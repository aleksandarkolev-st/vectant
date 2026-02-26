use anyhow::{Context, Result};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

use crate::compiler::builder::ModuleHashes;
use crate::compiler::context::CompileContext;
use crate::infra::constants::GUI_TOOLS;
use crate::infra::messages::CompileRequest;
use crate::runtime::runner_state::RunnerState;

/// Run a compiled Java program as a child process.
///
/// For GUI apps (`req.is_gui`): reuses or creates Xvfb + GStreamer, sets DISPLAY,
/// streams video via WebRTC.  For console apps: pipes stdout/stderr to the data channel.
///
/// On re-run (HMR substitute): kills the old JVM, reuses Xvfb/GStreamer pipeline,
/// spawns a new JVM.
pub async fn run_java(
    ctx: &CompileContext,
    req: &CompileRequest,
    classes_dir: &Path,
    main_class: &str,
    session_id: &str,
) -> Result<()> {
    let req_width = req.width.unwrap_or(800);
    let req_height = req.height.unwrap_or(600);

    let mut guard = ctx.runner_store.lock().await;

    // ── Tear down previous process, reuse Xvfb/GStreamer ──────────
    let mut reused_xvfb: Option<tokio::process::Child> = None;
    let mut reused_pipeline: Option<gst::Pipeline> = None;
    let mut reused_wsl_display = String::new();
    let mut reused_gst_display = String::new();
    let mut video_track_opt: Option<Arc<TrackLocalStaticRTP>> = None;
    let mut audio_track_opt: Option<Arc<TrackLocalStaticRTP>> = None;

    if let Some(state) = guard.as_mut() {
        let can_reuse =
            state.is_gui == req.is_gui && state.width == req_width && state.height == req_height;

        let state = guard.take().unwrap();

        // Kill old JVM / runner process
        if let Some(mut child) = state.process {
            eprintln!("[JavaRunner] Killing previous process...");
            let _ = child.kill().await;
        }

        if can_reuse {
            eprintln!("[JavaRunner] Reusing Xvfb and GStreamer pipeline");
            reused_xvfb = state.xvfb_process;
            reused_pipeline = state.gst_pipeline;
            reused_wsl_display = state.wsl_display_str;
            reused_gst_display = state.gst_display_str;
            video_track_opt = state.video_track;
            audio_track_opt = state.audio_track;
        } else {
            eprintln!("[JavaRunner] Full teardown (mode/resolution changed)");
            if let Some(pipeline) = state.gst_pipeline {
                let _ = pipeline.set_state(gst::State::Null);
            }
            if let Some(mut xvfb) = state.xvfb_process {
                let _ = xvfb.kill().await;
            }
        }
    }

    // ── Xvfb + GStreamer setup (GUI only) ─────────────────────────
    let mut wsl_display_str = reused_wsl_display;
    let mut gst_display_str = reused_gst_display;
    let mut xvfb_process: Option<tokio::process::Child> = reused_xvfb;
    let mut gst_pipeline: Option<gst::Pipeline> = reused_pipeline;

    if req.is_gui {
        // Start Xvfb if not reused
        if xvfb_process.is_none() {
            xvfb_process = Some(start_xvfb(ctx, session_id, req_width, req_height).await?);
            wsl_display_str = ":99".to_string();
            gst_display_str = wsl_display_str.clone();
        }

        // Start GStreamer if not reused
        if gst_pipeline.is_none() {
            let (pipeline, v_track, a_track) =
                start_gstreamer(&gst_display_str, session_id).await?;
            gst_pipeline = Some(pipeline);
            video_track_opt = Some(v_track);
            audio_track_opt = Some(a_track);
        }
    }

    // ── Build `java` command ──────────────────────────────────────
    let source_content = &req.source;
    let needs_javafx =
        source_content.contains("javafx.") || source_content.contains("import javafx");

    let mut cmd = crate::infra::utils::system_command("java");
    cmd.arg("-cp").arg(classes_dir);

    if needs_javafx {
        let javafx_lib = Path::new("/usr/share/openjfx/lib");
        if javafx_lib.exists() {
            cmd.arg("--module-path")
                .arg(javafx_lib)
                .arg("--add-modules")
                .arg("javafx.controls,javafx.fxml,javafx.swing,javafx.media");
        }
    }

    cmd.arg(main_class);

    if req.is_gui {
        cmd.env("DISPLAY", &wsl_display_str);
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    eprintln!(
        "[JavaRunner] Spawning: java -cp {:?} {} (GUI={})",
        classes_dir, main_class, req.is_gui
    );

    let mut child = cmd.spawn().context("Failed to spawn java — is openjdk installed?")?;

    // ── Capture I/O ───────────────────────────────────────────────
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take().unwrap()));

    let (log_tx, _) = tokio::sync::broadcast::channel::<String>(100);
    let log_tx_stdout = log_tx.clone();
    let log_tx_stderr = log_tx.clone();

    // Stdout → data channel
    let ctx_out = ctx.clone();
    let sid_out = session_id.to_string();
    let stdout_handle = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = log_tx_stdout.send(line.clone());
            let payload = serde_json::json!({
                "sessionId": sid_out,
                "type": "stdout",
                "line": line,
            });
            let _ = ctx_out
                .log_dc
                .send_text(serde_json::to_string(&payload).unwrap_or_default())
                .await;
        }
    });

    // Stderr → data channel
    let ctx_err = ctx.clone();
    let sid_err = session_id.to_string();
    let stderr_handle = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            eprintln!("[JavaRunner stderr] {}", line);
            let _ = log_tx_stderr.send(line.clone());
            let payload = serde_json::json!({
                "sessionId": sid_err,
                "type": "stderr",
                "line": line,
            });
            let _ = ctx_err
                .log_dc
                .send_text(serde_json::to_string(&payload).unwrap_or_default())
                .await;
        }
    });

    // ── Store RunnerState ─────────────────────────────────────────
    *guard = Some(RunnerState {
        process: Some(child),
        stdin: Some(stdin.clone()),
        output_tx: log_tx,
        is_gui: req.is_gui,
        is_hmr_capable: false, // Java doesn't support in-process HMR
        hmr_capability: None,
        xvfb_process,
        gst_pipeline,
        sdl_tx: None,
        video_track: video_track_opt.clone(),
        audio_track: audio_track_opt.clone(),
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

    // ── Stdin input channel for GUI apps ──────────────────────────
    if req.is_gui {
        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<String>();

        if let Some(state) = guard.as_mut() {
            state.sdl_tx = Some(input_tx.clone());
        }

        // Register in sdl_input_store so the input handler routes events here
        {
            let mut sdl_guard = ctx.sdl_input_store.lock().await;
            sdl_guard.insert(session_id.to_string(), input_tx);
        }

        // For Java GUI: use xdotool for input injection instead of runner stdin.
        // The xdotool path converts events to X11 input which AWT/Swing consumes.
        let display_for_input = guard
            .as_ref()
            .map(|s| s.wsl_display_str.clone())
            .unwrap_or_else(|| ":99".to_string());
        tokio::spawn(async move {
            while let Some(cmd) = input_rx.recv().await {
                // Parse the input command and convert to xdotool invocations
                // The frontend sends commands like "input mouse_move 100 200"
                // or "input mouse_down 1" — we convert these to xdotool calls.
                for line in cmd.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    // Forward raw input lines to xdotool
                    // Expected format from frontend: "input <type> <args>"
                    if let Some(rest) = line.strip_prefix("input ") {
                        let parts: Vec<&str> = rest.split_whitespace().collect();
                        if parts.is_empty() {
                            continue;
                        }
                        let mut xdo = tokio::process::Command::new("xdotool");
                        xdo.env("DISPLAY", &display_for_input);
                        match parts[0] {
                            "mouse_move" if parts.len() >= 3 => {
                                xdo.arg("mousemove")
                                    .arg("--screen").arg("0")
                                    .arg(parts[1]).arg(parts[2]);
                            }
                            "mouse_down" if parts.len() >= 2 => {
                                xdo.arg("mousedown").arg(parts[1]);
                            }
                            "mouse_up" if parts.len() >= 2 => {
                                xdo.arg("mouseup").arg(parts[1]);
                            }
                            "key_press" if parts.len() >= 2 => {
                                xdo.arg("key").arg(parts[1]);
                            }
                            "key_down" if parts.len() >= 2 => {
                                xdo.arg("keydown").arg(parts[1]);
                            }
                            "key_up" if parts.len() >= 2 => {
                                xdo.arg("keyup").arg(parts[1]);
                            }
                            _ => {
                                // Pass through as raw xdotool args
                                for p in &parts {
                                    xdo.arg(p);
                                }
                            }
                        }
                        xdo.stdout(Stdio::null()).stderr(Stdio::null());
                        let _ = xdo.spawn();
                    }
                }
            }
            eprintln!("[JavaRunner] Input channel closed");
        });
    }

    // ── Attach video/audio tracks to WebRTC transceivers ──────────
    if req.is_gui {
        if let Some(state) = guard.as_ref() {
            let transceivers = ctx.pc.get_transceivers().await;
            if let Some(track) = &state.video_track {
                for t in &transceivers {
                    if t.kind() == webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Video {
                        let _ = t
                            .sender()
                            .await
                            .replace_track(Some(
                                Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>,
                            ))
                            .await;
                        break;
                    }
                }
            }
            if let Some(track) = &state.audio_track {
                for t in &transceivers {
                    if t.kind() == webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Audio {
                        let _ = t
                            .sender()
                            .await
                            .replace_track(Some(
                                Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>,
                            ))
                            .await;
                        break;
                    }
                }
            }

            // Signal frontend to show GUI widget
            let gui_start = serde_json::json!({
                "type": "run-gui-start",
                "sessionId": session_id,
                "width": state.width,
                "height": state.height,
            });
            let _ = ctx.log_dc.send_text(gui_start.to_string()).await;
        }
    }

    // ── For console apps, wait for the process output before "done" ──
    // GUI apps run indefinitely, so we send "done" right away.
    // Console apps finish quickly; we must wait for stdout/stderr to
    // flush so the frontend receives all output before unsubscribing.
    if !req.is_gui {
        // Release the mutex so the I/O tasks can proceed unblocked
        drop(guard);

        // Wait for stdout and stderr reader tasks to finish
        // (they end when the JVM closes its pipes, i.e. on exit)
        let _ = stdout_handle.await;
        let _ = stderr_handle.await;

        eprintln!("[JavaRunner] Console process finished, sending done");
    }

    // ── Send build-status "done" ──────────────────────────────────
    let done = serde_json::json!({
        "sessionId": session_id,
        "status": "done",
        "success": true,
        "stage": "runner_java",
    });
    let _ = ctx
        .log_dc
        .send_text(serde_json::to_string(&done).unwrap_or_default())
        .await;

    Ok(())
}

