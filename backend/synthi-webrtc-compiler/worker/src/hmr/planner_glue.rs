// ============================================================
// PLANNER–LIFECYCLE GLUE
// ============================================================
// Connects the deterministic planner output to the lifecycle
// state machine and telemetry, producing the side-effects
// (transition, record metrics, format notification) that bridge
// a pure planner decision to the runtime.
// ============================================================

use crate::hmr::build_manifest::BuildManifest;
use crate::hmr::lifecycle_machine::LifecycleStateMachine;
use crate::hmr::planner::{plan_reload, PlannerInput, PlannerOutput};
use crate::hmr::planner_decision::ReloadDecision;
use crate::hmr::preview_lifecycle::PreviewLifecycleState;
use crate::hmr::telemetry::HmrTelemetry;

/// Notification produced when the planner makes a decision.
/// Serialized and sent to the frontend over WebRTC data channel.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PlannerNotification {
    #[serde(rename = "type")]
    pub msg_type: &'static str,
    pub status: &'static str,
    pub decision: String,
    pub decision_code: String,
    pub decision_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_message: Option<String>,
    pub preview_id: String,
}

/// Run the planner and apply results to the lifecycle + telemetry.
///
/// Returns the planner output and a serializable notification
/// to send to the frontend.
pub fn execute_planner_and_transition(
    input: &PlannerInput,
    lifecycle: &mut LifecycleStateMachine,
    telemetry: &HmrTelemetry,
) -> (PlannerOutput, PlannerNotification) {
    let output = plan_reload(input);

    // Transition lifecycle to RELOAD_PLANNED
    // (we're currently in COMPILE_FINISHED)
    let _ = lifecycle.transition(PreviewLifecycleState::ReloadPlanned);

    // Start a reload telemetry span
    let decision_str = decision_to_str(&output.decision);
    let _span = telemetry.start_reload(
        lifecycle.preview_id(),
        decision_str,
    );

    let notification = PlannerNotification {
        msg_type: "hmr-status",
        status: "reload-planned",
        decision: decision_str.to_string(),
        decision_code: output.reason.decision_code.clone(),
        decision_reason: output.reason.decision_reason.clone(),
        user_message: output.reason.user_message.clone(),
        preview_id: lifecycle.preview_id().to_string(),
    };

    (output, notification)
}

fn decision_to_str(d: &ReloadDecision) -> &'static str {
    match d {
        ReloadDecision::WarmReload => "warm_reload",
        ReloadDecision::ColdReload => "cold_reload",
        ReloadDecision::ManagedReload => "managed_reload",
        ReloadDecision::ProcessSwap => "process_swap",
        ReloadDecision::FullRestart => "full_restart",
        ReloadDecision::RejectBuild => "reject_build",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::adapter_matrix::AdapterMatrix;
    use crate::hmr::build_manifest::{BuildSlot, HealthcheckStrategy, PreviewPreservationMode, SnapshotMode};
    use crate::hmr::rollout_flags::RolloutFlags;

    fn setup() -> (
        LifecycleStateMachine,
        HmrTelemetry,
        BuildManifest,
        AdapterMatrix,
        RolloutFlags,
    ) {
        let mut sm = LifecycleStateMachine::new("test-preview");
        // Advance to CompileFinished
        sm.transition(PreviewLifecycleState::CompileRequested).unwrap();
        sm.transition(PreviewLifecycleState::Compiling).unwrap();
        sm.transition(PreviewLifecycleState::CompileFinished).unwrap();

        let telemetry = HmrTelemetry::new();

        let manifest = BuildManifest {
            preview_id: "test-preview".into(),
            language: "rust".into(),
            adapter_family: "DynamicLibrary".into(),
            capability_tier: 2,
            slot: BuildSlot::Core,
            artifact_path: "/tmp/test.so".into(),
            artifact_hash: "abc".into(),
            toolchain_fingerprint: "gcc-12".into(),
            abi_version: "1.0".into(),
            state_schema_hash: "s1".into(),
            snapshot_modes: vec![SnapshotMode::Binary],
            capabilities: vec![],
            preview_preservation_mode: PreviewPreservationMode::KeepAlive,
            dirty_unit_source: None,
            exported_symbols: vec![],
            dependencies: vec![],
            healthcheck_strategy: HealthcheckStrategy::SymbolCheck,
            rollout_flags: Default::default(),
            build_time_ms: 500,
            translation_units: None,
            dirty_units: None,
            header_fingerprint: None,
            source_map_metadata: None,
            candidate_generation: None,
            boundary_map_version: None,
            provenance_id: None,
        };

        let matrix = AdapterMatrix::default_matrix();
        let flags = RolloutFlags::new_defaults();

        (sm, telemetry, manifest, matrix, flags)
    }

    #[test]
    fn execute_transitions_to_reload_planned() {
        let (mut sm, telemetry, manifest, matrix, flags) = setup();

        let input = PlannerInput {
            manifest: &manifest,
            prev_manifest: None,
            adapter_matrix: &matrix,
            rollout_flags: &flags,
            abi_changed: false,
            schema_changed: false,
            runtime_supports_warm_reload: true,
            consecutive_failures: 0,
        };

        let (output, notification) = execute_planner_and_transition(&input, &mut sm, &telemetry);

        assert!(matches!(output.decision, ReloadDecision::WarmReload));
        assert_eq!(sm.state(), PreviewLifecycleState::ReloadPlanned);
        assert_eq!(notification.status, "reload-planned");
        assert_eq!(notification.decision, "warm_reload");
    }
}
