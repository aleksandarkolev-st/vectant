// ============================================================
// BUILD ARTIFACT MANIFEST
// ============================================================
// The manifest is the missing source of truth between compile
// and reload. Each build produces a manifest; the planner
// consumes it to make deterministic reload decisions.
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
        Self {
            preview_id: preview_id.into(),
            language: language.into(),
            adapter_family: adapter_family.into(),
            capability_tier,
            slot,
            artifact_path: artifact_path.into(),
            artifact_hash: artifact_hash.into(),
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_serde_roundtrip() {
        let mut m = BuildManifest::new(
            "p1", "cpp", "dynamic_library", 3,
            BuildSlot::Gui, "/tmp/gui.so", "abc123",
        );
        m.build_time_ms = 150;
        m.exported_symbols = vec!["on_render".into(), "on_update".into()];
        m.snapshot_modes = vec![SnapshotMode::Binary, SnapshotMode::Json];

        let json = serde_json::to_string(&m).unwrap();
        let de: BuildManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(de.preview_id, "p1");
        assert_eq!(de.capability_tier, 3);
        assert_eq!(de.exported_symbols.len(), 2);
        assert_eq!(de.snapshot_modes.len(), 2);
    }

    #[test]
    fn manifest_minimal() {
        let m = BuildManifest::new(
            "p2", "java", "managed_runtime", 2,
            BuildSlot::Full, "/tmp/app.jar", "def456",
        );
        assert_eq!(m.healthcheck_strategy, HealthcheckStrategy::None);
        assert_eq!(m.preview_preservation_mode, PreviewPreservationMode::Restart);
    }
}
