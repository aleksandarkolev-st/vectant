// ============================================================
// ADAPTED PROJECT DETECTION
// ============================================================
// Detects whether a project has already been AI-adapted (split
// into core/gui modules) so the deterministic Loop A hot path
// can skip AI entirely on subsequent compiles.
// ============================================================

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::hmr::compile_manifest::{CompileManifest, ModuleFiles};

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

    /// ULTRAPLAN Phase 4: path to host_runner.cpp, if present.
    /// The universal split prompt emits a 4th file alongside core/gui/
    /// shared — the per-project main() that dlopens libcore.so / libgui.so.
    /// Pre-Phase-4 sidecars don't have it; field is None for those.
    #[serde(default)]
    pub host_runner_path: Option<PathBuf>,

    /// ULTRAPLAN Phase 4: BYOR (Bring Your Own Runner) sentinel.
    /// True iff the host_runner.cpp on disk starts with the
    /// `// SYNTHI_USER_RUNNER` marker, meaning the user authored the
    /// runner themselves and we MUST NOT regenerate it on AI splits.
    /// See HMR_AGNOSTIC_ULTRAPLAN.md §5.2 (Point 2 mitigation B).
    #[serde(default)]
    pub user_owned_runner: bool,

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
            host_runner_path: None,
            user_owned_runner: false,
            split_hash: None,
            reason: None,
        }
    }

    /// Phase 4: full 4-file adaptation (core + gui + shared + host_runner).
    /// Use this constructor when the universal split prompt has produced
    /// all four files. `user_owned` flips when the host_runner contains
    /// the BYOR sentinel.
    pub fn adapted_full(
        core: PathBuf,
        gui: PathBuf,
        shared: Option<PathBuf>,
        host_runner: PathBuf,
        user_owned: bool,
    ) -> Self {
        Self {
            is_adapted: true,
            core_path: Some(core),
            gui_path: Some(gui),
            shared_path: shared,
            host_runner_path: Some(host_runner),
            user_owned_runner: user_owned,
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
            host_runner_path: None,
            user_owned_runner: false,
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
/// ULTRAPLAN Phase 4. Only one extension supported in V1 — the universal
/// split prompt is C++-only. V2 will language-parameterise this list.
const HOST_RUNNER_NAMES: &[&str] = &["host_runner.cpp"];

/// ULTRAPLAN Phase 4: marker that a host_runner.cpp is user-authored
/// rather than AI-generated. When the FIRST line of host_runner.cpp
/// (after optional whitespace) is exactly `// SYNTHI_USER_RUNNER`, the
/// HMR system locks the file and never regenerates it on subsequent
/// AI splits. The user can edit freely and we just rebuild on changes.
pub const BYOR_SENTINEL: &str = "// SYNTHI_USER_RUNNER";

/// ULTRAPLAN Phase 4: scan the first non-blank line of `host_runner.cpp`
/// for the BYOR sentinel. Returns false on read failure (treat as
/// AI-owned, the safer default).
pub fn host_runner_is_user_owned(host_runner_path: &Path) -> bool {
    let content = match std::fs::read_to_string(host_runner_path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        return trimmed == BYOR_SENTINEL;
    }
    false
}

/// Detect whether a workspace directory contains an adapted project.
///
/// An adapted project has:
/// 1. A core module file (core.cpp, core.rs, etc.)
/// 2. A GUI module file (gui.cpp, gui.rs, etc.)
///
/// Optionally also a shared header (shared.h, shared.hpp) and a
/// host_runner.cpp (Phase 4).
pub fn detect_adapted_project(workspace_dir: &Path) -> AdaptedProjectStatus {
    if !workspace_dir.is_dir() {
        return AdaptedProjectStatus::not_adapted("workspace directory does not exist");
    }

    if let Some(module_files) = read_manifest_module_files(workspace_dir) {
        let core_path = module_files
            .core
            .as_deref()
            .and_then(|p| existing_workspace_file(workspace_dir, p));
        let gui_path = module_files
            .gui
            .as_deref()
            .and_then(|p| existing_workspace_file(workspace_dir, p));
        let shared_path = module_files
            .shared
            .as_deref()
            .and_then(|p| existing_workspace_file(workspace_dir, p));
        let host_runner_path = module_files
            .host_runner
            .as_deref()
            .and_then(|p| existing_workspace_file(workspace_dir, p));
        if core_path.is_some() || gui_path.is_some() {
            let user_owned_runner = match &host_runner_path {
                Some(p) => host_runner_is_user_owned(p),
                None => false,
            };
            return match (core_path, gui_path) {
                (Some(core), Some(gui)) => match host_runner_path {
                    Some(runner) => AdaptedProjectStatus::adapted_full(
                        core,
                        gui,
                        shared_path,
                        runner,
                        user_owned_runner,
                    ),
                    None => AdaptedProjectStatus::adapted(core, gui, shared_path),
                },
                (Some(_), None) => {
                    AdaptedProjectStatus::not_adapted("manifest core module found but no gui module")
                }
                (None, Some(_)) => {
                    AdaptedProjectStatus::not_adapted("manifest gui module found but no core module")
                }
                (None, None) => AdaptedProjectStatus::not_adapted(
                    "manifest module_files declared but no core/gui split files found",
                ),
            };
        }
    }

    let core_path = find_first_match(workspace_dir, CORE_NAMES);
    let gui_path = find_first_match(workspace_dir, GUI_NAMES);
    let shared_path = find_first_match(workspace_dir, SHARED_NAMES);
    let host_runner_path = find_first_match(workspace_dir, HOST_RUNNER_NAMES);
    let user_owned_runner = match &host_runner_path {
        Some(p) => host_runner_is_user_owned(p),
        None => false,
    };

    match (core_path, gui_path) {
        (Some(core), Some(gui)) => match host_runner_path {
            Some(runner) => AdaptedProjectStatus::adapted_full(
                core,
                gui,
                shared_path,
                runner,
                user_owned_runner,
            ),
            None => AdaptedProjectStatus::adapted(core, gui, shared_path),
        },
        (Some(_), None) => AdaptedProjectStatus::not_adapted("core module found but no gui module"),
        (None, Some(_)) => AdaptedProjectStatus::not_adapted("gui module found but no core module"),
        (None, None) => AdaptedProjectStatus::not_adapted("no core/gui split files found"),
    }
}

fn read_manifest_module_files(workspace_dir: &Path) -> Option<ModuleFiles> {
    for rel in [".synthi/build_manifest.json", ".synthi_split_meta.json"] {
        let Ok(raw) = std::fs::read_to_string(workspace_dir.join(rel)) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let manifest_value = if rel == ".synthi_split_meta.json" {
            match value.get("compile_manifest") {
                Some(v) => v.clone(),
                None => continue,
            }
        } else {
            value
        };
        let Some(manifest) = CompileManifest::from_json_value(&manifest_value) else {
            continue;
        };
        if manifest.module_files.core.is_some() || manifest.module_files.gui.is_some() {
            return Some(manifest.module_files);
        }
    }
    None
}

fn existing_workspace_file(workspace_dir: &Path, raw: &str) -> Option<PathBuf> {
    let rel = workspace_relative_path(raw)?;
    let path = workspace_dir.join(rel);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn workspace_relative_path(raw: &str) -> Option<PathBuf> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() {
        return None;
    }
    let mut rel = PathBuf::new();
    for component in Path::new(&normalized).components() {
        match component {
            std::path::Component::Normal(part) => rel.push(part),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => return None,
        }
    }
    if rel.as_os_str().is_empty() {
        None
    } else {
        Some(rel)
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
