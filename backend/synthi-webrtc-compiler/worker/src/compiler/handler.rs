use crate::debug_log;
use anyhow::{Context, Result};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};

use crate::compiler::builder::{
    hash_content, hash_shared_header_semantic, ModuleHashes, RebuildScope,
};
use crate::compiler::context::CompileContext;
use crate::infra::crash_recovery::PLUGIN_TIMEOUT_SECS;
use crate::infra::messages::{CompileRequest, FileEntry, FileRef};
use sha2::{Digest, Sha256};

// ULTRAPLAN Lightning Phase 11 — per-process Tier 0 bypass counters.
// Atomic so they're safe across concurrent compile requests (unlikely
// in practice — single worker — but correct by construction).
static TIER0_HITS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static TIER0_MISSES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static TIER0_INELIGIBLE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static RUNNER_RUNTIME_CONTROL_SEQ: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
const MAX_DEVICE_PARTIAL_ARTIFACTS: usize = 128;
const MAX_WARM_SOURCE_BRIDGE_TUS: usize = 16;
const MAX_SOURCE_BRIDGE_SUPPORT_INLINE_DEPTH: usize = 6;
const MAX_SOURCE_BRIDGE_SUPPORT_INLINE_BYTES: usize = 256 * 1024;
const DEFAULT_WORKSPACE_FILE_REF_SEARCH_DEPTH: usize = 8;
const MAX_WORKSPACE_FILE_REF_SEARCH_DEPTH: usize = 32;
const DEFAULT_WORKSPACE_FILE_REF_SEARCH_LIMIT: usize = 16_384;
const MAX_WORKSPACE_FILE_REF_SEARCH_LIMIT: usize = 65_536;
const DEFAULT_RUNNER_RUNTIME_CONTROL_ACK_GRACE_MS: u64 = 5_000;
const DEFAULT_RUNNER_RUNTIME_CONTROL_ACK_TIMEOUT_MS: u64 =
    PLUGIN_TIMEOUT_SECS * 1_000 + DEFAULT_RUNNER_RUNTIME_CONTROL_ACK_GRACE_MS;

// Import our new modular stages
use crate::compiler::stages::ai_utils::{
    invalidate_ai_split_cache, perform_ai_diff_patch, perform_ai_split, perform_gpu_ai_diff_patch,
    update_ai_split_cache_role,
};
use crate::compiler::stages::compile_core::compile_core;
use crate::compiler::stages::compile_device::{
    compile_device_phase0, DeviceCompileOutcome, DeviceCompileProofMetadata,
};
use crate::compiler::stages::compile_gui::compile_gui;
use crate::compiler::stages::compile_runner::{
    compile_runner, CompileRunnerOptions, HOST_RUNNER_FILENAME,
};
use crate::compiler::stages::gpu_runtime_contract::ensure_gpu_runtime_contract_header;
use crate::compiler::stages::guardrails::{
    apply_core_guardrails, apply_gui_guardrails, apply_shared_guardrails,
};
use crate::compiler::stages::runner::{handle_runner_execution, RunnerReloadPolicy};
use crate::runtime::capability::HmrStatus;
use tokio::io::AsyncWriteExt;

fn compile_request_relpath(path: &str) -> Result<PathBuf> {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        anyhow::bail!("compile request contains an empty filename");
    }

    if normalized.starts_with('/') || normalized.starts_with("//") {
        anyhow::bail!("compile request filename is not workspace-relative: {path}");
    }

    let drive_prefixed = normalized
        .as_bytes()
        .get(0..2)
        .is_some_and(|prefix| prefix[0].is_ascii_alphabetic() && prefix[1] == b':');
    if drive_prefixed {
        anyhow::bail!("compile request filename is not workspace-relative: {path}");
    }

    let mut rel = PathBuf::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                anyhow::bail!("compile request filename is not workspace-relative: {path}");
            }
            part => rel.push(part),
        }
    }

    if rel.as_os_str().is_empty() {
        anyhow::bail!("compile request filename resolves to an empty path: {path}");
    }
    Ok(rel)
}

async fn write_compile_request_file_bytes(
    workspace: &Path,
    name: &str,
    content: &[u8],
) -> Result<()> {
    let rel = compile_request_relpath(name)?;
    let path = workspace.join(&rel);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("creating compile request parent {}", parent.display()))?;
    }
    tokio::fs::write(&path, content)
        .await
        .with_context(|| format!("writing compile request file {}", path.display()))?;
    Ok(())
}

async fn write_compile_request_file(workspace: &Path, name: &str, content: &str) -> Result<()> {
    write_compile_request_file_bytes(workspace, name, content.as_bytes()).await
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct WorkspaceFileRefSummary {
    count: usize,
    bytes: usize,
}

fn normalize_optional_sha256(raw: &str) -> String {
    raw.trim()
        .strip_prefix("sha256:")
        .unwrap_or_else(|| raw.trim())
        .to_ascii_lowercase()
}

fn file_ref_bytes_match_integrity(file_ref: &FileRef, bytes: &[u8]) -> bool {
    if let Some(expected) = file_ref.bytes {
        if bytes.len() as u64 != expected {
            return false;
        }
    }
    if let Some(expected) = file_ref.sha256.as_deref() {
        let actual = format!("{:x}", Sha256::digest(bytes));
        if actual != normalize_optional_sha256(expected) {
            return false;
        }
    }
    true
}

fn bounded_usize_env(name: &str, default_value: usize, max_value: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(max_value))
        .unwrap_or(default_value)
}

async fn push_existing_file_ref_candidate(
    candidates: &mut Vec<PathBuf>,
    seen_candidates: &mut BTreeSet<PathBuf>,
    slug_root: &Path,
    candidate: PathBuf,
) -> Result<()> {
    let metadata = match tokio::fs::metadata(&candidate).await {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(err).with_context(|| {
                format!(
                    "reading collab workspace file ref metadata {}",
                    candidate.display()
                )
            });
        }
    };
    if !metadata.is_file() {
        return Ok(());
    }
    let canonical = match tokio::fs::canonicalize(&candidate).await {
        Ok(path) => path,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(err).with_context(|| {
                format!("resolving collab workspace file ref {}", candidate.display())
            });
        }
    };
    if !canonical.starts_with(slug_root) {
        anyhow::bail!(
            "collab workspace file ref escaped workspace root: {}",
            candidate.display()
        );
    }
    if seen_candidates.insert(canonical.clone()) {
        candidates.push(canonical);
    }
    Ok(())
}

#[derive(Debug)]
struct CollabFileRefIndex {
    slug_root: PathBuf,
    candidate_dirs: Vec<PathBuf>,
    search_limit: usize,
}

impl CollabFileRefIndex {
    async fn from_slug(slug: Option<&str>) -> Result<Option<Self>> {
        let Some(slug) = slug.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let Some(root) = std::env::var("SYNTHI_REPOS_PATH")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
        else {
            return Ok(None);
        };
        let Ok(root) = tokio::fs::canonicalize(&root).await else {
            return Ok(None);
        };
        let slug_rel = compile_request_relpath(slug)?;
        let slug_root = root.join(slug_rel);
        let Ok(canonical_slug_root) = tokio::fs::canonicalize(&slug_root).await else {
            return Ok(None);
        };
        if !canonical_slug_root.starts_with(&root) {
            anyhow::bail!("workspace slug escaped repo root: {slug}");
        }

        let max_depth = bounded_usize_env(
            "SYNTHI_WORKSPACE_FILE_REF_SEARCH_DEPTH",
            DEFAULT_WORKSPACE_FILE_REF_SEARCH_DEPTH,
            MAX_WORKSPACE_FILE_REF_SEARCH_DEPTH,
        );
        let search_limit = bounded_usize_env(
            "SYNTHI_WORKSPACE_FILE_REF_SEARCH_LIMIT",
            DEFAULT_WORKSPACE_FILE_REF_SEARCH_LIMIT,
            MAX_WORKSPACE_FILE_REF_SEARCH_LIMIT,
        );

        let mut candidate_dirs = Vec::new();
        let mut seen_dirs = BTreeSet::new();
        let mut queue = VecDeque::new();
        seen_dirs.insert(canonical_slug_root.clone());
        queue.push_back((canonical_slug_root.clone(), 0usize));

        while let Some((dir, depth)) = queue.pop_front() {
            candidate_dirs.push(dir.clone());
            if depth >= max_depth {
                continue;
            }

            let mut entries = tokio::fs::read_dir(&dir)
                .await
                .with_context(|| format!("reading collab repo directory {}", dir.display()))?;
            while let Some(entry) = entries.next_entry().await? {
                let file_name = entry.file_name();
                if file_name.to_string_lossy() == ".git" {
                    continue;
                }
                if !entry.file_type().await?.is_dir() {
                    continue;
                }
                let Ok(canonical_child) = tokio::fs::canonicalize(entry.path()).await else {
                    continue;
                };
                if !canonical_child.starts_with(&canonical_slug_root) {
                    continue;
                }
                if seen_dirs.insert(canonical_child.clone()) {
                    if seen_dirs.len() > search_limit {
                        anyhow::bail!(
                            "workspace file ref search exceeded directory limit: {slug}"
                        );
                    }
                    queue.push_back((canonical_child, depth + 1));
                }
            }
        }
        Ok(Some(Self {
            slug_root: canonical_slug_root,
            candidate_dirs,
            search_limit,
        }))
    }

    async fn candidates_for(&self, rel: &Path) -> Result<Vec<PathBuf>> {
        let mut candidates = Vec::new();
        let mut seen_candidates = BTreeSet::new();
        for dir in &self.candidate_dirs {
            push_existing_file_ref_candidate(
                &mut candidates,
                &mut seen_candidates,
                &self.slug_root,
                dir.join(rel),
            )
            .await?;
            if candidates.len() > self.search_limit {
                anyhow::bail!(
                    "workspace file ref search exceeded candidate limit: {}",
                    rel.display()
                );
            }
        }
        Ok(candidates)
    }
}

async fn read_collab_repo_file_ref(
    collab_index: Option<&CollabFileRefIndex>,
    rel: &Path,
    normalized: &str,
    file_ref: &FileRef,
) -> Result<Option<Vec<u8>>> {
    let Some(collab_index) = collab_index else {
        return Ok(None);
    };
    let mut existing = Vec::new();
    for candidate in collab_index.candidates_for(rel).await? {
        match tokio::fs::read(&candidate).await {
            Ok(bytes) => existing.push((candidate, bytes)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(err)
                    .with_context(|| format!("reading collab workspace file ref {}", normalized));
            }
        }
    }
    if existing.is_empty() {
        return Ok(None);
    }

    let matches = existing
        .iter()
        .filter(|(_, bytes)| file_ref_bytes_match_integrity(file_ref, bytes))
        .collect::<Vec<_>>();
    let selected = if matches.is_empty() {
        existing.remove(0).1
    } else {
        let first = &matches[0].1;
        if matches
            .iter()
            .any(|(_, bytes)| bytes.as_slice() != first.as_slice())
        {
            anyhow::bail!("ambiguous collab workspace file ref: {}", normalized);
        }
        first.clone()
    };
    Ok(Some(selected))
}

async fn read_workspace_file_ref_bytes(
    workspace: &Path,
    canonical_workspace: &Path,
    rel: &Path,
    normalized: &str,
    file_ref: &FileRef,
    collab_index: Option<&CollabFileRefIndex>,
) -> Result<Vec<u8>> {
    let path = workspace.join(rel);
    match tokio::fs::canonicalize(&path).await {
        Ok(canonical_path) => {
            if !canonical_path.starts_with(canonical_workspace) {
                anyhow::bail!("workspace file ref escaped workspace: {}", normalized);
            }
            let bytes = tokio::fs::read(&canonical_path)
                .await
                .with_context(|| format!("reading workspace file ref {}", normalized))?;
            if file_ref_bytes_match_integrity(file_ref, &bytes) {
                return Ok(bytes);
            }
            if let Some(bytes) =
                read_collab_repo_file_ref(collab_index, rel, normalized, file_ref).await?
            {
                write_compile_request_file_bytes(workspace, normalized, &bytes).await?;
                return Ok(bytes);
            }
            Ok(bytes)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if let Some(bytes) =
                read_collab_repo_file_ref(collab_index, rel, normalized, file_ref).await?
            {
                write_compile_request_file_bytes(workspace, normalized, &bytes).await?;
                return Ok(bytes);
            }
            Err(err).with_context(|| format!("resolving workspace file ref {}", normalized))
        }
        Err(err) => {
            Err(err).with_context(|| format!("resolving workspace file ref {}", normalized))
        }
    }
}

async fn hydrate_workspace_file_refs(
    workspace: &Path,
    req: &mut CompileRequest,
) -> Result<WorkspaceFileRefSummary> {
    if req.file_refs.is_empty() {
        return Ok(WorkspaceFileRefSummary::default());
    }

    let canonical_workspace = tokio::fs::canonicalize(workspace)
        .await
        .with_context(|| format!("canonicalizing workspace {}", workspace.display()))?;
    let primary_name = normalized_request_filename(&req.filename);
    let mut known_contents: BTreeMap<String, String> = BTreeMap::new();
    if let Some(name) = primary_name.as_ref() {
        known_contents.insert(name.clone(), req.source.clone());
    }
    for file in &req.files {
        let normalized = normalized_request_filename(&file.name)
            .with_context(|| format!("normalizing inline compile file {}", file.name))?;
        if let Some(existing) = known_contents.get(&normalized) {
            if existing != &file.content {
                anyhow::bail!(
                    "inline compile files disagree for workspace path {}",
                    normalized
                );
            }
            continue;
        }
        known_contents.insert(normalized, file.content.clone());
    }

    let collab_index = CollabFileRefIndex::from_slug(req.slug.as_deref()).await?;
    let mut summary = WorkspaceFileRefSummary::default();
    for file_ref in &req.file_refs {
        let rel = compile_request_relpath(&file_ref.name)?;
        let normalized = rel.to_string_lossy().replace('\\', "/");
        let bytes = read_workspace_file_ref_bytes(
            workspace,
            &canonical_workspace,
            &rel,
            &normalized,
            file_ref,
            collab_index.as_ref(),
        )
        .await?;
        if let Some(expected) = file_ref.bytes {
            if bytes.len() as u64 != expected {
                anyhow::bail!(
                    "workspace file ref byte mismatch for {}: expected {} got {}",
                    normalized,
                    expected,
                    bytes.len()
                );
            }
        }
        if let Some(expected) = file_ref.sha256.as_deref() {
            let actual = format!("{:x}", Sha256::digest(&bytes));
            if actual != normalize_optional_sha256(expected) {
                anyhow::bail!(
                    "workspace file ref sha256 mismatch for {}: expected {} got {}",
                    normalized,
                    expected,
                    actual
                );
            }
        }
        let content = String::from_utf8(bytes)
            .with_context(|| format!("workspace file ref is not UTF-8 text: {}", normalized))?;
        if let Some(existing) = known_contents.get(&normalized) {
            if existing != &content {
                anyhow::bail!(
                    "workspace file ref conflicts with inline compile input: {}",
                    normalized
                );
            }
            continue;
        }
        summary.count += 1;
        summary.bytes += content.len();
        req.files.push(FileEntry {
            name: normalized.clone(),
            content: content.clone(),
        });
        known_contents.insert(normalized, content);
    }
    Ok(summary)
}

fn workspace_relative_string(workspace: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(workspace).unwrap_or(path);
    rel.to_string_lossy().replace('\\', "/")
}

fn adapted_module_filename(
    status: &AdaptedProjectStatus,
    workspace: &Path,
    kind: ModuleKind,
    fallback: &str,
) -> String {
    let path = match kind {
        ModuleKind::Shared => status.shared_path.as_ref(),
        ModuleKind::Core => status.core_path.as_ref(),
        ModuleKind::Gui => status.gui_path.as_ref(),
        ModuleKind::HostRunner => status.host_runner_path.as_ref(),
        ModuleKind::Device => None,
    };
    path.map(|p| workspace_relative_string(workspace, p))
        .unwrap_or_else(|| fallback.to_string())
}

fn normalized_request_filename(path: &str) -> Option<String> {
    compile_request_relpath(path)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

fn is_editing_adapted_module_or_device(
    filename: &str,
    status: &AdaptedProjectStatus,
    workspace: &Path,
    request_manifest: Option<&CompileManifest>,
) -> bool {
    let Some(req_name) = normalized_request_filename(filename) else {
        return false;
    };
    let mut candidates = Vec::new();
    if let Some(ref p) = status.shared_path {
        candidates.push(workspace_relative_string(workspace, p));
    }
    if let Some(ref p) = status.core_path {
        candidates.push(workspace_relative_string(workspace, p));
    }
    if let Some(ref p) = status.gui_path {
        candidates.push(workspace_relative_string(workspace, p));
    }
    if let Some(ref p) = status.host_runner_path {
        candidates.push(workspace_relative_string(workspace, p));
    }
    if let Some(device) = request_manifest.and_then(|m| m.device_source_filename()) {
        candidates.push(
            device
                .replace('\\', "/")
                .trim_start_matches("./")
                .to_string(),
        );
    }
    candidates.push("device.cu".to_string());
    candidates.push("device.hip".to_string());
    candidates
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(&req_name))
}

async fn sync_compile_request_workspace(ctx: &CompileContext, req: &CompileRequest) -> Result<()> {
    for file in &req.files {
        write_compile_request_file(&ctx.workspace_path, &file.name, &file.content).await?;
    }
    write_compile_request_file(&ctx.workspace_path, &req.filename, &req.source).await?;
    eprintln!(
        "[Compile] synced inline request files: primary={} additional={}",
        req.filename,
        req.files.len()
    );
    Ok(())
}

/// Write the split sidecar to disk with end-to-end operator logging.
///
/// Replaces the previous `let _ = tokio::fs::write(...)` pattern that
/// silently discarded both success and errors. The architecture cache
/// landing in the sidecar is load-bearing for every subsequent Tier 2
/// diff_patch, so we need to *see* it being written — path, byte count,
/// and the `architecture` field length — to verify the cache round-trips.
///
/// Uses `eprintln!` (not `debug_log!`) so it surfaces without the
/// `SYNTHI_WORKER_VERBOSE=1` env var. Operator observability trumps log
/// noise here; four call sites total.
async fn write_sidecar_logged(path: &std::path::Path, meta: &serde_json::Value, session_id: &str) {
    let mut enriched_meta = normalize_split_sidecar(meta);
    if let Some(obj) = enriched_meta.as_object_mut() {
        obj.insert(
            "sessionId".to_string(),
            serde_json::Value::String(session_id.to_string()),
        );
    }
    let body = match serde_json::to_string(&enriched_meta) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[HMR] sidecar serialize failed: {}", e);
            return;
        }
    };
    let arch_len = enriched_meta
        .get("architecture")
        .and_then(|v| v.as_str())
        .map(|s| s.len())
        .unwrap_or(0);
    let manifest_present = enriched_meta
        .get("compile_manifest")
        .map(|v| !v.is_null())
        .unwrap_or(false);
    match tokio::fs::write(path, &body).await {
        Ok(()) => {
            eprintln!(
                "[HMR] sidecar written: {} ({} bytes, arch={} chars, compile_manifest={})",
                path.display(),
                body.len(),
                arch_len,
                if manifest_present { "yes" } else { "no" },
            );
        }
        Err(e) => {
            eprintln!("[HMR] sidecar WRITE FAILED: {} → {}", path.display(), e);
        }
    }
}

fn sidecar_session_id(meta: &serde_json::Value) -> Option<&str> {
    meta.get("sessionId")
        .or_else(|| meta.get("session_id"))
        .and_then(|v| v.as_str())
}

async fn read_normalized_split_sidecar_for_proof(path: &Path) -> Option<serde_json::Value> {
    let raw = tokio::fs::read_to_string(path).await.ok()?;
    let meta = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    Some(normalize_split_sidecar(&meta))
}

async fn purge_stale_split_state_for_session(
    workspace: &Path,
    sidecar_path: &Path,
    session_id: &str,
    active_runner_session: Option<String>,
) -> Result<()> {
    let Ok(meta_raw) = tokio::fs::read_to_string(sidecar_path).await else {
        return Ok(());
    };
    let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_raw) else {
        return Ok(());
    };
    let sidecar_session = sidecar_session_id(&meta);
    let explicit_mismatch = sidecar_session
        .map(|cached| cached != session_id)
        .unwrap_or(false);
    let legacy_cross_session = sidecar_session.is_none()
        && active_runner_session
            .as_deref()
            .map(|active| active != session_id)
            .unwrap_or(false);

    if !(explicit_mismatch || legacy_cross_session) {
        return Ok(());
    }

    eprintln!(
        "[HMR] purging stale split sidecar for session mismatch: cached={:?} active_runner={:?} requested={}",
        sidecar_session,
        active_runner_session.as_deref(),
        session_id
    );
    match tokio::fs::remove_file(sidecar_path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(e).with_context(|| format!("removing stale {}", sidecar_path.display()))
        }
    }
    let synthi_dir = workspace.join(".synthi");
    match tokio::fs::remove_dir_all(&synthi_dir).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(e).with_context(|| format!("removing stale {}", synthi_dir.display()))
        }
    }
    Ok(())
}

fn split_agentic_report(result: &serde_json::Value) -> serde_json::Value {
    result
        .get("_synthi_agentic_report")
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}

fn generated_artifact_report(result: &serde_json::Value) -> serde_json::Value {
    result
        .get("_synthi_generated_artifact_report")
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}

fn device_mapping_report(result: &serde_json::Value) -> serde_json::Value {
    result
        .get("_synthi_device_mapping_report")
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}

fn source_context_report(result: &serde_json::Value) -> serde_json::Value {
    result
        .get("_synthi_source_context_report")
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}

fn launch_indirection_report(result: &serde_json::Value) -> serde_json::Value {
    result
        .get("_synthi_launch_indirection_report")
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}

/// Thin handler-side wrapper around `edit_applier::apply_edit_list`
/// that adds per-edit eprintln logging for operator observability.
/// The actual dispatch logic lives in `hmr::edit_applier::apply_edit_list`
/// so it is independently unit-testable from integration tests without
/// needing a CompileContext.
fn apply_edit_list(
    edits: &[crate::hmr::edit_applier::Edit],
    core: &str,
    gui: &str,
    shared: &str,
    host_runner: &str,
) -> anyhow::Result<(String, String, String, String)> {
    for (i, edit) in edits.iter().enumerate() {
        eprintln!(
            "[HMR] Tier 2: applying edit #{} {:?} to {} (anchor {} chars, content {} chars)",
            i,
            edit.operation,
            edit.module,
            edit.anchor.len(),
            edit.content.len()
        );
    }
    crate::hmr::edit_applier::apply_edit_list(edits, core, gui, shared, host_runner)
}

use crate::hmr::adapted_project::{detect_adapted_project, AdaptedProjectStatus};
use crate::hmr::adapter_trait::{AdapterReloadResult, ReloadArtifactBlob};
use crate::hmr::ai_bypass::{check_ai_bypass, AiBypassResult, SplitCache};
use crate::hmr::build_manifest::{BuildManifest, BuildSlot, SnapshotMode};
use crate::hmr::compile_enrichment::CompileEnrichment;
use crate::hmr::compile_manifest::{CompileManifest, DeviceVendor, ModuleKind};
use crate::hmr::deterministic_compile::{
    determine_deterministic_scope, validate_deterministic_input, DeterministicCompileInput,
    DeterministicRebuildScope,
};
use crate::hmr::gpu_device_fast_path::{
    build_device_include_bridge_partial_source, build_device_partial_source,
    changed_kernel_body_symbols, device_header_kernel_body_only_edit_symbol,
    device_only_capability_rejection_reason, device_source_hash, mapped_generated_device_path,
    try_direct_device_body_patch,
};
use crate::hmr::gpu_fission::verify_fission_candidates;
use crate::hmr::gpu_prod_contracts::{normalize_split_sidecar, RELOAD_PLAN_SCHEMA_VERSION};
use crate::hmr::gpu_proof::{
    sha256_hex_bytes, sha256_hex_str, write_proof_artifact, GpuHmrDegradedState,
    GpuHmrProofArtifact, GpuHmrProofArtifactInput, GpuHmrProofArtifactWrite,
    GpuHmrProofEvidenceRef, GpuHmrProofStageResult, GpuHmrProofState, GpuHmrProofTelemetry,
};
use crate::hmr::loop_classifier::{classify_loop, LoopClassifierInput};

fn strip_c_like_comments(source: &str) -> String {
    #[derive(Clone, Copy)]
    enum State {
        Normal,
        Slash,
        LineComment,
        BlockComment,
        BlockStar,
    }

    let mut out = String::with_capacity(source.len());
    let mut state = State::Normal;
    for ch in source.chars() {
        match (state, ch) {
            (State::Normal, '/') => state = State::Slash,
            (State::Normal, _) => out.push(ch),
            (State::Slash, '/') => {
                out.push(' ');
                state = State::LineComment;
            }
            (State::Slash, '*') => {
                out.push(' ');
                state = State::BlockComment;
            }
            (State::Slash, _) => {
                out.push('/');
                out.push(ch);
                state = State::Normal;
            }
            (State::LineComment, '\n') => {
                out.push('\n');
                state = State::Normal;
            }
            (State::LineComment, _) => {}
            (State::BlockComment, '*') => state = State::BlockStar,
            (State::BlockComment, '\n') => out.push('\n'),
            (State::BlockComment, _) => {}
            (State::BlockStar, '/') => {
                out.push(' ');
                state = State::Normal;
            }
            (State::BlockStar, '*') => {}
            (State::BlockStar, '\n') => {
                out.push('\n');
                state = State::BlockComment;
            }
            (State::BlockStar, _) => state = State::BlockComment,
        }
    }
    if matches!(state, State::Slash) {
        out.push('/');
    }
    out
}

fn extract_device_kernel_symbols(source: &str) -> Vec<String> {
    extract_device_kernel_declarations(source)
        .into_iter()
        .map(|decl| decl.name)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DeviceKernelDeclaration {
    name: String,
    signature: String,
}

fn extract_device_kernel_declarations(source: &str) -> Vec<DeviceKernelDeclaration> {
    let uncommented = strip_c_like_comments(source);
    let launch_bounds = match regex::Regex::new(r"__launch_bounds__\s*\([^)]*\)") {
        Ok(re) => re,
        Err(_) => return Vec::new(),
    };
    let normalized = launch_bounds.replace_all(&uncommented, " ");
    let re =
        match regex::Regex::new(r"__global__[^;{}()]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)") {
            Ok(re) => re,
            Err(_) => return Vec::new(),
        };
    let mut decls: Vec<DeviceKernelDeclaration> = re
        .captures_iter(&normalized)
        .filter_map(|caps| {
            let name = caps.get(1)?.as_str().to_string();
            let params = caps.get(2).map(|m| m.as_str()).unwrap_or_default();
            Some(DeviceKernelDeclaration {
                signature: format!("{}({})", name, normalize_kernel_params(params)),
                name,
            })
        })
        .collect();
    decls.sort_by(|a, b| a.name.cmp(&b.name).then(a.signature.cmp(&b.signature)));
    decls.dedup_by(|a, b| a.name == b.name && a.signature == b.signature);
    decls
}

fn extract_device_kernel_signatures(source: &str) -> Vec<String> {
    extract_device_kernel_declarations(source)
        .into_iter()
        .map(|decl| decl.signature)
        .collect()
}

fn normalize_kernel_params(params: &str) -> String {
    let normalized = split_top_level_params(params)
        .into_iter()
        .map(|param| normalize_kernel_param(&param))
        .filter(|param| !param.is_empty() && param != "void")
        .collect::<Vec<_>>();
    normalized.join(",")
}

fn split_top_level_params(params: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut paren = 0_i32;
    let mut bracket = 0_i32;
    let mut angle = 0_i32;
    for ch in params.chars() {
        match ch {
            '(' => paren += 1,
            ')' => paren -= 1,
            '[' => bracket += 1,
            ']' => bracket -= 1,
            '<' => angle += 1,
            '>' => angle -= 1,
            ',' if paren == 0 && bracket == 0 && angle == 0 => {
                out.push(current.trim().to_string());
                current.clear();
                continue;
            }
            _ => {}
        }
        current.push(ch);
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

fn normalize_kernel_param(param: &str) -> String {
    let without_default = param.split('=').next().unwrap_or(param).trim();
    let spaced = without_default
        .replace('*', " * ")
        .replace('&', " & ")
        .replace('[', " [ ")
        .replace(']', " ] ");
    let mut tokens = spaced
        .split_whitespace()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();

    if tokens.len() >= 2 {
        if let Some(last) = tokens.last() {
            if is_c_identifier(last) && !is_type_keyword(last) {
                tokens.pop();
            }
        }
    }

    tokens
        .join(" ")
        .replace(" *", "*")
        .replace(" &", "&")
        .replace(" [ ]", "[]")
}

fn is_type_keyword(token: &str) -> bool {
    matches!(
        token,
        "const"
            | "volatile"
            | "restrict"
            | "__restrict__"
            | "signed"
            | "unsigned"
            | "short"
            | "long"
            | "int"
            | "float"
            | "double"
            | "char"
            | "void"
            | "bool"
            | "size_t"
    )
}

fn is_c_identifier(token: &str) -> bool {
    let mut chars = token.chars();
    match chars.next() {
        Some(ch) if ch == '_' || ch.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn kernel_abi_fingerprint_source(source: &str) -> String {
    let kernel_symbols = extract_device_kernel_symbols(source);
    let kernel_signatures = extract_device_kernel_signatures(source);
    if kernel_signatures.is_empty() {
        kernel_symbols.join("|")
    } else {
        kernel_signatures.join("|")
    }
}

fn device_constant_global_layout_fingerprint(source: &str) -> String {
    let re = match regex::Regex::new(r"\b(__constant__|__device__|__managed__)\s+([^;]+);") {
        Ok(re) => re,
        Err(_) => return String::new(),
    };
    let mut decls = Vec::new();
    for captures in re.captures_iter(source) {
        let storage = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let decl = captures
            .get(2)
            .map(|m| m.as_str().split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        if decl.contains('(') {
            continue;
        }
        decls.push(format!("{storage} {decl}"));
    }
    decls.sort();
    format!("{}", hash_content(&decls.join(";")))
}

fn source_scan_abi_extractor_provenance(source: &str) -> serde_json::Value {
    serde_json::json!([{
        "extractorName": "synthi_source_text_kernel_signature_scan",
        "extractorKind": "source_text_scan",
        "extractorVersion": "v1",
        "inputHash": format!("sha256:{}", sha256_hex_str(source)),
        "acceptedByRuntimeCorrectnessPlan": false,
        "rejectedReason": "source_text_scan_is_not_an_accepted_abi_extractor",
        "evidenceScope": [
            "kernel_symbols",
            "kernel_signatures",
            "constant_global_text"
        ]
    }])
}

#[derive(Debug, Clone)]
struct ClangAstAbiExtraction {
    layout_size_alignment_verified: bool,
    accepted_extractor_evidence_refs: Vec<String>,
    accepted_extractor_sources: Vec<String>,
    extractor_provenance: Vec<serde_json::Value>,
    kernel_signatures: Vec<String>,
    parameter_abi_records: Vec<serde_json::Value>,
    degraded_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct ClangAstAbiAttempt {
    language: String,
    command: String,
    status: String,
    stderr_summary: String,
}

fn canonical_clang_type(ty: &str) -> String {
    ty.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace(" *", "*")
        .replace("* ", "*")
        .replace(" &", "&")
        .replace("& ", "&")
}

fn layout_type_without_cv(ty: &str) -> String {
    canonical_clang_type(ty)
        .split_whitespace()
        .filter(|token| !matches!(*token, "const" | "volatile"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn scalar_type_layout(ty: &str) -> Option<(usize, usize)> {
    match layout_type_without_cv(ty).as_str() {
        "bool" | "char" | "signed char" | "unsigned char" => Some((1, 1)),
        "short" | "short int" | "signed short" | "signed short int" | "unsigned short"
        | "unsigned short int" => Some((2, 2)),
        "int" | "signed int" | "unsigned int" | "float" => Some((4, 4)),
        "long"
        | "long int"
        | "signed long"
        | "signed long int"
        | "unsigned long"
        | "unsigned long int"
        | "long long"
        | "long long int"
        | "signed long long"
        | "signed long long int"
        | "unsigned long long"
        | "unsigned long long int"
        | "double"
        | "size_t"
        | "std::size_t" => Some((8, 8)),
        _ => None,
    }
}

fn record_type_layout_key(ty: &str) -> String {
    let mut key = layout_type_without_cv(ty);
    for prefix in ["struct ", "class ", "union "] {
        if let Some(stripped) = key.strip_prefix(prefix) {
            key = stripped.trim().to_string();
            break;
        }
    }
    key
}

fn parse_clang_record_layout_name(line: &str) -> Option<String> {
    let (_, rhs) = line.split_once('|')?;
    let leading_spaces = rhs.chars().take_while(|ch| *ch == ' ').count();
    if leading_spaces > 1 {
        return None;
    }
    let trimmed = rhs.trim();
    let rest = ["struct ", "class ", "union "]
        .into_iter()
        .find_map(|prefix| trimmed.strip_prefix(prefix))?;
    let name = rest
        .split(" (")
        .next()
        .unwrap_or_default()
        .trim();
    if name.is_empty() || name.starts_with("(anonymous") {
        return None;
    }
    Some(record_type_layout_key(name))
}

fn parse_clang_record_layout_size_alignment(line: &str) -> Option<(usize, usize)> {
    let size_re = regex::Regex::new(r"sizeof=([0-9]+)").ok()?;
    let align_re = regex::Regex::new(r"align=([0-9]+)").ok()?;
    let size = size_re
        .captures(line)?
        .get(1)?
        .as_str()
        .parse::<usize>()
        .ok()?;
    let alignment = align_re
        .captures(line)?
        .get(1)?
        .as_str()
        .parse::<usize>()
        .ok()?;
    Some((size, alignment))
}

fn clang_record_layouts(ast_text: &str) -> BTreeMap<String, (usize, usize)> {
    let mut layouts = BTreeMap::new();
    let mut current_record: Option<String> = None;
    let mut pending_layout = false;

    for line in ast_text.lines() {
        if line.contains("Dumping AST Record Layout") {
            current_record = None;
            pending_layout = true;
            continue;
        }
        if pending_layout && current_record.is_none() {
            current_record = parse_clang_record_layout_name(line);
            continue;
        }
        if let Some(record) = current_record.clone() {
            if let Some((size, alignment)) = parse_clang_record_layout_size_alignment(line) {
                layouts.insert(record, (size, alignment));
                current_record = None;
                pending_layout = false;
            }
        }
    }

    layouts
}

fn abi_record_from_clang_param(
    kernel: &str,
    arg_index: usize,
    ty: &str,
    record_layouts: &BTreeMap<String, (usize, usize)>,
) -> Option<serde_json::Value> {
    let canonical = canonical_clang_type(ty);
    if canonical.contains('&') || canonical.contains('[') || canonical.contains(']') {
        return None;
    }
    if canonical.contains('*') {
        return Some(serde_json::json!({
            "kernel": kernel,
            "argIndex": arg_index,
            "typeIdentity": canonical,
            "size": 8,
            "alignment": 8,
            "addressSpace": "generic_pointer"
        }));
    }
    if let Some((size, alignment)) = scalar_type_layout(&canonical) {
        return Some(serde_json::json!({
            "kernel": kernel,
            "argIndex": arg_index,
            "typeIdentity": canonical,
            "size": size,
            "alignment": alignment,
            "addressSpace": "by_value"
        }));
    }
    clang_param_record_layout(kernel, arg_index, &canonical, record_layouts)
}

fn clang_param_record_layout(
    kernel: &str,
    arg_index: usize,
    ty: &str,
    record_layouts: &BTreeMap<String, (usize, usize)>,
) -> Option<serde_json::Value> {
    let canonical = canonical_clang_type(ty);
    if canonical.contains('*') || canonical.contains('&') || canonical.contains('[') {
        return None;
    }
    let record_key = record_type_layout_key(&canonical);
    let (size, alignment) = record_layouts.get(&record_key)?;
    Some(serde_json::json!({
        "kernel": kernel,
        "argIndex": arg_index,
        "typeIdentity": canonical,
        "size": size,
        "alignment": alignment,
        "addressSpace": "by_value",
        "layoutKind": "record",
        "recordLayoutSource": "clang_record_layout"
    }))
}

fn split_clang_function_params(params: &str) -> Vec<String> {
    split_top_level_params(params)
        .into_iter()
        .map(|param| canonical_clang_type(&param))
        .filter(|param| !param.is_empty() && param != "void")
        .collect()
}

fn clang_ast_kernel_signatures(
    ast_text: &str,
    target_symbols: &[String],
) -> BTreeMap<String, Vec<String>> {
    let target_symbols = target_symbols.iter().cloned().collect::<BTreeSet<_>>();
    let re = match regex::Regex::new(
        r#"FunctionDecl[^\n]*\b([A-Za-z_][A-Za-z0-9_]*)\s+'void \(([^']*)\)'"#,
    ) {
        Ok(re) => re,
        Err(_) => return BTreeMap::new(),
    };
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for caps in re.captures_iter(ast_text) {
        let Some(name) = caps.get(1).map(|m| m.as_str().to_string()) else {
            continue;
        };
        if !target_symbols.is_empty() && !target_symbols.contains(&name) {
            continue;
        }
        let params =
            split_clang_function_params(caps.get(2).map(|m| m.as_str()).unwrap_or_default());
        out.entry(name.clone())
            .or_default()
            .insert(format!("{}({})", name, params.join(",")));
    }
    out.into_iter()
        .map(|(name, signatures)| (name, signatures.into_iter().collect()))
        .collect()
}

fn has_device_constant_or_global_decl(source: &str) -> bool {
    regex::Regex::new(r"\b(__constant__|__device__|__managed__)\s+([^;]+);")
        .ok()
        .is_some_and(|re| {
            re.captures_iter(source).any(|caps| {
                !caps
                    .get(2)
                    .map(|m| m.as_str())
                    .unwrap_or_default()
                    .contains('(')
            })
        })
}

fn abi_extractor_text_summary(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join(" | ")
        .chars()
        .take(512)
        .collect()
}

fn clang_ast_abi_extraction_failure(
    source: &str,
    extractor_name: &str,
    reason: &str,
    attempts: Vec<ClangAstAbiAttempt>,
) -> ClangAstAbiExtraction {
    let attempt_values = attempts
        .iter()
        .map(|attempt| {
            serde_json::json!({
                "language": &attempt.language,
                "command": &attempt.command,
                "status": &attempt.status,
                "stderrSummary": &attempt.stderr_summary,
            })
        })
        .collect::<Vec<_>>();
    let evidence_material = serde_json::json!({
        "extractor": extractor_name,
        "reason": reason,
        "inputHash": format!("sha256:{}", sha256_hex_str(source)),
        "attempts": attempt_values,
    });
    let evidence_id = format!(
        "evidence:abi-extractor:{}",
        sha256_hex_str(&evidence_material.to_string())
    );
    ClangAstAbiExtraction {
        layout_size_alignment_verified: false,
        accepted_extractor_evidence_refs: Vec::new(),
        accepted_extractor_sources: Vec::new(),
        extractor_provenance: vec![serde_json::json!({
            "extractorName": extractor_name,
            "extractorKind": "clang_ast",
            "extractorVersion": "v1",
            "evidenceId": evidence_id,
            "inputHash": format!("sha256:{}", sha256_hex_str(source)),
            "acceptedByRuntimeCorrectnessPlan": false,
            "rejectedReason": reason,
            "evidenceScope": [
                "kernel_parameter_type_identities",
                "kernel_parameter_size_alignment",
                "device_constant_global_absence"
            ],
            "attempts": evidence_material["attempts"].clone(),
        })],
        kernel_signatures: Vec::new(),
        parameter_abi_records: Vec::new(),
        degraded_reason: Some(reason.to_string()),
    }
}

fn clang_ast_abi_extraction_from_dump(
    source: &str,
    ast_text: &str,
    target_symbols: &[String],
    extractor_command: &str,
    evidence_id: String,
) -> ClangAstAbiExtraction {
    let target_symbols = if target_symbols.is_empty() {
        extract_device_kernel_symbols(source)
    } else {
        target_symbols.to_vec()
    };
    let ast_signatures = clang_ast_kernel_signatures(ast_text, &target_symbols);
    let record_layouts = clang_record_layouts(ast_text);
    let mut kernel_signatures = Vec::new();
    let mut parameter_abi_records = Vec::new();
    let mut missing_symbols = Vec::new();
    let mut unsupported_params = Vec::new();

    for symbol in &target_symbols {
        let Some(signatures) = ast_signatures.get(symbol) else {
            missing_symbols.push(symbol.clone());
            continue;
        };
        for signature in signatures {
            kernel_signatures.push(signature.clone());
            let params = signature
                .split_once('(')
                .and_then(|(_, tail)| tail.strip_suffix(')'))
                .map(split_clang_function_params)
                .unwrap_or_default();
            for (index, param) in params.iter().enumerate() {
                match abi_record_from_clang_param(symbol, index, param, &record_layouts) {
                    Some(record) => parameter_abi_records.push(record),
                    None => unsupported_params.push(format!("{symbol}:{index}:{param}")),
                }
            }
        }
    }

    let mut record_layout_values = record_layouts
        .iter()
        .map(|(type_identity, (size, alignment))| {
            serde_json::json!({
                "typeIdentity": type_identity,
                "size": size,
                "alignment": alignment,
                "layoutSource": "clang_record_layout"
            })
        })
        .collect::<Vec<_>>();
    record_layout_values.sort_by(|a, b| {
        a.get("typeIdentity")
            .and_then(serde_json::Value::as_str)
            .cmp(&b.get("typeIdentity").and_then(serde_json::Value::as_str))
    });
    kernel_signatures.sort();
    kernel_signatures.dedup();
    let globals_unverified = has_device_constant_or_global_decl(source);
    let layout_size_alignment_verified = !kernel_signatures.is_empty()
        && missing_symbols.is_empty()
        && unsupported_params.is_empty()
        && !globals_unverified;
    let degraded_reason = if layout_size_alignment_verified {
        None
    } else if !missing_symbols.is_empty() {
        Some("clang_ast_missing_target_kernel_symbols".to_string())
    } else if !unsupported_params.is_empty() {
        Some("clang_ast_parameter_layout_requires_record_extractor".to_string())
    } else if globals_unverified {
        Some("device_constant_or_global_layout_unverified".to_string())
    } else {
        Some("clang_ast_abi_extractor_unverified".to_string())
    };

    let mut provenance = serde_json::json!({
        "extractorName": "synthi_clang_ast_kernel_abi_extractor",
        "extractorKind": "clang_ast",
        "extractorVersion": "v1",
        "evidenceId": evidence_id,
        "command": extractor_command,
        "inputHash": format!("sha256:{}", sha256_hex_str(source)),
        "acceptedByRuntimeCorrectnessPlan": layout_size_alignment_verified,
        "evidenceScope": [
            "kernel_parameter_type_identities",
            "kernel_parameter_size_alignment",
            "device_constant_global_absence"
        ],
        "kernelSignatures": kernel_signatures,
        "parameterAbiRecords": parameter_abi_records,
        "recordLayouts": record_layout_values,
    });
    if let Some(reason) = degraded_reason.as_deref() {
        provenance["rejectedReason"] = serde_json::Value::String(reason.to_string());
    }
    let kernel_signatures_out = provenance["kernelSignatures"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect();
    let parameter_abi_records_out = provenance["parameterAbiRecords"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    ClangAstAbiExtraction {
        layout_size_alignment_verified,
        accepted_extractor_evidence_refs: if layout_size_alignment_verified {
            vec![provenance["evidenceId"]
                .as_str()
                .unwrap_or_default()
                .to_string()]
        } else {
            Vec::new()
        },
        accepted_extractor_sources: if layout_size_alignment_verified {
            vec!["clang_ast".to_string()]
        } else {
            Vec::new()
        },
        extractor_provenance: vec![provenance],
        kernel_signatures: kernel_signatures_out,
        parameter_abi_records: parameter_abi_records_out,
        degraded_reason,
    }
}

fn clang_ast_abi_extractor_compiler_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    for env_key in ["SYNTHI_GPU_HMR_ABI_EXTRACTOR_COMPILER", "CXX"] {
        if let Ok(value) = std::env::var(env_key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() && !candidates.iter().any(|candidate| candidate == trimmed) {
                candidates.push(trimmed.to_string());
            }
        }
    }
    if !candidates.iter().any(|candidate| candidate == "clang++") {
        candidates.push("clang++".to_string());
    }
    candidates
}

fn clang_ast_language_candidates(source: &str) -> Vec<&'static str> {
    let mut candidates = Vec::new();
    if source.contains("__global__") || source.contains("__device__") {
        candidates.push("hip");
        candidates.push("cuda");
    }
    candidates.push("c++");
    candidates
}

fn clang_ast_include_dir_args(
    workspace: &Path,
    metadata: &DeviceCompileProofMetadata,
) -> Vec<String> {
    let mut dirs = BTreeSet::new();
    dirs.insert(workspace.to_string_lossy().replace('\\', "/"));
    if let Some(source_filename) = metadata.source_filename.as_deref() {
        let source_path = workspace.join(source_filename);
        if let Some(parent) = source_path.parent() {
            dirs.insert(parent.to_string_lossy().replace('\\', "/"));
        }
    }
    dirs.into_iter()
        .flat_map(|dir| ["-I".to_string(), dir])
        .collect()
}

fn clang_ast_passthrough_separate_flag(flag: &str) -> bool {
    matches!(
        flag,
        "-I"
            | "-isystem"
            | "-iquote"
            | "-idirafter"
            | "-include"
            | "--include"
            | "--include-directory"
            | "--system-include"
            | "-D"
            | "-U"
            | "-std"
            | "--std"
            | "--target"
            | "-target"
            | "--sysroot"
            | "-isysroot"
            | "--gcc-toolchain"
            | "--cuda-path"
            | "--rocm-path"
            | "--hip-path"
    )
}

fn clang_ast_passthrough_joined_flag(flag: &str) -> bool {
    [
        "-I",
        "-isystem",
        "-iquote",
        "-idirafter",
        "-D",
        "-U",
        "-std=",
        "--std=",
        "--include=",
        "--include-directory=",
        "--system-include=",
        "--target=",
        "-target=",
        "--sysroot=",
        "-isysroot=",
        "--gcc-toolchain=",
        "--cuda-path=",
        "--rocm-path=",
        "--hip-path=",
    ]
    .iter()
    .any(|prefix| flag.starts_with(prefix))
}

fn clang_ast_compile_context_args(metadata: &DeviceCompileProofMetadata) -> Vec<String> {
    let mut args = Vec::new();
    let mut iter = metadata.effective_device_flags.iter().peekable();
    while let Some(flag) = iter.next() {
        if clang_ast_passthrough_separate_flag(flag) {
            args.push(flag.clone());
            if let Some(value) = iter.next() {
                args.push(value.clone());
            }
        } else if clang_ast_passthrough_joined_flag(flag) {
            args.push(flag.clone());
        }
    }
    args
}

fn clang_ast_gpu_language_args(
    language: &str,
    metadata: &DeviceCompileProofMetadata,
) -> Vec<String> {
    match language {
        "hip" => {
            let has_arch = metadata
                .effective_device_flags
                .iter()
                .any(|flag| flag.starts_with("--offload-arch"));
            if has_arch {
                Vec::new()
            } else {
                metadata
                    .gpu_arch
                    .iter()
                    .filter(|arch| !arch.trim().is_empty())
                    .map(|arch| format!("--offload-arch={arch}"))
                    .collect()
            }
        }
        "cuda" => {
            let mut args = vec!["-nocudainc".to_string(), "-nocudalib".to_string()];
            let has_arch = metadata
                .effective_device_flags
                .iter()
                .any(|flag| flag.starts_with("--cuda-gpu-arch") || flag.starts_with("-arch="));
            if !has_arch {
                args.extend(
                    metadata
                        .gpu_arch
                        .iter()
                        .filter(|arch| !arch.trim().is_empty())
                        .map(|arch| format!("--cuda-gpu-arch={arch}")),
                );
            }
            args
        }
        "c++" => vec![
            "-D__global__=".to_string(),
            "-D__device__=".to_string(),
            "-D__host__=".to_string(),
            "-D__shared__=".to_string(),
            "-D__constant__=".to_string(),
            "-D__managed__=".to_string(),
            "-D__launch_bounds__(...)=".to_string(),
        ],
        _ => Vec::new(),
    }
}

fn clang_ast_abi_extractor_args(
    workspace: &Path,
    metadata: &DeviceCompileProofMetadata,
    language: &str,
    input_path: &Path,
) -> Vec<String> {
    let mut args = vec!["-x".to_string(), language.to_string(), "-fsyntax-only".to_string()];
    args.extend(clang_ast_include_dir_args(workspace, metadata));
    args.extend(clang_ast_compile_context_args(metadata));
    args.extend(clang_ast_gpu_language_args(language, metadata));
    args.extend([
        "-Xclang".to_string(),
        "-ast-dump".to_string(),
        "-Xclang".to_string(),
        "-fdump-record-layouts".to_string(),
        input_path.to_string_lossy().to_string(),
    ]);
    args
}

fn clang_ast_command_display(compiler: &str, args: &[String], input_path: &Path) -> String {
    let input = input_path.to_string_lossy().replace('\\', "/");
    let displayed_args = args
        .iter()
        .map(|arg| {
            if arg.replace('\\', "/") == input {
                "<input>".to_string()
            } else if arg.chars().any(char::is_whitespace) {
                format!("{arg:?}")
            } else {
                arg.clone()
            }
        })
        .collect::<Vec<_>>();
    format!("{compiler} {}", displayed_args.join(" "))
}

async fn clang_ast_abi_extraction(
    workspace: &Path,
    outcome: &DeviceCompileOutcome,
) -> Option<ClangAstAbiExtraction> {
    let source_hash = sha256_hex_str(&outcome.compiled_source);
    let compiler = match clang_ast_abi_extractor_compiler_candidates()
        .into_iter()
        .find(|candidate| {
            std::process::Command::new(candidate)
                .arg("--version")
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false)
        }) {
        Some(compiler) => compiler,
        None => {
            return Some(clang_ast_abi_extraction_failure(
                &outcome.compiled_source,
                "synthi_clang_ast_kernel_abi_extractor",
                "clang_ast_extractor_compiler_unavailable",
                Vec::new(),
            ));
        }
    };
    let abi_dir = workspace.join(".synthi").join("gpu-hmr").join("abi");
    if tokio::fs::create_dir_all(&abi_dir).await.is_err() {
        return Some(clang_ast_abi_extraction_failure(
            &outcome.compiled_source,
            "synthi_clang_ast_kernel_abi_extractor",
            "clang_ast_extractor_workspace_unavailable",
            Vec::new(),
        ));
    }
    let input_path = abi_dir.join(format!("clang-abi-input_{source_hash}.hip"));
    if tokio::fs::write(&input_path, outcome.compiled_source.as_bytes())
        .await
        .is_err()
    {
        return Some(clang_ast_abi_extraction_failure(
            &outcome.compiled_source,
            "synthi_clang_ast_kernel_abi_extractor",
            "clang_ast_extractor_input_write_failed",
            Vec::new(),
        ));
    }
    let mut successful_dump = None;
    let mut attempts = Vec::new();
    for language in clang_ast_language_candidates(&outcome.compiled_source) {
        let args = clang_ast_abi_extractor_args(
            workspace,
            &outcome.proof_metadata,
            language,
            &input_path,
        );
        let command_display = clang_ast_command_display(&compiler, &args, &input_path);
        let mut command = tokio::process::Command::new(&compiler);
        command.current_dir(workspace).args(&args);
        let output = match tokio::time::timeout(
            std::time::Duration::from_secs(20),
            command.output(),
        )
        .await
        {
            Ok(Ok(output)) if output.status.success() => output,
            Ok(Ok(output)) => {
                attempts.push(ClangAstAbiAttempt {
                    language: language.to_string(),
                    command: command_display,
                    status: output
                        .status
                        .code()
                        .map(|code| format!("exit:{code}"))
                        .unwrap_or_else(|| "terminated".to_string()),
                    stderr_summary: abi_extractor_text_summary(&String::from_utf8_lossy(
                        &output.stderr,
                    )),
                });
                continue;
            }
            Ok(Err(err)) => {
                attempts.push(ClangAstAbiAttempt {
                    language: language.to_string(),
                    command: command_display,
                    status: "spawn_error".to_string(),
                    stderr_summary: err.to_string(),
                });
                continue;
            }
            Err(_) => {
                attempts.push(ClangAstAbiAttempt {
                    language: language.to_string(),
                    command: command_display,
                    status: "timeout".to_string(),
                    stderr_summary: "clang AST dump timed out".to_string(),
                });
                continue;
            }
        };
        successful_dump = Some((language.to_string(), command_display, output));
        break;
    }
    let Some((language, command_display, output)) = successful_dump else {
        return Some(clang_ast_abi_extraction_failure(
            &outcome.compiled_source,
            "synthi_clang_ast_kernel_abi_extractor",
            "clang_ast_dump_failed",
            attempts,
        ));
    };
    let ast_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let evidence_material = serde_json::json!({
        "compiler": compiler,
        "language": language,
        "command": command_display,
        "inputHash": format!("sha256:{source_hash}"),
        "astHash": format!("sha256:{}", sha256_hex_str(&ast_text)),
    });
    let evidence_id = format!(
        "evidence:abi-extractor:{}",
        sha256_hex_str(&evidence_material.to_string())
    );
    Some(clang_ast_abi_extraction_from_dump(
        &outcome.compiled_source,
        &ast_text,
        &outcome.target_symbols,
        &command_display,
        evidence_id,
    ))
}

fn device_filename_for_vendor(vendor: DeviceVendor) -> &'static str {
    match vendor {
        DeviceVendor::Cuda => "device.cu",
        DeviceVendor::Rocm => "device.hip",
    }
}

#[derive(Debug, Clone)]
struct DeviceCompileSources {
    full_source: String,
    full_filename: Option<String>,
    full_symbols: Vec<String>,
    direct_workspace_source: bool,
    partial_source: Option<String>,
    partial_filename: Option<String>,
    partial_symbols: Vec<String>,
    partial_source_paths: Vec<String>,
    partial_required: bool,
    partial_artifact_kind: Option<String>,
    partial_fallback_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct DevicePartialCompileSource {
    source: String,
    filename: String,
    symbols: Vec<String>,
    source_paths: Vec<String>,
    required: bool,
    artifact_kind: Option<String>,
    fallback_reason: Option<String>,
}

async fn compile_stage_or_invalidate_split_cache<T>(
    req: &CompileRequest,
    result: Result<T>,
    reason: &str,
) -> Result<T> {
    match result {
        Ok(value) => Ok(value),
        Err(err) => {
            invalidate_ai_split_cache(req, reason).await;
            Err(err)
        }
    }
}

#[derive(Debug, Clone)]
struct DevicePartialArtifactSpec {
    filename: String,
    content: String,
    kind: &'static str,
    generated_path: String,
    source_paths: Vec<String>,
    symbols: Vec<String>,
    omitted_source_includes: Vec<String>,
    mapping_confidence: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct DeviceIncludeGraphIndex {
    edges: BTreeMap<String, BTreeSet<String>>,
    known_paths: BTreeSet<String>,
    mapped_source_paths: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DevicePartialArtifactSelection {
    filename: String,
    kind: String,
    generated_path: String,
    symbols: Vec<String>,
    source_paths: Vec<String>,
    content_hash: Option<String>,
    content_bytes: Option<usize>,
    full_bytes: Option<usize>,
    source_path_match: bool,
    selection_reason: String,
    rejection_reason: Option<String>,
    mapping_confidence: Option<String>,
    verifier_evidence_id: Option<String>,
    dependency_hash: Option<String>,
    compile_command_hash: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct DevicePartialArtifactSelectionReport {
    selected: Option<DevicePartialArtifactSelection>,
    rejection_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct DeviceSymbolMapping {
    source_path: String,
    generated_path: String,
    mapping_confidence: Option<String>,
    identity: DeviceSymbolIdentityKey,
}

#[derive(Debug, Clone, Default, Eq, PartialEq, Ord, PartialOrd)]
struct DeviceSymbolIdentityKey {
    qualified_source_name: Option<String>,
    signature_hash: Option<String>,
    linkage: Option<String>,
    namespace_path: Option<String>,
    template_arity: Option<String>,
    overload_index: Option<String>,
    source_span: Option<String>,
    source_span_hash: Option<String>,
    mangled_names: Option<String>,
    demangled_names: Option<String>,
    exported_names: Option<String>,
}

impl DeviceSymbolIdentityKey {
    fn has_evidence(&self) -> bool {
        self.qualified_source_name.is_some()
            || self.signature_hash.is_some()
            || self.linkage.is_some()
            || self.namespace_path.is_some()
            || self.template_arity.is_some()
            || self.overload_index.is_some()
            || self.source_span.is_some()
            || self.source_span_hash.is_some()
            || self.mangled_names.is_some()
            || self.demangled_names.is_some()
            || self.exported_names.is_some()
    }
}

#[derive(Debug, Clone)]
struct AiDeltaDeviceScope {
    source: String,
    filename: String,
    symbols: Vec<String>,
    artifact_kind: String,
    source_paths: Vec<String>,
    selection_reason: String,
    mapping_confidence: Option<String>,
    dependency_hash: Option<String>,
    compile_command_hash: Option<String>,
    verifier_evidence_id: Option<String>,
}

fn partial_device_filename(generated_path: &str, symbols: &[String], source: &str) -> String {
    let normalized = generated_path.replace('\\', "/");
    let (dir, file) = normalized
        .rsplit_once('/')
        .map(|(dir, file)| (dir.to_string(), file.to_string()))
        .unwrap_or_else(|| (String::new(), normalized));
    let (stem, ext) = file
        .rsplit_once('.')
        .map(|(stem, ext)| (stem.to_string(), format!(".{ext}")))
        .unwrap_or((file, String::new()));
    let hash = hash_content(&format!("{}:{source}", symbols.join(",")));
    let filename = format!("{stem}.partial.{hash:016x}{ext}");
    if dir.is_empty() {
        filename
    } else {
        format!("{dir}/{filename}")
    }
}

fn build_source_include_partial_source(source_paths: &[String]) -> Option<String> {
    let mut normalized = BTreeSet::new();
    for path in source_paths {
        let path = normalized_request_filename(path)?;
        if path.contains('"') || path.contains('\n') || path.contains('\r') {
            return None;
        }
        normalized.insert(path);
    }
    if normalized.is_empty() || normalized.len() > MAX_WARM_SOURCE_BRIDGE_TUS {
        return None;
    }

    let mut source = String::from("// synthi-gpu-hmr: source include partial\n");
    for path in normalized {
        source.push_str("#include \"");
        source.push_str(&path);
        source.push_str("\"\n");
    }
    Some(source)
}

fn add_json_string_array_paths(value: &serde_json::Value, key: &str, paths: &mut BTreeSet<String>) {
    if let Some(items) = value.get(key).and_then(serde_json::Value::as_array) {
        for item in items {
            if let Some(path) = item
                .as_str()
                .map(normalize_generated_include_path)
                .filter(|path| !path.is_empty())
            {
                paths.insert(path);
            }
        }
    }
}

fn add_device_include_graph(index: &mut DeviceIncludeGraphIndex, graph: &serde_json::Value) {
    add_json_string_array_paths(graph, "deviceTranslationUnits", &mut index.known_paths);
    add_json_string_array_paths(graph, "generatedDeviceIncludes", &mut index.known_paths);
    add_json_string_array_paths(graph, "reachableHeaders", &mut index.known_paths);

    let Some(edges) = graph.get("edges").and_then(serde_json::Value::as_array) else {
        return;
    };
    for edge in edges {
        let Some(source) = edge
            .get("source")
            .and_then(serde_json::Value::as_str)
            .map(normalize_generated_include_path)
            .filter(|path| !path.is_empty())
        else {
            continue;
        };
        index.known_paths.insert(source.clone());
        let entry = index.edges.entry(source).or_default();
        if let Some(includes) = edge.get("includes").and_then(serde_json::Value::as_array) {
            for include in includes {
                if let Some(path) = include
                    .as_str()
                    .map(normalize_generated_include_path)
                    .filter(|path| !path.is_empty())
                {
                    index.known_paths.insert(path.clone());
                    entry.insert(path);
                }
            }
        }
    }
}

fn device_include_graph_index(sidecar: &serde_json::Value) -> DeviceIncludeGraphIndex {
    let mut index = DeviceIncludeGraphIndex::default();
    for pointer in ["/deviceMappings", "/deviceMappingReport/deviceMappings"] {
        let Some(items) = sidecar
            .pointer(pointer)
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        for item in items {
            if let Some(path) = item
                .get("sourcePath")
                .and_then(serde_json::Value::as_str)
                .map(normalize_generated_include_path)
                .filter(|path| !path.is_empty())
            {
                index.known_paths.insert(path.clone());
                index.mapped_source_paths.insert(path);
            }
            if let Some(path) = item
                .get("generatedPath")
                .and_then(serde_json::Value::as_str)
                .map(normalize_generated_include_path)
                .filter(|path| !path.is_empty())
            {
                index.known_paths.insert(path);
            }
        }
    }
    for pointer in [
        "/deviceMappingReport/deviceIncludeGraph",
        "/affectedHeaderGraph",
    ] {
        if let Some(graph) = sidecar.pointer(pointer) {
            add_device_include_graph(&mut index, graph);
        }
    }
    index
}

fn include_resolution_candidates(base_path: &str, include_path: &str) -> Vec<String> {
    let include = normalize_generated_include_path(include_path);
    if include.is_empty() {
        return Vec::new();
    }
    let mut candidates = vec![include.clone()];
    let base_dir = role_dir(base_path);
    if !base_dir.is_empty() {
        let resolved = normalize_generated_include_path(&format!("{base_dir}/{include}"));
        if !resolved.is_empty() && !candidates.contains(&resolved) {
            candidates.push(resolved);
        }
    }
    candidates
}

fn resolve_include_path(
    base_path: &str,
    include_path: &str,
    known_paths: &BTreeSet<String>,
) -> String {
    let candidates = include_resolution_candidates(base_path, include_path);
    for candidate in &candidates {
        if known_paths.contains(candidate) {
            return candidate.clone();
        }
    }
    candidates.into_iter().next().unwrap_or_default()
}

fn include_reaches_any(
    source_path: &str,
    targets: &BTreeSet<String>,
    index: &DeviceIncludeGraphIndex,
) -> bool {
    let source = normalize_generated_include_path(source_path);
    if targets.contains(&source) {
        return true;
    }
    let mut stack = vec![source];
    let mut seen = BTreeSet::new();
    while let Some(path) = stack.pop() {
        if !seen.insert(path.clone()) {
            continue;
        }
        if targets.contains(&path) {
            return true;
        }
        if let Some(next) = index.edges.get(&path) {
            for item in next {
                stack.push(item.clone());
            }
        }
    }
    false
}

fn source_bridge_line_is_safe_trivia(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.is_empty()
        || trimmed.starts_with("//")
        || trimmed.starts_with("/*")
        || trimmed.starts_with('*')
        || trimmed.starts_with("*/")
        || trimmed.starts_with('#')
}

fn inline_source_bridge_support_include(
    workspace: &Path,
    include_path: &str,
    target_paths: &BTreeSet<String>,
    omit_paths: &BTreeSet<String>,
    index: &DeviceIncludeGraphIndex,
    depth: usize,
    inlined_bytes: &mut usize,
) -> Option<String> {
    if depth > MAX_SOURCE_BRIDGE_SUPPORT_INLINE_DEPTH {
        return None;
    }
    let normalized = normalize_generated_include_path(include_path);
    if normalized.is_empty() || index.mapped_source_paths.contains(&normalized) {
        return None;
    }
    let rel = compile_request_relpath(&normalized).ok()?;
    let source = std::fs::read_to_string(workspace.join(rel)).ok()?;
    *inlined_bytes = inlined_bytes.saturating_add(source.len());
    if *inlined_bytes > MAX_SOURCE_BRIDGE_SUPPORT_INLINE_BYTES {
        return None;
    }

    let mut partial = String::new();
    for line in source.split_inclusive('\n') {
        if let Some(included) = quoted_include_from_line(line) {
            let resolved = resolve_include_path(&normalized, &included, &index.known_paths);
            if target_paths.contains(&resolved) || omit_paths.contains(&resolved) {
                partial.push_str(
                    "// synthi-gpu-hmr: omitted mapped source include from support prelude\n",
                );
                continue;
            }
            if include_reaches_any(&resolved, omit_paths, index) {
                if let Some(inlined) = inline_source_bridge_support_include(
                    workspace,
                    &resolved,
                    target_paths,
                    omit_paths,
                    index,
                    depth + 1,
                    inlined_bytes,
                ) {
                    partial.push_str("// synthi-gpu-hmr: inlined source bridge support include: ");
                    partial.push_str(&resolved);
                    partial.push('\n');
                    partial.push_str(&inlined);
                    if !inlined.ends_with('\n') {
                        partial.push('\n');
                    }
                } else {
                    partial.push_str(
                        "// synthi-gpu-hmr: omitted source bridge support include from partial artifact\n",
                    );
                }
                continue;
            }
        }
        partial.push_str(line);
    }
    Some(partial)
}

fn build_contextual_source_include_partial_source(
    workspace: Option<&Path>,
    sidecar: &serde_json::Value,
    generated_path: &str,
    full_source: &str,
    target_source_paths: &[String],
    omit_source_paths: &[String],
) -> Option<String> {
    let target_paths = target_source_paths
        .iter()
        .map(|path| normalize_generated_include_path(path))
        .filter(|path| !path.is_empty())
        .collect::<BTreeSet<_>>();
    if target_paths.is_empty() || target_paths.len() > MAX_WARM_SOURCE_BRIDGE_TUS {
        return None;
    }
    let omit_paths = omit_source_paths
        .iter()
        .map(|path| normalize_generated_include_path(path))
        .filter(|path| !path.is_empty() && !target_paths.contains(path))
        .collect::<BTreeSet<_>>();
    let index = device_include_graph_index(sidecar);
    let generated = normalize_generated_include_path(generated_path);

    let mut partial = String::from("// synthi-gpu-hmr: source include partial\n");
    let mut kept_target = false;
    let mut saw_source_include = false;
    let mut saw_body_after_source_includes = false;
    let mut wrote_nontrivia = false;
    let mut inlined_bytes = 0usize;

    for line in full_source.split_inclusive('\n') {
        if !wrote_nontrivia && line.trim().is_empty() {
            continue;
        }
        if let Some(included) = quoted_include_from_line(line) {
            let resolved = resolve_include_path(&generated, &included, &index.known_paths);
            if target_paths.contains(&resolved) {
                kept_target = true;
                saw_source_include = true;
                partial.push_str(line);
                wrote_nontrivia = true;
                continue;
            }
            if omit_paths.contains(&resolved) {
                saw_source_include = true;
                partial
                    .push_str("// synthi-gpu-hmr: omitted source include from partial artifact\n");
                wrote_nontrivia = true;
                continue;
            }
            if include_reaches_any(&resolved, &omit_paths, &index) {
                if let Some(workspace) = workspace {
                    if let Some(inlined) = inline_source_bridge_support_include(
                        workspace,
                        &resolved,
                        &target_paths,
                        &omit_paths,
                        &index,
                        0,
                        &mut inlined_bytes,
                    ) {
                        partial
                            .push_str("// synthi-gpu-hmr: inlined source bridge support include: ");
                        partial.push_str(&resolved);
                        partial.push('\n');
                        partial.push_str(&inlined);
                        if !inlined.ends_with('\n') {
                            partial.push('\n');
                        }
                    } else {
                        partial.push_str(
                            "// synthi-gpu-hmr: omitted source bridge support include from partial artifact\n",
                        );
                    }
                } else {
                    partial.push_str(
                        "// synthi-gpu-hmr: omitted source bridge support include from partial artifact\n",
                    );
                }
                wrote_nontrivia = true;
                continue;
            }
        } else if saw_source_include && !source_bridge_line_is_safe_trivia(line) {
            saw_body_after_source_includes = true;
            break;
        }
        partial.push_str(line);
        wrote_nontrivia = wrote_nontrivia || !line.trim().is_empty();
    }

    if !kept_target {
        if saw_body_after_source_includes {
            return None;
        }
        if let Some(source) = build_source_include_partial_source(target_source_paths) {
            partial.push_str(&source);
            kept_target = true;
        }
    }
    kept_target.then_some(partial)
}

fn normalized_symbol_set(symbols: &[String]) -> BTreeSet<String> {
    symbols
        .iter()
        .map(|symbol| symbol.trim())
        .filter(|symbol| !symbol.is_empty())
        .map(str::to_string)
        .collect()
}

fn string_array_field(item: &serde_json::Value, key: &str) -> Vec<String> {
    item.get(key)
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn string_field(item: &serde_json::Value, key: &str) -> Option<String> {
    item.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn scalar_identity_field(item: &serde_json::Value, key: &str) -> Option<String> {
    let value = item.get(key)?;
    if let Some(text) = value.as_str() {
        return Some(text.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }
    if value.is_null() {
        return None;
    }
    if value.is_number() || value.is_boolean() || value.is_array() || value.is_object() {
        return Some(value.to_string())
            .filter(|value| !value.is_empty())
            .map(|value| value.trim_matches('"').to_string());
    }
    None
}

fn identity_list_field(item: &serde_json::Value, key: &str) -> Option<String> {
    let value = item.get(key)?;
    if let Some(items) = value.as_array() {
        let values = items
            .iter()
            .filter_map(|item| {
                if let Some(text) = item.as_str() {
                    Some(text.trim().to_string())
                } else if item.is_null() {
                    None
                } else {
                    Some(item.to_string())
                }
            })
            .filter(|value| !value.is_empty())
            .collect::<BTreeSet<_>>();
        if values.is_empty() {
            None
        } else {
            Some(values.into_iter().collect::<Vec<_>>().join("\n"))
        }
    } else {
        scalar_identity_field(item, key)
    }
}

fn device_symbol_identity_key(item: &serde_json::Value) -> DeviceSymbolIdentityKey {
    DeviceSymbolIdentityKey {
        qualified_source_name: scalar_identity_field(item, "qualifiedSourceName")
            .or_else(|| scalar_identity_field(item, "qualifiedName")),
        signature_hash: scalar_identity_field(item, "signatureHash"),
        linkage: scalar_identity_field(item, "linkage"),
        namespace_path: scalar_identity_field(item, "namespacePath"),
        template_arity: scalar_identity_field(item, "templateArity"),
        overload_index: scalar_identity_field(item, "overloadIndex"),
        source_span: scalar_identity_field(item, "sourceSpan"),
        source_span_hash: scalar_identity_field(item, "sourceSpanHash"),
        mangled_names: identity_list_field(item, "mangledNames"),
        demangled_names: identity_list_field(item, "demangledNames"),
        exported_names: identity_list_field(item, "exportedNames"),
    }
}

fn device_symbol_mapping_index(
    sidecar: &serde_json::Value,
) -> BTreeMap<String, Vec<DeviceSymbolMapping>> {
    let mut index: BTreeMap<String, Vec<DeviceSymbolMapping>> = BTreeMap::new();
    for pointer in ["/deviceMappings", "/deviceMappingReport/deviceMappings"] {
        let Some(items) = sidecar
            .pointer(pointer)
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        for item in items {
            let Some(symbol) = item
                .get("symbol")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let Some(source_path) = item
                .get("sourcePath")
                .and_then(serde_json::Value::as_str)
                .and_then(normalized_request_filename)
            else {
                continue;
            };
            let Some(generated_path) = item
                .get("generatedPath")
                .and_then(serde_json::Value::as_str)
                .and_then(normalized_request_filename)
            else {
                continue;
            };
            index
                .entry(symbol.to_string())
                .or_default()
                .push(DeviceSymbolMapping {
                    source_path,
                    generated_path,
                    mapping_confidence: string_field(item, "mappingConfidence"),
                    identity: device_symbol_identity_key(item),
                });
        }
    }
    index
}

fn device_mapping_symbols_for_generated(
    sidecar: &serde_json::Value,
    generated_path: &str,
) -> Vec<String> {
    let requested_generated = normalized_request_filename(generated_path);
    let mut exact_symbols = BTreeSet::new();
    let mut symbols_by_generated: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for pointer in ["/deviceMappings", "/deviceMappingReport/deviceMappings"] {
        let Some(items) = sidecar
            .pointer(pointer)
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        for item in items {
            let Some(symbol) = item
                .get("symbol")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let Some(mapping_generated) = item
                .get("generatedPath")
                .and_then(serde_json::Value::as_str)
                .and_then(normalized_request_filename)
            else {
                continue;
            };
            if requested_generated.as_deref() == Some(mapping_generated.as_str()) {
                exact_symbols.insert(symbol.to_string());
            }
            symbols_by_generated
                .entry(mapping_generated)
                .or_default()
                .insert(symbol.to_string());
        }
    }

    if !exact_symbols.is_empty() {
        return exact_symbols.into_iter().collect();
    }
    if symbols_by_generated.len() == 1 {
        return symbols_by_generated
            .into_values()
            .next()
            .unwrap_or_default()
            .into_iter()
            .collect();
    }
    Vec::new()
}

fn mapping_confidence_for_symbols(
    symbol_index: &BTreeMap<String, Vec<DeviceSymbolMapping>>,
    symbols: &BTreeSet<String>,
    generated_path: &str,
    source_paths: &[String],
) -> Option<String> {
    let source_set = source_paths.iter().cloned().collect::<BTreeSet<_>>();
    let mut confidences = BTreeSet::new();
    for symbol in symbols {
        let Some(mappings) = symbol_index.get(symbol) else {
            continue;
        };
        for mapping in mappings {
            if mapping.generated_path == generated_path
                && (source_set.is_empty() || source_set.contains(&mapping.source_path))
            {
                if let Some(confidence) = mapping.mapping_confidence.as_deref() {
                    confidences.insert(confidence.to_string());
                }
            }
        }
    }
    match confidences.len() {
        0 => None,
        1 => confidences.into_iter().next(),
        _ => Some("mixed".to_string()),
    }
}

fn symbol_maps_to_scope(
    symbol_index: &BTreeMap<String, Vec<DeviceSymbolMapping>>,
    symbol: &str,
    generated_path: &str,
    source_path: Option<&str>,
) -> bool {
    let Some(mappings) = symbol_index.get(symbol) else {
        return false;
    };
    mappings.iter().any(|mapping| {
        mapping.generated_path == generated_path
            && source_path
                .map(|path| mapping.source_path == path)
                .unwrap_or(true)
    })
}

fn symbol_identity_uncertain_for_scope(
    symbol_index: &BTreeMap<String, Vec<DeviceSymbolMapping>>,
    symbol: &str,
    generated_path: &str,
    source_path: Option<&str>,
) -> bool {
    let Some(mappings) = symbol_index.get(symbol) else {
        return false;
    };
    let identity_keys = mappings
        .iter()
        .filter(|mapping| {
            mapping.generated_path == generated_path
                && source_path
                    .map(|path| mapping.source_path == path)
                    .unwrap_or(true)
                && mapping.identity.has_evidence()
        })
        .map(|mapping| mapping.identity.clone())
        .collect::<BTreeSet<_>>();
    identity_keys.len() > 1
}

fn any_symbol_identity_uncertain_for_scope(
    symbol_index: &BTreeMap<String, Vec<DeviceSymbolMapping>>,
    symbols: &BTreeSet<String>,
    generated_path: &str,
    source_path: Option<&str>,
) -> bool {
    symbols.iter().any(|symbol| {
        symbol_identity_uncertain_for_scope(symbol_index, symbol, generated_path, source_path)
    })
}

fn artifact_symbol_superset_is_safe(
    symbol_index: &BTreeMap<String, Vec<DeviceSymbolMapping>>,
    artifact_symbols: &BTreeSet<String>,
    requested_symbols: &BTreeSet<String>,
    generated_path: &str,
    request_path: Option<&str>,
) -> bool {
    if !artifact_symbols.is_superset(requested_symbols) {
        return false;
    }
    for symbol in artifact_symbols {
        if !symbol_maps_to_scope(symbol_index, symbol, generated_path, request_path) {
            return false;
        }
    }
    true
}

fn sidecar_any_bool(sidecar: &serde_json::Value, pointers: &[&str]) -> bool {
    pointers.iter().any(|pointer| {
        sidecar
            .pointer(pointer)
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    })
}

fn select_device_partial_artifact_with_report(
    sidecar: &serde_json::Value,
    generated_path: &str,
    request_path: Option<&str>,
    symbols: &[String],
) -> DevicePartialArtifactSelectionReport {
    let Some(generated) = normalized_request_filename(generated_path) else {
        return DevicePartialArtifactSelectionReport {
            selected: None,
            rejection_reason: Some("selection.path_identity_uncertain".to_string()),
        };
    };
    let requested_symbols = normalized_symbol_set(symbols);
    if requested_symbols.is_empty() {
        return DevicePartialArtifactSelectionReport {
            selected: None,
            rejection_reason: Some("selection.empty_edited_symbols".to_string()),
        };
    }
    let request = match request_path {
        Some(path) => match normalized_request_filename(path).filter(|path| !path.is_empty()) {
            Some(path) => Some(path),
            None => {
                return DevicePartialArtifactSelectionReport {
                    selected: None,
                    rejection_reason: Some("selection.path_identity_uncertain".to_string()),
                };
            }
        },
        None => None,
    };
    if sidecar_any_bool(
        sidecar,
        &[
            "/lastDeviceFastPathVerifierReport/includeGraphRootChanged",
            "/lastDeviceFastPathVerifierReport/includeRootChanged",
            "/lastWarmRebuildVerifierReport/includeGraphRootChanged",
            "/lastWarmRebuildVerifierReport/includeRootChanged",
        ],
    ) {
        return DevicePartialArtifactSelectionReport {
            selected: None,
            rejection_reason: Some("selection.include_root_changed".to_string()),
        };
    }
    if sidecar_any_bool(
        sidecar,
        &[
            "/lastDeviceFastPathVerifierReport/macroControlledAbiUncertain",
            "/lastDeviceFastPathVerifierReport/macroControlledSignatureOrLayoutUncertain",
            "/lastWarmRebuildVerifierReport/macroControlledAbiUncertain",
            "/lastWarmRebuildVerifierReport/macroControlledSignatureOrLayoutUncertain",
        ],
    ) {
        return DevicePartialArtifactSelectionReport {
            selected: None,
            rejection_reason: Some("selection.macro_controlled_abi_uncertain".to_string()),
        };
    }
    let symbol_index = device_symbol_mapping_index(sidecar);
    for symbol in &requested_symbols {
        if !symbol_maps_to_scope(&symbol_index, symbol, &generated, request.as_deref()) {
            return DevicePartialArtifactSelectionReport {
                selected: None,
                rejection_reason: Some("selection.unknown_symbol".to_string()),
            };
        }
    }
    if any_symbol_identity_uncertain_for_scope(
        &symbol_index,
        &requested_symbols,
        &generated,
        request.as_deref(),
    ) {
        return DevicePartialArtifactSelectionReport {
            selected: None,
            rejection_reason: Some("selection.symbol_identity_uncertain".to_string()),
        };
    }

    let mut candidates = Vec::new();
    let mut rejection_reason: Option<String> = None;
    let mut remember_rejection = |reason: &str| {
        if rejection_reason.is_none() {
            rejection_reason = Some(reason.to_string());
        }
    };
    for report_key in ["devicePartialArtifacts", "generatedDevicePartials"] {
        let Some(artifacts) = sidecar
            .get(report_key)
            .and_then(|report| report.get("artifacts"))
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        for item in artifacts {
            let Some(filename) = item
                .get("filename")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            if normalized_request_filename(filename).is_none() {
                remember_rejection("selection.path_identity_uncertain");
                continue;
            }
            let Some(artifact_generated) = item
                .get("generatedPath")
                .and_then(serde_json::Value::as_str)
                .and_then(normalized_request_filename)
            else {
                remember_rejection("selection.path_identity_uncertain");
                continue;
            };
            if artifact_generated != generated {
                remember_rejection("selection.generated_path_mismatch");
                continue;
            }

            let artifact_symbols = string_array_field(item, "symbols");
            let artifact_symbol_set = normalized_symbol_set(&artifact_symbols);
            let exact_symbol_set = artifact_symbol_set == requested_symbols;
            if any_symbol_identity_uncertain_for_scope(
                &symbol_index,
                &artifact_symbol_set,
                &generated,
                request.as_deref(),
            ) {
                remember_rejection("selection.symbol_identity_uncertain");
                continue;
            }

            let raw_source_paths = string_array_field(item, "sourcePaths");
            let mut source_paths = Vec::with_capacity(raw_source_paths.len());
            let mut source_path_identity_uncertain = false;
            for path in raw_source_paths {
                match normalized_request_filename(&path) {
                    Some(path) => source_paths.push(path),
                    None => source_path_identity_uncertain = true,
                }
            }
            if source_path_identity_uncertain {
                remember_rejection("selection.path_identity_uncertain");
                continue;
            }
            let source_path_match = request
                .as_deref()
                .map(|requested| source_paths.iter().any(|path| path == requested))
                .unwrap_or(false);
            if request.is_some() && !source_path_match {
                remember_rejection("selection.source_path_mismatch");
                continue;
            }

            let kind = item
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            if kind == "source_include_bridge" && request.is_some() {
                if source_paths.len() != 1 || !source_path_match {
                    remember_rejection("selection.source_path_mismatch");
                    continue;
                }
            }
            let multi_symbol_reload_supported = exact_symbol_set
                || kind == "source_include_bridge"
                || item
                    .get("multiSymbolReloadSupported")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
                || item
                    .get("runtimeMultiSymbolReloadSupported")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true);

            let safe_symbol_superset = artifact_symbol_superset_is_safe(
                &symbol_index,
                &artifact_symbol_set,
                &requested_symbols,
                &generated,
                request.as_deref(),
            );

            let selection_reason = if exact_symbol_set {
                "exact_symbol_set"
            } else if safe_symbol_superset && multi_symbol_reload_supported {
                "safe_symbol_superset"
            } else if safe_symbol_superset {
                remember_rejection("selection.runtime_multi_symbol_reload_unsupported");
                continue;
            } else if artifact_symbol_set.is_superset(&requested_symbols) {
                remember_rejection("selection.unsafe_symbol_superset");
                continue;
            } else {
                remember_rejection("selection.symbol_set_mismatch");
                continue;
            };
            let mapping_confidence = string_field(item, "mappingConfidence").or_else(|| {
                mapping_confidence_for_symbols(
                    &symbol_index,
                    &artifact_symbol_set,
                    &generated,
                    &source_paths,
                )
            });

            candidates.push(DevicePartialArtifactSelection {
                filename: filename.to_string(),
                kind,
                generated_path: artifact_generated,
                symbols: artifact_symbols,
                source_paths,
                content_hash: item
                    .get("contentHash")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                content_bytes: item
                    .get("contentBytes")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok()),
                full_bytes: item
                    .get("fullBytes")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok()),
                source_path_match,
                selection_reason: selection_reason.to_string(),
                rejection_reason: None,
                mapping_confidence,
                verifier_evidence_id: string_field(item, "verifierEvidenceId"),
                dependency_hash: string_field(item, "dependencyHash"),
                compile_command_hash: string_field(item, "compileCommandHash"),
            });
        }
    }

    candidates.sort_by(|a, b| {
        b.source_path_match
            .cmp(&a.source_path_match)
            .then(
                (a.selection_reason == "exact_symbol_set")
                    .cmp(&(b.selection_reason == "exact_symbol_set"))
                    .reverse(),
            )
            .then(
                a.content_bytes
                    .unwrap_or(usize::MAX)
                    .cmp(&b.content_bytes.unwrap_or(usize::MAX)),
            )
            .then(a.filename.cmp(&b.filename))
    });
    let selected = candidates.into_iter().next();
    DevicePartialArtifactSelectionReport {
        selected,
        rejection_reason,
    }
}

#[cfg(test)]
fn select_device_partial_artifact(
    sidecar: &serde_json::Value,
    generated_path: &str,
    request_path: Option<&str>,
    symbols: &[String],
) -> Option<DevicePartialArtifactSelection> {
    select_device_partial_artifact_with_report(sidecar, generated_path, request_path, symbols)
        .selected
}

fn selected_partial_reload_symbols(selection: &DevicePartialArtifactSelection) -> Vec<String> {
    normalized_symbol_set(&selection.symbols)
        .into_iter()
        .collect()
}

async fn read_selected_device_partial_artifact(
    workspace: &Path,
    selection: &DevicePartialArtifactSelection,
) -> Result<Option<String>> {
    let rel = match compile_request_relpath(&selection.filename) {
        Ok(rel) => rel,
        Err(e) => {
            eprintln!(
                "[gpu-hmr] partial artifact catalog entry rejected: file={} reason={}",
                selection.filename, e
            );
            return Ok(None);
        }
    };
    let source = match tokio::fs::read_to_string(workspace.join(rel)).await {
        Ok(source) => source,
        Err(e) => {
            eprintln!(
                "[gpu-hmr] partial artifact catalog entry unavailable: file={} reason={}",
                selection.filename, e
            );
            return Ok(None);
        }
    };
    if let Some(expected_hash) = selection.content_hash.as_deref() {
        let actual_hash = format!("{}", hash_content(&source));
        if actual_hash != expected_hash {
            eprintln!(
                "[gpu-hmr] partial artifact catalog entry stale: file={} expected_hash={} actual_hash={}",
                selection.filename, expected_hash, actual_hash
            );
            return Ok(None);
        }
    }
    Ok(Some(source))
}

async fn prepare_ai_delta_device_scope(
    workspace: &Path,
    sidecar: &serde_json::Value,
    generated_path: &str,
    request_path: &str,
    old_user_source: Option<&str>,
    new_user_source: &str,
    generated_device_source: &str,
) -> Result<Option<AiDeltaDeviceScope>> {
    let Some(symbol) = old_user_source
        .and_then(|old| device_header_kernel_body_only_edit_symbol(old, new_user_source))
    else {
        return Ok(None);
    };
    let symbols = vec![symbol];

    let selection_report = select_device_partial_artifact_with_report(
        sidecar,
        generated_path,
        Some(request_path),
        &symbols,
    );
    if let Some(selection) = selection_report.selected {
        if selection.kind == "kernel_region" {
            if let Some(source) =
                read_selected_device_partial_artifact(workspace, &selection).await?
            {
                eprintln!(
                    "[GPU AI Delta] scoped device prompt selected partial artifact file={} bytes={} symbols={} kind={}",
                    selection.filename,
                    source.len(),
                    symbols.join(","),
                    selection.kind
                );
                return Ok(Some(AiDeltaDeviceScope {
                    source,
                    filename: selection.filename,
                    symbols: selection.symbols,
                    artifact_kind: selection.kind,
                    source_paths: selection.source_paths,
                    selection_reason: selection.selection_reason,
                    mapping_confidence: selection.mapping_confidence,
                    dependency_hash: selection.dependency_hash,
                    compile_command_hash: selection.compile_command_hash,
                    verifier_evidence_id: selection.verifier_evidence_id,
                }));
            }
        } else {
            eprintln!(
                "[GPU AI Delta] scoped device prompt skipped partial artifact file={} kind={} reason=non_kernel_region",
                selection.filename, selection.kind
            );
        }
    } else if let Some(reason) = selection_report.rejection_reason.as_deref() {
        eprintln!(
            "[GPU AI Delta] scoped device prompt partial selection rejected: generated={} user={} symbols={} reason={}",
            generated_path,
            request_path,
            symbols.join(","),
            reason
        );
    }

    if let Some(source) = build_device_partial_source(generated_device_source, &symbols) {
        let filename = partial_device_filename(generated_path, &symbols, &source);
        eprintln!(
            "[GPU AI Delta] scoped device prompt synthesized partial artifact file={} bytes={} full_bytes={} symbols={}",
            filename,
            source.len(),
            generated_device_source.len(),
            symbols.join(",")
        );
        return Ok(Some(AiDeltaDeviceScope {
            source,
            filename,
            symbols,
            artifact_kind: "kernel_region".to_string(),
            source_paths: Vec::new(),
            selection_reason: "generated_body_partial".to_string(),
            mapping_confidence: None,
            dependency_hash: None,
            compile_command_hash: None,
            verifier_evidence_id: None,
        }));
    }

    Ok(None)
}

fn ai_delta_device_partial_payload(
    generated_path: &str,
    previous_full_device: &str,
    final_full_device: &str,
    scoped: Option<(&AiDeltaDeviceScope, &str)>,
) -> Option<serde_json::Value> {
    if let Some((scope, final_scoped_source)) = scoped {
        let filename = partial_device_filename(generated_path, &scope.symbols, final_scoped_source);
        return Some(serde_json::json!({
            "content": final_scoped_source,
            "filename": filename,
            "symbols": scope.symbols.clone(),
            "source": "aiDeltaPartialArtifact",
            "artifactFilename": scope.filename.clone(),
            "artifactKind": scope.artifact_kind.clone(),
            "sourcePaths": scope.source_paths.clone(),
            "selectionReason": scope.selection_reason.clone(),
            "mappingConfidence": scope.mapping_confidence.clone(),
            "dependencyHash": scope.dependency_hash.clone(),
            "compileCommandHash": scope.compile_command_hash.clone(),
            "verifierEvidenceId": scope.verifier_evidence_id.clone(),
            "requirePartial": true,
        }));
    }

    let symbols = changed_kernel_body_symbols(previous_full_device, final_full_device);
    if symbols.is_empty() {
        return None;
    }
    build_device_partial_source(final_full_device, &symbols).map(|partial_source| {
        let filename = partial_device_filename(generated_path, &symbols, &partial_source);
        serde_json::json!({
            "content": partial_source,
            "filename": filename,
            "symbols": symbols,
            "source": "aiDeltaChangedKernelArtifact",
            "artifactKind": "kernel_region",
            "sourcePaths": [],
            "selectionReason": "generated_body_partial",
            "requirePartial": true,
        })
    })
}

fn single_translation_unit_partial_payload(
    generated_path: &str,
    full_device_source: &str,
    full_symbols: &[String],
    affected_symbols: &[String],
) -> Option<serde_json::Value> {
    let full_symbol_set = normalized_symbol_set(full_symbols);
    let affected_symbol_set = normalized_symbol_set(affected_symbols);
    if full_symbol_set.is_empty()
        || affected_symbol_set.is_empty()
        || full_symbol_set != affected_symbol_set
    {
        return None;
    }

    let symbols = affected_symbol_set.into_iter().collect::<Vec<_>>();
    let filename = partial_device_filename(generated_path, &symbols, full_device_source);
    Some(serde_json::json!({
        "content": full_device_source,
        "filename": filename,
        "symbols": symbols,
        "source": "singleTranslationUnit",
        "artifactKind": "kernel_translation_unit",
        "sourcePaths": [],
        "selectionReason": "single_translation_unit",
        "fallbackReason": "partial_catalog_selection_unavailable",
        "requirePartial": true,
    }))
}

fn split_partial_device_source(
    split_data: &serde_json::Value,
) -> Option<DevicePartialCompileSource> {
    let partial = split_data.get("_synthi_device_partial")?;
    let string_field = |name: &str| {
        partial
            .get(name)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let source = partial
        .get("content")
        .or_else(|| partial.get("source"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())?
        .to_string();
    let filename = partial
        .get("filename")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())?
        .to_string();
    let symbols = partial
        .get("symbols")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|symbol| !symbol.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let source_paths = partial
        .get("sourcePaths")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter_map(normalized_request_filename)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let required = partial
        .get("requirePartial")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let artifact_kind = string_field("artifactKind");
    let fallback_reason = string_field("fallbackReason");
    if symbols.is_empty() {
        None
    } else {
        Some(DevicePartialCompileSource {
            source,
            filename,
            symbols,
            source_paths,
            required,
            artifact_kind,
            fallback_reason,
        })
    }
}

fn split_reload_plan_name(split_data: &serde_json::Value) -> Option<&str> {
    split_data
        .get("_synthi_reload_plan")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            split_data
                .pointer("/_synthi_reload_plan/selectedPlan")
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            split_data
                .pointer("/_synthi_reload_plan/plan")
                .and_then(serde_json::Value::as_str)
        })
}

fn manifest_device_source_matches(filename: &str, manifest: Option<&CompileManifest>) -> bool {
    let Some(request) = normalized_request_filename(filename) else {
        return false;
    };
    let Some(device) = manifest
        .and_then(CompileManifest::device_source_filename)
        .and_then(normalized_request_filename)
    else {
        return false;
    };
    request == device
}

fn direct_device_split_file_reload_plan(filename: &str) -> serde_json::Value {
    let normalized =
        normalized_request_filename(filename).unwrap_or_else(|| filename.replace('\\', "/"));
    let generated = normalized.clone();
    serde_json::json!({
        "schemaVersion": crate::hmr::gpu_prod_contracts::RELOAD_PLAN_SCHEMA_VERSION,
        "plan": "device_only",
        "reasonCodes": [
            "edit.direct_device_split_file",
            "build.device_sidecar_only"
        ],
        "affectedUserFiles": [normalized],
        "affectedGeneratedRoles": [generated],
        "timingsMs": {},
    })
}

fn can_compile_device_only_stage(
    split_data: &serde_json::Value,
    has_gpu_device_stage: bool,
    has_previous_core: bool,
    has_previous_gui: bool,
    is_gui: bool,
) -> bool {
    let device_reload_package = matches!(
        split_reload_plan_name(split_data),
        Some("device_only" | "warm_rebuild")
    ) || split_data.get("_synthi_device_partial").is_some();

    has_gpu_device_stage
        && device_reload_package
        && has_previous_core
        && (!is_gui || has_previous_gui)
}

fn allow_direct_translation_unit_partial(
    split_data: &serde_json::Value,
    has_gpu_device_stage: bool,
    has_previous_core: bool,
    has_previous_gui: bool,
    is_gui: bool,
    request_filename: &str,
    manifest: Option<&CompileManifest>,
) -> bool {
    has_gpu_device_stage
        && matches!(split_reload_plan_name(split_data), Some("device_only"))
        && has_previous_core
        && (!is_gui || has_previous_gui)
        && manifest_device_source_matches(request_filename, manifest)
}

async fn compile_device_sources_phase0(
    workspace_path: &Path,
    output_dir: &Path,
    timestamp: i64,
    sources: &DeviceCompileSources,
    manifest: &CompileManifest,
    allow_direct_translation_unit_partial: bool,
    allow_partial_device_reload: bool,
) -> Result<Option<DeviceCompileOutcome>> {
    let mut fallback_reason: Option<String> = None;
    if should_compile_partial_device_source(sources, allow_partial_device_reload) {
        if let (Some(partial_source), Some(partial_filename)) = (
            sources.partial_source.as_deref(),
            sources.partial_filename.as_deref(),
        ) {
            eprintln!(
                "[compile-device] partial source candidate file={} bytes={} full_bytes={} symbols={}",
                partial_filename,
                partial_source.len(),
                sources.full_source.len(),
                sources.partial_symbols.join(",")
            );
            match compile_device_phase0(
                workspace_path,
                output_dir,
                timestamp,
                partial_source,
                Some(partial_filename),
                manifest,
            )
            .await
            {
                Ok(Some(mut outcome)) => {
                    outcome.partial_module = true;
                    outcome.target_symbols = sources.partial_symbols.clone();
                    outcome.fallback_used = false;
                    outcome.fallback_reason = None;
                    outcome.requested_artifact_kind = sources.partial_artifact_kind.clone();
                    outcome.selected_artifact_kind = sources
                        .partial_artifact_kind
                        .clone()
                        .or_else(|| Some("partial_device".to_string()));
                    outcome.selected_artifact_bytes = Some(partial_source.len());
                    outcome.full_device_bytes = Some(sources.full_source.len());
                    validate_partial_device_artifact_exports(&outcome)?;
                    return Ok(Some(outcome));
                }
                Ok(None) => {
                    if sources.partial_required {
                        eprintln!(
                            "[compile-device] gpu-hmr-rejected fallbackUsed=false fallbackReason=required_partial_compile_no_artifact requestedArtifactKind={} selectedArtifactKind=none selectedArtifactBytes={} fullDeviceBytes={} file={}",
                            sources
                                .partial_artifact_kind
                                .as_deref()
                                .unwrap_or("partial_device"),
                            partial_source.len(),
                            sources.full_source.len(),
                            partial_filename
                        );
                        anyhow::bail!(
                            "required GPU partial source compile returned no artifact: {}",
                            partial_filename
                        );
                    }
                    eprintln!(
                        "[compile-device] partial source compile returned no artifact; falling back to full generated device"
                    );
                    fallback_reason = Some(
                        sources
                            .partial_fallback_reason
                            .clone()
                            .unwrap_or_else(|| "partial_compile_no_artifact".to_string()),
                    );
                }
                Err(e) => {
                    if sources.partial_required {
                        eprintln!(
                            "[compile-device] gpu-hmr-rejected fallbackUsed=false fallbackReason=required_partial_compile_failed requestedArtifactKind={} selectedArtifactKind=none selectedArtifactBytes={} fullDeviceBytes={} file={} error={e:#}",
                            sources
                                .partial_artifact_kind
                                .as_deref()
                                .unwrap_or("partial_device"),
                            partial_source.len(),
                            sources.full_source.len(),
                            partial_filename
                        );
                        return Err(e).with_context(|| {
                            format!(
                                "required GPU partial source compile failed: {}",
                                partial_filename
                            )
                        });
                    }
                    eprintln!(
                        "[compile-device] partial source compile failed; falling back to full generated device: {e:#}"
                    );
                    fallback_reason = Some(
                        sources
                            .partial_fallback_reason
                            .clone()
                            .unwrap_or_else(|| "partial_compile_failed".to_string()),
                    );
                }
            }
        }
    } else if sources.partial_source.is_some() && !allow_partial_device_reload {
        eprintln!(
            "[compile-device] partial source skipped; no live full device module was paused for this session"
        );
        fallback_reason = Some(
            sources
                .partial_fallback_reason
                .clone()
                .unwrap_or_else(|| "partial_reload_without_live_full_device_module".to_string()),
        );
    }

    let mut outcome = compile_device_phase0(
        workspace_path,
        output_dir,
        timestamp,
        &sources.full_source,
        sources.full_filename.as_deref(),
        manifest,
    )
    .await?;
    if let Some(outcome) = outcome.as_mut() {
        finalize_full_device_outcome(
            outcome,
            sources,
            fallback_reason,
            allow_direct_translation_unit_partial && allow_partial_device_reload,
        )?;
    }
    Ok(outcome)
}

fn should_compile_partial_device_source(
    sources: &DeviceCompileSources,
    allow_partial_device_reload: bool,
) -> bool {
    allow_partial_device_reload
        && sources.partial_source.is_some()
        && sources.partial_filename.is_some()
        && !sources.partial_symbols.is_empty()
}

fn finalize_full_device_outcome(
    outcome: &mut DeviceCompileOutcome,
    sources: &DeviceCompileSources,
    fallback_reason: Option<String>,
    allow_direct_translation_unit_partial: bool,
) -> Result<()> {
    let fallback_used = fallback_reason.is_some();
    let direct_translation_unit_partial = allow_direct_translation_unit_partial
        && sources.direct_workspace_source
        && sources.partial_source.is_none()
        && sources.partial_filename.is_none()
        && !fallback_used
        && !sources.full_symbols.is_empty();

    outcome.partial_module = direct_translation_unit_partial;
    outcome.target_symbols = sources.full_symbols.clone();
    outcome.fallback_used = fallback_used;
    outcome.fallback_reason = fallback_reason;
    outcome.requested_artifact_kind = if direct_translation_unit_partial {
        Some("direct_device_translation_unit".to_string())
    } else {
        sources.partial_artifact_kind.clone()
    };
    outcome.selected_artifact_kind = Some(
        if direct_translation_unit_partial {
            "direct_device_translation_unit"
        } else {
            "full_device"
        }
        .to_string(),
    );
    outcome.selected_artifact_bytes = Some(sources.full_source.len());
    outcome.full_device_bytes = Some(sources.full_source.len());

    if direct_translation_unit_partial {
        validate_partial_device_artifact_exports(outcome)?;
    }
    Ok(())
}

fn validate_partial_device_artifact_exports(outcome: &DeviceCompileOutcome) -> Result<()> {
    if !outcome.partial_module {
        return Ok(());
    }
    let expected = normalized_symbol_set(&outcome.target_symbols);
    if expected.is_empty() {
        anyhow::bail!("partial GPU artifact has no expected symbols");
    }
    let exported = normalized_symbol_set(&outcome.artifact_exported_symbols);
    if exported.is_empty() {
        anyhow::bail!("partial GPU artifact symbol inspection unavailable or empty");
    }

    let unresolved_mangled = exported
        .iter()
        .filter(|symbol| {
            looks_like_mangled_export(symbol)
                && !exported_symbol_matches_expected_source_identity(symbol, &expected)
        })
        .cloned()
        .collect::<Vec<_>>();
    if !unresolved_mangled.is_empty() {
        anyhow::bail!(
            "partial GPU artifact exports mangled symbols without explicit identity mapping: {}",
            unresolved_mangled.join(",")
        );
    }

    let ambiguous_exports = ambiguous_exported_symbol_identities(&exported, &expected);
    if !ambiguous_exports.is_empty() {
        anyhow::bail!(
            "partial GPU artifact has ambiguous exported symbol identity: {}",
            ambiguous_exports.join(", ")
        );
    }

    let missing = expected
        .difference(&exported)
        .filter(|expected_symbol| {
            !exported.iter().any(|exported_symbol| {
                exported_symbol_matches_expected_source_identity(exported_symbol, &expected)
                    && exported_symbol_source_identity_candidates(exported_symbol)
                        .iter()
                        .any(|candidate| candidate == *expected_symbol)
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        anyhow::bail!(
            "partial GPU artifact missing expected symbols: {}",
            missing.join(",")
        );
    }

    let unexpected = exported
        .difference(&expected)
        .filter(|symbol| !exported_symbol_matches_expected_source_identity(symbol, &expected))
        .cloned()
        .collect::<Vec<_>>();
    if !unexpected.is_empty() {
        anyhow::bail!(
            "partial GPU artifact exports unexpected symbols: {}",
            unexpected.join(",")
        );
    }

    eprintln!(
        "[compile-device] artifact symbol ownership status=ok expected_symbols={} exported_symbols={}",
        expected.into_iter().collect::<Vec<_>>().join(","),
        exported.into_iter().collect::<Vec<_>>().join(",")
    );
    Ok(())
}

fn ambiguous_exported_symbol_identities(
    exported: &BTreeSet<String>,
    expected: &BTreeSet<String>,
) -> Vec<String> {
    expected
        .iter()
        .filter_map(|expected_symbol| {
            let matches = exported
                .iter()
                .filter(|exported_symbol| {
                    exported_symbol == &expected_symbol
                        || exported_symbol_source_identity_candidates(exported_symbol)
                            .iter()
                            .any(|candidate| candidate == expected_symbol)
                })
                .cloned()
                .collect::<Vec<_>>();
            (matches.len() > 1).then(|| format!("{expected_symbol}=>{}", matches.join("|")))
        })
        .collect()
}

fn exported_symbol_matches_expected_source_identity(
    exported_symbol: &str,
    expected_symbols: &BTreeSet<String>,
) -> bool {
    if expected_symbols.contains(exported_symbol) {
        return true;
    }
    let matches = exported_symbol_source_identity_candidates(exported_symbol)
        .into_iter()
        .filter(|candidate| expected_symbols.contains(candidate))
        .collect::<BTreeSet<_>>();
    matches.len() == 1
}

fn exported_symbol_source_identity_candidates(exported_symbol: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(components) = parse_itanium_mangled_source_components(exported_symbol) {
        if !components.is_empty() {
            candidates.push(components.join("::"));
            if components.len() == 1 {
                let name = &components[0];
                candidates.push(name.clone());
            }
        }
    }
    candidates.sort();
    candidates.dedup();
    candidates
}

fn parse_itanium_mangled_source_components(symbol: &str) -> Option<Vec<String>> {
    let rest = symbol
        .strip_prefix("_Z")
        .or_else(|| symbol.strip_prefix("__Z"))?;
    if let Some(nested) = rest.strip_prefix('N') {
        let (components, _) = parse_itanium_component_sequence(nested, true)?;
        return Some(components);
    }
    let (component, _) = parse_itanium_length_prefixed_component(rest)?;
    Some(vec![component])
}

fn parse_itanium_component_sequence(mut input: &str, nested: bool) -> Option<(Vec<String>, &str)> {
    let mut components = Vec::new();
    loop {
        if nested && input.starts_with('E') {
            return (!components.is_empty()).then_some((components, &input[1..]));
        }
        input = input.trim_start_matches(|ch| matches!(ch, 'K' | 'V' | 'R'));
        let (component, rest) = parse_itanium_length_prefixed_component(input)?;
        components.push(component);
        input = rest;
        if !nested {
            return Some((components, input));
        }
    }
}

fn parse_itanium_length_prefixed_component(input: &str) -> Option<(String, &str)> {
    let digits_len = input
        .as_bytes()
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digits_len == 0 {
        return None;
    }
    let len = input.get(..digits_len)?.parse::<usize>().ok()?;
    let start = digits_len;
    let end = start.checked_add(len)?;
    let component = input.get(start..end)?;
    if component.is_empty() {
        return None;
    }
    Some((component.to_string(), input.get(end..).unwrap_or_default()))
}

fn looks_like_mangled_export(symbol: &str) -> bool {
    symbol.starts_with("_Z")
        || symbol.starts_with("__Z")
        || symbol.starts_with("?")
        || symbol.starts_with("$")
}

fn device_hmr_result_label(outcome: &DeviceCompileOutcome) -> &'static str {
    if outcome.partial_module {
        "gpu-hmr-partial"
    } else if outcome.fallback_used {
        "gpu-hmr-degraded-full-device"
    } else {
        "gpu-hmr-full-device"
    }
}

fn artifact_exports_expected_device_symbols(outcome: &DeviceCompileOutcome) -> bool {
    let exported = normalized_symbol_set(&outcome.artifact_exported_symbols);
    if exported.is_empty() {
        return false;
    }

    let expected = normalized_symbol_set(&outcome.target_symbols);
    if expected.is_empty() {
        return false;
    }

    expected.iter().all(|expected_symbol| {
        exported.iter().any(|exported_symbol| {
            exported_symbol == expected_symbol
                || exported_symbol_source_identity_candidates(exported_symbol)
                    .iter()
                    .any(|candidate| candidate == expected_symbol)
        })
    })
}

fn device_hmr_proof_telemetry(outcome: &DeviceCompileOutcome) -> GpuHmrProofTelemetry {
    let result_state = if artifact_exports_expected_device_symbols(outcome) {
        GpuHmrProofState::SymbolBound
    } else {
        GpuHmrProofState::CompileProven
    };

    let degraded_reason = match outcome.fallback_reason.as_deref() {
        Some(reason) if !reason.trim().is_empty() => {
            format!("runtime_dispatch_not_observed;fallback_reason={reason}")
        }
        _ => "runtime_dispatch_not_observed".to_string(),
    };

    GpuHmrProofTelemetry::new(
        result_state,
        Some(GpuHmrDegradedState::DispatchUnobserved),
        Some(degraded_reason),
        Some(device_hmr_result_label(outcome).to_string()),
    )
}

fn device_hmr_proof_stage_results(
    created_at: &str,
    source_edit_id: &str,
    selected_artifact_id: &str,
    artifact_evidence_id: &str,
    transport_evidence_id: &str,
    compiler_evidence_id: &str,
    symbol_evidence_id: &str,
    abi_evidence_id: &str,
    abi_stage_proven: bool,
    abi_stage_degraded_reason: Option<String>,
    symbol_bound: bool,
    proof: &GpuHmrProofTelemetry,
) -> Vec<GpuHmrProofStageResult> {
    let symbol_stage_status = if symbol_bound { "passed" } else { "blocked" };
    let symbol_degraded_reason = if symbol_bound {
        None
    } else {
        Some("expected_device_symbols_not_bound".to_string())
    };
    let abi_stage_status = if abi_stage_proven { "passed" } else { "blocked" };

    vec![
        GpuHmrProofStageResult {
            stage_id: "device-compile".to_string(),
            stage_name: "Device artifact compile".to_string(),
            status: "passed".to_string(),
            started_at: created_at.to_string(),
            completed_at: created_at.to_string(),
            input_artifact_ids: vec![source_edit_id.to_string()],
            output_artifact_ids: vec![selected_artifact_id.to_string()],
            evidence_refs: vec![
                artifact_evidence_id.to_string(),
                compiler_evidence_id.to_string(),
            ],
            degraded_state: None,
            degraded_reason: None,
        },
        GpuHmrProofStageResult {
            stage_id: "artifact-transport".to_string(),
            stage_name: "Device artifact transport".to_string(),
            status: "blocked".to_string(),
            started_at: created_at.to_string(),
            completed_at: created_at.to_string(),
            input_artifact_ids: vec![selected_artifact_id.to_string()],
            output_artifact_ids: vec![selected_artifact_id.to_string()],
            evidence_refs: vec![transport_evidence_id.to_string()],
            degraded_state: Some(GpuHmrDegradedState::RamIoUnavailable.as_str().to_string()),
            degraded_reason: Some("selected_loader_transport_not_observed".to_string()),
        },
        GpuHmrProofStageResult {
            stage_id: "symbol-binding".to_string(),
            stage_name: "Expected device symbol binding".to_string(),
            status: symbol_stage_status.to_string(),
            started_at: created_at.to_string(),
            completed_at: created_at.to_string(),
            input_artifact_ids: vec![selected_artifact_id.to_string()],
            output_artifact_ids: vec![selected_artifact_id.to_string()],
            evidence_refs: vec![symbol_evidence_id.to_string()],
            degraded_state: if symbol_bound {
                None
            } else {
                proof.degraded_state.clone()
            },
            degraded_reason: symbol_degraded_reason,
        },
        GpuHmrProofStageResult {
            stage_id: "abi-compatibility".to_string(),
            stage_name: "Device ABI compatibility".to_string(),
            status: abi_stage_status.to_string(),
            started_at: created_at.to_string(),
            completed_at: created_at.to_string(),
            input_artifact_ids: vec![selected_artifact_id.to_string()],
            output_artifact_ids: if abi_stage_proven {
                vec![selected_artifact_id.to_string()]
            } else {
                Vec::new()
            },
            evidence_refs: vec![abi_evidence_id.to_string()],
            degraded_state: if abi_stage_proven {
                None
            } else {
                Some(GpuHmrDegradedState::AbiUnverified.as_str().to_string())
            },
            degraded_reason: if abi_stage_proven {
                None
            } else {
                abi_stage_degraded_reason
            },
        },
        GpuHmrProofStageResult {
            stage_id: "runtime-dispatch-observation".to_string(),
            stage_name: "Runtime dispatch observation".to_string(),
            status: "blocked".to_string(),
            started_at: created_at.to_string(),
            completed_at: created_at.to_string(),
            input_artifact_ids: vec![selected_artifact_id.to_string()],
            output_artifact_ids: Vec::new(),
            evidence_refs: Vec::new(),
            degraded_state: proof.degraded_state.clone(),
            degraded_reason: proof.degraded_reason.clone(),
        },
    ]
}

fn abi_metadata_accepted_extractor_count(abi_material: &serde_json::Value) -> usize {
    abi_material
        .get("acceptedExtractorEvidenceRefs")
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

fn abi_metadata_accepted_extractor_provenance(
    abi_material: &serde_json::Value,
) -> (bool, Vec<String>, Vec<String>) {
    const ACCEPTED_ABI_EXTRACTOR_KINDS: &[&str] = &[
        "clang_ast",
        "clang_record_layout",
        "compiled_artifact_symbol_table",
        "compiler_invocation_metadata",
        "runtime_wrapper_instrumentation",
    ];

    let explicit_refs = string_array_field(abi_material, "acceptedExtractorEvidenceRefs");
    let explicit_sources = string_array_field(abi_material, "acceptedExtractorSources");
    let mut refs = BTreeSet::new();
    let mut sources = BTreeSet::new();

    if let Some(records) = abi_material
        .get("extractorProvenance")
        .and_then(serde_json::Value::as_array)
    {
        for record in records {
            let kind = record
                .get("kind")
                .or_else(|| record.get("extractorKind"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or_default();
            let evidence_id = record
                .get("evidenceId")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let extractor_name = record
                .get("extractorName")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let extractor_version = record
                .get("extractorVersion")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let input_hash = record
                .get("inputHash")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let explicitly_rejected = record
                .get("acceptedByRuntimeCorrectnessPlan")
                .and_then(serde_json::Value::as_bool)
                == Some(false);

            if ACCEPTED_ABI_EXTRACTOR_KINDS.contains(&kind)
                && evidence_id.is_some()
                && extractor_name.is_some()
                && extractor_version.is_some()
                && input_hash.is_some()
                && !explicitly_rejected
            {
                refs.insert(evidence_id.unwrap().to_string());
                sources.insert(kind.to_string());
            }
        }
    }

    let refs = refs.into_iter().collect::<Vec<_>>();
    let sources = sources.into_iter().collect::<Vec<_>>();
    let refs_match = explicit_refs.is_empty()
        || explicit_refs.iter().all(|explicit| refs.iter().any(|value| value == explicit));
    let sources_match = explicit_sources.is_empty()
        || explicit_sources
            .iter()
            .all(|explicit| sources.iter().any(|value| value == explicit));
    (!refs.is_empty() && refs_match && sources_match, refs, sources)
}

fn abi_stage_verdict_from_metadata(abi_material: &serde_json::Value) -> (bool, Option<String>) {
    let layout_size_alignment_verified = abi_material
        .get("layoutSizeAlignmentVerified")
        .and_then(serde_json::Value::as_bool)
        == Some(true);
    let extractor_provenance_complete = abi_material
        .get("extractorProvenanceComplete")
        .and_then(serde_json::Value::as_bool)
        != Some(false);
    let (accepted_extractor_provenance_observed, _, _) =
        abi_metadata_accepted_extractor_provenance(abi_material);

    if layout_size_alignment_verified
        && accepted_extractor_provenance_observed
        && extractor_provenance_complete
    {
        return (true, None);
    }

    let degraded_reason = string_field(abi_material, "degradedReason").or_else(|| {
        if !layout_size_alignment_verified {
            Some("abi_layout_size_alignment_unverified".to_string())
        } else if !accepted_extractor_provenance_observed {
            Some("abi_extractor_provenance_unverified".to_string())
        } else {
            Some("abi_extractor_provenance_incomplete".to_string())
        }
    });
    (false, degraded_reason)
}

fn device_abi_evidence_summary(
    abi_material: &serde_json::Value,
    constant_global_layout_hash: &str,
) -> String {
    format!(
        "kernel_signatures={} constant_global_layout_hash={} metadata_only=true accepted_extractors={}",
        abi_material
            .get("kernelSignatures")
            .and_then(serde_json::Value::as_array)
            .map(|items| items.len())
            .unwrap_or(0),
        constant_global_layout_hash,
        abi_metadata_accepted_extractor_count(abi_material)
    )
}

fn device_artifact_transport_metadata(
    selected_artifact_id: &str,
    artifact_hash: &str,
    artifact_bytes: usize,
    outcome: &DeviceCompileOutcome,
) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": "synthi.gpu.hmr.artifact_transport.v1",
        "selectedArtifactId": selected_artifact_id,
        "artifactContentHash": format!("sha256:{artifact_hash}"),
        "artifactBytes": artifact_bytes,
        "compileOutputTransport": "filesystem_path+ram_blob",
        "compileOutputTransports": ["filesystem_path", "ram_blob"],
        "reloadRequestTransports": ["filesystem_path", "ram_blob"],
        "selectedLoaderTransport": serde_json::Value::Null,
        "ramArtifactReferenceProvided": true,
        "ramBlobId": selected_artifact_id,
        "ramBytesHash": format!("sha256:{artifact_hash}"),
        "fallbackRecorded": false,
        "degradedState": GpuHmrDegradedState::RamIoUnavailable.as_str(),
        "degradedReason": "selected_loader_transport_not_observed",
        "partialModule": outcome.partial_module,
        "selectedArtifactKind": outcome.selected_artifact_kind.as_deref(),
        "requestedArtifactKind": outcome.requested_artifact_kind.as_deref(),
    })
}

fn device_artifact_transport_summary(transport_material: &serde_json::Value) -> String {
    format!(
        "compile_transport={} reload_transports={} selected_loader={} ram_reference={} degraded_state={}",
        transport_material
            .get("compileOutputTransport")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown"),
        transport_material
            .get("reloadRequestTransports")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "unknown".to_string()),
        transport_material
            .get("selectedLoaderTransport")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown"),
        transport_material
            .get("ramArtifactReferenceProvided")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        transport_material
            .get("degradedState")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("none")
    )
}

fn fission_verifier_report_from_sidecar(
    sidecar_meta: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    sidecar_meta
        .and_then(|meta| {
            meta.get("fissionVerifierReport")
                .or_else(|| meta.pointer("/runReport/fissionVerifierReport"))
        })
        .filter(|report| report.is_object())
        .cloned()
}

fn normalized_fission_hash(value: Option<&str>, fallback_material: &serde_json::Value) -> String {
    let valid = value
        .map(str::trim)
        .filter(|value| {
            let digest = value.strip_prefix("sha256:").unwrap_or(value);
            digest.len() == 64 && digest.chars().all(|ch| ch.is_ascii_hexdigit())
        })
        .map(str::to_string);
    valid.unwrap_or_else(|| sha256_hex_str(&fallback_material.to_string()))
}

fn partial_fission_source_paths(
    outcome: &DeviceCompileOutcome,
    sources: Option<&DeviceCompileSources>,
) -> Vec<String> {
    let mut paths = sources
        .map(|sources| sources.partial_source_paths.clone())
        .unwrap_or_default();
    if paths.is_empty() {
        if let Some(filename) = sources
            .and_then(|sources| sources.full_filename.as_deref())
            .or(outcome.proof_metadata.source_filename.as_deref())
        {
            paths.push(filename.to_string());
        }
    }
    paths
        .into_iter()
        .filter_map(|path| normalized_request_filename(&path))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn partial_fission_line_count(
    outcome: &DeviceCompileOutcome,
    sources: Option<&DeviceCompileSources>,
) -> u64 {
    let source = sources
        .and_then(|sources| sources.partial_source.as_deref())
        .unwrap_or(outcome.compiled_source.as_str());
    let count = source.lines().count().max(1);
    u64::try_from(count).unwrap_or(u64::MAX)
}

fn normalized_fission_scope_text(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect()
}

fn partial_fission_scope_rank(scope: &str) -> u64 {
    let normalized = normalized_fission_scope_text(scope);
    if normalized.contains("body") || normalized.contains("function") {
        0
    } else if normalized.contains("source_include")
        || (normalized.contains("partial") && normalized.contains("device"))
    {
        1
    } else if normalized.contains("multi") {
        2
    } else if normalized.contains("full")
        && (normalized.contains("device") || normalized.contains("module"))
    {
        3
    } else if normalized.contains("host") {
        4
    } else if normalized.contains("runner")
        || normalized.contains("process")
        || normalized.contains("restart")
    {
        5
    } else {
        2
    }
}

fn partial_fission_rejected_scope_label(scope_rank: u64) -> &'static str {
    match scope_rank {
        0 => "single_body_or_function",
        1 => "source_include_or_partial_device",
        2 => "multi_artifact_region",
        3 => "full_device_module",
        4 => "host_path",
        _ => "process_or_runner",
    }
}

fn partial_fission_narrower_rejections(
    selected_scope: &str,
    candidate_evidence_id: &str,
    sources: Option<&DeviceCompileSources>,
) -> Vec<serde_json::Value> {
    let selected_scope_rank = partial_fission_scope_rank(selected_scope);
    (0..selected_scope_rank)
        .map(|scope_rank| {
            serde_json::json!({
                "scopeRank": scope_rank,
                "artifactKind": partial_fission_rejected_scope_label(scope_rank),
                "reasonCode": "fission.narrower_scope_not_materialized_by_runtime_artifact_selection",
                "selectionMetadata": {
                    "selectedScope": selected_scope,
                    "directWorkspaceSource": sources
                        .map(|sources| sources.direct_workspace_source)
                        .unwrap_or(false),
                    "partialSourceAvailable": sources
                        .and_then(|sources| sources.partial_source.as_ref())
                        .is_some(),
                    "partialFilenameAvailable": sources
                        .and_then(|sources| sources.partial_filename.as_ref())
                        .is_some(),
                    "partialRequired": sources
                        .map(|sources| sources.partial_required)
                        .unwrap_or(false),
                    "partialFallbackReason": sources
                        .and_then(|sources| sources.partial_fallback_reason.as_deref()),
                },
                "verifierEvidenceIds": [candidate_evidence_id],
            })
        })
        .collect()
}

fn partial_fission_candidate_and_evidence(
    outcome: &DeviceCompileOutcome,
    sources: Option<&DeviceCompileSources>,
    created_at: &str,
    runtime_session_id: &str,
    source_edit_id: &str,
    selected_artifact_id: &str,
    artifact_hash: &str,
    compiler_evidence_id: &str,
    symbol_evidence_id: &str,
    abi_evidence_id: &str,
    transport_evidence_id: &str,
) -> Option<(serde_json::Value, GpuHmrProofEvidenceRef)> {
    if !outcome.partial_module {
        return None;
    }

    let source_paths = partial_fission_source_paths(outcome, sources);
    if source_paths.is_empty() || outcome.target_symbols.is_empty() {
        return None;
    }
    let exported_symbols = if outcome.artifact_exported_symbols.is_empty() {
        outcome.target_symbols.clone()
    } else {
        outcome.artifact_exported_symbols.clone()
    };
    let source_line_count = partial_fission_line_count(outcome, sources);
    let source_spans = source_paths
        .iter()
        .map(|path| {
            serde_json::json!({
                "path": path,
                "startLine": 1,
                "endLine": source_line_count,
            })
        })
        .collect::<Vec<_>>();
    let include_closure = source_paths
        .iter()
        .map(|path| serde_json::json!({ "path": path }))
        .collect::<Vec<_>>();
    let artifact_kind = outcome
        .selected_artifact_kind
        .as_deref()
        .or(outcome.requested_artifact_kind.as_deref())
        .unwrap_or("partial_device");
    let replacement_scope = if outcome.partial_module {
        outcome
            .selected_artifact_kind
            .as_deref()
            .or(outcome.requested_artifact_kind.as_deref())
            .unwrap_or("partial_device")
    } else {
        artifact_kind
    };
    let compile_recipe_material = serde_json::json!({
        "compileProvenance": &outcome.proof_metadata,
        "artifactKind": artifact_kind,
        "replacementScope": replacement_scope,
        "sourcePaths": &source_paths,
        "targetSymbols": &outcome.target_symbols,
    });
    let dependency_material = serde_json::json!({
        "sourcePaths": &source_paths,
        "includeClosure": &include_closure,
        "artifactHash": format!("sha256:{artifact_hash}"),
    });
    let compile_command_material = serde_json::json!({
        "compileCommandHash": outcome.proof_metadata.compile_command_hash.as_deref(),
        "effectiveDeviceFlags": &outcome.proof_metadata.effective_device_flags,
        "compilerIdentity": outcome.proof_metadata.compiler_identity.as_deref(),
    });
    let dependency_hash = normalized_fission_hash(
        outcome.proof_metadata.dependency_hash.as_deref(),
        &dependency_material,
    );
    let compile_recipe_hash = sha256_hex_str(&compile_recipe_material.to_string());
    let compile_command_hash = normalized_fission_hash(
        outcome.proof_metadata.compile_command_hash.as_deref(),
        &compile_command_material,
    );
    let seed = serde_json::json!({
        "sourceEditId": source_edit_id,
        "selectedArtifactId": selected_artifact_id,
        "artifactHash": format!("sha256:{artifact_hash}"),
        "sourcePaths": &source_paths,
        "sourceSpans": &source_spans,
        "targetSymbols": &outcome.target_symbols,
        "exportedSymbolsExpected": &exported_symbols,
        "artifactKind": artifact_kind,
        "replacementScope": replacement_scope,
        "dependencyClosureHash": &dependency_hash,
        "compileRecipeHash": &compile_recipe_hash,
        "compileCommandHash": &compile_command_hash,
    });
    let seed_hash = sha256_hex_str(&seed.to_string());
    let island_id = format!("fission-island:sha256:{seed_hash}");
    let candidate_evidence_id = format!("evidence:fission-island-input:{seed_hash}");
    let required_oracle_id = format!("oracle:required:sha256:{seed_hash}");

    let mut candidate = serde_json::json!({
        "schemaVersion": crate::hmr::gpu_fission::FISSION_ISLAND_SCHEMA_VERSION,
        "islandId": island_id,
        "sourceEditId": source_edit_id,
        "sourcePaths": source_paths,
        "sourceSpans": source_spans,
        "generatedRolePath": sources
            .and_then(|sources| sources.full_filename.as_deref())
            .or(outcome.proof_metadata.source_filename.as_deref()),
        "targetSymbols": &outcome.target_symbols,
        "exportedSymbolsExpected": exported_symbols,
        "artifactKind": artifact_kind,
        "replacementScope": replacement_scope,
        "includeClosure": include_closure,
        "dependencyClosureHash": dependency_hash,
        "abiMembraneId": format!("abi-membrane:{abi_evidence_id}"),
        "compileRecipeHash": compile_recipe_hash,
        "compileCommandHash": compile_command_hash,
        "loaderCapabilityRequirement": {
            "selectedArtifactId": selected_artifact_id,
            "acceptedTransports": ["ram_blob", "filesystem_path"],
        },
        "requiredOracleId": required_oracle_id,
        "verifierEvidenceIds": [
            candidate_evidence_id.clone(),
            compiler_evidence_id,
            symbol_evidence_id,
            abi_evidence_id,
            transport_evidence_id
        ],
        "sourceMappingEvidenceIds": [candidate_evidence_id.clone()],
        "includeClosureEvidenceIds": [candidate_evidence_id.clone()],
        "symbolOwnershipEvidenceIds": [symbol_evidence_id],
        "dependencyClosureEvidenceIds": [candidate_evidence_id.clone()],
        "abiMembraneEvidenceIds": [abi_evidence_id],
        "compileRecipeEvidenceIds": [compiler_evidence_id],
        "loaderCapabilityEvidenceIds": [transport_evidence_id],
        "outputOracleEvidenceIds": [candidate_evidence_id.clone()],
        "proposalSource": {
            "producer": "worker.compile_device",
            "kind": "partial_artifact_selection_metadata"
        },
    });
    if let Some(extra) = candidate
        .get("exportedSymbolsExpected")
        .and_then(serde_json::Value::as_array)
        .map(|exports| {
            let targets = outcome
                .target_symbols
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>();
            exports
                .iter()
                .filter_map(serde_json::Value::as_str)
                .filter(|symbol| !targets.contains(*symbol))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|extra| !extra.is_empty())
    {
        if let Some(object) = candidate.as_object_mut() {
            object.insert(
                "safeExportSupersetReason".to_string(),
                serde_json::Value::String(
                    "partial artifact symbol ownership verifier accepted exported superset"
                        .to_string(),
                ),
            );
            object.insert(
                "safeExportSupersetEvidenceIds".to_string(),
                serde_json::json!([symbol_evidence_id]),
            );
            object.insert(
                "safeExportSupersetSymbolsDeclared".to_string(),
                serde_json::json!(extra),
            );
        }
    }
    let narrower_rejections =
        partial_fission_narrower_rejections(replacement_scope, &candidate_evidence_id, sources);
    if !narrower_rejections.is_empty() {
        if let Some(object) = candidate.as_object_mut() {
            object.insert(
                "narrowerCandidateRejections".to_string(),
                serde_json::Value::Array(narrower_rejections),
            );
        }
    }

    let evidence = GpuHmrProofEvidenceRef {
        evidence_id: candidate_evidence_id,
        kind: "fission-island-input".to_string(),
        content_hash: format!("sha256:{}", sha256_hex_str(&candidate.to_string())),
        producer_subsystem: "worker.compile_device".to_string(),
        timestamp: created_at.to_string(),
        session_id: Some(runtime_session_id.to_string()),
        file_path: None,
        artifact_uri: Some(selected_artifact_id.to_string()),
        summary: format!(
            "partial artifact fission candidate source_paths={} target_symbols={} artifact_kind={}",
            candidate
                .get("sourcePaths")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len)
                .unwrap_or(0),
            outcome.target_symbols.len(),
            artifact_kind
        ),
        metadata: Some(candidate.clone()),
    };
    Some((candidate, evidence))
}

fn fission_report_status(report: &serde_json::Value) -> &str {
    report
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("missing")
}

fn fission_report_u64(report: &serde_json::Value, field: &str) -> u64 {
    report
        .get(field)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
}

fn fission_report_selected_island(report: &serde_json::Value) -> &str {
    report
        .get("selectedIslandId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("none")
}

fn fission_verifier_summary(report: &serde_json::Value) -> String {
    format!(
        "status={} candidates={} accepted={} rejected={} selected_island={}",
        fission_report_status(report),
        fission_report_u64(report, "candidateCount"),
        fission_report_u64(report, "acceptedCount"),
        fission_report_u64(report, "rejectedCount"),
        fission_report_selected_island(report)
    )
}

fn fission_verifier_rejection_reason(report: &serde_json::Value) -> Option<String> {
    if fission_report_status(report) == "pass" {
        return None;
    }
    fission_report_reason_codes(report)
        .into_iter()
        .find(|code| *code != "fission.no_accepted_candidate")
        .or_else(|| {
            fission_report_reason_codes(report)
                .into_iter()
                .find(|code| !code.trim().is_empty())
        })
        .map(str::to_string)
        .or_else(|| Some("fission_verifier_rejected".to_string()))
}

fn fission_report_reason_codes(report: &serde_json::Value) -> Vec<&str> {
    let mut codes = Vec::new();
    if let Some(reason_codes) = report
        .get("reasonCodes")
        .and_then(serde_json::Value::as_array)
    {
        codes.extend(reason_codes.iter().filter_map(serde_json::Value::as_str));
    }
    if let Some(candidates) = report.get("candidates").and_then(serde_json::Value::as_array) {
        for candidate in candidates {
            if candidate.get("status").and_then(serde_json::Value::as_str) == Some("pass") {
                continue;
            }
            if let Some(reason_codes) = candidate
                .get("reasonCodes")
                .and_then(serde_json::Value::as_array)
            {
                codes.extend(reason_codes.iter().filter_map(serde_json::Value::as_str));
            }
        }
    }
    codes
}

fn fission_verifier_evidence_and_stage(
    report: &serde_json::Value,
    created_at: &str,
    runtime_session_id: &str,
    source_edit_id: &str,
    selected_artifact_id: &str,
) -> (GpuHmrProofEvidenceRef, GpuHmrProofStageResult) {
    let report_hash = sha256_hex_str(&report.to_string());
    let evidence_id = format!("evidence:fission-verifier-report:{report_hash}");
    let passed = fission_report_status(report) == "pass";
    let evidence = GpuHmrProofEvidenceRef {
        evidence_id: evidence_id.clone(),
        kind: "fission-verifier-report".to_string(),
        content_hash: format!("sha256:{report_hash}"),
        producer_subsystem: "worker.gpu_fission_verifier".to_string(),
        timestamp: created_at.to_string(),
        session_id: Some(runtime_session_id.to_string()),
        file_path: None,
        artifact_uri: Some(selected_artifact_id.to_string()),
        summary: fission_verifier_summary(report),
        metadata: Some(report.clone()),
    };
    let stage = GpuHmrProofStageResult {
        stage_id: "fission-candidate-verification".to_string(),
        stage_name: "Grand fission candidate verification".to_string(),
        status: if passed { "passed" } else { "blocked" }.to_string(),
        started_at: created_at.to_string(),
        completed_at: created_at.to_string(),
        input_artifact_ids: vec![source_edit_id.to_string()],
        output_artifact_ids: if passed {
            vec![selected_artifact_id.to_string()]
        } else {
            Vec::new()
        },
        evidence_refs: vec![evidence_id],
        degraded_state: None,
        degraded_reason: fission_verifier_rejection_reason(report),
    };
    (evidence, stage)
}

async fn reload_artifact_blob_from_outcome(
    outcome: &DeviceCompileOutcome,
) -> Result<ReloadArtifactBlob> {
    let bytes = tokio::fs::read(&outcome.artifact_path)
        .await
        .with_context(|| {
            format!(
                "reading selected GPU HMR artifact for RAM reload transport {}",
                outcome.artifact_path.display()
            )
        })?;
    let artifact_hash = sha256_hex_bytes(&bytes);
    Ok(ReloadArtifactBlob {
        blob_id: format!("artifact:sha256:{artifact_hash}"),
        content_hash: format!("sha256:{artifact_hash}"),
        bytes,
    })
}

async fn write_device_hmr_proof_artifact(
    workspace: &Path,
    workspace_slug: Option<&str>,
    session_id: &str,
    source_hash: &str,
    outcome: &DeviceCompileOutcome,
    sources: Option<&DeviceCompileSources>,
    proof: &GpuHmrProofTelemetry,
    sidecar_meta: Option<&serde_json::Value>,
) -> Result<GpuHmrProofArtifactWrite> {
    let created_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let artifact_bytes = tokio::fs::read(&outcome.artifact_path)
        .await
        .with_context(|| {
            format!(
                "reading selected GPU HMR artifact for proof {}",
                outcome.artifact_path.display()
            )
        })?;
    let artifact_hash = sha256_hex_bytes(&artifact_bytes);
    let selected_artifact_id = format!("artifact:sha256:{artifact_hash}");
    let source_edit_id = format!("source-edit:{source_hash}");
    let runtime_session_id = format!("runtime-session:{session_id}");
    let workspace_slug = workspace_slug
        .filter(|slug| !slug.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            workspace
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "workspace".to_string());
    let artifact_path = workspace_relative_string(workspace, &outcome.artifact_path);

    let artifact_evidence_id = format!("evidence:device-artifact:{artifact_hash}");
    let transport_material = device_artifact_transport_metadata(
        &selected_artifact_id,
        &artifact_hash,
        artifact_bytes.len(),
        outcome,
    );
    let transport_evidence_hash = sha256_hex_str(&transport_material.to_string());
    let transport_evidence_id =
        format!("evidence:device-artifact-transport:{transport_evidence_hash}");
    let compiler_evidence_hash = sha256_hex_str(&outcome.stderr);
    let compiler_evidence_id = format!("evidence:device-compiler:{compiler_evidence_hash}");
    let symbol_material = serde_json::json!({
        "targetSymbols": &outcome.target_symbols,
        "artifactExportedSymbols": &outcome.artifact_exported_symbols,
        "symbolBound": artifact_exports_expected_device_symbols(outcome),
    });
    let symbol_evidence_hash = sha256_hex_str(&symbol_material.to_string());
    let symbol_evidence_id = format!("evidence:device-symbols:{symbol_evidence_hash}");
    let kernel_abi_fingerprint = kernel_abi_fingerprint_source(&outcome.compiled_source);
    let constant_global_layout_hash =
        device_constant_global_layout_fingerprint(&outcome.compiled_source);
    let clang_ast_abi = clang_ast_abi_extraction(workspace, outcome).await;
    let mut extractor_provenance = source_scan_abi_extractor_provenance(&outcome.compiled_source)
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(clang_ast_abi) = clang_ast_abi.as_ref() {
        extractor_provenance.extend(clang_ast_abi.extractor_provenance.clone());
    }
    let layout_size_alignment_verified = clang_ast_abi
        .as_ref()
        .is_some_and(|abi| abi.layout_size_alignment_verified);
    let accepted_extractor_evidence_refs = clang_ast_abi
        .as_ref()
        .map(|abi| abi.accepted_extractor_evidence_refs.clone())
        .unwrap_or_default();
    let accepted_extractor_sources = clang_ast_abi
        .as_ref()
        .map(|abi| abi.accepted_extractor_sources.clone())
        .unwrap_or_default();
    let clang_ast_kernel_signatures = clang_ast_abi
        .as_ref()
        .map(|abi| abi.kernel_signatures.clone())
        .unwrap_or_default();
    let parameter_abi_records = clang_ast_abi
        .as_ref()
        .map(|abi| abi.parameter_abi_records.clone())
        .unwrap_or_default();
    let abi_degraded_reason = clang_ast_abi
        .as_ref()
        .and_then(|abi| abi.degraded_reason.clone());
    let abi_material = serde_json::json!({
        "schemaVersion": "synthi.gpu.hmr.abi_metadata.v1",
        "kernelSymbols": extract_device_kernel_symbols(&outcome.compiled_source),
        "kernelSignatures": extract_device_kernel_signatures(&outcome.compiled_source),
        "clangAstKernelSignatures": clang_ast_kernel_signatures,
        "parameterAbiRecords": parameter_abi_records,
        "kernelAbiFingerprintHash": sha256_hex_str(&kernel_abi_fingerprint),
        "constantGlobalLayoutHash": &constant_global_layout_hash,
        "layoutSizeAlignmentVerified": layout_size_alignment_verified,
        "acceptedExtractorEvidenceRefs": accepted_extractor_evidence_refs,
        "acceptedExtractorSources": accepted_extractor_sources,
        "extractorProvenance": extractor_provenance,
        "degradedReason": abi_degraded_reason,
        "partialModule": outcome.partial_module,
        "targetSymbols": &outcome.target_symbols,
        "artifactExportedSymbols": &outcome.artifact_exported_symbols,
        "selectedArtifactKind": outcome.selected_artifact_kind.as_deref(),
        "requestedArtifactKind": outcome.requested_artifact_kind.as_deref(),
    });
    let (abi_stage_proven, abi_stage_degraded_reason) =
        abi_stage_verdict_from_metadata(&abi_material);
    let abi_evidence_hash = sha256_hex_str(&abi_material.to_string());
    let abi_evidence_id = format!("evidence:device-abi-metadata:{abi_evidence_hash}");

    let mut evidence_refs = vec![
        GpuHmrProofEvidenceRef {
            evidence_id: artifact_evidence_id.clone(),
            kind: "device-artifact".to_string(),
            content_hash: format!("sha256:{artifact_hash}"),
            producer_subsystem: "worker.compile_device".to_string(),
            timestamp: created_at.clone(),
            session_id: Some(runtime_session_id.clone()),
            file_path: Some(artifact_path),
            artifact_uri: Some(selected_artifact_id.clone()),
            summary: format!(
                "Selected device artifact bytes={} partial={} selected_kind={}",
                artifact_bytes.len(),
                outcome.partial_module,
                outcome
                    .selected_artifact_kind
                    .as_deref()
                    .unwrap_or("unspecified")
            ),
            metadata: Some(serde_json::json!({
                "artifactBytes": artifact_bytes.len(),
                "partialModule": outcome.partial_module,
                "selectedArtifactKind": outcome.selected_artifact_kind.as_deref(),
                "requestedArtifactKind": outcome.requested_artifact_kind.as_deref(),
            })),
        },
        GpuHmrProofEvidenceRef {
            evidence_id: transport_evidence_id.clone(),
            kind: "device-artifact-transport".to_string(),
            content_hash: format!("sha256:{transport_evidence_hash}"),
            producer_subsystem: "worker.compile_device".to_string(),
            timestamp: created_at.clone(),
            session_id: Some(runtime_session_id.clone()),
            file_path: None,
            artifact_uri: Some(selected_artifact_id.clone()),
            summary: device_artifact_transport_summary(&transport_material),
            metadata: Some(transport_material),
        },
        GpuHmrProofEvidenceRef {
            evidence_id: compiler_evidence_id.clone(),
            kind: "device-compiler-output".to_string(),
            content_hash: format!("sha256:{compiler_evidence_hash}"),
            producer_subsystem: "worker.compile_device".to_string(),
            timestamp: created_at.clone(),
            session_id: Some(runtime_session_id.clone()),
            file_path: None,
            artifact_uri: None,
            summary: format!(
                "Device compiler completed in {} ms with stderr_bytes={} compile_command_hash={} dependency_hash={} cache_hit={}",
                outcome.compiler_elapsed_ms,
                outcome.stderr.len(),
                outcome
                    .proof_metadata
                    .compile_command_hash
                    .as_deref()
                    .unwrap_or("unavailable"),
                outcome
                    .proof_metadata
                    .dependency_hash
                    .as_deref()
                    .unwrap_or("unavailable"),
                outcome.proof_metadata.cache_hit
            ),
            metadata: Some(serde_json::json!({
                "compilerElapsedMs": outcome.compiler_elapsed_ms,
                "stderrBytes": outcome.stderr.len(),
                "diagnostics": &outcome.diagnostics,
                "compileProvenance": &outcome.proof_metadata,
            })),
        },
        GpuHmrProofEvidenceRef {
            evidence_id: symbol_evidence_id.clone(),
            kind: "device-symbol-set".to_string(),
            content_hash: format!("sha256:{symbol_evidence_hash}"),
            producer_subsystem: "worker.compile_device".to_string(),
            timestamp: created_at.clone(),
            session_id: Some(runtime_session_id.clone()),
            file_path: None,
            artifact_uri: Some(selected_artifact_id.clone()),
            summary: format!(
                "target_symbols={} exported_symbols={} symbol_bound={}",
                outcome.target_symbols.len(),
                outcome.artifact_exported_symbols.len(),
                artifact_exports_expected_device_symbols(outcome)
            ),
            metadata: Some(symbol_material),
        },
        GpuHmrProofEvidenceRef {
            evidence_id: abi_evidence_id.clone(),
            kind: "device-abi-metadata".to_string(),
            content_hash: format!("sha256:{abi_evidence_hash}"),
            producer_subsystem: "worker.compile_device".to_string(),
            timestamp: created_at.clone(),
            session_id: Some(runtime_session_id.clone()),
            file_path: None,
            artifact_uri: Some(selected_artifact_id.clone()),
            summary: device_abi_evidence_summary(&abi_material, &constant_global_layout_hash),
            metadata: Some(abi_material),
        },
    ];

    if let Some(reason) = outcome.fallback_reason.as_deref() {
        let fallback_hash = sha256_hex_str(reason);
        evidence_refs.push(GpuHmrProofEvidenceRef {
            evidence_id: format!("evidence:device-fallback:{fallback_hash}"),
            kind: "device-fallback-reason".to_string(),
            content_hash: format!("sha256:{fallback_hash}"),
            producer_subsystem: "worker.compile_device".to_string(),
            timestamp: created_at.clone(),
            session_id: Some(runtime_session_id.clone()),
            file_path: None,
            artifact_uri: Some(selected_artifact_id.clone()),
            summary: reason.to_string(),
            metadata: None,
        });
    }

    let generated_fission = if fission_verifier_report_from_sidecar(sidecar_meta).is_none() {
        partial_fission_candidate_and_evidence(
            outcome,
            sources,
            &created_at,
            &runtime_session_id,
            &source_edit_id,
            &selected_artifact_id,
            &artifact_hash,
            &compiler_evidence_id,
            &symbol_evidence_id,
            &abi_evidence_id,
            &transport_evidence_id,
        )
    } else {
        None
    };
    if let Some((_, evidence)) = generated_fission.as_ref() {
        evidence_refs.push(evidence.clone());
    }
    let fission_report = fission_verifier_report_from_sidecar(sidecar_meta).or_else(|| {
        generated_fission
            .as_ref()
            .map(|(candidate, _)| verify_fission_candidates(&serde_json::Value::Array(vec![candidate.clone()])))
    });
    let fission_stage = fission_report.map(|report| {
        let (evidence, stage) = fission_verifier_evidence_and_stage(
            &report,
            &created_at,
            &runtime_session_id,
            &source_edit_id,
            &selected_artifact_id,
        );
        evidence_refs.push(evidence);
        stage
    });
    let symbol_bound = artifact_exports_expected_device_symbols(outcome);
    let mut stage_results = device_hmr_proof_stage_results(
        &created_at,
        &source_edit_id,
        &selected_artifact_id,
        &artifact_evidence_id,
        &transport_evidence_id,
        &compiler_evidence_id,
        &symbol_evidence_id,
        &abi_evidence_id,
        abi_stage_proven,
        abi_stage_degraded_reason,
        symbol_bound,
        proof,
    );
    if let Some(fission_stage) = fission_stage {
        stage_results.insert(0, fission_stage);
    }

    let artifact = GpuHmrProofArtifact::new(GpuHmrProofArtifactInput {
        workspace_slug,
        runtime_session_id,
        source_edit_id,
        selected_artifact_id,
        result_state: proof.result_state.clone(),
        degraded_state: proof.degraded_state.clone(),
        degraded_reason: proof.degraded_reason.clone(),
        stage_results,
        evidence_refs,
        visual_evidence_refs: Vec::new(),
        created_at: Some(created_at),
    });

    write_proof_artifact(workspace, &artifact).await
}

fn device_reload_kernel_symbols(source: &str, outcome: &DeviceCompileOutcome) -> Vec<String> {
    if outcome.partial_module && !outcome.target_symbols.is_empty() {
        return normalized_symbol_set(&outcome.target_symbols)
            .into_iter()
            .collect();
    }

    let source_symbols = extract_device_kernel_symbols(source);
    if !source_symbols.is_empty() {
        return source_symbols;
    }

    let artifact_symbols = normalized_symbol_set(&outcome.artifact_exported_symbols)
        .into_iter()
        .collect::<Vec<_>>();
    if !artifact_symbols.is_empty() {
        return artifact_symbols;
    }

    normalized_symbol_set(&outcome.target_symbols)
        .into_iter()
        .collect()
}

fn device_reload_kernel_symbol_specs(source: &str, outcome: &DeviceCompileOutcome) -> Vec<String> {
    let logical_symbols = device_reload_kernel_symbols(source, outcome);
    if !outcome.partial_module {
        return logical_symbols;
    }

    logical_symbols
        .into_iter()
        .map(|logical| {
            device_driver_symbol_for_logical_symbol(&logical, &outcome.artifact_exported_symbols)
                .filter(|driver| driver != &logical)
                .map(|driver| format!("{logical}={driver}"))
                .unwrap_or(logical)
        })
        .collect()
}

fn device_driver_symbol_for_logical_symbol(
    logical_symbol: &str,
    exported_symbols: &[String],
) -> Option<String> {
    let matches = normalized_symbol_set(exported_symbols)
        .into_iter()
        .filter(|exported| {
            exported == logical_symbol
                || exported_symbol_source_identity_candidates(exported)
                    .iter()
                    .any(|candidate| candidate == logical_symbol)
        })
        .collect::<Vec<_>>();
    (matches.len() == 1).then(|| matches[0].clone())
}

fn encode_gpu_kernel_command_token(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'$' | b'?' | b'@')
        {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn encode_gpu_kernel_command_specs(symbol_specs: &[String]) -> String {
    if symbol_specs.is_empty() {
        return "-".to_string();
    }
    symbol_specs
        .iter()
        .map(|spec| {
            spec.split_once('=')
                .map(|(logical, driver)| {
                    format!(
                        "{}={}",
                        encode_gpu_kernel_command_token(logical),
                        encode_gpu_kernel_command_token(driver)
                    )
                })
                .unwrap_or_else(|| encode_gpu_kernel_command_token(spec))
        })
        .collect::<Vec<_>>()
        .join(",")
}

async fn send_active_runner_runtime_command(
    ctx: &CompileContext,
    session_id: &str,
    command: &str,
    label: &str,
) -> Result<bool> {
    let (stdin_arc, mut output_rx) = {
        let mut guard = ctx.runner_store.lock().await;
        let Some(state) = guard.as_mut() else {
            return Ok(false);
        };
        if state.session_id.as_deref() != Some(session_id) {
            return Ok(false);
        }
        let runner_alive = if let Some(child) = state.process.as_mut() {
            matches!(child.try_wait(), Ok(None))
        } else {
            false
        };
        if !runner_alive {
            return Ok(false);
        }
        (state.stdin.clone(), state.output_tx.subscribe())
    };

    let Some(stdin_arc) = stdin_arc else {
        return Ok(false);
    };

    let token = format!(
        "runner-control-{}",
        RUNNER_RUNTIME_CONTROL_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let expected_status = runner_runtime_control_ack_status(command)
        .context("runner runtime command does not have an acknowledgement contract")?;
    let mut stdin = stdin_arc.lock().await;
    let line = format!("{command} {token}\n");
    if let Err(e) = stdin.write_all(line.as_bytes()).await {
        eprintln!("[compile-device] runner {label} command failed: {e}");
        anyhow::bail!("runner {label} command write failed: {e}");
    }
    if let Err(e) = stdin.flush().await {
        eprintln!("[compile-device] runner {label} flush failed: {e}");
        anyhow::bail!("runner {label} command flush failed: {e}");
    }
    eprintln!("[compile-device] runner {label} command sent: {command}");
    let timeout = runner_runtime_control_ack_timeout();
    if wait_for_runner_runtime_control_ack(&mut output_rx, expected_status, &token, timeout).await {
        Ok(true)
    } else {
        anyhow::bail!(
            "runner {label} command did not acknowledge {expected_status} within {}ms",
            timeout.as_millis()
        );
    }
}

fn runner_runtime_control_ack_status(command: &str) -> Option<&'static str> {
    match command {
        "synthi_pause_runtime" | "pause_runtime" => Some("runtime-paused"),
        "synthi_resume_runtime" | "resume_runtime" => Some("runtime-resumed"),
        _ => None,
    }
}

fn runner_runtime_control_ack_timeout() -> std::time::Duration {
    let ms = std::env::var("SYNTHI_GPU_HMR_RUNTIME_CONTROL_ACK_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_RUNNER_RUNTIME_CONTROL_ACK_TIMEOUT_MS);
    std::time::Duration::from_millis(ms)
}

fn extract_runner_structured_payload(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Some(trimmed);
    }

    const PREFIX: &str = "[Runner] [HMR-STATUS] ";
    line.find(PREFIX).map(|idx| &line[idx + PREFIX.len()..])
}

fn runner_runtime_control_ack_matches(line: &str, expected_status: &str, token: &str) -> bool {
    let Some(payload) = extract_runner_structured_payload(line) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
        return false;
    };
    value.get("status").and_then(serde_json::Value::as_str) == Some(expected_status)
        && value
            .get("runtimeControlToken")
            .and_then(serde_json::Value::as_str)
            == Some(token)
}

async fn wait_for_runner_runtime_control_ack(
    output_rx: &mut tokio::sync::broadcast::Receiver<String>,
    expected_status: &str,
    token: &str,
    timeout: std::time::Duration,
) -> bool {
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return false,
            received = output_rx.recv() => {
                match received {
                    Ok(line) if runner_runtime_control_ack_matches(&line, expected_status, token) => return true,
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return false,
                }
            }
        }
    }
}

async fn subscribe_active_runner_output(
    ctx: &CompileContext,
    session_id: &str,
) -> Option<tokio::sync::broadcast::Receiver<String>> {
    let guard = ctx.runner_store.lock().await;
    let state = guard.as_ref()?;
    if state.session_id.as_deref() != Some(session_id) {
        return None;
    }
    Some(state.output_tx.subscribe())
}

fn runner_device_sidecar_status(line: &str) -> Option<Result<(), String>> {
    let payload = extract_runner_structured_payload(line)?;
    let value = serde_json::from_str::<serde_json::Value>(payload).ok()?;
    if value.get("module").and_then(serde_json::Value::as_str) != Some("device") {
        return None;
    }

    match value.get("status").and_then(serde_json::Value::as_str)? {
        "applied" => Some(Ok(())),
        "rejected" | "compile_error" | "crash-fatal" => {
            let reason = value
                .get("reason")
                .or_else(|| value.get("error"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("device sidecar reload rejected by runner")
                .to_string();
            Some(Err(reason))
        }
        _ => None,
    }
}

fn runner_device_sidecar_ack_timeout() -> std::time::Duration {
    let ms = std::env::var("SYNTHI_GPU_HMR_DEVICE_RELOAD_ACK_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_RUNNER_RUNTIME_CONTROL_ACK_TIMEOUT_MS);
    std::time::Duration::from_millis(ms)
}

async fn wait_for_runner_device_sidecar_status(
    output_rx: &mut tokio::sync::broadcast::Receiver<String>,
) -> Result<()> {
    let timeout = runner_device_sidecar_ack_timeout();
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => {
                anyhow::bail!(
                    "runner device sidecar reload did not acknowledge terminal device HMR status within {}ms",
                    timeout.as_millis()
                );
            }
            received = output_rx.recv() => {
                match received {
                    Ok(line) => {
                        if let Some(status) = runner_device_sidecar_status(&line) {
                            return status.map_err(anyhow::Error::msg);
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        anyhow::bail!("runner output channel closed before device sidecar reload status");
                    }
                }
            }
        }
    }
}

async fn compile_device_sources_phase0_and_refresh_catalog(
    ctx: &CompileContext,
    req: &CompileRequest,
    output_dir: &Path,
    timestamp: i64,
    sources: &DeviceCompileSources,
    manifest: &CompileManifest,
    sidecar_path: &Path,
    session_id: &str,
    allow_direct_translation_unit_partial: bool,
    defer_runtime_resume: bool,
) -> Result<(Option<DeviceCompileOutcome>, bool)> {
    let workspace_path = ctx.workspace_path.as_path();
    let runtime_paused =
        match send_active_runner_runtime_command(ctx, session_id, "synthi_pause_runtime", "pause")
            .await
        {
            Ok(paused) => paused,
            Err(error) => {
                let status = HmrStatus::gpu_rejected_with_fallback_reason(
                    "device",
                    &format!("Runner did not acknowledge runtime pause before GPU HMR: {error}"),
                    "Keep previous GPU sidecar loaded",
                    "runtime.pause_not_acknowledged",
                );
                let _ = ctx.log_dc.send_text(status.to_json()).await;
                return Err(error.context("runner runtime pause was not acknowledged"));
            }
        };
    let device_result = compile_device_sources_phase0(
        workspace_path,
        output_dir,
        timestamp,
        sources,
        manifest,
        allow_direct_translation_unit_partial,
        runtime_paused,
    )
    .await;
    let device = match device_result {
        Ok(device) => device,
        Err(error) => {
            if runtime_paused {
                let _ = resume_active_runner_after_gpu_hmr(ctx, session_id).await;
            }
            return Err(error);
        }
    };

    let catalog_result: Result<()> = async {
        if let (Some(outcome), Some(partial_filename)) =
            (device.as_ref(), sources.partial_filename.as_deref())
        {
            if outcome.partial_module {
                refresh_device_partial_artifact_catalog(
                    sidecar_path,
                    partial_filename,
                    &outcome.compiled_source,
                    &outcome.target_symbols,
                    sources.full_filename.as_deref(),
                    sources.partial_artifact_kind.as_deref(),
                    &sources.partial_source_paths,
                    session_id,
                )
                .await?;
            }
        }
        if let Some(outcome) = device.as_ref() {
            if !outcome.partial_module {
                if let Some(full_filename) = sources.full_filename.as_deref() {
                    if outcome.compiled_source != sources.full_source {
                        let updated = update_ai_split_cache_role(
                            req,
                            "device",
                            full_filename,
                            outcome.compiled_source.clone(),
                        )
                        .await;
                        if updated {
                            eprintln!(
                                "[compile-device] split cache updated with verified healed device role file={} bytes={}",
                                full_filename,
                                outcome.compiled_source.len()
                            );
                        }
                    }
                    materialize_device_partial_artifacts(
                        workspace_path,
                        sidecar_path,
                        full_filename,
                        &outcome.compiled_source,
                        session_id,
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }
    .await;
    if let Err(error) = catalog_result {
        if runtime_paused {
            let _ = resume_active_runner_after_gpu_hmr(ctx, session_id).await;
        }
        return Err(error);
    }

    let runtime_resume_deferred = runtime_paused && defer_runtime_resume && device.is_some();
    if runtime_resume_deferred {
        eprintln!(
            "[compile-device] runner resume deferred until GPU sidecar reload command is dispatched"
        );
    }
    if runtime_paused && !runtime_resume_deferred {
        resume_active_runner_after_gpu_hmr(ctx, session_id).await?;
    }
    Ok((device, runtime_resume_deferred))
}

async fn resume_active_runner_after_gpu_hmr(ctx: &CompileContext, session_id: &str) -> Result<()> {
    if let Err(error) =
        send_active_runner_runtime_command(ctx, session_id, "synthi_resume_runtime", "resume").await
    {
        let status = HmrStatus::gpu_rejected_with_fallback_reason(
            "device",
            &format!("Runner did not acknowledge runtime resume after GPU HMR: {error}"),
            "Restart or reload the preview before applying another GPU HMR patch",
            "runtime.resume_not_acknowledged",
        );
        let _ = ctx.log_dc.send_text(status.to_json()).await;
        return Err(error.context("runner runtime resume was not acknowledged"));
    }
    Ok(())
}

fn is_gpu_device_reload_marker(name: &str) -> bool {
    name.starts_with("__gpu_device:") || name.starts_with("__gpu_device_partial:")
}

fn is_device_sidecar_only_reload(modules_to_load: &[(String, String)]) -> bool {
    !modules_to_load.is_empty()
        && modules_to_load
            .iter()
            .all(|(name, _)| is_gpu_device_reload_marker(name))
}

fn is_device_source_request(filename: &str) -> bool {
    normalized_request_filename(filename)
        .map(|name| {
            let lower = name.to_ascii_lowercase();
            lower.ends_with(".cu") || lower.ends_with(".hip")
        })
        .unwrap_or(false)
}

fn prefer_deterministic_gpu_edit(
    is_adapted: bool,
    prefer_gpu_pipeline: bool,
    filename: &str,
    force_gpu_ai_delta: bool,
) -> bool {
    is_adapted
        && prefer_gpu_pipeline
        && !force_gpu_ai_delta
        && (is_device_source_request(filename) || is_device_header_request(filename))
}

fn classifier_failure_count_for_request(
    consecutive_failures: u32,
    prefer_deterministic_gpu_edit: bool,
) -> u32 {
    if prefer_deterministic_gpu_edit {
        0
    } else {
        consecutive_failures
    }
}

fn sidecar_string_for_path(
    sidecar: &serde_json::Value,
    object_key: &str,
    path: &str,
) -> Option<String> {
    let normalized = normalized_request_filename(path).unwrap_or_else(|| path.replace('\\', "/"));
    sidecar
        .get(object_key)
        .and_then(|v| v.as_object())
        .and_then(|m| {
            m.get(&normalized).or_else(|| m.get(path)).or_else(|| {
                m.iter()
                    .find(|(candidate, _)| {
                        normalized_request_filename(candidate).as_deref()
                            == Some(normalized.as_str())
                    })
                    .map(|(_, value)| value)
            })
        })
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn ai_delta_reload_plan_report(
    plan: &str,
    user_path: &str,
    generated_path: Option<&str>,
    reason_codes: Vec<String>,
) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": RELOAD_PLAN_SCHEMA_VERSION,
        "plan": plan,
        "reasonCodes": reason_codes,
        "fallbacksAvailable": ["warm_rebuild", "ai_delta", "full_resplit", "cold_restart"],
        "affectedUserFiles": [user_path],
        "affectedGeneratedRoles": generated_path.map(|p| vec![p.to_string()]).unwrap_or_default(),
        "timingsMs": {},
    })
}

fn gpu_ai_delta_rejection_reports(
    requested_plan: &str,
    user_path: &str,
    generated_path: &str,
    signature_before: &str,
    signature_after: &str,
    layout_before: &str,
    layout_after: &str,
) -> (serde_json::Value, serde_json::Value, Vec<String>) {
    let signature_changed = signature_before != signature_after;
    let layout_changed = layout_before != layout_after;
    let mut reason_codes = vec!["verifier.ai_delta_rejected".to_string()];
    if signature_changed {
        reason_codes.push("abi.kernel_signature_changed".to_string());
    }
    if layout_changed {
        reason_codes.push("abi.constant_global_layout_changed".to_string());
    }
    if reason_codes.len() == 1 {
        reason_codes.push("verifier.ai_delta_unsafe".to_string());
    }

    let plan_report = ai_delta_reload_plan_report(
        "abi_breaking",
        user_path,
        Some(generated_path),
        reason_codes.clone(),
    );
    let verifier_report = serde_json::json!({
        "schemaVersion": "synthi.gpu.ai_delta_verifier.v1",
        "status": "reject",
        "requestedReloadPlan": requested_plan,
        "selectedFallback": "abi_breaking",
        "reasonCodes": reason_codes,
        "userFile": user_path,
        "generatedRole": generated_path,
        "evidence": {
            "kernelSignature": {
                "changed": signature_changed,
                "before": signature_before,
                "after": signature_after
            },
            "constantGlobalLayout": {
                "changed": layout_changed,
                "before": layout_before,
                "after": layout_after
            }
        }
    });
    (plan_report, verifier_report, reason_codes)
}

fn gpu_ai_delta_policy_rejection_reports(
    requested_plan: &str,
    user_path: &str,
    generated_path: &str,
    policy_reasons: Vec<String>,
    touched_roles: Vec<String>,
) -> (serde_json::Value, serde_json::Value, Vec<String>) {
    let mut reason_codes = vec!["verifier.ai_delta_rejected".to_string()];
    for reason in policy_reasons {
        if !reason_codes.iter().any(|existing| existing == &reason) {
            reason_codes.push(reason);
        }
    }

    let plan_report = ai_delta_reload_plan_report(
        "unsupported",
        user_path,
        Some(generated_path),
        reason_codes.clone(),
    );
    let verifier_report = serde_json::json!({
        "schemaVersion": "synthi.gpu.ai_delta_verifier.v1",
        "status": "reject",
        "requestedReloadPlan": requested_plan,
        "selectedFallback": "unsupported",
        "reasonCodes": reason_codes,
        "userFile": user_path,
        "generatedRole": generated_path,
        "evidence": {
            "touchedGeneratedRoles": touched_roles
        }
    });
    (plan_report, verifier_report, reason_codes)
}

fn gpu_ai_delta_touched_roles(edits: &[crate::hmr::edit_applier::Edit]) -> Vec<String> {
    let mut roles = std::collections::BTreeSet::new();
    for edit in edits {
        roles.insert(edit.module.clone());
    }
    roles.into_iter().collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GeneratedRoleIncludeViolation {
    role: String,
    include_path: String,
}

fn normalize_generated_include_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let mut parts: Vec<String> = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if parts.last().is_some_and(|last| last != "..") {
                parts.pop();
            } else {
                parts.push(part.to_string());
            }
            continue;
        }
        parts.push(part.to_string());
    }
    parts.join("/")
}

fn basename(path: &str) -> String {
    normalize_generated_include_path(path)
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

fn role_dir(path: &str) -> String {
    normalize_generated_include_path(path)
        .rsplit_once('/')
        .map(|(dir, _)| dir.to_string())
        .unwrap_or_default()
}

fn quoted_include_from_line(line: &str) -> Option<String> {
    let after_hash = line.trim_start().strip_prefix('#')?.trim_start();
    let after_include = after_hash.strip_prefix("include")?;
    let rest = after_include.trim_start();
    let quoted = rest.strip_prefix('"')?;
    let end = quoted.find('"')?;
    Some(quoted[..end].trim().to_string())
}

fn generated_role_include_policy_violations(
    roles: &[(&str, &str, &str)],
) -> Vec<GeneratedRoleIncludeViolation> {
    let mut allowed = std::collections::BTreeSet::new();
    allowed.insert("synthi_gpu_runtime.h".to_string());
    for (_, path, _) in roles {
        let normalized = normalize_generated_include_path(path);
        if !normalized.is_empty() {
            allowed.insert(normalized.clone());
            allowed.insert(basename(&normalized));
        }
    }

    let mut violations = Vec::new();
    for (role, path, source) in roles {
        let dir = role_dir(path);
        for line in source.lines() {
            let Some(included) = quoted_include_from_line(line) else {
                continue;
            };
            let normalized = normalize_generated_include_path(&included);
            let base = basename(&normalized);
            let resolved = if dir.is_empty() {
                normalized.clone()
            } else {
                normalize_generated_include_path(&format!("{}/{}", dir, included))
            };
            if allowed.contains(&normalized)
                || allowed.contains(&base)
                || allowed.contains(&resolved)
            {
                continue;
            }
            violations.push(GeneratedRoleIncludeViolation {
                role: (*role).to_string(),
                include_path: included,
            });
        }
    }
    violations
}

fn format_generated_role_include_violations(
    violations: &[GeneratedRoleIncludeViolation],
) -> String {
    violations
        .iter()
        .map(|v| format!("{} includes {:?}", v.role, v.include_path))
        .collect::<Vec<_>>()
        .join("; ")
}

#[derive(Debug, Clone)]
struct WarmRebuildDecision {
    accepted: bool,
    reload_plan: serde_json::Value,
    verifier_report: serde_json::Value,
    reason_codes: Vec<String>,
    generated_device_path: Option<String>,
    affected_symbols: Vec<String>,
    affected_source_paths: Vec<String>,
}

fn is_device_header_request(filename: &str) -> bool {
    normalized_request_filename(filename)
        .map(|name| {
            let lower = name.to_ascii_lowercase();
            [".cuh", ".h", ".hh", ".hpp", ".hxx"]
                .iter()
                .any(|suffix| lower.ends_with(suffix))
        })
        .unwrap_or(false)
}

fn sidecar_array_contains_path(sidecar: &serde_json::Value, pointer: &str, path: &str) -> bool {
    let normalized = normalized_request_filename(path).unwrap_or_else(|| path.replace('\\', "/"));
    sidecar
        .pointer(pointer)
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items.iter().any(|item| {
                item.as_str()
                    .map(|candidate| {
                        normalized_request_filename(candidate).as_deref()
                            == Some(normalized.as_str())
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn template_evidence_mentions_source(sidecar: &serde_json::Value, path: &str) -> bool {
    let normalized = normalized_request_filename(path).unwrap_or_else(|| path.replace('\\', "/"));
    sidecar
        .get("affectedTemplateInstantiations")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries.iter().any(|entry| {
                entry
                    .get("sourceHeaders")
                    .and_then(serde_json::Value::as_array)
                    .map(|headers| {
                        headers.iter().any(|header| {
                            header
                                .as_str()
                                .map(|candidate| {
                                    normalized_request_filename(candidate).as_deref()
                                        == Some(normalized.as_str())
                                })
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn kernel_symbol_from_signature(signature: &str) -> Option<String> {
    let head = signature.split('(').next()?.trim();
    let token = head.split_whitespace().last()?.trim();
    let name = token.rsplit("::").next().unwrap_or(token).trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn template_rebuild_impacts(sidecar: &serde_json::Value, path: &str) -> (Vec<String>, Vec<String>) {
    let normalized = normalized_request_filename(path).unwrap_or_else(|| path.replace('\\', "/"));
    let mut symbols = BTreeSet::new();
    let mut source_paths = BTreeSet::new();
    let Some(entries) = sidecar
        .get("affectedTemplateInstantiations")
        .and_then(serde_json::Value::as_array)
    else {
        return (Vec::new(), Vec::new());
    };

    for entry in entries {
        let mentions_header = entry
            .get("sourceHeaders")
            .and_then(serde_json::Value::as_array)
            .map(|headers| {
                headers.iter().any(|header| {
                    header
                        .as_str()
                        .and_then(normalized_request_filename)
                        .as_deref()
                        == Some(normalized.as_str())
                })
            })
            .unwrap_or(false);
        if !mentions_header {
            continue;
        }
        if let Some(symbol) = entry
            .get("reachableFromKernel")
            .and_then(serde_json::Value::as_str)
            .and_then(kernel_symbol_from_signature)
        {
            symbols.insert(symbol);
        }
        if let Some(path) = entry
            .get("owningTU")
            .and_then(serde_json::Value::as_str)
            .and_then(normalized_request_filename)
        {
            source_paths.insert(path);
        }
    }

    (
        symbols.into_iter().collect(),
        source_paths.into_iter().collect(),
    )
}

fn device_include_graph_mentions_source(sidecar: &serde_json::Value, path: &str) -> bool {
    sidecar_array_contains_path(sidecar, "/affectedHeaderGraph/reachableHeaders", path)
        || sidecar_array_contains_path(
            sidecar,
            "/deviceMappingReport/deviceIncludeGraph/reachableHeaders",
            path,
        )
        || sidecar_array_contains_path(
            sidecar,
            "/deviceMappingReport/deviceIncludeGraph/deviceTranslationUnits",
            path,
        )
        || sidecar_array_contains_path(
            sidecar,
            "/deviceMappingReport/deviceIncludeGraph/generatedDeviceIncludes",
            path,
        )
        || template_evidence_mentions_source(sidecar, path)
}

fn include_bridge_kernel_source_paths(
    sidecar: &serde_json::Value,
    target_path: &str,
) -> (Vec<String>, Vec<String>) {
    let target =
        normalized_request_filename(target_path).unwrap_or_else(|| target_path.replace('\\', "/"));
    let mut targets = BTreeSet::new();
    let mut omitted = BTreeSet::new();

    for pointer in ["/deviceMappings", "/deviceMappingReport/deviceMappings"] {
        let Some(items) = sidecar
            .pointer(pointer)
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        for item in items {
            if item.get("kind").and_then(serde_json::Value::as_str) != Some("kernel") {
                continue;
            }
            let include_bridge_mapping = item
                .get("generatedMappingMode")
                .and_then(serde_json::Value::as_str)
                == Some("source_include_bridge")
                || item
                    .get("mappingConfidence")
                    .and_then(serde_json::Value::as_str)
                    == Some("generated_include_bridge_same_source");
            if !include_bridge_mapping {
                continue;
            }
            let Some(source_path) = item
                .get("sourcePath")
                .and_then(serde_json::Value::as_str)
                .and_then(normalized_request_filename)
            else {
                continue;
            };
            if source_path == target {
                targets.insert(source_path);
            } else {
                omitted.insert(source_path);
            }
        }
    }

    (targets.into_iter().collect(), omitted.into_iter().collect())
}

fn device_partial_artifact_specs(
    sidecar: &serde_json::Value,
    generated_path: &str,
    full_source: &str,
    workspace: Option<&Path>,
) -> Vec<DevicePartialArtifactSpec> {
    let mut specs =
        include_bridge_partial_artifact_specs(sidecar, generated_path, full_source, workspace);
    specs.extend(source_backed_translation_unit_partial_artifact_specs(
        sidecar,
        generated_path,
    ));
    specs.extend(direct_kernel_partial_artifact_specs(
        generated_path,
        full_source,
    ));
    specs.sort_by(|a, b| a.filename.cmp(&b.filename));
    specs.dedup_by(|a, b| a.filename == b.filename);
    specs
}

fn source_backed_translation_unit_partial_artifact_specs(
    sidecar: &serde_json::Value,
    generated_path: &str,
) -> Vec<DevicePartialArtifactSpec> {
    let generated = normalized_request_filename(generated_path)
        .unwrap_or_else(|| generated_path.replace('\\', "/"));
    let mut by_source: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut confidence_by_source: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for pointer in ["/deviceMappings", "/deviceMappingReport/deviceMappings"] {
        let Some(items) = sidecar
            .pointer(pointer)
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        for item in items {
            if item.get("kind").and_then(serde_json::Value::as_str) != Some("kernel") {
                continue;
            }
            let Some(mapping_generated) = item
                .get("generatedPath")
                .and_then(serde_json::Value::as_str)
                .and_then(normalized_request_filename)
            else {
                continue;
            };
            if mapping_generated != generated {
                continue;
            }
            let Some(source_path) = item
                .get("sourcePath")
                .and_then(serde_json::Value::as_str)
                .and_then(normalized_request_filename)
            else {
                continue;
            };
            if source_path == generated || !is_device_translation_unit_path(&source_path) {
                continue;
            }
            let Some(symbol) = item
                .get("symbol")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            by_source
                .entry(source_path.clone())
                .or_default()
                .insert(symbol.to_string());
            if let Some(confidence) = string_field(item, "mappingConfidence") {
                confidence_by_source
                    .entry(source_path)
                    .or_default()
                    .insert(confidence);
            }
        }
    }

    by_source
        .into_iter()
        .filter_map(|(source_path, symbols)| {
            let source_paths = vec![source_path.clone()];
            let content = build_source_include_partial_source(&source_paths)?;
            let symbols = symbols.into_iter().collect::<Vec<_>>();
            let filename = partial_device_filename(&generated, &symbols, &content);
            Some(DevicePartialArtifactSpec {
                filename,
                content,
                kind: "source_include_bridge",
                generated_path: generated.clone(),
                source_paths,
                symbols,
                omitted_source_includes: Vec::new(),
                mapping_confidence: confidence_by_source.remove(&source_path).and_then(|items| {
                    match items.len() {
                        0 => None,
                        1 => items.into_iter().next(),
                        _ => Some("mixed".to_string()),
                    }
                }),
            })
        })
        .collect()
}

fn is_device_translation_unit_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".cu") || lower.ends_with(".hip")
}

fn include_bridge_partial_artifact_specs(
    sidecar: &serde_json::Value,
    generated_path: &str,
    full_source: &str,
    workspace: Option<&Path>,
) -> Vec<DevicePartialArtifactSpec> {
    let generated = normalized_request_filename(generated_path)
        .unwrap_or_else(|| generated_path.replace('\\', "/"));
    let mut by_source: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut confidence_by_source: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for pointer in ["/deviceMappings", "/deviceMappingReport/deviceMappings"] {
        let Some(items) = sidecar
            .pointer(pointer)
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        for item in items {
            if item.get("kind").and_then(serde_json::Value::as_str) != Some("kernel") {
                continue;
            }
            let include_bridge_mapping = item
                .get("generatedMappingMode")
                .and_then(serde_json::Value::as_str)
                == Some("source_include_bridge")
                || item
                    .get("mappingConfidence")
                    .and_then(serde_json::Value::as_str)
                    == Some("generated_include_bridge_same_source");
            if !include_bridge_mapping {
                continue;
            }
            let Some(mapping_generated) = item
                .get("generatedPath")
                .and_then(serde_json::Value::as_str)
                .and_then(normalized_request_filename)
            else {
                continue;
            };
            if mapping_generated != generated {
                continue;
            }
            let Some(source_path) = item
                .get("sourcePath")
                .and_then(serde_json::Value::as_str)
                .and_then(normalized_request_filename)
            else {
                continue;
            };
            let Some(symbol) = item
                .get("symbol")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            by_source
                .entry(source_path.clone())
                .or_default()
                .insert(symbol.to_string());
            if let Some(confidence) = string_field(item, "mappingConfidence") {
                confidence_by_source
                    .entry(source_path)
                    .or_default()
                    .insert(confidence);
            }
        }
    }

    if by_source.is_empty() {
        return Vec::new();
    }

    let all_sources = by_source.keys().cloned().collect::<BTreeSet<_>>();
    let mut specs = Vec::new();
    for (source_path, symbols) in by_source {
        let omitted = all_sources
            .iter()
            .filter(|path| *path != &source_path)
            .cloned()
            .collect::<Vec<_>>();
        let target_paths = vec![source_path.clone()];
        let content = build_contextual_source_include_partial_source(
            workspace,
            sidecar,
            generated_path,
            full_source,
            &target_paths,
            &omitted,
        )
        .or_else(|| build_source_include_partial_source(&target_paths))
        .or_else(|| {
            build_device_include_bridge_partial_source(full_source, &target_paths, &omitted)
        });
        let Some(content) = content else { continue };
        let symbols = symbols.into_iter().collect::<Vec<_>>();
        let filename = partial_device_filename(&generated, &symbols, &content);
        specs.push(DevicePartialArtifactSpec {
            filename,
            content,
            kind: "source_include_bridge",
            generated_path: generated.clone(),
            source_paths: target_paths,
            symbols,
            omitted_source_includes: omitted,
            mapping_confidence: confidence_by_source.remove(&source_path).and_then(|items| {
                match items.len() {
                    0 => None,
                    1 => items.into_iter().next(),
                    _ => Some("mixed".to_string()),
                }
            }),
        });
    }
    specs
}

fn direct_kernel_partial_artifact_specs(
    generated_path: &str,
    full_source: &str,
) -> Vec<DevicePartialArtifactSpec> {
    let symbols = extract_device_kernel_symbols(full_source)
        .into_iter()
        .collect::<BTreeSet<_>>();
    if symbols.len() <= 1 {
        return Vec::new();
    }

    let generated = normalized_request_filename(generated_path)
        .unwrap_or_else(|| generated_path.replace('\\', "/"));
    symbols
        .into_iter()
        .filter_map(|symbol| {
            let target = vec![symbol.clone()];
            let content = build_device_partial_source(full_source, &target)?;
            let filename = partial_device_filename(&generated, &target, &content);
            Some(DevicePartialArtifactSpec {
                filename,
                content,
                kind: "kernel_region",
                generated_path: generated.clone(),
                source_paths: vec![generated.clone()],
                symbols: target,
                omitted_source_includes: Vec::new(),
                mapping_confidence: None,
            })
        })
        .collect()
}

async fn materialize_device_partial_artifacts(
    workspace: &Path,
    sidecar_path: &Path,
    generated_path: &str,
    full_source: &str,
    session_id: &str,
) -> Result<()> {
    let raw = match tokio::fs::read_to_string(sidecar_path).await {
        Ok(raw) => raw,
        Err(_) => return Ok(()),
    };
    let mut meta = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(meta) => meta,
        Err(e) => {
            eprintln!(
                "[compile-device] partial artifact catalog skipped: sidecar parse failed: {e}"
            );
            return Ok(());
        }
    };
    let specs = device_partial_artifact_specs(&meta, generated_path, full_source, Some(workspace));
    if specs.is_empty() {
        return Ok(());
    }

    let total = specs.len();
    let mut artifacts = Vec::new();
    for spec in specs.iter().take(MAX_DEVICE_PARTIAL_ARTIFACTS) {
        write_compile_request_file(workspace, &spec.filename, &spec.content).await?;
        artifacts.push(serde_json::json!({
            "kind": spec.kind,
            "filename": spec.filename,
            "generatedPath": spec.generated_path,
            "sourcePaths": spec.source_paths,
            "symbols": spec.symbols,
            "omittedSourceIncludes": spec.omitted_source_includes,
            "contentBytes": spec.content.len(),
            "fullBytes": full_source.len(),
            "contentHash": format!("{}", hash_content(&spec.content)),
            "selectionReason": serde_json::Value::Null,
            "rejectionReason": serde_json::Value::Null,
            "fallbackReason": serde_json::Value::Null,
            "mappingConfidence": spec.mapping_confidence,
            "verifierEvidenceId": serde_json::Value::Null,
            "dependencyHash": serde_json::Value::Null,
            "compileCommandHash": serde_json::Value::Null,
        }));
    }
    let materialized = artifacts.len();
    let report = serde_json::json!({
        "schemaVersion": "synthi.gpu.device_partial_artifacts.v1",
        "generatedPath": generated_path.replace('\\', "/"),
        "materialized": materialized,
        "candidateCount": total,
        "truncated": total > materialized,
        "maxArtifacts": MAX_DEVICE_PARTIAL_ARTIFACTS,
        "artifacts": artifacts,
    });

    if let Some(obj) = meta.as_object_mut() {
        obj.insert("devicePartialArtifacts".to_string(), report.clone());
        obj.insert("generatedDevicePartials".to_string(), report);
    }
    write_sidecar_logged(sidecar_path, &meta, session_id).await;
    eprintln!(
        "[compile-device] materialized partial device artifacts count={} candidates={} generated={}",
        materialized,
        total,
        generated_path
    );
    Ok(())
}

fn refresh_device_partial_artifact_catalog_value(
    meta: &mut serde_json::Value,
    filename: &str,
    source: &str,
    symbols: &[String],
    generated_path: Option<&str>,
    artifact_kind: Option<&str>,
    source_paths: &[String],
) -> bool {
    let normalized =
        normalized_request_filename(filename).unwrap_or_else(|| filename.replace('\\', "/"));
    let symbol_set = normalized_symbol_set(symbols);
    let generated = generated_path.and_then(normalized_request_filename);
    let mut updated = false;

    for report_key in ["devicePartialArtifacts", "generatedDevicePartials"] {
        let Some(artifacts) = meta
            .get_mut(report_key)
            .and_then(|report| report.get_mut("artifacts"))
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        let mut report_updated = false;
        let has_filename_match = artifacts.iter().any(|artifact| {
            artifact
                .get("filename")
                .and_then(serde_json::Value::as_str)
                .and_then(normalized_request_filename)
                .as_deref()
                == Some(normalized.as_str())
        });
        for artifact in &mut *artifacts {
            let artifact_name = artifact
                .get("filename")
                .and_then(serde_json::Value::as_str)
                .and_then(normalized_request_filename);
            let filename_matches = artifact_name.as_deref() == Some(normalized.as_str());
            let symbol_matches = if symbol_set.is_empty() {
                false
            } else {
                let artifact_symbols = string_array_field(artifact, "symbols");
                let artifact_generated = artifact
                    .get("generatedPath")
                    .and_then(serde_json::Value::as_str)
                    .and_then(normalized_request_filename);
                normalized_symbol_set(&artifact_symbols) == symbol_set
                    && generated
                        .as_deref()
                        .map(|expected| artifact_generated.as_deref() == Some(expected))
                        .unwrap_or(true)
            };
            if !filename_matches && (has_filename_match || !symbol_matches) {
                continue;
            }
            if let Some(obj) = artifact.as_object_mut() {
                obj.insert(
                    "filename".to_string(),
                    serde_json::Value::String(normalized.clone()),
                );
                obj.insert("contentBytes".to_string(), serde_json::json!(source.len()));
                obj.insert(
                    "contentHash".to_string(),
                    serde_json::Value::String(format!("{}", hash_content(source))),
                );
                obj.insert(
                    "contentSource".to_string(),
                    serde_json::Value::String("compiled_source".to_string()),
                );
                if let Some(kind) = artifact_kind.map(str::trim).filter(|kind| !kind.is_empty()) {
                    obj.insert(
                        "kind".to_string(),
                        serde_json::Value::String(kind.to_string()),
                    );
                }
                let normalized_source_paths = source_paths
                    .iter()
                    .filter_map(|path| normalized_request_filename(path))
                    .map(serde_json::Value::String)
                    .collect::<Vec<_>>();
                if !normalized_source_paths.is_empty() {
                    obj.insert(
                        "sourcePaths".to_string(),
                        serde_json::Value::Array(normalized_source_paths),
                    );
                }
                report_updated = true;
            }
        }
        if !report_updated && !symbol_set.is_empty() {
            let normalized_source_paths = source_paths
                .iter()
                .filter_map(|path| normalized_request_filename(path))
                .map(serde_json::Value::String)
                .collect::<Vec<_>>();
            let mut artifact = serde_json::json!({
                "filename": normalized.clone(),
                "symbols": symbols,
                "contentBytes": source.len(),
                "contentHash": format!("{}", hash_content(source)),
                "contentSource": "compiled_source",
                "kind": artifact_kind
                    .map(str::trim)
                    .filter(|kind| !kind.is_empty())
                    .unwrap_or("compiled_partial"),
                "sourcePaths": normalized_source_paths
            });
            if let (Some(obj), Some(generated)) = (artifact.as_object_mut(), generated.as_deref()) {
                obj.insert(
                    "generatedPath".to_string(),
                    serde_json::Value::String(generated.to_string()),
                );
            }
            artifacts.push(artifact);
            report_updated = true;
        }
        updated |= report_updated;
    }

    updated
}

async fn refresh_device_partial_artifact_catalog(
    sidecar_path: &Path,
    filename: &str,
    source: &str,
    symbols: &[String],
    generated_path: Option<&str>,
    artifact_kind: Option<&str>,
    source_paths: &[String],
    session_id: &str,
) -> Result<()> {
    let raw = match tokio::fs::read_to_string(sidecar_path).await {
        Ok(raw) => raw,
        Err(_) => return Ok(()),
    };
    let mut meta = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(meta) => meta,
        Err(e) => {
            eprintln!(
                "[compile-device] partial artifact catalog refresh skipped: sidecar parse failed: {e}"
            );
            return Ok(());
        }
    };
    if !refresh_device_partial_artifact_catalog_value(
        &mut meta,
        filename,
        source,
        symbols,
        generated_path,
        artifact_kind,
        source_paths,
    ) {
        return Ok(());
    }
    write_sidecar_logged(sidecar_path, &meta, session_id).await;
    eprintln!(
        "[compile-device] refreshed partial artifact catalog file={} bytes={} hash={}",
        filename,
        source.len(),
        hash_content(source)
    );
    Ok(())
}

fn ranked_option_reason_codes(sidecar: &serde_json::Value, plan: &str) -> Vec<String> {
    sidecar
        .get("rankedReloadOptions")
        .and_then(serde_json::Value::as_array)
        .and_then(|options| {
            options
                .iter()
                .find(|option| option.get("plan").and_then(serde_json::Value::as_str) == Some(plan))
        })
        .and_then(|option| option.get("reasonCodes"))
        .and_then(serde_json::Value::as_array)
        .map(|codes| {
            codes
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn ranked_option_estimate_ms(sidecar: &serde_json::Value, plan: &str) -> Option<u64> {
    sidecar
        .get("rankedReloadOptions")
        .and_then(serde_json::Value::as_array)
        .and_then(|options| {
            options
                .iter()
                .find(|option| option.get("plan").and_then(serde_json::Value::as_str) == Some(plan))
        })
        .and_then(|option| option.get("estimatedMs"))
        .and_then(serde_json::Value::as_u64)
}

fn warm_rebuild_reload_plan(
    plan: &str,
    user_path: &str,
    generated_path: Option<&str>,
    reason_codes: Vec<String>,
    estimated_ms: Option<u64>,
) -> serde_json::Value {
    let mut timings = serde_json::Map::new();
    if let Some(ms) = estimated_ms {
        timings.insert(
            "warmEstimate".to_string(),
            serde_json::Value::Number(ms.into()),
        );
    }
    serde_json::json!({
        "schemaVersion": RELOAD_PLAN_SCHEMA_VERSION,
        "plan": plan,
        "reasonCodes": reason_codes,
        "fallbacksAvailable": ["ai_delta", "full_resplit", "cold_restart"],
        "affectedUserFiles": [user_path],
        "affectedGeneratedRoles": generated_path.map(|p| vec![p.to_string()]).unwrap_or_default(),
        "timingsMs": serde_json::Value::Object(timings),
    })
}

fn warm_rebuild_verifier_report(
    status: &str,
    user_path: &str,
    generated_path: Option<&str>,
    reason_codes: &[String],
    normalized_candidate: &serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": "synthi.gpu.warm_rebuild_verifier.v1",
        "status": status,
        "userFile": user_path,
        "generatedRole": generated_path,
        "reasonCodes": reason_codes,
        "evidence": {
            "deviceIncludeGraphStatus": normalized_candidate
                .pointer("/affectedHeaderGraph/status")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            "templateEvidenceStatus": normalized_candidate
                .get("templateEvidenceStatus")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            "templateEvidenceBounded": normalized_candidate
                .get("templateEvidenceBounded")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            "templateEvidenceInvalidationReasons": normalized_candidate
                .get("templateEvidenceInvalidationReasons")
                .cloned()
                .unwrap_or_else(|| serde_json::Value::Array(Vec::new())),
            "affectedTemplateInstantiations": normalized_candidate
                .get("affectedTemplateInstantiations")
                .cloned()
                .unwrap_or_else(|| serde_json::Value::Array(Vec::new())),
            "arbiterDecision": normalized_candidate
                .get("arbiterDecision")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            "selectedPlan": normalized_candidate
                .get("selectedPlan")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            "rankedWarmRebuildReasonCodes": ranked_option_reason_codes(
                normalized_candidate,
                "warm_rebuild"
            ),
        }
    })
}

fn try_warm_rebuild_header_plan(
    sidecar_meta: &serde_json::Value,
    user_path: &str,
    old_source: &str,
    new_source: &str,
    generated_device_path: Option<&str>,
) -> Option<WarmRebuildDecision> {
    if !is_device_header_request(user_path) || old_source == new_source {
        return None;
    }

    let mut preflight_reasons = Vec::new();
    if !device_include_graph_mentions_source(sidecar_meta, user_path) {
        preflight_reasons.push("header_dependency_unbounded".to_string());
    }
    if generated_device_path.is_none() {
        preflight_reasons.push("mapping_missing".to_string());
    }
    let source_included_by_generated_role = sidecar_array_contains_path(
        sidecar_meta,
        "/deviceMappingReport/deviceIncludeGraph/generatedDeviceIncludes",
        user_path,
    );
    let body_only_kernel = if source_included_by_generated_role {
        device_header_kernel_body_only_edit_symbol(old_source, new_source)
    } else {
        None
    };

    let candidate_plan = warm_rebuild_reload_plan(
        "warm_rebuild",
        user_path,
        generated_device_path,
        vec![
            "edit.device_reachable_header".to_string(),
            "build.warm_rebuild_candidate".to_string(),
        ],
        None,
    );
    let mut candidate_meta = sidecar_meta.as_object().cloned().unwrap_or_default();
    candidate_meta.insert("lastReloadPlanReport".to_string(), candidate_plan);
    invalidate_derived_gpu_reports(&mut candidate_meta);
    let normalized_candidate = normalize_split_sidecar(&serde_json::Value::Object(candidate_meta));

    let arbiter_decision = normalized_candidate
        .get("arbiterDecision")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unsupported");
    let selected_plan = normalized_candidate
        .get("selectedPlan")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let ranked_warm_reasons = ranked_option_reason_codes(&normalized_candidate, "warm_rebuild");
    let non_template_warm_reasons: Vec<String> = ranked_warm_reasons
        .iter()
        .filter(|code| !code.starts_with("template_"))
        .cloned()
        .collect();
    let (template_symbols, template_source_paths) =
        template_rebuild_impacts(&normalized_candidate, user_path);
    let template_source_projection_available = source_included_by_generated_role
        || (!template_symbols.is_empty() && !template_source_paths.is_empty());
    let deterministic_body_rebuild = preflight_reasons.is_empty()
        && body_only_kernel.is_some()
        && non_template_warm_reasons.is_empty();
    let mut reason_codes = if deterministic_body_rebuild {
        vec![
            "edit.device_source_included_header".to_string(),
            "edit.header_kernel_body_only".to_string(),
            "abi.kernel_signature_preserved".to_string(),
            "abi.constant_global_layout_preserved".to_string(),
            "template_evidence_not_required".to_string(),
            "build.warm_rebuild".to_string(),
            "build.device_sidecar_rebuild".to_string(),
        ]
    } else if preflight_reasons.is_empty()
        && arbiter_decision == "auto_run"
        && selected_plan == "warm_rebuild"
        && template_source_projection_available
    {
        vec![
            "edit.device_reachable_header".to_string(),
            "template_evidence_fresh".to_string(),
            "template_instantiation_bounded".to_string(),
            "template_impact_projection_available".to_string(),
            "build.warm_rebuild".to_string(),
            "build.device_sidecar_rebuild".to_string(),
        ]
    } else {
        let mut reasons = preflight_reasons;
        reasons.extend(ranked_warm_reasons.clone());
        if arbiter_decision == "auto_run"
            && selected_plan == "warm_rebuild"
            && !template_source_projection_available
        {
            reasons.push("template_impact_projection_missing".to_string());
        }
        if arbiter_decision != "auto_run" {
            reasons.push("arbiter_path_not_worth_running".to_string());
        }
        reasons
    };
    reason_codes.sort_unstable();
    reason_codes.dedup();

    let accepted = reason_codes.iter().any(|code| code == "build.warm_rebuild")
        && (deterministic_body_rebuild
            || (arbiter_decision == "auto_run"
                && selected_plan == "warm_rebuild"
                && template_source_projection_available));
    let estimated_ms = ranked_option_estimate_ms(&normalized_candidate, "warm_rebuild");
    let plan = warm_rebuild_reload_plan(
        if accepted {
            "warm_rebuild"
        } else {
            "unsupported"
        },
        user_path,
        generated_device_path,
        reason_codes.clone(),
        estimated_ms,
    );
    let verifier = warm_rebuild_verifier_report(
        if accepted { "accept" } else { "reject" },
        user_path,
        generated_device_path,
        &reason_codes,
        &normalized_candidate,
    );

    Some(WarmRebuildDecision {
        accepted,
        reload_plan: plan,
        verifier_report: verifier,
        reason_codes,
        generated_device_path: generated_device_path.map(str::to_string),
        affected_symbols: body_only_kernel
            .into_iter()
            .chain(template_symbols)
            .collect(),
        affected_source_paths: template_source_paths,
    })
}

fn device_fast_path_rejection_blocks_fallback(reason_codes: &[String]) -> bool {
    reason_codes.iter().any(|code| {
        matches!(
            code.as_str(),
            "abi.kernel_signature_changed"
                | "abi.constant_global_layout_changed"
                | "toolchain_capability_missing"
                | "toolchain_capability_stale"
                | "toolchain_capability_no_device_only_reload"
                | "fast_path_policy_blocks_device_only"
                | "stale_launch_pointer_detected"
                | "stale_launch_pointer_check_missing"
                | "launch_indirection_unverified"
                | "multi_device_tu_requires_topology_verification"
                | "gpu_device_tainted"
                | "gpu_driver_tdr"
                | "vram_session_refresh_required"
                | "vram_fragmented"
        )
    })
}

fn device_fast_path_missing_toolchain_allows_split_bootstrap(
    sidecar_meta: &serde_json::Value,
    request_path: &str,
    generated_device_path: Option<&str>,
    reason_codes: &[String],
) -> bool {
    if !reason_codes
        .iter()
        .any(|code| code == "toolchain_capability_missing")
    {
        return false;
    }
    if generated_device_path
        .map(str::trim)
        .is_some_and(|path| !path.is_empty())
    {
        return false;
    }
    let request_name = normalized_request_filename(request_path)
        .unwrap_or_else(|| request_path.replace('\\', "/"));
    sidecar_string_for_path(sidecar_meta, "sourceBaselineContents", &request_name).is_none()
        && sidecar_meta
            .get("original_source")
            .and_then(serde_json::Value::as_str)
            .is_none()
}

fn upsert_object_field(
    root: &mut serde_json::Map<String, serde_json::Value>,
    object_key: &str,
    field_key: &str,
    value: serde_json::Value,
) {
    let entry = root
        .entry(object_key.to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !entry.is_object() {
        *entry = serde_json::Value::Object(serde_json::Map::new());
    }
    if let Some(map) = entry.as_object_mut() {
        map.insert(field_key.to_string(), value);
    }
}

fn upsert_device_mapping_report_field(
    root: &mut serde_json::Map<String, serde_json::Value>,
    object_key: &str,
    field_key: &str,
    value: serde_json::Value,
) {
    let report = root
        .entry("deviceMappingReport".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !report.is_object() {
        *report = serde_json::json!({});
    }
    if let Some(report_obj) = report.as_object_mut() {
        let entry = report_obj
            .entry(object_key.to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if !entry.is_object() {
            *entry = serde_json::Value::Object(serde_json::Map::new());
        }
        if let Some(map) = entry.as_object_mut() {
            map.insert(field_key.to_string(), value);
        }
    }
}

fn invalidate_derived_gpu_reports(root: &mut serde_json::Map<String, serde_json::Value>) {
    for key in [
        "arbiterDecision",
        "selectedPlan",
        "arbiterReasonCodes",
        "rankedReloadOptions",
        "consentRequired",
        "consentReason",
        "fissionVerifierReport",
        "runReport",
    ] {
        root.remove(key);
    }
}

const GPU_HOST_CONTRACT_REQUIRED_SYMBOLS: &[&str] = &[
    "device_descriptor",
    "device_on_load",
    "device_kernel_sig_hash",
];

const GPU_HOST_CONTRACT_STATE_SYMBOLS: &[&str] = &["device_save_size", "device_save_write"];

fn missing_gpu_host_contract_symbols(exported_symbols: &[String]) -> Vec<&'static str> {
    GPU_HOST_CONTRACT_REQUIRED_SYMBOLS
        .iter()
        .copied()
        .filter(|required| !exported_symbols.iter().any(|symbol| symbol == required))
        .collect()
}

fn has_gpu_state_serialization_symbols(exported_symbols: &[String]) -> bool {
    GPU_HOST_CONTRACT_STATE_SYMBOLS
        .iter()
        .all(|required| exported_symbols.iter().any(|symbol| symbol == required))
}

pub async fn handle_compile_request(
    ctx: &CompileContext,
    mut req: CompileRequest,
    session_id: String,
) -> Result<serde_json::Value> {
    // ── Language dispatch: route non-C++ languages to dedicated pipelines ──
    if req.language == "java" {
        return crate::compiler::java::handler::handle_java_request(ctx, req, session_id).await;
    }

    let compile_start = std::time::Instant::now();

    // Directory setup
    let output_dir = ctx.workspace_path.join("build");
    if !output_dir.exists() {
        tokio::fs::create_dir_all(&output_dir).await?;
    }

    let ext = "so";

    // Manual logging instead of record_step for now
    debug_log!("[Compile] Step: Handler started");

    let file_ref_summary = hydrate_workspace_file_refs(&ctx.workspace_path, &mut req).await?;
    if file_ref_summary.count > 0 {
        eprintln!(
            "[Compile] hydrated workspace file refs: count={} bytes={}",
            file_ref_summary.count, file_ref_summary.bytes
        );
    }
    sync_compile_request_workspace(ctx, &req).await?;

    // ============================================================
    // HMR PIPELINE: Initialize and classify compile loop
    // ============================================================
    let language = req.language.as_str();
    let (rollout_flags, consecutive_failures) = {
        let mut orchestrator = ctx.hmr_orchestrator.lock().await;
        let pipeline = orchestrator.pipeline(&session_id);
        pipeline.ensure_adapter(language);
        (
            pipeline.rollout_flags.clone(),
            pipeline.consecutive_failures,
        )
    };

    // ── Compute source hash ──
    let source_hash_value = hash_content(&req.source);
    let source_hash_str = format!("{}", source_hash_value);

    let sidecar_path = ctx.workspace_path.join(".synthi_split_meta.json");
    let active_runner_session = {
        let guard = ctx.runner_store.lock().await;
        guard.as_ref().and_then(|state| state.session_id.clone())
    };
    purge_stale_split_state_for_session(
        &ctx.workspace_path,
        &sidecar_path,
        &session_id,
        active_runner_session,
    )
    .await?;

    // ── Detect adapted-project status ──
    let mut adapted_status = detect_adapted_project(&ctx.workspace_path);

    // Try to read persisted split hash from sidecar
    let request_compile_manifest = req
        .compile_manifest
        .as_ref()
        .and_then(|v| if v.is_null() { None } else { Some(v) })
        .and_then(CompileManifest::from_json_value);
    if adapted_status.is_adapted {
        if let Ok(meta_raw) = tokio::fs::read_to_string(&sidecar_path).await {
            if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_raw) {
                if let Some(h) = meta.get("split_hash").and_then(|v| v.as_str()) {
                    adapted_status = adapted_status.with_split_hash(h.to_string());
                }
            }
        }
    }

    // ── Build LoopClassifierInput with rich context ──
    let prefer_deterministic_gpu_edit_flag = prefer_deterministic_gpu_edit(
        adapted_status.is_adapted,
        req.prefer_gpu_pipeline,
        &req.filename,
        req.force_gpu_ai_delta,
    );
    let classifier_user_requested_ai = req.user_requested_ai && !prefer_deterministic_gpu_edit_flag;
    let classifier_consecutive_failures = classifier_failure_count_for_request(
        consecutive_failures,
        prefer_deterministic_gpu_edit_flag,
    );

    let classifier_input = LoopClassifierInput {
        adapted_status: &adapted_status,
        current_source_hash: Some(&source_hash_str),
        rollout_flags: &rollout_flags,
        consecutive_failures: classifier_consecutive_failures,
        failure_rescue_threshold: 2,
        user_requested_ai: classifier_user_requested_ai,
        user_requested_deterministic: req.user_requested_deterministic,
    };

    let classification = classify_loop(&classifier_input);
    let compile_loop = classification.loop_type;

    // ── Build CompileEnrichment ──
    let enrichment = CompileEnrichment::from_classification(
        classification.clone(),
        adapted_status.clone(),
        Some(source_hash_str.clone()),
    );

    // Unconditional log of the classify decision + its inputs. This exists
    // because we've had cases where an HMR edit unexpectedly took the
    // `AiBypassResult::Proceed` branch (full AI split) instead of
    // `FallbackDeterministic` (Tier 2 diff_patch). Without seeing the
    // classifier's inputs live, we're guessing at why. The line is noisy
    // but fires once per compile request, which is fine.
    eprintln!(
        "[HMR] classify_loop → {:?} (reason={:?}) inputs: is_adapted={} split_hash={:?} src_hash={} consec_fail={} effective_consec_fail={} prefer_det_gpu={} user_ai={} effective_user_ai={} user_det={} lang={}",
        compile_loop,
        classification.reason,
        adapted_status.is_adapted,
        adapted_status.split_hash,
        source_hash_str,
        consecutive_failures,
        classifier_consecutive_failures,
        prefer_deterministic_gpu_edit_flag,
        req.user_requested_ai,
        classifier_user_requested_ai,
        req.user_requested_deterministic,
        language
    );

    // ── AI bypass gate ──
    let split_cache = SplitCache::new(64);
    let ai_bypass_result = {
        let mut orchestrator = ctx.hmr_orchestrator.lock().await;
        let pipeline = orchestrator.pipeline(&session_id);
        check_ai_bypass(
            &pipeline.ai_gate,
            &split_cache,
            compile_loop,
            &source_hash_str,
        )
    };

    // ============================================================
    // PHASE 1: AI SPLIT & PROCESSING (routed through ai_bypass)
    // ============================================================

    // ULTRAPLAN Lightning Phase 11 — Tier 0 v2 state.
    // `tier0_v2_eligible`: tree-sitter AST classifier confirmed value-only
    // `tier0_old_source`: baseline source for the v2 classifier at bypass time
    // Both populated inside FallbackDeterministic when classify_edit says value-only.
    let mut tier0_v2_eligible = false;
    let mut tier0_old_source: Option<String> = None;

    let split_data = match ai_bypass_result {
        AiBypassResult::Proceed => {
            // Loop B: AI call allowed — perform the split
            debug_log!("[HMR] AI bypass: Proceed → calling perform_ai_split");
            let result = perform_ai_split(&req).await?;

            // Persist split freshness sidecar + original source + architecture
            // cache for diff-patching. The architecture is a markdown doc
            // emitted by the split model (may be an empty string if the model
            // forgot to emit the <synthi_arch_cache> block — fallback path
            // in Python will degrade to the generic diff_patch prompt).
            let architecture_md = result
                .get("_synthi_architecture")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            // ULTRAPLAN Phase 3: persist the AI-synthesised compile manifest
            // alongside the architecture. On Tier 2/3 the FallbackDeterministic
            // branch reads it back from the sidecar. `null` is the "no manifest
            // in this response" sentinel; downstream uses a generic fallback
            // and does not infer framework link flags.
            let manifest_json = result
                .get("_synthi_manifest")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let cache_report = result
                .get("_synthi_cache_report")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let agentic_report = split_agentic_report(&result);
            let generated_report = generated_artifact_report(&result);
            let mapping_report = device_mapping_report(&result);
            let source_report = source_context_report(&result);
            let launch_report = launch_indirection_report(&result);
            let meta = serde_json::json!({
                "split_hash": source_hash_str,
                "original_source": req.source,
                "architecture": architecture_md,
                "compile_manifest": manifest_json,
                "cache_report": cache_report,
                "agentic_report": agentic_report,
                "generated_artifact_report": generated_report,
                "device_mapping_report": mapping_report,
                "source_context_report": source_report,
                "launch_indirection_report": launch_report,
            });
            write_sidecar_logged(&sidecar_path, &meta, &session_id).await;

            // Cache the result for future Loop A lookups
            split_cache.put(crate::hmr::ai_bypass::CachedSplitResult {
                source_hash: source_hash_str.clone(),
                core_code: result
                    .get("core")
                    .and_then(|c| c["content"].as_str())
                    .unwrap_or("")
                    .to_string(),
                gui_code: result
                    .get("gui")
                    .and_then(|g| g["content"].as_str())
                    .unwrap_or("")
                    .to_string(),
                shared_code: result
                    .get("shared")
                    .and_then(|s| s["content"].as_str())
                    .map(|s| s.to_string()),
                language: req.language.clone(),
                cached_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            });

            result
        }
        AiBypassResult::UseCached(cached) => {
            // Loop A with cached split: reuse previous AI result
            debug_log!("[HMR] AI bypass: UseCached → reusing cached split");
            serde_json::json!({
                "shared": { "content": cached.shared_code.unwrap_or_default(), "filename": "shared.h" },
                "core": { "content": cached.core_code, "filename": "core.cpp" },
                "gui": { "content": cached.gui_code, "filename": "gui.cpp" }
            })
        }
        AiBypassResult::FallbackDeterministic => {
            // Loop A, no cache: read existing adapted files from disk.
            let shared_filename = adapted_module_filename(
                &enrichment.adapted_status,
                &ctx.workspace_path,
                ModuleKind::Shared,
                "shared.h",
            );
            let core_filename = adapted_module_filename(
                &enrichment.adapted_status,
                &ctx.workspace_path,
                ModuleKind::Core,
                "core.cpp",
            );
            let gui_filename = adapted_module_filename(
                &enrichment.adapted_status,
                &ctx.workspace_path,
                ModuleKind::Gui,
                "gui.cpp",
            );
            let host_runner_filename = adapted_module_filename(
                &enrichment.adapted_status,
                &ctx.workspace_path,
                ModuleKind::HostRunner,
                HOST_RUNNER_FILENAME,
            );
            let is_editing_split_file = is_editing_adapted_module_or_device(
                &req.filename,
                &enrichment.adapted_status,
                &ctx.workspace_path,
                request_compile_manifest.as_ref(),
            );

            // Always read the current split files from disk
            let core_content = if let Some(ref p) = enrichment.adapted_status.core_path {
                tokio::fs::read_to_string(p).await.unwrap_or_default()
            } else {
                String::new()
            };
            let gui_content = if let Some(ref p) = enrichment.adapted_status.gui_path {
                tokio::fs::read_to_string(p).await.unwrap_or_default()
            } else {
                String::new()
            };
            let shared_content = if let Some(ref p) = enrichment.adapted_status.shared_path {
                tokio::fs::read_to_string(p).await.unwrap_or_default()
            } else {
                String::new()
            };
            // ULTRAPLAN Phase 5: read host_runner.cpp as a 4th edit target
            // for Tier 2 diff_patch. Empty string when the project is a
            // pre-Phase-4 3-file project (host_runner_path is None) — the
            // diff_patch prompt builder skips the host_runner block in
            // that case so the prompt stays small.
            let host_runner_content =
                if let Some(ref p) = enrichment.adapted_status.host_runner_path {
                    tokio::fs::read_to_string(p).await.unwrap_or_default()
                } else {
                    String::new()
                };

            if enrichment.adapted_status.is_adapted && is_editing_split_file {
                // User is editing a split file directly — syncFile already
                // wrote the new content to disk.  Just use it.
                debug_log!(
                    "[HMR] FallbackDeterministic → split file edit ({})",
                    req.filename
                );
                let mut split_payload = serde_json::json!({
                    "shared": { "content": shared_content, "filename": shared_filename },
                    "core": { "content": core_content, "filename": core_filename },
                    "gui": { "content": gui_content, "filename": gui_filename }
                });
                if req.prefer_gpu_pipeline && is_device_source_request(&req.filename) {
                    if let Some(obj) = split_payload.as_object_mut() {
                        obj.insert(
                            "_synthi_reload_plan".to_string(),
                            direct_device_split_file_reload_plan(&req.filename),
                        );
                    }
                }
                split_payload
            } else if enrichment.adapted_status.is_adapted {
                // User is editing original source (main.cpp).  Diff-patch the
                // changes into the split files without re-running AI.
                //
                // Read the original source saved at AI-split time.  Diff it
                // against the user's new source, then transplant each changed
                // line into the right split file (core/gui/shared).
                // Read `original_source` (diff baseline), `architecture`
                // (cached split doc — may be empty on pre-migration sidecars),
                // and `compile_manifest` (AI-synthesised build recipe from the
                // universal split prompt — may be null on pre-Phase-3 sidecars,
                // in which case downstream uses a generic fallback) from
                // the same sidecar file in one pass.
                let (sidecar_meta, original_source, architecture_md, sidecar_manifest_json) = {
                    if let Ok(meta_raw) = tokio::fs::read_to_string(&sidecar_path).await {
                        match serde_json::from_str::<serde_json::Value>(&meta_raw) {
                            Ok(meta) => {
                                let normalized_meta = normalize_split_sidecar(&meta);
                                let src = normalized_meta
                                    .get("original_source")
                                    .and_then(|s| s.as_str())
                                    .map(|s| s.to_string());
                                let arch = normalized_meta
                                    .get("architecture")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let manifest = normalized_meta
                                    .get("compile_manifest")
                                    .cloned()
                                    .unwrap_or(serde_json::Value::Null);
                                (normalized_meta, src, arch, manifest)
                            }
                            Err(_) => (
                                serde_json::Value::Null,
                                None,
                                String::new(),
                                serde_json::Value::Null,
                            ),
                        }
                    } else {
                        (
                            serde_json::Value::Null,
                            None,
                            String::new(),
                            serde_json::Value::Null,
                        )
                    }
                };
                // Log what came back so the user can verify the cache is
                // round-tripping: the Proceed branch's "sidecar written: ...
                // arch=NNNN chars" should match this read's "arch=NNNN chars".
                eprintln!(
                    "[HMR] sidecar read: {} (original_source={}, arch={} chars, compile_manifest={})",
                    sidecar_path.display(),
                    if original_source.is_some() { "yes" } else { "no" },
                    architecture_md.len(),
                    if sidecar_manifest_json.is_null() { "no" } else { "yes" },
                );

                let mut natural_gpu_ai_delta_reason_codes: Vec<String> = Vec::new();
                let direct_device_split = if (is_device_source_request(&req.filename)
                    || is_device_header_request(&req.filename))
                    && !req.force_gpu_ai_delta
                {
                    let request_device_name = normalized_request_filename(&req.filename)
                        .unwrap_or_else(|| req.filename.replace('\\', "/"));
                    let generated_device_path =
                        mapped_generated_device_path(&sidecar_meta, &request_device_name)
                            .or_else(|| mapped_generated_device_path(&sidecar_meta, &req.filename));
                    let generated_device_source =
                        if let Some(path) = generated_device_path.as_deref() {
                            match compile_request_relpath(path) {
                                Ok(rel) => tokio::fs::read_to_string(ctx.workspace_path.join(rel))
                                    .await
                                    .unwrap_or_default(),
                                Err(e) => {
                                    eprintln!(
                                    "[gpu-hmr] device fast path: generated role path rejected: {}",
                                    e
                                );
                                    String::new()
                                }
                            }
                        } else {
                            String::new()
                        };
                    let device_patch = try_direct_device_body_patch(
                        &sidecar_meta,
                        &request_device_name,
                        &req.source,
                        &generated_device_source,
                    );
                    if device_patch.accepted {
                        let generated_path = device_patch
                            .generated_path
                            .clone()
                            .or(generated_device_path)
                            .ok_or_else(|| {
                                anyhow::anyhow!(
                                    "GPU device fast path accepted without a generated device path"
                                )
                            })?;
                        let patched_device_source =
                            device_patch.patched_device_source.clone().ok_or_else(|| {
                                anyhow::anyhow!(
                                    "GPU device fast path accepted without patched source"
                                )
                            })?;
                        write_compile_request_file(
                            &ctx.workspace_path,
                            &generated_path,
                            &patched_device_source,
                        )
                        .await?;

                        let mut meta = sidecar_meta.as_object().cloned().unwrap_or_default();
                        let baseline_hash = device_source_hash(&req.source);
                        upsert_object_field(
                            &mut meta,
                            "sourceBaselineContents",
                            &request_device_name,
                            serde_json::Value::String(req.source.clone()),
                        );
                        upsert_object_field(
                            &mut meta,
                            "sourceBaselineHashes",
                            &request_device_name,
                            serde_json::Value::String(baseline_hash.clone()),
                        );
                        upsert_device_mapping_report_field(
                            &mut meta,
                            "sourceBaselineContents",
                            &request_device_name,
                            serde_json::Value::String(req.source.clone()),
                        );
                        upsert_device_mapping_report_field(
                            &mut meta,
                            "sourceBaselineHashes",
                            &request_device_name,
                            serde_json::Value::String(baseline_hash.clone()),
                        );
                        meta.insert(
                            "lastReloadPlanReport".to_string(),
                            device_patch.reload_plan.clone(),
                        );
                        meta.insert(
                            "lastDeviceFastPathReport".to_string(),
                            device_patch.reload_plan.clone(),
                        );
                        meta.insert(
                            "lastDeviceFastPathVerifierReport".to_string(),
                            device_patch.verifier_report.clone(),
                        );
                        meta.insert(
                            "patchTier".to_string(),
                            serde_json::Value::String("device_only".to_string()),
                        );
                        meta.insert(
                            "cacheReport".to_string(),
                            serde_json::json!({
                                "splitCacheHit": false,
                                "splitCacheReason": "not_applicable_device_only_fast_path",
                                "splitCacheKey": format!("device:{}:{}", request_device_name, baseline_hash),
                            }),
                        );
                        invalidate_derived_gpu_reports(&mut meta);
                        write_sidecar_logged(
                            &sidecar_path,
                            &serde_json::Value::Object(meta),
                            &session_id,
                        )
                        .await;
                        eprintln!(
                            "[gpu-hmr] device_only fast path accepted: user={} generated={} reasons={}",
                            request_device_name,
                            generated_path,
                            device_patch.reason_codes.join(",")
                        );
                        let partial_selection_report = select_device_partial_artifact_with_report(
                            &sidecar_meta,
                            &generated_path,
                            Some(&request_device_name),
                            &device_patch.affected_symbols,
                        );
                        let partial_device_payload = if let Some(selection) =
                            partial_selection_report.selected
                        {
                            if let Some(previous_partial_source) =
                                read_selected_device_partial_artifact(&ctx.workspace_path, &selection)
                                    .await?
                            {
                                if selection.kind == "source_include_bridge"
                                    && selection.source_path_match
                                {
                                    let partial_filename = partial_device_filename(
                                        &generated_path,
                                        &device_patch.affected_symbols,
                                        &previous_partial_source,
                                    );
                                    eprintln!(
                                        "[gpu-hmr] device_only source bridge partial selected: source_file={} file={} bytes={} full_bytes={} symbols={} kind={}",
                                        selection.filename,
                                        partial_filename,
                                        previous_partial_source.len(),
                                        patched_device_source.len(),
                                        device_patch.affected_symbols.join(","),
                                        selection.kind
                                    );
                                    Some(serde_json::json!({
                                        "content": previous_partial_source,
                                        "filename": selection.filename.clone(),
                                        "symbols": selection.symbols.clone(),
                                        "source": "devicePartialArtifacts",
                                        "artifactFilename": selection.filename.clone(),
                                        "artifactKind": selection.kind.clone(),
                                        "sourcePaths": selection.source_paths.clone(),
                                        "selectionReason": selection.selection_reason.clone(),
                                        "mappingConfidence": selection.mapping_confidence.clone(),
                                        "dependencyHash": selection.dependency_hash.clone(),
                                        "compileCommandHash": selection.compile_command_hash.clone(),
                                        "verifierEvidenceId": selection.verifier_evidence_id.clone(),
                                        "requirePartial": true,
                                    }))
                                } else {
                                    let partial_patch = try_direct_device_body_patch(
                                        &sidecar_meta,
                                        &request_device_name,
                                        &req.source,
                                        &previous_partial_source,
                                    );
                                    if partial_patch.accepted
                                        && normalized_symbol_set(&partial_patch.affected_symbols)
                                            == normalized_symbol_set(&device_patch.affected_symbols)
                                    {
                                        let reload_symbols =
                                            selected_partial_reload_symbols(&selection);
                                        partial_patch.patched_device_source.map(|partial_source| {
                                            let partial_filename = partial_device_filename(
                                                &generated_path,
                                                &reload_symbols,
                                                &partial_source,
                                            );
                                            eprintln!(
                                                "[gpu-hmr] device_only partial artifact patched: source_file={} file={} bytes={} full_bytes={} edited_symbols={} reload_symbols={} kind={}",
                                                selection.filename,
                                                partial_filename,
                                                partial_source.len(),
                                                patched_device_source.len(),
                                                device_patch.affected_symbols.join(","),
                                                reload_symbols.join(","),
                                                selection.kind
                                            );
                                            serde_json::json!({
                                                "content": partial_source,
                                                "filename": partial_filename,
                                                "symbols": reload_symbols,
                                                "source": "devicePartialArtifacts",
                                                "artifactFilename": selection.filename,
                                                "artifactKind": selection.kind,
                                                "sourcePaths": selection.source_paths,
                                                "selectionReason": selection.selection_reason,
                                                "mappingConfidence": selection.mapping_confidence,
                                                "dependencyHash": selection.dependency_hash,
                                                "compileCommandHash": selection.compile_command_hash,
                                                "verifierEvidenceId": selection.verifier_evidence_id,
                                                "requirePartial": true,
                                            })
                                        })
                                    } else {
                                        eprintln!(
                                            "[gpu-hmr] device_only partial artifact patch rejected: file={} reasons={}",
                                            selection.filename,
                                            partial_patch.reason_codes.join(",")
                                        );
                                        None
                                    }
                                }
                            } else {
                                None
                            }
                        } else {
                            if let Some(reason) = partial_selection_report.rejection_reason.as_deref()
                            {
                                eprintln!(
                                    "[gpu-hmr] device_only partial artifact selection rejected: generated={} user={} symbols={} reason={}",
                                    generated_path,
                                    request_device_name,
                                    device_patch.affected_symbols.join(","),
                                    reason
                                );
                            }
                            None
                        }
                        .or_else(|| {
                            build_device_partial_source(
                                &patched_device_source,
                                &device_patch.affected_symbols,
                            )
                            .map(|partial_source| {
                                let partial_filename = partial_device_filename(
                                    &generated_path,
                                    &device_patch.affected_symbols,
                                    &partial_source,
                                );
                                eprintln!(
                                    "[gpu-hmr] device_only partial source prepared: file={} bytes={} full_bytes={} symbols={}",
                                    partial_filename,
                                    partial_source.len(),
                                    patched_device_source.len(),
                                    device_patch.affected_symbols.join(",")
                                );
                                serde_json::json!({
                                    "content": partial_source,
                                    "filename": partial_filename,
                                            "symbols": device_patch.affected_symbols.clone(),
                                            "source": "generatedBodyPartial",
                                            "artifactKind": "kernel_region",
                                            "selectionReason": "generated_body_partial",
                                            "fallbackReason": "partial_catalog_selection_unavailable",
                                            "requirePartial": true,
                                        })
                                    })
                                });
                        let partial_device_payload = partial_device_payload.or_else(|| {
                            single_translation_unit_partial_payload(
                                &generated_path,
                                &patched_device_source,
                                &device_mapping_symbols_for_generated(
                                    &sidecar_meta,
                                    &generated_path,
                                ),
                                &device_patch.affected_symbols,
                            )
                        });
                        let mut split_payload = serde_json::json!({
                            "shared": { "content": shared_content, "filename": shared_filename },
                            "core": { "content": core_content, "filename": core_filename },
                            "gui": { "content": gui_content, "filename": gui_filename },
                            "host_runner": { "content": host_runner_content, "filename": host_runner_filename },
                            "device": { "content": patched_device_source, "filename": generated_path },
                            "_synthi_manifest": sidecar_manifest_json.clone(),
                            "_synthi_reload_plan": device_patch.reload_plan.clone(),
                        });
                        if let (Some(obj), Some(partial)) =
                            (split_payload.as_object_mut(), partial_device_payload)
                        {
                            obj.insert("_synthi_device_partial".to_string(), partial);
                        }
                        Some(split_payload)
                    } else {
                        let mut meta = sidecar_meta.as_object().cloned().unwrap_or_default();
                        meta.insert(
                            "lastReloadPlanReport".to_string(),
                            device_patch.reload_plan.clone(),
                        );
                        meta.insert(
                            "lastDeviceFastPathReport".to_string(),
                            device_patch.reload_plan.clone(),
                        );
                        meta.insert(
                            "lastDeviceFastPathVerifierReport".to_string(),
                            device_patch.verifier_report.clone(),
                        );
                        meta.insert(
                            "patchTier".to_string(),
                            serde_json::Value::String("device_only_rejected".to_string()),
                        );
                        invalidate_derived_gpu_reports(&mut meta);
                        write_sidecar_logged(
                            &sidecar_path,
                            &serde_json::Value::Object(meta),
                            &session_id,
                        )
                        .await;
                        eprintln!(
                            "[gpu-hmr] device_only fast path rejected: user={} reasons={}",
                            request_device_name,
                            device_patch.reason_codes.join(",")
                        );
                        let split_bootstrap_allowed =
                            device_fast_path_missing_toolchain_allows_split_bootstrap(
                                &sidecar_meta,
                                &request_device_name,
                                generated_device_path.as_deref(),
                                &device_patch.reason_codes,
                            );
                        if device_fast_path_rejection_blocks_fallback(&device_patch.reason_codes)
                            && !split_bootstrap_allowed
                        {
                            eprintln!(
                                "[gpu-hmr] device_only hard stop: user={} reasons={}",
                                request_device_name,
                                device_patch.reason_codes.join(",")
                            );
                            anyhow::bail!(
                                "GPU device-only reload rejected before fallback: reason_codes={}",
                                device_patch.reason_codes.join(",")
                            );
                        }
                        if split_bootstrap_allowed {
                            eprintln!(
                                "[gpu-hmr] device_only bootstrap fallback allowed: user={} reasons={}",
                                request_device_name,
                                device_patch.reason_codes.join(",")
                            );
                        } else {
                            natural_gpu_ai_delta_reason_codes = device_patch.reason_codes.clone();
                        }
                        None
                    }
                } else {
                    None
                };

                if let Some(split) = direct_device_split {
                    split
                } else if let Some(split) = 'warm_candidate: {
                    let request_name = normalized_request_filename(&req.filename)
                        .unwrap_or_else(|| req.filename.replace('\\', "/"));
                    let old_source = sidecar_string_for_path(
                        &sidecar_meta,
                        "sourceBaselineContents",
                        &request_name,
                    );
                    if req.force_gpu_ai_delta || old_source.is_none() {
                        None
                    } else {
                        let generated_device_path =
                            mapped_generated_device_path(&sidecar_meta, &request_name).or_else(
                                || {
                                    CompileManifest::from_json_value(&sidecar_manifest_json)
                                        .and_then(|manifest| {
                                            manifest
                                                .device_source_filename()
                                                .map(|s| s.replace('\\', "/"))
                                        })
                                },
                            );
                        let Some(warm) = try_warm_rebuild_header_plan(
                            &sidecar_meta,
                            &request_name,
                            old_source.as_deref().unwrap_or_default(),
                            &req.source,
                            generated_device_path.as_deref(),
                        ) else {
                            break 'warm_candidate None;
                        };

                        let mut meta = sidecar_meta.as_object().cloned().unwrap_or_default();
                        meta.insert("lastReloadPlanReport".to_string(), warm.reload_plan.clone());
                        meta.insert(
                            "lastWarmRebuildVerifierReport".to_string(),
                            warm.verifier_report.clone(),
                        );
                        meta.insert(
                            "patchTier".to_string(),
                            serde_json::Value::String(if warm.accepted {
                                "warm_rebuild".to_string()
                            } else {
                                "warm_rebuild_rejected".to_string()
                            }),
                        );

                        if warm.accepted {
                            let baseline_hash = device_source_hash(&req.source);
                            upsert_object_field(
                                &mut meta,
                                "sourceBaselineContents",
                                &request_name,
                                serde_json::Value::String(req.source.clone()),
                            );
                            upsert_object_field(
                                &mut meta,
                                "sourceBaselineHashes",
                                &request_name,
                                serde_json::Value::String(baseline_hash.clone()),
                            );
                            upsert_device_mapping_report_field(
                                &mut meta,
                                "sourceBaselineContents",
                                &request_name,
                                serde_json::Value::String(req.source.clone()),
                            );
                            upsert_device_mapping_report_field(
                                &mut meta,
                                "sourceBaselineHashes",
                                &request_name,
                                serde_json::Value::String(baseline_hash.clone()),
                            );
                            meta.insert(
                                "cacheReport".to_string(),
                                serde_json::json!({
                                    "splitCacheHit": false,
                                    "splitCacheReason": "not_applicable_warm_rebuild",
                                    "splitCacheKey": format!("warm:{}:{}", request_name, baseline_hash),
                                }),
                            );
                            meta.entry("warmPathBudgetResult".to_string())
                                .or_insert_with(|| {
                                    serde_json::Value::String("within_budget".to_string())
                                });
                        }

                        invalidate_derived_gpu_reports(&mut meta);
                        write_sidecar_logged(
                            &sidecar_path,
                            &serde_json::Value::Object(meta),
                            &session_id,
                        )
                        .await;

                        if !warm.accepted {
                            eprintln!(
                                "[gpu-hmr] warm_rebuild rejected: user={} reasons={}",
                                request_name,
                                warm.reason_codes.join(",")
                            );
                            anyhow::bail!(
                                "GPU warm rebuild rejected before fallback: reason_codes={}",
                                warm.reason_codes.join(",")
                            );
                        }

                        let generated_path = warm.generated_device_path.ok_or_else(|| {
                            anyhow::anyhow!(
                                "GPU warm rebuild accepted without a generated device path"
                            )
                        })?;
                        let generated_device_source = {
                            let rel = compile_request_relpath(&generated_path)?;
                            tokio::fs::read_to_string(ctx.workspace_path.join(rel))
                                .await
                                .with_context(|| {
                                    format!(
                                        "reading generated device role {} for GPU warm rebuild",
                                        generated_path
                                    )
                                })?
                        };
                        eprintln!(
                            "[gpu-hmr] warm_rebuild accepted: user={} generated={} reasons={}",
                            request_name,
                            generated_path,
                            warm.reason_codes.join(",")
                        );
                        let partial_device_payload = if warm.affected_symbols.is_empty() {
                            None
                        } else {
                            let source_bridge_payload = build_source_include_partial_source(
                                &warm.affected_source_paths,
                            )
                            .map(|partial_source| {
                                let partial_filename = partial_device_filename(
                                    &generated_path,
                                    &warm.affected_symbols,
                                    &partial_source,
                                );
                                eprintln!(
                                    "[gpu-hmr] warm_rebuild source bridge partial prepared: file={} bytes={} full_bytes={} symbols={} source_tus={}",
                                    partial_filename,
                                    partial_source.len(),
                                    generated_device_source.len(),
                                    warm.affected_symbols.join(","),
                                    warm.affected_source_paths.join(",")
                                );
                                serde_json::json!({
                                    "content": partial_source,
                                    "filename": partial_filename,
                                    "symbols": warm.affected_symbols.clone(),
                                    "source": "sourceIncludeBridge",
                                    "sourcePaths": warm.affected_source_paths.clone(),
                                    "artifactKind": "source_include_bridge",
                                    "requirePartial": true,
                                })
                            });
                            let catalog_payload = if source_bridge_payload.is_some() {
                                None
                            } else {
                                let selection_report = select_device_partial_artifact_with_report(
                                    &sidecar_meta,
                                    &generated_path,
                                    Some(&request_name),
                                    &warm.affected_symbols,
                                );
                                if let Some(selection) = selection_report.selected {
                                    if selection.kind == "source_include_bridge"
                                        && selection.source_path_match
                                    {
                                        read_selected_device_partial_artifact(
                                            &ctx.workspace_path,
                                            &selection,
                                        )
                                        .await?
                                        .map(|partial_source| {
                                            eprintln!(
                                                "[gpu-hmr] warm_rebuild partial artifact selected: file={} bytes={} full_bytes={} symbols={} kind={}",
                                                selection.filename,
                                                partial_source.len(),
                                                generated_device_source.len(),
                                                warm.affected_symbols.join(","),
                                                selection.kind
                                            );
                                            serde_json::json!({
                                                "content": partial_source,
                                                "filename": selection.filename.clone(),
                                                "symbols": selection.symbols.clone(),
                                                "source": "devicePartialArtifacts",
                                                "artifactFilename": selection.filename,
                                                "artifactKind": selection.kind,
                                                "sourcePaths": selection.source_paths,
                                                "selectionReason": selection.selection_reason,
                                                "mappingConfidence": selection.mapping_confidence,
                                                "dependencyHash": selection.dependency_hash,
                                                "compileCommandHash": selection.compile_command_hash,
                                                "verifierEvidenceId": selection.verifier_evidence_id,
                                                "requirePartial": true,
                                            })
                                        })
                                    } else {
                                        eprintln!(
                                            "[gpu-hmr] warm_rebuild partial artifact skipped: file={} kind={} source_path_match={} reason=not_header_source_bridge",
                                            selection.filename,
                                            selection.kind,
                                            selection.source_path_match
                                        );
                                        None
                                    }
                                } else {
                                    if let Some(reason) =
                                        selection_report.rejection_reason.as_deref()
                                    {
                                        eprintln!(
                                            "[gpu-hmr] warm_rebuild partial artifact selection rejected: generated={} user={} symbols={} reason={}",
                                            generated_path,
                                            request_name,
                                            warm.affected_symbols.join(","),
                                            reason
                                        );
                                    }
                                    None
                                }
                            };
                            source_bridge_payload.or(catalog_payload).or_else(|| {
                                let (target_paths, omit_paths) =
                                    include_bridge_kernel_source_paths(&sidecar_meta, &request_name);
                                build_device_include_bridge_partial_source(
                                    &generated_device_source,
                                    &target_paths,
                                    &omit_paths,
                                )
                                .map(|partial_source| {
                                    let partial_filename = partial_device_filename(
                                        &generated_path,
                                        &warm.affected_symbols,
                                        &partial_source,
                                    );
                                    eprintln!(
                                        "[gpu-hmr] warm_rebuild partial source prepared: file={} bytes={} full_bytes={} symbols={} omitted_includes={}",
                                        partial_filename,
                                        partial_source.len(),
                                        generated_device_source.len(),
                                        warm.affected_symbols.join(","),
                                        omit_paths.len()
                                    );
                                    serde_json::json!({
                                        "content": partial_source,
                                        "filename": partial_filename,
                                        "symbols": warm.affected_symbols.clone(),
                                        "source": "sourceIncludeBridgeFallback",
                                        "artifactKind": "source_include_bridge",
                                        "fallbackReason": "partial_catalog_selection_unavailable",
                                        "requirePartial": true,
                                    })
                                })
                            })
                        };
                        let mut split_payload = serde_json::json!({
                            "shared": { "content": shared_content, "filename": shared_filename },
                            "core": { "content": core_content, "filename": core_filename },
                            "gui": { "content": gui_content, "filename": gui_filename },
                            "host_runner": { "content": host_runner_content, "filename": host_runner_filename },
                            "device": { "content": generated_device_source, "filename": generated_path },
                            "_synthi_manifest": sidecar_manifest_json.clone(),
                            "_synthi_reload_plan": warm.reload_plan.clone(),
                        });
                        if let (Some(obj), Some(partial)) =
                            (split_payload.as_object_mut(), partial_device_payload)
                        {
                            obj.insert("_synthi_device_partial".to_string(), partial);
                        }
                        Some(split_payload)
                    }
                } {
                    split
                } else if let Some(old_source) = {
                    let request_name = normalized_request_filename(&req.filename)
                        .unwrap_or_else(|| req.filename.replace('\\', "/"));
                    sidecar_string_for_path(&sidecar_meta, "sourceBaselineContents", &request_name)
                        .or(original_source.clone())
                } {
                    let diff = build_simple_diff(&old_source, &req.source);

                    if diff.is_empty() {
                        debug_log!("[HMR] No diff detected");
                        serde_json::json!({
                            "shared": { "content": shared_content, "filename": shared_filename },
                            "core": { "content": core_content, "filename": core_filename },
                            "gui": { "content": gui_content, "filename": gui_filename }
                        })
                    } else {
                        if req.force_gpu_ai_delta || !natural_gpu_ai_delta_reason_codes.is_empty() {
                            let request_device_name = normalized_request_filename(&req.filename)
                                .unwrap_or_else(|| req.filename.replace('\\', "/"));
                            if !natural_gpu_ai_delta_reason_codes.is_empty() {
                                eprintln!(
                                    "[GPU AI Delta] natural fallback requested: user={} reasons={}",
                                    request_device_name,
                                    natural_gpu_ai_delta_reason_codes.join(",")
                                );
                            }
                            if !is_device_source_request(&request_device_name)
                                && !is_device_header_request(&request_device_name)
                            {
                                anyhow::bail!(
                                    "GPU AI delta requires a GPU source or device header request, got {}",
                                    req.filename
                                );
                            }

                            let sidecar_manifest =
                                CompileManifest::from_json_value(&sidecar_manifest_json)
                                    .ok_or_else(|| {
                                        anyhow::anyhow!(
                                    "GPU AI delta requires a compile manifest in the split sidecar"
                                )
                                    })?;
                            if sidecar_manifest.gpu.is_none() {
                                anyhow::bail!(
                                    "GPU AI delta requires a GPU compile manifest, but no gpu block is present"
                                );
                            }

                            let generated_device_path = mapped_generated_device_path(
                                &sidecar_meta,
                                &request_device_name,
                            )
                            .or_else(|| {
                                sidecar_manifest
                                    .device_source_filename()
                                    .map(|s| s.replace('\\', "/"))
                            })
                            .ok_or_else(|| {
                                anyhow::anyhow!(
                                    "GPU AI delta could not resolve the internal generated device role"
                                )
                            })?;
                            let generated_device_source = {
                                let rel = compile_request_relpath(&generated_device_path)?;
                                tokio::fs::read_to_string(ctx.workspace_path.join(rel))
                                    .await
                                    .with_context(|| {
                                        format!(
                                            "reading generated device role {} for GPU AI delta",
                                            generated_device_path
                                        )
                                    })?
                            };
                            let ai_delta_device_scope = prepare_ai_delta_device_scope(
                                &ctx.workspace_path,
                                &sidecar_meta,
                                &generated_device_path,
                                &request_device_name,
                                Some(old_source.as_str()),
                                &req.source,
                                &generated_device_source,
                            )
                            .await?;
                            let Some(ai_delta_device_scope) = ai_delta_device_scope else {
                                let (plan_report, verifier_report, reason_codes) =
                                    gpu_ai_delta_policy_rejection_reports(
                                        "device_only",
                                        &request_device_name,
                                        &generated_device_path,
                                        vec![
                                            "ai_delta.scoped_device_artifact_missing".to_string(),
                                            "ai_delta.full_device_prompt_rejected".to_string(),
                                        ],
                                        vec!["device".to_string()],
                                    );
                                let mut meta =
                                    sidecar_meta.as_object().cloned().unwrap_or_default();
                                meta.insert("lastReloadPlanReport".to_string(), plan_report);
                                meta.insert(
                                    "lastGpuAiDeltaVerifierReport".to_string(),
                                    verifier_report,
                                );
                                meta.insert(
                                    "patchTier".to_string(),
                                    serde_json::Value::String("ai_delta_rejected".to_string()),
                                );
                                invalidate_derived_gpu_reports(&mut meta);
                                write_sidecar_logged(
                                    &sidecar_path,
                                    &serde_json::Value::Object(meta),
                                    &session_id,
                                )
                                .await;
                                eprintln!(
                                    "[GPU AI Delta] rejected unscoped device prompt: user={} generated={} reasons={}",
                                    request_device_name,
                                    generated_device_path,
                                    reason_codes.join(",")
                                );
                                anyhow::bail!(
                                    "GPU AI delta verifier rejected unscoped device prompt: reason_codes={}",
                                    reason_codes.join(",")
                                );
                            };
                            let ai_delta_device_prompt_source =
                                ai_delta_device_scope.source.as_str();

                            let arch_hint: Option<&str> = if architecture_md.is_empty() {
                                None
                            } else {
                                Some(architecture_md.as_str())
                            };
                            let ai_delta = perform_gpu_ai_diff_patch(
                                &diff,
                                &core_content,
                                &gui_content,
                                &shared_content,
                                &host_runner_content,
                                ai_delta_device_prompt_source,
                                arch_hint,
                                sidecar_meta
                                    .get("deviceMappingReport")
                                    .or_else(|| sidecar_meta.get("device_mapping_report")),
                                Some(&sidecar_manifest_json),
                                sidecar_meta
                                    .get("lastReloadPlanReport")
                                    .or_else(|| sidecar_meta.get("last_reload_plan_report")),
                                Some("device_only"),
                            )
                            .await?;
                            let touched_roles = gpu_ai_delta_touched_roles(&ai_delta.edits);
                            let mut policy_reasons = Vec::new();
                            if ai_delta.reload_plan == "device_only" {
                                if let Some(reason) =
                                    device_only_capability_rejection_reason(&sidecar_meta)
                                {
                                    policy_reasons.push(reason.to_string());
                                }
                            }
                            if touched_roles.len() > 1 {
                                policy_reasons
                                    .push("multi_role_ai_delta_requires_consent".to_string());
                                policy_reasons.push("arbiter_user_consent_required".to_string());
                            }
                            if ai_delta.edits.is_empty() {
                                policy_reasons.push("verifier.ai_delta_no_edits".to_string());
                            }
                            if !policy_reasons.is_empty() {
                                let (plan_report, verifier_report, reason_codes) =
                                    gpu_ai_delta_policy_rejection_reports(
                                        &ai_delta.reload_plan,
                                        &request_device_name,
                                        &generated_device_path,
                                        policy_reasons,
                                        touched_roles,
                                    );
                                let mut meta =
                                    sidecar_meta.as_object().cloned().unwrap_or_default();
                                meta.insert("lastReloadPlanReport".to_string(), plan_report);
                                meta.insert(
                                    "lastGpuAiDeltaVerifierReport".to_string(),
                                    verifier_report,
                                );
                                meta.insert(
                                    "patchTier".to_string(),
                                    serde_json::Value::String("ai_delta_rejected".to_string()),
                                );
                                invalidate_derived_gpu_reports(&mut meta);
                                write_sidecar_logged(
                                    &sidecar_path,
                                    &serde_json::Value::Object(meta),
                                    &session_id,
                                )
                                .await;
                                eprintln!(
                                    "[GPU AI Delta] rejected: user={} generated={} requested_plan={} reasons={}",
                                    request_device_name,
                                    generated_device_path,
                                    ai_delta.reload_plan,
                                    reason_codes.join(",")
                                );
                                anyhow::bail!(
                                    "GPU AI delta verifier rejected unsafe policy: reason_codes={}",
                                    reason_codes.join(",")
                                );
                            }

                            let (
                                final_core,
                                final_gui,
                                final_shared,
                                final_host_runner,
                                final_prompt_device,
                            ) = crate::hmr::edit_applier::apply_edit_list_with_device(
                                &ai_delta.edits,
                                &core_content,
                                &gui_content,
                                &shared_content,
                                &host_runner_content,
                                ai_delta_device_prompt_source,
                            )?;
                            let final_device = {
                                match crate::hmr::edit_applier::apply_edit_list_with_device(
                                    &ai_delta.edits,
                                    &core_content,
                                    &gui_content,
                                    &shared_content,
                                    &host_runner_content,
                                    &generated_device_source,
                                ) {
                                    Ok((_, _, _, _, full_device)) => full_device,
                                    Err(e) => {
                                        eprintln!(
                                            "[GPU AI Delta] scoped device prompt rejected: generated full role did not accept the same verified edits: {e:#}"
                                        );
                                        anyhow::bail!(
                                            "GPU AI delta scoped artifact edits did not apply to canonical generated device role"
                                        );
                                    }
                                }
                            };

                            let include_violations = generated_role_include_policy_violations(&[
                                ("shared", &shared_filename, &final_shared),
                                ("core", &core_filename, &final_core),
                                ("gui", &gui_filename, &final_gui),
                                ("host_runner", &host_runner_filename, &final_host_runner),
                                ("device", &generated_device_path, &final_device),
                            ]);
                            if !include_violations.is_empty() {
                                let details =
                                    format_generated_role_include_violations(&include_violations);
                                let touched_roles = include_violations
                                    .iter()
                                    .map(|v| v.role.clone())
                                    .collect::<std::collections::BTreeSet<_>>()
                                    .into_iter()
                                    .collect::<Vec<_>>();
                                let (plan_report, mut verifier_report, reason_codes) =
                                    gpu_ai_delta_policy_rejection_reports(
                                        &ai_delta.reload_plan,
                                        &request_device_name,
                                        &generated_device_path,
                                        vec![
                                            "generated_role_includes_project_header".to_string(),
                                            "verifier.generated_role_include_policy_failed"
                                                .to_string(),
                                        ],
                                        touched_roles,
                                    );
                                if let Some(obj) = verifier_report.as_object_mut() {
                                    obj.insert(
                                        "includeViolations".to_string(),
                                        serde_json::json!(include_violations
                                            .iter()
                                            .map(|v| serde_json::json!({
                                                "role": v.role,
                                                "include": v.include_path
                                            }))
                                            .collect::<Vec<_>>()),
                                    );
                                }
                                let mut meta =
                                    sidecar_meta.as_object().cloned().unwrap_or_default();
                                meta.insert("lastReloadPlanReport".to_string(), plan_report);
                                meta.insert(
                                    "lastGpuAiDeltaVerifierReport".to_string(),
                                    verifier_report,
                                );
                                meta.insert(
                                    "patchTier".to_string(),
                                    serde_json::Value::String("ai_delta_rejected".to_string()),
                                );
                                invalidate_derived_gpu_reports(&mut meta);
                                write_sidecar_logged(
                                    &sidecar_path,
                                    &serde_json::Value::Object(meta),
                                    &session_id,
                                )
                                .await;
                                eprintln!(
                                    "[GPU AI Delta] rejected generated-role include policy: {}",
                                    details
                                );
                                anyhow::bail!(
                                    "GPU AI delta verifier rejected generated-role include policy: reason_codes={}",
                                    reason_codes.join(",")
                                );
                            }

                            let signature_before =
                                kernel_abi_fingerprint_source(&generated_device_source);
                            let signature_after = kernel_abi_fingerprint_source(&final_device);
                            let layout_before =
                                device_constant_global_layout_fingerprint(&generated_device_source);
                            let layout_after =
                                device_constant_global_layout_fingerprint(&final_device);
                            if ai_delta.reload_plan == "device_only"
                                && (signature_before != signature_after
                                    || layout_before != layout_after)
                            {
                                let (plan_report, verifier_report, reason_codes) =
                                    gpu_ai_delta_rejection_reports(
                                        &ai_delta.reload_plan,
                                        &request_device_name,
                                        &generated_device_path,
                                        &signature_before,
                                        &signature_after,
                                        &layout_before,
                                        &layout_after,
                                    );
                                let mut meta =
                                    sidecar_meta.as_object().cloned().unwrap_or_default();
                                meta.insert("lastReloadPlanReport".to_string(), plan_report);
                                meta.insert(
                                    "lastGpuAiDeltaVerifierReport".to_string(),
                                    verifier_report,
                                );
                                meta.insert(
                                    "patchTier".to_string(),
                                    serde_json::Value::String("ai_delta_rejected".to_string()),
                                );
                                invalidate_derived_gpu_reports(&mut meta);
                                write_sidecar_logged(
                                    &sidecar_path,
                                    &serde_json::Value::Object(meta),
                                    &session_id,
                                )
                                .await;
                                eprintln!(
                                    "[GPU AI Delta] rejected: user={} generated={} requested_plan={} reasons={}",
                                    request_device_name,
                                    generated_device_path,
                                    ai_delta.reload_plan,
                                    reason_codes.join(",")
                                );
                                anyhow::bail!(
                                    "GPU AI delta verifier rejected device_only: reason_codes={}",
                                    reason_codes.join(",")
                                );
                            }

                            if let Some(ref p) = enrichment.adapted_status.core_path {
                                let _ = tokio::fs::write(p, &final_core).await;
                            }
                            if let Some(ref p) = enrichment.adapted_status.gui_path {
                                let _ = tokio::fs::write(p, &final_gui).await;
                            }
                            if let Some(ref p) = enrichment.adapted_status.shared_path {
                                let _ = tokio::fs::write(p, &final_shared).await;
                            }
                            if let Some(ref p) = enrichment.adapted_status.host_runner_path {
                                if final_host_runner != host_runner_content {
                                    let _ = tokio::fs::write(p, &final_host_runner).await;
                                }
                            }
                            write_compile_request_file(
                                &ctx.workspace_path,
                                &generated_device_path,
                                &final_device,
                            )
                            .await?;

                            let baseline_hash = device_source_hash(&req.source);
                            let mut meta = sidecar_meta.as_object().cloned().unwrap_or_default();
                            upsert_object_field(
                                &mut meta,
                                "sourceBaselineContents",
                                &request_device_name,
                                serde_json::Value::String(req.source.clone()),
                            );
                            upsert_object_field(
                                &mut meta,
                                "sourceBaselineHashes",
                                &request_device_name,
                                serde_json::Value::String(baseline_hash.clone()),
                            );
                            upsert_device_mapping_report_field(
                                &mut meta,
                                "sourceBaselineContents",
                                &request_device_name,
                                serde_json::Value::String(req.source.clone()),
                            );
                            upsert_device_mapping_report_field(
                                &mut meta,
                                "sourceBaselineHashes",
                                &request_device_name,
                                serde_json::Value::String(baseline_hash.clone()),
                            );
                            let reason_codes = vec![
                                "ai_delta.generated_role_patch".to_string(),
                                format!("ai_delta.reload_plan.{}", ai_delta.reload_plan),
                                "verifier.ai_delta_edits_applied".to_string(),
                                "verifier.kernel_signature_checked".to_string(),
                                "verifier.constant_global_layout_checked".to_string(),
                            ];
                            let mut reason_codes = reason_codes;
                            if !natural_gpu_ai_delta_reason_codes.is_empty() {
                                reason_codes.push("ai_delta.local_proof_failed".to_string());
                                reason_codes.extend(
                                    natural_gpu_ai_delta_reason_codes
                                        .iter()
                                        .map(|code| format!("local_proof.{code}")),
                                );
                            }
                            let plan_report = ai_delta_reload_plan_report(
                                &ai_delta.reload_plan,
                                &request_device_name,
                                Some(&generated_device_path),
                                reason_codes,
                            );
                            meta.insert("lastReloadPlanReport".to_string(), plan_report.clone());
                            meta.insert(
                                "patchTier".to_string(),
                                serde_json::Value::String("ai_delta".to_string()),
                            );
                            meta.insert(
                                "cacheReport".to_string(),
                                serde_json::json!({
                                    "splitCacheHit": false,
                                    "splitCacheReason": "ai_delta_after_full_split",
                                    "splitCacheKey": format!("gpu-ai-delta:{}:{}", request_device_name, baseline_hash),
                                }),
                            );
                            invalidate_derived_gpu_reports(&mut meta);
                            write_sidecar_logged(
                                &sidecar_path,
                                &serde_json::Value::Object(meta),
                                &session_id,
                            )
                            .await;
                            eprintln!(
                                "[GPU AI Delta] accepted: user={} generated={} plan={} edits={}",
                                request_device_name,
                                generated_device_path,
                                ai_delta.reload_plan,
                                ai_delta.edits.len()
                            );
                            let partial_device_payload = if ai_delta.reload_plan == "device_only" {
                                let payload = ai_delta_device_partial_payload(
                                    &generated_device_path,
                                    &generated_device_source,
                                    &final_device,
                                    Some((&ai_delta_device_scope, final_prompt_device.as_str())),
                                );
                                if let Some(partial) = payload.as_ref() {
                                    eprintln!(
                                        "[GPU AI Delta] partial compile package prepared: source={} file={} bytes={} symbols={}",
                                        partial
                                            .get("source")
                                            .and_then(serde_json::Value::as_str)
                                            .unwrap_or("unknown"),
                                        partial
                                            .get("filename")
                                            .and_then(serde_json::Value::as_str)
                                            .unwrap_or("unknown"),
                                        partial
                                            .get("content")
                                            .and_then(serde_json::Value::as_str)
                                            .map(str::len)
                                            .unwrap_or(0),
                                        string_array_field(partial, "symbols").join(",")
                                    );
                                }
                                payload
                            } else {
                                None
                            };
                            let mut split_payload = serde_json::json!({
                                "shared": { "content": final_shared, "filename": shared_filename },
                                "core": { "content": final_core, "filename": core_filename },
                                "gui": { "content": final_gui, "filename": gui_filename },
                                "host_runner": { "content": final_host_runner, "filename": host_runner_filename },
                                "device": { "content": final_device, "filename": generated_device_path },
                                "_synthi_manifest": sidecar_manifest_json.clone(),
                                "_synthi_reload_plan": plan_report,
                            });
                            if let (Some(obj), Some(partial)) =
                                (split_payload.as_object_mut(), partial_device_payload)
                            {
                                obj.insert("_synthi_device_partial".to_string(), partial);
                            }
                            split_payload
                        } else {
                            // ── Tiered patching (no AI classifier) ──
                            //
                            // Tier 1: VALUE_CHANGE → instant regex patcher (0ms)
                            //         Detected synchronously by classify_edit() —
                            //         pure Rust, ~1ms, no AI call.
                            //
                            // Tier 2: anything else → single full /refactor/diff_patch
                            //         call with all three split modules + the cached
                            //         architecture doc. The AI uses the arch doc's
                            //         "Where User Code Goes" section to route each
                            //         hunk to the right module(s) internally. No
                            //         external classifier.
                            //
                            // Tier 3: full AI re-split (last resort) if Tier 2 errors.
                            //
                            // Previously, Tier 2 used an /classify/edit AI call to
                            // pick ONE module and a targeted single-module prompt.
                            // classify cost ~4s per edit (Gemini API TTFT + SDK
                            // overhead) which exceeded the ~1-3s saved by the
                            // smaller targeted prompt — net latency LOSS. And when
                            // classify timed out, the Tier 2 loop silently dropped
                            // the edit because all hunks were EditTarget::Unknown.
                            // Killing classify removed both the latency regression
                            // and the silent-drop failure mode.
                            use crate::hmr::diff_patcher::patch_split_files;
                            use crate::hmr::edit_classifier::classify_edit;

                            let sync_classification = classify_edit(&old_source, &req.source);
                            let is_value_only = sync_classification.is_value_only;
                            eprintln!(
                                "[HMR] sync classify: {} hunks, value_only={}",
                                sync_classification.hunks.len(),
                                is_value_only
                            );

                            // ULTRAPLAN Lightning Phase 11 — Tier 0 v2 eligibility.
                            // Run tree-sitter AST classifier to confirm the edit is
                            // purely value changes (strings, integers). The regex
                            // `is_value_only` is a fast pre-filter; tree-sitter is
                            // the authoritative check that also detects integer
                            // literal changes for DWARF+iced-x86 patching.
                            if is_value_only {
                                use crate::hmr::ts_value_classifier::{
                                    classify_ast, AstClassification,
                                };
                                match classify_ast(&old_source, &req.source) {
                                    AstClassification::ValueOnly { ref changes }
                                        if !changes.is_empty() =>
                                    {
                                        eprintln!(
                                        "[HMR] Tier 0 v2 ELIGIBLE: {} value change(s) (tree-sitter confirmed)",
                                        changes.len()
                                    );
                                        tier0_v2_eligible = true;
                                        tier0_old_source = Some(old_source.clone());
                                    }
                                    AstClassification::ValueOnly { .. } => {
                                        eprintln!(
                                            "[HMR] Tier 0 v2: value-only but no literal changes"
                                        );
                                    }
                                    AstClassification::Structural => {
                                        eprintln!("[HMR] Tier 0 v2: tree-sitter says structural (regex disagreed)");
                                    }
                                    AstClassification::ParseError(e) => {
                                        eprintln!("[HMR] Tier 0 v2: parse error ({}), falling back to regex path", e);
                                    }
                                }
                            }

                            let arch_hint: Option<&str> = if architecture_md.is_empty() {
                                None
                            } else {
                                Some(architecture_md.as_str())
                            };

                            let (final_core, final_gui, final_shared, final_host_runner) =
                                if is_value_only {
                                    // Tier 1: pure value change — instant regex.
                                    // patch_split_files only knows about core/gui/shared
                                    // (legacy 3-module patcher); host_runner is preserved
                                    // verbatim from disk because Tier 1 is always value
                                    // changes (never structural edits to the runner).
                                    let patch = patch_split_files(
                                        &old_source,
                                        &req.source,
                                        &core_content,
                                        &gui_content,
                                        &shared_content,
                                    );
                                    if patch.has_changes() {
                                        eprintln!("[HMR] Tier 1: instant value patch (0ms)");
                                        (
                                            patch.core.unwrap_or_else(|| core_content.clone()),
                                            patch.gui.unwrap_or_else(|| gui_content.clone()),
                                            patch.shared.unwrap_or_else(|| shared_content.clone()),
                                            host_runner_content.clone(),
                                        )
                                    } else {
                                        // Regex couldn't find the value — fall through
                                        // to the AI path below rather than drop the edit.
                                        eprintln!("[HMR] Tier 1: regex patch failed despite value_only classification — falling through to AI diff_patch");
                                        match perform_ai_diff_patch(
                                            &diff,
                                            &core_content,
                                            &gui_content,
                                            &shared_content,
                                            &host_runner_content,
                                            arch_hint,
                                        )
                                        .await
                                        {
                                            Ok(edits) => {
                                                match apply_edit_list(
                                                    &edits,
                                                    &core_content,
                                                    &gui_content,
                                                    &shared_content,
                                                    &host_runner_content,
                                                ) {
                                                    Ok((c, g, s, h)) => (c, g, s, h),
                                                    Err(apply_err) => {
                                                        eprintln!(
                                                    "[HMR] Tier 2 (value-fallback) edit apply FAILED: {} → falling through to Tier 3 full re-split",
                                                    apply_err
                                                );
                                                        let result = perform_ai_split(&req).await?;
                                                        let fresh_arch = result
                                                            .get("_synthi_architecture")
                                                            .and_then(|v| v.as_str())
                                                            .unwrap_or("");
                                                        let fresh_manifest = result
                                                            .get("_synthi_manifest")
                                                            .cloned()
                                                            .unwrap_or(serde_json::Value::Null);
                                                        let fresh_cache_report = result
                                                            .get("_synthi_cache_report")
                                                            .cloned()
                                                            .unwrap_or(serde_json::Value::Null);
                                                        let fresh_agentic_report =
                                                            split_agentic_report(&result);
                                                        let fresh_generated_report =
                                                            generated_artifact_report(&result);
                                                        let fresh_mapping_report =
                                                            device_mapping_report(&result);
                                                        let fresh_source_report =
                                                            source_context_report(&result);
                                                        let fresh_launch_report =
                                                            launch_indirection_report(&result);
                                                        let meta = serde_json::json!({
                                                            "split_hash": source_hash_str,
                                                            "original_source": req.source,
                                                            "architecture": fresh_arch,
                                                            "compile_manifest": fresh_manifest,
                                                            "cache_report": fresh_cache_report,
                                                            "agentic_report": fresh_agentic_report,
                                                            "generated_artifact_report": fresh_generated_report,
                                                            "device_mapping_report": fresh_mapping_report,
                                                            "source_context_report": fresh_source_report,
                                                            "launch_indirection_report": fresh_launch_report,
                                                        });
                                                        write_sidecar_logged(
                                                            &sidecar_path,
                                                            &meta,
                                                            &session_id,
                                                        )
                                                        .await;
                                                        return Ok(result);
                                                    }
                                                }
                                            }
                                            Err(e) => {
                                                eprintln!("[HMR] Tier 2 (value-fallback) AI diff_patch failed: {}, falling through to Tier 3 full re-split", e);
                                                let result = perform_ai_split(&req).await?;
                                                let fresh_arch = result
                                                    .get("_synthi_architecture")
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or("");
                                                let fresh_manifest = result
                                                    .get("_synthi_manifest")
                                                    .cloned()
                                                    .unwrap_or(serde_json::Value::Null);
                                                let fresh_cache_report = result
                                                    .get("_synthi_cache_report")
                                                    .cloned()
                                                    .unwrap_or(serde_json::Value::Null);
                                                let fresh_agentic_report =
                                                    split_agentic_report(&result);
                                                let fresh_generated_report =
                                                    generated_artifact_report(&result);
                                                let fresh_mapping_report =
                                                    device_mapping_report(&result);
                                                let fresh_source_report =
                                                    source_context_report(&result);
                                                let fresh_launch_report =
                                                    launch_indirection_report(&result);
                                                let meta = serde_json::json!({
                                                    "split_hash": source_hash_str,
                                                    "original_source": req.source,
                                                    "architecture": fresh_arch,
                                                    "compile_manifest": fresh_manifest,
                                                    "cache_report": fresh_cache_report,
                                                    "agentic_report": fresh_agentic_report,
                                                    "generated_artifact_report": fresh_generated_report,
                                                    "device_mapping_report": fresh_mapping_report,
                                                    "source_context_report": fresh_source_report,
                                                    "launch_indirection_report": fresh_launch_report,
                                                });
                                                write_sidecar_logged(
                                                    &sidecar_path,
                                                    &meta,
                                                    &session_id,
                                                )
                                                .await;
                                                return Ok(result);
                                            }
                                        }
                                    }
                                } else {
                                    // Tier 2: non-value edit.
                                    //
                                    // First check the speculative cache for a hit.
                                    // If the file-sync handler fired a speculative
                                    // diff_patch while the user was pausing and
                                    // the AI call completed before compile, the
                                    // edits are already in the cache keyed by the
                                    // current source hash. Apply them directly and
                                    // skip the live AI call entirely.
                                    //
                                    // On any miss / apply failure, fall through
                                    // transparently to the normal live AI call.
                                    let spec_hash = crate::hmr::speculative_diff_patch::hash_source(
                                        &req.source,
                                    );
                                    // Wait up to 15s for any in-flight speculation
                                    // for this source hash. This de-duplicates the
                                    // Ctrl+S race: the frontend sends the file-sync
                                    // write and the compile request back-to-back,
                                    // so the speculative task is usually still in
                                    // its 300ms debounce when compile arrives. Without
                                    // the wait, handler.rs would fire its own live
                                    // AI call in parallel — two calls for the same
                                    // edit, no benefit. Waiting collapses them to one.
                                    // On miss / timeout, take_matching_or_wait
                                    // returns None and we fall through to the live
                                    // AI call below with no extra latency.
                                    let speculative_applied: Option<(
                                        String,
                                        String,
                                        String,
                                        String,
                                    )> = {
                                        if let Some(cached_edits) =
                                        crate::hmr::speculative_diff_patch::take_matching_or_wait(
                                            spec_hash,
                                            std::time::Duration::from_secs(25),
                                        )
                                        .await
                                    {
                                        match apply_edit_list(
                                            &cached_edits,
                                            &core_content,
                                            &gui_content,
                                            &shared_content,
                                            &host_runner_content,
                                        ) {
                                            Ok(tuple) => {
                                                eprintln!(
                                                "[HMR] Tier 2 SPECULATIVE HIT ({} edit(s), skipped AI call)",
                                                cached_edits.len()
                                            );
                                                Some(tuple)
                                            }
                                            Err(e) => {
                                                // Speculative was based on stale
                                                // split contents — anchor doesn't
                                                // match the live file. Fall through
                                                // to the live AI call rather than
                                                // bail to Tier 3.
                                                eprintln!(
                                                "[HMR] Tier 2 speculative apply FAILED: {} → falling through to live AI call",
                                                e
                                            );
                                                None
                                            }
                                        }
                                    } else {
                                        None
                                    }
                                    };

                                    if let Some(quad) = speculative_applied {
                                        quad
                                    } else {
                                        // Live AI call (diff-only output format — ~100
                                        // output tokens, ~1s generation on pro).
                                        eprintln!(
                                    "[HMR] Tier 2: AI diff_patch (diff={} bytes, arch={} chars, host_runner={} bytes)",
                                    diff.len(),
                                    architecture_md.len(),
                                    host_runner_content.len()
                                );
                                        match perform_ai_diff_patch(
                                            &diff,
                                            &core_content,
                                            &gui_content,
                                            &shared_content,
                                            &host_runner_content,
                                            arch_hint,
                                        )
                                        .await
                                        {
                                            Ok(edits) => {
                                                eprintln!(
                                            "[HMR] Tier 2: received {} edit(s), applying locally",
                                            edits.len()
                                        );
                                                match apply_edit_list(
                                                    &edits,
                                                    &core_content,
                                                    &gui_content,
                                                    &shared_content,
                                                    &host_runner_content,
                                                ) {
                                                    Ok((c, g, s, h)) => {
                                                        eprintln!(
                                                    "[HMR] Tier 2 SUCCESS ({} edits, core_changed={} gui_changed={} shared_changed={} host_runner_changed={})",
                                                    edits.len(),
                                                    c != core_content,
                                                    g != gui_content,
                                                    s != shared_content,
                                                    h != host_runner_content
                                                );
                                                        (c, g, s, h)
                                                    }
                                                    Err(apply_err) => {
                                                        // Anchor missing / ambiguous / unknown module.
                                                        // Don't try to partially apply — fall through
                                                        // to Tier 3 for a correct full re-split.
                                                        eprintln!(
                                                    "[HMR] Tier 2 edit apply FAILED: {} → falling through to Tier 3 full re-split",
                                                    apply_err
                                                );
                                                        let result = perform_ai_split(&req).await?;
                                                        let fresh_arch = result
                                                            .get("_synthi_architecture")
                                                            .and_then(|v| v.as_str())
                                                            .unwrap_or("");
                                                        let fresh_manifest = result
                                                            .get("_synthi_manifest")
                                                            .cloned()
                                                            .unwrap_or(serde_json::Value::Null);
                                                        let fresh_cache_report = result
                                                            .get("_synthi_cache_report")
                                                            .cloned()
                                                            .unwrap_or(serde_json::Value::Null);
                                                        let fresh_agentic_report =
                                                            split_agentic_report(&result);
                                                        let fresh_generated_report =
                                                            generated_artifact_report(&result);
                                                        let fresh_mapping_report =
                                                            device_mapping_report(&result);
                                                        let fresh_source_report =
                                                            source_context_report(&result);
                                                        let fresh_launch_report =
                                                            launch_indirection_report(&result);
                                                        let meta = serde_json::json!({
                                                            "split_hash": source_hash_str,
                                                            "original_source": req.source,
                                                            "architecture": fresh_arch,
                                                            "compile_manifest": fresh_manifest,
                                                            "cache_report": fresh_cache_report,
                                                            "agentic_report": fresh_agentic_report,
                                                            "generated_artifact_report": fresh_generated_report,
                                                            "device_mapping_report": fresh_mapping_report,
                                                            "source_context_report": fresh_source_report,
                                                            "launch_indirection_report": fresh_launch_report,
                                                        });
                                                        write_sidecar_logged(
                                                            &sidecar_path,
                                                            &meta,
                                                            &session_id,
                                                        )
                                                        .await;
                                                        return Ok(result);
                                                    }
                                                }
                                            }
                                            Err(e) => {
                                                eprintln!(
                                            "[HMR] Tier 2 AI diff_patch FAILED: {} → falling through to Tier 3 full re-split",
                                            e
                                        );
                                                let result = perform_ai_split(&req).await?;
                                                let fresh_arch = result
                                                    .get("_synthi_architecture")
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or("");
                                                let fresh_manifest = result
                                                    .get("_synthi_manifest")
                                                    .cloned()
                                                    .unwrap_or(serde_json::Value::Null);
                                                let fresh_cache_report = result
                                                    .get("_synthi_cache_report")
                                                    .cloned()
                                                    .unwrap_or(serde_json::Value::Null);
                                                let fresh_agentic_report =
                                                    split_agentic_report(&result);
                                                let fresh_generated_report =
                                                    generated_artifact_report(&result);
                                                let fresh_mapping_report =
                                                    device_mapping_report(&result);
                                                let fresh_source_report =
                                                    source_context_report(&result);
                                                let fresh_launch_report =
                                                    launch_indirection_report(&result);
                                                let meta = serde_json::json!({
                                                    "split_hash": source_hash_str,
                                                    "original_source": req.source,
                                                    "architecture": fresh_arch,
                                                    "compile_manifest": fresh_manifest,
                                                    "cache_report": fresh_cache_report,
                                                    "agentic_report": fresh_agentic_report,
                                                    "generated_artifact_report": fresh_generated_report,
                                                    "device_mapping_report": fresh_mapping_report,
                                                    "source_context_report": fresh_source_report,
                                                    "launch_indirection_report": fresh_launch_report,
                                                });
                                                write_sidecar_logged(
                                                    &sidecar_path,
                                                    &meta,
                                                    &session_id,
                                                )
                                                .await;
                                                return Ok(result);
                                            }
                                        }
                                    }
                                };

                            // Write patched files to disk + update sidecar. Preserve
                            // the existing architecture cache AND compile manifest
                            // — this is a diff-patch apply, not a re-split, so the
                            // architecture is still valid (same split modules, same
                            // contract) and the manifest hasn't changed (same
                            // library, same link flags).
                            if sidecar_manifest_json
                                .get("gpu")
                                .map(|v| !v.is_null())
                                .unwrap_or(false)
                            {
                                let include_violations =
                                    generated_role_include_policy_violations(&[
                                        ("shared", &shared_filename, &final_shared),
                                        ("core", &core_filename, &final_core),
                                        ("gui", &gui_filename, &final_gui),
                                        ("host_runner", &host_runner_filename, &final_host_runner),
                                    ]);
                                if !include_violations.is_empty() {
                                    let details = format_generated_role_include_violations(
                                        &include_violations,
                                    );
                                    eprintln!(
                                        "[GPU AI Delta] rejected generated-role include policy: {}",
                                        details
                                    );
                                    anyhow::bail!(
                                        "GPU AI delta verifier rejected generated-role include policy: reason_codes=generated_role_includes_project_header details={}",
                                        details
                                    );
                                }
                            }
                            if let Some(ref p) = enrichment.adapted_status.core_path {
                                let _ = tokio::fs::write(p, &final_core).await;
                            }
                            if let Some(ref p) = enrichment.adapted_status.gui_path {
                                let _ = tokio::fs::write(p, &final_gui).await;
                            }
                            if let Some(ref p) = enrichment.adapted_status.shared_path {
                                let _ = tokio::fs::write(p, &final_shared).await;
                            }
                            // ULTRAPLAN Phase 5: persist host_runner.cpp if the
                            // diff_patch produced edits targeting it. The hash
                            // change vs `host_runner_content` will be picked up
                            // by compile_runner downstream (its content cache
                            // re-keys on this string), triggering a runner
                            // rebuild only when the runner actually changed.
                            if let Some(ref p) = enrichment.adapted_status.host_runner_path {
                                if final_host_runner != host_runner_content {
                                    let _ = tokio::fs::write(p, &final_host_runner).await;
                                    eprintln!(
                                        "[HMR] Tier 2: host_runner.cpp updated ({} → {} bytes)",
                                        host_runner_content.len(),
                                        final_host_runner.len()
                                    );
                                }
                            }
                            let source_report = sidecar_meta
                                .get("sourceContextReport")
                                .or_else(|| sidecar_meta.get("source_context_report"))
                                .cloned()
                                .unwrap_or(serde_json::Value::Null);
                            let launch_report = sidecar_meta
                                .get("launchIndirectionReport")
                                .or_else(|| sidecar_meta.get("launch_indirection_report"))
                                .cloned()
                                .unwrap_or(serde_json::Value::Null);
                            let meta = serde_json::json!({
                                "split_hash": source_hash_str,
                                "original_source": req.source,
                                "architecture": architecture_md,
                                "compile_manifest": sidecar_manifest_json.clone(),
                                "source_context_report": source_report.clone(),
                                "launch_indirection_report": launch_report.clone(),
                            });
                            write_sidecar_logged(&sidecar_path, &meta, &session_id).await;

                            serde_json::json!({
                                "shared": { "content": final_shared, "filename": shared_filename },
                                "core": { "content": final_core, "filename": core_filename },
                                "gui": { "content": final_gui, "filename": gui_filename },
                                "host_runner": { "content": final_host_runner, "filename": host_runner_filename },
                                "_synthi_manifest": sidecar_manifest_json.clone(),
                                "_synthi_source_context_report": source_report,
                                "_synthi_launch_indirection_report": launch_report,
                            })
                        }
                    }
                } else {
                    // No original source saved — need AI re-split
                    debug_log!("[HMR] No original source baseline, falling back to AI split");
                    let result = perform_ai_split(&req).await?;
                    let fresh_arch = result
                        .get("_synthi_architecture")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let fresh_manifest = result
                        .get("_synthi_manifest")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let fresh_cache_report = result
                        .get("_synthi_cache_report")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let fresh_agentic_report = split_agentic_report(&result);
                    let fresh_generated_report = generated_artifact_report(&result);
                    let fresh_mapping_report = device_mapping_report(&result);
                    let fresh_source_report = source_context_report(&result);
                    let fresh_launch_report = launch_indirection_report(&result);
                    let meta = serde_json::json!({
                        "split_hash": source_hash_str,
                        "original_source": req.source,
                        "architecture": fresh_arch,
                        "compile_manifest": fresh_manifest,
                        "cache_report": fresh_cache_report,
                        "agentic_report": fresh_agentic_report,
                        "generated_artifact_report": fresh_generated_report,
                        "device_mapping_report": fresh_mapping_report,
                        "source_context_report": fresh_source_report,
                        "launch_indirection_report": fresh_launch_report,
                    });
                    write_sidecar_logged(&sidecar_path, &meta, &session_id).await;
                    result
                }
            } else {
                // Not adapted: wrap source as single core module
                debug_log!("[HMR] FallbackDeterministic → not adapted, wrapping as single module");
                serde_json::json!({
                    "shared": { "content": "", "filename": "shared.h" },
                    "core": { "content": req.source.clone(), "filename": "core.cpp" },
                    "gui": { "content": "", "filename": "gui.cpp" }
                })
            }
        }
    };

    // 2. Extract raw content
    let shared_raw = split_data
        .get("shared")
        .and_then(|s| s["content"].as_str())
        .unwrap_or("");
    let core_raw = split_data
        .get("core")
        .and_then(|c| c["content"].as_str())
        .unwrap_or("");
    let gui_raw = split_data
        .get("gui")
        .and_then(|g| g["content"].as_str())
        .unwrap_or("");

    // 3. Apply Guardrails
    // Each guardrail that modifies content = a prompt failure.  Log so we
    // can track prompt quality and eventually remove guardrails.
    let processed_shared = apply_shared_guardrails(shared_raw);
    if processed_shared != shared_raw {
        debug_log!(
            "[Guardrail] shared.h was modified by guardrails — prompt produced incorrect output"
        );
    }
    let allow_gui_in_core = enrichment.is_deterministic();
    let processed_core = apply_core_guardrails(core_raw, &processed_shared, allow_gui_in_core);
    if processed_core != core_raw {
        debug_log!(
            "[Guardrail] core.cpp was modified by guardrails — prompt produced incorrect output"
        );
    }
    let processed_gui = apply_gui_guardrails(gui_raw, &processed_shared);
    if processed_gui != gui_raw {
        debug_log!(
            "[Guardrail] gui.cpp was modified by guardrails — prompt produced incorrect output"
        );
    }

    // ============================================================
    // PHASE 2: REBUILD SCOPE DETERMINATION (deterministic_compile coordinator)
    // ============================================================

    let mut new_hashes = ModuleHashes::new();
    new_hashes.shared_hash = hash_shared_header_semantic(&processed_shared);
    new_hashes.core_hash = hash_content(&processed_core);
    new_hashes.gui_hash = hash_content(&processed_gui);

    // Get previous state
    let (prev_hashes, prev_core_path, prev_gui_path) = {
        let guard = ctx.runner_store.lock().await;
        if let Some(state) = guard.as_ref() {
            let same_session = state.session_id.as_deref() == Some(session_id.as_str());
            if same_session {
                (
                    state.module_hashes.clone(),
                    state.loaded_core_path.clone(),
                    state.loaded_gui_path.clone(),
                )
            } else {
                debug_log!(
                    "[HMR Planner] Ignoring previous module hashes from another session: current={:?} requested={}",
                    state.session_id.as_deref(),
                    session_id
                );
                (ModuleHashes::new(), None, None)
            }
        } else {
            (ModuleHashes::new(), None, None)
        }
    };

    // Route scope determination through deterministic_compile on Loop A
    let rebuild_scope = if enrichment.is_deterministic() && enrichment.adapted_status.is_adapted {
        // Loop A: use deterministic_compile as the scope coordinator
        let det_input = DeterministicCompileInput {
            adapted: enrichment.adapted_status.clone(),
            language: req.language.clone(),
            workspace_dir: ctx.workspace_path.clone(),
            output_dir: output_dir.clone(),
            compiler_flags: vec![],
            use_cache: enrichment.use_incremental_cache,
            preview_id: session_id.clone(),
        };

        if let Err(e) = validate_deterministic_input(&det_input) {
            eprintln!(
                "[Handler] Deterministic validation failed: {}, falling back to hash scope",
                e
            );
            // Fallback to hash-based scope
            hash_based_rebuild_scope(&prev_hashes, &new_hashes)
        } else {
            let prev_core_h = if prev_hashes.core_hash != 0 {
                Some(format!("{}", prev_hashes.core_hash))
            } else {
                None
            };
            let prev_gui_h = if prev_hashes.gui_hash != 0 {
                Some(format!("{}", prev_hashes.gui_hash))
            } else {
                None
            };
            let prev_shared_h = if prev_hashes.shared_hash != 0 {
                Some(format!("{}", prev_hashes.shared_hash))
            } else {
                None
            };
            let det_scope = determine_deterministic_scope(
                &det_input,
                prev_core_h.as_deref(),
                prev_gui_h.as_deref(),
                prev_shared_h.as_deref(),
                &format!("{}", new_hashes.core_hash),
                &format!("{}", new_hashes.gui_hash),
                &format!("{}", new_hashes.shared_hash),
            );
            // Map DeterministicRebuildScope → RebuildScope
            match det_scope {
                DeterministicRebuildScope::None => {
                    debug_log!("[Handler] Deterministic: No changes detected");
                    RebuildScope::None
                }
                DeterministicRebuildScope::CoreOnly => {
                    debug_log!("[Handler] Deterministic: Core rebuild");
                    RebuildScope::CoreOnly
                }
                DeterministicRebuildScope::GuiOnly => {
                    debug_log!("[Handler] Deterministic: GUI rebuild");
                    RebuildScope::GuiOnly
                }
                DeterministicRebuildScope::Both => {
                    debug_log!("[Handler] Deterministic: Full rebuild");
                    RebuildScope::Both
                }
            }
        }
    } else {
        // Loop B or non-adapted: use hash-based scope
        hash_based_rebuild_scope(&prev_hashes, &new_hashes)
    };

    // Notify frontend
    let scope_msg = match rebuild_scope {
        RebuildScope::GuiOnly => "GUI-only rebuild",
        RebuildScope::CoreOnly => "Core rebuild",
        RebuildScope::Both => "Full rebuild",
        RebuildScope::FullReload => "Full reload",
        RebuildScope::None => "No changes",
    };
    let payload = serde_json::json!({
        "sessionId": session_id.clone(),
        "type": "stderr",
        "line": format!("[HMR] {}\n", scope_msg)
    });
    let _ = ctx
        .log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;

    // ============================================================
    // PHASE 3: COMPILATION
    // ============================================================

    // Unique timestamp for .so filenames (seconds since epoch as i64)
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    // Unique ID for this reload in the HMR pipeline
    let reload_id = format!("r-{}", timestamp);

    // Manual logging
    debug_log!("[Compile] Step: Starting compilation");

    // Validate: bail early if AI split produced empty core content.
    // Without this guard, an empty .cpp is compiled into a .so with no
    // symbols, compile_core returns Ok(None), and the handler emits
    // "Core compilation failed" with zero diagnostic information.
    if rebuild_scope != RebuildScope::None
        && rebuild_scope != RebuildScope::GuiOnly
        && processed_core.trim().is_empty()
    {
        let msg = "AI split returned empty core module content. Cannot compile.";
        debug_log!("[Handler] {}", msg);
        let payload = serde_json::json!({
            "sessionId": session_id.clone(),
            "type": "stderr",
            "line": format!("[Error] {}\n", msg)
        });
        let _ = ctx
            .log_dc
            .send_text(serde_json::to_string(&payload).unwrap_or_default())
            .await;
        anyhow::bail!(msg);
    }

    // Ensure shared header exists before compilation starts
    if rebuild_scope != RebuildScope::None {
        let shared_fname = split_data
            .get("shared")
            .and_then(|s| s["filename"].as_str())
            .unwrap_or("shared.h");
        write_compile_request_file(&ctx.workspace_path, shared_fname, &processed_shared).await?;
    }

    // ULTRAPLAN Phase 3: resolve the compile manifest for this request.
    //
    // Three-layer lookup:
    //   1. `split_data._synthi_manifest` — set by ai_utils Proceed branch
    //      AND by the FallbackDeterministic Tier 2 success path (preserved
    //      from sidecar). Covers the common happy-path flows.
    //   2. sidecar `.synthi_split_meta.json::compile_manifest` — re-read
    //      here to cover `AiBypassResult::UseCached` (where the cached
    //      split content was reused but the manifest wasn't threaded
    //      through) and any edge case where the split_data was built
    //      without the manifest embedded.
    //   3. None → downstream `compile_core` / `compile_gui` fall back to
    //      `CompileManifest::generic_fallback()`, preserving generic host
    //      compatibility with pre-universal-prompt projects.
    let compile_manifest: Option<CompileManifest> = {
        let from_request = req
            .compile_manifest
            .as_ref()
            .and_then(|v| if v.is_null() { None } else { Some(v) })
            .and_then(CompileManifest::from_json_value);
        if from_request.is_some() {
            from_request
        } else {
            let from_split_data = split_data
                .get("_synthi_manifest")
                .and_then(|v| if v.is_null() { None } else { Some(v) })
                .and_then(CompileManifest::from_json_value);
            if from_split_data.is_some() {
                from_split_data
            } else {
                // Fallback: re-read sidecar. Cheap — tens of KB at most,
                // and only on UseCached/edge paths that don't carry the
                // manifest inside split_data.
                match tokio::fs::read_to_string(&sidecar_path).await {
                    Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
                        .ok()
                        .and_then(|meta| meta.get("compile_manifest").cloned())
                        .and_then(|v| if v.is_null() { None } else { Some(v) })
                        .and_then(|v| CompileManifest::from_json_value(&v)),
                    Err(_) => None,
                }
            }
        }
    };
    // ULTRAPLAN Lightning Phase 11 — inject -O0 and -fno-merge-constants
    // so Tier 0 literal patching is safe. Applied unconditionally to ALL
    // compiles — these are dev-mode flags, and HMR is a dev-only feature.
    let compile_manifest: Option<CompileManifest> = compile_manifest.map(|m| {
        if m.tier0_safe() {
            m
        } else {
            eprintln!(
                "[HMR] compile_manifest: injecting -O0/-fno-merge-constants for Tier 0 safety"
            );
            m.with_tier0_flags()
        }
    });

    match &compile_manifest {
        Some(m) => eprintln!(
            "[HMR] compile_manifest: compiler={}, std={}, gui_link={:?}, hot_reload={}, tier0_safe={}",
            m.select_compiler(ModuleKind::Core),
            m.std,
            m.gui_link_flags,
            m.hot_reload_mode.as_str(),
            m.tier0_safe(),
        ),
        None => eprintln!("[HMR] compile_manifest: none (generic fallback downstream)"),
    }

    if let Some(gpu) = compile_manifest.as_ref().and_then(|m| m.gpu.as_ref()) {
        let header_path = ensure_gpu_runtime_contract_header(&ctx.workspace_path, gpu).await?;
        eprintln!(
            "[compile-device] runtime contract header ready path={}",
            header_path.display()
        );
    }

    let device_source_content: Option<DeviceCompileSources> = if !req.prefer_gpu_pipeline {
        if compile_manifest
            .as_ref()
            .and_then(|m| m.gpu.as_ref())
            .is_some()
        {
            eprintln!("[compile-device] skipping — GPU pipeline disabled by compile request");
        }
        None
    } else if let Some(gpu) = compile_manifest.as_ref().and_then(|m| m.gpu.as_ref()) {
        let device_filename = compile_manifest
            .as_ref()
            .and_then(|m| m.device_source_filename())
            .unwrap_or_else(|| device_filename_for_vendor(gpu.vendor));
        let from_split = split_data
            .get("device")
            .and_then(|v| v.get("content"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                split_data
                    .get(device_filename)
                    .and_then(|v| v.get("content"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.to_string())
            });
        if let Some(src) = from_split {
            let split_device_filename = split_data
                .get("device")
                .and_then(|v| v.get("filename"))
                .or_else(|| {
                    split_data
                        .get(device_filename)
                        .and_then(|v| v.get("filename"))
                })
                .and_then(|v| v.as_str())
                .and_then(normalized_request_filename)
                .unwrap_or_else(|| device_filename.to_string());
            let full_symbols =
                device_mapping_symbols_for_generated(&split_data, &split_device_filename);
            let partial_request = split_partial_device_source(&split_data);
            let (
                partial_source,
                partial_filename,
                partial_symbols,
                partial_source_paths,
                partial_required,
                partial_artifact_kind,
                partial_fallback_reason,
            ) = partial_request
                .map(|partial| {
                    (
                        Some(partial.source),
                        Some(partial.filename),
                        partial.symbols,
                        partial.source_paths,
                        partial.required,
                        partial.artifact_kind,
                        partial.fallback_reason,
                    )
                })
                .unwrap_or((None, None, Vec::new(), Vec::new(), false, None, None));
            eprintln!(
                "[compile-device] source resolved from split_data file={} bytes={} mapped_symbols={} partial={} partial_required={}",
                split_device_filename,
                src.len(),
                if full_symbols.is_empty() {
                    "-".to_string()
                } else {
                    full_symbols.join(",")
                },
                partial_source
                    .as_ref()
                    .map(|source| source.len().to_string())
                    .unwrap_or_else(|| "none".to_string()),
                partial_required
            );
            Some(DeviceCompileSources {
                full_source: src,
                full_filename: Some(split_device_filename),
                full_symbols,
                direct_workspace_source: false,
                partial_source,
                partial_filename,
                partial_symbols,
                partial_source_paths,
                partial_required,
                partial_artifact_kind,
                partial_fallback_reason,
            })
        } else {
            match tokio::fs::read_to_string(ctx.workspace_path.join(device_filename)).await {
                Ok(src) if !src.trim().is_empty() => {
                    let full_symbols = extract_device_kernel_symbols(&src);
                    eprintln!(
                        "[compile-device] source resolved from workspace file={} bytes={} mapped_symbols={}",
                        device_filename,
                        src.len(),
                        if full_symbols.is_empty() {
                            "-".to_string()
                        } else {
                            full_symbols.join(",")
                        }
                    );
                    Some(DeviceCompileSources {
                        full_source: src,
                        full_filename: Some(device_filename.to_string()),
                        full_symbols,
                        direct_workspace_source: true,
                        partial_source: None,
                        partial_filename: None,
                        partial_symbols: Vec::new(),
                        partial_source_paths: Vec::new(),
                        partial_required: false,
                        partial_artifact_kind: None,
                        partial_fallback_reason: None,
                    })
                }
                Ok(_) => {
                    eprintln!("[compile-device] skipping — {device_filename} is empty");
                    None
                }
                Err(e) => {
                    eprintln!(
                        "[compile-device] skipping — manifest has gpu block but {} was not found: {}",
                        device_filename, e
                    );
                    None
                }
            }
        }
    } else {
        None
    };

    if let Some(device_sources) = device_source_content.as_ref() {
        if let Some(full_filename) = device_sources.full_filename.as_deref() {
            if let Err(e) = materialize_device_partial_artifacts(
                &ctx.workspace_path,
                &sidecar_path,
                full_filename,
                &device_sources.full_source,
                &session_id,
            )
            .await
            {
                eprintln!("[compile-device] partial artifact materialization skipped: {e:#}");
            }
        }
    }

    // ULTRAPLAN Phase 8: forward the manifest + architecture cache to
    // the frontend over the log data channel. The frontend's
    // compilerClient.js bridges `{type: "compile-manifest", ...}` into
    // a `synthi:compile-manifest` CustomEvent, and
    // `useCompileManifestListener` populates the Redux slice that the
    // StatusBar framework pill, CompileErrorCard and ConfidenceWarning
    // components read from.
    //
    // We emit BEFORE compile starts so the frontend can show the
    // detected framework + confidence nudge up-front, even if compile
    // fails. The architecture cache is sourced from split_data first
    // (fresh Proceed / Tier 3 path) and falls back to re-reading the
    // sidecar (UseCached / Tier 2 path where split_data lacks it).
    {
        let arch_from_split_data = split_data
            .get("_synthi_architecture")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let architecture_for_frontend = if let Some(a) = arch_from_split_data {
            a
        } else {
            match tokio::fs::read_to_string(&sidecar_path).await {
                Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
                    .ok()
                    .and_then(|meta| {
                        meta.get("architecture")
                            .and_then(|a| a.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_default(),
                Err(_) => String::new(),
            }
        };
        // Serialize the compile_manifest struct back to JSON so the
        // frontend receives the exact wire shape produced by the Python
        // side. If resolution produced None (pre-Phase-3 project, split
        // failure, etc.) emit null so the frontend knows there's no
        // manifest available rather than showing stale data.
        let manifest_json_for_frontend: serde_json::Value = compile_manifest
            .as_ref()
            .and_then(|m| serde_json::to_value(m).ok())
            .unwrap_or(serde_json::Value::Null);
        if !manifest_json_for_frontend.is_null() || !architecture_for_frontend.is_empty() {
            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "compile-manifest",
                "manifest": manifest_json_for_frontend,
                "architecture": architecture_for_frontend,
            });
            let _ = ctx
                .log_dc
                .send_text(serde_json::to_string(&payload).unwrap_or_default())
                .await;
            eprintln!("[HMR] compile-manifest emitted to frontend data channel");
        }
    }

    // ============================================================
    // ULTRAPLAN PHASE 4: HOST RUNNER CONTENT RESOLUTION
    // ============================================================
    //
    // Resolve host_runner.cpp content BEFORE the parallel compile block.
    // The universal split prompt emits a 4th file alongside core/gui/
    // shared: `host_runner.cpp`, the per-project main() that owns the
    // window/event loop and dlopens libcore.so + libgui.so. We compile
    // it as a build artifact here.
    //
    // Runtime selection depends on the manifest. Non-GPU adapted projects
    // may run the compiled per-project host_runner. GPU manifests keep the
    // per-project host_runner as build/validation output only: below,
    // `runtime_host_runner_bin_path` is forced to None so the shipped
    // runner handles Synthi's GPU runtime boundary, device sidecar loader,
    // HMR protocol, Xvfb/GStreamer capture, and WebRTC streaming.
    //
    // BYOR mode: when `adapted_status.user_owned_runner` is true (the
    // existing host_runner.cpp on disk starts with `// SYNTHI_USER_RUNNER`),
    // we MUST NOT overwrite it with the AI's regenerated content — even
    // on a fresh AI split. We just rebuild the user's existing file.
    // See HMR_AGNOSTIC_ULTRAPLAN.md §5.2 (Mitigation 2B).
    //
    // ULTRAPLAN Phase 9d (Lightning): this resolution block is now
    // hoisted ABOVE the compile dispatch so the three compile stages
    // (core/gui/runner) can all run in parallel with a single
    // tokio::join!. All three inputs (processed_core, processed_gui,
    // host_runner_content) are fully materialised before dispatch.
    let host_runner_content: Option<String> = if enrichment.adapted_status.user_owned_runner {
        // BYOR: read the user-authored runner from disk, ignore split_data.
        if let Some(ref p) = enrichment.adapted_status.host_runner_path {
            match tokio::fs::read_to_string(p).await {
                Ok(content) => {
                    eprintln!(
                        "[HMR] host_runner: BYOR mode — reusing user-owned runner ({} bytes from {})",
                        content.len(),
                        p.display()
                    );
                    Some(content)
                }
                Err(e) => {
                    eprintln!(
                        "[HMR] host_runner: BYOR sentinel set but read failed: {}",
                        e
                    );
                    None
                }
            }
        } else {
            eprintln!("[HMR] host_runner: BYOR flag set but no host_runner_path — skipping");
            None
        }
    } else {
        // AI-owned: prefer fresh content from split_data (Proceed / Tier 3
        // re-split paths), fall back to disk read (UseCached / Tier 2
        // diff_patch apply paths where split_data was constructed without
        // the host_runner field).
        let from_split = split_data
            .get("host_runner")
            .and_then(|v| v.get("content"))
            .and_then(|c| c.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string());
        if let Some(content) = from_split {
            // Persist generated runner under the manifest-declared internal role
            // path. Generated GPU roles must not materialize as normal user files.
            let host_runner_disk_name = split_data
                .get("host_runner")
                .and_then(|v| v.get("filename"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    adapted_module_filename(
                        &enrichment.adapted_status,
                        &ctx.workspace_path,
                        ModuleKind::HostRunner,
                        HOST_RUNNER_FILENAME,
                    )
                });
            let host_runner_disk = ctx.workspace_path.join(&host_runner_disk_name);
            match write_compile_request_file(&ctx.workspace_path, &host_runner_disk_name, &content)
                .await
            {
                Ok(()) => {
                    eprintln!(
                        "[HMR] host_runner: wrote {} bytes from split_data → {}",
                        content.len(),
                        host_runner_disk.display()
                    );
                }
                Err(e) => {
                    eprintln!("[HMR] host_runner: workspace write FAILED: {}", e);
                }
            }
            Some(content)
        } else if let Some(ref p) = enrichment.adapted_status.host_runner_path {
            // No fresh content (cached / tier-2 diff_patch path) — read
            // the on-disk copy. compile_runner's content cache will hit
            // for unchanged files so this is cheap.
            match tokio::fs::read_to_string(p).await {
                Ok(content) => {
                    eprintln!(
                        "[HMR] host_runner: reusing on-disk runner ({} bytes from {})",
                        content.len(),
                        p.display()
                    );
                    Some(content)
                }
                Err(e) => {
                    eprintln!("[HMR] host_runner: disk read failed: {}", e);
                    None
                }
            }
        } else {
            eprintln!(
                "[HMR] host_runner: no content from split_data or disk — skipping runner compile (pre-Phase-4 project)"
            );
            None
        }
    };

    // ============================================================
    // ULTRAPLAN Lightning Phase 9d — PARALLEL COMPILE DISPATCH
    // ============================================================
    //
    // compile_core, compile_gui, and compile_runner are independent
    // once `shared.h` is on disk and `host_runner_content` is
    // resolved. Run them concurrently via `tokio::join!` when the
    // worker has ≥3 cores available — on multicore hosts the wall-
    // clock drops from ~3×N serial to ~N parallel (capped by the
    // slowest stage).
    //
    // Gated on `num_cpus::get() >= 3` per rev3 §13 so single-core
    // container deployments don't pay the concurrent-compile overhead
    // (task scheduling, disk contention) for zero speedup benefit.
    //
    // compile_gui's `core_lib_path` parameter is vestigial — the
    // function only uses it inside a `_combined_hash` that's bound
    // to `_`. No actual ordering dependency. We pass an empty
    // String since it's unused downstream.
    //
    // Error reporting is deterministic: errors are collected in
    // source order (core → gui → runner) after the join completes,
    // so per-module diagnostics don't interleave on the log.
    // ── ULTRAPLAN Lightning Phase 11 — Tier 0 v2 compile bypass ──
    //
    // When tree-sitter classified the edit as value-only, run the
    // unified Tier 0 patcher: string byte-scan + DWARF line map +
    // iced-x86 integer immediate patching. Skips g++ entirely.
    // Gate: Tier 0 is only safe when compile flags prevent the
    // compiler from merging/folding string literals. Without -O0
    // and -fno-merge-constants, a literal that appears once in
    // source can end up shared or relocated in the binary, making
    // the byte-scan patch silently wrong.
    let tier0_flags_safe = compile_manifest
        .as_ref()
        .map(|m| m.tier0_safe())
        .unwrap_or(false);
    if tier0_v2_eligible && !tier0_flags_safe {
        eprintln!(
            "[HMR] Tier 0 BLOCKED: compile manifest missing -O0/-fno-merge-constants — \
             falling through to g++ (safe but slower)"
        );
    }

    let tier0_bypassed = if tier0_v2_eligible
        && rebuild_scope != RebuildScope::None
        && tier0_flags_safe
    {
        use crate::hmr::tier0_unified::{try_tier0_v2, Tier0V2Outcome};
        let t0_start = std::time::Instant::now();
        let old_src = tier0_old_source.as_deref().unwrap_or("");
        let tier0_core_filename = split_data
            .get("core")
            .and_then(|v| v.get("filename"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                adapted_module_filename(
                    &enrichment.adapted_status,
                    &ctx.workspace_path,
                    ModuleKind::Core,
                    "core.cpp",
                )
            });
        let tier0_gui_filename = split_data
            .get("gui")
            .and_then(|v| v.get("filename"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                adapted_module_filename(
                    &enrichment.adapted_status,
                    &ctx.workspace_path,
                    ModuleKind::Gui,
                    "gui.cpp",
                )
            });
        let source_files = [
            ("core", tier0_core_filename.as_str()),
            ("gui", tier0_gui_filename.as_str()),
        ];
        match try_tier0_v2(&output_dir, old_src, &req.source, &source_files) {
            Tier0V2Outcome::Patched(result) => {
                let t0_ms = t0_start.elapsed().as_millis();
                let total_ms = compile_start.elapsed().as_millis();

                // Phase 11d: try live memory patching to skip dlclose/dlopen.
                // If the runner is alive and we have patch_records with
                // file offsets, write directly to the runner's memory via
                // /proc/pid/mem. Eliminates the ~20ms dlopen cost.
                let live_patched = if !result.patch_records.is_empty() {
                    let guard = ctx.runner_store.lock().await;
                    if let Some(ref state) = *guard {
                        if let Some(ref child) = state.process {
                            if let Some(pid) = child.id() {
                                use crate::hmr::binary_patch::proc_mem_patcher::patch_live;
                                let mut all_ok = true;
                                for rec in &result.patch_records {
                                    match patch_live(
                                        pid,
                                        &rec.so_path,
                                        rec.file_offset,
                                        &rec.old_bytes,
                                        &rec.new_bytes,
                                    ) {
                                        Ok(()) => {}
                                        Err(e) => {
                                            eprintln!(
                                                "[HMR] Tier 0 live patch failed at {:#x}: {} — will reload",
                                                rec.file_offset, e
                                            );
                                            all_ok = false;
                                            break;
                                        }
                                    }
                                }
                                if all_ok {
                                    eprintln!(
                                        "[HMR] Tier 0 LIVE: patched {} record(s) in runner pid={}",
                                        result.patch_records.len(),
                                        pid
                                    );
                                }
                                all_ok
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                };

                let method = if live_patched {
                    "live-mem"
                } else {
                    "disk+reload"
                };
                eprintln!(
                    "[HMR] Tier 0 v2 SUCCESS ({}): {} string + {} integer + {} float patch(es) in {}ms (total: {}ms)",
                    method,
                    result.string_patches,
                    result.integer_patches,
                    result.float_patches,
                    t0_ms,
                    total_ms
                );
                if !result.skipped.is_empty() {
                    eprintln!("[HMR] Tier 0 v2 skipped: {}", result.skipped.join("; "));
                }
                TIER0_HITS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let payload = serde_json::json!({
                    "sessionId": session_id.clone(),
                    "type": "stderr",
                    "line": format!(
                        "[HMR] Tier 0 ({}): {}s + {}i + {}f in {}ms\n",
                        method, result.string_patches, result.integer_patches, result.float_patches, t0_ms
                    )
                });
                let _ = ctx
                    .log_dc
                    .send_text(serde_json::to_string(&payload).unwrap_or_default())
                    .await;
                true
            }
            Tier0V2Outcome::Ineligible(reason) => {
                TIER0_INELIGIBLE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                eprintln!("[HMR] Tier 0 v2 ineligible: {}", reason);
                false
            }
            Tier0V2Outcome::Failed(reason) => {
                TIER0_MISSES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                eprintln!(
                    "[HMR] Tier 0 v2 failed: {} — falling through to g++",
                    reason
                );
                false
            }
        }
    } else {
        if !tier0_v2_eligible {
            TIER0_INELIGIBLE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        false
    };

    // Log cumulative Tier 0 hit rate after every compile.
    {
        let hits = TIER0_HITS.load(std::sync::atomic::Ordering::Relaxed);
        let misses = TIER0_MISSES.load(std::sync::atomic::Ordering::Relaxed);
        let ineligible = TIER0_INELIGIBLE.load(std::sync::atomic::Ordering::Relaxed);
        let total = hits + misses + ineligible;
        if total > 0 {
            eprintln!(
                "[HMR] Tier 0 cumulative: {}/{} hits ({}%), {} misses, {} ineligible",
                hits,
                total,
                if total > 0 { hits * 100 / total } else { 0 },
                misses,
                ineligible
            );
        }
    }

    let has_gpu_device_stage = compile_manifest
        .as_ref()
        .and_then(|m| m.gpu.as_ref())
        .is_some()
        && device_source_content.is_some();
    let parallel_disabled_by_env = std::env::var("SYNTHI_DISABLE_PARALLEL_COMPILE")
        .ok()
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false);
    let use_parallel = num_cpus::get() >= 3 && !has_gpu_device_stage && !parallel_disabled_by_env;
    let mut reusable_core_path = prev_core_path.clone();
    let mut reusable_gui_path = prev_gui_path.clone();
    if reusable_core_path.is_none() || reusable_gui_path.is_none() {
        for p in crate::hmr::tier0_literal_patch::candidate_so_paths(&output_dir) {
            let name = p.file_name().unwrap_or_default().to_string_lossy();
            if name.contains("core") && reusable_core_path.is_none() {
                reusable_core_path = Some(p.to_string_lossy().to_string());
            } else if name.contains("gui") && reusable_gui_path.is_none() {
                reusable_gui_path = Some(p.to_string_lossy().to_string());
            }
        }
    }
    // Device-only builds may reuse host modules only when runner state proved
    // those modules belong to the same preview session. Filesystem fallbacks can
    // point at a previous workspace/session and are only safe for non-device
    // recovery paths that still rebuild or restart the host side.
    let device_only_compile_stage = can_compile_device_only_stage(
        &split_data,
        has_gpu_device_stage,
        prev_core_path.is_some(),
        prev_gui_path.is_some(),
        req.is_gui,
    );
    let allow_direct_translation_unit_partial = allow_direct_translation_unit_partial(
        &split_data,
        has_gpu_device_stage,
        prev_core_path.is_some(),
        prev_gui_path.is_some(),
        req.is_gui,
        &req.filename,
        compile_manifest.as_ref(),
    );
    if !tier0_bypassed {
        if device_only_compile_stage {
            eprintln!(
                "[HMR] device-only compile stage: reusing previous core/gui and compiling device sidecar only"
            );
        } else if use_parallel {
            eprintln!(
                "[HMR] parallel compile enabled (num_cpus={}) — dispatching core/gui/runner concurrently",
                num_cpus::get()
            );
        } else {
            eprintln!(
                "[HMR] parallel compile disabled (num_cpus={}, gpu_device_stage={}, env_disabled={}) — serial fallback",
                num_cpus::get(),
                has_gpu_device_stage,
                parallel_disabled_by_env
            );
        }
    }

    let (
        core_lib_path_opt,
        gui_lib_path_opt,
        host_runner_bin_path,
        device_compile_outcome,
        device_runtime_resume_deferred,
    ): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<DeviceCompileOutcome>,
        bool,
    ) = if tier0_bypassed {
        // Tier 0 patched existing .so files in place — skip g++.
        // Resolve paths from stable symlinks (cheap — two stat calls).
        // Prefer prev paths from runner_store, fall back to symlink
        // resolution for resilience against runner_store being cleared.
        let mut core_opt = prev_core_path.clone();
        let mut gui_opt = prev_gui_path.clone();
        if core_opt.is_none() || gui_opt.is_none() {
            for p in crate::hmr::tier0_literal_patch::candidate_so_paths(&output_dir) {
                let name = p.file_name().unwrap_or_default().to_string_lossy();
                if name.contains("core") && core_opt.is_none() {
                    core_opt = Some(p.to_string_lossy().to_string());
                } else if name.contains("gui") && gui_opt.is_none() {
                    gui_opt = Some(p.to_string_lossy().to_string());
                }
            }
        }
        (core_opt, gui_opt, None, None, false)
    } else if device_only_compile_stage {
        let (device_opt, runtime_resume_deferred) = if let (Some(sources), Some(manifest)) =
            (device_source_content.as_ref(), compile_manifest.as_ref())
        {
            compile_device_sources_phase0_and_refresh_catalog(
                ctx,
                &req,
                &output_dir,
                timestamp,
                sources,
                manifest,
                &sidecar_path,
                &session_id,
                allow_direct_translation_unit_partial,
                true,
            )
            .await?
        } else {
            (None, false)
        };
        (
            reusable_core_path.clone(),
            reusable_gui_path.clone(),
            None,
            device_opt,
            runtime_resume_deferred,
        )
    } else if use_parallel {
        // ─── Parallel path ──────────────────────────────────────────
        // Three futures run concurrently on the tokio runtime. The
        // compile_runner future is Ok(None) when there's no runner
        // content to compile — preserving the pre-Phase-9d semantics.
        let core_fut = compile_core(
            ctx,
            &split_data,
            &processed_core,
            rebuild_scope.clone(),
            prev_core_path.clone(),
            &output_dir,
            timestamp,
            ext,
            Some(session_id.clone()),
            compile_manifest.as_ref(),
        );
        let gui_fut = compile_gui(
            ctx,
            &split_data,
            &processed_gui,
            rebuild_scope.clone(),
            String::new(), // core_lib_path — vestigial in compile_gui
            &output_dir,
            timestamp,
            ext,
            Some(session_id.clone()),
            req.is_gui,
            compile_manifest.as_ref(),
        );
        let runner_fut = async {
            if let Some(ref content) = host_runner_content {
                compile_runner(
                    ctx,
                    content,
                    &output_dir,
                    timestamp,
                    Some(session_id.clone()),
                    compile_manifest.as_ref(),
                    CompileRunnerOptions::for_manifest(compile_manifest.as_ref()),
                )
                .await
            } else {
                Ok(None)
            }
        };
        let device_fut = async {
            if let (Some(sources), Some(manifest)) =
                (device_source_content.as_ref(), compile_manifest.as_ref())
            {
                compile_device_sources_phase0_and_refresh_catalog(
                    ctx,
                    &req,
                    &output_dir,
                    timestamp,
                    sources,
                    manifest,
                    &sidecar_path,
                    &session_id,
                    allow_direct_translation_unit_partial,
                    false,
                )
                .await
            } else {
                Ok((None, false))
            }
        };

        let (core_res, gui_res, runner_res, device_res) =
            tokio::join!(core_fut, gui_fut, runner_fut, device_fut);

        // Propagate core error first (it's the most load-bearing —
        // without core we can't even attempt to load the .so chain).
        let core_opt =
            compile_stage_or_invalidate_split_cache(&req, core_res, "compile_core_failed").await?;
        let gui_opt =
            compile_stage_or_invalidate_split_cache(&req, gui_res, "compile_gui_failed").await?;
        // Runner errors are non-fatal; a missing compiled runner falls
        // back to the shipped runner path for this compile.
        let runner_opt = match runner_res {
            Ok(p) => p,
            Err(e) => {
                eprintln!(
                    "[HMR] compile_runner FAILED (non-fatal; falling back to shipped runner for this compile): {}",
                    e
                );
                None
            }
        };
        let device_opt =
            compile_stage_or_invalidate_split_cache(&req, device_res, "compile_device_failed")
                .await?;
        (core_opt, gui_opt, runner_opt, device_opt.0, device_opt.1)
    } else {
        // ─── Serial fallback ───────────────────────────────────────
        let core_opt = compile_stage_or_invalidate_split_cache(
            &req,
            compile_core(
                ctx,
                &split_data,
                &processed_core,
                rebuild_scope.clone(),
                prev_core_path.clone(),
                &output_dir,
                timestamp,
                ext,
                Some(session_id.clone()),
                compile_manifest.as_ref(),
            )
            .await,
            "compile_core_failed",
        )
        .await?;

        let gui_opt = compile_stage_or_invalidate_split_cache(
            &req,
            compile_gui(
                ctx,
                &split_data,
                &processed_gui,
                rebuild_scope.clone(),
                String::new(),
                &output_dir,
                timestamp,
                ext,
                Some(session_id.clone()),
                req.is_gui,
                compile_manifest.as_ref(),
            )
            .await,
            "compile_gui_failed",
        )
        .await?;

        let runner_opt = if let Some(ref content) = host_runner_content {
            match compile_runner(
                ctx,
                content,
                &output_dir,
                timestamp,
                Some(session_id.clone()),
                compile_manifest.as_ref(),
                CompileRunnerOptions::for_manifest(compile_manifest.as_ref()),
            )
            .await
            {
                Ok(p) => p,
                Err(e) => {
                    eprintln!(
                        "[HMR] compile_runner FAILED (non-fatal; falling back to shipped runner for this compile): {}",
                        e
                    );
                    None
                }
            }
        } else {
            None
        };
        let device_opt = if let (Some(sources), Some(manifest)) =
            (device_source_content.as_ref(), compile_manifest.as_ref())
        {
            compile_stage_or_invalidate_split_cache(
                &req,
                compile_device_sources_phase0_and_refresh_catalog(
                    ctx,
                    &req,
                    &output_dir,
                    timestamp,
                    sources,
                    manifest,
                    &sidecar_path,
                    &session_id,
                    allow_direct_translation_unit_partial,
                    false,
                )
                .await,
                "compile_device_failed",
            )
            .await?
        } else {
            (None, false)
        };
        (core_opt, gui_opt, runner_opt, device_opt.0, device_opt.1)
    };

    let core_lib_path = core_lib_path_opt
        .ok_or_else(|| anyhow::anyhow!("Core compilation produced no output (no core module in split data or scope is GUI-only)"))?;
    let gui_lib_path = gui_lib_path_opt.unwrap_or(prev_gui_path.unwrap_or_default());

    if let Some(ref p) = host_runner_bin_path {
        eprintln!("[HMR] host_runner binary: {}", p);
    }
    let mut device_hmr_proof: Option<GpuHmrProofTelemetry> = None;
    let mut device_reload_artifact_blob: Option<ReloadArtifactBlob> = None;
    if let Some(ref out) = device_compile_outcome {
        device_reload_artifact_blob = Some(reload_artifact_blob_from_outcome(out).await?);
        let proof = device_hmr_proof_telemetry(out);
        let proof_sidecar_meta = read_normalized_split_sidecar_for_proof(&sidecar_path).await;
        let proof_artifact = write_device_hmr_proof_artifact(
            &ctx.workspace_path,
            req.slug.as_deref(),
            &session_id,
            &source_hash_str,
            out,
            device_source_content.as_ref(),
            &proof,
            proof_sidecar_meta.as_ref(),
        )
        .await?;
        let proof = proof.with_artifact_ref(proof_artifact.proof_id, proof_artifact.relative_path);
        let selected_artifact_bytes = out
            .selected_artifact_bytes
            .map(|bytes| bytes.to_string())
            .unwrap_or_else(|| "none".to_string());
        let full_device_bytes = out
            .full_device_bytes
            .map(|bytes| bytes.to_string())
            .unwrap_or_else(|| "none".to_string());
        eprintln!(
            "[compile-device] sidecar ready artifact={} compiler_ms={} stderr_bytes={} register_records={} partial={} symbols={} label={} fallbackUsed={} fallbackReason={} requestedArtifactKind={} selectedArtifactKind={} selectedArtifactBytes={} fullDeviceBytes={}",
            out.artifact_path.display(),
            out.compiler_elapsed_ms,
            out.stderr.len(),
            out.diagnostics.register_pressure.len(),
            out.partial_module,
            out.target_symbols.join(","),
            device_hmr_result_label(out),
            out.fallback_used,
            out.fallback_reason.as_deref().unwrap_or("none"),
            out.requested_artifact_kind.as_deref().unwrap_or("none"),
            out.selected_artifact_kind.as_deref().unwrap_or("none"),
            selected_artifact_bytes,
            full_device_bytes
        );
        eprintln!("[compile-device] {}", proof.to_log_line());
        let status = HmrStatus::gpu_proof_state_with_artifact(
            "device",
            &proof.result_state,
            proof.degraded_state.as_deref(),
            proof.degraded_reason.as_deref(),
            proof.label.as_deref(),
            proof.proof_id.as_deref(),
            proof.proof_artifact_path.as_deref(),
        );
        let _ = ctx.log_dc.send_text(status.to_json()).await;
        device_hmr_proof = Some(proof);
    }

    // ULTRAPLAN Phase 9e — emit cache hit-rate snapshot after every
    // compile so operators can watch the rate live. Cheap: atomic
    // loads only, no lock acquisition. Prints nothing on the first
    // compile of a session (all zeros) and starts reporting from
    // the second compile onward.
    let runtime_host_runner_bin_path = if compile_manifest
        .as_ref()
        .and_then(|m| m.gpu.as_ref())
        .is_some()
    {
        if host_runner_bin_path.is_some() {
            eprintln!(
                "[HMR] gpu manifest present: using shipped runner for GPU runtime boundary; per-project host_runner compiled only"
            );
        }
        None
    } else {
        host_runner_bin_path.clone()
    };

    ctx.incremental_cache.log_hit_rate_snapshot();

    // Manual logging
    debug_log!("[Compile] Step: Compilation finished");

    // ============================================================
    // PHASE 3.5: HMR PLANNER — decide reload strategy
    // ============================================================
    // Build a manifest from compile results and run the planner.
    // The planner produces a deterministic reload decision (warm/cold/
    // process-swap/full-restart) that guides runner execution.

    let build_time_ms = compile_start.elapsed().as_millis() as u64;

    // ── Compute dirty_units from rebuild scope ──
    let dirty_units: Vec<String> = match rebuild_scope {
        RebuildScope::CoreOnly => vec!["core".to_string()],
        RebuildScope::GuiOnly => vec!["gui".to_string()],
        RebuildScope::Both | RebuildScope::FullReload => {
            vec!["core".to_string(), "gui".to_string()]
        }
        RebuildScope::None => vec![],
    };

    let build_slot = match rebuild_scope {
        RebuildScope::CoreOnly => BuildSlot::Core,
        RebuildScope::GuiOnly => BuildSlot::Gui,
        _ => BuildSlot::Full,
    };

    let manifest_artifact_path = match rebuild_scope {
        RebuildScope::GuiOnly => gui_lib_path.clone(),
        _ if !core_lib_path.is_empty() => core_lib_path.clone(),
        _ => gui_lib_path.clone(),
    };

    let manifest_artifact_hash = match rebuild_scope {
        RebuildScope::CoreOnly => format!("{}", new_hashes.core_hash),
        RebuildScope::GuiOnly => format!("{}", new_hashes.gui_hash),
        _ => combined_hash(&[
            new_hashes.shared_hash,
            new_hashes.core_hash,
            new_hashes.gui_hash,
        ]),
    };

    let manifest_state_schema_hash = match rebuild_scope {
        RebuildScope::CoreOnly => format!("{}", new_hashes.core_hash),
        RebuildScope::GuiOnly => format!("{}", new_hashes.gui_hash),
        _ => combined_hash(&[new_hashes.core_hash, new_hashes.gui_hash]),
    };

    let prev_state_schema_hash = match rebuild_scope {
        RebuildScope::CoreOnly if prev_hashes.core_hash != 0 => {
            Some(format!("{}", prev_hashes.core_hash))
        }
        RebuildScope::GuiOnly if prev_hashes.gui_hash != 0 => {
            Some(format!("{}", prev_hashes.gui_hash))
        }
        _ if prev_hashes.core_hash != 0 || prev_hashes.gui_hash != 0 => Some(combined_hash(&[
            prev_hashes.core_hash,
            prev_hashes.gui_hash,
        ])),
        _ => None,
    };

    // ── Discover exported symbols from the artifact(s) behind this manifest ──
    let exported_symbols = match rebuild_scope {
        RebuildScope::GuiOnly => discover_exported_symbols(&gui_lib_path).await,
        RebuildScope::Both | RebuildScope::FullReload => {
            let mut symbols = discover_exported_symbols(&core_lib_path).await;
            if !gui_lib_path.is_empty() {
                symbols.extend(discover_exported_symbols(&gui_lib_path).await);
            }
            symbols.sort();
            symbols.dedup();
            symbols
        }
        _ => discover_exported_symbols(&core_lib_path).await,
    };

    // ── Validate required HMR entry points ──
    // Only check for core entry points when core was actually compiled.
    // GUI-only rebuilds won't have on_load (it's in core.so).
    if rebuild_scope != RebuildScope::GuiOnly {
        let has_on_load = exported_symbols.iter().any(|s| {
            s == "on_load" || s == "core_on_load" || s == "on_load_host" || s == "core_on_load_host"
        });
        if !has_on_load && !exported_symbols.is_empty() {
            let sym_list = exported_symbols.join(", ");
            let msg = format!(
                "Compiled .so is missing a required entry point (on_load / core_on_load). Exported symbols: [{}]",
                sym_list
            );
            debug_log!("[Handler] Symbol validation failed: {}", msg);
            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "stderr",
                "line": format!("[HMR Error] {}\n", msg)
            });
            let _ = ctx
                .log_dc
                .send_text(serde_json::to_string(&payload).unwrap_or_default())
                .await;
            anyhow::bail!(msg);
        }
    }

    // ── Determine capabilities from exported symbols ──
    let capabilities: Vec<String> = {
        let mut caps = Vec::new();
        let gpu_manifest_enabled = compile_manifest
            .as_ref()
            .and_then(|m| m.gpu.as_ref())
            .is_some();
        if exported_symbols
            .iter()
            .any(|s| s.contains("on_update") || s.contains("core_on_update"))
        {
            caps.push("hmr_state_update".to_string());
        }
        if exported_symbols
            .iter()
            .any(|s| s.contains("hmr_get_state_json"))
        {
            caps.push("json_state".to_string());
        }
        if exported_symbols
            .iter()
            .any(|s| s.contains("hmr_save_state_binary") || s.contains("on_save_state_binary"))
        {
            caps.push("binary_state".to_string());
        }
        if exported_symbols.iter().any(|s| s.contains("gui_on_render")) {
            caps.push("gui_render".to_string());
        }
        if gpu_manifest_enabled {
            let missing_gpu = missing_gpu_host_contract_symbols(&exported_symbols);
            if missing_gpu.is_empty() {
                caps.push("gpu_hotapi_contract".to_string());
            } else {
                caps.push("gpu_contract_incomplete".to_string());
                eprintln!(
                    "[GPU HMR] host GPU ABI incomplete missing={}",
                    missing_gpu.join(",")
                );
            }

            if has_gpu_state_serialization_symbols(&exported_symbols) {
                caps.push("gpu_managed_device_state".to_string());
            }
        }
        caps
    };

    // ── Snapshot modes from capabilities ──
    let snapshot_modes = {
        let mut modes = vec![];
        if capabilities.contains(&"binary_state".to_string()) {
            modes.push(SnapshotMode::Binary);
        }
        if capabilities.contains(&"json_state".to_string()) {
            modes.push(SnapshotMode::Json);
        }
        if modes.is_empty() {
            modes.push(SnapshotMode::None);
        }
        modes
    };

    let build_manifest = BuildManifest::for_language(session_id.clone(), language)
        .with_slot(build_slot)
        .with_artifact(&manifest_artifact_path, &manifest_artifact_hash)
        .with_abi_version(&format!("{}", new_hashes.shared_hash))
        .with_state_schema_hash(&manifest_state_schema_hash)
        .with_build_time(build_time_ms)
        .with_dirty_units(dirty_units.clone())
        .with_exported_symbols(exported_symbols)
        .with_capabilities(capabilities)
        .with_snapshot_modes(snapshot_modes);

    // Determine if ABI/schema changed from the previous build
    let abi_changed =
        prev_hashes.shared_hash != 0 && prev_hashes.shared_hash != new_hashes.shared_hash;
    let schema_changed = prev_state_schema_hash
        .as_deref()
        .map(|previous| previous != build_manifest.state_schema_hash)
        .unwrap_or(false);

    // Check if the existing runner supports warm reload
    let runtime_supports_warm = {
        let guard = ctx.runner_store.lock().await;
        guard.as_ref().map(|s| s.is_hmr_capable).unwrap_or(false)
    };

    let (planner_output, planner_notification, reload_result, mut pipeline_messages) = {
        let mut orchestrator = ctx.hmr_orchestrator.lock().await;
        let pipeline = orchestrator.pipeline(&session_id);

        let (planner_output, planner_notification) = pipeline.plan_reload(
            &build_manifest,
            abi_changed,
            schema_changed,
            runtime_supports_warm,
        );

        let mut notifications = pipeline.enqueue_candidate(&build_manifest, &planner_output);
        notifications
            .messages
            .extend(pipeline.tick_candidates(current_time_ms()).messages);

        let (reload_result, execute_notifications) = pipeline.execute_reload(
            language,
            &build_manifest,
            &planner_output,
            &format!("{}", reload_id),
        );
        notifications
            .messages
            .extend(execute_notifications.messages);

        (
            planner_output,
            planner_notification,
            reload_result,
            notifications.messages,
        )
    };

    let gpu_sidecar_loaded_by_runner = compile_manifest
        .as_ref()
        .and_then(|m| m.gpu.as_ref())
        .is_some();
    if gpu_sidecar_loaded_by_runner && device_compile_outcome.is_some() {
        debug_log!(
            "[GPU HMR] Skipping worker-side device reload; shipped runner will load sidecar"
        );
    } else if let (Some(device_outcome), Some(manifest)) =
        (device_compile_outcome.as_ref(), compile_manifest.as_ref())
    {
        if let Some(gpu) = manifest.gpu.as_ref() {
            let device_source = device_outcome.compiled_source.as_str();
            let gpu_language = gpu.vendor.as_str();
            let device_filename = device_filename_for_vendor(gpu.vendor);
            let mut device_dirty_units = dirty_units.clone();
            if !device_dirty_units.iter().any(|u| u == device_filename) {
                device_dirty_units.push(device_filename.to_string());
            }
            let kernel_symbols = device_reload_kernel_symbol_specs(device_source, device_outcome);
            let kernel_abi = kernel_abi_fingerprint_source(device_source);
            let artifact_path = device_outcome.artifact_path.to_string_lossy().to_string();
            let artifact_hash = format!(
                "{}",
                hash_content(&format!(
                    "{}:{}:{}",
                    artifact_path,
                    device_outcome.stderr.len(),
                    kernel_abi
                ))
            );
            let mut capabilities = vec![
                "gpu_sidecar_module".to_string(),
                "synthi_gpu_launch".to_string(),
                format!("gpu_hmr_result:{}", device_hmr_result_label(device_outcome)),
                format!("gpu_hmr_fallback_used:{}", device_outcome.fallback_used),
            ];
            if let Some(reason) = device_outcome.fallback_reason.as_deref() {
                capabilities.push(format!("gpu_hmr_fallback_reason:{reason}"));
            }
            if device_outcome.partial_module {
                capabilities.push("gpu_sidecar_partial_module".to_string());
            }
            let device_manifest = BuildManifest::for_language(session_id.clone(), gpu_language)
                .with_slot(BuildSlot::Custom("device".into()))
                .with_artifact(&artifact_path, &artifact_hash)
                .with_abi_version(&format!("{}", hash_content(&kernel_abi)))
                .with_state_schema_hash(&format!("{}", hash_content(device_source)))
                .with_build_time(device_outcome.compiler_elapsed_ms)
                .with_dirty_units(device_dirty_units)
                .with_exported_symbols(kernel_symbols)
                .with_capabilities(capabilities)
                .with_snapshot_modes(vec![SnapshotMode::Binary]);

            let (gpu_reload_result, gpu_notifications) = {
                let mut orchestrator = ctx.hmr_orchestrator.lock().await;
                orchestrator
                    .pipeline(&session_id)
                    .execute_gpu_device_reload(
                        gpu_language,
                        &device_manifest,
                        device_reload_artifact_blob.clone(),
                        &format!("{}-device", reload_id),
                    )
            };
            debug_log!(
                "[GPU HMR] Device reload result for {}: {:?}",
                gpu_language,
                gpu_reload_result
            );
            pipeline_messages.extend(gpu_notifications.messages);
        }
    }

    // Send planner decision to the frontend
    if let Ok(planner_json) = serde_json::to_string(&planner_notification) {
        let _ = ctx.log_dc.send_text(planner_json).await;
    }
    debug_log!(
        "[HMR Planner] Decision: {:?} — {}",
        planner_output.decision,
        planner_output.reason.decision_reason
    );

    // Execute adapter reload and collect notifications
    // Send all pipeline notifications to the frontend (adapter_status,
    // state_restore_status, adapter_health, etc.)
    for msg in &pipeline_messages {
        let _ = ctx.log_dc.send_text(msg.clone()).await;
    }

    // If the planner chose an in-process reload and the adapter succeeded,
    // skip the old runner restart path entirely — the reload is done.
    let dynlib_family = matches!(
        build_manifest.adapter_family.as_str(),
        "DynamicLibrary" | "dynamic_library" | "dynlib"
    );
    let adapter_handled = match (&planner_output.decision, &reload_result) {
        (
            crate::hmr::planner_decision::ReloadDecision::ProcessSwap,
            AdapterReloadResult::Success {
                state_preserved,
                reload_ms,
            },
        ) if !dynlib_family => {
            debug_log!(
                "[HMR] Process-swap reload completed authoritatively: state_preserved={}, reload_ms={}",
                state_preserved, reload_ms
            );
            true
        }
        (
            crate::hmr::planner_decision::ReloadDecision::ProcessSwap,
            AdapterReloadResult::Success {
                state_preserved,
                reload_ms,
            },
        ) => {
            debug_log!(
                "[HMR] Dynlib adapter preflight reached a process-swap plan (state_preserved={}, reload_ms={}); delegating actual reload to runner",
                state_preserved, reload_ms
            );
            false
        }
        (
            decision,
            AdapterReloadResult::Success {
                state_preserved,
                reload_ms,
            },
        ) if decision.is_in_process() && !dynlib_family => {
            debug_log!(
                "[HMR] Adapter reload completed authoritatively: state_preserved={}, reload_ms={}",
                state_preserved,
                reload_ms
            );
            true
        }
        (
            decision,
            AdapterReloadResult::Success {
                state_preserved,
                reload_ms,
            },
        ) if decision.is_in_process() && dynlib_family => {
            debug_log!(
                "[HMR] Dynlib adapter preflight succeeded (state_preserved={}, reload_ms={}), delegating actual swap to runner",
                state_preserved, reload_ms
            );
            false
        }
        _ => {
            debug_log!(
                "[HMR] Adapter did not handle reload (decision={:?}, result={:?}), falling through to runner",
                planner_output.decision, reload_result
            );
            false
        }
    };

    // ============================================================
    // PHASE 4: EXECUTION / HOT RELOAD
    // ============================================================

    // Determine modules to load
    let mut modules_to_load = Vec::new();

    // When on the deterministic path (no AI split) and the source is a standard main() app
    // (no core_on_load/core_on_update exports), load as a single "main" module.
    // The runner's "main" slot accepts entrypoint() which guardrails add for main() apps.
    let is_blocking_main_app = enrichment.is_deterministic()
        && !processed_core.contains("core_on_load")
        && !processed_core.contains("core_on_update")
        && (processed_core.contains("int main(") || processed_core.contains("entrypoint"));

    match rebuild_scope {
        RebuildScope::Both | RebuildScope::FullReload => {
            if is_blocking_main_app {
                // Load user's code as "main" module (accepts entrypoint symbol)
                modules_to_load.push(("main".to_string(), core_lib_path.clone()));
            } else {
                modules_to_load.push(("core".to_string(), core_lib_path.clone()));
                if !gui_lib_path.is_empty() && !processed_gui.trim().is_empty() {
                    modules_to_load.push(("gui".to_string(), gui_lib_path.clone()));
                }
            }
        }
        RebuildScope::CoreOnly => {
            if is_blocking_main_app {
                modules_to_load.push(("main".to_string(), core_lib_path.clone()));
            } else {
                modules_to_load.push(("core".to_string(), core_lib_path.clone()));
                // CRITICAL: GUI must also reload when core changes.
                // gui_on_render receives core's state (app_state.raw) and the GUI
                // module caches the CoreAPI pointer from core_get_api(). After core
                // is swapped to a new .so, the old GUI's cached pointers become
                // dangling.  Re-loading GUI forces gui_on_load to re-acquire the
                // new core's API and re-bind to the new AppState layout.
                if !gui_lib_path.is_empty() && !processed_gui.trim().is_empty() {
                    modules_to_load.push(("gui".to_string(), gui_lib_path.clone()));
                }
            }
        }
        RebuildScope::GuiOnly => {
            if !gui_lib_path.is_empty() && !processed_gui.trim().is_empty() {
                modules_to_load.push(("gui".to_string(), gui_lib_path.clone()));
            }
        }
        RebuildScope::None => {
            // Nothing to load
        }
    }

    if let (Some(device_outcome), Some(manifest)) =
        (device_compile_outcome.as_ref(), compile_manifest.as_ref())
    {
        if let Some(gpu) = manifest.gpu.as_ref() {
            let device_source = device_outcome.compiled_source.as_str();
            let kernel_symbol_specs =
                device_reload_kernel_symbol_specs(device_source, device_outcome);
            let kernel_abi_hash = format!(
                "{}",
                hash_content(&kernel_abi_fingerprint_source(device_source))
            );
            let marker = if device_outcome.partial_module {
                "__gpu_device_partial"
            } else {
                "__gpu_device"
            };
            let proof = device_hmr_proof
                .as_ref()
                .cloned()
                .unwrap_or_else(|| device_hmr_proof_telemetry(device_outcome));
            eprintln!(
                "[compile-device] reload package label={} fallbackUsed={} fallbackReason={} requestedArtifactKind={} selectedArtifactKind={} selectedArtifactBytes={} fullDeviceBytes={}",
                device_hmr_result_label(device_outcome),
                device_outcome.fallback_used,
                device_outcome.fallback_reason.as_deref().unwrap_or("none"),
                device_outcome
                    .requested_artifact_kind
                    .as_deref()
                    .unwrap_or("none"),
                device_outcome
                    .selected_artifact_kind
                    .as_deref()
                    .unwrap_or("none"),
                device_outcome
                    .selected_artifact_bytes
                    .map(|bytes| bytes.to_string())
                    .unwrap_or_else(|| "none".to_string()),
                device_outcome
                    .full_device_bytes
                    .map(|bytes| bytes.to_string())
                    .unwrap_or_else(|| "none".to_string())
            );
            eprintln!("[compile-device] {}", proof.to_log_line());
            let device_cmd = format!(
                "{}:{}:{}:{}",
                marker,
                gpu.vendor.as_str(),
                encode_gpu_kernel_command_specs(&kernel_symbol_specs),
                kernel_abi_hash
            );
            modules_to_load.insert(
                0,
                (
                    device_cmd,
                    device_outcome.artifact_path.to_string_lossy().to_string(),
                ),
            );
        }
    }

    // Check for `on_update` to determine if we can HMR or need restart
    let has_on_update =
        processed_core.contains("on_update") || processed_core.contains("core_on_update");

    // If the adapter already handled the reload in-process, skip the runner path.
    if adapter_handled {
        let authoritative_reload_ms = match &reload_result {
            AdapterReloadResult::Success { reload_ms, .. } => *reload_ms,
            _ => compile_start.elapsed().as_millis() as u64,
        };
        let candidate_messages = {
            let mut orchestrator = ctx.hmr_orchestrator.lock().await;
            orchestrator
                .pipeline(&session_id)
                .validate_active_candidate(authoritative_reload_ms)
                .messages
        };
        for msg in candidate_messages {
            let _ = ctx.log_dc.send_text(msg).await;
        }
        debug_log!("[HMR] Skipping handle_runner_execution — adapter reload was authoritative");
        // Resolve the frontend's compile() promise so the IDE doesn't stay stuck
        // in "Compiling..." when the adapter handled the reload without going through
        // handle_runner_execution (which is where build-status: done is normally sent).
        let done_payload = serde_json::json!({
            "sessionId": session_id.clone(),
            "status": "done",
            "success": true,
            "stage": "adapter",
        });
        let _ = ctx
            .log_dc
            .send_text(serde_json::to_string(&done_payload).unwrap_or_default())
            .await;
        return Ok(serde_json::json!({ "status": "ok", "hmr": "adapter_handled" }));
    }

    // ── ULTRAPLAN Lightning Phase 12.6 — supervisor dispatch ──
    //
    // When SYNTHI_PATH_C_SUPERVISOR=1 and a per-project runner binary
    // exists, route through the supervisor (typed IPC, per-session Xvfb)
    // instead of the legacy stdin text protocol. The supervisor owns
    // the child lifecycle and Xvfb display, while GStreamer/WebRTC
    // remain in the worker (captured from the per-session display).
    let use_supervisor = std::env::var("SYNTHI_PATH_C_SUPERVISOR")
        .map(|v| v == "1")
        .unwrap_or(false)
        && runtime_host_runner_bin_path.is_some();

    let device_sidecar_only_reload = is_device_sidecar_only_reload(&modules_to_load);

    let runner_reload_policy = if planner_output.decision.is_in_process() {
        RunnerReloadPolicy::default()
    } else {
        RunnerReloadPolicy::require_runner_restart(vec![planner_output
            .reason
            .decision_code
            .clone()])
    };

    let runtime_reload_start = std::time::Instant::now();
    let mut device_sidecar_status_rx =
        if device_runtime_resume_deferred && device_sidecar_only_reload {
            subscribe_active_runner_output(ctx, &session_id).await
        } else {
            None
        };
    let runner_result = if use_supervisor {
        use crate::runtime::path_c::supervisor::spawn_supervised;

        let bin_path = runtime_host_runner_bin_path.as_ref().unwrap();
        let req_width = req.width.unwrap_or(800);
        let req_height = req.height.unwrap_or(600);

        let mut sup_guard = ctx.supervisor_store.lock().await;
        if !runner_reload_policy.allow_existing_runner_reload && sup_guard.is_some() {
            eprintln!(
                "[HMR] Phase 12.6: restarting supervised session for reload policy reasons: {}",
                runner_reload_policy.reason_codes.join(",")
            );
            if let Some(mut session) = sup_guard.take() {
                let _ = session.shutdown().await;
            }
        }
        let result = if let Some(ref mut session) = *sup_guard {
            // Existing supervisor session — send reload commands via IPC
            eprintln!("[HMR] Phase 12.6: reusing supervised session (IPC reload)");
            let mut ok = true;
            for (name, path) in &modules_to_load {
                if let Err(e) = session.reload_module(name, path).await {
                    eprintln!("[HMR] Phase 12.6: IPC reload failed for {}: {}", name, e);
                    ok = false;
                    break;
                }
            }
            if ok {
                Ok(())
            } else {
                anyhow::bail!("supervisor IPC reload failed")
            }
        } else {
            // First compile — spawn supervised session
            eprintln!("[HMR] Phase 12.6: spawning supervised session");
            let mut alloc = ctx.xvfb_allocator.lock().await;
            match spawn_supervised(
                &mut alloc,
                &session_id,
                std::path::Path::new(bin_path),
                &output_dir,
                req_width,
                req_height,
            )
            .await
            {
                Ok(mut session) => {
                    // Set session and load initial modules
                    let _ = session.set_session(&session_id).await;
                    let mut ok = true;
                    for (name, path) in &modules_to_load {
                        if let Err(e) = session.load_module(name, path).await {
                            eprintln!("[HMR] Phase 12.6: initial load failed for {}: {}", name, e);
                            ok = false;
                            break;
                        }
                    }
                    *sup_guard = Some(session);
                    if ok {
                        Ok(())
                    } else {
                        anyhow::bail!("supervisor initial load failed")
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[HMR] Phase 12.6: supervisor spawn failed: {} — falling back to legacy",
                        e
                    );
                    drop(sup_guard);
                    drop(alloc);
                    handle_runner_execution(
                        ctx,
                        &req,
                        modules_to_load,
                        has_on_update,
                        enrichment.use_ai_split,
                        new_hashes,
                        core_lib_path.clone(),
                        gui_lib_path.clone(),
                        Some(session_id.clone()),
                        runtime_host_runner_bin_path.clone(),
                        runner_reload_policy.clone(),
                    )
                    .await
                    .map_err(|e| e.into())
                }
            }
        };
        result
    } else {
        handle_runner_execution(
            ctx,
            &req,
            modules_to_load,
            has_on_update,
            enrichment.use_ai_split,
            new_hashes,
            core_lib_path,
            gui_lib_path,
            Some(session_id.clone()),
            runtime_host_runner_bin_path.clone(),
            runner_reload_policy.clone(),
        )
        .await
    };

    match runner_result {
        Ok(()) => {
            if device_sidecar_only_reload {
                debug_log!(
                    "[HMR] Device-only runner reload dispatched; waiting for runner GPU sidecar status"
                );
                if let Some(output_rx) = device_sidecar_status_rx.as_mut() {
                    if let Err(error) = wait_for_runner_device_sidecar_status(output_rx).await {
                        let status = HmrStatus::gpu_rejected_with_fallback_reason(
                            "device",
                            &format!(
                                "Runner did not acknowledge device sidecar reload before GPU HMR resume: {error}"
                            ),
                            "Keep previous GPU sidecar loaded and restart or reload the preview before applying another GPU HMR patch",
                            "runtime.device_reload_not_acknowledged",
                        );
                        let _ = ctx.log_dc.send_text(status.to_json()).await;
                        if device_runtime_resume_deferred {
                            let _ = resume_active_runner_after_gpu_hmr(ctx, &session_id).await;
                        }
                        return Err(
                            error.context("runner device sidecar reload was not acknowledged")
                        );
                    }
                } else if device_runtime_resume_deferred {
                    let error = anyhow::anyhow!(
                        "active runner output subscription was unavailable for deferred device sidecar reload"
                    );
                    let status = HmrStatus::gpu_rejected_with_fallback_reason(
                        "device",
                        &format!(
                            "Runner did not expose device sidecar reload status before GPU HMR resume: {error}"
                        ),
                        "Keep previous GPU sidecar loaded and restart or reload the preview before applying another GPU HMR patch",
                        "runtime.device_reload_status_unavailable",
                    );
                    let _ = ctx.log_dc.send_text(status.to_json()).await;
                    let _ = resume_active_runner_after_gpu_hmr(ctx, &session_id).await;
                    return Err(error);
                }
            }
            if device_runtime_resume_deferred {
                resume_active_runner_after_gpu_hmr(ctx, &session_id).await?;
            }
            if !device_sidecar_only_reload {
                let candidate_messages = {
                    let mut orchestrator = ctx.hmr_orchestrator.lock().await;
                    orchestrator
                        .pipeline(&session_id)
                        .validate_active_candidate(
                            runtime_reload_start.elapsed().as_millis() as u64,
                        )
                        .messages
                };
                for msg in candidate_messages {
                    let _ = ctx.log_dc.send_text(msg).await;
                }
            }
        }
        Err(error) => {
            if device_runtime_resume_deferred {
                let _ = resume_active_runner_after_gpu_hmr(ctx, &session_id).await;
            }
            let status = HmrStatus::compile_error("runner", vec![error.to_string()]);
            let _ = ctx.log_dc.send_text(status.to_json()).await;
            let candidate_messages = {
                let mut orchestrator = ctx.hmr_orchestrator.lock().await;
                orchestrator
                    .pipeline(&session_id)
                    .reject_active_candidate(error.to_string())
                    .messages
            };
            for msg in candidate_messages {
                let _ = ctx.log_dc.send_text(msg).await;
            }
            return Err(error);
        }
    }

    Ok(serde_json::json!({ "status": "ok" }))
}

fn current_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn combined_hash(parts: &[u64]) -> String {
    parts
        .iter()
        .map(|part| format!("{:016x}", part))
        .collect::<Vec<_>>()
        .join(":")
}

// ============================================================
// HELPER: hash-based rebuild scope (fallback for Loop B)
// ============================================================
fn hash_based_rebuild_scope(prev_hashes: &ModuleHashes, new_hashes: &ModuleHashes) -> RebuildScope {
    if prev_hashes.shared_hash == 0 && prev_hashes.core_hash == 0 && prev_hashes.gui_hash == 0 {
        debug_log!("[Handler] First build - Full Rebuild");
        RebuildScope::Both
    } else if prev_hashes.shared_hash != new_hashes.shared_hash {
        debug_log!("[Handler] Shared header changed - Full Rebuild");
        RebuildScope::Both
    } else if prev_hashes.core_hash != new_hashes.core_hash {
        debug_log!("[Handler] Core changed - Core Rebuild");
        RebuildScope::CoreOnly
    } else if prev_hashes.gui_hash != new_hashes.gui_hash {
        debug_log!("[Handler] GUI changed - GUI Rebuild");
        RebuildScope::GuiOnly
    } else {
        debug_log!("[Handler] No code changes detected");
        RebuildScope::None
    }
}

// ============================================================
// HELPER: discover exported symbols from compiled .so
// ============================================================
async fn discover_exported_symbols(lib_path: &str) -> Vec<String> {
    // Try to read the ELF symtab via nm; fall back to empty if unavailable.
    let output = tokio::process::Command::new("nm")
        .args(["-D", "--defined-only", "--format=posix", lib_path])
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|line| {
                    // POSIX format: "symbol_name T addr size"
                    let name = line.split_whitespace().next()?;
                    // Only keep T (text/code) symbols
                    let sym_type = line.split_whitespace().nth(1)?;
                    if sym_type == "T" {
                        Some(name.to_string())
                    } else {
                        None
                    }
                })
                .collect()
        }
        _ => vec![],
    }
}

/// Build a simple unified-diff-style string from two sources.
/// Not a proper unified diff — just shows changed/added/removed lines
/// with +/- prefixes so the AI can see what changed.
pub(crate) fn build_simple_diff(old: &str, new: &str) -> String {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    if old_lines == new_lines {
        return String::new();
    }

    let mut diff = String::new();
    let mut oi = 0;
    let mut ni = 0;

    while oi < old_lines.len() && ni < new_lines.len() {
        if old_lines[oi] == new_lines[ni] {
            // Context line
            diff.push_str(&format!(" {}\n", old_lines[oi]));
            oi += 1;
            ni += 1;
        } else {
            // Changed line
            diff.push_str(&format!("-{}\n", old_lines[oi]));
            diff.push_str(&format!("+{}\n", new_lines[ni]));
            oi += 1;
            ni += 1;
        }
    }
    while oi < old_lines.len() {
        diff.push_str(&format!("-{}\n", old_lines[oi]));
        oi += 1;
    }
    while ni < new_lines.len() {
        diff.push_str(&format!("+{}\n", new_lines[ni]));
        ni += 1;
    }

    diff
}

#[cfg(test)]
mod gpu_host_contract_tests {
    use super::*;
    use crate::compiler::stages::compile_device::DeviceCompileProofMetadata;

    static WORKSPACE_FILE_REF_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    const FIXTURE_GENERATED_DEVICE_PATH: &str = ".synthi/generated/gpu/device.hip";
    const FIXTURE_SOURCE_PATH: &str = "fixtures/device/source.hip";
    const FIXTURE_SYMBOL: &str = "fixture_kernel_a";
    const FIXTURE_SIBLING_SYMBOL: &str = "fixture_kernel_b";
    const FIXTURE_SOURCE_PARTIAL_FILENAME: &str = ".synthi/generated/gpu/device.partial.source.hip";
    const FIXTURE_KERNEL_PARTIAL_FILENAME: &str = ".synthi/generated/gpu/device.partial.kernel.hip";

    fn symbols(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    }

    fn fixture_kernel_source(symbol: &str) -> String {
        format!("extern \"C\" __global__ void {symbol}() {{ }}")
    }

    fn fixture_source_include_partial(path: &str) -> String {
        format!("// synthi-gpu-hmr: source include partial\n#include \"{path}\"\n")
    }

    fn fixture_rocm_manifest(device_path: &str) -> CompileManifest {
        serde_json::from_value(serde_json::json!({
            "compiler": "clang++",
            "std": "c++26",
            "common_flags": [],
            "core_link_flags": [],
            "gui_link_flags": [],
            "shared_link_flags": [],
            "runner_link_flags": [],
            "module_files": {
                "device": device_path
            },
            "system_packages": [],
            "hot_reload_mode": "swap",
            "confidence": {
                "overall": "high",
                "runner_synthesis": "high",
                "link_flags": "high",
                "notes": ""
            },
            "gpu": {
                "vendor": "rocm",
                "device_compiler": "hipcc",
                "arch": ["gfx1201"],
                "device_flags": ["-O3"],
                "runtime_libs": ["amdhip64"],
                "snapshot_mode": "auto",
                "fatbin_strategy": "sidecar_module"
            }
        }))
        .expect("fixture manifest should parse")
    }

    fn fixture_device_outcome(
        partial_module: bool,
        target_symbols: Vec<String>,
        artifact_exported_symbols: Vec<String>,
    ) -> DeviceCompileOutcome {
        DeviceCompileOutcome {
            artifact_path: std::path::PathBuf::from("/tmp/device.hsaco"),
            compiled_source: String::new(),
            compiler_elapsed_ms: 0,
            partial_module,
            target_symbols,
            fallback_used: false,
            fallback_reason: None,
            requested_artifact_kind: None,
            selected_artifact_kind: None,
            selected_artifact_bytes: None,
            full_device_bytes: None,
            artifact_exported_symbols,
            diagnostics:
                crate::compiler::stages::ptxas_info_parser::GpuToolchainDiagnostics::default(),
            stderr: String::new(),
            proof_metadata: DeviceCompileProofMetadata::default(),
        }
    }

    #[test]
    fn direct_workspace_partial_requires_manifest_device_hmr_context() {
        let manifest = fixture_rocm_manifest("device.hip");
        let split_data = serde_json::json!({
            "_synthi_reload_plan": direct_device_split_file_reload_plan("device.hip")
        });

        assert!(manifest_device_source_matches(
            "device.hip",
            Some(&manifest)
        ));
        assert!(allow_direct_translation_unit_partial(
            &split_data,
            true,
            true,
            true,
            true,
            "device.hip",
            Some(&manifest),
        ));
        assert!(!allow_direct_translation_unit_partial(
            &split_data,
            true,
            false,
            true,
            true,
            "device.hip",
            Some(&manifest),
        ));
        assert!(!allow_direct_translation_unit_partial(
            &split_data,
            true,
            true,
            true,
            true,
            "kernels/device_helpers.h",
            Some(&manifest),
        ));
        assert!(!allow_direct_translation_unit_partial(
            &serde_json::json!({}),
            true,
            true,
            true,
            true,
            "device.hip",
            Some(&manifest),
        ));
    }

    #[test]
    fn partial_source_contract_preserves_fallback_metadata() {
        let split = serde_json::json!({
            "_synthi_device_partial": {
                "content": "extern \"C\" __global__ void shade() {}",
                "filename": ".synthi/generated/gpu/device.partial.hip",
                "symbols": ["shade"],
                "artifactKind": "source_include_bridge",
                "fallbackReason": "selection.source_path_mismatch",
                "requirePartial": true
            }
        });

        let partial = split_partial_device_source(&split).expect("partial source");
        assert_eq!(partial.filename, ".synthi/generated/gpu/device.partial.hip");
        assert_eq!(partial.symbols, vec!["shade".to_string()]);
        assert!(partial.required);
        assert_eq!(
            partial.artifact_kind.as_deref(),
            Some("source_include_bridge")
        );
        assert_eq!(
            partial.fallback_reason.as_deref(),
            Some("selection.source_path_mismatch")
        );
    }

    #[test]
    fn partial_device_source_requires_live_runtime_anchor() {
        let sources = DeviceCompileSources {
            full_source: "extern \"C\" __global__ void shade() {}".to_string(),
            full_filename: Some(".synthi/generated/gpu/device.hip".to_string()),
            full_symbols: vec!["shade".to_string()],
            direct_workspace_source: false,
            partial_source: Some("extern \"C\" __global__ void shade() {}".to_string()),
            partial_filename: Some(".synthi/generated/gpu/device.partial.hip".to_string()),
            partial_symbols: vec!["shade".to_string()],
            partial_source_paths: vec!["src/gpu/shade.h".to_string()],
            partial_required: true,
            partial_artifact_kind: Some("source_include_bridge".to_string()),
            partial_fallback_reason: None,
        };

        assert!(should_compile_partial_device_source(&sources, true));
        assert!(!should_compile_partial_device_source(&sources, false));
    }

    #[test]
    fn runtime_control_ack_matches_structured_runner_token() {
        let line = r#"[Runner] [HMR-STATUS] {"status":"runtime-paused","module":"runner","runtimeControlToken":"runner-control-7","runtimePaused":true}"#;

        assert!(runner_runtime_control_ack_matches(
            line,
            "runtime-paused",
            "runner-control-7"
        ));
        assert!(!runner_runtime_control_ack_matches(
            line,
            "runtime-resumed",
            "runner-control-7"
        ));
        assert!(!runner_runtime_control_ack_matches(
            line,
            "runtime-paused",
            "runner-control-8"
        ));
    }

    #[test]
    fn runtime_control_ack_ignores_unstructured_logs() {
        assert!(!runner_runtime_control_ack_matches(
            "[Runner] Runtime update/render paused for external HMR work",
            "runtime-paused",
            "runner-control-1"
        ));
    }

    #[test]
    fn device_sidecar_status_matches_terminal_device_hmr() {
        let applied = r#"[Runner] [HMR-STATUS] {"status":"applied","module":"device","capability":"GPU sidecar HMR","state_preserved":true}"#;
        assert!(runner_device_sidecar_status(applied).unwrap().is_ok());

        let rejected = r#"[Runner] [HMR-STATUS] {"status":"rejected","module":"device","reason":"driver rejected module"}"#;
        let err = runner_device_sidecar_status(rejected).unwrap().unwrap_err();
        assert!(err.contains("driver rejected module"));
    }

    #[test]
    fn device_sidecar_status_ignores_non_device_hmr() {
        let runner_status = r#"[Runner] [HMR-STATUS] {"status":"runtime-paused","module":"runner","runtimePaused":true}"#;
        assert!(runner_device_sidecar_status(runner_status).is_none());
    }

    #[test]
    fn runtime_control_ack_timeout_covers_plugin_watchdog() {
        assert!(DEFAULT_RUNNER_RUNTIME_CONTROL_ACK_TIMEOUT_MS > PLUGIN_TIMEOUT_SECS * 1_000);
    }

    #[test]
    fn device_sidecar_only_reload_accepts_full_and_partial_markers() {
        assert!(is_device_sidecar_only_reload(&[(
            "__gpu_device:rocm:shade:abi".to_string(),
            "/tmp/device.hsaco".to_string(),
        )]));
        assert!(is_device_sidecar_only_reload(&[(
            "__gpu_device_partial:rocm:shade:abi".to_string(),
            "/tmp/device.partial.hsaco".to_string(),
        )]));
        assert!(is_device_sidecar_only_reload(&[
            (
                "__gpu_device_partial:rocm:shade:abi".to_string(),
                "/tmp/device.partial.hsaco".to_string(),
            ),
            (
                "__gpu_device:rocm:all:abi".to_string(),
                "/tmp/device.hsaco".to_string(),
            ),
        ]));
        assert!(!is_device_sidecar_only_reload(&[]));
        assert!(!is_device_sidecar_only_reload(&[
            (
                "__gpu_device_partial:rocm:shade:abi".to_string(),
                "/tmp/device.partial.hsaco".to_string(),
            ),
            ("core".to_string(), "/tmp/libcore.so".to_string()),
        ]));
    }

    #[test]
    fn device_hmr_result_label_marks_degraded_full_fallback() {
        let outcome = DeviceCompileOutcome {
            artifact_path: std::path::PathBuf::from("/tmp/device.hsaco"),
            compiled_source: String::new(),
            compiler_elapsed_ms: 0,
            partial_module: false,
            target_symbols: Vec::new(),
            fallback_used: true,
            fallback_reason: Some("partial_compile_failed".to_string()),
            requested_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_kind: Some("full_device".to_string()),
            selected_artifact_bytes: Some(4096),
            full_device_bytes: Some(4096),
            artifact_exported_symbols: Vec::new(),
            diagnostics:
                crate::compiler::stages::ptxas_info_parser::GpuToolchainDiagnostics::default(),
            stderr: String::new(),
            proof_metadata: DeviceCompileProofMetadata::default(),
        };

        assert_eq!(
            device_hmr_result_label(&outcome),
            "gpu-hmr-degraded-full-device"
        );
        assert_eq!(
            outcome.fallback_reason.as_deref(),
            Some("partial_compile_failed")
        );
    }

    #[test]
    fn device_hmr_proof_reports_symbol_bound_but_dispatch_unobserved() {
        let outcome = fixture_device_outcome(true, symbols(&["shade"]), symbols(&["_Z5shadePi"]));

        let proof = device_hmr_proof_telemetry(&outcome);

        assert_eq!(proof.result_state, "gpu-hmr-symbol-bound");
        assert_eq!(
            proof.degraded_state.as_deref(),
            Some("gpu-hmr-dispatch-unobserved")
        );
        assert_eq!(
            proof.degraded_reason.as_deref(),
            Some("runtime_dispatch_not_observed")
        );
        assert_eq!(proof.label.as_deref(), Some("gpu-hmr-partial"));
    }

    #[test]
    fn device_hmr_proof_stays_compile_proven_without_export_evidence() {
        let outcome = fixture_device_outcome(true, symbols(&["shade"]), Vec::new());

        let proof = device_hmr_proof_telemetry(&outcome);

        assert_eq!(proof.result_state, "gpu-hmr-compile-proven");
        assert_eq!(
            proof.degraded_state.as_deref(),
            Some("gpu-hmr-dispatch-unobserved")
        );
    }

    #[test]
    fn device_hmr_proof_artifact_records_blocked_abi_stage() {
        let outcome = fixture_device_outcome(true, symbols(&["shade"]), symbols(&["_Z5shadePi"]));
        let proof = device_hmr_proof_telemetry(&outcome);

        let stages = device_hmr_proof_stage_results(
            "2026-05-26T00:00:00Z",
            "source-edit:abc",
            "artifact:sha256:def",
            "evidence:artifact",
            "evidence:transport",
            "evidence:compiler",
            "evidence:symbols",
            "evidence:abi",
            false,
            Some("abi_layout_size_alignment_unverified".to_string()),
            artifact_exports_expected_device_symbols(&outcome),
            &proof,
        );

        assert_eq!(stages[0].stage_id, "device-compile");
        assert_eq!(stages[1].stage_id, "artifact-transport");
        assert_eq!(stages[1].status, "blocked");
        assert_eq!(
            stages[1].degraded_state.as_deref(),
            Some("gpu-hmr-ram-io-unavailable")
        );
        assert_eq!(
            stages[1].evidence_refs,
            vec!["evidence:transport".to_string()]
        );
        assert_eq!(stages[2].stage_id, "symbol-binding");
        assert_eq!(stages[2].status, "passed");
        assert_eq!(stages[3].stage_id, "abi-compatibility");
        assert_eq!(stages[3].status, "blocked");
        assert_eq!(
            stages[3].degraded_state.as_deref(),
            Some("gpu-hmr-abi-unverified")
        );
        assert_eq!(
            stages[3].degraded_reason.as_deref(),
            Some("abi_layout_size_alignment_unverified")
        );
        assert_eq!(stages[3].evidence_refs, vec!["evidence:abi".to_string()]);
        assert_eq!(stages[4].stage_id, "runtime-dispatch-observation");
        assert_eq!(
            stages[4].degraded_state.as_deref(),
            Some("gpu-hmr-dispatch-unobserved")
        );
    }

    #[test]
    fn abi_stage_verdict_requires_accepted_extractor_provenance() {
        let abi_material = serde_json::json!({
            "layoutSizeAlignmentVerified": true,
            "acceptedExtractorEvidenceRefs": ["evidence:clang-ast:abc"],
            "acceptedExtractorSources": ["clang_ast"],
            "extractorProvenance": [{
                "extractorName": "clang++",
                "extractorKind": "clang_ast",
                "extractorVersion": "17.0.0",
                "evidenceId": "evidence:clang-ast:abc",
                "inputHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "acceptedByRuntimeCorrectnessPlan": true
            }]
        });

        let (proven, reason) = abi_stage_verdict_from_metadata(&abi_material);

        assert!(proven);
        assert_eq!(reason, None);
    }

    #[test]
    fn abi_stage_verdict_blocks_unmatched_extractor_refs() {
        let abi_material = serde_json::json!({
            "layoutSizeAlignmentVerified": true,
            "acceptedExtractorEvidenceRefs": ["evidence:clang-ast:other"],
            "acceptedExtractorSources": ["clang_ast"],
            "extractorProvenance": [{
                "extractorName": "clang++",
                "extractorKind": "clang_ast",
                "extractorVersion": "17.0.0",
                "evidenceId": "evidence:clang-ast:abc",
                "inputHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "acceptedByRuntimeCorrectnessPlan": true
            }]
        });

        let (proven, reason) = abi_stage_verdict_from_metadata(&abi_material);

        assert!(!proven);
        assert_eq!(
            reason.as_deref(),
            Some("abi_extractor_provenance_unverified")
        );
    }

    #[test]
    fn device_hmr_proof_artifact_records_passed_abi_stage() {
        let outcome = fixture_device_outcome(true, symbols(&["shade"]), symbols(&["shade"]));
        let proof = device_hmr_proof_telemetry(&outcome);

        let stages = device_hmr_proof_stage_results(
            "2026-05-26T00:00:00Z",
            "source-edit:abc",
            "artifact:sha256:def",
            "evidence:artifact",
            "evidence:transport",
            "evidence:compiler",
            "evidence:symbols",
            "evidence:abi",
            true,
            None,
            artifact_exports_expected_device_symbols(&outcome),
            &proof,
        );

        let abi_stage = stages
            .iter()
            .find(|stage| stage.stage_id == "abi-compatibility")
            .expect("ABI proof stage should be recorded");
        assert_eq!(abi_stage.status, "passed");
        assert_eq!(abi_stage.degraded_state, None);
        assert_eq!(abi_stage.degraded_reason, None);
        assert_eq!(
            abi_stage.output_artifact_ids,
            vec!["artifact:sha256:def".to_string()]
        );
    }

    #[tokio::test]
    async fn device_hmr_proof_artifact_records_metadata_only_abi_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_path = temp.path().join("device.hsaco");
        tokio::fs::write(&artifact_path, b"device-artifact")
            .await
            .unwrap();
        let mut outcome = fixture_device_outcome(true, symbols(&["shade"]), symbols(&["shade"]));
        outcome.artifact_path = artifact_path;
        outcome.compiled_source = r#"
extern "C" __global__ void shade(float* pixels, int count) {}
__constant__ int scale;
"#
        .to_string();
        outcome.proof_metadata = DeviceCompileProofMetadata {
            compiler_executable: Some("/opt/toolchain/bin/hipcc".to_string()),
            compiler_identity: Some("compiler-identity-hash".to_string()),
            device_compiler: Some("hipcc".to_string()),
            gpu_vendor: Some("rocm".to_string()),
            gpu_arch: vec!["gfx0000".to_string()],
            target_triple: Some("rocm:gfx0000".to_string()),
            sdk_version: Some("rocm:test".to_string()),
            source_filename: Some("device.hip".to_string()),
            effective_device_flags: vec!["-O3".to_string()],
            compile_command_hash: Some("compile-command-hash".to_string()),
            dependency_hash: Some("dependency-hash".to_string()),
            dependency_method: Some("depfile".to_string()),
            artifact_cache_key: Some("artifact-cache-key".to_string()),
            cache_hit: false,
        };
        outcome.requested_artifact_kind = Some("source_include_bridge".to_string());
        outcome.selected_artifact_kind = Some("source_include_bridge".to_string());
        let proof = device_hmr_proof_telemetry(&outcome);

        let written = write_device_hmr_proof_artifact(
            temp.path(),
            Some("workspace"),
            "runtime-session",
            "source-edit:unit",
            &outcome,
            None,
            &proof,
            None,
        )
        .await
        .unwrap();
        let artifact = crate::hmr::gpu_proof::read_proof_artifact(&written.path)
            .await
            .unwrap();
        let abi_evidence = artifact
            .evidence_refs
            .iter()
            .find(|evidence| evidence.kind == "device-abi-metadata")
            .expect("ABI metadata evidence should be recorded");
        let metadata = abi_evidence
            .metadata
            .as_ref()
            .expect("ABI metadata evidence should include structured metadata");
        let compiler_evidence = artifact
            .evidence_refs
            .iter()
            .find(|evidence| evidence.kind == "device-compiler-output")
            .expect("compiler output evidence should be recorded");
        let transport_evidence = artifact
            .evidence_refs
            .iter()
            .find(|evidence| evidence.kind == "device-artifact-transport")
            .expect("artifact transport evidence should be recorded");
        let transport_metadata = transport_evidence
            .metadata
            .as_ref()
            .expect("artifact transport evidence should include structured metadata");
        let compiler_metadata = compiler_evidence
            .metadata
            .as_ref()
            .expect("compiler evidence should include structured metadata");
        let compile_provenance = compiler_metadata
            .get("compileProvenance")
            .expect("compiler evidence should include compile provenance");

        assert!(abi_evidence
            .evidence_id
            .starts_with("evidence:device-abi-metadata:"));
        assert!(compiler_evidence
            .summary
            .contains("compile_command_hash=compile-command-hash"));
        assert!(transport_evidence
            .evidence_id
            .starts_with("evidence:device-artifact-transport:"));
        assert_eq!(
            transport_metadata
                .get("schemaVersion")
                .and_then(serde_json::Value::as_str),
            Some("synthi.gpu.hmr.artifact_transport.v1")
        );
        assert_eq!(
            transport_metadata
                .get("selectedLoaderTransport")
                .and_then(serde_json::Value::as_str),
            None
        );
        assert_eq!(
            transport_metadata
                .get("ramArtifactReferenceProvided")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        let expected_ram_blob_id =
            format!("artifact:sha256:{}", sha256_hex_bytes(b"device-artifact"));
        assert_eq!(
            transport_metadata
                .get("ramBlobId")
                .and_then(serde_json::Value::as_str),
            Some(expected_ram_blob_id.as_str())
        );
        assert_eq!(
            transport_metadata
                .get("reloadRequestTransports")
                .and_then(serde_json::Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .collect::<Vec<_>>()
                }),
            Some(vec!["filesystem_path", "ram_blob"])
        );
        assert_eq!(
            transport_metadata
                .get("degradedState")
                .and_then(serde_json::Value::as_str),
            Some("gpu-hmr-ram-io-unavailable")
        );
        assert_eq!(
            compile_provenance
                .get("compilerExecutable")
                .and_then(serde_json::Value::as_str),
            Some("/opt/toolchain/bin/hipcc")
        );
        assert_eq!(
            compile_provenance
                .get("compileCommandHash")
                .and_then(serde_json::Value::as_str),
            Some("compile-command-hash")
        );
        assert_eq!(
            compile_provenance
                .get("dependencyHash")
                .and_then(serde_json::Value::as_str),
            Some("dependency-hash")
        );
        assert_eq!(
            compile_provenance
                .get("gpuArch")
                .and_then(serde_json::Value::as_array)
                .and_then(|items| items.first())
                .and_then(serde_json::Value::as_str),
            Some("gfx0000")
        );
        assert_eq!(
            metadata
                .get("schemaVersion")
                .and_then(serde_json::Value::as_str),
            Some("synthi.gpu.hmr.abi_metadata.v1")
        );
        assert_eq!(
            metadata
                .get("kernelSignatures")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len),
            Some(1)
        );
        assert_eq!(
            metadata
                .get("partialModule")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            metadata
                .get("selectedArtifactKind")
                .and_then(serde_json::Value::as_str),
            Some("source_include_bridge")
        );
        assert!(metadata
            .get("kernelAbiFingerprintHash")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|hash| hash.len() == 64));
        assert!(metadata
            .get("constantGlobalLayoutHash")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|hash| !hash.is_empty()));
        assert_eq!(
            metadata
                .get("layoutSizeAlignmentVerified")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            metadata
                .get("acceptedExtractorEvidenceRefs")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len),
            Some(0)
        );
        let extractor = metadata
            .get("extractorProvenance")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
            .expect("ABI metadata should declare extractor provenance");
        assert_eq!(
            extractor
                .get("extractorKind")
                .and_then(serde_json::Value::as_str),
            Some("source_text_scan")
        );
        assert_eq!(
            extractor
                .get("acceptedByRuntimeCorrectnessPlan")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        let abi_stage = artifact
            .stage_results
            .iter()
            .find(|stage| stage.stage_id == "abi-compatibility")
            .expect("ABI proof stage should be recorded");
        assert_eq!(abi_stage.status, "blocked");
        assert_eq!(
            abi_stage.degraded_state.as_deref(),
            Some("gpu-hmr-abi-unverified")
        );
        assert_eq!(
            abi_stage.degraded_reason.as_deref(),
            Some("device_constant_or_global_layout_unverified")
        );
        assert_eq!(
            abi_stage.evidence_refs,
            vec![abi_evidence.evidence_id.clone()]
        );
        let transport_stage = artifact
            .stage_results
            .iter()
            .find(|stage| stage.stage_id == "artifact-transport")
            .expect("artifact transport proof stage should be recorded");
        assert_eq!(transport_stage.status, "blocked");
        assert_eq!(
            transport_stage.degraded_state.as_deref(),
            Some("gpu-hmr-ram-io-unavailable")
        );
        assert_eq!(
            transport_stage.evidence_refs,
            vec![transport_evidence.evidence_id.clone()]
        );
    }

    #[tokio::test]
    async fn device_hmr_proof_artifact_records_fission_verifier_report() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_path = temp.path().join("device.hsaco");
        tokio::fs::write(&artifact_path, b"device-artifact")
            .await
            .unwrap();
        let mut outcome = fixture_device_outcome(true, symbols(&["shade"]), symbols(&["shade"]));
        outcome.artifact_path = artifact_path;
        outcome.compiled_source =
            r#"extern "C" __global__ void shade(float* pixels, int count) {}"#.to_string();
        outcome.requested_artifact_kind = Some("source_include_bridge".to_string());
        outcome.selected_artifact_kind = Some("source_include_bridge".to_string());
        let proof = device_hmr_proof_telemetry(&outcome);
        let sidecar = serde_json::json!({
            "fissionVerifierReport": {
                "schemaVersion": "synthi.gpu.fission_verifier.v1",
                "selectionPolicy": "narrowest_viable_generic_v1",
                "status": "pass",
                "candidateCount": 2,
                "acceptedCount": 1,
                "rejectedCount": 1,
                "selectedIslandId": "island:sha256:abc",
                "selectedCandidateIndex": 1,
                "reasonCodes": ["fission.candidate_accepted"],
                "candidates": [
                    {
                        "status": "reject",
                        "islandId": "island:sha256:narrower",
                        "reasonCodes": ["fission.abi_membrane_evidence_missing"]
                    },
                    {
                        "status": "pass",
                        "islandId": "island:sha256:abc",
                        "reasonCodes": ["fission.candidate_verified"],
                        "selected": true
                    }
                ]
            }
        });

        let written = write_device_hmr_proof_artifact(
            temp.path(),
            Some("workspace"),
            "runtime-session",
            "source-edit:fission",
            &outcome,
            None,
            &proof,
            Some(&sidecar),
        )
        .await
        .unwrap();
        let artifact = crate::hmr::gpu_proof::read_proof_artifact(&written.path)
            .await
            .unwrap();
        let fission_evidence = artifact
            .evidence_refs
            .iter()
            .find(|evidence| evidence.kind == "fission-verifier-report")
            .expect("fission verifier evidence should be recorded");
        let metadata = fission_evidence
            .metadata
            .as_ref()
            .expect("fission verifier evidence should preserve structured report");
        let fission_stage = artifact
            .stage_results
            .iter()
            .find(|stage| stage.stage_id == "fission-candidate-verification")
            .expect("fission verifier stage should be recorded");

        assert!(fission_evidence
            .evidence_id
            .starts_with("evidence:fission-verifier-report:"));
        assert!(fission_evidence.summary.contains("accepted=1"));
        assert_eq!(
            metadata
                .get("selectedIslandId")
                .and_then(serde_json::Value::as_str),
            Some("island:sha256:abc")
        );
        assert_eq!(fission_stage.status, "passed");
        assert_eq!(fission_stage.evidence_refs, vec![fission_evidence.evidence_id.clone()]);
        assert_eq!(artifact.stage_results[0].stage_id, "fission-candidate-verification");
    }

    #[tokio::test]
    async fn partial_hmr_proof_artifact_promotes_partial_metadata_to_fission_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_path = temp.path().join("device.hsaco");
        tokio::fs::write(&artifact_path, b"device-artifact")
            .await
            .unwrap();
        let partial_source = r#"extern "C" __global__ void shade(float* pixels) {
  pixels[0] = 1.0f;
}
"#;
        let mut outcome = fixture_device_outcome(true, symbols(&["shade"]), symbols(&["shade"]));
        outcome.artifact_path = artifact_path;
        outcome.compiled_source = partial_source.to_string();
        outcome.requested_artifact_kind = Some("source_include_bridge".to_string());
        outcome.selected_artifact_kind = Some("source_include_bridge".to_string());
        outcome.proof_metadata = DeviceCompileProofMetadata {
            compiler_executable: Some("/opt/toolchain/bin/hipcc".to_string()),
            compiler_identity: Some("compiler-identity-hash".to_string()),
            device_compiler: Some("hipcc".to_string()),
            gpu_vendor: Some("rocm".to_string()),
            gpu_arch: vec!["gfx0000".to_string()],
            target_triple: Some("rocm:gfx0000".to_string()),
            sdk_version: Some("rocm:test".to_string()),
            source_filename: Some(".synthi/generated/gpu/device.hip".to_string()),
            effective_device_flags: vec!["-O3".to_string()],
            compile_command_hash: Some(sha256_hex_str("compile-command")),
            dependency_hash: Some(sha256_hex_str("dependency-closure")),
            dependency_method: Some("depfile".to_string()),
            artifact_cache_key: Some("artifact-cache-key".to_string()),
            cache_hit: false,
        };
        let sources = DeviceCompileSources {
            full_source: partial_source.to_string(),
            full_filename: Some(".synthi/generated/gpu/device.hip".to_string()),
            full_symbols: symbols(&["shade"]),
            direct_workspace_source: false,
            partial_source: Some(partial_source.to_string()),
            partial_filename: Some(".synthi/generated/gpu/device.partial.shade.hip".to_string()),
            partial_symbols: symbols(&["shade"]),
            partial_source_paths: vec!["src/gpu/shade.hip".to_string()],
            partial_required: true,
            partial_artifact_kind: Some("source_include_bridge".to_string()),
            partial_fallback_reason: None,
        };
        let proof = device_hmr_proof_telemetry(&outcome);

        let written = write_device_hmr_proof_artifact(
            temp.path(),
            Some("workspace"),
            "runtime-session",
            "source-edit:partial",
            &outcome,
            Some(&sources),
            &proof,
            None,
        )
        .await
        .unwrap();
        let artifact = crate::hmr::gpu_proof::read_proof_artifact(&written.path)
            .await
            .unwrap();
        let fission_input = artifact
            .evidence_refs
            .iter()
            .find(|evidence| evidence.kind == "fission-island-input")
            .expect("partial artifact fission input should be recorded");
        let fission_evidence = artifact
            .evidence_refs
            .iter()
            .find(|evidence| evidence.kind == "fission-verifier-report")
            .expect("partial artifact fission verifier should be recorded");
        let fission_stage = artifact
            .stage_results
            .iter()
            .find(|stage| stage.stage_id == "fission-candidate-verification")
            .expect("fission stage should be recorded");
        let report = fission_evidence
            .metadata
            .as_ref()
            .expect("fission report metadata should be present");

        assert_eq!(fission_stage.status, "passed");
        assert_eq!(
            report.get("status").and_then(serde_json::Value::as_str),
            Some("pass")
        );
        assert_eq!(
            report
                .pointer("/candidates/0/candidate/sourcePaths/0")
                .and_then(serde_json::Value::as_str),
            Some("src/gpu/shade.hip")
        );
        assert_eq!(
            report
                .pointer("/candidates/0/candidate/artifactKind")
                .and_then(serde_json::Value::as_str),
            Some("source_include_bridge")
        );
        assert!(report
            .pointer("/candidates/0/candidate/requiredOracleId")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| value.starts_with("oracle:required:sha256:")));
        assert_eq!(
            report
                .pointer("/candidates/0/candidate/sourceMappingEvidenceIds/0")
                .and_then(serde_json::Value::as_str),
            Some(fission_input.evidence_id.as_str())
        );
        assert_eq!(
            report
                .pointer("/candidates/0/narrowerRejectionCoverage/missingRanks")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len),
            Some(0)
        );
    }

    #[tokio::test]
    async fn partial_hmr_proof_artifact_covers_direct_translation_unit_narrower_scopes() {
        let temp = tempfile::tempdir().unwrap();
        let artifact_path = temp.path().join("device.hsaco");
        tokio::fs::write(&artifact_path, b"device-artifact")
            .await
            .unwrap();
        let source = r#"extern "C" __global__ void shade(float* pixels) {
  pixels[0] = 1.0f;
}
"#;
        let mut outcome = fixture_device_outcome(true, symbols(&["shade"]), symbols(&["shade"]));
        outcome.artifact_path = artifact_path;
        outcome.compiled_source = source.to_string();
        outcome.requested_artifact_kind = Some("direct_device_translation_unit".to_string());
        outcome.selected_artifact_kind = Some("direct_device_translation_unit".to_string());
        outcome.proof_metadata = DeviceCompileProofMetadata {
            compiler_executable: Some("/opt/toolchain/bin/hipcc".to_string()),
            compiler_identity: Some("compiler-identity-hash".to_string()),
            device_compiler: Some("hipcc".to_string()),
            gpu_vendor: Some("rocm".to_string()),
            gpu_arch: vec!["gfx0000".to_string()],
            target_triple: Some("rocm:gfx0000".to_string()),
            sdk_version: Some("rocm:test".to_string()),
            source_filename: Some("device.hip".to_string()),
            effective_device_flags: vec!["-O3".to_string()],
            compile_command_hash: Some(sha256_hex_str("compile-command")),
            dependency_hash: Some(sha256_hex_str("dependency-closure")),
            dependency_method: Some("depfile".to_string()),
            artifact_cache_key: Some("artifact-cache-key".to_string()),
            cache_hit: false,
        };
        let sources = DeviceCompileSources {
            full_source: source.to_string(),
            full_filename: Some("device.hip".to_string()),
            full_symbols: symbols(&["shade"]),
            direct_workspace_source: true,
            partial_source: None,
            partial_filename: None,
            partial_symbols: symbols(&["shade"]),
            partial_source_paths: Vec::new(),
            partial_required: false,
            partial_artifact_kind: None,
            partial_fallback_reason: None,
        };
        let proof = device_hmr_proof_telemetry(&outcome);

        let written = write_device_hmr_proof_artifact(
            temp.path(),
            Some("workspace"),
            "runtime-session",
            "source-edit:direct-tu",
            &outcome,
            Some(&sources),
            &proof,
            None,
        )
        .await
        .unwrap();
        let artifact = crate::hmr::gpu_proof::read_proof_artifact(&written.path)
            .await
            .unwrap();
        let fission_evidence = artifact
            .evidence_refs
            .iter()
            .find(|evidence| evidence.kind == "fission-verifier-report")
            .expect("direct translation unit fission verifier should be recorded");
        let report = fission_evidence
            .metadata
            .as_ref()
            .expect("fission report metadata should be present");

        assert_eq!(
            report.get("status").and_then(serde_json::Value::as_str),
            Some("pass")
        );
        assert_eq!(
            report
                .pointer("/candidates/0/narrowerRejectionCoverage/requiredRanks")
                .cloned(),
            Some(serde_json::json!([0, 1]))
        );
        assert_eq!(
            report
                .pointer("/candidates/0/narrowerRejectionCoverage/missingRanks")
                .cloned(),
            Some(serde_json::json!([]))
        );
        assert_eq!(
            report
                .pointer("/candidates/0/candidate/narrowerCandidateRejections")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn fission_stage_degraded_reason_uses_specific_candidate_reason() {
        let report = serde_json::json!({
            "schemaVersion": "synthi.gpu.fission_verifier.v1",
            "status": "reject",
            "reasonCodes": ["fission.no_accepted_candidate"],
            "candidates": [
                {
                    "status": "reject",
                    "reasonCodes": [
                        "fission.output_oracle_missing",
                        "fission.abi_membrane_evidence_missing"
                    ]
                }
            ]
        });

        assert_eq!(
            fission_verifier_rejection_reason(&report).as_deref(),
            Some("fission.output_oracle_missing")
        );
    }

    #[test]
    fn device_abi_evidence_summary_reports_accepted_extractor_count() {
        let abi_material = serde_json::json!({
            "kernelSignatures": ["shade(float*)"],
            "acceptedExtractorEvidenceRefs": [
                "evidence:clang-ast:one",
                "evidence:clang-record-layout:two"
            ],
        });

        let summary = device_abi_evidence_summary(&abi_material, "sha256:layout");

        assert!(summary.contains("kernel_signatures=1"));
        assert!(summary.contains("accepted_extractors=2"));
    }

    #[test]
    fn clang_ast_abi_extractor_uses_compile_context_without_codegen_flags() {
        let temp = tempfile::tempdir().unwrap();
        let input_path = temp
            .path()
            .join(".synthi")
            .join("gpu-hmr")
            .join("abi")
            .join("input.hip");
        let metadata = DeviceCompileProofMetadata {
            source_filename: Some("src/device.hip".to_string()),
            effective_device_flags: vec![
                "-O3".to_string(),
                "-lineinfo".to_string(),
                "-Isrc".to_string(),
                "-isystem".to_string(),
                "thirdparty/include".to_string(),
                "-DVALUE=1".to_string(),
                "-std=gnu++20".to_string(),
            ],
            gpu_arch: vec!["gfx1201".to_string()],
            ..Default::default()
        };

        let args = clang_ast_abi_extractor_args(temp.path(), &metadata, "hip", &input_path);
        let joined = args.join("\n");

        assert!(args.windows(2).any(|window| {
            window[0] == "-I"
                && window[1].replace('\\', "/") == temp.path().to_string_lossy().replace('\\', "/")
        }));
        assert!(joined.contains("-Isrc"));
        assert!(args.windows(2).any(|window| {
            window[0] == "-isystem" && window[1] == "thirdparty/include"
        }));
        assert!(joined.contains("-DVALUE=1"));
        assert!(joined.contains("-std=gnu++20"));
        assert!(joined.contains("--offload-arch=gfx1201"));
        assert!(joined.contains("-fdump-record-layouts"));
        assert!(!args.iter().any(|arg| arg == "-O3"));
        assert!(!args.iter().any(|arg| arg == "-lineinfo"));

        let cxx_args = clang_ast_abi_extractor_args(temp.path(), &metadata, "c++", &input_path);
        assert!(cxx_args.iter().any(|arg| arg == "-D__global__="));
        assert!(cxx_args.iter().any(|arg| arg == "-D__launch_bounds__(...)="));
    }

    #[test]
    fn clang_ast_abi_extractor_accepts_builtin_pointer_kernel_params() {
        let source = r#"
extern "C" __global__ void shade(const float* input, float* pixels, int count, unsigned long long frame) {}
"#;
        let ast = r#"
`-FunctionDecl 0x1 <device.hip:2:1, col:108> col:28 shade 'void (const float *, float *, int, unsigned long long)'
"#;

        let extraction = clang_ast_abi_extraction_from_dump(
            source,
            ast,
            &symbols(&["shade"]),
            "clang++ -x hip -fsyntax-only -Xclang -ast-dump <input>",
            "evidence:abi-extractor:test".to_string(),
        );

        assert!(extraction.layout_size_alignment_verified);
        assert_eq!(
            extraction.accepted_extractor_evidence_refs,
            vec!["evidence:abi-extractor:test".to_string()]
        );
        assert_eq!(
            extraction.accepted_extractor_sources,
            vec!["clang_ast".to_string()]
        );
        assert_eq!(
            extraction.kernel_signatures,
            vec!["shade(const float*,float*,int,unsigned long long)".to_string()]
        );
        assert_eq!(extraction.parameter_abi_records.len(), 4);
        assert_eq!(extraction.degraded_reason, None);
    }

    #[test]
    fn clang_ast_abi_extractor_accepts_opaque_record_pointer_params() {
        let source = r#"
struct RenderData { int count; };
extern "C" __global__ void shade(RenderData* render_data) {}
"#;
        let ast = r#"
`-FunctionDecl 0x1 <device.hip:3:1, col:64> col:28 shade 'void (RenderData *)'
"#;

        let extraction = clang_ast_abi_extraction_from_dump(
            source,
            ast,
            &symbols(&["shade"]),
            "clang++ -x hip -fsyntax-only -Xclang -ast-dump <input>",
            "evidence:abi-extractor:test".to_string(),
        );

        assert!(extraction.layout_size_alignment_verified);
        assert_eq!(extraction.parameter_abi_records.len(), 1);
        assert_eq!(extraction.parameter_abi_records[0]["typeIdentity"], "RenderData*");
        assert_eq!(extraction.parameter_abi_records[0]["size"], 8);
        assert_eq!(extraction.degraded_reason, None);
    }

    #[test]
    fn clang_ast_abi_extractor_accepts_record_by_value_with_layout_dump() {
        let source = r#"
struct RenderData { int count; float weight; };
extern "C" __global__ void shade(RenderData render_data) {}
"#;
        let ast = r#"
`-FunctionDecl 0x1 <device.hip:3:1, col:64> col:28 shade 'void (RenderData)'

*** Dumping AST Record Layout
         0 | struct RenderData
         0 |   int count
         4 |   float weight
           | [sizeof=8, dsize=8, align=4,
           |  nvsize=8, nvalign=4]
"#;

        let extraction = clang_ast_abi_extraction_from_dump(
            source,
            ast,
            &symbols(&["shade"]),
            "clang++ -x hip -fsyntax-only -Xclang -ast-dump -Xclang -fdump-record-layouts <input>",
            "evidence:abi-extractor:test".to_string(),
        );

        assert!(extraction.layout_size_alignment_verified);
        assert_eq!(extraction.parameter_abi_records.len(), 1);
        assert_eq!(extraction.parameter_abi_records[0]["typeIdentity"], "RenderData");
        assert_eq!(extraction.parameter_abi_records[0]["size"], 8);
        assert_eq!(extraction.parameter_abi_records[0]["alignment"], 4);
        assert_eq!(
            extraction.parameter_abi_records[0]["recordLayoutSource"],
            "clang_record_layout"
        );
        assert_eq!(
            extraction.accepted_extractor_evidence_refs,
            vec!["evidence:abi-extractor:test".to_string()]
        );
        assert_eq!(extraction.degraded_reason, None);
    }

    #[test]
    fn clang_ast_abi_extractor_rejects_record_by_value_without_layout_dump() {
        let source = r#"
struct RenderData { int count; };
extern "C" __global__ void shade(RenderData render_data) {}
"#;
        let ast = r#"
`-FunctionDecl 0x1 <device.hip:3:1, col:64> col:28 shade 'void (RenderData)'
"#;

        let extraction = clang_ast_abi_extraction_from_dump(
            source,
            ast,
            &symbols(&["shade"]),
            "clang++ -x hip -fsyntax-only -Xclang -ast-dump <input>",
            "evidence:abi-extractor:test".to_string(),
        );

        assert!(!extraction.layout_size_alignment_verified);
        assert!(extraction.accepted_extractor_evidence_refs.is_empty());
        assert_eq!(
            extraction.degraded_reason.as_deref(),
            Some("clang_ast_parameter_layout_requires_record_extractor")
        );
    }

    #[test]
    fn clang_ast_abi_extractor_records_failed_attempt_provenance() {
        let extraction = clang_ast_abi_extraction_failure(
            "extern \"C\" __global__ void shade(float* pixels) {}",
            "synthi_clang_ast_kernel_abi_extractor",
            "clang_ast_dump_failed",
            vec![ClangAstAbiAttempt {
                language: "hip".to_string(),
                command: "clang++ -x hip -fsyntax-only -Xclang -ast-dump <input>".to_string(),
                status: "timeout".to_string(),
                stderr_summary: "clang AST dump timed out".to_string(),
            }],
        );

        assert!(!extraction.layout_size_alignment_verified);
        assert!(extraction.accepted_extractor_evidence_refs.is_empty());
        assert_eq!(
            extraction.degraded_reason.as_deref(),
            Some("clang_ast_dump_failed")
        );
        let provenance = &extraction.extractor_provenance[0];
        assert_eq!(provenance["extractorKind"], "clang_ast");
        assert_eq!(provenance["acceptedByRuntimeCorrectnessPlan"], false);
        assert_eq!(provenance["rejectedReason"], "clang_ast_dump_failed");
        assert_eq!(provenance["attempts"][0]["status"], "timeout");
    }

    #[test]
    fn direct_workspace_translation_unit_hmr_requires_symbol_ownership() {
        let source = fixture_kernel_source("shade");
        let sources = DeviceCompileSources {
            full_source: source.clone(),
            full_filename: Some("device.hip".to_string()),
            full_symbols: symbols(&["shade"]),
            direct_workspace_source: true,
            partial_source: None,
            partial_filename: None,
            partial_symbols: Vec::new(),
            partial_source_paths: Vec::new(),
            partial_required: false,
            partial_artifact_kind: None,
            partial_fallback_reason: None,
        };

        let mut outcome = fixture_device_outcome(false, Vec::new(), symbols(&["shade"]));
        finalize_full_device_outcome(&mut outcome, &sources, None, true).unwrap();
        assert!(outcome.partial_module);
        assert_eq!(
            outcome.selected_artifact_kind.as_deref(),
            Some("direct_device_translation_unit")
        );
        assert_eq!(outcome.target_symbols, symbols(&["shade"]));
        assert_eq!(device_hmr_result_label(&outcome), "gpu-hmr-partial");

        let mut extra_export =
            fixture_device_outcome(false, Vec::new(), symbols(&["shade", "unowned_kernel"]));
        assert!(finalize_full_device_outcome(&mut extra_export, &sources, None, true).is_err());

        let mut initial_compile = fixture_device_outcome(false, Vec::new(), symbols(&["shade"]));
        finalize_full_device_outcome(&mut initial_compile, &sources, None, false).unwrap();
        assert!(!initial_compile.partial_module);
        assert_eq!(
            initial_compile.selected_artifact_kind.as_deref(),
            Some("full_device")
        );
    }

    #[test]
    fn full_reload_symbols_use_source_declarations_when_available() {
        let outcome = fixture_device_outcome(
            false,
            Vec::new(),
            symbols(&["artifact_kernel_a", "artifact_kernel_b"]),
        );
        let source = r#"
extern "C" __global__ void source_kernel_b() {}
extern "C" __global__ void source_kernel_a() {}
"#;

        assert_eq!(
            device_reload_kernel_symbols(source, &outcome),
            symbols(&["source_kernel_a", "source_kernel_b"])
        );
    }

    #[test]
    fn full_reload_symbols_fall_back_to_artifact_exports_when_source_is_opaque() {
        let outcome = fixture_device_outcome(
            false,
            Vec::new(),
            symbols(&["artifact_kernel_b", "artifact_kernel_a"]),
        );
        let source = r#"
#define DECLARE_KERNEL(name) /* project-specific kernel declaration macro */
DECLARE_KERNEL(opaque_kernel)
"#;

        assert_eq!(
            device_reload_kernel_symbols(source, &outcome),
            symbols(&["artifact_kernel_a", "artifact_kernel_b"])
        );
    }

    #[test]
    fn full_reload_symbols_fall_back_to_mapping_scope_when_source_and_exports_are_opaque() {
        let outcome = fixture_device_outcome(
            false,
            symbols(&["mapped_kernel_b", "mapped_kernel_a"]),
            Vec::new(),
        );
        let source = r#"
#include "src/device/generated_kernel_bridge.h"
"#;

        assert_eq!(
            device_reload_kernel_symbols(source, &outcome),
            symbols(&["mapped_kernel_a", "mapped_kernel_b"])
        );
    }

    #[test]
    fn partial_reload_symbols_keep_verifier_selected_scope() {
        let outcome = fixture_device_outcome(
            true,
            symbols(&["selected_kernel"]),
            symbols(&["selected_kernel", "other_export"]),
        );

        assert_eq!(
            device_reload_kernel_symbols("", &outcome),
            symbols(&["selected_kernel"])
        );
    }

    #[test]
    fn partial_reload_symbol_specs_map_logical_to_mangled_driver_symbol() {
        let outcome = fixture_device_outcome(true, symbols(&["shade"]), symbols(&["_Z5shadePf"]));

        assert_eq!(
            device_reload_kernel_symbol_specs("", &outcome),
            symbols(&["shade=_Z5shadePf"])
        );
    }

    #[test]
    fn partial_reload_symbol_specs_do_not_guess_unqualified_namespace_symbol() {
        let outcome =
            fixture_device_outcome(true, symbols(&["shade"]), symbols(&["_ZN3gpu5shadeEPf"]));

        assert_eq!(
            device_reload_kernel_symbol_specs("", &outcome),
            symbols(&["shade"])
        );
    }

    #[test]
    fn gpu_kernel_command_specs_percent_encode_delimiters() {
        assert_eq!(
            encode_gpu_kernel_command_specs(&symbols(&["gpu::shade=_ZN3gpu5shadeEPf"])),
            "gpu%3A%3Ashade=_ZN3gpu5shadeEPf"
        );
    }

    #[test]
    fn partial_artifact_export_validation_rejects_unknown_symbols() {
        let outcome = DeviceCompileOutcome {
            artifact_path: std::path::PathBuf::from("/tmp/device.hsaco"),
            compiled_source: String::new(),
            compiler_elapsed_ms: 0,
            partial_module: true,
            target_symbols: vec!["shade".to_string()],
            fallback_used: false,
            fallback_reason: None,
            requested_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_bytes: Some(128),
            full_device_bytes: Some(1024),
            artifact_exported_symbols: vec!["shade".to_string(), "foreign".to_string()],
            diagnostics:
                crate::compiler::stages::ptxas_info_parser::GpuToolchainDiagnostics::default(),
            stderr: String::new(),
            proof_metadata: DeviceCompileProofMetadata::default(),
        };

        let err = validate_partial_device_artifact_exports(&outcome).unwrap_err();
        assert!(err.to_string().contains("unexpected symbols"));
    }

    #[test]
    fn partial_artifact_export_validation_rejects_unmapped_mangled_symbols() {
        let outcome = DeviceCompileOutcome {
            artifact_path: std::path::PathBuf::from("/tmp/device.hsaco"),
            compiled_source: String::new(),
            compiler_elapsed_ms: 0,
            partial_module: true,
            target_symbols: vec!["shade".to_string()],
            fallback_used: false,
            fallback_reason: None,
            requested_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_bytes: Some(128),
            full_device_bytes: Some(1024),
            artifact_exported_symbols: vec!["_Z7foreignPf".to_string()],
            diagnostics:
                crate::compiler::stages::ptxas_info_parser::GpuToolchainDiagnostics::default(),
            stderr: String::new(),
            proof_metadata: DeviceCompileProofMetadata::default(),
        };

        let err = validate_partial_device_artifact_exports(&outcome).unwrap_err();
        assert!(err
            .to_string()
            .contains("mangled symbols without explicit identity mapping"));
    }

    #[test]
    fn partial_artifact_export_validation_matches_itanium_source_spelling() {
        let outcome = DeviceCompileOutcome {
            artifact_path: std::path::PathBuf::from("/tmp/device.hsaco"),
            compiled_source: String::new(),
            compiler_elapsed_ms: 0,
            partial_module: true,
            target_symbols: vec!["shade".to_string()],
            fallback_used: false,
            fallback_reason: None,
            requested_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_bytes: Some(128),
            full_device_bytes: Some(1024),
            artifact_exported_symbols: vec!["_Z5shadePf".to_string()],
            diagnostics:
                crate::compiler::stages::ptxas_info_parser::GpuToolchainDiagnostics::default(),
            stderr: String::new(),
            proof_metadata: DeviceCompileProofMetadata::default(),
        };

        validate_partial_device_artifact_exports(&outcome).unwrap();
    }

    #[test]
    fn partial_artifact_export_validation_rejects_ambiguous_mangled_overloads() {
        let outcome = DeviceCompileOutcome {
            artifact_path: std::path::PathBuf::from("/tmp/device.hsaco"),
            compiled_source: String::new(),
            compiler_elapsed_ms: 0,
            partial_module: true,
            target_symbols: vec!["shade".to_string()],
            fallback_used: false,
            fallback_reason: None,
            requested_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_bytes: Some(128),
            full_device_bytes: Some(1024),
            artifact_exported_symbols: vec!["_Z5shadef".to_string(), "_Z5shadei".to_string()],
            diagnostics:
                crate::compiler::stages::ptxas_info_parser::GpuToolchainDiagnostics::default(),
            stderr: String::new(),
            proof_metadata: DeviceCompileProofMetadata::default(),
        };

        let err = validate_partial_device_artifact_exports(&outcome).unwrap_err();
        assert!(err
            .to_string()
            .contains("ambiguous exported symbol identity"));
    }

    #[test]
    fn partial_artifact_export_validation_matches_itanium_qualified_source_name() {
        let outcome = DeviceCompileOutcome {
            artifact_path: std::path::PathBuf::from("/tmp/device.hsaco"),
            compiled_source: String::new(),
            compiler_elapsed_ms: 0,
            partial_module: true,
            target_symbols: vec!["gpu::shade".to_string()],
            fallback_used: false,
            fallback_reason: None,
            requested_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_bytes: Some(128),
            full_device_bytes: Some(1024),
            artifact_exported_symbols: vec!["_ZN3gpu5shadeEPf".to_string()],
            diagnostics:
                crate::compiler::stages::ptxas_info_parser::GpuToolchainDiagnostics::default(),
            stderr: String::new(),
            proof_metadata: DeviceCompileProofMetadata::default(),
        };

        validate_partial_device_artifact_exports(&outcome).unwrap();
    }

    #[test]
    fn partial_artifact_export_validation_rejects_qualified_mangled_symbol_for_unqualified_target()
    {
        let outcome = DeviceCompileOutcome {
            artifact_path: std::path::PathBuf::from("/tmp/device.hsaco"),
            compiled_source: String::new(),
            compiler_elapsed_ms: 0,
            partial_module: true,
            target_symbols: vec!["shade".to_string()],
            fallback_used: false,
            fallback_reason: None,
            requested_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_bytes: Some(128),
            full_device_bytes: Some(1024),
            artifact_exported_symbols: vec!["_ZN3gpu5shadeEPf".to_string()],
            diagnostics:
                crate::compiler::stages::ptxas_info_parser::GpuToolchainDiagnostics::default(),
            stderr: String::new(),
            proof_metadata: DeviceCompileProofMetadata::default(),
        };

        let err = validate_partial_device_artifact_exports(&outcome).unwrap_err();
        assert!(err
            .to_string()
            .contains("mangled symbols without explicit identity mapping"));
    }

    #[test]
    fn partial_artifact_export_validation_allows_exact_raw_symbol_identity() {
        let outcome = DeviceCompileOutcome {
            artifact_path: std::path::PathBuf::from("/tmp/device.hsaco"),
            compiled_source: String::new(),
            compiler_elapsed_ms: 0,
            partial_module: true,
            target_symbols: vec!["_Z5shadePf".to_string()],
            fallback_used: false,
            fallback_reason: None,
            requested_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_kind: Some("source_include_bridge".to_string()),
            selected_artifact_bytes: Some(128),
            full_device_bytes: Some(1024),
            artifact_exported_symbols: vec!["_Z5shadePf".to_string()],
            diagnostics:
                crate::compiler::stages::ptxas_info_parser::GpuToolchainDiagnostics::default(),
            stderr: String::new(),
            proof_metadata: DeviceCompileProofMetadata::default(),
        };

        validate_partial_device_artifact_exports(&outcome).unwrap();
    }

    #[test]
    fn missing_gpu_host_contract_symbols_reports_required_callbacks() {
        let missing = missing_gpu_host_contract_symbols(&symbols(&[
            "device_descriptor",
            "device_kernel_sig_hash",
        ]));
        assert_eq!(missing, vec!["device_on_load"]);
    }

    #[test]
    fn gpu_host_contract_accepts_required_lifecycle_symbols() {
        let missing = missing_gpu_host_contract_symbols(&symbols(&[
            "device_descriptor",
            "device_on_load",
            "device_kernel_sig_hash",
        ]));
        assert!(missing.is_empty());
    }

    #[test]
    fn gpu_state_serialization_requires_both_save_callbacks() {
        assert!(!has_gpu_state_serialization_symbols(&symbols(&[
            "device_save_size",
        ])));
        assert!(has_gpu_state_serialization_symbols(&symbols(&[
            "device_save_size",
            "device_save_write",
        ])));
    }

    #[test]
    fn device_kernel_symbol_extractor_handles_launch_bounds_positions() {
        let source = r#"
extern "C" __global__ void vec_add(const float* a, float* out) {}
__global__ void __launch_bounds__(256, 2) reduce(const float* in, float* out) {}
__global__ __launch_bounds__(128) void saxpy(float* y) {}
"#;

        assert_eq!(
            extract_device_kernel_symbols(source),
            vec![
                "reduce".to_string(),
                "saxpy".to_string(),
                "vec_add".to_string()
            ]
        );
    }

    #[test]
    fn device_kernel_symbol_extractor_ignores_comments_and_deduplicates() {
        let source = r#"
// __global__ void commented_out(float* x) {}
/*
__global__ void block_commented(float* x) {}
*/
__global__ void live_kernel(float* x) {}
__global__ void live_kernel(float* x);
"#;

        assert_eq!(
            extract_device_kernel_symbols(source),
            vec!["live_kernel".to_string()]
        );
    }

    #[test]
    fn device_kernel_signature_extractor_tracks_parameter_lists() {
        let source = r#"
extern "C" __global__ void vec_add(const float* a, const float* b, float* out, int n) {}
__global__ void __launch_bounds__(256, 2) reduce(float const* in, float* out) {}
__global__ void noop(void) {}
"#;

        assert_eq!(
            extract_device_kernel_signatures(source),
            vec![
                "noop()".to_string(),
                "reduce(float const*,float*)".to_string(),
                "vec_add(const float*,const float*,float*,int)".to_string(),
            ]
        );
    }

    #[test]
    fn device_kernel_abi_fingerprint_changes_on_signature_change() {
        let before = r#"
extern "C" __global__ void vec_add(const float* a, float* out, int n) {}
"#;
        let body_only = r#"
extern "C" __global__ void vec_add(const float* a, float* out, int n) { out[0] = a[0] + 1.0f; }
"#;
        let after = r#"
extern "C" __global__ void vec_add(const float* a, float* out, int n, float scale) {}
"#;

        assert_eq!(
            kernel_abi_fingerprint_source(before),
            kernel_abi_fingerprint_source(body_only)
        );
        assert_ne!(
            kernel_abi_fingerprint_source(before),
            kernel_abi_fingerprint_source(after)
        );
    }

    #[test]
    fn deterministic_gpu_edits_are_not_preempted_by_failure_rescue() {
        let status = AdaptedProjectStatus::adapted(
            PathBuf::from("core.cpp"),
            PathBuf::from("gui.cpp"),
            None,
        )
        .with_split_hash("hash1".into());
        let flags = crate::hmr::rollout_flags::RolloutFlags::new_defaults();

        assert!(prefer_deterministic_gpu_edit(
            true,
            true,
            "src/gpu/flow.hip",
            false
        ));
        assert!(prefer_deterministic_gpu_edit(
            true,
            true,
            "src/gpu/flow_template.hpp",
            false
        ));
        assert!(!prefer_deterministic_gpu_edit(
            true,
            true,
            "src/gpu/flow_template.hpp",
            true
        ));

        let effective_failures = classifier_failure_count_for_request(3, true);
        let classification = classify_loop(&LoopClassifierInput {
            adapted_status: &status,
            current_source_hash: Some("hash1"),
            rollout_flags: &flags,
            consecutive_failures: effective_failures,
            failure_rescue_threshold: 2,
            user_requested_ai: false,
            user_requested_deterministic: false,
        });

        assert_eq!(effective_failures, 0);
        assert_eq!(
            classification.loop_type,
            crate::hmr::loop_classifier::CompileLoop::LoopA
        );
    }

    fn warm_launch_indirection_report() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": "synthi.gpu.launch_indirection.v1",
            "status": "pass",
            "tableVersion": 1,
            "launchSiteCount": 1,
            "generatedLaunchSitesUseIndirection": true,
            "directLaunchBypassCount": 0,
            "loaderOwnsSymbolLookup": true,
            "vendorSymbolLookupBypassCount": 0,
            "stalePointerRisk": "none",
            "staleLaunchPointerChecks": {
                "schemaVersion": "synthi.gpu.stale_launch_pointer_check.v1",
                "status": "pass",
                "runtimeGenerationChecked": true,
                "failureReasonCode": "reload_failed.stale_launch_pointer",
                "reasonCodes": ["launch_indirection.runtime_generation_checked"]
            },
            "reasonCodes": ["launch_indirection.host_roles_use_public_wrapper"]
        })
    }

    fn warm_rebuild_sidecar(template_status: &str) -> serde_json::Value {
        let header = "#pragma once\nnamespace scale_template {\ntemplate <typename T, int BLOCK_SIZE>\n__device__ T tuned_gain(T value) {\n  constexpr T adjustment = static_cast<T>(BLOCK_SIZE) * static_cast<T>(0.00001f);\n  return value + adjustment;\n}\n}\n";
        let evidence = serde_json::json!({
            "schemaVersion": "synthi.gpu.template_evidence.v1",
            "status": template_status,
            "producer": "clang-libtooling+vendor-artifacts",
            "effectiveFlagsHash": "flags-hash",
            "gpuArch": "gfx1201",
            "bounded": true,
            "entries": [
                {
                    "templateName": "scale_template::tuned_gain<T, BLOCK_SIZE>",
                    "templateArgs": ["float", "128"],
                    "owningTU": "src/gpu/flow.hip",
                    "instantiationSite": "src/gpu/flow_template.hpp:4",
                    "reachableFromKernel": "flow(float*, int)",
                    "changedInputs": ["BLOCK_SIZE"],
                    "sourceHeaders": ["src/gpu/flow_template.hpp"],
                    "generatedRole": "device.flow",
                    "abiFingerprint": "abi",
                    "layoutFingerprint": "layout",
                    "artifactFingerprint": "artifact"
                }
            ]
        });
        normalize_split_sidecar(&serde_json::json!({
            "selectedCompileCommand": {
                "schemaVersion": "synthi.gpu.selected_compile_command.v1",
                "identity": "compile-command-id",
                "effectiveFlagsHash": "flags-hash"
            },
            "effectiveFlagsHash": "flags-hash",
            "toolchainCapabilities": {
                "schemaVersion": "synthi.gpu.toolchain_capability.v1",
                "status": "current",
                "compilerId": "hipcc",
                "gpuVendor": "rocm",
                "gpuArch": "gfx1201",
                "requiresRdc": false,
                "supportsDeviceOnlyReload": true
            },
            "sourceBaselineContents": {
                "src/gpu/flow_template.hpp": header
            },
            "sourceBaselineHashes": {
                "src/gpu/flow_template.hpp": device_source_hash(header)
            },
            "deviceMappingReport": {
                "schemaVersion": "synthi.gpu.device_mapping.v1",
                "generatedDevicePath": ".synthi/generated/gpu/device.hip",
                "deviceIncludeGraph": {
                    "schemaVersion": "synthi.gpu.device_include_graph.v1",
                    "status": "bounded",
                    "deviceTranslationUnits": ["src/gpu/flow.hip"],
                    "reachableHeaders": ["src/gpu/flow_template.hpp"],
                    "edges": [],
                    "missingIncludes": [],
                    "reasonCodes": []
                }
            },
            "templateEvidence": evidence,
            "launch_indirection_report": warm_launch_indirection_report()
        }))
    }

    fn generated_include_bridge_sidecar() -> serde_json::Value {
        let header = "#pragma once\n#ifdef __KERNELCC__\nGLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) CameraRays(HIPRTRenderData render_data)\n#else\nGLOBAL_KERNEL_SIGNATURE(void) inline CameraRays(HIPRTRenderData render_data, int x, int y)\n#endif\n{\n  render_data.random_number += 1;\n}\n";
        normalize_split_sidecar(&serde_json::json!({
            "selectedCompileCommand": {
                "schemaVersion": "synthi.gpu.selected_compile_command.v1",
                "identity": "compile-command-id",
                "effectiveFlagsHash": "flags-hash"
            },
            "effectiveFlagsHash": "flags-hash",
            "toolchainCapabilities": {
                "schemaVersion": "synthi.gpu.toolchain_capability.v1",
                "status": "current",
                "compilerId": "hipcc",
                "gpuVendor": "rocm",
                "gpuArch": "gfx1201",
                "requiresRdc": false,
                "supportsDeviceOnlyReload": true
            },
            "sourceBaselineContents": {
                "src/Device/kernels/CameraRays.h": header
            },
            "sourceBaselineHashes": {
                "src/Device/kernels/CameraRays.h": device_source_hash(header)
            },
            "deviceMappingReport": {
                "schemaVersion": "synthi.gpu.device_mapping.v1",
                "generatedDevicePath": ".synthi/generated/gpu/device.hip",
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "CameraRays",
                        "sourcePath": "src/Device/kernels/CameraRays.h",
                        "generatedRole": "device",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_include_bridge_same_source",
                        "generatedMappingMode": "source_include_bridge"
                    }
                ],
                "deviceIncludeGraph": {
                    "schemaVersion": "synthi.gpu.device_include_graph.v1",
                    "status": "bounded",
                    "deviceTranslationUnits": ["src/Device/kernels/CameraRays.h"],
                    "generatedDeviceIncludes": ["src/Device/kernels/CameraRays.h"],
                    "reachableHeaders": [],
                    "edges": [],
                    "missingIncludes": [],
                    "reasonCodes": []
                }
            },
            "launch_indirection_report": warm_launch_indirection_report()
        }))
    }

    #[test]
    fn include_bridge_partial_artifact_catalog_materializes_one_role_per_source_kernel() {
        let sidecar = normalize_split_sidecar(&serde_json::json!({
            "deviceMappingReport": {
                "schemaVersion": "synthi.gpu.device_mapping.v1",
                "generatedDevicePath": ".synthi/generated/gpu/device.hip",
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "CameraRays",
                        "sourcePath": "src/Device/kernels/CameraRays.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_include_bridge_same_source",
                        "generatedMappingMode": "source_include_bridge"
                    },
                    {
                        "kind": "kernel",
                        "symbol": "TraceTest",
                        "sourcePath": "src/Device/kernels/TraceTest.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_include_bridge_same_source",
                        "generatedMappingMode": "source_include_bridge"
                    }
                ]
            }
        }));
        let source = r#"
#include "src/Device/kernels/CameraRays.h"
#include "src/Device/kernels/TraceTest.h"
"#;

        let specs = device_partial_artifact_specs(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            source,
            None,
        );

        assert_eq!(specs.len(), 2);
        let camera = specs
            .iter()
            .find(|spec| spec.symbols == vec!["CameraRays".to_string()])
            .expect("CameraRays partial");
        assert_eq!(camera.kind, "source_include_bridge");
        assert!(camera
            .content
            .contains("#include \"src/Device/kernels/CameraRays.h\""));
        assert!(!camera
            .content
            .contains("#include \"src/Device/kernels/TraceTest.h\""));
        assert_eq!(
            camera.source_paths,
            vec!["src/Device/kernels/CameraRays.h".to_string()]
        );
    }

    #[test]
    fn include_bridge_partial_artifact_catalog_materializes_single_source_kernel() {
        let sidecar = normalize_split_sidecar(&serde_json::json!({
            "deviceMappingReport": {
                "schemaVersion": "synthi.gpu.device_mapping.v1",
                "generatedDevicePath": ".synthi/generated/gpu/device.hip",
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "MegaKernel",
                        "sourcePath": "src/Device/kernels/Megakernel.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_include_bridge_same_source",
                        "generatedMappingMode": "source_include_bridge"
                    }
                ]
            }
        }));
        let source = r#"
#include "src/Device/kernels/Megakernel.h"
"#;

        let specs = device_partial_artifact_specs(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            source,
            None,
        );

        assert_eq!(specs.len(), 1);
        let spec = specs.first().expect("single source bridge partial");
        assert_eq!(spec.kind, "source_include_bridge");
        assert_eq!(spec.symbols, vec!["MegaKernel".to_string()]);
        assert_eq!(
            spec.source_paths,
            vec!["src/Device/kernels/Megakernel.h".to_string()]
        );
        assert_eq!(
            spec.content,
            "// synthi-gpu-hmr: source include partial\n#include \"src/Device/kernels/Megakernel.h\"\n"
        );
    }

    #[test]
    fn source_backed_translation_unit_catalog_materializes_include_partial() {
        let sidecar = normalize_split_sidecar(&serde_json::json!({
            "deviceMappingReport": {
                "schemaVersion": "synthi.gpu.device_mapping.v1",
                "generatedDevicePath": FIXTURE_GENERATED_DEVICE_PATH,
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": FIXTURE_SYMBOL,
                        "sourcePath": FIXTURE_SOURCE_PATH,
                        "generatedPath": FIXTURE_GENERATED_DEVICE_PATH,
                        "mappingConfidence": "same_name_signature"
                    }
                ]
            }
        }));
        let source = format!(
            r#"
extern "C" __global__ void {FIXTURE_SIBLING_SYMBOL}(float* out) {{ out[0] = 1.0f; }}
extern "C" __global__ void {FIXTURE_SYMBOL}(float* out) {{ out[0] = 2.0f; }}
"#
        );

        let specs =
            device_partial_artifact_specs(&sidecar, FIXTURE_GENERATED_DEVICE_PATH, &source, None);

        let bridge = specs
            .iter()
            .find(|spec| {
                spec.kind == "source_include_bridge"
                    && spec.source_paths == vec![FIXTURE_SOURCE_PATH.to_string()]
            })
            .expect("source-backed TU bridge");
        assert_eq!(bridge.symbols, vec![FIXTURE_SYMBOL.to_string()]);
        assert_eq!(
            bridge.content,
            fixture_source_include_partial(FIXTURE_SOURCE_PATH)
        );
    }

    #[test]
    fn include_bridge_partial_artifact_inlines_support_context_without_sibling_kernels() {
        let temp = std::env::temp_dir().join(format!(
            "synthi-source-bridge-support-{}-{}",
            std::process::id(),
            hash_content("support-context-test")
        ));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(temp.join("src/kernels")).expect("create temp source tree");
        std::fs::write(
            temp.join("src/support.h"),
            "#ifndef SUPPORT_H\n#define SUPPORT_H\n#include \"kernels/Other.h\"\n__device__ int bridge_helper() { return 7; }\n#endif\n",
        )
        .expect("write support header");

        let sidecar = normalize_split_sidecar(&serde_json::json!({
            "deviceMappingReport": {
                "schemaVersion": "synthi.gpu.device_mapping.v1",
                "generatedDevicePath": ".synthi/generated/gpu/device.hip",
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "TargetKernel",
                        "sourcePath": "src/kernels/Target.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_include_bridge_same_source",
                        "generatedMappingMode": "source_include_bridge"
                    },
                    {
                        "kind": "kernel",
                        "symbol": "OtherKernel",
                        "sourcePath": "src/kernels/Other.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_include_bridge_same_source",
                        "generatedMappingMode": "source_include_bridge"
                    }
                ],
                "deviceIncludeGraph": {
                    "schemaVersion": "synthi.gpu.device_include_graph.v1",
                    "status": "bounded",
                    "generatedDeviceIncludes": [
                        "src/support.h",
                        "src/kernels/Target.h",
                        "src/kernels/Other.h"
                    ],
                    "edges": [
                        {
                            "source": "src/support.h",
                            "includes": ["src/kernels/Other.h"]
                        }
                    ],
                    "missingIncludes": [],
                    "reasonCodes": []
                }
            }
        }));
        let source = r#"
#include <hip/hip_runtime.h>
#define OPTION 1
#include "src/support.h"
#include "src/kernels/Target.h"
#include "src/kernels/Other.h"
extern "C" __global__ void generated_extra(float* out) { out[0] = 1.0f; }
"#;

        let specs = device_partial_artifact_specs(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            source,
            Some(temp.as_path()),
        );

        let target = specs
            .iter()
            .find(|spec| spec.symbols == vec!["TargetKernel".to_string()])
            .expect("target source bridge partial");
        assert_eq!(target.kind, "source_include_bridge");
        assert!(target.content.contains("__device__ int bridge_helper()"));
        assert!(target.content.contains("#include \"src/kernels/Target.h\""));
        assert!(!target.content.contains("kernels/Other.h\""));
        assert!(!target.content.contains("src/kernels/Other.h\""));
        assert!(!target.content.contains("generated_extra"));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn direct_device_partial_artifact_catalog_splits_monolithic_kernels_by_symbol() {
        let source = r#"
extern "C" __global__ void first(float* out) { out[0] = 1.0f; }
extern "C" __global__ void second(float* out) { out[0] = 2.0f; }
"#;

        let specs = device_partial_artifact_specs(
            &serde_json::json!({}),
            ".synthi/generated/gpu/device.hip",
            source,
            None,
        );

        assert_eq!(specs.len(), 2);
        let first = specs
            .iter()
            .find(|spec| spec.symbols == vec!["first".to_string()])
            .expect("first partial");
        assert_eq!(first.kind, "kernel_region");
        assert!(first.content.contains("void first"));
        assert!(!first.content.contains("void second"));
    }

    #[test]
    fn partial_artifact_catalog_keeps_include_bridge_and_direct_kernel_regions() {
        let sidecar = normalize_split_sidecar(&serde_json::json!({
            "deviceMappingReport": {
                "schemaVersion": "synthi.gpu.device_mapping.v1",
                "generatedDevicePath": ".synthi/generated/gpu/device.hip",
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "CameraRays",
                        "sourcePath": "src/Device/kernels/CameraRays.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_include_bridge_same_source",
                        "generatedMappingMode": "source_include_bridge"
                    },
                    {
                        "kind": "kernel",
                        "symbol": "TraceTest",
                        "sourcePath": "src/Device/kernels/TraceTest.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_include_bridge_same_source",
                        "generatedMappingMode": "source_include_bridge"
                    }
                ]
            }
        }));
        let source = r#"
#include "src/Device/kernels/CameraRays.h"
#include "src/Device/kernels/TraceTest.h"
extern "C" __global__ void generated_one(float* out) { out[0] = 1.0f; }
extern "C" __global__ void generated_two(float* out) { out[0] = 2.0f; }
"#;

        let specs = device_partial_artifact_specs(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            source,
            None,
        );

        assert_eq!(specs.len(), 4);
        assert!(specs.iter().any(|spec| {
            spec.kind == "source_include_bridge" && spec.symbols == vec!["CameraRays".to_string()]
        }));
        assert!(specs.iter().any(|spec| {
            spec.kind == "source_include_bridge" && spec.symbols == vec!["TraceTest".to_string()]
        }));
        assert!(specs.iter().any(|spec| {
            spec.kind == "kernel_region" && spec.symbols == vec!["generated_one".to_string()]
        }));
        assert!(specs.iter().any(|spec| {
            spec.kind == "kernel_region" && spec.symbols == vec!["generated_two".to_string()]
        }));
    }

    #[test]
    fn device_mapping_symbols_use_exact_generated_path_before_single_scope_fallback() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "symbol": "alpha",
                        "sourcePath": "src/a.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    },
                    {
                        "symbol": "beta",
                        "sourcePath": "src/b.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    }
                ]
            }
        });

        assert_eq!(
            device_mapping_symbols_for_generated(&sidecar, ".synthi/generated/gpu/device.hip"),
            symbols(&["alpha", "beta"])
        );
        assert_eq!(
            device_mapping_symbols_for_generated(&sidecar, "device.hip"),
            symbols(&["alpha", "beta"])
        );
    }

    #[test]
    fn device_mapping_symbols_do_not_guess_across_multiple_generated_paths() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "symbol": "alpha",
                        "sourcePath": "src/a.hip",
                        "generatedPath": ".synthi/generated/gpu/device_a.hip"
                    },
                    {
                        "symbol": "beta",
                        "sourcePath": "src/b.hip",
                        "generatedPath": ".synthi/generated/gpu/device_b.hip"
                    }
                ]
            }
        });

        assert_eq!(
            device_mapping_symbols_for_generated(&sidecar, ".synthi/generated/gpu/device_a.hip"),
            symbols(&["alpha"])
        );
        assert!(device_mapping_symbols_for_generated(&sidecar, "device.hip").is_empty());
    }

    #[test]
    fn partial_artifact_selector_prefers_matching_source_path_and_symbol() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "CameraRays",
                        "sourcePath": "src/Device/kernels/CameraRays.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_include_bridge_same_source"
                    },
                    {
                        "kind": "kernel",
                        "symbol": "MegaKernel",
                        "sourcePath": "src/Device/kernels/Megakernel.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_include_bridge_same_source"
                    }
                ]
            },
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.camera.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": ["src/Device/kernels/CameraRays.h"],
                        "symbols": ["CameraRays"],
                        "contentBytes": 200,
                        "contentHash": "camera"
                    },
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.mega.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": ["src/Device/kernels/Megakernel.h"],
                        "symbols": ["MegaKernel"],
                        "contentBytes": 100,
                        "contentHash": "mega"
                    },
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.other.hip",
                        "generatedPath": ".synthi/generated/gpu/other.hip",
                        "sourcePaths": ["src/Device/kernels/Megakernel.h"],
                        "symbols": ["MegaKernel"],
                        "contentBytes": 50,
                        "contentHash": "other"
                    }
                ]
            }
        });
        let symbols = vec!["MegaKernel".to_string()];

        let selected = select_device_partial_artifact(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some("src/Device/kernels/Megakernel.h"),
            &symbols,
        )
        .expect("matching partial artifact");

        assert_eq!(
            selected.filename,
            ".synthi/generated/gpu/device.partial.mega.hip"
        );
        assert_eq!(selected.kind, "source_include_bridge");
        assert_eq!(selected.content_hash.as_deref(), Some("mega"));
        assert!(selected.source_path_match);
    }

    #[test]
    fn partial_artifact_selector_allows_symbol_only_direct_kernel_artifacts() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "first",
                        "sourcePath": ".synthi/generated/gpu/device.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_kernel_region"
                    }
                ]
            },
            "generatedDevicePartials": {
                "artifacts": [
                    {
                        "kind": "kernel_region",
                        "filename": ".synthi/generated/gpu/device.partial.first.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": [".synthi/generated/gpu/device.hip"],
                        "symbols": ["first"],
                        "contentBytes": 64,
                        "contentHash": "h1"
                    }
                ]
            }
        });
        let symbols = vec!["first".to_string()];

        let selected = select_device_partial_artifact(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some(".synthi/generated/gpu/device.hip"),
            &symbols,
        )
        .expect("direct partial artifact");

        assert_eq!(
            selected.filename,
            ".synthi/generated/gpu/device.partial.first.hip"
        );
        assert_eq!(selected.kind, "kernel_region");
        assert!(selected.source_path_match);
    }

    #[test]
    fn partial_artifact_selector_accepts_safe_symbol_superset() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "shade_primary",
                        "sourcePath": "src/device/shade.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_include_bridge_same_source"
                    },
                    {
                        "kind": "kernel",
                        "symbol": "shade_secondary",
                        "sourcePath": "src/device/shade.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_include_bridge_same_source"
                    }
                ]
            },
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.shade.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": ["src/device/shade.h"],
                        "symbols": ["shade_primary", "shade_secondary"],
                        "contentBytes": 90,
                        "contentHash": "shade"
                    }
                ]
            }
        });
        let symbols = vec!["shade_primary".to_string()];

        let selected = select_device_partial_artifact(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some("src/device/shade.h"),
            &symbols,
        )
        .expect("safe source-owned superset");

        assert_eq!(selected.selection_reason, "safe_symbol_superset");
        assert_eq!(
            normalized_symbol_set(&selected.symbols),
            normalized_symbol_set(&["shade_primary".to_string(), "shade_secondary".to_string()])
        );
    }

    #[test]
    fn selected_partial_reload_symbols_use_artifact_owned_set() {
        let selection = DevicePartialArtifactSelection {
            filename: ".synthi/generated/gpu/device.partial.shade.hip".to_string(),
            kind: "kernel_region".to_string(),
            generated_path: ".synthi/generated/gpu/device.hip".to_string(),
            symbols: vec![
                " shade_secondary ".to_string(),
                "shade_primary".to_string(),
                "shade_secondary".to_string(),
            ],
            source_paths: vec!["src/device/shade.h".to_string()],
            content_hash: Some("hash".to_string()),
            content_bytes: Some(90),
            full_bytes: Some(900),
            source_path_match: true,
            selection_reason: "safe_symbol_superset".to_string(),
            rejection_reason: None,
            mapping_confidence: Some("generated_include_bridge_same_source".to_string()),
            verifier_evidence_id: Some("evidence".to_string()),
            dependency_hash: Some("deps".to_string()),
            compile_command_hash: Some("cmd".to_string()),
        };

        assert_eq!(
            selected_partial_reload_symbols(&selection),
            vec!["shade_primary".to_string(), "shade_secondary".to_string()]
        );
    }

    #[test]
    fn partial_artifact_selector_accepts_explicit_multi_symbol_reload_superset() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "owned_primary",
                        "sourcePath": ".synthi/generated/gpu/device.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_kernel_region"
                    },
                    {
                        "kind": "kernel",
                        "symbol": "owned_secondary",
                        "sourcePath": ".synthi/generated/gpu/device.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_kernel_region"
                    }
                ]
            },
            "generatedDevicePartials": {
                "artifacts": [
                    {
                        "kind": "kernel_region",
                        "filename": ".synthi/generated/gpu/device.partial.owned.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": [".synthi/generated/gpu/device.hip"],
                        "symbols": ["owned_primary", "owned_secondary"],
                        "contentBytes": 88,
                        "contentHash": "owned",
                        "multiSymbolReloadSupported": true
                    }
                ]
            }
        });
        let symbols = vec!["owned_primary".to_string()];

        let selected = select_device_partial_artifact(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some(".synthi/generated/gpu/device.hip"),
            &symbols,
        )
        .expect("explicit multi-symbol reload support");

        assert_eq!(selected.kind, "kernel_region");
        assert_eq!(selected.selection_reason, "safe_symbol_superset");
        assert_eq!(
            normalized_symbol_set(&selected.symbols),
            normalized_symbol_set(&["owned_primary".to_string(), "owned_secondary".to_string()])
        );
    }

    #[test]
    fn partial_artifact_selector_rejects_superset_without_reload_support() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "owned_primary",
                        "sourcePath": ".synthi/generated/gpu/device.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_kernel_region"
                    },
                    {
                        "kind": "kernel",
                        "symbol": "owned_secondary",
                        "sourcePath": ".synthi/generated/gpu/device.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "mappingConfidence": "generated_kernel_region"
                    }
                ]
            },
            "generatedDevicePartials": {
                "artifacts": [
                    {
                        "kind": "kernel_region",
                        "filename": ".synthi/generated/gpu/device.partial.owned.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": [".synthi/generated/gpu/device.hip"],
                        "symbols": ["owned_primary", "owned_secondary"],
                        "contentBytes": 88,
                        "contentHash": "owned"
                    }
                ]
            }
        });
        let report = select_device_partial_artifact_with_report(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some(".synthi/generated/gpu/device.hip"),
            &["owned_primary".to_string()],
        );

        assert!(report.selected.is_none());
        assert_eq!(
            report.rejection_reason.as_deref(),
            Some("selection.runtime_multi_symbol_reload_unsupported")
        );
    }

    #[test]
    fn compile_request_relpath_rejects_absolute_host_paths() {
        assert_eq!(
            normalized_request_filename(r"src\device\kernel.hip").as_deref(),
            Some("src/device/kernel.hip")
        );
        assert!(normalized_request_filename(r"C:\Users\dev\kernel.hip").is_none());
        assert!(normalized_request_filename("/workspace/src/device/kernel.hip").is_none());
        assert!(normalized_request_filename(r"\\server\share\kernel.hip").is_none());
        assert!(normalized_request_filename("../src/device/kernel.hip").is_none());
    }

    fn compile_request_with_file_refs(
        file_refs: Vec<crate::infra::messages::FileRef>,
    ) -> CompileRequest {
        CompileRequest {
            language: "cpp".to_string(),
            filename: "src/main.cpp".to_string(),
            source: "int main(){return 0;}\n".to_string(),
            session_id: Some("test-session".to_string()),
            files: Vec::new(),
            file_refs,
            is_gui: false,
            width: None,
            height: None,
            supports_h265: None,
            use_ai_split: false,
            user_requested_ai: false,
            user_requested_deterministic: true,
            force_gpu_ai_delta: false,
            prefer_gpu_pipeline: true,
            gpu_mode: None,
            gpu_arch: None,
            compile_manifest: None,
            target: None,
            project_root: None,
            slug: None,
        }
    }

    #[tokio::test]
    async fn workspace_file_refs_hydrate_verified_compile_inputs() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let include_dir = tmp.path().join("include");
        tokio::fs::create_dir_all(&include_dir).await.unwrap();
        let content = b"#pragma once\n#define VALUE 7\n";
        tokio::fs::write(include_dir.join("kernel.h"), content)
            .await
            .unwrap();
        let digest = format!("{:x}", Sha256::digest(content));
        let mut req = compile_request_with_file_refs(vec![crate::infra::messages::FileRef {
            name: "include/kernel.h".to_string(),
            sha256: Some(format!("sha256:{digest}")),
            bytes: Some(content.len() as u64),
        }]);

        let summary = hydrate_workspace_file_refs(tmp.path(), &mut req)
            .await
            .expect("file refs hydrate");

        assert_eq!(summary.count, 1);
        assert_eq!(summary.bytes, content.len());
        assert_eq!(req.files.len(), 1);
        assert_eq!(req.files[0].name, "include/kernel.h");
        assert_eq!(
            req.files[0].content,
            String::from_utf8_lossy(content).to_string()
        );
    }

    #[tokio::test]
    async fn workspace_file_refs_hydrate_from_collab_repo_mount_when_workspace_missing() {
        let _env_guard = WORKSPACE_FILE_REF_ENV_LOCK.lock().await;
        let previous = std::env::var("SYNTHI_REPOS_PATH").ok();
        let workspace = tempfile::tempdir().expect("workspace");
        let repos = tempfile::tempdir().expect("repos");
        let slug = "workspace-ref-slug";
        let content = b"{\"kind\":\"workspace-ref-input\"}\n";
        let collab_file = repos
            .path()
            .join(slug)
            .join("project-root")
            .join("inputs")
            .join("runtime-input.json");
        tokio::fs::create_dir_all(collab_file.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&collab_file, content).await.unwrap();
        let digest = format!("{:x}", Sha256::digest(content));
        std::env::set_var("SYNTHI_REPOS_PATH", repos.path());

        let mut req = compile_request_with_file_refs(vec![crate::infra::messages::FileRef {
            name: "inputs/runtime-input.json".to_string(),
            sha256: Some(format!("sha256:{digest}")),
            bytes: Some(content.len() as u64),
        }]);
        req.slug = Some(slug.to_string());

        let summary = hydrate_workspace_file_refs(workspace.path(), &mut req)
            .await
            .expect("file refs hydrate from collab repo mount");

        assert_eq!(summary.count, 1);
        assert_eq!(summary.bytes, content.len());
        assert_eq!(req.files[0].name, "inputs/runtime-input.json");
        assert_eq!(
            req.files[0].content,
            String::from_utf8_lossy(content).to_string()
        );
        let materialized = tokio::fs::read(
            workspace
                .path()
                .join("inputs")
                .join("runtime-input.json"),
        )
        .await
        .expect("materialized workspace ref");
        assert_eq!(materialized, content);

        if let Some(value) = previous {
            std::env::set_var("SYNTHI_REPOS_PATH", value);
        } else {
            std::env::remove_var("SYNTHI_REPOS_PATH");
        }
    }

    #[tokio::test]
    async fn workspace_file_refs_search_collab_repo_subtree_by_integrity() {
        let _env_guard = WORKSPACE_FILE_REF_ENV_LOCK.lock().await;
        let previous = std::env::var("SYNTHI_REPOS_PATH").ok();
        let workspace = tempfile::tempdir().expect("workspace");
        let repos = tempfile::tempdir().expect("repos");
        let slug = "workspace-ref-subtree-slug";
        let rel = PathBuf::from("inputs/runtime-input.json");
        let wrong_content = b"{\"kind\":\"wrong-input\"}\n";
        let expected_content = b"{\"kind\":\"expected-input\"}\n";
        let wrong_file = repos.path().join(slug).join(&rel);
        let expected_file = repos
            .path()
            .join(slug)
            .join("nested")
            .join("deeper")
            .join(&rel);
        tokio::fs::create_dir_all(wrong_file.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::create_dir_all(expected_file.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&wrong_file, wrong_content).await.unwrap();
        tokio::fs::write(&expected_file, expected_content)
            .await
            .unwrap();
        tokio::fs::create_dir_all(workspace.path().join("inputs"))
            .await
            .unwrap();
        tokio::fs::write(workspace.path().join(&rel), wrong_content)
            .await
            .unwrap();
        let digest = format!("{:x}", Sha256::digest(expected_content));
        std::env::set_var("SYNTHI_REPOS_PATH", repos.path());

        let mut req = compile_request_with_file_refs(vec![crate::infra::messages::FileRef {
            name: rel.to_string_lossy().replace('\\', "/"),
            sha256: Some(format!("sha256:{digest}")),
            bytes: Some(expected_content.len() as u64),
        }]);
        req.slug = Some(slug.to_string());

        let summary = hydrate_workspace_file_refs(workspace.path(), &mut req)
            .await
            .expect("file refs hydrate from integrity-matched subtree candidate");

        assert_eq!(summary.count, 1);
        assert_eq!(summary.bytes, expected_content.len());
        assert_eq!(
            req.files[0].content,
            String::from_utf8_lossy(expected_content).to_string()
        );
        let materialized = tokio::fs::read(workspace.path().join(&rel))
            .await
            .expect("materialized integrity-matched workspace ref");
        assert_eq!(materialized, expected_content);

        if let Some(value) = previous {
            std::env::set_var("SYNTHI_REPOS_PATH", value);
        } else {
            std::env::remove_var("SYNTHI_REPOS_PATH");
        }
    }

    #[tokio::test]
    async fn workspace_file_refs_reject_hash_mismatch() {
        let tmp = tempfile::tempdir().expect("tempdir");
        tokio::fs::write(tmp.path().join("kernel.h"), "content")
            .await
            .unwrap();
        let mut req = compile_request_with_file_refs(vec![crate::infra::messages::FileRef {
            name: "kernel.h".to_string(),
            sha256: Some("0".repeat(64)),
            bytes: None,
        }]);

        let err = hydrate_workspace_file_refs(tmp.path(), &mut req)
            .await
            .expect_err("hash mismatch should fail");
        assert!(err.to_string().contains("sha256 mismatch"));
    }

    #[tokio::test]
    async fn workspace_file_refs_reject_non_relative_paths() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut req = compile_request_with_file_refs(vec![crate::infra::messages::FileRef {
            name: "../kernel.h".to_string(),
            sha256: None,
            bytes: None,
        }]);

        let err = hydrate_workspace_file_refs(tmp.path(), &mut req)
            .await
            .expect_err("escaped path should fail");
        assert!(err.to_string().contains("workspace-relative"));
    }

    #[test]
    fn generated_include_path_normalization_preserves_unanchored_parent_segments() {
        assert_eq!(
            normalize_generated_include_path("src/device/../kernels/flow.h"),
            "src/kernels/flow.h"
        );
        assert_eq!(
            normalize_generated_include_path("../src/device/flow.h"),
            "../src/device/flow.h"
        );
        assert_eq!(
            normalize_generated_include_path("../../device/flow.h"),
            "../../device/flow.h"
        );
    }

    #[test]
    fn partial_artifact_selector_rejects_uncertain_request_path_identity() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "owned_kernel",
                        "sourcePath": "src/device/owned.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    }
                ]
            },
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.owned.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": ["src/device/owned.h"],
                        "symbols": ["owned_kernel"],
                        "contentBytes": 90,
                        "contentHash": "owned"
                    }
                ]
            }
        });
        let report = select_device_partial_artifact_with_report(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some(r"C:\workspace\src\device\owned.h"),
            &["owned_kernel".to_string()],
        );

        assert!(report.selected.is_none());
        assert_eq!(
            report.rejection_reason.as_deref(),
            Some("selection.path_identity_uncertain")
        );
    }

    #[test]
    fn partial_artifact_selector_rejects_uncertain_artifact_path_identity() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "owned_kernel",
                        "sourcePath": "src/device/owned.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    }
                ]
            },
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.owned.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": ["/workspace/src/device/owned.h"],
                        "symbols": ["owned_kernel"],
                        "contentBytes": 90,
                        "contentHash": "owned"
                    }
                ]
            }
        });
        let report = select_device_partial_artifact_with_report(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some("src/device/owned.h"),
            &["owned_kernel".to_string()],
        );

        assert!(report.selected.is_none());
        assert_eq!(
            report.rejection_reason.as_deref(),
            Some("selection.path_identity_uncertain")
        );
    }

    #[test]
    fn partial_artifact_selector_rejects_ambiguous_symbol_identity() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "owned_kernel",
                        "qualifiedSourceName": "scope::owned_kernel",
                        "signatureHash": "sig-a",
                        "sourcePath": "src/device/owned.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    },
                    {
                        "kind": "kernel",
                        "symbol": "owned_kernel",
                        "qualifiedSourceName": "scope::owned_kernel",
                        "signatureHash": "sig-b",
                        "sourcePath": "src/device/owned.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    }
                ]
            },
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.owned.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": ["src/device/owned.h"],
                        "symbols": ["owned_kernel"],
                        "contentBytes": 90,
                        "contentHash": "owned"
                    }
                ]
            }
        });
        let report = select_device_partial_artifact_with_report(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some("src/device/owned.h"),
            &["owned_kernel".to_string()],
        );

        assert!(report.selected.is_none());
        assert_eq!(
            report.rejection_reason.as_deref(),
            Some("selection.symbol_identity_uncertain")
        );
    }

    #[test]
    fn partial_artifact_selector_rejects_conflicting_compiled_symbol_identity() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "owned_kernel",
                        "qualifiedSourceName": "scope::owned_kernel",
                        "signatureHash": "sig-a",
                        "sourceSpanHash": "span-a",
                        "mangledNames": ["_Z12owned_kernelPi"],
                        "exportedNames": ["owned_kernel"],
                        "sourcePath": "src/device/owned.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    },
                    {
                        "kind": "kernel",
                        "symbol": "owned_kernel",
                        "qualifiedSourceName": "scope::owned_kernel",
                        "signatureHash": "sig-a",
                        "sourceSpanHash": "span-a",
                        "mangledNames": ["_Z12owned_kernelPf"],
                        "exportedNames": ["owned_kernel"],
                        "sourcePath": "src/device/owned.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    }
                ]
            },
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.owned.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": ["src/device/owned.h"],
                        "symbols": ["owned_kernel"],
                        "contentBytes": 90,
                        "contentHash": "owned"
                    }
                ]
            }
        });
        let report = select_device_partial_artifact_with_report(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some("src/device/owned.h"),
            &["owned_kernel".to_string()],
        );

        assert!(report.selected.is_none());
        assert_eq!(
            report.rejection_reason.as_deref(),
            Some("selection.symbol_identity_uncertain")
        );
    }

    #[test]
    fn partial_artifact_selector_accepts_reordered_compiled_symbol_identity() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "owned_kernel",
                        "qualifiedSourceName": "scope::owned_kernel",
                        "signatureHash": "sig-a",
                        "sourceSpanHash": "span-a",
                        "mangledNames": ["_Z13owned_kernel2Pi", "_Z12owned_kernelPi"],
                        "exportedNames": ["owned_kernel", "owned_kernel.stub"],
                        "sourcePath": "src/device/owned.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    },
                    {
                        "kind": "kernel",
                        "symbol": "owned_kernel",
                        "qualifiedSourceName": "scope::owned_kernel",
                        "signatureHash": "sig-a",
                        "sourceSpanHash": "span-a",
                        "mangledNames": ["_Z12owned_kernelPi", "_Z13owned_kernel2Pi"],
                        "exportedNames": ["owned_kernel.stub", "owned_kernel"],
                        "sourcePath": "src/device/owned.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    }
                ]
            },
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.owned.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": ["src/device/owned.h"],
                        "symbols": ["owned_kernel"],
                        "contentBytes": 90,
                        "contentHash": "owned"
                    }
                ]
            }
        });
        let selected = select_device_partial_artifact(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some("src/device/owned.h"),
            &["owned_kernel".to_string()],
        )
        .expect("reordered compiled identity evidence is equivalent");

        assert_eq!(selected.selection_reason, "exact_symbol_set");
        assert_eq!(selected.symbols, vec!["owned_kernel".to_string()]);
    }

    #[test]
    fn partial_artifact_selector_accepts_duplicate_symbol_identity_evidence() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "owned_kernel",
                        "qualifiedSourceName": "scope::owned_kernel",
                        "signatureHash": "sig-a",
                        "sourcePath": "src/device/owned.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    },
                    {
                        "kind": "kernel",
                        "symbol": "owned_kernel",
                        "qualifiedSourceName": "scope::owned_kernel",
                        "signatureHash": "sig-a",
                        "sourcePath": "src/device/owned.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    }
                ]
            },
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.owned.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": ["src/device/owned.h"],
                        "symbols": ["owned_kernel"],
                        "contentBytes": 90,
                        "contentHash": "owned"
                    }
                ]
            }
        });
        let selected = select_device_partial_artifact(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some("src/device/owned.h"),
            &["owned_kernel".to_string()],
        )
        .expect("duplicate identity evidence is not ambiguous");

        assert_eq!(selected.selection_reason, "exact_symbol_set");
        assert_eq!(selected.symbols, vec!["owned_kernel".to_string()]);
    }

    #[test]
    fn partial_artifact_selector_rejects_unknown_symbols() {
        let sidecar = serde_json::json!({
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.unknown.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": ["src/device/unknown.h"],
                        "symbols": ["unknown_kernel"],
                        "contentBytes": 90,
                        "contentHash": "unknown"
                    }
                ]
            }
        });
        let report = select_device_partial_artifact_with_report(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some("src/device/unknown.h"),
            &["unknown_kernel".to_string()],
        );

        assert!(report.selected.is_none());
        assert_eq!(
            report.rejection_reason.as_deref(),
            Some("selection.unknown_symbol")
        );
    }

    #[test]
    fn partial_artifact_selector_rejects_unsafe_symbol_superset() {
        let sidecar = serde_json::json!({
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "edited_kernel",
                        "sourcePath": "src/device/edited.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    },
                    {
                        "kind": "kernel",
                        "symbol": "foreign_kernel",
                        "sourcePath": "src/device/foreign.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    }
                ]
            },
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.mixed.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": ["src/device/edited.h"],
                        "symbols": ["edited_kernel", "foreign_kernel"],
                        "contentBytes": 90,
                        "contentHash": "mixed"
                    }
                ]
            }
        });
        let report = select_device_partial_artifact_with_report(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some("src/device/edited.h"),
            &["edited_kernel".to_string()],
        );

        assert!(report.selected.is_none());
        assert_eq!(
            report.rejection_reason.as_deref(),
            Some("selection.unsafe_symbol_superset")
        );
    }

    #[test]
    fn partial_artifact_selector_rejects_changed_include_root() {
        let sidecar = serde_json::json!({
            "lastDeviceFastPathVerifierReport": {
                "includeGraphRootChanged": true
            },
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "edited_kernel",
                        "sourcePath": "src/device/edited.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    }
                ]
            },
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.edited.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": ["src/device/edited.h"],
                        "symbols": ["edited_kernel"],
                        "contentBytes": 90,
                        "contentHash": "edited"
                    }
                ]
            }
        });
        let report = select_device_partial_artifact_with_report(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some("src/device/edited.h"),
            &["edited_kernel".to_string()],
        );

        assert!(report.selected.is_none());
        assert_eq!(
            report.rejection_reason.as_deref(),
            Some("selection.include_root_changed")
        );
    }

    #[test]
    fn partial_artifact_selector_rejects_macro_controlled_abi_uncertainty() {
        let sidecar = serde_json::json!({
            "lastDeviceFastPathVerifierReport": {
                "macroControlledAbiUncertain": true
            },
            "deviceMappingReport": {
                "deviceMappings": [
                    {
                        "kind": "kernel",
                        "symbol": "edited_kernel",
                        "sourcePath": "src/device/edited.h",
                        "generatedPath": ".synthi/generated/gpu/device.hip"
                    }
                ]
            },
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "kind": "source_include_bridge",
                        "filename": ".synthi/generated/gpu/device.partial.edited.hip",
                        "generatedPath": ".synthi/generated/gpu/device.hip",
                        "sourcePaths": ["src/device/edited.h"],
                        "symbols": ["edited_kernel"],
                        "contentBytes": 90,
                        "contentHash": "edited"
                    }
                ]
            }
        });
        let report = select_device_partial_artifact_with_report(
            &sidecar,
            ".synthi/generated/gpu/device.hip",
            Some("src/device/edited.h"),
            &["edited_kernel".to_string()],
        );

        assert!(report.selected.is_none());
        assert_eq!(
            report.rejection_reason.as_deref(),
            Some("selection.macro_controlled_abi_uncertain")
        );
    }

    #[test]
    fn derived_gpu_invalidation_clears_cached_fission_report() {
        let mut meta = serde_json::json!({
            "runReport": {
                "fissionVerifierReport": {
                    "status": "pass",
                    "selectedIslandId": "island:stale"
                }
            },
            "fissionVerifierReport": {
                "status": "pass",
                "selectedIslandId": "island:stale"
            },
            "fissionCandidate": {
                "islandId": "island:fresh"
            },
            "rankedReloadOptions": [
                {"plan": "device_only"}
            ]
        })
        .as_object()
        .cloned()
        .unwrap();

        invalidate_derived_gpu_reports(&mut meta);

        assert!(!meta.contains_key("runReport"));
        assert!(!meta.contains_key("rankedReloadOptions"));
        assert!(!meta.contains_key("fissionVerifierReport"));
        assert_eq!(
            meta.get("fissionCandidate")
                .and_then(|candidate| candidate.get("islandId"))
                .and_then(serde_json::Value::as_str),
            Some("island:fresh")
        );
    }

    #[test]
    fn ai_delta_payload_compiles_changed_kernel_partial() {
        let before = r#"
extern "C" __global__ void shade(float* out) { out[0] = 1.0f; }
extern "C" __global__ void trace(float* out) { out[0] = 2.0f; }
"#;
        let after = before.replace("out[0] = 2.0f;", "out[0] = 4.0f;");

        let payload = ai_delta_device_partial_payload(
            ".synthi/generated/gpu/device.hip",
            before,
            &after,
            None,
        )
        .expect("partial payload");

        assert_eq!(
            payload
                .get("artifactKind")
                .and_then(serde_json::Value::as_str),
            Some("kernel_region")
        );
        assert_eq!(
            string_array_field(&payload, "symbols"),
            vec!["trace".to_string()]
        );
        assert!(payload
            .get("content")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .contains("out[0] = 4.0f"));
        assert!(!payload
            .get("content")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .contains("__global__ void shade"));
        assert_eq!(
            payload
                .get("requirePartial")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn ai_delta_payload_uses_scoped_partial_source() {
        let scope = AiDeltaDeviceScope {
            source: "extern \"C\" __global__ void trace(float* out) { out[0] = 2.0f; }\n"
                .to_string(),
            filename: ".synthi/generated/gpu/device.partial.old.hip".to_string(),
            symbols: vec!["trace".to_string()],
            artifact_kind: "kernel_region".to_string(),
            source_paths: vec![".synthi/generated/gpu/device.hip".to_string()],
            selection_reason: "exact_symbol_set".to_string(),
            mapping_confidence: Some("generated_kernel_region".to_string()),
            dependency_hash: Some("dep-hash".to_string()),
            compile_command_hash: Some("cmd-hash".to_string()),
            verifier_evidence_id: Some("evidence-1".to_string()),
        };
        let final_scope = "extern \"C\" __global__ void trace(float* out) { out[0] = 5.0f; }\n";

        let payload = ai_delta_device_partial_payload(
            ".synthi/generated/gpu/device.hip",
            "",
            "",
            Some((&scope, final_scope)),
        )
        .expect("scoped partial payload");

        assert_eq!(
            payload.get("source").and_then(serde_json::Value::as_str),
            Some("aiDeltaPartialArtifact")
        );
        assert_eq!(
            payload
                .get("artifactFilename")
                .and_then(serde_json::Value::as_str),
            Some(".synthi/generated/gpu/device.partial.old.hip")
        );
        assert_eq!(
            payload.get("content").and_then(serde_json::Value::as_str),
            Some(final_scope)
        );
        assert_eq!(
            string_array_field(&payload, "symbols"),
            vec!["trace".to_string()]
        );
        assert_eq!(
            payload
                .get("selectionReason")
                .and_then(serde_json::Value::as_str),
            Some("exact_symbol_set")
        );
        assert_eq!(
            payload
                .get("dependencyHash")
                .and_then(serde_json::Value::as_str),
            Some("dep-hash")
        );
    }

    #[test]
    fn partial_artifact_catalog_refresh_updates_matching_reports_only() {
        let mut sidecar = serde_json::json!({
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "filename": ".synthi/generated/gpu/device.partial.target.hip",
                        "contentBytes": 10,
                        "contentHash": "old"
                    },
                    {
                        "filename": ".synthi/generated/gpu/device.partial.other.hip",
                        "contentBytes": 20,
                        "contentHash": "old-other"
                    }
                ]
            },
            "generatedDevicePartials": {
                "artifacts": [
                    {
                        "filename": ".synthi/generated/gpu/device.partial.target.hip",
                        "contentBytes": 10,
                        "contentHash": "old"
                    }
                ]
            }
        });
        let source = fixture_kernel_source(FIXTURE_SYMBOL);

        assert!(refresh_device_partial_artifact_catalog_value(
            &mut sidecar,
            ".synthi/generated/gpu/device.partial.target.hip",
            &source,
            &[FIXTURE_SYMBOL.to_string()],
            Some(FIXTURE_GENERATED_DEVICE_PATH),
            Some("source_include_bridge"),
            &[FIXTURE_SOURCE_PATH.to_string()],
        ));

        let expected_hash = format!("{}", hash_content(&source));
        for pointer in [
            "/devicePartialArtifacts/artifacts/0",
            "/generatedDevicePartials/artifacts/0",
        ] {
            let artifact = sidecar.pointer(pointer).expect("updated artifact");
            assert_eq!(
                artifact
                    .get("contentBytes")
                    .and_then(serde_json::Value::as_u64),
                Some(source.len() as u64)
            );
            assert_eq!(
                artifact
                    .get("contentHash")
                    .and_then(serde_json::Value::as_str),
                Some(expected_hash.as_str())
            );
            assert_eq!(
                artifact
                    .get("contentSource")
                    .and_then(serde_json::Value::as_str),
                Some("compiled_source")
            );
            assert_eq!(
                artifact.get("kind").and_then(serde_json::Value::as_str),
                Some("source_include_bridge")
            );
            assert_eq!(
                string_array_field(artifact, "sourcePaths"),
                vec![FIXTURE_SOURCE_PATH.to_string()]
            );
        }

        let other = sidecar
            .pointer("/devicePartialArtifacts/artifacts/1")
            .expect("unrelated artifact");
        assert_eq!(
            other.get("contentHash").and_then(serde_json::Value::as_str),
            Some("old-other")
        );
    }

    #[test]
    fn partial_artifact_catalog_refresh_can_rekey_by_exact_symbol_set() {
        let mut sidecar = serde_json::json!({
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "filename": ".synthi/generated/gpu/device.partial.old.hip",
                        "generatedPath": FIXTURE_GENERATED_DEVICE_PATH,
                        "symbols": [FIXTURE_SYMBOL],
                        "sourcePaths": [FIXTURE_SOURCE_PATH],
                        "contentBytes": 12000,
                        "contentHash": "old"
                    }
                ]
            },
            "generatedDevicePartials": {
                "artifacts": [
                    {
                        "filename": ".synthi/generated/gpu/device.partial.old.hip",
                        "generatedPath": FIXTURE_GENERATED_DEVICE_PATH,
                        "symbols": [FIXTURE_SYMBOL],
                        "sourcePaths": [FIXTURE_SOURCE_PATH],
                        "contentBytes": 12000,
                        "contentHash": "old"
                    }
                ]
            }
        });
        let source = fixture_kernel_source(FIXTURE_SYMBOL);
        let new_filename = ".synthi/generated/gpu/device.partial.new.hip";

        assert!(refresh_device_partial_artifact_catalog_value(
            &mut sidecar,
            new_filename,
            &source,
            &[FIXTURE_SYMBOL.to_string()],
            Some(FIXTURE_GENERATED_DEVICE_PATH),
            Some("source_include_bridge"),
            &[FIXTURE_SOURCE_PATH.to_string()],
        ));

        let expected_hash = format!("{}", hash_content(&source));
        for pointer in [
            "/devicePartialArtifacts/artifacts/0",
            "/generatedDevicePartials/artifacts/0",
        ] {
            let artifact = sidecar.pointer(pointer).expect("updated artifact");
            assert_eq!(
                artifact.get("filename").and_then(serde_json::Value::as_str),
                Some(new_filename)
            );
            assert_eq!(
                artifact
                    .get("contentHash")
                    .and_then(serde_json::Value::as_str),
                Some(expected_hash.as_str())
            );
            assert_eq!(
                artifact.get("kind").and_then(serde_json::Value::as_str),
                Some("source_include_bridge")
            );
            assert_eq!(
                string_array_field(artifact, "sourcePaths"),
                vec![FIXTURE_SOURCE_PATH.to_string()]
            );
        }
    }

    #[test]
    fn partial_artifact_catalog_refresh_prefers_exact_filename_over_symbol_rekey() {
        let mut sidecar = serde_json::json!({
            "devicePartialArtifacts": {
                "artifacts": [
                    {
                        "filename": FIXTURE_SOURCE_PARTIAL_FILENAME,
                        "kind": "source_include_bridge",
                        "generatedPath": FIXTURE_GENERATED_DEVICE_PATH,
                        "symbols": [FIXTURE_SYMBOL],
                        "sourcePaths": [FIXTURE_SOURCE_PATH],
                        "contentBytes": 82,
                        "contentHash": "old-source"
                    },
                    {
                        "filename": FIXTURE_KERNEL_PARTIAL_FILENAME,
                        "kind": "kernel_region",
                        "generatedPath": FIXTURE_GENERATED_DEVICE_PATH,
                        "symbols": [FIXTURE_SYMBOL],
                        "sourcePaths": [FIXTURE_GENERATED_DEVICE_PATH],
                        "contentBytes": 1600,
                        "contentHash": "old-kernel"
                    }
                ]
            },
            "generatedDevicePartials": {
                "artifacts": [
                    {
                        "filename": FIXTURE_SOURCE_PARTIAL_FILENAME,
                        "kind": "source_include_bridge",
                        "generatedPath": FIXTURE_GENERATED_DEVICE_PATH,
                        "symbols": [FIXTURE_SYMBOL],
                        "sourcePaths": [FIXTURE_SOURCE_PATH],
                        "contentBytes": 82,
                        "contentHash": "old-source"
                    },
                    {
                        "filename": FIXTURE_KERNEL_PARTIAL_FILENAME,
                        "kind": "kernel_region",
                        "generatedPath": FIXTURE_GENERATED_DEVICE_PATH,
                        "symbols": [FIXTURE_SYMBOL],
                        "sourcePaths": [FIXTURE_GENERATED_DEVICE_PATH],
                        "contentBytes": 1600,
                        "contentHash": "old-kernel"
                    }
                ]
            }
        });
        let source = fixture_source_include_partial(FIXTURE_SOURCE_PATH);

        assert!(refresh_device_partial_artifact_catalog_value(
            &mut sidecar,
            FIXTURE_SOURCE_PARTIAL_FILENAME,
            &source,
            &[FIXTURE_SYMBOL.to_string()],
            Some(FIXTURE_GENERATED_DEVICE_PATH),
            Some("source_include_bridge"),
            &[FIXTURE_SOURCE_PATH.to_string()],
        ));

        let expected_hash = format!("{}", hash_content(&source));
        for report_key in ["devicePartialArtifacts", "generatedDevicePartials"] {
            let artifacts = sidecar
                .pointer(&format!("/{report_key}/artifacts"))
                .and_then(serde_json::Value::as_array)
                .expect("artifacts");
            assert_eq!(artifacts.len(), 2);
            assert_eq!(
                artifacts[0]
                    .get("contentHash")
                    .and_then(serde_json::Value::as_str),
                Some(expected_hash.as_str())
            );
            assert_eq!(
                artifacts[1]
                    .get("filename")
                    .and_then(serde_json::Value::as_str),
                Some(FIXTURE_KERNEL_PARTIAL_FILENAME)
            );
            assert_eq!(
                artifacts[1]
                    .get("contentHash")
                    .and_then(serde_json::Value::as_str),
                Some("old-kernel")
            );
            assert_eq!(
                artifacts[1].get("kind").and_then(serde_json::Value::as_str),
                Some("kernel_region")
            );
        }
    }

    #[test]
    fn warm_rebuild_header_edit_requires_fresh_bounded_template_evidence() {
        let sidecar = warm_rebuild_sidecar("fresh");
        let old_header = sidecar
            .pointer("/sourceBaselineContents/src~1gpu~1flow_template.hpp")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        let new_header = old_header.replace("0.00001f", "0.00002f");

        let decision = try_warm_rebuild_header_plan(
            &sidecar,
            "src/gpu/flow_template.hpp",
            old_header,
            &new_header,
            Some(".synthi/generated/gpu/device.hip"),
        )
        .expect("warm decision");

        assert!(
            decision.accepted,
            "reason_codes={:?} verifier={}",
            decision.reason_codes, decision.verifier_report
        );
        assert_eq!(
            decision
                .reload_plan
                .get("plan")
                .and_then(serde_json::Value::as_str),
            Some("warm_rebuild")
        );
        assert!(decision
            .reason_codes
            .iter()
            .any(|code| code == "template_evidence_fresh"));
        assert_eq!(decision.affected_symbols, vec!["flow".to_string()]);
        assert_eq!(
            decision.affected_source_paths,
            vec!["src/gpu/flow.hip".to_string()]
        );
        let bridge = build_source_include_partial_source(&decision.affected_source_paths)
            .expect("source bridge partial");
        assert_eq!(
            bridge,
            "// synthi-gpu-hmr: source include partial\n#include \"src/gpu/flow.hip\"\n"
        );
        assert_eq!(
            decision
                .verifier_report
                .get("status")
                .and_then(serde_json::Value::as_str),
            Some("accept")
        );
    }

    #[test]
    fn warm_rebuild_header_edit_rejects_stale_template_evidence() {
        let sidecar = warm_rebuild_sidecar("stale");
        let old_header = sidecar
            .pointer("/sourceBaselineContents/src~1gpu~1flow_template.hpp")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        let new_header = old_header.replace("0.00001f", "0.00002f");

        let decision = try_warm_rebuild_header_plan(
            &sidecar,
            "src/gpu/flow_template.hpp",
            old_header,
            &new_header,
            Some(".synthi/generated/gpu/device.hip"),
        )
        .expect("warm decision");

        assert!(!decision.accepted);
        assert_eq!(
            decision
                .reload_plan
                .get("plan")
                .and_then(serde_json::Value::as_str),
            Some("unsupported")
        );
        assert!(decision
            .reason_codes
            .iter()
            .any(|code| code == "template_evidence_stale"));
    }

    #[test]
    fn warm_rebuild_accepts_generated_include_kernel_body_edit_without_template_evidence() {
        let sidecar = generated_include_bridge_sidecar();
        let old_header = sidecar
            .pointer("/sourceBaselineContents/src~1Device~1kernels~1CameraRays.h")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        let new_header = old_header.replace("random_number += 1", "random_number += 3");

        let decision = try_warm_rebuild_header_plan(
            &sidecar,
            "src/Device/kernels/CameraRays.h",
            old_header,
            &new_header,
            Some(".synthi/generated/gpu/device.hip"),
        )
        .expect("warm decision");

        assert!(
            decision.accepted,
            "reason_codes={:?} verifier={}",
            decision.reason_codes, decision.verifier_report
        );
        assert_eq!(
            decision
                .reload_plan
                .get("plan")
                .and_then(serde_json::Value::as_str),
            Some("warm_rebuild")
        );
        assert!(decision
            .reason_codes
            .iter()
            .any(|code| code == "edit.header_kernel_body_only"));
        assert!(decision
            .reason_codes
            .iter()
            .any(|code| code == "template_evidence_not_required"));
        assert_eq!(decision.affected_symbols, vec!["CameraRays".to_string()]);
    }

    #[test]
    fn include_bridge_kernel_paths_omit_only_other_mapped_kernel_sources() {
        let mut sidecar = generated_include_bridge_sidecar();
        sidecar["deviceMappingReport"]["deviceMappings"] = serde_json::json!([
            {
                "kind": "kernel",
                "symbol": "CameraRays",
                "sourcePath": "src/Device/kernels/CameraRays.h",
                "generatedRole": "device",
                "generatedPath": ".synthi/generated/gpu/device.hip",
                "mappingConfidence": "generated_include_bridge_same_source",
                "generatedMappingMode": "source_include_bridge"
            },
            {
                "kind": "kernel",
                "symbol": "MegaKernel",
                "sourcePath": "src/Device/kernels/Megakernel.h",
                "generatedRole": "device",
                "generatedPath": ".synthi/generated/gpu/device.hip",
                "mappingConfidence": "generated_include_bridge_same_source",
                "generatedMappingMode": "source_include_bridge"
            }
        ]);

        let (targets, omitted) =
            include_bridge_kernel_source_paths(&sidecar, "src/Device/kernels/CameraRays.h");

        assert_eq!(targets, vec!["src/Device/kernels/CameraRays.h".to_string()]);
        assert_eq!(omitted, vec!["src/Device/kernels/Megakernel.h".to_string()]);
    }

    #[test]
    fn device_only_compile_stage_reuses_host_modules_after_initial_load() {
        let split_data = serde_json::json!({
            "_synthi_reload_plan": "device_only",
            "_synthi_device_partial": {
                "content": "__global__ void CameraRays() {}",
                "filename": ".synthi/generated/gpu/device.partial.hip",
                "symbols": ["CameraRays"]
            }
        });

        assert!(can_compile_device_only_stage(
            &split_data,
            true,
            true,
            true,
            true
        ));
        assert!(!can_compile_device_only_stage(
            &split_data,
            true,
            false,
            true,
            true
        ));
        assert!(!can_compile_device_only_stage(
            &split_data,
            false,
            true,
            true,
            true
        ));
    }

    #[test]
    fn single_translation_unit_partial_requires_exact_symbol_ownership() {
        let source = "extern \"C\" __global__ void shade(float* x) { x[0] += 1.0f; }\n";
        let payload = single_translation_unit_partial_payload(
            ".synthi/generated/gpu/device.hip",
            source,
            &["shade".to_string()],
            &["shade".to_string()],
        )
        .expect("single-symbol translation unit is a valid partial reload unit");

        assert_eq!(
            payload
                .get("artifactKind")
                .and_then(serde_json::Value::as_str),
            Some("kernel_translation_unit")
        );
        assert_eq!(
            payload
                .get("requirePartial")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            payload
                .get("symbols")
                .and_then(serde_json::Value::as_array)
                .and_then(|items| items.first())
                .and_then(serde_json::Value::as_str),
            Some("shade")
        );

        assert!(single_translation_unit_partial_payload(
            ".synthi/generated/gpu/device.hip",
            source,
            &["shade".to_string(), "trace".to_string()],
            &["shade".to_string()],
        )
        .is_none());
    }

    #[test]
    fn device_only_compile_stage_requires_gui_path_for_gui_session() {
        let split_data = serde_json::json!({
            "_synthi_reload_plan": { "selectedPlan": "device_only" }
        });

        assert!(!can_compile_device_only_stage(
            &split_data,
            true,
            true,
            false,
            true
        ));
        assert!(can_compile_device_only_stage(
            &split_data,
            true,
            true,
            false,
            false
        ));
    }

    #[test]
    fn device_only_compile_stage_accepts_verified_warm_rebuild_package() {
        let split_data = serde_json::json!({
            "_synthi_reload_plan": { "plan": "warm_rebuild" }
        });

        assert!(can_compile_device_only_stage(
            &split_data,
            true,
            true,
            true,
            true
        ));
    }

    #[test]
    fn warm_rebuild_header_edit_rejects_unbounded_header_graph() {
        let mut sidecar = warm_rebuild_sidecar("fresh");
        sidecar["affectedHeaderGraph"]["reachableHeaders"] = serde_json::json!([]);
        sidecar["deviceMappingReport"]["deviceIncludeGraph"]["reachableHeaders"] =
            serde_json::json!([]);
        sidecar["affectedTemplateInstantiations"][0]["sourceHeaders"] = serde_json::json!([]);
        let old_header = sidecar
            .pointer("/sourceBaselineContents/src~1gpu~1flow_template.hpp")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        let new_header = old_header.replace("0.00001f", "0.00002f");

        let decision = try_warm_rebuild_header_plan(
            &sidecar,
            "src/gpu/flow_template.hpp",
            old_header,
            &new_header,
            Some(".synthi/generated/gpu/device.hip"),
        )
        .expect("warm decision");

        assert!(!decision.accepted);
        assert!(decision
            .reason_codes
            .iter()
            .any(|code| code == "header_dependency_unbounded"));
    }

    #[test]
    fn gpu_ai_delta_rejection_report_records_deterministic_evidence() {
        let (plan, report, reasons) = gpu_ai_delta_rejection_reports(
            "device_only",
            "src/gpu/particle_kernels.hip",
            ".synthi/generated/gpu/device.hip",
            "advance(float*,int)",
            "advance(float*,int,float)",
            "layout-before",
            "layout-after",
        );

        assert_eq!(
            plan.get("plan").and_then(serde_json::Value::as_str),
            Some("abi_breaking")
        );
        assert!(reasons
            .iter()
            .any(|code| code == "verifier.ai_delta_rejected"));
        assert!(reasons
            .iter()
            .any(|code| code == "abi.kernel_signature_changed"));
        assert!(reasons
            .iter()
            .any(|code| code == "abi.constant_global_layout_changed"));
        assert_eq!(
            report.get("status").and_then(serde_json::Value::as_str),
            Some("reject")
        );
        assert_eq!(
            report
                .pointer("/evidence/kernelSignature/changed")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            report
                .pointer("/evidence/constantGlobalLayout/changed")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn gpu_ai_delta_policy_rejection_report_records_consent_reason() {
        let (plan, report, reasons) = gpu_ai_delta_policy_rejection_reports(
            "device_only",
            "src/gpu/particle_kernels.hip",
            ".synthi/generated/gpu/device.hip",
            vec![
                "toolchain_capability_stale".to_string(),
                "multi_role_ai_delta_requires_consent".to_string(),
                "arbiter_user_consent_required".to_string(),
            ],
            vec!["device".to_string(), "shared".to_string()],
        );

        assert_eq!(
            plan.get("plan").and_then(serde_json::Value::as_str),
            Some("unsupported")
        );
        assert!(reasons
            .iter()
            .any(|code| code == "verifier.ai_delta_rejected"));
        assert!(reasons
            .iter()
            .any(|code| code == "toolchain_capability_stale"));
        assert!(reasons
            .iter()
            .any(|code| code == "multi_role_ai_delta_requires_consent"));
        assert!(reasons
            .iter()
            .any(|code| code == "arbiter_user_consent_required"));
        assert_eq!(
            report
                .pointer("/evidence/touchedGeneratedRoles/0")
                .and_then(serde_json::Value::as_str),
            Some("device")
        );
    }

    #[test]
    fn gpu_ai_delta_policy_rejection_report_records_empty_ai_delta() {
        let (plan, report, reasons) = gpu_ai_delta_policy_rejection_reports(
            "device_only",
            "src/gpu/particle_kernels.hip",
            ".synthi/generated/gpu/device.hip",
            vec![
                "toolchain_capability_stale".to_string(),
                "verifier.ai_delta_no_edits".to_string(),
            ],
            Vec::new(),
        );

        assert_eq!(
            plan.get("plan").and_then(serde_json::Value::as_str),
            Some("unsupported")
        );
        assert!(reasons
            .iter()
            .any(|code| code == "verifier.ai_delta_rejected"));
        assert!(reasons
            .iter()
            .any(|code| code == "toolchain_capability_stale"));
        assert!(reasons
            .iter()
            .any(|code| code == "verifier.ai_delta_no_edits"));
        assert_eq!(
            report
                .pointer("/evidence/touchedGeneratedRoles")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len),
            Some(0)
        );
    }

    #[test]
    fn gpu_ai_delta_touched_roles_are_stable_and_unique() {
        use crate::hmr::edit_applier::{Edit, EditOperation};

        let edits = vec![
            Edit {
                module: "device".to_string(),
                operation: EditOperation::Replace,
                anchor: "a".to_string(),
                content: "b".to_string(),
            },
            Edit {
                module: "shared".to_string(),
                operation: EditOperation::Replace,
                anchor: "x".to_string(),
                content: "y".to_string(),
            },
            Edit {
                module: "device".to_string(),
                operation: EditOperation::Replace,
                anchor: "c".to_string(),
                content: "d".to_string(),
            },
        ];

        assert_eq!(
            gpu_ai_delta_touched_roles(&edits),
            vec!["device".to_string(), "shared".to_string()]
        );
    }

    #[test]
    fn generated_role_include_policy_allows_only_generated_role_headers() {
        let roles = [
            (
                "shared",
                ".synthi/generated/gpu/shared.h",
                "#pragma once\n#include \"synthi_gpu_runtime.h\"\n",
            ),
            (
                "core",
                ".synthi/generated/gpu/core.cpp",
                "#include \"shared.h\"\nvoid core_on_update(){}\n",
            ),
            (
                "gui",
                ".synthi/generated/gpu/gui.cpp",
                "#include \"shared.h\"\nvoid gui_on_render(void*){}\n",
            ),
        ];

        assert!(generated_role_include_policy_violations(&roles).is_empty());
    }

    #[test]
    fn generated_role_include_policy_rejects_project_headers() {
        let roles = [
            (
                "shared",
                ".synthi/generated/gpu/shared.h",
                "#pragma once\n#include \"synthi_gpu_runtime.h\"\n",
            ),
            (
                "core",
                ".synthi/generated/gpu/core.cpp",
                "#include \"shared.h\"\n#include \"Device/includes/AdaptiveSampling.h\"\n",
            ),
        ];

        let violations = generated_role_include_policy_violations(&roles);
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].role, "core");
        assert_eq!(
            violations[0].include_path,
            "Device/includes/AdaptiveSampling.h"
        );
    }

    #[test]
    fn abi_device_fast_path_rejections_do_not_fall_through() {
        assert!(device_fast_path_rejection_blocks_fallback(&[
            "edit.kernel_body_only".to_string(),
            "abi.kernel_signature_changed".to_string(),
        ]));
        assert!(device_fast_path_rejection_blocks_fallback(&[
            "abi.constant_global_layout_changed".to_string()
        ]));
        assert!(device_fast_path_rejection_blocks_fallback(&[
            "toolchain_capability_missing".to_string()
        ]));
        assert!(device_fast_path_rejection_blocks_fallback(&[
            "toolchain_capability_stale".to_string()
        ]));
        assert!(device_fast_path_rejection_blocks_fallback(&[
            "toolchain_capability_no_device_only_reload".to_string()
        ]));
        assert!(device_fast_path_rejection_blocks_fallback(&[
            "fast_path_policy_blocks_device_only".to_string()
        ]));
        assert!(device_fast_path_rejection_blocks_fallback(&[
            "gpu_device_tainted".to_string()
        ]));
        assert!(device_fast_path_rejection_blocks_fallback(&[
            "vram_session_refresh_required".to_string()
        ]));
        assert!(!device_fast_path_rejection_blocks_fallback(&[
            "mapping.patch_anchor_missing".to_string()
        ]));
    }

    #[test]
    fn missing_toolchain_capability_only_bootstraps_without_prior_device_state() {
        let reasons = vec!["toolchain_capability_missing".to_string()];
        assert!(device_fast_path_missing_toolchain_allows_split_bootstrap(
            &serde_json::json!({}),
            "src/gpu/kernel.hip",
            None,
            &reasons,
        ));
        assert!(!device_fast_path_missing_toolchain_allows_split_bootstrap(
            &serde_json::json!({}),
            "src/gpu/kernel.hip",
            Some(".synthi/generated/gpu/device.hip"),
            &reasons,
        ));
        assert!(!device_fast_path_missing_toolchain_allows_split_bootstrap(
            &serde_json::json!({
                "sourceBaselineContents": {
                    "src/gpu/kernel.hip": "__global__ void kernel() {}"
                }
            }),
            "src/gpu/kernel.hip",
            None,
            &reasons,
        ));
        assert!(!device_fast_path_missing_toolchain_allows_split_bootstrap(
            &serde_json::json!({}),
            "src/gpu/kernel.hip",
            None,
            &["toolchain_capability_stale".to_string()],
        ));
    }
}
