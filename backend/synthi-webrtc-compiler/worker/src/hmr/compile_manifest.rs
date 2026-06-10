// ============================================================
// COMPILE MANIFEST (ULTRAPLAN Phase 3)
// ============================================================
//
// The compile manifest is the machine-readable config the AI emits
// inside the split response (via <synthi_build_manifest> XML tags) to
// tell the worker HOW to compile the split modules for the user's
// chosen library. Without it, the worker uses a generic host fallback and
// does not infer framework link flags.
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
// the compile stages use `CompileManifest::generic_fallback()`.
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

// ============================================================
// GPU EXTENSION (GPU_HMR_ULTRAPLAN §5.1)
// ============================================================
//
// Mirror of the Python `GpuBuildBlock` from ai-backend/ai-engine/
// build_manifest.py. Sits as an optional sub-block on `CompileManifest`
// so host-only projects deserialize unchanged. When `gpu` is `Some`,
// the worker schedules `compile_device` alongside the host compile
// stages and the GPU module adapter participates in hot-reload.
//
// The schema is the source of truth; this enum/struct must round-trip
// to/from the JSON the Python side emits inside <synthi_build_manifest>.
// Field names + serde renames are kept tight to match Python.

/// GPU vendor — drives which adapter is instantiated by
/// `adapter_registry.rs` and which runtime libraries (`cuda`, `cudart` vs
/// `amdhip64`) the host runner links against.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceVendor {
    Cuda,
    Rocm,
}

impl DeviceVendor {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Cuda => "cuda",
            Self::Rocm => "rocm",
        }
    }
}

/// Device compiler executable. `nvcc` is the standard CUDA path;
/// `clang-cuda` is the LLVM toolchain-driver alternative (same CUDA
/// source but routed through clang's CUDA frontend). `hipcc` is the
/// ROCm-side wrapper around clang for HIP source. The §5.3
/// `select_compiler` helper resolves this enum to the executable name
/// used in the spawn.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum DeviceCompiler {
    #[serde(rename = "nvcc")]
    Nvcc,
    #[serde(rename = "clang-cuda")]
    ClangCuda,
    #[serde(rename = "hipcc")]
    Hipcc,
}

impl DeviceCompiler {
    pub fn executable(&self) -> &'static str {
        match self {
            Self::Nvcc => "nvcc",
            Self::ClangCuda => "clang++", // clang-cuda is `clang++ --cuda`
            Self::Hipcc => "hipcc",
        }
    }
}

/// Device-state snapshot strategy. `Auto` lets the worker pick at
/// runtime based on `device_checkpoint_probe.rs` (Tier A if available,
/// fall through to Tier B). Explicit modes force the path for testing.
/// See §6.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotMode {
    DriverCheckpoint,
    Userspace,
    Auto,
}

impl SnapshotMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::DriverCheckpoint => "driver_checkpoint",
            Self::Userspace => "userspace",
            Self::Auto => "auto",
        }
    }
}

impl Default for SnapshotMode {
    fn default() -> Self {
        Self::Auto
    }
}

/// How the cubin/hsaco gets shipped. Only `SidecarModule` is HMR-
/// compatible — an embedded fatbin would require relinking the host
/// `.so` to swap, defeating the point. `validate_manifest_v1`
/// (Python side) rejects anything else before it reaches us; we
/// model only the supported variant here so a bad manifest fails
/// deserialization fast.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FatbinStrategy {
    #[default]
    SidecarModule,
}

/// One generated device role. V1 still compiles the primary device sidecar,
/// but the manifest preserves role topology for multi-device-TU and RDC
/// decisions instead of inferring it from filenames.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GpuDeviceRole {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub source_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compiler: Option<String>,
    #[serde(default)]
    pub arch: Vec<String>,
    #[serde(default)]
    pub requires_rdc: bool,
}

