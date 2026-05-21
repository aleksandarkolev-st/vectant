// ============================================================
// ABI CHANGE DETECTION
// ============================================================
// Heuristics for determining whether the ABI (Application Binary
// Interface) changed between two builds. Used by the planner to
// decide whether a warm reload is safe.
// ============================================================

use serde::{Deserialize, Serialize};

use crate::hmr::build_manifest::BuildManifest;

/// How the ABI comparison was determined.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AbiChangeSource {
    /// Compared explicit abi_version strings.
    VersionString,
    /// Compared exported symbol lists.
    SymbolDiff,
    /// Compared state schema hashes.
    SchemaHash,
    /// No previous manifest to compare against.
    NoPrevious,
}

/// Result of ABI change detection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbiChangeResult {
    pub abi_changed: bool,
    pub schema_changed: bool,
    pub source: AbiChangeSource,
    /// Symbols added in the new build.
    pub added_symbols: Vec<String>,
    /// Symbols removed from the new build.
    pub removed_symbols: Vec<String>,
}

/// Detect ABI changes between a previous and current build.
pub fn detect_abi_changes(
    prev: Option<&BuildManifest>,
    current: &BuildManifest,
) -> AbiChangeResult {
    let Some(prev) = prev else {
        return AbiChangeResult {
            abi_changed: false,
            schema_changed: false,
            source: AbiChangeSource::NoPrevious,
            added_symbols: vec![],
            removed_symbols: vec![],
        };
    };

    // 1. Compare abi_version strings
    let abi_changed = prev.abi_version != current.abi_version;

    // 2. Compare state schema hashes
    let schema_changed = prev.state_schema_hash != current.state_schema_hash;

    // 3. Compute symbol diff
    let prev_syms: std::collections::HashSet<&str> =
        prev.exported_symbols.iter().map(|s| s.as_str()).collect();
    let curr_syms: std::collections::HashSet<&str> = current
        .exported_symbols
        .iter()
        .map(|s| s.as_str())
        .collect();

    let added: Vec<String> = curr_syms
        .difference(&prev_syms)
        .map(|s| s.to_string())
        .collect();
    let removed: Vec<String> = prev_syms
        .difference(&curr_syms)
        .map(|s| s.to_string())
        .collect();

    // If abi_version didn't change but symbols did, that's also an ABI break
    let abi_from_symbols = !added.is_empty() || !removed.is_empty();

    AbiChangeResult {
        abi_changed: abi_changed || abi_from_symbols,
        schema_changed,
        source: if abi_changed {
            AbiChangeSource::VersionString
        } else if abi_from_symbols {
            AbiChangeSource::SymbolDiff
        } else if schema_changed {
            AbiChangeSource::SchemaHash
        } else {
            AbiChangeSource::VersionString
        },
        added_symbols: added,
        removed_symbols: removed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::build_manifest::{BuildSlot, HealthcheckStrategy, PreviewPreservationMode};

    fn make(abi: &str, schema: &str, symbols: Vec<&str>) -> BuildManifest {
        BuildManifest {
            preview_id: "p1".into(),
            language: "rust".into(),
            adapter_family: "DynamicLibrary".into(),
            capability_tier: 2,
            slot: BuildSlot::Core,
            artifact_path: "/tmp/t.so".into(),
            artifact_hash: "h".into(),
            toolchain_fingerprint: String::new(),
            abi_version: abi.into(),
            state_schema_hash: schema.into(),
            snapshot_modes: vec![],
            capabilities: vec![],
            preview_preservation_mode: PreviewPreservationMode::Restart,
            dirty_unit_source: None,
            exported_symbols: symbols.into_iter().map(|s| s.into()).collect(),
            dependencies: vec![],
            healthcheck_strategy: HealthcheckStrategy::SymbolCheck,
            rollout_flags: Default::default(),
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

    #[test]
    fn no_previous() {
        let current = make("1.0", "s1", vec!["init"]);
        let result = detect_abi_changes(None, &current);
        assert!(!result.abi_changed);
        assert!(!result.schema_changed);
    }

    #[test]
    fn same_abi() {
        let prev = make("1.0", "s1", vec!["init", "update"]);
        let curr = make("1.0", "s1", vec!["init", "update"]);
        let result = detect_abi_changes(Some(&prev), &curr);
        assert!(!result.abi_changed);
        assert!(!result.schema_changed);
    }

    #[test]
    fn abi_version_changed() {
        let prev = make("1.0", "s1", vec!["init"]);
        let curr = make("2.0", "s1", vec!["init"]);
        let result = detect_abi_changes(Some(&prev), &curr);
        assert!(result.abi_changed);
        assert!(!result.schema_changed);
    }

    #[test]
    fn schema_changed() {
        let prev = make("1.0", "s1", vec!["init"]);
        let curr = make("1.0", "s2", vec!["init"]);
        let result = detect_abi_changes(Some(&prev), &curr);
        assert!(!result.abi_changed);
        assert!(result.schema_changed);
    }

    #[test]
    fn symbol_removed() {
        let prev = make("1.0", "s1", vec!["init", "old_fn"]);
        let curr = make("1.0", "s1", vec!["init"]);
        let result = detect_abi_changes(Some(&prev), &curr);
        assert!(result.abi_changed);
        assert_eq!(result.removed_symbols, vec!["old_fn"]);
    }

    #[test]
    fn symbol_added() {
        let prev = make("1.0", "s1", vec!["init"]);
        let curr = make("1.0", "s1", vec!["init", "new_fn"]);
        let result = detect_abi_changes(Some(&prev), &curr);
        assert!(result.abi_changed);
        assert_eq!(result.added_symbols, vec!["new_fn"]);
    }
}
