// ============================================================
// Phase 3 (ULTRAPLAN) — CompileManifest integration smoke tests
// ============================================================
//
// These live in `tests/` instead of inside `src/hmr/compile_manifest.rs`
// because the worker lib's test binary has pre-existing compile errors
// in unrelated `wave*_integration_tests` modules that block `cargo test
// --lib` from building at all. Integration tests in `tests/` each
// compile into their own binary and only depend on the (cleanly
// compiling) lib, so they sidestep the broken internal test tree.
//
// What this covers:
//   - round-trip: serialize a BuildManifest shape from Python side,
//     deserialize on the Rust side, compare fields.
//   - sdl2_default(): confirm the backward-compat fallback produces
//     the exact flags compile_core/compile_gui used to hardcode.
//   - hot_reload_mode semantics: process_restart toggles
//     requires_process_restart().
//   - low confidence: runner_synthesis == "low" deserializes, so the
//     handler guardrail can inspect it.
//   - extra-fields tolerance: a V2 manifest with unknown fields still
//     parses (serde default(extra=ignore) behavior).
//   - missing confidence: from_json_value returns None (so handler.rs
//     falls back to sdl2_default instead of panicking).
//   - build_steps forward-compat: accepts-but-ignores.
//
// Run with:
//   cargo test --test phase3_compile_manifest
// from `backend/synthi-webrtc-compiler/worker/`.

use worker::hmr::compile_manifest::{CompileManifest, ConfidenceLevel, HotReloadMode};

const SAMPLE_SDL2_JSON: &str = r#"{
    "compiler": "g++",
    "std": "c++17",
    "common_flags": ["-shared", "-fPIC"],
    "core_link_flags": [],
    "gui_link_flags": ["-lSDL2"],
    "shared_link_flags": [],
    "runner_link_flags": ["-lSDL2", "-ldl"],
    "system_packages": ["libsdl2-dev"],
    "hot_reload_mode": "swap",
    "confidence": {
        "overall": "high",
        "runner_synthesis": "high",
        "link_flags": "high",
        "notes": "Standard SDL2"
    }
}"#;

#[test]
fn parses_sdl2_sample_from_python_wire_format() {
    let m: CompileManifest =
        serde_json::from_str(SAMPLE_SDL2_JSON).expect("SDL2 sample JSON should parse cleanly");
    assert_eq!(m.compiler.executable(), "g++");
    assert_eq!(m.std, "c++17");
    assert_eq!(m.gui_link_flags, vec!["-lSDL2".to_string()]);
    assert_eq!(
        m.runner_link_flags,
        vec!["-lSDL2".to_string(), "-ldl".to_string()]
    );
    assert_eq!(m.hot_reload_mode, HotReloadMode::Swap);
    assert_eq!(m.confidence.overall, ConfidenceLevel::High);
    assert_eq!(m.confidence.runner_synthesis, ConfidenceLevel::High);
    assert!(!m.requires_process_restart());
}

#[test]
fn sdl2_default_matches_legacy_hardcoded_shape() {
    // The pre-Phase-3 compile_core / compile_gui commands hardcoded:
    //   g++ -shared -fPIC -D_POSIX_C_SOURCE=199309L -g -gdwarf-4
    //       -fno-omit-frame-pointer -fdiagnostics-format=json ... -lSDL2
    // sdl2_default() MUST produce that exact flag set so existing
    // projects compile identically with manifest=None.
    let m = CompileManifest::sdl2_default();
    assert_eq!(m.compiler.executable(), "g++");
    assert_eq!(m.std, "c++17");
    assert!(m.common_flags.contains(&"-shared".to_string()));
    assert!(m.common_flags.contains(&"-fPIC".to_string()));
    assert!(m
        .common_flags
        .contains(&"-D_POSIX_C_SOURCE=199309L".to_string()));
    assert!(m.common_flags.contains(&"-g".to_string()));
    assert!(m.common_flags.contains(&"-gdwarf-4".to_string()));
    assert!(m
        .common_flags
        .contains(&"-fno-omit-frame-pointer".to_string()));
    assert!(m
        .common_flags
        .contains(&"-fdiagnostics-format=json".to_string()));
    assert!(m.gui_link_flags.contains(&"-lSDL2".to_string()));
    assert!(m.core_link_flags.is_empty());
    assert_eq!(m.hot_reload_mode, HotReloadMode::Swap);
    assert_eq!(m.confidence.overall, ConfidenceLevel::High);
    assert!(!m.requires_process_restart());
}

#[test]
fn fmod_process_restart_manifest() {
    let json = r#"{
        "compiler": "g++",
        "std": "c++17",
        "common_flags": ["-shared", "-fPIC"],
        "core_link_flags": [],
        "gui_link_flags": ["-lSDL2", "-lfmod"],
        "shared_link_flags": [],
        "runner_link_flags": ["-lSDL2", "-lfmod", "-ldl"],
        "system_packages": [],
        "hot_reload_mode": "process_restart",
        "confidence": {
            "overall": "high",
            "runner_synthesis": "high",
            "link_flags": "high",
            "notes": "FMOD is hot-reload hostile; using process_restart"
        }
    }"#;
    let m: CompileManifest = serde_json::from_str(json).unwrap();
    assert_eq!(m.hot_reload_mode, HotReloadMode::ProcessRestart);
    assert!(m.requires_process_restart());
    assert!(m.gui_link_flags.contains(&"-lfmod".to_string()));
    assert!(m.gui_link_flags.contains(&"-lSDL2".to_string()));
}

