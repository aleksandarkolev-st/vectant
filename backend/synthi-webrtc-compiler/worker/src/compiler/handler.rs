use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::env;
use std::hash::{Hash, Hasher};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::Bytes;
use chrono::Utc;
use futures::{FutureExt, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

use crate::android;
use crate::compiler::builder::{
    hash_content,
    hash_shared_header_semantic,
    ModuleHashes,
    RebuildScope,
    WidgetCompiler,
    WidgetDetector,
};

use crate::runtime::capability::{detect_capabilities, HmrCapability, HmrStatus};
use crate::compiler::error_parser::{parse_compiler_output, CompilerType, DiagnosticEvent};
use crate::hmr::fast_refresh::{BoundaryChecker, BoundaryViolationEvent, RefreshAction};
use crate::infra::observability::{StructuredLogger, LogFormat, LogLevel, LogEntry, MetricsAggregator, ReloadMetricsTracker, ReloadId};
use crate::safety::slot_isolation::{IsolationModel, IsolationManager};
use crate::safety::restart_control::{RestartController, BackoffConfig, KnownGoodStore};
use crate::safety::hardened_ipc::IpcConfig;
use crate::safety::quiescence::QuiescenceConfig;
use crate::infra::watcher::{PreemptiveConfig, PreemptiveMessage, SpeculativeCache};
use crate::runtime::shim::{auto_shim, ShimMode, detect_shim_mode};

#[allow(unused_imports)]
use crate::hmr::incremental_cache::{IncrementalCache, compile_with_cache, link_objects};
use gstreamer as gst;
use gstreamer::prelude::{Cast, ElementExt, GstBinExt, GstObjectExt};
use gstreamer_app as gst_app;

use tempfile::tempdir;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use webrtc::api::APIBuilder;
use webrtc::api::media_engine::MediaEngine;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::sdp_type::RTCSdpType;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp::packet::Packet;
use webrtc::rtp_transceiver::rtp_codec::{
    RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType,
};
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocal;
use webrtc::track::track_local::TrackLocalWriter;
use webrtc::util::Unmarshal;

use crate::compiler::context::CompileContext;
use crate::infra::constants::{GUI_TOOLS, REQUIRED_TOOLS};
use crate::infra::lsp_util::{LspSessionState, rewrite_uris};
use crate::infra::messages::{CompileRequest, FileEntry, IceServerEnv, SignalMessage};
use crate::runtime::runner_state::RunnerState;
use crate::hmr::orchestrator::HmrOrchestrator;
use crate::infra::utils::{make_chunks, get_wsl_host_ip, system_command};



pub async fn handle_compile(
    req: CompileRequest,
    log_dc: Arc<RTCDataChannel>,
    terminal_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>,
    sdl_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>,
    runner_store: Arc<Mutex<Option<RunnerState>>>,
    pc: Arc<RTCPeerConnection>,
    workspace_path: std::path::PathBuf,
    compile_cache: Arc<Mutex<HashMap<String, (u64, String)>>>,
    boundary_checker: Arc<Mutex<BoundaryChecker>>,
    incremental_cache: Arc<IncrementalCache>,
    // v2.1 HMR Infrastructure
    hmr_orchestrator: Arc<tokio::sync::Mutex<HmrOrchestrator>>,
    structured_logger: Arc<StructuredLogger>,
    metrics_aggregator: Arc<tokio::sync::Mutex<MetricsAggregator>>,
    restart_controller: Arc<tokio::sync::Mutex<RestartController>>,
    ipc_config: Arc<IpcConfig>,
) -> Result<()> {
    // ============================================================
    // v2.1 HMR METRICS & LOGGING INITIALIZATION
    // ============================================================
    let compile_start = std::time::Instant::now();
    let reload_id = ReloadId::new(); // Generate unique reload ID (from observability, re-exported from reload_protocol)
    
    structured_logger.log(&LogEntry::new(LogLevel::Info, "handle_compile", "Starting compile request")
        .with_reload_id(reload_id.clone())
        .with_field("is_gui", req.is_gui.to_string())
        .with_field("use_ai_split", req.use_ai_split.to_string())
        .with_field("language", req.language.clone()));
    
    // Module ID for tracking restarts and metrics
    let module_id = format!("{}:{}", req.language, if req.is_gui { "gui" } else { "cli" });
    
    // Log IPC config being used
    eprintln!("[HMR v2.1] Using IPC config: max_frame_size={}KB", ipc_config.max_frame_size / 1024);
    
    // Use the shared workspace path instead of creating a new temp dir
    let dir_path = workspace_path;

    // Check if we need to restart due to GUI mode change or blocking app
    // We do this early because we consume req.files later
    // If use_ai_split is true, we assume the AI will generate the necessary hooks (on_update, etc.)
    let source_has_hooks = req.source.contains("on_update")
        || req.source.contains("on_load")
        || req.source.contains("gui_on_update");
    let files_have_hooks = req.files.iter().any(|f| {
        f.content.contains("on_update")
            || f.content.contains("on_load")
            || f.content.contains("gui_on_update")
    });

    // Check if existing runner is already HMR-capable (from previous AI split)
    let existing_runner_is_hmr = {
        let mut guard = runner_store.lock().await;
        // Check if process is still alive before reusing
        let is_alive = if let Some(state) = guard.as_mut() {
            if let Some(child) = &mut state.process {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        eprintln!(
                            "[Main] Existing runner process has exited with status: {}",
                            status
                        );
                        false
                    }
                    Ok(None) => true, // Still running
                    Err(e) => {
                        eprintln!("[Main] Error checking runner process status: {}", e);
                        false
                    }
                }
            } else {
                false
            }
        } else {
            false
        };

        if !is_alive {
            *guard = None; // Clear dead runner
            false
        } else {
            guard.as_ref().map(|s| s.is_hmr_capable).unwrap_or(false)
        }
    };

    // CRITICAL FIX: If the existing runner is HMR-capable (meaning AI split was used before),
    // we should continue using AI split for consistency. This ensures that when a user:
    // 1. Runs with AI split → code gets transformed, runner is HMR-capable
    // 2. Makes a change and saves → AI split should happen again automatically
    //
    // Without this, subsequent saves would compile raw code (no hooks) and HMR would fail.
    let use_ai_split = req.use_ai_split || (existing_runner_is_hmr && req.is_gui);

    if use_ai_split != req.use_ai_split {
        eprintln!("[Main] Auto-enabling AI split (existing runner is HMR-capable)");
    }

    // HMR is possible if:
    // 1. use_ai_split is true (AI will generate hooks), OR
    // 2. Source code already has hooks (on_update, on_load), OR
    // 3. Files already have hooks
    let current_code_has_hooks = use_ai_split || source_has_hooks || files_have_hooks;
    let has_on_update = current_code_has_hooks;

    eprintln!("[Main] HMR detection: use_ai_split={} (req={}), source_has_hooks={}, files_have_hooks={}, existing_runner_is_hmr={}, has_on_update={}", 
        use_ai_split, req.use_ai_split, source_has_hooks, files_have_hooks, existing_runner_is_hmr, has_on_update);

    // Generate a unique filename for the shared library to support HMR
    let timestamp = Utc::now().timestamp_millis();
    let ext = if cfg!(target_os = "windows") {
        "dll"
    } else {
        "so"
    };

    // Phase 3: RAM-Based Compilation Pipeline
    // Use /dev/shm on Linux to avoid disk I/O
    let (output_dir, _is_shm) = if cfg!(target_os = "linux") {
        (std::path::PathBuf::from("/dev/shm"), true)
    } else {
        (dir_path.clone(), false)
    };

    let lib_filename = format!("libuser_code_{}.{}", timestamp, ext);
    let final_output_path = output_dir.join(&lib_filename);

    // Atomic swap: compile to temp file first
    let temp_filename = format!("temp_{}.{}", timestamp, ext);
    let temp_output_path = output_dir.join(&temp_filename);
    let temp_output_path_str = temp_output_path.to_string_lossy().to_string();

    // Clean up old shared libraries in output_dir
    if let Ok(mut entries) = tokio::fs::read_dir(&output_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if (name.starts_with("libuser_code_")
                    || name.starts_with("temp_")
                    || name.starts_with("libcore_")
                    || name.starts_with("libgui_"))
                    && (name.ends_with(".so") || name.ends_with(".dll"))
                {
                    let _ = tokio::fs::remove_file(path).await;
                }
            }
        }
    }

    // Write the main file
    let file_path = dir_path.join(&req.filename);
    // Clone session id locally so we can move it into spawned tasks without
    // invalidating the `req` value for later use.
    let session_id = req.session_id.clone();
    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let mut source_code = req.source.clone();
    if req.language == "rust" {
        // Check if user already defined entrypoint to avoid conflict
        if !source_code.contains("extern \"C\" fn entrypoint") {
            source_code.push_str("\n\n#[no_mangle]\npub extern \"C\" fn entrypoint(_state: *mut std::ffi::c_void) -> *mut std::ffi::c_void {\n    main();\n    std::ptr::null_mut()\n}\n");
        }
    } else if (req.language == "cpp" || req.language == "cpp_legacy") && use_ai_split {
        if !source_code.contains("extern \"C\" void* entrypoint") {
            source_code.push_str(
                "\n\nextern \"C\" void* entrypoint(void* state) {\n    main();\n    return 0;\n}\n",
            );
        }
    }
    tokio::fs::write(&file_path, &source_code).await?;
    println!("Main file written to {:?}", file_path);

    // Write additional files
    for file in &req.files {
        println!("Writing additional file: {}", file.name);
        let p = dir_path.join(&file.name);
        // Ensure parent directories exist if the file is in a subdirectory
        if let Some(parent) = p.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&p, &file.content).await?;
    }

    let mut modules_to_load: Vec<(String, String)> = Vec::new();

    // Define these at outer scope so they can be used after the if/else branches
    let mut new_hashes = ModuleHashes::new();
    let mut core_lib_path = String::new();
    let mut gui_lib_path = String::new();

    if use_ai_split {
        let split_data = match perform_ai_split(&req).await {
            Ok(d) => d,
            Err(e) => {
                let payload = serde_json::json!({
                    "sessionId": session_id.clone(),
                    "status": "done",
                    "success": false,
                    "stage": "ai_split",
                    "error": format!("AI Split failed: {}", e)
                });
                let _ = log_dc
                    .send_text(serde_json::to_string(&payload).unwrap_or_default())
                    .await;
                return Ok(());
            }
        };

        // DEBUG: Save generated code to a debug folder
        let debug_dir = dir_path
            .join("debug_ai_generated")
            .join(format!("{}", timestamp));
        println!("Saving AI generated code to debug dir: {:?}", debug_dir);
        if let Err(e) = tokio::fs::create_dir_all(&debug_dir).await {
            println!("Failed to create debug dir: {}", e);
        } else {
            if let Some(shared) = split_data.get("shared") {
                let fname = shared["filename"].as_str().unwrap_or("shared.h");
                let content = shared["content"].as_str().unwrap_or("");
                let _ = tokio::fs::write(debug_dir.join(fname), content).await;
            }
            if let Some(core) = split_data.get("core") {
                let fname = core["filename"].as_str().unwrap_or("core.cpp");
                let content = core["content"].as_str().unwrap_or("");
                let _ = tokio::fs::write(debug_dir.join(fname), content).await;
            }
            if let Some(gui) = split_data.get("gui") {
                let fname = gui["filename"].as_str().unwrap_or("gui.cpp");
                let content = gui["content"].as_str().unwrap_or("");
                let _ = tokio::fs::write(debug_dir.join(fname), content).await;
            }
            println!("Saved AI generated code to {:?}", debug_dir);

            // Notify frontend
            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "stderr",
                "line": format!("AI Generated code saved to: {:?}\n", debug_dir)
            });
            let _ = log_dc
                .send_text(serde_json::to_string(&payload).unwrap_or_default())
                .await;
        }

        // ============================================================
        // PHASE 1: APPLY GUARDRAILS TO ALL CONTENT FIRST
        // ============================================================
        // Use the outer-scope new_hashes variable
        if let Some(shared) = split_data.get("shared") {
            let content = shared["content"].as_str().unwrap_or("");
            new_hashes.shared_hash = hash_content(content);
        }
        if let Some(core) = split_data.get("core") {
            let content = core["content"].as_str().unwrap_or("");
            new_hashes.core_hash = hash_content(content);
        }
        if let Some(gui) = split_data.get("gui") {
            let content = gui["content"].as_str().unwrap_or("");
            new_hashes.gui_hash = hash_content(content);
        }

        // This ensures hashes are computed from post-guardrail content,
        // so the rebuild scope decision is based on what actually gets compiled.
        
        // Extract raw content from AI split
        let shared_raw = split_data.get("shared")
            .and_then(|s| s["content"].as_str())
            .unwrap_or("")
            .to_string();
        let core_raw = split_data.get("core")
            .and_then(|s| s["content"].as_str())
            .unwrap_or("")
            .to_string();
        let gui_raw = split_data.get("gui")
            .and_then(|s| s["content"].as_str())
            .unwrap_or("")
            .to_string();
        
        // Apply guardrails to shared.h
        let processed_shared = apply_shared_guardrails(&shared_raw);
        
        // Apply guardrails to core.cpp (needs shared content for context)
        let processed_core = apply_core_guardrails(&core_raw, &processed_shared);
        
        // Apply guardrails to gui.cpp (needs shared content for context)
        let processed_gui = apply_gui_guardrails(&gui_raw, &processed_shared);
        
        // ============================================================
        // PHASE 2: COMPUTE HASHES FROM POST-GUARDRAIL CONTENT
        // ============================================================
        // Use semantic hashing for shared.h so comment/whitespace churn doesn't force full rebuilds.
        new_hashes.shared_hash = hash_shared_header_semantic(&processed_shared);
        new_hashes.core_hash = hash_content(&processed_core);
        new_hashes.gui_hash = hash_content(&processed_gui);
        
        // Get previous hashes from runner state (if exists)
        let (prev_hashes, prev_core_path, _prev_gui_path) = {
            let guard = runner_store.lock().await;
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

        // Determine rebuild scope
        // DEBUG: Print hashes to help diagnose "Full build" issues
        eprintln!(
            "[Main] Hashes - Prev: s={}, c={}, g={}",
            prev_hashes.shared_hash, prev_hashes.core_hash, prev_hashes.gui_hash
        );
        eprintln!(
            "[Main] Hashes - New:  s={}, c={}, g={}",
            new_hashes.shared_hash, new_hashes.core_hash, new_hashes.gui_hash
        );

        let rebuild_scope = if prev_hashes.shared_hash == 0
            && prev_hashes.core_hash == 0
            && prev_hashes.gui_hash == 0
        {
        
        // ============================================================
        // PHASE 3: DETERMINE REBUILD SCOPE FROM POST-GUARDRAIL HASHES
        // ============================================================
        // DEBUG: Print hashes to help diagnose "Full build" issues
        eprintln!("[Main] Hashes (post-guardrail) - Prev: s={}, c={}, g={}", prev_hashes.shared_hash, prev_hashes.core_hash, prev_hashes.gui_hash);
        eprintln!("[Main] Hashes (post-guardrail) - New:  s={}, c={}, g={}", new_hashes.shared_hash, new_hashes.core_hash, new_hashes.gui_hash);

        // Enhanced debug: show which hashes changed
        if prev_hashes.shared_hash != 0 && prev_hashes.shared_hash != new_hashes.shared_hash {
            eprintln!("[Main] DEBUG: shared.h hash CHANGED - check for field order changes or AI rewriting struct fields");
        }
        if prev_hashes.core_hash != 0 && prev_hashes.core_hash != new_hashes.core_hash {
            eprintln!("[Main] DEBUG: core.cpp hash changed");
        }
        if prev_hashes.gui_hash != 0 && prev_hashes.gui_hash != new_hashes.gui_hash {
            eprintln!("[Main] DEBUG: gui.cpp hash changed");
        }

        let rebuild_scope = if prev_hashes.shared_hash == 0 && prev_hashes.core_hash == 0 && prev_hashes.gui_hash == 0 {
            eprintln!("[Main] First build detected - full build");
            RebuildScope::Both
        } else if prev_hashes.shared_hash != new_hashes.shared_hash {
            eprintln!("[Main] Shared header changed - full rebuild needed");
            RebuildScope::Both
        } else if prev_hashes.core_hash != new_hashes.core_hash {
            eprintln!("[Main] Core changed - rebuild core (GUI will reload with new CoreAPI)");
            RebuildScope::CoreOnly // Core change affects GUI's CoreAPI reference
        } else if prev_hashes.gui_hash != new_hashes.gui_hash {
            eprintln!("[Main] GUI-only change detected - rebuilding GUI only!");
            RebuildScope::GuiOnly
        } else {
            eprintln!("[Main] No changes detected in generated code - skipping build");
            RebuildScope::None
        };

        // Notify frontend of rebuild scope
        let scope_msg = match rebuild_scope {
            RebuildScope::GuiOnly => "GUI-only rebuild (core state preserved)",
            RebuildScope::CoreOnly => "Core rebuild (GUI will reload)",
            RebuildScope::Both => "Full rebuild",
            RebuildScope::FullReload => "Full reload required",
            RebuildScope::None => "No changes",
        };
        let payload = serde_json::json!({
            "sessionId": session_id.clone(),
            "type": "stderr",
            "line": format!("[HMR] {}\n", scope_msg)
        });
        let _ = log_dc
            .send_text(serde_json::to_string(&payload).unwrap_or_default())
            .await;

        // ============================================================
        // POST-AI VALIDATION: Check required exports exist in generated code
        // ============================================================
        let mut validation_errors: Vec<String> = Vec::new();
        let mut validation_warnings: Vec<String> = Vec::new();

        // Validate core.cpp required exports
        if let Some(core) = split_data.get("core") {
            let content = core["content"].as_str().unwrap_or("");

            // Required core exports (check for both new and legacy symbol names)
            // Support both inline: `extern "C" void* on_load(...)`
            // and block: `extern "C" { ... void* on_load(...) ... }`
            let has_extern_c_block = content.contains("extern \"C\" {");
            let has_on_load_fn =
                content.contains("void* core_on_load") || content.contains("void* on_load");
            let has_on_update_fn =
                content.contains("void core_on_update") || content.contains("void on_update");
            let has_inline_on_load = content.contains("extern \"C\" void* core_on_load")
                || content.contains("extern \"C\" void* on_load");
            let has_inline_on_update = content.contains("extern \"C\" void core_on_update")
                || content.contains("extern \"C\" void on_update");
            let has_on_load = has_inline_on_load || (has_extern_c_block && has_on_load_fn);
            let has_on_update = has_inline_on_update || (has_extern_c_block && has_on_update_fn);

            if !has_on_load {
                validation_errors
                    .push("core.cpp missing required export: on_load or core_on_load".to_string());
            }
            if !has_on_update {
                validation_warnings.push(
                    "core.cpp missing on_update/core_on_update - app will be blocking".to_string(),
                );
            }

            // Check for ABI version constant (check in core.cpp content and shared.h)
            let shared_content = split_data
                .get("shared")
                .and_then(|s| s["content"].as_str())
                .unwrap_or("");
            let has_abi_version = content.contains("SYNTHI_CORE_ABI_VERSION")
                || content.contains("abi_version")
                || shared_content.contains("abi_version");
            if !has_abi_version {
                validation_warnings
                    .push("core.cpp should define abi_version field in state struct".to_string());
            }

            let has_abi_version = content.contains("SYNTHI_CORE_ABI_VERSION") || 
                                  content.contains("abi_version") ||
                                  shared_content.contains("abi_version");
            if !has_abi_version {
                validation_warnings.push("core.cpp should define abi_version field in state struct".to_string());
            }
            
            // Dangerous patterns: GUI code modifying CoreState directly
            if content.contains("GuiState") && content.contains("CoreState") {
                // This is allowed - core might reference GUI types for callbacks
            }
        }

        // Validate gui.cpp required exports
        if let Some(gui) = split_data.get("gui") {
            let content = gui["content"].as_str().unwrap_or("");

            // Required GUI exports (check for both new and legacy symbol names)
            // Support both inline: `extern "C" void gui_render(...)`
            // and block: `extern "C" { ... void gui_render(...) ... }`
            let has_extern_c_block = content.contains("extern \"C\" {");
            let has_gui_render_fn =
                content.contains("void gui_on_render") || content.contains("void gui_render");
            let has_inline_extern = content.contains("extern \"C\" void gui_on_render")
                || content.contains("extern \"C\" void gui_render");
            let has_gui_render = has_inline_extern || (has_extern_c_block && has_gui_render_fn);

            if !has_gui_render {
                validation_errors.push(
                    "gui.cpp missing required export: gui_render or gui_on_render".to_string(),
                );
            }

            // Warning: GUI should not modify CoreState directly (HMR safety)
            if content.contains("CoreState*") && content.contains("->") {
                // Check if it's writing to CoreState (not just reading)
                if content.contains("core_state->")
                    && (content.contains("= ") || content.contains("++") || content.contains("--"))
                {
        
        // Validate gui.cpp required exports
        if let Some(gui) = split_data.get("gui") {
            let content = gui["content"].as_str().unwrap_or("");
            
            // Required GUI exports (check for both new and legacy symbol names)
            // Support both inline: `extern "C" void gui_render(...)` 
            // and block: `extern "C" { ... void gui_render(...) ... }`
            let has_extern_c_block = content.contains("extern \"C\" {");
            let has_gui_render_fn = content.contains("void gui_on_render") || content.contains("void gui_render");
            let has_inline_extern = content.contains("extern \"C\" void gui_on_render") ||
                                    content.contains("extern \"C\" void gui_render");
            let has_gui_render = has_inline_extern || (has_extern_c_block && has_gui_render_fn);
            
            if !has_gui_render {
                validation_errors.push("gui.cpp missing required export: gui_render or gui_on_render".to_string());
            }
            
            // Warning: GUI should not modify CoreState directly (HMR safety)
            if content.contains("CoreState*") && content.contains("->") {
                // Check if it's writing to CoreState (not just reading)
                if content.contains("core_state->") && 
                   (content.contains("= ") || content.contains("++") || content.contains("--")) {
                    validation_warnings.push("gui.cpp may be modifying CoreState - HMR state preservation may be affected".to_string());
                }
            }
        }

        
        // Report validation results
        if !validation_warnings.is_empty() {
            for warning in &validation_warnings {
                let payload = serde_json::json!({
                    "sessionId": session_id.clone(),
                    "type": "stderr",
                    "line": format!("[Validation Warning] {}\n", warning)
                });
                let _ = log_dc
                    .send_text(serde_json::to_string(&payload).unwrap_or_default())
                    .await;
            }
        }

                let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
            }
        }
        
        if !validation_errors.is_empty() {
            // Send all errors to frontend
            for error in &validation_errors {
                let payload = serde_json::json!({
                    "sessionId": session_id.clone(),
                    "type": "stderr",
                    "line": format!("[Validation Error] {}\n", error)
                });
                let _ = log_dc
                    .send_text(serde_json::to_string(&payload).unwrap_or_default())
                    .await;
            }

                let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
            }
            
            // Don't fail completely - continue with compilation but warn
            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "stderr",
                "line": "[Validation] Continuing with compilation despite validation issues...\n"
            });
            let _ = log_dc
                .send_text(serde_json::to_string(&payload).unwrap_or_default())
                .await;
        }

        // Reuse previous paths if not rebuilding that module
        if rebuild_scope == RebuildScope::GuiOnly {
            if let Some(ref path) = prev_core_path {
                core_lib_path = path.clone();
                eprintln!("[Main] Reusing existing core library: {}", core_lib_path);
            }
        }

        if let Some(shared) = split_data.get("shared") {
            let fname = shared["filename"].as_str().unwrap_or("shared.h");
            let mut content = shared["content"].as_str().unwrap_or("").to_string();

            // Guardrails: AI sometimes typedefs X11 types to void, which conflicts with Xlib headers.
            for bad in [
                "typedef void Display",
                "typedef void GC",
                "typedef void Atom",
                "typedef void XIM",
                "typedef void XIC",
            ] {
                if content.contains(bad) {
                    content = content.replace(bad, "// stripped invalid typedef\n");
                }
            }

            // Strip conflicting forward declarations of X11 types and normalize struct field types.
            for bad in [
                "struct Display;",
                "struct Window;",
                "struct Atom;",
                "struct XIM;",
                "struct XIC;",
                "struct Pixmap;",
                "struct GC;",
                "struct XWindowAttributes;",
            ] {
                if content.contains(bad) {
                    content = content.replace(bad, "// stripped conflicting X11 forward decl\n");
                }
            }
            content = content.replace("struct Display*", "Display*");
            content = content.replace("struct Window", "Window");
            content = content.replace("struct Atom", "Atom");
            content = content.replace("struct XIM*", "XIM*");
            content = content.replace("struct XIC*", "XIC*");
            content = content.replace("struct Pixmap", "Pixmap");
            content = content.replace("struct GC", "GC");
            content = content.replace("struct XWindowAttributes", "XWindowAttributes");

            // Guardrail: SDL_Event is a union in SDL2. Forward-declaring it as a struct
            // (e.g. `struct SDL_Event;`) causes compile failures when SDL.h is included.
            for bad in [
                "struct SDL_Event;",
                "typedef struct SDL_Event SDL_Event;",
                "typedef struct SDL_Event SDL_Event ;",
            ] {
                if content.contains(bad) {
                    content = content.replace(bad, "/* stripped invalid SDL_Event forward decl */");
                }
            }

            // FIX: gui_on_load declaration MUST have 3 parameters to match implementation
            if content.contains("gui_on_load(void* prev_state, void* window_ptr)")
                && !content
                    .contains("gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)")
            {
                content = content.replace(
                    "gui_on_load(void* prev_state, void* window_ptr)",
                    "gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)",
                );
                eprintln!("[Guardrail] Fixed gui_on_load declaration in shared.h: added missing core_api_ptr parameter");
            }

            println!("Writing shared library file: {}", fname);
            tokio::fs::write(dir_path.join(fname), content).await?;
        }

        let core_future = async {
            // Skip core compilation if GUI-only rebuild (reuse existing core.so)
            if rebuild_scope == RebuildScope::Both || rebuild_scope == RebuildScope::CoreOnly {
                if split_data.get("core").is_some() {
                    let fname = split_data.get("core")
                        .and_then(|s| s["filename"].as_str())
                        .unwrap_or("core.cpp");
                    
                    // Use the already-processed content from Phase 1 (guardrails already applied)
                    let content = processed_core.clone();

                    let content_hash = calculate_hash(&content);
                    
                    // Try content-addressable cache first (persists across sessions)
                    let cache_key = IncrementalCache::cache_key(&content, &["-shared", "-fPIC"], &[]);
                    if let Some(cached_so) = incremental_cache.get(&cache_key).await {
                        let path = cached_so.to_string_lossy().to_string();
                        eprintln!("[Cache] HIT for core module (persistent cache)");
                        println!("Using cached core library: {}", path);
                        return Ok::<_, anyhow::Error>(Some(path));
                    } else {
                        // Cache miss - need to compile
                        tokio::fs::write(dir_path.join(fname), &content).await?;
                        
                        let core_out = output_dir.join(format!("libcore_{}.{}", timestamp, ext));
                        let mut cmd = system_command("g++");
                        cmd.arg("-shared").arg("-fPIC")
                           .arg("-D_POSIX_C_SOURCE=199309L")
                           .arg("-g").arg("-gdwarf-4").arg("-fno-omit-frame-pointer")
                           .arg("-fdiagnostics-format=json")
                           .arg(fname).arg("-I.").arg("-o").arg(&core_out)
                           .arg("-ldl")
                           .arg("-rdynamic");
                        cmd.current_dir(&dir_path);
                        
                        let output = cmd.output().await?;
                        if !output.status.success() {
                             let stderr = String::from_utf8_lossy(&output.stderr);
                             eprintln!("Core compilation failed: {}", stderr);
                             
                             let payload = serde_json::json!({
                                "sessionId": session_id.clone(),
                                "status": "done",
                                "success": false,
                                "stage": "compile_core",
                                "error": stderr
                            });
                            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                            return Ok(None);
                        }
                        
                        let path = core_out.to_string_lossy().to_string();
                        
                        // Update cache
                        if let Ok(so_data) = tokio::fs::read(&path).await {
                            let source_hash = content_hash;
                            let flags_hash = calculate_hash(&"-shared-fPIC");
                            let headers_hash = 0u64;
                            let _ = incremental_cache.put(cache_key.clone(), source_hash, flags_hash, headers_hash, &so_data).await;
                        }
                        
                        let mut cache = compile_cache.lock().await;
                        cache.insert("core".to_string(), (content_hash, path.clone()));
                        return Ok::<_, anyhow::Error>(Some(path));
        // Skip core compilation if GUI-only rebuild (reuse existing core.so)
        if rebuild_scope == RebuildScope::Both || rebuild_scope == RebuildScope::CoreOnly {
            if let Some(core) = split_data.get("core") {
                let fname = core["filename"].as_str().unwrap_or("core.cpp");
                let mut content = core["content"].as_str().unwrap_or("").to_string();

                // Read shared.h content to check what's defined there
                let shared_content = split_data
                    .get("shared")
                    .and_then(|s| s["content"].as_str())
                    .unwrap_or("");

                // Detect if shared.h has full struct definitions or just forward declarations
                let shared_has_full_hostkv = shared_content.contains("struct HostKvApiV1 {")
                    || shared_content.contains("struct SynthiHostContextV1 {")
                    || shared_content.contains("struct SynthiNamespaceSchemaV1 {");

                // Fix common AI mistakes in core.cpp before compilation.
                if content.contains("is_running") {
                    content = content.replace("is_running", "running");
                }

                // CRITICAL: Strip X11-related functions that the AI incorrectly preserved from the input.
                // The AI sometimes keeps functions like `Display* initialize_display()` or `void cleanup_display(Display* d)`
                // which reference X11 types that don't exist in our SDL2-only environment.
                // We strip entire lines containing these patterns.
                let x11_type_patterns = [
                    "Display*",     // X11 display type
                    "Display *",    // with space
                    "Window*",      // X11 window type (not to be confused with SDL)
                    "XIM",          // X11 input method
                    "XIC",          // X11 input context
                    "Atom",         // X11 atom type
                    "Colormap",     // X11 colormap
                    "Pixmap",       // X11 pixmap
                    "GC ",          // X11 graphics context (with space to avoid "GCC")
                    "XEvent",       // X11 event type
                    "XOpenDisplay", // X11 function calls
                    "XCloseDisplay",
                    "XCreateWindow",
                    "XDestroyWindow",
                    "XOpenIM",
                    "XCreateIC",
                    "XCreateGC",
                    "XFreeGC",
                    "XCreatePixmap",
                    "XFreePixmap",
                ];

                // Strip lines with X11 function declarations/definitions
                let mut cleaned_lines = Vec::new();
                for line in content.lines() {
                    let has_x11 = x11_type_patterns.iter().any(|pat| line.contains(pat));
                    // Don't strip lines that are inside comment blocks or are includes (already handled)
                    let is_comment =
                        line.trim_start().starts_with("//") || line.trim_start().starts_with("/*");
                    let is_include = line.trim_start().starts_with("#include");

                    if has_x11 && !is_comment && !is_include {
                        cleaned_lines.push(format!("// [X11-stripped] {}", line));
                    } else {
                        cleaned_lines.push(line.to_string());
                    }
                }
                content = cleaned_lines.join("\n");

                // CRITICAL: Ensure shared.h is included FIRST
                if !content.contains("#include \"shared.h\"") {
                    // Add shared.h include at the top, after any standard includes
                    if let Some(pos) = content.find("#include <") {
                        // Find end of first include line
                        if let Some(newline) = content[pos..].find('\n') {
                            let insert_pos = pos + newline + 1;
                            content.insert_str(
                                insert_pos,
                                "#include \"shared.h\"  // [Guardrail] Added\n",
                            );
                            eprintln!("[Guardrail] Added #include \"shared.h\" to core.cpp");
                        }
                    } else {
                        content =
                            format!("#include \"shared.h\"  // [Guardrail] Added\n{}", content);
                        eprintln!("[Guardrail] Added #include \"shared.h\" to core.cpp");
                    }
                }

        let gui_future = async {
            // Parallel GUI compilation disabled due to dependency on core_lib_path and widget logic
            // falling back to sequential compilation below
            Ok::<Option<String>, anyhow::Error>(None)
        };
                // CRITICAL FIX: Transform malloc-based on_load to static storage
                if content.contains("malloc(sizeof(AppState))") && content.contains("on_load") {
                    eprintln!("[Guardrail] Detected malloc(sizeof(AppState)) pattern in core.cpp");
                    eprintln!(
                        "[Guardrail] CONVERTING malloc to static storage pattern for reliable HMR"
                    );

                    // AGGRESSIVE FIX: Convert malloc-based state to static storage
                    // This ensures HMR works reliably by avoiding dynamic allocation entirely

                    // If we see the common malloc pattern, inject a static variable and fix on_load
                    if !content.contains("static AppState app_state")
                        && !content.contains("static CoreState core_state")
                    {
                        // Find where on_load is defined and inject static variable before it
                        if let Some(on_load_pos) = content.find("extern \"C\" void* on_load") {
                            content.insert_str(on_load_pos, "// [Guardrail] Injected static storage for HMR\nstatic AppState app_state = {0};\n\n");
                            eprintln!("[Guardrail] Injected static AppState storage");
                        } else if let Some(on_load_pos) =
                            content.find("extern \"C\" void* core_on_load")
                        {
                            content.insert_str(on_load_pos, "// [Guardrail] Injected static storage for HMR\nstatic AppState app_state = {0};\n\n");
                            eprintln!("[Guardrail] Injected static AppState storage");
                        }
                    }

                    // Replace malloc pattern with static storage usage
                    // Pattern: AppState* state = (AppState*)malloc(sizeof(AppState));
                    // Becomes: AppState* state = (prev_state) ? (AppState*)prev_state : &app_state;
                    use regex::Regex;
                    let re_malloc = Regex::new(r"AppState\*\s+state\s*=\s*\(AppState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*AppState\s*\)\s*\)\s*;").unwrap();
                    content = re_malloc.replace_all(&content, "AppState* state = (prev_state) ? (AppState*)prev_state : &app_state; // [Guardrail] Fixed malloc->static").to_string();

                    let re_malloc2 = Regex::new(r"CoreState\*\s+state\s*=\s*\(CoreState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*CoreState\s*\)\s*\)\s*;").unwrap();
                    content = re_malloc2.replace_all(&content, "CoreState* state = (prev_state) ? (CoreState*)prev_state : &core_state; // [Guardrail] Fixed malloc->static").to_string();

                    // Also fix patterns inside if blocks
                    let re_if_malloc = Regex::new(r"if\s*\(\s*!prev_state\s*\)\s*\{\s*state\s*=\s*\(AppState\*\)\s*malloc[^}]+\}").unwrap();
                    content = re_if_malloc.replace_all(&content, "if (!prev_state) { state = &app_state; /* [Guardrail] Fixed malloc->static */ }").to_string();

                    eprintln!("[Guardrail] Converted malloc patterns to static storage");
                }

                // FIX: Detect and warn about free(state) which causes crashes on reload
                if content.contains("free(state)") {
                    eprintln!("[Guardrail] WARNING: Detected free(state) in core.cpp");
                    eprintln!("[Guardrail] This will cause crashes on hot reload - runner manages state lifecycle");
                    // Comment out free(state) calls
                    content = content.replace(
                        "free(state);",
                        "// free(state); // Commented - runner manages state",
                    );
                }

                // FIX: Detect and warn about memset on state which wipes preserved HMR state
                if content.contains("memset(state")
                    || content.contains("memset(&app_state")
                    || content.contains("memset(&state")
                    || content.contains("memset(&core_state")
                    || content.contains("memset( state")
                {
                    eprintln!("[Guardrail] WARNING: Detected memset on state in core.cpp");
                    eprintln!("[Guardrail] memset wipes preserved state from prev_state - this breaks HMR!");

                    // Aggressive stripping of memset - catch ALL variations
                    use regex::Regex;
                    let re_memset = Regex::new(r"memset\s*\(\s*(state|&app_state|&core_state|&state|&gui_app_state)[^;]*\)\s*;").unwrap();
                    content = re_memset
                        .replace_all(
                            &content,
                            "// [Guardrail] memset REMOVED to preserve HMR state",
                        )
                        .to_string();
                }

                // Drop writes/reads to non-existent XWindowAttributes fields that break the build.
                for bad_field in [
                    "event_mask",
                    "damage",
                    "border_pixel",
                    "background_pixel",
                    "saved_attributes",
                    "attributes_mask",
                ] {
                    if content.contains(bad_field) {
                        let mut cleaned = String::new();
                        for line in content.lines() {
                            if line.contains(bad_field) {
                                // comment out the entire line to keep line numbers roughly stable
                                cleaned.push_str("// stripped invalid field: ");
                                cleaned.push_str(line);
                                cleaned.push('\n');
                            } else {
                                cleaned.push_str(line);
                                cleaned.push('\n');
                            }
                        }
                        content = cleaned;
                    }
                }

                // INJECT MISSING HEADERS
                if content.contains("setlocale") && !content.contains("#include <locale.h>") {
                    content = format!("#include <locale.h>\n{}", content);
                }
                if content.contains("SDL_") && !content.contains("#include <SDL2/SDL.h>") {
                    content = format!("#include <SDL2/SDL.h>\n{}", content);
                }
                if (content.contains("XLookupString") || content.contains("XK_Escape"))
                    && !content.contains("#include <X11/Xutil.h>")
                {
                    content = format!(
                        "#include <X11/Xutil.h>\n#include <X11/keysym.h>\n{}",
                        content
                    );
                }
                if (content.contains("dlopen") || content.contains("dlsym"))
                    && !content.contains("#include <dlfcn.h>")
                {
                    content = format!("#include <dlfcn.h>\n{}", content);
                }

                // FIX: Ensure shared.h is included in core.cpp if AppState is used
                // The AI often forward declares AppState but then tries to instantiate it, causing incomplete type errors.
                if content.contains("AppState") && !content.contains("#include \"shared.h\"") {
                    if content.contains("struct AppState;") {
                        content = content.replace("struct AppState;", "#include \"shared.h\"");
                    } else {
                        content = format!("#include \"shared.h\"\n{}", content);
                    }
                }

                // FIX: Remove duplicate defines that are already in shared.h to prevent warnings
                if content.contains("#include \"shared.h\"") {
                    content =
                        content.replace("#define CORE_STATE_MAGIC", "// #define CORE_STATE_MAGIC");
                    content = content.replace(
                        "#define SYNTHI_ABI_VERSION",
                        "// #define SYNTHI_ABI_VERSION",
                    );

                    // CRITICAL FIX: Strip duplicate AppState struct/typedef from core.cpp
                    // The AI often duplicates the AppState definition from shared.h in core.cpp,
                    // causing "conflicting declaration" or "redefinition" errors.
                    // We use regex-like patterns to remove the entire struct block.

                    // Pattern 1: typedef struct AppState { ... } AppState;
                    if let Some(start) = content.find("typedef struct AppState") {
                        if let Some(end) = content[start..].find("} AppState;") {
                            let block_end = start + end + "} AppState;".len();
                            let block = &content[start..block_end];
                            eprintln!("[Guardrail] Stripping duplicate 'typedef struct AppState' from core.cpp (defined in shared.h)");
                            content = content.replace(block, "// AppState defined in shared.h");
                        }
                    }

                    // Pattern 1b: typedef struct { ... } AppState; (Anonymous struct typedef)
                    if let Some(start) = content.find("typedef struct {") {
                        if let Some(end) = content[start..].find("} AppState;") {
                            let block_end = start + end + "} AppState;".len();
                            let block = &content[start..block_end];
                            if block.contains("magic") && block.contains("struct_size") {
                                eprintln!("[Guardrail] Stripping duplicate 'typedef struct {{ ... }} AppState' from core.cpp");
                                content = content.replace(block, "// AppState defined in shared.h");
                            }
                        }
                    }

                    // Pattern 2: struct AppState { ... };
                    if let Some(start) = content.find("struct AppState {") {
                        if let Some(end) = content[start..].find("};") {
                            let block_end = start + end + "};".len();
                            let block = &content[start..block_end];
                            // Don't strip if this looks like a forward decl only
                            if block.contains("{") {
                                eprintln!("[Guardrail] Stripping duplicate 'struct AppState' definition from core.cpp (defined in shared.h)");
                                content = content.replace(block, "// AppState defined in shared.h");
                            }
                        }
                    }

                    // Pattern 3: Host KV structs (HostKvApiV1, SynthiHostContextV1, SynthiNamespaceSchemaV1)
                    // Intelligently handle these based on what's in shared.h
                    for struct_name in &[
                        "HostKvApiV1",
                        "SynthiHostContextV1",
                        "SynthiNamespaceSchemaV1",
                    ] {
                        // Always strip typedef forward declarations if they exist
                        let typedef_pattern =
                            format!("typedef struct {} {};", struct_name, struct_name);
                        if content.contains(&typedef_pattern) {
                            content = content.replace(
                                &typedef_pattern,
                                &format!("// {} forward-declared in shared.h", struct_name),
                            );
                            eprintln!(
                                "[Guardrail] Stripped typedef forward decl for '{}' from core.cpp",
                                struct_name
                            );
                        }

                        // Strip full struct definitions ONLY if shared.h has them
                        if shared_has_full_hostkv {
                            let struct_decl = format!("struct {} {{", struct_name);
                            if let Some(start) = content.find(&struct_decl) {
                                if let Some(end) = content[start..].find("};") {
                                    let block_end = start + end + "};".len();
                                    let block = &content[start..block_end];
                                    eprintln!("[Guardrail] Stripping duplicate 'struct {}' from core.cpp (full definition in shared.h)", struct_name);
                                    content = content.replace(
                                        block,
                                        &format!("// {} fully defined in shared.h", struct_name),
                                    );
                                }
                            }
                        } else {
                            // shared.h only has forward declarations, keep full definitions here
                            eprintln!("[Guardrail] Keeping 'struct {}' definition in core.cpp (shared.h has forward decl only)", struct_name);
                        }
                    }

                    // FIX: If AI uses Host KV types but shared.h doesn't define them, inject definitions
                    // This happens when AI generates g_core_schemas[] or uses SynthiHostContextV1
                    let uses_hostkv_types = content.contains("SynthiHostContextV1")
                        || content.contains("SynthiNamespaceSchemaV1")
                        || content.contains("HostKvApiV1")
                        || content.contains("g_core_schemas")
                        || content.contains("host_kv_schemas");

                    if uses_hostkv_types && !shared_has_full_hostkv {
                        // Need to inject Host KV C header definitions
                        let hostkv_header = r#"
// ============================================================
// [Guardrail] HOST KV TYPE DEFINITIONS (auto-injected)
// ============================================================

#ifndef SYNTHI_HOST_KV_TYPES_DEFINED
#define SYNTHI_HOST_KV_TYPES_DEFINED

#include <stdint.h>

// Forward declarations
struct SynthiHostContextV1;
struct HostKvApiV1;

// Namespace schema entry
typedef struct SynthiNamespaceSchemaV1 {
    const char* ns;       // NUL-terminated namespace name
    uint64_t schema_id;   // Schema version/hash
} SynthiNamespaceSchemaV1;

// Host context (passed to *_on_load_host)
typedef struct SynthiHostContextV1 {
    uint32_t host_api_version;
    const struct HostKvApiV1* kv;
    const char* session_id;
    uint32_t session_id_len;
    uint32_t module_slot;
    void* window;
    void* renderer;
    void* reserved[8];
} SynthiHostContextV1;

// KV API vtable
typedef struct HostKvApiV1 {
    uint32_t version;
    int (*set_bytes)(const SynthiHostContextV1* ctx, const char* ns, const char* key, const uint8_t* data, uint32_t len);
    int (*get_bytes)(const SynthiHostContextV1* ctx, const char* ns, const char* key, uint8_t** out, uint32_t* out_len);
    int (*delete_key)(const SynthiHostContextV1* ctx, const char* ns, const char* key);
    int (*clear_namespace)(const SynthiHostContextV1* ctx, const char* ns);
    int (*get_schema)(const SynthiHostContextV1* ctx, const char* ns, uint64_t* out_schema);
    int (*set_schema)(const SynthiHostContextV1* ctx, const char* ns, uint64_t schema);
    void* (*host_alloc)(uint32_t size);
    void (*host_free)(void* ptr);
    const char* (*last_error)(void);
} HostKvApiV1;

#endif // SYNTHI_HOST_KV_TYPES_DEFINED
"#;
                        // Prepend to content after includes
                        if let Some(include_end) = content.rfind("#include") {
                            if let Some(newline_pos) = content[include_end..].find('\n') {
                                let insert_pos = include_end + newline_pos + 1;
                                content.insert_str(insert_pos, hostkv_header);
                                eprintln!("[Guardrail] Injected Host KV type definitions (AI uses Host KV but shared.h lacks definitions)");
                            }
                        } else {
                            // No includes found, prepend at start
                            content = format!("{}{}", hostkv_header, content);
                            eprintln!("[Guardrail] Injected Host KV type definitions at start (no includes found)");
                        }
                    }
                }

                // FIX: AI sometimes references AppState fields that don't exist
                // Common hallucinated fields: wbuffer, write_buffer, rbuffer, read_buffer
                // Strip lines that reference these if they're not in shared.h
                {
                    let hallucinated_fields = [
                        "wbuffer",
                        "write_buffer",
                        "rbuffer",
                        "read_buffer",
                        "buffer_ptr",
                    ];
                    for field in &hallucinated_fields {
                        if !shared_content.contains(field)
                            && (content.contains(&format!("->{}", field))
                                || content.contains(&format!(".{}", field)))
                        {
                            // Strip lines referencing this non-existent field
                            let pattern1 = format!("->{}", field);
                            let pattern2 = format!(".{}", field);

                            let mut cleaned = Vec::new();
                            for line in content.lines() {
                                if line.contains(&pattern1) || line.contains(&pattern2) {
                                    cleaned.push(format!(
                                        "// [Guardrail] Removed: {} (field not in AppState)",
                                        line.trim()
                                    ));
                                    eprintln!("[Guardrail] Stripped line referencing non-existent field '{}': {}", field, line.trim());
                                } else {
                                    cleaned.push(line.to_string());
                                }
                            }
                            content = cleaned.join("\n");
                        }
                    }
                }

                // FIX: AI often forgets to initialize button state fields in core.cpp
                // If the AppState has btn_x/btn_y/btn_w/btn_h but core doesn't initialize them,
                // the button won't be visible. Inject default values if missing.
                if shared_content.contains("btn_x") && shared_content.contains("btn_y") {
                    // Check if core.cpp initializes any btn_ fields
                    let has_btn_init = content.contains("btn_x =")
                        || content.contains("btn_x=")
                        || content.contains("->btn_x =")
                        || content.contains(".btn_x =");

                    if !has_btn_init {
                        // Find ALL state initialization blocks and inject button init after dx = 5
                        // The AI typically generates: app_state.dx = 5; without btn_ fields
                        let btn_init_code = "\n        app_state.btn_x = 200;\n        app_state.btn_y = 10;\n        app_state.btn_w = 120;\n        app_state.btn_h = 40;";

                        // Replace ALL occurrences of dx = 5 initialization
                        if content.contains("app_state.dx = 5;") {
                            content = content.replace(
                                "app_state.dx = 5;",
                                &format!("app_state.dx = 5;{}", btn_init_code),
                            );
                            eprintln!("[Guardrail] Injected button state initialization (btn_x/y/w/h) in core.cpp");
                        }
                    }
                }

                // CRITICAL FIX: Delta injection sometimes uses 'state->' in core.cpp init blocks
                // but 'state' is a local variable inside on_load(). Must use 'app_state.' instead.
                // This fixes AI-generated code like: state->btn2_x = 330; -> app_state.btn2_x = 330;
                if content.contains("state->btn") && content.contains("static AppState app_state") {
                    // Find state->btn patterns that should be app_state.btn
                    let patterns = [
                        ("state->btn2_", "app_state.btn2_"),
                        ("state->btn3_", "app_state.btn3_"),
                        ("state->btn4_", "app_state.btn4_"),
                        ("state->new_btn_", "app_state.new_btn_"),
                        ("state->reset_btn_", "app_state.reset_btn_"),
                    ];
                    let mut fixed = false;
                    for (wrong, correct) in &patterns {
                        if content.contains(*wrong) {
                            content = content.replace(*wrong, *correct);
                            fixed = true;
                        }
                    }
                    if fixed {
                        eprintln!(
                            "[Guardrail] Fixed state->btn* -> app_state.btn* in core.cpp init code"
                        );
                    }
                }

                // FIX: cleanup_window not declared
                if content.contains("cleanup_window(app_state.window)")
                    && !content.contains("void cleanup_window")
                {
                    // Inject a simple implementation before it's used (e.g. at the top, after headers)
                    // We'll just inject it after the last include
                    if let Some(idx) = content.rfind("#include") {
                        if let Some(end_idx) = content[idx..].find('\n') {
                            let insert_pos = idx + end_idx + 1;
                            let cleanup_impl = "\nvoid cleanup_window(SDL_Window* win) { if (win) SDL_DestroyWindow(win); }\n";
                            content.insert_str(insert_pos, cleanup_impl);
                        }
                    } else {
                        // Fallback: prepend
                        content = format!("void cleanup_window(SDL_Window* win) {{ if (win) SDL_DestroyWindow(win); }}\n{}", content);
                    }
                }

                // INJECT SAFETY PATCH: Safer dlopen (don't unload old lib if new one fails)
                // Use minimal search string
                if content.contains("dlopen(") && content.contains("dlclose(") {
                    // We assume the structure is: if(gui_lib) dlclose; gui_lib = dlopen;
                    // We can't easily replace the whole block without regex.
                    // Instead, we inject a helper function at the top and use it? No, too complex.
                    // Let's try to replace the dlopen call itself.
                    content = content.replace(
                    "gui_lib = dlopen(path, RTLD_NOW);",
                    "fprintf(stderr, \"Loading GUI from %s\\n\", path); void* new_lib = dlopen(path, RTLD_NOW); if(new_lib) { if(gui_lib) dlclose(gui_lib); gui_lib = new_lib; fprintf(stderr, \"GUI loaded OK\\n\"); } else { fprintf(stderr, \"dlopen failed: %s\\n\", dlerror()); }"
                 );
                    // And remove the previous dlclose if it exists immediately before
                    content = content.replace(
                        "if (gui_lib) {\n        dlclose(gui_lib);\n    }",
                        "// dlclose moved to safe block",
                    );
                    // Also handle one-line version
                    content = content.replace(
                        "if (gui_lib) dlclose(gui_lib);",
                        "// dlclose moved to safe block",
                    );
                }

                // INJECT PROBE: Check if GUI is loaded
                if content.contains("if (ptr_gui_render)") {
                    content = content.replace(
                    "if (ptr_gui_render)",
                    "if (!ptr_gui_render) { static int null_cnt=0; if(++null_cnt%60==0) fprintf(stderr, \"WARNING: ptr_gui_render is NULL. GUI module not loaded!\\n\"); } if (ptr_gui_render)"
                 );
                }

                // INJECT DEBUG PRINT: Print state every 60 frames

                // INJECT XInitThreads: REMOVED (Dangerous to call after X11 init)
                /*
                if content.contains("XOpenDisplay(") {
                    content = content.replace(
                        "current_state->dpy = XOpenDisplay(NULL);",
                        "XInitThreads(); current_state->dpy = XOpenDisplay(NULL);"
                    );
                    content = content.replace(
                        "app_state.dpy = XOpenDisplay(NULL);",
                        "XInitThreads(); app_state.dpy = XOpenDisplay(NULL);"
                    );
                }
                */

                // FIX: Replace direct calls to gui functions with pointers to avoid undefined symbols
                for func in &[
                    "gui_initialize",
                    "gui_on_update",
                    "gui_render",
                    "gui_cleanup",
                    "gui_on_event",
                ] {
                    let ptr_name = format!("ptr_{}", func);
                    // Replace calls: func( -> ptr_name(
                    content = content.replace(&format!("{}(", func), &format!("{}(", ptr_name));

                    // FIX: Prevent double prefixing if the code already used pointers
                    // ptr_gui_initialize( -> ptr_ptr_gui_initialize( -> ptr_gui_initialize(
                    let double_ptr = format!("ptr_{}", ptr_name);
                    content = content.replace(&double_ptr, &ptr_name);

                    // Restore declarations: void ptr_name( -> void func(
                    content =
                        content.replace(&format!("void {}(", ptr_name), &format!("void {}(", func));
                }

                // Replace hard-wired GUI symbol assignments with null so the core does not depend on GUI at link/load time.
                for (from, to) in [
                    (
                        "ptr_gui_initialize = gui_initialize;",
                        "ptr_gui_initialize = nullptr;",
                    ),
                    (
                        "ptr_gui_on_update = gui_on_update;",
                        "ptr_gui_on_update = nullptr;",
                    ),
                    ("ptr_gui_render = gui_render;", "ptr_gui_render = nullptr;"),
                    (
                        "ptr_gui_cleanup = gui_cleanup;",
                        "ptr_gui_cleanup = nullptr;",
                    ),
                    (
                        "ptr_gui_on_event = gui_on_event;",
                        "ptr_gui_on_event = nullptr;",
                    ),
                ] {
                    if content.contains(from) {
                        content = content.replace(from, to);
                    }
                }

                // FIX: Comment out SDL_RenderPresent to prevent deadlock with runner's event loop
                // The runner handles SDL_RenderPresent after calling gui_render
                use regex::Regex;
                let re_present = Regex::new(r"SDL_RenderPresent\s*\([^)]*\)\s*;").unwrap();
                content = re_present
                    .replace_all(
                        &content,
                        "/* SDL_RenderPresent removed - runner handles this */",
                    )
                    .to_string();

                // FIX: Correct Display** cast in on_load (AI often generates invalid cast)
                if content.contains("(Display**)window_ptr") {
                    content = content.replace("(Display**)window_ptr", "(void**)window_ptr");
                }

                // FIX: Correct XCreateIC call (remove first arg if it is Display*, AI hallucinates this arg)
                if content.contains("XCreateIC(*(Display**)state->window,") {
                    content = content.replace("XCreateIC(*(Display**)state->window,", "XCreateIC(");
                }

                // Inject Event Draining in on_update: REMOVED (Steals events from runner)
                /*
                            if content.contains("extern \"C\" void on_update(") {
                                // We inject at the start of the function
                                let event_loop = r#"
                    // Auto-injected event loop
                    AppState* casted_state = (AppState*)state_ptr;
                    if (casted_state && casted_state->dpy) {
                        XEvent ev;
                        while (XPending(casted_state->dpy) > 0) {
                            XNextEvent(casted_state->dpy, &ev);
                        }
                    }
                "#;
                                content = content.replace(
                                    "extern \"C\" void on_update(void* state_ptr, double dt) {",
                                    &format!("extern \"C\" void on_update(void* state_ptr, double dt) {{{}", event_loop)
                                );
                            }
                            */

                if content.contains("main(") && !content.contains("extern \"C\" void* entrypoint") {
                    content.push_str("\n\nextern \"C\" void* entrypoint(void* state) {\n    main();\n    return 0;\n}\n");
                }

                // Inject State Serialization Stubs for Full HMR Capability
                // These exports enable "Full HMR" detection by the capability checker
                // The runner will see these symbols and grant Full HMR capability

                // Case 1: New-style Core module - generate DYNAMIC JSON serialization based on shared.h
                // Skip if AI already generated these functions to avoid redefinition errors
                if content.contains("core_on_load")
                    && !content.contains("core_on_save_state")
                    && !content.contains("core_get_state_schema_hash")
                {
                    // Parse actual fields from shared.h WITH DEFAULT VALUES for proper schema migration
                    let fields = parse_appstate_int_fields_with_defaults(shared_content);
                    eprintln!(
                        "[Guardrail] Parsed {} fields from shared.h for serialization: {:?}",
                        fields.len(),
                        fields
                            .iter()
                            .map(|(n, _, d)| format!("{}={:?}", n, d))
                            .collect::<Vec<_>>()
                    );

                    // Generate serialization code that handles ALL fields with declared defaults
                    let state_serial_stubs =
                        generate_state_serialization_code_with_defaults(&fields, "core");
                    content.push_str(&state_serial_stubs);
                    eprintln!("[Guardrail] Injected DYNAMIC state serialization for Full HMR (core) with declared defaults");
                }
                // Case 2: Legacy module - also use dynamic serialization
                // Skip if AI already generated these functions to avoid redefinition errors
                else if content.contains("on_load")
                    && !content.contains("on_save_state")
                    && !content.contains("core_on_load")
                    && !content.contains("get_state_schema_hash")
                {
                    // Parse actual fields from shared.h WITH DEFAULT VALUES for proper schema migration
                    let fields = parse_appstate_int_fields_with_defaults(shared_content);
                    eprintln!(
                        "[Guardrail] Parsed {} fields from shared.h for legacy serialization: {:?}",
                        fields.len(),
                        fields
                            .iter()
                            .map(|(n, _, d)| format!("{}={:?}", n, d))
                            .collect::<Vec<_>>()
                    );

                    // Generate serialization code that handles ALL fields (legacy prefix)
                    let state_serial_stubs =
                        generate_state_serialization_code_with_defaults(&fields, "legacy");
                    content.push_str(&state_serial_stubs);
                    eprintln!("[Guardrail] Injected DYNAMIC state serialization for Full HMR (legacy) with declared defaults");
                }

                let content_hash = calculate_hash(&content);
                // Cache hit? reuse compiled library path.

                // Try content-addressable cache first (persists across sessions)
                let cache_key = IncrementalCache::cache_key(&content, &["-shared", "-fPIC"], &[]);
                if let Some(cached_so) = incremental_cache.get(&cache_key).await {
                    core_lib_path = cached_so.to_string_lossy().to_string();
                    eprintln!("[Cache] HIT for core module (persistent cache)");
                    println!("Using cached core library: {}", core_lib_path);
                } else {
                    // Fall back to legacy in-memory cache for fast path
                    {
                        let cache = compile_cache.lock().await;
                        if let Some((h, p)) = cache.get("core") {
                            if *h == content_hash {
                                core_lib_path = p.clone();
                                println!("Using cached core library: {}", core_lib_path);
                            }
                        }
                    }

                    // Cache miss: compile core.
                    if core_lib_path.is_empty() {
                        tokio::fs::write(dir_path.join(fname), &content).await?;

                        let core_out = output_dir.join(format!("libcore_{}.{}", timestamp, ext));
                        let mut cmd = system_command("g++");
                        cmd.arg("-shared")
                            .arg("-fPIC")
                            .arg("-D_POSIX_C_SOURCE=199309L")
                            // Debug flags for source map generation
                            .arg("-g")
                            .arg("-gdwarf-4")
                            .arg("-fno-omit-frame-pointer")
                            // Add JSON diagnostics flag for structured error parsing
                            .arg("-fdiagnostics-format=json")
                            .arg(fname)
                            .arg("-I.")
                            .arg("-o")
                            .arg(&core_out)
                            .arg("-ldl")
                            // Export symbols for backtracing
                            .arg("-rdynamic");
                        cmd.current_dir(&dir_path);

                        let output = cmd.output().await?;
                        if !output.status.success() {
                            let stderr = String::from_utf8_lossy(&output.stderr);

                            // Parse compiler output into structured diagnostics
                            let diag_report =
                                parse_compiler_output(&stderr, "core", CompilerType::Gcc, true);
                            let diag_event = DiagnosticEvent::new("core", diag_report.clone())
                                .with_session(session_id.clone().unwrap_or_default());

                            // Send structured diagnostics
                            let diag_payload = serde_json::json!({
                                "sessionId": session_id.clone(),
                                "type": "compile-diagnostics",
                                "data": serde_json::from_str::<serde_json::Value>(&diag_event.to_json()).unwrap_or_default()
                            });
                            let _ = log_dc
                                .send_text(serde_json::to_string(&diag_payload).unwrap_or_default())
                                .await;

                            // Send compile error HMR status - rollback behavior keeps old module
                            let status = CapabilityHmrStatus::compile_error(
                                "core",
                                vec![stderr.to_string()],
                            );
                            let hmr_payload = serde_json::json!({
                                "sessionId": session_id.clone(),
                                "type": "hmr-status",
                                "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                            });
                            let _ = log_dc
                                .send_text(serde_json::to_string(&hmr_payload).unwrap_or_default())
                                .await;

                            // If we have an existing runner with the old core, keep it running (rollback)
                            {
                                let guard = runner_store.lock().await;
                                if let Some(state) = guard.as_ref() {
                                    if state.loaded_core_path.is_some() {
                                        let rejected = CapabilityHmrStatus::rejected(
                                            "core",
                                            "Compilation failed - keeping previous module",
                                        );
                                        let payload = serde_json::json!({
                                            "sessionId": session_id.clone(),
                                            "type": "hmr-status",
                                            "data": serde_json::from_str::<serde_json::Value>(&rejected.to_json()).unwrap_or_default()
                                        });
                                        let _ = log_dc
                                            .send_text(
                                                serde_json::to_string(&payload).unwrap_or_default(),
                                            )
                                            .await;
                                        eprintln!("[Rollback] Core compile failed, keeping old module running");
                                    }
                                }
                            }

                            let payload = serde_json::json!({
                                "sessionId": session_id.clone(),
                                "status": "done",
                                "success": false,
                                "stage": "compile_core",
                                "error": stderr,
                                "diagnostics": diag_report.diagnostics.len()
                            });
                            let _ = log_dc
                                .send_text(serde_json::to_string(&payload).unwrap_or_default())
                                .await;
                            return Ok(());
                        }

                        core_lib_path = core_out.to_string_lossy().to_string();
            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
        }

        // Reuse previous paths if not rebuilding that module
        if rebuild_scope == RebuildScope::GuiOnly {
            if let Some(ref path) = prev_core_path {
                core_lib_path = path.clone();
                eprintln!("[Main] Reusing existing core library: {}", core_lib_path);
            }
        }

        // Write shared.h (already processed by guardrails in Phase 1)
        // IMPORTANT: avoid rewriting when semantically unchanged, otherwise a file-watcher can
        // see generated `shared.h` churn and trigger redundant builds/restarts.
        if split_data.get("shared").is_some() {
            let fname = split_data
                .get("shared")
                .and_then(|s| s["filename"].as_str())
                .unwrap_or("shared.h");

            let shared_path = dir_path.join(fname);
            let shared_exists = tokio::fs::try_exists(&shared_path).await.unwrap_or(false);

            let shared_semantically_changed = prev_hashes.shared_hash == 0
                || prev_hashes.shared_hash != new_hashes.shared_hash;

            if !shared_exists || shared_semantically_changed {
                println!("Writing shared library file: {}", fname);
                tokio::fs::write(shared_path, &processed_shared).await?;
            } else {
                eprintln!("[Main] shared.h unchanged (semantic) - skipping write");
            }
        }

        // Skip core compilation if GUI-only rebuild (reuse existing core.so)
        if rebuild_scope == RebuildScope::Both || rebuild_scope == RebuildScope::CoreOnly {
        if split_data.get("core").is_some() {
            let fname = split_data.get("core")
                .and_then(|s| s["filename"].as_str())
                .unwrap_or("core.cpp");
            
            // Use the already-processed content from Phase 1 (guardrails already applied)
            let content = processed_core.clone();

                        // Detect Core module capabilities from exports
                        if let Ok(core_report) =
                            detect_capabilities(std::path::Path::new(&core_lib_path))
                        {
                            eprintln!(
                                "[Capability] Core module: {:?}, HMR: {:?}",
                                core_report.module_type, core_report.hmr_capability
                            );
                            let status =
                                CapabilityHmrStatus::capability_detected("core", &core_report);
                            let payload = serde_json::json!({
                                "sessionId": session_id.clone(),
                                "type": "hmr-status",
                                "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                            });
                            let _ = log_dc
                                .send_text(serde_json::to_string(&payload).unwrap_or_default())
                                .await;
                        }

                        // Store in persistent content-addressable cache
                        if let Ok(so_data) = tokio::fs::read(&core_lib_path).await {
                            let source_hash = content_hash;
                            let flags_hash = calculate_hash(&"-shared-fPIC");
                            let headers_hash = 0u64;
                            if let Err(e) = incremental_cache
                                .put(
                                    cache_key.clone(),
                                    source_hash,
                                    flags_hash,
                                    headers_hash,
                                    &so_data,
                                )
                                .await
                            {
                                eprintln!(
                                    "[Cache] Failed to store core in persistent cache: {}",
                                    e
                                );
                            } else {
                                eprintln!("[Cache] Stored core module in persistent cache");
                            }
                        }

                        // Also update legacy in-memory cache for fast path
                        let mut cache = compile_cache.lock().await;
                        cache.insert("core".to_string(), (content_hash, core_lib_path.clone()));
                    }
                }

                if !core_lib_path.is_empty() {
                    // Create symlink ./core.so -> core_lib_path so gui can dlopen("./core.so")
                    #[cfg(unix)]
                    {
                        let link_path = dir_path.join("core.so");
                        let _ = tokio::fs::remove_file(&link_path).await;
                        if let Err(e) = tokio::fs::symlink(&core_lib_path, &link_path).await {
                            println!("Failed to create core.so symlink: {}", e);
                        }
                    }
                    #[cfg(windows)]
                    {
                        let link_path = dir_path.join("core.dll");
                        let _ = tokio::fs::remove_file(&link_path).await;
                        if let Err(e) = tokio::fs::copy(&core_lib_path, &link_path).await {
                            println!("Failed to copy core.dll: {}", e);
                        }
                    }
                    modules_to_load.push(("core".to_string(), core_lib_path.clone()));
                }
            }
        } else {
            // GUI-only rebuild or No changes: reuse existing core library path
            if let Some(ref existing_core) = prev_core_path {
                core_lib_path = existing_core.clone();
                println!("Reusing existing core at {}", core_lib_path);
            }
        }

        if let Ok(Some(p)) = gui_res {
            gui_lib_path = p;
        }

        // ============================================================
        // FAST REFRESH BOUNDARY CHECKING
        // ============================================================
        // Check if code changes cross HMR boundaries before compiling
        let mut boundary_violations = Vec::new();
        let mut force_full_reload = false;

        if let Some(core) = split_data.get("core") {
            let content = core["content"].as_str().unwrap_or("");
            let mut checker = boundary_checker.lock().await;
            let result = checker.check_boundaries("core", content);

            if !result.violations.is_empty() {
                // Send boundary violation event to frontend
                let event = BoundaryViolationEvent::from_check("core", &result);
                let payload = serde_json::json!({
                    "sessionId": session_id.clone(),
                    "type": "hmr-status",
                    "data": {
                        "status": "boundary-violation",
                        "module": "core",
                        "violations": event.violations,
                        "action": format!("{:?}", event.action),
                        "summary": event.summary,
                        "canProceed": event.can_proceed
                    }
                });
                let _ = log_dc
                    .send_text(serde_json::to_string(&payload).unwrap_or_default())
                    .await;

                boundary_violations.extend(result.violations.clone());
                if result.action == RefreshAction::FullReload
                    || result.action == RefreshAction::Restart
                {
                    force_full_reload = true;
                }
            }
        }

        if let Some(gui) = split_data.get("gui") {
            let content = gui["content"].as_str().unwrap_or("");
            let mut checker = boundary_checker.lock().await;
            let result = checker.check_boundaries("gui", content);

            if !result.violations.is_empty() {
                let event = BoundaryViolationEvent::from_check("gui", &result);
                let payload = serde_json::json!({
                    "sessionId": session_id.clone(),
                    "type": "hmr-status",
                    "data": {
                        "status": "boundary-violation",
                        "module": "gui",
                        "violations": event.violations,
                        "action": format!("{:?}", event.action),
                        "summary": event.summary,
                        "canProceed": event.can_proceed
                    }
                });
                let _ = log_dc
                    .send_text(serde_json::to_string(&payload).unwrap_or_default())
                    .await;

                boundary_violations.extend(result.violations.clone());
                if !result.can_hmr {
                    force_full_reload = true;
                }
            }
        }

        // If boundary violations require full reload, notify frontend
        if force_full_reload {
            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "hmr-status",
                "data": {
                    "status": "full-reload-required",
                    "reason": "Fast Refresh boundary crossed",
                    "violations": boundary_violations.len(),
                    "message": "Code changes require a full reload. State will be reset."
                }
            });
            let _ = log_dc
                .send_text(serde_json::to_string(&payload).unwrap_or_default())
                .await;
        }

        if split_data.get("gui").is_some() {
            // Only compile GUI if scope includes it
            if rebuild_scope == RebuildScope::Both || rebuild_scope == RebuildScope::GuiOnly {
                let fname = gui["filename"].as_str().unwrap_or("gui.cpp");
                let mut content = gui["content"].as_str().unwrap_or("").to_string();

                // Read shared.h content to check what's defined there (reuse from core processing)
                let shared_content = split_data
                    .get("shared")
                    .and_then(|s| s["content"].as_str())
                    .unwrap_or("");

                // Detect if shared.h has full struct definitions or just forward declarations
                let shared_has_full_hostkv = shared_content.contains("struct HostKvApiV1 {")
                    || shared_content.contains("struct SynthiHostContextV1 {")
                    || shared_content.contains("struct SynthiNamespaceSchemaV1 {");

                // CRITICAL: Strip X11-related functions that the AI incorrectly preserved from the input.
                let x11_type_patterns = [
                    "Display*",
                    "Display *",
                    "XIM",
                    "XIC",
                    "Atom",
                    "Colormap",
                    "Pixmap",
                    "GC ",
                    "XEvent",
                    "XOpenDisplay",
                    "XCloseDisplay",
                    "XCreateWindow",
                    "XDestroyWindow",
                    "XOpenIM",
                    "XCreateIC",
                    "XCreateGC",
                    "XFreeGC",
                    "XCreatePixmap",
                    "XFreePixmap",
                ];
                let mut cleaned_lines = Vec::new();
                for line in content.lines() {
                    let has_x11 = x11_type_patterns.iter().any(|pat| line.contains(pat));
                    let is_comment =
                        line.trim_start().starts_with("//") || line.trim_start().starts_with("/*");
                    let is_include = line.trim_start().starts_with("#include");
                    if has_x11 && !is_comment && !is_include {
                        cleaned_lines.push(format!("// [X11-stripped] {}", line));
                    } else {
                        cleaned_lines.push(line.to_string());
                    }
                }
                content = cleaned_lines.join("\n");

                // FIX: GUI module should use GUI_STATE_MAGIC, not CORE_STATE_MAGIC
                // AI sometimes copies core.cpp pattern without changing the magic constant
                if content.contains("CORE_STATE_MAGIC")
                    && !content.contains("#define CORE_STATE_MAGIC")
                {
                    content = content.replace("CORE_STATE_MAGIC", "GUI_STATE_MAGIC");
                    eprintln!("[Guardrail] Fixed magic constant: replaced CORE_STATE_MAGIC with GUI_STATE_MAGIC in gui.cpp");
                }

                // FIX: Ensure shared.h is included in gui.cpp if AppState is used
                if content.contains("AppState") && !content.contains("#include \"shared.h\"") {
                    if content.contains("struct AppState;") {
                        content = content.replace("struct AppState;", "#include \"shared.h\"");
                    } else {
                        content = format!("#include \"shared.h\"\n{}", content);
                    }
                    eprintln!("[Guardrail] Added #include \"shared.h\" to gui.cpp");
                }

                // CRITICAL FIX: Strip duplicate AppState struct/typedef from gui.cpp
                if content.contains("#include \"shared.h\"") {
                    // Pattern 1: typedef struct AppState { ... } AppState;
                    if let Some(start) = content.find("typedef struct AppState") {
                        if let Some(end) = content[start..].find("} AppState;") {
                            let block_end = start + end + "} AppState;".len();
                            let block = &content[start..block_end];
                            eprintln!("[Guardrail] Stripping duplicate 'typedef struct AppState' from gui.cpp (defined in shared.h)");
                            content = content.replace(block, "// AppState defined in shared.h");
                        }
                    }

                    // Pattern 1b: typedef struct { ... } AppState; (Anonymous struct typedef)
                    if let Some(start) = content.find("typedef struct {") {
                        if let Some(end) = content[start..].find("} AppState;") {
                            let block_end = start + end + "} AppState;".len();
                            let block = &content[start..block_end];
                            if block.contains("magic") && block.contains("struct_size") {
                                eprintln!("[Guardrail] Stripping duplicate 'typedef struct {{ ... }} AppState' from gui.cpp");
                                content = content.replace(block, "// AppState defined in shared.h");
                            }
                        }
                    }

                    // Pattern 2: struct AppState { ... };
                    if let Some(start) = content.find("struct AppState {") {
                        if let Some(end) = content[start..].find("};") {
                            let block_end = start + end + "};".len();
                            let block = &content[start..block_end];
                            if block.contains("{") {
                                eprintln!("[Guardrail] Stripping duplicate 'struct AppState' definition from gui.cpp (defined in shared.h)");
                                content = content.replace(block, "// AppState defined in shared.h");
                            }
                        }
                    }

                    // Pattern 3: Host KV structs (HostKvApiV1, SynthiHostContextV1, SynthiNamespaceSchemaV1)
                    // Intelligently handle these based on what's in shared.h
                    for struct_name in &[
                        "HostKvApiV1",
                        "SynthiHostContextV1",
                        "SynthiNamespaceSchemaV1",
                    ] {
                        // Always strip typedef forward declarations if they exist
                        let typedef_pattern =
                            format!("typedef struct {} {};", struct_name, struct_name);
                        if content.contains(&typedef_pattern) {
                            content = content.replace(
                                &typedef_pattern,
                                &format!("// {} forward-declared in shared.h", struct_name),
                            );
                            eprintln!(
                                "[Guardrail] Stripped typedef forward decl for '{}' from gui.cpp",
                                struct_name
                            );
                        }

                        // Strip full struct definitions ONLY if shared.h has them
                        if shared_has_full_hostkv {
                            let struct_decl = format!("struct {} {{", struct_name);
                            if let Some(start) = content.find(&struct_decl) {
                                if let Some(end) = content[start..].find("};") {
                                    let block_end = start + end + "};".len();
                                    let block = &content[start..block_end];
                                    eprintln!("[Guardrail] Stripping duplicate 'struct {}' from gui.cpp (full definition in shared.h)", struct_name);
                                    content = content.replace(
                                        block,
                                        &format!("// {} fully defined in shared.h", struct_name),
                                    );
                                }
                            }
                        } else {
                            // shared.h only has forward declarations, keep full definitions here
                            eprintln!("[Guardrail] Keeping 'struct {}' definition in gui.cpp (shared.h has forward decl only)", struct_name);
                        }
                    }

                    // FIX: If AI uses Host KV types but shared.h doesn't define them, inject definitions
                    let uses_hostkv_types = content.contains("SynthiHostContextV1")
                        || content.contains("SynthiNamespaceSchemaV1")
                        || content.contains("HostKvApiV1")
                        || content.contains("g_gui_schemas")
                        || content.contains("host_kv_schemas");

                    if uses_hostkv_types && !shared_has_full_hostkv {
                        let hostkv_header = r#"
// ============================================================
// [Guardrail] HOST KV TYPE DEFINITIONS (auto-injected)
// ============================================================

#ifndef SYNTHI_HOST_KV_TYPES_DEFINED
#define SYNTHI_HOST_KV_TYPES_DEFINED

#include <stdint.h>

struct SynthiHostContextV1;
struct HostKvApiV1;

typedef struct SynthiNamespaceSchemaV1 {
    const char* ns;
    uint64_t schema_id;
} SynthiNamespaceSchemaV1;

typedef struct SynthiHostContextV1 {
    uint32_t host_api_version;
    const struct HostKvApiV1* kv;
    const char* session_id;
    uint32_t session_id_len;
    uint32_t module_slot;
    void* window;
    void* renderer;
    void* reserved[8];
} SynthiHostContextV1;

typedef struct HostKvApiV1 {
    uint32_t version;
    int (*set_bytes)(const SynthiHostContextV1* ctx, const char* ns, const char* key, const uint8_t* data, uint32_t len);
    int (*get_bytes)(const SynthiHostContextV1* ctx, const char* ns, const char* key, uint8_t** out, uint32_t* out_len);
    int (*delete_key)(const SynthiHostContextV1* ctx, const char* ns, const char* key);
    int (*clear_namespace)(const SynthiHostContextV1* ctx, const char* ns);
    int (*get_schema)(const SynthiHostContextV1* ctx, const char* ns, uint64_t* out_schema);
    int (*set_schema)(const SynthiHostContextV1* ctx, const char* ns, uint64_t schema);
    void* (*host_alloc)(uint32_t size);
    void (*host_free)(void* ptr);
    const char* (*last_error)(void);
} HostKvApiV1;

#endif // SYNTHI_HOST_KV_TYPES_DEFINED
"#;
                        if let Some(include_end) = content.rfind("#include") {
                            if let Some(newline_pos) = content[include_end..].find('\n') {
                                let insert_pos = include_end + newline_pos + 1;
                                content.insert_str(insert_pos, hostkv_header);
                                eprintln!(
                                    "[Guardrail] Injected Host KV type definitions into gui.cpp"
                                );
                            }
                        } else {
                            content = format!("{}{}", hostkv_header, content);
                            eprintln!(
                                "[Guardrail] Injected Host KV type definitions at start of gui.cpp"
                            );
                        }
                    }
                }

                // FIX: gui_on_load MUST have 3 parameters. AI sometimes generates 2-param version.
                // The runner expects: gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)
                if content.contains("gui_on_load(void* prev_state, void* window_ptr)")
                    && !content.contains(
                        "gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)",
                    )
                {
                    content = content.replace(
                        "gui_on_load(void* prev_state, void* window_ptr)",
                        "gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)",
                    );
                    eprintln!("[Guardrail] Fixed gui_on_load signature: added missing core_api_ptr parameter");
                }

                // FIX: Comment out SDL_RenderPresent to prevent deadlock
                // The runner handles SDL_RenderPresent after calling gui_render
                let re_present = regex::Regex::new(r"SDL_RenderPresent\s*\([^)]*\)\s*;").unwrap();
                content = re_present
                    .replace_all(
                        &content,
                        "/* SDL_RenderPresent removed - runner handles this */",
                    )
                    .to_string();

                // FIX: Replace SDL_GetKeyboardWindow with SDL_GetKeyboardFocus (AI hallucination fix)
                if content.contains("SDL_GetKeyboardWindow") {
                    content = content.replace("SDL_GetKeyboardWindow", "SDL_GetKeyboardFocus");
                    eprintln!(
                        "[Guardrail] Replaced SDL_GetKeyboardWindow with SDL_GetKeyboardFocus"
                    );
                }

                // CRITICAL FIX: Convert malloc-based gui_on_load to static storage for reliable HMR
                if content.contains("malloc(sizeof(AppState))") && content.contains("gui_on_load") {
                    eprintln!("[Guardrail] Detected malloc(sizeof(AppState)) pattern in gui.cpp");
                    eprintln!(
                        "[Guardrail] CONVERTING malloc to static storage pattern for reliable HMR"
                    );

                    // Inject static variable if not present
                    if !content.contains("static AppState gui_app_state")
                        && !content.contains("static GuiState gui_state")
                    {
                        if let Some(on_load_pos) = content.find("extern \"C\" void* gui_on_load") {
                            content.insert_str(on_load_pos, "// [Guardrail] Injected static storage for HMR\nstatic AppState gui_app_state = {0};\n\n");
                            eprintln!("[Guardrail] Injected static gui_app_state storage");
                        }
                    }

                    // Replace malloc pattern with static storage usage
                    use regex::Regex;
                    let re_malloc = Regex::new(r"AppState\*\s+state\s*=\s*\(AppState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*AppState\s*\)\s*\)\s*;").unwrap();
                    content = re_malloc.replace_all(&content, "AppState* state = (prev_state) ? (AppState*)prev_state : &gui_app_state; // [Guardrail] Fixed malloc->static").to_string();

                    let re_malloc2 = Regex::new(r"GuiState\*\s+state\s*=\s*\(GuiState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*GuiState\s*\)\s*\)\s*;").unwrap();
                    content = re_malloc2.replace_all(&content, "GuiState* state = (prev_state) ? (GuiState*)prev_state : &gui_state; // [Guardrail] Fixed malloc->static").to_string();

                    eprintln!("[Guardrail] Converted gui.cpp malloc patterns to static storage");
                }

                // FIX: Detect and warn about free(state) which causes crashes
                if content.contains("free(state)") {
                    eprintln!("[Guardrail] WARNING: Detected free(state) in gui.cpp");
                    eprintln!("[Guardrail] This will cause crashes on hot reload - runner manages state lifecycle");
                    // Comment out free(state) calls
                    content = content.replace(
                        "free(state);",
                        "// free(state); // Commented - runner manages state",
                    );
                }

                // FIX: Detect and warn about memset on state which wipes preserved HMR state
                if content.contains("memset(state")
                    || content.contains("memset(&app_state")
                    || content.contains("memset(&gui_state")
                    || content.contains("memset(&state")
                    || content.contains("memset(&gui_app_state")
                    || content.contains("memset( state")
                {
                    eprintln!("[Guardrail] WARNING: Detected memset on state in gui.cpp");
                    eprintln!("[Guardrail] memset wipes preserved state from prev_state - this breaks HMR!");

                    // Aggressive stripping of memset - catch ALL variations
                    use regex::Regex;
                    let re_memset = Regex::new(r"memset\s*\(\s*(state|&app_state|&gui_state|&state|&gui_app_state)[^;]*\)\s*;").unwrap();
                    content = re_memset
                        .replace_all(
                            &content,
                            "// [Guardrail] memset REMOVED to preserve HMR state",
                        )
                        .to_string();
                }

                // CRITICAL FIX: AI sometimes uses 'app_state' in gui.cpp instead of 'gui_app_state'
                // This happens during structural updates when AI copies patterns from core.cpp
                // The variable in gui.cpp MUST be 'gui_app_state' (injected by guardrail) not 'app_state'
                if content.contains("static AppState gui_app_state")
                    || content.contains("&gui_app_state")
                {
                    // gui.cpp uses gui_app_state, so fix any bare 'app_state' references
                    // But be careful not to replace 'gui_app_state' with 'gui_gui_app_state'

                    // Pattern: &app_state that should be &gui_app_state
                    if content.contains("&app_state") && !content.contains("&gui_app_state") {
                        content = content.replace("&app_state", "&gui_app_state");
                        eprintln!("[Guardrail] Fixed &app_state -> &gui_app_state in gui.cpp");
                    }

                    // Pattern: bare 'app_state' that should be 'gui_app_state'
                    // Use word boundary \b to match whole word only
                    // But we need to avoid replacing 'gui_app_state' with 'gui_gui_app_state'
                    if content.contains("gui_app_state") {
                        // Only replace standalone app_state (not gui_app_state)
                        // Simple approach: temporarily replace gui_app_state, then replace app_state, then restore
                        let placeholder = "__GUI_APP_STATE_PLACEHOLDER__";
                        let temp_content = content.replace("gui_app_state", placeholder);
                        if temp_content.contains("app_state") {
                            let fixed_content = temp_content.replace("app_state", "gui_app_state");
                            content = fixed_content.replace(placeholder, "gui_app_state");
                            eprintln!("[Guardrail] Fixed app_state -> gui_app_state references in gui.cpp");
                        } else {
                            // No standalone app_state found, nothing to do
                        }
                    }
                }

                if content.contains("main(") && !content.contains("extern \"C\" void* entrypoint") {
                    content.push_str("\n\nextern \"C\" void* entrypoint(void* state) {\n    main();\n    return 0;\n}\n");
                }

                // CRITICAL FIX: Delta injection sometimes uses 'renderer' instead of 'state->renderer'
                // Fix any bare 'renderer' that should be 'state->renderer' in SDL calls
                if content.contains("SDL_Render")
                    || content.contains("SDL_SetRenderDrawColor")
                    || content.contains("draw_text")
                {
                    // Match patterns like SDL_RenderFillRect(renderer, but NOT state->renderer
                    // Use simple string replacement for common patterns
                    let fixes = [
                        (
                            "SDL_RenderFillRect(renderer,",
                            "SDL_RenderFillRect(state->renderer,",
                        ),
                        (
                            "SDL_RenderDrawRect(renderer,",
                            "SDL_RenderDrawRect(state->renderer,",
                        ),
                        (
                            "SDL_SetRenderDrawColor(renderer,",
                            "SDL_SetRenderDrawColor(state->renderer,",
                        ),
                        (
                            "SDL_RenderClear(renderer)",
                            "SDL_RenderClear(state->renderer)",
                        ),
                        ("draw_text(renderer,", "draw_text(state->renderer,"),
                    ];
                    let mut fixed_any = false;
                    for (wrong, correct) in &fixes {
                        if content.contains(*wrong) {
                            content = content.replace(*wrong, *correct);
                            fixed_any = true;
                        }
                    }
                    if fixed_any {
                        eprintln!(
                            "[Guardrail] Fixed renderer -> state->renderer in gui.cpp SDL calls"
                        );
                    }
                }

                // CRITICAL FIX: Delta injection click handlers use 'x'/'y' but should use 'mx'/'my'
                // The event handler declares: int mx = ev->button.x; int my = ev->button.y;
                if content.contains("SDL_MOUSEBUTTONDOWN") {
                    // Fix click checks that use wrong variable names
                    // Pattern: "if (x >= state->" should be "if (mx >= state->"
                    let click_fixes = [
                        ("if (x >= state->", "if (mx >= state->"),
                        ("if (y >= state->", "if (my >= state->"),
                        ("&& x <", "&& mx <"),
                        ("&& y <", "&& my <"),
                        ("&& x <=", "&& mx <="),
                        ("&& y <=", "&& my <="),
                    ];
                    let mut fixed_click = false;
                    for (wrong, correct) in &click_fixes {
                        if content.contains(*wrong) {
                            content = content.replace(*wrong, *correct);
                            fixed_click = true;
                        }
                    }
                    if fixed_click {
                        eprintln!("[Guardrail] Fixed x/y -> mx/my in gui.cpp click handlers");
                    }
                }

                // Inject State Serialization Stubs for Full HMR Capability in GUI module
                // GUI typically doesn't need state preservation as it renders Core's state,
                // but we provide stubs for completeness
                // Skip if AI already generated these functions to avoid redefinition errors
                if content.contains("gui_on_load")
                    && !content.contains("gui_on_save_state")
                    && !content.contains("gui_get_state_schema_hash")
                {
                    let gui_serial_stubs = r#"

// [Guardrail] State serialization stubs for Full HMR capability (GUI)
// GUI module typically renders Core's state, so GUI state preservation is minimal
extern "C" char* gui_on_save_state(void* state_ptr) {
    (void)state_ptr;
    // GUI state is usually transient (textures, hover states)
    // Return empty JSON - GUI will reinitialize from Core state
    char* json = (char*)malloc(3);
    if (json) strcpy(json, "{}");
    return json;
}

extern "C" void* gui_on_load_from_json(const char* json) {
    (void)json;
    // GUI state is reinitialized from Core state during gui_on_load
    return NULL;
}

extern "C" void synthi_free_json(char* json) {
    if (json) free(json);
}
"#;
                    content.push_str(gui_serial_stubs);
                    eprintln!("[Guardrail] Injected GUI state serialization stubs for Full HMR capability");
            let fname = split_data.get("gui")
                .and_then(|s| s["filename"].as_str())
                .unwrap_or("gui.cpp");
            
            // Use the already-processed content from Phase 1 (guardrails already applied)
            let content = processed_gui.clone();
            
            // Hash content + core_lib_path dependency
            let combined_hash = calculate_hash(&(content.clone(), &core_lib_path));
            
            // Try content-addressable cache first (persists across sessions)
            let gui_cache_key = IncrementalCache::cache_key(&content, &["-shared", "-fPIC", "-lSDL2"], &[]);
            if let Some(cached_so) = incremental_cache.get(&gui_cache_key).await {
                gui_lib_path = cached_so.to_string_lossy().to_string();
                eprintln!("[Cache] HIT for gui module (persistent cache)");
                println!("Using cached gui library: {}", gui_lib_path);
            } else {
                // Cache miss - need to compile
                tokio::fs::write(dir_path.join(fname), &content).await?;
                
                let gui_out = output_dir.join(format!("libgui_{}.{}", timestamp, ext));
                let mut cmd = system_command("g++");
                cmd.arg("-shared").arg("-fPIC")
                   .arg("-D_POSIX_C_SOURCE=199309L")
                   // Debug flags for source map generation
                   .arg("-g").arg("-gdwarf-4").arg("-fno-omit-frame-pointer")
                   // Add JSON diagnostics flag for structured error parsing
                   .arg("-fdiagnostics-format=json")
                   .arg(fname).arg("-I.").arg("-o").arg(&gui_out)
                   .arg("-ldl")
                   // Export symbols for backtracing
                   .arg("-rdynamic");
                
                if req.is_gui {
                    cmd.arg("-lSDL2");
                }
                // User requested dynamic loading via dlopen/dlsym, so we do NOT link core directly.
                // if !core_lib_path.is_empty() {
                //    cmd.arg(&core_lib_path);
                // }

                cmd.current_dir(&dir_path);
                
                let output = cmd.output().await?;
                if !output.status.success() {
                     let stderr = String::from_utf8_lossy(&output.stderr);
                     
                     // Parse compiler output into structured diagnostics
                     let diag_report = parse_compiler_output(&stderr, "gui", CompilerType::Gcc, true);
                     let diag_event = DiagnosticEvent::new("gui", diag_report.clone())
                         .with_session(session_id.clone().unwrap_or_default());
                     
                     // Send structured diagnostics
                     let diag_payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "compile-diagnostics",
                        "data": serde_json::from_str::<serde_json::Value>(&diag_event.to_json()).unwrap_or_default()
                     });
                     let _ = log_dc.send_text(serde_json::to_string(&diag_payload).unwrap_or_default()).await;
                     
                     // Send compile error HMR status - rollback behavior keeps old module
                     let status = HmrStatus::compile_error("gui", vec![stderr.to_string()]);
                     let hmr_payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "hmr-status",
                        "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                     });
                     let _ = log_dc.send_text(serde_json::to_string(&hmr_payload).unwrap_or_default()).await;
                     
                     // If we have an existing runner with the old gui, keep it running (rollback)
                     {
                         let guard = runner_store.lock().await;
                         if let Some(state) = guard.as_ref() {
                             if state.loaded_gui_path.is_some() {
                                 let rejected = HmrStatus::rejected("gui", "Compilation failed - keeping previous GUI module");
                                 let payload = serde_json::json!({
                                     "sessionId": session_id.clone(),
                                     "type": "hmr-status",
                                     "data": serde_json::from_str::<serde_json::Value>(&rejected.to_json()).unwrap_or_default()
                                 });
                                 let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                 eprintln!("[Rollback] GUI compile failed, keeping old module running");
                                 
                                 // Don't fail the whole operation - just skip GUI update
                                 // The core will continue running with the old GUI
                             }
                         }
                     }
                     
                     let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "status": "done",
                        "success": false,
                        "stage": "compile_gui",
                        "error": stderr
                    });
                    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                    return Ok(());
                }
                gui_lib_path = gui_out.to_string_lossy().to_string();
                
                // Detect GUI module capabilities from exports
                if let Ok(gui_report) = detect_capabilities(std::path::Path::new(&gui_lib_path)) {
                    eprintln!("[Capability] GUI module: {:?}, HMR: {:?}", gui_report.module_type, gui_report.hmr_capability);
                    let status = HmrStatus::capability_detected("gui", &gui_report);
                    let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "hmr-status",
                        "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                    });
                    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                }

                // Hash content + core_lib_path dependency
                let combined_hash = calculate_hash(&(content.clone(), &core_lib_path));

                // Try content-addressable cache first (persists across sessions)
                let gui_cache_key =
                    IncrementalCache::cache_key(&content, &["-shared", "-fPIC", "-lSDL2"], &[]);
                if let Some(cached_so) = incremental_cache.get(&gui_cache_key).await {
                    gui_lib_path = cached_so.to_string_lossy().to_string();
                    eprintln!("[Cache] HIT for gui module (persistent cache)");
                    println!("Using cached gui library: {}", gui_lib_path);
                } else {
                    // Cache miss - need to compile
                    tokio::fs::write(dir_path.join(fname), &content).await?;

                    let gui_out = output_dir.join(format!("libgui_{}.{}", timestamp, ext));
                    let mut cmd = system_command("g++");
                    cmd.arg("-shared")
                        .arg("-fPIC")
                        .arg("-D_POSIX_C_SOURCE=199309L")
                        // Debug flags for source map generation
                        .arg("-g")
                        .arg("-gdwarf-4")
                        .arg("-fno-omit-frame-pointer")
                        // Add JSON diagnostics flag for structured error parsing
                        .arg("-fdiagnostics-format=json")
                        .arg(fname)
                        .arg("-I.")
                        .arg("-o")
                        .arg(&gui_out)
                        .arg("-ldl")
                        // Export symbols for backtracing
                        .arg("-rdynamic");

                    if req.is_gui {
                        cmd.arg("-lSDL2");
                    }
                    // User requested dynamic loading via dlopen/dlsym, so we do NOT link core directly.
                    // if !core_lib_path.is_empty() {
                    //    cmd.arg(&core_lib_path);
                    // }

                    cmd.current_dir(&dir_path);

                    let output = cmd.output().await?;
                    if !output.status.success() {
                        let stderr = String::from_utf8_lossy(&output.stderr);

                        // Parse compiler output into structured diagnostics
                        let diag_report =
                            parse_compiler_output(&stderr, "gui", CompilerType::Gcc, true);
                        let diag_event = DiagnosticEvent::new("gui", diag_report.clone())
                            .with_session(session_id.clone().unwrap_or_default());

                        // Send structured diagnostics
                        let diag_payload = serde_json::json!({
                           "sessionId": session_id.clone(),
                           "type": "compile-diagnostics",
                           "data": serde_json::from_str::<serde_json::Value>(&diag_event.to_json()).unwrap_or_default()
                        });
                        let _ = log_dc
                            .send_text(serde_json::to_string(&diag_payload).unwrap_or_default())
                            .await;

                        // Send compile error HMR status - rollback behavior keeps old module
                        let status =
                            CapabilityHmrStatus::compile_error("gui", vec![stderr.to_string()]);
                        let hmr_payload = serde_json::json!({
                           "sessionId": session_id.clone(),
                           "type": "hmr-status",
                           "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                        });
                        let _ = log_dc
                            .send_text(serde_json::to_string(&hmr_payload).unwrap_or_default())
                            .await;

                        // If we have an existing runner with the old gui, keep it running (rollback)
                        {
                            let guard = runner_store.lock().await;
                            if let Some(state) = guard.as_ref() {
                                if state.loaded_gui_path.is_some() {
                                    let rejected = CapabilityHmrStatus::rejected(
                                        "gui",
                                        "Compilation failed - keeping previous GUI module",
                                    );
                                    let payload = serde_json::json!({
                                        "sessionId": session_id.clone(),
                                        "type": "hmr-status",
                                        "data": serde_json::from_str::<serde_json::Value>(&rejected.to_json()).unwrap_or_default()
                                    });
                                    let _ = log_dc
                                        .send_text(
                                            serde_json::to_string(&payload).unwrap_or_default(),
                                        )
                                        .await;
                                    eprintln!(
                                        "[Rollback] GUI compile failed, keeping old module running"
                                    );

                                    // Don't fail the whole operation - just skip GUI update
                                    // The core will continue running with the old GUI
                                }
                            }
                        }

                        let payload = serde_json::json!({
                            "sessionId": session_id.clone(),
                            "status": "done",
                            "success": false,
                            "stage": "compile_gui",
                            "error": stderr
                        });
                        let _ = log_dc
                            .send_text(serde_json::to_string(&payload).unwrap_or_default())
                            .await;
                        return Ok(());
                    }
                    gui_lib_path = gui_out.to_string_lossy().to_string();

                    // Detect GUI module capabilities from exports
                    if let Ok(gui_report) = detect_capabilities(std::path::Path::new(&gui_lib_path))
                    {
                        eprintln!(
                            "[Capability] GUI module: {:?}, HMR: {:?}",
                            gui_report.module_type, gui_report.hmr_capability
                        );
                        let status = CapabilityHmrStatus::capability_detected("gui", &gui_report);
                        let payload = serde_json::json!({
                            "sessionId": session_id.clone(),
                            "type": "hmr-status",
                            "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                        });
                        let _ = log_dc
                            .send_text(serde_json::to_string(&payload).unwrap_or_default())
                            .await;
                    }

                    // Store in persistent content-addressable cache
                    if let Ok(so_data) = tokio::fs::read(&gui_lib_path).await {
                        let source_hash = combined_hash;
                        let flags_hash = calculate_hash(&"-shared-fPIC-lSDL2");
                        let headers_hash = 0u64;
                        if let Err(e) = incremental_cache
                            .put(
                                gui_cache_key.clone(),
                                source_hash,
                                flags_hash,
                                headers_hash,
                                &so_data,
                            )
                            .await
                        {
                            eprintln!("[Cache] Failed to store gui in persistent cache: {}", e);
                        } else {
                            eprintln!("[Cache] Stored gui module in persistent cache");
                        }
                    }

                    // Also update legacy in-memory cache for fast path
                    let mut cache = compile_cache.lock().await;
                    cache.insert("gui".to_string(), (combined_hash, gui_lib_path.clone()));

                    // ============================================================
                    // WIDGET-LEVEL GRANULARITY: Detect and compile widgets separately
                    // ============================================================
                    // If GUI source contains multiple widgets/components, compile each
                    // as a separate .so for finer-grained HMR (like Next.js component-level refresh)
                    let widget_compiler = WidgetCompiler::new(output_dir.clone());
                    let widget_analysis = WidgetDetector::new().analyze(&content, fname);

                    if widget_analysis.widgets.len() > 1 {
                        eprintln!(
                            "[Widget HMR] Detected {} widgets in GUI code - compiling separately",
                            widget_analysis.widgets.len()
                        );

                        // Notify frontend of widget detection
                        let widget_names: Vec<String> = widget_analysis
                            .widgets
                            .iter()
                            .map(|w| w.id.clone())
                            .collect();
                        let payload = serde_json::json!({
                            "sessionId": session_id.clone(),
                            "type": "hmr-status",
                            "data": {
                                "status": "widgets-detected",
                                "count": widget_analysis.widgets.len(),
                                "widgets": widget_names,
                                "message": format!("Detected {} widgets for component-level HMR", widget_analysis.widgets.len())
                            }
                        });
                        let _ = log_dc
                            .send_text(serde_json::to_string(&payload).unwrap_or_default())
                            .await;

                        // Get previous widget hashes for differential rebuild
                        let prev_widget_hashes = {
                            let guard = runner_store.lock().await;
                            if let Some(state) = guard.as_ref() {
                                state.widget_hashes.clone()
                            } else {
                                HashMap::new()
                            }
                        };

                        // Compile widgets with base flags
                        let base_flags: Vec<&str> = vec![
                            "-fPIC",
                            "-g",
                            "-gdwarf-4",
                            "-fno-omit-frame-pointer",
                            "-D_POSIX_C_SOURCE=199309L",
                        ];

                        match widget_compiler
                            .compile_widgets(&content, fname, "g++", &base_flags)
                            .await
                        {
                            Ok(widget_results) => {
                                let mut widgets_loaded: Vec<(String, String)> = Vec::new();
                                let mut widgets_skipped = 0;
                                let mut widgets_failed = 0;

                                for result in &widget_results {
                                    if result.success {
                                        if let Some(ref so_path) = result.so_path {
                                            // Check if widget actually changed (compare hashes)
                                            let widget_hash = hash_content(&result.widget_id);
                                            if let Some(&prev_hash) =
                                                prev_widget_hashes.get(&result.widget_id)
                                            {
                                                if prev_hash == widget_hash {
                                                    widgets_skipped += 1;
                                                    continue; // Skip unchanged widget
                                                }
                                            }

                                            let path_str = so_path.to_string_lossy().to_string();
                                            widgets_loaded
                                                .push((result.widget_id.clone(), path_str.clone()));

                                            // Notify frontend of individual widget compile
                                            let payload = serde_json::json!({
                                                "sessionId": session_id.clone(),
                                                "type": "hmr-status",
                                                "data": {
                                                    "status": "widget-compiled",
                                                    "widget_id": result.widget_id,
                                                    "duration_ms": result.duration_ms,
                                                    "path": path_str
                                                }
                                            });
                                            let _ = log_dc
                                                .send_text(
                                                    serde_json::to_string(&payload)
                                                        .unwrap_or_default(),
                                                )
                                                .await;
                                        }
                                    } else {
                                        widgets_failed += 1;
                                        eprintln!(
                                            "[Widget HMR] Widget '{}' failed: {:?}",
                                            result.widget_id, result.error
                                        );

                                        // Notify frontend of widget compile failure
                                        let payload = serde_json::json!({
                                            "sessionId": session_id.clone(),
                                            "type": "hmr-status",
                                            "data": {
                                                "status": "widget-compile-error",
                                                "widget_id": result.widget_id,
                                                "error": result.error
                                            }
                                        });
                                        let _ = log_dc
                                            .send_text(
                                                serde_json::to_string(&payload).unwrap_or_default(),
                                            )
                                            .await;
                                    }
                                }

                                // Summary notification
                                let payload = serde_json::json!({
                                    "sessionId": session_id.clone(),
                                    "type": "hmr-status",
                                    "data": {
                                        "status": "widgets-compiled",
                                        "loaded": widgets_loaded.len(),
                                        "skipped": widgets_skipped,
                                        "failed": widgets_failed,
                                        "message": format!("Widget HMR: {} loaded, {} unchanged, {} failed",
                                            widgets_loaded.len(), widgets_skipped, widgets_failed)
                                    }
                                });
                                let _ = log_dc
                                    .send_text(serde_json::to_string(&payload).unwrap_or_default())
                                    .await;

                                // Add widgets to modules_to_load
                                for (widget_id, path) in widgets_loaded {
                                    modules_to_load.push((format!("widget:{}", widget_id), path));
                                }
                            }
                            Err(e) => {
                                eprintln!("[Widget HMR] Widget compilation failed: {}", e);
                                // Fall back to whole-GUI compilation (already done above)
                            }
                        }
                    }
                }
                if !gui_lib_path.is_empty() {
                    // Create symlinks/copies with both gui and libgui names so user code that dlopens either path succeeds
                    #[cfg(unix)]
                    {
                        for name in ["gui.so", "libgui.so"] {
                            let link_path = dir_path.join(name);
                            let _ = tokio::fs::remove_file(&link_path).await;
                            if let Err(e) = tokio::fs::symlink(&gui_lib_path, &link_path).await {
                                println!("Failed to create {} symlink: {}", name, e);
                            }
                        }
                    }
                    #[cfg(windows)]
                    {
                        for name in ["gui.dll", "libgui.dll"] {
                            let link_path = dir_path.join(name);
                            let _ = tokio::fs::remove_file(&link_path).await;
                            if let Err(e) = tokio::fs::copy(&gui_lib_path, &link_path).await {
                                println!("Failed to copy {}: {}", name, e);
                            }
                        }
                    }

                    // ============================================================
                    // INDEPENDENT SWAP DOMAINS: GUI is a separate hot-reload unit
                    // ============================================================
                    // GUI and Core are TWO INDEPENDENT modules. Changing GUI should
                    // NOT force a core reload. The runner handles them separately.
                    //
                    // OLD BEHAVIOR (REMOVED): Force core reload when GUI changes
                    // NEW BEHAVIOR: Load GUI independently via runner's "load gui" command
                    //
                    // The runner maintains separate module slots for "core" and "gui".
                    // Each module has its own state (CoreState, GuiState) and its own
                    // on_load/on_unload lifecycle.
                    //
                    // Core's dlopen of gui.so happens in core's on_load. When we send
                    // "load gui" to runner, core will re-dlopen the updated gui.so
                    // on its next on_update cycle (via a reload signal mechanism).
                    // ============================================================

                    // Add GUI to modules_to_load as an INDEPENDENT module
                    // The runner will load it separately from core
                    modules_to_load.push(("gui".to_string(), gui_lib_path.clone()));
                    println!(
                        "[Independent Swap] GUI module queued for independent reload: {}",
                        gui_lib_path
                    );
                }
            } else {
                // Reuse existing GUI path if not rebuilding
                if let Some(ref existing_gui) = _prev_gui_path {
                    gui_lib_path = existing_gui.clone();
                    println!("Reusing existing GUI at {}", gui_lib_path);
                }
            }
        }

        // Fallback: if AI produced no GUI module, emit a minimal stub so ptr_gui_render is non-null.
        if gui_lib_path.is_empty() && req.is_gui {
            let stub_name = "gui_stub.cpp";
            let stub_src = r#"#include <SDL2/SDL.h>
            extern "C" void gui_initialize(void*) {}
            extern "C" void gui_on_update(void*, float) {}
            extern "C" void gui_render(void* state) {
                SDL_Renderer* r = (SDL_Renderer*)state;
                if (!r) return;
                SDL_SetRenderDrawColor(r, 0, 0, 0, 255);
                SDL_RenderClear(r);
            }
            extern "C" void gui_cleanup(void*) {}
            extern "C" void gui_on_event(void*, void*) {}
            "#;
            tokio::fs::write(dir_path.join(stub_name), stub_src).await?;

            let gui_out = output_dir.join(format!("libgui_stub_{}.{}", timestamp, ext));
            let mut cmd = system_command("g++");
            cmd.arg("-shared")
                .arg("-fPIC")
                .arg("-D_POSIX_C_SOURCE=199309L")
                .arg(stub_name)
                .arg("-I.")
                .arg("-o")
                .arg(&gui_out)
                .arg("-lSDL2");
            cmd.current_dir(&dir_path);
            let output = cmd.output().await?;
            if output.status.success() {
                gui_lib_path = gui_out.to_string_lossy().to_string();
                #[cfg(unix)]
                {
                    for name in ["gui.so", "libgui.so"] {
                        let link_path = dir_path.join(name);
                        let _ = tokio::fs::remove_file(&link_path).await;
                        let _ = tokio::fs::symlink(&gui_lib_path, &link_path).await;
                    }
                }
                #[cfg(windows)]
                {
                    for name in ["gui.dll", "libgui.dll"] {
                        let link_path = dir_path.join(name);
                        let _ = tokio::fs::remove_file(&link_path).await;
                        let _ = tokio::fs::copy(&gui_lib_path, &link_path).await;
                    }
                }
                // Independent swap: Add stub GUI as independent module
                modules_to_load.push(("gui".to_string(), gui_lib_path.clone()));
                println!("[Independent Swap] GUI stub module queued for independent reload");
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                println!("Failed to build GUI stub: {}", stderr);
            }
        }
    } else {
        // ============================================================
        // AUTO-SHIM PIPELINE: Make blocking code HMR-capable
        // ============================================================
        // This is the key to "Next.js-like" HMR that works without users
        // needing to structure their code in a specific way.
        // ============================================================
        let mut shimmed_filename = req.filename.clone();
        let mut shim_applied = false;

        if req.language == "cpp" || req.language == "cpp_legacy" {
            let shim_config = detect_shim_mode(&source_code);

            if shim_config.mode != ShimMode::None {
                eprintln!(
                    "[Shim] Applying auto-shim mode: {:?} (has_gui: {})",
                    shim_config.mode, shim_config.has_gui
                );

                let shim_result = auto_shim(&source_code);
                let shimmed_source = shim_result.source;

                // Write additional shim files (e.g., headers)
                for (fname, content) in &shim_result.additional_files {
                    let shim_file_path = dir_path.join(fname);
                    if let Err(e) = tokio::fs::write(&shim_file_path, content).await {
                        eprintln!("[Shim] Failed to write {}: {}", fname, e);
                    } else {
                        eprintln!("[Shim] Wrote additional file: {}", fname);
                    }
                }

                // Write shimmed source with a new filename
                // Handle paths correctly: test/main.cpp -> test/shimmed_main.cpp
                let original_path = std::path::Path::new(&req.filename);
                let parent = original_path.parent().unwrap_or(std::path::Path::new(""));
                let file_stem = original_path.file_stem().unwrap_or_default();
                let extension = original_path.extension().unwrap_or_default();
                
                let new_filename = format!("shimmed_{}.{}", 
                    file_stem.to_string_lossy(), 
                    extension.to_string_lossy()
                );
                
                let shimmed_rel_path = parent.join(new_filename);
                shimmed_filename = shimmed_rel_path.to_string_lossy().to_string();
                
                let shimmed_path = dir_path.join(&shimmed_filename);
                
                // Ensure parent directory exists (though it should for the original file)
                if let Some(p) = shimmed_path.parent() {
                    tokio::fs::create_dir_all(p).await?;
                }
                
                tokio::fs::write(&shimmed_path, &shimmed_source).await?;

                // Notify frontend about shim application
                let payload = serde_json::json!({
                    "sessionId": session_id.clone(),
                    "type": "hmr-status",
                    "data": {
                        "status": "shim-applied",
                        "mode": format!("{:?}", shim_config.mode),
                        "message": "Auto-shim applied to make code HMR-capable"
                    }
                });
                let _ = log_dc
                    .send_text(serde_json::to_string(&payload).unwrap_or_default())
                    .await;

                shim_applied = true;
            } else {
                eprintln!("[Shim] Code already HMR-compatible, no shim needed");
            }
        }

        let compile_filename = if shim_applied { &shimmed_filename } else { &req.filename };
        
        // Ensure path separators are correct for the OS
        // e.g., on Windows/WSL mixed envs, we might need to be careful, but these are relative paths
        
        let mut cmd = match req.language.as_str() {
            "cpp" | "cpp_legacy" => {
                let mut c = system_command("g++");
                c.arg("-shared").arg("-fPIC").arg("-D_POSIX_C_SOURCE=199309L");
                
                // Add -pthread for shimming support
                c.arg("-pthread");

                // Output to temp path for atomic swap
                c.arg(compile_filename).arg("-I.").arg("-o").arg(&temp_output_path_str);
                
                // CRITICAL: Always link pthread for shimmed apps
                if shim_applied {
                    c.arg("-lpthread");
                }
                if req.is_gui {
                    c.arg("-lSDL2").arg("-lX11");
                }
                apply_build_directives(&req.source, &mut c);
                c
            }
            "rust" => {
                let mut c = system_command("rustc");
                c.arg("--crate-type").arg("cdylib");
                // Output to temp path for atomic swap
                c.arg(&req.filename).arg("-o").arg(&temp_output_path_str);
                if req.is_gui {
                    c.arg("-l").arg("SDL2");
                }
                c
            }
            "ts" => {
                let mut c = system_command("tsc");
                c.arg(&req.filename);
                c
            }
            _ => return Ok(()),
        };
        cmd.current_dir(&dir_path);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take().map(BufReader::new);
        let stderr = child.stderr.take().map(BufReader::new);

        if let Some(mut out) = stdout {
            let dc = log_dc.clone();
            let sid = session_id.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 1024];
                loop {
                    match out.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                            let payload = serde_json::json!({
                                "sessionId": sid.clone(),
                                "type": "stdout",
                                "line": chunk
                            });
                            let txt = serde_json::to_string(&payload)
                                .unwrap_or_else(|_| String::from(""));
                            let _ = dc.send_text(txt).await;
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        if let Some(mut err) = stderr {
            let dc = log_dc.clone();
            let sid = session_id.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 1024];
                loop {
                    match err.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                            let payload = serde_json::json!({
                                "sessionId": sid.clone(),
                                "type": "stderr",
                                "line": chunk
                            });
                            let txt = serde_json::to_string(&payload)
                                .unwrap_or_else(|_| String::from(""));
                            let _ = dc.send_text(txt).await;
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let compile_status = child.wait().await?;

        // If compile failed, send status and return
        if !compile_status.success() {
            // Send compile error HMR status for UI feedback
            let status =
                CapabilityHmrStatus::compile_error("main", vec!["Compilation failed".to_string()]);
            let hmr_payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "hmr-status",
                "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
            });
            let _ = log_dc
                .send_text(serde_json::to_string(&hmr_payload).unwrap_or_default())
                .await;

            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "status": "done",
                "success": false,
                "stage": "compile",
                "code": compile_status.code()
            });
            let _ = log_dc
                .send_text(serde_json::to_string(&payload).unwrap_or_else(|_| String::from("")))
                .await;
            return Ok(());
        }

        // Phase 3: Atomic Swap
        // Rename temp file to final filename
        if let Err(e) = tokio::fs::rename(&temp_output_path, &final_output_path).await {
            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "status": "done",
                "success": false,
                "stage": "compile",
                "code": 1,
                "error": format!("Failed to rename temp file: {}", e)
            });
            let _ = log_dc
                .send_text(serde_json::to_string(&payload).unwrap_or_else(|_| String::from("")))
                .await;
            return Ok(());
        }

        // ============================================================
        // EXPORT-BASED CAPABILITY DETECTION (replaces string heuristics)
        // ============================================================
        // After compilation succeeds, inspect the compiled library's actual
        // exports to determine HMR capability deterministically.
        // This is the Next.js-like approach: detect from artifacts, not source.
        // ============================================================
        let capability_report = match detect_capabilities(&final_output_path) {
            Ok(report) => {
                eprintln!(
                    "[Capability] Module type: {:?}, HMR: {:?}",
                    report.module_type, report.hmr_capability
                );

                // Send capability detection result to frontend
                let status = CapabilityHmrStatus::capability_detected("main", &report);
                let payload = serde_json::json!({
                    "sessionId": session_id.clone(),
                    "type": "hmr-status",
                    "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                });
                let _ = log_dc
                    .send_text(serde_json::to_string(&payload).unwrap_or_default())
                    .await;

                // Send warnings to frontend
                for warning in &report.warnings {
                    let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "stderr",
                        "line": format!("[HMR Warning] {}\n", warning)
                    });
                    let _ = log_dc
                        .send_text(serde_json::to_string(&payload).unwrap_or_default())
                        .await;
                }

                Some(report)
            }
            Err(e) => {
                eprintln!("[Capability] Detection failed: {}", e);
                let payload = serde_json::json!({
                    "sessionId": session_id.clone(),
                    "type": "stderr",
                    "line": format!("[Capability] Detection failed: {}\n", e)
                });
                let _ = log_dc
                    .send_text(serde_json::to_string(&payload).unwrap_or_default())
                    .await;
                None
            }
        };

        // Update has_on_update based on ACTUAL exports (not source heuristics)
        let has_on_update = capability_report
            .as_ref()
            .map(|r| r.hmr_capability.supports_hmr())
            .unwrap_or(false);

        eprintln!("[Capability] Export-based HMR capable: {}", has_on_update);

        // ============================================================
        // HARD POLICY: HMR vs Full Reload Decision
        // ============================================================
        // Make "HMR vs full reload" a hard policy, not best-effort.
        // If blocking or ABI mismatch → explicitly emit "full reload required"
        // ============================================================
        let _require_full_reload = if let Some(ref report) = capability_report {
            match report.hmr_capability {
                HmrCapability::Blocking => {
                    eprintln!("[Policy] Blocking app detected - full reload required");
                    let status = CapabilityHmrStatus::FullReloadRequired {
                        reason: "Blocking app (no on_update loop). Cannot hot-reload.".to_string(),
                    };
                    let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "hmr-status",
                        "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                    });
                    let _ = log_dc
                        .send_text(serde_json::to_string(&payload).unwrap_or_default())
                        .await;
                    true
                }
                HmrCapability::Invalid => {
                    eprintln!("[Policy] Invalid module (missing exports) - full reload required");
                    let status = CapabilityHmrStatus::FullReloadRequired {
                        reason: "Invalid module (missing required exports).".to_string(),
                    };
                    let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "hmr-status",
                        "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                    });
                    let _ = log_dc
                        .send_text(serde_json::to_string(&payload).unwrap_or_default())
                        .await;
                    true
                }
                _ => false,
            }
        } else {
            // Capability detection failed - be conservative
            eprintln!("[Policy] Capability detection failed - assuming full reload required");
            true
        };

        // Check ABI version mismatch with existing runner
        let _abi_mismatch = if let Some(ref report) = capability_report {
            let guard_check = runner_store.lock().await;
            if let Some(state) = guard_check.as_ref() {
                if let Some(existing_cap) = &state.hmr_capability {
                    // Compare ABI versions if available
                    let existing_abi = match existing_cap {
                        HmrCapability::Full | HmrCapability::Partial => Some(1), // Placeholder
                        _ => None,
                    };
                    let new_abi = report.abi_version;
                    if existing_abi.is_some() && new_abi.is_some() && existing_abi != new_abi {
                        eprintln!(
                            "[Policy] ABI version mismatch: {:?} vs {:?} - full reload required",
                            existing_abi, new_abi
                        );
                        let status = CapabilityHmrStatus::FullReloadRequired {
                            reason: format!(
                                "ABI version mismatch ({:?} vs {:?})",
                                existing_abi, new_abi
                            ),
                        };
                        let payload = serde_json::json!({
                            "sessionId": session_id.clone(),
                            "type": "hmr-status",
                            "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                        });
                        let _ = log_dc
                            .send_text(serde_json::to_string(&payload).unwrap_or_default())
                            .await;
                        true
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

        modules_to_load.push((
            "main".to_string(),
            final_output_path.to_string_lossy().to_string(),
        ));

        // Store the policy decisions for use in runner logic
        // These are declared outside the else block but assigned here
    }

    // Unified Runner Logic
    if modules_to_load.is_empty() {
        return Ok(());
    }

    let mut guard = runner_store.lock().await;

    // Check if we need to restart due to GUI mode change or blocking app
    // We restart if:
    // 1. GUI mode changed (need to start/stop Xvfb)
    // 2. App is blocking (no on_update), so the runner is blocked and can't accept new commands.
    // 3. Hard policy requires full reload (blocking app, ABI mismatch, invalid module)
    // NOTE: If use_ai_split is true, the app is HMR-capable, so we should NOT restart just for code updates
    let is_blocking_app = !has_on_update;
    let req_width = req.width.unwrap_or(1280);
    let req_height = req.height.unwrap_or(720);

    eprintln!(
        "[Main] Restart check: is_gui={}, has_on_update={}, is_blocking_app={}, use_ai_split={}",
        req.is_gui, has_on_update, is_blocking_app, use_ai_split
    );

    // Reuse Xvfb/GStreamer if possible
    let mut reused_xvfb: Option<tokio::process::Child> = None;
    let mut reused_pipeline: Option<gst::Pipeline> = None;
    let mut reused_wsl_display = String::new();
    let mut reused_gst_display = String::new();
    let mut reused_sdl_tx: Option<mpsc::UnboundedSender<String>> = None;
    let mut video_track_opt: Option<Arc<TrackLocalStaticRTP>> = None;
    let mut audio_track_opt: Option<Arc<TrackLocalStaticRTP>> = None;

    // Determine if we have an existing runner that can handle HMR
    // HARD POLICY: If is_blocking_app is true, we CANNOT do HMR - must restart runner
    let existing_runner_can_hmr = if is_blocking_app {
        // Hard policy: blocking apps require full restart
        eprintln!("[Policy] Hard policy: blocking app requires full restart, HMR disabled");
        false
    } else if let Some(state) = guard.as_ref() {
        // Can do HMR if:
        // 1. GUI mode is the same
        // 2. Resolution is the same
        // 3. The app supports HMR (has_on_update is true) - already checked above
        let gui_mode_same = state.is_gui == req.is_gui;
        let resolution_same = state.width == req_width && state.height == req_height;
        eprintln!("[Main] Existing runner: is_gui={}, gui_mode_same={}, resolution_same={}, has_on_update={}", 
            state.is_gui, gui_mode_same, resolution_same, has_on_update);
        gui_mode_same && resolution_same && has_on_update
    } else {
        false
    };

    // If we can do HMR, skip all the restart/initialization logic and just send load commands
    if existing_runner_can_hmr {
        eprintln!("[Main] ╔═══════════════════════════════════════════════════════════╗");
        eprintln!("[Main] ║  HMR MODE: Reusing existing runner - NO RESTART          ║");
        eprintln!("[Main] ╚═══════════════════════════════════════════════════════════╝");
        eprintln!(
            "[Main] HMR mode: Skipping track attachment and output subscription (already set up)"
        );
    } else if let Some(state) = guard.as_mut() {
        // We have an existing runner but can't do HMR - need to restart
        let gui_mode_changed = state.is_gui != req.is_gui;
        eprintln!(
            "[Main] Restarting runner: gui_mode_changed={}, is_blocking_app={}, use_ai_split={}",
            gui_mode_changed, is_blocking_app, use_ai_split
        );

        // If resolution matches and is_gui matches, we can reuse Xvfb/GStreamer
        let can_reuse =
            state.is_gui == req.is_gui && state.width == req_width && state.height == req_height;

        let state = guard.take().unwrap();
        if let Some(mut child) = state.process {
            println!("Killing old runner process...");
            let _ = child.kill().await;
        }

        if can_reuse {
            println!("Reusing Xvfb and GStreamer pipeline...");
            reused_xvfb = state.xvfb_process;
            reused_pipeline = state.gst_pipeline;
            reused_wsl_display = state.wsl_display_str;
            reused_gst_display = state.gst_display_str;
            reused_sdl_tx = state.sdl_tx;
            video_track_opt = state.video_track;
            audio_track_opt = state.audio_track;
        } else {
            println!("Full restart (resolution/GUI mode changed)...");
            if let Some(mut child) = state.xvfb_process {
                let _ = child.kill().await;
            }
            if let Some(pipeline) = state.gst_pipeline {
                let _ = pipeline.set_state(gst::State::Null);
            }
        }
    }

    // Only start a new runner if we don't have one (either first run, or after restart)
    // Skip this entire block if we can do HMR with the existing runner
    if !existing_runner_can_hmr && guard.is_none() {
        // Start runner
        println!("Starting persistent runner...");

        let mut wsl_display_str = reused_wsl_display;
        let mut gst_display_str = reused_gst_display;
        let xvfb_process: Option<tokio::process::Child> = reused_xvfb;
        let mut gst_pipeline: Option<gst::Pipeline> = reused_pipeline;
        let mut sdl_tx_opt: Option<mpsc::UnboundedSender<String>> = reused_sdl_tx;
        let mut video_src_opt: Option<gst_app::AppSrc> = None;

        if req.is_gui {
            let width = req_width;
            let height = req_height;

            if xvfb_process.is_none() {
                for tool in GUI_TOOLS {
                    if Command::new(tool).arg("--version").output().await.is_err() {
                        let msg = format!("Error: GUI tool '{}' is missing. GUI apps require Linux/WSL with xdotool, Xvfb, and matchbox-window-manager installed.\n", tool);
                        let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "stderr",
                        "line": msg
                        });
                        let _ = log_dc
                            .send_text(serde_json::to_string(&payload).unwrap_or_default())
                            .await;
                        return Ok(());
                    }
                }

                let _resolution = format!("{}x{}x24", width, height);

                // Xvfb removed - using SDL2 offscreen rendering
                wsl_display_str = "".to_string();
                gst_display_str = "".to_string();
                println!("Falling back to DISPLAY {}", wsl_display_str);
            }

            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            // For SDL2 headless, we might not need a window manager if we use a dummy video driver or Xvfb
            // But keeping matchbox for now as SDL2 on Linux often runs on top of X11/Xvfb
            // Matchbox removed

            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

            let (v_tx, mut v_rx) = mpsc::unbounded_channel::<Vec<u8>>();
            let (a_tx, mut a_rx) = mpsc::unbounded_channel::<Vec<u8>>();

            let encoders = [
                // H264 first - universal browser support
                ("nvh264enc preset=low-latency-hp zerolatency=true", "rtph264pay", "video/H264"),
                ("vaapih264enc", "rtph264pay", "video/H264"),
                ("msdkh264enc", "rtph264pay", "video/H264"),
                ("amfh264enc", "rtph264pay", "video/H264"),
                ("d3d11h264enc", "rtph264pay", "video/H264"),
                ("x264enc tune=zerolatency speed-preset=ultrafast bitrate=2000 key-int-max=60 ! video/x-h264,stream-format=byte-stream", "rtph264pay", "video/H264"),

                // H265 - limited browser support (Safari only)
                ("nvh265enc preset=low-latency-hp zerolatency=true", "rtph265pay", "video/H265"),
                ("vaapih265enc", "rtph265pay", "video/H265"),
                ("msdkh265enc", "rtph265pay", "video/H265"),
                ("amfh265enc", "rtph265pay", "video/H265"),
                ("d3d11h265enc", "rtph265pay", "video/H265"),
                ("x265enc tune=zerolatency speed-preset=ultrafast bitrate=2000 key-int-max=60 ! video/x-h265,stream-format=byte-stream", "rtph265pay", "video/H265")
            ];

            let mut selected_mime_type = "video/H264".to_owned();
            let mut audio_source = "pulsesrc".to_string();
            let mut encoder_idx = 0;

            while encoder_idx < encoders.len() {
                let (encoder, payloader, mime_type) = encoders[encoder_idx];
                if mime_type == "video/H265" && req.supports_h265 == Some(false) {
                    encoder_idx += 1;
                    continue;
                }

                let gst_pipeline_str = format!(
                    "appsrc name=video_src format=time is-live=true do-timestamp=true ! video/x-raw,format=BGRx,width=800,height=600,framerate=30/1 ! queue ! videoconvert ! {} ! {} config-interval=-1 ! queue ! appsink name=video_sink drop=true max-buffers=100 \
                        {} ! audio/x-raw,rate=48000,channels=2 ! queue ! opusenc ! rtpopuspay ! queue ! appsink name=audio_sink drop=true max-buffers=100",
                    encoder, payloader, audio_source
                );

                match gst::parse_launch(&gst_pipeline_str) {
                    Ok(pipeline) => {
                        let pipeline = pipeline
                            .downcast::<gst::Pipeline>()
                            .expect("Expected pipeline");
                        let video_src = pipeline
                            .by_name("video_src")
                            .expect("Source not found")
                            .downcast::<gst_app::AppSrc>()
                            .expect("Expected AppSrc");

                        let v_tx_clone = v_tx.clone();
                        if let Ok(video_sink) = pipeline
                            .by_name("video_sink")
                            .context("Sink not found")
                            .and_then(|s| {
                                s.downcast::<gst_app::AppSink>()
                                    .map_err(|_| anyhow::anyhow!("Expected AppSink"))
                            })
                        {
                            let sink_sample_count =
                                std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
                            let sink_sample_count_clone = sink_sample_count.clone();
                            video_sink.set_callbacks(
                                gst_app::AppSinkCallbacks::builder()
                                    .new_sample(move |sink| {
                                        let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                                        let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                                        let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                                        let count = sink_sample_count_clone.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                        if count % 300 == 0 {
                                            eprintln!("[GStreamer] video_sink received sample #{}, size={} bytes", count, map.len());
                                        }
                                        match v_tx_clone.send(map.to_vec()) {
                                            Ok(_) => {
                                                if count % 300 == 0 {
                                                    eprintln!("[GStreamer] Successfully sent sample #{} to RTP channel", count);
                                                }
                                            }
                                            Err(e) => {
                                                eprintln!("[GStreamer] Failed to send to RTP channel: {:?}", e);
                                            }
                                        }
                                        Ok(gst::FlowSuccess::Ok)
                                    })
                                    .build()
                            );
                        }
                        let a_tx_clone = a_tx.clone();
                        if let Ok(audio_sink) = pipeline
                            .by_name("audio_sink")
                            .context("Sink not found")
                            .and_then(|s| {
                                s.downcast::<gst_app::AppSink>()
                                    .map_err(|_| anyhow::anyhow!("Expected AppSink"))
                            })
                        {
                            audio_sink.set_callbacks(
                                gst_app::AppSinkCallbacks::builder()
                                    .new_sample(move |sink| {
                                        let sample =
                                            sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                                        let buffer =
                                            sample.buffer().ok_or(gst::FlowError::Error)?;
                                        let map = buffer
                                            .map_readable()
                                            .map_err(|_| gst::FlowError::Error)?;
                                        let _ = a_tx_clone.send(map.to_vec());
                                        Ok(gst::FlowSuccess::Ok)
                                    })
                                    .build(),
                            );
                        }

                        if let Err(e) = pipeline.set_state(gst::State::Playing) {
                            eprintln!(
                                "Failed to set pipeline to playing with encoder {}: {}",
                                encoder, e
                            );
                            let mut pulse_error = false;
                            if let Some(bus) = pipeline.bus() {
                                while let Some(msg) =
                                    bus.timed_pop(gst::ClockTime::from_mseconds(100))
                                {
                                    match msg.view() {
                                        gst::MessageView::Error(err) => {
                                            let (src, _msg, dbg) = (
                                                err.src()
                                                    .map(|s| s.path_string())
                                                    .unwrap_or_default(),
                                                err.error(),
                                                err.debug(),
                                            );
                                            if src.contains("pulsesrc")
                                                || (dbg
                                                    .as_ref()
                                                    .map(|d| d.contains("Connection refused"))
                                                    .unwrap_or(false))
                                            {
                                                pulse_error = true;
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }

                            // Ensure pipeline is cleaned up before dropping
                            let _ = pipeline.set_state(gst::State::Null);

                            if pulse_error && audio_source == "pulsesrc" {
                                audio_source = "audiotestsrc is-live=true wave=silence".to_string();
                                continue;
                            }
                            encoder_idx += 1;
                            continue;
                        }
                        println!("Successfully started pipeline with encoder: {}", encoder);
                        gst_pipeline = Some(pipeline);
                        video_src_opt = Some(video_src);
                        selected_mime_type = mime_type.to_owned();
                        break;
                    }
                    Err(e) => {
                        eprintln!(
                            "Failed to create GStreamer pipeline with encoder {}: {}",
                            encoder, e
                        );
                        encoder_idx += 1;
                    }
                }
            }

            let video_track = Arc::new(TrackLocalStaticRTP::new(
                RTCRtpCodecCapability {
                    mime_type: selected_mime_type,
                    ..Default::default()
                },
                "video".to_owned(),
                "webrtc-rs".to_owned(),
            ));
            let audio_track = Arc::new(TrackLocalStaticRTP::new(
                RTCRtpCodecCapability {
                    mime_type: "audio/opus".to_owned(),
                    ..Default::default()
                },
                "audio".to_owned(),
                "webrtc-rs".to_owned(),
            ));

            video_track_opt = Some(video_track.clone());
            audio_track_opt = Some(audio_track.clone());

            let v_track_clone = video_track.clone();
            tokio::spawn(async move {
                eprintln!("[RTP] Video RTP processor task started, waiting for packets...");
                let mut rtp_count: u64 = 0;
                let mut rtp_fail_count: u64 = 0;
                let mut last_log = std::time::Instant::now();
                while let Some(buf) = v_rx.recv().await {
                    match Packet::unmarshal(&mut &buf[..]) {
                        Ok(packet) => {
                            rtp_count += 1;
                            let _ = v_track_clone.write_rtp(&packet).await;
                        }
                        Err(e) => {
                            rtp_fail_count += 1;
                            if rtp_fail_count <= 5 {
                                eprintln!("[RTP] Unmarshal failed: {:?}, buf len={}, first 20 bytes={:02x?}", e, buf.len(), &buf[..buf.len().min(20)]);
                            }
                        }
                    }
                    if last_log.elapsed() > std::time::Duration::from_secs(10) {
                        eprintln!(
                            "[RTP] Video packets: written={}, unmarshal_failed={}",
                            rtp_count, rtp_fail_count
                        );
                        last_log = std::time::Instant::now();
                    }
                }
            });

            let a_track_clone = audio_track.clone();
            tokio::spawn(async move {
                while let Some(buf) = a_rx.recv().await {
                    if let Ok(packet) = Packet::unmarshal(&mut &buf[..]) {
                        let _ = a_track_clone.write_rtp(&packet).await;
                    }
                }
            });

            // We don't need xdotool for SDL2 input injection if we are communicating directly with the runner
            // But if we want to simulate system-wide input on the Xvfb display, we might still use it.
            // However, the runner now handles SDL events directly via the "gui-event" message.
            // So we can probably skip xdotool or keep it as a fallback.
            // For now, let's keep the structure but maybe rename the variable to be generic.
            let mut input_injector = if cfg!(target_os = "windows") {
                let mut c = system_command("env");
                c.arg(format!("DISPLAY={}", wsl_display_str))
                    .arg("xdotool")
                    .arg("-");
                c
            } else {
                let mut c = Command::new("xdotool");
                c.arg("-").env("DISPLAY", &wsl_display_str);
                c
            };

            input_injector
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Ok(mut injector_child) = input_injector.spawn() {
                if let Some(mut injector_stdin) = injector_child.stdin.take() {
                    let (sdl_tx, mut sdl_rx) = mpsc::unbounded_channel::<String>();
                    if let Some(sid) = session_id.clone() {
                        let mut guard = sdl_input_store.lock().await;
                        guard.insert(sid, sdl_tx.clone());
                    }
                    sdl_tx_opt = Some(sdl_tx);

                    tokio::spawn(async move {
                        while let Some(mut cmd) = sdl_rx.recv().await {
                            if cmd.starts_with("mousemove ") {
                                while let Ok(next) = sdl_rx.try_recv() {
                                    if next.starts_with("mousemove ") {
                                        cmd = next;
                                    } else {
                                        if let Err(_) =
                                            injector_stdin.write_all(cmd.as_bytes()).await
                                        {
                                        }
                                        let _ = injector_stdin.write_all(b"\n").await;
                                        cmd = next;
                                        break;
                                    }
                                }
                            }
                            if let Err(_) = injector_stdin.write_all(cmd.as_bytes()).await {
                                break;
                            }
                            let _ = injector_stdin.write_all(b"\n").await;
                            let _ = injector_stdin.flush().await;
                        }
                        drop(injector_stdin);
                        let _ = injector_child.wait().await;
                    });
                }
            }

            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "run-gui-start",
                "width": width,
                "height": height,
                "display": wsl_display_str
            });
            let _ = log_dc
                .send_text(serde_json::to_string(&payload).unwrap_or_default())
                .await;
        }

        let exe_path = std::env::current_exe()?;
        let runner_path = exe_path
            .parent()
            .unwrap()
            .join(if cfg!(target_os = "windows") {
                "runner.exe"
            } else {
                "runner"
            });

        let mut cmd = Command::new(runner_path);
        cmd.current_dir(&dir_path);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        if req.is_gui {
            cmd.env("DISPLAY", &wsl_display_str);
            if cfg!(target_os = "windows") {
                cmd.env("WSLENV", "DISPLAY");
            }
        }

        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let (tx, _) = tokio::sync::broadcast::channel(100);
        let tx_clone = tx.clone();
        let video_src = video_src_opt.clone();

        tokio::spawn(async move {
            if let Some(src) = video_src {
                let mut reader = BufReader::new(stdout);
                let frame_size = 800 * 600 * 4;
                let mut buffer = vec![0u8; frame_size];
                let mut frame_count: u64 = 0;
                let mut last_log = std::time::Instant::now();
                loop {
                    match reader.read_exact(&mut buffer).await {
                        Ok(_) => {
                            frame_count += 1;
                            if last_log.elapsed() > std::time::Duration::from_secs(10) {
                                eprintln!(
                                    "[Main] Received {} frames from runner, pushing to GStreamer",
                                    frame_count
                                );
                                last_log = std::time::Instant::now();
                            }
                            let gst_buffer = gst::Buffer::from_slice(buffer.clone());
                            let result = src.push_buffer(gst_buffer);
                            if result.is_err()
                                && last_log.elapsed() > std::time::Duration::from_secs(5)
                            {
                                eprintln!("[Main] GStreamer push_buffer failed: {:?}", result);
                            }
                        }
                        Err(e) => {
                            eprintln!("[Main] Error reading from runner stdout: {}", e);
                            break;
                        }
                    }
                }
                eprintln!(
                    "[Main] Runner stdout reader exited after {} frames",
                    frame_count
                );
            } else {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let _ = tx_clone.send(format!("STDOUT:{}", line));
                        }
                        Err(_) => break,
                    }
                }
            }
        });

        let tx_clone2 = tx.clone();
        let log_dc_for_status = log_dc.clone();
        let sid_for_status = session_id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {
                        // Runner emits structured HMR status as:
                        // "[Runner] [HMR-STATUS] {json}"
                        // Surface this as a real `hmr-status` event to the frontend.
                        if let Some(idx) = line.find("[HMR-STATUS]") {
                            let json_part = line[(idx + "[HMR-STATUS]".len())..].trim();
                            if !json_part.is_empty() {
                                if let Ok(val) =
                                    serde_json::from_str::<serde_json::Value>(json_part)
                                {
                                    let payload = serde_json::json!({
                                        "sessionId": sid_for_status.clone(),
                                        "type": "hmr-status",
                                        "data": val
                                    });
                                    let _ = log_dc_for_status
                                        .send_text(
                                            serde_json::to_string(&payload).unwrap_or_default(),
                                        )
                                        .await;
                                }
                            }
                        }
                        let _ = tx_clone2.send(format!("STDERR:{}", line));
                    }
                    Err(_) => break,
                }
            }
        });

        *guard = Some(RunnerState {
            process: Some(child),
            stdin,
            output_tx: tx,
            is_gui: req.is_gui,
            is_hmr_capable: has_on_update, // Detected from compiled library exports
            hmr_capability: None,          // Will be set per-module as they load
            xvfb_process,
            gst_pipeline,
            sdl_tx: sdl_tx_opt,
            video_track: video_track_opt,
            audio_track: audio_track_opt,
            width: req_width,
            height: req_height,
            wsl_display_str,
            gst_display_str,
            module_hashes: ModuleHashes::new(),
            loaded_core_path: None,
            loaded_gui_path: None,
            // Widget-level HMR state
            loaded_widget_paths: HashMap::new(),
            widget_hashes: HashMap::new(),
        });
    }

    if let Some(state) = guard.as_mut() {
        // Only attach tracks and subscribe to output on initial setup (not during HMR)
        // We know it's initial setup if we just created the runner (existing_runner_can_hmr was false)
        if !existing_runner_can_hmr {
            // Ensure tracks are attached to the current PC
            if let (Some(v_track), Some(a_track)) = (&state.video_track, &state.audio_track) {
                let transceivers = pc.get_transceivers().await;
                eprintln!(
                    "[WebRTC] Found {} transceivers to attach tracks to",
                    transceivers.len()
                );
                for t in transceivers {
                    let kind = t.kind();
                    eprintln!(
                        "[WebRTC] Transceiver kind: {:?}, direction: {:?}",
                        kind,
                        t.direction()
                    );
                    if kind == RTPCodecType::Video {
                        let sender = t.sender().await;
                        match sender
                            .replace_track(Some(
                                Arc::clone(v_track) as Arc<dyn TrackLocal + Send + Sync>
                            ))
                            .await
                        {
                            Ok(_) => eprintln!("[WebRTC] Successfully attached video track"),
                            Err(e) => eprintln!("[WebRTC] Failed to attach video track: {:?}", e),
                        }
                    } else if kind == RTPCodecType::Audio {
                        let sender = t.sender().await;
                        match sender
                            .replace_track(Some(
                                Arc::clone(a_track) as Arc<dyn TrackLocal + Send + Sync>
                            ))
                            .await
                        {
                            Ok(_) => eprintln!("[WebRTC] Successfully attached audio track"),
                            Err(e) => eprintln!("[WebRTC] Failed to attach audio track: {:?}", e),
                        }
                    }
                }
            }

            // Subscribe to output
            let mut rx = state.output_tx.subscribe();
            let log_dc_clone = log_dc.clone();
            let sid = session_id.clone();

            tokio::spawn(async move {
                while let Ok(msg) = rx.recv().await {
                    if let Some((type_str, content)) = msg.split_once(':') {
                        let msg_type = if type_str == "STDOUT" {
                            "run-stdout"
                        } else {
                            "run-stderr"
                        };
                        let payload = serde_json::json!({
                            "sessionId": sid.clone(),
                            "type": msg_type,
                            "line": content
                        });
                        let _ = log_dc_clone
                            .send_text(serde_json::to_string(&payload).unwrap_or_default())
                            .await;
                    }
                }
            });

            // Register sdl input for this session
            if let Some(tx) = &state.sdl_tx {
                if let Some(sid) = session_id.clone() {
                    let mut g = sdl_input_store.lock().await;
                    g.insert(sid, tx.clone());
                }
            }
        } else {
            eprintln!("[Main] HMR mode: Skipping track attachment and output subscription (already set up)");
        }

        // Load Modules
        for (name, path) in &modules_to_load {
            let cmd = format!("load {} {}\n", name, path);
            eprintln!("[Main] Sending command to runner: {}", cmd.trim());
            state.stdin.write_all(cmd.as_bytes()).await?;

            // ============================================================
            // HMR APPLIED/REJECTED STATUS
            // ============================================================
            // After sending load command, emit HMR status to frontend.
            // In a full implementation, we'd wait for runner acknowledgment,
            // but for now we optimistically report success and will report
            // failure if the runner crashes or returns an error.
            // ============================================================

            // Detect capability for the loaded module to determine status
            let module_path = std::path::Path::new(path);
            if let Ok(report) = detect_capabilities(module_path) {
                if existing_runner_can_hmr {
                    // HMR applied successfully
                    let status = CapabilityHmrStatus::applied(name, &report);
                    let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "hmr-status",
                        "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                    });
                    let _ = log_dc
                        .send_text(serde_json::to_string(&payload).unwrap_or_default())
                        .await;
                    eprintln!(
                        "[HMR] Applied: module={}, capability={:?}, state_preserved={}",
                        name,
                        report.hmr_capability,
                        report.hmr_capability.preserves_state()
                    );
                }
            }
        }
        state.stdin.flush().await?;

        if existing_runner_can_hmr {
            eprintln!(
                "[Main] HMR update sent to existing runner: {} module(s) loaded",
                modules_to_load.len()
            );

            // Send overall HMR success notification
            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "hmr-status",
                "data": {
                    "status": "applied",
                    "module": "all",
                    "capability": "HMR Update Complete",
                    "state_preserved": true
                }
            });
            let _ = log_dc
                .send_text(serde_json::to_string(&payload).unwrap_or_default())
                .await;
        }

        // Update RunnerState with new module hashes and paths for future differential rebuilds
        state.module_hashes = new_hashes;
        if !core_lib_path.is_empty() {
            state.loaded_core_path = Some(core_lib_path.clone());
        }
        if !gui_lib_path.is_empty() {
            state.loaded_gui_path = Some(gui_lib_path.clone());
        }
    }

    // Send HMR update notification to frontend
    let hmr_payload = serde_json::json!({
        "sessionId": session_id.clone(),
        "type": "update",
        "hash": timestamp.to_string()
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&hmr_payload).unwrap_or_default())
        .await;

    // Send success
    let payload = serde_json::json!({
        "sessionId": session_id.clone(),
        "status": "done",
        "success": true,
        "stage": "run"
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;

    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
    
    // ============================================================
    // v2.1 COMPLETION METRICS
    // ============================================================
    let compile_duration = compile_start.elapsed();
    
    // Record metrics for this reload using proper tracker
    {
        let tracker = ReloadMetricsTracker::start(reload_id.clone(), module_id.clone());
        // For now we're tracking total duration, quiescence/snapshot would be recorded during HMR
        let mut metrics = metrics_aggregator.lock().await;
        metrics.record(&tracker, true);
    }
    
    // Mark successful compilation in restart controller (known good)
    {
        let mut rc = restart_controller.lock().await;
        // Record success with the appropriate lib path
        let lib_path = if !core_lib_path.is_empty() {
            std::path::PathBuf::from(&core_lib_path)
        } else if !gui_lib_path.is_empty() {
            std::path::PathBuf::from(&gui_lib_path)
        } else {
            dir_path.join("unknown_module")
        };
        rc.record_success(&module_id, &lib_path);
    }
    
    structured_logger.log(&LogEntry::new(LogLevel::Info, "handle_compile", "Compile completed successfully")
        .with_reload_id(reload_id.clone())
        .with_field("duration_ms", compile_duration.as_millis())
        .with_field("module_id", module_id.clone()));
    
    println!("[Main] handle_compile completed successfully.");

    // Cleanup terminal sender for this session (if any)
    if let Some(sid_opt) = session_id.clone() {
        let mut guard = terminal_store.lock().await;
        guard.remove(&sid_opt);
    }

    Ok(())
}
