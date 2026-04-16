// ============================================================
// SUPERVISOR (Phase 12.6d — §7.2 12a)
// ============================================================
//
// Manages the lifecycle of a per-session child runner:
//   1. Allocate per-session Xvfb via XvfbAllocator
//   2. Create Unix socket for IPC
//   3. Spawn child runner with DISPLAY + SYNTHI_HMR_SOCKET env
//   4. Accept IPC connection, perform handshake
//   5. Forward Load/Reload/PatchBytes commands from the worker
//   6. Receive WindowDiscovered from child for GStreamer targeting
//
// The supervisor does NOT own GStreamer/WebRTC — that stays in the
// worker's handle_runner_execution. The supervisor just provides:
//   - A per-session display (not shared :99)
//   - Typed IPC replacing stdin text protocol
//   - Two-phase window discovery

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::net::{UnixListener, UnixStream};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use std::time::Duration;

use super::hmr_protocol::*;
use super::ipc_transport::*;
use super::xvfb_allocator::XvfbAllocator;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// State for a supervised session.
pub struct SupervisedSession {
    pub session_id: String,
    pub display_str: String,
    pub child_process: Child,
    pub ipc_stream: UnixStream,
    pub child_pid: u32,
    pub negotiated_version: u8,
    pub child_capabilities: Vec<String>,
    pub x11_window_id: Option<u64>,
    next_command_id: u64,
}

impl SupervisedSession {
    fn next_id(&mut self) -> u64 {
        let id = self.next_command_id;
        self.next_command_id += 1;
        id
    }

    /// Send a Load command and wait for Ack.
    pub async fn load_module(&mut self, module_name: &str, so_path: &str) -> Result<()> {
        let id = self.next_id();
        let cmd = HmrCommand::Load {
            command_id: id,
            module_name: module_name.to_string(),
            so_path: so_path.to_string(),
        };
        send_command(&mut self.ipc_stream, &cmd).await?;
        self.wait_ack(id).await
    }

    /// Send a Reload command and wait for Ack.
    pub async fn reload_module(&mut self, module_name: &str, so_path: &str) -> Result<()> {
        let id = self.next_id();
        let cmd = HmrCommand::Reload {
            command_id: id,
            module_name: module_name.to_string(),
            so_path: so_path.to_string(),
        };
        send_command(&mut self.ipc_stream, &cmd).await?;
        self.wait_ack(id).await
    }

    /// Send a PatchBytes command for live memory patching.
    pub async fn patch_bytes(
        &mut self,
        module_name: &str,
        file_offset: u64,
        bytes_hex: &str,
    ) -> Result<()> {
        let id = self.next_id();
        let cmd = HmrCommand::PatchBytes {
            command_id: id,
            module_name: module_name.to_string(),
            file_offset,
            bytes_hex: bytes_hex.to_string(),
        };
        send_command(&mut self.ipc_stream, &cmd).await?;
        self.wait_ack(id).await
    }

    /// Send a SetSession command.
    pub async fn set_session(&mut self, session_id: &str) -> Result<()> {
        let id = self.next_id();
        let cmd = HmrCommand::SetSession {
            command_id: id,
            session_id: session_id.to_string(),
        };
        send_command(&mut self.ipc_stream, &cmd).await?;
        self.wait_ack(id).await
    }

    /// Graceful shutdown.
    pub async fn shutdown(&mut self) -> Result<()> {
        let id = self.next_id();
        let cmd = HmrCommand::Shutdown { command_id: id };
        send_command(&mut self.ipc_stream, &cmd).await?;
        // Don't wait for ack — child may exit immediately
        let _ = self.child_process.wait().await;
        Ok(())
    }

    async fn wait_ack(&mut self, expected_id: u64) -> Result<()> {
        loop {
            let resp = tokio::time::timeout(
                Duration::from_secs(10),
                recv_response(&mut self.ipc_stream),
            )
            .await
            .context("timeout waiting for IPC response")?
            .context("recv IPC response")?;

            match resp {
                HmrResponse::Ack { command_id } if command_id == expected_id => return Ok(()),
                HmrResponse::Error {
                    command_id,
                    code,
                    message,
                } if command_id == expected_id => {
                    anyhow::bail!("child error [{}]: {}", code, message)
                }
                HmrResponse::WindowDiscovered { x11_window_id } => {
                    self.x11_window_id = Some(x11_window_id);
                    eprintln!(
                        "[Supervisor] window discovered: {:#x}",
                        x11_window_id
                    );
                    continue;
                }
                other => anyhow::bail!(
                    "unexpected response (expected ack for {}): {:?}",
                    expected_id,
                    other
                ),
            }
        }
    }
}

