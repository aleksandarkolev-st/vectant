// ============================================================
// FLUTTER BUILDER MODULE
// ============================================================
// Handles Flutter project detection, validation, and compilation.
// Supports Android APK (debug) and Web builds on Linux workers.
// iOS builds require macOS workers (handled by routing).
// ============================================================

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::collections::HashMap;
use tokio::process::Command;
use tokio::io::{AsyncBufReadExt, BufReader};
use anyhow::{Result, Context, bail};
use serde::{Deserialize, Serialize};

use crate::mobile_routing::{
    BuildTarget, BuildVariant, FlutterProjectInfo, FlutterPlatform,
    FlutterDoctorResult, BuildDiagnostic, DiagnosticSeverity,
};

// ============================================================
// FLUTTER PROJECT DETECTION
// ============================================================

/// Detects if a directory contains a Flutter project
pub async fn detect_flutter_project(project_root: &Path) -> Result<FlutterProjectInfo> {
    let pubspec_path = project_root.join("pubspec.yaml");
    
    if !pubspec_path.exists() {
        return Ok(FlutterProjectInfo {
            is_flutter_project: false,
            pubspec_path: None,
            flutter_version_constraint: None,
            platforms: vec![],
            dependencies: vec![],
            dev_dependencies: vec![],
        });
    }
    
    // Read and parse pubspec.yaml
    let pubspec_content = tokio::fs::read_to_string(&pubspec_path)
        .await
        .context("Failed to read pubspec.yaml")?;
    
    let pubspec: PubspecYaml = serde_yaml::from_str(&pubspec_content)
        .context("Failed to parse pubspec.yaml")?;
    
    // Check for Flutter SDK dependency
    let is_flutter = pubspec.dependencies
        .as_ref()
        .map(|deps| deps.contains_key("flutter"))
        .unwrap_or(false);
    
    if !is_flutter {
        return Ok(FlutterProjectInfo {
            is_flutter_project: false,
            pubspec_path: Some(pubspec_path.to_string_lossy().to_string()),
            flutter_version_constraint: None,
            platforms: vec![],
            dependencies: pubspec.dependencies
                .map(|d| d.keys().cloned().collect())
                .unwrap_or_default(),
            dev_dependencies: pubspec.dev_dependencies
                .map(|d| d.keys().cloned().collect())
                .unwrap_or_default(),
        });
    }
    
    // Detect supported platforms by checking for platform directories
    let mut platforms = vec![];
    
    if project_root.join("android").exists() {
        platforms.push(FlutterPlatform::Android);
    }
    if project_root.join("ios").exists() {
        platforms.push(FlutterPlatform::Ios);
    }
    if project_root.join("web").exists() {
        platforms.push(FlutterPlatform::Web);
    }
    if project_root.join("linux").exists() {
        platforms.push(FlutterPlatform::Linux);
    }
    if project_root.join("macos").exists() {
        platforms.push(FlutterPlatform::Macos);
    }
    if project_root.join("windows").exists() {
        platforms.push(FlutterPlatform::Windows);
    }
    
    // Extract Flutter SDK constraint
    let flutter_constraint = pubspec.environment
        .as_ref()
        .and_then(|env| env.get("flutter"))
        .map(|v| v.to_string());
    
    Ok(FlutterProjectInfo {
        is_flutter_project: true,
        pubspec_path: Some(pubspec_path.to_string_lossy().to_string()),
        flutter_version_constraint: flutter_constraint,
        platforms,
        dependencies: pubspec.dependencies
            .map(|d| d.keys().cloned().collect())
            .unwrap_or_default(),
        dev_dependencies: pubspec.dev_dependencies
            .map(|d| d.keys().cloned().collect())
            .unwrap_or_default(),
    })
}

#[derive(Debug, Deserialize)]
struct PubspecYaml {
    name: Option<String>,
    dependencies: Option<HashMap<String, serde_yaml::Value>>,
    dev_dependencies: Option<HashMap<String, serde_yaml::Value>>,
    environment: Option<HashMap<String, String>>,
}

