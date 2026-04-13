// ============================================================
// WAVE 08 INTEGRATION TESTS
// ============================================================
// End-to-end scenarios for state hardening pipeline:
// snapshot → serialize → validate → migrate → restore.
// ============================================================


#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::hmr::state_checkpoint::{CheckpointManager, CheckpointPolicy, CheckpointResult};
    use crate::hmr::state_manager::SchemaVersion;
    use crate::hmr::state_migration::{FieldChange, MigrationRegistry, MigrationStep};
    use crate::hmr::state_restore_orchestrator::{orchestrate_restore, RestoreStrategy};
    use crate::hmr::state_restore_validator::{RestoreTarget, RestoreVerdict};
    use crate::hmr::state_serializer::{deserialize_state, serialize_state, SerializerConfig};
    use crate::hmr::state_size_limiter::{GlobalSizeLimits, SizeCheckResult, StateSizeLimiter};
    use crate::hmr::state_snapshot::{SnapshotReason, StateSnapshot};

    // ── Scenario 1: Full capture → serialize → restore cycle ────

    #[test]
    fn scenario_full_checkpoint_restore() {
        let mut mgr = CheckpointManager::new(CheckpointPolicy::default());
        let state = serde_json::json!({"counter": 42, "name": "test"});
        let v1 = SchemaVersion::new(1, 0, 0);

        // Capture
        let result = mgr.capture("mod_a", &state, v1, 1, 0xdead, 1000, SnapshotReason::PreReload);
        assert!(matches!(result, CheckpointResult::Captured { .. }));

        // Retrieve
        let snap = mgr.latest("mod_a").unwrap();
        assert_eq!(snap.payload["counter"], 42);

        // Validate for same-version restore
        let target = RestoreTarget {
            module_id: "mod_a".into(),
            schema_version: v1,
            abi_version: 1,
            source_hash: 0,
            required_fields: vec!["counter".into()],
            max_state_bytes: 1024 * 1024,
            layout_hash: None,
        };

        let registry = MigrationRegistry::new();
        let outcome = orchestrate_restore(snap, &target, &registry);
        assert_eq!(outcome.strategy, RestoreStrategy::Direct);
        assert_eq!(outcome.final_state.unwrap()["counter"], 42);
    }

    // ── Scenario 2: Migration path applied during restore ────

    #[test]
    fn scenario_migration_restore() {
        let v1 = SchemaVersion::new(1, 0, 0);
        let v2 = SchemaVersion::new(1, 1, 0);

        // Register migration
        let mut registry = MigrationRegistry::new();
        registry.register(MigrationStep {
            from: v1,
            to: v2,
            description: "add score field".into(),
            reversible: true,
            added_fields: vec![FieldChange {
                field_name: "score".into(),
                field_type: "u32".into(),
                default_value: Some(serde_json::json!(0)),
            }],
            removed_fields: vec![],
            renamed_fields: vec![],
            defaults: {
                let mut m = HashMap::new();
                m.insert("score".into(), serde_json::json!(0));
                m
            },
        });

        // Snapshot at v1
        let snap = StateSnapshot {
            snapshot_id: 1,
            module_id: "mod_a".into(),
            schema_version: v1,
            abi_version: 1,
            source_hash: 0,
            captured_at_ms: 1000,
            payload: serde_json::json!({"counter": 42}),
            field_checksums: {
                let mut m = HashMap::new();
                m.insert("counter".into(), 0x1234);
                m
            },
            layout_hash: None,
            reason: SnapshotReason::PreReload,
        };

        // Target at v2 (same ABI)
        let target = RestoreTarget {
            module_id: "mod_a".into(),
            schema_version: v2,
            abi_version: 1,
            source_hash: 0,
            required_fields: vec!["counter".into(), "score".into()],
            max_state_bytes: 1024 * 1024,
            layout_hash: None,
        };

        let outcome = orchestrate_restore(&snap, &target, &registry);
        assert_eq!(outcome.strategy, RestoreStrategy::Migrate { steps: 1 });
        let state = outcome.final_state.unwrap();
        assert_eq!(state["counter"], 42);
        assert_eq!(state["score"], 0);
    }

    // ── Scenario 3: Size limiter prevents oversized state ────

    #[test]
    fn scenario_size_limit_prevents_capture() {
        let mut mgr = CheckpointManager::new(CheckpointPolicy::default());
        // Create a large state that exceeds the serializer limit
        let big_state = serde_json::json!({"data": "x".repeat(20 * 1024 * 1024)});

        let result = mgr.capture(
            "mod_a",
            &big_state,
            SchemaVersion::new(1, 0, 0),
            1, 0, 1000,
            SnapshotReason::PreReload,
        );
        // Should fail at serialization or size check
        assert!(!matches!(result, CheckpointResult::Captured { .. }));
    }

    // ── Scenario 4: Serializer roundtrip with checksums ────

    #[test]
    fn scenario_serializer_roundtrip() {
        let state = serde_json::json!({
            "counter": 42,
            "nested": {"a": 1, "b": [1, 2, 3]},
            "flag": true
        });
        let config = SerializerConfig::default();

        let result = serialize_state(&state, &config).unwrap();
        assert_eq!(result.field_checksums.len(), 3);
        assert!(result.size_bytes > 0);

        let restored = deserialize_state(&result.bytes, &config).unwrap();
        assert_eq!(state, restored);
    }

    // ── Scenario 5: Incompatible ABI → discard ────

    #[test]
    fn scenario_incompatible_discard() {
        let snap = StateSnapshot {
            snapshot_id: 1,
            module_id: "mod_a".into(),
            schema_version: SchemaVersion::new(1, 0, 0),
            abi_version: 1,
            source_hash: 0,
            captured_at_ms: 1000,
            payload: serde_json::json!({"counter": 42}),
            field_checksums: HashMap::new(),
            layout_hash: None,
            reason: SnapshotReason::PreReload,
        };

        let target = RestoreTarget {
            module_id: "mod_a".into(),
            schema_version: SchemaVersion::new(1, 0, 0),
            abi_version: 2, // different ABI
            source_hash: 0,
            required_fields: vec![],
            max_state_bytes: 1024 * 1024,
            layout_hash: None,
        };

        let registry = MigrationRegistry::new();
        let outcome = orchestrate_restore(&snap, &target, &registry);
        assert!(matches!(outcome.strategy, RestoreStrategy::Discard { .. }));
    }
}
