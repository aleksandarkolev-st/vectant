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
use futures_util::StreamExt;
use uuid::Uuid;
use std::io::Read;
use std::time::{Duration, Instant};

use crate::mobile_routing::{
    ReactNativeProjectInfo, Diagnostic, DiagnosticSeverity, AndroidSdkHealth,
};
use crate::env_setup;

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
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
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
        cb(format!("Downloading Gradle distribution: {}", distribution_url));
    }

    // Stream download to disk to avoid holding the whole zip in memory.
    let client = reqwest::Client::new();
    let resp = client
        .get(distribution_url)
        .send()
        .await
        .with_context(|| format!("Failed to download Gradle distribution: {}", distribution_url))?
        .error_for_status()
        .with_context(|| format!("Gradle distribution HTTP error: {}", distribution_url))?;

    let mut file = tokio::fs::File::create(&zip_path)
        .await
        .with_context(|| format!("Failed to create {}", zip_path.display()))?;

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.context("Error while downloading Gradle distribution")?;
        use tokio::io::AsyncWriteExt;
        file.write_all(&bytes).await.context("Failed writing Gradle zip")?;
    }

    if let Some(cb) = log_callback {
        cb(format!("Extracting Gradle distribution to {}", extract_root.display()));
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
        bail!("Gradle distribution extracted but bin/gradle not found at {}", gradle_bin.display());
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
        let mut ls = Command::new("ls");
        ls.args(["-la", path.to_string_lossy().as_ref()]);
        let _ = run_command_and_log_output(ls, Some(cb), label).await;
    }
}

async fn find_files_recursive(dir: &Path, file_names: &[&str], out: &mut Vec<PathBuf>) -> Result<()> {
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

async fn patch_main_component_name(android_dir: &Path, app_name: &str, log_callback: Option<&LogCallback>) -> Result<()> {
    let java_root = android_dir.join("app/src/main/java");
    let kotlin_root = android_dir.join("app/src/main/kotlin");
    let mut candidates: Vec<PathBuf> = Vec::new();
    find_files_recursive(&java_root, &["MainActivity.java", "MainActivity.kt"], &mut candidates).await?;
    find_files_recursive(&kotlin_root, &["MainActivity.java", "MainActivity.kt"], &mut candidates).await?;

    // Best-effort patch: update the getMainComponentName return value.
    for file in candidates {
        let Ok(content) = tokio::fs::read_to_string(&file).await else { continue; };
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
                cb(format!("Patched MainActivity component name in {}", file.display()));
            }
        }
    }

    Ok(())
}

fn safe_tar_entry_path(path: &Path) -> Option<PathBuf> {
    if path.is_absolute() {
        return None;
    }
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    Some(path.to_path_buf())
}

