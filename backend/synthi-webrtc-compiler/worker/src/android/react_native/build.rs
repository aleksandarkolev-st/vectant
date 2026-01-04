use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

use super::common::{
    android_dir_is_ready_for_first_gradle_invocation, android_dir_missing_required_files,
    check_wrapper_jar_health, env_var_truthy, ensure_gradle_distribution, read_gradle_distribution_url,
    system_gradle_available, worker_cache_dir,
};
use super::detection::{detect_react_native_project, extract_android_app_id};
use super::gradle_runner::{
    apply_gradle_common_args_and_env, create_isolated_gradle_user_home, run_gradle_and_collect_diagnostics,
};
use super::project_init::ensure_android_gradle_project;
use super::LogCallback;
use crate::mobile_routing::Diagnostic;

/// Configuration for building a React Native APK for emulator
#[derive(Debug, Clone)]
pub struct EmulatorBuildConfig {
    pub project_root: PathBuf,
    pub variant: BuildVariant,
    pub extra_gradle_args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub enum BuildVariant {
    #[default]
    Debug,
    Release,
}

/// Result of APK build (for emulator installation)
#[derive(Debug, Clone)]
pub struct EmulatorBuildResult {
    pub success: bool,
    pub apk_path: Option<PathBuf>,
    pub app_id: Option<String>,
    pub build_duration_ms: u64,
    pub diagnostics: Vec<Diagnostic>,
}

/// Builds React Native debug APK for emulator installation
pub async fn build_apk_for_emulator(
    config: &EmulatorBuildConfig,
    log_callback: Option<LogCallback>,
) -> Result<EmulatorBuildResult> {
    let start = std::time::Instant::now();

    // Validate project exists
    if !config.project_root.exists() {
        bail!("Project root does not exist: {:?}", config.project_root);
    }

    // Detect project info for app ID
    let project_info = detect_react_native_project(&config.project_root).await?;
    if !project_info.is_react_native_project {
        bail!("Not a React Native project: {:?}", config.project_root);
    }

    // Ensure android/ exists and is a valid Android Gradle project before we do any heavy work.
    // This is the canonical first-time generation flow for pure React Native projects.
    let android_dir = config.project_root.join("android");
    ensure_android_gradle_project(
        &config.project_root,
        &android_dir,
        project_info.react_native_version.as_deref(),
        log_callback.as_ref(),
    )
    .await?;

    // Install npm dependencies if needed
    let node_modules = config.project_root.join("node_modules");
    if !node_modules.exists() {
        if let Some(ref callback) = log_callback {
            callback("Installing npm dependencies...".to_string());
        }
        let npm_result = run_npm_install(&config.project_root, log_callback.as_ref()).await?;
        if !npm_result {
            bail!("npm dependency install failed");
        }
    }

    // Determine APK path based on variant
    let (gradle_task, apk_path) = match config.variant {
        BuildVariant::Debug => (
            "assembleDebug",
            config
                .project_root
                .join("android/app/build/outputs/apk/debug/app-debug.apk"),
        ),
        BuildVariant::Release => (
            "assembleRelease",
            config
                .project_root
                .join("android/app/build/outputs/apk/release/app-release.apk"),
        ),
    };

    if !android_dir_is_ready_for_first_gradle_invocation(&android_dir) {
        let missing = android_dir_missing_required_files(&android_dir);
        bail!(
            "Android Gradle project is not ready (missing: {}). React Native CLI generation should have created these files.",
            missing.join(", ")
        );
    }

    // Refresh app id now that android/ may have been generated.
    let resolved_app_id = extract_android_app_id(&android_dir)
        .await
        .ok()
        .or(project_info.app_id.clone());

    // Use a per-build Gradle user home to avoid shared-cache corruption between concurrent jobs.
    let gradle_user_home = create_isolated_gradle_user_home(&config.project_root).await?;
    if let Some(cb) = log_callback.as_ref() {
        let caching = if env_var_truthy("SYNTHI_DISABLE_GRADLE_BUILD_CACHE") {
            "disabled"
        } else {
            "enabled"
        };
        let daemon = if env_var_truthy("SYNTHI_DISABLE_GRADLE_DAEMON") {
            "disabled"
        } else {
            "enabled"
        };
        cb(format!(
            "Using GRADLE_USER_HOME: {} (Gradle build cache: {}, Gradle daemon: {})",
            gradle_user_home.display(),
            caching,
            daemon
        ));
    }

    // If wrapper jar looks missing/corrupt, prefer system gradle immediately (if available).
    let wrapper_health = check_wrapper_jar_health(&android_dir).await;
    if (!wrapper_health.exists || wrapper_health.size_bytes < 1024 || !wrapper_health.looks_like_zip)
        && system_gradle_available().await
    {
        if let Some(cb) = log_callback.as_ref() {
            cb(format!(
                "Wrapper jar looks missing/corrupt (exists={} size={} looksLikeZip={}); falling back to system `gradle`",
                wrapper_health.exists, wrapper_health.size_bytes, wrapper_health.looks_like_zip
            ));
        }

        // NOTE: args must come before tasks for Gradle options; here we already added task.
        // Prefer putting args first by rebuilding cmd in-order.
        let mut cmd = Command::new("gradle");
        cmd.current_dir(&android_dir);
        apply_gradle_common_args_and_env(&mut cmd, &gradle_user_home);
        cmd.arg(gradle_task)
            .args(&config.extra_gradle_args)
            .envs(&config.env);

        let (status, diagnostics, _wrapper_main_missing) =
            run_gradle_and_collect_diagnostics(cmd, log_callback.as_ref()).await?;

        let duration = start.elapsed().as_millis() as u64;
        let final_apk_path = if status.success() && apk_path.exists() {
            Some(apk_path)
        } else {
            None
        };

        return Ok(EmulatorBuildResult {
            success: status.success(),
            apk_path: final_apk_path,
            app_id: resolved_app_id.clone(),
            build_duration_ms: duration,
            diagnostics,
        });
    }

    // If wrapper jar is missing/corrupt AND system gradle is not available, download the
    // Gradle distribution and run its bundled `bin/gradle` directly.
    if !wrapper_health.exists || wrapper_health.size_bytes < 1024 || !wrapper_health.looks_like_zip {
        if let Some(url) = read_gradle_distribution_url(&android_dir).await {
            if let Some(cb) = log_callback.as_ref() {
                cb(format!(
                    "Wrapper jar invalid (exists={} size={} looksLikeZip={}); using Gradle distribution from properties",
                    wrapper_health.exists, wrapper_health.size_bytes, wrapper_health.looks_like_zip
                ));
            }

            let gradle_bin =
                ensure_gradle_distribution(&android_dir, &url, log_callback.as_ref()).await?;
            let mut cmd = Command::new(&gradle_bin);
            cmd.current_dir(&android_dir);
            apply_gradle_common_args_and_env(&mut cmd, &gradle_user_home);
            cmd.arg(gradle_task)
                .args(&config.extra_gradle_args)
                .envs(&config.env);

            let (status, diagnostics, _wrapper_main_missing) =
                run_gradle_and_collect_diagnostics(cmd, log_callback.as_ref()).await?;

            let duration = start.elapsed().as_millis() as u64;
            let final_apk_path = if status.success() && apk_path.exists() {
                Some(apk_path)
            } else {
                None
            };

            return Ok(EmulatorBuildResult {
                success: status.success(),
                apk_path: final_apk_path,
                app_id: resolved_app_id.clone(),
                build_duration_ms: duration,
                diagnostics,
            });
        } else if let Some(cb) = log_callback.as_ref() {
            cb(
                "Wrapper jar invalid and no distributionUrl found in gradle-wrapper.properties"
                    .to_string(),
            );
        }
    }

    // Determine gradle wrapper path
    let gradlew = if cfg!(windows) {
        android_dir.join("gradlew.bat")
    } else {
        android_dir.join("gradlew")
    };

    if !gradlew.exists() {
        bail!(
            "Gradle wrapper not found at {} (expected Android project at {}). Ensure the React Native project contains android/gradlew (and gradle/wrapper/gradle-wrapper.jar + gradle-wrapper.properties).",
            gradlew.display(),
            android_dir.display()
        );
    }

    // Ensure gradlew is executable (Unix only)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = tokio::fs::metadata(&gradlew).await {
            let mut perms = metadata.permissions();
            perms.set_mode(0o755);
            let _ = tokio::fs::set_permissions(&gradlew, perms).await;
        }
    }

    if let Some(ref callback) = log_callback {
        callback(format!(
            "Running Gradle wrapper: {} {} (cwd={})",
            gradlew.display(),
            gradle_task,
            android_dir.display()
        ));
    }

    let mut cmd = Command::new(&gradlew);
    cmd.current_dir(&android_dir);
    apply_gradle_common_args_and_env(&mut cmd, &gradle_user_home);
    cmd.arg(gradle_task)
        .args(&config.extra_gradle_args)
        .envs(&config.env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Use shared runner that streams output and collects diagnostics.
    let (status, diagnostics, wrapper_main_missing) =
        run_gradle_and_collect_diagnostics(cmd, log_callback.as_ref()).await?;

    // If the wrapper can't load its main class, fall back to system gradle (if present).
    if wrapper_main_missing && !status.success() && system_gradle_available().await {
        if let Some(cb) = log_callback.as_ref() {
            cb("Gradle wrapper class missing; falling back to system `gradle`".to_string());
        }

        let mut alt = Command::new("gradle");
        alt.current_dir(&android_dir);
        apply_gradle_common_args_and_env(&mut alt, &gradle_user_home);
        alt.arg(gradle_task)
            .args(&config.extra_gradle_args)
            .envs(&config.env);

        let (status2, diagnostics2, _wrapper_main_missing2) =
            run_gradle_and_collect_diagnostics(alt, log_callback.as_ref()).await?;

        let duration = start.elapsed().as_millis() as u64;
        let final_apk_path = if status2.success() && apk_path.exists() {
            Some(apk_path)
        } else {
            None
        };

        return Ok(EmulatorBuildResult {
            success: status2.success(),
            apk_path: final_apk_path,
            app_id: resolved_app_id.clone(),
            build_duration_ms: duration,
            diagnostics: diagnostics2,
        });
    }

    let duration = start.elapsed().as_millis() as u64;
    let final_apk_path = if status.success() && apk_path.exists() {
        Some(apk_path)
    } else {
        None
    };

    Ok(EmulatorBuildResult {
        success: status.success(),
        apk_path: final_apk_path,
        app_id: resolved_app_id,
        build_duration_ms: duration,
        diagnostics,
    })
}

