// ============================================================
// PROCESS SWAP STATE TRANSFER
// ============================================================
// Transfers application state between old and new processes
// during a process-swap reload.  Uses stdout/stdin pipes or
// a temporary file for large state payloads.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Transport method for inter-process state transfer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StateTransport {
    /// Pipe state through stdin/stdout.
    StdioPipe,
    /// Shared memory segment.
    SharedMemory,
    /// Temporary file.
    TempFile,
    /// Unix domain socket.
    UnixSocket,
}

/// Configuration for state transfer.
#[derive(Debug, Clone)]
pub struct StateTransferConfig {
    /// Transport to use.
    pub transport: StateTransport,
    /// Maximum payload size (bytes).
    pub max_payload_bytes: usize,
    /// Timeout for the transfer (millis).
    pub timeout_ms: u64,
    /// Whether to compress the payload.
    pub compress: bool,
    /// Threshold above which to use TempFile instead of pipe.
    pub pipe_size_threshold: usize,
}

impl Default for StateTransferConfig {
    fn default() -> Self {
        Self {
            transport: StateTransport::StdioPipe,
            max_payload_bytes: 64 * 1024 * 1024, // 64 MB
            timeout_ms: 10_000,
            compress: false,
            pipe_size_threshold: 1024 * 1024, // 1 MB → switch to file
        }
    }
}

/// A state payload ready for transfer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatePayload {
    pub data: Vec<u8>,
    pub original_size: usize,
    pub compressed: bool,
    pub checksum: u32,
}

impl StatePayload {
    /// Create a payload from raw bytes.
    pub fn from_bytes(data: Vec<u8>, compress: bool) -> Self {
        let original_size = data.len();
        let checksum = crc32_simple(&data);
        Self {
            data,
            original_size,
            compressed: compress, // actual compression would happen here
            checksum,
        }
    }

    /// Verify checksum on receive side.
    pub fn verify_checksum(&self) -> bool {
        crc32_simple(&self.data) == self.checksum
    }
}

/// Simple CRC32 for integrity checking (non-cryptographic).
fn crc32_simple(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            if crc & 1 == 1 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

/// Pick the best transport for a given payload size.
pub fn select_transport(size_bytes: usize, config: &StateTransferConfig) -> StateTransport {
    if size_bytes > config.max_payload_bytes {
        // Too large; will fail, but TempFile is best bet.
        StateTransport::TempFile
    } else if size_bytes > config.pipe_size_threshold {
        StateTransport::TempFile
    } else {
        config.transport
    }
}

/// Result of state transfer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateTransferResult {
    pub transport: StateTransport,
    pub bytes_transferred: usize,
    pub duration_ms: u64,
    pub checksum_valid: bool,
    pub success: bool,
}

/// Simulate executing a state transfer.
pub fn execute_state_transfer(
    payload: &StatePayload,
    transport: StateTransport,
    simulated_duration_ms: u64,
) -> StateTransferResult {
    let checksum_valid = payload.verify_checksum();
    StateTransferResult {
        transport,
        bytes_transferred: payload.data.len(),
        duration_ms: simulated_duration_ms,
        checksum_valid,
        success: checksum_valid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_checksum_roundtrip() {
        let payload = StatePayload::from_bytes(b"game state data".to_vec(), false);
        assert!(payload.verify_checksum());
    }

    #[test]
    fn corrupted_payload_fails_checksum() {
        let mut payload = StatePayload::from_bytes(b"original".to_vec(), false);
        payload.data[0] = b'X'; // corrupt
        assert!(!payload.verify_checksum());
    }

    #[test]
    fn large_payload_uses_tempfile() {
        let config = StateTransferConfig::default();
        let transport = select_transport(2 * 1024 * 1024, &config);
        assert_eq!(transport, StateTransport::TempFile);
    }

    #[test]
    fn small_payload_uses_pipe() {
        let config = StateTransferConfig::default();
        let transport = select_transport(512, &config);
        assert_eq!(transport, StateTransport::StdioPipe);
    }

    #[test]
    fn transfer_succeeds_with_valid_checksum() {
        let payload = StatePayload::from_bytes(b"test".to_vec(), false);
        let result = execute_state_transfer(&payload, StateTransport::StdioPipe, 5);
        assert!(result.success);
        assert!(result.checksum_valid);
    }
}
