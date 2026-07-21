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
pub const RELOAD_ARTIFACT_ROLE_SCHEMA_VERSION: &str = "synthi.reload_artifact_role.v1";
pub const RELOAD_ARTIFACT_ROLE_ID_PREFIX: &str = "artifact-role:sha256:";
pub const RELOAD_ARTIFACT_INPUT_ID_PREFIX: &str = "artifact-input:sha256:";
pub const RELOAD_ARTIFACT_SET_ID_PREFIX: &str = "reload-transaction:sha256:";
pub const RELOAD_ARTIFACT_COMMITMENT_AUTHORITY: &str =
    "build_graph_commitment_only_not_compiler_runtime_or_gpu_hmr_proof";
const RELOAD_DEPENDENCY_CLOSURE_SCHEMA_VERSION: &str =
    "synthi.reload_dependency_closure.v1";
const RELOAD_ARTIFACT_SET_SCHEMA_VERSION: &str = "synthi.reload_artifact_set.v1";

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
    /// Recomputable, non-authoritative build-graph role commitment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reload_role: Option<ReloadArtifactRole>,
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
            reload_role: None,
        }
    }

    pub fn with_byte_length(mut self, byte_length: u64) -> Self {
        self.byte_length = Some(byte_length);
        self
    }

    /// Attach a non-authoritative build-graph declaration.
    ///
    /// This method only creates a deterministic commitment. GPU HMR
    /// acceptance must separately verify artifact bytes, every input byte,
    /// producer execution, loader receipts, epoch/dispatch, and output proof.
    pub fn with_reload_role_declaration(
        mut self,
        primary_input_ids: Vec<String>,
        producer_step_hash: String,
        output_ordinal: u32,
        dependency_role_ids: Vec<String>,
        dependency_inputs: Vec<BuildDependencyIdentity>,
    ) -> Result<Self, ArtifactSetIdentityError> {
        let role_id = derive_reload_artifact_role_id(
            &primary_input_ids,
            &producer_step_hash,
            output_ordinal,
        )?;
        let dependency_closure_hash =
            derive_reload_dependency_closure_hash(&dependency_inputs)?;
        self.artifact_id = role_id.clone();
        self.reload_role = Some(ReloadArtifactRole {
            role_id,
            evidence_authority: RELOAD_ARTIFACT_COMMITMENT_AUTHORITY.to_string(),
            primary_input_ids,
            producer_step_hash,
            output_ordinal,
            dependency_role_ids,
            dependency_inputs,
            dependency_closure_hash,
        });
        Ok(self)
    }
}

/// One declared input participating in an artifact dependency closure.
/// Paths are transport locators only; a verifier must independently read and
/// hash the bytes before this declaration can contribute to acceptance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildDependencyIdentity {
    /// Opaque build-graph input identity. It is not a path and carries no
    /// routing semantics.
    pub input_id: String,
    /// Transport/audit locator only. It is excluded from all commitments.
    pub workspace_relative_path: String,
    pub content_hash: String,
}

impl BuildDependencyIdentity {
    pub fn new(
        input_id: impl Into<String>,
        workspace_relative_path: impl Into<String>,
        content_hash: impl Into<String>,
    ) -> Self {
        Self {
            input_id: input_id.into(),
            workspace_relative_path: workspace_relative_path.into(),
            content_hash: content_hash.into(),
        }
    }
}

