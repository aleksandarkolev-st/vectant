// ============================================================
// REACT NATIVE BUILDER MODULE
// ============================================================
// Builds React Native Android APKs for emulator execution.
// Uses Gradle for Android builds, Metro bundler for JS.
// APKs are installed directly to emulator - no artifact download.
// ============================================================

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::collections::HashMap;
use tokio::process::Command;
use tokio::io::{AsyncBufReadExt, BufReader};
use anyhow::{Result, Context, bail};
use serde::Deserialize;

use crate::mobile_routing::{
    ReactNativeProjectInfo, Diagnostic, DiagnosticSeverity, AndroidSdkHealth,
};
use crate::env_setup;

// ============================================================
// REACT NATIVE PROJECT DETECTION
// ============================================================

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
    
    let package: PackageJson = serde_json::from_str(&package_content)
        .context("Failed to parse package.json")?;
    
    // Check for react-native dependency
    let rn_version = package.dependencies
        .as_ref()
        .and_then(|deps| deps.get("react-native"))
        .map(|v| v.as_str().unwrap_or("unknown").to_string());
    
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
async fn extract_android_app_id(android_dir: &Path) -> Result<String> {
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
                if let Some(end) = trimmed[start+1..].find('"') {
                    return Ok(trimmed[start+1..start+1+end].to_string());
                }
            }
        }
    }
    
    bail!("applicationId not found in build.gradle")
}

/// Extracts minSdkVersion from build.gradle
async fn extract_android_min_sdk(android_dir: &Path) -> Result<Option<u32>> {
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
                    if v >= 16 && v <= 35 { // Reasonable SDK range
                        return Ok(Some(v));
                    }
                }
            }
        }
    }
    
    Ok(None)
}

#[derive(Debug, Deserialize)]
struct PackageJson {
    name: Option<String>,
    dependencies: Option<HashMap<String, serde_json::Value>>,
    #[serde(rename = "devDependencies")]
    #[allow(dead_code)]
    dev_dependencies: Option<HashMap<String, serde_json::Value>>,
}

// ============================================================
// ANDROID SDK HEALTH CHECK
// ============================================================

