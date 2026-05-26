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
use webrtc::rtp::packet::Packet;
use webrtc_util::Unmarshal;

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
    // Use dimensions from the source code if the frontend didn't specify any.
    // This lets `frame.setSize(400, 200)` control the video widget size.
    // Scan the main source first, then additional files.
    let (mut source_w, mut source_h) = parse_gui_dimensions(&req.source);
    if source_w.is_none() && source_h.is_none() {
        for f in &req.files {
            let (w, h) = parse_gui_dimensions(&f.content);
            if w.is_some() || h.is_some() {
                source_w = w;
                source_h = h;
                break;
            }
        }
    }
    let req_width = req.width.or(source_w).unwrap_or(800);
    let req_height = req.height.or(source_h).unwrap_or(600);

    let mut guard = ctx.runner_store.lock().await;

    // ── Tear down previous process, reuse Xvfb/GStreamer ──────────
    // Per-peer tracks + fanout subs are persistent across runner
    // restarts, so no track plumbing needs to carry through here.
    let mut reused_xvfb: Option<tokio::process::Child> = None;
    let mut reused_pipeline: Option<gst::Pipeline> = None;
    let mut reused_wsl_display = String::new();
    let mut _reused_gst_display = String::new();

    if let Some(state) = guard.as_mut() {
        let can_reuse =
            state.is_gui == req.is_gui && state.width == req_width && state.height == req_height;

        let state = guard.take().unwrap();

        // Snapshot the X client count BEFORE killing the JVM. We use the
        // drop in client count as the signal that the X server has fully
        // reaped the dead JVM's connection. Without this, the next spawn
        // races against the OLD JVM's still-mapped windows + matchbox's
        // stale reparenting frame, and the window-discovery logic locks
        // onto the OLD XID — GStreamer then captures a black framebuffer
        // owned by the dead client (the "black screen on second build"
        // symptom). Only meaningful when reusing Xvfb (GUI rerun).
        let pre_kill_clients = if state.is_gui && can_reuse {
            count_x_clients(&state.wsl_display_str).await
        } else {
            0
        };

        // Kill old JVM / runner process. `tokio::Child::kill().await`
        // sends SIGKILL and waits for the process to be reaped — but
        // the X server's reap of that client's windows is asynchronous
        // and not covered by this wait. See the post-kill loop below.
        if let Some(mut child) = state.process {
            eprintln!(
                "[JavaRunner] Killing previous process (pid={:?})...",
                child.id()
            );
            let _ = child.kill().await;
        }

        // Bounded wait for the X server + matchbox to settle. Up to
        // 1500 ms, polling every 50 ms. If the count drops we proceed
        // immediately; if the deadline hits we proceed anyway and let
        // the spawn-side xwininfo retry loop handle whatever lingers.
        if state.is_gui && can_reuse && pre_kill_clients > 0 {
            let display = state.wsl_display_str.clone();
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(1500);
            loop {
                let now = count_x_clients(&display).await;
                if now < pre_kill_clients {
                    eprintln!(
                        "[JavaRunner] X11 cleanup: client count {} → {} after JVM kill",
                        pre_kill_clients, now
                    );
                    break;
                }
                if tokio::time::Instant::now() >= deadline {
                    eprintln!(
                        "[JavaRunner] X11 cleanup: timed out (1.5s) waiting for X client count to drop from {}",
                        pre_kill_clients
                    );
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }

        if can_reuse {
            // Verify the stored display is still responsive before reusing.
            // TCP probe is the most reliable check — abstract UNIX sockets
            // don't leave a file in /tmp/.X11-unix/ so we can't stat them.
            let display_ok = {
                let num = state
                    .wsl_display_str
                    .trim_start_matches("127.0.0.1:")
                    .trim_start_matches(':');
                let port: u16 = 6000 + num.parse::<u16>().unwrap_or(99);
                // Try file socket first (cheapest), then TCP
                std::path::Path::new(&format!("/tmp/.X11-unix/X{}", num)).exists()
                    || tokio::net::TcpStream::connect(("127.0.0.1", port))
                        .await
                        .is_ok()
            };

            if display_ok {
                eprintln!(
                    "[JavaRunner] Reusing Xvfb (display={} OK)",
                    state.wsl_display_str
                );
                reused_xvfb = state.xvfb_process;
                reused_wsl_display = state.wsl_display_str;
                _reused_gst_display = state.gst_display_str;
                // Always restart GStreamer for GUI — the window XID changes
                // between JVM runs so the old pipeline captures a stale window.
                if state.is_gui {
                    eprintln!("[JavaRunner] Tearing down old GStreamer (GUI XID changed)");
                    if let Some(pipeline) = state.gst_pipeline {
                        let _ = pipeline.set_state(gst::State::Null);
                    }
                } else {
                    reused_pipeline = state.gst_pipeline;
                }
            } else {
                eprintln!(
                    "[JavaRunner] Reuse requested but display {} is dead — full teardown",
                    state.wsl_display_str
                );
                if let Some(pipeline) = state.gst_pipeline {
                    let _ = pipeline.set_state(gst::State::Null);
                }
                if let Some(mut xvfb) = state.xvfb_process {
                    let _ = xvfb.kill().await;
                }
            }
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

    // ── Xvfb setup (GUI only) ─────────────────────────────────────
    // GStreamer is deferred until after Java spawns (see below).
    // All X11 comms (Java AWT, GStreamer, xdotool) use the same
    // DISPLAY=:99 via abstract UNIX sockets — matching the C++ runner.
    let mut wsl_display_str = reused_wsl_display;
    let mut xvfb_process: Option<tokio::process::Child> = reused_xvfb;
    let mut gst_pipeline: Option<gst::Pipeline> = reused_pipeline;

    if req.is_gui {
        // Start Xvfb if not reused
        if xvfb_process.is_none() {
            let (child, display) = start_xvfb(ctx, session_id, req_width, req_height).await?;
            xvfb_process = Some(child);
            wsl_display_str = display;
        }
        // GStreamer start is deferred until after Java spawns (see below)
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

    // For GUI apps, force AWT into non-headless mode.  Container JREs
    // often default to headless=true which silently prevents Swing/AWT
    // from creating visible windows on X11.
    if req.is_gui {
        cmd.arg("-Djava.awt.headless=false");
        cmd.arg("-Dsun.java2d.xrender=false"); // avoid XRender bugs over TCP
        cmd.arg("-Dsun.java2d.pmoffscreen=false"); // paint directly to X window (not offscreen pixmap)
        cmd.arg("-Dsun.java2d.opengl=false"); // disable OpenGL pipeline
        cmd.arg("-Dsun.awt.noerasebackground=true"); // reduce white-flash flicker
    }

    cmd.arg(main_class);

    if req.is_gui {
        cmd.env("DISPLAY", &wsl_display_str);
        cmd.env("AWT_TOOLKIT", "XToolkit"); // force X11 toolkit
        cmd.env("GDK_BACKEND", "x11"); // GTK fallback
                                       // WM reparenting compat — some WMs break AWT without this
        cmd.env("_JAVA_AWT_WM_NONREPARENTING", "1");
        // Reinforce Java2D flags via env (in case cmd args have ordering issues)
        cmd.env(
            "JAVA_TOOL_OPTIONS",
            "-Dsun.java2d.pmoffscreen=false -Dsun.java2d.opengl=false -Dsun.java2d.xrender=false",
        );
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    eprintln!(
        "[JavaRunner] Spawning: java -cp {:?} {} {} (GUI={}, DISPLAY={})",
        classes_dir,
        if req.is_gui {
            "-Djava.awt.headless=false -Dsun.java2d.xrender=false"
        } else {
            ""
        },
        main_class,
        req.is_gui,
        if req.is_gui {
            wsl_display_str.as_str()
        } else {
            ""
        }
    );

    let mut child = cmd
        .spawn()
        .context("Failed to spawn java — is openjdk installed?")?;

    // ── GStreamer start — ROOT capture ─────────────────────────────
    // We defer GStreamer start until after the Java window is visible
    // and fullscreened.  Then we capture the ROOT window (not the
    // child XID), same approach as the C++ stages runner.
    //
    // IMPORTANT: We verify the local display (":99") is actually
    // reachable before using it.  In containers, UNIX sockets often
    // fail, so we fall back to TCP for GStreamer if needed.
    //
    // Root capture is generic — works for Swing, JavaFX, SDL, OpenGL,
    // LWJGL, or any X11 toolkit.
    if req.is_gui && gst_pipeline.is_none() {
        eprintln!("[JavaRunner] Waiting for Java GUI window to appear...");
        let xid = find_gui_window(&wsl_display_str, req_width, req_height, 8000).await;

        if let Some(xid) = xid {
            eprintln!(
                "[JavaRunner] Window 0x{:x} mapped and visible, forcing fullscreen...",
                xid
            );

            // Force-resize the window to fill the screen.
            // matchbox-wm should do this automatically, but sometimes the
            // initial window geometry from Java's setSize() wins the race.
            // Resize ALL windows on the display to guarantee fullscreen.
            let _ = Command::new("sh")
                .arg("-c")
                .arg(format!(
                    "for wid in $(xdotool search --onlyvisible --name ''); do xdotool windowsize --sync $wid {} {} 2>/dev/null; xdotool windowmove --sync $wid 0 0 2>/dev/null; done",
                    req_width, req_height
                ))
                .env("DISPLAY", &wsl_display_str)
                .output()
                .await;
            // Also resize the specific JFrame we found
            let _ = Command::new("xdotool")
                .arg("windowsize")
                .arg("--sync")
                .arg(format!("0x{:x}", xid))
                .arg(format!("{}", req_width))
                .arg(format!("{}", req_height))
                .env("DISPLAY", &wsl_display_str)
                .output()
                .await;
            let _ = Command::new("xdotool")
                .arg("windowmove")
                .arg("--sync")
                .arg(format!("0x{:x}", xid))
                .arg("0")
                .arg("0")
                .env("DISPLAY", &wsl_display_str)
                .output()
                .await;
            let _ = Command::new("xdotool")
                .arg("windowactivate")
                .arg("--sync")
                .arg(format!("0x{:x}", xid))
                .env("DISPLAY", &wsl_display_str)
                .output()
                .await;
            let _ = Command::new("xdotool")
                .arg("windowfocus")
                .arg("--sync")
                .arg(format!("0x{:x}", xid))
                .env("DISPLAY", &wsl_display_str)
                .output()
                .await;

            // Wait for Swing to finish layout/paint after the resize.
            tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;

            // Verify window geometry after resize
            if let Ok(geo_out) = Command::new("xdotool")
                .arg("getwindowgeometry")
                .arg(format!("0x{:x}", xid))
                .env("DISPLAY", &wsl_display_str)
                .output()
                .await
            {
                let geo_text = String::from_utf8_lossy(&geo_out.stdout);
                eprintln!(
                    "[JavaRunner] Window geometry after resize: {}",
                    geo_text.trim()
                );
            }

            // Force a Swing repaint by sending Expose event
            let _ = Command::new("xdotool")
                .arg("key")
                .arg("--window")
                .arg(format!("0x{:x}", xid))
                .arg("F5")
                .env("DISPLAY", &wsl_display_str)
                .output()
                .await;

            // Diagnostic: xwd root capture to check pixel diversity
            if let Ok(xwd_out) = Command::new("xwd")
                .arg("-root")
                .arg("-silent")
                .env("DISPLAY", &wsl_display_str)
                .output()
                .await
            {
                let bytes = &xwd_out.stdout;
                if bytes.len() > 200 {
                    let sample: std::collections::HashSet<u8> =
                        bytes[100..].iter().step_by(97).copied().collect();
                    eprintln!(
                        "[JavaRunner] xwd root: {} bytes, {} unique values (>4 = real content)",
                        bytes.len(),
                        sample.len()
                    );
                } else {
                    eprintln!(
                        "[JavaRunner] xwd root: only {} bytes (too small)",
                        bytes.len()
                    );
                }
            }

            eprintln!(
                "[JavaRunner] Starting ROOT capture (window 0x{:x} fills {}x{} screen)",
                xid, req_width, req_height
            );
        } else {
            eprintln!(
                "[JavaRunner] WARNING: No window found, root capture may show only background"
            );
        }

        // Root capture — no XID, same approach as the C++ runner.
        // All connections use DISPLAY=:99 (abstract UNIX sockets + XShm).
        let pipeline = start_gstreamer(
            &wsl_display_str,
            session_id,
            None,
            ctx.video_fanout.clone(),
            ctx.audio_fanout.clone(),
        )
        .await?;
        gst_pipeline = Some(pipeline);

        // Force periodic Swing repaints via xdotool.
        // After GStreamer starts, Swing components may have already painted
        // but the capture missed them.  Sending window unmap/remap cycles
        // forces a full repaint that ximagesrc will capture.
        if let Some(xid) = find_gui_window(&wsl_display_str, req_width, req_height, 2000).await {
            let repaint_display = wsl_display_str.clone();
            tokio::spawn(async move {
                for i in 0..3 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(500 + i * 1000)).await;
                    // Send xdotool key to trigger repaint
                    let _ = Command::new("xdotool")
                        .arg("windowminimize")
                        .arg("--sync")
                        .arg(format!("0x{:x}", xid))
                        .env("DISPLAY", &repaint_display)
                        .output()
                        .await;
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                    let _ = Command::new("xdotool")
                        .arg("windowactivate")
                        .arg("--sync")
                        .arg(format!("0x{:x}", xid))
                        .env("DISPLAY", &repaint_display)
                        .output()
                        .await;
                    eprintln!(
                        "[JavaRunner] Forced repaint cycle {} for window 0x{:x}",
                        i + 1,
                        xid
                    );
                }
            });
        }
    }

    // Delayed X11 window diagnostic for GUI apps.
    // After 3 seconds, check if any windows appeared on the display,
    // take a screenshot to verify content, and log window details.
    if req.is_gui {
        let diag_display = wsl_display_str.clone();
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;

            // 1. Count windows
            match Command::new("xdotool")
                .arg("search")
                .arg("--name")
                .arg("")
                .env("DISPLAY", &diag_display)
                .output()
                .await
            {
                Ok(out) => {
                    let stdout_str = String::from_utf8_lossy(&out.stdout);
                    let win_count = stdout_str.trim().lines().count();
                    eprintln!(
                        "[JavaRunner] X11 window check (3s): {} windows on DISPLAY={}",
                        win_count, diag_display
                    );
                    if win_count == 0 {
                        eprintln!(
                            "[JavaRunner] WARNING: No windows found! Java may not have created a visible window."
                        );
                    }
                }
                Err(e) => {
                    eprintln!("[JavaRunner] xdotool search failed: {}", e);
                }
            }

            // 2. Capture screenshot to a temp file and check if it's uniform
            let screenshot_path = "/tmp/_synthi_diag_screenshot.xwd";
            if let Ok(xwd_out) = Command::new("xwd")
                .arg("-root")
                .arg("-silent")
                .arg("-out")
                .arg(screenshot_path)
                .env("DISPLAY", &diag_display)
                .output()
                .await
            {
                if xwd_out.status.success() {
                    if let Ok(meta) = std::fs::metadata(screenshot_path) {
                        let size = meta.len();
                        // 800x600x3 ≈ 1.44 MB raw.  An xwd of a uniform
                        // image will be roughly that size (XWD is uncompressed).
                        // But we can sample a few pixel values to check diversity.
                        eprintln!(
                            "[JavaRunner] Screenshot (xwd): {} bytes — {}",
                            size,
                            if size > 100_000 {
                                "has content"
                            } else {
                                "suspiciously small"
                            }
                        );
                    }
                    // Sample a few bytes from the pixel area to check color
                    if let Ok(data) = std::fs::read(screenshot_path) {
                        // XWD header is variable length; pixel data starts after it.
                        // Check if there are at least 2 distinct byte values in a
                        // sample region (simplistic diversity check).
                        let start = std::cmp::min(200, data.len());
                        let end = std::cmp::min(start + 3000, data.len());
                        let sample = &data[start..end];
                        let mut vals = std::collections::HashSet::new();
                        for &b in sample.iter().step_by(3) {
                            vals.insert(b);
                        }
                        eprintln!(
                            "[JavaRunner] Screenshot pixel diversity: {} distinct values in sample (1=uniform, >3=has content)",
                            vals.len()
                        );
                        // Log first few distinct values
                        let first_vals: Vec<_> = vals.iter().take(5).collect();
                        eprintln!("[JavaRunner] Sample pixel values: {:?}", first_vals);
                    }
                    let _ = std::fs::remove_file(screenshot_path);
                } else {
                    let err_str = String::from_utf8_lossy(&xwd_out.stderr);
                    eprintln!("[JavaRunner] xwd failed: {}", err_str.trim());
                }
            }

            // 3. List window tree for debugging (root + largest child's children)
            if let Ok(tree) = Command::new("xwininfo")
                .arg("-root")
                .arg("-children")
                .env("DISPLAY", &diag_display)
                .output()
                .await
            {
                let tree_str = String::from_utf8_lossy(&tree.stdout);
                for line in tree_str.lines().take(25) {
                    eprintln!("[JavaRunner] xwininfo: {}", line);
                }

                // Also inspect the largest child's sub-tree (matchbox frame)
                // to see if the JFrame is reparented inside it
                for line in tree_str.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("0x") && trimmed.contains("800x600") {
                        if let Some(xid_str) = trimmed.split_whitespace().next() {
                            eprintln!(
                                "[JavaRunner] Inspecting matchbox frame {} children:",
                                xid_str
                            );
                            if let Ok(sub) = Command::new("xwininfo")
                                .arg("-id")
                                .arg(xid_str)
                                .arg("-children")
                                .env("DISPLAY", &diag_display)
                                .output()
                                .await
                            {
                                let sub_str = String::from_utf8_lossy(&sub.stdout);
                                for sline in sub_str.lines().take(20) {
                                    eprintln!("[JavaRunner]   frame-child: {}", sline);
                                }
                            }
                        }
                        break;
                    }
                }
            }
        });
    }
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
        session_id: Some(session_id.to_string()),
        is_gui: req.is_gui,
        is_hmr_capable: false, // Java doesn't support in-process HMR
        hmr_capability: None,
        xvfb_process,
        gst_pipeline,
        sdl_tx: None,
        video_track: None,
        audio_track: None,
        width: req_width,
        height: req_height,
        gst_display_str: wsl_display_str.clone(),
        wsl_display_str,
        module_hashes: ModuleHashes::new(),
        loaded_core_path: None,
        loaded_gui_path: None,
        loaded_device_abi: None,
        loaded_widget_paths: HashMap::new(),
        widget_hashes: HashMap::new(),
    });

    // ── X11 input injection for GUI apps ─────────────────────────
    // The main worker event router (main.rs) converts browser mouse/keyboard
    // events into SDL-format commands ("input motion x y", "input button
    // down btn x y", "input key down sdlk") and sends them to the channel.
    // The input module translates these into xdotool invocations on the
    // Xvfb display so AWT/Swing receives native X11 events.
    if req.is_gui {
        let display_for_input = guard
            .as_ref()
            .map(|s| s.wsl_display_str.clone())
            .unwrap_or_else(|| ":99".to_string());

        let input_tx = super::input::spawn_input_task(display_for_input);

        if let Some(state) = guard.as_mut() {
            state.sdl_tx = Some(input_tx.clone());
        }

        // Register in sdl_input_store so the terminal data-channel handler
        // in main.rs can route gui-event messages to this sender.
        {
            let mut sdl_guard = ctx.sdl_input_store.lock().await;
            sdl_guard.insert(session_id.to_string(), input_tx);
        }
    }

    // Under `TrackFanout`, tracks are pre-attached on each peer's
    // transceiver during `create_peer`; GStreamer just dispatches
    // packets to the session fanouts and every subscribed peer's
    // track receives them. No per-runner replace_track dance.
    if req.is_gui {
        if let Some(state) = guard.as_ref() {
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

/// Count active X11 client connections on `display` via `xlsclients`.
/// Used as the cleanup signal after killing a previous JVM: the drop
/// in client count indicates the X server has reaped the dead JVM's
/// connection (and matchbox will subsequently clean up its frame on
/// the resulting DestroyNotify). Returns 0 on any failure — callers
/// must treat 0 as "skip the wait" so a missing/broken `xlsclients`
/// degrades to today's behaviour rather than blocking forever.
async fn count_x_clients(display: &str) -> usize {
    use tokio::process::Command;
    match Command::new("xlsclients")
        .env("DISPLAY", display)
        .output()
        .await
    {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).lines().count(),
        _ => 0,
    }
}

/// Start Xvfb and matchbox-window-manager.
/// Returns `(child, display)` where `display` is the DISPLAY string
/// (e.g. `:99`) for all X11 connections (Java AWT, GStreamer, xdotool).
/// Uses abstract UNIX sockets — same config as the C++ stages runner.
async fn start_xvfb(
    ctx: &CompileContext,
    session_id: &str,
    width: u32,
    height: u32,
) -> Result<(tokio::process::Child, String)> {
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

    let display_num: u32 = 99;

    // Ensure /tmp/.X11-unix exists with sticky-bit permissions.
    {
        let dir = std::path::Path::new("/tmp/.X11-unix");
        if !dir.exists() {
            let _ = std::fs::create_dir_all(dir);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o1777));
        }
    }

    // Kill any stale Xvfb on this display before cleaning up lock files
    let _ = Command::new("pkill")
        .arg("-f")
        .arg(format!("Xvfb :{}", display_num))
        .output()
        .await;
    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

    // Also kill stale matchbox-window-manager instances
    let _ = Command::new("pkill")
        .arg("-f")
        .arg("matchbox-window-manager")
        .output()
        .await;

    // Kill stale compositors from previous runs — a lingering xcompmgr
    // would still redirect child windows offscreen, breaking XID capture.
    for compositor in &["xcompmgr", "picom", "compton"] {
        let _ = Command::new("pkill")
            .arg("-f")
            .arg(*compositor)
            .output()
            .await;
    }
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    // Clean up stale lock / socket files
    for path in &[
        format!("/tmp/.X11-unix/X{}", display_num),
        format!("/tmp/.X{}-lock", display_num),
    ] {
        if std::path::Path::new(path).exists() {
            let _ = std::fs::remove_file(path);
        }
    }

    // Match the C++ stages runner Xvfb config exactly:
    //   Xvfb :99 -screen 0 WxHx24 -ac
    //
    // NO extra flags. Previously -listen tcp, +extension RENDER,
    // -extension Composite caused: (a) framebuffer freeze after initial
    // paint, (b) GStreamer ximagesrc forced to use XGetImage over TCP
    // (freezes after one frame) instead of XShm (continuous updates).
    //
    // Without explicit -listen tcp, Xvfb uses abstract UNIX sockets by
    // default.  These always work in containers (kernel feature, no
    // filesystem) and support XShm for efficient screen capture.
    let mut xvfb_cmd = Command::new("Xvfb");
    xvfb_cmd
        .arg(format!(":{}", display_num))
        .arg("-screen")
        .arg("0")
        .arg(format!("{}x{}x24", width, height))
        .arg("-ac")
        .kill_on_drop(true);

    let child = xvfb_cmd.spawn().context("Failed to spawn Xvfb")?;

    // Wait for Xvfb to be ready.
    // Use DISPLAY=:N which connects via abstract UNIX sockets (same as
    // the C++ runner).  The file socket /tmp/.X11-unix/XN may or may not
    // appear — that's fine, xdpyinfo will confirm the display works.
    let display_str = format!(":{}", display_num);
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(5);
    loop {
        let probe = Command::new("xdpyinfo")
            .env("DISPLAY", &display_str)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        if probe.map(|s| s.success()).unwrap_or(false) {
            eprintln!("[JavaRunner] Xvfb ready on DISPLAY={}", display_str);
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            eprintln!(
                "[JavaRunner] WARNING: Xvfb not confirmed after 5s, proceeding with DISPLAY={}",
                display_str
            );
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    // Diagnostic: verify X11 display is accessible via the chosen transport
    {
        let xdpy_out = Command::new("xdpyinfo")
            .env("DISPLAY", &display_str)
            .output()
            .await;
        match xdpy_out {
            Ok(out) if out.status.success() => {
                eprintln!("[JavaRunner] xdpyinfo on DISPLAY={} OK", display_str);
            }
            Ok(out) => {
                let stderr_text = String::from_utf8_lossy(&out.stderr);
                eprintln!(
                    "[JavaRunner] xdpyinfo FAILED on DISPLAY={}: {}",
                    display_str,
                    stderr_text.trim()
                );
            }
            Err(e) => {
                eprintln!("[JavaRunner] xdpyinfo not found or failed to run: {}", e);
            }
        }
    }

    // Start Window Manager on the same display
    let mut wm_cmd = Command::new("matchbox-window-manager");
    wm_cmd
        .arg("-use_titlebar")
        .arg("no")
        .arg("-use_cursor")
        .arg("no")
        .env("DISPLAY", &display_str);
    // WM must outlive this scope — intentionally not setting kill_on_drop
    let _wm = wm_cmd
        .spawn()
        .context("Failed to spawn matchbox-window-manager")?;

    // NOTE: We do NOT start a compositor (xcompmgr, picom, compton).
    // Without a compositor, Xvfb manages compositing natively — child
    // windows' painted content is embedded in the root framebuffer.
    // This is the same approach the C++ stages runner uses.

    // Set root window to a dark color (looks like "loading" in the video widget).
    // If only this color is visible, the app window isn't mapped/painted yet.
    let _ = Command::new("xsetroot")
        .arg("-solid")
        .arg("#1a1a2e")
        .env("DISPLAY", &display_str)
        .output()
        .await;

    // Give the WM a moment to register with X
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    eprintln!(
        "[JavaRunner] Xvfb + WM started (no compositor), DISPLAY={}",
        display_str
    );

    Ok((child, display_str))
}

/// Poll for the main GUI window on the given display.
///
/// Uses `xwininfo -root -children` (not xdotool) to reliably parse the
/// window tree.  Finds the matchbox-wm frame (screen-sized child of root),
/// then inspects its children to find the JFrame reparented inside it.
///
/// The returned XID is used for diagnostic logging only — the actual
/// capture uses root mode (no XID) because Xvfb's root capture reads
/// the composited screen buffer which includes all visible windows.
///
/// Returns the XID of the Java window, or the matchbox frame as fallback,
/// or `None` if no suitable window is found within the timeout.
async fn find_gui_window(
    display: &str,
    expected_width: u32,
    expected_height: u32,
    timeout_ms: u64,
) -> Option<u64> {
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);
    let expected_geo = format!("{}x{}", expected_width, expected_height);

    loop {
        // Step 1: Find the matchbox frame (direct child of root, screen-sized)
        // Uses xwininfo which outputs geometry like: 0x6000ff (has no name): ()  800x600+0+0
        let mut matchbox_frame_xid: Option<u64> = None;

        if let Ok(output) = Command::new("xwininfo")
            .arg("-root")
            .arg("-children")
            .env("DISPLAY", display)
            .output()
            .await
        {
            let stdout = String::from_utf8_lossy(&output.stdout);

            for line in stdout.lines() {
                let trimmed = line.trim();
                // xwininfo child lines start with "0x..."
                if !trimmed.starts_with("0x") {
                    continue;
                }

                // Look for the expected geometry pattern (e.g. "800x600+")
                let geo_pattern = format!("{}+", expected_geo);
                if !trimmed.contains(&geo_pattern) {
                    continue;
                }

                // Parse XID from "0x6000ff ..."
                let hex_str = trimmed.split_whitespace().next().unwrap_or("");
                let hex_digits = hex_str.trim_start_matches("0x");
                if let Ok(xid) = u64::from_str_radix(hex_digits, 16) {
                    // Skip tiny or internal windows (matchbox's own 5x5 window)
                    eprintln!(
                        "[JavaRunner] find_gui_window: candidate root child 0x{:x} — {}",
                        xid,
                        trimmed.chars().take(80).collect::<String>()
                    );
                    matchbox_frame_xid = Some(xid);
                    break;
                }
            }
        }

        // Step 2: If we found the matchbox frame, look for the JFrame inside
        if let Some(frame_xid) = matchbox_frame_xid {
            eprintln!(
                "[JavaRunner] Found matchbox frame: xid=0x{:x} ({})",
                frame_xid, expected_geo
            );

            // List children of the matchbox frame
            if let Ok(children_out) = Command::new("xwininfo")
                .arg("-id")
                .arg(format!("0x{:x}", frame_xid))
                .arg("-children")
                .env("DISPLAY", display)
                .output()
                .await
            {
                let children_text = String::from_utf8_lossy(&children_out.stdout);
                let mut best_child_xid: Option<u64> = None;
                let mut best_child_area: u64 = 0;

                for cline in children_text.lines() {
                    let ctrimmed = cline.trim();
                    if !ctrimmed.starts_with("0x") {
                        continue;
                    }

                    // Parse XID
                    let hex_str = ctrimmed.split_whitespace().next().unwrap_or("");
                    let hex_digits = hex_str.trim_start_matches("0x");
                    let child_xid: u64 = match u64::from_str_radix(hex_digits, 16) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };

                    // Parse geometry: look for WxH+X+Y pattern
                    let mut child_w: u64 = 0;
                    let mut child_h: u64 = 0;
                    for word in ctrimmed.split_whitespace() {
                        if word.contains('x') && word.contains('+') {
                            let geo_part = word.split('+').next().unwrap_or("");
                            let parts: Vec<&str> = geo_part.split('x').collect();
                            if parts.len() == 2 {
                                child_w = parts[0].parse().unwrap_or(0);
                                child_h = parts[1].parse().unwrap_or(0);
                            }
                        }
                    }

                    let area = child_w * child_h;
                    eprintln!(
                        "[JavaRunner]   frame child: xid=0x{:x} size={}x{}",
                        child_xid, child_w, child_h
                    );

                    if area > best_child_area && child_w > 10 && child_h > 10 {
                        best_child_area = area;
                        best_child_xid = Some(child_xid);
                    }
                }

                if let Some(child_xid) = best_child_xid {
                    eprintln!(
                        "[JavaRunner] Found JFrame inside matchbox: xid=0x{:x} ({}x? area={})",
                        child_xid,
                        best_child_area / expected_height as u64,
                        best_child_area
                    );
                    return Some(child_xid);
                }

                // No sizeable child yet — JFrame may not be reparented yet
                eprintln!("[JavaRunner] Matchbox frame found but no JFrame child yet, retrying...");
            }
        }

        if tokio::time::Instant::now() >= deadline {
            // Last resort: return the matchbox frame itself
            if let Some(frame_xid) = matchbox_frame_xid {
                eprintln!(
                    "[JavaRunner] Timeout: using matchbox frame 0x{:x} as fallback",
                    frame_xid
                );
                return Some(frame_xid);
            }
            eprintln!(
                "[JavaRunner] find_gui_window: no suitable window found within {}ms",
                timeout_ms
            );
            return None;
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
    }
}

