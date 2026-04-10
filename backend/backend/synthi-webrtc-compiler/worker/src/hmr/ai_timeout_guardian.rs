// ============================================================
// AI TIMEOUT GUARDIAN
// ============================================================
// Manages timeouts for AI requests, scaling them based on
// priority and historical response times.  Prevents the planner
// from blocking indefinitely on a slow AI backend.
// ============================================================


use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

use crate::hmr::ai_request_contract::AiPriority;

/// Timeout configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeoutConfig {
    /// Base timeout per priority level (millis).
    pub base_timeouts: PriorityTimeouts,
    /// Minimum timeout regardless of history (millis).
    pub min_timeout_ms: u64,
    /// Maximum timeout regardless of history (millis).
    pub max_timeout_ms: u64,
    /// How many recent response times to track.
    pub history_window: usize,
    /// Percentile to use from history (e.g. 95 for p95).
    pub target_percentile: u8,
    /// Multiplier applied to percentile estimate.
    pub safety_multiplier: f64,
}

/// Base timeouts per priority.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriorityTimeouts {
    pub low_ms: u64,
    pub medium_ms: u64,
    pub high_ms: u64,
    pub critical_ms: u64,
}

impl Default for TimeoutConfig {
    fn default() -> Self {
        Self {
            base_timeouts: PriorityTimeouts {
                low_ms: 15_000,
                medium_ms: 10_000,
                high_ms: 5_000,
                critical_ms: 3_000,
            },
            min_timeout_ms: 2_000,
            max_timeout_ms: 30_000,
            history_window: 50,
            target_percentile: 95,
            safety_multiplier: 1.5,
        }
    }
}

/// Timeout decision.
#[derive(Debug, Clone)]
pub struct TimeoutDecision {
    /// Computed timeout in millis.
    pub timeout_ms: u64,
    /// Source of the timeout decision.
    pub source: TimeoutSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimeoutSource {
    /// Using base timeout (no history).
    Base,
    /// Computed from historical p-th percentile.
    Historical { percentile_ms: u64 },
    /// Clamped to minimum.
    MinClamped,
    /// Clamped to maximum.
    MaxClamped,
}

/// Tracks AI response times and computes adaptive timeouts.
pub struct TimeoutGuardian {
    config: TimeoutConfig,
    /// Recent response times (millis).
    history: VecDeque<u64>,
}

impl TimeoutGuardian {
    pub fn new(config: TimeoutConfig) -> Self {
        Self {
            history: VecDeque::with_capacity(config.history_window),
            config,
        }
    }

    /// Compute the timeout for a given priority.
    pub fn compute_timeout(&self, priority: AiPriority) -> TimeoutDecision {
        let base = self.base_for_priority(priority);

        // If not enough history, use base
        if self.history.len() < 5 {
            return self.clamp(base, TimeoutSource::Base);
        }

        // Compute percentile from history
        let mut sorted: Vec<u64> = self.history.iter().cloned().collect();
        sorted.sort_unstable();
        let idx = ((self.config.target_percentile as f64 / 100.0)
            * (sorted.len() as f64 - 1.0)) as usize;
        let percentile_ms = sorted[idx.min(sorted.len() - 1)];

        let adaptive = (percentile_ms as f64 * self.config.safety_multiplier) as u64;

        // Use the smaller of base and adaptive (don't exceed base for high priority)
        let timeout = match priority {
            AiPriority::Critical | AiPriority::High => adaptive.min(base),
            _ => adaptive.max(base),
        };

        self.clamp(
            timeout,
            TimeoutSource::Historical { percentile_ms },
        )
    }

    /// Record a response time.
    pub fn record_response_time(&mut self, duration_ms: u64) {
        if self.history.len() >= self.config.history_window {
            self.history.pop_front();
        }
        self.history.push_back(duration_ms);
    }

    fn base_for_priority(&self, priority: AiPriority) -> u64 {
        match priority {
            AiPriority::Low => self.config.base_timeouts.low_ms,
            AiPriority::Medium => self.config.base_timeouts.medium_ms,
            AiPriority::High => self.config.base_timeouts.high_ms,
            AiPriority::Critical => self.config.base_timeouts.critical_ms,
        }
    }

    fn clamp(&self, timeout: u64, source: TimeoutSource) -> TimeoutDecision {
        if timeout < self.config.min_timeout_ms {
            TimeoutDecision {
                timeout_ms: self.config.min_timeout_ms,
                source: TimeoutSource::MinClamped,
            }
        } else if timeout > self.config.max_timeout_ms {
            TimeoutDecision {
                timeout_ms: self.config.max_timeout_ms,
                source: TimeoutSource::MaxClamped,
            }
        } else {
            TimeoutDecision {
                timeout_ms: timeout,
                source,
            }
        }
    }

    /// Average response time (or None if no history).
    pub fn avg_response_ms(&self) -> Option<u64> {
        if self.history.is_empty() {
            None
        } else {
            let sum: u64 = self.history.iter().sum();
            Some(sum / self.history.len() as u64)
        }
    }

    /// Number of recorded samples.
    pub fn sample_count(&self) -> usize {
        self.history.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_timeout_no_history() {
        let guardian = TimeoutGuardian::new(TimeoutConfig::default());
        let decision = guardian.compute_timeout(AiPriority::Medium);
        assert_eq!(decision.timeout_ms, 10_000);
        assert_eq!(decision.source, TimeoutSource::Base);
    }

    #[test]
    fn adaptive_with_history() {
        let mut guardian = TimeoutGuardian::new(TimeoutConfig::default());
        for _ in 0..10 {
            guardian.record_response_time(200);
        }
        let decision = guardian.compute_timeout(AiPriority::Low);
        // Should use adaptive or base, whichever is larger for low priority
        assert!(decision.timeout_ms >= 200);
    }

    #[test]
    fn clamp_max() {
        let mut guardian = TimeoutGuardian::new(TimeoutConfig {
            max_timeout_ms: 5000,
            ..Default::default()
        });
        for _ in 0..10 {
            guardian.record_response_time(50_000);
        }
        let decision = guardian.compute_timeout(AiPriority::Low);
        assert_eq!(decision.timeout_ms, 5000);
    }
}
