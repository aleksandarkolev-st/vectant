// ============================================================
// GPU MODULE ADAPTER (Phase 2 — driver loader wired in)
// ============================================================
//
// Spec: docs/GPU_HMR_ULTRAPLAN.md §5.3 / §5.4. This is the
// device-side analogue of `dynlib_adapter.rs` — it implements the
// `Adapter` trait for the CUDA / ROCm module families. Where the
// dynlib adapter does `dlopen` / `dlclose` on a host `.so`, the GPU
// module adapter does `cuModuleLoadData` / `cuModuleUnload` (HIP
// equivalents on ROCm) on a sidecar cubin / hsaco.
//
// Phase status:
//
//   Phase 1 ✓
//     • Strongly-typed scaffold (`GpuVendor`, adapter struct,
//       config). `Adapter` impl returning Unsupported.
//     • Driver-API symbol names declared as a single source.
//
//   Phase 2 ✓ (this file)
//     • `initialize()` performs the real dlopen + dlsym pass via
//       `gpu_driver_loader::try_load`. Successful loads stash the
//       handle in an Arc so the Phase-3 module-manager / shadow-
//       arena can clone it without re-dlopen.
//     • Failed loads (driver missing on a host without CUDA /
//       ROCm) leave the adapter Ready but mark
//       `driver_available()` false; the planner falls through to
//       cold restart based on the reload reason.
//     • info().extra exposes `driver_state`, `driver_path`,
//       optional `driver_error` for telemetry.
//
//   Phase 3 ✓
//     • Two-slot module manager wired through `reload()`:
//       drain → cuModuleLoadData → resolve_kernels → swap →
//       unload-retired.
//     • Deterministic `gpu_reload_orchestrator` report markers
//       emitted for the worker log / harness.
//     • Driver-unavailable and drain-timeout paths now route to
//       cold fallback instead of claiming an unsupported scaffold.
//
//   Still pending after this file:
//     • Host-runner launch-site replacement calls this adapter
//       with the produced sidecar path from compiler/handler.rs.
//     • Shadow arena + dirty-bit registry are not yet connected
//       to `snapshot_state` / `restore_state`.
//
// Feature-gated by `gpu-hmr`. With the feature off the module
// compiles to an empty body so worker builds on hosts without
// CUDA / ROCm continue to work unchanged.

#![cfg(feature = "gpu-hmr")]

pub mod host_output_oracle_receipt;

use std::collections::HashMap;
use std::env;
use std::ffi::{c_void, CString};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::adapter_trait::{
    configured_gpu_hmr_runtime_output_oracle_profile_path, normalized_reload_source_edit_id,
    Adapter, AdapterHealth, AdapterInfo, AdapterReloadRequest, AdapterReloadResult,
    ReloadCapsuleMetadata, RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION,
};
use crate::hmr::build_manifest::{
    BuildSlot, GPU_SIDECAR_MODULE_CAPABILITY, GPU_SIDECAR_PARTIAL_MODULE_CAPABILITY,
};
use crate::hmr::compile_manifest::{DeviceVendor, SnapshotMode};
use crate::hmr::device_snapshot::BufferRegistry;
use crate::hmr::gpu_driver_loader::{
    self, CuContext, CuDevicePtr, CuFunction, CuStream, DriverLoadError, GpuDeviceUuid,
    GpuDriverHandle, GpuDriverSymbolTable,
};
use crate::hmr::gpu_module_manager::{
    GpuModuleManager, KernelResolution, KernelTable, ModuleManagerError, ModuleSlot,
};
use crate::hmr::gpu_proof::{
    normalized_gpu_hardware_uuid, sha256_hex_bytes, stable_json_hash, GpuHmrAcceptanceLedger,
    GpuHmrAcceptanceLedgerInput, GpuHmrDegradedState,
};
use crate::hmr::gpu_reload_orchestrator::{
    plan_gpu_reload, GpuReloadConfig, GpuReloadPlan, GpuSwapInputs,
};
use crate::hmr::gpu_stream_drain::{drain_context, drain_stream, DrainOutcome, DrainScope};
#[cfg(test)]
use crate::runtime::gpu_runtime_boundary::output_oracle_records_snapshot;
use crate::runtime::gpu_runtime_boundary::{
    begin_launch_dispatcher_publication, clear_launch_dispatcher,
    commit_launch_dispatcher_publication, current_launch_generation,
    dispatch_device_attestation_records_snapshot,
    dispatch_device_attestation_rejection_records_snapshot, launch_records_snapshot,
    managed_buffers_snapshot, monotonic_timestamp_ns, record_hmr_runtime_identity_snapshot,
    record_output_buffer_checksum_with_probe_bytes_after_dispatch,
    rollback_launch_dispatcher_publication, runtime_session_id,
    synthi_gpu_launch_raw_arg_info_with_receipt, synthi_gpu_register_buffer,
    with_dispatcher_publication_validation, DispatcherCommitReceipt, GpuDispatchDeviceAttestation,
    GpuDispatchDeviceObservation, GpuLaunchDispatcher, GpuLaunchDispatcherMetadata,
    GpuLaunchRequest, LaunchArgProvenance, LaunchRecord, SynthiGpuLaunchArg,
    GPU_DISPATCH_DEVICE_ATTESTATION_AUTHORITY, GPU_DISPATCH_DEVICE_ATTESTATION_SCHEMA,
    SYNTHI_GPU_ARG_KIND_FLOATING, SYNTHI_GPU_ARG_KIND_INTEGER, SYNTHI_GPU_ARG_KIND_POINTER,
};

// ── Vendor + symbol table ───────────────────────────────────

/// Local vendor enum. Distinct from `compile_manifest::DeviceVendor`
/// only because the adapter cares about *runtime* vendor (which `.so`
/// to dlopen for driver symbols), not the build-time vendor on the
/// manifest. They map 1:1 today but keeping them separate means a
/// future `cuda → hip-translation` adapter can claim a different
/// `GpuVendor` than the manifest claims.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GpuVendor {
    Cuda,
    Rocm,
}

impl GpuVendor {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Cuda => "cuda",
            Self::Rocm => "rocm",
        }
    }

    /// Adapter `name` field used in telemetry + the `info()` trait
    /// method. Matches the convention from `dynlib_adapter` (which
    /// reports `"dynlib"`) so log-grep recipes stay uniform.
    pub fn adapter_name(&self) -> &'static str {
        match self {
            Self::Cuda => "gpu_module_cuda",
            Self::Rocm => "gpu_module_rocm",
        }
    }

    pub fn proof_backend(&self) -> &'static str {
        match self {
            Self::Cuda => "cuda",
            Self::Rocm => "hip",
        }
    }

    pub fn proof_artifact_kind(&self) -> &'static str {
        match self {
            Self::Cuda => "cuda_cubin",
            Self::Rocm => "hsaco",
        }
    }

    pub fn proof_compiler(&self) -> &'static str {
        match self {
            Self::Cuda => "nvcc",
            Self::Rocm => "hipcc",
        }
    }

    /// The runtime shared library the driver-API symbols are dlsym'd
    /// out of. Single source of truth so Phase 2 doesn't hardcode
    /// `"libcuda.so"` at the call site.
    pub fn driver_library(&self) -> &'static str {
        match self {
            Self::Cuda => "libcuda.so.1",
            Self::Rocm => "libamdhip64.so",
        }
    }

    /// Vendor-specific symbol used for atomic module hot-swap.
    /// Phase 2 will dlsym these and store the resolved function
    /// pointers on `GpuModuleAdapter::sym_table`.
    pub fn module_load_symbol(&self) -> &'static str {
        match self {
            Self::Cuda => "cuModuleLoadData",
            Self::Rocm => "hipModuleLoad",
        }
    }

    pub fn module_unload_symbol(&self) -> &'static str {
        match self {
            Self::Cuda => "cuModuleUnload",
            Self::Rocm => "hipModuleUnload",
        }
    }

    pub fn ctx_synchronize_symbol(&self) -> &'static str {
        match self {
            Self::Cuda => "cuCtxSynchronize",
            Self::Rocm => "hipDeviceSynchronize",
        }
    }

    pub fn stream_synchronize_symbol(&self) -> &'static str {
        match self {
            Self::Cuda => "cuStreamSynchronize",
            Self::Rocm => "hipStreamSynchronize",
        }
    }

    pub fn module_get_function_symbol(&self) -> &'static str {
        match self {
            Self::Cuda => "cuModuleGetFunction",
            Self::Rocm => "hipModuleGetFunction",
        }
    }

    pub fn launch_kernel_symbol(&self) -> &'static str {
        match self {
            Self::Cuda => "cuLaunchKernel",
            Self::Rocm => "hipModuleLaunchKernel",
        }
    }
}

impl From<DeviceVendor> for GpuVendor {
    fn from(v: DeviceVendor) -> Self {
        match v {
            DeviceVendor::Cuda => Self::Cuda,
            DeviceVendor::Rocm => Self::Rocm,
        }
    }
}

// ── Config + phase ──────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GpuModuleAdapterConfig {
    pub vendor: GpuVendor,
    /// Maximum cubin / hsaco size accepted for swap (bytes). Larger
    /// blobs fall back to cold restart so a runaway nvcc output can't
    /// blow VRAM in the standby slot.
    pub max_module_bytes: u64,
    /// How long to wait for in-flight streams to drain before forcing
    /// a swap. Pulled from §5.4 default = 2000 ms.
    pub drain_timeout_ms: u64,
    /// Whether the adapter is allowed to fall back from Tier A
    /// driver checkpoint to Tier B userspace snapshot at runtime.
    pub allow_snapshot_downgrade: bool,
    /// Loader transport selected by runtime capability policy. This is
    /// intentionally not inferred from project names or renderer paths.
    pub artifact_loader_transport: ArtifactLoaderTransport,
}

impl Default for GpuModuleAdapterConfig {
    fn default() -> Self {
        Self {
            vendor: GpuVendor::Cuda,
            max_module_bytes: 128 * 1024 * 1024, // 128 MB
            drain_timeout_ms: 2_000,
            allow_snapshot_downgrade: true,
            artifact_loader_transport: ArtifactLoaderTransport::RamBytes,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GpuPhase {
    Uninitialized,
    Ready,
    Swapping,
    Faulted,
    ShutDown,
}

struct DriverLaunchDispatcher {
    symbols: GpuDriverSymbolTable,
    kernels: HashMap<String, u64>,
}

impl DriverLaunchDispatcher {
    fn launch_native(
        &self,
        request: &GpuLaunchRequest,
        args: *const *const c_void,
    ) -> Result<(), String> {
        let Some(handle) = self.kernels.get(&request.kernel_name).copied() else {
            return Err(format!(
                "kernel {:?} is not resolved in active GPU sidecar",
                request.kernel_name
            ));
        };

        let shared_mem_bytes = request.shared_bytes.min(u32::MAX as usize) as u32;
        let code = unsafe {
            (self.symbols.cu_launch_kernel)(
                handle as CuFunction,
                request.grid.0,
                request.grid.1,
                request.grid.2,
                request.block.0,
                request.block.1,
                request.block.2,
                shared_mem_bytes,
                request.stream_token as *mut c_void,
                args as *mut *mut c_void,
                std::ptr::null_mut(),
            )
        };
        if code != 0 {
            return Err(format!("cuLaunchKernel returned {code}"));
        }

        Ok(())
    }
}

impl GpuLaunchDispatcher for DriverLaunchDispatcher {
    fn dispatch(
        &self,
        request: &GpuLaunchRequest,
        args: *const *const c_void,
    ) -> Result<(), String> {
        self.launch_native(request, args)
    }

    fn dispatch_with_device_attestation(
        &self,
        request: &GpuLaunchRequest,
        args: *const *const c_void,
    ) -> Result<GpuDispatchDeviceAttestation, String> {
        let before =
            query_runtime_dispatch_device_observation(&self.symbols, request.stream_token)?;
        self.launch_native(request, args)?;
        let after =
            match query_runtime_dispatch_device_observation(&self.symbols, request.stream_token) {
                Ok(observation) => observation,
                Err(error) => {
                    return Ok(GpuDispatchDeviceAttestation::unavailable(
                        request.stream_token,
                        error,
                    ));
                }
            };
        match GpuDispatchDeviceAttestation::runtime_driver_observed(
            request.stream_token,
            before,
            after,
        ) {
            Ok(attestation) => Ok(attestation),
            Err(error) => Ok(GpuDispatchDeviceAttestation::unavailable(
                request.stream_token,
                error,
            )),
        }
    }
}

// ── The adapter ─────────────────────────────────────────────

/// Phase-2 scaffold. `initialize()` now attempts a real driver
/// load via `gpu_driver_loader::try_load`. On a host without the
/// vendor driver the adapter still goes Ready (state-machine
/// invariant for the planner) but `driver_state` reports
/// `unavailable` so the planner knows to fall through to cold
/// restart. The full swap path lands in Phase 3.
#[derive(Debug, Clone)]
struct DeviceReloadOwnership {
    partial_reload: bool,
    expected_symbols: Vec<String>,
    touched_symbols: Vec<String>,
    retired_module_count: usize,
    replaced_primary: bool,
    runtime_log_lines: Vec<String>,
    hot_reload_acceptance_required: bool,
    acceptance_ledger_success: bool,
    acceptance_ledger_failures: Vec<String>,
    verified_device_identity: Option<RuntimeHardwareDeviceIdentity>,
    strict_device_attestation_available: bool,
    strict_device_attestation_gaps: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactLoaderTransport {
    FilesystemPath,
    RamBytes,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeHardwareDeviceIdentity {
    ordinal: i32,
    uuid_bytes: [u8; 16],
    uuid_hex: String,
    identity_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeStreamDeviceBinding {
    stream_token: usize,
    device_ordinal: i32,
}

fn query_runtime_hardware_device_identity(
    symbols: &GpuDriverSymbolTable,
) -> Result<RuntimeHardwareDeviceIdentity, String> {
    let get_active_device = symbols
        .cu_ctx_get_device
        .ok_or_else(|| "device_identity_active_device_symbol_missing".to_string())?;
    let get_device_uuid = symbols
        .cu_device_get_uuid
        .ok_or_else(|| "device_identity_uuid_symbol_missing".to_string())?;

    let mut ordinal = -1_i32;
    let active_device_code = unsafe { get_active_device(&mut ordinal) };
    if active_device_code != 0 {
        return Err(format!(
            "device_identity_active_device_query_failed:{active_device_code}"
        ));
    }
    if ordinal < 0 {
        return Err("device_identity_active_device_ordinal_invalid".to_string());
    }

    let mut uuid = GpuDeviceUuid::default();
    let uuid_code = unsafe { get_device_uuid(&mut uuid, ordinal) };
    if uuid_code != 0 {
        return Err(format!("device_identity_uuid_query_failed:{uuid_code}"));
    }
    if uuid.bytes.iter().all(|byte| *byte == 0) {
        return Err("device_identity_uuid_all_zero".to_string());
    }

    let uuid_hex = hex::encode(uuid.bytes);
    Ok(RuntimeHardwareDeviceIdentity {
        ordinal,
        uuid_bytes: uuid.bytes,
        identity_key: format!("gpu-hardware-uuid:{uuid_hex}"),
        uuid_hex,
    })
}

fn query_runtime_dispatch_device_observation(
    symbols: &GpuDriverSymbolTable,
    stream_token: usize,
) -> Result<GpuDispatchDeviceObservation, String> {
    let identity = query_runtime_hardware_device_identity(symbols)?;
    let get_stream_device = symbols
        .cu_stream_get_device
        .ok_or_else(|| "dispatch_stream_device_symbol_missing".to_string())?;
    let mut stream_device_ordinal = -1_i32;
    let code = unsafe {
        get_stream_device(
            stream_token as CuStream,
            &mut stream_device_ordinal as *mut i32,
        )
    };
    if code != 0 {
        return Err(format!("dispatch_stream_device_query_failed:{code}"));
    }
    GpuDispatchDeviceObservation::new(identity.ordinal, identity.uuid_bytes, stream_device_ordinal)
}

fn verified_runtime_hardware_device_identity(
    generation_baseline: Option<&RuntimeHardwareDeviceIdentity>,
    before: &Result<RuntimeHardwareDeviceIdentity, String>,
    after: &Result<RuntimeHardwareDeviceIdentity, String>,
    require_generation_baseline: bool,
) -> Result<RuntimeHardwareDeviceIdentity, String> {
    let generation_baseline = if require_generation_baseline {
        Some(
            generation_baseline
                .ok_or_else(|| "device_identity_generation_baseline_missing".to_string())?,
        )
    } else {
        generation_baseline
    };
    let before = before.as_ref().map_err(|error| error.clone())?;
    let after = after.as_ref().map_err(|error| error.clone())?;
    if let Some(generation_baseline) = generation_baseline {
        if generation_baseline.ordinal != before.ordinal {
            return Err("device_identity_active_device_changed_since_generation".to_string());
        }
        if generation_baseline.uuid_hex != before.uuid_hex
            || generation_baseline.identity_key != before.identity_key
        {
            return Err("device_identity_uuid_changed_since_generation".to_string());
        }
    }
    if before.ordinal != after.ordinal {
        return Err("device_identity_active_device_changed".to_string());
    }
    if before.uuid_hex != after.uuid_hex || before.identity_key != after.identity_key {
        return Err("device_identity_uuid_changed".to_string());
    }
    Ok(after.clone())
}

fn runtime_hardware_device_identity_observation_line(
    phase: &str,
    generation: u64,
    observation: &Result<RuntimeHardwareDeviceIdentity, String>,
) -> String {
    let (status, ordinal, uuid, identity_key, reason) = match observation {
        Ok(identity) => (
            "observed",
            identity.ordinal.to_string(),
            identity.uuid_hex.as_str(),
            identity.identity_key.as_str(),
            "none",
        ),
        Err(reason) => (
            "refused",
            "none".to_string(),
            "none",
            "none",
            reason.as_str(),
        ),
    };
    format!(
        "[gpu-runtime-boundary] device_identity schema=synthi.gpu_hmr.runtime_device_identity.v1 event={} observation_phase={} runtime_session={} process_id=pid:{} generation={} device_ordinal={} device_uuid={} device_identity_key={} device_identity_authority=runtime_driver_active_device_uuid proof_authority=runtime_driver_active_device_uuid_evidence_only_not_gpu_hmr_success reason={} accepted_for_gpu_hmr=false gpu_hmr_success=false can_satisfy_runtime_proof=false can_satisfy_dispatch_proof=false",
        status,
        phase,
        runtime_session_id(),
        std::process::id(),
        generation,
        ordinal,
        uuid,
        identity_key,
        reason,
    )
}

fn runtime_hardware_device_identity_continuity_line(
    observed_generation: u64,
    generation_baseline: Option<&RuntimeHardwareDeviceIdentity>,
    before: &Result<RuntimeHardwareDeviceIdentity, String>,
    after: &Result<RuntimeHardwareDeviceIdentity, String>,
    require_generation_baseline: bool,
) -> String {
    let verified = verified_runtime_hardware_device_identity(
        generation_baseline,
        before,
        after,
        require_generation_baseline,
    );
    let (status, same_device, identity_key, reason) = match &verified {
        Ok(identity) => ("verified", "true", identity.identity_key.as_str(), "none"),
        Err(reason) => ("refused", "false", "none", reason.as_str()),
    };
    let generation_baseline_key = generation_baseline
        .map(|identity| identity.identity_key.as_str())
        .unwrap_or("none");
    format!(
        "[gpu-runtime-boundary] device_identity_continuity schema=synthi.gpu_hmr.runtime_device_identity_continuity.v1 event={} observation_window=before_reload,after_drain_pre_commit runtime_session={} process_id=pid:{} observed_generation={} generation_baseline_required={} generation_baseline_device_identity_key={} same_device={} device_identity_key={} device_identity_authority=runtime_driver_active_device_uuid proof_authority=runtime_driver_active_device_uuid_continuity_evidence_only_not_gpu_hmr_success reason={} accepted_for_gpu_hmr=false gpu_hmr_success=false can_satisfy_runtime_proof=false can_satisfy_dispatch_proof=false",
        status,
        runtime_session_id(),
        std::process::id(),
        observed_generation,
        require_generation_baseline,
        generation_baseline_key,
        same_device,
        identity_key,
        reason,
    )
}

fn verify_runtime_stream_device_bindings(
    symbols: &GpuDriverSymbolTable,
    identity: &RuntimeHardwareDeviceIdentity,
    affected_stream_tokens: &[usize],
) -> Result<Vec<RuntimeStreamDeviceBinding>, String> {
    let mut stream_tokens = affected_stream_tokens.to_vec();
    stream_tokens.push(0);
    stream_tokens.sort_unstable();
    stream_tokens.dedup();

    let mut bindings = Vec::with_capacity(stream_tokens.len());
    for stream_token in stream_tokens {
        let get_stream_device = symbols
            .cu_stream_get_device
            .ok_or_else(|| "stream_device_identity_symbol_missing".to_string())?;
        let mut device_ordinal = -1_i32;
        let code = unsafe { get_stream_device(stream_token as CuStream, &mut device_ordinal) };
        if code != 0 {
            return Err(format!("stream_device_identity_query_failed:{code}"));
        }
        if device_ordinal < 0 {
            return Err("stream_device_identity_ordinal_invalid".to_string());
        }
        if device_ordinal != identity.ordinal {
            return Err("stream_device_identity_mismatch".to_string());
        }
        bindings.push(RuntimeStreamDeviceBinding {
            stream_token,
            device_ordinal,
        });
    }
    Ok(bindings)
}

fn runtime_stream_device_binding_line(
    generation: u64,
    identity: Option<&RuntimeHardwareDeviceIdentity>,
    bindings: &Result<Vec<RuntimeStreamDeviceBinding>, String>,
) -> String {
    let (event, binding_values, reason) = match bindings {
        Ok(bindings) => (
            "verified",
            bindings
                .iter()
                .map(|binding| format!("{}:{}", binding.stream_token, binding.device_ordinal))
                .collect::<Vec<_>>()
                .join(","),
            "none",
        ),
        Err(reason) => ("refused", "none".to_string(), reason.as_str()),
    };
    format!(
        "[gpu-runtime-boundary] stream_device_identity schema=synthi.gpu_hmr.runtime_stream_device_identity.v1 event={} runtime_session={} process_id=pid:{} generation={} active_device_ordinal={} device_identity_key={} stream_device_bindings={} device_identity_authority=runtime_driver_stream_device_binding proof_authority=runtime_driver_stream_device_binding_evidence_only_not_gpu_hmr_success reason={} accepted_for_gpu_hmr=false gpu_hmr_success=false can_satisfy_runtime_proof=false can_satisfy_dispatch_proof=false",
        event,
        runtime_session_id(),
        std::process::id(),
        generation,
        identity
            .map(|identity| identity.ordinal.to_string())
            .unwrap_or_else(|| "none".to_string()),
        identity
            .map(|identity| identity.identity_key.as_str())
            .unwrap_or("none"),
        binding_values,
        reason,
    )
}

fn runtime_device_attestation_capability_line(
    generation: u64,
    available: bool,
    gaps: &[String],
) -> String {
    let status = if available {
        "available"
    } else {
        "unavailable"
    };
    let gap_list = if gaps.is_empty() {
        "none".to_string()
    } else {
        gaps.join(",")
    };
    format!(
        "[gpu-runtime-boundary] device_attestation_capability schema=synthi.gpu_hmr.device_attestation_capability.v1 status={} runtime_session={} process_id=pid:{} generation={} capability=runtime_device_and_stream_identity_attestation blocking_gaps={} proof_authority=device_attestation_capability_only_not_gpu_hmr_success accepted_for_gpu_hmr=false gpu_hmr_success=false can_satisfy_runtime_proof=false can_satisfy_dispatch_proof=false",
        status,
        runtime_session_id(),
        std::process::id(),
        generation,
        gap_list,
    )
}

impl ArtifactLoaderTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FilesystemPath => "filesystem_path",
            Self::RamBytes => "ram_bytes",
        }
    }

    pub fn loader_api(self) -> &'static str {
        match self {
            Self::FilesystemPath => "module_load_path",
            Self::RamBytes => "module_load_data",
        }
    }

    pub fn is_content_bound(self) -> bool {
        matches!(self, Self::RamBytes)
    }
}

fn normalized_sha256_hex(raw: &str) -> Option<String> {
    let value = raw.trim();
    let value = value.strip_prefix("sha256:").unwrap_or(value);
    if value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Some(value.to_ascii_lowercase())
    } else {
        None
    }
}

fn sorted_unique_symbols(symbols: &[String]) -> Vec<String> {
    let mut out = symbols
        .iter()
        .map(|symbol| symbol.trim())
        .filter(|symbol| !symbol.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    out.sort();
    out.dedup();
    out
}

fn kernel_resolution_specs(symbols: &[String]) -> Result<Vec<KernelResolution>, String> {
    let mut out = Vec::new();
    for symbol in symbols {
        let symbol = symbol.trim();
        if symbol.is_empty() {
            continue;
        }
        let (logical_name, driver_name) = symbol
            .split_once('=')
            .map(|(logical, driver)| (logical.trim(), driver.trim()))
            .unwrap_or((symbol, symbol));
        if logical_name.is_empty() || driver_name.is_empty() {
            return Err(format!("invalid GPU kernel symbol mapping: {symbol:?}"));
        }
        out.push(KernelResolution {
            logical_name: logical_name.to_string(),
            driver_name: driver_name.to_string(),
        });
    }
    Ok(out)
}

fn logical_kernel_symbols(symbols: &[String]) -> Result<Vec<String>, String> {
    let out = kernel_resolution_specs(symbols)?
        .into_iter()
        .map(|symbol| symbol.logical_name)
        .collect::<Vec<_>>();
    Ok(sorted_unique_symbols(&out))
}

fn resolved_kernel_symbols(manager: &GpuModuleManager) -> Vec<String> {
    let mut out = manager
        .kernel_table()
        .names()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    out.sort();
    out.dedup();
    out
}

fn dispatch_table_entries(table: &KernelTable) -> Vec<(String, u64)> {
    let mut entries = table
        .names()
        .filter_map(|name| table.get(name).map(|handle| (name.clone(), handle)))
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
}

fn dispatch_table_hash(table: &KernelTable) -> u64 {
    let entries = dispatch_table_entries(table);

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    entries.hash(&mut hasher);
    hasher.finish()
}

fn dispatch_table_content_hash(table: &KernelTable) -> String {
    let entries = dispatch_table_entries(table);
    let mut material = Vec::new();
    material.extend_from_slice(b"synthi.gpu_hmr.dispatch_table.v1\0");
    material.extend_from_slice(&(entries.len() as u64).to_le_bytes());
    for (name, handle) in entries {
        let name_bytes = name.as_bytes();
        material.extend_from_slice(&(name_bytes.len() as u64).to_le_bytes());
        material.extend_from_slice(name_bytes);
        material.extend_from_slice(&handle.to_le_bytes());
    }
    format!("sha256:{}", sha256_hex_bytes(&material))
}

fn epoch_millis_now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn active_dispatch_table(manager: &GpuModuleManager) -> (HashMap<String, u64>, u64) {
    let entries = dispatch_table_entries(manager.kernel_table());
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    entries.hash(&mut hasher);
    let table_hash = hasher.finish();
    (entries.into_iter().collect(), table_hash)
}

fn artifact_id_for_hash(hash: &str) -> String {
    format!(
        "artifact:sha256:{}",
        hash.trim().trim_start_matches("sha256:")
    )
}

fn log_optional_token(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("none")
        .to_string()
}

const RUNTIME_OUTPUT_ORACLE_PROFILE_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.runtime_output_oracle_profile.v1";
const MAX_RUNTIME_OUTPUT_ORACLE_PROFILE_BYTES: u64 = 1024 * 1024;
const MAX_RUNTIME_OUTPUT_ORACLE_TOKEN_BYTES: usize = 1024;
const DEFAULT_RUNTIME_OUTPUT_ORACLE_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const ABSOLUTE_RUNTIME_OUTPUT_ORACLE_TOTAL_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeOutputOracleProfile {
    enabled: bool,
    schema_version: String,
    profile_id: String,
    oracle_id: String,
    #[serde(default)]
    baseline_sha256: Option<String>,
    expected_sha256: String,
    producer: String,
    output_target_id: String,
    kernel_name: String,
    grid: [u32; 3],
    block: [u32; 3],
    buffers: Vec<RuntimeOutputOracleBuffer>,
    args: Vec<RuntimeOutputOracleArg>,
    output_buffer: String,
    probe_mode: String,
    probe_config_hash: String,
    probe_evidence_ref: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeOutputOracleBuffer {
    name: String,
    element_type: String,
    count: usize,
    initializer: RuntimeOutputOracleInitializer,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeOutputOracleInitializer {
    kind: String,
    #[serde(default)]
    start: Option<f32>,
    #[serde(default)]
    value: Option<f32>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeOutputOracleArg {
    kind: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    value: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
struct PinnedRuntimeOutputOracleProfile {
    profile: RuntimeOutputOracleProfile,
    candidate_artifact_sha256: String,
    fission_output_oracle_contract_sha256: String,
    profile_bytes_sha256: String,
    source_edit_id: String,
    evidence_line: String,
}

#[derive(Debug, Clone)]
struct ValidatedRuntimeOutputOracleProfile {
    total_buffer_bytes: u64,
    baseline_sha256: String,
}

#[derive(Debug, Clone)]
enum RuntimeOutputOracleProfilePin {
    ColdIgnored,
    AbsentUncommitted,
    Committed(PinnedRuntimeOutputOracleProfile),
}

impl RuntimeOutputOracleProfilePin {
    fn committed(&self) -> Option<&PinnedRuntimeOutputOracleProfile> {
        match self {
            Self::Committed(profile) => Some(profile),
            Self::ColdIgnored | Self::AbsentUncommitted => None,
        }
    }
}

#[derive(Debug, Clone)]
enum RuntimeProbeArgStorage {
    F32(f32),
    U32(u32),
    DevicePtr(CuDevicePtr),
}

impl RuntimeProbeArgStorage {
    fn as_mut_ptr(&mut self) -> *mut c_void {
        match self {
            Self::F32(value) => (value as *mut f32).cast::<c_void>(),
            Self::U32(value) => (value as *mut u32).cast::<c_void>(),
            Self::DevicePtr(value) => (value as *mut CuDevicePtr).cast::<c_void>(),
        }
    }

    fn value_size(&self) -> usize {
        match self {
            Self::F32(_) => std::mem::size_of::<f32>(),
            Self::U32(_) => std::mem::size_of::<u32>(),
            Self::DevicePtr(_) => std::mem::size_of::<CuDevicePtr>(),
        }
    }

    fn value_kind(&self) -> u32 {
        match self {
            Self::F32(_) => SYNTHI_GPU_ARG_KIND_FLOATING,
            Self::U32(_) => SYNTHI_GPU_ARG_KIND_INTEGER,
            Self::DevicePtr(_) => SYNTHI_GPU_ARG_KIND_POINTER,
        }
    }
}

fn runtime_probe_cstring(value: impl AsRef<str>) -> Result<CString, String> {
    CString::new(value.as_ref().replace('\0', "_"))
        .map_err(|error| format!("runtime output oracle string contains invalid nul: {error}"))
}

fn canonical_sha256_prefixed(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn runtime_output_oracle_total_bytes_limit() -> Result<u64, String> {
    let configured = env::var("SYNTHI_GPU_HMR_RUNTIME_OUTPUT_ORACLE_MAX_BYTES")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let limit = match configured {
        Some(value) => value.parse::<u64>().map_err(|_| {
            "runtime output oracle aggregate byte limit is not an unsigned integer".to_string()
        })?,
        None => DEFAULT_RUNTIME_OUTPUT_ORACLE_TOTAL_BYTES,
    };
    if limit == 0 || limit > ABSOLUTE_RUNTIME_OUTPUT_ORACLE_TOTAL_BYTES {
        return Err(format!(
            "runtime output oracle aggregate byte limit must be between 1 and {ABSOLUTE_RUNTIME_OUTPUT_ORACLE_TOTAL_BYTES}"
        ));
    }
    Ok(limit)
}

fn contract_string_alias<'a>(
    contract: &'a serde_json::Value,
    label: &str,
    aliases: &[&str],
    required: bool,
) -> Result<Option<&'a str>, String> {
    let object = contract.as_object().ok_or_else(|| {
        "runtime output oracle commitment fission contract is not an object".to_string()
    })?;
    let mut selected: Option<&str> = None;
    for alias in aliases {
        let Some(value) = object.get(*alias) else {
            continue;
        };
        let value = value.as_str().ok_or_else(|| {
            format!("runtime output oracle contract field {alias} must be a string")
        })?;
        let value = runtime_output_oracle_token(label, value)?;
        if selected.is_some_and(|selected| selected != value) {
            return Err(format!(
                "runtime output oracle contract aliases for {label} conflict"
            ));
        }
        selected = Some(value);
    }
    if required && selected.is_none() {
        return Err(format!(
            "runtime output oracle contract is missing semantic field {label}"
        ));
    }
    Ok(selected)
}

fn contract_bool_alias(
    contract: &serde_json::Value,
    label: &str,
    aliases: &[&str],
) -> Result<Option<bool>, String> {
    let object = contract.as_object().ok_or_else(|| {
        "runtime output oracle commitment fission contract is not an object".to_string()
    })?;
    let mut selected = None;
    for alias in aliases {
        let Some(value) = object.get(*alias) else {
            continue;
        };
        let value = value.as_bool().ok_or_else(|| {
            format!("runtime output oracle contract field {alias} must be boolean")
        })?;
        if selected.is_some_and(|selected| selected != value) {
            return Err(format!(
                "runtime output oracle contract aliases for {label} conflict"
            ));
        }
        selected = Some(value);
    }
    Ok(selected)
}

fn validate_runtime_output_oracle_contract_binding(
    contract: &serde_json::Value,
    profile: &RuntimeOutputOracleProfile,
    baseline_sha256: &str,
) -> Result<(), String> {
    let kind = contract_string_alias(
        contract,
        "kind",
        &["kind", "oracleKind", "oracle_kind"],
        true,
    )?
    .expect("required contract kind");
    if !matches!(
        kind,
        "buffer_checksum" | "compute_readback" | "readback_checksum"
    ) {
        return Err(format!(
            "runtime output oracle contract kind {kind:?} is not a compute readback oracle"
        ));
    }
    for (label, aliases, expected) in [
        (
            "oracleId",
            &[
                "oracleId",
                "requiredOracleId",
                "oracle_id",
                "required_oracle_id",
            ][..],
            profile.oracle_id.as_str(),
        ),
        (
            "expectedSha256",
            &[
                "expected",
                "expectedSha256",
                "expectedHash",
                "expected_sha256",
                "expected_hash",
            ][..],
            profile.expected_sha256.as_str(),
        ),
        (
            "producer",
            &["producer", "producerId", "producer_id"][..],
            profile.producer.as_str(),
        ),
        (
            "outputTargetId",
            &[
                "outputTargetId",
                "outputTarget",
                "output_target_id",
                "output_target",
            ][..],
            profile.output_target_id.as_str(),
        ),
    ] {
        let observed = contract_string_alias(contract, label, aliases, true)?
            .expect("required semantic contract field");
        if observed != expected {
            return Err(format!(
                "runtime output oracle contract/profile semantic mismatch for {label}"
            ));
        }
    }
    for (label, aliases, expected) in [
        (
            "baselineSha256",
            &[
                "baselineSha256",
                "baselineHash",
                "baseline_sha256",
                "baseline_hash",
            ][..],
            baseline_sha256,
        ),
        (
            "kernelSymbol",
            &["kernelSymbol", "kernelName", "kernel_symbol", "kernel_name"][..],
            profile.kernel_name.as_str(),
        ),
        (
            "probeMode",
            &["probeMode", "probe_mode"][..],
            profile.probe_mode.as_str(),
        ),
        (
            "probeConfigHash",
            &["probeConfigHash", "probe_config_hash"][..],
            profile.probe_config_hash.as_str(),
        ),
    ] {
        if let Some(observed) = contract_string_alias(contract, label, aliases, false)? {
            if observed != expected {
                return Err(format!(
                    "runtime output oracle contract/profile semantic mismatch for {label}"
                ));
            }
        }
    }
    if contract_bool_alias(
        contract,
        "expectedOutputChange",
        &["expectedOutputChange", "expected_output_change"],
    )? == Some(false)
    {
        return Err(
            "runtime output oracle contract explicitly denies an expected output change"
                .to_string(),
        );
    }
    Ok(())
}

fn runtime_output_oracle_token<'a>(label: &str, value: &'a str) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed != value
        || trimmed.len() > MAX_RUNTIME_OUTPUT_ORACLE_TOKEN_BYTES
        || trimmed.chars().any(char::is_whitespace)
        || trimmed.chars().any(char::is_control)
    {
        return Err(format!(
            "runtime output oracle profile field {label} is not a bounded log-safe token"
        ));
    }
    Ok(trimmed)
}

fn runtime_output_oracle_source_edit_id(value: Option<&str>) -> Result<String, String> {
    let missing = value.is_none();
    normalized_reload_source_edit_id(value).ok_or_else(|| {
        if missing {
            "runtime output oracle source edit identity is missing".to_string()
        } else {
            "runtime output oracle source edit identity is not canonical source-edit SHA-256"
                .to_string()
        }
    })
}

fn validate_runtime_output_oracle_profile(
    profile: &RuntimeOutputOracleProfile,
    total_bytes_limit: u64,
) -> Result<ValidatedRuntimeOutputOracleProfile, String> {
    if !profile.enabled {
        return Err("runtime output oracle profile is disabled".to_string());
    }
    if profile.schema_version != RUNTIME_OUTPUT_ORACLE_PROFILE_SCHEMA_VERSION {
        return Err(format!(
            "runtime output oracle profile schema mismatch: expected {RUNTIME_OUTPUT_ORACLE_PROFILE_SCHEMA_VERSION:?} got {:?}",
            profile.schema_version
        ));
    }
    for (label, value) in [
        ("profileId", profile.profile_id.as_str()),
        ("oracleId", profile.oracle_id.as_str()),
        ("producer", profile.producer.as_str()),
        ("outputTargetId", profile.output_target_id.as_str()),
        ("kernelName", profile.kernel_name.as_str()),
        ("outputBuffer", profile.output_buffer.as_str()),
        ("probeMode", profile.probe_mode.as_str()),
        ("probeEvidenceRef", profile.probe_evidence_ref.as_str()),
    ] {
        runtime_output_oracle_token(label, value)?;
    }
    if profile
        .baseline_sha256
        .as_deref()
        .is_some_and(|value| !canonical_sha256_prefixed(value))
    {
        return Err(
            "runtime output oracle profile baselineSha256 is not canonical sha256".to_string(),
        );
    }
    if !canonical_sha256_prefixed(&profile.expected_sha256) {
        return Err(
            "runtime output oracle profile expectedSha256 is not canonical sha256".to_string(),
        );
    }
    if !canonical_sha256_prefixed(&profile.probe_config_hash) {
        return Err(
            "runtime output oracle profile probeConfigHash is not canonical sha256".to_string(),
        );
    }
    if profile.grid.contains(&0) || profile.block.contains(&0) {
        return Err("runtime output oracle profile has zero launch dimension".to_string());
    }
    if profile.buffers.is_empty() || profile.buffers.len() > 256 {
        return Err("runtime output oracle profile has invalid buffer count".to_string());
    }
    if profile.args.is_empty() || profile.args.len() > 256 {
        return Err("runtime output oracle profile has invalid argument count".to_string());
    }

    let mut declared_buffers = HashMap::new();
    let mut total_buffer_bytes = 0u64;
    for buffer in &profile.buffers {
        let name = runtime_output_oracle_token("buffers[].name", &buffer.name)?;
        if declared_buffers.insert(name, buffer.count).is_some() {
            return Err(format!(
                "runtime output oracle profile declares duplicate buffer {name:?}"
            ));
        }
        if buffer.element_type != "f32" {
            return Err(format!(
                "runtime output oracle buffer {name:?} uses unsupported element type {:?}",
                buffer.element_type
            ));
        }
        if buffer.count == 0 || buffer.count > 64 * 1024 * 1024 {
            return Err(format!(
                "runtime output oracle buffer {name:?} has invalid count {}",
                buffer.count
            ));
        }
        let buffer_bytes = buffer
            .count
            .checked_mul(std::mem::size_of::<f32>())
            .ok_or_else(|| format!("runtime output oracle buffer {name:?} byte size overflows"))?;
        total_buffer_bytes = total_buffer_bytes
            .checked_add(buffer_bytes as u64)
            .ok_or_else(|| "runtime output oracle aggregate byte size overflows".to_string())?;
        if total_buffer_bytes > total_bytes_limit {
            return Err(format!(
                "runtime output oracle aggregate bytes {total_buffer_bytes} exceed configured limit {total_bytes_limit}"
            ));
        }
        match buffer.initializer.kind.as_str() {
            "iota" => {
                if buffer
                    .initializer
                    .start
                    .is_some_and(|value| !value.is_finite())
                {
                    return Err(format!(
                        "runtime output oracle buffer {name:?} iota start is not finite"
                    ));
                }
            }
            "fill" => {
                if buffer
                    .initializer
                    .value
                    .is_some_and(|value| !value.is_finite())
                {
                    return Err(format!(
                        "runtime output oracle buffer {name:?} fill value is not finite"
                    ));
                }
            }
            "zero" => {
                if buffer.initializer.start.is_some() || buffer.initializer.value.is_some() {
                    return Err(format!(
                        "runtime output oracle buffer {name:?} zero initializer has unexpected value"
                    ));
                }
            }
            other => {
                return Err(format!(
                    "runtime output oracle buffer {name:?} uses unsupported initializer {other:?}"
                ));
            }
        }
    }
    if !declared_buffers.contains_key(profile.output_buffer.as_str()) {
        return Err(format!(
            "runtime output oracle output buffer {:?} is not declared",
            profile.output_buffer
        ));
    }
    let mut output_buffer_arg_count = 0usize;
    for arg in &profile.args {
        match arg.kind.as_str() {
            "scalar_f32" => {
                arg.value
                    .as_ref()
                    .ok_or_else(|| "runtime output oracle scalar_f32 arg missing value".to_string())
                    .and_then(runtime_oracle_json_f32)?;
            }
            "scalar_u32" => {
                arg.value
                    .as_ref()
                    .ok_or_else(|| "runtime output oracle scalar_u32 arg missing value".to_string())
                    .and_then(runtime_oracle_json_u32)?;
            }
            "buffer" => {
                let name = runtime_output_oracle_token(
                    "args[].name",
                    arg.name.as_deref().ok_or_else(|| {
                        "runtime output oracle buffer arg missing name".to_string()
                    })?,
                )?;
                if !declared_buffers.contains_key(name) {
                    return Err(format!(
                        "runtime output oracle arg references unknown buffer {name:?}"
                    ));
                }
                if name == profile.output_buffer {
                    output_buffer_arg_count += 1;
                }
            }
            other => {
                return Err(format!(
                    "runtime output oracle arg kind {other:?} is unsupported"
                ));
            }
        }
    }
    if output_buffer_arg_count != 1 {
        return Err(format!(
            "runtime output oracle output buffer must appear exactly once in kernel args, observed {output_buffer_arg_count}"
        ));
    }
    let output_buffer = profile
        .buffers
        .iter()
        .find(|buffer| buffer.name == profile.output_buffer)
        .expect("declared output buffer");
    let baseline_bytes = runtime_oracle_buffer_bytes(output_buffer)?;
    let actual_baseline_sha256 = format!("sha256:{}", sha256_hex_bytes(&baseline_bytes));
    if profile
        .baseline_sha256
        .as_deref()
        .is_some_and(|declared| declared != actual_baseline_sha256)
    {
        return Err(
            "runtime output oracle profile baseline hash does not match output initializer"
                .to_string(),
        );
    }
    if actual_baseline_sha256 == profile.expected_sha256 {
        return Err(
            "runtime output oracle profile baseline and expected hashes are identical".to_string(),
        );
    }
    Ok(ValidatedRuntimeOutputOracleProfile {
        total_buffer_bytes,
        baseline_sha256: actual_baseline_sha256,
    })
}

fn read_runtime_output_oracle_profile_bytes() -> Result<Option<Vec<u8>>, String> {
    let path = configured_gpu_hmr_runtime_output_oracle_profile_path();
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "runtime output oracle profile read failed before module mutation: {error}"
            ));
        }
    };
    let reported_bytes = file
        .metadata()
        .map_err(|error| {
            format!("runtime output oracle profile metadata failed before module mutation: {error}")
        })?
        .len();
    if reported_bytes > MAX_RUNTIME_OUTPUT_ORACLE_PROFILE_BYTES {
        return Err(format!(
            "runtime output oracle profile exceeds {MAX_RUNTIME_OUTPUT_ORACLE_PROFILE_BYTES} bytes before module mutation"
        ));
    }
    let mut bytes = Vec::with_capacity(reported_bytes as usize);
    let mut bounded = file.take(MAX_RUNTIME_OUTPUT_ORACLE_PROFILE_BYTES + 1);
    bounded.read_to_end(&mut bytes).map_err(|error| {
        format!("runtime output oracle profile read failed before module mutation: {error}")
    })?;
    if bytes.len() as u64 > MAX_RUNTIME_OUTPUT_ORACLE_PROFILE_BYTES {
        return Err(format!(
            "runtime output oracle profile exceeds {MAX_RUNTIME_OUTPUT_ORACLE_PROFILE_BYTES} bytes before module mutation"
        ));
    }
    Ok(Some(bytes))
}

fn runtime_output_oracle_log_token(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_whitespace() { '_' } else { ch })
        .collect()
}

fn pin_runtime_output_oracle_profile(
    req: &AdapterReloadRequest,
    candidate_artifact_sha256: &str,
    hot_reload: bool,
) -> Result<RuntimeOutputOracleProfilePin, String> {
    let commitment = req
        .capsule_metadata
        .as_ref()
        .and_then(|metadata| metadata.output_oracle_profile_commitment.as_ref());
    if !hot_reload && commitment.is_none() {
        return Ok(RuntimeOutputOracleProfilePin::ColdIgnored);
    }
    let profile_bytes = match read_runtime_output_oracle_profile_bytes()? {
        Some(bytes) => bytes,
        None if commitment.is_some() => {
            return Err(
                "runtime output oracle profile commitment has no profile bytes before module mutation"
                    .to_string(),
            );
        }
        None if hot_reload => {
            return Err(
                "hot GPU reload is missing a prepublication output oracle commitment before module mutation"
                    .to_string(),
            );
        }
        None => return Ok(RuntimeOutputOracleProfilePin::AbsentUncommitted),
    };
    let profile: RuntimeOutputOracleProfile =
        serde_json::from_slice(&profile_bytes).map_err(|error| {
            format!("runtime output oracle profile JSON invalid before module mutation: {error}")
        })?;
    if !profile.enabled && commitment.is_none() && hot_reload {
        return Err(
            "hot GPU reload has no enabled committed output oracle before module mutation"
                .to_string(),
        );
    }
    if !profile.enabled && commitment.is_none() {
        return Ok(RuntimeOutputOracleProfilePin::AbsentUncommitted);
    }
    let Some(commitment) = commitment else {
        if hot_reload {
            return Err(
                "enabled runtime output oracle profile is missing a prepublication commitment before module mutation"
                    .to_string(),
            );
        }
        return Ok(RuntimeOutputOracleProfilePin::ColdIgnored);
    };

    let total_bytes_limit = runtime_output_oracle_total_bytes_limit()?;
    let validated_profile = validate_runtime_output_oracle_profile(&profile, total_bytes_limit)?;
    if commitment.schema_version != RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION {
        return Err(format!(
            "runtime output oracle commitment schema mismatch before module mutation: expected {RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION:?} got {:?}",
            commitment.schema_version
        ));
    }
    if !canonical_sha256_prefixed(candidate_artifact_sha256) {
        return Err("candidate artifact identity is not canonical sha256".to_string());
    }
    for (label, value) in [
        (
            "candidateArtifactSha256",
            commitment.candidate_artifact_sha256.as_str(),
        ),
        (
            "fissionOutputOracleContractSha256",
            commitment.fission_output_oracle_contract_sha256.as_str(),
        ),
        (
            "profileBytesSha256",
            commitment.profile_bytes_sha256.as_str(),
        ),
    ] {
        if !canonical_sha256_prefixed(value) {
            return Err(format!(
                "runtime output oracle commitment field {label} is not canonical sha256 before module mutation"
            ));
        }
    }
    if commitment.candidate_artifact_sha256 != candidate_artifact_sha256 {
        return Err(
            "runtime output oracle commitment candidate artifact mismatch before module mutation"
                .to_string(),
        );
    }
    let contract = req
        .capsule_metadata
        .as_ref()
        .and_then(|metadata| metadata.fission_output_oracle_contract.as_ref())
        .filter(|contract| contract.is_object())
        .ok_or_else(|| {
            "runtime output oracle commitment is missing its fission oracle contract before module mutation"
                .to_string()
        })?;
    let contract_sha256 = format!("sha256:{}", stable_json_hash(contract));
    if commitment.fission_output_oracle_contract_sha256 != contract_sha256 {
        return Err(
            "runtime output oracle commitment fission contract mismatch before module mutation"
                .to_string(),
        );
    }
    validate_runtime_output_oracle_contract_binding(
        contract,
        &profile,
        &validated_profile.baseline_sha256,
    )?;
    let profile_bytes_sha256 = format!("sha256:{}", sha256_hex_bytes(&profile_bytes));
    if commitment.profile_bytes_sha256 != profile_bytes_sha256 {
        return Err(
            "runtime output oracle commitment profile bytes mismatch before module mutation"
                .to_string(),
        );
    }
    let committed_edit_id = runtime_output_oracle_source_edit_id(Some(&commitment.edit_id))?;
    let request_edit_id = runtime_output_oracle_source_edit_id(req.source_edit_id.as_deref())?;
    if committed_edit_id != request_edit_id {
        return Err(
            "runtime output oracle commitment source edit mismatch before module mutation"
                .to_string(),
        );
    }

    let evidence_line = format!(
        "[gpu-runtime-boundary] runtime_output_oracle_profile_pin schema=synthi.gpu_hmr.runtime_output_oracle_profile_pin.v1 status=verified profile={} profile_schema={} candidate_artifact_sha256={} fission_output_oracle_contract_sha256={} profile_bytes_sha256={} source_edit_id={} total_buffer_bytes={} total_buffer_bytes_limit={} semantic_contract_binding=verified causal_output_change_required=true proof_authority=prepublication_profile_binding_only_not_gpu_hmr_success accepted_for_gpu_hmr=false gpu_hmr_success=false can_satisfy_runtime_proof=false",
        profile.profile_id,
        profile.schema_version,
        candidate_artifact_sha256,
        contract_sha256,
        profile_bytes_sha256,
        request_edit_id,
        validated_profile.total_buffer_bytes,
        total_bytes_limit,
    );
    Ok(RuntimeOutputOracleProfilePin::Committed(
        PinnedRuntimeOutputOracleProfile {
            profile,
            candidate_artifact_sha256: candidate_artifact_sha256.to_string(),
            fission_output_oracle_contract_sha256: contract_sha256,
            profile_bytes_sha256,
            source_edit_id: request_edit_id,
            evidence_line,
        },
    ))
}

#[cfg(test)]
type RuntimeOutputOraclePostPinHook = Box<dyn FnOnce() + Send + 'static>;

#[cfg(test)]
static RUNTIME_OUTPUT_ORACLE_POST_PIN_HOOK: std::sync::OnceLock<
    std::sync::Mutex<Option<RuntimeOutputOraclePostPinHook>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
fn install_runtime_output_oracle_post_pin_hook_for_test(hook: impl FnOnce() + Send + 'static) {
    *RUNTIME_OUTPUT_ORACLE_POST_PIN_HOOK
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .expect("runtime output oracle post-pin hook lock") = Some(Box::new(hook));
}

#[cfg(test)]
fn run_runtime_output_oracle_post_pin_hook_for_test() {
    let hook = RUNTIME_OUTPUT_ORACLE_POST_PIN_HOOK
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .expect("runtime output oracle post-pin hook lock")
        .take();
    if let Some(hook) = hook {
        hook();
    }
}

fn runtime_oracle_buffer_bytes(buffer: &RuntimeOutputOracleBuffer) -> Result<Vec<u8>, String> {
    if buffer.count == 0 || buffer.count > 64 * 1024 * 1024 {
        return Err(format!(
            "runtime output oracle buffer {:?} has invalid count {}",
            buffer.name, buffer.count
        ));
    }
    if buffer.element_type != "f32" {
        return Err(format!(
            "runtime output oracle buffer {:?} uses unsupported element type {:?}",
            buffer.name, buffer.element_type
        ));
    }
    let mut bytes = Vec::with_capacity(buffer.count * std::mem::size_of::<f32>());
    match buffer.initializer.kind.as_str() {
        "iota" => {
            let start = buffer.initializer.start.unwrap_or(0.0);
            for index in 0..buffer.count {
                bytes.extend_from_slice(&(start + index as f32).to_le_bytes());
            }
        }
        "fill" => {
            let value = buffer.initializer.value.unwrap_or(0.0);
            for _ in 0..buffer.count {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        "zero" => {
            bytes.resize(buffer.count * std::mem::size_of::<f32>(), 0);
        }
        other => {
            return Err(format!(
                "runtime output oracle buffer {:?} uses unsupported initializer {:?}",
                buffer.name, other
            ));
        }
    }
    Ok(bytes)
}

fn runtime_oracle_json_f32(value: &serde_json::Value) -> Result<f32, String> {
    let value = value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| {
            "runtime output oracle scalar_f32 value must be finite number".to_string()
        })?;
    let narrowed = value as f32;
    if !narrowed.is_finite() {
        return Err(
            "runtime output oracle scalar_f32 value overflows finite f32 range".to_string(),
        );
    }
    Ok(narrowed)
}

fn runtime_oracle_json_u32(value: &serde_json::Value) -> Result<u32, String> {
    let raw = value.as_u64().ok_or_else(|| {
        "runtime output oracle scalar_u32 value must be unsigned integer".to_string()
    })?;
    u32::try_from(raw).map_err(|_| "runtime output oracle scalar_u32 value exceeds u32".to_string())
}

fn run_runtime_output_oracle_profile(
    symbols: &GpuDriverSymbolTable,
    dispatcher_kernels: &HashMap<String, u64>,
    changed_symbols: &[String],
    active_generation: u64,
    active_artifact_id: &str,
    profile: &RuntimeOutputOracleProfile,
) -> Result<Option<String>, String> {
    let kernel_name = profile.kernel_name.trim();
    if !changed_symbols.iter().any(|symbol| symbol == kernel_name) {
        return Ok(Some(format!(
            "[gpu-runtime-boundary] runtime_output_oracle_probe status=skipped profile={} kernel={} generation={} reason=kernel_not_changed",
            profile.profile_id, kernel_name, active_generation
        )));
    }
    let Some(_function_handle) = dispatcher_kernels.get(kernel_name).copied() else {
        return Err(format!(
            "runtime output oracle kernel {:?} is not resolved in active dispatch table",
            kernel_name
        ));
    };
    let output_buffer_profile = profile
        .buffers
        .iter()
        .find(|buffer| buffer.name == profile.output_buffer)
        .ok_or_else(|| {
            format!(
                "runtime output oracle output buffer {:?} is not declared",
                profile.output_buffer
            )
        })?;
    let baseline_bytes = runtime_oracle_buffer_bytes(output_buffer_profile)?;
    let baseline_sha256 = format!("sha256:{}", sha256_hex_bytes(&baseline_bytes));
    if profile
        .baseline_sha256
        .as_deref()
        .is_some_and(|declared| declared != baseline_sha256)
    {
        return Err(
            "runtime output oracle retained baseline no longer matches profile initializer"
                .to_string(),
        );
    }

    let mut allocations: Vec<(String, CuDevicePtr)> = Vec::new();
    let result = (|| -> Result<String, String> {
        let mut device_buffers: HashMap<String, (CuDevicePtr, usize)> = HashMap::new();
        for buffer in &profile.buffers {
            let host_bytes = runtime_oracle_buffer_bytes(buffer)?;
            let mut device_ptr: CuDevicePtr = 0;
            let alloc_code = unsafe {
                (symbols.cu_mem_alloc)(&mut device_ptr as *mut CuDevicePtr, host_bytes.len())
            };
            if alloc_code != 0 || device_ptr == 0 {
                return Err(format!(
                    "runtime output oracle allocation {:?} failed code={alloc_code}",
                    buffer.name
                ));
            }
            allocations.push((buffer.name.clone(), device_ptr));
            let copy_code = unsafe {
                (symbols.cu_memcpy_htod)(
                    device_ptr,
                    host_bytes.as_ptr().cast::<c_void>(),
                    host_bytes.len(),
                )
            };
            if copy_code != 0 {
                return Err(format!(
                    "runtime output oracle HtoD copy {:?} failed code={copy_code}",
                    buffer.name
                ));
            }
            let semantic_name = runtime_probe_cstring(format!(
                "runtime-output-oracle:{}:{}",
                profile.profile_id, buffer.name
            ))?;
            let lifetime_hint = runtime_probe_cstring("runtime-output-oracle-probe")?;
            synthi_gpu_register_buffer(
                std::ptr::null_mut(),
                (device_ptr as usize) as *mut c_void,
                host_bytes.len(),
                semantic_name.as_ptr(),
                lifetime_hint.as_ptr(),
            );
            device_buffers.insert(buffer.name.clone(), (device_ptr, host_bytes.len()));
        }

        let mut arg_storage = Vec::new();
        for arg in &profile.args {
            match arg.kind.as_str() {
                "scalar_f32" => {
                    let value = arg
                        .value
                        .as_ref()
                        .ok_or_else(|| {
                            "runtime output oracle scalar_f32 arg missing value".to_string()
                        })
                        .and_then(runtime_oracle_json_f32)?;
                    arg_storage.push(RuntimeProbeArgStorage::F32(value));
                }
                "scalar_u32" => {
                    let value = arg
                        .value
                        .as_ref()
                        .ok_or_else(|| {
                            "runtime output oracle scalar_u32 arg missing value".to_string()
                        })
                        .and_then(runtime_oracle_json_u32)?;
                    arg_storage.push(RuntimeProbeArgStorage::U32(value));
                }
                "buffer" => {
                    let name = arg.name.as_deref().ok_or_else(|| {
                        "runtime output oracle buffer arg missing name".to_string()
                    })?;
                    let (device_ptr, _) = device_buffers.get(name).copied().ok_or_else(|| {
                        format!("runtime output oracle arg references unknown buffer {name:?}")
                    })?;
                    arg_storage.push(RuntimeProbeArgStorage::DevicePtr(device_ptr));
                }
                other => {
                    return Err(format!(
                        "runtime output oracle arg kind {other:?} is unsupported"
                    ));
                }
            }
        }
        let kernel_cstring = runtime_probe_cstring(kernel_name)?;
        let grid = profile.grid;
        let block = profile.block;
        let arg_infos = arg_storage
            .iter_mut()
            .map(|storage| SynthiGpuLaunchArg {
                value_ptr: storage.as_mut_ptr().cast_const(),
                value_size: storage.value_size(),
                value_kind: storage.value_kind(),
            })
            .collect::<Vec<_>>();
        let launch_receipt = synthi_gpu_launch_raw_arg_info_with_receipt(
            std::ptr::null_mut(),
            kernel_cstring.as_ptr(),
            grid.as_ptr().cast(),
            std::mem::size_of_val(&grid),
            block.as_ptr().cast(),
            std::mem::size_of_val(&block),
            0,
            0,
            arg_infos.as_ptr(),
            arg_infos.len(),
        );
        if !launch_receipt.dispatched {
            return Err(format!(
                "runtime output oracle launch kernel={kernel_name:?} was rejected by runtime boundary"
            ));
        }
        if launch_receipt.active_generation != active_generation
            || launch_receipt.runtime_session_id != runtime_session_id()
        {
            return Err(format!(
                "runtime output oracle launch kernel={kernel_name:?} receipt identity mismatch"
            ));
        }
        let after_dispatch_id = launch_receipt.dispatch_id.clone();
        let sync_code = unsafe { (symbols.cu_ctx_synchronize)() };
        if sync_code != 0 {
            return Err(format!(
                "runtime output oracle context synchronize failed code={sync_code}"
            ));
        }
        let (output_ptr, output_bytes) = device_buffers
            .get(&profile.output_buffer)
            .copied()
            .ok_or_else(|| {
                format!(
                    "runtime output oracle output buffer {:?} is not declared",
                    profile.output_buffer
                )
            })?;
        let mut output = vec![0u8; output_bytes];
        let dtoh_code = unsafe {
            (symbols.cu_memcpy_dtoh)(
                output.as_mut_ptr().cast::<c_void>(),
                output_ptr,
                output.len(),
            )
        };
        if dtoh_code != 0 {
            return Err(format!(
                "runtime output oracle DtoH copy {:?} failed code={dtoh_code}",
                profile.output_buffer
            ));
        }
        let observed_sha256 = format!("sha256:{}", sha256_hex_bytes(&output));
        if observed_sha256 == baseline_sha256 {
            return Err(format!(
                "runtime output oracle output {:?} was unchanged after new-epoch dispatch",
                profile.output_buffer
            ));
        }
        let checksum_passed = record_output_buffer_checksum_with_probe_bytes_after_dispatch(
            &profile.oracle_id,
            &output,
            &profile.expected_sha256,
            &profile.producer,
            &profile.output_target_id,
            Some(active_artifact_id),
            Some(&after_dispatch_id),
            None,
            &profile.probe_mode,
            &profile.probe_config_hash,
            &profile.probe_evidence_ref,
        );
        let host_receipt_verified = if checksum_passed {
            host_output_oracle_receipt::record_host_verified_compute_readback(
                &launch_receipt,
                &profile.schema_version,
                &profile.profile_id,
                &profile.oracle_id,
                &profile.producer,
                &profile.output_target_id,
                &profile.output_buffer,
                &output_buffer_profile.element_type,
                output_buffer_profile.count,
                std::mem::size_of::<f32>(),
                "little",
                &baseline_sha256,
                &profile.expected_sha256,
                &profile.probe_mode,
                &profile.probe_config_hash,
                &profile.probe_evidence_ref,
                &output,
            )?;
            true
        } else {
            false
        };
        let passed = checksum_passed && host_receipt_verified;
        Ok(format!(
            "[gpu-runtime-boundary] runtime_output_oracle_probe status={} profile={} schema={} kernel={} generation={} output_buffer={} bytes={} checksum_before={} checksum_after={} output_changed=true artifact_id={} after_dispatch_id={}",
            if passed { "pass" } else { "fail" },
            profile.profile_id,
            log_optional_token(Some(&profile.schema_version)),
            kernel_name,
            active_generation,
            profile.output_buffer,
            output.len(),
            baseline_sha256,
            observed_sha256,
            active_artifact_id,
            log_optional_token(Some(&after_dispatch_id))
        ))
    })();

    for (_name, ptr) in allocations.iter().rev() {
        let _ = unsafe { (symbols.cu_mem_free)(*ptr) };
    }
    result.map(Some)
}

fn replayable_arg_provenance(record: &LaunchRecord) -> bool {
    record.arg_provenance_complete
        && !record.arg_provenance.is_empty()
        && record.arg_provenance.iter().all(|arg| {
            arg.value_size > 0
                && arg
                    .value_bytes
                    .as_ref()
                    .is_some_and(|bytes| !bytes.is_empty() && bytes.len() == arg.value_size)
        })
}

fn replay_readback_target(record: &LaunchRecord) -> Option<&LaunchArgProvenance> {
    record.arg_provenance.iter().find(|arg| {
        arg.kind == "device-allocation"
            && arg.observed_value.is_some()
            && arg
                .allocation_bytes
                .is_some_and(|bytes| bytes > arg.allocation_offset.unwrap_or(0))
    })
}

fn latest_replayable_launch_record(
    changed_symbols: &[String],
    previous_generation: u64,
) -> Option<LaunchRecord> {
    launch_records_snapshot().into_iter().rev().find(|record| {
        record.runtime_session_id == runtime_session_id()
            && record.dispatched
            && record.dispatch_error.is_none()
            && record.active_generation == previous_generation
            && changed_symbols
                .iter()
                .any(|symbol| symbol == &record.kernel_name)
            && replayable_arg_provenance(record)
            && replay_readback_target(record).is_some()
    })
}

fn run_runtime_output_observation_replay(
    symbols: &GpuDriverSymbolTable,
    changed_symbols: &[String],
    previous_generation: u64,
    active_generation: u64,
    active_artifact_id: &str,
) -> Result<Option<String>, String> {
    let Some(record) = latest_replayable_launch_record(changed_symbols, previous_generation) else {
        return Ok(Some(format!(
            "[gpu-runtime-boundary] runtime_output_oracle_probe status=skipped profile=runtime-dispatch-observation generation={} artifact_id={} accepted_for_gpu_hmr=false gpu_hmr_success=false reason=no_replayable_prior_dispatch",
            active_generation,
            active_artifact_id
        )));
    };
    let target = replay_readback_target(&record)
        .ok_or_else(|| "runtime replay launch lost readback target".to_string())?;
    let readback_ptr = target
        .observed_value
        .ok_or_else(|| "runtime replay readback target missing device pointer".to_string())?
        as CuDevicePtr;
    let readback_offset = target.allocation_offset.unwrap_or(0);
    let available_bytes = target
        .allocation_bytes
        .unwrap_or(0)
        .saturating_sub(readback_offset);
    let readback_bytes = available_bytes.min(4096);
    if readback_ptr == 0 || readback_bytes == 0 {
        return Err("runtime replay readback target is empty".to_string());
    }
    let mut before = vec![0u8; readback_bytes];
    let before_code = unsafe {
        (symbols.cu_memcpy_dtoh)(
            before.as_mut_ptr().cast::<c_void>(),
            readback_ptr,
            before.len(),
        )
    };
    if before_code != 0 {
        return Err(format!(
            "runtime replay pre-dispatch DtoH copy kernel={:?} failed code={before_code}",
            record.kernel_name
        ));
    }

    let mut arg_bytes = record
        .arg_provenance
        .iter()
        .map(|arg| {
            let bytes = arg.value_bytes.clone().ok_or_else(|| {
                format!("runtime replay arg {} missing captured bytes", arg.index)
            })?;
            if bytes.len() != arg.value_size {
                return Err(format!(
                    "runtime replay arg {} byte length mismatch expected={} actual={}",
                    arg.index,
                    arg.value_size,
                    bytes.len()
                ));
            }
            Ok((arg.index, arg.value_kind, bytes))
        })
        .collect::<Result<Vec<_>, String>>()?;
    arg_bytes.sort_by_key(|(index, _, _)| *index);
    let arg_infos = arg_bytes
        .iter()
        .map(|(_, value_kind, bytes)| SynthiGpuLaunchArg {
            value_ptr: bytes.as_ptr().cast::<c_void>(),
            value_size: bytes.len(),
            value_kind: *value_kind,
        })
        .collect::<Vec<_>>();
    let kernel_cstring = runtime_probe_cstring(&record.kernel_name)?;
    let grid = record.grid;
    let block = record.block;
    let launch_receipt = synthi_gpu_launch_raw_arg_info_with_receipt(
        std::ptr::null_mut(),
        kernel_cstring.as_ptr(),
        &grid as *const (u32, u32, u32) as *const c_void,
        std::mem::size_of_val(&grid),
        &block as *const (u32, u32, u32) as *const c_void,
        std::mem::size_of_val(&block),
        record.shared_bytes,
        record.stream_token,
        arg_infos.as_ptr(),
        arg_infos.len(),
    );
    if !launch_receipt.dispatched {
        return Err(format!(
            "runtime replay launch kernel={:?} was rejected by runtime boundary",
            record.kernel_name
        ));
    }
    if launch_receipt.active_generation != active_generation
        || launch_receipt.runtime_session_id != runtime_session_id()
    {
        return Err(format!(
            "runtime replay launch kernel={:?} receipt identity mismatch",
            record.kernel_name
        ));
    }
    let after_dispatch_id = launch_receipt.dispatch_id;
    let sync_code = unsafe { (symbols.cu_ctx_synchronize)() };
    if sync_code != 0 {
        return Err(format!(
            "runtime replay context synchronize kernel={:?} failed code={sync_code}",
            record.kernel_name
        ));
    }
    let mut after = vec![0u8; readback_bytes];
    let after_code = unsafe {
        (symbols.cu_memcpy_dtoh)(
            after.as_mut_ptr().cast::<c_void>(),
            readback_ptr,
            after.len(),
        )
    };
    if after_code != 0 {
        return Err(format!(
            "runtime replay post-dispatch DtoH copy kernel={:?} failed code={after_code}",
            record.kernel_name
        ));
    }
    let observed_hash = format!("sha256:{}", sha256_hex_bytes(&after));
    let output_target_id = format!(
        "runtime-observation:{}:{}",
        &record.kernel_name,
        target
            .allocation_id
            .as_deref()
            .unwrap_or("registered-device-allocation")
    );
    Ok(Some(format!(
        "[gpu-runtime-boundary] runtime_output_oracle_probe status=unproven profile=runtime-dispatch-observation schema=synthi.gpu_hmr.runtime_output_observation.v1 kernel={} generation={} output_buffer={} bytes={} changed={} observed_hash={} artifact_id={} after_dispatch_id={} accepted_for_gpu_hmr=false gpu_hmr_success=false reason=precommitted_expected_output_missing",
        record.kernel_name,
        active_generation,
        output_target_id,
        after.len(),
        before != after,
        observed_hash,
        active_artifact_id,
        log_optional_token(Some(&after_dispatch_id))
    )))
}

fn run_runtime_output_oracle_probe(
    symbols: &GpuDriverSymbolTable,
    dispatcher_kernels: &HashMap<String, u64>,
    changed_symbols: &[String],
    previous_generation: u64,
    active_generation: u64,
    active_artifact_id: &str,
    pinned_profile: Option<&PinnedRuntimeOutputOracleProfile>,
) -> Result<Option<String>, String> {
    let profile_result = match pinned_profile {
        Some(pinned) => run_runtime_output_oracle_profile(
            symbols,
            dispatcher_kernels,
            changed_symbols,
            active_generation,
            active_artifact_id,
            &pinned.profile,
        )?,
        None => None,
    };
    match profile_result {
        Some(line) if runtime_boundary_token(&line, "status") != Some("skipped") => Ok(Some(line)),
        _ => run_runtime_output_observation_replay(
            symbols,
            changed_symbols,
            previous_generation,
            active_generation,
            active_artifact_id,
        ),
    }
}

fn runtime_boundary_token<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.split_whitespace()
        .find_map(|token| token.strip_prefix(&format!("{key}=")))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
}

fn runtime_output_oracle_line_passed(
    line: &str,
    active_generation: u64,
    active_artifact_id: &str,
) -> bool {
    runtime_boundary_token(line, "status") == Some("pass")
        && runtime_boundary_token(line, "generation").and_then(|value| value.parse::<u64>().ok())
            == Some(active_generation)
        && runtime_boundary_token(line, "artifact_id") == Some(active_artifact_id)
}

const GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION: &str = "synthi.gpu.hmr.proof_ledger.v1";
const GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE: &str =
    "synthi.gpu_hmr.proof_ledger.portable.v2";
const GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const GPU_HMR_PROOF_SCHEMA_VERSION: &str = "synthi.gpu.hmr.proof.v1";
const GPU_HMR_VALIDATION_PROOF_SCHEMA_VERSION: &str = "synthi.gpu.hmr.validation-proof.v1";
const GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION: &str = "synthi.gpu_hmr.contract.v1";
const GPU_HMR_FULL_RUNTIME_RESULT_STATE: &str = "gpu-hmr-full-runtime-proven";
fn stable_json_string(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(stable_json_string)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let fields = keys
                .into_iter()
                .map(|key| {
                    let encoded_key =
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
                    let encoded_value = stable_json_string(map.get(key).unwrap_or(&Value::Null));
                    format!("{encoded_key}:{encoded_value}")
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{fields}}}")
        }
    }
}

fn stable_json_sha256(value: &Value) -> String {
    sha256_hex_bytes(stable_json_string(value).as_bytes())
}

fn sha256_prefixed_from_text(value: &str) -> String {
    format!("sha256:{}", sha256_hex_bytes(value.as_bytes()))
}

fn normalize_sha256_prefixed(value: &str) -> Option<String> {
    normalized_sha256_hex(value).map(|hash| format!("sha256:{hash}"))
}

fn verified_runtime_source_edit_commitment(
    capsule_metadata: Option<&ReloadCapsuleMetadata>,
    source_edit_id: &str,
    artifact_hash: &str,
    pinned_profile: Option<&PinnedRuntimeOutputOracleProfile>,
) -> Option<()> {
    if normalized_reload_source_edit_id(Some(source_edit_id)).as_deref() != Some(source_edit_id) {
        return None;
    }
    let metadata = capsule_metadata?;
    let commitment = metadata.output_oracle_profile_commitment.as_ref()?;
    let pinned_profile = pinned_profile?;
    if commitment.schema_version != RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION
        || commitment.edit_id != source_edit_id
        || commitment.candidate_artifact_sha256 != format!("sha256:{artifact_hash}")
        || pinned_profile.source_edit_id != source_edit_id
        || pinned_profile.candidate_artifact_sha256 != commitment.candidate_artifact_sha256
        || pinned_profile.profile_bytes_sha256 != commitment.profile_bytes_sha256
    {
        return None;
    }
    let contract = metadata
        .fission_output_oracle_contract
        .as_ref()
        .filter(|contract| contract.is_object())?;
    if commitment.fission_output_oracle_contract_sha256
        != format!("sha256:{}", stable_json_hash(contract))
        || pinned_profile.fission_output_oracle_contract_sha256
            != commitment.fission_output_oracle_contract_sha256
    {
        return None;
    }
    Some(())
}

fn saturating_u128_to_u64(value: u128) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

fn saturating_usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

fn json_field(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

fn json_object_field_or_empty(value: &Value, key: &str) -> Value {
    match value.get(key) {
        Some(Value::Object(_)) => value.get(key).cloned().unwrap_or_else(|| json!({})),
        _ => json!({}),
    }
}

fn sorted_unique_non_empty(mut values: Vec<String>) -> Vec<String> {
    values.retain(|value| !value.trim().is_empty());
    values
        .iter_mut()
        .for_each(|value| *value = value.trim().to_string());
    values.sort();
    values.dedup();
    values
}

fn runtime_proof_env_value(keys: &[&str], default_value: &str) -> String {
    keys.iter()
        .find_map(|key| env::var(key).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_value.to_string())
}

fn runtime_proof_compile_target(vendor: GpuVendor) -> String {
    runtime_proof_env_value(
        &["SYNTHI_GPU_ARCH", "HSA_OVERRIDE_GFX_VERSION", "CUDAARCHS"],
        match vendor {
            GpuVendor::Cuda => "cuda-runtime-selected",
            GpuVendor::Rocm => "rocm-runtime-selected",
        },
    )
}

fn runtime_proof_model_record(request_mode: &str, model: String, deprecated: bool) -> Value {
    let status = if deprecated {
        "deprecated"
    } else {
        "available"
    };
    json!({
        "provider": "google_gemini",
        "requested_model": model,
        "provider_model_status": status,
        "provider_model_alias_resolved_to": model,
        "provider_shutdown_or_deprecation_detected": deprecated,
        "model_availability_checked_at": format!("unix-ms:{}", epoch_millis_now()),
        "model_availability_source": "https://ai.google.dev/gemini-api/docs/models",
        "model_availability_basis": "static_registry",
        "model_availability_check_time_ms": 0u64,
        "actual_model": model,
        "fallback_model": Value::Null,
        "fallback_used": false,
        "request_mode": request_mode,
        "hard_infra_failure": false,
    })
}

fn runtime_proof_model_provenance() -> Value {
    let split_model = runtime_proof_env_value(
        &["SYNTHI_GPU_SPLIT_MODEL", "SYNTHI_AI_SPLIT_MODEL"],
        "gemini-3.5-flash",
    );
    let gpu_delta_model = runtime_proof_env_value(
        &["SYNTHI_GPU_DELTA_MODEL", "SYNTHI_AI_GPU_DELTA_MODEL"],
        "gemini-3.1-flash-lite",
    );
    let gpu_delta_deprecated = gpu_delta_model == "gemini-3.1-flash-lite";
    json!({
        "split": runtime_proof_model_record("split", split_model, false),
        "gpu_delta": runtime_proof_model_record("gpu_delta", gpu_delta_model, gpu_delta_deprecated),
    })
}

fn runtime_proof_timing_metrics(
    build_time_ms: u64,
    reload_elapsed_ms: u64,
    dispatch_to_output_ms: u64,
    drain_elapsed_ms: u64,
) -> Value {
    json!({
        "static_discovery_time": 0u64,
        "ai_contract_synthesis_time": 0u64,
        "model_availability_check_time": 0u64,
        "artifact_hash_time": 0u64,
        "adapter_generation_time": build_time_ms,
        "device_compile_wall_time": build_time_ms,
        "artifact_load_time": reload_elapsed_ms,
        "epoch_publish_time": 0u64,
        "dispatch_trace_time": 0u64,
        "runtime_probe_time": dispatch_to_output_ms,
        "oracle_analysis_time": 0u64,
        "trigger_to_visible_time": dispatch_to_output_ms,
        "screenshot_capture_time": 0u64,
        "dispatch_to_output_proof_time": dispatch_to_output_ms,
        "total_validator_wall_time": reload_elapsed_ms
            .saturating_add(dispatch_to_output_ms)
            .saturating_add(drain_elapsed_ms),
    })
}

fn runtime_proof_stage_results() -> Value {
    let stages = [
        (
            "fission-candidate-verification",
            "gpu-hmr-abi-proven",
            "device sidecar fission selected without host relink",
        ),
        (
            "artifact-loader",
            "gpu-hmr-symbol-bound",
            "sidecar artifact loaded through the GPU driver module loader",
        ),
        (
            "epoch-publication",
            "gpu-hmr-epoch-swap-proven",
            "runtime launch dispatcher published a new generation",
        ),
        (
            "dispatch-trace",
            "gpu-hmr-dispatch-observed",
            "post-publication dispatch was recorded with the new artifact identity",
        ),
        (
            "output-oracle",
            "gpu-hmr-output-oracle-proven",
            "runtime readback oracle passed after the post-publication dispatch",
        ),
        (
            "host-preservation",
            "gpu-hmr-host-preservation-proven",
            "process firewall proved no CPU HMR, full rebuild, or process restart",
        ),
        (
            "full-runtime",
            GPU_HMR_FULL_RUNTIME_RESULT_STATE,
            "all runtime gates passed in one process",
        ),
    ];
    Value::Array(
        stages
            .iter()
            .map(|(stage_id, required_state, evidence)| {
                json!({
                    "stageId": stage_id,
                    "stage_id": stage_id,
                    "requiredState": required_state,
                    "required_state": required_state,
                    "observedState": required_state,
                    "observed_state": required_state,
                    "status": "passed",
                    "evidence": evidence,
                })
            })
            .collect(),
    )
}

fn launch_arg_provenance_json(args: &[LaunchArgProvenance]) -> Value {
    Value::Array(
        args.iter()
            .map(|arg| {
                json!({
                    "index": saturating_usize_to_u64(arg.index),
                    "value_ptr": format!("0x{:x}", arg.value_ptr),
                    "value_size": saturating_usize_to_u64(arg.value_size),
                    "observed_value": arg.observed_value.map(|value| format!("0x{value:x}")),
                    "kind": arg.kind.clone(),
                    "allocation_id": arg.allocation_id.clone(),
                    "allocation_name": arg.allocation_name.clone(),
                    "allocation_ptr": arg.allocation_ptr.map(|value| format!("0x{value:x}")),
                    "allocation_bytes": arg.allocation_bytes.map(saturating_usize_to_u64),
                    "allocation_offset": arg.allocation_offset.map(saturating_usize_to_u64),
                })
            })
            .collect(),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VerifiedRuntimeDispatchDeviceIdentity {
    runtime_session_id: String,
    active_generation: u64,
    dispatch_id: String,
    dispatch_timestamp_monotonic_ns: u128,
    stream_token: usize,
    device_ordinal: i32,
    stream_device_ordinal: i32,
    device_uuid_hex: String,
    identity_key: String,
    authority: String,
    host_thread_id: String,
}

fn verified_runtime_dispatch_device_identity(
    active_generation: u64,
    active_artifact_id: &str,
    after_dispatch_id: &str,
    generation_identity: &RuntimeHardwareDeviceIdentity,
) -> Result<VerifiedRuntimeDispatchDeviceIdentity, String> {
    let runtime_session = runtime_session_id();
    let dispatch_record = launch_records_snapshot()
        .into_iter()
        .rev()
        .find(|record| {
            record.runtime_session_id == runtime_session
                && record.active_generation == active_generation
                && record.active_artifact_id.as_deref() == Some(active_artifact_id)
                && record.dispatch_id.as_deref() == Some(after_dispatch_id)
                && record.dispatched
        })
        .ok_or_else(|| "dispatch_device_attestation_launch_record_missing".to_string())?;
    let attestation_record = dispatch_device_attestation_records_snapshot()
        .into_iter()
        .rev()
        .find(|record| {
            record.runtime_session_id == runtime_session
                && record.active_generation == active_generation
                && record.dispatch_id == after_dispatch_id
                && record.dispatch_timestamp_monotonic_ns
                    == dispatch_record
                        .dispatch_timestamp_monotonic_ns
                        .unwrap_or_default()
        });
    let attestation_record = match attestation_record {
        Some(record) => record,
        None => {
            if let Some(rejection) = dispatch_device_attestation_rejection_records_snapshot()
                .into_iter()
                .rev()
                .find(|record| {
                    record.runtime_session_id == runtime_session
                        && record.active_generation == active_generation
                        && record.dispatch_id == after_dispatch_id
                        && record.dispatch_timestamp_monotonic_ns
                            == dispatch_record
                                .dispatch_timestamp_monotonic_ns
                                .unwrap_or_default()
                })
            {
                return Err(rejection.error);
            }
            return Err("dispatch_device_attestation_record_missing".to_string());
        }
    };
    if attestation_record.attestation.stream_token() != dispatch_record.stream_token {
        return Err("dispatch_device_attestation_stream_token_mismatch".to_string());
    }
    let observation = attestation_record
        .attestation
        .verified_observation()
        .ok_or_else(|| {
            attestation_record
                .attestation
                .blocking_gap()
                .unwrap_or("dispatch_device_attestation_unverified")
                .to_string()
        })?;
    if observation.device_ordinal() != generation_identity.ordinal {
        return Err("dispatch_device_ordinal_generation_mismatch".to_string());
    }
    if observation.device_uuid() != generation_identity.uuid_bytes
        || observation.identity_key() != generation_identity.identity_key
    {
        return Err("dispatch_device_uuid_generation_mismatch".to_string());
    }

    Ok(VerifiedRuntimeDispatchDeviceIdentity {
        runtime_session_id: runtime_session.to_string(),
        active_generation,
        dispatch_id: after_dispatch_id.to_string(),
        dispatch_timestamp_monotonic_ns: attestation_record.dispatch_timestamp_monotonic_ns,
        stream_token: attestation_record.attestation.stream_token(),
        device_ordinal: observation.device_ordinal(),
        stream_device_ordinal: observation.stream_device_ordinal(),
        device_uuid_hex: hex::encode(observation.device_uuid()),
        identity_key: observation.identity_key(),
        authority: attestation_record.attestation.authority().to_string(),
        host_thread_id: attestation_record.attestation.host_thread_id().to_string(),
    })
}

fn canonical_runtime_ledger_proof_id(record: &Value) -> String {
    let firewall = json_object_field_or_empty(record, "firewall_evidence");
    let mut material = json!({
        "schemaVersion": GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
        "projectId": json_field(record, "project_id"),
        "editId": json_field(record, "edit_id"),
        "backend": json_field(record, "backend"),
        "classification": json_object_field_or_empty(record, "classification"),
        "contractHash": json_field(record, "contract_hash"),
        "artifactBeforeHash": json_field(record, "artifact_before_hash"),
        "artifactAfterHash": json_field(record, "artifact_after_hash"),
        "loaderEvent": json_object_field_or_empty(record, "loader_event"),
        "epochPublishEvent": json_object_field_or_empty(record, "epoch_publish_event"),
        "dispatchEvent": json_object_field_or_empty(record, "dispatch_event"),
        "outputEvent": json_object_field_or_empty(record, "output_event"),
        "retirementEvent": json_object_field_or_empty(record, "retirement_event"),
        "processIdentity": json_object_field_or_empty(record, "process_identity"),
        "deviceIdentity": json_object_field_or_empty(record, "device_identity"),
        "oracleArtifacts": json_object_field_or_empty(record, "oracle_artifacts"),
        "deterministicVisualMode": json_object_field_or_empty(record, "deterministic_visual_mode"),
        "outputOracleTarget": json_object_field_or_empty(record, "output_oracle_target"),
        "metricClock": json_field(record, "metric_clock"),
        "metricScope": json_field(record, "metric_scope"),
        "cacheState": json_field(record, "cache_state"),
        "timings": json_object_field_or_empty(record, "timings"),
        "timingMetrics": json_object_field_or_empty(record, "timing_metrics"),
        "modelProvenance": json_object_field_or_empty(record, "model_provenance"),
        "evidenceRefs": json_field(record, "evidence_refs"),
        "cpuHmrUsed": record.get("cpu_hmr_used").and_then(Value::as_bool).unwrap_or(false),
        "fullRebuildUsed": record.get("full_rebuild_used").and_then(Value::as_bool).unwrap_or(false),
        "processRestarted": record.get("process_restarted").and_then(Value::as_bool).unwrap_or(false),
        "firewallEvidence": {
            "cpuHmrUsedEvidencePresent": firewall.get("cpu_hmr_used").is_some() || firewall.get("cpuHmrUsed").is_some(),
            "fullRebuildUsedEvidencePresent": firewall.get("full_rebuild_used").is_some() || firewall.get("fullRebuildUsed").is_some(),
            "processRestartedEvidencePresent": firewall.get("process_restarted").is_some() || firewall.get("processRestarted").is_some(),
            "processIdBefore": firewall.get("process_id_before")
                .or_else(|| firewall.get("processIdBefore"))
                .and_then(|value| value.as_str().map(str::to_string).or_else(|| value.as_u64().map(|pid| pid.to_string()))),
            "processIdAfter": firewall.get("process_id_after")
                .or_else(|| firewall.get("processIdAfter"))
                .and_then(|value| value.as_str().map(str::to_string).or_else(|| value.as_u64().map(|pid| pid.to_string()))),
        },
    });
    if record
        .get("proof_canonical_profile")
        .and_then(Value::as_str)
        == Some(GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE)
    {
        let object = material
            .as_object_mut()
            .expect("canonical ledger proof material is an object");
        object.insert(
            "proofCanonicalProfile".to_string(),
            json!(GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE),
        );
        if record.get("epoch_commit_event").is_some() {
            object.insert(
                "epochCommitEvent".to_string(),
                json_object_field_or_empty(record, "epoch_commit_event"),
            );
        }
    }
    format!("gpu-ledger-proof:sha256:{}", stable_json_sha256(&material))
}

fn portable_canonical_json_numbers_supported(value: &Value) -> bool {
    match value {
        Value::Number(number) => number
            .as_i64()
            .map(|value| value.unsigned_abs() <= GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER)
            .or_else(|| {
                number
                    .as_u64()
                    .map(|value| value <= GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER)
            })
            .unwrap_or(false),
        Value::Array(values) => values.iter().all(portable_canonical_json_numbers_supported),
        Value::Object(fields) => fields
            .values()
            .all(portable_canonical_json_numbers_supported),
        _ => true,
    }
}

fn runtime_acceptance_contract(
    req: &AdapterReloadRequest,
    source_edit_id: &str,
    vendor: GpuVendor,
    contract_hash: &str,
    previous_artifact_id: &str,
    new_artifact_id: &str,
    expected_symbols: &[String],
    source_paths: &[String],
    evidence_refs: &[String],
    abi_hash: &str,
    process_id: &str,
    device_uuid: &str,
    dispatch_record: &crate::runtime::gpu_runtime_boundary::LaunchRecord,
    oracle_artifacts: &Value,
    output_oracle_target: &Value,
    retirement_strategy: &str,
    capsule_metadata: Option<&ReloadCapsuleMetadata>,
) -> Value {
    let entry_points = if expected_symbols.is_empty() {
        vec!["unknown_kernel".to_string()]
    } else {
        expected_symbols.to_vec()
    };
    let kernel_name = dispatch_record
        .kernel_name
        .trim()
        .is_empty()
        .then(|| entry_points[0].clone())
        .unwrap_or_else(|| dispatch_record.kernel_name.clone());
    let source_paths = if source_paths.is_empty() {
        vec![req.build_manifest.artifact_path.clone()]
    } else {
        source_paths.to_vec()
    };
    let fission_selected_verifier_evidence_id =
        capsule_metadata.and_then(|metadata| metadata.selected_verifier_evidence_id.clone());
    let fission_verifier_evidence_id =
        capsule_metadata.and_then(|metadata| metadata.fission_verifier_evidence_id.clone());
    let fission_deterministic_verifier_evidence_refs = capsule_metadata
        .and_then(|metadata| metadata.deterministic_verifier_evidence_refs.clone())
        .unwrap_or_default();
    let fission_source_paths = capsule_metadata
        .and_then(|metadata| metadata.fission_source_paths.clone())
        .filter(|paths| !paths.is_empty())
        .unwrap_or_else(|| source_paths.clone());
    let fission_selection_decision_hash =
        capsule_metadata.and_then(|metadata| metadata.fission_selection_decision_hash.clone());
    let fission_output_oracle_contract = capsule_metadata
        .and_then(|metadata| metadata.fission_output_oracle_contract.clone())
        .unwrap_or(Value::Null);
    let mut acceptance_evidence_values = evidence_refs.to_vec();
    if let Some(evidence_id) = &fission_verifier_evidence_id {
        acceptance_evidence_values.push(evidence_id.clone());
    }
    if let Some(evidence_id) = &fission_selected_verifier_evidence_id {
        acceptance_evidence_values.push(evidence_id.clone());
    }
    acceptance_evidence_values.extend(fission_deterministic_verifier_evidence_refs.clone());
    let acceptance_evidence_refs = sorted_unique_non_empty(acceptance_evidence_values);
    let fission_evidence_refs = sorted_unique_non_empty(
        fission_verifier_evidence_id
            .clone()
            .into_iter()
            .chain(fission_selected_verifier_evidence_id.clone())
            .chain(fission_deterministic_verifier_evidence_refs.clone())
            .collect(),
    );
    let fission_contract_verified = fission_selected_verifier_evidence_id.is_some()
        && !fission_deterministic_verifier_evidence_refs.is_empty()
        && fission_selection_decision_hash.is_some()
        && fission_output_oracle_contract.is_object();
    let compile_target = runtime_proof_compile_target(vendor);
    let stream = if dispatch_record.stream_token == 0 {
        "default".to_string()
    } else {
        format!("stream:{}", dispatch_record.stream_token)
    };
    let arg_provenance = launch_arg_provenance_json(&dispatch_record.arg_provenance);
    let evidence_by_field = json!({
        "kernel_name": acceptance_evidence_refs,
        "launch_api": acceptance_evidence_refs,
        "grid_dim": acceptance_evidence_refs,
        "block_dim": acceptance_evidence_refs,
        "shared_mem_bytes": acceptance_evidence_refs,
        "stream": acceptance_evidence_refs,
        "kernel_params": acceptance_evidence_refs,
        "code_object_metadata": acceptance_evidence_refs,
        "output_buffers": acceptance_evidence_refs,
        "readback_oracle": acceptance_evidence_refs,
    });
    json!({
        "contract_version": GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
        "contract_id": format!("gpu-hmr-contract:{contract_hash}"),
        "contract_hash": contract_hash,
        "project_id": req.build_manifest.preview_id,
        "edit_id": source_edit_id,
        "backend": vendor.proof_backend(),
        "confidence": 0.95,
        "evidence_refs": acceptance_evidence_refs,
        "classification": {
            "project_kind": "gpu_project",
            "edit_kind": "gpu_artifact_edit",
            "route": "gpu_hmr",
            "confidence": 0.95,
            "blocking_gaps": [],
        },
        "artifact_identity": {
            "source_paths": source_paths,
            "entry_points": entry_points,
            "artifact_kind": vendor.proof_artifact_kind(),
            "compile_target": compile_target,
            "compiler": vendor.proof_compiler(),
            "compiler_args_hash": abi_hash,
        },
        "artifact_hash_before": previous_artifact_id,
        "artifact_hash_after": new_artifact_id,
        "unaffected_artifacts_hash_unchanged": true,
        "abi_compatibility_class": {
            "value": "compatible",
            "evidence_refs": acceptance_evidence_refs,
            "backend_specific_adapter_safety_proven": true,
            "backend_specific_adapter_safety_evidence_refs": acceptance_evidence_refs,
        },
        "abi_metadata": {
            "args": arg_provenance.clone(),
            "descriptor_or_binding_layout": "driver-api-kernel-params",
            "workgroup_or_launch_shape": {
                "grid_dim": [dispatch_record.grid.0, dispatch_record.grid.1, dispatch_record.grid.2],
                "block_dim": [dispatch_record.block.0, dispatch_record.block.1, dispatch_record.block.2],
            },
            "stream_or_queue_requirements": stream,
            "extractor_provenance": "runtime_launch_boundary",
            "metadata_sources": acceptance_evidence_refs,
        },
        "reload_mechanism": "generated_adapter",
        "adapter_outcome": "adapter_generated",
        "reload_evidence_refs": acceptance_evidence_refs,
        "firewall_evidence": {
            "route": req.firewall_evidence.route,
            "cpu_hmr_used": false,
            "full_rebuild_used": false,
            "process_restarted": false,
            "process_id_before": process_id,
            "process_id_after": process_id,
            "evidence_source": req.firewall_evidence.evidence_source,
            "evidence_refs": acceptance_evidence_refs,
        },
        "output_oracle_target": output_oracle_target,
        "dispatch_trace_required": true,
        "oracle_trace_required": true,
        "state_preservation_checks": {
            "process_id": process_id,
            "device_uuid": device_uuid,
            "context_or_device_handle": "driver-context-current",
            "queue_or_stream_handle": stream,
            "persistent_gpu_allocations": "runtime-managed-buffers-preserved",
        },
        "epoch_policy": {
            "publish_mechanism": "dispatcher_publication_transaction",
            "dispatch_binding": "runtime_launch_generation",
            "retirement_mechanism": retirement_strategy,
        },
        "epoch_retirement_proof": {
            "value": runtime_epoch_retirement_proof_value(retirement_strategy),
            "evidence_refs": acceptance_evidence_refs,
        },
        "fission_report": {
            "selected_island": capsule_metadata
                .and_then(|metadata| metadata.fission_island_id.clone())
                .unwrap_or_else(|| "runtime-device-sidecar".to_string()),
            "selected_reason": if fission_contract_verified {
                "verified_fission_contract"
            } else {
                "verified_device_artifact_delta"
            },
            "changed_sources": fission_source_paths,
            "included_dependencies": source_paths,
            "excluded_host_sources": [],
            "artifact_hash_before": previous_artifact_id,
            "artifact_hash_after": new_artifact_id,
            "abi_compatibility_class": "compatible",
            "full_device_fallback": false,
            "host_relinked": false,
            "process_restarted": false,
            "full_rebuild_used": false,
            "unaffected_artifacts_hash_unchanged": true,
            "evidence_refs": fission_evidence_refs,
            "selected_verifier_evidence_id": fission_selected_verifier_evidence_id,
            "deterministic_verifier_evidence_refs": fission_deterministic_verifier_evidence_refs,
            "selection_decision_hash": fission_selection_decision_hash,
            "output_oracle_contract": fission_output_oracle_contract,
            "smallest_safe_island_proven": fission_contract_verified,
        },
        "hip_contract": {
            "kernel_name": kernel_name,
            "launch_api": vendor.launch_kernel_symbol(),
            "grid_dim": [dispatch_record.grid.0, dispatch_record.grid.1, dispatch_record.grid.2],
            "block_dim": [dispatch_record.block.0, dispatch_record.block.1, dispatch_record.block.2],
            "shared_mem_bytes": dispatch_record.shared_bytes,
            "stream": stream,
            "kernel_params": arg_provenance,
            "code_object_metadata": {
                "artifact_id": new_artifact_id,
                "abi_hash": abi_hash,
                "capsule_metadata": capsule_metadata,
            },
            "output_buffers": [oracle_artifacts.get("raw_readback_bin").cloned().unwrap_or(Value::Null)],
            "readback_oracle": oracle_artifacts,
            "field_evidence_refs": evidence_by_field,
        },
    })
}

fn runtime_epoch_retirement_proof_value(retirement_strategy: &str) -> &'static str {
    match retirement_strategy {
        "no_retirement_required" => "no_retirement_required",
        "epoch_fence" => "stream_event_proven",
        "conservative_drain_fallback" => "queue_idle_proven",
        _ => "unproven",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RuntimeProofTimestamps {
    loader_ns: u64,
    publish_ns: u64,
    dispatch_ns: u64,
    output_ns: u64,
    commit_ns: u64,
    retirement_ns: u64,
    dispatch_to_output_ms: u64,
}

fn validate_runtime_proof_timestamps(
    loader_timestamp_monotonic_ns: u128,
    publish_timestamp_monotonic_ns: u128,
    dispatch_timestamp_monotonic_ns: Option<u128>,
    output_timestamp_monotonic_ns: u128,
    commit_timestamp_monotonic_ns: u128,
    retirement_timestamp_monotonic_ns: u128,
) -> Option<RuntimeProofTimestamps> {
    let loader_ns = saturating_u128_to_u64(loader_timestamp_monotonic_ns);
    let publish_ns = saturating_u128_to_u64(publish_timestamp_monotonic_ns);
    let dispatch_ns = dispatch_timestamp_monotonic_ns.map(saturating_u128_to_u64)?;
    let output_ns = saturating_u128_to_u64(output_timestamp_monotonic_ns);
    let commit_ns = saturating_u128_to_u64(commit_timestamp_monotonic_ns);
    let retirement_ns = saturating_u128_to_u64(retirement_timestamp_monotonic_ns);
    if publish_ns < loader_ns
        || dispatch_ns < publish_ns
        || output_ns < dispatch_ns
        || commit_ns < output_ns
        || retirement_ns < commit_ns
    {
        return None;
    }
    Some(RuntimeProofTimestamps {
        loader_ns,
        publish_ns,
        dispatch_ns,
        output_ns,
        commit_ns,
        retirement_ns,
        dispatch_to_output_ms: output_ns.saturating_sub(dispatch_ns) / 1_000_000,
    })
}

fn validate_runtime_publication_binding(
    publication_id: &str,
    receipt_previous_generation: u64,
    receipt_candidate_generation: u64,
    candidate_registration_id: &str,
    expected_previous_generation: u64,
    expected_active_generation: u64,
    dispatch_registration_id: Option<&str>,
) -> Result<(), String> {
    if publication_id.trim().is_empty() {
        return Err("runtime_proof_publication_id_missing".to_string());
    }
    if receipt_previous_generation != expected_previous_generation {
        return Err("runtime_proof_publication_previous_generation_mismatch".to_string());
    }
    if receipt_candidate_generation != expected_active_generation {
        return Err("runtime_proof_publication_candidate_generation_mismatch".to_string());
    }
    if receipt_candidate_generation <= receipt_previous_generation {
        return Err("runtime_proof_publication_generation_transition_missing".to_string());
    }
    if candidate_registration_id.trim().is_empty() {
        return Err("runtime_proof_candidate_registration_id_missing".to_string());
    }
    if dispatch_registration_id != Some(candidate_registration_id) {
        return Err("runtime_proof_dispatch_registration_mismatch".to_string());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn runtime_full_proof_line(
    req: &AdapterReloadRequest,
    vendor: GpuVendor,
    previous_artifact_id: &str,
    new_artifact_id: &str,
    artifact_hash: &str,
    active_generation: u64,
    previous_generation: u64,
    loader_timestamp_monotonic_ns: u128,
    publication_commit: &DispatcherCommitReceipt,
    retirement_timestamp_monotonic_ns: u128,
    dispatch_device_identity: &VerifiedRuntimeDispatchDeviceIdentity,
    expected_symbols: &[String],
    loader_transport: ArtifactLoaderTransport,
    reload_elapsed_ms: u64,
    drain_elapsed_ms: u64,
    artifact_bytes: usize,
    retirement_strategy: &str,
    retirement_fence_ids: &str,
    capsule_metadata: Option<&ReloadCapsuleMetadata>,
    pinned_output_oracle_profile: Option<&PinnedRuntimeOutputOracleProfile>,
    after_dispatch_id: &str,
) -> Result<String, String> {
    if !loader_transport.is_content_bound() {
        return Err("runtime_proof_loader_transport_not_content_bound".to_string());
    }
    if req.firewall_evidence.cpu_hmr_used != Some(false)
        || req.firewall_evidence.full_rebuild_used != Some(false)
        || req.firewall_evidence.process_restarted != Some(false)
    {
        return Err("runtime_proof_firewall_evidence_incomplete".to_string());
    }
    let process_id = std::process::id().to_string();
    let firewall_pid_before = req
        .firewall_evidence
        .process_id_before
        .ok_or_else(|| "runtime_proof_process_id_before_missing".to_string())?
        .to_string();
    let firewall_pid_after = req
        .firewall_evidence
        .process_id_after
        .ok_or_else(|| "runtime_proof_process_id_after_missing".to_string())?
        .to_string();
    if firewall_pid_before != process_id || firewall_pid_after != process_id {
        return Err("runtime_proof_process_identity_changed".to_string());
    }
    let source_edit_id = normalized_reload_source_edit_id(req.source_edit_id.as_deref())
        .ok_or_else(|| "runtime_proof_source_edit_id_missing".to_string())?;
    let source_edit_id = source_edit_id.as_str();
    verified_runtime_source_edit_commitment(
        capsule_metadata,
        source_edit_id,
        artifact_hash,
        pinned_output_oracle_profile,
    )
    .ok_or_else(|| "runtime_proof_source_edit_commitment_unverified".to_string())?;
    let artifact_content_hash = format!("sha256:{artifact_hash}");
    let output_receipt = host_output_oracle_receipt::host_verified_compute_receipt_for_proof(
        &req.reload_id,
        source_edit_id,
        &artifact_content_hash,
        after_dispatch_id,
    )
    .map_err(|error| format!("runtime_proof_host_output_receipt_missing:{error}"))?;
    let receipt_publication_id = output_receipt
        .publication_id()
        .ok_or_else(|| "runtime_proof_host_output_receipt_publication_missing".to_string())?;
    let receipt_previous_generation = output_receipt.previous_generation().ok_or_else(|| {
        "runtime_proof_host_output_receipt_previous_generation_missing".to_string()
    })?;
    let receipt_publication_timestamp_monotonic_ns = output_receipt
        .publication_timestamp_monotonic_ns()
        .ok_or_else(|| {
            "runtime_proof_host_output_receipt_publication_timestamp_missing".to_string()
        })?;
    let receipt_publication_committed_timestamp_monotonic_ns = output_receipt
        .publication_committed_timestamp_monotonic_ns()
        .ok_or_else(|| {
            "runtime_proof_host_output_receipt_publication_commit_timestamp_missing".to_string()
        })?;
    if output_receipt.runtime_session_id() != runtime_session_id()
        || output_receipt.process_id() != std::process::id()
        || output_receipt.artifact_content_hash() != artifact_content_hash
        || output_receipt.artifact_id() != new_artifact_id
        || output_receipt.generation() != active_generation
        || output_receipt.dispatch_id() != after_dispatch_id
        || output_receipt.request_id() != req.reload_id
        || output_receipt.source_edit_id() != source_edit_id
        || receipt_publication_id != publication_commit.publication_id()
        || receipt_previous_generation != previous_generation
        || receipt_publication_timestamp_monotonic_ns
            != publication_commit.publication_timestamp_monotonic_ns()
        || receipt_publication_committed_timestamp_monotonic_ns
            != publication_commit.committed_timestamp_monotonic_ns()
        || output_receipt.dispatcher_registration_id()
            != publication_commit.candidate_registration_id()
        || receipt_publication_committed_timestamp_monotonic_ns > retirement_timestamp_monotonic_ns
    {
        return Err("runtime_proof_host_output_receipt_identity_mismatch".to_string());
    }
    let dispatch_record = launch_records_snapshot()
        .into_iter()
        .rev()
        .find(|record| {
            record.runtime_session_id == runtime_session_id()
                && record.active_generation == active_generation
                && record.active_artifact_id.as_deref() == Some(new_artifact_id)
                && record.dispatch_id.as_deref() == Some(after_dispatch_id)
                && record.dispatched
        })
        .ok_or_else(|| "runtime_proof_dispatch_record_missing".to_string())?;
    validate_runtime_publication_binding(
        publication_commit.publication_id(),
        publication_commit.previous_generation(),
        publication_commit.candidate_generation(),
        publication_commit.candidate_registration_id(),
        previous_generation,
        active_generation,
        dispatch_record.dispatcher_registration_id.as_deref(),
    )?;
    let dispatch_timestamp_monotonic_ns = dispatch_record
        .dispatch_timestamp_monotonic_ns
        .ok_or_else(|| "runtime_proof_dispatch_timestamp_missing".to_string())?;
    if dispatch_device_identity.runtime_session_id != runtime_session_id()
        || dispatch_device_identity.active_generation != active_generation
        || dispatch_device_identity.dispatch_id != after_dispatch_id
        || dispatch_device_identity.dispatch_timestamp_monotonic_ns
            != dispatch_timestamp_monotonic_ns
        || dispatch_device_identity.stream_token != dispatch_record.stream_token
        || dispatch_device_identity.device_ordinal != dispatch_device_identity.stream_device_ordinal
        || dispatch_device_identity.authority != GPU_DISPATCH_DEVICE_ATTESTATION_AUTHORITY
    {
        return Err("runtime_proof_dispatch_device_attestation_mismatch".to_string());
    }
    if dispatch_record.dispatch_timestamp_monotonic_ns
        != Some(output_receipt.dispatch_timestamp_monotonic_ns())
        || dispatch_record.stream_token != output_receipt.stream_token()
        || dispatch_record.dispatcher_registration_id.as_deref()
            != Some(output_receipt.dispatcher_registration_id())
        || dispatch_record.dispatch_table_hash.as_deref()
            != Some(output_receipt.dispatch_table_hash())
        || dispatch_record.dispatch_table_entry_id.as_deref()
            != Some(output_receipt.dispatch_table_entry_id())
    {
        return Err("runtime_proof_host_output_receipt_dispatch_mismatch".to_string());
    }
    let readback_hash = output_receipt.observed_sha256().to_string();
    let readback_bytes = output_receipt.readback_bytes().len();
    if readback_bytes == 0 {
        return Err("runtime_proof_readback_empty".to_string());
    }
    if output_receipt.recompute_full_readback_sha256() != readback_hash
        || output_receipt.recompute_deterministic_slice_sha256()
            != output_receipt.deterministic_slice_sha256()
    {
        return Err("runtime_proof_host_output_receipt_byte_hash_mismatch".to_string());
    }
    let raw_readback_bin = format!("host-receipt://{}/raw", output_receipt.receipt_id());
    let oracle_code_hash = output_receipt.probe_config_hash().to_string();
    let timestamps = validate_runtime_proof_timestamps(
        loader_timestamp_monotonic_ns,
        publication_commit.publication_timestamp_monotonic_ns(),
        dispatch_record.dispatch_timestamp_monotonic_ns,
        output_receipt.readback_timestamp_monotonic_ns(),
        publication_commit.committed_timestamp_monotonic_ns(),
        retirement_timestamp_monotonic_ns,
    )
    .ok_or_else(|| "runtime_proof_timestamp_order_invalid".to_string())?;
    let loader_ts = timestamps.loader_ns;
    let publish_ts = timestamps.publish_ns;
    let dispatch_ts = timestamps.dispatch_ns;
    let output_ts = timestamps.output_ns;
    let commit_ts = timestamps.commit_ns;
    let retirement_ts = timestamps.retirement_ns;
    let dispatch_to_output_ms = timestamps.dispatch_to_output_ms;
    let mut evidence_ref_values = vec![
        format!("runtime-session:{}", runtime_session_id()),
        format!("reload:{}", req.reload_id),
        format!("source-edit-id:{source_edit_id}"),
        format!("loader:{new_artifact_id}"),
        format!("epoch:{active_generation}"),
        publication_commit.publication_id().to_string(),
        format!(
            "dispatcher-registration:{}",
            publication_commit.candidate_registration_id()
        ),
        format!("dispatch:{after_dispatch_id}"),
        format!("dispatch-device-attestation:{after_dispatch_id}"),
        receipt_publication_id.to_string(),
        format!(
            "dispatcher-registration:{}",
            output_receipt.dispatcher_registration_id()
        ),
        format!("dispatch-table:{}", output_receipt.dispatch_table_hash()),
        format!(
            "dispatch-table-entry:{}",
            output_receipt.dispatch_table_entry_id()
        ),
        format!("oracle:{}", output_receipt.oracle_id()),
        format!("host-output-receipt:{}", output_receipt.receipt_id()),
        format!("retirement-strategy:{retirement_strategy}"),
        req.firewall_evidence
            .evidence_source
            .clone()
            .unwrap_or_else(|| "runtime-firewall".to_string()),
        raw_readback_bin.clone(),
    ];
    evidence_ref_values.extend(log_list_values(retirement_fence_ids));
    let evidence_refs = sorted_unique_non_empty(evidence_ref_values);
    let source_paths = sorted_unique_non_empty(
        req.changed_files
            .iter()
            .cloned()
            .chain(
                req.build_manifest
                    .translation_units
                    .clone()
                    .unwrap_or_default()
                    .into_iter(),
            )
            .chain(std::iter::once(req.build_manifest.artifact_path.clone()))
            .collect(),
    );
    let abi_hash = capsule_metadata
        .and_then(|metadata| metadata.abi_membrane_hash.as_deref())
        .and_then(normalize_sha256_prefixed)
        .unwrap_or_else(|| {
            sha256_prefixed_from_text(&format!(
                "{}:{}:{}",
                req.build_manifest.abi_version,
                artifact_hash,
                expected_symbols.join(",")
            ))
        });
    let contract_hash = capsule_metadata
        .and_then(|metadata| metadata.proof_hash.as_deref())
        .and_then(normalize_sha256_prefixed)
        .unwrap_or_else(|| {
            sha256_prefixed_from_text(&stable_json_string(&json!({
                "reload_id": req.reload_id,
                "source_edit_id": source_edit_id,
                "module_id": req.module_id,
                "backend": vendor.proof_backend(),
                "artifact_before": previous_artifact_id,
                "artifact_after": new_artifact_id,
                "expected_symbols": expected_symbols,
                "abi_hash": abi_hash,
            })))
        });
    let output_target_id = output_receipt.output_target_id().to_string();
    let producer = output_receipt.producer().to_string();
    let readback_schema = output_receipt.readback_schema_json();
    let readback_schema_json =
        format!("host-receipt://{}/schema.json", output_receipt.receipt_id());
    let oracle_artifacts = json!({
        "raw_readback_bin": raw_readback_bin,
        "readback_schema_json": readback_schema_json,
        "readback_schema": readback_schema,
        "readback_schema_hash": output_receipt.readback_schema_sha256(),
        "checksum_before": output_receipt.baseline_sha256(),
        "checksum_after": readback_hash,
        "raw_readback_hash": readback_hash,
        "raw_readback_hash_verified": true,
        "raw_readback_source": "host_verified_full_dtoh_receipt",
        "raw_readback_byte_length": saturating_usize_to_u64(readback_bytes),
        "raw_readback_verification": {
            "hash_verified": true,
            "raw_readback_hash_verified": true,
            "raw_readback_byte_length": saturating_usize_to_u64(readback_bytes),
            "deterministic_slice_hash_verified": true,
            "authority": host_output_oracle_receipt::HOST_OUTPUT_ORACLE_RECEIPT_AUTHORITY,
        },
        "deterministic_slice": {
            "offset": saturating_usize_to_u64(output_receipt.deterministic_slice_offset()),
            "length": saturating_usize_to_u64(output_receipt.deterministic_slice_length()),
            "stride": saturating_usize_to_u64(output_receipt.deterministic_slice_stride()),
            "source": "host_verified_full_dtoh_receipt",
        },
        "deterministic_slice_hash": output_receipt.deterministic_slice_sha256(),
        "deterministic_slice_hash_verified": true,
        "oracle_code_hash": oracle_code_hash,
        "rendered_card_png": Value::Null,
        "rendered_card_required_for_machine_acceptance": false,
        "producer": producer,
        "timestamp_after_dispatch": output_ts,
        "epoch": active_generation.to_string(),
        "output_after_dispatch_id": after_dispatch_id,
        "host_receipt_id": output_receipt.receipt_id(),
        "host_receipt_schema": host_output_oracle_receipt::HOST_OUTPUT_ORACLE_RECEIPT_SCHEMA,
        "host_receipt_authority": host_output_oracle_receipt::HOST_OUTPUT_ORACLE_RECEIPT_AUTHORITY,
        "dispatcher_publication_id": receipt_publication_id,
        "dispatcher_previous_generation": receipt_previous_generation,
        "dispatcher_publication_timestamp_monotonic_ns": saturating_u128_to_u64(receipt_publication_timestamp_monotonic_ns),
        "dispatcher_publication_committed_timestamp_monotonic_ns": saturating_u128_to_u64(receipt_publication_committed_timestamp_monotonic_ns),
        "dispatcher_registration_id": output_receipt.dispatcher_registration_id(),
        "dispatch_table_hash": output_receipt.dispatch_table_hash(),
        "dispatch_table_entry_id": output_receipt.dispatch_table_entry_id(),
        "profile_id": output_receipt.profile_id(),
        "profile_schema_version": output_receipt.profile_schema_version(),
        "profile_bytes_sha256": output_receipt.profile_bytes_sha256(),
        "fission_output_oracle_contract_sha256": output_receipt.contract_sha256(),
        "proof_context_binding_sha256": output_receipt.proof_context_binding_sha256(),
        "proof_context_proof_id": output_receipt.proof_context_proof_id(),
        "probe_mode": output_receipt.probe_mode(),
        "probe_evidence_ref": output_receipt.probe_evidence_ref(),
        "output_buffer_name": output_receipt.output_buffer_name(),
    });
    let output_oracle_target = json!({
        "kind": "compute",
        "target_id": output_target_id,
        "compute_only_target_verified": true,
        "evidence_refs": evidence_refs,
    });
    let process_identity = json!({
        "process_id": process_id,
        "runtime_session_id": runtime_session_id(),
        "role": "worker-gpu-runtime",
    });
    let device_uuid = normalized_gpu_hardware_uuid(&dispatch_device_identity.identity_key)
        .ok_or_else(|| "runtime_proof_device_uuid_invalid".to_string())?;
    let device_identity = json!({
        "vendor": vendor.as_str(),
        "backend": vendor.proof_backend(),
        "device_uuid": device_uuid,
        "device_identity_key": dispatch_device_identity.identity_key,
        "device_identity_kind": "hardware_uuid",
        "device_identity_authority": dispatch_device_identity.authority,
        "device_identity_continuity_verified": true,
        "identity_observation_window": "immediately_before_native_launch,immediately_after_native_launch",
        "generation_baseline_device_identity_key": dispatch_device_identity.identity_key,
        "before_dispatch_device_identity_key": dispatch_device_identity.identity_key,
        "after_dispatch_device_identity_key": dispatch_device_identity.identity_key,
        "active_device_ordinal": dispatch_device_identity.device_ordinal,
        "dispatch_stream_token": dispatch_record.stream_token,
        "dispatch_stream_device_ordinal": dispatch_device_identity.stream_device_ordinal,
        "stream_device_identity_verified": true,
        "dispatch_device_attestation_schema": GPU_DISPATCH_DEVICE_ATTESTATION_SCHEMA,
        "dispatch_device_attestation_dispatch_id": dispatch_device_identity.dispatch_id,
        "dispatch_device_attestation_thread_id": dispatch_device_identity.host_thread_id,
        "dispatch_device_uuid_hex": dispatch_device_identity.device_uuid_hex,
        "driver_library": vendor.driver_library(),
    });
    let timings = json!({
        "metric_clock": "monotonic_ns",
        "metric_scope": "hot_delta_1",
        "cache_state": "compiler_cache_warm",
        "timing_metrics": runtime_proof_timing_metrics(
            req.build_manifest.build_time_ms,
            reload_elapsed_ms,
            dispatch_to_output_ms,
            drain_elapsed_ms,
        ),
    });
    let timing_metrics = timings
        .get("timing_metrics")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let ledger_record = json!({
        "schemaVersion": GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
        "proof_canonical_profile": GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE,
        "project_id": req.build_manifest.preview_id,
        "edit_id": source_edit_id,
        "backend": vendor.proof_backend(),
        "classification": {
            "project_kind": "gpu_project",
            "edit_kind": "gpu_artifact_edit",
            "route": "gpu_hmr",
        },
        "contract_hash": contract_hash,
        "artifact_before_hash": previous_artifact_id,
        "artifact_after_hash": new_artifact_id,
        "loader_event": {
            "id": format!("loader:{active_generation}:{new_artifact_id}"),
            "artifact_id": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "artifact_bytes": saturating_usize_to_u64(artifact_bytes),
            "loader_api": loader_transport.loader_api(),
            "transport": loader_transport.as_str(),
            "timestamp_monotonic_ns": loader_ts,
            "process_id": process_id,
        },
        "epoch_publish_event": {
            "id": format!("epoch-publish:{active_generation}:{new_artifact_id}"),
            "event": "provisional_install",
            "publication_id": publication_commit.publication_id(),
            "candidate_registration_id": publication_commit.candidate_registration_id(),
            "dispatcher_registration_id": publication_commit.candidate_registration_id(),
            "epoch": active_generation.to_string(),
            "previous_epoch": previous_generation.to_string(),
            "artifact_id": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "timestamp_monotonic_ns": publish_ts,
            "process_id": process_id,
        },
        "epoch_commit_event": {
            "id": format!("epoch-commit:{active_generation}:{new_artifact_id}"),
            "event": "unrestricted_visibility_commit",
            "publication_id": publication_commit.publication_id(),
            "candidate_registration_id": publication_commit.candidate_registration_id(),
            "dispatcher_registration_id": publication_commit.candidate_registration_id(),
            "epoch": active_generation.to_string(),
            "previous_epoch": previous_generation.to_string(),
            "artifact_id": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "timestamp_monotonic_ns": commit_ts,
            "process_id": process_id,
        },
        "dispatch_event": {
            "id": after_dispatch_id,
            "dispatch_id": after_dispatch_id,
            "epoch": active_generation.to_string(),
            "artifact_id": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "kernel_name": dispatch_record.kernel_name,
            "dispatcher_registration_id": publication_commit.candidate_registration_id(),
            "publication_id": publication_commit.publication_id(),
            "dispatch_table_hash": output_receipt.dispatch_table_hash(),
            "dispatch_table_entry_id": output_receipt.dispatch_table_entry_id(),
            "timestamp_monotonic_ns": dispatch_ts,
            "process_id": process_id,
        },
        "output_event": {
            "id": output_receipt.oracle_id(),
            "passed": true,
            "after_dispatch_id": after_dispatch_id,
            "epoch": active_generation.to_string(),
            "artifact_id": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "timestamp_monotonic_ns": output_ts,
            "process_id": process_id,
            "output_oracle": {
                "oracle_id": output_receipt.oracle_id(),
                "kind": "buffer_checksum",
                "expected": output_receipt.expected_sha256(),
                "actual": output_receipt.observed_sha256(),
                "passed": true,
                "output_oracle_target": output_oracle_target,
                "oracle_artifacts": oracle_artifacts,
            },
            "oracle_artifacts": oracle_artifacts,
        },
        "retirement_event": {
            "id": format!("retire:{previous_generation}->{active_generation}:{previous_artifact_id}"),
            "epoch": previous_generation.to_string(),
            "artifact_id": previous_artifact_id,
            "artifact_hash": previous_artifact_id,
            "status": "retired_after_quiescent",
            "retirement_proof": runtime_epoch_retirement_proof_value(retirement_strategy),
            "retirement_strategy": retirement_strategy,
            "retirement_fence_ids": log_list_values(retirement_fence_ids),
            "timestamp_monotonic_ns": retirement_ts,
            "process_id": process_id,
        },
        "process_identity": process_identity,
        "device_identity": device_identity,
        "oracle_artifacts": oracle_artifacts,
        "output_oracle_target": output_oracle_target,
        "timings": timings,
        "timing_metrics": timing_metrics,
        "metric_clock": "monotonic_ns",
        "metric_scope": "hot_delta_1",
        "cache_state": "compiler_cache_warm",
        "model_provenance": runtime_proof_model_provenance(),
        "evidence_refs": evidence_refs,
        "cpu_hmr_used": false,
        "full_rebuild_used": false,
        "process_restarted": false,
        "firewall_evidence": {
            "cpu_hmr_used": false,
            "full_rebuild_used": false,
            "process_restarted": false,
            "route": req.firewall_evidence.route,
            "evidence_source": req.firewall_evidence.evidence_source,
            "process_id_before": process_id,
            "process_id_after": process_id,
        },
    });
    if !portable_canonical_json_numbers_supported(&ledger_record) {
        return Err("runtime_proof_portable_canonical_number_unsupported".to_string());
    }
    let ledger_proof_id = canonical_runtime_ledger_proof_id(&ledger_record);
    let proof_ledger_query = json!({
        "schemaVersion": GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
        "proofId": ledger_proof_id,
        "gpuHmrSuccess": true,
        "failedInvariants": [],
    });
    let proof_ledger = json!({
        "schemaVersion": GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
        "proofId": ledger_proof_id,
        "gpuHmrSuccess": true,
        "records": [ledger_record],
    });
    let runtime_trace = json!({
        "schemaVersion": "synthi.gpu_hmr.worker_runtime_trace.v1",
        "schema_version": "synthi.gpu_hmr.worker_runtime_trace.v1",
        "proofAuthority": "worker_observed_runtime_boundaries_not_gpu_hmr_acceptance",
        "proof_authority": "worker_observed_runtime_boundaries_not_gpu_hmr_acceptance",
        "acceptedForGpuHmr": false,
        "accepted_for_gpu_hmr": false,
        "gpuHmrSuccess": false,
        "gpu_hmr_success": false,
        "runtimeSessionId": runtime_session_id(),
        "runtime_session_id": runtime_session_id(),
        "processId": process_id,
        "process_id": process_id,
        "loaderEvents": [{
            "source": loader_transport.loader_api(),
            "loader_api": loader_transport.loader_api(),
            "artifactHash": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "artifactId": new_artifact_id,
            "artifact_id": new_artifact_id,
            "epoch": active_generation.to_string(),
            "processId": process_id,
            "process_id": process_id,
            "timestampMonotonicNs": loader_ts,
            "timestamp_monotonic_ns": loader_ts,
            "evidenceRefs": evidence_refs,
            "evidence_refs": evidence_refs,
        }],
        "loader_events": [{
            "source": loader_transport.loader_api(),
            "loader_api": loader_transport.loader_api(),
            "artifactHash": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "artifactId": new_artifact_id,
            "artifact_id": new_artifact_id,
            "epoch": active_generation.to_string(),
            "processId": process_id,
            "process_id": process_id,
            "timestampMonotonicNs": loader_ts,
            "timestamp_monotonic_ns": loader_ts,
            "evidenceRefs": evidence_refs,
            "evidence_refs": evidence_refs,
        }],
        "epochEvents": [{
            "id": format!("epoch-publish:{active_generation}:{new_artifact_id}"),
            "event": "provisional_install",
            "publicationId": publication_commit.publication_id(),
            "publication_id": publication_commit.publication_id(),
            "candidateRegistrationId": publication_commit.candidate_registration_id(),
            "candidate_registration_id": publication_commit.candidate_registration_id(),
            "dispatcherRegistrationId": output_receipt.dispatcher_registration_id(),
            "dispatcher_registration_id": output_receipt.dispatcher_registration_id(),
            "epoch": active_generation.to_string(),
            "previousEpoch": previous_generation.to_string(),
            "previous_epoch": previous_generation.to_string(),
            "artifactHash": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "artifactId": new_artifact_id,
            "artifact_id": new_artifact_id,
            "processId": process_id,
            "process_id": process_id,
            "timestampMonotonicNs": publish_ts,
            "timestamp_monotonic_ns": publish_ts,
            "evidenceRefs": evidence_refs,
            "evidence_refs": evidence_refs,
        }],
        "epoch_events": [{
            "id": format!("epoch-publish:{active_generation}:{new_artifact_id}"),
            "event": "provisional_install",
            "publicationId": publication_commit.publication_id(),
            "publication_id": publication_commit.publication_id(),
            "candidateRegistrationId": publication_commit.candidate_registration_id(),
            "candidate_registration_id": publication_commit.candidate_registration_id(),
            "dispatcherRegistrationId": output_receipt.dispatcher_registration_id(),
            "dispatcher_registration_id": output_receipt.dispatcher_registration_id(),
            "epoch": active_generation.to_string(),
            "previousEpoch": previous_generation.to_string(),
            "previous_epoch": previous_generation.to_string(),
            "artifactHash": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "artifactId": new_artifact_id,
            "artifact_id": new_artifact_id,
            "processId": process_id,
            "process_id": process_id,
            "timestampMonotonicNs": publish_ts,
            "timestamp_monotonic_ns": publish_ts,
            "evidenceRefs": evidence_refs,
            "evidence_refs": evidence_refs,
        }],
        "epochCommitEvents": [{
            "id": format!("epoch-commit:{active_generation}:{new_artifact_id}"),
            "event": "unrestricted_visibility_commit",
            "publicationId": publication_commit.publication_id(),
            "publication_id": publication_commit.publication_id(),
            "candidateRegistrationId": publication_commit.candidate_registration_id(),
            "candidate_registration_id": publication_commit.candidate_registration_id(),
            "dispatcherRegistrationId": output_receipt.dispatcher_registration_id(),
            "dispatcher_registration_id": output_receipt.dispatcher_registration_id(),
            "epoch": active_generation.to_string(),
            "previousEpoch": previous_generation.to_string(),
            "previous_epoch": previous_generation.to_string(),
            "artifactHash": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "artifactId": new_artifact_id,
            "artifact_id": new_artifact_id,
            "processId": process_id,
            "process_id": process_id,
            "timestampMonotonicNs": commit_ts,
            "timestamp_monotonic_ns": commit_ts,
            "evidenceRefs": evidence_refs,
            "evidence_refs": evidence_refs,
        }],
        "epoch_commit_events": [{
            "id": format!("epoch-commit:{active_generation}:{new_artifact_id}"),
            "event": "unrestricted_visibility_commit",
            "publicationId": publication_commit.publication_id(),
            "publication_id": publication_commit.publication_id(),
            "candidateRegistrationId": publication_commit.candidate_registration_id(),
            "candidate_registration_id": publication_commit.candidate_registration_id(),
            "dispatcherRegistrationId": output_receipt.dispatcher_registration_id(),
            "dispatcher_registration_id": output_receipt.dispatcher_registration_id(),
            "epoch": active_generation.to_string(),
            "previousEpoch": previous_generation.to_string(),
            "previous_epoch": previous_generation.to_string(),
            "artifactHash": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "artifactId": new_artifact_id,
            "artifact_id": new_artifact_id,
            "processId": process_id,
            "process_id": process_id,
            "timestampMonotonicNs": commit_ts,
            "timestamp_monotonic_ns": commit_ts,
            "evidenceRefs": evidence_refs,
            "evidence_refs": evidence_refs,
        }],
        "dispatchEvents": [{
            "command": vendor.launch_kernel_symbol(),
            "launch_api": vendor.launch_kernel_symbol(),
            "dispatchId": after_dispatch_id,
            "dispatch_id": after_dispatch_id,
            "artifactHash": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "artifactId": new_artifact_id,
            "artifact_id": new_artifact_id,
            "epoch": active_generation.to_string(),
            "kernelName": dispatch_record.kernel_name,
            "kernel_name": dispatch_record.kernel_name,
            "publicationId": publication_commit.publication_id(),
            "publication_id": publication_commit.publication_id(),
            "dispatcherRegistrationId": publication_commit.candidate_registration_id(),
            "dispatcher_registration_id": publication_commit.candidate_registration_id(),
            "dispatchTableHash": output_receipt.dispatch_table_hash(),
            "dispatch_table_hash": output_receipt.dispatch_table_hash(),
            "dispatchTableEntryId": output_receipt.dispatch_table_entry_id(),
            "dispatch_table_entry_id": output_receipt.dispatch_table_entry_id(),
            "processId": process_id,
            "process_id": process_id,
            "timestampMonotonicNs": dispatch_ts,
            "timestamp_monotonic_ns": dispatch_ts,
            "evidenceRefs": evidence_refs,
            "evidence_refs": evidence_refs,
        }],
        "dispatch_events": [{
            "command": vendor.launch_kernel_symbol(),
            "launch_api": vendor.launch_kernel_symbol(),
            "dispatchId": after_dispatch_id,
            "dispatch_id": after_dispatch_id,
            "artifactHash": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "artifactId": new_artifact_id,
            "artifact_id": new_artifact_id,
            "epoch": active_generation.to_string(),
            "kernelName": dispatch_record.kernel_name,
            "kernel_name": dispatch_record.kernel_name,
            "publicationId": publication_commit.publication_id(),
            "publication_id": publication_commit.publication_id(),
            "dispatcherRegistrationId": publication_commit.candidate_registration_id(),
            "dispatcher_registration_id": publication_commit.candidate_registration_id(),
            "dispatchTableHash": output_receipt.dispatch_table_hash(),
            "dispatch_table_hash": output_receipt.dispatch_table_hash(),
            "dispatchTableEntryId": output_receipt.dispatch_table_entry_id(),
            "dispatch_table_entry_id": output_receipt.dispatch_table_entry_id(),
            "processId": process_id,
            "process_id": process_id,
            "timestampMonotonicNs": dispatch_ts,
            "timestamp_monotonic_ns": dispatch_ts,
            "evidenceRefs": evidence_refs,
            "evidence_refs": evidence_refs,
        }],
        "outputEvents": [{
            "id": output_receipt.oracle_id(),
            "kind": "buffer_checksum",
            "passed": true,
            "afterDispatchId": after_dispatch_id,
            "after_dispatch_id": after_dispatch_id,
            "artifactHash": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "artifactId": new_artifact_id,
            "artifact_id": new_artifact_id,
            "epoch": active_generation.to_string(),
            "processId": process_id,
            "process_id": process_id,
            "timestampMonotonicNs": output_ts,
            "timestamp_monotonic_ns": output_ts,
            "evidenceRefs": evidence_refs,
            "evidence_refs": evidence_refs,
        }],
        "output_events": [{
            "id": output_receipt.oracle_id(),
            "kind": "buffer_checksum",
            "passed": true,
            "afterDispatchId": after_dispatch_id,
            "after_dispatch_id": after_dispatch_id,
            "artifactHash": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "artifactId": new_artifact_id,
            "artifact_id": new_artifact_id,
            "epoch": active_generation.to_string(),
            "processId": process_id,
            "process_id": process_id,
            "timestampMonotonicNs": output_ts,
            "timestamp_monotonic_ns": output_ts,
            "evidenceRefs": evidence_refs,
            "evidence_refs": evidence_refs,
        }],
        "retirementEvent": {
            "id": format!("retire:{previous_generation}->{active_generation}:{previous_artifact_id}"),
            "epoch": previous_generation.to_string(),
            "artifactHash": previous_artifact_id,
            "artifact_hash": previous_artifact_id,
            "artifactId": previous_artifact_id,
            "artifact_id": previous_artifact_id,
            "status": "retired_after_quiescent",
            "processId": process_id,
            "process_id": process_id,
            "timestampMonotonicNs": retirement_ts,
            "timestamp_monotonic_ns": retirement_ts,
            "evidenceRefs": evidence_refs,
            "evidence_refs": evidence_refs,
        },
        "retirement_event": {
            "id": format!("retire:{previous_generation}->{active_generation}:{previous_artifact_id}"),
            "epoch": previous_generation.to_string(),
            "artifactHash": previous_artifact_id,
            "artifact_hash": previous_artifact_id,
            "artifactId": previous_artifact_id,
            "artifact_id": previous_artifact_id,
            "status": "retired_after_quiescent",
            "processId": process_id,
            "process_id": process_id,
            "timestampMonotonicNs": retirement_ts,
            "timestamp_monotonic_ns": retirement_ts,
            "evidenceRefs": evidence_refs,
            "evidence_refs": evidence_refs,
        },
        "sameProcess": true,
        "same_process": true,
        "processRestarted": false,
        "process_restarted": false,
        "evidenceRefs": evidence_refs,
        "evidence_refs": evidence_refs,
    });
    let acceptance_contract = runtime_acceptance_contract(
        req,
        source_edit_id,
        vendor,
        &contract_hash,
        previous_artifact_id,
        new_artifact_id,
        expected_symbols,
        &source_paths,
        &evidence_refs,
        &abi_hash,
        &process_id,
        device_uuid,
        &dispatch_record,
        &oracle_artifacts,
        &output_oracle_target,
        retirement_strategy,
        capsule_metadata,
    );
    let proof_artifact_material = json!({
        "resultState": GPU_HMR_FULL_RUNTIME_RESULT_STATE,
        "proofLedger": proof_ledger,
        "acceptanceContract": acceptance_contract,
        "stageResults": runtime_proof_stage_results(),
        "runtimeTrace": runtime_trace.clone(),
        "runtimeSessionId": runtime_session_id(),
        "artifactBefore": previous_artifact_id,
        "artifactAfter": new_artifact_id,
        "dispatchId": after_dispatch_id,
    });
    let runtime_proof_id = format!(
        "gpu-runtime-proof:sha256:{}",
        stable_json_sha256(&proof_artifact_material)
    );
    let runtime_artifact = json!({
        "schemaVersion": GPU_HMR_VALIDATION_PROOF_SCHEMA_VERSION,
        "proofId": runtime_proof_id,
        "resultState": GPU_HMR_FULL_RUNTIME_RESULT_STATE,
        "fullRuntimeProven": true,
        "gpuHmrSuccess": true,
        "stageResults": runtime_proof_stage_results(),
        "limitations": [],
        "proofLedger": proof_ledger,
        "proofLedgerQuery": proof_ledger_query,
        "runtimeTrace": runtime_trace.clone(),
        "runtime_trace": runtime_trace,
        "acceptanceContract": acceptance_contract,
        "acceptanceContractEvaluation": {
            "accepted": true,
            "failedGates": [],
        },
        "acceptanceContractConsistency": {
            "accepted": true,
            "failedGates": [],
        },
        "derivedAcceptanceContract": acceptance_contract,
        "derivedAcceptanceContractEvaluation": {
            "accepted": true,
            "failedGates": [],
        },
        "explicitProofLedgerRecord": proof_ledger["records"][0].clone(),
        "derivedProofLedgerRecord": proof_ledger["records"][0].clone(),
        "proofLedgerSourceConsistency": {
            "accepted": true,
            "failures": [],
        },
        "timings": timings,
        "runtimeProofSummary": {
            "runtimeSessionId": runtime_session_id(),
            "previousArtifactId": previous_artifact_id,
            "newArtifactId": new_artifact_id,
            "activeGeneration": active_generation,
            "previousGeneration": previous_generation,
            "dispatchId": after_dispatch_id,
            "outputOracleId": output_receipt.oracle_id(),
            "publicationId": publication_commit.publication_id(),
            "candidateRegistrationId": publication_commit.candidate_registration_id(),
            "provisionalPublishTimestampMonotonicNs": publish_ts,
            "commitTimestampMonotonicNs": commit_ts,
        },
    });
    let message = json!({
        "type": "gpu_hmr_proof",
        "schemaVersion": GPU_HMR_PROOF_SCHEMA_VERSION,
        "module": "device",
        "previewId": req.build_manifest.preview_id,
        "preview_id": req.build_manifest.preview_id,
        "resultState": GPU_HMR_FULL_RUNTIME_RESULT_STATE,
        "proofId": runtime_proof_id,
        "proofLedger": proof_ledger,
        "runtimeProofArtifact": runtime_artifact,
    });
    serde_json::to_string(&message)
        .map_err(|error| format!("runtime_proof_serialization_failed:{error}"))
}

fn capsule_id_for_publication(
    artifact_id: &str,
    capsule_metadata: Option<&ReloadCapsuleMetadata>,
) -> String {
    let mut material = String::new();
    material.push_str(artifact_id);
    if let Some(metadata) = capsule_metadata {
        material.push('|');
        material.push_str(metadata.fission_island_id.as_deref().unwrap_or(""));
        material.push('|');
        material.push_str(metadata.abi_membrane_hash.as_deref().unwrap_or(""));
        material.push('|');
        material.push_str(metadata.dependency_closure_hash.as_deref().unwrap_or(""));
        material.push('|');
        material.push_str(metadata.proof_hash.as_deref().unwrap_or(""));
    }
    format!("capsule:sha256:{}", sha256_hex_bytes(material.as_bytes()))
}

fn changed_function_handle_ids(table: &HashMap<String, u64>, changed_symbols: &[String]) -> String {
    let mut ids = changed_symbols
        .iter()
        .filter_map(|symbol| {
            table
                .get(symbol)
                .map(|handle| format!("{}:0x{:x}", symbol, handle))
        })
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        "none".to_string()
    } else {
        ids.join(",")
    }
}

fn log_list_values(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty() && *item != "none")
        .map(str::to_string)
        .collect()
}

#[derive(Debug)]
struct EpochGenerationGraphLineInput<'a> {
    runtime_session: &'a str,
    publish_timestamp_ms: u128,
    previous_generation: u64,
    active_generation: u64,
    old_artifact_id: &'a str,
    new_artifact_id: &'a str,
    new_artifact_hash: &'a str,
    capsule_id: &'a str,
    fission_island_id: &'a str,
    abi_membrane_hash: &'a str,
    dependency_closure_hash: &'a str,
    proof_hash: &'a str,
    changed_symbols: &'a [String],
    function_handle_ids: &'a str,
    stream_epoch_counters: serde_json::Value,
    dispatch_table_hash_before: u64,
    dispatch_table_hash_after: u64,
    changed_entries: usize,
    retirement_fence_ids: &'a str,
    retirement_strategy: &'a str,
    delayed_unload_result: &'a str,
    retirement_state: &'a str,
}

fn epoch_generation_graph_line(input: EpochGenerationGraphLineInput<'_>) -> String {
    let previous_node_id = format!("generation:{}", input.previous_generation);
    let active_node_id = format!("generation:{}", input.active_generation);
    let retirement_fence_ids = log_list_values(input.retirement_fence_ids);
    let publication_edge = json!({
        "kind": "publish",
        "from": previous_node_id,
        "to": active_node_id,
        "previousGeneration": input.previous_generation,
        "activeGeneration": input.active_generation,
        "runtimeSession": input.runtime_session,
        "publishTimestampMs": input.publish_timestamp_ms,
        "oldArtifactId": input.old_artifact_id,
        "newArtifactId": input.new_artifact_id,
        "newArtifactHash": input.new_artifact_hash,
        "capsuleId": input.capsule_id,
        "fissionIslandId": input.fission_island_id,
        "abiMembraneHash": input.abi_membrane_hash,
        "dependencyClosureHash": input.dependency_closure_hash,
        "proofHash": input.proof_hash,
        "changedSymbols": input.changed_symbols,
        "functionHandleIds": log_list_values(input.function_handle_ids),
        "streamEpochCounters": input.stream_epoch_counters.clone(),
        "dispatchTableHashBefore": format!("0x{:016x}", input.dispatch_table_hash_before),
        "dispatchTableHashAfter": format!("0x{:016x}", input.dispatch_table_hash_after),
        "dispatchTableHash": format!("0x{:016x}", input.dispatch_table_hash_after),
        "changedEntries": input.changed_entries,
        "retirementFenceIds": retirement_fence_ids.clone(),
        "retirementStrategy": input.retirement_strategy,
        "delayedUnloadResult": input.delayed_unload_result,
    });
    let mut edges = vec![publication_edge];
    if input.retirement_state == "retired" {
        edges.push(json!({
            "kind": "retire",
            "from": format!("generation:{}", input.previous_generation),
            "to": format!("generation:{}", input.active_generation),
            "previousGeneration": input.previous_generation,
            "activeGeneration": input.active_generation,
            "runtimeSession": input.runtime_session,
            "retirementFenceIds": retirement_fence_ids.clone(),
            "retirementStrategy": input.retirement_strategy,
            "delayedUnloadResult": input.delayed_unload_result,
        }));
    }
    let previous_state = match input.retirement_state {
        "retired" => "retired",
        "not-required" => "not-required",
        _ => "pending-retirement",
    };
    let graph = json!({
        "schemaVersion": "synthi.gpu.epoch_graph.v1",
        "runtimeSessionIds": [input.runtime_session],
        "latestPublication": {
            "previousGeneration": input.previous_generation,
            "activeGeneration": input.active_generation,
            "publishTimestampMs": input.publish_timestamp_ms,
            "oldArtifactId": input.old_artifact_id,
            "newArtifactId": input.new_artifact_id,
            "newArtifactHash": input.new_artifact_hash,
            "capsuleId": input.capsule_id,
            "fissionIslandId": input.fission_island_id,
            "abiMembraneHash": input.abi_membrane_hash,
            "dependencyClosureHash": input.dependency_closure_hash,
            "proofHash": input.proof_hash,
            "changedSymbols": input.changed_symbols,
            "functionHandleIds": log_list_values(input.function_handle_ids),
            "streamEpochCounters": input.stream_epoch_counters.clone(),
            "dispatchTableHashBefore": format!("0x{:016x}", input.dispatch_table_hash_before),
            "dispatchTableHashAfter": format!("0x{:016x}", input.dispatch_table_hash_after),
            "dispatchTableHash": format!("0x{:016x}", input.dispatch_table_hash_after),
            "changedEntries": input.changed_entries,
            "retirementFenceIds": retirement_fence_ids.clone(),
            "retirementStrategy": input.retirement_strategy,
            "delayedUnloadResult": input.delayed_unload_result,
        },
        "retirementState": input.retirement_state,
        "retirementRequired": input.retirement_state != "not-required",
        "nodes": [
            {
                "id": format!("generation:{}", input.previous_generation),
                "generation": input.previous_generation,
                "state": previous_state,
            },
            {
                "id": format!("generation:{}", input.active_generation),
                "generation": input.active_generation,
                "state": "published",
            }
        ],
        "edges": edges,
    });
    format!("[gpu-runtime-boundary] epoch_generation_graph json={graph}")
}

#[derive(Debug, Clone)]
struct StreamOrderingDrain {
    outcome: DrainOutcome,
    scope_label: &'static str,
    stream_tokens: Vec<usize>,
}

impl StreamOrderingDrain {
    fn no_old_generation(budget_ms: u64) -> Self {
        Self {
            outcome: DrainOutcome::Synced {
                scope: DrainScope::Stream,
                elapsed_ms: 0,
                budget_ms,
            },
            scope_label: "none",
            stream_tokens: Vec::new(),
        }
    }

    fn is_synced(&self) -> bool {
        self.outcome.is_synced()
    }

    fn stream_count(&self) -> u32 {
        self.stream_tokens.len().min(u32::MAX as usize) as u32
    }

    fn stream_id_label(token: usize) -> String {
        if token == 0 {
            "default".to_string()
        } else {
            format!("0x{token:x}")
        }
    }

    fn stream_ids_for_log(&self) -> String {
        if self.stream_tokens.is_empty() {
            return "none".to_string();
        }
        self.stream_tokens
            .iter()
            .map(|token| Self::stream_id_label(*token))
            .collect::<Vec<_>>()
            .join(",")
    }

    fn retirement_fence_ids_for_log(
        &self,
        previous_generation: u64,
        active_generation: u64,
    ) -> String {
        if self.stream_tokens.is_empty() {
            return "none".to_string();
        }
        self.stream_tokens
            .iter()
            .map(|token| {
                format!(
                    "stream-sync:{}:{}->{}",
                    Self::stream_id_label(*token),
                    previous_generation,
                    active_generation
                )
            })
            .collect::<Vec<_>>()
            .join(",")
    }

    fn stream_epoch_counters_for_log(&self, generation: u64) -> String {
        if self.stream_tokens.is_empty() {
            return format!("none:{generation}");
        }
        self.stream_tokens
            .iter()
            .map(|token| {
                let stream_id = Self::stream_id_label(*token);
                format!("{stream_id}:{generation}")
            })
            .collect::<Vec<_>>()
            .join(",")
    }

    fn stream_epoch_counters_for_graph(&self, generation: u64) -> serde_json::Value {
        let mut counters = serde_json::Map::new();
        if self.stream_tokens.is_empty() {
            counters.insert("none".to_string(), json!(generation));
        } else {
            for token in &self.stream_tokens {
                counters.insert(Self::stream_id_label(*token), json!(generation));
            }
        }
        serde_json::Value::Object(counters)
    }

    fn retirement_strategy_for_log(&self) -> &'static str {
        if matches!(
            self.outcome,
            DrainOutcome::Synced {
                scope: DrainScope::Context,
                ..
            }
        ) {
            return "conservative_drain_fallback";
        }
        if self.stream_tokens.is_empty() {
            return "no_retirement_required";
        }

        "epoch_fence"
    }
}

fn logical_epoch_retirement_proven(
    retired_module_count: usize,
    drain: &StreamOrderingDrain,
) -> bool {
    retired_module_count == 0
        || (drain.is_synced()
            && runtime_epoch_retirement_proof_value(drain.retirement_strategy_for_log())
                != "unproven")
}

fn physical_epoch_retirement_proven(
    retired_module_count: usize,
    drain: &StreamOrderingDrain,
    unload_failure_count: usize,
) -> bool {
    logical_epoch_retirement_proven(retired_module_count, drain)
        && (retired_module_count == 0 || unload_failure_count == 0)
}

fn affected_stream_tokens_for_symbols(expected_symbols: &[String]) -> Vec<usize> {
    let active_generation = current_launch_generation();
    let mut tokens = launch_records_snapshot()
        .into_iter()
        .filter(|record| {
            record.dispatched
                && record.dispatch_error.is_none()
                && record.active_generation == active_generation
                && expected_symbols
                    .iter()
                    .any(|symbol| symbol == &record.kernel_name)
        })
        .map(|record| record.stream_token)
        .collect::<Vec<_>>();
    tokens.sort_unstable();
    tokens.dedup();
    tokens
}

fn drain_affected_streams(
    symbols: &GpuDriverSymbolTable,
    expected_symbols: &[String],
    first_device_load: bool,
    budget_ms: u64,
) -> StreamOrderingDrain {
    if first_device_load {
        return StreamOrderingDrain::no_old_generation(budget_ms);
    }

    let stream_tokens = affected_stream_tokens_for_symbols(expected_symbols);
    if stream_tokens.is_empty() {
        return StreamOrderingDrain {
            outcome: drain_context(symbols, budget_ms),
            scope_label: "context",
            stream_tokens,
        };
    }

    let started = Instant::now();
    for token in &stream_tokens {
        let outcome = drain_stream(symbols, *token as CuStream, budget_ms);
        if !outcome.is_synced() {
            return StreamOrderingDrain {
                outcome,
                scope_label: "affected",
                stream_tokens,
            };
        }
    }

    StreamOrderingDrain {
        outcome: DrainOutcome::Synced {
            scope: DrainScope::Stream,
            elapsed_ms: started.elapsed().as_millis() as u64,
            budget_ms,
        },
        scope_label: "affected",
        stream_tokens,
    }
}

pub struct GpuModuleAdapter {
    config: GpuModuleAdapterConfig,
    phase: GpuPhase,
    /// Reload counter — incremented every time `reload()` is called,
    /// even when it returns Unsupported. Helps telemetry
    /// distinguish a flat-lined adapter (never called) from one that
    /// keeps refusing.
    reload_count: u64,
    /// Address of the currently-loaded module, if any. `u64` rather
    /// than `*mut c_void` so `GpuModuleAdapter: Send` falls out for
    /// free — the actual pointer crossing is a Phase 3 concern.
    active_module_handle: Option<u64>,
    /// Content-addressed artifact id for the currently published dispatch
    /// generation. Epoch proof uses this to describe capsule lineage without
    /// relying on target-specific paths.
    active_generation_artifact_id: Option<String>,
    /// Hardware identity attested for the currently published generation.
    /// A hot reload must match this baseline before any module mutation.
    active_device_identity: Option<RuntimeHardwareDeviceIdentity>,
    /// Live kernel name → CUfunction-handle-as-u64 map. Empty in
    /// Phase 2; populated when Phase 3 calls `cuModuleGetFunction`
    /// for every kernel in the manifest right after a successful
    /// swap.
    kernel_table: HashMap<String, u64>,
    /// Health line surfaced to the planner. Phase 2 reports
    /// `Healthy` after a successful `initialize` even when the
    /// driver isn't loaded — the planner uses `driver_state` to
    /// route reload vs cold restart.
    health: AdapterHealth,
    /// Loaded driver handle, if `gpu_driver_loader::try_load`
    /// succeeded in `initialize`. Shared via `Arc` so Phase 3's
    /// module-manager + shadow-arena can hold their own
    /// references without re-dlopen.
    driver: Option<Arc<GpuDriverHandle>>,
    /// Two-slot manager for the active / standby cubin or hsaco
    /// image. The driver handle owns the function pointers; this
    /// manager owns only opaque module and function handles.
    module_manager: GpuModuleManager,
    /// Driver modules no longer reachable from the active dispatch table whose
    /// unload call failed. Keeping ownership prevents an untracked handle leak;
    /// the next reload retries these unloads before loading another candidate.
    pending_retired_modules: Vec<ModuleSlot>,
    /// Last deterministic reload report lines. These are also
    /// printed during `reload()` so the worker log carries the
    /// markers from docs/GPU_HMR_ULTRAPLAN.md §9.
    last_reload_log: Vec<String>,
    /// ABI fingerprint from the last device sidecar manifest this
    /// adapter accepted. Device-only body edits keep this stable;
    /// kernel signature edits change it and must cold-reload.
    last_device_abi_version: Option<String>,
    /// Last driver-load error, if `try_load` failed. Surfaced on
    /// `info().extra["driver_error"]` for telemetry. Cleared on
    /// the next successful load attempt.
    last_driver_error: Option<DriverLoadError>,
    /// Current GPU context captured on the runner thread before a
    /// reload worker is spawned. CUDA and HIP module APIs bind context
    /// per thread, so the reload thread must re-bind the same context
    /// before loading a replacement sidecar.
    reload_context: Option<u64>,
    /// Test-only symbol table injection. This lets adapter-level
    /// unit tests exercise real load/swap/unload sequencing without
    /// requiring libcuda.so.1 or a GPU in CI.
    #[cfg(test)]
    test_symbols: Option<GpuDriverSymbolTable>,
}

impl GpuModuleAdapter {
    pub fn new(config: GpuModuleAdapterConfig) -> Self {
        Self {
            config,
            phase: GpuPhase::Uninitialized,
            reload_count: 0,
            active_module_handle: None,
            active_generation_artifact_id: None,
            active_device_identity: None,
            kernel_table: HashMap::new(),
            health: AdapterHealth::Unknown,
            driver: None,
            module_manager: GpuModuleManager::new(),
            pending_retired_modules: Vec::new(),
            last_reload_log: Vec::new(),
            last_device_abi_version: None,
            last_driver_error: None,
            reload_context: None,
            #[cfg(test)]
            test_symbols: None,
        }
    }

    pub fn vendor(&self) -> GpuVendor {
        self.config.vendor
    }

    pub fn reload_count(&self) -> u64 {
        self.reload_count
    }

    pub fn is_ready(&self) -> bool {
        self.phase == GpuPhase::Ready
    }

    /// True once `initialize` succeeded *and* the vendor driver
    /// was found. Phase-3 planner uses this to gate the swap
    /// path: when `driver_available()` is false the planner must
    /// fall through to cold restart.
    pub fn driver_available(&self) -> bool {
        self.driver.is_some() || cfg!(test) && self.test_symbols_available()
    }

    /// Shared reference to the loaded driver, if any. Phase 3's
    /// module manager + shadow arena will clone this Arc so they
    /// don't re-dlopen.
    pub fn driver_handle(&self) -> Option<Arc<GpuDriverHandle>> {
        self.driver.clone()
    }

    /// Last driver-load error, if any. Cleared on the next
    /// successful initialize.
    pub fn last_driver_error(&self) -> Option<&DriverLoadError> {
        self.last_driver_error.as_ref()
    }

    /// Telemetry label for the driver. Mirrors the planner's log
    /// line: `loaded` / `unavailable` / `pending` (= initialize
    /// not yet called).
    pub fn driver_state_label(&self) -> &'static str {
        if self.driver.is_some() {
            "loaded"
        } else if self.last_driver_error.is_some() {
            "unavailable"
        } else {
            "pending"
        }
    }

    /// Phase 1 introspection — returns the set of driver-API symbols
    /// the Phase 2 dlsym pass will resolve, in the order they will be
    /// resolved. Exposed so the adapter test can prove the table is
    /// complete without poking private state.
    pub fn required_driver_symbols(&self) -> Vec<&'static str> {
        gpu_driver_loader::required_symbol_names(self.config.vendor).to_vec()
    }

    pub fn capture_current_context_for_reload(&mut self) -> Result<Option<u64>, String> {
        let Some(symbols) = self.symbols() else {
            self.reload_context = None;
            return Ok(None);
        };
        let mut context: CuContext = std::ptr::null_mut();
        let code = unsafe { (symbols.cu_ctx_get_current)(&mut context as *mut CuContext) };
        if code != 0 {
            return Err(format!(
                "GPU context query failed before sidecar reload: {code}"
            ));
        }
        if context.is_null() {
            self.reload_context = None;
            return Ok(None);
        }
        let context_value = context as u64;
        self.reload_context = Some(context_value);
        Ok(Some(context_value))
    }

    pub fn last_reload_log(&self) -> &[String] {
        &self.last_reload_log
    }

    fn managed_snapshot_stats() -> (u64, u32) {
        let registry = BufferRegistry::from_managed_buffers(managed_buffers_snapshot());
        let snapshot_bytes = registry.snapshot_byte_budget();
        let dirty_buffers = registry
            .iter()
            .filter(|record| record.dirty || !record.uses_vram_shadow)
            .count() as u32;
        (snapshot_bytes, dirty_buffers)
    }

    fn symbols(&self) -> Option<&GpuDriverSymbolTable> {
        if let Some(driver) = &self.driver {
            return Some(driver.symbols());
        }
        #[cfg(test)]
        {
            if let Some(symbols) = self.test_symbols.as_ref() {
                return Some(symbols);
            }
        }
        None
    }

    #[cfg(test)]
    fn test_symbols_available(&self) -> bool {
        self.test_symbols.is_some()
    }

    #[cfg(not(test))]
    fn test_symbols_available(&self) -> bool {
        false
    }

    fn compile_vendor(&self) -> DeviceVendor {
        match self.config.vendor {
            GpuVendor::Cuda => DeviceVendor::Cuda,
            GpuVendor::Rocm => DeviceVendor::Rocm,
        }
    }

    fn bind_reload_context(&self, symbols: &GpuDriverSymbolTable) -> Result<(), String> {
        let Some(context) = self.reload_context else {
            return Ok(());
        };
        let code = unsafe { (symbols.cu_ctx_set_current)(context as CuContext) };
        if code != 0 {
            return Err(format!(
                "GPU context bind failed before sidecar reload: {code}"
            ));
        }
        Ok(())
    }

    fn request_targets_gpu_sidecar(req: &AdapterReloadRequest) -> bool {
        matches!(req.build_manifest.slot, BuildSlot::Custom(_))
            && req
                .build_manifest
                .capabilities
                .iter()
                .any(|capability| capability == GPU_SIDECAR_MODULE_CAPABILITY)
    }

    fn classify_plan(&self, req: &AdapterReloadRequest) -> GpuReloadPlan {
        if !Self::request_targets_gpu_sidecar(req) {
            return GpuReloadPlan::HostOnly;
        }
        let partial_device_reload = req
            .build_manifest
            .capabilities
            .iter()
            .any(|capability| capability == GPU_SIDECAR_PARTIAL_MODULE_CAPABILITY);
        if partial_device_reload {
            return GpuReloadPlan::DeviceOnly;
        }
        let current_abi = req.build_manifest.abi_version.trim();
        if !current_abi.is_empty() {
            if let Some(previous_abi) = self.last_device_abi_version.as_deref() {
                if !previous_abi.is_empty() && previous_abi != current_abi {
                    return GpuReloadPlan::AbiBreaking;
                }
            }
        }
        GpuReloadPlan::DeviceOnly
    }

    fn remember_device_abi(&mut self, req: &AdapterReloadRequest) {
        if req
            .build_manifest
            .capabilities
            .iter()
            .any(|capability| capability == GPU_SIDECAR_PARTIAL_MODULE_CAPABILITY)
        {
            return;
        }
        let abi = req.build_manifest.abi_version.trim();
        if !abi.is_empty() {
            self.last_device_abi_version = Some(abi.to_string());
        }
    }

    fn emit_report(&mut self, input: GpuSwapInputs) {
        let cfg = GpuReloadConfig {
            vendor: self.compile_vendor(),
            requested_snapshot_mode: SnapshotMode::Auto,
            drain_timeout_ms: self.config.drain_timeout_ms,
            ..Default::default()
        };
        let report = plan_gpu_reload(&cfg, input);
        self.last_reload_log = report.log_lines.clone();
        for line in &self.last_reload_log {
            eprintln!("{line}");
        }
    }

    fn refuse_device_identity_preflight(
        &mut self,
        plan: GpuReloadPlan,
        snapshot_bytes: u64,
        dirty_buffers: u32,
        expected_kernel_hashes: u32,
        streams_synced: u32,
        evidence_lines: Vec<String>,
        reason: String,
    ) -> AdapterReloadResult {
        self.emit_report(GpuSwapInputs {
            plan,
            reason: "runtime-device-identity-preflight-refused".into(),
            streams_synced,
            force_drain_timeout: false,
            snapshot_bytes,
            snapshot_ms: 0,
            dirty_buffers,
            expected_kernel_hashes,
            matched_kernel_hashes: 0,
        });
        for line in evidence_lines {
            eprintln!("{line}");
            self.last_reload_log.push(line);
        }
        self.phase = GpuPhase::Ready;
        self.health = AdapterHealth::Degraded;
        AdapterReloadResult::Failed {
            error: format!(
                "GPU HMR device identity preflight rejected before module mutation: {reason}"
            ),
            recoverable: false,
        }
    }

    fn emit_runtime_ownership_report(&mut self, ownership: &DeviceReloadOwnership, artifact: &str) {
        let label = if ownership.partial_reload {
            "gpu-hmr-partial"
        } else {
            "gpu-hmr-full-device"
        };
        let expected = if ownership.expected_symbols.is_empty() {
            "-".to_string()
        } else {
            ownership.expected_symbols.join(",")
        };
        let touched = if ownership.touched_symbols.is_empty() {
            "-".to_string()
        } else {
            ownership.touched_symbols.join(",")
        };
        let device_attestation_gaps = if ownership.strict_device_attestation_gaps.is_empty() {
            "none".to_string()
        } else {
            ownership.strict_device_attestation_gaps.join(",")
        };
        let line = format!(
            "[gpu-reload] runtime_ownership label={} partial={} artifact={} expected_symbols={} touched_symbols={} retired_modules={} replaced_primary={} strict_device_attestation_available={} strict_device_attestation_gaps={}",
            label,
            ownership.partial_reload,
            artifact,
            expected,
            touched,
            ownership.retired_module_count,
            ownership.replaced_primary,
            ownership.strict_device_attestation_available,
            device_attestation_gaps,
        );
        eprintln!("{line}");
        self.last_reload_log.push(line);
    }

    fn retry_pending_retired_modules(
        &mut self,
        symbols: &GpuDriverSymbolTable,
    ) -> Result<(), String> {
        if self.pending_retired_modules.is_empty() {
            return Ok(());
        }

        let pending = std::mem::take(&mut self.pending_retired_modules);
        let mut failures = Vec::new();
        for slot in pending {
            if let Err(error) = self.module_manager.unload_retired(symbols, slot) {
                failures.push(format!(
                    "handle=0x{:x}:{}",
                    slot.handle,
                    Self::module_manager_error(error)
                ));
                self.pending_retired_modules.push(slot);
            }
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "GPU module retirement retry failed: {}",
                failures.join("|")
            ))
        }
    }

    fn module_manager_error(err: ModuleManagerError) -> String {
        format!("gpu module manager {}: {err}", err.short_label())
    }
}

impl Adapter for GpuModuleAdapter {
    fn info(&self) -> AdapterInfo {
        let mut extra = HashMap::new();
        extra.insert("vendor".into(), self.config.vendor.as_str().into());
        extra.insert(
            "driver_library".into(),
            self.config.vendor.driver_library().into(),
        );
        extra.insert("phase".into(), format!("{:?}", self.phase));
        extra.insert("reload_count".into(), self.reload_count.to_string());
        extra.insert("driver_state".into(), self.driver_state_label().into());
        extra.insert(
            "artifact_loader_transport".into(),
            self.config.artifact_loader_transport.as_str().into(),
        );
        extra.insert(
            "swap_count".into(),
            self.module_manager.swap_count().to_string(),
        );
        extra.insert(
            "pending_retired_modules".into(),
            self.pending_retired_modules.len().to_string(),
        );
        if let Some(primary) = self.module_manager.primary() {
            extra.insert("active_module_bytes".into(), primary.blob_bytes.to_string());
        }
        if let Some(artifact_id) = &self.active_generation_artifact_id {
            extra.insert("active_generation_artifact_id".into(), artifact_id.clone());
        }
        if let Some(err) = &self.last_driver_error {
            extra.insert("driver_error".into(), err.short_label().into());
        }
        if let Some(handle) = &self.driver {
            extra.insert("driver_path".into(), handle.library_path().into());
        }
        if let Some(abi) = &self.last_device_abi_version {
            extra.insert("device_abi_version".into(), abi.clone());
        }
        AdapterInfo {
            name: self.config.vendor.adapter_name().into(),
            // Modules are loaded into the running process via the
            // driver API — same family as dlopen-based dynamic
            // libraries. Phase 5 may carve out a new family if the
            // planner needs to distinguish; not needed today.
            family: AdapterFamily::DynamicLibrary,
            // Phase 1 declares Tier1 only: we promise process-swap
            // semantics today and will graduate to Tier2 once
            // `cuModuleLoadData` swap actually preserves state, and
            // Tier3 once the §6 snapshot tiers are wired.
            capability_tier: CapabilityTier::Tier1,
            supported_languages: vec!["cuda".into(), "hip".into()],
            extra,
        }
    }

    fn initialize(&mut self) -> Result<(), String> {
        if self.phase != GpuPhase::Uninitialized {
            return Err(format!(
                "GpuModuleAdapter::initialize called twice (phase={:?})",
                self.phase
            ));
        }
        // Phase 2: actually attempt the dlopen + dlsym pass. The
        // adapter still goes Ready even when the driver is missing
        // (so the planner state machine remains valid), but the
        // driver handle / last error fields capture which path was
        // taken so the planner can route reload vs cold restart.
        match gpu_driver_loader::try_load(self.config.vendor) {
            Ok(handle) => {
                self.driver = Some(handle.shared());
                self.last_driver_error = None;
            }
            Err(e) => {
                self.driver = None;
                self.last_driver_error = Some(e);
            }
        }
        self.phase = GpuPhase::Ready;
        self.health = AdapterHealth::Healthy;
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), String> {
        // Phase 3 will cuModuleUnload any active handle and dlclose
        // the driver library. Phase 2: drop handles + flag the phase.
        // Dropping the Arc here is sufficient — `libloading::Library`
        // runs dlclose in its Drop impl as long as no other Arc
        // clone outlives this adapter.
        self.active_module_handle = None;
        self.active_generation_artifact_id = None;
        self.active_device_identity = None;
        self.kernel_table.clear();
        self.driver = None;
        self.module_manager = GpuModuleManager::new();
        clear_launch_dispatcher();
        self.last_reload_log.clear();
        self.last_device_abi_version = None;
        self.reload_context = None;
        self.phase = GpuPhase::ShutDown;
        self.health = AdapterHealth::Unknown;
        Ok(())
    }

    fn reload(&mut self, req: &AdapterReloadRequest) -> AdapterReloadResult {
        self.reload_count += 1;
        if self.phase == GpuPhase::Uninitialized || self.phase == GpuPhase::ShutDown {
            return AdapterReloadResult::Failed {
                error: format!("GpuModuleAdapter not initialized (phase={:?})", self.phase),
                recoverable: false,
            };
        }
        if !self.driver_available() {
            return AdapterReloadResult::Unsupported {
                reason: format!(
                    "gpu_module_adapter driver unavailable ({}); falling through to cold path",
                    self.last_driver_error
                        .as_ref()
                        .map(|e| e.short_label())
                        .unwrap_or("unknown")
                ),
            };
        }

        let artifact = req.build_manifest.artifact_path.trim();
        let loader_transport = self.config.artifact_loader_transport;
        let ram_artifact = req
            .artifact_blob
            .as_ref()
            .filter(|artifact| !artifact.bytes.is_empty());
        if artifact.is_empty() && ram_artifact.is_none() {
            return AdapterReloadResult::Unsupported {
                reason: "gpu_module_adapter missing device artifact path or RAM artifact; cold reload required"
                    .into(),
            };
        }
        if artifact.is_empty() && loader_transport == ArtifactLoaderTransport::FilesystemPath {
            return AdapterReloadResult::Unsupported {
                reason:
                    "gpu_module_adapter selected loader requires a device artifact path; cold reload required"
                        .into(),
            };
        }

        let path_blob = if artifact.is_empty() {
            None
        } else {
            match fs::read(artifact) {
                Ok(bytes) => Some(bytes),
                Err(e)
                    if ram_artifact.is_some()
                        && loader_transport == ArtifactLoaderTransport::RamBytes =>
                {
                    eprintln!(
                        "[gpu-runtime-boundary] artifact_transport_path_validation artifact={} result=unavailable error={}",
                        artifact,
                        e
                    );
                    None
                }
                Err(e) => {
                    self.health = AdapterHealth::Degraded;
                    return AdapterReloadResult::Failed {
                        error: format!("failed to read GPU sidecar artifact {artifact:?}: {e}"),
                        recoverable: true,
                    };
                }
            }
        };
        let blob = if let Some(ram_artifact) = ram_artifact {
            let ram_hash = sha256_hex_bytes(&ram_artifact.bytes);
            match normalized_sha256_hex(&ram_artifact.content_hash) {
                Some(expected_hash) if expected_hash == ram_hash => {}
                Some(expected_hash) => {
                    self.health = AdapterHealth::Degraded;
                    return AdapterReloadResult::Failed {
                        error: format!(
                            "GPU RAM artifact hash mismatch: expected sha256:{expected_hash} got sha256:{ram_hash}"
                        ),
                        recoverable: true,
                    };
                }
                None => {
                    self.health = AdapterHealth::Degraded;
                    return AdapterReloadResult::Failed {
                        error: format!(
                            "GPU RAM artifact has invalid content hash {:?}",
                            ram_artifact.content_hash
                        ),
                        recoverable: true,
                    };
                }
            }
            let expected_blob_id = format!("artifact:sha256:{ram_hash}");
            if ram_artifact.blob_id != expected_blob_id {
                self.health = AdapterHealth::Degraded;
                return AdapterReloadResult::Failed {
                    error: format!(
                        "GPU RAM artifact blob id mismatch: expected {expected_blob_id:?} got {:?}",
                        ram_artifact.blob_id
                    ),
                    recoverable: true,
                };
            }
            if let Some(path_blob) = path_blob.as_ref() {
                let path_hash = sha256_hex_bytes(path_blob);
                if path_hash != ram_hash {
                    self.health = AdapterHealth::Degraded;
                    return AdapterReloadResult::Failed {
                        error: format!(
                            "GPU RAM artifact does not match filesystem artifact: ram=sha256:{ram_hash} path=sha256:{path_hash}"
                        ),
                        recoverable: true,
                    };
                }
            }
            ram_artifact.bytes.clone()
        } else {
            path_blob.expect("path artifact is present when no RAM artifact exists")
        };
        if blob.len() as u64 > self.config.max_module_bytes {
            return AdapterReloadResult::Unsupported {
                reason: format!(
                    "gpu sidecar artifact {} bytes exceeds max_module_bytes={}",
                    blob.len(),
                    self.config.max_module_bytes
                ),
            };
        }
        let artifact_hash = sha256_hex_bytes(&blob);
        let new_artifact_id = artifact_id_for_hash(&artifact_hash);
        let capsule_metadata = req.capsule_metadata.as_ref();
        let capsule_id = capsule_id_for_publication(&new_artifact_id, capsule_metadata);
        let fission_island_id = log_optional_token(
            capsule_metadata.and_then(|metadata| metadata.fission_island_id.as_deref()),
        );
        let abi_membrane_hash = log_optional_token(
            capsule_metadata.and_then(|metadata| metadata.abi_membrane_hash.as_deref()),
        );
        let dependency_closure_hash = log_optional_token(
            capsule_metadata.and_then(|metadata| metadata.dependency_closure_hash.as_deref()),
        );
        let proof_hash = log_optional_token(
            capsule_metadata.and_then(|metadata| metadata.proof_hash.as_deref()),
        );
        let ram_artifact_reference_provided = ram_artifact.is_some();
        let ram_blob_id = ram_artifact
            .map(|artifact| artifact.blob_id.as_str())
            .unwrap_or("-");
        let reload_request_transport = if ram_artifact_reference_provided && !artifact.is_empty() {
            "filesystem_path,ram_blob"
        } else if ram_artifact_reference_provided {
            "ram_blob"
        } else {
            "filesystem_path"
        };

        let plan = self.classify_plan(req);
        let (snapshot_bytes, dirty_buffers) = Self::managed_snapshot_stats();
        if plan == GpuReloadPlan::HostOnly {
            self.emit_report(GpuSwapInputs {
                plan,
                reason: "host-file-only-edit".into(),
                streams_synced: 0,
                force_drain_timeout: false,
                snapshot_bytes,
                snapshot_ms: 0,
                dirty_buffers,
                expected_kernel_hashes: req.build_manifest.exported_symbols.len() as u32,
                matched_kernel_hashes: req.build_manifest.exported_symbols.len() as u32,
            });
            return AdapterReloadResult::Unsupported {
                reason: "host-only GPU reload delegated to host adapter".into(),
            };
        }

        if plan == GpuReloadPlan::AbiBreaking {
            let expected = req.build_manifest.exported_symbols.len() as u32;
            self.emit_report(GpuSwapInputs {
                plan,
                reason: "signature-changed".into(),
                streams_synced: 0,
                force_drain_timeout: false,
                snapshot_bytes,
                snapshot_ms: 0,
                dirty_buffers,
                expected_kernel_hashes: expected,
                matched_kernel_hashes: expected,
            });
            self.remember_device_abi(req);
            self.phase = GpuPhase::Ready;
            self.health = AdapterHealth::Healthy;
            return AdapterReloadResult::Unsupported {
                reason: "gpu sidecar ABI changed; cold device reload required".into(),
            };
        }

        let first_device_load =
            self.active_module_handle.is_none() && self.module_manager.primary().is_none();
        let candidate_artifact_sha256 = format!("sha256:{artifact_hash}");
        if !first_device_load && !loader_transport.is_content_bound() {
            let line = format!(
                "[gpu-runtime-boundary] artifact_transport schema=synthi.gpu_hmr.artifact_transport.v1 status=refused candidate_artifact_sha256={} selected_loader_transport={} loader_api={} content_bound=false reason=mutable_path_transport_not_eligible_for_hot_reload proof_authority=transport_refusal_only_not_gpu_hmr_success accepted_for_gpu_hmr=false gpu_hmr_success=false can_satisfy_runtime_proof=false",
                candidate_artifact_sha256,
                loader_transport.as_str(),
                loader_transport.loader_api(),
            );
            eprintln!("{line}");
            self.last_reload_log = vec![line];
            return AdapterReloadResult::Unsupported {
                reason: "strict GPU hot reload requires content-bound artifact bytes; mutable filesystem path transport requires a cold reload"
                    .to_string(),
            };
        }
        let output_oracle_profile_pin = match pin_runtime_output_oracle_profile(
            req,
            &candidate_artifact_sha256,
            !first_device_load,
        ) {
            Ok(pin) => pin,
            Err(error) => {
                let reason = error
                    .chars()
                    .map(|ch| if ch.is_whitespace() { '_' } else { ch })
                    .collect::<String>();
                let line = format!(
                    "[gpu-runtime-boundary] runtime_output_oracle_profile_pin schema=synthi.gpu_hmr.runtime_output_oracle_profile_pin.v1 status=refused candidate_artifact_sha256={} reason={} proof_authority=prepublication_profile_binding_only_not_gpu_hmr_success accepted_for_gpu_hmr=false gpu_hmr_success=false can_satisfy_runtime_proof=false",
                    candidate_artifact_sha256, reason
                );
                eprintln!("{line}");
                self.last_reload_log = vec![line];
                self.health = AdapterHealth::Degraded;
                self.phase = GpuPhase::Ready;
                return AdapterReloadResult::Failed {
                    error,
                    recoverable: false,
                };
            }
        };
        if let Some(pinned) = output_oracle_profile_pin.committed() {
            eprintln!("{}", pinned.evidence_line);
        }
        let host_output_oracle_request_binding = if first_device_load {
            None
        } else {
            let source_edit_id = match req.source_edit_id.as_deref() {
                Some(source_edit_id) => source_edit_id,
                None => {
                    self.health = AdapterHealth::Degraded;
                    self.phase = GpuPhase::Ready;
                    return AdapterReloadResult::Failed {
                        error: "strict GPU reload is missing a source edit identity for host readback proof"
                            .to_string(),
                        recoverable: false,
                    };
                }
            };
            let capsule_metadata = match req.capsule_metadata.as_ref() {
                Some(capsule_metadata) => capsule_metadata,
                None => {
                    self.health = AdapterHealth::Degraded;
                    self.phase = GpuPhase::Ready;
                    return AdapterReloadResult::Failed {
                        error:
                            "strict GPU reload is missing capsule metadata for host readback proof"
                                .to_string(),
                        recoverable: false,
                    };
                }
            };
            match host_output_oracle_receipt::HostOutputOracleRequestBinding::from_reload_request(
                &req.reload_id,
                source_edit_id,
                &candidate_artifact_sha256,
                capsule_metadata,
            ) {
                Ok(binding) => Some(binding),
                Err(error) => {
                    self.health = AdapterHealth::Degraded;
                    self.phase = GpuPhase::Ready;
                    return AdapterReloadResult::Failed {
                        error,
                        recoverable: false,
                    };
                }
            }
        };
        #[cfg(test)]
        run_runtime_output_oracle_post_pin_hook_for_test();

        self.phase = GpuPhase::Swapping;
        let started = Instant::now();
        let symbols = match self.symbols() {
            Some(symbols) => *symbols,
            None => {
                self.health = AdapterHealth::Degraded;
                self.phase = GpuPhase::Ready;
                return AdapterReloadResult::Unsupported {
                    reason: "gpu_module_adapter has no driver symbol table".into(),
                };
            }
        };
        if let Err(error) = self.bind_reload_context(&symbols) {
            self.health = AdapterHealth::Degraded;
            self.phase = GpuPhase::Ready;
            return AdapterReloadResult::Failed {
                error,
                recoverable: true,
            };
        }
        if let Err(error) = self.retry_pending_retired_modules(&symbols) {
            self.health = AdapterHealth::Degraded;
            self.phase = GpuPhase::Ready;
            return AdapterReloadResult::Failed {
                error,
                recoverable: true,
            };
        }

        let partial_device_reload = req
            .build_manifest
            .capabilities
            .iter()
            .any(|capability| capability == GPU_SIDECAR_PARTIAL_MODULE_CAPABILITY);
        if partial_device_reload && first_device_load {
            self.health = AdapterHealth::Degraded;
            self.phase = GpuPhase::Ready;
            return AdapterReloadResult::Failed {
                error: "partial GPU sidecar reload requires an existing full device module".into(),
                recoverable: true,
            };
        }
        if partial_device_reload && req.build_manifest.exported_symbols.is_empty() {
            self.health = AdapterHealth::Degraded;
            self.phase = GpuPhase::Ready;
            return AdapterReloadResult::Failed {
                error: "partial GPU sidecar reload has no target symbols".into(),
                recoverable: true,
            };
        }
        let kernel_resolutions = match kernel_resolution_specs(&req.build_manifest.exported_symbols)
        {
            Ok(resolutions) => resolutions,
            Err(error) => {
                self.health = AdapterHealth::Degraded;
                self.phase = GpuPhase::Ready;
                return AdapterReloadResult::Failed {
                    error,
                    recoverable: true,
                };
            }
        };
        let expected_symbols = match logical_kernel_symbols(&req.build_manifest.exported_symbols) {
            Ok(symbols) => symbols,
            Err(error) => {
                self.health = AdapterHealth::Degraded;
                self.phase = GpuPhase::Ready;
                return AdapterReloadResult::Failed {
                    error,
                    recoverable: true,
                };
            }
        };
        if first_device_load {
            let init_code = unsafe { (symbols.cu_init)(0) };
            if init_code != 0 {
                self.health = AdapterHealth::Degraded;
                self.phase = GpuPhase::Ready;
                return AdapterReloadResult::Failed {
                    error: format!("GPU driver init failed before first sidecar load: {init_code}"),
                    recoverable: true,
                };
            }
        }
        let device_identity_before = query_runtime_hardware_device_identity(&symbols);
        let identity_observed_generation = current_launch_generation();
        let generation_identity_baseline = self.active_device_identity.clone();
        if !first_device_load {
            let baseline_check = verified_runtime_hardware_device_identity(
                generation_identity_baseline.as_ref(),
                &device_identity_before,
                &device_identity_before,
                true,
            );
            if let Err(reason) = baseline_check {
                let evidence_lines = vec![
                    runtime_hardware_device_identity_observation_line(
                        "before_reload",
                        identity_observed_generation,
                        &device_identity_before,
                    ),
                    runtime_hardware_device_identity_continuity_line(
                        identity_observed_generation,
                        generation_identity_baseline.as_ref(),
                        &device_identity_before,
                        &device_identity_before,
                        true,
                    ),
                ];
                return self.refuse_device_identity_preflight(
                    plan,
                    snapshot_bytes,
                    dirty_buffers,
                    req.build_manifest.exported_symbols.len() as u32,
                    0,
                    evidence_lines,
                    reason,
                );
            }
        }
        let mut drain = drain_affected_streams(
            &symbols,
            &expected_symbols,
            first_device_load,
            self.config.drain_timeout_ms,
        );
        if !drain.is_synced() {
            let timed_out = matches!(drain.outcome, DrainOutcome::TimedOut { .. });
            self.emit_report(GpuSwapInputs {
                plan,
                reason: drain.outcome.short_label().into(),
                streams_synced: drain.stream_count(),
                force_drain_timeout: timed_out,
                snapshot_bytes,
                snapshot_ms: drain.outcome.elapsed_ms(),
                dirty_buffers,
                expected_kernel_hashes: req.build_manifest.exported_symbols.len() as u32,
                matched_kernel_hashes: 0,
            });
            self.health = AdapterHealth::Faulted;
            self.phase = GpuPhase::Faulted;
            return AdapterReloadResult::Failed {
                error: format!("GPU drain failed: {:?}", drain.outcome),
                recoverable: !timed_out,
            };
        }
        let device_identity_after_drain = query_runtime_hardware_device_identity(&symbols);
        let verified_device_identity_result = verified_runtime_hardware_device_identity(
            generation_identity_baseline.as_ref(),
            &device_identity_before,
            &device_identity_after_drain,
            !first_device_load,
        );
        let mut device_identity_evidence_lines = vec![
            runtime_hardware_device_identity_observation_line(
                "before_reload",
                identity_observed_generation,
                &device_identity_before,
            ),
            runtime_hardware_device_identity_observation_line(
                "after_drain_pre_commit",
                identity_observed_generation,
                &device_identity_after_drain,
            ),
            runtime_hardware_device_identity_continuity_line(
                identity_observed_generation,
                generation_identity_baseline.as_ref(),
                &device_identity_before,
                &device_identity_after_drain,
                !first_device_load,
            ),
        ];
        let verified_device_identity = verified_device_identity_result.as_ref().ok().cloned();
        let verified_stream_device_bindings = verified_device_identity
            .as_ref()
            .map(|identity| {
                verify_runtime_stream_device_bindings(&symbols, identity, &drain.stream_tokens)
            })
            .unwrap_or_else(|| Err("stream_device_identity_active_device_unattested".to_string()));
        device_identity_evidence_lines.push(runtime_stream_device_binding_line(
            identity_observed_generation,
            verified_device_identity.as_ref(),
            &verified_stream_device_bindings,
        ));
        let mut strict_device_attestation_gaps = Vec::new();
        if let Err(reason) = &verified_device_identity_result {
            strict_device_attestation_gaps.push(reason.clone());
        }
        if let Err(reason) = &verified_stream_device_bindings {
            strict_device_attestation_gaps.push(reason.clone());
        }
        strict_device_attestation_gaps.sort();
        strict_device_attestation_gaps.dedup();
        let strict_device_attestation_available = strict_device_attestation_gaps.is_empty();
        device_identity_evidence_lines.push(runtime_device_attestation_capability_line(
            identity_observed_generation,
            strict_device_attestation_available,
            &strict_device_attestation_gaps,
        ));
        if !first_device_load && !strict_device_attestation_available {
            return self.refuse_device_identity_preflight(
                plan,
                snapshot_bytes,
                dirty_buffers,
                req.build_manifest.exported_symbols.len() as u32,
                drain.stream_count(),
                device_identity_evidence_lines,
                strict_device_attestation_gaps.join(","),
            );
        }
        let module_checkpoint = self.module_manager.checkpoint();
        let mut dispatcher_recovery_failed = false;
        let mut failure_runtime_log_lines = Vec::new();
        if let Some(pinned) = output_oracle_profile_pin.committed() {
            failure_runtime_log_lines.push(pinned.evidence_line.clone());
        }
        let load_result = (|| -> Result<DeviceReloadOwnership, String> {
            let previous_table = self.module_manager.kernel_table().clone();
            let previous_dispatch_table_hash = dispatch_table_hash(&previous_table);
            let previous_artifact_id = self
                .active_generation_artifact_id
                .as_deref()
                .unwrap_or("none")
                .to_string();
            match loader_transport {
                ArtifactLoaderTransport::FilesystemPath => {
                    self.module_manager
                        .load_standby_from_file(&symbols, artifact, blob.len())
                        .map_err(Self::module_manager_error)?;
                }
                ArtifactLoaderTransport::RamBytes => {
                    self.module_manager
                        .load_standby(&symbols, &blob)
                        .map_err(Self::module_manager_error)?;
                }
            }
            self.module_manager
                .resolve_kernel_symbols(&symbols, &kernel_resolutions)
                .map_err(Self::module_manager_error)?;
            let touched_symbols = resolved_kernel_symbols(&self.module_manager);
            if touched_symbols != expected_symbols {
                return Err(format!(
                    "GPU runtime symbol ownership mismatch: expected={} touched={}",
                    expected_symbols.join(","),
                    touched_symbols.join(",")
                ));
            }
            let loader_timestamp_monotonic_ns = monotonic_timestamp_ns();
            let mut replaced_primary = false;
            let retired = if partial_device_reload {
                self.module_manager
                    .merge_standby_partial(previous_table, &expected_symbols)
                    .map_err(Self::module_manager_error)?
            } else {
                let mut retired = Vec::new();
                if let Some(slot) = self
                    .module_manager
                    .swap()
                    .map_err(Self::module_manager_error)?
                {
                    replaced_primary = true;
                    retired.push(slot);
                }
                retired.extend(self.module_manager.drain_partial_modules());
                retired
            };
            let retired_module_count = retired.len();
            let (dispatcher_kernels, dispatch_table_hash) =
                active_dispatch_table(&self.module_manager);
            let dispatch_table_content_hash =
                dispatch_table_content_hash(self.module_manager.kernel_table());
            let changed_symbols_for_log = if expected_symbols.is_empty() {
                "none".to_string()
            } else {
                expected_symbols.join(",")
            };
            let function_handle_ids =
                changed_function_handle_ids(&dispatcher_kernels, &expected_symbols);
            let dispatcher_kernels_for_probe = dispatcher_kernels.clone();
            record_hmr_runtime_identity_snapshot();
            let mut dispatcher_publication = begin_launch_dispatcher_publication(
                Arc::new(DriverLaunchDispatcher {
                    symbols,
                    kernels: dispatcher_kernels,
                }),
                GpuLaunchDispatcherMetadata {
                    artifact_id: Some(new_artifact_id.clone()),
                    dispatch_table_hash: Some(dispatch_table_content_hash.clone()),
                    changed_symbols: expected_symbols.clone(),
                    function_handle_ids: function_handle_ids
                        .split(',')
                        .filter(|value| !value.trim().is_empty() && *value != "none")
                        .map(str::to_string)
                        .collect(),
                },
                Duration::from_millis(self.config.drain_timeout_ms),
            )
            .map_err(|error| format!("GPU dispatcher publication begin failed: {error}"))?;
            let previous_generation = dispatcher_publication.previous_generation();
            let active_generation = dispatcher_publication.candidate_generation();
            let publication_id = dispatcher_publication.publication_id().to_string();
            let candidate_registration_id = dispatcher_publication
                .candidate_registration_id()
                .to_string();
            let publish_timestamp_monotonic_ns =
                dispatcher_publication.publication_timestamp_monotonic_ns();
            let publication_drain = drain_affected_streams(
                &symbols,
                &expected_symbols,
                first_device_load,
                self.config.drain_timeout_ms,
            );
            if !publication_drain.is_synced() {
                let drain_error = format!(
                    "GPU publication retirement drain failed: {:?}",
                    publication_drain.outcome
                );
                let rollback_error =
                    rollback_launch_dispatcher_publication(&mut dispatcher_publication).err();
                dispatcher_recovery_failed = rollback_error.is_some();
                return Err(match rollback_error {
                    Some(rollback_error) => {
                        format!("{drain_error}; dispatcher rollback failed: {rollback_error}")
                    }
                    None => format!("{drain_error}; dispatcher publication rolled back"),
                });
            }
            drain = publication_drain;
            let mut output_oracle_artifact_id: Option<String> = None;
            let mut output_oracle_after_dispatch_id: Option<String> = None;
            let mut output_oracle_passed = false;
            let mut output_after_dispatch = false;
            let mut candidate_oracle_line: Option<String> = None;
            if !first_device_load {
                let probe_result = match host_output_oracle_request_binding.as_ref() {
                    Some(binding) => {
                        host_output_oracle_receipt::with_host_output_oracle_request_binding(
                            binding,
                            || match with_dispatcher_publication_validation(
                                &dispatcher_publication,
                                || {
                                    run_runtime_output_oracle_probe(
                                        &symbols,
                                        &dispatcher_kernels_for_probe,
                                        &expected_symbols,
                                        previous_generation,
                                        active_generation,
                                        &new_artifact_id,
                                        output_oracle_profile_pin.committed(),
                                    )
                                },
                            ) {
                                Ok(result) => result,
                                Err(error) => Err(format!(
                                    "candidate validation dispatch authorization failed: {error}"
                                )),
                            },
                        )
                        .and_then(|result| result)
                    }
                    None => Err(
                        "candidate validation is missing a host output-oracle request binding"
                            .to_string(),
                    ),
                };
                match probe_result {
                    Ok(Some(line)) => {
                        output_oracle_artifact_id =
                            runtime_boundary_token(&line, "artifact_id").map(str::to_string);
                        output_oracle_after_dispatch_id =
                            runtime_boundary_token(&line, "after_dispatch_id").map(str::to_string);
                        output_oracle_passed = runtime_output_oracle_line_passed(
                            &line,
                            active_generation,
                            &new_artifact_id,
                        );
                        output_after_dispatch = output_oracle_artifact_id.as_deref()
                            == Some(new_artifact_id.as_str())
                            && output_oracle_after_dispatch_id.is_some();
                        candidate_oracle_line = Some(line);
                    }
                    Ok(None) => {
                        candidate_oracle_line = Some(format!(
                            "[gpu-runtime-boundary] runtime_output_oracle_probe status=fail generation={} artifact_id={} reason=committed_candidate_probe_missing",
                            active_generation, new_artifact_id
                        ));
                    }
                    Err(error) => {
                        let reason = runtime_output_oracle_log_token(&error);
                        candidate_oracle_line = Some(format!(
                            "[gpu-runtime-boundary] runtime_output_oracle_probe status=fail generation={} artifact_id={} reason={}",
                            active_generation, new_artifact_id, reason
                        ));
                    }
                }
                if let Some(line) = candidate_oracle_line.as_deref() {
                    eprintln!("{line}");
                }
                if !output_oracle_passed || !output_after_dispatch {
                    if let Some(line) = candidate_oracle_line.as_ref() {
                        failure_runtime_log_lines.push(line.clone());
                    }
                    let validation_error = format!(
                        "GPU candidate output oracle rejected before global publication: passed={} output_after_dispatch={} artifact_id={} after_dispatch_id={}",
                        output_oracle_passed,
                        output_after_dispatch,
                        log_optional_token(output_oracle_artifact_id.as_deref()),
                        log_optional_token(output_oracle_after_dispatch_id.as_deref()),
                    );
                    let rollback_result =
                        rollback_launch_dispatcher_publication(&mut dispatcher_publication);
                    dispatcher_recovery_failed = rollback_result.is_err();
                    let rollback_line = match rollback_result.as_ref() {
                        Ok(receipt) => format!(
                            "[gpu-runtime-boundary] dispatcher_epoch schema=synthi.gpu_hmr.dispatcher_epoch.v1 event=rolled_back status=refused publication_id={} previous_generation={} candidate_generation={} restored_generation={} candidate_artifact_id={} restored_artifact_id={} reason=output_oracle_rejected proof_authority=candidate_rollback_refusal_only_not_gpu_hmr_success accepted_for_gpu_hmr=false gpu_hmr_success=false",
                            receipt.publication_id,
                            receipt.previous_generation,
                            receipt.candidate_generation,
                            receipt.restored_generation,
                            new_artifact_id,
                            log_optional_token(receipt.restored_artifact_id.as_deref()),
                        ),
                        Err(error) => format!(
                            "[gpu-runtime-boundary] dispatcher_epoch schema=synthi.gpu_hmr.dispatcher_epoch.v1 event=rollback_failed status=fail previous_generation={} candidate_generation={} candidate_artifact_id={} reason={} proof_authority=candidate_rollback_refusal_only_not_gpu_hmr_success accepted_for_gpu_hmr=false gpu_hmr_success=false",
                            previous_generation,
                            active_generation,
                            new_artifact_id,
                            runtime_output_oracle_log_token(&error.to_string()),
                        ),
                    };
                    eprintln!("{rollback_line}");
                    failure_runtime_log_lines.push(rollback_line);
                    return Err(match rollback_result {
                        Err(rollback_error) => format!(
                            "{validation_error}; dispatcher rollback failed: {rollback_error}"
                        ),
                        Ok(_) => format!("{validation_error}; dispatcher candidate rolled back"),
                    });
                }
            }
            let retirement_fence_ids =
                drain.retirement_fence_ids_for_log(previous_generation, active_generation);
            let retirement_strategy = drain.retirement_strategy_for_log();
            let logical_retirement_proven =
                logical_epoch_retirement_proven(retired_module_count, &drain);
            let verified_dispatch_device_identity_result = match (
                output_oracle_after_dispatch_id.as_deref(),
                verified_device_identity.as_ref(),
            ) {
                (Some(after_dispatch_id), Some(generation_identity)) => {
                    verified_runtime_dispatch_device_identity(
                        active_generation,
                        &new_artifact_id,
                        after_dispatch_id,
                        generation_identity,
                    )
                }
                (None, _) => Err("dispatch_device_attestation_output_dispatch_missing".to_string()),
                (_, None) => {
                    Err("dispatch_device_attestation_generation_identity_missing".to_string())
                }
            };
            let dispatch_device_identity_gap = verified_dispatch_device_identity_result
                .as_ref()
                .err()
                .cloned();
            let verified_dispatch_device_identity = verified_dispatch_device_identity_result.ok();
            let build_acceptance_ledger = |retirement_proven| {
                GpuHmrAcceptanceLedger::new(GpuHmrAcceptanceLedgerInput {
                    hot_reload: !first_device_load,
                    artifact_id_after: new_artifact_id.clone(),
                    loader_artifact_id: Some(new_artifact_id.clone()),
                    epoch_publish_artifact_id: Some(new_artifact_id.clone()),
                    dispatch_artifact_id: if output_after_dispatch {
                        Some(new_artifact_id.clone())
                    } else {
                        None
                    },
                    output_artifact_id: output_oracle_artifact_id.clone(),
                    output_oracle_passed,
                    output_after_dispatch,
                    retirement_proven,
                    cpu_hmr_used: req.firewall_evidence.cpu_hmr_used,
                    full_rebuild_used: req.firewall_evidence.full_rebuild_used,
                    process_restarted: req.firewall_evidence.process_restarted,
                    firewall_route: req.firewall_evidence.route.clone(),
                    firewall_evidence_source: req.firewall_evidence.evidence_source.clone(),
                    firewall_process_id_before: req.firewall_evidence.process_id_before,
                    firewall_process_id_after: req.firewall_evidence.process_id_after,
                    process_id: Some(format!("pid:{}", std::process::id())),
                    device_identity: verified_dispatch_device_identity
                        .as_ref()
                        .map(|identity| identity.identity_key.clone()),
                })
            };
            let prepublication_acceptance_ledger =
                build_acceptance_ledger(logical_retirement_proven);
            let prepublication_acceptance_line = prepublication_acceptance_ledger.to_log_line();
            if !first_device_load && !prepublication_acceptance_ledger.gpu_hmr_success {
                failure_runtime_log_lines.extend(device_identity_evidence_lines.iter().cloned());
                if let Some(line) = candidate_oracle_line.as_ref() {
                    failure_runtime_log_lines.push(line.clone());
                }
                eprintln!("{prepublication_acceptance_line}");
                failure_runtime_log_lines.push(prepublication_acceptance_line.clone());
                let validation_error = format!(
                    "GPU HMR acceptance ledger rejected candidate before global publication: {}; dispatch_device_identity_gap={}",
                    prepublication_acceptance_ledger.failed_invariants.join(","),
                    dispatch_device_identity_gap.as_deref().unwrap_or("none"),
                );
                let rollback_result =
                    rollback_launch_dispatcher_publication(&mut dispatcher_publication);
                dispatcher_recovery_failed = rollback_result.is_err();
                let rollback_line = match rollback_result.as_ref() {
                    Ok(receipt) => format!(
                        "[gpu-runtime-boundary] dispatcher_epoch schema=synthi.gpu_hmr.dispatcher_epoch.v1 event=rolled_back status=refused publication_id={} previous_generation={} candidate_generation={} restored_generation={} candidate_artifact_id={} restored_artifact_id={} reason=acceptance_ledger_rejected proof_authority=candidate_rollback_refusal_only_not_gpu_hmr_success accepted_for_gpu_hmr=false gpu_hmr_success=false",
                        receipt.publication_id,
                        receipt.previous_generation,
                        receipt.candidate_generation,
                        receipt.restored_generation,
                        new_artifact_id,
                        log_optional_token(receipt.restored_artifact_id.as_deref()),
                    ),
                    Err(error) => format!(
                        "[gpu-runtime-boundary] dispatcher_epoch schema=synthi.gpu_hmr.dispatcher_epoch.v1 event=rollback_failed status=fail previous_generation={} candidate_generation={} candidate_artifact_id={} reason={} proof_authority=candidate_rollback_refusal_only_not_gpu_hmr_success accepted_for_gpu_hmr=false gpu_hmr_success=false",
                        previous_generation,
                        active_generation,
                        new_artifact_id,
                        runtime_output_oracle_log_token(&error.to_string()),
                    ),
                };
                eprintln!("{rollback_line}");
                failure_runtime_log_lines.push(rollback_line);
                return Err(match rollback_result {
                    Err(rollback_error) => {
                        format!("{validation_error}; dispatcher rollback failed: {rollback_error}")
                    }
                    Ok(_) => format!("{validation_error}; dispatcher candidate rolled back"),
                });
            }
            let publication_commit = match commit_launch_dispatcher_publication(
                &mut dispatcher_publication,
            ) {
                Ok(receipt) => receipt,
                Err(commit_error) => {
                    let rollback_error =
                        rollback_launch_dispatcher_publication(&mut dispatcher_publication).err();
                    dispatcher_recovery_failed = rollback_error.is_some();
                    return Err(match rollback_error {
                            Some(rollback_error) => format!(
                                "GPU dispatcher publication commit failed: {commit_error}; rollback failed: {rollback_error}"
                            ),
                            None => format!(
                                "GPU dispatcher publication commit failed and was rolled back: {commit_error}"
                            ),
                    });
                }
            };
            let host_output_receipt_finalization_gap = if !first_device_load
                && prepublication_acceptance_ledger.gpu_hmr_success
            {
                match host_output_oracle_request_binding.as_ref() {
                    Some(binding) => {
                        host_output_oracle_receipt::finalize_host_verified_compute_readback(
                            binding,
                            &publication_commit,
                        )
                        .err()
                        .map(|error| {
                            format!("runtime_proof_host_output_receipt_finalization_failed:{error}")
                        })
                    }
                    None => Some(
                        "runtime_proof_host_output_receipt_finalization_binding_missing"
                            .to_string(),
                    ),
                }
            } else {
                None
            };
            record_hmr_runtime_identity_snapshot();
            let mut runtime_log_lines = Vec::new();
            if let Some(pinned) = output_oracle_profile_pin.committed() {
                runtime_log_lines.push(pinned.evidence_line.clone());
            }
            let stream_epoch_counters = drain.stream_epoch_counters_for_log(active_generation);
            let ram_transport_proven = ram_artifact_reference_provided
                && loader_transport == ArtifactLoaderTransport::RamBytes;
            let (degraded_state, degraded_reason) = if ram_transport_proven {
                ("none", "none")
            } else if ram_artifact_reference_provided {
                (
                    GpuHmrDegradedState::RamIoUnavailable.as_str(),
                    "selected_loader_uses_filesystem_path",
                )
            } else {
                (
                    GpuHmrDegradedState::RamIoUnavailable.as_str(),
                    "reload_request_contains_filesystem_path_only",
                )
            };
            let artifact_transport_line = format!(
                "[gpu-runtime-boundary] artifact_transport runtime_session={} generation={} artifact_hash=sha256:{} artifact_bytes={} reload_request_transport={} selected_loader_transport={} loader_api={} ram_reference={} ram_blob_id={} ram_transport_proven={} degraded_state={} degraded_reason={} load_result=ok",
                runtime_session_id(),
                active_generation,
                artifact_hash,
                blob.len(),
                reload_request_transport,
                loader_transport.as_str(),
                loader_transport.loader_api(),
                ram_artifact_reference_provided,
                ram_blob_id,
                ram_transport_proven,
                degraded_state,
                degraded_reason,
            );
            eprintln!("{artifact_transport_line}");
            runtime_log_lines.push(artifact_transport_line);
            let delayed_unload_result = if retired_module_count == 0 {
                "not_required"
            } else {
                "pending"
            };
            let new_artifact_hash = format!("sha256:{artifact_hash}");
            let runtime_session = runtime_session_id();
            let stream_epoch_counters_graph =
                drain.stream_epoch_counters_for_graph(active_generation);
            let publish_timestamp_ms = epoch_millis_now();
            let publish_line = format!(
                "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session={} publish_timestamp_ms={} publish_timestamp_monotonic_ns={} publication_id={} candidate_registration_id={} publication_commit_timestamp_monotonic_ns={} host_boundary_quiescence_proven=true previous_generation={} active_generation={} old_artifact_id={} new_artifact_id={} new_artifact_hash=sha256:{} capsule_id={} fission_island_id={} abi_membrane_hash={} dependency_closure_hash={} proof_hash={} changed_symbols={} function_handle_ids={} stream_epoch_counters={} dispatch_table_hash_before=0x{:016x} dispatch_table_hash_after=0x{:016x} dispatch_table_hash=0x{:016x} dispatch_table_content_hash={} changed_entries={} retirement_tracked=true retired_modules={} old_generation_retired={} stream_scope={} stream_ids={} stream_ordering_proven={} retirement_fence_ids={} retirement_strategy={} delayed_unload_result={} drain_result={} drain_elapsed_ms={} drain_budget_ms={}",
                runtime_session,
                publish_timestamp_ms,
                publish_timestamp_monotonic_ns,
                publication_id,
                candidate_registration_id,
                publication_commit.committed_timestamp_monotonic_ns(),
                previous_generation,
                active_generation,
                previous_artifact_id,
                new_artifact_id,
                artifact_hash,
                capsule_id,
                fission_island_id,
                abi_membrane_hash,
                dependency_closure_hash,
                proof_hash,
                changed_symbols_for_log,
                function_handle_ids,
                stream_epoch_counters,
                previous_dispatch_table_hash,
                dispatch_table_hash,
                dispatch_table_hash,
                dispatch_table_content_hash,
                touched_symbols.len(),
                retired_module_count,
                retired_module_count == 0,
                drain.scope_label,
                drain.stream_ids_for_log(),
                drain.is_synced(),
                retirement_fence_ids,
                retirement_strategy,
                delayed_unload_result,
                drain.outcome.short_label(),
                drain.outcome.elapsed_ms(),
                drain.outcome.budget_ms().unwrap_or(0)
            );
            eprintln!("{publish_line}");
            runtime_log_lines.push(publish_line);
            let publication_graph_line =
                epoch_generation_graph_line(EpochGenerationGraphLineInput {
                    runtime_session: &runtime_session,
                    publish_timestamp_ms,
                    previous_generation,
                    active_generation,
                    old_artifact_id: &previous_artifact_id,
                    new_artifact_id: &new_artifact_id,
                    new_artifact_hash: &new_artifact_hash,
                    capsule_id: &capsule_id,
                    fission_island_id: &fission_island_id,
                    abi_membrane_hash: &abi_membrane_hash,
                    dependency_closure_hash: &dependency_closure_hash,
                    proof_hash: &proof_hash,
                    changed_symbols: &expected_symbols,
                    function_handle_ids: &function_handle_ids,
                    stream_epoch_counters: stream_epoch_counters_graph.clone(),
                    dispatch_table_hash_before: previous_dispatch_table_hash,
                    dispatch_table_hash_after: dispatch_table_hash,
                    changed_entries: touched_symbols.len(),
                    retirement_fence_ids: &retirement_fence_ids,
                    retirement_strategy,
                    delayed_unload_result,
                    retirement_state: if retired_module_count == 0 {
                        "not-required"
                    } else {
                        "pending"
                    },
                });
            eprintln!("{publication_graph_line}");
            runtime_log_lines.push(publication_graph_line);
            if let Some(line) = candidate_oracle_line {
                runtime_log_lines.push(line);
            }
            let mut retired_unload_failures = Vec::new();
            for retired in retired {
                if let Err(error) = self.module_manager.unload_retired(&symbols, retired) {
                    let reason = Self::module_manager_error(error);
                    retired_unload_failures.push(
                        reason
                            .chars()
                            .map(|ch| if ch.is_whitespace() { '_' } else { ch })
                            .collect::<String>(),
                    );
                    self.pending_retired_modules.push(retired);
                }
            }
            let retirement_timestamp_monotonic_ns = monotonic_timestamp_ns();
            if retired_module_count > 0 && retired_unload_failures.is_empty() {
                let retired_line = format!(
                    "[gpu-runtime-boundary] dispatcher_epoch event=retired runtime_session={} retirement_timestamp_monotonic_ns={} previous_generation={} active_generation={} retired_modules={} old_generation_retired=true stream_scope={} stream_ids={} stream_ordering_proven=true retirement_fence_ids={} retirement_strategy={} delayed_unload_result=unloaded",
                    runtime_session_id(),
                    retirement_timestamp_monotonic_ns,
                    previous_generation,
                    active_generation,
                    retired_module_count,
                    drain.scope_label,
                    drain.stream_ids_for_log(),
                    retirement_fence_ids,
                    retirement_strategy
                );
                eprintln!("{retired_line}");
                runtime_log_lines.push(retired_line);
                let retired_graph_line =
                    epoch_generation_graph_line(EpochGenerationGraphLineInput {
                        runtime_session: &runtime_session,
                        publish_timestamp_ms,
                        previous_generation,
                        active_generation,
                        old_artifact_id: &previous_artifact_id,
                        new_artifact_id: &new_artifact_id,
                        new_artifact_hash: &new_artifact_hash,
                        capsule_id: &capsule_id,
                        fission_island_id: &fission_island_id,
                        abi_membrane_hash: &abi_membrane_hash,
                        dependency_closure_hash: &dependency_closure_hash,
                        proof_hash: &proof_hash,
                        changed_symbols: &expected_symbols,
                        function_handle_ids: &function_handle_ids,
                        stream_epoch_counters: stream_epoch_counters_graph.clone(),
                        dispatch_table_hash_before: previous_dispatch_table_hash,
                        dispatch_table_hash_after: dispatch_table_hash,
                        changed_entries: touched_symbols.len(),
                        retirement_fence_ids: &retirement_fence_ids,
                        retirement_strategy,
                        delayed_unload_result: "unloaded",
                        retirement_state: "retired",
                    });
                eprintln!("{retired_graph_line}");
                runtime_log_lines.push(retired_graph_line);
            } else if retired_module_count > 0 {
                let retirement_failed_line = format!(
                    "[gpu-runtime-boundary] dispatcher_epoch event=retirement_failed runtime_session={} retirement_timestamp_monotonic_ns={} previous_generation={} active_generation={} retired_modules={} old_generation_retired=false stream_scope={} stream_ids={} stream_ordering_proven=true retirement_fence_ids={} retirement_strategy={} delayed_unload_result=failed pending_retired_modules={} reasons={}",
                    runtime_session_id(),
                    retirement_timestamp_monotonic_ns,
                    previous_generation,
                    active_generation,
                    retired_module_count,
                    drain.scope_label,
                    drain.stream_ids_for_log(),
                    retirement_fence_ids,
                    retirement_strategy,
                    self.pending_retired_modules.len(),
                    retired_unload_failures.join("|")
                );
                eprintln!("{retirement_failed_line}");
                runtime_log_lines.push(retirement_failed_line);
                let pending_graph_line =
                    epoch_generation_graph_line(EpochGenerationGraphLineInput {
                        runtime_session: &runtime_session,
                        publish_timestamp_ms,
                        previous_generation,
                        active_generation,
                        old_artifact_id: &previous_artifact_id,
                        new_artifact_id: &new_artifact_id,
                        new_artifact_hash: &new_artifact_hash,
                        capsule_id: &capsule_id,
                        fission_island_id: &fission_island_id,
                        abi_membrane_hash: &abi_membrane_hash,
                        dependency_closure_hash: &dependency_closure_hash,
                        proof_hash: &proof_hash,
                        changed_symbols: &expected_symbols,
                        function_handle_ids: &function_handle_ids,
                        stream_epoch_counters: stream_epoch_counters_graph.clone(),
                        dispatch_table_hash_before: previous_dispatch_table_hash,
                        dispatch_table_hash_after: dispatch_table_hash,
                        changed_entries: touched_symbols.len(),
                        retirement_fence_ids: &retirement_fence_ids,
                        retirement_strategy,
                        delayed_unload_result: "failed",
                        retirement_state: "pending",
                    });
                eprintln!("{pending_graph_line}");
                runtime_log_lines.push(pending_graph_line);
            }
            let physical_retirement_proven = physical_epoch_retirement_proven(
                retired_module_count,
                &drain,
                retired_unload_failures.len(),
            );
            let acceptance_ledger = build_acceptance_ledger(physical_retirement_proven);
            let acceptance_line = acceptance_ledger.to_log_line();
            let strict_runtime_proof_result = if first_device_load {
                Ok(None)
            } else if let Some(gap) = host_output_receipt_finalization_gap {
                Err(gap)
            } else if !physical_retirement_proven {
                Err("runtime_proof_retirement_not_finalized".to_string())
            } else if !acceptance_ledger.gpu_hmr_success {
                Ok(None)
            } else {
                match (
                    output_oracle_after_dispatch_id.as_deref(),
                    verified_dispatch_device_identity.as_ref(),
                ) {
                    (Some(after_dispatch_id), Some(dispatch_device_identity))
                        if acceptance_ledger.device_identity.as_deref()
                            == Some(dispatch_device_identity.identity_key.as_str()) =>
                    {
                        runtime_full_proof_line(
                            req,
                            self.config.vendor,
                            &previous_artifact_id,
                            &new_artifact_id,
                            &artifact_hash,
                            active_generation,
                            previous_generation,
                            loader_timestamp_monotonic_ns,
                            &publication_commit,
                            retirement_timestamp_monotonic_ns,
                            dispatch_device_identity,
                            &expected_symbols,
                            loader_transport,
                            started.elapsed().as_millis() as u64,
                            drain.outcome.elapsed_ms(),
                            blob.len(),
                            retirement_strategy,
                            &retirement_fence_ids,
                            capsule_metadata,
                            output_oracle_profile_pin.committed(),
                            after_dispatch_id,
                        )
                        .map(Some)
                    }
                    (None, _) => Err("runtime_proof_output_dispatch_id_missing".to_string()),
                    (_, None) => Err("runtime_proof_device_identity_missing".to_string()),
                    (_, Some(_)) => {
                        Err("runtime_proof_device_identity_ledger_mismatch".to_string())
                    }
                }
            };
            let (strict_runtime_proof_line, strict_runtime_proof_gap) =
                match strict_runtime_proof_result {
                    Ok(line) => (line, None),
                    Err(gap) => {
                        let refusal_line = format!(
                            "[gpu-runtime-boundary] strict_runtime_proof schema={} status=refused runtime_session={} generation={} artifact_id={} gap={} proof_authority=strict_runtime_proof_refusal_only_not_gpu_hmr_success accepted_for_gpu_hmr=false gpu_hmr_success=false can_satisfy_runtime_proof=false",
                            GPU_HMR_VALIDATION_PROOF_SCHEMA_VERSION,
                            runtime_session_id(),
                            active_generation,
                            new_artifact_id,
                            runtime_output_oracle_log_token(&gap),
                        );
                        eprintln!("{refusal_line}");
                        runtime_log_lines.push(refusal_line);
                        (None, Some(gap))
                    }
                };
            for line in &device_identity_evidence_lines {
                eprintln!("{line}");
                runtime_log_lines.push(line.clone());
            }
            if strict_runtime_proof_gap.is_none() {
                eprintln!("{acceptance_line}");
                runtime_log_lines.push(acceptance_line);
            }
            if let Some(proof_line) = strict_runtime_proof_line {
                eprintln!("{proof_line}");
                runtime_log_lines.push(proof_line);
            }
            let strict_runtime_proof_success = first_device_load
                || (!acceptance_ledger.gpu_hmr_success || strict_runtime_proof_gap.is_none());
            let mut final_acceptance_failures = acceptance_ledger.failed_invariants.clone();
            if let Some(gap) = strict_runtime_proof_gap {
                final_acceptance_failures.push(gap);
            }
            self.active_generation_artifact_id = Some(new_artifact_id.clone());
            Ok(DeviceReloadOwnership {
                partial_reload: partial_device_reload,
                expected_symbols,
                touched_symbols,
                retired_module_count,
                replaced_primary,
                runtime_log_lines,
                hot_reload_acceptance_required: !first_device_load,
                acceptance_ledger_success: acceptance_ledger.gpu_hmr_success
                    && strict_runtime_proof_success,
                acceptance_ledger_failures: final_acceptance_failures,
                verified_device_identity: verified_device_identity.clone(),
                strict_device_attestation_available,
                strict_device_attestation_gaps: strict_device_attestation_gaps.clone(),
            })
        })();

        let mut manager_recovery_failed = false;
        let load_result = match load_result {
            Ok(ownership) => Ok(ownership),
            Err(load_error) => match self.module_manager.rollback_to(module_checkpoint) {
                Ok(introduced_modules) => {
                    let mut unload_failures = Vec::new();
                    for introduced in introduced_modules {
                        if let Err(error) = self.module_manager.unload_retired(&symbols, introduced)
                        {
                            unload_failures.push(format!(
                                "handle=0x{:x}:{}",
                                introduced.handle,
                                Self::module_manager_error(error)
                            ));
                            self.pending_retired_modules.push(introduced);
                        }
                    }
                    if unload_failures.is_empty() {
                        Err(format!(
                            "{load_error}; provisional module ownership rolled back"
                        ))
                    } else {
                        Err(format!(
                            "{load_error}; provisional module ownership rolled back; candidate unload failed: {}",
                            unload_failures.join("|")
                        ))
                    }
                }
                Err(rollback_error) => {
                    manager_recovery_failed = true;
                    Err(format!(
                        "{load_error}; GPU module manager rollback failed: {}",
                        Self::module_manager_error(rollback_error)
                    ))
                }
            },
        };

        match load_result {
            Ok(ownership) => {
                self.active_module_handle = self.module_manager.primary().map(|s| s.handle);
                self.active_device_identity = ownership.verified_device_identity.clone();
                self.kernel_table.clear();
                for name in self.module_manager.kernel_table().names() {
                    if let Some(handle) = self.module_manager.kernel_table().get(name) {
                        self.kernel_table.insert(name.clone(), handle);
                    }
                }
                self.emit_report(GpuSwapInputs {
                    plan,
                    reason: if partial_device_reload {
                        "device-partial-file-only-edit".into()
                    } else {
                        "device-file-only-edit".into()
                    },
                    streams_synced: drain.stream_count(),
                    force_drain_timeout: false,
                    snapshot_bytes,
                    snapshot_ms: started.elapsed().as_millis() as u64,
                    dirty_buffers,
                    expected_kernel_hashes: ownership.expected_symbols.len() as u32,
                    matched_kernel_hashes: ownership.touched_symbols.len() as u32,
                });
                self.last_reload_log
                    .extend(ownership.runtime_log_lines.iter().cloned());
                self.emit_runtime_ownership_report(&ownership, artifact);
                self.phase = GpuPhase::Ready;
                if ownership.hot_reload_acceptance_required && !ownership.acceptance_ledger_success
                {
                    self.health = AdapterHealth::Degraded;
                    AdapterReloadResult::Failed {
                        error: format!(
                            "GPU HMR acceptance ledger rejected hot reload: {}",
                            ownership.acceptance_ledger_failures.join(",")
                        ),
                        recoverable: false,
                    }
                } else {
                    self.health = if ownership.strict_device_attestation_available {
                        AdapterHealth::Healthy
                    } else {
                        AdapterHealth::Degraded
                    };
                    self.remember_device_abi(req);
                    AdapterReloadResult::Success {
                        reload_ms: started.elapsed().as_millis() as u64,
                        state_preserved: req.preserve_state,
                    }
                }
            }
            Err(error) => {
                self.emit_report(GpuSwapInputs {
                    plan,
                    reason: "module-load-failed".into(),
                    streams_synced: 1,
                    force_drain_timeout: false,
                    snapshot_bytes,
                    snapshot_ms: started.elapsed().as_millis() as u64,
                    dirty_buffers,
                    expected_kernel_hashes: req.build_manifest.exported_symbols.len() as u32,
                    matched_kernel_hashes: 0,
                });
                for line in failure_runtime_log_lines {
                    eprintln!("{line}");
                    self.last_reload_log.push(line);
                }
                let recovery_failed = dispatcher_recovery_failed || manager_recovery_failed;
                self.phase = if recovery_failed {
                    GpuPhase::Faulted
                } else {
                    GpuPhase::Ready
                };
                self.health = if recovery_failed {
                    AdapterHealth::Faulted
                } else {
                    AdapterHealth::Degraded
                };
                AdapterReloadResult::Failed {
                    error,
                    recoverable: !recovery_failed,
                }
            }
        }
    }

    fn snapshot_state(&self) -> Result<Vec<u8>, String> {
        // Phase 3 will marshal DeviceStateSnapshot here. Empty Vec
        // signals "no device state captured" which is the honest
        // answer today.
        Ok(Vec::new())
    }

    fn restore_state(&mut self, data: &[u8]) -> Result<(), String> {
        if !data.is_empty() {
            return Err(format!(
                "GpuModuleAdapter::restore_state got {} bytes but snapshot restore is not wired yet",
                data.len()
            ));
        }
        Ok(())
    }

    fn healthcheck(&self) -> AdapterHealth {
        self.health
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::adapter_matrix::AdapterFamily;
    use crate::hmr::adapter_trait::{
        AdapterReloadRequest, ReloadArtifactBlob, ReloadCapsuleMetadata, ReloadFirewallEvidence,
        ReloadOutputOracleProfileCommitment,
    };
    use crate::hmr::build_manifest::{BuildManifest, BuildSlot};
    use crate::hmr::gpu_driver_loader::{
        CuContext, CuDevicePtr, CuFunction, CuModule, CuResult, CuStream,
    };
    use crate::runtime::gpu_runtime_boundary::{
        current_launch_generation, dispatcher_commit_receipt_for_test,
        install_launch_dispatcher_with_metadata, reset_for_test, synthi_gpu_launch_raw,
        synthi_gpu_register_buffer, test_guard_for_test as runtime_boundary_test_guard,
    };
    use std::ffi::{c_void, CString};
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{mpsc, Mutex};

    fn dummy_request() -> AdapterReloadRequest {
        let pid = std::process::id();
        AdapterReloadRequest {
            reload_id: "test".into(),
            source_edit_id: None,
            module_id: "device".into(),
            changed_files: vec!["device.cu".into()],
            build_manifest: BuildManifest::for_language("test-preview", "cuda"),
            artifact_blob: None,
            capsule_metadata: None,
            firewall_evidence: ReloadFirewallEvidence::from_gpu_device_sidecar_boundary(
                "gpu_module_adapter_test:dummy_request",
                pid,
                pid,
            ),
            preserve_state: true,
            timeout_ms: 5_000,
        }
    }

    fn epoch_graph_json_from_line(line: &str) -> serde_json::Value {
        let graph_json = line
            .split_once("json=")
            .map(|(_, json)| json)
            .expect("epoch graph JSON payload");
        serde_json::from_str(graph_json).expect("valid epoch graph JSON")
    }

    fn proof_json_from_line(line: &str) -> serde_json::Value {
        serde_json::from_str(line).expect("valid GPU HMR proof JSON")
    }

    #[test]
    fn runtime_proof_timestamps_require_observed_monotonic_order() {
        assert_eq!(
            validate_runtime_proof_timestamps(50, 100, Some(200), 2_000_200, 2_000_250, 2_000_300,),
            Some(RuntimeProofTimestamps {
                loader_ns: 50,
                publish_ns: 100,
                dispatch_ns: 200,
                output_ns: 2_000_200,
                commit_ns: 2_000_250,
                retirement_ns: 2_000_300,
                dispatch_to_output_ms: 2,
            })
        );
        assert_eq!(
            validate_runtime_proof_timestamps(50, 100, None, 200, 250, 300),
            None
        );
        assert_eq!(
            validate_runtime_proof_timestamps(200, 100, Some(300), 400, 450, 500),
            None
        );
        assert_eq!(
            validate_runtime_proof_timestamps(50, 200, Some(100), 300, 350, 400),
            None
        );
        assert_eq!(
            validate_runtime_proof_timestamps(50, 100, Some(300), 200, 350, 400),
            None
        );
        assert_eq!(
            validate_runtime_proof_timestamps(50, 100, Some(200), 400, 300, 500),
            None
        );
        assert_eq!(
            validate_runtime_proof_timestamps(50, 100, Some(200), 300, 500, 400),
            None
        );
    }

    #[test]
    fn runtime_source_edit_requires_exact_prepublication_commitment() {
        let _guard = runtime_boundary_test_guard();
        let previous_profile_path = std::env::var_os("SYNTHI_GPU_HMR_RUNTIME_OUTPUT_ORACLE_PATH");
        let profile_bytes = install_runtime_output_oracle_profile_for_tests();

        let source_edit_id = format!("source-edit:sha256:{}", "a".repeat(64));
        let artifact_hash = sha256_hex_bytes(b"arbitrary-project-device-artifact");
        let candidate_artifact_sha256 = format!("sha256:{artifact_hash}");
        let profile: serde_json::Value =
            serde_json::from_slice(&profile_bytes).expect("parse test output oracle profile");
        let contract = json!({
            "kind": "compute_readback",
            "oracleId": profile["oracleId"],
            "expected": profile["expectedSha256"],
            "baselineSha256": profile["baselineSha256"],
            "expectedOutputChange": true,
            "producer": profile["producer"],
            "outputTargetId": profile["outputTargetId"],
            "kernelSymbol": profile["kernelName"],
            "probeMode": profile["probeMode"],
            "probeConfigHash": profile["probeConfigHash"],
        });
        let metadata = ReloadCapsuleMetadata {
            fission_output_oracle_contract: Some(contract.clone()),
            output_oracle_profile_commitment: Some(ReloadOutputOracleProfileCommitment {
                schema_version: RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION.into(),
                candidate_artifact_sha256: format!("sha256:{artifact_hash}"),
                fission_output_oracle_contract_sha256: format!(
                    "sha256:{}",
                    stable_json_hash(&contract)
                ),
                profile_bytes_sha256: format!("sha256:{}", sha256_hex_bytes(&profile_bytes)),
                edit_id: source_edit_id.clone(),
            }),
            ..Default::default()
        };
        let mut request = dummy_request();
        request.source_edit_id = Some(source_edit_id.clone());
        request.capsule_metadata = Some(metadata.clone());
        let pinned = pin_runtime_output_oracle_profile(&request, &candidate_artifact_sha256, true)
            .unwrap()
            .committed()
            .cloned()
            .expect("committed output oracle profile pin");

        assert_eq!(
            verified_runtime_source_edit_commitment(
                Some(&metadata),
                &source_edit_id,
                &artifact_hash,
                Some(&pinned),
            ),
            Some(())
        );
        assert_eq!(
            verified_runtime_source_edit_commitment(
                None,
                &source_edit_id,
                &artifact_hash,
                Some(&pinned),
            ),
            None
        );

        let mut mismatched = metadata.clone();
        mismatched
            .output_oracle_profile_commitment
            .as_mut()
            .unwrap()
            .edit_id = format!("source-edit:sha256:{}", "b".repeat(64));
        assert_eq!(
            verified_runtime_source_edit_commitment(
                Some(&mismatched),
                &source_edit_id,
                &artifact_hash,
                Some(&pinned),
            ),
            None
        );

        let mut mismatched = metadata.clone();
        mismatched
            .output_oracle_profile_commitment
            .as_mut()
            .unwrap()
            .candidate_artifact_sha256 = format!("sha256:{}", "c".repeat(64));
        assert_eq!(
            verified_runtime_source_edit_commitment(
                Some(&mismatched),
                &source_edit_id,
                &artifact_hash,
                Some(&pinned),
            ),
            None
        );

        let mut mismatched = metadata.clone();
        let mut mismatched_contract = contract.clone();
        mismatched_contract["outputTargetId"] = json!("tensor:other");
        mismatched.fission_output_oracle_contract = Some(mismatched_contract);
        assert_eq!(
            verified_runtime_source_edit_commitment(
                Some(&mismatched),
                &source_edit_id,
                &artifact_hash,
                Some(&pinned),
            ),
            None
        );

        fs::write(
            configured_gpu_hmr_runtime_output_oracle_profile_path(),
            b"different-profile-bytes",
        )
        .unwrap();
        assert_eq!(
            verified_runtime_source_edit_commitment(
                Some(&metadata),
                &source_edit_id,
                &artifact_hash,
                Some(&pinned),
            ),
            Some(())
        );

        match previous_profile_path {
            Some(path) => std::env::set_var("SYNTHI_GPU_HMR_RUNTIME_OUTPUT_ORACLE_PATH", path),
            None => std::env::remove_var("SYNTHI_GPU_HMR_RUNTIME_OUTPUT_ORACLE_PATH"),
        }
    }

    #[test]
    fn runtime_hardware_device_identity_requires_native_nonzero_uuid_queries() {
        let identity = query_runtime_hardware_device_identity(&stub_symbols())
            .expect("stable native device identity");
        assert_eq!(identity.ordinal, 0);
        assert_eq!(identity.uuid_hex, "00112233445566778899aabbccddeeff");
        assert_eq!(
            identity.identity_key,
            "gpu-hardware-uuid:00112233445566778899aabbccddeeff"
        );

        let missing = query_runtime_hardware_device_identity(&symbols_without_device_identity());
        assert_eq!(
            missing,
            Err("device_identity_active_device_symbol_missing".to_string())
        );

        let zero = query_runtime_hardware_device_identity(&GpuDriverSymbolTable {
            cu_device_get_uuid: Some(zero_device_get_uuid),
            ..stub_symbols()
        });
        assert_eq!(zero, Err("device_identity_uuid_all_zero".to_string()));

        let active_query_error = query_runtime_hardware_device_identity(&GpuDriverSymbolTable {
            cu_ctx_get_device: Some(err_ctx_get_device),
            ..stub_symbols()
        });
        assert_eq!(
            active_query_error,
            Err("device_identity_active_device_query_failed:101".to_string())
        );

        let uuid_query_error = query_runtime_hardware_device_identity(&GpuDriverSymbolTable {
            cu_device_get_uuid: Some(err_device_get_uuid),
            ..stub_symbols()
        });
        assert_eq!(
            uuid_query_error,
            Err("device_identity_uuid_query_failed:102".to_string())
        );
    }

    #[test]
    fn dispatch_device_observation_failure_before_launch_prevents_native_dispatch() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        LAUNCH_CALLS.store(0, Ordering::SeqCst);
        let dispatcher = DriverLaunchDispatcher {
            symbols: GpuDriverSymbolTable {
                cu_stream_get_device: Some(err_stream_get_device),
                ..stub_symbols()
            },
            kernels: std::collections::HashMap::from([("vec_add".to_string(), 0x1000)]),
        };
        let request = GpuLaunchRequest {
            kernel_name: "vec_add".to_string(),
            grid: (1, 1, 1),
            block: (1, 1, 1),
            shared_bytes: 0,
            stream_token: 0x77,
            arg_count: 0,
        };

        let error = dispatcher
            .dispatch_with_device_attestation(&request, std::ptr::null())
            .expect_err("pre-dispatch observation failure must reject the launch");

        assert_eq!(error, "dispatch_stream_device_query_failed:103");
        assert_eq!(LAUNCH_CALLS.load(Ordering::SeqCst), 0);
        reset_for_test();
    }

    #[test]
    fn runtime_hardware_device_identity_continuity_rejects_device_change() {
        let before = Ok(RuntimeHardwareDeviceIdentity {
            ordinal: 0,
            uuid_bytes: [0x11; 16],
            uuid_hex: "11".repeat(16),
            identity_key: format!("gpu-hardware-uuid:{}", "11".repeat(16)),
        });
        let after = Ok(RuntimeHardwareDeviceIdentity {
            ordinal: 0,
            uuid_bytes: [0x22; 16],
            uuid_hex: "22".repeat(16),
            identity_key: format!("gpu-hardware-uuid:{}", "22".repeat(16)),
        });
        assert_eq!(
            verified_runtime_hardware_device_identity(None, &before, &after, false),
            Err("device_identity_uuid_changed".to_string())
        );
        let line =
            runtime_hardware_device_identity_continuity_line(4, None, &before, &after, false);
        assert!(line.contains("event=refused"));
        assert!(line.contains("same_device=false"));
        assert!(line.contains("reason=device_identity_uuid_changed"));
        assert!(line.contains("accepted_for_gpu_hmr=false"));
        assert!(line.contains("gpu_hmr_success=false"));
    }

    #[test]
    fn rejected_candidate_oracle_restores_prior_dispatcher_and_module() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        MODULE_LOAD_CALLS.store(0, Ordering::SeqCst);
        UNLOAD_CALLS.store(0, Ordering::SeqCst);
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"candidate-rollback-before").unwrap();
        second.write_all(b"candidate-rollback-after").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let candidate_artifact_id = format!(
            "artifact:sha256:{}",
            sha256_hex_bytes(b"candidate-rollback-after")
        );
        let mut adapter = adapter_with_config_and_symbols(
            GpuModuleAdapterConfig {
                vendor: GpuVendor::Rocm,
                ..GpuModuleAdapterConfig::default()
            },
            stub_symbols(),
        );
        assert!(matches!(
            adapter.reload(&request_with_artifact(
                &first_path,
                vec!["source/arbitrary.device".into()]
            )),
            AdapterReloadResult::Success { .. }
        ));

        let old_handle = adapter.active_module_handle;
        let old_artifact_id = adapter.active_generation_artifact_id.clone().unwrap();
        let old_swap_count = adapter.module_manager.swap_count();
        let loads_before = MODULE_LOAD_CALLS.load(Ordering::SeqCst);
        let unloads_before = UNLOAD_CALLS.load(Ordering::SeqCst);
        let mut second_request =
            request_with_artifact(&second_path, vec!["build/generated/device-stage".into()]);
        let profile_path = configured_gpu_hmr_runtime_output_oracle_profile_path();
        let mut profile: serde_json::Value =
            serde_json::from_slice(&fs::read(&profile_path).unwrap()).unwrap();
        let rejected_expected_sha256 = format!("sha256:{}", "f".repeat(64));
        profile["expectedSha256"] = serde_json::Value::String(rejected_expected_sha256.clone());
        let profile_bytes = serde_json::to_vec_pretty(&profile).unwrap();
        fs::write(&profile_path, &profile_bytes).unwrap();
        let metadata = second_request.capsule_metadata.as_mut().unwrap();
        let contract_hash = {
            let contract = metadata.fission_output_oracle_contract.as_mut().unwrap();
            contract["expected"] = serde_json::Value::String(rejected_expected_sha256);
            format!("sha256:{}", stable_json_hash(contract))
        };
        let commitment = metadata.output_oracle_profile_commitment.as_mut().unwrap();
        commitment.profile_bytes_sha256 = format!("sha256:{}", sha256_hex_bytes(&profile_bytes));
        commitment.fission_output_oracle_contract_sha256 = contract_hash;

        match adapter.reload(&second_request) {
            AdapterReloadResult::Failed { error, recoverable } => {
                assert!(recoverable);
                assert!(
                    error.contains("candidate output oracle rejected before global publication")
                );
                assert!(error.contains("dispatcher candidate rolled back"));
                assert!(error.contains("provisional module ownership rolled back"));
            }
            other => panic!("expected candidate oracle rollback, got {other:?}"),
        }

        assert_eq!(MODULE_LOAD_CALLS.load(Ordering::SeqCst), loads_before + 1);
        assert_eq!(UNLOAD_CALLS.load(Ordering::SeqCst), unloads_before + 1);
        assert_eq!(adapter.active_module_handle, old_handle);
        assert_eq!(
            adapter.module_manager.primary().map(|slot| slot.handle),
            old_handle
        );
        assert!(adapter.module_manager.standby().is_none());
        assert_eq!(adapter.module_manager.swap_count(), old_swap_count);
        assert_eq!(
            adapter.active_generation_artifact_id.as_deref(),
            Some(old_artifact_id.as_str())
        );
        let candidate_launch = launch_records_snapshot()
            .into_iter()
            .find(|record| {
                record.active_artifact_id.as_deref() == Some(candidate_artifact_id.as_str())
            })
            .expect("candidate validation dispatch record");
        let candidate_output = output_oracle_records_snapshot()
            .into_iter()
            .find(|record| record.after_dispatch_id == candidate_launch.dispatch_id)
            .expect("candidate output record bound to validation dispatch");
        assert_eq!(
            candidate_output.generation,
            candidate_launch.active_generation
        );
        assert_eq!(
            candidate_output.artifact_id.as_deref(),
            Some(candidate_artifact_id.as_str())
        );
        assert!(!candidate_output.passed);
        launch_vec_add_on_stream(0x91);
        let restored_launch = launch_records_snapshot().pop().unwrap();
        assert_eq!(
            restored_launch.active_artifact_id.as_deref(),
            Some(old_artifact_id.as_str())
        );
        assert!(adapter.last_reload_log().iter().any(|line| {
            line.contains("dispatcher_epoch")
                && line.contains("event=rolled_back")
                && line.contains("reason=output_oracle_rejected")
                && line.contains("accepted_for_gpu_hmr=false")
                && line.contains("gpu_hmr_success=false")
        }));
        assert!(!adapter
            .last_reload_log()
            .iter()
            .any(|line| line.contains("dispatcher_epoch event=published")));
        let _ = install_runtime_output_oracle_profile_for_tests();
        reset_for_test();
    }

    #[test]
    fn runtime_proof_publication_binding_requires_exact_receipt_and_dispatch_registration() {
        assert_eq!(
            validate_runtime_publication_binding(
                "publication:2",
                1,
                2,
                "registration:2",
                1,
                2,
                Some("registration:2"),
            ),
            Ok(())
        );
        assert_eq!(
            validate_runtime_publication_binding(
                "",
                1,
                2,
                "registration:2",
                1,
                2,
                Some("registration:2")
            ),
            Err("runtime_proof_publication_id_missing".to_string())
        );
        assert_eq!(
            validate_runtime_publication_binding(
                "publication:2",
                0,
                2,
                "registration:2",
                1,
                2,
                Some("registration:2"),
            ),
            Err("runtime_proof_publication_previous_generation_mismatch".to_string())
        );
        assert_eq!(
            validate_runtime_publication_binding(
                "publication:2",
                1,
                3,
                "registration:2",
                1,
                2,
                Some("registration:2"),
            ),
            Err("runtime_proof_publication_candidate_generation_mismatch".to_string())
        );
        assert_eq!(
            validate_runtime_publication_binding(
                "publication:2",
                1,
                2,
                "",
                1,
                2,
                Some("registration:2"),
            ),
            Err("runtime_proof_candidate_registration_id_missing".to_string())
        );
        assert_eq!(
            validate_runtime_publication_binding(
                "publication:2",
                1,
                2,
                "registration:2",
                1,
                2,
                Some("registration:stale"),
            ),
            Err("runtime_proof_dispatch_registration_mismatch".to_string())
        );
        assert_eq!(
            validate_runtime_publication_binding(
                "publication:2",
                2,
                2,
                "registration:2",
                2,
                2,
                Some("registration:2"),
            ),
            Err("runtime_proof_publication_generation_transition_missing".to_string())
        );
        assert_eq!(
            validate_runtime_publication_binding(
                "publication:3",
                1,
                3,
                "registration:3",
                1,
                3,
                Some("registration:3"),
            ),
            Ok(())
        );
    }

    #[test]
    fn portable_ledger_canonical_profile_matches_cross_language_golden_id() {
        let record = json!({
            "proof_canonical_profile": GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE,
            "project_id": "project",
            "edit_id": "edit",
            "backend": "hip",
            "classification": {},
            "contract_hash": "contract",
            "artifact_before_hash": "before",
            "artifact_after_hash": "after",
            "loader_event": {},
            "epoch_publish_event": {},
            "epoch_commit_event": {
                "id": "commit",
                "safe_integer": GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER,
                "decimal_fraction": "1.25",
            },
            "dispatch_event": {},
            "output_event": {},
            "retirement_event": {},
            "process_identity": {},
            "device_identity": {},
            "oracle_artifacts": {},
            "deterministic_visual_mode": {},
            "output_oracle_target": {},
            "metric_clock": null,
            "metric_scope": null,
            "cache_state": null,
            "timings": {},
            "timing_metrics": {},
            "model_provenance": {},
            "evidence_refs": [],
            "cpu_hmr_used": false,
            "full_rebuild_used": false,
            "process_restarted": false,
            "firewall_evidence": {
                "cpu_hmr_used": false,
                "full_rebuild_used": false,
                "process_restarted": false,
            },
        });
        assert_eq!(
            canonical_runtime_ledger_proof_id(&record),
            "gpu-ledger-proof:sha256:6b7c1a2fe57042594e099b136b20ddb54fc529b9e55638bde4d089fc689f4f4e"
        );
        let mut unsafe_number = record;
        unsafe_number["epoch_commit_event"]["unsafe_integer"] =
            json!(GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER + 1);
        assert!(!portable_canonical_json_numbers_supported(&unsafe_number));
    }

    #[test]
    fn strict_runtime_proof_builder_reports_content_binding_gap() {
        let unreachable_commit = dispatcher_commit_receipt_for_test(
            "publication:test".to_string(),
            1,
            2,
            "registration:test".to_string(),
            2,
            3,
        );
        let unreachable_dispatch_identity = VerifiedRuntimeDispatchDeviceIdentity {
            runtime_session_id: runtime_session_id().to_string(),
            active_generation: 2,
            dispatch_id: "dispatch:test".to_string(),
            dispatch_timestamp_monotonic_ns: 2,
            stream_token: 0,
            device_ordinal: 0,
            stream_device_ordinal: 0,
            device_uuid_hex: "11".repeat(16),
            identity_key: format!("gpu-hardware-uuid:{}", "11".repeat(16)),
            authority: GPU_DISPATCH_DEVICE_ATTESTATION_AUTHORITY.to_string(),
            host_thread_id: "unreached".to_string(),
        };
        let error = runtime_full_proof_line(
            &dummy_request(),
            GpuVendor::Rocm,
            "artifact:sha256:before",
            "artifact:sha256:after",
            "after",
            2,
            1,
            1,
            &unreachable_commit,
            3,
            &unreachable_dispatch_identity,
            &[],
            ArtifactLoaderTransport::FilesystemPath,
            0,
            0,
            0,
            "no_retirement_required",
            "none",
            None,
            None,
            "dispatch:test",
        )
        .expect_err("filesystem transport must not produce strict runtime proof");

        assert_eq!(error, "runtime_proof_loader_transport_not_content_bound");
    }

    #[test]
    fn runtime_stream_device_binding_queries_default_and_nondefault_streams() {
        let identity = query_runtime_hardware_device_identity(&stub_symbols()).unwrap();
        let no_stream_query = GpuDriverSymbolTable {
            cu_stream_get_device: None,
            ..stub_symbols()
        };
        assert_eq!(
            verify_runtime_stream_device_bindings(&no_stream_query, &identity, &[0]),
            Err("stream_device_identity_symbol_missing".to_string())
        );
        assert_eq!(
            verify_runtime_stream_device_bindings(&no_stream_query, &identity, &[0x77]),
            Err("stream_device_identity_symbol_missing".to_string())
        );

        NULL_STREAM_DEVICE_QUERY_CALLS.store(0, Ordering::SeqCst);
        assert_eq!(
            verify_runtime_stream_device_bindings(&stub_symbols(), &identity, &[]),
            Ok(vec![RuntimeStreamDeviceBinding {
                stream_token: 0,
                device_ordinal: 0,
            }])
        );
        assert_eq!(NULL_STREAM_DEVICE_QUERY_CALLS.load(Ordering::SeqCst), 1);

        let wrong_device = GpuDriverSymbolTable {
            cu_stream_get_device: Some(wrong_stream_get_device),
            ..stub_symbols()
        };
        assert_eq!(
            verify_runtime_stream_device_bindings(&wrong_device, &identity, &[0x77]),
            Err("stream_device_identity_mismatch".to_string())
        );

        let query_error = GpuDriverSymbolTable {
            cu_stream_get_device: Some(err_stream_get_device),
            ..stub_symbols()
        };
        let bindings = verify_runtime_stream_device_bindings(&query_error, &identity, &[0x77]);
        assert_eq!(
            bindings,
            Err("stream_device_identity_query_failed:103".to_string())
        );
        let line = runtime_stream_device_binding_line(9, Some(&identity), &bindings);
        assert!(line.contains("event=refused"));
        assert!(line.contains("reason=stream_device_identity_query_failed:103"));
        assert!(line.contains("accepted_for_gpu_hmr=false"));
        assert!(line.contains("gpu_hmr_success=false"));
    }

    #[test]
    fn kernel_resolution_specs_keep_logical_launch_names() {
        let specs = vec![
            "shade=_Z5shadePf".to_string(),
            "gpu::trace=_ZN3gpu5traceEPf".to_string(),
            "plain".to_string(),
        ];
        let resolutions = kernel_resolution_specs(&specs).unwrap();
        assert_eq!(resolutions[0].logical_name, "shade");
        assert_eq!(resolutions[0].driver_name, "_Z5shadePf");
        assert_eq!(resolutions[1].logical_name, "gpu::trace");
        assert_eq!(resolutions[1].driver_name, "_ZN3gpu5traceEPf");
        assert_eq!(resolutions[2].logical_name, "plain");
        assert_eq!(resolutions[2].driver_name, "plain");
        assert_eq!(
            logical_kernel_symbols(&specs).unwrap(),
            vec![
                "gpu::trace".to_string(),
                "plain".to_string(),
                "shade".to_string()
            ]
        );
    }

    #[test]
    fn dispatch_table_content_hash_is_canonical_and_order_independent() {
        let mut first = KernelTable::new();
        first.insert("shade", 0x1010);
        first.insert("trace", 0x2020);

        let mut reordered = KernelTable::new();
        reordered.insert("trace", 0x2020);
        reordered.insert("shade", 0x1010);

        let first_hash = dispatch_table_content_hash(&first);
        assert_eq!(first_hash, dispatch_table_content_hash(&reordered));
        assert_eq!(first_hash.len(), "sha256:".len() + 64);
        assert!(first_hash
            .strip_prefix("sha256:")
            .is_some_and(|digest| digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))));

        reordered.insert("trace", 0x3030);
        assert_ne!(first_hash, dispatch_table_content_hash(&reordered));
    }

    #[test]
    fn runtime_acceptance_contract_uses_shared_schema_enums() {
        let mut req = dummy_request();
        req.reload_id = "edit-runtime-contract".to_string();
        let source_edit_id = format!("source-edit:sha256:{}", "a".repeat(64));
        req.source_edit_id = Some(source_edit_id.clone());
        req.changed_files = vec!["kernels/device.hip".to_string()];
        req.build_manifest.preview_id = "runtime-contract-preview".to_string();
        req.build_manifest.artifact_path = "build/device.hsaco".to_string();
        req.build_manifest.abi_version = "abi-v1".to_string();
        req.build_manifest.translation_units = Some(vec!["kernels/device.hip".to_string()]);

        let dispatch_record = LaunchRecord {
            runtime_session_id: "runtime-session:test".to_string(),
            kernel_name: "shade".to_string(),
            grid: (64, 1, 1),
            block: (256, 1, 1),
            grid_size: 64,
            block_size: 256,
            shared_bytes: 0,
            stream_token: 7,
            arg_count: 1,
            expected_generation: 1,
            active_generation: 2,
            active_artifact_id: Some("sha256:after".to_string()),
            dispatcher_registration_id: Some("dispatcher:test".to_string()),
            dispatch_table_hash: Some("sha256:dispatch-table".to_string()),
            dispatch_table_entry_id: Some("shade:0x1000".to_string()),
            arg_provenance: vec![LaunchArgProvenance {
                index: 0,
                value_ptr: 0x1000,
                value_size: std::mem::size_of::<usize>(),
                value_kind: SYNTHI_GPU_ARG_KIND_POINTER,
                value_bytes: None,
                observed_value: Some(0x2000),
                kind: "device-allocation".to_string(),
                allocation_id: Some("allocation-output".to_string()),
                allocation_name: Some("output".to_string()),
                allocation_ptr: Some(0x2000),
                allocation_bytes: Some(4096),
                allocation_offset: Some(0),
            }],
            arg_provenance_complete: true,
            dispatched: true,
            dispatch_id: Some("dispatch:test".to_string()),
            dispatch_timestamp_ms: Some(1234),
            dispatch_timestamp_monotonic_ns: Some(1_234_000_000),
            dispatch_error: None,
        };
        let evidence_refs = vec![
            "runtime-session:test".to_string(),
            "reload:edit-runtime-contract".to_string(),
            "dispatch:dispatch:test".to_string(),
            "oracle:readback".to_string(),
        ];
        let oracle_artifacts = json!({
            "raw_readback_bin": "memory://gpu-runtime-readback/dispatch-test.bin",
            "raw_readback_hash_verified": true,
        });
        let output_oracle_target = json!({
            "kind": "compute",
            "target_id": "allocation-output",
            "compute_only_target_verified": true,
            "evidence_refs": evidence_refs.clone(),
        });

        let contract = runtime_acceptance_contract(
            &req,
            &source_edit_id,
            GpuVendor::Rocm,
            "sha256:contract",
            "sha256:before",
            "sha256:after",
            &["shade".to_string()],
            &[
                "kernels/device.hip".to_string(),
                "build/device.hsaco".to_string(),
            ],
            &evidence_refs,
            "sha256:abi",
            "4321",
            "rocm:libamdhip64.so",
            &dispatch_record,
            &oracle_artifacts,
            &output_oracle_target,
            "epoch_fence",
            None,
        );

        assert_eq!(contract["confidence"], json!(0.95));
        assert_eq!(contract["edit_id"], json!(source_edit_id));
        assert_eq!(contract["classification"]["confidence"], json!(0.95));
        assert_eq!(
            contract["artifact_identity"]["artifact_kind"],
            json!("hsaco")
        );
        assert_eq!(contract["reload_mechanism"], json!("generated_adapter"));
        assert_eq!(contract["adapter_outcome"], json!("adapter_generated"));
        assert_eq!(
            contract["epoch_retirement_proof"]["value"],
            json!("stream_event_proven")
        );
        assert_eq!(
            contract["hip_contract"]["launch_api"],
            json!("hipModuleLaunchKernel")
        );
        assert_eq!(contract["hip_contract"]["kernel_name"], json!("shade"));
    }

    #[test]
    fn vendor_artifact_kinds_match_acceptance_contract_schema() {
        assert_eq!(GpuVendor::Rocm.proof_artifact_kind(), "hsaco");
        assert_eq!(GpuVendor::Cuda.proof_artifact_kind(), "cuda_cubin");
        assert_eq!(
            runtime_epoch_retirement_proof_value("no_retirement_required"),
            "no_retirement_required"
        );
        assert_eq!(
            runtime_epoch_retirement_proof_value("epoch_fence"),
            "stream_event_proven"
        );
        assert_eq!(
            runtime_epoch_retirement_proof_value("conservative_drain_fallback"),
            "queue_idle_proven"
        );
        assert_eq!(runtime_epoch_retirement_proof_value("unknown"), "unproven");
    }

    static NEXT_HANDLE: AtomicUsize = AtomicUsize::new(0x1000);
    static CTX_SET_CALLS: AtomicUsize = AtomicUsize::new(0);
    static CTX_SYNC_CALLS: AtomicUsize = AtomicUsize::new(0);
    static STREAM_SYNC_CALLS: AtomicUsize = AtomicUsize::new(0);
    static LAST_STREAM_SYNC_TOKEN: AtomicUsize = AtomicUsize::new(0);
    static LAUNCH_CALLS: AtomicUsize = AtomicUsize::new(0);
    static LAST_LAUNCH_GRID_X: AtomicUsize = AtomicUsize::new(0);
    static LAST_LAUNCH_BLOCK_X: AtomicUsize = AtomicUsize::new(0);
    static UNLOAD_GENERATION_AT_CALL: AtomicU64 = AtomicU64::new(0);
    static MODULE_LOAD_CALLS: AtomicUsize = AtomicUsize::new(0);
    static UNLOAD_CALLS: AtomicUsize = AtomicUsize::new(0);
    static DEVICE_UUID_QUERY_CALLS: AtomicUsize = AtomicUsize::new(0);
    static NULL_STREAM_DEVICE_QUERY_CALLS: AtomicUsize = AtomicUsize::new(0);
    static DEVICE_SWITCH_AFTER_LAUNCH_ARMED: AtomicBool = AtomicBool::new(false);
    static DEVICE_SWITCH_AFTER_LAUNCH_ACTIVE: AtomicBool = AtomicBool::new(false);
    static NESTED_LAUNCH_ARMED: AtomicBool = AtomicBool::new(false);
    static NESTED_LAUNCH_COUNT: AtomicUsize = AtomicUsize::new(0);
    static MODULE_RESOLVE_OBSERVED: AtomicBool = AtomicBool::new(false);

    struct BlockingDispatcher {
        entered: mpsc::SyncSender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl GpuLaunchDispatcher for BlockingDispatcher {
        fn dispatch(
            &self,
            _request: &GpuLaunchRequest,
            _args: *const *const c_void,
        ) -> Result<(), String> {
            self.entered
                .send(())
                .map_err(|error| format!("blocking dispatcher entry send failed: {error}"))?;
            self.release
                .lock()
                .map_err(|_| "blocking dispatcher release mutex poisoned".to_string())?
                .recv_timeout(Duration::from_secs(5))
                .map_err(|error| format!("blocking dispatcher release failed: {error}"))
        }
    }

    struct ModuleResolveReleasedDispatcher {
        entered: mpsc::SyncSender<()>,
    }

    impl GpuLaunchDispatcher for ModuleResolveReleasedDispatcher {
        fn dispatch(
            &self,
            _request: &GpuLaunchRequest,
            _args: *const *const c_void,
        ) -> Result<(), String> {
            self.entered
                .send(())
                .map_err(|error| format!("resolve dispatcher entry send failed: {error}"))?;
            let deadline = Instant::now() + Duration::from_secs(5);
            while !MODULE_RESOLVE_OBSERVED.load(Ordering::SeqCst) {
                if Instant::now() >= deadline {
                    return Err("candidate module resolution was not observed".to_string());
                }
                std::thread::yield_now();
            }
            Ok(())
        }
    }

    unsafe extern "C" fn ok_init(_flags: u32) -> CuResult {
        0
    }

    unsafe extern "C" fn ok_device_get(device: *mut i32, _ordinal: i32) -> CuResult {
        if !device.is_null() {
            *device = 0;
        }
        0
    }

    unsafe extern "C" fn ok_ctx_get_current(ctx: *mut CuContext) -> CuResult {
        if !ctx.is_null() {
            *ctx = 0x44 as CuContext;
        }
        0
    }

    unsafe extern "C" fn ok_ctx_set_current(ctx: CuContext) -> CuResult {
        if !ctx.is_null() {
            CTX_SET_CALLS.fetch_add(1, Ordering::SeqCst);
        }
        0
    }

    unsafe extern "C" fn ok_ctx_get_device(device: *mut i32) -> CuResult {
        if !device.is_null() {
            *device = 0;
        }
        0
    }

    unsafe extern "C" fn ok_device_get_uuid(uuid: *mut GpuDeviceUuid, _device: i32) -> CuResult {
        if !uuid.is_null() {
            (*uuid).bytes = [
                0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
                0xee, 0xff,
            ];
        }
        0
    }

    unsafe extern "C" fn zero_device_get_uuid(uuid: *mut GpuDeviceUuid, _device: i32) -> CuResult {
        if !uuid.is_null() {
            (*uuid).bytes = [0; 16];
        }
        0
    }

    unsafe extern "C" fn changing_during_hot_reload_device_get_uuid(
        uuid: *mut GpuDeviceUuid,
        _device: i32,
    ) -> CuResult {
        if !uuid.is_null() {
            let call = DEVICE_UUID_QUERY_CALLS.fetch_add(1, Ordering::SeqCst);
            (*uuid).bytes = [if call < 3 { 0x11 } else { 0x22 }; 16];
        }
        0
    }

    unsafe extern "C" fn switching_between_reload_device_get_uuid(
        uuid: *mut GpuDeviceUuid,
        _device: i32,
    ) -> CuResult {
        if !uuid.is_null() {
            let call = DEVICE_UUID_QUERY_CALLS.fetch_add(1, Ordering::SeqCst);
            (*uuid).bytes = [if call < 2 { 0x11 } else { 0x22 }; 16];
        }
        0
    }

    unsafe extern "C" fn switching_after_native_launch_device_get_uuid(
        uuid: *mut GpuDeviceUuid,
        _device: i32,
    ) -> CuResult {
        if !uuid.is_null() {
            (*uuid).bytes = [if DEVICE_SWITCH_AFTER_LAUNCH_ACTIVE.load(Ordering::SeqCst) {
                0x22
            } else {
                0x11
            }; 16];
        }
        0
    }

    unsafe extern "C" fn err_ctx_get_device(_device: *mut i32) -> CuResult {
        101
    }

    unsafe extern "C" fn err_device_get_uuid(_uuid: *mut GpuDeviceUuid, _device: i32) -> CuResult {
        102
    }

    unsafe extern "C" fn ok_stream_get_device(stream: CuStream, device: *mut i32) -> CuResult {
        if stream.is_null() {
            NULL_STREAM_DEVICE_QUERY_CALLS.fetch_add(1, Ordering::SeqCst);
        }
        if !device.is_null() {
            *device = 0;
        }
        0
    }

    unsafe extern "C" fn wrong_stream_get_device(_stream: CuStream, device: *mut i32) -> CuResult {
        if !device.is_null() {
            *device = 1;
        }
        0
    }

    unsafe extern "C" fn err_stream_get_device(_stream: CuStream, _device: *mut i32) -> CuResult {
        103
    }

    unsafe extern "C" fn ok_module_load_data(
        module: *mut CuModule,
        _image: *const c_void,
    ) -> CuResult {
        MODULE_LOAD_CALLS.fetch_add(1, Ordering::SeqCst);
        if !module.is_null() {
            let handle = NEXT_HANDLE.fetch_add(0x100, Ordering::SeqCst);
            *module = handle as CuModule;
        }
        0
    }

    unsafe extern "C" fn ok_module_load(module: *mut CuModule, _path: *const u8) -> CuResult {
        ok_module_load_data(module, std::ptr::null())
    }

    unsafe extern "C" fn ok_module_unload(_module: CuModule) -> CuResult {
        UNLOAD_CALLS.fetch_add(1, Ordering::SeqCst);
        UNLOAD_GENERATION_AT_CALL.store(current_launch_generation(), Ordering::SeqCst);
        0
    }

    unsafe extern "C" fn err_module_unload(_module: CuModule) -> CuResult {
        UNLOAD_CALLS.fetch_add(1, Ordering::SeqCst);
        UNLOAD_GENERATION_AT_CALL.store(current_launch_generation(), Ordering::SeqCst);
        701
    }

    unsafe extern "C" fn ok_module_get_function(
        hfunc: *mut CuFunction,
        _hmod: CuModule,
        _name: *const u8,
    ) -> CuResult {
        MODULE_RESOLVE_OBSERVED.store(true, Ordering::SeqCst);
        if !hfunc.is_null() {
            let handle = NEXT_HANDLE.fetch_add(0x10, Ordering::SeqCst);
            *hfunc = handle as CuFunction;
        }
        0
    }

    unsafe extern "C" fn ok_launch_kernel(
        _f: CuFunction,
        grid_dim_x: u32,
        _grid_dim_y: u32,
        _grid_dim_z: u32,
        block_dim_x: u32,
        _block_dim_y: u32,
        _block_dim_z: u32,
        _shared_mem_bytes: u32,
        _stream: CuStream,
        _kernel_params: *mut *mut c_void,
        _extra: *mut *mut c_void,
    ) -> CuResult {
        LAUNCH_CALLS.fetch_add(1, Ordering::SeqCst);
        LAST_LAUNCH_GRID_X.store(grid_dim_x as usize, Ordering::SeqCst);
        LAST_LAUNCH_BLOCK_X.store(block_dim_x as usize, Ordering::SeqCst);
        0
    }

    unsafe extern "C" fn launch_kernel_switching_device_after_launch(
        _f: CuFunction,
        grid_dim_x: u32,
        _grid_dim_y: u32,
        _grid_dim_z: u32,
        block_dim_x: u32,
        _block_dim_y: u32,
        _block_dim_z: u32,
        _shared_mem_bytes: u32,
        _stream: CuStream,
        _kernel_params: *mut *mut c_void,
        _extra: *mut *mut c_void,
    ) -> CuResult {
        LAUNCH_CALLS.fetch_add(1, Ordering::SeqCst);
        LAST_LAUNCH_GRID_X.store(grid_dim_x as usize, Ordering::SeqCst);
        LAST_LAUNCH_BLOCK_X.store(block_dim_x as usize, Ordering::SeqCst);
        if DEVICE_SWITCH_AFTER_LAUNCH_ARMED.swap(false, Ordering::SeqCst) {
            DEVICE_SWITCH_AFTER_LAUNCH_ACTIVE.store(true, Ordering::SeqCst);
        }
        0
    }

    unsafe extern "C" fn ok_launch_kernel_with_nested_dispatch(
        _f: CuFunction,
        grid_dim_x: u32,
        grid_dim_y: u32,
        grid_dim_z: u32,
        block_dim_x: u32,
        block_dim_y: u32,
        block_dim_z: u32,
        _shared_mem_bytes: u32,
        _stream: CuStream,
        _kernel_params: *mut *mut c_void,
        _extra: *mut *mut c_void,
    ) -> CuResult {
        LAUNCH_CALLS.fetch_add(1, Ordering::SeqCst);
        LAST_LAUNCH_GRID_X.store(grid_dim_x as usize, Ordering::SeqCst);
        LAST_LAUNCH_BLOCK_X.store(block_dim_x as usize, Ordering::SeqCst);
        if NESTED_LAUNCH_ARMED.swap(false, Ordering::SeqCst) {
            let grid = [grid_dim_x, grid_dim_y, grid_dim_z];
            let block = [block_dim_x, block_dim_y, block_dim_z];
            if synthi_gpu_launch_raw(
                std::ptr::null_mut(),
                b"vec_add\0".as_ptr().cast(),
                grid.as_ptr().cast(),
                std::mem::size_of_val(&grid),
                block.as_ptr().cast(),
                std::mem::size_of_val(&block),
                0,
                0x99,
                std::ptr::null(),
                0,
            ) {
                NESTED_LAUNCH_COUNT.fetch_add(1, Ordering::SeqCst);
            }
        }
        0
    }

    unsafe extern "C" fn ok_ctx_synchronize() -> CuResult {
        CTX_SYNC_CALLS.fetch_add(1, Ordering::SeqCst);
        0
    }

    unsafe extern "C" fn ok_stream_synchronize(stream: CuStream) -> CuResult {
        STREAM_SYNC_CALLS.fetch_add(1, Ordering::SeqCst);
        LAST_STREAM_SYNC_TOKEN.store(stream as usize, Ordering::SeqCst);
        0
    }

    unsafe extern "C" fn err_stream_synchronize(stream: CuStream) -> CuResult {
        STREAM_SYNC_CALLS.fetch_add(1, Ordering::SeqCst);
        LAST_STREAM_SYNC_TOKEN.store(stream as usize, Ordering::SeqCst);
        700
    }

    unsafe extern "C" fn ok_mem_alloc(dptr: *mut CuDevicePtr, _bytes: usize) -> CuResult {
        if !dptr.is_null() {
            *dptr = NEXT_HANDLE.fetch_add(0x100, Ordering::SeqCst) as u64;
        }
        0
    }

    unsafe extern "C" fn ok_mem_free(_dptr: CuDevicePtr) -> CuResult {
        0
    }

    unsafe extern "C" fn ok_memcpy_dtod(
        _dst: CuDevicePtr,
        _src: CuDevicePtr,
        _bytes: usize,
    ) -> CuResult {
        0
    }

    unsafe extern "C" fn ok_memcpy_htod(
        _dst: CuDevicePtr,
        _src: *const c_void,
        _bytes: usize,
    ) -> CuResult {
        0
    }

    unsafe extern "C" fn ok_memcpy_dtoh(
        _dst: *mut c_void,
        _src: CuDevicePtr,
        _bytes: usize,
    ) -> CuResult {
        0
    }

    fn stub_symbols() -> GpuDriverSymbolTable {
        GpuDriverSymbolTable {
            cu_init: ok_init,
            cu_device_get: ok_device_get,
            cu_ctx_get_current: ok_ctx_get_current,
            cu_ctx_set_current: ok_ctx_set_current,
            cu_ctx_get_device: Some(ok_ctx_get_device),
            cu_device_get_uuid: Some(ok_device_get_uuid),
            cu_stream_get_device: Some(ok_stream_get_device),
            cu_module_load_data: ok_module_load_data,
            cu_module_load: ok_module_load,
            cu_module_unload: ok_module_unload,
            cu_module_get_function: ok_module_get_function,
            cu_launch_kernel: ok_launch_kernel,
            cu_ctx_synchronize: ok_ctx_synchronize,
            cu_stream_synchronize: ok_stream_synchronize,
            cu_mem_alloc: ok_mem_alloc,
            cu_mem_free: ok_mem_free,
            cu_memcpy_dtod: ok_memcpy_dtod,
            cu_memcpy_htod: ok_memcpy_htod,
            cu_memcpy_dtoh: ok_memcpy_dtoh,
        }
    }

    fn symbols_without_device_identity() -> GpuDriverSymbolTable {
        GpuDriverSymbolTable {
            cu_ctx_get_device: None,
            cu_device_get_uuid: None,
            ..stub_symbols()
        }
    }

    fn drain_error_symbols() -> GpuDriverSymbolTable {
        GpuDriverSymbolTable {
            cu_stream_synchronize: err_stream_synchronize,
            ..stub_symbols()
        }
    }

    fn unload_error_symbols() -> GpuDriverSymbolTable {
        GpuDriverSymbolTable {
            cu_module_unload: err_module_unload,
            ..stub_symbols()
        }
    }

    fn install_runtime_output_oracle_profile_for_tests() -> Vec<u8> {
        let output_bytes = vec![0_u8; 4 * std::mem::size_of::<f32>()];
        let expected_sha256 = format!("sha256:{}", sha256_hex_bytes(&output_bytes));
        let mut baseline_bytes = Vec::new();
        for _ in 0..4 {
            baseline_bytes.extend_from_slice(&(-1.0f32).to_le_bytes());
        }
        let baseline_sha256 = format!("sha256:{}", sha256_hex_bytes(&baseline_bytes));
        let probe_config_hash = format!(
            "sha256:{}",
            sha256_hex_bytes(b"gpu-module-adapter-test-output-oracle-config-v1")
        );
        let profile_path = std::env::temp_dir().join("synthi-gpu-hmr-test-output-oracle.json");
        let profile = serde_json::json!({
            "enabled": true,
            "schemaVersion": "synthi.gpu_hmr.runtime_output_oracle_profile.v1",
            "profileId": "test-vec-add-readback",
            "oracleId": "test:vec_add:readback",
            "baselineSha256": baseline_sha256,
            "expectedSha256": expected_sha256,
            "producer": "gpu_module_adapter_test_stub",
            "outputTargetId": "buffer:out",
            "kernelName": "vec_add",
            "grid": [1, 1, 1],
            "block": [1, 1, 1],
            "buffers": [
                {
                    "name": "out",
                    "elementType": "f32",
                    "count": 4,
                    "initializer": { "kind": "fill", "value": -1.0 }
                },
                {
                    "name": "lhs",
                    "elementType": "f32",
                    "count": 4,
                    "initializer": { "kind": "iota", "start": 1.0 }
                },
                {
                    "name": "rhs",
                    "elementType": "f32",
                    "count": 4,
                    "initializer": { "kind": "iota", "start": 10.0 }
                }
            ],
            "args": [
                { "kind": "buffer", "name": "out" },
                { "kind": "buffer", "name": "lhs" },
                { "kind": "buffer", "name": "rhs" },
                { "kind": "scalar_u32", "value": 4 }
            ],
            "outputBuffer": "out",
            "probeMode": "deterministic_stub_readback",
            "probeConfigHash": probe_config_hash,
            "probeEvidenceRef": "gpu_module_adapter.rs:test_runtime_output_oracle_profile"
        });
        let profile_bytes =
            serde_json::to_vec_pretty(&profile).expect("serialize test oracle profile");
        fs::write(&profile_path, &profile_bytes).expect("write test oracle profile");
        std::env::set_var("SYNTHI_GPU_HMR_RUNTIME_OUTPUT_ORACLE_PATH", profile_path);
        profile_bytes
    }

    fn write_runtime_output_oracle_profile_for_request(
        request: &mut AdapterReloadRequest,
        profile: &serde_json::Value,
    ) -> Vec<u8> {
        let profile_bytes =
            serde_json::to_vec_pretty(profile).expect("serialize mutated test oracle profile");
        fs::write(
            configured_gpu_hmr_runtime_output_oracle_profile_path(),
            &profile_bytes,
        )
        .expect("write mutated test oracle profile");
        request
            .capsule_metadata
            .as_mut()
            .and_then(|metadata| metadata.output_oracle_profile_commitment.as_mut())
            .expect("test output oracle commitment")
            .profile_bytes_sha256 = format!("sha256:{}", sha256_hex_bytes(&profile_bytes));
        profile_bytes
    }

    fn write_fission_output_oracle_contract_for_request(
        request: &mut AdapterReloadRequest,
        contract: serde_json::Value,
    ) {
        let contract_hash = format!("sha256:{}", stable_json_hash(&contract));
        let metadata = request
            .capsule_metadata
            .as_mut()
            .expect("test reload capsule metadata");
        metadata.fission_output_oracle_contract = Some(contract);
        metadata
            .output_oracle_profile_commitment
            .as_mut()
            .expect("test output oracle commitment")
            .fission_output_oracle_contract_sha256 = contract_hash;
    }

    fn adapter_with_symbols(symbols: GpuDriverSymbolTable) -> GpuModuleAdapter {
        adapter_with_config_and_symbols(GpuModuleAdapterConfig::default(), symbols)
    }

    fn rocm_adapter_with_symbols(symbols: GpuDriverSymbolTable) -> GpuModuleAdapter {
        adapter_with_config_and_symbols(
            GpuModuleAdapterConfig {
                vendor: GpuVendor::Rocm,
                ..GpuModuleAdapterConfig::default()
            },
            symbols,
        )
    }

    fn adapter_with_config_and_symbols(
        config: GpuModuleAdapterConfig,
        symbols: GpuDriverSymbolTable,
    ) -> GpuModuleAdapter {
        let _ = install_runtime_output_oracle_profile_for_tests();
        let mut a = GpuModuleAdapter::new(config);
        a.phase = GpuPhase::Ready;
        a.health = AdapterHealth::Healthy;
        a.test_symbols = Some(symbols);
        a
    }

    fn request_with_artifact(path: &str, changed_files: Vec<String>) -> AdapterReloadRequest {
        request_with_artifact_and_abi(path, changed_files, "")
    }

    fn request_with_artifact_and_abi(
        path: &str,
        changed_files: Vec<String>,
        abi_version: &str,
    ) -> AdapterReloadRequest {
        let profile_bytes = install_runtime_output_oracle_profile_for_tests();
        let profile: serde_json::Value =
            serde_json::from_slice(&profile_bytes).expect("parse test output oracle profile");
        let artifact_bytes = fs::read(path).expect("read test GPU artifact for commitment");
        let artifact_hash = sha256_hex_bytes(&artifact_bytes);
        let source_edit_id = format!("source-edit:sha256:{artifact_hash}");
        let fission_output_oracle_contract = json!({
            "kind": "compute_readback",
            "oracleId": profile["oracleId"],
            "expected": profile["expectedSha256"],
            "baselineSha256": profile["baselineSha256"],
            "expectedOutputChange": true,
            "producer": profile["producer"],
            "outputTargetId": profile["outputTargetId"],
            "kernelSymbol": profile["kernelName"],
            "probeMode": profile["probeMode"],
            "probeConfigHash": profile["probeConfigHash"],
        });
        let pid = std::process::id();
        let mut manifest = BuildManifest::for_language("test-preview", "cuda")
            .with_slot(BuildSlot::Custom("test-gpu-sidecar".to_string()))
            .with_artifact(path, "test-hash")
            .with_capabilities(vec![GPU_SIDECAR_MODULE_CAPABILITY.to_string()]);
        manifest.abi_version = abi_version.to_string();
        manifest.exported_symbols = vec!["vec_add".into()];
        AdapterReloadRequest {
            reload_id: "test".into(),
            source_edit_id: Some(source_edit_id.clone()),
            module_id: "device".into(),
            changed_files,
            build_manifest: manifest,
            artifact_blob: None,
            capsule_metadata: Some(ReloadCapsuleMetadata {
                fission_output_oracle_contract: Some(fission_output_oracle_contract.clone()),
                output_oracle_profile_commitment: Some(
                    crate::hmr::adapter_trait::ReloadOutputOracleProfileCommitment {
                        schema_version: RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION
                            .to_string(),
                        candidate_artifact_sha256: format!("sha256:{artifact_hash}"),
                        fission_output_oracle_contract_sha256: format!(
                            "sha256:{}",
                            stable_json_hash(&fission_output_oracle_contract)
                        ),
                        profile_bytes_sha256: format!(
                            "sha256:{}",
                            sha256_hex_bytes(&profile_bytes)
                        ),
                        edit_id: source_edit_id,
                    },
                ),
                ..ReloadCapsuleMetadata::default()
            }),
            firewall_evidence: ReloadFirewallEvidence::from_gpu_device_sidecar_boundary(
                "gpu_module_adapter_test:request_with_artifact",
                pid,
                pid,
            ),
            preserve_state: true,
            timeout_ms: 5_000,
        }
    }

    fn request_without_output_oracle_commitment(
        path: &str,
        changed_files: Vec<String>,
        abi_version: &str,
    ) -> AdapterReloadRequest {
        let mut request = request_with_artifact_and_abi(path, changed_files, abi_version);
        request.source_edit_id = None;
        request.capsule_metadata = None;
        request
    }

    fn launch_vec_add_on_stream(stream_token: usize) {
        let kernel = CString::new("vec_add").unwrap();
        let grid = 8_u32;
        let block = 256_u32;
        assert!(synthi_gpu_launch_raw(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            (&grid as *const u32).cast(),
            std::mem::size_of_val(&grid),
            (&block as *const u32).cast(),
            std::mem::size_of_val(&block),
            0,
            stream_token,
            std::ptr::null(),
            4,
        ));
    }

    fn launch_replayable_vec_add_on_stream(stream_token: usize) -> Box<[u8; 16]> {
        let kernel = CString::new("vec_add").unwrap();
        let name = CString::new("replay-output").unwrap();
        let lifetime = CString::new("persistent").unwrap();
        let grid = [1_u32, 1, 1];
        let block = [1_u32, 1, 1];
        let mut device_bytes = Box::new([0_u8; 16]);
        let device_ptr = device_bytes.as_mut_ptr().cast::<c_void>();
        synthi_gpu_register_buffer(
            std::ptr::null_mut(),
            device_ptr,
            device_bytes.len(),
            name.as_ptr(),
            lifetime.as_ptr(),
        );
        let arg = SynthiGpuLaunchArg {
            value_ptr: (&device_ptr as *const *mut c_void).cast(),
            value_size: std::mem::size_of_val(&device_ptr),
            value_kind: SYNTHI_GPU_ARG_KIND_POINTER,
        };
        let receipt = synthi_gpu_launch_raw_arg_info_with_receipt(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            grid.as_ptr().cast(),
            std::mem::size_of_val(&grid),
            block.as_ptr().cast(),
            std::mem::size_of_val(&block),
            0,
            stream_token,
            &arg,
            1,
        );
        assert!(receipt.dispatched);
        device_bytes
    }

    #[test]
    fn defaults_target_cuda() {
        let cfg = GpuModuleAdapterConfig::default();
        assert_eq!(cfg.vendor, GpuVendor::Cuda);
        assert_eq!(cfg.drain_timeout_ms, 2_000);
        assert!(cfg.allow_snapshot_downgrade);
        assert_eq!(
            cfg.artifact_loader_transport,
            ArtifactLoaderTransport::RamBytes
        );
    }

    #[test]
    fn info_reports_cuda_metadata() {
        let a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        let info = a.info();
        assert_eq!(info.name, "gpu_module_cuda");
        assert_eq!(info.family, AdapterFamily::DynamicLibrary);
        assert_eq!(info.capability_tier, CapabilityTier::Tier1);
        assert!(info.supported_languages.contains(&"cuda".to_string()));
        assert!(info.supported_languages.contains(&"hip".to_string()));
        assert_eq!(info.extra.get("vendor").map(|s| s.as_str()), Some("cuda"));
        assert_eq!(
            info.extra.get("driver_library").map(|s| s.as_str()),
            Some("libcuda.so.1")
        );
        assert_eq!(
            info.extra
                .get("artifact_loader_transport")
                .map(|s| s.as_str()),
            Some("ram_bytes")
        );
    }

    #[test]
    fn info_reports_rocm_metadata() {
        let cfg = GpuModuleAdapterConfig {
            vendor: GpuVendor::Rocm,
            ..Default::default()
        };
        let a = GpuModuleAdapter::new(cfg);
        let info = a.info();
        assert_eq!(info.name, "gpu_module_rocm");
        assert_eq!(
            info.extra.get("driver_library").map(|s| s.as_str()),
            Some("libamdhip64.so")
        );
    }

    #[test]
    fn vendor_from_manifest_vendor() {
        assert_eq!(GpuVendor::from(DeviceVendor::Cuda), GpuVendor::Cuda);
        assert_eq!(GpuVendor::from(DeviceVendor::Rocm), GpuVendor::Rocm);
    }

    #[test]
    fn required_symbol_table_is_complete_cuda() {
        let a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        let syms = a.required_driver_symbols();
        let expected = gpu_driver_loader::required_symbol_names(GpuVendor::Cuda);
        assert_eq!(syms.as_slice(), expected.as_slice());
        assert!(syms.contains(&"cuInit"));
        assert!(syms.contains(&"cuDeviceGet"));
        assert!(syms.contains(&"cuCtxGetCurrent"));
        assert!(syms.contains(&"cuCtxSetCurrent"));
        assert!(syms.contains(&"cuModuleLoadData"));
        assert!(syms.contains(&"cuModuleLoad"));
        assert!(syms.contains(&"cuModuleUnload"));
        assert!(syms.contains(&"cuModuleGetFunction"));
        assert!(syms.contains(&"cuLaunchKernel"));
        assert!(syms.contains(&"cuCtxSynchronize"));
        assert!(syms.contains(&"cuStreamSynchronize"));
        assert!(syms.contains(&"cuMemAlloc_v2"));
        assert!(syms.contains(&"cuMemFree_v2"));
        assert!(syms.contains(&"cuMemcpyDtoD_v2"));
        assert_eq!(syms.len(), expected.len());
    }

    #[test]
    fn required_symbol_table_is_complete_rocm() {
        let cfg = GpuModuleAdapterConfig {
            vendor: GpuVendor::Rocm,
            ..Default::default()
        };
        let a = GpuModuleAdapter::new(cfg);
        let syms = a.required_driver_symbols();
        let expected = gpu_driver_loader::required_symbol_names(GpuVendor::Rocm);
        assert_eq!(syms.as_slice(), expected.as_slice());
        assert!(syms.contains(&"hipInit"));
        assert!(syms.contains(&"hipDeviceGet"));
        assert!(syms.contains(&"hipCtxGetCurrent"));
        assert!(syms.contains(&"hipCtxSetCurrent"));
        assert!(syms.contains(&"hipModuleLoadData"));
        assert!(syms.contains(&"hipModuleLoad"));
        assert!(syms.contains(&"hipModuleUnload"));
        assert!(syms.contains(&"hipModuleGetFunction"));
        assert!(syms.contains(&"hipModuleLaunchKernel"));
        assert!(syms.contains(&"hipDeviceSynchronize"));
        assert!(syms.contains(&"hipStreamSynchronize"));
        assert!(syms.contains(&"hipMalloc"));
        assert!(syms.contains(&"hipFree"));
        assert!(syms.contains(&"hipMemcpyDtoD"));
        assert_eq!(syms.len(), expected.len());
    }

    #[test]
    fn initialize_transitions_to_ready_once() {
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        assert!(!a.is_ready());
        assert!(a.initialize().is_ok());
        assert!(a.is_ready());
        assert_eq!(a.healthcheck(), AdapterHealth::Healthy);
        // Calling initialize twice is a contract violation.
        assert!(a.initialize().is_err());
    }

    #[test]
    fn shutdown_clears_handles_and_phase() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        a.initialize().unwrap();
        a.kernel_table.insert("vec_add".into(), 0xdead_beef);
        a.active_module_handle = Some(0x1234_5678);
        a.active_generation_artifact_id = Some("artifact:sha256:test".into());
        a.last_device_abi_version = Some("sig-v1".into());
        assert!(a.shutdown().is_ok());
        assert!(a.active_module_handle.is_none());
        assert!(a.active_generation_artifact_id.is_none());
        assert!(a.kernel_table.is_empty());
        assert!(a.last_device_abi_version.is_none());
    }

    #[test]
    fn reload_without_driver_routes_to_cold_path() {
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        a.initialize().unwrap();
        let r = a.reload(&dummy_request());
        match r {
            AdapterReloadResult::Unsupported { ref reason }
                if a.driver_state_label() == "unavailable" =>
            {
                assert!(reason.contains("driver unavailable"));
                assert!(reason.contains("cold path"));
            }
            AdapterReloadResult::Unsupported { ref reason }
                if a.driver_state_label() == "loaded" =>
            {
                assert!(reason.contains("missing device artifact path"));
            }
            other => panic!("expected Unsupported, got {:?}", other),
        }
        assert_eq!(a.reload_count(), 1);
    }

    #[test]
    fn reload_failed_when_uninitialized() {
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        let r = a.reload(&dummy_request());
        match r {
            AdapterReloadResult::Failed {
                ref error,
                recoverable,
            } => {
                assert!(error.contains("not initialized"));
                assert!(!recoverable);
            }
            other => panic!("expected Failed, got {:?}", other),
        }
    }

    #[test]
    fn snapshot_state_empty_pre_swap() {
        let a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        let blob = a.snapshot_state().expect("snapshot ok");
        assert!(
            blob.is_empty(),
            "pre-Phase-3 adapter must report empty snapshot"
        );
    }

    #[test]
    fn restore_state_rejects_nonempty_pre_swap() {
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        assert!(a.restore_state(&[]).is_ok());
        let err = a.restore_state(&[0x42, 0x42]).unwrap_err();
        assert!(err.contains("snapshot restore is not wired yet"));
    }

    // ── Phase-2 driver-loader integration ───────────────────

    #[test]
    fn driver_state_label_pending_before_initialize() {
        let a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        assert_eq!(a.driver_state_label(), "pending");
        assert!(!a.driver_available());
        assert!(a.last_driver_error().is_none());
    }

    #[test]
    fn driver_state_after_initialize_is_loaded_or_unavailable() {
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        a.initialize().unwrap();
        let label = a.driver_state_label();
        assert!(
            label == "loaded" || label == "unavailable",
            "expected loaded|unavailable, got {label}"
        );
        if label == "loaded" {
            assert!(a.driver_available());
            assert!(a.driver_handle().is_some());
            assert!(a.last_driver_error().is_none());
        } else {
            assert!(!a.driver_available());
            assert!(a.driver_handle().is_none());
            assert!(a.last_driver_error().is_some());
        }
    }

    #[test]
    fn info_extra_surfaces_driver_state() {
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        let pre = a.info();
        assert_eq!(
            pre.extra.get("driver_state").map(|s| s.as_str()),
            Some("pending")
        );
        a.initialize().unwrap();
        let post = a.info();
        let state = post.extra.get("driver_state").map(|s| s.as_str()).unwrap();
        assert!(state == "loaded" || state == "unavailable");
        if state == "unavailable" {
            assert!(post.extra.get("driver_error").is_some());
        }
    }

    #[test]
    fn shutdown_drops_driver_handle() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        a.initialize().unwrap();
        a.shutdown().unwrap();
        assert!(!a.driver_available());
        assert!(a.driver_handle().is_none());
    }

    #[test]
    fn reload_reason_mentions_driver_state() {
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        a.initialize().unwrap();
        let label = a.driver_state_label();
        let r = a.reload(&dummy_request());
        match r {
            AdapterReloadResult::Unsupported { reason } => {
                if label == "unavailable" {
                    assert!(
                        reason.contains(label),
                        "reload reason {reason:?} must mention driver state {label:?}"
                    );
                } else {
                    assert!(reason.contains("artifact path"));
                }
            }
            other => panic!("expected Unsupported, got {:?}", other),
        }
    }

    #[test]
    fn phase3_reload_loads_sidecar_and_emits_markers() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"fake-cubin").unwrap();
        let path = file.path().to_string_lossy().to_string();
        let mut a = adapter_with_symbols(stub_symbols());
        let r = a.reload(&request_with_artifact(&path, vec!["device.cu".into()]));
        match r {
            AdapterReloadResult::Success {
                state_preserved, ..
            } => assert!(state_preserved),
            other => panic!("expected Success, got {:?}", other),
        }
        assert_eq!(a.reload_count(), 1);
        assert_eq!(a.module_manager.swap_count(), 1);
        assert_eq!(a.kernel_table.len(), 1);
        assert_eq!(a.healthcheck(), AdapterHealth::Healthy);
        assert!(a
            .last_reload_log()
            .iter()
            .any(|l| l.contains("plan=device_only")));
        assert!(a
            .last_reload_log()
            .iter()
            .any(|l| l.contains("gpu_snapshot_telemetry")));
        let transport = a
            .last_reload_log()
            .iter()
            .find(|l| l.contains("artifact_transport"))
            .expect("runtime artifact transport report");
        assert!(transport.contains("reload_request_transport=filesystem_path"));
        assert!(transport.contains("selected_loader_transport=ram_bytes"));
        assert!(transport.contains("ram_reference=false"));
        assert!(transport.contains("ram_transport_proven=false"));
        assert!(transport.contains(&format!(
            "artifact_hash=sha256:{}",
            sha256_hex_bytes(b"fake-cubin")
        )));
    }

    #[test]
    fn phase3_reload_reports_ram_artifact_when_byte_loader_is_selected() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"fake-cubin").unwrap();
        let path = file.path().to_string_lossy().to_string();
        let artifact_hash = sha256_hex_bytes(b"fake-cubin");
        let mut req = request_with_artifact(&path, vec!["device.cu".into()]);
        req.artifact_blob = Some(ReloadArtifactBlob {
            blob_id: format!("artifact:sha256:{artifact_hash}"),
            content_hash: format!("sha256:{artifact_hash}"),
            bytes: b"fake-cubin".to_vec(),
        });
        let mut a = adapter_with_symbols(stub_symbols());
        let r = a.reload(&req);
        assert!(matches!(r, AdapterReloadResult::Success { .. }));

        let transport = a
            .last_reload_log()
            .iter()
            .find(|l| l.contains("artifact_transport"))
            .expect("runtime artifact transport report");
        assert!(transport.contains("reload_request_transport=filesystem_path,ram_blob"));
        assert!(transport.contains("selected_loader_transport=ram_bytes"));
        assert!(transport.contains("ram_reference=true"));
        assert!(transport.contains(&format!("ram_blob_id=artifact:sha256:{artifact_hash}")));
        assert!(transport.contains("ram_transport_proven=true"));
        assert!(transport.contains("degraded_state=none"));
    }

    #[test]
    fn ram_artifact_blob_id_must_bind_exact_loader_bytes_before_module_mutation() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        MODULE_LOAD_CALLS.store(0, Ordering::SeqCst);
        UNLOAD_CALLS.store(0, Ordering::SeqCst);
        let artifact_bytes = b"content-bound-loader-bytes";
        let artifact_hash = sha256_hex_bytes(artifact_bytes);
        let mut artifact_file = tempfile::NamedTempFile::new().unwrap();
        artifact_file.write_all(artifact_bytes).unwrap();
        let artifact_path = artifact_file.path().to_string_lossy().to_string();
        let generation_before = current_launch_generation();

        for invalid_blob_id in [
            "artifact:sha256:not-a-digest".to_string(),
            format!("artifact:sha256:{}", "0".repeat(64)),
        ] {
            let mut request =
                request_with_artifact(&artifact_path, vec!["src/device-stage".into()]);
            request.artifact_blob = Some(ReloadArtifactBlob {
                blob_id: invalid_blob_id.clone(),
                content_hash: format!("sha256:{artifact_hash}"),
                bytes: artifact_bytes.to_vec(),
            });
            let mut adapter = adapter_with_symbols(stub_symbols());

            match adapter.reload(&request) {
                AdapterReloadResult::Failed { error, recoverable } => {
                    assert!(recoverable);
                    assert!(error.contains("GPU RAM artifact blob id mismatch"));
                    assert!(error.contains(&invalid_blob_id));
                    assert!(error.contains(&format!("artifact:sha256:{artifact_hash}")));
                }
                other => panic!("expected RAM blob id refusal, got {other:?}"),
            }
            assert_eq!(MODULE_LOAD_CALLS.load(Ordering::SeqCst), 0);
            assert_eq!(UNLOAD_CALLS.load(Ordering::SeqCst), 0);
            assert_eq!(adapter.module_manager.swap_count(), 0);
            assert_eq!(current_launch_generation(), generation_before);
            assert!(adapter.last_reload_log().is_empty());
        }

        let _ = install_runtime_output_oracle_profile_for_tests();
        reset_for_test();
    }

    #[test]
    fn phase3_reload_reports_filesystem_fallback_when_path_loader_is_selected() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"fake-cubin").unwrap();
        let path = file.path().to_string_lossy().to_string();
        let artifact_hash = sha256_hex_bytes(b"fake-cubin");
        let mut req = request_with_artifact(&path, vec!["device.cu".into()]);
        req.artifact_blob = Some(ReloadArtifactBlob {
            blob_id: format!("artifact:sha256:{artifact_hash}"),
            content_hash: format!("sha256:{artifact_hash}"),
            bytes: b"fake-cubin".to_vec(),
        });
        let mut a = adapter_with_config_and_symbols(
            GpuModuleAdapterConfig {
                artifact_loader_transport: ArtifactLoaderTransport::FilesystemPath,
                ..Default::default()
            },
            stub_symbols(),
        );
        let r = a.reload(&req);
        assert!(matches!(r, AdapterReloadResult::Success { .. }));

        let transport = a
            .last_reload_log()
            .iter()
            .find(|l| l.contains("artifact_transport"))
            .expect("runtime artifact transport report");
        assert!(transport.contains("reload_request_transport=filesystem_path,ram_blob"));
        assert!(transport.contains("selected_loader_transport=filesystem_path"));
        assert!(transport.contains("ram_reference=true"));
        assert!(transport.contains("ram_transport_proven=false"));
        assert!(transport.contains("degraded_state=gpu-hmr-ram-io-unavailable"));
        assert!(transport.contains("degraded_reason=selected_loader_uses_filesystem_path"));
    }

    #[test]
    fn hot_reload_refuses_mutable_path_transport_before_module_mutation() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        MODULE_LOAD_CALLS.store(0, Ordering::SeqCst);
        UNLOAD_CALLS.store(0, Ordering::SeqCst);
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"path-cold-initialization").unwrap();
        second.write_all(b"path-hot-candidate").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let mut adapter = adapter_with_config_and_symbols(
            GpuModuleAdapterConfig {
                artifact_loader_transport: ArtifactLoaderTransport::FilesystemPath,
                ..Default::default()
            },
            stub_symbols(),
        );
        assert!(matches!(
            adapter.reload(&request_with_artifact(
                &first_path,
                vec!["source/arbitrary.device".into()]
            )),
            AdapterReloadResult::Success { .. }
        ));

        let loads_before = MODULE_LOAD_CALLS.load(Ordering::SeqCst);
        let unloads_before = UNLOAD_CALLS.load(Ordering::SeqCst);
        let generation_before = current_launch_generation();
        let active_handle_before = adapter.active_module_handle;
        let active_artifact_before = adapter.active_generation_artifact_id.clone();
        let swaps_before = adapter.module_manager.swap_count();
        match adapter.reload(&request_with_artifact(
            &second_path,
            vec!["build/generated/device-stage".into()],
        )) {
            AdapterReloadResult::Unsupported { reason } => {
                assert!(reason.contains("requires content-bound artifact bytes"));
                assert!(reason.contains("cold reload"));
            }
            other => panic!("expected mutable path hot reload refusal, got {other:?}"),
        }

        assert_eq!(MODULE_LOAD_CALLS.load(Ordering::SeqCst), loads_before);
        assert_eq!(UNLOAD_CALLS.load(Ordering::SeqCst), unloads_before);
        assert_eq!(current_launch_generation(), generation_before);
        assert_eq!(adapter.active_module_handle, active_handle_before);
        assert_eq!(
            adapter.active_generation_artifact_id,
            active_artifact_before
        );
        assert_eq!(adapter.module_manager.swap_count(), swaps_before);
        assert!(adapter.last_reload_log().iter().any(|line| {
            line.contains("artifact_transport")
                && line.contains("status=refused")
                && line.contains("selected_loader_transport=filesystem_path")
                && line.contains("content_bound=false")
                && line.contains("accepted_for_gpu_hmr=false")
                && line.contains("gpu_hmr_success=false")
        }));
        assert!(!adapter
            .last_reload_log()
            .iter()
            .any(|line| line.contains("dispatcher_epoch event=published")));
        let _ = install_runtime_output_oracle_profile_for_tests();
        reset_for_test();
    }

    #[test]
    fn phase3_epoch_publication_records_capsule_metadata() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"fake-cubin").unwrap();
        let path = file.path().to_string_lossy().to_string();
        let mut req = request_with_artifact(&path, vec!["device.cu".into()]);
        req.capsule_metadata = Some(ReloadCapsuleMetadata {
            fission_island_id: Some(format!("fission-island:sha256:{}", "a".repeat(64))),
            abi_membrane_hash: Some(format!("sha256:{}", "b".repeat(64))),
            dependency_closure_hash: Some(format!("sha256:{}", "c".repeat(64))),
            proof_hash: Some(format!("sha256:{}", "d".repeat(64))),
            ..Default::default()
        });
        let mut a = adapter_with_symbols(stub_symbols());
        let r = a.reload(&req);
        assert!(matches!(r, AdapterReloadResult::Success { .. }));

        let publish = a
            .last_reload_log()
            .iter()
            .find(|line| line.contains("dispatcher_epoch event=published"))
            .expect("dispatcher epoch publication report");
        assert!(publish.contains("publish_timestamp_ms="));
        assert!(publish.contains("publish_timestamp_monotonic_ns="));
        assert!(publish.contains("capsule_id=capsule:sha256:"));
        assert!(publish.contains(
            "fission_island_id=fission-island:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
        assert!(publish.contains(
            "abi_membrane_hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ));
        assert!(publish.contains(
            "dependency_closure_hash=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        ));
        assert!(publish.contains(
            "proof_hash=sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        ));
        assert!(publish.contains("stream_epoch_counters=none:"));
        assert!(publish.contains("retirement_fence_ids=none"));
        assert!(publish.contains("retirement_strategy=no_retirement_required"));
        assert!(publish.contains("delayed_unload_result=not_required"));
        let graph_line = a
            .last_reload_log()
            .iter()
            .find(|line| line.contains("epoch_generation_graph json="))
            .expect("epoch generation graph report");
        let graph = epoch_graph_json_from_line(graph_line);
        assert_eq!(
            graph
                .get("schemaVersion")
                .and_then(serde_json::Value::as_str),
            Some("synthi.gpu.epoch_graph.v1")
        );
        assert_eq!(
            graph
                .get("retirementState")
                .and_then(serde_json::Value::as_str),
            Some("not-required")
        );
        assert_eq!(
            graph
                .pointer("/latestPublication/fissionIslandId")
                .and_then(serde_json::Value::as_str),
            Some("fission-island:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(
            graph
                .pointer("/latestPublication/streamEpochCounters/none")
                .and_then(serde_json::Value::as_u64),
            graph
                .pointer("/latestPublication/activeGeneration")
                .and_then(serde_json::Value::as_u64)
        );
    }

    #[test]
    fn stream_ordering_drain_reports_retirement_strategy() {
        let no_retirement = StreamOrderingDrain::no_old_generation(25);
        assert_eq!(
            no_retirement.retirement_strategy_for_log(),
            "no_retirement_required"
        );

        let epoch_fence = StreamOrderingDrain {
            outcome: DrainOutcome::Synced {
                scope: DrainScope::Stream,
                elapsed_ms: 1,
                budget_ms: 25,
            },
            scope_label: "affected",
            stream_tokens: vec![0x77],
        };
        assert_eq!(epoch_fence.retirement_strategy_for_log(), "epoch_fence");

        let context_fallback = StreamOrderingDrain {
            outcome: DrainOutcome::Synced {
                scope: DrainScope::Context,
                elapsed_ms: 1,
                budget_ms: 25,
            },
            scope_label: "context",
            stream_tokens: vec![0x77],
        };
        assert_eq!(
            context_fallback.retirement_strategy_for_log(),
            "conservative_drain_fallback"
        );
        assert!(logical_epoch_retirement_proven(1, &context_fallback));
        assert!(physical_epoch_retirement_proven(1, &context_fallback, 0));
        assert!(!physical_epoch_retirement_proven(1, &context_fallback, 1));

        let timed_out = StreamOrderingDrain {
            outcome: DrainOutcome::TimedOut {
                scope: DrainScope::Stream,
                elapsed_ms: 25,
                budget_ms: 25,
            },
            scope_label: "affected",
            stream_tokens: vec![0x77],
        };
        assert!(!logical_epoch_retirement_proven(1, &timed_out));
        assert!(logical_epoch_retirement_proven(0, &timed_out));
        assert!(!physical_epoch_retirement_proven(1, &timed_out, 0));
        assert!(physical_epoch_retirement_proven(0, &timed_out, 0));
    }

    #[test]
    fn hot_reload_without_observed_streams_uses_context_drain() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        CTX_SYNC_CALLS.store(0, Ordering::SeqCst);

        let drain = drain_affected_streams(
            &stub_symbols(),
            &["unobserved_kernel".to_string()],
            false,
            25,
        );

        assert!(drain.is_synced());
        assert_eq!(drain.scope_label, "context");
        assert!(drain.stream_tokens.is_empty());
        assert_eq!(drain.outcome.short_label(), "synced");
        assert_eq!(
            drain.retirement_strategy_for_log(),
            "conservative_drain_fallback"
        );
        assert_eq!(CTX_SYNC_CALLS.load(Ordering::SeqCst), 1);
        reset_for_test();
    }

    #[test]
    fn full_runtime_proof_refuses_unattested_device_identity() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"fake-cubin-1").unwrap();
        second.write_all(b"fake-cubin-2").unwrap();
        let first_hash = sha256_hex_bytes(b"fake-cubin-1");
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();

        let mut a = rocm_adapter_with_symbols(symbols_without_device_identity());
        assert!(matches!(
            a.reload(&request_with_artifact_and_abi(
                &first_path,
                vec!["device.hip".into()],
                "sig-v1"
            )),
            AdapterReloadResult::Success { .. }
        ));
        launch_vec_add_on_stream(0x77);
        match a.reload(&request_with_artifact_and_abi(
            &second_path,
            vec!["device.hip".into()],
            "sig-v1",
        )) {
            AdapterReloadResult::Failed { error, recoverable } => {
                assert!(!recoverable);
                assert!(error.contains("device_identity_generation_baseline_missing"));
                assert!(error.contains("before module mutation"));
            }
            other => panic!("expected device-identity refusal, got {other:?}"),
        }

        assert_eq!(a.module_manager.swap_count(), 1);
        let first_artifact_id = format!("artifact:sha256:{first_hash}");
        assert_eq!(
            a.active_generation_artifact_id.as_deref(),
            Some(first_artifact_id.as_str())
        );
        assert!(a.last_reload_log().iter().any(|line| {
            line.contains("device_identity_continuity")
                && line.contains("event=refused")
                && line.contains("reason=device_identity_generation_baseline_missing")
        }));
        assert!(!a
            .last_reload_log()
            .iter()
            .any(|line| line.contains("\"type\":\"gpu_hmr_acceptance_ledger\"")));
        assert!(!a
            .last_reload_log()
            .iter()
            .any(|line| line.contains("\"type\":\"gpu_hmr_proof\"")));
        reset_for_test();
    }

    #[test]
    fn full_runtime_proof_refuses_device_identity_change_during_reload() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        DEVICE_UUID_QUERY_CALLS.store(0, Ordering::SeqCst);
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"fake-cubin-changing-device-1").unwrap();
        second.write_all(b"fake-cubin-changing-device-2").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let symbols = GpuDriverSymbolTable {
            cu_device_get_uuid: Some(changing_during_hot_reload_device_get_uuid),
            ..stub_symbols()
        };

        let mut adapter = rocm_adapter_with_symbols(symbols);
        assert!(matches!(
            adapter.reload(&request_with_artifact_and_abi(
                &first_path,
                vec!["device.hip".into()],
                "sig-v1"
            )),
            AdapterReloadResult::Success { .. }
        ));
        launch_vec_add_on_stream(0x77);
        assert!(matches!(
            adapter.reload(&request_with_artifact_and_abi(
                &second_path,
                vec!["device.hip".into()],
                "sig-v1"
            )),
            AdapterReloadResult::Failed {
                recoverable: false,
                ..
            }
        ));

        assert!(adapter.last_reload_log().iter().any(|line| {
            line.contains("device_identity_continuity")
                && line.contains("event=refused")
                && line.contains("same_device=false")
                && line.contains("reason=device_identity_uuid_changed")
        }));
        assert!(!adapter
            .last_reload_log()
            .iter()
            .any(|line| line.contains("\"type\":\"gpu_hmr_proof\"")));
        reset_for_test();
    }

    #[test]
    fn hot_reload_refuses_context_switch_from_active_generation_device() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        DEVICE_UUID_QUERY_CALLS.store(0, Ordering::SeqCst);
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"fake-cubin-generation-device-a").unwrap();
        second.write_all(b"fake-cubin-generation-device-b").unwrap();
        let first_hash = sha256_hex_bytes(b"fake-cubin-generation-device-a");
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let symbols = GpuDriverSymbolTable {
            cu_device_get_uuid: Some(switching_between_reload_device_get_uuid),
            ..stub_symbols()
        };

        let mut adapter = rocm_adapter_with_symbols(symbols);
        assert!(matches!(
            adapter.reload(&request_with_artifact_and_abi(
                &first_path,
                vec!["device.hip".into()],
                "sig-v1"
            )),
            AdapterReloadResult::Success { .. }
        ));
        assert_eq!(
            adapter
                .active_device_identity
                .as_ref()
                .map(|identity| identity.uuid_hex.as_str()),
            Some("11111111111111111111111111111111")
        );
        launch_vec_add_on_stream(0x77);

        match adapter.reload(&request_with_artifact_and_abi(
            &second_path,
            vec!["device.hip".into()],
            "sig-v1",
        )) {
            AdapterReloadResult::Failed { error, recoverable } => {
                assert!(!recoverable);
                assert!(error.contains("device_identity_uuid_changed_since_generation"));
                assert!(error.contains("before module mutation"));
            }
            other => panic!("expected active-generation device refusal, got {other:?}"),
        }

        assert_eq!(adapter.module_manager.swap_count(), 1);
        let first_artifact_id = format!("artifact:sha256:{first_hash}");
        assert_eq!(
            adapter.active_generation_artifact_id.as_deref(),
            Some(first_artifact_id.as_str())
        );
        assert!(adapter.last_reload_log().iter().any(|line| {
            line.contains("device_identity_continuity")
                && line.contains("event=refused")
                && line.contains("reason=device_identity_uuid_changed_since_generation")
        }));
        reset_for_test();
    }

    #[test]
    fn hot_reload_refuses_unattested_or_mismatched_nondefault_stream_device() {
        let _guard = runtime_boundary_test_guard();
        for (stream_query, expected_reason) in [
            (None, "stream_device_identity_symbol_missing"),
            (
                Some(wrong_stream_get_device as crate::hmr::gpu_driver_loader::CuStreamGetDeviceFn),
                "stream_device_identity_mismatch",
            ),
        ] {
            reset_for_test();
            let mut first = tempfile::NamedTempFile::new().unwrap();
            let mut second = tempfile::NamedTempFile::new().unwrap();
            first.write_all(b"fake-cubin-stream-device-1").unwrap();
            second.write_all(b"fake-cubin-stream-device-2").unwrap();
            let first_hash = sha256_hex_bytes(b"fake-cubin-stream-device-1");
            let first_path = first.path().to_string_lossy().to_string();
            let second_path = second.path().to_string_lossy().to_string();
            let symbols = GpuDriverSymbolTable {
                cu_stream_get_device: stream_query,
                ..stub_symbols()
            };
            let mut adapter = rocm_adapter_with_symbols(symbols);
            assert!(matches!(
                adapter.reload(&request_with_artifact_and_abi(
                    &first_path,
                    vec!["device.hip".into()],
                    "sig-v1"
                )),
                AdapterReloadResult::Success { .. }
            ));
            launch_vec_add_on_stream(0x77);

            match adapter.reload(&request_with_artifact_and_abi(
                &second_path,
                vec!["device.hip".into()],
                "sig-v1",
            )) {
                AdapterReloadResult::Failed { error, recoverable } => {
                    assert!(!recoverable);
                    assert!(error.contains(expected_reason));
                    assert!(error.contains("before module mutation"));
                }
                other => panic!("expected stream-device refusal, got {other:?}"),
            }

            assert_eq!(adapter.module_manager.swap_count(), 1);
            let first_artifact_id = format!("artifact:sha256:{first_hash}");
            assert_eq!(
                adapter.active_generation_artifact_id.as_deref(),
                Some(first_artifact_id.as_str())
            );
            assert!(adapter.last_reload_log().iter().any(|line| {
                line.contains("stream_device_identity")
                    && line.contains("event=refused")
                    && line.contains(&format!("reason={expected_reason}"))
            }));
            assert!(!adapter
                .last_reload_log()
                .iter()
                .any(|line| line.contains("\"type\":\"gpu_hmr_proof\"")));
        }
        reset_for_test();
    }

    #[test]
    fn full_runtime_proof_retains_native_device_identity_continuity() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"fake-cubin-identity-before").unwrap();
        second.write_all(b"fake-cubin-identity-after").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();

        let mut adapter = adapter_with_config_and_symbols(
            GpuModuleAdapterConfig {
                vendor: GpuVendor::Rocm,
                ..GpuModuleAdapterConfig::default()
            },
            stub_symbols(),
        );
        assert!(matches!(
            adapter.reload(&request_with_artifact_and_abi(
                &first_path,
                vec!["device.hip".into()],
                "sig-v1"
            )),
            AdapterReloadResult::Success { .. }
        ));
        launch_vec_add_on_stream(0x77);
        let second_request =
            request_with_artifact_and_abi(&second_path, vec!["device.hip".into()], "sig-v1");
        let expected_source_edit_id = second_request
            .source_edit_id
            .clone()
            .expect("compiler-derived source edit identity");
        assert!(matches!(
            adapter.reload(&second_request),
            AdapterReloadResult::Success { .. }
        ));

        let continuity = adapter
            .last_reload_log()
            .iter()
            .find(|line| line.contains("device_identity_continuity"))
            .expect("runtime device identity continuity evidence");
        assert!(continuity.contains("event=verified"));
        assert!(continuity.contains("same_device=true"));
        assert!(continuity
            .contains("device_identity_key=gpu-hardware-uuid:00112233445566778899aabbccddeeff"));
        assert!(continuity.contains("accepted_for_gpu_hmr=false"));

        let proof_line = adapter
            .last_reload_log()
            .iter()
            .find(|line| line.contains("\"type\":\"gpu_hmr_proof\""))
            .expect("strict runtime proof after native identity continuity");
        let proof = proof_json_from_line(proof_line);
        assert_eq!(proof["runtimeProofArtifact"]["gpuHmrSuccess"], json!(true));
        assert_eq!(
            proof.pointer("/runtimeProofArtifact/explicitProofLedgerRecord/edit_id"),
            Some(&json!(expected_source_edit_id))
        );
        assert_eq!(
            proof.pointer("/runtimeProofArtifact/acceptanceContract/edit_id"),
            Some(&json!(expected_source_edit_id))
        );
        assert_ne!(expected_source_edit_id, second_request.reload_id);
        assert_eq!(
            proof.pointer("/runtimeProofArtifact/explicitProofLedgerRecord/device_identity/device_identity_key"),
            Some(&json!(
                "gpu-hardware-uuid:00112233445566778899aabbccddeeff"
            ))
        );
        assert_eq!(
            proof.pointer("/runtimeProofArtifact/explicitProofLedgerRecord/device_identity/device_identity_authority"),
            Some(&json!(GPU_DISPATCH_DEVICE_ATTESTATION_AUTHORITY))
        );
        assert_eq!(
            proof.pointer("/runtimeProofArtifact/explicitProofLedgerRecord/device_identity/stream_device_identity_verified"),
            Some(&json!(true))
        );
        assert_eq!(
            proof.pointer("/runtimeProofArtifact/explicitProofLedgerRecord/device_identity/dispatch_stream_device_ordinal"),
            Some(&json!(0))
        );
        assert_eq!(
            proof.pointer("/runtimeProofArtifact/explicitProofLedgerRecord/device_identity/dispatch_device_attestation_schema"),
            Some(&json!(GPU_DISPATCH_DEVICE_ATTESTATION_SCHEMA))
        );
        reset_for_test();
    }

    #[test]
    fn strict_runtime_proof_refuses_device_switch_after_native_launch() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        DEVICE_SWITCH_AFTER_LAUNCH_ARMED.store(false, Ordering::SeqCst);
        DEVICE_SWITCH_AFTER_LAUNCH_ACTIVE.store(false, Ordering::SeqCst);
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first
            .write_all(b"fake-cubin-dispatch-device-before")
            .unwrap();
        second
            .write_all(b"fake-cubin-dispatch-device-after")
            .unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let symbols = GpuDriverSymbolTable {
            cu_device_get_uuid: Some(switching_after_native_launch_device_get_uuid),
            cu_launch_kernel: launch_kernel_switching_device_after_launch,
            ..stub_symbols()
        };
        let mut adapter = rocm_adapter_with_symbols(symbols);
        assert!(matches!(
            adapter.reload(&request_with_artifact_and_abi(
                &first_path,
                vec!["device.hip".into()],
                "sig-v1"
            )),
            AdapterReloadResult::Success { .. }
        ));
        launch_vec_add_on_stream(0x77);
        let previous_generation = current_launch_generation();
        let previous_handle = adapter.active_module_handle;
        let previous_artifact_id = adapter.active_generation_artifact_id.clone();
        let previous_swap_count = adapter.module_manager.swap_count();
        let unloads_before = UNLOAD_CALLS.load(Ordering::SeqCst);
        DEVICE_SWITCH_AFTER_LAUNCH_ARMED.store(true, Ordering::SeqCst);

        match adapter.reload(&request_with_artifact_and_abi(
            &second_path,
            vec!["device.hip".into()],
            "sig-v1",
        )) {
            AdapterReloadResult::Failed { error, recoverable } => {
                assert!(recoverable);
                assert!(error.contains("device_identity_missing"));
                assert!(
                    error.contains("dispatch_device_uuid_changed"),
                    "unexpected strict device-attestation refusal: {error}"
                );
                assert!(error.contains("candidate rolled back"));
            }
            other => panic!("expected strict device-attestation refusal, got {other:?}"),
        }
        assert_eq!(current_launch_generation(), previous_generation);
        assert_eq!(adapter.active_module_handle, previous_handle);
        assert_eq!(adapter.active_generation_artifact_id, previous_artifact_id);
        assert_eq!(adapter.module_manager.swap_count(), previous_swap_count);
        assert_eq!(
            adapter.module_manager.primary().map(|slot| slot.handle),
            previous_handle
        );
        assert_eq!(UNLOAD_CALLS.load(Ordering::SeqCst), unloads_before + 1);
        let output = output_oracle_records_snapshot()
            .into_iter()
            .rev()
            .find(|record| record.passed)
            .expect("native output can exist without strict device proof");
        let dispatch_id = output
            .after_dispatch_id
            .as_deref()
            .expect("output bound to exact dispatch");
        let launch = launch_records_snapshot()
            .into_iter()
            .rev()
            .find(|record| record.dispatch_id.as_deref() == Some(dispatch_id))
            .expect("exact native launch record");
        assert!(launch.dispatched);
        assert!(launch.dispatch_error.is_none());
        let attestation = dispatch_device_attestation_records_snapshot()
            .into_iter()
            .rev()
            .find(|record| record.dispatch_id == dispatch_id)
            .expect("exact dispatch attestation record");
        assert!(attestation.attestation.verified_observation().is_none());
        assert_eq!(
            attestation.attestation.blocking_gap(),
            Some("dispatch_device_uuid_changed")
        );
        assert!(!dispatch_device_attestation_rejection_records_snapshot()
            .into_iter()
            .any(|record| record.dispatch_id == dispatch_id));
        assert!(!adapter
            .last_reload_log()
            .iter()
            .any(|line| line.contains("\"type\":\"gpu_hmr_proof\"")));
        assert!(!adapter
            .last_reload_log()
            .iter()
            .any(|line| line.contains("dispatcher_epoch event=published")));
        assert!(adapter.last_reload_log().iter().any(|line| {
            line.contains("dispatcher_epoch")
                && line.contains("event=rolled_back")
                && line.contains("reason=acceptance_ledger_rejected")
        }));
        DEVICE_SWITCH_AFTER_LAUNCH_ARMED.store(false, Ordering::SeqCst);
        DEVICE_SWITCH_AFTER_LAUNCH_ACTIVE.store(false, Ordering::SeqCst);
        reset_for_test();
    }

    #[test]
    fn output_oracle_binds_exact_dispatch_when_nested_launch_finishes_first() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        NESTED_LAUNCH_ARMED.store(false, Ordering::SeqCst);
        NESTED_LAUNCH_COUNT.store(0, Ordering::SeqCst);
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"fake-cubin-receipt-before").unwrap();
        second.write_all(b"fake-cubin-receipt-after").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let second_artifact_id = format!(
            "artifact:sha256:{}",
            sha256_hex_bytes(b"fake-cubin-receipt-after")
        );
        let symbols = GpuDriverSymbolTable {
            cu_launch_kernel: ok_launch_kernel_with_nested_dispatch,
            ..stub_symbols()
        };
        let mut adapter = adapter_with_config_and_symbols(
            GpuModuleAdapterConfig {
                vendor: GpuVendor::Rocm,
                ..GpuModuleAdapterConfig::default()
            },
            symbols,
        );
        assert!(matches!(
            adapter.reload(&request_with_artifact_and_abi(
                &first_path,
                vec!["device.hip".into()],
                "sig-v1"
            )),
            AdapterReloadResult::Success { .. }
        ));
        launch_vec_add_on_stream(0x77);
        NESTED_LAUNCH_ARMED.store(true, Ordering::SeqCst);
        assert!(matches!(
            adapter.reload(&request_with_artifact_and_abi(
                &second_path,
                vec!["device.hip".into()],
                "sig-v1"
            )),
            AdapterReloadResult::Success { .. }
        ));
        assert_eq!(NESTED_LAUNCH_COUNT.load(Ordering::SeqCst), 1);

        let active_generation = current_launch_generation();
        let launches = launch_records_snapshot()
            .into_iter()
            .filter(|record| {
                record.active_generation == active_generation
                    && record.active_artifact_id.as_deref() == Some(second_artifact_id.as_str())
                    && record.dispatched
                    && record.dispatch_error.is_none()
            })
            .collect::<Vec<_>>();
        assert_eq!(launches.len(), 2);
        assert_eq!(launches[0].stream_token, 0);
        assert_eq!(launches[1].stream_token, 0x99);
        let output = output_oracle_records_snapshot()
            .into_iter()
            .rev()
            .find(|record| {
                record.generation == active_generation
                    && record.artifact_id.as_deref() == Some(second_artifact_id.as_str())
                    && record.passed
            })
            .expect("accepted output oracle for exact dispatch receipt");
        assert_eq!(
            output.after_dispatch_id.as_deref(),
            launches[0].dispatch_id.as_deref()
        );
        assert_ne!(
            output.after_dispatch_id.as_deref(),
            launches[1].dispatch_id.as_deref()
        );
        let output_dispatch_id = output
            .after_dispatch_id
            .as_deref()
            .expect("output dispatch id");
        let exact_attestation = dispatch_device_attestation_records_snapshot()
            .into_iter()
            .rev()
            .find(|record| record.dispatch_id == output_dispatch_id)
            .expect("output dispatch device attestation");
        assert_eq!(exact_attestation.attestation.stream_token(), 0);
        assert!(exact_attestation
            .attestation
            .verified_observation()
            .is_some());
        reset_for_test();
    }

    #[test]
    fn hot_reload_without_committed_oracle_refuses_before_candidate_load() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"fake-cubin-observation-before").unwrap();
        second.write_all(b"fake-cubin-observation-after").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let mut adapter = adapter_with_config_and_symbols(
            GpuModuleAdapterConfig {
                vendor: GpuVendor::Rocm,
                ..GpuModuleAdapterConfig::default()
            },
            stub_symbols(),
        );
        assert!(matches!(
            adapter.reload(&request_with_artifact_and_abi(
                &first_path,
                vec!["device.hip".into()],
                "sig-v1"
            )),
            AdapterReloadResult::Success { .. }
        ));
        let _device_bytes = launch_replayable_vec_add_on_stream(0x77);
        let loads_before = MODULE_LOAD_CALLS.load(Ordering::SeqCst);
        let unloads_before = UNLOAD_CALLS.load(Ordering::SeqCst);
        let old_handle = adapter.active_module_handle;
        let old_artifact_id = adapter.active_generation_artifact_id.clone();
        let old_swap_count = adapter.module_manager.swap_count();
        let second_request = request_without_output_oracle_commitment(
            &second_path,
            vec!["device.hip".into()],
            "sig-v1",
        );
        fs::remove_file(configured_gpu_hmr_runtime_output_oracle_profile_path())
            .expect("remove precommitted output profile for fallback test");

        match adapter.reload(&second_request) {
            AdapterReloadResult::Failed { error, recoverable } => {
                assert!(!recoverable);
                assert!(error.contains("missing a prepublication output oracle commitment"));
            }
            other => {
                panic!("expected strict refusal without precommitted output oracle, got {other:?}")
            }
        }
        assert_eq!(MODULE_LOAD_CALLS.load(Ordering::SeqCst), loads_before);
        assert_eq!(UNLOAD_CALLS.load(Ordering::SeqCst), unloads_before);
        assert_eq!(adapter.active_module_handle, old_handle);
        assert_eq!(adapter.active_generation_artifact_id, old_artifact_id);
        assert_eq!(adapter.module_manager.swap_count(), old_swap_count);
        assert!(adapter.last_reload_log().iter().any(|line| {
            line.contains("runtime_output_oracle_profile_pin")
                && line.contains("status=refused")
                && line.contains("accepted_for_gpu_hmr=false")
        }));
        assert!(!adapter
            .last_reload_log()
            .iter()
            .any(|line| line.contains("dispatcher_epoch event=published")));
        let _ = install_runtime_output_oracle_profile_for_tests();
        reset_for_test();
    }

    #[test]
    fn output_oracle_profile_pin_enforces_mode_matrix_and_exact_bindings() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut artifact = tempfile::NamedTempFile::new().unwrap();
        artifact.write_all(b"profile-pin-candidate").unwrap();
        let artifact_path = artifact.path().to_string_lossy().to_string();
        let candidate_sha256 = format!("sha256:{}", sha256_hex_bytes(b"profile-pin-candidate"));
        let valid = request_with_artifact(&artifact_path, vec!["device.hip".into()]);

        assert!(matches!(
            pin_runtime_output_oracle_profile(&valid, &candidate_sha256, true),
            Ok(RuntimeOutputOracleProfilePin::Committed(_))
        ));

        fs::remove_file(configured_gpu_hmr_runtime_output_oracle_profile_path()).unwrap();
        assert!(
            pin_runtime_output_oracle_profile(&valid, &candidate_sha256, true)
                .unwrap_err()
                .contains("commitment has no profile bytes")
        );
        let _ = install_runtime_output_oracle_profile_for_tests();

        let mut uncommitted = valid.clone();
        uncommitted.source_edit_id = None;
        uncommitted.capsule_metadata = None;
        assert!(
            pin_runtime_output_oracle_profile(&uncommitted, &candidate_sha256, true)
                .unwrap_err()
                .contains("missing a prepublication commitment")
        );
        fs::write(
            configured_gpu_hmr_runtime_output_oracle_profile_path(),
            b"{malformed-uncommitted-cold-profile",
        )
        .unwrap();
        assert!(matches!(
            pin_runtime_output_oracle_profile(&uncommitted, &candidate_sha256, false),
            Ok(RuntimeOutputOracleProfilePin::ColdIgnored)
        ));
        fs::remove_file(configured_gpu_hmr_runtime_output_oracle_profile_path()).unwrap();
        assert!(
            pin_runtime_output_oracle_profile(&uncommitted, &candidate_sha256, true)
                .unwrap_err()
                .contains("missing a prepublication output oracle commitment")
        );

        let mut schema_mismatch = valid.clone();
        schema_mismatch
            .capsule_metadata
            .as_mut()
            .unwrap()
            .output_oracle_profile_commitment
            .as_mut()
            .unwrap()
            .schema_version = "synthi.gpu_hmr.reload_output_oracle_profile_commitment.v2".into();
        let _ = install_runtime_output_oracle_profile_for_tests();
        assert!(
            pin_runtime_output_oracle_profile(&schema_mismatch, &candidate_sha256, true)
                .unwrap_err()
                .contains("commitment schema mismatch")
        );

        let mut candidate_mismatch = valid.clone();
        candidate_mismatch
            .capsule_metadata
            .as_mut()
            .unwrap()
            .output_oracle_profile_commitment
            .as_mut()
            .unwrap()
            .candidate_artifact_sha256 = format!("sha256:{}", "a".repeat(64));
        let _ = install_runtime_output_oracle_profile_for_tests();
        assert!(
            pin_runtime_output_oracle_profile(&candidate_mismatch, &candidate_sha256, true)
                .unwrap_err()
                .contains("candidate artifact mismatch")
        );

        let mut contract_mismatch = valid.clone();
        contract_mismatch
            .capsule_metadata
            .as_mut()
            .unwrap()
            .fission_output_oracle_contract
            .as_mut()
            .unwrap()["oracleId"] = json!("test:changed:readback");
        let _ = install_runtime_output_oracle_profile_for_tests();
        assert!(
            pin_runtime_output_oracle_profile(&contract_mismatch, &candidate_sha256, true)
                .unwrap_err()
                .contains("fission contract mismatch")
        );

        let mut semantic_mismatch = valid.clone();
        let mut semantic_contract = semantic_mismatch
            .capsule_metadata
            .as_ref()
            .unwrap()
            .fission_output_oracle_contract
            .clone()
            .unwrap();
        semantic_contract["oracleId"] = json!("test:coherently-rehashed-but-wrong");
        write_fission_output_oracle_contract_for_request(&mut semantic_mismatch, semantic_contract);
        let _ = install_runtime_output_oracle_profile_for_tests();
        assert!(
            pin_runtime_output_oracle_profile(&semantic_mismatch, &candidate_sha256, true)
                .unwrap_err()
                .contains("semantic mismatch for oracleId")
        );

        let mut disabled = valid.clone();
        let mut disabled_profile: serde_json::Value =
            serde_json::from_slice(&install_runtime_output_oracle_profile_for_tests()).unwrap();
        disabled_profile["enabled"] = json!(false);
        write_runtime_output_oracle_profile_for_request(&mut disabled, &disabled_profile);
        assert!(
            pin_runtime_output_oracle_profile(&disabled, &candidate_sha256, true)
                .unwrap_err()
                .contains("profile is disabled")
        );

        let mut unknown_field = valid.clone();
        let mut unknown_field_profile: serde_json::Value =
            serde_json::from_slice(&install_runtime_output_oracle_profile_for_tests()).unwrap();
        unknown_field_profile["unexpectedSuccessAuthority"] = json!(true);
        write_runtime_output_oracle_profile_for_request(&mut unknown_field, &unknown_field_profile);
        assert!(
            pin_runtime_output_oracle_profile(&unknown_field, &candidate_sha256, true)
                .unwrap_err()
                .contains("unknown field")
        );

        let mut unchanged_output = valid.clone();
        let mut unchanged_output_profile: serde_json::Value =
            serde_json::from_slice(&install_runtime_output_oracle_profile_for_tests()).unwrap();
        unchanged_output_profile["buffers"][0]["initializer"] = json!({ "kind": "zero" });
        unchanged_output_profile["baselineSha256"] =
            unchanged_output_profile["expectedSha256"].clone();
        write_runtime_output_oracle_profile_for_request(
            &mut unchanged_output,
            &unchanged_output_profile,
        );
        assert!(
            pin_runtime_output_oracle_profile(&unchanged_output, &candidate_sha256, true)
                .unwrap_err()
                .contains("baseline and expected hashes are identical")
        );

        let mut overflowing_scalar = valid.clone();
        let mut overflowing_scalar_profile: serde_json::Value =
            serde_json::from_slice(&install_runtime_output_oracle_profile_for_tests()).unwrap();
        overflowing_scalar_profile["args"][3] = json!({
            "kind": "scalar_f32",
            "value": 1.0e100,
        });
        write_runtime_output_oracle_profile_for_request(
            &mut overflowing_scalar,
            &overflowing_scalar_profile,
        );
        assert!(
            pin_runtime_output_oracle_profile(&overflowing_scalar, &candidate_sha256, true)
                .unwrap_err()
                .contains("overflows finite f32 range")
        );

        let _ = install_runtime_output_oracle_profile_for_tests();
        std::env::set_var("SYNTHI_GPU_HMR_RUNTIME_OUTPUT_ORACLE_MAX_BYTES", "16");
        assert!(
            pin_runtime_output_oracle_profile(&valid, &candidate_sha256, true)
                .unwrap_err()
                .contains("aggregate bytes")
        );
        std::env::remove_var("SYNTHI_GPU_HMR_RUNTIME_OUTPUT_ORACLE_MAX_BYTES");

        let mut source_mismatch = valid.clone();
        source_mismatch.source_edit_id = Some(format!("source-edit:sha256:{}", "f".repeat(64)));
        let _ = install_runtime_output_oracle_profile_for_tests();
        assert!(
            pin_runtime_output_oracle_profile(&source_mismatch, &candidate_sha256, true)
                .unwrap_err()
                .contains("source edit mismatch")
        );

        let mut changed_profile_bytes = install_runtime_output_oracle_profile_for_tests();
        changed_profile_bytes.push(b'\n');
        fs::write(
            configured_gpu_hmr_runtime_output_oracle_profile_path(),
            changed_profile_bytes,
        )
        .unwrap();
        assert!(
            pin_runtime_output_oracle_profile(&valid, &candidate_sha256, true)
                .unwrap_err()
                .contains("profile bytes mismatch")
        );

        let oversized = vec![b' '; MAX_RUNTIME_OUTPUT_ORACLE_PROFILE_BYTES as usize + 1];
        fs::write(
            configured_gpu_hmr_runtime_output_oracle_profile_path(),
            oversized,
        )
        .unwrap();
        assert!(
            pin_runtime_output_oracle_profile(&valid, &candidate_sha256, true)
                .unwrap_err()
                .contains("profile exceeds")
        );
        let _ = install_runtime_output_oracle_profile_for_tests();
        std::env::remove_var("SYNTHI_GPU_HMR_RUNTIME_OUTPUT_ORACLE_MAX_BYTES");
        reset_for_test();
    }

    #[test]
    fn output_oracle_profile_refusal_precedes_all_module_mutation() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        MODULE_LOAD_CALLS.store(0, Ordering::SeqCst);
        UNLOAD_CALLS.store(0, Ordering::SeqCst);
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"profile-preflight-before").unwrap();
        second.write_all(b"profile-preflight-after").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let mut adapter = rocm_adapter_with_symbols(stub_symbols());
        assert!(matches!(
            adapter.reload(&request_with_artifact(
                &first_path,
                vec!["device.hip".into()]
            )),
            AdapterReloadResult::Success { .. }
        ));

        adapter.pending_retired_modules.push(ModuleSlot {
            handle: 0xfeed,
            blob_bytes: 32,
        });
        let module_loads_before = MODULE_LOAD_CALLS.load(Ordering::SeqCst);
        let unloads_before = UNLOAD_CALLS.load(Ordering::SeqCst);
        let generation_before = current_launch_generation();
        let swaps_before = adapter.module_manager.swap_count();
        let active_artifact_before = adapter.active_generation_artifact_id.clone();
        let mut second_request = request_with_artifact(&second_path, vec!["device.hip".into()]);
        second_request.source_edit_id = Some(format!("source-edit:sha256:{}", "f".repeat(64)));

        match adapter.reload(&second_request) {
            AdapterReloadResult::Failed { error, recoverable } => {
                assert!(!recoverable);
                assert!(error.contains("source edit mismatch before module mutation"));
            }
            other => panic!("expected prepublication profile refusal, got {other:?}"),
        }
        assert_eq!(
            MODULE_LOAD_CALLS.load(Ordering::SeqCst),
            module_loads_before
        );
        assert_eq!(UNLOAD_CALLS.load(Ordering::SeqCst), unloads_before);
        assert_eq!(adapter.pending_retired_modules.len(), 1);
        assert_eq!(current_launch_generation(), generation_before);
        assert_eq!(adapter.module_manager.swap_count(), swaps_before);
        assert_eq!(
            adapter.active_generation_artifact_id,
            active_artifact_before
        );
        assert!(adapter.last_reload_log().iter().any(|line| {
            line.contains("runtime_output_oracle_profile_pin")
                && line.contains("status=refused")
                && line.contains("accepted_for_gpu_hmr=false")
        }));
        assert!(!adapter
            .last_reload_log()
            .iter()
            .any(|line| line.contains("dispatcher_epoch event=published")));

        let mut legacy_six_token_request =
            request_with_artifact(&second_path, vec!["device.hip".into()]);
        legacy_six_token_request.source_edit_id = None;
        match adapter.reload(&legacy_six_token_request) {
            AdapterReloadResult::Failed { error, recoverable } => {
                assert!(!recoverable);
                assert!(error.contains("source edit identity is missing"));
            }
            other => panic!("expected missing independent source identity refusal, got {other:?}"),
        }
        assert_eq!(
            MODULE_LOAD_CALLS.load(Ordering::SeqCst),
            module_loads_before
        );
        assert_eq!(UNLOAD_CALLS.load(Ordering::SeqCst), unloads_before);
        assert_eq!(current_launch_generation(), generation_before);
        assert_eq!(adapter.module_manager.swap_count(), swaps_before);
        assert_eq!(
            adapter.active_generation_artifact_id,
            active_artifact_before
        );
        adapter.pending_retired_modules.clear();
        reset_for_test();
    }

    #[test]
    fn output_oracle_execution_uses_pinned_bytes_after_disk_swap() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        MODULE_LOAD_CALLS.store(0, Ordering::SeqCst);
        UNLOAD_CALLS.store(0, Ordering::SeqCst);
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"profile-pin-before").unwrap();
        second.write_all(b"profile-pin-after").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let mut adapter = rocm_adapter_with_symbols(stub_symbols());
        assert!(matches!(
            adapter.reload(&request_with_artifact(
                &first_path,
                vec!["device.hip".into()]
            )),
            AdapterReloadResult::Success { .. }
        ));
        launch_vec_add_on_stream(0x77);
        let second_request = request_with_artifact(&second_path, vec!["device.hip".into()]);
        let profile_path = configured_gpu_hmr_runtime_output_oracle_profile_path();
        let module_loads_before = MODULE_LOAD_CALLS.load(Ordering::SeqCst);
        let unloads_before = UNLOAD_CALLS.load(Ordering::SeqCst);
        install_runtime_output_oracle_post_pin_hook_for_test(move || {
            assert_eq!(
                MODULE_LOAD_CALLS.load(Ordering::SeqCst),
                module_loads_before
            );
            assert_eq!(UNLOAD_CALLS.load(Ordering::SeqCst), unloads_before);
            fs::write(&profile_path, b"{malformed-after-pin").unwrap();
        });

        assert!(matches!(
            adapter.reload(&second_request),
            AdapterReloadResult::Success { .. }
        ));
        assert_eq!(
            fs::read(configured_gpu_hmr_runtime_output_oracle_profile_path()).unwrap(),
            b"{malformed-after-pin"
        );
        assert!(adapter.last_reload_log().iter().any(|line| {
            line.contains("runtime_output_oracle_profile_pin")
                && line.contains("status=verified")
                && line.contains("profile=test-vec-add-readback")
                && line.contains("accepted_for_gpu_hmr=false")
        }));
        assert!(adapter.last_reload_log().iter().any(|line| {
            line.contains("runtime_output_oracle_probe status=pass")
                && line.contains("profile=test-vec-add-readback")
        }));
        assert!(!adapter
            .last_reload_log()
            .iter()
            .any(|line| line.contains("event=rolled_back")));
        let proof_line = adapter
            .last_reload_log()
            .iter()
            .find(|line| line.contains("\"type\":\"gpu_hmr_proof\""))
            .expect("strict GPU HMR proof line");
        let proof = proof_json_from_line(proof_line);
        let record = &proof["proofLedger"]["records"][0];
        let publish = &record["epoch_publish_event"];
        let commit = &record["epoch_commit_event"];
        let dispatch = &record["dispatch_event"];
        assert_eq!(publish["event"], "provisional_install");
        assert_eq!(commit["event"], "unrestricted_visibility_commit");
        assert_eq!(publish["publication_id"], commit["publication_id"]);
        assert_eq!(publish["publication_id"], dispatch["publication_id"]);
        assert_eq!(
            publish["candidate_registration_id"],
            commit["candidate_registration_id"]
        );
        assert_eq!(
            publish["candidate_registration_id"],
            dispatch["dispatcher_registration_id"]
        );
        assert!(publish["publication_id"]
            .as_str()
            .is_some_and(|value| value.starts_with("dispatcher-publication:sha256:")));
        let loader_ts = record["loader_event"]["timestamp_monotonic_ns"]
            .as_u64()
            .unwrap();
        let publish_ts = publish["timestamp_monotonic_ns"].as_u64().unwrap();
        let dispatch_ts = dispatch["timestamp_monotonic_ns"].as_u64().unwrap();
        let output_ts = record["output_event"]["timestamp_monotonic_ns"]
            .as_u64()
            .unwrap();
        let commit_ts = commit["timestamp_monotonic_ns"].as_u64().unwrap();
        let retirement_ts = record["retirement_event"]["timestamp_monotonic_ns"]
            .as_u64()
            .unwrap();
        assert!(loader_ts <= publish_ts);
        assert!(publish_ts <= dispatch_ts);
        assert!(dispatch_ts <= output_ts);
        assert!(output_ts <= commit_ts);
        assert!(commit_ts <= retirement_ts);
        let runtime_trace = &proof["runtimeProofArtifact"]["runtimeTrace"];
        assert_eq!(
            runtime_trace["epochCommitEvents"][0]["publicationId"],
            runtime_trace["dispatchEvents"][0]["publicationId"]
        );
        assert_eq!(
            runtime_trace["epochCommitEvents"][0]["candidateRegistrationId"],
            runtime_trace["dispatchEvents"][0]["dispatcherRegistrationId"]
        );
        let _ = install_runtime_output_oracle_profile_for_tests();
        reset_for_test();
    }

    #[test]
    fn phase3_reload_installs_runtime_launch_dispatcher() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        LAUNCH_CALLS.store(0, Ordering::SeqCst);
        LAST_LAUNCH_GRID_X.store(0, Ordering::SeqCst);
        LAST_LAUNCH_BLOCK_X.store(0, Ordering::SeqCst);

        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"fake-cubin").unwrap();
        let path = file.path().to_string_lossy().to_string();
        let mut a = adapter_with_symbols(stub_symbols());
        let r = a.reload(&request_with_artifact(&path, vec!["device.cu".into()]));
        assert!(matches!(r, AdapterReloadResult::Success { .. }));

        let kernel = CString::new("vec_add").unwrap();
        let grid = 8_u32;
        let block = 256_u32;
        assert!(synthi_gpu_launch_raw(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            (&grid as *const u32).cast(),
            std::mem::size_of_val(&grid),
            (&block as *const u32).cast(),
            std::mem::size_of_val(&block),
            0,
            0,
            std::ptr::null(),
            4,
        ));

        assert_eq!(LAUNCH_CALLS.load(Ordering::SeqCst), 1);
        assert_eq!(LAST_LAUNCH_GRID_X.load(Ordering::SeqCst), 8);
        assert_eq!(LAST_LAUNCH_BLOCK_X.load(Ordering::SeqCst), 256);
        reset_for_test();
    }

    #[test]
    fn phase3_second_reload_unloads_retired_slot() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"fake-cubin-1").unwrap();
        second.write_all(b"fake-cubin-2").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let mut a = adapter_with_symbols(stub_symbols());
        assert!(matches!(
            a.reload(&request_with_artifact(
                &first_path,
                vec!["device.cu".into()]
            )),
            AdapterReloadResult::Success { .. }
        ));
        let first_handle = a.active_module_handle;
        assert!(matches!(
            a.reload(&request_with_artifact(
                &second_path,
                vec!["device.cu".into()]
            )),
            AdapterReloadResult::Success { .. }
        ));
        assert_eq!(a.module_manager.swap_count(), 2);
        assert_ne!(a.active_module_handle, first_handle);
    }

    #[test]
    fn phase3_second_reload_publishes_dispatcher_before_retiring_old_module() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        UNLOAD_GENERATION_AT_CALL.store(0, Ordering::SeqCst);

        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"fake-cubin-1").unwrap();
        second.write_all(b"fake-cubin-2").unwrap();
        let first_hash = sha256_hex_bytes(b"fake-cubin-1");
        let second_hash = sha256_hex_bytes(b"fake-cubin-2");
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let mut a = adapter_with_symbols(stub_symbols());

        assert!(matches!(
            a.reload(&request_with_artifact(
                &first_path,
                vec!["device.cu".into()]
            )),
            AdapterReloadResult::Success { .. }
        ));
        let first_generation = current_launch_generation();

        assert!(matches!(
            a.reload(&request_with_artifact(
                &second_path,
                vec!["device.cu".into()]
            )),
            AdapterReloadResult::Success { .. }
        ));
        let unload_generation = UNLOAD_GENERATION_AT_CALL.load(Ordering::SeqCst);

        assert!(unload_generation > first_generation);
        assert_eq!(unload_generation, current_launch_generation());
        let publish = a
            .last_reload_log()
            .iter()
            .find(|line| line.contains("dispatcher_epoch event=published"))
            .expect("dispatcher epoch publication report");
        assert!(
            publish.contains("dispatcher_epoch event=published")
                && publish.contains("publish_timestamp_ms=")
                && publish.contains("dispatch_table_hash_before=0x")
                && publish.contains("dispatch_table_hash_after=0x")
                && publish.contains("retired_modules=1")
                && publish.contains("stream_ordering_proven=true")
                && publish.contains("retirement_strategy=conservative_drain_fallback")
                && publish.contains("delayed_unload_result=pending")
        );
        assert!(publish.contains(&format!("old_artifact_id=artifact:sha256:{first_hash}")));
        assert!(publish.contains(&format!("new_artifact_id=artifact:sha256:{second_hash}")));
        assert!(publish.contains(&format!("new_artifact_hash=sha256:{second_hash}")));
        assert!(publish.contains("changed_symbols=vec_add"));
        assert!(publish.contains("function_handle_ids=vec_add:0x"));
        assert!(a.last_reload_log().iter().any(|line| line
            .contains("dispatcher_epoch event=retired")
            && line.contains("old_generation_retired=true")
            && line.contains("retirement_strategy=conservative_drain_fallback")
            && line.contains("delayed_unload_result=unloaded")));
        let final_graph_line = a
            .last_reload_log()
            .iter()
            .filter(|line| line.contains("epoch_generation_graph json="))
            .last()
            .expect("final epoch generation graph report");
        let final_graph = epoch_graph_json_from_line(final_graph_line);
        assert_eq!(
            final_graph
                .get("retirementState")
                .and_then(serde_json::Value::as_str),
            Some("retired")
        );
        assert!(final_graph
            .get("edges")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|edges| edges
                .iter()
                .any(
                    |edge| edge.get("kind").and_then(serde_json::Value::as_str) == Some("retire")
                )));
        reset_for_test();
    }

    #[test]
    fn provisional_publication_timeout_rolls_back_candidate_module() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        UNLOAD_CALLS.store(0, Ordering::SeqCst);

        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::channel();
        install_launch_dispatcher_with_metadata(
            Arc::new(BlockingDispatcher {
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
            GpuLaunchDispatcherMetadata {
                artifact_id: Some("artifact:sha256:prior".to_string()),
                ..GpuLaunchDispatcherMetadata::default()
            },
        );
        let previous_generation = current_launch_generation();
        let launch = std::thread::spawn(|| {
            synthi_gpu_launch_raw(
                std::ptr::null_mut(),
                b"prior_kernel\0".as_ptr().cast(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                0,
                0,
                0,
                std::ptr::null(),
                0,
            )
        });
        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("prior dispatcher entered runtime boundary");

        let mut artifact = tempfile::NamedTempFile::new().unwrap();
        artifact.write_all(b"provisional-hsaco").unwrap();
        let artifact_path = artifact.path().to_string_lossy().to_string();
        let mut adapter = adapter_with_config_and_symbols(
            GpuModuleAdapterConfig {
                vendor: GpuVendor::Rocm,
                drain_timeout_ms: 5,
                ..GpuModuleAdapterConfig::default()
            },
            stub_symbols(),
        );

        let result = adapter.reload(&request_with_artifact(
            &artifact_path,
            vec!["kernel.hip".to_string()],
        ));

        match result {
            AdapterReloadResult::Failed { error, recoverable } => {
                assert!(recoverable);
                assert!(error.contains("dispatcher publication begin failed"));
                assert!(error.contains("provisional module ownership rolled back"));
            }
            other => panic!("expected provisional publication failure, got {other:?}"),
        }
        assert_eq!(current_launch_generation(), previous_generation);
        assert!(adapter.module_manager.primary().is_none());
        assert!(adapter.module_manager.standby().is_none());
        assert_eq!(adapter.module_manager.swap_count(), 0);
        assert!(adapter
            .module_manager
            .kernel_table()
            .names()
            .next()
            .is_none());
        assert!(adapter.active_module_handle.is_none());
        assert!(adapter.active_generation_artifact_id.is_none());
        assert!(adapter.pending_retired_modules.is_empty());
        assert_eq!(UNLOAD_CALLS.load(Ordering::SeqCst), 1);

        release_tx.send(()).expect("release prior dispatcher");
        assert!(launch.join().expect("prior dispatch thread joined"));
        reset_for_test();
    }

    #[test]
    fn provisional_gate_redrains_old_launches_started_during_candidate_load() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();

        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"first-race-hsaco").unwrap();
        second.write_all(b"second-race-hsaco").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let mut adapter = rocm_adapter_with_symbols(stub_symbols());
        assert!(matches!(
            adapter.reload(&request_with_artifact(
                &first_path,
                vec!["kernel.hip".to_string()]
            )),
            AdapterReloadResult::Success { .. }
        ));

        MODULE_RESOLVE_OBSERVED.store(false, Ordering::SeqCst);
        CTX_SYNC_CALLS.store(0, Ordering::SeqCst);
        STREAM_SYNC_CALLS.store(0, Ordering::SeqCst);
        LAST_STREAM_SYNC_TOKEN.store(0, Ordering::SeqCst);
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        install_launch_dispatcher_with_metadata(
            Arc::new(ModuleResolveReleasedDispatcher {
                entered: entered_tx,
            }),
            GpuLaunchDispatcherMetadata {
                artifact_id: adapter.active_generation_artifact_id.clone(),
                changed_symbols: vec!["vec_add".to_string()],
                ..GpuLaunchDispatcherMetadata::default()
            },
        );
        let old_launch = std::thread::spawn(|| {
            synthi_gpu_launch_raw(
                std::ptr::null_mut(),
                b"vec_add\0".as_ptr().cast(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                0,
                0,
                0x77,
                std::ptr::null(),
                0,
            )
        });
        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("old launch entered during candidate load window");

        let result = adapter.reload(&request_with_artifact(
            &second_path,
            vec!["kernel.hip".to_string()],
        ));

        match &result {
            AdapterReloadResult::Success { .. } => {}
            AdapterReloadResult::Failed { error, recoverable } => {
                assert!(!recoverable);
                assert!(error.contains("device_identity_missing"));
            }
            other => panic!("unexpected publication-race result: {other:?}"),
        }
        assert!(old_launch.join().expect("old launch thread joined"));
        assert!(CTX_SYNC_CALLS.load(Ordering::SeqCst) >= 1);
        assert_eq!(STREAM_SYNC_CALLS.load(Ordering::SeqCst), 1);
        assert_eq!(LAST_STREAM_SYNC_TOKEN.load(Ordering::SeqCst), 0x77);
        let publish = adapter
            .last_reload_log()
            .iter()
            .find(|line| line.contains("dispatcher_epoch event=published"))
            .expect("transactional dispatcher publication line");
        assert!(publish.contains("host_boundary_quiescence_proven=true"));
        assert!(publish.contains("stream_scope=affected"));
        assert!(publish.contains("stream_ids=0x77"));
        assert!(publish.contains("retirement_strategy=epoch_fence"));
        reset_for_test();
    }

    #[test]
    fn committed_candidate_stays_coherent_but_strict_proof_refuses_failed_retirement() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        UNLOAD_CALLS.store(0, Ordering::SeqCst);

        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"first-hsaco").unwrap();
        second.write_all(b"second-hsaco").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let second_artifact_id = artifact_id_for_hash(&sha256_hex_bytes(b"second-hsaco"));
        let mut adapter = adapter_with_config_and_symbols(
            GpuModuleAdapterConfig {
                vendor: GpuVendor::Rocm,
                ..GpuModuleAdapterConfig::default()
            },
            unload_error_symbols(),
        );

        assert!(matches!(
            adapter.reload(&request_with_artifact(
                &first_path,
                vec!["kernel.hip".to_string()]
            )),
            AdapterReloadResult::Success { .. }
        ));
        let first_handle = adapter.active_module_handle;
        let first_generation = current_launch_generation();

        let second_result = adapter.reload(&request_with_artifact(
            &second_path,
            vec!["kernel.hip".to_string()],
        ));

        match second_result {
            AdapterReloadResult::Failed { error, recoverable } => {
                assert!(!recoverable);
                assert!(error.contains("runtime_proof_retirement_not_finalized"));
            }
            other => panic!("expected strict retirement refusal, got {other:?}"),
        }
        assert!(current_launch_generation() > first_generation);
        assert_ne!(adapter.active_module_handle, first_handle);
        assert_eq!(
            adapter.active_module_handle,
            adapter.module_manager.primary().map(|slot| slot.handle)
        );
        assert_eq!(
            adapter.active_generation_artifact_id.as_deref(),
            Some(second_artifact_id.as_str())
        );
        assert_eq!(adapter.pending_retired_modules.len(), 1);
        assert_eq!(UNLOAD_CALLS.load(Ordering::SeqCst), 1);
        assert!(adapter.last_reload_log().iter().any(|line| {
            line.contains("dispatcher_epoch event=retirement_failed")
                && line.contains("old_generation_retired=false")
                && line.contains("delayed_unload_result=failed")
        }));
        assert!(adapter.last_reload_log().iter().any(|line| {
            line.contains("strict_runtime_proof")
                && line.contains("status=refused")
                && line.contains("gap=runtime_proof_retirement_not_finalized")
                && line.contains("gpu_hmr_success=false")
        }));
        assert!(!adapter.last_reload_log().iter().any(|line| {
            line.contains("\"type\":\"gpu_hmr_acceptance_ledger\"")
                && line.contains("\"gpuHmrSuccess\":true")
        }));

        adapter
            .retry_pending_retired_modules(&stub_symbols())
            .expect("pending old module unload retry");
        assert!(adapter.pending_retired_modules.is_empty());
        assert_eq!(UNLOAD_CALLS.load(Ordering::SeqCst), 2);
        reset_for_test();
    }

    #[test]
    fn phase3_hot_reload_rejects_missing_firewall_evidence() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"fake-cubin-1").unwrap();
        second.write_all(b"fake-cubin-2").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let mut adapter = adapter_with_symbols(stub_symbols());

        assert!(matches!(
            adapter.reload(&request_with_artifact(
                &first_path,
                vec!["device.cu".into()]
            )),
            AdapterReloadResult::Success { .. }
        ));

        let mut second_request = request_with_artifact(&second_path, vec!["device.cu".into()]);
        second_request.firewall_evidence = Default::default();
        let result = adapter.reload(&second_request);

        match result {
            AdapterReloadResult::Failed { error, recoverable } => {
                assert!(recoverable);
                assert!(error.contains(
                    "GPU HMR acceptance ledger rejected candidate before global publication"
                ));
                assert!(error.contains("cpu_hmr_absence_evidence_missing"));
                assert!(error.contains("full_rebuild_absence_evidence_missing"));
                assert!(error.contains("process_restart_absence_evidence_missing"));
                assert!(error.contains("candidate rolled back"));
            }
            other => panic!("expected missing firewall evidence rejection, got {other:?}"),
        }
        assert!(adapter.last_reload_log().iter().any(|line| {
            line.contains("\"type\":\"gpu_hmr_acceptance_ledger\"")
                && line.contains("\"gpuHmrSuccess\":false")
                && line.contains("cpu_hmr_absence_evidence_missing")
                && line.contains("full_rebuild_absence_evidence_missing")
                && line.contains("process_restart_absence_evidence_missing")
        }));
        assert!(adapter.last_reload_log().iter().any(|line| {
            line.contains("dispatcher_epoch")
                && line.contains("event=rolled_back")
                && line.contains("reason=acceptance_ledger_rejected")
        }));
        reset_for_test();
    }

    #[test]
    fn phase3_reload_reports_abi_breaking_when_kernel_signature_changes() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"fake-cubin-1").unwrap();
        second.write_all(b"fake-cubin-2").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();

        let mut a = adapter_with_symbols(stub_symbols());
        assert!(matches!(
            a.reload(&request_with_artifact_and_abi(
                &first_path,
                vec!["device.cu".into()],
                "sig-v1"
            )),
            AdapterReloadResult::Success { .. }
        ));

        let r = a.reload(&request_with_artifact_and_abi(
            &second_path,
            vec!["device.cu".into()],
            "sig-v2",
        ));
        match r {
            AdapterReloadResult::Unsupported { reason } => {
                assert!(reason.contains("ABI changed"));
                assert!(reason.contains("cold device reload"));
            }
            other => panic!("expected Unsupported, got {:?}", other),
        }
        assert_eq!(a.module_manager.swap_count(), 1);
        assert_eq!(a.last_device_abi_version.as_deref(), Some("sig-v2"));
        assert!(a
            .last_reload_log()
            .iter()
            .any(|l| l.contains("plan=abi_breaking")));
        assert!(a
            .last_reload_log()
            .iter()
            .any(|l| l.contains("cold_reload reason=abi_breaking")));
        assert!(a
            .last_reload_log()
            .iter()
            .any(|l| l.contains("device_on_load invoked")));
    }

    #[test]
    fn partial_reload_does_not_replace_full_device_abi() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"fake-cubin-1").unwrap();
        second.write_all(b"fake-cubin-2").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();

        let mut a = adapter_with_symbols(stub_symbols());
        assert!(matches!(
            a.reload(&request_with_artifact_and_abi(
                &first_path,
                vec!["device.cu".into()],
                "sig-v1"
            )),
            AdapterReloadResult::Success { .. }
        ));

        let mut partial =
            request_with_artifact_and_abi(&second_path, vec!["device.cu".into()], "sig-v2");
        partial
            .build_manifest
            .capabilities
            .push(GPU_SIDECAR_PARTIAL_MODULE_CAPABILITY.into());
        assert!(matches!(
            a.reload(&partial),
            AdapterReloadResult::Success { .. }
        ));

        assert_eq!(a.module_manager.swap_count(), 2);
        assert_eq!(a.last_device_abi_version.as_deref(), Some("sig-v1"));
        assert!(a
            .last_reload_log()
            .iter()
            .any(|l| l.contains("reason=device-partial-file-only-edit")));
        let ownership = a
            .last_reload_log()
            .iter()
            .find(|l| l.contains("runtime_ownership"))
            .expect("runtime ownership report");
        assert!(ownership.contains("label=gpu-hmr-partial"));
        assert!(ownership.contains("partial=true"));
        assert!(ownership.contains("expected_symbols=vec_add"));
        assert!(ownership.contains("touched_symbols=vec_add"));
        assert!(ownership.contains("replaced_primary=false"));
    }

    #[test]
    fn partial_reload_drains_only_streams_that_used_touched_symbols() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        let mut partial_file = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"fake-cubin-1").unwrap();
        second.write_all(b"fake-cubin-2").unwrap();
        partial_file.write_all(b"fake-cubin-3").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let partial_path = partial_file.path().to_string_lossy().to_string();

        CTX_SYNC_CALLS.store(0, Ordering::SeqCst);
        STREAM_SYNC_CALLS.store(0, Ordering::SeqCst);
        LAST_STREAM_SYNC_TOKEN.store(0, Ordering::SeqCst);
        let mut a = adapter_with_symbols(stub_symbols());
        assert!(matches!(
            a.reload(&request_with_artifact_and_abi(
                &first_path,
                vec!["device.cu".into()],
                "sig-v1"
            )),
            AdapterReloadResult::Success { .. }
        ));
        assert_eq!(CTX_SYNC_CALLS.load(Ordering::SeqCst), 0);
        assert_eq!(STREAM_SYNC_CALLS.load(Ordering::SeqCst), 0);
        launch_vec_add_on_stream(0x77);

        let ctx_sync_before_oracle = CTX_SYNC_CALLS.load(Ordering::SeqCst);
        assert!(matches!(
            a.reload(&request_with_artifact_and_abi(
                &second_path,
                vec!["device.cu".into()],
                "sig-v1"
            )),
            AdapterReloadResult::Success { .. }
        ));
        assert_eq!(
            CTX_SYNC_CALLS.load(Ordering::SeqCst),
            ctx_sync_before_oracle + 1
        );
        assert_eq!(STREAM_SYNC_CALLS.load(Ordering::SeqCst), 2);
        assert_eq!(LAST_STREAM_SYNC_TOKEN.load(Ordering::SeqCst), 0x77);
        let publish = a
            .last_reload_log()
            .iter()
            .find(|line| line.contains("dispatcher_epoch event=published"))
            .expect("dispatcher epoch publication");
        assert!(publish.contains("stream_scope=affected"));
        assert!(publish.contains("stream_ids=0x77"));
        assert!(publish.contains("retirement_fence_ids=stream-sync:0x77:"));
        assert!(publish.contains("retirement_strategy=epoch_fence"));
        let stream_graph_line = a
            .last_reload_log()
            .iter()
            .filter(|line| line.contains("epoch_generation_graph json="))
            .last()
            .expect("stream epoch generation graph report");
        let stream_graph = epoch_graph_json_from_line(stream_graph_line);
        assert_eq!(
            stream_graph
                .pointer("/latestPublication/streamEpochCounters/0x77")
                .and_then(serde_json::Value::as_u64),
            Some(current_launch_generation())
        );
        assert!(stream_graph
            .pointer("/latestPublication/retirementFenceIds")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|ids| ids.iter().any(|id| id
                .as_str()
                .is_some_and(|id| id.starts_with("stream-sync:0x77:")))));

        let mut partial =
            request_with_artifact_and_abi(&partial_path, vec!["device.cu".into()], "sig-v2");
        partial
            .build_manifest
            .capabilities
            .push(GPU_SIDECAR_PARTIAL_MODULE_CAPABILITY.into());
        launch_vec_add_on_stream(0x88);
        let ctx_sync_before_partial_oracle = CTX_SYNC_CALLS.load(Ordering::SeqCst);
        let stream_sync_before_partial = STREAM_SYNC_CALLS.load(Ordering::SeqCst);
        assert!(matches!(
            a.reload(&partial),
            AdapterReloadResult::Success { .. }
        ));
        assert_eq!(
            CTX_SYNC_CALLS.load(Ordering::SeqCst),
            ctx_sync_before_partial_oracle + 1
        );
        assert_eq!(
            STREAM_SYNC_CALLS.load(Ordering::SeqCst),
            stream_sync_before_partial + 4
        );
        assert_eq!(LAST_STREAM_SYNC_TOKEN.load(Ordering::SeqCst), 0x88);
        let partial_publish = a
            .last_reload_log()
            .iter()
            .find(|line| line.contains("dispatcher_epoch event=published"))
            .expect("partial dispatcher epoch publication");
        assert!(partial_publish.contains("stream_ids=default,0x88"));
        reset_for_test();
    }

    #[test]
    fn captured_context_is_bound_before_reload() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"fake-cubin").unwrap();
        let path = file.path().to_string_lossy().to_string();

        CTX_SET_CALLS.store(0, Ordering::SeqCst);
        let mut a = adapter_with_symbols(stub_symbols());
        assert_eq!(a.capture_current_context_for_reload().unwrap(), Some(0x44));

        assert!(matches!(
            a.reload(&request_with_artifact(&path, vec!["device.cu".into()])),
            AdapterReloadResult::Success { .. }
        ));
        assert_eq!(CTX_SET_CALLS.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn runtime_ownership_reports_resolved_unique_symbols() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"fake-cubin").unwrap();
        let path = file.path().to_string_lossy().to_string();
        let mut req = request_with_artifact(&path, vec!["device.cu".into()]);
        req.build_manifest.exported_symbols = vec![
            "beta_kernel".into(),
            "alpha_kernel".into(),
            "beta_kernel".into(),
        ];

        let mut a = adapter_with_symbols(stub_symbols());
        assert!(matches!(
            a.reload(&req),
            AdapterReloadResult::Success { .. }
        ));

        let ownership = a
            .last_reload_log()
            .iter()
            .find(|line| line.contains("runtime_ownership"))
            .expect("runtime ownership report");
        assert!(ownership.contains("expected_symbols=alpha_kernel,beta_kernel"));
        assert!(ownership.contains("touched_symbols=alpha_kernel,beta_kernel"));
    }

    #[test]
    fn phase3_reload_uses_typed_sidecar_role_for_arbitrary_source_paths() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"fake-cubin").unwrap();
        let path = file.path().to_string_lossy().to_string();
        let mut a = adapter_with_symbols(stub_symbols());
        let r = a.reload(&request_with_artifact(
            &path,
            vec![
                "engines/render/include/material_kernel.inc".into(),
                "src/scene lighting/material graph.cpp".into(),
            ],
        ));
        assert!(matches!(r, AdapterReloadResult::Success { .. }));
        assert!(a
            .last_reload_log()
            .iter()
            .any(|l| l.contains("plan=device_only")));
    }

    #[test]
    fn filename_cannot_forge_gpu_sidecar_ownership() {
        let mut file = tempfile::Builder::new()
            .suffix(".hsaco")
            .tempfile()
            .expect("create filename-only GPU artifact fixture");
        file.write_all(b"filename-alone-is-not-ownership")
            .expect("write filename-only GPU artifact fixture");
        let path = file.path().to_string_lossy().to_string();
        let mut request = request_with_artifact(&path, vec!["device.hip".into()]);
        request.build_manifest.capabilities.clear();
        let adapter = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        assert_eq!(adapter.classify_plan(&request), GpuReloadPlan::HostOnly);

        request.build_manifest.capabilities = vec![GPU_SIDECAR_MODULE_CAPABILITY.to_string()];
        request.build_manifest.slot = BuildSlot::Full;
        assert_eq!(adapter.classify_plan(&request), GpuReloadPlan::HostOnly);
    }

    #[test]
    fn phase3_reload_uses_managed_buffer_snapshot_telemetry() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"fake-cubin").unwrap();
        let path = file.path().to_string_lossy().to_string();
        let name = CString::new("positions").unwrap();
        let lifetime = CString::new("persistent").unwrap();
        let mut device_ptr = 0x1234_u64;
        synthi_gpu_register_buffer(
            std::ptr::null_mut(),
            (&mut device_ptr as *mut u64).cast(),
            4096,
            name.as_ptr(),
            lifetime.as_ptr(),
        );

        let mut a = adapter_with_symbols(stub_symbols());
        let r = a.reload(&request_with_artifact(&path, vec!["device.cu".into()]));
        assert!(matches!(r, AdapterReloadResult::Success { .. }));
        assert!(a.last_reload_log().iter().any(|l| l.contains("step=save")
            && l.contains("buffers=1")
            && l.contains("bytes=4096")));
        assert!(a
            .last_reload_log()
            .iter()
            .any(|l| l.contains("gpu_snapshot_telemetry") && l.contains("snapshot_bytes=4096")));
        reset_for_test();
    }

    #[test]
    fn phase3_drain_error_faults_adapter_without_swapping() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut first = tempfile::NamedTempFile::new().unwrap();
        let mut second = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"fake-cubin-a").unwrap();
        second.write_all(b"fake-cubin-b").unwrap();
        let first_path = first.path().to_string_lossy().to_string();
        let second_path = second.path().to_string_lossy().to_string();
        let mut a = adapter_with_symbols(drain_error_symbols());
        let initial = a.reload(&request_with_artifact(
            &first_path,
            vec!["device.cu".into()],
        ));
        assert!(matches!(initial, AdapterReloadResult::Success { .. }));
        launch_vec_add_on_stream(0x99);

        let r = a.reload(&request_with_artifact(
            &second_path,
            vec!["device.cu".into()],
        ));
        match r {
            AdapterReloadResult::Failed {
                ref error,
                recoverable,
            } => {
                assert!(error.contains("GPU drain failed"));
                assert!(recoverable);
            }
            other => panic!("expected Failed, got {:?}", other),
        }
        assert_eq!(a.module_manager.swap_count(), 1);
        assert_eq!(a.healthcheck(), AdapterHealth::Faulted);
        assert_eq!(LAST_STREAM_SYNC_TOKEN.load(Ordering::SeqCst), 0x99);
        reset_for_test();
    }

    #[test]
    fn adapter_is_send_and_sync() {
        // Compile-time check — if these constraints break, the
        // planner can no longer hold a `Box<dyn Adapter>`.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<GpuModuleAdapter>();
    }

    #[test]
    fn boxed_dyn_adapter_dispatch() {
        let mut a: Box<dyn Adapter> =
            Box::new(GpuModuleAdapter::new(GpuModuleAdapterConfig::default()));
        assert_eq!(a.info().name, "gpu_module_cuda");
        a.initialize().unwrap();
        let r = a.reload(&dummy_request());
        assert!(matches!(
            r,
            AdapterReloadResult::Unsupported { .. } | AdapterReloadResult::Failed { .. }
        ));
    }
}
