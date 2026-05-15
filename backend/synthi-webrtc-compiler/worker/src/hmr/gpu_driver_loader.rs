// ============================================================
// GPU DRIVER LOADER (Phase 2 scaffold)
// ============================================================
//
// Spec: docs/GPU_HMR_ULTRAPLAN.md §5.3.
//
// Phase 1 declared the driver-API symbol *names* on
// `GpuModuleAdapter::required_driver_symbols`. Phase 2 actually
// resolves them: dlopen the vendor library (`libcuda.so.1` /
// `libamdhip64.so`) and `dlsym` every entry into a typed
// `GpuDriverSymbolTable`.
//
// The loader is the only Phase-2 module that touches the real
// driver. Everything downstream (`gpu_module_manager`,
// `gpu_shadow_arena`, `gpu_stream_drain`) calls through the
// symbol table so they stay unit-testable without a GPU.
//
// Phase 2 scope (this file):
//
//   • `try_load(vendor)` — fail-fast loader returning a
//     `GpuDriverHandle` on success or `DriverLoadError` on
//     missing library / missing symbol.
//   • `probe(vendor)` — non-failing check returning a
//     `DriverProbe` enum the planner can branch on at startup.
//   • `GpuDriverSymbolTable` — typed function pointers for the
//     driver symbols listed in §5.3.
//   • `Send + Sync` impl gated by the fact that `libloading`
//     yields `Library: Send + Sync` already.
//
// Phase 3 will replace `try_load` with a richer
// `Capabilities::detect` that reports CUDA driver version,
// compute capability, and Tier-A availability.
//
// Feature-gated by `gpu-hmr`. With the feature off the module
// compiles to an empty body.

#![cfg(feature = "gpu-hmr")]

use std::ffi::c_void;
use std::sync::Arc;

use crate::hmr::gpu_module_adapter::GpuVendor;

// ── Function-pointer type aliases ───────────────────────────
//
// The CUDA Driver API and the HIP runtime API mirror each other
// closely enough that the same type aliases work for both
// vendors. The driver functions all return a signed integer
// (`CUresult` / `hipError_t`); we treat that as `i32`. Handles
// (`CUmodule`, `CUfunction`, `CUstream`, `CUcontext`, `CUdeviceptr`)
// are all pointer-sized — we use `*mut c_void` for opaque
// handles and `u64` for `CUdeviceptr` (the driver API defines it
// as `unsigned long long`).
//
// Phase 3 may introduce a vendor-specific specialization if HIP
// diverges (e.g. hipMemcpyDtoD takes a stream argument that
// cuMemcpyDtoD does not in some CUDA versions). For Phase 2 the
// shared signatures hold.

pub type CuResult = i32;
pub type CuDevicePtr = u64;
pub type CuStream = *mut c_void;
pub type CuModule = *mut c_void;
pub type CuFunction = *mut c_void;
pub type CuContext = *mut c_void;
pub type CuKernelParams = *mut *mut c_void;

pub const REQUIRED_SYMBOL_COUNT: usize = 12;

pub type CuInitFn = unsafe extern "C" fn(flags: u32) -> CuResult;
pub type CuDeviceGetFn = unsafe extern "C" fn(device: *mut i32, ordinal: i32) -> CuResult;
pub type CuCtxGetCurrentFn = unsafe extern "C" fn(ctx: *mut CuContext) -> CuResult;

pub type CuModuleLoadDataFn =
    unsafe extern "C" fn(module: *mut CuModule, image: *const c_void) -> CuResult;
pub type CuModuleUnloadFn = unsafe extern "C" fn(module: CuModule) -> CuResult;
pub type CuModuleGetFunctionFn =
    unsafe extern "C" fn(hfunc: *mut CuFunction, hmod: CuModule, name: *const u8) -> CuResult;
pub type CuLaunchKernelFn = unsafe extern "C" fn(
    f: CuFunction,
    grid_dim_x: u32,
    grid_dim_y: u32,
    grid_dim_z: u32,
    block_dim_x: u32,
    block_dim_y: u32,
    block_dim_z: u32,
    shared_mem_bytes: u32,
    stream: CuStream,
    kernel_params: CuKernelParams,
    extra: CuKernelParams,
) -> CuResult;

pub type CuCtxSynchronizeFn = unsafe extern "C" fn() -> CuResult;
pub type CuStreamSynchronizeFn = unsafe extern "C" fn(stream: CuStream) -> CuResult;

pub type CuMemAllocFn = unsafe extern "C" fn(dptr: *mut CuDevicePtr, bytes: usize) -> CuResult;
pub type CuMemFreeFn = unsafe extern "C" fn(dptr: CuDevicePtr) -> CuResult;
pub type CuMemcpyDtoDFn =
    unsafe extern "C" fn(dst: CuDevicePtr, src: CuDevicePtr, bytes: usize) -> CuResult;

