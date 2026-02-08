use anyhow::{Context, Result};
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

use super::session::EmulatorSession;
use super::types::{AppInstallResult, EmulatorState, APK_INSTALL_TIMEOUT_SECS};

impl EmulatorSession {
    // ============================================================
    // APP INSTALLATION
    // ============================================================

    /// Installs an APK on the emulator
    pub async fn install_apk(&self, apk_path: &Path) -> Result<AppInstallResult> {
        let start = std::time::Instant::now();

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

        let adb = self.core.config.android_sdk_root.join("platform-tools/adb");

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

        let out = stdout.trim();
        let err = stderr.trim();
        let combined = format!("stdout: {}\nstderr: {}", out, err);

        // `adb install` reports success/failure primarily on stdout.
        if !output.status.success() || !out.contains("Success") {
            return Ok(AppInstallResult {
                success: false,
                install_time_ms: start.elapsed().as_millis() as u64,
                package_name: None,
                error: Some(format!("Install failed. {}", combined)),
            });
        }

        // Try to extract package name from APK using aapt (best effort)
        // This is optional; if it fails, we still return success.
        let package_name = None;

        Ok(AppInstallResult {
            success: true,
            install_time_ms: start.elapsed().as_millis() as u64,
            package_name,
            error: None,
        })
    }
}
