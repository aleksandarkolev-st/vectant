// ============================================================
// CANDIDATE SUPERSESSION
// ============================================================
// Logic for determining when a newer candidate should supersede
// an older one.  Used by the candidate queue to short-circuit
// in-flight candidates when a newer build arrives.
// ============================================================

use serde::{Deserialize, Serialize};

use crate::hmr::build_manifest::{ArtifactSetIdentityError, BuildManifest};
use crate::hmr::candidate::{Candidate, CandidateState};

/// Supersession verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SupersessionVerdict {
    /// The newer candidate supersedes — discard the older one.
    Supersede,
    /// The older candidate should finish (e.g., it's nearly promoted).
    LetFinish,
    /// Same artifact — skip the newer candidate.
    Duplicate,
}

/// Policy for supersession decisions.
#[derive(Debug, Clone)]
pub struct SupersessionPolicy {
    /// Never supersede if the older candidate is already past health check.
    pub protect_validated: bool,
    /// Always supersede regardless of state.
    pub aggressive: bool,
}

impl Default for SupersessionPolicy {
    fn default() -> Self {
        Self {
            protect_validated: true,
            aggressive: false,
        }
    }
}

/// Decide whether a newer candidate should supersede an active older one.
pub fn should_supersede(
    active: &Candidate,
    newer_manifest: &BuildManifest,
    policy: &SupersessionPolicy,
) -> Result<SupersessionVerdict, ArtifactSetIdentityError> {
    let newer_identity = newer_manifest.artifact_set_identity()?;
    // Same artifact — no point in replacing.
    if active.id().artifact_set_identity() == newer_identity {
        return Ok(SupersessionVerdict::Duplicate);
    }

    // Already terminal — nothing to supersede.
    if active.is_terminal() {
        return Ok(SupersessionVerdict::LetFinish);
    }

    // Aggressive mode always supersedes.
    if policy.aggressive {
        return Ok(SupersessionVerdict::Supersede);
    }

    // If validated and policy protects validated, let it finish.
    if policy.protect_validated && active.state == CandidateState::Validated {
        return Ok(SupersessionVerdict::LetFinish);
    }

    // In Loading or HealthChecking — supersede with newer.
    Ok(match active.state {
        CandidateState::Built | CandidateState::Loading | CandidateState::HealthChecking => {
            SupersessionVerdict::Supersede
        }
        _ => SupersessionVerdict::LetFinish,
    })
}

