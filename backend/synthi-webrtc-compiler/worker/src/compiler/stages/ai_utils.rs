use crate::infra::messages::CompileRequest;
use crate::infra::utils::get_wsl_host_ip;
use anyhow::Result;
use regex::Regex;
use reqwest;
use serde_json;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::OnceLock;

use super::guardrails::{is_semantic_string, patch_strings_in_cached_result};

// Cache for AI split results to avoid redundant API calls
#[derive(Clone)]
struct CachedSplit {
    result: serde_json::Value,
    original_source: String, // Store original source for string extraction
}

static AI_SPLIT_CACHE: OnceLock<tokio::sync::Mutex<std::collections::HashMap<u64, CachedSplit>>> =
    OnceLock::new();
// Secondary cache keyed by structural hash for string-patching hits
static AI_SPLIT_STRUCTURAL_CACHE: OnceLock<
    tokio::sync::Mutex<std::collections::HashMap<u64, CachedSplit>>,
> = OnceLock::new();

fn get_ai_split_cache() -> &'static tokio::sync::Mutex<std::collections::HashMap<u64, CachedSplit>>
{
    AI_SPLIT_CACHE.get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
}

fn get_ai_split_structural_cache(
) -> &'static tokio::sync::Mutex<std::collections::HashMap<u64, CachedSplit>> {
    AI_SPLIT_STRUCTURAL_CACHE
        .get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
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

// Extract string literals from source (helper)
fn extract_string_literals(source: &str) -> Vec<String> {
    let mut strings = Vec::new();
    let mut chars = source.chars().peekable();
    let mut in_string = false;
    let mut in_char = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut escape_next = false;
    let mut current_string = String::new();

    while let Some(c) = chars.next() {
        if escape_next {
            if in_string {
                current_string.push('\\');
                current_string.push(c);
            }
            escape_next = false;
            continue;
        }

        if in_line_comment {
            if c == '\n' {
                in_line_comment = false;
            }
            continue;
        }

        if in_block_comment {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block_comment = false;
            }
            continue;
        }

        if in_string {
            if c == '\\' {
                escape_next = true;
            } else if c == '"' {
                strings.push(current_string.clone());
                current_string.clear();
                in_string = false;
            } else {
                current_string.push(c);
            }
            continue;
        }

        if in_char {
            if c == '\\' {
                escape_next = true;
            } else if c == '\'' {
                in_char = false;
            }
            continue;
        }

        // Detect start of constructs
        if c == '/' {
            if chars.peek() == Some(&'/') {
                chars.next();
                in_line_comment = true;
                continue;
            }
            if chars.peek() == Some(&'*') {
                chars.next();
                in_block_comment = true;
                continue;
            }
        }
        if c == '"' {
            in_string = true;
            continue;
        }
        if c == '\'' {
            in_char = true;
            continue;
        }
    }
    strings
}

fn extract_structural_signature(source: &str) -> String {
    let mut result = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut in_string = false;
    let mut in_char = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut escape_next = false;

    while let Some(c) = chars.next() {
        if escape_next {
            escape_next = false;
            continue;
        }
        if in_line_comment {
            if c == '\n' {
                in_line_comment = false;
                result.push('\n');
            }
            continue;
        }
        if in_block_comment {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block_comment = false;
            }
            continue;
        }
        if in_string {
            if c == '\\' {
                escape_next = true;
            } else if c == '"' {
                in_string = false;
                result.push_str("\"__STR__\"");
            }
            continue;
        }
        if in_char {
            if c == '\\' {
                escape_next = true;
            } else if c == '\'' {
                in_char = false;
                result.push_str("'_'");
            }
            continue;
        }

        if c == '/' {
            if chars.peek() == Some(&'/') {
                chars.next();
                in_line_comment = true;
                continue;
            } else if chars.peek() == Some(&'*') {
                chars.next();
                in_block_comment = true;
                continue;
            }
        }
        if c == '"' {
            in_string = true;
            continue;
        }
        if c == '\'' {
            in_char = true;
            continue;
        }
        if c.is_ascii_digit() {
            while chars
                .peek()
                .map(|ch| {
                    ch.is_ascii_digit()
                        || *ch == '.'
                        || *ch == 'x'
                        || *ch == 'X'
                        || *ch == 'u'
                        || *ch == 'U'
                        || *ch == 'l'
                        || *ch == 'L'
                })
                .unwrap_or(false)
            {
                chars.next();
            }
            result.push_str("0");
            continue;
        }
        result.push(c);
    }
    result
}