// ============================================================
// FLUTTER DOCTOR (HEALTH CHECK)
// ============================================================

/// Runs `flutter doctor` to check toolchain health
pub async fn run_flutter_doctor() -> Result<FlutterDoctorResult> {
    let output = Command::new("flutter")
        .args(["doctor", "--verbose"])
        .output()
        .await
        .context("Failed to run flutter doctor")?;
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    
    let mut issues = vec![];
    
    // Parse doctor output for issues
    let flutter_ok = stdout.contains("[✓] Flutter");
    let dart_ok = stdout.contains("[✓] Dart");
    let android_ok = stdout.contains("[✓] Android toolchain") 
        || stdout.contains("[✓] Android SDK");
    let xcode_ok = stdout.contains("[✓] Xcode");
    
    // Collect issues (lines starting with [✗] or [!])
    for line in stdout.lines() {
        if line.contains("[✗]") || line.contains("[!]") {
            issues.push(line.trim().to_string());
        }
    }
    
    if !stderr.is_empty() && !output.status.success() {
        issues.push(format!("stderr: {}", stderr.trim()));
    }
    
    Ok(FlutterDoctorResult {
        flutter_ok,
        dart_ok,
        android_toolchain_ok: android_ok,
        xcode_ok,
        issues,
    })
}

// ============================================================
// FLUTTER BUILD EXECUTION
// ============================================================

/// Configuration for a Flutter build
#[derive(Debug, Clone)]
pub struct FlutterBuildConfig {
    pub project_root: PathBuf,
    pub target: BuildTarget,
    pub variant: BuildVariant,
    pub entry_point: String,
    pub extra_args: Vec<String>,
    pub env: HashMap<String, String>,
}

/// Result of a Flutter build
#[derive(Debug, Clone)]
pub struct FlutterBuildResult {
    pub success: bool,
    pub artifact_path: Option<PathBuf>,
    pub artifact_size_bytes: Option<u64>,
    pub build_duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub diagnostics: Vec<BuildDiagnostic>,
}

/// Log callback for streaming build output
pub type LogCallback = Box<dyn Fn(String) + Send + Sync>;

