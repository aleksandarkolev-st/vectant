// ============================================================
// STATE SNAPSHOT SCHEMA
// ============================================================
// Defines the canonical schema for state snapshots that get
// persisted during HMR.  Snapshots capture the full state of
// a module at a point in time, including metadata needed for
// safe restoration.
// ============================================================

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

    let added: Vec<String> = new_fields
        .difference(&old_fields)
        .map(|k| (*k).clone())
        .collect();
    let removed: Vec<String> = old_fields
        .difference(&new_fields)
        .map(|k| (*k).clone())
        .collect();

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

// ============================================================
// STATE SNAPSHOT v2 ENVELOPE (GPU_HMR_ULTRAPLAN §5.4)
// ============================================================
//
// v2 wraps the original `StateSnapshot` (host-side) and optionally
// carries a `DeviceStateSnapshot` (GPU-side). The planner takes a
// `StateSnapshotV2` from `Adapter::snapshot_state` and routes the
// `host` to the dynlib adapter and `device` (if Some) to the GPU
// module adapter.
//
// Why v2 instead of bumping `schema_version` on `StateSnapshot`:
// the device payload is large and is captured at a different
// cadence than host state (device-only reloads snapshot just the
// device side; host-only reloads skip the device entirely). Keeping
// them in sibling fields lets the orchestrator transmit only what
// changed.
//
// The `device` field is stored as `Option<serde_json::Value>` so
// host-only worker builds don't need to pull in the gpu-hmr
// feature just to deserialize an envelope. With `--features gpu-hmr`
// enabled, the helper `with_device` / `device_typed` methods are
// available to convert to/from the strongly-typed
// `device_snapshot::DeviceStateSnapshot`.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateSnapshotV2 {
    /// v2 envelope marker — currently a constant `2`. Reload
    /// orchestrator checks this and refuses to restore from a
    /// future envelope version.
    pub envelope_version: u8,

    /// The host-side payload — same shape as v1's `StateSnapshot`.
    pub host: StateSnapshot,

    /// Optional device-side payload. Carries a
    /// `DeviceStateSnapshot` (see `hmr::device_snapshot`) when
    /// the build was GPU-aware, otherwise None.
    ///
    /// Stored as untyped JSON so the host-only worker build
    /// (without the `gpu-hmr` feature) can still deserialize
    /// the envelope, just without inspecting the device payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<serde_json::Value>,
}

impl StateSnapshotV2 {
    /// Default envelope version constant. Bumped on schema-breaking
    /// changes to the `host` or `device` payload shapes.
    pub const ENVELOPE_VERSION: u8 = 2;

    /// Wrap a host-only `StateSnapshot` into a v2 envelope.
    pub fn from_host(host: StateSnapshot) -> Self {
        Self {
            envelope_version: Self::ENVELOPE_VERSION,
            host,
            device: None,
        }
    }

    pub fn has_device_state(&self) -> bool {
        self.device.is_some()
    }

    /// Drop the device payload — used when the planner routes a
    /// pure host reload and wants to forward the envelope without
    /// the (possibly large) device blob.
    pub fn without_device(mut self) -> Self {
        self.device = None;
        self
    }

    /// Sniff the snapshot tier the device payload claims, without
    /// needing the gpu-hmr feature on. Looks for `"tier"` at the
    /// top level of the JSON object. None if no device payload or
    /// the field is missing.
    pub fn device_tier_label(&self) -> Option<String> {
        self.device
            .as_ref()
            .and_then(|v| v.get("tier"))
            .and_then(|t| t.as_str())
            .map(str::to_string)
    }

