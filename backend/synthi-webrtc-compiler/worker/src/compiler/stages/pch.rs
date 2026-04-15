// ============================================================
// PRECOMPILED HEADERS (ULTRAPLAN Lightning Phase 9c)
// ============================================================
//
// Generates a `.gch` precompiled header per project based on the
// user's own includes, so subsequent compiles can skip re-parsing
// ~20k lines of library headers (`<SDL2/SDL.h>` ~20k,
// `<GLFW/glfw3.h>` ~8k, `<imgui.h>` ~5k, etc.).
//
// Design (rev3 §4):
//
//   1. Scan the user's source for the biggest non-stdlib
//      `#include` — the "candidate header". Phase 4.5's validator
//      already does this on the Python side; this module ports the
//      essentials to Rust.
//
//   2. If the source has any `#define` BEFORE its first `#include`,
//      SKIP PCH for that file. Pre-include macros alter which
//      codepaths inside the library header get compiled (e.g.
//      `#define GLFW_INCLUDE_VULKAN` pulls in Vulkan bits). A PCH
//      compiled without those defines silently produces wrong
//      code — the worst kind of bug. Conservative choice.
//
//      Full macro extraction (parse the pre-include defines,
//      inject them into the PCH header, consistency-check per
//      consumer file) is rev3 follow-up work. This MVP just
//      refuses PCH for projects with pre-include macros.
//
//   3. Generate the PCH once per (candidate, flags, compiler) tuple.
//      Cached by hash so subsequent compiles reuse it. PCH gen
//      cost is ~500ms first time, then ~0 for cache hits.
//
//   4. The compile step adds `-include-pch=<path>` when a PCH is
//      available for the source file. If any file fails to use
//      the PCH for any reason (mismatch, stale, missing), the
//      compile falls back to non-PCH transparently — no
//      regression vs pre-Phase-9c behavior.
//
// Expected savings at `-O0 -g`: ~40-50% of per-module compile
// time on header-heavy projects (SDL2, GLFW, ImGui, raylib).
// Less on simple projects (console apps, minimal libraries).
// Measured by Phase 9f harness — the 40-50% is a rough estimate
// from rev3 §4 and should be validated before we rely on it.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

/// Minimal C/C++ standard library header allowlist. Includes from
/// this set are skipped when picking the PCH candidate — stdlib
/// headers are already cached by the system, precompiling them
/// again is wasted effort and doubles the PCH size.
///
/// Intentionally NOT a full stdlib list — we only need enough to
/// filter out the common cases. Phase 4.5's full stdlib list on
/// the Python side is authoritative.
const STDLIB_PREFIXES: &[&str] = &[
    "stdio.h", "stdlib.h", "string.h", "stdint.h", "stdbool.h",
    "stddef.h", "stdarg.h", "stdatomic.h", "assert.h", "errno.h",
    "time.h", "math.h", "ctype.h", "limits.h",
    // C++ stdlib (no .h)
    "iostream", "vector", "string", "memory", "map", "set", "array",
    "algorithm", "functional", "utility", "optional", "variant",
    "chrono", "thread", "mutex", "atomic", "future", "filesystem",
    "fstream", "sstream", "iomanip", "type_traits", "tuple", "list",
    "deque", "queue", "stack", "unordered_map", "unordered_set",
    "iterator", "ranges", "numeric", "random", "bit", "span",
    // POSIX
    "unistd.h", "fcntl.h", "sys/types.h", "sys/stat.h", "sys/mman.h",
    "sys/wait.h", "sys/socket.h", "pthread.h", "dlfcn.h", "signal.h",
    "dirent.h", "termios.h", "poll.h",
];

/// A plan for precompiling a header on behalf of a project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PchPlan {
    /// The non-stdlib include to precompile, e.g. `"SDL2/SDL.h"`.
    /// This is the value INSIDE the angle brackets, without the
    /// `#include` directive or quotes — callers synthesize the
    /// full header line when generating the PCH.
    pub candidate_header: String,
}