async fn ensure_android_from_rn_npm_template(
    project_root: &Path,
    rn_version: &str,
    app_name: &str,
    log_callback: Option<&LogCallback>,
) -> Result<()> {
    let android_dir = project_root.join("android");
    if android_dir_is_gradle_build(&android_dir).await {
        return Ok(());
    }

    let cache_root = project_root.join(".synthi/rn-template");
    tokio::fs::create_dir_all(&cache_root)
        .await
        .with_context(|| format!("Failed to create {}", cache_root.display()))?;

    // NPM tarballs for react-native are predictable.
    let tarball_url = format!("https://registry.npmjs.org/react-native/-/react-native-{}.tgz", rn_version);
    let tgz_path = cache_root.join(format!("react-native-{}.tgz", rn_version));

    if !tgz_path.exists() {
        if let Some(cb) = log_callback {
            cb(format!("Downloading React Native template tarball: {}", tarball_url));
        }
        let client = reqwest::Client::new();
        let resp = client
            .get(&tarball_url)
            .send()
            .await
            .with_context(|| format!("Failed to download RN tarball: {}", tarball_url))?
            .error_for_status()
            .with_context(|| format!("RN tarball HTTP error: {}", tarball_url))?;

        let mut file = tokio::fs::File::create(&tgz_path)
            .await
            .with_context(|| format!("Failed to create {}", tgz_path.display()))?;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.context("Error while downloading RN tarball")?;
            use tokio::io::AsyncWriteExt;
            file.write_all(&bytes).await.context("Failed writing RN tgz")?;
        }
    }

    if android_dir.exists() {
        let _ = tokio::fs::remove_dir_all(&android_dir).await;
    }
    tokio::fs::create_dir_all(&android_dir)
        .await
        .with_context(|| format!("Failed to create {}", android_dir.display()))?;

    if let Some(cb) = log_callback {
        cb(format!("Extracting Android template from react-native@{}", rn_version));
    }

    // Extract using blocking std I/O (tar + flate2 are sync).
    let tgz_path_clone = tgz_path.clone();
    let android_dir_clone = android_dir.clone();
    let rn_version_owned = rn_version.to_string();
    let extract_result: Result<()> = tokio::task::spawn_blocking(move || -> Result<()> {
        let file = std::fs::File::open(&tgz_path_clone)
            .with_context(|| format!("Failed to open {}", tgz_path_clone.display()))?;
        let gz = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(gz);

        let prefix = Path::new("package/template/android");
        for entry in archive.entries().context("Failed to read tar entries")? {
            let mut entry = entry.context("Failed reading tar entry")?;
            let path = entry.path().context("Failed reading tar entry path")?;
            let Some(safe_path) = safe_tar_entry_path(&path) else { continue; };
            if !safe_path.starts_with(prefix) {
                continue;
            }

            let rel = match safe_path.strip_prefix(prefix) {
                Ok(r) => r,
                Err(_) => continue,
            };
            if rel.as_os_str().is_empty() {
                continue;
            }

            let out_path = android_dir_clone.join(rel);
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).ok();
            }

            if entry.header().entry_type().is_dir() {
                std::fs::create_dir_all(&out_path).ok();
                continue;
            }

            let mut out = std::fs::File::create(&out_path)
                .with_context(|| format!("Failed to create {}", out_path.display()))?;
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .with_context(|| format!("Failed to read template file for {}", rn_version_owned))?;
            std::io::Write::write_all(&mut out, &buf)
                .with_context(|| format!("Failed to write {}", out_path.display()))?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(mode) = entry.header().mode() {
                    let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode));
                }
            }
        }

        Ok(())
    })
    .await
    .context("Failed to join template extraction task")?;
    extract_result?;

    // Patch component name to match user's AppRegistry registration.
    patch_main_component_name(&android_dir, app_name, log_callback).await?;

    if !android_dir_is_gradle_build(&android_dir).await {
        if let Some(cb) = log_callback {
            cb("Template extraction completed but Gradle files still missing".to_string());
        }
        list_dir_for_debug(&android_dir, log_callback, "ls -la <project_root>/android").await;
        bail!("Extracted template did not produce a valid Android Gradle build");
    }

    Ok(())
}

async fn android_dir_is_gradle_build(android_dir: &Path) -> bool {
    let settings = android_dir.join("settings.gradle");
    let settings_kts = android_dir.join("settings.gradle.kts");
    let build_gradle = android_dir.join("build.gradle");
    let build_gradle_kts = android_dir.join("build.gradle.kts");
    settings.exists() || settings_kts.exists() || build_gradle.exists() || build_gradle_kts.exists()
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
    v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())
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

