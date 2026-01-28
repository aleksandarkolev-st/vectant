// ============================================================
// RELOAD PROTOCOL - DETERMINISTIC HMR STATE MACHINE
// ============================================================
// Addresses requirement #1: Single deterministic reload path
//
// CANONICAL RELOAD FLOW (no ambiguity, no "hope"):
//
// 1. Supervisor sends ReloadModule(slot, path)
// 2. Worker enters quiescence for that slot:
//    - Stops callbacks and timers
//    - Joins/cancels owned threads
//    - Drains message queues
//    - Flushes pending I/O
// 3. Worker produces snapshot (or explicit NoSnapshotPossible)
// 4. Worker sends Snapshot(slot, bytes, version)
// 5. Worker sends ReadyForKill(slot)
// 6. Supervisor validates snapshot, kills worker
// 7. Supervisor spawns new worker
// 8. Supervisor sends LoadModule(slot, path, snapshot)
//
// KEY INVARIANTS:
// - Supervisor NEVER assumes worker is idle
// - Worker MUST explicitly acknowledge quiescence
// - All state transitions have hard timeouts
// - Failures trigger clean restart, not retry loops
// ============================================================

// #![allow(dead_code)] - REMOVED: This module is now wired up in main.rs

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Unique identifier for a reload operation (for logging/tracing)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ReloadId(pub u64);

impl ReloadId {
    pub fn new() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        ReloadId(COUNTER.fetch_add(1, Ordering::SeqCst))
    }

    /// Get the raw ID value
    pub fn as_u64(&self) -> u64 {
        self.0
    }
}

impl Default for ReloadId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for ReloadId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "reload-{:08x}", self.0)
    }
}

// ============================================================
// RELOAD STATE MACHINE
// ============================================================

/// State machine for a single reload operation
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReloadState {
    /// Initial state - reload requested but not started
    Pending,
    /// ReloadModule sent to worker, awaiting quiescence
    AwaitingQuiescence { sent_at: Instant },
    /// Worker acknowledged quiescence, awaiting snapshot
    AwaitingSnapshot { quiesced_at: Instant },
    /// Snapshot received, awaiting ReadyForKill
    AwaitingReadyForKill { snapshot_received_at: Instant },
    /// Worker signaled ready, supervisor can kill
    ReadyToKill { ready_at: Instant },
    /// Worker killed, spawning new one
    Respawning { killed_at: Instant },
    /// New worker started, loading module
    LoadingModule { spawned_at: Instant },
    /// Reload completed successfully
    Completed { duration: Duration },
    /// Reload failed
    Failed {
        error: ReloadError,
        duration: Duration,
    },
}

/// Errors that can occur during reload
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReloadError {
    /// Worker failed to reach quiescence within timeout
    QuiescenceTimeout { slot: String, timeout_ms: u64 },
    /// Worker failed to produce snapshot within timeout  
    SnapshotTimeout { slot: String, timeout_ms: u64 },
    /// Worker explicitly reported snapshot not possible
    SnapshotNotPossible { slot: String, reason: String },
    /// Snapshot validation failed (checksum, size, format)
    SnapshotInvalid { slot: String, reason: String },
    /// Worker failed to signal ReadyForKill
    ReadyForKillTimeout { slot: String, timeout_ms: u64 },
    /// Failed to spawn new worker
    SpawnFailed { reason: String },
    /// New worker failed to load module
    LoadFailed { slot: String, reason: String },
    /// Protocol violation (unexpected message)
    ProtocolViolation { expected: String, got: String },
    /// Worker crashed during reload
    WorkerCrashed { signal: Option<i32> },
    /// Internal error
    Internal { reason: String },
}

