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

// ============================================================
// ULTRAPLAN Phase 9b — Two-step compile+link split
// ============================================================
//
// The traditional fused invocation is:
//
//     g++ <common_flags> source.cpp -o lib.so <link_flags>
//
// where `common_flags` includes `-shared -fPIC -g -gdwarf-4 ...` so
// g++ does both compile and link in one shot. That's a single
// process spawn (~300-600ms cold), but `ccache` from Phase 9a can't
// cache it — ccache only caches compilations invoked with the `-c`
// flag.
//
// Phase 9b splits the invocation into:
//
//   (1) ccache g++ <compile_flags> -c source.cpp -o source.o
//   (2)        g++ -shared source.o -o lib.so <link_flags>
//
// Step 1 is ccache-wrapped, so unchanged modules hit the ccache
// store and return the cached `.o` in ~5ms. Step 2 is a pure link
// invocation — fast (~30ms) regardless of caching.
//
// Net cost model:
//   - Cold compile (first session build):         ~330ms (was ~330ms fused — neutral)
//   - Incremental compile with unchanged module:   ~35ms (was ~330ms — 10x faster)
//   - Incremental compile with changed module:    ~330ms (was ~330ms — neutral)
//
// The win is specifically for the N-1 unchanged modules on any
// compile where only 1 of 3 changed. Phase 9d's parallel dispatch
// stacks with this: unchanged modules get ccache hits AND run in
// parallel with the changed one.
//
// ─── Design choices ─────────────────────────────────────────────
//
// - `-shared` is stripped from common_flags at the compile step
//   (it's a link-only flag; g++ rejects `-c` + `-shared`). Every
//   other flag passes through transparently.
// - `-fPIC` STAYS in the compile step — it's required for PIC
//   object files, which ARE valid inputs to a shared-library link.
// - The link step uses plain `system_command(compiler)` — no
//   ccache wrap. ccache can't cache link outputs, so wrapping just
//   adds a wasted process spawn.
// - Callers pass the OBJECT output path; this helper doesn't
//   derive it from the .so path. Callers know the timestamp and
//   filename conventions they want.

/// Build a compile-only g++ invocation that produces a .o file.
///
/// The resulting command is meant to be spawned, awaited, and checked
/// for success. Callers chain it with `link_object_to_so_command` to
/// produce the final .so. On ccache-enabled hosts, the compile step
/// is transparently cached by ccache's preprocessed-source hash —
/// callers never touch ccache directly.
///
/// Parameters:
///   - `compiler_exe`: `g++`, `clang++`, etc. from manifest
///   - `source_file`: filename relative to `workspace_dir` (e.g. `"core.cpp"`)
///   - `object_out`: absolute path where the .o should land
///   - `std_flag`: e.g. `"-std=c++17"`, pre-formatted by the caller
///   - `common_flags`: manifest `common_flags` — `-shared` is stripped
///     automatically; everything else passes through
///   - `workspace_dir`: set as the command's cwd
pub fn compile_to_object_command(
    compiler_exe: &str,
    source_file: &str,
    object_out: &std::path::Path,
    std_flag: &str,
    common_flags: &[String],
    workspace_dir: &std::path::Path,
) -> Command {
    let mut cmd = cpp_compile_command(compiler_exe);
    cmd.arg(std_flag);
    // -c: compile only, produce object file. Without this, ccache
    // doesn't recognise the invocation as cacheable.
    cmd.arg("-c");
    // Strip `-shared` from compile-step flags — g++ rejects `-c`
    // + `-shared` as mutually exclusive. `-fPIC` and all other
    // common flags pass through transparently.
    for f in common_flags {
        if f != "-shared" {
            cmd.arg(f);
        }
    }
    cmd.arg(source_file).arg("-I.");
    cmd.arg("-o").arg(object_out);
    cmd.current_dir(workspace_dir);
    cmd
}

/// Build a link-only g++ invocation that links object file(s) into
/// a shared library. No ccache wrap — ccache can't cache link
/// invocations, so wrapping just wastes a process spawn.
///
/// Parameters:
///   - `compiler_exe`: same as `compile_to_object_command` (g++/clang++)
///   - `object_file`: absolute path to the .o input
///   - `so_out`: absolute path where the linked .so should land
///   - `link_flags`: all link-step args — manifest `core_link_flags`
///     / `gui_link_flags` / `runner_link_flags`, plus any hardcoded
///     boilerplate like `-ldl -pthread -rdynamic`
///   - `workspace_dir`: set as the command's cwd
pub fn link_object_to_so_command(
    compiler_exe: &str,
    object_file: &std::path::Path,
    so_out: &std::path::Path,
    link_flags: &[String],
    workspace_dir: &std::path::Path,
) -> Command {
    // Plain system_command (not cpp_compile_command) — the link step
    // isn't cachable by ccache, so we skip the wrapper entirely to
    // avoid the extra process spawn.
    let mut cmd = crate::infra::utils::system_command(compiler_exe);
    cmd.arg("-shared");
    cmd.arg(object_file);
    cmd.arg("-o").arg(so_out);
    for f in link_flags {
        cmd.arg(f);
    }
    cmd.current_dir(workspace_dir);
    cmd
}