async fn ensure_android_gradle_project(
    project_root: &Path,
    android_dir: &Path,
    rn_version: Option<&str>,
    log_callback: Option<&LogCallback>,
) -> Result<()> {
    if android_dir_is_gradle_build(android_dir).await {
        return Ok(());
    }

    if let Some(cb) = log_callback {
        cb(format!(
            "Android directory missing Gradle build files (no settings.gradle). Attempting to generate android/ in {}",
            project_root.display()
        ));
    }

    let package = read_package_json(project_root).await;
    let is_expo = package.as_ref().map(|p| package_has_dependency(p, "expo")).unwrap_or(false);

    // Try Expo prebuild first if this looks like an Expo project.
    if is_expo {
        let mut cmd = Command::new("npx");
        cmd.current_dir(project_root)
            .args(["expo", "prebuild", "--platform", "android", "--non-interactive"]);
        let status = run_command_and_log_output(cmd, log_callback, "npx expo prebuild --platform android --non-interactive").await?;
        if status.success() && android_dir_is_gradle_build(android_dir).await {
            return Ok(());
        }
    }

    // Fall back to generating a bare React Native android/ directory from the RN template.
    // We generate into a temp folder and copy only `android/` into the existing project.
    let temp_base = project_root.join(".synthi/rn-init");
    tokio::fs::create_dir_all(&temp_base)
        .await
        .with_context(|| format!("Failed to create {}", temp_base.display()))?;

    let app_name = read_app_json_name(project_root)
        .await
        .or_else(|| package.as_ref().and_then(|p| p.name.clone()))
        .unwrap_or_else(|| "App".to_string());
    let init_name = sanitize_rn_project_name(&app_name);
    let temp_suffix = Uuid::new_v4().simple().to_string();
    // Keep the project name strictly alphanumeric to avoid RN CLI validation edge-cases.
    let temp_project_name = format!("{}{}", init_name, &temp_suffix[..8.min(temp_suffix.len())]);

    if let Some(cb) = log_callback {
        cb(format!("Generating Android project via React Native init: {}", temp_project_name));
    }

    let rn_ver = rn_version
        .map(|v| v.trim())
        .filter(|v| !v.is_empty() && *v != "unknown")
        .unwrap_or("latest");

    async fn try_rn_init(
        temp_base: &Path,
        rn_ver: &str,
        temp_project_name: &str,
        args: &[&str],
        log_callback: Option<&LogCallback>,
        label: &str,
    ) -> Result<std::process::ExitStatus> {
        let temp_project_root = temp_base.join(temp_project_name);
        if temp_project_root.exists() {
            let _ = tokio::fs::remove_dir_all(&temp_project_root).await;
        }

        let mut cmd = Command::new("npx");
        cmd.current_dir(temp_base)
            .env("CI", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .args([
                &format!("react-native@{}", rn_ver),
                "init",
                temp_project_name,
                "--verbose",
            ])
            .args(args);
        run_command_and_log_output(cmd, log_callback, label).await
    }

    // `react-native init` frequently fails in minimal worker images due to missing `git`.
    // Prefer `--skip-git-init` when available. Also accept partial success if android/ exists.
    let init_attempts: Vec<(&'static str, Vec<&'static str>)> = vec![
        ("npx react-native init (skip-install, skip-git-init)", vec!["--skip-install", "--skip-git-init"]),
        ("npx react-native init (skip-install)", vec!["--skip-install"]),
        ("npx react-native init (skip-git-init)", vec!["--skip-git-init"]),
        ("npx react-native init", vec![]),
    ];

    let mut last_status: Option<std::process::ExitStatus> = None;
    for (label, args) in init_attempts {
        let status = try_rn_init(
            &temp_base,
            rn_ver,
            &temp_project_name,
            &args,
            log_callback,
            label,
        )
        .await?;
        last_status = Some(status);

        let generated_project_root = temp_base.join(&temp_project_name);
        let generated_android_dir = generated_project_root.join("android");
        if android_dir_is_gradle_build(&generated_android_dir).await {
            // Even if init returned non-zero, we have what we need.
            break;
        }

        if status.success() {
            // Init succeeded but Android build not found: no point retrying with different flags.
            break;
        }
    }

    let generated_project_root = temp_base.join(&temp_project_name);
    let generated_android_dir = generated_project_root.join("android");
    if !android_dir_is_gradle_build(&generated_android_dir).await {
        if let Some(cb) = log_callback {
            cb(format!(
                "react-native init did not produce an Android Gradle build (last_status={:?}). Checked {}",
                last_status.map(|s| s.code()),
                generated_android_dir.display()
            ));

            // Extra diagnostics: show what's actually in the generated dirs.
            let mut ls_root = Command::new("ls");
            ls_root.args(["-la", generated_project_root.to_string_lossy().as_ref()]);
            let _ = run_command_and_log_output(ls_root, Some(cb), "ls -la <generated_project_root>").await;

            if generated_android_dir.exists() {
                let mut ls_android = Command::new("ls");
                ls_android.args(["-la", generated_android_dir.to_string_lossy().as_ref()]);
                let _ = run_command_and_log_output(ls_android, Some(cb), "ls -la <generated_android_dir>").await;
            }
        }
        // Last fallback: extract android template directly from the RN npm tarball.
        if let Some(cb) = log_callback {
            cb("Falling back to extracting Android template from react-native npm tarball".to_string());
        }

        let app_name_for_template = read_app_json_name(project_root)
            .await
            .or_else(|| package.as_ref().and_then(|p| p.name.clone()))
            .unwrap_or_else(|| "App".to_string());

        ensure_android_from_rn_npm_template(
            project_root,
            rn_ver,
            &app_name_for_template,
            log_callback,
        )
        .await?;

        return Ok(());
    }

    // Replace existing android directory (if any)
    if android_dir.exists() {
        let _ = tokio::fs::remove_dir_all(android_dir).await;
    }

    // Copy generated android/ into place (Linux workers have `cp`).
    let mut cp = Command::new("cp");
    cp.args(["-a", generated_android_dir.to_string_lossy().as_ref(), project_root.to_string_lossy().as_ref()]);
    let status_cp = run_command_and_log_output(cp, log_callback, "cp -a <generated>/android <project_root>").await?;
    if !status_cp.success() {
        bail!("Failed to copy generated android/ into project");
    }

    // Cleanup temp folder best-effort.
    let _ = tokio::fs::remove_dir_all(&generated_project_root).await;

    if !android_dir_is_gradle_build(android_dir).await {
        bail!(
            "Android directory still does not contain a Gradle build after generation: {}",
            android_dir.display()
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

async fn ensure_gradle_wrapper_scripts(android_dir: &Path, log_callback: Option<&LogCallback>) -> Result<()> {
    let wrapper_dir = android_dir.join("gradle/wrapper");
    let wrapper_jar = wrapper_dir.join("gradle-wrapper.jar");
    let wrapper_props = wrapper_dir.join("gradle-wrapper.properties");

    // If the Android folder itself is missing, we can't fix anything.
    if !android_dir.exists() {
        bail!("Android directory not found: {}", android_dir.display());
    }

    // If scripts exist already, nothing to do.
    let gradlew_unix = android_dir.join("gradlew");
    let gradlew_bat = android_dir.join("gradlew.bat");
    if gradlew_unix.exists() || gradlew_bat.exists() {
        return Ok(());
    }

    // We only auto-generate the launch scripts if the wrapper artifacts exist.
    if !wrapper_jar.exists() || !wrapper_props.exists() {
        return Ok(());
    }

    // Best-effort validation: jar should be a ZIP (starts with PK) and non-trivial size.
    // If it's missing/corrupt, we still let the build continue so we can fall back to system gradle.
    let health = check_wrapper_jar_health(android_dir).await;
    if let Some(cb) = log_callback {
        cb(format!(
            "Gradle wrapper jar health: exists={} size={} looksLikeZip={}",
            health.exists, health.size_bytes, health.looks_like_zip
        ));
    }

    if let Some(cb) = log_callback {
        cb(format!(
            "Gradle wrapper scripts missing; generating minimal gradlew/gradlew.bat in {}",
            android_dir.display()
        ));
    }

    // Minimal POSIX gradlew launcher (avoids copying Gradle's full script).
    // Uses the wrapper jar that already exists under gradle/wrapper.
    let gradlew_sh = r#"#!/usr/bin/env sh
set -eu

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

exec java -classpath "$DIR/gradle/wrapper/gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain "$@"
"#;

    // Minimal Windows gradlew.bat launcher.
    let gradlew_cmd = r#"@echo off
setlocal
set DIR=%~dp0
java -classpath "%DIR%gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain %*
endlocal
"#;

    tokio::fs::write(&gradlew_unix, gradlew_sh)
        .await
        .with_context(|| format!("Failed to write {}", gradlew_unix.display()))?;
    tokio::fs::write(&gradlew_bat, gradlew_cmd)
        .await
        .with_context(|| format!("Failed to write {}", gradlew_bat.display()))?;

    // Ensure executable bit on Unix for the shell script.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = tokio::fs::metadata(&gradlew_unix).await {
            let mut perms = metadata.permissions();
            perms.set_mode(0o755);
            let _ = tokio::fs::set_permissions(&gradlew_unix, perms).await;
        }
    }

    Ok(())
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

    // Ensure android/ exists and contains a Gradle build (settings.gradle). Some projects
    // (e.g. Expo-managed or incomplete check-ins) may lack a native Android project.
    ensure_android_gradle_project(
        &config.project_root,
        &android_dir,
        project_info.react_native_version.as_deref(),
        log_callback.as_ref(),
    )
    .await?;

    // Refresh app id now that android/ may have been generated.
    let resolved_app_id = extract_android_app_id(&android_dir).await.ok().or(project_info.app_id.clone());

    // Use a per-build Gradle user home to avoid shared-cache corruption between concurrent jobs.
    let gradle_user_home = create_isolated_gradle_user_home(&config.project_root).await?;

    // If the wrapper jar/properties exist but gradlew scripts are missing, generate them.
    // This allows builds to proceed even when the interactive terminal is unavailable.
    ensure_gradle_wrapper_scripts(&android_dir, log_callback.as_ref()).await?;

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
        let final_apk_path = if status.success() && apk_path.exists() { Some(apk_path) } else { None };

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

            let gradle_bin = ensure_gradle_distribution(&android_dir, &url, log_callback.as_ref()).await?;
            let mut cmd = Command::new(&gradle_bin);
            cmd.current_dir(&android_dir);
            apply_gradle_common_args_and_env(&mut cmd, &gradle_user_home);
            cmd.arg(gradle_task)
                .args(&config.extra_gradle_args)
                .envs(&config.env);

            let (status, diagnostics, _wrapper_main_missing) =
                run_gradle_and_collect_diagnostics(cmd, log_callback.as_ref()).await?;

            let duration = start.elapsed().as_millis() as u64;
            let final_apk_path = if status.success() && apk_path.exists() { Some(apk_path) } else { None };

            return Ok(EmulatorBuildResult {
                success: status.success(),
                apk_path: final_apk_path,
                app_id: resolved_app_id.clone(),
                build_duration_ms: duration,
                diagnostics,
            });
        } else if let Some(cb) = log_callback.as_ref() {
            cb("Wrapper jar invalid and no distributionUrl found in gradle-wrapper.properties".to_string());
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
        let final_apk_path = if status2.success() && apk_path.exists() { Some(apk_path) } else { None };

        return Ok(EmulatorBuildResult {
            success: status2.success(),
            apk_path: final_apk_path,
            app_id: resolved_app_id.clone(),
            build_duration_ms: duration,
            diagnostics: diagnostics2,
        });
    }

    let duration = start.elapsed().as_millis() as u64;
    let final_apk_path = if status.success() && apk_path.exists() { Some(apk_path) } else { None };

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