impl std::fmt::Display for ReloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReloadError::QuiescenceTimeout { slot, timeout_ms } => {
                write!(
                    f,
                    "Quiescence timeout for slot '{}' after {}ms",
                    slot, timeout_ms
                )
            }
            ReloadError::SnapshotTimeout { slot, timeout_ms } => {
                write!(
                    f,
                    "Snapshot timeout for slot '{}' after {}ms",
                    slot, timeout_ms
                )
            }
            ReloadError::SnapshotNotPossible { slot, reason } => {
                write!(f, "Snapshot not possible for slot '{}': {}", slot, reason)
            }
            ReloadError::SnapshotInvalid { slot, reason } => {
                write!(f, "Invalid snapshot for slot '{}': {}", slot, reason)
            }
            ReloadError::ReadyForKillTimeout { slot, timeout_ms } => {
                write!(
                    f,
                    "ReadyForKill timeout for slot '{}' after {}ms",
                    slot, timeout_ms
                )
            }
            ReloadError::SpawnFailed { reason } => {
                write!(f, "Failed to spawn worker: {}", reason)
            }
            ReloadError::LoadFailed { slot, reason } => {
                write!(f, "Failed to load module in slot '{}': {}", slot, reason)
            }
            ReloadError::ProtocolViolation { expected, got } => {
                write!(f, "Protocol violation: expected {}, got {}", expected, got)
            }
            ReloadError::WorkerCrashed { signal } => {
                if let Some(sig) = signal {
                    write!(f, "Worker crashed with signal {}", sig)
                } else {
                    write!(f, "Worker crashed")
                }
            }
            ReloadError::Internal { reason } => {
                write!(f, "Internal error: {}", reason)
            }
        }
    }
}

// ============================================================
// PROTOCOL MESSAGES
// ============================================================

/// Messages from Supervisor to Worker
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SupervisorMessage {
    /// Request module reload - worker must enter quiescence
    ReloadModule {
        reload_id: ReloadId,
        slot: String,
        new_module_path: String,
        /// Hard timeout for quiescence (worker MUST respond before this)
        quiescence_timeout_ms: u32,
        /// Hard timeout for snapshot production
        snapshot_timeout_ms: u32,
    },

    /// Load module with optional snapshot (sent to new worker after respawn)
    LoadModule {
        reload_id: ReloadId,
        slot: String,
        module_path: String,
        snapshot: Option<ValidatedSnapshot>,
    },

    /// Request snapshot without reload (for periodic backups)
    RequestSnapshot {
        reload_id: ReloadId,
        slot: String,
        timeout_ms: u32,
    },

    /// Graceful shutdown request
    Shutdown { timeout_ms: u32 },

    /// Heartbeat ping
    Ping { seq: u64 },

    /// Acknowledge quiescence received (supervisor -> worker)
    QuiescenceAcknowledged { reload_id: ReloadId },
}

/// Messages from Worker to Supervisor  
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WorkerMessage {
    /// Worker has reached quiescence for the slot
    QuiescenceAchieved {
        reload_id: ReloadId,
        slot: String,
        /// Details about what was quiesced
        quiescence_report: QuiescenceReport,
    },

    /// Worker failed to reach quiescence
    QuiescenceFailed {
        reload_id: ReloadId,
        slot: String,
        reason: String,
        /// Can supervisor do a hard restart instead?
        hard_restart_ok: bool,
    },

    /// Snapshot of module state
    Snapshot {
        reload_id: ReloadId,
        slot: String,
        data: Vec<u8>,
        state_version: u32,
        semantic_hash: u64,
        /// CRC32 checksum for corruption detection
        checksum: u32,
    },

    /// Snapshot not possible (e.g., active transactions)
    SnapshotNotPossible {
        reload_id: ReloadId,
        slot: String,
        reason: String,
        /// Supervisor should do cold restart
        cold_restart_required: bool,
    },

    /// Worker is ready to be killed (all cleanup done)
    ReadyForKill { reload_id: ReloadId, slot: String },

    /// Module loaded successfully (sent by new worker after spawn)
    ModuleLoaded {
        reload_id: ReloadId,
        slot: String,
        abi_version: u32,
        state_version: u32,
        layout_hash: Option<u64>,
        semantic_hash: u64,
    },

    /// Module load failed
    ModuleLoadFailed {
        reload_id: ReloadId,
        slot: String,
        reason: String,
    },

    /// Generic error report
    Error {
        reload_id: Option<ReloadId>,
        slot: Option<String>,
        message: String,
        fatal: bool,
    },

    /// Worker is ready (sent on startup)
    Ready,

    /// Heartbeat response
    Pong { seq: u64 },

    /// Worker is shutting down
    ShuttingDown,
}

