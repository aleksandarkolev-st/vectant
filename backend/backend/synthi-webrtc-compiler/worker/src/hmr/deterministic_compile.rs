// ============================================================
// DETERMINISTIC COMPILE PATH (Loop A)
// ============================================================
// Pure-function contract for the AI-free compilation path.
// When a project is adapted, Loop A recompiles the existing
// core/gui modules without calling any AI endpoint. This is
// the steady-state hot path that must meet the ≤2.5s warm
// reload latency budget.
// ============================================================


use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::hmr::adapted_project::AdaptedProjectStatus;
use crate::hmr::build_manifest::BuildManifest;

/// Input to the deterministic compile step.
#[derive(Debug, Clone)]
pub struct DeterministicCompileInput {
    /// Adapted project status (must be is_adapted == true).
    pub adapted: AdaptedProjectStatus,

    /// Language (cpp, c, rust, zig).
    pub language: String,

    /// Workspace directory containing the source files.
    pub workspace_dir: PathBuf,

    /// Output directory for build artifacts.
    pub output_dir: PathBuf,

    /// Compiler flags.
    pub compiler_flags: Vec<String>,

    /// Whether to use the incremental cache.
    pub use_cache: bool,

    /// Preview ID for manifest generation.
    pub preview_id: String,
}

/// Output of the deterministic compile step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeterministicCompileOutput {
    /// Whether compilation succeeded.
    pub success: bool,

    /// Build manifest for the planner (only set on success).
    pub manifest: Option<BuildManifest>,

    /// Compiler stderr/stdout diagnostics.
    pub diagnostics: Vec<String>,

    /// Time spent compiling core module (ms).
    pub core_compile_ms: u64,

    /// Time spent compiling gui module (ms).
    pub gui_compile_ms: u64,

    /// Time spent linking (ms).
    pub link_ms: u64,

    /// Whether the incremental cache was used.
    pub cache_hit: bool,

    /// Total elapsed time (ms).
    pub total_ms: u64,
}

impl DeterministicCompileOutput {
    /// Create a failure result.
    pub fn failure(diagnostics: Vec<String>, total_ms: u64) -> Self {
        Self {
            success: false,
            manifest: None,
            diagnostics,
            core_compile_ms: 0,
            gui_compile_ms: 0,
            link_ms: 0,
            cache_hit: false,
            total_ms,
        }
    }

    /// Check if total time exceeds the warm reload budget.
    pub fn exceeds_warm_budget(&self) -> bool {
        self.total_ms > 2500
    }

    /// Check if total time exceeds the cold reload budget.
    pub fn exceeds_cold_budget(&self) -> bool {
        self.total_ms > 5000
    }
}

/// Validate that the input is suitable for deterministic compilation.
///
/// Returns an error message if the project is not adapted or
/// the required source files are missing.
pub fn validate_deterministic_input(
    input: &DeterministicCompileInput,
) -> Result<(), String> {
    if !input.adapted.is_adapted {
        return Err("project is not adapted; cannot use Loop A".into());
    }

    if input.adapted.core_path.is_none() {
        return Err("adapted project missing core module path".into());
    }

    if input.adapted.gui_path.is_none() {
        return Err("adapted project missing gui module path".into());
    }

    Ok(())
}

/// Compute the rebuild scope for a deterministic compile.
///
/// For now this returns which modules need recompilation based
/// on file modification times. The actual compilation is done
/// by the existing compiler pipeline (compile_core / compile_gui).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeterministicRebuildScope {
    /// Nothing changed; skip compilation.
    None,
    /// Only core module changed.
    CoreOnly,
    /// Only GUI module changed.
    GuiOnly,
    /// Both changed (or shared header changed).
    Both,
}

/// Determine which modules need recompilation.
///
/// This is a simplified version that checks file existence;
/// the full version will use dirty-unit detection (Wave 07).
pub fn determine_deterministic_scope(
    input: &DeterministicCompileInput,
    prev_core_hash: Option<&str>,
    prev_gui_hash: Option<&str>,
    curr_core_hash: &str,
    curr_gui_hash: &str,
) -> DeterministicRebuildScope {
    let core_changed = prev_core_hash.map(|h| h != curr_core_hash).unwrap_or(true);
    let gui_changed = prev_gui_hash.map(|h| h != curr_gui_hash).unwrap_or(true);

    // If shared header exists, a change forces both
    // (this will be refined in Wave 07 with dirty-unit tracking)
    let _ = input; // used for shared header check in future

    match (core_changed, gui_changed) {
        (false, false) => DeterministicRebuildScope::None,
        (true, false) => DeterministicRebuildScope::CoreOnly,
        (false, true) => DeterministicRebuildScope::GuiOnly,
        (true, true) => DeterministicRebuildScope::Both,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::adapted_project::AdaptedProjectStatus;

    #[test]
    fn validate_rejects_non_adapted() {
        let input = DeterministicCompileInput {
            adapted: AdaptedProjectStatus::not_adapted("test"),
            language: "cpp".into(),
            workspace_dir: PathBuf::from("/tmp"),
            output_dir: PathBuf::from("/tmp/out"),
            compiler_flags: vec![],
            use_cache: false,
            preview_id: "p1".into(),
        };
        assert!(validate_deterministic_input(&input).is_err());
    }

    #[test]
    fn validate_accepts_adapted() {
        let input = DeterministicCompileInput {
            adapted: AdaptedProjectStatus::adapted(
                PathBuf::from("core.cpp"),
                PathBuf::from("gui.cpp"),
                None,
            ),
            language: "cpp".into(),
            workspace_dir: PathBuf::from("/tmp"),
            output_dir: PathBuf::from("/tmp/out"),
            compiler_flags: vec![],
            use_cache: false,
            preview_id: "p1".into(),
        };
        assert!(validate_deterministic_input(&input).is_ok());
    }

    #[test]
    fn scope_detection() {
        let input = DeterministicCompileInput {
            adapted: AdaptedProjectStatus::adapted(
                PathBuf::from("core.cpp"),
                PathBuf::from("gui.cpp"),
                None,
            ),
            language: "cpp".into(),
            workspace_dir: PathBuf::from("/tmp"),
            output_dir: PathBuf::from("/tmp/out"),
            compiler_flags: vec![],
            use_cache: false,
            preview_id: "p1".into(),
        };

        assert_eq!(
            determine_deterministic_scope(&input, Some("h1"), Some("h2"), "h1", "h2"),
            DeterministicRebuildScope::None
        );
        assert_eq!(
            determine_deterministic_scope(&input, Some("h1"), Some("h2"), "h1x", "h2"),
            DeterministicRebuildScope::CoreOnly
        );
        assert_eq!(
            determine_deterministic_scope(&input, Some("h1"), Some("h2"), "h1", "h2x"),
            DeterministicRebuildScope::GuiOnly
        );
        assert_eq!(
            determine_deterministic_scope(&input, Some("h1"), Some("h2"), "h1x", "h2x"),
            DeterministicRebuildScope::Both
        );
    }

    #[test]
    fn budget_checks() {
        let mut out = DeterministicCompileOutput::failure(vec![], 2000);
        assert!(!out.exceeds_warm_budget());
        out.total_ms = 3000;
        assert!(out.exceeds_warm_budget());
        assert!(!out.exceeds_cold_budget());
        out.total_ms = 6000;
        assert!(out.exceeds_cold_budget());
    }
}
