// ============================================================
// CANDIDATE PROMOTION POLICY
// ============================================================
// Determines whether a validated candidate should be promoted
// to live, based on configurable policies: health checks,
// latency budgets, rollout flags, and cooldown windows.
// ============================================================

use serde::{Deserialize, Serialize};

use crate::hmr::candidate::{Candidate, CandidateState};
use crate::hmr::health_check::HealthCheckResult;
use crate::hmr::planner_decision::ReloadDecision;

/// Promotion policy verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PromotionVerdict {
    /// Promote immediately.
    Promote,
    /// Defer — need more health data or cooldown not elapsed.
    Defer { reason: String },
    /// Reject — hard failure, do not promote.
    Reject { reason: String },
}

/// Configurable promotion policy.
#[derive(Debug, Clone)]
pub struct PromotionPolicy {
    /// Require health check to pass before promotion.
    pub require_health_check: bool,

    /// Maximum latency for the health check itself (ms).
    pub max_health_latency_ms: u64,

    /// Whether health probe latency is a promotion gate.
    ///
    /// A healthy probe proves the candidate responded correctly. Probe latency is
    /// useful performance telemetry, but it is not a safety property unless a
    /// caller explicitly opts into enforcing this SLA.
    pub enforce_health_latency_budget: bool,

    /// Minimum time since candidate creation before promotion (ms).
    /// Prevents promoting too quickly on flaky builds.
    pub min_age_ms: u64,

    /// Maximum age before candidate is considered stale (ms).
    pub max_age_ms: u64,

    /// Whether to enforce the warm reload latency budget (2.5s).
    pub enforce_latency_budget: bool,

    /// Maximum total reload time for promotion (ms).
    pub max_total_reload_ms: u64,
}

impl Default for PromotionPolicy {
    fn default() -> Self {
        Self {
            require_health_check: true,
            max_health_latency_ms: 1000,
            enforce_health_latency_budget: false,
            min_age_ms: 0,
            max_age_ms: 30_000,
            enforce_latency_budget: true,
            max_total_reload_ms: 2500,
        }
    }
}

