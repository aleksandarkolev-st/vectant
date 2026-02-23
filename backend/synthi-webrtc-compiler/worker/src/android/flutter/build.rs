// ============================================================
// FLUTTER BUILD MODULE
// ============================================================
// High-level API for building Flutter APKs for emulator installation.
// Handles dependency resolution, build execution, and APK location.
// ============================================================

use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use super::const_fixer::fix_const_errors;
use super::detection::{detect_flutter_project, FlutterProjectInfo};
use super::flutter_runner::{run_flutter_build_apk, run_flutter_clean, run_pub_get};
use super::LogCallback;
use crate::android::routing::Diagnostic;

/// Build variant for Flutter APKs
#[derive(Debug, Clone, Copy, Default)]
pub enum BuildVariant {
    #[default]
    Debug,
    Release,
    Profile,
}

/// Configuration for building a Flutter APK
#[derive(Debug, Clone)]
pub struct FlutterBuildConfig {
    pub project_root: PathBuf,
    pub variant: BuildVariant,
    pub extra_args: Vec<String>,
    pub env: HashMap<String, String>,
    pub skip_pub_get: bool,
    pub clean_first: bool,
}

impl Default for FlutterBuildConfig {
    fn default() -> Self {
        Self {
            project_root: PathBuf::new(),
            variant: BuildVariant::Debug,
            extra_args: Vec::new(),
            env: HashMap::new(),
            skip_pub_get: false,
            clean_first: false,
        }
    }
}

/// Result of a Flutter APK build
#[derive(Debug, Clone)]
pub struct FlutterBuildResult {
    pub success: bool,
    pub apk_path: Option<PathBuf>,
    pub app_id: Option<String>,
    pub build_duration_ms: u64,
    pub diagnostics: Vec<Diagnostic>,
    pub project_info: Option<FlutterProjectInfo>,
}

/// Builds a Flutter APK for emulator installation
pub async fn build_flutter_apk(
    config: &FlutterBuildConfig,
    log_callback: Option<LogCallback>,
) -> Result<FlutterBuildResult> {
    let start = Instant::now();

    // Validate project exists
    if !config.project_root.exists() {
        bail!("Project root does not exist: {:?}", config.project_root);
    }

    // Detect Flutter project
    let project_info = detect_flutter_project(&config.project_root).await?;
    if !project_info.is_flutter_project {
        bail!("Not a Flutter project: {:?}", config.project_root);
    }

    if !project_info.has_android_module {
        bail!("Flutter project does not have Android support. Run 'flutter create --platforms=android .' to add it.");
    }

    if let Some(ref cb) = log_callback {
        cb(format!(
            "Detected Flutter project: {}",
            project_info.project_name.as_deref().unwrap_or("unknown")
        ));
        if let Some(ref version) = project_info.flutter_version {
            cb(format!("Flutter version constraint: {}", version));
        }
        if let Some(ref app_id) = project_info.app_id {
            cb(format!("Application ID: {}", app_id));
        }
    }

    // Pre-build: Auto-fix common Dart const expression errors.
    // AI-generated code frequently wraps widget trees in `const` even when
    // children contain non-constant expressions (lambdas, callbacks, etc.).
    // Fixing this BEFORE the build avoids a full Gradle round-trip failure.
    match fix_const_errors(&config.project_root).await {
        Ok(fix_result) if fix_result.fixes_applied > 0 => {
            if let Some(ref cb) = log_callback {
                cb(format!(
                    "[const-fixer] Auto-fixed {} const error(s) in {} file(s)",
                    fix_result.fixes_applied, fix_result.files_fixed
                ));
                for detail in &fix_result.details {
                    cb(format!("[const-fixer] {}", detail));
                }
            }
        }
        Err(e) => {
            // Non-fatal: log and continue, the build will surface the real error.
            if let Some(ref cb) = log_callback {
                cb(format!(
                    "[const-fixer] Warning: auto-fix scan failed: {}",
                    e
                ));
            }
        }
        _ => {} // No fixes needed
    }

    // Clean if requested
    if config.clean_first {
        if let Some(ref cb) = log_callback {
            cb("Cleaning Flutter project...".to_string());
        }
        run_flutter_clean(&config.project_root, log_callback.as_ref()).await?;
    }

    // ALWAYS run pub get — never skip based on timestamp comparison.
    // In a reconciliation-based workspace the lock file timestamp is
    // unreliable ("zombie cache" problem). `flutter pub get` is fast
    // when deps are already resolved, but catches stale/corrupt state.
    if !config.skip_pub_get {
        if let Some(ref cb) = log_callback {
            cb("Running flutter pub get...".to_string());
        }

        let pub_result =
            run_pub_get(&config.project_root, log_callback.as_ref(), Some(300)).await?;

        if !pub_result.success {
            return Ok(FlutterBuildResult {
                success: false,
                apk_path: None,
                app_id: project_info.app_id.clone(),
                build_duration_ms: start.elapsed().as_millis() as u64,
                diagnostics: pub_result.diagnostics,
                project_info: Some(project_info),
            });
        }
    }

    // Determine APK output path based on variant
    let (release, apk_path) = match config.variant {
        BuildVariant::Debug => (
            false,
            config
                .project_root
                .join("build/app/outputs/flutter-apk/app-debug.apk"),
        ),
        BuildVariant::Release => (
            true,
            config
                .project_root
                .join("build/app/outputs/flutter-apk/app-release.apk"),
        ),
        BuildVariant::Profile => (
            false, // Profile uses debug-like build but with profile optimizations
            config
                .project_root
                .join("build/app/outputs/flutter-apk/app-profile.apk"),
        ),
    };

    // Build extra args
    let mut extra_args: Vec<&str> = config.extra_args.iter().map(|s| s.as_str()).collect();

    // Add offline mode for faster builds if deps are ready, but this can be risky if
    // project has conditional dependencies or we missed something in detection.
    // Safe option: rely on Gradle build cache.
    // However, if we skipped pub_get, we imply we trust the environment state.
    if config.skip_pub_get {
        extra_args.push("--no-pub");
    }

    if matches!(config.variant, BuildVariant::Profile) {
        extra_args.push("--profile");
    }

    if let Some(ref cb) = log_callback {
        cb(format!(
            "Building {} APK...",
            match config.variant {
                BuildVariant::Debug => "debug",
                BuildVariant::Release => "release",
                BuildVariant::Profile => "profile",
            }
        ));
    }

    // Run the build
    let build_result = run_flutter_build_apk(
        &config.project_root,
        release,
        &extra_args,
        &config.env,
        log_callback.as_ref(),
        Some(600), // 10 minute timeout
    )
    .await?;

    // Check for APK
    let final_apk_path = if build_result.success && apk_path.exists() {
        if let Some(ref cb) = log_callback {
            cb(format!("APK built successfully: {}", apk_path.display()));
        }
        Some(apk_path)
    } else {
        // Try to find APK in alternative locations
        find_flutter_apk(
            &config.project_root,
            matches!(config.variant, BuildVariant::Release),
        )
        .await
    };

    Ok(FlutterBuildResult {
        success: build_result.success && final_apk_path.is_some(),
        apk_path: final_apk_path,
        app_id: project_info.app_id.clone(),
        build_duration_ms: start.elapsed().as_millis() as u64,
        diagnostics: build_result.diagnostics,
        project_info: Some(project_info),
    })
}