/// Installs JS dependencies using npm.
///
/// Prefers `npm ci` when package-lock.json exists; falls back to `npm install` if `npm ci` fails.
async fn run_npm_install(project_root: &Path, log_callback: Option<&LogCallback>) -> Result<bool> {
    let has_package_lock = project_root.join("package-lock.json").exists();
    let prefer_ci = has_package_lock && !env_var_truthy("SYNTHI_DISABLE_NPM_CI");

    let use_cache = !env_var_truthy("SYNTHI_DISABLE_NPM_CACHE");

    async fn run_npm_once(
        project_root: &Path,
        args: &[&str],
        log_callback: Option<&LogCallback>,
        use_cache: bool,
    ) -> Result<std::process::Output> {
        if let Some(callback) = log_callback {
            callback(format!("Running: npm {}", args.join(" ")));
        }

        let mut cmd = Command::new("npm");
        cmd.current_dir(project_root).args(args);

        // Shared npm cache to speed up repeated installs.
        // This does NOT sync node_modules back to the workspace.
        if use_cache {
            let cache_dir = std::env::var("SYNTHI_NPM_CACHE_DIR")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| worker_cache_dir().join("npm-cache"));
            tokio::fs::create_dir_all(&cache_dir)
                .await
                .with_context(|| {
                    format!("Failed to create npm cache dir at {}", cache_dir.display())
                })?;
            cmd.env("npm_config_cache", &cache_dir);
            cmd.env("npm_config_prefer_offline", "true");
            cmd.env("npm_config_progress", "false");
            if let Some(callback) = log_callback {
                callback(format!("Using npm cache dir: {}", cache_dir.display()));
            }
        } else if let Some(callback) = log_callback {
            callback("npm cache disabled (SYNTHI_DISABLE_NPM_CACHE=1)".to_string());
        }

        // Reduce noise and time spent on non-essential network calls.
        cmd.env("npm_config_audit", "false");
        cmd.env("npm_config_fund", "false");

        let output = cmd.output().await.context("Failed to run npm")?;

        if let Some(callback) = log_callback {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                callback(line.to_string());
            }

            for line in String::from_utf8_lossy(&output.stderr).lines() {
                callback(format!("[stderr] {}", line));
            }
        }

        Ok(output)
    }

    if prefer_ci {
        let output = run_npm_once(project_root, &["ci"], log_callback, use_cache).await?;
        if output.status.success() {
            return Ok(true);
        }

        if let Some(callback) = log_callback {
            callback("npm ci failed; falling back to npm install".to_string());
        }
    }

    let output = run_npm_once(project_root, &["install"], log_callback, use_cache).await?;
    Ok(output.status.success())
}

/// Runs `./gradlew clean` to clear build artifacts
pub async fn clean_android(project_root: &Path) -> Result<()> {
    let android_dir = project_root.join("android");
    let gradlew = if cfg!(windows) {
        android_dir.join("gradlew.bat")
    } else {
        android_dir.join("gradlew")
    };

    Command::new(&gradlew)
        .current_dir(&android_dir)
        .arg("clean")
        .output()
        .await
        .context("Failed to run gradle clean")?;

    Ok(())
}
