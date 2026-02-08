mod avd;
mod daemon;
mod install;
mod kvm;
mod launch;
mod lifecycle;
mod logcat;
mod sdk_health;
mod session;
mod shutdown;
mod types;

pub use daemon::{acquire_emulator_daemon, ensure_emulator_ready, EnsureReadyResult};
pub use kvm::{detect_kvm, KvmStatus};
pub use sdk_health::{check_android_sdk, AndroidSdkHealth};
pub use session::EmulatorSession;
pub use types::{
    AppInstallResult, AppLaunchResult, EmulatorBootResult, EmulatorConfig, EmulatorState, LogLevel,
    LogcatEntry,
};
