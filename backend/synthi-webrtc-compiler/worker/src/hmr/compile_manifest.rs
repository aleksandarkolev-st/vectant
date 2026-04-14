// ============================================================
// COMPILE MANIFEST (ULTRAPLAN Phase 3)
// ============================================================
//
// The compile manifest is the machine-readable config the AI emits
// inside the split response (via <synthi_build_manifest> XML tags) to
// tell the worker HOW to compile the split modules for the user's
// chosen library. Without it, the worker hardcodes `g++ -lSDL2` and
// only SDL2 projects work.
//
// With it, the worker reads per-project:
//   - compiler (g++ or clang++)
//   - std (c++17, c++20, ...)
//   - common_flags (shared across all compile steps)
//   - core_link_flags (applied to libcore.so)
//   - gui_link_flags (applied to libgui.so — where most library links live,
//                     e.g. -lSDL2 or -lglfw or -lraylib)
//   - runner_link_flags (applied to the host runner executable)
//   - hot_reload_mode (swap / process_restart / auto — Point 4 mitigation)
//   - confidence (runner_synthesis / link_flags / overall — Point 2 mitigation)
//
// NAMING: do NOT confuse with the existing `hmr::build_manifest::BuildManifest`
// which tracks BUILD ARTIFACTS (slot state, what .so files were produced).
// This one tracks COMPILE CONFIG (how to produce them). The names are
// distinct on purpose: `BuildManifest` = artifact registry,
// `CompileManifest` = compile recipe.
//
// On the wire: this struct serializes to the exact same JSON shape as
// Python's `build_manifest.py::BuildManifest`. The Python side is the
// source of truth for the schema; this is the deserializer. Field names
// and types must stay in sync.
//
// Sidecar integration: the worker persists this into
// `.synthi_split_meta.json` alongside `architecture` and `original_source`.
// On Tier 2 / Tier 3 compile paths, handler.rs reads it back and threads
// `Option<&CompileManifest>` into compile_core / compile_gui. If None
// (pre-universal-prompt sidecars, manifest omitted, JSON parse failure),
// the compile stages fall back to hardcoded SDL2 defaults — no regression
// on existing projects.
//
// See HMR_AGNOSTIC_ULTRAPLAN.md §4 for the full schema and §5.4 for the
// hot_reload_mode semantics.

use serde::{Deserialize, Serialize};

/// Per-call confidence the AI reports about its own manifest synthesis.
/// `runner_synthesis == "low"` is the Point 2 guardrail trigger — handler
/// refuses to compile and surfaces the Bring Your Own Runner error card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfidenceBlock {
    pub overall: ConfidenceLevel,
    pub runner_synthesis: ConfidenceLevel,
    pub link_flags: ConfidenceLevel,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConfidenceLevel {
    High,
    Medium,
    Low,
}

impl ConfidenceLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
        }
    }
}

/// Hot-reload strategy for this project. Point 4 mitigation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HotReloadMode {
    /// `dlclose` the old `.so`, `dlopen` the new one. Fast (~50ms). Standard
    /// path for SDL2/GLFW/raylib/well-behaved libraries.
    Swap,
    /// Kill the runner process, re-spawn with new `.so` files. Slower
    /// (~300-800ms) but correct for libraries with hidden global state
    /// that desyncs on swap (FMOD, Wwise, Qt, wxWidgets, JUCE).
    ProcessRestart,
    /// Start with `Swap`; if the runner crashes within 2s of a reload,
    /// auto-downgrade to `ProcessRestart` for the rest of the session.
    /// Implemented by `hmr::dynlib_crash_isolation`.
    Auto,
}

impl HotReloadMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Swap => "swap",
            Self::ProcessRestart => "process_restart",
            Self::Auto => "auto",
        }
    }
}

impl Default for HotReloadMode {
    fn default() -> Self {
        Self::Swap
    }
}

/// Compiler choice. V1 accepts `g++` or `clang++`. Anything else is
/// rejected Python-side in `validate_manifest_v1()` before we see it,
/// so this enum doesn't carry a fallback variant.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Compiler {
    #[serde(rename = "g++")]
    GccPlusPlus,
    #[serde(rename = "clang++")]
    ClangPlusPlus,
}

impl Compiler {
    pub fn executable(&self) -> &'static str {
        match self {
            Self::GccPlusPlus => "g++",
            Self::ClangPlusPlus => "clang++",
        }
    }
}

impl Default for Compiler {
    fn default() -> Self {
        Self::GccPlusPlus
    }
}

