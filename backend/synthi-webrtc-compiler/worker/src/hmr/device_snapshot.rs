// ============================================================
// DEVICE STATE SNAPSHOT (Phase 1 scaffold — Tier B userspace path)
// ============================================================
//
// Spec: docs/GPU_HMR_ULTRAPLAN.md §6.
//
// The plan defines two snapshot tiers:
//
//   Tier A (DriverCheckpoint)
//     Calls cuCheckpointProcessCheckpoint (CUDA ≥ 12.5). Single
//     opaque blob; the driver does the heavy lifting. Cheap when
//     available, but version-gated.
//
//   Tier B (Userspace)
//     The worker iterates its own buffer registry and copies VRAM
//     back to RAM (or to an in-VRAM shadow arena per §6.1.1) before
//     each swap. Latency budget §6.1 is the contract — naive
//     `cuMemcpyDtoH` of a multi-GB working set blows the budget,
//     hence dirty-bit accounting + the in-VRAM shadow.
//
// This file holds the Tier-B types only — DeviceStateSnapshot,
// BufferRecord, BufferRegistry, ConstantSlotRecord, StreamRecord.
// Phase 1 scope: serde-roundtrippable shape, no actual driver
// interaction. Phase 2 wires up the cuMemcpyDtoD shadow path and
// the dirty-bit shim; Phase 3 plugs in Tier A.
//
// Feature-gated by `gpu-hmr` so worker builds without the flag
// continue to compile unchanged.

#![cfg(feature = "gpu-hmr")]

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ── Top-level snapshot envelope ─────────────────────────────

/// One device-state snapshot. Sits inside `StateSnapshotV2`
/// (host + device, added in a separate commit on `state_snapshot.rs`).
/// Phase 1: this struct is just the bag of records; Phase 2 adds
/// the actual VRAM payloads and serializes via rmp-serde.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceStateSnapshot {
    /// Capture-time tier (mirrors `compile_manifest::SnapshotMode`
    /// minus `Auto` — by the time we're recording, the orchestrator
    /// has picked one).
    pub tier: SnapshotTier,
    /// CUDA device ordinal at capture time. Mismatching this on
    /// restore is a hard fail (per §6 "no migration across devices").
    pub device_ordinal: i32,
    /// Driver / runtime version captured for compatibility checks
    /// (e.g. CUDA driver 12.5). Stored as the raw int from
    /// `cuDriverGetVersion`.
    pub driver_version: i32,
    /// Compute capability of the device, e.g. "sm_120" for RTX 5070.
    pub compute_capability: String,
    /// Stream sync state — must be drained before snapshot is
    /// considered consistent.
    pub streams: Vec<StreamRecord>,
    /// Buffer working set captured for this swap.
    pub buffers: BufferRegistry,
    /// `__constant__` memory slots captured.
    pub constants: Vec<ConstantSlotRecord>,
    /// Per-kernel signature hashes (matches `kernel_hashes` from
    /// the splitter's `<synthi_kernel_hashes>` block). Phase 2
    /// uses this to assert the new module exposes every kernel
    /// the snapshot expects.
    pub kernel_sig_hashes: HashMap<String, String>,
    /// Capture-time wall-clock millis, for budget telemetry per
    /// §6.1.
    pub captured_at_ms: u64,
    /// Number of millis the orchestrator measured between
    /// `device_save` start and end. Surfaces as `snapshot_ms` in
    /// the `gpu_snapshot_telemetry` log line.
    pub capture_duration_ms: u64,
    /// Whether the in-VRAM shadow arena (§6.1.1) was used. Drives
    /// the WARN vs FAIL decision in the harness when the budget is
    /// missed.
    pub used_vram_shadow: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotTier {
    /// Tier A — driver checkpoint blob (single opaque payload).
    DriverCheckpoint,
    /// Tier B — userspace serializer that walks the buffer registry.
    Userspace,
}

impl SnapshotTier {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::DriverCheckpoint => "driver_checkpoint",
            Self::Userspace => "userspace",
        }
    }

    /// Short label the harness greps for in worker.log
    /// (`snapshot_tier=A` / `=B`).
    pub fn short_label(&self) -> &'static str {
        match self {
            Self::DriverCheckpoint => "A",
            Self::Userspace => "B",
        }
    }
}

// ── Per-buffer record ───────────────────────────────────────

/// One device buffer tracked by the worker. Phase 1 stores only
/// metadata; Phase 2 adds an opaque `Vec<u8>` payload (gated by
/// `clean_dirty_bit` so unchanged buffers don't pay the copy cost).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BufferRecord {
    /// Stable identifier — the address as a u64 at registration
    /// time. Survives device-only reloads (same VRAM pointer);
    /// regenerated on cold restart.
    pub handle_id: u64,
    /// Symbolic name from the host runner (e.g. "a", "b", "c") so
    /// the harness can grep `[gpu-adapter] reused buffer a=…`.
    pub debug_name: String,
    /// Allocation size in bytes.
    pub bytes: u64,
    /// Element stride if the host registered it as a typed array
    /// (`sizeof(float)` etc). Phase 2 uses this for endianness +
    /// pointer-fix-up logic.
    pub element_stride: Option<u32>,
    /// True if the buffer has been written to since the last
    /// snapshot — §6.1.2 dirty-bit shim. Clean buffers can skip
    /// the cuMemcpyDtoD step entirely on a subsequent swap.
    pub dirty: bool,
    /// Whether this buffer participates in the in-VRAM shadow
    /// arena (§6.1.1). Large read-only buffers (textures, model
    /// weights) usually opt out.
    pub uses_vram_shadow: bool,
    /// Where the shadow copy lives, if any. None on Tier-A.
    pub shadow_handle_id: Option<u64>,
}

