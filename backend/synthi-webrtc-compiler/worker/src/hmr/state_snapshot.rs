// ============================================================
// STATE SNAPSHOT SCHEMA
// ============================================================
// Defines the canonical schema for state snapshots that get
// persisted during HMR.  Snapshots capture the full state of
// a module at a point in time, including metadata needed for
// safe restoration.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::hmr::state_manager::SchemaVersion;

// ── Snapshot envelope ───────────────────────────────────────

/// A timestamped, versioned state snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateSnapshot {
    /// Unique snapshot id (monotonic).
    pub snapshot_id: u64,
    /// Module that owns this state.
    pub module_id: String,
    /// Schema version at capture time.
    pub schema_version: SchemaVersion,
    /// ABI version at capture time.
    pub abi_version: u32,
    /// Source content hash when snapshot was captured.
    pub source_hash: u64,
    /// Timestamp (epoch millis).
    pub captured_at_ms: u64,
    /// Serialized state payload (JSON).
    pub payload: serde_json::Value,
    /// Field-level checksums for partial restore.
    pub field_checksums: HashMap<String, u64>,
    /// Layout hash for the state type.
    pub layout_hash: Option<u64>,
    /// Capture reason.
    pub reason: SnapshotReason,
}

/// Why a snapshot was captured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SnapshotReason {
    /// Pre-reload capture (the normal hot path).
    PreReload,
    /// Periodic background checkpoint.
    Checkpoint,
    /// Explicit user request.
    UserRequested,
    /// Pre-migration capture (before schema migration).
    PreMigration,
    /// Rollback preparation.
    RollbackPrep,
}

// ── Snapshot comparison ─────────────────────────────────────

/// Result of comparing two snapshots to determine restore strategy.
#[derive(Debug, Clone)]
pub struct SnapshotCompat {
    /// Whether payloads are byte-identical.
    pub identical: bool,
    /// Whether schemas are compatible (same major version).
    pub schema_compatible: bool,
    /// Whether ABI is compatible.
    pub abi_compatible: bool,
    /// Fields that changed between snapshots.
    pub changed_fields: Vec<String>,
    /// Fields that are new in the newer snapshot.
    pub new_fields: Vec<String>,
    /// Fields removed in the newer snapshot.
    pub removed_fields: Vec<String>,
}

/// Compare two snapshots for restore compatibility.
pub fn compare_snapshots(old: &StateSnapshot, new: &StateSnapshot) -> SnapshotCompat {
    let identical = old.payload == new.payload;
    let schema_compatible = old.schema_version.can_upgrade_to(&new.schema_version);
    let abi_compatible = old.abi_version == new.abi_version;

    let old_fields: std::collections::HashSet<&String> = old.field_checksums.keys().collect();
    let new_fields: std::collections::HashSet<&String> = new.field_checksums.keys().collect();

    let mut changed = Vec::new();
    for key in old_fields.intersection(&new_fields) {
        if old.field_checksums.get(*key) != new.field_checksums.get(*key) {
            changed.push((*key).clone());
        }
    }

    let added: Vec<String> = new_fields.difference(&old_fields).map(|k| (*k).clone()).collect();
    let removed: Vec<String> = old_fields.difference(&new_fields).map(|k| (*k).clone()).collect();

    SnapshotCompat {
        identical,
        schema_compatible,
        abi_compatible,
        changed_fields: changed,
        new_fields: added,
        removed_fields: removed,
    }
}

// ── Snapshot ring buffer ────────────────────────────────────

/// Bounded ring of recent snapshots for a module.
pub struct SnapshotRing {
    capacity: usize,
    snapshots: Vec<StateSnapshot>,
    next_id: u64,
}

impl SnapshotRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            snapshots: Vec::with_capacity(capacity),
            next_id: 1,
        }
    }

    /// Push a new snapshot, evicting oldest if full.
    pub fn push(&mut self, mut snap: StateSnapshot) -> u64 {
        let id = self.next_id;
        snap.snapshot_id = id;
        self.next_id += 1;

        if self.snapshots.len() >= self.capacity {
            self.snapshots.remove(0);
        }
        self.snapshots.push(snap);
        id
    }

    /// Get the most recent snapshot.
    pub fn latest(&self) -> Option<&StateSnapshot> {
        self.snapshots.last()
    }

    /// Get snapshot by id.
    pub fn get(&self, id: u64) -> Option<&StateSnapshot> {
        self.snapshots.iter().find(|s| s.snapshot_id == id)
    }

    /// Number of stored snapshots.
    pub fn len(&self) -> usize {
        self.snapshots.len()
    }

    /// Whether ring is empty.
    pub fn is_empty(&self) -> bool {
        self.snapshots.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_snapshot(module: &str) -> StateSnapshot {
        StateSnapshot {
            snapshot_id: 0,
            module_id: module.into(),
            schema_version: SchemaVersion::new(1, 0, 0),
            abi_version: 1,
            source_hash: 0xdead,
            captured_at_ms: 1000,
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

    #[test]
    fn ring_evicts_oldest() {
        let mut ring = SnapshotRing::new(2);
        ring.push(sample_snapshot("a"));
        ring.push(sample_snapshot("b"));
        ring.push(sample_snapshot("c"));
        assert_eq!(ring.len(), 2);
        assert!(ring.get(1).is_none()); // evicted
        assert!(ring.get(2).is_some());
        assert!(ring.get(3).is_some());
    }

    #[test]
    fn compare_identical() {
        let a = sample_snapshot("mod");
        let b = a.clone();
        let cmp = compare_snapshots(&a, &b);
        assert!(cmp.identical);
        assert!(cmp.schema_compatible);
    }
}
