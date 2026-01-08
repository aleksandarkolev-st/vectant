use std::sync::OnceLock;
use std::hash::{Hash, Hasher};
use std::collections::hash_map::DefaultHasher;
use anyhow::{Result, Context};
use serde_json;
use reqwest;
use regex::Regex;
use crate::infra::messages::CompileRequest;
use crate::infra::utils::get_wsl_host_ip;

use super::guardrails::{patch_strings_in_cached_result, is_semantic_string};

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

fn calculate_hash<T: Hash>(t: &T) -> u64 {
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
            if c == '\n' { in_line_comment = false; }
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
        if escape_next { escape_next = false; continue; }
        if in_line_comment { if c == '\n' { in_line_comment = false; result.push('\n'); } continue; }
        if in_block_comment { if c == '*' && chars.peek() == Some(&'/') { chars.next(); in_block_comment = false; } continue; }
        if in_string { if c == '\\' { escape_next = true; } else if c == '"' { in_string = false; result.push_str("\"__STR__\""); } continue; }
        if in_char { if c == '\\' { escape_next = true; } else if c == '\'' { in_char = false; result.push_str("'_'"); } continue; }

        if c == '/' {
            if chars.peek() == Some(&'/') { chars.next(); in_line_comment = true; continue; }
            else if chars.peek() == Some(&'*') { chars.next(); in_block_comment = true; continue; }
        }
        if c == '"' { in_string = true; continue; }
        if c == '\'' { in_char = true; continue; }
        if c.is_ascii_digit() {
            while chars.peek().map(|ch| ch.is_ascii_digit() || *ch == '.' || *ch == 'x' || *ch == 'X' || *ch == 'u' || *ch == 'U' || *ch == 'l' || *ch == 'L').unwrap_or(false) {
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
    let core_content = cached_result.get("core").and_then(|c| c.get("content")).and_then(|c| c.as_str()).unwrap_or("");
    let gui_content = cached_result.get("gui").and_then(|g| g.get("content")).and_then(|c| c.as_str()).unwrap_or("");
    let shared_content = cached_result.get("shared").and_then(|s| s.get("content")).and_then(|c| c.as_str()).unwrap_or("");

    let changes_json: Vec<serde_json::Value> = changes.iter().map(|(old, new)| serde_json::json!([old, new])).collect();
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

    let res = client.post(&url).json(&payload).timeout(std::time::Duration::from_secs(20)).send().await?.json::<serde_json::Value>().await?;
    let result_str = res["result"].as_str().ok_or(anyhow::anyhow!("No result from AI"))?;
    // Clean markdown (omitted heavy logic for brevity, assuming backend returns clean or simple clean)
    // For now simple clean:
    let clean_json = result_str.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let updated_data: serde_json::Value = serde_json::from_str(clean_json)?;
    eprintln!("[AI Split] Incremental update completed in {:?}", start_time.elapsed());
    Ok(updated_data)
}

fn detect_structural_deletions(old_source: &str, new_source: &str) -> Vec<String> {
    let old_lines: Vec<&str> = old_source.lines().collect();
    let new_lines: Vec<&str> = new_source.lines().collect();
    let mut deletions = Vec::new();
    for old_line in &old_lines {
        let trimmed = old_line.trim();
        if trimmed.is_empty() { continue; }
        if !new_lines.iter().any(|new_line| new_line.trim() == trimmed) {
            deletions.push(trimmed.to_string());
        }
    }
    deletions
}

fn try_local_deletion_patch(cached_result: &serde_json::Value, deletions: &[String]) -> Option<serde_json::Value> {
    if deletions.is_empty() { return None; }
    let core_content = cached_result.get("core").and_then(|c| c.get("content")).and_then(|c| c.as_str()).unwrap_or("");
    let gui_content = cached_result.get("gui").and_then(|g| g.get("content")).and_then(|c| c.as_str()).unwrap_or("");
    let shared_content = cached_result.get("shared").and_then(|s| s.get("content")).and_then(|c| c.as_str()).unwrap_or("");

    let mut new_core = core_content.to_string();
    let mut new_gui = gui_content.to_string();
    let mut new_shared = shared_content.to_string();
    let mut any_changes = false;

    // Simple deletion logic (shortened for brevity but functional)
    for deletion in deletions {
        if deletion.len() < 3 { continue; }
        if deletion.contains("button") || deletion.contains("btn") {
            let btn_pattern = Regex::new(r"(\w+_btn_\w+|btn\d*_\w+)").unwrap();
            for cap in btn_pattern.captures_iter(deletion) {
                let var_name = &cap[1];
                 let field_pattern = format!("int {};", var_name);
                if new_shared.contains(&field_pattern) {
                    new_shared = new_shared.replace(&field_pattern, &format!("// REMOVED: {}", field_pattern));
                    any_changes = true;
                }
            }
        }
    }
    
    if !any_changes { return None; }
    let mut result = cached_result.clone();
     if let Some(core) = result.get_mut("core") { core["content"] = serde_json::Value::String(new_core); }
    if let Some(gui) = result.get_mut("gui") { gui["content"] = serde_json::Value::String(new_gui); }
    if let Some(shared) = result.get_mut("shared") { shared["content"] = serde_json::Value::String(new_shared); }
    Some(result)
}

async fn perform_delta_deletion(cached_result: &serde_json::Value, deletion_description: &str) -> Result<serde_json::Value> {
     let core_content = cached_result.get("core").and_then(|c| c.get("content")).and_then(|c| c.as_str()).unwrap_or("");
    let gui_content = cached_result.get("gui").and_then(|g| g.get("content")).and_then(|c| c.as_str()).unwrap_or("");
    let shared_content = cached_result.get("shared").and_then(|s| s.get("content")).and_then(|c| c.as_str()).unwrap_or("");
    
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
    let res = client.post(&url).json(&payload).timeout(std::time::Duration::from_secs(20)).send().await?.json::<serde_json::Value>().await?;
    if let Some(result) = res.get("result") { return Ok(result.clone()); }
    Err(anyhow::anyhow!("No valid result from delta deletion endpoint"))
}

fn detect_structural_additions(old_source: &str, new_source: &str) -> Option<String> {
    let old_lines: Vec<&str> = old_source.lines().collect();
    let new_lines: Vec<&str> = new_source.lines().collect();
    let mut additions = Vec::new();
    for new_line in &new_lines {
        let trimmed = new_line.trim();
        if trimmed.is_empty() { continue; }
        if !old_lines.iter().any(|old_line| old_line.trim() == trimmed) {
            additions.push(trimmed.to_string());
        }
    }
    if additions.is_empty() { return None; }
    Some(additions.join("\n"))
}

async fn perform_structural_ai_update(
    cached_result: &serde_json::Value,
    _original_source: &str,
    _new_source: &str,
    structural_changes: &str,
    _language: &str,
) -> Result<serde_json::Value> {
    let core_content = cached_result.get("core").and_then(|c| c.get("content")).and_then(|c| c.as_str()).unwrap_or("");
    let gui_content = cached_result.get("gui").and_then(|g| g.get("content")).and_then(|c| c.as_str()).unwrap_or("");
    let shared_content = cached_result.get("shared").and_then(|s| s.get("content")).and_then(|c| c.as_str()).unwrap_or("");
    
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
    let res = client.post(&url).json(&payload).timeout(std::time::Duration::from_secs(30)).send().await?.json::<serde_json::Value>().await?;
    
    if let Some(result) = res.get("result") { return Ok(result.clone()); }
     let result_str = res["result"].as_str().ok_or(anyhow::anyhow!("No result from AI delta endpoint"))?;
     let clean_json = result_str.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
      // Try to find just the JSON object
    let json_only = if let Some(start) = clean_json.find('{') {
        &clean_json[start..] // Simple slice, real logic needs matching braces
    } else { clean_json };
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
                if let Ok(updated) = perform_incremental_ai_update(&cached.result, &changes, &req.language).await {
                    let cached_entry = CachedSplit { result: updated.clone(), original_source: req.source.clone() };
                    get_ai_split_cache().lock().await.insert(source_hash, cached_entry.clone());
                    get_ai_split_structural_cache().lock().await.insert(structural_hash, cached_entry);
                    return Ok(updated);
                }
            }
        } else {
             let (patched_result, did_patch) = patch_strings_in_cached_result(&cached.result, &old_strings, &new_strings);
             if old_strings != new_strings && !did_patch {
                 // Fallback to AI
             } else {
                 get_ai_split_cache().lock().await.insert(source_hash, CachedSplit { result: patched_result.clone(), original_source: req.source.clone() });
                 return Ok(patched_result);
             }
        }
    }
    
    // Level 2.6: Local deletion
    let any_cached = get_ai_split_structural_cache().lock().await.values().next().cloned();
    if let Some(cached) = any_cached {
        let deletions = detect_structural_deletions(&cached.original_source, &req.source);
        if !deletions.is_empty() {
            if let Some(patched) = try_local_deletion_patch(&cached.result, &deletions) {
                 let cached_entry = CachedSplit { result: patched.clone(), original_source: req.source.clone() };
                 get_ai_split_cache().lock().await.insert(source_hash, cached_entry.clone());
                 get_ai_split_structural_cache().lock().await.insert(structural_hash, cached_entry);
                 return Ok(patched);
            }
             if let Ok(updated) = perform_delta_deletion(&cached.result, deletions.join("\n").as_str()).await {
                 return Ok(updated);
            }
        }
        
        // Level 2.75: Structural addition
         if let Some(structural_changes) = detect_structural_additions(&cached.original_source, &req.source) {
              if let Ok(updated) = perform_structural_ai_update(&cached.result, &cached.original_source, &req.source, &structural_changes, &req.language).await {
                  return Ok(updated);
              }
         }
    }
    
    // Level 3: Full AI Split
    let client = reqwest::Client::new();
     let payload = serde_json::json!({
        "source": req.source,
        "language": req.language,
        "is_gui": req.is_gui,
        "filename": req.filename
    });
    
    let backend_url = get_ai_backend_url();
    let url = format!("{}/generate/split", backend_url);
    eprintln!("[AI Split] Calling FULL AI split endpoint: {}", url);
    let res = client.post(&url).json(&payload).timeout(std::time::Duration::from_secs(60)).send().await?.json::<serde_json::Value>().await?;
    
    // Cache result
    let cached_entry = CachedSplit { result: res.clone(), original_source: req.source.clone() };
    get_ai_split_cache().lock().await.insert(source_hash, cached_entry.clone());
    get_ai_split_structural_cache().lock().await.insert(structural_hash, cached_entry);
    
    Ok(res)
}
