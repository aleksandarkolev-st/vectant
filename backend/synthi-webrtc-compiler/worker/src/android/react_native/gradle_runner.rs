use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

#[cfg(windows)]
use std::os::windows::process::ExitStatusExt;

use super::common::{env_var_truthy, stable_project_cache_key, worker_cache_dir};
use super::diagnostics::{parse_gradle_diagnostic, parse_metro_diagnostic};
use super::LogCallback;
use crate::mobile_routing::Diagnostic;

pub(crate) async fn run_gradle_and_collect_diagnostics(
    mut cmd: Command,
    log_callback: Option<&LogCallback>,
) -> Result<(std::process::ExitStatus, Vec<Diagnostic>, bool)> {
    cmd.kill_on_drop(true);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().context("Failed to spawn gradle")?;

    let stdout = child.stdout.take().context("Missing stdout")?;
    let stderr = child.stderr.take().context("Missing stderr")?;

    // Read as raw bytes and decode lossily so we don't abort on non-UTF8 output.
    // (Gradle/Kotlin can emit control bytes that can break `.lines()`. )
    let mut stdout_reader = BufReader::new(stdout);
    let mut stderr_reader = BufReader::new(stderr);
    let mut stdout_buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut stderr_buf: Vec<u8> = Vec::with_capacity(8 * 1024);

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
    let mut exit_status: Option<std::process::ExitStatus> = None;

    loop {
        // Exit once the process is done and we've drained stdio.
        if exit_status.is_some() && stdout_closed && stderr_closed {
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
                    anyhow::bail!("Gradle build timed out after {} seconds", start.elapsed().as_secs());
                }
            }

            status_res = child.wait(), if exit_status.is_none() => {
                exit_status = Some(status_res.context("Failed to wait for gradle")?);
            }

            stdout_res = stdout_reader.read_until(b'\n', &mut stdout_buf), if !stdout_closed => {
                match stdout_res {
                    Ok(0) => stdout_closed = true,
                    Ok(_) => {
                        let line_text = String::from_utf8_lossy(&stdout_buf)
                            .trim_end_matches(['\r','\n'])
                            .to_string();
                        stdout_buf.clear();
                        if !line_text.is_empty() {
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
                        let line_text = String::from_utf8_lossy(&stderr_buf)
                            .trim_end_matches(['\r','\n'])
                            .to_string();
                        stderr_buf.clear();
                        if !line_text.is_empty() {
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
                    }
                    Err(e) => {
                        eprintln!("Error reading stderr: {}", e);
                        stderr_closed = true;
                    }
                }
            }
        }
    }

    let status = exit_status.unwrap_or_else(|| {
        // Should be rare; fallback if we drained pipes but didn't observe wait() yet.
        // Treat as non-success and let caller handle diagnostics.
        std::process::ExitStatus::from_raw(1)
    });
    Ok((status, diagnostics, wrapper_main_missing))
}

pub(crate) async fn create_isolated_gradle_user_home(project_root: &Path) -> Result<PathBuf> {
    if let Ok(p) = std::env::var("SYNTHI_GRADLE_USER_HOME") {
        let p = p.trim();
        if !p.is_empty() {
            let home = PathBuf::from(p);
            tokio::fs::create_dir_all(&home)
                .await
                .with_context(|| format!("Failed to create GRADLE_USER_HOME at {}", home.display()))?;
            return Ok(home);
        }
    }

    // Default: stable per-project Gradle user home under the worker cache.
    // This avoids re-downloading the Gradle distribution + Maven artifacts on every run.
    let home = worker_cache_dir()
        .join("gradle-user-home")
        .join(stable_project_cache_key(project_root));
    tokio::fs::create_dir_all(&home)
        .await
        .with_context(|| format!("Failed to create GRADLE_USER_HOME at {}", home.display()))?;
    Ok(home)
}

