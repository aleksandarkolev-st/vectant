use anyhow::{Context, Result};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use webrtc::rtp::packet::Packet;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTPCodecType};
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};
use webrtc::util::Unmarshal;

use crate::compiler::builder::ModuleHashes;
use crate::compiler::context::CompileContext;
use crate::infra::constants::GUI_TOOLS;
use crate::infra::messages::CompileRequest;
use crate::infra::observability::{LogEntry, LogLevel, ReloadId, ReloadMetricsTracker};
use crate::infra::utils::system_command;
use crate::runtime::capability::{detect_capabilities, HmrStatus as CapabilityHmrStatus};
use crate::runtime::runner_state::RunnerState; // Aliasing if needed, or check definition

pub async fn handle_runner_execution(
    ctx: &CompileContext,
    req: &CompileRequest,
    modules_to_load: Vec<(String, String)>,
    has_on_update: bool,
    use_ai_split: bool,
    new_hashes: ModuleHashes,
    core_lib_path: String,
    gui_lib_path: String,
    timestamp: i64,
    compile_start: std::time::Instant,
    reload_id: ReloadId,
    module_id: String,
    session_id: Option<String>,
) -> Result<()> {
    // Unified Runner Logic
    if modules_to_load.is_empty() {
        return Ok(());
    }

    let mut guard = ctx.runner_store.lock().await;

    // Check if we need to restart due to GUI mode change or blocking app
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
    if !existing_runner_can_hmr && guard.is_none() {
        // Start runner
        println!("Starting persistent runner...");

        let mut wsl_display_str = reused_wsl_display;
        let mut gst_display_str = reused_gst_display;
        let mut xvfb_process: Option<tokio::process::Child> = reused_xvfb;
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
                        let _ = ctx
                            .log_dc
                            .send_text(serde_json::to_string(&payload).unwrap_or_default())
                            .await;
                        return Ok(());
                    }
                }

                // Start Xvfb (Virtual Framebuffer)
                // Try finding a free display or use separate ones per worker?
                // For simplified single-worker model, we can use :99
                let display_num = 99;

                // [Fix] Clean up stale lock files from previous runs
                let lock_file = format!("/tmp/.X11-unix/X{}", display_num);
                if std::path::Path::new(&lock_file).exists() {
                    println!("Removing stale Xvfb lock file: {}", lock_file);
                    let _ = std::fs::remove_file(&lock_file);
                }
                let lock_file_tmp = format!("/tmp/.X{}-lock", display_num);
                if std::path::Path::new(&lock_file_tmp).exists() {
                    println!("Removing stale Xvfb lock file: {}", lock_file_tmp);
                    let _ = std::fs::remove_file(&lock_file_tmp);
                }

                wsl_display_str = format!(":{}", display_num);
                gst_display_str = wsl_display_str.clone();

                println!("Starting Xvfb on display {}", wsl_display_str);

                let mut xvfb_cmd = Command::new("Xvfb");
                xvfb_cmd
                    .arg(&wsl_display_str)
                    .arg("-screen")
                    .arg("0")
                    .arg(format!("{}x{}x24", width, height))
                    .arg("-ac"); // Disable access control

                xvfb_cmd.kill_on_drop(true);
                let child = xvfb_cmd.spawn().context("Failed to spawn Xvfb")?;
                xvfb_process = Some(child);

                // Give Xvfb a moment to start
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                // Start Matchbox Window Manager (to handle window sizing/borders)
                let mut wm_cmd = Command::new("matchbox-window-manager");
                wm_cmd.env("DISPLAY", &wsl_display_str);
                wm_cmd.kill_on_drop(true);
                // We don't keep the WM handle, assuming it dies when Xvfb dies or worker dies
                let _ = wm_cmd
                    .spawn()
                    .context("Failed to spawn matchbox-window-manager")?;

                println!("Xvfb and Window Manager started.");
            }

            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

            // Start GStreamer Pipeline
            let encoders = [
                ("nvh264enc preset=low-latency-hp zerolatency=true", "rtph264pay", "video/H264"),
                ("vaapih264enc", "rtph264pay", "video/H264"),
                ("x264enc tune=zerolatency speed-preset=ultrafast bitrate=2000 key-int-max=60 ! video/x-h264,stream-format=byte-stream", "rtph264pay", "video/H264"),
                ("vp8enc deadline=1 cpu-used=4 end-usage=cbr target-bitrate=2000000", "rtpvp8pay", "video/VP8"),
            ];

            let mut selected_mime_type = "video/H264".to_owned();
            let mut encoder_idx = 0;
            let mut pipeline = None;
            let width = req_width;
            let height = req_height;

            while encoder_idx < encoders.len() {
                let (encoder, payloader, mime_type) = encoders[encoder_idx];
                println!("Trying encoder: {}", encoder);

                // ximagesrc -> videoscale -> videoconvert -> encoder -> payloader -> appsink
                // audiotestsrc (silence) -> opusenc -> rtpopuspay -> appsink
                // We use audiotestsrc instead of pulsesrc to be robust in headless environments

                let pipeline_str = format!(
                    "ximagesrc display-name=\"{}\" use-damage=0 ! video/x-raw,framerate=30/1 ! videoscale ! videoconvert ! {} ! {} name=video_pay ! appsink name=video_sink sync=false \
                     audiotestsrc is-live=true wave=silence ! opusenc ! rtpopuspay name=audio_pay ! appsink name=audio_sink sync=false",
                     gst_display_str, encoder, payloader
                );

                match gst::parse_launch(&pipeline_str) {
                    Ok(p) => {
                        if let Ok(pipe) = p.dynamic_cast::<gst::Pipeline>() {
                            match pipe.set_state(gst::State::Playing) {
                                Ok(_) => {
                                    // Check if it actually runs for a bit?
                                    // ideally we wait for state change success
                                    let bus = pipe.bus().unwrap();
                                    // wait up to 0.5s for error
                                    if let Some(msg) =
                                        bus.timed_pop(gst::ClockTime::from_mseconds(500))
                                    {
                                        if let gst::MessageView::Error(err) = msg.view() {
                                            println!("Encoder {} failed: {}", encoder, err.error());
                                            let _ = pipe.set_state(gst::State::Null);
                                        } else {
                                            println!("Encoder {} started successfully.", encoder);
                                            pipeline = Some(pipe);
                                            selected_mime_type = mime_type.to_string();
                                            break;
                                        }
                                    } else {
                                        println!(
                                            "Encoder {} started successfully (no immediate error).",
                                            encoder
                                        );
                                        pipeline = Some(pipe);
                                        selected_mime_type = mime_type.to_string();
                                        break;
                                    }
                                }
                                Err(err) => {
                                    println!(
                                        "Failed to set state for encoder {}: {}",
                                        encoder, err
                                    );
                                }
                            }
                        }
                    }
                    Err(err) => {
                        println!("Failed to parse pipeline with {}: {}", encoder, err);
                    }
                }
                encoder_idx += 1;
            }

            if pipeline.is_none() {
                let msg = "Error: Failed to initialize any video encoder. Please check GStreamer installation.";
                let payload = serde_json::json!({
                   "sessionId": session_id.clone(),
                   "type": "stderr",
                   "line": msg
                });
                let _ = ctx
                    .log_dc
                    .send_text(serde_json::to_string(&payload).unwrap_or_default())
                    .await;
                return Ok(());
            }

            let (v_tx, mut v_rx) = mpsc::unbounded_channel::<Vec<u8>>();
            let (a_tx, mut a_rx) = mpsc::unbounded_channel::<Vec<u8>>();

            gst_pipeline = pipeline;
            let pipeline_ref = gst_pipeline.as_ref().unwrap();

            // Get AppSinks
            let video_sink = pipeline_ref
                .by_name("video_sink")
                .unwrap()
                .dynamic_cast::<gst_app::AppSink>()
                .unwrap();
            let audio_sink = pipeline_ref
                .by_name("audio_sink")
                .unwrap()
                .dynamic_cast::<gst_app::AppSink>()
                .unwrap();

            // Setup Video Track
            let mime = selected_mime_type.clone();
            let video_track = Arc::new(TrackLocalStaticRTP::new(
                RTCRtpCodecCapability {
                    mime_type: mime,
                    ..Default::default()
                },
                "video".to_owned(),
                "synthi_stream".to_owned(),
            ));
            video_track_opt = Some(video_track.clone());

            let v_tx_clone = v_tx.clone();
            video_sink.set_callbacks(
                gst_app::AppSinkCallbacks::builder()
                    .new_sample(move |sink| match sink.pull_sample() {
                        Ok(sample) => {
                            if let Some(buffer) = sample.buffer() {
                                if let Ok(map) = buffer.map_readable() {
                                    let data = map.as_slice().to_vec();
                                    let _ = v_tx_clone.send(data);
                                }
                            }
                            Ok(gst::FlowSuccess::Ok)
                        }
                        Err(_) => Err(gst::FlowError::Eos),
                    })
                    .build(),
            );

            // Spawn async task to write video RTP packets
            let v_track_clone = video_track.clone();
            tokio::spawn(async move {
                while let Some(data) = v_rx.recv().await {
                    if let Err(e) = v_track_clone.write(&data).await {
                        if e.to_string().contains("closed") {
                            break;
                        }
                        eprintln!("RTP write error: {}", e);
                    }
                }
            });

            // Setup Audio Track
            let audio_track = Arc::new(TrackLocalStaticRTP::new(
                RTCRtpCodecCapability {
                    mime_type: "audio/opus".to_owned(),
                    ..Default::default()
                },
                "audio".to_owned(),
                "synthi_stream".to_owned(),
            ));
            audio_track_opt = Some(audio_track.clone());

            let a_tx_clone = a_tx.clone();
            audio_sink.set_callbacks(
                gst_app::AppSinkCallbacks::builder()
                    .new_sample(move |sink| match sink.pull_sample() {
                        Ok(sample) => {
                            if let Some(buffer) = sample.buffer() {
                                if let Ok(map) = buffer.map_readable() {
                                    let data = map.as_slice().to_vec();
                                    let _ = a_tx_clone.send(data);
                                }
                            }
                            Ok(gst::FlowSuccess::Ok)
                        }
                        Err(_) => Err(gst::FlowError::Eos),
                    })
                    .build(),
            );

            // Spawn async task to write audio RTP packets
            let a_track_clone = audio_track.clone();
            tokio::spawn(async move {
                while let Some(data) = a_rx.recv().await {
                    if let Err(e) = a_track_clone.write(&data).await {
                        if e.to_string().contains("closed") {
                            break;
                        }
                    }
                }
            });
        }

        // Spawn Runner Process
        let runner_path = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("runner")))
            .unwrap_or_else(|| std::path::PathBuf::from("runner"));

        println!("Spawning runner: {:?}", runner_path);

        let mut cmd = Command::new(runner_path);
        cmd.env("DISPLAY", &wsl_display_str)
            .env(
                "LD_LIBRARY_PATH",
                std::env::var("LD_LIBRARY_PATH").unwrap_or_default(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(sid) = &session_id {
            cmd.env("SYNTHI_SESSION_ID", sid);
        }

        let mut child = cmd.spawn().context("Failed to spawn runner process")?;

        // Capture stdout/stderr
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let stdin = child.stdin.take().unwrap();

        let (log_tx, _) = tokio::sync::broadcast::channel::<String>(100);
        let log_tx_clone = log_tx.clone();

        // Forward stdout/stderr to log_dc
        let ctx_clone = ctx.clone();
        let session_id_clone = session_id.clone();

        // Stdout Reader
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(line) = reader.next_line().await {
                match line {
                    Some(l) => {
                        let _ = log_tx_clone.send(l.clone());
                        // Send to frontend
                        let payload = serde_json::json!({
                           "sessionId": session_id_clone,
                           "type": "stdout",
                           "line": l
                        });
                        let _ = ctx_clone
                            .log_dc
                            .send_text(serde_json::to_string(&payload).unwrap_or_default())
                            .await;
                    }
                    None => break,
                }
            }
        });

        let ctx_clone2 = ctx.clone();
        let session_id_clone2 = session_id.clone();
        let log_tx_clone2 = log_tx.clone();

        // Stderr Reader
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(line) = reader.next_line().await {
                match line {
                    Some(l) => {
                        eprintln!("[Runner Stderr] {}", l);
                        let _ = log_tx_clone2.send(l.clone());
                        // Send to frontend
                        let payload = serde_json::json!({
                           "sessionId": session_id_clone2,
                           "type": "stderr",
                           "line": l
                        });
                        let _ = ctx_clone2
                            .log_dc
                            .send_text(serde_json::to_string(&payload).unwrap_or_default())
                            .await;
                    }
                    None => break,
                }
            }
        });

        *guard = Some(RunnerState {
            process: Some(child),
            stdin: Some(stdin),
            output_tx: log_tx,
            is_gui: req.is_gui,
            is_hmr_capable: has_on_update,
            hmr_capability: None,
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
            loaded_widget_paths: HashMap::new(),
            widget_hashes: HashMap::new(),
        });
    }

    if let Some(state) = guard.as_mut() {
        if !existing_runner_can_hmr {
            if let Some(track) = &state.video_track {
                println!("[Main] Adding video track to PeerConnection");
                let _ = ctx
                    .pc
                    .add_track(Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>)
                    .await?;
            }
            if let Some(track) = &state.audio_track {
                println!("[Main] Adding audio track to PeerConnection");
                let _ = ctx
                    .pc
                    .add_track(Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>)
                    .await?;
            }
        }

        // Load Modules
        for (name, path) in &modules_to_load {
            // Check if process is still alive
            if let Some(child) = state.process.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    eprintln!("[Main] Runner process has already exited with status: {}", status);
                    break;
                }
            }

            if let Some(stdin) = state.stdin.as_mut() {
                let cmd = format!("load {} {}\n", name, path);
                println!("[Main] Sending command to runner: {}", cmd.trim());
                if let Err(e) = stdin.write_all(cmd.as_bytes()).await {
                    eprintln!("Failed to write to runner stdin: {}", e);
                }
                if let Err(e) = stdin.flush().await {
                    eprintln!("Failed to flush runner stdin: {}", e);
                }
                // Give it a moment to load
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            }
        }

        // Update RunnerState
        state.module_hashes = new_hashes;
        if !core_lib_path.is_empty() {
            state.loaded_core_path = Some(core_lib_path.clone());
        }
        if !gui_lib_path.is_empty() {
            state.loaded_gui_path = Some(gui_lib_path.clone());
        }
    }

    // Send Status Updates
    // ...

    Ok(())
}
