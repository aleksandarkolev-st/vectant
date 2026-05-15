// ============================================================
// MANAGED AGENT PROTOCOL
// ============================================================
// Defines the wire protocol between the HMR host and the
// in-process agent injected into JVM / .NET managed runtimes.
// The agent receives commands over a local socket and reports
// status back.
// ============================================================

use serde::{Deserialize, Serialize};

/// Protocol version.
pub const AGENT_PROTOCOL_VERSION: u32 = 1;

/// Commands sent from host → agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentCommand {
    /// Handshake / version check.
    Hello {
        protocol_version: u32,
        host_id: String,
    },
    /// Prepare for an incoming reload.
    PrepareReload {
        reload_id: String,
        artifact_path: String,
        changed_classes: Vec<String>,
    },
    /// Commit the prepared reload (make it live).
    CommitReload { reload_id: String },
    /// Roll back a prepared but uncommitted reload.
    RollbackReload { reload_id: String },
    /// Ask the agent to export current state.
    ExportState { format: StateTransferFormat },
    /// Send state to the agent for import.
    ImportState {
        format: StateTransferFormat,
        data: Vec<u8>,
    },
    /// Request health status.
    Ping,
    /// Tell the agent to shut down.
    Shutdown,
}

/// Responses sent from agent → host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentResponse {
    /// Handshake acknowledgement.
    HelloAck {
        agent_version: String,
        runtime_kind: String,
        protocol_version: u32,
    },
    /// Reload prepared and ready to commit.
    ReloadPrepared {
        reload_id: String,
        classes_affected: usize,
    },
    /// Reload committed successfully.
    ReloadCommitted { reload_id: String, duration_ms: u64 },
    /// Reload rolled back.
    ReloadRolledBack { reload_id: String },
    /// State export result.
    StateExported {
        format: StateTransferFormat,
        data: Vec<u8>,
        size_bytes: usize,
    },
    /// State imported.
    StateImported {
        format: StateTransferFormat,
        size_bytes: usize,
    },
    /// Health response.
    Pong {
        uptime_ms: u64,
        reload_count: u32,
        healthy: bool,
    },
    /// Error from agent.
    Error { code: String, message: String },
    /// Agent shutting down.
    ShutdownAck,
}

/// Format for state transfer over the protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StateTransferFormat {
    Json,
    Binary,
}

/// A framed message envelope for the protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolFrame {
    pub sequence: u64,
    pub payload: FramePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FramePayload {
    Command(AgentCommand),
    Response(AgentResponse),
}

impl ProtocolFrame {
    pub fn command(seq: u64, cmd: AgentCommand) -> Self {
        Self {
            sequence: seq,
            payload: FramePayload::Command(cmd),
        }
    }

    pub fn response(seq: u64, resp: AgentResponse) -> Self {
        Self {
            sequence: seq,
            payload: FramePayload::Response(resp),
        }
    }
}

/// Validate that a Hello/HelloAck handshake is compatible.
pub fn validate_handshake(host_version: u32, agent_version: u32) -> Result<(), String> {
    if host_version != agent_version {
        Err(format!(
            "protocol mismatch: host v{} vs agent v{}",
            host_version, agent_version
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_compatible() {
        assert!(validate_handshake(1, 1).is_ok());
    }

    #[test]
    fn handshake_mismatch() {
        assert!(validate_handshake(1, 2).is_err());
    }

    #[test]
    fn frame_roundtrip() {
        let frame = ProtocolFrame::command(
            1,
            AgentCommand::Hello {
                protocol_version: AGENT_PROTOCOL_VERSION,
                host_id: "hmr-host-1".into(),
            },
        );
        let json = serde_json::to_string(&frame).unwrap();
        let parsed: ProtocolFrame = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.sequence, 1);
    }

    #[test]
    fn error_response() {
        let resp = AgentResponse::Error {
            code: "CLASS_NOT_FOUND".into(),
            message: "com.example.Foo not in classpath".into(),
        };
        let frame = ProtocolFrame::response(42, resp);
        match &frame.payload {
            FramePayload::Response(AgentResponse::Error { code, .. }) => {
                assert_eq!(code, "CLASS_NOT_FOUND");
            }
            _ => panic!("expected error response"),
        }
    }
}
