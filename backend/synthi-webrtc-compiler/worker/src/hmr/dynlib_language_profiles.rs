// ============================================================
// DYNLIB LANGUAGE PROFILES
// ============================================================
// Per-language configuration for C, C++, Rust, and Zig dynlib
// compilation, linking, and ABI conventions.  Used by
// dynlib_build_hooks and dynlib_adapter to adapt behaviour to
// the source language of the loaded module.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Languages supported by the DynLib adapter family.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DynLibLanguage {
    C,
    Cpp,
    Rust,
    Zig,
}

impl DynLibLanguage {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::C => "c",
            Self::Cpp => "cpp",
            Self::Rust => "rust",
            Self::Zig => "zig",
        }
    }

    /// Try to detect language from file extension.
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext {
            "c" | "h" => Some(Self::C),
            "cpp" | "cxx" | "cc" | "hpp" | "hxx" => Some(Self::Cpp),
            "rs" => Some(Self::Rust),
            "zig" => Some(Self::Zig),
            _ => None,
        }
    }
}

/// Name mangling convention used by the language.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ManglingScheme {
    /// No mangling (C, Zig with export, Rust with #[no_mangle]).
    None,
    /// Itanium ABI mangling (GCC/Clang C++).
    ItaniumCpp,
    /// MSVC C++ mangling.
    MsvcCpp,
    /// Rust symbol mangling (v0 scheme).
    RustV0,
}

/// ABI calling convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CallingConvention {
    /// Standard C calling convention.
    Cdecl,
    /// System default (Windows: stdcall on x86).
    System,
}

/// Per-language build profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanguageProfile {
    pub language: DynLibLanguage,
    /// Compiler executable name.
    pub compiler: String,
    /// Flags to produce position-independent shared library.
    pub shared_lib_flags: Vec<String>,
    /// Flags to export dynamic symbols.
    pub export_flags: Vec<String>,
    /// Debug info flags.
    pub debug_flags: Vec<String>,
    /// Optimization flags for reload speed.
    pub fast_rebuild_flags: Vec<String>,
    /// Expected mangling scheme.
    pub mangling: ManglingScheme,
    /// Calling convention for HMR ABI symbols.
    pub calling_convention: CallingConvention,
    /// Shared library extension per this language's toolchain.
    pub output_extension: String,
    /// Whether the language requires a special extern "C" wrapper.
    pub needs_extern_c: bool,
}

/// Get the canonical language profile.
pub fn profile_for(lang: DynLibLanguage) -> LanguageProfile {
    match lang {
        DynLibLanguage::C => LanguageProfile {
            language: lang,
            compiler: "cc".into(),
            shared_lib_flags: vec!["-shared".into(), "-fPIC".into()],
            export_flags: vec!["-rdynamic".into()],
            debug_flags: vec!["-g".into()],
            fast_rebuild_flags: vec!["-O0".into()],
            mangling: ManglingScheme::None,
            calling_convention: CallingConvention::Cdecl,
            output_extension: default_so_ext(),
            needs_extern_c: false,
        },
        DynLibLanguage::Cpp => LanguageProfile {
            language: lang,
            compiler: "c++".into(),
            shared_lib_flags: vec!["-shared".into(), "-fPIC".into()],
            export_flags: vec!["-rdynamic".into()],
            debug_flags: vec!["-g".into()],
            fast_rebuild_flags: vec!["-O0".into()],
            mangling: ManglingScheme::ItaniumCpp,
            calling_convention: CallingConvention::Cdecl,
            output_extension: default_so_ext(),
            needs_extern_c: true,
        },
        DynLibLanguage::Rust => LanguageProfile {
            language: lang,
            compiler: "rustc".into(),
            shared_lib_flags: vec!["--crate-type=cdylib".into()],
            export_flags: vec![],
            debug_flags: vec!["-g".into()],
            fast_rebuild_flags: vec!["-C".into(), "opt-level=0".into()],
            mangling: ManglingScheme::None, // #[no_mangle] on HMR symbols
            calling_convention: CallingConvention::Cdecl,
            output_extension: default_so_ext(),
            needs_extern_c: true,
        },
        DynLibLanguage::Zig => LanguageProfile {
            language: lang,
            compiler: "zig".into(),
            shared_lib_flags: vec!["-dynamic".into()],
            export_flags: vec![],
            debug_flags: vec![],
            fast_rebuild_flags: vec![],
            mangling: ManglingScheme::None, // export with C ABI
            calling_convention: CallingConvention::Cdecl,
            output_extension: default_so_ext(),
            needs_extern_c: false,
        },
    }
}

fn default_so_ext() -> String {
    if cfg!(target_os = "macos") {
        ".dylib".into()
    } else if cfg!(target_os = "windows") {
        ".dll".into()
    } else {
        ".so".into()
    }
}

/// Detect language from a list of file paths.
pub fn detect_language(paths: &[String]) -> Option<DynLibLanguage> {
    for path in paths {
        if let Some(ext) = path.rsplit('.').next() {
            if let Some(lang) = DynLibLanguage::from_extension(ext) {
                return Some(lang);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_c() {
        let files = vec!["main.c".into(), "util.h".into()];
        assert_eq!(detect_language(&files), Some(DynLibLanguage::C));
    }

    #[test]
    fn detects_rust() {
        let files = vec!["lib.rs".into()];
        assert_eq!(detect_language(&files), Some(DynLibLanguage::Rust));
    }

    #[test]
    fn cpp_needs_extern_c() {
        let profile = profile_for(DynLibLanguage::Cpp);
        assert!(profile.needs_extern_c);
        assert_eq!(profile.mangling, ManglingScheme::ItaniumCpp);
    }

    #[test]
    fn zig_no_extern_c() {
        let profile = profile_for(DynLibLanguage::Zig);
        assert!(!profile.needs_extern_c);
        assert_eq!(profile.mangling, ManglingScheme::None);
    }

    #[test]
    fn rust_cdylib_crate_type() {
        let profile = profile_for(DynLibLanguage::Rust);
        assert!(profile.shared_lib_flags.contains(&"--crate-type=cdylib".to_string()));
    }
}