// ── Symbol table ────────────────────────────────────────────

/// Resolved function pointers for one vendor. Phase 2 leaves all
/// fields non-optional — `try_load` either fills every slot or
/// returns an error. Future-proofs the swap path against a half-
/// loaded driver where some symbols missed.
#[derive(Clone, Copy)]
pub struct GpuDriverSymbolTable {
    pub cu_init: CuInitFn,
    pub cu_device_get: CuDeviceGetFn,
    pub cu_ctx_get_current: CuCtxGetCurrentFn,
    pub cu_module_load_data: CuModuleLoadDataFn,
    pub cu_module_unload: CuModuleUnloadFn,
    pub cu_module_get_function: CuModuleGetFunctionFn,
    pub cu_launch_kernel: CuLaunchKernelFn,
    pub cu_ctx_synchronize: CuCtxSynchronizeFn,
    pub cu_stream_synchronize: CuStreamSynchronizeFn,
    pub cu_mem_alloc: CuMemAllocFn,
    pub cu_mem_free: CuMemFreeFn,
    pub cu_memcpy_dtod: CuMemcpyDtoDFn,
}

/// The driver symbols the loader must resolve, in the order
/// they're resolved (so a partial-load error surfaces with a
/// deterministic "stopped at symbol N" message).
pub fn required_symbol_names(vendor: GpuVendor) -> [&'static str; REQUIRED_SYMBOL_COUNT] {
    match vendor {
        GpuVendor::Cuda => [
            "cuInit",
            "cuDeviceGet",
            "cuCtxGetCurrent",
            "cuModuleLoadData",
            "cuModuleUnload",
            "cuModuleGetFunction",
            "cuLaunchKernel",
            "cuCtxSynchronize",
            "cuStreamSynchronize",
            "cuMemAlloc_v2",
            "cuMemFree_v2",
            "cuMemcpyDtoD_v2",
        ],
        GpuVendor::Rocm => [
            "hipInit",
            "hipDeviceGet",
            "hipCtxGetCurrent",
            "hipModuleLoadData",
            "hipModuleUnload",
            "hipModuleGetFunction",
            "hipModuleLaunchKernel",
            "hipDeviceSynchronize",
            "hipStreamSynchronize",
            "hipMalloc",
            "hipFree",
            "hipMemcpyDtoD",
        ],
    }
}

// ── Errors ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriverLoadError {
    /// Library file could not be opened (driver not installed,
    /// LD_LIBRARY_PATH mis-set, or running inside a container
    /// without the GPU bind-mount).
    LibraryNotFound { library: String, detail: String },
    /// Library opened but a required symbol is missing. The driver
    /// is too old or the binary is the stub variant.
    SymbolMissing {
        library: String,
        symbol: String,
        detail: String,
    },
}

impl DriverLoadError {
    pub fn library(&self) -> &str {
        match self {
            Self::LibraryNotFound { library, .. } => library,
            Self::SymbolMissing { library, .. } => library,
        }
    }

    pub fn short_label(&self) -> &'static str {
        match self {
            Self::LibraryNotFound { .. } => "library_not_found",
            Self::SymbolMissing { .. } => "symbol_missing",
        }
    }
}

impl std::fmt::Display for DriverLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LibraryNotFound { library, detail } => {
                write!(f, "driver library {library:?} not found: {detail}")
            }
            Self::SymbolMissing {
                library,
                symbol,
                detail,
            } => {
                write!(f, "symbol {symbol:?} missing from {library:?}: {detail}")
            }
        }
    }
}

/// Non-failing startup probe. Surfaces enough state for the
/// planner to log a single line and decide whether to enable
/// GPU-HMR or fall through to cold restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriverProbe {
    /// `try_load` succeeded.
    Loaded {
        library: String,
        symbol_count: usize,
    },
    /// Driver library / symbols are missing. Carries the underlying
    /// error so the planner can include `short_label` in its log.
    Unavailable(DriverLoadError),
}

impl DriverProbe {
    pub fn is_available(&self) -> bool {
        matches!(self, Self::Loaded { .. })
    }
}

// ── Handle ──────────────────────────────────────────────────

/// Loaded driver handle. Holds the `Library` to keep dlopen alive
/// for the lifetime of the handle (drop = dlclose). Wrapped in
/// `Arc` so the adapter, the module manager and the shadow arena
/// can all share the same resolved symbol table without each
/// dlopen'ing it again.
pub struct GpuDriverHandle {
    library: libloading::Library,
    library_path: String,
    vendor: GpuVendor,
    symbols: GpuDriverSymbolTable,
}

impl GpuDriverHandle {
    pub fn vendor(&self) -> GpuVendor {
        self.vendor
    }