/// Checks Android SDK and emulator toolchain health for React Native
pub async fn check_android_sdk() -> Result<AndroidSdkHealth> {
    // Tests run under the Rust test harness, not our `main()`, so make sure the
    // Android SDK env is still bootstrapped when this check is called.
    env_setup::ensure_android_sdk_env();

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
        let output = Command::new(emulator)
            .arg("-list-avds")
            .output()
            .await?;
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
    let adb_path = sdk_root.as_ref().and_then(|r| resolve_android_tool(r, "adb"));
    let emulator_path = sdk_root.as_ref().and_then(|r| resolve_android_tool(r, "emulator"));
    let avdmanager_path = sdk_root.as_ref().and_then(|r| resolve_android_tool(r, "avdmanager"));
    let sdkmanager_path = sdk_root.as_ref().and_then(|r| resolve_android_tool(r, "sdkmanager"));

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
        list_system_images_via_sdkmanager(p).await.unwrap_or_default()
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

// ============================================================
// APK BUILD FOR EMULATOR
// ============================================================

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

/// Log callback for streaming build output
pub type LogCallback = Box<dyn Fn(String) + Send + Sync>;

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
    
    // Install npm dependencies if needed
    let node_modules = config.project_root.join("node_modules");
    if !node_modules.exists() {
        if let Some(ref callback) = log_callback {
            callback("Installing npm dependencies...".to_string());
        }
        let npm_result = run_npm_install(&config.project_root, log_callback.as_ref()).await?;
        if !npm_result {
            bail!("npm install failed");
        }
    }
    
    // Determine APK path based on variant
    let (gradle_task, apk_path) = match config.variant {
        BuildVariant::Debug => (
            "assembleDebug",
            config.project_root.join("android/app/build/outputs/apk/debug/app-debug.apk"),
        ),
        BuildVariant::Release => (
            "assembleRelease",
            config.project_root.join("android/app/build/outputs/apk/release/app-release.apk"),
        ),
    };
    
    // Build APK using Gradle
    let android_dir = config.project_root.join("android");
    
    // Determine gradle wrapper path
    let gradlew = if cfg!(windows) {
        android_dir.join("gradlew.bat")
    } else {
        android_dir.join("gradlew")
    };

    if !gradlew.exists() {
        bail!(
            "Gradle wrapper not found at {} (expected Android project at {}). Ensure the React Native project contains android/gradlew.",
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

    // Construct Gradle command (direct exec) with a fallback via bash/sh.
    // In some environments, the wrapper can fail to exec with ENOENT due to
    // shebang/line-ending issues; bash/sh invocation is more robust.
    let mut cmd = Command::new(&gradlew);
    cmd.current_dir(&android_dir)
        .arg(gradle_task)
        .args(&config.extra_gradle_args)
        .envs(&config.env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            // Only try fallbacks for "not found" (os error 2).
            // Other errors (like permission denied) should be surfaced as-is.
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(anyhow::Error::new(e))
                    .context("Failed to spawn gradle build")
                    .context(format!("gradlew={} cwd={}", gradlew.display(), android_dir.display()));
            }

            let mut tried: Vec<&'static str> = vec![];
            let mut last_fallback_err: Option<std::io::Error> = None;
            let mut spawned: Option<tokio::process::Child> = None;

            for shell in ["bash", "sh"] {
                tried.push(shell);
                let mut alt = Command::new(shell);
                alt.current_dir(&android_dir)
                    .arg(gradlew.as_os_str())
                    .arg(gradle_task)
                    .args(&config.extra_gradle_args)
                    .envs(&config.env)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());

                match alt.spawn() {
                    Ok(c) => {
                        if let Some(ref callback) = log_callback {
                            callback(format!("Gradle wrapper fallback via {} succeeded", shell));
                        }
                        spawned = Some(c);
                        break;
                    }
                    Err(e2) => {
                        last_fallback_err = Some(e2);
                        if let Some(ref callback) = log_callback {
                            callback(format!(
                                "Gradle wrapper fallback via {} failed: {}",
                                shell,
                                last_fallback_err.as_ref().unwrap()
                            ));
                        }
                        // try next
                    }
                }
            }

            if let Some(c) = spawned {
                c
            } else {
                let fallback_context = last_fallback_err
                    .as_ref()
                    .map(|err| format!(" last_fallback_error={}", err))
                    .unwrap_or_default();

                return Err(anyhow::Error::new(e))
                    .context("Failed to spawn gradle build (direct exec and bash/sh fallback)")
                    .context(format!(
                        "gradlew={} cwd={} tried={:?}{}",
                        gradlew.display(),
                        android_dir.display(),
                        tried,
                        fallback_context
                    ));
            }
        }
    };
    
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    
    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();
    
    let mut diagnostics = vec![];
    
    // Stream output lines
    loop {
        tokio::select! {
            stdout_res = stdout_reader.next_line() => {
                match stdout_res {
                    Ok(Some(line_text)) => {
                        if let Some(ref callback) = log_callback {
                            callback(line_text.clone());
                        }
                        // Parse for diagnostics
                        if let Some(diag) = parse_gradle_diagnostic(&line_text) {
                            diagnostics.push(diag);
                        }
                        if let Some(diag) = parse_metro_diagnostic(&line_text) {
                            diagnostics.push(diag);
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        eprintln!("Error reading stdout: {}", e);
                        break;
                    }
                }
            }
            stderr_res = stderr_reader.next_line() => {
                match stderr_res {
                    Ok(Some(line_text)) => {
                        if let Some(ref callback) = log_callback {
                            callback(format!("[stderr] {}", line_text));
                        }
                        if let Some(diag) = parse_gradle_diagnostic(&line_text) {
                            diagnostics.push(diag);
                        }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        eprintln!("Error reading stderr: {}", e);
                    }
                }
            }
        }
    }
    
    let status = child.wait().await.context("Failed to wait for gradle build")?;
    let duration = start.elapsed().as_millis() as u64;
    
    let final_apk_path = if status.success() && apk_path.exists() {
        Some(apk_path)
    } else {
        None
    };
    
    Ok(EmulatorBuildResult {
        success: status.success(),
        apk_path: final_apk_path,
        app_id: project_info.app_id,
        build_duration_ms: duration,
        diagnostics,
    })
}

/// Runs `npm install` to install dependencies
async fn run_npm_install(project_root: &Path, log_callback: Option<&LogCallback>) -> Result<bool> {
    if let Some(callback) = log_callback {
        callback("Running: npm install".to_string());
    }
    
    let output = Command::new("npm")
        .current_dir(project_root)
        .args(["install"])
        .output()
        .await
        .context("Failed to run npm install")?;
    
    if let Some(callback) = log_callback {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            callback(line.to_string());
        }
    }
    
    Ok(output.status.success())
}