impl BufferRecord {
    pub fn is_clean(&self) -> bool {
        !self.dirty
    }

    pub fn shadow_size_bytes(&self) -> u64 {
        if self.uses_vram_shadow {
            self.bytes
        } else {
            0
        }
    }
}

/// Collection of `BufferRecord`s tracked by the adapter. Keeps the
/// host runner's symbolic names addressable while also offering an
/// ID lookup for the snapshot save path. Phase 2 will wire this in
/// to `gpu_module_adapter::GpuModuleAdapter`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct BufferRegistry {
    /// Symbolic name → record. Insertion-ordered for harness logs.
    by_name: Vec<BufferRecord>,
}

impl BufferRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.by_name.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_name.is_empty()
    }

    pub fn register(&mut self, record: BufferRecord) {
        if let Some(existing) = self.by_name.iter_mut().find(|r| r.handle_id == record.handle_id) {
            *existing = record;
        } else {
            self.by_name.push(record);
        }
    }

    pub fn get_by_name(&self, name: &str) -> Option<&BufferRecord> {
        self.by_name.iter().find(|r| r.debug_name == name)
    }

    pub fn get_by_handle(&self, handle_id: u64) -> Option<&BufferRecord> {
        self.by_name.iter().find(|r| r.handle_id == handle_id)
    }

    pub fn iter(&self) -> impl Iterator<Item = &BufferRecord> {
        self.by_name.iter()
    }

    /// Sum of bytes that will be copied during a Tier-B snapshot,
    /// honouring dirty-bit + shadow accounting (§6.1.2). Phase 2
    /// uses this for the harness budget assertion.
    pub fn snapshot_byte_budget(&self) -> u64 {
        self.by_name
            .iter()
            .filter(|r| r.dirty || !r.uses_vram_shadow)
            .map(|r| r.bytes)
            .sum()
    }

    /// Mark every buffer clean after a successful save — Phase 2
    /// orchestrator calls this once the device_save step has
    /// confirmed flush.
    pub fn mark_all_clean(&mut self) {
        for r in &mut self.by_name {
            r.dirty = false;
        }
    }

    /// Total bytes claimed by the in-VRAM shadow arena.
    pub fn shadow_bytes(&self) -> u64 {
        self.by_name.iter().map(|r| r.shadow_size_bytes()).sum()
    }
}

// ── __constant__ memory ─────────────────────────────────────

/// One `__constant__` memory slot. Captured because constants are
/// re-uploaded on every module load and we want to skip the upload
/// if the bytes match.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConstantSlotRecord {
    /// Symbol name from the cubin (`cuModuleGetGlobal` target).
    pub name: String,
    pub bytes: u64,
    /// Last-known checksum (fnv64 or similar). Phase 2 hashes the
    /// real upload; Phase 1 leaves this for the harness to verify
    /// roundtrip without invoking the driver.
    pub checksum: u64,
}

// ── Stream record ───────────────────────────────────────────

