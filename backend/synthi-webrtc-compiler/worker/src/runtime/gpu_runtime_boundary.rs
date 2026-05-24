// ============================================================
// SYNTHI GPU RUNTIME C ABI BOUNDARY
// ============================================================
//
// The worker-generated `synthi_gpu_runtime.h` declares these symbols
// for agent-rewritten host modules. This file backs that contract on
// the Rust side: modules can register Synthi-managed device buffers,
// report launch requests through `synthi_gpu_launch(...)`, and look up
// managed buffers during save/restore.
//
// Phase scope: this is the ABI boundary and registry. The actual
// CUfunction/HIP-function invocation is owned by the GPU module adapter
// and launch graph plumbing. This layer records launches, marks managed
// buffers dirty so snapshots remain conservative, and fails fast when no
// device sidecar dispatcher has been installed.

#![cfg(feature = "gpu-hmr")]

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedBufferRecord {
    pub ptr: usize,
    pub bytes: usize,
    pub semantic_name: Option<String>,
    pub lifetime_hint: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchRecord {
    pub kernel_name: String,
    pub grid: (u32, u32, u32),
    pub block: (u32, u32, u32),
    pub grid_size: usize,
    pub block_size: usize,
    pub shared_bytes: usize,
    pub stream_token: usize,
    pub arg_count: usize,
    pub expected_generation: u64,
    pub active_generation: u64,
    pub dispatched: bool,
    pub dispatch_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuLaunchRequest {
    pub kernel_name: String,
    pub grid: (u32, u32, u32),
    pub block: (u32, u32, u32),
    pub shared_bytes: usize,
    pub stream_token: usize,
    pub arg_count: usize,
}

pub trait GpuLaunchDispatcher: Send + Sync {
    fn dispatch(
        &self,
        request: &GpuLaunchRequest,
        args: *const *const c_void,
    ) -> Result<(), String>;
}

#[derive(Debug, Default)]
struct BoundaryState {
    buffers_by_ptr: HashMap<usize, ManagedBufferRecord>,
    ptr_by_name: HashMap<String, usize>,
    launches: Vec<LaunchRecord>,
}

static STATE: OnceLock<Mutex<BoundaryState>> = OnceLock::new();
static DISPATCHER: OnceLock<Mutex<Option<Arc<dyn GpuLaunchDispatcher>>>> = OnceLock::new();
static LAUNCH_GENERATION: AtomicU64 = AtomicU64::new(1);
#[cfg(test)]
static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn state() -> &'static Mutex<BoundaryState> {
    STATE.get_or_init(|| Mutex::new(BoundaryState::default()))
}

fn dispatcher_slot() -> &'static Mutex<Option<Arc<dyn GpuLaunchDispatcher>>> {
    DISPATCHER.get_or_init(|| Mutex::new(None))
}

pub fn install_launch_dispatcher(
    dispatcher: Arc<dyn GpuLaunchDispatcher>,
) -> Option<Arc<dyn GpuLaunchDispatcher>> {
    let mut guard = dispatcher_slot()
        .lock()
        .expect("gpu runtime dispatcher mutex poisoned");
    let previous = guard.replace(dispatcher);
    LAUNCH_GENERATION.fetch_add(1, Ordering::SeqCst);
    previous
}

pub fn clear_launch_dispatcher() -> Option<Arc<dyn GpuLaunchDispatcher>> {
    let mut guard = dispatcher_slot()
        .lock()
        .expect("gpu runtime dispatcher mutex poisoned");
    let previous = guard.take();
    LAUNCH_GENERATION.fetch_add(1, Ordering::SeqCst);
    previous
}

pub fn current_launch_generation() -> u64 {
    LAUNCH_GENERATION.load(Ordering::SeqCst)
}

