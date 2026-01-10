use anyhow::{bail, Context, Result};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use gstreamer as gst;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout};
use tokio::process::Command;
use tokio::net::TcpStream;
use webrtc::data_channel::RTCDataChannel;
use webrtc::data_channel::data_channel_state::RTCDataChannelState;

use crate::android::fs::{
    reconcile_and_stream_with_rules, take_snapshot_with_rules, ReconcileConfig, SyncRules,
};
use crate::android::webrtc::{send_log, send_logcat, send_mobile_capabilities, send_status};
use crate::android::webrtc::{input as emulator_input, video_pipeline};
use crate::android::webrtc::{EmulatorStreamConfig, EmulatorStreamMode};
use crate::android::webrtc::input::{is_session_cancelled, clear_cancelled_session};
use crate::android::emulator_grpc;
use crate::android::emulator::{
    acquire_emulator_daemon, detect_kvm, ensure_emulator_ready, EmulatorConfig, EnsureReadyResult,
    LogcatEntry,
};
use crate::android::react_native::{
    build_apk_for_emulator, check_android_sdk, detect_react_native_project, BuildVariant,
    EmulatorBuildConfig,
};

use super::project_detection::find_react_native_project_root;

use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::track::track_local::TrackLocal;

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
    let raw = std::env::var("SYNTHI_ANDROID_XVFB_RESOLUTION").unwrap_or_else(|_| "1440x2960".to_string());
    let s = raw.trim();
    let (w, h) = s.split_once('x')?;
    let w = w.trim().parse::<i32>().ok()?;
    let h = h.trim().parse::<i32>().ok()?;
    if w > 0 && h > 0 { Some((w, h)) } else { None }
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

