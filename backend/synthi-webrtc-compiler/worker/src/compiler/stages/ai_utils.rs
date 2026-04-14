use crate::infra::messages::CompileRequest;
use crate::infra::utils::get_wsl_host_ip;
use anyhow::Result;
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
    let source_hash = calculate_hash(&req.source);

    eprintln!(
        "[AI Split] ENTER (src_hash={}, src_len={})",
        source_hash,
        req.source.len()
    );

    {
        let cache = get_ai_split_cache().lock().await;
        if let Some(cached) = cache.get(&source_hash) {
            eprintln!("[AI Split] Level 1 HIT (exact source_hash match)");
            return Ok(cached.result.clone());
        }
        eprintln!("[AI Split] Level 1 MISS (cache entries: {})", cache.len());
    }

    // Level 3: Full AI Split
    // The AI engine exposes /refactor/split/verified for verified splitting.
    // It expects a VerifiedAiRequest: { code, lang, mode?, verify?, auto_repair?, ... }
    // and returns { result: "<raw LLM JSON string>", lang, verified, ... }.
    // The LLM JSON inside "result" is: { core: {filename, content}, gui: {...}, shared: {...} }
    eprintln!("[AI Split] Level 3 → full AI split via /refactor/split/verified");
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

    // ULTRAPLAN Phase 3: capture the compile manifest the AI synthesised
    // alongside the architecture cache. The Python response wrapper is
    // `{result: "...", architecture: "...", manifest: {...}, ...}` under
    // the universal split prompt. We stash it as `_synthi_manifest` in the
    // split Value so handler.rs can pull it into the sidecar and thread it
    // into compile_core / compile_gui. If the field is absent (old sidecar,
    // backend running pre-Phase-2 code, or parse failure on Python side),
    // downstream falls back to `CompileManifest::sdl2_default()`.
    if let Some(manifest) = raw_response.get("manifest") {
        if !manifest.is_null() {
            let manifest_size = manifest.to_string().len();
            eprintln!("[AI Split] compile manifest captured ({} bytes)", manifest_size);
            if let Some(obj) = res.as_object_mut() {
                obj.insert("_synthi_manifest".to_string(), manifest.clone());
            }
        } else {
            eprintln!("[AI Split] manifest field is null (fallback to sdl2 default downstream)");
        }
    } else {
        eprintln!("[AI Split] no manifest in response (fallback to sdl2 default downstream)");
    }

    // ULTRAPLAN Phase 4: log host_runner presence. The parsed `res` Value
    // already carries `host_runner` as a sibling of `core`/`gui`/`shared`
    // (because the universal split prompt outputs all four fields inside
    // the same `<JSON>` block, which Python forwards as `result`). No
    // explicit re-stashing is needed here — handler.rs reads
    // `split_data["host_runner"]["content"]` directly. This block is
    // observability only: confirms the AI honoured the 4-file contract.
    match res.get("host_runner").and_then(|v| v.get("content")).and_then(|c| c.as_str()) {
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

    let res: serde_json::Value = client
        .post(&url)
        .json(&payload)
        // 60s — diff_patch with diff-only output format. Output tokens
        // dropped from ~3000 (full file regen) to ~100 (edit instructions)
        // so the pro-model call should normally be 1-2s. 60s is very
        // generous headroom for network flakes.
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let elapsed = res.get("elapsed_seconds").and_then(|v| v.as_f64()).unwrap_or(0.0);

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

    let res = client
        .post(&url)
        .json(&payload)
        // 60s — heal sends the broken module + g++ errors back to the AI
        // for repair. Uses pro model by default (was previously lite but
        // promoted for quality). Typical 3-6s; 60s is generous headroom.
        .timeout(std::time::Duration::from_secs(60))
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

// NOTE: perform_ai_classify_edit + the /classify/edit Python endpoint
// were removed. Classify was costing ~4s per edit (network + Google
// API TTFT + Python SDK overhead for a lite call) — more time than
// it saved by letting us use a targeted single-module prompt. The
// architecture cache now handles routing inside the full diff_patch
// prompt via its "Where User Code Goes" section, so the AI routes
// internally from a single call per edit. See handler.rs Tier 2 flow.
