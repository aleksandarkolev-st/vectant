// ============================================================
// GPU MODULE MANAGER (Phase 2 scaffold)
// ============================================================
//
// Spec: docs/GPU_HMR_ULTRAPLAN.md §5.4 + §5.5.
//
// The dynlib reload path keeps two slots — `primary` (live) and
// `standby` (next). On reload the orchestrator builds into
// standby, drains the primary, atomic-swaps the pointer, and
// unloads the retired image. This file is the GPU analogue.
//
// Phase 2 contract:
//
//   • `GpuModuleManager` owns two slots; the active one is the
//     handle the kernel launch table dereferences against.
//   • `load_standby(blob)` invokes `cuModuleLoadData` through the
//     driver symbol table, parks the handle in `standby`.
//   • `resolve_kernels(name_list)` runs `cuModuleGetFunction`
//     across the new module — populates a `KernelTable` keyed
//     by mangled symbol name.
//   • `swap()` promotes standby to primary; returns the retired
//     handle so the caller can `unload_retired(driver, handle)`
//     after the drain.
//   • Defensive: if the driver returns non-zero, the manager
//     records the error code on `last_error` and refuses to
//     swap until the slot is cleared.
//
// All driver calls go through `GpuDriverHandle`. Tests can swap
// in stub function pointers via `with_test_table(table, f)` to
// exercise the manager without a real GPU.
//
// Feature-gated by `gpu-hmr`.

#![cfg(feature = "gpu-hmr")]

use std::collections::HashMap;
use std::ffi::CString;
use std::path::Path;

use crate::hmr::gpu_driver_loader::{
    CuFunction, CuKernelParams, CuModule, CuResult, CuStream, GpuDriverSymbolTable,
};

// ── Slot record ─────────────────────────────────────────────

/// One loaded module image. `handle` is the raw `CUmodule`
/// pointer reinterpreted as `u64` so the struct stays Send + Sync
/// without an explicit unsafe impl. Conversion happens at the
/// `cuModuleUnload` boundary inside `unload_retired`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModuleSlot {
    pub handle: u64,
    pub blob_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PartialModuleSlot {
    slot: ModuleSlot,
    symbols: Vec<String>,
}

impl ModuleSlot {
    pub fn module_ptr(&self) -> CuModule {
        self.handle as CuModule
    }
}

/// Mangled-name → CUfunction map, populated by
/// `cuModuleGetFunction` after a successful load. Keeps the
/// launch table addressable without re-walking the module.
#[derive(Debug, Clone, Default)]
pub struct KernelTable {
    by_name: HashMap<String, u64>,
}

impl KernelTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.by_name.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_name.is_empty()
    }

    pub fn insert(&mut self, name: impl Into<String>, fn_handle: u64) {
        self.by_name.insert(name.into(), fn_handle);
    }

    pub fn get(&self, name: &str) -> Option<u64> {
        self.by_name.get(name).copied()
    }

    pub fn names(&self) -> impl Iterator<Item = &String> {
        self.by_name.keys()
    }

    pub fn clear(&mut self) {
        self.by_name.clear();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelResolution {
    pub logical_name: String,
    pub driver_name: String,
}

impl KernelResolution {
    pub fn identity(name: impl Into<String>) -> Self {
        let name = name.into();
        Self {
            logical_name: name.clone(),
            driver_name: name,
        }
    }
}

// ── Launch config ───────────────────────────────────────────

/// Driver-API launch dimensions for a resolved kernel. The first
/// runtime boundary version passes 1D launch sizes through the
/// C ABI, so this helper expands them into full x/y/z tuples.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KernelLaunchConfig {
    pub grid: (u32, u32, u32),
    pub block: (u32, u32, u32),
    pub shared_mem_bytes: u32,
    pub stream: CuStream,
}

impl KernelLaunchConfig {
    pub fn new(
        grid_size: usize,
        block_size: usize,
        shared_mem_bytes: usize,
        stream_token: usize,
    ) -> Self {
        Self {
            grid: (clamp_launch_dim(grid_size), 1, 1),
            block: (clamp_launch_dim(block_size), 1, 1),
            shared_mem_bytes: shared_mem_bytes.min(u32::MAX as usize) as u32,
            stream: stream_token as CuStream,
        }
    }
}

fn clamp_launch_dim(value: usize) -> u32 {
    value.max(1).min(u32::MAX as usize) as u32
}

// ── Errors ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModuleManagerError {
    /// Driver returned non-zero. `code` is `CUresult`; the caller
    /// looks it up against the cuda.h enum.
    DriverError { op: &'static str, code: CuResult },
    /// `load_standby` invoked while a standby is already loaded.
    /// The caller must `swap()` (or explicitly discard) the
    /// existing one first.
    StandbyOccupied,
    /// `swap()` called with no standby loaded.
    NoStandby,
    /// `launch_kernel` called before any module has been promoted.
    NoPrimary,
    /// `resolve_kernels` called before `load_standby`.
    NoTarget,
    /// `launch_kernel` named a kernel that has not been resolved
    /// against the primary module.
    UnknownKernel(String),
    /// Kernel name failed CString conversion (interior NUL).
    InvalidKernelName(String),
    /// Artifact path failed CString conversion (interior NUL).
    InvalidArtifactPath(String),
    /// Empty cubin/hsaco — refuse the load up-front.
    EmptyBlob,
}

