// ============================================================
// ANDROID EMULATOR MODULE
// ============================================================
// Manages Android emulator lifecycle for cloud-based Flutter
// development. Supports headless execution without KVM where
// possible, with deterministic boot and graceful shutdown.
//
// KEY FEATURES:
// - Headless AVD execution (no GUI)
// - Boot detection via adb wait-for-device + getprop
// - APK installation and app launch
// - Logcat streaming with filters
// - Process cleanup and zombie prevention
// - Hard timeout enforcement
// ============================================================

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;

// ============================================================
// CONSTANTS
// ============================================================

/// Default emulator boot timeout (180 seconds)
const EMULATOR_BOOT_TIMEOUT_SECS: u64 = 180;

/// Maximum time to wait for adb to connect (30 seconds)
const ADB_CONNECT_TIMEOUT_SECS: u64 = 30;

/// Maximum time for APK installation (120 seconds)
const APK_INSTALL_TIMEOUT_SECS: u64 = 120;

/// Maximum time for app launch (30 seconds)
const APP_LAUNCH_TIMEOUT_SECS: u64 = 30;

/// Interval for boot status polling (2 seconds)
const BOOT_POLL_INTERVAL_MS: u64 = 2000;

/// Maximum total session time (30 minutes)
const MAX_SESSION_DURATION_SECS: u64 = 1800;

/// Default AVD name for cloud workers
const DEFAULT_AVD_NAME: &str = "synthi_cloud_avd";

/// Default system image for x86_64 (no Play Store, smaller)
const DEFAULT_SYSTEM_IMAGE: &str = "system-images;android-34;google_apis;x86_64";

