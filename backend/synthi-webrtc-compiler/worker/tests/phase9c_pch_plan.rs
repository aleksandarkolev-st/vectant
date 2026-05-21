// ============================================================
// Phase 9c (ULTRAPLAN Lightning) — PCH plan derivation integration tests
// ============================================================
//
// Exercises the public surface of `stages::pch`:
//   - `derive_pch_plan(source)` — accepts/rejects source for PCH
//   - `pch_output_path(cache_dir, candidate, flags_hash)` — path derivation
//   - `pch_flags_hash(...)` — cache key stability
//
// The module's internal helpers (parse_include_directive,
// is_stdlib_header) are tested in the inline `#[cfg(test)] mod tests`
// block inside pch.rs. This file tests the public API across the
// binary boundary — same pattern as phase3-phase9b suites.
//
// Phase 9c scope is intentionally narrow for the MVP: the pch.rs
// module produces plans and cache paths, but it's NOT YET wired into
// the compile stages. Wiring (PCH generation via `g++ -x c++-header`
// + per-file fallback on mismatch + cache hit rate tracking) is
// follow-up work. Shipping the logic layer first so it can be
// reviewed + tested independently of the compile-stage integration.

use worker::compiler::stages::pch::{derive_pch_plan, pch_flags_hash, pch_output_path};

// ────────────────────────────────────────────────────────────
// derive_pch_plan — public plan derivation
// ────────────────────────────────────────────────────────────

#[test]
fn derives_plan_for_sdl2_project() {
    let src = r#"#include <SDL2/SDL.h>
#include <stdio.h>

int main() {
    SDL_Init(SDL_INIT_VIDEO);
    return 0;
}
"#;
    let plan = derive_pch_plan(src).expect("SDL2 project should derive a plan");
    assert_eq!(plan.candidate_header, "SDL2/SDL.h");
}

#[test]
fn derives_plan_for_glfw_project() {
    let src = r#"#include <GLFW/glfw3.h>
int main() { glfwInit(); return 0; }"#;
    let plan = derive_pch_plan(src).expect("GLFW project should derive a plan");
    assert_eq!(plan.candidate_header, "GLFW/glfw3.h");
}

#[test]
fn derives_plan_for_raylib_project() {
    let src = r#"#include <raylib.h>
int main() { InitWindow(800, 600, "test"); return 0; }"#;
    let plan = derive_pch_plan(src).expect("raylib project should derive a plan");
    assert_eq!(plan.candidate_header, "raylib.h");
}

#[test]
fn skips_pch_for_source_with_pre_include_macro_glfw_vulkan() {
    // Common real-world case: GLFW_INCLUDE_VULKAN alters the glfw3.h
    // content significantly. A PCH compiled without the macro silently
    // produces wrong code. Conservative choice: skip PCH entirely.
    let src = r#"#define GLFW_INCLUDE_VULKAN
#include <GLFW/glfw3.h>
int main() { return 0; }"#;
    assert!(
        derive_pch_plan(src).is_none(),
        "source with pre-include #define must disable PCH"
    );
}

#[test]
fn skips_pch_for_source_with_gnu_source_define() {
    // Another real-world case: _GNU_SOURCE enables glibc extensions
    // in POSIX headers. Same category — pre-include macro.
    let src = r#"#define _GNU_SOURCE
#include <sched.h>
#include <SDL2/SDL.h>
int main() { return 0; }"#;
    assert!(derive_pch_plan(src).is_none());
}

#[test]
fn allows_post_include_defines() {
    // Defines AFTER the first #include don't affect the PCH's header
    // compilation — the PCH is already done by then. These are fine.
    let src = r#"#include <SDL2/SDL.h>
#define MY_MAX_FPS 60
#define MY_WINDOW_W 800
int main() { return 0; }"#;
    let plan = derive_pch_plan(src).expect("post-include defines should be fine");
    assert_eq!(plan.candidate_header, "SDL2/SDL.h");
}

#[test]
fn skips_pch_for_stdlib_only_project() {
    // Pure console app with no library → no PCH candidate.
    let src = r#"#include <stdio.h>
#include <stdlib.h>
#include <string>
#include <vector>
int main() { printf("hello\n"); return 0; }"#;
    assert!(
        derive_pch_plan(src).is_none(),
        "stdlib-only project has no PCH candidate"
    );
}

#[test]
fn skips_pch_for_empty_source() {
    assert!(derive_pch_plan("").is_none());
    assert!(derive_pch_plan("   \n\n\t\n   ").is_none());
    assert!(derive_pch_plan("// just a comment\n").is_none());
}

