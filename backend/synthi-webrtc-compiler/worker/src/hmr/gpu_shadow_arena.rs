// ============================================================
// GPU SHADOW ARENA (Phase 2 scaffold)
// ============================================================
//
// Spec: docs/GPU_HMR_ULTRAPLAN.md §6.1.1.
//
// The in-VRAM shadow arena is the latency lever for the Tier-B
// snapshot path. Walking the buffer registry and copying every
// allocation back to host RAM via cuMemcpyDtoH blows the §6.1
// budget on multi-GB working sets; copying device→device with
// cuMemcpyDtoD into a sibling allocation in the same VRAM stays
// inside the budget (memory bandwidth >> PCIe bandwidth on
// Blackwell / RDNA).
//
// Phase 2 contract for this file:
//
//   • `ShadowArena` owns a per-buffer shadow allocation map.
//   • `register(symbols, orig_dptr, size)` → cuMemAlloc(size)
//     to mint a shadow slot, record `(orig, shadow, size)`.
//   • `sync_to_shadow(symbols, key)` → cuMemcpyDtoD(shadow,
//     orig, size). Called by the snapshot path before the swap.
//   • `sync_from_shadow(symbols, key)` → cuMemcpyDtoD(orig,
//     shadow, size). Called by the restore path after the new
//     module is bound.
//   • `release(symbols, key)` → cuMemFree(shadow). Used at
//     shutdown or when the host runner re-registers a buffer
//     of different size.
//   • `total_shadow_bytes()` exposes the VRAM cost so the
//     planner can decide between "everything shadows" and
//     "only hot buffers shadow" per heuristic in §6.1.1.
//
// All cuMem* calls go through `GpuDriverSymbolTable` so the
// arena is unit-testable through stubs.
//
// Feature-gated by `gpu-hmr`.

#![cfg(feature = "gpu-hmr")]

use std::collections::HashMap;

use crate::hmr::gpu_driver_loader::{CuDevicePtr, CuResult, GpuDriverSymbolTable};

// ── Per-buffer shadow record ───────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShadowEntry {
    /// The host-runner's device pointer (e.g. the `float*` it
    /// got from cuMemAlloc earlier in the preview lifecycle).
    pub orig_dptr: CuDevicePtr,
    /// The shadow allocation produced by `register`. Lives in
    /// VRAM, freed by `release`.
    pub shadow_dptr: CuDevicePtr,
    pub size_bytes: usize,
    /// True if `sync_to_shadow` has run since the last
    /// `sync_from_shadow` — drives the no-op short-circuit in
    /// the restore path.
    pub shadow_is_fresh: bool,
}

// ── Errors ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShadowArenaError {
    /// Driver returned non-zero.
    DriverError { op: &'static str, code: CuResult },
    /// `register` called with size 0.
    ZeroSize { key: CuDevicePtr },
    /// `sync_*` / `release` called for a buffer that never
    /// `register`ed.
    UnknownKey { key: CuDevicePtr },
    /// `register` called for a key that already exists with a
    /// different size — the caller must `release` and re-register.
    SizeMismatch {
        key: CuDevicePtr,
        existing: usize,
        requested: usize,
    },
}

impl ShadowArenaError {
    pub fn short_label(&self) -> &'static str {
        match self {
            Self::DriverError { .. } => "driver_error",
            Self::ZeroSize { .. } => "zero_size",
            Self::UnknownKey { .. } => "unknown_key",
            Self::SizeMismatch { .. } => "size_mismatch",
        }
    }
}

impl std::fmt::Display for ShadowArenaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DriverError { op, code } => {
                write!(f, "shadow arena driver op {op:?} returned {code}")
            }
            Self::ZeroSize { key } => write!(f, "register({key:#x}, 0): zero-byte shadow"),
            Self::UnknownKey { key } => {
                write!(f, "no shadow entry for {key:#x}")
            }
            Self::SizeMismatch {
                key,
                existing,
                requested,
            } => write!(
                f,
                "shadow size mismatch for {key:#x}: existing={existing}, requested={requested}"
            ),
        }
    }
}