// ════════════════════════════════════════════════════════════════
// PRIVATE HELPERS — Xvfb & GStreamer bootstrap
// ════════════════════════════════════════════════════════════════
// These are extracted verbatim from the C++ runner.rs logic so
// that both pipelines share identical Xvfb/GStreamer behaviour.
// ════════════════════════════════════════════════════════════════

async fn start_xvfb(
    ctx: &CompileContext,
    session_id: &str,
    width: u32,
    height: u32,
) -> Result<tokio::process::Child> {
    for tool in GUI_TOOLS {
        if Command::new(tool).arg("--version").output().await.is_err() {
            let msg = format!(
                "Error: GUI tool '{}' is missing. Java GUI apps require Xvfb and matchbox-window-manager.\n",
                tool
            );
            let payload = serde_json::json!({
                "sessionId": session_id,
                "type": "stderr",
                "line": msg,
            });
            let _ = ctx
                .log_dc
                .send_text(serde_json::to_string(&payload).unwrap_or_default())
                .await;
            anyhow::bail!("Missing GUI tool: {}", tool);
        }
    }

    let display_num = 99;

    // Clean up stale lock files
    for path in &[
        format!("/tmp/.X11-unix/X{}", display_num),
        format!("/tmp/.X{}-lock", display_num),
    ] {
        if std::path::Path::new(path).exists() {
            let _ = std::fs::remove_file(path);
        }
    }

    let mut xvfb_cmd = Command::new("Xvfb");
    xvfb_cmd
        .arg(format!(":{}", display_num))
        .arg("-screen")
        .arg("0")
        .arg(format!("{}x{}x24", width, height))
        .arg("-ac")
        .kill_on_drop(true);

    let child = xvfb_cmd.spawn().context("Failed to spawn Xvfb")?;
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    // Start Window Manager
    let mut wm_cmd = Command::new("matchbox-window-manager");
    wm_cmd
        .arg("-use_titlebar")
        .arg("no")
        .arg("-use_cursor")
        .arg("no")
        .env("DISPLAY", format!(":{}", display_num));
    // WM must outlive this scope — intentionally not setting kill_on_drop
    let _wm = wm_cmd.spawn().context("Failed to spawn matchbox-window-manager")?;

    tokio::time::sleep(tokio::time::Duration::from_millis(700)).await;

    eprintln!("[JavaRunner] Xvfb + WM started on :{}", display_num);
    Ok(child)
}

