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
// and launch graph plumbing; until that path is fully connected this
// layer records launches and marks managed buffers dirty so snapshots
// remain conservative.

#![cfg(feature = "gpu-hmr")]

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr};
use std::sync::{Mutex, OnceLock};

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
    pub grid_size: usize,
    pub block_size: usize,
    pub shared_bytes: usize,
    pub stream_token: usize,
    pub arg_count: usize,
}

#[derive(Debug, Default)]
struct BoundaryState {
    buffers_by_ptr: HashMap<usize, ManagedBufferRecord>,
    ptr_by_name: HashMap<String, usize>,
    launches: Vec<LaunchRecord>,
}

static STATE: OnceLock<Mutex<BoundaryState>> = OnceLock::new();

fn state() -> &'static Mutex<BoundaryState> {
    STATE.get_or_init(|| Mutex::new(BoundaryState::default()))
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
pub extern "C" fn synthi_gpu_launch_raw(
    _gpu: *mut c_void,
    kernel_name: *const c_char,
    _grid: *const c_void,
    grid_size: usize,
    _block: *const c_void,
    block_size: usize,
    shared_bytes: usize,
    stream_token: usize,
    _args: *const *const c_void,
    arg_count: usize,
) -> bool {
    let kernel_name = cstr(kernel_name).unwrap_or_else(|| "<unknown>".to_string());
    let mut guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    for record in guard.buffers_by_ptr.values_mut() {
        // Until launch-graph write-set inference is connected, every launch
        // conservatively dirties every Synthi-managed buffer.
        record.dirty = true;
    }
    guard.launches.push(LaunchRecord {
        kernel_name: kernel_name.clone(),
        grid_size,
        block_size,
        shared_bytes,
        stream_token,
        arg_count,
    });

    eprintln!(
        "[gpu-runtime-boundary] synthi_gpu_launch kernel={} args={} stream={} shared_bytes={}",
        kernel_name, arg_count, stream_token, shared_bytes
    );
    true
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

#[cfg(test)]
pub fn reset_for_test() {
    let mut guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    *guard = BoundaryState::default();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::sync::{MutexGuard, OnceLock};

    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn test_guard() -> MutexGuard<'static, ()> {
        TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("gpu runtime boundary test mutex poisoned")
    }

    #[test]
    fn register_pack_and_restore_managed_buffer() {
        let _guard = test_guard();
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
        let _guard = test_guard();
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
        let ok = synthi_gpu_launch_raw(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            std::ptr::null(),
            12,
            std::ptr::null(),
            12,
            0,
            99,
            std::ptr::null(),
            4,
        );

        assert!(ok);
        let launches = launch_records_snapshot();
        assert_eq!(launches.len(), 1);
        assert_eq!(launches[0].kernel_name, "vec_add");
        assert_eq!(launches[0].arg_count, 4);
        assert!(managed_buffers_snapshot()[0].dirty);
    }
}