/// Evaluate whether a candidate should be promoted.
pub fn evaluate_promotion(
    candidate: &Candidate,
    policy: &PromotionPolicy,
    total_reload_ms: u64,
) -> PromotionVerdict {
    let enforce_warm_latency_budget =
        policy.enforce_latency_budget && matches!(candidate.decision, ReloadDecision::WarmReload);

    // Must be in Validated state
    if candidate.state != CandidateState::Validated {
        return PromotionVerdict::Reject {
            reason: format!("candidate in {:?} state, not Validated", candidate.state),
        };
    }

    // Check health result if required
    if policy.require_health_check {
        match &candidate.health_result {
            None => {
                return PromotionVerdict::Defer {
                    reason: "awaiting health check result".into(),
                };
            }
            Some(HealthCheckResult::Unhealthy { reason, .. }) => {
                return PromotionVerdict::Reject {
                    reason: format!("health check failed: {}", reason),
                };
            }
            Some(HealthCheckResult::Healthy { latency_ms }) => {
                if policy.enforce_health_latency_budget
                    && *latency_ms > policy.max_health_latency_ms
                {
                    return PromotionVerdict::Reject {
                        reason: format!(
                            "health check latency {}ms exceeds max {}ms",
                            latency_ms, policy.max_health_latency_ms
                        ),
                    };
                }
            }
            Some(HealthCheckResult::Skipped) => {
                // Acceptable
            }
            Some(HealthCheckResult::Timeout { .. }) => {
                return PromotionVerdict::Reject {
                    reason: "health check timed out".into(),
                };
            }
        }
    }

    // Check age bounds
    let age_ms = candidate.age().as_millis() as u64;
    if age_ms < policy.min_age_ms {
        return PromotionVerdict::Defer {
            reason: format!(
                "candidate age {}ms below minimum {}ms",
                age_ms, policy.min_age_ms
            ),
        };
    }
    if age_ms > policy.max_age_ms {
        return PromotionVerdict::Reject {
            reason: format!(
                "candidate age {}ms exceeds maximum {}ms (stale)",
                age_ms, policy.max_age_ms
            ),
        };
    }

    // Warm reload latency budget enforcement. Cold reloads and first compiles
    // may legitimately take longer because they include process startup,
    // runner load, AI split generation, or full module initialization.
    if enforce_warm_latency_budget && total_reload_ms > policy.max_total_reload_ms {
        return PromotionVerdict::Reject {
            reason: format!(
                "total reload time {}ms exceeds budget {}ms",
                total_reload_ms, policy.max_total_reload_ms
            ),
        };
    }

    PromotionVerdict::Promote
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::build_manifest::{
        BuildManifest, BuildSlot, HealthcheckStrategy, PreviewPreservationMode,
    };
    use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};

    fn validated_candidate_with(decision: ReloadDecision, latency_ms: u64) -> Candidate {
        let manifest = BuildManifest {
            preview_id: "p1".into(),
            language: "rust".into(),
            adapter_family: "DynamicLibrary".into(),
            capability_tier: 2,
            slot: BuildSlot::Core,
            artifact_path: "/tmp/test.so".into(),
            artifact_hash: "hash1".into(),
            toolchain_fingerprint: String::new(),
            abi_version: "1.0".into(),
            state_schema_hash: String::new(),
            snapshot_modes: vec![],
            capabilities: vec![],
            preview_preservation_mode: PreviewPreservationMode::Restart,
            dirty_unit_source: None,
            exported_symbols: vec![],
            dependencies: vec![],
            healthcheck_strategy: HealthcheckStrategy::SymbolCheck,
            rollout_flags: Default::default(),
            build_time_ms: 100,
            translation_units: None,
            dirty_units: None,
            header_fingerprint: None,
            source_map_metadata: None,
            candidate_generation: None,
            boundary_map_version: None,
            provenance_id: None,
        };
        let mut c = Candidate::new(manifest, 1, decision, StateStrategy::Preserve);
        c.begin_load();
        c.begin_health_check();
        c.record_health(HealthCheckResult::Healthy { latency_ms });
        c
    }

    fn validated_candidate() -> Candidate {
        validated_candidate_with(ReloadDecision::WarmReload, 50)
    }

    #[test]
    fn promote_on_success() {
        let c = validated_candidate();
        let policy = PromotionPolicy::default();
        assert_eq!(
            evaluate_promotion(&c, &policy, 400),
            PromotionVerdict::Promote
        );
    }

    #[test]
    fn reject_on_budget_exceeded() {
        let c = validated_candidate();
        let policy = PromotionPolicy::default();
        match evaluate_promotion(&c, &policy, 5000) {
            PromotionVerdict::Reject { reason } => {
                assert!(reason.contains("budget"));
            }
            other => panic!("Expected Reject, got {:?}", other),
        }
    }

    #[test]
    fn promote_when_health_latency_exceeds_probe_budget_by_default() {
        let c = validated_candidate_with(ReloadDecision::WarmReload, 1500);
        let policy = PromotionPolicy::default();
        assert_eq!(
            evaluate_promotion(&c, &policy, 1500),
            PromotionVerdict::Promote
        );
    }

    #[test]
    fn reject_when_health_latency_budget_is_explicitly_enforced() {
        let c = validated_candidate_with(ReloadDecision::WarmReload, 1500);
        let policy = PromotionPolicy {
            enforce_health_latency_budget: true,
            ..PromotionPolicy::default()
        };
        match evaluate_promotion(&c, &policy, 1500) {
            PromotionVerdict::Reject { reason } => {
                assert!(reason.contains("health check latency"));
            }
            other => panic!("Expected Reject, got {:?}", other),
        }
    }

    #[test]
    fn promote_cold_reload_over_warm_latency_budget() {
        let c = validated_candidate_with(ReloadDecision::ColdReload, 5000);
        let policy = PromotionPolicy::default();
        assert_eq!(
            evaluate_promotion(&c, &policy, 5000),
            PromotionVerdict::Promote
        );
    }

    #[test]
    fn reject_on_wrong_state() {
        let manifest = BuildManifest {
            preview_id: "p1".into(),
            language: "rust".into(),
            adapter_family: "DynamicLibrary".into(),
            capability_tier: 2,
            slot: BuildSlot::Core,
            artifact_path: "/tmp/test.so".into(),
            artifact_hash: "hash1".into(),
            toolchain_fingerprint: String::new(),
            abi_version: "1.0".into(),
            state_schema_hash: String::new(),
            snapshot_modes: vec![],
            capabilities: vec![],
            preview_preservation_mode: PreviewPreservationMode::Restart,
            dirty_unit_source: None,
            exported_symbols: vec![],
            dependencies: vec![],
            healthcheck_strategy: HealthcheckStrategy::SymbolCheck,
            rollout_flags: Default::default(),
            build_time_ms: 100,
            translation_units: None,
            dirty_units: None,
            header_fingerprint: None,
            source_map_metadata: None,
            candidate_generation: None,
            boundary_map_version: None,
            provenance_id: None,
        };
        let c = Candidate::new(
            manifest,
            1,
            ReloadDecision::WarmReload,
            StateStrategy::Preserve,
        );
        match evaluate_promotion(&c, &PromotionPolicy::default(), 400) {
            PromotionVerdict::Reject { reason } => {
                assert!(reason.contains("Built"));
            }
            other => panic!("Expected Reject, got {:?}", other),
        }
    }
}