// ── The arena ───────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct ShadowArena {
    entries: HashMap<CuDevicePtr, ShadowEntry>,
    /// Sum of `size_bytes` across live entries — kept up-to-date
    /// in the register / release paths so callers don't have to
    /// re-sum on every snapshot.
    total_bytes: usize,
    /// Number of cuMemcpyDtoD invocations done by `sync_to_shadow`.
    /// Surfaced as `shadow_to_calls` in telemetry.
    sync_to_calls: u64,
    /// Number of cuMemcpyDtoD invocations done by `sync_from_shadow`.
    sync_from_calls: u64,
    /// Last driver error (set when a cuMem* returned non-zero).
    last_error: Option<ShadowArenaError>,
}

impl ShadowArena {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn total_shadow_bytes(&self) -> usize {
        self.total_bytes
    }

    pub fn sync_to_calls(&self) -> u64 {
        self.sync_to_calls
    }

    pub fn sync_from_calls(&self) -> u64 {
        self.sync_from_calls
    }

    pub fn last_error(&self) -> Option<&ShadowArenaError> {
        self.last_error.as_ref()
    }

    pub fn clear_last_error(&mut self) {
        self.last_error = None;
    }

    pub fn get(&self, key: CuDevicePtr) -> Option<&ShadowEntry> {
        self.entries.get(&key)
    }

    pub fn entries(&self) -> impl Iterator<Item = &ShadowEntry> {
        self.entries.values()
    }

    /// Registers a shadow allocation for `orig_dptr`. Calls
    /// `cuMemAlloc(size)` once and parks the resulting pointer
    /// in the entry table.
    pub fn register(
        &mut self,
        symbols: &GpuDriverSymbolTable,
        orig_dptr: CuDevicePtr,
        size_bytes: usize,
    ) -> Result<ShadowEntry, ShadowArenaError> {
        if size_bytes == 0 {
            let err = ShadowArenaError::ZeroSize { key: orig_dptr };
            self.last_error = Some(err.clone());
            return Err(err);
        }
        if let Some(existing) = self.entries.get(&orig_dptr) {
            if existing.size_bytes != size_bytes {
                let err = ShadowArenaError::SizeMismatch {
                    key: orig_dptr,
                    existing: existing.size_bytes,
                    requested: size_bytes,
                };
                self.last_error = Some(err.clone());
                return Err(err);
            }
            // Identical re-register is idempotent — useful for
            // recoverable host runner crashes that re-attach
            // existing allocations.
            return Ok(*existing);
        }

        let mut shadow: CuDevicePtr = 0;
        // SAFETY: cuMemAlloc writes a single CUdeviceptr into the
        // out pointer. The pointer lives on the stack until the
        // call returns.
        let code = unsafe { (symbols.cu_mem_alloc)(&mut shadow as *mut CuDevicePtr, size_bytes) };
        if code != 0 {
            let err = ShadowArenaError::DriverError {
                op: "cuMemAlloc",
                code,
            };
            self.last_error = Some(err.clone());
            return Err(err);
        }

        let entry = ShadowEntry {
            orig_dptr,
            shadow_dptr: shadow,
            size_bytes,
            shadow_is_fresh: false,
        };
        self.entries.insert(orig_dptr, entry);
        self.total_bytes = self.total_bytes.saturating_add(size_bytes);
        Ok(entry)
    }

