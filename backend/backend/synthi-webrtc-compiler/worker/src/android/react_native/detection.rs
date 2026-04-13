use anyhow::{bail, Context, Result};
use std::path::Path;

use super::common::PackageJson;
use crate::android::routing::ReactNativeProjectInfo;

/// Detects if a directory contains a React Native project
pub async fn detect_react_native_project(project_root: &Path) -> Result<ReactNativeProjectInfo> {
    let package_json_path = project_root.join("package.json");

    if !package_json_path.exists() {
        return Ok(ReactNativeProjectInfo {
            is_react_native_project: false,
            package_json_path: None,
            app_name: None,
            app_id: None,
            react_native_version: None,
            min_sdk_version: None,
        });
    }

    // Read and parse package.json
    let package_content = tokio::fs::read_to_string(&package_json_path)
        .await
        .context("Failed to read package.json")?;

    let package: PackageJson =
        serde_json::from_str(&package_content).context("Failed to parse package.json")?;

    // Check for react-native dependency
    let rn_version = package
        .dependencies
        .as_ref()
        .and_then(|deps| deps.get("react-native"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            package
                .dev_dependencies
                .as_ref()
                .and_then(|deps| deps.get("react-native"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

    let is_rn = rn_version.is_some();

    if !is_rn {
        return Ok(ReactNativeProjectInfo {
            is_react_native_project: false,
            package_json_path: Some(package_json_path.to_string_lossy().to_string()),
            app_name: package.name.clone(),
            app_id: None,
            react_native_version: None,
            min_sdk_version: None,
        });
    }

    // Check Android platform support
    let android_dir = project_root.join("android");
    if !android_dir.exists() {
        return Ok(ReactNativeProjectInfo {
            is_react_native_project: true,
            package_json_path: Some(package_json_path.to_string_lossy().to_string()),
            app_name: package.name.clone(),
            app_id: None,
            react_native_version: rn_version,
            min_sdk_version: None,
        });
    }

    // Try to extract app ID from build.gradle
    let app_id = extract_android_app_id(&android_dir).await.ok();
    let min_sdk = extract_android_min_sdk(&android_dir).await.ok().flatten();

    Ok(ReactNativeProjectInfo {
        is_react_native_project: true,
        package_json_path: Some(package_json_path.to_string_lossy().to_string()),
        app_name: package.name,
        app_id,
        react_native_version: rn_version,
        min_sdk_version: min_sdk,
    })
}

/// Extracts Android application ID from build.gradle
pub(crate) async fn extract_android_app_id(android_dir: &Path) -> Result<String> {
    // Try app/build.gradle first (standard location)
    let build_gradle = android_dir.join("app/build.gradle");
    let content = if build_gradle.exists() {
        tokio::fs::read_to_string(&build_gradle).await?
    } else {
        // Try build.gradle.kts for Kotlin DSL
        let kts_path = android_dir.join("app/build.gradle.kts");
        tokio::fs::read_to_string(&kts_path).await?
    };

    // Look for applicationId "com.example.app" or namespace "com.example.app"
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("applicationId") || trimmed.starts_with("namespace") {
            // Handle both: applicationId "com.app" and applicationId = "com.app"
            if let Some(start) = trimmed.find('"') {
                if let Some(end) = trimmed[start + 1..].find('"') {
                    return Ok(trimmed[start + 1..start + 1 + end].to_string());
                }
            }
        }
    }

    bail!("applicationId not found in build.gradle")
}

/// Extracts minSdkVersion from build.gradle
pub(crate) async fn extract_android_min_sdk(android_dir: &Path) -> Result<Option<u32>> {
    let build_gradle = android_dir.join("app/build.gradle");
    let content = if build_gradle.exists() {
        tokio::fs::read_to_string(&build_gradle).await?
    } else {
        let kts_path = android_dir.join("app/build.gradle.kts");
        tokio::fs::read_to_string(&kts_path).await?
    };

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.contains("minSdk") {
            // minSdkVersion 21 or minSdk = 21 or minSdkVersion = 21
            let parts: Vec<&str> = trimmed.split(|c: char| !c.is_numeric()).collect();
            for part in parts {
                if let Ok(v) = part.parse::<u32>() {
                    if v >= 16 && v <= 35 {
                        // Reasonable SDK range
                        return Ok(Some(v));
                    }
                }
            }
        }
    }

    Ok(None)
}
