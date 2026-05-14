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
//   Phase 3 (not in this commit)
//     • Two-slot module manager wired through `reload()`:
//       cuModuleLoadData → resolve_kernels → drain → swap →
//       unload-retired.
//     • Shadow arena + dirty-bit shim integrated into
//       `snapshot_state` / `restore_state`.
//     • Tier-A driver checkpoint path.
//
// Feature-gated by `gpu-hmr`. With the feature off the module
// compiles to an empty body so worker builds on hosts without
// CUDA / ROCm continue to work unchanged.

#![cfg(feature = "gpu-hmr")]

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::adapter_trait::{
    Adapter, AdapterHealth, AdapterInfo, AdapterReloadRequest, AdapterReloadResult,
};
use crate::hmr::compile_manifest::DeviceVendor;
use crate::hmr::gpu_driver_loader::{self, DriverLoadError, GpuDriverHandle};

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

/// Phase-2 scaffold. `initialize()` now attempts a real driver
/// load via `gpu_driver_loader::try_load`. On a host without the
/// vendor driver the adapter still goes Ready (state-machine
/// invariant for the planner) but `driver_state` reports
/// `unavailable` so the planner knows to fall through to cold
/// restart. The full swap path lands in Phase 3.
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
    /// Last driver-load error, if `try_load` failed. Surfaced on
    /// `info().extra["driver_error"]` for telemetry. Cleared on
    /// the next successful load attempt.
    last_driver_error: Option<DriverLoadError>,
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
            last_driver_error: None,
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
        self.driver.is_some()
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
        extra.insert("driver_state".into(), self.driver_state_label().into());
        if let Some(err) = &self.last_driver_error {
            extra.insert("driver_error".into(), err.short_label().into());
        }
        if let Some(handle) = &self.driver {
            extra.insert("driver_path".into(), handle.library_path().into());
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
        // The driver-side swap doesn't land until Phase 3. The reason
        // string carries the driver state so the planner can branch:
        //   • driver=loaded → Phase 3 will wire the two-slot manager.
        //   • driver=unavailable → cold path is the only option.
        let reason = match self.driver_state_label() {
            "loaded" => "gpu_module_adapter Phase 2 — driver loaded, swap path lands in Phase 3"
                .to_string(),
            "unavailable" => format!(
                "gpu_module_adapter Phase 2 — driver unavailable ({}); falling through to cold path",
                self.last_driver_error
                    .as_ref()
                    .map(|e| e.short_label())
                    .unwrap_or("unknown")
            ),
            _ => "gpu_module_adapter Phase 2 scaffold — driver state pending".to_string(),
        };
        AdapterReloadResult::Unsupported { reason }
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
                "GpuModuleAdapter::restore_state got {} bytes but Phase 2 scaffold only accepts empty payload",
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
    fn reload_unsupported_post_init() {
        let mut a = GpuModuleAdapter::new(GpuModuleAdapterConfig::default());
        a.initialize().unwrap();
        let r = a.reload(&dummy_request());
        match r {
            AdapterReloadResult::Unsupported { ref reason } => {
                // Reason text changes per phase; the contract is
                // that it identifies the phase + driver state so
                // the planner can branch.
                assert!(
                    reason.contains("Phase"),
                    "reason must identify phase: {reason}"
                );
                assert!(
                    reason.contains("loaded")
                        || reason.contains("unavailable")
                        || reason.contains("pending"),
                    "reason must include driver state: {reason}"
                );
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
        assert!(err.contains("Phase"));
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
        assert_eq!(pre.extra.get("driver_state").map(|s| s.as_str()), Some("pending"));
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
                assert!(
                    reason.contains(label),
                    "reload reason {reason:?} must mention driver state {label:?}"
                );
            }
            other => panic!("expected Unsupported, got {:?}", other),
        }
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
