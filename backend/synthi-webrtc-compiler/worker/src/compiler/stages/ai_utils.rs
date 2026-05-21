use crate::infra::messages::CompileRequest;
use crate::infra::utils::get_wsl_host_ip;
use anyhow::{anyhow, Result};
use reqwest;
use serde_json;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::OnceLock;

// Cache for AI split results to avoid redundant API calls.
// Keyed by exact source hash — the structural cache that used to back
// Level 2 / 2.6 shortcuts was removed with those levels.
#[derive(Clone)]
struct CachedSplit {
    result: serde_json::Value,
    original_source: String,
}

static AI_SPLIT_CACHE: OnceLock<tokio::sync::Mutex<std::collections::HashMap<u64, CachedSplit>>> =
    OnceLock::new();

fn get_ai_split_cache() -> &'static tokio::sync::Mutex<std::collections::HashMap<u64, CachedSplit>>
{
    AI_SPLIT_CACHE.get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
}

pub fn calculate_hash<T: Hash>(t: &T) -> u64 {
    let mut s = DefaultHasher::new();
    t.hash(&mut s);
    s.finish()
}

fn get_ai_backend_url() -> String {
    if let Ok(url) = std::env::var("AI_BACKEND_URL") {
        return url;
    }
    if let Some(host_ip) = get_wsl_host_ip() {
        return format!("http://{}:8000", host_ip);
    }
    "http://localhost:8000".to_string()
}

fn add_ai_auth(request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match std::env::var("AI_BACKEND_AUTH_TOKEN").or_else(|_| std::env::var("AI_ENGINE_AUTH_TOKEN"))
    {
        Ok(token) if !token.trim().is_empty() => request.header("x-synthi-internal-token", token),
        _ => request,
    }
}

/// HTTP timeout for AI backend calls (diff_patch, heal, manifest heal, split).
///
/// Previously hardcoded per call site (60s for diff_patch/heal/manifest_heal,
/// 150s for split). Raised and unified after live Gemini calls were observed
/// taking 63s on diff_patch — the 60s bound was tripping a timeout AFTER the
/// AI had already produced a correct answer, falling through to Tier 3 full
/// re-split and wasting ~60s per save.
///
/// 180s is the worst-case ceiling for any Gemini model we currently call.
/// Operators can override with `SYNTHI_AI_HTTP_TIMEOUT_SECS` if a slower
/// model or degraded service requires more headroom, or set it lower to
/// fail fast in CI.
fn ai_http_timeout() -> std::time::Duration {
    let secs: u64 = std::env::var("SYNTHI_AI_HTTP_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(180);
    std::time::Duration::from_secs(secs)
}

fn summarize_ai_error_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return "<empty response body>".to_string();
    }
    let summary = serde_json::from_str::<serde_json::Value>(trimmed)
        .ok()
        .and_then(|json| {
            let detail = json.get("detail").unwrap_or(&json);
            summarize_ai_error_json(detail)
        })
        .unwrap_or_else(|| trimmed.to_string());
    summary.chars().take(1200).collect()
}

fn push_summary_part(parts: &mut Vec<String>, part: impl Into<String>) {
    let part = part.into();
    if !part.is_empty() && !parts.iter().any(|existing| existing == &part) {
        parts.push(part);
    }
}

fn summarize_ai_error_json(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(_) => {
            let mut parts = Vec::new();
            if let Some(message) = value.get("message").and_then(|v| v.as_str()) {
                push_summary_part(&mut parts, message);
            }
            if let Some(violations) = value
                .get("verification")
                .and_then(|v| v.get("violations"))
                .and_then(|v| v.as_array())
            {
                for violation in violations.iter().take(8) {
                    let rule = violation
                        .get("rule")
                        .and_then(|v| v.as_str())
                        .unwrap_or("verifier_violation");
                    let message = violation
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    push_summary_part(&mut parts, format!("{}: {}", rule, message));
                }
            }
            if let Some(reason_codes) = value
                .get("source_context_report")
                .and_then(|v| v.get("graphicsBackend"))
                .and_then(|v| v.get("reasonCodes"))
                .and_then(|v| v.as_array())
            {
                let codes: Vec<&str> = reason_codes
                    .iter()
                    .filter_map(|v| v.as_str())
                    .take(8)
                    .collect();
                if !codes.is_empty() {
                    push_summary_part(
                        &mut parts,
                        format!("graphicsBackend.reasonCodes={}", codes.join(",")),
                    );
                }
            }
            if parts.is_empty() {
                Some(value.to_string())
            } else {
                Some(parts.join(" | "))
            }
        }
        _ => Some(value.to_string()),
    }
}

async fn post_ai_json(
    client: &reqwest::Client,
    url: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value> {
    let resp = add_ai_auth(client.post(url))
        .json(payload)
        .timeout(ai_http_timeout())
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        return Err(anyhow!(
            "AI endpoint {} failed with HTTP status {}: {}",
            url,
            status,
            summarize_ai_error_body(&body)
        ));
    }
    serde_json::from_str::<serde_json::Value>(&body).map_err(|e| {
        anyhow!(
            "AI endpoint {} returned invalid JSON body: {}",
            url,
            e
        )
    })
}

fn text_has_gpu_markers(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    source.contains("__global__")
        || source.contains("__device__")
        || source.contains("<<<")
        || lower.contains("cuda_runtime")
        || lower.contains("hip_runtime")
        || lower.contains("cudamalloc")
        || lower.contains("hipmalloc")
}

fn request_has_gpu_markers(req: &CompileRequest) -> bool {
    if text_has_gpu_markers(&req.source) {
        return true;
    }
    req.files
        .iter()
        .any(|file| text_has_gpu_markers(&file.content))
}

fn normalized_request_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim()
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string()
}

fn request_file_context(req: &CompileRequest) -> Vec<(String, String)> {
    let mut files: Vec<(String, String)> = Vec::new();
    let primary = normalized_request_path(&req.filename);
    if !primary.is_empty() {
        files.push((primary, req.source.clone()));
    }

    for file in &req.files {
        let name = normalized_request_path(&file.name);
        if name.is_empty() {
            continue;
        }
        if let Some((_, content)) = files.iter_mut().find(|(existing, _)| existing == &name) {
            *content = file.content.clone();
        } else {
            files.push((name, file.content.clone()));
        }
    }

    files
}

