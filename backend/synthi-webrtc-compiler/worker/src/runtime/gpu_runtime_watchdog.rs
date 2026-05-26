// ============================================================
// GPU RUNTIME WATCHDOG (GPU_HMR_ULTRAPLAN Phase 3)
// ============================================================
//
// CPU-only event model for GPU launch monitoring. The host runner can
// feed launch/complete notifications into this tracker; when a launch
// exceeds the configured budget it emits a gpu_runtime_error event with
// kind=stream_hang / STREAM_HANG.

#![cfg(feature = "gpu-hmr")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuRuntimeErrorKind {
    IllegalAddress,
    MisalignedAddress,
    LaunchTimeout,
    Assert,
    InvalidPc,
    LaunchFailure,
    InvalidConfiguration,
    StreamHang,
    Unknown,
}

impl GpuRuntimeErrorKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::IllegalAddress => "illegal_address",
            Self::MisalignedAddress => "misaligned_address",
            Self::LaunchTimeout => "launch_timeout",
            Self::Assert => "assert",
            Self::InvalidPc => "invalid_pc",
            Self::LaunchFailure => "launch_failure",
            Self::InvalidConfiguration => "invalid_configuration",
            Self::StreamHang => "stream_hang",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_runtime_status(raw: &str) -> Self {
        let normalized = raw
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric())
            .flat_map(|ch| ch.to_lowercase())
            .collect::<String>();
        if normalized.contains("illegaladdress") {
            Self::IllegalAddress
        } else if normalized.contains("misalignedaddress") {
            Self::MisalignedAddress
        } else if normalized.contains("launchtimeout") {
            Self::LaunchTimeout
        } else if normalized.contains("assert") {
            Self::Assert
        } else if normalized.contains("invalidpc") {
            Self::InvalidPc
        } else if normalized.contains("launchfailure") {
            Self::LaunchFailure
        } else if normalized.contains("invalidconfiguration") {
            Self::InvalidConfiguration
        } else {
            Self::Unknown
        }
    }

    pub fn requires_context_restart(&self) -> bool {
        matches!(
            self,
            Self::IllegalAddress
                | Self::MisalignedAddress
                | Self::LaunchTimeout
                | Self::Assert
                | Self::InvalidPc
                | Self::LaunchFailure
                | Self::StreamHang
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuRuntimeErrorEvent {
    pub event_type: String,
    pub kind: GpuRuntimeErrorKind,
    pub kernel: String,
    pub stream_id: u64,
    pub elapsed_ms: u64,
    pub watchdog_ms: u64,
    pub requires_context_restart: bool,
}

impl GpuRuntimeErrorEvent {
    pub fn from_runtime_status(
        kernel: impl Into<String>,
        stream_id: u64,
        raw_status: &str,
        elapsed_ms: u64,
        watchdog_ms: u64,
    ) -> Self {
        let kind = GpuRuntimeErrorKind::from_runtime_status(raw_status);
        let requires_context_restart = kind.requires_context_restart();
        Self {
            event_type: "gpu_runtime_error".into(),
            kind,
            kernel: kernel.into(),
            stream_id,
            elapsed_ms,
            watchdog_ms,
            requires_context_restart,
        }
    }

    pub fn log_marker(&self) -> String {
        match self.kind {
            GpuRuntimeErrorKind::StreamHang => format!(
                "gpu_runtime_error kind=stream_hang STREAM_HANG kernel={} stream={} elapsed_ms={}",
                self.kernel, self.stream_id, self.elapsed_ms
            ),
            _ => format!(
                "gpu_runtime_error kind={} kernel={} stream={} elapsed_ms={}",
                self.kind.as_str(),
                self.kernel,
                self.stream_id,
                self.elapsed_ms
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingLaunch {
    kernel: String,
    stream_id: u64,
    started_at_ms: u64,
}

#[derive(Debug, Clone)]
pub struct GpuLaunchWatchdog {
    watchdog_ms: u64,
    pending: HashMap<u64, PendingLaunch>,
}

impl GpuLaunchWatchdog {
    pub fn new(watchdog_ms: u64) -> Self {
        Self {
            watchdog_ms,
            pending: HashMap::new(),
        }
    }

    pub fn from_env() -> Self {
        let watchdog_ms = std::env::var("SYNTHI_GPU_LAUNCH_WATCHDOG_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(5_000);
        Self::new(watchdog_ms)
    }

    pub fn observe_launch(
        &mut self,
        launch_id: u64,
        kernel: impl Into<String>,
        stream_id: u64,
        now_ms: u64,
    ) {
        self.pending.insert(
            launch_id,
            PendingLaunch {
                kernel: kernel.into(),
                stream_id,
                started_at_ms: now_ms,
            },
        );
    }

    pub fn mark_complete(&mut self, launch_id: u64) {
        self.pending.remove(&launch_id);
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    pub fn poll_hangs(&mut self, now_ms: u64) -> Vec<GpuRuntimeErrorEvent> {
        let mut hung = Vec::new();
        let mut remove_ids = Vec::new();
        for (launch_id, launch) in &self.pending {
            let elapsed = now_ms.saturating_sub(launch.started_at_ms);
            if elapsed >= self.watchdog_ms {
                hung.push(GpuRuntimeErrorEvent {
                    event_type: "gpu_runtime_error".into(),
                    kind: GpuRuntimeErrorKind::StreamHang,
                    kernel: launch.kernel.clone(),
                    stream_id: launch.stream_id,
                    elapsed_ms: elapsed,
                    watchdog_ms: self.watchdog_ms,
                    requires_context_restart: true,
                });
                remove_ids.push(*launch_id);
            }
        }
        for id in remove_ids {
            self.pending.remove(&id);
        }
        hung
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watchdog_emits_stream_hang_after_budget() {
        let mut w = GpuLaunchWatchdog::new(5_000);
        w.observe_launch(1, "vec_add", 7, 1_000);
        let events = w.poll_hangs(6_001);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, GpuRuntimeErrorKind::StreamHang);
        assert!(events[0].requires_context_restart);
        assert!(events[0].log_marker().contains("STREAM_HANG"));
        assert_eq!(w.pending_count(), 0);
    }

    #[test]
    fn completed_launch_does_not_emit() {
        let mut w = GpuLaunchWatchdog::new(100);
        w.observe_launch(1, "k", 0, 0);
        w.mark_complete(1);
        assert!(w.poll_hangs(1_000).is_empty());
    }

    #[test]
    fn nonfatal_error_kind_does_not_require_restart() {
        assert!(!GpuRuntimeErrorKind::InvalidConfiguration.requires_context_restart());
        assert!(GpuRuntimeErrorKind::IllegalAddress.requires_context_restart());
    }

    #[test]
    fn runtime_status_classifier_maps_vendor_faults() {
        let cases = [
            (
                "cudaErrorIllegalAddress",
                GpuRuntimeErrorKind::IllegalAddress,
                true,
            ),
            (
                "hipErrorMisalignedAddress",
                GpuRuntimeErrorKind::MisalignedAddress,
                true,
            ),
            (
                "cudaErrorLaunchTimeout",
                GpuRuntimeErrorKind::LaunchTimeout,
                true,
            ),
            ("cudaErrorAssert", GpuRuntimeErrorKind::Assert, true),
            ("cudaErrorInvalidPc", GpuRuntimeErrorKind::InvalidPc, true),
            (
                "cudaErrorLaunchFailure",
                GpuRuntimeErrorKind::LaunchFailure,
                true,
            ),
            (
                "cudaErrorInvalidConfiguration",
                GpuRuntimeErrorKind::InvalidConfiguration,
                false,
            ),
        ];

        for (raw, expected, restart) in cases {
            let event = GpuRuntimeErrorEvent::from_runtime_status("kernel", 1, raw, 9, 5_000);
            assert_eq!(event.kind, expected, "{raw}");
            assert_eq!(event.requires_context_restart, restart, "{raw}");
            assert!(event.log_marker().contains(expected.as_str()));
        }
    }
}