fn parse_installed_system_images(stdout: &str) -> Vec<String> {
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

fn rank_system_image(pkg: &str) -> (u32, u32) {
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
}

impl Default for EmulatorConfig {
    fn default() -> Self {
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
    fn from_char(c: char) -> Self {
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
// EMULATOR SESSION
// ============================================================

/// Manages a single emulator session
pub struct EmulatorSession {
    config: EmulatorConfig,
    state: Arc<Mutex<EmulatorState>>,
    emulator_process: Arc<Mutex<Option<Child>>>,
    serial: Arc<Mutex<Option<String>>>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    logcat_process: Arc<Mutex<Option<Child>>>,
    started_at: Option<Instant>,
}

impl EmulatorSession {
    /// Creates a new emulator session with the given configuration
    pub fn new(config: EmulatorConfig) -> Self {
        Self {
            config,
            state: Arc::new(Mutex::new(EmulatorState::Stopped)),
            emulator_process: Arc::new(Mutex::new(None)),
            serial: Arc::new(Mutex::new(None)),
            shutdown_tx: None,
            logcat_process: Arc::new(Mutex::new(None)),
            started_at: None,
        }
    }

    /// Creates a session with default configuration
    pub fn with_defaults() -> Self {
        Self::new(EmulatorConfig::default())
    }

    /// Returns current emulator state
    pub async fn state(&self) -> EmulatorState {
        *self.state.lock().await
    }

    /// Returns the emulator serial (e.g., "emulator-5554")
    pub async fn serial(&self) -> Option<String> {
        self.serial.lock().await.clone()
    }

    // ============================================================
    // AVD MANAGEMENT
    // ============================================================

    /// Ensures the AVD exists, creating it if necessary
    pub async fn ensure_avd(&self) -> Result<()> {
        let avdmanager = self
            .config
            .android_sdk_root
            .join("cmdline-tools/latest/bin/avdmanager");

        // Check if AVD exists
        let output = Command::new(&avdmanager)
            .args(["list", "avd", "-c"])
            .output()
            .await
            .context("Failed to list AVDs")?;

        let avd_list = String::from_utf8_lossy(&output.stdout);
        if avd_list.lines().any(|l| l.trim() == self.config.avd_name) {
            return Ok(()); // AVD already exists
        }

        // Create AVD.
        // avdmanager may prompt (e.g. "Do you wish to create a custom hardware profile?"),
        // so provide a default "no".
        let mut cmd = Command::new(&avdmanager);
        cmd.args([
            "create",
            "avd",
            "--name",
            &self.config.avd_name,
            "--package",
            &self.config.system_image,
            "--device",
            "pixel_4",
            "--force",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .context("Failed to spawn avdmanager create avd")?;
        if let Some(mut stdin) = child.stdin.take() {
            // "no" is the safe default.
            let _ = stdin.write_all(b"no\n").await;
        }
        let out = child
            .wait_with_output()
            .await
            .context("Failed to wait for avdmanager")?;
        if !out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            bail!(
                "avdmanager create avd failed (status={:?})\nstdout:\n{}\nstderr:\n{}",
                out.status.code(),
                stdout,
                stderr
            );
        }

        Ok(())
    }

    /// Downloads the required system image if not present
    pub async fn ensure_system_image(&mut self) -> Result<()> {
        let sdkmanager = self
            .config
            .android_sdk_root
            .join("cmdline-tools/latest/bin/sdkmanager");

        async fn list_installed(sdkmanager: &Path, sdk_root: &Path) -> Result<String> {
            let output = Command::new(sdkmanager)
                .arg(format!("--sdk_root={}", sdk_root.display()))
                .args(["--list_installed"])
                .output()
                .await
                .with_context(|| {
                    format!("Failed to run {} --list_installed", sdkmanager.display())
                })?;
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }

        async fn accept_licenses_best_effort(sdkmanager: &Path, sdk_root: &Path) {
            let mut cmd = Command::new(sdkmanager);
            cmd.arg(format!("--sdk_root={}", sdk_root.display()))
                .arg("--licenses")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if let Ok(mut child) = cmd.spawn() {
                if let Some(mut stdin) = child.stdin.take() {
                    // Some license prompts require multiple confirmations.
                    let _ = stdin.write_all(b"y\n").await;
                    let _ = stdin.write_all(b"y\n").await;
                    let _ = stdin.write_all(b"y\n").await;
                    let _ = stdin.write_all(b"y\n").await;
                    let _ = stdin.flush().await;
                }
                let _ = child.wait().await;
            }
        }

        async fn install_package(sdkmanager: &Path, sdk_root: &Path, pkg: &str) -> Result<()> {
            // Try to accept licenses first; ignore failures.
            accept_licenses_best_effort(sdkmanager, sdk_root).await;

            let mut cmd = Command::new(sdkmanager);
            cmd.arg(format!("--sdk_root={}", sdk_root.display()))
                .arg(pkg)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = cmd
                .spawn()
                .with_context(|| format!("Failed to spawn sdkmanager to install {}", pkg))?;
            if let Some(mut stdin) = child.stdin.take() {
                // Accept licenses / prompts.
                let _ = stdin.write_all(b"y\n").await;
                let _ = stdin.write_all(b"y\n").await;
                let _ = stdin.write_all(b"y\n").await;
                let _ = stdin.write_all(b"y\n").await;
                let _ = stdin.flush().await;
            }

            let out = child
                .wait_with_output()
                .await
                .with_context(|| format!("Failed to wait for sdkmanager installing {}", pkg))?;

            if !out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);
                bail!(
                    "sdkmanager install failed for: {} (status={:?})\nstdout:\n{}\nstderr:\n{}",
                    pkg,
                    out.status.code(),
                    stdout,
                    stderr
                );
            }

            Ok(())
        }

        let sdk_root = self.config.android_sdk_root.clone();
        let installed_text = list_installed(&sdkmanager, &sdk_root).await?;
        let installed_images = parse_installed_system_images(&installed_text);

        // If the requested image already exists, we're done.
        if installed_images
            .iter()
            .any(|p| p == &self.config.system_image)
        {
            return Ok(());
        }

        // Try installing the requested image.
        let requested = self.config.system_image.clone();
        if install_package(&sdkmanager, &sdk_root, &requested)
            .await
            .is_ok()
        {
            return Ok(());
        }

        // If install failed, try fallbacks (prefer already-installed images first).
        if !installed_images.is_empty() {
            let mut sorted = installed_images;
            sorted.sort_by(|a, b| rank_system_image(b).cmp(&rank_system_image(a)));
            let chosen = sorted[0].clone();
            self.config.system_image = chosen;
            return Ok(());
        }

        // No installed system images; try a few commonly available candidates.
        let fallback_candidates = [
            // Same API, alternate ABI/flavor.
            "system-images;android-34;google_apis;x86",
            "system-images;android-34;default;x86_64",
            // Commonly available older API.
            "system-images;android-33;google_apis;x86_64",
            "system-images;android-33;default;x86_64",
            "system-images;android-32;google_apis;x86_64",
            "system-images;android-31;google_apis;x86_64",
        ];

        let mut last_err: Option<anyhow::Error> = None;
        for pkg in fallback_candidates {
            match install_package(&sdkmanager, &sdk_root, pkg).await {
                Ok(_) => {
                    self.config.system_image = pkg.to_string();
                    return Ok(());
                }
                Err(e) => last_err = Some(e),
            }
        }

        // Re-list for debugging context.
        let installed_after = list_installed(&sdkmanager, &sdk_root)
            .await
            .unwrap_or_default();
        let installed_images_after = parse_installed_system_images(&installed_after);

        if let Some(e) = last_err {
            bail!(
                "No usable Android system image could be installed. Last error: {:#}\nCurrently installed system images: {:?}",
                e,
                installed_images_after
            );
        }

        bail!(
            "No usable Android system image could be installed. Currently installed system images: {:?}",
            installed_images_after
        );
    }

    // ============================================================
    // EMULATOR LIFECYCLE
    // ============================================================

    /// Boots the emulator and waits for it to be ready
    pub async fn boot(&mut self) -> Result<EmulatorBootResult> {
        let start = Instant::now();

        // Update state
        *self.state.lock().await = EmulatorState::Booting;

        // Ensure AVD and system image exist
        self.ensure_system_image().await?;
        self.ensure_avd().await?;

        // Build emulator command
        let emulator_path = self.config.android_sdk_root.join("emulator/emulator");

        let mut cmd = Command::new(&emulator_path);
        cmd.args([
            "-avd",
            &self.config.avd_name,
            "-no-window",    // Headless
            "-no-audio",     // No audio
            "-no-boot-anim", // Skip boot animation
            "-gpu",
            "swiftshader_indirect", // Software rendering
            "-memory",
            &self.config.ram_mb.to_string(),
            "-cores",
            &self.config.cores.to_string(),
            "-read-only",        // Don't modify system image
            "-no-snapshot-save", // Don't save snapshots
            "-no-snapshot-load", // Don't load snapshots
        ]);

        // Add hardware acceleration if enabled
        if self.config.use_hw_accel {
            cmd.args(["-accel", "on"]);
        } else {
            cmd.args(["-accel", "off"]);
        }

        // Add extra args
        for arg in &self.config.extra_args {
            cmd.arg(arg);
        }

        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        // Start emulator process
        let child = cmd.spawn().context("Failed to spawn emulator")?;
        *self.emulator_process.lock().await = Some(child);
        self.started_at = Some(start);

        // Wait for emulator to boot
        match self.wait_for_boot().await {
            Ok(serial) => {
                *self.serial.lock().await = Some(serial.clone());
                *self.state.lock().await = EmulatorState::Ready;

                Ok(EmulatorBootResult {
                    success: true,
                    state: EmulatorState::Ready,
                    boot_time_ms: start.elapsed().as_millis() as u64,
                    serial: Some(serial),
                    error: None,
                })
            }
            Err(e) => {
                *self.state.lock().await = EmulatorState::Failed;
                self.kill_emulator().await;

                Ok(EmulatorBootResult {
                    success: false,
                    state: EmulatorState::Failed,
                    boot_time_ms: start.elapsed().as_millis() as u64,
                    serial: None,
                    error: Some(e.to_string()),
                })
            }
        }
    }

    /// Waits for the emulator to fully boot
    async fn wait_for_boot(&self) -> Result<String> {
        let adb = self.config.android_sdk_root.join("platform-tools/adb");
        let boot_timeout = Duration::from_secs(self.config.boot_timeout_secs);

        // Step 1: Wait for adb to see the device
        let connect_timeout = Duration::from_secs(ADB_CONNECT_TIMEOUT_SECS);
        let serial = timeout(connect_timeout, self.wait_for_adb_device(&adb))
            .await
            .context("Timeout waiting for adb device")?
            .context("Failed to detect emulator device")?;

        // Step 2: Wait for boot completion
        let remaining =
            boot_timeout.saturating_sub(self.started_at.map(|s| s.elapsed()).unwrap_or_default());

        timeout(remaining, self.wait_for_boot_complete(&adb, &serial))
            .await
            .context("Timeout waiting for boot completion")?
            .context("Failed to complete boot")?;

        Ok(serial)
    }

    /// Waits for adb to detect an emulator device
    async fn wait_for_adb_device(&self, adb: &Path) -> Result<String> {
        loop {
            let output = Command::new(adb).args(["devices", "-l"]).output().await?;

            let stdout = String::from_utf8_lossy(&output.stdout);

            // Look for emulator-XXXX in device list
            for line in stdout.lines() {
                if line.starts_with("emulator-") && line.contains("device") {
                    let serial = line.split_whitespace().next().unwrap_or("");
                    if !serial.is_empty() {
                        return Ok(serial.to_string());
                    }
                }
            }

            tokio::time::sleep(Duration::from_millis(BOOT_POLL_INTERVAL_MS)).await;
        }
    }

    /// Waits for Android to finish booting
    async fn wait_for_boot_complete(&self, adb: &Path, serial: &str) -> Result<()> {
        loop {
            // Check sys.boot_completed property
            let output = Command::new(adb)
                .args(["-s", serial, "shell", "getprop", "sys.boot_completed"])
                .output()
                .await?;

            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if value == "1" {
                // Also check dev.bootcomplete for older devices
                let output2 = Command::new(adb)
                    .args(["-s", serial, "shell", "getprop", "dev.bootcomplete"])
                    .output()
                    .await?;

                let value2 = String::from_utf8_lossy(&output2.stdout).trim().to_string();
                if value2 == "1" || value2.is_empty() {
                    // Boot complete!
                    return Ok(());
                }
            }

            tokio::time::sleep(Duration::from_millis(BOOT_POLL_INTERVAL_MS)).await;
        }
    }

    // ============================================================
    // APP INSTALLATION
    // ============================================================

    /// Installs an APK on the emulator
    pub async fn install_apk(&self, apk_path: &Path) -> Result<AppInstallResult> {
        let start = Instant::now();

        let state = self.state().await;
        if state != EmulatorState::Ready && state != EmulatorState::Running {
            return Ok(AppInstallResult {
                success: false,
                install_time_ms: 0,
                package_name: None,
                error: Some(format!("Emulator not ready (state: {:?})", state)),
            });
        }

        let serial = self
            .serial()
            .await
            .ok_or_else(|| anyhow::anyhow!("No emulator serial"))?;

        let adb = self.config.android_sdk_root.join("platform-tools/adb");

        // Install APK
        let output = timeout(
            Duration::from_secs(APK_INSTALL_TIMEOUT_SECS),
            Command::new(&adb)
                .args(["-s", &serial, "install", "-r", "-t"])
                .arg(apk_path)
                .output(),
        )
        .await
        .context("APK install timeout")?
        .context("Failed to run adb install")?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if !output.status.success() || stderr.contains("Failure") {
            return Ok(AppInstallResult {
                success: false,
                install_time_ms: start.elapsed().as_millis() as u64,
                package_name: None,
                error: Some(format!("Install failed: {}", stderr)),
            });
        }

        // Extract package name from APK
        let package_name = self.get_package_name(apk_path).await.ok();

        Ok(AppInstallResult {
            success: true,
            install_time_ms: start.elapsed().as_millis() as u64,
            package_name,
            error: None,
        })
    }

    /// Gets package name from APK using aapt2
    async fn get_package_name(&self, apk_path: &Path) -> Result<String> {
        let aapt2 = self
            .config
            .android_sdk_root
            .join("build-tools/34.0.0/aapt2");

        let output = Command::new(&aapt2)
            .args(["dump", "packagename"])
            .arg(apk_path)
            .output()
            .await
            .context("Failed to run aapt2")?;

        let package = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if package.is_empty() {
            bail!("Could not extract package name");
        }

        Ok(package)
    }

    // ============================================================
    // APP LAUNCH
    // ============================================================

    /// Launches the app's main activity
    pub async fn launch_app(&self, package_name: &str) -> Result<AppLaunchResult> {
        let start = Instant::now();

        let serial = self
            .serial()
            .await
            .ok_or_else(|| anyhow::anyhow!("No emulator serial"))?;

        let adb = self.config.android_sdk_root.join("platform-tools/adb");

        // Get main activity using pm dump
        let activity = self.get_main_activity(&adb, &serial, package_name).await?;

        // Launch activity
        let output = timeout(
            Duration::from_secs(APP_LAUNCH_TIMEOUT_SECS),
            Command::new(&adb)
                .args([
                    "-s",
                    &serial,
                    "shell",
                    "am",
                    "start",
                    "-n",
                    &format!("{}/{}", package_name, activity),
                    "-a",
                    "android.intent.action.MAIN",
                    "-c",
                    "android.intent.category.LAUNCHER",
                ])
                .output(),
        )
        .await
        .context("App launch timeout")?
        .context("Failed to run am start")?;

        let stderr = String::from_utf8_lossy(&output.stderr);

        if !output.status.success() || stderr.contains("Error") {
            return Ok(AppLaunchResult {
                success: false,
                launch_time_ms: start.elapsed().as_millis() as u64,
                activity: None,
                error: Some(format!("Launch failed: {}", stderr)),
            });
        }

        *self.state.lock().await = EmulatorState::Running;

        Ok(AppLaunchResult {
            success: true,
            launch_time_ms: start.elapsed().as_millis() as u64,
            activity: Some(format!("{}/{}", package_name, activity)),
            error: None,
        })
    }

    /// Gets the main launcher activity for a package
    async fn get_main_activity(&self, adb: &Path, serial: &str, package: &str) -> Result<String> {
        let output = Command::new(adb)
            .args([
                "-s",
                serial,
                "shell",
                "cmd",
                "package",
                "resolve-activity",
                "--brief",
                "-c",
                "android.intent.category.LAUNCHER",
                package,
            ])
            .output()
            .await
            .context("Failed to resolve main activity")?;

        let stdout = String::from_utf8_lossy(&output.stdout);

        // Parse output like "com.example.app/.MainActivity"
        for line in stdout.lines() {
            if line.contains('/') {
                let parts: Vec<&str> = line.trim().split('/').collect();
                if parts.len() == 2 {
                    return Ok(parts[1].to_string());
                }
            }
        }

        // Fallback: try common Flutter activity name
        Ok(".MainActivity".to_string())
    }

    // ============================================================
    // LOGCAT STREAMING
    // ============================================================

    /// Starts streaming logcat output
    pub async fn start_logcat(
        &self,
        package_name: Option<&str>,
        log_tx: mpsc::UnboundedSender<LogcatEntry>,
    ) -> Result<()> {
        let serial = self
            .serial()
            .await
            .ok_or_else(|| anyhow::anyhow!("No emulator serial"))?;

        let adb = self.config.android_sdk_root.join("platform-tools/adb");

        // Build logcat command
        let mut cmd = Command::new(&adb);
        cmd.args(["-s", &serial, "logcat", "-v", "threadtime"]);

        // Filter by package if specified
        if let Some(pkg) = package_name {
            // Get PID of the app
            if let Ok(pid) = self.get_app_pid(&adb, &serial, pkg).await {
                cmd.args(["--pid", &pid.to_string()]);
            }
        }

        cmd.stdout(Stdio::piped()).stderr(Stdio::null());

        let mut child = cmd.spawn().context("Failed to spawn logcat")?;
        let stdout = child.stdout.take().unwrap();

        // Store process handle
        *self.logcat_process.lock().await = Some(child);

        // Spawn task to read and forward log entries
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();

            while let Ok(Some(line)) = reader.next_line().await {
                if let Some(entry) = parse_logcat_line(&line) {
                    if log_tx.send(entry).is_err() {
                        break; // Receiver dropped
                    }
                }
            }
        });

        Ok(())
    }

    /// Stops logcat streaming
    pub async fn stop_logcat(&self) -> Result<()> {
        if let Some(mut child) = self.logcat_process.lock().await.take() {
            let _ = child.kill().await;
        }
        Ok(())
    }

    /// Gets the PID of a running app
    async fn get_app_pid(&self, adb: &Path, serial: &str, package: &str) -> Result<u32> {
        let output = Command::new(adb)
            .args(["-s", serial, "shell", "pidof", package])
            .output()
            .await?;

        let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let pid: u32 = pid_str.parse().context("Invalid PID")?;
        Ok(pid)
    }

    // ============================================================
    // SHUTDOWN AND CLEANUP
    // ============================================================

    /// Gracefully shuts down the emulator
    pub async fn shutdown(&mut self) -> Result<()> {
        *self.state.lock().await = EmulatorState::ShuttingDown;

        // Stop logcat first
        self.stop_logcat().await?;

        // Try graceful shutdown via adb
        if let Some(serial) = self.serial().await {
            let adb = self.config.android_sdk_root.join("platform-tools/adb");

            // Send shutdown command
            let _ = Command::new(&adb)
                .args(["-s", &serial, "emu", "kill"])
                .output()
                .await;

            // Wait up to 10 seconds for graceful shutdown
            let graceful_timeout = Duration::from_secs(10);
            let _ = timeout(graceful_timeout, self.wait_for_emulator_exit()).await;
        }

        // Force kill if still running
        self.kill_emulator().await;

        *self.state.lock().await = EmulatorState::Stopped;
        *self.serial.lock().await = None;

        Ok(())
    }

    /// Waits for emulator process to exit
    async fn wait_for_emulator_exit(&self) {
        if let Some(ref mut child) = *self.emulator_process.lock().await {
            let _ = child.wait().await;
        }
    }

    /// Force kills the emulator process
    async fn kill_emulator(&self) {
        if let Some(mut child) = self.emulator_process.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await; // Reap zombie
        }
    }

    /// Checks if session has exceeded maximum duration
    pub fn is_expired(&self) -> bool {
        if let Some(started) = self.started_at {
            started.elapsed() > Duration::from_secs(self.config.max_session_secs)
        } else {
            false
        }
    }

    /// Force terminates everything (for crash recovery)
    pub async fn force_terminate(&mut self) {
        // Kill logcat
        if let Some(mut child) = self.logcat_process.lock().await.take() {
            let _ = child.kill().await;
        }

        // Kill emulator
        if let Some(mut child) = self.emulator_process.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }

        // Also kill any stray emulator processes
        let _ = Command::new("pkill")
            .args(["-9", "-f", &format!("-avd {}", self.config.avd_name)])
            .output()
            .await;

        *self.state.lock().await = EmulatorState::Stopped;
    }
}

