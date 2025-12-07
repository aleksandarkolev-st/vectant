
import os

file_path = r"c:\Users\dev\Downloads\synthi-test\synthi-ide\backend\synthi-webrtc-compiler\worker\src\main.rs"

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# We need to restructure handle_compile.
# The plan is to:
# 1. Identify the start of handle_compile.
# 2. Identify the `if req.use_ai_split` block.
# 3. Identify the standard compilation block.
# 4. Identify the runner execution block (which is duplicated).

# We will rewrite handle_compile to:
# - Prepare `modules_to_load` (Vec<(String, String)>)
# - If AI split:
#   - Do AI split logic
#   - Compile core/gui
#   - Add to modules_to_load
# - Else:
#   - Do standard compile
#   - Atomic swap
#   - Add to modules_to_load
# - Unified Runner Logic (using modules_to_load)

# Let's find the markers.
start_marker = "async fn handle_compile("
end_marker = "Ok(())\n}"

start_idx = content.find(start_marker)
# Find the matching closing brace for the function is hard with simple find.
# But we know the function ends at the end of the file (almost).
# Actually, verify_tooling is after it.

verify_marker = "async fn verify_tooling() -> Result<()> {"
end_idx = content.find(verify_marker)

if start_idx == -1 or end_idx == -1:
    print("Could not find function boundaries")
    exit(1)

# Extract the function body
func_body = content[start_idx:end_idx]

# We will construct the new function body.
# We need to keep the signature.
sig_end = func_body.find("{") + 1
signature = func_body[:sig_end]

# Common setup
setup_code = """
    // Use the shared workspace path instead of creating a new temp dir
    let dir_path = workspace_path;

    // Check if we need to restart due to GUI mode change or blocking app
    // We do this early because we consume req.files later
    let has_on_update = req.source.contains("on_update") || req.files.iter().any(|f| f.content.contains("on_update"));

    // Generate a unique filename for the shared library to support HMR
    let timestamp = Utc::now().timestamp_millis();
    let ext = if cfg!(target_os = "windows") { "dll" } else { "so" };
    
    // Phase 3: RAM-Based Compilation Pipeline
    // Use /dev/shm on Linux to avoid disk I/O
    let (output_dir, _is_shm) = if cfg!(target_os = "linux") {
        (std::path::PathBuf::from("/dev/shm"), true)
    } else {
        (dir_path.clone(), false)
    };

    let lib_filename = format!("libuser_code_{}.{}", timestamp, ext);
    let final_output_path = output_dir.join(&lib_filename);
    
    // Atomic swap: compile to temp file first
    let temp_filename = format!("temp_{}.{}", timestamp, ext);
    let temp_output_path = output_dir.join(&temp_filename);
    let temp_output_path_str = temp_output_path.to_string_lossy().to_string();

    // Clean up old shared libraries in output_dir
    if let Ok(mut entries) = tokio::fs::read_dir(&output_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if (name.starts_with("libuser_code_") || name.starts_with("temp_")) && (name.ends_with(".so") || name.ends_with(".dll")) {
                    let _ = tokio::fs::remove_file(path).await;
                }
            }
        }
    }
    
    // Write the main file
    let file_path = dir_path.join(&req.filename);
    // Clone session id locally so we can move it into spawned tasks without
    // invalidating the `req` value for later use.
    let session_id = req.session_id.clone();
    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let mut source_code = req.source.clone();
    if req.language == "rust" {
        // Check if user already defined entrypoint to avoid conflict
        if !source_code.contains("extern \\"C\\" fn entrypoint") {
             source_code.push_str("\\n\\n#[no_mangle]\\npub extern \\"C\\" fn entrypoint(_state: *mut std::ffi::c_void) -> *mut std::ffi::c_void {\\n    main();\\n    std::ptr::null_mut()\\n}\\n");
        }
    } else if req.language == "cpp" || req.language == "cpp_legacy" {
        if !source_code.contains("extern \\"C\\" void* entrypoint") {
             source_code.push_str("\\n\\nextern \\"C\\" void* entrypoint(void* state) {\\n    main();\\n    return 0;\\n}\\n");
        }
    }
    tokio::fs::write(&file_path, &source_code).await?;
    println!("Main file written to {:?}", file_path);

    // Write additional files
    for file in &req.files {
        println!("Writing additional file: {}", file.name);
        let p = dir_path.join(&file.name);
        // Ensure parent directories exist if the file is in a subdirectory
        if let Some(parent) = p.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&p, &file.content).await?;
    }

    let mut modules_to_load: Vec<(String, String)> = Vec::new();
    
    fn calculate_hash<T: Hash>(t: &T) -> u64 {
        let mut s = DefaultHasher::new();
        t.hash(&mut s);
        s.finish()
    }
"""

