// ============================================================
// GPU MODULE ADAPTER (Phase 1 scaffold)
// ============================================================
//
// Spec: docs/GPU_HMR_ULTRAPLAN.md §5.3 / §5.4. This is the
// device-side analogue of `dynlib_adapter.rs` — it implements the
// `Adapter` trait for the CUDA / ROCm module families. Where the
// dynlib adapter does `dlopen` / `dlclose` on a host `.so`, the GPU
// module adapter does `cuModuleLoadData` / `cuModuleUnload` (HIP
// equivalents on ROCm) on a sidecar cubin / hsaco.
//
// Phase 1 scope (this file):
//
//   • Strongly-typed scaffold types — `GpuVendor`, `GpuModuleAdapter`,
//     `GpuModuleAdapterConfig`.
//   • `Adapter` trait implementation, returning `Unsupported` from
//     `reload()` and empty payloads from `snapshot_state` /
//     `restore_state`.
//   • Driver-API symbol *names* defined as constants so the Phase 2
//     dlsym pass (in `device_loader.rs`) has a single source of
//     truth.
//   • Feature-gated by `gpu-hmr`. With the feature off, the module
//     compiles to an empty body so worker builds on hosts without
//     CUDA / ROCm continue to work unchanged.
//
// Phase 2 will add (NOT in this commit):
//
//   • Real `cuModuleLoadData` / `cuModuleUnload` dlsym + invocation.
//   • Two-slot module manager (mirrors `slot_manager.rs::LibSlot`).
//   • Stream drain, `cuCtxSynchronize`, kernel launch table rewrite.
//   • `device_save` / `device_restore` integration with
//     `device_snapshot.rs` (Tier-B userspace path).
//
// Phase 3+ extends to driver checkpoint snapshot (Tier A) and the
// no-shim healer integration. None of those land here.

#![cfg(feature = "gpu-hmr")]

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::adapter_trait::{
    Adapter, AdapterHealth, AdapterInfo, AdapterReloadRequest, AdapterReloadResult,
};
use crate::hmr::compile_manifest::DeviceVendor;

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
            Self::Rocm => "hipModuleLoadData",
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

// ── The adapter ─────────────────────────────────────────────

/// Phase-1 scaffold. Holds enough state to satisfy the `Adapter`
/// trait but does not yet call into the driver. Phase 2 will replace
/// `Unsupported` reload results with the real two-slot swap.
pub struct GpuModuleAdapter {
    config: GpuModuleAdapterConfig,
    phase: GpuPhase,
    /// Reload counter — incremented every time `reload()` is called,
    /// even when it returns Unsupported. Helps Phase 1 telemetry
    /// distinguish a flat-lined adapter (never called) from one that
    /// keeps refusing.
    reload_count: u64,
    /// Address of the currently-loaded module, if any. `u64` rather
    /// than `*mut c_void` so `GpuModuleAdapter: Send` falls out for
    /// free — the actual pointer crossing is a Phase 2 concern.
    active_module_handle: Option<u64>,
    /// Live kernel name → CUfunction-handle-as-u64 map. Empty in
    /// Phase 1; populated when Phase 2 calls `cuModuleGetFunction`
    /// for every kernel in the manifest right after a successful
    /// swap.
    kernel_table: HashMap<String, u64>,
    /// Health line surfaced to the planner. Phase 1 reports `Unknown`
    /// until the device-side probe (Phase 2) wires up.
    health: AdapterHealth,
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

    /// Phase 1 introspection — returns the set of driver-API symbols
    /// the Phase 2 dlsym pass will resolve, in the order they will be
    /// resolved. Exposed so the adapter test can prove the table is
    /// complete without poking private state.
    pub fn required_driver_symbols(&self) -> Vec<&'static str> {
        let v = self.config.vendor;
        vec![
            v.module_load_symbol(),
            v.module_unload_symbol(),
            v.module_get_function_symbol(),
            v.ctx_synchronize_symbol(),
            v.stream_synchronize_symbol(),
        ]
    }
}

impl Adapter for GpuModuleAdapter {
    fn info(&self) -> AdapterInfo {
        let mut extra = HashMap::new();
        extra.insert("vendor".into(), self.config.vendor.as_str().into());
        extra.insert("driver_library".into(), self.config.vendor.driver_library().into());
        extra.insert("phase".into(), format!("{:?}", self.phase));
        extra.insert("reload_count".into(), self.reload_count.to_string());
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
        // Phase 2 will:
        //   1. dlopen self.config.vendor.driver_library()
        //   2. dlsym every required_driver_symbols() entry
        //   3. cuInit(0) + cuCtxGetCurrent
        // For Phase 1 we just transition to Ready.
        self.phase = GpuPhase::Ready;
        self.health = AdapterHealth::Healthy;
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), String> {
        // Phase 2 will cuModuleUnload any active handle and dlclose
        // the driver library. Phase 1: drop handles + flag the phase.
        self.active_module_handle = None;
        self.kernel_table.clear();
        self.phase = GpuPhase::ShutDown;
        self.health = AdapterHealth::Unknown;
        Ok(())
    }

