// ============================================================
// Phase 4 (ULTRAPLAN) — Host runner compilation integration tests
// ============================================================
//
// Coverage targets (see HMR_AGNOSTIC_ULTRAPLAN.md §7 Phase 4):
//
//   adapted_project.rs:
//     - 3-file shape (no host_runner) — backward compat with pre-Phase-4
//     - 4-file shape (host_runner.cpp present) — new path, host_runner_path set
//     - BYOR sentinel detection (first non-blank line)
//     - BYOR with leading whitespace and blank lines
//     - BYOR sentinel NOT on first non-blank line (must NOT trigger)
//     - sentinel exact-match (substring matches must NOT trigger)
//
//   compile_runner.rs:
//     - build_runner_flag_list: strips -shared / -fPIC from common_flags
//     - build_runner_flag_list: includes runner_link_flags (not gui/core)
//     - build_runner_flag_list: always appends -ldl + -rdynamic
//     - build_runner_flag_list: -std flag derived from manifest.std
//     - build_runner_flag_list: clang++ + c++20 + glfw scenario
//     - build_runner_flag_list: empty manifest (sdl2_default round-trip)
//     - build_runner_flag_list: FMOD process_restart manifest
//     - HOST_RUNNER_FILENAME constant matches the universal split prompt
//
// Why integration tests instead of inline `#[cfg(test)] mod tests`:
// the worker lib's test binary has pre-existing compile errors in
// unrelated wave integration test modules that block `cargo test --lib`.
// Tests in `tests/` compile to their own binary linking against the
// (cleanly compiling) lib only — same pattern as phase3_compile_manifest.rs.
//
// Things NOT covered here (and why):
//   - end-to-end compile_runner with real g++: requires a full
//     CompileContext (WebRTC RTCDataChannel + 14 other Arc<Mutex<>> deps),
//     impractical for a unit test. Will be exercised via Phase 7 corpus.
//   - handler.rs flow (split_data → host_runner write → compile call):
//     also blocked on CompileContext. Will be exercised in Phase 7.

use std::fs;
use std::path::PathBuf;
use worker::compiler::stages::compile_runner::{build_runner_flag_list, HOST_RUNNER_FILENAME};
use worker::hmr::adapted_project::{
    detect_adapted_project, host_runner_is_user_owned, AdaptedProjectStatus, BYOR_SENTINEL,
};
use worker::hmr::compile_manifest::{
    CompileManifest, Compiler, ConfidenceBlock, ConfidenceLevel, HotReloadMode,
};

// ============================================================
// Test fixture helpers
// ============================================================

/// Creates a unique tempdir under the system temp root, returns its
/// PathBuf. Caller is responsible for `fs::remove_dir_all`.
fn fresh_tempdir(label: &str) -> PathBuf {
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("phase4_hr_{}_{}_{}", label, pid, nanos));
    fs::create_dir_all(&dir).expect("create tempdir");
    dir
}

fn cleanup(dir: &PathBuf) {
    let _ = fs::remove_dir_all(dir);
}

fn write_split_files(dir: &PathBuf) {
    fs::write(dir.join("core.cpp"), "// core").unwrap();
    fs::write(dir.join("gui.cpp"), "// gui").unwrap();
    fs::write(dir.join("shared.h"), "// shared").unwrap();
}

// ============================================================
// adapted_project.rs — 3-file backward compat
// ============================================================

#[test]
fn detects_3_file_shape_as_adapted_without_host_runner() {
    let dir = fresh_tempdir("3file");
    write_split_files(&dir);
    // Note: NO host_runner.cpp written.
    let status = detect_adapted_project(&dir);
    assert!(status.is_adapted, "3-file shape should still be adapted");
    assert!(status.core_path.is_some());
    assert!(status.gui_path.is_some());
    assert!(status.shared_path.is_some());
    assert!(
        status.host_runner_path.is_none(),
        "no host_runner.cpp on disk → host_runner_path must be None"
    );
    assert!(
        !status.user_owned_runner,
        "no host_runner.cpp → user_owned_runner must default to false"
    );
    cleanup(&dir);
}