#[test]
fn low_confidence_macro_main_manifest() {
    // The wxWidgets IMPLEMENT_APP(MyApp) case — runner_synthesis == "low"
    // is what the handler guardrail watches for to refuse compile and
    // surface the Bring Your Own Runner error card.
    let json = r#"{
        "compiler": "g++",
        "std": "c++17",
        "common_flags": [],
        "core_link_flags": [],
        "gui_link_flags": ["-lwx_gtk3u_core-3.0"],
        "shared_link_flags": [],
        "runner_link_flags": ["-lwx_gtk3u_core-3.0", "-ldl"],
        "system_packages": [],
        "hot_reload_mode": "swap",
        "confidence": {
            "overall": "low",
            "runner_synthesis": "low",
            "link_flags": "medium",
            "notes": "IMPLEMENT_APP(MyApp) macro hides main(), cannot safely untangle"
        }
    }"#;
    let m: CompileManifest = serde_json::from_str(json).unwrap();
    assert_eq!(m.confidence.runner_synthesis, ConfidenceLevel::Low);
    assert_eq!(m.confidence.link_flags, ConfidenceLevel::Medium);
    assert!(m.confidence.notes.contains("IMPLEMENT_APP"));
}

#[test]
fn from_json_value_tolerates_extra_fields() {
    // V2 may add fields we don't know about. Deserialization should
    // ignore them, not fail — otherwise a Python-side schema bump
    // breaks every in-flight project.
    let v: serde_json::Value = serde_json::from_str(
        r#"{
            "compiler": "clang++",
            "std": "c++20",
            "common_flags": ["-shared"],
            "core_link_flags": [],
            "gui_link_flags": ["-lglfw"],
            "shared_link_flags": [],
            "runner_link_flags": ["-lglfw"],
            "system_packages": [],
            "hot_reload_mode": "swap",
            "confidence": {
                "overall": "high",
                "runner_synthesis": "high",
                "link_flags": "high",
                "notes": ""
            },
            "some_future_field_v2": {"anything": "here"}
        }"#,
    )
    .unwrap();
    let m = CompileManifest::from_json_value(&v).expect("clang++ glfw manifest should parse");
    assert_eq!(m.compiler.executable(), "clang++");
    assert_eq!(m.std, "c++20");
    assert_eq!(m.gui_link_flags, vec!["-lglfw".to_string()]);
}

#[test]
fn from_json_value_returns_none_on_missing_confidence() {
    // `confidence` is the ONLY non-default field. Without it, handler.rs
    // must see None and fall back to sdl2_default(), not panic.
    let v: serde_json::Value = serde_json::json!({
        "compiler": "g++",
        "common_flags": [],
        "gui_link_flags": []
    });
    assert!(CompileManifest::from_json_value(&v).is_none());
}

#[test]
fn from_json_value_returns_none_on_garbage() {
    // Arbitrary JSON that isn't even shaped like a manifest.
    let v: serde_json::Value = serde_json::json!({
        "something": "completely unrelated"
    });
    assert!(CompileManifest::from_json_value(&v).is_none());
}

#[test]
fn auto_hot_reload_mode_parses() {
    let json = r#"{
        "compiler": "g++",
        "std": "c++17",
        "common_flags": [],
        "core_link_flags": [],
        "gui_link_flags": ["-lSDL2"],
        "shared_link_flags": [],
        "runner_link_flags": ["-lSDL2", "-ldl"],
        "system_packages": [],
        "hot_reload_mode": "auto",
        "confidence": {
            "overall": "high",
            "runner_synthesis": "high",
            "link_flags": "high",
            "notes": ""
        }
    }"#;
    let m: CompileManifest = serde_json::from_str(json).unwrap();
    assert_eq!(m.hot_reload_mode, HotReloadMode::Auto);
    // Auto starts as Swap semantically (downgraded to ProcessRestart on crash)
    // so requires_process_restart() == false at parse time.
    assert!(!m.requires_process_restart());
}

#[test]
fn build_steps_forward_compat_parses() {
    // V1 rejects execution of multi-step manifests Python-side before
    // they reach here. But the SCHEMA should accept them so a Python
    // bug that lets one through doesn't crash the Rust deserializer.
    let json = r#"{
        "compiler": "g++",
        "std": "c++17",
        "common_flags": [],
        "core_link_flags": [],
        "gui_link_flags": [],
        "shared_link_flags": [],
        "runner_link_flags": [],
        "system_packages": [],
        "hot_reload_mode": "swap",
        "confidence": {
            "overall": "high",
            "runner_synthesis": "high",
            "link_flags": "high",
            "notes": ""
        },
        "build_steps": [
            {"name": "moc", "command": "moc", "args": ["main.h"]}
        ]
    }"#;
    let m: CompileManifest = serde_json::from_str(json).unwrap();
    assert!(m.build_steps.is_some());
    assert_eq!(m.build_steps.unwrap().len(), 1);
}

#[test]
fn round_trip_serialize_deserialize() {
    // Round-trip: serialize the default, deserialize, compare. Catches
    // any asymmetry between serde renames on the read vs write side.
    let original = CompileManifest::sdl2_default();
    let serialized = serde_json::to_string(&original).unwrap();
    let decoded: CompileManifest = serde_json::from_str(&serialized).unwrap();
    assert_eq!(
        decoded.compiler.executable(),
        original.compiler.executable()
    );
    assert_eq!(decoded.std, original.std);
    assert_eq!(decoded.common_flags, original.common_flags);
    assert_eq!(decoded.gui_link_flags, original.gui_link_flags);
    assert_eq!(decoded.runner_link_flags, original.runner_link_flags);
    assert_eq!(decoded.hot_reload_mode, original.hot_reload_mode);
    assert_eq!(decoded.confidence.overall, original.confidence.overall);
}
