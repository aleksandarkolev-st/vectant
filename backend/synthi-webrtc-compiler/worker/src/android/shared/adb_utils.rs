// ============================================================
// ADB UTILITIES
// ============================================================
// Common ADB operations shared across all mobile compilation types.
// Provides a unified interface for APK installation, app launching,
// port forwarding, and package management.
// ============================================================

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

// ============================================================
// CONSTANTS
// ============================================================

/// Default timeout for APK installation (120 seconds)
pub const APK_INSTALL_TIMEOUT_SECS: u64 = 120;

/// Default timeout for app launch (30 seconds)
pub const APP_LAUNCH_TIMEOUT_SECS: u64 = 30;

/// Default timeout for ADB commands (60 seconds)
pub const ADB_COMMAND_TIMEOUT_SECS: u64 = 60;

// ============================================================
// RESULT TYPES
// ============================================================

/// Result of an APK installation operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdbInstallResult {
    pub success: bool,
    pub install_time_ms: u64,
    pub package_name: Option<String>,
    pub error: Option<String>,
    pub replaced_existing: bool,
}

/// Result of an app launch operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdbLaunchResult {
    pub success: bool,
    pub launch_time_ms: u64,
    pub activity: Option<String>,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

// ============================================================
// APK INSTALLATION
// ============================================================

/// Installs an APK on the specified emulator/device
///
/// # Arguments
/// * `adb_path` - Path to the adb binary
/// * `serial` - Device/emulator serial (e.g., "emulator-5554")
/// * `apk_path` - Path to the APK file
/// * `reinstall` - Whether to reinstall (replace existing) if already installed
/// * `allow_test` - Whether to allow test APKs (-t flag)
pub async fn adb_install_apk(
    adb_path: &Path,
    serial: &str,
    apk_path: &Path,
    reinstall: bool,
    allow_test: bool,
) -> Result<AdbInstallResult> {
    let start = std::time::Instant::now();

    if !apk_path.exists() {
        return Ok(AdbInstallResult {
            success: false,
            install_time_ms: 0,
            package_name: None,
            error: Some(format!("APK file not found: {:?}", apk_path)),
            replaced_existing: false,
        });
    }

    let mut args = vec!["-s", serial, "install"];
    if reinstall {
        args.push("-r");
    }
    if allow_test {
        args.push("-t");
    }

    let output = timeout(
        Duration::from_secs(APK_INSTALL_TIMEOUT_SECS),
        Command::new(adb_path)
            .args(&args)
            .arg(apk_path)
            .output(),
    )
    .await
    .context("APK install timeout")?
    .context("Failed to run adb install")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("stdout: {}\nstderr: {}", stdout.trim(), stderr.trim());

    // Check for success
    let success = output.status.success() && stdout.contains("Success");
    let replaced = stdout.contains("replacing existing") || reinstall;

    // Try to extract package name using aapt
    let package_name = extract_package_from_apk(adb_path.parent().unwrap_or(Path::new(".")), apk_path).await.ok();

    if !success {
        return Ok(AdbInstallResult {
            success: false,
            install_time_ms: start.elapsed().as_millis() as u64,
            package_name,
            error: Some(format!("Install failed: {}", combined)),
            replaced_existing: false,
        });
    }

    Ok(AdbInstallResult {
        success: true,
        install_time_ms: start.elapsed().as_millis() as u64,
        package_name,
        error: None,
        replaced_existing: replaced,
    })
}