/// Device-link topology and cost metadata. When `requires_rdc` is true,
/// the Arbiter must treat warm/device paths as linker-bound unless a later
/// vendor-specific probe proves otherwise.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GpuDeviceLink {
    #[serde(default)]
    pub requires_rdc: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(default)]
    pub affected_roles: Vec<String>,
    #[serde(default)]
    pub supports_incremental: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_ms: Option<u64>,
}

/// GPU-side build recipe. Mirrors Python `GpuBuildBlock`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GpuBuildBlock {
    pub vendor: DeviceVendor,
    pub device_compiler: DeviceCompiler,
    #[serde(default)]
    pub arch: Vec<String>,
    #[serde(default)]
    pub device_flags: Vec<String>,
    #[serde(default)]
    pub runtime_libs: Vec<String>,
    #[serde(default)]
    pub snapshot_mode: SnapshotMode,
    #[serde(default)]
    pub fatbin_strategy: FatbinStrategy,
    #[serde(default)]
    pub device_roles: Vec<GpuDeviceRole>,
    #[serde(default)]
    pub device_link: GpuDeviceLink,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_split_granularity: Option<serde_json::Value>,
}

/// Which compile stage a given module is destined for. Used by
/// `select_compiler` so the four host modules and the optional device
/// module dispatch to the right toolchain without duplicating the
/// logic at every call site (compile_core, compile_gui, compile_runner,
/// compile_device).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleKind {
    Core,
    Gui,
    Shared,
    HostRunner,
    Device,
}

/// Role-to-file mapping for projects whose split modules do not use the
/// legacy `shared.h/core.cpp/gui.cpp/host_runner.cpp/device.*` names.
///
/// `files` remains the full browser resend list; this block provides the
/// semantic role mapping the worker needs for detection and compile dispatch.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModuleFiles {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub core: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gui: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_runner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
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
    pub files: Vec<String>,

    #[serde(default)]
    pub module_files: ModuleFiles,

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

    /// Optional GPU sub-block (GPU_HMR_ULTRAPLAN §5.1). `None` for the
    /// overwhelming majority of projects today; when `Some`, the worker
    /// schedules `compile_device` alongside the host compile stages and
    /// the GPU module adapter participates in hot-reload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu: Option<GpuBuildBlock>,
}

fn default_std() -> String {
    "c++26".to_string()
}

impl CompileManifest {
    /// Construct a technology-agnostic fallback for old sidecars that do not
    /// carry a compile manifest. It preserves the generic host-module compile
    /// flags but intentionally does not infer framework or GPU link flags.
    pub fn generic_fallback() -> Self {
        Self {
            compiler: Compiler::GccPlusPlus,
            std: "c++26".to_string(),
            common_flags: vec![
                "-shared".to_string(),
                "-fPIC".to_string(),
                "-O0".to_string(),
                "-fno-merge-constants".to_string(),
                "-D_POSIX_C_SOURCE=199309L".to_string(),
                "-g".to_string(),
                "-gdwarf-4".to_string(),
                "-fno-omit-frame-pointer".to_string(),
                "-fdiagnostics-format=json".to_string(),
            ],
            core_link_flags: Vec::new(),
            gui_link_flags: Vec::new(),
            shared_link_flags: Vec::new(),
            runner_link_flags: vec!["-ldl".to_string()],
            files: vec![
                "shared.h".to_string(),
                "core.cpp".to_string(),
                "gui.cpp".to_string(),
                "host_runner.cpp".to_string(),
            ],
            module_files: ModuleFiles {
                shared: Some("shared.h".to_string()),
                core: Some("core.cpp".to_string()),
                gui: Some("gui.cpp".to_string()),
                host_runner: Some("host_runner.cpp".to_string()),
                device: None,
            },
            system_packages: Vec::new(),
            hot_reload_mode: HotReloadMode::Swap,
            confidence: ConfidenceBlock {
                overall: ConfidenceLevel::Low,
                runner_synthesis: ConfidenceLevel::Low,
                link_flags: ConfidenceLevel::Low,
                notes: "Generic fallback: no framework or GPU link flags inferred.".to_string(),
            },
            build_steps: None,
            gpu: None,
        }
    }

