// ============================================================
// CANDIDATE TIMEOUT WATCHDOG
// ============================================================
// Monitors active candidates for timeout conditions.  If a
// candidate stays in a non-terminal state beyond configured
// limits, the watchdog triggers rollback or discard.
// ============================================================

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::hmr::candidate::CandidateState;

/// Per-state timeout configuration.
#[derive(Debug, Clone)]
pub struct CandidateTimeouts {
    /// Max time in Loading state.
    pub loading_timeout: Duration,
    /// Max time in HealthChecking state.
    pub health_checking_timeout: Duration,
    /// Max time in Validated state before promotion must happen.
    pub validated_timeout: Duration,
    /// Max total candidate lifetime from Built to terminal.
    pub total_lifetime: Duration,
}

impl Default for CandidateTimeouts {
    fn default() -> Self {
        Self {
            loading_timeout: Duration::from_secs(5),
            health_checking_timeout: Duration::from_secs(3),
            validated_timeout: Duration::from_secs(2),
            total_lifetime: Duration::from_secs(15),
        }
    }
}

/// Result of a watchdog check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WatchdogAction {
    /// Candidate is within limits.
    Ok,
    /// Candidate should be rolled back (timeout in active state).
    Rollback {
        state: CandidateState,
        elapsed_ms: u64,
        limit_ms: u64,
    },
    /// Candidate should be discarded (stale overall).
    Discard { total_age_ms: u64, limit_ms: u64 },
}

/// Check whether a candidate has exceeded its timeouts.
pub fn check_candidate_timeout(
    state: CandidateState,
    state_duration: Duration,
    total_age: Duration,
    timeouts: &CandidateTimeouts,
) -> WatchdogAction {
    // Terminal states never trigger.
    if matches!(
        state,
        CandidateState::Promoted | CandidateState::RolledBack | CandidateState::Discarded
    ) {
        return WatchdogAction::Ok;
    }

    // Check total lifetime first.
    if total_age > timeouts.total_lifetime {
        return WatchdogAction::Discard {
            total_age_ms: total_age.as_millis() as u64,
            limit_ms: timeouts.total_lifetime.as_millis() as u64,
        };
    }

    // Check per-state timeout.
    let limit = match state {
        CandidateState::Loading => timeouts.loading_timeout,
        CandidateState::HealthChecking => timeouts.health_checking_timeout,
        CandidateState::Validated => timeouts.validated_timeout,
        CandidateState::Built => timeouts.total_lifetime, // Built is just queued
        _ => return WatchdogAction::Ok,
    };

    if state_duration > limit {
        return WatchdogAction::Rollback {
            state,
            elapsed_ms: state_duration.as_millis() as u64,
            limit_ms: limit.as_millis() as u64,
        };
    }

    WatchdogAction::Ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_limits() {
        let action = check_candidate_timeout(
            CandidateState::Loading,
            Duration::from_millis(500),
            Duration::from_millis(1000),
            &CandidateTimeouts::default(),
        );
        assert_eq!(action, WatchdogAction::Ok);
    }

    #[test]
    fn loading_timeout() {
        let action = check_candidate_timeout(
            CandidateState::Loading,
            Duration::from_secs(6),
            Duration::from_secs(7),
            &CandidateTimeouts::default(),
        );
        match action {
            WatchdogAction::Rollback { state, .. } => {
                assert_eq!(state, CandidateState::Loading);
            }
            other => panic!("Expected Rollback, got {:?}", other),
        }
    }

    #[test]
    fn total_lifetime_exceeded() {
        let action = check_candidate_timeout(
            CandidateState::HealthChecking,
            Duration::from_secs(2),
            Duration::from_secs(20),
            &CandidateTimeouts::default(),
        );
        match action {
            WatchdogAction::Discard { total_age_ms, .. } => {
                assert!(total_age_ms >= 20_000);
            }
            other => panic!("Expected Discard, got {:?}", other),
        }
    }

    #[test]
    fn terminal_state_ok() {
        let action = check_candidate_timeout(
            CandidateState::Promoted,
            Duration::from_secs(100),
            Duration::from_secs(100),
            &CandidateTimeouts::default(),
        );
        assert_eq!(action, WatchdogAction::Ok);
    }
}
