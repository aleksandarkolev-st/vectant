use std::sync::Arc;
use std::process::Stdio;
use std::collections::HashMap;
use std::env;

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
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTPCodecType};
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use webrtc::rtp::packet::Packet;
use webrtc::util::marshal::Unmarshal;

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
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let store = compile_store.clone();
        let term_store = term_store.clone();
        let pc_for_callback = pc_clone.clone();
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
                    async move {
                        if msg.is_string {
                            // Try to parse as a CompileRequest
                            if let Ok(req) = serde_json::from_slice::<CompileRequest>(&msg.data) {
                                let log_dc = { store.lock().await.clone() };
                                if let Some(log) = log_dc {
                                    let ts = term_store_for_msg.clone();
                                    tokio::spawn(handle_compile(req, log, ts, pc_for_compile));
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

async fn handle_compile(req: CompileRequest, log_dc: Arc<RTCDataChannel>, terminal_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>, pc: Arc<RTCPeerConnection>) -> Result<()> {
    let dir = tempdir().context("failed to create temp dir")?;
    
    // Write the main file
    let file_path = dir.path().join(&req.filename);
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
            c.arg(&req.filename).arg("-I.").arg("-lX11").arg("-o").arg("main.out");
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
        let bin_path = dir.path().join("main.out");
        let mut run_cmd = Command::new(bin_path);
        run_cmd.current_dir(dir.path());
        // Ensure the runtime process has a piped stdin so we can forward
        // terminal input into it.
        run_cmd.stdin(Stdio::piped());
        run_cmd.stdout(Stdio::piped());
        run_cmd.stderr(Stdio::piped());

        let mut xvfb_process: Option<tokio::process::Child> = None;
        let mut gst_pipeline: Option<gst::Pipeline> = None;

        if req.is_gui {
            let mut display_str = String::new();
            let mut xvfb = Command::new("Xvfb");
            xvfb.arg("-displayfd").arg("1")
                .arg("-screen")
                .arg("0")
                .arg("1280x720x24")
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

            let gst_pipeline_str = format!(
                "ximagesrc display-name={} use-damage=false ! video/x-raw,framerate=30/1 ! queue ! videoconvert ! vp8enc deadline=1 ! rtpvp8pay ! queue ! appsink name=video_sink \
                 pulsesrc ! audio/x-raw,rate=48000,channels=2 ! queue ! opusenc ! rtpopuspay ! queue ! appsink name=audio_sink",
                display_str
            );

            match gst::parse_launch(&gst_pipeline_str) {
                Ok(pipeline) => {
                    let pipeline = pipeline.downcast::<gst::Pipeline>().expect("Expected pipeline");
                    
                    if let Ok(video_sink) = pipeline.by_name("video_sink").context("Sink not found").and_then(|s| s.downcast::<gst_app::AppSink>().map_err(|_| anyhow::anyhow!("Expected AppSink"))) {
                        video_sink.set_callbacks(
                            gst_app::AppSinkCallbacks::builder()
                                .new_sample(move |sink| {
                                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                                    let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                                    let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                                    let _ = v_tx.send(map.to_vec());
                                    Ok(gst::FlowSuccess::Ok)
                                })
                                .build()
                        );
                    }

                    if let Ok(audio_sink) = pipeline.by_name("audio_sink").context("Sink not found").and_then(|s| s.downcast::<gst_app::AppSink>().map_err(|_| anyhow::anyhow!("Expected AppSink"))) {
                        audio_sink.set_callbacks(
                            gst_app::AppSinkCallbacks::builder()
                                .new_sample(move |sink| {
                                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                                    let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                                    let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                                    let _ = a_tx.send(map.to_vec());
                                    Ok(gst::FlowSuccess::Ok)
                                })
                                .build()
                        );
                    }

                    if let Err(e) = pipeline.set_state(gst::State::Playing) {
                        eprintln!("Failed to set pipeline to playing: {}", e);
                    }
                    gst_pipeline = Some(pipeline);
                }
                Err(e) => eprintln!("Failed to create GStreamer pipeline: {}", e),
            }

            let video_track = Arc::new(TrackLocalStaticRTP::new(
                RTCRtpCodecCapability { mime_type: "video/vp8".to_owned(), ..Default::default() },
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
                while let Some(mut buf) = v_rx.recv().await {
                    if let Ok(packet) = Packet::unmarshal(&mut &buf[..]) {
                        let _ = v_track_clone.write_rtp(&packet).await;
                    }
                }
            });

            let a_track_clone = audio_track.clone();
            tokio::spawn(async move {
                while let Some(mut buf) = a_rx.recv().await {
                    if let Ok(packet) = Packet::unmarshal(&mut &buf[..]) {
                        let _ = a_track_clone.write_rtp(&packet).await;
                    }
                }
            });

            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "run-gui-start",
                "width": 1280,
                "height": 720,
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
