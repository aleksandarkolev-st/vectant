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
    let mut _reused_gst_display = String::new();
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
            // Verify the stored display is still responsive before reusing.
            // TCP probe is the most reliable check — abstract UNIX sockets
            // don't leave a file in /tmp/.X11-unix/ so we can't stat them.
            let display_ok = {
                let num = state.wsl_display_str.trim_start_matches("127.0.0.1:").trim_start_matches(':');
                let port: u16 = 6000 + num.parse::<u16>().unwrap_or(99);
                // Try file socket first (cheapest), then TCP
                std::path::Path::new(&format!("/tmp/.X11-unix/X{}", num)).exists()
                    || tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok()
            };

            if display_ok {
                eprintln!("[JavaRunner] Reusing Xvfb (display={} OK)", state.wsl_display_str);
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
                    video_track_opt = state.video_track;
                    audio_track_opt = state.audio_track;
                }
            } else {
                eprintln!("[JavaRunner] Reuse requested but display {} is dead — full teardown", state.wsl_display_str);
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
    // GStreamer is ALWAYS deferred until after Java spawns, so we can
    // find the actual JFrame window and capture it by XID.  This avoids
    // the Xvfb root-capture problem entirely.
    let mut wsl_display_str = reused_wsl_display;
    let mut xvfb_process: Option<tokio::process::Child> = reused_xvfb;
    let mut gst_pipeline: Option<gst::Pipeline> = reused_pipeline;

    // local_display is ":99" — used for GStreamer root capture (XShm on the root
    // window works perfectly on Xvfb; the issue was only with XShm on child XIDs).
    // tcp_display is "127.0.0.1:99.0" — used for Java AWT and xdotool.
    let mut local_display = String::new();

    if req.is_gui {
        // Start Xvfb if not reused
        if xvfb_process.is_none() {
            let (child, tcp_display, local_disp, _comp) = start_xvfb(ctx, session_id, req_width, req_height).await?;
            xvfb_process = Some(child);
            wsl_display_str = tcp_display;           // Java AWT, xdotool use TCP
            local_display = local_disp;              // GStreamer ximagesrc uses local (XShm on root)
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
        cmd.arg("-Dsun.java2d.xrender=false");     // avoid XRender bugs over TCP
        cmd.arg("-Dsun.java2d.pmoffscreen=false");  // paint directly to X window (not offscreen pixmap)
        cmd.arg("-Dsun.java2d.opengl=false");       // disable OpenGL pipeline
        cmd.arg("-Dsun.awt.noerasebackground=true"); // reduce white-flash flicker
    }

    cmd.arg(main_class);

    if req.is_gui {
        cmd.env("DISPLAY", &wsl_display_str);
        cmd.env("AWT_TOOLKIT", "XToolkit");     // force X11 toolkit
        cmd.env("GDK_BACKEND", "x11");           // GTK fallback
        // WM reparenting compat — some WMs break AWT without this
        cmd.env("_JAVA_AWT_WM_NONREPARENTING", "1");
        // Reinforce Java2D flags via env (in case cmd args have ordering issues)
        cmd.env("JAVA_TOOL_OPTIONS",
            "-Dsun.java2d.pmoffscreen=false -Dsun.java2d.opengl=false -Dsun.java2d.xrender=false");
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    eprintln!(
        "[JavaRunner] Spawning: java -cp {:?} {} {} (GUI={}, DISPLAY={})",
        classes_dir,
        if req.is_gui { "-Djava.awt.headless=false -Dsun.java2d.xrender=false" } else { "" },
        main_class,
        req.is_gui,
        if req.is_gui { &wsl_display_str } else { &String::new() }
    );

    let mut child = cmd.spawn().context("Failed to spawn java — is openjdk installed?")?;

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
            eprintln!("[JavaRunner] Window 0x{:x} mapped and visible, forcing fullscreen...", xid);

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
                eprintln!("[JavaRunner] Window geometry after resize: {}", geo_text.trim());
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
                        bytes.len(), sample.len()
                    );
                } else {
                    eprintln!("[JavaRunner] xwd root: only {} bytes (too small)", bytes.len());
                }
            }

            eprintln!("[JavaRunner] Starting ROOT capture (window 0x{:x} fills {}x{} screen)", xid, req_width, req_height);
        } else {
            eprintln!("[JavaRunner] WARNING: No window found, root capture may show only background");
        }

        // Root capture — no XID, same approach as the C++ runner.
        //
        // DISPLAY SELECTION: We must verify that the chosen display
        // is actually reachable before handing it to ximagesrc.  In
        // containers, UNIX file sockets often fail to create, and
        // abstract sockets may or may not work.  If local ":99" fails,
        // fall back to TCP which is guaranteed to work.
        let gst_display = if !local_display.is_empty() {
            // Test if local display is reachable
            let local_ok = Command::new("xdpyinfo")
                .env("DISPLAY", &local_display)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await
                .map(|s| s.success())
                .unwrap_or(false);
            if local_ok {
                eprintln!("[JavaRunner] Local display {} verified OK — using for GStreamer (XShm)", local_display);
                local_display.clone()
            } else {
                eprintln!("[JavaRunner] Local display {} NOT reachable — falling back to TCP {}", local_display, wsl_display_str);
                wsl_display_str.clone()
            }
        } else {
            wsl_display_str.clone()
        };
        let (pipeline, v_track, a_track) =
            start_gstreamer(&gst_display, session_id, None).await?;
        gst_pipeline = Some(pipeline);
        video_track_opt = Some(v_track);
        audio_track_opt = Some(a_track);

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
                        .arg("windowminimize").arg("--sync").arg(format!("0x{:x}", xid))
                        .env("DISPLAY", &repaint_display)
                        .output().await;
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                    let _ = Command::new("xdotool")
                        .arg("windowactivate").arg("--sync").arg(format!("0x{:x}", xid))
                        .env("DISPLAY", &repaint_display)
                        .output().await;
                    eprintln!("[JavaRunner] Forced repaint cycle {} for window 0x{:x}", i + 1, xid);
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
                .arg("-out").arg(screenshot_path)
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
                            if size > 100_000 { "has content" } else { "suspiciously small" }
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
                            eprintln!("[JavaRunner] Inspecting matchbox frame {} children:", xid_str);
                            if let Ok(sub) = Command::new("xwininfo")
                                .arg("-id").arg(xid_str)
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
        gst_display_str: if local_display.is_empty() { wsl_display_str.clone() } else { local_display.clone() },
        wsl_display_str,
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
            eprintln!("[JavaRunner] Attaching tracks to {} transceivers", transceivers.len());
            let mut video_replaced = false;
            let mut audio_replaced = false;
            if let Some(track) = &state.video_track {
                for t in &transceivers {
                    if t.kind() == webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Video {
                        match t
                            .sender()
                            .await
                            .replace_track(Some(
                                Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>,
                            ))
                            .await
                        {
                            Ok(_) => {
                                eprintln!("[JavaRunner] ✓ Video track replaced successfully");
                                video_replaced = true;
                            }
                            Err(e) => eprintln!("[JavaRunner] ✗ Video replace_track error: {}", e),
                        }
                        break;
                    }
                }
            }
            if let Some(track) = &state.audio_track {
                for t in &transceivers {
                    if t.kind() == webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Audio {
                        match t
                            .sender()
                            .await
                            .replace_track(Some(
                                Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>,
                            ))
                            .await
                        {
                            Ok(_) => {
                                eprintln!("[JavaRunner] ✓ Audio track replaced successfully");
                                audio_replaced = true;
                            }
                            Err(e) => eprintln!("[JavaRunner] ✗ Audio replace_track error: {}", e),
                        }
                        break;
                    }
                }
            }
            if !video_replaced {
                eprintln!("[JavaRunner] WARNING: No video transceiver found to replace!");
            }
            if !audio_replaced {
                eprintln!("[JavaRunner] WARNING: No audio transceiver found to replace!");
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

/// Start Xvfb and matchbox-window-manager.
/// Returns `(child, tcp_display, local_display, has_compositor)` where:
///   - `tcp_display` is a TCP-based DISPLAY (e.g. `127.0.0.1:99.0`) for
///     clients like Java that need TCP to connect.
///   - `local_display` is a local DISPLAY (`:99`) for local X11 access.
///   - `has_compositor` is always false — we intentionally skip compositors
///     because they redirect child windows offscreen, breaking XID capture.
async fn start_xvfb(
    ctx: &CompileContext,
    session_id: &str,
    width: u32,
    height: u32,
) -> Result<(tokio::process::Child, String, String, bool)> {
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

    // Start Xvfb with TCP enabled as a safety net.
    // We deliberately DO NOT pass `-nolisten local` — abstract UNIX sockets
    // (a Linux kernel feature, no filesystem permissions needed) are the
    // preferred transport for local X11 connections because they:
    //   1. Always work in containers (no /tmp/.X11-unix permission issues)
    //   2. Support XShm (shared-memory screen capture for ximagesrc)
    //   3. Are lower-latency than TCP
    // `-listen tcp` is kept as an explicit fallback in case abstract sockets
    // fail for any reason.  We omit `-listen unix` since the file-based
    // socket in /tmp/.X11-unix often fails due to directory permissions.
    // Match the C++ stages runner Xvfb config exactly:
    //   Xvfb :99 -screen 0 WxHx24 -ac
    // Previously we added -listen tcp, +extension RENDER, -extension Composite
    // but these caused the framebuffer to NOT update after the initial paint.
    // The C++ runner works without any of those flags.
    // We add -listen tcp as the ONLY extra so Java AWT can connect via TCP
    // (UNIX sockets often fail in containers).
    let mut xvfb_cmd = Command::new("Xvfb");
    xvfb_cmd
        .arg(format!(":{}", display_num))
        .arg("-screen").arg("0").arg(format!("{}x{}x24", width, height))
        .arg("-ac")
        .arg("-listen").arg("tcp")
        .kill_on_drop(true);

    let child = xvfb_cmd.spawn().context("Failed to spawn Xvfb")?;

    // Wait for Xvfb to be ready.  Check both the UNIX socket and TCP port.
    let socket_path = format!("/tmp/.X11-unix/X{}", display_num);
    let tcp_port: u16 = 6000 + display_num as u16;
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(5);

    let mut display_str = String::new();
    loop {
        // 1. Prefer UNIX file socket (lowest latency, XShm works)
        if std::path::Path::new(&socket_path).exists() {
            display_str = format!(":{}", display_num);
            eprintln!("[JavaRunner] Xvfb ready via UNIX file socket: {}", socket_path);
            break;
        }
        // 2. TCP probe — Xvfb is running on TCP.
        //    We previously tried DISPLAY=:N (abstract sockets) here, but
        //    in many container environments abstract sockets are not
        //    available or not enabled by Xvfb.  Java AWT then silently
        //    fails to connect and no window appears.
        //    Use the explicit TCP address which is guaranteed to work.
        if tokio::net::TcpStream::connect(("127.0.0.1", tcp_port)).await.is_ok() {
            display_str = format!("127.0.0.1:{}.0", display_num);
            eprintln!(
                "[JavaRunner] Xvfb TCP port {} responding; using DISPLAY={}",
                tcp_port, display_str
            );
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            // Last resort — try TCP address anyway since it's the most reliable
            display_str = format!("127.0.0.1:{}.0", display_num);
            eprintln!(
                "[JavaRunner] WARNING: Xvfb not confirmed after 5s, using DISPLAY={}",
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
    let _wm = wm_cmd.spawn().context("Failed to spawn matchbox-window-manager")?;

    // NOTE: We do NOT start a compositor (xcompmgr, picom, compton).
    // Without a compositor, Xvfb manages compositing natively — child
    // windows' painted content is embedded in the root framebuffer.
    // This is the same approach the C++ stages runner uses.
    let compositor_ok = false;

    // Set root window to a dark color (looks like "loading" in the video widget).
    // If only this color is visible, the app window isn't mapped/painted yet.
    let _ = Command::new("xsetroot")
        .arg("-solid").arg("#1a1a2e")
        .env("DISPLAY", &display_str)
        .output()
        .await;

    // Give the WM a moment to register with X
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    eprintln!("[JavaRunner] Xvfb + WM started (no compositor), DISPLAY={}", display_str);

    let local_display = format!(":{}", display_num);
    eprintln!(
        "[JavaRunner] Display strings: tcp={} local={} compositor={}",
        display_str, local_display, compositor_ok
    );
    Ok((child, display_str, local_display, compositor_ok))
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
                .arg("-id").arg(format!("0x{:x}", frame_xid))
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
                        child_xid, best_child_area / expected_height as u64, best_child_area
                    );
                    return Some(child_xid);
                }

                // No sizeable child yet — JFrame may not be reparented yet
                eprintln!(
                    "[JavaRunner] Matchbox frame found but no JFrame child yet, retrying..."
                );
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
            eprintln!("[JavaRunner] find_gui_window: no suitable window found within {}ms", timeout_ms);
            return None;
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
    }
}

async fn start_gstreamer(
    tcp_display: &str,
    _session_id: &str,
    window_xid: Option<u64>,
) -> Result<(gst::Pipeline, Arc<TrackLocalStaticRTP>, Arc<TrackLocalStaticRTP>)> {
    let encoders = [
        ("nvh264enc preset=low-latency-hp zerolatency=true ! video/x-h264,stream-format=byte-stream,profile=constrained-baseline", "rtph264pay", "video/H264"),
        ("vaapih264enc ! video/x-h264,stream-format=byte-stream,profile=constrained-baseline", "rtph264pay", "video/H264"),
        ("x264enc tune=zerolatency speed-preset=ultrafast bitrate=2000 key-int-max=60 ! video/x-h264,stream-format=byte-stream,profile=constrained-baseline", "rtph264pay", "video/H264"),
        ("vp8enc deadline=1 cpu-used=4 end-usage=cbr target-bitrate=2000000", "rtpvp8pay", "video/VP8"),
    ];

    let mut pipeline_opt: Option<gst::Pipeline> = None;
    let mut selected_mime = "video/H264".to_string();

    // Build the ximagesrc element string based on capture mode:
    //
    // For XID capture: use TCP + remote=true (XGetImage).
    // For ROOT capture: prefer local display (XShm) for continuous
    //     frame updates.  TCP+remote=true froze after the first frame.
    //     XShm on root works perfectly on Xvfb — the issue was only
    //     with XShm on child window XIDs.
    //
    // show-pointer=false avoids cursor artifacts in the stream.
    let ximagesrc_str = if let Some(xid) = window_xid {
        eprintln!(
            "[JavaRunner] ximagesrc: capturing JFrame window xid=0x{:x} on display={} (TCP+XGetImage)",
            xid, tcp_display
        );
        format!(
            "ximagesrc display-name=\"{}\" xid=0x{:x} use-damage=0 remote=true show-pointer=false",
            tcp_display, xid
        )
    } else {
        // Root capture: prefer local display for XShm (continuous updates).
        // Do NOT use remote=true here — XShm on the root window works fine
        // on Xvfb and gives continuous frame re-reads.
        // TCP+remote=true caused the capture to freeze after the first frame.
        let is_tcp = tcp_display.contains("127.0.0.1") || tcp_display.contains(':') && tcp_display.chars().next().map_or(false, |c| c.is_ascii_digit());
        eprintln!(
            "[JavaRunner] ximagesrc: ROOT capture on display={} (local_xshm={}, includes all visible windows)",
            tcp_display, !is_tcp
        );
        if is_tcp {
            // TCP display — must use remote=true
            format!(
                "ximagesrc display-name=\"{}\" use-damage=0 remote=true show-pointer=false",
                tcp_display
            )
        } else {
            // Local display — use XShm (default, no remote=true)
            format!(
                "ximagesrc display-name=\"{}\" use-damage=0 show-pointer=false",
                tcp_display
            )
        }
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
                    let mode_str = if window_xid.is_some() { "XID+XGetImage" } else { "root" };
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
                                eprintln!("[JavaRunner] Encoder {} failed (fallback): {}", encoder, err.error());
                                let _ = pipe.set_state(gst::State::Null);
                                continue;
                            }
                        }
                        eprintln!("[JavaRunner] Encoder {} started (root fallback on {})", encoder, tcp_display);
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
        let mut frame_count: u64 = 0;
        while let Some(data) = v_rx.recv().await {
            frame_count += 1;
            if frame_count <= 10 || frame_count == 30 || frame_count == 100 || frame_count % 500 == 0 {
                eprintln!(
                    "[JavaRunner] Video RTP packet #{}, size={} bytes",
                    frame_count, data.len()
                );
            }
            if let Err(e) = vt.write(&data).await {
                if e.to_string().contains("closed") {
                    eprintln!("[JavaRunner] Video track closed after {} packets", frame_count);
                    break;
                }
                // Log first few write errors — often indicates track not yet bound
                if frame_count <= 5 {
                    eprintln!("[JavaRunner] Video write error (packet #{}): {}", frame_count, e);
                }
            }
        }
        eprintln!("[JavaRunner] Video writer task ended, total packets: {}", frame_count);
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
