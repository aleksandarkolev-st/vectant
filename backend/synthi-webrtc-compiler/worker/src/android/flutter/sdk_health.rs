// ============================================================
// FLUTTER SDK HEALTH CHECK
// ============================================================
// Validates Flutter SDK installation and toolchain readiness.
// ============================================================

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::process::Command;

/// Flutter SDK health status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlutterSdkHealth {
    pub flutter_available: bool,
    pub flutter_path: Option<PathBuf>,
    pub flutter_version: Option<String>,
    pub dart_version: Option<String>,
    pub android_sdk_available: bool,
    pub android_licenses_accepted: bool,
    pub java_available: bool,
    pub java_version: Option<String>,
    pub issues: Vec<String>,
}

impl Default for FlutterSdkHealth {
    fn default() -> Self {
        Self {
            flutter_available: false,
            flutter_path: None,
            flutter_version: None,
            dart_version: None,
            android_sdk_available: false,
            android_licenses_accepted: true,
            java_available: false,
            java_version: None,
            issues: vec![],
        }
    }
}

/// Checks Flutter SDK health and availability
pub async fn check_flutter_sdk() -> Result<FlutterSdkHealth> {
    let mut health = FlutterSdkHealth::default();

    // Check Flutter binary
    match find_flutter_binary().await {
        Ok((path, version)) => {
            health.flutter_available = true;
            health.flutter_path = Some(path);
            health.flutter_version = version;
        }
        Err(e) => {
            health.issues.push(format!("Flutter not found: {}", e));
        }
    }

    // Check Dart version
    if let Ok(dart_version) = get_dart_version().await {
        health.dart_version = Some(dart_version);
    }

    // Check Java
    match check_java().await {
        Ok(version) => {
            health.java_available = true;
            health.java_version = Some(version);
        }
        Err(e) => {
            health.issues.push(format!("Java not found: {}", e));
        }
    }

    // Check Android SDK
    if let Ok(sdk_path) = std::env::var("ANDROID_SDK_ROOT")
        .or_else(|_| std::env::var("ANDROID_HOME"))
    {
        let sdk = PathBuf::from(&sdk_path);
        if sdk.exists() {
            health.android_sdk_available = true;
        } else {
            health.issues.push(format!("Android SDK path does not exist: {}", sdk_path));
        }
    } else {
        health.issues.push("ANDROID_SDK_ROOT or ANDROID_HOME not set".to_string());
    }

    // Run flutter doctor to check for additional issues
    if health.flutter_available {
        if let Ok(doctor_issues) = run_flutter_doctor().await {
            for issue in doctor_issues {
                if !health.issues.contains(&issue) {
                    health.issues.push(issue);
                }
            }
        }
    }

    Ok(health)
}

/// Finds the Flutter binary and returns its path and version
async fn find_flutter_binary() -> Result<(PathBuf, Option<String>)> {
    // Check FLUTTER_ROOT first
    if let Ok(flutter_root) = std::env::var("FLUTTER_ROOT") {
        let flutter_bin = PathBuf::from(&flutter_root).join("bin/flutter");
        if flutter_bin.exists() {
            let version = get_flutter_version(&flutter_bin).await.ok();
            return Ok((flutter_bin, version));
        }
    }

    // Try PATH
    let output = Command::new("which")
        .arg("flutter")
        .output()
        .await
        .context("Failed to search for flutter in PATH")?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let flutter_bin = PathBuf::from(&path);
        let version = get_flutter_version(&flutter_bin).await.ok();
        return Ok((flutter_bin, version));
    }

    // Check common installation paths
    let common_paths = [
        "/opt/flutter/bin/flutter",
        "/usr/local/flutter/bin/flutter",
        "/home/worker/flutter/bin/flutter",
        "/home/sasho/flutter/bin/flutter",  // Common dev machine location
    ];

    for path_str in &common_paths {
        let path = PathBuf::from(path_str);
        if path.exists() {
            let version = get_flutter_version(&path).await.ok();
            return Ok((path, version));
        }
    }

    // Check home directory
    if let Ok(home) = std::env::var("HOME") {
        let home_flutter = PathBuf::from(home).join("flutter/bin/flutter");
        if home_flutter.exists() {
            let version = get_flutter_version(&home_flutter).await.ok();
            return Ok((home_flutter, version));
        }
    }

    // Check FLUTTER_HOME environment variable
    if let Ok(flutter_home) = std::env::var("FLUTTER_HOME") {
        let flutter_bin = PathBuf::from(&flutter_home).join("bin/flutter");
        if flutter_bin.exists() {
            let version = get_flutter_version(&flutter_bin).await.ok();
            return Ok((flutter_bin, version));
        }
    }

    // Scan /home/*/flutter as fallback for multi-user systems
    if let Ok(entries) = std::fs::read_dir("/home") {
        for entry in entries.flatten() {
            let flutter_path = entry.path().join("flutter/bin/flutter");
            if flutter_path.exists() {
                let version = get_flutter_version(&flutter_path).await.ok();
                return Ok((flutter_path, version));
            }
        }
    }

    anyhow::bail!("Flutter SDK not found in PATH or common locations")
}