/// Cleans Flutter build outputs
pub async fn clean_flutter(project_root: &Path, log_callback: Option<LogCallback>) -> Result<()> {
    run_flutter_clean(project_root, log_callback.as_ref()).await?;
    Ok(())
}

/// Searches for Flutter APK in common output locations
async fn find_flutter_apk(project_root: &Path, release: bool) -> Option<PathBuf> {
    let variant = if release { "release" } else { "debug" };

    let possible_paths = [
        // Standard Flutter APK output
        format!("build/app/outputs/flutter-apk/app-{}.apk", variant),
        // Alternative output location
        format!("build/app/outputs/apk/{}/app-{}.apk", variant, variant),
        // Some older Flutter versions
        format!("build/outputs/apk/{}/app-{}.apk", variant, variant),
    ];

    for relative_path in &possible_paths {
        let full_path = project_root.join(relative_path);
        if full_path.exists() {
            return Some(full_path);
        }
    }

    // Search recursively in build directory
    let build_dir = project_root.join("build");
    if build_dir.exists() {
        if let Ok(apk) = find_apk_recursive(&build_dir, variant).await {
            return Some(apk);
        }
    }

    None
}

/// Recursively searches for APK files
async fn find_apk_recursive(dir: &Path, variant: &str) -> Result<PathBuf> {
    let mut entries = tokio::fs::read_dir(dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();

        if path.is_dir() {
            if let Ok(found) = Box::pin(find_apk_recursive(&path, variant)).await {
                return Ok(found);
            }
        } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.ends_with(".apk") && name.contains(variant) {
                return Ok(path);
            }
        }
    }

    bail!("No APK found")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_variant_default() {
        let variant = BuildVariant::default();
        assert!(matches!(variant, BuildVariant::Debug));
    }

    #[test]
    fn test_flutter_build_config_default() {
        let config = FlutterBuildConfig::default();
        assert!(config.extra_args.is_empty());
        assert!(!config.skip_pub_get);
        assert!(!config.clean_first);
    }
}