async fn start_gstreamer(
    display: &str,
    _session_id: &str,
) -> Result<(gst::Pipeline, Arc<TrackLocalStaticRTP>, Arc<TrackLocalStaticRTP>)> {
    let encoders = [
        ("nvh264enc preset=low-latency-hp zerolatency=true", "rtph264pay", "video/H264"),
        ("vaapih264enc", "rtph264pay", "video/H264"),
        ("x264enc tune=zerolatency speed-preset=ultrafast bitrate=2000 key-int-max=60 ! video/x-h264,stream-format=byte-stream", "rtph264pay", "video/H264"),
        ("vp8enc deadline=1 cpu-used=4 end-usage=cbr target-bitrate=2000000", "rtpvp8pay", "video/VP8"),
    ];

    let mut pipeline_opt: Option<gst::Pipeline> = None;
    let mut selected_mime = "video/H264".to_string();

    for (encoder, payloader, mime) in &encoders {
        let pipeline_str = format!(
            "ximagesrc display-name=\"{}\" use-damage=0 ! video/x-raw,framerate=30/1 ! videoscale ! videoconvert ! {} ! {} name=video_pay ! appsink name=video_sink sync=false \
             audiotestsrc is-live=true wave=silence ! opusenc ! rtpopuspay name=audio_pay ! appsink name=audio_sink sync=false",
            display, encoder, payloader
        );

        if let Ok(elem) = gst::parse_launch(&pipeline_str) {
            if let Ok(pipe) = elem.dynamic_cast::<gst::Pipeline>() {
                if pipe.set_state(gst::State::Playing).is_ok() {
                    let bus = pipe.bus().unwrap();
                    if let Some(msg) = bus.timed_pop(gst::ClockTime::from_mseconds(500)) {
                        if let gst::MessageView::Error(err) = msg.view() {
                            eprintln!("[JavaRunner] Encoder {} failed: {}", encoder, err.error());
                            let _ = pipe.set_state(gst::State::Null);
                            continue;
                        }
                    }
                    eprintln!("[JavaRunner] Encoder {} started", encoder);
                    pipeline_opt = Some(pipe);
                    selected_mime = mime.to_string();
                    break;
                }
            }
        }
    }

    let pipeline = pipeline_opt
        .ok_or_else(|| anyhow::anyhow!("Failed to init any GStreamer video encoder"))?;

    // Video track
    let video_sink = pipeline
        .by_name("video_sink")
        .unwrap()
        .dynamic_cast::<gst_app::AppSink>()
        .unwrap();
    let audio_sink = pipeline
        .by_name("audio_sink")
        .unwrap()
        .dynamic_cast::<gst_app::AppSink>()
        .unwrap();

    let video_track = Arc::new(TrackLocalStaticRTP::new(
        RTCRtpCodecCapability {
            mime_type: selected_mime,
            ..Default::default()
        },
        "video".to_owned(),
        "synthi_stream".to_owned(),
    ));

    let (v_tx, mut v_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let v_tx_clone = v_tx.clone();
    video_sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| match sink.pull_sample() {
                Ok(sample) => {
                    if let Some(buf) = sample.buffer() {
                        if let Ok(map) = buf.map_readable() {
                            let _ = v_tx_clone.send(map.as_slice().to_vec());
                        }
                    }
                    Ok(gst::FlowSuccess::Ok)
                }
                Err(_) => Err(gst::FlowError::Eos),
            })
            .build(),
    );

    let vt = video_track.clone();
    tokio::spawn(async move {
        while let Some(data) = v_rx.recv().await {
            if let Err(e) = vt.write(&data).await {
                if e.to_string().contains("closed") {
                    break;
                }
            }
        }
    });

    // Audio track
    let audio_track = Arc::new(TrackLocalStaticRTP::new(
        RTCRtpCodecCapability {
            mime_type: "audio/opus".to_owned(),
            ..Default::default()
        },
        "audio".to_owned(),
        "synthi_stream".to_owned(),
    ));

    let (a_tx, mut a_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let a_tx_clone = a_tx.clone();
    audio_sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| match sink.pull_sample() {
                Ok(sample) => {
                    if let Some(buf) = sample.buffer() {
                        if let Ok(map) = buf.map_readable() {
                            let _ = a_tx_clone.send(map.as_slice().to_vec());
                        }
                    }
                    Ok(gst::FlowSuccess::Ok)
                }
                Err(_) => Err(gst::FlowError::Eos),
            })
            .build(),
    );

    let at = audio_track.clone();
    tokio::spawn(async move {
        while let Some(data) = a_rx.recv().await {
            if let Err(e) = at.write(&data).await {
                if e.to_string().contains("closed") {
                    break;
                }
            }
        }
    });

    Ok((pipeline, video_track, audio_track))
}