impl ModuleManagerError {
    pub fn short_label(&self) -> &'static str {
        match self {
            Self::DriverError { .. } => "driver_error",
            Self::StandbyOccupied => "standby_occupied",
            Self::NoStandby => "no_standby",
            Self::NoPrimary => "no_primary",
            Self::NoTarget => "no_target",
            Self::UnknownKernel(_) => "unknown_kernel",
            Self::InvalidKernelName(_) => "invalid_kernel_name",
            Self::InvalidArtifactPath(_) => "invalid_artifact_path",
            Self::EmptyBlob => "empty_blob",
        }
    }
}

impl std::fmt::Display for ModuleManagerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DriverError { op, code } => write!(f, "driver op {op:?} returned {code}"),
            Self::StandbyOccupied => write!(f, "standby slot already holds a module"),
            Self::NoStandby => write!(f, "no standby module to swap"),
            Self::NoPrimary => write!(f, "no primary module loaded — call swap first"),
            Self::NoTarget => write!(f, "no module loaded — call load_standby first"),
            Self::UnknownKernel(s) => write!(f, "kernel {s:?} has not been resolved"),
            Self::InvalidKernelName(s) => write!(f, "kernel name {s:?} contains NUL"),
            Self::InvalidArtifactPath(s) => write!(f, "artifact path {s:?} contains NUL"),
            Self::EmptyBlob => write!(f, "empty cubin / hsaco blob"),
        }
    }
}

// ── The manager ─────────────────────────────────────────────

/// Two-slot module manager. The primary slot is what the launch
/// table dereferences against; the standby is the next image
/// loading or just-loaded. After a swap the old primary becomes
/// the retired handle the caller must unload.
#[derive(Debug, Default)]
pub struct GpuModuleManager {
    primary: Option<ModuleSlot>,
    standby: Option<ModuleSlot>,
    partials: Vec<PartialModuleSlot>,
    kernels: KernelTable,
    /// Last driver error, set whenever a call returned non-zero.
    /// Cleared when the offending slot is cleared.
    last_error: Option<ModuleManagerError>,
    /// Monotonic count of swaps that completed cleanly; surfaced
    /// in telemetry as `gpu_swap_count`.
    swap_count: u64,
}

