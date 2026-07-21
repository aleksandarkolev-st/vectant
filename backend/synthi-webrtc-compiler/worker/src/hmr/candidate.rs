// ============================================================
// CANDIDATE PROMOTION / ROLLBACK PROTOCOL
// ============================================================
// Defines the contract for promoting a new candidate to "live"
// or rolling back to the previous module when health checks fail.
//
// The candidate model:
//   1. Build produces a new artifact (candidate)
//   2. Candidate is loaded alongside the current (live) module
//   3. Health check runs against the candidate
//   4. On success: candidate is promoted, old is unloaded
//   5. On failure: candidate is discarded, old stays live
// ============================================================

use serde::{Deserialize, Serialize};
use std::time::Instant;

use crate::hmr::build_manifest::{ArtifactSetIdentityError, BuildManifest};
use crate::hmr::health_check::HealthCheckResult;
use crate::hmr::planner_decision::{ReloadDecision, StateStrategy};

/// Identifies a specific candidate within a preview session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CandidateId {
    preview_id: String,
    generation: u64,
    artifact_hash: String,
    artifact_set_identity: String,
}

impl CandidateId {
    pub fn preview_id(&self) -> &str {
        &self.preview_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn artifact_hash(&self) -> &str {
        &self.artifact_hash
    }

    pub fn artifact_set_identity(&self) -> &str {
        &self.artifact_set_identity
    }
}

/// State of a candidate through its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CandidateState {
    /// Candidate artifact has been built.
    Built,
    /// Candidate is being loaded into the runtime.
    Loading,
    /// Candidate is loaded; health check is running.
    HealthChecking,
    /// Candidate passed health check; promotion pending.
    Validated,
    /// Candidate is now live — old module has been unloaded.
    Promoted,
    /// Candidate was rolled back; old module is still live.
    RolledBack,
    /// Candidate was discarded (e.g., superseded by a newer build).
    Discarded,
}

/// A single candidate through its lifecycle.
#[derive(Debug, Clone)]
pub struct Candidate {
    id: CandidateId,
    pub state: CandidateState,
    pub manifest: BuildManifest,
    pub decision: ReloadDecision,
    pub state_strategy: StateStrategy,
    pub health_result: Option<HealthCheckResult>,
    pub rollback_reason: Option<String>,
    pub created_at: Instant,
    pub promoted_at: Option<Instant>,
}

impl Candidate {
    pub fn new(
        manifest: BuildManifest,
        generation: u64,
        decision: ReloadDecision,
        state_strategy: StateStrategy,
    ) -> Result<Self, ArtifactSetIdentityError> {
        let artifact_set_identity = manifest.artifact_set_identity()?;
        let id = CandidateId {
            preview_id: manifest.preview_id.clone(),
            generation,
            artifact_hash: manifest.artifact_hash.clone(),
            artifact_set_identity,
        };
        Ok(Self {
            id,
            state: CandidateState::Built,
            manifest,
            decision,
            state_strategy,
            health_result: None,
            rollback_reason: None,
            created_at: Instant::now(),
            promoted_at: None,
        })
    }

    pub fn id(&self) -> &CandidateId {
        &self.id
    }

    /// Time elapsed since candidate was created.
    pub fn age(&self) -> std::time::Duration {
        self.created_at.elapsed()
    }

    /// Mark candidate as loading.
    pub fn begin_load(&mut self) {
        self.state = CandidateState::Loading;
    }

    /// Mark candidate as health-checking.
    pub fn begin_health_check(&mut self) {
        self.state = CandidateState::HealthChecking;
    }

    /// Record health check result.
    pub fn record_health(&mut self, result: HealthCheckResult) {
        self.health_result = Some(result.clone());
        if result.is_healthy() {
            self.state = CandidateState::Validated;
        } else {
            self.state = CandidateState::RolledBack;
            self.rollback_reason = result
                .failure_reason()
                .map(|s| s.to_string())
                .or_else(|| Some("health_check_failed".into()));
        }
    }

    /// Promote candidate to live.
    pub fn promote(&mut self) {
        self.state = CandidateState::Promoted;
        self.promoted_at = Some(Instant::now());
    }

    /// Rollback candidate with a reason.
    pub fn rollback(&mut self, reason: impl Into<String>) {
        self.state = CandidateState::RolledBack;
        self.rollback_reason = Some(reason.into());
    }

    /// Discard candidate (superseded).
    pub fn discard(&mut self) {
        self.state = CandidateState::Discarded;
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            CandidateState::Promoted | CandidateState::RolledBack | CandidateState::Discarded
        )
    }
}

/// Serializable summary of a candidate lifecycle for notifications.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateSummary {
    pub preview_id: String,
    pub generation: u64,
    pub artifact_hash: String,
    pub artifact_set_identity: String,
    pub state: CandidateState,
    pub decision: String,
    pub rollback_reason: Option<String>,
    pub age_ms: u64,
}

