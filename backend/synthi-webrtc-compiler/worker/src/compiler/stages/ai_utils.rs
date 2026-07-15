use crate::hmr::gpu_proof::sha256_hex_str;
use crate::infra::messages::CompileRequest;
use crate::infra::utils::get_wsl_host_ip;
use anyhow::{anyhow, Context, Result};
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

fn first_nonempty_env(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        std::env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn gpu_split_provider(req: &CompileRequest) -> String {
    req.ai_provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .or_else(|| first_nonempty_env(&["SYNTHI_SPLIT_PROVIDER", "SYNTHI_GPU_SPLIT_PROVIDER"]))
        .unwrap_or_else(|| "gemini".to_string())
}

fn gpu_split_model_override(req: &CompileRequest) -> Option<String> {
    req.ai_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            first_nonempty_env(&[
                "SYNTHI_SPLIT_MODEL",
                "SYNTHI_GPU_SPLIT_MODEL",
                "SYNTHI_GEMINI_MODEL",
            ])
        })
}

fn gpu_delta_model_override() -> Option<String> {
    first_nonempty_env(&["SYNTHI_GPU_DELTA_MODEL", "SYNTHI_GEMINI_DELTA_MODEL"])
}

fn ai_split_cache_key(req: &CompileRequest) -> u64 {
    let gpu_mode = req
        .gpu_mode
        .as_deref()
        .unwrap_or("auto")
        .to_ascii_lowercase();
    let split_provider = gpu_split_provider(req);
    let split_model = gpu_split_model_override(req);
    let has_gpu_markers = request_has_gpu_markers(req);
    let file_context = request_file_context(req);
    let arch_hint = gpu_arch_hint(req);
    // Cache entries are accepted split artifacts. Keep this tied to the
    // prompt/verifier contract, not just source text, so newly hardened
    // deterministic split verifiers do not reuse stale generated roles.
    const AI_SPLIT_CACHE_SCHEMA_VERSION: &str =
        "gpu-strict-lifecycle-v17-live-update-verified-cache";
    calculate_hash(&(
        AI_SPLIT_CACHE_SCHEMA_VERSION,
        req.language.as_str(),
        req.filename.as_str(),
        &file_context,
        req.prefer_gpu_pipeline,
        gpu_mode.as_str(),
        arch_hint.as_deref().unwrap_or(""),
        has_gpu_markers,
        split_provider.as_str(),
        split_model.as_deref().unwrap_or(""),
    ))
}

pub async fn invalidate_ai_split_cache(req: &CompileRequest, reason: &str) {
    let cache_key = ai_split_cache_key(req);
    let mut cache = get_ai_split_cache().lock().await;
    if cache.remove(&cache_key).is_some() {
        eprintln!(
            "[AI Split] invalidated cache key={} reason={}",
            cache_key, reason
        );
    }
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

/// Single provider-call timeout for AI backend requests.
///
/// Previously hardcoded per call site (60s for diff_patch/heal/manifest_heal,
/// 150s for split). Raised and unified after live Gemini calls were observed
/// taking 63s on diff_patch — the 60s bound was tripping a timeout AFTER the
/// AI had already produced a correct answer, falling through to Tier 3 full
/// re-split and wasting ~60s per save.
///
/// 180s is the default single-call ceiling.
/// Operators can override with `SYNTHI_AI_HTTP_TIMEOUT_SECS` if a slower
/// model or degraded service requires more headroom, or set it lower to
/// fail fast in CI.
const DEFAULT_AI_HTTP_TIMEOUT_SECS: u64 = 180;
const GPU_SPLIT_MAX_PROVIDER_ATTEMPTS: u64 = 3;
const GPU_SPLIT_VERIFIER_OVERHEAD_SECS: u64 = 90;

fn ai_http_timeout() -> std::time::Duration {
    let secs: u64 = std::env::var("SYNTHI_AI_HTTP_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_AI_HTTP_TIMEOUT_SECS);
    std::time::Duration::from_secs(secs)
}

/// Endpoint-level timeout for AI requests sent through the JSON helper.
///
/// `/refactor/split/gpu` can perform multiple provider attempts in one HTTP
/// request because the AI engine retries verifier-rejected splits before
/// returning. Its client-side timeout therefore needs to cover the whole
/// verifier-gated endpoint budget, not just one Gemini call.
fn ai_http_timeout_for_url(url: &str) -> std::time::Duration {
    if url.ends_with("/refactor/split/gpu") {
        let secs = std::env::var("SYNTHI_AI_GPU_SPLIT_HTTP_TIMEOUT_SECS")
            .or_else(|_| std::env::var("SYNTHI_AI_HTTP_TIMEOUT_SECS"))
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(default_gpu_split_http_timeout_secs());
        return std::time::Duration::from_secs(secs);
    }
    ai_http_timeout()
}

fn default_gpu_split_http_timeout_secs() -> u64 {
    DEFAULT_AI_HTTP_TIMEOUT_SECS * GPU_SPLIT_MAX_PROVIDER_ATTEMPTS
        + GPU_SPLIT_VERIFIER_OVERHEAD_SECS
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
    redact_sensitive_ai_text(&summary).chars().take(1200).collect()
}

fn push_summary_part(parts: &mut Vec<String>, part: impl Into<String>) {
    let part = part.into();
    if !part.is_empty() && !parts.iter().any(|existing| existing == &part) {
        parts.push(part);
    }
}

fn redact_until_delimiter(input: &str, marker: &str, replacement: &str) -> String {
    let mut output = String::new();
    let mut search_from = 0;
    let lower = input.to_lowercase();
    let marker_lower = marker.to_lowercase();
    while let Some(relative_start) = lower[search_from..].find(&marker_lower) {
        let start = search_from + relative_start;
        let value_start = start + marker.len();
        let mut end = value_start;
        for (offset, ch) in input[value_start..].char_indices() {
            if ch.is_whitespace() || matches!(ch, '"' | '\'' | ',' | '\\' | '}' | ']' | ')') {
                break;
            }
            end = value_start + offset + ch.len_utf8();
        }
        output.push_str(&input[search_from..start]);
        output.push_str(replacement);
        search_from = end;
    }
    output.push_str(&input[search_from..]);
    output
}

fn redact_google_api_keys(input: &str) -> String {
    let mut output = String::new();
    let mut search_from = 0;
    while let Some(relative_start) = input[search_from..].find("AIza") {
        let start = search_from + relative_start;
        let mut end = start;
        for (offset, ch) in input[start..].char_indices() {
            if offset == 0 || ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                end = start + offset + ch.len_utf8();
                continue;
            }
            break;
        }
        output.push_str(&input[search_from..start]);
        if end - start >= 20 {
            output.push_str("[REDACTED_GOOGLE_API_KEY]");
        } else {
            output.push_str(&input[start..end]);
        }
        search_from = end;
    }
    output.push_str(&input[search_from..]);
    output
}

fn redact_sensitive_ai_text(input: &str) -> String {
    let mut redacted = input.to_string();
    for (marker, replacement) in [
        ("api_key:", "api_key:[REDACTED]"),
        ("api_key=", "api_key=[REDACTED]"),
        ("apikey:", "apikey:[REDACTED]"),
        ("GOOGLE_API_KEY=", "GOOGLE_API_KEY=[REDACTED]"),
        ("GEMINI_API_KEY=", "GEMINI_API_KEY=[REDACTED]"),
        ("OPENAI_API_KEY=", "OPENAI_API_KEY=[REDACTED]"),
        ("ANTHROPIC_API_KEY=", "ANTHROPIC_API_KEY=[REDACTED]"),
        ("Authorization: Bearer ", "Authorization: Bearer [REDACTED]"),
        ("Bearer ", "Bearer [REDACTED]"),
    ] {
        redacted = redact_until_delimiter(&redacted, marker, replacement);
    }
    redact_google_api_keys(&redacted)
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
            if let Some(reason_codes) = value
                .get("source_context_report")
                .and_then(|v| v.get("buildMetadata"))
                .and_then(|v| v.get("targetResolution"))
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
                        format!("targetResolution.reasonCodes={}", codes.join(",")),
                    );
                }
            }
            if let Some(model) = value
                .get("provider_model")
                .or_else(|| value.get("model_provenance"))
            {
                let requested = model
                    .get("requested_model")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unspecified");
                let status = model
                    .get("provider_model_status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let actual = model
                    .get("actual_model")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unresolved");
                let hard_failure = model
                    .get("hard_infra_failure")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                push_summary_part(
                    &mut parts,
                    format!(
                        "model requested={} actual={} provider_status={} hard_infra_failure={}",
                        requested, actual, status, hard_failure
                    ),
                );
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
        .timeout(ai_http_timeout_for_url(url))
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
    serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|e| anyhow!("AI endpoint {} returned invalid JSON body: {}", url, e))
}

