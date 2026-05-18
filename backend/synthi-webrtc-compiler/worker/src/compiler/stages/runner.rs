use crate::debug_log;
use anyhow::{Context, Result};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use webrtc::rtp::packet::Packet;
use webrtc_util::Unmarshal;

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

/// Emit a lifecycle-progress message on the build-log DC so the MCP +
/// frontend can surface per-stage warming progress. Ultraplan
/// §Response envelope "Warming progress" — MCP's session envelope
/// carries `warming_progress: {stage, stage_progress_pct,
/// estimated_ready_at}`.
///
/// Fire-and-forget; drop errors so a flaky DC doesn't stall the warm
/// path.
async fn emit_lifecycle_progress(
    ctx: &CompileContext,
    session_id: Option<&str>,
    state: &str,
    stage: &str,
    progress_pct: u8,
    estimated_ready_ms: Option<u64>,
) {
    let mut payload = serde_json::json!({
        "sessionId": session_id,
        "type": "lifecycle",
        "state": state,
        "warming_progress": {
            "stage": stage,
            "stage_progress_pct": progress_pct.min(100),
        },
    });
    if let Some(ms) = estimated_ready_ms {
        payload["warming_progress"]["estimated_ready_at"] = serde_json::Value::from(now_ms() + ms);
    }
    let _ = ctx
        .log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
    // and the later logging can reference it without re-resolving
    // `host_runner_bin_path`. The spawn block uses it to pick the
    // binary + cwd. Stdin HMR commands (set_session / load) are
    // sent uniformly to both runner types (Phase 12.5).
    let use_per_project_runner = host_runner_bin_path.is_some();

    let req_width = req.width.unwrap_or(800);
    let req_height = req.height.unwrap_or(600);

    debug_log!(
        "[Main] Restart check: is_gui={}, has_on_update={}, use_ai_split={}",
        req.is_gui,
        has_on_update,
        use_ai_split
    );

    // Reuse Xvfb/GStreamer if possible. Under `TrackFanout` there's no
    // per-run track to carry across restarts — fanout subscribers are
    // per-peer and persistent for the peer's lifetime.
    let mut reused_xvfb: Option<tokio::process::Child> = None;
    let mut reused_pipeline: Option<gst::Pipeline> = None;
    let mut reused_wsl_display = String::new();
    let mut reused_gst_display = String::new();
    let mut reused_sdl_tx: Option<mpsc::UnboundedSender<String>> = None;

    // Determine if we have an existing runner that can handle HMR.
    // The runner process supports hot-loading modules via stdin `load`
    // commands regardless of whether the user's code exports on_update.
    // The on_update callback is optional — it just lets user code react
    // to the swap (e.g. migrate state).  Without it, the new module is
    // loaded and the next render frame picks up the new symbols.
    //
    // CRITICAL: also verify the child process is still alive. Otherwise we
    // happily fall into the "HMR MODE: Reusing existing runner" path and
    // immediately bail with "Runner process exited before module loading
    // could begin" — which is exactly what happens when the user's main()
    // returned cleanly after a previous run (e.g. clicked Restart, or the
    // game-loop hit Escape). Treating an exited runner as "no runner" lets
    // the spawn-fresh branch below take over.
    let existing_runner_can_hmr = if let Some(state) = guard.as_mut() {
        let runner_alive = match state.process.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        };
        let gui_mode_same = state.is_gui == req.is_gui;
        let resolution_same = state.width == req_width && state.height == req_height;
        debug_log!("[Main] Existing runner: alive={}, is_gui={}, gui_mode_same={}, resolution_same={}, has_on_update={}",
            runner_alive, state.is_gui, gui_mode_same, resolution_same, has_on_update);

        // HMR enabled: reuse running process when alive AND GUI mode and
        // resolution match.
        runner_alive && gui_mode_same && resolution_same
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
            gui_mode_changed,
            use_ai_split
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

        // Phase 12.6: if a supervisor session exists with a per-session
        // Xvfb display, override gst_display_str so ximagesrc captures
        // from the supervisor's display instead of the shared :99.
        {
            let sup_guard = ctx.supervisor_store.lock().await;
            if let Some(ref session) = *sup_guard {
                eprintln!(
                    "[Runner] Phase 12.6: using supervisor display {} (not :99)",
                    session.display_str
                );
                wsl_display_str = session.display_str.clone();
                gst_display_str = session.display_str.clone();
            }
        }

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
                emit_lifecycle_progress(
                    ctx,
                    session_id.as_deref(),
                    "warming",
                    "xvfb_start",
                    15,
                    Some(5_000),
                )
                .await;

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

            // Kick off the focus probe for this display. One probe per
            // DISPLAY; idempotent. The probe's cache feeds the
            // window-tree focus lock + WM_CLASS spoof check in the
            // gui-event handler (main.rs). Advisory-only in phase 1.
            crate::safety::focus_probe::ensure_probe(&wsl_display_str).await;
            if let Some(sid) = session_id.as_deref() {
                crate::safety::focus_probe::bind_session_display(sid, &wsl_display_str);
            }

            emit_lifecycle_progress(
                ctx,
                session_id.as_deref(),
                "warming",
                "gstreamer_start",
                40,
                Some(3_000),
            )
            .await;

            if gst_pipeline.is_none() {
                // VP8 only: the per-peer WebRTC track declares video/VP8 so
                // the pipeline MUST emit VP8 RTP. H264 is excluded because
                // @roamhq/wrtc (used by the MCP agent) ships without H264,
                // and mixing codecs between pipeline and track silently
                // breaks negotiation.
                //
                // `keyframe-max-dist=30` forces a keyframe every second at
                // 30 fps. Without it, vp8enc's default of 128 frames (~4 s)
                // means a late-joining observer peer can wait multiple
                // seconds before FrameSink sees a decodable keyframe — and
                // some combinations of `deadline=1 cpu-used=4` end up
                // emitting keyframes only on scene-change, which the
                // MCP observer flow treats as "no_frame_yet" forever.
                // The encoder is given `name=video_enc` so `create_peer`
                // can dispatch `force-key-unit` events on subscribe.
                let encoders = [
                    ("vp8enc name=video_enc deadline=1 cpu-used=4 end-usage=cbr target-bitrate=2000000 keyframe-max-dist=30", "rtpvp8pay", "video/VP8"),
                ];

                let mut selected_mime_type = "video/VP8".to_owned();
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
                                                println!(
                                                    "Encoder {} failed: {}",
                                                    encoder,
                                                    err.error()
                                                );
                                                let _ = pipe.set_state(gst::State::Null);
                                            } else {
                                                debug_log!(
                                                    "Encoder {} started successfully.",
                                                    encoder
                                                );
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
                                            encoder,
                                            err
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
                    let msg = "Failed to initialize vp8enc. Check GStreamer installation (gstreamer1.0-plugins-good).";
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

                // Video: appsink pushes RTP bytes into a channel; we
                // unmarshal to `Packet` and `dispatch` into the session
                // `video_fanout`. Each peer's subscribed
                // `TrackLocalStaticRTP` task (set up in `create_peer`)
                // writes into its own transceiver. Under HMR, the next
                // runner run produces fresh packets that flow through
                // the same fanout — no `replace_track` dance needed.
                let _ = &selected_mime_type; // kept for pipeline_string use

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

                // Dispatch video packets to the session fanout + tap the
                // RTP marker bit to emit sparse `{type:"frame-advance"}`
                // for the post-HMR paint gate (ultraplan §4.4). The
                // frame-advance ack goes on the build-log DC of the
                // peer that triggered this compile; observers see it
                // via broadcast_build_log_text.
                let video_fanout = ctx.video_fanout.clone();
                let log_dc_for_frame_advance = ctx.log_dc.clone();
                let session_id_for_frame_timing = session_id.clone();
                tokio::spawn(async move {
                    let mut frame_seq: u64 = 0;
                    let mut dispatched: u64 = 0;
                    let mut unmarshal_fail: u64 = 0;
                    let mut last_log = std::time::Instant::now();
                    const EMIT_EVERY_N_FRAMES: u64 = 3;
                    while let Some(data) = v_rx.recv().await {
                        let is_end_of_frame = data.len() >= 2 && (data[1] & 0x80) != 0;
                        if let Ok(packet) = Packet::unmarshal(&mut &data[..]) {
                            video_fanout.dispatch(packet);
                            dispatched += 1;
                        } else {
                            unmarshal_fail += 1;
                            eprintln!(
                                "[Runner] Failed to unmarshal RTP packet ({} bytes)",
                                data.len()
                            );
                        }
                        if dispatched <= 3
                            || last_log.elapsed() >= std::time::Duration::from_secs(2)
                        {
                            last_log = std::time::Instant::now();
                            eprintln!(
                                "[video-rtp] dispatched={} unmarshal_fail={} subscribers={} fanout_dispatched={} fanout_dropped_lag={} fanout_dropped_error={}",
                                dispatched,
                                unmarshal_fail,
                                video_fanout.subscriber_count(),
                                video_fanout.stats().packets_dispatched,
                                video_fanout.stats().packets_dropped_lag,
                                video_fanout.stats().packets_dropped_error,
                            );
                        }
                        if is_end_of_frame {
                            frame_seq += 1;
                            // F4 measurement: feed every end-of-frame
                            // into the per-session interval tracker.
                            // Cheap (one mutex + push to a bounded
                            // VecDeque); marker-rate caps at the
                            // encoder's frame rate (≤60 Hz).
                            if let Some(ref sid) = session_id_for_frame_timing {
                                crate::infra::frame_timing::record_end_of_frame(sid);
                            }
                            if frame_seq % EMIT_EVERY_N_FRAMES == 0 {
                                let ts_ms = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_millis() as u64)
                                    .unwrap_or(0);
                                let msg = format!(
                                    r#"{{"type":"frame-advance","frame_seq":{},"ts_ms":{}}}"#,
                                    frame_seq, ts_ms
                                );
                                let dc = log_dc_for_frame_advance.clone();
                                tokio::spawn(async move {
                                    let _ = dc.send_text(msg).await;
                                });
                            }
                        }
                    }
                });

                // Audio: identical dispatch pattern via `audio_fanout`.
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

                let audio_fanout = ctx.audio_fanout.clone();
                tokio::spawn(async move {
                    while let Some(data) = a_rx.recv().await {
                        if let Ok(packet) = Packet::unmarshal(&mut &data[..]) {
                            audio_fanout.dispatch(packet);
                        }
                    }
                });
            }
        }

        // Frame-timing publisher (F2 + F4): every 5s, publish the
        // rolling p50/p95/p99 of inter-frame intervals + a pipeline-
        // budget proxy on the build-log DC. The MCP routes this into
        // its event log so PHASE_0_5_FINDINGS.md can be filled in
        // with real numbers without a separate scrape endpoint.
        if let Some(sid_for_publish) = session_id.clone() {
            let log_dc_for_timing = ctx.log_dc.clone();
            tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(crate::infra::frame_timing::PUBLISH_INTERVAL);
                interval.tick().await; // skip the immediate first tick
                loop {
                    interval.tick().await;
                    crate::infra::frame_timing::publish_snapshots();
                    let snap = match crate::infra::frame_timing::latest_published(&sid_for_publish)
                    {
                        Some(s) if s.sample_count > 0 => s,
                        _ => continue,
                    };
                    let payload = serde_json::json!({
                        "sessionId": sid_for_publish,
                        "type": "frame-timing",
                        "total_frames": snap.total_frames,
                        "sample_count": snap.sample_count,
                        "interval_ms": {
                            "mean": snap.mean_ms,
                            "min": snap.min_ms,
                            "p50": snap.p50_ms,
                            "p95": snap.p95_ms,
                            "p99": snap.p99_ms,
                            "max": snap.max_ms,
                        },
                        "pipeline_budget_estimate_ms": snap.pipeline_budget_estimate_ms,
                    });
                    let _ = log_dc_for_timing.send_text(payload.to_string()).await;
                }
            });
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
            if use_per_project_runner {
                "per-project"
            } else {
                "shipped"
            },
            runner_path
        );
        eprintln!(
            "[Main] Spawning runner ({}): {:?}",
            if use_per_project_runner {
                "per-project"
            } else {
                "shipped"
            },
            runner_path
        );

        emit_lifecycle_progress(
            ctx,
            session_id.as_deref(),
            "warming",
            "runner_spawn",
            75,
            Some(2_000),
        )
        .await;

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
        // after link. GPU split sidecars are workspace-relative; the
        // shipped runner reads ./.synthi_split_meta.json at startup to
        // choose the backend and split-state path.
        if use_per_project_runner {
            if let Some(parent) = runner_path.parent() {
                cmd.current_dir(parent);
                eprintln!("[Main] per-project runner cwd: {}", parent.display());
            }
        } else if ctx.workspace_path.join(".synthi_split_meta.json").exists() {
            cmd.current_dir(&ctx.workspace_path);
            eprintln!(
                "[Main] shipped runner cwd: {}",
                ctx.workspace_path.display()
            );
        }

        if let Some(sid) = &session_id {
            cmd.env("SYNTHI_SESSION_ID", sid);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                // Diagnostic: the bare anyhow context strips the underlying
                // io::Error reason before it reaches the frontend, leaving us
                // unable to tell ENOENT from EACCES from ETXTBSY. Capture
                // errno + binary state into both the worker stderr and the
                // wrapped error message so the next failure is actionable.
                let kind = e.kind();
                let raw_os_error = e.raw_os_error();
                let cwd_at_spawn = std::env::current_dir().ok();
                let (exists, len, is_file) = match std::fs::metadata(&runner_path) {
                    Ok(md) => (true, md.len(), md.is_file()),
                    Err(_) => (false, 0u64, false),
                };
                eprintln!(
                    "[Main] runner spawn FAILED: binary={:?} cwd_at_spawn={:?} kind={:?} raw_os_error={:?} exists={} len={} is_file={} err={}",
                    runner_path, cwd_at_spawn, kind, raw_os_error, exists, len, is_file, e
                );
                return Err(anyhow::Error::from(e).context(format!(
                    "Failed to spawn runner process: binary={} kind={:?} raw_os_error={:?} exists={} len={} is_file={}",
                    runner_path.display(), kind, raw_os_error, exists, len, is_file
                )));
            }
        };

        // Runner is up — flip lifecycle to `ready`. First peer attach
        // moves it to `running` via peer-count tracking (signaling-side).
        emit_lifecycle_progress(
            ctx,
            session_id.as_deref(),
            "ready",
            "runner_started",
            100,
            None,
        )
        .await;

        // Guest-process registry (ultraplan §Security v4 pre-work #5-#6).
        // Record the root PID + binary fingerprint so the focus-lock +
        // WM_CLASS spoof checks have a ground truth. This is passive —
        // enforcement lands in a follow-up; the registry entry exists
        // on every spawn whether or not downstream code consumes it.
        if let Some(pid) = child.id() {
            if let Some(sid) = session_id.as_deref() {
                let argv0 = runner_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string());
                let registered =
                    crate::safety::guest_registry::GLOBAL_GUEST_REGISTRY.register(sid, pid, argv0);
                let summary = serde_json::json!({
                    "sessionId": sid,
                    "type": "guest-registered",
                    "root_pid": registered.root_pid,
                    "binary_path": registered.binary_path
                        .as_ref().map(|p| p.display().to_string()),
                    "binary_fingerprint": registered.binary_fingerprint,
                    "expected_wm_class_hint": registered.expected_wm_class_hint,
                });
                let _ = ctx
                    .log_dc
                    .send_text(serde_json::to_string(&summary).unwrap_or_default())
                    .await;
                eprintln!(
                    "[GuestRegistry] session={} root_pid={} binary={:?}",
                    sid, registered.root_pid, registered.binary_path,
                );
            }
        }

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
            session_id: session_id.clone(),
            is_gui: req.is_gui,
            is_hmr_capable: has_on_update,
            hmr_capability: None,
            xvfb_process,
            gst_pipeline,
            sdl_tx: sdl_tx_opt.clone(),
            video_track: None,
            audio_track: None,
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
                                let _ = stdin_guard
                                    .write_all(format!("{}\n", line).as_bytes())
                                    .await;
                            }
                        }
                        let _ = stdin_guard.flush().await;
                    }
                    debug_log!("[stdin-input] Input channel closed");
                });

                debug_log!("[Main] stdin input channel registered for session {}", sid);
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
        // Under `TrackFanout`, there is no per-run track to
        // `replace_track` onto each peer's transceiver — per-peer tracks
        // are attached in `create_peer` and persist for the peer's
        // lifetime. Fresh RTP packets from the new GStreamer pipeline
        // flow through the same fanout, so every attached peer sees the
        // new frames automatically.

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
        // ULTRAPLAN Lightning Phase 12.5 — the per-project host_runner
        // now speaks the same stdin text protocol as the shipped runner
        // (set_session / load core <path> / load gui <path> / quit).
        // The AI-generated template has a reader thread that drains the
        // queue at the top of every frame and executes the 6-phase
        // dlopen/dlclose sequence with prev_state preserved across
        // reloads — see UNIVERSAL_SPLIT_PROMPT's HOST RUNNER GENERATION
        // section. So we send the same commands in both modes, no
        // branching needed.
        if let Some(stdin_arc) = &state.stdin {
            // Check if process is still alive before sending anything.
            // Capture the exit status (signal vs code) so that the bail
            // message below can carry it into the frontend's
            // SynthiException — the bare "Runner process exited" string
            // is useless for telling a SIGSEGV apart from a normal exit
            // apart from a SIGKILL from an OOM killer.
            let mut process_alive = true;
            let mut exit_status_repr: Option<String> = None;
            if let Some(child) = state.process.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    let repr = {
                        #[cfg(unix)]
                        {
                            use std::os::unix::process::ExitStatusExt;
                            match (status.code(), status.signal()) {
                                (Some(code), _) => format!("code={}", code),
                                (None, Some(sig)) => format!("signal={}", sig),
                                _ => format!("{}", status),
                            }
                        }
                        #[cfg(not(unix))]
                        {
                            format!("{}", status)
                        }
                    };
                    debug_log!(
                        "[Main] Runner process has already exited ({})",
                        repr
                    );
                    exit_status_repr = Some(repr);
                    process_alive = false;
                }
            }

            if process_alive {
                let mut stdin = stdin_arc.lock().await;
                let mut send_failed = false;

                // ULTRAPLAN Lightning Phase 12.6 — version handshake.
                // Send `handshake <version>` as the FIRST command on every
                // stdin session. The runner's command dispatcher ignores
                // unknown commands gracefully (Phase 12.5 contract), so
                // old runners that don't understand "handshake" just log
                // and continue. Future versions use the handshake for
                // capability negotiation (e.g. "supports binary state
                // transfer", "supports widget-level reload", etc.).
                //
                // Protocol version 1: set_session + load + quit. That's
                // all the runner needs to speak today.
                {
                    let handshake = "handshake 1\n";
                    debug_log!("[Main] Sending handshake: {}", handshake.trim());
                    if let Err(e) = stdin.write_all(handshake.as_bytes()).await {
                        eprintln!("[Main] Failed to write handshake to runner stdin: {}", e);
                        send_failed = true;
                    }
                }

                // Send set_session (required for Host KV support).
                // The runner needs the session ID before any module load
                // so modules can read/write persistent key-value state.
                if !send_failed {
                    if let Some(ref sid) = session_id {
                        let session_cmd = format!("set_session {}\n", sid);
                        debug_log!("[Main] Sending session to runner: {}", session_cmd.trim());
                        if let Err(e) = stdin.write_all(session_cmd.as_bytes()).await {
                            eprintln!("[Main] Failed to write set_session to runner stdin: {}", e);
                            send_failed = true;
                        }
                    }
                }

                if !send_failed {
                    // Send all load commands back-to-back (no sleep between them)
                    for (name, path) in &modules_to_load {
                        let cmd = if let Some(rest) = name.strip_prefix("__gpu_device:") {
                            let mut fields = rest.splitn(2, ':');
                            let vendor = fields.next().unwrap_or("cuda");
                            let kernels = fields.next().filter(|s| !s.is_empty()).unwrap_or("-");
                            format!("load_device {} {} {}\n", vendor, path, kernels)
                        } else {
                            format!("load {} {}\n", name, path)
                        };
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
                anyhow::bail!(
                    "Runner process exited before module loading could begin ({})",
                    exit_status_repr.as_deref().unwrap_or("status unknown")
                );
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
