pub mod hot_reload;
pub mod legacy_module_state;
pub mod platform;

pub mod capability;
pub mod cgroup_process_set;
pub mod closed_execution_process;
pub mod closed_execution_provider;
#[cfg(feature = "gpu-hmr")]
pub mod gpu_runtime_boundary;
// The GPU runtime *proof* contract (canonical hashing / strict verification) is
// part of the always-on compile + runner proof path (compiler/handler.rs,
// compiler/stages/runner.rs use it unconditionally). Only the device-compile
// stage itself stays behind `gpu-hmr`.
pub mod gpu_runtime_proof;
#[cfg(feature = "gpu-hmr")]
pub mod gpu_runtime_watchdog;
pub mod loader;
pub mod module_map_attestation;
pub mod native_runner_codec;
pub mod process_isolation;
// pub mod runner_bin; // Removed to avoid circular dependency / duplicate verification
pub mod runner_command_admission;
pub mod runner_logic;
pub mod runner_protocol;
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