fn text_has_gpu_markers(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    source.contains("__global__")
        || source.contains("__device__")
        || source.contains("<<<")
        || source.contains("GLOBAL_KERNEL_SIGNATURE")
        || source.contains("HIPRT_DEVICE")
        || source.contains("HIPRT_HOST_DEVICE")
        || lower.contains("cuda_runtime")
        || lower.contains("hip_runtime")
        || lower.contains("cudamalloc")
        || lower.contains("hipmalloc")
        || lower.contains("oromodulelaunchkernel")
        || lower.contains("hiprtccreateprogram")
        || lower.contains("hiprtccompileprogram")
        || lower.contains("hiprtcgetcode")
        || lower.contains("hiprtcgetbitcode")
        || lower.contains("cumodulelaunchkernel")
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

pub async fn update_ai_split_cache_role(
    req: &CompileRequest,
    role: &str,
    filename: &str,
    content: String,
) -> bool {
    if role.trim().is_empty() || filename.trim().is_empty() || content.trim().is_empty() {
        return false;
    }

    let cache_key = ai_split_cache_key(req);
    let mut cache = get_ai_split_cache().lock().await;
    let Some(cached) = cache.get_mut(&cache_key) else {
        return false;
    };
    let Some(obj) = cached.result.as_object_mut() else {
        return false;
    };

    insert_split_role(obj, role, filename, content.clone());
    if let Some(filename_entry) = obj
        .get_mut(filename)
        .and_then(|value| value.as_object_mut())
    {
        filename_entry.insert(
            "filename".to_string(),
            serde_json::Value::String(filename.to_string()),
        );
        filename_entry.insert("content".to_string(), serde_json::Value::String(content));
    }
    eprintln!(
        "[AI Split] updated cached generated role key={} role={} file={} bytes={}",
        cache_key,
        role,
        filename,
        obj.get(role)
            .and_then(|value| value.get("content"))
            .and_then(serde_json::Value::as_str)
            .map(str::len)
            .unwrap_or(0)
    );
    true
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

    for role in ["shared", "core", "gui", "host_runner"] {
        let Some(filename) = manifest_module_file(manifest, role) else {
            continue;
        };
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

    let Some(device_filename) = manifest_module_file(manifest, "device") else {
        return split;
    };
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

fn split_role_content<'a>(split: &'a serde_json::Value, role: &str) -> &'a str {
    split
        .get(role)
        .and_then(|v| v.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
}

fn split_generated_host_text(split: &serde_json::Value) -> String {
    [
        split_role_content(split, "core"),
        split_role_content(split, "gui"),
        split_role_content(split, "host_runner"),
    ]
    .join("\n")
}

fn strip_cpp_comments(source: &str, strip_literals: bool) -> String {
    #[derive(Clone, Copy)]
    enum State {
        Normal,
        LineComment,
        BlockComment,
        String { escaped: bool },
        Char { escaped: bool },
    }

    let mut result = String::with_capacity(source.len());
    let mut state = State::Normal;
    let mut chars = source.chars().peekable();

    while let Some(ch) = chars.next() {
        match state {
            State::Normal => match ch {
                '/' if chars.peek() == Some(&'/') => {
                    result.push(' ');
                    result.push(' ');
                    chars.next();
                    state = State::LineComment;
                }
                '/' if chars.peek() == Some(&'*') => {
                    result.push(' ');
                    result.push(' ');
                    chars.next();
                    state = State::BlockComment;
                }
                '"' if strip_literals => {
                    result.push('"');
                    state = State::String { escaped: false };
                }
                '\'' if strip_literals => {
                    result.push('\'');
                    state = State::Char { escaped: false };
                }
                _ => result.push(ch),
            },
            State::LineComment => {
                if ch == '\n' {
                    result.push('\n');
                    state = State::Normal;
                } else {
                    result.push(' ');
                }
            }
            State::BlockComment => {
                if ch == '*' && chars.peek() == Some(&'/') {
                    result.push(' ');
                    result.push(' ');
                    chars.next();
                    state = State::Normal;
                } else if ch == '\n' {
                    result.push('\n');
                } else {
                    result.push(' ');
                }
            }
            State::String { escaped } => {
                if ch == '\n' {
                    result.push('\n');
                    state = State::Normal;
                } else if escaped {
                    result.push(' ');
                    state = State::String { escaped: false };
                } else if ch == '\\' {
                    result.push(' ');
                    state = State::String { escaped: true };
                } else if ch == '"' {
                    result.push('"');
                    state = State::Normal;
                } else {
                    result.push(' ');
                }
            }
            State::Char { escaped } => {
                if ch == '\n' {
                    result.push('\n');
                    state = State::Normal;
                } else if escaped {
                    result.push(' ');
                    state = State::Char { escaped: false };
                } else if ch == '\\' {
                    result.push(' ');
                    state = State::Char { escaped: true };
                } else if ch == '\'' {
                    result.push('\'');
                    state = State::Normal;
                } else {
                    result.push(' ');
                }
            }
        }
    }

    result
}

fn request_gpu_source_text(req: &CompileRequest) -> String {
    request_file_context(req)
        .into_iter()
        .map(|(name, content)| format!("\n// file: {name}\n{content}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn push_unique_kernel(kernels: &mut Vec<String>, kernel: &str) {
    let kernel = kernel.trim().trim_start_matches('&');
    if kernel.is_empty() || kernel == "nullptr" || kernel == "NULL" {
        return;
    }
    let kernel = kernel.rsplit("::").next().unwrap_or(kernel);
    if !kernels.iter().any(|existing| existing == kernel) {
        kernels.push(kernel.to_string());
    }
}

fn source_update_kernel_launches(source: &str) -> Vec<String> {
    let source = strip_cpp_comments(source, true);
    let Ok(raw_re) = regex::Regex::new(r"\b([A-Za-z_][A-Za-z0-9_:]*)\s*<<<") else {
        return Vec::new();
    };
    let mut kernels = Vec::new();
    for caps in raw_re.captures_iter(&source) {
        let Some(kernel) = caps.get(1).map(|m| m.as_str()) else {
            continue;
        };
        push_unique_kernel(&mut kernels, kernel);
    }

    let launch_patterns = [
        r"\bhipLaunchKernelGGL\s*\(\s*HIP_KERNEL_NAME\s*\(\s*([A-Za-z_][A-Za-z0-9_:]*)",
        r"\bhipLaunchKernelGGL\s*\(\s*\(?\s*([A-Za-z_][A-Za-z0-9_:]*)",
        r"\bcudaLaunchKernel(?:Ex)?\s*\(\s*(?:\([^)]*\)\s*)?\s*([A-Za-z_][A-Za-z0-9_:]*)",
        r"\bhipLaunchKernel\s*\(\s*(?:\([^)]*\)\s*)?\s*([A-Za-z_][A-Za-z0-9_:]*)",
    ];
    for pattern in launch_patterns {
        let Ok(re) = regex::Regex::new(pattern) else {
            continue;
        };
        for caps in re.captures_iter(&source) {
            let Some(kernel) = caps.get(1).map(|m| m.as_str()) else {
                continue;
            };
            push_unique_kernel(&mut kernels, kernel);
        }
    }

    kernels
}

fn source_has_host_visible_device_readback(source: &str) -> bool {
    let lower = strip_cpp_comments(source, true).to_ascii_lowercase();
    ((lower.contains("hipmemcpy") || lower.contains("cudamemcpy"))
        && lower.contains("devicetohost"))
        || lower.contains("hipmemcpydtoh")
        || lower.contains("cudamemcpydtoh")
        || lower.contains("oromemcpydtoh")
        || lower.contains("oromemcpy_dtoh")
        || lower.contains("oromemcpydevicetohost")
        || lower.contains("memcpydtoh")
}

fn source_has_runtime_launch_api(source: &str) -> bool {
    let lower = strip_cpp_comments(source, true).to_ascii_lowercase();
    lower.contains("hiplaunchkernelggl")
        || lower.contains("hiplaunchkernel")
        || lower.contains("cudalaunchkernel")
        || lower.contains("cumodulelaunchkernel")
        || lower.contains("hipmodulelaunchkernel")
        || lower.contains("oromodulelaunchkernel")
}

fn generated_has_gpu_launch_boundary(generated_host_text: &str) -> bool {
    let generated = strip_cpp_comments(generated_host_text, true).to_ascii_lowercase();
    generated.contains("synthi_gpu_launch")
}

fn generated_launches_kernel(generated_host_text: &str, kernel: &str) -> bool {
    let generated_host_text = strip_cpp_comments(generated_host_text, false);
    let escaped = regex::escape(kernel);
    let boundary_pattern = format!(
        r#"(?s)\bsynthi_gpu_launch(?:_[A-Za-z0-9_]+)?\s*\([^;]*["']{}["']"#,
        escaped
    );
    regex::Regex::new(&boundary_pattern)
        .ok()
        .is_some_and(|re| re.is_match(&generated_host_text))
}

fn generated_preserves_host_visible_readback(generated_host_text: &str) -> bool {
    let lower = strip_cpp_comments(generated_host_text, true).to_ascii_lowercase();
    ((lower.contains("hipmemcpy") || lower.contains("cudamemcpy"))
        && lower.contains("devicetohost"))
        || lower.contains("hipmemcpydtoh")
        || lower.contains("cudamemcpydtoh")
        || lower.contains("oromemcpydtoh")
        || lower.contains("oromemcpy_dtoh")
        || lower.contains("oromemcpydevicetohost")
        || lower.contains("memcpydtoh")
}

fn validate_gpu_split_live_update_contract(
    req: &CompileRequest,
    split: &serde_json::Value,
) -> Result<()> {
    if !req.prefer_gpu_pipeline || !request_has_gpu_markers(req) {
        return Ok(());
    }

    let source_text = request_gpu_source_text(req);
    let update_kernels = source_update_kernel_launches(&source_text);
    let source_has_runtime_launch = source_has_runtime_launch_api(&source_text);
    if update_kernels.is_empty() && !source_has_runtime_launch {
        return Ok(());
    }

    let generated_host_text = split_generated_host_text(split);
    let missing_kernels = update_kernels
        .iter()
        .filter(|kernel| !generated_launches_kernel(&generated_host_text, kernel))
        .cloned()
        .collect::<Vec<_>>();
    let source_requires_readback = source_has_host_visible_device_readback(&source_text);
    let generated_has_readback = generated_preserves_host_visible_readback(&generated_host_text);
    let source_requires_launch_boundary = source_has_runtime_launch && update_kernels.is_empty();
    let generated_has_launch_boundary = generated_has_gpu_launch_boundary(&generated_host_text);

    if missing_kernels.is_empty()
        && (!source_requires_launch_boundary || generated_has_launch_boundary)
        && (!source_requires_readback || generated_has_readback)
    {
        return Ok(());
    }

    let mut reason_codes = Vec::new();
    if !missing_kernels.is_empty() {
        reason_codes.push(format!(
            "gpu_split_live_update_missing_kernel_launch:{}",
            missing_kernels.join(",")
        ));
    }
    if source_requires_launch_boundary && !generated_has_launch_boundary {
        reason_codes.push("gpu_split_live_update_missing_runtime_launch_boundary".to_string());
    }
    if source_requires_readback && !generated_has_readback {
        reason_codes.push("gpu_split_live_update_missing_device_to_host_readback".to_string());
    }

    anyhow::bail!(
        "GPU split verifier rejected non-live generated split: reason_codes={}",
        reason_codes.join(",")
    );
}

// NOTE: `detect_structural_additions` and `perform_structural_ai_update`
// were removed together with the `Level 2.75` shortcut in `perform_ai_split`.
// They implemented the SDL-hardcoded "X11→SDL2 translation" delta path
// that silently failed on half its string-match injection points. The
// architecture-cache-aware Tier 2 diff_patch pipeline in handler.rs
// (FallbackDeterministic → classify → targeted diff_patch with cached
// architecture hint) now handles the same case language-agnostically.

const PROVIDER_CALL_REQUEST_SCHEMA_VERSION: &str = "synthi.ai.provider_call_request.v2";
const PROVIDER_CALL_RECEIPT_SCHEMA_VERSION: &str = "synthi.ai.provider_call_receipt.v1";
const PROVIDER_CALL_CHALLENGE_SCHEMA_VERSION: &str = "synthi.ai.provider_call_challenge.v1";
const PROVIDER_CALL_RECEIPT_AUTHORITY: &str =
    "request_bound_provider_call_only_not_gpu_hmr_success";

fn prefixed_sha256(value: &str) -> String {
    format!("sha256:{}", sha256_hex_str(value))
}

fn ordered_json_hash(values: Vec<serde_json::Value>) -> String {
    let material = serde_json::to_string(&values).expect("provider call hash material");
    prefixed_sha256(&material)
}

fn valid_provider_call_nonce(value: &str) -> bool {
    value.strip_prefix("provider-call:").is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn valid_prefixed_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|suffix| {
        suffix.len() == 64
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn canonical_provider_call_challenge_tag(challenge: &serde_json::Value) -> Result<String> {
    const OPEN: &str = "<synthi_provider_call_challenge>";
    const CLOSE: &str = "</synthi_provider_call_challenge>";
    let object = challenge
        .as_object()
        .context("AI provider response challenge must be an object")?;
    if object.len() != 5 {
        anyhow::bail!("AI provider response challenge has unexpected fields");
    }
    let field = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_str)
            .with_context(|| format!("AI provider response challenge field {key} is invalid"))
    };
    let encoded = format!(
        "{{\"challenge_hash\":{},\"prompt_payload_hash\":{},\"request_hash\":{},\"request_nonce\":{},\"schema_version\":{}}}",
        serde_json::to_string(field("challenge_hash")?)?,
        serde_json::to_string(field("prompt_payload_hash")?)?,
        serde_json::to_string(field("request_hash")?)?,
        serde_json::to_string(field("request_nonce")?)?,
        serde_json::to_string(field("schema_version")?)?,
    );
    Ok(format!("{OPEN}{encoded}{CLOSE}"))
}

fn validate_provider_call_challenge_echo(
    raw_response: &str,
    challenge: &serde_json::Value,
) -> Result<()> {
    const OPEN: &str = "<synthi_provider_call_challenge>";
    const CLOSE: &str = "</synthi_provider_call_challenge>";
    let expected_tag = canonical_provider_call_challenge_tag(challenge)?;
    if raw_response.matches(OPEN).count() != 1
        || raw_response.matches(CLOSE).count() != 1
        || !raw_response.contains(&expected_tag)
    {
        anyhow::bail!("AI provider response did not echo the exact fresh-call challenge");
    }
    Ok(())
}

fn object_has_gpu_authority_claim(object: &serde_json::Map<String, serde_json::Value>) -> bool {
    [
        "accepted_for_gpu_hmr",
        "acceptedForGpuHmr",
        "gpu_hmr_success",
        "gpuHmrSuccess",
        "can_satisfy_runtime_proof",
        "canSatisfyRuntimeProof",
        "can_satisfy_dispatch_proof",
        "canSatisfyDispatchProof",
    ]
    .iter()
    .any(|key| {
        object
            .get(*key)
            .is_some_and(|value| value.as_bool() != Some(false))
    })
}

fn provider_call_request_binding(
    req: &CompileRequest,
    file_context: &[(String, String)],
    requested_model: &str,
    arch_hint: Option<&str>,
    extra_instructions: Option<&str>,
) -> Result<(serde_json::Value, String)> {
    let nonce = req
        .ai_provider_call_nonce
        .as_deref()
        .map(str::trim)
        .filter(|value| valid_provider_call_nonce(value))
        .ok_or_else(|| anyhow!("required AI provider call needs a caller-generated nonce"))?;
    let requested_provider = req
        .ai_provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| anyhow!("required AI provider call needs an explicit provider"))?;
    let caller_requested_model = req
        .ai_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("required AI provider call needs an explicit model"))?;
    if caller_requested_model != requested_model.trim() {
        anyhow::bail!("required AI provider call model does not match caller request");
    }
    let mut file_entries = file_context
        .iter()
        .map(|(name, content)| serde_json::json!([name, prefixed_sha256(content)]))
        .collect::<Vec<_>>();
    file_entries.sort_by(|left, right| {
        left.get(0)
            .and_then(serde_json::Value::as_str)
            .cmp(&right.get(0).and_then(serde_json::Value::as_str))
    });
    let file_manifest_hash = ordered_json_hash(vec![
        serde_json::Value::String("synthi.ai.provider_call_file_manifest.v1".to_string()),
        serde_json::Value::Array(file_entries.clone()),
    ]);
    let binding = serde_json::json!({
        "schema_version": PROVIDER_CALL_REQUEST_SCHEMA_VERSION,
        "nonce": nonce,
        "mode": "split",
        "request_mode": "split",
        "language": req.language.trim(),
        "focus": normalized_request_path(&req.filename),
        "requested_provider": requested_provider,
        "requested_model": requested_model.trim(),
        "gpu_arch": arch_hint.unwrap_or("").trim(),
        "source_hash": prefixed_sha256(&req.source),
        "file_manifest_hash": file_manifest_hash,
        "file_count": file_entries.len(),
        "extra_instructions_hash": prefixed_sha256(extra_instructions.unwrap_or("")),
    });
    let request_hash = ordered_json_hash(vec![
        binding["schema_version"].clone(),
        binding["nonce"].clone(),
        binding["mode"].clone(),
        binding["request_mode"].clone(),
        binding["language"].clone(),
        binding["focus"].clone(),
        binding["requested_provider"].clone(),
        binding["requested_model"].clone(),
        binding["gpu_arch"].clone(),
        binding["source_hash"].clone(),
        binding["file_manifest_hash"].clone(),
        binding["file_count"].clone(),
        binding["extra_instructions_hash"].clone(),
    ]);
    Ok((binding, request_hash))
}

fn validate_required_ai_provider_call(
    raw_response: &serde_json::Value,
    expected_request_binding: &serde_json::Value,
    expected_request_hash: &str,
) -> Result<serde_json::Value> {
    let Some(provenance) = raw_response
        .get("model_provenance")
        .or_else(|| raw_response.get("provider_model"))
        .and_then(serde_json::Value::as_object)
    else {
        anyhow::bail!("AI split provider call was required but model provenance is missing");
    };

    let Some(receipt) = raw_response
        .get("provider_call_receipt")
        .and_then(serde_json::Value::as_object)
    else {
        anyhow::bail!("AI split provider call was required but receipt is missing");
    };

    let provider_call_used = provenance
        .get("provider_call_used")
        .or_else(|| provenance.get("providerCallUsed"))
        .and_then(serde_json::Value::as_bool);
    let provider = provenance
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let requested_model = provenance
        .get("requested_model")
        .or_else(|| provenance.get("requestedModel"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let actual_model = provenance
        .get("actual_model")
        .or_else(|| provenance.get("actualModel"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let provider_status = provenance
        .get("provider_model_status")
        .or_else(|| provenance.get("providerModelStatus"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let fallback_model = provenance
        .get("fallback_model")
        .or_else(|| provenance.get("fallbackModel"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let fallback_used = provenance
        .get("fallback_used")
        .or_else(|| provenance.get("fallbackUsed"))
        .and_then(serde_json::Value::as_bool);
    let alias_resolved_to = provenance
        .get("provider_model_alias_resolved_to")
        .or_else(|| provenance.get("providerModelAliasResolvedTo"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let shutdown_or_deprecation_detected = provenance
        .get("provider_shutdown_or_deprecation_detected")
        .or_else(|| provenance.get("providerShutdownOrDeprecationDetected"))
        .and_then(serde_json::Value::as_bool);
    let hard_infra_failure = provenance
        .get("hard_infra_failure")
        .or_else(|| provenance.get("hardInfraFailure"))
        .and_then(serde_json::Value::as_bool);
    let request_mode = provenance
        .get("request_mode")
        .or_else(|| provenance.get("requestMode"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let checked_at = provenance
        .get("model_availability_checked_at")
        .or_else(|| provenance.get("modelAvailabilityCheckedAt"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();

    let mut reason_codes = Vec::new();
    if provider_call_used != Some(true) {
        reason_codes.push("ai_split_provider_call_not_observed");
    }
    if provider.is_empty() {
        reason_codes.push("ai_split_provider_identity_missing");
    } else if provider.eq_ignore_ascii_case("deterministic_static_splitter") {
        reason_codes.push("ai_split_deterministic_splitter_not_provider_call");
    }
    if requested_model.is_empty() {
        reason_codes.push("ai_split_requested_model_missing");
    }
    if actual_model.is_empty() {
        reason_codes.push("ai_split_actual_model_missing");
    }
    if !matches!(
        provider_status,
        "available" | "deprecated" | "unknown" | "private_alias"
    ) {
        reason_codes.push("ai_split_provider_model_status_invalid");
    }
    if fallback_used.is_none() {
        reason_codes.push("ai_split_provider_fallback_state_missing");
    }
    if shutdown_or_deprecation_detected.is_none() {
        reason_codes.push("ai_split_provider_lifecycle_state_missing");
    }
    if hard_infra_failure != Some(false) {
        reason_codes.push("ai_split_provider_hard_infra_failure");
    }
    if request_mode != "split" {
        reason_codes.push("ai_split_provider_request_mode_invalid");
    }
    if checked_at.is_empty() {
        reason_codes.push("ai_split_provider_availability_timestamp_missing");
    }

    let receipt_string = |key: &str| {
        receipt
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
    };
    let receipt_schema = receipt_string("schema_version");
    let receipt_authority = receipt_string("proof_authority");
    let receipt_nonce = receipt_string("request_nonce");
    let receipt_request_hash = receipt_string("request_hash");
    let receipt_response_hash = receipt_string("response_hash");
    let receipt_challenge_hash = receipt_string("challenge_hash");
    let receipt_provider = receipt_string("provider");
    let receipt_requested_model = receipt_string("requested_model");
    let receipt_actual_model = receipt_string("actual_model");
    let receipt_request_mode = receipt_string("request_mode");
    let receipt_provider_status = receipt_string("provider_model_status");
    let receipt_fallback_model = receipt_string("fallback_model");
    let receipt_fallback_used = receipt
        .get("fallback_used")
        .and_then(serde_json::Value::as_bool);
    let receipt_alias_resolved_to = receipt_string("provider_model_alias_resolved_to");
    let receipt_shutdown_or_deprecation_detected = receipt
        .get("provider_shutdown_or_deprecation_detected")
        .and_then(serde_json::Value::as_bool);
    let receipt_checked_at = receipt_string("model_availability_checked_at");
    let started_monotonic = receipt_string("started_monotonic_ns");
    let completed_monotonic = receipt_string("completed_monotonic_ns");
    let started_unix = receipt_string("started_unix_ns");
    let completed_unix = receipt_string("completed_unix_ns");
    let receipt_hash = receipt_string("receipt_hash");
    let call_id = receipt_string("call_id");
    let expected_nonce = expected_request_binding
        .get("nonce")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let expected_requested_provider = expected_request_binding
        .get("requested_provider")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let expected_requested_model = expected_request_binding
        .get("requested_model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let provider_raw_response = raw_response
        .get("provider_call_raw_response")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let response_hash = if provider_raw_response.is_empty() {
        String::new()
    } else {
        prefixed_sha256(provider_raw_response)
    };
    let challenge = receipt.get("challenge");
    let challenge_schema = challenge
        .and_then(|value| value.get("schema_version"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let challenge_nonce = challenge
        .and_then(|value| value.get("request_nonce"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let challenge_request_hash = challenge
        .and_then(|value| value.get("request_hash"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let challenge_prompt_hash = challenge
        .and_then(|value| value.get("prompt_payload_hash"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let challenge_embedded_hash = challenge
        .and_then(|value| value.get("challenge_hash"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let expected_challenge_hash = ordered_json_hash(vec![
        serde_json::Value::String(PROVIDER_CALL_CHALLENGE_SCHEMA_VERSION.to_string()),
        serde_json::Value::String(challenge_nonce.to_string()),
        serde_json::Value::String(challenge_request_hash.to_string()),
        serde_json::Value::String(challenge_prompt_hash.to_string()),
    ]);
    let challenge_echo_verified = challenge.is_some_and(|value| {
        validate_provider_call_challenge_echo(provider_raw_response, value).is_ok()
    });
    let intervals_valid = started_monotonic
        .parse::<u128>()
        .ok()
        .zip(completed_monotonic.parse::<u128>().ok())
        .is_some_and(|(started, completed)| completed > started)
        && started_unix
            .parse::<u128>()
            .ok()
            .zip(completed_unix.parse::<u128>().ok())
            .is_some_and(|(started, completed)| completed >= started);
    let expected_receipt_hash = ordered_json_hash(vec![
        serde_json::Value::String(PROVIDER_CALL_RECEIPT_SCHEMA_VERSION.to_string()),
        serde_json::Value::String(PROVIDER_CALL_RECEIPT_AUTHORITY.to_string()),
        serde_json::Value::String(receipt_nonce.to_string()),
        serde_json::Value::String(receipt_request_hash.to_string()),
        serde_json::Value::String(receipt_response_hash.to_string()),
        serde_json::Value::String(receipt_challenge_hash.to_string()),
        serde_json::Value::String(receipt_provider.to_string()),
        serde_json::Value::String(receipt_requested_model.to_string()),
        serde_json::Value::String(receipt_actual_model.to_string()),
        serde_json::Value::String(receipt_request_mode.to_string()),
        serde_json::Value::String(receipt_provider_status.to_string()),
        serde_json::Value::String(receipt_fallback_model.to_string()),
        serde_json::Value::Bool(receipt_fallback_used.unwrap_or(false)),
        serde_json::Value::String(receipt_alias_resolved_to.to_string()),
        serde_json::Value::Bool(receipt_shutdown_or_deprecation_detected.unwrap_or(false)),
        serde_json::Value::String(receipt_checked_at.to_string()),
        serde_json::Value::String(started_monotonic.to_string()),
        serde_json::Value::String(completed_monotonic.to_string()),
        serde_json::Value::String(started_unix.to_string()),
        serde_json::Value::String(completed_unix.to_string()),
    ]);
    if receipt_schema != PROVIDER_CALL_RECEIPT_SCHEMA_VERSION {
        reason_codes.push("ai_split_provider_receipt_schema_invalid");
    }
    if receipt_authority != PROVIDER_CALL_RECEIPT_AUTHORITY {
        reason_codes.push("ai_split_provider_receipt_authority_invalid");
    }
    if receipt.get("accepted").and_then(serde_json::Value::as_bool) != Some(true)
        || receipt
            .get("provider_call_used")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
    {
        reason_codes.push("ai_split_provider_receipt_not_accepted");
    }
    if receipt.get("request_binding") != Some(expected_request_binding) {
        reason_codes.push("ai_split_provider_receipt_request_binding_mismatch");
    }
    if receipt_nonce != expected_nonce || receipt_request_hash != expected_request_hash {
        reason_codes.push("ai_split_provider_receipt_request_identity_mismatch");
    }
    if !provider.eq_ignore_ascii_case(expected_requested_provider)
        || !receipt_provider.eq_ignore_ascii_case(expected_requested_provider)
    {
        reason_codes.push("ai_split_provider_receipt_requested_provider_mismatch");
    }
    if requested_model != expected_requested_model
        || receipt_requested_model != expected_requested_model
    {
        reason_codes.push("ai_split_provider_receipt_requested_model_mismatch");
    }
    if receipt_response_hash != response_hash || response_hash.is_empty() {
        reason_codes.push("ai_split_provider_receipt_response_hash_mismatch");
    }
    if challenge_schema != PROVIDER_CALL_CHALLENGE_SCHEMA_VERSION
        || challenge_nonce != expected_nonce
        || challenge_request_hash != expected_request_hash
        || !valid_prefixed_sha256(challenge_prompt_hash)
        || receipt_challenge_hash != expected_challenge_hash
        || challenge_embedded_hash != expected_challenge_hash
    {
        reason_codes.push("ai_split_provider_receipt_challenge_binding_mismatch");
    }
    if !challenge_echo_verified
        || receipt
            .get("challenge_echo_verified")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
    {
        reason_codes.push("ai_split_provider_receipt_challenge_echo_mismatch");
    }
    if receipt_provider != provider
        || receipt_requested_model != requested_model
        || receipt_actual_model != actual_model
        || receipt_request_mode != request_mode
        || receipt_provider_status != provider_status
        || receipt_fallback_model != fallback_model
        || receipt_fallback_used != fallback_used
        || receipt_alias_resolved_to != alias_resolved_to
        || receipt_shutdown_or_deprecation_detected != shutdown_or_deprecation_detected
        || receipt_checked_at != checked_at
    {
        reason_codes.push("ai_split_provider_receipt_provenance_mismatch");
    }
    if receipt
        .get("hard_infra_failure")
        .and_then(serde_json::Value::as_bool)
        != Some(false)
    {
        reason_codes.push("ai_split_provider_receipt_hard_infra_failure");
    }
    if !intervals_valid {
        reason_codes.push("ai_split_provider_receipt_interval_invalid");
    }
    if receipt_hash != expected_receipt_hash
        || call_id != format!("provider-call:{}", expected_receipt_hash)
    {
        reason_codes.push("ai_split_provider_receipt_hash_mismatch");
    }
    if object_has_gpu_authority_claim(receipt)
        || object_has_gpu_authority_claim(provenance)
        || receipt
            .get("accepted_for_gpu_hmr")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
        || receipt
            .get("gpu_hmr_success")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
        || receipt
            .get("can_satisfy_runtime_proof")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
        || receipt
            .get("can_satisfy_dispatch_proof")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
    {
        reason_codes.push("ai_split_provider_receipt_claims_gpu_authority");
    }

    if !reason_codes.is_empty() {
        anyhow::bail!(
            "AI split provider call was required but provenance failed: reason_codes={}",
            reason_codes.join(",")
        );
    }
    Ok(serde_json::Value::Object(receipt.clone()))
}

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
    let split_provider = gpu_split_provider(req);
    let split_model = gpu_split_model_override(req);
    let has_gpu_markers = request_has_gpu_markers(req);
    let file_context = request_file_context(req);
    let arch_hint = gpu_arch_hint(req);
    let source_hash = ai_split_cache_key(req);

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
        if req.bypass_ai_split_cache || req.require_ai_provider_call {
            eprintln!(
                "[AI Split] Level 1 BYPASS requested (cache entries: {}, provider_call_required={})",
                cache.len(),
                req.require_ai_provider_call
            );
        } else if let Some(cached) = cache.get(&source_hash) {
            eprintln!("[AI Split] Level 1 HIT (exact source_hash match)");
            return Ok(with_split_cache_report(
                cached.result.clone(),
                source_hash,
                true,
                "exact_source_hash",
                cache.len(),
            ));
        } else {
            eprintln!("[AI Split] Level 1 MISS (cache entries: {})", cache.len());
        }
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
        let live_update_contract = " The generated split must preserve the real runtime update loop: every source update-path GPU kernel launch must be represented by a synthi_gpu_launch boundary in the generated host/core path, and every source host-visible device-to-host/readback copy must remain on the generated render/update path. Do not stub, fake, preview, synthesize, or replace GPU output with host-side approximations. If this cannot be preserved, report the split as unsupported instead of returning compiling-but-nonlive code.";
        let base = match gpu_mode.as_str() {
            "cuda" => Some(format!("GPU target preference: emit CUDA/NVIDIA-compatible GPU HMR split output when GPU splitting is applicable. Preserve source semantics exactly: every original kernel branch, guard, boundary condition, constant, reset path, and host/device copy must survive unchanged except for mechanical routing through Synthi's GPU runtime ABI.{live_update_contract}")),
            "rocm" | "hip" => Some(format!("GPU target preference: emit ROCm/HIP-compatible GPU HMR split output when GPU splitting is applicable. Preserve source semantics exactly: every original kernel branch, guard, boundary condition, constant, reset path, and host/device copy must survive unchanged except for mechanical routing through Synthi's GPU runtime ABI.{live_update_contract}")),
            _ => Some(format!("GPU target preference: emit GPU HMR split output when GPU splitting is applicable. Preserve source semantics exactly: every original kernel branch, guard, boundary condition, constant, reset path, and host/device copy must survive unchanged except for mechanical routing through Synthi's GPU runtime ABI.{live_update_contract}")),
        };
        base.map(|text| match arch_hint.as_deref() {
            Some(arch) => format!("{text} Target device architecture: {arch}. The compile manifest gpu.arch must use this architecture."),
            None => text,
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
    payload["provider"] = serde_json::Value::String(split_provider.clone());
    payload["require_provider_call"] = serde_json::Value::Bool(req.require_ai_provider_call);
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
    } else if req.require_ai_provider_call {
        anyhow::bail!(
            "required AI provider call needs an explicit model for provider {}",
            split_provider
        );
    }

    let provider_call_expectation = if req.require_ai_provider_call {
        let requested_model = payload
            .get("model")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let extra_instructions = payload.get("prompt").and_then(serde_json::Value::as_str);
        let (binding, request_hash) = provider_call_request_binding(
            req,
            &file_context,
            requested_model,
            arch_hint.as_deref(),
            extra_instructions,
        )?;
        payload["provider_call_request"] = binding.clone();
        payload["provider_call_request_hash"] = serde_json::Value::String(request_hash.clone());
        Some((binding, request_hash))
    } else {
        None
    };

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
        let gpu_result: Result<serde_json::Value, anyhow::Error> =
            async { post_ai_json(&client, &gpu_split_url, &payload).await }.await;
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
        let verified_result: Result<serde_json::Value, anyhow::Error> =
            async { post_ai_json(&client, &verified_url, &payload).await }.await;

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
        if req.bypass_ai_split_cache {
            "bypass_requested"
        } else {
            "exact_source_hash_miss"
        },
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

    if let Some(model_provenance) = raw_response
        .get("model_provenance")
        .or_else(|| raw_response.get("provider_model"))
    {
        if !model_provenance.is_null() {
            eprintln!("[AI Split] model provenance captured");
            if let Some(obj) = res.as_object_mut() {
                obj.insert(
                    "_synthi_model_provenance".to_string(),
                    model_provenance.clone(),
                );
            }
        }
    }

    if let Some((expected_binding, expected_hash)) = provider_call_expectation.as_ref() {
        let receipt =
            validate_required_ai_provider_call(&raw_response, expected_binding, expected_hash)?;
        if let Some(obj) = res.as_object_mut() {
            obj.insert("_synthi_provider_call_receipt".to_string(), receipt);
        }
    }

    validate_gpu_split_live_update_contract(req, &res)?;

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

    // Cache ordinary results only. Request-bound receipts are single-use and
    // must never be replayed through the split cache.
    if !req.require_ai_provider_call {
        let cached_entry = CachedSplit {
            result: res.clone(),
            original_source: req.source.clone(),
        };
        get_ai_split_cache()
            .lock()
            .await
            .insert(source_hash, cached_entry);
    } else {
        eprintln!("[AI Split] provider-receipt result intentionally not cached");
    }

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
    pub fission_candidate: Option<serde_json::Value>,
    pub model_provenance: Option<serde_json::Value>,
}

#[derive(Debug, serde::Deserialize)]
struct GpuDiffPatchResponse {
    #[serde(default)]
    reload_plan: Option<String>,
    #[serde(default)]
    edits: Vec<crate::hmr::edit_applier::Edit>,
    #[serde(rename = "fissionCandidate", default)]
    fission_candidate: Option<serde_json::Value>,
    #[serde(default)]
    elapsed_seconds: Option<f64>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    requested_model: Option<String>,
    #[serde(default)]
    actual_model: Option<String>,
    #[serde(default)]
    model_fallback_used: Option<bool>,
    #[serde(default)]
    model_role: Option<String>,
    #[serde(default)]
    provider_model: Option<serde_json::Value>,
    #[serde(default)]
    model_provenance: Option<serde_json::Value>,
}

fn gpu_diff_patch_model_provenance(
    parsed: &GpuDiffPatchResponse,
) -> Option<serde_json::Value> {
    parsed
        .model_provenance
        .clone()
        .or_else(|| parsed.provider_model.clone())
}

fn model_provenance_hard_infra_failure(model_provenance: Option<&serde_json::Value>) -> bool {
    let Some(model) = model_provenance else {
        return false;
    };
    model
        .get("hard_infra_failure")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || model
            .get("provider_model_status")
            .and_then(|v| v.as_str())
            .map(|status| status.eq_ignore_ascii_case("shutdown"))
            .unwrap_or(false)
}

fn summarize_model_provenance(model_provenance: &serde_json::Value) -> String {
    let requested = model_provenance
        .get("requested_model")
        .and_then(|v| v.as_str())
        .unwrap_or("unspecified");
    let actual = model_provenance
        .get("actual_model")
        .and_then(|v| v.as_str())
        .unwrap_or("unresolved");
    let status = model_provenance
        .get("provider_model_status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let checked_at = model_provenance
        .get("model_availability_checked_at")
        .and_then(|v| v.as_str())
        .unwrap_or("unchecked");
    let alias = model_provenance
        .get("provider_model_alias_resolved_to")
        .and_then(|v| v.as_str())
        .unwrap_or("none");
    let hard_failure = model_provenance
        .get("hard_infra_failure")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    format!(
        "requested={} actual={} provider_status={} alias={} checked_at={} hard_infra_failure={}",
        requested, actual, status, alias, checked_at, hard_failure
    )
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

    let delta_model = gpu_delta_model_override();
    eprintln!(
        "[GPU AI Delta] Calling {} with diff={} bytes arch={} chars device={} bytes hint={} model={}",
        url,
        diff.len(),
        architecture.map(|s| s.len()).unwrap_or(0),
        device_content.len(),
        reload_plan_hint.unwrap_or("none"),
        delta_model.as_deref().unwrap_or("ai-engine-default"),
    );

    let mut payload = serde_json::json!({
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
    if let Some(model) = &delta_model {
        payload["model"] = serde_json::Value::String(model.clone());
    }

    let res = post_ai_json(&client, &url, &payload).await?;

    let parsed: GpuDiffPatchResponse = serde_json::from_value(res.clone()).map_err(|e| {
        anyhow::anyhow!(
            "[GPU AI Delta] failed to parse GPU diff response: {} (raw: {})",
            e,
            res.to_string().chars().take(300).collect::<String>()
        )
    })?;
    let model_provenance = gpu_diff_patch_model_provenance(&parsed);
    if model_provenance_hard_infra_failure(model_provenance.as_ref()) {
        let summary = model_provenance
            .as_ref()
            .map(summarize_model_provenance)
            .unwrap_or_else(|| "missing model provenance".to_string());
        anyhow::bail!(
            "[GPU AI Delta] provider model infrastructure failure: {}",
            summary
        );
    }
    let reload_plan = parsed.reload_plan.unwrap_or_else(|| "mixed".to_string());
    eprintln!(
        "[GPU AI Delta] Completed in {:.2}s plan={} edit(s)={} model={} actual_model={} fallback_used={} role={} provider_status={} model_checked_at={}",
        parsed.elapsed_seconds.unwrap_or(0.0),
        reload_plan,
        parsed.edits.len(),
        parsed
            .requested_model
            .as_deref()
            .or(parsed.model.as_deref())
            .unwrap_or("unspecified"),
        parsed.actual_model.as_deref().unwrap_or("unspecified"),
        parsed.model_fallback_used.unwrap_or(false),
        parsed.model_role.as_deref().unwrap_or("gpu_delta"),
        model_provenance
            .as_ref()
            .and_then(|v| v.get("provider_model_status"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown"),
        model_provenance
            .as_ref()
            .and_then(|v| v.get("model_availability_checked_at"))
            .and_then(|v| v.as_str())
            .unwrap_or("unchecked"),
    );

    Ok(GpuDiffPatchResult {
        reload_plan,
        edits: parsed.edits,
        fission_candidate: parsed.fission_candidate,
        model_provenance,
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
    use crate::infra::messages::FileEntry;
    use serde_json::json;

    #[test]
    fn gpu_split_timeout_covers_provider_retry_budget() {
        assert_eq!(
            default_gpu_split_http_timeout_secs(),
            DEFAULT_AI_HTTP_TIMEOUT_SECS * GPU_SPLIT_MAX_PROVIDER_ATTEMPTS
                + GPU_SPLIT_VERIFIER_OVERHEAD_SECS
        );
        assert!(default_gpu_split_http_timeout_secs() > DEFAULT_AI_HTTP_TIMEOUT_SECS);
    }

    #[test]
    fn detects_gpu_markers_in_source_text() {
        assert!(text_has_gpu_markers("__global__ void step(float* x) {}"));
        assert!(text_has_gpu_markers("#include <hip/hip_runtime.h>"));
        assert!(text_has_gpu_markers("kernel<<<grid, block>>>(x);"));
        assert!(text_has_gpu_markers(
            "GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) CameraRays(HIPRTRenderData data) {}"
        ));
        assert!(text_has_gpu_markers(
            "HIPRT_DEVICE bool filterFunc(float x) { return x > 0.0f; }"
        ));
        assert!(text_has_gpu_markers(
            "oroModuleLaunchKernel(fn, 1, 1, 1, 64, 1, 1, 0, stream, args, 0);"
        ));
        assert!(!text_has_gpu_markers("int main() { return 0; }"));
    }

    #[test]
    fn gpu_diff_patch_response_preserves_fission_candidate_proposal() {
        let parsed: GpuDiffPatchResponse = serde_json::from_value(json!({
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "islandId": "island:proposal",
                "targetSymbols": ["step"],
                "proposalSource": "ai_delta"
            }
        }))
        .unwrap();

        let candidate = parsed.fission_candidate.expect("fission candidate");
        assert_eq!(candidate["islandId"], "island:proposal");
        assert_eq!(candidate["targetSymbols"], json!(["step"]));
        assert_eq!(candidate["proposalSource"], "ai_delta");
    }

    #[test]
    fn gpu_diff_patch_response_detects_shutdown_model_provenance() {
        let parsed: GpuDiffPatchResponse = serde_json::from_value(json!({
            "reload_plan": "device_only",
            "edits": [],
            "provider_model": {
                "requested_model": "gemini-3.1-flash-lite-preview",
                "actual_model": null,
                "provider_model_status": "shutdown",
                "provider_model_alias_resolved_to": null,
                "provider_shutdown_or_deprecation_detected": true,
                "model_availability_checked_at": "2026-06-07T00:00:00Z",
                "hard_infra_failure": true
            }
        }))
        .unwrap();
        let provenance = gpu_diff_patch_model_provenance(&parsed);
        assert!(model_provenance_hard_infra_failure(provenance.as_ref()));
    }

    #[test]
    fn ai_error_summary_includes_model_provenance() {
        let body = json!({
            "detail": {
                "message": "GPU delta provider failed",
                "provider_model": {
                    "requested_model": "gemini-3.1-flash-lite-preview",
                    "actual_model": null,
                    "provider_model_status": "shutdown",
                    "hard_infra_failure": true
                }
            }
        })
        .to_string();

        let summary = summarize_ai_error_body(&body);

        assert!(summary.contains("GPU delta provider failed"));
        assert!(summary.contains("provider_status=shutdown"));
        assert!(summary.contains("hard_infra_failure=true"));
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
    fn summarizes_ai_provider_auth_failure_without_secrets() {
        let raw_key = "AIzaSyProviderSuspendedFixtureKey000000000";
        let body = json!({
            "detail": {
                "message": "GPU split AI provider failed before verification",
                "provider_preflight": {
                    "ok": false,
                    "reasonCode": "ai_provider_account_suspended",
                    "message": format!(
                        "PermissionDenied: Consumer api_key:{} has been suspended. Authorization: Bearer eyJhbGciOiJIUzI1Ni.payload.signature",
                        raw_key
                    ),
                    "accepted_for_gpu_hmr": false,
                    "gpu_hmr_success": false
                },
                "verification": {
                    "ok": false,
                    "violations": [
                        {
                            "rule": "ai_provider_account_suspended",
                            "message": format!(
                                "PermissionDenied: Consumer api_key:{} has been suspended. reason=CONSUMER_SUSPENDED Authorization: Bearer eyJhbGciOiJIUzI1Ni.payload.signature",
                                raw_key
                            )
                        }
                    ]
                }
            }
        })
        .to_string();

        let summary = summarize_ai_error_body(&body);

        assert!(summary.contains("GPU split AI provider failed before verification"));
        assert!(summary.contains("ai_provider_account_suspended"));
        assert!(summary.contains("CONSUMER_SUSPENDED"));
        assert!(summary.contains("api_key:[REDACTED]"));
        assert!(summary.contains("Bearer [REDACTED]"));
        assert!(!summary.contains(raw_key));
        assert!(!summary.contains("payload.signature"));
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
    fn summarizes_ai_error_body_keeps_target_resolution_reason_codes() {
        let body = json!({
            "detail": {
                "message": "GPU split unsupported for this project shape",
                "source_context_report": {
                    "buildMetadata": {
                        "targetResolution": {
                            "status": "ambiguous",
                            "reasonCodes": ["target_resolution_ambiguous"]
                        }
                    }
                },
                "verification": {
                    "ok": false,
                    "violations": [
                        {
                            "rule": "target_resolution_ambiguous",
                            "message": "Multiple executable targets contain the requested file."
                        }
                    ]
                }
            }
        })
        .to_string();

        let summary = summarize_ai_error_body(&body);

        assert!(summary.contains("target_resolution_ambiguous"));
        assert!(summary.contains("targetResolution.reasonCodes=target_resolution_ambiguous"));
        assert!(summary.len() < 1200);
    }

    #[test]
    fn summarizes_ai_error_body_string_detail() {
        let summary = summarize_ai_error_body(r#"{"detail":"bad split"}"#);

        assert_eq!(summary, "bad split");
    }

    #[test]
    fn provider_call_challenge_echo_requires_exact_canonical_tag() {
        let challenge = json!({
            "schema_version": PROVIDER_CALL_CHALLENGE_SCHEMA_VERSION,
            "request_nonce": "provider-call:0123456789abcdef0123456789abcdef",
            "request_hash": format!("sha256:{}", "1".repeat(64)),
            "prompt_payload_hash": format!("sha256:{}", "2".repeat(64)),
            "challenge_hash": format!("sha256:{}", "3".repeat(64)),
        });
        let canonical = canonical_provider_call_challenge_tag(&challenge)
            .expect("canonical provider challenge tag");
        validate_provider_call_challenge_echo(&format!("prefix{canonical}suffix"), &challenge)
            .expect("exact canonical challenge should pass");

        let noncanonical = format!(
            "<synthi_provider_call_challenge>{}</synthi_provider_call_challenge>",
            serde_json::to_string_pretty(&challenge).expect("pretty challenge JSON")
        );
        let error = validate_provider_call_challenge_echo(&noncanonical, &challenge)
            .expect_err("semantic JSON equivalence must not replace exact prompt bytes")
            .to_string();
        assert!(error.contains("exact fresh-call challenge"));
    }

    #[test]
    fn required_provider_call_provenance_is_fail_closed() {
        let binding = json!({
            "schema_version": PROVIDER_CALL_REQUEST_SCHEMA_VERSION,
            "nonce": "provider-call:0123456789abcdef0123456789abcdef",
            "mode": "split",
            "request_mode": "split",
            "language": "cpp",
            "focus": "src/main.hip",
            "requested_provider": "generic_provider",
            "requested_model": "requested-model",
            "gpu_arch": "gfx1201",
            "source_hash": format!("sha256:{}", "1".repeat(64)),
            "file_manifest_hash": format!("sha256:{}", "2".repeat(64)),
            "file_count": 1,
            "extra_instructions_hash": format!("sha256:{}", "3".repeat(64)),
        });
        let request_hash = ordered_json_hash(vec![
            binding["schema_version"].clone(),
            binding["nonce"].clone(),
            binding["mode"].clone(),
            binding["request_mode"].clone(),
            binding["language"].clone(),
            binding["focus"].clone(),
            binding["requested_provider"].clone(),
            binding["requested_model"].clone(),
            binding["gpu_arch"].clone(),
            binding["source_hash"].clone(),
            binding["file_manifest_hash"].clone(),
            binding["file_count"].clone(),
            binding["extra_instructions_hash"].clone(),
        ]);
        let challenge_prompt_hash = prefixed_sha256("provider prompt payload");
        let challenge_hash = ordered_json_hash(vec![
            json!(PROVIDER_CALL_CHALLENGE_SCHEMA_VERSION),
            binding["nonce"].clone(),
            json!(request_hash),
            json!(challenge_prompt_hash),
        ]);
        let challenge = json!({
            "schema_version": PROVIDER_CALL_CHALLENGE_SCHEMA_VERSION,
            "request_nonce": binding["nonce"],
            "request_hash": request_hash,
            "prompt_payload_hash": challenge_prompt_hash,
            "challenge_hash": challenge_hash,
        });
        let raw_provider_response = format!(
            "{{\"files\":{{\"device.hip\":\"kernel\"}}}}<synthi_provider_call_challenge>{}</synthi_provider_call_challenge>",
            serde_json::to_string(&challenge).expect("challenge JSON")
        );
        let raw_result = r#"{"files":{"device.hip":"normalized-kernel"}}"#;
        let response_hash = prefixed_sha256(&raw_provider_response);
        let checked_at = "2026-07-15T00:00:00+00:00";
        let receipt_hash = ordered_json_hash(vec![
            json!(PROVIDER_CALL_RECEIPT_SCHEMA_VERSION),
            json!(PROVIDER_CALL_RECEIPT_AUTHORITY),
            binding["nonce"].clone(),
            json!(request_hash),
            json!(response_hash),
            json!(challenge_hash),
            json!("generic_provider"),
            json!("requested-model"),
            json!("actual-model"),
            json!("split"),
            json!("available"),
            json!(""),
            json!(false),
            json!(""),
            json!(false),
            json!(checked_at),
            json!("100"),
            json!("200"),
            json!("1700000000000000000"),
            json!("1700000000000000100"),
        ]);
        let valid = json!({
            "result": raw_result,
            "provider_call_raw_response": raw_provider_response,
            "model_provenance": {
                "provider_call_used": true,
                "provider": "generic_provider",
                "requested_model": "requested-model",
                "actual_model": "actual-model",
                "provider_model_status": "available",
                "fallback_model": null,
                "fallback_used": false,
                "provider_model_alias_resolved_to": null,
                "provider_shutdown_or_deprecation_detected": false,
                "request_mode": "split",
                "model_availability_checked_at": checked_at,
                "hard_infra_failure": false
            },
            "provider_call_receipt": {
                "schema_version": PROVIDER_CALL_RECEIPT_SCHEMA_VERSION,
                "proof_authority": PROVIDER_CALL_RECEIPT_AUTHORITY,
                "accepted": true,
                "provider_call_used": true,
                "request_binding": binding,
                "request_nonce": binding["nonce"],
                "request_hash": request_hash,
                "response_hash": response_hash,
                "challenge": challenge,
                "challenge_hash": challenge_hash,
                "challenge_echo_verified": true,
                "provider": "generic_provider",
                "requested_model": "requested-model",
                "actual_model": "actual-model",
                "request_mode": "split",
                "provider_model_status": "available",
                "fallback_model": null,
                "fallback_used": false,
                "provider_model_alias_resolved_to": null,
                "provider_shutdown_or_deprecation_detected": false,
                "model_availability_checked_at": checked_at,
                "hard_infra_failure": false,
                "started_monotonic_ns": "100",
                "completed_monotonic_ns": "200",
                "started_unix_ns": "1700000000000000000",
                "completed_unix_ns": "1700000000000000100",
                "receipt_hash": receipt_hash,
                "call_id": format!("provider-call:{}", receipt_hash),
                "accepted_for_gpu_hmr": false,
                "gpu_hmr_success": false,
                "can_satisfy_runtime_proof": false,
                "can_satisfy_dispatch_proof": false
            }
        });
        validate_required_ai_provider_call(&valid, &binding, &request_hash)
            .expect("valid provider provenance");

        let mut top_level_only = valid.clone();
        top_level_only["provider_call_used"] = json!(true);
        top_level_only["model_provenance"]["provider_call_used"] = json!(false);
        let error = validate_required_ai_provider_call(&top_level_only, &binding, &request_hash)
            .expect_err("nested provider observation remains authoritative")
            .to_string();
        assert!(error.contains("ai_split_provider_call_not_observed"));

        let mut forged_response = valid.clone();
        forged_response["provider_call_receipt"]["response_hash"] =
            json!(format!("sha256:{}", "9".repeat(64)));
        let error = validate_required_ai_provider_call(&forged_response, &binding, &request_hash)
            .expect_err("forged provider response hash")
            .to_string();
        assert!(error.contains("ai_split_provider_receipt_response_hash_mismatch"));
        assert!(error.contains("ai_split_provider_receipt_hash_mismatch"));

        let mut forged_requested_model = valid.clone();
        forged_requested_model["model_provenance"]["requested_model"] = json!("other-model");
        forged_requested_model["provider_call_receipt"]["requested_model"] = json!("other-model");
        let forged_receipt_hash = ordered_json_hash(vec![
            json!(PROVIDER_CALL_RECEIPT_SCHEMA_VERSION),
            json!(PROVIDER_CALL_RECEIPT_AUTHORITY),
            binding["nonce"].clone(),
            json!(request_hash),
            json!(response_hash),
            json!(challenge_hash),
            json!("generic_provider"),
            json!("other-model"),
            json!("actual-model"),
            json!("split"),
            json!("available"),
            json!(""),
            json!(false),
            json!(""),
            json!(false),
            json!(checked_at),
            json!("100"),
            json!("200"),
            json!("1700000000000000000"),
            json!("1700000000000000100"),
        ]);
        forged_requested_model["provider_call_receipt"]["receipt_hash"] =
            json!(forged_receipt_hash);
        forged_requested_model["provider_call_receipt"]["call_id"] =
            json!(format!("provider-call:{}", forged_receipt_hash));
        let error =
            validate_required_ai_provider_call(&forged_requested_model, &binding, &request_hash)
                .expect_err("receipt model must remain bound to request")
                .to_string();
        assert!(error.contains("ai_split_provider_receipt_requested_model_mismatch"));

        let mut forged_requested_provider = valid.clone();
        forged_requested_provider["model_provenance"]["provider"] = json!("other_provider");
        forged_requested_provider["provider_call_receipt"]["provider"] =
            json!("other_provider");
        let forged_provider_receipt_hash = ordered_json_hash(vec![
            json!(PROVIDER_CALL_RECEIPT_SCHEMA_VERSION),
            json!(PROVIDER_CALL_RECEIPT_AUTHORITY),
            binding["nonce"].clone(),
            json!(request_hash),
            json!(response_hash),
            json!(challenge_hash),
            json!("other_provider"),
            json!("requested-model"),
            json!("actual-model"),
            json!("split"),
            json!("available"),
            json!(""),
            json!(false),
            json!(""),
            json!(false),
            json!(checked_at),
            json!("100"),
            json!("200"),
            json!("1700000000000000000"),
            json!("1700000000000000100"),
        ]);
        forged_requested_provider["provider_call_receipt"]["receipt_hash"] =
            json!(forged_provider_receipt_hash);
        forged_requested_provider["provider_call_receipt"]["call_id"] =
            json!(format!("provider-call:{}", forged_provider_receipt_hash));
        let error = validate_required_ai_provider_call(
            &forged_requested_provider,
            &binding,
            &request_hash,
        )
        .expect_err("receipt provider must remain bound to request")
        .to_string();
        assert!(error.contains("ai_split_provider_receipt_requested_provider_mismatch"));

        let mut authority_claim = valid.clone();
        authority_claim["provider_call_receipt"]["gpuHmrSuccess"] = json!(true);
        let error = validate_required_ai_provider_call(&authority_claim, &binding, &request_hash)
            .expect_err("provider receipt authority claim")
            .to_string();
        assert!(error.contains("ai_split_provider_receipt_claims_gpu_authority"));

        let mut typed_authority_claim = valid.clone();
        typed_authority_claim["provider_call_receipt"]["gpuHmrSuccess"] = json!("true");
        let error =
            validate_required_ai_provider_call(&typed_authority_claim, &binding, &request_hash)
                .expect_err("provider receipt non-boolean authority claim")
                .to_string();
        assert!(error.contains("ai_split_provider_receipt_claims_gpu_authority"));

        let mut provenance_authority_claim = valid.clone();
        provenance_authority_claim["model_provenance"]["acceptedForGpuHmr"] = json!(1);
        let error = validate_required_ai_provider_call(
            &provenance_authority_claim,
            &binding,
            &request_hash,
        )
        .expect_err("provider provenance authority claim")
        .to_string();
        assert!(error.contains("ai_split_provider_receipt_claims_gpu_authority"));
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

    #[test]
    fn split_normalization_does_not_infer_default_role_filenames() {
        let split = json!({
            "shared.h": "#pragma once\n",
            "core.cpp": "extern \"C\" void core_on_update(void*, double) {}",
            "gui.cpp": "extern \"C\" void gui_on_render(void*) {}",
            "host_runner.cpp": "int main() { return 0; }",
            "device.hip": "extern \"C\" __global__ void inferred_device(float* x) {}",
            "device.cu": "extern \"C\" __global__ void inferred_cuda(float* x) {}"
        });
        let manifest = json!({
            "gpu": { "vendor": "rocm" }
        });

        let normalized = normalize_split_response(split, Some(&manifest));

        for role in ["shared", "core", "gui", "host_runner", "device"] {
            assert!(
                normalized.get(role).is_none(),
                "role {role} should require an explicit manifest module file or role object"
            );
        }
        assert!(normalized.get("device.hip").is_some());
        assert!(normalized.get("device.cu").is_some());
    }

    fn gpu_compile_request_for_source(source: &str) -> CompileRequest {
        CompileRequest {
            language: "cpp".to_string(),
            filename: "main.cpp".to_string(),
            source: source.to_string(),
            session_id: None,
            files: Vec::new(),
            file_refs: Vec::new(),
            is_gui: true,
            width: None,
            height: None,
            supports_h265: None,
            use_ai_split: true,
            bypass_ai_split_cache: false,
            require_ai_provider_call: false,
            ai_provider_call_nonce: None,
            ai_provider: None,
            ai_model: None,
            user_requested_ai: false,
            user_requested_deterministic: false,
            force_gpu_ai_delta: false,
            prefer_gpu_pipeline: true,
            gpu_mode: Some("rocm".to_string()),
            gpu_arch: Some("gfx1201".to_string()),
            compile_manifest: None,
            target: None,
            project_root: None,
            slug: None,
        }
    }

    #[test]
    fn required_provider_call_requires_caller_identity() {
        let mut req = gpu_compile_request_for_source("__global__ void kernel(float* out) {}");
        req.require_ai_provider_call = true;

        let error =
            provider_call_request_binding(&req, &[], "requested-model", Some("gfx1201"), None)
                .expect_err("missing caller nonce must fail before provider execution")
                .to_string();
        assert!(error.contains("caller-generated nonce"));

        req.ai_provider_call_nonce = Some("provider-call:not-hex".to_string());
        assert!(
            provider_call_request_binding(&req, &[], "requested-model", Some("gfx1201"), None,)
                .is_err()
        );

        let nonce = "provider-call:0123456789abcdef0123456789abcdef";
        req.ai_provider_call_nonce = Some(nonce.to_string());
        let error = provider_call_request_binding(
            &req,
            &[],
            "requested-model",
            Some("gfx1201"),
            None,
        )
        .expect_err("missing caller provider must fail before provider execution")
        .to_string();
        assert!(error.contains("explicit provider"));

        req.ai_provider = Some("Generic-Provider".to_string());
        let error = provider_call_request_binding(
            &req,
            &[],
            "requested-model",
            Some("gfx1201"),
            None,
        )
        .expect_err("missing caller model must fail before provider execution")
        .to_string();
        assert!(error.contains("explicit model"));

        req.ai_model = Some("requested-model".to_string());
        let (binding, _) =
            provider_call_request_binding(&req, &[], "requested-model", Some("gfx1201"), None)
                .expect("valid caller nonce");
        assert_eq!(binding["nonce"], nonce);
        assert_eq!(binding["requested_provider"], "generic-provider");
        assert_eq!(binding["requested_model"], "requested-model");
    }

    #[test]
    fn live_update_contract_rejects_generated_split_that_omits_update_kernel_and_readback() {
        let req = gpu_compile_request_for_source(
            r#"
#include <hip/hip_runtime.h>
__global__ void initialize_positions(float* x) {}
__global__ void advect_particles(float* x) {}
int main() {
    float* d = nullptr;
    float h[16];
    dim3 grid(1), block(64);
    initialize_positions<<<grid, block>>>(d);
    advect_particles<<<grid, block>>>(d);
    hipMemcpy(h, d, sizeof(h), hipMemcpyDeviceToHost);
}
"#,
        );
        let split = json!({
            "core": {
                "content": "extern \"C\" void core_on_update(void*) { synthi_gpu_launch(nullptr, \"initialize_positions\", dim3(1), dim3(64), 0, nullptr, {}); }"
            },
            "gui": { "content": "extern \"C\" void gui_on_render(void*) {}" },
            "host_runner": { "content": "int main() { return 0; }" },
            "device": {
                "content": "extern \"C\" __global__ void initialize_positions(float*) {} extern \"C\" __global__ void advect_particles(float*) {}"
            }
        });

        let err = validate_gpu_split_live_update_contract(&req, &split).unwrap_err();
        let message = err.to_string();
        assert!(message.contains("gpu_split_live_update_missing_kernel_launch:advect_particles"));
        assert!(message.contains("gpu_split_live_update_missing_device_to_host_readback"));
    }

    #[test]
    fn live_update_contract_accepts_generated_split_with_update_kernel_and_readback() {
        let req = gpu_compile_request_for_source(
            r#"
#include <hip/hip_runtime.h>
__global__ void advect_particles(float* x) {}
int main() {
    float* d = nullptr;
    float h[16];
    dim3 grid(1), block(64);
    advect_particles<<<grid, block>>>(d);
    hipMemcpy(h, d, sizeof(h), hipMemcpyDeviceToHost);
}
"#,
        );
        let split = json!({
            "core": {
                "content": "extern \"C\" void core_on_update(void*) { synthi_gpu_launch(nullptr, \"advect_particles\", dim3(1), dim3(64), 0, nullptr, {}); hipMemcpy(host_values, device_values, 64, hipMemcpyDeviceToHost); }"
            },
            "gui": { "content": "extern \"C\" void gui_on_render(void*) {}" },
            "host_runner": { "content": "int main() { return 0; }" },
            "device": {
                "content": "extern \"C\" __global__ void advect_particles(float*) {}"
            }
        });

        validate_gpu_split_live_update_contract(&req, &split).unwrap();
    }

    #[test]
    fn live_update_contract_rejects_multi_file_split_that_omits_kernel() {
        let mut req = gpu_compile_request_for_source(
            r#"
#include "kernels.hip"
int main() { return 0; }
"#,
        );
        req.files = vec![FileEntry {
            name: "src/kernels.hip".to_string(),
            content: r#"
#include <hip/hip_runtime.h>
__global__ void shade_tile(float* x) {}
void launch_frame(float* d) {
    dim3 grid(1), block(64);
    shade_tile<<<grid, block>>>(d);
}
"#
            .to_string(),
        }];
        let split = json!({
            "core": {
                "content": "extern \"C\" void core_on_update(void*) {}"
            },
            "gui": { "content": "extern \"C\" void gui_on_render(void*) {}" },
            "host_runner": { "content": "int main() { return 0; }" },
            "device": {
                "content": "extern \"C\" __global__ void shade_tile(float*) {}"
            }
        });

        let err = validate_gpu_split_live_update_contract(&req, &split).unwrap_err();
        assert!(err
            .to_string()
            .contains("gpu_split_live_update_missing_kernel_launch:shade_tile"));
    }

    #[test]
    fn live_update_contract_rejects_raw_generated_launch_without_hmr_boundary() {
        let req = gpu_compile_request_for_source(
            r#"
#include <hip/hip_runtime.h>
__global__ void shade_tile(float* x) {}
int main() {
    float* d = nullptr;
    dim3 grid(1), block(64);
    shade_tile<<<grid, block>>>(d);
}
"#,
        );
        let split = json!({
            "core": {
                "content": "extern \"C\" void core_on_update(void*) { dim3 grid(1), block(64); shade_tile<<<grid, block>>>(device_values); }"
            },
            "gui": { "content": "extern \"C\" void gui_on_render(void*) {}" },
            "host_runner": { "content": "int main() { return 0; }" },
            "device": {
                "content": "extern \"C\" __global__ void shade_tile(float*) {}"
            }
        });

        let err = validate_gpu_split_live_update_contract(&req, &split).unwrap_err();
        assert!(err
            .to_string()
            .contains("gpu_split_live_update_missing_kernel_launch:shade_tile"));
    }

    #[test]
    fn live_update_contract_accepts_hip_launch_kernel_ggl_boundary() {
        let req = gpu_compile_request_for_source(
            r#"
#include <hip/hip_runtime.h>
__global__ void shade_tile(float* x) {}
int main() {
    float* d = nullptr;
    dim3 grid(1), block(64);
    hipLaunchKernelGGL(shade_tile, grid, block, 0, 0, d);
}
"#,
        );
        let split = json!({
            "core": {
                "content": "extern \"C\" void core_on_update(void*) { synthi_gpu_launch(nullptr, \"shade_tile\", dim3(1), dim3(64), 0, nullptr, {}); }"
            },
            "gui": { "content": "extern \"C\" void gui_on_render(void*) {}" },
            "host_runner": { "content": "int main() { return 0; }" },
            "device": {
                "content": "extern \"C\" __global__ void shade_tile(float*) {}"
            }
        });

        validate_gpu_split_live_update_contract(&req, &split).unwrap();
    }

    #[tokio::test]
    async fn invalidates_split_cache_after_compile_failure() {
        let req = CompileRequest {
            language: "cpp".to_string(),
            filename: "src/cache_poison_probe.cpp".to_string(),
            source: "__global__ void cache_poison_probe(float* x) { x[0] = 1.0f; }".to_string(),
            session_id: None,
            files: Vec::new(),
            file_refs: Vec::new(),
            is_gui: true,
            width: None,
            height: None,
            supports_h265: None,
            use_ai_split: true,
            bypass_ai_split_cache: false,
            require_ai_provider_call: false,
            ai_provider_call_nonce: None,
            ai_provider: None,
            ai_model: None,
            user_requested_ai: false,
            user_requested_deterministic: false,
            force_gpu_ai_delta: false,
            prefer_gpu_pipeline: true,
            gpu_mode: Some("rocm".to_string()),
            gpu_arch: Some("gfx1201".to_string()),
            compile_manifest: None,
            target: None,
            project_root: None,
            slug: None,
        };
        let key = ai_split_cache_key(&req);
        get_ai_split_cache().lock().await.insert(
            key,
            CachedSplit {
                result: json!({"core": {"content": "{", "filename": "core.cpp"}}),
                original_source: req.source.clone(),
            },
        );

        invalidate_ai_split_cache(&req, "compile_core_failed").await;

        assert!(get_ai_split_cache().lock().await.get(&key).is_none());
    }

    #[tokio::test]
    async fn updates_cached_device_role_after_verified_heal() {
        let req = CompileRequest {
            language: "cpp".to_string(),
            filename: "src/healed_cache_probe.cpp".to_string(),
            source: "__global__ void healed_cache_probe(float* x) { x[0] = 1.0f; }".to_string(),
            session_id: None,
            files: Vec::new(),
            file_refs: Vec::new(),
            is_gui: true,
            width: None,
            height: None,
            supports_h265: None,
            use_ai_split: true,
            bypass_ai_split_cache: false,
            require_ai_provider_call: false,
            ai_provider_call_nonce: None,
            ai_provider: None,
            ai_model: None,
            user_requested_ai: false,
            user_requested_deterministic: false,
            force_gpu_ai_delta: false,
            prefer_gpu_pipeline: true,
            gpu_mode: Some("rocm".to_string()),
            gpu_arch: Some("gfx1201".to_string()),
            compile_manifest: None,
            target: None,
            project_root: None,
            slug: None,
        };
        let key = ai_split_cache_key(&req);
        get_ai_split_cache().lock().await.insert(
            key,
            CachedSplit {
                result: json!({
                    "device": {
                        "filename": ".synthi/generated/gpu/device.hip",
                        "content": "bad generated device"
                    },
                    ".synthi/generated/gpu/device.hip": {
                        "filename": ".synthi/generated/gpu/device.hip",
                        "content": "bad generated device"
                    }
                }),
                original_source: req.source.clone(),
            },
        );

        assert!(
            update_ai_split_cache_role(
                &req,
                "device",
                ".synthi/generated/gpu/device.hip",
                "verified healed device".to_string(),
            )
            .await
        );

        let cache = get_ai_split_cache().lock().await;
        let cached = cache.get(&key).expect("cache entry");
        assert_eq!(
            cached
                .result
                .pointer("/device/content")
                .and_then(serde_json::Value::as_str),
            Some("verified healed device")
        );
        assert_eq!(
            cached
                .result
                .pointer("/.synthi~1generated~1gpu~1device.hip/content")
                .and_then(serde_json::Value::as_str),
            Some("verified healed device")
        );
    }
}
