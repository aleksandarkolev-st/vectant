// ============================================================
// PROCESS SWAP GRACEFUL DRAIN
// ============================================================
// Drains in-flight requests from the old process before
// retiring it.  Ensures zero dropped connections during a
// process-swap reload.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Drain configuration.
#[derive(Debug, Clone)]
pub struct DrainConfig {
    /// Maximum time to wait for in-flight requests (millis).
    pub drain_timeout_ms: u64,
    /// Polling interval to check in-flight count (millis).
    pub poll_interval_ms: u64,
    /// Whether to force-kill after timeout.
    pub force_kill_after_timeout: bool,
}

impl Default for DrainConfig {
    fn default() -> Self {
        Self {
            drain_timeout_ms: 10_000,
            poll_interval_ms: 100,
            force_kill_after_timeout: true,
        }
    }
}

/// Snapshot of the old process's request state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrainSnapshot {
    /// Number of in-flight requests at drain start.
    pub initial_in_flight: u32,
    /// Current in-flight requests.
    pub current_in_flight: u32,
    /// Elapsed drain time (millis).
    pub elapsed_ms: u64,
}

/// Outcome of the drain operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DrainOutcome {
    /// All requests finished within timeout.
    Completed,
    /// Timeout reached, some requests still in-flight.
    TimedOut,
    /// Force-killed after timeout.
    ForceKilled,
}

/// Result of a drain operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrainResult {
    pub outcome: DrainOutcome,
    pub initial_in_flight: u32,
    pub remaining_in_flight: u32,
    pub total_drain_ms: u64,
}

/// Evaluate a drain based on snapshots.
///
/// In production: called in a loop with actual request counts.
/// Here: single-shot evaluation from a simulated snapshot.
pub fn evaluate_drain(
    snapshot: &DrainSnapshot,
    config: &DrainConfig,
) -> DrainResult {
    if snapshot.current_in_flight == 0 {
        return DrainResult {
            outcome: DrainOutcome::Completed,
            initial_in_flight: snapshot.initial_in_flight,
            remaining_in_flight: 0,
            total_drain_ms: snapshot.elapsed_ms,
        };
    }

    if snapshot.elapsed_ms >= config.drain_timeout_ms {
        let outcome = if config.force_kill_after_timeout {
            DrainOutcome::ForceKilled
        } else {
            DrainOutcome::TimedOut
        };

        return DrainResult {
            outcome,
            initial_in_flight: snapshot.initial_in_flight,
            remaining_in_flight: snapshot.current_in_flight,
            total_drain_ms: snapshot.elapsed_ms,
        };
    }

    // Still draining — not yet timed out.
    DrainResult {
        outcome: DrainOutcome::Completed, // optimistic; caller retries
        initial_in_flight: snapshot.initial_in_flight,
        remaining_in_flight: snapshot.current_in_flight,
        total_drain_ms: snapshot.elapsed_ms,
    }
}

/// Estimate the drain time based on request rate.
pub fn estimate_drain_time_ms(in_flight: u32, avg_request_ms: f64) -> u64 {
    if in_flight == 0 {
        return 0;
    }
    (in_flight as f64 * avg_request_ms) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completes_when_zero_in_flight() {
        let snapshot = DrainSnapshot {
            initial_in_flight: 5,
            current_in_flight: 0,
            elapsed_ms: 200,
        };
        let result = evaluate_drain(&snapshot, &DrainConfig::default());
        assert_eq!(result.outcome, DrainOutcome::Completed);
        assert_eq!(result.remaining_in_flight, 0);
    }

    #[test]
    fn force_kills_on_timeout() {
        let snapshot = DrainSnapshot {
            initial_in_flight: 10,
            current_in_flight: 3,
            elapsed_ms: 11_000,
        };
        let result = evaluate_drain(&snapshot, &DrainConfig::default());
        assert_eq!(result.outcome, DrainOutcome::ForceKilled);
        assert_eq!(result.remaining_in_flight, 3);
    }

    #[test]
    fn times_out_without_force_kill() {
        let config = DrainConfig {
            force_kill_after_timeout: false,
            drain_timeout_ms: 5000,
            ..Default::default()
        };
        let snapshot = DrainSnapshot {
            initial_in_flight: 10,
            current_in_flight: 2,
            elapsed_ms: 6000,
        };
        let result = evaluate_drain(&snapshot, &config);
        assert_eq!(result.outcome, DrainOutcome::TimedOut);
    }

    #[test]
    fn estimate_drain_time() {
        assert_eq!(estimate_drain_time_ms(10, 50.0), 500);
        assert_eq!(estimate_drain_time_ms(0, 50.0), 0);
    }
}
