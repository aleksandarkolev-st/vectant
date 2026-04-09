// ============================================================
// DIRTY FILE CLASSIFIER
// ============================================================
// Classifies changed files into categories that drive rebuild
// scope decisions.  A file change is classified as Core, GUI,
// Shared, Config, Resource, or Irrelevant.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Classification of a changed file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FileClass {
    /// Core logic (state, computation, main loop).
    Core,
    /// GUI-only (rendering, UI events, layout).
    Gui,
    /// Shared between core and GUI (common headers, types, utils).
    Shared,
    /// Build configuration (Makefile, CMakeLists, Cargo.toml, etc.).
    Config,
    /// Non-code resources (images, shaders, data files).
    Resource,
    /// Files that don't affect the build at all.
    Irrelevant,
}

impl FileClass {
    /// Whether this class triggers recompilation.
    pub fn triggers_rebuild(&self) -> bool {
        matches!(
            self,
            FileClass::Core | FileClass::Gui | FileClass::Shared | FileClass::Config
        )
    }
}

/// A changed file with its classification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirtyFile {
    pub path: String,
    pub class: FileClass,
    pub content_hash: Option<String>,
}

/// Classify a file path into a FileClass.
///
/// This uses path-based heuristics (extension, directory name patterns).
/// Language-specific classifiers can override this.
pub fn classify_file(path: &str) -> FileClass {
    let p = Path::new(path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let path_lower = path.to_lowercase();

    // Irrelevant files
    if matches!(ext, "md" | "txt" | "log" | "json" | "yaml" | "yml" | "toml" | "lock")
        && !is_build_config(name)
    {
        return FileClass::Irrelevant;
    }

    // Git/editor junk
    if path_lower.contains(".git/")
        || path_lower.contains("node_modules/")
        || name.starts_with('.')
        || name.ends_with('~')
    {
        return FileClass::Irrelevant;
    }

    // Build config
    if is_build_config(name) {
        return FileClass::Config;
    }

    // Resources
    if matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "ico" | "webp"
            | "glsl" | "vert" | "frag" | "wgsl"
            | "wav" | "mp3" | "ogg"
            | "ttf" | "otf" | "woff" | "woff2"
    ) {
        return FileClass::Resource;
    }

    // Shared headers/includes
    if is_shared_path(&path_lower) {
        return FileClass::Shared;
    }

    // GUI files
    if is_gui_path(&path_lower) {
        return FileClass::Gui;
    }

    // Default: Core
    FileClass::Core
}

fn is_build_config(name: &str) -> bool {
    matches!(
        name,
        "Makefile"
            | "CMakeLists.txt"
            | "Cargo.toml"
            | "build.rs"
            | "meson.build"
            | "BUILD"
            | "BUILD.bazel"
            | "package.json"
            | "tsconfig.json"
            | "webpack.config.js"
            | "vite.config.js"
            | "vite.config.ts"
    )
}

fn is_shared_path(path: &str) -> bool {
    path.contains("/shared/")
        || path.contains("/common/")
        || path.contains("/include/")
        || path.contains("/types/")
        || path.contains("/proto/")
        || path.contains("_shared.")
        || path.contains("_common.")
}

fn is_gui_path(path: &str) -> bool {
    path.contains("/gui/")
        || path.contains("/ui/")
        || path.contains("/render/")
        || path.contains("/view/")
        || path.contains("/component")
        || path.contains("/widget")
        || path.contains("_gui.")
        || path.contains("_render.")
        || path.contains("_ui.")
}

/// Classify a batch of file paths.
pub fn classify_files(paths: &[String]) -> Vec<DirtyFile> {
    paths
        .iter()
        .map(|p| DirtyFile {
            path: p.clone(),
            class: classify_file(p),
            content_hash: None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_file() {
        assert_eq!(classify_file("src/main.rs"), FileClass::Core);
        assert_eq!(classify_file("src/engine/physics.cpp"), FileClass::Core);
    }

    #[test]
    fn gui_file() {
        assert_eq!(classify_file("src/gui/window.rs"), FileClass::Gui);
        assert_eq!(classify_file("src/render/pipeline.rs"), FileClass::Gui);
        assert_eq!(classify_file("src/components/button.tsx"), FileClass::Gui);
    }

    #[test]
    fn shared_file() {
        assert_eq!(classify_file("src/shared/types.rs"), FileClass::Shared);
        assert_eq!(classify_file("include/common.h"), FileClass::Shared);
    }

    #[test]
    fn config_file() {
        assert_eq!(classify_file("Cargo.toml"), FileClass::Config);
        assert_eq!(classify_file("CMakeLists.txt"), FileClass::Config);
    }

    #[test]
    fn resource_file() {
        assert_eq!(classify_file("assets/logo.png"), FileClass::Resource);
        assert_eq!(classify_file("shaders/main.glsl"), FileClass::Resource);
    }

    #[test]
    fn irrelevant() {
        assert_eq!(classify_file("README.md"), FileClass::Irrelevant);
        assert_eq!(classify_file(".gitignore"), FileClass::Irrelevant);
    }

    #[test]
    fn batch_classify() {
        let files = vec![
            "src/main.rs".into(),
            "src/gui/panel.rs".into(),
            "README.md".into(),
        ];
        let classified = classify_files(&files);
        assert_eq!(classified[0].class, FileClass::Core);
        assert_eq!(classified[1].class, FileClass::Gui);
        assert_eq!(classified[2].class, FileClass::Irrelevant);
    }
}
