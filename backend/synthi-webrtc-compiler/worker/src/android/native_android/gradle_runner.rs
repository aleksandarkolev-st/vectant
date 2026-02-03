// ============================================================
// NATIVE ANDROID GRADLE RUNNER
// ============================================================
// Gradle execution utilities for native Android (Java/Kotlin) projects.
// Handles gradlew execution, environment setup, and output parsing.
// ============================================================

use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::diagnostics::{parse_gradle_diagnostic, parse_kotlin_diagnostic, parse_java_diagnostic};
use super::LogCallback;
use crate::android::routing::Diagnostic;

// ============================================================
// CONSTANTS
// ============================================================

/// Default Gradle build timeout (25 minutes)
pub const GRADLE_BUILD_TIMEOUT_SECS: u64 = 25 * 60;

/// Heartbeat interval for progress reporting
pub const GRADLE_HEARTBEAT_INTERVAL_SECS: u64 = 15;

/// Stale output threshold before emitting heartbeat
pub const GRADLE_STALE_OUTPUT_SECS: u64 = 20;

// ============================================================
// GRADLE RUNNER
// ============================================================

/// Result of a Gradle command execution
#[derive(Debug, Clone)]
pub struct GradleRunResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub diagnostics: Vec<Diagnostic>,
    pub wrapper_main_missing: bool,
}

/// Runs a Gradle task and collects diagnostics
pub async fn run_gradle_task(
    project_root: &Path,
    tasks: &[&str],
    extra_args: &[&str],
    env_vars: &HashMap<String, String>,
    log_callback: Option<&LogCallback>,
    timeout_secs: Option<u64>,
) -> Result<GradleRunResult> {
    let start = Instant::now();
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(GRADLE_BUILD_TIMEOUT_SECS));

    // Find gradlew (generates if missing)
    let gradlew = find_gradle_wrapper(project_root).await?;

    // Build command - on Unix, run gradlew via /bin/sh for reliability
    #[cfg(unix)]
    let mut cmd = {
        let mut c = Command::new("/bin/sh");
        c.arg(&gradlew);
        c
    };
    #[cfg(not(unix))]
    let mut cmd = Command::new(&gradlew);
    
    cmd.current_dir(project_root);
    cmd.kill_on_drop(true);

    // Add tasks
    for task in tasks {
        cmd.arg(task);
    }

    // Add common Gradle args
    apply_gradle_common_args(&mut cmd);

    // Add extra args
    for arg in extra_args {
        cmd.arg(arg);
    }

    // Apply environment
    apply_gradle_environment(&mut cmd, project_root, env_vars)?;

    // Execute with streaming output
    let result = execute_gradle_with_streaming(cmd, log_callback, timeout, start).await?;

    Ok(result)
}

/// Finds the Gradle wrapper script, generating it if necessary
pub async fn find_gradle_wrapper(project_root: &Path) -> Result<PathBuf> {
    let gradlew = if cfg!(windows) {
        project_root.join("gradlew.bat")
    } else {
        project_root.join("gradlew")
    };

    if !gradlew.exists() {
        // Try to generate the Gradle wrapper using system Gradle
        eprintln!("[gradle_runner] Gradle wrapper not found, attempting to generate it...");
        generate_gradle_wrapper(project_root).await?;
        
        if !gradlew.exists() {
            bail!(
                "Failed to generate Gradle wrapper at {:?}",
                gradlew
            );
        }
    }

    // Ensure gradlew is executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(&gradlew) {
            let mut perms = metadata.permissions();
            if perms.mode() & 0o111 == 0 {
                perms.set_mode(perms.mode() | 0o755);
                std::fs::set_permissions(&gradlew, perms).ok();
            }
        }
    }

    Ok(gradlew)
}

