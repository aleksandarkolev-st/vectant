use std::sync::Arc;
use std::collections::HashMap;
use std::process::Stdio;
use anyhow::{Context, Result};
use tokio::process::Command;
use tokio::io::{AsyncWriteExt, AsyncReadExt, BufReader};
use tokio::sync::mpsc;
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};
use webrtc::rtp::packet::Packet;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTPCodecType};
use webrtc::util::Unmarshal;

use crate::compiler::context::CompileContext;
use crate::compiler::builder::ModuleHashes;
use crate::infra::messages::CompileRequest;
use crate::runtime::runner_state::RunnerState;
use crate::infra::constants::GUI_TOOLS;
use crate::infra::utils::system_command;
use crate::infra::observability::{LogEntry, LogLevel, ReloadMetricsTracker, ReloadId};
use crate::runtime::capability::{detect_capabilities, HmrStatus as CapabilityHmrStatus}; // Aliasing if needed, or check definition

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
    session_id: Option<String>
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
                        let _ = ctx.log_dc
                            .send_text(serde_json::to_string(&payload).unwrap_or_default())
                            .await;
                        return Ok(());
                    }
                }

                // Start Xvfb (Virtual Framebuffer)
                // Try finding a free display or use separate ones per worker? 
                // For simplified single-worker model, we can use :99
                let display_num = 99;
                wsl_display_str = format!(":{}", display_num);
                gst_display_str = wsl_display_str.clone();
                
                println!("Starting Xvfb on display {}", wsl_display_str);

                let mut xvfb_cmd = Command::new("Xvfb");
                xvfb_cmd.arg(&wsl_display_str)
                        .arg("-screen").arg("0").arg(format!("{}x{}x24", width, height))
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
                let _ = wm_cmd.spawn().context("Failed to spawn matchbox-window-manager")?;

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
                // pulsesrc -> audioconvert -> opusenc -> rtpopuspay -> appsink
                
                let pipeline_str = format!(
                    "ximagesrc display-name=\"{}\" use-damage=0 ! video/x-raw,framerate=30/1 ! videoscale ! videoconvert ! {} ! {} name=video_pay ! appsink name=video_sink sync=false \
                     pulsesrc ! audioconvert ! opusenc ! rtpopuspay name=audio_pay ! appsink name=audio_sink sync=false",
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
                                    if let Some(msg) = bus.timed_pop(gst::ClockTime::from_milli_seconds(500)) {
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
                                        println!("Encoder {} started successfully (no immediate error).", encoder);
                                        pipeline = Some(pipe);
                                        selected_mime_type = mime_type.to_string();
                                        break;
                                    }
                                },
                                Err(err) => {
                                     println!("Failed to set state for encoder {}: {}", encoder, err);
                                }
                            }
                        }
                    },
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
                 let _ = ctx.log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                 return Ok(());
            }

            gst_pipeline = pipeline;
            let pipeline_ref = gst_pipeline.as_ref().unwrap();
            
            // Get AppSinks
            let video_sink = pipeline_ref.by_name("video_sink").unwrap().dynamic_cast::<gst_app::AppSink>().unwrap();
            let audio_sink = pipeline_ref.by_name("audio_sink").unwrap().dynamic_cast::<gst_app::AppSink>().unwrap();

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

            let v_track_clone = video_track.clone(); // Clone for closure
            video_sink.set_callbacks(
                gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    match sink.pull_sample() {
                        Ok(sample) => {
                            if let Some(buffer) = sample.buffer() {
                                if let Ok(map) = buffer.map_readable() {
                                    let data = map.as_slice();
                                    // This is a blocking write, but usually fast for RTP packets
                                    if let Err(e) = v_track_clone.write(data) {
                                         if e.to_string().contains("closed") {
                                             return Err(gst::FlowError::Eos);
                                         }
                                         eprintln!("RTP write error: {}", e);
                                    }
                                }
                            }
                            Ok(gst::FlowSuccess::Ok)
                        }
                        Err(_) => Err(gst::FlowError::Eos),
                    }
                })
                .build()
            );

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

            let a_track_clone = audio_track.clone();
            audio_sink.set_callbacks(
                gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    match sink.pull_sample() {
                        Ok(sample) => {
                             if let Some(buffer) = sample.buffer() {
                                if let Ok(map) = buffer.map_readable() {
                                    let data = map.as_slice();
                                    if let Err(e) = a_track_clone.write(data) {
                                         if e.to_string().contains("closed") {
                                             return Err(gst::FlowError::Eos);
                                         }
                                    }
                                }
                            }
                            Ok(gst::FlowSuccess::Ok)
                        }
                        Err(_) => Err(gst::FlowError::Eos),
                    }
                })
                .build()
            );
        }

        // ... (Runner Process Start)
        // ...
        
        // ... (Status Monitoring)
        
        *guard = Some(RunnerState {
            process: None, // Placeholder, needs actual child
            stdin: None, // Placeholder matching type Option<ChildStdin>
            output_tx: tokio::sync::broadcast::channel(1).0, // Placeholder
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
            // Attach tracks logic ...
            // Subscribe output logic ...
        }

        // Load Modules
        for (name, path) in &modules_to_load {
             // ...
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
