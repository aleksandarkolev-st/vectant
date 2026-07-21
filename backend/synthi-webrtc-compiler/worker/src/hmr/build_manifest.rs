// ============================================================
// BUILD ARTIFACT MANIFEST
// ============================================================
// The manifest is the missing source of truth between compile
// and reload. Each build produces a manifest; the planner
// consumes it to make deterministic reload decisions.
// ============================================================

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt;

pub const GPU_SIDECAR_MODULE_CAPABILITY: &str = "gpu_sidecar_module";
pub const GPU_SIDECAR_PARTIAL_MODULE_CAPABILITY: &str = "gpu_sidecar_partial_module";

/// Snapshot modes supported by an adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotMode {
    /// Binary snapshot (MessagePack, bincode, etc.)
    Binary,
    /// Structured JSON fallback
    Json,
    /// No snapshot support — state will be reset.
    None,
}

/// Strategy the runtime will use to health-check a candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthcheckStrategy {
    /// Validate exported symbols only.
    SymbolCheck,
    /// Run first tick / first render after loading.
    FirstTick,
    /// Full startup sequence validation.
    StartupSequence,
    /// No health check available.
    None,
}

/// Mode the planner should use for preview preservation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewPreservationMode {
    /// Keep existing preview alive during candidate load.
    KeepAlive,
    /// Brief pause while swapping, then resume.
    Quiesce,
    /// Preview must be restarted.
    Restart,
}

/// The source that triggered dirty-unit identification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirtyUnitSource {
    /// File watcher detected a change.
    FileWatcher,
    /// User explicitly requested recompile.
    UserRequest,
    /// AI adaptation modified sources.
    AiAdaptation,
    /// Dependency graph analysis found transitive changes.
    DependencyGraph,
}

/// A build slot (compilation target within a preview session).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildSlot {
    Core,
    Gui,
    Widget(String),
    Full,
    Custom(String),
}

/// Content identity for one output participating in a reload transaction.
///
/// `artifact_id` is an opaque build-graph identity. Consumers must not infer
/// behavior from it; routing remains driven by observed runtime capabilities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildArtifactIdentity {
    pub artifact_id: String,
    pub artifact_path: String,
    pub artifact_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_length: Option<u64>,
}

impl BuildArtifactIdentity {
    pub fn new(
        artifact_id: impl Into<String>,
        artifact_path: impl Into<String>,
        artifact_hash: impl Into<String>,
    ) -> Self {
        Self {
            artifact_id: artifact_id.into(),
            artifact_path: artifact_path.into(),
            artifact_hash: artifact_hash.into(),
            byte_length: None,
        }
    }

    pub fn with_byte_length(mut self, byte_length: u64) -> Self {
        self.byte_length = Some(byte_length);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactSetIdentityError {
    reason: String,
}

impl ArtifactSetIdentityError {
    fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

impl fmt::Display for ArtifactSetIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.reason)
    }
}

impl std::error::Error for ArtifactSetIdentityError {}

