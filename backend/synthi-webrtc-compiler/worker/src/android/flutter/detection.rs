// ============================================================
// FLUTTER PROJECT DETECTION
// ============================================================
// Detects Flutter projects by analyzing pubspec.yaml and project structure.
// ============================================================

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Information about a detected Flutter project
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlutterProjectInfo {
    pub is_flutter_project: bool,
    pub pubspec_path: Option<String>,
    pub project_name: Option<String>,
    pub app_id: Option<String>,
    pub flutter_version: Option<String>,
    pub min_sdk_version: Option<u32>,
    pub target_sdk_version: Option<u32>,
    pub uses_kotlin: bool,
    pub uses_swift: bool,
    pub has_android_module: bool,
    pub has_ios_module: bool,
}

impl Default for FlutterProjectInfo {
    fn default() -> Self {
        Self {
            is_flutter_project: false,
            pubspec_path: None,
            project_name: None,
            app_id: None,
            flutter_version: None,
            min_sdk_version: None,
            target_sdk_version: None,
            uses_kotlin: false,
            uses_swift: false,
            has_android_module: false,
            has_ios_module: false,
        }
    }
}

/// Represents a pubspec.yaml file
#[derive(Debug, Deserialize)]
struct PubspecYaml {
    name: Option<String>,
    version: Option<String>,
    environment: Option<PubspecEnvironment>,
    dependencies: Option<serde_yaml::Value>,
    dev_dependencies: Option<serde_yaml::Value>,
    flutter: Option<serde_yaml::Value>,
}

#[derive(Debug, Deserialize)]
struct PubspecEnvironment {
    sdk: Option<String>,
    flutter: Option<String>,
}

/// Detects if a directory contains a Flutter project
pub async fn detect_flutter_project(project_root: &Path) -> Result<FlutterProjectInfo> {
    let pubspec_path = project_root.join("pubspec.yaml");

    if !pubspec_path.exists() {
        return Ok(FlutterProjectInfo::default());
    }

    // Read and parse pubspec.yaml
    let pubspec_content = tokio::fs::read_to_string(&pubspec_path)
        .await
        .context("Failed to read pubspec.yaml")?;

    let pubspec: PubspecYaml = serde_yaml::from_str(&pubspec_content)
        .context("Failed to parse pubspec.yaml")?;

    // Check for flutter dependency (indicates it's a Flutter project)
    let is_flutter = pubspec.flutter.is_some() || 
        pubspec.dependencies.as_ref().map(|deps| {
            if let serde_yaml::Value::Mapping(map) = deps {
                map.contains_key(&serde_yaml::Value::String("flutter".to_string()))
            } else {
                false
            }
        }).unwrap_or(false);

    if !is_flutter {
        return Ok(FlutterProjectInfo {
            is_flutter_project: false,
            pubspec_path: Some(pubspec_path.to_string_lossy().to_string()),
            project_name: pubspec.name.clone(),
            ..Default::default()
        });
    }

    // Check for Android platform
    let android_dir = project_root.join("android");
    let has_android = android_dir.exists() && android_dir.join("build.gradle").exists()
        || android_dir.join("build.gradle.kts").exists();

    // Check for iOS platform
    let ios_dir = project_root.join("ios");
    let has_ios = ios_dir.exists();

    // Detect if using Kotlin for Android
    let uses_kotlin = if has_android {
        detect_kotlin_usage(&android_dir).await
    } else {
        false
    };

    // Detect if using Swift for iOS
    let uses_swift = if has_ios {
        detect_swift_usage(&ios_dir).await
    } else {
        false
    };

    // Extract Flutter SDK version constraint
    let flutter_version = pubspec.environment
        .as_ref()
        .and_then(|env| env.flutter.clone());

    // Extract app ID from Android manifest or build.gradle
    let app_id = if has_android {
        extract_android_app_id(&android_dir).await.ok()
    } else {
        None
    };

    // Extract min/target SDK from build.gradle
    let (min_sdk, target_sdk) = if has_android {
        extract_android_sdk_versions(&android_dir).await.unwrap_or((None, None))
    } else {
        (None, None)
    };

    Ok(FlutterProjectInfo {
        is_flutter_project: true,
        pubspec_path: Some(pubspec_path.to_string_lossy().to_string()),
        project_name: pubspec.name,
        app_id,
        flutter_version,
        min_sdk_version: min_sdk,
        target_sdk_version: target_sdk,
        uses_kotlin,
        uses_swift,
        has_android_module: has_android,
        has_ios_module: has_ios,
    })
}

/// Checks if the Android module uses Kotlin
async fn detect_kotlin_usage(android_dir: &Path) -> bool {
    // Check for .kt files in the source directory
    let kotlin_src = android_dir.join("app/src/main/kotlin");
    if kotlin_src.exists() {
        return true;
    }

    // Check build.gradle for kotlin plugin
    let build_gradle = android_dir.join("app/build.gradle");
    if build_gradle.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&build_gradle).await {
            if content.contains("kotlin-android") || content.contains("org.jetbrains.kotlin") {
                return true;
            }
        }
    }

    // Check build.gradle.kts
    let build_gradle_kts = android_dir.join("app/build.gradle.kts");
    if build_gradle_kts.exists() {
        return true;
    }

    false
}

