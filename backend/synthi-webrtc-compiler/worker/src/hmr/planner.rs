// ============================================================
// DETERMINISTIC RELOAD PLANNER
// ============================================================
// Pure-function planner that takes a BuildManifest + adapter
// capabilities and produces a deterministic ReloadDecision +
// PlannerReasonBundle.
//
// AI is NOT in this hot path. The planner is deterministic:
// same inputs → same outputs, every time.
// ============================================================

use crate::hmr::adapter_matrix::{AdapterFamily, AdapterMatrix, CapabilityTier};
use crate::hmr::build_manifest::{BuildManifest, HealthcheckStrategy, SnapshotMode};
use crate::hmr::planner_decision::{
    FallbackStrategy, PlannerReasonBundle, ReloadDecision, StateStrategy,
};
use crate::hmr::rollout_flags::RolloutFlags;

/// Inputs gathered at planner decision time.
pub struct PlannerInput<'a> {
    /// The freshly-produced build manifest.
    pub manifest: &'a BuildManifest,
    /// Previous manifest (if any) for diff-based decisions.
    pub prev_manifest: Option<&'a BuildManifest>,
    /// The adapter matrix for capability lookups.
    pub adapter_matrix: &'a AdapterMatrix,
    /// Rollout flags (kill switches, percentage rollouts, etc.)
    pub rollout_flags: &'a RolloutFlags,
    /// Whether the ABI version changed between old and new.
    pub abi_changed: bool,
    /// Whether the state schema hash changed.
    pub schema_changed: bool,
    /// Whether we have an active warm-reload capable runtime.
    pub runtime_supports_warm_reload: bool,
    /// Number of consecutive failures for this preview.
    pub consecutive_failures: u32,
}

/// Output of the deterministic planner.
pub struct PlannerOutput {
    pub decision: ReloadDecision,
    pub reason: PlannerReasonBundle,
}

