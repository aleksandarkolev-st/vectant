// ============================================================
// GPU STREAM DRAIN (Phase 2 scaffold)
// ============================================================
//
// Spec: docs/GPU_HMR_ULTRAPLAN.md §5.4 ("drain step").
//
// Before a module swap can land we need to know every kernel
// launched against the old image has finished. The driver
// offers two granularities:
//
//   • `cuStreamSynchronize(stream)` — bounded to one stream.
//   • `cuCtxSynchronize()` — every stream in the current
//     context.
//
// Both are blocking calls. Phase 2 wraps them in a bounded
// drain helper that:
//
//   • Times the drain against a wall-clock budget.
//   • Records whether the drain came home (Synced) or the budget
//     was exhausted (TimedOut). A TimedOut outcome lets the
//     planner choose between forcing the swap anyway (potential
//     undefined behaviour) or falling back to cold restart.
//
// Phase 2 does *not* implement the driver-side cancellation —
// CUDA has no public stream-abort API. The drain helper is the
// budget enforcer for the §5.4 telemetry; surfacing TimedOut is
// enough to drive the planner's decision.
//
// Feature-gated by `gpu-hmr`.

#![cfg(feature = "gpu-hmr")]

use std::time::Instant;

use crate::hmr::gpu_driver_loader::{CuResult, CuStream, GpuDriverSymbolTable};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrainScope {
    Context,
    Stream,
}

impl DrainScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Context => "context",
            Self::Stream => "stream",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DrainOutcome {
    /// Drain returned before the budget expired.
    Synced {
        scope: DrainScope,
        elapsed_ms: u64,
        budget_ms: u64,
    },
    /// Budget expired before the drain returned. The caller
    /// decides whether to escalate.
    TimedOut {
        scope: DrainScope,
        elapsed_ms: u64,
        budget_ms: u64,
    },
    /// Driver returned non-zero from the synchronize call.
    DriverError {
        scope: DrainScope,
        elapsed_ms: u64,
        op: &'static str,
        code: CuResult,
    },
}

impl DrainOutcome {
    pub fn is_synced(&self) -> bool {
        matches!(self, Self::Synced { .. })
    }

    pub fn elapsed_ms(&self) -> u64 {
        match self {
            Self::Synced { elapsed_ms, .. } => *elapsed_ms,
            Self::TimedOut { elapsed_ms, .. } => *elapsed_ms,
            Self::DriverError { elapsed_ms, .. } => *elapsed_ms,
        }
    }

    pub fn budget_ms(&self) -> Option<u64> {
        match self {
            Self::Synced { budget_ms, .. } => Some(*budget_ms),
            Self::TimedOut { budget_ms, .. } => Some(*budget_ms),
            Self::DriverError { .. } => None,
        }
    }

    pub fn short_label(&self) -> &'static str {
        match self {
            Self::Synced { .. } => "synced",
            Self::TimedOut { .. } => "timed_out",
            Self::DriverError { .. } => "driver_error",
        }
    }
}

/// Optional clock injection so unit tests can time-travel
/// without sleeping for real.
#[derive(Clone, Copy)]
pub enum DrainClock<'a> {
    Wall,
    Synthetic(&'a dyn Fn() -> u64),
}

impl<'a> DrainClock<'a> {
    pub fn now_ms(&self, started: Instant) -> u64 {
        match self {
            Self::Wall => started.elapsed().as_millis() as u64,
            Self::Synthetic(f) => f(),
        }
    }
}

/// Drains all streams in the current context via
/// `cuCtxSynchronize`. The call is blocking; budget enforcement
/// is post-hoc — if the driver returns within the budget we
/// report Synced, otherwise TimedOut. Returns the outcome by
/// value so callers can log it as a single line.
pub fn drain_context(
    symbols: &GpuDriverSymbolTable,
    budget_ms: u64,
) -> DrainOutcome {
    drain_context_with_clock(symbols, budget_ms, DrainClock::Wall)
}

pub fn drain_context_with_clock(
    symbols: &GpuDriverSymbolTable,
    budget_ms: u64,
    clock: DrainClock,
) -> DrainOutcome {
    let started = Instant::now();
    // SAFETY: `cuCtxSynchronize` takes no arguments and operates
    // on the calling thread's context.
    let code = unsafe { (symbols.cu_ctx_synchronize)() };
    let elapsed_ms = clock.now_ms(started);
    if code != 0 {
        return DrainOutcome::DriverError {
            scope: DrainScope::Context,
            elapsed_ms,
            op: "cuCtxSynchronize",
            code,
        };
    }
    if elapsed_ms > budget_ms {
        DrainOutcome::TimedOut {
            scope: DrainScope::Context,
            elapsed_ms,
            budget_ms,
        }
    } else {
        DrainOutcome::Synced {
            scope: DrainScope::Context,
            elapsed_ms,
            budget_ms,
        }
    }
}