/// Derive the .o output path that corresponds to a given .so output
/// path. Convention: `libfoo_<ts>.so` → `foo_<ts>.o`. The `.o` lives
/// in the same directory as the `.so` so both are easy to clean up
/// together.
pub fn object_path_for_so(so_path: &std::path::Path) -> std::path::PathBuf {
    // Strip the "lib" prefix if present and replace the .so extension
    // with .o. Fallback: just swap the extension.
    let stem = so_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("out");
    let stem_no_lib = stem.strip_prefix("lib").unwrap_or(stem);
    let parent = so_path.parent().unwrap_or(std::path::Path::new("."));
    parent.join(format!("{}.o", stem_no_lib))
}

/// Build a link-only g++ invocation that links an object file into
/// an EXECUTABLE (not a shared library). Mirrors
/// `link_object_to_so_command` but omits `-shared` — used by
/// `compile_runner` to produce the per-project host_runner binary.
///
/// Same rationale for no ccache wrap as `link_object_to_so_command`.
pub fn link_object_to_exec_command(
    compiler_exe: &str,
    object_file: &std::path::Path,
    exec_out: &std::path::Path,
    link_flags: &[String],
    workspace_dir: &std::path::Path,
) -> Command {
    let mut cmd = crate::infra::utils::system_command(compiler_exe);
    cmd.arg(object_file);
    cmd.arg("-o").arg(exec_out);
    for f in link_flags {
        cmd.arg(f);
    }
    cmd.current_dir(workspace_dir);
    cmd
}

/// Derive the .o output path for an executable target. Convention:
/// `host_runner_<ts>` → `host_runner_<ts>.o`. Same directory as the
/// executable for uniform cleanup.
pub fn object_path_for_exec(exec_path: &std::path::Path) -> std::path::PathBuf {
    let stem = exec_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("out");
    let parent = exec_path.parent().unwrap_or(std::path::Path::new("."));
    parent.join(format!("{}.o", stem))
}

fn is_cpp_compiler(program: &str) -> bool {
    // Tolerate bare names and absolute paths — the manifest's
    // Compiler enum returns "g++" / "clang++" today but the user
    // may override via PATH or absolute paths in the future.
    //
    // Device compilers (`nvcc`, `hipcc`, and clang-cuda invocations)
    // are intentionally EXCLUDED here: ccache doesn't understand
    // cubin/hsaco artifacts, and even when it caches a host-side
    // intermediate it can produce subtly wrong PTX on a hit. The
    // device-compile cache lives in `compile_device.rs` and uses
    // `IncrementalCache` keyed on (device_src, device_flags, arch_list).
    // See GPU_HMR_ULTRAPLAN §5.3.
    let base = std::path::Path::new(program)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(program);
    if is_device_compiler(base) {
        return false;
    }
    matches!(base, "g++" | "gcc" | "clang" | "clang++" | "c++" | "cc")
}

/// True for any executable that produces GPU device code. We disable
/// ccache wrapping for these (see `is_cpp_compiler`).
///
/// Note: `clang-cuda` isn't a distinct executable — it's clang invoked
/// with `--cuda-gpu-arch=…`. There's no clean way to detect the CUDA
/// mode from the executable name alone, so we accept that a clang call
/// without `--cuda-gpu-arch` still hits ccache. The device-compile
/// stage routes through `select_compiler(ModuleKind::Device)` and the
/// device stage uses `system_command(...)` directly (never
/// `cpp_compile_command`), so the wrap can't accidentally happen.
pub fn is_device_compiler(program: &str) -> bool {
    let base = std::path::Path::new(program)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(program);
    matches!(base, "nvcc" | "hipcc")
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
    fn nvcc_is_not_a_cpp_compiler_for_ccache_purposes() {
        // GPU_HMR_ULTRAPLAN §5.3: device compilers must not be wrapped
        // by ccache — ccache doesn't understand cubin/hsaco hashing
        // and the device-compile cache (IncrementalCache) lives in
        // compile_device.rs.
        assert!(!is_cpp_compiler("nvcc"));
        assert!(!is_cpp_compiler("/usr/local/cuda/bin/nvcc"));
    }

    #[test]
    fn hipcc_is_not_a_cpp_compiler_for_ccache_purposes() {
        assert!(!is_cpp_compiler("hipcc"));
        assert!(!is_cpp_compiler("/opt/rocm/bin/hipcc"));
    }

    #[test]
    fn is_device_compiler_recognises_nvcc_and_hipcc() {
        assert!(is_device_compiler("nvcc"));
        assert!(is_device_compiler("hipcc"));
        assert!(is_device_compiler("/usr/local/cuda/bin/nvcc"));
        assert!(is_device_compiler("/opt/rocm/bin/hipcc"));
        assert!(!is_device_compiler("g++"));
        assert!(!is_device_compiler("clang++"));
    }

    #[test]
    fn cpp_compile_command_for_nvcc_uses_plain_system_command() {
        // Build the command; we can't inspect the spawned process,
        // but we can at least confirm the function returns without
        // requiring `ccache` to exist. The smoke is that for nvcc the
        // wrap path is skipped, and the helper still returns a Command
        // that names the right program.
        let cmd = cpp_compile_command("nvcc");
        let program = cmd.as_std().get_program().to_string_lossy().into_owned();
        // Whether it's "nvcc" or wrapped via wsl depends on
        // system_command's WSL plumbing; assert it does NOT contain
        // "ccache" — that's the regression we're guarding against.
        assert!(!program.contains("ccache"), "got program={program}");
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