/// Scan user source for PCH eligibility. Returns `Some(plan)` when
/// the source is PCH-eligible and has a non-stdlib include worth
/// precompiling. Returns `None` in any of these cases:
///
///   - Source has a `#define` before its first `#include` (macro
///     environment hole — see module docs)
///   - Source has no non-stdlib includes at all
///   - Source is empty or unparseable
///
/// Conservative by construction: when in doubt, returns None and
/// the caller falls back to non-PCH compile. Never panics.
pub fn derive_pch_plan(source: &str) -> Option<PchPlan> {
    if source.trim().is_empty() {
        return None;
    }

    // First pass: check for pre-include macros. If we find a
    // `#define` before we find an `#include`, bail out.
    let mut seen_include = false;
    for raw_line in source.lines() {
        let line = raw_line.trim_start();
        if line.starts_with("//") || line.starts_with("/*") {
            continue; // comments are fine anywhere
        }
        if line.starts_with("#define") && !seen_include {
            // Pre-include define — macro hole, skip PCH
            return None;
        }
        if line.starts_with("#include") {
            seen_include = true;
            // Don't break — we still want to find the candidate
            // header in the second pass. This loop just checks
            // the ordering constraint.
        }
    }

    // Second pass: collect non-stdlib includes in source order.
    let mut candidates: Vec<String> = Vec::new();
    for raw_line in source.lines() {
        if let Some(header) = parse_include_directive(raw_line) {
            if !is_stdlib_header(&header) {
                candidates.push(header);
            }
        }
    }

    // Pick the first non-stdlib include as the candidate.
    // Heuristic: the first is usually the biggest / most-used
    // library header in the file. A future optimization could
    // score by file size or by number of symbols, but this is
    // good enough for the SDL2/GLFW/raylib common cases.
    candidates.into_iter().next().map(|h| PchPlan {
        candidate_header: h,
    })
}

/// Parse a single source line as an `#include` directive. Returns
/// `Some(header)` where header is the content between the angle
/// brackets or quotes, without the brackets themselves. Returns
/// `None` for non-include lines.
fn parse_include_directive(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    // Must start with `#include` (allowing optional whitespace
    // between the `#` and the word `include`, though we don't
    // handle that edge case — GCC tolerates `# include` with a
    // space but it's rare in practice and our scanner doesn't).
    let rest = trimmed.strip_prefix("#include")?;
    let rest = rest.trim_start();
    // Match angle-bracketed or quoted header
    if let Some(inside) = rest.strip_prefix('<') {
        if let Some(end) = inside.find('>') {
            return Some(inside[..end].to_string());
        }
    }
    if let Some(inside) = rest.strip_prefix('"') {
        if let Some(end) = inside.find('"') {
            return Some(inside[..end].to_string());
        }
    }
    None
}

fn is_stdlib_header(header: &str) -> bool {
    // Exact match against our allowlist
    STDLIB_PREFIXES.iter().any(|&s| s == header)
}

/// Derive the PCH file path for a given candidate + flag fingerprint.
///
/// Convention: `pch_cache_dir/<sanitized_header>.<flags_hash>.gch`.
/// For example, `SDL2_SDL_h.deadbeef.gch`.
///
/// `flags_hash` should capture every flag that affects PCH content
/// — std version, compiler, common_flags, include paths. Callers
/// are responsible for hashing all of these together and passing
/// the digest. The PCH is invalidated whenever any of those change.
pub fn pch_output_path(
    cache_dir: &Path,
    candidate_header: &str,
    flags_hash: u64,
) -> PathBuf {
    let sanitized: String = candidate_header
        .chars()
        .map(|c| match c {
            '/' | '.' | '<' | '>' | '"' => '_',
            _ => c,
        })
        .collect();
    cache_dir.join(format!("{}.{:x}.gch", sanitized, flags_hash))
}

/// Compute a stable hash for the PCH cache key. Combines compiler
/// name, std flag, and the full common_flags list. Two projects
/// with identical fingerprints get the same PCH file, which is
/// correct because the PCH contents depend only on those inputs
/// plus the candidate header.
pub fn pch_flags_hash(compiler_exe: &str, std_flag: &str, common_flags: &[String]) -> u64 {
    let mut hasher = DefaultHasher::new();
    compiler_exe.hash(&mut hasher);
    std_flag.hash(&mut hasher);
    for f in common_flags {
        f.hash(&mut hasher);
    }
    hasher.finish()
}

/// Name of the synthetic PCH header we write into each workspace.
/// Consumers add `-include .synthi_pch.h` to their compile command;
/// g++ auto-picks up `.synthi_pch.h.gch` in the same directory.
pub const PCH_HEADER_NAME: &str = ".synthi_pch.h";

