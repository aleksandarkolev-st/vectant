use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

use super::types::{EmulatorConfig, EmulatorState, SessionCore};

/// Manages a single emulator session
pub struct EmulatorSession {
    pub(crate) core: SessionCore,
}

impl EmulatorSession {
    /// Creates a new emulator session with the given configuration
    pub fn new(config: EmulatorConfig) -> Self {
        let max_session = Duration::from_secs(config.max_session_secs);
        Self {
            core: SessionCore {
                config,
                state: Arc::new(Mutex::new(EmulatorState::Stopped)),
                emulator_process: Arc::new(Mutex::new(None)),
                xvfb_process: Arc::new(Mutex::new(None)),
                x11_display: Arc::new(Mutex::new(String::new())),
                serial: Arc::new(Mutex::new(None)),
                shutdown_tx: None,
                logcat_process: Arc::new(Mutex::new(None)),
                started_at: None,
                max_session,
            },
        }
    }

    /// Creates a session with default configuration
    pub fn with_defaults() -> Self {
        Self::new(EmulatorConfig::default())
    }

    /// Returns current emulator state
    pub async fn state(&self) -> EmulatorState {
        *self.core.state.lock().await
    }

    /// Returns the emulator serial (e.g., "emulator-5554")
    pub async fn serial(&self) -> Option<String> {
        self.core.serial.lock().await.clone()
    }

    /// Checks if session has exceeded maximum duration
    pub fn is_expired(&self) -> bool {
        if let Some(started) = self.core.started_at {
            started.elapsed() > self.core.max_session
        } else {
            false
        }
    }

    /// Force terminates everything (for crash recovery)
    pub async fn force_terminate(&mut self) {
        use tokio::process::Command;

        // Kill logcat
        if let Some(mut child) = self.core.logcat_process.lock().await.take() {
            let _ = child.kill().await;
        }

        // Kill emulator
        if let Some(mut child) = self.core.emulator_process.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }

        // Also kill any stray emulator processes
        let _ = Command::new("pkill")
            .args(["-9", "-f", &format!("-avd {}", self.core.config.avd_name)])
            .output()
            .await;

        *self.core.state.lock().await = EmulatorState::Stopped;
    }
}

impl Drop for EmulatorSession {
    fn drop(&mut self) {
        // Ensure cleanup runs (spawn blocking task)
        // Note: In production, use explicit shutdown() instead
    }
}