/// One stream that must be drained before snapshot is consistent.
/// §5.4 drain step asserts every stream has `streams_synced=1`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StreamRecord {
    /// Stream handle as u64 (same Send-via-integer trick as
    /// `gpu_module_adapter::active_module_handle`).
    pub handle_id: u64,
    /// Number of pending operations the watchdog observed before
    /// draining. 0 == idle, > 0 == workload in flight.
    pub pending_ops: u32,
    /// `cuStreamSynchronize` wall-clock millis. Surfaces in the
    /// harness `step=drain` line.
    pub drain_ms: u64,
    /// Whether `cuStreamSynchronize` returned ok within
    /// `drain_timeout_ms` (§5.4 default 2000).
    pub drained_clean: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_record(name: &str, handle: u64, bytes: u64, dirty: bool) -> BufferRecord {
        BufferRecord {
            handle_id: handle,
            debug_name: name.into(),
            bytes,
            element_stride: Some(4),
            dirty,
            uses_vram_shadow: true,
            shadow_handle_id: Some(handle + 1),
        }
    }

    #[test]
    fn tier_strings() {
        assert_eq!(SnapshotTier::DriverCheckpoint.as_str(), "driver_checkpoint");
        assert_eq!(SnapshotTier::Userspace.as_str(), "userspace");
        assert_eq!(SnapshotTier::DriverCheckpoint.short_label(), "A");
        assert_eq!(SnapshotTier::Userspace.short_label(), "B");
    }

    #[test]
    fn buffer_record_is_clean_inverse_of_dirty() {
        let mut r = sample_record("a", 0x10, 4096, false);
        assert!(r.is_clean());
        r.dirty = true;
        assert!(!r.is_clean());
    }

    #[test]
    fn shadow_size_zero_when_no_shadow() {
        let mut r = sample_record("a", 0x10, 4096, false);
        assert_eq!(r.shadow_size_bytes(), 4096);
        r.uses_vram_shadow = false;
        assert_eq!(r.shadow_size_bytes(), 0);
    }

    #[test]
    fn registry_insertion_order_preserved() {
        let mut reg = BufferRegistry::new();
        reg.register(sample_record("a", 0x10, 1024, false));
        reg.register(sample_record("b", 0x20, 2048, false));
        reg.register(sample_record("c", 0x30, 4096, false));
        let names: Vec<&str> = reg.iter().map(|r| r.debug_name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c"]);
        assert_eq!(reg.len(), 3);
    }

    #[test]
    fn registry_update_in_place() {
        let mut reg = BufferRegistry::new();
        reg.register(sample_record("a", 0x10, 1024, false));
        reg.register(sample_record("a", 0x10, 2048, true)); // same handle_id
        assert_eq!(reg.len(), 1);
        let a = reg.get_by_name("a").unwrap();
        assert_eq!(a.bytes, 2048);
        assert!(a.dirty);
    }

    #[test]
    fn registry_lookup_by_name_and_handle() {
        let mut reg = BufferRegistry::new();
        reg.register(sample_record("a", 0x10, 1024, false));
        reg.register(sample_record("b", 0x20, 2048, false));
        assert_eq!(reg.get_by_name("a").unwrap().bytes, 1024);
        assert_eq!(reg.get_by_handle(0x20).unwrap().debug_name, "b");
        assert!(reg.get_by_name("z").is_none());
    }

    #[test]
    fn snapshot_byte_budget_skips_clean_shadowed_buffers() {
        // §6.1.2 dirty-bit accounting: clean buffer + shadow on
        // means we DON'T pay the copy cost on the next swap.
        let mut reg = BufferRegistry::new();
        reg.register(sample_record("dirty", 0x10, 4096, true));   // dirty -> counted
        reg.register(sample_record("clean", 0x20, 8192, false));  // clean + shadow -> skipped
        let mut without_shadow = sample_record("no_shadow", 0x30, 1024, false);
        without_shadow.uses_vram_shadow = false;
        reg.register(without_shadow); // clean but no shadow -> counted
        assert_eq!(reg.snapshot_byte_budget(), 4096 + 1024);
    }

    #[test]
    fn mark_all_clean_idempotent() {
        let mut reg = BufferRegistry::new();
        reg.register(sample_record("a", 0x10, 1024, true));
        reg.register(sample_record("b", 0x20, 2048, true));
        assert!(reg.iter().all(|r| r.dirty));
        reg.mark_all_clean();
        assert!(reg.iter().all(|r| !r.dirty));
        reg.mark_all_clean();
        assert!(reg.iter().all(|r| !r.dirty));
    }

    #[test]
    fn shadow_bytes_sum() {
        let mut reg = BufferRegistry::new();
        reg.register(sample_record("a", 0x10, 1024, false));
        reg.register(sample_record("b", 0x20, 2048, false));
        let mut no_shadow = sample_record("c", 0x30, 9999, false);
        no_shadow.uses_vram_shadow = false;
        reg.register(no_shadow);
        assert_eq!(reg.shadow_bytes(), 1024 + 2048);
    }

    #[test]
    fn snapshot_envelope_roundtrips_through_json() {
        let snap = DeviceStateSnapshot {
            tier: SnapshotTier::Userspace,
            device_ordinal: 0,
            driver_version: 12080,
            compute_capability: "sm_120".into(),
            streams: vec![StreamRecord {
                handle_id: 0xAA,
                pending_ops: 3,
                drain_ms: 12,
                drained_clean: true,
            }],
            buffers: {
                let mut r = BufferRegistry::new();
                r.register(sample_record("a", 0x10, 1024, false));
                r
            },
            constants: vec![ConstantSlotRecord {
                name: "k_pi".into(),
                bytes: 4,
                checksum: 0xCAFEBABE,
            }],
            kernel_sig_hashes: {
                let mut m = HashMap::new();
                m.insert("vec_add".into(), "deadbeef".into());
                m
            },
            captured_at_ms: 1_700_000_000_000,
            capture_duration_ms: 42,
            used_vram_shadow: true,
        };
        let json = serde_json::to_string(&snap).unwrap();
        let back: DeviceStateSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back, snap);
        assert_eq!(back.tier.short_label(), "B");
        assert_eq!(back.compute_capability, "sm_120");
    }

    #[test]
    fn stream_record_roundtrips_through_json() {
        let s = StreamRecord {
            handle_id: 0xDEAD,
            pending_ops: 1,
            drain_ms: 1500,
            drained_clean: false,
        };
        let j = serde_json::to_string(&s).unwrap();
        let back: StreamRecord = serde_json::from_str(&j).unwrap();
        assert_eq!(back, s);
    }
}
