use std::sync::Arc;
use std::process::Stdio;
use std::collections::HashMap;
use std::env;

mod builder;
mod watcher;
mod server;
mod storage;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

use anyhow::{Context, Result};
use futures::{FutureExt, StreamExt, SinkExt};
use serde::{Deserialize, Serialize};
use tempfile::tempdir;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader, AsyncWriteExt};
use chrono::{Utc, SecondsFormat};
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
const GUI_TOOLS: &[&str] = &["xdotool", "Xvfb", "matchbox-window-manager"];

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

#[derive(Debug, Deserialize)]
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
}

struct RunnerState {
    process: Option<tokio::process::Child>, // Option to allow taking it if needed, or just drop
    stdin: tokio::process::ChildStdin,
    output_tx: tokio::sync::broadcast::Sender<String>,
    is_gui: bool,
    xvfb_process: Option<tokio::process::Child>,
    gst_pipeline: Option<gst::Pipeline>,
    x11_tx: Option<mpsc::UnboundedSender<String>>,
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
    // Store of sessionId -> xdotool stdin sender for persistent X11 input
    let x11_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>> = Arc::new(Mutex::new(HashMap::new()));
    // Store for persistent runner process
    let runner_store: Arc<Mutex<Option<RunnerState>>> = Arc::new(Mutex::new(None));

    // Create a persistent workspace directory for the session
    let workspace_dir = Arc::new(tempdir()?);
    let workspace_path = workspace_dir.path().to_owned();
    let workspace_path_for_watcher = workspace_path.clone();
    let workspace_path_for_builder = workspace_path.clone();
    let workspace_path_arc = Arc::new(workspace_path);

    // --- Build System Initialization ---
    let (update_tx, _) = tokio::sync::broadcast::channel(16);
    let (watcher_tx, watcher_rx) = std::sync::mpsc::channel();
    
    // Start Watcher
    let _watcher = watcher::setup_watcher(&workspace_path_for_watcher, watcher_tx).context("Failed to setup watcher")?;
    
    // Start Build Loop
    let build_update_tx = update_tx.clone();
    
    let mut build_session = builder::BuildSession::new(workspace_path_for_builder);
    let session_hash = build_session.session_hash.clone();
    
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

