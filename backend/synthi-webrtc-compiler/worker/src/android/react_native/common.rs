use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;
use uuid::Uuid;

use super::LogCallback;

#[derive(Debug, Deserialize)]
pub(crate) struct PackageJson {
    pub(crate) name: Option<String>,
    pub(crate) dependencies: Option<HashMap<String, serde_json::Value>>,
    #[serde(rename = "devDependencies")]
    #[allow(dead_code)]
    pub(crate) dev_dependencies: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct WrapperJarHealth {
    pub(crate) exists: bool,
    pub(crate) size_bytes: u64,
    pub(crate) looks_like_zip: bool,
}

pub(crate) async fn check_wrapper_jar_health(android_dir: &Path) -> WrapperJarHealth {
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

pub(crate) async fn system_gradle_available() -> bool {
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

pub(crate) async fn read_gradle_distribution_url(android_dir: &Path) -> Option<String> {
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

pub(crate) async fn ensure_gradle_distribution(
    android_dir: &Path,
    distribution_url: &str,
    log_callback: Option<&LogCallback>,
) -> Result<PathBuf> {
    let cache_root = android_dir.join(".synthi/gradle-dist");
    tokio::fs::create_dir_all(&cache_root).await.ok();

    let url_hash = crate::compiler::builder::hash_content(distribution_url).to_string();
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

pub(crate) async fn list_dir_for_debug(path: &Path, log_callback: Option<&LogCallback>, label: &str) {
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

pub(crate) async fn find_files_recursive(
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

pub(crate) async fn patch_main_component_name(
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

pub(crate) fn android_dir_missing_required_files(android_dir: &Path) -> Vec<&'static str> {
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

pub(crate) fn android_dir_is_ready_for_first_gradle_invocation(android_dir: &Path) -> bool {
    android_dir_missing_required_files(android_dir).is_empty()
}

pub(crate) fn worker_cache_dir() -> PathBuf {
    if let Ok(p) = std::env::var("SYNTHI_WORKER_CACHE_DIR") {
        let p = p.trim();
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }

    // Prefer a stable OS cache directory so artifacts persist across runs.
    // Fall back to temp_dir() only if we can't determine a better location.
    #[cfg(windows)]
    {
        if let Ok(p) = std::env::var("LOCALAPPDATA") {
            let p = p.trim();
            if !p.is_empty() {
                return PathBuf::from(p).join("synthi-worker-cache");
            }
        }
        if let Ok(p) = std::env::var("USERPROFILE") {
            let p = p.trim();
            if !p.is_empty() {
                return PathBuf::from(p)
                    .join("AppData")
                    .join("Local")
                    .join("synthi-worker-cache");
            }
        }
    }

    #[cfg(unix)]
    {
        if let Ok(p) = std::env::var("XDG_CACHE_HOME") {
            let p = p.trim();
            if !p.is_empty() {
                return PathBuf::from(p).join("synthi-worker-cache");
            }
        }
        if let Ok(p) = std::env::var("HOME") {
            let p = p.trim();
            if !p.is_empty() {
                return PathBuf::from(p)
                    .join(".cache")
                    .join("synthi-worker-cache");
            }
        }
    }

    std::env::temp_dir().join("synthi-worker-cache")
}

pub(crate) fn env_var_truthy(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            matches!(v.as_str(), "1" | "true" | "yes" | "y" | "on")
        })
        .unwrap_or(false)
}

pub(crate) fn stable_project_cache_key(project_root: &Path) -> String {
    // Stable across runs for the same project path.
    // Used to avoid per-build cache misses while still isolating projects.
    let mut h = Sha256::new();
    h.update(project_root.to_string_lossy().as_bytes());
    let hex = format!("{:x}", h.finalize());
    hex.chars().take(16).collect()
}

pub(crate) async fn read_package_json(project_root: &Path) -> Option<PackageJson> {
    let package_json_path = project_root.join("package.json");
    let content = tokio::fs::read_to_string(&package_json_path).await.ok()?;
    serde_json::from_str(&content).ok()
}

pub(crate) fn package_has_dependency(package: &PackageJson, dep: &str) -> bool {
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

pub(crate) async fn read_app_json_name(project_root: &Path) -> Option<String> {
    let app_json_path = project_root.join("app.json");
    let content = tokio::fs::read_to_string(&app_json_path).await.ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    v.get("name")
        .and_then(|n| n.as_str())
        .map(|s| s.to_string())
}

pub(crate) fn sanitize_rn_project_name(name: &str) -> String {
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

pub(crate) async fn run_command_and_log_output(
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
pub(crate) struct NodeInfo {
    pub(crate) version: String,
    pub(crate) major: u64,
    pub(crate) exec_path: Option<String>,
}

fn parse_node_major(version: &str) -> Option<u64> {
    let v = version.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    v.split('.').next()?.parse::<u64>().ok()
}

pub(crate) async fn detect_node_info() -> Option<NodeInfo> {
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

pub(crate) async fn list_child_dirs(dir: &Path) -> Vec<String> {
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

pub(crate) async fn find_generated_project_root(
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