/// Gets Flutter version string
async fn get_flutter_version(flutter_bin: &PathBuf) -> Result<String> {
    let output = Command::new(flutter_bin)
        .args(["--version", "--machine"])
        .output()
        .await
        .context("Failed to run flutter --version")?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Parse JSON output
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
            if let Some(version) = json.get("frameworkVersion").and_then(|v| v.as_str()) {
                return Ok(version.to_string());
            }
        }
        // Fall back to first line
        return Ok(stdout.lines().next().unwrap_or("unknown").to_string());
    }

    // Try without --machine flag
    let output = Command::new(flutter_bin)
        .arg("--version")
        .output()
        .await?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Parse "Flutter X.Y.Z" from output
    for line in stdout.lines() {
        if line.starts_with("Flutter") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                return Ok(parts[1].to_string());
            }
        }
    }

    Ok("unknown".to_string())
}

/// Gets Dart version
async fn get_dart_version() -> Result<String> {
    let output = Command::new("dart")
        .arg("--version")
        .output()
        .await
        .context("Failed to run dart --version")?;

    let output_str = String::from_utf8_lossy(&output.stderr);
    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let combined = format!("{}{}", output_str, stdout_str);

    // Parse "Dart SDK version: X.Y.Z"
    for line in combined.lines() {
        if line.contains("Dart") && line.contains("version") {
            // Extract version number
            let parts: Vec<&str> = line.split_whitespace().collect();
            for (i, part) in parts.iter().enumerate() {
                if *part == "version:" || *part == "version" {
                    if let Some(ver) = parts.get(i + 1) {
                        return Ok(ver.to_string());
                    }
                }
            }
            // Try to find version-like string
            for part in &parts {
                if part.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                    return Ok(part.to_string());
                }
            }
        }
    }

    Ok("unknown".to_string())
}

/// Checks Java availability and version
async fn check_java() -> Result<String> {
    let output = Command::new("java")
        .arg("-version")
        .output()
        .await
        .context("Failed to run java -version")?;

    // Java version is printed to stderr
    let stderr = String::from_utf8_lossy(&output.stderr);
    
    // Parse version from output like: openjdk version "17.0.1" or java version "1.8.0_xxx"
    for line in stderr.lines() {
        if line.contains("version") {
            let parts: Vec<&str> = line.split('"').collect();
            if parts.len() >= 2 {
                return Ok(parts[1].to_string());
            }
        }
    }

    if output.status.success() {
        Ok("unknown".to_string())
    } else {
        anyhow::bail!("Java not available")
    }
}

/// Runs flutter doctor and extracts issues
async fn run_flutter_doctor() -> Result<Vec<String>> {
    let output = Command::new("flutter")
        .args(["doctor", "--verbose"])
        .env("CI", "true") // Suppress interactive prompts
        .output()
        .await?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut issues = Vec::new();

    let mut in_issue_section = false;
    for line in stdout.lines() {
        let trimmed = line.trim();
        
        // Lines starting with [✗] or [!] indicate issues
        if trimmed.starts_with("[✗]") || trimmed.starts_with("[!]") || 
           trimmed.starts_with("[X]") || trimmed.starts_with("[x]") {
            in_issue_section = true;
            let issue = trimmed
                .trim_start_matches("[✗]")
                .trim_start_matches("[!]")
                .trim_start_matches("[X]")
                .trim_start_matches("[x]")
                .trim();
            if !issue.is_empty() {
                issues.push(issue.to_string());
            }
        } else if trimmed.starts_with("[✓]") || trimmed.starts_with("[√]") {
            in_issue_section = false;
        } else if in_issue_section && trimmed.starts_with("•") {
            // Sub-issue bullet point
            let sub_issue = trimmed.trim_start_matches("•").trim();
            if !sub_issue.is_empty() && sub_issue.len() > 10 {
                issues.push(format!("  - {}", sub_issue));
            }
        }
    }

    Ok(issues)
}
