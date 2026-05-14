// ============================================================
// WAVE 06 INTEGRATION TESTS
// ============================================================
// End-to-end scenarios testing the candidate runtime pipeline:
// queue → bridge → promote/rollback → history, supersession,
// watchdog, and notification generation.
// ============================================================

#![allow(dead_code, unused_variables)]

#[cfg(all(test, feature = "legacy_hmr_tests"))]
mod tests {
    use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
    use crate::hmr::build_manifest::{BuildManifest, BuildSlot, HealthcheckStrategy};
    use crate::hmr::candidate::{CandidateState, CandidateSummary};
    use crate::hmr::candidate_bridge::{bridge_tick, BridgeAction, BridgeConfig};
    use crate::hmr::candidate_history::CandidateHistory;
    use crate::hmr::candidate_notification::CandidateNotification;
    use crate::hmr::candidate_queue::CandidateQueue;
    use crate::hmr::candidate_supersession::{should_supersede, SupersessionPolicy, SupersessionVerdict};
    use crate::hmr::candidate_watchdog::{check_candidate_timeout, CandidateTimeouts, WatchdogAction};
    use crate::hmr::health_check::HealthCheckResult;
    use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};
    use crate::hmr::promotion_policy::{evaluate_promotion, PromotionPolicy, PromotionVerdict};
    use std::time::Duration;

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

    // ── Scenario 1: Queue → activate → promote full cycle ───────

    #[test]
    fn scenario_full_promote_cycle() {
        let mut q = CandidateQueue::new("p1");
        let mut history = CandidateHistory::new();

        // Enqueue
        let gen = q.enqueue(manifest("a"), ReloadDecision::WarmReload, StateStrategy::PreservePointer);
        assert_eq!(gen, 1);
        assert_eq!(q.pending_count(), 1);

        // Activate
        let active = q.activate_next().unwrap();
        assert_eq!(active.state, CandidateState::Loading);

        // Health check
        active.begin_health_check();
        active.record_health(HealthCheckResult::Healthy { latency_ms: 30 });
        assert_eq!(active.state, CandidateState::Validated);

        // Evaluate promotion
        let verdict = evaluate_promotion(active, &PromotionPolicy::default(), 400);
        assert_eq!(verdict, PromotionVerdict::Promote);

        // Promote
        active.promote();
        assert_eq!(active.state, CandidateState::Promoted);

        // Archive
        let summary = q.complete_active().unwrap();
        history.record(summary, 1000);
        assert_eq!(history.len(), 1);
        assert_eq!(history.stats().promoted, 1);
    }

    // ── Scenario 2: Supersession during loading ─────────────────

    #[test]
    fn scenario_supersession() {
        let mut q = CandidateQueue::new("p1");
        q.enqueue(manifest("a"), ReloadDecision::WarmReload, StateStrategy::PreservePointer);
        let active = q.activate_next().unwrap();

        // New build arrives while loading
        let verdict = should_supersede(active, "b", &SupersessionPolicy::default());
        assert_eq!(verdict, SupersessionVerdict::Supersede);
    }

    // ── Scenario 3: Bridge tick with pending → begin load ───────

    #[test]
    fn scenario_bridge_pending() {
        let mut q = CandidateQueue::new("p1");
        q.enqueue(manifest("a"), ReloadDecision::WarmReload, StateStrategy::PreservePointer);

        let (action, _) = bridge_tick(&q, &BridgeConfig::default(), 0);
        assert!(matches!(action, BridgeAction::BeginLoad { .. }));
    }

    // ── Scenario 4: History stats after mixed outcomes ──────────

    #[test]
    fn scenario_history_stats() {
        let mut history = CandidateHistory::new();

        for i in 0..5 {
            let state = if i % 2 == 0 {
                CandidateState::Promoted
            } else {
                CandidateState::RolledBack
            };
            history.record(
                CandidateSummary {
                    preview_id: "p1".into(),
                    generation: i,
                    artifact_hash: format!("h{i}"),
                    state,
                    decision: "WarmReload".into(),
                    rollback_reason: if state == CandidateState::RolledBack {
                        Some("test".into())
                    } else {
                        None
                    },
                    age_ms: 200 + i * 50,
                },
                i * 1000,
            );
        }

        let stats = history.stats();
        assert_eq!(stats.total, 5);
        assert_eq!(stats.promoted, 3);
        assert_eq!(stats.rolled_back, 2);
        assert!(stats.promotion_rate > 0.5);
    }

    // ── Scenario 5: Notification serialization round-trip ───────

    #[test]
    fn scenario_notification_roundtrip() {
        let notif = CandidateNotification::Promoted {
            preview_id: "p1".into(),
            generation: 10,
            total_reload_ms: 350,
        };
        let json = notif.to_json();
        let parsed: CandidateNotification = serde_json::from_str(&json).unwrap();
        match parsed {
            CandidateNotification::Promoted {
                generation,
                total_reload_ms,
                ..
            } => {
                assert_eq!(generation, 10);
                assert_eq!(total_reload_ms, 350);
            }
            _ => panic!("Wrong variant"),
        }
    }
}
