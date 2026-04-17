//! RTP fan-out to N `TrackLocalStaticRTP` tracks.
//!
//! Why this exists
//! ---------------
//!
//! Today the GStreamer appsink pipeline feeds one `tokio::mpsc` consumer
//! that writes to one `TrackLocalStaticRTP` (see
//! `android/webrtc/video_pipeline.rs:614`). For observer co-attach we need
//! to fan the same RTP stream to *every* peer's track. Three constraints
//! shape the design:
//!
//! 1. **GStreamer appsink `max-buffers=1`.** The pipeline is configured to
//!    drop all but the newest sample. If we serialize writes across N tracks
//!    (`for t in tracks { t.write_rtp(&p).await }`), the slowest peer
//!    throttles everyone — head-of-line blocking defeats the whole point of
//!    having a second peer.
//!
//! 2. **`write_rtp` is an async backpressure point.** The webrtc crate's
//!    pacer/interceptor chain can block if that peer's transport has
//!    congestion. That's per-peer and independent.
//!
//! 3. **Peers come and go mid-session.** A stopped observer must not block
//!    a live browser (and vice versa). Dropped writes on a stale track
//!    should degrade to a no-op.
//!
//! Design
//! ------
//!
//! A single `broadcast::Sender<Arc<rtp::Packet>>` fans the stream to N
//! receivers. Each registered peer gets its own `Receiver` + dedicated
//! `tokio::task` that writes into its track. Bounded capacity means a slow
//! peer's `Receiver` lags; `recv` on a lagged receiver returns
//! `RecvError::Lagged(n)` and the task skips forward to the latest packet,
//! which is the right behavior for a live preview (drop frames, don't
//! stall).
//!
//! Registration is drop-safe: the `TaskHandle` returned from `register`
//! aborts the per-peer task when dropped, so the caller just has to hold
//! onto the handle for as long as the peer is attached and drop it when
//! the peer disconnects.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::broadcast;
use webrtc::rtp::packet::Packet;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocalWriter;

/// Discriminates the two RTP pipelines. Audio + video are cloned separately
/// (separate SSRCs, separate payload types) so their fan-out state stays
/// independent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrackKind {
    Video,
    Audio,
}

/// Cumulative fan-out stats for observability. Written by the fanout tasks;
/// read by metrics / health endpoints.
#[derive(Debug, Default)]
pub struct FanoutStats {
    pub packets_dispatched: AtomicU64,
    pub packets_dropped_lag: AtomicU64,
    pub packets_dropped_error: AtomicU64,
}

impl FanoutStats {
    pub fn snapshot(&self) -> FanoutStatsSnapshot {
        FanoutStatsSnapshot {
            packets_dispatched: self.packets_dispatched.load(Ordering::Relaxed),
            packets_dropped_lag: self.packets_dropped_lag.load(Ordering::Relaxed),
            packets_dropped_error: self.packets_dropped_error.load(Ordering::Relaxed),
        }
    }
}

/// Immutable copy of the current stats.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FanoutStatsSnapshot {
    pub packets_dispatched: u64,
    pub packets_dropped_lag: u64,
    pub packets_dropped_error: u64,
}