pub(crate) fn apply_gradle_common_args_and_env(cmd: &mut Command, gradle_user_home: &Path) {
    // Avoid using /root/.gradle (shared across jobs) which can become corrupted/locked.
    cmd.env("GRADLE_USER_HOME", gradle_user_home);

    // Ensure Gradle is launched with a real JDK and avoid noisy toolchain probing.
    // Some base images include placeholder directories like /usr/lib/jvm/openjdk-17 without bin/java,
    // which causes Gradle to emit warnings and can add startup overhead.
    if let Some(java_home) = resolve_java_home() {
        // Override JAVA_HOME if it's unset or invalid.
        let override_java_home = match std::env::var_os("JAVA_HOME") {
            None => true,
            Some(v) => !looks_like_java_home(Path::new(&v)),
        };
        if override_java_home {
            cmd.env("JAVA_HOME", &java_home);
        }

        // Gradle will pick this up as default JVM; toolchains are configured via gradle.properties.
    }

    // Default to daemon-enabled so subsequent builds are faster on a warm worker.
    // Opt out with SYNTHI_DISABLE_GRADLE_DAEMON=1.
    if env_var_truthy("SYNTHI_DISABLE_GRADLE_DAEMON") {
        cmd.arg("--no-daemon");
    } else {
        cmd.arg("--daemon");
    }

    // Make output line-oriented and stable for log streaming.
    cmd.arg("--console=plain");

    // Force Gradle to use this user home even if env isn't honored.
    cmd.arg("--gradle-user-home");
    cmd.arg(gradle_user_home);

    // Enable Gradle build cache by default to speed up subsequent builds.
    // Opt out with SYNTHI_DISABLE_GRADLE_BUILD_CACHE=1.
    if !env_var_truthy("SYNTHI_DISABLE_GRADLE_BUILD_CACHE") {
        cmd.arg("--build-cache");
    }
}

pub(crate) fn resolve_java_home() -> Option<PathBuf> {
    // Highest priority: explicit override.
    if let Ok(v) = std::env::var("SYNTHI_JAVA_HOME") {
        let p = PathBuf::from(v.trim());
        if looks_like_java_home(&p) {
            return Some(p);
        }
    }

    // Next: existing JAVA_HOME if valid.
    if let Ok(v) = std::env::var("JAVA_HOME") {
        let p = PathBuf::from(v.trim());
        if looks_like_java_home(&p) {
            return Some(p);
        }
    }

    // Linux/Unix: scan common JVM install roots.
    #[cfg(unix)]
    {
        // If java is on PATH, derive JAVA_HOME from it.
        if let Some(p) = resolve_java_home_from_path() {
            if looks_like_java_home(&p) {
                return Some(p);
            }
        }

        let jvm_root = Path::new("/usr/lib/jvm");
        if let Ok(entries) = std::fs::read_dir(jvm_root) {
            // Prefer JDK 17+ if multiple are present.
            let mut candidates: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| looks_like_java_home(p))
                .collect();

            candidates.sort_by_key(|p| {
                let s = p.to_string_lossy().to_lowercase();
                // crude ranking: prefer 21, then 17, then anything else.
                if s.contains("21") {
                    0
                } else if s.contains("17") {
                    1
                } else {
                    2
                }
            });

            if let Some(p) = candidates.first() {
                return Some(p.clone());
            }
        }

        // Debian-style default.
        let default_java = PathBuf::from("/usr/lib/jvm/default-java");
        if looks_like_java_home(&default_java) {
            return Some(default_java);
        }
    }

    None
}

fn resolve_java_home_from_path() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;

    #[cfg(windows)]
    let java_name = "java.exe";
    #[cfg(not(windows))]
    let java_name = "java";

    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(java_name);
        if !candidate.exists() {
            continue;
        }

        // Resolve symlinks if possible.
        let resolved = std::fs::canonicalize(&candidate).unwrap_or(candidate);

        // Expected layout: <JAVA_HOME>/bin/java
        if let Some(bin_dir) = resolved.parent() {
            if let Some(java_home) = bin_dir.parent() {
                let home = java_home.to_path_buf();
                if looks_like_java_home(&home) {
                    return Some(home);
                }
            }
        }
    }

    None
}

fn looks_like_java_home(p: &Path) -> bool {
    if !p.exists() {
        return false;
    }
    #[cfg(windows)]
    {
        return p.join("bin/java.exe").exists();
    }
    #[cfg(not(windows))]
    {
        return p.join("bin/java").exists();
    }
}
