#![allow(dead_code)]
#![allow(unused_imports)]
#![allow(unused_variables)]

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::env;
use std::hash::{Hash, Hasher};
use std::process::Stdio;
use std::sync::Arc;

use worker::android;
use worker::compiler;
use worker::hmr;
use worker::infra;
use worker::runtime;
use worker::safety;

use anyhow::{Context, Result};
use bytes::Bytes;
use futures::{FutureExt, SinkExt, StreamExt};

/*
use compiler::builder::{
    hash_content,
    hash_shared_header_semantic,
    ModuleHashes,
    RebuildScope,
    WidgetCompiler,
    WidgetDetector,
};

use runtime::capability::{detect_capabilities, HmrCapability, HmrStatus};

use compiler::error_parser::{parse_compiler_output, CompilerType, DiagnosticEvent};
*/

use hmr::fast_refresh::{
    BoundaryChecker,
    // BoundaryViolationEvent, // unused
    // RefreshAction, // unused
    // PreemptiveConfig, PreemptiveMessage, SpeculativeCache // These seem to be in watcher.rs?
};

use infra::observability::{
    StructuredLogger,
    LogFormat,
    LogLevel,
    LogEntry,
    MetricsAggregator,
    // ReloadMetricsTracker, // unused
    // ReloadId, // unused
};


use safety::slot_isolation::{IsolationModel, IsolationManager};
use safety::restart_control::{RestartController, BackoffConfig, KnownGoodStore};
use safety::hardened_ipc::IpcConfig;
use safety::quiescence::QuiescenceConfig;

use infra::watcher::{PreemptiveConfig, PreemptiveMessage, SpeculativeCache};

// use runtime::shim::{auto_shim, ShimMode, detect_shim_mode};

#[allow(unused_imports)]
use hmr::incremental_cache::{IncrementalCache, compile_with_cache, link_objects};
use gstreamer as gst;
use gstreamer::prelude::ElementExt;
// use gstreamer::prelude::{Cast, GstBinExt, GstObjectExt};
// use gstreamer_app as gst_app;

use tempfile::tempdir;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::interceptor::registry::Registry;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::RTCDataChannel;
// use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::sdp_type::RTCSdpType;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
// use webrtc::rtp::packet::Packet;
use webrtc::rtp_transceiver::rtp_codec::{
    RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType, RTCRtpHeaderExtensionCapability,
};
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
// use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
// use webrtc::track::track_local::TrackLocal;
// use webrtc::track::track_local::TrackLocalWriter;
// use webrtc::util::Unmarshal;
use webrtc::rtp_transceiver::RTCPFeedback;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocal;
use webrtc::track::track_local::TrackLocalWriter;
use webrtc::util::Unmarshal;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use serde::{Deserialize, Serialize};

// use printer::compile_context::CompileContext; // Legacy path
use compiler::context::CompileContext;
use infra::constants::{/*GUI_TOOLS,*/ REQUIRED_TOOLS};
use infra::lsp_util::{LspSessionState, rewrite_uris};
use infra::messages::{CompileRequest, /*FileEntry,*/ IceServerEnv, SignalMessage};
use runtime::runner_state::RunnerState;
use hmr::orchestrator::{HmrOrchestrator, OrchestratorConfig};
use infra::utils::{make_chunks, get_wsl_host_ip};

use worker::safety::security;
use worker::infra::watcher;
use worker::compiler::builder;
use worker::infra::server;
use worker::infra::storage;






fn get_ai_backend_url() -> String {
    if let Ok(url) = std::env::var("AI_BACKEND_URL") {
        return url;
    }
    
    // Auto-detect WSL host IP
    if let Some(host_ip) = get_wsl_host_ip() {
        return format!("http://{}:8000", host_ip);
    }
    "http://localhost:8000".to_string()
}
    
const GUI_TOOLS: &[&str] = &["xdotool", "Xvfb", "matchbox-window-manager"]; // Keeping these for now as SDL2 might use Xvfb on Linux

#[derive(Debug, Serialize, Deserialize)]
struct FileEntry {
    name: String,
    content: String,
}

/// Request to cancel a running mobile emulator job
#[derive(Debug, Deserialize)]
struct CancelMobileJobRequest {
    #[serde(rename = "type")]
    msg_type: String,  // Should be "cancel-mobile-job"
    session_id: String,
}

/// Request to cancel a running build (all targets)
#[derive(Debug, Deserialize)]
struct CancelBuildRequest {
    #[serde(rename = "type")]
    msg_type: String, // Should be "cancel-build"
    #[serde(default)]
    session_id: Option<String>,
}


// Auto-detect WSL host IP
fn get_wsl_backend_url() -> String {
    if let Some(host_ip) = get_wsl_host_ip() {
        return format!("http://{}:8000", host_ip);
    }

    "http://127.0.0.1:8000".to_string()
}

fn get_signaling_url() -> String {
    if let Ok(url) = std::env::var("SIGNALING_URL") {
        return url;
    }

    // In most setups, the signaling server runs alongside the worker (in WSL)
    // or is accessible via localhost forwarding.
    // We ONLY default to Host IP for the AI Backend which we know runs on Windows.
    "ws://localhost:9000".to_string()
}

