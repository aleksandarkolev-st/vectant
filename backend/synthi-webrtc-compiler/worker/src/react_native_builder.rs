// ============================================================
// REACT NATIVE BUILDER MODULE
// ============================================================
// Builds React Native Android APKs for emulator execution.
// Uses Gradle for Android builds, Metro bundler for JS.
// APKs are installed directly to emulator - no artifact download.
// ============================================================

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

use crate::env_setup;
use crate::mobile_routing::{
    AndroidSdkHealth, Diagnostic, DiagnosticSeverity, ReactNativeProjectInfo,
};

#[derive(Debug, Clone, Copy)]
struct WrapperJarHealth {
    exists: bool,
    size_bytes: u64,
    looks_like_zip: bool,
}

async fn check_wrapper_jar_health(android_dir: &Path) -> WrapperJarHealth {
    let jar = android_dir.join("gradle/wrapper/gradle-wrapper.jar");
    let meta = tokio::fs::metadata(&jar).await;
    let (exists, size_bytes) = match meta {
        Ok(m) => (true, m.len()),
        Err(_) => (false, 0),
    };

    let looks_like_zip = if exists && size_bytes >= 4 {
        match tokio::fs::read(&jar).await {
            Ok(bytes) if bytes.len() >= 4 => bytes[0..2] == [b'P', b'K'],
            _ => false,
        }
    } else {
        false
    };

    WrapperJarHealth {
        exists,
        size_bytes,
        looks_like_zip,
    }
}

async fn system_gradle_available() -> bool {
    // Cheap check: `gradle -v` should exit 0 if installed.
    Command::new("gradle")
        .arg("-v")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn read_gradle_distribution_url(android_dir: &Path) -> Option<String> {
    let props_path = android_dir.join("gradle/wrapper/gradle-wrapper.properties");
    let content = tokio::fs::read_to_string(&props_path).await.ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("distributionUrl=") {
            return Some(unescape_java_properties_value(rest.trim()));
        }
    }
    None
}

fn unescape_java_properties_value(input: &str) -> String {
    // Minimal Java .properties value unescape.
    // Needed for Gradle wrapper values like `https\://services.gradle.org/...`.
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }

        match chars.next() {
            None => {
                // Trailing backslash; keep it.
                out.push('\\');
            }
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('f') => out.push('\u{000C}'),
            Some('u') => {
                let mut hex = String::new();
                for _ in 0..4 {
                    if let Some(h) = chars.next() {
                        hex.push(h);
                    } else {
                        break;
                    }
                }
                if hex.len() == 4 {
                    if let Ok(code) = u16::from_str_radix(&hex, 16) {
                        if let Some(ch) = char::from_u32(code as u32) {
                            out.push(ch);
                            continue;
                        }
                    }
                }
                // If unicode escape was invalid, keep the raw sequence.
                out.push('u');
                out.push_str(&hex);
            }
            Some(other) => {
                // Default: backslash escapes the next char as-is (e.g. \:, \=, \\).
                out.push(other);
            }
        }
    }
    out
}

fn safe_zip_entry_path(name: &str) -> Option<PathBuf> {
    // Prevent zip-slip. Only allow relative paths.
    let p = Path::new(name);
    if p.is_absolute() {
        return None;
    }
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(p.to_path_buf())
}

async fn ensure_gradle_distribution(
    android_dir: &Path,
    distribution_url: &str,
    log_callback: Option<&LogCallback>,
) -> Result<PathBuf> {
    let cache_root = android_dir.join(".synthi/gradle-dist");
    tokio::fs::create_dir_all(&cache_root).await.ok();

    let url_hash = crate::builder::hash_content(distribution_url).to_string();
    let zip_path = cache_root.join(format!("dist_{}.zip", url_hash));
    let extract_root = cache_root.join(format!("dist_{}", url_hash));

    // If already extracted and executable exists, reuse.
    let existing_gradle = extract_root.join("bin/gradle");
    if existing_gradle.exists() {
        return Ok(existing_gradle);
    }

    if let Some(cb) = log_callback {
        cb(format!(
            "Downloading Gradle distribution: {}",
            distribution_url
        ));
    }

    // Stream download to disk to avoid holding the whole zip in memory.
    let client = reqwest::Client::new();
    let resp = client
        .get(distribution_url)
        .send()
        .await
        .with_context(|| {
            format!(
                "Failed to download Gradle distribution: {}",
                distribution_url
            )
        })?
        .error_for_status()
        .with_context(|| format!("Gradle distribution HTTP error: {}", distribution_url))?;

    let mut file = tokio::fs::File::create(&zip_path)
        .await
        .with_context(|| format!("Failed to create {}", zip_path.display()))?;

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.context("Error while downloading Gradle distribution")?;
        use tokio::io::AsyncWriteExt;
        file.write_all(&bytes)
            .await
            .context("Failed writing Gradle zip")?;
    }

    if let Some(cb) = log_callback {
        cb(format!(
            "Extracting Gradle distribution to {}",
            extract_root.display()
        ));
    }

    tokio::fs::create_dir_all(&extract_root).await.ok();

    // Unzip with std::fs because zip::ZipArchive requires Read+Seek.
    let zip_file = std::fs::File::open(&zip_path)
        .with_context(|| format!("Failed to open {}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(zip_file).context("Failed to read Gradle zip")?;

    // Gradle distribution zip contains a single top-level folder: gradle-<ver>/...
    // We extract its contents into extract_root, stripping that top-level folder.
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).context("Failed to read zip entry")?;
        let name = entry.name().to_string();
        let rel = match safe_zip_entry_path(&name) {
            Some(p) => p,
            None => continue,
        };

        // Strip the first path component (gradle-<ver>/...).
        let mut comps = rel.components();
        comps.next();
        let stripped: PathBuf = comps.collect();
        if stripped.as_os_str().is_empty() {
            continue;
        }

        let out_path = extract_root.join(stripped);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).ok();
            continue;
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        let mut out = std::fs::File::create(&out_path)
            .with_context(|| format!("Failed to create {}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out)
            .with_context(|| format!("Failed to write {}", out_path.display()))?;

        // Preserve executable bit for gradle launcher on Unix.
        #[cfg(unix)]
        {
            if let Some(mode) = entry.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode));
            }
        }
    }

    let gradle_bin = extract_root.join("bin/gradle");
    if !gradle_bin.exists() {
        bail!(
            "Gradle distribution extracted but bin/gradle not found at {}",
            gradle_bin.display()
        );
    }

    // Ensure executable bit in case zip permissions weren't preserved.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&gradle_bin, std::fs::Permissions::from_mode(0o755));
    }

    Ok(gradle_bin)
}