/// The build artifact manifest.
///
/// Every compiled-language path must produce one of these per build.
/// The reload planner consumes it together with the previous manifest
/// to decide warm / cold / managed / process-swap / reject.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildManifest {
    /// Unique preview session ID.
    pub preview_id: String,
    /// Language that was compiled.
    pub language: String,
    /// Adapter family (see `AdapterFamily`).
    pub adapter_family: String,
    /// Capability tier (0–3).
    pub capability_tier: u8,
    /// Which slot this build targets.
    pub slot: BuildSlot,
    /// Path to the produced artifact (e.g. ".so", ".jar").
    pub artifact_path: String,
    /// Content hash of the artifact.
    pub artifact_hash: String,
    /// Every output whose bytes participate in this reload transaction.
    /// `None` is the legacy singleton representation; `Some([])` is invalid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<Vec<BuildArtifactIdentity>>,
    /// Fingerprint of the toolchain used to build.
    pub toolchain_fingerprint: String,
    /// ABI version tag.
    pub abi_version: String,
    /// Hash of the state schema the artifact expects.
    pub state_schema_hash: String,
    /// Snapshot modes the adapter supports.
    pub snapshot_modes: Vec<SnapshotMode>,
    /// Capabilities declared by the adapter.
    pub capabilities: Vec<String>,
    /// How the preview should be preserved during reload.
    pub preview_preservation_mode: PreviewPreservationMode,
    /// What triggered dirty-unit detection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty_unit_source: Option<DirtyUnitSource>,
    /// Exported symbols from the artifact.
    pub exported_symbols: Vec<String>,
    /// Artifact dependencies (other slots this depends on).
    pub dependencies: Vec<String>,
    /// Healthcheck strategy for the candidate.
    pub healthcheck_strategy: HealthcheckStrategy,
    /// Rollout / feature flags active for this build.
    pub rollout_flags: HashMap<String, bool>,
    /// Build duration in milliseconds.
    pub build_time_ms: u64,

    // ── Optional extension fields ────────────────────────────
    /// Translation units that were compiled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation_units: Option<Vec<String>>,
    /// Which translation units were dirty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty_units: Option<Vec<String>>,
    /// Header fingerprint (for shared-header change detection).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header_fingerprint: Option<String>,
    /// Source-map metadata pointer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_map_metadata: Option<String>,
    /// Monotonically increasing candidate generation counter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_generation: Option<u64>,
    /// Boundary map version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundary_map_version: Option<String>,
    /// Provenance ID linking to AI adaptation, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance_id: Option<String>,
}

impl BuildManifest {
    /// Create a minimal valid manifest for a build.
    pub fn new(
        preview_id: impl Into<String>,
        language: impl Into<String>,
        adapter_family: impl Into<String>,
        capability_tier: u8,
        slot: BuildSlot,
        artifact_path: impl Into<String>,
        artifact_hash: impl Into<String>,
    ) -> Self {
        let artifact_path = artifact_path.into();
        let artifact_hash = artifact_hash.into();
        Self {
            preview_id: preview_id.into(),
            language: language.into(),
            adapter_family: adapter_family.into(),
            capability_tier,
            slot,
            artifact_path,
            artifact_hash,
            artifacts: None,
            toolchain_fingerprint: String::new(),
            abi_version: String::new(),
            state_schema_hash: String::new(),
            snapshot_modes: vec![SnapshotMode::None],
            capabilities: Vec::new(),
            preview_preservation_mode: PreviewPreservationMode::Restart,
            dirty_unit_source: None,
            exported_symbols: Vec::new(),
            dependencies: Vec::new(),
            healthcheck_strategy: HealthcheckStrategy::None,
            rollout_flags: HashMap::new(),
            build_time_ms: 0,
            translation_units: None,
            dirty_units: None,
            header_fingerprint: None,
            source_map_metadata: None,
            candidate_generation: None,
            boundary_map_version: None,
            provenance_id: None,
        }
    }

    /// Shorthand constructor: infers adapter family from language.
    pub fn for_language(preview_id: impl Into<String>, language: impl Into<String>) -> Self {
        let lang: String = language.into();
        let (family, tier) = match lang.as_str() {
            "c" | "cpp" | "rust" | "zig" => ("DynamicLibrary".to_string(), 2u8),
            "java" | "kotlin" => ("ManagedRuntime".to_string(), 1),
            "csharp" => ("ManagedRuntime".to_string(), 1),
            "go" | "swift" => ("ProcessSwap".to_string(), 0),
            _ => ("DynamicLibrary".to_string(), 0),
        };
        Self::new(preview_id, &lang, family, tier, BuildSlot::Full, "", "")
    }

    // ── Builder-style setters ──

    pub fn with_slot(mut self, slot: BuildSlot) -> Self {
        self.slot = slot;
        self
    }

    pub fn with_artifact(mut self, path: &str, hash: &str) -> Self {
        self.artifact_path = path.to_string();
        self.artifact_hash = hash.to_string();
        self
    }

    pub fn with_artifacts(mut self, artifacts: Vec<BuildArtifactIdentity>) -> Self {
        self.artifacts = Some(artifacts);
        self
    }