fn has_semantic_string_changes(old_strings: &[String], new_strings: &[String]) -> bool {
    for (old, new) in old_strings.iter().zip(new_strings.iter()) {
        if old != new {
            if is_semantic_string(old) || is_semantic_string(new) {
                return true;
            }
        }
    }
    false
}

fn collect_string_changes(old_strings: &[String], new_strings: &[String]) -> Vec<(String, String)> {
    let mut changes = Vec::new();
    for (old, new) in old_strings.iter().zip(new_strings.iter()) {
        if old != new {
            changes.push((old.clone(), new.clone()));
        }
    }
    changes
}

async fn perform_incremental_ai_update(
    cached_result: &serde_json::Value,
    changes: &[(String, String)],
    _language: &str,
) -> Result<serde_json::Value> {
    let start_time = std::time::Instant::now();
    let core_content = cached_result
        .get("core")
        .and_then(|c| c.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let gui_content = cached_result
        .get("gui")
        .and_then(|g| g.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let shared_content = cached_result
        .get("shared")
        .and_then(|s| s.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    let changes_json: Vec<serde_json::Value> = changes
        .iter()
        .map(|(old, new)| serde_json::json!([old, new]))
        .collect();
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "update_type": "incremental",
        "changes": changes_json,
        "core_content": core_content,
        "gui_content": gui_content,
        "shared_content": shared_content
    });

    let backend_url = get_ai_backend_url();
    let url = format!("{}/refactor/structural", backend_url);
    eprintln!("[AI Split] Calling fast incremental endpoint: {}", url);

    let res = client
        .post(&url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;
    let result_str = res["result"]
        .as_str()
        .ok_or(anyhow::anyhow!("No result from AI"))?;
    // Clean markdown (omitted heavy logic for brevity, assuming backend returns clean or simple clean)
    // For now simple clean:
    let clean_json = result_str
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let updated_data: serde_json::Value = serde_json::from_str(clean_json)?;
    eprintln!(
        "[AI Split] Incremental update completed in {:?}",
        start_time.elapsed()
    );
    Ok(updated_data)
}

fn detect_structural_deletions(old_source: &str, new_source: &str) -> Vec<String> {
    let old_lines: Vec<&str> = old_source.lines().collect();
    let new_lines: Vec<&str> = new_source.lines().collect();
    let mut deletions = Vec::new();
    for old_line in &old_lines {
        let trimmed = old_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !new_lines.iter().any(|new_line| new_line.trim() == trimmed) {
            deletions.push(trimmed.to_string());
        }
    }
    deletions
}

fn try_local_deletion_patch(
    cached_result: &serde_json::Value,
    deletions: &[String],
) -> Option<serde_json::Value> {
    if deletions.is_empty() {
        return None;
    }
    let core_content = cached_result
        .get("core")
        .and_then(|c| c.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let gui_content = cached_result
        .get("gui")
        .and_then(|g| g.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let shared_content = cached_result
        .get("shared")
        .and_then(|s| s.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    let new_core = core_content.to_string();
    let new_gui = gui_content.to_string();
    let mut new_shared = shared_content.to_string();
    let mut any_changes = false;

    // Simple deletion logic (shortened for brevity but functional)
    for deletion in deletions {
        if deletion.len() < 3 {
            continue;
        }
        if deletion.contains("button") || deletion.contains("btn") {
            let btn_pattern = Regex::new(r"(\w+_btn_\w+|btn\d*_\w+)").unwrap();
            for cap in btn_pattern.captures_iter(deletion) {
                let var_name = &cap[1];
                let field_pattern = format!("int {};", var_name);
                if new_shared.contains(&field_pattern) {
                    new_shared = new_shared
                        .replace(&field_pattern, &format!("// REMOVED: {}", field_pattern));
                    any_changes = true;
                }
            }
        }
    }

    if !any_changes {
        return None;
    }
    let mut result = cached_result.clone();
    if let Some(core) = result.get_mut("core") {
        core["content"] = serde_json::Value::String(new_core);
    }
    if let Some(gui) = result.get_mut("gui") {
        gui["content"] = serde_json::Value::String(new_gui);
    }
    if let Some(shared) = result.get_mut("shared") {
        shared["content"] = serde_json::Value::String(new_shared);
    }
    Some(result)
}

async fn perform_delta_deletion(
    cached_result: &serde_json::Value,
    deletion_description: &str,
) -> Result<serde_json::Value> {
    let core_content = cached_result
        .get("core")
        .and_then(|c| c.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let gui_content = cached_result
        .get("gui")
        .and_then(|g| g.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let shared_content = cached_result
        .get("shared")
        .and_then(|s| s.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "update_type": "deletion",
        "changes_description": deletion_description,
        "core_content": core_content,
        "gui_content": gui_content,
        "shared_content": shared_content,
        "cached_result": cached_result
    });
    let backend_url = get_ai_backend_url();
    let url = format!("{}/refactor/delta", backend_url);
    let res = client
        .post(&url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;
    if let Some(result) = res.get("result") {
        return Ok(result.clone());
    }
    Err(anyhow::anyhow!(
        "No valid result from delta deletion endpoint"
    ))
}

fn detect_structural_additions(old_source: &str, new_source: &str) -> Option<String> {
    let old_lines: Vec<&str> = old_source.lines().collect();
    let new_lines: Vec<&str> = new_source.lines().collect();
    let mut additions = Vec::new();
    for new_line in &new_lines {
        let trimmed = new_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !old_lines.iter().any(|old_line| old_line.trim() == trimmed) {
            additions.push(trimmed.to_string());
        }
    }
    if additions.is_empty() {
        return None;
    }
    Some(additions.join("\n"))
}

async fn perform_structural_ai_update(
    cached_result: &serde_json::Value,
    _original_source: &str,
    _new_source: &str,
    structural_changes: &str,
    _language: &str,
) -> Result<serde_json::Value> {
    let core_content = cached_result
        .get("core")
        .and_then(|c| c.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let gui_content = cached_result
        .get("gui")
        .and_then(|g| g.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let shared_content = cached_result
        .get("shared")
        .and_then(|s| s.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "update_type": "addition",
        "changes_description": structural_changes,
        "core_content": core_content,
        "gui_content": gui_content,
        "shared_content": shared_content,
        "cached_result": cached_result
    });
    let backend_url = get_ai_backend_url();
    let url = format!("{}/refactor/delta", backend_url);
    let res = client
        .post(&url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    if let Some(result) = res.get("result") {
        return Ok(result.clone());
    }
    let result_str = res["result"]
        .as_str()
        .ok_or(anyhow::anyhow!("No result from AI delta endpoint"))?;
    let clean_json = result_str
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    // Try to find just the JSON object
    let json_only = if let Some(start) = clean_json.find('{') {
        &clean_json[start..] // Simple slice, real logic needs matching braces
    } else {
        clean_json
    };
    let updated_data: serde_json::Value = serde_json::from_str(json_only)?;
    Ok(updated_data)
}

pub async fn perform_ai_split(req: &CompileRequest) -> Result<serde_json::Value> {
    // Level 1: Full source hash -> instant cache hit
    let source_hash = calculate_hash(&req.source);
    let structural_sig = extract_structural_signature(&req.source);
    let structural_hash = calculate_hash(&structural_sig);

    {
        let cache = get_ai_split_cache().lock().await;
        if let Some(cached) = cache.get(&source_hash) {
            eprintln!("[AI Split] Cache HIT (exact match)");
            return Ok(cached.result.clone());
        }
    }

    // Level 2: Structural match
    let structural_cache_result = {
        let structural_cache = get_ai_split_structural_cache().lock().await;
        structural_cache.get(&structural_hash).cloned()
    };

    if let Some(cached) = structural_cache_result {
        let old_strings = extract_string_literals(&cached.original_source);
        let new_strings = extract_string_literals(&req.source);

        if has_semantic_string_changes(&old_strings, &new_strings) {
            let changes = collect_string_changes(&old_strings, &new_strings);
            if !changes.is_empty() {
                if let Ok(updated) =
                    perform_incremental_ai_update(&cached.result, &changes, &req.language).await
                {
                    let cached_entry = CachedSplit {
                        result: updated.clone(),
                        original_source: req.source.clone(),
                    };
                    get_ai_split_cache()
                        .lock()
                        .await
                        .insert(source_hash, cached_entry.clone());
                    get_ai_split_structural_cache()
                        .lock()
                        .await
                        .insert(structural_hash, cached_entry);
                    return Ok(updated);
                }
            }
        } else {
            let (patched_result, did_patch) =
                patch_strings_in_cached_result(&cached.result, &old_strings, &new_strings);
            if old_strings != new_strings && !did_patch {
                // Fallback to AI
            } else {
                get_ai_split_cache().lock().await.insert(
                    source_hash,
                    CachedSplit {
                        result: patched_result.clone(),
                        original_source: req.source.clone(),
                    },
                );
                return Ok(patched_result);
            }
        }
    }

    // Level 2.6: Local deletion
    let any_cached = get_ai_split_structural_cache()
        .lock()
        .await
        .values()
        .next()
        .cloned();
    if let Some(cached) = any_cached {
        let deletions = detect_structural_deletions(&cached.original_source, &req.source);
        if !deletions.is_empty() {
            if let Some(patched) = try_local_deletion_patch(&cached.result, &deletions) {
                let cached_entry = CachedSplit {
                    result: patched.clone(),
                    original_source: req.source.clone(),
                };
                get_ai_split_cache()
                    .lock()
                    .await
                    .insert(source_hash, cached_entry.clone());
                get_ai_split_structural_cache()
                    .lock()
                    .await
                    .insert(structural_hash, cached_entry);
                return Ok(patched);
            }
            if let Ok(updated) =
                perform_delta_deletion(&cached.result, deletions.join("\n").as_str()).await
            {
                return Ok(updated);
            }
        }

        // Level 2.75: Structural addition
        if let Some(structural_changes) =
            detect_structural_additions(&cached.original_source, &req.source)
        {
            if let Ok(updated) = perform_structural_ai_update(
                &cached.result,
                &cached.original_source,
                &req.source,
                &structural_changes,
                &req.language,
            )
            .await
            {
                return Ok(updated);
            }
        }
    }

    // Level 3: Full AI Split
    // The AI engine exposes /refactor/split/verified for verified splitting.
    // It expects a VerifiedAiRequest: { code, lang, mode?, verify?, auto_repair?, ... }
    // and returns { result: "<raw LLM JSON string>", lang, verified, ... }.
    // The LLM JSON inside "result" is: { core: {filename, content}, gui: {...}, shared: {...} }
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "code": req.source,
        "lang": req.language,
        "mode": "split",
        "verify": true,
        "auto_repair": true
    });

    let backend_url = get_ai_backend_url();

    // Try verified endpoint first; fall back to unverified if it times out.
    // Both return {"result": "<json>", "lang": "..."} — same parser handles both.
    let verified_url = format!("{}/refactor/split/verified", backend_url);
    let split_url = format!("{}/refactor/split", backend_url);

    eprintln!("[AI Split] Calling VERIFIED AI split endpoint: {}", verified_url);
    let verified_result: Result<serde_json::Value, anyhow::Error> = async {
        let resp = client
            .post(&verified_url)
            .json(&payload)
            .timeout(std::time::Duration::from_secs(150))
            .send()
            .await?
            .error_for_status()?;
        Ok(resp.json::<serde_json::Value>().await?)
    }.await;

    let raw_response = match verified_result {
        Ok(json) if json.get("result").and_then(|r| r.as_str()).is_some() => json,
        Ok(json) => {
            eprintln!("[AI Split] Verified returned no result field: {:?}, trying unverified",
                json.to_string().chars().take(200).collect::<String>());
            client
                .post(&split_url)
                .json(&payload)
                .timeout(std::time::Duration::from_secs(150))
                .send()
                .await?
                .json::<serde_json::Value>()
                .await?
        }
        Err(e) => {
            eprintln!("[AI Split] Verified endpoint failed ({}), trying unverified", e);
            let resp = client
                .post(&split_url)
                .json(&payload)
                .timeout(std::time::Duration::from_secs(150))
                .send()
                .await?
                .error_for_status()?;
            resp.json::<serde_json::Value>().await?
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
    let mut res = res;
    if let Some(arch) = raw_response.get("architecture").and_then(|v| v.as_str()) {
        if !arch.is_empty() {
            eprintln!("[AI Split] architecture cache captured ({} chars)", arch.len());
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

    // Cache result
    let cached_entry = CachedSplit {
        result: res.clone(),
        original_source: req.source.clone(),
    };
    get_ai_split_cache()
        .lock()
        .await
        .insert(source_hash, cached_entry.clone());
    get_ai_split_structural_cache()
        .lock()
        .await
        .insert(structural_hash, cached_entry);

    Ok(res)
}

/// Call the AI diff-patch endpoint to apply a source diff to split modules.
///
/// Takes a unified diff of the user's source changes + current split file
/// contents, sends them to the AI, and returns a JSON value with updated
/// module contents for only the files that changed.
pub async fn perform_ai_diff_patch(
    diff: &str,
    core_content: &str,
    gui_content: &str,
    shared_content: &str,
) -> Result<serde_json::Value> {
    let client = reqwest::Client::new();
    let backend_url = get_ai_backend_url();
    let url = format!("{}/refactor/diff_patch", backend_url);

    eprintln!("[AI DiffPatch] Calling {} with diff ({} bytes)", url, diff.len());

    let payload = serde_json::json!({
        "diff": diff,
        "core_content": core_content,
        "gui_content": gui_content,
        "shared_content": shared_content,
    });

    let res = client
        .post(&url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    // The endpoint returns {"result": {"core": {...}, "gui": {...}, ...}}
    let result = res.get("result").cloned().unwrap_or(serde_json::json!({}));
    let elapsed = res.get("elapsed_seconds").and_then(|v| v.as_f64()).unwrap_or(0.0);
    eprintln!("[AI DiffPatch] Completed in {:.2}s", elapsed);

    Ok(result)
}

/// Targeted delta patch: send only ONE module + a small diff hunk to the AI.
/// Much faster than sending all 3 modules (~1-2s vs ~22s).
///
/// `architecture` is the cached split-architecture markdown doc captured at
/// initial split time. Passing `Some(arch)` injects it into the prompt as
/// a hint so the model does not re-derive the module contract on every
/// edit. Passing `None` (or `Some("")`) falls back to the generic prompt.
pub async fn perform_targeted_delta_patch(
    diff_hunk: &str,
    module_name: &str,
    module_content: &str,
    architecture: Option<&str>,
) -> Result<String> {
    let client = reqwest::Client::new();
    let backend_url = get_ai_backend_url();
    let url = format!("{}/refactor/diff_patch", backend_url);

    eprintln!(
        "[AI TargetedPatch] {} module, {} bytes diff, arch={} chars",
        module_name,
        diff_hunk.len(),
        architecture.map(|s| s.len()).unwrap_or(0)
    );

    let payload = serde_json::json!({
        "diff": diff_hunk,
        "target_module": module_name,
        "module_content": module_content,
        "architecture": architecture.unwrap_or(""),
    });

    let res = client
        .post(&url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let elapsed = res.get("elapsed_seconds").and_then(|v| v.as_f64()).unwrap_or(0.0);
    eprintln!("[AI TargetedPatch] {} completed in {:.2}s", module_name, elapsed);

    // Extract the patched module content
    let result = res.get("result").cloned().unwrap_or(serde_json::json!({}));
    let patched = result.get(module_name)
        .and_then(|v| v.get("content").or(Some(v)))
        .and_then(|v| v.as_str())
        .unwrap_or(module_content);

    Ok(patched.to_string())
}

/// Ask the AI to fix a compilation error in a module.
///
/// Sends the broken code + g++ error messages to `/refactor/heal`.
/// The AI returns the complete fixed file (~1-2s).
pub async fn perform_ai_heal(
    module_name: &str,
    module_content: &str,
    error_messages: &str,
    shared_content: &str,
) -> Result<String> {
    let client = reqwest::Client::new();
    let backend_url = get_ai_backend_url();
    let url = format!("{}/refactor/heal", backend_url);

    eprintln!(
        "[AI Heal] {} module, {} bytes code, {} bytes errors",
        module_name,
        module_content.len(),
        error_messages.len()
    );

    let payload = serde_json::json!({
        "module_name": module_name,
        "module_content": module_content,
        "error_messages": error_messages,
        "shared_content": shared_content,
    });

    let res = client
        .post(&url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let elapsed = res.get("elapsed_seconds").and_then(|v| v.as_f64()).unwrap_or(0.0);
    eprintln!("[AI Heal] {} completed in {:.2}s", module_name, elapsed);

    let content = res
        .get("result")
        .and_then(|r| r.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| anyhow::anyhow!("No content in heal response"))?;

    Ok(content.to_string())
}

/// Classify which module a code diff belongs to using AI.
/// Returns "core", "gui", "shared", or "unknown".
pub async fn perform_ai_classify_edit(diff: &str, lang: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let backend_url = get_ai_backend_url();
    let url = format!("{}/classify/edit", backend_url);

    let payload = serde_json::json!({ "diff": diff, "lang": lang });

    // 30s allows for the occasional cold-start latency spike on Gemini lite.
    // Typical classify should return in <2s with gemini-3.1-flash-lite-preview.
    let res = client
        .post(&url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    Ok(res.get("target")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string())
}