async fn wait_for_grpc_ready(host: &str, port: u16, total_timeout: Duration) -> Result<()> {
    let addr = format!("{}:{}", host, port);
    let start = Instant::now();
    loop {
        if start.elapsed() >= total_timeout {
            bail!("gRPC port {} not reachable within {:?}", addr, total_timeout);
        }

        let attempt = timeout(Duration::from_millis(500), TcpStream::connect(&addr)).await;
        if let Ok(Ok(_stream)) = attempt {
            return Ok(());
        }

        sleep(Duration::from_millis(250)).await;
    }
}

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
    pc: Arc<RTCPeerConnection>,
) -> Result<()> {
    // Version marker to identify deployed binary - this helps detect stale binaries
    const JOB_HANDLER_VERSION: &str = "v2-webrtc-video-2025-01-18";
    eprintln!("[mobile-job] Starting handle_react_native_emulator_job version={}", JOB_HANDLER_VERSION);
    
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

    // Log version to frontend so we can verify which code is actually running
    send_log(
        &log_dc,
        &session_id,
        &format!("[worker] Job handler version: {} (webrtc_video=true, no screenshot fallback)", JOB_HANDLER_VERSION),
        "worker",
    )
    .await;

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

    let stream_config = EmulatorStreamConfig::from_env();
    send_log(
        &log_dc,
        &session_id,
        &format!(
            "[stream] mode={:?} grpc={}:{} token={}",
            stream_config.mode,
            stream_config.grpc.host,
            stream_config.grpc.port,
            stream_config.grpc.use_token
        ),
        "emulator",
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

    // Start emulator prewarm in the background so it can boot while Gradle builds.
    // IMPORTANT: we do not send status updates here (to avoid UI state churn);
    // we only emit log lines for verification.
    let overlap_start = Instant::now();

    let mut emulator_config = EmulatorConfig::default();
    emulator_config.android_sdk_root = sdk_root.clone();

    if stream_config.mode == EmulatorStreamMode::Grpc {
        let grpc_gpu = std::env::var("SYNTHI_ANDROID_EMULATOR_GPU")
            .unwrap_or_else(|_| "swiftshader_indirect".to_string());
        emulator_config
            .extra_args
            .extend(vec![
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

    // Check for cancellation before starting the build
    if is_session_cancelled(&session_id) {
        eprintln!("[mobile-job] Session {} cancelled before build", session_id);
        clear_cancelled_session(&session_id);
        bail!("Session cancelled by user");
    }

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

    if stream_config.mode == EmulatorStreamMode::Grpc {
        send_log(
            &log_dc,
            &session_id,
            &format!(
                "[grpc] waiting for emulator gRPC port {}:{} to become reachable",
                stream_config.grpc.host, stream_config.grpc.port
            ),
            "emulator",
        )
        .await;

        wait_for_grpc_ready(
            &stream_config.grpc.host,
            stream_config.grpc.port,
            Duration::from_secs(15),
        )
        .await
        .context("emulator gRPC port not reachable")?;

        send_log(
            &log_dc,
            &session_id,
            &format!(
                "[grpc] emulator gRPC port ready at {}:{}",
                stream_config.grpc.host, stream_config.grpc.port
            ),
            "emulator",
        )
        .await;
    }

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

    // Step 7: Start logcat streaming (best-effort; may be chatty).
    send_status(&log_dc, &session_id, "streaming", "Starting device logs...", None).await;

    let (logcat_tx, mut logcat_rx) = mpsc::unbounded_channel::<LogcatEntry>();
    let logcat_started = daemon
        .session_mut()
        .start_logcat(Some(&package_name), logcat_tx)
        .await
        .is_ok();

    // Forward logcat entries to frontend.
    // Note: the frontend may choose to ignore these messages.
    let log_dc_for_logcat = log_dc.clone();
    let session_id_for_logcat = session_id.clone();
    let logcat_task = tokio::spawn(async move {
        while let Some(entry) = logcat_rx.recv().await {
            send_logcat(&log_dc_for_logcat, &session_id_for_logcat, &entry).await;
        }
    });

    // Step 8: Start real-time emulator video track (GStreamer RTP -> WebRTC video track).
    // Also enable the emulator-input backchannel.
    let adb_path = if cfg!(windows) {
        sdk_root.join("platform-tools/adb.exe")
    } else {
        sdk_root.join("platform-tools/adb")
    };

    emulator_input::register_session(
        &session_id,
        adb_path.clone(),
        emulator_serial.clone(),
        stream_config.clone(),
    )
    .await?;

    let mut grpc_frame_task: Option<tokio::task::JoinHandle<()>> = None;

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
        if let Ok((w, h)) = emulator_input::query_device_size(&adb_path, &emulator_serial).await {
            if w > 0 && h > 0 {
                app_cfg.width = w;
                app_cfg.height = h;
            }
        }

        send_log(
            &log_dc,
            &session_id,
            &format!(
                "[video] starting GStreamer appsrc pipeline: {}",
                video_pipeline::EmulatorVideoPipeline::debug_appsrc_pipeline_string(&app_cfg)
            ),
            "emulator",
        )
        .await;

        let mut frame_rx = match emulator_grpc::stream_frames(&stream_config.grpc).await {
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
                return Err(e).context("failed to start emulator gRPC frame stream");
            }
        };

        let pipeline = match video_pipeline::EmulatorVideoPipeline::start_appsrc(app_cfg.clone()) {
            Ok(p) => p,
            Err(e) => {
                emulator_input::unregister_session_sync(&session_id);
                return Err(e).context("failed to start emulator gRPC video pipeline");
            }
        };

        let appsrc = pipeline
            .appsrc_clone()
            .context("gRPC pipeline missing appsrc")?;

        let log_dc_for_grpc = log_dc.clone();
        let session_id_for_grpc = session_id.clone();
        let expected_w = app_cfg.width;
        let expected_h = app_cfg.height;
        let expected_format = app_cfg.format.clone();
        grpc_frame_task = Some(tokio::spawn(async move {
            let mut frames: u64 = 0;
            let mut dropped: u64 = 0;
            let mut last_log = Instant::now();
            let mut last_frame_at = Instant::now();
            let mut mismatch_logged = false;
            let mut last_frame_size: Option<(u32, u32)> = None;
            let mut interval = tokio::time::interval(Duration::from_secs(5));

            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        if frames == 0 {
                            send_log(
                                &log_dc_for_grpc,
                                &session_id_for_grpc,
                                "[grpc] no frames received yet (display may be inactive or stream stalled)",
                                "emulator",
                            )
                            .await;
                        } else if last_frame_at.elapsed() >= Duration::from_secs(5) {
                            send_log(
                                &log_dc_for_grpc,
                                &session_id_for_grpc,
                                &format!(
                                    "[grpc] stream stalled: last_frame_age_ms={}",
                                    last_frame_at.elapsed().as_millis()
                                ),
                                "emulator",
                            )
                            .await;
                        }
                    }
                    maybe = frame_rx.recv() => {
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

                let mut buffer = gst::Buffer::from_slice(frame.data);
                if let Some(pts) = frame.timestamp_ns {
                    if let Some(buf) = buffer.get_mut() {
                        buf.set_pts(gst::ClockTime::from_nseconds(pts));
                    }
                }

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
        if !session_display.trim().is_empty() {
            cfg.x11_display = session_display;
        } else if let Ok(d) = std::env::var("DISPLAY") {
            if !d.trim().is_empty() {
                cfg.x11_display = d;
            }
        }

        // XID capture can cause X_GetImage BadMatch with some GPU modes due to incompatible X11 visuals.
        // Default to root capture which is safer. XID capture can be enabled via SYNTHI_ANDROID_CAPTURE_XID=true.
        let capture_xid = std::env::var("SYNTHI_ANDROID_CAPTURE_XID")
            .ok()
            .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);

        // Debug: try to locate the emulator window and report if it's likely off-screen.
        // This helps diagnose "stream ready but blank" when root capture is used.
        // Also capture geometry for region-based root capture.
        let mut emulator_geom: Option<(i32, i32, i32, i32)> = None;
        if !cfg!(target_os = "windows") {
            if let Some((xid, _w, _h)) = find_emulator_x11_window(&cfg.x11_display).await {
                if let Some((x, y, w, h)) = xdotool_window_geometry_xywh(&cfg.x11_display, xid).await {
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
                    } else {
                        send_log(
                            &log_dc,
                            &session_id,
                            &format!(
                                "[video] debug: display={} emulatorWindow xid={} geom x={} y={} w={} h={}",
                                cfg.x11_display, xid, x, y, w, h
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
                    &format!("[video] capturing emulator X11 window xid={}{} on DISPLAY={}", xid, extra, cfg.x11_display),
                    "emulator",
                )
                .await;
            } else {
                send_log(
                    &log_dc,
                    &session_id,
                    &format!(
                        "[video] no emulator X11 window found via xdotool; capturing X11 root on DISPLAY={} (may look black if emulator is off-screen)",
                        cfg.x11_display
                    ),
                    "emulator",
                )
                .await;
            }
        } else {
            // Use root capture with region crop to just the emulator window area
            if let Some((x, y, w, h)) = emulator_geom {
                let left_pad = std::env::var("SYNTHI_ANDROID_LEFT_PAD_PX")
                    .ok()
                    .and_then(|v| v.parse::<i32>().ok())
                    .unwrap_or(24);
                cfg.startx = Some((x - left_pad).max(0));
                cfg.starty = Some(y.max(0));
                cfg.endx = Some(x + w);
                cfg.endy = Some(y + h);
                
                // Crop the SDK toolbar/right padding.
                // Override via SYNTHI_ANDROID_TOOLBAR_WIDTH, else infer from device size vs window width.
                let mut toolbar_width = std::env::var("SYNTHI_ANDROID_TOOLBAR_WIDTH")
                    .ok()
                    .and_then(|v| v.parse::<u32>().ok())
                    .map(|v| v as i32)
                    .unwrap_or(72); // Default toolbar width (generous to ensure full crop)
                if std::env::var("SYNTHI_ANDROID_TOOLBAR_WIDTH").is_err() {
                    if let Ok((device_w, device_h)) =
                        emulator_input::query_device_size(&adb_path, &emulator_serial).await
                    {
                        if device_w > 0 && device_h > 0 && h > 0 {
                            let scale = (h as f64) / (device_h as f64);
                            let expected_w = (device_w as f64) * scale;
                            let extra = (w as f64 - expected_w).round() as i32;
                            if extra > 0 {
                                let pad = std::env::var("SYNTHI_ANDROID_TOOLBAR_PAD_PX")
                                    .ok()
                                    .and_then(|v| v.parse::<u32>().ok())
                                    .unwrap_or(120) as i32;
                                toolbar_width = extra + pad; // extra padding to fully remove toolbar gutter
                            }
                        }
                    }
                }
                cfg.crop_right = toolbar_width.max(0) as u32;
                
                // Use the capture region size MINUS the crop as output size (don't distort aspect ratio)
                // The actual video will be (w - toolbar_width) x h after cropping
                cfg.width = (w - toolbar_width).max(100) as u32;
                cfg.height = h as u32;
                
                send_log(
                    &log_dc,
                    &session_id,
                        &format!(
                            "[video] capturing X11 root region x={}..{} y={}..{} ({}x{}), left_pad={}, crop_right={}, output={}x{} on DISPLAY={}",
                            cfg.startx.unwrap(), cfg.endx.unwrap(), cfg.starty.unwrap(), cfg.endy.unwrap(),
                            w, h, left_pad, cfg.crop_right, cfg.width, cfg.height, cfg.x11_display
                        ),
                    "emulator",
                )
                .await;
            } else {
                send_log(
                    &log_dc,
                    &session_id,
                    &format!("[video] capturing X11 root on DISPLAY={} (no emulator window found, may be black)", cfg.x11_display),
                    "emulator",
                )
                .await;
            }
        }

        // Note: When using region capture, we use the region size directly to avoid distortion.
        // The device resolution query is only used when we have no better size info.
        if cfg.startx.is_none() {
            // Only override dimensions if not using region capture
            if let Ok((w, h)) = emulator_input::query_device_size(&adb_path, &emulator_serial).await {
                if w > 0 && h > 0 {
                    cfg.width = w;
                    cfg.height = h;
                }
            }
        }

        send_log(
            &log_dc,
            &session_id,
            &format!(
                "[video] starting GStreamer pipeline: {}",
                video_pipeline::EmulatorVideoPipeline::debug_pipeline_string(&cfg)
            ),
            "emulator",
        )
        .await;

        let pipeline = match video_pipeline::EmulatorVideoPipeline::start(cfg.clone()) {
            Ok(p) => p,
            Err(e) => {
                // If capturing a specific window fails (common under Xvfb / WMs), retry root capture.
                if cfg.x11_xid.is_some() {
                    send_log(
                        &log_dc,
                        &session_id,
                        &format!(
                            "[video] capture via xid failed; retrying root capture on DISPLAY={}: {:#}",
                            cfg.x11_display, e
                        ),
                        "emulator",
                    )
                    .await;

                    cfg.x11_xid = None;
                    send_log(
                        &log_dc,
                        &session_id,
                        &format!(
                            "[video] starting GStreamer pipeline (root capture): {}",
                            video_pipeline::EmulatorVideoPipeline::debug_pipeline_string(&cfg)
                        ),
                        "emulator",
                    )
                    .await;

                    match video_pipeline::EmulatorVideoPipeline::start(cfg.clone()) {
                        Ok(p) => p,
                        Err(e2) => {
                            emulator_input::unregister_session_sync(&session_id);
                            return Err(e2).context("failed to start emulator video pipeline (root capture retry)");
                        }
                    }
                } else {
                    emulator_input::unregister_session_sync(&session_id);
                    return Err(e).context("failed to start emulator video pipeline");
                }
            }
        };

        (pipeline, cfg.x11_display.clone())
    };

    // Attach to existing video transceiver.
    let transceivers = pc.get_transceivers().await;
    let mut video_transceiver_found = false;
    for t in transceivers {
        if t.kind() == RTPCodecType::Video {
            video_transceiver_found = true;
            let sender = t.sender().await;
            eprintln!("[mobile-job] Attaching video track to transceiver...");
            match sender
                .replace_track(Some(Arc::clone(&pipeline.track) as Arc<dyn TrackLocal + Send + Sync>))
                .await
            {
                Ok(_) => {
                    eprintln!("[mobile-job] Video track attached successfully");
                    send_log(
                        &log_dc,
                        &session_id,
                        "[video] Track attached to WebRTC sender successfully",
                        "emulator",
                    )
                    .await;
                }
                Err(e) => {
                    eprintln!("[mobile-job] ERROR: Failed to attach video track: {:?}", e);
                    send_log(
                        &log_dc,
                        &session_id,
                        &format!("[video] ERROR: Failed to attach track to sender: {:?}", e),
                        "emulator",
                    )
                    .await;
                }
            }
        }
    }
    if !video_transceiver_found {
        eprintln!("[mobile-job] WARNING: No video transceiver found! Browser may not have requested video.");
        send_log(
            &log_dc,
            &session_id,
            "[video] WARNING: No video transceiver found in peer connection!",
            "emulator",
        )
        .await;
    }

    send_status(
        &log_dc,
        &session_id,
        "ready",
        "Emulator stream ready",
        Some(json!({
            "success": true,
            "package_name": package_name,
            "emulator_serial": emulator_serial,
            "display": display_label,
            "logcat": logcat_started,
            "video_transceiver_attached": video_transceiver_found,
        })),
    )
    .await;

    // Keep the job alive while the user interacts with the emulator in the web panel.
    let stream_secs: u64 = std::env::var("SYNTHI_ANDROID_STREAM_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(15 * 60);
    let stream_until = Instant::now() + Duration::from_secs(stream_secs);

    let mut last_rtp_log = Instant::now();
    let mut last_rtp_count: u64 = 0;
    loop {
        // Check if the session was cancelled by the user
        if is_session_cancelled(&session_id) {
            eprintln!("[mobile-job] Session {} cancelled by user, stopping...", session_id);
            send_log(&log_dc, &session_id, "[video] Session cancelled by user", "emulator").await;
            break;
        }
        
        if Instant::now() >= stream_until {
            break;
        }
        if log_dc.ready_state() != RTCDataChannelState::Open {
            break;
        }
        match pc.connection_state() {
            RTCPeerConnectionState::Connected | RTCPeerConnectionState::Connecting => {}
            _ => break,
        }
        
        // Periodically log RTP packet count to help diagnose video streaming issues
        if last_rtp_log.elapsed() >= Duration::from_secs(5) {
            let rtp_count = pipeline.get_rtp_packet_count();
            let appsink_count = pipeline.get_appsink_sample_count();
            let gst_state = pipeline.get_pipeline_state();
            let errors = pipeline.drain_errors();
            let packets_per_sec = (rtp_count - last_rtp_count) / 5;
            
            let mut msg = format!(
                "[video-rtp] worker stats: rtp={} appsink={} pps={} gst={} pc={:?}",
                rtp_count, appsink_count, packets_per_sec, gst_state, pc.connection_state()
            );
            if !errors.is_empty() {
                msg.push_str(&format!(" errors=[{}]", errors.join(", ")));
            }
            
            send_log(&log_dc, &session_id, &msg, "emulator").await;
            last_rtp_count = rtp_count;
            last_rtp_log = Instant::now();
        }
        
        sleep(Duration::from_millis(250)).await;
    }

    // Check if we exited due to cancellation
    let was_cancelled = is_session_cancelled(&session_id);

    // Cleanup: stop streaming + unregister input.
    logcat_task.abort();
    if let Some(task) = grpc_frame_task {
        task.abort();
    }
    let _ = daemon.session_mut().stop_logcat().await;
    daemon.release_keepalive().await;
    emulator_input::unregister_session_sync(&session_id);
    // Clear the cancelled flag for this session
    clear_cancelled_session(&session_id);
    pipeline.stop();

    if was_cancelled {
        send_status(
            &log_dc,
            &session_id,
            "cancelled",
            "Emulator session cancelled by user",
            Some(json!({
                "success": true,
                "cancelled": true,
                "package_name": package_name,
                "emulator_serial": emulator_serial,
            })),
        )
        .await;
    } else {
        send_status(
            &log_dc,
            &session_id,
            "done",
            "Emulator session ended",
            Some(json!({
                "success": true,
                "package_name": package_name,
                "emulator_serial": emulator_serial,
            })),
        )
        .await;
    }

    Ok(())
}
