// ============================================================
// NATIVE ANDROID PROJECT DETECTION
// ============================================================
// Detects native Android projects (Java and Kotlin) and extracts
// project metadata including build configuration and dependencies.
// ============================================================

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::fs;

use super::manifest_parser::{parse_android_manifest, AndroidManifestInfo};

// ============================================================
// TYPES
// ============================================================

/// Type of Android project
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AndroidProjectType {
    /// Pure Java Android project
    Java,
    /// Kotlin Android project
    Kotlin,
    /// Mixed Java/Kotlin project
    Mixed,
    /// Unknown or undetermined
    Unknown,
}

impl Default for AndroidProjectType {
    fn default() -> Self {
        Self::Unknown
    }
}

/// Detailed information about a native Android project
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NativeAndroidProjectInfo {
    /// Whether this is a valid native Android project
    pub is_native_android_project: bool,

    /// Project type (Java, Kotlin, or Mixed)
    pub project_type: AndroidProjectType,

    /// Path to the project root
    pub project_root: Option<String>,

    /// Path to the app module (usually "app")
    pub app_module_path: Option<String>,

    /// Application ID (package name from build.gradle)
    pub application_id: Option<String>,

    /// Package name from AndroidManifest.xml
    pub manifest_package: Option<String>,

    /// Parsed AndroidManifest information
    pub manifest_info: Option<AndroidManifestInfo>,

    /// minSdkVersion
    pub min_sdk_version: Option<u32>,

    /// targetSdkVersion
    pub target_sdk_version: Option<u32>,

    /// compileSdkVersion
    pub compile_sdk_version: Option<u32>,

    /// Gradle version
    pub gradle_version: Option<String>,

    /// Android Gradle Plugin version
    pub agp_version: Option<String>,

    /// Kotlin version (if Kotlin project)
    pub kotlin_version: Option<String>,

    /// List of build variants (e.g., ["debug", "release"])
    pub build_variants: Vec<String>,

    /// List of product flavors
    pub product_flavors: Vec<String>,

    /// Whether the project uses Jetpack Compose
    pub uses_compose: bool,

    /// Whether the project uses View Binding
    pub uses_view_binding: bool,

    /// Whether the project uses Data Binding
    pub uses_data_binding: bool,
}

// ============================================================
// DETECTION LOGIC
// ============================================================

/// Detects if a directory contains a native Android project
pub async fn detect_native_android_project(project_root: &Path) -> Result<NativeAndroidProjectInfo> {
    let mut info = NativeAndroidProjectInfo {
        project_root: Some(project_root.to_string_lossy().to_string()),
        ..Default::default()
    };

    // Check for essential Android project files
    let settings_gradle = project_root.join("settings.gradle");
    let settings_gradle_kts = project_root.join("settings.gradle.kts");
    let root_build_gradle = project_root.join("build.gradle");
    let root_build_gradle_kts = project_root.join("build.gradle.kts");

    // Must have either settings.gradle or settings.gradle.kts
    let has_settings = settings_gradle.exists() || settings_gradle_kts.exists();
    let has_root_build = root_build_gradle.exists() || root_build_gradle_kts.exists();

    if !has_settings && !has_root_build {
        return Ok(info);
    }

    // Look for app module
    let app_dir = project_root.join("app");
    if !app_dir.exists() {
        // Try to find the main module from settings.gradle
        if let Some(module) = find_main_module(project_root).await {
            info.app_module_path = Some(module);
        } else {
            return Ok(info);
        }
    } else {
        info.app_module_path = Some("app".to_string());
    }

    let app_module = project_root.join(info.app_module_path.as_ref().unwrap());
    let app_build_gradle = app_module.join("build.gradle");
    let app_build_gradle_kts = app_module.join("build.gradle.kts");

    // Must have app/build.gradle or app/build.gradle.kts
    if !app_build_gradle.exists() && !app_build_gradle_kts.exists() {
        return Ok(info);
    }

    // Parse AndroidManifest.xml
    let manifest_path = app_module.join("src/main/AndroidManifest.xml");
    if manifest_path.exists() {
        if let Ok(manifest_info) = parse_android_manifest(&manifest_path).await {
            info.manifest_package = manifest_info.package.clone();
            info.manifest_info = Some(manifest_info);
        }
    }

    // Parse build.gradle to extract configuration
    let build_gradle_path = if app_build_gradle_kts.exists() {
        &app_build_gradle_kts
    } else {
        &app_build_gradle
    };

    if let Ok(content) = fs::read_to_string(build_gradle_path).await {
        parse_build_gradle_content(&content, &mut info);
    }

    // Parse root build.gradle for AGP and Kotlin versions
    let root_build_path = if root_build_gradle_kts.exists() {
        &root_build_gradle_kts
    } else {
        &root_build_gradle
    };

    if let Ok(content) = fs::read_to_string(root_build_path).await {
        parse_root_build_gradle(&content, &mut info);
    }

    // Detect project type (Java/Kotlin/Mixed)
    info.project_type = detect_project_language(&app_module).await;

    // If we have application ID or manifest package, this is a valid project
    info.is_native_android_project = info.application_id.is_some() || info.manifest_package.is_some();

    // Exclude React Native and Flutter projects
    if is_react_native_project(project_root).await || is_flutter_project(project_root).await {
        info.is_native_android_project = false;
        return Ok(info);
    }

    // Default build variants
    if info.build_variants.is_empty() {
        info.build_variants = vec!["debug".to_string(), "release".to_string()];
    }

    Ok(info)
}