// ============================================================
// adapted_project.rs — 4-file shape detection
// ============================================================

#[test]
fn detects_4_file_shape_with_ai_owned_host_runner() {
    let dir = fresh_tempdir("4file_ai");
    write_split_files(&dir);
    fs::write(
        dir.join(HOST_RUNNER_FILENAME),
        "// AI-generated runner\nint main() { return 0; }\n",
    )
    .unwrap();
    let status = detect_adapted_project(&dir);
    assert!(status.is_adapted);
    assert!(status.host_runner_path.is_some());
    assert_eq!(
        status
            .host_runner_path
            .as_ref()
            .unwrap()
            .file_name()
            .unwrap(),
        HOST_RUNNER_FILENAME
    );
    assert!(
        !status.user_owned_runner,
        "AI-owned runner should NOT trip BYOR sentinel"
    );
    cleanup(&dir);
}

#[test]
fn detects_byor_sentinel_on_first_line() {
    let dir = fresh_tempdir("byor_first");
    write_split_files(&dir);
    fs::write(
        dir.join(HOST_RUNNER_FILENAME),
        "// SYNTHI_USER_RUNNER\nint main() { return 0; }\n",
    )
    .unwrap();
    let status = detect_adapted_project(&dir);
    assert!(status.is_adapted);
    assert!(status.host_runner_path.is_some());
    assert!(
        status.user_owned_runner,
        "BYOR sentinel on first line MUST trip user_owned_runner"
    );
    cleanup(&dir);
}

#[test]
fn detects_byor_sentinel_with_leading_blank_lines() {
    let dir = fresh_tempdir("byor_blanks");
    write_split_files(&dir);
    fs::write(
        dir.join(HOST_RUNNER_FILENAME),
        "\n\n   \n// SYNTHI_USER_RUNNER\nint main() { return 0; }\n",
    )
    .unwrap();
    let status = detect_adapted_project(&dir);
    assert!(
        status.user_owned_runner,
        "BYOR sentinel as first non-blank line must trip the flag"
    );
    cleanup(&dir);
}

#[test]
fn detects_byor_sentinel_with_leading_whitespace() {
    let dir = fresh_tempdir("byor_indent");
    write_split_files(&dir);
    // Sentinel indented — must still match because we trim() each line.
    fs::write(
        dir.join(HOST_RUNNER_FILENAME),
        "    // SYNTHI_USER_RUNNER\nint main() {}",
    )
    .unwrap();
    let status = detect_adapted_project(&dir);
    assert!(
        status.user_owned_runner,
        "BYOR sentinel with leading whitespace should still match (lines are trimmed)"
    );
    cleanup(&dir);
}

#[test]
fn rejects_byor_sentinel_when_not_on_first_non_blank_line() {
    let dir = fresh_tempdir("byor_late");
    write_split_files(&dir);
    // Sentinel buried — earlier non-blank line wins, sentinel ignored.
    fs::write(
        dir.join(HOST_RUNNER_FILENAME),
        "#include <SDL2/SDL.h>\n// SYNTHI_USER_RUNNER\nint main() {}",
    )
    .unwrap();
    let status = detect_adapted_project(&dir);
    assert!(
        !status.user_owned_runner,
        "BYOR sentinel must be on the FIRST non-blank line — buried sentinels do not count"
    );
    cleanup(&dir);
}

#[test]
fn rejects_byor_sentinel_substring() {
    let dir = fresh_tempdir("byor_substring");
    write_split_files(&dir);
    // Substring with extra prefix → not exact match.
    fs::write(
        dir.join(HOST_RUNNER_FILENAME),
        "// SYNTHI_USER_RUNNER_EXTENDED\nint main() {}",
    )
    .unwrap();
    let status = detect_adapted_project(&dir);
    assert!(
        !status.user_owned_runner,
        "BYOR sentinel must be exact match, not substring"
    );
    cleanup(&dir);
}

