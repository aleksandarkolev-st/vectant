use anyhow::{Context, Result};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use super::session::EmulatorSession;
use super::types::{LogLevel, LogcatEntry};

impl EmulatorSession {
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

        let adb = self.core.config.android_sdk_root.join("platform-tools/adb");

        // Build logcat command
        let mut cmd = Command::new(&adb);
        cmd.args(["-s", &serial, "logcat", "-v", "threadtime"]);

        // Logcat can be extremely verbose; default to warnings+ to reduce noise.
        // Override with SYNTHI_ANDROID_LOGCAT_FILTER (e.g. "*:I" or "MyTag:D *:S").
        let filter = std::env::var("SYNTHI_ANDROID_LOGCAT_FILTER").unwrap_or_else(|_| "*:W".to_string());

        // Filter by package if specified
        if let Some(pkg) = package_name {
            // Get PID of the app
            if let Ok(pid) = self.get_app_pid(&adb, &serial, pkg).await {
                cmd.args(["--pid", &pid.to_string()]);
            }
        }

        cmd.arg(filter);

        cmd.stdout(Stdio::piped()).stderr(Stdio::null());

        let mut child = cmd.spawn().context("Failed to spawn logcat")?;
        let stdout = child.stdout.take().unwrap();

        // Store process handle
        *self.core.logcat_process.lock().await = Some(child);

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
        if let Some(mut child) = self.core.logcat_process.lock().await.take() {
            let _ = child.kill().await;
        }
        Ok(())
    }

    /// Gets the PID of a running app
    async fn get_app_pid(&self, adb: &std::path::Path, serial: &str, package: &str) -> Result<u32> {
        let output = Command::new(adb)
            .args(["-s", serial, "shell", "pidof", package])
            .output()
            .await?;

        let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let pid: u32 = pid_str.parse().context("Invalid PID")?;
        Ok(pid)
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
}
