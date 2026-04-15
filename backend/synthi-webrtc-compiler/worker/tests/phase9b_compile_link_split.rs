// ============================================================
// Phase 9b (ULTRAPLAN Lightning) — compile+link split integration tests
// ============================================================
//
// Exercises the four Phase 9b helpers in `compile_helpers`:
//   - compile_to_object_command       (compile step, ccache-wrapped)
//   - link_object_to_so_command       (shared library link)
//   - link_object_to_exec_command     (executable link)
//   - object_path_for_so / object_path_for_exec (path derivation)
//
// The focus is on COMMAND SHAPE (does the resulting Command have the
// right args in the right order, cwd, etc.) rather than spawning real
// g++ and verifying byte-exact .o/.so outputs — those are better covered
// via the end-to-end Phase 9f benchmark harness and the existing
// phase3_compile_manifest suite's compile-chain smoke.
//
// Rationale for command-shape focus: the split is a mechanical
// transformation of the old fused invocation. If the shape is right
// and compiler_exe is valid, the real compile will work — we don't
// need to spawn g++ to verify the Command object was built correctly.

use std::path::PathBuf;
use worker::compiler::stages::compile_helpers::{
    compile_to_object_command, link_object_to_exec_command, link_object_to_so_command,
    object_path_for_exec, object_path_for_so,
};

// ────────────────────────────────────────────────────────────
// Path derivation
// ────────────────────────────────────────────────────────────

#[test]
fn object_path_for_so_strips_lib_prefix() {
    let so = PathBuf::from("/workspace/build/libcore_1234.so");
    let obj = object_path_for_so(&so);
    assert_eq!(obj, PathBuf::from("/workspace/build/core_1234.o"));
}

#[test]
fn object_path_for_so_without_lib_prefix() {
    let so = PathBuf::from("/workspace/build/custom_target.so");
    let obj = object_path_for_so(&so);
    assert_eq!(obj, PathBuf::from("/workspace/build/custom_target.o"));
}

#[test]
fn object_path_for_so_preserves_timestamp_in_stem() {
    let so = PathBuf::from("/tmp/build/libgui_1700000000.so");
    let obj = object_path_for_so(&so);
    assert_eq!(obj, PathBuf::from("/tmp/build/gui_1700000000.o"));
}

#[test]
fn object_path_for_so_handles_relative_path() {
    let so = PathBuf::from("build/libcore_1.so");
    let obj = object_path_for_so(&so);
    assert_eq!(obj, PathBuf::from("build/core_1.o"));
}

#[test]
fn object_path_for_exec_uses_exec_name() {
    let exec = PathBuf::from("/workspace/build/host_runner_1234");
    let obj = object_path_for_exec(&exec);
    assert_eq!(obj, PathBuf::from("/workspace/build/host_runner_1234.o"));
}

#[test]
fn object_path_for_exec_with_versioned_name() {
    let exec = PathBuf::from("/build/host_runner_1700000000");
    let obj = object_path_for_exec(&exec);
    assert_eq!(obj, PathBuf::from("/build/host_runner_1700000000.o"));
}

// ────────────────────────────────────────────────────────────
// compile_to_object_command shape
// ────────────────────────────────────────────────────────────

fn args_of(cmd: &tokio::process::Command) -> Vec<String> {
    cmd.as_std()
        .get_args()
        .map(|os| os.to_string_lossy().to_string())
        .collect()
}

#[test]
fn compile_to_object_has_dash_c_flag() {
    let cmd = compile_to_object_command(
        "g++",
        "core.cpp",
        &PathBuf::from("/tmp/core.o"),
        "-std=c++17",
        &vec!["-g".to_string(), "-fPIC".to_string()],
        std::path::Path::new("/tmp"),
    );
    let args = args_of(&cmd);
    // -c must be present — without it ccache won't cache
    assert!(args.contains(&"-c".to_string()), "missing -c in: {:?}", args);
}

#[test]
fn compile_to_object_strips_shared_flag() {
    let cmd = compile_to_object_command(
        "g++",
        "core.cpp",
        &PathBuf::from("/tmp/core.o"),
        "-std=c++17",
        &vec![
            "-shared".to_string(),  // MUST be stripped — incompatible with -c
            "-fPIC".to_string(),
            "-g".to_string(),
        ],
        std::path::Path::new("/tmp"),
    );
    let args = args_of(&cmd);
    assert!(!args.contains(&"-shared".to_string()),
        "-shared must be stripped from compile step args: {:?}", args);
    // -fPIC and -g should survive the filter
    assert!(args.contains(&"-fPIC".to_string()));
    assert!(args.contains(&"-g".to_string()));
}

#[test]
fn compile_to_object_includes_std_flag() {
    let cmd = compile_to_object_command(
        "g++",
        "core.cpp",
        &PathBuf::from("/tmp/core.o"),
        "-std=c++20",
        &vec![],
        std::path::Path::new("/tmp"),
    );
    let args = args_of(&cmd);
    assert!(args.contains(&"-std=c++20".to_string()));
}