async fn start_gstreamer(
    tcp_display: &str,
    _session_id: &str,
    window_xid: Option<u64>,
    video_fanout: Arc<crate::webrtc::TrackFanout>,
    audio_fanout: Arc<crate::webrtc::TrackFanout>,
) -> Result<gst::Pipeline> {
    // VP8 only — see main.rs create_peer for the rationale. Track mime is
    // video/VP8 so the pipeline must match.
    //
    // `keyframe-max-dist=30` → one keyframe per second at 30 fps, so a
    // late-joining observer peer sees a decodable frame within ~1 s of
    // subscribe. `name=video_enc` lets `create_peer` fire `force-key-unit`
    // on the encoder when a fresh peer subscribes, short-circuiting the
    // wait entirely in the common case.
    let encoders = [
        ("vp8enc name=video_enc deadline=1 cpu-used=4 end-usage=cbr target-bitrate=2000000 keyframe-max-dist=30", "rtpvp8pay", "video/VP8"),
    ];

    let mut pipeline_opt: Option<gst::Pipeline> = None;
    let mut selected_mime = "video/VP8".to_string();

    // Build the ximagesrc element string based on capture mode:
    //
    // ROOT capture (no XID): uses DISPLAY=:99 (abstract UNIX sockets)
    // with XShm for continuous frame reads.  This matches the C++ runner.
    //
    // XID capture (future/other toolkits): would need remote=true.
    //
    // show-pointer=false avoids cursor artifacts in the stream.
    let ximagesrc_str = if let Some(xid) = window_xid {
        eprintln!(
            "[JavaRunner] ximagesrc: capturing window xid=0x{:x} on display={}",
            xid, tcp_display
        );
        format!(
            "ximagesrc display-name=\"{}\" xid=0x{:x} use-damage=0 remote=true show-pointer=false",
            tcp_display, xid
        )
    } else {
        // Root capture with XShm — continuous frame updates.
        eprintln!(
            "[JavaRunner] ximagesrc: ROOT capture on display={} (XShm, all visible windows)",
            tcp_display
        );
        format!(
            "ximagesrc display-name=\"{}\" use-damage=0 show-pointer=false",
            tcp_display
        )
    };

    // Try each encoder with the configured ximagesrc
    for (encoder, payloader, mime) in &encoders {
        let pipeline_str = format!(
            "{} ! video/x-raw,framerate=30/1 ! videoscale ! videoconvert ! {} ! {} name=video_pay ! appsink name=video_sink sync=false \
             audiotestsrc is-live=true wave=silence ! opusenc ! rtpopuspay name=audio_pay ! appsink name=audio_sink sync=false",
            ximagesrc_str, encoder, payloader
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
                    let mode_str = if window_xid.is_some() {
                        "XID+XGetImage"
                    } else {
                        "root"
                    };
                    eprintln!(
                        "[JavaRunner] Encoder {} started ({} capture on {})",
                        encoder, mode_str, tcp_display
                    );
                    pipeline_opt = Some(pipe);
                    selected_mime = mime.to_string();
                    break;
                }
            }
        }
    }

    // If primary capture failed, retry without XID (root capture fallback)
    if pipeline_opt.is_none() {
        eprintln!(
            "[JavaRunner] Primary ximagesrc failed on {}, trying root capture fallback",
            tcp_display
        );

        for (encoder, payloader, mime) in &encoders {
            let fallback_src = format!(
                "ximagesrc display-name=\"{}\" use-damage=0 remote=true show-pointer=false",
                tcp_display
            );
            let pipeline_str = format!(
                "{} ! video/x-raw,framerate=30/1 ! videoscale ! videoconvert ! {} ! {} name=video_pay ! appsink name=video_sink sync=false \
                 audiotestsrc is-live=true wave=silence ! opusenc ! rtpopuspay name=audio_pay ! appsink name=audio_sink sync=false",
                fallback_src, encoder, payloader
            );

            if let Ok(elem) = gst::parse_launch(&pipeline_str) {
                if let Ok(pipe) = elem.dynamic_cast::<gst::Pipeline>() {
                    if pipe.set_state(gst::State::Playing).is_ok() {
                        let bus = pipe.bus().unwrap();
                        if let Some(msg) = bus.timed_pop(gst::ClockTime::from_mseconds(500)) {
                            if let gst::MessageView::Error(err) = msg.view() {
                                eprintln!(
                                    "[JavaRunner] Encoder {} failed (fallback): {}",
                                    encoder,
                                    err.error()
                                );
                                let _ = pipe.set_state(gst::State::Null);
                                continue;
                            }
                        }
                        eprintln!(
                            "[JavaRunner] Encoder {} started (root fallback on {})",
                            encoder, tcp_display
                        );
                        pipeline_opt = Some(pipe);
                        selected_mime = mime.to_string();
                        break;
                    }
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

    // Under `TrackFanout` the producer doesn't own any `TrackLocalStaticRTP`;
    // per-peer tracks are created in `create_peer` and subscribe to these
    // fanouts. `selected_mime` is still useful for operator logs but the
    // per-peer tracks own their own mime (configured at peer creation).
    let _ = selected_mime;

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

    let video_fanout_dispatch = video_fanout.clone();
    tokio::spawn(async move {
        let mut frame_count: u64 = 0;
        while let Some(data) = v_rx.recv().await {
            frame_count += 1;
            if frame_count <= 10
                || frame_count == 30
                || frame_count == 100
                || frame_count % 500 == 0
            {
                eprintln!(
                    "[JavaRunner] Video RTP packet #{}, size={} bytes",
                    frame_count,
                    data.len()
                );
            }
            if let Ok(packet) = Packet::unmarshal(&mut &data[..]) {
                video_fanout_dispatch.dispatch(packet);
            } else if frame_count <= 5 {
                eprintln!(
                    "[JavaRunner] Failed to unmarshal RTP packet #{}",
                    frame_count
                );
            }
        }
        eprintln!(
            "[JavaRunner] Video dispatch task ended, total packets: {}",
            frame_count
        );
    });

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

    let audio_fanout_dispatch = audio_fanout.clone();
    tokio::spawn(async move {
        while let Some(data) = a_rx.recv().await {
            if let Ok(packet) = Packet::unmarshal(&mut &data[..]) {
                audio_fanout_dispatch.dispatch(packet);
            }
        }
    });

    Ok(pipeline)
}

/// Extract GUI window dimensions from Java source code.
///
/// Scans for common Swing/AWT patterns:
///   - `setSize(w, h)`
///   - `new Dimension(w, h)` (used with setPreferredSize, setMinimumSize, etc.)
///   - `setBounds(x, y, w, h)`
///   - `JFrame(... w, h)` constructor with bounds
///
/// Returns `(Some(width), Some(height))` if found, `(None, None)` otherwise.
/// Only integer literals are matched — expressions/variables are ignored
/// (the fallback 800×600 applies).  The last match wins so overrides
/// like `frame.setSize(...)` after construction take precedence.
fn parse_gui_dimensions(source: &str) -> (Option<u32>, Option<u32>) {
    let mut width: Option<u32> = None;
    let mut height: Option<u32> = None;

    for line in source.lines() {
        let trimmed = line.trim();

        // Skip comments
        if trimmed.starts_with("//") || trimmed.starts_with('*') || trimmed.starts_with("/*") {
            continue;
        }

        // setSize(w, h)
        if let Some(args) = extract_call_args(trimmed, "setSize") {
            if let Some((w, h)) = parse_two_ints(&args) {
                width = Some(w);
                height = Some(h);
            }
        }

        // setBounds(x, y, w, h) — take the last two args
        if let Some(args) = extract_call_args(trimmed, "setBounds") {
            let nums: Vec<u32> = args
                .split(',')
                .filter_map(|s| s.trim().parse().ok())
                .collect();
            if nums.len() == 4 {
                width = Some(nums[2]);
                height = Some(nums[3]);
            }
        }

        // new Dimension(w, h)
        if let Some(args) = extract_call_args(trimmed, "Dimension") {
            if let Some((w, h)) = parse_two_ints(&args) {
                width = Some(w);
                height = Some(h);
            }
        }
    }

    // Clamp to reasonable range (minimum 100×100, maximum 1920×1080)
    let clamp = |v: Option<u32>| v.map(|n| n.clamp(100, 1920));
    (clamp(width), clamp(height))
}

/// Extract the argument string from `name(...)` in a line.
/// E.g. `extract_call_args("frame.setSize(400, 200);", "setSize")` → `Some("400, 200")`
fn extract_call_args<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let idx = line.find(name)?;
    let after = &line[idx + name.len()..];
    let open = after.find('(')?;
    let inner = &after[open + 1..];
    let close = inner.find(')')?;
    Some(&inner[..close])
}

/// Parse "w, h" → (w, h) from a two-integer argument string.
fn parse_two_ints(args: &str) -> Option<(u32, u32)> {
    let parts: Vec<&str> = args.split(',').collect();
    if parts.len() == 2 {
        let w: u32 = parts[0].trim().parse().ok()?;
        let h: u32 = parts[1].trim().parse().ok()?;
        Some((w, h))
    } else {
        None
    }
}