/// Drains a single stream via `cuStreamSynchronize`. Same
/// budget semantics as `drain_context`.
pub fn drain_stream(
    symbols: &GpuDriverSymbolTable,
    stream: CuStream,
    budget_ms: u64,
) -> DrainOutcome {
    drain_stream_with_clock(symbols, stream, budget_ms, DrainClock::Wall)
}

pub fn drain_stream_with_clock(
    symbols: &GpuDriverSymbolTable,
    stream: CuStream,
    budget_ms: u64,
    clock: DrainClock,
) -> DrainOutcome {
    let started = Instant::now();
    // SAFETY: stream pointer comes from the caller's context; a
    // null stream is the documented "default stream" sentinel,
    // which cuStreamSynchronize accepts.
    let code = unsafe { (symbols.cu_stream_synchronize)(stream) };
    let elapsed_ms = clock.now_ms(started);
    if code != 0 {
        return DrainOutcome::DriverError {
            scope: DrainScope::Stream,
            elapsed_ms,
            op: "cuStreamSynchronize",
            code,
        };
    }
    if elapsed_ms > budget_ms {
        DrainOutcome::TimedOut {
            scope: DrainScope::Stream,
            elapsed_ms,
            budget_ms,
        }
    } else {
        DrainOutcome::Synced {
            scope: DrainScope::Stream,
            elapsed_ms,
            budget_ms,
        }
    }
}

