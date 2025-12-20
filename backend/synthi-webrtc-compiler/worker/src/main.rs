use std::sync::Arc;
use std::process::Stdio;
use std::collections::HashMap;
use std::env;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

mod builder;
mod watcher;
mod server;
mod storage;
mod capability;
mod shim;
mod host_kv;
mod plugin_contract;
mod incremental_cache;
mod state_diff;
mod binary_state;
mod crash_recovery;
mod error_parser;
pub mod source_map;
mod fast_refresh;
mod boundary;
mod abi_version;
mod loader;
mod supervisor;
mod state_manager;
mod reload_manager;

use builder::{RebuildScope, ModuleHashes, hash_content, WidgetDetector, WidgetCompiler};
use fast_refresh::{BoundaryChecker, RefreshAction, BoundaryViolationEvent};
use watcher::{PreemptiveConfig, PreemptiveMessage, SpeculativeCache};
use error_parser::{parse_compiler_output, CompilerType, DiagnosticEvent};
use capability::{detect_capabilities, HmrCapability, HmrStatus};
use shim::{auto_shim, ShimMode, detect_shim_mode};
#[allow(unused_imports)]
use incremental_cache::{IncrementalCache, compile_with_cache, link_objects};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

use anyhow::{Context, Result};
use futures::{FutureExt, StreamExt, SinkExt};
use serde::{Deserialize, Serialize};
use tempfile::tempdir;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader, AsyncWriteExt};
use chrono::Utc;
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::sdp::sdp_type::RTCSdpType;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTPCodecType, RTCRtpCodecParameters};
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use webrtc::rtp::packet::Packet;
use webrtc::util::marshal::Unmarshal;
use bytes::Bytes;

#[derive(Debug, Deserialize)]
struct IceServerEnv {
    urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential: Option<String>,
}

const REQUIRED_TOOLS: &[&str] = &["g++", "rustc", "tsc", "clangd"];
const GUI_TOOLS: &[&str] = &["xdotool", "Xvfb", "matchbox-window-manager"]; // Keeping these for now as SDL2 might use Xvfb on Linux

#[derive(Debug, Serialize, Deserialize)]
struct SignalMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sdp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sdp_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    candidate: Option<RTCIceCandidateInit>,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileEntry {
    name: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct CompileRequest {
    language: String,
    filename: String,
    source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(default)]
    files: Vec<FileEntry>,
    #[serde(default)]
    is_gui: bool,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    supports_h265: Option<bool>,
    #[serde(default)]
    use_ai_split: bool,
}

#[allow(dead_code)]
struct RunnerState {
    process: Option<tokio::process::Child>, // Option to allow taking it if needed, or just drop
    stdin: tokio::process::ChildStdin,
    output_tx: tokio::sync::broadcast::Sender<String>,
    is_gui: bool,
    is_hmr_capable: bool, // True if runner was started with HMR-capable code (detected from exports)
    hmr_capability: Option<capability::HmrCapability>, // Detailed capability level
    xvfb_process: Option<tokio::process::Child>,
    gst_pipeline: Option<gst::Pipeline>,
    sdl_tx: Option<mpsc::UnboundedSender<String>>,
    video_track: Option<Arc<TrackLocalStaticRTP>>,
    audio_track: Option<Arc<TrackLocalStaticRTP>>,
    width: u32,
    height: u32,
    wsl_display_str: String,
    gst_display_str: String,
    // Module hashes for differential rebuild
    module_hashes: ModuleHashes,
    // Loaded module paths (for determining what to reload)
    loaded_core_path: Option<String>,
    loaded_gui_path: Option<String>,
    // Widget-level compilation state
    loaded_widget_paths: HashMap<String, String>, // widget_id -> so_path
    widget_hashes: HashMap<String, u64>,          // widget_id -> content_hash
}

struct LspSessionState {
    client_root_uri: Option<String>,
    server_root_uri: String,
}

fn rewrite_uris(val: &mut serde_json::Value, state: &LspSessionState, to_server: bool) {
    if let Some(client_uri) = &state.client_root_uri {
        let (from, to) = if to_server {
            (client_uri.as_str(), state.server_root_uri.as_str())
        } else {
            (state.server_root_uri.as_str(), client_uri.as_str())
        };
        
        match val {
            serde_json::Value::String(s) => {
                if s.starts_with(from) {
                    let suffix = &s[from.len()..];
                    
                    // Fix double slash issue: if 'to' ends with '/' and suffix starts with '/', strip one.
                    let clean_suffix = if to.ends_with('/') && suffix.starts_with('/') {
                        &suffix[1..]
                    } else {
                        suffix
                    };

                    let sep = if !to.ends_with('/') && !clean_suffix.starts_with('/') && !clean_suffix.is_empty() {
                        "/"
                    } else {
                        ""
                    };
                    *s = format!("{}{}{}", to, sep, clean_suffix);
                }
            }
            serde_json::Value::Array(arr) => {
                for v in arr {
                    rewrite_uris(v, state, to_server);
                }
            }
            serde_json::Value::Object(map) => {
                for (_, v) in map {
                    rewrite_uris(v, state, to_server);
                }
            }
            _ => {}
        }
    }
}

fn make_chunks(data: &[u8], msg_id: u32) -> Vec<Vec<u8>> {
    let chunk_size = 60000; 
    let total_len = data.len();
    let total_chunks = (total_len + chunk_size - 1) / chunk_size;
    let mut chunks = Vec::new();

    for (i, chunk_slice) in data.chunks(chunk_size).enumerate() {
        let mut packet = Vec::with_capacity(16 + chunk_slice.len());
        packet.extend_from_slice(b"CHNK");
        packet.extend_from_slice(&msg_id.to_be_bytes());
        packet.extend_from_slice(&(i as u32).to_be_bytes());
        packet.extend_from_slice(&(total_chunks as u32).to_be_bytes());
        packet.extend_from_slice(chunk_slice);
        chunks.push(packet);
    }
    chunks
}