#[cfg(test)]
mod artifact_set_tests {
    use super::*;
    use crate::hmr::build_manifest::{BuildArtifactIdentity, BuildSlot};
    use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};

    const SELECTED_HASH: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const BEFORE_HASH: &str =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const AFTER_HASH: &str =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const SAME_HASH: &str =
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    fn candidate(manifest: BuildManifest) -> Candidate {
        Candidate::new(
            manifest,
            1,
            ReloadDecision::WarmReload,
            StateStrategy::Preserve,
        )
        .unwrap()
    }

    fn manifest(secondary_hash: &str) -> BuildManifest {
        BuildManifest::new(
            "preview",
            "open-vocabulary-label",
            "observed-mechanism",
            0,
            BuildSlot::Full,
            "/build/selected.bin",
            SELECTED_HASH,
        )
        .with_artifacts(vec![
            BuildArtifactIdentity::new(
                "selected-output",
                "/build/selected.bin",
                SELECTED_HASH,
            ),
            BuildArtifactIdentity::new(
                "another-output",
                "/build/another.bin",
                secondary_hash,
            ),
        ])
    }

    #[test]
    fn same_primary_with_changed_secondary_is_not_duplicate() {
        let mut active = candidate(manifest(BEFORE_HASH));
        active.begin_load();

        assert_eq!(
            should_supersede(
                &active,
                &manifest(AFTER_HASH),
                &SupersessionPolicy::default(),
            )
            .unwrap(),
            SupersessionVerdict::Supersede
        );
    }

    #[test]
    fn identical_reordered_artifact_set_is_duplicate() {
        let active_manifest = manifest(SAME_HASH);
        let mut reordered = active_manifest.clone();
        reordered.artifacts.as_mut().unwrap().reverse();

        assert_eq!(
            should_supersede(
                &candidate(active_manifest),
                &reordered,
                &SupersessionPolicy::default(),
            )
            .unwrap(),
            SupersessionVerdict::Duplicate
        );
    }

    #[test]
    fn malformed_new_artifact_set_is_never_duplicate() {
        let active_manifest = manifest(SAME_HASH);
        let mut malformed = active_manifest.clone();
        let artifacts = malformed.artifacts.as_mut().unwrap();
        artifacts[1].artifact_id = artifacts[0].artifact_id.clone();

        assert!(should_supersede(
            &candidate(active_manifest),
            &malformed,
            &SupersessionPolicy::default(),
        )
        .is_err());
    }

    #[test]
    fn supersession_uses_the_identity_frozen_at_candidate_admission() {
        let admitted_manifest = manifest(SAME_HASH);
        let duplicate_manifest = admitted_manifest.clone();
        let mut active = candidate(admitted_manifest);
        active.manifest.artifacts.as_mut().unwrap()[1].artifact_hash = AFTER_HASH.into();

        assert_eq!(
            should_supersede(
                &active,
                &duplicate_manifest,
                &SupersessionPolicy::default(),
            )
            .unwrap(),
            SupersessionVerdict::Duplicate
        );
    }
}

#[cfg(all(test, feature = "legacy_hmr_tests"))]
mod tests {
    use super::*;
    use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
    use crate::hmr::build_manifest::{BuildManifest, BuildSlot, HealthcheckStrategy};
    use crate::hmr::health_check::HealthCheckResult;
    use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};

    fn make_candidate(hash: &str) -> Candidate {
        let manifest = BuildManifest {
            preview_id: "p1".into(),
            language: "rust".into(),
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            slot: BuildSlot::Primary,
            artifact_path: "/tmp/test.so".into(),
            artifact_hash: hash.into(),
            abi_version: "1.0".into(),
            state_schema_hash: None,
            snapshot_modes: vec![],
            capabilities: vec![],
            exported_symbols: vec![],
            dependencies: vec![],
            healthcheck_strategy: HealthcheckStrategy::SymbolProbe,
            rollout_flags: Default::default(),
            build_time_ms: 100,
            extension: Default::default(),
        };
        Candidate::new(
            manifest,
            1,
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        )
        .unwrap()
    }

    #[test]
    fn duplicate_hash() {
        let c = make_candidate("abc");
        assert_eq!(
            should_supersede(&c, "abc", &SupersessionPolicy::default()),
            SupersessionVerdict::Duplicate
        );
    }

    #[test]
    fn supersede_loading() {
        let mut c = make_candidate("abc");
        c.begin_load();
        assert_eq!(
            should_supersede(&c, "def", &SupersessionPolicy::default()),
            SupersessionVerdict::Supersede
        );
    }

    #[test]
    fn protect_validated() {
        let mut c = make_candidate("abc");
        c.begin_load();
        c.begin_health_check();
        c.record_health(HealthCheckResult::Healthy { latency_ms: 10 });
        assert_eq!(c.state, CandidateState::Validated);
        assert_eq!(
            should_supersede(&c, "def", &SupersessionPolicy::default()),
            SupersessionVerdict::LetFinish
        );
    }

    #[test]
    fn aggressive_overrides() {
        let mut c = make_candidate("abc");
        c.begin_load();
        c.begin_health_check();
        c.record_health(HealthCheckResult::Healthy { latency_ms: 10 });
        let policy = SupersessionPolicy {
            protect_validated: true,
            aggressive: true,
        };
        assert_eq!(
            should_supersede(&c, "def", &policy),
            SupersessionVerdict::Supersede
        );
    }
}
