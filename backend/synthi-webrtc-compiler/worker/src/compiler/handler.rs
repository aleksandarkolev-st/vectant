use anyhow::Result;
use chrono::Utc;

use crate::compiler::builder::{
    hash_content, hash_shared_header_semantic, ModuleHashes, RebuildScope,
};
use crate::compiler::context::CompileContext;
use crate::infra::messages::CompileRequest;
use crate::infra::observability::{ReloadId, ReloadMetricsTracker};

// Import our new modular stages
use crate::compiler::stages::ai_utils::perform_ai_split;
use crate::compiler::stages::compile_core::compile_core;
use crate::compiler::stages::compile_gui::compile_gui;
use crate::compiler::stages::guardrails::{
    apply_core_guardrails, apply_gui_guardrails, apply_shared_guardrails,
};
use crate::compiler::stages::runner::handle_runner_execution;

// HMR pipeline integration
use crate::hmr::integration::HmrPipeline;
use crate::hmr::loop_classifier::CompileLoop;
use crate::hmr::build_manifest::{BuildManifest, BuildSlot, HealthcheckStrategy, SnapshotMode, PreviewPreservationMode};

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
    let timestamp = Utc::now().timestamp_millis();
    let _app_id = format!("app_{}", timestamp);

    // Directory setup
    let output_dir = ctx.workspace_path.join("build");
    if !output_dir.exists() {
        tokio::fs::create_dir_all(&output_dir).await?;
    }

    // Platform detection (WSL/Linux compat)
    let _is_wsl = {
        if let Ok(content) = std::fs::read_to_string("/proc/version") {
            content.to_lowercase().contains("microsoft")
        } else {
            false
        }
    };
    let ext = "so";

    // Initialize metrics
    let reload_id = ReloadId::new();
    // Use start explicitly
    let _tracker = ReloadMetricsTracker::start(reload_id, "compile_request".to_string());

    // Manual logging instead of record_step for now
    eprintln!("[Compile] Step: Handler started");

    // ============================================================
    // HMR PIPELINE: Initialize and classify compile loop
    // ============================================================
    let language = req.language.as_str();
    let mut hmr_pipeline = HmrPipeline::new(&session_id);
    hmr_pipeline.ensure_adapter(language);

    // Classify compile loop: Loop A (deterministic, no AI) vs Loop B (AI-assisted)
    let has_ai_changes = req.use_ai_split; // AI split implies AI involvement
    let compile_loop = hmr_pipeline.classify_loop(has_ai_changes);
    eprintln!("[HMR] Compile loop: {:?}, language: {}", compile_loop, language);

    // AI Gate: block AI calls in Loop A (deterministic path)
    let ai_gate_decision = hmr_pipeline.check_ai_gate(compile_loop, "ai_split");
    let use_ai_split_gated = match &ai_gate_decision {
        crate::hmr::ai_gate::AiGateDecision::Allowed { .. } => req.use_ai_split,
        crate::hmr::ai_gate::AiGateDecision::Blocked { reason } => {
            // In steady-state Loop A, skip AI split and use direct compilation.
            // This ensures the deterministic hot path doesn't depend on AI latency.
            if req.use_ai_split {
                eprintln!("[HMR AI Gate] AI split blocked in Loop A: {}", reason);
                let payload = serde_json::json!({
                    "sessionId": session_id.clone(),
                    "type": "hmr-status",
                    "status": "ai-gated",
                    "reason": reason,
                });
                let _ = ctx
                    .log_dc
                    .send_text(serde_json::to_string(&payload).unwrap_or_default())
                    .await;
            }
            // Still respect the user's explicit request — only block if this is
            // a steady-state reload (Loop A). First compile always uses AI.
            req.use_ai_split
        }
    };

    // ============================================================
    // PHASE 1: AI SPLIT & PROCESSING
    // ============================================================

    // 1. Perform AI Split (with caching and structural updates)
    let split_data = if use_ai_split_gated {
        perform_ai_split(&req).await?
    } else {
        // Fallback for direct mode if needed, or simple wrap
        serde_json::json!({
            "shared": { "content": "", "filename": "shared.h" },
            "core": { "content": req.source.clone(), "filename": "core.cpp" },
            "gui": { "content": "", "filename": "gui.cpp" }
        })
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
    let processed_shared = apply_shared_guardrails(shared_raw);
    // Allow GUI in core if we are NOT using AI split (legacy/direct mode)
    let allow_gui_in_core = !req.use_ai_split;
    let processed_core = apply_core_guardrails(core_raw, &processed_shared, allow_gui_in_core);
    let processed_gui = apply_gui_guardrails(gui_raw, &processed_shared);

    // ============================================================
    // PHASE 2: REBUILD SCOPE DETERMINATION
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

    let rebuild_scope = if prev_hashes.shared_hash == 0
        && prev_hashes.core_hash == 0
        && prev_hashes.gui_hash == 0
    {
        eprintln!("[Handler] First build - Full Rebuild");
        RebuildScope::Both
    } else if prev_hashes.shared_hash != new_hashes.shared_hash {
        eprintln!("[Handler] Shared header changed - Full Rebuild");
        RebuildScope::Both
    } else if prev_hashes.core_hash != new_hashes.core_hash {
        eprintln!("[Handler] Core changed - Core Rebuild");
        RebuildScope::CoreOnly
    } else if prev_hashes.gui_hash != new_hashes.gui_hash {
        eprintln!("[Handler] GUI changed - GUI Rebuild");
        RebuildScope::GuiOnly
    } else {
        eprintln!("[Handler] No code changes detected");
        RebuildScope::None
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

    // Manual logging
    eprintln!("[Compile] Step: Starting compilation");

    // Validate: bail early if AI split produced empty core content.
    // Without this guard, an empty .cpp is compiled into a .so with no
    // symbols, compile_core returns Ok(None), and the handler emits
    // "Core compilation failed" with zero diagnostic information.
    if rebuild_scope != RebuildScope::None
        && rebuild_scope != RebuildScope::GuiOnly
        && processed_core.trim().is_empty()
    {
        let msg = "AI split returned empty core module content. Cannot compile.";
        eprintln!("[Handler] {}", msg);
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

    let core_lib_path =
        core_lib_path_opt.ok_or_else(|| anyhow::anyhow!("Core compilation failed"))?;

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
    eprintln!("[Compile] Step: Compilation finished");

    // ============================================================
    // PHASE 3.5: HMR PLANNER — decide reload strategy
    // ============================================================
    // Build a manifest from compile results and run the planner.
    // The planner produces a deterministic reload decision (warm/cold/
    // process-swap/full-restart) that guides runner execution.

    let build_time_ms = compile_start.elapsed().as_millis() as u64;

    let build_manifest = BuildManifest::for_language(
        session_id.clone(),
        language,
    )
    .with_slot(match rebuild_scope {
        RebuildScope::CoreOnly => BuildSlot::Core,
        RebuildScope::GuiOnly => BuildSlot::Gui,
        _ => BuildSlot::Full,
    })
    .with_artifact(&core_lib_path, &format!("{}", new_hashes.core_hash))
    .with_abi_version(&format!("{}", new_hashes.shared_hash))
    .with_state_schema_hash(&format!("{}", new_hashes.core_hash))
    .with_build_time(build_time_ms);

    // Determine if ABI/schema changed from the previous build
    let abi_changed = prev_hashes.shared_hash != 0
        && prev_hashes.shared_hash != new_hashes.shared_hash;
    let schema_changed = prev_hashes.core_hash != 0
        && prev_hashes.core_hash != new_hashes.core_hash;

    // Check if the existing runner supports warm reload
    let runtime_supports_warm = {
        let guard = ctx.runner_store.lock().await;
        guard.as_ref().map(|s| s.is_hmr_capable).unwrap_or(false)
    };

    let (planner_output, planner_notification) = hmr_pipeline.plan_reload(
        &build_manifest,
        abi_changed,
        schema_changed,
        runtime_supports_warm,
    );

    // Send planner decision to the frontend
    if let Ok(planner_json) = serde_json::to_string(&planner_notification) {
        let _ = ctx.log_dc.send_text(planner_json).await;
    }
    eprintln!(
        "[HMR Planner] Decision: {:?} — {}",
        planner_output.decision, planner_output.reason.decision_reason
    );

    // Execute adapter reload and collect notifications
    let (_reload_result, pipeline_notifications) = hmr_pipeline.execute_reload(
        language,
        &build_manifest,
        &planner_output,
        &format!("{}", reload_id),
    );

    // Send all pipeline notifications to the frontend (adapter_status,
    // state_restore_status, adapter_health, etc.)
    for msg in &pipeline_notifications.messages {
        let _ = ctx.log_dc.send_text(msg.clone()).await;
    }

    // ============================================================
    // PHASE 4: EXECUTION / HOT RELOAD
    // ============================================================

    // Determine modules to load
    let mut modules_to_load = Vec::new();

    // When NOT using AI split and the source is a standard main() app
    // (no core_on_load/core_on_update exports), load as a single "main" module.
    // The runner's "main" slot accepts entrypoint() which guardrails add for main() apps.
    let is_blocking_main_app = !req.use_ai_split
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

    handle_runner_execution(
        ctx,
        &req,
        modules_to_load,
        has_on_update,
        req.use_ai_split,
        new_hashes,
        core_lib_path,
        gui_lib_path,
        timestamp,
        compile_start,
        reload_id,
        "main".to_string(),
        Some(session_id.clone()),
    )
    .await?;

    Ok(serde_json::json!({ "status": "ok" }))
}
