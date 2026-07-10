use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant};

use log::warn;
use tokio::sync::{
    mpsc::{Receiver, Sender, channel, error::TryRecvError},
};
use webrtc::{
    media::Sample,
    rtcp::packet::Packet,
    rtp::{
        self,
        extension::HeaderExtension,
    },
    rtp_transceiver::rtp_sender::RTCRtpSender,
    track::track_local::{
        TrackLocal, track_local_static_rtp::TrackLocalStaticRTP,
        track_local_static_sample::TrackLocalStaticSample,
    },
};

use crate::StreamConnection;

pub struct TrackLocalSender<Track>
where
    Track: TrackLike,
{
    channel_queue_size: usize,
    pub(crate) stream: Arc<StreamConnection>,
    // Samples travel in per-frame batches: one channel send per frame instead
    // of one per RTP packet (~40x fewer mutex+waker ops at 1080p60).
    sender: Option<Sender<Vec<Track::Sample>>>,
}

impl<Track> TrackLocalSender<Track>
where
    Track: TrackLike,
{
    pub fn new(stream: Arc<StreamConnection>, channel_queue_size: usize) -> Self {
        Self {
            channel_queue_size,
            stream,
            sender: Default::default(),
        }
    }

    /// Pacing rate for the token-bucket sender: 3x the configured stream
    /// bitrate, so sustained throughput is never limited — only bursts far
    /// above the stream rate get smoothed. The floor only guards against a
    /// degenerate near-zero bitrate; it must stay well under the lowest real
    /// preset (1.5 Mbps) or it defeats pacing on exactly the low-bandwidth/
    /// cellular configs this exists to help (a flat 3 MB/s floor here
    /// previously did exactly that — 1.5 Mbps and 3 Mbps presets were paced
    /// at 24 Mbps instead of their intended 4.5/9 Mbps).
    fn pace_bytes_per_sec(&self) -> u64 {
        // settings.bitrate is in kbps -> *125 = bytes/sec
        (self.stream.settings.bitrate as u64 * 125)
            .saturating_mul(3)
            .max(200_000)
    }

    pub fn blocking_create_track(
        &mut self,
        track: Track,
        mut on_packet: impl FnMut(Box<dyn Packet + Send + Sync>) + Send + 'static,
    ) -> Result<(), anyhow::Error> {
        let stream = self.stream.clone();

        let track = Arc::new(track);

        let (sender, receiver) = channel(self.channel_queue_size);

        let pace_bytes_per_sec = self.pace_bytes_per_sec();
        self.stream.runtime.spawn({
            let track = track.clone();
            async move {
                sample_sender(track, receiver, pace_bytes_per_sec).await;
            }
        });

        let track_sender = self.stream.runtime.block_on({
            let track = track.clone();
            async move { stream.peer.add_track(track.track()).await }
        })?;

        // Read incoming RTCP packets.
        // Before these packets are returned they are processed by interceptors. For things
        // like NACK this needs to be called.
        self.stream.runtime.spawn(async move {
            let mut rtcp_buf = vec![0u8; 1500];
            while let Ok((packets, _)) = track_sender.read(&mut rtcp_buf).await {
                for packet in packets {
                    on_packet(packet);
                }
            }
        });

        self.sender.replace(sender);

        Ok(())
    }

    pub fn blocking_send_batch(&self, batch: Vec<Track::Sample>) {
        if let Some(sender) = self.sender.as_ref() {
            let _ = sender.blocking_send(batch);
        }
    }
}

