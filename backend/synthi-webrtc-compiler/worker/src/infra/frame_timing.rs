//! Frame-timing tracker — supplies F2 + F4 measurements the ultraplan
//! flagged as phase-0.5 deferred decisions:
//!
//!   F4 — VFR frame-interval distribution. Synthi's encoder produces
//!        VFR output; the seq-count fallback in the MCP frame-seq gate
//!        uses an interval estimate that's currently a guess. We
//!        record per-frame deltas + emit a rolling p50/p95/p99 snapshot
//!        so PHASE_0_5_FINDINGS.md can be filled in with real numbers.
//!
//!   F2 — pipeline_budget_ms recalibration cadence. The MCP honours the
//!        worker-reported budget but the worker doesn't recalibrate.
//!        This module exposes a single estimate (paint+encode+transport
//!        proxy) computed from the rolling interval window so callers
//!        can sample whether the budget has drifted enough to warrant
//!        a re-broadcast.
//!
//! Per-DISPLAY (which is per-session in the worker) tracker lives
//! behind a global lazy_static map so the runner-side dispatch loop
//! can hand frames in without threading state through. Periodic
//! snapshot publishing happens from a single background task started
//! at the first `record_end_of_frame` call.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use lazy_static::lazy_static;

/// Rolling window of inter-frame deltas. Capped so a long-running
/// session doesn't grow unbounded.
const WINDOW_SIZE: usize = 256;
/// How often a publish task refreshes the global snapshot.
pub const PUBLISH_INTERVAL: Duration = Duration::from_secs(5);

/// One session's accumulator. End-of-frame events feed `record_end()`;
/// snapshots are computed lazily.
#[derive(Debug)]
struct IntervalAccumulator {
    last_end_of_frame: Option<Instant>,
    deltas_ms: VecDeque<f64>,
    total_frames: u64,
}

impl IntervalAccumulator {
    fn new() -> Self {
        Self {
            last_end_of_frame: None,
            deltas_ms: VecDeque::with_capacity(WINDOW_SIZE),
            total_frames: 0,
        }
    }

    fn record_end(&mut self, now: Instant) {
        self.total_frames += 1;
        if let Some(prev) = self.last_end_of_frame {
            let ms = now.duration_since(prev).as_secs_f64() * 1000.0;
            if ms.is_finite() && ms >= 0.0 {
                self.deltas_ms.push_back(ms);
                if self.deltas_ms.len() > WINDOW_SIZE {
                    self.deltas_ms.pop_front();
                }
            }
        }
        self.last_end_of_frame = Some(now);
    }

    fn snapshot(&self) -> FrameTimingSnapshot {
        let n = self.deltas_ms.len();
        if n == 0 {
            return FrameTimingSnapshot::empty(self.total_frames);
        }
        let mut sorted: Vec<f64> = self.deltas_ms.iter().copied().collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let pct = |p: f64| -> f64 {
            let idx = ((p / 100.0) * (n as f64 - 1.0)).round() as usize;
            sorted[idx.min(n - 1)]
        };
        let mean = sorted.iter().sum::<f64>() / n as f64;
        let p50 = pct(50.0);
        let p95 = pct(95.0);
        let p99 = pct(99.0);
        let min = sorted[0];
        let max = sorted[n - 1];
        // F2 budget proxy: paint+encode+transport ≈ p95 of intervals.
        // This is a coarse heuristic — real components require an HMR-
        // overlay round-trip probe (deferred). The proxy lets us see
        // drift without owning the calibration loop today.
        let pipeline_budget_estimate_ms = p95.ceil() as u64;
        FrameTimingSnapshot {
            total_frames: self.total_frames,
            sample_count: n as u64,
            mean_ms: round_ms(mean),
            min_ms: round_ms(min),
            p50_ms: round_ms(p50),
            p95_ms: round_ms(p95),
            p99_ms: round_ms(p99),
            max_ms: round_ms(max),
            pipeline_budget_estimate_ms,
        }
    }
}

