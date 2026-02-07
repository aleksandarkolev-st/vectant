// ============================================================
// NATIVE ANDROID BUILD
// ============================================================
// APK build logic for native Android (Java/Kotlin) projects.
// Handles Gradle-based compilation, variant selection, and APK output.
// ============================================================

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::fs;

use super::detection::{detect_native_android_project, NativeAndroidProjectInfo};
use super::gradle_runner::{run_gradle_task, gradle_clean, GradleRunResult};
use super::manifest_parser::{parse_android_manifest, get_launcher_component};
use super::LogCallback;
use crate::android::routing::Diagnostic;

// ============================================================
// TYPES
// ============================================================

/// Build variant for native Android
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildVariant {
    #[default]
    Debug,
    Release,
}

impl BuildVariant {
    pub fn as_str(&self) -> &'static str {
        match self {
            BuildVariant::Debug => "debug",
            BuildVariant::Release => "release",
        }
    }

    pub fn gradle_task(&self) -> &'static str {
        match self {
            BuildVariant::Debug => "assembleDebug",
            BuildVariant::Release => "assembleRelease",
        }
    }

    pub fn apk_dir_name(&self) -> &'static str {
        match self {
            BuildVariant::Debug => "debug",
            BuildVariant::Release => "release",
        }
    }

    pub fn apk_suffix(&self) -> &'static str {
        match self {
            BuildVariant::Debug => "-debug",
            BuildVariant::Release => "-release",
        }
    }
}

/// Configuration for native Android build
#[derive(Debug, Clone)]
pub struct BuildConfig {
    /// Path to the project root
    pub project_root: PathBuf,

    /// Build variant (debug/release)
    pub variant: BuildVariant,

    /// Optional product flavor (e.g., "free", "paid")
    pub flavor: Option<String>,

    /// Extra Gradle arguments
    pub extra_gradle_args: Vec<String>,

    /// Additional environment variables
    pub env: HashMap<String, String>,

    /// Whether to clean before building
    pub clean_before_build: bool,

    /// Build timeout in seconds (default: 25 minutes)
    pub timeout_secs: Option<u64>,
}

impl Default for BuildConfig {
    fn default() -> Self {
        Self {
            project_root: PathBuf::new(),
            variant: BuildVariant::Debug,
            flavor: None,
            extra_gradle_args: Vec::new(),
            env: HashMap::new(),
            clean_before_build: false,
            timeout_secs: None,
        }
    }
}

/// Result of a native Android build
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildResult {
    /// Whether the build succeeded
    pub success: bool,

    /// Path to the generated APK (if successful)
    pub apk_path: Option<PathBuf>,

    /// Application ID (package name)
    pub application_id: Option<String>,

    /// Launcher component (package/activity)
    pub launcher_component: Option<String>,

    /// Build duration in milliseconds
    pub build_duration_ms: u64,

    /// List of diagnostics (errors and warnings)
    pub diagnostics: Vec<Diagnostic>,

    /// Gradle exit code
    pub exit_code: Option<i32>,

    /// Project information
    pub project_info: Option<NativeAndroidProjectInfo>,
}

// ============================================================
// BUILD LOGIC
// ============================================================

/// Builds a native Android APK
pub async fn build_native_android_apk(
    config: &BuildConfig,
    log_callback: Option<LogCallback>,
) -> Result<BuildResult> {
    let start = std::time::Instant::now();
    let log_cb = log_callback.as_ref();

    // Validate project exists
    if !config.project_root.exists() {
        bail!("Project root does not exist: {:?}", config.project_root);
    }

    // Detect project
    if let Some(cb) = log_cb {
        cb("Detecting project structure...".to_string());
    }

    let project_info = detect_native_android_project(&config.project_root).await?;
    if !project_info.is_native_android_project {
        bail!(
            "Not a native Android project: {:?}. Missing required Gradle files or AndroidManifest.xml",
            config.project_root
        );
    }

    let app_module = project_info
        .app_module_path
        .as_ref()
        .map(|m| config.project_root.join(m))
        .unwrap_or_else(|| config.project_root.join("app"));

    // Log project details
    if let Some(cb) = log_cb {
        cb(format!(
            "Project type: {:?}, App module: {}",
            project_info.project_type,
            app_module.display()
        ));
        if let Some(ref app_id) = project_info.application_id {
            cb(format!("Application ID: {}", app_id));
        }
        if let Some(ref kotlin_ver) = project_info.kotlin_version {
            cb(format!("Kotlin version: {}", kotlin_ver));
        }
    }

    // Clean if requested
    if config.clean_before_build {
        if let Some(cb) = log_cb {
            cb("Cleaning previous build...".to_string());
        }
        let clean_result = gradle_clean(&config.project_root, log_cb).await;
        if let Err(e) = clean_result {
            if let Some(cb) = log_cb {
                cb(format!("Clean failed (continuing anyway): {}", e));
            }
        }
    }

    // Determine Gradle task
    let task = build_gradle_task(&config.variant, config.flavor.as_deref());
    
    if let Some(cb) = log_cb {
        cb(format!("Running Gradle task: {}", task));
    }

    // Build extra args
    let mut extra_args: Vec<&str> = config
        .extra_gradle_args
        .iter()
        .map(|s| s.as_str())
        .collect();

    // Run Gradle build
    let gradle_result = run_gradle_task(
        &config.project_root,
        &[&task],
        &extra_args,
        &config.env,
        log_cb,
        config.timeout_secs,
    )
    .await?;

    // Find the APK
    let apk_path = if gradle_result.success {
        find_apk(&app_module, &config.variant, config.flavor.as_deref()).await
    } else {
        None
    };

    // Get launcher component
    let launcher_component = project_info
        .manifest_info
        .as_ref()
        .and_then(|m| get_launcher_component(m));

    // Resolve application ID
    let application_id = project_info.application_id.clone()
        .or_else(|| project_info.manifest_package.clone());

    if let Some(cb) = log_cb {
        if gradle_result.success {
            if let Some(ref apk) = apk_path {
                cb(format!("Build successful! APK: {}", apk.display()));
            } else {
                cb("Build completed but APK not found".to_string());
            }
        } else {
            cb(format!("Build failed with exit code: {:?}", gradle_result.exit_code));
        }
    }

    Ok(BuildResult {
        success: gradle_result.success && apk_path.is_some(),
        apk_path,
        application_id,
        launcher_component,
        build_duration_ms: start.elapsed().as_millis() as u64,
        diagnostics: gradle_result.diagnostics,
        exit_code: gradle_result.exit_code,
        project_info: Some(project_info),
    })
}