async fn list_dir_for_debug(path: &Path, log_callback: Option<&LogCallback>, label: &str) {
    if let Some(cb) = log_callback {
        cb(format!("{label}: {}", path.display()));
        let mut entries: Vec<String> = Vec::new();
        if let Ok(mut rd) = tokio::fs::read_dir(path).await {
            while let Ok(Some(ent)) = rd.next_entry().await {
                let p = ent.path();
                let ft = ent.file_type().await.ok();
                let kind = if ft.as_ref().map(|t| t.is_dir()).unwrap_or(false) {
                    "dir"
                } else if ft.as_ref().map(|t| t.is_file()).unwrap_or(false) {
                    "file"
                } else {
                    "other"
                };
                entries.push(format!(
                    "- [{kind}] {}",
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("<unknown>")
                ));
            }
        }
        entries.sort();
        for line in entries {
            cb(line);
        }
    }
}

async fn find_files_recursive(
    dir: &Path,
    file_names: &[&str],
    out: &mut Vec<PathBuf>,
) -> Result<()> {
    // NOTE: This is intentionally iterative (no async recursion), because recursive `async fn`
    // requires boxing to avoid an infinitely sized future.
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];

    while let Some(current_dir) = stack.pop() {
        let mut rd = match tokio::fs::read_dir(&current_dir).await {
            Ok(r) => r,
            Err(_) => continue,
        };

        while let Some(entry) = rd.next_entry().await? {
            let path = entry.path();
            let ft = entry.file_type().await?;

            if ft.is_dir() {
                stack.push(path);
                continue;
            }

            if ft.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if file_names.iter().any(|target| *target == name) {
                        out.push(path);
                    }
                }
            }
        }
    }

    Ok(())
}

async fn patch_main_component_name(
    android_dir: &Path,
    app_name: &str,
    log_callback: Option<&LogCallback>,
) -> Result<()> {
    let java_root = android_dir.join("app/src/main/java");
    let kotlin_root = android_dir.join("app/src/main/kotlin");
    let mut candidates: Vec<PathBuf> = Vec::new();
    find_files_recursive(
        &java_root,
        &["MainActivity.java", "MainActivity.kt"],
        &mut candidates,
    )
    .await?;
    find_files_recursive(
        &kotlin_root,
        &["MainActivity.java", "MainActivity.kt"],
        &mut candidates,
    )
    .await?;

    // Best-effort patch: update the getMainComponentName return value.
    for file in candidates {
        let Ok(content) = tokio::fs::read_to_string(&file).await else {
            continue;
        };
        if !content.contains("getMainComponentName") {
            continue;
        }

        let mut updated = content.clone();

        // Common patterns:
        // Java: return "HelloWorld";
        // Kotlin: return "HelloWorld"
        // We only replace inside MainActivity to avoid rewriting other identifiers.
        updated = updated.replace("\"HelloWorld\"", &format!("\"{}\"", app_name));
        updated = updated.replace("'HelloWorld'", &format!("'{}'", app_name));

        if updated != content {
            tokio::fs::write(&file, updated).await.ok();
            if let Some(cb) = log_callback {
                cb(format!(
                    "Patched MainActivity component name in {}",
                    file.display()
                ));
            }
        }
    }

    Ok(())
}

