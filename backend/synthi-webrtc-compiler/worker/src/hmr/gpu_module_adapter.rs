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
use std::ffi::c_void;
use std::fs;
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::adapter_trait::{
    Adapter, AdapterHealth, AdapterInfo, AdapterReloadRequest, AdapterReloadResult,
};
use crate::hmr::compile_manifest::{DeviceVendor, SnapshotMode};
use crate::hmr::device_snapshot::BufferRegistry;
use crate::hmr::gpu_driver_loader::{
    self, CuFunction, DriverLoadError, GpuDriverHandle, GpuDriverSymbolTable,
};
use crate::hmr::gpu_module_manager::{GpuModuleManager, ModuleManagerError};
use crate::hmr::gpu_reload_orchestrator::{
    plan_gpu_reload, GpuReloadConfig, GpuReloadPlan, GpuSwapInputs,
};
use crate::hmr::gpu_stream_drain::{drain_context, DrainOutcome, DrainScope};
use crate::runtime::gpu_runtime_boundary::{
    clear_launch_dispatcher, install_launch_dispatcher, managed_buffers_snapshot,
    GpuLaunchDispatcher, GpuLaunchRequest,
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
}

impl Default for GpuModuleAdapterConfig {
    fn default() -> Self {
        Self {
            vendor: GpuVendor::Cuda,
            max_module_bytes: 128 * 1024 * 1024, // 128 MB
            drain_timeout_ms: 2_000,
            allow_snapshot_downgrade: true,
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
            kernel_table: HashMap::new(),
            health: AdapterHealth::Unknown,
            driver: None,
            module_manager: GpuModuleManager::new(),
            last_reload_log: Vec::new(),
            last_device_abi_version: None,
            last_driver_error: None,
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

    fn emit_runtime_ownership_report(
        &mut self,
        ownership: &DeviceReloadOwnership,
        artifact: &str,
    ) {
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
            "swap_count".into(),
            self.module_manager.swap_count().to_string(),
        );
        if let Some(primary) = self.module_manager.primary() {
            extra.insert("active_module_bytes".into(), primary.blob_bytes.to_string());
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
        self.kernel_table.clear();
        self.driver = None;
        self.module_manager = GpuModuleManager::new();
        clear_launch_dispatcher();
        self.last_reload_log.clear();
        self.last_device_abi_version = None;
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
        if artifact.is_empty() {
            return AdapterReloadResult::Unsupported {
                reason: "gpu_module_adapter missing device artifact path; cold reload required"
                    .into(),
            };
        }

        let blob = match fs::read(artifact) {
            Ok(bytes) => bytes,
            Err(e) => {
                self.health = AdapterHealth::Degraded;
                return AdapterReloadResult::Failed {
                    error: format!("failed to read GPU sidecar artifact {artifact:?}: {e}"),
                    recoverable: true,
                };
            }
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

        let first_device_load =
            self.active_module_handle.is_none() && self.module_manager.primary().is_none();
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
        let drain = if first_device_load {
            DrainOutcome::Synced {
                scope: DrainScope::Context,
                elapsed_ms: 0,
                budget_ms: self.config.drain_timeout_ms,
            }
        } else {
            drain_context(&symbols, self.config.drain_timeout_ms)
        };
        if !drain.is_synced() {
            let timed_out = matches!(drain, DrainOutcome::TimedOut { .. });
            self.emit_report(GpuSwapInputs {
                plan,
                reason: drain.short_label().into(),
                streams_synced: 0,
                force_drain_timeout: timed_out,
                snapshot_bytes,
                snapshot_ms: drain.elapsed_ms(),
                dirty_buffers,
                expected_kernel_hashes: req.build_manifest.exported_symbols.len() as u32,
                matched_kernel_hashes: 0,
            });
            self.health = AdapterHealth::Faulted;
            self.phase = GpuPhase::Faulted;
            return AdapterReloadResult::Failed {
                error: format!("GPU drain failed: {:?}", drain),
                recoverable: !timed_out,
            };
        }

        let partial_device_reload = req
            .build_manifest
            .capabilities
            .iter()
            .any(|capability| capability == "gpu_sidecar_partial_module");
        let load_result = (|| -> Result<DeviceReloadOwnership, String> {
            if partial_device_reload && first_device_load {
                return Err(
                    "partial GPU sidecar reload requires an existing full device module".into(),
                );
            }
            if partial_device_reload && req.build_manifest.exported_symbols.is_empty() {
                return Err("partial GPU sidecar reload has no target symbols".into());
            }
            let previous_table = self.module_manager.kernel_table().clone();
            if self.config.vendor == GpuVendor::Rocm {
                self.module_manager
                    .load_standby_from_file(&symbols, artifact, blob.len())
                    .map_err(Self::module_manager_error)?;
            } else {
                self.module_manager
                    .load_standby(&symbols, &blob)
                    .map_err(Self::module_manager_error)?;
            }
            self.module_manager
                .resolve_kernels(&symbols, &req.build_manifest.exported_symbols)
                .map_err(Self::module_manager_error)?;
            let expected_symbols = sorted_unique_symbols(&req.build_manifest.exported_symbols);
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
                    .merge_standby_partial(previous_table, &req.build_manifest.exported_symbols)
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
            for retired in retired {
                self.module_manager
                    .unload_retired(&symbols, retired)
                    .map_err(Self::module_manager_error)?;
            }
            Ok(DeviceReloadOwnership {
                partial_reload: partial_device_reload,
                expected_symbols,
                touched_symbols,
                retired_module_count,
                replaced_primary,
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
                install_launch_dispatcher(Arc::new(DriverLaunchDispatcher {
                    symbols,
                    kernels: self.kernel_table.clone(),
                }));
                self.emit_report(GpuSwapInputs {
                    plan,
                    reason: if partial_device_reload {
                        "device-partial-file-only-edit".into()
                    } else {
                        "device-file-only-edit".into()
                    },
                    streams_synced: 1,
                    force_drain_timeout: false,
                    snapshot_bytes,
                    snapshot_ms: started.elapsed().as_millis() as u64,
                    dirty_buffers,
                    expected_kernel_hashes: ownership.expected_symbols.len() as u32,
                    matched_kernel_hashes: ownership.touched_symbols.len() as u32,
                });
                self.emit_runtime_ownership_report(&ownership, artifact);
                self.phase = GpuPhase::Ready;
                self.health = AdapterHealth::Healthy;
                self.remember_device_abi(req);
                AdapterReloadResult::Success {
                    reload_ms: started.elapsed().as_millis() as u64,
                    state_preserved: req.preserve_state,
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
    use crate::hmr::adapter_trait::AdapterReloadRequest;
    use crate::hmr::build_manifest::BuildManifest;
    use crate::hmr::gpu_driver_loader::{
        CuContext, CuDevicePtr, CuFunction, CuModule, CuResult, CuStream,
    };
    use crate::runtime::gpu_runtime_boundary::{
        reset_for_test, synthi_gpu_launch_raw, synthi_gpu_register_buffer,
        test_guard_for_test as runtime_boundary_test_guard,
    };
    use std::ffi::{c_void, CString};
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn dummy_request() -> AdapterReloadRequest {
        AdapterReloadRequest {
            reload_id: "test".into(),
            module_id: "device".into(),
            changed_files: vec!["device.cu".into()],
            build_manifest: BuildManifest::for_language("test-preview", "cuda"),
            preserve_state: true,
            timeout_ms: 5_000,
        }
    }

    static NEXT_HANDLE: AtomicUsize = AtomicUsize::new(0x1000);
    static LAUNCH_CALLS: AtomicUsize = AtomicUsize::new(0);
    static LAST_LAUNCH_GRID_X: AtomicUsize = AtomicUsize::new(0);
    static LAST_LAUNCH_BLOCK_X: AtomicUsize = AtomicUsize::new(0);
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
        0
    }

    unsafe extern "C" fn err_ctx_synchronize() -> CuResult {
        700
    }

    unsafe extern "C" fn ok_stream_synchronize(_stream: CuStream) -> CuResult {
        0
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

    fn stub_symbols() -> GpuDriverSymbolTable {
        GpuDriverSymbolTable {
            cu_init: ok_init,
            cu_device_get: ok_device_get,
            cu_ctx_get_current: ok_ctx_get_current,
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
        }
    }

    fn drain_error_symbols() -> GpuDriverSymbolTable {
        GpuDriverSymbolTable {
            cu_ctx_synchronize: err_ctx_synchronize,
            ..stub_symbols()
        }
    }

    fn adapter_with_symbols(symbols: GpuDriverSymbolTable) -> GpuModuleAdapter {
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
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
        let mut manifest =
            BuildManifest::for_language("test-preview", "cuda").with_artifact(path, "test-hash");
        manifest.abi_version = abi_version.to_string();
        manifest.exported_symbols = vec!["vec_add".into()];
        AdapterReloadRequest {
            reload_id: "test".into(),
            module_id: "device".into(),
            changed_files,
            build_manifest: manifest,
            preserve_state: true,
            timeout_ms: 5_000,
        }
    }

    #[test]
    fn defaults_target_cuda() {
        let cfg = GpuModuleAdapterConfig::default();
        assert_eq!(cfg.vendor, GpuVendor::Cuda);
        assert_eq!(cfg.drain_timeout_ms, 2_000);
        assert!(cfg.allow_snapshot_downgrade);
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
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        a.initialize().unwrap();
        a.kernel_table.insert("vec_add".into(), 0xdead_beef);
        a.active_module_handle = Some(0x1234_5678);
        a.last_device_abi_version = Some("sig-v1".into());
        assert!(a.shutdown().is_ok());
        assert!(a.active_module_handle.is_none());
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
    fn phase3_reload_reports_abi_breaking_when_kernel_signature_changes() {
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
    fn runtime_ownership_reports_resolved_unique_symbols() {
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
        assert!(matches!(a.reload(&req), AdapterReloadResult::Success { .. }));

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
