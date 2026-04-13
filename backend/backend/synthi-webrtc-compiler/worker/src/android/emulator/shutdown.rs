use anyhow::Result;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

use super::session::EmulatorSession;
use super::types::EmulatorState;

impl EmulatorSession {
    // ============================================================
    // SHUTDOWN AND CLEANUP
    // ============================================================

    /// Gracefully shuts down the emulator
    pub async fn shutdown(&mut self) -> Result<()> {
        *self.core.state.lock().await = EmulatorState::ShuttingDown;

        // Stop logcat first
        self.stop_logcat().await?;

        // Try graceful shutdown via adb
        if let Some(serial) = self.serial().await {
            let adb = self.core.config.android_sdk_root.join("platform-tools/adb");

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

        // Stop Xvfb if we started it
        if let Some(mut xvfb) = self.core.xvfb_process.lock().await.take() {
            let _ = xvfb.kill().await;
            let _ = xvfb.wait().await;
        }

        *self.core.state.lock().await = EmulatorState::Stopped;
        *self.core.serial.lock().await = None;

        Ok(())
    }

    /// Waits for emulator process to exit
    async fn wait_for_emulator_exit(&self) {
        if let Some(ref mut child) = *self.core.emulator_process.lock().await {
            let _ = child.wait().await;
        }
    }

    /// Force kills the emulator process
    async fn kill_emulator(&self) {
        if let Some(mut child) = self.core.emulator_process.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await; // Reap zombie
        }
    }
}
