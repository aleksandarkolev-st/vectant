pub mod hot_reload;
pub mod legacy_module_state;
pub mod platform;

pub mod capability;
#[cfg(feature = "gpu-hmr")]
pub mod gpu_runtime_boundary;
#[cfg(feature = "gpu-hmr")]
pub mod gpu_runtime_watchdog;
pub mod loader;
pub mod process_isolation;
// pub mod runner_bin; // Removed to avoid circular dependency / duplicate verification
pub mod runner_logic;
pub mod runner_state;
pub mod shim;
pub mod supervisor;

pub mod plugin_contract;

pub mod runner;

// ULTRAPLAN Lightning Phase 10a: WindowBackend trait + per-library
// implementations. Currently dead code until runner_bin.rs is migrated
// to dispatch through the trait — the modules suppress the warning
// with `#[allow(dead_code)]`. See window_backend.rs for the migration plan.
pub mod backends;
pub mod path_c;
pub mod window_backend;
