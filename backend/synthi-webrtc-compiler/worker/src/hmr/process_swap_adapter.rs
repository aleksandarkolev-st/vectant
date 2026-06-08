// ============================================================
// PROCESS SWAP ADAPTER
// ============================================================
// Implements the Adapter trait for the ProcessSwap family
// (Go, Swift).  These languages produce static binaries that
// can't be hot-swapped in-process, so we spawn a new process
// with the new binary and hand off state via IPC.
// ============================================================

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tempfile::TempDir;

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::adapter_trait::{
    Adapter, AdapterHealth, AdapterInfo, AdapterReloadRequest, AdapterReloadResult,
};
use crate::hmr::process_swap_drain::{drain_child_process, DrainConfig, DrainResult};
use crate::hmr::process_swap_handoff::{
    read_envelope_from_path, write_envelope, write_envelope_to_path, HandoffEnvelope,
};
use crate::hmr::process_swap_state_transfer::{
    select_transport, StateTransferConfig, StateTransport,
};

/// Configuration for the process-swap adapter.
#[derive(Debug, Clone)]
pub struct ProcessSwapConfig {
    /// Languages this instance handles.
    pub languages: Vec<String>,
    /// Maximum time to wait for the new process to become ready (ms).
    pub startup_timeout_ms: u64,
    /// Maximum time for the state handoff IPC (ms).
    pub handoff_timeout_ms: u64,
    /// How many old processes to keep alive during overlap.
    pub overlap_window: u32,
    /// Whether to run the new process in a separate cgroup/namespace.
    pub isolate_new_process: bool,
}

impl Default for ProcessSwapConfig {
    fn default() -> Self {
        Self {
            languages: vec!["go".into(), "swift".into()],
            startup_timeout_ms: 5000,
            handoff_timeout_ms: 3000,
            overlap_window: 1,
            isolate_new_process: false,
        }
    }
}

/// Phase of the process-swap adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SwapPhase {
    Uninitialized,
    Running,
    SpawningNew,
    HandingOff,
    Faulted,
    ShutDown,
}

/// Represents a child process managed by this adapter.
struct ManagedProcess {
    pid: u32,
    binary_path: String,
    ready: bool,
    child: Child,
    ready_file: PathBuf,
    handoff_file: Option<PathBuf>,
    _handoff_dir: TempDir,
    started_at: Instant,
}

/// The process-swap adapter.
pub struct ProcessSwapAdapter {
    config: ProcessSwapConfig,
    phase: SwapPhase,
    health: AdapterHealth,
    /// Currently active process.
    active: Option<ManagedProcess>,
    /// New process being spun up.
    pending: Option<ManagedProcess>,
    /// Number of swap operations performed.
    swap_count: u64,
    /// Last exported state.
    last_snapshot: Option<Vec<u8>>,
    drain_config: DrainConfig,
    state_transfer_config: StateTransferConfig,
    last_drain_result: Option<DrainResult>,
    last_transport: Option<StateTransport>,
}

impl ProcessSwapAdapter {
    pub fn new(config: ProcessSwapConfig) -> Self {
        Self {
            config,
            phase: SwapPhase::Uninitialized,
            health: AdapterHealth::Unknown,
            active: None,
            pending: None,
            swap_count: 0,
            last_snapshot: None,
            drain_config: DrainConfig::default(),
            state_transfer_config: StateTransferConfig::default(),
            last_drain_result: None,
            last_transport: None,
        }
    }

    fn build_handoff_envelope(&self, req: &AdapterReloadRequest) -> Option<HandoffEnvelope> {
        self.last_snapshot
            .as_ref()
            .filter(|_| req.preserve_state)
            .map(|snapshot| HandoffEnvelope::new(&req.module_id, 1, snapshot.clone(), now_ms()))
    }