    /// Recompute a path-independent identity for the complete reload transaction.
    ///
    /// The selected artifact must occur exactly once in the set. Artifact IDs
    /// are opaque, unique build-graph keys. Content hashes define identity;
    /// locator paths and optional byte lengths are independently verified
    /// transport metadata and deliberately do not affect the commitment.
    pub fn artifact_set_identity(&self) -> Result<String, ArtifactSetIdentityError> {
        let mut artifacts = match &self.artifacts {
            Some(artifacts) => artifacts.clone(),
            None => selected_artifact_identity(&self.artifact_path, &self.artifact_hash)
                .into_iter()
                .collect::<Vec<_>>(),
        };

        if artifacts.is_empty() {
            return Err(ArtifactSetIdentityError::new(
                "artifact_set_missing_selected_artifact",
            ));
        }

        let mut ids = HashSet::with_capacity(artifacts.len());
        let mut paths = HashSet::with_capacity(artifacts.len());
        for artifact in &artifacts {
            if artifact.artifact_id.trim().is_empty()
                || artifact.artifact_path.trim().is_empty()
                || artifact.artifact_hash.trim().is_empty()
            {
                return Err(ArtifactSetIdentityError::new(
                    "artifact_set_contains_empty_identity_field",
                ));
            }
            if !ids.insert(artifact.artifact_id.as_str()) {
                return Err(ArtifactSetIdentityError::new(
                    "artifact_set_contains_duplicate_artifact_id",
                ));
            }
            if !paths.insert(artifact.artifact_path.as_str()) {
                return Err(ArtifactSetIdentityError::new(
                    "artifact_set_contains_duplicate_artifact_path",
                ));
            }
            if !is_canonical_sha256(&artifact.artifact_hash) {
                return Err(ArtifactSetIdentityError::new(
                    "artifact_set_contains_noncanonical_sha256",
                ));
            }
        }

        let mut selected = artifacts.iter().filter(|artifact| {
            artifact.artifact_path == self.artifact_path
                && artifact.artifact_hash == self.artifact_hash
        });
        let selected_id = selected
            .next()
            .map(|artifact| artifact.artifact_id.clone())
            .ok_or_else(|| {
                ArtifactSetIdentityError::new("artifact_set_selected_artifact_mismatch")
            })?;
        if selected.next().is_some() {
            return Err(ArtifactSetIdentityError::new(
                "artifact_set_selected_artifact_ambiguous",
            ));
        }

        artifacts.sort_by(|left, right| {
            left.artifact_id
                .cmp(&right.artifact_id)
                .then_with(|| left.artifact_hash.cmp(&right.artifact_hash))
        });

        let mut hasher = Sha256::new();
        hash_identity_field(&mut hasher, b"synthi.build_artifact_set.v1");
        hash_identity_field(&mut hasher, selected_id.as_bytes());
        hasher.update((artifacts.len() as u64).to_be_bytes());
        for artifact in artifacts {
            hash_identity_field(&mut hasher, artifact.artifact_id.as_bytes());
            hash_identity_field(&mut hasher, artifact.artifact_hash.as_bytes());
        }

        Ok(format!("artifact-set:sha256:{:x}", hasher.finalize()))
    }

    pub fn with_abi_version(mut self, version: &str) -> Self {
        self.abi_version = version.to_string();
        self
    }

    pub fn with_state_schema_hash(mut self, hash: &str) -> Self {
        self.state_schema_hash = hash.to_string();
        self
    }

    pub fn with_build_time(mut self, ms: u64) -> Self {
        self.build_time_ms = ms;
        self
    }

    pub fn with_exported_symbols(mut self, symbols: Vec<String>) -> Self {
        self.exported_symbols = symbols;
        self
    }

    pub fn with_snapshot_modes(mut self, modes: Vec<SnapshotMode>) -> Self {
        self.snapshot_modes = modes;
        self
    }

    pub fn with_capabilities(mut self, caps: Vec<String>) -> Self {
        self.capabilities = caps;
        self
    }

