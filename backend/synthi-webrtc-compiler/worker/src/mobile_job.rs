// ============================================================
// MOBILE EMULATOR JOB HANDLER
// ============================================================
// Orchestrates the full mobile development workflow:
// 1. Detect React Native project
// 2. Build APK via Gradle
// 3. Boot Android emulator (headless)
// 4. Install APK
// 5. Launch app
// 6. Stream logcat back to frontend
// ============================================================

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STD;
use base64::Engine;
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout};
use webrtc::data_channel::RTCDataChannel;

use crate::android_emulator::{EmulatorConfig, EmulatorSession, LogcatEntry};
use crate::react_native_builder::{
    build_apk_for_emulator, check_android_sdk, detect_react_native_project, BuildVariant,
    EmulatorBuildConfig,
};
use crate::workspace_reconcile::{
    reconcile_and_stream_with_rules, take_snapshot_with_rules, ReconcileConfig, Snapshot, SyncRules,
};

// ============================================================
// JOB STATUS MESSAGES
// ============================================================

/// Sends a status update to the frontend via the build-log channel
async fn send_status(
    log_dc: &Arc<RTCDataChannel>,
    session_id: &str,
    status: &str,
    message: &str,
    data: Option<serde_json::Value>,
) {
    let payload = json!({
        "sessionId": session_id,
        "type": "mobile-status",
        "status": status,
        "message": message,
        "data": data,
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;
}

/// Sends a log line to the frontend
async fn send_log(log_dc: &Arc<RTCDataChannel>, session_id: &str, line: &str, source: &str) {
    let payload = json!({
        "sessionId": session_id,
        "type": "mobile-log",
        "source": source,
        "line": line,
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;
}

/// Sends logcat entry to frontend
async fn send_logcat(log_dc: &Arc<RTCDataChannel>, session_id: &str, entry: &LogcatEntry) {
    let payload = json!({
        "sessionId": session_id,
        "type": "logcat",
        "entry": entry,
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;
}

/// Sends a single emulator frame (PNG, base64) to the frontend.
async fn send_emulator_frame(
    log_dc: &Arc<RTCDataChannel>,
    session_id: &str,
    png_b64: &str,
    bytes: usize,
) {
    let payload = json!({
        "sessionId": session_id,
        "type": "emulator-frame",
        "data": {
            "mime": "image/png",
            "png_b64": png_b64,
            "bytes": bytes,
        }
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;
}

async fn capture_screencap_png(adb: &PathBuf, serial: &str) -> Result<Vec<u8>> {
    // `exec-out` returns raw bytes on stdout. This is the simplest way to capture
    // pixels without needing shared folders, framebuffer access, or a video pipeline.
    let out = timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(adb)
            .args(["-s", serial, "exec-out", "screencap", "-p"])
            .output(),
    )
    .await
    .context("screencap timeout")?
    .context("Failed to run adb exec-out screencap")?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        bail!("adb screencap failed (status={:?}) stderr={}", out.status.code(), stderr);
    }

    // Basic PNG signature check.
    const PNG_SIG: &[u8] = b"\x89PNG\r\n\x1a\n";
    if out.stdout.len() < PNG_SIG.len() || &out.stdout[..PNG_SIG.len()] != PNG_SIG {
        bail!("adb screencap did not return PNG bytes (len={})", out.stdout.len());
    }

    Ok(out.stdout)
}

// ============================================================
// PROJECT DETECTION HELPERS
// ============================================================

/// Searches up from start_path to find the nearest directory containing
/// a package.json with react-native as a dependency.
/// Will not search above workspace_root.
async fn find_react_native_project_root(
    start_path: &PathBuf,
    workspace_root: &PathBuf,
) -> Result<PathBuf> {
    let mut current = start_path.clone();

    // If start_path is a file, get its parent directory
    if current.is_file() {
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        }
    }

    loop {
        let package_json = current.join("package.json");
        if package_json.exists() {
            // Read and check for react-native dependency
            if let Ok(content) = tokio::fs::read_to_string(&package_json).await {
                if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
                    let has_rn = pkg
                        .get("dependencies")
                        .and_then(|d| d.get("react-native"))
                        .is_some()
                        || pkg
                            .get("devDependencies")
                            .and_then(|d| d.get("react-native"))
                            .is_some();

                    if has_rn {
                        return Ok(current);
                    }
                }
            }
        }

        // Don't search above workspace root
        if current == *workspace_root || current.parent().is_none() {
            break;
        }

        // Move up one directory
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }

    bail!(
        "No React Native project found. Searched from {} up to {}",
        start_path.display(),
        workspace_root.display()
    )
}

// ============================================================
// MAIN JOB HANDLER
// ============================================================

/// Handles a React Native emulator job
///
/// This orchestrates the full flow:
/// 1. Project detection
/// 2. APK build
/// 3. Emulator boot
/// 4. Install + launch
/// 5. Logcat streaming
pub async fn handle_react_native_emulator_job(
    log_dc: Arc<RTCDataChannel>,
    session_id: String,
    workspace_path: PathBuf,
    project_root: Option<String>,
    is_release: bool,
) -> Result<()> {
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

    send_status(
        &log_dc,
        &session_id,
        "starting",
        "Starting React Native emulator job...",
        None,
    )
    .await;

    // Step 1: Detect React Native project by searching up from start_path
    send_status(
        &log_dc,
        &session_id,
        "detecting",
        "Detecting React Native project...",
        None,
    )
    .await;

    // Search for package.json with react-native starting from start_path and going up
    let project_path = find_react_native_project_root(&start_path, &workspace_path)
        .await
        .context("Failed to find React Native project")?;

    let project_info = detect_react_native_project(&project_path)
        .await
        .context("Failed to detect React Native project")?;

    if !project_info.is_react_native_project {
        send_status(
            &log_dc,
            &session_id,
            "error",
            "Not a React Native project",
            Some(json!({
                "path": project_path.display().to_string(),
            })),
        )
        .await;
        bail!("Not a React Native project: {}", project_path.display());
    }

    send_status(
        &log_dc,
        &session_id,
        "detected",
        "React Native project detected",
        Some(json!({
            "app_name": project_info.app_name,
            "app_id": project_info.app_id,
            "rn_version": project_info.react_native_version,
        })),
    )
    .await;

    // Step 2: Check Android SDK health
    send_status(
        &log_dc,
        &session_id,
        "checking-sdk",
        "Checking Android SDK...",
        None,
    )
    .await;

    let sdk_health = check_android_sdk()
        .await
        .context("Failed to check Android SDK")?;

    let sdk_root = sdk_health
        .sdk_path
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/opt/android-sdk"));

    if !sdk_health.is_ready() {
        let issues: Vec<String> = [
            if !sdk_health.adb_ok {
                Some("adb not found".to_string())
            } else {
                None
            },
            if !sdk_health.emulator_ok {
                Some("emulator not found".to_string())
            } else {
                None
            },
            if !sdk_health.avdmanager_ok {
                Some("avdmanager not found".to_string())
            } else {
                None
            },
            if sdk_health.system_images.is_empty() {
                Some("no system images installed".to_string())
            } else {
                None
            },
        ]
        .into_iter()
        .flatten()
        .collect();

        send_status(
            &log_dc,
            &session_id,
            "error",
            "Android SDK not ready",
            Some(json!({
                "sdk_path": sdk_health.sdk_path,
                "issues": issues,
                "details": sdk_health.issues,
            })),
        )
        .await;
        bail!("Android SDK not ready: {:?}", issues);
    }

    send_log(
        &log_dc,
        &session_id,
        &format!("Android SDK ready at {:?}", sdk_root),
        "system",
    )
    .await;

    // Phase 1: snapshot only the Android Gradle subtree that we intend to persist back.
    // This ensures that when `android/` is first generated, it is included in the diff.
    let (pre_build_snapshot, sync_rules, sync_cfg) =
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

            let snap = match take_snapshot_with_rules(&workspace_path, rules.clone()).await {
                Ok(s) => Some(s),
                Err(e) => {
                    send_log(
                        &log_dc,
                        &session_id,
                        &format!("Workspace snapshot failed (will skip reconciliation): {e:#}"),
                        "system",
                    )
                    .await;
                    None
                }
            };

            (snap, Some(rules), Some(cfg))
        } else {
            send_log(
                &log_dc,
                &session_id,
                "Project path is outside workspace; reconciliation will be disabled",
                "system",
            )
            .await;
            (None, None, None)
        };

    // Step 3: Build APK
    send_status(&log_dc, &session_id, "building", "Building APK...", None).await;

    // Create build config
    let build_config = EmulatorBuildConfig {
        project_root: project_path.clone(),
        variant: if is_release {
            BuildVariant::Release
        } else {
            BuildVariant::Debug
        },
        extra_gradle_args: vec![],
        env: HashMap::new(),
    };

    // Keep a small rolling buffer of recent Gradle output so we can surface a useful
    // error snippet to the frontend on failure.
    let recent_lines: Arc<Mutex<VecDeque<String>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(200)));

    // Create log callback that forwards to the frontend
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
            send_log(&dc, &sid, &line, "gradle").await;
        });
    });

    // Heartbeat while building so the frontend doesn't look frozen during long Gradle phases.
    let (build_done_tx, mut build_done_rx) = watch::channel(false);
    {
        let dc = log_dc.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let start = Instant::now();
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        if *build_done_rx.borrow() {
                            break;
                        }
                        send_status(&dc, &sid, "building", "Building APK...", Some(json!({
                            "elapsed_ms": start.elapsed().as_millis() as u64,
                        }))).await;
                    }
                    changed = build_done_rx.changed() => {
                        if changed.is_ok() && *build_done_rx.borrow() {
                            break;
                        }
                    }
                }
            }
        });
    }

    let build_result = match build_apk_for_emulator(&build_config, Some(log_callback)).await {
        Ok(r) => {
            let _ = build_done_tx.send(true);
            r
        }
        Err(e) => {
            let _ = build_done_tx.send(true);
            send_status(
                &log_dc,
                &session_id,
                "build-failed",
                "APK build failed",
                Some(json!({
                    "error": format!("{:#}", e),
                })),
            )
            .await;

            // Phase 2: reconcile any partial Android/Gradle artifacts created before failure.
            if let (Some(snapshot), Some(rules), Some(cfg)) = (
                pre_build_snapshot.clone(),
                sync_rules.clone(),
                sync_cfg.clone(),
            ) {
                send_status(
                    &log_dc,
                    &session_id,
                    "reconciling",
                    "Syncing generated Android/Gradle files back to workspace...",
                    None,
                )
                .await;
                if let Err(sync_err) = reconcile_and_stream_with_rules(
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
                        &format!("Workspace reconciliation failed (non-fatal): {sync_err:#}"),
                        "system",
                    )
                    .await;
                }
            }
            return Err(e).context("APK build failed");
        }
    };

    if !build_result.success {
        let snapshot: Vec<String> = {
            let buf = recent_lines.lock().await;
            buf.iter().cloned().collect()
        };

        // Prefer the section starting at the last "FAILURE: Build failed" if present.
        let start_idx = snapshot
            .iter()
            .rposition(|l| l.contains("FAILURE: Build failed"))
            .unwrap_or_else(|| snapshot.len().saturating_sub(60));
        let snippet = snapshot
            .into_iter()
            .skip(start_idx)
            .take(120)
            .collect::<Vec<_>>()
            .join("\n");

        send_status(
            &log_dc,
            &session_id,
            "build-failed",
            "APK build failed",
            Some(json!({
                "diagnostics": build_result.diagnostics,
                "error": snippet,
            })),
        )
        .await;

        // Phase 2: reconcile any partial artifacts from a failed build.
        if let (Some(snapshot), Some(rules), Some(cfg)) = (
            pre_build_snapshot.clone(),
            sync_rules.clone(),
            sync_cfg.clone(),
        ) {
            send_status(
                &log_dc,
                &session_id,
                "reconciling",
                "Syncing generated Android/Gradle files back to workspace...",
                None,
            )
            .await;
            if let Err(sync_err) = reconcile_and_stream_with_rules(
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
                    &format!("Workspace reconciliation failed (non-fatal): {sync_err:#}"),
                    "system",
                )
                .await;
            }
        }
        bail!("APK build failed");
    }

    let apk_path = build_result
        .apk_path
        .ok_or_else(|| anyhow::anyhow!("Build succeeded but no APK path returned"))?;

    send_status(
        &log_dc,
        &session_id,
        "built",
        "APK built successfully",
        Some(json!({
            "apk_path": apk_path.display().to_string(),
            "build_duration_ms": build_result.build_duration_ms,
        })),
    )
    .await;

    // Phase 2: reconcile generated wrapper/config (and optional build outputs) back to the real workspace.
    if let (Some(snapshot), Some(rules), Some(cfg)) = (pre_build_snapshot, sync_rules, sync_cfg) {
        send_status(
            &log_dc,
            &session_id,
            "reconciling",
            "Syncing generated Android/Gradle files back to workspace...",
            None,
        )
        .await;

        // Heartbeat while reconciling so the frontend doesn't assume the worker died
        // if hashing/streaming takes a while.
        let (sync_done_tx, mut sync_done_rx) = watch::channel(false);
        {
            let dc = log_dc.clone();
            let sid = session_id.clone();
            tokio::spawn(async move {
                let start = Instant::now();
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = interval.tick() => {
                            if *sync_done_rx.borrow() {
                                break;
                            }
                            send_status(&dc, &sid, "reconciling", "Syncing generated Android/Gradle files back to workspace...", Some(json!({
                                "elapsed_ms": start.elapsed().as_millis() as u64,
                            }))).await;
                        }
                        changed = sync_done_rx.changed() => {
                            if changed.is_ok() && *sync_done_rx.borrow() {
                                break;
                            }
                        }
                    }
                }
            });
        }

        let sync_res = reconcile_and_stream_with_rules(
            log_dc.clone(),
            &session_id,
            &workspace_path,
            snapshot,
            rules,
            cfg,
        )
        .await;
        let _ = sync_done_tx.send(true);

        if let Err(sync_err) = sync_res {
            send_log(
                &log_dc,
                &session_id,
                &format!("Workspace reconciliation failed (non-fatal): {sync_err:#}"),
                "system",
            )
            .await;
        }
    }

    // Step 4: Boot emulator
    send_status(
        &log_dc,
        &session_id,
        "booting-emulator",
        "Booting Android emulator...",
        None,
    )
    .await;

    let mut emulator_config = EmulatorConfig::default();
    emulator_config.android_sdk_root = sdk_root.clone();

    // If the worker has KVM available, enable hardware acceleration.
    // This dramatically reduces emulator boot time and flakiness.
    #[cfg(target_os = "linux")]
    {
        if std::path::Path::new("/dev/kvm").exists() {
            emulator_config.use_hw_accel = true;
        }
    }

    let mut emulator = EmulatorSession::new(emulator_config);

    // Heartbeat while booting; cold boots can take many minutes.
    let (boot_done_tx, mut boot_done_rx) = watch::channel(false);
    {
        let dc = log_dc.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let start = Instant::now();
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        if *boot_done_rx.borrow() {
                            break;
                        }
                        send_status(&dc, &sid, "booting-emulator", "Booting Android emulator...", Some(json!({
                            "elapsed_ms": start.elapsed().as_millis() as u64,
                        }))).await;
                    }
                    changed = boot_done_rx.changed() => {
                        if changed.is_ok() && *boot_done_rx.borrow() {
                            break;
                        }
                    }
                }
            }
        });
    }

    let boot_result = emulator.boot().await.context("Failed to boot emulator")?;
    let _ = boot_done_tx.send(true);

    if !boot_result.success {
        send_status(
            &log_dc,
            &session_id,
            "error",
            "Emulator boot failed",
            Some(json!({
                "error": boot_result.error,
                "boot_time_ms": boot_result.boot_time_ms,
            })),
        )
        .await;
        bail!("Emulator boot failed: {:?}", boot_result.error);
    }

    let emulator_serial = boot_result.serial.clone().unwrap_or_default();

    send_status(
        &log_dc,
        &session_id,
        "emulator-ready",
        "Emulator booted",
        Some(json!({
            "serial": emulator_serial,
            "boot_time_ms": boot_result.boot_time_ms,
        })),
    )
    .await;

    // Step 5: Install APK
    send_status(
        &log_dc,
        &session_id,
        "installing",
        "Installing APK...",
        None,
    )
    .await;

    let install_result = emulator
        .install_apk(&apk_path)
        .await
        .context("Failed to install APK")?;

    if !install_result.success {
        send_status(
            &log_dc,
            &session_id,
            "error",
            "APK install failed",
            Some(json!({
                "error": install_result.error,
            })),
        )
        .await;
        // Shutdown emulator on failure
        let _ = emulator.shutdown().await;
        bail!("APK install failed: {:?}", install_result.error);
    }

    let package_name = install_result
        .package_name
        .clone()
        .or_else(|| project_info.app_id.clone())
        .unwrap_or_else(|| "com.unknown.app".to_string());

    send_status(
        &log_dc,
        &session_id,
        "installed",
        "APK installed",
        Some(json!({
            "package_name": package_name,
            "install_time_ms": install_result.install_time_ms,
        })),
    )
    .await;

    // Step 6: Launch app
    send_status(&log_dc, &session_id, "launching", "Launching app...", None).await;

    let launch_result = emulator
        .launch_app(&package_name)
        .await
        .context("Failed to launch app")?;

    if !launch_result.success {
        send_status(
            &log_dc,
            &session_id,
            "error",
            "App launch failed",
            Some(json!({
                "error": launch_result.error,
            })),
        )
        .await;
        let _ = emulator.shutdown().await;
        bail!("App launch failed: {:?}", launch_result.error);
    }

    send_status(
        &log_dc,
        &session_id,
        "running",
        "App running",
        Some(json!({
            "activity": launch_result.activity,
            "launch_time_ms": launch_result.launch_time_ms,
        })),
    )
    .await;

    // Step 7: Start logcat streaming
    send_status(&log_dc, &session_id, "streaming", "Streaming logs...", None).await;

    let (logcat_tx, mut logcat_rx) = mpsc::unbounded_channel::<LogcatEntry>();

    emulator
        .start_logcat(Some(&package_name), logcat_tx)
        .await
        .context("Failed to start logcat")?;

    // Forward logcat entries to frontend
    let log_dc_for_logcat = log_dc.clone();
    let session_id_for_logcat = session_id.clone();

    tokio::spawn(async move {
        while let Some(entry) = logcat_rx.recv().await {
            send_logcat(&log_dc_for_logcat, &session_id_for_logcat, &entry).await;
        }
    });

    // Step 8: Stream emulator frames (PNG screenshots) for a short window.
    // This is a minimal, portable preview mechanism that works even when we do not
    // have a WebRTC video track carrying emulator pixels.
    let log_dc_for_frames = log_dc.clone();
    let session_id_for_frames = session_id.clone();
    let adb_for_frames = sdk_root.join("platform-tools/adb");
    let serial_for_frames = emulator_serial.clone();

    tokio::spawn(async move {
        // Conservative defaults to avoid overwhelming the datachannel.
        const MAX_PNG_BYTES: usize = 600_000;
        const FRAME_INTERVAL: Duration = Duration::from_secs(2);
        const STREAM_DURATION: Duration = Duration::from_secs(120);

        let start = Instant::now();
        let mut last_error_at: Option<Instant> = None;

        while start.elapsed() < STREAM_DURATION {
            match capture_screencap_png(&adb_for_frames, &serial_for_frames).await {
                Ok(png) => {
                    if png.len() <= MAX_PNG_BYTES {
                        let b64 = BASE64_STD.encode(&png);
                        send_emulator_frame(
                            &log_dc_for_frames,
                            &session_id_for_frames,
                            &b64,
                            png.len(),
                        )
                        .await;
                    }
                }
                Err(e) => {
                    // Avoid spamming logs if screencap fails repeatedly.
                    let should_log = last_error_at
                        .map(|t| t.elapsed() > Duration::from_secs(15))
                        .unwrap_or(true);
                    if should_log {
                        send_log(
                            &log_dc_for_frames,
                            &session_id_for_frames,
                            &format!("[frames] screencap failed: {}", e),
                            "emulator",
                        )
                        .await;
                        last_error_at = Some(Instant::now());
                    }
                }
            }

            sleep(FRAME_INTERVAL).await;
        }
    });

    // Send final success status
    send_status(
        &log_dc,
        &session_id,
        "done",
        "Mobile job completed successfully",
        Some(json!({
            "success": true,
            "package_name": package_name,
            "emulator_serial": emulator_serial,
        })),
    )
    .await;

    // Note: The emulator keeps running. In a real implementation, you'd want to:
    // - Store the EmulatorSession for later shutdown
    // - Listen for a "stop" command from the frontend
    // - Implement a timeout/watchdog

    // For now, we keep the emulator running until session timeout or explicit stop
    // The EmulatorSession will be dropped when this function returns, but the
    // emulator process continues (it's detached). A proper implementation would
    // store the session in a global map keyed by session_id.

    Ok(())
}

// ============================================================
// HELPER: Quick health check
// ============================================================

/// Quick check if mobile emulator workflow is available
pub async fn is_mobile_emulator_available() -> bool {
    if let Ok(health) = check_android_sdk().await {
        health.is_ready()
    } else {
        false
    }
}
