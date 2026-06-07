// ============================================================
// ADAPTER TRAIT
// ============================================================
// Unified trait that all adapter families implement.  The
// planner calls into adapters through this trait, never through
// language-specific or family-specific branches.
// ============================================================

use base64::Engine as _;
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

/// Optional proof/capsule identity metadata for a hot-reload publication.
///
/// Adapters may ignore fields they cannot use, but GPU epoch publication
/// proof records this metadata when present so validation can distinguish a
/// real generation capsule from a path-only module swap.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReloadCapsuleMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fission_island_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abi_membrane_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependency_closure_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof_hash: Option<String>,
}

/// Evidence from the caller boundary that non-GPU reload routes were not used.
///
/// GPU adapters must consume this as evidence, not infer it locally. Missing
/// values mean the caller did not prove the firewall invariant.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReloadFirewallEvidence {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cpu_hmr_used: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub full_rebuild_used: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub process_restarted: Option<bool>,
}

impl ReloadFirewallEvidence {
    pub fn gpu_hmr_verified_absence() -> Self {
        Self {
            cpu_hmr_used: Some(false),
            full_rebuild_used: Some(false),
            process_restarted: Some(false),
        }
    }
}

const RELOAD_CAPSULE_METADATA_TOKEN_PREFIX: &str = "capsulev1_";

fn non_empty_token(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "none")
}

fn normalized_reload_capsule_metadata(
    metadata: &ReloadCapsuleMetadata,
) -> Option<ReloadCapsuleMetadata> {
    let normalized = ReloadCapsuleMetadata {
        fission_island_id: non_empty_token(metadata.fission_island_id.clone()),
        abi_membrane_hash: non_empty_token(metadata.abi_membrane_hash.clone()),
        dependency_closure_hash: non_empty_token(metadata.dependency_closure_hash.clone()),
        proof_hash: non_empty_token(metadata.proof_hash.clone()),
    };
    (normalized.fission_island_id.is_some()
        || normalized.abi_membrane_hash.is_some()
        || normalized.dependency_closure_hash.is_some()
        || normalized.proof_hash.is_some())
    .then_some(normalized)
}

pub fn encode_reload_capsule_metadata_token(metadata: &ReloadCapsuleMetadata) -> Option<String> {
    let metadata = normalized_reload_capsule_metadata(metadata)?;
    let json = serde_json::to_vec(&metadata).ok()?;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
    Some(format!("{RELOAD_CAPSULE_METADATA_TOKEN_PREFIX}{payload}"))
}

pub fn decode_reload_capsule_metadata_token(token: &str) -> Option<ReloadCapsuleMetadata> {
    let payload = token
        .trim()
        .strip_prefix(RELOAD_CAPSULE_METADATA_TOKEN_PREFIX)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.as_bytes())
        .ok()?;
    let metadata = serde_json::from_slice::<ReloadCapsuleMetadata>(&bytes).ok()?;
    normalized_reload_capsule_metadata(&metadata)
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
    /// Optional capsule proof metadata for generation-published reloads.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub capsule_metadata: Option<ReloadCapsuleMetadata>,
    /// Explicit firewall evidence supplied by the reload boundary.
    #[serde(default)]
    pub firewall_evidence: ReloadFirewallEvidence,
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

    #[test]
    fn reload_capsule_metadata_token_round_trips_non_empty_fields() {
        let metadata = ReloadCapsuleMetadata {
            fission_island_id: Some(" fission-island:sha256:abc ".into()),
            abi_membrane_hash: Some("sha256:def".into()),
            dependency_closure_hash: Some("".into()),
            proof_hash: Some("sha256:123".into()),
        };

        let token = encode_reload_capsule_metadata_token(&metadata).expect("capsule token");
        assert!(token.starts_with("capsulev1_"));
        assert!(!token.contains(':'));
        assert!(!token.contains(' '));

        let decoded =
            decode_reload_capsule_metadata_token(&token).expect("decoded capsule metadata");
        assert_eq!(
            decoded.fission_island_id.as_deref(),
            Some("fission-island:sha256:abc")
        );
        assert_eq!(decoded.abi_membrane_hash.as_deref(), Some("sha256:def"));
        assert_eq!(decoded.dependency_closure_hash, None);
        assert_eq!(decoded.proof_hash.as_deref(), Some("sha256:123"));
    }

    #[test]
    fn reload_capsule_metadata_token_omits_empty_metadata() {
        assert!(encode_reload_capsule_metadata_token(&ReloadCapsuleMetadata::default()).is_none());
        assert!(decode_reload_capsule_metadata_token("not-a-capsule-token").is_none());
    }
}