// ============================================================
// QUIESCENCE PROTOCOL
// ============================================================

/// Report of what was quiesced (for debugging/auditing)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QuiescenceReport {
    /// Timers stopped
    pub timers_stopped: u32,
    /// Callbacks unregistered  
    pub callbacks_unregistered: u32,
    /// Threads joined
    pub threads_joined: u32,
    /// Queues drained (with item counts)
    pub queues_drained: Vec<(String, u32)>,
    /// I/O operations flushed
    pub io_flushed: u32,
    /// Time taken to quiesce
    pub quiescence_duration_ms: u64,
    /// Per-subsystem status
    pub subsystem_status: HashMap<String, SubsystemQuiescenceStatus>,
}

/// Status of quiescence for a specific subsystem
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubsystemQuiescenceStatus {
    pub name: String,
    pub quiesced: bool,
    pub duration_ms: u64,
    pub items_flushed: u32,
    pub error: Option<String>,
}

/// Subsystem identifiers for quiescence tracking
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Subsystem {
    /// Audio processing (callbacks, ring buffers)
    Audio,
    /// Rendering (GPU work, render threads)
    Render,
    /// Input handling (event queues)
    Input,
    /// Network I/O
    Network,
    /// File I/O
    FileIO,
    /// Timer/scheduler
    Timers,
    /// Custom user-defined
    Custom(u32),
}

impl Subsystem {
    pub fn as_str(&self) -> &'static str {
        match self {
            Subsystem::Audio => "audio",
            Subsystem::Render => "render",
            Subsystem::Input => "input",
            Subsystem::Network => "network",
            Subsystem::FileIO => "file_io",
            Subsystem::Timers => "timers",
            Subsystem::Custom(_) => "custom",
        }
    }
}

// ============================================================
// VALIDATED SNAPSHOT
// ============================================================

/// A snapshot that has been validated by the supervisor
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatedSnapshot {
    /// Raw snapshot data
    pub data: Vec<u8>,
    /// State version this snapshot is from
    pub state_version: u32,
    /// Semantic hash for reload safety
    pub semantic_hash: u64,
    /// Validated checksum
    pub checksum: u32,
    /// When the snapshot was taken
    pub timestamp_ms: u64,
}

impl ValidatedSnapshot {
    /// Validate a snapshot from worker message
    pub fn validate(
        data: Vec<u8>,
        state_version: u32,
        semantic_hash: u64,
        checksum: u32,
        max_size: usize,
    ) -> Result<Self, String> {
        // Check size limit
        if data.len() > max_size {
            return Err(format!(
                "Snapshot too large: {} bytes > {} max",
                data.len(),
                max_size
            ));
        }

        // Verify checksum
        let computed = crc32_checksum(&data);
        if computed != checksum {
            return Err(format!(
                "Checksum mismatch: expected 0x{:08x}, got 0x{:08x}",
                checksum, computed
            ));
        }

        Ok(ValidatedSnapshot {
            data,
            state_version,
            semantic_hash,
            checksum,
            timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        })
    }
}

/// Compute CRC32 checksum
pub fn crc32_checksum(data: &[u8]) -> u32 {
    // CRC32-C (Castagnoli) polynomial - same as used in iSCSI, ext4, etc.
    const CRC32C_TABLE: [u32; 256] = crc32c_table();

    let mut crc = 0xFFFFFFFF_u32;
    for &byte in data {
        let index = ((crc ^ byte as u32) & 0xFF) as usize;
        crc = CRC32C_TABLE[index] ^ (crc >> 8);
    }
    !crc
}

/// Generate CRC32-C lookup table at compile time
const fn crc32c_table() -> [u32; 256] {
    const POLY: u32 = 0x82F63B78; // CRC32-C polynomial
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut j = 0;
        while j < 8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ POLY;
            } else {
                crc >>= 1;
            }
            j += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

// ============================================================
// RELOAD OPERATION TRACKER
// ============================================================