#[test]
fn picks_first_non_stdlib_include() {
    // Multiple non-stdlib includes — first one wins. This is a
    // heuristic; a smarter selector could score by header size or
    // by symbol count, but first-wins works for SDL2/GLFW/raylib/etc.
    let src = r#"#include <stdio.h>
#include <raylib.h>
#include <SDL2/SDL.h>
int main() { return 0; }"#;
    let plan = derive_pch_plan(src).expect("should derive a plan");
    assert_eq!(plan.candidate_header, "raylib.h");
}

#[test]
fn handles_quoted_includes() {
    // Project with local + library includes. Local headers come
    // first (common convention) — PCH picks the first non-stdlib
    // header, which may be a local file. That's actually OK: the
    // PCH just wraps it up faster.
    let src = r#"#include "shared.h"
#include <SDL2/SDL.h>
int main() { return 0; }"#;
    let plan = derive_pch_plan(src).expect("should derive a plan");
    assert_eq!(plan.candidate_header, "shared.h");
}

#[test]
fn allows_comments_before_pre_include_defines() {
    let src = r#"// Copyright header
/*
 * License terms
 */

#include <SDL2/SDL.h>
int main() { return 0; }"#;
    let plan = derive_pch_plan(src).expect("comments are fine before includes");
    assert_eq!(plan.candidate_header, "SDL2/SDL.h");
}

// ────────────────────────────────────────────────────────────
// pch_output_path — cache path derivation
// ────────────────────────────────────────────────────────────

#[test]
fn pch_path_sanitizes_slashes() {
    let path = pch_output_path(std::path::Path::new("/tmp/pch"), "SDL2/SDL.h", 0xdeadbeef);
    let s = path.to_string_lossy();
    assert!(
        s.contains("SDL2_SDL_h"),
        "slashes should be replaced: {}",
        s
    );
    assert!(!s.contains("SDL2/SDL.h"));
    assert!(s.ends_with(".gch"));
}

#[test]
fn pch_path_embeds_flags_hash() {
    let path_a = pch_output_path(std::path::Path::new("/tmp/pch"), "GLFW/glfw3.h", 0x1111);
    let path_b = pch_output_path(std::path::Path::new("/tmp/pch"), "GLFW/glfw3.h", 0x2222);
    assert_ne!(
        path_a, path_b,
        "different flag hashes must produce different PCH paths"
    );
}

#[test]
fn pch_path_isolates_different_candidate_headers() {
    let sdl2 = pch_output_path(std::path::Path::new("/tmp/pch"), "SDL2/SDL.h", 0xdead);
    let glfw = pch_output_path(std::path::Path::new("/tmp/pch"), "GLFW/glfw3.h", 0xdead);
    assert_ne!(
        sdl2, glfw,
        "different headers must produce different PCH paths"
    );
}

// ────────────────────────────────────────────────────────────
// pch_flags_hash — cache key stability and sensitivity
// ────────────────────────────────────────────────────────────

#[test]
fn flags_hash_is_deterministic() {
    let h1 = pch_flags_hash(
        "g++",
        "-std=c++17",
        &vec!["-O0".to_string(), "-fPIC".to_string()],
    );
    let h2 = pch_flags_hash(
        "g++",
        "-std=c++17",
        &vec!["-O0".to_string(), "-fPIC".to_string()],
    );
    assert_eq!(h1, h2, "same inputs produce same hash");
}

#[test]
fn flags_hash_changes_with_compiler() {
    let gpp = pch_flags_hash("g++", "-std=c++17", &vec![]);
    let clang = pch_flags_hash("clang++", "-std=c++17", &vec![]);
    assert_ne!(gpp, clang);
}

#[test]
fn flags_hash_changes_with_std_version() {
    let cpp17 = pch_flags_hash("g++", "-std=c++17", &vec![]);
    let cpp20 = pch_flags_hash("g++", "-std=c++20", &vec![]);
    assert_ne!(cpp17, cpp20);
}

#[test]
fn flags_hash_changes_with_common_flags() {
    let base = pch_flags_hash("g++", "-std=c++17", &vec!["-O0".to_string()]);
    let with_opt = pch_flags_hash(
        "g++",
        "-std=c++17",
        &vec!["-O0".to_string(), "-g".to_string()],
    );
    assert_ne!(base, with_opt);
}

#[test]
fn flags_hash_is_order_sensitive() {
    // Conservative choice: flag order matters. `-O0 -g` and `-g -O0`
    // produce different hashes. This may produce some spurious cache
    // misses when the manifest reorders flags but catches real
    // semantic differences when the user passes conflicting flags in
    // a specific order.
    let h_a = pch_flags_hash(
        "g++",
        "-std=c++17",
        &vec!["-O0".to_string(), "-g".to_string()],
    );
    let h_b = pch_flags_hash(
        "g++",
        "-std=c++17",
        &vec!["-g".to_string(), "-O0".to_string()],
    );
    assert_ne!(h_a, h_b);
}
