use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Once;

/// Ensures Android SDK tools are visible to the current Rust process
/// even when launched via `cargo run` / `cargo test` (which does not
/// source `.bashrc`/`.profile`).
///
/// Behavior:
/// - Chooses an SDK root deterministically from:
///   1) `SYNTHI_ANDROID_SDK_ROOT` (explicit override)
///   2) existing `ANDROID_SDK_ROOT` / `ANDROID_HOME` if they exist
///   3) common install locations (Linux/macOS)
/// - Sets `ANDROID_SDK_ROOT` and `ANDROID_HOME` if missing/invalid
/// - Prepends required directories to `PATH` if present:
///   `platform-tools`, `emulator`, `cmdline-tools/latest/bin`
///
/// Returns the resolved SDK root (if any).
pub fn ensure_android_sdk_env() -> Option<PathBuf> {
    let sdk_root = resolve_android_sdk_root();

    if let Some(ref root) = sdk_root {
        // Only override when missing or clearly invalid.
        if !env_var_points_to_existing_dir("ANDROID_SDK_ROOT") {
            std::env::set_var("ANDROID_SDK_ROOT", root);
        }
        if !env_var_points_to_existing_dir("ANDROID_HOME") {
            std::env::set_var("ANDROID_HOME", root);
        }

        // Ensure PATH contains tool dirs.
        let mut to_prepend = Vec::<PathBuf>::new();

        let platform_tools = root.join("platform-tools");
        if platform_tools.exists() {
            to_prepend.push(platform_tools);
        }

        let emulator_dir = root.join("emulator");
        if emulator_dir.exists() {
            to_prepend.push(emulator_dir);
        }

        for cmdline_bin in [
            root.join("cmdline-tools/latest/bin"),
            root.join("cmdline-tools/bin"),
            root.join("tools/bin"),
        ] {
            if cmdline_bin.exists() {
                to_prepend.push(cmdline_bin);
                break; // prefer latest
            }
        }

        prepend_to_path(&to_prepend);
    }

    sdk_root
}

static LOAD_ANDROID_ENV_ONCE: Once = Once::new();

pub fn load_android_env_file() {
    LOAD_ANDROID_ENV_ONCE.call_once(|| {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let path = Path::new(manifest_dir)
            .join("src")
            .join("android")
            .join(".env");
        if !path.exists() {
            return;
        }

        let Ok(contents) = std::fs::read_to_string(&path) else {
            return;
        };

        for raw_line in contents.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let key = key.trim();
            if key.is_empty() || std::env::var_os(key).is_some() {
                continue;
            }
            let mut value = value.trim().trim_end_matches('\r').to_string();
            if (value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\''))
            {
                value = value[1..value.len().saturating_sub(1)].to_string();
            }
            if value.is_empty() {
                continue;
            }
            std::env::set_var(key, value);
        }
    });
}

pub fn log_android_env_diagnostics(context: &str) {
    let path = std::env::var("PATH").unwrap_or_else(|_| "<unset>".to_string());
    let sdk_root = std::env::var("ANDROID_SDK_ROOT").unwrap_or_else(|_| "<unset>".to_string());
    let sdk_home = std::env::var("ANDROID_HOME").unwrap_or_else(|_| "<unset>".to_string());
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "<unset>".to_string());

    eprintln!("[AndroidEnv][{}] HOME={}", context, home);
    eprintln!("[AndroidEnv][{}] ANDROID_SDK_ROOT={}", context, sdk_root);
    eprintln!("[AndroidEnv][{}] ANDROID_HOME={}", context, sdk_home);
    eprintln!("[AndroidEnv][{}] PATH={}", context, path);
}

fn env_var_points_to_existing_dir(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|v| !v.trim().is_empty() && Path::new(&v).exists())
        .unwrap_or(false)
}

fn resolve_android_sdk_root() -> Option<PathBuf> {
    // 1) Explicit override for deterministic behavior in CI/worker images.
    if let Ok(v) = std::env::var("SYNTHI_ANDROID_SDK_ROOT") {
        let p = PathBuf::from(v);
        if sdk_root_looks_valid(&p) {
            return Some(p);
        }
    }

    // 2) Respect existing variables if they are valid.
    for var in ["ANDROID_SDK_ROOT", "ANDROID_HOME"] {
        if let Ok(v) = std::env::var(var) {
            let p = PathBuf::from(v);
            if sdk_root_looks_valid(&p) {
                return Some(p);
            }
        }
    }

    // 3) Common locations.
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/android-sdk"),
        PathBuf::from("/usr/lib/android-sdk"),
        PathBuf::from("/usr/local/android-sdk"),
    ];

    if let Some(home) = std::env::var("HOME")
        .ok()
        .filter(|h| !h.trim().is_empty())
        .map(PathBuf::from)
    {
        // Common ad-hoc install location (matches WSL tutorials and our dev setup)
        candidates.push(home.join("android-sdk"));
        candidates.push(home.join("Android/Sdk"));
        candidates.push(home.join("Android/sdk"));
        candidates.push(home.join("Library/Android/sdk"));
    }

    // If we're running as root (or HOME is otherwise unhelpful), try scanning /home/*.
    // This is deterministic and cheap (bounded by number of users).
    if let Ok(entries) = std::fs::read_dir("/home") {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            candidates.push(p.join("android-sdk"));
            candidates.push(p.join("Android/Sdk"));
            candidates.push(p.join("Android/sdk"));
        }
    }

    candidates.into_iter().find(|p| sdk_root_looks_valid(p))
}

fn sdk_root_looks_valid(root: &Path) -> bool {
    // Minimal validation: at least platform-tools exists.
    // (emulator + cmdline-tools may be optional depending on job type)
    root.exists() && root.join("platform-tools").exists()
}

fn prepend_to_path(dirs: &[PathBuf]) {
    if dirs.is_empty() {
        return;
    }

    let existing = std::env::var_os("PATH").unwrap_or_else(|| OsString::new());
    let mut paths: Vec<PathBuf> = std::env::split_paths(&existing).collect();

    // Prepend in order, avoiding duplicates.
    for d in dirs.iter().rev() {
        if !paths.iter().any(|p| p == d) {
            paths.insert(0, d.clone());
        }
    }

    match std::env::join_paths(paths.iter()) {
        Ok(joined) => std::env::set_var("PATH", joined),
        Err(_) => {
            // Fallback: best-effort string join.
            let sep = if cfg!(windows) { ";" } else { ":" };
            let mut out = String::new();
            for (i, p) in paths.iter().enumerate() {
                if i > 0 {
                    out.push_str(sep);
                }
                out.push_str(&p.to_string_lossy());
            }
            std::env::set_var("PATH", out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn run_ok(program: &str, args: &[&str]) -> bool {
        Command::new(program)
            .args(args)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Integration-style smoke test for local/CI environments that have an Android SDK.
    ///
    /// Run explicitly:
    /// `cargo test -p worker android_sdk_tools_visible -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn android_sdk_tools_visible() {
        ensure_android_sdk_env();
        log_android_env_diagnostics("test");

        assert!(run_ok("adb", &["version"]), "adb not runnable");
        assert!(run_ok("emulator", &["-list-avds"]), "emulator not runnable");
        assert!(
            run_ok("avdmanager", &["list", "avd"]),
            "avdmanager not runnable"
        );
    }
}
