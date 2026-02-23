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
use gstreamer as gst;
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio::sync::Mutex;
use tokio::time::sleep;
use webrtc::data_channel::RTCDataChannel;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::stats::StatsReportType;
use webrtc::track::track_local::TrackLocal;

async fn wait_for_cancel(session_id: &str) {
    loop {
        if is_session_cancelled(session_id) {
            return;
        }
        sleep(Duration::from_millis(500)).await;
    }
}

use crate::android::emulator::{
    acquire_emulator_daemon, detect_kvm, ensure_emulator_ready, EmulatorConfig, EnsureReadyResult,
    LogLevel, LogcatEntry,
};
use crate::android::emulator_grpc;
use crate::android::flutter::{
    build_flutter_apk, check_flutter_sdk, derive_app_id, detect_flutter_project,
    generate_android_scaffold, needs_android_scaffold, BuildVariant, FlutterBuildConfig,
};
use crate::android::fs::{
    reconcile_and_stream_with_rules, take_snapshot_with_rules, ReconcileConfig, SyncRules,
};
use crate::android::webrtc::input as emulator_input;
use crate::android::webrtc::input::{clear_cancelled_session, is_session_cancelled};
use crate::android::webrtc::video_pipeline;
use crate::android::webrtc::{send_log, send_logcat, send_mobile_capabilities, send_status};
use crate::android::webrtc::{EmulatorStreamConfig, EmulatorStreamMode};

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
        &format!(
            "[worker] Flutter job handler version: {}",
            JOB_HANDLER_VERSION
        ),
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

    let stream_config = EmulatorStreamConfig::from_env();

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
        let (snapshot, rules, cfg) =
            if let Ok(rel_project) = project_path.strip_prefix(&workspace_path) {
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
        let app_id = project_info.app_id.clone().unwrap_or_else(|| {
            derive_app_id(
                project_info
                    .project_name
                    .as_deref()
                    .unwrap_or("flutter_app"),
            )
        });
        let project_name = project_info
            .project_name
            .clone()
            .unwrap_or_else(|| "Flutter App".to_string());

        // Try to find Flutter SDK path early for scaffold generation
        let flutter_sdk_path = find_flutter_sdk_path().await;

        if let Err(e) = generate_android_scaffold(
            &project_path,
            &app_id,
            &project_name,
            flutter_sdk_path.as_deref(),
        )
        .await
        {
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
            )
            .await
            {
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

            let (snapshot, rules, cfg) = if let Ok(rel_project) =
                project_path.strip_prefix(&workspace_path)
            {
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

            let app_id = project_info.app_id.clone().unwrap_or_else(|| {
                derive_app_id(
                    project_info
                        .project_name
                        .as_deref()
                        .unwrap_or("flutter_app"),
                )
            });
            let project_name = project_info
                .project_name
                .clone()
                .unwrap_or_else(|| "Flutter App".to_string());

            // Try to find Flutter SDK path for scaffold generation
            let flutter_sdk_path = find_flutter_sdk_path().await;

            if let Err(e) = generate_android_scaffold(
                &project_path,
                &app_id,
                &project_name,
                flutter_sdk_path.as_deref(),
            )
            .await
            {
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
                    )
                    .await
                    {
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
            project_info.uses_kotlin, project_info.uses_swift
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
    let mut stream_config = EmulatorStreamConfig::from_env();
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
            emulator_config
                .extra_args
                .push("-grpc-use-token".to_string());
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
            if emulator_config.use_hw_accel {
                "on"
            } else {
                "off"
            }
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
        eprintln!(
            "[flutter-job] Session {} cancelled before build",
            session_id
        );
        clear_cancelled_session(&session_id);
        // Do not abort prewarm - let it finish for reuse
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
    send_status(
        &log_dc,
        &session_id,
        "building",
        "Building Flutter APK...",
        None,
    )
    .await;

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
        clean_first: true,
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
    let build_result = tokio::select! {
        res = build_flutter_apk(&build_config, Some(log_callback)) => res,
        _ = wait_for_cancel(&session_id) => {
            let _ = build_done_tx.send(true);
            // Do not abort prewarm - let it finish for reuse
            anyhow::bail!("Session cancelled by user during build");
        }
    };
    let _ = build_done_tx.send(true);

    let build_result = build_result.context("Flutter build failed")?;

    if !build_result.success {
        // Do not abort prewarm - user might fix and restart immediately

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

    // Wait for prewarm to complete OR cancel (allowing detach for reuse)
    tokio::select! {
        res = emulator_prewarm => {
            res.context("Emulator prewarm task panicked")??;
        }
        _ = wait_for_cancel(&session_id) => {
             // Detach prewarm (it keeps running)
             anyhow::bail!("Session cancelled by user during emulator boot");
        }
    }

    // Acquire the emulator daemon lock. This ensures we "own" the emulator session.
    // The lock is held until `daemon` is dropped at the end of the function.
    let (mut daemon, emulator_result) = tokio::select! {
        res = acquire_emulator_daemon(emulator_config.clone()) => {
             res.context("Failed to acquire emulator daemon")?
        }
        _ = wait_for_cancel(&session_id) => {
             anyhow::bail!("Session cancelled by user during emulator boot");
        }
    };

    send_status(
        &log_dc,
        &session_id,
        "emulator-ready",
        if emulator_result.reused {
            "Emulator reused"
        } else {
            "Emulator booted"
        },
        Some(json!({
             "serial": emulator_result.serial,
             "boot_time_ms": 0,
             "reused": emulator_result.reused,
        })),
    )
    .await;

    // Send "ready" status immediately after emulator-ready to satisfy frontend logic
    // which specifically looks for "ready", "running", or "streaming".
    send_status(
        &log_dc,
        &session_id,
        "ready",
        "Emulator ready for interaction",
        None,
    )
    .await;

    // --- Video Pipeline Initialization ---
    // Added to support emulator video streaming for Flutter
    let adb_path = emulator_config.android_sdk_root.join("platform-tools/adb");
    let emulator_serial = emulator_result.serial.clone();

    let mut grpc_frame_task: Option<tokio::task::JoinHandle<()>> = None;
    let mut adaptation_task: Option<tokio::task::JoinHandle<()>> = None;

    let (pipeline, display_label) = if stream_config.mode == EmulatorStreamMode::Grpc {
        if !emulator_grpc::grpc_codegen_available() {
            send_log(
                &log_dc,
                &session_id,
                "[grpc] gRPC codegen unavailable (protoc/protos missing); cannot start grpc streaming",
                "emulator",
            )
            .await;
            emulator_input::unregister_session_sync(&session_id);
            bail!("gRPC codegen unavailable; install protoc and provide emulator protos");
        }

        let mut app_cfg = video_pipeline::EmulatorAppSrcConfig::default();
        app_cfg.codec = video_pipeline::VideoCodec::H264;
        app_cfg.format = "RGB".to_string();

        {
            let transceivers = pc.get_transceivers().await;
            for t in transceivers {
                if t.kind() == RTPCodecType::Video {
                    let sender = t.sender().await;
                    let params = sender.get_parameters().await;
                    for codec in params.rtp_parameters.codecs {
                        let mime = codec.capability.mime_type.to_lowercase();
                        if mime.contains("h264") {
                            eprintln!(
                                "[mobile-job] Found negotiated codec {} with PT {} fmtp={}",
                                codec.capability.mime_type,
                                codec.payload_type,
                                codec.capability.sdp_fmtp_line
                            );
                            app_cfg.payload_type = codec.payload_type;
                            break;
                        }
                    }
                }
            }
        }

        if let Ok((w, h)) = emulator_input::query_device_size(&adb_path, &emulator_serial).await {
            if w > 0 && h > 0 {
                if w > 720 {
                    // High-res device: request 1/2 scale from the emulator to reduce bandwidth
                    stream_config.grpc.target_width = Some(w / 2);
                    stream_config.grpc.target_height = Some(h / 2);
                    app_cfg.width = w / 2;
                    app_cfg.height = h / 2;
                } else {
                    stream_config.grpc.target_width = Some(w);
                    stream_config.grpc.target_height = Some(h);
                    app_cfg.width = w;
                    app_cfg.height = h;
                }
            }
        }

        send_log(
            &log_dc,
            &session_id,
            &format!(
                "[video] starting GStreamer appsrc pipeline (pt={}): {}",
                app_cfg.payload_type,
                video_pipeline::EmulatorVideoPipeline::debug_appsrc_pipeline_string(&app_cfg)
            ),
            "emulator",
        )
        .await;

        let frame_rx = match emulator_grpc::stream_frames(&stream_config.grpc).await {
            Ok(rx) => rx,
            Err(e) => {
                send_log(
                    &log_dc,
                    &session_id,
                    &format!("[grpc] failed to start frame stream: {:#}", e),
                    "emulator",
                )
                .await;
                emulator_input::unregister_session_sync(&session_id);
                bail!("failed to start emulator gRPC frame stream: {}", e);
            }
        };

        let pipeline = match video_pipeline::EmulatorVideoPipeline::start_appsrc(app_cfg.clone()) {
            Ok(p) => Arc::new(p),
            Err(e) => {
                emulator_input::unregister_session_sync(&session_id);
                bail!("failed to start emulator gRPC video pipeline: {}", e);
            }
        };

        let appsrc = pipeline
            .appsrc_clone()
            .context("gRPC pipeline missing appsrc")?;

        adaptation_task = Some(spawn_video_bitrate_adaptation(
            pc.clone(),
            pipeline.clone(),
            log_dc.clone(),
            session_id.clone(),
        ));

        // Wake mechanism
        let adb_path_clone = adb_path.clone();
        let serial_clone = emulator_serial.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let _ = tokio::process::Command::new(&adb_path_clone)
                .arg("-s")
                .arg(&serial_clone)
                .arg("shell")
                .arg("input")
                .arg("keyevent")
                .arg("KEYCODE_WAKEUP")
                .output()
                .await;
            tokio::time::sleep(Duration::from_millis(500)).await;
            let _ = tokio::process::Command::new(&adb_path_clone)
                .arg("-s")
                .arg(&serial_clone)
                .arg("shell")
                .arg("input")
                .arg("keyevent")
                .arg("82")
                .output()
                .await;
        });

        let log_dc_for_grpc = log_dc.clone();
        let session_id_for_grpc = session_id.clone();
        let expected_w = app_cfg.width;
        let expected_h = app_cfg.height;
        let expected_format = app_cfg.format.clone();

        // We used to have `mut frame_rx` in logic above, but in the `match` block it returns `rx` which is `mpsc::Receiver`.
        // We need to move it into the spawn.
        let mut frame_rx_moved = frame_rx;

        grpc_frame_task = Some(tokio::spawn(async move {
            let mut frames: u64 = 0;
            let mut dropped: u64 = 0;
            let mut last_log = Instant::now();
            let mut last_frame_at = Instant::now();
            let mut mismatch_logged = false;
            let mut last_frame_size: Option<(u32, u32)> = None;
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            let mut last_push_buffer: Option<gst::Buffer> = None;

            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        let elapsed = last_frame_at.elapsed();
                        if frames == 0 {
                            send_log(
                                &log_dc_for_grpc,
                                &session_id_for_grpc,
                                "[grpc] no frames received yet (display may be inactive)",
                                "emulator",
                            )
                            .await;
                        } else if elapsed >= Duration::from_secs(10) {
                                if elapsed.as_secs() % 30 < 5 {
                                send_log(
                                    &log_dc_for_grpc,
                                    &session_id_for_grpc,
                                    &format!(
                                        "[grpc] display idle: last update {}s ago (heartbeat active)",
                                        elapsed.as_secs()
                                    ),
                                    "emulator",
                                )
                                .await;
                                }
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {
                        if let Some(buf) = &last_push_buffer {
                            let _ = appsrc.push_buffer(buf.clone());
                        }
                    }
                    maybe = frame_rx_moved.recv() => {
                        let Some(frame) = maybe else {
                            send_log(
                                &log_dc_for_grpc,
                                &session_id_for_grpc,
                                "[grpc] frame stream closed by emulator",
                                "emulator",
                            )
                            .await;
                            break;
                        };
                        frames += 1;
                        last_frame_at = Instant::now();

                        if frame.width > 0 && frame.height > 0 {
                            let size = (frame.width, frame.height);
                            if last_frame_size != Some(size) {
                                emulator_input::update_grpc_frame_size(
                                    &session_id_for_grpc,
                                    frame.width,
                                    frame.height,
                                );
                                last_frame_size = Some(size);
                            }
                        }

                        if !mismatch_logged
                            && (frame.width != expected_w
                                || frame.height != expected_h
                                || frame.format != expected_format)
                        {
                            mismatch_logged = true;
                            send_log(
                                &log_dc_for_grpc,
                                &session_id_for_grpc,
                                &format!(
                                    "[grpc] frame format mismatch: stream={}x{} {} expected={}x{} {}",
                                    frame.width,
                                    frame.height,
                                    frame.format,
                                    expected_w,
                                    expected_h,
                                    expected_format
                                ),
                                "emulator",
                            )
                            .await;
                        }

                        if frame.format != expected_format {
                            dropped += 1;
                            continue;
                        }

                        let buffer = gst::Buffer::from_slice(frame.data);
                        last_push_buffer = Some(buffer.clone());

                        if appsrc.push_buffer(buffer).is_err() {
                            dropped += 1;
                        }

                        if last_log.elapsed() >= Duration::from_secs(5) {
                            send_log(
                                &log_dc_for_grpc,
                                &session_id_for_grpc,
                                &format!(
                                    "[grpc] frames={} dropped={} expected={}x{} {}",
                                    frames, dropped, expected_w, expected_h, expected_format
                                ),
                                "emulator",
                            )
                            .await;
                            last_log = Instant::now();
                        }
                    }
                }
            }
        }));

        (
            pipeline,
            format!(
                "grpc://{}:{}",
                stream_config.grpc.host, stream_config.grpc.port
            ),
        )
    } else {
        // Use the same X11 display as the emulator session.
        let session_display = {
            let d = daemon.session_mut().core.x11_display.lock().await.clone();
            d
        };

        let mut cfg = video_pipeline::EmulatorVideoConfig::default();
        cfg.codec = video_pipeline::VideoCodec::H264;

        if !session_display.trim().is_empty() {
            cfg.x11_display = session_display;
        } else if let Ok(d) = std::env::var("DISPLAY") {
            if !d.trim().is_empty() {
                cfg.x11_display = d;
            }
        }

        let capture_xid = std::env::var("SYNTHI_ANDROID_CAPTURE_XID")
            .ok()
            .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);

        let mut emulator_geom: Option<(i32, i32, i32, i32)> = None;
        if !cfg!(target_os = "windows") {
            if let Some((xid, _w, _h)) = find_emulator_x11_window(&cfg.x11_display).await {
                if let Some((x, y, w, h)) =
                    xdotool_window_geometry_xywh(&cfg.x11_display, xid).await
                {
                    emulator_geom = Some((x, y, w, h));
                    if let Some((sw, sh)) = parse_xvfb_resolution() {
                        let offscreen = x >= sw || y >= sh || (x + w) <= 0 || (y + h) <= 0;
                        send_log(
                            &log_dc,
                            &session_id,
                            &format!(
                                "[video] debug: Xvfb={}x{} display={} emulatorWindow xid={} geom x={} y={} w={} h={} offscreen={}",
                                sw,
                                sh,
                                cfg.x11_display,
                                xid,
                                x,
                                y,
                                w,
                                h,
                                offscreen
                            ),
                            "emulator",
                        )
                        .await;
                    }
                }
            }
        }

        if capture_xid {
            if let Some((xid, w, h)) = find_emulator_x11_window(&cfg.x11_display).await {
                cfg.x11_xid = Some(xid);
                let extra = if w > 0 && h > 0 {
                    format!(" ({}x{})", w, h)
                } else {
                    String::new()
                };
                send_log(
                    &log_dc,
                    &session_id,
                    &format!(
                        "[video] capturing emulator X11 window xid={}{} on DISPLAY={}",
                        xid, extra, cfg.x11_display
                    ),
                    "emulator",
                )
                .await;
            }
        } else {
            // Use root capture with region crop
            if let Some((x, y, w, h)) = emulator_geom {
                let left_pad = std::env::var("SYNTHI_ANDROID_LEFT_PAD_PX")
                    .ok()
                    .and_then(|v| v.parse::<i32>().ok())
                    .unwrap_or(24);
                cfg.startx = Some((x - left_pad).max(0));
                cfg.starty = Some(y.max(0));
                cfg.endx = Some(x + w);
                cfg.endy = Some(y + h);

                let mut toolbar_width = std::env::var("SYNTHI_ANDROID_TOOLBAR_WIDTH")
                    .ok()
                    .and_then(|v| v.parse::<u32>().ok())
                    .map(|v| v as i32)
                    .unwrap_or(72);

                if std::env::var("SYNTHI_ANDROID_TOOLBAR_WIDTH").is_err() {
                    // Try to infer toolbar width
                    if let Ok((device_w, device_h)) =
                        emulator_input::query_device_size(&adb_path, &emulator_serial).await
                    {
                        if device_w > 0 && device_h > 0 && h > 0 {
                            let scale = (h as f64) / (device_h as f64);
                            let expected_w = (device_w as f64) * scale;
                            let extra = (w as f64 - expected_w).round() as i32;
                            if extra > 0 {
                                toolbar_width = extra + 120;
                            }
                        }
                    }
                }
                cfg.crop_right = toolbar_width.max(0) as u32;
                cfg.width = (w - toolbar_width).max(100) as u32;
                cfg.height = h as u32;

                send_log(
                    &log_dc,
                    &session_id,
                    &format!(
                        "[video] crop region: x={} y={} w={} h={} (toolbar={})",
                        cfg.startx.unwrap_or(0),
                        cfg.starty.unwrap_or(0),
                        cfg.width,
                        cfg.height,
                        toolbar_width
                    ),
                    "emulator",
                )
                .await;
            }
        }

        if cfg.startx.is_none() {
            if let Ok((w, h)) = emulator_input::query_device_size(&adb_path, &emulator_serial).await
            {
                if w > 0 && h > 0 {
                    cfg.width = w;
                    cfg.height = h;
                }
            }
        }

        {
            let transceivers = pc.get_transceivers().await;
            for t in transceivers {
                if t.kind() == RTPCodecType::Video {
                    let sender = t.sender().await;
                    let params = sender.get_parameters().await;
                    for codec in params.rtp_parameters.codecs {
                        let mime = codec.capability.mime_type.to_lowercase();
                        if mime.contains("h264") {
                            cfg.payload_type = codec.payload_type;
                            break;
                        }
                    }
                }
            }
        }

        send_log(
            &log_dc,
            &session_id,
            &format!(
                "[video] starting pipeline: {}",
                video_pipeline::EmulatorVideoPipeline::debug_pipeline_string(&cfg)
            ),
            "emulator",
        )
        .await;

        let pipeline = match video_pipeline::EmulatorVideoPipeline::start(cfg.clone()) {
            Ok(p) => Arc::new(p),
            Err(e) => {
                // Fallback to basic root capture
                cfg.x11_xid = None;
                send_log(
                    &log_dc,
                    &session_id,
                    "[video] retrying with basic root capture",
                    "emulator",
                )
                .await;
                match video_pipeline::EmulatorVideoPipeline::start(cfg.clone()) {
                    Ok(p) => Arc::new(p),
                    Err(e2) => {
                        let _ = emulator_input::unregister_session_sync(&session_id);
                        bail!("Failed to start video pipeline: {}", e2);
                    }
                }
            }
        };

        (pipeline, cfg.x11_display.clone())
    };

    // Attach to existing video transceiver
    {
        let transceivers = pc.get_transceivers().await;
        for t in transceivers {
            if t.kind() == RTPCodecType::Video {
                let sender = t.sender().await;
                eprintln!("[flutter-job] Attaching video track to transceiver...");
                match sender
                    .replace_track(Some(
                        Arc::clone(&pipeline.track) as Arc<dyn TrackLocal + Send + Sync>
                    ))
                    .await
                {
                    Ok(_) => {
                        eprintln!("[flutter-job] Video track attached successfully");
                        let params = sender.get_parameters().await;
                        if !params.encodings.is_empty() {
                            let ssrc = params.encodings[0].ssrc;
                            eprintln!("[flutter-job] Found Sender SSRC: {}", ssrc);
                            if ssrc != 0 {
                                pipeline.set_ssrc(ssrc);
                            }
                        }

                        let rtcp_sender = sender.clone();
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 1500];
                            // Assuming RTCRtpSender impls something that allows reading RTCP or we need to use a different mechanism.
                            // In webrtc-rs, Sender.read reads RTCP packets.
                            while let Ok((_, _)) = rtcp_sender.read(&mut buf).await {}
                        });
                    }
                    Err(e) => eprintln!("Failed to replace track: {}", e),
                }
            }
        }
    }

    // Initialize input and wake up device

    let adb_path = emulator_config.android_sdk_root.join("platform-tools/adb");
    emulator_input::register_session(
        &session_id,
        adb_path.clone(),
        emulator_result.serial.clone(),
        stream_config.clone(),
    )
    .await?;

    let serial_wake = emulator_result.serial.clone();
    let adb_path_wake = adb_path.clone();

    // Step 4b: Stream logcat (START EARLY)
    // We start logcat before install so we can see what's happening on the device
    // during the potentially long install process.
    let log_dc_for_logcat = log_dc.clone();
    let session_id_for_logcat = session_id.clone();
    // Use a generic filter initially or just "*"
    let device_for_logcat = emulator_result.serial.to_string();
    let logcat_task = tokio::spawn(async move {
        // Stream all logs initially (maybe filter later?)
        // For now, let's just stream main logcat
        // Note: we don't have app PID yet.
        match stream_system_logcat(
            &log_dc_for_logcat,
            &session_id_for_logcat,
            &device_for_logcat,
        )
        .await
        {
            Ok(_) => {}
            Err(e) => eprintln!("[flutter-job] Early logcat streaming error: {}", e),
        }
    });

    // Wake up device immediately (so user sees screen during install)
    send_log(
        &log_dc,
        &session_id,
        "Waking up device (and disabling sleep)...",
        "system",
    )
    .await;

    // Wait for boot completion before trying to wake/install
    if let Err(_) = tokio::select! {
        res = wait_for_boot_completion(&adb_path_wake, &serial_wake, &log_dc, &session_id) => res,
        _ = wait_for_cancel(&session_id) => {
             // Just break out, subsequent steps will check cancellation
             Ok(())
        }
    } {
        // Log warning but continue
    }

    if is_session_cancelled(&session_id) {
        logcat_task.abort();
        if let Some(task) = &grpc_frame_task {
            task.abort();
        }
        if let Some(task) = &adaptation_task {
            task.abort();
        }
        let _ = daemon.session_mut().stop_logcat().await;
        daemon.release_keepalive().await;
        emulator_input::unregister_session_sync(&session_id);
        pipeline.stop();
        anyhow::bail!("Session cancelled by user");
    }

    // Disable sleep
    let _ = Command::new(&adb_path_wake)
        .arg("-s")
        .arg(&serial_wake)
        .arg("shell")
        .arg("settings")
        .arg("put")
        .arg("system")
        .arg("screen_off_timeout")
        .arg("2147483647")
        .output()
        .await;

    // Wake up
    let _ = Command::new(&adb_path_wake)
        .arg("-s")
        .arg(&serial_wake)
        .arg("shell")
        .arg("input")
        .arg("keyevent")
        .arg("KEYCODE_WAKEUP")
        .output()
        .await;

    // Unlock (Menu key often helps dismiss lock screen on emulator)
    let _ = Command::new(&adb_path_wake)
        .arg("-s")
        .arg(&serial_wake)
        .arg("shell")
        .arg("input")
        .arg("keyevent")
        .arg("82") // MENU
        .output()
        .await;

    // Step 5: Install APK
    send_status(&log_dc, &session_id, "ready", "Installing APK...", None).await;

    let device_serial = &emulator_result.serial;

    let install_result = tokio::select! {
        res = install_apk(&apk_path, device_serial) => res,
        _ = wait_for_cancel(&session_id) => {
             logcat_task.abort();
             if let Some(task) = &grpc_frame_task { task.abort(); }
             if let Some(task) = &adaptation_task { task.abort(); }
             let _ = daemon.session_mut().stop_logcat().await;
             daemon.release_keepalive().await;
             emulator_input::unregister_session_sync(&session_id);
             pipeline.stop();
             anyhow::bail!("Session cancelled by user during APK install");
        }
    };

    if let Err(e) = &install_result {
        send_status(
            &log_dc,
            &session_id,
            "error",
            &format!("APK installation failed: {}", e),
            None,
        )
        .await;
        bail!("APK installation failed: {}", e);
    }

    send_log(&log_dc, &session_id, "APK installed successfully", "adb").await;

    // Wake up again after install (in case install was slow and device slept)
    let _ = Command::new(&adb_path_wake)
        .arg("-s")
        .arg(&serial_wake)
        .arg("shell")
        .arg("input")
        .arg("keyevent")
        .arg("KEYCODE_WAKEUP")
        .output()
        .await;
    let _ = Command::new(&adb_path_wake)
        .arg("-s")
        .arg(&serial_wake)
        .arg("shell")
        .arg("input")
        .arg("keyevent")
        .arg("82")
        .output()
        .await;

    // Step 6: Launch app
    let app_id = build_result
        .app_id
        .or(project_info.app_id)
        .context("Could not determine application ID")?;

    send_status(
        &log_dc,
        &session_id,
        "ready",
        &format!("Launching {}...", app_id),
        None,
    )
    .await;

    let launch_result = tokio::select! {
        res = launch_app(&app_id, device_serial) => res,
        _ = wait_for_cancel(&session_id) => {
             logcat_task.abort();
             if let Some(task) = &grpc_frame_task { task.abort(); }
             if let Some(task) = &adaptation_task { task.abort(); }
             let _ = daemon.session_mut().stop_logcat().await;
             daemon.release_keepalive().await;
             emulator_input::unregister_session_sync(&session_id);
             pipeline.stop();
             Err(anyhow::anyhow!("Session cancelled by user"))
        }
    };

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
    send_log(&log_dc, &session_id, "Starting logcat stream...", "system").await;

    // Start logcat streaming in background (FILTERED FOR APP)
    // We cancel the global one first if we want, or we keep it?
    // Actually, capturing only app logs is cleaner if we can.
    // But `stream_logcat` uses `pidof` which needs the app to be running.
    // So we'll let the system logcat run until we have the app PID, then maybe switch?
    // For simplicity, let's just abort the system logcat task and start the app-specific one.
    logcat_task.abort();

    let log_dc_for_logcat = log_dc.clone();
    let session_id_for_logcat = session_id.clone();
    let app_id_for_logcat = app_id.clone();
    let device_for_logcat = device_serial.to_string();
    let logcat_task = tokio::spawn(async move {
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

    // Register input session (mouse/keyboard) and keep alive
    let adb_path_for_input = if cfg!(windows) {
        emulator_config
            .android_sdk_root
            .join("platform-tools/adb.exe")
    } else {
        emulator_config.android_sdk_root.join("platform-tools/adb")
    };
    if let Err(e) = emulator_input::register_session(
        &session_id,
        adb_path_for_input,
        device_serial.to_string(),
        stream_config.clone(),
    )
    .await
    {
        send_log(
            &log_dc,
            &session_id,
            &format!("Input registration failed: {}", e),
            "system",
        )
        .await;
    }

    // Keep the job alive until cancelled
    loop {
        if is_session_cancelled(&session_id) {
            eprintln!("[flutter-job] Session {} cancelled", session_id);
            break;
        }
        sleep(Duration::from_millis(500)).await;
    }

    // Cleanup tasks
    logcat_task.abort();
    if let Some(task) = grpc_frame_task {
        task.abort();
    }
    if let Some(task) = adaptation_task {
        task.abort();
    }

    // Cleanup emulator state
    let _ = daemon.session_mut().stop_logcat().await;
    daemon.release_keepalive().await;
    emulator_input::unregister_session_sync(&session_id);
    pipeline.stop();

    // Clear cancelled flag so next session can start fresh
    clear_cancelled_session(&session_id);

    send_status(&log_dc, &session_id, "stopped", "Session ended", None).await;

    Ok(())
}

/// Finds the Flutter project root by searching up from start_path
async fn find_flutter_project_root(
    start_path: &PathBuf,
    workspace_path: &PathBuf,
) -> Result<PathBuf> {
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

    let mut cmd = Command::new("adb");
    cmd.args(["-s", device_serial, "install", "-r", "-t"])
        .arg(apk_path);

    // Ensure kill_on_drop behavior if using child handle directly,
    // but .output() manages the child. If we drop the future returned by .output(),
    // tokio::process::Command usually leaves it running.
    // To support cancellation, we should spawn and wait.

    cmd.kill_on_drop(true);
    // Suppress output unless error
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let child = cmd.spawn().context("Failed to spawn adb install")?;
    let output = child
        .wait_with_output()
        .await
        .context("Failed to wait for adb install")?;

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
    let mut cmd = Command::new("adb");
    cmd.args([
        "-s",
        device_serial,
        "shell",
        "monkey",
        "-p",
        app_id,
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
    ]);
    cmd.kill_on_drop(true);

    let output = cmd
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
        tokio::fs::read_to_string(&local_props_path)
            .await
            .unwrap_or_default()
    } else {
        String::new()
    };

    // Check if flutter.sdk is already set correctly
    let has_flutter_sdk = existing
        .lines()
        .any(|line| line.trim().starts_with("flutter.sdk="));

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
                .and_then(|p| p.parent())
            // flutter
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

// --- Video/AppSrc Helpers ---

async fn xdotool_search(display: &str, args: &[&str]) -> Option<Vec<u64>> {
    let out = Command::new("xdotool")
        .env("DISPLAY", display)
        .args(args)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return Some(vec![]);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut xids = vec![];
    for line in stdout.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if let Ok(x) = l.parse::<u64>() {
            xids.push(x);
        }
    }
    Some(xids)
}

