use std::env;
use std::sync::Arc;
use tokio::sync::Mutex;
use anyhow::{Context, Result};
use chrono::Utc;
use serde_json::Value;

use crate::infra::messages::CompileRequest;
use crate::compiler::context::CompileContext;
use crate::compiler::builder::{
    hash_content, hash_shared_header_semantic, ModuleHashes, RebuildScope,
};
use crate::infra::observability::{ReloadId, LogEntry, LogLevel, ReloadMetricsTracker};
use crate::runtime::capability::detect_capabilities;

// Import our new modular stages
use crate::compiler::stages::ai_utils::perform_ai_split;
use crate::compiler::stages::guardrails::{
    apply_shared_guardrails, apply_core_guardrails, apply_gui_guardrails
};
use crate::compiler::stages::compile_core::compile_core;
use crate::compiler::stages::compile_gui::compile_gui;
use crate::compiler::stages::runner::handle_runner_execution;

pub async fn handle_compile_request(
    ctx: &CompileContext,
    req: CompileRequest,
    session_id: String,
) -> Result<serde_json::Value> {
    let compile_start = std::time::Instant::now();
    let timestamp = Utc::now().timestamp_millis();
    let app_id = format!("app_{}", timestamp);
    
    // Directory setup
    let output_dir = ctx.workspace_path.join("build");
    if !output_dir.exists() {
        tokio::fs::create_dir_all(&output_dir).await?;
    }
    
    // Platform detection (WSL/Linux compat)
    let is_wsl = {
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
    let tracker = ReloadMetricsTracker::start(reload_id, "compile_request".to_string());
    
    // Manual logging instead of record_step for now
    eprintln!("[Compile] Step: Handler started");

    // ============================================================
    // PHASE 1: AI SPLIT & PROCESSING
    // ============================================================
    
    // 1. Perform AI Split (with caching and structural updates)
    let split_data = if req.use_ai_split {
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
    let shared_raw = split_data.get("shared").and_then(|s| s["content"].as_str()).unwrap_or("");
    let core_raw = split_data.get("core").and_then(|c| c["content"].as_str()).unwrap_or("");
    let gui_raw = split_data.get("gui").and_then(|g| g["content"].as_str()).unwrap_or("");
    
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

    let rebuild_scope = if prev_hashes.shared_hash == 0 && prev_hashes.core_hash == 0 && prev_hashes.gui_hash == 0 {
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
    let _ = ctx.log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;

    // ============================================================
    // PHASE 3: COMPILATION
    // ============================================================
    
    // Manual logging
    eprintln!("[Compile] Step: Starting compilation");

    // Ensure shared header exists before compilation starts
    if rebuild_scope != RebuildScope::None {
        let shared_fname = split_data.get("shared")
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
        Some(session_id.clone())
    ).await?;
    
    let core_lib_path = core_lib_path_opt.ok_or_else(|| anyhow::anyhow!("Core compilation failed"))?;

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
        req.is_gui
    ).await?;
    
    // If GUI is not requested or failed (but core succeeded), we might proceed with just core?
    // But `gui_lib_path_opt` returns existing path if not rebuilt.
    let gui_lib_path = gui_lib_path_opt.unwrap_or(prev_gui_path.unwrap_or_default());
    
    // Manual logging
    eprintln!("[Compile] Step: Compilation finished");

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
                 if !gui_lib_path.is_empty() {
                     modules_to_load.push(("gui".to_string(), gui_lib_path.clone()));
                 }
             }
        },
        RebuildScope::CoreOnly => {
            if is_blocking_main_app {
                modules_to_load.push(("main".to_string(), core_lib_path.clone()));
            } else {
                modules_to_load.push(("core".to_string(), core_lib_path.clone()));
            }
            // Core reload often requires GUI storage reload, but logic depends on runner capabilities
            // Often we reload both to be safe unless we are strictly preserving state.
            // For now, let's just reload core.
        },
        RebuildScope::GuiOnly => {
            if !gui_lib_path.is_empty() {
                 modules_to_load.push(("gui".to_string(), gui_lib_path.clone()));
            }
        },
        RebuildScope::None => {
            // Nothing to load
        }
    }

    // Check for `on_update` to determine if we can HMR or need restart
    let has_on_update = processed_core.contains("on_update") || processed_core.contains("core_on_update");
    
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
        Some(session_id.clone())
    ).await?;

    Ok(serde_json::json!({ "status": "ok" }))
}
