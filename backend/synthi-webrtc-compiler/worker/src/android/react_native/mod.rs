pub mod build;
mod common;
pub mod detection;
mod diagnostics;
mod gradle_runner;
mod project_init;
pub mod sdk_health;

pub type LogCallback = Box<dyn Fn(String) + Send + Sync>;

pub use build::{build_apk_for_emulator, clean_android, BuildVariant, EmulatorBuildConfig, EmulatorBuildResult};
pub use detection::detect_react_native_project;
pub use sdk_health::check_android_sdk;
