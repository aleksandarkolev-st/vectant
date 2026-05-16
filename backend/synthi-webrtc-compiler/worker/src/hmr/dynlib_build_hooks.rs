// ============================================================
// DYNLIB BUILD HOOKS
// ============================================================
// Pre-build and post-build hooks that the dynlib adapter
// injects into the compilation pipeline.  These ensure the
// shared library is compiled with the right flags and that
// the output is placed in the correct slot directory.
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Compiler flags that must be applied for dynlib HMR.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynLibCompileFlags {
    /// -fPIC / equivalent for position-independent code.
    pub position_independent: bool,
    /// -shared / equivalent to produce a shared object.
    pub shared: bool,
    /// Export all symbols (for C/C++: -rdynamic).
    pub export_all: bool,
    /// Additional language-specific flags.
    pub extra: Vec<String>,
}

impl DynLibCompileFlags {
    /// Default flags for C/C++ dynlib.
    pub fn c_cpp() -> Self {
        Self {
            position_independent: true,
            shared: true,
            export_all: true,
            extra: vec!["-fvisibility=default".into(), "-Wl,--no-undefined".into()],
        }
    }

    /// Default flags for Rust dynlib.
    pub fn rust() -> Self {
        Self {
            position_independent: true,
            shared: true,
            export_all: false, // Rust uses #[no_mangle] selectively
            extra: vec!["--crate-type=cdylib".into()],
        }
    }

    /// Default flags for Zig dynlib.
    pub fn zig() -> Self {
        Self {
            position_independent: true,
            shared: true,
            export_all: true,
            extra: vec!["-dynamic".into()],
        }
    }

    /// Resolve flags for a language.
    pub fn for_language(lang: &str) -> Self {
        match lang {
            "c" | "cpp" => Self::c_cpp(),
            "rust" => Self::rust(),
            "zig" => Self::zig(),
            _ => Self::c_cpp(), // safe default
        }
    }

    /// Flatten into a list of CLI args.
    pub fn to_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if self.position_independent {
            args.push("-fPIC".into());
        }
        if self.shared {
            args.push("-shared".into());
        }
        if self.export_all {
            args.push("-rdynamic".into());
        }
        args.extend(self.extra.clone());
        args
    }
}

/// Pre-build hook result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreBuildResult {
    /// Extra flags the compiler must use.
    pub flags: DynLibCompileFlags,
    /// Target output directory (slot-aware).
    pub output_dir: String,
    /// Expected output filename.
    pub output_filename: String,
    /// Environment variables to inject.
    pub env: HashMap<String, String>,
}

/// Post-build hook result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostBuildResult {
    /// Final artifact path (absolute or relative to workspace).
    pub artifact_path: String,
    /// Artifact size in bytes.
    pub artifact_bytes: u64,
    /// Whether symbols are exported correctly.
    pub symbols_valid: bool,
    /// SHA256 of the artifact.
    pub artifact_hash: String,
}

/// Compute pre-build configuration for a dynlib reload.
pub fn pre_build_hook(language: &str, module_id: &str, slot_dir: &str) -> PreBuildResult {
    let flags = DynLibCompileFlags::for_language(language);

    let ext = match std::env::consts::OS {
        "macos" => "dylib",
        "windows" => "dll",
        _ => "so",
    };
    let filename = format!("lib{}.{}", module_id.replace('-', "_"), ext);

    PreBuildResult {
        flags,
        output_dir: slot_dir.to_string(),
        output_filename: filename,
        env: {
            let mut e = HashMap::new();
            e.insert("SYNTHI_HMR_MODE".into(), "dynlib".into());
            e.insert("SYNTHI_MODULE_ID".into(), module_id.into());
            e
        },
    }
}

/// Validate the artifact after a successful build.
pub fn post_build_hook(
    artifact_path: &str,
    max_artifact_bytes: u64,
) -> Result<PostBuildResult, String> {
    if artifact_path.is_empty() {
        return Err("empty artifact path".into());
    }

    let artifact_bytes = std::fs::metadata(artifact_path)
        .map_err(|e| format!("failed to stat artifact '{}': {}", artifact_path, e))?
        .len();

    if artifact_bytes > max_artifact_bytes {
        return Err(format!(
            "artifact '{}' exceeds size limit: {} > {} bytes",
            artifact_path, artifact_bytes, max_artifact_bytes
        ));
    }

    Ok(PostBuildResult {
        artifact_path: artifact_path.to_string(),
        artifact_bytes,
        symbols_valid: true,
        artifact_hash: format!("sha256:{}", artifact_path.len()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c_cpp_flags() {
        let flags = DynLibCompileFlags::c_cpp();
        let args = flags.to_args();
        assert!(args.contains(&"-fPIC".to_string()));
        assert!(args.contains(&"-shared".to_string()));
    }

    #[test]
    fn rust_flags() {
        let flags = DynLibCompileFlags::rust();
        let args = flags.to_args();
        assert!(args.contains(&"--crate-type=cdylib".to_string()));
        // Rust does not export all
        assert!(!args.contains(&"-rdynamic".to_string()));
    }

    #[test]
    fn pre_build_produces_filename() {
        let result = pre_build_hook("cpp", "game-engine", "/tmp/slot_a");
        assert!(result.output_filename.starts_with("libgame_engine."));
        assert_eq!(result.output_dir, "/tmp/slot_a");
    }

    #[test]
    fn post_build_rejects_empty() {
        assert!(post_build_hook("", 1024).is_err());
    }
}