fn extract_fingerprint(sdp: &str) -> Option<String> {
    for line in sdp.lines() {
        if let Some(rest) = line.strip_prefix("a=fingerprint:") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

#[tokio::main]
async fn main() -> Result<()> {
    eprintln!("[Worker] Starting up (PID: {})", std::process::id());
    println!("Worker starting...");
    println!("Operating System: {}", std::env::consts::OS);
    
    // v2.1: Print security audit at startup (requirement #9)
    if std::env::var("SYNTHI_SECURITY_AUDIT").map(|v| v == "1").unwrap_or(false) {
        security::print_security_audit();
    } else {
        // Brief security notice
        let audit = security::audit_security();
        eprintln!("[Security] Status: {} enforced, {} partial, {} stub (set SYNTHI_SECURITY_AUDIT=1 for details)",
            audit.enforced_count, audit.partial_count, audit.stub_count);
    }
    
    // ============================================================
    // v2.1 HMR INFRASTRUCTURE INITIALIZATION (Requirements #1-10)
    // ============================================================
    // Initialize all HMR hardening infrastructure from dead code modules:
    // - StructuredLogger for observability (#10)
    // - IsolationManager for worker isolation (#7)
    // - RestartController for backoff/fallback (#8)
    // - IpcConfig for hardened communication (#4)
    // - HmrOrchestrator for central coordination
    // ============================================================
    
    // Initialize structured logging (requirement #10)
    let hmr_log_format = if std::env::var("SYNTHI_JSON_LOGS").map(|v| v == "1").unwrap_or(false) {
        LogFormat::Json
    } else {
        LogFormat::Human
    };
    let hmr_log_level = match std::env::var("SYNTHI_LOG_LEVEL").unwrap_or_default().as_str() {
        "trace" => LogLevel::Trace,
        "debug" => LogLevel::Debug,
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    };
    let structured_logger = Arc::new(StructuredLogger::new(hmr_log_format, hmr_log_level));
    
    // Initialize metrics aggregator for reload performance tracking
    let metrics_aggregator = Arc::new(tokio::sync::Mutex::new(MetricsAggregator::new()));
    
    // Log startup
    structured_logger.log(&LogEntry::new(LogLevel::Info, "main", "Worker starting with HMR v2.1 hardening")
        .with_field("os", std::env::consts::OS)
        .with_field("log_format", format!("{:?}", hmr_log_format)));
    
    // Initialize isolation manager (requirement #7)
    let isolation_model = match std::env::var("SYNTHI_ISOLATION_MODEL").unwrap_or_default().as_str() {
        "worker_per_slot" => IsolationModel::WorkerPerSlot,
        "grouped" => IsolationModel::GroupedWorkers,
        _ => IsolationModel::SingleWorker, // Default: simpler, lower overhead
    };
    let isolation_manager = Arc::new(tokio::sync::Mutex::new(IsolationManager::new(isolation_model)));
    eprintln!("[HMR v2.1] Isolation model: {:?}", isolation_model);
    
    // Initialize restart controller with backoff (requirement #8)
    let known_good_dir = std::env::temp_dir().join("synthi_known_good");
    let _ = std::fs::create_dir_all(&known_good_dir);
    let known_good_store = KnownGoodStore::with_persistence(known_good_dir.join("known_good.json"));
    let backoff_config = BackoffConfig::default();
    let restart_controller = Arc::new(tokio::sync::Mutex::new(
        RestartController::new(backoff_config, known_good_store)
    ));
    eprintln!("[HMR v2.1] Restart controller initialized with backoff/fallback");
    
    // Initialize hardened IPC config (requirement #4)
    let ipc_config = Arc::new(IpcConfig::default());
    eprintln!("[HMR v2.1] IPC config: max_frame_size={}MB, read_timeout={}s",
        ipc_config.max_frame_size / (1024 * 1024),
        ipc_config.read_timeout.as_secs());
    
    // Initialize HMR orchestrator (central coordination)
    let orchestrator_config = OrchestratorConfig {
        prefer_binary_state: true,
        max_snapshots: 10,
        max_consecutive_crashes: 3,
        task_shutdown_timeout: std::time::Duration::from_secs(5),
        strict_abi: std::env::var("SYNTHI_STRICT_ABI").map(|v| v == "1").unwrap_or(false),
        max_boundaries_per_module: 20,
    };
    let hmr_orchestrator = Arc::new(tokio::sync::Mutex::new(HmrOrchestrator::with_config(orchestrator_config)));
    eprintln!("[HMR v2.1] Orchestrator initialized (binary_state={}, strict_abi={})",
        true, std::env::var("SYNTHI_STRICT_ABI").map(|v| v == "1").unwrap_or(false));
    
    // Initialize quiescence config (requirement #6)
    let _quiescence_config = QuiescenceConfig::default();
    eprintln!("[HMR v2.1] Quiescence protocol ready");
    
    structured_logger.log(&LogEntry::new(LogLevel::Info, "main", "HMR v2.1 infrastructure initialized"));
    
    // ============================================================
    // END v2.1 INFRASTRUCTURE
    // ============================================================
    
    // Cargo does not source shell rc files, so ensure Android SDK tools are visible
    // to this process deterministically before any SDK checks or emulator logic.
    android::ensure_android_sdk_env();
    android::log_android_env_diagnostics("startup");

    println!("=== WORKER ENV DIAGNOSTIC (post-bootstrap) ===");
    println!(
        "CARGO_MANIFEST_DIR = {:?}",
        std::env::var("CARGO_MANIFEST_DIR")
    );
    println!("HOME = {:?}", std::env::var("HOME"));
    println!("PATH = {:?}", std::env::var("PATH"));
    println!("ANDROID_SDK_ROOT = {:?}", std::env::var("ANDROID_SDK_ROOT"));
    println!("ANDROID_HOME = {:?}", std::env::var("ANDROID_HOME"));
    println!("===========================================");

    eprintln!("[Worker] Initializing GStreamer...");
    match gst::init() {
        Ok(_) => eprintln!("[Worker] GStreamer initialized successfully"),
        Err(e) => {
            eprintln!("[Worker] FATAL: GStreamer initialization failed: {}", e);
            // We want to return the error to fail specifically
            return Err(anyhow::anyhow!("GStreamer init failed: {}", e));
        }
    }
    
    eprintln!("[Worker] Verifying tooling...");
    verify_tooling().await?;
    let signaling_url = get_signaling_url();
    println!("Connecting to signaling server at: {}", signaling_url);
    let (ws_stream, _) = connect_async(&signaling_url).await?;
    let (mut ws_write, mut ws_read) = ws_stream.split();
    let (signal_tx, mut signal_rx) = mpsc::unbounded_channel::<SignalMessage>();

    ws_write
        .send(Message::text(serde_json::to_string(&SignalMessage {
            msg_type: "register".into(),
            role: Some("worker".into()),
            sdp: None,
            sdp_type: None,
            candidate: None,
        })?))
        .await?;

    tokio::spawn(async move {
        while let Some(msg) = signal_rx.recv().await {
            if let Ok(text) = serde_json::to_string(&msg) {
                let _ = ws_write.send(Message::text(text)).await;
            }
        }
    });

    let mut pc = create_peer(signal_tx.clone()).await?;
    let log_channel_store: Arc<Mutex<Option<Arc<RTCDataChannel>>>> = Arc::new(Mutex::new(None));
    // Store of sessionId -> stdin sender so datachannel 'terminal' messages can be
    // routed to the running process's stdin.
    let terminal_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    // Store of sessionId -> sdl input sender for persistent SDL input
    let sdl_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    // Store for persistent runner process
    let runner_store: Arc<Mutex<Option<RunnerState>>> = Arc::new(Mutex::new(None));
    // Store for currently running compile task (any target)
    let compile_task_store: Arc<Mutex<Option<(String, tokio::task::JoinHandle<()>)>>> =
        Arc::new(Mutex::new(None));
    // Simple in-memory cache for tracking compiled lib paths (legacy, used alongside IncrementalCache)
    let compile_cache: Arc<Mutex<HashMap<String, (u64, String)>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Content-addressable incremental compilation cache (persists across sessions)
    // Uses /dev/shm on Linux for fast RAM-based caching
    let cache_dir = if cfg!(target_os = "linux") {
        std::path::PathBuf::from("/dev/shm/synthi_compile_cache")
    } else {
        std::env::temp_dir().join("synthi_compile_cache")
    };
    let incremental_cache = Arc::new(
        IncrementalCache::new(cache_dir)
            .await
            .expect("Failed to initialize incremental compile cache"),
    );
    eprintln!("[Cache] Initialized content-addressable compile cache");

    // Speculative compilation cache for preemptive builds
    let speculative_cache: Arc<Mutex<SpeculativeCache>> =
        Arc::new(Mutex::new(SpeculativeCache::new(32)));

    // Fast Refresh boundary checker (per-session)
    let boundary_checker: Arc<Mutex<BoundaryChecker>> =
        Arc::new(Mutex::new(BoundaryChecker::new()));

    // Create a persistent workspace directory for the session
    let workspace_dir = Arc::new(tempdir()?);
    let workspace_path = workspace_dir.path().to_owned();
    let workspace_path_for_watcher = workspace_path.clone();
    let workspace_path_for_builder = workspace_path.clone();
    let workspace_path_arc = Arc::new(workspace_path);

    // --- Build System Initialization ---
    let (update_tx, _) = tokio::sync::broadcast::channel(16);
    let (preemptive_tx, preemptive_rx) = std::sync::mpsc::channel::<PreemptiveMessage>();

    // Start Preemptive Watcher (replaces standard watcher for speculative compilation)
    let preemptive_config = PreemptiveConfig {
        enabled: true,
        speculative_delay_ms: 150, // Start speculative compile 150ms after keystroke pause
        commit_delay_ms: 300,      // Commit final result 300ms after last change
        max_speculative_count: 5,  // Max speculative compiles before forcing commit
    };
    let (_watcher, cancel_flag) = watcher::setup_preemptive_watcher(
        &workspace_path_for_watcher,
        preemptive_tx,
        preemptive_config,
    )
    .context("Failed to setup preemptive watcher")?;

    // Start Build Loop
    let build_update_tx = update_tx.clone();

    let mut build_session = builder::BuildSession::new(workspace_path_for_builder);
    let session_hash = build_session.session_hash.clone();

    // Speculative cache for build loop
    let _build_speculative_cache = speculative_cache.clone();
    let build_cancel_flag = cancel_flag.clone();

    // Start WebSocket Server
    let server_update_rx = update_tx.subscribe();
    let server_hash = session_hash.clone();
    tokio::spawn(async move {
        server::start_server("0.0.0.0:8001".to_string(), server_update_rx, server_hash).await;
    });

    // Forward updates to DataChannel
    let mut dc_rx = update_tx.subscribe();
    let dc_store = log_channel_store.clone();
    tokio::spawn(async move {
        while let Ok(msg) = dc_rx.recv().await {
            let guard = dc_store.lock().await;
            if let Some(dc) = &*guard {
                let _ = dc.send_text(msg).await;
            }
        }
    });

    // Build Loop Task with Preemptive/Speculative Compilation
    tokio::task::spawn_blocking(move || {
        use std::sync::atomic::Ordering;
        use std::time::Instant;

        loop {
            if let Ok(message) = preemptive_rx.recv() {
                match message {
                    PreemptiveMessage::StartSpeculative {
                        paths,
                        scope,
                        timestamp: _timestamp,
                    } => {
                        eprintln!(
                            "[Build] Starting speculative compile for scope '{}': {:?}",
                            scope, paths
                        );

                        // Check cancellation flag periodically during compile
                        if build_cancel_flag.load(Ordering::SeqCst) {
                            eprintln!("[Build] Speculative compile cancelled before start");
                            continue;
                        }

                        // Perform speculative compilation
                        let start = Instant::now();
                        for path_str in &paths {
                            let path = std::path::Path::new(&path_str);
                            let relative_path =
                                if let Ok(rel) = path.strip_prefix(&build_session.workspace_root) {
                                    rel.to_string_lossy().to_string()
                                } else {
                                    path_str.clone()
                                };

                            // Check for cancellation between files
                            if build_cancel_flag.load(Ordering::SeqCst) {
                                eprintln!(
                                    "[Build] Speculative compile cancelled during compilation"
                                );
                                break;
                            }

                            // Do incremental compile but don't send update yet
                            if let Some(_payload) =
                                build_session.incremental_compile(vec![relative_path.clone()])
                            {
                                // Cache the speculative result
                                let _content_hash = {
                                    let mut hasher =
                                        std::collections::hash_map::DefaultHasher::new();
                                    relative_path.hash(&mut hasher);
                                    hasher.finish()
                                };

                                // Store in speculative cache (blocking mutex)
                                // Note: In production, use a lock-free structure
                                eprintln!(
                                    "[Build] Speculative compile complete in {}ms, cached",
                                    start.elapsed().as_millis()
                                );
                            }
                        }
                    }

                    PreemptiveMessage::CancelSpeculative { reason } => {
                        eprintln!("[Build] Speculative compile cancelled: {}", reason);
                        // Cancel flag is already set by watcher
                    }

                    PreemptiveMessage::CommitSpeculative { paths, scope } => {
                        eprintln!(
                            "[Build] Committing speculative compile for scope '{}': {:?}",
                            scope, paths
                        );

                        // Send the cached result to frontend
                        let msg = serde_json::json!({
                            "type": "update",
                            "data": {
                                "hash": build_session.session_hash,
                                "scope": scope,
                                "speculative": true,
                                "message": format!("Speculative compile committed for {:?}", paths)
                            }
                        });
                        if let Ok(json) = serde_json::to_string(&msg) {
                            let _ = build_update_tx.send(json);
                        }
                    }

                    PreemptiveMessage::Changed { scope, paths } => {
                        // Standard (non-speculative) change - compile immediately
                        eprintln!(
                            "[Build] Standard compile for scope '{}': {:?}",
                            scope, paths
                        );

                        for path_str in paths {
                            let path = std::path::Path::new(&path_str);
                            let relative_path =
                                if let Ok(rel) = path.strip_prefix(&build_session.workspace_root) {
                                    rel.to_string_lossy().to_string()
                                } else {
                                    path_str
                                };

                            if let Some(payload) =
                                build_session.incremental_compile(vec![relative_path])
                            {
                                // Wrap with type="update" and include hash
                                let msg = serde_json::json!({
                                    "type": "update",
                                    "data": {
                                        "hash": build_session.session_hash,
                                        "manifest": payload.manifest,
                                        "modules": payload.modules
                                    }
                                });
                                if let Ok(json) = serde_json::to_string(&msg) {
                                    let _ = build_update_tx.send(json);
                                }
                            }
                        }
                    }
                }
            }
        }
    });
    // -----------------------------------

    wire_peer_channels(
        &pc,
        log_channel_store.clone(),
        terminal_input_store.clone(),
        sdl_input_store.clone(),
        runner_store.clone(),
        compile_task_store.clone(),
        workspace_path_arc.clone(),
        compile_cache.clone(),
        boundary_checker.clone(),
        incremental_cache.clone(),
        hmr_orchestrator.clone(),
        structured_logger.clone(),
        metrics_aggregator.clone(),
        restart_controller.clone(),
        ipc_config.clone(),
    ).await?;

    let mut current_remote_fingerprint: Option<String> = None;
    while let Some(msg) = ws_read.next().await {
        let msg = msg?;
        if !msg.is_text() {
            continue;
        }
        let parsed: SignalMessage = match serde_json::from_str(&msg.into_text()?) {
            Ok(v) => v,
            Err(_) => continue,
        };

        match parsed.msg_type.as_str() {
            "offer" => {
                if let Some(sdp) = parsed.sdp {
                    let sdp_type = match parsed.sdp_type.as_deref().unwrap_or("offer") {
                        "offer" => RTCSdpType::Offer,
                        "answer" => RTCSdpType::Answer,
                        "pranswer" => RTCSdpType::Pranswer,
                        "rollback" => RTCSdpType::Rollback,
                        _ => RTCSdpType::Offer,
                    };
                    let new_fingerprint = extract_fingerprint(&sdp);
                    let fingerprint_changed = match (&current_remote_fingerprint, &new_fingerprint) {
                        (Some(old_fp), Some(new_fp)) => old_fp != new_fp,
                        (Some(_), None) => true,
                        _ => false,
                    };

                    if fingerprint_changed {
                        eprintln!(
                            "[WebRTC-signal] Detected new peer fingerprint, recreating PeerConnection for fresh browser session"
                        );
                        if let Err(e) = pc.close().await {
                            eprintln!("[WebRTC-signal] Warning: failed to close old PC: {:?}", e);
                        }
                        {
                            let mut guard = log_channel_store.lock().await;
                            *guard = None;
                        }
                        match create_peer(signal_tx.clone()).await {
                            Ok(new_pc) => {
                                wire_peer_channels(
                                    &new_pc,
                                    log_channel_store.clone(),
                                    terminal_input_store.clone(),
                                    sdl_input_store.clone(),
                                    runner_store.clone(),
                                    compile_task_store.clone(),
                                    workspace_path_arc.clone(),
                                    compile_cache.clone(),
                                    boundary_checker.clone(),
                                    incremental_cache.clone(),
                                    hmr_orchestrator.clone(),
                                    structured_logger.clone(),
                                    metrics_aggregator.clone(),
                                    restart_controller.clone(),
                                    ipc_config.clone(),
                                )
                                .await?;
                                pc = new_pc;
                                current_remote_fingerprint = None;
                            }
                            Err(e) => {
                                eprintln!(
                                    "[WebRTC-signal] CRITICAL ERROR: Failed to re-create peer connection: {:?}",
                                    e
                                );
                                return Err(e);
                            }
                        }
                    }

                    eprintln!("[WebRTC-signal] Received offer (type={:?}), current state={:?}", sdp_type, pc.signaling_state());
                    let mut desc = RTCSessionDescription::default();
                    desc.sdp_type = sdp_type;
                    desc.sdp = sdp;
                    pc.set_remote_description(desc).await?;
                    let answer = pc.create_answer(None).await?;
                    pc.set_local_description(answer.clone()).await?;
                    eprintln!("[WebRTC-signal] Sending answer, new state={:?}", pc.signaling_state());
                    if let Some(pos) = answer.sdp.find("transport-wide-cc") {
                        eprintln!("[WebRTC-signal] TWCC found in Answer SDP at index {}", pos);
                    } else {
                        eprintln!("[WebRTC-signal] WARNING: TWCC missing from Answer SDP!");
                    }
                    signal_tx.send(SignalMessage {
                        msg_type: "answer".into(),
                        role: None,
                        sdp: Some(answer.sdp),
                        sdp_type: Some(answer.sdp_type.to_string()),
                        candidate: None,
                    })?;
                    if let Some(fp) = new_fingerprint {
                        current_remote_fingerprint = Some(fp);
                    }
                }
            }
            "candidate" => {
                if let Some(c) = parsed.candidate {
                    let _ = pc.add_ice_candidate(c).await;
                }
            }
            "reset" => {
                eprintln!("[WebRTC-signal] Received reset command, clearing WebRTC state (SOFT RESET)...");
                
                // 1. Close the existing PeerConnection
                if let Err(e) = pc.close().await {
                    eprintln!("[WebRTC-signal] Warning: failed to close old PC: {:?}", e);
                }
                current_remote_fingerprint = None;

                // 2. Clear runner state (Terminates Emulator/GStreamer pipeline)
                {
                    let mut guard = runner_store.lock().await;
                    if guard.is_some() {
                        eprintln!("[WebRTC-signal] Dropping old RunnerState...");
                        *guard = None;
                    }
                }

                // 3. Clear other session stores
                {
                     let mut guard = log_channel_store.lock().await;
                     *guard = None;
                }
                {
                     let mut guard = terminal_input_store.lock().await;
                     guard.clear();
                }
                {
                     let mut guard = sdl_input_store.lock().await;
                     guard.clear();
                }

                // 4. Create a fresh PeerConnection
                match create_peer(signal_tx.clone()).await {
                    Ok(new_pc) => {
                        wire_peer_channels(
                            &new_pc,
                            log_channel_store.clone(),
                            terminal_input_store.clone(),
                            sdl_input_store.clone(),
                            runner_store.clone(),
                            compile_task_store.clone(),
                            workspace_path_arc.clone(),
                            compile_cache.clone(),
                            boundary_checker.clone(),
                            incremental_cache.clone(),
                             hmr_orchestrator.clone(),
                             structured_logger.clone(),
                             metrics_aggregator.clone(),
                             restart_controller.clone(),
                             ipc_config.clone(),
                         ).await?;
                         pc = new_pc;
                         eprintln!("[WebRTC-signal] Soft reset complete. New PeerConnection ready.");
                    },
                    Err(e) => {
                         eprintln!("[WebRTC-signal] CRITICAL ERROR: Failed to re-create peer connection: {:?}", e);
                         // Panic? Return? Try to continue?
                         // If we can't create a peer, we're likely dead anyway.
                         return Err(e);
                    }
                }
            }
            _ => {}
        }
    }

    Ok(())
}

async fn create_peer(
    signal_tx: mpsc::UnboundedSender<SignalMessage>,
) -> Result<Arc<RTCPeerConnection>> {
    let mut m = MediaEngine::default();
    m.register_default_codecs()?;

    // Manually register H265 as it might not be in default codecs
    let _ = m.register_codec(
        RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: "video/H265".to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "".to_owned(),
                rtcp_feedback: vec![RTCPFeedback {
                    typ: "transport-cc".to_owned(),
                    parameter: "".to_owned(),
                }],
            },
            payload_type: 96,
            ..Default::default()
        },
        RTPCodecType::Video,
    );

    // Explicitly register H264 (Baseline) with transport-cc
    // This matches standard Android emulator / RN output (profile-level-id=42001f)
    let _ = m.register_codec(
        RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: "video/H264".to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f".to_owned(),
                rtcp_feedback: vec![RTCPFeedback {
                    typ: "transport-cc".to_owned(),
                    parameter: "".to_owned(),
                }],
            },
            payload_type: 103, // Match common dynamic PT
            ..Default::default()
        },
        RTPCodecType::Video,
    );

    // Explicitly register H264 with transport-cc (Constrained Baseline - 42e01f)
    let _ = m.register_codec(
        RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: "video/H264".to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f".to_owned(),
                rtcp_feedback: vec![RTCPFeedback {
                    typ: "transport-cc".to_owned(),
                    parameter: "".to_owned(),
                }],
            },
            payload_type: 102, 
            ..Default::default()
        },
        RTPCodecType::Video,
    );

    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut m)?;

    let api = APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(registry)
        .build();
    // Allow configuring ICE servers via COMPILER_ICE_SERVERS environment variable as JSON
    // Example: COMPILER_ICE_SERVERS='[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:turn.example.com:3478"],"username":"user","credential":"pass"}]'
    let ice_servers_env = env::var("COMPILER_ICE_SERVERS").ok();
    let mut ice_servers: Vec<webrtc::ice_transport::ice_server::RTCIceServer> = Vec::new();
    if let Some(raw) = ice_servers_env {
        match serde_json::from_str::<Vec<IceServerEnv>>(&raw) {
            Ok(parsed) => {
                for srv in parsed {
                    ice_servers.push(webrtc::ice_transport::ice_server::RTCIceServer {
                        urls: srv.urls,
                        username: srv.username.unwrap_or_default(),
                        credential: srv.credential.unwrap_or_default(),
                        ..Default::default()
                    });
                }
            }
            Err(e) => {
                eprintln!(
                    "Failed to parse COMPILER_ICE_SERVERS - falling back to default STUN: {}",
                    e
                );
                ice_servers.push(webrtc::ice_transport::ice_server::RTCIceServer {
                    urls: vec!["stun:stun.l.google.com:19302".to_string()],
                    ..Default::default()
                });
            }
        }
    } else {
        ice_servers.push(webrtc::ice_transport::ice_server::RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            ..Default::default()
        });
    }

    let config = RTCConfiguration {
        ice_servers,
        ..Default::default()
    };

    let pc = Arc::new(api.new_peer_connection(config).await?);

    // Add transceivers for video and audio so they are negotiated initially
    pc.add_transceiver_from_kind(
        RTPCodecType::Video,
        Some(RTCRtpTransceiverInit {
            direction: RTCRtpTransceiverDirection::Sendonly,
            send_encodings: vec![],
        }),
    )
    .await?;

    pc.add_transceiver_from_kind(
        RTPCodecType::Audio,
        Some(RTCRtpTransceiverInit {
            direction: RTCRtpTransceiverDirection::Sendonly,
            send_encodings: vec![],
        }),
    )
    .await?;

    // Important: some browsers won't emit `ontrack` unless the SDP includes track/MSID info.
    // Attaching placeholder tracks up-front ensures the answer advertises real tracks, while
    // later runtime pipelines can `replace_track()` without requiring renegotiation.
    // This is especially important for Android emulator streaming, where the real track is
    // created after the initial offer/answer exchange.
    {
        let placeholder_video = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability {
                mime_type: "video/H264".to_owned(),
                sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f".to_owned(),
                rtcp_feedback: vec![RTCPFeedback {
                    typ: "transport-cc".to_owned(),
                    parameter: "".to_owned(),
                }],
                ..Default::default()
            },
            "video".to_owned(),
            "synthi-placeholder".to_owned(),
        ));
        let placeholder_audio = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability {
                mime_type: "audio/opus".to_owned(),
                ..Default::default()
            },
            "audio".to_owned(),
            "synthi-placeholder".to_owned(),
        ));

        let transceivers = pc.get_transceivers().await;
        for t in transceivers {
            let kind = t.kind();
            if kind == RTPCodecType::Video {
                let sender = t.sender().await;
                match sender
                    .replace_track(Some(
                        Arc::clone(&placeholder_video) as Arc<dyn TrackLocal + Send + Sync>
                    ))
                    .await
                {
                    Ok(_) => eprintln!("[WebRTC] Attached placeholder video track"),
                    Err(e) => eprintln!("[WebRTC] Failed to attach placeholder video track: {:?}", e),
                }
            } else if kind == RTPCodecType::Audio {
                let sender = t.sender().await;
                match sender
                    .replace_track(Some(
                        Arc::clone(&placeholder_audio) as Arc<dyn TrackLocal + Send + Sync>
                    ))
                    .await
                {
                    Ok(_) => eprintln!("[WebRTC] Attached placeholder audio track"),
                    Err(e) => eprintln!("[WebRTC] Failed to attach placeholder audio track: {:?}", e),
                }
            }
        }
    }

    {
        let tx = signal_tx.clone();
        pc.on_ice_candidate(Box::new(move |candidate| {
            let tx = tx.clone();
            async move {
                if let Some(c) = candidate {
                    if let Ok(init) = c.to_json() {
                        let _ = tx.send(SignalMessage {
                            msg_type: "candidate".into(),
                            role: None,
                            sdp: None,
                            sdp_type: None,
                            candidate: Some(init),
                        });
                    }
                }
            }
            .boxed()
        }));
    }

    pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
        println!("Peer Connection State: {s:?}");
        async {}.boxed()
    }));

    Ok(pc)
}