/// Spawn a supervised session: Xvfb + child + IPC handshake.
pub async fn spawn_supervised(
    allocator: &mut XvfbAllocator,
    session_id: &str,
    runner_bin: &Path,
    build_dir: &Path,
    width: u32,
    height: u32,
) -> Result<SupervisedSession> {
    // 1. Allocate per-session Xvfb
    let display_str = allocator
        .allocate(session_id, width, height)
        .await
        .context("allocate Xvfb")?;

    // 2. Create IPC socket
    let sock_path = socket_path(session_id);
    let _ = std::fs::remove_file(&sock_path);
    let listener = UnixListener::bind(&sock_path)
        .with_context(|| format!("bind {}", sock_path))?;

    // 3. Spawn child runner
    let mut child = Command::new(runner_bin)
        .env("DISPLAY", &display_str)
        .env("SYNTHI_HMR_SOCKET", &sock_path)
        .env("SYNTHI_SESSION_ID", session_id)
        .env(
            "LD_LIBRARY_PATH",
            std::env::var("LD_LIBRARY_PATH").unwrap_or_default(),
        )
        .current_dir(build_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("spawn {}", runner_bin.display()))?;

    let child_pid = child.id().unwrap_or(0);
    eprintln!(
        "[Supervisor] spawned child pid={} on display={} socket={}",
        child_pid, display_str, sock_path
    );

    // 4. Accept IPC connection (with timeout)
    let (mut stream, _) = tokio::time::timeout(CONNECT_TIMEOUT, listener.accept())
        .await
        .context("timeout waiting for child to connect")?
        .context("accept IPC connection")?;

    // 5. Handshake
    let handshake = HmrCommand::Handshake {
        supervisor_version: PROTOCOL_VERSION_CURRENT,
        supervisor_min_supported: PROTOCOL_VERSION_MIN_SUPPORTED,
        supervisor_capabilities: default_supervisor_capabilities(),
    };
    send_command(&mut stream, &handshake).await?;

    let ack = tokio::time::timeout(HANDSHAKE_TIMEOUT, recv_response(&mut stream))
        .await
        .context("handshake timeout (child didn't respond within 5s)")?
        .context("recv handshake ack")?;

    let (child_version, child_min, child_caps) = match ack {
        HmrResponse::HandshakeAck {
            child_version,
            child_min_supported,
            child_capabilities,
        } => (child_version, child_min_supported, child_capabilities),
        other => anyhow::bail!("expected HandshakeAck, got {:?}", other),
    };

    if !versions_compatible(
        PROTOCOL_VERSION_CURRENT,
        PROTOCOL_VERSION_MIN_SUPPORTED,
        child_version,
        child_min,
    ) {
        anyhow::bail!(
            "version mismatch: supervisor={}/{} child={}/{}",
            PROTOCOL_VERSION_CURRENT,
            PROTOCOL_VERSION_MIN_SUPPORTED,
            child_version,
            child_min
        );
    }

    let neg_ver = negotiated_version(PROTOCOL_VERSION_CURRENT, child_version);
    eprintln!(
        "[Supervisor] handshake OK: negotiated v{}, child caps={:?}",
        neg_ver, child_caps
    );

    // Cleanup socket file on success (child already connected)
    let _ = std::fs::remove_file(&sock_path);

    Ok(SupervisedSession {
        session_id: session_id.to_string(),
        display_str,
        child_process: child,
        ipc_stream: stream,
        child_pid,
        negotiated_version: neg_ver,
        child_capabilities: child_caps,
        x11_window_id: None,
        next_command_id: 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_path_format() {
        let p = socket_path("session-abc123");
        assert_eq!(p, "/tmp/synthi_hmr_session-abc123.sock");
    }
}