    pub fn with_dirty_units(mut self, units: Vec<String>) -> Self {
        self.dirty_units = Some(units);
        self
    }
}

fn selected_artifact_identity(path: &str, hash: &str) -> Option<BuildArtifactIdentity> {
    if path.trim().is_empty() || hash.trim().is_empty() {
        None
    } else {
        Some(BuildArtifactIdentity::new(
            "manifest_selected_artifact",
            path,
            hash,
        ))
    }
}

fn hash_identity_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn is_canonical_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const HASH_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    #[test]
    fn manifest_serde_roundtrip() {
        let mut m = BuildManifest::new(
            "p1",
            "cpp",
            "dynamic_library",
            3,
            BuildSlot::Gui,
            "/tmp/gui.so",
            HASH_A,
        );
        m.build_time_ms = 150;
        m.exported_symbols = vec!["on_render".into(), "on_update".into()];
        m.snapshot_modes = vec![SnapshotMode::Binary, SnapshotMode::Json];

        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("\"artifacts\""));
        let de: BuildManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(de.preview_id, "p1");
        assert_eq!(de.capability_tier, 3);
        assert_eq!(de.exported_symbols.len(), 2);
        assert_eq!(de.snapshot_modes.len(), 2);
        assert!(de.artifacts.is_none());
        assert!(de.artifact_set_identity().is_ok());
    }

    #[test]
    fn manifest_minimal() {
        let m = BuildManifest::new(
            "p2",
            "java",
            "managed_runtime",
            2,
            BuildSlot::Full,
            "/tmp/app.jar",
            "def456",
        );
        assert_eq!(m.healthcheck_strategy, HealthcheckStrategy::None);
        assert_eq!(
            m.preview_preservation_mode,
            PreviewPreservationMode::Restart
        );
    }

    #[test]
    fn artifact_set_identity_is_order_and_path_independent() {
        let selected = BuildArtifactIdentity::new("output-a", "/build/a.bin", HASH_A)
            .with_byte_length(11);
        let secondary = BuildArtifactIdentity::new("output-b", "/build/b.bin", HASH_B)
            .with_byte_length(17);
        let first = BuildManifest::new(
            "p",
            "unfamiliar-language",
            "observed-mechanism",
            0,
            BuildSlot::Custom("opaque-transaction".into()),
            "/build/a.bin",
            HASH_A,
        )
        .with_artifacts(vec![selected, secondary]);
        let relocated = BuildManifest::new(
            "p",
            "different-label",
            "different-label",
            0,
            BuildSlot::Custom("different-label".into()),
            "/cache/a.bin",
            HASH_A,
        )
        .with_artifacts(vec![
            BuildArtifactIdentity::new("output-b", "/cache/b.bin", HASH_B)
                .with_byte_length(17),
            BuildArtifactIdentity::new("output-a", "/cache/a.bin", HASH_A)
                .with_byte_length(11),
        ]);

        assert_eq!(
            first.artifact_set_identity().unwrap(),
            relocated.artifact_set_identity().unwrap()
        );
    }

    #[test]
    fn artifact_set_identity_changes_when_only_secondary_bytes_change() {
        let base = BuildManifest::new(
            "p",
            "source-label",
            "mechanism-label",
            0,
            BuildSlot::Full,
            "/build/a.bin",
            HASH_A,
        )
        .with_artifacts(vec![
            BuildArtifactIdentity::new("output-a", "/build/a.bin", HASH_A),
            BuildArtifactIdentity::new("output-b", "/build/b.bin", HASH_B),
        ]);
        let changed = base.clone().with_artifacts(vec![
            BuildArtifactIdentity::new("output-a", "/build/a.bin", HASH_A),
            BuildArtifactIdentity::new("output-b", "/build/b.bin", HASH_C),
        ]);

        assert_ne!(
            base.artifact_set_identity().unwrap(),
            changed.artifact_set_identity().unwrap()
        );
    }

    #[test]
    fn artifact_set_identity_ignores_optional_transport_metadata() {
        let without_length = BuildManifest::new(
            "p",
            "source-label",
            "mechanism-label",
            0,
            BuildSlot::Full,
            "/build/a.bin",
            HASH_A,
        )
        .with_artifacts(vec![BuildArtifactIdentity::new(
            "output-a",
            "/build/a.bin",
            HASH_A,
        )]);
        let with_length = without_length
            .clone()
            .with_artifacts(vec![
                BuildArtifactIdentity::new("output-a", "/relocated/a.bin", HASH_A)
                    .with_byte_length(4096),
            ])
            .with_artifact("/relocated/a.bin", HASH_A);

        assert_eq!(
            without_length.artifact_set_identity().unwrap(),
            with_length.artifact_set_identity().unwrap()
        );
    }

    #[test]
    fn malformed_artifact_sets_fail_closed() {
        let duplicate = BuildManifest::new(
            "p",
            "source-label",
            "mechanism-label",
            0,
            BuildSlot::Full,
            "/build/a.bin",
            HASH_A,
        )
        .with_artifacts(vec![
            BuildArtifactIdentity::new("same-id", "/build/a.bin", HASH_A),
            BuildArtifactIdentity::new("same-id", "/build/b.bin", HASH_B),
        ]);
        assert_eq!(
            duplicate.artifact_set_identity().unwrap_err().to_string(),
            "artifact_set_contains_duplicate_artifact_id"
        );

        let missing_selected = duplicate.with_artifacts(vec![BuildArtifactIdentity::new(
            "different-id",
            "/build/b.bin",
            HASH_B,
        )]);
        assert_eq!(
            missing_selected
                .artifact_set_identity()
                .unwrap_err()
                .to_string(),
            "artifact_set_selected_artifact_mismatch"
        );

        let duplicate_path = BuildManifest::new(
            "p",
            "source-label",
            "mechanism-label",
            0,
            BuildSlot::Full,
            "/build/a.bin",
            HASH_A,
        )
        .with_artifacts(vec![
            BuildArtifactIdentity::new("output-a", "/build/a.bin", HASH_A),
            BuildArtifactIdentity::new("output-b", "/build/a.bin", HASH_B),
        ]);
        assert_eq!(
            duplicate_path
                .artifact_set_identity()
                .unwrap_err()
                .to_string(),
            "artifact_set_contains_duplicate_artifact_path"
        );

        let noncanonical_hash = BuildManifest::new(
            "p",
            "source-label",
            "mechanism-label",
            0,
            BuildSlot::Full,
            "/build/a.bin",
            HASH_A,
        )
        .with_artifacts(vec![BuildArtifactIdentity::new(
            "output-a",
            "/build/a.bin",
            HASH_A.to_ascii_uppercase(),
        )]);
        assert_eq!(
            noncanonical_hash
                .artifact_set_identity()
                .unwrap_err()
                .to_string(),
            "artifact_set_contains_noncanonical_sha256"
        );

        let noncanonical_legacy = BuildManifest::new(
            "p",
            "source-label",
            "mechanism-label",
            0,
            BuildSlot::Full,
            "/build/a.bin",
            "not-a-content-hash",
        );
        assert_eq!(
            noncanonical_legacy
                .artifact_set_identity()
                .unwrap_err()
                .to_string(),
            "artifact_set_contains_noncanonical_sha256"
        );
    }

    #[test]
    fn selecting_an_artifact_after_declaring_the_set_cannot_erase_the_set() {
        let manifest = BuildManifest::new(
            "p",
            "source-label",
            "mechanism-label",
            0,
            BuildSlot::Full,
            "/build/a.bin",
            HASH_A,
        )
        .with_artifacts(vec![
            BuildArtifactIdentity::new("output-a", "/build/a.bin", HASH_A),
            BuildArtifactIdentity::new("output-b", "/build/b.bin", HASH_B),
        ])
        .with_artifact("/build/c.bin", HASH_C);

        assert_eq!(manifest.artifacts.as_ref().unwrap().len(), 2);
        assert_eq!(
            manifest.artifact_set_identity().unwrap_err().to_string(),
            "artifact_set_selected_artifact_mismatch"
        );
    }
}