/// Parses a line for Gradle build errors
fn parse_gradle_diagnostic(line: &str) -> Option<Diagnostic> {
    // Match Gradle error patterns:
    // > Task :app:compileDebugJavaWithJavac FAILED
    // /path/to/File.java:10: error: ';' expected
    // e: /path/to/File.kt:10:5 Expecting ')'
    
    let trimmed = line.trim();
    
    // Java compiler errors
    if let Some(caps) = regex::Regex::new(r"^(.+\.java):(\d+):\s*(error|warning):\s*(.+)$")
        .ok()
        .and_then(|re| re.captures(trimmed))
    {
        let severity = match caps.get(3)?.as_str() {
            "error" => DiagnosticSeverity::Error,
            "warning" => DiagnosticSeverity::Warning,
            _ => return None,
        };
        return Some(Diagnostic {
            file: caps.get(1)?.as_str().to_string(),
            line: caps.get(2)?.as_str().parse().ok()?,
            column: 1,
            severity,
            message: caps.get(4)?.as_str().to_string(),
            code: None,
        });
    }
    
    // Kotlin compiler errors (e: prefix)
    if let Some(caps) = regex::Regex::new(r"^e:\s*(.+\.kt):(\d+):(\d+)\s+(.+)$")
        .ok()
        .and_then(|re| re.captures(trimmed))
    {
        return Some(Diagnostic {
            file: caps.get(1)?.as_str().to_string(),
            line: caps.get(2)?.as_str().parse().ok()?,
            column: caps.get(3)?.as_str().parse().ok()?,
            severity: DiagnosticSeverity::Error,
            message: caps.get(4)?.as_str().to_string(),
            code: None,
        });
    }
    
    None
}

/// Parses Metro bundler / JavaScript errors
fn parse_metro_diagnostic(line: &str) -> Option<Diagnostic> {
    // Match Metro/Babel/TypeScript errors:
    // ERROR  src/App.tsx:10:5 - error TS2322: Type 'string' is not assignable
    // SyntaxError: /path/to/file.js: Unexpected token (10:5)
    
    let trimmed = line.trim();
    
    // TypeScript errors from Metro
    if let Some(caps) = regex::Regex::new(r"^ERROR\s+(.+\.[jt]sx?):(\d+):(\d+)\s*-\s*error\s+(\w+):\s*(.+)$")
        .ok()
        .and_then(|re| re.captures(trimmed))
    {
        return Some(Diagnostic {
            file: caps.get(1)?.as_str().to_string(),
            line: caps.get(2)?.as_str().parse().ok()?,
            column: caps.get(3)?.as_str().parse().ok()?,
            severity: DiagnosticSeverity::Error,
            message: caps.get(5)?.as_str().to_string(),
            code: Some(caps.get(4)?.as_str().to_string()),
        });
    }
    
    // Babel syntax errors
    if let Some(caps) = regex::Regex::new(r"SyntaxError:\s*(.+\.[jt]sx?):\s*(.+)\s*\((\d+):(\d+)\)")
        .ok()
        .and_then(|re| re.captures(trimmed))
    {
        return Some(Diagnostic {
            file: caps.get(1)?.as_str().to_string(),
            line: caps.get(3)?.as_str().parse().ok()?,
            column: caps.get(4)?.as_str().parse().ok()?,
            severity: DiagnosticSeverity::Error,
            message: caps.get(2)?.as_str().to_string(),
            code: None,
        });
    }
    
    None
}

// ============================================================
// GRADLE CLEAN
// ============================================================

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

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_parse_gradle_java_error() {
        let line = "/src/main/java/com/app/MainActivity.java:25: error: ';' expected";
        let diag = parse_gradle_diagnostic(line).unwrap();
        
        assert_eq!(diag.file, "/src/main/java/com/app/MainActivity.java");
        assert_eq!(diag.line, 25);
        assert_eq!(diag.severity, DiagnosticSeverity::Error);
    }
    
    #[test]
    fn test_parse_gradle_kotlin_error() {
        let line = "e: /src/main/kotlin/App.kt:10:5 Expecting ')'";
        let diag = parse_gradle_diagnostic(line).unwrap();
        
        assert_eq!(diag.file, "/src/main/kotlin/App.kt");
        assert_eq!(diag.line, 10);
        assert_eq!(diag.column, 5);
        assert_eq!(diag.severity, DiagnosticSeverity::Error);
    }
    
    #[test]
    fn test_parse_metro_typescript_error() {
        let line = "ERROR  src/App.tsx:10:5 - error TS2322: Type 'string' is not assignable";
        let diag = parse_metro_diagnostic(line).unwrap();
        
        assert_eq!(diag.file, "src/App.tsx");
        assert_eq!(diag.line, 10);
        assert_eq!(diag.code, Some("TS2322".to_string()));
    }
    
    #[test]
    fn test_parse_non_diagnostic() {
        let line = "> Task :app:compileDebugJavaWithJavac";
        assert!(parse_gradle_diagnostic(line).is_none());
    }
}