async fn xdotool_window_geometry(display: &str, xid: u64) -> Option<(u32, u32)> {
    // xdotool getwindowgeometry --shell prints WIDTH/HEIGHT among other keys.
    let out = Command::new("xdotool")
        .env("DISPLAY", display)
        .args(["getwindowgeometry", "--shell", &xid.to_string()])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut w: Option<u32> = None;
    let mut h: Option<u32> = None;
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("WIDTH=") {
            w = v.trim().parse::<u32>().ok();
        } else if let Some(v) = line.strip_prefix("HEIGHT=") {
            h = v.trim().parse::<u32>().ok();
        }
    }
    match (w, h) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Some((w, h)),
        _ => None,
    }
}

fn parse_xvfb_resolution() -> Option<(i32, i32)> {
    // Keep in sync with emulator lifecycle defaults.
    let raw =
        std::env::var("SYNTHI_ANDROID_XVFB_RESOLUTION").unwrap_or_else(|_| "1440x2960".to_string());
    let s = raw.trim();
    let (w, h) = s.split_once('x')?;
    let w = w.trim().parse::<i32>().ok()?;
    let h = h.trim().parse::<i32>().ok()?;
    if w > 0 && h > 0 {
        Some((w, h))
    } else {
        None
    }
}

async fn xdotool_window_geometry_xywh(display: &str, xid: u64) -> Option<(i32, i32, i32, i32)> {
    // xdotool getwindowgeometry --shell prints X/Y/WIDTH/HEIGHT among other keys.
    let out = Command::new("xdotool")
        .env("DISPLAY", display)
        .args(["getwindowgeometry", "--shell", &xid.to_string()])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut x: Option<i32> = None;
    let mut y: Option<i32> = None;
    let mut w: Option<i32> = None;
    let mut h: Option<i32> = None;
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("X=") {
            x = v.trim().parse::<i32>().ok();
        } else if let Some(v) = line.strip_prefix("Y=") {
            y = v.trim().parse::<i32>().ok();
        } else if let Some(v) = line.strip_prefix("WIDTH=") {
            w = v.trim().parse::<i32>().ok();
        } else if let Some(v) = line.strip_prefix("HEIGHT=") {
            h = v.trim().parse::<i32>().ok();
        }
    }
    match (x, y, w, h) {
        (Some(x), Some(y), Some(w), Some(h)) if w > 0 && h > 0 => Some((x, y, w, h)),
        _ => None,
    }
}