fn round_ms(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[derive(Clone, Debug)]
pub struct FrameTimingSnapshot {
    pub total_frames: u64,
    pub sample_count: u64,
    pub mean_ms: f64,
    pub min_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
    /// F2 estimate: a rolling pipeline_budget_ms proxy = ceil(p95). See
    /// the module-level note about its limits.
    pub pipeline_budget_estimate_ms: u64,
}

impl FrameTimingSnapshot {
    pub fn empty(total_frames: u64) -> Self {
        Self {
            total_frames,
            sample_count: 0,
            mean_ms: 0.0,
            min_ms: 0.0,
            p50_ms: 0.0,
            p95_ms: 0.0,
            p99_ms: 0.0,
            max_ms: 0.0,
            pipeline_budget_estimate_ms: 0,
        }
    }
}

lazy_static! {
    static ref ACCUMULATORS: RwLock<HashMap<String, Mutex<IntervalAccumulator>>> =
        RwLock::new(HashMap::new());
    /// session_id → most-recent published snapshot. Cheap to poll;
    /// updated by the publish task on PUBLISH_INTERVAL cadence.
    static ref PUBLISHED: RwLock<HashMap<String, FrameTimingSnapshot>> = RwLock::new(HashMap::new());
}

/// Record an end-of-frame for a session. Called from the runner's RTP
/// dispatch loop on every marker-bit packet. Cheap (one mutex per
/// frame); on the worker the marker rate is ≤60 Hz so contention is
/// negligible.
pub fn record_end_of_frame(session_id: &str) {
    let now = Instant::now();
    {
        let map = ACCUMULATORS.read().expect("accumulators poisoned");
        if let Some(slot) = map.get(session_id) {
            if let Ok(mut acc) = slot.lock() {
                acc.record_end(now);
                return;
            }
        }
    }
    // Slow-path: insert a new accumulator.
    let mut map = ACCUMULATORS.write().expect("accumulators poisoned");
    let entry = map
        .entry(session_id.to_string())
        .or_insert_with(|| Mutex::new(IntervalAccumulator::new()));
    if let Ok(mut acc) = entry.lock() {
        acc.record_end(now);
    };
}

/// Snapshot a session's current interval distribution. Returns
/// `Empty` shape when the accumulator has fewer than two recorded
/// frames.
pub fn snapshot(session_id: &str) -> FrameTimingSnapshot {
    let map = ACCUMULATORS.read().expect("accumulators poisoned");
    if let Some(slot) = map.get(session_id) {
        if let Ok(acc) = slot.lock() {
            return acc.snapshot();
        }
    }
    FrameTimingSnapshot::empty(0)
}

/// Snapshot of every active session's distribution (for admin/operator
/// dashboards).
pub fn all_snapshots() -> Vec<(String, FrameTimingSnapshot)> {
    let map = ACCUMULATORS.read().expect("accumulators poisoned");
    let mut out = Vec::with_capacity(map.len());
    for (sid, slot) in map.iter() {
        if let Ok(acc) = slot.lock() {
            out.push((sid.clone(), acc.snapshot()));
        }
    }
    out
}

/// Publish the latest snapshot into the cache. Callers that want the
/// most recent published value (without recomputing) read from
/// `latest_published`. Used by the periodic build-log emitter so the
/// hot path doesn't recompute percentiles on every frame.
pub fn publish_snapshots() {
    let snapshots = all_snapshots();
    let mut published = PUBLISHED.write().expect("published poisoned");
    published.clear();
    for (sid, snap) in snapshots {
        published.insert(sid, snap);
    }
}

pub fn latest_published(session_id: &str) -> Option<FrameTimingSnapshot> {
    let map = PUBLISHED.read().expect("published poisoned");
    map.get(session_id).cloned()
}

pub fn unregister(session_id: &str) {
    let mut map = ACCUMULATORS.write().expect("accumulators poisoned");
    map.remove(session_id);
    let mut published = PUBLISHED.write().expect("published poisoned");
    published.remove(session_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn empty_session_returns_empty_snapshot() {
        let s = snapshot("never-recorded");
        assert_eq!(s.total_frames, 0);
        assert_eq!(s.sample_count, 0);
    }

    #[test]
    fn single_frame_records_total_but_no_intervals() {
        let sid = "single-frame-session";
        record_end_of_frame(sid);
        let s = snapshot(sid);
        assert_eq!(s.total_frames, 1);
        assert_eq!(s.sample_count, 0);
        unregister(sid);
    }

    #[test]
    fn percentiles_increase_monotonically() {
        let sid = "monotonic";
        record_end_of_frame(sid);
        for _ in 0..10 {
            thread::sleep(Duration::from_millis(2));
            record_end_of_frame(sid);
        }
        let s = snapshot(sid);
        assert!(s.sample_count >= 10);
        assert!(s.p50_ms <= s.p95_ms);
        assert!(s.p95_ms <= s.p99_ms);
        assert!(s.p99_ms <= s.max_ms);
        assert!(s.pipeline_budget_estimate_ms >= s.p95_ms.ceil() as u64);
        unregister(sid);
    }

    #[test]
    fn publish_round_trips() {
        let sid = "publish-test";
        record_end_of_frame(sid);
        thread::sleep(Duration::from_millis(2));
        record_end_of_frame(sid);
        publish_snapshots();
        let pub_snap = latest_published(sid).expect("published snapshot missing");
        assert!(pub_snap.sample_count >= 1);
        unregister(sid);
    }

    #[test]
    fn unregister_clears_state() {
        let sid = "to-unregister";
        record_end_of_frame(sid);
        record_end_of_frame(sid);
        publish_snapshots();
        unregister(sid);
        let after = snapshot(sid);
        assert_eq!(after.sample_count, 0);
        assert_eq!(after.total_frames, 0);
        assert!(latest_published(sid).is_none());
    }
}