/// Run the deterministic reload planner.
///
/// This is a pure function with no side effects: given the same
/// inputs, it always produces the same output.
pub fn plan_reload(input: &PlannerInput) -> PlannerOutput {
    // ── Kill switches ────────────────────────────────────────
    if input.rollout_flags.is_hmr_killed() {
        return PlannerOutput {
            decision: ReloadDecision::FullRestart,
            reason: PlannerReasonBundle {
                decision_reason: "Global HMR kill switch is active".into(),
                decision_code: "KILL_SWITCH_GLOBAL".into(),
                state_strategy: StateStrategy::DiscardAll,
                fallback_strategy: FallbackStrategy::FullRestart,
                user_message: Some("HMR disabled by administrator".into()),
            },
        };
    }

    let family = &input.manifest.adapter_family;
    if input.rollout_flags.is_family_killed(family) {
        return PlannerOutput {
            decision: ReloadDecision::FullRestart,
            reason: PlannerReasonBundle {
                decision_reason: format!("Kill switch active for {:?}", family),
                decision_code: "KILL_SWITCH_FAMILY".into(),
                state_strategy: StateStrategy::DiscardAll,
                fallback_strategy: FallbackStrategy::FullRestart,
                user_message: Some(format!("HMR disabled for {:?} adapter", family)),
            },
        };
    }

    // ── Forced fallback ──────────────────────────────────────
    if let Some(forced) = input.rollout_flags.forced_fallback_for(family) {
        let decision = match forced.as_str() {
            "cold_reload" => ReloadDecision::ColdReload,
            "process_swap" => ReloadDecision::ProcessSwap,
            "full_restart" => ReloadDecision::FullRestart,
            _ => ReloadDecision::ColdReload,
        };
        return PlannerOutput {
            decision,
            reason: PlannerReasonBundle {
                decision_reason: format!("Forced fallback to {} for {:?}", forced, family),
                decision_code: "FORCED_FALLBACK".into(),
                state_strategy: StateStrategy::SnapshotRestore,
                fallback_strategy: FallbackStrategy::FullRestart,
                user_message: None,
            },
        };
    }

    // ── Too many consecutive failures → full restart ─────────
    if input.consecutive_failures >= 3 {
        return PlannerOutput {
            decision: ReloadDecision::FullRestart,
            reason: PlannerReasonBundle {
                decision_reason: format!(
                    "{} consecutive failures — forcing full restart",
                    input.consecutive_failures
                ),
                decision_code: "CONSECUTIVE_FAILURES".into(),
                state_strategy: StateStrategy::DiscardAll,
                fallback_strategy: FallbackStrategy::FullRestart,
                user_message: Some("Multiple reload failures, restarting preview".into()),
            },
        };
    }

    // ── Capability check ─────────────────────────────────────
    let tier = input.manifest.capability_tier;

    // ── Warm reload path ─────────────────────────────────────
    if tier >= CapabilityTier::Tier2
        && !input.abi_changed
        && !input.schema_changed
        && input.runtime_supports_warm_reload
    {
        let state_strategy = if input.manifest.snapshot_modes.contains(&SnapshotMode::DlsymInPlace) {
            StateStrategy::PreservePointer
        } else {
            StateStrategy::SnapshotRestore
        };

        return PlannerOutput {
            decision: ReloadDecision::WarmReload,
            reason: PlannerReasonBundle {
                decision_reason: "ABI + schema stable, warm reload eligible".into(),
                decision_code: "WARM_ELIGIBLE".into(),
                state_strategy,
                fallback_strategy: FallbackStrategy::ColdReload,
                user_message: None,
            },
        };
    }

    // ── Cold reload (schema changed but ABI OK) ──────────────
    if !input.abi_changed && input.schema_changed {
        return PlannerOutput {
            decision: ReloadDecision::ColdReload,
            reason: PlannerReasonBundle {
                decision_reason: "Schema changed — cold reload with state migration".into(),
                decision_code: "SCHEMA_CHANGED".into(),
                state_strategy: StateStrategy::SnapshotRestore,
                fallback_strategy: FallbackStrategy::ProcessSwap,
                user_message: Some("State schema changed, migrating state".into()),
            },
        };
    }

    // ── Managed reload for managed runtimes ──────────────────
    if *family == AdapterFamily::ManagedRuntime {
        return PlannerOutput {
            decision: ReloadDecision::ManagedReload,
            reason: PlannerReasonBundle {
                decision_reason: "Managed runtime — using managed reload".into(),
                decision_code: "MANAGED_RUNTIME".into(),
                state_strategy: StateStrategy::SnapshotRestore,
                fallback_strategy: FallbackStrategy::FullRestart,
                user_message: None,
            },
        };
    }

    // ── ABI changed → process swap (dlopen family) ───────────
    if input.abi_changed && *family == AdapterFamily::DynamicLibrary {
        return PlannerOutput {
            decision: ReloadDecision::ProcessSwap,
            reason: PlannerReasonBundle {
                decision_reason: "ABI changed — process swap required".into(),
                decision_code: "ABI_CHANGED".into(),
                state_strategy: StateStrategy::SnapshotRestore,
                fallback_strategy: FallbackStrategy::FullRestart,
                user_message: Some("ABI changed, swapping process".into()),
            },
        };
    }

    // ── Process swap family ──────────────────────────────────
    if *family == AdapterFamily::ProcessSwap {
        return PlannerOutput {
            decision: ReloadDecision::ProcessSwap,
            reason: PlannerReasonBundle {
                decision_reason: "Process swap adapter family".into(),
                decision_code: "PROCESS_SWAP_FAMILY".into(),
                state_strategy: StateStrategy::SnapshotRestore,
                fallback_strategy: FallbackStrategy::FullRestart,
                user_message: None,
            },
        };
    }

    // ── Default: cold reload ─────────────────────────────────
    PlannerOutput {
        decision: ReloadDecision::ColdReload,
        reason: PlannerReasonBundle {
            decision_reason: "Default fallback — cold reload".into(),
            decision_code: "DEFAULT_COLD".into(),
            state_strategy: StateStrategy::SnapshotRestore,
            fallback_strategy: FallbackStrategy::FullRestart,
            user_message: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::adapter_matrix::AdapterDescriptor;
    use crate::hmr::build_manifest::BuildSlot;

    fn make_manifest(family: AdapterFamily, tier: CapabilityTier) -> BuildManifest {
        BuildManifest {
            preview_id: "test".into(),
            language: "rust".into(),
            adapter_family: family,
            capability_tier: tier,
            slot: BuildSlot::Primary,
            artifact_path: "/tmp/test.so".into(),
            artifact_hash: "abc123".into(),
            abi_version: "1.0".into(),
            state_schema_hash: Some("schema1".into()),
            snapshot_modes: vec![SnapshotMode::DlsymInPlace],
            capabilities: vec!["state_export".into()],
            exported_symbols: vec!["init".into(), "update".into()],
            dependencies: vec![],
            healthcheck_strategy: HealthcheckStrategy::SymbolProbe,
            rollout_flags: Default::default(),
            build_time_ms: 500,
            extension: Default::default(),
        }
    }

    #[test]
    fn warm_reload_when_eligible() {
        let manifest = make_manifest(AdapterFamily::DynamicLibrary, CapabilityTier::Tier2);
        let matrix = AdapterMatrix::default_matrix();
        let flags = RolloutFlags::new_defaults();

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

        let output = plan_reload(&input);
        assert!(matches!(output.decision, ReloadDecision::WarmReload));
        assert_eq!(output.reason.decision_code, "WARM_ELIGIBLE");
    }

    #[test]
    fn cold_reload_on_schema_change() {
        let manifest = make_manifest(AdapterFamily::DynamicLibrary, CapabilityTier::Tier2);
        let matrix = AdapterMatrix::default_matrix();
        let flags = RolloutFlags::new_defaults();

        let input = PlannerInput {
            manifest: &manifest,
            prev_manifest: None,
            adapter_matrix: &matrix,
            rollout_flags: &flags,
            abi_changed: false,
            schema_changed: true,
            runtime_supports_warm_reload: true,
            consecutive_failures: 0,
        };

        let output = plan_reload(&input);
        assert!(matches!(output.decision, ReloadDecision::ColdReload));
        assert_eq!(output.reason.decision_code, "SCHEMA_CHANGED");
    }

    #[test]
    fn full_restart_on_kill_switch() {
        let manifest = make_manifest(AdapterFamily::DynamicLibrary, CapabilityTier::Tier2);
        let matrix = AdapterMatrix::default_matrix();
        let flags = RolloutFlags::new_defaults();
        flags.set_global_kill(true);

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

        let output = plan_reload(&input);
        assert!(matches!(output.decision, ReloadDecision::FullRestart));
        assert_eq!(output.reason.decision_code, "KILL_SWITCH_GLOBAL");
    }

    #[test]
    fn process_swap_on_abi_change() {
        let manifest = make_manifest(AdapterFamily::DynamicLibrary, CapabilityTier::Tier2);
        let matrix = AdapterMatrix::default_matrix();
        let flags = RolloutFlags::new_defaults();

        let input = PlannerInput {
            manifest: &manifest,
            prev_manifest: None,
            adapter_matrix: &matrix,
            rollout_flags: &flags,
            abi_changed: true,
            schema_changed: false,
            runtime_supports_warm_reload: true,
            consecutive_failures: 0,
        };

        let output = plan_reload(&input);
        assert!(matches!(output.decision, ReloadDecision::ProcessSwap));
        assert_eq!(output.reason.decision_code, "ABI_CHANGED");
    }

    #[test]
    fn consecutive_failures_force_restart() {
        let manifest = make_manifest(AdapterFamily::DynamicLibrary, CapabilityTier::Tier2);
        let matrix = AdapterMatrix::default_matrix();
        let flags = RolloutFlags::new_defaults();

        let input = PlannerInput {
            manifest: &manifest,
            prev_manifest: None,
            adapter_matrix: &matrix,
            rollout_flags: &flags,
            abi_changed: false,
            schema_changed: false,
            runtime_supports_warm_reload: true,
            consecutive_failures: 3,
        };

        let output = plan_reload(&input);
        assert!(matches!(output.decision, ReloadDecision::FullRestart));
        assert_eq!(output.reason.decision_code, "CONSECUTIVE_FAILURES");
    }
}
