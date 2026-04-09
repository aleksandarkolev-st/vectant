// ============================================================
// HMR ELIGIBILITY CHECKER
// ============================================================
// Replaces the hardcoded `existing_runner_can_hmr = false` in
// runner.rs with a proper eligibility function. This is the
// gate that decides whether an existing runner process can
// accept a hot-reloaded module without being killed.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::build_manifest::BuildManifest;
use crate::hmr::rollout_flags::RolloutFlags;

/// Result of the eligibility check.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HmrEligibility {
    /// Whether the runner can accept a hot reload.
    pub eligible: bool,

    /// Which adapter family would handle the reload.
    pub adapter_family: Option<AdapterFamily>,

    /// Reasons the runner is NOT eligible (empty if eligible).
    pub blockers: Vec<String>,

    /// Reasons the runner IS eligible (empty if not).
    pub enablers: Vec<String>,
}

impl HmrEligibility {
    fn blocked(reason: impl Into<String>) -> Self {
        Self {
            eligible: false,
            adapter_family: None,
            blockers: vec![reason.into()],
            enablers: vec![],
        }
    }

    fn ok(family: AdapterFamily, enablers: Vec<String>) -> Self {
        Self {
            eligible: true,
            adapter_family: Some(family),
            blockers: vec![],
            enablers,
        }
    }
}

/// Input for the eligibility check.
pub struct EligibilityInput<'a> {
    /// Is this a GUI-mode compile?
    pub is_gui: bool,

    /// Does the module export on_update()?
    pub has_on_update: bool,

    /// Is this a blocking app (e.g., ncurses, headless compute)?
    pub is_blocking_app: bool,

    /// Does an existing runner process exist?
    pub has_existing_runner: bool,

    /// Are the GUI mode and resolution the same?
    pub gui_mode_same: bool,
    pub resolution_same: bool,

    /// The new build manifest.
    pub manifest: &'a BuildManifest,

    /// Rollout flags.
    pub rollout_flags: &'a RolloutFlags,
}