#[test]
fn rejects_byor_sentinel_in_block_comment_first_line() {
    let dir = fresh_tempdir("byor_block_comment");
    write_split_files(&dir);
    // Block comment on first line — does not start with `// SYNTHI_USER_RUNNER`.
    fs::write(
        dir.join(HOST_RUNNER_FILENAME),
        "/* SYNTHI_USER_RUNNER */\nint main() {}",
    )
    .unwrap();
    let status = detect_adapted_project(&dir);
    assert!(
        !status.user_owned_runner,
        "block-comment sentinel does not match — must be `//` line comment"
    );
    cleanup(&dir);
}

#[test]
fn host_runner_is_user_owned_returns_false_for_missing_file() {
    let dir = fresh_tempdir("missing_runner");
    let nonexistent = dir.join("does_not_exist.cpp");
    assert!(
        !host_runner_is_user_owned(&nonexistent),
        "missing file should default to AI-owned (false), not panic"
    );
    cleanup(&dir);
}

#[test]
fn host_runner_is_user_owned_returns_false_for_empty_file() {
    let dir = fresh_tempdir("empty_runner");
    fs::write(dir.join("empty.cpp"), "").unwrap();
    assert!(
        !host_runner_is_user_owned(&dir.join("empty.cpp")),
        "empty file should default to AI-owned (false)"
    );
    cleanup(&dir);
}

#[test]
fn host_runner_is_user_owned_handles_only_blank_lines() {
    let dir = fresh_tempdir("blank_runner");
    fs::write(dir.join("blank.cpp"), "\n\n   \n\t\n").unwrap();
    assert!(
        !host_runner_is_user_owned(&dir.join("blank.cpp")),
        "all-blank file should default to AI-owned (false), not panic"
    );
    cleanup(&dir);
}

#[test]
fn byor_sentinel_constant_is_exact() {
    // Lock the public constant so a typo regression on the sentinel
    // (e.g. lowercased or rephrased) is caught at build time, not
    // silently in production where every project would suddenly become
    // user-owned (or no project would, depending on the typo direction).
    assert_eq!(BYOR_SENTINEL, "// SYNTHI_USER_RUNNER");
}

// ============================================================
// adapted_project.rs — adapted_full constructor
// ============================================================

#[test]
fn adapted_full_constructor_sets_all_fields() {
    let core = PathBuf::from("/tmp/core.cpp");
    let gui = PathBuf::from("/tmp/gui.cpp");
    let shared = Some(PathBuf::from("/tmp/shared.h"));
    let runner = PathBuf::from("/tmp/host_runner.cpp");
    let status = AdaptedProjectStatus::adapted_full(
        core.clone(),
        gui.clone(),
        shared.clone(),
        runner.clone(),
        true,
    );
    assert!(status.is_adapted);
    assert_eq!(status.core_path, Some(core));
    assert_eq!(status.gui_path, Some(gui));
    assert_eq!(status.shared_path, shared);
    assert_eq!(status.host_runner_path, Some(runner));
    assert!(status.user_owned_runner);
    assert!(status.split_hash.is_none());
    assert!(status.reason.is_none());
}

// ============================================================
// compile_runner.rs — build_runner_flag_list pure function
// ============================================================

fn make_test_manifest(
    compiler: Compiler,
    std: &str,
    common_flags: Vec<&str>,
    runner_link_flags: Vec<&str>,
) -> CompileManifest {
    CompileManifest {
        compiler,
        std: std.to_string(),
        common_flags: common_flags.into_iter().map(String::from).collect(),
        core_link_flags: vec![],
        gui_link_flags: vec![],
        shared_link_flags: vec![],
        runner_link_flags: runner_link_flags.into_iter().map(String::from).collect(),
        files: vec![],
        module_files: Default::default(),
        system_packages: vec![],
        hot_reload_mode: HotReloadMode::Swap,
        confidence: ConfidenceBlock {
            overall: ConfidenceLevel::High,
            runner_synthesis: ConfidenceLevel::High,
            link_flags: ConfidenceLevel::High,
            notes: String::new(),
        },
        build_steps: None,
        gpu: None,
    }
}

