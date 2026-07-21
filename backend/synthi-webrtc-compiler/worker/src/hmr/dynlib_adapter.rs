// ============================================================
// DYNAMIC LIBRARY ADAPTER
// ============================================================
// Implements support-only admission for DynamicLibrary candidates.
// Runtime reload stays unsupported until a loader can emit observed
// publication and dispatch receipts for the same artifact bytes.
// ============================================================

use object::{Object, ObjectKind, ObjectSymbol};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::path::Path;

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::adapter_trait::{
    Adapter, AdapterHealth, AdapterInfo, AdapterReloadRequest, AdapterReloadResult,
};
use crate::runtime::runner::validator::{
    classify_resolved_module_contract, LifecycleAbi, LifecycleExportPresence,
    ResolvedModuleContract,
};

const DYNLIB_PREFLIGHT_AUTHORITY: &str =
    "static_candidate_preflight_only_not_runtime_reload_or_dispatch_proof";

/// Configuration for the dynlib adapter.
#[derive(Debug, Clone)]
pub struct DynLibAdapterConfig {
    /// Languages this instance handles.
    pub languages: Vec<String>,
    /// Maximum artifact size allowed (bytes).
    pub max_artifact_bytes: u64,
    /// Whether to validate ABI symbols before swap.
    pub validate_symbols: bool,
    /// Healthcheck: number of ticks to wait after reload.
    pub healthcheck_ticks: u32,
}

impl Default for DynLibAdapterConfig {
    fn default() -> Self {
        Self {
            languages: vec!["c".into(), "cpp".into(), "rust".into(), "zig".into()],
            max_artifact_bytes: 256 * 1024 * 1024, // 256 MB
            validate_symbols: true,
            healthcheck_ticks: 2,
        }
    }
}

/// Internal state of the dynlib adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DynLibPhase {
    Uninitialized,
    Ready,
    ShutDown,
}

#[derive(Debug, Clone)]
struct DynLibCandidatePreflight {
    module_id: String,
    artifact_path: String,
    artifact_sha256: String,
    artifact_bytes: u64,
    exported_symbol_count: usize,
    resolved_contract: ResolvedModuleContract,
}

/// The dynamic library adapter.
pub struct DynLibAdapter {
    config: DynLibAdapterConfig,
    phase: DynLibPhase,
    /// Last statically observed candidate. This is not an active module.
    last_preflight: Option<DynLibCandidatePreflight>,
    /// Health after last reload.
    health: AdapterHealth,
    /// Number of candidates that completed support-only preflight.
    preflight_count: u64,
}

impl DynLibAdapter {
    pub fn new(config: DynLibAdapterConfig) -> Self {
        Self {
            config,
            phase: DynLibPhase::Uninitialized,
            last_preflight: None,
            health: AdapterHealth::Unknown,
            preflight_count: 0,
        }
    }

    /// Get the phase for debugging.
    pub fn phase(&self) -> &str {
        match self.phase {
            DynLibPhase::Uninitialized => "uninitialized",
            DynLibPhase::Ready => "ready",
            DynLibPhase::ShutDown => "shutdown",
        }
    }