ai_logic = """
    if req.use_ai_split {
        let split_data = match perform_ai_split(&req).await {
            Ok(d) => d,
            Err(e) => {
                let payload = serde_json::json!({
                    "sessionId": session_id.clone(),
                    "status": "done",
                    "success": false,
                    "stage": "ai_split",
                    "error": format!("AI Split failed: {}", e)
                });
                let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                return Ok(());
            }
        };

        let mut core_lib_path = String::new();
        let mut gui_lib_path = String::new();

        if let Some(shared) = split_data.get("shared") {
            let fname = shared["filename"].as_str().unwrap_or("shared.h");
            let content = shared["content"].as_str().unwrap_or("");
            println!("Writing shared library file: {}", fname);
            tokio::fs::write(dir_path.join(fname), content).await?;
        }

        if let Some(core) = split_data.get("core") {
            let fname = core["filename"].as_str().unwrap_or("core.cpp");
            let content = core["content"].as_str().unwrap_or("");
            let content_hash = calculate_hash(&content);
            
            let mut cached_path = None;
            {
                let cache = compile_cache.lock().await;
                if let Some((h, p)) = cache.get("core") {
                    if *h == content_hash {
                        cached_path = Some(p.clone());
                    }
                }
            }

            if let Some(p) = cached_path {
                core_lib_path = p;
                println!("Using cached core library: {}", core_lib_path);
            } else {
                tokio::fs::write(dir_path.join(fname), content).await?;
                
                let core_out = output_dir.join(format!("libcore_{}.{}", timestamp, ext));
                let mut cmd = system_command("g++");
                cmd.arg("-shared").arg("-fPIC")
                   .arg("-D_POSIX_C_SOURCE=199309L")
                   .arg(fname).arg("-I.").arg("-o").arg(&core_out);
                cmd.current_dir(&dir_path);
                
                let output = cmd.output().await?;
                if !output.status.success() {
                     let stderr = String::from_utf8_lossy(&output.stderr);
                     let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "status": "done",
                        "success": false,
                        "stage": "compile_core",
                        "error": stderr
                    });
                    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                    return Ok(());
                }
                core_lib_path = core_out.to_string_lossy().to_string();
                
                let mut cache = compile_cache.lock().await;
                cache.insert("core".to_string(), (content_hash, core_lib_path.clone()));
            }
            if !core_lib_path.is_empty() {
                modules_to_load.push(("core".to_string(), core_lib_path.clone()));
            }
        }

        if let Some(gui) = split_data.get("gui") {
            let fname = gui["filename"].as_str().unwrap_or("gui.cpp");
            let content = gui["content"].as_str().unwrap_or("");
            
            // Hash content + core_lib_path dependency
            let combined_hash = calculate_hash(&(content, &core_lib_path));
            
            let mut cached_path = None;
            {
                let cache = compile_cache.lock().await;
                if let Some((h, p)) = cache.get("gui") {
                    if *h == combined_hash {
                        cached_path = Some(p.clone());
                    }
                }
            }

            if let Some(p) = cached_path {
                gui_lib_path = p;
                println!("Using cached gui library: {}", gui_lib_path);
            } else {
                tokio::fs::write(dir_path.join(fname), content).await?;
                
                let gui_out = output_dir.join(format!("libgui_{}.{}", timestamp, ext));
                let mut cmd = system_command("g++");
                cmd.arg("-shared").arg("-fPIC")
                   .arg("-D_POSIX_C_SOURCE=199309L")
                   .arg(fname).arg("-I.").arg("-o").arg(&gui_out);
                
                if req.is_gui {
                    cmd.arg("-lX11");
                }
                if !core_lib_path.is_empty() {
                    cmd.arg(&core_lib_path);
                }

                cmd.current_dir(&dir_path);
                
                let output = cmd.output().await?;
                if !output.status.success() {
                     let stderr = String::from_utf8_lossy(&output.stderr);
                     let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "status": "done",
                        "success": false,
                        "stage": "compile_gui",
                        "error": stderr
                    });
                    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                    return Ok(());
                }
                gui_lib_path = gui_out.to_string_lossy().to_string();
                
                let mut cache = compile_cache.lock().await;
                cache.insert("gui".to_string(), (combined_hash, gui_lib_path.clone()));
            }
            if !gui_lib_path.is_empty() {
                modules_to_load.push(("gui".to_string(), gui_lib_path.clone()));
            }
        }
    } else {
        // Standard Compilation Logic
        let mut cmd = match req.language.as_str() {
            "cpp" | "cpp_legacy" => {
                let mut c = system_command("g++");
                c.arg("-shared").arg("-fPIC").arg("-D_POSIX_C_SOURCE=199309L");
                // Output to temp path for atomic swap
                c.arg(&req.filename).arg("-I.").arg("-o").arg(&temp_output_path_str);
                if req.is_gui {
                    c.arg("-lX11");
                }
                c
            }
            "rust" => {
                let mut c = system_command("rustc");
                c.arg("--crate-type").arg("cdylib");
                // Output to temp path for atomic swap
                c.arg(&req.filename).arg("-o").arg(&temp_output_path_str);
                if req.is_gui {
                    c.arg("-l").arg("X11");
                }
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

        // Phase 3: Atomic Swap
        // Rename temp file to final filename
        if let Err(e) = tokio::fs::rename(&temp_output_path, &final_output_path).await {
            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "status": "done",
                "success": false,
                "stage": "compile",
                "code": 1,
                "error": format!("Failed to rename temp file: {}", e)
            });
            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_else(|_| String::from(""))).await;
            return Ok(());
        }
        
        modules_to_load.push(("main".to_string(), final_output_path.to_string_lossy().to_string()));
    }
"""