fn android_has_settings(android_dir: &Path) -> bool {
    android_dir.join("settings.gradle").exists() || android_dir.join("settings.gradle.kts").exists()
}

fn android_has_root_build_gradle(android_dir: &Path) -> bool {
    android_dir.join("build.gradle").exists() || android_dir.join("build.gradle.kts").exists()
}

fn android_has_gradle_wrapper_scripts(android_dir: &Path) -> bool {
    android_dir.join("gradlew").exists() || android_dir.join("gradlew.bat").exists()
}

fn android_has_gradle_wrapper_files(android_dir: &Path) -> bool {
    let wrapper_dir = android_dir.join("gradle/wrapper");
    wrapper_dir.join("gradle-wrapper.properties").exists()
        && wrapper_dir.join("gradle-wrapper.jar").exists()
}

fn android_dir_missing_required_files(android_dir: &Path) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if !android_dir.exists() {
        missing.push("android/ directory");
        return missing;
    }
    if !android_has_settings(android_dir) {
        missing.push("android/settings.gradle (or settings.gradle.kts)");
    }
    if !android_has_root_build_gradle(android_dir) {
        missing.push("android/build.gradle (or build.gradle.kts)");
    }
    if !android_has_gradle_wrapper_scripts(android_dir) {
        missing.push("android/gradlew (or gradlew.bat)");
    }
    if !android_has_gradle_wrapper_files(android_dir) {
        missing.push("android/gradle/wrapper/gradle-wrapper.properties + gradle-wrapper.jar");
    }
    missing
}

fn android_dir_is_ready_for_first_gradle_invocation(android_dir: &Path) -> bool {
    android_dir_missing_required_files(android_dir).is_empty()
}

async fn read_package_json(project_root: &Path) -> Option<PackageJson> {
    let package_json_path = project_root.join("package.json");
    let content = tokio::fs::read_to_string(&package_json_path).await.ok()?;
    serde_json::from_str(&content).ok()
}

fn package_has_dependency(package: &PackageJson, dep: &str) -> bool {
    package
        .dependencies
        .as_ref()
        .map(|d| d.contains_key(dep))
        .unwrap_or(false)
        || package
            .dev_dependencies
            .as_ref()
            .map(|d| d.contains_key(dep))
            .unwrap_or(false)
}

async fn read_app_json_name(project_root: &Path) -> Option<String> {
    let app_json_path = project_root.join("app.json");
    let content = tokio::fs::read_to_string(&app_json_path).await.ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    v.get("name")
        .and_then(|n| n.as_str())
        .map(|s| s.to_string())
}

fn sanitize_rn_project_name(name: &str) -> String {
    // React Native init expects a valid project name.
    // Keep ASCII letters/digits, start with a letter.
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        }
    }
    if out.is_empty() || !out.chars().next().unwrap_or('A').is_ascii_alphabetic() {
        out.insert_str(0, "App");
    }
    // Avoid very long names.
    out.chars().take(40).collect()
}

async fn run_command_and_log_output(
    mut cmd: Command,
    log_callback: Option<&LogCallback>,
    label: &str,
) -> Result<std::process::ExitStatus> {
    if let Some(cb) = log_callback {
        cb(format!("Running: {}", label));
    }

    let output = cmd
        .output()
        .await
        .with_context(|| format!("Failed to run {}", label))?;

    if let Some(cb) = log_callback {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            cb(line.to_string());
        }
        for line in String::from_utf8_lossy(&output.stderr).lines() {
            cb(format!("[stderr] {}", line));
        }
    }

    Ok(output.status)
}

#[derive(Debug, Clone)]
struct NodeInfo {
    version: String,
    major: u64,
    exec_path: Option<String>,
}

fn parse_node_major(version: &str) -> Option<u64> {
    let v = version.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    v.split('.').next()?.parse::<u64>().ok()
}

async fn detect_node_info() -> Option<NodeInfo> {
    // Prefer `process.version` + `process.execPath` so we know *which* Node binary is used.
    let output = Command::new("node")
        .args(["-p", "process.version + '\\n' + (process.execPath || '')"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .ok()?;
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout);
        let mut lines = text.lines();
        let version = lines.next()?.trim().to_string();
        let exec = lines.next().unwrap_or("").trim().to_string();
        let major = parse_node_major(&version)?;
        let exec_path = if exec.is_empty() { None } else { Some(exec) };
        return Some(NodeInfo {
            version,
            major,
            exec_path,
        });
    }

    // Fallback: `node -v`.
    let output = Command::new("node")
        .arg("-v")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let major = parse_node_major(&version)?;
    Some(NodeInfo {
        version,
        major,
        exec_path: None,
    })
}