/// Subscription handle. Aborts the per-peer task on drop so the caller
/// doesn't have to clean up explicitly — a peer disconnect that nukes its
/// `PeerHandle` also severs the fan-out.
#[derive(Debug)]
pub struct FanoutSubscription {
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FanoutSubscription {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Default broadcast capacity. Enough to hold ~1s of 30 fps video without
/// lagging under normal conditions; short enough that a stalled peer
/// notices quickly and drops ahead instead of holding a huge backlog.
pub const DEFAULT_CAPACITY: usize = 64;

/// Fan-out for one RTP stream (video OR audio, not both).
///
/// Typical wiring — one fanout per kind, both constructed at worker start:
///
/// ```ignore
/// let video_fanout = Arc::new(TrackFanout::new(TrackKind::Video, 64));
/// // On each RTP packet arriving from GStreamer:
/// video_fanout.dispatch(packet);
/// // On new peer register:
/// let sub = video_fanout.subscribe_track(peer.video_track.clone());
/// // Store `sub` in the PeerHandle; drop it on disconnect.
/// ```
pub struct TrackFanout {
    kind: TrackKind,
    tx: broadcast::Sender<Arc<Packet>>,
    stats: Arc<FanoutStats>,
}

impl TrackFanout {
    /// Build a new fan-out with the given broadcast capacity.
    pub fn new(kind: TrackKind, capacity: usize) -> Self {
        let capacity = capacity.max(1);
        let (tx, _rx) = broadcast::channel(capacity);
        Self {
            kind,
            tx,
            stats: Arc::new(FanoutStats::default()),
        }
    }

    /// Number of currently-subscribed peers. Lag-check convenience.
    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }

    /// Snapshot the running counters.
    pub fn stats(&self) -> FanoutStatsSnapshot {
        self.stats.snapshot()
    }

    /// Clone the stats `Arc` for external observers (metrics endpoints).
    pub fn stats_arc(&self) -> Arc<FanoutStats> {
        self.stats.clone()
    }

    /// What kind of RTP this fan-out handles.
    pub fn kind(&self) -> TrackKind {
        self.kind
    }

    /// Publish one packet to all current subscribers. Synchronous + cheap —
    /// if there are zero subscribers the packet is dropped (this is expected
    /// at startup before the first peer attaches).
    ///
    /// Wraps `packet` in an `Arc` so each subscriber task clones the pointer,
    /// not the payload.
    pub fn dispatch(&self, packet: Packet) {
        // A `broadcast::Sender::send` only errors when there are zero
        // subscribers. That's not a real error — just means nobody's
        // listening yet. We silently drop.
        let _ = self.tx.send(Arc::new(packet));
        self.stats.packets_dispatched.fetch_add(1, Ordering::Relaxed);
    }

    /// Register a track for fan-out. Spawns a tokio task that consumes from
    /// this fan-out's broadcast channel and writes into `track.write_rtp`.
    ///
    /// The returned `FanoutSubscription` aborts the task on drop. Storing
    /// it in `PeerHandle` keeps the fan-out alive for the peer's lifetime;
    /// dropping the handle on disconnect cleans up automatically.
    pub fn subscribe_track(&self, track: Arc<TrackLocalStaticRTP>) -> FanoutSubscription {
        let mut rx = self.tx.subscribe();
        let stats = self.stats.clone();
        let task = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(packet) => {
                        match track.write_rtp(&packet).await {
                            Ok(_) => {}
                            Err(_) => {
                                stats.packets_dropped_error.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        stats.packets_dropped_lag.fetch_add(n, Ordering::Relaxed);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        FanoutSubscription { task }
    }

    /// Register a callback-style subscriber for tests or non-track consumers
    /// (e.g. a recording pipeline). The callback is spawned into its own
    /// task with the same broadcast semantics as `subscribe_track`.
    pub fn subscribe_raw<F, Fut>(&self, mut f: F) -> FanoutSubscription
    where
        F: FnMut(Arc<Packet>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let mut rx = self.tx.subscribe();
        let stats = self.stats.clone();
        let task = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(packet) => {
                        f(packet).await;
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        stats.packets_dropped_lag.fetch_add(n, Ordering::Relaxed);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        FanoutSubscription { task }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn pkt(seq: u16) -> Packet {
        let mut p = Packet::default();
        p.header.sequence_number = seq;
        p
    }

    #[tokio::test]
    async fn dispatch_with_no_subscribers_is_a_no_op() {
        let fan = TrackFanout::new(TrackKind::Video, 4);
        fan.dispatch(pkt(1));
        let s = fan.stats();
        assert_eq!(s.packets_dispatched, 1);
        assert_eq!(s.packets_dropped_error, 0);
        assert_eq!(s.packets_dropped_lag, 0);
    }

    #[tokio::test]
    async fn raw_subscriber_receives_every_packet() {
        let fan = TrackFanout::new(TrackKind::Video, 16);
        let received = Arc::new(AtomicUsize::new(0));
        let received_clone = received.clone();
        let _sub = fan.subscribe_raw(move |_p| {
            let c = received_clone.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
            }
        });
        for i in 0..5 {
            fan.dispatch(pkt(i));
        }
        // Yield so the task drains the channel.
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(received.load(Ordering::SeqCst), 5);
    }

    #[tokio::test]
    async fn slow_subscriber_lags_and_is_counted_in_stats() {
        let fan = TrackFanout::new(TrackKind::Video, 2);
        let received = Arc::new(AtomicUsize::new(0));
        let received_clone = received.clone();
        let _sub = fan.subscribe_raw(move |_p| {
            let c = received_clone.clone();
            async move {
                // Deliberately slow — forces the broadcast channel to lag.
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                c.fetch_add(1, Ordering::SeqCst);
            }
        });
        // Pump many packets; broadcast capacity is 2 so the slow subscriber
        // will miss most of them.
        for i in 0..20 {
            fan.dispatch(pkt(i));
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let s = fan.stats();
        assert_eq!(s.packets_dispatched, 20);
        assert!(s.packets_dropped_lag > 0, "expected some lagged drops");
        assert!(received.load(Ordering::SeqCst) < 20);
    }

    #[tokio::test]
    async fn subscription_drop_aborts_the_consumer_task() {
        let fan = TrackFanout::new(TrackKind::Video, 4);
        assert_eq!(fan.subscriber_count(), 0);
        {
            let _sub = fan.subscribe_raw(|_p| async {});
            assert_eq!(fan.subscriber_count(), 1);
        }
        // After drop the per-peer task aborts; the broadcast channel notices
        // on its next `send`.
        fan.dispatch(pkt(0));
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert_eq!(fan.subscriber_count(), 0);
    }

    #[tokio::test]
    async fn parallel_subscribers_do_not_head_of_line_block_one_another() {
        let fan = TrackFanout::new(TrackKind::Video, 8);
        let fast_received = Arc::new(AtomicUsize::new(0));
        let fast_recv_clone = fast_received.clone();
        let _fast = fan.subscribe_raw(move |_p| {
            let c = fast_recv_clone.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
            }
        });
        let _slow = fan.subscribe_raw(|_p| async {
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        });

        for i in 0..6 {
            fan.dispatch(pkt(i));
        }
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        // Fast subscriber saw everything (capacity 8, only 6 packets).
        assert_eq!(fast_received.load(Ordering::SeqCst), 6);
    }

    #[test]
    fn kind_roundtrip() {
        let v = TrackFanout::new(TrackKind::Video, 4);
        let a = TrackFanout::new(TrackKind::Audio, 4);
        assert_eq!(v.kind(), TrackKind::Video);
        assert_eq!(a.kind(), TrackKind::Audio);
    }
}