#[test]
fn compile_to_object_includes_source_and_output_paths() {
    let cmd = compile_to_object_command(
        "g++",
        "core.cpp",
        &PathBuf::from("/tmp/build/core_123.o"),
        "-std=c++17",
        &vec!["-fPIC".to_string()],
        std::path::Path::new("/workspace"),
    );
    let args = args_of(&cmd);
    assert!(args.contains(&"core.cpp".to_string()));
    assert!(args.contains(&"-I.".to_string()));
    assert!(args.contains(&"-o".to_string()));
    assert!(args.iter().any(|a| a.contains("core_123.o")));
}

// ────────────────────────────────────────────────────────────
// link_object_to_so_command shape
// ────────────────────────────────────────────────────────────

#[test]
fn link_to_so_has_shared_flag() {
    let cmd = link_object_to_so_command(
        "g++",
        &PathBuf::from("/tmp/core.o"),
        &PathBuf::from("/tmp/libcore.so"),
        &vec!["-lSDL2".to_string()],
        std::path::Path::new("/tmp"),
    );
    let args = args_of(&cmd);
    assert!(args.contains(&"-shared".to_string()),
        "link step must include -shared: {:?}", args);
}

#[test]
fn link_to_so_includes_link_flags() {
    let cmd = link_object_to_so_command(
        "g++",
        &PathBuf::from("/tmp/gui.o"),
        &PathBuf::from("/tmp/libgui.so"),
        &vec!["-lSDL2".to_string(), "-lfmod".to_string(), "-ldl".to_string()],
        std::path::Path::new("/tmp"),
    );
    let args = args_of(&cmd);
    assert!(args.contains(&"-lSDL2".to_string()));
    assert!(args.contains(&"-lfmod".to_string()));
    assert!(args.contains(&"-ldl".to_string()));
}

#[test]
fn link_to_so_includes_object_and_output_paths() {
    let obj = PathBuf::from("/tmp/build/core_1.o");
    let so = PathBuf::from("/tmp/build/libcore_1.so");
    let cmd = link_object_to_so_command(
        "g++",
        &obj,
        &so,
        &vec![],
        std::path::Path::new("/tmp/build"),
    );
    let args = args_of(&cmd);
    assert!(args.iter().any(|a| a.contains("core_1.o")));
    assert!(args.iter().any(|a| a.contains("libcore_1.so")));
    assert!(args.contains(&"-o".to_string()));
}

// ────────────────────────────────────────────────────────────
// link_object_to_exec_command shape
// ────────────────────────────────────────────────────────────

#[test]
fn link_to_exec_omits_shared_flag() {
    let cmd = link_object_to_exec_command(
        "g++",
        &PathBuf::from("/tmp/host_runner.o"),
        &PathBuf::from("/tmp/host_runner"),
        &vec!["-lSDL2".to_string()],
        std::path::Path::new("/tmp"),
    );
    let args = args_of(&cmd);
    assert!(!args.contains(&"-shared".to_string()),
        "executable link must NOT include -shared: {:?}", args);
}

#[test]
fn link_to_exec_includes_runner_link_flags() {
    let cmd = link_object_to_exec_command(
        "g++",
        &PathBuf::from("/tmp/host_runner.o"),
        &PathBuf::from("/tmp/host_runner"),
        &vec![
            "-lSDL2".to_string(),
            "-lfmod".to_string(),
            "-ldl".to_string(),
            "-rdynamic".to_string(),
        ],
        std::path::Path::new("/tmp"),
    );
    let args = args_of(&cmd);
    assert!(args.contains(&"-lSDL2".to_string()));
    assert!(args.contains(&"-lfmod".to_string()));
    assert!(args.contains(&"-ldl".to_string()));
    assert!(args.contains(&"-rdynamic".to_string()));
}

#[test]
fn link_to_exec_includes_object_and_output_paths() {
    let obj = PathBuf::from("/tmp/build/host_runner_1.o");
    let exe = PathBuf::from("/tmp/build/host_runner_1");
    let cmd = link_object_to_exec_command(
        "g++",
        &obj,
        &exe,
        &vec![],
        std::path::Path::new("/tmp/build"),
    );
    let args = args_of(&cmd);
    assert!(args.iter().any(|a| a.contains("host_runner_1.o")));
    assert!(args.iter().any(|a| a.ends_with("host_runner_1") && !a.contains(".o")));
    assert!(args.contains(&"-o".to_string()));
}

// ────────────────────────────────────────────────────────────
// Integration: split steps produce a buildable pair
// ────────────────────────────────────────────────────────────

#[test]
fn compile_then_link_shape_is_consistent() {
    // Given a source file and intended .so target, the derived .o
    // path and the two commands should reference the same object file.
    let so = PathBuf::from("/tmp/build/libcore_42.so");
    let obj = object_path_for_so(&so);
    let source = "core.cpp";
    let workspace = std::path::Path::new("/tmp/build");

    let compile = compile_to_object_command(
        "g++",
        source,
        &obj,
        "-std=c++17",
        &vec!["-fPIC".to_string(), "-g".to_string()],
        workspace,
    );
    let link = link_object_to_so_command(
        "g++",
        &obj,
        &so,
        &vec!["-lSDL2".to_string()],
        workspace,
    );

    // Compile output should match link input
    let compile_args = args_of(&compile);
    let link_args = args_of(&link);

    assert!(compile_args.iter().any(|a| a.contains("core_42.o")));
    assert!(link_args.iter().any(|a| a.contains("core_42.o")));
    assert!(link_args.iter().any(|a| a.contains("libcore_42.so")));
}