    /// Legacy SDL2 fixture retained for unit tests that verify old manifest
    /// shape handling. Production fallbacks must use `generic_fallback()`.
    #[cfg(test)]
    pub fn legacy_sdl2_fixture() -> Self {
        Self {
            compiler: Compiler::GccPlusPlus,
            std: "c++26".to_string(),
            common_flags: vec![
                "-shared".to_string(),
                "-fPIC".to_string(),
                "-O0".to_string(),
                "-fno-merge-constants".to_string(),
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
            files: vec![
                "shared.h".to_string(),
                "core.cpp".to_string(),
                "gui.cpp".to_string(),
                "host_runner.cpp".to_string(),
            ],
            module_files: ModuleFiles {
                shared: Some("shared.h".to_string()),
                core: Some("core.cpp".to_string()),
                gui: Some("gui.cpp".to_string()),
                host_runner: Some("host_runner.cpp".to_string()),
                device: None,
            },
            system_packages: vec!["libsdl2-dev".to_string()],
            hot_reload_mode: HotReloadMode::Swap,
            confidence: ConfidenceBlock {
                overall: ConfidenceLevel::High,
                runner_synthesis: ConfidenceLevel::High,
                link_flags: ConfidenceLevel::High,
                notes: "Legacy SDL2 test fixture.".to_string(),
            },
            build_steps: None,
            gpu: None,
        }
    }

    /// Parse a manifest from the sidecar's `compile_manifest` JSON field.
    /// Returns `None` on parse failure. Callers use a generic fallback or
    /// request a verified re-split; missing manifests never infer link flags.
    pub fn from_json_value(value: &serde_json::Value) -> Option<Self> {
        let mut manifest: Self = serde_json::from_value(value.clone()).ok()?;
        manifest.normalize_argv_fields();
        Some(manifest)
    }

    fn normalize_argv_fields(&mut self) {
        normalize_argv_list(&mut self.common_flags);
        normalize_argv_list(&mut self.core_link_flags);
        normalize_argv_list(&mut self.gui_link_flags);
        normalize_argv_list(&mut self.shared_link_flags);
        normalize_argv_list(&mut self.runner_link_flags);
        if let Some(gpu) = self.gpu.as_mut() {
            normalize_argv_list(&mut gpu.device_flags);
        }
    }

    /// Pick the compiler executable for a given module kind. Host
    /// modules (`Core`, `Gui`, `Shared`, `HostRunner`) use the manifest's
    /// host `compiler` field (`g++` / `clang++`). The device module uses
    /// the GPU block's `device_compiler` (`nvcc` / `clang-cuda` / `hipcc`)
    /// when present. Requesting `Device` on a manifest without a `gpu` block is
    /// a caller bug and is rejected before device compilation is dispatched.
    ///
    /// Spec: GPU_HMR_ULTRAPLAN §5.3.
    pub fn select_compiler(&self, kind: ModuleKind) -> &'static str {
        match kind {
            ModuleKind::Device => self
                .gpu
                .as_ref()
                .map(|g| g.device_compiler.executable())
                .expect("device compiler selection requires manifest.gpu"),
            _ => self.compiler.executable(),
        }
    }

    /// Return the manifest-declared source path for a semantic module role.
    pub fn module_file(&self, kind: ModuleKind) -> Option<&str> {
        match kind {
            ModuleKind::Shared => self.module_files.shared.as_deref(),
            ModuleKind::Core => self.module_files.core.as_deref(),
            ModuleKind::Gui => self.module_files.gui.as_deref(),
            ModuleKind::HostRunner => self.module_files.host_runner.as_deref(),
            ModuleKind::Device => self.module_files.device.as_deref(),
        }
        .filter(|s| !s.trim().is_empty())
    }