impl Drop for EmulatorSession {
    fn drop(&mut self) {
        // Ensure cleanup runs (spawn blocking task)
        // Note: In production, use explicit shutdown() instead
    }
}

// ============================================================
// LOGCAT PARSING
// ============================================================

/// Parses a logcat line in threadtime format
/// Format: "MM-DD HH:MM:SS.mmm PID TID LEVEL TAG: MESSAGE"
fn parse_logcat_line(line: &str) -> Option<LogcatEntry> {
    let parts: Vec<&str> = line.splitn(7, ' ').collect();
    if parts.len() < 7 {
        return None;
    }

    let timestamp = format!("{} {}", parts[0], parts[1]);
    let pid: Option<u32> = parts[2].trim().parse().ok();
    let tid: Option<u32> = parts[3].trim().parse().ok();
    let level = parts[4]
        .chars()
        .next()
        .map(LogLevel::from_char)
        .unwrap_or(LogLevel::Info);

    // Tag and message are separated by ": "
    let tag_msg = parts[5..].join(" ");
    let (tag, message) = if let Some(idx) = tag_msg.find(": ") {
        (
            tag_msg[..idx].trim().to_string(),
            tag_msg[idx + 2..].to_string(),
        )
    } else {
        (tag_msg.clone(), String::new())
    };

    Some(LogcatEntry {
        timestamp,
        pid,
        tid,
        level,
        tag,
        message,
    })
}

