// ============================================================
// LOOP CLASSIFIER
// ============================================================
// Classifies whether a compile request should take the
// deterministic Loop A (AI-free) or the AI-assisted Loop B
// path. This is the central routing decision for the two-loop
// architecture described in the HMR recovery plan.
// ============================================================


use serde::{Deserialize, Serialize};

use crate::hmr::adapted_project::AdaptedProjectStatus;
use crate::hmr::rollout_flags::RolloutFlags;

/// Which compile loop to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompileLoop {
    /// Loop A: deterministic, AI-free. Used for adapted projects
    /// where core/gui split already exists and is fresh.
    LoopA,

    /// Loop B: AI-assisted. Used for initial adaptation, stale
    /// splits, or rescue after consecutive failures.
    LoopB,
}

/// Reason the classifier chose a particular loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LoopReason {
    /// Project is already adapted and split is fresh.
    AdaptedProjectFresh,

    /// Project is adapted but split is stale (source changed).
    AdaptedProjectStale,

    /// Project has not been adapted yet.
    NotAdapted,

    /// Forced to Loop B by consecutive failure count.
    RescueAfterFailures { count: u32 },

    /// Forced to Loop A by kill switch (AI disabled).
    AiKilled,

    /// Forced to Loop B by explicit user request.
    UserRequestedAi,

    /// Forced to Loop A by explicit user request.
    UserRequestedDeterministic,
}

/// Input for the loop classifier.
pub struct LoopClassifierInput<'a> {
    /// Adapted project detection result.
    pub adapted_status: &'a AdaptedProjectStatus,

    /// Current source hash for freshness check.
    pub current_source_hash: Option<&'a str>,

    /// Rollout flags (may kill AI globally).
    pub rollout_flags: &'a RolloutFlags,

    /// Number of consecutive compile failures.
    pub consecutive_failures: u32,

    /// Threshold of failures before triggering Loop B rescue.
    pub failure_rescue_threshold: u32,

    /// Whether the user explicitly requested AI split.
    pub user_requested_ai: bool,

    /// Whether the user explicitly requested deterministic mode.
    pub user_requested_deterministic: bool,
}

/// Output of the loop classifier.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopClassification {
    pub loop_type: CompileLoop,
    pub reason: LoopReason,
}

