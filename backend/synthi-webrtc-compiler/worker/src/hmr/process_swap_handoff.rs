// ============================================================
// PROCESS SWAP HANDOFF PROTOCOL
// ============================================================
// Defines the IPC handoff protocol between old and new processes
// in the ProcessSwap adapter family.  State is transferred via
// a structured envelope over stdin/stdout pipes.
// ============================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

/// Envelope format for IPC state transfer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffEnvelope {
    /// Protocol version.
    pub version: u32,
    /// Module that owns this state.
    pub module_id: String,
    /// Schema version of the state payload.
    pub schema_version: u32,
    /// Serialized state bytes.
    pub payload: Vec<u8>,
    /// Checksum (CRC32) of the payload for integrity.
    pub checksum: u32,
    /// Timestamp when the state was exported (epoch ms).
    pub exported_at_ms: u64,
}

impl HandoffEnvelope {
    /// Current protocol version.
    pub const CURRENT_VERSION: u32 = 1;

    /// Create a new envelope.
    pub fn new(module_id: &str, schema_version: u32, payload: Vec<u8>, now_ms: u64) -> Self {
        let checksum = crc32_simple(&payload);
        Self {
            version: Self::CURRENT_VERSION,
            module_id: module_id.into(),
            schema_version,
            payload,
            checksum,
            exported_at_ms: now_ms,
        }
    }

    /// Validate integrity.
    pub fn validate(&self) -> Result<(), String> {
        if self.version != Self::CURRENT_VERSION {
            return Err(format!(
                "unsupported handoff version: {} (expected {})",
                self.version,
                Self::CURRENT_VERSION
            ));
        }
        let computed = crc32_simple(&self.payload);
        if computed != self.checksum {
            return Err(format!(
                "checksum mismatch: computed 0x{:08x}, expected 0x{:08x}",
                computed, self.checksum
            ));
        }
        Ok(())
    }
}

pub fn write_envelope<W: Write>(
    writer: &mut W,
    envelope: &HandoffEnvelope,
) -> Result<usize, String> {
    let encoded = rmp_serde::to_vec(envelope)
        .map_err(|error| format!("failed to serialize handoff envelope: {}", error))?;
    writer
        .write_all(&encoded)
        .map_err(|error| format!("failed to write handoff envelope: {}", error))?;
    writer
        .flush()
        .map_err(|error| format!("failed to flush handoff envelope: {}", error))?;
    Ok(encoded.len())
}

pub fn read_envelope<R: Read>(reader: &mut R) -> Result<HandoffEnvelope, String> {
    let mut encoded = Vec::new();
    reader
        .read_to_end(&mut encoded)
        .map_err(|error| format!("failed to read handoff envelope: {}", error))?;
    let envelope: HandoffEnvelope = rmp_serde::from_slice(&encoded)
        .map_err(|error| format!("failed to decode handoff envelope: {}", error))?;
    envelope.validate()?;
    Ok(envelope)
}

pub fn write_envelope_to_path(envelope: &HandoffEnvelope, path: &Path) -> Result<usize, String> {
    let encoded = rmp_serde::to_vec(envelope)
        .map_err(|error| format!("failed to serialize handoff envelope: {}", error))?;
    fs::write(path, &encoded).map_err(|error| {
        format!(
            "failed to persist handoff envelope to {:?}: {}",
            path, error
        )
    })?;
    Ok(encoded.len())
}

pub fn read_envelope_from_path(path: &Path) -> Result<HandoffEnvelope, String> {
    let encoded = fs::read(path)
        .map_err(|error| format!("failed to read handoff envelope from {:?}: {}", path, error))?;
    let envelope: HandoffEnvelope = rmp_serde::from_slice(&encoded)
        .map_err(|error| format!("failed to decode handoff envelope: {}", error))?;
    envelope.validate()?;
    Ok(envelope)
}

/// The handoff phases from the old process's perspective.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HandoffPhase {
    /// Old process: quiesce, stop accepting work.
    Quiesce,
    /// Old process: export state into envelope.
    ExportState,
    /// Transfer: pipe envelope to new process.
    Transfer,
    /// New process: import state from envelope.
    ImportState,
    /// New process: signal readiness.
    Ready,
    /// Old process: terminate.
    Retire,
}