    fn reload(&mut self, _req: &AdapterReloadRequest) -> AdapterReloadResult {
        self.reload_count += 1;
        if self.phase == GpuPhase::Uninitialized || self.phase == GpuPhase::ShutDown {
            return AdapterReloadResult::Failed {
                error: format!("GpuModuleAdapter not initialized (phase={:?})", self.phase),
                recoverable: false,
            };
        }
        // The driver-side swap doesn't land until Phase 2. Surfacing
        // Unsupported lets the planner fall through to the cold path
        // until then — exactly the behavior the harness expects from
        // a pre-Phase-2 worker per §12.4.
        AdapterReloadResult::Unsupported {
            reason: "gpu_module_adapter Phase 1 scaffold — driver swap not yet implemented".into(),
        }
    }

    fn snapshot_state(&self) -> Result<Vec<u8>, String> {
        // Phase 2 will marshal DeviceStateSnapshot here. Empty Vec
        // signals "no device state captured" which is the honest
        // answer today.
        Ok(Vec::new())
    }

    fn restore_state(&mut self, data: &[u8]) -> Result<(), String> {
        if !data.is_empty() {
            return Err(format!(
                "GpuModuleAdapter::restore_state got {} bytes but Phase 1 scaffold only accepts empty payload",
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
        assert_eq!(info.extra.get("driver_library").map(|s| s.as_str()), Some("libcuda.so.1"));
    }

    #[test]
    fn info_reports_rocm_metadata() {
        let cfg = GpuModuleAdapterConfig { vendor: GpuVendor::Rocm, ..Default::default() };
        let a = GpuModuleAdapter::new(cfg);
        let info = a.info();
        assert_eq!(info.name, "gpu_module_rocm");
        assert_eq!(info.extra.get("driver_library").map(|s| s.as_str()), Some("libamdhip64.so"));
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
        assert!(syms.contains(&"cuModuleLoadData"));
        assert!(syms.contains(&"cuModuleUnload"));
        assert!(syms.contains(&"cuModuleGetFunction"));
        assert!(syms.contains(&"cuCtxSynchronize"));
        assert!(syms.contains(&"cuStreamSynchronize"));
        assert_eq!(syms.len(), 5);
    }

    #[test]
    fn required_symbol_table_is_complete_rocm() {
        let cfg = GpuModuleAdapterConfig { vendor: GpuVendor::Rocm, ..Default::default() };
        let a = GpuModuleAdapter::new(cfg);
        let syms = a.required_driver_symbols();
        assert!(syms.contains(&"hipModuleLoadData"));
        assert!(syms.contains(&"hipModuleUnload"));
        assert!(syms.contains(&"hipModuleGetFunction"));
        assert!(syms.contains(&"hipDeviceSynchronize"));
        assert!(syms.contains(&"hipStreamSynchronize"));
        assert_eq!(syms.len(), 5);
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
        assert!(a.shutdown().is_ok());
        assert!(a.active_module_handle.is_none());
        assert!(a.kernel_table.is_empty());
    }

    #[test]
    fn reload_unsupported_phase1_post_init() {
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        a.initialize().unwrap();
        let r = a.reload(&dummy_request());
        match r {
            AdapterReloadResult::Unsupported { ref reason } => {
                assert!(reason.contains("Phase 1"));
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
            AdapterReloadResult::Failed { ref error, recoverable } => {
                assert!(error.contains("not initialized"));
                assert!(!recoverable);
            }
            other => panic!("expected Failed, got {:?}", other),
        }
    }

    #[test]
    fn snapshot_state_empty_phase1() {
        let a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        let blob = a.snapshot_state().expect("snapshot ok");
        assert!(blob.is_empty(), "Phase 1 must report empty snapshot");
    }

    #[test]
    fn restore_state_rejects_nonempty_phase1() {
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        assert!(a.restore_state(&[]).is_ok());
        let err = a.restore_state(&[0x42, 0x42]).unwrap_err();
        assert!(err.contains("Phase 1"));
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
        assert!(matches!(r, AdapterReloadResult::Unsupported { .. }));
    }
}