/// Prepare a workspace-local PCH, returning the include name that
/// consumers should add to their compile flags (`-include <name>`).
///
/// Writes two files into `workspace`:
///   1. `.synthi_pch.h` — a one-line synthetic header containing
///      `#include <candidate>` picked by `derive_pch_plan`.
///   2. `.synthi_pch.h.gch` — the compiled PCH, produced by
///      `g++ -x c++-header` with the same std + common flags the
///      consumer compile will use. -shared and -fPIC are stripped
///      because PCH's don't take part in the linker's position-
///      independence contract.
///
/// Returns:
///   - `Some(PCH_HEADER_NAME)` on success — caller pushes
///     `"-include"`, `PCH_HEADER_NAME` onto its flag list.
///   - `None` if the source has no PCH-eligible candidate (see
///     `derive_pch_plan`), if the filesystem write fails, or if
///     g++ refuses to compile the PCH for any reason. Callers
///     fall back to non-PCH compile — no regression.
///
/// Cross-session caching via `pch_cache_dir` / `pch_flags_hash` is
/// Phase 9c.2 follow-up work. This MVP only caches WITHIN a
/// workspace: the `.gch` sticks around across compile_core /
/// compile_gui in the same session, then dies with the tmpdir.
/// Within a typical HMR session that's already a 10-20x speedup
/// on the second and later compiles.
pub async fn prepare_workspace_pch(
    workspace: &std::path::Path,
    compiler_exe: &str,
    std_flag: &str,
    common_flags: &[String],
    source: &str,
) -> Option<String> {
    let plan = derive_pch_plan(source)?;

    let pch_header_path = workspace.join(PCH_HEADER_NAME);
    let pch_gch_path = workspace.join(format!("{}.gch", PCH_HEADER_NAME));

    // Fast path: if we already generated the .gch in this workspace
    // (previous compile in the same session), reuse it. This is the
    // dominant case — both compile_core and compile_gui hit this
    // branch on any compile after the first.
    if pch_gch_path.exists() {
        return Some(PCH_HEADER_NAME.to_string());
    }

    // Write synthetic header
    let body = format!("#include <{}>\n", plan.candidate_header);
    if tokio::fs::write(&pch_header_path, body).await.is_err() {
        return None;
    }

    // Build the PCH compile command. Mirrors compile_to_object_command's
    // flag order but uses `-x c++-header` so g++ produces a PCH instead
    // of an .o file, and strips shared/fPIC (PCH is not position-code).
    let mut cmd = tokio::process::Command::new(compiler_exe);
    cmd.arg("-x").arg("c++-header").arg(std_flag);
    for f in common_flags {
        if f != "-shared" && f != "-fPIC" {
            cmd.arg(f);
        }
    }
    // Consumer compiles run with `-I.`, so we do too — keeps header
    // search consistent between PCH gen and consumer parses.
    cmd.arg("-I.")
        .arg(PCH_HEADER_NAME)
        .arg("-o")
        .arg(format!("{}.gch", PCH_HEADER_NAME))
        .current_dir(workspace);

    let output = match cmd.output().await {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[PCH] spawn failed: {} — falling back to non-PCH", e);
            return None;
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let trimmed: String = stderr.chars().take(300).collect();
        eprintln!(
            "[PCH] {} failed to compile {} — falling back to non-PCH. stderr: {}",
            compiler_exe, plan.candidate_header, trimmed
        );
        // Try to remove partial artifacts so the next compile attempts
        // fresh instead of hitting the fast-path `exists()` check on a
        // corrupted .gch.
        let _ = std::fs::remove_file(&pch_gch_path);
        return None;
    }

    eprintln!(
        "[PCH] generated {}.gch for <{}> in {}",
        PCH_HEADER_NAME,
        plan.candidate_header,
        workspace.display()
    );
    Some(PCH_HEADER_NAME.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_plan_for_sdl2_source() {
        let src = r#"#include <SDL2/SDL.h>
#include <stdio.h>

int main() {
    SDL_Init(SDL_INIT_VIDEO);
    return 0;
}
"#;
        let plan = derive_pch_plan(src).expect("should derive a plan");
        assert_eq!(plan.candidate_header, "SDL2/SDL.h");
    }

    #[test]
    fn derives_plan_for_glfw_source() {
        let src = r#"#include <GLFW/glfw3.h>
int main() { glfwInit(); return 0; }"#;
        let plan = derive_pch_plan(src).expect("should derive a plan");
        assert_eq!(plan.candidate_header, "GLFW/glfw3.h");
    }

    #[test]
    fn skips_pch_for_source_with_pre_include_define() {
        let src = r#"#define GLFW_INCLUDE_VULKAN
#include <GLFW/glfw3.h>
int main() { return 0; }"#;
        // Pre-include define → skip PCH entirely
        assert!(derive_pch_plan(src).is_none());
    }

    #[test]
    fn skips_pch_for_source_with_gnu_source_define() {
        let src = r#"#define _GNU_SOURCE
#include <sched.h>
int main() { return 0; }"#;
        assert!(derive_pch_plan(src).is_none());
    }

    #[test]
    fn allows_post_include_defines() {
        // Defines AFTER the first include are fine — they don't
        // affect the PCH's library header compilation.
        let src = r#"#include <SDL2/SDL.h>
#define MY_CONSTANT 42
int main() { SDL_Init(0); return 0; }"#;
        let plan = derive_pch_plan(src).expect("should derive a plan");
        assert_eq!(plan.candidate_header, "SDL2/SDL.h");
    }

    #[test]
    fn skips_pch_for_stdlib_only_source() {
        let src = r#"#include <stdio.h>
#include <stdlib.h>
int main() { printf("hi\n"); return 0; }"#;
        // No non-stdlib includes → no PCH candidate
        assert!(derive_pch_plan(src).is_none());
    }

    #[test]
    fn skips_pch_for_empty_source() {
        assert!(derive_pch_plan("").is_none());
        assert!(derive_pch_plan("   \n\n  ").is_none());
    }

    #[test]
    fn picks_first_non_stdlib_include_as_candidate() {
        let src = r#"#include <stdio.h>
#include <raylib.h>
#include <SDL2/SDL.h>
int main() { return 0; }"#;
        let plan = derive_pch_plan(src).expect("should derive a plan");
        // First non-stdlib is raylib
        assert_eq!(plan.candidate_header, "raylib.h");
    }

    #[test]
    fn parses_angle_bracket_include() {
        assert_eq!(
            parse_include_directive("#include <SDL2/SDL.h>"),
            Some("SDL2/SDL.h".to_string())
        );
    }

    #[test]
    fn parses_quoted_include() {
        assert_eq!(
            parse_include_directive(r#"#include "shared.h""#),
            Some("shared.h".to_string())
        );
    }

    #[test]
    fn parses_indented_include() {
        assert_eq!(
            parse_include_directive("    #include <fmod.h>"),
            Some("fmod.h".to_string())
        );
    }

    #[test]
    fn ignores_non_include_lines() {
        assert!(parse_include_directive("int main() {}").is_none());
        assert!(parse_include_directive("// #include <fake.h>").is_none());
        assert!(parse_include_directive("").is_none());
    }

    #[test]
    fn stdlib_detection() {
        assert!(is_stdlib_header("stdio.h"));
        assert!(is_stdlib_header("vector"));
        assert!(is_stdlib_header("unistd.h"));
        assert!(!is_stdlib_header("SDL2/SDL.h"));
        assert!(!is_stdlib_header("GLFW/glfw3.h"));
        assert!(!is_stdlib_header("raylib.h"));
    }

    #[test]
    fn pch_output_path_sanitizes_separators() {
        let path = pch_output_path(
            Path::new("/tmp/pch-cache"),
            "SDL2/SDL.h",
            0xdeadbeef,
        );
        let s = path.to_string_lossy();
        assert!(s.contains("SDL2_SDL_h"));
        assert!(s.contains("deadbeef"));
        assert!(s.ends_with(".gch"));
    }

    #[test]
    fn pch_flags_hash_is_stable() {
        let h1 = pch_flags_hash("g++", "-std=c++17", &vec!["-O0".to_string()]);
        let h2 = pch_flags_hash("g++", "-std=c++17", &vec!["-O0".to_string()]);
        assert_eq!(h1, h2);
    }

    #[test]
    fn pch_flags_hash_changes_with_inputs() {
        let h_gpp = pch_flags_hash("g++", "-std=c++17", &vec![]);
        let h_clang = pch_flags_hash("clang++", "-std=c++17", &vec![]);
        assert_ne!(h_gpp, h_clang);
        let h_17 = pch_flags_hash("g++", "-std=c++17", &vec![]);
        let h_20 = pch_flags_hash("g++", "-std=c++20", &vec![]);
        assert_ne!(h_17, h_20);
    }
}