impl GpuModuleManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn primary(&self) -> Option<ModuleSlot> {
        self.primary
    }

    pub fn standby(&self) -> Option<ModuleSlot> {
        self.standby
    }

    pub fn swap_count(&self) -> u64 {
        self.swap_count
    }

    pub fn kernel_table(&self) -> &KernelTable {
        &self.kernels
    }

    pub fn partial_module_count(&self) -> usize {
        self.partials.len()
    }

    pub fn last_error(&self) -> Option<&ModuleManagerError> {
        self.last_error.as_ref()
    }

    pub fn clear_last_error(&mut self) {
        self.last_error = None;
    }

    /// Loads a cubin/hsaco blob into the standby slot. Wraps
    /// `cuModuleLoadData`. The caller must have already drained
    /// the primary stream + must not have a standby loaded.
    pub fn load_standby(
        &mut self,
        symbols: &GpuDriverSymbolTable,
        blob: &[u8],
    ) -> Result<ModuleSlot, ModuleManagerError> {
        if self.standby.is_some() {
            let err = ModuleManagerError::StandbyOccupied;
            self.last_error = Some(err.clone());
            return Err(err);
        }
        if blob.is_empty() {
            let err = ModuleManagerError::EmptyBlob;
            self.last_error = Some(err.clone());
            return Err(err);
        }

        let mut module: CuModule = std::ptr::null_mut();
        // SAFETY: `cuModuleLoadData` is documented to take a
        // pointer to a host buffer containing a cubin or PTX
        // image. We pass a slice from the caller which lives
        // until the call returns.
        let code = unsafe {
            (symbols.cu_module_load_data)(&mut module as *mut CuModule, blob.as_ptr() as *const _)
        };
        if code != 0 {
            let err = ModuleManagerError::DriverError {
                op: "cuModuleLoadData",
                code,
            };
            self.last_error = Some(err.clone());
            return Err(err);
        }

        let slot = ModuleSlot {
            handle: module as u64,
            blob_bytes: blob.len(),
        };
        self.standby = Some(slot);
        Ok(slot)
    }

    /// Loads a cubin/hsaco artifact from a filesystem path into the standby
    /// slot. ROCm's `hipcc --genco` output is a code object file and the HIP
    /// module API reliably accepts it through `hipModuleLoad`; using
    /// `hipModuleLoadData` on that same hsaco can hang on ROCDXG-backed WSL
    /// systems.
    pub fn load_standby_from_file(
        &mut self,
        symbols: &GpuDriverSymbolTable,
        artifact_path: impl AsRef<Path>,
        blob_bytes: usize,
    ) -> Result<ModuleSlot, ModuleManagerError> {
        if self.standby.is_some() {
            let err = ModuleManagerError::StandbyOccupied;
            self.last_error = Some(err.clone());
            return Err(err);
        }
        if blob_bytes == 0 {
            let err = ModuleManagerError::EmptyBlob;
            self.last_error = Some(err.clone());
            return Err(err);
        }

        let path_text = artifact_path.as_ref().to_string_lossy();
        let c_path = CString::new(path_text.as_ref())
            .map_err(|_| ModuleManagerError::InvalidArtifactPath(path_text.into_owned()))?;
        let mut module: CuModule = std::ptr::null_mut();
        // SAFETY: `cuModuleLoad` / `hipModuleLoad` expect a NUL-terminated
        // path to a cubin/hsaco artifact. `c_path` lives until the call
        // returns, and the driver owns the loaded module handle on success.
        let code = unsafe {
            (symbols.cu_module_load)(&mut module as *mut CuModule, c_path.as_ptr() as *const u8)
        };
        if code != 0 {
            let err = ModuleManagerError::DriverError {
                op: "cuModuleLoad",
                code,
            };
            self.last_error = Some(err.clone());
            return Err(err);
        }

        let slot = ModuleSlot {
            handle: module as u64,
            blob_bytes,
        };
        self.standby = Some(slot);
        Ok(slot)
    }

    /// Populates the kernel table by calling
    /// `cuModuleGetFunction` for every name in `kernel_names`
    /// against the standby module. Returns the kernel count on
    /// success.
    pub fn resolve_kernels(
        &mut self,
        symbols: &GpuDriverSymbolTable,
        kernel_names: &[String],
    ) -> Result<usize, ModuleManagerError> {
        let resolutions = kernel_names
            .iter()
            .cloned()
            .map(KernelResolution::identity)
            .collect::<Vec<_>>();
        self.resolve_kernel_symbols(symbols, &resolutions)
    }

    pub fn resolve_kernel_symbols(
        &mut self,
        symbols: &GpuDriverSymbolTable,
        kernels: &[KernelResolution],
    ) -> Result<usize, ModuleManagerError> {
        let slot = self.standby.ok_or_else(|| {
            let err = ModuleManagerError::NoTarget;
            self.last_error = Some(err.clone());
            err
        })?;
        // Build the new kernel table off to the side so a mid-loop
        // failure doesn't leave a half-populated state on the
        // manager. Only the final success path swaps it in.
        let mut next = KernelTable::new();
        for kernel in kernels {
            let logical_name = kernel.logical_name.trim();
            let driver_name = kernel.driver_name.trim();
            if logical_name.is_empty() || driver_name.is_empty() {
                let err = ModuleManagerError::InvalidKernelName(kernel.logical_name.clone());
                self.last_error = Some(err.clone());
                return Err(err);
            }
            if CString::new(logical_name).is_err() {
                let err = ModuleManagerError::InvalidKernelName(kernel.logical_name.clone());
                self.last_error = Some(err.clone());
                return Err(err);
            }
            let cstr = CString::new(driver_name)
                .map_err(|_| ModuleManagerError::InvalidKernelName(kernel.driver_name.clone()))?;
            let mut hfunc: CuFunction = std::ptr::null_mut();
            // SAFETY: slot.module_ptr() is the value returned by
            // cuModuleLoadData earlier; the name pointer lives
            // until the call returns.
            let code = unsafe {
                (symbols.cu_module_get_function)(
                    &mut hfunc as *mut CuFunction,
                    slot.module_ptr(),
                    cstr.as_ptr() as *const u8,
                )
            };
            if code != 0 {
                let err = ModuleManagerError::DriverError {
                    op: "cuModuleGetFunction",
                    code,
                };
                self.last_error = Some(err.clone());
                return Err(err);
            }
            next.insert(logical_name.to_string(), hfunc as u64);
        }
        self.kernels = next;
        Ok(self.kernels.len())
    }

    /// Promotes standby to primary, returning the retired primary
    /// handle (if any). The caller must call `unload_retired`
    /// after the drain step finishes. Increments `swap_count` on
    /// success.
    pub fn swap(&mut self) -> Result<Option<ModuleSlot>, ModuleManagerError> {
        let new_primary = match self.standby.take() {
            Some(s) => s,
            None => {
                let err = ModuleManagerError::NoStandby;
                self.last_error = Some(err.clone());
                return Err(err);
            }
        };
        let retired = self.primary.take();
        self.primary = Some(new_primary);
        self.swap_count += 1;
        Ok(retired)
    }

    /// Merges a standby module that contains only a subset of kernels into the
    /// active launch table. The primary module remains loaded for every symbol
    /// outside `replaced_symbols`; the partial module stays resident for the
    /// replacement function handles.
    pub fn merge_standby_partial(
        &mut self,
        previous: KernelTable,
        replaced_symbols: &[String],
    ) -> Result<Vec<ModuleSlot>, ModuleManagerError> {
        let new_partial = match self.standby.take() {
            Some(s) => s,
            None => {
                let err = ModuleManagerError::NoStandby;
                self.last_error = Some(err.clone());
                return Err(err);
            }
        };
        if self.primary.is_none() {
            self.standby = Some(new_partial);
            let err = ModuleManagerError::NoPrimary;
            self.last_error = Some(err.clone());
            return Err(err);
        }

        let mut partial_symbols = Vec::new();
        for symbol in replaced_symbols {
            if self.kernels.get(symbol).is_none() {
                self.standby = Some(new_partial);
                let err = ModuleManagerError::UnknownKernel(symbol.clone());
                self.last_error = Some(err.clone());
                return Err(err);
            }
            if !partial_symbols.iter().any(|existing| existing == symbol) {
                partial_symbols.push(symbol.clone());
            }
        }
        if partial_symbols.is_empty() {
            self.standby = Some(new_partial);
            let err = ModuleManagerError::NoTarget;
            self.last_error = Some(err.clone());
            return Err(err);
        }

        let partial_table = std::mem::take(&mut self.kernels);
        let mut merged = previous;
        for symbol in &partial_symbols {
            if let Some(handle) = partial_table.get(symbol) {
                merged.insert(symbol.clone(), handle);
            }
        }

        let mut retired = Vec::new();
        let mut retained = Vec::new();
        for partial in self.partials.drain(..) {
            if partial.symbols.iter().all(|symbol| {
                partial_symbols
                    .iter()
                    .any(|new_symbol| new_symbol == symbol)
            }) {
                retired.push(partial.slot);
            } else {
                retained.push(partial);
            }
        }
        retained.push(PartialModuleSlot {
            slot: new_partial,
            symbols: partial_symbols,
        });

        self.partials = retained;
        self.kernels = merged;
        self.swap_count += 1;
        self.last_error = None;
        Ok(retired)
    }

    pub fn drain_partial_modules(&mut self) -> Vec<ModuleSlot> {
        self.partials
            .drain(..)
            .map(|partial| partial.slot)
            .collect()
    }

    /// Unloads a retired module handle. Wraps `cuModuleUnload`.
    /// Returns the driver result code so the caller can decide
    /// whether to escalate; on non-zero the error is also
    /// recorded on `last_error`.
    pub fn unload_retired(
        &mut self,
        symbols: &GpuDriverSymbolTable,
        retired: ModuleSlot,
    ) -> Result<(), ModuleManagerError> {
        // SAFETY: `retired.module_ptr()` is the value returned by
        // a prior `cuModuleLoadData`. Repeat unloads of the same
        // pointer are caller error.
        let code = unsafe { (symbols.cu_module_unload)(retired.module_ptr()) };
        if code != 0 {
            let err = ModuleManagerError::DriverError {
                op: "cuModuleUnload",
                code,
            };
            self.last_error = Some(err.clone());
            return Err(err);
        }
        Ok(())
    }

    /// Launches a resolved kernel through the vendor driver API.
    /// The kernel handle must already exist in the active primary
    /// table; unresolved names are rejected before entering the
    /// driver so the runtime boundary can surface a deterministic
    /// error card.
    pub fn launch_kernel(
        &mut self,
        symbols: &GpuDriverSymbolTable,
        kernel_name: &str,
        config: KernelLaunchConfig,
        kernel_params: CuKernelParams,
    ) -> Result<(), ModuleManagerError> {
        if self.primary.is_none() {
            let err = ModuleManagerError::NoPrimary;
            self.last_error = Some(err.clone());
            return Err(err);
        }

        let hfunc = match self.kernels.get(kernel_name) {
            Some(h) => h as CuFunction,
            None => {
                let err = ModuleManagerError::UnknownKernel(kernel_name.to_string());
                self.last_error = Some(err.clone());
                return Err(err);
            }
        };

        let code = unsafe {
            (symbols.cu_launch_kernel)(
                hfunc,
                config.grid.0,
                config.grid.1,
                config.grid.2,
                config.block.0,
                config.block.1,
                config.block.2,
                config.shared_mem_bytes,
                config.stream,
                kernel_params,
                std::ptr::null_mut(),
            )
        };
        if code != 0 {
            let err = ModuleManagerError::DriverError {
                op: "cuLaunchKernel",
                code,
            };
            self.last_error = Some(err.clone());
            return Err(err);
        }

        Ok(())
    }
}

