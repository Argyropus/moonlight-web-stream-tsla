use std::{collections::HashMap, process::Stdio, sync::Arc, time::Duration};

use actix_web::{
    Either, Error, HttpRequest, HttpResponse, get, post, rt as actix_rt,
    web::{Data, Json, Payload},
};
use actix_ws::{Closed, Message, MessageStream, Session};
use common::{
    StreamSettings,
    api_bindings::{
        PostCancelRequest, PostCancelResponse, StreamClientMessage, StreamServerMessage,
    },
    config::Config,
    ipc::{ServerIpcMessage, StreamerIpcMessage, create_child_ipc},
    serialize_json,
};
use log::{debug, error, info, warn};
use moonlight_common::{PairStatus, stream::bindings::SupportedVideoFormats};
use tokio::{process::Command, spawn, sync::Mutex, time::sleep};

use crate::{
    api::auth::ApiCredentials,
    data::{ActiveStream, RuntimeApiData},
};

/// The stream handler WILL authenticate the client because it is a websocket
/// The Authenticator will let this route through
#[get("/host/stream")]
pub async fn start_host(
    data: Data<RuntimeApiData>,
    config: Data<Config>,
    credentials: Data<ApiCredentials>,
    request: HttpRequest,
    payload: Payload,
) -> Result<HttpResponse, Error> {
    let (response, session, mut stream) = actix_ws::handle(&request, payload)?;

    actix_rt::spawn(async move {
        info!("[Stream]: new WebSocket connection established, awaiting auth message");
        let message;
        loop {
            message = match stream.recv().await {
                Some(Ok(Message::Text(text))) => text,
                Some(Ok(Message::Binary(_))) => {
                    warn!("[Stream]: unexpected binary message during auth phase");
                    return;
                }
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) | Some(Ok(Message::Nop)) => continue,
                Some(Ok(other)) => {
                    warn!("[Stream]: unexpected message during auth phase: {other:?}");
                    continue;
                }
                Some(Err(err)) => {
                    warn!("[Stream]: WebSocket error during auth phase: {err}");
                    return;
                }
                None => {
                    info!("[Stream]: WebSocket closed before auth message received");
                    return;
                }
            };
            break;
        }

        let message = match serde_json::from_str::<StreamClientMessage>(&message) {
            Ok(value) => value,
            Err(_) => {
                return;
            }
        };

        match message {
            StreamClientMessage::AuthenticateAndInit {
                credentials: request_credentials,
                host_id,
                app_id,
                bitrate,
                packet_size,
                fps,
                width,
                height,
                video_sample_queue_size,
                play_audio_local,
                audio_sample_queue_size,
                video_supported_formats,
                video_colorspace,
                video_color_range_full,
            } => {
                info!(
                    "[Stream]: received auth request for host={host_id} app={app_id} ({width}x{height}@{fps}fps)"
                );

                let stream_settings = StreamSettings {
                    bitrate,
                    packet_size,
                    fps,
                    width,
                    height,
                    video_sample_queue_size,
                    audio_sample_queue_size,
                    play_audio_local,
                    video_supported_formats: SupportedVideoFormats::from_bits(
                        video_supported_formats,
                    )
                    .unwrap_or_else(|| {
                        warn!("[Stream]: Received invalid supported video formats");
                        SupportedVideoFormats::H264
                    }),
                    video_colorspace: video_colorspace.into(),
                    video_color_range_full,
                };

                run_primary_stream(
                    data,
                    config,
                    credentials,
                    session,
                    stream,
                    request_credentials,
                    host_id,
                    app_id,
                    stream_settings,
                )
                .await;
            }
            StreamClientMessage::AuthenticateAndAttachInput {
                credentials: request_credentials,
                host_id,
            } => {
                info!("[Stream]: received attach-input request for host={host_id}");

                run_attach_input(
                    data,
                    credentials,
                    session,
                    stream,
                    request_credentials,
                    host_id,
                )
                .await;
            }
            _ => {
                warn!("[Stream]: first WS message was not AuthenticateAndInit or AuthenticateAndAttachInput");
                let _ = session.close(None).await;
            }
        }
    });

    Ok(response)
}