/// Result of one handoff phase.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffStepResult {
    pub phase: HandoffPhase,
    pub success: bool,
    pub duration_ms: u64,
    pub note: String,
}

/// Full handoff report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffReport {
    pub module_id: String,
    pub old_pid: u32,
    pub new_pid: u32,
    pub steps: Vec<HandoffStepResult>,
    pub envelope_bytes: usize,
    pub total_ms: u64,
    pub success: bool,
}

/// Execute the full handoff protocol (simulation).
pub fn execute_handoff(
    module_id: &str,
    old_pid: u32,
    new_pid: u32,
    state: Option<&[u8]>,
    schema_version: u32,
    now_ms: u64,
) -> HandoffReport {
    let mut steps = Vec::new();
    let mut envelope_bytes = 0;

    // Phase 1: Quiesce
    steps.push(HandoffStepResult {
        phase: HandoffPhase::Quiesce,
        success: true,
        duration_ms: 10,
        note: format!("pid {} quiesced", old_pid),
    });

    // Phase 2: Export
    let envelope = state.map(|s| {
        let env = HandoffEnvelope::new(module_id, schema_version, s.to_vec(), now_ms);
        envelope_bytes = env.payload.len();
        env
    });

    steps.push(HandoffStepResult {
        phase: HandoffPhase::ExportState,
        success: true,
        duration_ms: if envelope.is_some() { 15 } else { 1 },
        note: format!("exported {} bytes", envelope_bytes),
    });

    // Phase 3: Transfer
    let transfer_ok = if let Some(ref env) = envelope {
        env.validate().is_ok()
    } else {
        true // no state to transfer
    };
    steps.push(HandoffStepResult {
        phase: HandoffPhase::Transfer,
        success: transfer_ok,
        duration_ms: 20,
        note: if transfer_ok {
            "pipe transfer ok".into()
        } else {
            "checksum mismatch".into()
        },
    });

    if !transfer_ok {
        let total_ms = steps.iter().map(|s| s.duration_ms).sum();
        return HandoffReport {
            module_id: module_id.into(),
            old_pid,
            new_pid,
            steps,
            envelope_bytes,
            total_ms,
            success: false,
        };
    }

    // Phase 4: Import
    steps.push(HandoffStepResult {
        phase: HandoffPhase::ImportState,
        success: true,
        duration_ms: if envelope.is_some() { 10 } else { 1 },
        note: format!("pid {} imported state", new_pid),
    });

    // Phase 5: Ready
    steps.push(HandoffStepResult {
        phase: HandoffPhase::Ready,
        success: true,
        duration_ms: 5,
        note: format!("pid {} ready", new_pid),
    });

    // Phase 6: Retire old
    steps.push(HandoffStepResult {
        phase: HandoffPhase::Retire,
        success: true,
        duration_ms: 5,
        note: format!("pid {} retired", old_pid),
    });

    let total_ms = steps.iter().map(|s| s.duration_ms).sum();
    HandoffReport {
        module_id: module_id.into(),
        old_pid,
        new_pid,
        steps,
        envelope_bytes,
        total_ms,
        success: true,
    }
}

/// Simple CRC32 for payload integrity (not cryptographic).
fn crc32_simple(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_roundtrip() {
        let envelope = HandoffEnvelope::new("mod_a", 1, b"hello state".to_vec(), 1000);
        assert!(envelope.validate().is_ok());
    }

    #[test]
    fn envelope_detects_corruption() {
        let mut envelope = HandoffEnvelope::new("mod_a", 1, b"hello".to_vec(), 1000);
        envelope.payload.push(0xFF); // corrupt
        assert!(envelope.validate().is_err());
    }

    #[test]
    fn handoff_with_state() {
        let report = execute_handoff("app", 100, 200, Some(b"state data"), 1, 1000);
        assert!(report.success);
        assert_eq!(report.steps.len(), 6);
        assert!(report.envelope_bytes > 0);
    }

    #[test]
    fn handoff_without_state() {
        let report = execute_handoff("app", 100, 200, None, 1, 1000);
        assert!(report.success);
        assert_eq!(report.envelope_bytes, 0);
    }
}
