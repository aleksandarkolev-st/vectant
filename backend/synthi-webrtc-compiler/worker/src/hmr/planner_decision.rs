// ============================================================
// RELOAD PLANNER DECISION SCHEMA
// ============================================================
// Defines the outputs of the deterministic reload planner.
// Every reload decision must be explainable from manifest +
// runtime state — no scattered heuristics.
// ============================================================

use serde::{Deserialize, Serialize};

/// Reload decision the planner can make.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReloadDecision {
    /// In-process artifact swap. State preserved. Fastest path.
    WarmReload,
    /// Same runtime family, but state schema changed.
    /// Migration exists or state will be partially reset.
    ColdReload,
    /// Managed runtime (JVM, .NET) slot reload.
    ManagedReload,
    /// New candidate process started; old process exports state via IPC.
    ProcessSwap,
    /// Full restart within the same preview session (last resort before browser reload).
    FullRestart,
    /// Build rejected — candidate is invalid and must not be loaded.
    RejectBuild,
}

impl ReloadDecision {
    /// Returns true if this decision keeps the current process alive.
    pub fn is_in_process(&self) -> bool {
        matches!(
            self,
            Self::WarmReload | Self::ColdReload | Self::ManagedReload
        )
    }

    /// Returns true if the decision preserves the preview session (no browser reload).
    pub fn preserves_session(&self) -> bool {
        !matches!(self, Self::RejectBuild)
    }
}

/// Strategy for handling runtime state across the reload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateStrategy {
    /// State can be carried forward unchanged.
    Preserve,
    /// State needs schema-aware migration.
    Migrate,
    /// State is intentionally discarded.
    Reset,
    /// State is derived and will be recomputed.
    Reconstruct,
    /// State is stored externally and merely re-attached.
    External,
}

/// What to do if the primary reload decision fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FallbackStrategy {
    /// Try cold reload next.
    ColdReload,
    /// Try process swap.
    ProcessSwap,
    /// Fall back to full restart.
    FullRestart,
    /// Keep the current (old) preview — do nothing.
    KeepCurrent,
    /// No fallback — reject.
    None,
}

/// Structured reason bundle emitted with every planner decision.
///
/// The frontend and logging systems consume this to explain
/// *why* a particular reload type was chosen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannerReasonBundle {
    /// The reload decision.
    pub decision: ReloadDecision,
    /// Human-readable explanation.
    pub decision_reason: String,
    /// Machine-readable reason code (e.g. "abi_incompatible").
    pub decision_code: String,
    /// How state will be handled.
    pub state_strategy: StateStrategy,
    /// What to do if the primary decision fails.
    pub fallback_strategy: FallbackStrategy,
    /// Message suitable for display to the user.
    pub user_message: String,
}

impl PlannerReasonBundle {
    pub fn new(decision: ReloadDecision) -> Self {
        let (reason, code, user_msg) = match decision {
            ReloadDecision::WarmReload => (
                "ABI compatible, schema unchanged, candidate healthy".into(),
                "warm_eligible".into(),
                "Applying warm reload...".into(),
            ),
            ReloadDecision::ColdReload => (
                "State schema changed or migration required".into(),
                "schema_changed".into(),
                "Cold reload — state will be migrated or reset.".into(),
            ),
            ReloadDecision::ManagedReload => (
                "Managed runtime slot reload".into(),
                "managed_slot".into(),
                "Managed runtime reloading...".into(),
            ),
            ReloadDecision::ProcessSwap => (
                "In-process swap unsafe; using process swap with state handoff".into(),
                "process_swap".into(),
                "Swapping to new process...".into(),
            ),
            ReloadDecision::FullRestart => (
                "No safe incremental path available".into(),
                "full_restart".into(),
                "Full restart required.".into(),
            ),
            ReloadDecision::RejectBuild => (
                "Candidate artifact is invalid".into(),
                "reject_build".into(),
                "Build rejected — candidate failed validation.".into(),
            ),
        };

        Self {
            decision,
            decision_reason: reason,
            decision_code: code,
            state_strategy: StateStrategy::Reset,
            fallback_strategy: FallbackStrategy::KeepCurrent,
            user_message: user_msg,
        }
    }

    pub fn with_state_strategy(mut self, s: StateStrategy) -> Self {
        self.state_strategy = s;
        self
    }

    pub fn with_fallback(mut self, f: FallbackStrategy) -> Self {
        self.fallback_strategy = f;
        self
    }

    pub fn with_reason(mut self, reason: impl Into<String>, code: impl Into<String>) -> Self {
        self.decision_reason = reason.into();
        self.decision_code = code.into();
        self
    }

    pub fn with_user_message(mut self, msg: impl Into<String>) -> Self {
        self.user_message = msg.into();
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_predicates() {
        assert!(ReloadDecision::WarmReload.is_in_process());
        assert!(ReloadDecision::ColdReload.is_in_process());
        assert!(!ReloadDecision::ProcessSwap.is_in_process());
        assert!(ReloadDecision::FullRestart.preserves_session());
        assert!(!ReloadDecision::RejectBuild.preserves_session());
    }

    #[test]
    fn reason_bundle_serde() {
        let bundle = PlannerReasonBundle::new(ReloadDecision::WarmReload)
            .with_state_strategy(StateStrategy::Preserve)
            .with_fallback(FallbackStrategy::ColdReload);

        let json = serde_json::to_string(&bundle).unwrap();
        let de: PlannerReasonBundle = serde_json::from_str(&json).unwrap();
        assert_eq!(de.decision, ReloadDecision::WarmReload);
        assert_eq!(de.state_strategy, StateStrategy::Preserve);
        assert_eq!(de.fallback_strategy, FallbackStrategy::ColdReload);
    }
}