/// Finds the main module from settings.gradle
async fn find_main_module(project_root: &Path) -> Option<String> {
    let settings_path = if project_root.join("settings.gradle.kts").exists() {
        project_root.join("settings.gradle.kts")
    } else {
        project_root.join("settings.gradle")
    };

    let content = fs::read_to_string(&settings_path).await.ok()?;

    // Parse include statements: include ':app' or include(":app")
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("include") {
            // Extract module names
            if let Some(start) = trimmed.find('\'').or_else(|| trimmed.find('"')) {
                let rest = &trimmed[start + 1..];
                if let Some(end) = rest.find('\'').or_else(|| rest.find('"')) {
                    let module = rest[..end].trim_start_matches(':');
                    // Return the first module (usually the main one)
                    return Some(module.to_string());
                }
            }
        }
    }

    None
}

/// Parses app/build.gradle content
fn parse_build_gradle_content(content: &str, info: &mut NativeAndroidProjectInfo) {
    for line in content.lines() {
        let trimmed = line.trim();

        // Application ID
        if trimmed.starts_with("applicationId") || trimmed.starts_with("namespace") {
            if let Some(id) = extract_string_value(trimmed) {
                info.application_id = Some(id);
            }
        }

        // SDK versions
        if trimmed.contains("minSdk") {
            if let Some(v) = extract_numeric_value(trimmed) {
                info.min_sdk_version = Some(v);
            }
        }
        if trimmed.contains("targetSdk") {
            if let Some(v) = extract_numeric_value(trimmed) {
                info.target_sdk_version = Some(v);
            }
        }
        if trimmed.contains("compileSdk") {
            if let Some(v) = extract_numeric_value(trimmed) {
                info.compile_sdk_version = Some(v);
            }
        }

        // Feature flags
        if trimmed.contains("viewBinding") && trimmed.contains("true") {
            info.uses_view_binding = true;
        }
        if trimmed.contains("dataBinding") && trimmed.contains("true") {
            info.uses_data_binding = true;
        }
        if trimmed.contains("compose") && trimmed.contains("true") {
            info.uses_compose = true;
        }

        // Product flavors
        if trimmed.starts_with("flavorDimensions") || trimmed.contains("productFlavors") {
            // Basic detection - would need more sophisticated parsing
        }
    }
}

/// Parses root build.gradle for plugin versions
fn parse_root_build_gradle(content: &str, info: &mut NativeAndroidProjectInfo) {
    for line in content.lines() {
        let trimmed = line.trim();

        // Android Gradle Plugin version
        if trimmed.contains("com.android.tools.build:gradle:") {
            if let Some(version) = extract_version_from_dependency(trimmed) {
                info.agp_version = Some(version);
            }
        }
        if trimmed.contains("com.android.application") && trimmed.contains("version") {
            if let Some(version) = extract_string_value(trimmed) {
                info.agp_version = Some(version);
            }
        }

        // Kotlin version
        if trimmed.contains("kotlin") && (trimmed.contains("version") || trimmed.contains(":")) {
            if let Some(version) = extract_kotlin_version(trimmed) {
                info.kotlin_version = Some(version);
            }
        }
    }
}