    /// Approximate JSON size of the device payload, in bytes.
    /// Useful for the orchestrator's `gpu_snapshot_telemetry` log
    /// line per §6.1.
    pub fn device_payload_size(&self) -> u64 {
        self.device
            .as_ref()
            .map(|v| {
                serde_json::to_string(v)
                    .map(|s| s.len() as u64)
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    }
}

#[cfg(feature = "gpu-hmr")]
impl StateSnapshotV2 {
    /// Build an envelope with a strongly-typed device payload.
    /// Available with `--features gpu-hmr`.
    pub fn with_device(
        host: StateSnapshot,
        device: crate::hmr::device_snapshot::DeviceStateSnapshot,
    ) -> Self {
        Self {
            envelope_version: Self::ENVELOPE_VERSION,
            host,
            device: Some(
                serde_json::to_value(device)
                    .expect("DeviceStateSnapshot is JSON-safe by construction"),
            ),
        }
    }

    /// Deserialize the device payload into the strongly-typed
    /// `DeviceStateSnapshot`. Available with `--features gpu-hmr`.
    pub fn device_typed(&self) -> Option<crate::hmr::device_snapshot::DeviceStateSnapshot> {
        self.device
            .as_ref()
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }
}

#[cfg(test)]
mod v2_tests {
    use super::*;

    fn sample_host_snapshot() -> StateSnapshot {
        StateSnapshot {
            snapshot_id: 7,
            module_id: "core".into(),
            schema_version: SchemaVersion::new(1, 0, 0),
            abi_version: 1,
            source_hash: 0xdead_beef,
            captured_at_ms: 1_700_000_000,
            payload: serde_json::json!({"x": 1}),
            field_checksums: HashMap::new(),
            layout_hash: None,
            reason: SnapshotReason::PreReload,
        }
    }

    #[test]
    fn v2_host_only_envelope() {
        let v2 = StateSnapshotV2::from_host(sample_host_snapshot());
        assert_eq!(v2.envelope_version, StateSnapshotV2::ENVELOPE_VERSION);
        assert!(!v2.has_device_state());
        assert_eq!(v2.device_payload_size(), 0);
        assert!(v2.device_tier_label().is_none());
    }

    #[test]
    fn v2_serialises_without_device_field_when_absent() {
        let v2 = StateSnapshotV2::from_host(sample_host_snapshot());
        let json = serde_json::to_string(&v2).unwrap();
        // skip_serializing_if drops the device field entirely
        // when None — keeps host-only envelopes compact.
        assert!(!json.contains("\"device\""));
        let back: StateSnapshotV2 = serde_json::from_str(&json).unwrap();
        assert!(!back.has_device_state());
    }

    #[test]
    fn v2_without_device_drops_payload() {
        let mut v2 = StateSnapshotV2::from_host(sample_host_snapshot());
        v2.device = Some(serde_json::json!({"tier": "userspace"}));
        assert!(v2.has_device_state());
        let stripped = v2.without_device();
        assert!(!stripped.has_device_state());
    }

    #[test]
    fn device_tier_label_reads_top_level_tier() {
        let mut v2 = StateSnapshotV2::from_host(sample_host_snapshot());
        v2.device = Some(serde_json::json!({"tier": "userspace", "buffers": []}));
        assert_eq!(v2.device_tier_label(), Some("userspace".into()));

        v2.device = Some(serde_json::json!({"buffers": []}));
        assert_eq!(v2.device_tier_label(), None);
    }

    #[test]
    fn device_payload_size_reflects_serialized_length() {
        let mut v2 = StateSnapshotV2::from_host(sample_host_snapshot());
        v2.device = Some(serde_json::json!({"x": 1}));
        let small = v2.device_payload_size();
        v2.device = Some(serde_json::json!({"x": "a".repeat(1000)}));
        let big = v2.device_payload_size();
        assert!(big > small);
        assert!(big >= 1000);
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn v2_strongly_typed_device_roundtrip() {
        use crate::hmr::device_snapshot::{BufferRegistry, DeviceStateSnapshot, SnapshotTier};
        let device = DeviceStateSnapshot {
            tier: SnapshotTier::Userspace,
            device_ordinal: 0,
            driver_version: 12080,
            compute_capability: "sm_120".into(),
            streams: vec![],
            buffers: BufferRegistry::new(),
            constants: vec![],
            kernel_sig_hashes: HashMap::new(),
            captured_at_ms: 1_700_000_000_000,
            capture_duration_ms: 0,
            used_vram_shadow: true,
        };
        let v2 = StateSnapshotV2::with_device(sample_host_snapshot(), device.clone());
        assert!(v2.has_device_state());
        assert_eq!(v2.device_tier_label(), Some("userspace".into()));
        let back = v2.device_typed().expect("device typed roundtrip");
        assert_eq!(back, device);
        assert_eq!(back.compute_capability, "sm_120");
    }
}