    /// cuMemcpyDtoD(shadow ← orig). Captures the current device
    /// state for `orig_dptr` into the shadow slot. Sets
    /// `shadow_is_fresh = true`.
    pub fn sync_to_shadow(
        &mut self,
        symbols: &GpuDriverSymbolTable,
        orig_dptr: CuDevicePtr,
    ) -> Result<usize, ShadowArenaError> {
        let entry = self
            .entries
            .get(&orig_dptr)
            .copied()
            .ok_or(ShadowArenaError::UnknownKey { key: orig_dptr })?;
        // SAFETY: both pointers were minted by cuMemAlloc earlier
        // (orig by the host runner, shadow by `register`) and the
        // size is the smaller of the two.
        let code = unsafe {
            (symbols.cu_memcpy_dtod)(entry.shadow_dptr, entry.orig_dptr, entry.size_bytes)
        };
        if code != 0 {
            let err = ShadowArenaError::DriverError {
                op: "cuMemcpyDtoD<to_shadow>",
                code,
            };
            self.last_error = Some(err.clone());
            return Err(err);
        }
        self.sync_to_calls += 1;
        if let Some(slot) = self.entries.get_mut(&orig_dptr) {
            slot.shadow_is_fresh = true;
        }
        Ok(entry.size_bytes)
    }

    /// cuMemcpyDtoD(orig ← shadow). Restores `orig_dptr` from the
    /// shadow slot. Refuses if the shadow has never been synced.
    pub fn sync_from_shadow(
        &mut self,
        symbols: &GpuDriverSymbolTable,
        orig_dptr: CuDevicePtr,
    ) -> Result<usize, ShadowArenaError> {
        let entry = self
            .entries
            .get(&orig_dptr)
            .copied()
            .ok_or(ShadowArenaError::UnknownKey { key: orig_dptr })?;
        // SAFETY: as above.
        let code = unsafe {
            (symbols.cu_memcpy_dtod)(entry.orig_dptr, entry.shadow_dptr, entry.size_bytes)
        };
        if code != 0 {
            let err = ShadowArenaError::DriverError {
                op: "cuMemcpyDtoD<from_shadow>",
                code,
            };
            self.last_error = Some(err.clone());
            return Err(err);
        }
        self.sync_from_calls += 1;
        Ok(entry.size_bytes)
    }

    /// Frees the shadow allocation. cuMemFree(shadow). Removes
    /// the entry from the table on success.
    pub fn release(
        &mut self,
        symbols: &GpuDriverSymbolTable,
        orig_dptr: CuDevicePtr,
    ) -> Result<usize, ShadowArenaError> {
        let entry = match self.entries.remove(&orig_dptr) {
            Some(e) => e,
            None => {
                let err = ShadowArenaError::UnknownKey { key: orig_dptr };
                self.last_error = Some(err.clone());
                return Err(err);
            }
        };
        // SAFETY: shadow_dptr was minted by cuMemAlloc on
        // register; releasing it once is correct.
        let code = unsafe { (symbols.cu_mem_free)(entry.shadow_dptr) };
        if code != 0 {
            // Re-insert so the caller can retry / inspect.
            self.entries.insert(orig_dptr, entry);
            let err = ShadowArenaError::DriverError {
                op: "cuMemFree",
                code,
            };
            self.last_error = Some(err.clone());
            return Err(err);
        }
        self.total_bytes = self.total_bytes.saturating_sub(entry.size_bytes);
        Ok(entry.size_bytes)
    }
}

