// ============================================================
// STATE RESTORE ORCHESTRATOR
// ============================================================
// Coordinates the full restore pipeline: choose snapshot →
// validate → migrate (if needed) → apply.  Single entry point
// for the reload protocol to call.
// ============================================================

use crate::hmr::state_migration::MigrationRegistry;
use crate::hmr::state_manager::SchemaVersion;
use crate::hmr::state_restore_validator::{validate_restore, RestoreTarget, RestoreVerdict};
use crate::hmr::state_snapshot::StateSnapshot;

/// Restore strategy decided by the orchestrator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreStrategy {
    /// Apply snapshot directly (no migration).
    Direct,
    /// Apply snapshot then run migration path.
    Migrate { steps: usize },
    /// Discard state — too incompatible.
    Discard { reason: String },
}

/// Full restore outcome.
#[derive(Debug, Clone)]
pub struct RestoreOutcome {
    pub strategy: RestoreStrategy,
    pub snapshot_id: u64,
    pub final_state: Option<serde_json::Value>,
    pub warnings: Vec<String>,
}

/// Orchestrate state restoration for a module.
pub fn orchestrate_restore(
    snapshot: &StateSnapshot,
    target: &RestoreTarget,
    migration_registry: &MigrationRegistry,
) -> RestoreOutcome {
    // Step 1: Validate
    let validation = validate_restore(snapshot, target);

    match validation.verdict {
        RestoreVerdict::Safe => {
            // Direct restore
            RestoreOutcome {
                strategy: RestoreStrategy::Direct,
                snapshot_id: snapshot.snapshot_id,
                final_state: Some(snapshot.payload.clone()),
                warnings: validation.warnings,
            }
        }

        RestoreVerdict::NeedsMigration => {
            // Try to find migration path
            match migration_registry.find_path(snapshot.schema_version, target.schema_version) {
                Ok(path) => {
                    let steps = path.steps.len();
                    match migration_registry.apply_path(&snapshot.payload, &path) {
                        Ok(migrated) => RestoreOutcome {
                            strategy: RestoreStrategy::Migrate { steps },
                            snapshot_id: snapshot.snapshot_id,
                            final_state: Some(migrated),
                            warnings: validation.warnings,
                        },
                        Err(e) => RestoreOutcome {
                            strategy: RestoreStrategy::Discard {
                                reason: format!("migration failed: {}", e),
                            },
                            snapshot_id: snapshot.snapshot_id,
                            final_state: None,
                            warnings: validation.warnings,
                        },
                    }
                }
                Err(e) => RestoreOutcome {
                    strategy: RestoreStrategy::Discard {
                        reason: format!("no migration path: {}", e),
                    },
                    snapshot_id: snapshot.snapshot_id,
                    final_state: None,
                    warnings: validation.warnings,
                },
            }
        }

        RestoreVerdict::PartialRestore { lost_fields } => {
            let mut warnings = validation.warnings;
            warnings.push(format!("partial restore, lost fields: {:?}", lost_fields));

            RestoreOutcome {
                strategy: RestoreStrategy::Direct,
                snapshot_id: snapshot.snapshot_id,
                final_state: Some(snapshot.payload.clone()),
                warnings,
            }
        }

        RestoreVerdict::Incompatible { reasons } => RestoreOutcome {
            strategy: RestoreStrategy::Discard {
                reason: reasons.join("; "),
            },
            snapshot_id: snapshot.snapshot_id,
            final_state: None,
            warnings: validation.warnings,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::state_snapshot::SnapshotReason;
    use std::collections::HashMap;

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
            reason: SnapshotReason::PreReload,
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
    fn direct_restore() {
        let v = SchemaVersion::new(1, 0, 0);
        let reg = MigrationRegistry::new();
        let outcome = orchestrate_restore(&snap(v, 1), &target(v, 1), &reg);
        assert_eq!(outcome.strategy, RestoreStrategy::Direct);
        assert!(outcome.final_state.is_some());
    }

    #[test]
    fn incompatible_discard() {
        let reg = MigrationRegistry::new();
        let outcome = orchestrate_restore(
            &snap(SchemaVersion::new(1, 0, 0), 1),
            &target(SchemaVersion::new(1, 0, 0), 2),
            &reg,
        );
        assert!(matches!(outcome.strategy, RestoreStrategy::Discard { .. }));
    }
}
