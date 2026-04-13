use anyhow::Result;
use crate::debug_log;

use crate::compiler::builder::{
    hash_content, hash_shared_header_semantic, ModuleHashes, RebuildScope,
};
use crate::compiler::context::CompileContext;
use crate::infra::messages::CompileRequest;

// Import our new modular stages
use crate::compiler::stages::ai_utils::{perform_ai_split, perform_ai_diff_patch};
use crate::compiler::stages::compile_core::compile_core;
use crate::compiler::stages::compile_gui::compile_gui;
use crate::compiler::stages::guardrails::{
    apply_core_guardrails, apply_gui_guardrails, apply_shared_guardrails,
};
use crate::compiler::stages::runner::handle_runner_execution;

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
async fn write_sidecar_logged(
    path: &std::path::Path,
    meta: &serde_json::Value,
) {
    let body = match serde_json::to_string(meta) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[HMR] sidecar serialize failed: {}", e);
            return;
        }
    };
    let arch_len = meta
        .get("architecture")
        .and_then(|v| v.as_str())
        .map(|s| s.len())
        .unwrap_or(0);
    match tokio::fs::write(path, &body).await {
        Ok(()) => {
            eprintln!(
                "[HMR] sidecar written: {} ({} bytes, arch={} chars)",
                path.display(),
                body.len(),
                arch_len
            );
        }
        Err(e) => {
            eprintln!(
                "[HMR] sidecar WRITE FAILED: {} → {}",
                path.display(),
                e
            );
        }
    }
}

/// Apply a list of AI-produced edits to the current core/gui/shared
/// module contents. Returns the patched contents, or propagates the
/// first error encountered (caller falls through to Tier 3 full re-split).
///
/// Each `Edit` carries its own `module` field; this dispatcher just
/// routes it to the matching string and calls `edit_applier::apply_edit`.
/// Edits are applied in order; if edit N fails, edits 0..N-1 are
/// already applied in the local copies but since we return `Err`, the
/// caller discards them and falls through to Tier 3 — no partial state
/// ever makes it to disk.
fn apply_edit_list(
    edits: &[crate::hmr::edit_applier::Edit],
    core: &str,
    gui: &str,
    shared: &str,
) -> anyhow::Result<(String, String, String)> {
    use crate::hmr::edit_applier::apply_edit;
    let mut c = core.to_string();
    let mut g = gui.to_string();
    let mut s = shared.to_string();

    for (i, edit) in edits.iter().enumerate() {
        let updated = match edit.module.as_str() {
            "core" => apply_edit(&c, edit)?,
            "gui" => apply_edit(&g, edit)?,
            "shared" => apply_edit(&s, edit)?,
            other => {
                anyhow::bail!("edit #{} targets unknown module {:?}", i, other);
            }
        };
        match edit.module.as_str() {
            "core" => c = updated,
            "gui" => g = updated,
            "shared" => s = updated,
            _ => unreachable!(),
        }
        eprintln!(
            "[HMR] Tier 2: applied edit #{} {:?} to {} (anchor {} chars, content {} chars)",
            i,
            edit.operation,
            edit.module,
            edit.anchor.len(),
            edit.content.len()
        );
    }

    Ok((c, g, s))
}