/// Extracts package name from APK using aapt or aapt2
async fn extract_package_from_apk(sdk_tools_dir: &Path, apk_path: &Path) -> Result<String> {
    // Try aapt2 first, then aapt
    let aapt_paths = [
        sdk_tools_dir.join("aapt2"),
        sdk_tools_dir.join("aapt"),
        PathBuf::from("aapt2"),
        PathBuf::from("aapt"),
    ];

    for aapt in &aapt_paths {
        let output = Command::new(aapt)
            .args(["dump", "badging"])
            .arg(apk_path)
            .output()
            .await;

        if let Ok(output) = output {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // Parse: package: name='com.example.app' versionCode='1' ...
                for line in stdout.lines() {
                    if line.starts_with("package:") {
                        if let Some(start) = line.find("name='") {
                            let rest = &line[start + 6..];
                            if let Some(end) = rest.find('\'') {
                                return Ok(rest[..end].to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    bail!("Could not extract package name from APK")
}

// ============================================================
// APP LAUNCHING
// ============================================================

/// Launches an app's main activity on the specified emulator/device
///
/// # Arguments
/// * `adb_path` - Path to the adb binary
/// * `serial` - Device/emulator serial
/// * `package_name` - App package name (e.g., "com.example.app")
/// * `activity_name` - Optional activity name (will auto-detect if None)
pub async fn adb_launch_activity(
    adb_path: &Path,
    serial: &str,
    package_name: &str,
    activity_name: Option<&str>,
) -> Result<AdbLaunchResult> {
    let start = std::time::Instant::now();

    // Resolve activity name if not provided
    let activity = match activity_name {
        Some(a) => a.to_string(),
        None => resolve_main_activity(adb_path, serial, package_name).await?,
    };

    // Launch the activity
    let component = format!("{}/{}", package_name, activity);
    let output = timeout(
        Duration::from_secs(APP_LAUNCH_TIMEOUT_SECS),
        Command::new(adb_path)
            .args([
                "-s", serial,
                "shell", "am", "start",
                "-n", &component,
                "-a", "android.intent.action.MAIN",
                "-c", "android.intent.category.LAUNCHER",
            ])
            .output(),
    )
    .await
    .context("App launch timeout")?
    .context("Failed to run am start")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout.trim(), stderr.trim()).to_lowercase();

    // Check for errors
    let has_error = combined.contains("error")
        || combined.contains("exception")
        || combined.contains("does not exist")
        || combined.contains("not started")
        || combined.contains("unable to find");

    if !output.status.success() || has_error {
        return Ok(AdbLaunchResult {
            success: false,
            launch_time_ms: start.elapsed().as_millis() as u64,
            activity: Some(activity),
            pid: None,
            error: Some(format!("Launch failed: {}", combined)),
        });
    }

    // Try to get PID
    let pid = get_app_pid(adb_path, serial, package_name).await.ok();

    Ok(AdbLaunchResult {
        success: true,
        launch_time_ms: start.elapsed().as_millis() as u64,
        activity: Some(activity),
        pid,
        error: None,
    })
}

/// Resolves the main activity for a package
async fn resolve_main_activity(adb_path: &Path, serial: &str, package: &str) -> Result<String> {
    // Try using cmd package resolve-activity (API 24+)
    let output = Command::new(adb_path)
        .args([
            "-s", serial,
            "shell", "cmd", "package", "resolve-activity",
            "--brief",
            "-c", "android.intent.category.LAUNCHER",
            "-a", "android.intent.action.MAIN",
            package,
        ])
        .output()
        .await;

    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let component = line.strip_prefix("name=").unwrap_or(line).trim();
            if component.contains('/') {
                let parts: Vec<&str> = component.split('/').collect();
                if parts.len() == 2 && !parts[1].is_empty() {
                    return Ok(parts[1].to_string());
                }
            }
        }
    }

    // Fallback to common activity names
    Ok(".MainActivity".to_string())
}

/// Gets the PID of a running app
async fn get_app_pid(adb_path: &Path, serial: &str, package: &str) -> Result<u32> {
    let output = Command::new(adb_path)
        .args(["-s", serial, "shell", "pidof", package])
        .output()
        .await?;

    let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let pid: u32 = pid_str.parse().context("Invalid PID")?;
    Ok(pid)
}

// ============================================================
// PACKAGE MANAGEMENT
// ============================================================

/// Gets list of installed packages on the device
pub async fn adb_get_installed_packages(adb_path: &Path, serial: &str) -> Result<Vec<String>> {
    let output = Command::new(adb_path)
        .args(["-s", serial, "shell", "pm", "list", "packages"])
        .output()
        .await
        .context("Failed to list packages")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let packages: Vec<String> = stdout
        .lines()
        .filter_map(|line| line.strip_prefix("package:"))
        .map(|s| s.trim().to_string())
        .collect();

    Ok(packages)
}

/// Uninstalls a package from the device
pub async fn adb_uninstall_package(adb_path: &Path, serial: &str, package: &str) -> Result<bool> {
    let output = Command::new(adb_path)
        .args(["-s", serial, "uninstall", package])
        .output()
        .await
        .context("Failed to uninstall package")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.contains("Success"))
}

// ============================================================
// PORT FORWARDING
// ============================================================

/// Sets up port forwarding from host to device
pub async fn adb_forward_port(
    adb_path: &Path,
    serial: &str,
    host_port: u16,
    device_port: u16,
) -> Result<()> {
    let output = Command::new(adb_path)
        .args([
            "-s", serial,
            "forward",
            &format!("tcp:{}", host_port),
            &format!("tcp:{}", device_port),
        ])
        .output()
        .await
        .context("Failed to set up port forwarding")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Port forward failed: {}", stderr);
    }

    Ok(())
}

/// Sets up reverse port forwarding from device to host
pub async fn adb_reverse_port(
    adb_path: &Path,
    serial: &str,
    device_port: u16,
    host_port: u16,
) -> Result<()> {
    let output = Command::new(adb_path)
        .args([
            "-s", serial,
            "reverse",
            &format!("tcp:{}", device_port),
            &format!("tcp:{}", host_port),
        ])
        .output()
        .await
        .context("Failed to set up reverse port")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Reverse port failed: {}", stderr);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_adb_result_types() {
        let install_result = AdbInstallResult {
            success: true,
            install_time_ms: 1500,
            package_name: Some("com.example.app".to_string()),
            error: None,
            replaced_existing: false,
        };
        assert!(install_result.success);

        let launch_result = AdbLaunchResult {
            success: true,
            launch_time_ms: 500,
            activity: Some(".MainActivity".to_string()),
            pid: Some(12345),
            error: None,
        };
        assert!(launch_result.success);
    }
}