/// Non-authoritative build-graph commitment for one physical output.
///
/// Role IDs are correlation keys only. Runtime routing must use verified load
/// capabilities and boundary evidence, never the role ID or any input path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReloadArtifactRole {
    pub role_id: String,
    pub evidence_authority: String,
    pub primary_input_ids: Vec<String>,
    /// Canonical identity claimed for the compiler/build-system step. A later
    /// verifier must bind it to observed invocation evidence.
    pub producer_step_hash: String,
    /// Stable output position when one observed step emits multiple artifacts.
    pub output_ordinal: u32,
    #[serde(default)]
    pub dependency_role_ids: Vec<String>,
    pub dependency_inputs: Vec<BuildDependencyIdentity>,
    pub dependency_closure_hash: String,
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
    /// transport metadata and deliberately do not affect the commitment. This
    /// method validates commitment structure only. It cannot authorize GPU HMR
    /// without verifier-owned byte, producer, loader, runtime, and oracle proof.
    pub fn artifact_set_identity(&self) -> Result<String, ArtifactSetIdentityError> {
        let mut artifacts = match &self.artifacts {
            Some(artifacts) => artifacts.clone(),
            None => selected_artifact_identity(&self.artifact_path, &self.artifact_hash)
                .into_iter()
                .collect::<Vec<_>>(),
        };

        let role_count = artifacts
            .iter()
            .filter(|artifact| artifact.reload_role.is_some())
            .count();
        if role_count > 0 {
            if role_count != artifacts.len() {
                return Err(ArtifactSetIdentityError::new(
                    "reload_artifact_set_mixes_strict_and_legacy_records",
                ));
            }
            return self.reload_artifact_set_identity(&artifacts);
        }

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
            if artifact
                .artifact_id
                .starts_with(RELOAD_ARTIFACT_ROLE_ID_PREFIX)
            {
                return Err(ArtifactSetIdentityError::new(
                    "reload_artifact_role_declaration_missing",
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

    /// Recompute only a role-complete reload transaction commitment.
    ///
    /// Callers that require the structured transaction contract must use this
    /// accessor instead of accepting the backward-compatible legacy identity.
    /// This is still a declaration commitment, not runtime proof.
    pub fn reload_transaction_commitment_identity(
        &self,
    ) -> Result<String, ArtifactSetIdentityError> {
        let artifacts = self.artifacts.as_ref().ok_or_else(|| {
            ArtifactSetIdentityError::new("reload_transaction_commitment_is_missing")
        })?;
        if artifacts.is_empty()
            || artifacts
                .iter()
                .any(|artifact| artifact.reload_role.is_none())
        {
            return Err(ArtifactSetIdentityError::new(
                "reload_transaction_commitment_is_missing",
            ));
        }
        self.reload_artifact_set_identity(artifacts)
    }

    fn reload_artifact_set_identity(
        &self,
        reload_artifacts: &[BuildArtifactIdentity],
    ) -> Result<String, ArtifactSetIdentityError> {
        if reload_artifacts.is_empty() {
            return Err(ArtifactSetIdentityError::new(
                "reload_artifact_set_is_empty",
            ));
        }

        let mut role_ids = HashSet::with_capacity(reload_artifacts.len());
        let mut artifact_ids = HashSet::with_capacity(reload_artifacts.len());
        let mut artifact_paths = HashSet::with_capacity(reload_artifacts.len());
        for artifact in reload_artifacts {
            validate_reload_artifact(artifact)?;
            let role = artifact
                .reload_role
                .as_ref()
                .expect("strict-role cardinality validated by caller");
            if !role_ids.insert(role.role_id.as_str()) {
                return Err(ArtifactSetIdentityError::new(
                    "reload_artifact_set_contains_duplicate_role_id",
                ));
            }
            if !artifact_ids.insert(artifact.artifact_id.as_str()) {
                return Err(ArtifactSetIdentityError::new(
                    "reload_artifact_set_contains_duplicate_artifact_id",
                ));
            }
            if !artifact_paths.insert(artifact.artifact_path.as_str()) {
                return Err(ArtifactSetIdentityError::new(
                    "reload_artifact_set_contains_duplicate_artifact_path",
                ));
            }
        }

        let roles_by_id = reload_artifacts
            .iter()
            .map(|artifact| {
                let role = artifact
                    .reload_role
                    .as_ref()
                    .expect("strict-role cardinality validated by caller");
                (role.role_id.as_str(), role)
            })
            .collect::<HashMap<_, _>>();

        for artifact in reload_artifacts {
            let role = artifact
                .reload_role
                .as_ref()
                .expect("strict-role cardinality validated by caller");
            let mut dependencies = HashSet::with_capacity(role.dependency_role_ids.len());
            for dependency in &role.dependency_role_ids {
                if dependency == &role.role_id {
                    return Err(ArtifactSetIdentityError::new(
                        "reload_artifact_role_depends_on_itself",
                    ));
                }
                if !dependencies.insert(dependency.as_str()) {
                    return Err(ArtifactSetIdentityError::new(
                        "reload_artifact_role_contains_duplicate_dependency",
                    ));
                }
                if !role_ids.contains(dependency.as_str()) {
                    return Err(ArtifactSetIdentityError::new(
                        "reload_artifact_role_dependency_is_missing",
                    ));
                }

                let dependency_role = roles_by_id
                    .get(dependency.as_str())
                    .expect("dependency membership validated above");
                let own_closure = role
                    .dependency_inputs
                    .iter()
                    .map(|input| (input.input_id.as_str(), input.content_hash.as_str()))
                    .collect::<HashSet<_>>();
                if dependency_role.dependency_inputs.iter().any(|input| {
                    !own_closure.contains(&(input.input_id.as_str(), input.content_hash.as_str()))
                }) {
                    return Err(ArtifactSetIdentityError::new(
                        "reload_artifact_dependency_closure_is_incomplete",
                    ));
                }
            }
        }
        validate_reload_role_graph_is_acyclic(&roles_by_id)?;

        let mut selected = reload_artifacts.iter().filter(|artifact| {
            artifact.artifact_path == self.artifact_path
                && artifact.artifact_hash == self.artifact_hash
        });
        let selected_role_id = selected
            .next()
            .and_then(|artifact| artifact.reload_role.as_ref())
            .map(|role| role.role_id.clone())
            .ok_or_else(|| {
                ArtifactSetIdentityError::new("reload_artifact_set_selected_artifact_mismatch")
            })?;
        if selected.next().is_some() {
            return Err(ArtifactSetIdentityError::new(
                "reload_artifact_set_selected_artifact_ambiguous",
            ));
        }

        let mut ordered = reload_artifacts.to_vec();
        ordered.sort_by(|left, right| {
            left.reload_role
                .as_ref()
                .map(|role| role.role_id.as_str())
                .cmp(
                    &right
                        .reload_role
                        .as_ref()
                        .map(|role| role.role_id.as_str()),
                )
        });
        let mut hasher = Sha256::new();
        hash_identity_field(&mut hasher, RELOAD_ARTIFACT_SET_SCHEMA_VERSION.as_bytes());
        hash_identity_field(&mut hasher, selected_role_id.as_bytes());
        hasher.update((ordered.len() as u64).to_be_bytes());
        for artifact in ordered {
            let role = artifact
                .reload_role
                .expect("strict-role cardinality validated by caller");
            hash_identity_field(&mut hasher, role.role_id.as_bytes());
            hash_identity_field(&mut hasher, artifact.artifact_id.as_bytes());
            hash_identity_field(&mut hasher, artifact.artifact_hash.as_bytes());
            let mut dependencies = role.dependency_role_ids;
            dependencies.sort();
            hasher.update((dependencies.len() as u64).to_be_bytes());
            for dependency in dependencies {
                hash_identity_field(&mut hasher, dependency.as_bytes());
            }
            hash_identity_field(&mut hasher, role.dependency_closure_hash.as_bytes());
        }

        Ok(format!(
            "{RELOAD_ARTIFACT_SET_ID_PREFIX}{:x}",
            hasher.finalize()
        ))
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

pub fn derive_reload_artifact_role_id(
    primary_input_ids: &[String],
    producer_step_hash: &str,
    output_ordinal: u32,
) -> Result<String, ArtifactSetIdentityError> {
    let mut input_ids = canonical_reload_input_ids(primary_input_ids)?;
    if input_ids.is_empty() {
        return Err(ArtifactSetIdentityError::new(
            "reload_artifact_role_primary_inputs_are_empty",
        ));
    }
    if !is_canonical_sha256(producer_step_hash) {
        return Err(ArtifactSetIdentityError::new(
            "reload_artifact_role_producer_step_hash_is_invalid",
        ));
    }
    input_ids.sort();

    let mut hasher = Sha256::new();
    hash_identity_field(&mut hasher, RELOAD_ARTIFACT_ROLE_SCHEMA_VERSION.as_bytes());
    hash_identity_field(&mut hasher, producer_step_hash.as_bytes());
    hasher.update(output_ordinal.to_be_bytes());
    hasher.update((input_ids.len() as u64).to_be_bytes());
    for input_id in input_ids {
        hash_identity_field(&mut hasher, input_id.as_bytes());
    }
    Ok(format!(
        "{RELOAD_ARTIFACT_ROLE_ID_PREFIX}{:x}",
        hasher.finalize()
    ))
}

pub fn derive_reload_dependency_closure_hash(
    inputs: &[BuildDependencyIdentity],
) -> Result<String, ArtifactSetIdentityError> {
    let mut normalized = inputs
        .iter()
        .map(|input| {
            if input.workspace_relative_path.is_empty()
                || input.workspace_relative_path.contains('\0')
            {
                return Err(ArtifactSetIdentityError::new(
                    "reload_dependency_contains_invalid_transport_locator",
                ));
            }
            if !is_canonical_prefixed_sha256(&input.input_id, RELOAD_ARTIFACT_INPUT_ID_PREFIX) {
                return Err(ArtifactSetIdentityError::new(
                    "reload_dependency_contains_invalid_input_id",
                ));
            }
            if !is_canonical_sha256(&input.content_hash) {
                return Err(ArtifactSetIdentityError::new(
                    "reload_dependency_contains_noncanonical_sha256",
                ));
            }
            Ok((input.input_id.clone(), input.content_hash.clone()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    normalized.sort();
    if normalized
        .windows(2)
        .any(|pair| pair[0].0 == pair[1].0)
    {
        return Err(ArtifactSetIdentityError::new(
            "reload_dependency_contains_duplicate_input_id",
        ));
    }

    let mut hasher = Sha256::new();
    hash_identity_field(
        &mut hasher,
        RELOAD_DEPENDENCY_CLOSURE_SCHEMA_VERSION.as_bytes(),
    );
    hasher.update((normalized.len() as u64).to_be_bytes());
    for (input_id, content_hash) in normalized {
        hash_identity_field(&mut hasher, input_id.as_bytes());
        hash_identity_field(&mut hasher, content_hash.as_bytes());
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn validate_reload_artifact(
    artifact: &BuildArtifactIdentity,
) -> Result<(), ArtifactSetIdentityError> {
    let role = artifact.reload_role.as_ref().ok_or_else(|| {
        ArtifactSetIdentityError::new("reload_artifact_role_evidence_is_missing")
    })?;
    if artifact.artifact_id.trim().is_empty() || artifact.artifact_path.trim().is_empty() {
        return Err(ArtifactSetIdentityError::new(
            "reload_artifact_contains_empty_identity_field",
        ));
    }
    if !is_canonical_sha256(&artifact.artifact_hash) {
        return Err(ArtifactSetIdentityError::new(
            "reload_artifact_contains_noncanonical_sha256",
        ));
    }
    if role.evidence_authority != RELOAD_ARTIFACT_COMMITMENT_AUTHORITY {
        return Err(ArtifactSetIdentityError::new(
            "reload_artifact_role_claims_invalid_evidence_authority",
        ));
    }
    let expected_role_id = derive_reload_artifact_role_id(
        &role.primary_input_ids,
        &role.producer_step_hash,
        role.output_ordinal,
    )?;
    if role.role_id != expected_role_id {
        return Err(ArtifactSetIdentityError::new(
            "reload_artifact_role_id_mismatch",
        ));
    }
    if artifact.artifact_id != role.role_id {
        return Err(ArtifactSetIdentityError::new(
            "reload_artifact_identity_is_not_role_bound",
        ));
    }
    let expected_closure_hash =
        derive_reload_dependency_closure_hash(&role.dependency_inputs)?;
    if role.dependency_closure_hash != expected_closure_hash {
        return Err(ArtifactSetIdentityError::new(
            "reload_artifact_dependency_closure_hash_mismatch",
        ));
    }

    let primary_input_ids = canonical_reload_input_ids(&role.primary_input_ids)?;
    let dependency_input_ids = role
        .dependency_inputs
        .iter()
        .map(|input| input.input_id.as_str())
        .collect::<HashSet<_>>();
    if primary_input_ids
        .iter()
        .any(|input_id| !dependency_input_ids.contains(input_id.as_str()))
    {
        return Err(ArtifactSetIdentityError::new(
            "reload_artifact_primary_input_missing_from_dependency_closure",
        ));
    }
    Ok(())
}

fn validate_reload_role_graph_is_acyclic(
    roles_by_id: &HashMap<&str, &ReloadArtifactRole>,
) -> Result<(), ArtifactSetIdentityError> {
    let mut remaining_dependencies = HashMap::with_capacity(roles_by_id.len());
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
    for (role_id, role) in roles_by_id {
        remaining_dependencies.insert(*role_id, role.dependency_role_ids.len());
        for dependency in &role.dependency_role_ids {
            dependents
                .entry(dependency.as_str())
                .or_default()
                .push(*role_id);
        }
    }

    let mut ready = remaining_dependencies
        .iter()
        .filter_map(|(role_id, count)| (*count == 0).then_some(*role_id))
        .collect::<Vec<_>>();
    let mut visited = 0usize;
    while let Some(role_id) = ready.pop() {
        visited += 1;
        for dependent in dependents.get(role_id).into_iter().flatten() {
            let remaining = remaining_dependencies
                .get_mut(dependent)
                .expect("dependent role must belong to the validated transaction");
            *remaining -= 1;
            if *remaining == 0 {
                ready.push(*dependent);
            }
        }
    }

    if visited != roles_by_id.len() {
        return Err(ArtifactSetIdentityError::new(
            "reload_artifact_dependency_graph_contains_cycle",
        ));
    }
    Ok(())
}

fn canonical_reload_input_ids(
    input_ids: &[String],
) -> Result<Vec<String>, ArtifactSetIdentityError> {
    let mut canonical = Vec::with_capacity(input_ids.len());
    let mut unique = HashSet::with_capacity(input_ids.len());
    for input_id in input_ids {
        if !is_canonical_prefixed_sha256(input_id, RELOAD_ARTIFACT_INPUT_ID_PREFIX) {
            return Err(ArtifactSetIdentityError::new(
                "reload_artifact_primary_input_id_is_invalid",
            ));
        }
        if !unique.insert(input_id.clone()) {
            return Err(ArtifactSetIdentityError::new(
                "reload_artifact_contains_duplicate_primary_input_id",
            ));
        }
        canonical.push(input_id.clone());
    }
    Ok(canonical)
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
    is_canonical_prefixed_sha256(value, "sha256:")
}

fn is_canonical_prefixed_sha256(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|hex| {
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
    const HASH_D: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const INPUT_A: &str =
        "artifact-input:sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const INPUT_B: &str =
        "artifact-input:sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const INPUT_C: &str =
        "artifact-input:sha256:3333333333333333333333333333333333333333333333333333333333333333";
    const INPUT_D: &str =
        "artifact-input:sha256:4444444444444444444444444444444444444444444444444444444444444444";

    fn dependency(input_id: &str, path: &str, hash: &str) -> BuildDependencyIdentity {
        BuildDependencyIdentity::new(input_id, path, hash)
    }

    fn reload_artifact(
        artifact_path: &str,
        artifact_hash: &str,
        primary_input_ids: &[&str],
        producer_step_hash: &str,
        output_ordinal: u32,
        dependency_role_ids: Vec<String>,
        dependency_inputs: Vec<BuildDependencyIdentity>,
    ) -> BuildArtifactIdentity {
        BuildArtifactIdentity::new("discarded-caller-label", artifact_path, artifact_hash)
            .with_reload_role_declaration(
                primary_input_ids
                    .iter()
                    .map(|input_id| input_id.to_string())
                    .collect(),
                producer_step_hash.to_string(),
                output_ordinal,
                dependency_role_ids,
                dependency_inputs,
            )
            .unwrap()
    }

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
        assert_eq!(
            de.reload_transaction_commitment_identity()
                .unwrap_err()
                .to_string(),
            "reload_transaction_commitment_is_missing"
        );
    }

    #[test]
    fn reload_role_identity_uses_opaque_primary_input_ids_only() {
        let first = derive_reload_artifact_role_id(
            &[INPUT_A.to_string(), INPUT_B.to_string()],
            HASH_A,
            0,
        )
        .unwrap();
        let reordered = derive_reload_artifact_role_id(
            &[INPUT_B.to_string(), INPUT_A.to_string()],
            HASH_A,
            0,
        )
        .unwrap();

        assert_eq!(first, reordered);
        assert!(first.starts_with(RELOAD_ARTIFACT_ROLE_ID_PREFIX));
        assert_eq!(first.len(), RELOAD_ARTIFACT_ROLE_ID_PREFIX.len() + 64);
        assert_ne!(
            first,
            derive_reload_artifact_role_id(
                &[INPUT_A.to_string(), INPUT_B.to_string()],
                HASH_B,
                0,
            )
            .unwrap()
        );
        assert_ne!(
            first,
            derive_reload_artifact_role_id(
                &[INPUT_A.to_string(), INPUT_B.to_string()],
                HASH_A,
                1,
            )
            .unwrap()
        );
    }

    #[test]
    fn reload_dependency_commitment_ignores_transport_locators() {
        let original = vec![
            dependency(INPUT_A, "source/first.input", HASH_A),
            dependency(INPUT_B, "source/second.input", HASH_B),
        ];
        let relocated = vec![
            dependency(INPUT_B, "cache/b", HASH_B),
            dependency(INPUT_A, "cache/a", HASH_A),
        ];

        assert_eq!(
            derive_reload_dependency_closure_hash(&original).unwrap(),
            derive_reload_dependency_closure_hash(&relocated).unwrap()
        );
    }

    #[test]
    fn reload_role_declarations_reject_noncanonical_identities() {
        assert_eq!(
            derive_reload_artifact_role_id(&[], HASH_A, 0)
                .unwrap_err()
                .to_string(),
            "reload_artifact_role_primary_inputs_are_empty"
        );
        assert_eq!(
            derive_reload_artifact_role_id(&["source/file.cpp".into()], HASH_A, 0)
                .unwrap_err()
                .to_string(),
            "reload_artifact_primary_input_id_is_invalid"
        );
        assert_eq!(
            derive_reload_artifact_role_id(&[INPUT_A.into()], "compiler-step", 0)
                .unwrap_err()
                .to_string(),
            "reload_artifact_role_producer_step_hash_is_invalid"
        );
    }

    #[test]
    fn reload_transaction_commitment_binds_every_opaque_role_and_dependency_closure() {
        let first = reload_artifact(
            "/build/first.bin",
            HASH_A,
            &[INPUT_A],
            HASH_A,
            0,
            Vec::new(),
            vec![dependency(INPUT_A, "units/first.input", HASH_A)],
        );
        let second = reload_artifact(
            "/build/second.bin",
            HASH_B,
            &[INPUT_B],
            HASH_B,
            0,
            vec![first.reload_role.as_ref().unwrap().role_id.clone()],
            vec![
                dependency(INPUT_B, "units/second.input", HASH_B),
                dependency(INPUT_A, "units/first.input", HASH_A),
            ],
        );
        let third = reload_artifact(
            "/build/third.bin",
            HASH_C,
            &[INPUT_C],
            HASH_C,
            0,
            vec![second.reload_role.as_ref().unwrap().role_id.clone()],
            vec![
                dependency(INPUT_C, "units/third.input", HASH_C),
                dependency(INPUT_B, "units/second.input", HASH_B),
                dependency(INPUT_A, "units/first.input", HASH_A),
            ],
        );
        let base = BuildManifest::new(
            "p",
            "metadata-only-label",
            "metadata-only-label",
            0,
            BuildSlot::Full,
            "/build/first.bin",
            HASH_A,
        )
        .with_artifacts(vec![first.clone(), second.clone(), third.clone()]);
        assert!(base
            .artifact_set_identity()
            .unwrap()
            .starts_with(RELOAD_ARTIFACT_SET_ID_PREFIX));
        assert_eq!(
            base.artifact_set_identity().unwrap(),
            base.reload_transaction_commitment_identity().unwrap()
        );

        let mut relocated_entries = vec![third.clone(), second.clone(), first.clone()];
        relocated_entries[0].artifact_path = "/cache/third.bin".into();
        relocated_entries[1].artifact_path = "/cache/second.bin".into();
        relocated_entries[2].artifact_path = "/cache/first.bin".into();
        let relocated = BuildManifest::new(
            "p",
            "another-metadata-label",
            "another-metadata-label",
            0,
            BuildSlot::Custom("another-metadata-label".into()),
            "/cache/first.bin",
            HASH_A,
        )
        .with_artifacts(relocated_entries);
        assert_eq!(
            base.artifact_set_identity().unwrap(),
            relocated.artifact_set_identity().unwrap()
        );

        let mut changed_output = base.clone();
        changed_output.artifacts.as_mut().unwrap()[1].artifact_hash = HASH_D.into();
        assert_eq!(
            changed_output.artifacts.as_ref().unwrap()[1]
                .reload_role
                .as_ref()
                .unwrap()
                .role_id,
            second.reload_role.as_ref().unwrap().role_id
        );
        assert_ne!(
            base.artifact_set_identity().unwrap(),
            changed_output.artifact_set_identity().unwrap()
        );

        let mut changed_dependency = base.clone();
        let changed_role = changed_dependency.artifacts.as_mut().unwrap()[2]
            .reload_role
            .as_mut()
            .unwrap();
        changed_role.dependency_inputs[0].content_hash = HASH_D.into();
        changed_role.dependency_closure_hash =
            derive_reload_dependency_closure_hash(&changed_role.dependency_inputs).unwrap();
        assert_eq!(
            changed_role.role_id,
            third.reload_role.as_ref().unwrap().role_id
        );
        assert_ne!(
            base.artifact_set_identity().unwrap(),
            changed_dependency.artifact_set_identity().unwrap()
        );
    }

    #[test]
    fn reload_transaction_commitment_recomputes_roles_and_closures_fail_closed() {
        let first = reload_artifact(
            "/build/first.bin",
            HASH_A,
            &[INPUT_A],
            HASH_A,
            0,
            Vec::new(),
            vec![dependency(INPUT_A, "units/first.input", HASH_A)],
        );
        let second = reload_artifact(
            "/build/second.bin",
            HASH_B,
            &[INPUT_B],
            HASH_B,
            0,
            vec![first.reload_role.as_ref().unwrap().role_id.clone()],
            vec![
                dependency(INPUT_B, "units/second.input", HASH_B),
                dependency(INPUT_A, "units/first.input", HASH_A),
            ],
        );
        let manifest = BuildManifest::new(
            "p",
            "metadata-only-label",
            "metadata-only-label",
            0,
            BuildSlot::Full,
            "/build/first.bin",
            HASH_A,
        )
        .with_artifacts(vec![first, second]);

        let mut forged_role = manifest.clone();
        forged_role.artifacts.as_mut().unwrap()[1]
            .reload_role
            .as_mut()
            .unwrap()
            .role_id = format!("{RELOAD_ARTIFACT_ROLE_ID_PREFIX}{}", "f".repeat(64));
        assert_eq!(
            forged_role.artifact_set_identity().unwrap_err().to_string(),
            "reload_artifact_role_id_mismatch"
        );

        let mut forged_closure = manifest.clone();
        forged_closure.artifacts.as_mut().unwrap()[1]
            .reload_role
            .as_mut()
            .unwrap()
            .dependency_closure_hash = HASH_D.into();
        assert_eq!(
            forged_closure
                .artifact_set_identity()
                .unwrap_err()
                .to_string(),
            "reload_artifact_dependency_closure_hash_mismatch"
        );

        let mut missing_role = manifest.clone();
        missing_role.artifacts.as_mut().unwrap()[1]
            .reload_role
            .as_mut()
            .unwrap()
            .dependency_role_ids = vec![format!(
            "{RELOAD_ARTIFACT_ROLE_ID_PREFIX}{}",
            "e".repeat(64)
        )];
        assert_eq!(
            missing_role
                .artifact_set_identity()
                .unwrap_err()
                .to_string(),
            "reload_artifact_role_dependency_is_missing"
        );

        let mut missing_primary_bytes = manifest;
        missing_primary_bytes.artifacts.as_mut().unwrap()[1]
            .reload_role
            .as_mut()
            .unwrap()
            .dependency_inputs = vec![dependency(INPUT_D, "include/other.input", HASH_B)];
        let role = missing_primary_bytes.artifacts.as_mut().unwrap()[1]
            .reload_role
            .as_mut()
            .unwrap();
        role.dependency_closure_hash =
            derive_reload_dependency_closure_hash(&role.dependency_inputs).unwrap();
        assert_eq!(
            missing_primary_bytes
                .artifact_set_identity()
                .unwrap_err()
                .to_string(),
            "reload_artifact_primary_input_missing_from_dependency_closure"
        );
    }

    #[test]
    fn reload_transaction_rejects_incomplete_or_cyclic_role_graphs() {
        let first = reload_artifact(
            "/build/first.bin",
            HASH_A,
            &[INPUT_A],
            HASH_A,
            0,
            Vec::new(),
            vec![dependency(INPUT_A, "units/first.input", HASH_A)],
        );
        let second = reload_artifact(
            "/build/second.bin",
            HASH_B,
            &[INPUT_B],
            HASH_B,
            0,
            vec![first.reload_role.as_ref().unwrap().role_id.clone()],
            vec![
                dependency(INPUT_B, "units/second.input", HASH_B),
                dependency(INPUT_A, "units/first.input", HASH_A),
            ],
        );
        let manifest = BuildManifest::new(
            "p",
            "metadata-only-label",
            "metadata-only-label",
            0,
            BuildSlot::Full,
            "/build/first.bin",
            HASH_A,
        )
        .with_artifacts(vec![first, second]);

        let mut incomplete = manifest.clone();
        let incomplete_role = incomplete.artifacts.as_mut().unwrap()[1]
            .reload_role
            .as_mut()
            .unwrap();
        incomplete_role
            .dependency_inputs
            .retain(|input| input.input_id == INPUT_B);
        incomplete_role.dependency_closure_hash =
            derive_reload_dependency_closure_hash(&incomplete_role.dependency_inputs).unwrap();
        assert_eq!(
            incomplete.artifact_set_identity().unwrap_err().to_string(),
            "reload_artifact_dependency_closure_is_incomplete"
        );

        let mut cyclic = manifest;
        let second_role_id = cyclic.artifacts.as_ref().unwrap()[1]
            .reload_role
            .as_ref()
            .unwrap()
            .role_id
            .clone();
        let first_role = cyclic.artifacts.as_mut().unwrap()[0]
            .reload_role
            .as_mut()
            .unwrap();
        first_role.dependency_role_ids = vec![second_role_id];
        first_role
            .dependency_inputs
            .push(dependency(INPUT_B, "units/second.input", HASH_B));
        first_role.dependency_closure_hash =
            derive_reload_dependency_closure_hash(&first_role.dependency_inputs).unwrap();
        assert_eq!(
            cyclic.artifact_set_identity().unwrap_err().to_string(),
            "reload_artifact_dependency_graph_contains_cycle"
        );
    }

    #[test]
    fn reload_transaction_commitments_cannot_self_upgrade_or_downgrade() {
        let first = reload_artifact(
            "/build/first.bin",
            HASH_A,
            &[INPUT_A],
            HASH_A,
            0,
            Vec::new(),
            vec![dependency(INPUT_A, "units/first.input", HASH_A)],
        );
        let second = reload_artifact(
            "/build/second.bin",
            HASH_B,
            &[INPUT_B],
            HASH_B,
            0,
            vec![first.reload_role.as_ref().unwrap().role_id.clone()],
            vec![
                dependency(INPUT_B, "units/second.input", HASH_B),
                dependency(INPUT_A, "units/first.input", HASH_A),
            ],
        );
        let manifest = BuildManifest::new(
            "p",
            "metadata-only-label",
            "metadata-only-label",
            0,
            BuildSlot::Full,
            "/build/first.bin",
            HASH_A,
        )
        .with_artifacts(vec![first, second]);

        let mut forged_authority = manifest.clone();
        forged_authority.artifacts.as_mut().unwrap()[0]
            .reload_role
            .as_mut()
            .unwrap()
            .evidence_authority = "gpu_hmr_success".into();
        assert_eq!(
            forged_authority
                .artifact_set_identity()
                .unwrap_err()
                .to_string(),
            "reload_artifact_role_claims_invalid_evidence_authority"
        );

        let mut mixed = manifest.clone();
        mixed.artifacts.as_mut().unwrap()[1].reload_role = None;
        assert_eq!(
            mixed.artifact_set_identity().unwrap_err().to_string(),
            "reload_artifact_set_mixes_strict_and_legacy_records"
        );

        let mut stripped = manifest.clone();
        for artifact in stripped.artifacts.as_mut().unwrap() {
            artifact.reload_role = None;
        }
        assert_eq!(
            stripped.artifact_set_identity().unwrap_err().to_string(),
            "reload_artifact_role_declaration_missing"
        );

        for (index, artifact) in stripped.artifacts.as_mut().unwrap().iter_mut().enumerate() {
            artifact.artifact_id = format!("legacy-output-{index}");
        }
        let downgraded_identity = stripped.artifact_set_identity().unwrap();
        assert!(downgraded_identity.starts_with("artifact-set:sha256:"));
        assert!(!downgraded_identity.starts_with(RELOAD_ARTIFACT_SET_ID_PREFIX));
        assert_eq!(
            stripped
                .reload_transaction_commitment_identity()
                .unwrap_err()
                .to_string(),
            "reload_transaction_commitment_is_missing"
        );
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