/// Generates the Gradle wrapper files using system Gradle
async fn generate_gradle_wrapper(project_root: &Path) -> Result<()> {
    // First try system Gradle if available
    if let Ok(gradle_cmd) = find_system_gradle() {
        eprintln!("[gradle_runner] Using system gradle: {:?}", gradle_cmd);
        
        let output = Command::new(&gradle_cmd)
            .current_dir(project_root)
            .arg("wrapper")
            .arg("--gradle-version=8.5")
            .arg("--distribution-type=bin")
            .arg("--no-daemon")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .context("Failed to run 'gradle wrapper'")?;
        
        if output.status.success() {
            eprintln!("[gradle_runner] Gradle wrapper generated successfully via system gradle");
            return Ok(());
        }
        
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[gradle_runner] System gradle failed: {}", stderr);
    }
    
    // Fallback: Generate wrapper files manually
    eprintln!("[gradle_runner] Generating Gradle wrapper files manually...");
    generate_gradle_wrapper_files(project_root).await?;
    
    eprintln!("[gradle_runner] Gradle wrapper files generated successfully");
    Ok(())
}

/// Generates Gradle wrapper files directly without needing system Gradle
async fn generate_gradle_wrapper_files(project_root: &Path) -> Result<()> {
    use tokio::fs;
    
    const GRADLE_VERSION: &str = "8.5";
    const WRAPPER_JAR_URL: &str = "https://services.gradle.org/distributions/gradle-8.5-bin.zip";
    
    // Create gradle/wrapper directory
    let wrapper_dir = project_root.join("gradle").join("wrapper");
    fs::create_dir_all(&wrapper_dir).await
        .context("Failed to create gradle/wrapper directory")?;
    
    // Write gradle-wrapper.properties
    let properties_content = format!(
        r#"distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\://services.gradle.org/distributions/gradle-{}-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
"#,
        GRADLE_VERSION
    );
    
    let properties_path = wrapper_dir.join("gradle-wrapper.properties");
    fs::write(&properties_path, properties_content).await
        .context("Failed to write gradle-wrapper.properties")?;
    
    // Write gradlew (Unix shell script)
    let gradlew_content = include_str!("gradlew_template.txt");
    let gradlew_path = project_root.join("gradlew");
    fs::write(&gradlew_path, gradlew_content).await
        .context("Failed to write gradlew")?;
    
    // Make gradlew executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&gradlew_path).await?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&gradlew_path, perms).await?;
    }
    
    // Write gradlew.bat (Windows batch script)
    let gradlew_bat_content = include_str!("gradlew_bat_template.txt");
    let gradlew_bat_path = project_root.join("gradlew.bat");
    fs::write(&gradlew_bat_path, gradlew_bat_content).await
        .context("Failed to write gradlew.bat")?;
    
    // Download gradle-wrapper.jar
    let jar_path = wrapper_dir.join("gradle-wrapper.jar");
    download_gradle_wrapper_jar(&jar_path).await?;
    
    Ok(())
}

/// Downloads the gradle-wrapper.jar from Gradle's GitHub releases
async fn download_gradle_wrapper_jar(jar_path: &Path) -> Result<()> {
    use tokio::fs;
    
    // The gradle-wrapper.jar is a small bootstrap JAR that downloads the actual Gradle distribution
    // We can download it from Gradle's GitHub releases
    const WRAPPER_JAR_URL: &str = "https://raw.githubusercontent.com/gradle/gradle/v8.5.0/gradle/wrapper/gradle-wrapper.jar";
    
    eprintln!("[gradle_runner] Downloading gradle-wrapper.jar...");
    
    // Try to download using curl (most reliable on Linux)
    let output = Command::new("curl")
        .args(["-fsSL", "-o", jar_path.to_str().unwrap_or_default(), WRAPPER_JAR_URL])
        .output()
        .await;
    
    if let Ok(out) = output {
        if out.status.success() && jar_path.exists() {
            let size = fs::metadata(jar_path).await.map(|m| m.len()).unwrap_or(0);
            if size > 10000 {
                eprintln!("[gradle_runner] Downloaded gradle-wrapper.jar ({} bytes)", size);
                return Ok(());
            }
        }
    }
    
    // Fallback: try wget
    let output = Command::new("wget")
        .args(["-q", "-O", jar_path.to_str().unwrap_or_default(), WRAPPER_JAR_URL])
        .output()
        .await;
    
    if let Ok(out) = output {
        if out.status.success() && jar_path.exists() {
            let size = fs::metadata(jar_path).await.map(|m| m.len()).unwrap_or(0);
            if size > 10000 {
                eprintln!("[gradle_runner] Downloaded gradle-wrapper.jar ({} bytes)", size);
                return Ok(());
            }
        }
    }
    
    bail!("Failed to download gradle-wrapper.jar. Please ensure curl or wget is available.");
}