    pub fn library_path(&self) -> &str {
        &self.library_path
    }

    pub fn symbols(&self) -> &GpuDriverSymbolTable {
        &self.symbols
    }

    /// Compile-time-checked Send+Sync: `libloading::Library` is
    /// already Send+Sync on all supported platforms, and the
    /// symbol table holds bare function pointers, which are
    /// trivially Send+Sync. The wrapped `_library` field forces
    /// rustc to verify the bound stays satisfied.
    pub fn shared(self) -> Arc<Self> {
        Arc::new(self)
    }
}

impl std::fmt::Debug for GpuDriverHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GpuDriverHandle")
            .field("vendor", &self.vendor)
            .field("library_path", &self.library_path)
            .field("symbol_count", &REQUIRED_SYMBOL_COUNT)
            .finish()
    }
}

// ── Loader ──────────────────────────────────────────────────

/// Attempts to dlopen the vendor driver and resolve all driver
/// symbols. Fail-fast: the first missing symbol terminates the
/// resolve loop and returns `SymbolMissing`. The caller decides
/// whether to fall back to cold restart.
pub fn try_load(vendor: GpuVendor) -> Result<GpuDriverHandle, DriverLoadError> {
    let library_path = vendor.driver_library().to_string();
    // SAFETY: dlopen is inherently unsafe — calling code accepts
    // that the OS will execute arbitrary `_init`-section code in
    // the loaded library. The Phase 2 contract is that the vendor
    // library is trusted; this loader doesn't open user-supplied
    // paths.
    let library = unsafe { libloading::Library::new(&library_path) }.map_err(|e| {
        DriverLoadError::LibraryNotFound {
            library: library_path.clone(),
            detail: e.to_string(),
        }
    })?;

    let names = required_symbol_names(vendor);
    // Resolve each symbol. The block keeps the unsafe surface
    // tight; if any lookup fails we record which symbol it was.
    let symbols = unsafe { resolve_symbols(&library, &library_path, &names) }?;

    Ok(GpuDriverHandle {
        library,
        library_path,
        vendor,
        symbols,
    })
}

/// Non-failing probe. Calls `try_load` and folds the result into
/// the `DriverProbe` enum so callers can log + branch without
/// pattern-matching error types.
pub fn probe(vendor: GpuVendor) -> DriverProbe {
    match try_load(vendor) {
        Ok(h) => DriverProbe::Loaded {
            library: h.library_path().to_string(),
            symbol_count: REQUIRED_SYMBOL_COUNT,
        },
        Err(e) => DriverProbe::Unavailable(e),
    }
}