async fn find_emulator_x11_window(display: &str) -> Option<(u64, u32, u32)> {
    if cfg!(target_os = "windows") {
        return None;
    }
    let d = display.trim();
    if d.is_empty() {
        return None;
    }

    // Collect candidate windows from multiple queries.
    let mut candidates: Vec<u64> = vec![];
    let queries: &[&[&str]] = &[
        &["search", "--name", "Android Emulator"],
        &["search", "--name", "Emulator"],
        &["search", "--class", "emulator"],
        &["search", "--classname", "emulator"],
    ];
    for q in queries {
        if let Some(mut xids) = xdotool_search(d, q).await {
            candidates.append(&mut xids);
        }
    }

    // De-dupe.
    candidates.sort_unstable();
    candidates.dedup();
    if candidates.is_empty() {
        return None;
    }

    // Pick the largest window by area; this avoids selecting tiny tooltips/overlays.
    let mut best: Option<(u64, u32, u32, u64)> = None; // (xid, w, h, area)
    for xid in candidates.iter().copied() {
        if let Some((w, h)) = xdotool_window_geometry(d, xid).await {
            let area = (w as u64) * (h as u64);
            match best {
                Some((_, _, _, best_area)) if area <= best_area => {}
                _ => best = Some((xid, w, h, area)),
            }
        }
    }

    if let Some((xid, w, h, _)) = best {
        return Some((xid, w, h));
    }

    // Fallback: return the last xid if geometry isn't available.
    let xid = candidates.last().copied()?;
    Some((xid, 0, 0))
}