/// Finds the system Gradle installation
fn find_system_gradle() -> Result<PathBuf> {
    // Check common locations for Gradle
    let candidates = vec![
        // Standard PATH lookup
        "gradle",
        // Common Linux installation paths
        "/usr/bin/gradle",
        "/usr/local/bin/gradle",
        "/opt/gradle/bin/gradle",
        // Snap/Flatpak installations
        "/snap/bin/gradle",
        // SDKMAN installations
        "/root/.sdkman/candidates/gradle/current/bin/gradle",
    ];
    
    for candidate in &candidates {
        let path = PathBuf::from(candidate);
        if candidate == &"gradle" {
            // For bare "gradle", check if it's in PATH using which
            if let Ok(output) = std::process::Command::new("which")
                .arg("gradle")
                .output()
            {
                if output.status.success() {
                    let path_str = String::from_utf8_lossy(&output.stdout);
                    let resolved = PathBuf::from(path_str.trim());
                    if resolved.exists() {
                        return Ok(resolved);
                    }
                }
            }
        } else if path.exists() {
            return Ok(path);
        }
    }
    
    // Also check GRADLE_HOME environment variable
    if let Ok(gradle_home) = std::env::var("GRADLE_HOME") {
        let gradle_bin = PathBuf::from(&gradle_home).join("bin/gradle");
        if gradle_bin.exists() {
            return Ok(gradle_bin);
        }
    }
    
    bail!(
        "System Gradle not found. Please install Gradle or add a Gradle wrapper to your project."
    );
}

/// Applies common Gradle arguments for better CI/cloud performance
fn apply_gradle_common_args(cmd: &mut Command) {
    // Disable daemon for cloud workers (avoids memory issues)
    if env_var_truthy("SYNTHI_DISABLE_GRADLE_DAEMON") {
        cmd.arg("--no-daemon");
    }

    // Enable build cache unless disabled
    if !env_var_truthy("SYNTHI_DISABLE_GRADLE_BUILD_CACHE") {
        cmd.arg("--build-cache");
    }

    // Parallel execution
    cmd.arg("--parallel");

    // Stack traces for debugging
    cmd.arg("--stacktrace");

    // Configure workers (limit memory pressure)
    if let Ok(workers) = std::env::var("SYNTHI_GRADLE_WORKERS") {
        cmd.arg(format!("-Dorg.gradle.workers.max={}", workers));
    }

    // Limit JVM memory
    if let Ok(mem) = std::env::var("SYNTHI_GRADLE_JVM_MEMORY") {
        cmd.arg(format!("-Dorg.gradle.jvmargs=-Xmx{}", mem));
    } else {
        cmd.arg("-Dorg.gradle.jvmargs=-Xmx4g");
    }
}

/// Applies Gradle environment variables
fn apply_gradle_environment(
    cmd: &mut Command,
    project_root: &Path,
    extra_env: &HashMap<String, String>,
) -> Result<()> {
    // Resolve JAVA_HOME
    if let Some(java_home) = resolve_java_home() {
        cmd.env("JAVA_HOME", &java_home);
    }

    // Set ANDROID_HOME/ANDROID_SDK_ROOT
    if let Some(android_home) = resolve_android_sdk() {
        cmd.env("ANDROID_HOME", &android_home);
        cmd.env("ANDROID_SDK_ROOT", &android_home);
    }

    // Set GRADLE_USER_HOME if specified
    if let Ok(gradle_home) = std::env::var("SYNTHI_GRADLE_USER_HOME") {
        if !gradle_home.is_empty() {
            cmd.env("GRADLE_USER_HOME", &gradle_home);
        }
    } else {
        // Use project-specific Gradle home to avoid cache conflicts
        let gradle_home = project_root.join(".gradle-home");
        std::fs::create_dir_all(&gradle_home).ok();
        cmd.env("GRADLE_USER_HOME", &gradle_home);
    }

    // Apply extra environment variables
    for (key, value) in extra_env {
        cmd.env(key, value);
    }

    // Disable Gradle Java toolchain auto-detect (causes issues with probing)
    if !env_var_truthy("SYNTHI_ENABLE_GRADLE_JAVA_AUTODETECT") {
        cmd.env("JAVA_TOOL_OPTIONS", "");
    }

    Ok(())
}