    // Build Loop Task
    tokio::task::spawn_blocking(move || {
        loop {
            if let Ok(path_str) = watcher_rx.recv() {
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
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let store = compile_store.clone();
        let term_store = term_store.clone();
        let pc_for_callback = pc_clone.clone();
        let workspace_path_for_dc = workspace_path_for_callback.clone();
        let x11_store_outer = x11_input_store.clone();
        let runner_store_outer = runner_store_for_callback.clone();
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
                        let x11_store = x11_store_outer.clone();
                        let runner_store = runner_store_outer.clone();
                        async move {
                            if msg.is_string {
                                // Try to parse as a CompileRequest
                                if let Ok(req) = serde_json::from_slice::<CompileRequest>(&msg.data) {
                                    let log_dc = { store.lock().await.clone() };
                                    if let Some(log) = log_dc {
                                        let ts = term_store_for_msg.clone();
                                        let x11s = x11_store.clone();
                                        let rs = runner_store.clone();
                                        let pc_clone = pc_for_compile.clone();
                                        let wp = workspace_path_for_compile.clone();
                                        tokio::spawn(handle_compile(req, log, ts, x11s, rs, pc_clone, wp.to_path_buf()));
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
                    let x11_store_for_msg = x11_store_outer.clone();
                    dc.on_message(Box::new(move |msg| {
                        let term_store_for_msg = term_store.clone();
                        let x11_store = x11_store_for_msg.clone();
                        async move {
                            if msg.is_string {
                                // diagnostic log
                                if let Ok(s) = String::from_utf8(msg.data.to_vec()) {
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
                                            // Handle GUI event by sending to persistent xdotool process
                                            if let Some(sid) = v.get("sessionId").and_then(|x| x.as_str()) {
                                                if let Some(evt) = v.get("event") {
                                                    let guard = x11_store.lock().await;
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

async fn handle_compile(
    req: CompileRequest,
    log_dc: Arc<RTCDataChannel>,
    terminal_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>,
    x11_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>,
    runner_store: Arc<Mutex<Option<RunnerState>>>,
    pc: Arc<RTCPeerConnection>,
    workspace_path: std::path::PathBuf,
) -> Result<()> {
    // Use the shared workspace path instead of creating a new temp dir
    let dir_path = workspace_path;

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
                if (name.starts_with("libuser_code_") || name.starts_with("temp_")) && (name.ends_with(".so") || name.ends_with(".dll")) {
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
    } else if req.language == "cpp" {
        if !source_code.contains("extern \"C\" void* entrypoint") {
             source_code.push_str("\n\nextern \"C\" void* entrypoint(void* state) {\n    main();\n    return 0;\n}\n");
        }
    }
    tokio::fs::write(&file_path, &source_code).await?;
    println!("Main file written to {:?}", file_path);

    // Write additional files
    for file in req.files {
        println!("Writing additional file: {}", file.name);
        let p = dir_path.join(&file.name);
        // Ensure parent directories exist if the file is in a subdirectory
        if let Some(parent) = p.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&p, file.content).await?;
    }

    let mut cmd = match req.language.as_str() {
        "cpp" => {
            let mut c = system_command("g++");
            c.arg("-shared").arg("-fPIC");
            // Output to temp path for atomic swap
            c.arg(&req.filename).arg("-I.").arg("-o").arg(&temp_output_path_str);
            if req.is_gui {
                c.arg("-lX11");
            }
            c
        }
        "rust" => {
            let mut c = system_command("rustc");
            c.arg("--crate-type").arg("cdylib");
            // Output to temp path for atomic swap
            c.arg(&req.filename).arg("-o").arg(&temp_output_path_str);
            if req.is_gui {
                c.arg("-l").arg("X11");
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

    // NOTE: We don't register a terminal stdin sender for the compiler process
    // itself (g++, rustc, tsc) because those tools typically do not read from
    // stdin. Instead, we will register a sender when we spawn the runtime
    // process (the produced binary) so that terminal input is routed to the
    // running program's stdin.

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

    // Run the produced binary for C++ only (for now)
    if req.language == "cpp_legacy" {
        let bin_path = dir_path.join("main.out");
        let mut run_cmd = if cfg!(target_os = "windows") {
            let mut c = Command::new("wsl");
            c.arg("./main.out");
            c
        } else {
            Command::new(bin_path)
        };
        run_cmd.current_dir(&dir_path);
        // Ensure the runtime process has a piped stdin so we can forward
        // terminal input into it.
        run_cmd.stdin(Stdio::piped());
        run_cmd.stdout(Stdio::piped());
        run_cmd.stderr(Stdio::piped());

        let mut xvfb_process: Option<tokio::process::Child> = None;
        let mut gst_pipeline: Option<gst::Pipeline> = None;

        if req.is_gui {
            for tool in GUI_TOOLS {
                if Command::new(tool).arg("--version").output().await.is_err() {
                     let msg = format!("Error: GUI tool '{}' is missing. GUI apps require Linux/WSL with xdotool, Xvfb, and matchbox-window-manager installed.\n", tool);
                     let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "type": "stderr",
                        "line": msg
                     });
                     let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                     
                     let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "status": "done",
                        "success": false,
                        "stage": "run",
                        "code": 1
                     });
                     let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                     return Ok(());
                }
            }

            let width = req.width.unwrap_or(1280);
            let height = req.height.unwrap_or(720);
            let resolution = format!("{}x{}x24", width, height);

            let mut wsl_display_str = String::new();
            let mut gst_display_str = String::new();
            let mut xvfb = system_command("Xvfb");
            xvfb.arg("-displayfd").arg("1")
                .arg("-screen")
                .arg("0")
                .arg(&resolution)
                .arg("-ac")
                .arg("-listen")
                .arg("tcp")
                .arg("-s").arg("0")
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit());

            match xvfb.spawn() {
                Ok(mut child) => {
                    if let Some(stdout) = child.stdout.take() {
                        let mut reader = BufReader::new(stdout);
                        let mut line = String::new();
                        match reader.read_line(&mut line).await {
                            Ok(n) if n > 0 => {
                                let display_num = line.trim();
                                // Use standard X DISPLAY format ":N"
                                wsl_display_str = format!(":{}", display_num);
                                if cfg!(target_os = "windows") {
                                    // On Windows, we need to connect to WSL's Xvfb via TCP
                                    gst_display_str = format!("127.0.0.1:{}", display_num);
                                } else {
                                    gst_display_str = wsl_display_str.clone();
                                }
                                println!("Xvfb started on display {}", wsl_display_str);
                            }
                            _ => eprintln!("Xvfb failed to output a display number"),
                        }
                    }
                    xvfb_process = Some(child);
                }
                Err(e) => eprintln!("Failed to spawn Xvfb: {}", e),
            }

            // If for any reason we didn't obtain a display number from Xvfb,
            // fall back to a default display so GUI input mapping still works.
            if wsl_display_str.is_empty() {
                wsl_display_str = ":99".to_string();
                if cfg!(target_os = "windows") {
                    gst_display_str = "127.0.0.1:99".to_string();
                } else {
                    gst_display_str = wsl_display_str.clone();
                }
                println!("Falling back to DISPLAY {}", wsl_display_str);
            }

            // Give Xvfb time to fully initialize
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            // Start a window manager for proper focus/window management
            // Using matchbox-window-manager as it's lightweight and designed for embedded systems
            let mut wm_cmd = if cfg!(target_os = "windows") {
                let mut c = system_command("env");
                c.arg(format!("DISPLAY={}", wsl_display_str)).arg("matchbox-window-manager");
                c
            } else {
                let mut c = Command::new("matchbox-window-manager");
                c.env("DISPLAY", &wsl_display_str);
                c
            };

            wm_cmd.stdout(Stdio::null())
                  .stderr(Stdio::null());
            match wm_cmd.spawn() {
                Ok(_) => println!("Started window manager on display {}", wsl_display_str),
                Err(e) => eprintln!("Warning: Failed to start window manager: {}. GUI apps may not receive input properly.", e),
            }

            // Give window manager time to initialize
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

            let (v_tx, mut v_rx) = mpsc::unbounded_channel::<Vec<u8>>();
            let (a_tx, mut a_rx) = mpsc::unbounded_channel::<Vec<u8>>();

            let encoders = [
                ("nvh265enc preset=low-latency-hp zerolatency=true", "rtph265pay", "video/H265"),
                ("vaapih265enc", "rtph265pay", "video/H265"),
                ("msdkh265enc", "rtph265pay", "video/H265"),
                ("v4l2h265enc", "rtph265pay", "video/H265"),
                ("mfh265enc low-latency=true", "rtph265pay", "video/H265"),
                ("d3d11h265enc", "rtph265pay", "video/H265"),
                ("amfh265enc", "rtph265pay", "video/H265"),
                // H264 HW Fallbacks
                ("nvh264enc preset=low-latency-hp zerolatency=true", "rtph264pay", "video/H264"),
                ("vaapih264enc", "rtph264pay", "video/H264"),
                ("msdkh264enc", "rtph264pay", "video/H264"),
                ("v4l2h264enc", "rtph264pay", "video/H264"),
                ("mfh264enc low-latency=true", "rtph264pay", "video/H264"),
                ("d3d11h264enc", "rtph264pay", "video/H264"),
                ("amfh264enc", "rtph264pay", "video/H264"),
                // SW Fallbacks - Prefer H264 for performance in WSL
                ("x264enc tune=zerolatency speed-preset=ultrafast bitrate=2000 key-int-max=60 ! video/x-h264,stream-format=byte-stream", "rtph264pay", "video/H264"),
                ("openh264enc ! video/x-h264,stream-format=byte-stream", "rtph264pay", "video/H264"),
                // SW H265 (Last resort - heavy on CPU)
                ("x265enc tune=zerolatency speed-preset=ultrafast bitrate=2000 key-int-max=60 ! video/x-h265,stream-format=byte-stream", "rtph265pay", "video/H265"),
                ("openh265enc ! video/x-h265,stream-format=byte-stream", "rtph265pay", "video/H265"),
            ];

            let mut selected_mime_type = "video/H265".to_owned();
            let mut audio_source = "pulsesrc".to_string();
            let mut encoder_idx = 0;

            while encoder_idx < encoders.len() {
                let (encoder, payloader, mime_type) = encoders[encoder_idx];

                // Skip H265 if browser explicitly says it's not supported
                if mime_type == "video/H265" && req.supports_h265 == Some(false) {
                    encoder_idx += 1;
                    continue;
                }

                let gst_pipeline_str = format!(
                    "ximagesrc display-name={} use-damage=false show-pointer=false ! video/x-raw,framerate=30/1 ! queue ! videoconvert ! {} ! {} config-interval=-1 ! queue ! appsink name=video_sink drop=true max-buffers=100 \
                     {} ! audio/x-raw,rate=48000,channels=2 ! queue ! opusenc ! rtpopuspay ! queue ! appsink name=audio_sink drop=true max-buffers=100",
                    gst_display_str, encoder, payloader, audio_source
                );

                match gst::parse_launch(&gst_pipeline_str) {
                    Ok(pipeline) => {
                        let pipeline = pipeline.downcast::<gst::Pipeline>().expect("Expected pipeline");
                        
                        let v_tx_clone = v_tx.clone();
                        if let Ok(video_sink) = pipeline.by_name("video_sink").context("Sink not found").and_then(|s| s.downcast::<gst_app::AppSink>().map_err(|_| anyhow::anyhow!("Expected AppSink"))) {
                            video_sink.set_callbacks(
                                gst_app::AppSinkCallbacks::builder()
                                    .new_sample(move |sink| {
                                        let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                                        let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                                        let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                                        let _ = v_tx_clone.send(map.to_vec());
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
                            
                            // Check for PulseAudio errors on the bus
                            let mut pulse_error = false;
                            if let Some(bus) = pipeline.bus() {
                                while let Some(msg) = bus.timed_pop(gst::ClockTime::from_mseconds(100)) {
                                    match msg.view() {
                                        gst::MessageView::Error(err) => {
                                            let (src, msg, dbg) = (err.src().map(|s| s.path_string()).unwrap_or_default(), err.error(), err.debug());
                                            eprintln!("GStreamer Error from {}: {} ({:?})", src, msg, dbg);
                                            
                                            if src.contains("pulsesrc") || (dbg.as_ref().map(|d| d.contains("Connection refused")).unwrap_or(false)) {
                                                pulse_error = true;
                                            }

                                            let payload = serde_json::json!({
                                                "sessionId": session_id.clone(),
                                                "type": "stderr",
                                                "line": format!("GStreamer Error from {}: {} ({:?})", src, msg, dbg)
                                            });
                                            let _ = log_dc.clone().send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                        }
                                        gst::MessageView::Warning(warn) => {
                                            let (s, m, d) = (warn.src().map(|s| s.path_string()).unwrap_or_default(), warn.error(), warn.debug());
                                            eprintln!("GStreamer Warning from {}: {} ({:?})", s, m, d);
                                            let payload = serde_json::json!({
                                                "sessionId": session_id.clone(),
                                                "type": "stderr",
                                                "line": format!("GStreamer Warning from {}: {} ({:?})", s, m, d)
                                            });
                                            let _ = log_dc.clone().send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                        }
                                        _ => {}
                                    }
                                }
                            }

                            // If it was a pulse error and we are using pulsesrc, switch to fallback and retry
                            if pulse_error && audio_source == "pulsesrc" {
                                println!("PulseAudio failed, switching to audiotestsrc fallback");
                                audio_source = "audiotestsrc is-live=true wave=silence".to_string();
                                // Don't increment encoder_idx, so we retry this encoder
                                continue;
                            }

                            // Send failure into the build-log channel so UI can show it
                            let payload = serde_json::json!({
                                "sessionId": session_id.clone(),
                                "type": "stderr",
                                "line": format!("Failed to set pipeline to playing with encoder {}: {}", encoder, e)
                            });
                            let _ = log_dc.clone().send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                            
                            encoder_idx += 1;
                            continue;
                        }
                        println!("Successfully started pipeline with encoder: {}", encoder);
                        // Also surface success to the build-log channel for UI
                        {
                            let payload = serde_json::json!({
                                "sessionId": session_id.clone(),
                                "type": "stdout",
                                "line": format!("Successfully started pipeline with encoder: {}", encoder)
                            });
                            let _ = log_dc.clone().send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                        }
                        gst_pipeline = Some(pipeline);
                        selected_mime_type = mime_type.to_owned();
                        break;
                    }
                    Err(e) => {
                        eprintln!("Failed to create GStreamer pipeline with encoder {}: {}", encoder, e);
                        let payload = serde_json::json!({
                            "sessionId": session_id.clone(),
                            "type": "stderr",
                            "line": format!("Failed to create GStreamer pipeline with encoder {}: {}", encoder, e)
                        });
                        let _ = log_dc.clone().send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
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

            // Find existing transceivers and replace track
            let transceivers = pc.get_transceivers().await;
            for t in transceivers {
                let kind = t.kind();
                if kind == RTPCodecType::Video {
                    let sender = t.sender().await;
                    let _ = sender.replace_track(Some(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)).await;
                } else if kind == RTPCodecType::Audio {
                    let sender = t.sender().await;
                    let _ = sender.replace_track(Some(Arc::clone(&audio_track) as Arc<dyn TrackLocal + Send + Sync>)).await;
                }
            }

            let v_track_clone = video_track.clone();
            tokio::spawn(async move {
                while let Some(buf) = v_rx.recv().await {
                    if let Ok(packet) = Packet::unmarshal(&mut &buf[..]) {
                        let _ = v_track_clone.write_rtp(&packet).await;
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

            // Start persistent xdotool process for input handling
            let mut xdotool = if cfg!(target_os = "windows") {
                let mut c = system_command("env");
                c.arg(format!("DISPLAY={}", wsl_display_str)).arg("xdotool").arg("-");
                c
            } else {
                let mut c = Command::new("xdotool");
                c.arg("-").env("DISPLAY", &wsl_display_str);
                c
            };

            xdotool.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            
            let mut xdotool_child = xdotool.spawn()?;
            
            let mut xdotool_stdin = xdotool_child.stdin.take().ok_or(anyhow::anyhow!("Failed to open xdotool stdin"))?;
            let xdotool_stderr = xdotool_child.stderr.take();

            if let Some(stderr) = xdotool_stderr {
                tokio::spawn(async move {
                    let reader = BufReader::new(stderr);
                    let mut lines = reader.lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        eprintln!("[xdotool error] {}", line);
                    }
                });
            }

            let (x11_tx, mut x11_rx) = mpsc::unbounded_channel::<String>();
            
            if let Some(sid) = session_id.clone() {
                let mut guard = x11_input_store.lock().await;
                guard.insert(sid, x11_tx);
            }

            tokio::spawn(async move {
                while let Some(mut cmd) = x11_rx.recv().await {
                    // Coalesce mouse move events to prevent lag
                    if cmd.starts_with("mousemove ") {
                        while let Ok(next) = x11_rx.try_recv() {
                            if next.starts_with("mousemove ") {
                                cmd = next;
                            } else {
                                // Found a non-move event (e.g. click), flush the last move first
                                if let Err(e) = xdotool_stdin.write_all(cmd.as_bytes()).await {
                                    eprintln!("Failed to write to xdotool: {}", e);
                                }
                                let _ = xdotool_stdin.write_all(b"\n").await;
                                cmd = next;
                                break;
                            }
                        }
                    }

                    if let Err(e) = xdotool_stdin.write_all(cmd.as_bytes()).await {
                        eprintln!("Failed to write to xdotool: {}", e);
                        break;
                    }
                    let _ = xdotool_stdin.write_all(b"\n").await;
                    let _ = xdotool_stdin.flush().await;
                }
                // Channel closed, close stdin, wait for process
                drop(xdotool_stdin);
                let _ = xdotool_child.wait().await;
            });

            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "run-gui-start",
                "width": width,
                "height": height,
                "display": wsl_display_str
            });
            let json_str = serde_json::to_string(&payload).unwrap_or_default();
            println!("Sending GUI start message: {}", json_str);
            let _ = log_dc.send_text(json_str).await;

            run_cmd.env("DISPLAY", &wsl_display_str);
            if cfg!(target_os = "windows") {
                run_cmd.env("WSLENV", "DISPLAY");
            }
        }

        // Record start time (seconds precision), spawn the run child, and notify listeners
        let start_dt = Utc::now();
        let start_time = start_dt.to_rfc3339_opts(SecondsFormat::Secs, true);
        let mut run_child = run_cmd.spawn()?;
        let mut run_child_stdin = run_child.stdin.take();
        // Notify that the run started (so UI can display start time)
        let start_payload = serde_json::json!({
            "sessionId": session_id.clone(),
            "type": "run-start",
            "start_time": start_time.clone()
        });
        let _ = log_dc.send_text(serde_json::to_string(&start_payload).unwrap_or_else(|_| String::from(""))).await;
        let run_stdout = run_child.stdout.take().map(BufReader::new);
        let run_stderr = run_child.stderr.take().map(BufReader::new);

        // If we have a session id, register a sender so 'terminal' messages
        // are routed into the running child's stdin.
        if let Some(sid_opt) = session_id.clone() {
            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
            {
                let mut guard = terminal_store.lock().await;
                guard.insert(sid_opt.clone(), tx);
            }

            // Spawn a task that writes incoming stdin messages into the run child's stdin
            tokio::spawn(async move {
                while let Some(chunk) = rx.recv().await {
                    if let Some(mut s) = run_child_stdin.take() {
                        let _ = s.write_all(chunk.as_bytes()).await;
                        // put stdin back for subsequent writes
                        run_child_stdin = Some(s);
                    }
                }
            });
        }

        if let Some(mut out) = run_stdout {
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
                                "type": "run-stdout",
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

        if let Some(mut err) = run_stderr {
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
                                "type": "run-stderr",
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

        let run_status = run_child.wait().await?;
        
        if req.is_gui {
            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "run-gui-end"
            });
            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
        }

        if let Some(mut child) = xvfb_process { let _ = child.kill().await; }
        if let Some(pipeline) = gst_pipeline {
            let _ = pipeline.set_state(gst::State::Null);
        }

        let end_dt = Utc::now();
        let end_time = end_dt.to_rfc3339_opts(SecondsFormat::Secs, true);
        let elapsed = end_dt.signed_duration_since(start_dt);
        let elapsed_ms = elapsed.num_milliseconds();
        let elapsed_str = if elapsed_ms >= 1000 {
            format!("{:.3}s", elapsed_ms as f64 / 1000.0)
        } else {
            format!("{}ms", elapsed_ms)
        };

        let payload = serde_json::json!({
            "sessionId": session_id.clone(),
            "status": "done",
            "success": run_status.success(),
            "stage": "run",
            "code": run_status.code(),
            "start_time": start_time,
            "end_time": end_time,
            "elapsed_ms": elapsed_ms,
            "elapsed": elapsed_str
        });
        let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_else(|_| String::from(""))).await;
        // Cleanup terminal sender for this session
        if let Some(sid_opt) = session_id.clone() {
            let mut guard = terminal_store.lock().await;
            guard.remove(&sid_opt);
        }
        // Cleanup x11 sender for this session
        if let Some(sid_opt) = session_id.clone() {
            let mut g = x11_input_store.lock().await;
            g.remove(&sid_opt);
        }
        return Ok(());
    } else if req.language == "rust" || req.language == "cpp" {
        // let ext = if cfg!(target_os = "windows") { "dll" } else { "so" };
        let lib_path = final_output_path;
        let lib_path_str = lib_path.to_string_lossy().to_string();

        let mut guard = runner_store.lock().await;
        
        // Check if we need to restart due to GUI mode change
        if guard.as_ref().map_or(false, |s| s.is_gui != req.is_gui) {
             println!("Restarting runner due to GUI mode change");
             let mut state = guard.take().unwrap();
             if let Some(mut child) = state.process { let _ = child.kill().await; }
             if let Some(mut child) = state.xvfb_process { let _ = child.kill().await; }
             if let Some(pipeline) = state.gst_pipeline { let _ = pipeline.set_state(gst::State::Null); }
        }
        
        if guard.is_none() {
            // Start runner
            println!("Starting persistent runner...");
            
            let mut wsl_display_str = String::new();
            let mut xvfb_process: Option<tokio::process::Child> = None;
            let mut gst_pipeline: Option<gst::Pipeline> = None;
            let mut x11_tx_opt: Option<mpsc::UnboundedSender<String>> = None;

            if req.is_gui {
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

                let width = req.width.unwrap_or(1280);
                let height = req.height.unwrap_or(720);
                let resolution = format!("{}x{}x24", width, height);

                let mut gst_display_str = String::new();
                let mut xvfb = system_command("Xvfb");
                xvfb.arg("-displayfd").arg("1")
                    .arg("-screen")
                    .arg("0")
                    .arg(&resolution)
                    .arg("-ac")
                    .arg("-listen")
                    .arg("tcp")
                    .arg("-s").arg("0")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit());

                match xvfb.spawn() {
                    Ok(mut child) => {
                        if let Some(stdout) = child.stdout.take() {
                            let mut reader = BufReader::new(stdout);
                            let mut line = String::new();
                            match reader.read_line(&mut line).await {
                                Ok(n) if n > 0 => {
                                    let display_num = line.trim();
                                    wsl_display_str = format!(":{}", display_num);
                                    if cfg!(target_os = "windows") {
                                        gst_display_str = format!("127.0.0.1:{}", display_num);
                                    } else {
                                        gst_display_str = wsl_display_str.clone();
                                    }
                                    println!("Xvfb started on display {}", wsl_display_str);
                                }
                                _ => eprintln!("Xvfb failed to output a display number"),
                            }
                        }
                        xvfb_process = Some(child);
                    }
                    Err(e) => eprintln!("Failed to spawn Xvfb: {}", e),
                }

                if wsl_display_str.is_empty() {
                    wsl_display_str = ":99".to_string();
                    if cfg!(target_os = "windows") {
                        gst_display_str = "127.0.0.1:99".to_string();
                    } else {
                        gst_display_str = wsl_display_str.clone();
                    }
                    println!("Falling back to DISPLAY {}", wsl_display_str);
                }

                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                let mut wm_cmd = if cfg!(target_os = "windows") {
                    let mut c = system_command("env");
                    c.arg(format!("DISPLAY={}", wsl_display_str)).arg("matchbox-window-manager");
                    c
                } else {
                    let mut c = Command::new("matchbox-window-manager");
                    c.env("DISPLAY", &wsl_display_str);
                    c
                };

                wm_cmd.stdout(Stdio::null()).stderr(Stdio::null());
                let _ = wm_cmd.spawn(); // Let it run

                tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

                let (v_tx, mut v_rx) = mpsc::unbounded_channel::<Vec<u8>>();
                let (a_tx, mut a_rx) = mpsc::unbounded_channel::<Vec<u8>>();

                let encoders = [
                    ("nvh265enc preset=low-latency-hp zerolatency=true", "rtph265pay", "video/H265"),
                    ("vaapih265enc", "rtph265pay", "video/H265"),
                    ("msdkh265enc", "rtph265pay", "video/H265"),
                    ("v4l2h265enc", "rtph265pay", "video/H265"),
                    ("mfh265enc low-latency=true", "rtph265pay", "video/H265"),
                    ("d3d11h265enc", "rtph265pay", "video/H265"),
                    ("amfh265enc", "rtph265pay", "video/H265"),
                    ("nvh264enc preset=low-latency-hp zerolatency=true", "rtph264pay", "video/H264"),
                    ("vaapih264enc", "rtph264pay", "video/H264"),
                    ("msdkh264enc", "rtph264pay", "video/H264"),
                    ("v4l2h264enc", "rtph264pay", "video/H264"),
                    ("mfh264enc low-latency=true", "rtph264pay", "video/H264"),
                    ("d3d11h264enc", "rtph264pay", "video/H264"),
                    ("amfh264enc", "rtph264pay", "video/H264"),
                    ("x264enc tune=zerolatency speed-preset=ultrafast bitrate=2000 key-int-max=60 ! video/x-h264,stream-format=byte-stream", "rtph264pay", "video/H264"),
                    ("openh264enc ! video/x-h264,stream-format=byte-stream", "rtph264pay", "video/H264"),
                    ("x265enc tune=zerolatency speed-preset=ultrafast bitrate=2000 key-int-max=60 ! video/x-h265,stream-format=byte-stream", "rtph265pay", "video/H265"),
                    ("openh265enc ! video/x-h265,stream-format=byte-stream", "rtph265pay", "video/H265"),
                ];

                let mut selected_mime_type = "video/H265".to_owned();
                let mut audio_source = "pulsesrc".to_string();
                let mut encoder_idx = 0;

                while encoder_idx < encoders.len() {
                    let (encoder, payloader, mime_type) = encoders[encoder_idx];
                    if mime_type == "video/H265" && req.supports_h265 == Some(false) {
                        encoder_idx += 1;
                        continue;
                    }

                    let gst_pipeline_str = format!(
                        "ximagesrc display-name={} use-damage=false show-pointer=false ! video/x-raw,framerate=30/1 ! queue ! videoconvert ! {} ! {} config-interval=-1 ! queue ! appsink name=video_sink drop=true max-buffers=100 \
                         {} ! audio/x-raw,rate=48000,channels=2 ! queue ! opusenc ! rtpopuspay ! queue ! appsink name=audio_sink drop=true max-buffers=100",
                        gst_display_str, encoder, payloader, audio_source
                    );

                    match gst::parse_launch(&gst_pipeline_str) {
                        Ok(pipeline) => {
                            let pipeline = pipeline.downcast::<gst::Pipeline>().expect("Expected pipeline");
                            let v_tx_clone = v_tx.clone();
                            if let Ok(video_sink) = pipeline.by_name("video_sink").context("Sink not found").and_then(|s| s.downcast::<gst_app::AppSink>().map_err(|_| anyhow::anyhow!("Expected AppSink"))) {
                                video_sink.set_callbacks(
                                    gst_app::AppSinkCallbacks::builder()
                                        .new_sample(move |sink| {
                                            let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                                            let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                                            let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                                            let _ = v_tx_clone.send(map.to_vec());
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
                                                let (src, msg, dbg) = (err.src().map(|s| s.path_string()).unwrap_or_default(), err.error(), err.debug());
                                                if src.contains("pulsesrc") || (dbg.as_ref().map(|d| d.contains("Connection refused")).unwrap_or(false)) {
                                                    pulse_error = true;
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                if pulse_error && audio_source == "pulsesrc" {
                                    audio_source = "audiotestsrc is-live=true wave=silence".to_string();
                                    continue;
                                }
                                encoder_idx += 1;
                                continue;
                            }
                            println!("Successfully started pipeline with encoder: {}", encoder);
                            gst_pipeline = Some(pipeline);
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

                let transceivers = pc.get_transceivers().await;
                for t in transceivers {
                    let kind = t.kind();
                    if kind == RTPCodecType::Video {
                        let sender = t.sender().await;
                        let _ = sender.replace_track(Some(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)).await;
                    } else if kind == RTPCodecType::Audio {
                        let sender = t.sender().await;
                        let _ = sender.replace_track(Some(Arc::clone(&audio_track) as Arc<dyn TrackLocal + Send + Sync>)).await;
                    }
                }

                let v_track_clone = video_track.clone();
                tokio::spawn(async move {
                    while let Some(buf) = v_rx.recv().await {
                        if let Ok(packet) = Packet::unmarshal(&mut &buf[..]) {
                            let _ = v_track_clone.write_rtp(&packet).await;
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

                let mut xdotool = if cfg!(target_os = "windows") {
                    let mut c = system_command("env");
                    c.arg(format!("DISPLAY={}", wsl_display_str)).arg("xdotool").arg("-");
                    c
                } else {
                    let mut c = Command::new("xdotool");
                    c.arg("-").env("DISPLAY", &wsl_display_str);
                    c
                };

                xdotool.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
                if let Ok(mut xdotool_child) = xdotool.spawn() {
                    if let Some(mut xdotool_stdin) = xdotool_child.stdin.take() {
                        let (x11_tx, mut x11_rx) = mpsc::unbounded_channel::<String>();
                        x11_tx_opt = Some(x11_tx);
                        
                        tokio::spawn(async move {
                            while let Some(mut cmd) = x11_rx.recv().await {
                                if cmd.starts_with("mousemove ") {
                                    while let Ok(next) = x11_rx.try_recv() {
                                        if next.starts_with("mousemove ") {
                                            cmd = next;
                                        } else {
                                            if let Err(_) = xdotool_stdin.write_all(cmd.as_bytes()).await {}
                                            let _ = xdotool_stdin.write_all(b"\n").await;
                                            cmd = next;
                                            break;
                                        }
                                    }
                                }
                                if let Err(_) = xdotool_stdin.write_all(cmd.as_bytes()).await { break; }
                                let _ = xdotool_stdin.write_all(b"\n").await;
                                let _ = xdotool_stdin.flush().await;
                            }
                            drop(xdotool_stdin);
                            let _ = xdotool_child.wait().await;
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
            
            tokio::spawn(async move {
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
            });
            
            let tx_clone2 = tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => break,
                        Ok(_) => {
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
                xvfb_process,
                gst_pipeline,
                x11_tx: x11_tx_opt,
            });
        }

        if let Some(state) = guard.as_mut() {
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

            // Register x11 input for this session
            if let Some(tx) = &state.x11_tx {
                if let Some(sid) = session_id.clone() {
                    let mut g = x11_input_store.lock().await;
                    g.insert(sid, tx.clone());
                }
            }

            // Send load command
            let cmd = format!("load {}\n", lib_path_str);
            println!("Sending command to runner: {}", cmd.trim());
            state.stdin.write_all(cmd.as_bytes()).await?;
            state.stdin.flush().await?;
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
        
        return Ok(());
    }

    let payload = serde_json::json!({
        "sessionId": session_id.clone(),
        "status": "done",
        "success": true,
        "stage": "compile"
    });
    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_else(|_| String::from(""))).await;

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