#[tokio::main]
async fn main() -> Result<()> {
    println!("Worker starting...");
    println!("Operating System: {}", std::env::consts::OS);
    gst::init()?;
    verify_tooling().await?;
    let (ws_stream, _) = connect_async("ws://localhost:9000").await?;
    let (mut ws_write, mut ws_read) = ws_stream.split();
    let (signal_tx, mut signal_rx) = mpsc::unbounded_channel::<SignalMessage>();

    ws_write
        .send(Message::text(
            serde_json::to_string(&SignalMessage {
                msg_type: "register".into(),
                role: Some("worker".into()),
                sdp: None,
                sdp_type: None,
                candidate: None,
            })?,
        ))
        .await?;

    tokio::spawn(async move {
        while let Some(msg) = signal_rx.recv().await {
            if let Ok(text) = serde_json::to_string(&msg) {
                let _ = ws_write.send(Message::text(text)).await;
            }
        }
    });

    let pc = create_peer(signal_tx.clone()).await?;
    let log_channel_store: Arc<Mutex<Option<Arc<RTCDataChannel>>>> = Arc::new(Mutex::new(None));
    let compile_store = log_channel_store.clone();
    // Store of sessionId -> stdin sender so datachannel 'terminal' messages can be
    // routed to the running process's stdin.
    let terminal_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>> = Arc::new(Mutex::new(HashMap::new()));
    // Store of sessionId -> sdl input sender for persistent SDL input
    let sdl_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>> = Arc::new(Mutex::new(HashMap::new()));
    // Store for persistent runner process
    let runner_store: Arc<Mutex<Option<RunnerState>>> = Arc::new(Mutex::new(None));
    // Simple in-memory cache for tracking compiled lib paths (legacy, used alongside IncrementalCache)
    let compile_cache: Arc<Mutex<HashMap<String, (u64, String)>>> = Arc::new(Mutex::new(HashMap::new()));
    
    // Content-addressable incremental compilation cache (persists across sessions)
    // Uses /dev/shm on Linux for fast RAM-based caching
    let cache_dir = if cfg!(target_os = "linux") {
        std::path::PathBuf::from("/dev/shm/synthi_compile_cache")
    } else {
        std::env::temp_dir().join("synthi_compile_cache")
    };
    let incremental_cache = Arc::new(IncrementalCache::new(cache_dir).await
        .expect("Failed to initialize incremental compile cache"));
    eprintln!("[Cache] Initialized content-addressable compile cache");
    
    // Speculative compilation cache for preemptive builds
    let speculative_cache: Arc<Mutex<SpeculativeCache>> = Arc::new(Mutex::new(SpeculativeCache::new(32)));
    
    // Fast Refresh boundary checker (per-session)
    let boundary_checker: Arc<Mutex<BoundaryChecker>> = Arc::new(Mutex::new(BoundaryChecker::new()));

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
        preemptive_config
    ).context("Failed to setup preemptive watcher")?;
    
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
                    PreemptiveMessage::StartSpeculative { paths, scope, timestamp: _timestamp } => {
                        eprintln!("[Build] Starting speculative compile for scope '{}': {:?}", scope, paths);
                        
                        // Check cancellation flag periodically during compile
                        if build_cancel_flag.load(Ordering::SeqCst) {
                            eprintln!("[Build] Speculative compile cancelled before start");
                            continue;
                        }
                        
                        // Perform speculative compilation
                        let start = Instant::now();
                        for path_str in &paths {
                            let path = std::path::Path::new(&path_str);
                            let relative_path = if let Ok(rel) = path.strip_prefix(&build_session.workspace_root) {
                                rel.to_string_lossy().to_string()
                            } else {
                                path_str.clone()
                            };
                            
                            // Check for cancellation between files
                            if build_cancel_flag.load(Ordering::SeqCst) {
                                eprintln!("[Build] Speculative compile cancelled during compilation");
                                break;
                            }
                            
                            // Do incremental compile but don't send update yet
                            if let Some(_payload) = build_session.incremental_compile(vec![relative_path.clone()]) {
                                // Cache the speculative result
                                let _content_hash = {
                                    let mut hasher = std::collections::hash_map::DefaultHasher::new();
                                    relative_path.hash(&mut hasher);
                                    hasher.finish()
                                };
                                
                                // Store in speculative cache (blocking mutex)
                                // Note: In production, use a lock-free structure
                                eprintln!("[Build] Speculative compile complete in {}ms, cached", 
                                    start.elapsed().as_millis());
                            }
                        }
                    }
                    
                    PreemptiveMessage::CancelSpeculative { reason } => {
                        eprintln!("[Build] Speculative compile cancelled: {}", reason);
                        // Cancel flag is already set by watcher
                    }
                    
                    PreemptiveMessage::CommitSpeculative { paths, scope } => {
                        eprintln!("[Build] Committing speculative compile for scope '{}': {:?}", scope, paths);
                        
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
                        eprintln!("[Build] Standard compile for scope '{}': {:?}", scope, paths);
                        
                        for path_str in paths {
                            let path = std::path::Path::new(&path_str);
                            let relative_path = if let Ok(rel) = path.strip_prefix(&build_session.workspace_root) {
                                rel.to_string_lossy().to_string()
                            } else {
                                path_str
                            };

                            if let Some(payload) = build_session.incremental_compile(vec![relative_path]) {
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

    let term_store = terminal_input_store.clone();
    let pc_clone = pc.clone();
    let workspace_path_for_callback = workspace_path_arc.clone();
    let runner_store_for_callback = runner_store.clone();
    let compile_cache_for_callback = compile_cache.clone();
    let boundary_checker_for_callback = boundary_checker.clone();
    let incremental_cache_for_callback = incremental_cache.clone();
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let store = compile_store.clone();
        let term_store = term_store.clone();
        let pc_for_callback = pc_clone.clone();
        let workspace_path_for_dc = workspace_path_for_callback.clone();
        let sdl_store_outer = sdl_input_store.clone();
        let runner_store_outer = runner_store_for_callback.clone();
        let compile_cache_outer = compile_cache_for_callback.clone();
        let boundary_checker_outer = boundary_checker_for_callback.clone();
        let incremental_cache_outer = incremental_cache_for_callback.clone();
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
                        let compile_cache = compile_cache_outer.clone();
                        let boundary_checker = boundary_checker_outer.clone();
                        let incremental_cache = incremental_cache_outer.clone();
                        async move {
                            if msg.is_string {
                                // Try to parse as a CompileRequest
                                if let Ok(req) = serde_json::from_slice::<CompileRequest>(&msg.data) {
                                    eprintln!("[Main] Received CompileRequest: is_gui={}, use_ai_split={}, lang={}", 
                                        req.is_gui, req.use_ai_split, req.language);
                                    let log_dc = { store.lock().await.clone() };
                                    if let Some(log) = log_dc {
                                        let ts = term_store_for_msg.clone();
                                        let sdls = sdl_store.clone();
                                        let rs = runner_store.clone();
                                        let pc_clone = pc_for_compile.clone();
                                        let wp = workspace_path_for_compile.clone();
                                        let cc = compile_cache.clone();
                                        let bc = boundary_checker.clone();
                                        let ic = incremental_cache.clone();
                                        tokio::spawn(handle_compile(req, log, ts, sdls, rs, pc_clone, wp.to_path_buf(), cc, bc, ic));
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
                    dc.on_message(Box::new(move |msg| {
                        let term_store_for_msg = term_store.clone();
                        let sdl_store = sdl_store_for_msg.clone();
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
                                    }
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
        }
        .boxed()
    }));

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
                    let mut desc = RTCSessionDescription::default();
                    desc.sdp_type = sdp_type;
                    desc.sdp = sdp;
                    pc.set_remote_description(desc).await?;
                    let answer = pc.create_answer(None).await?;
                    pc.set_local_description(answer.clone()).await?;
                    signal_tx.send(SignalMessage {
                        msg_type: "answer".into(),
                        role: None,
                        sdp: Some(answer.sdp),
                        sdp_type: Some(answer.sdp_type.to_string()),
                        candidate: None,
                    })?;
                }
            }
            "candidate" => {
                if let Some(c) = parsed.candidate {
                    let _ = pc.add_ice_candidate(c).await;
                }
            }
            _ => {}
        }
    }

    Ok(())
}

async fn create_peer(signal_tx: mpsc::UnboundedSender<SignalMessage>) -> Result<Arc<RTCPeerConnection>> {
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
                rtcp_feedback: vec![],
            },
            payload_type: 96,
            ..Default::default()
        },
        RTPCodecType::Video,
    );

    let api = APIBuilder::new().with_media_engine(m).build();
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
                eprintln!("Failed to parse COMPILER_ICE_SERVERS - falling back to default STUN: {}", e);
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
    pc.add_transceiver_from_kind(RTPCodecType::Video, Some(RTCRtpTransceiverInit {
        direction: RTCRtpTransceiverDirection::Sendonly,
        send_encodings: vec![],
    })).await?;
    
    pc.add_transceiver_from_kind(RTPCodecType::Audio, Some(RTCRtpTransceiverInit {
        direction: RTCRtpTransceiverDirection::Sendonly,
        send_encodings: vec![],
    })).await?;

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

// Cache for AI split results to avoid redundant API calls
// Two-level cache: 
//   1. Full source hash -> instant hit (no patching needed)
//   2. Structural hash -> hit with string patching (fast, no AI call)
use std::sync::OnceLock;

#[derive(Clone)]
struct CachedSplit {
    result: serde_json::Value,
    original_source: String,  // Store original source for string extraction
}

static AI_SPLIT_CACHE: OnceLock<tokio::sync::Mutex<std::collections::HashMap<u64, CachedSplit>>> = OnceLock::new();
// Secondary cache keyed by structural hash for string-patching hits
static AI_SPLIT_STRUCTURAL_CACHE: OnceLock<tokio::sync::Mutex<std::collections::HashMap<u64, CachedSplit>>> = OnceLock::new();

fn get_ai_split_cache() -> &'static tokio::sync::Mutex<std::collections::HashMap<u64, CachedSplit>> {
    AI_SPLIT_CACHE.get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
}

