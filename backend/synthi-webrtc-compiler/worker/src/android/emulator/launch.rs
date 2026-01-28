use anyhow::{Context, Result};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

use super::session::EmulatorSession;
use super::types::{AppLaunchResult, EmulatorState, APP_LAUNCH_TIMEOUT_SECS};

impl EmulatorSession {
    // ============================================================
    // APP LAUNCH
    // ============================================================

    /// Launches the app's main activity
    pub async fn launch_app(&self, package_name: &str) -> Result<AppLaunchResult> {
        let start = std::time::Instant::now();

        let serial = self
            .serial()
            .await
            .ok_or_else(|| anyhow::anyhow!("No emulator serial"))?;

        let adb = self.core.config.android_sdk_root.join("platform-tools/adb");

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

        let out = String::from_utf8_lossy(&output.stdout);
        let out_trim = out.trim();
        let err_trim = stderr.trim();
        let combined = format!("stdout: {}\nstderr: {}", out_trim, err_trim);

        // `am start` errors can appear on either stdout or stderr depending on Android version.
        let combined_lower = combined.to_lowercase();
        let looks_like_error = combined_lower.contains("error")
            || combined_lower.contains("exception")
            || combined_lower.contains("does not exist")
            || combined_lower.contains("not started")
            || combined_lower.contains("unable to find");

        if !output.status.success() || looks_like_error {
            return Ok(AppLaunchResult {
                success: false,
                launch_time_ms: start.elapsed().as_millis() as u64,
                activity: None,
                error: Some(format!("Launch failed. {}", combined)),
            });
        }

        *self.core.state.lock().await = EmulatorState::Running;

        Ok(AppLaunchResult {
            success: true,
            launch_time_ms: start.elapsed().as_millis() as u64,
            activity: Some(activity),
            error: None,
        })
    }

    async fn get_main_activity(
        &self,
        adb: &std::path::Path,
        serial: &str,
        package: &str,
    ) -> Result<String> {
        // Prefer using `cmd package resolve-activity` if available.
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
                "-a",
                "android.intent.action.MAIN",
                package,
            ])
            .output()
            .await;

        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Resolve output can contain lines like:
            //   com.example.app/.MainActivity
            // or sometimes:
            //   name=com.example.app/.MainActivity
            for line in stdout.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }

                let component = line.strip_prefix("name=").unwrap_or(line).trim();

                if component.contains('/') {
                    let parts: Vec<&str> = component.split('/').collect();
                    if parts.len() == 2 && !parts[1].trim().is_empty() {
                        return Ok(parts[1].trim().to_string());
                    }
                }
            }
        }

        // Fallback: try common Flutter activity name
        Ok(".MainActivity".to_string())
    }
}
