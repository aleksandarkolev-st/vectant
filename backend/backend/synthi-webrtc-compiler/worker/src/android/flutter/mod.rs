// ============================================================
// FLUTTER ANDROID BUILD MODULE
// ============================================================
// Handles Flutter project detection, build, and APK generation.
// Follows the same modular pattern as react_native/.
// ============================================================

mod android_scaffold;
pub mod build;
pub mod const_fixer;
pub mod detection;
mod diagnostics;
mod flutter_runner;
mod sdk_health;

pub type LogCallback = Box<dyn Fn(String) + Send + Sync>;

pub use android_scaffold::{
    derive_app_id, diagnose_android_scaffold, generate_android_scaffold, needs_android_scaffold,
    DiagnosticReport, MaintenanceAction,
};
pub use build::{
    build_flutter_apk, clean_flutter, BuildVariant, FlutterBuildConfig, FlutterBuildResult,
};
pub use const_fixer::fix_const_errors;
pub use detection::{detect_flutter_project, FlutterProjectInfo};
pub use sdk_health::check_flutter_sdk;