    /// Device source path, falling back to the canonical extension for the
    /// selected vendor when the manifest predates `module_files.device`.
    pub fn device_source_filename(&self) -> Option<&str> {
        self.module_file(ModuleKind::Device).or_else(|| {
            self.gpu.as_ref().map(|gpu| match gpu.vendor {
                DeviceVendor::Cuda => "device.cu",
                DeviceVendor::Rocm => "device.hip",
            })
        })
    }

    /// Whether this manifest requires process-restart on hot-reload (either
    /// explicitly via `ProcessRestart` or via `Auto` + crash recovery).
    /// Handler.rs uses this to decide dlclose-swap vs process kill+respawn.
    pub fn requires_process_restart(&self) -> bool {
        matches!(self.hot_reload_mode, HotReloadMode::ProcessRestart)
    }

    /// Whether the compile flags are safe for Tier 0 literal patching.
    ///
    /// Tier 0 patches .so bytes directly. This is only safe when:
    ///   - `-O0` prevents constant folding/inlining that moves literals
    ///   - `-fno-merge-constants` prevents GCC from pooling identical
    ///     string literals into a single .rodata entry
    ///
    /// Without these, the compiler may merge "Hello" used in two places
    /// into one copy — Tier 0 would patch both call sites when only one
    /// changed, producing a silently wrong binary.
    pub fn tier0_safe(&self) -> bool {
        let has_o0 = self.common_flags.iter().any(|f| f == "-O0");
        let no_higher_opt = !self
            .common_flags
            .iter()
            .any(|f| (f.starts_with("-O") && f != "-O0" && f != "-Os") || f == "-Os");
        let has_no_merge = self
            .common_flags
            .iter()
            .any(|f| f == "-fno-merge-constants");
        has_o0 && no_higher_opt && has_no_merge
    }

    /// Ensure the manifest has Tier 0 safety flags. Returns a new
    /// manifest with `-O0` and `-fno-merge-constants` injected if
    /// missing. Removes any `-O1`/`-O2`/`-O3`/`-Os` that would
    /// conflict. Used by the handler before compile dispatch.
    pub fn with_tier0_flags(&self) -> Self {
        let mut m = self.clone();
        // Remove any optimization flags that conflict with -O0
        m.common_flags
            .retain(|f| !(f.starts_with("-O") && f != "-O0"));
        if !m.common_flags.iter().any(|f| f == "-O0") {
            m.common_flags.push("-O0".to_string());
        }
        if !m.common_flags.iter().any(|f| f == "-fno-merge-constants") {
            m.common_flags.push("-fno-merge-constants".to_string());
        }
        m
    }
}

fn normalize_argv_list(values: &mut Vec<String>) {
    let mut normalized = Vec::with_capacity(values.len());
    for value in values.drain(..) {
        let tokens = split_manifest_argv_value(&value);
        if tokens.is_empty() {
            continue;
        }
        normalized.extend(tokens);
    }
    *values = normalized;
}