fn normalize_gpu_arch_hint(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("auto") {
        None
    } else {
        Some(value.to_string())
    }
}

fn gpu_arch_hint(req: &CompileRequest) -> Option<String> {
    req.gpu_arch
        .as_deref()
        .and_then(normalize_gpu_arch_hint)
        .or_else(|| {
            std::env::var("SYNTHI_GPU_ARCH_HINT")
                .ok()
                .and_then(|s| normalize_gpu_arch_hint(&s))
        })
        .or_else(|| {
            std::env::var("SYNTHI_GPU_ARCH")
                .ok()
                .and_then(|s| normalize_gpu_arch_hint(&s))
        })
}

fn split_content(value: Option<&serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => Some(s.to_string()),
        Some(serde_json::Value::Object(map)) => map
            .get("content")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string()),
        _ => None,
    }
}

fn with_split_cache_report(
    mut result: serde_json::Value,
    cache_key: u64,
    hit: bool,
    reason: &str,
    entries_before_lookup: usize,
) -> serde_json::Value {
    if let Some(obj) = result.as_object_mut() {
        obj.insert(
            "_synthi_cache_report".to_string(),
            serde_json::json!({
                "splitCacheHit": hit,
                "splitCacheReason": reason,
                "splitCacheKey": cache_key.to_string(),
                "splitCacheEntries": entries_before_lookup,
            }),
        );
    }
    result
}

fn manifest_module_file(manifest: &serde_json::Value, role: &str) -> Option<String> {
    manifest
        .get("module_files")
        .and_then(|v| v.get(role))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim_start_matches("./").replace('\\', "/"))
}

fn default_device_filename(manifest: &serde_json::Value) -> &'static str {
    match manifest
        .get("gpu")
        .and_then(|gpu| gpu.get("vendor"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "rocm" | "hip" => "device.hip",
        _ => "device.cu",
    }
}

fn insert_split_role(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    role: &str,
    filename: &str,
    content: String,
) {
    obj.insert(
        role.to_string(),
        serde_json::json!({
            "filename": filename,
            "content": content,
        }),
    );
}

fn normalize_split_response(
    mut split: serde_json::Value,
    manifest: Option<&serde_json::Value>,
) -> serde_json::Value {
    let Some(manifest) = manifest else {
        return split;
    };
    let Some(obj) = split.as_object_mut() else {
        return split;
    };

    for (role, fallback) in [
        ("shared", "shared.h"),
        ("core", "core.cpp"),
        ("gui", "gui.cpp"),
        ("host_runner", "host_runner.cpp"),
    ] {
        let filename = manifest_module_file(manifest, role).unwrap_or_else(|| fallback.to_string());
        let already_role_keyed = obj
            .get(role)
            .and_then(|v| v.get("content"))
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if already_role_keyed {
            continue;
        }
        if let Some(content) =
            split_content(obj.get(&filename)).or_else(|| split_content(obj.get(role)))
        {
            insert_split_role(obj, role, &filename, content);
        }
    }

    let device_filename = manifest_module_file(manifest, "device")
        .unwrap_or_else(|| default_device_filename(manifest).to_string());
    let device_role_keyed = obj
        .get("device")
        .and_then(|v| v.get("content"))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !device_role_keyed {
        if let Some(content) =
            split_content(obj.get(&device_filename)).or_else(|| split_content(obj.get("device")))
        {
            insert_split_role(obj, "device", &device_filename, content);
        }
    }

    split
}

// NOTE: `detect_structural_additions` and `perform_structural_ai_update`
// were removed together with the `Level 2.75` shortcut in `perform_ai_split`.
// They implemented the SDL-hardcoded "X11→SDL2 translation" delta path
// that silently failed on half its string-match injection points. The
// architecture-cache-aware Tier 2 diff_patch pipeline in handler.rs
// (FallbackDeterministic → classify → targeted diff_patch with cached
// architecture hint) now handles the same case language-agnostically.