/// How to compile the split modules for this specific project.
///
/// Deserialized from the Python `BuildManifest` JSON that comes in via
/// the split response's `manifest` field. Persisted to the split sidecar
/// under `compile_manifest`. Threaded through to `compile_core` and
/// `compile_gui` as `Option<&CompileManifest>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileManifest {
    #[serde(default)]
    pub compiler: Compiler,

    #[serde(default = "default_std")]
    pub std: String,

    #[serde(default)]
    pub common_flags: Vec<String>,

    #[serde(default)]
    pub core_link_flags: Vec<String>,

    #[serde(default)]
    pub gui_link_flags: Vec<String>,

    #[serde(default)]
    pub shared_link_flags: Vec<String>,

    #[serde(default)]
    pub runner_link_flags: Vec<String>,

    #[serde(default)]
    pub system_packages: Vec<String>,

    #[serde(default)]
    pub hot_reload_mode: HotReloadMode,

    pub confidence: ConfidenceBlock,

    /// Forward-compat for V2 multi-step builds. V1 rejects non-None on
    /// the Python side (`validate_manifest_v1`) before it reaches here,
    /// so we should never see this populated in practice. Kept in the
    /// struct so the deserializer doesn't error on forward-compat
    /// manifests that pass through unvalidated for some reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_steps: Option<Vec<serde_json::Value>>,
}

fn default_std() -> String {
    "c++17".to_string()
}

impl CompileManifest {
    /// Construct a hardcoded SDL2 default for backward compatibility with
    /// projects that predate the universal split prompt (sidecars without
    /// a `compile_manifest` field). Matches the old hardcoded compile_core
    /// / compile_gui behavior exactly.
    pub fn sdl2_default() -> Self {
        Self {
            compiler: Compiler::GccPlusPlus,
            std: "c++17".to_string(),
            common_flags: vec![
                "-shared".to_string(),
                "-fPIC".to_string(),
                "-D_POSIX_C_SOURCE=199309L".to_string(),
                "-g".to_string(),
                "-gdwarf-4".to_string(),
                "-fno-omit-frame-pointer".to_string(),
                "-fdiagnostics-format=json".to_string(),
            ],
            core_link_flags: Vec::new(),
            gui_link_flags: vec!["-lSDL2".to_string()],
            shared_link_flags: Vec::new(),
            runner_link_flags: vec!["-lSDL2".to_string(), "-ldl".to_string()],
            system_packages: vec!["libsdl2-dev".to_string()],
            hot_reload_mode: HotReloadMode::Swap,
            confidence: ConfidenceBlock {
                overall: ConfidenceLevel::High,
                runner_synthesis: ConfidenceLevel::High,
                link_flags: ConfidenceLevel::High,
                notes: "Hardcoded SDL2 default (no manifest in sidecar).".to_string(),
            },
            build_steps: None,
        }
    }

    /// Parse a manifest from the sidecar's `compile_manifest` JSON field.
    /// Returns `None` on parse failure — caller falls back to `sdl2_default()`.
    pub fn from_json_value(value: &serde_json::Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }

    /// Whether this manifest requires process-restart on hot-reload (either
    /// explicitly via `ProcessRestart` or via `Auto` + crash recovery).
    /// Handler.rs uses this to decide dlclose-swap vs process kill+respawn.
    pub fn requires_process_restart(&self) -> bool {
        matches!(self.hot_reload_mode, HotReloadMode::ProcessRestart)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parses_sdl2_sample() {
        let m: CompileManifest = serde_json::from_str(SAMPLE_SDL2_JSON).unwrap();
        assert_eq!(m.compiler.executable(), "g++");
        assert_eq!(m.std, "c++17");
        assert_eq!(m.gui_link_flags, vec!["-lSDL2".to_string()]);
        assert_eq!(m.runner_link_flags, vec!["-lSDL2".to_string(), "-ldl".to_string()]);
        assert_eq!(m.hot_reload_mode, HotReloadMode::Swap);
        assert_eq!(m.confidence.overall, ConfidenceLevel::High);
        assert_eq!(m.confidence.runner_synthesis, ConfidenceLevel::High);
        assert!(!m.requires_process_restart());
    }

    #[test]
    fn parses_fmod_process_restart() {
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
    fn parses_low_confidence_macro_main() {
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
        assert!(m.confidence.notes.contains("IMPLEMENT_APP"));
    }

    #[test]
    fn sdl2_default_is_buildable() {
        let m = CompileManifest::sdl2_default();
        assert_eq!(m.compiler.executable(), "g++");
        assert!(m.gui_link_flags.contains(&"-lSDL2".to_string()));
        assert_eq!(m.hot_reload_mode, HotReloadMode::Swap);
        assert_eq!(m.confidence.overall, ConfidenceLevel::High);
    }

    #[test]
    fn from_json_value_survives_extra_fields() {
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
        let m = CompileManifest::from_json_value(&v).unwrap();
        assert_eq!(m.compiler.executable(), "clang++");
        assert_eq!(m.std, "c++20");
        assert_eq!(m.gui_link_flags, vec!["-lglfw".to_string()]);
    }

    #[test]
    fn from_json_value_none_on_missing_confidence() {
        let v: serde_json::Value = serde_json::json!({
            "compiler": "g++",
            "common_flags": [],
            "gui_link_flags": []
            // missing confidence field
        });
        assert!(CompileManifest::from_json_value(&v).is_none());
    }

    #[test]
    fn forward_compat_build_steps_parses() {
        // V1 should parse but not execute a manifest with build_steps.
        // Validation happens in Python (validate_manifest_v1); by the
        // time we get here, build_steps should be None. But if a
        // manifest sneaks through with build_steps, we still deserialize
        // it — the rejection is downstream.
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
}
