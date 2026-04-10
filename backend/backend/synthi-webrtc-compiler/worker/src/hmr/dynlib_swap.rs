// ============================================================
// DYNAMIC LIBRARY SWAP PROTOCOL
// ============================================================
// The wire protocol for in-process dynamic library hot-swap.
// Defines the message types exchanged between the supervisor
// and the worker during a warm reload via dlopen/dlsym.
// ============================================================


use serde::{Deserialize, Serialize};

/// Messages sent from supervisor → worker for dynamic lib swap.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd")]
pub enum SwapCommand {
    /// Tell the worker to quiesce (finish current frame, stop ticking).
    #[serde(rename = "quiesce")]
    Quiesce {
        /// Timeout in milliseconds. Worker must ack before this.
        timeout_ms: u64,
    },

    /// Tell the worker to snapshot its state (serialize via module ABI).
    #[serde(rename = "snapshot")]
    Snapshot {
        /// Which module slot to snapshot.
        slot: String,
        /// State format version.
        format_version: u32,
    },

    /// Tell the worker to unload the old library and load the new one.
    #[serde(rename = "swap")]
    Swap {
        /// Module slot.
        slot: String,
        /// Path to the new shared library.
        new_lib_path: String,
        /// ABI version of the new library.
        new_abi_version: String,
        /// Exported symbols to verify after load.
        required_symbols: Vec<String>,
    },

    /// Tell the worker to restore state from a snapshot.
    #[serde(rename = "restore")]
    Restore {
        slot: String,
        /// State bytes (will be base64 in JSON).
        #[serde(with = "base64_bytes")]
        snapshot: Vec<u8>,
        format_version: u32,
    },

    /// Tell the worker to resume ticking (end quiescence).
    #[serde(rename = "resume")]
    Resume,

    /// Abort the swap and rollback to the old library.
    #[serde(rename = "abort")]
    Abort { reason: String },
}

/// Messages sent from worker → supervisor during dynamic lib swap.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "ack")]
pub enum SwapAck {
    /// Worker is quiesced (idle, no frames in flight).
    #[serde(rename = "quiesced")]
    Quiesced,

    /// Worker has produced a state snapshot.
    #[serde(rename = "snapshot_ready")]
    SnapshotReady {
        slot: String,
        #[serde(with = "base64_bytes")]
        data: Vec<u8>,
        format_version: u32,
        size_bytes: usize,
    },

    /// Library swap completed successfully.
    #[serde(rename = "swapped")]
    Swapped {
        slot: String,
        new_lib_path: String,
        symbols_verified: Vec<String>,
        load_time_ms: u64,
    },

    /// State restored from snapshot.
    #[serde(rename = "restored")]
    Restored {
        slot: String,
        restore_time_ms: u64,
    },

    /// Worker has resumed ticking.
    #[serde(rename = "resumed")]
    Resumed,

    /// Something went wrong during the swap.
    #[serde(rename = "error")]
    Error {
        phase: String,
        message: String,
    },
}

/// Phases of the dynamic library swap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SwapPhase {
    Idle,
    Quiescing,
    Snapshotting,
    Swapping,
    Restoring,
    Resuming,
    Completed,
    Failed,
    Aborted,
}

impl SwapPhase {
    pub fn is_terminal(&self) -> bool {
        matches!(self, SwapPhase::Completed | SwapPhase::Failed | SwapPhase::Aborted)
    }
}

/// base64 serde adapter for Vec<u8> fields.
mod base64_bytes {
    use serde::{Deserialize, Deserializer, Serializer};
    use base64::{engine::general_purpose::STANDARD, Engine};

    pub fn serialize<S>(bytes: &Vec<u8>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let encoded = STANDARD.encode(bytes);
        serializer.serialize_str(&encoded)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        STANDARD.decode(&s).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_command_serialization() {
        let cmd = SwapCommand::Swap {
            slot: "gui".into(),
            new_lib_path: "/tmp/gui.so".into(),
            new_abi_version: "2.0".into(),
            required_symbols: vec!["on_render".into(), "on_event".into()],
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"cmd\":\"swap\""));
        assert!(json.contains("on_render"));
    }

    #[test]
    fn swap_ack_serialization() {
        let ack = SwapAck::Swapped {
            slot: "gui".into(),
            new_lib_path: "/tmp/gui.so".into(),
            symbols_verified: vec!["on_render".into()],
            load_time_ms: 42,
        };
        let json = serde_json::to_string(&ack).unwrap();
        assert!(json.contains("\"ack\":\"swapped\""));
    }

    #[test]
    fn phase_terminal() {
        assert!(!SwapPhase::Quiescing.is_terminal());
        assert!(SwapPhase::Completed.is_terminal());
        assert!(SwapPhase::Failed.is_terminal());
        assert!(SwapPhase::Aborted.is_terminal());
    }
}
