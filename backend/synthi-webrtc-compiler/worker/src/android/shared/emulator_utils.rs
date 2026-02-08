// ============================================================
// EMULATOR UTILITIES
// ============================================================
// Cross-platform emulator utilities shared between React Native,
// Native Android, and Flutter compilation pipelines.
// ============================================================

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::time::sleep;

// ============================================================
// CONSTANTS
// ============================================================

/// Default boot timeout (10 minutes for cold boot without KVM)
pub const EMULATOR_BOOT_TIMEOUT_SECS: u64 = 600;

/// Polling interval for boot status checks
pub const BOOT_POLL_INTERVAL_MS: u64 = 2000;

/// ADB connection timeout
pub const ADB_CONNECT_TIMEOUT_SECS: u64 = 180;

// ============================================================
// TYPES
// ============================================================

/// Emulator boot status
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EmulatorBootStatus {
    /// Emulator is not running
    NotRunning,
    /// Emulator is booting (boot_completed != 1)
    Booting,
    /// Emulator is fully booted and ready
    Ready,
    /// Boot failed with error
    Failed(String),
    /// Boot timed out
    TimedOut,
}

/// Emulator device properties
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmulatorProperties {
    pub boot_completed: bool,
    pub sdk_version: Option<u32>,
    pub device_model: Option<String>,
    pub product_name: Option<String>,
    pub abi: Option<String>,
    pub locale: Option<String>,
    pub all_properties: HashMap<String, String>,
}

// ============================================================
// BOOT CHECKING
// ============================================================

/// Waits for the emulator to complete booting
///
/// # Arguments
/// * `adb_path` - Path to adb binary
/// * `serial` - Emulator serial (e.g., "emulator-5554")
/// * `timeout_secs` - Maximum time to wait for boot completion
/// * `progress_callback` - Optional callback for progress updates
///
/// # Returns
/// * `EmulatorBootStatus::Ready` if boot completed successfully
/// * `EmulatorBootStatus::TimedOut` if boot didn't complete in time
/// * `EmulatorBootStatus::Failed` if an error occurred
pub async fn wait_for_emulator_boot<F>(
    adb_path: &Path,
    serial: &str,
    timeout_secs: u64,
    progress_callback: Option<F>,
) -> EmulatorBootStatus
where
    F: Fn(&str) + Send + Sync,
{
    let start = Instant::now();
    let timeout = Duration::from_secs(timeout_secs);
    let poll_interval = Duration::from_millis(BOOT_POLL_INTERVAL_MS);

    let mut last_status = String::new();
    let mut consecutive_ready = 0;

    loop {
        if start.elapsed() > timeout {
            return EmulatorBootStatus::TimedOut;
        }

        // Check boot_completed property
        match check_boot_completed(adb_path, serial).await {
            Ok(true) => {
                consecutive_ready += 1;
                // Require 2 consecutive ready checks to avoid false positives
                if consecutive_ready >= 2 {
                    if let Some(ref cb) = progress_callback {
                        cb("Emulator boot completed");
                    }
                    return EmulatorBootStatus::Ready;
                }
            }
            Ok(false) => {
                consecutive_ready = 0;
                let status = format!(
                    "Booting... ({}s elapsed)",
                    start.elapsed().as_secs()
                );
                if status != last_status {
                    if let Some(ref cb) = progress_callback {
                        cb(&status);
                    }
                    last_status = status;
                }
            }
            Err(e) => {
                consecutive_ready = 0;
                // ADB connection errors are expected during early boot
                let err_str = e.to_string();
                if err_str.contains("device offline") || err_str.contains("no devices") {
                    let status = format!(
                        "Waiting for emulator connection... ({}s elapsed)",
                        start.elapsed().as_secs()
                    );
                    if status != last_status {
                        if let Some(ref cb) = progress_callback {
                            cb(&status);
                        }
                        last_status = status;
                    }
                }
            }
        }

        sleep(poll_interval).await;
    }
}

/// Checks if sys.boot_completed == 1
async fn check_boot_completed(adb_path: &Path, serial: &str) -> Result<bool> {
    let output = Command::new(adb_path)
        .args(["-s", serial, "shell", "getprop", "sys.boot_completed"])
        .output()
        .await
        .context("Failed to check boot status")?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(stdout == "1")
}

// ============================================================
// CONNECTIVITY CHECKING
// ============================================================