/// Detects the primary language of the project
async fn detect_project_language(app_module: &Path) -> AndroidProjectType {
    let java_dir = app_module.join("src/main/java");
    let kotlin_dir = app_module.join("src/main/kotlin");

    let has_java = has_source_files(&java_dir, "java").await;
    let has_kotlin = has_source_files(&kotlin_dir, "kt").await
        || has_source_files(&java_dir, "kt").await; // Kotlin can also be in java/ dir

    match (has_java, has_kotlin) {
        (true, true) => AndroidProjectType::Mixed,
        (true, false) => AndroidProjectType::Java,
        (false, true) => AndroidProjectType::Kotlin,
        (false, false) => AndroidProjectType::Unknown,
    }
}

/// Checks if a directory contains source files with the given extension
async fn has_source_files(dir: &Path, extension: &str) -> bool {
    if !dir.exists() {
        return false;
    }

    async fn check_recursive(dir: &Path, ext: &str) -> bool {
        let mut entries = match fs::read_dir(dir).await {
            Ok(e) => e,
            Err(_) => return false,
        };

        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.is_dir() {
                if Box::pin(check_recursive(&path, ext)).await {
                    return true;
                }
            } else if path.extension().map(|e| e == ext).unwrap_or(false) {
                return true;
            }
        }
        false
    }

    check_recursive(dir, extension).await
}

/// Checks if this is a React Native project
async fn is_react_native_project(project_root: &Path) -> bool {
    let package_json = project_root.join("package.json");
    if !package_json.exists() {
        return false;
    }

    if let Ok(content) = fs::read_to_string(&package_json).await {
        return content.contains("react-native");
    }
    false
}

/// Checks if this is a Flutter project
async fn is_flutter_project(project_root: &Path) -> bool {
    let pubspec = project_root.join("pubspec.yaml");
    pubspec.exists()
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

fn extract_string_value(line: &str) -> Option<String> {
    // Handle: applicationId "com.example" or applicationId = "com.example"
    let start = line.find('"').or_else(|| line.find('\''))?;
    let rest = &line[start + 1..];
    let end = rest.find('"').or_else(|| rest.find('\''))?;
    Some(rest[..end].to_string())
}

fn extract_numeric_value(line: &str) -> Option<u32> {
    // Handle: minSdk 21 or minSdk = 21 or minSdkVersion 21
    for word in line.split_whitespace() {
        if let Ok(v) = word.trim_end_matches(|c: char| !c.is_numeric()).parse::<u32>() {
            if v >= 1 && v <= 99 {
                return Some(v);
            }
        }
    }
    None
}

fn extract_version_from_dependency(line: &str) -> Option<String> {
    // Handle: classpath 'com.android.tools.build:gradle:8.2.0'
    let start = line.rfind(':')?;
    let rest = &line[start + 1..];
    let end = rest.find('\'').or_else(|| rest.find('"'))?;
    Some(rest[..end].to_string())
}

fn extract_kotlin_version(line: &str) -> Option<String> {
    // Handle: kotlin("jvm") version "1.9.0" or ext.kotlin_version = '1.9.0'
    if let Some(v) = extract_string_value(line) {
        // Validate it looks like a version
        if v.chars().next().map(|c| c.is_numeric()).unwrap_or(false) {
            return Some(v);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_string_value() {
        assert_eq!(
            extract_string_value(r#"applicationId "com.example.app""#),
            Some("com.example.app".to_string())
        );
        assert_eq!(
            extract_string_value(r#"applicationId = "com.example.app""#),
            Some("com.example.app".to_string())
        );
    }

    #[test]
    fn test_extract_numeric_value() {
        assert_eq!(extract_numeric_value("minSdk 21"), Some(21));
        assert_eq!(extract_numeric_value("minSdkVersion = 24"), Some(24));
    }

    #[test]
    fn test_project_type_default() {
        assert_eq!(AndroidProjectType::default(), AndroidProjectType::Unknown);
    }
}
