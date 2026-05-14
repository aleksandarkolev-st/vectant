// ============================================================
// STATE RESTORE VALIDATOR
// ============================================================
// Validates that a state snapshot can be safely restored into
// the target module.  Checks schema compatibility, ABI match,
// field invariants, and size constraints before committing
// the restore.
// ============================================================


use serde::{Deserialize, Serialize};

use crate::hmr::state_manager::SchemaVersion;
use crate::hmr::state_snapshot::StateSnapshot;

/// Restore validation verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum RestoreVerdict {
    /// Safe to restore as-is.
    Safe,
    /// Restorable with migration (schema changed but compatible).
    NeedsMigration,
    /// Restorable but some fields will be lost.
    PartialRestore { lost_fields: Vec<String> },
    /// Cannot restore — state is incompatible.
    Incompatible { reasons: Vec<String> },
}

/// Context about the target module for validation.
#[derive(Debug, Clone)]
pub struct RestoreTarget {
    pub module_id: String,
    pub schema_version: SchemaVersion,
    pub abi_version: u32,
    pub source_hash: u64,
    /// Expected required fields in the state.
    pub required_fields: Vec<String>,
    /// Maximum state size the module can accept.
    pub max_state_bytes: usize,
    /// Layout hash of the target state type (if known).
    pub layout_hash: Option<u64>,
}

/// Detailed validation report.
#[derive(Debug, Clone)]
pub struct RestoreValidation {
    pub verdict: RestoreVerdict,
    pub snapshot_id: u64,
    pub schema_match: bool,
    pub abi_match: bool,
    pub layout_match: Option<bool>,
    pub missing_required_fields: Vec<String>,
    pub extra_fields: Vec<String>,
    pub size_ok: bool,
    pub warnings: Vec<String>,
}

/// Validate whether a snapshot can be restored to the target module.
pub fn validate_restore(
    snapshot: &StateSnapshot,
    target: &RestoreTarget,
) -> RestoreValidation {
    let mut reasons = Vec::new();
    let mut warnings = Vec::new();

    // Schema version check
    let schema_match = snapshot.schema_version == target.schema_version;
    let schema_compatible = snapshot.schema_version.can_upgrade_to(&target.schema_version);
    if !schema_match && !schema_compatible {
        reasons.push(format!(
            "schema {} incompatible with target {}",
            snapshot.schema_version, target.schema_version
        ));
    }

    // ABI check
    let abi_match = snapshot.abi_version == target.abi_version;
    if !abi_match {
        reasons.push(format!(
            "ABI version {} != target {}",
            snapshot.abi_version, target.abi_version
        ));
    }

    // Layout hash check
    let layout_match = match (snapshot.layout_hash, target.layout_hash) {
        (Some(a), Some(b)) => {
            if a != b {
                reasons.push("layout hash mismatch".into());
            }
            Some(a == b)
        }
        _ => None,
    };

    // Required fields check
    let snapshot_fields: std::collections::HashSet<String> =
        snapshot.field_checksums.keys().cloned().collect();
    let missing: Vec<String> = target
        .required_fields
        .iter()
        .filter(|f| !snapshot_fields.contains(*f))
        .cloned()
        .collect();
    if !missing.is_empty() {
        warnings.push(format!("missing required fields: {:?}", missing));
    }

    // Extra fields
    let target_fields: std::collections::HashSet<String> =
        target.required_fields.iter().cloned().collect();
    let extra: Vec<String> = snapshot_fields
        .iter()
        .filter(|f| !target_fields.contains(*f) && !target.required_fields.is_empty())
        .cloned()
        .collect();

    // Size check
    let payload_bytes = snapshot.payload.to_string().len();
    let size_ok = payload_bytes <= target.max_state_bytes;
    if !size_ok {
        reasons.push(format!(
            "payload {} bytes exceeds target limit {}",
            payload_bytes, target.max_state_bytes
        ));
    }

    // Determine verdict
    let verdict = if !reasons.is_empty() {
        RestoreVerdict::Incompatible { reasons: reasons.clone() }
    } else if !missing.is_empty() {
        RestoreVerdict::PartialRestore {
            lost_fields: missing.clone(),
        }
    } else if !schema_match && schema_compatible {
        RestoreVerdict::NeedsMigration
    } else {
        RestoreVerdict::Safe
    };

    RestoreValidation {
        verdict,
        snapshot_id: snapshot.snapshot_id,
        schema_match,
        abi_match,
        layout_match,
        missing_required_fields: missing,
        extra_fields: extra,
        size_ok,
        warnings,
    }
}

#[cfg(all(test, feature = "legacy_hmr_tests"))]
mod tests {
    use super::*;

    fn snap(schema: SchemaVersion, abi: u32) -> StateSnapshot {
        StateSnapshot {
            snapshot_id: 1,
            module_id: "test".into(),
            schema_version: schema,
            abi_version: abi,
            source_hash: 0,
            captured_at_ms: 0,
            payload: serde_json::json!({"counter": 42}),
            field_checksums: {
                let mut m = HashMap::new();
                m.insert("counter".into(), 0x1234);
                m
            },
            layout_hash: None,
            reason: crate::hmr::state_snapshot::SnapshotReason::PreReload,
        }
    }

    fn target(schema: SchemaVersion, abi: u32) -> RestoreTarget {
        RestoreTarget {
            module_id: "test".into(),
            schema_version: schema,
            abi_version: abi,
            source_hash: 0,
            required_fields: vec!["counter".into()],
            max_state_bytes: 1024 * 1024,
            layout_hash: None,
        }
    }

    #[test]
    fn safe_restore() {
        let v = SchemaVersion::new(1, 0, 0);
        let result = validate_restore(&snap(v, 1), &target(v, 1));
        assert_eq!(result.verdict, RestoreVerdict::Safe);
    }

    #[test]
    fn needs_migration() {
        let result = validate_restore(
            &snap(SchemaVersion::new(1, 0, 0), 1),
            &target(SchemaVersion::new(1, 1, 0), 1),
        );
        assert_eq!(result.verdict, RestoreVerdict::NeedsMigration);
    }

    #[test]
    fn incompatible_abi() {
        let v = SchemaVersion::new(1, 0, 0);
        let result = validate_restore(&snap(v, 1), &target(v, 2));
        assert!(matches!(result.verdict, RestoreVerdict::Incompatible { .. }));
    }
}