/// Executes a Flutter build
pub async fn build_flutter(
    config: &FlutterBuildConfig,
    log_callback: Option<LogCallback>,
) -> Result<FlutterBuildResult> {
    let start = std::time::Instant::now();
    
    // Validate project exists
    if !config.project_root.exists() {
        bail!("Project root does not exist: {:?}", config.project_root);
    }
    
    // First, run pub get to ensure dependencies are resolved
    let pub_get_result = run_pub_get(&config.project_root, log_callback.as_ref()).await?;
    if !pub_get_result {
        bail!("flutter pub get failed");
    }
    
    // Build the command based on target
    let (subcommand, platform_args, artifact_path) = match config.target {
        BuildTarget::FlutterAndroidDebug => (
            "apk",
            vec!["--debug"],
            config.project_root.join("build/app/outputs/flutter-apk/app-debug.apk"),
        ),
        BuildTarget::FlutterAndroidRelease => (
            "apk",
            vec!["--release"],
            config.project_root.join("build/app/outputs/flutter-apk/app-release.apk"),
        ),
        BuildTarget::FlutterWeb => (
            "web",
            vec!["--release"],
            config.project_root.join("build/web"),
        ),
        BuildTarget::FlutterLinuxDesktop => (
            "linux",
            vec!["--release"],
            config.project_root.join("build/linux/x64/release/bundle"),
        ),
        BuildTarget::FlutterIosDebug => (
            "ios",
            vec!["--debug", "--no-codesign"],
            config.project_root.join("build/ios/iphoneos/Runner.app"),
        ),
        BuildTarget::FlutterIosRelease => (
            "ios",
            vec!["--release", "--no-codesign"],
            config.project_root.join("build/ios/iphoneos/Runner.app"),
        ),
        BuildTarget::FlutterMacosDesktop => (
            "macos",
            vec!["--release"],
            config.project_root.join("build/macos/Build/Products/Release"),
        ),
        _ => bail!("Unsupported Flutter build target: {:?}", config.target),
    };
    
    // Construct command
    let mut cmd = Command::new("flutter");
    cmd.current_dir(&config.project_root)
        .arg("build")
        .arg(subcommand)
        .args(&platform_args)
        .arg("--target")
        .arg(&config.entry_point)
        .args(&config.extra_args)
        .envs(&config.env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    
    if let Some(ref callback) = log_callback {
        callback(format!("Running: flutter build {} {:?}", subcommand, platform_args));
    }
    
    // Spawn and stream output
    let mut child = cmd.spawn().context("Failed to spawn flutter build")?;
    
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    
    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();
    
    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut diagnostics = vec![];
    
    // Stream output lines
    loop {
        tokio::select! {
            line = stdout_reader.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        if let Some(ref callback) = log_callback {
                            callback(l.clone());
                        }
                        stdout_buf.push_str(&l);
                        stdout_buf.push('\n');
                        
                        // Parse for diagnostics
                        if let Some(diag) = parse_flutter_diagnostic(&l) {
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
            line = stderr_reader.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        if let Some(ref callback) = log_callback {
                            callback(format!("[stderr] {}", l));
                        }
                        stderr_buf.push_str(&l);
                        stderr_buf.push('\n');
                        
                        if let Some(diag) = parse_flutter_diagnostic(&l) {
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
    
    let status = child.wait().await.context("Failed to wait for flutter build")?;
    let duration = start.elapsed().as_millis() as u64;
    
    // Check artifact exists
    let (final_artifact_path, artifact_size) = if status.success() && artifact_path.exists() {
        let size = if artifact_path.is_file() {
            tokio::fs::metadata(&artifact_path).await?.len()
        } else {
            // For directories (web, desktop), calculate total size
            calculate_dir_size(&artifact_path).await?
        };
        (Some(artifact_path), Some(size))
    } else {
        (None, None)
    };
    
    Ok(FlutterBuildResult {
        success: status.success(),
        artifact_path: final_artifact_path,
        artifact_size_bytes: artifact_size,
        build_duration_ms: duration,
        stdout: stdout_buf,
        stderr: stderr_buf,
        diagnostics,
    })
}

/// Runs `flutter pub get` to resolve dependencies
async fn run_pub_get(project_root: &Path, log_callback: Option<&LogCallback>) -> Result<bool> {
    if let Some(callback) = log_callback {
        callback("Running: flutter pub get".to_string());
    }
    
    let output = Command::new("flutter")
        .current_dir(project_root)
        .args(["pub", "get"])
        .output()
        .await
        .context("Failed to run flutter pub get")?;
    
    if let Some(callback) = log_callback {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            callback(line.to_string());
        }
    }
    
    Ok(output.status.success())
}

/// Parses a line for Dart/Flutter diagnostic messages
fn parse_flutter_diagnostic(line: &str) -> Option<BuildDiagnostic> {
    // Match patterns like:
    // lib/main.dart:10:5: Error: Expected ';' after this.
    // lib/main.dart:10:5: Warning: Unused variable.
    
    let re = regex::Regex::new(
        r"^(.+\.dart):(\d+):(\d+):\s*(Error|Warning|Info|Hint):\s*(.+)$"
    ).ok()?;
    
    let caps = re.captures(line)?;
    
    let severity = match caps.get(4)?.as_str() {
        "Error" => DiagnosticSeverity::Error,
        "Warning" => DiagnosticSeverity::Warning,
        "Info" => DiagnosticSeverity::Info,
        "Hint" => DiagnosticSeverity::Hint,
        _ => return None,
    };
    
    Some(BuildDiagnostic {
        file: caps.get(1)?.as_str().to_string(),
        line: caps.get(2)?.as_str().parse().ok()?,
        column: caps.get(3)?.as_str().parse().ok()?,
        severity,
        message: caps.get(5)?.as_str().to_string(),
        code: None,
    })
}

/// Calculates total size of a directory recursively
async fn calculate_dir_size(path: &Path) -> Result<u64> {
    let mut total = 0u64;
    let mut entries = tokio::fs::read_dir(path).await?;
    
    while let Some(entry) = entries.next_entry().await? {
        let metadata = entry.metadata().await?;
        if metadata.is_file() {
            total += metadata.len();
        } else if metadata.is_dir() {
            total += Box::pin(calculate_dir_size(&entry.path())).await?;
        }
    }
    
    Ok(total)
}

// ============================================================
// FLUTTER ANALYZE (STATIC ANALYSIS)
// ============================================================

/// Runs `flutter analyze` for static analysis
pub async fn analyze_flutter(
    project_root: &Path,
    log_callback: Option<&LogCallback>,
) -> Result<Vec<BuildDiagnostic>> {
    if let Some(callback) = log_callback {
        callback("Running: flutter analyze".to_string());
    }
    
    let output = Command::new("flutter")
        .current_dir(project_root)
        .args(["analyze", "--no-fatal-warnings"])
        .output()
        .await
        .context("Failed to run flutter analyze")?;
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut diagnostics = vec![];
    
    for line in stdout.lines() {
        if let Some(diag) = parse_flutter_diagnostic(line) {
            diagnostics.push(diag);
        }
    }
    
    Ok(diagnostics)
}

// ============================================================
// FLUTTER CLEAN
// ============================================================

/// Runs `flutter clean` to clear build artifacts
pub async fn clean_flutter(project_root: &Path) -> Result<()> {
    Command::new("flutter")
        .current_dir(project_root)
        .arg("clean")
        .output()
        .await
        .context("Failed to run flutter clean")?;
    
    Ok(())
}

// ============================================================
// ARTIFACT PACKAGING
// ============================================================

/// Packages build artifacts for upload (e.g., zip web build)
pub async fn package_artifact(
    artifact_path: &Path,
    output_path: &Path,
) -> Result<PathBuf> {
    if artifact_path.is_file() {
        // Single file (APK, etc.) - just copy
        tokio::fs::copy(artifact_path, output_path).await?;
        Ok(output_path.to_path_buf())
    } else if artifact_path.is_dir() {
        // Directory (web, desktop) - create zip
        let zip_path = output_path.with_extension("zip");
        
        // Use zip command (available on Linux)
        let status = Command::new("zip")
            .args(["-r", "-q"])
            .arg(&zip_path)
            .arg(".")
            .current_dir(artifact_path)
            .status()
            .await
            .context("Failed to create zip archive")?;
        
        if !status.success() {
            bail!("zip command failed");
        }
        
        Ok(zip_path)
    } else {
        bail!("Artifact path does not exist: {:?}", artifact_path);
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_parse_flutter_diagnostic() {
        let line = "lib/main.dart:10:5: Error: Expected ';' after this.";
        let diag = parse_flutter_diagnostic(line).unwrap();
        
        assert_eq!(diag.file, "lib/main.dart");
        assert_eq!(diag.line, 10);
        assert_eq!(diag.column, 5);
        assert_eq!(diag.severity, DiagnosticSeverity::Error);
        assert_eq!(diag.message, "Expected ';' after this.");
    }
    
    #[test]
    fn test_parse_warning() {
        let line = "lib/utils.dart:25:3: Warning: Unused import.";
        let diag = parse_flutter_diagnostic(line).unwrap();
        
        assert_eq!(diag.severity, DiagnosticSeverity::Warning);
    }
    
    #[test]
    fn test_parse_non_diagnostic() {
        let line = "Building flutter tool...";
        assert!(parse_flutter_diagnostic(line).is_none());
    }
}
