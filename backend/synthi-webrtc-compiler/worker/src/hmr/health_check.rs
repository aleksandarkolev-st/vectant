// ============================================================
// CANDIDATE HEALTH CHECK CONTRACT
// ============================================================
// Defines how a reload candidate is validated before it replaces
// the current module. Each adapter family / language provides its
// own health-check implementation, but they all conform to this
// trait.
// ============================================================

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::hmr::build_manifest::HealthcheckStrategy;

/// Result of a candidate health check.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum HealthCheckResult {
    /// Candidate is healthy and can replace the current module.
    Healthy {
        latency_ms: u64,
    },
    /// Candidate is unhealthy — rollback to previous module.
    Unhealthy {
        reason: String,
        latency_ms: u64,
    },
    /// Health check timed out.
    Timeout {
        timeout_ms: u64,
    },
    /// Health check skipped (e.g., no strategy configured).
    Skipped,
}

impl HealthCheckResult {
    pub fn is_healthy(&self) -> bool {
        matches!(self, HealthCheckResult::Healthy { .. } | HealthCheckResult::Skipped)
    }

    pub fn is_failure(&self) -> bool {
        matches!(
            self,
            HealthCheckResult::Unhealthy { .. } | HealthCheckResult::Timeout { .. }
        )
    }

    pub fn failure_reason(&self) -> Option<&str> {
        match self {
            HealthCheckResult::Unhealthy { reason, .. } => Some(reason),
            HealthCheckResult::Timeout { timeout_ms: _ } => None, // caller can format
            _ => None,
        }
    }
}

/// Configuration for health check execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthCheckConfig {
    /// The strategy to use.
    pub strategy: HealthcheckStrategy,
    /// Maximum time to wait for the health check to complete.
    pub timeout: Duration,
    /// Number of retries before declaring unhealthy.
    pub max_retries: u32,
    /// Delay between retries.
    pub retry_delay: Duration,
}

impl Default for HealthCheckConfig {
    fn default() -> Self {
        Self {
            strategy: HealthcheckStrategy::SymbolCheck,
            timeout: Duration::from_secs(5),
            max_retries: 1,
            retry_delay: Duration::from_millis(200),
        }
    }
}

impl HealthCheckConfig {
    /// Config appropriate for dlopen / symbol probe checks.
    pub fn for_symbol_probe() -> Self {
        Self {
            strategy: HealthcheckStrategy::SymbolCheck,
            timeout: Duration::from_secs(2),
            max_retries: 0,
            retry_delay: Duration::from_millis(0),
        }
    }

    /// Config appropriate for TCP/HTTP health probes.
    pub fn for_http_probe() -> Self {
        Self {
            strategy: HealthcheckStrategy::FirstTick,
            timeout: Duration::from_secs(10),
            max_retries: 2,
            retry_delay: Duration::from_millis(500),
        }
    }

    /// Config appropriate for process exit-code checks.
    pub fn for_exit_code() -> Self {
        Self {
            strategy: HealthcheckStrategy::StartupSequence,
            timeout: Duration::from_secs(5),
            max_retries: 0,
            retry_delay: Duration::from_millis(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy_result() {
        let r = HealthCheckResult::Healthy { latency_ms: 50 };
        assert!(r.is_healthy());
        assert!(!r.is_failure());
    }

    #[test]
    fn unhealthy_result() {
        let r = HealthCheckResult::Unhealthy {
            reason: "segfault".into(),
            latency_ms: 10,
        };
        assert!(!r.is_healthy());
        assert!(r.is_failure());
        assert_eq!(r.failure_reason(), Some("segfault"));
    }

    #[test]
    fn timeout_result() {
        let r = HealthCheckResult::Timeout { timeout_ms: 5000 };
        assert!(r.is_failure());
    }

    #[test]
    fn skipped_is_ok() {
        let r = HealthCheckResult::Skipped;
        assert!(r.is_healthy());
    }

    #[test]
    fn config_defaults() {
        let cfg = HealthCheckConfig::default();
        assert_eq!(cfg.timeout, Duration::from_secs(5));
        assert!(matches!(cfg.strategy, HealthcheckStrategy::SymbolCheck));
    }

    #[test]
    fn serde_roundtrip() {
        let r = HealthCheckResult::Healthy { latency_ms: 100 };
        let json = serde_json::to_string(&r).unwrap();
        let back: HealthCheckResult = serde_json::from_str(&json).unwrap();
        assert!(back.is_healthy());
    }
}
