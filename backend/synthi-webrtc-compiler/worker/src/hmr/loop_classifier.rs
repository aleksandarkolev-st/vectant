// ============================================================
// LOOP CLASSIFIER
// ============================================================
// Classifies whether a compile request should take the
// deterministic Loop A (AI-free) or the AI-assisted Loop B
// path. This is the central routing decision for the two-loop
// architecture described in the HMR recovery plan.
// ============================================================

use serde::{Deserialize, Serialize};
use std::fmt;

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

    /// Forced to Loop B by a caller that requires an observed provider call.
    RequiredAiProviderCall,

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

    /// Whether the caller requires a fresh, observed AI provider call.
    pub require_ai_provider_call: bool,

    /// Whether the user explicitly requested deterministic mode.
    pub user_requested_deterministic: bool,
}

/// Output of the loop classifier.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopClassification {
    pub loop_type: CompileLoop,
    pub reason: LoopReason,
}

/// A strict provider request cannot be silently downgraded to another loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LoopRoutingError {
    RequiredProviderCallConflictsWithDeterministicMode,
    RequiredProviderCallDisabledByPolicy,
}

impl fmt::Display for LoopRoutingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RequiredProviderCallConflictsWithDeterministicMode => write!(
                f,
                "required_ai_provider_call_conflicts_with_deterministic_mode: a required provider call cannot use deterministic routing"
            ),
            Self::RequiredProviderCallDisabledByPolicy => write!(
                f,
                "required_ai_provider_call_disabled_by_policy: AI provider execution is disabled by rollout policy"
            ),
        }
    }
}

impl std::error::Error for LoopRoutingError {}