#[test]
fn flag_list_strips_shared_and_fpic_from_common_flags() {
    // The runner is an executable. -shared and -fPIC make sense for
    // libcore.so/libgui.so but break the link when applied to an
    // executable target. They MUST be filtered out.
    let m = make_test_manifest(
        Compiler::GccPlusPlus,
        "c++17",
        vec!["-shared", "-fPIC", "-g", "-O0"],
        vec!["-lSDL2"],
    );
    let flags = build_runner_flag_list(&m);
    assert!(!flags.iter().any(|f| f == "-shared"), "must strip -shared");
    assert!(!flags.iter().any(|f| f == "-fPIC"), "must strip -fPIC");
    assert!(
        flags.iter().any(|f| f == "-g"),
        "non-shared/-fPIC flags must pass through"
    );
    assert!(flags.iter().any(|f| f == "-O0"));
}

#[test]
fn flag_list_uses_runner_link_flags_not_gui_or_core() {
    // The compile_runner stage should never link against the gui_link_flags
    // (those are for libgui.so) — runner has its own link flags.
    let mut m = make_test_manifest(
        Compiler::GccPlusPlus,
        "c++17",
        vec![],
        vec!["-lSDL2", "-lpthread"],
    );
    m.gui_link_flags = vec!["-lglfw".to_string()]; // poison pill
    m.core_link_flags = vec!["-lboost".to_string()]; // poison pill
    let flags = build_runner_flag_list(&m);
    assert!(flags.iter().any(|f| f == "-lSDL2"));
    assert!(flags.iter().any(|f| f == "-lpthread"));
    assert!(
        !flags.iter().any(|f| f == "-lglfw"),
        "compile_runner must NOT pull gui_link_flags"
    );
    assert!(
        !flags.iter().any(|f| f == "-lboost"),
        "compile_runner must NOT pull core_link_flags"
    );
}

#[test]
fn flag_list_always_appends_ldl_and_rdynamic() {
    // -ldl is required because the runner itself calls dlopen("./libcore.so").
    // -rdynamic is required so the runner exports symbols the dlopen'd
    // modules can dlsym back via RTLD_DEFAULT (host KV API, etc.).
    let m = make_test_manifest(
        Compiler::GccPlusPlus,
        "c++17",
        vec![],
        vec![], // No runner_link_flags at all
    );
    let flags = build_runner_flag_list(&m);
    assert!(
        flags.iter().any(|f| f == "-ldl"),
        "-ldl must always be present"
    );
    assert!(
        flags.iter().any(|f| f == "-rdynamic"),
        "-rdynamic must always be present"
    );
}

#[test]
fn flag_list_std_flag_matches_manifest_std() {
    let m = make_test_manifest(Compiler::ClangPlusPlus, "c++20", vec![], vec![]);
    let flags = build_runner_flag_list(&m);
    assert!(flags.iter().any(|f| f == "-std=c++20"));
    assert!(!flags.iter().any(|f| f == "-std=c++17"));
}

#[test]
fn flag_list_clang_glfw_c20_scenario() {
    // Realistic clang++ + GLFW + c++20 + filesystem build
    let m = make_test_manifest(
        Compiler::ClangPlusPlus,
        "c++20",
        vec!["-shared", "-fPIC", "-g", "-Wall", "-O2"],
        vec!["-lglfw", "-lGL", "-lm"],
    );
    let flags = build_runner_flag_list(&m);
    // std flag
    assert!(flags.contains(&"-std=c++20".to_string()));
    // common_flags (filtered)
    assert!(!flags.contains(&"-shared".to_string()));
    assert!(!flags.contains(&"-fPIC".to_string()));
    assert!(flags.contains(&"-g".to_string()));
    assert!(flags.contains(&"-Wall".to_string()));
    assert!(flags.contains(&"-O2".to_string()));
    // runner_link_flags
    assert!(flags.contains(&"-lglfw".to_string()));
    assert!(flags.contains(&"-lGL".to_string()));
    assert!(flags.contains(&"-lm".to_string()));
    // Runtime boilerplate
    assert!(flags.contains(&"-ldl".to_string()));
    assert!(flags.contains(&"-rdynamic".to_string()));
}

