// ============================================================
// STATE CHECKPOINT MANAGER
// ============================================================
// Coordinates periodic and event-driven state checkpoints.
// Orchestrates snapshot capture, validation, and storage using
// the serializer, snapshot ring, and size limiter.
// ============================================================

#![allow(dead_code)]

use std::collections::HashMap;

use crate::hmr::state_manager::SchemaVersion;
use crate::hmr::state_serializer::{serialize_state, SerializerConfig};
use crate::hmr::state_size_limiter::{SizeCheckResult, StateSizeLimiter, GlobalSizeLimits};
use crate::hmr::state_snapshot::{SnapshotReason, SnapshotRing, StateSnapshot};

/// Checkpoint policy.
#[derive(Debug, Clone)]
pub struct CheckpointPolicy {
    /// Maximum interval between checkpoints (millis).
    pub max_interval_ms: u64,
    /// Minimum interval between checkpoints (debounce).
    pub min_interval_ms: u64,
    /// Whether to checkpoint before every reload.
    pub checkpoint_on_reload: bool,
    /// Ring capacity per module.
    pub ring_capacity: usize,
}

impl Default for CheckpointPolicy {
    fn default() -> Self {
        Self {
            max_interval_ms: 30_000, // 30 seconds
            min_interval_ms: 1_000,  // 1 second debounce
            checkpoint_on_reload: true,
            ring_capacity: 8,
        }
    }
}

/// Checkpoint status for a single module.
struct ModuleCheckpoint {
    ring: SnapshotRing,
    last_checkpoint_ms: u64,
}

/// Manages checkpoints across all modules.
pub struct CheckpointManager {
    policy: CheckpointPolicy,
    modules: HashMap<String, ModuleCheckpoint>,
    size_limiter: StateSizeLimiter,
    serializer_config: SerializerConfig,
}

/// Result of a checkpoint operation.
#[derive(Debug)]
pub enum CheckpointResult {
    /// Checkpoint captured successfully.
    Captured { snapshot_id: u64, size_bytes: usize },
    /// Skipped due to debounce (too soon).
    Debounced,
    /// Skipped due to size limit.
    SizeLimitExceeded { module_id: String },
    /// Serialization error.
    SerializationError(String),
}

impl CheckpointManager {
    pub fn new(policy: CheckpointPolicy) -> Self {
        Self {
            modules: HashMap::new(),
            size_limiter: StateSizeLimiter::new(GlobalSizeLimits::default()),
            serializer_config: SerializerConfig::default(),
            policy,
        }
    }

    /// Capture a checkpoint for a module.
    pub fn capture(
        &mut self,
        module_id: &str,
        state: &serde_json::Value,
        schema_version: SchemaVersion,
        abi_version: u32,
        source_hash: u64,
        now_ms: u64,
        reason: SnapshotReason,
    ) -> CheckpointResult {
        // Debounce check (skip for reload/rollback reasons)
        let should_debounce = matches!(reason, SnapshotReason::Checkpoint);
        if should_debounce {
            if let Some(mc) = self.modules.get(module_id) {
                if now_ms.saturating_sub(mc.last_checkpoint_ms) < self.policy.min_interval_ms {
                    return CheckpointResult::Debounced;
                }
            }
        }

        // Serialize
        let ser_result = match serialize_state(state, &self.serializer_config) {
            Ok(r) => r,
            Err(e) => return CheckpointResult::SerializationError(e.to_string()),
        };

        // Size check
        match self.size_limiter.check(module_id, ser_result.size_bytes) {
            SizeCheckResult::Exceeded { .. } | SizeCheckResult::TooManyModules { .. } => {
                return CheckpointResult::SizeLimitExceeded {
                    module_id: module_id.into(),
                };
            }
            _ => {}
        }

        // Create snapshot
        let snapshot = StateSnapshot {
            snapshot_id: 0, // assigned by ring
            module_id: module_id.into(),
            schema_version,
            abi_version,
            source_hash,
            captured_at_ms: now_ms,
            payload: state.clone(),
            field_checksums: ser_result.field_checksums,
            layout_hash: None,
            reason,
        };

        // Store
        let mc = self.modules.entry(module_id.to_string()).or_insert_with(|| {
            ModuleCheckpoint {
                ring: SnapshotRing::new(self.policy.ring_capacity),
                last_checkpoint_ms: 0,
            }
        });
        let snapshot_id = mc.ring.push(snapshot);
        mc.last_checkpoint_ms = now_ms;

        self.size_limiter.record(module_id, ser_result.size_bytes);

        CheckpointResult::Captured {
            snapshot_id,
            size_bytes: ser_result.size_bytes,
        }
    }

    /// Get the latest snapshot for a module.
    pub fn latest(&self, module_id: &str) -> Option<&StateSnapshot> {
        self.modules.get(module_id).and_then(|mc| mc.ring.latest())
    }

    /// Get a specific snapshot by id.
    pub fn get_snapshot(&self, module_id: &str, snapshot_id: u64) -> Option<&StateSnapshot> {
        self.modules.get(module_id).and_then(|mc| mc.ring.get(snapshot_id))
    }

    /// Remove all checkpoints for a module.
    pub fn clear_module(&mut self, module_id: &str) {
        self.modules.remove(module_id);
        self.size_limiter.remove(module_id);
    }

    /// Total stored bytes across all modules.
    pub fn total_bytes(&self) -> usize {
        self.size_limiter.total_bytes()
    }

    /// Number of modules with checkpoints.
    pub fn module_count(&self) -> usize {
        self.modules.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_and_retrieve() {
        let mut mgr = CheckpointManager::new(CheckpointPolicy::default());
        let state = serde_json::json!({"counter": 42});

        let result = mgr.capture(
            "mod_a",
            &state,
            SchemaVersion::new(1, 0, 0),
            1,
            0xdead,
            1000,
            SnapshotReason::PreReload,
        );
        assert!(matches!(result, CheckpointResult::Captured { .. }));

        let snap = mgr.latest("mod_a").unwrap();
        assert_eq!(snap.payload["counter"], 42);
    }

    #[test]
    fn debounce() {
        let policy = CheckpointPolicy {
            min_interval_ms: 5000,
            ..Default::default()
        };
        let mut mgr = CheckpointManager::new(policy);
        let state = serde_json::json!({"x": 1});

        mgr.capture("m", &state, SchemaVersion::new(1, 0, 0), 1, 0, 1000, SnapshotReason::Checkpoint);
        let result = mgr.capture("m", &state, SchemaVersion::new(1, 0, 0), 1, 0, 2000, SnapshotReason::Checkpoint);
        assert!(matches!(result, CheckpointResult::Debounced));
    }

    #[test]
    fn reload_bypasses_debounce() {
        let policy = CheckpointPolicy {
            min_interval_ms: 5000,
            ..Default::default()
        };
        let mut mgr = CheckpointManager::new(policy);
        let state = serde_json::json!({"x": 1});

        mgr.capture("m", &state, SchemaVersion::new(1, 0, 0), 1, 0, 1000, SnapshotReason::PreReload);
        let result = mgr.capture("m", &state, SchemaVersion::new(1, 0, 0), 1, 0, 1500, SnapshotReason::PreReload);
        assert!(matches!(result, CheckpointResult::Captured { .. }));
    }
}