/// Check whether the existing runner can accept a hot reload.
///
/// This replaces the hardcoded `false` at runner.rs:~74 with a
/// proper decision function. The decision is:
///
/// 1. No existing runner → not eligible
/// 2. Blocking app → not eligible (hard policy)
/// 3. HMR killed globally → not eligible
/// 4. HMR killed for this adapter family → not eligible
/// 5. Tier0 capability → not eligible (no hot reload support)
/// 6. GUI mode or resolution changed → not eligible
/// 7. No on_update export → not eligible for warm reload
/// 8. All checks pass → eligible
pub fn check_hmr_eligibility(input: &EligibilityInput) -> HmrEligibility {
    // 1. Must have existing runner
    if !input.has_existing_runner {
        return HmrEligibility::blocked("no existing runner process");
    }

    // 2. Blocking apps always restart
    if input.is_blocking_app {
        return HmrEligibility::blocked("blocking app requires full restart");
    }

    // 3. Global kill switch
    if input.rollout_flags.is_hmr_killed() {
        return HmrEligibility::blocked("HMR globally killed via rollout flag");
    }

    let family = input.manifest.adapter_family;
    let tier = input.manifest.capability_tier;

    // 4. Per-family kill switch
    if input.rollout_flags.is_family_killed(&family) {
        return HmrEligibility::blocked(format!(
            "HMR killed for adapter family {:?}",
            family
        ));
    }

    // 5. Tier0 = no HMR
    if tier == CapabilityTier::Tier0 {
        return HmrEligibility::blocked("Tier0 capability: no hot reload support");
    }

    // 6. GUI mode / resolution mismatch
    if input.is_gui && !input.gui_mode_same {
        return HmrEligibility::blocked("GUI mode changed — must restart");
    }
    if input.is_gui && !input.resolution_same {
        return HmrEligibility::blocked("resolution changed — must restart");
    }

    // 7. on_update required for warm reload with DynamicLibrary
    if family == AdapterFamily::DynamicLibrary && !input.has_on_update {
        return HmrEligibility::blocked(
            "no on_update export — dynamic library warm reload requires it",
        );
    }

    // 8. All checks pass
    let mut enablers = vec![
        format!("adapter_family={:?}", family),
        format!("capability_tier={:?}", tier),
    ];
    if input.has_on_update {
        enablers.push("has_on_update=true".into());
    }
    if input.is_gui {
        enablers.push("gui_mode_same=true, resolution_same=true".into());
    }

    HmrEligibility::ok(family, enablers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
    use crate::hmr::build_manifest::{BuildManifest, BuildSlot, HealthcheckStrategy};
    use crate::hmr::rollout_flags::RolloutFlags;

    fn test_manifest(family: AdapterFamily, tier: CapabilityTier) -> BuildManifest {
        BuildManifest {
            preview_id: "p1".into(),
            language: "rust".into(),
            adapter_family: family,
            capability_tier: tier,
            slot: BuildSlot::Primary,
            artifact_path: "/tmp/t.so".into(),
            artifact_hash: "h".into(),
            abi_version: "1.0".into(),
            state_schema_hash: None,
            snapshot_modes: vec![],
            capabilities: vec![],
            exported_symbols: vec![],
            dependencies: vec![],
            healthcheck_strategy: HealthcheckStrategy::SymbolProbe,
            rollout_flags: Default::default(),
            build_time_ms: 0,
            extension: Default::default(),
        }
    }

    #[test]
    fn eligible_gui_with_on_update() {
        let manifest = test_manifest(AdapterFamily::DynamicLibrary, CapabilityTier::Tier2);
        let flags = RolloutFlags::new_defaults();
        let input = EligibilityInput {
            is_gui: true,
            has_on_update: true,
            is_blocking_app: false,
            has_existing_runner: true,
            gui_mode_same: true,
            resolution_same: true,
            manifest: &manifest,
            rollout_flags: &flags,
        };
        let result = check_hmr_eligibility(&input);
        assert!(result.eligible);
    }

    #[test]
    fn blocked_no_runner() {
        let manifest = test_manifest(AdapterFamily::DynamicLibrary, CapabilityTier::Tier2);
        let flags = RolloutFlags::new_defaults();
        let input = EligibilityInput {
            is_gui: false,
            has_on_update: true,
            is_blocking_app: false,
            has_existing_runner: false,
            gui_mode_same: true,
            resolution_same: true,
            manifest: &manifest,
            rollout_flags: &flags,
        };
        assert!(!check_hmr_eligibility(&input).eligible);
    }

    #[test]
    fn blocked_blocking_app() {
        let manifest = test_manifest(AdapterFamily::DynamicLibrary, CapabilityTier::Tier2);
        let flags = RolloutFlags::new_defaults();
        let input = EligibilityInput {
            is_gui: false,
            has_on_update: true,
            is_blocking_app: true,
            has_existing_runner: true,
            gui_mode_same: true,
            resolution_same: true,
            manifest: &manifest,
            rollout_flags: &flags,
        };
        assert!(!check_hmr_eligibility(&input).eligible);
    }

    #[test]
    fn blocked_tier0() {
        let manifest = test_manifest(AdapterFamily::DynamicLibrary, CapabilityTier::Tier0);
        let flags = RolloutFlags::new_defaults();
        let input = EligibilityInput {
            is_gui: true,
            has_on_update: true,
            is_blocking_app: false,
            has_existing_runner: true,
            gui_mode_same: true,
            resolution_same: true,
            manifest: &manifest,
            rollout_flags: &flags,
        };
        assert!(!check_hmr_eligibility(&input).eligible);
    }

    #[test]
    fn blocked_resolution_change() {
        let manifest = test_manifest(AdapterFamily::DynamicLibrary, CapabilityTier::Tier2);
        let flags = RolloutFlags::new_defaults();
        let input = EligibilityInput {
            is_gui: true,
            has_on_update: true,
            is_blocking_app: false,
            has_existing_runner: true,
            gui_mode_same: true,
            resolution_same: false,
            manifest: &manifest,
            rollout_flags: &flags,
        };
        assert!(!check_hmr_eligibility(&input).eligible);
    }

    #[test]
    fn blocked_no_on_update_for_dynlib() {
        let manifest = test_manifest(AdapterFamily::DynamicLibrary, CapabilityTier::Tier2);
        let flags = RolloutFlags::new_defaults();
        let input = EligibilityInput {
            is_gui: true,
            has_on_update: false,
            is_blocking_app: false,
            has_existing_runner: true,
            gui_mode_same: true,
            resolution_same: true,
            manifest: &manifest,
            rollout_flags: &flags,
        };
        assert!(!check_hmr_eligibility(&input).eligible);
    }

    #[test]
    fn managed_runtime_allows_no_on_update() {
        let manifest = test_manifest(AdapterFamily::ManagedRuntime, CapabilityTier::Tier1);
        let flags = RolloutFlags::new_defaults();
        let input = EligibilityInput {
            is_gui: false,
            has_on_update: false,
            is_blocking_app: false,
            has_existing_runner: true,
            gui_mode_same: true,
            resolution_same: true,
            manifest: &manifest,
            rollout_flags: &flags,
        };
        assert!(check_hmr_eligibility(&input).eligible);
    }
}