#[test]
fn flag_list_generic_fallback_round_trip() {
    let m = CompileManifest::generic_fallback();
    let flags = build_runner_flag_list(&m);
    assert!(flags.contains(&"-std=c++26".to_string()));
    assert!(!flags.contains(&"-lSDL2".to_string()));
    assert!(flags.contains(&"-ldl".to_string()));
    // generic fallback common_flags has -shared/-fPIC, both must be stripped
    assert!(!flags.contains(&"-shared".to_string()));
    assert!(!flags.contains(&"-fPIC".to_string()));
    // -D_POSIX_C_SOURCE etc. should pass through
    assert!(flags.iter().any(|f| f.starts_with("-D_POSIX_C_SOURCE")));
}

#[test]
fn flag_list_fmod_process_restart_scenario() {
    let mut m = make_test_manifest(
        Compiler::GccPlusPlus,
        "c++17",
        vec!["-shared", "-fPIC"],
        vec!["-lSDL2", "-lfmod", "-ldl"],
    );
    m.hot_reload_mode = HotReloadMode::ProcessRestart;
    let flags = build_runner_flag_list(&m);
    // FMOD link flag must reach the runner
    assert!(flags.contains(&"-lfmod".to_string()));
    // Even though manifest already lists -ldl, the always-append step
    // adds it again — duplicates are fine for the linker, ordering
    // matters more, and dedup would risk dropping a manifest-specific
    // -ldl that came earlier than expected.
    let ldl_count = flags.iter().filter(|f| f.as_str() == "-ldl").count();
    assert!(ldl_count >= 1, "at least one -ldl must be present");
}

#[test]
fn flag_list_ordering_std_first_libs_last() {
    // The compiler cares about flag ordering for some scenarios (e.g.
    // GCC's --as-needed link gating). Verify the structural ordering
    // contract: -std comes first, common compile flags next, link
    // flags later, dlopen boilerplate at the very end.
    let m = make_test_manifest(Compiler::GccPlusPlus, "c++17", vec!["-O2"], vec!["-lSDL2"]);
    let flags = build_runner_flag_list(&m);
    let std_idx = flags.iter().position(|f| f == "-std=c++17").unwrap();
    let o2_idx = flags.iter().position(|f| f == "-O2").unwrap();
    let sdl_idx = flags.iter().position(|f| f == "-lSDL2").unwrap();
    let ldl_idx = flags.iter().position(|f| f == "-ldl").unwrap();
    let rdynamic_idx = flags.iter().position(|f| f == "-rdynamic").unwrap();
    assert!(std_idx < o2_idx, "-std should come before compile flags");
    assert!(
        o2_idx < sdl_idx,
        "compile flags should come before link flags"
    );
    assert!(
        sdl_idx < ldl_idx,
        "manifest link flags should come before -ldl boilerplate"
    );
    assert!(ldl_idx < rdynamic_idx, "-ldl should come before -rdynamic");
}

#[test]
fn host_runner_filename_constant_matches_universal_split_prompt() {
    // The universal split prompt instructs the AI to emit the runner
    // file as `host_runner.cpp`. detect_adapted_project + handler.rs
    // both look for that exact name. Lock the constant so a rename
    // can't silently desynchronise the prompt and the worker.
    assert_eq!(HOST_RUNNER_FILENAME, "host_runner.cpp");
}

// ============================================================
// adapted_project.rs — serde round-trip stability
// ============================================================