// ── Tests ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};

    static CTX_CALLS: AtomicU64 = AtomicU64::new(0);
    static STREAM_CALLS: AtomicU64 = AtomicU64::new(0);
    static CTX_RESULT: AtomicI32 = AtomicI32::new(0);
    static STREAM_RESULT: AtomicI32 = AtomicI32::new(0);

    unsafe extern "C" fn stub_ctx_sync() -> CuResult {
        CTX_CALLS.fetch_add(1, Ordering::SeqCst);
        CTX_RESULT.load(Ordering::SeqCst)
    }
    unsafe extern "C" fn stub_stream_sync(_s: *mut c_void) -> CuResult {
        STREAM_CALLS.fetch_add(1, Ordering::SeqCst);
        STREAM_RESULT.load(Ordering::SeqCst)
    }
    // Unused stubs.
    unsafe extern "C" fn stub_init(_f: u32) -> CuResult { 0 }
    unsafe extern "C" fn stub_device_get(_d: *mut i32, _o: i32) -> CuResult { 0 }
    unsafe extern "C" fn stub_ctx_get(_c: *mut *mut c_void) -> CuResult { 0 }
    unsafe extern "C" fn stub_load_data(_m: *mut *mut c_void, _i: *const c_void) -> CuResult { 0 }
    unsafe extern "C" fn stub_unload(_m: *mut c_void) -> CuResult { 0 }
    unsafe extern "C" fn stub_get_function(_h: *mut *mut c_void, _m: *mut c_void, _n: *const u8) -> CuResult { 0 }
    unsafe extern "C" fn stub_alloc(_p: *mut u64, _b: usize) -> CuResult { 0 }
    unsafe extern "C" fn stub_free(_p: u64) -> CuResult { 0 }
    unsafe extern "C" fn stub_dtod(_d: u64, _s: u64, _b: usize) -> CuResult { 0 }

    fn stub_table() -> GpuDriverSymbolTable {
        GpuDriverSymbolTable {
            cu_init: stub_init,
            cu_device_get: stub_device_get,
            cu_ctx_get_current: stub_ctx_get,
            cu_module_load_data: stub_load_data,
            cu_module_unload: stub_unload,
            cu_module_get_function: stub_get_function,
            cu_ctx_synchronize: stub_ctx_sync,
            cu_stream_synchronize: stub_stream_sync,
            cu_mem_alloc: stub_alloc,
            cu_mem_free: stub_free,
            cu_memcpy_dtod: stub_dtod,
        }
    }

    fn reset() {
        CTX_CALLS.store(0, Ordering::SeqCst);
        STREAM_CALLS.store(0, Ordering::SeqCst);
        CTX_RESULT.store(0, Ordering::SeqCst);
        STREAM_RESULT.store(0, Ordering::SeqCst);
    }

    #[test]
    fn drain_scope_labels() {
        assert_eq!(DrainScope::Context.as_str(), "context");
        assert_eq!(DrainScope::Stream.as_str(), "stream");
    }

    #[test]
    fn drain_context_invokes_driver_and_reports_synced_within_budget() {
        reset();
        let t = stub_table();
        // Synthetic clock claims 5 ms elapsed regardless of
        // wall time. Budget 100 → Synced.
        let now = || 5u64;
        let r = drain_context_with_clock(&t, 100, DrainClock::Synthetic(&now));
        assert_eq!(CTX_CALLS.load(Ordering::SeqCst), 1);
        assert!(r.is_synced(), "got {r:?}");
        assert_eq!(r.elapsed_ms(), 5);
        assert_eq!(r.budget_ms(), Some(100));
        assert_eq!(r.short_label(), "synced");
    }

    #[test]
    fn drain_context_reports_timed_out_when_clock_exceeds_budget() {
        reset();
        let t = stub_table();
        let now = || 250u64;
        let r = drain_context_with_clock(&t, 100, DrainClock::Synthetic(&now));
        match r {
            DrainOutcome::TimedOut { scope, elapsed_ms, budget_ms } => {
                assert_eq!(scope, DrainScope::Context);
                assert_eq!(elapsed_ms, 250);
                assert_eq!(budget_ms, 100);
            }
            other => panic!("expected TimedOut, got {other:?}"),
        }
    }

    #[test]
    fn drain_context_reports_driver_error() {
        reset();
        CTX_RESULT.store(3, Ordering::SeqCst);
        let t = stub_table();
        let now = || 12u64;
        let r = drain_context_with_clock(&t, 100, DrainClock::Synthetic(&now));
        match r {
            DrainOutcome::DriverError { scope, elapsed_ms, op, code } => {
                assert_eq!(scope, DrainScope::Context);
                assert_eq!(elapsed_ms, 12);
                assert_eq!(op, "cuCtxSynchronize");
                assert_eq!(code, 3);
            }
            other => panic!("expected DriverError, got {other:?}"),
        }
        // DriverError omits budget so the planner can't
        // accidentally treat it as a soft timeout.
        let r_short = match r {
            DrainOutcome::DriverError { .. } => "driver_error",
            _ => "x",
        };
        assert_eq!(r_short, "driver_error");
    }

    #[test]
    fn drain_stream_invokes_driver_and_records_stream_scope() {
        reset();
        let t = stub_table();
        let now = || 7u64;
        let r = drain_stream_with_clock(&t, std::ptr::null_mut(), 50, DrainClock::Synthetic(&now));
        assert_eq!(STREAM_CALLS.load(Ordering::SeqCst), 1);
        match r {
            DrainOutcome::Synced { scope, elapsed_ms, budget_ms } => {
                assert_eq!(scope, DrainScope::Stream);
                assert_eq!(elapsed_ms, 7);
                assert_eq!(budget_ms, 50);
            }
            other => panic!("expected Synced, got {other:?}"),
        }
    }

    #[test]
    fn drain_stream_propagates_driver_error() {
        reset();
        STREAM_RESULT.store(11, Ordering::SeqCst);
        let t = stub_table();
        let r = drain_stream_with_clock(
            &t,
            std::ptr::null_mut(),
            100,
            DrainClock::Synthetic(&|| 0),
        );
        match r {
            DrainOutcome::DriverError { scope, op, code, .. } => {
                assert_eq!(scope, DrainScope::Stream);
                assert_eq!(op, "cuStreamSynchronize");
                assert_eq!(code, 11);
            }
            other => panic!("expected DriverError, got {other:?}"),
        }
    }

    #[test]
    fn budget_zero_means_timed_out_unless_instant() {
        reset();
        let t = stub_table();
        // Synthetic 1 ms with budget 0 → TimedOut.
        let r1 = drain_context_with_clock(&t, 0, DrainClock::Synthetic(&|| 1));
        assert!(matches!(r1, DrainOutcome::TimedOut { .. }));
        // Synthetic 0 ms with budget 0 → Synced (boundary case).
        let r2 = drain_context_with_clock(&t, 0, DrainClock::Synthetic(&|| 0));
        assert!(matches!(r2, DrainOutcome::Synced { .. }));
    }

    #[test]
    fn drain_outcome_short_labels() {
        let s = DrainOutcome::Synced { scope: DrainScope::Context, elapsed_ms: 1, budget_ms: 10 };
        let t = DrainOutcome::TimedOut { scope: DrainScope::Stream, elapsed_ms: 10, budget_ms: 5 };
        let d = DrainOutcome::DriverError {
            scope: DrainScope::Context,
            elapsed_ms: 1,
            op: "cuCtxSynchronize",
            code: 7,
        };
        assert_eq!(s.short_label(), "synced");
        assert_eq!(t.short_label(), "timed_out");
        assert_eq!(d.short_label(), "driver_error");
        assert_eq!(d.budget_ms(), None);
        assert_eq!(s.budget_ms(), Some(10));
    }

    #[test]
    fn drain_helpers_are_send_safe() {
        // The helpers themselves are functions, not types — but
        // their inputs (symbol table + stream pointer-as-u64)
        // must support being shared across threads if the
        // adapter is going to use them from a worker thread.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<DrainOutcome>();
        assert_send_sync::<DrainScope>();
    }

    #[test]
    fn wall_clock_works_for_default_path() {
        // Smoke test that the non-synthetic path actually
        // returns. Doesn't assert latency because CI is noisy.
        reset();
        let t = stub_table();
        let r = drain_context(&t, 1_000);
        assert!(matches!(r, DrainOutcome::Synced { .. }));
        let r = drain_stream(&t, std::ptr::null_mut(), 1_000);
        assert!(matches!(r, DrainOutcome::Synced { .. }));
    }
}
