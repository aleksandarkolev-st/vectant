// ============================================================
// ADAPTER TRAIT
// ============================================================
// Unified trait that all adapter families implement.  The
// planner calls into adapters through this trait, never through
// language-specific or family-specific branches.
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::build_manifest::BuildManifest;

// ── Adapter lifecycle events ────────────────────────────────

/// Optional in-memory artifact payload carried alongside a reload request.
///
/// The byte payload is intentionally skipped during serde so status messages
/// and diagnostics can expose the blob id/hash without serializing large
/// compiled artifacts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReloadArtifactBlob {
    /// Content-addressed id for the artifact bytes.
    pub blob_id: String,
    /// SHA-256 content hash, formatted as `sha256:<hex>`.
    pub content_hash: String,
    /// Artifact bytes available to adapters that support RAM loaders.
    #[serde(skip_serializing, skip_deserializing, default)]
    pub bytes: Vec<u8>,
}

/// High-level reload request that the planner feeds to an adapter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdapterReloadRequest {
    /// Unique reload ID for correlation.
    pub reload_id: String,
    /// Module that changed.
    pub module_id: String,
    /// Paths of changed files.
    pub changed_files: Vec<String>,
    /// Build manifest from the latest compilation.
    pub build_manifest: BuildManifest,
    /// Optional RAM artifact payload for adapters with byte/blob loaders.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub artifact_blob: Option<ReloadArtifactBlob>,
    /// Whether state preservation is requested.
    pub preserve_state: bool,
    /// Timeout for this reload (millis).
    pub timeout_ms: u64,
}

/// Result of an adapter reload attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AdapterReloadResult {
    /// Reload succeeded with optional state-round-trip info.
    Success {
        reload_ms: u64,
        state_preserved: bool,
    },
    /// Reload failed but the old artifact is still running.
    Failed { error: String, recoverable: bool },
    /// Adapter cannot handle this reload; escalate to cold path.
    Unsupported { reason: String },
}

/// Health of an adapter after a reload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AdapterHealth {
    Healthy,
    Degraded,
    Faulted,
    Unknown,
}

/// Adapter info exposed to the planner / telemetry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdapterInfo {
    pub name: String,
    pub family: AdapterFamily,
    pub capability_tier: CapabilityTier,
    pub supported_languages: Vec<String>,
    pub extra: HashMap<String, String>,
}

// ── The trait ────────────────────────────────────────────────

/// Every adapter family implements this trait.  The planner
/// dispatches through it without knowing the concrete type.
pub trait Adapter: Send + Sync {
    /// Static metadata about this adapter.
    fn info(&self) -> AdapterInfo;

    /// Called once before the first reload.  Sets up any long-lived
    /// resources (e.g. a JVM, a dlopen handle, a child process).
    fn initialize(&mut self) -> Result<(), String>;

    /// Tear down resources.
    fn shutdown(&mut self) -> Result<(), String>;

    /// Perform a hot reload.
    fn reload(&mut self, req: &AdapterReloadRequest) -> AdapterReloadResult;

    /// Export current state from the running artifact.
    fn snapshot_state(&self) -> Result<Vec<u8>, String>;

    /// Import state into the (possibly new) artifact.
    fn restore_state(&mut self, data: &[u8]) -> Result<(), String>;

    /// Quick liveness check after the last reload.
    fn healthcheck(&self) -> AdapterHealth;

    /// Human-readable status line for diagnostics.
    fn status_line(&self) -> String {
        format!("{}: {:?}", self.info().name, self.healthcheck())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dummy adapter to verify the trait compiles.
    struct NoopAdapter;

    impl Adapter for NoopAdapter {
        fn info(&self) -> AdapterInfo {
            AdapterInfo {
                name: "noop".into(),
                family: AdapterFamily::DynamicLibrary,
                capability_tier: CapabilityTier::Tier0,
                supported_languages: vec![],
                extra: HashMap::new(),
            }
        }
        fn initialize(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn shutdown(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn reload(&mut self, _req: &AdapterReloadRequest) -> AdapterReloadResult {
            AdapterReloadResult::Unsupported {
                reason: "noop".into(),
            }
        }
        fn snapshot_state(&self) -> Result<Vec<u8>, String> {
            Ok(vec![])
        }
        fn restore_state(&mut self, _data: &[u8]) -> Result<(), String> {
            Ok(())
        }
        fn healthcheck(&self) -> AdapterHealth {
            AdapterHealth::Unknown
        }
    }

    #[test]
    fn noop_adapter_trait_object() {
        let mut adapter: Box<dyn Adapter> = Box::new(NoopAdapter);
        assert_eq!(adapter.info().name, "noop");
        assert!(adapter.initialize().is_ok());
        assert_eq!(adapter.healthcheck(), AdapterHealth::Unknown);
    }
}