fn get_ai_split_structural_cache() -> &'static tokio::sync::Mutex<std::collections::HashMap<u64, CachedSplit>> {
    AI_SPLIT_STRUCTURAL_CACHE.get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
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
            if c == '\\' { escape_next = true; }
            else if c == '\'' { in_char = false; }
            continue;
        }
        
        // Detect start of constructs
        if c == '/' {
            if chars.peek() == Some(&'/') { chars.next(); in_line_comment = true; continue; }
            if chars.peek() == Some(&'*') { chars.next(); in_block_comment = true; continue; }
        }
        if c == '"' { in_string = true; continue; }
        if c == '\'' { in_char = true; continue; }
    }
    
    strings
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
        "black", "white", "red", "green", "blue", "yellow", "cyan", "magenta",
        "orange", "purple", "pink", "brown", "gray", "grey", "navy", "teal",
        "lime", "aqua", "maroon", "olive", "silver", "fuchsia",
    ];
    
    let lower = s.to_lowercase();
    color_names.iter().any(|c| lower == *c)
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
                let multi_decl_re = regex::Regex::new(r"\b(int|unsigned|char|short|long)\s+([^;]+);").ok();
                
                if let Some(mre) = multi_decl_re {
                    for cap in mre.captures_iter(body_str) {
                        if let (Some(type_match), Some(decls_match)) = (cap.get(1), cap.get(2)) {
                            let field_type = type_match.as_str().to_string();
                            let decls_str = decls_match.as_str();
                            
                            // Split by comma and parse each field
                            for decl in decls_str.split(',') {
                                let decl = decl.trim();
                                if decl.is_empty() { continue; }
                                
                                // Parse "name = value" or just "name"
                                let parts: Vec<&str> = decl.splitn(2, '=').collect();
                                let field_name = parts[0].trim().to_string();
                                
                                // Skip internal fields
                                if field_name.starts_with("_") || 
                                   field_name == "magic" || 
                                   field_name == "struct_size" ||
                                   field_name == "abi_version" ||
                                   field_name.is_empty() {
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
    prefix: &str
) -> String {
    crate::binary_state::generate_msgpack_serialization_code_with_defaults(fields, prefix)
}

/// Detect structural DELETIONS between old and new source code
/// Returns lines that were removed
fn detect_structural_deletions(old_source: &str, new_source: &str) -> Vec<String> {
    let old_lines: Vec<&str> = old_source.lines().collect();
    let new_lines: Vec<&str> = new_source.lines().collect();
    
    let mut deletions = Vec::new();
    
    for old_line in &old_lines {
        let trimmed = old_line.trim();
        if trimmed.is_empty() { continue; }
        
        let exists_in_new = new_lines.iter().any(|new_line| {
            new_line.trim() == trimmed
        });
        
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
    let core_content = cached_result.get("core")
        .and_then(|c| c.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let gui_content = cached_result.get("gui")
        .and_then(|g| g.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let shared_content = cached_result.get("shared")
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
        if deletion.len() < 3 { continue; }
        
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
                    new_shared = new_shared.replace(&field_pattern, &format!("// REMOVED: {}", field_pattern));
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
        if deletion.contains("XFillRectangle") || deletion.contains("XDrawRectangle") ||
           deletion.contains("SDL_RenderFillRect") || deletion.contains("SDL_RenderDrawRect") {
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
        if trimmed.is_empty() { continue; }
        
        // Check if this line exists in old (with some fuzzy matching for whitespace)
        let exists_in_old = old_lines.iter().any(|old_line| {
            old_line.trim() == trimmed
        });
        
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
    let has_button = additions.iter().any(|line| {
        button_keywords.iter().any(|kw| line.contains(kw))
    });
    if has_button {
        description_parts.push("new button/clickable element");
    }
    
    // Detect draw calls (rectangles, shapes)
    let draw_keywords = ["draw", "Draw", "rect", "Rect", "fill", "Fill", "XFillRectangle", "XDrawRectangle"];
    let has_draw = additions.iter().any(|line| {
        draw_keywords.iter().any(|kw| line.contains(kw))
    });
    if has_draw && !has_button {
        description_parts.push("new shape/rectangle");
    }
    
    // Detect text additions
    let text_keywords = ["text", "Text", "string", "String", "XDrawString", "printf", "print"];
    let has_text = additions.iter().any(|line| {
        text_keywords.iter().any(|kw| line.contains(kw))
    });
    if has_text {
        description_parts.push("new text element");
    }
    
    // Detect event handling additions
    let event_keywords = ["event", "Event", "handler", "Handler", "motion", "Motion", "expose", "Expose"];
    let has_event = additions.iter().any(|line| {
        event_keywords.iter().any(|kw| line.contains(kw))
    });
    if has_event {
        description_parts.push("new event handler");
    }
    
    // Detect variable/struct additions
    let var_keywords = ["int ", "float ", "double ", "char ", "bool ", "struct ", "void "];
    let has_var = additions.iter().any(|line| {
        var_keywords.iter().any(|kw| line.starts_with(kw) || line.contains(&format!(" {}", kw)))
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
    let raw_code = additions.iter().take(50).cloned().collect::<Vec<_>>().join("\n");
    
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
    let core_content = cached_result.get("core")
        .and_then(|c| c.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let gui_content = cached_result.get("gui")
        .and_then(|g| g.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let shared_content = cached_result.get("shared")
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

    let backend_url = std::env::var("AI_BACKEND_URL")
        .unwrap_or_else(|_| "http://172.19.224.1:8000".to_string());
    let url = format!("{}/refactor/delta", backend_url);

    eprintln!("[AI Split] Calling fast delta endpoint: {}", url);
    
    let res = client.post(&url)
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
    let result_str = res["result"].as_str().ok_or(anyhow::anyhow!("No result from AI delta endpoint"))?;
    
    // Clean markdown
    let clean_json = if let Some(start) = result_str.find("```json") {
        let s = &result_str[start+7..];
        if let Some(end) = s.find("```") { &s[..end] } else { s }
    } else if let Some(start) = result_str.find("```") {
        let s = &result_str[start+3..];
        if let Some(end) = s.find("```") { &s[..end] } else { s }
    } else {
        result_str
    }.trim();

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
            eprintln!("[AI Split] Attempted to parse: {}...", &json_only.chars().take(500).collect::<String>());
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
    
    let core_content = cached_result.get("core")
        .and_then(|c| c.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let gui_content = cached_result.get("gui")
        .and_then(|g| g.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let shared_content = cached_result.get("shared")
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

    let backend_url = std::env::var("AI_BACKEND_URL")
        .unwrap_or_else(|_| "http://172.19.224.1:8000".to_string());
    let url = format!("{}/refactor/delta", backend_url);

    eprintln!("[AI Split] Calling delta deletion endpoint: {}", url);
    
    let res = client.post(&url)
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
    
    Err(anyhow::anyhow!("No valid result from delta deletion endpoint"))
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
    let core_content = cached_result.get("core")
        .and_then(|c| c.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let gui_content = cached_result.get("gui")
        .and_then(|g| g.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let shared_content = cached_result.get("shared")
        .and_then(|s| s.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    
    // Convert changes to JSON array format
    let changes_json: Vec<serde_json::Value> = changes.iter()
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

    let backend_url = std::env::var("AI_BACKEND_URL")
        .unwrap_or_else(|_| "http://172.19.224.1:8000".to_string());
    let url = format!("{}/refactor/structural", backend_url);

    eprintln!("[AI Split] Calling fast incremental endpoint: {}", url);
    
    let res = client.post(&url)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(20)) // Short timeout for incremental
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let result_str = res["result"].as_str().ok_or(anyhow::anyhow!("No result from AI"))?;
    
    // Clean markdown
    let clean_json = if let Some(start) = result_str.find("```json") {
        let s = &result_str[start+7..];
        if let Some(end) = s.find("```") { &s[..end] } else { s }
    } else if let Some(start) = result_str.find("```") {
        let s = &result_str[start+3..];
        if let Some(end) = s.find("```") { &s[..end] } else { s }
    } else {
        result_str
    }.trim();

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
            while chars.peek().map(|ch| ch.is_ascii_digit() || *ch == '.' || *ch == 'x' || *ch == 'X' 
                || *ch == 'a' || *ch == 'b' || *ch == 'c' || *ch == 'd' || *ch == 'e' || *ch == 'f'
                || *ch == 'A' || *ch == 'B' || *ch == 'C' || *ch == 'D' || *ch == 'E' || *ch == 'F'
                || *ch == 'u' || *ch == 'U' || *ch == 'l' || *ch == 'L').unwrap_or(false) {
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
                        eprintln!("[AI Split] Incremental update failed: {} - falling back to full regen", e);
                        // Fall through to Level 3 (full AI call)
                    }
                }
            }
        } else {
            eprintln!("[AI Split] Cache HIT (structural match) - patching strings...");
            
            // Patch the cached result with new strings
            let (patched_result, did_patch) = patch_strings_in_cached_result(&cached.result, &old_strings, &new_strings);
            
            // If patching didn't actually change anything, and strings differ, something's wrong
            // Fall back to AI call
            let strings_differ = old_strings != new_strings;
            if strings_differ && !did_patch {
                eprintln!("[AI Split] String patching FAILED (strings not found in output) - calling AI");
                // Fall through to Level 3 (AI call)
            } else {
                // Store patched result in exact-match cache for future
                {
                    let mut cache = get_ai_split_cache().lock().await;
                    cache.insert(source_hash, CachedSplit {
                        result: patched_result.clone(),
                        original_source: req.source.clone(),
                    });
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
            eprintln!("[AI Split] Detected {} deleted lines - attempting local patch", deletions.len());
            
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
                let deletion_description = deletions.iter()
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
                        eprintln!("[AI Split] Delta deletion failed: {} - will try other paths", e);
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
        if let Some(structural_changes) = detect_structural_additions(&cached.original_source, &req.source) {
            eprintln!("[AI Split] ╔═══════════════════════════════════════════════════════════╗");
            eprintln!("[AI Split] ║  DELTA CHANGE DETECTED - Using fast incremental path     ║");
            eprintln!("[AI Split] ╚═══════════════════════════════════════════════════════════╝");
            eprintln!("[AI Split] Delta type: Structural ADDITION (new element/button)");
            eprintln!("[AI Split] X11 code to translate:\n{}", structural_changes.lines().take(5).collect::<Vec<_>>().join("\n"));
            eprintln!("[AI Split] NOTE: Runner will NOT restart - HMR will hot-reload the modules");
            
            match perform_structural_ai_update(&cached.result, &cached.original_source, &req.source, &structural_changes, &req.language).await {
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
                    eprintln!("[AI Split] ✗ Structural update failed: {} - falling back to full regen", e);
                    // Fall through to Level 3 (full AI call)
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

    let backend_url = std::env::var("AI_BACKEND_URL")
        .unwrap_or_else(|_| "http://172.19.224.1:8000".to_string());
    let url = format!("{}/refactor/split", backend_url);

    let res = client.post(&url)
        .json(&payload)
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let result_str = res["result"].as_str().ok_or(anyhow::anyhow!("No result from AI"))?;
    
    // Clean markdown
    let clean_json = if let Some(start) = result_str.find("```json") {
        let s = &result_str[start+7..];
        if let Some(end) = s.find("```") {
            &s[..end]
        } else {
            s
        }
    } else if let Some(start) = result_str.find("```") {
        let s = &result_str[start+3..];
        if let Some(end) = s.find("```") {
            &s[..end]
        } else {
            s
        }
    } else {
        result_str
    }.trim();

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
                        return Err(anyhow::anyhow!("JSON Parse Error: {}. \nRaw content snippet: {}...", e, snippet));
                     }
                 }
            } else {
                println!("Failed to parse AI response: {}", e);
                println!("Raw content: {}", clean_json);
                let snippet: String = clean_json.chars().take(1000).collect();
                return Err(anyhow::anyhow!("JSON Parse Error: {}. \nRaw content snippet: {}...", e, snippet));
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
) -> Result<()> {
    // Use the shared workspace path instead of creating a new temp dir
    let dir_path = workspace_path;

    // Check if we need to restart due to GUI mode change or blocking app
    // We do this early because we consume req.files later
    // If use_ai_split is true, we assume the AI will generate the necessary hooks (on_update, etc.)
    let source_has_hooks = req.source.contains("on_update") || req.source.contains("on_load") || req.source.contains("gui_on_update");
    let files_have_hooks = req.files.iter().any(|f| f.content.contains("on_update") || f.content.contains("on_load") || f.content.contains("gui_on_update"));
    
    // Check if existing runner is already HMR-capable (from previous AI split)
    let existing_runner_is_hmr = {
        let mut guard = runner_store.lock().await;
        // Check if process is still alive before reusing
        let is_alive = if let Some(state) = guard.as_mut() {
             if let Some(child) = &mut state.process {
                 match child.try_wait() {
                     Ok(Some(status)) => {
                         eprintln!("[Main] Existing runner process has exited with status: {}", status);
                         false
                     },
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
    let ext = if cfg!(target_os = "windows") { "dll" } else { "so" };
    
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
                if (name.starts_with("libuser_code_") || name.starts_with("temp_") || name.starts_with("libcore_") || name.starts_with("libgui_")) && (name.ends_with(".so") || name.ends_with(".dll")) {
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
    } else if req.language == "cpp" || req.language == "cpp_legacy" {
        if !source_code.contains("extern \"C\" void* entrypoint") {
             source_code.push_str("\n\nextern \"C\" void* entrypoint(void* state) {\n    main();\n    return 0;\n}\n");
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
                let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                return Ok(());
            }
        };

        // DEBUG: Save generated code to a debug folder
        let debug_dir = dir_path.join("debug_ai_generated").join(format!("{}", timestamp));
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
            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
        }

        // ============================================================
        // DIFFERENTIAL REBUILD: Compute new hashes and determine scope
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
        
        // Get previous hashes from runner state (if exists)
        let (prev_hashes, prev_core_path, _prev_gui_path) = {
            let guard = runner_store.lock().await;
            if let Some(state) = guard.as_ref() {
                (state.module_hashes.clone(), state.loaded_core_path.clone(), state.loaded_gui_path.clone())
            } else {
                (ModuleHashes::new(), None, None)
            }
        };
        
        // Determine rebuild scope
        // DEBUG: Print hashes to help diagnose "Full build" issues
        eprintln!("[Main] Hashes - Prev: s={}, c={}, g={}", prev_hashes.shared_hash, prev_hashes.core_hash, prev_hashes.gui_hash);
        eprintln!("[Main] Hashes - New:  s={}, c={}, g={}", new_hashes.shared_hash, new_hashes.core_hash, new_hashes.gui_hash);

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
        let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;

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
            let has_on_load_fn = content.contains("void* core_on_load") || content.contains("void* on_load");
            let has_on_update_fn = content.contains("void core_on_update") || content.contains("void on_update");
            let has_inline_on_load = content.contains("extern \"C\" void* core_on_load") || 
                                     content.contains("extern \"C\" void* on_load");
            let has_inline_on_update = content.contains("extern \"C\" void core_on_update") || 
                                       content.contains("extern \"C\" void on_update");
            let has_on_load = has_inline_on_load || (has_extern_c_block && has_on_load_fn);
            let has_on_update = has_inline_on_update || (has_extern_c_block && has_on_update_fn);
            
            if !has_on_load {
                validation_errors.push("core.cpp missing required export: on_load or core_on_load".to_string());
            }
            if !has_on_update {
                validation_warnings.push("core.cpp missing on_update/core_on_update - app will be blocking".to_string());
            }
            
            // Check for ABI version constant (check in core.cpp content and shared.h)
            let shared_content = split_data.get("shared")
                .and_then(|s| s["content"].as_str())
                .unwrap_or("");
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
                let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
            }
            
            // Don't fail completely - continue with compilation but warn
            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "stderr",
                "line": "[Validation] Continuing with compilation despite validation issues...\n"
            });
            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
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
            for bad in ["typedef void Display", "typedef void GC", "typedef void Atom", "typedef void XIM", "typedef void XIC"] {
                if content.contains(bad) {
                    content = content.replace(bad, "// stripped invalid typedef\n");
                }
            }

            // Strip conflicting forward declarations of X11 types and normalize struct field types.
            for bad in [
                "struct Display;", "struct Window;", "struct Atom;", "struct XIM;", "struct XIC;", "struct Pixmap;", "struct GC;", "struct XWindowAttributes;"
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
            if content.contains("gui_on_load(void* prev_state, void* window_ptr)") && 
               !content.contains("gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)") {
                content = content.replace(
                    "gui_on_load(void* prev_state, void* window_ptr)",
                    "gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)"
                );
                eprintln!("[Guardrail] Fixed gui_on_load declaration in shared.h: added missing core_api_ptr parameter");
            }

            println!("Writing shared library file: {}", fname);
            tokio::fs::write(dir_path.join(fname), content).await?;
        }

        // Skip core compilation if GUI-only rebuild (reuse existing core.so)
        if rebuild_scope == RebuildScope::Both || rebuild_scope == RebuildScope::CoreOnly {
        if let Some(core) = split_data.get("core") {
            let fname = core["filename"].as_str().unwrap_or("core.cpp");
            let mut content = core["content"].as_str().unwrap_or("").to_string();

            // Read shared.h content to check what's defined there
            let shared_content = split_data.get("shared")
                .and_then(|s| s["content"].as_str())
                .unwrap_or("");
            
            // Detect if shared.h has full struct definitions or just forward declarations
            let shared_has_full_hostkv = shared_content.contains("struct HostKvApiV1 {") ||
                                          shared_content.contains("struct SynthiHostContextV1 {") ||
                                          shared_content.contains("struct SynthiNamespaceSchemaV1 {");

            // Fix common AI mistakes in core.cpp before compilation.
            if content.contains("is_running") {
                content = content.replace("is_running", "running");
            }

            // CRITICAL: Strip X11-related functions that the AI incorrectly preserved from the input.
            // The AI sometimes keeps functions like `Display* initialize_display()` or `void cleanup_display(Display* d)`
            // which reference X11 types that don't exist in our SDL2-only environment.
            // We strip entire lines containing these patterns.
            let x11_type_patterns = [
                "Display*",      // X11 display type
                "Display *",     // with space
                "Window*",       // X11 window type (not to be confused with SDL)
                "XIM",           // X11 input method
                "XIC",           // X11 input context
                "Atom",          // X11 atom type
                "Colormap",      // X11 colormap
                "Pixmap",        // X11 pixmap
                "GC ",           // X11 graphics context (with space to avoid "GCC")
                "XEvent",        // X11 event type
                "XOpenDisplay",  // X11 function calls
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
                let is_comment = line.trim_start().starts_with("//") || line.trim_start().starts_with("/*");
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
                        content.insert_str(insert_pos, "#include \"shared.h\"  // [Guardrail] Added\n");
                        eprintln!("[Guardrail] Added #include \"shared.h\" to core.cpp");
                    }
                } else {
                    content = format!("#include \"shared.h\"  // [Guardrail] Added\n{}", content);
                    eprintln!("[Guardrail] Added #include \"shared.h\" to core.cpp");
                }
            }

            // CRITICAL FIX: Transform malloc-based on_load to static storage
            if content.contains("malloc(sizeof(AppState))") && content.contains("on_load") {
                eprintln!("[Guardrail] Detected malloc(sizeof(AppState)) pattern in core.cpp");
                eprintln!("[Guardrail] CONVERTING malloc to static storage pattern for reliable HMR");
                
                // AGGRESSIVE FIX: Convert malloc-based state to static storage
                // This ensures HMR works reliably by avoiding dynamic allocation entirely
                
                // If we see the common malloc pattern, inject a static variable and fix on_load
                if !content.contains("static AppState app_state") && !content.contains("static CoreState core_state") {
                    // Find where on_load is defined and inject static variable before it
                    if let Some(on_load_pos) = content.find("extern \"C\" void* on_load") {
                        content.insert_str(on_load_pos, "// [Guardrail] Injected static storage for HMR\nstatic AppState app_state = {0};\n\n");
                        eprintln!("[Guardrail] Injected static AppState storage");
                    } else if let Some(on_load_pos) = content.find("extern \"C\" void* core_on_load") {
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
                content = content.replace("free(state);", "// free(state); // Commented - runner manages state");
            }

            // FIX: Detect and warn about memset on state which wipes preserved HMR state
            if content.contains("memset(state") || content.contains("memset(&app_state") || 
                content.contains("memset(&state") || content.contains("memset(&core_state") ||
                content.contains("memset( state") {
                eprintln!("[Guardrail] WARNING: Detected memset on state in core.cpp");
                eprintln!("[Guardrail] memset wipes preserved state from prev_state - this breaks HMR!");
                
                // Aggressive stripping of memset - catch ALL variations
                use regex::Regex;
                let re_memset = Regex::new(r"memset\s*\(\s*(state|&app_state|&core_state|&state|&gui_app_state)[^;]*\)\s*;").unwrap();
                content = re_memset.replace_all(&content, "// [Guardrail] memset REMOVED to preserve HMR state").to_string();
            }

            // Drop writes/reads to non-existent XWindowAttributes fields that break the build.
            for bad_field in ["event_mask", "damage", "border_pixel", "background_pixel", "saved_attributes", "attributes_mask"] {
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
            if (content.contains("XLookupString") || content.contains("XK_Escape")) && !content.contains("#include <X11/Xutil.h>") {
                content = format!("#include <X11/Xutil.h>\n#include <X11/keysym.h>\n{}", content);
            }
            if (content.contains("dlopen") || content.contains("dlsym")) && !content.contains("#include <dlfcn.h>") {
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
                content = content.replace("#define CORE_STATE_MAGIC", "// #define CORE_STATE_MAGIC");
                content = content.replace("#define SYNTHI_ABI_VERSION", "// #define SYNTHI_ABI_VERSION");
                
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
                for struct_name in &["HostKvApiV1", "SynthiHostContextV1", "SynthiNamespaceSchemaV1"] {
                     // Always strip typedef forward declarations if they exist
                     let typedef_pattern = format!("typedef struct {} {};", struct_name, struct_name);
                     if content.contains(&typedef_pattern) {
                         content = content.replace(&typedef_pattern, &format!("// {} forward-declared in shared.h", struct_name));
                         eprintln!("[Guardrail] Stripped typedef forward decl for '{}' from core.cpp", struct_name);
                     }
                     
                     // Strip full struct definitions ONLY if shared.h has them
                     if shared_has_full_hostkv {
                         let struct_decl = format!("struct {} {{", struct_name);
                         if let Some(start) = content.find(&struct_decl) {
                             if let Some(end) = content[start..].find("};") {
                                 let block_end = start + end + "};".len();
                                 let block = &content[start..block_end];
                                 eprintln!("[Guardrail] Stripping duplicate 'struct {}' from core.cpp (full definition in shared.h)", struct_name);
                                 content = content.replace(block, &format!("// {} fully defined in shared.h", struct_name));
                             }
                         }
                     } else {
                         // shared.h only has forward declarations, keep full definitions here
                         eprintln!("[Guardrail] Keeping 'struct {}' definition in core.cpp (shared.h has forward decl only)", struct_name);
                     }
                }
                
                // FIX: If AI uses Host KV types but shared.h doesn't define them, inject definitions
                // This happens when AI generates g_core_schemas[] or uses SynthiHostContextV1
                let uses_hostkv_types = content.contains("SynthiHostContextV1") || 
                                        content.contains("SynthiNamespaceSchemaV1") ||
                                        content.contains("HostKvApiV1") ||
                                        content.contains("g_core_schemas") ||
                                        content.contains("host_kv_schemas");
                
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
                let hallucinated_fields = ["wbuffer", "write_buffer", "rbuffer", "read_buffer", "buffer_ptr"];
                for field in &hallucinated_fields {
                    if !shared_content.contains(field) && (content.contains(&format!("->{}", field)) || content.contains(&format!(".{}", field))) {
                        // Strip lines referencing this non-existent field
                        let pattern1 = format!("->{}", field);
                        let pattern2 = format!(".{}", field);
                        
                        let mut cleaned = Vec::new();
                        for line in content.lines() {
                            if line.contains(&pattern1) || line.contains(&pattern2) {
                                cleaned.push(format!("// [Guardrail] Removed: {} (field not in AppState)", line.trim()));
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
                let has_btn_init = content.contains("btn_x =") || 
                                   content.contains("btn_x=") ||
                                   content.contains("->btn_x =") ||
                                   content.contains(".btn_x =");
                
                if !has_btn_init {
                    // Find ALL state initialization blocks and inject button init after dx = 5
                    // The AI typically generates: app_state.dx = 5; without btn_ fields
                    let btn_init_code = "\n        app_state.btn_x = 200;\n        app_state.btn_y = 10;\n        app_state.btn_w = 120;\n        app_state.btn_h = 40;";
                    
                    // Replace ALL occurrences of dx = 5 initialization
                    if content.contains("app_state.dx = 5;") {
                        content = content.replace(
                            "app_state.dx = 5;",
                            &format!("app_state.dx = 5;{}", btn_init_code)
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
                    eprintln!("[Guardrail] Fixed state->btn* -> app_state.btn* in core.cpp init code");
                }
            }

            // FIX: cleanup_window not declared
            if content.contains("cleanup_window(app_state.window)") && !content.contains("void cleanup_window") {
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
                    "// dlclose moved to safe block"
                 );
                 // Also handle one-line version
                 content = content.replace(
                    "if (gui_lib) dlclose(gui_lib);",
                    "// dlclose moved to safe block"
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
            for func in &["gui_initialize", "gui_on_update", "gui_render", "gui_cleanup", "gui_on_event"] {
                let ptr_name = format!("ptr_{}", func);
                // Replace calls: func( -> ptr_name(
                content = content.replace(&format!("{}(", func), &format!("{}(", ptr_name));
                
                // FIX: Prevent double prefixing if the code already used pointers
                // ptr_gui_initialize( -> ptr_ptr_gui_initialize( -> ptr_gui_initialize(
                let double_ptr = format!("ptr_{}", ptr_name);
                content = content.replace(&double_ptr, &ptr_name);

                // Restore declarations: void ptr_name( -> void func(
                content = content.replace(&format!("void {}(", ptr_name), &format!("void {}(", func));
            }

            // Replace hard-wired GUI symbol assignments with null so the core does not depend on GUI at link/load time.
            for (from, to) in [
                ("ptr_gui_initialize = gui_initialize;", "ptr_gui_initialize = nullptr;"),
                ("ptr_gui_on_update = gui_on_update;", "ptr_gui_on_update = nullptr;"),
                ("ptr_gui_render = gui_render;", "ptr_gui_render = nullptr;"),
                ("ptr_gui_cleanup = gui_cleanup;", "ptr_gui_cleanup = nullptr;"),
                ("ptr_gui_on_event = gui_on_event;", "ptr_gui_on_event = nullptr;")
            ] {
                if content.contains(from) {
                    content = content.replace(from, to);
                }
            }



            // FIX: Comment out SDL_RenderPresent to prevent deadlock with runner's event loop
            // The runner handles SDL_RenderPresent after calling gui_render
            use regex::Regex;
            let re_present = Regex::new(r"SDL_RenderPresent\s*\([^)]*\)\s*;").unwrap();
            content = re_present.replace_all(&content, "/* SDL_RenderPresent removed - runner handles this */").to_string();

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
            if content.contains("core_on_load") && 
               !content.contains("core_on_save_state") && 
               !content.contains("core_get_state_schema_hash") {
                // Parse actual fields from shared.h WITH DEFAULT VALUES for proper schema migration
                let fields = parse_appstate_int_fields_with_defaults(shared_content);
                eprintln!("[Guardrail] Parsed {} fields from shared.h for serialization: {:?}", 
                    fields.len(), 
                    fields.iter().map(|(n,_,d)| format!("{}={:?}", n, d)).collect::<Vec<_>>());
                
                // Generate serialization code that handles ALL fields with declared defaults
                let state_serial_stubs = generate_state_serialization_code_with_defaults(&fields, "core");
                content.push_str(&state_serial_stubs);
                eprintln!("[Guardrail] Injected DYNAMIC state serialization for Full HMR (core) with declared defaults");
            }
            // Case 2: Legacy module - also use dynamic serialization
            // Skip if AI already generated these functions to avoid redefinition errors
            else if content.contains("on_load") && 
                    !content.contains("on_save_state") && 
                    !content.contains("core_on_load") &&
                    !content.contains("get_state_schema_hash") {
                // Parse actual fields from shared.h WITH DEFAULT VALUES for proper schema migration
                let fields = parse_appstate_int_fields_with_defaults(shared_content);
                eprintln!("[Guardrail] Parsed {} fields from shared.h for legacy serialization: {:?}", 
                    fields.len(), 
                    fields.iter().map(|(n,_,d)| format!("{}={:?}", n, d)).collect::<Vec<_>>());
                
                // Generate serialization code that handles ALL fields (legacy prefix)
                let state_serial_stubs = generate_state_serialization_code_with_defaults(&fields, "legacy");
                content.push_str(&state_serial_stubs);
                eprintln!("[Guardrail] Injected DYNAMIC state serialization for Full HMR (legacy) with declared defaults");
            }

            let content_hash = calculate_hash(&content);
            
            // Try content-addressable cache first (persists across sessions)
            let cache_key = IncrementalCache::cache_key(&content, &["-shared", "-fPIC"], &[]);
            if let Some(cached_so) = incremental_cache.get(&cache_key).await {
                core_lib_path = cached_so.to_string_lossy().to_string();
                eprintln!("[Cache] HIT for core module (persistent cache)");
                println!("Using cached core library: {}", core_lib_path);
            } else {
                // Cache miss - need to compile
                tokio::fs::write(dir_path.join(fname), &content).await?;
                
                let core_out = output_dir.join(format!("libcore_{}.{}", timestamp, ext));
                let mut cmd = system_command("g++");
                cmd.arg("-shared").arg("-fPIC")
                   .arg("-D_POSIX_C_SOURCE=199309L")
                   // Debug flags for source map generation
                   .arg("-g").arg("-gdwarf-4").arg("-fno-omit-frame-pointer")
                   // Add JSON diagnostics flag for structured error parsing
                   .arg("-fdiagnostics-format=json")
                   .arg(fname).arg("-I.").arg("-o").arg(&core_out)
                   .arg("-ldl")
                   // Export symbols for backtracing
                   .arg("-rdynamic");
                cmd.current_dir(&dir_path);
                
                let output = cmd.output().await?;
                if !output.status.success() {
                     let stderr = String::from_utf8_lossy(&output.stderr);
                     
                     // Parse compiler output into structured diagnostics
                     let diag_report = parse_compiler_output(&stderr, "core", CompilerType::Gcc, true);
                     let diag_event = DiagnosticEvent::new("core", diag_report.clone())
                         .with_session(session_id.clone().unwrap_or_default());
                     
                     // Send structured diagnostics
                     let diag_payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "compile-diagnostics",
                        "data": serde_json::from_str::<serde_json::Value>(&diag_event.to_json()).unwrap_or_default()
                     });
                     let _ = log_dc.send_text(serde_json::to_string(&diag_payload).unwrap_or_default()).await;
                     
                     // Send compile error HMR status - rollback behavior keeps old module
                     let status = HmrStatus::compile_error("core", vec![stderr.to_string()]);
                     let hmr_payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "hmr-status",
                        "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                     });
                     let _ = log_dc.send_text(serde_json::to_string(&hmr_payload).unwrap_or_default()).await;
                     
                     // If we have an existing runner with the old core, keep it running (rollback)
                     {
                         let guard = runner_store.lock().await;
                         if let Some(state) = guard.as_ref() {
                             if state.loaded_core_path.is_some() {
                                 let rejected = HmrStatus::rejected("core", "Compilation failed - keeping previous module");
                                 let payload = serde_json::json!({
                                     "sessionId": session_id.clone(),
                                     "type": "hmr-status",
                                     "data": serde_json::from_str::<serde_json::Value>(&rejected.to_json()).unwrap_or_default()
                                 });
                                 let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
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
                    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                    return Ok(());
                }
                core_lib_path = core_out.to_string_lossy().to_string();
                
                // Detect Core module capabilities from exports
                if let Ok(core_report) = detect_capabilities(std::path::Path::new(&core_lib_path)) {
                    eprintln!("[Capability] Core module: {:?}, HMR: {:?}", core_report.module_type, core_report.hmr_capability);
                    let status = HmrStatus::capability_detected("core", &core_report);
                    let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "hmr-status",
                        "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                    });
                    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                }
                
                // Store in persistent content-addressable cache
                if let Ok(so_data) = tokio::fs::read(&core_lib_path).await {
                    let source_hash = content_hash;
                    let flags_hash = calculate_hash(&"-shared-fPIC");
                    let headers_hash = 0u64;
                    if let Err(e) = incremental_cache.put(cache_key.clone(), source_hash, flags_hash, headers_hash, &so_data).await {
                        eprintln!("[Cache] Failed to store core in persistent cache: {}", e);
                    } else {
                        eprintln!("[Cache] Stored core module in persistent cache");
                    }
                }
                
                // Also update legacy in-memory cache for fast path
                let mut cache = compile_cache.lock().await;
                cache.insert("core".to_string(), (content_hash, core_lib_path.clone()));
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
                let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                
                boundary_violations.extend(result.violations.clone());
                if result.action == RefreshAction::FullReload || result.action == RefreshAction::Restart {
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
                let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                
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
            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
        }

        if let Some(gui) = split_data.get("gui") {
            // Only compile GUI if scope includes it
            if rebuild_scope == RebuildScope::Both || rebuild_scope == RebuildScope::GuiOnly {
            let fname = gui["filename"].as_str().unwrap_or("gui.cpp");
            let mut content = gui["content"].as_str().unwrap_or("").to_string();

            // Read shared.h content to check what's defined there (reuse from core processing)
            let shared_content = split_data.get("shared")
                .and_then(|s| s["content"].as_str())
                .unwrap_or("");
            
            // Detect if shared.h has full struct definitions or just forward declarations
            let shared_has_full_hostkv = shared_content.contains("struct HostKvApiV1 {") ||
                                          shared_content.contains("struct SynthiHostContextV1 {") ||
                                          shared_content.contains("struct SynthiNamespaceSchemaV1 {");

            // CRITICAL: Strip X11-related functions that the AI incorrectly preserved from the input.
            let x11_type_patterns = [
                "Display*", "Display *", "XIM", "XIC", "Atom", "Colormap", "Pixmap", "GC ",
                "XEvent", "XOpenDisplay", "XCloseDisplay", "XCreateWindow", "XDestroyWindow",
                "XOpenIM", "XCreateIC", "XCreateGC", "XFreeGC", "XCreatePixmap", "XFreePixmap",
            ];
            let mut cleaned_lines = Vec::new();
            for line in content.lines() {
                let has_x11 = x11_type_patterns.iter().any(|pat| line.contains(pat));
                let is_comment = line.trim_start().starts_with("//") || line.trim_start().starts_with("/*");
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
            if content.contains("CORE_STATE_MAGIC") && !content.contains("#define CORE_STATE_MAGIC") {
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
                for struct_name in &["HostKvApiV1", "SynthiHostContextV1", "SynthiNamespaceSchemaV1"] {
                     // Always strip typedef forward declarations if they exist
                     let typedef_pattern = format!("typedef struct {} {};", struct_name, struct_name);
                     if content.contains(&typedef_pattern) {
                         content = content.replace(&typedef_pattern, &format!("// {} forward-declared in shared.h", struct_name));
                         eprintln!("[Guardrail] Stripped typedef forward decl for '{}' from gui.cpp", struct_name);
                     }
                     
                     // Strip full struct definitions ONLY if shared.h has them
                     if shared_has_full_hostkv {
                         let struct_decl = format!("struct {} {{", struct_name);
                         if let Some(start) = content.find(&struct_decl) {
                             if let Some(end) = content[start..].find("};") {
                                 let block_end = start + end + "};".len();
                                 let block = &content[start..block_end];
                                 eprintln!("[Guardrail] Stripping duplicate 'struct {}' from gui.cpp (full definition in shared.h)", struct_name);
                                 content = content.replace(block, &format!("// {} fully defined in shared.h", struct_name));
                             }
                         }
                     } else {
                         // shared.h only has forward declarations, keep full definitions here
                         eprintln!("[Guardrail] Keeping 'struct {}' definition in gui.cpp (shared.h has forward decl only)", struct_name);
                     }
                }
                
                // FIX: If AI uses Host KV types but shared.h doesn't define them, inject definitions
                let uses_hostkv_types = content.contains("SynthiHostContextV1") || 
                                        content.contains("SynthiNamespaceSchemaV1") ||
                                        content.contains("HostKvApiV1") ||
                                        content.contains("g_gui_schemas") ||
                                        content.contains("host_kv_schemas");
                
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
                            eprintln!("[Guardrail] Injected Host KV type definitions into gui.cpp");
                        }
                    } else {
                        content = format!("{}{}", hostkv_header, content);
                        eprintln!("[Guardrail] Injected Host KV type definitions at start of gui.cpp");
                    }
                }
            }

            // FIX: gui_on_load MUST have 3 parameters. AI sometimes generates 2-param version.
            // The runner expects: gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)
            if content.contains("gui_on_load(void* prev_state, void* window_ptr)") && 
               !content.contains("gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)") {
                content = content.replace(
                    "gui_on_load(void* prev_state, void* window_ptr)",
                    "gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)"
                );
                eprintln!("[Guardrail] Fixed gui_on_load signature: added missing core_api_ptr parameter");
            }

            // FIX: Comment out SDL_RenderPresent to prevent deadlock
            // The runner handles SDL_RenderPresent after calling gui_render
            let re_present = regex::Regex::new(r"SDL_RenderPresent\s*\([^)]*\)\s*;").unwrap();
            content = re_present.replace_all(&content, "/* SDL_RenderPresent removed - runner handles this */").to_string();

            // FIX: Replace SDL_GetKeyboardWindow with SDL_GetKeyboardFocus (AI hallucination fix)
            if content.contains("SDL_GetKeyboardWindow") {
                content = content.replace("SDL_GetKeyboardWindow", "SDL_GetKeyboardFocus");
                eprintln!("[Guardrail] Replaced SDL_GetKeyboardWindow with SDL_GetKeyboardFocus");
            }

            // CRITICAL FIX: Convert malloc-based gui_on_load to static storage for reliable HMR
            if content.contains("malloc(sizeof(AppState))") && content.contains("gui_on_load") {
                eprintln!("[Guardrail] Detected malloc(sizeof(AppState)) pattern in gui.cpp");
                eprintln!("[Guardrail] CONVERTING malloc to static storage pattern for reliable HMR");
                
                // Inject static variable if not present
                if !content.contains("static AppState gui_app_state") && !content.contains("static GuiState gui_state") {
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
                content = content.replace("free(state);", "// free(state); // Commented - runner manages state");
            }

            // FIX: Detect and warn about memset on state which wipes preserved HMR state
            if content.contains("memset(state") || content.contains("memset(&app_state") || 
                content.contains("memset(&gui_state") || content.contains("memset(&state") ||
                content.contains("memset(&gui_app_state") || content.contains("memset( state") {
                eprintln!("[Guardrail] WARNING: Detected memset on state in gui.cpp");
                eprintln!("[Guardrail] memset wipes preserved state from prev_state - this breaks HMR!");
                
                // Aggressive stripping of memset - catch ALL variations
                use regex::Regex;
                let re_memset = Regex::new(r"memset\s*\(\s*(state|&app_state|&gui_state|&state|&gui_app_state)[^;]*\)\s*;").unwrap();
                content = re_memset.replace_all(&content, "// [Guardrail] memset REMOVED to preserve HMR state").to_string();
            }

            // CRITICAL FIX: AI sometimes uses 'app_state' in gui.cpp instead of 'gui_app_state'
            // This happens during structural updates when AI copies patterns from core.cpp
            // The variable in gui.cpp MUST be 'gui_app_state' (injected by guardrail) not 'app_state'
            if content.contains("static AppState gui_app_state") || content.contains("&gui_app_state") {
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
            if content.contains("SDL_Render") || content.contains("SDL_SetRenderDrawColor") || content.contains("draw_text") {
                // Match patterns like SDL_RenderFillRect(renderer, but NOT state->renderer
                // Use simple string replacement for common patterns
                let fixes = [
                    ("SDL_RenderFillRect(renderer,", "SDL_RenderFillRect(state->renderer,"),
                    ("SDL_RenderDrawRect(renderer,", "SDL_RenderDrawRect(state->renderer,"),
                    ("SDL_SetRenderDrawColor(renderer,", "SDL_SetRenderDrawColor(state->renderer,"),
                    ("SDL_RenderClear(renderer)", "SDL_RenderClear(state->renderer)"),
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
                    eprintln!("[Guardrail] Fixed renderer -> state->renderer in gui.cpp SDL calls");
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
            if content.contains("gui_on_load") && 
               !content.contains("gui_on_save_state") &&
               !content.contains("gui_get_state_schema_hash") {
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
            }
            
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
                
                // Store in persistent content-addressable cache
                if let Ok(so_data) = tokio::fs::read(&gui_lib_path).await {
                    let source_hash = combined_hash;
                    let flags_hash = calculate_hash(&"-shared-fPIC-lSDL2");
                    let headers_hash = 0u64;
                    if let Err(e) = incremental_cache.put(gui_cache_key.clone(), source_hash, flags_hash, headers_hash, &so_data).await {
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
                    eprintln!("[Widget HMR] Detected {} widgets in GUI code - compiling separately", 
                        widget_analysis.widgets.len());
                    
                    // Notify frontend of widget detection
                    let widget_names: Vec<String> = widget_analysis.widgets.iter()
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
                    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                    
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
                        "-fPIC", "-g", "-gdwarf-4", "-fno-omit-frame-pointer",
                        "-D_POSIX_C_SOURCE=199309L"
                    ];
                    
                    match widget_compiler.compile_widgets(&content, fname, "g++", &base_flags).await {
                        Ok(widget_results) => {
                            let mut widgets_loaded: Vec<(String, String)> = Vec::new();
                            let mut widgets_skipped = 0;
                            let mut widgets_failed = 0;
                            
                            for result in &widget_results {
                                if result.success {
                                    if let Some(ref so_path) = result.so_path {
                                        // Check if widget actually changed (compare hashes)
                                        let widget_hash = hash_content(&result.widget_id);
                                        if let Some(&prev_hash) = prev_widget_hashes.get(&result.widget_id) {
                                            if prev_hash == widget_hash {
                                                widgets_skipped += 1;
                                                continue; // Skip unchanged widget
                                            }
                                        }
                                        
                                        let path_str = so_path.to_string_lossy().to_string();
                                        widgets_loaded.push((result.widget_id.clone(), path_str.clone()));
                                        
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
                                        let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                    }
                                } else {
                                    widgets_failed += 1;
                                    eprintln!("[Widget HMR] Widget '{}' failed: {:?}", 
                                        result.widget_id, result.error);
                                    
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
                                    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
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
                            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                            
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
                println!("[Independent Swap] GUI module queued for independent reload: {}", gui_lib_path);
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
            cmd.arg("-shared").arg("-fPIC")
               .arg("-D_POSIX_C_SOURCE=199309L")
               .arg(stub_name).arg("-I.").arg("-o").arg(&gui_out)
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
                eprintln!("[Shim] Applying auto-shim mode: {:?} (has_gui: {})", shim_config.mode, shim_config.has_gui);
                
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
                shimmed_filename = format!("shimmed_{}", req.filename);
                let shimmed_path = dir_path.join(&shimmed_filename);
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
                let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                
                shim_applied = true;
            } else {
                eprintln!("[Shim] Code already HMR-compatible, no shim needed");
            }
        }
        
        let compile_filename = if shim_applied { &shimmed_filename } else { &req.filename };
        
        let mut cmd = match req.language.as_str() {
            "cpp" | "cpp_legacy" => {
                let mut c = system_command("g++");
                c.arg("-shared").arg("-fPIC").arg("-D_POSIX_C_SOURCE=199309L");
                // Output to temp path for atomic swap
                c.arg(compile_filename).arg("-I.").arg("-o").arg(&temp_output_path_str);
                if req.is_gui {
                    c.arg("-lSDL2").arg("-lX11");
                }
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
                            let txt = serde_json::to_string(&payload).unwrap_or_else(|_| String::from(""));
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
                            let txt = serde_json::to_string(&payload).unwrap_or_else(|_| String::from(""));
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
            let status = HmrStatus::compile_error("main", vec!["Compilation failed".to_string()]);
            let hmr_payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "hmr-status",
                "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
            });
            let _ = log_dc.send_text(serde_json::to_string(&hmr_payload).unwrap_or_default()).await;
            
            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "status": "done",
                "success": false,
                "stage": "compile",
                "code": compile_status.code()
            });
            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_else(|_| String::from(""))).await;
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
            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_else(|_| String::from(""))).await;
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
                eprintln!("[Capability] Module type: {:?}, HMR: {:?}", report.module_type, report.hmr_capability);
                
                // Send capability detection result to frontend
                let status = HmrStatus::capability_detected("main", &report);
                let payload = serde_json::json!({
                    "sessionId": session_id.clone(),
                    "type": "hmr-status",
                    "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                });
                let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                
                // Send warnings to frontend
                for warning in &report.warnings {
                    let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "stderr",
                        "line": format!("[HMR Warning] {}\n", warning)
                    });
                    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
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
                let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
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
                    let status = HmrStatus::FullReloadRequired {
                        reason: "Blocking app (no on_update loop). Cannot hot-reload.".to_string(),
                    };
                    let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "hmr-status",
                        "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                    });
                    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                    true
                }
                HmrCapability::Invalid => {
                    eprintln!("[Policy] Invalid module (missing exports) - full reload required");
                    let status = HmrStatus::FullReloadRequired {
                        reason: "Invalid module (missing required exports).".to_string(),
                    };
                    let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "hmr-status",
                        "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                    });
                    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                    true
                }
                _ => false
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
                        _ => None
                    };
                    let new_abi = report.abi_version;
                    if existing_abi.is_some() && new_abi.is_some() && existing_abi != new_abi {
                        eprintln!("[Policy] ABI version mismatch: {:?} vs {:?} - full reload required", existing_abi, new_abi);
                        let status = HmrStatus::FullReloadRequired {
                            reason: format!("ABI version mismatch ({:?} vs {:?})", existing_abi, new_abi),
                        };
                        let payload = serde_json::json!({
                            "sessionId": session_id.clone(),
                            "type": "hmr-status",
                            "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                        });
                        let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
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
        
        modules_to_load.push(("main".to_string(), final_output_path.to_string_lossy().to_string()));
        
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
    
    eprintln!("[Main] Restart check: is_gui={}, has_on_update={}, is_blocking_app={}, use_ai_split={}", 
        req.is_gui, has_on_update, is_blocking_app, use_ai_split);
    
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
        eprintln!("[Main] HMR mode: Skipping track attachment and output subscription (already set up)");
    } else if let Some(state) = guard.as_mut() {
        // We have an existing runner but can't do HMR - need to restart
        let gui_mode_changed = state.is_gui != req.is_gui;
        eprintln!("[Main] Restarting runner: gui_mode_changed={}, is_blocking_app={}, use_ai_split={}", 
            gui_mode_changed, is_blocking_app, use_ai_split);
        
        // If resolution matches and is_gui matches, we can reuse Xvfb/GStreamer
        let can_reuse = state.is_gui == req.is_gui && state.width == req_width && state.height == req_height;
        
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
            if let Some(mut child) = state.xvfb_process { let _ = child.kill().await; }
            if let Some(pipeline) = state.gst_pipeline { let _ = pipeline.set_state(gst::State::Null); }
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
                            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
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
                        let pipeline = pipeline.downcast::<gst::Pipeline>().expect("Expected pipeline");
                        let video_src = pipeline.by_name("video_src").expect("Source not found").downcast::<gst_app::AppSrc>().expect("Expected AppSrc");
                        
                        let v_tx_clone = v_tx.clone();
                        if let Ok(video_sink) = pipeline.by_name("video_sink").context("Sink not found").and_then(|s| s.downcast::<gst_app::AppSink>().map_err(|_| anyhow::anyhow!("Expected AppSink"))) {
                            let sink_sample_count = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
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
                        if let Ok(audio_sink) = pipeline.by_name("audio_sink").context("Sink not found").and_then(|s| s.downcast::<gst_app::AppSink>().map_err(|_| anyhow::anyhow!("Expected AppSink"))) {
                            audio_sink.set_callbacks(
                                gst_app::AppSinkCallbacks::builder()
                                    .new_sample(move |sink| {
                                        let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                                        let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                                        let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                                        let _ = a_tx_clone.send(map.to_vec());
                                        Ok(gst::FlowSuccess::Ok)
                                    })
                                    .build()
                            );
                        }

                        if let Err(e) = pipeline.set_state(gst::State::Playing) {
                            eprintln!("Failed to set pipeline to playing with encoder {}: {}", encoder, e);
                            let mut pulse_error = false;
                            if let Some(bus) = pipeline.bus() {
                                while let Some(msg) = bus.timed_pop(gst::ClockTime::from_mseconds(100)) {
                                    match msg.view() {
                                        gst::MessageView::Error(err) => {
                                            let (src, _msg, dbg) = (err.src().map(|s| s.path_string()).unwrap_or_default(), err.error(), err.debug());
                                            if src.contains("pulsesrc") || (dbg.as_ref().map(|d| d.contains("Connection refused")).unwrap_or(false)) {
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
                        eprintln!("Failed to create GStreamer pipeline with encoder {}: {}", encoder, e);
                        encoder_idx += 1;
                    }
                }
            }

            let video_track = Arc::new(TrackLocalStaticRTP::new(
                RTCRtpCodecCapability { mime_type: selected_mime_type, ..Default::default() },
                "video".to_owned(),
                "webrtc-rs".to_owned(),
            ));
            let audio_track = Arc::new(TrackLocalStaticRTP::new(
                RTCRtpCodecCapability { mime_type: "audio/opus".to_owned(), ..Default::default() },
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
                        eprintln!("[RTP] Video packets: written={}, unmarshal_failed={}", rtp_count, rtp_fail_count);
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
                c.arg(format!("DISPLAY={}", wsl_display_str)).arg("xdotool").arg("-");
                c
            } else {
                let mut c = Command::new("xdotool");
                c.arg("-").env("DISPLAY", &wsl_display_str);
                c
            };

            input_injector.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            if let Ok(mut injector_child) = input_injector.spawn() {
                if let Some(mut injector_stdin) = injector_child.stdin.take() {
                    let (sdl_tx, mut sdl_rx) = mpsc::unbounded_channel::<String>();
                    if let Some(sid) = session_id.clone() { let mut guard = sdl_input_store.lock().await; guard.insert(sid, sdl_tx.clone()); }
                    sdl_tx_opt = Some(sdl_tx);
                    
                    tokio::spawn(async move {
                        while let Some(mut cmd) = sdl_rx.recv().await {
                            if cmd.starts_with("mousemove ") {
                                while let Ok(next) = sdl_rx.try_recv() {
                                    if next.starts_with("mousemove ") {
                                        cmd = next;
                                    } else {
                                        if let Err(_) = injector_stdin.write_all(cmd.as_bytes()).await {}
                                        let _ = injector_stdin.write_all(b"\n").await;
                                        cmd = next;
                                        break;
                                    }
                                }
                            }
                            if let Err(_) = injector_stdin.write_all(cmd.as_bytes()).await { break; }
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
            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
        }

        let exe_path = std::env::current_exe()?;
        let runner_path = exe_path.parent().unwrap().join(if cfg!(target_os = "windows") { "runner.exe" } else { "runner" });
        
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
                                eprintln!("[Main] Received {} frames from runner, pushing to GStreamer", frame_count);
                                last_log = std::time::Instant::now();
                            }
                            let gst_buffer = gst::Buffer::from_slice(buffer.clone());
                            let result = src.push_buffer(gst_buffer);
                            if result.is_err() && last_log.elapsed() > std::time::Duration::from_secs(5) {
                                eprintln!("[Main] GStreamer push_buffer failed: {:?}", result);
                            }
                        }
                        Err(e) => {
                            eprintln!("[Main] Error reading from runner stdout: {}", e);
                            break;
                        }
                    }
                }
                eprintln!("[Main] Runner stdout reader exited after {} frames", frame_count);
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
                                if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_part) {
                                    let payload = serde_json::json!({
                                        "sessionId": sid_for_status.clone(),
                                        "type": "hmr-status",
                                        "data": val
                                    });
                                    let _ = log_dc_for_status
                                        .send_text(serde_json::to_string(&payload).unwrap_or_default())
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
            hmr_capability: None, // Will be set per-module as they load
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
                eprintln!("[WebRTC] Found {} transceivers to attach tracks to", transceivers.len());
                for t in transceivers {
                    let kind = t.kind();
                    eprintln!("[WebRTC] Transceiver kind: {:?}, direction: {:?}", kind, t.direction());
                    if kind == RTPCodecType::Video {
                        let sender = t.sender().await;
                        match sender.replace_track(Some(Arc::clone(v_track) as Arc<dyn TrackLocal + Send + Sync>)).await {
                            Ok(_) => eprintln!("[WebRTC] Successfully attached video track"),
                            Err(e) => eprintln!("[WebRTC] Failed to attach video track: {:?}", e),
                        }
                    } else if kind == RTPCodecType::Audio {
                        let sender = t.sender().await;
                        match sender.replace_track(Some(Arc::clone(a_track) as Arc<dyn TrackLocal + Send + Sync>)).await {
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
                            let msg_type = if type_str == "STDOUT" { "run-stdout" } else { "run-stderr" };
                            let payload = serde_json::json!({
                            "sessionId": sid.clone(),
                            "type": msg_type,
                            "line": content
                        });
                        let _ = log_dc_clone.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
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
                    let status = HmrStatus::applied(name, &report);
                    let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "hmr-status",
                        "data": serde_json::from_str::<serde_json::Value>(&status.to_json()).unwrap_or_default()
                    });
                    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                    eprintln!("[HMR] Applied: module={}, capability={:?}, state_preserved={}", 
                        name, report.hmr_capability, report.hmr_capability.preserves_state());
                }
            }
        }
        state.stdin.flush().await?;
        
        if existing_runner_can_hmr {
            eprintln!("[Main] HMR update sent to existing runner: {} module(s) loaded", modules_to_load.len());
            
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
            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
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
    let _ = log_dc.send_text(serde_json::to_string(&hmr_payload).unwrap_or_default()).await;

    // Send success
    let payload = serde_json::json!({
        "sessionId": session_id.clone(),
        "status": "done",
        "success": true,
        "stage": "run"
    });
    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
    
    println!("[Main] handle_compile completed successfully.");
    
    // Cleanup terminal sender for this session (if any)
    if let Some(sid_opt) = session_id.clone() {
        let mut guard = terminal_store.lock().await;
        guard.remove(&sid_opt);
    }

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