/// Be patient for boot completion
async fn wait_for_boot_completion(
    adb_path: &PathBuf,
    device_serial: &str,
    log_dc: &Arc<RTCDataChannel>,
    session_id: &str,
) -> Result<()> {
    use tokio::process::Command;
    let start = Instant::now();
    let timeout = Duration::from_secs(60); // Max wait 60s (it says prewarm complete so should be fast)

    loop {
        if start.elapsed() > timeout {
            send_log(
                log_dc,
                session_id,
                "Warning: Specific boot check timed out (proceeding anyway)",
                "system",
            )
            .await;
            break;
        }

        let output = Command::new(adb_path)
            .args([
                "-s",
                device_serial,
                "shell",
                "getprop",
                "sys.boot_completed",
            ])
            .output()
            .await;

        match output {
            Ok(o) => {
                let s = String::from_utf8_lossy(&o.stdout);
                if s.trim() == "1" {
                    send_log(
                        log_dc,
                        session_id,
                        "Device boot verification success",
                        "system",
                    )
                    .await;
                    break;
                }
            }
            Err(_) => {}
        }

        sleep(Duration::from_millis(1000)).await;
        if start.elapsed().as_secs() % 5 == 0 {
            send_log(log_dc, session_id, "Waiting for device boot...", "system").await;
        }
    }
    Ok(())
}