fn cstr(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn clamp_dim(value: u64) -> u32 {
    value.max(1).min(u32::MAX as u64) as u32
}

fn read_launch_dims(ptr: *const c_void, bytes: usize) -> (u32, u32, u32) {
    if ptr.is_null() || bytes == 0 {
        return (1, 1, 1);
    }

    unsafe {
        if bytes >= 12 {
            let p = ptr as *const u32;
            return (
                clamp_dim(std::ptr::read_unaligned(p) as u64),
                clamp_dim(std::ptr::read_unaligned(p.add(1)) as u64),
                clamp_dim(std::ptr::read_unaligned(p.add(2)) as u64),
            );
        }
        if bytes >= std::mem::size_of::<usize>() {
            let n = std::ptr::read_unaligned(ptr as *const usize);
            return (clamp_dim(n as u64), 1, 1);
        }
        if bytes >= std::mem::size_of::<u32>() {
            let n = std::ptr::read_unaligned(ptr as *const u32);
            return (clamp_dim(n as u64), 1, 1);
        }
    }

    (1, 1, 1)
}

#[no_mangle]
pub extern "C" fn synthi_gpu_register_buffer(
    _gpu: *mut c_void,
    ptr: *mut c_void,
    bytes: usize,
    semantic_name: *const c_char,
    lifetime_hint: *const c_char,
) {
    if ptr.is_null() || bytes == 0 {
        eprintln!(
            "[gpu-runtime-boundary] ignoring invalid buffer registration ptr={ptr:p} bytes={bytes}"
        );
        return;
    }

    let semantic_name = cstr(semantic_name);
    let lifetime_hint = cstr(lifetime_hint);
    let key = ptr as usize;
    let mut guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    guard.buffers_by_ptr.insert(
        key,
        ManagedBufferRecord {
            ptr: key,
            bytes,
            semantic_name: semantic_name.clone(),
            lifetime_hint: lifetime_hint.clone(),
            dirty: true,
        },
    );
    if let Some(name) = &semantic_name {
        guard.ptr_by_name.insert(name.clone(), key);
    }

    eprintln!(
        "[gpu-runtime-boundary] registered buffer name={} ptr=0x{:x} bytes={} lifetime={}",
        semantic_name.as_deref().unwrap_or("<unnamed>"),
        key,
        bytes,
        lifetime_hint.as_deref().unwrap_or("<unset>")
    );
}

#[no_mangle]
pub extern "C" fn synthi_gpu_launch_generation() -> u64 {
    current_launch_generation()
}

#[no_mangle]
pub extern "C" fn synthi_gpu_launch_raw_checked(
    _gpu: *mut c_void,
    kernel_name: *const c_char,
    _grid: *const c_void,
    grid_size: usize,
    _block: *const c_void,
    block_size: usize,
    shared_bytes: usize,
    stream_token: usize,
    args: *const *const c_void,
    arg_count: usize,
    expected_generation: u64,
) -> bool {
    synthi_gpu_launch_raw_impl(
        _gpu,
        kernel_name,
        _grid,
        grid_size,
        _block,
        block_size,
        shared_bytes,
        stream_token,
        args,
        arg_count,
        expected_generation,
    )
}

#[no_mangle]
pub extern "C" fn synthi_gpu_launch_raw(
    _gpu: *mut c_void,
    kernel_name: *const c_char,
    _grid: *const c_void,
    grid_size: usize,
    _block: *const c_void,
    block_size: usize,
    shared_bytes: usize,
    stream_token: usize,
    args: *const *const c_void,
    arg_count: usize,
) -> bool {
    synthi_gpu_launch_raw_impl(
        _gpu,
        kernel_name,
        _grid,
        grid_size,
        _block,
        block_size,
        shared_bytes,
        stream_token,
        args,
        arg_count,
        current_launch_generation(),
    )
}

fn synthi_gpu_launch_raw_impl(
    _gpu: *mut c_void,
    kernel_name: *const c_char,
    _grid: *const c_void,
    grid_size: usize,
    _block: *const c_void,
    block_size: usize,
    shared_bytes: usize,
    stream_token: usize,
    args: *const *const c_void,
    arg_count: usize,
    expected_generation: u64,
) -> bool {
    let kernel_name = cstr(kernel_name).unwrap_or_else(|| "<unknown>".to_string());
    let grid = read_launch_dims(_grid, grid_size);
    let block = read_launch_dims(_block, block_size);
    let active_generation = current_launch_generation();
    let stale_generation = expected_generation != 0 && expected_generation != active_generation;
    let request = GpuLaunchRequest {
        kernel_name: kernel_name.clone(),
        grid,
        block,
        shared_bytes,
        stream_token,
        arg_count,
    };

    let (launch_index, dispatcher) = {
        let mut guard = state().lock().expect("gpu runtime boundary mutex poisoned");
        for record in guard.buffers_by_ptr.values_mut() {
            // Until launch-graph write-set inference is connected, every launch
            // conservatively dirties every Synthi-managed buffer.
            record.dirty = true;
        }
        let launch_index = guard.launches.len();
        guard.launches.push(LaunchRecord {
            kernel_name: kernel_name.clone(),
            grid,
            block,
            grid_size,
            block_size,
            shared_bytes,
            stream_token,
            arg_count,
            expected_generation,
            active_generation,
            dispatched: false,
            dispatch_error: None,
        });
        let dispatcher = if stale_generation {
            None
        } else {
            dispatcher_slot()
                .lock()
                .expect("gpu runtime dispatcher mutex poisoned")
                .clone()
        };
        (launch_index, dispatcher)
    };

    let dispatch_result = if stale_generation {
        Some(Err("reload_failed.stale_launch_pointer".to_string()))
    } else {
        dispatcher.as_ref().map(|d| d.dispatch(&request, args))
    };

    let mut guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    if let Some(record) = guard.launches.get_mut(launch_index) {
        match dispatch_result {
            Some(Ok(())) => {
                record.dispatched = true;
            }
            Some(Err(e)) => {
                record.dispatch_error = Some(e);
            }
            None => {
                record.dispatch_error = Some("no GPU launch dispatcher installed".to_string());
            }
        }
    }
    drop(guard);

    let (ok, dispatch_error) = {
        let guard = state().lock().expect("gpu runtime boundary mutex poisoned");
        match guard.launches.get(launch_index) {
            Some(record) => (record.dispatch_error.is_none(), record.dispatch_error.clone()),
            None => (false, Some("launch record disappeared".to_string())),
        }
    };
    let dispatch_label = if stale_generation {
        "stale-pointer"
    } else if dispatcher.is_some() {
        if ok {
            "ok"
        } else {
            "failed"
        }
    } else {
        "missing-dispatcher"
    };

    if let Some(error) = dispatch_error.as_deref() {
        eprintln!(
            "[gpu-runtime-boundary] synthi_gpu_launch kernel={} grid={:?} block={:?} args={} stream={} shared_bytes={} dispatch={} error={}",
            kernel_name,
            grid,
            block,
            arg_count,
            stream_token,
            shared_bytes,
            dispatch_label,
            log_safe(error)
        );
    } else {
        eprintln!(
            "[gpu-runtime-boundary] synthi_gpu_launch kernel={} grid={:?} block={:?} args={} stream={} shared_bytes={} dispatch={}",
            kernel_name,
            grid,
            block,
            arg_count,
            stream_token,
            shared_bytes,
            dispatch_label
        );
    }
    ok
}

#[no_mangle]
pub extern "C" fn synthi_gpu_pack_buffer(
    semantic_name: *const c_char,
    ptr: *const c_void,
    bytes: usize,
) -> bool {
    let semantic_name = cstr(semantic_name);
    let key = ptr as usize;
    let guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    let known = semantic_name
        .as_ref()
        .and_then(|name| guard.ptr_by_name.get(name))
        .copied()
        .or_else(|| guard.buffers_by_ptr.get(&key).map(|record| record.ptr));
    let ok = known.is_some() && bytes > 0;
    eprintln!(
        "[gpu-runtime-boundary] pack buffer name={} ptr=0x{:x} bytes={} ok={}",
        semantic_name.as_deref().unwrap_or("<unnamed>"),
        key,
        bytes,
        ok
    );
    ok
}

#[no_mangle]
pub extern "C" fn synthi_gpu_restore_buffer(
    _blob: *const u8,
    semantic_name: *const c_char,
    out_ptr: *mut *mut c_void,
) -> bool {
    if out_ptr.is_null() {
        return false;
    }
    let Some(name) = cstr(semantic_name) else {
        return false;
    };
    let guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    let Some(ptr) = guard.ptr_by_name.get(&name).copied() else {
        return false;
    };
    unsafe {
        *out_ptr = ptr as *mut c_void;
    }
    eprintln!(
        "[gpu-runtime-boundary] restore buffer name={} ptr=0x{:x} ok=true",
        name, ptr
    );
    true
}

pub fn managed_buffers_snapshot() -> Vec<ManagedBufferRecord> {
    let guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    guard.buffers_by_ptr.values().cloned().collect()
}

pub fn launch_records_snapshot() -> Vec<LaunchRecord> {
    let guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    guard.launches.clone()
}

pub fn launch_record_count() -> usize {
    let guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    guard.launches.len()
}

pub fn failed_launch_records_since(start: usize) -> Vec<LaunchRecord> {
    let guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    guard
        .launches
        .iter()
        .skip(start)
        .filter(|record| record.dispatch_error.is_some())
        .cloned()
        .collect()
}

fn log_safe(value: &str) -> String {
    value
        .chars()
        .map(|ch| match ch {
            '\r' | '\n' | '\t' => ' ',
            other => other,
        })
        .collect()
}

#[cfg(test)]
pub fn reset_for_test() {
    let mut guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    *guard = BoundaryState::default();
    clear_launch_dispatcher();
    LAUNCH_GENERATION.store(1, Ordering::SeqCst);
}

#[cfg(test)]
pub fn test_guard_for_test() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("gpu runtime boundary test mutex poisoned")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::sync::Arc;

    #[test]
    fn register_pack_and_restore_managed_buffer() {
        let _guard = test_guard_for_test();
        reset_for_test();
        let mut value = 42_u32;
        let name = CString::new("positions").unwrap();
        let lifetime = CString::new("persistent").unwrap();

        synthi_gpu_register_buffer(
            std::ptr::null_mut(),
            (&mut value as *mut u32).cast(),
            std::mem::size_of_val(&value),
            name.as_ptr(),
            lifetime.as_ptr(),
        );

        let buffers = managed_buffers_snapshot();
        assert_eq!(buffers.len(), 1);
        assert_eq!(buffers[0].semantic_name.as_deref(), Some("positions"));
        assert_eq!(buffers[0].lifetime_hint.as_deref(), Some("persistent"));
        assert!(synthi_gpu_pack_buffer(
            name.as_ptr(),
            (&value as *const u32).cast(),
            std::mem::size_of_val(&value)
        ));

        let mut restored: *mut c_void = std::ptr::null_mut();
        assert!(synthi_gpu_restore_buffer(
            std::ptr::null(),
            name.as_ptr(),
            &mut restored,
        ));
        assert_eq!(restored, (&mut value as *mut u32).cast());
    }

    #[test]
    fn launch_records_boundary_call_and_dirties_buffers() {
        let _guard = test_guard_for_test();
        reset_for_test();
        let mut value = 7_u32;
        let name = CString::new("velocities").unwrap();
        synthi_gpu_register_buffer(
            std::ptr::null_mut(),
            (&mut value as *mut u32).cast(),
            std::mem::size_of_val(&value),
            name.as_ptr(),
            std::ptr::null(),
        );

        let kernel = CString::new("vec_add").unwrap();
        let grid = [12_u32, 2, 1];
        let block = 256_u32;
        let ok = synthi_gpu_launch_raw(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            grid.as_ptr().cast(),
            std::mem::size_of_val(&grid),
            (&block as *const u32).cast(),
            std::mem::size_of_val(&block),
            0,
            99,
            std::ptr::null(),
            4,
        );

        assert!(!ok);
        let launches = launch_records_snapshot();
        assert_eq!(launches.len(), 1);
        assert_eq!(launches[0].kernel_name, "vec_add");
        assert_eq!(launches[0].grid, (12, 2, 1));
        assert_eq!(launches[0].block, (256, 1, 1));
        assert_eq!(launches[0].arg_count, 4);
        assert!(!launches[0].dispatched);
        assert_eq!(
            launches[0].dispatch_error.as_deref(),
            Some("no GPU launch dispatcher installed")
        );
        assert!(managed_buffers_snapshot()[0].dirty);
    }

    struct TestDispatcher {
        should_fail: bool,
        calls: std::sync::Arc<Mutex<Vec<GpuLaunchRequest>>>,
    }

    impl GpuLaunchDispatcher for TestDispatcher {
        fn dispatch(
            &self,
            request: &GpuLaunchRequest,
            _args: *const *const c_void,
        ) -> Result<(), String> {
            self.calls.lock().unwrap().push(request.clone());
            if self.should_fail {
                Err("synthetic launch failure".into())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn launch_dispatcher_receives_decoded_dimensions() {
        let _guard = test_guard_for_test();
        reset_for_test();
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        let before = synthi_gpu_launch_generation();
        install_launch_dispatcher(Arc::new(TestDispatcher {
            should_fail: false,
            calls: calls.clone(),
        }));
        assert!(synthi_gpu_launch_generation() > before);

        let kernel = CString::new("gemm").unwrap();
        let grid = [8_u32, 4, 1];
        let block = [16_u32, 16, 1];
        assert!(synthi_gpu_launch_raw(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            grid.as_ptr().cast(),
            std::mem::size_of_val(&grid),
            block.as_ptr().cast(),
            std::mem::size_of_val(&block),
            512,
            0xfeed,
            std::ptr::null(),
            6,
        ));

        let seen = calls.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].kernel_name, "gemm");
        assert_eq!(seen[0].grid, (8, 4, 1));
        assert_eq!(seen[0].block, (16, 16, 1));
        assert_eq!(seen[0].shared_bytes, 512);
        assert_eq!(seen[0].stream_token, 0xfeed);

        let launches = launch_records_snapshot();
        assert!(launches[0].dispatched);
        assert!(launches[0].dispatch_error.is_none());
        assert_eq!(
            launches[0].expected_generation,
            launches[0].active_generation
        );
    }

    #[test]
    fn launch_dispatcher_failure_returns_false_and_records_error() {
        let _guard = test_guard_for_test();
        reset_for_test();
        install_launch_dispatcher(Arc::new(TestDispatcher {
            should_fail: true,
            calls: std::sync::Arc::new(Mutex::new(Vec::new())),
        }));

        let kernel = CString::new("bad").unwrap();
        let grid = 1_u32;
        let ok = synthi_gpu_launch_raw(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            (&grid as *const u32).cast(),
            std::mem::size_of_val(&grid),
            (&grid as *const u32).cast(),
            std::mem::size_of_val(&grid),
            0,
            0,
            std::ptr::null(),
            0,
        );

        assert!(!ok);
        assert_eq!(launch_record_count(), 1);
        let failed = failed_launch_records_since(0);
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].kernel_name, "bad");
        assert!(failed_launch_records_since(1).is_empty());
        let launches = launch_records_snapshot();
        assert!(!launches[0].dispatched);
        assert_eq!(
            launches[0].dispatch_error.as_deref(),
            Some("synthetic launch failure")
        );
    }

    #[test]
    fn checked_launch_rejects_stale_generation() {
        let _guard = test_guard_for_test();
        reset_for_test();
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        install_launch_dispatcher(Arc::new(TestDispatcher {
            should_fail: false,
            calls: calls.clone(),
        }));
        let stale_generation = synthi_gpu_launch_generation();
        install_launch_dispatcher(Arc::new(TestDispatcher {
            should_fail: false,
            calls: calls.clone(),
        }));

        let kernel = CString::new("stale").unwrap();
        let dim = 1_u32;
        let ok = synthi_gpu_launch_raw_checked(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            0,
            0,
            std::ptr::null(),
            0,
            stale_generation,
        );

        assert!(!ok);
        assert!(calls.lock().unwrap().is_empty());
        let launches = launch_records_snapshot();
        assert_eq!(
            launches[0].dispatch_error.as_deref(),
            Some("reload_failed.stale_launch_pointer")
        );
        assert_ne!(
            launches[0].expected_generation,
            launches[0].active_generation
        );
    }
}