    /// Observe a candidate without executing it or claiming a runtime swap.
    fn validate_artifact(
        &self,
        req: &AdapterReloadRequest,
    ) -> Result<DynLibCandidatePreflight, String> {
        let artifact_path = &req.build_manifest.artifact_path;

        if !self.config.validate_symbols {
            return Err("dynamic-library validation cannot be disabled".into());
        }
        if artifact_path.is_empty() {
            return Err("empty artifact path".into());
        }
        if req.module_id.is_empty()
            || req.module_id.trim() != req.module_id
            || req.module_id.chars().any(char::is_control)
        {
            return Err("module_id must be a non-empty opaque identifier".into());
        }

        let file = std::fs::File::open(artifact_path)
            .map_err(|error| format!("artifact '{}' is not readable: {error}", artifact_path))?;
        let metadata = file.metadata().map_err(|error| {
            format!(
                "artifact '{}' metadata is not readable: {error}",
                artifact_path
            )
        })?;
        if !metadata.is_file() {
            return Err(format!(
                "artifact '{}' is not a regular file",
                artifact_path
            ));
        }
        if metadata.len() == 0 {
            return Err(format!("artifact '{}' is empty", artifact_path));
        }
        if metadata.len() > self.config.max_artifact_bytes {
            return Err(format!(
                "artifact '{}' exceeds max size: {} > {} bytes",
                artifact_path,
                metadata.len(),
                self.config.max_artifact_bytes
            ));
        }

        let bounded_read_limit =
            self.config
                .max_artifact_bytes
                .checked_add(1)
                .ok_or_else(|| {
                    "max_artifact_bytes must leave room for overflow detection".to_string()
                })?;
        let mut bytes = Vec::new();
        file.take(bounded_read_limit)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("artifact '{}' read failed: {error}", artifact_path))?;
        if bytes.len() as u64 > self.config.max_artifact_bytes {
            return Err(format!(
                "artifact '{}' grew beyond max size while being inspected",
                artifact_path
            ));
        }
        if bytes.len() as u64 != metadata.len() {
            return Err(format!(
                "artifact '{}' changed while it was being inspected",
                artifact_path
            ));
        }

        let artifact_sha256 = sha256_prefixed(&bytes);
        let declared_hash = req.build_manifest.artifact_hash.trim();
        if !canonical_sha256(declared_hash) {
            return Err("build manifest lacks a canonical artifact SHA-256".into());
        }
        if declared_hash != artifact_sha256 {
            return Err(format!(
                "artifact hash mismatch: manifest={} observed={}",
                declared_hash, artifact_sha256
            ));
        }

        if let Some(blob) = req.artifact_blob.as_ref() {
            if !blob.content_hash.is_empty() && blob.content_hash != artifact_sha256 {
                return Err("artifact blob hash does not match observed file bytes".into());
            }
            if !blob.bytes.is_empty() && sha256_prefixed(&blob.bytes) != artifact_sha256 {
                return Err("artifact blob bytes do not match observed file bytes".into());
            }
        }

        let exported_symbols = observed_dynamic_exports(Path::new(artifact_path), &bytes)?;
        let resolved_contract = classify_resolved_module_contract(
            LifecycleExportPresence::from_symbol_names(exported_symbols.iter()),
        )
        .map_err(|error| format!("candidate lifecycle contract is not loadable: {error:?}"))?;

        if req.preserve_state && !has_state_round_trip(&exported_symbols, resolved_contract) {
            return Err("state preservation requested without observed save/load exports".into());
        }

        Ok(DynLibCandidatePreflight {
            module_id: req.module_id.clone(),
            artifact_path: artifact_path.clone(),
            artifact_sha256,
            artifact_bytes: bytes.len() as u64,
            exported_symbol_count: exported_symbols.len(),
            resolved_contract,
        })
    }
}