fn split_manifest_argv_value(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if !trimmed
        .chars()
        .any(|ch| ch.is_whitespace() || ch == '"' || ch == '\'')
    {
        return vec![trimmed.to_string()];
    }

    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in trimmed.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = Some(ch),
            ch if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    if tokens.is_empty() {
        vec![trimmed.to_string()]
    } else {
        tokens
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
    fn legacy_sdl2_fixture_is_buildable() {
        let m = CompileManifest::legacy_sdl2_fixture();
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
    fn from_json_value_normalizes_grouped_argv_fields() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{
                "compiler": "clang++",
                "std": "c++20",
                "common_flags": ["-shared -fPIC", "-DAPP_NAME=\"Synthi App\""],
                "core_link_flags": [],
                "gui_link_flags": ["-L\"/opt/vendor sdk/lib\" -lgraphics"],
                "shared_link_flags": [],
                "runner_link_flags": ["-ldl -pthread"],
                "system_packages": [],
                "hot_reload_mode": "swap",
                "confidence": {
                    "overall": "high",
                    "runner_synthesis": "high",
                    "link_flags": "high",
                    "notes": ""
                },
                "gpu": {
                    "vendor": "rocm",
                    "device_compiler": "hipcc",
                    "arch": ["gfx1201"],
                    "device_flags": ["-O3 --offload-arch=gfx1201"],
                    "runtime_libs": ["amdhip64"],
                    "snapshot_mode": "auto",
                    "fatbin_strategy": "sidecar_module"
                }
            }"#,
        )
        .unwrap();
        let m = CompileManifest::from_json_value(&v).unwrap();
        assert_eq!(
            m.common_flags,
            vec![
                "-shared".to_string(),
                "-fPIC".to_string(),
                "-DAPP_NAME=Synthi App".to_string()
            ]
        );
        assert_eq!(
            m.gui_link_flags,
            vec![
                "-L/opt/vendor sdk/lib".to_string(),
                "-lgraphics".to_string()
            ]
        );
        assert_eq!(
            m.runner_link_flags,
            vec!["-ldl".to_string(), "-pthread".to_string()]
        );
        assert_eq!(
            m.gpu.unwrap().device_flags,
            vec!["-O3".to_string(), "--offload-arch=gfx1201".to_string()]
        );
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

    #[test]
    fn legacy_sdl2_fixture_is_tier0_safe() {
        let m = CompileManifest::legacy_sdl2_fixture();
        assert!(
            m.tier0_safe(),
            "legacy SDL2 fixture must include -O0 and -fno-merge-constants"
        );
    }

    #[test]
    fn tier0_safe_rejects_o2() {
        let mut m = CompileManifest::legacy_sdl2_fixture();
        m.common_flags.push("-O2".to_string());
        assert!(!m.tier0_safe());
    }

    #[test]
    fn tier0_safe_rejects_missing_no_merge() {
        let mut m = CompileManifest::legacy_sdl2_fixture();
        m.common_flags.retain(|f| f != "-fno-merge-constants");
        assert!(!m.tier0_safe());
    }

    #[test]
    fn with_tier0_flags_injects_missing() {
        let mut m = CompileManifest::legacy_sdl2_fixture();
        m.common_flags
            .retain(|f| f != "-O0" && f != "-fno-merge-constants");
        assert!(!m.tier0_safe());
        let fixed = m.with_tier0_flags();
        assert!(fixed.tier0_safe());
    }

    #[test]
    fn with_tier0_flags_strips_o2() {
        let mut m = CompileManifest::legacy_sdl2_fixture();
        m.common_flags.push("-O2".to_string());
        let fixed = m.with_tier0_flags();
        assert!(fixed.tier0_safe());
        assert!(!fixed.common_flags.contains(&"-O2".to_string()));
    }

    // ────────────────────────────────────────────────────────────────
    // GPU sub-block (GPU_HMR_ULTRAPLAN §5.1)
    // ────────────────────────────────────────────────────────────────

    const CUDA_MANIFEST_JSON: &str = r#"{
        "compiler": "g++",
        "std": "c++26",
        "common_flags": ["-shared","-fPIC"],
        "core_link_flags": [],
        "gui_link_flags": ["-lSDL2"],
        "shared_link_flags": [],
        "runner_link_flags": ["-lSDL2","-ldl","-lcudart","-lcuda"],
        "files": ["shared.h","core.cpp","gui.cpp","host_runner.cpp","device.cu"],
        "system_packages": [],
        "hot_reload_mode": "swap",
        "confidence": {
            "overall": "high",
            "runner_synthesis": "high",
            "link_flags": "high",
            "notes": "CUDA vector-add"
        },
        "gpu": {
            "vendor": "cuda",
            "device_compiler": "nvcc",
            "arch": ["sm_80","sm_90"],
            "device_flags": ["-O3","-lineinfo","--use_fast_math"],
            "runtime_libs": ["cudart","cuda"],
            "snapshot_mode": "auto",
            "fatbin_strategy": "sidecar_module"
        }
    }"#;

    #[test]
    fn parses_cuda_manifest() {
        let m: CompileManifest = serde_json::from_str(CUDA_MANIFEST_JSON).unwrap();
        let gpu = m.gpu.as_ref().expect("gpu block must parse");
        assert_eq!(gpu.vendor, DeviceVendor::Cuda);
        assert_eq!(gpu.device_compiler, DeviceCompiler::Nvcc);
        assert_eq!(gpu.arch, vec!["sm_80".to_string(), "sm_90".to_string()]);
        assert_eq!(m.files.last().map(|s| s.as_str()), Some("device.cu"));
        assert_eq!(gpu.snapshot_mode, SnapshotMode::Auto);
        assert_eq!(gpu.fatbin_strategy, FatbinStrategy::SidecarModule);
    }

    #[test]
    fn parses_rocm_manifest() {
        let json = r#"{
            "compiler": "g++",
            "std": "c++26",
            "common_flags": [],
            "core_link_flags": [],
            "gui_link_flags": [],
            "shared_link_flags": [],
            "runner_link_flags": [],
            "system_packages": [],
            "hot_reload_mode": "swap",
            "confidence": {"overall":"high","runner_synthesis":"high","link_flags":"high","notes":""},
            "gpu": {
                "vendor": "rocm",
                "device_compiler": "hipcc",
                "arch": ["gfx90a"],
                "device_flags": ["-O3"],
                "runtime_libs": ["amdhip64"],
                "snapshot_mode": "userspace",
                "fatbin_strategy": "sidecar_module"
            }
        }"#;
        let m: CompileManifest = serde_json::from_str(json).unwrap();
        let gpu = m.gpu.unwrap();
        assert_eq!(gpu.vendor, DeviceVendor::Rocm);
        assert_eq!(gpu.device_compiler, DeviceCompiler::Hipcc);
        assert_eq!(gpu.snapshot_mode, SnapshotMode::Userspace);
    }

    #[test]
    fn host_only_manifest_has_no_gpu_block() {
        let m: CompileManifest = serde_json::from_str(SAMPLE_SDL2_JSON).unwrap();
        assert!(m.gpu.is_none());
    }

    #[test]
    fn select_compiler_routes_device_to_nvcc() {
        let m: CompileManifest = serde_json::from_str(CUDA_MANIFEST_JSON).unwrap();
        assert_eq!(m.select_compiler(ModuleKind::Core), "g++");
        assert_eq!(m.select_compiler(ModuleKind::Gui), "g++");
        assert_eq!(m.select_compiler(ModuleKind::Device), "nvcc");
    }

    #[test]
    fn select_compiler_routes_device_to_hipcc_on_rocm() {
        let json = r#"{
            "compiler": "clang++",
            "std": "c++26",
            "common_flags": [],
            "core_link_flags": [],
            "gui_link_flags": [],
            "shared_link_flags": [],
            "runner_link_flags": [],
            "system_packages": [],
            "hot_reload_mode": "swap",
            "confidence": {"overall":"high","runner_synthesis":"high","link_flags":"high","notes":""},
            "gpu": {
                "vendor": "rocm",
                "device_compiler": "hipcc",
                "arch": ["gfx90a"],
                "device_flags": [],
                "runtime_libs": [],
                "snapshot_mode": "auto",
                "fatbin_strategy": "sidecar_module"
            }
        }"#;
        let m: CompileManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.select_compiler(ModuleKind::Core), "clang++");
        assert_eq!(m.select_compiler(ModuleKind::Device), "hipcc");
    }

    #[test]
    fn select_compiler_rejects_device_when_no_gpu_block() {
        let m: CompileManifest = serde_json::from_str(SAMPLE_SDL2_JSON).unwrap();
        let result = std::panic::catch_unwind(|| m.select_compiler(ModuleKind::Device));
        assert!(result.is_err());
        assert_eq!(m.select_compiler(ModuleKind::Core), "g++");
    }

    #[test]
    fn legacy_sdl2_fixture_has_no_gpu_block() {
        let m = CompileManifest::legacy_sdl2_fixture();
        assert!(m.gpu.is_none());
    }

    #[test]
    fn gpu_block_serde_roundtrips() {
        let m: CompileManifest = serde_json::from_str(CUDA_MANIFEST_JSON).unwrap();
        let back = serde_json::to_string(&m).unwrap();
        let again: CompileManifest = serde_json::from_str(&back).unwrap();
        assert_eq!(m.gpu, again.gpu);
    }

    #[test]
    fn clang_cuda_resolves_to_clang_plus_plus() {
        let json = r#"{
            "compiler": "clang++",
            "std": "c++26",
            "common_flags": [],
            "core_link_flags": [],
            "gui_link_flags": [],
            "shared_link_flags": [],
            "runner_link_flags": [],
            "system_packages": [],
            "hot_reload_mode": "swap",
            "confidence": {"overall":"high","runner_synthesis":"high","link_flags":"high","notes":""},
            "gpu": {
                "vendor": "cuda",
                "device_compiler": "clang-cuda",
                "arch": ["sm_80"],
                "device_flags": [],
                "runtime_libs": [],
                "snapshot_mode": "auto",
                "fatbin_strategy": "sidecar_module"
            }
        }"#;
        let m: CompileManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.select_compiler(ModuleKind::Device), "clang++");
    }

    #[test]
    fn parses_gpu_device_roles_and_device_link_topology() {
        let json = r#"{
            "compiler": "clang++",
            "std": "c++26",
            "common_flags": [],
            "core_link_flags": [],
            "gui_link_flags": [],
            "shared_link_flags": [],
            "runner_link_flags": [],
            "system_packages": [],
            "hot_reload_mode": "swap",
            "confidence": {"overall":"high","runner_synthesis":"high","link_flags":"high","notes":""},
            "gpu": {
                "vendor": "rocm",
                "device_compiler": "hipcc",
                "arch": ["gfx1201"],
                "device_flags": ["-O3", "-fgpu-rdc"],
                "runtime_libs": ["amdhip64"],
                "snapshot_mode": "auto",
                "fatbin_strategy": "sidecar_module",
                "device_roles": [
                    {
                        "id": "device.raster",
                        "path": ".synthi/generated/gpu/device_raster.hip",
                        "source_files": ["src/gpu/raster.hip"],
                        "compiler": "hipcc",
                        "arch": ["gfx1201"],
                        "requires_rdc": true
                    }
                ],
                "device_link": {
                    "requires_rdc": true,
                    "bundle_id": "bundle.raster",
                    "affected_roles": ["device.raster"],
                    "supports_incremental": false,
                    "estimated_ms": 9000,
                    "budget_ms": 5000
                },
                "generated_split_granularity": {
                    "schemaVersion": "synthi.gpu_hmr.generated_split_granularity.v1",
                    "acceptedClaim": "device_translation_unit_hmr",
                    "hmrReloadScope": "device_translation_unit",
                    "smallestSafeFissionIslandProven": false
                }
            }
        }"#;
        let m: CompileManifest = serde_json::from_str(json).unwrap();
        let gpu = m.gpu.expect("gpu block");

        assert_eq!(gpu.device_roles.len(), 1);
        assert_eq!(gpu.device_roles[0].id, "device.raster");
        assert_eq!(
            gpu.device_roles[0].source_files,
            vec!["src/gpu/raster.hip".to_string()]
        );
        assert!(gpu.device_roles[0].requires_rdc);
        assert!(gpu.device_link.requires_rdc);
        assert_eq!(gpu.device_link.bundle_id.as_deref(), Some("bundle.raster"));
        assert_eq!(gpu.device_link.estimated_ms, Some(9000));
        assert_eq!(
            gpu.generated_split_granularity
                .as_ref()
                .and_then(|value| value.get("acceptedClaim"))
                .and_then(|value| value.as_str()),
            Some("device_translation_unit_hmr")
        );
    }
}
