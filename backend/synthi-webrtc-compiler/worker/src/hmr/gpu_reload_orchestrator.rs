// ============================================================
// GPU RELOAD ORCHESTRATOR (GPU_HMR_ULTRAPLAN Phase 3)
// ============================================================
//
// Deterministic device-aware reload state machine. This module owns the
// ordered plan, guardrails, rollback decision, and log markers. Driver
// calls still live in gpu_module_manager / gpu_stream_drain; handler.rs
// can wire this report into the live swap path without re-encoding the
// product contract.

#![cfg(feature = "gpu-hmr")]

use serde::{Deserialize, Serialize};

use crate::hmr::compile_manifest::{DeviceVendor, SnapshotMode};
use crate::hmr::device_checkpoint_probe::probe_checkpoint;
use crate::hmr::device_snapshot::SnapshotTier;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuReloadPlan {
    HostOnly,
    DeviceOnly,
    Mixed,
    AbiBreaking,
}

impl GpuReloadPlan {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::HostOnly => "host_only",
            Self::DeviceOnly => "device_only",
            Self::Mixed => "mixed",
            Self::AbiBreaking => "abi_breaking",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuReloadStep {
    HostSwap,
    DeviceSave,
    Drain,
    Save,
    Unload,
    Load,
    Restore,
    Verify,
    DeviceRestore,
    ColdReload,
    DeviceOnLoad,
    Rollback,
    ColdRestart,
}

impl GpuReloadStep {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::HostSwap => "host_swap",
            Self::DeviceSave => "device_save",
            Self::Drain => "drain",
            Self::Save => "save",
            Self::Unload => "unload",
            Self::Load => "load",
            Self::Restore => "restore",
            Self::Verify => "verify",
            Self::DeviceRestore => "device_restore",
            Self::ColdReload => "cold_reload",
            Self::DeviceOnLoad => "device_on_load",
            Self::Rollback => "rollback",
            Self::ColdRestart => "cold_restart",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuReloadConfig {
    pub vendor: DeviceVendor,
    pub requested_snapshot_mode: SnapshotMode,
    pub drain_timeout_ms: u64,
    pub snapshot_budget_ms: u64,
    pub max_heal_retries: u8,
}

impl Default for GpuReloadConfig {
    fn default() -> Self {
        Self {
            vendor: DeviceVendor::Cuda,
            requested_snapshot_mode: SnapshotMode::Auto,
            drain_timeout_ms: env_u64("SYNTHI_GPU_DRAIN_TIMEOUT_MS", 2_000),
            snapshot_budget_ms: env_u64("SYNTHI_GPU_SNAPSHOT_BUDGET_MS", 250),
            max_heal_retries: 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuSwapInputs {
    pub plan: GpuReloadPlan,
    pub reason: String,
    pub streams_synced: u32,
    pub force_drain_timeout: bool,
    pub snapshot_bytes: u64,
    pub snapshot_ms: u64,
    pub dirty_buffers: u32,
    pub expected_kernel_hashes: u32,
    pub matched_kernel_hashes: u32,
}

impl GpuSwapInputs {
    pub fn device_only(reason: impl Into<String>) -> Self {
        Self {
            plan: GpuReloadPlan::DeviceOnly,
            reason: reason.into(),
            streams_synced: 1,
            force_drain_timeout: false,
            snapshot_bytes: 0,
            snapshot_ms: 0,
            dirty_buffers: 0,
            expected_kernel_hashes: 1,
            matched_kernel_hashes: 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuReloadReport {
    pub plan: GpuReloadPlan,
    pub selected_tier: SnapshotTier,
    pub steps: Vec<GpuReloadStep>,
    pub log_lines: Vec<String>,
    pub state_preserved: bool,
    pub requires_cold_restart: bool,
    pub rollback_required: bool,
}

impl GpuReloadReport {
    pub fn step_sequence(&self) -> String {
        self.steps
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(" -> ")
    }
}

pub fn plan_gpu_reload(config: &GpuReloadConfig, input: GpuSwapInputs) -> GpuReloadReport {
    let probe = probe_checkpoint(config.vendor, config.requested_snapshot_mode);
    let tier = probe.selected_tier;
    let mut steps = Vec::new();
    let mut logs = vec![
        format!(
            "[gpu-reload] plan={}  reason={}",
            input.plan.as_str(),
            input.reason
        ),
        probe.log_marker(),
    ];

    if input.force_drain_timeout {
        steps.extend([GpuReloadStep::Drain, GpuReloadStep::ColdRestart]);
        logs.push(format!(
            "[gpu-reload] step=drain timeout_ms={} outcome=timed_out",
            config.drain_timeout_ms
        ));
        logs.push("[gpu-reload] cold-restart reason=kernel-hang-detected".into());
        return GpuReloadReport {
            plan: input.plan,
            selected_tier: tier,
            steps,
            log_lines: logs,
            state_preserved: false,
            requires_cold_restart: true,
            rollback_required: false,
        };
    }

    match input.plan {
        GpuReloadPlan::HostOnly => {
            steps.push(GpuReloadStep::HostSwap);
            logs.push("[gpu-reload] host_only delegating to existing host swap".into());
        }
        GpuReloadPlan::DeviceOnly => {
            append_device_swap(&mut steps, &mut logs, config, &input, tier)
        }
        GpuReloadPlan::Mixed => {
            steps.push(GpuReloadStep::DeviceSave);
            logs.push("[gpu-reload] device_save begin".into());
            steps.push(GpuReloadStep::HostSwap);
            logs.push("[gpu-reload] host_swap begin".into());
            append_device_swap(&mut steps, &mut logs, config, &input, tier);
            steps.push(GpuReloadStep::DeviceRestore);
            logs.push("[gpu-reload] device_restore ok".into());
        }
        GpuReloadPlan::AbiBreaking => {
            steps.extend([GpuReloadStep::ColdReload, GpuReloadStep::DeviceOnLoad]);
            logs.push("[gpu-reload] cold_reload reason=abi_breaking".into());
            logs.push("[gpu-reload] device_on_load invoked".into());
        }
    }

    let rollback_required = input.matched_kernel_hashes < input.expected_kernel_hashes;
    if rollback_required {
        steps.push(GpuReloadStep::Rollback);
        logs.push(format!(
            "[gpu-reload] step=verify sig_match={}/{} mismatch rollback",
            input.matched_kernel_hashes, input.expected_kernel_hashes
        ));
    }

    GpuReloadReport {
        plan: input.plan,
        selected_tier: tier,
        steps,
        log_lines: logs,
        state_preserved: !rollback_required && input.plan != GpuReloadPlan::HostOnly,
        requires_cold_restart: false,
        rollback_required,
    }
}

fn append_device_swap(
    steps: &mut Vec<GpuReloadStep>,
    logs: &mut Vec<String>,
    config: &GpuReloadConfig,
    input: &GpuSwapInputs,
    tier: SnapshotTier,
) {
    steps.extend([
        GpuReloadStep::Drain,
        GpuReloadStep::Save,
        GpuReloadStep::Unload,
        GpuReloadStep::Load,
        GpuReloadStep::Restore,
        GpuReloadStep::Verify,
    ]);
    logs.push(format!(
        "[gpu-reload] step=drain   streams_synced={}  ms=0",
        input.streams_synced
    ));
    logs.push(format!(
        "[gpu-reload] step=save    tier={}  buffers={}  bytes={}",
        tier.as_str(),
        input.dirty_buffers,
        input.snapshot_bytes
    ));
    logs.push("[gpu-reload] step=unload  module=retired".into());
    logs.push("[gpu-reload] step=load    module=standby".into());
    logs.push(format!(
        "[gpu-reload] step=restore bufs_replayed={}  bytes={}",
        input.dirty_buffers, input.snapshot_bytes
    ));
    logs.push(format!(
        "[gpu-reload] step=verify  sig_match={}/{}  ok",
        input.matched_kernel_hashes, input.expected_kernel_hashes
    ));
    logs.push(format!(
        "gpu_snapshot_telemetry snapshot_tier={} snapshot_ms={} snapshot_bytes={} budget_ms={}",
        tier.short_label(),
        input.snapshot_ms,
        input.snapshot_bytes,
        config.snapshot_budget_ms
    ));
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_only_runs_fast_swap_sequence() {
        let cfg = GpuReloadConfig {
            requested_snapshot_mode: SnapshotMode::Userspace,
            ..Default::default()
        };
        let report = plan_gpu_reload(&cfg, GpuSwapInputs::device_only("device-file-only-edit"));
        assert_eq!(report.plan, GpuReloadPlan::DeviceOnly);
        assert!(report
            .step_sequence()
            .contains("drain -> save -> unload -> load -> restore -> verify"));
        assert!(report
            .log_lines
            .iter()
            .any(|l| l.contains("plan=device_only")));
        assert!(report
            .log_lines
            .iter()
            .any(|l| l.contains("gpu_snapshot_telemetry")));
    }

    #[test]
    fn mixed_plan_wraps_host_swap_between_device_save_and_restore() {
        let cfg = GpuReloadConfig {
            requested_snapshot_mode: SnapshotMode::Userspace,
            ..Default::default()
        };
        let mut input = GpuSwapInputs::device_only("mixed-edit");
        input.plan = GpuReloadPlan::Mixed;
        let report = plan_gpu_reload(&cfg, input);
        let seq = report.step_sequence();
        assert!(seq.starts_with("device_save -> host_swap -> drain"));
        assert!(seq.ends_with("verify -> device_restore"));
        assert!(report
            .log_lines
            .iter()
            .any(|l| l.contains("device_restore ok")));
    }

    #[test]
    fn abi_breaking_cold_reloads_and_invokes_device_on_load() {
        let cfg = GpuReloadConfig::default();
        let mut input = GpuSwapInputs::device_only("signature-changed");
        input.plan = GpuReloadPlan::AbiBreaking;
        let report = plan_gpu_reload(&cfg, input);
        assert_eq!(
            report.steps,
            vec![GpuReloadStep::ColdReload, GpuReloadStep::DeviceOnLoad]
        );
        assert!(report
            .log_lines
            .iter()
            .any(|l| l.contains("device_on_load invoked")));
    }

    #[test]
    fn drain_timeout_requires_cold_restart() {
        let cfg = GpuReloadConfig::default();
        let mut input = GpuSwapInputs::device_only("hang");
        input.force_drain_timeout = true;
        let report = plan_gpu_reload(&cfg, input);
        assert!(report.requires_cold_restart);
        assert!(report
            .log_lines
            .iter()
            .any(|l| l.contains("kernel-hang-detected")));
    }

    #[test]
    fn signature_mismatch_requests_rollback() {
        let cfg = GpuReloadConfig {
            requested_snapshot_mode: SnapshotMode::Userspace,
            ..Default::default()
        };
        let mut input = GpuSwapInputs::device_only("verify-mismatch");
        input.expected_kernel_hashes = 2;
        input.matched_kernel_hashes = 1;
        let report = plan_gpu_reload(&cfg, input);
        assert!(report.rollback_required);
        assert!(report.steps.contains(&GpuReloadStep::Rollback));
    }
}
