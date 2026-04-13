// ============================================================
// PROCESS SWAP SOCKET HANDOFF
// ============================================================
// Logic for passing listening sockets from the old process to
// the new one during a process-swap reload (Go / Swift).
// Uses fd-passing on Unix or named pipes on Windows.
// ============================================================


use serde::{Deserialize, Serialize};

/// Method used to transfer a listening socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SocketHandoffMethod {
    /// Unix domain socket fd-passing (sendmsg + SCM_RIGHTS).
    FdPassing,
    /// LISTEN_FDS / systemd socket activation.
    SystemdActivation,
    /// Named pipe (Windows).
    NamedPipe,
    /// Close-and-rebind (no real handoff; brief downtime).
    CloseRebind,
}

impl SocketHandoffMethod {
    /// Pick best method for the current platform.
    pub fn default_for_platform() -> Self {
        if cfg!(target_os = "windows") {
            Self::NamedPipe
        } else {
            Self::FdPassing
        }
    }
}

/// Description of a socket to transfer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocketDescriptor {
    /// Unique id for this socket.
    pub id: String,
    /// Address the socket is bound to.
    pub bind_address: String,
    /// Port number.
    pub port: u16,
    /// Whether it's a TCP or Unix socket.
    pub kind: SocketKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SocketKind {
    Tcp,
    Unix,
}

/// Configuration for socket handoff.
#[derive(Debug, Clone)]
pub struct SocketHandoffConfig {
    pub method: SocketHandoffMethod,
    /// Timeout for the handoff operation (millis).
    pub handoff_timeout_ms: u64,
    /// Whether to verify the new process is listening after handoff.
    pub verify_listening: bool,
}

impl Default for SocketHandoffConfig {
    fn default() -> Self {
        Self {
            method: SocketHandoffMethod::default_for_platform(),
            handoff_timeout_ms: 5000,
            verify_listening: true,
        }
    }
}

/// Result of attempting socket handoff.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocketHandoffResult {
    pub socket_id: String,
    pub method: SocketHandoffMethod,
    pub success: bool,
    pub duration_ms: u64,
    pub error: Option<String>,
}

/// Plan a socket handoff for N sockets.
pub fn plan_socket_handoff(
    sockets: &[SocketDescriptor],
    config: &SocketHandoffConfig,
) -> Vec<SocketHandoffPlan> {
    sockets
        .iter()
        .map(|s| SocketHandoffPlan {
            socket: s.clone(),
            method: config.method,
            timeout_ms: config.handoff_timeout_ms,
        })
        .collect()
}

/// A planned handoff for one socket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocketHandoffPlan {
    pub socket: SocketDescriptor,
    pub method: SocketHandoffMethod,
    pub timeout_ms: u64,
}

/// Simulate executing a socket handoff.
pub fn execute_socket_handoff(
    plan: &SocketHandoffPlan,
    simulated_duration_ms: u64,
    simulated_success: bool,
) -> SocketHandoffResult {
    SocketHandoffResult {
        socket_id: plan.socket.id.clone(),
        method: plan.method,
        success: simulated_success,
        duration_ms: simulated_duration_ms,
        error: if simulated_success {
            None
        } else {
            Some("simulated handoff failure".into())
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_socket() -> SocketDescriptor {
        SocketDescriptor {
            id: "http".into(),
            bind_address: "0.0.0.0".into(),
            port: 8080,
            kind: SocketKind::Tcp,
        }
    }

    #[test]
    fn plans_all_sockets() {
        let sockets = vec![test_socket()];
        let plans = plan_socket_handoff(&sockets, &SocketHandoffConfig::default());
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].socket.port, 8080);
    }

    #[test]
    fn execute_success() {
        let plan = SocketHandoffPlan {
            socket: test_socket(),
            method: SocketHandoffMethod::FdPassing,
            timeout_ms: 5000,
        };
        let result = execute_socket_handoff(&plan, 12, true);
        assert!(result.success);
        assert!(result.error.is_none());
    }

    #[test]
    fn execute_failure() {
        let plan = SocketHandoffPlan {
            socket: test_socket(),
            method: SocketHandoffMethod::FdPassing,
            timeout_ms: 5000,
        };
        let result = execute_socket_handoff(&plan, 5001, false);
        assert!(!result.success);
        assert!(result.error.is_some());
    }
}