/// Classify which compile loop to use.
///
/// Decision chain (first match wins):
/// 1. User forced deterministic → Loop A
/// 2. AI globally killed → Loop A
/// 3. User forced AI → Loop B
/// 4. Consecutive failures above threshold → Loop B (rescue)
/// 5. Not adapted → Loop B (initial adaptation)
/// 6. Adapted but stale → Loop B (re-adaptation)
/// 7. Adapted and fresh → Loop A
pub fn classify_loop(input: &LoopClassifierInput) -> LoopClassification {
    // 1. User override: deterministic
    if input.user_requested_deterministic {
        return LoopClassification {
            loop_type: CompileLoop::LoopA,
            reason: LoopReason::UserRequestedDeterministic,
        };
    }

    // 2. Global AI kill switch
    if input.rollout_flags.is_hmr_killed() {
        return LoopClassification {
            loop_type: CompileLoop::LoopA,
            reason: LoopReason::AiKilled,
        };
    }

    // 3. User override: AI
    if input.user_requested_ai {
        return LoopClassification {
            loop_type: CompileLoop::LoopB,
            reason: LoopReason::UserRequestedAi,
        };
    }

    // 4. Failure rescue
    if input.consecutive_failures >= input.failure_rescue_threshold
        && input.failure_rescue_threshold > 0
    {
        return LoopClassification {
            loop_type: CompileLoop::LoopB,
            reason: LoopReason::RescueAfterFailures {
                count: input.consecutive_failures,
            },
        };
    }

    // 5-7. Adaptation status
    // For non-adapted projects (single-file programs), use Loop A with
    // deterministic wrapping.  The FallbackDeterministic path in handler.rs
    // wraps the source as a single core module without calling AI, which
    // is equivalent to a direct recompile.  Loop B (AI split) is only
    // needed when the user explicitly requests it or during failure rescue.
    if !input.adapted_status.is_adapted {
        return LoopClassification {
            loop_type: CompileLoop::LoopA,
            reason: LoopReason::NotAdapted,
        };
    }

    // Adapted; check freshness
    let is_fresh = match (
        &input.adapted_status.split_hash,
        input.current_source_hash,
    ) {
        (Some(split_hash), Some(source_hash)) => split_hash == source_hash,
        _ => true, // No hash info → assume fresh
    };

    if is_fresh {
        LoopClassification {
            loop_type: CompileLoop::LoopA,
            reason: LoopReason::AdaptedProjectFresh,
        }
    } else {
        LoopClassification {
            loop_type: CompileLoop::LoopB,
            reason: LoopReason::AdaptedProjectStale,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::adapted_project::AdaptedProjectStatus;
    use crate::hmr::rollout_flags::RolloutFlags;
    use std::path::PathBuf;

    fn adapted_fresh() -> AdaptedProjectStatus {
        AdaptedProjectStatus::adapted(
            PathBuf::from("core.cpp"),
            PathBuf::from("gui.cpp"),
            None,
        )
        .with_split_hash("hash1".into())
    }

    fn flags() -> RolloutFlags {
        RolloutFlags::new_defaults()
    }

    #[test]
    fn loop_a_for_adapted_fresh() {
        let status = adapted_fresh();
        let f = flags();
        let input = LoopClassifierInput {
            adapted_status: &status,
            current_source_hash: Some("hash1"),
            rollout_flags: &f,
            consecutive_failures: 0,
            failure_rescue_threshold: 3,
            user_requested_ai: false,
            user_requested_deterministic: false,
        };
        let result = classify_loop(&input);
        assert_eq!(result.loop_type, CompileLoop::LoopA);
    }

    #[test]
    fn loop_b_for_not_adapted() {
        let status = AdaptedProjectStatus::not_adapted("no files");
        let f = flags();
        let input = LoopClassifierInput {
            adapted_status: &status,
            current_source_hash: None,
            rollout_flags: &f,
            consecutive_failures: 0,
            failure_rescue_threshold: 3,
            user_requested_ai: false,
            user_requested_deterministic: false,
        };
        let result = classify_loop(&input);
        assert_eq!(result.loop_type, CompileLoop::LoopB);
    }

    #[test]
    fn loop_b_rescue_on_failures() {
        let status = adapted_fresh();
        let f = flags();
        let input = LoopClassifierInput {
            adapted_status: &status,
            current_source_hash: Some("hash1"),
            rollout_flags: &f,
            consecutive_failures: 3,
            failure_rescue_threshold: 3,
            user_requested_ai: false,
            user_requested_deterministic: false,
        };
        let result = classify_loop(&input);
        assert_eq!(result.loop_type, CompileLoop::LoopB);
    }

    #[test]
    fn ai_killed_forces_loop_a() {
        let status = AdaptedProjectStatus::not_adapted("no files");
        let f = flags();
        f.set_global_kill(true);
        let input = LoopClassifierInput {
            adapted_status: &status,
            current_source_hash: None,
            rollout_flags: &f,
            consecutive_failures: 0,
            failure_rescue_threshold: 3,
            user_requested_ai: false,
            user_requested_deterministic: false,
        };
        let result = classify_loop(&input);
        assert_eq!(result.loop_type, CompileLoop::LoopA);
    }

    #[test]
    fn user_override_deterministic() {
        let status = AdaptedProjectStatus::not_adapted("no files");
        let f = flags();
        let input = LoopClassifierInput {
            adapted_status: &status,
            current_source_hash: None,
            rollout_flags: &f,
            consecutive_failures: 0,
            failure_rescue_threshold: 3,
            user_requested_ai: false,
            user_requested_deterministic: true,
        };
        let result = classify_loop(&input);
        assert_eq!(result.loop_type, CompileLoop::LoopA);
    }
}
