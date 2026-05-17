// ============================================================
// MANAGED HEALTH PROBE
// ============================================================
// Health probing logic for managed runtimes (JVM / .NET).
// Pings the in-process agent, checks memory/GC metrics, and
// determines whether the runtime is healthy after a reload.
// ============================================================

use serde::{Deserialize, Serialize};

/// Health probe configuration.
#[derive(Debug, Clone)]
pub struct HealthProbeConfig {
    /// Ping timeout (millis).
    pub ping_timeout_ms: u64,
    /// Max heap usage percentage before degraded.
    pub heap_warning_pct: f64,
    /// Max heap usage percentage before faulted.
    pub heap_critical_pct: f64,
    /// Number of consecutive failed pings before faulted.
    pub max_ping_failures: u32,
}

impl Default for HealthProbeConfig {
    fn default() -> Self {
        Self {
            ping_timeout_ms: 2000,
            heap_warning_pct: 80.0,
            heap_critical_pct: 95.0,
            max_ping_failures: 3,
        }
    }
}

/// Metrics reported by the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeMetrics {
    /// Heap used (bytes).
    pub heap_used_bytes: u64,
    /// Heap max (bytes).
    pub heap_max_bytes: u64,
    /// Number of GC pauses since last probe.
    pub gc_pause_count: u32,
    /// Total GC pause millis since last probe.
    pub gc_pause_total_ms: u64,
    /// Thread count.
    pub thread_count: u32,
    /// Whether the agent responded to ping.
    pub ping_ok: bool,
    /// Ping round-trip (millis).
    pub ping_rtt_ms: u64,
}

/// Health verdict after probing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ManagedHealthStatus {
    Healthy,
    Degraded,
    Faulted,
}

/// Result of a health probe.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthProbeResult {
    pub status: ManagedHealthStatus,
    pub reasons: Vec<String>,
    pub metrics: RuntimeMetrics,
}

/// The health probe evaluator.
pub struct ManagedHealthProbe {
    config: HealthProbeConfig,
    consecutive_ping_failures: u32,
}

impl ManagedHealthProbe {
    pub fn new(config: HealthProbeConfig) -> Self {
        Self {
            config,
            consecutive_ping_failures: 0,
        }
    }

    /// Evaluate health from agent-reported metrics.
    pub fn evaluate(&mut self, metrics: RuntimeMetrics) -> HealthProbeResult {
        let mut reasons = Vec::new();
        let mut status = ManagedHealthStatus::Healthy;

        // Ping check.
        if !metrics.ping_ok {
            self.consecutive_ping_failures += 1;
            if self.consecutive_ping_failures >= self.config.max_ping_failures {
                status = ManagedHealthStatus::Faulted;
                reasons.push(format!(
                    "{} consecutive ping failures",
                    self.consecutive_ping_failures
                ));
            } else {
                status = ManagedHealthStatus::Degraded;
                reasons.push("ping failed".into());
            }
        } else {
            self.consecutive_ping_failures = 0;

            if metrics.ping_rtt_ms > self.config.ping_timeout_ms {
                status = ManagedHealthStatus::Degraded;
                reasons.push(format!(
                    "ping RTT {}ms exceeds timeout",
                    metrics.ping_rtt_ms
                ));
            }
        }

        // Heap check.
        if metrics.heap_max_bytes > 0 {
            let heap_pct = (metrics.heap_used_bytes as f64 / metrics.heap_max_bytes as f64) * 100.0;

            if heap_pct >= self.config.heap_critical_pct {
                status = ManagedHealthStatus::Faulted;
                reasons.push(format!("heap at {:.1}% (critical)", heap_pct));
            } else if heap_pct >= self.config.heap_warning_pct {
                if status == ManagedHealthStatus::Healthy {
                    status = ManagedHealthStatus::Degraded;
                }
                reasons.push(format!("heap at {:.1}% (warning)", heap_pct));
            }
        }

        HealthProbeResult {
            status,
            reasons,
            metrics,
        }
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive_ping_failures
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn healthy_metrics() -> RuntimeMetrics {
        RuntimeMetrics {
            heap_used_bytes: 100 * 1024 * 1024,
            heap_max_bytes: 512 * 1024 * 1024,
            gc_pause_count: 1,
            gc_pause_total_ms: 20,
            thread_count: 30,
            ping_ok: true,
            ping_rtt_ms: 5,
        }
    }

    #[test]
    fn healthy_runtime() {
        let mut probe = ManagedHealthProbe::new(HealthProbeConfig::default());
        let result = probe.evaluate(healthy_metrics());
        assert_eq!(result.status, ManagedHealthStatus::Healthy);
    }

    #[test]
    fn degraded_on_high_heap() {
        let mut probe = ManagedHealthProbe::new(HealthProbeConfig::default());
        let mut m = healthy_metrics();
        m.heap_used_bytes = 420 * 1024 * 1024; // ~82%
        let result = probe.evaluate(m);
        assert_eq!(result.status, ManagedHealthStatus::Degraded);
    }

    #[test]
    fn faulted_on_critical_heap() {
        let mut probe = ManagedHealthProbe::new(HealthProbeConfig::default());
        let mut m = healthy_metrics();
        m.heap_used_bytes = 500 * 1024 * 1024; // ~97%
        let result = probe.evaluate(m);
        assert_eq!(result.status, ManagedHealthStatus::Faulted);
    }

    #[test]
    fn faulted_after_repeated_ping_failures() {
        let mut probe = ManagedHealthProbe::new(HealthProbeConfig {
            max_ping_failures: 2,
            ..Default::default()
        });
        let mut m = healthy_metrics();
        m.ping_ok = false;

        let r1 = probe.evaluate(m.clone());
        assert_eq!(r1.status, ManagedHealthStatus::Degraded);

        let r2 = probe.evaluate(m);
        assert_eq!(r2.status, ManagedHealthStatus::Faulted);
    }
}