impl From<&Candidate> for CandidateSummary {
    fn from(c: &Candidate) -> Self {
        Self {
            preview_id: c.id.preview_id().to_string(),
            generation: c.id.generation(),
            artifact_hash: c.id.artifact_hash().to_string(),
            artifact_set_identity: c.id.artifact_set_identity().to_string(),
            state: c.state,
            decision: format!("{:?}", c.decision),
            rollback_reason: c.rollback_reason.clone(),
            age_ms: c.age().as_millis() as u64,
        }
    }
}

#[cfg(test)]
mod artifact_set_identity_tests {
    use super::*;
    use crate::hmr::build_manifest::{BuildArtifactIdentity, BuildSlot};

    const SELECTED_HASH: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SECONDARY_HASH: &str =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const CHANGED_SECONDARY_HASH: &str =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    fn manifest(secondary_hash: &str) -> BuildManifest {
        BuildManifest::new(
            "preview",
            "open-vocabulary-label",
            "observed-mechanism",
            0,
            BuildSlot::Custom("opaque-transaction".into()),
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
                "secondary-output",
                "/build/secondary.bin",
                secondary_hash,
            ),
        ])
    }

    fn candidate(manifest: BuildManifest) -> Candidate {
        Candidate::new(
            manifest,
            7,
            ReloadDecision::WarmReload,
            StateStrategy::Preserve,
        )
        .unwrap()
    }

    #[test]
    fn candidate_and_summary_retain_complete_artifact_set_identity() {
        let manifest = manifest(SECONDARY_HASH);
        let expected_identity = manifest.artifact_set_identity().unwrap();
        let candidate = candidate(manifest);
        let summary = CandidateSummary::from(&candidate);

        assert_eq!(candidate.id().artifact_set_identity(), expected_identity);
        assert_eq!(summary.artifact_set_identity, expected_identity);
    }

    #[test]
    fn changed_secondary_output_changes_candidate_identity() {
        let before = candidate(manifest(SECONDARY_HASH));
        let after = candidate(manifest(CHANGED_SECONDARY_HASH));

        assert_eq!(before.id().artifact_hash(), after.id().artifact_hash());
        assert_ne!(
            before.id().artifact_set_identity(),
            after.id().artifact_set_identity()
        );
    }

    #[test]
    fn malformed_artifact_set_cannot_construct_candidate() {
        let malformed = manifest(SECONDARY_HASH).with_artifacts(vec![
            BuildArtifactIdentity::new(
                "duplicate-output",
                "/build/selected.bin",
                SELECTED_HASH,
            ),
            BuildArtifactIdentity::new(
                "duplicate-output",
                "/build/secondary.bin",
                SECONDARY_HASH,
            ),
        ]);

        assert!(Candidate::new(
            malformed,
            7,
            ReloadDecision::WarmReload,
            StateStrategy::Preserve,
        )
        .is_err());
    }
}

#[cfg(all(test, feature = "legacy_hmr_tests"))]
mod tests {
    use super::*;
    use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
    use crate::hmr::build_manifest::{BuildSlot, HealthcheckStrategy, SnapshotMode};

    fn test_manifest() -> BuildManifest {
        BuildManifest {
            preview_id: "p1".into(),
            language: "rust".into(),
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            slot: BuildSlot::Primary,
            artifact_path: "/tmp/test.so".into(),
            artifact_hash: "hash1".into(),
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
        }
    }

    #[test]
    fn candidate_lifecycle_promote() {
        let mut c = Candidate::new(
            test_manifest(),
            1,
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        )
        .unwrap();
        assert_eq!(c.state, CandidateState::Built);

        c.begin_load();
        assert_eq!(c.state, CandidateState::Loading);

        c.begin_health_check();
        assert_eq!(c.state, CandidateState::HealthChecking);

        c.record_health(HealthCheckResult::Healthy { latency_ms: 10 });
        assert_eq!(c.state, CandidateState::Validated);

        c.promote();
        assert_eq!(c.state, CandidateState::Promoted);
        assert!(c.is_terminal());
    }

    #[test]
    fn candidate_lifecycle_rollback() {
        let mut c = Candidate::new(
            test_manifest(),
            1,
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        )
        .unwrap();
        c.begin_load();
        c.begin_health_check();
        c.record_health(HealthCheckResult::Unhealthy {
            reason: "segfault".into(),
            latency_ms: 5,
        });
        assert_eq!(c.state, CandidateState::RolledBack);
        assert_eq!(c.rollback_reason.as_deref(), Some("segfault"));
        assert!(c.is_terminal());
    }

    #[test]
    fn candidate_discard() {
        let mut c = Candidate::new(
            test_manifest(),
            1,
            ReloadDecision::ColdReload,
            StateStrategy::SnapshotRestore,
        )
        .unwrap();
        c.discard();
        assert_eq!(c.state, CandidateState::Discarded);
        assert!(c.is_terminal());
    }

    #[test]
    fn candidate_summary() {
        let c = Candidate::new(
            test_manifest(),
            42,
            ReloadDecision::WarmReload,
            StateStrategy::PreservePointer,
        )
        .unwrap();
        let summary = CandidateSummary::from(&c);
        assert_eq!(summary.generation, 42);
        assert_eq!(summary.preview_id, "p1");
    }
}
