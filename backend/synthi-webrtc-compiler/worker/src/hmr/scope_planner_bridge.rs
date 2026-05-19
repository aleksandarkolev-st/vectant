// ============================================================
// SCOPE-TO-PLANNER BRIDGE
// ============================================================
// Converts a ScopeResult (rebuild scope) into a planner input
// that the deterministic planner can use to decide the reload
// strategy.  This bridges the dirty-unit detection (Wave 07)
// to the planner contract (Wave 03).
// ============================================================

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};
use crate::hmr::rebuild_scope::{RebuildScope, ScopeResult};

/// Input context for the scope-to-planner bridge.
#[derive(Debug, Clone)]
pub struct ScopePlannerInput {
    /// The rebuild scope result.
    pub scope: ScopeResult,
    /// Current adapter family.
    pub adapter_family: AdapterFamily,
    /// Current capability tier.
    pub capability_tier: CapabilityTier,
    /// Whether the build manifest has snapshot support.
    pub has_snapshot: bool,
    /// Whether ABI changed.
    pub abi_changed: bool,
}

/// Output: the reload decision and state strategy.
#[derive(Debug, Clone)]
pub struct ScopePlannerOutput {
    pub decision: ReloadDecision,
    pub state_strategy: StateStrategy,
    pub reason: String,
}

/// Maps a rebuild scope + context into a planner-compatible decision.
pub fn scope_to_planner(input: &ScopePlannerInput) -> ScopePlannerOutput {
    match input.scope.scope {
        RebuildScope::None => ScopePlannerOutput {
            decision: ReloadDecision::RejectBuild,
            state_strategy: StateStrategy::Reset,
            reason: "no rebuild needed".into(),
        },

        RebuildScope::GuiOnly => {
            // GUI-only change: warm reload if snapshot available
            if input.abi_changed {
                ScopePlannerOutput {
                    decision: ReloadDecision::ColdReload,
                    state_strategy: StateStrategy::Migrate,
                    reason: "GUI change with ABI break → cold reload".into(),
                }
            } else if input.has_snapshot {
                ScopePlannerOutput {
                    decision: ReloadDecision::WarmReload,
                    state_strategy: StateStrategy::Preserve,
                    reason: "GUI-only change, no ABI break → warm reload".into(),
                }
            } else {
                ScopePlannerOutput {
                    decision: ReloadDecision::ColdReload,
                    state_strategy: StateStrategy::Reset,
                    reason: "GUI-only but no snapshot → cold reload".into(),
                }
            }
        }

        RebuildScope::CoreOnly => {
            // Core change: cold reload minimum, snapshot for state preservation
            if input.has_snapshot && !input.abi_changed {
                ScopePlannerOutput {
                    decision: ReloadDecision::ColdReload,
                    state_strategy: StateStrategy::Migrate,
                    reason: "core change, snapshot available → cold reload with restore".into(),
                }
            } else {
                ScopePlannerOutput {
                    decision: ReloadDecision::ManagedReload,
                    state_strategy: StateStrategy::Reset,
                    reason: "core change, no snapshot → managed reload".into(),
                }
            }
        }

        RebuildScope::Both => {
            // Both changed: managed reload minimum
            if input.abi_changed {
                ScopePlannerOutput {
                    decision: ReloadDecision::ProcessSwap,
                    state_strategy: StateStrategy::Migrate,
                    reason: "both changed + ABI break → process swap".into(),
                }
            } else {
                ScopePlannerOutput {
                    decision: ReloadDecision::ColdReload,
                    state_strategy: StateStrategy::Migrate,
                    reason: "both changed, no ABI break → cold reload".into(),
                }
            }
        }

        RebuildScope::FullReload => ScopePlannerOutput {
            decision: ReloadDecision::FullRestart,
            state_strategy: StateStrategy::Reset,
            reason: "full reload required (config/build change)".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn scope_result(scope: RebuildScope) -> ScopeResult {
        ScopeResult {
            scope,
            affected_modules: HashSet::new(),
            has_shared_change: false,
            has_config_change: false,
            dirty_core: vec![],
            dirty_gui: vec![],
        }
    }

    #[test]
    fn gui_only_warm() {
        let input = ScopePlannerInput {
            scope: scope_result(RebuildScope::GuiOnly),
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            has_snapshot: true,
            abi_changed: false,
        };
        let output = scope_to_planner(&input);
        assert_eq!(output.decision, ReloadDecision::WarmReload);
    }

    #[test]
    fn core_change_cold() {
        let input = ScopePlannerInput {
            scope: scope_result(RebuildScope::CoreOnly),
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            has_snapshot: true,
            abi_changed: false,
        };
        let output = scope_to_planner(&input);
        assert_eq!(output.decision, ReloadDecision::ColdReload);
    }

    #[test]
    fn full_reload_restart() {
        let input = ScopePlannerInput {
            scope: scope_result(RebuildScope::FullReload),
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            has_snapshot: true,
            abi_changed: false,
        };
        let output = scope_to_planner(&input);
        assert_eq!(output.decision, ReloadDecision::FullRestart);
    }

    #[test]
    fn none_rejects() {
        let input = ScopePlannerInput {
            scope: scope_result(RebuildScope::None),
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            has_snapshot: false,
            abi_changed: false,
        };
        let output = scope_to_planner(&input);
        assert_eq!(output.decision, ReloadDecision::RejectBuild);
    }
}
