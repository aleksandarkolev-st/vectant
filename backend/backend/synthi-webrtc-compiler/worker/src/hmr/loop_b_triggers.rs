// ============================================================
// LOOP B TRIGGER CONDITIONS
// ============================================================
// Defines the explicit conditions under which Loop B (the
// AI-assisted path) should be triggered. Separates "when to
// use AI" from the classification logic so triggers can be
// independently tested and documented.
// ============================================================


use serde::{Deserialize, Serialize};

/// A specific condition that triggers Loop B.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum LoopBTrigger {
    /// Project has never been adapted (first compile).
    InitialAdaptation,

    /// Split is stale — original source changed since last AI split.
    StaleSplit,

    /// User explicitly requested AI-assisted compilation.
    UserRequest,

    /// Too many consecutive deterministic compile failures.
    FailureRescue { consecutive: u32, threshold: u32 },

    /// Structural change detected (new file added, file removed).
    StructuralChange,

    /// ABI break detected that deterministic path cannot handle.
    AbiBreakRescue,
}

impl LoopBTrigger {
    /// Human-readable label for telemetry.
    pub fn label(&self) -> &'static str {
        match self {
            LoopBTrigger::InitialAdaptation => "initial_adaptation",
            LoopBTrigger::StaleSplit => "stale_split",
            LoopBTrigger::UserRequest => "user_request",
            LoopBTrigger::FailureRescue { .. } => "failure_rescue",
            LoopBTrigger::StructuralChange => "structural_change",
            LoopBTrigger::AbiBreakRescue => "abi_break_rescue",
        }
    }

    /// Whether this trigger should be logged at warn level
    /// (indicates degraded deterministic path).
    pub fn is_degradation(&self) -> bool {
        matches!(
            self,
            LoopBTrigger::FailureRescue { .. }
                | LoopBTrigger::AbiBreakRescue
                | LoopBTrigger::StaleSplit
        )
    }
}

/// Evaluate all Loop B trigger conditions and return the first
/// matching trigger, if any. Returns None if Loop A should be used.
pub fn evaluate_triggers(
    is_adapted: bool,
    split_is_fresh: bool,
    user_requested_ai: bool,
    consecutive_failures: u32,
    failure_threshold: u32,
    has_structural_change: bool,
    has_abi_break: bool,
) -> Option<LoopBTrigger> {
    // Priority order: user request > failure rescue > ABI break >
    // structural change > stale split > initial adaptation

    if user_requested_ai {
        return Some(LoopBTrigger::UserRequest);
    }

    if consecutive_failures >= failure_threshold && failure_threshold > 0 {
        return Some(LoopBTrigger::FailureRescue {
            consecutive: consecutive_failures,
            threshold: failure_threshold,
        });
    }

    if has_abi_break {
        return Some(LoopBTrigger::AbiBreakRescue);
    }

    if has_structural_change {
        return Some(LoopBTrigger::StructuralChange);
    }

    if is_adapted && !split_is_fresh {
        return Some(LoopBTrigger::StaleSplit);
    }

    if !is_adapted {
        return Some(LoopBTrigger::InitialAdaptation);
    }

    None // All conditions green → Loop A
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_trigger_for_adapted_fresh() {
        let trigger = evaluate_triggers(true, true, false, 0, 3, false, false);
        assert!(trigger.is_none());
    }

    #[test]
    fn initial_adaptation() {
        let trigger = evaluate_triggers(false, false, false, 0, 3, false, false);
        assert_eq!(trigger, Some(LoopBTrigger::InitialAdaptation));
    }

    #[test]
    fn stale_split() {
        let trigger = evaluate_triggers(true, false, false, 0, 3, false, false);
        assert_eq!(trigger, Some(LoopBTrigger::StaleSplit));
    }

    #[test]
    fn user_request_wins() {
        let trigger = evaluate_triggers(true, true, true, 0, 3, false, false);
        assert_eq!(trigger, Some(LoopBTrigger::UserRequest));
    }

    #[test]
    fn failure_rescue() {
        let trigger = evaluate_triggers(true, true, false, 3, 3, false, false);
        assert_eq!(
            trigger,
            Some(LoopBTrigger::FailureRescue {
                consecutive: 3,
                threshold: 3
            })
        );
    }

    #[test]
    fn abi_break() {
        let trigger = evaluate_triggers(true, true, false, 0, 3, false, true);
        assert_eq!(trigger, Some(LoopBTrigger::AbiBreakRescue));
    }

    #[test]
    fn structural_change() {
        let trigger = evaluate_triggers(true, true, false, 0, 3, true, false);
        assert_eq!(trigger, Some(LoopBTrigger::StructuralChange));
    }

    #[test]
    fn degradation_check() {
        assert!(LoopBTrigger::FailureRescue {
            consecutive: 3,
            threshold: 3
        }
        .is_degradation());
        assert!(LoopBTrigger::AbiBreakRescue.is_degradation());
        assert!(!LoopBTrigger::UserRequest.is_degradation());
        assert!(!LoopBTrigger::InitialAdaptation.is_degradation());
    }
}
