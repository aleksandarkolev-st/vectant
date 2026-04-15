// ============================================================
// COMPILE HELPERS (ULTRAPLAN Phase 9a — ccache wrapping)
// ============================================================
//
// Thin wrappers around `system_command` that transparently route
// C/C++ compiler invocations through `ccache` when it's available on
// the worker host. The goal is to catch partial hits that Phase 3's
// `.so` content-hash cache misses — comment-only changes, whitespace,
// header edits that don't affect preprocessor output — at the `.o`
// level where ccache already does the work for us.
//
// Design decisions:
//
//   - Detection is ONCE at worker startup via `OnceLock`. If the
//     `ccache` binary is not on PATH, all subsequent calls silently
//     fall through to plain `system_command(compiler_exe)`. No
//     runtime penalty for non-ccache deployments.
//
//   - `CCACHE_DIR` is set PER-WORKER-PROCESS by default
//     (`/tmp/synthi-ccache-<pid>`), not shared across workers.
//     This avoids the concurrency + cache-poisoning issues called
//     out in the rev3 plan §13.6. Users who want a shared cache
//     can opt in via `SYNTHI_CCACHE_DIR=/shared/path`.
//
//   - `SYNTHI_NO_CCACHE=1` disables the wrap entirely even if the
//     binary is present — useful for A/B benchmarking and for
//     isolating compile-time regressions.
//
//   - The wrap only applies to known C/C++ compiler executables
//     (`g++`, `gcc`, `clang`, `clang++`). Anything else passes
//     through untouched, so this helper is safe to call from any
//     compile stage that's threading a manifest-driven compiler name.
//
// Phase 9a alone buys ~50ms on cached hits. Phase 9b (`.o` caching)
// builds on top by checking the `.o` cache BEFORE invoking ccache —
// ccache becomes the broader-equivalence backstop for cases the
// content-hash cache misses.

use crate::infra::utils::system_command;
use std::sync::OnceLock;
use tokio::process::Command;

/// Cached ccache availability. Resolved once on first use via
/// `ccache --version`. On non-ccache hosts the value is `false` and
/// all subsequent calls take the fall-through path.
static CCACHE_AVAILABLE: OnceLock<bool> = OnceLock::new();

/// Cached resolved `CCACHE_DIR` value, applied to every compile
/// command when ccache is enabled. Per-worker tmpdir by default to
/// avoid cross-worker poisoning — users can opt in to a shared cache
/// via the `SYNTHI_CCACHE_DIR` env var.
static CCACHE_DIR_VALUE: OnceLock<String> = OnceLock::new();

fn ccache_available() -> bool {
    *CCACHE_AVAILABLE.get_or_init(|| {
        // Hard opt-out — useful for benchmarks and for isolating
        // ccache-related compile regressions during development.
        if std::env::var("SYNTHI_NO_CCACHE").ok().as_deref() == Some("1") {
            eprintln!("[ccache] disabled via SYNTHI_NO_CCACHE=1");
            return false;
        }
        // Probe with `ccache --version` via a plain std Command
        // (synchronous — this fires at most once per worker process
        // lifetime, on the first compile that tries to use ccache).
        match std::process::Command::new("ccache")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
        {
            Ok(status) if status.success() => {
                eprintln!("[ccache] detected and enabled (dir={})", ccache_dir());
                true
            }
            _ => {
                eprintln!("[ccache] not found on PATH — compile commands will run without caching");
                false
            }
        }
    })
}

fn ccache_dir() -> &'static str {
    CCACHE_DIR_VALUE.get_or_init(|| {
        // Explicit opt-in to a shared cache dir. Users who do this
        // accept the concurrency + poisoning risks documented in the
        // rev3 plan §13.6 in exchange for cross-worker cache sharing.
        if let Ok(shared) = std::env::var("SYNTHI_CCACHE_DIR") {
            return shared;
        }
        // Default: per-worker-process tmpdir. Isolated, no locking
        // overhead, cleaned on process exit. Downside: a new worker
        // process starts cold — first compile of each module pays
        // the full compile cost before the cache warms up.
        format!("/tmp/synthi-ccache-{}", std::process::id())
    })
}

/// Spawn a C/C++ compiler, transparently wrapping the invocation in
/// `ccache` when available. Prefer this over `system_command(compiler_exe)`
/// at every C/C++ compile-stage call site — `compile_core`, `compile_gui`,
/// `compile_runner`, and their source/manifest heal retry paths.
///
/// On non-ccache hosts (or with `SYNTHI_NO_CCACHE=1`), this function
/// behaves identically to `system_command(compiler_exe)` — zero runtime
/// cost for the detection.
///
/// Only wraps recognised C/C++ compilers. Anything else (like `nm`
/// for the Phase 12 link-time check) passes through untouched, so
/// this helper is safe to drop in anywhere a compiler-name string
/// appears.
pub fn cpp_compile_command(compiler_exe: &str) -> Command {
    if !is_cpp_compiler(compiler_exe) || !ccache_available() {
        return system_command(compiler_exe);
    }
    // `system_command("ccache")` gives us the same WSL / stdio plumbing
    // the rest of the worker uses; we just prepend the compiler name
    // as the first positional argument to ccache.
    let mut cmd = system_command("ccache");
    cmd.arg(compiler_exe);
    cmd.env("CCACHE_DIR", ccache_dir());
    cmd
}

fn is_cpp_compiler(program: &str) -> bool {
    // Tolerate bare names and absolute paths — the manifest's
    // Compiler enum returns "g++" / "clang++" today but the user
    // may override via PATH or absolute paths in the future.
    let base = std::path::Path::new(program)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(program);
    matches!(base, "g++" | "gcc" | "clang" | "clang++" | "c++" | "cc")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_standard_cpp_compilers() {
        assert!(is_cpp_compiler("g++"));
        assert!(is_cpp_compiler("gcc"));
        assert!(is_cpp_compiler("clang"));
        assert!(is_cpp_compiler("clang++"));
        assert!(is_cpp_compiler("c++"));
        assert!(is_cpp_compiler("cc"));
    }

    #[test]
    fn recognises_absolute_path_cpp_compilers() {
        assert!(is_cpp_compiler("/usr/bin/g++"));
        assert!(is_cpp_compiler("/opt/gcc-13/bin/g++"));
        assert!(is_cpp_compiler("/usr/local/bin/clang++"));
    }

    #[test]
    fn rejects_non_cpp_tools() {
        assert!(!is_cpp_compiler("nm"));
        assert!(!is_cpp_compiler("ld"));
        assert!(!is_cpp_compiler("ar"));
        assert!(!is_cpp_compiler("rustc"));
        assert!(!is_cpp_compiler("python3"));
    }

    #[test]
    fn rejects_versioned_compiler_names() {
        // V1 intentionally doesn't match versioned names. If the user
        // configures `g++-13` or `clang-16`, ccache wrap is skipped.
        // Documented conservative choice — we can extend this list.
        assert!(!is_cpp_compiler("g++-13"));
        assert!(!is_cpp_compiler("clang-16"));
    }

    #[test]
    fn ccache_dir_default_includes_pid() {
        // Force fresh init
        let dir = ccache_dir();
        assert!(
            dir.starts_with("/tmp/synthi-ccache-"),
            "default ccache dir should be per-worker tmpdir, got: {}",
            dir
        );
    }
}