// ============================================================
// HEALTH CHECKS
// ============================================================

/// Checks if Android SDK is properly installed
pub async fn check_android_sdk(sdk_root: &Path) -> Result<AndroidSdkHealth> {
    let mut health = AndroidSdkHealth {
        sdk_root_exists: sdk_root.exists(),
        emulator_exists: false,
        adb_exists: false,
        avdmanager_exists: false,
        system_images: vec![],
        issues: vec![],
    };

    if !health.sdk_root_exists {
        health
            .issues
            .push(format!("SDK root does not exist: {:?}", sdk_root));
        return Ok(health);
    }

    // Check emulator
    let emulator = sdk_root.join("emulator/emulator");
    health.emulator_exists = emulator.exists();
    if !health.emulator_exists {
        health.issues.push("emulator binary not found".to_string());
    }

    // Check adb
    let adb = sdk_root.join("platform-tools/adb");
    health.adb_exists = adb.exists();
    if !health.adb_exists {
        health.issues.push("adb binary not found".to_string());
    }

    // Check avdmanager
    let avdmanager = sdk_root.join("cmdline-tools/latest/bin/avdmanager");
    health.avdmanager_exists = avdmanager.exists();
    if !health.avdmanager_exists {
        health.issues.push("avdmanager not found".to_string());
    }

    // List installed system images
    let sdkmanager = sdk_root.join("cmdline-tools/latest/bin/sdkmanager");
    if sdkmanager.exists() {
        if let Ok(output) = Command::new(&sdkmanager)
            .args(["--list_installed"])
            .output()
            .await
        {
            let installed = String::from_utf8_lossy(&output.stdout);
            for line in installed.lines() {
                if line.contains("system-images") {
                    health.system_images.push(line.trim().to_string());
                }
            }
        }
    }

    Ok(health)
}

