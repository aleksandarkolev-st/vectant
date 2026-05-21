use crate::debug_log;
use anyhow::{Context, Result};
use std::path::{Component, Path, PathBuf};

use crate::compiler::builder::{
    hash_content, hash_shared_header_semantic, ModuleHashes, RebuildScope,
};
use crate::compiler::context::CompileContext;
use crate::infra::messages::CompileRequest;

// ULTRAPLAN Lightning Phase 11 — per-process Tier 0 bypass counters.
// Atomic so they're safe across concurrent compile requests (unlikely
// in practice — single worker — but correct by construction).
static TIER0_HITS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static TIER0_MISSES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static TIER0_INELIGIBLE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// Import our new modular stages
use crate::compiler::stages::ai_utils::{
    perform_ai_diff_patch, perform_ai_split, perform_gpu_ai_diff_patch,
};
use crate::compiler::stages::compile_core::compile_core;
use crate::compiler::stages::compile_device::{compile_device_phase0, DeviceCompileOutcome};
use crate::compiler::stages::compile_gui::compile_gui;
use crate::compiler::stages::compile_runner::{compile_runner, HOST_RUNNER_FILENAME};
use crate::compiler::stages::gpu_runtime_contract::ensure_gpu_runtime_contract_header;
use crate::compiler::stages::guardrails::{
    apply_core_guardrails, apply_gui_guardrails, apply_shared_guardrails,
};
use crate::compiler::stages::runner::{handle_runner_execution, RunnerReloadPolicy};
use crate::runtime::capability::HmrStatus;

fn compile_request_relpath(path: &str) -> Result<PathBuf> {
    if path.trim().is_empty() {
        anyhow::bail!("compile request contains an empty filename");
    }

    let mut rel = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => rel.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                anyhow::bail!("compile request filename is not workspace-relative: {path}");
            }
        }
    }

    if rel.as_os_str().is_empty() {
        anyhow::bail!("compile request filename resolves to an empty path: {path}");
    }
    Ok(rel)
}

