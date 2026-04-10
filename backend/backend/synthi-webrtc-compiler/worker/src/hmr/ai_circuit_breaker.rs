// ============================================================
// AI CIRCUIT BREAKER
// ============================================================
// Prevents cascading failures by tracking AI backend health.
// Uses the classic circuit-breaker pattern: Closed → Open →
// Half-Open, with configurable thresholds and cooldowns.
// ============================================================


use serde::{Deserialize, Serialize};

/// Circuit breaker state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CircuitState {
    /// Normal operation — requests flow through.
    Closed,
    /// Too many failures — requests are blocked.
    Open,
    /// Probing — allowing one request to test recovery.
    HalfOpen,
}

/// Circuit breaker configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircuitBreakerConfig {
    /// Number of consecutive failures to open the circuit.
    pub failure_threshold: u32,
    /// Time to stay open before transitioning to half-open (millis).
    pub open_duration_ms: u64,
    /// Number of successes in half-open to close the circuit.
    pub recovery_threshold: u32,
    /// Whether to count timeouts as failures.
    pub count_timeouts: bool,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            failure_threshold: 3,
            open_duration_ms: 30_000, // 30 seconds
            recovery_threshold: 2,
            count_timeouts: true,
        }
    }
}

/// Result of checking the circuit breaker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CircuitCheckResult {
    /// Request allowed.
    Allow,
    /// Request blocked (circuit open).
    Block { retry_after_ms: u64 },
    /// Probe request (circuit half-open, only one allowed).
    Probe,
}

/// The circuit breaker.
pub struct CircuitBreaker {
    config: CircuitBreakerConfig,
    state: CircuitState,
    consecutive_failures: u32,
    consecutive_successes: u32,
    opened_at_ms: u64,
    total_trips: u32,
}

impl CircuitBreaker {
    pub fn new(config: CircuitBreakerConfig) -> Self {
        Self {
            config,
            state: CircuitState::Closed,
            consecutive_failures: 0,
            consecutive_successes: 0,
            opened_at_ms: 0,
            total_trips: 0,
        }
    }

    /// Check whether a request should be allowed.
    pub fn check(&self, now_ms: u64) -> CircuitCheckResult {
        match self.state {
            CircuitState::Closed => CircuitCheckResult::Allow,

            CircuitState::Open => {
                let elapsed = now_ms.saturating_sub(self.opened_at_ms);
                if elapsed >= self.config.open_duration_ms {
                    CircuitCheckResult::Probe
                } else {
                    CircuitCheckResult::Block {
                        retry_after_ms: self.config.open_duration_ms - elapsed,
                    }
                }
            }

            CircuitState::HalfOpen => CircuitCheckResult::Probe,
        }
    }

    /// Record a successful AI response.
    pub fn record_success(&mut self) {
        self.consecutive_failures = 0;

        match self.state {
            CircuitState::Closed => {
                // Already healthy
            }
            CircuitState::HalfOpen => {
                self.consecutive_successes += 1;
                if self.consecutive_successes >= self.config.recovery_threshold {
                    self.state = CircuitState::Closed;
                    self.consecutive_successes = 0;
                }
            }
            CircuitState::Open => {
                // Shouldn't happen, but treat as recovery
                self.state = CircuitState::HalfOpen;
                self.consecutive_successes = 1;
            }
        }
    }

    /// Record a failed AI response.
    pub fn record_failure(&mut self, now_ms: u64) {
        self.consecutive_successes = 0;
        self.consecutive_failures += 1;

        match self.state {
            CircuitState::Closed => {
                if self.consecutive_failures >= self.config.failure_threshold {
                    self.trip(now_ms);
                }
            }
            CircuitState::HalfOpen => {
                // Any failure in half-open re-opens
                self.trip(now_ms);
            }
            CircuitState::Open => {
                // Already open, update timestamp
                self.opened_at_ms = now_ms;
            }
        }
    }

    /// Record a timeout (if config.count_timeouts).
    pub fn record_timeout(&mut self, now_ms: u64) {
        if self.config.count_timeouts {
            self.record_failure(now_ms);
        }
    }

    /// Transition to half-open (called on probe decision).
    pub fn transition_to_half_open(&mut self) {
        if self.state == CircuitState::Open {
            self.state = CircuitState::HalfOpen;
            self.consecutive_successes = 0;
        }
    }

    /// Current state.
    pub fn state(&self) -> CircuitState {
        self.state
    }

    /// Total number of times the circuit has tripped.
    pub fn total_trips(&self) -> u32 {
        self.total_trips
    }

    fn trip(&mut self, now_ms: u64) {
        self.state = CircuitState::Open;
        self.opened_at_ms = now_ms;
        self.total_trips += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_closed() {
        let cb = CircuitBreaker::new(CircuitBreakerConfig::default());
        assert_eq!(cb.state(), CircuitState::Closed);
        assert_eq!(cb.check(0), CircuitCheckResult::Allow);
    }

    #[test]
    fn trips_after_threshold() {
        let mut cb = CircuitBreaker::new(CircuitBreakerConfig {
            failure_threshold: 3,
            ..Default::default()
        });
        cb.record_failure(100);
        cb.record_failure(200);
        assert_eq!(cb.state(), CircuitState::Closed);
        cb.record_failure(300);
        assert_eq!(cb.state(), CircuitState::Open);
        assert_eq!(cb.total_trips(), 1);
    }

    #[test]
    fn blocks_when_open() {
        let mut cb = CircuitBreaker::new(CircuitBreakerConfig {
            failure_threshold: 1,
            open_duration_ms: 5000,
            ..Default::default()
        });
        cb.record_failure(1000);
        let result = cb.check(2000);
        assert!(matches!(result, CircuitCheckResult::Block { .. }));
    }

    #[test]
    fn probes_after_cooldown() {
        let mut cb = CircuitBreaker::new(CircuitBreakerConfig {
            failure_threshold: 1,
            open_duration_ms: 5000,
            ..Default::default()
        });
        cb.record_failure(1000);
        let result = cb.check(7000);
        assert_eq!(result, CircuitCheckResult::Probe);
    }

    #[test]
    fn recovers_through_half_open() {
        let mut cb = CircuitBreaker::new(CircuitBreakerConfig {
            failure_threshold: 1,
            open_duration_ms: 1000,
            recovery_threshold: 2,
            ..Default::default()
        });
        cb.record_failure(0);
        assert_eq!(cb.state(), CircuitState::Open);

        cb.transition_to_half_open();
        assert_eq!(cb.state(), CircuitState::HalfOpen);

        cb.record_success();
        assert_eq!(cb.state(), CircuitState::HalfOpen); // need 2
        cb.record_success();
        assert_eq!(cb.state(), CircuitState::Closed);
    }
}