async fn authenticate(
    credentials: &ApiCredentials,
    request_credentials: Option<&str>,
) -> bool {
    credentials.authenticate_with_credentials(request_credentials)
        || match request_credentials {
            Some(token) => credentials.validate_session(token).await,
            None => false,
        }
}

/// Relays browser -> streamer messages for a single client_id until the
/// WebSocket closes or errors. Shared between the primary (AV) connection and
/// any attached input-only connections — both just forward `StreamClientMessage`s
/// tagged with their own `client_id` over the same IPC pipe.
async fn relay_ws_to_ipc(
    client_id: u32,
    stream: &mut MessageStream,
    ping_session: &mut Session,
    ipc_sender: &mut common::ipc::IpcSender<ServerIpcMessage>,
) {
    loop {
        match stream.recv().await {
            Some(Ok(Message::Text(text))) => {
                let Ok(message) = serde_json::from_str::<StreamClientMessage>(&text) else {
                    warn!("[Stream]: failed to deserialize from json: {text}");
                    continue;
                };
                // Log client debug logs locally instead of forwarding to streamer
                if let StreamClientMessage::ClientLog { ref log } = message {
                    info!("[Client Log]:\n{log}");
                    continue;
                }
                debug!("[Stream]: relaying WS→IPC (client {client_id}): {text}");
                ipc_sender
                    .send(ServerIpcMessage::WebSocket { client_id, message })
                    .await;
            }
            // Respond to keep-alive pings so the browser doesn't close the connection.
            Some(Ok(Message::Ping(data))) => {
                debug!("[Stream]: received WS Ping, sending Pong");
                let _ = ping_session.pong(&data).await;
            }
            // Ignore pong/nop frames — not an error.
            Some(Ok(Message::Pong(_))) | Some(Ok(Message::Nop)) => {}
            Some(Ok(Message::Close(reason))) => {
                info!("[Stream]: WS closed by client {client_id}: {reason:?}");
                break;
            }
            // Binary frames and continuation frames are unexpected; ignore them.
            Some(Ok(other)) => {
                debug!("[Stream]: ignoring unexpected WS frame: {other:?}");
            }
            // WebSocket closed or error — exit relay.
            Some(Err(err)) => {
                warn!("[Stream]: WS relay error (client {client_id}): {err:?}");
                break;
            }
            None => {
                info!("[Stream]: WS stream ended (None) for client {client_id}");
                break;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_primary_stream(
    data: Data<RuntimeApiData>,
    config: Data<Config>,
    credentials: Data<ApiCredentials>,
    mut session: Session,
    mut stream: MessageStream,
    request_credentials: Option<String>,
    host_id: u32,
    app_id: u32,
    stream_settings: StreamSettings,
) {
    let authenticated = authenticate(&credentials, request_credentials.as_deref()).await;

    if !authenticated {
        warn!("[Stream]: authentication failed for stream request");
        let _ = send_ws_message(
            &mut session,
            StreamServerMessage::StageFailed {
                stage: "Authentication".to_string(),
                error_code: -1,
            },
        )
        .await;

        let _ = session.close(None).await;
        return;
    }

    // Collect host data
    let (
        host_address,
        host_http_port,
        client_private_key_pem,
        client_certificate_pem,
        server_certificate_pem,
        app,
    ) = {
        let hosts = data.hosts.read().await;
        let Some(host) = hosts.get(host_id as usize) else {
            let _ = send_ws_message(&mut session, StreamServerMessage::HostNotFound).await;
            let _ = session.close(None).await;
            return;
        };
        let mut host = host.lock().await;
        let host_inner = &mut host.moonlight;

        if host_inner.is_paired() == PairStatus::NotPaired {
            warn!("[Stream]: tried to connect to a not paired host");

            let _ = send_ws_message(&mut session, StreamServerMessage::HostNotPaired).await;
            let _ = session.close(None).await;
            return;
        }

        let apps = match host_inner.app_list().await {
            Ok(value) => value,
            Err(err) => {
                error!("[Stream]: failed to get app list from host: {err:?}");

                let _ = send_ws_message(&mut session, StreamServerMessage::InternalServerError)
                    .await;
                let _ = session.close(None).await;
                return;
            }
        };
        let Some(app) = apps.iter().find(|app| app.id == app_id).cloned() else {
            warn!("[Stream]: failed to get request app from user");

            let _ = send_ws_message(&mut session, StreamServerMessage::AppNotFound).await;
            let _ = session.close(None).await;
            return;
        };

        if let Some(client_private_key) = host_inner.client_private_key()
            && let Some(client_certificate) = host_inner.client_certificate()
            && let Some(server_certificate) = host_inner.server_certificate()
        {
            (
                host_inner.address().to_string(),
                host_inner.http_port(),
                client_private_key.to_string(),
                client_certificate.to_string(),
                server_certificate.to_string(),
                app,
            )
        } else {
            return;
        }
    };

    // Send App info
    let _ = send_ws_message(
        &mut session,
        StreamServerMessage::UpdateApp { app: app.into() },
    )
    .await;

    // Starting stage: launch streamer
    let _ = send_ws_message(
        &mut session,
        StreamServerMessage::StageStarting {
            stage: "Launch Streamer".to_string(),
        },
    )
    .await;

    // Spawn child
    let (mut child, stdin, stdout) = match Command::new(&config.streamer_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(mut child) => {
            if let Some(stdin) = child.stdin.take()
                && let Some(stdout) = child.stdout.take()
            {
                (child, stdin, stdout)
            } else {
                error!("[Stream]: streamer process didn't include a stdin or stdout");

                let _ = send_ws_message(&mut session, StreamServerMessage::InternalServerError)
                    .await;
                let _ = session.close(None).await;

                if let Err(err) = child.kill().await {
                    warn!("[Stream]: failed to kill child: {err:?}");
                }

                return;
            }
        }
        Err(err) => {
            error!("[Stream]: failed to spawn streamer process: {err:?}");

            let _ = send_ws_message(&mut session, StreamServerMessage::InternalServerError).await;
            let _ = session.close(None).await;
            return;
        }
    };

    // Create ipc
    let (mut ipc_sender, mut ipc_receiver) =
        create_child_ipc::<ServerIpcMessage, StreamerIpcMessage>(
            "Streamer".to_string(),
            stdin,
            stdout,
            child.stderr.take(),
        )
        .await;

    // Register this stream so a second browser connection can later attach an
    // input-only peer into the same streamer process instead of starting a new one.
    let active_stream = Arc::new(Mutex::new(ActiveStream {
        ipc_sender: ipc_sender.clone(),
        next_client_id: 1, // 0 is reserved for this primary AV client
        clients: HashMap::from([(0u32, session.clone())]),
    }));
    {
        let hosts = data.hosts.read().await;
        if let Some(host) = hosts.get(host_id as usize) {
            let mut host = host.lock().await;
            host.active_stream = Some(active_stream.clone());
        }
    }

    // Router: owns the IPC receiver for the lifetime of the stream and demuxes
    // replies to whichever browser connection (primary or attached input-only)
    // they're tagged for. On Stop, tears down every attached client.
    spawn({
        let data = data.clone();
        let active_stream = active_stream.clone();

        async move {
            while let Some(message) = ipc_receiver.recv().await {
                match message {
                    StreamerIpcMessage::WebSocket { client_id, message } => {
                        let target = {
                            let active = active_stream.lock().await;
                            active.clients.get(&client_id).cloned()
                        };
                        if let Some(mut target_session) = target {
                            if let Err(Closed) = send_ws_message(&mut target_session, message).await {
                                warn!(
                                    "[Ipc]: tried to send a ws message to client {client_id} but the socket is already closed"
                                );
                            }
                        }
                    }
                    StreamerIpcMessage::Stop => {
                        debug!("[Ipc]: ipc receiver stopped by streamer");
                        break;
                    }
                }
            }
            info!("[Ipc]: ipc receiver is closed");

            // Close every attached session (primary + any input-only attachments)
            // and clear the registry so future attach requests get StreamNotActive.
            let mut active = active_stream.lock().await;
            for (_, client_session) in active.clients.drain() {
                let _ = client_session.close(None).await;
            }
            drop(active);

            let hosts = data.hosts.read().await;
            if let Some(host) = hosts.get(host_id as usize) {
                let mut host = host.lock().await;
                host.active_stream = None;
            }
        }
    });

    // Send init into ipc
    ipc_sender
        .send(ServerIpcMessage::Init {
            server_config: Config::clone(&config),
            stream_settings,
            host_address,
            host_http_port,
            host_unique_id: None,
            client_private_key_pem,
            client_certificate_pem,
            server_certificate_pem,
            app_id,
        })
        .await;

    let mut ping_session = session.clone();
    relay_ws_to_ipc(0, &mut stream, &mut ping_session, &mut ipc_sender).await;

    // -- After the websocket disconnects we kill the stream:
    ipc_sender.send(ServerIpcMessage::Stop).await;
    drop(ipc_sender);

    sleep(Duration::from_secs(4)).await;

    info!("[Stream]: killing streamer");
    match child.kill().await {
        Ok(_) => {
            info!("[Stream]: killed streamer");
        }
        Err(err) => {
            warn!("[Stream]: failed to kill child: {err:?}");
        }
    }
}

async fn run_attach_input(
    data: Data<RuntimeApiData>,
    credentials: Data<ApiCredentials>,
    mut session: Session,
    mut stream: MessageStream,
    request_credentials: Option<String>,
    host_id: u32,
) {
    let authenticated = authenticate(&credentials, request_credentials.as_deref()).await;

    if !authenticated {
        warn!("[Stream]: authentication failed for attach-input request");
        let _ = send_ws_message(
            &mut session,
            StreamServerMessage::StageFailed {
                stage: "Authentication".to_string(),
                error_code: -1,
            },
        )
        .await;

        let _ = session.close(None).await;
        return;
    }

    let active_stream = {
        let hosts = data.hosts.read().await;
        let Some(host) = hosts.get(host_id as usize) else {
            let _ = send_ws_message(&mut session, StreamServerMessage::HostNotFound).await;
            let _ = session.close(None).await;
            return;
        };
        let host = host.lock().await;
        host.active_stream.clone()
    };

    let Some(active_stream) = active_stream else {
        warn!("[Stream]: attach-input request for host={host_id} with no active stream");
        let _ = send_ws_message(&mut session, StreamServerMessage::StreamNotActive).await;
        let _ = session.close(None).await;
        return;
    };

    let (client_id, mut ipc_sender) = {
        let mut active = active_stream.lock().await;
        let client_id = active.next_client_id;
        active.next_client_id += 1;
        active.clients.insert(client_id, session.clone());
        (client_id, active.ipc_sender.clone())
    };

    info!("[Stream]: attaching input-only client {client_id} to host={host_id}");
    ipc_sender
        .send(ServerIpcMessage::AttachInputClient { client_id })
        .await;

    let mut ping_session = session.clone();
    relay_ws_to_ipc(client_id, &mut stream, &mut ping_session, &mut ipc_sender).await;

    info!("[Stream]: detaching input-only client {client_id} from host={host_id}");

    {
        let mut active = active_stream.lock().await;
        active.clients.remove(&client_id);
    }

    ipc_sender
        .send(ServerIpcMessage::DetachInputClient { client_id })
        .await;

    let _ = session.close(None).await;
}

async fn send_ws_message(sender: &mut Session, message: StreamServerMessage) -> Result<(), Closed> {
    let Some(json) = serialize_json(&message) else {
        return Ok(());
    };

    sender.text(json).await
}

#[post("/host/cancel")]
pub async fn cancel_host(
    data: Data<RuntimeApiData>,
    request: Json<PostCancelRequest>,
) -> Either<Json<PostCancelResponse>, HttpResponse> {
    let hosts = data.hosts.read().await;

    let host_id = request.host_id;
    let Some(host) = hosts.get(host_id as usize) else {
        return Either::Right(HttpResponse::NotFound().finish());
    };

    let mut host = host.lock().await;

    let success = match host.moonlight.cancel().await {
        Ok(value) => value,
        Err(err) => {
            warn!("[Api]: failed to cancel stream for {host_id}:{err:?}");

            return Either::Right(HttpResponse::InternalServerError().finish());
        }
    };

    Either::Left(Json(PostCancelResponse { success }))
}