/// Executes Gradle with streaming output and diagnostics collection
async fn execute_gradle_with_streaming(
    mut cmd: Command,
    log_callback: Option<&LogCallback>,
    total_timeout: Duration,
    start: Instant,
) -> Result<GradleRunResult> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    
    let mut child = cmd.spawn().context("Failed to spawn gradle")?;

    let stdout = child.stdout.take().context("Missing stdout")?;
    let stderr = child.stderr.take().context("Missing stderr")?;

    let mut stdout_reader = BufReader::new(stdout);
    let mut stderr_reader = BufReader::new(stderr);
    let mut stdout_buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut stderr_buf: Vec<u8> = Vec::with_capacity(8 * 1024);

    let mut diagnostics = Vec::new();
    let mut wrapper_main_missing = false;
    let mut last_output = Instant::now();

    let mut heartbeat = tokio::time::interval(Duration::from_secs(GRADLE_HEARTBEAT_INTERVAL_SECS));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut stdout_closed = false;
    let mut stderr_closed = false;
    let mut exit_status: Option<std::process::ExitStatus> = None;

    loop {
        if exit_status.is_some() && stdout_closed && stderr_closed {
            break;
        }

        tokio::select! {
            _ = heartbeat.tick() => {
                if last_output.elapsed() >= Duration::from_secs(GRADLE_STALE_OUTPUT_SECS) {
                    if let Some(cb) = log_callback {
                        cb(format!(
                            "Gradle still running... (elapsed={}s, no output for {}s)",
                            start.elapsed().as_secs(),
                            last_output.elapsed().as_secs(),
                        ));
                    }
                }

                if start.elapsed() >= total_timeout {
                    if let Some(cb) = log_callback {
                        cb(format!(
                            "Gradle timed out after {}s; terminating",
                            start.elapsed().as_secs(),
                        ));
                    }
                    let _ = child.kill().await;
                    bail!("Gradle build timed out after {} seconds", start.elapsed().as_secs());
                }
            }

            status_res = child.wait(), if exit_status.is_none() => {
                exit_status = Some(status_res.context("Failed to wait for gradle")?);
            }

            stdout_res = stdout_reader.read_until(b'\n', &mut stdout_buf), if !stdout_closed => {
                match stdout_res {
                    Ok(0) => stdout_closed = true,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&stdout_buf)
                            .trim_end_matches(['\r', '\n'])
                            .to_string();
                        stdout_buf.clear();
                        
                        if !line.is_empty() {
                            if let Some(cb) = log_callback {
                                cb(line.clone());
                            }
                            last_output = Instant::now();
                            
                            // Parse diagnostics
                            collect_diagnostics(&line, &mut diagnostics);
                        }
                    }
                    Err(e) => {
                        eprintln!("Error reading stdout: {}", e);
                        stdout_closed = true;
                    }
                }
            }

            stderr_res = stderr_reader.read_until(b'\n', &mut stderr_buf), if !stderr_closed => {
                match stderr_res {
                    Ok(0) => stderr_closed = true,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&stderr_buf)
                            .trim_end_matches(['\r', '\n'])
                            .to_string();
                        stderr_buf.clear();
                        
                        if !line.is_empty() {
                            let lower = line.to_lowercase();
                            
                            // Check for wrapper issues
                            if lower.contains("gradlewrappermain") {
                                wrapper_main_missing = true;
                            }
                            
                            if let Some(cb) = log_callback {
                                cb(format!("[stderr] {}", line));
                            }
                            last_output = Instant::now();
                            
                            collect_diagnostics(&line, &mut diagnostics);
                        }
                    }
                    Err(e) => {
                        eprintln!("Error reading stderr: {}", e);
                        stderr_closed = true;
                    }
                }
            }
        }
    }

    let status = exit_status.unwrap();
    let exit_code = status.code();

    Ok(GradleRunResult {
        success: status.success(),
        exit_code,
        duration_ms: start.elapsed().as_millis() as u64,
        diagnostics,
        wrapper_main_missing,
    })
}

