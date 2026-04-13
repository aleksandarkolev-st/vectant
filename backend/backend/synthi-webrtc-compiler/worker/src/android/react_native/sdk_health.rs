use anyhow::Result;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use crate::android;
use crate::android::routing::AndroidSdkHealth;

/// Checks Android SDK and emulator toolchain health for React Native
pub async fn check_android_sdk() -> Result<AndroidSdkHealth> {
    // Tests run under the Rust test harness, not our `main()`, so make sure the
    // Android SDK env is still bootstrapped when this check is called.
    android::ensure_android_sdk_env();

    fn first_existing_path(candidates: &[PathBuf]) -> Option<PathBuf> {
        candidates.iter().find(|p| p.exists()).cloned()
    }

    fn resolve_sdk_root() -> Option<PathBuf> {
        if let Ok(v) = std::env::var("ANDROID_SDK_ROOT") {
            if !v.trim().is_empty() {
                return Some(PathBuf::from(v));
            }
        }
        if let Ok(v) = std::env::var("ANDROID_HOME") {
            if !v.trim().is_empty() {
                return Some(PathBuf::from(v));
            }
        }

        // Common default for our Linux workers
        let default = PathBuf::from("/opt/android-sdk");
        if default.exists() {
            Some(default)
        } else {
            None
        }
    }

    fn resolve_android_tool(sdk_root: &Path, tool: &str) -> Option<PathBuf> {
        // Prefer absolute SDK paths over relying on PATH.
        // Also consider Windows wrappers for cmdline-tools.
        let candidates: Vec<PathBuf> = match tool {
            "adb" => vec![
                sdk_root.join("platform-tools/adb"),
                sdk_root.join("platform-tools/adb.exe"),
            ],
            "emulator" => vec![
                sdk_root.join("emulator/emulator"),
                sdk_root.join("emulator/emulator.exe"),
            ],
            "avdmanager" => vec![
                sdk_root.join("cmdline-tools/latest/bin/avdmanager"),
                sdk_root.join("cmdline-tools/latest/bin/avdmanager.bat"),
                sdk_root.join("cmdline-tools/latest/bin/avdmanager.cmd"),
                sdk_root.join("cmdline-tools/bin/avdmanager"),
                sdk_root.join("cmdline-tools/bin/avdmanager.bat"),
                sdk_root.join("cmdline-tools/bin/avdmanager.cmd"),
                sdk_root.join("tools/bin/avdmanager"),
                sdk_root.join("tools/bin/avdmanager.bat"),
                sdk_root.join("tools/bin/avdmanager.cmd"),
            ],
            "sdkmanager" => vec![
                sdk_root.join("cmdline-tools/latest/bin/sdkmanager"),
                sdk_root.join("cmdline-tools/latest/bin/sdkmanager.bat"),
                sdk_root.join("cmdline-tools/latest/bin/sdkmanager.cmd"),
                sdk_root.join("cmdline-tools/bin/sdkmanager"),
                sdk_root.join("cmdline-tools/bin/sdkmanager.bat"),
                sdk_root.join("cmdline-tools/bin/sdkmanager.cmd"),
                sdk_root.join("tools/bin/sdkmanager"),
                sdk_root.join("tools/bin/sdkmanager.bat"),
                sdk_root.join("tools/bin/sdkmanager.cmd"),
            ],
            _ => vec![],
        };

        first_existing_path(&candidates)
    }

    async fn command_success_path(program: &Path, args: &[&str]) -> bool {
        Command::new(program)
            .args(args)
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn command_success_name(program: &str, args: &[&str]) -> bool {
        Command::new(program)
            .args(args)
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn list_system_images_via_sdkmanager(sdkmanager: &Path) -> Result<Vec<String>> {
        let output = Command::new(sdkmanager)
            .arg("--list_installed")
            .output()
            .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut images = vec![];
        for line in stdout.lines() {
            if line.contains("system-images;") {
                let trimmed = line.trim();
                if let Some(img) = trimmed.split_whitespace().next() {
                    images.push(img.to_string());
                }
            }
        }
        Ok(images)
    }

    async fn list_avds_via_emulator(emulator: &Path) -> Result<Vec<String>> {
        let output = Command::new(emulator).arg("-list-avds").output().await?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect())
    }

    let sdk_root = resolve_sdk_root();
    let sdk_path = sdk_root.as_ref().map(|p| p.to_string_lossy().to_string());

    let mut issues = vec![];

    // Check node/npm (required for React Native)
    let node_ok = command_success_name("node", &["--version"]).await;

    if !node_ok {
        issues.push("Node.js not found - required for React Native".to_string());
    }

    // Check npx (for running react-native CLI)
    let npx_ok = command_success_name("npx", &["--version"]).await;

    if !npx_ok {
        issues.push("npx not found - required for React Native CLI".to_string());
    }

    // Resolve Android tools from SDK root if possible (avoid PATH dependency)
    let adb_path = sdk_root
        .as_ref()
        .and_then(|r| resolve_android_tool(r, "adb"));
    let emulator_path = sdk_root
        .as_ref()
        .and_then(|r| resolve_android_tool(r, "emulator"));
    let avdmanager_path = sdk_root
        .as_ref()
        .and_then(|r| resolve_android_tool(r, "avdmanager"));
    let sdkmanager_path = sdk_root
        .as_ref()
        .and_then(|r| resolve_android_tool(r, "sdkmanager"));

    // Check adb
    let adb_ok = if let Some(ref p) = adb_path {
        command_success_path(p, &["version"]).await
    } else {
        command_success_name("adb", &["version"]).await
    };

    if !adb_ok {
        issues.push("adb not found - install Android platform-tools".to_string());
    }

    // Check emulator
    let emulator_ok = if let Some(ref p) = emulator_path {
        command_success_path(p, &["-version"]).await
    } else {
        command_success_name("emulator", &["-version"]).await
    };

    if !emulator_ok {
        issues.push("Android emulator not found".to_string());
    }

    // Check avdmanager
    let avdmanager_ok = if let Some(ref p) = avdmanager_path {
        command_success_path(p, &["list", "avd"]).await
    } else {
        command_success_name("avdmanager", &["list", "avd"]).await
    };

    if !avdmanager_ok {
        issues.push("avdmanager not found - install Android cmdline-tools".to_string());
    }

    // Check Java (required for Gradle)
    let java_ok = command_success_name("java", &["-version"]).await;

    if !java_ok {
        issues.push("Java not found - required for Android builds".to_string());
    }

    // List system images (prefer sdkmanager from SDK root)
    let system_images = if let Some(ref p) = sdkmanager_path {
        list_system_images_via_sdkmanager(p)
            .await
            .unwrap_or_default()
    } else {
        vec![]
    };

    // List AVDs (prefer emulator from SDK root)
    let available_avds = if let Some(ref p) = emulator_path {
        list_avds_via_emulator(p).await.unwrap_or_default()
    } else {
        vec![]
    };

    if sdk_root.is_none() {
        issues.push(
            "Android SDK root not configured (set ANDROID_SDK_ROOT/ANDROID_HOME or mount /opt/android-sdk)"
                .to_string(),
        );
    }

    Ok(AndroidSdkHealth {
        sdk_path,
        node_ok,
        adb_ok,
        emulator_ok,
        avdmanager_ok,
        java_ok,
        system_images,
        available_avds,
        issues,
    })
}