#[test]
fn adapted_project_status_serde_round_trip_with_new_fields() {
    // The struct gains two fields in Phase 4: host_runner_path and
    // user_owned_runner. Both have #[serde(default)] so old JSON
    // (pre-Phase-4 sidecars or in-memory snapshots) deserializes cleanly.
    // Verify both directions.
    let original = AdaptedProjectStatus::adapted_full(
        PathBuf::from("/tmp/core.cpp"),
        PathBuf::from("/tmp/gui.cpp"),
        Some(PathBuf::from("/tmp/shared.h")),
        PathBuf::from("/tmp/host_runner.cpp"),
        true,
    );
    let json = serde_json::to_string(&original).expect("serialize");
    let decoded: AdaptedProjectStatus =
        serde_json::from_str(&json).expect("deserialize round-trip");
    assert_eq!(decoded.is_adapted, original.is_adapted);
    assert_eq!(decoded.core_path, original.core_path);
    assert_eq!(decoded.gui_path, original.gui_path);
    assert_eq!(decoded.shared_path, original.shared_path);
    assert_eq!(decoded.host_runner_path, original.host_runner_path);
    assert_eq!(decoded.user_owned_runner, original.user_owned_runner);
}

#[test]
fn adapted_project_status_deserializes_pre_phase4_json() {
    // Old JSON without host_runner_path / user_owned_runner must still
    // deserialize cleanly into the new struct. This is the contract
    // that lets us upgrade without a sidecar migration.
    let pre_phase4_json = r#"{
        "is_adapted": true,
        "core_path": "/tmp/core.cpp",
        "gui_path": "/tmp/gui.cpp",
        "shared_path": "/tmp/shared.h",
        "split_hash": "abc123",
        "reason": null
    }"#;
    let decoded: AdaptedProjectStatus =
        serde_json::from_str(pre_phase4_json).expect("pre-Phase-4 JSON must deserialize");
    assert!(decoded.is_adapted);
    assert!(decoded.host_runner_path.is_none());
    assert!(!decoded.user_owned_runner);
    assert_eq!(decoded.split_hash, Some("abc123".to_string()));
}

// ============================================================
// adapted_project.rs — coupling of detection + BYOR decision
// ============================================================

#[test]
fn detection_wires_byor_into_status_in_one_pass() {
    // Locks the contract that detect_adapted_project does the BYOR
    // sentinel scan inline. handler.rs depends on this — it never
    // calls host_runner_is_user_owned itself, only reads the bool
    // off enrichment.adapted_status.user_owned_runner. If detection
    // and BYOR ever drift apart, handler.rs will silently never see
    // BYOR mode and start overwriting user-authored runners.
    let dir = fresh_tempdir("detect_byor_coupling");
    write_split_files(&dir);
    fs::write(
        dir.join(HOST_RUNNER_FILENAME),
        "// SYNTHI_USER_RUNNER\n#include <SDL2/SDL.h>\nint main(){return 0;}\n",
    )
    .unwrap();
    let status = detect_adapted_project(&dir);
    // All four flags must be set in a single detect_adapted_project call:
    assert!(status.is_adapted);
    assert!(status.host_runner_path.is_some());
    assert!(status.user_owned_runner);
    // And the path must point at the actual file we wrote
    let path = status.host_runner_path.unwrap();
    let read_back = fs::read_to_string(&path).unwrap();
    assert!(read_back.starts_with("// SYNTHI_USER_RUNNER"));
    cleanup(&dir);
}

#[test]
fn detection_does_not_set_byor_for_three_file_legacy_project() {
    // Legacy 3-file projects (no host_runner.cpp at all) must NEVER
    // accidentally land with user_owned_runner=true. That's the safer
    // default — a missing runner means "AI may freely generate one".
    let dir = fresh_tempdir("legacy_no_byor");
    write_split_files(&dir);
    let status = detect_adapted_project(&dir);
    assert!(status.is_adapted);
    assert!(status.host_runner_path.is_none());
    assert!(
        !status.user_owned_runner,
        "missing host_runner.cpp must NOT be treated as user-owned"
    );
    cleanup(&dir);
}
