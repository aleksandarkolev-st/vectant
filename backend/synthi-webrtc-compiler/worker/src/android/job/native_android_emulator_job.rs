// ============================================================
// NATIVE ANDROID EMULATOR JOB HANDLER
// ============================================================
// Orchestrates the complete native Android (Java/Kotlin) build
// and emulator execution flow. Integrates with the WebRTC streaming
// pipeline for live preview.
// ============================================================

use anyhow::{bail, Context, Result};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::time::sleep;
use webrtc::data_channel::RTCDataChannel;

use crate::android::emulator::{
    acquire_emulator_daemon, detect_kvm, EmulatorConfig, EnsureReadyResult,
};
use crate::android::native_android::{
    build_native_android_apk, detect_native_android_project, BuildConfig, BuildVariant,
};
use crate::android::shared::{
    adb_install_apk, adb_launch_activity,
};
use crate::android::webrtc::{send_log, send_mobile_capabilities, send_status};
use crate::android::webrtc::input::{is_session_cancelled, clear_cancelled_session};

use webrtc::peer_connection::RTCPeerConnection;

// ============================================================
// JOB CONFIGURATION
// ============================================================

/// Configuration for a native Android emulator job
#[derive(Debug, Clone)]
pub struct NativeAndroidJobConfig {
    /// Unique session ID
    pub session_id: String,

    /// Workspace ID
    pub workspace_id: String,

    /// Path to the project root
    pub project_root: PathBuf,

    /// Build variant (debug/release)
    pub build_variant: BuildVariant,

    /// Optional product flavor
    pub flavor: Option<String>,

    /// Whether to clean before building
    pub clean_build: bool,

    /// Extra Gradle arguments
    pub extra_gradle_args: Vec<String>,

    /// Emulator configuration
    pub emulator_config: EmulatorConfig,

    /// Whether to enable logcat streaming
    pub enable_logcat: bool,

    /// Logcat filter (e.g., "*:W" for warnings+)
    pub logcat_filter: Option<String>,

    /// Maximum session duration in seconds
    pub max_session_secs: u64,
}

impl Default for NativeAndroidJobConfig {
    fn default() -> Self {
        Self {
            session_id: String::new(),
            workspace_id: String::new(),
            project_root: PathBuf::new(),
            build_variant: BuildVariant::Debug,
            flavor: None,
            clean_build: false,
            extra_gradle_args: Vec::new(),
            emulator_config: EmulatorConfig::default(),
            enable_logcat: true,
            logcat_filter: None,
            max_session_secs: 1800, // 30 minutes
        }
    }
}

/// Job execution state
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    Initializing,
    DetectingProject,
    BuildingApk,
    StartingEmulator,
    InstallingApk,
    LaunchingApp,
    Running,
    Cancelled,
    Failed,
    Completed,
}

// ============================================================
// JOB HANDLER
// ============================================================

/// Handles a native Android emulator job
pub async fn handle_native_android_emulator_job(
    config: NativeAndroidJobConfig,
    peer_connection: Arc<RTCPeerConnection>,
    data_channel: Arc<RTCDataChannel>,
) -> Result<()> {
    let session_id = config.session_id.clone();
    let start_time = Instant::now();

    // Clear any previous cancellation state
    clear_cancelled_session(&session_id);

    // Send initial status
    send_status(&data_channel, &session_id, "initializing", "Starting native Android job...", None).await;
    send_log(&data_channel, &session_id, &format!("Session ID: {}", session_id), "worker").await;
    send_log(&data_channel, &session_id, &format!("Project: {}", config.project_root.display()), "worker").await;

    // Run the job with error handling
    let result = run_native_android_job_inner(
        &config,
        &peer_connection,
        &data_channel,
        start_time,
    )
    .await;

    // Handle result
    match result {
        Ok(()) => {
            send_status(&data_channel, &session_id, "completed", "Job completed successfully", None).await;
            send_log(&data_channel, &session_id, "Native Android job completed", "worker").await;
        }
        Err(e) => {
            let error_msg = format!("Job failed: {}", e);
            send_status(&data_channel, &session_id, "failed", &error_msg, None).await;
            send_log(&data_channel, &session_id, &error_msg, "worker").await;
            return Err(e);
        }
    }

    Ok(())
}

