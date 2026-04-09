// ============================================================
// DYNLIB METRICS COLLECTOR
// ============================================================
// Collects timing and resource metrics for every phase of the
// dynlib lifecycle: load, symbol resolution, swap, state
// transfer, health check.  Feeds telemetry pipeline.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// A single timing measurement.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metric {
    pub name: String,
    pub value_ms: f64,
    pub timestamp_ms: u64,
}

/// Aggregate statistics for a metric series.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricStats {
    pub name: String,
    pub count: u64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub sum_ms: f64,
    pub mean_ms: f64,
}

impl MetricStats {
    fn new(name: &str) -> Self {
        Self {
            name: name.into(),
            count: 0,
            min_ms: f64::MAX,
            max_ms: 0.0,
            sum_ms: 0.0,
            mean_ms: 0.0,
        }
    }

    fn record(&mut self, value_ms: f64) {
        self.count += 1;
        self.sum_ms += value_ms;
        if value_ms < self.min_ms {
            self.min_ms = value_ms;
        }
        if value_ms > self.max_ms {
            self.max_ms = value_ms;
        }
        self.mean_ms = self.sum_ms / self.count as f64;
    }
}

/// Phases we collect metrics for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DynLibPhaseMetric {
    Load,
    SymbolResolve,
    PreloadValidate,
    StateExport,
    StateImport,
    Swap,
    HealthCheck,
    Rollback,
    TotalReload,
}

impl DynLibPhaseMetric {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Load => "dynlib.load",
            Self::SymbolResolve => "dynlib.symbol_resolve",
            Self::PreloadValidate => "dynlib.preload_validate",
            Self::StateExport => "dynlib.state_export",
            Self::StateImport => "dynlib.state_import",
            Self::Swap => "dynlib.swap",
            Self::HealthCheck => "dynlib.health_check",
            Self::Rollback => "dynlib.rollback",
            Self::TotalReload => "dynlib.total_reload",
        }
    }
}

/// Metrics collector for DynLib operations.
pub struct DynLibMetrics {
    /// Raw metric log.
    samples: Vec<Metric>,
    /// Running stats per phase.
    stats: Vec<(DynLibPhaseMetric, MetricStats)>,
    /// Memory delta (bytes) from last reload.
    pub last_memory_delta_bytes: i64,
    /// Reload count.
    pub reload_count: u64,
    /// Failed reload count.
    pub failed_reload_count: u64,
}

impl DynLibMetrics {
    pub fn new() -> Self {
        Self {
            samples: Vec::new(),
            stats: Vec::new(),
            last_memory_delta_bytes: 0,
            reload_count: 0,
            failed_reload_count: 0,
        }
    }

    /// Record a timing measurement for a phase.
    pub fn record(&mut self, phase: DynLibPhaseMetric, value_ms: f64, timestamp_ms: u64) {
        self.samples.push(Metric {
            name: phase.as_str().into(),
            value_ms,
            timestamp_ms,
        });

        if let Some(entry) = self.stats.iter_mut().find(|(p, _)| *p == phase) {
            entry.1.record(value_ms);
        } else {
            let mut s = MetricStats::new(phase.as_str());
            s.record(value_ms);
            self.stats.push((phase, s));
        }
    }

    /// Record a completed reload.
    pub fn record_reload(&mut self, total_ms: f64, timestamp_ms: u64, memory_delta: i64) {
        self.reload_count += 1;
        self.last_memory_delta_bytes = memory_delta;
        self.record(DynLibPhaseMetric::TotalReload, total_ms, timestamp_ms);
    }

    /// Record a failed reload.
    pub fn record_failed_reload(&mut self) {
        self.failed_reload_count += 1;
    }

    /// Get stats for a specific phase.
    pub fn stats_for(&self, phase: DynLibPhaseMetric) -> Option<&MetricStats> {
        self.stats.iter().find(|(p, _)| *p == phase).map(|(_, s)| s)
    }

    /// Total samples collected.
    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }

    /// Summary of all phases.
    pub fn summary(&self) -> Vec<MetricStats> {
        self.stats.iter().map(|(_, s)| s.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_aggregates() {
        let mut m = DynLibMetrics::new();
        m.record(DynLibPhaseMetric::Load, 10.0, 1000);
        m.record(DynLibPhaseMetric::Load, 20.0, 2000);
        m.record(DynLibPhaseMetric::SymbolResolve, 5.0, 1500);

        let load_stats = m.stats_for(DynLibPhaseMetric::Load).unwrap();
        assert_eq!(load_stats.count, 2);
        assert!((load_stats.mean_ms - 15.0).abs() < 0.01);
        assert!((load_stats.min_ms - 10.0).abs() < 0.01);
        assert!((load_stats.max_ms - 20.0).abs() < 0.01);

        assert_eq!(m.sample_count(), 3);
    }

    #[test]
    fn tracks_reloads() {
        let mut m = DynLibMetrics::new();
        m.record_reload(45.0, 1000, 2048);
        m.record_reload(50.0, 2000, -512);

        assert_eq!(m.reload_count, 2);
        assert_eq!(m.last_memory_delta_bytes, -512);

        let total = m.stats_for(DynLibPhaseMetric::TotalReload).unwrap();
        assert_eq!(total.count, 2);
    }

    #[test]
    fn summary_covers_all_phases() {
        let mut m = DynLibMetrics::new();
        m.record(DynLibPhaseMetric::Swap, 8.0, 100);
        m.record(DynLibPhaseMetric::HealthCheck, 3.0, 200);

        let summary = m.summary();
        assert_eq!(summary.len(), 2);
    }
}
