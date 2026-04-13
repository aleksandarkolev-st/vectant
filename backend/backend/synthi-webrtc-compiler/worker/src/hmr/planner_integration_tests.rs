// ============================================================
// WAVE 03 INTEGRATION SCENARIOS
// ============================================================
// End-to-end test stubs verifying the planner contract, lifecycle
// machine, candidate protocol, and ABI detection work together.
// ============================================================

#[cfg(test)]
mod tests {
    use crate::hmr::abi_detect::detect_abi_changes;
    use crate::hmr::adapter_matrix::{AdapterFamily, AdapterMatrix, CapabilityTier};
    use crate::hmr::build_manifest::{BuildManifest, BuildSlot, HealthcheckStrategy, SnapshotMode};
    use crate::hmr::candidate::Candidate;
    use crate::hmr::health_check::HealthCheckResult;
    use crate::hmr::lifecycle_machine::LifecycleStateMachine;
    use crate::hmr::planner::{plan_reload, PlannerInput};
    use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};
    use crate::hmr::planner_glue::execute_planner_and_transition;
    use crate::hmr::preview_lifecycle::PreviewLifecycleState;
    use crate::hmr::rollback_notification::RollbackNotification;
    use crate::hmr::rollout_flags::RolloutFlags;
    use crate::hmr::telemetry::HmrTelemetry;

    fn manifest(abi: &str, schema: &str) -> BuildManifest {
        BuildManifest {
            preview_id: "p1".into(),
            language: "rust".into(),
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            slot: BuildSlot::Primary,
            artifact_path: "/tmp/t.so".into(),
            artifact_hash: "h1".into(),
            abi_version: abi.into(),
            state_schema_hash: Some(schema.into()),
            snapshot_modes: vec![SnapshotMode::DlsymInPlace],
            capabilities: vec![],
            exported_symbols: vec!["init".into(), "update".into()],
            dependencies: vec![],
            healthcheck_strategy: HealthcheckStrategy::SymbolProbe,
            rollout_flags: Default::default(),
            build_time_ms: 500,
            extension: Default::default(),
        }
    }

    /// Scenario: warm reload happy path
    #[test]
    fn scenario_warm_reload_e2e() {
        let prev = manifest("1.0", "s1");
        let curr = manifest("1.0", "s1");
        let matrix = AdapterMatrix::default_matrix();
        let flags = RolloutFlags::new_defaults();
        let telemetry = HmrTelemetry::new();

        // 1. Detect ABI changes
        let abi = detect_abi_changes(Some(&prev), &curr);
        assert!(!abi.abi_changed);
        assert!(!abi.schema_changed);

        // 2. Setup lifecycle
        let mut sm = LifecycleStateMachine::new("p1");
        sm.transition(PreviewLifecycleState::CompileRequested).unwrap();
        sm.transition(PreviewLifecycleState::Compiling).unwrap();
        sm.transition(PreviewLifecycleState::CompileFinished).unwrap();

        // 3. Run planner via glue
        let input = PlannerInput {
            manifest: &curr,
            prev_manifest: Some(&prev),
            adapter_matrix: &matrix,
            rollout_flags: &flags,
            abi_changed: abi.abi_changed,
            schema_changed: abi.schema_changed,
            runtime_supports_warm_reload: true,
            consecutive_failures: 0,
        };
        let (output, notification) = execute_planner_and_transition(&input, &mut sm, &telemetry);
        assert!(matches!(output.decision, ReloadDecision::WarmReload));
        assert_eq!(sm.state(), PreviewLifecycleState::ReloadPlanned);

        // 4. Candidate lifecycle
        let mut candidate = Candidate::new(
            curr,
            1,
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        );
        candidate.begin_load();
        candidate.begin_health_check();
        candidate.record_health(HealthCheckResult::Healthy { latency_ms: 10 });
        candidate.promote();

        // 5. Complete lifecycle
        sm.transition(PreviewLifecycleState::ReloadApplying).unwrap();
        sm.transition(PreviewLifecycleState::ReloadApplied).unwrap();
        sm.transition(PreviewLifecycleState::Idle).unwrap();
    }

    /// Scenario: ABI break causes process swap with rollback
    #[test]
    fn scenario_abi_break_rollback() {
        let prev = manifest("1.0", "s1");
        let curr = manifest("2.0", "s1");
        let matrix = AdapterMatrix::default_matrix();
        let flags = RolloutFlags::new_defaults();

        let abi = detect_abi_changes(Some(&prev), &curr);
        assert!(abi.abi_changed);

        let input = PlannerInput {
            manifest: &curr,
            prev_manifest: Some(&prev),
            adapter_matrix: &matrix,
            rollout_flags: &flags,
            abi_changed: abi.abi_changed,
            schema_changed: abi.schema_changed,
            runtime_supports_warm_reload: true,
            consecutive_failures: 0,
        };
        let output = plan_reload(&input);
        assert!(matches!(output.decision, ReloadDecision::ProcessSwap));

        // Candidate fails health check
        let mut candidate = Candidate::new(
            curr,
            1,
            ReloadDecision::ProcessSwap,
            StateStrategy::SnapshotRestore,
        );
        candidate.begin_load();
        candidate.begin_health_check();
        candidate.record_health(HealthCheckResult::Unhealthy {
            reason: "segfault in init".into(),
            latency_ms: 5,
        });

        let notif = RollbackNotification::from_candidate(&candidate).unwrap();
        assert_eq!(notif.reason_code, "candidate_crash");
    }
}
