// ============================================================
// FLUTTER EMULATOR JOB HANDLER
// ============================================================
// Orchestrates the full Flutter build and emulator workflow:
// 1. Project detection
// 2. APK build (flutter build apk)
// 3. Emulator boot
// 4. Install + launch
// 5. Logcat streaming
// ============================================================

use anyhow::{bail, Context, Result};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio::sync::Mutex;
use tokio::time::sleep;
use webrtc::data_channel::RTCDataChannel;
use webrtc::peer_connection::RTCPeerConnection;

use crate::android::emulator::{
    acquire_emulator_daemon, detect_kvm, ensure_emulator_ready, EmulatorConfig, EnsureReadyResult,
    LogcatEntry, LogLevel,
};
use crate::android::flutter::{
    build_flutter_apk, check_flutter_sdk, detect_flutter_project, BuildVariant, FlutterBuildConfig,
    derive_app_id, generate_android_scaffold, needs_android_scaffold,
};
use crate::android::webrtc::input::{clear_cancelled_session, is_session_cancelled};
use crate::android::webrtc::{send_log, send_logcat, send_mobile_capabilities, send_status};
use crate::android::webrtc::{EmulatorStreamConfig, EmulatorStreamMode};
use crate::android::fs::{
    reconcile_and_stream_with_rules, take_snapshot_with_rules, ReconcileConfig, SyncRules,
};

/// Job handler version for tracking deployed binaries
const JOB_HANDLER_VERSION: &str = "flutter-v1-2025-02";

