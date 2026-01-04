use anyhow::{bail, Context, Result};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio::sync::Mutex;
use tokio::time::sleep;
use webrtc::data_channel::RTCDataChannel;

use crate::android::fs::{
    reconcile_and_stream_with_rules, take_snapshot_with_rules, ReconcileConfig, SyncRules,
};
use crate::android::webrtc::{
    bytes_to_b64, send_emulator_frame, send_emulator_frame_chunked, send_log, send_logcat,
    send_mobile_capabilities, send_status,
};
use crate::android::emulator::{
    acquire_emulator_daemon, detect_kvm, ensure_emulator_ready, EmulatorConfig, EnsureReadyResult,
    LogcatEntry,
};
use crate::android::react_native::{
    build_apk_for_emulator, check_android_sdk, detect_react_native_project, BuildVariant,
    EmulatorBuildConfig,
};

use super::project_detection::find_react_native_project_root;

use crate::android::webrtc::frames::{capture_screencap_png, compress_frame_for_preview};

/// Handles a React Native emulator job.
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

    // Tell the frontend what streaming/input transports are available.
    send_mobile_capabilities(&log_dc, &session_id).await;

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

    // Start emulator prewarm in the background so it can boot while Gradle builds.
    // IMPORTANT: we do not send status updates here (to avoid UI state churn);
    // we only emit log lines for verification.
    let overlap_start = Instant::now();

    let mut emulator_config = EmulatorConfig::default();
    emulator_config.android_sdk_root = sdk_root.clone();

    // Hardware accel (KVM) detection + logging.
    // We only enable `-accel on` if /dev/kvm exists AND is accessible.
    let kvm = detect_kvm();
    emulator_config.use_hw_accel = kvm.accessible;
    send_log(
        &log_dc,
        &session_id,
        &format!(
            "[kvm] exists={} accessible={} -> accel {} ({})",
            kvm.exists,
            kvm.accessible,
            if emulator_config.use_hw_accel { "on" } else { "off" },
            kvm.reason
        ),
        "emulator",
    )
    .await;

    let prewarm_config = emulator_config.clone();
    let log_dc_for_prewarm = log_dc.clone();
    let session_id_for_prewarm = session_id.clone();
    let emulator_prewarm = tokio::spawn(async move {
        let start = Instant::now();
        send_log(
            &log_dc_for_prewarm,
            &session_id_for_prewarm,
            "[overlap] Starting emulator prewarm in background",
            "emulator",
        )
        .await;

        let res = ensure_emulator_ready(prewarm_config).await;
        match &res {
            Ok(info) => {
                send_log(
                    &log_dc_for_prewarm,
                    &session_id_for_prewarm,
                    &format!(
                        "[overlap] Emulator prewarm complete (reused={} boot_time_ms={} elapsed_ms={})",
                        info.reused,
                        info.boot_time_ms,
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
                    &format!(
                        "[overlap] Emulator prewarm failed (elapsed_ms={}): {:#}",
                        start.elapsed().as_millis(),
                        e
                    ),
                    "emulator",
                )
                .await;
            }
        }

        res
    });

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
                        &format!(
                            "Workspace snapshot failed (will skip reconciliation): {e:#}"
                        ),
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

    send_log(
        &log_dc,
        &session_id,
        "[overlap] Gradle build started while emulator prewarm runs",
        "system",
    )
    .await;

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
    let recent_lines: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::with_capacity(200)));

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

            // Don't leave a background boot task running for a failed job.
            emulator_prewarm.abort();

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
        // Don't leave a background boot task running for a failed job.
        emulator_prewarm.abort();

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

    send_log(
        &log_dc,
        &session_id,
        &format!(
            "[overlap] Build complete; waiting for reconcile + emulator (elapsed_ms={})",
            overlap_start.elapsed().as_millis()
        ),
        "system",
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

    // Step 4: Boot (or reuse) emulator via daemon
    send_status(
        &log_dc,
        &session_id,
        "booting-emulator",
        "Booting Android emulator...",
        None,
    )
    .await;

    // Ensure background prewarm completes before acquiring the daemon lock.
    // This avoids contention (both paths touch the same global daemon mutex).
    let _ = emulator_prewarm.await;

    send_log(
        &log_dc,
        &session_id,
        &format!(
            "[overlap] Proceeding to emulator acquire after build/reconcile (elapsed_ms={})",
            overlap_start.elapsed().as_millis()
        ),
        "system",
    )
    .await;

    // Heartbeat while acquiring; cold boots can take many minutes.
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

    let (mut daemon, ready): (tokio::sync::MutexGuard<'static, _>, EnsureReadyResult) =
        acquire_emulator_daemon(emulator_config)
            .await
            .context("Failed to acquire emulator daemon")?;
    let _ = boot_done_tx.send(true);

    let emulator_serial = ready.serial.clone();

    send_status(
        &log_dc,
        &session_id,
        "emulator-ready",
        if ready.reused { "Emulator reused" } else { "Emulator booted" },
        Some(json!({
            "serial": emulator_serial,
            "boot_time_ms": ready.boot_time_ms,
            "reused": ready.reused,
        })),
    )
    .await;

    // Step 5: Install APK
    send_status(&log_dc, &session_id, "installing", "Installing APK...", None).await;

    let install_result = daemon
        .session_mut()
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
        // Reset emulator on failure (daemon-managed)
        daemon.shutdown_now().await;
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

    let launch_result = daemon
        .session_mut()
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
        daemon.shutdown_now().await;
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

    daemon
        .session_mut()
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
    let adb_for_frames = if cfg!(windows) {
        sdk_root.join("platform-tools/adb.exe")
    } else {
        sdk_root.join("platform-tools/adb")
    };
    let serial_for_frames = emulator_serial.clone();

    tokio::spawn(async move {
        // Conservative defaults to avoid overwhelming the datachannel.
        const FRAME_INTERVAL: Duration = Duration::from_secs(2);
        const STREAM_DURATION: Duration = Duration::from_secs(120);
        // If base64 is still huge after compression, fall back to chunking.
        const MAX_B64_INLINE: usize = 45_000;
        // Hard safety cap after compression (should be rare with resizing).
        const MAX_BYTES_AFTER_COMPRESS: usize = 2_000_000;

        let start = Instant::now();
        let mut last_error_at: Option<Instant> = None;

        // One-time log line so we can diagnose "black screen" reports from the UI.
        send_log(
            &log_dc_for_frames,
            &session_id_for_frames,
            &format!(
                "[frames] starting screenshot stream (interval={}ms duration={}s)",
                FRAME_INTERVAL.as_millis(),
                STREAM_DURATION.as_secs()
            ),
            "emulator",
        )
        .await;

        while start.elapsed() < STREAM_DURATION {
            match capture_screencap_png(&adb_for_frames, &serial_for_frames).await {
                Ok(png) => {
                    // IMPORTANT: Do not gate on the raw PNG size.
                    // Raw screencap PNGs can easily exceed a conservative threshold even though
                    // the compressed/resized preview is small; gating before compression causes
                    // "black screen" (no frames ever sent).
                    let (mime, bytes) = match compress_frame_for_preview(&png) {
                        Ok(v) => v,
                        Err(_) => ("image/png".to_string(), png),
                    };

                    if bytes.len() > MAX_BYTES_AFTER_COMPRESS {
                        let should_log = last_error_at
                            .map(|t| t.elapsed() > Duration::from_secs(15))
                            .unwrap_or(true);
                        if should_log {
                            send_log(
                                &log_dc_for_frames,
                                &session_id_for_frames,
                                &format!(
                                    "[frames] skipping oversized compressed frame ({} bytes)",
                                    bytes.len()
                                ),
                                "emulator",
                            )
                            .await;
                            last_error_at = Some(Instant::now());
                        }
                        sleep(FRAME_INTERVAL).await;
                        continue;
                    }

                    let b64 = bytes_to_b64(&bytes);
                    if b64.len() <= MAX_B64_INLINE {
                        send_emulator_frame(
                            &log_dc_for_frames,
                            &session_id_for_frames,
                            &mime,
                            &b64,
                            bytes.len(),
                        )
                        .await;
                    } else {
                        send_emulator_frame_chunked(
                            &log_dc_for_frames,
                            &session_id_for_frames,
                            &mime,
                            &b64,
                            bytes.len(),
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

    // Release the emulator back to the daemon (keep alive for next jobs)
    daemon.release_keepalive().await;

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

    Ok(())
}