async fn run_native_android_job_inner(
    config: &NativeAndroidJobConfig,
    peer_connection: &Arc<RTCPeerConnection>,
    data_channel: &Arc<RTCDataChannel>,
    start_time: Instant,
) -> Result<()> {
    let session_id = &config.session_id;

    // Check for cancellation
    macro_rules! check_cancelled {
        () => {
            if is_session_cancelled(session_id) {
                send_status(data_channel, session_id, "cancelled", "Job cancelled by user", None).await;
                return Ok(());
            }
        };
    }

    // ============================================================
    // PHASE 1: PROJECT DETECTION
    // ============================================================
    send_status(data_channel, session_id, "detecting", "Detecting project structure...", None).await;

    let project_info = detect_native_android_project(&config.project_root)
        .await
        .context("Failed to detect project")?;

    if !project_info.is_native_android_project {
        bail!(
            "Not a valid native Android project. Expected Gradle project with AndroidManifest.xml"
        );
    }

    send_log(
        data_channel,
        session_id,
        &format!("Project type: {:?}", project_info.project_type),
        "worker",
    )
    .await;

    if let Some(ref app_id) = project_info.application_id {
        send_log(data_channel, session_id, &format!("Application ID: {}", app_id), "worker").await;
    }

    // Send project capabilities
    send_mobile_capabilities(data_channel, session_id).await;

    // Send project info as data payload
    let project_data = json!({
        "projectType": format!("{:?}", project_info.project_type),
        "applicationId": project_info.application_id,
        "minSdk": project_info.min_sdk_version,
        "targetSdk": project_info.target_sdk_version,
        "kotlinVersion": project_info.kotlin_version,
        "usesCompose": project_info.uses_compose,
    });
    send_status(data_channel, session_id, "project_detected", "Project structure detected", Some(project_data)).await;

    check_cancelled!();

    // ============================================================
    // PHASE 2: BUILD APK
    // ============================================================
    send_status(data_channel, session_id, "building", "Building APK...", None).await;

    let build_config = BuildConfig {
        project_root: config.project_root.clone(),
        variant: config.build_variant,
        flavor: config.flavor.clone(),
        extra_gradle_args: config.extra_gradle_args.clone(),
        env: HashMap::new(),
        clean_before_build: config.clean_build,
        timeout_secs: None,
    };

    // Create log callback for build output
    let dc_clone = Arc::clone(data_channel);
    let session_id_clone = session_id.to_string();
    let log_callback = Box::new(move |msg: String| {
        let dc = Arc::clone(&dc_clone);
        let sid = session_id_clone.clone();
        tokio::spawn(async move {
            send_log(&dc, &sid, &msg, "gradle").await;
        });
    });

    let build_result = build_native_android_apk(&build_config, Some(log_callback))
        .await
        .context("Build failed")?;

    // Send diagnostics
    for diag in &build_result.diagnostics {
        let diag_json = json!({
            "type": "diagnostic",
            "severity": diag.severity,
            "message": diag.message,
            "file": diag.file,
            "line": diag.line,
            "column": diag.column,
            "code": diag.code,
        });
        let _ = data_channel
            .send_text(serde_json::to_string(&diag_json).unwrap_or_default())
            .await;
    }

    if !build_result.success {
        bail!(
            "Build failed with {} errors",
            build_result.diagnostics.iter().filter(|d| d.severity == "error").count()
        );
    }

    let apk_path = build_result
        .apk_path
        .context("Build succeeded but no APK found")?;

    send_log(data_channel, session_id, &format!("APK built: {}", apk_path.display()), "gradle").await;
    send_log(
        data_channel,
        session_id,
        &format!("Build time: {}ms", build_result.build_duration_ms),
        "gradle",
    )
    .await;

    check_cancelled!();

    // ============================================================
    // PHASE 3: START EMULATOR
    // ============================================================
    send_status(data_channel, session_id, "starting_emulator", "Starting Android emulator...", None).await;

    // Check KVM availability (sync function)
    let kvm_status = detect_kvm();
    send_log(data_channel, session_id, &format!("KVM status: {:?}", kvm_status), "worker").await;

    // Acquire emulator - returns (MutexGuard, EnsureReadyResult) tuple
    let (_daemon_guard, ready_result) = acquire_emulator_daemon(config.emulator_config.clone())
        .await
        .context("Failed to acquire emulator")?;

    // EnsureReadyResult is a struct with { serial, boot_time_ms, reused }
    let serial = ready_result.serial.clone();

    if ready_result.reused {
        send_log(
            data_channel,
            session_id,
            &format!("Reusing existing emulator: {}", serial),
            "worker",
        )
        .await;
    } else {
        send_log(
            data_channel,
            session_id,
            &format!("Emulator booted: {} ({}ms)", serial, ready_result.boot_time_ms),
            "worker",
        )
        .await;
    }

    let adb_path = config
        .emulator_config
        .android_sdk_root
        .join("platform-tools/adb");

    check_cancelled!();

    // ============================================================
    // PHASE 4: INSTALL APK
    // ============================================================
    send_status(data_channel, session_id, "installing", "Installing APK on emulator...", None).await;

    let install_result = adb_install_apk(&adb_path, &serial, &apk_path, true, true)
        .await
        .context("Failed to install APK")?;

    if !install_result.success {
        bail!(
            "APK installation failed: {}",
            install_result.error.unwrap_or_default()
        );
    }

    send_log(
        data_channel,
        session_id,
        &format!("APK installed in {}ms", install_result.install_time_ms),
        "adb",
    )
    .await;

    let package_name = install_result
        .package_name
        .or(build_result.application_id.clone())
        .or(project_info.application_id.clone())
        .context("Could not determine package name")?;

    check_cancelled!();

    // ============================================================
    // PHASE 5: LAUNCH APP
    // ============================================================
    send_status(data_channel, session_id, "launching", "Launching application...", None).await;

    // Determine activity to launch
    let activity = build_result
        .launcher_component
        .as_ref()
        .map(|c| {
            // Extract activity part from component
            c.split('/').last().unwrap_or(".MainActivity")
        })
        .map(|s| s.to_string());

    let launch_result = adb_launch_activity(&adb_path, &serial, &package_name, activity.as_deref())
        .await
        .context("Failed to launch app")?;

    if !launch_result.success {
        bail!(
            "App launch failed: {}",
            launch_result.error.unwrap_or_default()
        );
    }

    send_log(
        data_channel,
        session_id,
        &format!(
            "App launched: {} (activity: {})",
            package_name,
            launch_result.activity.as_deref().unwrap_or("unknown")
        ),
        "adb",
    )
    .await;

    check_cancelled!();

    // ============================================================
    // PHASE 6: LOGCAT STREAMING
    // ============================================================
    if config.enable_logcat {
        send_status(data_channel, session_id, "streaming", "Starting logcat stream...", None).await;

        // TODO: Integrate with EmulatorSession logcat streaming via daemon
        // For now, logcat streaming is handled by the daemon managing the session
        send_log(data_channel, session_id, "Logcat streaming enabled", "worker").await;
    }

    // ============================================================
    // PHASE 7: RUNNING STATE
    // ============================================================
    send_status(data_channel, session_id, "running", "Application running", None).await;

    let session_start = Instant::now();
    let max_duration = Duration::from_secs(config.max_session_secs);

    // Keep the session alive until cancelled or timeout
    loop {
        if is_session_cancelled(session_id) {
            send_log(data_channel, session_id, "Session cancelled by user", "worker").await;
            break;
        }

        if session_start.elapsed() > max_duration {
            send_log(data_channel, session_id, "Session timed out", "worker").await;
            break;
        }

        // Check if peer connection is still alive
        let state = peer_connection.connection_state();
        if state == webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState::Failed
            || state == webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState::Closed
        {
            send_log(data_channel, session_id, "Peer connection closed", "worker").await;
            break;
        }

        sleep(Duration::from_millis(500)).await;
    }

    // ============================================================
    // CLEANUP
    // ============================================================
    send_status(data_channel, session_id, "stopping", "Stopping emulator session...", None).await;

    // Clean up session cancellation state
    clear_cancelled_session(session_id);

    send_log(
        data_channel,
        session_id,
        &format!(
            "Total session time: {}s",
            start_time.elapsed().as_secs()
        ),
        "worker",
    )
    .await;

    Ok(())
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/// Creates a job configuration from JSON parameters
pub fn parse_job_config(
    session_id: &str,
    workspace_id: &str,
    project_root: &str,
    params: &serde_json::Value,
    emulator_config: EmulatorConfig,
) -> Result<NativeAndroidJobConfig> {
    let variant = params
        .get("variant")
        .and_then(|v| v.as_str())
        .map(|s| match s.to_lowercase().as_str() {
            "release" => BuildVariant::Release,
            _ => BuildVariant::Debug,
        })
        .unwrap_or(BuildVariant::Debug);

    let flavor = params
        .get("flavor")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let clean_build = params
        .get("clean")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let extra_gradle_args = params
        .get("gradleArgs")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();

    let enable_logcat = params
        .get("logcat")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let logcat_filter = params
        .get("logcatFilter")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let max_session_secs = params
        .get("maxSessionSecs")
        .and_then(|v| v.as_u64())
        .unwrap_or(1800);

    Ok(NativeAndroidJobConfig {
        session_id: session_id.to_string(),
        workspace_id: workspace_id.to_string(),
        project_root: PathBuf::from(project_root),
        build_variant: variant,
        flavor,
        clean_build,
        extra_gradle_args,
        emulator_config,
        enable_logcat,
        logcat_filter,
        max_session_secs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_job_config() {
        let params = json!({
            "variant": "debug",
            "clean": true,
            "logcat": true,
            "gradleArgs": ["--info"]
        });

        let config = parse_job_config(
            "session-123",
            "workspace-456",
            "/path/to/project",
            &params,
            EmulatorConfig::default(),
        )
        .unwrap();

        assert_eq!(config.session_id, "session-123");
        assert_eq!(config.build_variant, BuildVariant::Debug);
        assert!(config.clean_build);
        assert!(config.enable_logcat);
        assert_eq!(config.extra_gradle_args, vec!["--info"]);
    }

    #[test]
    fn test_job_state_enum() {
        assert_ne!(JobState::Initializing, JobState::Running);
        assert_eq!(JobState::Failed, JobState::Failed);
    }
}