// ── Tests ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::{c_void, CStr};

    // ── Stub symbol table ───────────────────────────────────
    //
    // We can't dlopen a real driver in CI. Instead we expose a
    // synthesized `GpuDriverSymbolTable` whose function pointers
    // are `extern "C"` stubs that simulate success/failure
    // shapes. The stubs read + mutate a per-thread `StubState`
    // — using globals here would cross-pollute parallel cargo
    // tests (one test storing a non-zero error code into the
    // result static would race against another test asserting
    // success).
    //
    // Each test runs on a single thread end-to-end, so a
    // `thread_local!` Cell-of-state gives each test a fresh
    // counter without forcing `--test-threads=1`.

    use std::cell::RefCell;

    struct StubState {
        load_calls: u64,
        load_result: CuResult,
        get_fn_calls: u64,
        get_fn_result: CuResult,
        launch_calls: u64,
        launch_result: CuResult,
        last_launch_fn: u64,
        last_grid_x: u32,
        last_block_x: u32,
        last_shared_bytes: u32,
        unload_calls: u64,
        unload_result: CuResult,
        next_module_handle: u64,
        next_fn_handle: u64,
    }

    impl StubState {
        const fn fresh() -> Self {
            Self {
                load_calls: 0,
                load_result: 0,
                get_fn_calls: 0,
                get_fn_result: 0,
                launch_calls: 0,
                launch_result: 0,
                last_launch_fn: 0,
                last_grid_x: 0,
                last_block_x: 0,
                last_shared_bytes: 0,
                unload_calls: 0,
                unload_result: 0,
                next_module_handle: 0x1_0000,
                next_fn_handle: 0x2_0000,
            }
        }
    }

    thread_local! {
        static STATE: RefCell<StubState> = const { RefCell::new(StubState::fresh()) };
        static GET_FN_NAMES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    fn with_state<R>(f: impl FnOnce(&StubState) -> R) -> R {
        STATE.with(|s| f(&s.borrow()))
    }
    fn with_state_mut<R>(f: impl FnOnce(&mut StubState) -> R) -> R {
        STATE.with(|s| f(&mut s.borrow_mut()))
    }
    fn get_fn_names() -> Vec<String> {
        GET_FN_NAMES.with(|names| names.borrow().clone())
    }

    unsafe extern "C" fn stub_load_data(module: *mut CuModule, _image: *const c_void) -> CuResult {
        with_state_mut(|s| {
            s.load_calls += 1;
            let r = s.load_result;
            if r == 0 {
                let h = s.next_module_handle;
                s.next_module_handle += 0x100;
                unsafe { *module = h as CuModule };
            }
            r
        })
    }
    unsafe extern "C" fn stub_load_file(module: *mut CuModule, _path: *const u8) -> CuResult {
        stub_load_data(module, std::ptr::null())
    }
    unsafe extern "C" fn stub_unload(_module: CuModule) -> CuResult {
        with_state_mut(|s| {
            s.unload_calls += 1;
            s.unload_result
        })
    }
    unsafe extern "C" fn stub_get_function(
        hfunc: *mut CuFunction,
        _hmod: CuModule,
        name: *const u8,
    ) -> CuResult {
        with_state_mut(|s| {
            s.get_fn_calls += 1;
            if !name.is_null() {
                let decoded = unsafe { CStr::from_ptr(name as *const i8) }
                    .to_string_lossy()
                    .to_string();
                GET_FN_NAMES.with(|names| names.borrow_mut().push(decoded));
            }
            let r = s.get_fn_result;
            if r == 0 {
                let h = s.next_fn_handle;
                s.next_fn_handle += 0x10;
                unsafe { *hfunc = h as CuFunction };
            }
            r
        })
    }
    unsafe extern "C" fn stub_launch_kernel(
        f: CuFunction,
        grid_dim_x: u32,
        _grid_dim_y: u32,
        _grid_dim_z: u32,
        block_dim_x: u32,
        _block_dim_y: u32,
        _block_dim_z: u32,
        shared_mem_bytes: u32,
        _stream: *mut c_void,
        _kernel_params: *mut *mut c_void,
        _extra: *mut *mut c_void,
    ) -> CuResult {
        with_state_mut(|s| {
            s.launch_calls += 1;
            s.last_launch_fn = f as u64;
            s.last_grid_x = grid_dim_x;
            s.last_block_x = block_dim_x;
            s.last_shared_bytes = shared_mem_bytes;
            s.launch_result
        })
    }
    // Unused-symbol stubs (the manager doesn't call them but the
    // GpuDriverSymbolTable layout requires every field set).
    unsafe extern "C" fn stub_init(_f: u32) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_device_get(_d: *mut i32, _o: i32) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_ctx_get(_c: *mut *mut c_void) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_ctx_set(_c: *mut c_void) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_ctx_sync() -> CuResult {
        0
    }
    unsafe extern "C" fn stub_stream_sync(_s: *mut c_void) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_mem_alloc(_p: *mut u64, _b: usize) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_mem_free(_p: u64) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_memcpy_dtod(_d: u64, _s: u64, _b: usize) -> CuResult {
        0
    }

    pub(super) fn stub_table() -> GpuDriverSymbolTable {
        GpuDriverSymbolTable {
            cu_init: stub_init,
            cu_device_get: stub_device_get,
            cu_ctx_get_current: stub_ctx_get,
            cu_ctx_set_current: stub_ctx_set,
            cu_module_load_data: stub_load_data,
            cu_module_load: stub_load_file,
            cu_module_unload: stub_unload,
            cu_module_get_function: stub_get_function,
            cu_launch_kernel: stub_launch_kernel,
            cu_ctx_synchronize: stub_ctx_sync,
            cu_stream_synchronize: stub_stream_sync,
            cu_mem_alloc: stub_mem_alloc,
            cu_mem_free: stub_mem_free,
            cu_memcpy_dtod: stub_memcpy_dtod,
        }
    }

    fn reset_counters() {
        with_state_mut(|s| *s = StubState::fresh());
        GET_FN_NAMES.with(|names| names.borrow_mut().clear());
    }

    // ── Actual assertions ──────────────────────────────────

    #[test]
    fn fresh_manager_has_no_slots() {
        let m = GpuModuleManager::new();
        assert!(m.primary().is_none());
        assert!(m.standby().is_none());
        assert!(m.kernel_table().is_empty());
        assert_eq!(m.swap_count(), 0);
    }

    #[test]
    fn load_standby_invokes_driver_and_records_slot() {
        reset_counters();
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        let slot = m.load_standby(&t, &[0u8, 1, 2, 3]).unwrap();
        assert_eq!(with_state(|s| s.load_calls), 1);
        assert_eq!(slot.blob_bytes, 4);
        assert!(slot.handle != 0);
        assert_eq!(m.standby().unwrap(), slot);
        assert!(m.primary().is_none());
    }

    #[test]
    fn load_standby_rejects_empty_blob() {
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        let err = m.load_standby(&t, &[]).unwrap_err();
        assert_eq!(err.short_label(), "empty_blob");
        assert!(m.last_error().is_some());
    }

    #[test]
    fn load_standby_rejects_when_standby_occupied() {
        reset_counters();
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        m.load_standby(&t, &[1, 2]).unwrap();
        let err = m.load_standby(&t, &[3, 4]).unwrap_err();
        assert_eq!(err.short_label(), "standby_occupied");
    }

    #[test]
    fn load_standby_surfaces_driver_error_code() {
        reset_counters();
        with_state_mut(|s| s.load_result = 42);
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        let err = m.load_standby(&t, &[1, 2]).unwrap_err();
        match err {
            ModuleManagerError::DriverError { op, code } => {
                assert_eq!(op, "cuModuleLoadData");
                assert_eq!(code, 42);
            }
            other => panic!("expected DriverError, got {other:?}"),
        }
    }

    #[test]
    fn resolve_kernels_populates_table() {
        reset_counters();
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        m.load_standby(&t, &[1, 2]).unwrap();
        let n = m
            .resolve_kernels(&t, &["vec_add".into(), "gemm".into(), "softmax".into()])
            .unwrap();
        assert_eq!(n, 3);
        assert_eq!(with_state(|s| s.get_fn_calls), 3);
        assert!(m.kernel_table().get("vec_add").is_some());
        assert!(m.kernel_table().get("missing").is_none());
    }

    #[test]
    fn resolve_kernel_symbols_uses_driver_name_and_keeps_logical_key() {
        reset_counters();
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        m.load_standby(&t, &[1, 2]).unwrap();
        let n = m
            .resolve_kernel_symbols(
                &t,
                &[KernelResolution {
                    logical_name: "shade".into(),
                    driver_name: "_Z5shadePf".into(),
                }],
            )
            .unwrap();
        assert_eq!(n, 1);
        assert_eq!(get_fn_names(), vec!["_Z5shadePf".to_string()]);
        assert!(m.kernel_table().get("shade").is_some());
        assert!(m.kernel_table().get("_Z5shadePf").is_none());
    }

    #[test]
    fn resolve_kernels_fails_without_standby() {
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        let err = m.resolve_kernels(&t, &["vec_add".into()]).unwrap_err();
        assert_eq!(err.short_label(), "no_target");
    }

    #[test]
    fn resolve_kernels_rejects_nul_in_name() {
        reset_counters();
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        m.load_standby(&t, &[1, 2]).unwrap();
        let err = m.resolve_kernels(&t, &["good\0bad".into()]).unwrap_err();
        assert_eq!(err.short_label(), "invalid_kernel_name");
    }

    #[test]
    fn resolve_kernels_atomicity_on_driver_failure() {
        reset_counters();
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        m.load_standby(&t, &[1, 2]).unwrap();
        // Pre-fill the kernel table so we can prove it didn't
        // get partially clobbered when the second lookup fails.
        let mut sentinel = KernelTable::new();
        sentinel.insert("sentinel", 0xdeadbeef);
        m.kernels = sentinel;
        with_state_mut(|s| s.get_fn_result = 7);
        let err = m
            .resolve_kernels(&t, &["a".into(), "b".into()])
            .unwrap_err();
        match err {
            ModuleManagerError::DriverError { code, .. } => assert_eq!(code, 7),
            other => panic!("expected DriverError, got {other:?}"),
        }
        // Previous table must still be intact — the half-built
        // `next` was never published.
        assert_eq!(m.kernel_table().get("sentinel"), Some(0xdeadbeef));
    }

    #[test]
    fn swap_promotes_standby_and_returns_retired() {
        reset_counters();
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        let first = m.load_standby(&t, &[1, 2]).unwrap();
        let retired = m.swap().unwrap();
        assert!(retired.is_none(), "first swap has no retired handle");
        assert_eq!(m.primary().unwrap(), first);
        assert!(m.standby().is_none());

        let second = m.load_standby(&t, &[3, 4]).unwrap();
        let retired = m.swap().unwrap();
        assert_eq!(retired.unwrap(), first);
        assert_eq!(m.primary().unwrap(), second);
        assert_eq!(m.swap_count(), 2);
    }

    #[test]
    fn partial_merge_overrides_changed_symbols_and_keeps_primary() {
        reset_counters();
        let mut m = GpuModuleManager::new();
        let t = stub_table();

        let primary = m.load_standby(&t, &[1, 2, 3]).unwrap();
        m.resolve_kernels(&t, &["shade".into(), "trace".into()])
            .unwrap();
        let original_shade = m.kernel_table().get("shade").unwrap();
        let original_trace = m.kernel_table().get("trace").unwrap();
        m.swap().unwrap();

        m.load_standby(&t, &[4, 5]).unwrap();
        m.resolve_kernels(&t, &["shade".into()]).unwrap();
        let previous = {
            let mut table = KernelTable::new();
            table.insert("shade", original_shade);
            table.insert("trace", original_trace);
            table
        };
        let retired = m
            .merge_standby_partial(previous, &["shade".to_string()])
            .unwrap();

        assert!(retired.is_empty());
        assert_eq!(m.primary().unwrap(), primary);
        assert_eq!(m.partial_module_count(), 1);
        assert_ne!(m.kernel_table().get("shade"), Some(original_shade));
        assert_eq!(m.kernel_table().get("trace"), Some(original_trace));
        assert_eq!(m.swap_count(), 2);
    }

    #[test]
    fn repeated_partial_merge_retires_superseded_partial_module() {
        reset_counters();
        let mut m = GpuModuleManager::new();
        let t = stub_table();

        m.load_standby(&t, &[1, 2, 3]).unwrap();
        m.resolve_kernels(&t, &["shade".into(), "trace".into()])
            .unwrap();
        let original_shade = m.kernel_table().get("shade").unwrap();
        let original_trace = m.kernel_table().get("trace").unwrap();
        m.swap().unwrap();

        let mut previous = KernelTable::new();
        previous.insert("shade", original_shade);
        previous.insert("trace", original_trace);
        m.load_standby(&t, &[4, 5]).unwrap();
        m.resolve_kernels(&t, &["shade".into()]).unwrap();
        m.merge_standby_partial(previous, &["shade".to_string()])
            .unwrap();
        let first_partial_handle = m.partials[0].slot.handle;
        let first_shade = m.kernel_table().get("shade").unwrap();

        let mut previous = KernelTable::new();
        previous.insert("shade", first_shade);
        previous.insert("trace", original_trace);
        m.load_standby(&t, &[6, 7]).unwrap();
        m.resolve_kernels(&t, &["shade".into()]).unwrap();
        let retired = m
            .merge_standby_partial(previous, &["shade".to_string()])
            .unwrap();

        assert_eq!(retired.len(), 1);
        assert_eq!(retired[0].handle, first_partial_handle);
        assert_eq!(m.partial_module_count(), 1);
        assert_eq!(m.kernel_table().get("trace"), Some(original_trace));
        assert_ne!(m.kernel_table().get("shade"), Some(first_shade));
    }

    #[test]
    fn swap_fails_without_standby() {
        let mut m = GpuModuleManager::new();
        let err = m.swap().unwrap_err();
        assert_eq!(err.short_label(), "no_standby");
    }

    #[test]
    fn unload_retired_invokes_driver_and_clears_on_success() {
        reset_counters();
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        m.load_standby(&t, &[1, 2]).unwrap();
        m.swap().unwrap();
        let retired = ModuleSlot {
            handle: 0xabcd,
            blob_bytes: 2,
        };
        m.unload_retired(&t, retired).unwrap();
        assert_eq!(with_state(|s| s.unload_calls), 1);
    }

    #[test]
    fn unload_retired_surfaces_driver_error() {
        reset_counters();
        with_state_mut(|s| s.unload_result = 9);
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        let retired = ModuleSlot {
            handle: 0xabcd,
            blob_bytes: 2,
        };
        let err = m.unload_retired(&t, retired).unwrap_err();
        match err {
            ModuleManagerError::DriverError { op, code } => {
                assert_eq!(op, "cuModuleUnload");
                assert_eq!(code, 9);
            }
            other => panic!("expected DriverError, got {other:?}"),
        }
    }

    #[test]
    fn kernel_table_helpers() {
        let mut t = KernelTable::new();
        assert!(t.is_empty());
        t.insert("vec_add", 0x10);
        t.insert("gemm", 0x20);
        assert_eq!(t.len(), 2);
        assert_eq!(t.get("vec_add"), Some(0x10));
        let mut names: Vec<&String> = t.names().collect();
        names.sort();
        assert_eq!(
            names.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            vec!["gemm", "vec_add"]
        );
        t.clear();
        assert!(t.is_empty());
    }

    #[test]
    fn launch_config_clamps_1d_runtime_sizes() {
        let c = KernelLaunchConfig::new(0, usize::MAX, usize::MAX, 0x77);
        assert_eq!(c.grid, (1, 1, 1));
        assert_eq!(c.block, (u32::MAX, 1, 1));
        assert_eq!(c.shared_mem_bytes, u32::MAX);
        assert_eq!(c.stream as usize, 0x77);
    }

    #[test]
    fn launch_kernel_invokes_driver_for_resolved_primary_kernel() {
        reset_counters();
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        m.load_standby(&t, &[1, 2, 3]).unwrap();
        m.resolve_kernels(&t, &["vec_add".into()]).unwrap();
        let fn_handle = m.kernel_table().get("vec_add").unwrap();
        m.swap().unwrap();

        let cfg = KernelLaunchConfig::new(8, 256, 128, 0x55);
        m.launch_kernel(&t, "vec_add", cfg, std::ptr::null_mut())
            .unwrap();

        with_state(|s| {
            assert_eq!(s.launch_calls, 1);
            assert_eq!(s.last_launch_fn, fn_handle);
            assert_eq!(s.last_grid_x, 8);
            assert_eq!(s.last_block_x, 256);
            assert_eq!(s.last_shared_bytes, 128);
        });
    }

    #[test]
    fn launch_kernel_rejects_without_primary() {
        reset_counters();
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        m.load_standby(&t, &[1, 2, 3]).unwrap();
        m.resolve_kernels(&t, &["vec_add".into()]).unwrap();

        let err = m
            .launch_kernel(
                &t,
                "vec_add",
                KernelLaunchConfig::new(1, 1, 0, 0),
                std::ptr::null_mut(),
            )
            .unwrap_err();

        assert_eq!(err.short_label(), "no_primary");
        assert_eq!(with_state(|s| s.launch_calls), 0);
    }

    #[test]
    fn launch_kernel_rejects_unknown_kernel() {
        reset_counters();
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        m.load_standby(&t, &[1, 2, 3]).unwrap();
        m.resolve_kernels(&t, &["vec_add".into()]).unwrap();
        m.swap().unwrap();

        let err = m
            .launch_kernel(
                &t,
                "missing",
                KernelLaunchConfig::new(1, 1, 0, 0),
                std::ptr::null_mut(),
            )
            .unwrap_err();

        assert_eq!(err.short_label(), "unknown_kernel");
        assert_eq!(with_state(|s| s.launch_calls), 0);
    }

    #[test]
    fn launch_kernel_surfaces_driver_error() {
        reset_counters();
        with_state_mut(|s| s.launch_result = 701);
        let mut m = GpuModuleManager::new();
        let t = stub_table();
        m.load_standby(&t, &[1, 2, 3]).unwrap();
        m.resolve_kernels(&t, &["vec_add".into()]).unwrap();
        m.swap().unwrap();

        let err = m
            .launch_kernel(
                &t,
                "vec_add",
                KernelLaunchConfig::new(1, 1, 0, 0),
                std::ptr::null_mut(),
            )
            .unwrap_err();

        match err {
            ModuleManagerError::DriverError { op, code } => {
                assert_eq!(op, "cuLaunchKernel");
                assert_eq!(code, 701);
            }
            other => panic!("expected DriverError, got {other:?}"),
        }
        assert_eq!(with_state(|s| s.launch_calls), 1);
    }

    #[test]
    fn manager_is_send_and_sync() {
        // Compile-time check.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<GpuModuleManager>();
        assert_send_sync::<ModuleSlot>();
        assert_send_sync::<KernelTable>();
    }
}