/// Android SDK health check result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AndroidSdkHealth {
    pub sdk_root_exists: bool,
    pub emulator_exists: bool,
    pub adb_exists: bool,
    pub avdmanager_exists: bool,
    pub system_images: Vec<String>,
    pub issues: Vec<String>,
}

impl AndroidSdkHealth {
    pub fn is_healthy(&self) -> bool {
        self.sdk_root_exists
            && self.emulator_exists
            && self.adb_exists
            && self.avdmanager_exists
            && !self.system_images.is_empty()
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_logcat_line() {
        let line = "12-16 10:30:45.123  1234  5678 I flutter : Hello World";
        let entry = parse_logcat_line(line).unwrap();

        assert_eq!(entry.timestamp, "12-16 10:30:45.123");
        assert_eq!(entry.pid, Some(1234));
        assert_eq!(entry.tid, Some(5678));
        assert_eq!(entry.level, LogLevel::Info);
        assert!(entry.tag.contains("flutter"));
    }

    #[test]
    fn test_log_level_from_char() {
        assert_eq!(LogLevel::from_char('V'), LogLevel::Verbose);
        assert_eq!(LogLevel::from_char('D'), LogLevel::Debug);
        assert_eq!(LogLevel::from_char('I'), LogLevel::Info);
        assert_eq!(LogLevel::from_char('W'), LogLevel::Warning);
        assert_eq!(LogLevel::from_char('E'), LogLevel::Error);
        assert_eq!(LogLevel::from_char('F'), LogLevel::Fatal);
    }

    #[test]
    fn test_emulator_config_default() {
        let config = EmulatorConfig::default();
        assert_eq!(config.avd_name, DEFAULT_AVD_NAME);
        assert_eq!(config.ram_mb, 2048);
        assert_eq!(config.use_hw_accel, false);
    }
}
