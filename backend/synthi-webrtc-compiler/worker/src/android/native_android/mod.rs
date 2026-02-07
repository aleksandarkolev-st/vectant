// ============================================================
// NATIVE ANDROID MODULE
// ============================================================
// Compilation and emulator execution support for native Android
// projects (Java and Kotlin). Follows the same modular pattern
// as the react_native module.
// ============================================================

pub mod build;
pub mod detection;
pub mod diagnostics;
pub mod gradle_runner;
pub mod manifest_parser;

pub type LogCallback = Box<dyn Fn(String) + Send + Sync>;

pub use build::{
    build_native_android_apk, clean_android_build, BuildConfig, BuildResult, BuildVariant,
};
pub use detection::{
    detect_native_android_project, AndroidProjectType, NativeAndroidProjectInfo,
};
pub use manifest_parser::{
    parse_android_manifest, AndroidManifestInfo, IntentFilterInfo, ActivityInfo,
};
