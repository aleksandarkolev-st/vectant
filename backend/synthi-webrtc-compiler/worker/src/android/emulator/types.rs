use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Child;
use tokio::sync::{oneshot, Mutex};

// ============================================================
// CONSTANTS
// ============================================================

/// Default emulator boot timeout.
///
/// NOTE: Cold boots for modern system images (especially without hardware accel)
/// can exceed 10 minutes. Keep this conservative to reduce flaky CI.
pub(crate) const EMULATOR_BOOT_TIMEOUT_SECS: u64 = 1200;

/// Maximum time to wait for adb to connect.
///
/// Note: Cold boot on software rendering can be slow to initialize USB/ADB.
/// Increased from 30s -> 180s to prevent premature timeouts.
pub(crate) const ADB_CONNECT_TIMEOUT_SECS: u64 = 180;

/// Maximum time for APK installation (120 seconds)
pub(crate) const APK_INSTALL_TIMEOUT_SECS: u64 = 120;

/// Maximum time for app launch (30 seconds)
pub(crate) const APP_LAUNCH_TIMEOUT_SECS: u64 = 30;

/// Interval for boot status polling (2 seconds)
pub(crate) const BOOT_POLL_INTERVAL_MS: u64 = 2000;

/// Maximum total session time (30 minutes)
pub(crate) const MAX_SESSION_DURATION_SECS: u64 = 1800;

/// Default AVD name for cloud workers
pub(crate) const DEFAULT_AVD_NAME: &str = "synthi_cloud_avd";

/// Default system image for x86_64 (no Play Store, smaller)
pub(crate) const DEFAULT_SYSTEM_IMAGE: &str = "system-images;android-34;google_apis;x86_64";

pub(crate) fn parse_installed_system_images(stdout: &str) -> Vec<String> {
    // `sdkmanager --list_installed` output varies across versions.
    // We best-effort extract the first whitespace token from lines containing `system-images;`.
    let mut out = vec![];
    for line in stdout.lines() {
        if !line.contains("system-images;") {
            continue;
        }
        let trimmed = line.trim();
        if let Some(pkg) = trimmed.split_whitespace().next() {
            if pkg.starts_with("system-images;") {
                out.push(pkg.to_string());
            }
        }
    }
    out
}

fn system_image_api_level(pkg: &str) -> Option<u32> {
    // Example: system-images;android-34;google_apis;x86_64
    // Extract 34.
    let parts: Vec<&str> = pkg.split(';').collect();
    if parts.len() < 4 {
        return None;
    }
    let android_part = parts.get(1)?.trim();
    let ver = android_part.strip_prefix("android-")?;
    ver.parse::<u32>().ok()
}

pub(crate) fn rank_system_image(pkg: &str) -> (u32, u32) {
    // Higher is better.
    // Primary: API level.
    // Secondary: flavor preference.
    let api = system_image_api_level(pkg).unwrap_or(0);
    let flavor = if pkg.contains("google_apis") {
        3
    } else if pkg.contains("playstore") {
        2
    } else if pkg.contains("default") {
        1
    } else {
        0
    };
    (api, flavor)
}

// ============================================================
// EMULATOR CONFIGURATION
// ============================================================

/// Configuration for emulator instance
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmulatorConfig {
    /// AVD name to use
    pub avd_name: String,

    /// System image (e.g., "system-images;android-34;google_apis;x86_64")
    pub system_image: String,

    /// RAM allocation in MB (default: 2048)
    pub ram_mb: u32,

    /// Number of CPU cores (default: 2)
    pub cores: u32,

    /// Boot timeout in seconds
    pub boot_timeout_secs: u64,

    /// Maximum session duration in seconds
    pub max_session_secs: u64,

    /// Whether to use hardware acceleration (KVM on Linux)
    /// Set to false for cloud environments without KVM
    pub use_hw_accel: bool,

    /// Additional emulator arguments
    pub extra_args: Vec<String>,

    /// Android SDK root path
    pub android_sdk_root: PathBuf,

    /// Native LCD width (default: 540)
    pub native_width: u32,

    /// Native LCD height (default: 960)
    pub native_height: u32,

    /// Native LCD density (default: 240)
    pub native_density: u32,
}

impl Default for EmulatorConfig {
    fn default() -> Self {
        // Default to 540x1170 (19.5:9 aspect ratio) to match modern device frames
        let (w, h, d) = if std::env::var("SYNTHI_ANDROID_720P").is_ok() {
            (720, 1560, 320) // 720p 19.5:9
        } else {
            (540, 1170, 240) // 540p 19.5:9
        };

        Self {
            avd_name: DEFAULT_AVD_NAME.to_string(),
            system_image: DEFAULT_SYSTEM_IMAGE.to_string(),
            ram_mb: 2048,
            cores: 2,
            boot_timeout_secs: EMULATOR_BOOT_TIMEOUT_SECS,
            max_session_secs: MAX_SESSION_DURATION_SECS,
            use_hw_accel: false, // Default to software rendering for cloud
            extra_args: vec![],
            android_sdk_root: PathBuf::from("/opt/android-sdk"),
            // Step 1: Default to 540x960 @ 240 dpi for native low-res rendering
            native_width: w,
            native_height: h,
            native_density: d,
        }
    }
}

// ============================================================
// EMULATOR STATE
// ============================================================

/// Current state of the emulator
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EmulatorState {
    /// Not started
    Stopped,
    /// Starting up
    Booting,
    /// Fully booted and ready
    Ready,
    /// Running an app
    Running,
    /// Shutting down
    ShuttingDown,
    /// Failed to start or crashed
    Failed,
}

/// Emulator boot result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmulatorBootResult {
    pub success: bool,
    pub state: EmulatorState,
    pub boot_time_ms: u64,
    pub serial: Option<String>,
    pub error: Option<String>,
}

/// App installation result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInstallResult {
    pub success: bool,
    pub install_time_ms: u64,
    pub package_name: Option<String>,
    pub error: Option<String>,
}

/// App launch result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppLaunchResult {
    pub success: bool,
    pub launch_time_ms: u64,
    pub activity: Option<String>,
    pub error: Option<String>,
}

/// Logcat entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogcatEntry {
    pub timestamp: String,
    pub pid: Option<u32>,
    pub tid: Option<u32>,
    pub level: LogLevel,
    pub tag: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LogLevel {
    Verbose,
    Debug,
    Info,
    Warning,
    Error,
    Fatal,
    Silent,
}

impl LogLevel {
    pub(crate) fn from_char(c: char) -> Self {
        match c {
            'V' => LogLevel::Verbose,
            'D' => LogLevel::Debug,
            'I' => LogLevel::Info,
            'W' => LogLevel::Warning,
            'E' => LogLevel::Error,
            'F' => LogLevel::Fatal,
            'S' => LogLevel::Silent,
            _ => LogLevel::Info,
        }
    }
}

// ============================================================
// SESSION CORE STATE (shared fields)
// ============================================================

pub(crate) struct SessionCore {
    pub config: EmulatorConfig,
    pub state: Arc<Mutex<EmulatorState>>,
    pub emulator_process: Arc<Mutex<Option<Child>>>,
    pub xvfb_process: Arc<Mutex<Option<Child>>>,
    pub x11_display: Arc<Mutex<String>>,
    pub serial: Arc<Mutex<Option<String>>>,
    pub shutdown_tx: Option<oneshot::Sender<()>>,
    pub logcat_process: Arc<Mutex<Option<Child>>>,
    pub started_at: Option<std::time::Instant>,
    pub max_session: Duration,
}
