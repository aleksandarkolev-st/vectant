use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::process::Command;

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
