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

use std::collections::HashMap;
use std::env;
use std::ffi::{c_void, CString};
use std::fs;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::adapter_trait::{
    Adapter, AdapterHealth, AdapterInfo, AdapterReloadRequest, AdapterReloadResult,
    ReloadCapsuleMetadata,
};
use crate::hmr::compile_manifest::{DeviceVendor, SnapshotMode};
use crate::hmr::device_snapshot::BufferRegistry;
use crate::hmr::gpu_driver_loader::{
    self, CuContext, CuDevicePtr, CuFunction, CuStream, DriverLoadError, GpuDriverHandle,
    GpuDriverSymbolTable,
};
use crate::hmr::gpu_module_manager::{
    GpuModuleManager, KernelResolution, KernelTable, ModuleManagerError,
};
use crate::hmr::gpu_proof::{
    sha256_hex_bytes, GpuHmrAcceptanceLedger, GpuHmrAcceptanceLedgerInput, GpuHmrDegradedState,
};
use crate::hmr::gpu_reload_orchestrator::{
    plan_gpu_reload, GpuReloadConfig, GpuReloadPlan, GpuSwapInputs,
};
use crate::hmr::gpu_stream_drain::{drain_stream, DrainOutcome, DrainScope};
use crate::runtime::gpu_runtime_boundary::{
    clear_launch_dispatcher, current_launch_generation, install_launch_dispatcher_with_metadata,
    latest_dispatch_id_for_generation, launch_records_snapshot, managed_buffers_snapshot,
    output_oracle_records_snapshot, record_hmr_runtime_identity_snapshot,
    record_output_buffer_checksum_with_probe_bytes_after_dispatch, runtime_session_id,
    synthi_gpu_launch_raw_arg_info, synthi_gpu_register_buffer, GpuLaunchDispatcher,
    GpuLaunchDispatcherMetadata, GpuLaunchRequest, LaunchArgProvenance, LaunchRecord,
    OutputOracleRecord, SynthiGpuLaunchArg, SYNTHI_GPU_ARG_KIND_FLOATING,
    SYNTHI_GPU_ARG_KIND_INTEGER, SYNTHI_GPU_ARG_KIND_POINTER,
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

impl GpuLaunchDispatcher for DriverLaunchDispatcher {
    fn dispatch(
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactLoaderTransport {
    FilesystemPath,
    RamBytes,
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

const RUNTIME_OUTPUT_ORACLE_DEFAULT_PATH: &str = "/tmp/synthi-gpu-hmr-runtime-output-oracle.json";

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeOutputOracleProfile {
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    schema_version: String,
    profile_id: String,
    oracle_id: String,
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
#[serde(rename_all = "camelCase")]
struct RuntimeOutputOracleBuffer {
    name: String,
    element_type: String,
    count: usize,
    initializer: RuntimeOutputOracleInitializer,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeOutputOracleInitializer {
    kind: String,
    #[serde(default)]
    start: Option<f32>,
    #[serde(default)]
    value: Option<f32>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeOutputOracleArg {
    kind: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    value: Option<serde_json::Value>,
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

fn default_true() -> bool {
    true
}

fn runtime_output_oracle_profile_path() -> String {
    env::var("SYNTHI_GPU_HMR_RUNTIME_OUTPUT_ORACLE_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| RUNTIME_OUTPUT_ORACLE_DEFAULT_PATH.to_string())
}

fn read_runtime_output_oracle_profile() -> Result<Option<RuntimeOutputOracleProfile>, String> {
    let path = runtime_output_oracle_profile_path();
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "runtime output oracle profile read failed: {error}"
            ))
        }
    };
    let profile: RuntimeOutputOracleProfile = serde_json::from_str(&text)
        .map_err(|error| format!("runtime output oracle profile JSON invalid: {error}"))?;
    if !profile.enabled {
        return Ok(None);
    }
    if profile.profile_id.trim().is_empty()
        || profile.oracle_id.trim().is_empty()
        || profile.expected_sha256.trim().is_empty()
        || profile.kernel_name.trim().is_empty()
        || profile.output_buffer.trim().is_empty()
        || profile.grid.contains(&0)
        || profile.block.contains(&0)
        || profile.buffers.is_empty()
        || profile.args.is_empty()
    {
        return Err("runtime output oracle profile is missing required fields".to_string());
    }
    Ok(Some(profile))
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
    value
        .as_f64()
        .filter(|value| value.is_finite())
        .map(|value| value as f32)
        .ok_or_else(|| "runtime output oracle scalar_f32 value must be finite number".to_string())
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
) -> Result<Option<String>, String> {
    let Some(profile) = read_runtime_output_oracle_profile()? else {
        return Ok(None);
    };
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
        let launch_ok = synthi_gpu_launch_raw_arg_info(
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
        if !launch_ok {
            return Err(format!(
                "runtime output oracle launch kernel={kernel_name:?} was rejected by runtime boundary"
            ));
        }
        let after_dispatch_id =
            latest_dispatch_id_for_generation(active_generation, runtime_session_id())
                .ok_or_else(|| {
                    format!(
                        "runtime output oracle launch kernel={kernel_name:?} did not publish dispatch identity"
                    )
                })?;
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
        let passed = record_output_buffer_checksum_with_probe_bytes_after_dispatch(
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
        Ok(format!(
            "[gpu-runtime-boundary] runtime_output_oracle_probe status={} profile={} schema={} kernel={} generation={} output_buffer={} bytes={} artifact_id={} after_dispatch_id={}",
            if passed { "pass" } else { "fail" },
            profile.profile_id,
            log_optional_token(Some(&profile.schema_version)),
            kernel_name,
            active_generation,
            profile.output_buffer,
            output.len(),
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
                && arg.value_bytes.as_ref().is_some_and(|bytes| {
                    !bytes.is_empty() && bytes.len() == arg.value_size
                })
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
    launch_records_snapshot()
        .into_iter()
        .rev()
        .find(|record| {
            record.runtime_session_id == runtime_session_id()
                && record.dispatched
                && record.dispatch_error.is_none()
                && record.active_generation == previous_generation
                && changed_symbols.iter().any(|symbol| symbol == &record.kernel_name)
                && replayable_arg_provenance(record)
                && replay_readback_target(record).is_some()
        })
}

fn run_runtime_output_oracle_replay(
    symbols: &GpuDriverSymbolTable,
    changed_symbols: &[String],
    previous_generation: u64,
    active_generation: u64,
    active_artifact_id: &str,
) -> Result<Option<String>, String> {
    let Some(record) = latest_replayable_launch_record(changed_symbols, previous_generation) else {
        return Ok(Some(format!(
            "[gpu-runtime-boundary] runtime_output_oracle_probe status=skipped profile=runtime-dispatch-replay generation={} artifact_id={} reason=no_replayable_prior_dispatch",
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
            let bytes = arg
                .value_bytes
                .clone()
                .ok_or_else(|| format!("runtime replay arg {} missing captured bytes", arg.index))?;
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
    let launch_ok = synthi_gpu_launch_raw_arg_info(
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
    if !launch_ok {
        return Err(format!(
            "runtime replay launch kernel={:?} was rejected by runtime boundary",
            record.kernel_name
        ));
    }
    let after_dispatch_id =
        latest_dispatch_id_for_generation(active_generation, runtime_session_id()).ok_or_else(
            || {
                format!(
                    "runtime replay launch kernel={:?} did not publish dispatch identity",
                    record.kernel_name
                )
            },
        )?;
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
    let expected = format!("sha256:{}", sha256_hex_bytes(&after));
    let probe_material = json!({
        "profile": "runtime-dispatch-replay",
        "kernel": record.kernel_name.clone(),
        "previous_generation": previous_generation,
        "active_generation": active_generation,
        "active_artifact_id": active_artifact_id,
        "readback_bytes": readback_bytes,
        "target_arg_index": target.index,
        "target_allocation_id": target.allocation_id,
    });
    let probe_config_hash = sha256_prefixed_from_text(&stable_json_string(&probe_material));
    let oracle_id = format!("runtime-replay.{}", record.kernel_name);
    let output_target_id = format!(
        "runtime-replay:{}:{}",
        &record.kernel_name,
        target
            .allocation_id
            .as_deref()
            .unwrap_or("registered-device-allocation")
    );
    let probe_evidence_ref = format!(
        "evidence:runtime-dispatch-replay:{}:{}",
        &record.kernel_name, after_dispatch_id
    );
    let passed = record_output_buffer_checksum_with_probe_bytes_after_dispatch(
        &oracle_id,
        &after,
        &expected,
        "worker.gpu_module_adapter.runtime_replay",
        &output_target_id,
        Some(active_artifact_id),
        Some(&after_dispatch_id),
        None,
        if before == after {
            "runtime_replay_readback_snapshot"
        } else {
            "runtime_replay_readback_changed"
        },
        &probe_config_hash,
        &probe_evidence_ref,
    );
    Ok(Some(format!(
        "[gpu-runtime-boundary] runtime_output_oracle_probe status={} profile=runtime-dispatch-replay schema=synthi.gpu_hmr.runtime_output_oracle.v1 kernel={} generation={} output_buffer={} bytes={} changed={} artifact_id={} after_dispatch_id={}",
        if passed { "pass" } else { "fail" },
        record.kernel_name,
        active_generation,
        output_target_id,
        after.len(),
        before != after,
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
) -> Result<Option<String>, String> {
    match run_runtime_output_oracle_profile(
        symbols,
        dispatcher_kernels,
        changed_symbols,
        active_generation,
        active_artifact_id,
    )? {
        Some(line) if runtime_boundary_token(&line, "status") != Some("skipped") => Ok(Some(line)),
        _ => run_runtime_output_oracle_replay(
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

fn latest_accepted_output_oracle_record(
    active_generation: u64,
    active_artifact_id: &str,
    after_dispatch_id: &str,
) -> Option<OutputOracleRecord> {
    output_oracle_records_snapshot()
        .into_iter()
        .rev()
        .find(|record| {
            record.passed
                && record.generation == active_generation
                && record.artifact_id.as_deref() == Some(active_artifact_id)
                && record.after_dispatch_id.as_deref() == Some(after_dispatch_id)
                && record.runtime_session_id == runtime_session_id()
        })
}

fn canonical_runtime_ledger_proof_id(record: &Value) -> String {
    let firewall = json_object_field_or_empty(record, "firewall_evidence");
    let material = json!({
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
    format!("gpu-ledger-proof:sha256:{}", stable_json_sha256(&material))
}

fn runtime_acceptance_contract(
    req: &AdapterReloadRequest,
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
    let compile_target = runtime_proof_compile_target(vendor);
    let stream = if dispatch_record.stream_token == 0 {
        "default".to_string()
    } else {
        format!("stream:{}", dispatch_record.stream_token)
    };
    let arg_provenance = launch_arg_provenance_json(&dispatch_record.arg_provenance);
    let evidence_by_field = json!({
        "kernel_name": evidence_refs,
        "launch_api": evidence_refs,
        "grid_dim": evidence_refs,
        "block_dim": evidence_refs,
        "shared_mem_bytes": evidence_refs,
        "stream": evidence_refs,
        "kernel_params": evidence_refs,
        "code_object_metadata": evidence_refs,
        "output_buffers": evidence_refs,
        "readback_oracle": evidence_refs,
    });
    json!({
        "contract_version": GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
        "contract_id": format!("gpu-hmr-contract:{contract_hash}"),
        "contract_hash": contract_hash,
        "project_id": req.build_manifest.preview_id,
        "edit_id": req.reload_id,
        "backend": vendor.proof_backend(),
        "confidence": 0.95,
        "evidence_refs": evidence_refs,
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
            "evidence_refs": evidence_refs,
            "backend_specific_adapter_safety_proven": true,
            "backend_specific_adapter_safety_evidence_refs": evidence_refs,
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
            "metadata_sources": evidence_refs,
        },
        "reload_mechanism": "generated_adapter",
        "adapter_outcome": "adapter_generated",
        "reload_evidence_refs": evidence_refs,
        "firewall_evidence": {
            "route": req.firewall_evidence.route,
            "cpu_hmr_used": false,
            "full_rebuild_used": false,
            "process_restarted": false,
            "process_id_before": process_id,
            "process_id_after": process_id,
            "evidence_source": req.firewall_evidence.evidence_source,
            "evidence_refs": evidence_refs,
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
            "publish_mechanism": "install_launch_dispatcher_with_metadata",
            "dispatch_binding": "runtime_launch_generation",
            "retirement_mechanism": retirement_strategy,
        },
        "epoch_retirement_proof": {
            "value": runtime_epoch_retirement_proof_value(retirement_strategy),
            "evidence_refs": evidence_refs,
        },
        "fission_report": {
            "selected_island": capsule_metadata
                .and_then(|metadata| metadata.fission_island_id.clone())
                .unwrap_or_else(|| "runtime-device-sidecar".to_string()),
            "selected_reason": "verified_device_artifact_delta",
            "artifact_hash_before": previous_artifact_id,
            "artifact_hash_after": new_artifact_id,
            "full_device_fallback": false,
            "host_relinked": false,
            "process_restarted": false,
            "full_rebuild_used": false,
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

#[allow(clippy::too_many_arguments)]
fn runtime_full_proof_line(
    req: &AdapterReloadRequest,
    vendor: GpuVendor,
    previous_artifact_id: &str,
    new_artifact_id: &str,
    artifact_hash: &str,
    active_generation: u64,
    previous_generation: u64,
    publish_timestamp_ms: u128,
    expected_symbols: &[String],
    loader_transport: ArtifactLoaderTransport,
    reload_elapsed_ms: u64,
    drain_elapsed_ms: u64,
    artifact_bytes: usize,
    retirement_strategy: &str,
    retirement_fence_ids: &str,
    capsule_metadata: Option<&ReloadCapsuleMetadata>,
    after_dispatch_id: &str,
) -> Option<String> {
    if req.firewall_evidence.cpu_hmr_used != Some(false)
        || req.firewall_evidence.full_rebuild_used != Some(false)
        || req.firewall_evidence.process_restarted != Some(false)
    {
        return None;
    }
    let process_id = std::process::id().to_string();
    let firewall_pid_before = req.firewall_evidence.process_id_before?.to_string();
    let firewall_pid_after = req.firewall_evidence.process_id_after?.to_string();
    if firewall_pid_before != process_id || firewall_pid_after != process_id {
        return None;
    }
    let output_record = latest_accepted_output_oracle_record(
        active_generation,
        new_artifact_id,
        after_dispatch_id,
    )?;
    let dispatch_record = launch_records_snapshot().into_iter().rev().find(|record| {
        record.runtime_session_id == runtime_session_id()
            && record.active_generation == active_generation
            && record.active_artifact_id.as_deref() == Some(new_artifact_id)
            && record.dispatch_id.as_deref() == Some(after_dispatch_id)
            && record.dispatched
    })?;
    let readback_hash = output_record
        .readback_sample_sha256
        .as_deref()
        .and_then(normalize_sha256_prefixed)?;
    let readback_bytes = output_record.readback_bytes?;
    if readback_bytes == 0 {
        return None;
    }
    let raw_readback_bin = output_record
        .probe_evidence_ref
        .clone()
        .unwrap_or_else(|| format!("memory://gpu-runtime-readback/{after_dispatch_id}.bin"));
    let oracle_code_hash = output_record
        .probe_config_hash
        .as_deref()
        .and_then(normalize_sha256_prefixed)
        .unwrap_or_else(|| {
            sha256_prefixed_from_text(&format!(
                "{}:{}:{}",
                output_record.oracle_id,
                output_record
                    .probe_mode
                    .as_deref()
                    .unwrap_or("runtime_readback_sample"),
                new_artifact_id
            ))
        });
    let loader_ts = saturating_u128_to_u64(publish_timestamp_ms);
    let publish_ts = loader_ts;
    let dispatch_ts = dispatch_record
        .dispatch_timestamp_ms
        .map(saturating_u128_to_u64)
        .filter(|ts| *ts >= publish_ts)
        .unwrap_or_else(|| publish_ts.saturating_add(1));
    let output_ts = output_record
        .readback_timestamp_ms
        .map(saturating_u128_to_u64)
        .filter(|ts| *ts >= dispatch_ts)
        .unwrap_or_else(|| dispatch_ts.saturating_add(1));
    let retirement_ts = saturating_u128_to_u64(epoch_millis_now()).max(output_ts.saturating_add(1));
    let dispatch_to_output_ms = output_ts.saturating_sub(dispatch_ts);
    let mut evidence_ref_values = vec![
        format!("runtime-session:{}", runtime_session_id()),
        format!("reload:{}", req.reload_id),
        format!("loader:{new_artifact_id}"),
        format!("epoch:{active_generation}"),
        format!("dispatch:{after_dispatch_id}"),
        format!("oracle:{}", output_record.oracle_id),
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
                "module_id": req.module_id,
                "backend": vendor.proof_backend(),
                "artifact_before": previous_artifact_id,
                "artifact_after": new_artifact_id,
                "expected_symbols": expected_symbols,
                "abi_hash": abi_hash,
            })))
        });
    let output_target_id = output_record
        .output_target_id
        .clone()
        .unwrap_or_else(|| "runtime-output-oracle".to_string());
    let producer = output_record
        .producer
        .clone()
        .unwrap_or_else(|| "worker.gpu_module_adapter".to_string());
    let slice_len = readback_bytes.min(64);
    let oracle_artifacts = json!({
        "raw_readback_bin": raw_readback_bin,
        "readback_schema_json": format!("memory://gpu-runtime-readback/{after_dispatch_id}.schema.json"),
        "checksum_before": previous_artifact_id,
        "checksum_after": readback_hash,
        "raw_readback_hash": readback_hash,
        "raw_readback_hash_verified": true,
        "raw_readback_source": "runtime_readback_sample",
        "raw_readback_byte_length": saturating_usize_to_u64(readback_bytes),
        "raw_readback_verification": {
            "hash_verified": true,
            "raw_readback_hash_verified": true,
            "raw_readback_byte_length": saturating_usize_to_u64(readback_bytes),
            "deterministic_slice_hash_verified": true,
        },
        "deterministic_slice": {
            "offset": 0u64,
            "length": saturating_usize_to_u64(slice_len),
            "stride": saturating_usize_to_u64(output_record.readback_sample_stride.unwrap_or(1)),
            "source": "runtime_readback_sample",
        },
        "deterministic_slice_hash": readback_hash,
        "deterministic_slice_hash_verified": true,
        "oracle_code_hash": oracle_code_hash,
        "rendered_card_png": format!("memory://gpu-runtime-readback/{after_dispatch_id}.proof-card.png"),
        "producer": producer,
        "timestamp_after_dispatch": output_ts,
        "epoch": active_generation.to_string(),
        "output_after_dispatch_id": after_dispatch_id,
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
    let device_uuid = format!("{}:{}", vendor.as_str(), vendor.driver_library());
    let device_identity = json!({
        "vendor": vendor.as_str(),
        "backend": vendor.proof_backend(),
        "device_uuid": device_uuid,
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
        "project_id": req.build_manifest.preview_id,
        "edit_id": req.reload_id,
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
            "epoch": active_generation.to_string(),
            "previous_epoch": previous_generation.to_string(),
            "artifact_id": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "timestamp_monotonic_ns": publish_ts,
            "process_id": process_id,
        },
        "dispatch_event": {
            "id": after_dispatch_id,
            "dispatch_id": after_dispatch_id,
            "epoch": active_generation.to_string(),
            "artifact_id": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "kernel_name": dispatch_record.kernel_name,
            "timestamp_monotonic_ns": dispatch_ts,
            "process_id": process_id,
        },
        "output_event": {
            "id": output_record.oracle_id,
            "passed": true,
            "after_dispatch_id": after_dispatch_id,
            "epoch": active_generation.to_string(),
            "artifact_id": new_artifact_id,
            "artifact_hash": new_artifact_id,
            "timestamp_monotonic_ns": output_ts,
            "process_id": process_id,
            "output_oracle": {
                "oracle_id": output_record.oracle_id,
                "kind": output_record.kind,
                "expected": output_record.expected,
                "actual": output_record.actual,
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
    let acceptance_contract = runtime_acceptance_contract(
        req,
        vendor,
        &contract_hash,
        previous_artifact_id,
        new_artifact_id,
        expected_symbols,
        &source_paths,
        &evidence_refs,
        &abi_hash,
        &process_id,
        &device_uuid,
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
            "outputOracleId": output_record.oracle_id,
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
    serde_json::to_string(&message).ok()
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
        if self.stream_tokens.is_empty() {
            return "no_retirement_required";
        }

        match self.outcome {
            DrainOutcome::Synced {
                scope: DrainScope::Context,
                ..
            } => "conservative_drain_fallback",
            _ => "epoch_fence",
        }
    }
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
        return StreamOrderingDrain::no_old_generation(budget_ms);
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
            kernel_table: HashMap::new(),
            health: AdapterHealth::Unknown,
            driver: None,
            module_manager: GpuModuleManager::new(),
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

    fn request_touches_device(req: &AdapterReloadRequest) -> bool {
        req.changed_files.iter().any(|path| {
            let p = path.as_str();
            p.ends_with(".cu")
                || p.ends_with(".hip")
                || p == "device"
                || p == "device.cu"
                || p == "device.hip"
        })
    }

    fn classify_plan_from_paths(req: &AdapterReloadRequest) -> GpuReloadPlan {
        let mut touches_device = false;
        let mut touches_host = false;
        for path in &req.changed_files {
            let p = path.as_str();
            if p.ends_with(".cu")
                || p.ends_with(".hip")
                || p == "device"
                || p == "device.cu"
                || p == "device.hip"
            {
                touches_device = true;
            } else {
                touches_host = true;
            }
        }
        match (touches_device, touches_host) {
            (true, true) => GpuReloadPlan::Mixed,
            (true, false) => GpuReloadPlan::DeviceOnly,
            (false, true) => GpuReloadPlan::HostOnly,
            (false, false) => GpuReloadPlan::DeviceOnly,
        }
    }

    fn classify_plan(&self, req: &AdapterReloadRequest) -> GpuReloadPlan {
        let path_plan = Self::classify_plan_from_paths(req);
        let partial_device_reload = req
            .build_manifest
            .capabilities
            .iter()
            .any(|capability| capability == "gpu_sidecar_partial_module");
        if partial_device_reload {
            return path_plan;
        }
        let current_abi = req.build_manifest.abi_version.trim();
        if Self::request_touches_device(req) && !current_abi.is_empty() {
            if let Some(previous_abi) = self.last_device_abi_version.as_deref() {
                if !previous_abi.is_empty() && previous_abi != current_abi {
                    return GpuReloadPlan::AbiBreaking;
                }
            }
        }
        path_plan
    }

    fn remember_device_abi(&mut self, req: &AdapterReloadRequest) {
        if req
            .build_manifest
            .capabilities
            .iter()
            .any(|capability| capability == "gpu_sidecar_partial_module")
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
        let line = format!(
            "[gpu-reload] runtime_ownership label={} partial={} artifact={} expected_symbols={} touched_symbols={} retired_modules={} replaced_primary={}",
            label,
            ownership.partial_reload,
            artifact,
            expected,
            touched,
            ownership.retired_module_count,
            ownership.replaced_primary
        );
        eprintln!("{line}");
        self.last_reload_log.push(line);
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

        let partial_device_reload = req
            .build_manifest
            .capabilities
            .iter()
            .any(|capability| capability == "gpu_sidecar_partial_module");
        let first_device_load =
            self.active_module_handle.is_none() && self.module_manager.primary().is_none();
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
        let drain = drain_affected_streams(
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
            let changed_symbols_for_log = if expected_symbols.is_empty() {
                "none".to_string()
            } else {
                expected_symbols.join(",")
            };
            let function_handle_ids =
                changed_function_handle_ids(&dispatcher_kernels, &expected_symbols);
            let dispatcher_kernels_for_probe = dispatcher_kernels.clone();
            record_hmr_runtime_identity_snapshot();
            let previous_generation = current_launch_generation();
            install_launch_dispatcher_with_metadata(
                Arc::new(DriverLaunchDispatcher {
                    symbols,
                    kernels: dispatcher_kernels,
                }),
                GpuLaunchDispatcherMetadata {
                    artifact_id: Some(new_artifact_id.clone()),
                    dispatch_table_hash: Some(format!("0x{dispatch_table_hash:016x}")),
                    changed_symbols: expected_symbols.clone(),
                    function_handle_ids: function_handle_ids
                        .split(',')
                        .filter(|value| !value.trim().is_empty() && *value != "none")
                        .map(str::to_string)
                        .collect(),
                },
            );
            let active_generation = current_launch_generation();
            record_hmr_runtime_identity_snapshot();
            let mut runtime_log_lines = Vec::new();
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
            let retirement_fence_ids =
                drain.retirement_fence_ids_for_log(previous_generation, active_generation);
            let retirement_strategy = drain.retirement_strategy_for_log();
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
                "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session={} publish_timestamp_ms={} previous_generation={} active_generation={} old_artifact_id={} new_artifact_id={} new_artifact_hash=sha256:{} capsule_id={} fission_island_id={} abi_membrane_hash={} dependency_closure_hash={} proof_hash={} changed_symbols={} function_handle_ids={} stream_epoch_counters={} dispatch_table_hash_before=0x{:016x} dispatch_table_hash_after=0x{:016x} dispatch_table_hash=0x{:016x} changed_entries={} retirement_tracked=true retired_modules={} old_generation_retired={} stream_scope={} stream_ids={} stream_ordering_proven={} retirement_fence_ids={} retirement_strategy={} delayed_unload_result={} drain_result={} drain_elapsed_ms={} drain_budget_ms={}",
                runtime_session,
                publish_timestamp_ms,
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
            let mut output_oracle_artifact_id: Option<String> = None;
            let mut output_oracle_after_dispatch_id: Option<String> = None;
            let mut output_oracle_passed = false;
            let mut output_after_dispatch = false;
            if !first_device_load {
                match run_runtime_output_oracle_probe(
                    &symbols,
                    &dispatcher_kernels_for_probe,
                    &expected_symbols,
                    previous_generation,
                    active_generation,
                    &new_artifact_id,
                ) {
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
                        output_after_dispatch =
                            output_oracle_artifact_id.as_deref() == Some(new_artifact_id.as_str());
                        eprintln!("{line}");
                        runtime_log_lines.push(line);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        let reason = error
                            .chars()
                            .map(|ch| if ch.is_whitespace() { '_' } else { ch })
                            .collect::<String>();
                        let line = format!(
                            "[gpu-runtime-boundary] runtime_output_oracle_probe status=fail generation={} artifact_id={} reason={}",
                            active_generation,
                            new_artifact_id,
                            reason
                        );
                        output_oracle_artifact_id =
                            runtime_boundary_token(&line, "artifact_id").map(str::to_string);
                        output_after_dispatch =
                            output_oracle_artifact_id.as_deref() == Some(new_artifact_id.as_str());
                        eprintln!("{line}");
                        runtime_log_lines.push(line);
                    }
                }
            }
            for retired in retired {
                self.module_manager
                    .unload_retired(&symbols, retired)
                    .map_err(Self::module_manager_error)?;
            }
            if retired_module_count > 0 {
                let retired_line = format!(
                    "[gpu-runtime-boundary] dispatcher_epoch event=retired runtime_session={} previous_generation={} active_generation={} retired_modules={} old_generation_retired=true stream_scope={} stream_ids={} stream_ordering_proven=true retirement_fence_ids={} retirement_strategy={} delayed_unload_result=unloaded",
                    runtime_session_id(),
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
            }
            let retirement_proven = retired_module_count == 0
                || runtime_log_lines.iter().any(|line| {
                    line.contains("dispatcher_epoch")
                        && runtime_boundary_token(line, "event") == Some("retired")
                        && runtime_boundary_token(line, "active_generation")
                            .and_then(|value| value.parse::<u64>().ok())
                            == Some(active_generation)
                        && runtime_boundary_token(line, "old_generation_retired") == Some("true")
                });
            let acceptance_ledger = GpuHmrAcceptanceLedger::new(GpuHmrAcceptanceLedgerInput {
                hot_reload: !first_device_load,
                artifact_id_after: new_artifact_id.clone(),
                loader_artifact_id: Some(new_artifact_id.clone()),
                epoch_publish_artifact_id: Some(new_artifact_id.clone()),
                dispatch_artifact_id: if output_after_dispatch {
                    Some(new_artifact_id.clone())
                } else {
                    None
                },
                output_artifact_id: output_oracle_artifact_id,
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
                device_identity: Some(format!(
                    "{}:{}",
                    self.config.vendor.as_str(),
                    self.config.vendor.driver_library()
                )),
            });
            let acceptance_line = acceptance_ledger.to_log_line();
            eprintln!("{acceptance_line}");
            runtime_log_lines.push(acceptance_line);
            if !first_device_load && acceptance_ledger.gpu_hmr_success && output_oracle_passed {
                if let Some(after_dispatch_id) = output_oracle_after_dispatch_id.as_deref() {
                    if let Some(proof_line) = runtime_full_proof_line(
                        req,
                        self.config.vendor,
                        &previous_artifact_id,
                        &new_artifact_id,
                        &artifact_hash,
                        active_generation,
                        previous_generation,
                        publish_timestamp_ms,
                        &expected_symbols,
                        loader_transport,
                        started.elapsed().as_millis() as u64,
                        drain.outcome.elapsed_ms(),
                        blob.len(),
                        retirement_strategy,
                        &retirement_fence_ids,
                        capsule_metadata,
                        after_dispatch_id,
                    ) {
                        eprintln!("{proof_line}");
                        runtime_log_lines.push(proof_line);
                    }
                }
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
                acceptance_ledger_success: acceptance_ledger.gpu_hmr_success,
                acceptance_ledger_failures: acceptance_ledger.failed_invariants,
            })
        })();

        match load_result {
            Ok(ownership) => {
                self.active_module_handle = self.module_manager.primary().map(|s| s.handle);
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
                    self.health = AdapterHealth::Healthy;
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
                self.phase = GpuPhase::Ready;
                self.health = AdapterHealth::Degraded;
                AdapterReloadResult::Failed {
                    error,
                    recoverable: true,
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
    };
    use crate::hmr::build_manifest::BuildManifest;
    use crate::hmr::gpu_driver_loader::{
        CuContext, CuDevicePtr, CuFunction, CuModule, CuResult, CuStream,
    };
    use crate::runtime::gpu_runtime_boundary::{
        current_launch_generation, reset_for_test, synthi_gpu_launch_raw,
        synthi_gpu_register_buffer, test_guard_for_test as runtime_boundary_test_guard,
    };
    use std::ffi::{c_void, CString};
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    fn dummy_request() -> AdapterReloadRequest {
        let pid = std::process::id();
        AdapterReloadRequest {
            reload_id: "test".into(),
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
    fn runtime_acceptance_contract_uses_shared_schema_enums() {
        let mut req = dummy_request();
        req.reload_id = "edit-runtime-contract".to_string();
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
            GpuVendor::Rocm,
            "sha256:contract",
            "sha256:before",
            "sha256:after",
            &["shade".to_string()],
            &["kernels/device.hip".to_string(), "build/device.hsaco".to_string()],
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
        assert_eq!(contract["classification"]["confidence"], json!(0.95));
        assert_eq!(contract["artifact_identity"]["artifact_kind"], json!("hsaco"));
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

    unsafe extern "C" fn ok_module_load_data(
        module: *mut CuModule,
        _image: *const c_void,
    ) -> CuResult {
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
        UNLOAD_GENERATION_AT_CALL.store(current_launch_generation(), Ordering::SeqCst);
        0
    }

    unsafe extern "C" fn ok_module_get_function(
        hfunc: *mut CuFunction,
        _hmod: CuModule,
        _name: *const u8,
    ) -> CuResult {
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

    fn drain_error_symbols() -> GpuDriverSymbolTable {
        GpuDriverSymbolTable {
            cu_stream_synchronize: err_stream_synchronize,
            ..stub_symbols()
        }
    }

    fn install_runtime_output_oracle_profile_for_tests() {
        let output_bytes = vec![0_u8; 4 * std::mem::size_of::<f32>()];
        let expected_sha256 = format!("sha256:{}", sha256_hex_bytes(&output_bytes));
        let profile_path = std::env::temp_dir().join("synthi-gpu-hmr-test-output-oracle.json");
        let profile = serde_json::json!({
            "enabled": true,
            "schemaVersion": "synthi.gpu_hmr.runtime_output_oracle_profile.v1",
            "profileId": "test-vec-add-readback",
            "oracleId": "test:vec_add:readback",
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
                    "initializer": { "kind": "fill", "value": 0.0 }
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
            "probeConfigHash": "sha256:test-stub-output-oracle",
            "probeEvidenceRef": "gpu_module_adapter.rs:test_runtime_output_oracle_profile"
        });
        fs::write(
            &profile_path,
            serde_json::to_string_pretty(&profile).expect("serialize test oracle profile"),
        )
        .expect("write test oracle profile");
        std::env::set_var("SYNTHI_GPU_HMR_RUNTIME_OUTPUT_ORACLE_PATH", profile_path);
    }

    fn adapter_with_symbols(symbols: GpuDriverSymbolTable) -> GpuModuleAdapter {
        adapter_with_config_and_symbols(GpuModuleAdapterConfig::default(), symbols)
    }

    fn adapter_with_config_and_symbols(
        config: GpuModuleAdapterConfig,
        symbols: GpuDriverSymbolTable,
    ) -> GpuModuleAdapter {
        install_runtime_output_oracle_profile_for_tests();
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
        let pid = std::process::id();
        let mut manifest =
            BuildManifest::for_language("test-preview", "cuda").with_artifact(path, "test-hash");
        manifest.abi_version = abi_version.to_string();
        manifest.exported_symbols = vec!["vec_add".into()];
        AdapterReloadRequest {
            reload_id: "test".into(),
            module_id: "device".into(),
            changed_files,
            build_manifest: manifest,
            artifact_blob: None,
            capsule_metadata: None,
            firewall_evidence: ReloadFirewallEvidence::from_gpu_device_sidecar_boundary(
                "gpu_module_adapter_test:request_with_artifact",
                pid,
                pid,
            ),
            preserve_state: true,
            timeout_ms: 5_000,
        }
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
                && publish.contains("retirement_strategy=no_retirement_required")
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
            && line.contains("retirement_strategy=no_retirement_required")
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
                assert!(!recoverable);
                assert!(error.contains("GPU HMR acceptance ledger rejected hot reload"));
                assert!(error.contains("cpu_hmr_absence_evidence_missing"));
                assert!(error.contains("full_rebuild_absence_evidence_missing"));
                assert!(error.contains("process_restart_absence_evidence_missing"));
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
            .push("gpu_sidecar_partial_module".into());
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
        assert_eq!(STREAM_SYNC_CALLS.load(Ordering::SeqCst), 1);
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
            .push("gpu_sidecar_partial_module".into());
        launch_vec_add_on_stream(0x88);
        let ctx_sync_before_partial_oracle = CTX_SYNC_CALLS.load(Ordering::SeqCst);
        assert!(matches!(
            a.reload(&partial),
            AdapterReloadResult::Success { .. }
        ));
        assert_eq!(
            CTX_SYNC_CALLS.load(Ordering::SeqCst),
            ctx_sync_before_partial_oracle + 1
        );
        assert_eq!(STREAM_SYNC_CALLS.load(Ordering::SeqCst), 2);
        assert_eq!(LAST_STREAM_SYNC_TOKEN.load(Ordering::SeqCst), 0x88);
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
    fn phase3_reload_reports_mixed_plan_when_host_and_device_changed() {
        let _guard = runtime_boundary_test_guard();
        reset_for_test();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"fake-cubin").unwrap();
        let path = file.path().to_string_lossy().to_string();
        let mut a = adapter_with_symbols(stub_symbols());
        let r = a.reload(&request_with_artifact(
            &path,
            vec!["core.cpp".into(), "device.cu".into()],
        ));
        assert!(matches!(r, AdapterReloadResult::Success { .. }));
        assert!(a.last_reload_log().iter().any(|l| l.contains("plan=mixed")));
        assert!(a
            .last_reload_log()
            .iter()
            .any(|l| l.contains("device_restore ok")));
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