/// Collects diagnostics from a log line
fn collect_diagnostics(line: &str, diagnostics: &mut Vec<Diagnostic>) {
    if let Some(diag) = parse_gradle_diagnostic(line) {
        diagnostics.push(diag);
    }
    if let Some(diag) = parse_java_diagnostic(line) {
        diagnostics.push(diag);
    }
    if let Some(diag) = parse_kotlin_diagnostic(line) {
        diagnostics.push(diag);
    }
}

// ============================================================
// ENVIRONMENT RESOLUTION
// ============================================================

/// Resolves JAVA_HOME from environment or common locations
pub fn resolve_java_home() -> Option<PathBuf> {
    // Check environment first
    if let Ok(java_home) = std::env::var("JAVA_HOME") {
        if !java_home.is_empty() {
            let path = PathBuf::from(&java_home);
            if path.exists() {
                return Some(path);
            }
        }
    }

    // Check SYNTHI-specific variable
    if let Ok(java_home) = std::env::var("SYNTHI_JAVA_HOME") {
        if !java_home.is_empty() {
            let path = PathBuf::from(&java_home);
            if path.exists() {
                return Some(path);
            }
        }
    }

    // Try common Linux locations
    let common_paths = [
        "/usr/lib/jvm/java-17-openjdk-amd64",
        "/usr/lib/jvm/java-17-openjdk",
        "/usr/lib/jvm/java-11-openjdk-amd64",
        "/usr/lib/jvm/java-11-openjdk",
        "/opt/java/openjdk",
        "/opt/java/jdk-17",
    ];

    for path_str in common_paths {
        let path = PathBuf::from(path_str);
        if path.exists() {
            return Some(path);
        }
    }

    None
}

/// Resolves Android SDK path
pub fn resolve_android_sdk() -> Option<PathBuf> {
    // Check environment variables
    for var in ["ANDROID_HOME", "ANDROID_SDK_ROOT", "SYNTHI_ANDROID_SDK"] {
        if let Ok(sdk) = std::env::var(var) {
            if !sdk.is_empty() {
                let path = PathBuf::from(&sdk);
                if path.exists() {
                    return Some(path);
                }
            }
        }
    }

    // Try common locations
    let common_paths = [
        "/opt/android-sdk",
        "/usr/local/android-sdk",
        &format!("{}/Android/Sdk", std::env::var("HOME").unwrap_or_default()),
    ];

    for path_str in common_paths {
        let path = PathBuf::from(path_str);
        if path.exists() {
            return Some(path);
        }
    }

    None
}

/// Checks if an environment variable is truthy
fn env_var_truthy(name: &str) -> bool {
    std::env::var(name)
        .map(|v| {
            let v = v.trim().to_lowercase();
            v == "1" || v == "true" || v == "yes"
        })
        .unwrap_or(false)
}

// ============================================================
// GRADLE TASKS
// ============================================================

/// Gets available Gradle tasks
pub async fn get_gradle_tasks(project_root: &Path) -> Result<Vec<String>> {
    let gradlew = find_gradle_wrapper(project_root).await?;
    
    let output = Command::new(&gradlew)
        .current_dir(project_root)
        .args(["tasks", "--all", "-q"])
        .output()
        .await
        .context("Failed to list tasks")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let tasks: Vec<String> = stdout
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with(' '))
        .filter_map(|l| l.split_whitespace().next())
        .filter(|t| !t.contains("---"))
        .map(|s| s.to_string())
        .collect();

    Ok(tasks)
}

/// Cleans the Gradle build
pub async fn gradle_clean(
    project_root: &Path,
    log_callback: Option<&LogCallback>,
) -> Result<GradleRunResult> {
    run_gradle_task(
        project_root,
        &["clean"],
        &[],
        &HashMap::new(),
        log_callback,
        Some(120),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_env_var_truthy() {
        // Note: These tests depend on actual env vars not being set
        assert!(!env_var_truthy("NONEXISTENT_VAR_12345"));
    }

    #[test]
    fn test_resolve_functions() {
        // These may or may not find values depending on system
        let _ = resolve_java_home();
        let _ = resolve_android_sdk();
    }
}