// SAFETY contract for `resolve_symbols`:
//   • `library` must remain alive for the lifetime of the
//     returned table — enforced by `GpuDriverHandle::library`
//     owning the `Library`.
//   • `names` must point at the actual driver symbols for the
//     given vendor. `required_symbol_names` is the single source.
unsafe fn resolve_symbols(
    library: &libloading::Library,
    library_path: &str,
    names: &[&'static str; REQUIRED_SYMBOL_COUNT],
) -> Result<GpuDriverSymbolTable, DriverLoadError> {
    macro_rules! fetch {
        ($idx:expr, $ty:ty) => {{
            let sym_name = names[$idx];
            let sym: libloading::Symbol<$ty> =
                library
                    .get(sym_name.as_bytes())
                    .map_err(|e| DriverLoadError::SymbolMissing {
                        library: library_path.to_string(),
                        symbol: sym_name.to_string(),
                        detail: e.to_string(),
                    })?;
            *sym
        }};
    }

    Ok(GpuDriverSymbolTable {
        cu_init: fetch!(0, CuInitFn),
        cu_device_get: fetch!(1, CuDeviceGetFn),
        cu_ctx_get_current: fetch!(2, CuCtxGetCurrentFn),
        cu_module_load_data: fetch!(3, CuModuleLoadDataFn),
        cu_module_unload: fetch!(4, CuModuleUnloadFn),
        cu_module_get_function: fetch!(5, CuModuleGetFunctionFn),
        cu_launch_kernel: fetch!(6, CuLaunchKernelFn),
        cu_ctx_synchronize: fetch!(7, CuCtxSynchronizeFn),
        cu_stream_synchronize: fetch!(8, CuStreamSynchronizeFn),
        cu_mem_alloc: fetch!(9, CuMemAllocFn),
        cu_mem_free: fetch!(10, CuMemFreeFn),
        cu_memcpy_dtod: fetch!(11, CuMemcpyDtoDFn),
    })
}

// ── Tests ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_symbol_count_is_pinned_for_both_vendors() {
        assert_eq!(
            required_symbol_names(GpuVendor::Cuda).len(),
            REQUIRED_SYMBOL_COUNT
        );
        assert_eq!(
            required_symbol_names(GpuVendor::Rocm).len(),
            REQUIRED_SYMBOL_COUNT
        );
    }

    #[test]
    fn cuda_symbol_table_uses_versioned_mem_symbols() {
        // The CUDA driver API uses _v2 suffix on the memory
        // functions; mis-resolving these is a classic
        // copy-paste bug. Pin the names in a test.
        let names = required_symbol_names(GpuVendor::Cuda);
        assert!(names.contains(&"cuMemAlloc_v2"));
        assert!(names.contains(&"cuMemFree_v2"));
        assert!(names.contains(&"cuMemcpyDtoD_v2"));
        assert!(names.contains(&"cuLaunchKernel"));
    }

    #[test]
    fn rocm_symbol_table_uses_plain_hip_names() {
        // HIP keeps unversioned names. Asserting both vendors
        // forces a deliberate update if upstream renames.
        let names = required_symbol_names(GpuVendor::Rocm);
        assert!(names.contains(&"hipMalloc"));
        assert!(names.contains(&"hipFree"));
        assert!(names.contains(&"hipMemcpyDtoD"));
        assert!(names.contains(&"hipModuleLaunchKernel"));
    }

    #[test]
    fn cuda_symbol_table_first_three_are_init_path() {
        // The init triplet must resolve before anything else;
        // hard-coding the order means a partial-load error
        // points at the correct missing symbol.
        let names = required_symbol_names(GpuVendor::Cuda);
        assert_eq!(names[0], "cuInit");
        assert_eq!(names[1], "cuDeviceGet");
        assert_eq!(names[2], "cuCtxGetCurrent");
    }

    #[test]
    fn driver_load_error_short_labels() {
        let a = DriverLoadError::LibraryNotFound {
            library: "libcuda.so.1".into(),
            detail: "no such file".into(),
        };
        let b = DriverLoadError::SymbolMissing {
            library: "libcuda.so.1".into(),
            symbol: "cuModuleLoadData".into(),
            detail: "undefined symbol".into(),
        };
        assert_eq!(a.short_label(), "library_not_found");
        assert_eq!(b.short_label(), "symbol_missing");
        assert_eq!(a.library(), "libcuda.so.1");
        assert_eq!(b.library(), "libcuda.so.1");
    }

    #[test]
    fn driver_load_error_display_is_useful() {
        let e = DriverLoadError::LibraryNotFound {
            library: "libcuda.so.1".into(),
            detail: "no such file".into(),
        };
        let msg = format!("{e}");
        assert!(msg.contains("libcuda.so.1"));
        assert!(msg.contains("no such file"));
    }

    #[test]
    fn probe_returns_unavailable_on_missing_driver() {
        // CI runs without an NVIDIA driver installed. The probe
        // path must surface that cleanly — the worker uses this
        // as the "fall through to cold path" signal.
        let p = probe(GpuVendor::Cuda);
        if let DriverProbe::Loaded { symbol_count, .. } = &p {
            // Local dev box happens to have the driver. Still
            // assert the contract holds.
            assert_eq!(*symbol_count, REQUIRED_SYMBOL_COUNT);
            assert!(p.is_available());
        } else if let DriverProbe::Unavailable(e) = &p {
            // Library not found OR symbol_missing both
            // count as unavailable. Make sure we got one
            // of those.
            assert!(matches!(
                e.short_label(),
                "library_not_found" | "symbol_missing"
            ));
            assert!(!p.is_available());
        }
    }

    #[test]
    fn try_load_rocm_is_unavailable_in_ci() {
        // Same shape on the HIP side.
        let r = try_load(GpuVendor::Rocm);
        if let Err(e) = r {
            assert!(matches!(
                e.short_label(),
                "library_not_found" | "symbol_missing"
            ));
            assert_eq!(e.library(), "libamdhip64.so");
        }
    }

    #[test]
    fn handle_is_send_and_sync() {
        // Compile-time check. The adapter holds the handle in an
        // Arc + the planner expects `Box<dyn Adapter>`, so the
        // Send+Sync bound must hold.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<GpuDriverHandle>();
        assert_send_sync::<GpuDriverSymbolTable>();
        assert_send_sync::<Arc<GpuDriverHandle>>();
    }

    #[test]
    fn driver_probe_is_available_reflects_variant() {
        let unavailable = DriverProbe::Unavailable(DriverLoadError::LibraryNotFound {
            library: "x".into(),
            detail: "y".into(),
        });
        assert!(!unavailable.is_available());
        let loaded = DriverProbe::Loaded {
            library: "libcuda.so.1".into(),
            symbol_count: REQUIRED_SYMBOL_COUNT,
        };
        assert!(loaded.is_available());
    }
}