    fn spawn_new(&mut self, req: &AdapterReloadRequest) -> Result<(), String> {
        let binary_path = Path::new(&req.build_manifest.artifact_path);
        if req.build_manifest.artifact_path.is_empty() {
            return Err("empty binary path".into());
        }
        if !binary_path.exists() {
            return Err(format!(
                "artifact path does not exist: {}",
                req.build_manifest.artifact_path
            ));
        }

        self.phase = SwapPhase::SpawningNew;

        let handoff_dir = TempDir::new().map_err(|error| {
            format!("failed to create process-swap handoff directory: {}", error)
        })?;
        let ready_file = handoff_dir.path().join("ready.signal");
        let handoff_envelope = self.build_handoff_envelope(req);
        let transport = handoff_envelope
            .as_ref()
            .map(|envelope| select_transport(envelope.payload.len(), &self.state_transfer_config));

        let handoff_file = if matches!(transport, Some(StateTransport::TempFile)) {
            let path = handoff_dir.path().join("handoff.msgpack");
            if let Some(envelope) = handoff_envelope.as_ref() {
                write_envelope_to_path(envelope, &path)?;
                let _ = read_envelope_from_path(&path)?;
            }
            Some(path)
        } else {
            None
        };

        let mut command = Command::new(binary_path);
        let use_stdio_handoff =
            handoff_envelope.is_some() && !matches!(transport, Some(StateTransport::TempFile));
        command
            .stdin(if use_stdio_handoff {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env("SYNTHI_PROCESS_SWAP_READY_FILE", &ready_file)
            .env("SYNTHI_PROCESS_SWAP_MODULE_ID", &req.module_id)
            .env("SYNTHI_PROCESS_SWAP_RELOAD_ID", &req.reload_id)
            .env(
                "SYNTHI_PROCESS_SWAP_OVERLAP_WINDOW",
                self.config.overlap_window.to_string(),
            );

        if self.config.isolate_new_process {
            command.env("SYNTHI_PROCESS_SWAP_ISOLATED", "1");
        }
        if let Some(path) = handoff_file.as_ref() {
            command.env("SYNTHI_PROCESS_SWAP_HANDOFF_FILE", path);
        }
        if handoff_envelope.is_some() {
            command.env(
                "SYNTHI_PROCESS_SWAP_HANDOFF_MODE",
                if use_stdio_handoff { "stdio" } else { "file" },
            );
        }

        let mut child = command.spawn().map_err(|error| {
            format!(
                "failed to spawn process-swap binary '{}': {}",
                req.build_manifest.artifact_path, error
            )
        })?;

        if let Some(envelope) = handoff_envelope.as_ref() {
            if use_stdio_handoff {
                let mut stdin = child
                    .stdin
                    .take()
                    .ok_or("failed to acquire child stdin for process handoff")?;
                write_envelope(&mut stdin, envelope)?;
            }
            self.last_transport = Some(transport.unwrap_or(StateTransport::StdioPipe));
        } else {
            self.last_transport = None;
        }

        self.pending = Some(ManagedProcess {
            pid: child.id(),
            binary_path: req.build_manifest.artifact_path.clone(),
            ready: false,
            child,
            ready_file,
            handoff_file,
            _handoff_dir: handoff_dir,
            started_at: Instant::now(),
        });

        Ok(())
    }

    fn wait_for_pending_ready(&mut self) -> Result<(), String> {
        let timeout = Duration::from_millis(self.config.startup_timeout_ms.max(1));
        let fallback_ready_after = Duration::from_millis(self.config.startup_timeout_ms.min(500));

        loop {
            let pending = self.pending.as_mut().ok_or("no pending process")?;
            if pending.ready_file.exists() {
                pending.ready = true;
                return Ok(());
            }

            match pending.child.try_wait() {
                Ok(Some(status)) => {
                    return Err(format!(
                        "new process exited before readiness for '{}': {}",
                        pending.binary_path, status
                    ));
                }
                Ok(None) => {}
                Err(error) => {
                    return Err(format!(
                        "failed while waiting for new process readiness: {}",
                        error
                    ));
                }
            }

            let elapsed = pending.started_at.elapsed();
            if elapsed >= fallback_ready_after {
                pending.ready = true;
                return Ok(());
            }
            if elapsed >= timeout {
                return Err(format!(
                    "new process did not become ready within {}ms",
                    self.config.startup_timeout_ms
                ));
            }

            thread::sleep(Duration::from_millis(50));
        }
    }

    /// Perform state handoff from old to new process.
    fn handoff(&mut self) -> Result<u64, String> {
        self.wait_for_pending_ready()?;
        self.phase = SwapPhase::HandingOff;

        let started = Instant::now();
        let previous = self.active.take();
        self.active = self.pending.take();
        self.phase = SwapPhase::Running;
        self.swap_count += 1;

        if let Some(previous_process) = previous {
            if let Err(error) = self.retire_previous(previous_process) {
                self.health = AdapterHealth::Degraded;
                eprintln!(
                    "[ProcessSwapAdapter] Previous process retirement degraded: {}",
                    error
                );
            }
        }

        Ok(started.elapsed().as_millis() as u64)
    }

    /// Kill the old process after a successful swap.
    fn retire_previous(&mut self, mut previous: ManagedProcess) -> Result<(), String> {
        let drain_result = drain_child_process(&mut previous.child, &self.drain_config)?;
        self.last_drain_result = Some(drain_result);
        Ok(())
    }

    fn terminate_process(process: &mut ManagedProcess) -> Result<(), String> {
        match process.child.try_wait() {
            Ok(Some(_)) => Ok(()),
            Ok(None) => {
                process.child.kill().map_err(|error| {
                    format!("failed to terminate process {}: {}", process.pid, error)
                })?;
                let _ = process.child.wait();
                Ok(())
            }
            Err(error) => Err(format!(
                "failed to inspect process {}: {}",
                process.pid, error
            )),
        }
    }
}

impl Adapter for ProcessSwapAdapter {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            name: "process_swap".into(),
            family: AdapterFamily::ProcessSwap,
            capability_tier: CapabilityTier::Tier1,
            supported_languages: self.config.languages.clone(),
            extra: {
                let mut m = HashMap::new();
                m.insert("swap_count".into(), self.swap_count.to_string());
                if let Some(ref p) = self.active {
                    m.insert("active_pid".into(), p.pid.to_string());
                }
                if let Some(ref p) = self.pending {
                    m.insert("pending_pid".into(), p.pid.to_string());
                }
                if let Some(transport) = self.last_transport {
                    m.insert("last_transport".into(), format!("{:?}", transport));
                }
                if let Some(ref drain) = self.last_drain_result {
                    m.insert("last_drain_outcome".into(), format!("{:?}", drain.outcome));
                }
                m
            },
        }
    }