/// Handles a Flutter emulator job.
///
/// This orchestrates the full flow:
/// 1. Project detection (pubspec.yaml)
/// 2. Dependency resolution (flutter pub get)
/// 3. APK build (flutter build apk)
/// 4. Emulator boot
/// 5. Install + launch
/// 6. Logcat streaming
pub async fn handle_flutter_emulator_job(
    log_dc: Arc<RTCDataChannel>,
    session_id: String,
    workspace_path: PathBuf,
    project_root: Option<String>,
    is_release: bool,
    pc: Arc<RTCPeerConnection>,
) -> Result<()> {
    eprintln!(
        "[flutter-job] Starting handle_flutter_emulator_job version={}",
        JOB_HANDLER_VERSION
    );

    // Determine starting path for project detection
    let start_path = if let Some(root) = &project_root {
        let cleaned = root.trim_start_matches('/');
        if cleaned.is_empty() {
            workspace_path.clone()
        } else {
            workspace_path.join(cleaned)
        }
    } else {
        workspace_path.clone()
    };

    send_log(
        &log_dc,
        &session_id,
        &format!("[worker] Flutter job handler version: {}", JOB_HANDLER_VERSION),
        "worker",
    )
    .await;

    send_status(
        &log_dc,
        &session_id,
        "starting",
        "Starting Flutter emulator job...",
        None,
    )
    .await;

    send_log(
        &log_dc,
        &session_id,
        &format!("Session ID: {}", session_id),
        "worker",
    )
    .await;

    send_log(
        &log_dc,
        &session_id,
        &format!("Project path: {}", start_path.display()),
        "worker",
    )
    .await;

    // Tell the frontend what streaming/input transports are available.
    send_mobile_capabilities(&log_dc, &session_id).await;

    // Step 1: Detect Flutter project
    send_status(
        &log_dc,
        &session_id,
        "detecting",
        "Detecting Flutter project...",
        None,
    )
    .await;

    let project_path = find_flutter_project_root(&start_path, &workspace_path).await?;
    let project_info = detect_flutter_project(&project_path)
        .await
        .context("Failed to detect Flutter project")?;

    if !project_info.is_flutter_project {
        send_status(
            &log_dc,
            &session_id,
            "error",
            "Not a Flutter project",
            Some(json!({
                "path": project_path.display().to_string(),
            })),
        )
        .await;
        bail!("Not a Flutter project: {}", project_path.display());
    }

    if !project_info.has_android_module {
        send_log(
            &log_dc,
            &session_id,
            "Android module missing, generating scaffold...",
            "system",
        )
        .await;

        // Prepare for sync: Calculate relative path for android/
        let android_path = project_path.join("android");
        let (snapshot, rules, cfg) = if let Ok(rel_project) = project_path.strip_prefix(&workspace_path) {
            let rel_project = rel_project.to_string_lossy().replace('\\', "/");
            let rel_project = rel_project.trim().trim_matches('/');
            let android_rel = if rel_project.is_empty() {
                "android".to_string()
            } else {
                format!("{}/android", rel_project)
            };

            let rules = SyncRules::default().with_prefix(&android_rel);
            let cfg = ReconcileConfig::from_env();

            // Take snapshot of MISSING directory (empty state) ensures everything counts as "New"
            // and CreateOnly policies don't block upload.
            let snap = match take_snapshot_with_rules(&workspace_path, rules.clone()).await {
                Ok(s) => Some(s),
                Err(e) => {
                    eprintln!("Snapshot failed: {}", e);
                    None
                }
            };
            (snap, Some(rules), Some(cfg))
        } else {
            (None, None, None)
        };

        // Generate Android scaffold
        let app_id = project_info.app_id.clone()
            .unwrap_or_else(|| derive_app_id(project_info.project_name.as_deref().unwrap_or("flutter_app")));
        let project_name = project_info.project_name.clone().unwrap_or_else(|| "Flutter App".to_string());
        
        // Try to find Flutter SDK path early for scaffold generation
        let flutter_sdk_path = find_flutter_sdk_path().await;

        if let Err(e) = generate_android_scaffold(&project_path, &app_id, &project_name, flutter_sdk_path.as_deref()).await {
            send_status(
                &log_dc,
                &session_id,
                "error",
                &format!("Failed to generate Android scaffold: {}", e),
                None,
            )
            .await;
            bail!("Failed to generate Android scaffold: {}", e);
        }

        send_log(
            &log_dc,
            &session_id,
            "Android scaffold generated successfully",
            "system",
        )
        .await;
        
        // reconcile generated files back to workspace
        if let (Some(snapshot), Some(rules), Some(cfg)) = (snapshot, rules, cfg) {
            send_log(
                &log_dc,
                &session_id,
                "Syncing scaffold to workspace...",
                "system",
            )
            .await;
            
            if let Err(e) = reconcile_and_stream_with_rules(
                log_dc.clone(),
                &session_id,
                &workspace_path,
                snapshot,
                rules,
                cfg,
            ).await {
                 send_log(
                    &log_dc,
                    &session_id,
                    &format!("Warning: Failed to sync scaffold: {}", e),
                    "system",
                )
                .await;
            } else {
                 send_log(
                    &log_dc,
                    &session_id,
                    "Scaffold synced to workspace",
                    "system",
                )
                .await;
            }
        }

    } else {
        // Check if existing Android setup needs updating (v1 embedding -> v2)
        if needs_android_scaffold(&project_path).await {
            send_log(
                &log_dc,
                &session_id,
                "Updating Android scaffold to v2 embedding...",
                "system",
            )
            .await;

            // Prepare for sync: Calculate relative path for android/
            let android_path = project_path.join("android");
            
            // CRITICAL: We want to force overwrite of broken files.
            // Remove the directory LOCALLY so the snapshot sees it as "Missing".
            // This ensures "CreateOnly" rules in SyncRules don't prevent us from uploading the fixed files.
            if android_path.exists() {
                if let Err(e) = tokio::fs::remove_dir_all(&android_path).await {
                    eprintln!("Failed to remove old android dir: {}", e);
                }
            }

            let (snapshot, rules, cfg) = if let Ok(rel_project) = project_path.strip_prefix(&workspace_path) {
                let rel_project = rel_project.to_string_lossy().replace('\\', "/");
                let rel_project = rel_project.trim().trim_matches('/');
                let android_rel = if rel_project.is_empty() {
                    "android".to_string()
                } else {
                    format!("{}/android", rel_project)
                };

                let rules = SyncRules::default().with_prefix(&android_rel);
                let cfg = ReconcileConfig::from_env();

                let snap = match take_snapshot_with_rules(&workspace_path, rules.clone()).await {
                    Ok(s) => Some(s),
                    Err(e) => {
                        eprintln!("Snapshot failed: {}", e);
                        None
                    }
                };
                (snap, Some(rules), Some(cfg))
            } else {
                (None, None, None)
            };

            let app_id = project_info.app_id.clone()
                .unwrap_or_else(|| derive_app_id(project_info.project_name.as_deref().unwrap_or("flutter_app")));
            let project_name = project_info.project_name.clone().unwrap_or_else(|| "Flutter App".to_string());
            
            // Try to find Flutter SDK path for scaffold generation
            let flutter_sdk_path = find_flutter_sdk_path().await;

            if let Err(e) = generate_android_scaffold(&project_path, &app_id, &project_name, flutter_sdk_path.as_deref()).await {
                send_log(
                    &log_dc,
                    &session_id,
                    &format!("Warning: Failed to update Android scaffold: {}", e),
                    "system",
                )
                .await;
                // Continue anyway, might work
            } else {
                send_log(
                    &log_dc,
                    &session_id,
                    "Android scaffold updated to v2 embedding",
                    "system",
                )
                .await;
                
                // reconcile generated files back to workspace
                if let (Some(snapshot), Some(rules), Some(cfg)) = (snapshot, rules, cfg) {
                    send_log(
                        &log_dc,
                        &session_id,
                        "Syncing updated scaffold to workspace...",
                        "system",
                    )
                    .await;
                    
                    if let Err(e) = reconcile_and_stream_with_rules(
                        log_dc.clone(),
                        &session_id,
                        &workspace_path,
                        snapshot,
                        rules,
                        cfg,
                    ).await {
                         send_log(
                            &log_dc,
                            &session_id,
                            &format!("Warning: Failed to sync updated scaffold: {}", e),
                            "system",
                        )
                        .await;
                    } else {
                         send_log(
                            &log_dc,
                            &session_id,
                            "Updated scaffold synced to workspace",
                            "system",
                        )
                        .await;
                    }
                }
            }
        }
    }

    send_log(
        &log_dc,
        &session_id,
        &format!(
            "Project type: Flutter (Kotlin: {}, Swift: {})",
            project_info.uses_kotlin,
            project_info.uses_swift
        ),
        "worker",
    )
    .await;

    if let Some(ref app_id) = project_info.app_id {
        send_log(
            &log_dc,
            &session_id,
            &format!("Application ID: {}", app_id),
            "worker",
        )
        .await;
    }

    send_status(
        &log_dc,
        &session_id,
        "detected",
        "Flutter project detected",
        Some(json!({
            "project_name": project_info.project_name,
            "app_id": project_info.app_id,
            "flutter_version": project_info.flutter_version,
            "uses_kotlin": project_info.uses_kotlin,
            "min_sdk": project_info.min_sdk_version,
        })),
    )
    .await;

    // Step 2: Check Flutter SDK health
    send_status(
        &log_dc,
        &session_id,
        "checking-sdk",
        "Checking Flutter SDK...",
        None,
    )
    .await;

    let sdk_health = check_flutter_sdk()
        .await
        .context("Failed to check Flutter SDK")?;

    if !sdk_health.flutter_available {
        send_status(
            &log_dc,
            &session_id,
            "error",
            "Flutter SDK not available",
            Some(json!({
                "issues": sdk_health.issues,
            })),
        )
        .await;
        bail!("Flutter SDK not available: {:?}", sdk_health.issues);
    }

    send_log(
        &log_dc,
        &session_id,
        &format!(
            "Flutter SDK: {} (Dart: {})",
            sdk_health.flutter_version.as_deref().unwrap_or("unknown"),
            sdk_health.dart_version.as_deref().unwrap_or("unknown")
        ),
        "system",
    )
    .await;

    if !sdk_health.android_sdk_available {
        send_status(
            &log_dc,
            &session_id,
            "error",
            "Android SDK not available",
            Some(json!({
                "issues": sdk_health.issues,
            })),
        )
        .await;
        bail!("Android SDK not available");
    }

    // Get Android SDK root for emulator
    let sdk_root = std::env::var("ANDROID_SDK_ROOT")
        .or_else(|_| std::env::var("ANDROID_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/opt/android-sdk"));

    // Start emulator prewarm in background
    let stream_config = EmulatorStreamConfig::from_env();
    let mut emulator_config = EmulatorConfig::default();
    emulator_config.android_sdk_root = sdk_root.clone();

    if stream_config.mode == EmulatorStreamMode::Grpc {
        let grpc_gpu = std::env::var("SYNTHI_ANDROID_EMULATOR_GPU")
            .unwrap_or_else(|_| "swiftshader_indirect".to_string());
        emulator_config.extra_args.extend(vec![
            "-no-window".to_string(),
            "-grpc".to_string(),
            stream_config.grpc.port.to_string(),
            "-gpu".to_string(),
            grpc_gpu,
        ]);
        if stream_config.grpc.use_token {
            emulator_config.extra_args.push("-grpc-use-token".to_string());
        }
    }

    // KVM detection
    let kvm = detect_kvm();
    emulator_config.use_hw_accel = kvm.accessible;
    send_log(
        &log_dc,
        &session_id,
        &format!(
            "[kvm] exists={} accessible={} -> accel {}",
            kvm.exists,
            kvm.accessible,
            if emulator_config.use_hw_accel { "on" } else { "off" }
        ),
        "emulator",
    )
    .await;

    // Start emulator prewarm
    let prewarm_config = emulator_config.clone();
    let log_dc_for_prewarm = log_dc.clone();
    let session_id_for_prewarm = session_id.clone();
    let emulator_prewarm = tokio::spawn(async move {
        send_log(
            &log_dc_for_prewarm,
            &session_id_for_prewarm,
            "[overlap] Starting emulator prewarm in background",
            "emulator",
        )
        .await;

        let start = Instant::now();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let res = ensure_emulator_ready(prewarm_config).await;
        match &res {
            Ok(info) => {
                send_log(
                    &log_dc_for_prewarm,
                    &session_id_for_prewarm,
                    &format!(
                        "[overlap] Emulator prewarm complete (reused={} elapsed_ms={})",
                        info.reused,
                        start.elapsed().as_millis()
                    ),
                    "emulator",
                )
                .await;
            }
            Err(e) => {
                send_log(
                    &log_dc_for_prewarm,
                    &session_id_for_prewarm,
                    &format!("[overlap] Emulator prewarm failed: {:#}", e),
                    "emulator",
                )
                .await;
            }
        }
        res
    });

    // Check for cancellation before build
    if is_session_cancelled(&session_id) {
        eprintln!("[flutter-job] Session {} cancelled before build", session_id);
        clear_cancelled_session(&session_id);
        bail!("Session cancelled by user");
    }

    // Ensure local.properties has flutter.sdk set
    if let Some(ref flutter_path) = sdk_health.flutter_path {
        if let Err(e) = ensure_local_properties(&project_path, flutter_path).await {
            send_log(
                &log_dc,
                &session_id,
                &format!("Warning: Could not write local.properties: {}", e),
                "system",
            )
            .await;
        }
    }

    // Step 3: Build APK
    send_status(&log_dc, &session_id, "building", "Building Flutter APK...", None).await;

    send_log(
        &log_dc,
        &session_id,
        "[overlap] Flutter build started while emulator boots",
        "system",
    )
    .await;

    // Create build config
    let build_config = FlutterBuildConfig {
        project_root: project_path.clone(),
        variant: if is_release {
            BuildVariant::Release
        } else {
            BuildVariant::Debug
        },
        extra_args: vec![],
        env: HashMap::new(),
        skip_pub_get: false,
        clean_first: false,
    };

    // Rolling buffer for recent output
    let recent_lines: Arc<Mutex<VecDeque<String>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(200)));

    // Create log callback
    let log_dc_for_build = log_dc.clone();
    let session_id_for_build = session_id.clone();
    let recent_for_build = recent_lines.clone();
    let log_callback: Box<dyn Fn(String) + Send + Sync> = Box::new(move |line: String| {
        let dc = log_dc_for_build.clone();
        let sid = session_id_for_build.clone();
        let recent = recent_for_build.clone();
        tokio::spawn(async move {
            {
                let mut buf = recent.lock().await;
                if buf.len() >= 200 {
                    let _ = buf.pop_front();
                }
                buf.push_back(line.clone());
            }
            send_log(&dc, &sid, &line, "flutter").await;
        });
    });

    // Build heartbeat
    let (build_done_tx, mut build_done_rx) = watch::channel(false);
    {
        let dc = log_dc.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let start = Instant::now();
            let mut interval = tokio::time::interval(Duration::from_secs(15));
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        let elapsed = start.elapsed().as_secs();
                        send_log(&dc, &sid, &format!("[heartbeat] Flutter build running... {}s", elapsed), "system").await;
                    }
                    _ = build_done_rx.changed() => {
                        break;
                    }
                }
            }
        });
    }

    // Execute build
    let build_result = build_flutter_apk(&build_config, Some(log_callback)).await;
    let _ = build_done_tx.send(true);

    let build_result = build_result.context("Flutter build failed")?;

    if !build_result.success {
        let error_summary = {
            let buf = recent_lines.lock().await;
            buf.iter()
                .rev()
                .take(20)
                .rev()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        };

        send_status(
            &log_dc,
            &session_id,
            "build-failed",
            "Flutter build failed",
            Some(json!({
                "diagnostics": build_result.diagnostics,
                "recent_output": error_summary,
            })),
        )
        .await;
        bail!("Flutter build failed");
    }

    let apk_path = build_result
        .apk_path
        .context("Build succeeded but APK not found")?;

    send_log(
        &log_dc,
        &session_id,
        &format!("APK built: {}", apk_path.display()),
        "flutter",
    )
    .await;

    send_status(
        &log_dc,
        &session_id,
        "build-complete",
        "Flutter APK built successfully",
        Some(json!({
            "apk_path": apk_path.display().to_string(),
            "duration_ms": build_result.build_duration_ms,
        })),
    )
    .await;

    // Step 4: Wait for emulator
    send_status(
        &log_dc,
        &session_id,
        "waiting-emulator",
        "Waiting for emulator...",
        None,
    )
    .await;

    let emulator_result = emulator_prewarm
        .await
        .context("Emulator prewarm task panicked")?
        .context("Emulator failed to start")?;

    send_log(
        &log_dc,
        &session_id,
        &format!(
            "Emulator ready (device: {})",
            &emulator_result.serial
        ),
        "emulator",
    )
    .await;

    // Step 5: Install APK
    send_status(&log_dc, &session_id, "installing", "Installing APK...", None).await;

    let device_serial = &emulator_result.serial;

    let install_result = install_apk(&apk_path, device_serial).await;
    if let Err(e) = &install_result {
        send_status(
            &log_dc,
            &session_id,
            "install-failed",
            &format!("APK installation failed: {}", e),
            None,
        )
        .await;
        bail!("APK installation failed: {}", e);
    }

    send_log(&log_dc, &session_id, "APK installed successfully", "adb").await;

    // Step 6: Launch app
    let app_id = build_result
        .app_id
        .or(project_info.app_id)
        .context("Could not determine application ID")?;

    send_status(
        &log_dc,
        &session_id,
        "launching",
        &format!("Launching {}...", app_id),
        None,
    )
    .await;

    let launch_result = launch_app(&app_id, device_serial).await;
    if let Err(e) = &launch_result {
        send_log(
            &log_dc,
            &session_id,
            &format!("App launch warning: {}", e),
            "adb",
        )
        .await;
    }

    send_status(
        &log_dc,
        &session_id,
        "running",
        "App is running",
        Some(json!({
            "app_id": app_id,
            "device": device_serial,
        })),
    )
    .await;

    // Step 7: Stream logcat
    send_log(
        &log_dc,
        &session_id,
        "Starting logcat stream...",
        "system",
    )
    .await;

    // Start logcat streaming in background
    let log_dc_for_logcat = log_dc.clone();
    let session_id_for_logcat = session_id.clone();
    let app_id_for_logcat = app_id.clone();
    let device_for_logcat = device_serial.to_string();
    tokio::spawn(async move {
        if let Err(e) = stream_logcat(
            &log_dc_for_logcat,
            &session_id_for_logcat,
            &app_id_for_logcat,
            &device_for_logcat,
        )
        .await
        {
            eprintln!("[flutter-job] Logcat streaming error: {}", e);
        }
    });

    // Start video streaming if configured
    // TODO: Implement video streaming for Flutter using EmulatorVideoPipeline::start()
    // similar to React Native job. For now, Flutter runs without video streaming.
    if stream_config.mode == EmulatorStreamMode::Grpc {
        send_log(
            &log_dc,
            &session_id,
            "Video streaming not yet implemented for Flutter builds",
            "emulator",
        )
        .await;
    }

    // Keep the job alive until cancelled
    loop {
        if is_session_cancelled(&session_id) {
            eprintln!("[flutter-job] Session {} cancelled", session_id);
            clear_cancelled_session(&session_id);
            break;
        }
        sleep(Duration::from_millis(500)).await;
    }

    send_status(&log_dc, &session_id, "stopped", "Session ended", None).await;

    Ok(())
}

