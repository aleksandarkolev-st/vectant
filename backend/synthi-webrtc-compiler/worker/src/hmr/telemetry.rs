// ============================================================
// HMR TELEMETRY — TIMING & ROLLBACK INSTRUMENTATION
// ============================================================
// Lightweight in-process counters and histograms for:
//   - compile_requested → compile_finished latency
//   - reload_planned → reload_applied latency
//   - rollback reasons distribution
//
// No external dependencies. Consumed by a future /metrics
// endpoint and baseline latency reporting.
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Histogram bucket boundaries in milliseconds.
const LATENCY_BUCKETS: &[u64] = &[50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

/// A simple histogram that counts values into pre-defined buckets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatencyHistogram {
    /// Bucket upper bounds (ms) and their counts.
    pub buckets: Vec<(u64, u64)>,
    /// Total observations.
    pub count: u64,
    /// Sum of all observed values (ms).
    pub sum: u64,
    /// Maximum observed value (ms).
    pub max: u64,
}

impl LatencyHistogram {
    pub fn new() -> Self {
        Self {
            buckets: LATENCY_BUCKETS.iter().map(|&b| (b, 0)).collect(),
            count: 0,
            sum: 0,
            max: 0,
        }
    }

    pub fn observe(&mut self, value_ms: u64) {
        self.count += 1;
        self.sum += value_ms;
        if value_ms > self.max {
            self.max = value_ms;
        }
        for bucket in &mut self.buckets {
            if value_ms <= bucket.0 {
                bucket.1 += 1;
                return;
            }
        }
        // Overflows the largest bucket — count in the last one.
        if let Some(last) = self.buckets.last_mut() {
            last.1 += 1;
        }
    }

    /// Approximate p-th percentile (0.0–1.0).
    pub fn percentile(&self, p: f64) -> u64 {
        if self.count == 0 {
            return 0;
        }
        let target = (p * self.count as f64).ceil() as u64;
        let mut cumulative = 0u64;
        for &(bound, count) in &self.buckets {
            cumulative += count;
            if cumulative >= target {
                return bound;
            }
        }
        self.max
    }
}

/// Compile timing span.
pub struct CompileSpan {
    pub start: Instant,
    pub preview_id: String,
}

/// Reload timing span.
pub struct ReloadSpan {
    pub start: Instant,
    pub preview_id: String,
    pub decision: String,
}

/// Thread-safe telemetry store.
#[derive(Clone)]
pub struct HmrTelemetry {
    inner: Arc<Mutex<HmrTelemetryInner>>,
    /// Atomic counter for total compiles (fast path).
    pub total_compiles: Arc<AtomicU64>,
    /// Atomic counter for total reloads.
    pub total_reloads: Arc<AtomicU64>,
}

struct HmrTelemetryInner {
    /// compile_requested → compile_finished (ms)
    compile_latency: LatencyHistogram,
    /// reload_planned → reload_applied (ms)
    reload_latency: LatencyHistogram,
    /// Rollback reason → count
    rollback_reasons: HashMap<String, u64>,
    /// Per-decision type count.
    decision_counts: HashMap<String, u64>,
}