use crate::hmr::loop_classifier::{classify_loop, LoopClassifierInput};
use crate::hmr::adapted_project::detect_adapted_project;
use crate::hmr::compile_enrichment::CompileEnrichment;
use crate::hmr::ai_bypass::{check_ai_bypass, AiBypassResult, SplitCache};
use crate::hmr::deterministic_compile::{
    determine_deterministic_scope, validate_deterministic_input, DeterministicCompileInput,
    DeterministicRebuildScope,
};
use crate::hmr::build_manifest::{BuildManifest, BuildSlot, SnapshotMode};
use crate::hmr::adapter_trait::AdapterReloadResult;

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

    // ============================================================
    // HMR PIPELINE: Initialize and classify compile loop
    // ============================================================
    let language = req.language.as_str();
    let (rollout_flags, consecutive_failures) = {
        let mut orchestrator = ctx.hmr_orchestrator.lock().await;
        let pipeline = orchestrator.pipeline(&session_id);
        pipeline.ensure_adapter(language);
        (pipeline.rollout_flags.clone(), pipeline.consecutive_failures)
    };

    // ── Compute source hash ──
    let source_hash_value = hash_content(&req.source);
    let source_hash_str = format!("{}", source_hash_value);

    // ── Detect adapted-project status ──
    let mut adapted_status = detect_adapted_project(&ctx.workspace_path);

    // Try to read persisted split hash from sidecar
    let sidecar_path = ctx.workspace_path.join(".synthi_split_meta.json");
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
        check_ai_bypass(&pipeline.ai_gate, &split_cache, compile_loop, &source_hash_str)
    };

    // ============================================================
    // PHASE 1: AI SPLIT & PROCESSING (routed through ai_bypass)
    // ============================================================

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
            let meta = serde_json::json!({
                "split_hash": source_hash_str,
                "original_source": req.source,
                "architecture": architecture_md,
            });
            write_sidecar_logged(&sidecar_path, &meta).await;

            // Cache the result for future Loop A lookups
            split_cache.put(crate::hmr::ai_bypass::CachedSplitResult {
                source_hash: source_hash_str.clone(),
                core_code: result.get("core").and_then(|c| c["content"].as_str()).unwrap_or("").to_string(),
                gui_code: result.get("gui").and_then(|g| g["content"].as_str()).unwrap_or("").to_string(),
                shared_code: result.get("shared").and_then(|s| s["content"].as_str()).map(|s| s.to_string()),
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
            let is_editing_split_file = {
                let fname = req.filename.to_lowercase();
                fname.contains("core.") || fname.contains("gui.") || fname.contains("shared.")
            };

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

            if enrichment.adapted_status.is_adapted && is_editing_split_file {
                // User is editing a split file directly — syncFile already
                // wrote the new content to disk.  Just use it.
                debug_log!("[HMR] FallbackDeterministic → split file edit ({})", req.filename);
                serde_json::json!({
                    "shared": { "content": shared_content, "filename": "shared.h" },
                    "core": { "content": core_content, "filename": "core.cpp" },
                    "gui": { "content": gui_content, "filename": "gui.cpp" }
                })
            } else if enrichment.adapted_status.is_adapted {
                // User is editing original source (main.cpp).  Diff-patch the
                // changes into the split files without re-running AI.
                //
                // Read the original source saved at AI-split time.  Diff it
                // against the user's new source, then transplant each changed
                // line into the right split file (core/gui/shared).
                // Read both `original_source` (diff baseline) and `architecture`
                // (cached split doc — may be empty on pre-migration sidecars)
                // from the same sidecar file in one pass.
                let (original_source, architecture_md) = {
                    if let Ok(meta_raw) = tokio::fs::read_to_string(&sidecar_path).await {
                        match serde_json::from_str::<serde_json::Value>(&meta_raw) {
                            Ok(meta) => {
                                let src = meta
                                    .get("original_source")
                                    .and_then(|s| s.as_str())
                                    .map(|s| s.to_string());
                                let arch = meta
                                    .get("architecture")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                (src, arch)
                            }
                            Err(_) => (None, String::new()),
                        }
                    } else {
                        (None, String::new())
                    }
                };
                // Log what came back so the user can verify the cache is
                // round-tripping: the Proceed branch's "sidecar written: ...
                // arch=NNNN chars" should match this read's "arch=NNNN chars".
                eprintln!(
                    "[HMR] sidecar read: {} (original_source={}, arch={} chars)",
                    sidecar_path.display(),
                    if original_source.is_some() { "yes" } else { "no" },
                    architecture_md.len()
                );

                if let Some(old_source) = original_source {
                    let diff = build_simple_diff(&old_source, &req.source);

                    if diff.is_empty() {
                        debug_log!("[HMR] No diff detected");
                        serde_json::json!({
                            "shared": { "content": shared_content, "filename": "shared.h" },
                            "core": { "content": core_content, "filename": "core.cpp" },
                            "gui": { "content": gui_content, "filename": "gui.cpp" }
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
                        use crate::hmr::edit_classifier::classify_edit;
                        use crate::hmr::diff_patcher::patch_split_files;

                        let sync_classification = classify_edit(&old_source, &req.source);
                        let is_value_only = sync_classification.is_value_only;
                        eprintln!(
                            "[HMR] sync classify: {} hunks, value_only={}",
                            sync_classification.hunks.len(),
                            is_value_only
                        );

                        let arch_hint: Option<&str> = if architecture_md.is_empty() {
                            None
                        } else {
                            Some(architecture_md.as_str())
                        };

                        let (final_core, final_gui, final_shared) = if is_value_only {
                            // Tier 1: pure value change — instant regex
                            let patch = patch_split_files(
                                &old_source, &req.source,
                                &core_content, &gui_content, &shared_content,
                            );
                            if patch.has_changes() {
                                eprintln!("[HMR] Tier 1: instant value patch (0ms)");
                                (
                                    patch.core.unwrap_or_else(|| core_content.clone()),
                                    patch.gui.unwrap_or_else(|| gui_content.clone()),
                                    patch.shared.unwrap_or_else(|| shared_content.clone()),
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
                                    arch_hint,
                                ).await {
                                    Ok(edits) => {
                                        match apply_edit_list(&edits, &core_content, &gui_content, &shared_content) {
                                            Ok((c, g, s)) => (c, g, s),
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
                                                let meta = serde_json::json!({
                                                    "split_hash": source_hash_str,
                                                    "original_source": req.source,
                                                    "architecture": fresh_arch,
                                                });
                                                write_sidecar_logged(&sidecar_path, &meta).await;
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
                                        let meta = serde_json::json!({
                                            "split_hash": source_hash_str,
                                            "original_source": req.source,
                                            "architecture": fresh_arch,
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
                            let spec_hash = crate::hmr::speculative_diff_patch::hash_source(&req.source);
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
                            let speculative_applied: Option<(String, String, String)> = {
                                if let Some(cached_edits) =
                                    crate::hmr::speculative_diff_patch::take_matching_or_wait(
                                        spec_hash,
                                        std::time::Duration::from_secs(15),
                                    )
                                    .await
                                {
                                    match apply_edit_list(
                                        &cached_edits,
                                        &core_content,
                                        &gui_content,
                                        &shared_content,
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

                            if let Some(triple) = speculative_applied {
                                triple
                            } else {
                                // Live AI call (diff-only output format — ~100
                                // output tokens, ~1s generation on pro).
                                eprintln!(
                                    "[HMR] Tier 2: AI diff_patch (diff={} bytes, arch={} chars)",
                                    diff.len(),
                                    architecture_md.len()
                                );
                                match perform_ai_diff_patch(
                                    &diff,
                                    &core_content,
                                    &gui_content,
                                    &shared_content,
                                    arch_hint,
                                ).await {
                                    Ok(edits) => {
                                        eprintln!(
                                            "[HMR] Tier 2: received {} edit(s), applying locally",
                                            edits.len()
                                        );
                                        match apply_edit_list(&edits, &core_content, &gui_content, &shared_content) {
                                            Ok((c, g, s)) => {
                                                eprintln!(
                                                    "[HMR] Tier 2 SUCCESS ({} edits, core_changed={} gui_changed={} shared_changed={})",
                                                    edits.len(),
                                                    c != core_content,
                                                    g != gui_content,
                                                    s != shared_content
                                                );
                                                (c, g, s)
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
                                                let meta = serde_json::json!({
                                                    "split_hash": source_hash_str,
                                                    "original_source": req.source,
                                                    "architecture": fresh_arch,
                                                });
                                                write_sidecar_logged(&sidecar_path, &meta).await;
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
                                        let meta = serde_json::json!({
                                            "split_hash": source_hash_str,
                                            "original_source": req.source,
                                            "architecture": fresh_arch,
                                        });
                                        write_sidecar_logged(&sidecar_path, &meta).await;
                                        return Ok(result);
                                    }
                                }
                            }
                        };

                        // Write patched files to disk + update sidecar. Preserve
                        // the existing architecture cache — this is a diff-patch
                        // apply, not a re-split, so the architecture is still
                        // valid (same split modules, same contract).
                        if let Some(ref p) = enrichment.adapted_status.core_path {
                            let _ = tokio::fs::write(p, &final_core).await;
                        }
                        if let Some(ref p) = enrichment.adapted_status.gui_path {
                            let _ = tokio::fs::write(p, &final_gui).await;
                        }
                        if let Some(ref p) = enrichment.adapted_status.shared_path {
                            let _ = tokio::fs::write(p, &final_shared).await;
                        }
                        let meta = serde_json::json!({
                            "split_hash": source_hash_str,
                            "original_source": req.source,
                            "architecture": architecture_md,
                        });
                        write_sidecar_logged(&sidecar_path, &meta).await;

                        serde_json::json!({
                            "shared": { "content": final_shared, "filename": "shared.h" },
                            "core": { "content": final_core, "filename": "core.cpp" },
                            "gui": { "content": final_gui, "filename": "gui.cpp" }
                        })
                    }
                } else {
                    // No original source saved — need AI re-split
                    debug_log!("[HMR] No original source baseline, falling back to AI split");
                    let result = perform_ai_split(&req).await?;
                    let fresh_arch = result
                        .get("_synthi_architecture")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let meta = serde_json::json!({
                        "split_hash": source_hash_str,
                        "original_source": req.source,
                        "architecture": fresh_arch,
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
        debug_log!("[Guardrail] shared.h was modified by guardrails — prompt produced incorrect output");
    }
    let allow_gui_in_core = enrichment.is_deterministic();
    let processed_core = apply_core_guardrails(core_raw, &processed_shared, allow_gui_in_core);
    if processed_core != core_raw {
        debug_log!("[Guardrail] core.cpp was modified by guardrails — prompt produced incorrect output");
    }
    let processed_gui = apply_gui_guardrails(gui_raw, &processed_shared);
    if processed_gui != gui_raw {
        debug_log!("[Guardrail] gui.cpp was modified by guardrails — prompt produced incorrect output");
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
            eprintln!("[Handler] Deterministic validation failed: {}, falling back to hash scope", e);
            // Fallback to hash-based scope
            hash_based_rebuild_scope(&prev_hashes, &new_hashes)
        } else {
            let prev_core_h = if prev_hashes.core_hash != 0 { Some(format!("{}", prev_hashes.core_hash)) } else { None };
            let prev_gui_h = if prev_hashes.gui_hash != 0 { Some(format!("{}", prev_hashes.gui_hash)) } else { None };
            let prev_shared_h = if prev_hashes.shared_hash != 0 { Some(format!("{}", prev_hashes.shared_hash)) } else { None };
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
        tokio::fs::write(ctx.workspace_path.join(shared_fname), &processed_shared).await?;
    }

    // Compile Core
    let core_lib_path_opt = compile_core(
        ctx,
        &split_data,
        &processed_core,
        rebuild_scope.clone(),
        prev_core_path.clone(),
        &output_dir,
        timestamp,
        ext,
        Some(session_id.clone()),
    )
    .await?;

    let core_lib_path = core_lib_path_opt
        .ok_or_else(|| anyhow::anyhow!("Core compilation produced no output (no core module in split data or scope is GUI-only)"))?;

    // Compile GUI
    let gui_lib_path_opt = compile_gui(
        ctx,
        &split_data,
        &processed_gui,
        rebuild_scope.clone(),
        core_lib_path.clone(),
        &output_dir,
        timestamp,
        ext,
        Some(session_id.clone()),
        req.is_gui,
    )
    .await?;

    // If GUI is not requested or failed (but core succeeded), we might proceed with just core?
    // But `gui_lib_path_opt` returns existing path if not rebuilt.
    let gui_lib_path = gui_lib_path_opt.unwrap_or(prev_gui_path.unwrap_or_default());

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
        RebuildScope::Both | RebuildScope::FullReload => vec!["core".to_string(), "gui".to_string()],
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
        _ if prev_hashes.core_hash != 0 || prev_hashes.gui_hash != 0 => {
            Some(combined_hash(&[prev_hashes.core_hash, prev_hashes.gui_hash]))
        }
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
        if exported_symbols.iter().any(|s| s.contains("on_update") || s.contains("core_on_update")) {
            caps.push("hmr_state_update".to_string());
        }
        if exported_symbols.iter().any(|s| s.contains("hmr_get_state_json")) {
            caps.push("json_state".to_string());
        }
        if exported_symbols.iter().any(|s| s.contains("hmr_save_state_binary") || s.contains("on_save_state_binary")) {
            caps.push("binary_state".to_string());
        }
        if exported_symbols.iter().any(|s| s.contains("gui_on_render")) {
            caps.push("gui_render".to_string());
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

    let build_manifest = BuildManifest::for_language(
        session_id.clone(),
        language,
    )
    .with_slot(build_slot)
    .with_artifact(&manifest_artifact_path, &manifest_artifact_hash)
    .with_abi_version(&format!("{}", new_hashes.shared_hash))
    .with_state_schema_hash(&manifest_state_schema_hash)
    .with_build_time(build_time_ms)
    .with_dirty_units(dirty_units)
    .with_exported_symbols(exported_symbols)
    .with_capabilities(capabilities)
    .with_snapshot_modes(snapshot_modes);

    // Determine if ABI/schema changed from the previous build
    let abi_changed = prev_hashes.shared_hash != 0
        && prev_hashes.shared_hash != new_hashes.shared_hash;
    let schema_changed = prev_state_schema_hash
        .as_deref()
        .map(|previous| previous != build_manifest.state_schema_hash)
        .unwrap_or(false);

    // Check if the existing runner supports warm reload
    let runtime_supports_warm = {
        let guard = ctx.runner_store.lock().await;
        guard.as_ref().map(|s| s.is_hmr_capable).unwrap_or(false)
    };

    let (planner_output, planner_notification, reload_result, pipeline_messages) = {
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
        notifications.messages.extend(execute_notifications.messages);

        (planner_output, planner_notification, reload_result, notifications.messages)
    };

    // Send planner decision to the frontend
    if let Ok(planner_json) = serde_json::to_string(&planner_notification) {
        let _ = ctx.log_dc.send_text(planner_json).await;
    }
    debug_log!(
        "[HMR Planner] Decision: {:?} — {}",
        planner_output.decision, planner_output.reason.decision_reason
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
            AdapterReloadResult::Success { state_preserved, reload_ms },
        ) if !dynlib_family => {
            debug_log!(
                "[HMR] Process-swap reload completed authoritatively: state_preserved={}, reload_ms={}",
                state_preserved, reload_ms
            );
            true
        }
        (
            crate::hmr::planner_decision::ReloadDecision::ProcessSwap,
            AdapterReloadResult::Success { state_preserved, reload_ms },
        ) => {
            debug_log!(
                "[HMR] Dynlib adapter preflight reached a process-swap plan (state_preserved={}, reload_ms={}); delegating actual reload to runner",
                state_preserved, reload_ms
            );
            false
        }
        (decision, AdapterReloadResult::Success { state_preserved, reload_ms })
            if decision.is_in_process() && !dynlib_family =>
        {
            debug_log!(
                "[HMR] Adapter reload completed authoritatively: state_preserved={}, reload_ms={}",
                state_preserved, reload_ms
            );
            true
        }
        (decision, AdapterReloadResult::Success { state_preserved, reload_ms })
            if decision.is_in_process() && dynlib_family =>
        {
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

    let runtime_reload_start = std::time::Instant::now();
    let runner_result = handle_runner_execution(
        ctx,
        &req,
        modules_to_load,
        has_on_update,
        enrichment.use_ai_split,
        new_hashes,
        core_lib_path,
        gui_lib_path,
        Some(session_id.clone()),
    )
    .await;

    match runner_result {
        Ok(()) => {
            let candidate_messages = {
                let mut orchestrator = ctx.hmr_orchestrator.lock().await;
                orchestrator
                    .pipeline(&session_id)
                    .validate_active_candidate(runtime_reload_start.elapsed().as_millis() as u64)
                    .messages
            };
            for msg in candidate_messages {
                let _ = ctx.log_dc.send_text(msg).await;
            }
        }
        Err(error) => {
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
    if prev_hashes.shared_hash == 0
        && prev_hashes.core_hash == 0
        && prev_hashes.gui_hash == 0
    {
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