/// Finds the Flutter project root by searching up from start_path
async fn find_flutter_project_root(start_path: &PathBuf, workspace_path: &PathBuf) -> Result<PathBuf> {
    let mut current = start_path.clone();

    loop {
        let pubspec = current.join("pubspec.yaml");
        if pubspec.exists() {
            // Verify it's a Flutter project
            if let Ok(content) = tokio::fs::read_to_string(&pubspec).await {
                if content.contains("flutter:") || content.contains("flutter_test:") {
                    return Ok(current);
                }
            }
        }

        // Don't go above workspace root
        if current == *workspace_path || current.parent().is_none() {
            break;
        }

        current = current.parent().unwrap().to_path_buf();
    }

    // If not found, assume start_path is the project
    if start_path.join("pubspec.yaml").exists() {
        Ok(start_path.clone())
    } else {
        bail!("No Flutter project found (no pubspec.yaml with flutter dependency)")
    }
}

/// Installs APK to emulator via ADB
async fn install_apk(apk_path: &PathBuf, device_serial: &str) -> Result<()> {
    use tokio::process::Command;

    let output = Command::new("adb")
        .args(["-s", device_serial, "install", "-r", "-t"])
        .arg(apk_path)
        .output()
        .await
        .context("Failed to run adb install")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        bail!("adb install failed: {} {}", stdout, stderr);
    }

    Ok(())
}

