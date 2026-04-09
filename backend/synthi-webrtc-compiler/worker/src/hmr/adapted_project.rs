// ============================================================
// ADAPTED PROJECT DETECTION
// ============================================================
// Detects whether a project has already been AI-adapted (split
// into core/gui modules) so the deterministic Loop A hot path
// can skip AI entirely on subsequent compiles.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Result of adapted-project detection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdaptedProjectStatus {
    /// Whether the project has valid core/gui split files.
    pub is_adapted: bool,

    /// Path to the core module source, if found.
    pub core_path: Option<PathBuf>,

    /// Path to the GUI module source, if found.
    pub gui_path: Option<PathBuf>,

    /// Path to the shared header, if found.
    pub shared_path: Option<PathBuf>,

    /// Hash of the AI split result that produced this adaptation.
    /// Used to detect if the split is stale vs the original source.
    pub split_hash: Option<String>,

    /// Reason the project is NOT adapted, if applicable.
    pub reason: Option<String>,
}

impl AdaptedProjectStatus {
    /// Fully adapted: core + gui both present.
    pub fn adapted(core: PathBuf, gui: PathBuf, shared: Option<PathBuf>) -> Self {
        Self {
            is_adapted: true,
            core_path: Some(core),
            gui_path: Some(gui),
            shared_path: shared,
            split_hash: None,
            reason: None,
        }
    }

    /// Not adapted, with a reason.
    pub fn not_adapted(reason: impl Into<String>) -> Self {
        Self {
            is_adapted: false,
            core_path: None,
            gui_path: None,
            shared_path: None,
            split_hash: None,
            reason: Some(reason.into()),
        }
    }

    /// Set the split hash for staleness checks.
    pub fn with_split_hash(mut self, hash: String) -> Self {
        self.split_hash = Some(hash);
        self
    }
}

/// Well-known file names for adapted project outputs.
const CORE_NAMES: &[&str] = &["core.cpp", "core.c", "core.rs", "core.zig"];
const GUI_NAMES: &[&str] = &["gui.cpp", "gui.c", "gui.rs", "gui.zig"];
const SHARED_NAMES: &[&str] = &["shared.h", "shared.hpp", "shared.rs"];

/// Detect whether a workspace directory contains an adapted project.
///
/// An adapted project has:
/// 1. A core module file (core.cpp, core.rs, etc.)
/// 2. A GUI module file (gui.cpp, gui.rs, etc.)
///
/// Optionally also a shared header (shared.h, shared.hpp).
pub fn detect_adapted_project(workspace_dir: &Path) -> AdaptedProjectStatus {
    if !workspace_dir.is_dir() {
        return AdaptedProjectStatus::not_adapted("workspace directory does not exist");
    }

    let core_path = find_first_match(workspace_dir, CORE_NAMES);
    let gui_path = find_first_match(workspace_dir, GUI_NAMES);
    let shared_path = find_first_match(workspace_dir, SHARED_NAMES);

    match (core_path, gui_path) {
        (Some(core), Some(gui)) => AdaptedProjectStatus::adapted(core, gui, shared_path),
        (Some(_), None) => {
            AdaptedProjectStatus::not_adapted("core module found but no gui module")
        }
        (None, Some(_)) => {
            AdaptedProjectStatus::not_adapted("gui module found but no core module")
        }
        (None, None) => {
            AdaptedProjectStatus::not_adapted("no core/gui split files found")
        }
    }
}

/// Check if a compile source hash matches the cached split hash,
/// indicating the split is still fresh.
pub fn is_split_fresh(status: &AdaptedProjectStatus, current_source_hash: &str) -> bool {
    match &status.split_hash {
        Some(hash) => hash == current_source_hash,
        None => false,
    }
}

fn find_first_match(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    for name in names {
        let candidate = dir.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn not_adapted_when_no_dir() {
        let status = detect_adapted_project(Path::new("/nonexistent/path/xyz"));
        assert!(!status.is_adapted);
    }

    #[test]
    fn not_adapted_when_empty_dir() {
        let dir = std::env::temp_dir().join("hmr_test_empty");
        let _ = fs::create_dir_all(&dir);
        let status = detect_adapted_project(&dir);
        assert!(!status.is_adapted);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn adapted_when_core_and_gui_present() {
        let dir = std::env::temp_dir().join("hmr_test_adapted");
        let _ = fs::create_dir_all(&dir);
        fs::write(dir.join("core.cpp"), "// core").unwrap();
        fs::write(dir.join("gui.cpp"), "// gui").unwrap();
        let status = detect_adapted_project(&dir);
        assert!(status.is_adapted);
        assert!(status.core_path.is_some());
        assert!(status.gui_path.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn split_freshness() {
        let status = AdaptedProjectStatus::adapted(
            PathBuf::from("core.cpp"),
            PathBuf::from("gui.cpp"),
            None,
        )
        .with_split_hash("abc123".into());

        assert!(is_split_fresh(&status, "abc123"));
        assert!(!is_split_fresh(&status, "def456"));
    }
}