    fn initialize(&mut self) -> Result<(), String> {
        if self.phase != SwapPhase::Uninitialized {
            return Err(format!("cannot initialize from {:?}", self.phase));
        }
        self.phase = SwapPhase::Running;
        self.health = AdapterHealth::Unknown;
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), String> {
        if let Some(mut active) = self.active.take() {
            Self::terminate_process(&mut active)?;
        }
        if let Some(mut pending) = self.pending.take() {
            Self::terminate_process(&mut pending)?;
        }
        self.phase = SwapPhase::ShutDown;
        self.health = AdapterHealth::Unknown;
        Ok(())
    }

    fn reload(&mut self, req: &AdapterReloadRequest) -> AdapterReloadResult {
        if self.phase != SwapPhase::Running {
            return AdapterReloadResult::Failed {
                error: format!("adapter not running (phase: {:?})", self.phase),
                recoverable: false,
            };
        }

        let artifact = &req.build_manifest.artifact_path;
        if artifact.is_empty() {
            return AdapterReloadResult::Failed {
                error: "no artifact_path".into(),
                recoverable: true,
            };
        }

        // Spawn new process
        if let Err(e) = self.spawn_new(req) {
            self.phase = SwapPhase::Faulted;
            self.health = AdapterHealth::Faulted;
            return AdapterReloadResult::Failed {
                error: e,
                recoverable: true,
            };
        }

        // Handoff
        match self.handoff() {
            Ok(ms) => {
                if self.health != AdapterHealth::Degraded {
                    self.health = AdapterHealth::Healthy;
                }
                AdapterReloadResult::Success {
                    reload_ms: ms,
                    state_preserved: req.preserve_state && self.last_snapshot.is_some(),
                }
            }
            Err(e) => {
                // Kill the pending process, keep old one
                if let Some(mut pending) = self.pending.take() {
                    let _ = Self::terminate_process(&mut pending);
                }
                self.phase = SwapPhase::Running;
                self.health = AdapterHealth::Degraded;
                AdapterReloadResult::Failed {
                    error: e,
                    recoverable: true,
                }
            }
        }
    }