impl TrackLocalSender<SequencedTrackLocalStaticRTP> {
    /// Activate the sender by replacing the track on an existing transceiver sender.
    /// This is codec-agnostic: the transceiver was added with all codecs in the SDP,
    /// and we now attach the track for whichever codec Moonlight actually selected.
    /// No renegotiation is triggered.
    pub fn blocking_activate_via_replace_track(
        &mut self,
        track: Arc<TrackLocalStaticRTP>,
        rtp_sender: Arc<RTCRtpSender>,
        mut on_packet: impl FnMut(Box<dyn Packet + Send + Sync>) + Send + 'static,
    ) -> Result<(), anyhow::Error> {
        let sequenced = Arc::new(SequencedTrackLocalStaticRTP::from_arc(track.clone()));

        // Attach the track to the pre-existing transceiver sender.
        // The inner TrackLocalStaticRTP is what pion binds to its interceptor chain.
        self.stream.runtime.block_on(
            rtp_sender.replace_track(Some(sequenced.track.clone()))
        )?;

        let (sender, receiver) = channel(self.channel_queue_size);

        let pace_bytes_per_sec = self.pace_bytes_per_sec();
        self.stream.runtime.spawn({
            let track = sequenced.clone();
            async move {
                sample_sender(track, receiver, pace_bytes_per_sec).await;
            }
        });

        self.stream.runtime.spawn(async move {
            let mut rtcp_buf = vec![0u8; 1500];
            while let Ok((packets, _)) = rtp_sender.read(&mut rtcp_buf).await {
                for packet in packets {
                    on_packet(packet);
                }
            }
        });

        self.sender.replace(sender);
        Ok(())
    }
}

/// Safety valve for the pacer's local queue: ~4096 packets (≈5MB) means the
/// link has been unable to drain for a long time — drop everything queued and
/// let the receiver recover via PLI instead of growing without bound.
const PACE_QUEUE_MAX: usize = 4096;

async fn sample_sender<Track>(
    track: Arc<Track>,
    mut receiver: Receiver<Vec<Track::Sample>>,
    pace_bytes_per_sec: u64,
) where
    Track: TrackLike,
{
    // We do NOT send the PlayoutDelayExtension.
    // Setting it to (0, 0) disables WebRTC's adaptive jitter buffer, causing severe frame drops
    // on cellular networks with 20ms+ latency jitter. Letting the browser manage its own jitter
    // buffer is essential for smooth real-time streaming over variable networks.
    let extensions = [];

    // Token-bucket pacer. A normal frame fits inside the burst allowance and is
    // sent immediately, exactly as before; only bursts well above the sustained
    // rate (IDR/recovery frames, which can be 20+ packets back-to-back) get
    // spread out, so they don't overflow the downlink queue and cause the
    // loss → PLI → another IDR spiral on constrained links. Refill is based on
    // measured elapsed time, so coarse OS timers only reduce smoothing
    // granularity — never throughput.
    let rate = pace_bytes_per_sec.max(1) as f64;
    let burst_bytes = (rate * 0.005).max(24_000.0);
    let mut budget = burst_bytes;
    let mut last_refill = Instant::now();
    let mut queue: VecDeque<Track::Sample> = VecDeque::new();
    let mut open = true;

    while open || !queue.is_empty() {
        // Move everything already waiting in the channel into the local queue,
        // so the (blocking) decode callback side never stalls on a full channel
        // while we pace.
        loop {
            match receiver.try_recv() {
                Ok(batch) => queue.extend(batch),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    open = false;
                    break;
                }
            }
        }

        if queue.len() > PACE_QUEUE_MAX {
            warn!(
                "[Stream]: pacer queue exceeded {PACE_QUEUE_MAX} packets, dropping them (link too slow?)"
            );
            queue.clear();
            continue;
        }

        if queue.is_empty() {
            if !open {
                break;
            }
            match receiver.recv().await {
                Some(batch) => queue.extend(batch),
                None => open = false,
            }
            continue;
        }

        let now = Instant::now();
        budget = (budget + now.duration_since(last_refill).as_secs_f64() * rate).min(burst_bytes);
        last_refill = now;

        if budget <= 0.0 {
            // Out of budget: wait for a refill, but keep accepting packets so
            // the sender side stays unblocked.
            let deficit_secs = (-budget / rate).max(0.0005);
            let sleep = tokio::time::sleep(Duration::from_secs_f64(deficit_secs));
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    _ = &mut sleep => break,
                    received = receiver.recv(), if open => match received {
                        Some(batch) => queue.extend(batch),
                        None => open = false,
                    }
                }
            }
            continue;
        }

        // Pause state only changes at setup/renegotiation, so checking it once
        // per drain burst (instead of per packet inside write_with_extensions)
        // avoids an async lock acquisition inside webrtc-rs for every packet.
        let paused = track.writes_paused().await;
        while budget > 0.0 {
            let Some(sample) = queue.pop_front() else {
                break;
            };
            budget -= Track::sample_size(&sample) as f64;
            if paused {
                // Drop without writing so sequence numbers don't increment.
                continue;
            }
            if let Err(err) = track
                .write_with_extensions(
                    sample,
                    &extensions,
                )
                .await
            {
                warn!("[Stream]: track.write_sample failed: {err}");
            }
        }
    }
}

