use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;
use uuid::Uuid;

use super::common::*;
use super::LogCallback;

pub(crate) async fn ensure_android_gradle_project(
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
        cb("Attempting to restore android/ from worker cache...".to_string());
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

    // Preserve user-authored build scripts by default; always overwrite wrapper tooling.
    let should_overwrite_android = |rel: &str| {
        let rel = rel.replace('\\', "/");
        rel == "gradlew"
            || rel == "gradlew.bat"
            || rel == "local.properties"
            || rel.starts_with("gradle/wrapper/")
    };

    // Try to restore from a worker-local cache first (avoids re-running RN init).
    // Cache key: RN version (already resolved to an exact semver-ish token).
    let cache_android_dir = worker_cache_dir()
        .join("rn-android")
        .join(rn_ver.replace(['/', '\\', ':'], "_"))
        .join("android");

    if android_dir_missing_required_files(&cache_android_dir).is_empty() {
        if let Some(cb) = log_callback {
            cb(format!(
                "Restoring android/ from cache: {}",
                cache_android_dir.display()
            ));
        }

        copy_dir_selective(&cache_android_dir, android_dir, &should_overwrite_android).await?;

        if android_dir_is_ready_for_first_gradle_invocation(android_dir) {
            if let Some(cb) = log_callback {
                cb("android/ restored from cache (skipping RN init)".to_string());
            }
            return Ok(());
        }

        if let Some(cb) = log_callback {
            let missing_after = android_dir_missing_required_files(android_dir);
            cb(format!(
                "Cache restore did not yield a ready android/ (missing: {}); falling back to RN init",
                missing_after.join(", ")
            ));
        }
    } else if let Some(cb) = log_callback {
        cb(format!(
            "No cached android/ found for rn_ver={} (expected {}). Will run RN init.",
            rn_ver,
            cache_android_dir.display()
        ));
    }

    if let Some(cb) = log_callback {
        cb("Generating android/ via React Native CLI".to_string());
    }

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

    // Copy only android/ back into the user's project.
    copy_dir_selective(
        &generated_android_dir,
        android_dir,
        &should_overwrite_android,
    )
    .await?;

    // Best-effort: populate worker cache for this RN version so future runs can restore instantly.
    // Write to a staging dir then rename to reduce partial-cache risk.
    let cache_root = cache_android_dir
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| worker_cache_dir().join("rn-android").join(rn_ver.clone()));
    let cache_stage = cache_root.join(format!(".staging-{}", Uuid::new_v4().simple()));
    let cache_target = cache_android_dir.clone();
    let cache_write_res: Result<()> = async {
        tokio::fs::create_dir_all(&cache_stage).await.ok();
        copy_dir_selective(&generated_android_dir, &cache_stage, &|_rel: &str| true).await?;
        // Replace any existing cache atomically-ish.
        if cache_target.exists() {
            let _ = tokio::fs::remove_dir_all(&cache_target).await;
        }
        tokio::fs::create_dir_all(&cache_root).await.ok();
        let _ = tokio::fs::rename(&cache_stage, &cache_target).await;
        Ok(())
    }
    .await;

    if let Some(cb) = log_callback {
        match cache_write_res {
            Ok(_) => cb(format!(
                "Cached android/ template at {}",
                cache_target.display()
            )),
            Err(e) => cb(format!("Non-fatal: failed to write android/ cache: {e:#}")),
        }
    }

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
