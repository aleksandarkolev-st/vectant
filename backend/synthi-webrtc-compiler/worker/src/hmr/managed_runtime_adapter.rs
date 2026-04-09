// ============================================================
// MANAGED RUNTIME ADAPTER
// ============================================================
// Implements the Adapter trait for the ManagedRuntime family
// (Java, Kotlin/JVM, C#/.NET).  These runtimes host a long-
// lived VM and can reload classes or assemblies without
// restarting the entire process.
// ============================================================

#![allow(dead_code)]

use std::collections::HashMap;

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::adapter_trait::{
    Adapter, AdapterHealth, AdapterInfo, AdapterReloadRequest, AdapterReloadResult,
};

/// Configuration for the managed-runtime adapter.
#[derive(Debug, Clone)]
pub struct ManagedRuntimeConfig {
    /// Languages this instance handles.
    pub languages: Vec<String>,
    /// Kind of managed runtime.
    pub runtime_kind: ManagedRuntimeKind,
    /// Maximum artifact size (bytes) for hot-swap payloads.
    pub max_payload_bytes: u64,
    /// Timeout for the host reload command (millis).
    pub reload_timeout_ms: u64,
}

/// Identifies the managed host type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedRuntimeKind {
    Jvm,
    DotNet,
}

impl Default for ManagedRuntimeConfig {
    fn default() -> Self {
        Self {
            languages: vec!["java".into(), "kotlin".into()],
            runtime_kind: ManagedRuntimeKind::Jvm,
            max_payload_bytes: 128 * 1024 * 1024,
            reload_timeout_ms: 10_000,
        }
    }
}

/// Internal phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManagedPhase {
    Uninitialized,
    HostStarting,
    Ready,
    Reloading,
    Faulted,
    ShutDown,
}

/// The managed-runtime adapter.
pub struct ManagedRuntimeAdapter {
    config: ManagedRuntimeConfig,
    phase: ManagedPhase,
    health: AdapterHealth,
    /// Simulated host PID.
    host_pid: Option<u32>,
    /// Tracks number of class/assembly reloads.
    reload_count: u64,
    /// Serialized state exported from the host.
    last_snapshot: Option<Vec<u8>>,
}

impl ManagedRuntimeAdapter {
    pub fn new(config: ManagedRuntimeConfig) -> Self {
        Self {
            config,
            phase: ManagedPhase::Uninitialized,
            health: AdapterHealth::Unknown,
            host_pid: None,
            reload_count: 0,
            last_snapshot: None,
        }
    }

    /// Start the managed host (JVM / CLR).
    fn start_host(&mut self) -> Result<(), String> {
        self.phase = ManagedPhase::HostStarting;
        // In production: spawn java/dotnet process, wait for readiness.
        self.host_pid = Some(99999); // placeholder
        self.phase = ManagedPhase::Ready;
        self.health = AdapterHealth::Healthy;
        Ok(())
    }

    /// Stop the managed host.
    fn stop_host(&mut self) {
        self.host_pid = None;
        self.phase = ManagedPhase::ShutDown;
        self.health = AdapterHealth::Unknown;
    }

    /// Send the updated classes/assembly to the host for reload.
    fn send_reload(&mut self, artifact_path: &str) -> Result<u64, String> {
        if artifact_path.is_empty() {
            return Err("empty artifact path".into());
        }
        self.phase = ManagedPhase::Reloading;

        // Validate artifact extension
        let valid_exts = match self.config.runtime_kind {
            ManagedRuntimeKind::Jvm => vec![".jar", ".class"],
            ManagedRuntimeKind::DotNet => vec![".dll", ".exe"],
        };
        if !valid_exts.iter().any(|ext| artifact_path.ends_with(ext)) {
            self.phase = ManagedPhase::Faulted;
            return Err(format!(
                "invalid artifact for {:?}: {}",
                self.config.runtime_kind, artifact_path
            ));
        }

        // Simulate sending to the host agent
        self.reload_count += 1;
        self.phase = ManagedPhase::Ready;
        self.health = AdapterHealth::Healthy;
        Ok(50) // ~50ms for managed reload
    }
}

impl Adapter for ManagedRuntimeAdapter {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            name: match self.config.runtime_kind {
                ManagedRuntimeKind::Jvm => "managed_jvm".into(),
                ManagedRuntimeKind::DotNet => "managed_dotnet".into(),
            },
            family: AdapterFamily::ManagedRuntime,
            capability_tier: CapabilityTier::Tier2,
            supported_languages: self.config.languages.clone(),
            extra: {
                let mut m = HashMap::new();
                m.insert("reload_count".into(), self.reload_count.to_string());
                m.insert("host_pid".into(), format!("{:?}", self.host_pid));
                m
            },
        }
    }

    fn initialize(&mut self) -> Result<(), String> {
        if self.phase != ManagedPhase::Uninitialized {
            return Err(format!("cannot initialize from {:?}", self.phase));
        }
        self.start_host()
    }

    fn shutdown(&mut self) -> Result<(), String> {
        self.stop_host();
        Ok(())
    }

    fn reload(&mut self, req: &AdapterReloadRequest) -> AdapterReloadResult {
        if self.phase != ManagedPhase::Ready {
            return AdapterReloadResult::Failed {
                error: format!("host not ready (phase: {:?})", self.phase),
                recoverable: false,
            };
        }

        let artifact = match &req.build_manifest.artifact_path {
            Some(p) => p.clone(),
            None => {
                return AdapterReloadResult::Failed {
                    error: "no artifact_path in build manifest".into(),
                    recoverable: true,
                }
            }
        };

        match self.send_reload(&artifact) {
            Ok(ms) => AdapterReloadResult::Success {
                reload_ms: ms,
                state_preserved: req.preserve_state && self.last_snapshot.is_some(),
            },
            Err(e) => {
                self.health = AdapterHealth::Faulted;
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
    use crate::hmr::build_manifest::BuildManifest;

    fn jvm_manifest(artifact: &str) -> BuildManifest {
        BuildManifest {
            build_id: "b-1".into(),
            module_id: "app".into(),
            artifact_path: Some(artifact.into()),
            artifact_hash: "def456".into(),
            build_ms: 2000,
            compiler_version: "javac 17".into(),
            warnings: vec![],
        }
    }

    #[test]
    fn jvm_lifecycle() {
        let mut adapter = ManagedRuntimeAdapter::new(ManagedRuntimeConfig::default());
        assert!(adapter.initialize().is_ok());

        let req = AdapterReloadRequest {
            reload_id: "r-1".into(),
            module_id: "app".into(),
            changed_files: vec!["Main.java".into()],
            build_manifest: jvm_manifest("app.jar"),
            preserve_state: false,
            timeout_ms: 5000,
        };
        let result = adapter.reload(&req);
        assert!(matches!(result, AdapterReloadResult::Success { .. }));

        assert!(adapter.shutdown().is_ok());
    }

    #[test]
    fn rejects_wrong_artifact_type() {
        let mut adapter = ManagedRuntimeAdapter::new(ManagedRuntimeConfig::default());
        adapter.initialize().unwrap();

        let req = AdapterReloadRequest {
            reload_id: "r-2".into(),
            module_id: "app".into(),
            changed_files: vec![],
            build_manifest: jvm_manifest("app.so"),
            preserve_state: false,
            timeout_ms: 5000,
        };
        let result = adapter.reload(&req);
        assert!(matches!(result, AdapterReloadResult::Failed { .. }));
    }
}