/// Classify which compile loop to use.
///
/// Decision chain (first match wins):
/// 1. Required provider call fails closed or forces Loop B
/// 2. User forced deterministic → Loop A
/// 3. AI globally killed → Loop A
/// 4. User forced AI → Loop B
/// 5. Consecutive failures above threshold → Loop B (rescue)
/// 6. Not adapted → Loop B (initial adaptation)
/// 7. Adapted and fresh → Loop A
pub fn classify_loop(input: &LoopClassifierInput) -> Result<LoopClassification, LoopRoutingError> {
    if input.require_ai_provider_call {
        if input.user_requested_deterministic {
            return Err(LoopRoutingError::RequiredProviderCallConflictsWithDeterministicMode);
        }
        if input.rollout_flags.is_ai_split_disabled() {
            return Err(LoopRoutingError::RequiredProviderCallDisabledByPolicy);
        }
        return Ok(LoopClassification {
            loop_type: CompileLoop::LoopB,
            reason: LoopReason::RequiredAiProviderCall,
        });
    }

    // 2. User override: deterministic
    if input.user_requested_deterministic {
        return Ok(LoopClassification {
            loop_type: CompileLoop::LoopA,
            reason: LoopReason::UserRequestedDeterministic,
        });
    }

    // 3. Global AI kill switch
    if input.rollout_flags.is_hmr_killed() {
        return Ok(LoopClassification {
            loop_type: CompileLoop::LoopA,
            reason: LoopReason::AiKilled,
        });
    }

    // 4. User override: AI
    if input.user_requested_ai {
        return Ok(LoopClassification {
            loop_type: CompileLoop::LoopB,
            reason: LoopReason::UserRequestedAi,
        });
    }

    // 5. Failure rescue
    if input.consecutive_failures >= input.failure_rescue_threshold
        && input.failure_rescue_threshold > 0
    {
        return Ok(LoopClassification {
            loop_type: CompileLoop::LoopB,
            reason: LoopReason::RescueAfterFailures {
                count: input.consecutive_failures,
            },
        });
    }

    // 6. Not adapted → Loop B (first compile needs AI split to create modules)
    if !input.adapted_status.is_adapted {
        return Ok(LoopClassification {
            loop_type: CompileLoop::LoopB,
            reason: LoopReason::NotAdapted,
        });
    }

    // 7. Adapted → always Loop A.
    // Once the AI has split the project into core/gui modules, subsequent
    // edits use the deterministic path which reads the adapted files from
    // disk and uses hash-based scope detection to recompile only what
    // changed (CoreOnly/GuiOnly/Both/None).  The split is NOT re-run on
    // every edit — that would defeat HMR entirely.  AI re-split only
    // happens via explicit user request (step 4) or failure rescue (step 5).
    Ok(LoopClassification {
        loop_type: CompileLoop::LoopA,
        reason: LoopReason::AdaptedProjectFresh,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::adapted_project::AdaptedProjectStatus;
    use crate::hmr::rollout_flags::{RolloutConfig, RolloutFlags};
    use std::path::PathBuf;

    fn adapted_fresh() -> AdaptedProjectStatus {
        AdaptedProjectStatus::adapted(PathBuf::from("core.cpp"), PathBuf::from("gui.cpp"), None)
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
            require_ai_provider_call: false,
            user_requested_deterministic: false,
        };
        let result = classify_loop(&input).expect("ordinary routing");
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
            require_ai_provider_call: false,
            user_requested_deterministic: false,
        };
        let result = classify_loop(&input).expect("ordinary routing");
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
            require_ai_provider_call: false,
            user_requested_deterministic: false,
        };
        let result = classify_loop(&input).expect("ordinary routing");
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
            require_ai_provider_call: false,
            user_requested_deterministic: false,
        };
        let result = classify_loop(&input).expect("ordinary routing");
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
            require_ai_provider_call: false,
            user_requested_deterministic: true,
        };
        let result = classify_loop(&input).expect("ordinary routing");
        assert_eq!(result.loop_type, CompileLoop::LoopA);
    }

    #[test]
    fn required_provider_call_forces_loop_b_for_adapted_project() {
        let status = adapted_fresh();
        let f = flags();
        let input = LoopClassifierInput {
            adapted_status: &status,
            current_source_hash: Some("hash1"),
            rollout_flags: &f,
            consecutive_failures: 0,
            failure_rescue_threshold: 3,
            user_requested_ai: false,
            require_ai_provider_call: true,
            user_requested_deterministic: false,
        };

        let result = classify_loop(&input).expect("required provider route");

        assert_eq!(result.loop_type, CompileLoop::LoopB);
        assert!(matches!(result.reason, LoopReason::RequiredAiProviderCall));
    }

    #[test]
    fn required_provider_call_rejects_deterministic_override() {
        let status = adapted_fresh();
        let f = flags();
        let input = LoopClassifierInput {
            adapted_status: &status,
            current_source_hash: Some("hash1"),
            rollout_flags: &f,
            consecutive_failures: 0,
            failure_rescue_threshold: 3,
            user_requested_ai: false,
            require_ai_provider_call: true,
            user_requested_deterministic: true,
        };

        assert!(matches!(
            classify_loop(&input),
            Err(LoopRoutingError::RequiredProviderCallConflictsWithDeterministicMode)
        ));
    }

    #[test]
    fn required_provider_call_fails_when_ai_is_killed() {
        let status = adapted_fresh();
        let f = flags();
        f.set_global_kill(true);
        let input = LoopClassifierInput {
            adapted_status: &status,
            current_source_hash: Some("hash1"),
            rollout_flags: &f,
            consecutive_failures: 0,
            failure_rescue_threshold: 3,
            user_requested_ai: false,
            require_ai_provider_call: true,
            user_requested_deterministic: false,
        };

        assert!(matches!(
            classify_loop(&input),
            Err(LoopRoutingError::RequiredProviderCallDisabledByPolicy)
        ));
    }

    #[test]
    fn required_provider_call_fails_when_no_ai_hot_path_is_forced() {
        let status = adapted_fresh();
        let f = RolloutFlags::new(RolloutConfig {
            force_no_ai_hot_path: true,
            ..Default::default()
        });
        let input = LoopClassifierInput {
            adapted_status: &status,
            current_source_hash: Some("hash1"),
            rollout_flags: &f,
            consecutive_failures: 0,
            failure_rescue_threshold: 3,
            user_requested_ai: false,
            require_ai_provider_call: true,
            user_requested_deterministic: false,
        };

        assert!(matches!(
            classify_loop(&input),
            Err(LoopRoutingError::RequiredProviderCallDisabledByPolicy)
        ));
    }
}