impl HmrTelemetry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HmrTelemetryInner {
                compile_latency: LatencyHistogram::new(),
                reload_latency: LatencyHistogram::new(),
                rollback_reasons: HashMap::new(),
                decision_counts: HashMap::new(),
            })),
            total_compiles: Arc::new(AtomicU64::new(0)),
            total_reloads: Arc::new(AtomicU64::new(0)),
        }
    }

    // ── Compile timing ───────────────────────────────────────

    /// Call when a compile is requested. Returns a span to finish later.
    pub fn start_compile(&self, preview_id: impl Into<String>) -> CompileSpan {
        self.total_compiles.fetch_add(1, Ordering::Relaxed);
        CompileSpan {
            start: Instant::now(),
            preview_id: preview_id.into(),
        }
    }

    /// Call when a compile finishes.
    pub fn finish_compile(&self, span: &CompileSpan) {
        let elapsed = span.start.elapsed().as_millis() as u64;
        let mut inner = self.inner.lock().unwrap();
        inner.compile_latency.observe(elapsed);
    }

    // ── Reload timing ────────────────────────────────────────

    /// Call when the planner makes a reload decision.
    pub fn start_reload(
        &self,
        preview_id: impl Into<String>,
        decision: impl Into<String>,
    ) -> ReloadSpan {
        self.total_reloads.fetch_add(1, Ordering::Relaxed);
        let decision = decision.into();
        {
            let mut inner = self.inner.lock().unwrap();
            *inner.decision_counts.entry(decision.clone()).or_default() += 1;
        }
        ReloadSpan {
            start: Instant::now(),
            preview_id: preview_id.into(),
            decision,
        }
    }

    /// Call when the reload is applied (candidate promoted).
    pub fn finish_reload(&self, span: &ReloadSpan) {
        let elapsed = span.start.elapsed().as_millis() as u64;
        let mut inner = self.inner.lock().unwrap();
        inner.reload_latency.observe(elapsed);
    }

    // ── Rollback tracking ────────────────────────────────────

    /// Record a rollback with its reason code.
    pub fn record_rollback(&self, reason_code: impl Into<String>) {
        let mut inner = self.inner.lock().unwrap();
        *inner
            .rollback_reasons
            .entry(reason_code.into())
            .or_default() += 1;
    }

    // ── Reporting ────────────────────────────────────────────

    /// Produce a snapshot report for logging or an admin endpoint.
    pub fn report(&self) -> TelemetryReport {
        let inner = self.inner.lock().unwrap();
        TelemetryReport {
            total_compiles: self.total_compiles.load(Ordering::Relaxed),
            total_reloads: self.total_reloads.load(Ordering::Relaxed),
            compile_latency: inner.compile_latency.clone(),
            reload_latency: inner.reload_latency.clone(),
            rollback_reasons: inner.rollback_reasons.clone(),
            decision_counts: inner.decision_counts.clone(),
        }
    }
}

/// Serializable telemetry snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryReport {
    pub total_compiles: u64,
    pub total_reloads: u64,
    pub compile_latency: LatencyHistogram,
    pub reload_latency: LatencyHistogram,
    pub rollback_reasons: HashMap<String, u64>,
    pub decision_counts: HashMap<String, u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn histogram_basic() {
        let mut h = LatencyHistogram::new();
        h.observe(42);
        h.observe(150);
        h.observe(800);
        assert_eq!(h.count, 3);
        assert_eq!(h.sum, 992);
        assert_eq!(h.max, 800);
    }

    #[test]
    fn histogram_percentile() {
        let mut h = LatencyHistogram::new();
        for _ in 0..100 {
            h.observe(80);
        }
        // All observations are ≤100 bucket
        assert_eq!(h.percentile(0.5), 100);
        assert_eq!(h.percentile(0.95), 100);
    }

    #[test]
    fn telemetry_compile_roundtrip() {
        let t = HmrTelemetry::new();
        let span = t.start_compile("p1");
        t.finish_compile(&span);
        let report = t.report();
        assert_eq!(report.total_compiles, 1);
        assert_eq!(report.compile_latency.count, 1);
    }

    #[test]
    fn telemetry_rollback_tracking() {
        let t = HmrTelemetry::new();
        t.record_rollback("abi_incompatible");
        t.record_rollback("abi_incompatible");
        t.record_rollback("candidate_crash");
        let report = t.report();
        assert_eq!(report.rollback_reasons.get("abi_incompatible"), Some(&2));
        assert_eq!(report.rollback_reasons.get("candidate_crash"), Some(&1));
    }

    #[test]
    fn telemetry_decision_counts() {
        let t = HmrTelemetry::new();
        let _span = t.start_reload("p1", "warm_reload");
        let _span2 = t.start_reload("p1", "warm_reload");
        let _span3 = t.start_reload("p1", "cold_reload");
        let report = t.report();
        assert_eq!(report.decision_counts.get("warm_reload"), Some(&2));
        assert_eq!(report.decision_counts.get("cold_reload"), Some(&1));
    }
}