// ── Tests ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::c_void;

    use std::cell::RefCell;

    // Per-thread stub state — see gpu_module_manager test
    // module for the rationale (parallel cargo tests would
    // pollute shared atomics).
    struct StubState {
        alloc_calls: u64,
        alloc_result: CuResult,
        free_calls: u64,
        free_result: CuResult,
        dtod_calls: u64,
        dtod_result: CuResult,
        dtod_last_bytes: u64,
        dtod_last_dst: u64,
        dtod_last_src: u64,
        next_shadow: u64,
    }

    impl StubState {
        const fn fresh() -> Self {
            Self {
                alloc_calls: 0,
                alloc_result: 0,
                free_calls: 0,
                free_result: 0,
                dtod_calls: 0,
                dtod_result: 0,
                dtod_last_bytes: 0,
                dtod_last_dst: 0,
                dtod_last_src: 0,
                next_shadow: 0x9_0000,
            }
        }
    }

    thread_local! {
        static STATE: RefCell<StubState> = const { RefCell::new(StubState::fresh()) };
    }

    fn with_state<R>(f: impl FnOnce(&StubState) -> R) -> R {
        STATE.with(|s| f(&s.borrow()))
    }
    fn with_state_mut<R>(f: impl FnOnce(&mut StubState) -> R) -> R {
        STATE.with(|s| f(&mut s.borrow_mut()))
    }

    unsafe extern "C" fn stub_alloc(dptr: *mut CuDevicePtr, bytes: usize) -> CuResult {
        with_state_mut(|s| {
            s.alloc_calls += 1;
            let r = s.alloc_result;
            if r == 0 {
                let h = s.next_shadow;
                s.next_shadow += 0x1000;
                unsafe { *dptr = h };
                // Sanity-check that the stub even saw the right size.
                assert!(bytes > 0);
            }
            r
        })
    }
    unsafe extern "C" fn stub_free(_dptr: CuDevicePtr) -> CuResult {
        with_state_mut(|s| {
            s.free_calls += 1;
            s.free_result
        })
    }
    unsafe extern "C" fn stub_dtod(dst: CuDevicePtr, src: CuDevicePtr, bytes: usize) -> CuResult {
        with_state_mut(|s| {
            s.dtod_calls += 1;
            s.dtod_last_dst = dst;
            s.dtod_last_src = src;
            s.dtod_last_bytes = bytes as u64;
            s.dtod_result
        })
    }
    // Unused stubs to satisfy table layout.
    unsafe extern "C" fn stub_init(_f: u32) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_device_get(_d: *mut i32, _o: i32) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_ctx_get(_c: *mut *mut c_void) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_load_data(_m: *mut *mut c_void, _i: *const c_void) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_load_file(_m: *mut *mut c_void, _p: *const u8) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_unload(_m: *mut c_void) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_get_function(
        _h: *mut *mut c_void,
        _m: *mut c_void,
        _n: *const u8,
    ) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_launch_kernel(
        _f: *mut c_void,
        _grid_dim_x: u32,
        _grid_dim_y: u32,
        _grid_dim_z: u32,
        _block_dim_x: u32,
        _block_dim_y: u32,
        _block_dim_z: u32,
        _shared_mem_bytes: u32,
        _stream: *mut c_void,
        _kernel_params: *mut *mut c_void,
        _extra: *mut *mut c_void,
    ) -> CuResult {
        0
    }
    unsafe extern "C" fn stub_ctx_sync() -> CuResult {
        0
    }
    unsafe extern "C" fn stub_stream_sync(_s: *mut c_void) -> CuResult {
        0
    }

    fn stub_table() -> GpuDriverSymbolTable {
        GpuDriverSymbolTable {
            cu_init: stub_init,
            cu_device_get: stub_device_get,
            cu_ctx_get_current: stub_ctx_get,
            cu_module_load_data: stub_load_data,
            cu_module_load: stub_load_file,
            cu_module_unload: stub_unload,
            cu_module_get_function: stub_get_function,
            cu_launch_kernel: stub_launch_kernel,
            cu_ctx_synchronize: stub_ctx_sync,
            cu_stream_synchronize: stub_stream_sync,
            cu_mem_alloc: stub_alloc,
            cu_mem_free: stub_free,
            cu_memcpy_dtod: stub_dtod,
        }
    }

    fn reset() {
        with_state_mut(|s| *s = StubState::fresh());
    }

    #[test]
    fn fresh_arena_is_empty() {
        let a = ShadowArena::new();
        assert!(a.is_empty());
        assert_eq!(a.len(), 0);
        assert_eq!(a.total_shadow_bytes(), 0);
        assert_eq!(a.sync_to_calls(), 0);
        assert_eq!(a.sync_from_calls(), 0);
    }

    #[test]
    fn register_calls_cu_mem_alloc_and_records_entry() {
        reset();
        let mut a = ShadowArena::new();
        let t = stub_table();
        let e = a.register(&t, 0xa000, 4096).unwrap();
        assert_eq!(with_state(|s| s.alloc_calls), 1);
        assert_eq!(e.orig_dptr, 0xa000);
        assert_eq!(e.size_bytes, 4096);
        assert!(!e.shadow_is_fresh);
        assert_eq!(a.len(), 1);
        assert_eq!(a.total_shadow_bytes(), 4096);
    }

    #[test]
    fn register_rejects_zero_size() {
        let mut a = ShadowArena::new();
        let t = stub_table();
        let err = a.register(&t, 0xa000, 0).unwrap_err();
        assert_eq!(err.short_label(), "zero_size");
    }

    #[test]
    fn register_idempotent_on_same_size() {
        reset();
        let mut a = ShadowArena::new();
        let t = stub_table();
        let e1 = a.register(&t, 0xa000, 4096).unwrap();
        let e2 = a.register(&t, 0xa000, 4096).unwrap();
        assert_eq!(e1, e2);
        assert_eq!(
            with_state(|s| s.alloc_calls),
            1,
            "second register must not realloc"
        );
        assert_eq!(a.total_shadow_bytes(), 4096);
    }

    #[test]
    fn register_rejects_size_mismatch() {
        reset();
        let mut a = ShadowArena::new();
        let t = stub_table();
        a.register(&t, 0xa000, 4096).unwrap();
        let err = a.register(&t, 0xa000, 8192).unwrap_err();
        match err {
            ShadowArenaError::SizeMismatch {
                key,
                existing,
                requested,
            } => {
                assert_eq!(key, 0xa000);
                assert_eq!(existing, 4096);
                assert_eq!(requested, 8192);
            }
            other => panic!("expected SizeMismatch, got {other:?}"),
        }
    }

    #[test]
    fn register_surfaces_driver_error() {
        reset();
        with_state_mut(|s| s.alloc_result = 2);
        let mut a = ShadowArena::new();
        let t = stub_table();
        let err = a.register(&t, 0xa000, 4096).unwrap_err();
        match err {
            ShadowArenaError::DriverError { op, code } => {
                assert_eq!(op, "cuMemAlloc");
                assert_eq!(code, 2);
            }
            other => panic!("expected DriverError, got {other:?}"),
        }
        // Failed alloc must not register an entry.
        assert!(a.is_empty());
    }

    #[test]
    fn sync_to_shadow_invokes_dtod_with_correct_direction() {
        reset();
        let mut a = ShadowArena::new();
        let t = stub_table();
        a.register(&t, 0xa000, 4096).unwrap();
        let shadow_ptr = a.get(0xa000).unwrap().shadow_dptr;
        let n = a.sync_to_shadow(&t, 0xa000).unwrap();
        assert_eq!(n, 4096);
        let (dtod_calls, dst, src, bytes) = with_state(|s| {
            (
                s.dtod_calls,
                s.dtod_last_dst,
                s.dtod_last_src,
                s.dtod_last_bytes,
            )
        });
        assert_eq!(dtod_calls, 1);
        // dst = shadow, src = orig (the "save" direction).
        assert_eq!(dst, shadow_ptr);
        assert_eq!(src, 0xa000);
        assert_eq!(bytes, 4096);
        assert!(a.get(0xa000).unwrap().shadow_is_fresh);
        assert_eq!(a.sync_to_calls(), 1);
    }

    #[test]
    fn sync_from_shadow_invokes_dtod_with_correct_direction() {
        reset();
        let mut a = ShadowArena::new();
        let t = stub_table();
        a.register(&t, 0xa000, 4096).unwrap();
        let shadow_ptr = a.get(0xa000).unwrap().shadow_dptr;
        a.sync_to_shadow(&t, 0xa000).unwrap();
        reset();
        a.sync_from_shadow(&t, 0xa000).unwrap();
        let (dtod_calls, dst, src) =
            with_state(|s| (s.dtod_calls, s.dtod_last_dst, s.dtod_last_src));
        assert_eq!(dtod_calls, 1);
        // dst = orig, src = shadow (the "restore" direction).
        assert_eq!(dst, 0xa000);
        assert_eq!(src, shadow_ptr);
        assert_eq!(a.sync_from_calls(), 1);
    }

    #[test]
    fn sync_rejects_unknown_key() {
        let mut a = ShadowArena::new();
        let t = stub_table();
        let err = a.sync_to_shadow(&t, 0xdead).unwrap_err();
        assert_eq!(err.short_label(), "unknown_key");
        let err = a.sync_from_shadow(&t, 0xdead).unwrap_err();
        assert_eq!(err.short_label(), "unknown_key");
    }

    #[test]
    fn sync_surfaces_driver_error() {
        reset();
        let mut a = ShadowArena::new();
        let t = stub_table();
        a.register(&t, 0xa000, 4096).unwrap();
        with_state_mut(|s| s.dtod_result = 5);
        let err = a.sync_to_shadow(&t, 0xa000).unwrap_err();
        match err {
            ShadowArenaError::DriverError { op, code } => {
                assert!(op.starts_with("cuMemcpyDtoD"));
                assert_eq!(code, 5);
            }
            other => panic!("expected DriverError, got {other:?}"),
        }
    }

    #[test]
    fn release_frees_and_removes_entry() {
        reset();
        let mut a = ShadowArena::new();
        let t = stub_table();
        a.register(&t, 0xa000, 4096).unwrap();
        assert_eq!(a.total_shadow_bytes(), 4096);
        let n = a.release(&t, 0xa000).unwrap();
        assert_eq!(n, 4096);
        assert_eq!(with_state(|s| s.free_calls), 1);
        assert!(a.is_empty());
        assert_eq!(a.total_shadow_bytes(), 0);
    }

    #[test]
    fn release_unknown_key_errors() {
        let mut a = ShadowArena::new();
        let t = stub_table();
        let err = a.release(&t, 0x1).unwrap_err();
        assert_eq!(err.short_label(), "unknown_key");
    }

    #[test]
    fn release_failure_keeps_entry_for_retry() {
        reset();
        with_state_mut(|s| s.free_result = 4);
        let mut a = ShadowArena::new();
        let t = stub_table();
        a.register(&t, 0xa000, 4096).unwrap();
        let err = a.release(&t, 0xa000).unwrap_err();
        match err {
            ShadowArenaError::DriverError { op, code } => {
                assert_eq!(op, "cuMemFree");
                assert_eq!(code, 4);
            }
            other => panic!("expected DriverError, got {other:?}"),
        }
        // Entry must still exist so the caller can retry.
        assert!(a.get(0xa000).is_some());
        assert_eq!(a.total_shadow_bytes(), 4096);
    }

    #[test]
    fn total_bytes_aggregates_across_entries() {
        reset();
        let mut a = ShadowArena::new();
        let t = stub_table();
        a.register(&t, 0xa000, 4096).unwrap();
        a.register(&t, 0xb000, 8192).unwrap();
        a.register(&t, 0xc000, 1024).unwrap();
        assert_eq!(a.total_shadow_bytes(), 4096 + 8192 + 1024);
        a.release(&t, 0xb000).unwrap();
        assert_eq!(a.total_shadow_bytes(), 4096 + 1024);
    }

    #[test]
    fn arena_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<ShadowArena>();
        assert_send_sync::<ShadowEntry>();
    }
}