/// Configuration for reload operations
#[derive(Debug, Clone)]
pub struct ReloadConfig {
    /// Timeout for worker to reach quiescence
    pub quiescence_timeout: Duration,
    /// Timeout for worker to produce snapshot
    pub snapshot_timeout: Duration,
    /// Timeout for worker to signal ReadyForKill
    pub ready_for_kill_timeout: Duration,
    /// Timeout for new worker to start and become ready
    pub spawn_timeout: Duration,
    /// Timeout for new worker to load module
    pub load_timeout: Duration,
    /// Maximum snapshot size per slot (bytes)
    pub max_snapshot_size: usize,
}

impl Default for ReloadConfig {
    fn default() -> Self {
        Self {
            quiescence_timeout: Duration::from_secs(5),
            snapshot_timeout: Duration::from_secs(10),
            ready_for_kill_timeout: Duration::from_secs(2),
            spawn_timeout: Duration::from_secs(10),
            load_timeout: Duration::from_secs(30),
            max_snapshot_size: 8 * 1024 * 1024, // 8 MB default
        }
    }
}

/// Tracks an in-progress reload operation
#[derive(Debug)]
pub struct ReloadOperation {
    pub id: ReloadId,
    pub slot: String,
    pub new_module_path: String,
    pub state: ReloadState,
    pub config: ReloadConfig,
    pub started_at: Instant,
    pub snapshot: Option<ValidatedSnapshot>,
    /// Per-slot snapshot size limits (overrides default)
    pub slot_max_snapshot_size: Option<usize>,
}

impl ReloadOperation {
    pub fn new(slot: String, new_module_path: String, config: ReloadConfig) -> Self {
        Self {
            id: ReloadId::new(),
            slot,
            new_module_path,
            state: ReloadState::Pending,
            config,
            started_at: Instant::now(),
            snapshot: None,
            slot_max_snapshot_size: None,
        }
    }

    /// Get the effective max snapshot size for this slot
    pub fn max_snapshot_size(&self) -> usize {
        self.slot_max_snapshot_size
            .unwrap_or(self.config.max_snapshot_size)
    }

    /// Check if operation has timed out in current state
    pub fn is_timed_out(&self) -> bool {
        match &self.state {
            ReloadState::Pending => false,
            ReloadState::AwaitingQuiescence { sent_at } => {
                sent_at.elapsed() > self.config.quiescence_timeout
            }
            ReloadState::AwaitingSnapshot { quiesced_at } => {
                quiesced_at.elapsed() > self.config.snapshot_timeout
            }
            ReloadState::AwaitingReadyForKill {
                snapshot_received_at,
            } => snapshot_received_at.elapsed() > self.config.ready_for_kill_timeout,
            ReloadState::ReadyToKill { .. } => false,
            ReloadState::Respawning { killed_at } => {
                killed_at.elapsed() > self.config.spawn_timeout
            }
            ReloadState::LoadingModule { spawned_at } => {
                spawned_at.elapsed() > self.config.load_timeout
            }
            ReloadState::Completed { .. } | ReloadState::Failed { .. } => false,
        }
    }

    /// Get timeout error for current state
    pub fn timeout_error(&self) -> Option<ReloadError> {
        match &self.state {
            ReloadState::AwaitingQuiescence { .. } => Some(ReloadError::QuiescenceTimeout {
                slot: self.slot.clone(),
                timeout_ms: self.config.quiescence_timeout.as_millis() as u64,
            }),
            ReloadState::AwaitingSnapshot { .. } => Some(ReloadError::SnapshotTimeout {
                slot: self.slot.clone(),
                timeout_ms: self.config.snapshot_timeout.as_millis() as u64,
            }),
            ReloadState::AwaitingReadyForKill { .. } => Some(ReloadError::ReadyForKillTimeout {
                slot: self.slot.clone(),
                timeout_ms: self.config.ready_for_kill_timeout.as_millis() as u64,
            }),
            ReloadState::Respawning { .. } => Some(ReloadError::SpawnFailed {
                reason: "Spawn timeout".to_string(),
            }),
            ReloadState::LoadingModule { .. } => Some(ReloadError::LoadFailed {
                slot: self.slot.clone(),
                reason: "Load timeout".to_string(),
            }),
            _ => None,
        }
    }

