use anyhow::{Context, Result};
use crate::debug_log;
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use std::collections::HashMap;
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
use crate::runtime::runner_state::RunnerState; // Aliasing if needed, or check definition

fn extract_structured_runner_message(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Some(trimmed);
    }

    const PREFIX: &str = "[Runner] [HMR-STATUS] ";
    line.find(PREFIX).map(|idx| &line[idx + PREFIX.len()..])
}

pub async fn handle_runner_execution(
    ctx: &CompileContext,
    req: &CompileRequest,
    modules_to_load: Vec<(String, String)>,
    has_on_update: bool,
    use_ai_split: bool,
    new_hashes: ModuleHashes,
    core_lib_path: String,
    gui_lib_path: String,
    session_id: Option<String>,
    // ULTRAPLAN Lightning Phase 12 — when Some, spawn the AI-generated
    // per-project host_runner_<ts> binary instead of the shipped
    // target/debug/runner. The per-project binary owns window/renderer
    // lifecycle, dlopens libcore.so/libgui.so itself, and runs its own
    // main loop. Worker still manages Xvfb + GStreamer + WebRTC around
    // it (frame capture via ximagesrc on DISPLAY=:99 is unchanged).
    host_runner_bin_path: Option<String>,
) -> Result<()> {
    // Unified Runner Logic
    if modules_to_load.is_empty() {
        // Nothing to load — still resolve the frontend's compile() promise.
        let done_payload = serde_json::json!({
            "sessionId": session_id,
            "status": "done",
            "success": true,
            "stage": "runner",
        });
        let _ = ctx
            .log_dc
            .send_text(serde_json::to_string(&done_payload).unwrap_or_default())
            .await;
        return Ok(());
    }

    let mut guard = ctx.runner_store.lock().await;

    // ULTRAPLAN Lightning Phase 12 — hoisted so both the spawn block
    // and the later stdin-command block can branch on it without
    // re-resolving `host_runner_bin_path`. The spawn block uses it to
    // pick the binary + cwd; the stdin block uses it to skip the
    // `set_session`/`load` protocol that the per-project runner does
    // not speak.
    let use_per_project_runner = host_runner_bin_path.is_some();

    let req_width = req.width.unwrap_or(800);
    let req_height = req.height.unwrap_or(600);

    debug_log!(
        "[Main] Restart check: is_gui={}, has_on_update={}, use_ai_split={}",
        req.is_gui, has_on_update, use_ai_split
    );

    // Reuse Xvfb/GStreamer if possible
    let mut reused_xvfb: Option<tokio::process::Child> = None;
    let mut reused_pipeline: Option<gst::Pipeline> = None;
    let mut reused_wsl_display = String::new();
    let mut reused_gst_display = String::new();
    let mut reused_sdl_tx: Option<mpsc::UnboundedSender<String>> = None;
    let mut video_track_opt: Option<Arc<TrackLocalStaticRTP>> = None;
    let mut audio_track_opt: Option<Arc<TrackLocalStaticRTP>> = None;

    // Determine if we have an existing runner that can handle HMR.
    // The runner process supports hot-loading modules via stdin `load`
    // commands regardless of whether the user's code exports on_update.
    // The on_update callback is optional — it just lets user code react
    // to the swap (e.g. migrate state).  Without it, the new module is
    // loaded and the next render frame picks up the new symbols.
    let existing_runner_can_hmr = if let Some(state) = guard.as_ref() {
        let gui_mode_same = state.is_gui == req.is_gui;
        let resolution_same = state.width == req_width && state.height == req_height;
        debug_log!("[Main] Existing runner: is_gui={}, gui_mode_same={}, resolution_same={}, has_on_update={}",
            state.is_gui, gui_mode_same, resolution_same, has_on_update);

        // HMR enabled: reuse running process when GUI mode and resolution match.
        gui_mode_same && resolution_same
    } else {
        false
    };

    // If we can do HMR, skip all the restart/initialization logic and just send load commands
    if existing_runner_can_hmr {
        debug_log!("[Main] ╔═══════════════════════════════════════════════════════════╗");
        debug_log!("[Main] ║  HMR MODE: Reusing existing runner - NO RESTART          ║");
        debug_log!("[Main] ╚═══════════════════════════════════════════════════════════╝");
        debug_log!(
            "[Main] HMR mode: Skipping track attachment and output subscription (already set up)"
        );
    } else if let Some(state) = guard.as_mut() {
        // We have an existing runner but can't do HMR - need to restart
        let gui_mode_changed = state.is_gui != req.is_gui;
        debug_log!(
            "[Main] Restarting runner: gui_mode_changed={}, use_ai_split={}",
            gui_mode_changed, use_ai_split
        );

        // If resolution matches and is_gui matches, we can reuse Xvfb/GStreamer
        let can_reuse =
            state.is_gui == req.is_gui && state.width == req_width && state.height == req_height;

        let state = guard.take().unwrap();
        if let Some(mut child) = state.process {
            debug_log!("Killing old runner process...");
            let _ = child.kill().await;
        }

        if can_reuse {
            debug_log!("Reusing Xvfb and GStreamer pipeline...");
            reused_xvfb = state.xvfb_process;
            reused_pipeline = state.gst_pipeline;
            reused_wsl_display = state.wsl_display_str;
            reused_gst_display = state.gst_display_str;
            reused_sdl_tx = None; // Do not reuse sdl_tx so we recreate the input task for the new runner's stdin
            video_track_opt = state.video_track;
            audio_track_opt = state.audio_track;
        } else {
            debug_log!("Full restart (resolution/GUI mode changed)...");
            // Stop GStreamer BEFORE killing Xvfb to avoid capture-from-dead-display crashes
            if let Some(pipeline) = state.gst_pipeline {
                let _ = pipeline.set_state(gst::State::Null);
            }
            if let Some(mut child) = state.xvfb_process {
                let _ = child.kill().await;
            }
        }
    }

    // Only start a new runner if we don't have one (either first run, or after restart)
    if !existing_runner_can_hmr && guard.is_none() {
        // Start runner
        debug_log!("Starting persistent runner...");

        let mut wsl_display_str = reused_wsl_display;
        let mut gst_display_str = reused_gst_display;
        let mut xvfb_process: Option<tokio::process::Child> = reused_xvfb;
        let mut gst_pipeline: Option<gst::Pipeline> = reused_pipeline;
        let sdl_tx_opt: Option<mpsc::UnboundedSender<String>> = reused_sdl_tx;

        if req.is_gui {
            let width = req_width;
            let height = req_height;

            if xvfb_process.is_none() {
                for tool in GUI_TOOLS {
                    if Command::new(tool).arg("--version").output().await.is_err() {
                        let msg = format!("GUI tool '{}' is missing. GUI apps require Linux/WSL with xdotool, Xvfb, and matchbox-window-manager installed.", tool);
                        debug_log!("[Runner] {}", msg);
                        anyhow::bail!(msg);
                    }
                }

                // Start Xvfb (Virtual Framebuffer)
                // Try finding a free display or use separate ones per worker?
                // For simplified single-worker model, we can use :99
                let display_num = 99;

                // [Fix] Clean up stale lock files from previous runs
                let lock_file = format!("/tmp/.X11-unix/X{}", display_num);
                if std::path::Path::new(&lock_file).exists() {
                    debug_log!("Removing stale Xvfb lock file: {}", lock_file);
                    let _ = std::fs::remove_file(&lock_file);
                }
                let lock_file_tmp = format!("/tmp/.X{}-lock", display_num);
                if std::path::Path::new(&lock_file_tmp).exists() {
                    debug_log!("Removing stale Xvfb lock file: {}", lock_file_tmp);
                    let _ = std::fs::remove_file(&lock_file_tmp);
                }

                wsl_display_str = format!(":{}", display_num);
                gst_display_str = wsl_display_str.clone();

                debug_log!("Starting Xvfb on display {}", wsl_display_str);

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
                wm_cmd
                    .arg("-use_titlebar")
                    .arg("no")
                    .arg("-use_cursor")
                    .arg("no");
                wm_cmd.env("DISPLAY", &wsl_display_str);
                // NOTE: kill_on_drop is NOT set here. The WM needs to live as long
                // as Xvfb — it will be killed when Xvfb is killed. Setting
                // kill_on_drop(true) + `let _ = spawn()` would immediately drop the
                // Child handle, killing the WM within milliseconds of starting.
                wm_cmd
                    .spawn()
                    .context("Failed to spawn matchbox-window-manager")?;

                debug_log!("Xvfb and Window Manager started.");
            }

            // Wait for Xvfb and window manager to be fully ready before
            // starting GStreamer capture (ximagesrc needs a live X display).
            tokio::time::sleep(tokio::time::Duration::from_millis(700)).await;

            if gst_pipeline.is_none() {
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

                while encoder_idx < encoders.len() {
                    let (encoder, payloader, mime_type) = encoders[encoder_idx];
                    debug_log!("Trying encoder: {}", encoder);

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
                                                debug_log!("Encoder {} started successfully.", encoder);
                                                pipeline = Some(pipe);
                                                selected_mime_type = mime_type.to_string();
                                                break;
                                            }
                                        } else {
                                            debug_log!(
                                                "Encoder {} started successfully (no immediate error).",
                                                encoder
                                            );
                                            pipeline = Some(pipe);
                                            selected_mime_type = mime_type.to_string();
                                            break;
                                        }
                                    }
                                    Err(err) => {
                                        debug_log!(
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
                    let msg = "Failed to initialize any video encoder (tried nvh264enc, vaapih264enc, x264enc, vp8enc). Check GStreamer installation.";
                    debug_log!("[Runner] {}", msg);
                    anyhow::bail!(msg);
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
        }

        // Spawn Runner Process
        //
        // ULTRAPLAN Lightning Phase 12 — per-project runner selection.
        // When `host_runner_bin_path` is Some we spawn the AI-synthesised
        // per-project binary directly. It owns SDL/window/renderer + the
        // dlopen of libcore.so/libgui.so + its own main loop. cwd is set
        // to the binary's parent dir so the AI's `./libcore.so` dlopen
        // call resolves against the symlinks created in compile_core /
        // compile_gui.
        //
        // When `host_runner_bin_path` is None we fall back to the shipped
        // `target/debug/runner` — the legacy path that drives modules via
        // stdin `load` commands and uses the SHIPPED ABI expectations.
        // `use_per_project_runner` is hoisted at the top of this fn.
        let runner_path: std::path::PathBuf = if let Some(ref p) = host_runner_bin_path {
            std::path::PathBuf::from(p)
        } else {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.join("runner")))
                .unwrap_or_else(|| std::path::PathBuf::from("runner"))
        };

        debug_log!(
            "Spawning runner ({}): {:?}",
            if use_per_project_runner { "per-project" } else { "shipped" },
            runner_path
        );
        eprintln!(
            "[Main] Spawning runner ({}): {:?}",
            if use_per_project_runner { "per-project" } else { "shipped" },
            runner_path
        );

        let mut cmd = Command::new(&runner_path);
        cmd.env("DISPLAY", &wsl_display_str)
            .env(
                "LD_LIBRARY_PATH",
                std::env::var("LD_LIBRARY_PATH").unwrap_or_default(),
            )
            // The worker already manages Xvfb, GStreamer, and video streaming.
            // The runner only needs to load .so modules and execute them in-process.
            // ProcessIsolated mode spawns a supervisor + child that conflicts with
            // the worker's own Xvfb on :99 and uses binary IPC instead of the text
            // protocol the worker sends.
            .env("SYNTHI_UNSAFE_INPROCESS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // Phase 12 — per-project runner needs cwd = build dir so its
        // `dlopen("./libcore.so")` resolves via the symlinks created
        // after link. Shipped runner doesn't care about cwd.
        if use_per_project_runner {
            if let Some(parent) = runner_path.parent() {
                cmd.current_dir(parent);
                eprintln!("[Main] per-project runner cwd: {}", parent.display());
            }
        }

        if let Some(sid) = &session_id {
            cmd.env("SYNTHI_SESSION_ID", sid);
        }

        let mut child = cmd.spawn().context("Failed to spawn runner process")?;

        // Capture stdout/stderr
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take().unwrap()));

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
                        debug_log!("[Runner Stderr] {}", l);
                        let _ = log_tx_clone2.send(l.clone());

                        if let Some(structured) = extract_structured_runner_message(&l) {
                            if serde_json::from_str::<serde_json::Value>(structured).is_ok() {
                                let _ = ctx_clone2.log_dc.send_text(structured.to_string()).await;
                                continue;
                            }
                        }

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
            stdin: Some(stdin.clone()),
            output_tx: log_tx,
            is_gui: req.is_gui,
            is_hmr_capable: has_on_update,
            hmr_capability: None,
            xvfb_process,
            gst_pipeline,
            sdl_tx: sdl_tx_opt.clone(),
            video_track: video_track_opt,
            audio_track: audio_track_opt,
            width: req_width,
            height: req_height,
            wsl_display_str: wsl_display_str.clone(),
            gst_display_str,
            module_hashes: ModuleHashes::new(),
            loaded_core_path: None,
            loaded_gui_path: None,
            loaded_widget_paths: HashMap::new(),
            widget_hashes: HashMap::new(),
        });

        // Set up xdotool input channel for GUI apps (only on fresh start, not reuse)
        if req.is_gui && sdl_tx_opt.is_none() {
            if let Some(ref sid) = session_id {
                let (input_tx, mut input_rx) = mpsc::unbounded_channel::<String>();

                // Store sender in RunnerState
                if let Some(state) = guard.as_mut() {
                    state.sdl_tx = Some(input_tx.clone());
                }

                // Register in sdl_input_store so terminal handler can route events
                {
                    let mut sdl_guard = ctx.sdl_input_store.lock().await;
                    sdl_guard.insert(sid.clone(), input_tx);
                }

                // Spawn stdin input writer — sends `input` commands directly
                // to the runner process's stdin (parsed as SDL_PushEvent).
                // This completely bypasses X11 and the window manager, avoiding:
                //   - matchbox-WM intercepting/consuming click events
                //   - xdotool process-per-event overhead (~5-10ms each)
                //   - coordinate mismatches between Xvfb and SDL window
                let stdin_for_input = stdin.clone();
                tokio::spawn(async move {
                    while let Some(cmd) = input_rx.recv().await {
                        let mut stdin_guard = stdin_for_input.lock().await;
                        // Commands may contain multiple lines (e.g. scroll = button down + up)
                        for line in cmd.lines() {
                            if !line.is_empty() {
                                let _ = stdin_guard.write_all(format!("{}\n", line).as_bytes()).await;
                            }
                        }
                        let _ = stdin_guard.flush().await;
                    }
                    debug_log!("[stdin-input] Input channel closed");
                });

                debug_log!(
                    "[Main] stdin input channel registered for session {}",
                    sid
                );
            }
        } else if req.is_gui {
            // Reusing existing sdl_tx - re-register it in the store
            if let Some(ref sid) = session_id {
                if let Some(state) = guard.as_ref() {
                    if let Some(tx) = &state.sdl_tx {
                        let mut sdl_guard = ctx.sdl_input_store.lock().await;
                        sdl_guard.insert(sid.clone(), tx.clone());
                    }
                }
            }
        }
    }

    if let Some(state) = guard.as_mut() {
        if !existing_runner_can_hmr {
            // Replace tracks on pre-allocated transceivers instead of adding new ones
            let transceivers = ctx.pc.get_transceivers().await;
            if let Some(track) = &state.video_track {
                debug_log!("[Main] Replacing video track on transceiver");
                for t in &transceivers {
                    if t.kind() == webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Video {
                        match t
                            .sender()
                            .await
                            .replace_track(Some(
                                Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>
                            ))
                            .await
                        {
                            Ok(_) => debug_log!("[Main] Video track replaced successfully"),
                            Err(e) => eprintln!("[Main] ERROR replacing video track: {:?}", e),
                        }
                        break;
                    }
                }
            }
            if let Some(track) = &state.audio_track {
                debug_log!("[Main] Replacing audio track on transceiver");
                for t in &transceivers {
                    if t.kind() == webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Audio {
                        match t
                            .sender()
                            .await
                            .replace_track(Some(
                                Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>
                            ))
                            .await
                        {
                            Ok(_) => debug_log!("[Main] Audio track replaced successfully"),
                            Err(e) => eprintln!("[Main] ERROR replacing audio track: {:?}", e),
                        }
                        break;
                    }
                }
            }

        }

        // Signal the frontend to show/update the GUI widget.
        // Must be sent on both full-restart and HMR reloads so the
        // window always opens regardless of whether the runner was reused.
        if req.is_gui {
            let gui_start = serde_json::json!({
                "type": "run-gui-start",
                "sessionId": session_id,
                "width": state.width,
                "height": state.height,
            });
            let _ = ctx.log_dc.send_text(gui_start.to_string()).await;
        }

        // ============================================================
        // SEND SESSION + LOAD COMMANDS (BATCHED)
        // ============================================================
        // We send all commands back-to-back and flush once.  The runner's
        // main loop uses try_recv() to drain ALL pending commands before
        // the next render frame, so batching ensures atomic multi-module
        // swap: no intermediate frame where new core state is rendered
        // by old GUI code (which would read corrupt data).
        //
        // ULTRAPLAN Lightning Phase 12 — the per-project host_runner
        // dlopens libcore.so/libgui.so itself via its own code, so it
        // does not speak the `set_session` / `load <name> <path>` stdin
        // protocol. Skip the whole block in that mode. In-process HMR
        // via stdin commands is followup work (Phase 12.5+).
        if use_per_project_runner {
            eprintln!(
                "[Main] per-project runner: skipping stdin set_session/load commands \
                 (binary loads modules internally)"
            );
        } else if let Some(stdin_arc) = &state.stdin {
            // Check if process is still alive before sending anything
            let mut process_alive = true;
            if let Some(child) = state.process.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    debug_log!(
                        "[Main] Runner process has already exited with status: {}",
                        status
                    );
                    process_alive = false;
                }
            }

            if process_alive {
                let mut stdin = stdin_arc.lock().await;
                let mut send_failed = false;

                // Send set_session first (required for Host KV support).
                // The runner needs the session ID before any module load
                // so modules can read/write persistent key-value state.
                if let Some(ref sid) = session_id {
                    let session_cmd = format!("set_session {}\n", sid);
                    debug_log!("[Main] Sending session to runner: {}", session_cmd.trim());
                    if let Err(e) = stdin.write_all(session_cmd.as_bytes()).await {
                        eprintln!("[Main] Failed to write set_session to runner stdin: {}", e);
                        send_failed = true;
                    }
                }

                if !send_failed {
                    // Send all load commands back-to-back (no sleep between them)
                    for (name, path) in &modules_to_load {
                        let cmd = format!("load {} {}\n", name, path);
                        debug_log!("[Main] Sending command to runner: {}", cmd.trim());
                        if let Err(e) = stdin.write_all(cmd.as_bytes()).await {
                            eprintln!("[Main] Failed to write to runner stdin: {}", e);
                            send_failed = true;
                            break;
                        }
                    }
                }

                if !send_failed {
                    // Single flush pushes all commands at once
                    if let Err(e) = stdin.flush().await {
                        eprintln!("[Main] Failed to flush runner stdin: {}", e);
                        send_failed = true;
                    }
                }

                if send_failed {
                    // Runner process likely crashed - report error to frontend
                    anyhow::bail!("Runner process stdin write failed (process may have crashed)");
                }
            } else {
                anyhow::bail!("Runner process exited before module loading could begin");
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

    // Send build-status "done" so the frontend's compile() promise resolves.
    // Without this, native compile promises hang forever, breaking HMR session
    // lifecycle and the [RECOMPILING] badge.
    let done_payload = serde_json::json!({
        "sessionId": session_id,
        "status": "done",
        "success": true,
        "stage": "runner",
    });
    let _ = ctx
        .log_dc
        .send_text(serde_json::to_string(&done_payload).unwrap_or_default())
        .await;

    Ok(())
}
