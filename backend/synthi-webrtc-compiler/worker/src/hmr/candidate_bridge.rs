// ============================================================
// CANDIDATE RUNTIME BRIDGE
// ============================================================
// Ties the candidate queue to the runtime: drives the activate →
// load → health-check → promote/rollback cycle.  This is the
// main "tick" function that the compiler handler calls after
// each build completes.
// ============================================================

use serde::{Deserialize, Serialize};

use crate::hmr::candidate::CandidateState;
use crate::hmr::candidate_notification::CandidateNotification;
use crate::hmr::candidate_queue::CandidateQueue;
use crate::hmr::candidate_supersession::SupersessionPolicy;
use crate::hmr::candidate_watchdog::{check_candidate_timeout, CandidateTimeouts, WatchdogAction};
use crate::hmr::promotion_policy::{evaluate_promotion, PromotionPolicy, PromotionVerdict};

/// Actions the bridge wants the caller to perform.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BridgeAction {
    /// Nothing to do right now.
    Idle,
    /// Begin loading the given candidate (swap library).
    BeginLoad { generation: u64 },
    /// Begin health check for the active candidate.
    BeginHealthCheck { generation: u64 },
    /// Promote the active candidate to live.
    Promote { generation: u64 },
    /// Rollback the active candidate.
    Rollback { generation: u64, reason: String },
    /// Discard the active candidate (stale/superseded).
    Discard { generation: u64, reason: String },
}

/// Configuration for the bridge.
#[derive(Debug, Clone)]
pub struct BridgeConfig {
    pub promotion_policy: PromotionPolicy,
    pub supersession_policy: SupersessionPolicy,
    pub timeouts: CandidateTimeouts,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            promotion_policy: PromotionPolicy::default(),
            supersession_policy: SupersessionPolicy::default(),
            timeouts: CandidateTimeouts::default(),
        }
    }
}

/// Run one bridge tick: inspect active candidate and determine next action.
///
/// This is a pure function — it reads the queue/candidate state and returns
/// an action.  The caller performs the actual side effects and updates state.
pub fn bridge_tick(
    queue: &CandidateQueue,
    config: &BridgeConfig,
    _current_time_ms: u64,
) -> (BridgeAction, Vec<CandidateNotification>) {
    let mut notifications = Vec::new();

    let active = match queue.active() {
        Some(c) => c,
        None => {
            // No active candidate — try to activate next
            if queue.pending_count() > 0 {
                return (
                    BridgeAction::BeginLoad {
                        generation: 0, // caller will activate_next()
                    },
                    notifications,
                );
            }
            return (BridgeAction::Idle, notifications);
        }
    };

    // Check watchdog
    let state_duration = active.age(); // simplification: whole age as state duration
    let total_age = active.age();
    let watchdog =
        check_candidate_timeout(active.state, state_duration, total_age, &config.timeouts);

    match watchdog {
        WatchdogAction::Rollback { state, .. } => {
            let reason = format!("timeout in {:?} state", state);
            notifications.push(CandidateNotification::RolledBack {
                preview_id: active.id.preview_id.clone(),
                generation: active.id.generation,
                reason: reason.clone(),
            });
            return (
                BridgeAction::Rollback {
                    generation: active.id.generation,
                    reason,
                },
                notifications,
            );
        }
        WatchdogAction::Discard { .. } => {
            let reason = "total lifetime exceeded".to_string();
            notifications.push(CandidateNotification::Discarded {
                preview_id: active.id.preview_id.clone(),
                generation: active.id.generation,
                reason: reason.clone(),
            });
            return (
                BridgeAction::Discard {
                    generation: active.id.generation,
                    reason,
                },
                notifications,
            );
        }
        WatchdogAction::Ok => {}
    }

    // State-specific actions
    match active.state {
        CandidateState::Loading => {
            // Still loading — caller continues
            (BridgeAction::Idle, notifications)
        }
        CandidateState::HealthChecking => {
            // Still health checking — caller continues
            (BridgeAction::Idle, notifications)
        }
        CandidateState::Validated => {
            // Check promotion policy
            let verdict = evaluate_promotion(
                active,
                &config.promotion_policy,
                active.age().as_millis() as u64,
            );
            notifications.push(CandidateNotification::PromotionDecision {
                preview_id: active.id.preview_id.clone(),
                generation: active.id.generation,
                verdict: verdict.clone(),
            });
            match verdict {
                PromotionVerdict::Promote => (
                    BridgeAction::Promote {
                        generation: active.id.generation,
                    },
                    notifications,
                ),
                PromotionVerdict::Defer { reason } => (BridgeAction::Idle, notifications),
                PromotionVerdict::Reject { reason } => (
                    BridgeAction::Rollback {
                        generation: active.id.generation,
                        reason,
                    },
                    notifications,
                ),
            }
        }
        CandidateState::Built => {
            // Shouldn't be active in Built state, but handle gracefully
            (
                BridgeAction::BeginLoad {
                    generation: active.id.generation,
                },
                notifications,
            )
        }
        _ => (BridgeAction::Idle, notifications),
    }
}

#[cfg(all(test, feature = "legacy_hmr_tests"))]
mod tests {
    use super::*;
    use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
    use crate::hmr::build_manifest::{BuildManifest, BuildSlot, HealthcheckStrategy};
    use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};

    fn manifest(hash: &str) -> BuildManifest {
        BuildManifest {
            preview_id: "p1".into(),
            language: "rust".into(),
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            slot: BuildSlot::Primary,
            artifact_path: "/tmp/test.so".into(),
            artifact_hash: hash.into(),
            abi_version: "1.0".into(),
            state_schema_hash: None,
            snapshot_modes: vec![],
            capabilities: vec![],
            exported_symbols: vec![],
            dependencies: vec![],
            healthcheck_strategy: HealthcheckStrategy::SymbolProbe,
            rollout_flags: Default::default(),
            build_time_ms: 100,
            extension: Default::default(),
        }
    }

    #[test]
    fn idle_on_empty() {
        let q = CandidateQueue::new("p1");
        let (action, _) = bridge_tick(&q, &BridgeConfig::default(), 0);
        assert!(matches!(action, BridgeAction::Idle));
    }

    #[test]
    fn begin_load_on_pending() {
        let mut q = CandidateQueue::new("p1");
        q.enqueue(
            manifest("a"),
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        );
        let (action, _) = bridge_tick(&q, &BridgeConfig::default(), 0);
        assert!(matches!(action, BridgeAction::BeginLoad { .. }));
    }
}
