// ============================================================
// DEVICE CHECKPOINT PROBE (GPU_HMR_ULTRAPLAN Phase 3)
// ============================================================
//
// Decides whether a workspace can use the Tier-A binary driver
// checkpoint path or must fall back to Tier-B userspace snapshots.
// The probe is deliberately non-failing: the orchestrator always gets
// a selected tier and a human-readable reason for logs.

#![cfg(feature = "gpu-hmr")]

use crate::hmr::compile_manifest::{DeviceVendor, SnapshotMode};
use crate::hmr::device_snapshot::SnapshotTier;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointProbe {
    pub vendor: DeviceVendor,
    pub requested: SnapshotMode,
    pub selected_tier: SnapshotTier,
    pub tier_a_available: bool,
    pub downgraded: bool,
    pub reason: String,
    pub checked_symbols: Vec<String>,
}

impl CheckpointProbe {
    pub fn log_marker(&self) -> String {
        if self.tier_a_available {
            format!(
                "[device-checkpoint-probe] tier=A available vendor={} symbols={}",
                self.vendor.as_str(),
                self.checked_symbols.len()
            )
        } else if self.downgraded {
            format!(
                "[device-checkpoint-probe] tier=A unavailable; falling back to tier B reason={}",
                self.reason
            )
        } else {
            format!(
                "[device-checkpoint-probe] tier=B selected reason={}",
                self.reason
            )
        }
    }
}

pub fn probe_checkpoint(vendor: DeviceVendor, requested: SnapshotMode) -> CheckpointProbe {
    if requested == SnapshotMode::Userspace {
        return CheckpointProbe {
            vendor,
            requested,
            selected_tier: SnapshotTier::Userspace,
            tier_a_available: false,
            downgraded: false,
            reason: "snapshot_mode=userspace".into(),
            checked_symbols: Vec::new(),
        };
    }

    match vendor {
        DeviceVendor::Cuda => probe_cuda(requested),
        DeviceVendor::Rocm => probe_rocm(requested),
    }
}

fn probe_cuda(requested: SnapshotMode) -> CheckpointProbe {
    let symbols = cuda_checkpoint_symbols();
    let mut missing = Vec::new();
    let library_result = unsafe { libloading::Library::new("libcuda.so.1") };
    match library_result {
        Ok(lib) => {
            for sym in symbols {
                let result = unsafe { lib.get::<*const ()>(sym.as_bytes()) };
                if result.is_err() {
                    missing.push((*sym).to_string());
                }
            }
            if missing.is_empty() {
                return CheckpointProbe {
                    vendor: DeviceVendor::Cuda,
                    requested,
                    selected_tier: SnapshotTier::DriverCheckpoint,
                    tier_a_available: true,
                    downgraded: false,
                    reason: "cuda-checkpoint-symbols-present".into(),
                    checked_symbols: symbols.iter().map(|s| (*s).to_string()).collect(),
                };
            }
            CheckpointProbe {
                vendor: DeviceVendor::Cuda,
                requested,
                selected_tier: SnapshotTier::Userspace,
                tier_a_available: false,
                downgraded: true,
                reason: format!("missing symbols: {}", missing.join(",")),
                checked_symbols: symbols.iter().map(|s| (*s).to_string()).collect(),
            }
        }
        Err(e) => CheckpointProbe {
            vendor: DeviceVendor::Cuda,
            requested,
            selected_tier: SnapshotTier::Userspace,
            tier_a_available: false,
            downgraded: requested != SnapshotMode::Userspace,
            reason: format!("libcuda.so.1 unavailable: {e}"),
            checked_symbols: symbols.iter().map(|s| (*s).to_string()).collect(),
        },
    }
}

fn probe_rocm(requested: SnapshotMode) -> CheckpointProbe {
    let available = std::process::Command::new("criu-amdgpu")
        .arg("--version")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);
    if available {
        CheckpointProbe {
            vendor: DeviceVendor::Rocm,
            requested,
            selected_tier: SnapshotTier::DriverCheckpoint,
            tier_a_available: true,
            downgraded: false,
            reason: "criu-amdgpu-present".into(),
            checked_symbols: vec!["criu-amdgpu".into()],
        }
    } else {
        CheckpointProbe {
            vendor: DeviceVendor::Rocm,
            requested,
            selected_tier: SnapshotTier::Userspace,
            tier_a_available: false,
            downgraded: requested != SnapshotMode::Userspace,
            reason: "criu-amdgpu unavailable".into(),
            checked_symbols: vec!["criu-amdgpu".into()],
        }
    }
}

pub fn cuda_checkpoint_symbols() -> &'static [&'static str] {
    &[
        "cuCheckpointProcessLock",
        "cuCheckpointProcessCheckpoint",
        "cuCheckpointProcessRestore",
        "cuCheckpointProcessUnlock",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn userspace_request_skips_tier_a_probe() {
        let probe = probe_checkpoint(DeviceVendor::Cuda, SnapshotMode::Userspace);
        assert_eq!(probe.selected_tier, SnapshotTier::Userspace);
        assert!(!probe.downgraded);
        assert!(probe.log_marker().contains("tier=B selected"));
    }

    #[test]
    fn cuda_symbol_list_pins_checkpoint_api() {
        let names = cuda_checkpoint_symbols();
        assert!(names.contains(&"cuCheckpointProcessLock"));
        assert!(names.contains(&"cuCheckpointProcessCheckpoint"));
        assert!(names.contains(&"cuCheckpointProcessRestore"));
    }

    #[test]
    fn auto_probe_always_selects_a_tier() {
        let probe = probe_checkpoint(DeviceVendor::Cuda, SnapshotMode::Auto);
        assert!(matches!(
            probe.selected_tier,
            SnapshotTier::DriverCheckpoint | SnapshotTier::Userspace
        ));
        assert!(probe.log_marker().contains("[device-checkpoint-probe]"));
    }
}