pub trait TrackLike: Send + Sync + 'static {
    type Sample: Send + 'static;

    /// Approximate wire size of a sample, used by the pacer's token bucket.
    fn sample_size(sample: &Self::Sample) -> usize;

    /// True while no binding will accept writes (e.g. transceiver not yet
    /// negotiated). Checked once per drain burst by the pacer; samples are
    /// dropped without side effects while paused.
    fn writes_paused(&self) -> impl Future<Output = bool> + Send {
        async { false }
    }

    fn write_with_extensions(
        &self,
        sample: Self::Sample,
        extensions: &[HeaderExtension],
    ) -> impl Future<Output = Result<(), anyhow::Error>> + Send;

    fn track(self: Arc<Self>) -> Arc<dyn TrackLocal + Send + Sync + 'static>;
}

impl TrackLike for TrackLocalStaticSample {
    type Sample = Sample;

    fn sample_size(sample: &Self::Sample) -> usize {
        sample.data.len()
    }

    async fn write_with_extensions(
        &self,
        sample: Self::Sample,
        extensions: &[HeaderExtension],
    ) -> Result<(), anyhow::Error> {
        self.write_sample_with_extensions(&sample, extensions)
            .await
            .map_err(anyhow::Error::from)
    }

    fn track(self: Arc<Self>) -> Arc<dyn TrackLocal + Send + Sync + 'static> {
        self
    }
}

pub struct SequencedTrackLocalStaticRTP {
    track: Arc<TrackLocalStaticRTP>,
    sequence_number: AtomicU16,
}

impl From<TrackLocalStaticRTP> for SequencedTrackLocalStaticRTP {
    fn from(value: TrackLocalStaticRTP) -> Self {
        Self {
            track: Arc::new(value),
            sequence_number: AtomicU16::new(0),
        }
    }
}

impl SequencedTrackLocalStaticRTP {
    pub(crate) fn from_arc(track: Arc<TrackLocalStaticRTP>) -> Self {
        Self {
            track,
            sequence_number: AtomicU16::new(0),
        }
    }
}

impl TrackLike for SequencedTrackLocalStaticRTP {
    type Sample = rtp::packet::Packet;

    fn sample_size(sample: &Self::Sample) -> usize {
        // 12 bytes fixed RTP header + payload
        12 + sample.payload.len()
    }

    fn writes_paused(&self) -> impl Future<Output = bool> + Send {
        // If a write happened while paused, the sequence number would
        // increment without anything being sent — the pacer checks this
        // before each drain burst and drops instead.
        self.track.all_binding_paused()
    }

    async fn write_with_extensions(
        &self,
        mut sample: Self::Sample,
        extensions: &[HeaderExtension],
    ) -> Result<(), anyhow::Error> {
        sample.header.sequence_number = self.sequence_number.fetch_add(1, Ordering::Relaxed);

        self.track
            .write_rtp_with_extensions(&sample, extensions)
            .await
            .map_err(anyhow::Error::from)
            .map(|_| ())
    }

    fn track(self: Arc<Self>) -> Arc<dyn TrackLocal + Send + Sync + 'static> {
        self.track.clone()
    }
}
