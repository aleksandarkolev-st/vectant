use anyhow::{bail, Context, Result};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncBufReadExt;
use tokio::io::BufReader;
use tokio::process::Command;
use tokio::time::timeout;

use super::session::EmulatorSession;
use super::types::{
    EmulatorBootResult, EmulatorState, ADB_CONNECT_TIMEOUT_SECS, BOOT_POLL_INTERVAL_MS,
};

impl EmulatorSession {
    // ============================================================
    // EMULATOR LIFECYCLE
    // ============================================================

    /// Boots the emulator and waits for it to be ready
    pub async fn boot(&mut self) -> Result<EmulatorBootResult> {
        let start = Instant::now();

        // Update state
        *self.core.state.lock().await = EmulatorState::Booting;

        // Ensure AVD and system image exist
        self.ensure_system_image().await?;
        self.ensure_avd().await?;

        // Ensure an X11 display exists for real-time video capture.
        // Default (Linux): run the emulator on Xvfb so it doesn't pop a visible window,
        // and so the capture pipeline has a stable, known display.
        // Opt-in to host display via SYNTHI_ANDROID_USE_HOST_DISPLAY=true.
        let display = if cfg!(target_os = "windows") {
            std::env::var("DISPLAY").unwrap_or_default()
        } else {
            let use_host_display = std::env::var("SYNTHI_ANDROID_USE_HOST_DISPLAY")
                .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes"))
                .unwrap_or(false);

            if use_host_display {
                std::env::var("DISPLAY").unwrap_or_default()
            } else {
                let d = std::env::var("SYNTHI_ANDROID_XVFB_DISPLAY")
                    .unwrap_or_else(|_| ":99".to_string());
                let res = std::env::var("SYNTHI_ANDROID_XVFB_RESOLUTION")
                    .unwrap_or_else(|_| "1440x2960".to_string());
                let screen = format!("{}x24", res);

                // Spawn Xvfb and keep it alive for the lifetime of this emulator session.
                let mut xvfb = Command::new("Xvfb");
                xvfb.args([
                    &d,
                    "-screen",
                    "0",
                    &screen,
                    "-nolisten",
                    "tcp",
                    "-ac",
                    "+extension",
                    "GLX",
                    // Disable MIT-SHM to avoid X_ShmGetImage BadMatch errors in headless capture.
                    "-extension",
                    "MIT-SHM",
                    "+render",
                    "-noreset",
                ]);
                xvfb.stdout(Stdio::null()).stderr(Stdio::null());

                match xvfb.spawn() {
                    Ok(child) => {
                        *self.core.xvfb_process.lock().await = Some(child);
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        d
                    }
                    Err(e) => {
                        // Fallback: if Xvfb isn't available, use the host DISPLAY.
                        // This may open a visible emulator window.
                        let host = std::env::var("DISPLAY").unwrap_or_default();
                        if host.trim().is_empty() {
                            return Err(e).context("Failed to start Xvfb and no DISPLAY set");
                        }
                        host
                    }
                }
            }
        };

        *self.core.x11_display.lock().await = display.clone();

        // Build emulator command
        let emulator_path = self
            .core
            .config
            .android_sdk_root
            .join("emulator/emulator");

        let mut cmd = Command::new(&emulator_path);
        // GPU mode: ximagesrc capture requires the emulator to render into the X11 window.
        // -gpu off = no rendering at all (headless, no X11 output)
        // -gpu swiftshader_indirect = software rendering, but uses incompatible X11 visual (XID capture fails with BadMatch)
        // -gpu guest = software rendering inside Android VM, renders to standard X11 window
        // For video streaming with ximagesrc, -gpu guest is most compatible.
        let gpu_mode = if cfg!(target_os = "windows") {
            std::env::var("SYNTHI_ANDROID_EMULATOR_GPU").unwrap_or_else(|_| "swiftshader_indirect".to_string())
        } else {
            std::env::var("SYNTHI_ANDROID_EMULATOR_GPU").unwrap_or_else(|_| {
                // Use guest mode for X11 capture compatibility
                "guest".to_string()
            })
        };
        eprintln!("[emulator] Starting with -gpu {} on DISPLAY={}", gpu_mode, display);
        cmd.args([
            "-avd",
            &self.core.config.avd_name,
            "-no-audio",     // No audio
            "-no-boot-anim", // Skip boot animation
            "-gpu",
            &gpu_mode,
            "-memory",
            &self.core.config.ram_mb.to_string(),
            "-cores",
            &self.core.config.cores.to_string(),
            "-read-only",        // Don't modify system image
            "-no-snapshot-save", // Don't save snapshots
            "-no-snapshot-load", // Don't load snapshots
            "-no-skin",          // Disable device skin/frame (removes side toolbar)
        ]);

        if !display.trim().is_empty() {
            cmd.env("DISPLAY", &display);
        }

        // Add hardware acceleration if enabled
        if self.core.config.use_hw_accel {
            cmd.args(["-accel", "on"]);
        } else {
            cmd.args(["-accel", "off"]);
        }

        // Add extra args
        for arg in &self.core.config.extra_args {
            cmd.arg(arg);
        }

        // Pipe output for debugging
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        // Start emulator process
        let mut child = cmd.spawn().context("Failed to spawn emulator")?;

        // Capture stderr for error reporting
        let stderr = child.stderr.take();
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr).lines();
            let state = self.core.state.clone();
            tokio::spawn(async move {
                while let Ok(Some(line)) = reader.next_line().await {
                    // If emulator output indicates crash, mark state
                    if line.contains("panic") || line.contains("FATAL") {
                        *state.lock().await = EmulatorState::Failed;
                    }
                }
            });
        }

        // Store process handle
        *self.core.emulator_process.lock().await = Some(child);
        self.core.started_at = Some(Instant::now());

        // Wait for emulator to boot and be ready
        let boot_timeout = Duration::from_secs(self.core.config.boot_timeout_secs);
        let result = timeout(boot_timeout, self.wait_for_emulator_ready()).await;

        match result {
            Ok(Ok(serial)) => {
                *self.core.serial.lock().await = Some(serial.clone());
                *self.core.state.lock().await = EmulatorState::Ready;

                Ok(EmulatorBootResult {
                    success: true,
                    state: EmulatorState::Ready,
                    boot_time_ms: start.elapsed().as_millis() as u64,
                    serial: Some(serial),
                    error: None,
                })
            }
            Ok(Err(e)) => {
                *self.core.state.lock().await = EmulatorState::Failed;
                Ok(EmulatorBootResult {
                    success: false,
                    state: EmulatorState::Failed,
                    boot_time_ms: start.elapsed().as_millis() as u64,
                    serial: None,
                    error: Some(format!("{}", e)),
                })
            }
            Err(_) => {
                *self.core.state.lock().await = EmulatorState::Failed;
                Ok(EmulatorBootResult {
                    success: false,
                    state: EmulatorState::Failed,
                    boot_time_ms: start.elapsed().as_millis() as u64,
                    serial: None,
                    error: Some("Emulator boot timed out".to_string()),
                })
            }
        }
    }

    async fn wait_for_emulator_ready(&self) -> Result<String> {
        let adb = self
            .core
            .config
            .android_sdk_root
            .join("platform-tools/adb");

        // Wait for adb to see the emulator device
        let serial = timeout(
            Duration::from_secs(ADB_CONNECT_TIMEOUT_SECS),
            self.wait_for_adb_device(&adb),
        )
        .await
        .context("adb connect timeout")??;

        // Wait for boot complete
        self.wait_for_boot_complete(&adb, &serial).await?;

        Ok(serial)
    }

    async fn wait_for_adb_device(&self, adb: &std::path::Path) -> Result<String> {
        // `adb devices` can list multiple devices; pick the first emulator.
        for _ in 0..60 {
            let output = Command::new(adb).arg("devices").output().await?;
            let stdout = String::from_utf8_lossy(&output.stdout);

            for line in stdout.lines() {
                let line = line.trim();
                if line.starts_with("emulator-") && line.contains("\tdevice") {
                    let serial = line.split_whitespace().next().unwrap_or("").to_string();
                    if !serial.is_empty() {
                        return Ok(serial);
                    }
                }
            }

            tokio::time::sleep(Duration::from_millis(BOOT_POLL_INTERVAL_MS)).await;
        }

        bail!("No emulator device detected via adb");
    }

    async fn wait_for_boot_complete(&self, adb: &std::path::Path, serial: &str) -> Result<()> {
        // Poll sys.boot_completed and other signals.
        loop {
            let output = Command::new(adb)
                .args(["-s", serial, "shell", "getprop", "sys.boot_completed"])
                .output()
                .await?;

            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();

            if output.status.success() && value == "1" {
                // Also check dev.bootcomplete for older devices
                let output2 = Command::new(adb)
                    .args(["-s", serial, "shell", "getprop", "dev.bootcomplete"])
                    .output()
                    .await?;

                let value2 = String::from_utf8_lossy(&output2.stdout).trim().to_string();

                // Additional readiness signal: boot animation has stopped.
                // Some images report sys.boot_completed but still aren't interactive yet.
                let bootanim_out = Command::new(adb)
                    .args(["-s", serial, "shell", "getprop", "init.svc.bootanim"])
                    .output()
                    .await
                    .ok();
                let bootanim = bootanim_out
                    .as_ref()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_default();

                // Extra check: ensure package manager is responsive.
                // This avoids rare cases where sys.boot_completed flips early but `pm` isn't ready.
                let pm_ok = Command::new(adb)
                    .args(["-s", serial, "shell", "pm", "path", "android"])
                    .output()
                    .await
                    .map(|o| o.status.success() && !o.stdout.is_empty())
                    .unwrap_or(false);

                if (value2 == "1" || value2.is_empty())
                    && (bootanim.is_empty() || bootanim == "stopped")
                    && pm_ok
                {
                    return Ok(());
                }
            } else if !output.status.success() {
                // If adb is still settling, stderr often contains helpful hints like "device offline".
                // Don't fail the boot for that; just keep polling until the overall timeout.
                let _ = err;
            }

            tokio::time::sleep(Duration::from_millis(BOOT_POLL_INTERVAL_MS)).await;
        }
    }
}