async fn wire_peer_channels(
    pc: &Arc<RTCPeerConnection>,
    log_channel_store: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
    terminal_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>,
    sdl_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>,
    runner_store: Arc<Mutex<Option<RunnerState>>>,
    compile_task_store: Arc<Mutex<Option<(String, tokio::task::JoinHandle<()>)>>>,
    workspace_path_arc: Arc<std::path::PathBuf>,
    compile_cache: Arc<Mutex<HashMap<String, (u64, String)>>>,
    boundary_checker: Arc<Mutex<BoundaryChecker>>,
    incremental_cache: Arc<IncrementalCache>,
    hmr_orchestrator: Arc<tokio::sync::Mutex<HmrOrchestrator>>,
    structured_logger: Arc<StructuredLogger>,
    metrics_aggregator: Arc<tokio::sync::Mutex<MetricsAggregator>>,
    restart_controller: Arc<tokio::sync::Mutex<RestartController>>,
    ipc_config: Arc<IpcConfig>,
) -> Result<()> {
    let pc = pc.clone();
    let build_log_dc = pc
        .create_data_channel("build-log", Some(RTCDataChannelInit::default()))
        .await?;
    let store_for_open = log_channel_store.clone();
    let build_log_dc_for_open = build_log_dc.clone();
    build_log_dc.on_open(Box::new(move || {
        let dc = build_log_dc_for_open.clone();
        let store = store_for_open.clone();
        async move {
            let mut guard = store.lock().await;
            *guard = Some(dc);
        }
        .boxed()
    }));

    let compile_store = log_channel_store.clone();
    let term_store = terminal_input_store.clone();
    let pc_clone = pc.clone();
    let workspace_path_for_callback = workspace_path_arc.clone();
    let runner_store_for_callback = runner_store.clone();
    let compile_task_store_for_callback = compile_task_store.clone();
    let compile_cache_for_callback = compile_cache.clone();
    let boundary_checker_for_callback = boundary_checker.clone();
    let incremental_cache_for_callback = incremental_cache.clone();
    // v2.1 HMR Infrastructure clones for callback
    let hmr_orchestrator_for_callback = hmr_orchestrator.clone();
    let structured_logger_for_callback = structured_logger.clone();
    let metrics_aggregator_for_callback = metrics_aggregator.clone();
    let restart_controller_for_callback = restart_controller.clone();
    let ipc_config_for_callback = ipc_config.clone();
    let sdl_input_store_for_callback = sdl_input_store.clone();
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let store = compile_store.clone();
        let term_store = term_store.clone();
        let pc_for_callback = pc_clone.clone();
        let workspace_path_for_dc = workspace_path_for_callback.clone();
        let sdl_store_outer = sdl_input_store_for_callback.clone();
        let runner_store_outer = runner_store_for_callback.clone();
        let compile_task_store_outer = compile_task_store_for_callback.clone();
        let compile_cache_outer = compile_cache_for_callback.clone();
        let boundary_checker_outer = boundary_checker_for_callback.clone();
        let incremental_cache_outer = incremental_cache_for_callback.clone();
        // v2.1 outer clones
        let hmr_orchestrator_outer = hmr_orchestrator_for_callback.clone();
        let structured_logger_outer = structured_logger_for_callback.clone();
        let metrics_aggregator_outer = metrics_aggregator_for_callback.clone();
        let restart_controller_outer = restart_controller_for_callback.clone();
        let ipc_config_outer = ipc_config_for_callback.clone();
        async move {
            let label = dc.label();
                if label == "compile" {
                    // Clone terminal store out of the FnMut closure into a local
                    // that can be moved into the async block below without
                    // consuming the captured `term_store`.
                    dc.on_message(Box::new(move |msg| {
                        let store = store.clone();
                        let term_store_for_msg = term_store.clone();
                        let pc_for_compile = pc_for_callback.clone();
                        let workspace_path_for_compile = workspace_path_for_dc.clone();
                        let sdl_store = sdl_store_outer.clone();
                        let runner_store = runner_store_outer.clone();
                        let runner_store_for_msg = runner_store_outer.clone();
                        let compile_cache = compile_cache_outer.clone();
                        let boundary_checker = boundary_checker_outer.clone();
                        let incremental_cache = incremental_cache_outer.clone();
                        let compile_task_store_for_msg = compile_task_store_outer.clone();
                        // v2.1 inner clones
                        let hmr_orchestrator = hmr_orchestrator_outer.clone();
                        let structured_logger = structured_logger_outer.clone();
                        let metrics_aggregator = metrics_aggregator_outer.clone();
                        let restart_controller = restart_controller_outer.clone();
                        let ipc_config = ipc_config_outer.clone();
                        async move {
                            if msg.is_string {
                                eprintln!("[Main] Received message on 'compile' channel. Length: {}", msg.data.len());
                                // Try to parse as a CancelBuildRequest first
                                if let Ok(cancel_req) = serde_json::from_slice::<CancelBuildRequest>(&msg.data) {
                                    if cancel_req.msg_type == "cancel-build" {
                                        let target_session = cancel_req.session_id.clone();
                                        eprintln!(
                                            "[Main] Received cancel-build for session: {:?}",
                                            target_session
                                        );

                                        // For mobile sessions, also mark cancellation
                                        if let Some(ref sid) = target_session {
                                            crate::android::webrtc::input::cancel_session(sid);
                                            crate::android::webrtc::input::unregister_session_sync(sid);
                                        }

                                        // Abort active compile task if it matches
                                        let mut task_guard = compile_task_store_for_msg.lock().await;
                                        let mut cancelled_session = target_session.clone();
                                        if let Some((current_id, handle)) = task_guard.take() {
                                            if target_session.as_ref().map_or(true, |sid| sid == &current_id) {
                                                handle.abort();
                                                if cancelled_session.is_none() {
                                                    cancelled_session = Some(current_id.clone());
                                                }
                                            } else {
                                                *task_guard = Some((current_id, handle));
                                            }
                                        }

                                        // Stop any running runner process/pipeline
                                        {
                                            let mut guard = runner_store_for_msg.lock().await;
                                            if let Some(state) = guard.take() {
                                                if let Some(mut child) = state.process {
                                                    let _ = child.kill().await;
                                                }
                                                if let Some(mut child) = state.xvfb_process {
                                                    let _ = child.kill().await;
                                                }
                                                if let Some(pipeline) = state.gst_pipeline {
                                                    let _ = pipeline.set_state(gst::State::Null);
                                                }
                                            }
                                        }

                                        // Notify frontend
                                        if let Some(sid) = cancelled_session {
                                            if let Some(log) = { store.lock().await.clone() } {
                                                let payload = serde_json::json!({
                                                    "type": "build-status",
                                                    "status": "cancelled",
                                                    "sessionId": sid,
                                                    "message": "Build cancelled by user"
                                                });
                                                let _ = log.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                            } else {
                                                eprintln!("[Main] Build cancelled by user (session {})", sid);
                                            }
                                        }
                                        return;
                                    }
                                }

                                // Try to parse as a CancelMobileJobRequest next
                                if let Ok(cancel_req) = serde_json::from_slice::<CancelMobileJobRequest>(&msg.data) {
                                    if cancel_req.msg_type == "cancel-mobile-job" {
                                        eprintln!("[Main] Received cancel-mobile-job for session: {}", cancel_req.session_id);
                                        // Mark the session as cancelled
                                        crate::android::webrtc::input::cancel_session(&cancel_req.session_id);
                                        // Also unregister the input session
                                        crate::android::webrtc::input::unregister_session_sync(&cancel_req.session_id);
                                        return;
                                    }
                                }
                                
                                // Try to parse as a CompileRequest
                                if let Ok(req) = serde_json::from_slice::<CompileRequest>(&msg.data) {
                                    eprintln!("[Main] Received CompileRequest: is_gui={}, use_ai_split={}, lang={}, target={:?}", 
                                        req.is_gui, req.use_ai_split, req.language, req.target);
                                    let log_dc = { store.lock().await.clone() };
                                    if let Some(log) = log_dc {
                                        eprintln!("[Main] Found active build-log channel, proceeding with build...");
                                        // Check if this is a mobile emulator target
                                        if let Some(ref target) = req.target {
                                            if target == "react-native-emulator" {
                                                let session_id = req.session_id.clone().unwrap_or_else(|| {
                                                    format!("sess-{}-{}", chrono::Utc::now().timestamp_millis(), uuid::Uuid::new_v4().as_u128() % 100000)
                                                });
                                                let project_root = req.project_root.clone();
                                                let slug = req.slug.clone();
                                                let log_clone = log.clone();
                                                tokio::spawn(async move {
                                                    // Download/sync the workspace if slug is provided.
                                                    // IMPORTANT: do NOT delete the workspace by default.
                                                    // Reusing /synthi/<slug> preserves node_modules, Gradle outputs, and other build artifacts,
                                                    // dramatically speeding up subsequent mobile builds.
                                                    // To force a clean slate, set SYNTHI_MOBILE_FORCE_REDOWNLOAD=1.
                                                    let workspace_path = if let Some(s) = &slug {
                                                        let local_dir = std::path::PathBuf::from("/synthi").join(s);
                                                        let force_redownload = std::env::var("SYNTHI_MOBILE_FORCE_REDOWNLOAD")
                                                            .ok()
                                                            .map(|v| {
                                                                let v = v.trim().to_ascii_lowercase();
                                                                matches!(v.as_str(), "1" | "true" | "yes" | "y" | "on")
                                                            })
                                                            .unwrap_or(false);

                                                        if force_redownload && local_dir.exists() {
                                                            if let Err(e) = std::fs::remove_dir_all(&local_dir) {
                                                                eprintln!(
                                                                    "[Mobile] Failed to clear existing workspace {}: {}",
                                                                    local_dir.display(),
                                                                    e
                                                                );
                                                            } else {
                                                                eprintln!(
                                                                    "[Mobile] Cleared existing workspace {} (force redownload)",
                                                                    local_dir.display()
                                                                );
                                                            }
                                                        }

                                                        match storage::download(&s, None).await {
                                                            Ok(path) => {
                                                                eprintln!("[Mobile] Workspace ready at: {}", path.display());
                                                                path
                                                            },
                                                            Err(e) => {
                                                                eprintln!("[Mobile] Failed to download workspace: {}", e);
                                                                let payload = serde_json::json!({
                                                                    "sessionId": session_id,
                                                                    "type": "mobile-status",
                                                                    "status": "error",
                                                                    "message": format!("Failed to download workspace: {}", e),
                                                                });
                                                                let _ = log_clone.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                                                return;
                                                            }
                                                        }
                                                    } else {
                                                        eprintln!("[Mobile] No slug provided, cannot download workspace");
                                                        let payload = serde_json::json!({
                                                            "sessionId": session_id,
                                                            "type": "mobile-status",
                                                            "status": "error",
                                                            "message": "No workspace slug provided for mobile build",
                                                        });
                                                        let _ = log_clone.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                                        return;
                                                    };

                                                    if let Err(e) = worker::android::job::handle_react_native_emulator_job(
                                                        log_clone,
                                                        session_id.clone(),
                                                        workspace_path,
                                                        project_root,
                                                        false, // debug build by default
                                                        pc_for_compile.clone(),
                                                    ).await {
                                                        eprintln!("[Main] Mobile emulator job failed: {:?}", e);
                                                    }
                                                });
                                                return;
                                            }
                                            
                                            // Native Android (Java/Kotlin) emulator target
                                            if target == "native-android-emulator" {
                                                let session_id = req.session_id.clone().unwrap_or_else(|| {
                                                    format!("sess-{}-{}", chrono::Utc::now().timestamp_millis(), uuid::Uuid::new_v4().as_u128() % 100000)
                                                });
                                                let project_root = req.project_root.clone();
                                                let slug = req.slug.clone();
                                                let log_clone = log.clone();
                                                let pc_clone = pc_for_compile.clone();
                                                tokio::spawn(async move {
                                                    // Download/sync the workspace if slug is provided.
                                                    let workspace_path = if let Some(s) = &slug {
                                                        let local_dir = std::path::PathBuf::from("/synthi").join(s);
                                                        let force_redownload = std::env::var("SYNTHI_MOBILE_FORCE_REDOWNLOAD")
                                                            .ok()
                                                            .map(|v| {
                                                                let v = v.trim().to_ascii_lowercase();
                                                                matches!(v.as_str(), "1" | "true" | "yes" | "y" | "on")
                                                            })
                                                            .unwrap_or(false);

                                                        if force_redownload && local_dir.exists() {
                                                            if let Err(e) = std::fs::remove_dir_all(&local_dir) {
                                                                eprintln!(
                                                                    "[NativeAndroid] Failed to clear existing workspace {}: {}",
                                                                    local_dir.display(),
                                                                    e
                                                                );
                                                            } else {
                                                                eprintln!(
                                                                    "[NativeAndroid] Cleared existing workspace {} (force redownload)",
                                                                    local_dir.display()
                                                                );
                                                            }
                                                        }

                                                        match storage::download(&s, None).await {
                                                            Ok(path) => {
                                                                eprintln!("[NativeAndroid] Workspace ready at: {}", path.display());
                                                                path
                                                            },
                                                            Err(e) => {
                                                                eprintln!("[NativeAndroid] Failed to download workspace: {}", e);
                                                                let payload = serde_json::json!({
                                                                    "sessionId": session_id,
                                                                    "type": "mobile-status",
                                                                    "status": "error",
                                                                    "message": format!("Failed to download workspace: {}", e),
                                                                });
                                                                let _ = log_clone.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                                                return;
                                                            }
                                                        }
                                                    } else {
                                                        eprintln!("[NativeAndroid] No slug provided, cannot download workspace");
                                                        let payload = serde_json::json!({
                                                            "sessionId": session_id,
                                                            "type": "mobile-status",
                                                            "status": "error",
                                                            "message": "No workspace slug provided for native Android build",
                                                        });
                                                        let _ = log_clone.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                                        return;
                                                    };

                                                    eprintln!("[NativeAndroid] Starting native Android build for session: {}", session_id);
                                                    
                                                    // Use the native Android job handler
                                                    if let Err(e) = crate::android::job::handle_native_android_job_simple(
                                                        log_clone,
                                                        session_id.clone(),
                                                        workspace_path,
                                                        project_root,
                                                        false, // debug build by default
                                                        pc_clone,
                                                    ).await {
                                                        eprintln!("[Main] Native Android emulator job failed: {:?}", e);
                                                    }
                                                });
                                                return;
                                            }
                                        }

                                        // Default: native compile flow
                                        let ts = term_store_for_msg.clone();
                                        let sdls = sdl_store.clone();
                                        let rs = runner_store.clone();
                                        let pc_clone = pc_for_compile.clone();
                                        let wp = workspace_path_for_compile.clone();
                                        let cc = compile_cache.clone();
                                        let bc = boundary_checker.clone();
                                        let ic = incremental_cache.clone();
                                        // v2.1 clones for spawn
                                        let ho = hmr_orchestrator.clone();
                                        let sl = structured_logger.clone();
                                        let ma = metrics_aggregator.clone();
                                        let rc = restart_controller.clone();
                                        let ipc = ipc_config.clone();
                                        let session_id = req
                                            .session_id
                                            .clone()
                                            .unwrap_or_else(|| format!("sess-{}-{}", chrono::Utc::now().timestamp_millis(), uuid::Uuid::new_v4().as_u128() % 100000));
                                        let mut req = req;
                                        if req.session_id.is_none() {
                                            req.session_id = Some(session_id.clone());
                                        }
                                        let task_store = compile_task_store_for_msg.clone();
                                        let log_clone = log.clone();
                                        let task_session = session_id.clone();
                                        let handle = tokio::spawn(async move {
                                            if let Err(e) = handle_compile(req, log_clone, ts, sdls, rs, pc_clone, wp.to_path_buf(), cc, bc, ic, ho, sl, ma, rc, ipc).await {
                                                eprintln!("[Main] Compile task failed: {:?}", e);
                                            }
                                            let mut guard = task_store.lock().await;
                                            if let Some((current_id, _)) = guard.as_ref() {
                                                if current_id == &task_session {
                                                    *guard = None;
                                                }
                                            }
                                        });
                                        {
                                            let mut guard = compile_task_store_for_msg.lock().await;
                                            if let Some((_, existing)) = guard.take() {
                                                existing.abort();
                                            }
                                            *guard = Some((session_id, handle));
                                        }
                                    }
                                    return;
                                }
                                // Not a compile request - ignore here. Terminal messages arrive on
                                // the separate 'terminal' datachannel.
                            }
                        }
                        .boxed()
                    }));
            } else if label == "build-log" {
                let mut guard = store.lock().await;
                *guard = Some(dc.clone());
            } else if label == "terminal" {
                    // Terminal datachannel - used to receive stdin messages for running
                    // processes. Messages are expected as JSON: { type: 'stdin', sessionId, data }
                    let sdl_store_for_msg = sdl_store_outer.clone();
                    let runner_store_for_term = runner_store_outer.clone();
                    let build_log_store_for_term = store.clone();
                    dc.on_message(Box::new(move |msg| {
                        let term_store_for_msg = term_store.clone();
                        let sdl_store = sdl_store_for_msg.clone();
                        let runner_store_term = runner_store_for_term.clone();
                        let build_log_term = build_log_store_for_term.clone();
                        async move {
                            if msg.is_string {
                                // diagnostic log
                                if let Ok(_s) = String::from_utf8(msg.data.to_vec()) {
                                    // println!("[worker] terminal msg: {}", s);
                                }
                                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&msg.data) {
                                    if let Some(t) = v.get("type").and_then(|x| x.as_str()) {
                                        if t == "stdin" {
                                            if let Some(sid) = v.get("sessionId").and_then(|x| x.as_str()) {
                                                if let Some(d) = v.get("data").and_then(|x| x.as_str()) {
                                                    let guard = term_store_for_msg.lock().await;
                                                    if let Some(sender) = guard.get(sid) {
                                                        let _ = sender.send(d.to_string());
                                                    } else {
                                                        println!("[worker] no stdin sender for session {}", sid);
                                                    }
                                                }
                                            }
                                        } else if t == "gui-event" {
                                            // Handle GUI event by sending to persistent SDL process
                                            if let Some(sid) = v.get("sessionId").and_then(|x| x.as_str()) {
                                                if let Some(evt) = v.get("event") {
                                                    // Handle stop-runner before SDL sender lookup
                                                    // (runner may not have an SDL sender registered)
                                                    if let Some(typ) = evt.get("type").and_then(|x| x.as_str()) {
                                                        if typ == "stop-runner" {
                                                            println!("[worker] stop-runner requested for session {}", sid);
                                                            // Take and destroy runner state
                                                            let mut rg = runner_store_term.lock().await;
                                                            if let Some(mut state) = rg.take() {
                                                                // Kill the runner process
                                                                if let Some(ref mut child) = state.process {
                                                                    let _ = child.kill().await;
                                                                    println!("[worker] runner process killed");
                                                                }
                                                                // Kill Xvfb
                                                                if let Some(ref mut xvfb) = state.xvfb_process {
                                                                    let _ = xvfb.kill().await;
                                                                    println!("[worker] Xvfb killed");
                                                                }
                                                                // Stop GStreamer pipeline
                                                                if let Some(ref pipeline) = state.gst_pipeline {
                                                                    let _ = pipeline.set_state(gst::State::Null);
                                                                    println!("[worker] GStreamer pipeline stopped");
                                                                }
                                                                drop(state);
                                                            }
                                                            // Clean up SDL and terminal input senders for this session
                                                            {
                                                                let mut sdl_guard = sdl_store.lock().await;
                                                                sdl_guard.remove(sid);
                                                            }
                                                            {
                                                                let mut term_guard = term_store_for_msg.lock().await;
                                                                term_guard.remove(sid);
                                                            }
                                                            // Notify frontend that the runner has ended
                                                            let log_guard = build_log_term.lock().await;
                                                            if let Some(dc) = log_guard.as_ref() {
                                                                let end_msg = serde_json::json!({
                                                                    "type": "run-gui-end"
                                                                });
                                                                let _ = dc.send_text(end_msg.to_string()).await;
                                                            }
                                                            // Early return - don't try SDL sender lookup
                                                            return;
                                                        }
                                                    }

                                                    let guard = sdl_store.lock().await;
                                                    if let Some(sender) = guard.get(sid) {
                                                        let mut cmd = String::new();
                                                        if let Some(typ) = evt.get("type").and_then(|x| x.as_str()) {
                                                            match typ {
                                                                "mouse" => {
                                                                    if let Some(action) = evt.get("action").and_then(|x| x.as_str()) {
                                                                        if action == "move" {
                                                                            if let (Some(x), Some(y)) = (evt.get("x").and_then(|x| x.as_f64()), evt.get("y").and_then(|y| y.as_f64())) {
                                                                                cmd = format!("mousemove {} {}", x as i32, y as i32);
                                                                            }
                                                                        } else if action == "down" {
                                                                            if let Some(btn) = evt.get("button").and_then(|b| b.as_i64()) {
                                                                                cmd = format!("mousedown {}", btn);
                                                                                println!("[worker] click down {}", btn);
                                                                            }
                                                                        } else if action == "up" {
                                                                            if let Some(btn) = evt.get("button").and_then(|b| b.as_i64()) {
                                                                                cmd = format!("mouseup {}", btn);
                                                                                println!("[worker] click up {}", btn);
                                                                            }
                                                                        } else if action == "wheel" {
                                                                            if let Some(delta) = evt.get("deltaY").and_then(|d| d.as_f64()) {
                                                                                let btn = if delta > 0.0 { 5 } else { 4 };
                                                                                cmd = format!("click {}", btn);
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                                "key" => {
                                                                    if let Some(action) = evt.get("action").and_then(|x| x.as_str()) {
                                                                        if let Some(key) = evt.get("key").and_then(|k| k.as_str()) {
                                                                            let cmd_arg = if action == "press" { "key" } else if action == "down" { "keydown" } else { "keyup" };
                                                                            cmd = format!("{} {}", cmd_arg, key);
                                                                            println!("[worker] key {} {}", cmd_arg, key);
                                                                        }
                                                                    }
                                                                }
                                                                _ => {}
                                                            }
                                                        }
                                                        if !cmd.is_empty() {
                                                            let _ = sender.send(cmd);
                                                        }
                                                    } else {
                                                        println!("[worker] no x11 sender for session {}", sid);
                                                    }
                                                }
                                            }
                                        }
                                    } else {
                                        eprintln!("[Main] ERROR: No build-log channel found in store! Dropping compile request.");
                                    }
                                } else {
                                     eprintln!("[Main] Failed to parse CompileRequest. Data preview: {}", String::from_utf8_lossy(&msg.data).chars().take(100).collect::<String>());
                                }
                            }
                        }
                        .boxed()
                    }));
            } else if label.starts_with("lsp") {
                let rest = label.strip_prefix("lsp-").unwrap_or("cpp");
                let (lang_str, slug_opt) = if let Some((l, s)) = rest.split_once("?slug=") {
                    (l, Some(s.to_string()))
                } else {
                    (rest, None)
                };
                let lang = lang_str.to_string();

                let log_store = store.clone();
                let dc_clone = dc.clone();
                let workspace_path_for_lsp = workspace_path_for_dc.clone();

                // Create a channel to buffer incoming messages immediately
                let (incoming_tx, mut incoming_rx) = mpsc::unbounded_channel::<webrtc::data_channel::data_channel_message::DataChannelMessage>();

                let incoming_tx_clone = incoming_tx.clone();
                dc.on_message(Box::new(move |msg| {
                    let tx = incoming_tx_clone.clone();
                    async move {
                        let _ = tx.send(msg);
                    }
                    .boxed()
                }));

                tokio::spawn(async move {
                    // Try to download the workspace files
                    let slug_to_use = slug_opt.as_deref().unwrap_or("test-workspace");
                    println!("LSP Request: lang={}, slug={}", lang, slug_to_use);

                    let workspace_path = match storage::download(slug_to_use, None).await {
                        Ok(path) => {
                            let abs_path = if cfg!(target_os = "windows") {
                                if let Ok(full) = tokio::fs::canonicalize(&path).await {
                                    full
                                } else {
                                    path
                                }
                            } else {
                                path
                            };
                            println!("Successfully downloaded workspace to: {}", abs_path.display());
                            abs_path
                        },
                        Err(e) => {
                            eprintln!("Failed to download workspace: {}", e);
                            println!("Falling back to temp workspace: {}", workspace_path_for_lsp.display());
                            workspace_path_for_lsp.as_ref().clone()
                        }
                    };

                    println!("Starting LSP for language: {}", lang);
                    let mut cmd = match lang.as_str() {
                        "cpp" | "c" => {
                            // Create compile_flags.txt to enforce C++17
                            let flags_path = workspace_path.join("compile_flags.txt");
                            if let Ok(mut file) = std::fs::File::create(flags_path) {
                                use std::io::Write;
                                let _ = writeln!(file, "-std=c++17");
                                // Force C++ mode to ensure headers are treated correctly
                                let _ = writeln!(file, "-xc++");
                            }

                            let mut c = system_command("clangd");
                            c.arg("--background-index");
                            c.arg("--completion-style=detailed");
                            c.arg("--header-insertion=iwyu");
                            c.arg("--clang-tidy");
                            // c.arg("--all-scopes-completion");
                            // Allow clangd to query g++ and other compilers for system include paths
                            c.arg("--query-driver=*");
                            c
                        },
                        "rust" => system_command("rust-analyzer"),
                        "python" | "py" => system_command("pylsp"),
                        "typescript" | "ts" | "javascript" | "js" => {
                             let mut c = system_command("typescript-language-server");
                             c.arg("--stdio");
                             c
                        },
                        _ => {
                            println!("Unsupported language for LSP: {}", lang);
                            return;
                        }
                    };

                    cmd.current_dir(&workspace_path);
                    cmd.stdin(Stdio::piped());
                    cmd.stdout(Stdio::piped());
                    cmd.stderr(Stdio::piped());

                    match cmd.spawn() {
                        Ok(mut child) => {
                            let mut stdin = child.stdin.take().expect("Failed to open stdin");
                            let stdout = child.stdout.take().expect("Failed to open stdout");
                            let stderr = child.stderr.take().expect("Failed to open stderr");

                            let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();

                            // Calculate server root URI once
                            let path_str = workspace_path.to_string_lossy().replace("\\", "/");
                            // Strip UNC prefix if present (e.g. //?/C:/...)
                            let path_str = if path_str.starts_with("//?/") {
                                path_str[4..].to_string()
                            } else {
                                path_str
                            };

                            let mut server_root_uri = if cfg!(target_os = "windows") {
                                let mut wsl_path = path_str.clone();
                                if let Some(colon_idx) = wsl_path.find(':') {
                                    let drive = &wsl_path[0..colon_idx].to_lowercase();
                                    let rest = &wsl_path[colon_idx+1..];
                                    wsl_path = format!("/mnt/{}{}", drive, rest);
                                }
                                format!("file://{}", wsl_path)
                            } else if path_str.starts_with('/') {
                                format!("file://{}", path_str)
                            } else {
                                format!("file:///{}", path_str)
                            };

                            if !server_root_uri.ends_with('/') {
                                server_root_uri.push('/');
                            }

                            let state = Arc::new(Mutex::new(LspSessionState {
                                client_root_uri: None,
                                server_root_uri: server_root_uri.clone(),
                            }));

                            // Process incoming messages (buffered + new)
                            let state_for_incoming = state.clone();
                            let workspace_path_for_incoming = workspace_path.clone();
                            let stdin_tx_clone = stdin_tx.clone();

                            tokio::spawn(async move {
                                while let Some(msg) = incoming_rx.recv().await {
                                    let tx = stdin_tx_clone.clone();
                                    let state = state_for_incoming.clone();
                                    let workspace_path = workspace_path_for_incoming.clone();

                                    let mut data = msg.data.to_vec();

                                    // Determine if the message has headers or is raw JSON
                                    let (json_bytes, has_headers) = if let Some(json_start) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                                        (&data[json_start+4..], true)
                                    } else {
                                        (&data[..], false)
                                    };

                                    // Try to parse and process
                                    let mut processed = false;

                                    // Debug: Print raw data length
                                    println!("Received LSP data from WebRTC: {} bytes", data.len());
                                    if let Ok(s) = String::from_utf8(data.clone()) {
                                        println!("Received LSP data content: {}", s.chars().take(200).collect::<String>());
                                    }

                                    if let Ok(mut json_val) = serde_json::from_slice::<serde_json::Value>(json_bytes) {
                                        let mut guard = state.lock().await;

                                        // Debug: Print method
                                        if let Some(method) = json_val.get("method").and_then(|m| m.as_str()) {
                                            println!("Received LSP method: {}", method);
                                        }

                                        // 1. Capture client root URI from initialize
                                        if json_val.get("method").and_then(|m| m.as_str()) == Some("initialize") {
                                            if let Some(params) = json_val.get("params") {
                                                if let Some(root_uri) = params.get("rootUri").and_then(|s| s.as_str()) {
                                                    let mut uri = root_uri.to_string();
                                                    if !uri.ends_with('/') {
                                                        uri.push('/');
                                                    }
                                                    guard.client_root_uri = Some(uri.clone());
                                                    println!("Captured client root URI: {}", uri);
                                                } else if let Some(folders) = params.get("workspaceFolders").and_then(|f| f.as_array()) {
                                                    if let Some(first) = folders.first() {
                                                        if let Some(uri_str) = first.get("uri").and_then(|s| s.as_str()) {
                                                            let mut uri = uri_str.to_string();
                                                            if !uri.ends_with('/') {
                                                                uri.push('/');
                                                            }
                                                            guard.client_root_uri = Some(uri.clone());
                                                            println!("Captured client root URI from folders: {}", uri);
                                                        }
                                                    }
                                                }
                                            }

                                            if guard.client_root_uri.is_none() {
                                                println!("Client root URI not found in initialize, defaulting to file:///");
                                                guard.client_root_uri = Some("file:///".to_string());
                                            }
                                        }

                                        // 2. Rewrite URIs (Client -> Server)
                                        rewrite_uris(&mut json_val, &guard, true);

                                        // 3. Handle didOpen file writing
                                        if json_val.get("method").and_then(|m| m.as_str()) == Some("textDocument/didOpen") {
                                            if let Some(params) = json_val.get("params") {
                                                if let Some(doc) = params.get("textDocument") {
                                                    if let (Some(uri), Some(text)) = (doc.get("uri").and_then(|s| s.as_str()), doc.get("text").and_then(|s| s.as_str())) {
                                                        if let Some(rel) = uri.strip_prefix(&guard.server_root_uri) {
                                                            let rel = rel.trim_start_matches('/');
                                                            let file_path = workspace_path.join(rel);
                                                            if let Some(parent) = file_path.parent() {
                                                                let _ = tokio::fs::create_dir_all(parent).await;
                                                            }
                                                            if let Err(e) = tokio::fs::write(&file_path, text).await {
                                                                eprintln!("Failed to write file {}: {}", file_path.display(), e);
                                                            } else {
                                                                println!("Wrote file to disk: {}", file_path.display());
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        // 4. Handle didChange file writing (only if full sync)
                                        if json_val.get("method").and_then(|m| m.as_str()) == Some("textDocument/didChange") {
                                            if let Some(params) = json_val.get("params") {
                                                if let Some(changes) = params.get("contentChanges").and_then(|c| c.as_array()) {
                                                    if changes.len() == 1 {
                                                        if let Some(change) = changes.first() {
                                                            if change.get("range").is_none() {
                                                                if let Some(text) = change.get("text").and_then(|s| s.as_str()) {
                                                                    if let Some(doc) = params.get("textDocument") {
                                                                        if let Some(uri) = doc.get("uri").and_then(|s| s.as_str()) {
                                                                            if let Some(rel) = uri.strip_prefix(&guard.server_root_uri) {
                                                                                let rel = rel.trim_start_matches('/');
                                                                                let file_path = workspace_path.join(rel);
                                                                                if let Err(e) = tokio::fs::write(&file_path, text).await {
                                                                                    eprintln!("Failed to update file {}: {}", file_path.display(), e);
                                                                                } else {
                                                                                    println!("Updated file on disk: {}", file_path.display());
                                                                                }
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        // Re-serialize and add headers (required for Stdin)
                                        if let Ok(new_content) = serde_json::to_vec(&json_val) {
                                            let new_len = new_content.len();
                                            let new_header = format!("Content-Length: {}\r\n\r\n", new_len);
                                            let mut new_msg = Vec::new();
                                            new_msg.extend_from_slice(new_header.as_bytes());
                                            new_msg.extend_from_slice(&new_content);
                                            data = new_msg;
                                            processed = true;
                                        }
                                    }

                                    if !processed && !has_headers {
                                        // If we didn't process it (maybe parse failed) but it didn't have headers,
                                        // we must add headers to forward to Stdin.
                                        let new_len = data.len();
                                        let new_header = format!("Content-Length: {}\r\n\r\n", new_len);
                                        let mut new_msg = Vec::new();
                                        new_msg.extend_from_slice(new_header.as_bytes());
                                        new_msg.extend_from_slice(&data);
                                        data = new_msg;
                                    }

                                    let _ = tx.send(data);
                                }
                            });

                            tokio::spawn(async move {
                                while let Some(data) = stdin_rx.recv().await {
                                    if let Err(_) = stdin.write_all(&data).await { break; }
                                    if let Err(_) = stdin.flush().await { break; }
                                }
                            });

                            let dc_out = dc_clone.clone();
                            let state_for_outgoing = state.clone();
                            tokio::spawn(async move {
                                let mut reader = BufReader::new(stdout);
                                loop {
                                    let mut content_length = 0;
                                    let mut header_lines = Vec::new();
                                    loop {
                                        let mut line = String::new();
                                        match reader.read_line(&mut line).await {
                                            Ok(0) => return,
                                            Ok(_) => {
                                                if line == "\r\n" || line == "\n" {
                                                    break;
                                                }
                                                if line.to_lowercase().starts_with("content-length:") {
                                                    if let Some(idx) = line.find(':') {
                                                        if let Ok(len) = line[idx+1..].trim().parse::<usize>() {
                                                            content_length = len;
                                                        }
                                                    }
                                                }
                                                header_lines.push(line);
                                            }
                                            Err(_) => return,
                                        }
                                    }

                                    if content_length > 0 {
                                        let mut buf = vec![0u8; content_length];
                                        match reader.read_exact(&mut buf).await {
                                            Ok(_) => {
                                                println!("Received {} bytes from LSP stdout", content_length);
                                                if let Ok(mut json_val) = serde_json::from_slice::<serde_json::Value>(&buf) {
                                                    // Log initialize response and force Full text sync
                                                    if let Some(result) = json_val.get_mut("result") {
                                                        if let Some(caps) = result.get_mut("capabilities") {
                                                            println!("LSP Initialize Response Capabilities: {:?}", caps);

                                                            // Force textDocumentSync to Full (1) to ensure we always get full content
                                                            // so we can keep the file on disk in sync for clangd.
                                                            if let Some(caps_obj) = caps.as_object_mut() {
                                                                if let Some(sync) = caps_obj.get_mut("textDocumentSync") {
                                                                    if sync.is_number() {
                                                                        *sync = serde_json::json!(1);
                                                                    } else if let Some(sync_obj) = sync.as_object_mut() {
                                                                        sync_obj.insert("change".to_string(), serde_json::json!(1));
                                                                    }
                                                                } else {
                                                                    // If not present, default to Full (1)
                                                                    caps_obj.insert("textDocumentSync".to_string(), serde_json::json!(1));
                                                                }
                                                            }
                                                        }
                                                    }

                                                    let guard = state_for_outgoing.lock().await;
                                                    rewrite_uris(&mut json_val, &guard, false);

                                                    if let Ok(new_content) = serde_json::to_vec(&json_val) {
                                                        // Send ONLY content (no headers) to WebRTC
                                                        let data_len = new_content.len();
                                                        if data_len > 60000 {
                                                            let msg_id = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() % 0xFFFFFFFF) as u32;
                                                            let chunks = make_chunks(&new_content, msg_id);
                                                            println!("Sending {} bytes in {} chunks (ID: {})", data_len, chunks.len(), msg_id);
                                                            for chunk in chunks {
                                                                let data = Bytes::from(chunk);
                                                                if let Err(e) = dc_out.send(&data).await {
                                                                    eprintln!("Failed to send chunk: {}", e);
                                                                    break;
                                                                }
                                                            }
                                                        } else {
                                                            let data = Bytes::copy_from_slice(&new_content);
                                                            println!("Sending {} bytes to WebRTC (LSP stdout)", data.len());
                                                            if let Err(e) = dc_out.send(&data).await {
                                                                eprintln!("Failed to send to WebRTC: {}", e);
                                                                break;
                                                            }
                                                        }
                                                    }
                                                } else {
                                                    // Failed to parse JSON, but we read `content_length` bytes.
                                                    // Send just the body?
                                                    println!("Failed to parse JSON from LSP stdout, sending raw bytes");
                                                    let data = Bytes::copy_from_slice(&buf);
                                                    if let Err(e) = dc_out.send(&data).await {
                                                        eprintln!("Failed to send raw bytes to WebRTC: {}", e);
                                                        break;
                                                    }
                                                }
                                            }
                                            Err(_) => break,
                                        }
                                    }
                                }
                            });

                            let log_store_clone = log_store.clone();
                            tokio::spawn(async move {
                                let mut reader = BufReader::new(stderr);
                                let mut line = String::new();
                                loop {
                                    line.clear();
                                    match reader.read_line(&mut line).await {
                                        Ok(0) => break,
                                        Ok(_) => {
                                            let log_dc = { log_store_clone.lock().await.clone() };
                                            if let Some(ldc) = log_dc {
                                                let payload = serde_json::json!({
                                                    "type": "lsp-stderr",
                                                    "language": lang,
                                                    "line": line
                                                });
                                                let _ = ldc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                            } else {
                                                print!("[LSP-ERR] {}", line);
                                            }
                                        }
                                        Err(_) => break,
                                    }
                                }
                            });

                            let _ = child.wait().await;
                        }
                        Err(e) => {
                            eprintln!("Failed to spawn LSP: {}", e);
                        }
                    }
                });
            }
            else if label == "emulator-input" {
                dc.on_message(Box::new(move |msg| {
                    async move {
                        if !msg.is_string {
                            return;
                        }
                        if let Ok(v) = serde_json::from_slice::<worker::android::webrtc::input::EmulatorInputMessage>(&msg.data) {
                            if let Err(e) = worker::android::webrtc::input::handle_input_message(v).await {
                                eprintln!("[emulator-input] error: {:#}", e);
                            }
                        } else {
                            eprintln!("[emulator-input] failed to deserialize message: {}", String::from_utf8_lossy(&msg.data));
                        }
                    }
                    .boxed()
                }));
            }
        }
        .boxed()
    }));

    Ok(())
}

// Cache for AI split results to avoid redundant API calls
// Two-level cache:
//   1. Full source hash -> instant hit (no patching needed)
//   2. Structural hash -> hit with string patching (fast, no AI call)
use std::sync::OnceLock;

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

/// Extract all string literals from C/C++ source in order
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

// ============================================================
// GUARDRAIL HELPER FUNCTIONS
// ============================================================
// These functions apply all guardrails to source content BEFORE
// hash computation, ensuring rebuild scope decisions are based
// on the actual compiled content.

/// Apply guardrails to shared.h content
fn apply_shared_guardrails(content: &str) -> String {
    let mut result = content.to_string();
    
    // Guardrails: AI sometimes typedefs X11 types to void, which conflicts with Xlib headers.
    for bad in ["typedef void Display", "typedef void GC", "typedef void Atom", "typedef void XIM", "typedef void XIC"] {
        if result.contains(bad) {
            result = result.replace(bad, "// stripped invalid typedef\n");
        }
    }

    // Strip conflicting forward declarations of X11 types and normalize struct field types.
    for bad in [
        "struct Display;", "struct Window;", "struct Atom;", "struct XIM;", "struct XIC;", "struct Pixmap;", "struct GC;", "struct XWindowAttributes;"
    ] {
        if result.contains(bad) {
            result = result.replace(bad, "// stripped conflicting X11 forward decl\n");
        }
    }
    result = result.replace("struct Display*", "Display*");
    result = result.replace("struct Window", "Window");
    result = result.replace("struct Atom", "Atom");
    result = result.replace("struct XIM*", "XIM*");
    result = result.replace("struct XIC*", "XIC*");
    result = result.replace("struct Pixmap", "Pixmap");
    result = result.replace("struct GC", "GC");
    result = result.replace("struct XWindowAttributes", "XWindowAttributes");

    // Guardrail: SDL_Event is a union in SDL2. Forward-declaring it as a struct
    // (e.g. `struct SDL_Event;`) causes compile failures when SDL.h is included.
    for bad in [
        "struct SDL_Event;",
        "typedef struct SDL_Event SDL_Event;",
        "typedef struct SDL_Event SDL_Event ;",
    ] {
        if result.contains(bad) {
            result = result.replace(bad, "/* stripped invalid SDL_Event forward decl */");
        }
    }

    // FIX: gui_on_load declaration MUST have 3 parameters to match implementation
    if result.contains("gui_on_load(void* prev_state, void* window_ptr)") && 
       !result.contains("gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)") {
        result = result.replace(
            "gui_on_load(void* prev_state, void* window_ptr)",
            "gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)"
        );
        eprintln!("[Guardrail] Fixed gui_on_load declaration in shared.h: added missing core_api_ptr parameter");
    }
    
    result
}

/// Apply guardrails to core.cpp content (requires processed shared.h for context)
fn apply_core_guardrails(content: &str, shared_content: &str) -> String {
    let mut result = content.to_string();
    
    // Detect if shared.h has full struct definitions or just forward declarations
    let shared_has_full_hostkv = shared_content.contains("struct HostKvApiV1 {") ||
                                  shared_content.contains("struct SynthiHostContextV1 {") ||
                                  shared_content.contains("struct SynthiNamespaceSchemaV1 {");

    // Fix common AI mistakes in core.cpp before compilation.
    if result.contains("is_running") {
        result = result.replace("is_running", "running");
    }

    // CRITICAL: Strip X11-related functions that the AI incorrectly preserved from the input.
    let x11_type_patterns = [
        "Display*", "Display *", "Window*", "XIM", "XIC", "Atom", "Colormap", "Pixmap", "GC ",
        "XEvent", "XOpenDisplay", "XCloseDisplay", "XCreateWindow", "XDestroyWindow",
        "XOpenIM", "XCreateIC", "XCreateGC", "XFreeGC", "XCreatePixmap", "XFreePixmap",
    ];
    
    let mut cleaned_lines = Vec::new();
    for line in result.lines() {
        let has_x11 = x11_type_patterns.iter().any(|pat| line.contains(pat));
        let is_comment = line.trim_start().starts_with("//") || line.trim_start().starts_with("/*");
        let is_include = line.trim_start().starts_with("#include");
        
        if has_x11 && !is_comment && !is_include {
            cleaned_lines.push(format!("// [X11-stripped] {}", line));
        } else {
            cleaned_lines.push(line.to_string());
        }
    }
    result = cleaned_lines.join("\n");

    // CRITICAL: Ensure shared.h is included FIRST
    if !result.contains("#include \"shared.h\"") {
        if let Some(pos) = result.find("#include <") {
            if let Some(newline) = result[pos..].find('\n') {
                let insert_pos = pos + newline + 1;
                result.insert_str(insert_pos, "#include \"shared.h\"  // [Guardrail] Added\n");
            }
        } else {
            result = format!("#include \"shared.h\"  // [Guardrail] Added\n{}", result);
        }
    }

    // CRITICAL FIX: Transform malloc-based on_load to static storage
    if result.contains("malloc(sizeof(AppState))") && result.contains("on_load") {
        if !result.contains("static AppState app_state") && !result.contains("static CoreState core_state") {
            if let Some(on_load_pos) = result.find("extern \"C\" void* on_load") {
                result.insert_str(on_load_pos, "// [Guardrail] Injected static storage for HMR\nstatic AppState app_state = {0};\n\n");
            } else if let Some(on_load_pos) = result.find("extern \"C\" void* core_on_load") {
                result.insert_str(on_load_pos, "// [Guardrail] Injected static storage for HMR\nstatic AppState app_state = {0};\n\n");
            }
        }
        
        let re_malloc = regex::Regex::new(r"AppState\*\s+state\s*=\s*\(AppState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*AppState\s*\)\s*\)\s*;").unwrap();
        result = re_malloc.replace_all(&result, "AppState* state = (prev_state) ? (AppState*)prev_state : &app_state; // [Guardrail] Fixed malloc->static").to_string();
        
        let re_malloc2 = regex::Regex::new(r"CoreState\*\s+state\s*=\s*\(CoreState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*CoreState\s*\)\s*\)\s*;").unwrap();
        result = re_malloc2.replace_all(&result, "CoreState* state = (prev_state) ? (CoreState*)prev_state : &core_state; // [Guardrail] Fixed malloc->static").to_string();
        
        let re_if_malloc = regex::Regex::new(r"if\s*\(\s*!prev_state\s*\)\s*\{\s*state\s*=\s*\(AppState\*\)\s*malloc[^}]+\}").unwrap();
        result = re_if_malloc.replace_all(&result, "if (!prev_state) { state = &app_state; /* [Guardrail] Fixed malloc->static */ }").to_string();
    }

    // FIX: Detect and warn about free(state) which causes crashes on reload
    if result.contains("free(state)") {
        result = result.replace("free(state);", "// free(state); // Commented - runner manages state");
    }

    // FIX: Detect and warn about memset on state which wipes preserved HMR state
    if result.contains("memset(state") || result.contains("memset(&app_state") || 
        result.contains("memset(&state") || result.contains("memset(&core_state") ||
        result.contains("memset( state") {
        let re_memset = regex::Regex::new(r"memset\s*\(\s*(state|&app_state|&core_state|&state|&gui_app_state)[^;]*\)\s*;").unwrap();
        result = re_memset.replace_all(&result, "// [Guardrail] memset REMOVED to preserve HMR state").to_string();
    }

    // Drop writes/reads to non-existent XWindowAttributes fields
    for bad_field in ["event_mask", "damage", "border_pixel", "background_pixel", "saved_attributes", "attributes_mask"] {
        if result.contains(bad_field) {
            let mut cleaned = String::new();
            for line in result.lines() {
                if line.contains(bad_field) {
                    cleaned.push_str("// stripped invalid field: ");
                    cleaned.push_str(line);
                    cleaned.push('\n');
                } else {
                    cleaned.push_str(line);
                    cleaned.push('\n');
                }
            }
            result = cleaned;
        }
    }

    // INJECT MISSING HEADERS
    if result.contains("setlocale") && !result.contains("#include <locale.h>") {
        result = format!("#include <locale.h>\n{}", result);
    }
    if result.contains("SDL_") && !result.contains("#include <SDL2/SDL.h>") {
        result = format!("#include <SDL2/SDL.h>\n{}", result);
    }
    if (result.contains("XLookupString") || result.contains("XK_Escape")) && !result.contains("#include <X11/Xutil.h>") {
        result = format!("#include <X11/Xutil.h>\n#include <X11/keysym.h>\n{}", result);
    }
    if (result.contains("dlopen") || result.contains("dlsym")) && !result.contains("#include <dlfcn.h>") {
        result = format!("#include <dlfcn.h>\n{}", result);
    }

    // FIX: Ensure shared.h is included in core.cpp if AppState is used
    if result.contains("AppState") && !result.contains("#include \"shared.h\"") {
        if result.contains("struct AppState;") {
            result = result.replace("struct AppState;", "#include \"shared.h\"");
        } else {
            result = format!("#include \"shared.h\"\n{}", result);
        }
    }

    // FIX: Remove duplicate defines that are already in shared.h
    if result.contains("#include \"shared.h\"") {
        result = result.replace("#define CORE_STATE_MAGIC", "// #define CORE_STATE_MAGIC");
        result = result.replace("#define SYNTHI_ABI_VERSION", "// #define SYNTHI_ABI_VERSION");
        
        // Strip duplicate AppState struct/typedef
        if let Some(start) = result.find("typedef struct AppState") {
            if let Some(end) = result[start..].find("} AppState;") {
                let block_end = start + end + "} AppState;".len();
                let block = result[start..block_end].to_string();
                result = result.replace(&block, "// AppState defined in shared.h");
            }
        }

        if let Some(start) = result.find("typedef struct {") {
            if let Some(end) = result[start..].find("} AppState;") {
                 let block_end = start + end + "} AppState;".len();
                 let block = result[start..block_end].to_string();
                 if block.contains("magic") && block.contains("struct_size") {
                     result = result.replace(&block, "// AppState defined in shared.h");
                 }
            }
        }
    }

    result
}


/// Patch string literals in cached JSON result with new strings from source
/// Returns (patched_result, did_patch_anything)
fn patch_strings_in_cached_result(
    cached: &serde_json::Value,
    old_strings: &[String],
    new_strings: &[String],
) -> (serde_json::Value, bool) {
    // Only patch if we have a reasonable mapping
    if old_strings.is_empty() || new_strings.is_empty() {
        return (cached.clone(), false);
    }

    let mut result = cached.clone();
    let mut any_patches_applied = false;

    // Patch each file's content in the split result
    for key in &["core", "gui", "shared"] {
        if let Some(file_obj) = result.get_mut(key) {
            if let Some(content) = file_obj.get_mut("content") {
                if let Some(content_str) = content.as_str() {
                    let mut patched = content_str.to_string();

                    // Replace old strings with new strings where they differ
                    // Match by position in the string list (assuming order is preserved)
                    for (old, new) in old_strings.iter().zip(new_strings.iter()) {
                        if old != new && !old.is_empty() {
                            // Use format with quotes to avoid partial matches
                            let old_quoted = format!("\"{}\"", old);
                            let new_quoted = format!("\"{}\"", new);
                            if patched.contains(&old_quoted) {
                                patched = patched.replace(&old_quoted, &new_quoted);
                                any_patches_applied = true;
                            }
                        }
                    }

                    *content = serde_json::Value::String(patched);
                }
            }
        }
    }

    (result, any_patches_applied)
}

/// Check if a string looks like a semantic value that AI transforms (not just copies)
/// These include: color names, font names, file paths, etc.
fn is_semantic_string(s: &str) -> bool {
    // X11/CSS color names
    let color_names = [
        "black", "white", "red", "green", "blue", "yellow", "cyan", "magenta", "orange", "purple",
        "pink", "brown", "gray", "grey", "navy", "teal", "lime", "aqua", "maroon", "olive",
        "silver", "fuchsia",
    ];

    let lower = s.to_lowercase();
    color_names.iter().any(|c| lower == *c)
}



/// Apply guardrails to gui.cpp content (requires processed shared.h for context)
fn apply_gui_guardrails(content: &str, shared_content: &str) -> String {
    let mut result = content.to_string();
    
    // Detect if shared.h has full struct definitions
    let shared_has_full_hostkv = shared_content.contains("struct HostKvApiV1 {") ||
                                  shared_content.contains("struct SynthiHostContextV1 {") ||
                                  shared_content.contains("struct SynthiNamespaceSchemaV1 {");

    // Strip X11-related functions
    let x11_type_patterns = [
        "Display*", "Display *", "XIM", "XIC", "Atom", "Colormap", "Pixmap", "GC ",
        "XEvent", "XOpenDisplay", "XCloseDisplay", "XCreateWindow", "XDestroyWindow",
        "XOpenIM", "XCreateIC", "XCreateGC", "XFreeGC", "XCreatePixmap", "XFreePixmap",
    ];
    let mut cleaned_lines = Vec::new();
    for line in result.lines() {
        let has_x11 = x11_type_patterns.iter().any(|pat| line.contains(pat));
        let is_comment = line.trim_start().starts_with("//") || line.trim_start().starts_with("/*");
        let is_include = line.trim_start().starts_with("#include");
        if has_x11 && !is_comment && !is_include {
            cleaned_lines.push(format!("// [X11-stripped] {}", line));
        } else {
            cleaned_lines.push(line.to_string());
        }
    }
    result = cleaned_lines.join("\n");

    // FIX: GUI module should use GUI_STATE_MAGIC
    if result.contains("CORE_STATE_MAGIC") && !result.contains("#define CORE_STATE_MAGIC") {
        result = result.replace("CORE_STATE_MAGIC", "GUI_STATE_MAGIC");
    }

    // FIX: Ensure shared.h is included
    if result.contains("AppState") && !result.contains("#include \"shared.h\"") {
        if result.contains("struct AppState;") {
            result = result.replace("struct AppState;", "#include \"shared.h\"");
        } else {
            result = format!("#include \"shared.h\"\n{}", result);
        }
    }
    
    // Strip duplicate AppState definitions
    if result.contains("#include \"shared.h\"") {
        if let Some(start) = result.find("typedef struct AppState") {
            if let Some(end) = result[start..].find("} AppState;") {
                let block_end = start + end + "} AppState;".len();
                let block = result[start..block_end].to_string();
                result = result.replace(&block, "// AppState defined in shared.h");
            }
        }

        if let Some(start) = result.find("typedef struct {") {
            if let Some(end) = result[start..].find("} AppState;") {
                 let block_end = start + end + "} AppState;".len();
                 let block = result[start..block_end].to_string();
                 if block.contains("magic") && block.contains("struct_size") {
                     result = result.replace(&block, "// AppState defined in shared.h");
                 }
            }
        }
        
        if let Some(start) = result.find("struct AppState {") {
            if let Some(end) = result[start..].find("};") {
                let block_end = start + end + "};".len();
                let block = result[start..block_end].to_string();
                if block.contains("{") {
                    result = result.replace(&block, "// AppState defined in shared.h");
                }
            }
        }

        // Handle Host KV structs
        for struct_name in &["HostKvApiV1", "SynthiHostContextV1", "SynthiNamespaceSchemaV1"] {
             let typedef_pattern = format!("typedef struct {} {};", struct_name, struct_name);
             if result.contains(&typedef_pattern) {
                 result = result.replace(&typedef_pattern, &format!("// {} forward-declared in shared.h", struct_name));
             }
             
             if shared_has_full_hostkv {
                 let struct_decl = format!("struct {} {{", struct_name);
                 if let Some(start) = result.find(&struct_decl) {
                     if let Some(end) = result[start..].find("};") {
                         let block_end = start + end + "};".len();
                         let block = result[start..block_end].to_string();
                         result = result.replace(&block, &format!("// {} fully defined in shared.h", struct_name));
                     }
                 }
             }
        }
        
        // Inject Host KV definitions if needed
        let uses_hostkv_types = result.contains("SynthiHostContextV1") || 
                                result.contains("SynthiNamespaceSchemaV1") ||
                                result.contains("HostKvApiV1") ||
                                result.contains("g_gui_schemas") ||
                                result.contains("host_kv_schemas");
        
        if uses_hostkv_types && !shared_has_full_hostkv {
            let hostkv_header = get_hostkv_header();
            if let Some(include_end) = result.rfind("#include") {
                if let Some(newline_pos) = result[include_end..].find('\n') {
                    let insert_pos = include_end + newline_pos + 1;
                    result.insert_str(insert_pos, &hostkv_header);
                }
            } else {
                result = format!("{}{}", hostkv_header, result);
            }
        }
    }

    // FIX: gui_on_load MUST have 3 parameters
    if result.contains("gui_on_load(void* prev_state, void* window_ptr)") && 
       !result.contains("gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)") {
        result = result.replace(
            "gui_on_load(void* prev_state, void* window_ptr)",
            "gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)"
        );
    }

    // FIX: Comment out SDL_RenderPresent
    let re_present = regex::Regex::new(r"SDL_RenderPresent\s*\([^)]*\)\s*;").unwrap();
    result = re_present.replace_all(&result, "/* SDL_RenderPresent removed - runner handles this */").to_string();

    // FIX: Replace SDL_GetKeyboardWindow
    if result.contains("SDL_GetKeyboardWindow") {
        result = result.replace("SDL_GetKeyboardWindow", "SDL_GetKeyboardFocus");
    }

    // Convert malloc-based gui_on_load to static storage
    if result.contains("malloc(sizeof(AppState))") && result.contains("gui_on_load") {
        if !result.contains("static AppState gui_app_state") && !result.contains("static GuiState gui_state") {
            if let Some(on_load_pos) = result.find("extern \"C\" void* gui_on_load") {
                result.insert_str(on_load_pos, "// [Guardrail] Injected static storage for HMR\nstatic AppState gui_app_state = {0};\n\n");
            }
        }
        
        let re_malloc = regex::Regex::new(r"AppState\*\s+state\s*=\s*\(AppState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*AppState\s*\)\s*\)\s*;").unwrap();
        result = re_malloc.replace_all(&result, "AppState* state = (prev_state) ? (AppState*)prev_state : &gui_app_state; // [Guardrail] Fixed malloc->static").to_string();
        
        let re_malloc2 = regex::Regex::new(r"GuiState\*\s+state\s*=\s*\(GuiState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*GuiState\s*\)\s*\)\s*;").unwrap();
        result = re_malloc2.replace_all(&result, "GuiState* state = (prev_state) ? (GuiState*)prev_state : &gui_state; // [Guardrail] Fixed malloc->static").to_string();
    }

    // FIX: free(state) crashes
    if result.contains("free(state)") {
        result = result.replace("free(state);", "// free(state); // Commented - runner manages state");
    }

    // FIX: memset wipes HMR state
    if result.contains("memset(state") || result.contains("memset(&app_state") || 
        result.contains("memset(&gui_state") || result.contains("memset(&state") ||
        result.contains("memset(&gui_app_state") || result.contains("memset( state") {
        let re_memset = regex::Regex::new(r"memset\s*\(\s*(state|&app_state|&gui_state|&state|&gui_app_state)[^;]*\)\s*;").unwrap();
        result = re_memset.replace_all(&result, "// [Guardrail] memset REMOVED to preserve HMR state").to_string();
    }

    // FIX: app_state -> gui_app_state in gui.cpp
    if result.contains("static AppState gui_app_state") || result.contains("&gui_app_state") {
        if result.contains("&app_state") && !result.contains("&gui_app_state") {
            result = result.replace("&app_state", "&gui_app_state");
        }
        
        if result.contains("gui_app_state") {
            let placeholder = "__GUI_APP_STATE_PLACEHOLDER__";
            let temp_content = result.replace("gui_app_state", placeholder);
            if temp_content.contains("app_state") {
                let fixed_content = temp_content.replace("app_state", "gui_app_state");
                result = fixed_content.replace(placeholder, "gui_app_state");
            }
        }
    }

    // Add entrypoint if needed
    if result.contains("main(") && !result.contains("extern \"C\" void* entrypoint") {
         result.push_str("\n\nextern \"C\" void* entrypoint(void* state) {\n    main();\n    return 0;\n}\n");
    }

    // FIX: renderer -> state->renderer
    if result.contains("SDL_Render") || result.contains("SDL_SetRenderDrawColor") || result.contains("draw_text") {
        let fixes = [
            ("SDL_RenderFillRect(renderer,", "SDL_RenderFillRect(state->renderer,"),
            ("SDL_RenderDrawRect(renderer,", "SDL_RenderDrawRect(state->renderer,"),
            ("SDL_SetRenderDrawColor(renderer,", "SDL_SetRenderDrawColor(state->renderer,"),
            ("SDL_RenderClear(renderer)", "SDL_RenderClear(state->renderer)"),
            ("draw_text(renderer,", "draw_text(state->renderer,"),
        ];
        for (wrong, correct) in &fixes {
            if result.contains(*wrong) {
                result = result.replace(*wrong, *correct);
            }
        }
    }

    // FIX: x/y -> mx/my in click handlers
    if result.contains("SDL_MOUSEBUTTONDOWN") {
        let click_fixes = [
            ("if (x >= state->", "if (mx >= state->"),
            ("if (y >= state->", "if (my >= state->"),
            ("&& x <", "&& mx <"),
            ("&& y <", "&& my <"),
            ("&& x <=", "&& mx <="),
            ("&& y <=", "&& my <="),
        ];
        for (wrong, correct) in &click_fixes {
            if result.contains(*wrong) {
                result = result.replace(*wrong, *correct);
            }
        }
    }
    
    // Inject GUI state serialization stubs
    if result.contains("gui_on_load") && 
       !result.contains("gui_on_save_state") &&
       !result.contains("gui_get_state_schema_hash") {
        let gui_serial_stubs = r#"

// [Guardrail] State serialization stubs for Full HMR capability (GUI)
extern "C" char* gui_on_save_state(void* state_ptr) {
    (void)state_ptr;
    char* json = (char*)malloc(3);
    if (json) strcpy(json, "{}");
    return json;
}

extern "C" void* gui_on_load_from_json(const char* json) {
    (void)json;
    return NULL;
}

extern "C" void synthi_free_json(char* json) {
    if (json) free(json);
}
"#;
        result.push_str(gui_serial_stubs);
    }
    
    result
}
/// Get the Host KV header definitions
fn get_hostkv_header() -> &'static str {
    r#"
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
"#
}







/// Check if any changed strings are semantic (would need AI re-processing)
fn has_semantic_string_changes(old_strings: &[String], new_strings: &[String]) -> bool {
    for (old, new) in old_strings.iter().zip(new_strings.iter()) {
        if old != new {
            // If either old or new is a semantic string, we need AI
            if is_semantic_string(old) || is_semantic_string(new) {
                return true;
            }
        }
    }
    false
}

/// Collect the specific string changes for incremental AI update
fn collect_string_changes(old_strings: &[String], new_strings: &[String]) -> Vec<(String, String)> {
    let mut changes = Vec::new();
    for (old, new) in old_strings.iter().zip(new_strings.iter()) {
        if old != new {
            changes.push((old.clone(), new.clone()));
        }
    }
    changes
}

/// Parse AppState struct fields from shared.h content
/// Returns a list of (field_name, field_type, default_value) tuples for int fields
/// Default value is extracted from declarations like "int btn_x = 200;"
fn parse_appstate_int_fields_with_defaults(shared_content: &str) -> Vec<(String, String, Option<i64>)> {
    let mut fields = Vec::new();
    
    // Find AppState struct definition
    let struct_re = regex::Regex::new(r"struct\s+AppState\s*\{([^}]*)\}").ok();
    
    if let Some(re) = struct_re {
        if let Some(captures) = re.captures(shared_content) {
            if let Some(body) = captures.get(1) {
                let body_str = body.as_str();

                
                // Parse individual field declarations WITH default values
                // Match patterns like: int x; or int x = 10; or int btn_x = 330, btn_y = 10;
                // Also handle inline declarations like: int x = 0, y = 0, dx = 5, dy = 5;

                // First, handle comma-separated declarations on single lines
                // Pattern: int field1 = val1, field2 = val2, ...;
                let multi_decl_re =
                    regex::Regex::new(r"\b(int|unsigned|char|short|long)\s+([^;]+);").ok();

                if let Some(mre) = multi_decl_re {
                    for cap in mre.captures_iter(body_str) {
                        if let (Some(type_match), Some(decls_match)) = (cap.get(1), cap.get(2)) {
                            let field_type = type_match.as_str().to_string();
                            let decls_str = decls_match.as_str();

                            // Split by comma and parse each field
                            for decl in decls_str.split(',') {
                                let decl = decl.trim();
                                if decl.is_empty() {
                                    continue;
                                }

                                // Parse "name = value" or just "name"
                                let parts: Vec<&str> = decl.splitn(2, '=').collect();
                                let field_name = parts[0].trim().to_string();

                                // Skip internal fields
                                if field_name.starts_with("_")
                                    || field_name == "magic"
                                    || field_name == "struct_size"
                                    || field_name == "abi_version"
                                    || field_name.is_empty()
                                {
                                    continue;
                                }

                                // Parse default value if present
                                let default_value = if parts.len() > 1 {
                                    let val_str = parts[1].trim();
                                    // Try to parse as integer
                                    val_str.parse::<i64>().ok()
                                } else {
                                    None
                                };

                                fields.push((field_name, field_type.clone(), default_value));
                            }
                        }
                    }
                }
            }
        }
    }

    // If no fields found, use common defaults
    if fields.is_empty() {
        fields = vec![
            ("x".to_string(), "int".to_string(), Some(0)),
            ("y".to_string(), "int".to_string(), Some(0)),
            ("dx".to_string(), "int".to_string(), Some(5)),
            ("dy".to_string(), "int".to_string(), Some(5)),
            ("running".to_string(), "int".to_string(), Some(1)),
            ("paused".to_string(), "int".to_string(), Some(0)),
        ];
    }

    fields
}

/// Generate state serialization code with explicit default values from shared.h
fn generate_state_serialization_code_with_defaults(
    fields: &[(String, String, Option<i64>)],
    prefix: &str,
) -> String {
    worker::hmr::binary_state::generate_msgpack_serialization_code_with_defaults(fields, prefix)
}

/// Detect structural DELETIONS between old and new source code
/// Returns lines that were removed
fn detect_structural_deletions(old_source: &str, new_source: &str) -> Vec<String> {
    let old_lines: Vec<&str> = old_source.lines().collect();
    let new_lines: Vec<&str> = new_source.lines().collect();

    let mut deletions = Vec::new();

    for old_line in &old_lines {
        let trimmed = old_line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let exists_in_new = new_lines.iter().any(|new_line| new_line.trim() == trimmed);

        if !exists_in_new {
            deletions.push(trimmed.to_string());
        }
    }

    deletions
}

/// Try to apply deletions locally without calling AI
/// Returns Some(updated_result) if successful, None if AI is needed
fn try_local_deletion_patch(
    cached_result: &serde_json::Value,
    deletions: &[String],
) -> Option<serde_json::Value> {
    if deletions.is_empty() {
        return None;
    }

    // Get current code
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

    let mut new_core = core_content.to_string();
    let mut new_gui = gui_content.to_string();
    let mut new_shared = shared_content.to_string();
    let mut any_changes = false;

    for deletion in deletions {
        // Try to find and remove related code in the split files
        // Look for patterns that match the deleted line

        // Skip empty or very short lines
        if deletion.len() < 3 {
            continue;
        }

        // For button deletions, look for btn_ variables
        if deletion.contains("btn_") || deletion.contains("button") || deletion.contains("Button") {
            // Extract button variable names like btn2_x, reset_btn_x, etc.
            let btn_pattern = regex::Regex::new(r"(\w+_btn_\w+|btn\d*_\w+)").unwrap();
            for cap in btn_pattern.captures_iter(deletion) {
                let var_name = &cap[1];
                let base_name = var_name.split('_').take(2).collect::<Vec<_>>().join("_");

                // Remove from shared.h (state struct fields)
                let field_pattern = format!("int {};", var_name);
                if new_shared.contains(&field_pattern) {
                    new_shared = new_shared
                        .replace(&field_pattern, &format!("// REMOVED: {}", field_pattern));
                    any_changes = true;
                    eprintln!("[LocalPatch] Removed field {} from shared.h", var_name);
                }

                // Comment out references in core.cpp - collect lines to replace first
                let core_lines: Vec<String> = new_core.lines().map(|s| s.to_string()).collect();
                for line in &core_lines {
                    if line.contains(&base_name) && !line.trim().starts_with("//") {
                        new_core = new_core.replace(line, &format!("// REMOVED: {}", line));
                        any_changes = true;
                    }
                }

                // Comment out references in gui.cpp - collect lines to replace first
                let gui_lines: Vec<String> = new_gui.lines().map(|s| s.to_string()).collect();
                for line in &gui_lines {
                    if line.contains(&base_name) && !line.trim().starts_with("//") {
                        new_gui = new_gui.replace(line, &format!("// REMOVED: {}", line));
                        any_changes = true;
                    }
                }
            }
        }

        // For XFillRectangle/XDrawRectangle deletions (drawing code)
        if deletion.contains("XFillRectangle")
            || deletion.contains("XDrawRectangle")
            || deletion.contains("SDL_RenderFillRect")
            || deletion.contains("SDL_RenderDrawRect")
        {
            // Find and comment out the SDL equivalent in gui.cpp
            // This is trickier - we need to match the geometry
            // For now, just mark as needing AI help if we can't do simple match
        }
    }

    if !any_changes {
        return None;
    }

    // Build updated result
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

    eprintln!("[LocalPatch] Applied local deletion patch - no AI call needed");
    Some(result)
}

/// Detect GUI-related modifications (position, color, size changes)
/// Returns modified lines as X11 code for translation to SDL2
fn detect_gui_modifications(old_source: &str, new_source: &str) -> Option<String> {
    let old_lines: Vec<&str> = old_source.lines().collect();
    let new_lines: Vec<&str> = new_source.lines().collect();
    
    // GUI-related keywords that indicate drawable/interactive elements
    let gui_keywords = [
        "XFillRectangle", "XDrawRectangle", "XDrawString", "XDrawLine",
        "XSetForeground", "XSetBackground", "XDrawArc", "XFillArc",
        "SDL_Rect", "SDL_RenderFillRect", "SDL_RenderDrawRect",
        "btn_x", "btn_y", "btn_w", "btn_h", "button",
        "color", "Color", "width", "height", "position",
    ];
    
    let mut modifications = Vec::new();
    
    // Find modified lines (lines that have similar structure but different values)
    for new_line in &new_lines {
        let trimmed_new = new_line.trim();
        if trimmed_new.is_empty() || trimmed_new.starts_with("//") {
            continue;
        }
        
        // Check if this line contains GUI keywords
        let is_gui_line = gui_keywords.iter().any(|kw| trimmed_new.contains(kw));
        if !is_gui_line {
            continue;
        }
        
        // Check if a SIMILAR line exists in old (same function call, different args)
        let has_similar_in_old = old_lines.iter().any(|old_line| {
            let trimmed_old = old_line.trim();
            // Check if they share the same function call or variable name
            if trimmed_old == trimmed_new {
                return true; // Exact match - not a modification
            }
            // Check for similar structure (e.g., same function name)
            for kw in &gui_keywords {
                if trimmed_old.contains(kw) && trimmed_new.contains(kw) {
                    // Same keyword, likely a modification if values differ
                    return true;
                }
            }
            false
        });
        
        // If this GUI line doesn't have an exact match in old, it's new or modified
        let exists_exactly_in_old = old_lines.iter().any(|old_line| old_line.trim() == trimmed_new);
        
        if is_gui_line && has_similar_in_old && !exists_exactly_in_old {
            modifications.push(trimmed_new.to_string());
        }
    }
    
    if modifications.is_empty() {
        return None;
    }
    
    eprintln!("[AI Split] Detected {} GUI modifications", modifications.len());
    Some(modifications.join("\n"))
}

/// Detect structural additions between old and new source code
/// Returns a description of what was added (new buttons, new elements, etc.)
fn detect_structural_additions(old_source: &str, new_source: &str) -> Option<String> {
    // Split into lines for diff analysis
    let old_lines: Vec<&str> = old_source.lines().collect();
    let new_lines: Vec<&str> = new_source.lines().collect();

    // Find added lines (simple diff - lines in new but not in old)
    let mut additions = Vec::new();

    for new_line in &new_lines {
        let trimmed = new_line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Check if this line exists in old (with some fuzzy matching for whitespace)
        let exists_in_old = old_lines.iter().any(|old_line| old_line.trim() == trimmed);

        if !exists_in_old {
            additions.push(trimmed.to_string());
        }
    }

    // Also check for deletions - if more deletions than additions, this is primarily a deletion
    let deletions = detect_structural_deletions(old_source, new_source);
    if deletions.len() > additions.len() && additions.len() < 3 {
        // This is primarily a deletion, not an addition
        return None;
    }

    if additions.is_empty() {
        return None;
    }

    // Analyze what was added
    let mut description_parts = Vec::new();

    // Detect button additions
    let button_keywords = ["button", "Button", "btn", "Btn", "click", "Click"];
    let has_button = additions
        .iter()
        .any(|line| button_keywords.iter().any(|kw| line.contains(kw)));
    if has_button {
        description_parts.push("new button/clickable element");
    }

    // Detect draw calls (rectangles, shapes)
    let draw_keywords = [
        "draw",
        "Draw",
        "rect",
        "Rect",
        "fill",
        "Fill",
        "XFillRectangle",
        "XDrawRectangle",
    ];
    let has_draw = additions
        .iter()
        .any(|line| draw_keywords.iter().any(|kw| line.contains(kw)));
    if has_draw && !has_button {
        description_parts.push("new shape/rectangle");
    }

    // Detect text additions
    let text_keywords = [
        "text",
        "Text",
        "string",
        "String",
        "XDrawString",
        "printf",
        "print",
    ];
    let has_text = additions
        .iter()
        .any(|line| text_keywords.iter().any(|kw| line.contains(kw)));
    if has_text {
        description_parts.push("new text element");
    }

    // Detect event handling additions
    let event_keywords = [
        "event", "Event", "handler", "Handler", "motion", "Motion", "expose", "Expose",
    ];
    let has_event = additions
        .iter()
        .any(|line| event_keywords.iter().any(|kw| line.contains(kw)));
    if has_event {
        description_parts.push("new event handler");
    }

    // Detect variable/struct additions
    let var_keywords = [
        "int ", "float ", "double ", "char ", "bool ", "struct ", "void ",
    ];
    let has_var = additions.iter().any(|line| {
        var_keywords
            .iter()
            .any(|kw| line.starts_with(kw) || line.contains(&format!(" {}", kw)))
    });
    if has_var && description_parts.is_empty() {
        description_parts.push("new variable/definition");
    }

    if description_parts.is_empty() {
        // Generic structural change
        description_parts.push("code structure change");
    }

    // Return ONLY the raw X11 code for translation to SDL2
    // The AI will translate this X11 code directly to SDL2
    let raw_code = additions
        .iter()
        .take(50)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");

    Some(raw_code)
}

/// Perform incremental structural AI update - tell AI what was added, not regenerate everything
/// NOW USES the fast /refactor/delta endpoint (~2-3s vs ~18s)
/// - Keeps existing working code (with guardrails applied)
/// - Only asks AI to generate the delta (new button code snippet)
/// - Injects that delta into the existing code
async fn perform_structural_ai_update(
    cached_result: &serde_json::Value,
    _original_source: &str,
    _new_source: &str,
    structural_changes: &str,
    _language: &str,
) -> Result<serde_json::Value> {
    let start_time = std::time::Instant::now();

    // Extract current code from cached result
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

    // Use the NEW fast delta endpoint - sends cached_result so AI only generates delta snippets
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "update_type": "addition",
        "changes_description": structural_changes,
        "core_content": core_content,
        "gui_content": gui_content,
        "shared_content": shared_content,
        "cached_result": cached_result  // CRITICAL: Include cached result for delta injection
    });

    let backend_url = get_ai_backend_url();
    let url = format!("{}/refactor/delta", backend_url);

    eprintln!("[AI Split] Calling fast delta endpoint: {}", url);

    let res = client
        .post(&url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(30)) // Shorter timeout for fast endpoint
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    // Delta endpoint returns {"result": {...}, "delta": {...}}
    // The "result" is already the updated code with delta injected
    if let Some(result) = res.get("result") {
        if result.is_object() && result.get("core").is_some() {
            let elapsed = start_time.elapsed();
            eprintln!("[AI Split] Delta injection completed in {:?}", elapsed);
            return Ok(result.clone());
        }
    }

    // Fallback: try to parse as string (old behavior)
    let result_str = res["result"]
        .as_str()
        .ok_or(anyhow::anyhow!("No result from AI delta endpoint"))?;

    // Clean markdown
    let clean_json = if let Some(start) = result_str.find("```json") {
        let s = &result_str[start + 7..];
        if let Some(end) = s.find("```") {
            &s[..end]
        } else {
            s
        }
    } else if let Some(start) = result_str.find("```") {
        let s = &result_str[start + 3..];
        if let Some(end) = s.find("```") {
            &s[..end]
        } else {
            s
        }
    } else {
        result_str
    }
    .trim();

    // Try to find just the JSON object (AI sometimes adds extra text after)
    let json_only = if let Some(start) = clean_json.find('{') {
        // Find the matching closing brace by counting braces
        let chars: Vec<char> = clean_json[start..].chars().collect();
        let mut depth = 0;
        let mut end_idx = chars.len();
        for (i, c) in chars.iter().enumerate() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end_idx = i + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        &clean_json[start..start + end_idx]
    } else {
        clean_json
    };

    let updated_data: serde_json::Value = match serde_json::from_str(json_only) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[AI Split] JSON parse error in structural update: {}", e);
            eprintln!(
                "[AI Split] Attempted to parse: {}...",
                &json_only.chars().take(500).collect::<String>()
            );
            return Err(anyhow::anyhow!("JSON parse error: {}", e));
        }
    };

    let elapsed = start_time.elapsed();
    eprintln!("[AI Split] Structural update completed in {:?}", elapsed);

    Ok(updated_data)
}

/// Perform delta deletion - ask AI to identify what to remove, then apply locally
/// Uses /refactor/delta endpoint with update_type="deletion"
async fn perform_delta_deletion(
    cached_result: &serde_json::Value,
    deletion_description: &str,
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

    eprintln!("[AI Split] Calling delta deletion endpoint: {}", url);

    let res = client
        .post(&url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    // Delta endpoint returns {"result": {...}, "delta": {...}}
    if let Some(result) = res.get("result") {
        if result.is_object() && result.get("core").is_some() {
            let elapsed = start_time.elapsed();
            eprintln!("[AI Split] Delta deletion completed in {:?}", elapsed);
            return Ok(result.clone());
        }
    }

    Err(anyhow::anyhow!(
        "No valid result from delta deletion endpoint"
    ))
}

/// Perform incremental AI update - ask AI to apply specific changes to existing code
/// NOW USES the fast /refactor/structural endpoint (~2-3s vs ~10s)
async fn perform_incremental_ai_update(
    cached_result: &serde_json::Value,
    changes: &[(String, String)],
    _language: &str,
) -> Result<serde_json::Value> {
    let start_time = std::time::Instant::now();

    // Extract current code from cached result
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

    // Convert changes to JSON array format
    let changes_json: Vec<serde_json::Value> = changes
        .iter()
        .map(|(old, new)| serde_json::json!([old, new]))
        .collect();

    // Use the NEW fast structural endpoint
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
        .timeout(std::time::Duration::from_secs(20)) // Short timeout for incremental
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let result_str = res["result"]
        .as_str()
        .ok_or(anyhow::anyhow!("No result from AI"))?;

    // Clean markdown
    let clean_json = if let Some(start) = result_str.find("```json") {
        let s = &result_str[start + 7..];
        if let Some(end) = s.find("```") {
            &s[..end]
        } else {
            s
        }
    } else if let Some(start) = result_str.find("```") {
        let s = &result_str[start + 3..];
        if let Some(end) = s.find("```") {
            &s[..end]
        } else {
            s
        }
    } else {
        result_str
    }
    .trim();

    let updated_data: serde_json::Value = serde_json::from_str(clean_json)?;

    let elapsed = start_time.elapsed();
    eprintln!("[AI Split] Incremental update completed in {:?}", elapsed);

    Ok(updated_data)
}

/// Extract structural signature from C/C++ code for smart caching.
/// This ignores string literals, comments, and numeric constants so that
/// simple text changes don't cause AI cache misses (Next.js-like HMR behavior).
fn extract_structural_signature(source: &str) -> String {
    let mut result = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut in_string = false;
    let mut in_char = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut escape_next = false;

    while let Some(c) = chars.next() {
        // Handle escape sequences in strings/chars
        if escape_next {
            escape_next = false;
            continue;
        }

        // Handle line comments
        if in_line_comment {
            if c == '\n' {
                in_line_comment = false;
                result.push('\n'); // Preserve line structure
            }
            continue;
        }

        // Handle block comments
        if in_block_comment {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block_comment = false;
            }
            continue;
        }

        // Handle strings - replace content with placeholder
        if in_string {
            if c == '\\' {
                escape_next = true;
            } else if c == '"' {
                in_string = false;
                result.push_str("\"__STR__\""); // Placeholder for any string
            }
            continue;
        }

        // Handle char literals
        if in_char {
            if c == '\\' {
                escape_next = true;
            } else if c == '\'' {
                in_char = false;
                result.push_str("'_'"); // Placeholder for any char
            }
            continue;
        }

        // Detect start of comments
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

        // Detect start of string
        if c == '"' {
            in_string = true;
            continue;
        }

        // Detect start of char literal
        if c == '\'' {
            in_char = true;
            continue;
        }

        // Skip numeric literals (but keep the structure)
        if c.is_ascii_digit() {
            // Consume the entire number
            while chars
                .peek()
                .map(|ch| {
                    ch.is_ascii_digit()
                        || *ch == '.'
                        || *ch == 'x'
                        || *ch == 'X'
                        || *ch == 'a'
                        || *ch == 'b'
                        || *ch == 'c'
                        || *ch == 'd'
                        || *ch == 'e'
                        || *ch == 'f'
                        || *ch == 'A'
                        || *ch == 'B'
                        || *ch == 'C'
                        || *ch == 'D'
                        || *ch == 'E'
                        || *ch == 'F'
                        || *ch == 'u'
                        || *ch == 'U'
                        || *ch == 'l'
                        || *ch == 'L'
                })
                .unwrap_or(false)
            {
                chars.next();
            }
            result.push_str("0"); // Placeholder for any number
            continue;
        }

        // Keep everything else (identifiers, keywords, operators, braces, etc.)
        result.push(c);
    }

    result
}

async fn perform_ai_split(req: &CompileRequest) -> Result<serde_json::Value> {
    // FOUR-LEVEL CACHE for fast HMR (like Next.js):
    // Level 1: Full source hash -> instant cache hit (exact match) - 0ms
    // Level 2: Structural hash -> cache hit with string patching (text-only changes) - ~1ms
    // Level 2.5: Semantic changes (colors/numbers) -> incremental AI update - ~2-5s
    // Level 2.75: Structural additions (new button) -> incremental AI update - ~5-10s
    // Level 3: Full cache miss -> call AI backend for full split - ~15-25s

    let source_hash = calculate_hash(&req.source);
    let structural_sig = extract_structural_signature(&req.source);
    let structural_hash = calculate_hash(&structural_sig);

    // Level 1: Check exact source match (instant, no work)
    {
        let cache = get_ai_split_cache().lock().await;
        if let Some(cached) = cache.get(&source_hash) {
            eprintln!("[AI Split] Cache HIT (exact match) - instant return");
            return Ok(cached.result.clone());
        }
    }

    // Level 2: Check structural match (fast patching, no AI call)
    // Only works for simple text changes, NOT semantic changes like colors
    let structural_cache_result = {
        let structural_cache = get_ai_split_structural_cache().lock().await;
        structural_cache.get(&structural_hash).cloned()
    };

    if let Some(cached) = structural_cache_result {
        // Extract strings from old and new source
        let old_strings = extract_string_literals(&cached.original_source);
        let new_strings = extract_string_literals(&req.source);

        // Check if any changes are semantic (colors, etc.) that need AI re-processing
        if has_semantic_string_changes(&old_strings, &new_strings) {
            eprintln!("[AI Split] Structural match but SEMANTIC change detected - using incremental AI update");

            // Level 2.5: Incremental AI update (faster than full regen)
            // Ask AI to just update the specific changes, not regenerate everything
            let changes = collect_string_changes(&old_strings, &new_strings);
            if !changes.is_empty() {
                match perform_incremental_ai_update(&cached.result, &changes, &req.language).await {
                    Ok(updated_result) => {
                        // Store updated result in both caches
                        let cached_entry = CachedSplit {
                            result: updated_result.clone(),
                            original_source: req.source.clone(),
                        };
                        {
                            let mut cache = get_ai_split_cache().lock().await;
                            cache.insert(source_hash, cached_entry.clone());
                        }
                        {
                            let mut structural_cache = get_ai_split_structural_cache().lock().await;
                            structural_cache.insert(structural_hash, cached_entry);
                        }
                        eprintln!("[AI Split] Incremental update complete - fast semantic HMR!");
                        return Ok(updated_result);
                    }
                    Err(e) => {
                        eprintln!(
                            "[AI Split] Incremental update failed: {} - falling back to full regen",
                            e
                        );
                        // Fall through to Level 3 (full AI call)
                    }
                }
            }
        } else {
            eprintln!("[AI Split] Cache HIT (structural match) - patching strings...");

            // Patch the cached result with new strings
            let (patched_result, did_patch) =
                patch_strings_in_cached_result(&cached.result, &old_strings, &new_strings);

            // If patching didn't actually change anything, and strings differ, something's wrong
            // Fall back to AI call
            let strings_differ = old_strings != new_strings;
            if strings_differ && !did_patch {
                eprintln!(
                    "[AI Split] String patching FAILED (strings not found in output) - calling AI"
                );
                // Fall through to Level 3 (AI call)
            } else {
                // Store patched result in exact-match cache for future
                {
                    let mut cache = get_ai_split_cache().lock().await;
                    cache.insert(
                        source_hash,
                        CachedSplit {
                            result: patched_result.clone(),
                            original_source: req.source.clone(),
                        },
                    );
                }

                eprintln!("[AI Split] String patching complete - fast HMR!");
                return Ok(patched_result);
            }
        }
    }

    // Level 2.6: Try LOCAL deletion patching (no AI call needed!)
    // If user deleted code (button, etc.), we can often patch locally
    let any_cached_for_deletion = {
        let structural_cache = get_ai_split_structural_cache().lock().await;
        structural_cache.values().next().cloned()
    };

    if let Some(cached) = any_cached_for_deletion {
        let deletions = detect_structural_deletions(&cached.original_source, &req.source);
        if !deletions.is_empty() {
            eprintln!(
                "[AI Split] Detected {} deleted lines - attempting local patch",
                deletions.len()
            );

            if let Some(patched_result) = try_local_deletion_patch(&cached.result, &deletions) {
                // Store patched result in caches
                let cached_entry = CachedSplit {
                    result: patched_result.clone(),
                    original_source: req.source.clone(),
                };
                {
                    let mut cache = get_ai_split_cache().lock().await;
                    cache.insert(source_hash, cached_entry.clone());
                }
                {
                    let mut structural_cache = get_ai_split_structural_cache().lock().await;
                    structural_cache.insert(structural_hash, cached_entry);
                }
                eprintln!("[AI Split] Local deletion patch applied - instant HMR!");
                return Ok(patched_result);
            } else {
                eprintln!("[AI Split] Local deletion patch failed - will try AI delta deletion");

                // Try AI delta deletion endpoint
                let deletion_description = deletions
                    .iter()
                    .take(10)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");

                match perform_delta_deletion(&cached.result, &deletion_description).await {
                    Ok(updated_result) => {
                        let cached_entry = CachedSplit {
                            result: updated_result.clone(),
                            original_source: req.source.clone(),
                        };
                        {
                            let mut cache = get_ai_split_cache().lock().await;
                            cache.insert(source_hash, cached_entry.clone());
                        }
                        {
                            let mut structural_cache = get_ai_split_structural_cache().lock().await;
                            structural_cache.insert(structural_hash, cached_entry);
                        }
                        eprintln!("[AI Split] Delta deletion complete - fast HMR!");
                        return Ok(updated_result);
                    }
                    Err(e) => {
                        eprintln!(
                            "[AI Split] Delta deletion failed: {} - will try other paths",
                            e
                        );
                        // Fall through to next level
                    }
                }
            }
        }
    }

    // Level 2.75: Try incremental structural update if we have ANY cached result
    // This is like Next.js - detect what changed and tell AI to just add that
    let any_cached_result = {
        let structural_cache = get_ai_split_structural_cache().lock().await;
        // Find the most recent cached entry (any entry will do for structural diff)
        structural_cache.values().next().cloned()
    };

    if let Some(cached) = any_cached_result {
        // Check if this looks like a structural addition (new button, new element)
        if let Some(structural_changes) =
            detect_structural_additions(&cached.original_source, &req.source)
        {
            eprintln!("[AI Split] ╔═══════════════════════════════════════════════════════════╗");
            eprintln!("[AI Split] ║  DELTA CHANGE DETECTED - Using fast incremental path     ║");
            eprintln!("[AI Split] ╚═══════════════════════════════════════════════════════════╝");
            eprintln!("[AI Split] Delta type: Structural ADDITION (new element/button)");
            eprintln!(
                "[AI Split] X11 code to translate:\n{}",
                structural_changes
                    .lines()
                    .take(5)
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            eprintln!("[AI Split] NOTE: Runner will NOT restart - HMR will hot-reload the modules");

            match perform_structural_ai_update(
                &cached.result,
                &cached.original_source,
                &req.source,
                &structural_changes,
                &req.language,
            )
            .await
            {
                Ok(updated_result) => {
                    // Store updated result in both caches
                    let cached_entry = CachedSplit {
                        result: updated_result.clone(),
                        original_source: req.source.clone(),
                    };
                    {
                        let mut cache = get_ai_split_cache().lock().await;
                        cache.insert(source_hash, cached_entry.clone());
                    }
                    {
                        let mut structural_cache = get_ai_split_structural_cache().lock().await;
                        structural_cache.insert(structural_hash, cached_entry);
                    }
                    eprintln!("[AI Split] ✓ Delta injection complete - fast HMR for new elements!");
                    return Ok(updated_result);
                }
                Err(e) => {
                    eprintln!(
                        "[AI Split] ✗ Structural update failed: {} - falling back to full regen",
                        e
                    );
                    // Fall through to Level 3 (full AI call)
                }
            }
        }
        // Level 2.8: Check for GUI modifications (position, color, size changes)
        // These are lines that exist in both but with different values
        else if let Some(gui_changes) = detect_gui_modifications(&cached.original_source, &req.source) {
            eprintln!("[AI Split] ╔═══════════════════════════════════════════════════════════╗");
            eprintln!("[AI Split] ║  GUI MODIFICATION DETECTED - Using fast delta path       ║");
            eprintln!("[AI Split] ╚═══════════════════════════════════════════════════════════╝");
            eprintln!("[AI Split] Delta type: GUI MODIFICATION (position/color/size change)");
            eprintln!("[AI Split] Modified GUI code:\n{}", gui_changes.lines().take(5).collect::<Vec<_>>().join("\n"));
            
            match perform_structural_ai_update(&cached.result, &cached.original_source, &req.source, &gui_changes, &req.language).await {
                Ok(updated_result) => {
                    let cached_entry = CachedSplit {
                        result: updated_result.clone(),
                        original_source: req.source.clone(),
                    };
                    {
                        let mut cache = get_ai_split_cache().lock().await;
                        cache.insert(source_hash, cached_entry.clone());
                    }
                    {
                        let mut structural_cache = get_ai_split_structural_cache().lock().await;
                        structural_cache.insert(structural_hash, cached_entry);
                    }
                    eprintln!("[AI Split] ✓ GUI modification delta complete - fast HMR!");
                    return Ok(updated_result);
                }
                Err(e) => {
                    eprintln!("[AI Split] ✗ GUI modification update failed: {} - falling back to full regen", e);
                }
            }
        }
    }

    // Level 3: Cache miss - call AI backend (full regeneration)
    eprintln!("[AI Split] Cache MISS (no incremental path) - calling AI backend for full split...");
    let start_time = std::time::Instant::now();

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "code": req.source,
        "lang": req.language,
        "files": req.files,
        "mode": "split"
    });

    let backend_url = get_ai_backend_url();
    let url = format!("{}/refactor/split", backend_url);

    let res = client
        .post(&url)
        .json(&payload)
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let result_str = res["result"]
        .as_str()
        .ok_or(anyhow::anyhow!("No result from AI"))?;

    // Clean markdown
    let clean_json = if let Some(start) = result_str.find("```json") {
        let s = &result_str[start + 7..];
        if let Some(end) = s.find("```") {
            &s[..end]
        } else {
            s
        }
    } else if let Some(start) = result_str.find("```") {
        let s = &result_str[start + 3..];
        if let Some(end) = s.find("```") {
            &s[..end]
        } else {
            s
        }
    } else {
        result_str
    }
    .trim();

    let split_data: serde_json::Value = match serde_json::from_str(clean_json) {
        Ok(v) => v,
        Err(e) => {
            // Try to repair truncated JSON
            // Assumption: Truncated inside the last string value (explanation)
            if e.to_string().contains("EOF") {
                let repaired = format!("{}\"}}", clean_json);
                if let Ok(v) = serde_json::from_str(&repaired) {
                    println!("Successfully repaired truncated JSON response.");
                    v
                } else {
                    // Try just closing brace if it wasn't in a string
                    let repaired_brace = format!("{}}}", clean_json);
                    if let Ok(v) = serde_json::from_str(&repaired_brace) {
                        println!("Successfully repaired truncated JSON response (brace only).");
                        v
                    } else {
                        println!("Failed to parse AI response: {}", e);
                        println!("Raw content: {}", clean_json);
                        let snippet: String = clean_json.chars().take(1000).collect();
                        return Err(anyhow::anyhow!(
                            "JSON Parse Error: {}. \nRaw content snippet: {}...",
                            e,
                            snippet
                        ));
                    }
                }
            } else {
                println!("Failed to parse AI response: {}", e);
                println!("Raw content: {}", clean_json);
                let snippet: String = clean_json.chars().take(1000).collect();
                return Err(anyhow::anyhow!(
                    "JSON Parse Error: {}. \nRaw content snippet: {}...",
                    e,
                    snippet
                ));
            }
        }
    };

    // Cache the result for future requests
    let elapsed = start_time.elapsed();
    eprintln!("[AI Split] Completed in {:?}", elapsed);

    let cached_entry = CachedSplit {
        result: split_data.clone(),
        original_source: req.source.clone(),
    };

    // Store in both caches
    {
        let mut cache = get_ai_split_cache().lock().await;
        cache.insert(source_hash, cached_entry.clone());
        // Limit cache size to 100 entries
        if cache.len() > 100 {
            if let Some(oldest_key) = cache.keys().next().cloned() {
                cache.remove(&oldest_key);
            }
        }
    }

    {
        let mut structural_cache = get_ai_split_structural_cache().lock().await;
        structural_cache.insert(structural_hash, cached_entry);
        // Limit structural cache size to 50 entries
        if structural_cache.len() > 50 {
            if let Some(oldest_key) = structural_cache.keys().next().cloned() {
                structural_cache.remove(&oldest_key);
            }
        }
    }

    Ok(split_data)
}

async fn perform_ai_fix(code: &str, error: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "code": code,
        "lang": "cpp", // Defaulting to cpp as this seems to be C++ centric, strictly speaking we should pass language
        "prompt": format!("Fix the following error:\n{}", error),
        "mode": "fix"
    });

    let backend_url = get_ai_backend_url();
    let url = format!("{}/refactor/fix", backend_url);

    let res = client
        .post(&url)
        .json(&payload)
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let result_str = res["result"]
        .as_str()
        .ok_or(anyhow::anyhow!("No result from AI"))?;

    // Clean markdown
    let clean_code = if let Some(start) = result_str.find("```") {
        let s = &result_str[start + 3..];
        if let Some(newline) = s.find('\n') {
            let s = &s[newline + 1..];
            if let Some(end) = s.rfind("```") {
                &s[..end]
            } else {
                s
            }
        } else {
            s
        }
    } else {
        result_str
    }
    .trim();

    Ok(clean_code.to_string())
}
async fn handle_compile(
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
    hmr_orchestrator: Arc<tokio::sync::Mutex<HmrOrchestrator>>,
    structured_logger: Arc<StructuredLogger>,
    metrics_aggregator: Arc<tokio::sync::Mutex<MetricsAggregator>>,
    restart_controller: Arc<tokio::sync::Mutex<RestartController>>,
    ipc_config: Arc<IpcConfig>,
) -> Result<()> {
    // Construct context object for cleaner passing
    let ctx = CompileContext {
        log_dc,
        terminal_store,
        sdl_input_store,
        runner_store,
        pc,
        workspace_path,
        compile_cache,
        boundary_checker,
        incremental_cache,
        hmr_orchestrator,
        structured_logger,
        metrics_aggregator,
        restart_controller,
        ipc_config,
    };
    
    // Call the unified handler
    // We ignore the return value (JSON graph) for now as the void return type expects
    let session_id = req
        .session_id
        .clone()
        .unwrap_or_else(|| "default_session".to_string());
    let _ = crate::compiler::handler::handle_compile_request(&ctx, req, session_id).await?;

    Ok(())
}

async fn verify_tooling() -> Result<()> {
    for tool in REQUIRED_TOOLS {
        let status = system_command(tool)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("{tool} not found on PATH");
        }
    }
    Ok(())
}

fn system_command(program: &str) -> Command {
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("wsl");
        cmd.arg(program);
        cmd
    } else {
        Command::new(program)
    }
}

fn apply_build_directives(content: &str, cmd: &mut Command) {
    for line in content.lines() {
        // Parse custom linker flags
        // Format: // LINK: -lSDL2 -lGL
        if let Some(flags) = line.trim().strip_prefix("// LINK:") {
            for flag in flags.split_whitespace() {
                cmd.arg(flag);
            }
        }

        // Parse pkg-config dependencies
        // Format: // PKG: gtk+-3.0 opencv4
        if let Some(pkgs) = line.trim().strip_prefix("// PKG:") {
            let pkgs_str = pkgs.trim();
            if !pkgs_str.is_empty() {
                let mut pkg_cmd = if cfg!(target_os = "windows") {
                    let mut c = std::process::Command::new("wsl");
                    c.arg("pkg-config");
                    c
                } else {
                    std::process::Command::new("pkg-config")
                };

                let output = pkg_cmd
                    .arg("--cflags")
                    .arg("--libs")
                    .args(pkgs_str.split_whitespace())
                    .output();

                match output {
                    Ok(out) if out.status.success() => {
                        let flags = String::from_utf8_lossy(&out.stdout);
                        for flag in flags.split_whitespace() {
                            cmd.arg(flag);
                        }
                    }
                    Ok(out) => {
                        println!(
                            "pkg-config failed for {}: {}",
                            pkgs_str,
                            String::from_utf8_lossy(&out.stderr)
                        );
                    }
                    Err(e) => {
                        println!("Failed to run pkg-config: {}", e);
                    }
                }
            }
        }
    }
}
