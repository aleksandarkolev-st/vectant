// ============================================================
// PROCESS SWAP ADAPTER
// ============================================================
// Implements the Adapter trait for the ProcessSwap family
// (Go, Swift).  These languages produce static binaries that
// can't be hot-swapped in-process, so we spawn a new process
// with the new binary and hand off state via IPC.
// ============================================================

#![allow(dead_code)]

use std::collections::HashMap;

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::adapter_trait::{
    Adapter, AdapterHealth, AdapterInfo, AdapterReloadRequest, AdapterReloadResult,
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
#[derive(Debug, Clone)]
struct ManagedProcess {
    /// Simulated PID.
    pid: u32,
    /// Path to the binary.
    binary_path: String,
    /// Whether currently accepting requests.
    ready: bool,
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
    /// PID counter for simulation.
    next_pid: u32,
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
            next_pid: 10000,
        }
    }

    fn allocate_pid(&mut self) -> u32 {
        let pid = self.next_pid;
        self.next_pid += 1;
        pid
    }

    /// Spawn a new process with the given binary.
    fn spawn_new(&mut self, binary_path: &str) -> Result<(), String> {
        if binary_path.is_empty() {
            return Err("empty binary path".into());
        }
        self.phase = SwapPhase::SpawningNew;
        let pid = self.allocate_pid();
        self.pending = Some(ManagedProcess {
            pid,
            binary_path: binary_path.to_string(),
            ready: true, // In production: wait for readiness signal
        });
        Ok(())
    }

    /// Perform state handoff from old to new process.
    fn handoff(&mut self) -> Result<u64, String> {
        let new_proc = self.pending.as_ref().ok_or("no pending process")?;
        if !new_proc.ready {
            return Err("new process not ready".into());
        }

        self.phase = SwapPhase::HandingOff;

        // In production: send state via stdin/stdout pipe, unix socket, or shared memory.
        let handoff_ms = 100; // simulated

        // Promote new, retire old
        self.active = self.pending.take();
        self.phase = SwapPhase::Running;
        self.swap_count += 1;

        Ok(handoff_ms)
    }

    /// Kill the old process after a successful swap.
    fn retire_previous(&mut self) {
        // In production: send SIGTERM, wait for graceful shutdown.
        // The old process is already replaced in self.active.
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
        self.active = None;
        self.pending = None;
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
        if let Err(e) = self.spawn_new(artifact) {
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
                self.retire_previous();
                self.health = AdapterHealth::Healthy;
                AdapterReloadResult::Success {
                    reload_ms: ms,
                    state_preserved: req.preserve_state && self.last_snapshot.is_some(),
                }
            }
            Err(e) => {
                // Kill the pending process, keep old one
                self.pending = None;
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

    fn test_manifest(artifact: &str) -> BuildManifest {
        BuildManifest::new("p1", "go", "process_swap", 1, BuildSlot::Full, artifact, "ghi789")
    }

    #[test]
    fn lifecycle() {
        let mut adapter = ProcessSwapAdapter::new(ProcessSwapConfig::default());
        assert!(adapter.initialize().is_ok());

        let req = AdapterReloadRequest {
            reload_id: "r-1".into(),
            module_id: "app".into(),
            changed_files: vec!["main.go".into()],
            build_manifest: test_manifest("/tmp/app_v2"),
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

        for i in 0..3 {
            let req = AdapterReloadRequest {
                reload_id: format!("r-{}", i),
                module_id: "app".into(),
                changed_files: vec![],
                build_manifest: test_manifest(&format!("/tmp/app_v{}", i)),
                preserve_state: false,
                timeout_ms: 5000,
            };
            adapter.reload(&req);
        }
        assert_eq!(adapter.swap_count, 3);
    }
}