runner_logic = """
    // Unified Runner Logic
    // We only proceed if we have modules to load (or if it's TS which we don't handle here yet, but TS returns early above)
    if modules_to_load.is_empty() {
        return Ok(());
    }

    let mut guard = runner_store.lock().await;
    
    // Check if we need to restart due to GUI mode change or blocking app
    // We restart if:
    // 1. GUI mode changed (need to start/stop Xvfb)
    // 2. App is blocking (no on_update), so the runner is blocked and can't accept new commands.
    let is_blocking_app = !has_on_update;
    let req_width = req.width.unwrap_or(1280);
    let req_height = req.height.unwrap_or(720);
    
    // Reuse Xvfb/GStreamer if possible
    let mut reused_xvfb: Option<tokio::process::Child> = None;
    let mut reused_pipeline: Option<gst::Pipeline> = None;
    let mut reused_wsl_display = String::new();
    let mut reused_gst_display = String::new();
    let mut reused_x11_tx: Option<mpsc::UnboundedSender<String>> = None;
    let mut video_track_opt: Option<Arc<TrackLocalStaticRTP>> = None;
    let mut audio_track_opt: Option<Arc<TrackLocalStaticRTP>> = None;

    if let Some(state) = guard.as_mut() {
        let needs_restart = state.is_gui != req.is_gui || is_blocking_app;
        if needs_restart {
            println!("Restarting runner due to GUI mode change or blocking app detected");
            // If resolution matches and is_gui matches, we can reuse Xvfb/GStreamer
            let can_reuse = state.is_gui == req.is_gui && state.width == req_width && state.height == req_height;
            
            let mut state = guard.take().unwrap();
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
                reused_x11_tx = state.x11_tx;
            } else {
                println!("Full restart (resolution/GUI mode changed)...");
                if let Some(mut child) = state.xvfb_process { let _ = child.kill().await; }
                if let Some(pipeline) = state.gst_pipeline { let _ = pipeline.set_state(gst::State::Null); }
            }
        }
    }
    
    if guard.is_none() {
        // Start runner
        println!("Starting persistent runner...");
        
        let mut wsl_display_str = reused_wsl_display;
        let mut gst_display_str = reused_gst_display;
        let mut xvfb_process: Option<tokio::process::Child> = reused_xvfb;
        let mut gst_pipeline: Option<gst::Pipeline> = reused_pipeline;
        let mut x11_tx_opt: Option<mpsc::UnboundedSender<String>> = reused_x11_tx;

        if req.is_gui {
            let width = req_width;
            let height = req_height;
            
            if xvfb_process.is_none() {
                for tool in GUI_TOOLS {
                    if Command::new(tool).arg("--version").output().await.is_err() {
                            let msg = format!("Error: GUI tool '{}' is missing. GUI apps require Linux/WSL with xdotool, Xvfb, and matchbox-window-manager installed.\\n", tool);
                            let payload = serde_json::json!({
                            "sessionId": session_id.clone(),
                            "type": "stderr",
                            "line": msg
                            });
                            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                            return Ok(());
                    }
                }

                let resolution = format!("{}x{}x24", width, height);

                let mut xvfb = system_command("Xvfb");
                xvfb.arg("-displayfd").arg("1")
                    .arg("-screen")
                    .arg("0")
                    .arg(&resolution)
                    .arg("-ac")
                    .arg("-listen")
                    .arg("tcp")
                    .arg("-s").arg("0")
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
                                wsl_display_str = format!(":{}", display_num);
                                if cfg!(target_os = "windows") {
                                    gst_display_str = format!("127.0.0.1:{}", display_num);
                                } else {
                                    gst_display_str = wsl_display_str.clone();
                                }
                                println!("Xvfb started on display {}", wsl_display_str);
                            }
                            _ => eprintln!("Xvfb failed to output a display number"),
                        }
                    }
                    xvfb_process = Some(child);
                }
                Err(e) => eprintln!("Failed to spawn Xvfb: {}", e),
                }

            if wsl_display_str.is_empty() {
                wsl_display_str = ":99".to_string();
                if cfg!(target_os = "windows") {
                    gst_display_str = "127.0.0.1:99".to_string();
                } else {
                    gst_display_str = wsl_display_str.clone();
                }
                println!("Falling back to DISPLAY {}", wsl_display_str);
            }

            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            let mut wm_cmd = if cfg!(target_os = "windows") {
                let mut c = system_command("env");
                c.arg(format!("DISPLAY={}", wsl_display_str)).arg("matchbox-window-manager");
                c
            } else {
                let mut c = Command::new("matchbox-window-manager");
                c.env("DISPLAY", &wsl_display_str);
                c
            };

            wm_cmd.stdout(Stdio::null()).stderr(Stdio::null());
            let _ = wm_cmd.spawn(); // Let it run

            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

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
                ("nvh264enc preset=low-latency-hp zerolatency=true", "rtph264pay", "video/H264"),
                ("vaapih264enc", "rtph264pay", "video/H264"),
                ("msdkh264enc", "rtph264pay", "video/H264"),
                ("v4l2h264enc", "rtph264pay", "video/H264"),
                ("mfh264enc low-latency=true", "rtph264pay", "video/H264"),
                ("d3d11h264enc", "rtph264pay", "video/H264"),
                ("amfh264enc", "rtph264pay", "video/H264"),
                ("x264enc tune=zerolatency speed-preset=ultrafast bitrate=2000 key-int-max=60 ! video/x-h264,stream-format=byte-stream", "rtph264pay", "video/H264"),
                ("openh264enc ! video/x-h264,stream-format=byte-stream", "rtph264pay", "video/H264"),
                ("x265enc tune=zerolatency speed-preset=ultrafast bitrate=2000 key-int-max=60 ! video/x-h265,stream-format=byte-stream", "rtph265pay", "video/H265"),
                ("openh265enc ! video/x-h265,stream-format=byte-stream", "rtph265pay", "video/H265"),
            ];

            let mut selected_mime_type = "video/H265".to_owned();
            let mut audio_source = "pulsesrc".to_string();
            let mut encoder_idx = 0;

            while encoder_idx < encoders.len() {
                let (encoder, payloader, mime_type) = encoders[encoder_idx];
                if mime_type == "video/H265" && req.supports_h265 == Some(false) {
                    encoder_idx += 1;
                    continue;
                }

                let gst_pipeline_str = format!(
                    "ximagesrc display-name={} use-damage=false show-pointer=false ! video/x-raw,framerate=30/1 ! queue ! videoconvert ! {} ! {} config-interval=-1 ! queue ! appsink name=video_sink drop=true max-buffers=100 \
                        {} ! audio/x-raw,rate=48000,channels=2 ! queue ! opusenc ! rtpopuspay ! queue ! appsink name=audio_sink drop=true max-buffers=100",
                    gst_display_str, encoder, payloader, audio_source
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
                            let mut pulse_error = false;
                            if let Some(bus) = pipeline.bus() {
                                while let Some(msg) = bus.timed_pop(gst::ClockTime::from_mseconds(100)) {
                                    match msg.view() {
                                        gst::MessageView::Error(err) => {
                                            let (src, msg, dbg) = (err.src().map(|s| s.path_string()).unwrap_or_default(), err.error(), err.debug());
                                            if src.contains("pulsesrc") || (dbg.as_ref().map(|d| d.contains("Connection refused")).unwrap_or(false)) {
                                                pulse_error = true;
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            if pulse_error && audio_source == "pulsesrc" {
                                audio_source = "audiotestsrc is-live=true wave=silence".to_string();
                                continue;
                            }
                            encoder_idx += 1;
                            continue;
                        }
                        println!("Successfully started pipeline with encoder: {}", encoder);
                        gst_pipeline = Some(pipeline);
                        selected_mime_type = mime_type.to_owned();
                        break;
                    }
                    Err(e) => {
                        eprintln!("Failed to create GStreamer pipeline with encoder {}: {}", encoder, e);
                        encoder_idx += 1;
                    }
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

            video_track_opt = Some(video_track.clone());
            audio_track_opt = Some(audio_track.clone());

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

            let mut xdotool = if cfg!(target_os = "windows") {
                let mut c = system_command("env");
                c.arg(format!("DISPLAY={}", wsl_display_str)).arg("xdotool").arg("-");
                c
            } else {
                let mut c = Command::new("xdotool");
                c.arg("-").env("DISPLAY", &wsl_display_str);
                c
            };

            xdotool.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            if let Ok(mut xdotool_child) = xdotool.spawn() {
                if let Some(mut xdotool_stdin) = xdotool_child.stdin.take() {
                    let (x11_tx, mut x11_rx) = mpsc::unbounded_channel::<String>();
                    if let Some(sid) = session_id.clone() { let mut guard = x11_input_store.lock().await; guard.insert(sid, x11_tx.clone()); }
                    x11_tx_opt = Some(x11_tx);
                    
                    tokio::spawn(async move {
                        while let Some(mut cmd) = x11_rx.recv().await {
                            if cmd.starts_with("mousemove ") {
                                while let Ok(next) = x11_rx.try_recv() {
                                    if next.starts_with("mousemove ") {
                                        cmd = next;
                                    } else {
                                        if let Err(_) = xdotool_stdin.write_all(cmd.as_bytes()).await {}
                                        let _ = xdotool_stdin.write_all(b"\\n").await;
                                        cmd = next;
                                        break;
                                    }
                                }
                            }
                            if let Err(_) = xdotool_stdin.write_all(cmd.as_bytes()).await { break; }
                            let _ = xdotool_stdin.write_all(b"\\n").await;
                            let _ = xdotool_stdin.flush().await;
                        }
                        drop(xdotool_stdin);
                        let _ = xdotool_child.wait().await;
                    });
                }
            }

            let payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "run-gui-start",
                "width": width,
                "height": height,
                "display": wsl_display_str
            });
            let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
        }
        }

        let exe_path = std::env::current_exe()?;
        let runner_path = exe_path.parent().unwrap().join(if cfg!(target_os = "windows") { "runner.exe" } else { "runner" });
        
        let mut cmd = Command::new(runner_path);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        if req.is_gui {
            cmd.env("DISPLAY", &wsl_display_str);
            if cfg!(target_os = "windows") {
                cmd.env("WSLENV", "DISPLAY");
            }
        }
        
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        
        let (tx, _) = tokio::sync::broadcast::channel(100);
        let tx_clone = tx.clone();
        
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {
                        let _ = tx_clone.send(format!("STDOUT:{}", line));
                    }
                    Err(_) => break,
                }
            }
        });
        
        let tx_clone2 = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {
                        let _ = tx_clone2.send(format!("STDERR:{}", line));
                    }
                    Err(_) => break,
                }
            }
        });

        *guard = Some(RunnerState {
            process: Some(child),
            stdin,
            output_tx: tx,
            is_gui: req.is_gui,
            xvfb_process,
            gst_pipeline,
            x11_tx: x11_tx_opt,
            video_track: video_track_opt,
            audio_track: audio_track_opt,
            width: req_width,
            height: req_height,
            wsl_display_str,
            gst_display_str,
        });
    }

    if let Some(state) = guard.as_mut() {
        // Ensure tracks are attached to the current PC
        if let (Some(v_track), Some(a_track)) = (&state.video_track, &state.audio_track) {
            let transceivers = pc.get_transceivers().await;
            for t in transceivers {
                let kind = t.kind();
                if kind == RTPCodecType::Video {
                    let sender = t.sender().await;
                    let _ = sender.replace_track(Some(Arc::clone(v_track) as Arc<dyn TrackLocal + Send + Sync>)).await;
                } else if kind == RTPCodecType::Audio {
                    let sender = t.sender().await;
                    let _ = sender.replace_track(Some(Arc::clone(a_track) as Arc<dyn TrackLocal + Send + Sync>)).await;
                }
            }
        }

        // Subscribe to output
        let mut rx = state.output_tx.subscribe();
        let log_dc_clone = log_dc.clone();
        let sid = session_id.clone();
        
        tokio::spawn(async move {
            while let Ok(msg) = rx.recv().await {
                if let Some((type_str, content)) = msg.split_once(':') {
                        let msg_type = if type_str == "STDOUT" { "run-stdout" } else { "run-stderr" };
                        let payload = serde_json::json!({
                        "sessionId": sid.clone(),
                        "type": msg_type,
                        "line": content
                    });
                    let _ = log_dc_clone.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                }
            }
        });

        // Register x11 input for this session
        if let Some(tx) = &state.x11_tx {
            if let Some(sid) = session_id.clone() {
                let mut g = x11_input_store.lock().await;
                g.insert(sid, tx.clone());
            }
        }

        // Load Modules
        for (name, path) in modules_to_load {
            let cmd = format!("load {} {}\\n", name, path);
            println!("Sending command to runner: {}", cmd.trim());
            state.stdin.write_all(cmd.as_bytes()).await?;
        }
        state.stdin.flush().await?;
    }
    
    // Send HMR update notification to frontend
    let hmr_payload = serde_json::json!({
        "sessionId": session_id.clone(),
        "type": "update",
        "hash": timestamp.to_string()
    });
    let _ = log_dc.send_text(serde_json::to_string(&hmr_payload).unwrap_or_default()).await;

    // Send success
    let payload = serde_json::json!({
        "sessionId": session_id.clone(),
        "status": "done",
        "success": true,
        "stage": "run"
    });
    let _ = log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
    
    return Ok(());
"""

new_func_body = signature + setup_code + ai_logic + runner_logic + "}\n"

# Replace the function body
new_content = content[:start_idx] + new_func_body + content[end_idx + len(end_marker):]

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(new_content)

print("Successfully refactored handle_compile")
