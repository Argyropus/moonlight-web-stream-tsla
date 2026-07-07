use std::marker::PhantomData;

use log::warn;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::{
    io::{
        AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader, Lines, Stdin, Stdout,
    },
    process::{ChildStderr, ChildStdin, ChildStdout},
    spawn,
    sync::mpsc::{Receiver, Sender, channel},
};

use crate::{
    StreamSettings,
    api_bindings::{StreamClientMessage, StreamServerMessage},
    config::Config,
};

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Serialize, Deserialize)]
pub enum ServerIpcMessage {
    Init {
        server_config: Config,
        stream_settings: StreamSettings,
        host_address: String,
        host_http_port: u16,
        host_unique_id: Option<String>,
        client_private_key_pem: String,
        client_certificate_pem: String,
        server_certificate_pem: String,
        app_id: u32,
    },
    WebSocket {
        client_id: u32,
        message: StreamClientMessage,
    },
    /// Attach a new input-only WebRTC peer (no video/audio) for `client_id`,
    /// driving the same already-running MoonlightStream.
    AttachInputClient {
        client_id: u32,
    },
    /// Tear down the input-only peer for `client_id` without affecting the
    /// primary (client_id 0) AV connection or the underlying MoonlightStream.
    DetachInputClient {
        client_id: u32,
    },
    Stop,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum StreamerIpcMessage {
    WebSocket {
        client_id: u32,
        message: StreamServerMessage,
    },
    Stop,
}

// We're using the:
// Stdin: message passing
// Stdout: message passing
// Stderr: logging

pub async fn create_child_ipc<Message, ChildMessage>(
    log_prefix: String,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: Option<ChildStderr>,
) -> (IpcSender<Message>, IpcReceiver<ChildMessage>)
where
    Message: Send + Serialize + 'static,
    ChildMessage: DeserializeOwned,
{
    if let Some(stderr) = stderr {
        spawn(async move {
            let buf_reader = BufReader::new(stderr);
            let mut lines = buf_reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                println!("[{log_prefix}]: {line}");
            }
        });
    }

    let (sender, receiver) = channel::<Message>(10);

    spawn(async move {
        ipc_sender(stdin, receiver).await;
    });

    (
        IpcSender { sender },
        IpcReceiver {
            errored: false,
            read: create_lines(stdout),
            phantom: Default::default(),
        },
    )
}

pub async fn create_process_ipc<ParentMessage, Message>(
    stdin: Stdin,
    stdout: Stdout,
) -> (IpcSender<Message>, IpcReceiver<ParentMessage>)
where
    ParentMessage: DeserializeOwned,
    Message: Send + Serialize + 'static,
{
    let (sender, receiver) = channel::<Message>(10);

    spawn(async move {
        ipc_sender(stdout, receiver).await;
    });

    (
        IpcSender { sender },
        IpcReceiver {
            errored: false,
            read: create_lines(stdin),
            phantom: Default::default(),
        },
    )
}
fn create_lines(
    read: impl AsyncRead + Send + Unpin + 'static,
) -> Lines<Box<dyn AsyncBufRead + Send + Unpin + 'static>> {
    (Box::new(BufReader::new(read)) as Box<dyn AsyncBufRead + Send + Unpin + 'static>).lines()
}

async fn ipc_sender<Message>(mut write: impl AsyncWriteExt + Unpin, mut receiver: Receiver<Message>)
where
    Message: Serialize,
{
    while let Some(value) = receiver.recv().await {
        let mut json = match serde_json::to_string(&value) {
            Ok(value) => value,
            Err(err) => {
                warn!("[Ipc]: failed to encode message: {err:?}");
                continue;
            }
        };
        json.push('\n');

        if let Err(err) = write.write_all(json.as_bytes()).await {
            warn!("[Ipc]: failed to write message length: {err:?}");
            return;
        };

        if let Err(err) = write.flush().await {
            warn!("[Ipc]: failed to flush: {err:?}");
            return;
        }
    }
}

#[derive(Debug)]
pub struct IpcSender<Message> {
    sender: Sender<Message>,
}

impl<Message> Clone for IpcSender<Message> {
    fn clone(&self) -> Self {
        Self {
            sender: self.sender.clone(),
        }
    }
}

impl<Message> IpcSender<Message>
where
    Message: Serialize + Send + 'static,
{
    pub async fn send(&mut self, message: Message) {
        if self.sender.send(message).await.is_err() {
            warn!("[Ipc]: failed to send message");
        }
    }
}

pub struct IpcReceiver<Message> {
    errored: bool,
    read: Lines<Box<dyn AsyncBufRead + Send + Unpin>>,
    phantom: PhantomData<Message>,
}

impl<Message> IpcReceiver<Message>
where
    Message: DeserializeOwned,
{
    pub async fn recv(&mut self) -> Option<Message> {
        if self.errored {
            return None;
        }

        // A malformed line must not be treated as end-of-stream: every caller
        // uses `while let Some(..) = recv()` as its message loop, so returning
        // `None` here would tear down the whole stream over one bad message.
        loop {
            let line = match self.read.next_line().await {
                Ok(Some(value)) => value,
                Ok(None) => return None,
                Err(err) => {
                    self.errored = true;

                    warn!("[Ipc]: failed to read next line {err:?}");

                    return None;
                }
            };

            match serde_json::from_str::<Message>(&line) {
                Ok(value) => return Some(value),
                Err(err) => {
                    warn!("[Ipc]: failed to deserialize message, skipping it: {err:?}");
                }
            }
        }
    }
}