/// Checks if the emulator is reachable via ADB
pub async fn check_emulator_connectivity(adb_path: &Path, serial: &str) -> Result<bool> {
    let output = Command::new(adb_path)
        .args(["-s", serial, "shell", "echo", "ping"])
        .output()
        .await
        .context("Failed to ping emulator")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(output.status.success() && stdout.contains("ping"))
}

/// Waits for ADB to connect to the emulator
pub async fn wait_for_adb_connection(
    adb_path: &Path,
    serial: &str,
    timeout_secs: u64,
) -> Result<()> {
    let start = Instant::now();
    let timeout = Duration::from_secs(timeout_secs);
    let poll_interval = Duration::from_millis(1000);

    loop {
        if start.elapsed() > timeout {
            bail!("ADB connection timed out after {}s", timeout_secs);
        }

        if check_emulator_connectivity(adb_path, serial).await.unwrap_or(false) {
            return Ok(());
        }

        sleep(poll_interval).await;
    }
}

// ============================================================
// PROPERTY RETRIEVAL
// ============================================================

/// Gets various properties from the emulator
pub async fn get_emulator_properties(adb_path: &Path, serial: &str) -> Result<EmulatorProperties> {
    let output = Command::new(adb_path)
        .args(["-s", serial, "shell", "getprop"])
        .output()
        .await
        .context("Failed to get properties")?;

    if !output.status.success() {
        bail!("getprop failed");
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut props = HashMap::new();

    for line in stdout.lines() {
        // Parse format: [prop.name]: [value]
        if let Some(start) = line.find('[') {
            if let Some(end) = line[start..].find(']') {
                let key = &line[start + 1..start + end];
                if let Some(val_start) = line[start + end..].find('[') {
                    let rest = &line[start + end + val_start..];
                    if let Some(val_end) = rest[1..].find(']') {
                        let value = &rest[1..val_end + 1];
                        props.insert(key.to_string(), value.to_string());
                    }
                }
            }
        }
    }

    Ok(EmulatorProperties {
        boot_completed: props.get("sys.boot_completed").map(|v| v == "1").unwrap_or(false),
        sdk_version: props
            .get("ro.build.version.sdk")
            .and_then(|v| v.parse().ok()),
        device_model: props.get("ro.product.model").cloned(),
        product_name: props.get("ro.product.name").cloned(),
        abi: props.get("ro.product.cpu.abi").cloned(),
        locale: props.get("persist.sys.locale").cloned(),
        all_properties: props,
    })
}

/// Gets specific property value from emulator
pub async fn get_emulator_property(
    adb_path: &Path,
    serial: &str,
    property: &str,
) -> Result<String> {
    let output = Command::new(adb_path)
        .args(["-s", serial, "shell", "getprop", property])
        .output()
        .await
        .context("Failed to get property")?;

    if !output.status.success() {
        bail!("getprop {} failed", property);
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// ============================================================
// SCREEN STATE
// ============================================================

/// Wakes up the emulator screen
pub async fn wake_emulator_screen(adb_path: &Path, serial: &str) -> Result<()> {
    // Send KEYCODE_WAKEUP
    Command::new(adb_path)
        .args(["-s", serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP"])
        .output()
        .await
        .context("Failed to wake screen")?;

    // Dismiss lock screen if present
    Command::new(adb_path)
        .args(["-s", serial, "shell", "input", "keyevent", "KEYCODE_MENU"])
        .output()
        .await
        .ok();

    Ok(())
}

/// Checks if the screen is on
pub async fn is_screen_on(adb_path: &Path, serial: &str) -> Result<bool> {
    let output = Command::new(adb_path)
        .args(["-s", serial, "shell", "dumpsys", "display"])
        .output()
        .await
        .context("Failed to check screen state")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Look for "mScreenState=ON" or "Display Power: state=ON"
    Ok(stdout.contains("mScreenState=ON") || stdout.contains("state=ON"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_boot_status_variants() {
        assert_eq!(EmulatorBootStatus::Ready, EmulatorBootStatus::Ready);
        assert_ne!(EmulatorBootStatus::Booting, EmulatorBootStatus::Ready);
    }

    #[test]
    fn test_emulator_properties_default() {
        let props = EmulatorProperties::default();
        assert!(!props.boot_completed);
        assert!(props.sdk_version.is_none());
    }
}
