// ============================================================
// FLUTTER RUNNER
// ============================================================
// Executes Flutter CLI commands with output streaming.
// Handles pub get, build, clean, etc.
// ============================================================

use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

use super::diagnostics::parse_flutter_diagnostics;
use super::LogCallback;
use crate::android::routing::Diagnostic;

/// Default timeout for Flutter builds (10 minutes)
const FLUTTER_BUILD_TIMEOUT_SECS: u64 = 600;

/// Result of a Flutter command execution
#[derive(Debug, Clone)]
pub struct FlutterRunResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub diagnostics: Vec<Diagnostic>,
}

/// Finds the Flutter binary path
pub async fn find_flutter_binary() -> Result<PathBuf> {
    // Check FLUTTER_ROOT first
    if let Ok(flutter_root) = std::env::var("FLUTTER_ROOT") {
        let flutter_bin = PathBuf::from(&flutter_root).join("bin/flutter");
        if flutter_bin.exists() {
            return Ok(flutter_bin);
        }
    }

    // Try PATH using 'which'
    let output = Command::new("which")
        .arg("flutter")
        .output()
        .await
        .context("Failed to search for flutter")?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(PathBuf::from(path));
    }

    // Check common locations
    let common_paths = [
        "/opt/flutter/bin/flutter",
        "/usr/local/flutter/bin/flutter",
        "/home/worker/flutter/bin/flutter",
        "/home/sasho/flutter/bin/flutter",  // Common dev machine location
    ];

    for path in &common_paths {
        let p = PathBuf::from(path);
        if p.exists() {
            return Ok(p);
        }
    }

    // Check home directory
    if let Ok(home) = std::env::var("HOME") {
        let home_flutter = PathBuf::from(home).join("flutter/bin/flutter");
        if home_flutter.exists() {
            return Ok(home_flutter);
        }
    }

    // Check FLUTTER_HOME environment variable
    if let Ok(flutter_home) = std::env::var("FLUTTER_HOME") {
        let flutter_bin = PathBuf::from(&flutter_home).join("bin/flutter");
        if flutter_bin.exists() {
            return Ok(flutter_bin);
        }
    }

    // Scan /home/*/flutter as fallback for multi-user systems
    if let Ok(entries) = std::fs::read_dir("/home") {
        for entry in entries.flatten() {
            let flutter_path = entry.path().join("flutter/bin/flutter");
            if flutter_path.exists() {
                return Ok(flutter_path);
            }
        }
    }

    bail!("Flutter SDK not found. Please ensure FLUTTER_ROOT is set or flutter is in PATH.")
}

/// Runs `flutter pub get` to fetch dependencies
pub async fn run_pub_get(
    project_root: &Path,
    log_callback: Option<&LogCallback>,
    timeout_secs: Option<u64>,
) -> Result<FlutterRunResult> {
    run_flutter_command(
        project_root,
        &["pub", "get"],
        &HashMap::new(),
        log_callback,
        timeout_secs,
    )
    .await
}

/// Runs `flutter clean`
pub async fn run_flutter_clean(
    project_root: &Path,
    log_callback: Option<&LogCallback>,
) -> Result<FlutterRunResult> {
    run_flutter_command(
        project_root,
        &["clean"],
        &HashMap::new(),
        log_callback,
        Some(60),
    )
    .await
}

/// Runs `flutter build apk` with specified options
pub async fn run_flutter_build_apk(
    project_root: &Path,
    release: bool,
    extra_args: &[&str],
    env_vars: &HashMap<String, String>,
    log_callback: Option<&LogCallback>,
    timeout_secs: Option<u64>,
) -> Result<FlutterRunResult> {
    // AGGRESSIVE CLEAN: Manually remove build artifacts to prevent stale cache issues
    if let Some(cb) = log_callback {
        cb("Performing aggressive workspace cleanup...".to_string());
    }
    
    // Debug: Print main.dart content to logs to verify sync status
    let main_dart = project_root.join("lib/main.dart");
    if main_dart.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&main_dart).await {
            if let Some(cb) = log_callback {
                cb(format!("[debug] lib/main.dart content preview (FULL):\n{}", content));
            }
        }
    }

    let dirs_to_clean = ["build", ".dart_tool", "android/.gradle", "android/app/build"];
    for dir in dirs_to_clean {
        let p = project_root.join(dir);
        if p.exists() {
             let _ = tokio::fs::remove_dir_all(&p).await;
        }
    }

    let mut args = vec!["build", "apk"];
    
    if release {
        args.push("--release");
    } else {
        args.push("--debug");
    }
    
    // REMOVED --verbose to reduce log noise
    // args.push("--verbose");
    
    // Add any extra arguments
    for arg in extra_args {
        args.push(arg);
    }

    run_flutter_command(
        project_root,
        &args,
        env_vars,
        log_callback,
        timeout_secs,
    )
    .await
}

/// Runs `flutter build appbundle` for release builds
pub async fn run_flutter_build_appbundle(
    project_root: &Path,
    env_vars: &HashMap<String, String>,
    log_callback: Option<&LogCallback>,
    timeout_secs: Option<u64>,
) -> Result<FlutterRunResult> {
    run_flutter_command(
        project_root,
        &["build", "appbundle", "--release", "--verbose"],
        env_vars,
        log_callback,
        timeout_secs,
    )
    .await
}