pub async fn perform_ai_split(req: &CompileRequest) -> Result<serde_json::Value> {
    // Level 1: Full source hash → instant cache hit.
    // No other cache levels — Level 2 (structural match + string patching),
    // Level 2.6 (local deletion), and Level 2.75 (structural addition) all
    // got removed. They were SDL-hardcoded /refactor/delta shortcuts from
    // when perform_ai_split was the only HMR path and full splits took 18s.
    // Now the common HMR path is handler.rs Tier 2 diff_patch with the
    // architecture cache, which handles all edit kinds language-agnostically.
    // perform_ai_split is only called for first-compile splits and Tier 3
    // fallbacks — both of those want correct full splits, not cheap deltas.
    let gpu_mode = req
        .gpu_mode
        .as_deref()
        .unwrap_or("auto")
        .to_ascii_lowercase();
    let split_model = std::env::var("SYNTHI_GEMINI_MODEL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let has_gpu_markers = request_has_gpu_markers(req);
    let file_context = request_file_context(req);
    let arch_hint = gpu_arch_hint(req);
    // Split output depends on more than raw source now: the same file can
    // produce different output depending on the user's project files and GPU
    // target. Include both so large multi-file projects and arch changes do
    // not reuse stale monolithic split output.
    const AI_SPLIT_CACHE_SCHEMA_VERSION: &str = "gpu-strict-lifecycle-v7";
    let source_hash = calculate_hash(&(
        AI_SPLIT_CACHE_SCHEMA_VERSION,
        req.language.as_str(),
        req.filename.as_str(),
        &file_context,
        req.prefer_gpu_pipeline,
        gpu_mode.as_str(),
        arch_hint.as_deref().unwrap_or(""),
        has_gpu_markers,
        split_model.as_deref().unwrap_or(""),
    ));

    eprintln!(
        "[AI Split] ENTER (cache_key={}, src_len={}, files={}, gpu_mode={}, gpu_arch={}, gpu_markers={})",
        source_hash,
        req.source.len(),
        file_context.len(),
        gpu_mode,
        arch_hint.as_deref().unwrap_or("auto"),
        has_gpu_markers
    );

    let cache_entries_before_lookup = {
        let cache = get_ai_split_cache().lock().await;
        if let Some(cached) = cache.get(&source_hash) {
            eprintln!("[AI Split] Level 1 HIT (exact source_hash match)");
            return Ok(with_split_cache_report(
                cached.result.clone(),
                source_hash,
                true,
                "exact_source_hash",
                cache.len(),
            ));
        }
        eprintln!("[AI Split] Level 1 MISS (cache entries: {})", cache.len());
        cache.len()
    };

    // Level 3: Full AI Split
    // The AI engine exposes /refactor/split/verified for verified splitting.
    // It expects a VerifiedAiRequest: { code, lang, mode?, verify?, auto_repair?, ... }
    // and returns { result: "<raw LLM JSON string>", lang, verified, ... }.
    // The LLM JSON inside "result" is: { core: {filename, content}, gui: {...}, shared: {...} }
    eprintln!("[AI Split] Level 3 → full AI split via /refactor/split/verified");
    let client = reqwest::Client::new();
    let gpu_target_prompt = if req.prefer_gpu_pipeline {
        let base = match gpu_mode.as_str() {
            "cuda" => Some("GPU target preference: emit CUDA/NVIDIA-compatible GPU HMR split output when GPU splitting is applicable. Preserve source semantics exactly: every original kernel branch, guard, boundary condition, constant, reset path, and host/device copy must survive unchanged except for mechanical routing through Synthi's GPU runtime ABI."),
            "rocm" | "hip" => Some("GPU target preference: emit ROCm/HIP-compatible GPU HMR split output when GPU splitting is applicable. Preserve source semantics exactly: every original kernel branch, guard, boundary condition, constant, reset path, and host/device copy must survive unchanged except for mechanical routing through Synthi's GPU runtime ABI."),
            _ => Some("GPU target preference: emit GPU HMR split output when GPU splitting is applicable. Preserve source semantics exactly: every original kernel branch, guard, boundary condition, constant, reset path, and host/device copy must survive unchanged except for mechanical routing through Synthi's GPU runtime ABI."),
        };
        base.map(|text| match arch_hint.as_deref() {
            Some(arch) => format!("{text} Target device architecture: {arch}. The compile manifest gpu.arch must use this architecture."),
            None => text.to_string(),
        })
    } else {
        None
    };
    let mut payload = serde_json::json!({
        "code": req.source,
        "lang": req.language,
        "mode": "split",
        "verify": true,
        "auto_repair": true,
        "focus": normalized_request_path(&req.filename),
        "files": file_context
            .iter()
            .map(|(name, content)| serde_json::json!({
                "path": name,
                "name": name,
                "content": content
            }))
            .collect::<Vec<_>>()
    });
    if let Some(arch) = &arch_hint {
        payload["gpu_arch"] = serde_json::Value::String(arch.clone());
    }
    if let Some(prompt) = gpu_target_prompt {
        payload["prompt"] = serde_json::Value::String(prompt.to_string());
        eprintln!(
            "[AI Split] GPU target prompt attached for mode={}",
            gpu_mode
        );
    }
    if let Some(model) = &split_model {
        payload["model"] = serde_json::Value::String(model.clone());
        eprintln!("[AI Split] Split model override attached: {}", model);
    }

    let backend_url = get_ai_backend_url();

    // GPU sources need the 5-file kernel splitter, not the host-only
    // universal splitter. Try it first when the request actually contains
    // CUDA/HIP markers; fall back to the verified host splitter if the GPU
    // endpoint rejects the source or is unavailable.
    let verified_url = format!("{}/refactor/split/verified", backend_url);
    let split_url = format!("{}/refactor/split", backend_url);
    let gpu_split_url = format!("{}/refactor/split/gpu", backend_url);

    let mut raw_response: Option<serde_json::Value> = None;
    if req.prefer_gpu_pipeline && gpu_mode != "disabled" && has_gpu_markers {
        eprintln!(
            "[AI Split] GPU markers detected; calling GPU split endpoint: {}",
            gpu_split_url
        );
        let gpu_result: Result<serde_json::Value, anyhow::Error> = async {
            post_ai_json(&client, &gpu_split_url, &payload).await
        }
        .await;
        match gpu_result {
            Ok(json) if json.get("result").and_then(|r| r.as_str()).is_some() => {
                eprintln!("[AI Split] GPU split endpoint returned a 5-file split");
                raw_response = Some(json);
            }
            Ok(json) => {
                eprintln!(
                    "[AI Split] GPU split returned no result field: {:?}",
                    json.to_string().chars().take(200).collect::<String>()
                );
                return Err(anyhow!(
                    "GPU split endpoint returned no result field for a GPU-preferred compile"
                ));
            }
            Err(e) => {
                eprintln!("[AI Split] GPU split endpoint failed ({})", e);
                return Err(anyhow!(
                    "GPU split endpoint failed for a GPU-preferred compile: {}",
                    e
                ));
            }
        }
    }

    let raw_response = if let Some(json) = raw_response {
        json
    } else {
        // Try verified endpoint first; fall back to unverified if it times out.
        // Both return {"result": "<json>", "lang": "..."} — same parser handles both.
        eprintln!(
            "[AI Split] Calling VERIFIED AI split endpoint: {}",
            verified_url
        );
        let verified_result: Result<serde_json::Value, anyhow::Error> = async {
            post_ai_json(&client, &verified_url, &payload).await
        }
        .await;

        match verified_result {
            Ok(json) if json.get("result").and_then(|r| r.as_str()).is_some() => json,
            Ok(json) => {
                eprintln!(
                    "[AI Split] Verified returned no result field: {:?}, trying unverified",
                    json.to_string().chars().take(200).collect::<String>()
                );
                post_ai_json(&client, &split_url, &payload).await?
            }
            Err(e) => {
                eprintln!(
                    "[AI Split] Verified endpoint failed ({}), trying unverified",
                    e
                );
                post_ai_json(&client, &split_url, &payload).await?
            }
        }
    };

    // Parse the response: extract "result" string and parse the LLM JSON within it.
    // The AI engine wraps the LLM output as { "result": "<json string>", "lang": "cpp" }.
    // The LLM may return explanation text BEFORE a ```json code fence, so we must
    // search for the fence anywhere in the text, not just at the start.
    let res = if let Some(result_str) = raw_response.get("result").and_then(|r| r.as_str()) {
        let cleaned = result_str.trim();

        // Strategy: find the LAST ```json (or ```) fenced block in the text.
        // LLMs often emit explanation prose before the JSON code fence.
        let json_str = if let Some(fence_start) =
            cleaned.rfind("```json").or_else(|| cleaned.rfind("```\n{"))
        {
            // Skip past the opening fence line (```json\n)
            let after_fence = &cleaned[fence_start..];
            let content_start = after_fence.find('\n').map(|p| p + 1).unwrap_or(7);
            let inner = &after_fence[content_start..];
            // Find the closing ``` fence
            if let Some(close) = inner.find("```") {
                inner[..close].trim()
            } else {
                // No closing fence — take everything after the opening
                inner.trim()
            }
        } else if cleaned.starts_with("```") {
            // Entire response is a single fenced block (no lang tag)
            let without_opening = if let Some(pos) = cleaned.find('\n') {
                &cleaned[pos + 1..]
            } else {
                cleaned.trim_start_matches("```")
            };
            without_opening.trim_end_matches("```").trim()
        } else {
            cleaned
        };

        // Within the extracted block, find the outermost JSON object { ... }
        let json_str = if let Some(start) = json_str.find('{') {
            if let Some(end) = json_str.rfind('}') {
                &json_str[start..=end]
            } else {
                json_str
            }
        } else {
            json_str
        };

        match serde_json::from_str::<serde_json::Value>(json_str) {
            Ok(parsed) => {
                eprintln!("[AI Split] Successfully parsed LLM JSON from result wrapper");
                parsed
            }
            Err(e) => {
                eprintln!(
                    "[AI Split] Failed to parse LLM JSON from result: {}. Raw prefix: {}",
                    e,
                    &result_str[..result_str.len().min(300)]
                );
                anyhow::bail!("AI split returned unparseable result: {}", e);
            }
        }
    } else if raw_response.get("core").is_some() {
        // Direct structured response (no wrapper) — use as-is
        eprintln!("[AI Split] Response already in structured format (no wrapper)");
        raw_response.clone()
    } else {
        eprintln!(
            "[AI Split] Unexpected response format: {}",
            &raw_response.to_string()[..raw_response.to_string().len().min(200)]
        );
        anyhow::bail!("AI split returned unexpected response format");
    };

    // Extract the architecture cache from the Python wrapper (alongside
    // the `result` field) and embed it into `res` as `_synthi_architecture`.
    // This is piggybacking on the existing JSON Value so that:
    //   - `perform_ai_split`'s signature does not need to change
    //   - the in-memory split cache automatically retains the architecture
    //   - handler.rs can read it from `split_data["_synthi_architecture"]`
    //     and persist it in the sidecar for later diff_patch calls.
    //
    // The Python response wrapper is `{result: "...", architecture: "...", ...}`.
    // The architecture is a plain markdown string (may be empty if the split
    // model forgot to emit the <synthi_arch_cache> XML block).
    let mut res = normalize_split_response(res, raw_response.get("manifest"));
    res = with_split_cache_report(
        res,
        source_hash,
        false,
        "exact_source_hash_miss",
        cache_entries_before_lookup,
    );
    if let Some(arch) = raw_response.get("architecture").and_then(|v| v.as_str()) {
        if !arch.is_empty() {
            eprintln!(
                "[AI Split] architecture cache captured ({} chars)",
                arch.len()
            );
            if let Some(obj) = res.as_object_mut() {
                obj.insert(
                    "_synthi_architecture".to_string(),
                    serde_json::Value::String(arch.to_string()),
                );
            }
        } else {
            eprintln!("[AI Split] no architecture in response (fallback to generic)");
        }
    }

    // ULTRAPLAN Phase 3: capture the compile manifest the AI synthesised
    // alongside the architecture cache. The Python response wrapper is
    // `{result: "...", architecture: "...", manifest: {...}, ...}` under
    // the universal split prompt. We stash it as `_synthi_manifest` in the
    // split Value so handler.rs can pull it into the sidecar and thread it
    // into compile_core / compile_gui. If the field is absent (old sidecar,
    // backend running pre-Phase-2 code, or parse failure on Python side),
    // downstream uses `CompileManifest::generic_fallback()` without inferring
    // framework link flags.
    if let Some(manifest) = raw_response.get("manifest") {
        if !manifest.is_null() {
            let manifest_size = manifest.to_string().len();
            eprintln!(
                "[AI Split] compile manifest captured ({} bytes)",
                manifest_size
            );
            if let Some(obj) = res.as_object_mut() {
                obj.insert("_synthi_manifest".to_string(), manifest.clone());
            }
        } else {
            eprintln!("[AI Split] manifest field is null (generic fallback downstream)");
        }
    } else {
        eprintln!("[AI Split] no manifest in response (generic fallback downstream)");
    }

    if let Some(agentic_report) = raw_response.get("agentic_report") {
        if !agentic_report.is_null() {
            eprintln!("[AI Split] agentic split report captured");
            if let Some(obj) = res.as_object_mut() {
                obj.insert("_synthi_agentic_report".to_string(), agentic_report.clone());
            }
        }
    }

    if let Some(generated_report) = raw_response.get("generated_artifact_report") {
        if !generated_report.is_null() {
            eprintln!("[AI Split] generated artifact purity report captured");
            if let Some(obj) = res.as_object_mut() {
                obj.insert(
                    "_synthi_generated_artifact_report".to_string(),
                    generated_report.clone(),
                );
            }
        }
    }

    if let Some(mapping_report) = raw_response.get("device_mapping_report") {
        if !mapping_report.is_null() {
            eprintln!("[AI Split] device mapping report captured");
            if let Some(obj) = res.as_object_mut() {
                obj.insert(
                    "_synthi_device_mapping_report".to_string(),
                    mapping_report.clone(),
                );
            }
        }
    }

    if let Some(source_context_report) = raw_response.get("source_context_report") {
        if !source_context_report.is_null() {
            eprintln!("[AI Split] deterministic source context report captured");
            if let Some(obj) = res.as_object_mut() {
                obj.insert(
                    "_synthi_source_context_report".to_string(),
                    source_context_report.clone(),
                );
            }
        }
    }

    if let Some(launch_report) = raw_response.get("launch_indirection_report") {
        if !launch_report.is_null() {
            eprintln!("[AI Split] launch indirection report captured");
            if let Some(obj) = res.as_object_mut() {
                obj.insert(
                    "_synthi_launch_indirection_report".to_string(),
                    launch_report.clone(),
                );
            }
        }
    }

    // ULTRAPLAN Phase 4: log host_runner presence. The parsed `res` Value
    // already carries `host_runner` as a sibling of `core`/`gui`/`shared`
    // (because the universal split prompt outputs all four fields inside
    // the same `<JSON>` block, which Python forwards as `result`). No
    // explicit re-stashing is needed here — handler.rs reads
    // `split_data["host_runner"]["content"]` directly. This block is
    // observability only: confirms the AI honoured the 4-file contract.
    match res
        .get("host_runner")
        .and_then(|v| v.get("content"))
        .and_then(|c| c.as_str())
    {
        Some(content) if !content.trim().is_empty() => {
            eprintln!(
                "[AI Split] host_runner.cpp captured ({} bytes)",
                content.len()
            );
        }
        Some(_) => {
            eprintln!(
                "[AI Split] host_runner field present but empty — universal split prompt likely failed; downstream will skip runner compile"
            );
        }
        None => {
            eprintln!(
                "[AI Split] no host_runner in response — pre-universal-prompt or split-only project; downstream will skip runner compile"
            );
        }
    }

    // Cache result (Level 1 only — the structural cache is gone).
    let cached_entry = CachedSplit {
        result: res.clone(),
        original_source: req.source.clone(),
    };
    get_ai_split_cache()
        .lock()
        .await
        .insert(source_hash, cached_entry);

    Ok(res)
}

/// Call the AI diff-patch endpoint to apply a source diff to split modules.
///
/// Takes a unified diff of the user's source changes + current split file
/// contents + the cached split architecture markdown, sends them to the
/// AI, and returns a **list of structured edits** (not full files) that
/// the caller applies locally via `hmr::edit_applier::apply_edit`.
///
/// The diff-only output format is what makes this call fast: instead of
/// asking the model to regenerate ~3000 tokens of full `gui.cpp` content,
/// we ask for ~100 tokens of edit instructions. Generation time drops
/// from ~30s of autoregressive decoding to ~1s, which is the single
/// biggest latency win we have short of running a local model.
///
/// `architecture` is the cached split-architecture markdown doc captured
/// at initial split time. Passing `Some(arch)` injects it into the prompt
/// as a hint so the model does not re-derive the module contract on every
/// edit. Passing `None` (or `Some("")`) falls back to the generic prompt.
pub async fn perform_ai_diff_patch(
    diff: &str,
    core_content: &str,
    gui_content: &str,
    shared_content: &str,
    host_runner_content: &str,
    architecture: Option<&str>,
) -> Result<Vec<crate::hmr::edit_applier::Edit>> {
    let client = reqwest::Client::new();
    let backend_url = get_ai_backend_url();
    let url = format!("{}/refactor/diff_patch", backend_url);

    eprintln!(
        "[AI DiffPatch] Calling {} with diff ({} bytes), arch={} chars, host_runner={} bytes",
        url,
        diff.len(),
        architecture.map(|s| s.len()).unwrap_or(0),
        host_runner_content.len(),
    );

    let payload = serde_json::json!({
        "diff": diff,
        "core_content": core_content,
        "gui_content": gui_content,
        "shared_content": shared_content,
        // ULTRAPLAN Phase 5: send host_runner.cpp as a 4th edit target
        // alongside core/gui/shared. Empty string is the "no host runner
        // in this project" sentinel — the Python prompt builder skips
        // the host_runner section in that case to keep the prompt small
        // for legacy 3-file projects.
        "host_runner_content": host_runner_content,
        "architecture": architecture.unwrap_or(""),
    });

    let res: serde_json::Value = add_ai_auth(client.post(&url))
        .json(&payload)
        // Unified AI HTTP timeout — see `ai_http_timeout` at the top of
        // this file. The previous hardcoded 60s tripped on a live 63s
        // Gemini response and fell through to Tier 3 full re-split
        // while the correct diff was already in flight.
        .timeout(ai_http_timeout())
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let elapsed = res
        .get("elapsed_seconds")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    // Response shape: {"edits": [...], "elapsed_seconds": f64}
    // Extra fields are ignored by serde (EditList uses #[serde(default)]
    // and only pulls the `edits` array).
    let edit_list: crate::hmr::edit_applier::EditList = serde_json::from_value(res.clone())
        .map_err(|e| {
            anyhow::anyhow!(
                "[AI DiffPatch] failed to parse edit list from response: {} (raw: {})",
                e,
                res.to_string().chars().take(300).collect::<String>()
            )
        })?;

    eprintln!(
        "[AI DiffPatch] Completed in {:.2}s with {} edit(s)",
        elapsed,
        edit_list.edits.len()
    );

    Ok(edit_list.edits)
}

#[derive(Debug, Clone)]
pub struct GpuDiffPatchResult {
    pub reload_plan: String,
    pub edits: Vec<crate::hmr::edit_applier::Edit>,
}

#[derive(Debug, serde::Deserialize)]
struct GpuDiffPatchResponse {
    #[serde(default)]
    reload_plan: Option<String>,
    #[serde(default)]
    edits: Vec<crate::hmr::edit_applier::Edit>,
    #[serde(default)]
    elapsed_seconds: Option<f64>,
}

/// GPU-aware AI delta path. Unlike the generic diff patch endpoint, this sends
/// the current device role and accepts `module="device"` edits, while the Rust
/// side still applies and verifies the patch locally.
pub async fn perform_gpu_ai_diff_patch(
    diff: &str,
    core_content: &str,
    gui_content: &str,
    shared_content: &str,
    host_runner_content: &str,
    device_content: &str,
    architecture: Option<&str>,
    mapping_report: Option<&serde_json::Value>,
    compile_manifest: Option<&serde_json::Value>,
    reload_plan_report: Option<&serde_json::Value>,
    reload_plan_hint: Option<&str>,
) -> Result<GpuDiffPatchResult> {
    let client = reqwest::Client::new();
    let backend_url = get_ai_backend_url();
    let url = format!("{}/refactor/diff_patch/gpu", backend_url);

    eprintln!(
        "[GPU AI Delta] Calling {} with diff={} bytes arch={} chars device={} bytes hint={}",
        url,
        diff.len(),
        architecture.map(|s| s.len()).unwrap_or(0),
        device_content.len(),
        reload_plan_hint.unwrap_or("none"),
    );

    let payload = serde_json::json!({
        "diff": diff,
        "core_content": core_content,
        "gui_content": gui_content,
        "shared_content": shared_content,
        "host_runner_content": host_runner_content,
        "device_content": device_content,
        "architecture": architecture.unwrap_or(""),
        "mapping_report": mapping_report.cloned().unwrap_or(serde_json::Value::Null),
        "compile_manifest": compile_manifest.cloned().unwrap_or(serde_json::Value::Null),
        "reload_plan_report": reload_plan_report.cloned().unwrap_or(serde_json::Value::Null),
        "reload_plan": reload_plan_hint,
    });

    let res: serde_json::Value = add_ai_auth(client.post(&url))
        .json(&payload)
        .timeout(ai_http_timeout())
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let parsed: GpuDiffPatchResponse = serde_json::from_value(res.clone()).map_err(|e| {
        anyhow::anyhow!(
            "[GPU AI Delta] failed to parse GPU diff response: {} (raw: {})",
            e,
            res.to_string().chars().take(300).collect::<String>()
        )
    })?;
    let reload_plan = parsed.reload_plan.unwrap_or_else(|| "mixed".to_string());
    eprintln!(
        "[GPU AI Delta] Completed in {:.2}s plan={} edit(s)={}",
        parsed.elapsed_seconds.unwrap_or(0.0),
        reload_plan,
        parsed.edits.len()
    );

    Ok(GpuDiffPatchResult {
        reload_plan,
        edits: parsed.edits,
    })
}

// NOTE: perform_targeted_delta_patch was removed together with the
// classify step in handler.rs. Rationale: classify took ~4s per edit
// (network + Google API TTFT + Python SDK overhead for a lite call)
// which exceeded the ~1-3s saved by using a targeted single-module
// prompt over the full 3-module prompt. Net was a latency LOSS, plus
// silent edit drops when classify timed out. The architecture cache
// now gives full `perform_ai_diff_patch` all the routing info it needs
// via the "Where User Code Goes" section, so the AI routes internally
// from a single call.

/// Ask the AI to fix a compilation error in a module.
///
/// Sends the broken code + compiler error messages + the cached split
/// architecture doc to `/refactor/heal`. The AI returns the complete
/// fixed file (~1-2s).
///
/// `architecture` is the cached split-architecture markdown doc (may
/// be `None` or `Some("")` for pre-migration sidecars). When provided,
/// the Python endpoint injects it into the heal prompt so that
/// project-specific "don'ts" (e.g. forbidden patterns, runner-owned
/// APIs) come from the arch cache instead of hardcoded SDL-specific
/// rules that only worked for one codebase.
pub async fn perform_ai_heal(
    module_name: &str,
    module_content: &str,
    error_messages: &str,
    shared_content: &str,
    architecture: Option<&str>,
) -> Result<String> {
    let client = reqwest::Client::new();
    let backend_url = get_ai_backend_url();
    let url = format!("{}/refactor/heal", backend_url);

    eprintln!(
        "[AI Heal] {} module, {} bytes code, {} bytes errors, arch={} chars",
        module_name,
        module_content.len(),
        error_messages.len(),
        architecture.map(|s| s.len()).unwrap_or(0)
    );

    let payload = serde_json::json!({
        "module_name": module_name,
        "module_content": module_content,
        "error_messages": error_messages,
        "shared_content": shared_content,
        "architecture": architecture.unwrap_or(""),
    });

    let res = add_ai_auth(client.post(&url))
        .json(&payload)
        // Unified AI HTTP timeout — see `ai_http_timeout` at the top of
        // this file. Heal sends the broken module + g++ errors back to
        // the AI for repair (pro model). Typical 3-6s.
        .timeout(ai_http_timeout())
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let elapsed = res
        .get("elapsed_seconds")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    eprintln!("[AI Heal] {} completed in {:.2}s", module_name, elapsed);

    let content = res
        .get("result")
        .and_then(|r| r.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| anyhow::anyhow!("No content in heal response"))?;

    Ok(content.to_string())
}

// NOTE: perform_ai_classify_edit + the /classify/edit Python endpoint
// were removed. Classify was costing ~4s per edit (network + Google
// API TTFT + Python SDK overhead for a lite call) — more time than
// it saved by letting us use a targeted single-module prompt. The
// architecture cache now handles routing inside the full diff_patch
// prompt via its "Where User Code Goes" section, so the AI routes
// internally from a single call per edit. See handler.rs Tier 2 flow.

// ─────────────────────────────────────────────────────────────────────────────
// ULTRAPLAN Phase 6 — manifest heal via /refactor/heal/manifest
// ─────────────────────────────────────────────────────────────────────────────

/// Result of a manifest-heal AI call.
#[derive(Debug, Clone)]
pub struct ManifestHealResult {
    /// The new manifest JSON to retry the compile with. When `unchanged`
    /// is true this is byte-identical to the input — caller MUST short
    /// circuit and surface the error card instead of retrying.
    pub updated_manifest: serde_json::Value,
    /// True when the AI couldn't infer a fix and returned the input
    /// unchanged. Triggers immediate fall-through to the 3-option
    /// error card (no compile retry).
    pub unchanged: bool,
    /// One-sentence explanation from the AI. Surfaced in logs and in
    /// the error card if the heal eventually fails.
    pub notes: String,
}

/// ULTRAPLAN Phase 6 — attempt a manifest-heal retry for a failing
/// compile stage. This is the runtime safety net that catches
/// `undefined reference` errors the Phase 4.5 pre-flight validator
/// missed.
///
/// Flow:
///   1. Extract undefined symbols from `stderr` (generic regex).
///   2. Read the sidecar for the current manifest + original_source
///      + architecture cache.
///   3. Call `/refactor/heal/manifest` with those inputs.
///   4. If the AI returned an updated manifest, parse it and retry the
///      compile ONCE via `rebuild_cmd(new_manifest)`.
///   5. On success, write the updated manifest back to the sidecar
///      so the NEXT compile uses it.
///
/// Returns `Some((output, new_manifest))` when the manifest-heal
/// retry succeeds. Returns `None` in all these "keep going with source
/// heal" cases:
///   - `stderr` has no undefined-reference errors (pure source error)
///   - sidecar has no compile_manifest (pre-Phase-3 project)
///   - AI heal returned `unchanged: true` (couldn't infer a fix)
///   - the retry compile also failed
///
/// Caller's responsibility: on Some, treat the compile as succeeded
/// and fall through to the post-compile path (cache.put, return Ok).
/// On None, fall through to the existing source-heal loop.
///
/// `rebuild_cmd` closure: given the new manifest, produce the tokio
/// Command that will retry the compile. Must set `current_dir` and
/// specify the output path. The closure is called at most once.
pub async fn try_manifest_heal_retry<F>(
    stderr: &str,
    workspace_dir: &std::path::Path,
    failed_module: &str,
    source_excerpt_fallback: &str,
    rebuild_cmd: F,
) -> Option<(
    std::process::Output,
    crate::hmr::compile_manifest::CompileManifest,
)>
where
    F: FnOnce(&crate::hmr::compile_manifest::CompileManifest) -> tokio::process::Command,
{
    use crate::hmr::compile_manifest::CompileManifest;
    use crate::hmr::undef_symbols::extract_undefined_symbols;

    // 1. Extract undefined symbols
    let symbols = extract_undefined_symbols(stderr);
    if symbols.is_empty() {
        return None; // pure source error, not a link error
    }
    eprintln!(
        "[ManifestHeal/{}] detected {} undefined symbol(s), attempting manifest heal",
        failed_module,
        symbols.len()
    );

    // 2. Read sidecar for current manifest + source + arch
    let sidecar_path = workspace_dir.join(".synthi_split_meta.json");
    let sidecar: serde_json::Value = match tokio::fs::read_to_string(&sidecar_path).await {
        Ok(raw) => match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "[ManifestHeal/{}] sidecar parse failed: {}",
                    failed_module, e
                );
                return None;
            }
        },
        Err(_) => {
            eprintln!(
                "[ManifestHeal/{}] no sidecar at {} — cannot heal",
                failed_module,
                sidecar_path.display()
            );
            return None;
        }
    };
    let current_manifest_json = sidecar
        .get("compile_manifest")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    if current_manifest_json.is_null() {
        eprintln!(
            "[ManifestHeal/{}] sidecar has no compile_manifest field — cannot heal",
            failed_module
        );
        return None;
    }
    let original_source = sidecar
        .get("original_source")
        .and_then(|s| s.as_str())
        .unwrap_or("");
    let source_excerpt = if !original_source.is_empty() {
        original_source
    } else {
        source_excerpt_fallback
    };
    let architecture = sidecar
        .get("architecture")
        .and_then(|s| s.as_str())
        .unwrap_or("");
    let arch_hint: Option<&str> = if architecture.is_empty() {
        None
    } else {
        Some(architecture)
    };

    // 3. Call manifest heal
    let symbol_names: Vec<String> = symbols.iter().map(|s| s.name.clone()).collect();
    let healed = match perform_ai_heal_manifest(
        &current_manifest_json,
        &symbol_names,
        source_excerpt,
        failed_module,
        arch_hint,
    )
    .await
    {
        Ok(h) => h,
        Err(e) => {
            eprintln!(
                "[ManifestHeal/{}] heal endpoint call failed: {}",
                failed_module, e
            );
            return None;
        }
    };
    if healed.unchanged {
        eprintln!(
            "[ManifestHeal/{}] AI returned unchanged — no retry (notes: {})",
            failed_module,
            healed.notes.chars().take(120).collect::<String>()
        );
        return None;
    }

    // 4. Parse new manifest
    let new_manifest = match CompileManifest::from_json_value(&healed.updated_manifest) {
        Some(m) => m,
        None => {
            eprintln!(
                "[ManifestHeal/{}] new manifest JSON is malformed — skipping retry",
                failed_module
            );
            return None;
        }
    };
    eprintln!(
        "[ManifestHeal/{}] heal SUCCEEDED — gui_flags={:?}, runner_flags={:?}",
        failed_module, new_manifest.gui_link_flags, new_manifest.runner_link_flags
    );

    // 5. Write updated manifest back to sidecar BEFORE the retry so
    //    that if the retry itself crashes, the next compile starts
    //    from the improved manifest rather than the old broken one.
    let mut sidecar_updated = sidecar.clone();
    if let Some(obj) = sidecar_updated.as_object_mut() {
        obj.insert(
            "compile_manifest".to_string(),
            healed.updated_manifest.clone(),
        );
    }
    match serde_json::to_string(&sidecar_updated) {
        Ok(body) => {
            let _ = tokio::fs::write(&sidecar_path, body).await;
            eprintln!(
                "[ManifestHeal/{}] sidecar manifest updated at {}",
                failed_module,
                sidecar_path.display()
            );
        }
        Err(e) => {
            eprintln!(
                "[ManifestHeal/{}] sidecar serialize failed: {} (retry will proceed anyway)",
                failed_module, e
            );
        }
    }

    // 6. Rebuild command with new manifest + spawn
    let mut cmd = rebuild_cmd(&new_manifest);
    cmd.kill_on_drop(true);
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[ManifestHeal/{}] spawn failed: {}", failed_module, e);
            return None;
        }
    };
    let out =
        match tokio::time::timeout(std::time::Duration::from_secs(30), child.wait_with_output())
            .await
        {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => {
                eprintln!("[ManifestHeal/{}] retry wait error: {}", failed_module, e);
                return None;
            }
            Err(_) => {
                eprintln!(
                    "[ManifestHeal/{}] retry compile timed out after 30s",
                    failed_module
                );
                return None;
            }
        };

    if out.status.success() {
        eprintln!("[ManifestHeal/{}] retry compile SUCCEEDED", failed_module);
        Some((out, new_manifest))
    } else {
        let retry_stderr = String::from_utf8_lossy(&out.stderr).to_string();
        eprintln!(
            "[ManifestHeal/{}] retry compile FAILED:\n{}",
            failed_module,
            retry_stderr.chars().take(500).collect::<String>()
        );
        None
    }
}

