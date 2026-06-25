use std::sync::Arc;

use log::info;
use moonlight_common::stream::{
    bindings::{ConnectionStatus, Stage},
    connection::ConnectionListener,
};

use crate::{StreamConnection, serialize_json};
use common::{
    api_bindings::{StreamServerGeneralMessage, StreamServerMessage},
    ipc::StreamerIpcMessage,
};

pub struct StreamConnectionListener {
    stream: Arc<StreamConnection>,
}

impl StreamConnectionListener {
    pub fn new(stream: Arc<StreamConnection>) -> Self {
        Self { stream }
    }
}

impl ConnectionListener for StreamConnectionListener {
    fn stage_starting(&mut self, stage: Stage) {
        let mut ipc_sender = self.stream.ipc_sender.clone();

        self.stream.runtime.spawn(async move {
            ipc_sender
                .send(StreamerIpcMessage::WebSocket {
                    client_id: 0,
                    message: StreamServerMessage::StageStarting {
                        stage: stage.name().to_string(),
                    },
                })
                .await;
        });
    }

    fn stage_complete(&mut self, stage: Stage) {
        let mut ipc_sender = self.stream.ipc_sender.clone();

        self.stream.runtime.spawn(async move {
            ipc_sender
                .send(StreamerIpcMessage::WebSocket {
                    client_id: 0,
                    message: StreamServerMessage::StageComplete {
                        stage: stage.name().to_string(),
                    },
                })
                .await;
        });
    }

    fn stage_failed(&mut self, stage: Stage, error_code: i32) {
        let mut ipc_sender = self.stream.ipc_sender.clone();

        self.stream.runtime.spawn(async move {
            ipc_sender
                .send(StreamerIpcMessage::WebSocket {
                    client_id: 0,
                    message: StreamServerMessage::StageFailed {
                        stage: stage.name().to_string(),
                        error_code,
                    },
                })
                .await;
        });
    }

    fn connection_started(&mut self) {
        // Video track was pre-registered before the initial offer/answer,
        // so no renegotiation is needed here. The track will be activated
        // in TrackSampleVideoDecoder::setup() using the pre-registered track.
    }

    fn connection_terminated(&mut self, error_code: i32) {
        let mut ipc_sender = self.stream.ipc_sender.clone();

        self.stream.runtime.spawn(async move {
            ipc_sender
                .send(StreamerIpcMessage::WebSocket {
                    client_id: 0,
                    message: StreamServerMessage::ConnectionTerminated { error_code },
                })
                .await;
        });

        let stream = self.stream.clone();
        self.stream.runtime.spawn(async move {
            if let Some(message) = serialize_json(&StreamServerGeneralMessage::ConnectionTerminated)
            {
                let _ = stream.general_channel.send_text(message).await;
            }
        });
    }

    fn log_message(&mut self, message: &str) {
        info!("[Moonlight Stream]: {}", message.trim());
    }

    fn connection_status_update(&mut self, status: ConnectionStatus) {
        let stream = self.stream.clone();
        self.stream.runtime.spawn(async move {
            if let Some(message) =
                serialize_json(&StreamServerGeneralMessage::ConnectionStatusUpdate {
                    status: status.into(),
                })
            {
                let _ = stream.general_channel.send_text(message).await;
            }
        });
    }

    fn set_hdr_mode(&mut self, _hdr_enabled: bool) {}

    fn controller_rumble(
        &mut self,
        controller_number: u16,
        low_frequency_motor: u16,
        high_frequency_motor: u16,
    ) {
        let stream = self.stream.clone();

        self.stream.runtime.spawn(async move {
            stream
                .input
                .send_controller_rumble(
                    controller_number as u8,
                    low_frequency_motor,
                    high_frequency_motor,
                )
                .await;
        });
    }

    fn controller_rumble_triggers(
        &mut self,
        controller_number: u16,
        left_trigger_motor: u16,
        right_trigger_motor: u16,
    ) {
        let stream = self.stream.clone();

        self.stream.runtime.spawn(async move {
            stream
                .input
                .send_controller_trigger_rumble(
                    controller_number as u8,
                    left_trigger_motor,
                    right_trigger_motor,
                )
                .await;
        });
    }

    fn controller_set_motion_event_state(
        &mut self,
        _controller_number: u16,
        _motion_type: u8,
        _report_rate_hz: u16,
    ) {
        // unsupported: https://github.com/w3c/gamepad/issues/211
    }

    fn controller_set_adaptive_triggers(
        &mut self,
        _controller_number: u16,
        _event_flags: u8,
        _type_left: u8,
        _type_right: u8,
        _left: &mut u8,
        _right: &mut u8,
    ) {
        // unsupported
    }

    fn controller_set_led(&mut self, _controller_number: u16, _r: u8, _g: u8, _b: u8) {
        // unsupported
    }
}
