use std::sync::Arc;
use std::process::Stdio;
use std::collections::HashMap;
use std::env;

mod storage;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use gstreamer_app::prelude::*;

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

const REQUIRED_TOOLS: &[&str] = &["g++", "rustc", "tsc"];

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
                    *s = s.replace(from, to);
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

#[tokio::main]
async fn main() -> Result<()> {
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

    // Create a persistent workspace directory for the session
    let workspace_dir = Arc::new(tempdir()?);
    let workspace_path = workspace_dir.path().to_owned();
    let workspace_path_arc = Arc::new(workspace_path);

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
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let store = compile_store.clone();
        let term_store = term_store.clone();
        let pc_for_callback = pc_clone.clone();
        let workspace_path_for_dc = workspace_path_for_callback.clone();
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
                    async move {
                        if msg.is_string {
                            // Try to parse as a CompileRequest
                            if let Ok(req) = serde_json::from_slice::<CompileRequest>(&msg.data) {
                                let log_dc = { store.lock().await.clone() };
                                if let Some(log) = log_dc {
                                    let ts = term_store_for_msg.clone();
                                    tokio::spawn(handle_compile(req, log, ts, pc_for_compile, workspace_path_for_compile.to_path_buf()));
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
                    dc.on_message(Box::new(move |msg| {
                        let term_store_for_msg = term_store.clone();
                        async move {
                            if msg.is_string {
                                // diagnostic log
                                if let Ok(s) = String::from_utf8(msg.data.to_vec()) {
                                    println!("[worker] terminal msg: {}", s);
                                }
                                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&msg.data) {
                                    if let Some(t) = v.get("type").and_then(|x| x.as_str()) {
                                        if t == "stdin" {
                                            if let Some(sid) = v.get("sessionId").and_then(|x| x.as_str()) {
                                                if let Some(d) = v.get("data").and_then(|x| x.as_str()) {
                                                    let mut guard = term_store_for_msg.lock().await;
                                                    if let Some(sender) = guard.get(sid) {
                                                        let _ = sender.send(d.to_string());
                                                    } else {
                                                        println!("[worker] no stdin sender for session {}", sid);
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

                tokio::spawn(async move {
                    // Try to download the workspace files
                    let slug_to_use = slug_opt.as_deref().unwrap_or("test-workspace");
                    println!("LSP Request: lang={}, slug={}", lang, slug_to_use);
                    
                    let workspace_path = match storage::download(slug_to_use, None).await {
                        Ok(path) => {
                            println!("Successfully downloaded workspace to: {}", path.display());
                            path
                        },
                        Err(e) => {
                            eprintln!("Failed to download workspace: {}", e);
                            println!("Falling back to temp workspace: {}", workspace_path_for_lsp.display());
                            workspace_path_for_lsp.as_ref().clone()
                        }
                    };

                    println!("Starting LSP for language: {}", lang);
                    let mut cmd = match lang.as_str() {
                        "cpp" | "c" => system_command("clangd"),
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
                            let server_root_uri = if cfg!(target_os = "windows") {
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

                            let state = Arc::new(Mutex::new(LspSessionState {
                                client_root_uri: None,
                                server_root_uri: server_root_uri.clone(),
                            }));

                            let state_for_incoming = state.clone();
                            let workspace_path_for_incoming = workspace_path_for_lsp.clone();

                            dc_clone.on_message(Box::new(move |msg| {
                                let tx = stdin_tx.clone();
                                let state = state_for_incoming.clone();
                                let workspace_path = workspace_path_for_incoming.clone();
                                async move {
                                    let mut data = msg.data.to_vec();
                                    
                                    // Determine if the message has headers or is raw JSON
                                    let (json_bytes, has_headers) = if let Some(json_start) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                                        (&data[json_start+4..], true)
                                    } else {
                                        (&data[..], false)
                                    };
                                    
                                    // Try to parse and process
                                    let mut processed = false;
                                    if let Ok(mut json_val) = serde_json::from_slice::<serde_json::Value>(json_bytes) {
                                        let mut guard = state.lock().await;
                                        
                                        // 1. Capture client root URI from initialize
                                        if json_val.get("method").and_then(|m| m.as_str()) == Some("initialize") {
                                            if let Some(params) = json_val.get("params") {
                                                if let Some(root_uri) = params.get("rootUri").and_then(|s| s.as_str()) {
                                                    guard.client_root_uri = Some(root_uri.to_string());
                                                    println!("Captured client root URI: {}", root_uri);
                                                } else if let Some(folders) = params.get("workspaceFolders").and_then(|f| f.as_array()) {
                                                    if let Some(first) = folders.first() {
                                                        if let Some(uri) = first.get("uri").and_then(|s| s.as_str()) {
                                                            guard.client_root_uri = Some(uri.to_string());
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
                                }.boxed()
                            }));
                            
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
                                                header_lines.push(line.clone());
                                                if line == "\r\n" {
                                                    break;
                                                }
                                                if line.to_lowercase().starts_with("content-length:") {
                                                    if let Some(idx) = line.find(':') {
                                                        if let Ok(len) = line[idx+1..].trim().parse::<usize>() {
                                                            content_length = len;
                                                        }
                                                    }
                                                }
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
                                                    let guard = state_for_outgoing.lock().await;
                                                    rewrite_uris(&mut json_val, &guard, false);
                                                    
                                                    if let Ok(new_content) = serde_json::to_vec(&json_val) {
                                                        // Send ONLY content (no headers) to WebRTC
                                                        let data = Bytes::copy_from_slice(&new_content);
                                                        if let Err(_) = dc_out.send(&data).await { break; }
                                                    }
                                                } else {
                                                    // Failed to parse JSON, but we read `content_length` bytes.
                                                    // Send just the body?
                                                    let data = Bytes::copy_from_slice(&buf);
                                                    if let Err(_) = dc_out.send(&data).await { break; }
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

async fn handle_compile(req: CompileRequest, log_dc: Arc<RTCDataChannel>, terminal_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>, pc: Arc<RTCPeerConnection>, workspace_path: std::path::PathBuf) -> Result<()> {
    // Use the shared workspace path instead of creating a new temp dir
    let dir_path = workspace_path;
    
    // Write the main file
    let file_path = dir_path.join(&req.filename);
    // Clone session id locally so we can move it into spawned tasks without
    // invalidating the `req` value for later use.
    let session_id = req.session_id.clone();
    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&file_path, &req.source).await?;
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
            c.arg(&req.filename).arg("-I.").arg("-lX11").arg("-o").arg("main.out");
            c
        }
        "rust" => {
            let mut c = system_command("rustc");
            c.arg(&req.filename).arg("-o").arg("main.out");
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

    // Run the produced binary for C++ only (for now)
    if req.language == "cpp" {
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
            let width = req.width.unwrap_or(1280);
            let height = req.height.unwrap_or(720);
            let resolution = format!("{}x{}x24", width, height);

            let mut display_str = String::new();
            let mut xvfb = system_command("Xvfb");
            xvfb.arg("-displayfd").arg("1")
                .arg("-screen")
                .arg("0")
                .arg(&resolution)
                .arg("-ac")
                .arg("-listen")
                .arg("tcp")
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
                                display_str = format!("127.0.0.1:{}", display_num);
                                println!("Xvfb started on display {}", display_str);
                            }
                            _ => eprintln!("Xvfb failed to output a display number"),
                        }
                    }
                    xvfb_process = Some(child);
                }
                Err(e) => eprintln!("Failed to spawn Xvfb: {}", e),
            }

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
                ("x265enc tune=zerolatency speed-preset=ultrafast ! video/x-h265,stream-format=byte-stream", "rtph265pay", "video/H265"),
                ("openh265enc ! video/x-h265,stream-format=byte-stream", "rtph265pay", "video/H265"),
                // H264 Fallbacks
                ("nvh264enc preset=low-latency-hp zerolatency=true", "rtph264pay", "video/H264"),
                ("vaapih264enc", "rtph264pay", "video/H264"),
                ("msdkh264enc", "rtph264pay", "video/H264"),
                ("v4l2h264enc", "rtph264pay", "video/H264"),
                ("mfh264enc low-latency=true", "rtph264pay", "video/H264"),
                ("d3d11h264enc", "rtph264pay", "video/H264"),
                ("amfh264enc", "rtph264pay", "video/H264"),
                ("x264enc tune=zerolatency speed-preset=ultrafast ! video/x-h264,stream-format=byte-stream", "rtph264pay", "video/H264"),
                ("openh264enc ! video/x-h264,stream-format=byte-stream", "rtph264pay", "video/H264"),
            ];

            let mut selected_mime_type = "video/H265".to_owned();

            for (encoder, payloader, mime_type) in encoders {
                let gst_pipeline_str = format!(
                    "ximagesrc display-name={} use-damage=false ! video/x-raw,framerate=30/1 ! queue ! videoconvert ! {} ! {} config-interval=1 ! queue ! appsink name=video_sink \
                     pulsesrc ! audio/x-raw,rate=48000,channels=2 ! queue ! opusenc ! rtpopuspay ! queue ! appsink name=audio_sink",
                    display_str, encoder, payloader
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
                            continue;
                        }
                        println!("Successfully started pipeline with encoder: {}", encoder);
                        gst_pipeline = Some(pipeline);
                        selected_mime_type = mime_type.to_owned();
                        break;
                    }
                    Err(e) => eprintln!("Failed to create GStreamer pipeline with encoder {}: {}", encoder, e),
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

            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "run-gui-start",
                "width": width,
                "height": height,
                "display": display_str
            });
            let json_str = serde_json::to_string(&payload).unwrap_or_default();
            println!("Sending GUI start message: {}", json_str);
            let _ = log_dc.send_text(json_str).await;

            run_cmd.env("DISPLAY", display_str);
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