/// Launches app via ADB
async fn launch_app(app_id: &str, device_serial: &str) -> Result<()> {
    use tokio::process::Command;

    // Use monkey to launch the app (works for most apps)
    let output = Command::new("adb")
        .args([
            "-s",
            device_serial,
            "shell",
            "monkey",
            "-p",
            app_id,
            "-c",
            "android.intent.category.LAUNCHER",
            "1",
        ])
        .output()
        .await
        .context("Failed to run adb shell monkey")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("App launch failed: {}", stderr);
    }

    Ok(())
}

/// Streams logcat output to frontend
async fn stream_logcat(
    log_dc: &Arc<RTCDataChannel>,
    session_id: &str,
    app_id: &str,
    device_serial: &str,
) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    // Clear existing logcat
    let _ = Command::new("adb")
        .args(["-s", device_serial, "logcat", "-c"])
        .output()
        .await;

    // Start logcat with filter for our app
    let mut child = Command::new("adb")
        .args([
            "-s",
            device_serial,
            "logcat",
            "-v",
            "time",
            "--pid",
            &get_app_pid(app_id, device_serial).await.unwrap_or_default(),
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .context("Failed to start logcat")?;

    let stdout = child.stdout.take().expect("stdout should be captured");
    let mut reader = BufReader::new(stdout).lines();

    while let Ok(Some(line)) = reader.next_line().await {
        if is_session_cancelled(session_id) {
            break;
        }
        let entry = parse_logcat_line(&line);
        send_logcat(log_dc, session_id, &entry).await;
    }

    let _ = child.kill().await;
    Ok(())
}

/// Gets the PID of the running app
async fn get_app_pid(app_id: &str, device_serial: &str) -> Result<String> {
    use tokio::process::Command;

    let output = Command::new("adb")
        .args(["-s", device_serial, "shell", "pidof", app_id])
        .output()
        .await?;

    let pid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if pid.is_empty() {
        bail!("App not running");
    }
    Ok(pid)
}

/// Parses a raw logcat line into a LogcatEntry
fn parse_logcat_line(line: &str) -> LogcatEntry {
    // Logcat format with -v time: "MM-DD HH:MM:SS.mmm D/Tag(PID): Message"
    // Try to parse, fall back to raw line as message
    
    let level_char = line.chars().nth(18).unwrap_or('I');
    let level = LogLevel::from_char(level_char);
    
    // Extract tag and message if possible
    let (tag, message) = if let Some(slash_pos) = line.find('/') {
        if let Some(colon_pos) = line[slash_pos..].find(':') {
            let tag_end = slash_pos + colon_pos;
            let tag_part = &line[slash_pos + 1..tag_end];
            // Remove PID from tag (format: "Tag(1234)")
            let tag = tag_part.split('(').next().unwrap_or(tag_part).to_string();
            let msg = line.get(tag_end + 2..).unwrap_or("").to_string();
            (tag, msg)
        } else {
            ("flutter".to_string(), line.to_string())
        }
    } else {
        ("flutter".to_string(), line.to_string())
    };

    let timestamp = line.get(0..18).unwrap_or("").trim().to_string();

    LogcatEntry {
        timestamp,
        pid: None,
        tid: None,
        level,
        tag,
        message,
    }
}

/// Ensures android/local.properties has flutter.sdk set
/// This is needed for Gradle to find Flutter when building.
async fn ensure_local_properties(project_root: &Path, flutter_sdk: &Path) -> Result<()> {
    let local_props_path = project_root.join("android/local.properties");
    
    // Get the Flutter SDK directory (parent of bin/flutter)
    let flutter_sdk_dir = flutter_sdk
        .parent() // bin
        .and_then(|p| p.parent()) // flutter root
        .unwrap_or(flutter_sdk);
    
    let flutter_sdk_str = flutter_sdk_dir.display().to_string();
    
    // Read existing content or start fresh
    let existing = if local_props_path.exists() {
        tokio::fs::read_to_string(&local_props_path).await.unwrap_or_default()
    } else {
        String::new()
    };
    
    // Check if flutter.sdk is already set correctly
    let has_flutter_sdk = existing.lines().any(|line| {
        line.trim().starts_with("flutter.sdk=")
    });
    
    if has_flutter_sdk {
        // Already has flutter.sdk, don't modify
        return Ok(());
    }
    
    // Append flutter.sdk
    let new_content = if existing.is_empty() {
        format!("flutter.sdk={}\n", flutter_sdk_str)
    } else if existing.ends_with('\n') {
        format!("{}flutter.sdk={}\n", existing, flutter_sdk_str)
    } else {
        format!("{}\nflutter.sdk={}\n", existing, flutter_sdk_str)
    };
    
    // Ensure android directory exists
    let android_dir = project_root.join("android");
    if !android_dir.exists() {
        tokio::fs::create_dir_all(&android_dir).await?;
    }
    
    tokio::fs::write(&local_props_path, new_content).await?;
    
    Ok(())
}

/// Helper to find Flutter SDK path for scaffold generation
async fn find_flutter_sdk_path() -> Option<String> {
    // Check common locations
    let candidates = [
        // Environment variable
        std::env::var("FLUTTER_HOME").ok(),
        std::env::var("FLUTTER_SDK").ok(),
        // Common paths
        Some("/home/sasho/flutter".to_string()),
        Some("/opt/flutter".to_string()),
        Some("/usr/local/flutter".to_string()),
    ];
    
    for candidate in candidates.into_iter().flatten() {
        let path = std::path::Path::new(&candidate);
        if path.join("bin/flutter").exists() {
            return Some(candidate);
        }
    }
    
    // Try to find via PATH by running `which flutter`
    if let Ok(output) = tokio::process::Command::new("which")
        .arg("flutter")
        .output()
        .await
    {
        if output.status.success() {
            let flutter_bin = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // flutter_bin is /path/to/flutter/bin/flutter, we want /path/to/flutter
            if let Some(sdk) = std::path::Path::new(&flutter_bin)
                .parent() // bin
                .and_then(|p| p.parent()) // flutter
            {
                return Some(sdk.display().to_string());
            }
        }
    }
    
    // Try scanning home directories
    if let Ok(entries) = std::fs::read_dir("/home") {
        for entry in entries.flatten() {
            let flutter_path = entry.path().join("flutter");
            if flutter_path.join("bin/flutter").exists() {
                return Some(flutter_path.display().to_string());
            }
        }
    }
    
    None
}