/// Streams system logcat (no filter by PID)
async fn stream_system_logcat(
    log_dc: &Arc<RTCDataChannel>,
    session_id: &str,
    device_serial: &str,
) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    let mut child = Command::new("adb")
        .args([
            "-s",
            device_serial,
            "logcat",
            "-v",
            "time",
            // Don't filter by PID yet
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .context("Failed to start system logcat")?;

    let stdout = child.stdout.take().expect("stdout should be captured");
    let mut reader = BufReader::new(stdout).lines();

    while let Ok(Some(line)) = reader.next_line().await {
        if is_session_cancelled(session_id) {
            break;
        }
        // Send as raw log or parsed
        let entry = parse_logcat_line(&line);
        send_logcat(log_dc, session_id, &entry).await;
    }

    let _ = child.kill().await;
    Ok(())
}

fn spawn_video_bitrate_adaptation(
    pc: Arc<RTCPeerConnection>,
    pipeline: Arc<video_pipeline::EmulatorVideoPipeline>,
    log_dc: Arc<RTCDataChannel>,
    session_id: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3));
        let mut current_bitrate = 2000u32;

        loop {
            interval.tick().await;

            if pc.connection_state() == RTCPeerConnectionState::Closed
                || pc.connection_state() == RTCPeerConnectionState::Failed
            {
                break;
            }

            // Check if cancelled
            if crate::android::webrtc::input::is_session_cancelled(&session_id) {
                eprintln!(
                    "[webrtc-adapt] Session {} cancelled, stopping adaptation loop",
                    session_id
                );
                break;
            }

            // Fetch capabilities / stats
            let stats = pc.get_stats().await;
            let mut available_bitrate: Option<f64> = None;

            for (_, stat) in &stats.reports {
                if let StatsReportType::CandidatePair(cp) = stat {
                    // Check if this pair is actually sending packets.
                    if cp.packets_sent > 0 && cp.available_outgoing_bitrate > 0.0 {
                        available_bitrate = Some(cp.available_outgoing_bitrate);
                        break;
                    }
                }
            }

            if let Some(avail_bits) = available_bitrate {
                let avail_kbps = (avail_bits / 1000.0) as u32;

                // Apply conservative factor (80%)
                let target_kbps = (avail_kbps as f64 * 0.8) as u32;

                // Smoothing: New = 0.7 * Current + 0.3 * Target
                let new_bitrate = (0.7 * current_bitrate as f64 + 0.3 * target_kbps as f64) as u32;

                // Clamp (500kbps - 6000kbps)
                let clamped_bitrate = new_bitrate.max(500).min(6000);

                // Threshold > 10% change to avoid spam
                let diff = (clamped_bitrate as i32 - current_bitrate as i32).abs();
                // ALWAYS log for now to see what's happening
                if diff > (current_bitrate as i32 / 10) {
                    eprintln!(
                        "[webrtc-adapt] est={} kbps -> target={} kbps (current={})",
                        avail_kbps, clamped_bitrate, current_bitrate
                    );
                    if diff > (current_bitrate as i32 / 10) {
                        if let Err(e) = pipeline.set_target_bitrate(clamped_bitrate) {
                            eprintln!("[webrtc-adapt] set_target_bitrate failed: {}", e);
                        } else {
                            current_bitrate = clamped_bitrate;
                            crate::android::webrtc::send_log(
                                &log_dc,
                                &session_id,
                                &format!(
                                    "[adapt] Bitrate adjusted to {} kbps (est available: {} kbps)",
                                    clamped_bitrate, avail_kbps
                                ),
                                "system",
                            )
                            .await;
                        }
                    }
                }
            }
        }
    })
}