    fn snapshot_state(&self) -> Result<Vec<u8>, String> {
        self.last_snapshot.clone().ok_or_else(|| "no state".into())
    }

    fn restore_state(&mut self, data: &[u8]) -> Result<(), String> {
        if data.is_empty() {
            return Err("empty state".into());
        }
        self.last_snapshot = Some(data.to_vec());
        Ok(())
    }

    fn healthcheck(&self) -> AdapterHealth {
        self.health
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::build_manifest::{BuildManifest, BuildSlot};
    use tempfile::tempdir;

    fn test_manifest(artifact: &str) -> BuildManifest {
        BuildManifest::new(
            "p1",
            "go",
            "process_swap",
            1,
            BuildSlot::Full,
            artifact,
            "ghi789",
        )
    }

    #[cfg(unix)]
    fn create_test_binary() -> (TempDir, String) {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let path = dir.path().join("process_swap_test.sh");
        std::fs::write(
            &path,
            "#!/bin/sh\nif [ -n \"$SYNTHI_PROCESS_SWAP_READY_FILE\" ]; then : > \"$SYNTHI_PROCESS_SWAP_READY_FILE\"; fi\nsleep 1\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        (dir, path.to_string_lossy().into_owned())
    }

    #[cfg(windows)]
    fn create_test_binary() -> (TempDir, String) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("process_swap_test.cmd");
        std::fs::write(
            &path,
            "@echo off\r\nif defined SYNTHI_PROCESS_SWAP_READY_FILE type nul > \"%SYNTHI_PROCESS_SWAP_READY_FILE%\"\r\nping -n 2 127.0.0.1 > nul\r\n",
        )
        .unwrap();
        (dir, path.to_string_lossy().into_owned())
    }

    #[test]
    fn lifecycle() {
        let mut adapter = ProcessSwapAdapter::new(ProcessSwapConfig::default());
        assert!(adapter.initialize().is_ok());
        let (_temp_dir, executable) = create_test_binary();

        let req = AdapterReloadRequest {
            reload_id: "r-1".into(),
            module_id: "app".into(),
            changed_files: vec!["main.go".into()],
            build_manifest: test_manifest(&executable),
            artifact_blob: None,
            capsule_metadata: None,
            firewall_evidence: Default::default(),
            preserve_state: false,
            timeout_ms: 5000,
        };
        let result = adapter.reload(&req);
        assert!(matches!(result, AdapterReloadResult::Success { .. }));
        assert_eq!(adapter.swap_count, 1);

        assert!(adapter.shutdown().is_ok());
    }

    #[test]
    fn swap_count_increments() {
        let mut adapter = ProcessSwapAdapter::new(ProcessSwapConfig::default());
        adapter.initialize().unwrap();
        let (_temp_dir, executable) = create_test_binary();

        for i in 0..3 {
            let req = AdapterReloadRequest {
                reload_id: format!("r-{}", i),
                module_id: "app".into(),
                changed_files: vec![],
                build_manifest: test_manifest(&executable),
                artifact_blob: None,
                capsule_metadata: None,
                firewall_evidence: Default::default(),
                preserve_state: false,
                timeout_ms: 5000,
            };
            adapter.reload(&req);
        }
        assert_eq!(adapter.swap_count, 3);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