/// Cleans the Android build outputs
pub async fn clean_android_build(
    project_root: &Path,
    log_callback: Option<LogCallback>,
) -> Result<bool> {
    let result = gradle_clean(project_root, log_callback.as_ref()).await?;
    Ok(result.success)
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/// Builds the Gradle task name based on variant and flavor
fn build_gradle_task(variant: &BuildVariant, flavor: Option<&str>) -> String {
    match flavor {
        Some(f) => {
            // Capitalize first letter of flavor and variant
            let flavor_cap = capitalize_first(f);
            let variant_cap = capitalize_first(variant.as_str());
            format!("assemble{}{}", flavor_cap, variant_cap)
        }
        None => variant.gradle_task().to_string(),
    }
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().chain(chars).collect(),
    }
}

/// Finds the APK file in the build outputs
async fn find_apk(
    app_module: &Path,
    variant: &BuildVariant,
    flavor: Option<&str>,
) -> Option<PathBuf> {
    let outputs_dir = app_module.join("build/outputs/apk");

    // Build expected path based on flavor
    let apk_dir = match flavor {
        Some(f) => outputs_dir.join(f).join(variant.apk_dir_name()),
        None => outputs_dir.join(variant.apk_dir_name()),
    };

    if !apk_dir.exists() {
        // Try alternative locations
        return find_apk_recursive(&outputs_dir, variant.as_str()).await;
    }

    // Look for APK file in the directory
    let mut entries = fs::read_dir(&apk_dir).await.ok()?;
    
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().map(|e| e == "apk").unwrap_or(false) {
            // Prefer the one matching our variant
            let name = path.file_name()?.to_string_lossy();
            if name.contains(variant.as_str()) {
                return Some(path);
            }
        }
    }

    // Just return the first APK found
    let mut entries = fs::read_dir(&apk_dir).await.ok()?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().map(|e| e == "apk").unwrap_or(false) {
            return Some(path);
        }
    }

    None
}

/// Recursively searches for an APK matching the variant
async fn find_apk_recursive(dir: &Path, variant: &str) -> Option<PathBuf> {
    if !dir.exists() {
        return None;
    }

    let mut entries = fs::read_dir(dir).await.ok()?;
    
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        
        if path.is_dir() {
            if let Some(found) = Box::pin(find_apk_recursive(&path, variant)).await {
                return Some(found);
            }
        } else if path.extension().map(|e| e == "apk").unwrap_or(false) {
            let name = path.file_name()?.to_string_lossy();
            if name.contains(variant) {
                return Some(path);
            }
        }
    }

    None
}

/// Gets the APK output path for a given configuration
pub fn get_expected_apk_path(
    project_root: &Path,
    app_module: &str,
    variant: &BuildVariant,
    flavor: Option<&str>,
) -> PathBuf {
    let base = project_root
        .join(app_module)
        .join("build/outputs/apk");

    match flavor {
        Some(f) => base
            .join(f)
            .join(variant.apk_dir_name())
            .join(format!("app-{}-{}.apk", f, variant.as_str())),
        None => base
            .join(variant.apk_dir_name())
            .join(format!("app-{}.apk", variant.as_str())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_variant() {
        assert_eq!(BuildVariant::Debug.gradle_task(), "assembleDebug");
        assert_eq!(BuildVariant::Release.gradle_task(), "assembleRelease");
        assert_eq!(BuildVariant::Debug.as_str(), "debug");
    }

    #[test]
    fn test_build_gradle_task() {
        assert_eq!(
            build_gradle_task(&BuildVariant::Debug, None),
            "assembleDebug"
        );
        assert_eq!(
            build_gradle_task(&BuildVariant::Debug, Some("free")),
            "assembleFreeDebug"
        );
        assert_eq!(
            build_gradle_task(&BuildVariant::Release, Some("paid")),
            "assemblePaidRelease"
        );
    }

    #[test]
    fn test_capitalize_first() {
        assert_eq!(capitalize_first("debug"), "Debug");
        assert_eq!(capitalize_first("free"), "Free");
        assert_eq!(capitalize_first(""), "");
    }

    #[test]
    fn test_expected_apk_path() {
        let root = PathBuf::from("/project");
        
        let path = get_expected_apk_path(&root, "app", &BuildVariant::Debug, None);
        assert!(path.to_string_lossy().contains("app-debug.apk"));
        
        let path = get_expected_apk_path(&root, "app", &BuildVariant::Release, Some("free"));
        assert!(path.to_string_lossy().contains("free"));
        assert!(path.to_string_lossy().contains("release"));
    }
}