fn canonical_sha256(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn sha256_prefixed(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn observed_dynamic_exports(path: &Path, bytes: &[u8]) -> Result<BTreeSet<String>, String> {
    let file = object::File::parse(bytes).map_err(|error| {
        format!(
            "artifact '{}' is not a supported object: {error}",
            path.display()
        )
    })?;
    if file.kind() != ObjectKind::Dynamic {
        return Err(format!(
            "artifact '{}' is not a dynamic library",
            path.display()
        ));
    }

    let symbols = file
        .dynamic_symbols()
        .filter(|symbol| symbol.is_definition())
        .filter_map(|symbol| symbol.name().ok().map(str::to_string))
        .collect::<BTreeSet<_>>();
    if symbols.is_empty() {
        return Err(format!(
            "artifact '{}' has no observed dynamic exports",
            path.display()
        ));
    }
    Ok(symbols)
}

fn has_state_round_trip(
    exported_symbols: &BTreeSet<String>,
    contract: ResolvedModuleContract,
) -> bool {
    let (save, load) = match contract.lifecycle_abi {
        LifecycleAbi::CorePrefixed => ("core_on_save_state", "core_on_load_from_json"),
        LifecycleAbi::GuiPrefixed => ("gui_on_save_state", "gui_on_load_from_json"),
        LifecycleAbi::GuiLegacy | LifecycleAbi::Legacy => ("on_save_state", "on_load_from_json"),
    };
    exported_symbols.contains(save) && exported_symbols.contains(load)
}

impl Adapter for DynLibAdapter {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            name: "dynlib".into(),
            family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier0,
            supported_languages: self.config.languages.clone(),
            extra: {
                let mut m = HashMap::new();
                m.insert("reload_count".into(), "0".into());
                m.insert(
                    "candidate_preflight_count".into(),
                    self.preflight_count.to_string(),
                );
                m.insert(
                    "evidence_authority".into(),
                    DYNLIB_PREFLIGHT_AUTHORITY.into(),
                );
                m.insert("accepted_for_hmr".into(), "false".into());
                m.insert("runtime_reload_proven".into(), "false".into());
                m.insert("runtime_dispatch_proven".into(), "false".into());
                m.insert(
                    "healthcheck_ticks".into(),
                    self.config.healthcheck_ticks.to_string(),
                );
                m.insert("phase".into(), self.phase().into());
                if let Some(preflight) = &self.last_preflight {
                    m.insert("candidate_module_id".into(), preflight.module_id.clone());
                    m.insert(
                        "candidate_artifact_path".into(),
                        preflight.artifact_path.clone(),
                    );
                    m.insert(
                        "candidate_artifact_sha256".into(),
                        preflight.artifact_sha256.clone(),
                    );
                    m.insert(
                        "candidate_artifact_bytes".into(),
                        preflight.artifact_bytes.to_string(),
                    );
                    m.insert(
                        "candidate_exported_symbol_count".into(),
                        preflight.exported_symbol_count.to_string(),
                    );
                    m.insert(
                        "candidate_lifecycle_role".into(),
                        format!("{:?}", preflight.resolved_contract.role),
                    );
                    m.insert(
                        "candidate_lifecycle_abi".into(),
                        format!("{:?}", preflight.resolved_contract.lifecycle_abi),
                    );
                }
                m
            },
        }
    }

    fn initialize(&mut self) -> Result<(), String> {
        if self.phase != DynLibPhase::Uninitialized {
            return Err(format!("cannot initialize from phase {:?}", self.phase));
        }
        self.phase = DynLibPhase::Ready;
        self.health = AdapterHealth::Unknown;
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), String> {
        self.phase = DynLibPhase::ShutDown;
        self.last_preflight = None;
        self.health = AdapterHealth::Unknown;
        Ok(())
    }

    fn reload(&mut self, req: &AdapterReloadRequest) -> AdapterReloadResult {
        if self.phase != DynLibPhase::Ready {
            return AdapterReloadResult::Failed {
                error: format!("adapter not ready (phase: {:?})", self.phase),
                recoverable: false,
            };
        }

        match self.validate_artifact(req) {
            Ok(preflight) => {
                self.last_preflight = Some(preflight);
                self.preflight_count += 1;
                self.health = AdapterHealth::Unknown;
                AdapterReloadResult::Unsupported {
                    reason: concat!(
                        "dynamic-library candidate preflight passed; ",
                        "runtime artifact load, epoch publication, dispatch, and output proof ",
                        "are still required"
                    )
                    .into(),
                }
            }
            Err(error) => AdapterReloadResult::Failed {
                error,
                recoverable: true,
            },
        }
    }

    fn snapshot_state(&self) -> Result<Vec<u8>, String> {
        Err("state snapshot is unavailable without an observed runtime loader hook".into())
    }

    fn restore_state(&mut self, _data: &[u8]) -> Result<(), String> {
        Err("state restore is unavailable without an observed runtime loader hook".into())
    }

    fn healthcheck(&self) -> AdapterHealth {
        self.health
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::adapter_trait::ReloadArtifactBlob;
    use crate::hmr::build_manifest::{BuildManifest, BuildSlot};
    use std::path::{Path, PathBuf};

    fn request(artifact: &Path, artifact_hash: &str) -> AdapterReloadRequest {
        AdapterReloadRequest {
            reload_id: "reload-candidate".into(),
            source_edit_id: None,
            module_id: "tenant/module-17".into(),
            changed_files: vec!["src/module.c".into()],
            build_manifest: BuildManifest::new(
                "preview-session",
                "c",
                "DynamicLibrary",
                3,
                BuildSlot::Full,
                artifact.to_string_lossy(),
                artifact_hash,
            ),
            artifact_blob: None,
            capsule_metadata: None,
            firewall_evidence: Default::default(),
            preserve_state: false,
            timeout_ms: 5000,
        }
    }

    fn initialized_adapter() -> DynLibAdapter {
        let mut adapter = DynLibAdapter::new(DynLibAdapterConfig::default());
        adapter.initialize().expect("initialize adapter");
        adapter
    }

    #[test]
    fn nonexistent_artifact_fails_without_mutating_preflight_state() {
        let mut adapter = initialized_adapter();
        let path = PathBuf::from("candidate-that-does-not-exist.so");
        let result = adapter.reload(&request(
            &path,
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        ));

        assert!(matches!(result, AdapterReloadResult::Failed { .. }));
        assert_eq!(adapter.phase(), "ready");
        assert_eq!(adapter.info().extra["candidate_preflight_count"], "0");
        assert_eq!(adapter.healthcheck(), AdapterHealth::Unknown);
    }

    #[test]
    fn state_api_never_fabricates_a_runtime_round_trip() {
        let mut adapter = initialized_adapter();
        assert!(adapter.snapshot_state().is_err());
        assert!(adapter.restore_state(b"state").is_err());
        assert_eq!(adapter.info().extra["accepted_for_hmr"], "false");
        assert_eq!(adapter.info().extra["runtime_dispatch_proven"], "false");
    }

    #[cfg(unix)]
    fn compile_shared_object(source: &str) -> (tempfile::TempDir, PathBuf, String) {
        use std::process::Command;

        let temp = tempfile::tempdir().expect("create temporary source directory");
        let source_path = temp.path().join("candidate.c");
        let artifact_path = temp.path().join("candidate.so");
        std::fs::write(&source_path, source).expect("write candidate source");
        let output = Command::new("cc")
            .args(["-shared", "-fPIC"])
            .arg(&source_path)
            .arg("-o")
            .arg(&artifact_path)
            .output()
            .expect("execute C compiler");
        assert!(
            output.status.success(),
            "shared-object compile failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let hash = sha256_prefixed(&std::fs::read(&artifact_path).expect("read artifact"));
        (temp, artifact_path, hash)
    }

    #[cfg(unix)]
    #[test]
    fn observed_bytes_and_exports_yield_support_only_preflight() {
        let (_temp, artifact, hash) = compile_shared_object(
            r#"
                void *entrypoint(void *host) { return host; }
                void on_update(void *state, double dt) { (void)state; (void)dt; }
            "#,
        );
        let mut req = request(&artifact, &hash);
        req.build_manifest.exported_symbols = vec![
            "core_on_load".into(),
            "core_on_update".into(),
            "core_get_api".into(),
        ];
        let mut adapter = initialized_adapter();

        let result = adapter.reload(&req);

        assert!(matches!(result, AdapterReloadResult::Unsupported { .. }));
        let info = adapter.info();
        assert_eq!(info.extra["reload_count"], "0");
        assert_eq!(info.capability_tier, CapabilityTier::Tier0);
        assert_eq!(info.extra["candidate_preflight_count"], "1");
        assert_eq!(info.extra["candidate_artifact_sha256"], hash);
        assert_eq!(info.extra["candidate_module_id"], "tenant/module-17");
        assert_eq!(info.extra["candidate_lifecycle_abi"], "Legacy");
        assert_eq!(info.extra["accepted_for_hmr"], "false");
        assert_eq!(info.extra["evidence_authority"], DYNLIB_PREFLIGHT_AUTHORITY);
        assert_eq!(adapter.healthcheck(), AdapterHealth::Unknown);
    }

    #[cfg(unix)]
    #[test]
    fn candidate_hash_must_match_observed_artifact_bytes() {
        let (_temp, artifact, _hash) = compile_shared_object(
            r#"
                void *entrypoint(void *host) { return host; }
                void on_update(void *state, double dt) { (void)state; (void)dt; }
            "#,
        );
        let mut adapter = initialized_adapter();
        let result = adapter.reload(&request(
            &artifact,
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        ));

        assert!(matches!(result, AdapterReloadResult::Failed { .. }));
        assert_eq!(adapter.info().extra["candidate_preflight_count"], "0");
    }

    #[cfg(unix)]
    #[test]
    fn artifact_blob_hash_and_bytes_must_bind_to_observed_file() {
        let (_temp, artifact, hash) = compile_shared_object(
            r#"
                void *entrypoint(void *host) { return host; }
                void on_update(void *state, double dt) { (void)state; (void)dt; }
            "#,
        );
        let cases = [
            ReloadArtifactBlob {
                blob_id: "candidate-blob".into(),
                content_hash:
                    "sha256:0000000000000000000000000000000000000000000000000000000000000000".into(),
                bytes: Vec::new(),
            },
            ReloadArtifactBlob {
                blob_id: "candidate-blob".into(),
                content_hash: hash.clone(),
                bytes: b"different artifact bytes".to_vec(),
            },
        ];

        for artifact_blob in cases {
            let mut req = request(&artifact, &hash);
            req.artifact_blob = Some(artifact_blob);
            let mut adapter = initialized_adapter();
            assert!(matches!(
                adapter.reload(&req),
                AdapterReloadResult::Failed { .. }
            ));
            assert_eq!(adapter.info().extra["candidate_preflight_count"], "0");
        }
    }

    #[cfg(unix)]
    #[test]
    fn incomplete_and_mixed_observed_lifecycles_fail_closed() {
        let cases = [
            r#"void core_on_load(void) {}"#,
            r#"
                void *entrypoint(void *host) { return host; }
                void on_update(void *state, double dt) { (void)state; (void)dt; }
                void *gui_on_load(void *a, void *b, void *c) {
                    (void)b; (void)c; return a;
                }
                void gui_on_render(void *state) { (void)state; }
            "#,
        ];

        for source in cases {
            let (_temp, artifact, hash) = compile_shared_object(source);
            let mut adapter = initialized_adapter();
            assert!(matches!(
                adapter.reload(&request(&artifact, &hash)),
                AdapterReloadResult::Failed { .. }
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn symbol_validation_cannot_be_disabled() {
        let (_temp, artifact, hash) = compile_shared_object(
            r#"
                void *entrypoint(void *host) { return host; }
                void on_update(void *state, double dt) { (void)state; (void)dt; }
            "#,
        );
        let mut adapter = DynLibAdapter::new(DynLibAdapterConfig {
            validate_symbols: false,
            ..DynLibAdapterConfig::default()
        });
        adapter.initialize().unwrap();

        assert!(matches!(
            adapter.reload(&request(&artifact, &hash)),
            AdapterReloadResult::Failed { .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn preservation_requires_observed_state_exports_for_resolved_abi() {
        let (_temp, artifact, hash) = compile_shared_object(
            r#"
                void *entrypoint(void *host) { return host; }
                void on_update(void *state, double dt) { (void)state; (void)dt; }
            "#,
        );
        let mut req = request(&artifact, &hash);
        req.preserve_state = true;
        let mut adapter = initialized_adapter();

        assert!(matches!(
            adapter.reload(&req),
            AdapterReloadResult::Failed { .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn failed_candidate_does_not_replace_last_observed_preflight() {
        let (_temp, artifact, hash) = compile_shared_object(
            r#"
                void *entrypoint(void *host) { return host; }
                void on_update(void *state, double dt) { (void)state; (void)dt; }
            "#,
        );
        let mut adapter = initialized_adapter();
        assert!(matches!(
            adapter.reload(&request(&artifact, &hash)),
            AdapterReloadResult::Unsupported { .. }
        ));
        let accepted_hash = adapter.info().extra["candidate_artifact_sha256"].clone();

        let mut invalid = request(&artifact, &hash);
        invalid.module_id = " invalid ".into();
        assert!(matches!(
            adapter.reload(&invalid),
            AdapterReloadResult::Failed { .. }
        ));
        let info = adapter.info();
        assert_eq!(info.extra["candidate_preflight_count"], "1");
        assert_eq!(info.extra["candidate_artifact_sha256"], accepted_hash);
    }
}