async fn write_compile_request_file(workspace: &Path, name: &str, content: &str) -> Result<()> {
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
async fn write_sidecar_logged(path: &std::path::Path, meta: &serde_json::Value) {
    let enriched_meta = normalize_split_sidecar(meta);
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
use crate::hmr::adapter_trait::AdapterReloadResult;
use crate::hmr::ai_bypass::{check_ai_bypass, AiBypassResult, SplitCache};
use crate::hmr::build_manifest::{BuildManifest, BuildSlot, SnapshotMode};
use crate::hmr::compile_enrichment::CompileEnrichment;
use crate::hmr::compile_manifest::{CompileManifest, DeviceVendor, ModuleKind};
use crate::hmr::deterministic_compile::{
    determine_deterministic_scope, validate_deterministic_input, DeterministicCompileInput,
    DeterministicRebuildScope,
};
use crate::hmr::gpu_device_fast_path::{
    device_only_capability_rejection_reason, device_source_hash, mapped_generated_device_path,
    try_direct_device_body_patch,
};
use crate::hmr::gpu_prod_contracts::{normalize_split_sidecar, RELOAD_PLAN_SCHEMA_VERSION};
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

fn device_filename_for_vendor(vendor: DeviceVendor) -> &'static str {
    match vendor {
        DeviceVendor::Cuda => "device.cu",
        DeviceVendor::Rocm => "device.hip",
    }
}

fn is_device_source_request(filename: &str) -> bool {
    normalized_request_filename(filename)
        .map(|name| {
            let lower = name.to_ascii_lowercase();
            lower.ends_with(".cu") || lower.ends_with(".hip")
        })
        .unwrap_or(false)
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

#[derive(Debug, Clone)]
struct WarmRebuildDecision {
    accepted: bool,
    reload_plan: serde_json::Value,
    verifier_report: serde_json::Value,
    reason_codes: Vec<String>,
    generated_device_path: Option<String>,
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

fn device_include_graph_mentions_source(sidecar: &serde_json::Value, path: &str) -> bool {
    sidecar_array_contains_path(sidecar, "/affectedHeaderGraph/reachableHeaders", path)
        || sidecar_array_contains_path(
            sidecar,
            "/deviceMappingReport/deviceIncludeGraph/reachableHeaders",
            path,
        )
        || template_evidence_mentions_source(sidecar, path)
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
    let normalized_candidate =
        normalize_split_sidecar(&serde_json::Value::Object(candidate_meta));

    let arbiter_decision = normalized_candidate
        .get("arbiterDecision")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unsupported");
    let selected_plan = normalized_candidate
        .get("selectedPlan")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let mut reason_codes = if preflight_reasons.is_empty()
        && arbiter_decision == "auto_run"
        && selected_plan == "warm_rebuild"
    {
        vec![
            "edit.device_reachable_header".to_string(),
            "template_evidence_fresh".to_string(),
            "template_instantiation_bounded".to_string(),
            "build.warm_rebuild".to_string(),
            "build.device_sidecar_rebuild".to_string(),
        ]
    } else {
        let mut reasons = preflight_reasons;
        reasons.extend(ranked_option_reason_codes(
            &normalized_candidate,
            "warm_rebuild",
        ));
        if arbiter_decision != "auto_run" {
            reasons.push("arbiter_path_not_worth_running".to_string());
        }
        reasons
    };
    reason_codes.sort_unstable();
    reason_codes.dedup();

    let accepted = reason_codes
        .iter()
        .any(|code| code == "build.warm_rebuild")
        && arbiter_decision == "auto_run"
        && selected_plan == "warm_rebuild";
    let estimated_ms = ranked_option_estimate_ms(&normalized_candidate, "warm_rebuild");
    let plan = warm_rebuild_reload_plan(
        if accepted { "warm_rebuild" } else { "unsupported" },
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
    req: CompileRequest,
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

    // ── Detect adapted-project status ──
    let mut adapted_status = detect_adapted_project(&ctx.workspace_path);

    // Try to read persisted split hash from sidecar
    let sidecar_path = ctx.workspace_path.join(".synthi_split_meta.json");
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
    let classifier_input = LoopClassifierInput {
        adapted_status: &adapted_status,
        current_source_hash: Some(&source_hash_str),
        rollout_flags: &rollout_flags,
        consecutive_failures,
        failure_rescue_threshold: 2,
        user_requested_ai: req.user_requested_ai,
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
        "[HMR] classify_loop → {:?} (reason={:?}) inputs: is_adapted={} split_hash={:?} src_hash={} consec_fail={} user_ai={} user_det={} lang={}",
        compile_loop,
        classification.reason,
        adapted_status.is_adapted,
        adapted_status.split_hash,
        source_hash_str,
        consecutive_failures,
        req.user_requested_ai,
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
            write_sidecar_logged(&sidecar_path, &meta).await;

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
                serde_json::json!({
                    "shared": { "content": shared_content, "filename": shared_filename },
                    "core": { "content": core_content, "filename": core_filename },
                    "gui": { "content": gui_content, "filename": gui_filename }
                })
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
                let direct_device_split = if is_device_source_request(&req.filename)
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
                        write_sidecar_logged(&sidecar_path, &serde_json::Value::Object(meta)).await;
                        eprintln!(
                            "[gpu-hmr] device_only fast path accepted: user={} generated={} reasons={}",
                            request_device_name,
                            generated_path,
                            device_patch.reason_codes.join(",")
                        );
                        Some(serde_json::json!({
                            "shared": { "content": shared_content, "filename": shared_filename },
                            "core": { "content": core_content, "filename": core_filename },
                            "gui": { "content": gui_content, "filename": gui_filename },
                            "host_runner": { "content": host_runner_content, "filename": host_runner_filename },
                            "device": { "content": patched_device_source, "filename": generated_path },
                            "_synthi_manifest": sidecar_manifest_json.clone(),
                            "_synthi_reload_plan": device_patch.reload_plan.clone(),
                        }))
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
                        write_sidecar_logged(&sidecar_path, &serde_json::Value::Object(meta)).await;
                        eprintln!(
                            "[gpu-hmr] device_only fast path rejected: user={} reasons={}",
                            request_device_name,
                            device_patch.reason_codes.join(",")
                        );
                        if device_fast_path_rejection_blocks_fallback(&device_patch.reason_codes) {
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
                        natural_gpu_ai_delta_reason_codes = device_patch.reason_codes.clone();
                        eprintln!(
                            "[GPU AI Delta] natural fallback requested: user={} reasons={}",
                            request_device_name,
                            natural_gpu_ai_delta_reason_codes.join(",")
                        );
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
                        write_sidecar_logged(&sidecar_path, &serde_json::Value::Object(meta))
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
                        Some(serde_json::json!({
                            "shared": { "content": shared_content, "filename": shared_filename },
                            "core": { "content": core_content, "filename": core_filename },
                            "gui": { "content": gui_content, "filename": gui_filename },
                            "host_runner": { "content": host_runner_content, "filename": host_runner_filename },
                            "device": { "content": generated_device_source, "filename": generated_path },
                            "_synthi_manifest": sidecar_manifest_json.clone(),
                            "_synthi_reload_plan": warm.reload_plan.clone(),
                        }))
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
                            if !is_device_source_request(&request_device_name) {
                                anyhow::bail!(
                                    "GPU AI delta requires a .cu/.hip request, got {}",
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
                                &generated_device_source,
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
                                final_device,
                            ) = crate::hmr::edit_applier::apply_edit_list_with_device(
                                &ai_delta.edits,
                                &core_content,
                                &gui_content,
                                &shared_content,
                                &host_runner_content,
                                &generated_device_source,
                            )?;

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
                            write_sidecar_logged(&sidecar_path, &serde_json::Value::Object(meta))
                                .await;
                            eprintln!(
                                "[GPU AI Delta] accepted: user={} generated={} plan={} edits={}",
                                request_device_name,
                                generated_device_path,
                                ai_delta.reload_plan,
                                ai_delta.edits.len()
                            );
                            serde_json::json!({
                                "shared": { "content": final_shared, "filename": shared_filename },
                                "core": { "content": final_core, "filename": core_filename },
                                "gui": { "content": final_gui, "filename": gui_filename },
                                "host_runner": { "content": final_host_runner, "filename": host_runner_filename },
                                "device": { "content": final_device, "filename": generated_device_path },
                                "_synthi_manifest": sidecar_manifest_json.clone(),
                                "_synthi_reload_plan": plan_report,
                            })
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
                                                        write_sidecar_logged(&sidecar_path, &meta)
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
                                                write_sidecar_logged(&sidecar_path, &meta).await;
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
                                                        write_sidecar_logged(&sidecar_path, &meta)
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
                                                write_sidecar_logged(&sidecar_path, &meta).await;
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
                            write_sidecar_logged(&sidecar_path, &meta).await;

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
                    write_sidecar_logged(&sidecar_path, &meta).await;
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
            (
                state.module_hashes.clone(),
                state.loaded_core_path.clone(),
                state.loaded_gui_path.clone(),
            )
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

    let device_source_content: Option<String> = if !req.prefer_gpu_pipeline {
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
            eprintln!(
                "[compile-device] source resolved from split_data file={} bytes={}",
                device_filename,
                src.len()
            );
            Some(src)
        } else {
            match tokio::fs::read_to_string(ctx.workspace_path.join(device_filename)).await {
                Ok(src) if !src.trim().is_empty() => {
                    eprintln!(
                        "[compile-device] source resolved from workspace file={} bytes={}",
                        device_filename,
                        src.len()
                    );
                    Some(src)
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
    if !tier0_bypassed {
        if use_parallel {
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

    let (core_lib_path_opt, gui_lib_path_opt, host_runner_bin_path, device_compile_outcome): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<DeviceCompileOutcome>,
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
        (core_opt, gui_opt, None, None)
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
                )
                .await
            } else {
                Ok(None)
            }
        };
        let device_fut = async {
            if let (Some(source), Some(manifest)) =
                (device_source_content.as_deref(), compile_manifest.as_ref())
            {
                compile_device_phase0(
                    &ctx.workspace_path,
                    &output_dir,
                    timestamp,
                    source,
                    manifest.device_source_filename(),
                    manifest,
                )
                .await
            } else {
                Ok(None)
            }
        };

        let (core_res, gui_res, runner_res, device_res) =
            tokio::join!(core_fut, gui_fut, runner_fut, device_fut);

        // Propagate core error first (it's the most load-bearing —
        // without core we can't even attempt to load the .so chain).
        let core_opt = core_res?;
        let gui_opt = gui_res?;
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
        let device_opt = device_res?;
        (core_opt, gui_opt, runner_opt, device_opt)
    } else {
        // ─── Serial fallback ───────────────────────────────────────
        let core_opt = compile_core(
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
        .await?;

        let gui_opt = compile_gui(
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
        .await?;

        let runner_opt = if let Some(ref content) = host_runner_content {
            match compile_runner(
                ctx,
                content,
                &output_dir,
                timestamp,
                Some(session_id.clone()),
                compile_manifest.as_ref(),
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
        let device_opt = if let (Some(source), Some(manifest)) =
            (device_source_content.as_deref(), compile_manifest.as_ref())
        {
            compile_device_phase0(
                &ctx.workspace_path,
                &output_dir,
                timestamp,
                source,
                manifest.device_source_filename(),
                manifest,
            )
            .await?
        } else {
            None
        };
        (core_opt, gui_opt, runner_opt, device_opt)
    };

    let core_lib_path = core_lib_path_opt
        .ok_or_else(|| anyhow::anyhow!("Core compilation produced no output (no core module in split data or scope is GUI-only)"))?;
    let gui_lib_path = gui_lib_path_opt.unwrap_or(prev_gui_path.unwrap_or_default());

    if let Some(ref p) = host_runner_bin_path {
        eprintln!("[HMR] host_runner binary: {}", p);
    }
    if let Some(ref out) = device_compile_outcome {
        eprintln!(
            "[compile-device] sidecar ready artifact={} stderr_bytes={} register_records={}",
            out.artifact_path.display(),
            out.stderr.len(),
            out.diagnostics.register_pressure.len()
        );
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
    } else if let (Some(device_outcome), Some(manifest)) = (
        device_compile_outcome.as_ref(),
        compile_manifest.as_ref(),
    ) {
        if let Some(gpu) = manifest.gpu.as_ref() {
            let device_source = device_outcome.compiled_source.as_str();
            let gpu_language = gpu.vendor.as_str();
            let device_filename = device_filename_for_vendor(gpu.vendor);
            let mut device_dirty_units = dirty_units.clone();
            if !device_dirty_units.iter().any(|u| u == device_filename) {
                device_dirty_units.push(device_filename.to_string());
            }
            let kernel_symbols = extract_device_kernel_symbols(device_source);
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
            let device_manifest = BuildManifest::for_language(session_id.clone(), gpu_language)
                .with_slot(BuildSlot::Custom("device".into()))
                .with_artifact(&artifact_path, &artifact_hash)
                .with_abi_version(&format!("{}", hash_content(&kernel_abi)))
                .with_state_schema_hash(&format!("{}", hash_content(device_source)))
                .with_build_time(build_time_ms)
                .with_dirty_units(device_dirty_units)
                .with_exported_symbols(kernel_symbols)
                .with_capabilities(vec![
                    "gpu_sidecar_module".to_string(),
                    "synthi_gpu_launch".to_string(),
                ])
                .with_snapshot_modes(vec![SnapshotMode::Binary]);

            let (gpu_reload_result, gpu_notifications) = {
                let mut orchestrator = ctx.hmr_orchestrator.lock().await;
                orchestrator
                    .pipeline(&session_id)
                    .execute_gpu_device_reload(
                        gpu_language,
                        &device_manifest,
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

    if let (Some(device_outcome), Some(manifest)) = (
        device_compile_outcome.as_ref(),
        compile_manifest.as_ref(),
    ) {
        if let Some(gpu) = manifest.gpu.as_ref() {
            let device_source = device_outcome.compiled_source.as_str();
            let kernel_symbols = extract_device_kernel_symbols(device_source);
            let kernel_abi_hash = format!(
                "{}",
                hash_content(&kernel_abi_fingerprint_source(device_source))
            );
            let device_cmd = format!(
                "__gpu_device:{}:{}:{}",
                gpu.vendor.as_str(),
                kernel_symbols.join(","),
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

    let device_sidecar_only_reload = !modules_to_load.is_empty()
        && modules_to_load
            .iter()
            .all(|(name, _)| name.starts_with("__gpu_device:"));

    let runner_reload_policy = if planner_output.decision.is_in_process() {
        RunnerReloadPolicy::default()
    } else {
        RunnerReloadPolicy::require_runner_restart(vec![
            planner_output.reason.decision_code.clone(),
        ])
    };

    let runtime_reload_start = std::time::Instant::now();
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
            } else {
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

    fn symbols(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_string()).collect()
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
            decision.reason_codes,
            decision.verifier_report
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
}
