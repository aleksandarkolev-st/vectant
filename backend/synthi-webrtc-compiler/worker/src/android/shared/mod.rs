// ============================================================
// SHARED UTILITIES FOR MOBILE COMPILATION
// ============================================================
// Cross-platform utilities shared between React Native, Native Android,
// and Flutter compilation pipelines.
// ============================================================

pub mod adb_utils;
pub mod emulator_utils;

pub use adb_utils::{
    adb_install_apk, adb_launch_activity, adb_get_installed_packages,
    adb_uninstall_package, adb_forward_port, adb_reverse_port,
    AdbInstallResult, AdbLaunchResult,
};
pub use emulator_utils::{
    wait_for_emulator_boot, check_emulator_connectivity, get_emulator_properties,
    EmulatorBootStatus,
};