/// Ask the AI to update a manifest's link flags after a link-time
/// `undefined reference` failure. Wrapper around
/// `POST /refactor/heal/manifest` (see ai-engine/main.py for the
/// endpoint and ai-engine/diff_patch_helpers.py for the prompt body).
///
/// `current_manifest` is the JSON shape that came out of the split
/// (or last successful compile) — same wire format as the manifest
/// the worker just tried to use. Pass it through verbatim.
///
/// `undefined_symbols` is the result of
/// `hmr::undef_symbols::extract_undefined_symbols(stderr)`. Empty list
/// is a programming error — the caller should not invoke this path
/// when there's nothing to heal.
///
/// `source_excerpt` is enough of the user's source for the AI to
/// correlate symbols with `#include` directives. Caller should slice
/// down to the includes + the function bodies that reference the
/// missing symbols. ~2KB is plenty.
///
/// `failed_module` is one of "core", "gui", "shared", "host_runner".
/// Tells the AI which manifest field needs the new flag. Server
/// rejects anything else with HTTP 400.
pub async fn perform_ai_heal_manifest(
    current_manifest: &serde_json::Value,
    undefined_symbols: &[String],
    source_excerpt: &str,
    failed_module: &str,
    architecture: Option<&str>,
) -> Result<ManifestHealResult> {
    if undefined_symbols.is_empty() {
        anyhow::bail!("perform_ai_heal_manifest called with empty undefined_symbols — caller bug");
    }

    let client = reqwest::Client::new();
    let backend_url = get_ai_backend_url();
    let url = format!("{}/refactor/heal/manifest", backend_url);

    eprintln!(
        "[ManifestHeal] POST {} ({} symbols, failed_module={}, source_excerpt={} bytes)",
        url,
        undefined_symbols.len(),
        failed_module,
        source_excerpt.len(),
    );

    let payload = serde_json::json!({
        "current_manifest": current_manifest,
        "undefined_symbols": undefined_symbols,
        "source_excerpt": source_excerpt,
        "failed_module": failed_module,
        "architecture": architecture.unwrap_or(""),
    });

    let res: serde_json::Value = add_ai_auth(client.post(&url))
        .json(&payload)
        // Unified AI HTTP timeout — see `ai_http_timeout` at the top of
        // this file. Manifest heal output is tiny (~100-300 tokens of
        // JSON) so this is normally 1-2s; the generous ceiling covers
        // degraded-service tail latencies.
        .timeout(ai_http_timeout())
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;

    let updated_manifest = res
        .get("updated_manifest")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("[ManifestHeal] response missing `updated_manifest`"))?;
    let unchanged = res
        .get("unchanged")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let notes = res
        .get("notes")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let elapsed = res
        .get("elapsed_seconds")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    eprintln!(
        "[ManifestHeal] {} in {:.2}s — notes: {}",
        if unchanged {
            "UNCHANGED (no fix inferred)"
        } else {
            "UPDATED"
        },
        elapsed,
        notes.chars().take(120).collect::<String>(),
    );

    Ok(ManifestHealResult {
        updated_manifest,
        unchanged,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detects_gpu_markers_in_source_text() {
        assert!(text_has_gpu_markers("__global__ void step(float* x) {}"));
        assert!(text_has_gpu_markers("#include <hip/hip_runtime.h>"));
        assert!(text_has_gpu_markers("kernel<<<grid, block>>>(x);"));
        assert!(!text_has_gpu_markers("int main() { return 0; }"));
    }

    #[test]
    fn summarizes_ai_error_body_detail_object() {
        let body = json!({
            "detail": {
                "message": "GPU split AI provider failed before verification",
                "verification": {
                    "ok": false,
                    "violations": [
                        {"rule": "ai_provider_timeout", "message": "TimeoutError"}
                    ]
                }
            }
        })
        .to_string();

        let summary = summarize_ai_error_body(&body);

        assert!(summary.contains("GPU split AI provider failed before verification"));
        assert!(summary.contains("ai_provider_timeout"));
        assert!(summary.contains("TimeoutError"));
    }

    #[test]
    fn summarizes_ai_error_body_keeps_unsupported_reason_codes_first() {
        let body = json!({
            "detail": {
                "message": "GPU split unsupported for this project shape",
                "source_context_report": {
                    "graphicsBackend": {
                        "primary": "vulkan",
                        "reasonCodes": [
                            "unsupported.graphics_backend_vulkan",
                            "unsupported_project_shape"
                        ],
                        "evidence": [
                            {"path": format!("src/noise_{}", "x".repeat(3000))}
                        ]
                    }
                },
                "verification": {
                    "ok": false,
                    "violations": [
                        {
                            "rule": "unsupported.graphics_backend_vulkan",
                            "message": "Vulkan requires explicit fallback."
                        }
                    ]
                }
            }
        })
        .to_string();

        let summary = summarize_ai_error_body(&body);

        assert!(summary.contains("GPU split unsupported for this project shape"));
        assert!(summary.contains("unsupported.graphics_backend_vulkan"));
        assert!(summary.contains("unsupported_project_shape"));
        assert!(summary.len() < 1200);
    }

    #[test]
    fn summarizes_ai_error_body_string_detail() {
        let summary = summarize_ai_error_body(r#"{"detail":"bad split"}"#);

        assert_eq!(summary, "bad split");
    }

    #[test]
    fn normalizes_gpu_filename_map_to_role_entries() {
        let split = json!({
            "include/flow_state.hpp": "#pragma once\n",
            "src/flow_core.cpp": "extern \"C\" void core_on_update(void*, double) {}",
            "ui/flow_gui.cpp": "extern \"C\" void gui_on_render(void*) {}",
            "run/flow_runner.cpp": "int main() { return 0; }",
            "gpu/flow_device.hip": "extern \"C\" __global__ void particle_flow(float* x) {}"
        });
        let manifest = json!({
            "module_files": {
                "shared": "include/flow_state.hpp",
                "core": "src/flow_core.cpp",
                "gui": "ui/flow_gui.cpp",
                "host_runner": "run/flow_runner.cpp",
                "device": "gpu/flow_device.hip"
            },
            "gpu": { "vendor": "rocm" }
        });

        let normalized = normalize_split_response(split, Some(&manifest));

        assert_eq!(
            normalized["core"]["filename"].as_str(),
            Some("src/flow_core.cpp")
        );
        assert_eq!(
            normalized["device"]["filename"].as_str(),
            Some("gpu/flow_device.hip")
        );
        assert!(normalized["device"]["content"]
            .as_str()
            .unwrap()
            .contains("particle_flow"));
    }
}