/// Checks if the iOS module uses Swift
async fn detect_swift_usage(ios_dir: &Path) -> bool {
    // Check for .swift files in Runner
    let runner_dir = ios_dir.join("Runner");
    if !runner_dir.exists() {
        return false;
    }

    // Check for AppDelegate.swift
    runner_dir.join("AppDelegate.swift").exists()
}

/// Extracts Android application ID from build.gradle or AndroidManifest.xml
async fn extract_android_app_id(android_dir: &Path) -> Result<String> {
    // Try app/build.gradle first
    let build_gradle = android_dir.join("app/build.gradle");
    if build_gradle.exists() {
        let content = tokio::fs::read_to_string(&build_gradle).await?;
        if let Some(app_id) = parse_application_id(&content) {
            return Ok(app_id);
        }
    }

    // Try app/build.gradle.kts
    let build_gradle_kts = android_dir.join("app/build.gradle.kts");
    if build_gradle_kts.exists() {
        let content = tokio::fs::read_to_string(&build_gradle_kts).await?;
        if let Some(app_id) = parse_application_id(&content) {
            return Ok(app_id);
        }
    }

    // Fall back to AndroidManifest.xml
    let manifest = android_dir.join("app/src/main/AndroidManifest.xml");
    if manifest.exists() {
        let content = tokio::fs::read_to_string(&manifest).await?;
        if let Some(app_id) = parse_manifest_package(&content) {
            return Ok(app_id);
        }
    }

    anyhow::bail!("Could not find application ID")
}

/// Parses applicationId from build.gradle content
fn parse_application_id(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        
        // Match: applicationId "com.example.app" or applicationId = "com.example.app"
        if trimmed.starts_with("applicationId") {
            let parts: Vec<&str> = trimmed.split('"').collect();
            if parts.len() >= 2 {
                return Some(parts[1].to_string());
            }
            let parts: Vec<&str> = trimmed.split('\'').collect();
            if parts.len() >= 2 {
                return Some(parts[1].to_string());
            }
        }

        // Match: namespace "com.example.app" (newer Flutter projects)
        if trimmed.starts_with("namespace") {
            let parts: Vec<&str> = trimmed.split('"').collect();
            if parts.len() >= 2 {
                return Some(parts[1].to_string());
            }
        }
    }
    None
}

/// Parses package name from AndroidManifest.xml
fn parse_manifest_package(content: &str) -> Option<String> {
    // Look for package="com.example.app"
    let package_pattern = r#"package\s*=\s*["']([^"']+)["']"#;
    if let Ok(re) = regex::Regex::new(package_pattern) {
        if let Some(caps) = re.captures(content) {
            return caps.get(1).map(|m| m.as_str().to_string());
        }
    }
    None
}

/// Extracts minSdkVersion and targetSdkVersion from build.gradle
async fn extract_android_sdk_versions(android_dir: &Path) -> Result<(Option<u32>, Option<u32>)> {
    let build_gradle = android_dir.join("app/build.gradle");
    let content = if build_gradle.exists() {
        tokio::fs::read_to_string(&build_gradle).await?
    } else {
        let kts = android_dir.join("app/build.gradle.kts");
        tokio::fs::read_to_string(&kts).await?
    };

    let mut min_sdk: Option<u32> = None;
    let mut target_sdk: Option<u32> = None;

    for line in content.lines() {
        let trimmed = line.trim();

        // Match: minSdkVersion 21 or minSdk = 21 or minSdk 21
        if trimmed.starts_with("minSdkVersion") || trimmed.starts_with("minSdk") {
            if let Some(num) = extract_number_from_line(trimmed) {
                min_sdk = Some(num);
            }
        }

        // Match: targetSdkVersion 34 or targetSdk = 34 or targetSdk 34
        if trimmed.starts_with("targetSdkVersion") || trimmed.starts_with("targetSdk") {
            if let Some(num) = extract_number_from_line(trimmed) {
                target_sdk = Some(num);
            }
        }
    }

    Ok((min_sdk, target_sdk))
}

/// Extracts a number from a line like "minSdkVersion 21" or "minSdk = 21"
fn extract_number_from_line(line: &str) -> Option<u32> {
    // Find all digits at the end or after = sign
    for word in line.split_whitespace().rev() {
        if let Ok(num) = word.parse::<u32>() {
            return Some(num);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_application_id() {
        assert_eq!(
            parse_application_id(r#"applicationId "com.example.myapp""#),
            Some("com.example.myapp".to_string())
        );
        assert_eq!(
            parse_application_id(r#"applicationId = "com.example.myapp""#),
            Some("com.example.myapp".to_string())
        );
        assert_eq!(
            parse_application_id(r#"namespace "com.example.myapp""#),
            Some("com.example.myapp".to_string())
        );
    }

    #[test]
    fn test_extract_number_from_line() {
        assert_eq!(extract_number_from_line("minSdkVersion 21"), Some(21));
        assert_eq!(extract_number_from_line("minSdk = 21"), Some(21));
        assert_eq!(extract_number_from_line("targetSdkVersion 34"), Some(34));
    }
}