async fn list_child_dirs(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return out;
    };
    while let Ok(Some(ent)) = rd.next_entry().await {
        if ent
            .file_type()
            .await
            .ok()
            .map(|t| t.is_dir())
            .unwrap_or(false)
        {
            if let Some(name) = ent.file_name().to_str() {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    out
}

async fn find_generated_project_root(
    temp_root: &Path,
    expected: &Path,
    before_dirs: &[String],
    log_callback: Option<&LogCallback>,
) -> PathBuf {
    async fn discover_by_android_sentinels(
        temp_root: &Path,
        log_callback: Option<&LogCallback>,
    ) -> Option<PathBuf> {
        // Some init implementations can create nested paths or different folder names.
        // As a last-resort, scan the temp_root for a valid android/ directory and
        // infer the project root from it.
        let mut candidates: Vec<PathBuf> = Vec::new();
        let _ = find_files_recursive(
            temp_root,
            &["settings.gradle", "settings.gradle.kts"],
            &mut candidates,
        )
        .await;

        for settings in candidates {
            let Some(android_dir) = settings.parent() else {
                continue;
            };
            if android_dir
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n == "android")
                .unwrap_or(false)
                && android_dir_is_ready_for_first_gradle_invocation(android_dir)
            {
                let Some(root) = android_dir.parent() else {
                    continue;
                };
                if let Some(cb) = log_callback {
                    cb(format!(
                        "Discovered RN project root via android/ sentinels: {}",
                        root.display()
                    ));
                }
                return Some(root.to_path_buf());
            }
        }

        None
    }

    if expected.exists() {
        return expected.to_path_buf();
    }

    let after_dirs = list_child_dirs(temp_root).await;
    let mut new_dirs: Vec<String> = after_dirs
        .into_iter()
        .filter(|d| !before_dirs.contains(d))
        .collect();
    new_dirs.sort();

    if let Some(cb) = log_callback {
        cb(format!(
            "Expected RN project dir missing; discovered new dirs: {:?}",
            new_dirs
        ));
    }

    // If nothing obvious was created at the top-level, attempt a sentinel scan.
    if new_dirs.is_empty() {
        if let Some(root) = discover_by_android_sentinels(temp_root, log_callback).await {
            return root;
        }
    }

    // Prefer a directory that actually has android/.
    for d in &new_dirs {
        let candidate = temp_root.join(d);
        if candidate.join("android").exists() {
            if let Some(cb) = log_callback {
                cb(format!(
                    "Using discovered RN project dir: {}",
                    candidate.display()
                ));
            }
            return candidate;
        }
    }

    // Next: a directory that has package.json.
    for d in &new_dirs {
        let candidate = temp_root.join(d);
        if candidate.join("package.json").exists() {
            if let Some(cb) = log_callback {
                cb(format!(
                    "Using discovered RN project dir: {}",
                    candidate.display()
                ));
            }
            return candidate;
        }
    }

    // If there's exactly one new dir, use it.
    if new_dirs.len() == 1 {
        let candidate = temp_root.join(&new_dirs[0]);
        if let Some(cb) = log_callback {
            cb(format!(
                "Using discovered RN project dir: {}",
                candidate.display()
            ));
        }
        return candidate;
    }

    // Last-resort scan even if there were multiple new dirs.
    if let Some(root) = discover_by_android_sentinels(temp_root, log_callback).await {
        return root;
    }

    // Fall back to the expected path even if it doesn't exist, so callers can log it.
    expected.to_path_buf()
}

async fn ensure_android_gradle_project(
    project_root: &Path,
    android_dir: &Path,
    rn_version: Option<&str>,
    log_callback: Option<&LogCallback>,
) -> Result<()> {
    if android_dir_is_ready_for_first_gradle_invocation(android_dir) {
        return Ok(());
    }

    let missing = android_dir_missing_required_files(android_dir);
    if let Some(cb) = log_callback {
        cb(format!(
            "Android Gradle project is missing required files: {}",
            missing.join(", ")
        ));
        cb("Generating android/ via React Native CLI".to_string());
    }

    let package_json_path = project_root.join("package.json");
    if !package_json_path.exists() {
        bail!(
            "Cannot generate android/: package.json not found at {}",
            package_json_path.display()
        );
    }

    let package_content = tokio::fs::read_to_string(&package_json_path)
        .await
        .with_context(|| format!("Failed to read {}", package_json_path.display()))?;
    let package: PackageJson = serde_json::from_str(&package_content)
        .with_context(|| format!("Failed to parse {}", package_json_path.display()))?;

    fn dep_version_string(pkg: &PackageJson, name: &str) -> Option<String> {
        let v = pkg
            .dependencies
            .as_ref()
            .and_then(|d| d.get(name))
            .or_else(|| pkg.dev_dependencies.as_ref().and_then(|d| d.get(name)))?;
        v.as_str().map(|s| s.to_string())
    }

    fn resolve_rn_cli_version(spec: &str) -> Result<String> {
        // Accept: 0.73.6, 0.73.6-rc.2, ^0.73.6, ~0.73.6
        // Reject: 0.7x.x, workspace:*, file:..., ranges like ">=0.72 <0.74".
        let s = spec.trim();
        let s = s
            .strip_prefix('^')
            .or_else(|| s.strip_prefix('~'))
            .unwrap_or(s);
        // Must be an exact semver-ish token (optionally with prerelease).
        let re = regex::Regex::new(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$").unwrap();
        if let Some(c) = re.captures(s) {
            let major: u64 = c.get(1).unwrap().as_str().parse().unwrap_or(999);
            let minor: u64 = c.get(2).unwrap().as_str().parse().unwrap_or(999);
            let _patch: u64 = c.get(3).unwrap().as_str().parse().unwrap_or(999);
            // React Native uses 0.xx.y today; reject obviously wrong majors.
            if major != 0 {
                bail!("Invalid react-native version '{spec}': expected 0.x.y (e.g. 0.73.6)");
            }
            // Extra guard for common typos like 0.7x.x: regex already rejects.
            if minor < 50 {
                bail!("Invalid react-native version '{spec}': expected a modern 0.xx.y version (e.g. 0.73.6)");
            }
            return Ok(s.to_string());
        }
        bail!(
            "Invalid react-native version spec '{spec}'. Use an exact version like 0.73.6 (or ^0.73.6 / ~0.73.6)."
        )
    }

    let rn_spec_from_pkg = dep_version_string(&package, "react-native");
    let rn_spec = rn_spec_from_pkg
        .as_deref()
        .or(rn_version)
        .ok_or_else(|| anyhow::anyhow!("react-native dependency not found in package.json"))?;
    let rn_ver = resolve_rn_cli_version(rn_spec).with_context(|| {
        "Cannot generate android/: react-native version is not a valid concrete semver".to_string()
    })?;

    let app_name = read_app_json_name(project_root)
        .await
        .or_else(|| package.name.clone())
        .unwrap_or_else(|| "App".to_string());
    let init_name = sanitize_rn_project_name(&app_name);
    let temp_project_name = format!("{}{}", init_name, &Uuid::new_v4().simple().to_string()[..8]);

    // Canonical flow: generate into an isolated temp dir and copy back only android/.
    let temp_root = project_root
        .join(".synthi")
        .join("rn-init")
        .join(Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&temp_root)
        .await
        .with_context(|| format!("Failed to create {}", temp_root.display()))?;

    #[derive(Clone, Copy, Debug)]
    enum RnInitStrategy {
        /// Uses `npx @react-native-community/cli init <name> ...`.
        /// This is the recommended replacement for the deprecated `react-native init`.
        CommunityCli,
        /// Uses the exact form: `npx react-native@<ver> init <name> ...`
        PackagePinned,
        /// Uses `npx react-native init <name> --version <ver> ...`.
        /// This is still React Native CLI-only, but avoids cases where package-pinning
        /// doesn't actually result in the desired template/version being generated.
        VersionFlagPinned,
        /// Uses `npx --package react-native@<ver> -- react-native init <name> ...`.
        PackageFlagPinned,
    }

    async fn try_rn_init(
        temp_root: &Path,
        rn_ver: &str,
        temp_project_name: &str,
        flags: &[&str],
        log_callback: Option<&LogCallback>,
        label: &str,
        strategy: RnInitStrategy,
    ) -> Result<std::process::ExitStatus> {
        let temp_project_root = temp_root.join(temp_project_name);
        if temp_project_root.exists() {
            let _ = tokio::fs::remove_dir_all(&temp_project_root).await;
        }

        let mut cmd = Command::new("npx");
        cmd.current_dir(temp_root)
            .env("CI", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            // Non-interactive: prevent npx prompts (important for worker/CI).
            .arg("--yes");

        match strategy {
            RnInitStrategy::CommunityCli => {
                // `react-native init` is deprecated and can exit early in modern CLIs.
                // Use the community CLI directly.
                cmd.args([
                    "@react-native-community/cli",
                    "init",
                    temp_project_name,
                    "--version",
                    rn_ver,
                ]);
            }
            RnInitStrategy::PackagePinned => {
                cmd.args([
                    &format!("react-native@{}", rn_ver),
                    "init",
                    temp_project_name,
                ]);
            }
            RnInitStrategy::VersionFlagPinned => {
                cmd.args([
                    "react-native",
                    "init",
                    temp_project_name,
                    "--version",
                    rn_ver,
                ]);
            }
            RnInitStrategy::PackageFlagPinned => {
                cmd.args([
                    "--package",
                    &format!("react-native@{}", rn_ver),
                    "--",
                    "react-native",
                    "init",
                    temp_project_name,
                ]);
            }
        }

        cmd.args(flags);
        run_command_and_log_output(cmd, log_callback, label).await
    }

    // We intentionally try a small number of well-known React Native CLI forms.
    // Some environments appear to exit 0 but fail to generate `android/`.
    // In those cases, a different invocation style can succeed without user intervention.
    let common_flags: Vec<&'static str> = vec!["--skip-install", "--skip-git-init", "--verbose"];
    let fallback_flags: Vec<&'static str> = vec!["--skip-git-init", "--verbose"];

    let node_info = detect_node_info().await;
    let node_major = node_info.as_ref().map(|n| n.major);
    if let Some(cb) = log_callback {
        let version_str = node_info
            .as_ref()
            .map(|n| n.version.clone())
            .unwrap_or_else(|| "<unknown>".to_string());
        let exec_str = node_info
            .as_ref()
            .and_then(|n| n.exec_path.clone())
            .unwrap_or_else(|| "<unknown>".to_string());
        cb(format!("Worker node version: {version_str}"));
        cb(format!("Worker node execPath: {exec_str}"));

        if let Ok(path) = std::env::var("PATH") {
            // Keep logs readable; show only the first chunk.
            let snippet: String = path.chars().take(300).collect();
            cb(format!("Worker PATH (prefix): {snippet}"));
        }
    }

    // React Native tooling has increasingly strict Node requirements.
    // In practice, init can "succeed" (exit 0) while not generating android/ when Node is too old.
    // Your logs show dependencies requiring Node >= 20.19.4.
    if node_major.unwrap_or(0) < 20 {
        let version_str = node_info
            .as_ref()
            .map(|n| n.version.clone())
            .unwrap_or_else(|| "<unknown>".to_string());
        let exec_str = node_info
            .as_ref()
            .and_then(|n| n.exec_path.clone())
            .unwrap_or_else(|| "<unknown>".to_string());
        bail!(
            "React Native CLI requires Node.js >= 20.19.4 in the worker (detected {version_str} at {exec_str}). \
This usually means the worker process is using a different Node than your interactive shell (PATH/service/container). \
Ensure Node 20.19.4+ is on PATH for the worker process and restart the worker, then retry."
        );
    }

    let mut init_attempts: Vec<(&'static str, RnInitStrategy, Vec<&'static str>)> = vec![
        (
            "npx @react-native-community/cli init --version <ver> (skip-install, skip-git-init)",
            RnInitStrategy::CommunityCli,
            common_flags.clone(),
        ),
        (
            "npx react-native@<ver> init (skip-install, skip-git-init)",
            RnInitStrategy::PackagePinned,
            common_flags.clone(),
        ),
        (
            "npx --package react-native@<ver> -- react-native init (skip-install, skip-git-init)",
            RnInitStrategy::PackageFlagPinned,
            common_flags.clone(),
        ),
        (
            "npx react-native@<ver> init (skip-git-init)",
            RnInitStrategy::PackagePinned,
            fallback_flags.clone(),
        ),
    ];

    // The `react-native init --version <ver>` form is known to crash on Node 18
    // (`util.styleText` is Node 20+). Only attempt it on Node >= 20.
    if node_major.unwrap_or(0) >= 20 {
        init_attempts.insert(
            1,
            (
                "npx react-native init --version <ver> (skip-install, skip-git-init)",
                RnInitStrategy::VersionFlagPinned,
                common_flags.clone(),
            ),
        );
        init_attempts.push((
            "npx react-native init --version <ver> (skip-git-init)",
            RnInitStrategy::VersionFlagPinned,
            fallback_flags.clone(),
        ));
    }

    if let Some(cb) = log_callback {
        cb(format!(
            "Running: RN init into temp dir (rn_ver={}, name={}, cwd={})",
            rn_ver,
            temp_project_name,
            temp_root.display()
        ));
    }

    let mut last_status: Option<std::process::ExitStatus> = None;
    for (label, strategy, flags) in init_attempts {
        let before_dirs = list_child_dirs(&temp_root).await;
        let status = try_rn_init(
            &temp_root,
            &rn_ver,
            &temp_project_name,
            &flags,
            log_callback,
            label,
            strategy,
        )
        .await?;
        last_status = Some(status);

        let expected_project_root = temp_root.join(&temp_project_name);
        let generated_project_root = find_generated_project_root(
            &temp_root,
            &expected_project_root,
            &before_dirs,
            log_callback,
        )
        .await;
        let generated_android_dir = generated_project_root.join("android");
        if android_dir_is_ready_for_first_gradle_invocation(&generated_android_dir) {
            break;
        }

        if let Some(cb) = log_callback {
            cb(format!(
                "RN init attempt did not yield a ready android/. status={:?}",
                status.code()
            ));
            list_dir_for_debug(&generated_project_root, Some(cb), "generated project root").await;
            if generated_android_dir.exists() {
                list_dir_for_debug(&generated_android_dir, Some(cb), "generated android/").await;
            }
        }
    }

    let expected_project_root = temp_root.join(&temp_project_name);
    let generated_project_root = find_generated_project_root(
        &temp_root,
        &expected_project_root,
        &list_child_dirs(&temp_root).await,
        log_callback,
    )
    .await;
    let generated_android_dir = generated_project_root.join("android");
    if !android_dir_is_ready_for_first_gradle_invocation(&generated_android_dir) {
        if let Some(cb) = log_callback {
            cb(format!(
                "RN init did not produce a valid Android Gradle project (exit_code={:?}).",
                last_status.and_then(|s| s.code())
            ));
            list_dir_for_debug(&generated_project_root, Some(cb), "generated project root").await;
            if generated_android_dir.exists() {
                list_dir_for_debug(&generated_android_dir, Some(cb), "generated android/").await;
            }
        }

        let missing_gen = android_dir_missing_required_files(&generated_android_dir);
        bail!(
            "Failed to generate android/ via React Native CLI. Missing in generated android/: {}. \
Ensure `npx` can download react-native@{} and that Node/npm are available in the worker.",
            missing_gen.join(", "),
            rn_ver
        );
    }

    async fn copy_dir_selective(
        src_root: &Path,
        dst_root: &Path,
        should_overwrite: &impl Fn(&str) -> bool,
    ) -> Result<()> {
        tokio::fs::create_dir_all(dst_root)
            .await
            .with_context(|| format!("Failed to create {}", dst_root.display()))?;

        // Iterative walk to avoid recursive async fn.
        let mut stack: Vec<(PathBuf, PathBuf, String)> = vec![(
            src_root.to_path_buf(),
            dst_root.to_path_buf(),
            String::new(),
        )];

        while let Some((src_dir, dst_dir, rel_prefix)) = stack.pop() {
            let mut rd = tokio::fs::read_dir(&src_dir)
                .await
                .with_context(|| format!("Failed to read dir {}", src_dir.display()))?;

            while let Some(ent) = rd.next_entry().await? {
                let src_path = ent.path();
                let name = ent.file_name();
                let name_str = name.to_string_lossy().to_string();
                let rel = if rel_prefix.is_empty() {
                    name_str.clone()
                } else {
                    format!("{}/{}", rel_prefix, name_str)
                };

                let ft = ent.file_type().await?;
                let dst_path = dst_dir.join(&name);

                if ft.is_dir() {
                    tokio::fs::create_dir_all(&dst_path).await.ok();
                    stack.push((src_path, dst_path, rel));
                } else if ft.is_file() {
                    let overwrite = should_overwrite(&rel);
                    if dst_path.exists() && !overwrite {
                        continue;
                    }
                    if let Some(parent) = dst_path.parent() {
                        tokio::fs::create_dir_all(parent).await.ok();
                    }
                    tokio::fs::copy(&src_path, &dst_path)
                        .await
                        .with_context(|| {
                            format!(
                                "Failed to copy {} -> {}",
                                src_path.display(),
                                dst_path.display()
                            )
                        })?;

                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if rel == "gradlew" {
                            if let Ok(metadata) = tokio::fs::metadata(&dst_path).await {
                                let mut perms = metadata.permissions();
                                perms.set_mode(0o755);
                                let _ = tokio::fs::set_permissions(&dst_path, perms).await;
                            }
                        }
                    }
                }
            }
        }

        Ok(())
    }

    // Copy only android/ back into the user's project.
    // Preserve user-authored build scripts by default; always overwrite wrapper tooling.
    let should_overwrite = |rel: &str| {
        let rel = rel.replace('\\', "/");
        rel == "gradlew"
            || rel == "gradlew.bat"
            || rel == "local.properties"
            || rel.starts_with("gradle/wrapper/")
    };

    copy_dir_selective(&generated_android_dir, android_dir, &should_overwrite).await?;

    // Cleanup temp folder best-effort.
    let _ = tokio::fs::remove_dir_all(&temp_root).await;

    if !android_dir_is_ready_for_first_gradle_invocation(android_dir) {
        let missing_after = android_dir_missing_required_files(android_dir);
        bail!(
            "android/ generation succeeded but required Gradle files are still missing: {}",
            missing_after.join(", ")
        );
    }

    Ok(())
}

async fn run_gradle_and_collect_diagnostics(
    mut cmd: Command,
    log_callback: Option<&LogCallback>,
) -> Result<(std::process::ExitStatus, Vec<Diagnostic>, bool)> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().context("Failed to spawn gradle")?;

    let stdout = child.stdout.take().context("Missing stdout")?;
    let stderr = child.stderr.take().context("Missing stderr")?;

    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    let mut diagnostics = vec![];
    let mut wrapper_main_missing = false;

    // Gradle can sit quiet for long stretches (dependency downloads, Kotlin IC, etc).
    // Emit periodic heartbeats so the UI doesn't look frozen, and hard-timeout
    // truly stuck builds.
    let start = Instant::now();
    let mut last_output = Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let total_timeout = Duration::from_secs(25 * 60);

    let mut stdout_closed = false;
    let mut stderr_closed = false;

    loop {
        if stdout_closed && stderr_closed {
            break;
        }

        tokio::select! {
            _ = heartbeat.tick() => {
                if last_output.elapsed() >= Duration::from_secs(20) {
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
                            "Gradle timed out after {}s; terminating build process",
                            start.elapsed().as_secs(),
                        ));
                    }
                    let _ = child.kill().await;
                    bail!("Gradle build timed out after {} seconds", start.elapsed().as_secs());
                }
            }
            stdout_res = stdout_reader.next_line(), if !stdout_closed => {
                match stdout_res {
                    Ok(Some(line_text)) => {
                        if let Some(cb) = log_callback {
                            cb(line_text.clone());
                        }
                        last_output = Instant::now();
                        if let Some(diag) = parse_gradle_diagnostic(&line_text) {
                            diagnostics.push(diag);
                        }
                        if let Some(diag) = parse_metro_diagnostic(&line_text) {
                            diagnostics.push(diag);
                        }
                    }
                    Ok(None) => stdout_closed = true,
                    Err(e) => {
                        eprintln!("Error reading stdout: {}", e);
                        stdout_closed = true;
                    }
                }
            }
            stderr_res = stderr_reader.next_line(), if !stderr_closed => {
                match stderr_res {
                    Ok(Some(line_text)) => {
                        let lower = line_text.to_lowercase();
                        if lower.contains("gradlewrappermain") || lower.contains("org.gradle.wrapper.gradlewrappermain") {
                            wrapper_main_missing = true;
                        }
                        if lower.contains("could not find or load main class") && lower.contains("gradlewrappermain") {
                            wrapper_main_missing = true;
                        }
                        if let Some(cb) = log_callback {
                            cb(format!("[stderr] {}", line_text));
                        }
                        last_output = Instant::now();
                        if let Some(diag) = parse_gradle_diagnostic(&line_text) {
                            diagnostics.push(diag);
                        }
                    }
                    Ok(None) => stderr_closed = true,
                    Err(e) => {
                        eprintln!("Error reading stderr: {}", e);
                        stderr_closed = true;
                    }
                }
            }
        }
    }

    let status = child.wait().await.context("Failed to wait for gradle")?;
    Ok((status, diagnostics, wrapper_main_missing))
}