    /// Transition to next state
    pub fn transition(&mut self, new_state: ReloadState) {
        let old_state = std::mem::replace(&mut self.state, new_state);
        eprintln!(
            "[{}] State transition: {:?} -> {:?}",
            self.id, old_state, self.state
        );
    }

    /// Mark as completed
    pub fn complete(&mut self) {
        let duration = self.started_at.elapsed();
        self.state = ReloadState::Completed { duration };
        eprintln!("[{}] Reload completed in {:?}", self.id, duration);
    }

    /// Mark as failed
    pub fn fail(&mut self, error: ReloadError) {
        let duration = self.started_at.elapsed();
        eprintln!(
            "[{}] Reload failed after {:?}: {}",
            self.id, duration, error
        );
        self.state = ReloadState::Failed { error, duration };
    }
}

// ============================================================
// SLOT-SPECIFIC SNAPSHOT LIMITS
// ============================================================

/// Per-slot configuration for snapshot handling
#[derive(Debug, Clone)]
pub struct SlotSnapshotConfig {
    /// Maximum snapshot size in bytes
    pub max_size: usize,
    /// Whether this slot supports snapshots at all
    pub snapshots_enabled: bool,
    /// MsgPack decode limits
    pub decode_limits: MsgPackDecodeLimits,
}

impl Default for SlotSnapshotConfig {
    fn default() -> Self {
        Self {
            max_size: 8 * 1024 * 1024, // 8 MB
            snapshots_enabled: true,
            decode_limits: MsgPackDecodeLimits::default(),
        }
    }
}

/// Limits for MsgPack decoding to prevent DoS
#[derive(Debug, Clone)]
pub struct MsgPackDecodeLimits {
    /// Maximum nesting depth for maps/arrays
    pub max_depth: u32,
    /// Maximum number of elements in a map
    pub max_map_size: u32,
    /// Maximum number of elements in an array
    pub max_array_size: u32,
    /// Maximum length of a string
    pub max_string_len: u32,
    /// Maximum length of binary data
    pub max_bin_len: u32,
}

impl Default for MsgPackDecodeLimits {
    fn default() -> Self {
        Self {
            max_depth: 32,
            max_map_size: 10_000,
            max_array_size: 100_000,
            max_string_len: 1024 * 1024,  // 1 MB
            max_bin_len: 8 * 1024 * 1024, // 8 MB
        }
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reload_id_unique() {
        let id1 = ReloadId::new();
        let id2 = ReloadId::new();
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_crc32_checksum() {
        let data = b"hello world";
        let checksum = crc32_checksum(data);
        // Verify it's consistent
        assert_eq!(checksum, crc32_checksum(data));
        // Verify different data gives different checksum
        assert_ne!(checksum, crc32_checksum(b"hello world!"));
    }

    #[test]
    fn test_snapshot_validation() {
        let data = vec![1, 2, 3, 4, 5];
        let checksum = crc32_checksum(&data);

        // Valid snapshot
        let result = ValidatedSnapshot::validate(data.clone(), 1, 12345, checksum, 1024);
        assert!(result.is_ok());

        // Wrong checksum
        let result = ValidatedSnapshot::validate(data.clone(), 1, 12345, checksum + 1, 1024);
        assert!(result.is_err());

        // Too large
        let result = ValidatedSnapshot::validate(
            data.clone(),
            1,
            12345,
            checksum,
            4, // Max 4 bytes but data is 5
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_reload_timeout_detection() {
        let config = ReloadConfig {
            quiescence_timeout: Duration::from_millis(10),
            ..Default::default()
        };

        let mut op =
            ReloadOperation::new("test".to_string(), "/path/to/module".to_string(), config);

        op.state = ReloadState::AwaitingQuiescence {
            sent_at: Instant::now() - Duration::from_millis(20),
        };

        assert!(op.is_timed_out());
        assert!(matches!(
            op.timeout_error(),
            Some(ReloadError::QuiescenceTimeout { .. })
        ));
    }
}
