use std::sync::Arc;
use std::process::Stdio;
use std::env;

use anyhow::{Context, Result};
use futures::{FutureExt, StreamExt, SinkExt};
use serde::{Deserialize, Serialize};
use tempfile::tempdir;
use tokio::io::{AsyncBufReadExt, BufReader};
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
    #[serde(default)]
    files: Vec<FileEntry>,
}

#[tokio::main]
async fn main() -> Result<()> {
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

    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let store = compile_store.clone();
        async move {
            let label = dc.label();
            if label == "compile" {
                dc.on_message(Box::new(move |msg| {
                    let store = store.clone();
                    async move {
                        if msg.is_string {
                            println!("Received message on compile channel");
                            match serde_json::from_slice::<CompileRequest>(&msg.data) {
                                Ok(req) => {
                                    println!("Deserialized request for file: {}", req.filename);
                                    let log_dc = { store.lock().await.clone() };
                                    if let Some(log) = log_dc {
                                        println!("Spawning handle_compile");
                                        tokio::spawn(async move {
                                            if let Err(e) = handle_compile(req, log).await {
                                                eprintln!("Compilation task failed: {:?}", e);
                                            }
                                        });
                                    } else {
                                        println!("ERROR: Build log channel is not ready yet!");
                                    }
                                }
                                Err(e) => {
                                    println!("Failed to deserialize compile request: {}", e);
                                    if let Ok(s) = std::str::from_utf8(&msg.data) {
                                        println!("Raw message: {}", s);
                                    }
                                }
                            }
                        }
                    }
                    .boxed()
                }));
            } else if label == "build-log" {
                let mut guard = store.lock().await;
                *guard = Some(dc.clone());
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

async fn handle_compile(req: CompileRequest, log_dc: Arc<RTCDataChannel>) -> Result<()> {
    println!("handle_compile started for {}", req.filename);
    let dir = tempdir().context("failed to create temp dir")?;
    
    // Write the main file
    let file_path = dir.path().join(&req.filename);
    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&file_path, &req.source).await?;
    println!("Main file written to {:?}", file_path);

    // Write additional files
    for file in req.files {
        println!("Writing additional file: {}", file.name);
        let p = dir.path().join(&file.name);
        // Ensure parent directories exist if the file is in a subdirectory
        if let Some(parent) = p.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&p, file.content).await?;
    }

    let mut cmd = match req.language.as_str() {
        "cpp" => {
            let mut c = Command::new("g++");
            c.arg(&req.filename).arg("-I.").arg("-o").arg("main.out");
            c
        }
        "rust" => {
            let mut c = Command::new("rustc");
            c.arg(&req.filename).arg("-o").arg("main.out");
            c
        }
        "ts" => {
            let mut c = Command::new("tsc");
            c.arg(&req.filename);
            c
        }
        _ => return Ok(()),
    };
    cmd.current_dir(dir.path());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().map(BufReader::new);
    let stderr = child.stderr.take().map(BufReader::new);

    if let Some(out) = stdout {
        let dc = log_dc.clone();
        tokio::spawn(async move {
            let mut lines = out.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = dc.send_text(format!("stdout: {line}")).await;
            }
        });
    }

    if let Some(err) = stderr {
        let dc = log_dc.clone();
        tokio::spawn(async move {
            let mut lines = err.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = dc.send_text(format!("stderr: {line}")).await;
            }
        });
    }

    let compile_status = child.wait().await?;

    // If compile failed, send status and return
    if !compile_status.success() {
        let _ = log_dc
            .send_text(serde_json::to_string(&serde_json::json!({ "status": "done", "success": false, "stage": "compile", "code": compile_status.code() }))?)
            .await;
        return Ok(());
    }

    // Run the produced binary for C++ only (for now)
    if req.language == "cpp" {
        let bin_path = dir.path().join("main.out");
        let mut run_cmd = Command::new(bin_path);
        run_cmd.current_dir(dir.path());
        run_cmd.stdout(Stdio::piped());
        run_cmd.stderr(Stdio::piped());

        let mut run_child = run_cmd.spawn()?;
        let run_stdout = run_child.stdout.take().map(BufReader::new);
        let run_stderr = run_child.stderr.take().map(BufReader::new);

        if let Some(out) = run_stdout {
            let dc = log_dc.clone();
            tokio::spawn(async move {
                let mut lines = out.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = dc.send_text(format!("run stdout: {line}")).await;
                }
            });
        }

        if let Some(err) = run_stderr {
            let dc = log_dc.clone();
            tokio::spawn(async move {
                let mut lines = err.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = dc.send_text(format!("run stderr: {line}")).await;
                }
            });
        }

        let run_status = run_child.wait().await?;
        let _ = log_dc
            .send_text(serde_json::to_string(&serde_json::json!({
                "status": "done",
                "success": run_status.success(),
                "stage": "run",
                "code": run_status.code()
            }))?)
            .await;
        return Ok(());
    }

    let _ = log_dc
        .send_text(serde_json::to_string(&serde_json::json!({ "status": "done", "success": true, "stage": "compile" }))?)
        .await;

    Ok(())
}

async fn verify_tooling() -> Result<()> {
    for tool in REQUIRED_TOOLS {
        let status = Command::new(tool)
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