/// Core function to run any Flutter command with streaming output
pub async fn run_flutter_command(
    project_root: &Path,
    args: &[&str],
    env_vars: &HashMap<String, String>,
    log_callback: Option<&LogCallback>,
    timeout_secs: Option<u64>,
) -> Result<FlutterRunResult> {
    let start = Instant::now();
    let timeout_duration = Duration::from_secs(timeout_secs.unwrap_or(FLUTTER_BUILD_TIMEOUT_SECS));

    let flutter_bin = find_flutter_binary().await?;

    if let Some(cb) = log_callback {
        cb(format!("Running: flutter {}", args.join(" ")));
    }

    let mut cmd = Command::new(&flutter_bin);
    cmd.args(args);
    cmd.current_dir(project_root);
    cmd.kill_on_drop(true);

    // Apply environment variables
    apply_flutter_environment(&mut cmd, project_root, env_vars)?;

    // Set up pipes for streaming
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().context("Failed to spawn flutter process")?;

    let stdout = child.stdout.take().expect("stdout should be captured");
    let stderr = child.stderr.take().expect("stderr should be captured");

    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    let mut stdout_collected = String::new();
    let mut stderr_collected = String::new();

    // Stream output with timeout
    let result = timeout(timeout_duration, async {
        loop {
            tokio::select! {
                line = stdout_reader.next_line() => {
                    match line {
                        Ok(Some(line)) => {
                            stdout_collected.push_str(&line);
                            stdout_collected.push('\n');
                            if let Some(cb) = log_callback {
                                cb(line);
                            }
                        }
                        Ok(None) => {}
                        Err(e) => {
                            eprintln!("[flutter_runner] stdout read error: {}", e);
                        }
                    }
                }
                line = stderr_reader.next_line() => {
                    match line {
                        Ok(Some(line)) => {
                            stderr_collected.push_str(&line);
                            stderr_collected.push('\n');
                            if let Some(cb) = log_callback {
                                // Filter out noisy Gradle/Java stack traces
                                let is_stack_trace = line.contains("org.gradle.") 
                                    || line.contains("java.base/") 
                                    || line.contains("java.util.concurrent.")
                                    || line.contains('\t') && line.contains("at ")
                                    || line.trim().starts_with("at ");
                                
                                if !is_stack_trace {
                                    // Prefix stderr lines for visibility
                                    cb(format!("[stderr] {}", line));
                                }
                            }
                        }
                        Ok(None) => {}
                        Err(e) => {
                            eprintln!("[flutter_runner] stderr read error: {}", e);
                        }
                    }
                }
                status = child.wait() => {
                    match status {
                        Ok(exit_status) => {
                            let duration_ms = start.elapsed().as_millis() as u64;
                            let success = exit_status.success();
                            let exit_code = exit_status.code();

                            // Parse diagnostics from output
                            let diagnostics = parse_flutter_diagnostics(&stdout_collected, &stderr_collected);

                            return Ok(FlutterRunResult {
                                success,
                                exit_code,
                                stdout: stdout_collected,
                                stderr: stderr_collected,
                                duration_ms,
                                diagnostics,
                            });
                        }
                        Err(e) => {
                            return Err(anyhow::anyhow!("Failed to wait for flutter process: {}", e));
                        }
                    }
                }
            }
        }
    }).await;

    match result {
        Ok(inner) => inner,
        Err(_) => {
            // Timeout - kill the process
            let _ = child.kill().await;
            bail!(
                "Flutter command timed out after {} seconds",
                timeout_duration.as_secs()
            );
        }
    }
}

/// Applies Flutter-specific environment variables
fn apply_flutter_environment(
    cmd: &mut Command,
    project_root: &Path,
    extra_env: &HashMap<String, String>,
) -> Result<()> {
    // Set CI mode to avoid interactive prompts
    cmd.env("CI", "true");
    cmd.env("FLUTTER_SUPPRESS_ANALYTICS", "true");

    // Pass through Android SDK
    if let Ok(sdk) = std::env::var("ANDROID_SDK_ROOT") {
        cmd.env("ANDROID_SDK_ROOT", &sdk);
        cmd.env("ANDROID_HOME", &sdk);
    } else if let Ok(sdk) = std::env::var("ANDROID_HOME") {
        cmd.env("ANDROID_SDK_ROOT", &sdk);
        cmd.env("ANDROID_HOME", &sdk);
    }

    // Pass through Java home
    if let Ok(java_home) = std::env::var("JAVA_HOME") {
        cmd.env("JAVA_HOME", &java_home);
    }

    // Pass through Flutter root
    if let Ok(flutter_root) = std::env::var("FLUTTER_ROOT") {
        cmd.env("FLUTTER_ROOT", &flutter_root);
        // Ensure Flutter's bin is in PATH
        if let Ok(path) = std::env::var("PATH") {
            let flutter_bin = format!("{}/bin", flutter_root);
            if !path.contains(&flutter_bin) {
                cmd.env("PATH", format!("{}:{}", flutter_bin, path));
            }
        }
    }

    // Pub cache location
    if let Ok(pub_cache) = std::env::var("PUB_CACHE") {
        cmd.env("PUB_CACHE", pub_cache);
    }

    // Apply extra environment variables
    for (key, value) in extra_env {
        cmd.env(key, value);
    }

    Ok(())
}

/// Checks if Flutter dependencies are up to date
pub async fn check_pub_outdated(project_root: &Path) -> Result<bool> {
    let pubspec_lock = project_root.join("pubspec.lock");
    let pubspec_yaml = project_root.join("pubspec.yaml");

    if !pubspec_lock.exists() {
        return Ok(false);
    }

    // Check if pubspec.yaml is newer than pubspec.lock
    let yaml_modified = tokio::fs::metadata(&pubspec_yaml).await?.modified()?;
    let lock_modified = tokio::fs::metadata(&pubspec_lock).await?.modified()?;

    Ok(lock_modified >= yaml_modified)
}
