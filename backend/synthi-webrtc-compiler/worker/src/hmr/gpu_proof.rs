use serde::{Deserialize, Serialize};

pub const GPU_HMR_PROOF_SCHEMA_VERSION: &str = "synthi.gpu.hmr.proof.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GpuHmrProofState {
    CompileProven,
    SymbolBound,
    AbiProven,
    DispatchProven,
    OutputProven,
    HostPreservationProven,
    FullRuntimeProven,
}

impl GpuHmrProofState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CompileProven => "gpu-hmr-compile-proven",
            Self::SymbolBound => "gpu-hmr-symbol-bound",
            Self::AbiProven => "gpu-hmr-abi-proven",
            Self::DispatchProven => "gpu-hmr-dispatch-proven",
            Self::OutputProven => "gpu-hmr-output-proven",
            Self::HostPreservationProven => "gpu-hmr-host-preservation-proven",
            Self::FullRuntimeProven => "gpu-hmr-full-runtime-proven",
        }
    }

    pub fn rank(self) -> u8 {
        match self {
            Self::CompileProven => 1,
            Self::SymbolBound => 2,
            Self::AbiProven => 3,
            Self::DispatchProven => 4,
            Self::OutputProven => 5,
            Self::HostPreservationProven => 6,
            Self::FullRuntimeProven => 7,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GpuHmrDegradedState {
    FakeLaunchPath,
    UnknownArgProvenance,
    AbiUnverified,
    DispatchUnobserved,
    OutputUnobserved,
    HostReplaced,
    VisualOnly,
}

impl GpuHmrDegradedState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FakeLaunchPath => "gpu-hmr-fake-launch-path",
            Self::UnknownArgProvenance => "gpu-hmr-unknown-arg-provenance",
            Self::AbiUnverified => "gpu-hmr-abi-unverified",
            Self::DispatchUnobserved => "gpu-hmr-dispatch-unobserved",
            Self::OutputUnobserved => "gpu-hmr-output-unobserved",
            Self::HostReplaced => "gpu-hmr-host-replaced",
            Self::VisualOnly => "gpu-hmr-visual-only",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuHmrProofTelemetry {
    #[serde(rename = "schemaVersion")]
    pub schema_version: &'static str,
    #[serde(rename = "resultState")]
    pub result_state: String,
    #[serde(rename = "degradedState", skip_serializing_if = "Option::is_none")]
    pub degraded_state: Option<String>,
    #[serde(rename = "degradedReason", skip_serializing_if = "Option::is_none")]
    pub degraded_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl GpuHmrProofTelemetry {
    pub fn new(
        result_state: GpuHmrProofState,
        degraded_state: Option<GpuHmrDegradedState>,
        degraded_reason: Option<String>,
        label: Option<String>,
    ) -> Self {
        Self {
            schema_version: GPU_HMR_PROOF_SCHEMA_VERSION,
            result_state: result_state.as_str().to_string(),
            degraded_state: degraded_state.map(GpuHmrDegradedState::as_str).map(str::to_string),
            degraded_reason,
            label,
        }
    }

    pub fn to_log_line(&self) -> String {
        serde_json::json!({
            "type": "gpu_hmr_proof",
            "schemaVersion": self.schema_version,
            "resultState": self.result_state,
            "degradedState": self.degraded_state,
            "degradedReason": self.degraded_reason,
            "label": self.label,
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_state_names_match_runtime_correctness_contract() {
        assert_eq!(
            GpuHmrProofState::CompileProven.as_str(),
            "gpu-hmr-compile-proven"
        );
        assert_eq!(
            GpuHmrProofState::DispatchProven.as_str(),
            "gpu-hmr-dispatch-proven"
        );
        assert_eq!(
            GpuHmrProofState::FullRuntimeProven.as_str(),
            "gpu-hmr-full-runtime-proven"
        );
        assert!(GpuHmrProofState::FullRuntimeProven.rank() > GpuHmrProofState::SymbolBound.rank());
    }

    #[test]
    fn degraded_state_names_match_runtime_correctness_contract() {
        assert_eq!(
            GpuHmrDegradedState::FakeLaunchPath.as_str(),
            "gpu-hmr-fake-launch-path"
        );
        assert_eq!(
            GpuHmrDegradedState::UnknownArgProvenance.as_str(),
            "gpu-hmr-unknown-arg-provenance"
        );
        assert_eq!(
            GpuHmrDegradedState::VisualOnly.as_str(),
            "gpu-hmr-visual-only"
        );
    }

    #[test]
    fn telemetry_log_line_is_machine_parseable() {
        let telemetry = GpuHmrProofTelemetry::new(
            GpuHmrProofState::SymbolBound,
            Some(GpuHmrDegradedState::DispatchUnobserved),
            Some("runtime_dispatch_not_observed".to_string()),
            Some("gpu-hmr-partial".to_string()),
        );
        let line = telemetry.to_log_line();
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["type"], "gpu_hmr_proof");
        assert_eq!(value["schemaVersion"], "synthi.gpu.hmr.proof.v1");
        assert_eq!(value["resultState"], "gpu-hmr-symbol-bound");
        assert_eq!(value["degradedState"], "gpu-hmr-dispatch-unobserved");
        assert_eq!(value["label"], "gpu-hmr-partial");
    }
}