async fn create_isolated_gradle_user_home(project_root: &Path) -> Result<PathBuf> {
    let home = project_root
        .join(".synthi/gradle-user-home")
        .join(Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&home)
        .await
        .with_context(|| format!("Failed to create GRADLE_USER_HOME at {}", home.display()))?;
    Ok(home)
}

fn apply_gradle_common_args_and_env(cmd: &mut Command, gradle_user_home: &Path) {
    // Avoid using /root/.gradle (shared across jobs) which can become corrupted/locked.
    cmd.env("GRADLE_USER_HOME", gradle_user_home);

    // Prefer no-daemon for ephemeral worker jobs.
    cmd.arg("--no-daemon");

    // Make output line-oriented and stable for log streaming.
    cmd.arg("--console=plain");

    // Force Gradle to use this user home even if env isn't honored.
    cmd.arg("--gradle-user-home");
    cmd.arg(gradle_user_home);
}

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
                if let Some(end) = trimmed[start + 1..].find('"') {
                    return Ok(trimmed[start + 1..start + 1 + end].to_string());
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
        let output = Command::new(emulator).arg("-list-avds").output().await?;
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
    let adb_path = sdk_root
        .as_ref()
        .and_then(|r| resolve_android_tool(r, "adb"));
    let emulator_path = sdk_root
        .as_ref()
        .and_then(|r| resolve_android_tool(r, "emulator"));
    let avdmanager_path = sdk_root
        .as_ref()
        .and_then(|r| resolve_android_tool(r, "avdmanager"));
    let sdkmanager_path = sdk_root
        .as_ref()
        .and_then(|r| resolve_android_tool(r, "sdkmanager"));

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
        list_system_images_via_sdkmanager(p)
            .await
            .unwrap_or_default()
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
            bail!("npm install failed");
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

    // Build APK using Gradle

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

    // If wrapper jar looks missing/corrupt, prefer system gradle immediately (if available).
    let wrapper_health = check_wrapper_jar_health(&android_dir).await;
    if (!wrapper_health.exists
        || wrapper_health.size_bytes < 1024
        || !wrapper_health.looks_like_zip)
        && system_gradle_available().await
    {
        if let Some(cb) = log_callback.as_ref() {
            cb(format!(
                "Wrapper jar looks missing/corrupt (exists={} size={} looksLikeZip={}); falling back to system `gradle`",
                wrapper_health.exists, wrapper_health.size_bytes, wrapper_health.looks_like_zip
            ));
        }

        let mut cmd = Command::new("gradle");
        cmd.current_dir(&android_dir)
            .arg(gradle_task)
            .args(&config.extra_gradle_args)
            .envs(&config.env);

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
    if !wrapper_health.exists || wrapper_health.size_bytes < 1024 || !wrapper_health.looks_like_zip
    {
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

    // Construct Gradle command (direct exec) with a fallback via bash/sh.
    // In some environments, the wrapper can fail to exec with ENOENT due to
    // shebang/line-ending issues; bash/sh invocation is more robust.
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

        for line in String::from_utf8_lossy(&output.stderr).lines() {
            callback(format!("[stderr] {}", line));
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
    if let Some(caps) =
        regex::Regex::new(r"^ERROR\s+(.+\.[jt]sx?):(\d+):(\d+)\s*-\s*error\s+(\w+):\s*(.+)$")
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
