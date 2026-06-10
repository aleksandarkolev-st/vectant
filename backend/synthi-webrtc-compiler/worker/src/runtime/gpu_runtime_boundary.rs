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

use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_void, CStr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::runtime::capability::HmrStatus;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedBufferRecord {
    pub ptr: usize,
    pub bytes: usize,
    pub allocation_id: String,
    pub semantic_name: Option<String>,
    pub lifetime_hint: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchArgProvenance {
    pub index: usize,
    pub value_ptr: usize,
    pub value_size: usize,
    pub value_kind: u32,
    pub value_bytes: Option<Vec<u8>>,
    pub observed_value: Option<usize>,
    pub kind: String,
    pub allocation_id: Option<String>,
    pub allocation_name: Option<String>,
    pub allocation_ptr: Option<usize>,
    pub allocation_bytes: Option<usize>,
    pub allocation_offset: Option<usize>,
}

#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct SynthiGpuLaunchArg {
    pub value_ptr: *const c_void,
    pub value_size: usize,
    pub value_kind: u32,
}

pub const SYNTHI_GPU_ARG_KIND_UNKNOWN: u32 = 0;
pub const SYNTHI_GPU_ARG_KIND_POINTER: u32 = 1;
pub const SYNTHI_GPU_ARG_KIND_INTEGER: u32 = 2;
pub const SYNTHI_GPU_ARG_KIND_FLOATING: u32 = 3;
pub const SYNTHI_GPU_ARG_KIND_ENUM: u32 = 4;
pub const SYNTHI_GPU_ARG_KIND_AGGREGATE: u32 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchRecord {
    pub runtime_session_id: String,
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
    pub active_artifact_id: Option<String>,
    pub dispatcher_registration_id: Option<String>,
    pub dispatch_table_hash: Option<String>,
    pub dispatch_table_entry_id: Option<String>,
    pub arg_provenance: Vec<LaunchArgProvenance>,
    pub arg_provenance_complete: bool,
    pub dispatched: bool,
    pub dispatch_id: Option<String>,
    pub dispatch_timestamp_ms: Option<u128>,
    pub dispatch_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostIdentityRecord {
    pub role: String,
    pub ptr: usize,
    pub aux: u64,
    pub generation: u64,
    pub runtime_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputOracleRecord {
    pub oracle_id: String,
    pub required_oracle_id: String,
    pub kind: String,
    pub expected: String,
    pub actual: String,
    pub tolerance: Option<String>,
    pub producer: Option<String>,
    pub output_target_id: Option<String>,
    pub readback_timestamp_ms: Option<u128>,
    pub artifact_id: Option<String>,
    pub after_dispatch_id: Option<String>,
    pub visual_evidence_ref: Option<String>,
    pub probe_mode: Option<String>,
    pub probe_config_hash: Option<String>,
    pub probe_evidence_ref: Option<String>,
    pub readback_bytes: Option<usize>,
    pub readback_sample_stride: Option<usize>,
    pub readback_sample_sha256: Option<String>,
    pub readback_sample_hex: Option<String>,
    pub passed: bool,
    pub generation: u64,
    pub runtime_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginalHostPathRecord {
    pub host_path_id: String,
    pub dispatch_table_entry_id: String,
    pub runtime_dispatch_table_entry_id: Option<String>,
    pub dispatch_entry_runtime_verified: bool,
    pub dispatch_boundary_observed: bool,
    pub attachment_provenance: String,
    pub generation: u64,
    pub runtime_session_id: String,
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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GpuLaunchDispatcherMetadata {
    pub artifact_id: Option<String>,
    pub dispatch_table_hash: Option<String>,
    pub changed_symbols: Vec<String>,
    pub function_handle_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ActiveDispatcherMetadata {
    generation: u64,
    registration_id: String,
    artifact_id: Option<String>,
    dispatch_table_hash: Option<String>,
    changed_symbols: Vec<String>,
    function_handle_ids: Vec<String>,
}

#[derive(Debug, Default)]
struct BoundaryState {
    buffers_by_ptr: HashMap<usize, ManagedBufferRecord>,
    ptr_by_name: HashMap<String, usize>,
    next_allocation_sequence: u64,
    launches: Vec<LaunchRecord>,
    host_identities: Vec<HostIdentityRecord>,
    output_oracles: Vec<OutputOracleRecord>,
    original_host_paths: Vec<OriginalHostPathRecord>,
    reported_failure_keys: HashSet<String>,
}

static STATE: OnceLock<Mutex<BoundaryState>> = OnceLock::new();
static DISPATCHER: OnceLock<Mutex<Option<Arc<dyn GpuLaunchDispatcher>>>> = OnceLock::new();
static DISPATCHER_METADATA: OnceLock<Mutex<Option<ActiveDispatcherMetadata>>> = OnceLock::new();
static LAUNCH_GENERATION: AtomicU64 = AtomicU64::new(1);
static RUNTIME_SESSION_ID: OnceLock<String> = OnceLock::new();
#[cfg(test)]
static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn state() -> &'static Mutex<BoundaryState> {
    STATE.get_or_init(|| Mutex::new(BoundaryState::default()))
}

fn dispatcher_slot() -> &'static Mutex<Option<Arc<dyn GpuLaunchDispatcher>>> {
    DISPATCHER.get_or_init(|| Mutex::new(None))
}

fn dispatcher_metadata_slot() -> &'static Mutex<Option<ActiveDispatcherMetadata>> {
    DISPATCHER_METADATA.get_or_init(|| Mutex::new(None))
}

pub fn install_launch_dispatcher(
    dispatcher: Arc<dyn GpuLaunchDispatcher>,
) -> Option<Arc<dyn GpuLaunchDispatcher>> {
    install_launch_dispatcher_with_metadata(dispatcher, GpuLaunchDispatcherMetadata::default()).0
}

pub fn install_launch_dispatcher_with_metadata(
    dispatcher: Arc<dyn GpuLaunchDispatcher>,
    metadata: GpuLaunchDispatcherMetadata,
) -> (Option<Arc<dyn GpuLaunchDispatcher>>, u64) {
    let mut guard = dispatcher_slot()
        .lock()
        .expect("gpu runtime dispatcher mutex poisoned");
    let previous = guard.replace(dispatcher);
    let generation = LAUNCH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let active = active_dispatcher_metadata(generation, metadata);
    *dispatcher_metadata_slot()
        .lock()
        .expect("gpu runtime dispatcher metadata mutex poisoned") = Some(active);
    (previous, generation)
}

pub fn clear_launch_dispatcher() -> Option<Arc<dyn GpuLaunchDispatcher>> {
    let mut guard = dispatcher_slot()
        .lock()
        .expect("gpu runtime dispatcher mutex poisoned");
    let previous = guard.take();
    LAUNCH_GENERATION.fetch_add(1, Ordering::SeqCst);
    *dispatcher_metadata_slot()
        .lock()
        .expect("gpu runtime dispatcher metadata mutex poisoned") = None;
    previous
}

pub fn current_launch_generation() -> u64 {
    LAUNCH_GENERATION.load(Ordering::SeqCst)
}

pub fn runtime_session_id() -> &'static str {
    RUNTIME_SESSION_ID
        .get_or_init(|| {
            let start_nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0);
            format!("pid{}-{}", std::process::id(), start_nanos)
        })
        .as_str()
}

fn allocation_identity(ptr: usize, bytes: usize, sequence: u64) -> String {
    let material = format!("{}:{ptr:x}:{bytes}:{sequence}", runtime_session_id());
    format!("runtime-allocation-{:016x}", stable_hash64(&material))
}

fn active_dispatcher_metadata(
    generation: u64,
    metadata: GpuLaunchDispatcherMetadata,
) -> ActiveDispatcherMetadata {
    let mut material = String::new();
    material.push_str(&generation.to_string());
    material.push('|');
    material.push_str(metadata.artifact_id.as_deref().unwrap_or(""));
    material.push('|');
    material.push_str(metadata.dispatch_table_hash.as_deref().unwrap_or(""));
    material.push('|');
    material.push_str(&metadata.changed_symbols.join(","));
    material.push('|');
    material.push_str(&metadata.function_handle_ids.join(","));
    let registration_id = format!("dispatcher:sha256:{}", sha256_hex_raw(material.as_bytes()));
    ActiveDispatcherMetadata {
        generation,
        registration_id,
        artifact_id: metadata.artifact_id,
        dispatch_table_hash: metadata.dispatch_table_hash,
        changed_symbols: metadata.changed_symbols,
        function_handle_ids: metadata.function_handle_ids,
    }
}

fn sha256_hex_raw(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn dispatcher_metadata_snapshot() -> Option<ActiveDispatcherMetadata> {
    dispatcher_metadata_slot()
        .lock()
        .expect("gpu runtime dispatcher metadata mutex poisoned")
        .clone()
}

fn active_dispatcher_artifact_id() -> Option<String> {
    dispatcher_metadata_snapshot()
        .and_then(|metadata| metadata.artifact_id)
        .filter(|artifact_id| !artifact_id.trim().is_empty())
}

fn cstr_or_active_artifact_id(ptr: *const c_char) -> Option<String> {
    cstr(ptr).or_else(active_dispatcher_artifact_id)
}

fn dispatch_table_entry_id_for_kernel(
    metadata: &ActiveDispatcherMetadata,
    kernel_name: &str,
) -> Option<String> {
    metadata
        .changed_symbols
        .iter()
        .position(|symbol| symbol == kernel_name)
        .and_then(|index| metadata.function_handle_ids.get(index).cloned())
        .or_else(|| {
            metadata
                .changed_symbols
                .iter()
                .any(|symbol| symbol == kernel_name)
                .then(|| format!("symbol:{kernel_name}"))
        })
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct DecodedLaunchDims {
    dims: (u32, u32, u32),
    invalid_reason: Option<String>,
}

fn invalid_launch_dim_reason(label: &str, values: &[(usize, u64)]) -> Option<String> {
    for (index, value) in values {
        if *value == 0 {
            return Some(format!("{label}[{index}] is zero"));
        }
        if *value == u32::MAX as u64 || *value == u64::MAX {
            return Some(format!("{label}[{index}] is sentinel-max"));
        }
    }
    None
}

fn decode_launch_dims(label: &str, ptr: *const c_void, bytes: usize) -> DecodedLaunchDims {
    if ptr.is_null() || bytes == 0 {
        return DecodedLaunchDims {
            dims: (1, 1, 1),
            invalid_reason: None,
        };
    }

    unsafe {
        if bytes >= 12 {
            let p = ptr as *const u32;
            let raw = [
                std::ptr::read_unaligned(p) as u64,
                std::ptr::read_unaligned(p.add(1)) as u64,
                std::ptr::read_unaligned(p.add(2)) as u64,
            ];
            return DecodedLaunchDims {
                dims: (clamp_dim(raw[0]), clamp_dim(raw[1]), clamp_dim(raw[2])),
                invalid_reason: invalid_launch_dim_reason(
                    label,
                    &[(0, raw[0]), (1, raw[1]), (2, raw[2])],
                ),
            };
        }
        if bytes >= std::mem::size_of::<usize>() {
            let n = std::ptr::read_unaligned(ptr as *const usize);
            let raw = n as u64;
            return DecodedLaunchDims {
                dims: (clamp_dim(raw), 1, 1),
                invalid_reason: invalid_launch_dim_reason(label, &[(0, raw)]),
            };
        }
        if bytes >= std::mem::size_of::<u32>() {
            let n = std::ptr::read_unaligned(ptr as *const u32);
            let raw = n as u64;
            return DecodedLaunchDims {
                dims: (clamp_dim(raw), 1, 1),
                invalid_reason: invalid_launch_dim_reason(label, &[(0, raw)]),
            };
        }
    }

    DecodedLaunchDims {
        dims: (1, 1, 1),
        invalid_reason: None,
    }
}

fn registered_allocation_for_value(
    guard: &BoundaryState,
    value: usize,
) -> Option<&ManagedBufferRecord> {
    guard.buffers_by_ptr.values().find(|record| {
        value >= record.ptr
            && value
                .checked_sub(record.ptr)
                .is_some_and(|offset| offset < record.bytes)
    })
}

fn classify_arg_value(
    guard: &BoundaryState,
    index: usize,
    value_ptr: *const c_void,
    value_size: usize,
    value_kind: u32,
) -> LaunchArgProvenance {
    let value_ptr_usize = value_ptr as usize;
    let value_bytes = || -> Option<Vec<u8>> {
        if value_ptr.is_null() || value_size == 0 || value_size > 64 {
            return None;
        }
        let mut bytes = vec![0u8; value_size];
        unsafe {
            std::ptr::copy_nonoverlapping(value_ptr.cast::<u8>(), bytes.as_mut_ptr(), value_size);
        }
        Some(bytes)
    };
    if value_ptr.is_null() {
        return LaunchArgProvenance {
            index,
            value_ptr: value_ptr_usize,
            value_size,
            value_kind,
            value_bytes: None,
            observed_value: None,
            kind: "missing-arg-storage".to_string(),
            allocation_id: None,
            allocation_name: None,
            allocation_ptr: None,
            allocation_bytes: None,
            allocation_offset: None,
        };
    }

    if value_size == 0 {
        return LaunchArgProvenance {
            index,
            value_ptr: value_ptr_usize,
            value_size,
            value_kind,
            value_bytes: None,
            observed_value: None,
            kind: "legacy-unknown-size".to_string(),
            allocation_id: None,
            allocation_name: None,
            allocation_ptr: None,
            allocation_bytes: None,
            allocation_offset: None,
        };
    }

    if matches!(
        value_kind,
        SYNTHI_GPU_ARG_KIND_INTEGER | SYNTHI_GPU_ARG_KIND_FLOATING | SYNTHI_GPU_ARG_KIND_ENUM
    ) {
        return LaunchArgProvenance {
            index,
            value_ptr: value_ptr_usize,
            value_size,
            value_kind,
            value_bytes: value_bytes(),
            observed_value: None,
            kind: "scalar-value".to_string(),
            allocation_id: None,
            allocation_name: None,
            allocation_ptr: None,
            allocation_bytes: None,
            allocation_offset: None,
        };
    }

    if value_kind == SYNTHI_GPU_ARG_KIND_AGGREGATE {
        return LaunchArgProvenance {
            index,
            value_ptr: value_ptr_usize,
            value_size,
            value_kind,
            value_bytes: value_bytes(),
            observed_value: None,
            kind: "aggregate-value".to_string(),
            allocation_id: None,
            allocation_name: None,
            allocation_ptr: None,
            allocation_bytes: None,
            allocation_offset: None,
        };
    }

    if value_size < std::mem::size_of::<usize>() {
        return LaunchArgProvenance {
            index,
            value_ptr: value_ptr_usize,
            value_size,
            value_kind,
            value_bytes: value_bytes(),
            observed_value: None,
            kind: "scalar-value".to_string(),
            allocation_id: None,
            allocation_name: None,
            allocation_ptr: None,
            allocation_bytes: None,
            allocation_offset: None,
        };
    }

    if value_size > std::mem::size_of::<usize>() {
        return LaunchArgProvenance {
            index,
            value_ptr: value_ptr_usize,
            value_size,
            value_kind,
            value_bytes: None,
            observed_value: None,
            kind: "aggregate-value".to_string(),
            allocation_id: None,
            allocation_name: None,
            allocation_ptr: None,
            allocation_bytes: None,
            allocation_offset: None,
        };
    }

    let observed_value = unsafe { std::ptr::read_unaligned(value_ptr as *const usize) };
    if observed_value == 0 {
        return LaunchArgProvenance {
            index,
            value_ptr: value_ptr_usize,
            value_size,
            value_kind,
            value_bytes: Some(0usize.to_ne_bytes().to_vec()),
            observed_value: Some(0),
            kind: "null-value".to_string(),
            allocation_id: None,
            allocation_name: None,
            allocation_ptr: None,
            allocation_bytes: None,
            allocation_offset: None,
        };
    }

    if let Some(record) = registered_allocation_for_value(guard, observed_value) {
        return LaunchArgProvenance {
            index,
            value_ptr: value_ptr_usize,
            value_size,
            value_kind,
            value_bytes: Some(observed_value.to_ne_bytes().to_vec()),
            observed_value: Some(observed_value),
            kind: "device-allocation".to_string(),
            allocation_id: Some(record.allocation_id.clone()),
            allocation_name: record.semantic_name.clone(),
            allocation_ptr: Some(record.ptr),
            allocation_bytes: Some(record.bytes),
            allocation_offset: observed_value.checked_sub(record.ptr),
        };
    }

    let unknown_kind = if value_kind == SYNTHI_GPU_ARG_KIND_POINTER {
        "unknown-pointer"
    } else {
        "unknown-pointer-or-scalar"
    };

    LaunchArgProvenance {
        index,
        value_ptr: value_ptr_usize,
        value_size,
        value_kind,
        value_bytes: Some(observed_value.to_ne_bytes().to_vec()),
        observed_value: Some(observed_value),
        kind: unknown_kind.to_string(),
        allocation_id: None,
        allocation_name: None,
        allocation_ptr: None,
        allocation_bytes: None,
        allocation_offset: None,
    }
}

fn arg_provenance_is_runtime_proven(arg: &LaunchArgProvenance) -> bool {
    match arg.kind.as_str() {
        "scalar-value" => true,
        "device-allocation" => {
            arg.allocation_id
                .as_deref()
                .is_some_and(|id| !id.is_empty())
                && arg.allocation_bytes.is_some()
        }
        _ => false,
    }
}

fn classify_launch_args(
    guard: &BoundaryState,
    args: *const *const c_void,
    arg_info: *const SynthiGpuLaunchArg,
    arg_count: usize,
) -> Vec<LaunchArgProvenance> {
    if arg_count == 0 {
        return Vec::new();
    }
    if !arg_info.is_null() {
        return (0..arg_count)
            .map(|index| {
                let info = unsafe { std::ptr::read_unaligned(arg_info.add(index)) };
                classify_arg_value(
                    guard,
                    index,
                    info.value_ptr,
                    info.value_size,
                    info.value_kind,
                )
            })
            .collect();
    }
    if args.is_null() {
        return (0..arg_count)
            .map(|index| {
                classify_arg_value(
                    guard,
                    index,
                    std::ptr::null(),
                    0,
                    SYNTHI_GPU_ARG_KIND_UNKNOWN,
                )
            })
            .collect();
    }
    (0..arg_count)
        .map(|index| {
            let value_ptr = unsafe { std::ptr::read_unaligned(args.add(index)) };
            classify_arg_value(guard, index, value_ptr, 0, SYNTHI_GPU_ARG_KIND_UNKNOWN)
        })
        .collect()
}

fn raw_arg_pointers(
    _args: *const *const c_void,
    arg_info: *const SynthiGpuLaunchArg,
    arg_count: usize,
) -> Vec<*const c_void> {
    if arg_info.is_null() {
        return Vec::new();
    }
    (0..arg_count)
        .map(|index| unsafe { std::ptr::read_unaligned(arg_info.add(index)).value_ptr })
        .collect()
}

fn arg_provenance_details(args: &[LaunchArgProvenance]) -> String {
    if args.is_empty() {
        return "-".to_string();
    }
    args.iter()
        .map(|arg| {
            let allocation = arg
                .allocation_name
                .as_deref()
                .map(|name| format!(":{name}"))
                .unwrap_or_default();
            let allocation_id = arg
                .allocation_id
                .as_deref()
                .map(|id| format!(":alloc_id={id}"))
                .unwrap_or_default();
            let observed = arg
                .observed_value
                .map(|value| format!(":0x{value:x}"))
                .unwrap_or_default();
            let allocation_bytes = arg
                .allocation_bytes
                .map(|bytes| format!(":alloc_bytes={bytes}"))
                .unwrap_or_default();
            let allocation_offset = arg
                .allocation_offset
                .map(|offset| format!(":alloc_offset={offset}"))
                .unwrap_or_default();
            format!(
                "{}:{}{}{}{}{}{}:size={}",
                arg.index,
                arg.kind,
                allocation,
                allocation_id,
                observed,
                allocation_bytes,
                allocation_offset,
                arg.value_size
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn stable_hash64(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn record_host_identity_event(role: String, identity_ptr: *const c_void, aux_identity: u64) {
    let generation = current_launch_generation();
    let runtime_session = runtime_session_id().to_string();
    let ptr = identity_ptr as usize;
    {
        let mut guard = state().lock().expect("gpu runtime boundary mutex poisoned");
        guard.host_identities.push(HostIdentityRecord {
            role: role.clone(),
            ptr,
            aux: aux_identity,
            generation,
            runtime_session_id: runtime_session.clone(),
        });
    }
    eprintln!(
        "[gpu-runtime-boundary] host_identity role={} ptr=0x{:x} aux={} generation={} runtime_session={}",
        log_safe(&role),
        ptr,
        aux_identity,
        generation,
        runtime_session
    );
}

fn runtime_owned_host_identity_role(role: &str) -> bool {
    matches!(
        role,
        "runner_process" | "hmr_boundary_state" | "runtime_context"
    ) || role.starts_with("launch_")
}

fn latest_replayable_host_identities(
    generation: u64,
    runtime_session: &str,
) -> Vec<HostIdentityRecord> {
    let guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    let mut by_role = HashMap::<String, HostIdentityRecord>::new();
    for record in &guard.host_identities {
        if record.generation >= generation
            || record.runtime_session_id != runtime_session
            || runtime_owned_host_identity_role(&record.role)
        {
            continue;
        }
        let should_replace = by_role
            .get(&record.role)
            .map(|current| record.generation > current.generation)
            .unwrap_or(true);
        if should_replace {
            by_role.insert(record.role.clone(), record.clone());
        }
    }
    let mut records = by_role.into_values().collect::<Vec<_>>();
    records.sort_by(|left, right| left.role.cmp(&right.role));
    records
}

fn record_launch_host_identities(
    kernel_name: &str,
    kernel_name_ptr: *const c_void,
    gpu: *const c_void,
    stream_token: usize,
) {
    let pid = std::process::id() as usize;
    let session_hash = stable_hash64(runtime_session_id());
    record_host_identity_event(
        "runner_process".to_string(),
        pid as *const c_void,
        session_hash,
    );
    if !kernel_name_ptr.is_null() {
        let kernel_hash = stable_hash64(kernel_name);
        record_host_identity_event(
            format!("launch_kernel_{kernel_hash:016x}"),
            kernel_name_ptr,
            kernel_hash,
        );
    }
    if !gpu.is_null() {
        record_host_identity_event("runtime_context".to_string(), gpu, 0);
    }
    if stream_token != 0 {
        record_host_identity_event(
            "launch_stream".to_string(),
            stream_token as *const c_void,
            0,
        );
    }
}

pub fn record_hmr_runtime_identity_snapshot() {
    let generation = current_launch_generation();
    let runtime_session = runtime_session_id().to_string();
    let retained_host_identities = latest_replayable_host_identities(generation, &runtime_session);
    let pid = std::process::id() as usize;
    let session_hash = stable_hash64(&runtime_session);
    record_host_identity_event(
        "runner_process".to_string(),
        pid as *const c_void,
        session_hash,
    );
    record_host_identity_event(
        "hmr_boundary_state".to_string(),
        (state() as *const Mutex<BoundaryState>).cast::<c_void>(),
        stable_hash64("hmr_boundary_state"),
    );
    record_host_identity_event(
        "runtime_context".to_string(),
        (dispatcher_slot() as *const Mutex<Option<Arc<dyn GpuLaunchDispatcher>>>).cast::<c_void>(),
        stable_hash64("runtime_context"),
    );
    for record in retained_host_identities {
        record_host_identity_event(record.role, record.ptr as *const c_void, record.aux);
    }
}

fn record_original_host_path_event_at(
    host_path_id: String,
    dispatch_table_entry_id: String,
    runtime_dispatch_table_entry_id: Option<String>,
    dispatch_boundary_observed: bool,
    attachment_provenance: String,
    generation: u64,
    runtime_session: String,
) {
    let declared_dispatch_table_entry_id = dispatch_table_entry_id.trim();
    let dispatch_entry_runtime_verified = runtime_dispatch_table_entry_id
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| {
            !value.is_empty()
                && value != "none"
                && !declared_dispatch_table_entry_id.is_empty()
                && value == declared_dispatch_table_entry_id
        });
    {
        let mut guard = state().lock().expect("gpu runtime boundary mutex poisoned");
        guard.original_host_paths.push(OriginalHostPathRecord {
            host_path_id: host_path_id.clone(),
            dispatch_table_entry_id: dispatch_table_entry_id.clone(),
            runtime_dispatch_table_entry_id: runtime_dispatch_table_entry_id.clone(),
            dispatch_entry_runtime_verified,
            dispatch_boundary_observed,
            attachment_provenance: attachment_provenance.clone(),
            generation,
            runtime_session_id: runtime_session.clone(),
        });
    }
    eprintln!(
        "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed={} attachment_provenance={} host_path_id={} dispatch_table_entry_id={} runtime_dispatch_table_entry_id={} dispatch_entry_runtime_verified={} generation={} runtime_session={}",
        dispatch_boundary_observed,
        log_token(&attachment_provenance),
        log_token(&host_path_id),
        log_token(&dispatch_table_entry_id),
        log_token(runtime_dispatch_table_entry_id.as_deref().unwrap_or("none")),
        dispatch_entry_runtime_verified,
        generation,
        runtime_session
    );
}

fn record_original_host_path_event(
    host_path_id: String,
    dispatch_table_entry_id: String,
    dispatch_boundary_observed: bool,
    attachment_provenance: String,
) {
    let generation = current_launch_generation();
    let runtime_session = runtime_session_id().to_string();
    let runtime_dispatch_table_entry_id = dispatch_boundary_observed
        .then(|| latest_runtime_dispatch_table_entry_id(generation, &runtime_session))
        .flatten();
    record_original_host_path_event_at(
        host_path_id,
        dispatch_table_entry_id,
        runtime_dispatch_table_entry_id,
        dispatch_boundary_observed,
        attachment_provenance,
        generation,
        runtime_session,
    );
}

fn latest_runtime_dispatch_table_entry_id(
    generation: u64,
    runtime_session: &str,
) -> Option<String> {
    let guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    guard
        .launches
        .iter()
        .rev()
        .find(|record| {
            record.active_generation == generation && record.runtime_session_id == runtime_session
        })
        .and_then(|record| record.dispatch_table_entry_id.clone())
        .filter(|entry_id| !entry_id.trim().is_empty())
}

pub fn latest_dispatch_id_for_generation(
    generation: u64,
    runtime_session: &str,
) -> Option<String> {
    let guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    guard
        .launches
        .iter()
        .rev()
        .find(|record| {
            record.active_generation == generation && record.runtime_session_id == runtime_session
        })
        .and_then(|record| record.dispatch_id.clone())
        .filter(|dispatch_id| !dispatch_id.trim().is_empty())
}

fn record_output_oracle_event(
    oracle_id: String,
    kind: String,
    expected: String,
    actual: String,
    passed: bool,
) {
    record_output_oracle_event_with_metadata(
        oracle_id,
        kind,
        expected,
        actual,
        passed,
        OutputOracleMetadata::default(),
    );
}

#[derive(Default)]
struct OutputOracleMetadata {
    tolerance: Option<String>,
    producer: Option<String>,
    output_target_id: Option<String>,
    readback_timestamp_ms: Option<u128>,
    artifact_id: Option<String>,
    after_dispatch_id: Option<String>,
    visual_evidence_ref: Option<String>,
    probe_mode: Option<String>,
    probe_config_hash: Option<String>,
    probe_evidence_ref: Option<String>,
    readback_bytes: Option<usize>,
    readback_sample_stride: Option<usize>,
    readback_sample_sha256: Option<String>,
    readback_sample_hex: Option<String>,
}

fn epoch_millis_now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn append_log_token(line: &mut String, key: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        line.push(' ');
        line.push_str(key);
        line.push('=');
        line.push_str(&log_token(value));
    }
}

fn attach_readback_sample_metadata(metadata: &mut OutputOracleMetadata, data: &[u8]) {
    if data.is_empty() {
        return;
    }
    const MAX_SAMPLE_BYTES: usize = 1024;
    let stride = std::cmp::max(1, (data.len() + MAX_SAMPLE_BYTES - 1) / MAX_SAMPLE_BYTES);
    let sample = data
        .iter()
        .step_by(stride)
        .take(MAX_SAMPLE_BYTES)
        .copied()
        .collect::<Vec<_>>();
    metadata.readback_bytes = Some(data.len());
    metadata.readback_sample_stride = Some(stride);
    metadata.readback_sample_sha256 = Some(sha256_checksum_value(&sample));
    metadata.readback_sample_hex = Some(hex::encode(sample));
}

fn record_output_oracle_event_with_metadata(
    oracle_id: String,
    kind: String,
    expected: String,
    actual: String,
    passed: bool,
    metadata: OutputOracleMetadata,
) {
    let generation = current_launch_generation();
    let runtime_session = runtime_session_id().to_string();
    let after_dispatch_id = metadata
        .after_dispatch_id
        .clone()
        .or_else(|| latest_dispatch_id_for_generation(generation, &runtime_session));
    {
        let mut guard = state().lock().expect("gpu runtime boundary mutex poisoned");
        guard.output_oracles.push(OutputOracleRecord {
            oracle_id: oracle_id.clone(),
            required_oracle_id: oracle_id.clone(),
            kind: kind.clone(),
            expected: expected.clone(),
            actual: actual.clone(),
            tolerance: metadata.tolerance.clone(),
            producer: metadata.producer.clone(),
            output_target_id: metadata.output_target_id.clone(),
            readback_timestamp_ms: metadata.readback_timestamp_ms,
            artifact_id: metadata.artifact_id.clone(),
            after_dispatch_id: after_dispatch_id.clone(),
            visual_evidence_ref: metadata.visual_evidence_ref.clone(),
            probe_mode: metadata.probe_mode.clone(),
            probe_config_hash: metadata.probe_config_hash.clone(),
            probe_evidence_ref: metadata.probe_evidence_ref.clone(),
            readback_bytes: metadata.readback_bytes,
            readback_sample_stride: metadata.readback_sample_stride,
            readback_sample_sha256: metadata.readback_sample_sha256.clone(),
            readback_sample_hex: metadata.readback_sample_hex.clone(),
            passed,
            generation,
            runtime_session_id: runtime_session.clone(),
        });
    }
    let mut line = format!(
        "[gpu-runtime-boundary] output_oracle id={} required_oracle_id={} kind={} expected={} actual={} passed={} generation={} runtime_session={}",
        log_token(&oracle_id),
        log_token(&oracle_id),
        log_token(&kind),
        log_token(&expected),
        log_token(&actual),
        passed,
        generation,
        runtime_session
    );
    append_log_token(&mut line, "tolerance", metadata.tolerance.as_deref());
    append_log_token(&mut line, "producer", metadata.producer.as_deref());
    append_log_token(
        &mut line,
        "output_target_id",
        metadata.output_target_id.as_deref(),
    );
    if let Some(readback_timestamp_ms) = metadata.readback_timestamp_ms {
        line.push_str(" readback_timestamp=");
        line.push_str(&readback_timestamp_ms.to_string());
    }
    append_log_token(&mut line, "artifact_id", metadata.artifact_id.as_deref());
    append_log_token(
        &mut line,
        "after_dispatch_id",
        after_dispatch_id.as_deref(),
    );
    append_log_token(
        &mut line,
        "visual_evidence_ref",
        metadata.visual_evidence_ref.as_deref(),
    );
    append_log_token(&mut line, "probe_mode", metadata.probe_mode.as_deref());
    append_log_token(
        &mut line,
        "probe_config_hash",
        metadata.probe_config_hash.as_deref(),
    );
    append_log_token(
        &mut line,
        "probe_evidence_ref",
        metadata.probe_evidence_ref.as_deref(),
    );
    if let Some(readback_bytes) = metadata.readback_bytes {
        line.push_str(" readback_bytes=");
        line.push_str(&readback_bytes.to_string());
    }
    if let Some(readback_sample_stride) = metadata.readback_sample_stride {
        line.push_str(" readback_sample_stride=");
        line.push_str(&readback_sample_stride.to_string());
    }
    append_log_token(
        &mut line,
        "readback_sample_sha256",
        metadata.readback_sample_sha256.as_deref(),
    );
    append_log_token(
        &mut line,
        "readback_sample_hex",
        metadata.readback_sample_hex.as_deref(),
    );
    eprintln!("{line}");
}

fn sha256_checksum_value(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn normalize_checksum_value(value: String) -> String {
    let trimmed = value.trim();
    if trimmed.len() == 64 && trimmed.chars().all(|ch| ch.is_ascii_hexdigit()) {
        format!("sha256:{}", trimmed.to_ascii_lowercase())
    } else if let Some(rest) = trimmed.strip_prefix("sha256:") {
        format!("sha256:{}", rest.to_ascii_lowercase())
    } else {
        trimmed.to_string()
    }
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
    guard.next_allocation_sequence = guard.next_allocation_sequence.saturating_add(1);
    let allocation_id = allocation_identity(key, bytes, guard.next_allocation_sequence);
    guard.buffers_by_ptr.insert(
        key,
        ManagedBufferRecord {
            ptr: key,
            bytes,
            allocation_id: allocation_id.clone(),
            semantic_name: semantic_name.clone(),
            lifetime_hint: lifetime_hint.clone(),
            dirty: true,
        },
    );
    if let Some(name) = &semantic_name {
        guard.ptr_by_name.insert(name.clone(), key);
    }

    eprintln!(
        "[gpu-runtime-boundary] registered buffer name={} allocation_id={} ptr=0x{:x} bytes={} lifetime={}",
        semantic_name.as_deref().unwrap_or("<unnamed>"),
        log_token(&allocation_id),
        key,
        bytes,
        lifetime_hint.as_deref().unwrap_or("<unset>")
    );
}

#[no_mangle]
pub extern "C" fn synthi_gpu_record_host_identity(
    role: *const c_char,
    identity_ptr: *const c_void,
    aux_identity: u64,
) {
    let role = cstr(role).unwrap_or_else(|| "<unknown>".to_string());
    record_host_identity_event(role, identity_ptr, aux_identity);
}

#[no_mangle]
pub extern "C" fn synthi_gpu_record_output_oracle(
    oracle_id: *const c_char,
    kind: *const c_char,
    expected_value: *const c_char,
    actual_value: *const c_char,
    passed: bool,
) {
    let oracle_id = cstr(oracle_id).unwrap_or_else(|| "<unknown>".to_string());
    let kind = cstr(kind).unwrap_or_else(|| "<unknown>".to_string());
    let expected = cstr(expected_value).unwrap_or_default();
    let actual = cstr(actual_value).unwrap_or_default();
    record_output_oracle_event(oracle_id, kind, expected, actual, passed);
}

#[no_mangle]
pub extern "C" fn synthi_gpu_record_output_oracle_with_provenance(
    oracle_id: *const c_char,
    kind: *const c_char,
    expected_value: *const c_char,
    actual_value: *const c_char,
    tolerance: *const c_char,
    producer: *const c_char,
    output_target_id: *const c_char,
    artifact_id: *const c_char,
    visual_evidence_ref: *const c_char,
    passed: bool,
) {
    let oracle_id = cstr(oracle_id).unwrap_or_else(|| "<unknown>".to_string());
    let kind = cstr(kind).unwrap_or_else(|| "<unknown>".to_string());
    let expected = cstr(expected_value).unwrap_or_default();
    let actual = cstr(actual_value).unwrap_or_default();
    record_output_oracle_event_with_metadata(
        oracle_id,
        kind,
        expected,
        actual,
        passed,
        OutputOracleMetadata {
            tolerance: cstr(tolerance),
            producer: cstr(producer),
            output_target_id: cstr(output_target_id),
            readback_timestamp_ms: Some(epoch_millis_now()),
            artifact_id: cstr_or_active_artifact_id(artifact_id),
            visual_evidence_ref: cstr(visual_evidence_ref),
            ..OutputOracleMetadata::default()
        },
    );
}

#[no_mangle]
pub extern "C" fn synthi_gpu_record_output_oracle_with_probe(
    oracle_id: *const c_char,
    kind: *const c_char,
    expected_value: *const c_char,
    actual_value: *const c_char,
    tolerance: *const c_char,
    producer: *const c_char,
    output_target_id: *const c_char,
    artifact_id: *const c_char,
    visual_evidence_ref: *const c_char,
    probe_mode: *const c_char,
    probe_config_hash: *const c_char,
    probe_evidence_ref: *const c_char,
    passed: bool,
) {
    let oracle_id = cstr(oracle_id).unwrap_or_else(|| "<unknown>".to_string());
    let kind = cstr(kind).unwrap_or_else(|| "<unknown>".to_string());
    let expected = cstr(expected_value).unwrap_or_default();
    let actual = cstr(actual_value).unwrap_or_default();
    record_output_oracle_event_with_metadata(
        oracle_id,
        kind,
        expected,
        actual,
        passed,
        OutputOracleMetadata {
            tolerance: cstr(tolerance),
            producer: cstr(producer),
            output_target_id: cstr(output_target_id),
            readback_timestamp_ms: Some(epoch_millis_now()),
            artifact_id: cstr_or_active_artifact_id(artifact_id),
            visual_evidence_ref: cstr(visual_evidence_ref),
            probe_mode: cstr(probe_mode),
            probe_config_hash: cstr(probe_config_hash),
            probe_evidence_ref: cstr(probe_evidence_ref),
            ..OutputOracleMetadata::default()
        },
    );
}

#[no_mangle]
pub extern "C" fn synthi_gpu_record_output_buffer_checksum(
    oracle_id: *const c_char,
    data: *const c_void,
    bytes: usize,
    expected_sha256: *const c_char,
) -> bool {
    let oracle_id = cstr(oracle_id).unwrap_or_else(|| "<unknown>".to_string());
    let expected = normalize_checksum_value(cstr(expected_sha256).unwrap_or_default());
    let (actual, passed) = if data.is_null() || bytes == 0 {
        ("<invalid-buffer>".to_string(), false)
    } else {
        let data = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), bytes) };
        let actual = sha256_checksum_value(data);
        let passed = !expected.is_empty() && actual.eq_ignore_ascii_case(&expected);
        (actual, passed)
    };
    let mut metadata = OutputOracleMetadata::default();
    if !data.is_null() && bytes > 0 {
        let data = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), bytes) };
        attach_readback_sample_metadata(&mut metadata, data);
    }
    record_output_oracle_event_with_metadata(
        oracle_id,
        "buffer_checksum".to_string(),
        expected,
        actual,
        passed,
        metadata,
    );
    passed
}

#[no_mangle]
pub extern "C" fn synthi_gpu_record_output_buffer_checksum_with_provenance(
    oracle_id: *const c_char,
    data: *const c_void,
    bytes: usize,
    expected_sha256: *const c_char,
    producer: *const c_char,
    output_target_id: *const c_char,
    artifact_id: *const c_char,
    visual_evidence_ref: *const c_char,
) -> bool {
    let oracle_id = cstr(oracle_id).unwrap_or_else(|| "<unknown>".to_string());
    let expected = normalize_checksum_value(cstr(expected_sha256).unwrap_or_default());
    let (actual, passed) = if data.is_null() || bytes == 0 {
        ("<invalid-buffer>".to_string(), false)
    } else {
        let data = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), bytes) };
        let actual = sha256_checksum_value(data);
        let passed = !expected.is_empty() && actual.eq_ignore_ascii_case(&expected);
        (actual, passed)
    };
    let mut metadata = OutputOracleMetadata {
        tolerance: None,
        producer: cstr(producer),
        output_target_id: cstr(output_target_id),
        readback_timestamp_ms: Some(epoch_millis_now()),
        artifact_id: cstr_or_active_artifact_id(artifact_id),
        visual_evidence_ref: cstr(visual_evidence_ref),
        ..OutputOracleMetadata::default()
    };
    if !data.is_null() && bytes > 0 {
        let data = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), bytes) };
        attach_readback_sample_metadata(&mut metadata, data);
    }
    record_output_oracle_event_with_metadata(
        oracle_id,
        "buffer_checksum".to_string(),
        expected,
        actual,
        passed,
        metadata,
    );
    passed
}

#[no_mangle]
pub extern "C" fn synthi_gpu_record_output_buffer_checksum_with_probe(
    oracle_id: *const c_char,
    data: *const c_void,
    bytes: usize,
    expected_sha256: *const c_char,
    producer: *const c_char,
    output_target_id: *const c_char,
    artifact_id: *const c_char,
    visual_evidence_ref: *const c_char,
    probe_mode: *const c_char,
    probe_config_hash: *const c_char,
    probe_evidence_ref: *const c_char,
) -> bool {
    let oracle_id = cstr(oracle_id).unwrap_or_else(|| "<unknown>".to_string());
    let expected = normalize_checksum_value(cstr(expected_sha256).unwrap_or_default());
    let (actual, passed) = if data.is_null() || bytes == 0 {
        ("<invalid-buffer>".to_string(), false)
    } else {
        let data = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), bytes) };
        let actual = sha256_checksum_value(data);
        let passed = !expected.is_empty() && actual.eq_ignore_ascii_case(&expected);
        (actual, passed)
    };
    let mut metadata = OutputOracleMetadata {
        tolerance: None,
        producer: cstr(producer),
        output_target_id: cstr(output_target_id),
        readback_timestamp_ms: Some(epoch_millis_now()),
        artifact_id: cstr_or_active_artifact_id(artifact_id),
        visual_evidence_ref: cstr(visual_evidence_ref),
        probe_mode: cstr(probe_mode),
        probe_config_hash: cstr(probe_config_hash),
        probe_evidence_ref: cstr(probe_evidence_ref),
        ..OutputOracleMetadata::default()
    };
    if !data.is_null() && bytes > 0 {
        let data = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), bytes) };
        attach_readback_sample_metadata(&mut metadata, data);
    }
    record_output_oracle_event_with_metadata(
        oracle_id,
        "buffer_checksum".to_string(),
        expected,
        actual,
        passed,
        metadata,
    );
    passed
}

pub fn record_output_buffer_checksum_with_probe_bytes(
    oracle_id: &str,
    data: &[u8],
    expected_sha256: &str,
    producer: &str,
    output_target_id: &str,
    artifact_id: Option<&str>,
    visual_evidence_ref: Option<&str>,
    probe_mode: &str,
    probe_config_hash: &str,
    probe_evidence_ref: &str,
) -> bool {
    record_output_buffer_checksum_with_probe_bytes_after_dispatch(
        oracle_id,
        data,
        expected_sha256,
        producer,
        output_target_id,
        artifact_id,
        None,
        visual_evidence_ref,
        probe_mode,
        probe_config_hash,
        probe_evidence_ref,
    )
}

pub fn record_output_buffer_checksum_with_probe_bytes_after_dispatch(
    oracle_id: &str,
    data: &[u8],
    expected_sha256: &str,
    producer: &str,
    output_target_id: &str,
    artifact_id: Option<&str>,
    after_dispatch_id: Option<&str>,
    visual_evidence_ref: Option<&str>,
    probe_mode: &str,
    probe_config_hash: &str,
    probe_evidence_ref: &str,
) -> bool {
    let expected = normalize_checksum_value(expected_sha256.to_string());
    let actual = sha256_checksum_value(data);
    let passed = !expected.is_empty() && actual.eq_ignore_ascii_case(&expected);
    let mut metadata = OutputOracleMetadata {
        tolerance: None,
        producer: Some(producer.to_string()),
        output_target_id: Some(output_target_id.to_string()),
        readback_timestamp_ms: Some(epoch_millis_now()),
        artifact_id: artifact_id.map(str::to_string).or_else(|| {
            dispatcher_metadata_snapshot().and_then(|metadata| metadata.artifact_id)
        }),
        after_dispatch_id: after_dispatch_id.map(str::to_string),
        visual_evidence_ref: visual_evidence_ref.map(str::to_string),
        probe_mode: Some(probe_mode.to_string()),
        probe_config_hash: Some(probe_config_hash.to_string()),
        probe_evidence_ref: Some(probe_evidence_ref.to_string()),
        ..OutputOracleMetadata::default()
    };
    attach_readback_sample_metadata(&mut metadata, data);
    record_output_oracle_event_with_metadata(
        oracle_id.to_string(),
        "buffer_checksum".to_string(),
        expected,
        actual,
        passed,
        metadata,
    );
    passed
}

fn dispatch_id_for_launch(
    runtime_session_id: &str,
    active_generation: u64,
    launch_index: usize,
    kernel_name: &str,
    dispatch_timestamp_ms: u128,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(runtime_session_id.as_bytes());
    hasher.update(b"|");
    hasher.update(active_generation.to_string().as_bytes());
    hasher.update(b"|");
    hasher.update(launch_index.to_string().as_bytes());
    hasher.update(b"|");
    hasher.update(kernel_name.as_bytes());
    hasher.update(b"|");
    hasher.update(dispatch_timestamp_ms.to_string().as_bytes());
    format!("dispatch:sha256:{}", hex::encode(hasher.finalize()))
}

#[no_mangle]
pub extern "C" fn synthi_gpu_record_original_host_path(
    host_path_id: *const c_char,
    dispatch_table_entry_id: *const c_char,
    dispatch_boundary_observed: bool,
) {
    let host_path_id = cstr(host_path_id).unwrap_or_else(|| "<unknown>".to_string());
    let dispatch_table_entry_id =
        cstr(dispatch_table_entry_id).unwrap_or_else(|| "<unknown>".to_string());
    record_original_host_path_event(
        host_path_id,
        dispatch_table_entry_id,
        dispatch_boundary_observed,
        "runtime_explicit".to_string(),
    );
}

#[no_mangle]
pub extern "C" fn synthi_gpu_record_original_host_path_with_provenance(
    host_path_id: *const c_char,
    dispatch_table_entry_id: *const c_char,
    attachment_provenance: *const c_char,
    dispatch_boundary_observed: bool,
) {
    let host_path_id = cstr(host_path_id).unwrap_or_else(|| "<unknown>".to_string());
    let dispatch_table_entry_id =
        cstr(dispatch_table_entry_id).unwrap_or_else(|| "<unknown>".to_string());
    let attachment_provenance =
        cstr(attachment_provenance).unwrap_or_else(|| "<unspecified>".to_string());
    record_original_host_path_event(
        host_path_id,
        dispatch_table_entry_id,
        dispatch_boundary_observed,
        attachment_provenance,
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
        std::ptr::null(),
        arg_count,
        expected_generation,
        None,
    )
}

#[no_mangle]
pub extern "C" fn synthi_gpu_launch_raw_arg_info_checked(
    _gpu: *mut c_void,
    kernel_name: *const c_char,
    _grid: *const c_void,
    grid_size: usize,
    _block: *const c_void,
    block_size: usize,
    shared_bytes: usize,
    stream_token: usize,
    args: *const SynthiGpuLaunchArg,
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
        std::ptr::null(),
        args,
        arg_count,
        expected_generation,
        None,
    )
}

#[no_mangle]
pub extern "C" fn synthi_gpu_launch_original_host_path_raw_arg_info_checked(
    _gpu: *mut c_void,
    kernel_name: *const c_char,
    _grid: *const c_void,
    grid_size: usize,
    _block: *const c_void,
    block_size: usize,
    shared_bytes: usize,
    stream_token: usize,
    args: *const SynthiGpuLaunchArg,
    arg_count: usize,
    expected_generation: u64,
    host_path_id: *const c_char,
    dispatch_table_entry_id: *const c_char,
    attachment_provenance: *const c_char,
) -> bool {
    let original_host_path = cstr(host_path_id)
        .filter(|host_path_id| !host_path_id.trim().is_empty())
        .map(|host_path_id| OriginalHostPathLaunchAttachment {
            host_path_id,
            dispatch_table_entry_id: cstr(dispatch_table_entry_id)
                .filter(|entry_id| !entry_id.trim().is_empty()),
            attachment_provenance: cstr(attachment_provenance)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "host_runtime_explicit".to_string()),
        });
    synthi_gpu_launch_raw_impl(
        _gpu,
        kernel_name,
        _grid,
        grid_size,
        _block,
        block_size,
        shared_bytes,
        stream_token,
        std::ptr::null(),
        args,
        arg_count,
        expected_generation,
        original_host_path,
    )
}

#[no_mangle]
pub extern "C" fn synthi_gpu_launch_source_location_raw_arg_info_checked(
    _gpu: *mut c_void,
    kernel_name: *const c_char,
    _grid: *const c_void,
    grid_size: usize,
    _block: *const c_void,
    block_size: usize,
    shared_bytes: usize,
    stream_token: usize,
    args: *const SynthiGpuLaunchArg,
    arg_count: usize,
    expected_generation: u64,
    host_path_id: *const c_char,
    attachment_provenance: *const c_char,
) -> bool {
    let original_host_path = cstr(host_path_id)
        .filter(|host_path_id| !host_path_id.trim().is_empty())
        .map(|host_path_id| OriginalHostPathLaunchAttachment {
            host_path_id,
            dispatch_table_entry_id: None,
            attachment_provenance: cstr(attachment_provenance)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "host_runtime_explicit".to_string()),
        });
    synthi_gpu_launch_raw_impl(
        _gpu,
        kernel_name,
        _grid,
        grid_size,
        _block,
        block_size,
        shared_bytes,
        stream_token,
        std::ptr::null(),
        args,
        arg_count,
        expected_generation,
        original_host_path,
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
        std::ptr::null(),
        arg_count,
        current_launch_generation(),
        None,
    )
}

#[no_mangle]
pub extern "C" fn synthi_gpu_launch_raw_arg_info(
    _gpu: *mut c_void,
    kernel_name: *const c_char,
    _grid: *const c_void,
    grid_size: usize,
    _block: *const c_void,
    block_size: usize,
    shared_bytes: usize,
    stream_token: usize,
    args: *const SynthiGpuLaunchArg,
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
        std::ptr::null(),
        args,
        arg_count,
        current_launch_generation(),
        None,
    )
}

struct OriginalHostPathLaunchAttachment {
    host_path_id: String,
    dispatch_table_entry_id: Option<String>,
    attachment_provenance: String,
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
    arg_info: *const SynthiGpuLaunchArg,
    arg_count: usize,
    expected_generation: u64,
    original_host_path: Option<OriginalHostPathLaunchAttachment>,
) -> bool {
    let kernel_name_ptr = kernel_name.cast::<c_void>();
    let kernel_name = cstr(kernel_name).unwrap_or_else(|| "<unknown>".to_string());
    let grid_decoded = decode_launch_dims("grid", _grid, grid_size);
    let block_decoded = decode_launch_dims("block", _block, block_size);
    let grid = grid_decoded.dims;
    let block = block_decoded.dims;
    let active_generation = current_launch_generation();
    let runtime_session_id = runtime_session_id().to_string();
    let active_dispatcher_metadata =
        dispatcher_metadata_snapshot().filter(|metadata| metadata.generation == active_generation);
    let active_dispatch_table_entry_id = active_dispatcher_metadata
        .as_ref()
        .and_then(|metadata| dispatch_table_entry_id_for_kernel(metadata, &kernel_name));
    record_launch_host_identities(
        &kernel_name,
        kernel_name_ptr,
        _gpu.cast_const(),
        stream_token,
    );
    if let Some(attachment) = original_host_path {
        let dispatch_table_entry_id = attachment
            .dispatch_table_entry_id
            .or_else(|| active_dispatch_table_entry_id.clone())
            .unwrap_or_else(|| format!("symbol:{kernel_name}"));
        record_original_host_path_event_at(
            attachment.host_path_id,
            dispatch_table_entry_id,
            active_dispatch_table_entry_id.clone(),
            true,
            attachment.attachment_provenance,
            active_generation,
            runtime_session_id.clone(),
        );
    }
    let stale_generation = expected_generation != 0 && expected_generation != active_generation;
    let request = GpuLaunchRequest {
        kernel_name: kernel_name.clone(),
        grid,
        block,
        shared_bytes,
        stream_token,
        arg_count,
    };
    let arg_value_ptrs = raw_arg_pointers(args, arg_info, arg_count);
    let dispatch_args = if arg_info.is_null() {
        args
    } else {
        arg_value_ptrs.as_ptr()
    };

    let (launch_index, dispatcher, arg_provenance, arg_provenance_complete) = {
        let mut guard = state().lock().expect("gpu runtime boundary mutex poisoned");
        for record in guard.buffers_by_ptr.values_mut() {
            // Until launch-graph write-set inference is connected, every launch
            // conservatively dirties every Synthi-managed buffer.
            record.dirty = true;
        }
        let arg_provenance = classify_launch_args(&guard, args, arg_info, arg_count);
        let arg_provenance_complete = arg_provenance.iter().all(arg_provenance_is_runtime_proven);
        let launch_index = guard.launches.len();
        guard.launches.push(LaunchRecord {
            runtime_session_id: runtime_session_id.clone(),
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
            active_artifact_id: active_dispatcher_metadata
                .as_ref()
                .and_then(|metadata| metadata.artifact_id.clone()),
            dispatcher_registration_id: active_dispatcher_metadata
                .as_ref()
                .map(|metadata| metadata.registration_id.clone()),
            dispatch_table_hash: active_dispatcher_metadata
                .as_ref()
                .and_then(|metadata| metadata.dispatch_table_hash.clone()),
            dispatch_table_entry_id: active_dispatch_table_entry_id.clone(),
            arg_provenance: arg_provenance.clone(),
            arg_provenance_complete,
            dispatched: false,
            dispatch_id: None,
            dispatch_timestamp_ms: None,
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
        (
            launch_index,
            dispatcher,
            arg_provenance,
            arg_provenance_complete,
        )
    };

    let invalid_launch_dims = grid_decoded
        .invalid_reason
        .or(block_decoded.invalid_reason)
        .map(|reason| format!("gpu_launch_invalid_dimensions: {reason}"));

    let dispatch_result = if let Some(reason) = invalid_launch_dims {
        Some(Err(reason))
    } else if stale_generation {
        Some(Err("reload_failed.stale_launch_pointer".to_string()))
    } else {
        dispatcher
            .as_ref()
            .map(|d| d.dispatch(&request, dispatch_args))
    };

    let dispatch_timestamp_ms = epoch_millis_now();
    let dispatch_id = dispatch_id_for_launch(
        &runtime_session_id,
        active_generation,
        launch_index,
        &kernel_name,
        dispatch_timestamp_ms,
    );
    let mut guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    if let Some(record) = guard.launches.get_mut(launch_index) {
        record.dispatch_id = Some(dispatch_id.clone());
        record.dispatch_timestamp_ms = Some(dispatch_timestamp_ms);
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
            Some(record) => (
                record.dispatch_error.is_none(),
                record.dispatch_error.clone(),
            ),
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
    let active_artifact_id = active_dispatcher_metadata
        .as_ref()
        .and_then(|metadata| metadata.artifact_id.as_deref())
        .unwrap_or("none");
    let dispatcher_registration_id = active_dispatcher_metadata
        .as_ref()
        .map(|metadata| metadata.registration_id.as_str())
        .unwrap_or("none");
    let dispatch_table_hash = active_dispatcher_metadata
        .as_ref()
        .and_then(|metadata| metadata.dispatch_table_hash.as_deref())
        .unwrap_or("none");
    let dispatch_table_entry_id = active_dispatch_table_entry_id
        .clone()
        .unwrap_or_else(|| "none".to_string());

    if let Some(error) = dispatch_error.as_deref() {
        eprintln!(
            "[gpu-runtime-boundary] synthi_gpu_launch kernel={} grid={:?} block={:?} args={} stream={} shared_bytes={} dispatch={} generation={} runtime_session={} artifact_id={} dispatcher_registration_id={} dispatch_table_hash={} dispatch_table_entry_id={} dispatch_timestamp={} dispatch_id={} error={}",
            kernel_name,
            grid,
            block,
            arg_count,
            stream_token,
            shared_bytes,
            dispatch_label,
            active_generation,
            runtime_session_id,
            log_token(active_artifact_id),
            log_token(dispatcher_registration_id),
            log_token(dispatch_table_hash),
            log_token(&dispatch_table_entry_id),
            dispatch_timestamp_ms,
            log_token(&dispatch_id),
            log_safe(error)
        );
        maybe_emit_launch_failure_status(&kernel_name, error, dispatch_label, active_generation);
    } else {
        eprintln!(
            "[gpu-runtime-boundary] synthi_gpu_launch kernel={} grid={:?} block={:?} args={} stream={} shared_bytes={} dispatch={} generation={} runtime_session={} artifact_id={} dispatcher_registration_id={} dispatch_table_hash={} dispatch_table_entry_id={} dispatch_timestamp={} dispatch_id={}",
            kernel_name,
            grid,
            block,
            arg_count,
            stream_token,
            shared_bytes,
            dispatch_label,
            active_generation,
            runtime_session_id,
            log_token(active_artifact_id),
            log_token(dispatcher_registration_id),
            log_token(dispatch_table_hash),
            log_token(&dispatch_table_entry_id),
            dispatch_timestamp_ms,
            log_token(&dispatch_id)
        );
    }
    let known_arg_count = arg_provenance
        .iter()
        .filter(|arg| arg_provenance_is_runtime_proven(arg))
        .count();
    let unknown_arg_count = arg_provenance.len().saturating_sub(known_arg_count);
    let degraded_state = if arg_provenance_complete {
        "none"
    } else {
        "gpu-hmr-unknown-arg-provenance"
    };
    eprintln!(
        "[gpu-runtime-boundary] launch_arg_provenance kernel={} generation={} runtime_session={} dispatch_table_entry_id={} dispatch_timestamp={} dispatch_id={} complete={} known_args={} unknown_args={} degradedState={} details={}",
        kernel_name,
        active_generation,
        runtime_session_id,
        log_token(&dispatch_table_entry_id),
        dispatch_timestamp_ms,
        log_token(&dispatch_id),
        arg_provenance_complete,
        known_arg_count,
        unknown_arg_count,
        degraded_state,
        log_safe(&arg_provenance_details(&arg_provenance))
    );
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

pub fn host_identity_records_snapshot() -> Vec<HostIdentityRecord> {
    let guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    guard.host_identities.clone()
}

pub fn output_oracle_records_snapshot() -> Vec<OutputOracleRecord> {
    let guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    guard.output_oracles.clone()
}

pub fn original_host_path_records_snapshot() -> Vec<OriginalHostPathRecord> {
    let guard = state().lock().expect("gpu runtime boundary mutex poisoned");
    guard.original_host_paths.clone()
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

fn log_token(value: &str) -> String {
    let token = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':' | '/' | '+' | '@') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if token.is_empty() {
        "-".to_string()
    } else {
        token
    }
}

fn maybe_emit_launch_failure_status(
    kernel_name: &str,
    error: &str,
    dispatch_label: &str,
    active_generation: u64,
) {
    if dispatch_label == "missing-dispatcher" {
        return;
    }

    let safe_error = log_safe(error);
    let safe_kernel = log_safe(kernel_name);
    let key = format!("{active_generation}:{safe_kernel}:{safe_error}");
    let should_emit = {
        let mut guard = state().lock().expect("gpu runtime boundary mutex poisoned");
        guard.reported_failure_keys.insert(key)
    };
    if !should_emit {
        return;
    }

    eprintln!(
        "[gpu-runtime-boundary] gpu_runtime_error kind=launch_failed kernel={} generation={} error={}",
        safe_kernel, active_generation, safe_error
    );
    eprintln!(
        "[gpu-runtime-boundary] gpu-hmr-rejected fallbackUsed=false fallbackReason=runtime_launch_failed kernel={} generation={}",
        safe_kernel, active_generation
    );
    let status = HmrStatus::gpu_rejected_with_fallback_reason(
        "device",
        &format!(
            "GPU kernel launch failed after sidecar reload: kernel={} error={}",
            safe_kernel, safe_error
        ),
        "Keep runtime running but mark GPU HMR degraded until the launch succeeds",
        "runtime_launch_failed",
    );
    eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
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
        assert!(buffers[0].allocation_id.starts_with("runtime-allocation-"));
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
    fn host_identity_snapshot_boundary_accepts_runtime_roles() {
        let _guard = test_guard_for_test();
        reset_for_test();
        let role = CString::new("core_state").unwrap();
        let value = 42_u64;

        synthi_gpu_record_host_identity(role.as_ptr(), (&value as *const u64).cast(), value);

        let identities = host_identity_records_snapshot();
        assert_eq!(identities.len(), 1);
        assert_eq!(identities[0].role, "core_state");
        assert_eq!(identities[0].ptr, (&value as *const u64) as usize);
        assert_eq!(identities[0].aux, value);
        assert_eq!(identities[0].generation, current_launch_generation());
    }

    #[test]
    fn launch_boundary_records_generic_host_path_identity() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let kernel = CString::new("vec_add").unwrap();
        let grid = 8_u32;
        let block = 256_u32;
        assert!(!synthi_gpu_launch_raw(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            (&grid as *const u32).cast(),
            std::mem::size_of_val(&grid),
            (&block as *const u32).cast(),
            std::mem::size_of_val(&block),
            0,
            0,
            std::ptr::null(),
            0,
        ));
        clear_launch_dispatcher();
        assert!(!synthi_gpu_launch_raw(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            (&grid as *const u32).cast(),
            std::mem::size_of_val(&grid),
            (&block as *const u32).cast(),
            std::mem::size_of_val(&block),
            0,
            0,
            std::ptr::null(),
            0,
        ));

        let identities = host_identity_records_snapshot();
        let runner_identities = identities
            .iter()
            .filter(|record| record.role == "runner_process")
            .collect::<Vec<_>>();
        assert_eq!(runner_identities.len(), 2);
        assert_eq!(runner_identities[0].ptr, std::process::id() as usize);
        assert_eq!(runner_identities[0].ptr, runner_identities[1].ptr);
        assert_eq!(runner_identities[0].aux, runner_identities[1].aux);
        assert_ne!(
            runner_identities[0].generation,
            runner_identities[1].generation
        );
        let launch_identities = identities
            .iter()
            .filter(|record| record.role.starts_with("launch_kernel_"))
            .collect::<Vec<_>>();
        assert_eq!(launch_identities.len(), 2);
        assert_eq!(launch_identities[0].role, launch_identities[1].role);
        assert_eq!(launch_identities[0].ptr, kernel.as_ptr() as usize);
        assert_eq!(launch_identities[0].ptr, launch_identities[1].ptr);
        assert_eq!(launch_identities[0].aux, launch_identities[1].aux);
        assert_ne!(
            launch_identities[0].generation,
            launch_identities[1].generation
        );
        assert_eq!(
            launch_identities[0].runtime_session_id,
            launch_identities[1].runtime_session_id
        );
    }

    #[test]
    fn hmr_runtime_identity_snapshot_records_generation_lineage() {
        let _guard = test_guard_for_test();
        reset_for_test();

        record_hmr_runtime_identity_snapshot();
        clear_launch_dispatcher();
        record_hmr_runtime_identity_snapshot();

        let identities = host_identity_records_snapshot();
        for role in ["runner_process", "hmr_boundary_state", "runtime_context"] {
            let role_records = identities
                .iter()
                .filter(|record| record.role == role)
                .collect::<Vec<_>>();
            assert_eq!(role_records.len(), 2);
            assert_eq!(role_records[0].ptr, role_records[1].ptr);
            assert_eq!(role_records[0].aux, role_records[1].aux);
            assert_ne!(role_records[0].generation, role_records[1].generation);
            assert_eq!(
                role_records[0].runtime_session_id,
                role_records[1].runtime_session_id
            );
        }
    }

    #[test]
    fn hmr_runtime_identity_snapshot_replays_latest_app_identity_across_code_only_generation() {
        let _guard = test_guard_for_test();
        reset_for_test();
        let role = CString::new("core_state").unwrap();
        let value = 42_u64;

        synthi_gpu_record_host_identity(role.as_ptr(), (&value as *const u64).cast(), value);
        clear_launch_dispatcher();
        record_hmr_runtime_identity_snapshot();
        clear_launch_dispatcher();
        record_hmr_runtime_identity_snapshot();

        let identities = host_identity_records_snapshot();
        let core_records = identities
            .iter()
            .filter(|record| record.role == "core_state")
            .collect::<Vec<_>>();
        assert_eq!(core_records.len(), 3);
        assert_eq!(
            core_records
                .iter()
                .map(|record| record.generation)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        for record in core_records {
            assert_eq!(record.ptr, (&value as *const u64) as usize);
            assert_eq!(record.aux, value);
        }
    }

    #[test]
    fn output_oracle_boundary_records_deterministic_payload() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let oracle_id = CString::new("probe.checksum").unwrap();
        let kind = CString::new("buffer_checksum").unwrap();
        let expected = CString::new("sha256:abc").unwrap();
        let actual = CString::new("sha256:abc").unwrap();

        synthi_gpu_record_output_oracle(
            oracle_id.as_ptr(),
            kind.as_ptr(),
            expected.as_ptr(),
            actual.as_ptr(),
            true,
        );

        let records = output_oracle_records_snapshot();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].oracle_id, "probe.checksum");
        assert_eq!(records[0].required_oracle_id, "probe.checksum");
        assert_eq!(records[0].kind, "buffer_checksum");
        assert_eq!(records[0].expected, "sha256:abc");
        assert_eq!(records[0].actual, "sha256:abc");
        assert!(records[0].passed);
        assert_eq!(records[0].generation, current_launch_generation());
        assert_eq!(records[0].runtime_session_id, runtime_session_id());
    }

    #[test]
    fn output_oracle_with_provenance_records_complete_runtime_metadata() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let oracle_id = CString::new("probe.pixel").unwrap();
        let kind = CString::new("selected_pixels").unwrap();
        let expected = CString::new("0.25").unwrap();
        let actual = CString::new("0.251").unwrap();
        let tolerance = CString::new("0.005").unwrap();
        let producer = CString::new("runtime_probe").unwrap();
        let output_target = CString::new("target:color").unwrap();
        let artifact_id = CString::new("artifact:abc").unwrap();
        let visual_ref = CString::new("screenshot:frame").unwrap();

        synthi_gpu_record_output_oracle_with_provenance(
            oracle_id.as_ptr(),
            kind.as_ptr(),
            expected.as_ptr(),
            actual.as_ptr(),
            tolerance.as_ptr(),
            producer.as_ptr(),
            output_target.as_ptr(),
            artifact_id.as_ptr(),
            visual_ref.as_ptr(),
            true,
        );

        let records = output_oracle_records_snapshot();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].oracle_id, "probe.pixel");
        assert_eq!(records[0].required_oracle_id, "probe.pixel");
        assert_eq!(records[0].kind, "selected_pixels");
        assert_eq!(records[0].tolerance.as_deref(), Some("0.005"));
        assert_eq!(records[0].producer.as_deref(), Some("runtime_probe"));
        assert_eq!(records[0].output_target_id.as_deref(), Some("target:color"));
        assert!(records[0].readback_timestamp_ms.is_some());
        assert_eq!(records[0].artifact_id.as_deref(), Some("artifact:abc"));
        assert_eq!(
            records[0].visual_evidence_ref.as_deref(),
            Some("screenshot:frame")
        );
        assert!(records[0].passed);
    }

    #[test]
    fn output_oracle_with_probe_records_deterministic_contract_metadata() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let oracle_id = CString::new("probe.pixel").unwrap();
        let kind = CString::new("selected_pixels").unwrap();
        let expected = CString::new("0.25").unwrap();
        let actual = CString::new("0.25").unwrap();
        let tolerance = CString::new("0.005").unwrap();
        let producer = CString::new("runtime_probe").unwrap();
        let output_target = CString::new("target:color").unwrap();
        let artifact_id = CString::new("artifact:abc").unwrap();
        let visual_ref = CString::new("screenshot:frame").unwrap();
        let probe_mode = CString::new("fixed_validation_probe").unwrap();
        let probe_config_hash =
            CString::new("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
                .unwrap();
        let probe_evidence_ref = CString::new("evidence:output-oracle:probe:pixel").unwrap();

        synthi_gpu_record_output_oracle_with_probe(
            oracle_id.as_ptr(),
            kind.as_ptr(),
            expected.as_ptr(),
            actual.as_ptr(),
            tolerance.as_ptr(),
            producer.as_ptr(),
            output_target.as_ptr(),
            artifact_id.as_ptr(),
            visual_ref.as_ptr(),
            probe_mode.as_ptr(),
            probe_config_hash.as_ptr(),
            probe_evidence_ref.as_ptr(),
            true,
        );

        let records = output_oracle_records_snapshot();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].oracle_id, "probe.pixel");
        assert_eq!(records[0].required_oracle_id, "probe.pixel");
        assert_eq!(records[0].kind, "selected_pixels");
        assert_eq!(records[0].tolerance.as_deref(), Some("0.005"));
        assert_eq!(records[0].producer.as_deref(), Some("runtime_probe"));
        assert_eq!(records[0].output_target_id.as_deref(), Some("target:color"));
        assert!(records[0].readback_timestamp_ms.is_some());
        assert_eq!(records[0].artifact_id.as_deref(), Some("artifact:abc"));
        assert_eq!(
            records[0].visual_evidence_ref.as_deref(),
            Some("screenshot:frame")
        );
        assert_eq!(
            records[0].probe_mode.as_deref(),
            Some("fixed_validation_probe")
        );
        assert_eq!(
            records[0].probe_config_hash.as_deref(),
            Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(
            records[0].probe_evidence_ref.as_deref(),
            Some("evidence:output-oracle:probe:pixel")
        );
        assert!(records[0].passed);
    }

    #[test]
    fn output_buffer_checksum_boundary_hashes_runtime_bytes() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let bytes = b"deterministic output bytes";
        let expected_text = sha256_checksum_value(bytes);
        let expected = CString::new(expected_text.clone()).unwrap();
        let oracle_id = CString::new("probe.buffer").unwrap();

        assert!(synthi_gpu_record_output_buffer_checksum(
            oracle_id.as_ptr(),
            bytes.as_ptr().cast(),
            bytes.len(),
            expected.as_ptr(),
        ));

        let records = output_oracle_records_snapshot();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].oracle_id, "probe.buffer");
        assert_eq!(records[0].required_oracle_id, "probe.buffer");
        assert_eq!(records[0].kind, "buffer_checksum");
        assert_eq!(records[0].expected, expected_text);
        assert_eq!(records[0].actual, expected_text);
        assert!(records[0].passed);
    }

    #[test]
    fn output_buffer_checksum_with_provenance_records_runtime_metadata() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let bytes = b"deterministic output bytes";
        let expected_text = sha256_checksum_value(bytes);
        let expected = CString::new(expected_text.clone()).unwrap();
        let oracle_id = CString::new("probe.buffer").unwrap();
        let producer = CString::new("runtime_probe").unwrap();
        let output_target = CString::new("buffer:color").unwrap();
        let artifact_id = CString::new("artifact:def").unwrap();

        assert!(synthi_gpu_record_output_buffer_checksum_with_provenance(
            oracle_id.as_ptr(),
            bytes.as_ptr().cast(),
            bytes.len(),
            expected.as_ptr(),
            producer.as_ptr(),
            output_target.as_ptr(),
            artifact_id.as_ptr(),
            std::ptr::null(),
        ));

        let records = output_oracle_records_snapshot();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].oracle_id, "probe.buffer");
        assert_eq!(records[0].required_oracle_id, "probe.buffer");
        assert_eq!(records[0].kind, "buffer_checksum");
        assert_eq!(records[0].expected, expected_text);
        assert_eq!(records[0].actual, expected_text);
        assert_eq!(records[0].producer.as_deref(), Some("runtime_probe"));
        assert_eq!(records[0].output_target_id.as_deref(), Some("buffer:color"));
        assert!(records[0].readback_timestamp_ms.is_some());
        assert_eq!(records[0].artifact_id.as_deref(), Some("artifact:def"));
        assert_eq!(records[0].visual_evidence_ref, None);
        assert!(records[0].passed);
    }

    #[test]
    fn output_buffer_checksum_with_probe_records_deterministic_contract_metadata() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let bytes = b"deterministic output bytes";
        let expected_text = sha256_checksum_value(bytes);
        let expected = CString::new(expected_text.clone()).unwrap();
        let oracle_id = CString::new("probe.buffer").unwrap();
        let producer = CString::new("runtime_probe").unwrap();
        let output_target = CString::new("buffer:color").unwrap();
        let artifact_id = CString::new("artifact:def").unwrap();
        let probe_mode = CString::new("fixed_validation_probe").unwrap();
        let probe_config_hash =
            CString::new("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
                .unwrap();
        let probe_evidence_ref = CString::new("evidence:output-oracle:probe:buffer").unwrap();

        assert!(synthi_gpu_record_output_buffer_checksum_with_probe(
            oracle_id.as_ptr(),
            bytes.as_ptr().cast(),
            bytes.len(),
            expected.as_ptr(),
            producer.as_ptr(),
            output_target.as_ptr(),
            artifact_id.as_ptr(),
            std::ptr::null(),
            probe_mode.as_ptr(),
            probe_config_hash.as_ptr(),
            probe_evidence_ref.as_ptr(),
        ));

        let records = output_oracle_records_snapshot();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].oracle_id, "probe.buffer");
        assert_eq!(records[0].required_oracle_id, "probe.buffer");
        assert_eq!(records[0].kind, "buffer_checksum");
        assert_eq!(records[0].expected, expected_text);
        assert_eq!(records[0].actual, expected_text);
        assert_eq!(records[0].producer.as_deref(), Some("runtime_probe"));
        assert_eq!(records[0].output_target_id.as_deref(), Some("buffer:color"));
        assert!(records[0].readback_timestamp_ms.is_some());
        assert_eq!(records[0].artifact_id.as_deref(), Some("artifact:def"));
        assert_eq!(records[0].visual_evidence_ref, None);
        assert_eq!(
            records[0].probe_mode.as_deref(),
            Some("fixed_validation_probe")
        );
        assert_eq!(
            records[0].probe_config_hash.as_deref(),
            Some("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
        assert_eq!(
            records[0].probe_evidence_ref.as_deref(),
            Some("evidence:output-oracle:probe:buffer")
        );
        assert!(records[0].passed);
    }

    #[test]
    fn output_oracle_records_latest_generation_dispatch_id() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let calls = Arc::new(Mutex::new(Vec::new()));
        install_launch_dispatcher(Arc::new(TestDispatcher {
            should_fail: false,
            calls,
        }));

        let kernel = CString::new("oracle_linked").unwrap();
        let dim = 1_u32;
        let scalar = 42_u32;
        let args = [SynthiGpuLaunchArg {
            value_ptr: (&scalar as *const u32).cast(),
            value_size: std::mem::size_of_val(&scalar),
            value_kind: SYNTHI_GPU_ARG_KIND_INTEGER,
        }];

        assert!(synthi_gpu_launch_raw_arg_info(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            0,
            0,
            args.as_ptr(),
            args.len(),
        ));

        let dispatch_id = launch_records_snapshot()[0]
            .dispatch_id
            .clone()
            .expect("dispatch id");
        let bytes = b"dispatch-linked output";
        let expected_text = sha256_checksum_value(bytes);
        let expected = CString::new(expected_text).unwrap();
        let oracle_id = CString::new("probe.dispatch-linked").unwrap();

        assert!(synthi_gpu_record_output_buffer_checksum(
            oracle_id.as_ptr(),
            bytes.as_ptr().cast(),
            bytes.len(),
            expected.as_ptr(),
        ));

        let records = output_oracle_records_snapshot();
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].after_dispatch_id.as_deref(),
            Some(dispatch_id.as_str())
        );
    }

    #[test]
    fn output_oracle_provenance_uses_active_artifact_when_not_supplied() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let calls = Arc::new(Mutex::new(Vec::new()));
        install_launch_dispatcher_with_metadata(
            Arc::new(TestDispatcher {
                should_fail: false,
                calls,
            }),
            GpuLaunchDispatcherMetadata {
                artifact_id: Some("artifact:active".to_string()),
                ..GpuLaunchDispatcherMetadata::default()
            },
        );

        let oracle_id = CString::new("probe.pixel").unwrap();
        let kind = CString::new("selected_pixels").unwrap();
        let expected = CString::new("0.25").unwrap();
        let actual = CString::new("0.25").unwrap();
        let producer = CString::new("runtime_probe").unwrap();
        let output_target = CString::new("target:color").unwrap();
        synthi_gpu_record_output_oracle_with_provenance(
            oracle_id.as_ptr(),
            kind.as_ptr(),
            expected.as_ptr(),
            actual.as_ptr(),
            std::ptr::null(),
            producer.as_ptr(),
            output_target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            true,
        );

        let bytes = b"deterministic output bytes";
        let expected_text = sha256_checksum_value(bytes);
        let expected_checksum = CString::new(expected_text).unwrap();
        let checksum_id = CString::new("probe.buffer").unwrap();
        assert!(synthi_gpu_record_output_buffer_checksum_with_provenance(
            checksum_id.as_ptr(),
            bytes.as_ptr().cast(),
            bytes.len(),
            expected_checksum.as_ptr(),
            producer.as_ptr(),
            output_target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
        ));

        let records = output_oracle_records_snapshot();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].artifact_id.as_deref(), Some("artifact:active"));
        assert_eq!(records[1].artifact_id.as_deref(), Some("artifact:active"));
    }

    #[test]
    fn output_buffer_checksum_boundary_rejects_missing_expected_value() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let bytes = b"deterministic output bytes";
        let oracle_id = CString::new("probe.buffer").unwrap();

        assert!(!synthi_gpu_record_output_buffer_checksum(
            oracle_id.as_ptr(),
            bytes.as_ptr().cast(),
            bytes.len(),
            std::ptr::null(),
        ));

        let records = output_oracle_records_snapshot();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, "buffer_checksum");
        assert_eq!(records[0].expected, "");
        assert!(records[0].actual.starts_with("sha256:"));
        assert!(!records[0].passed);
    }

    #[test]
    fn original_host_path_boundary_records_runtime_attachment() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let host_path_id = CString::new("host-main-loop").unwrap();
        let dispatch_entry_id = CString::new("kernel-entry").unwrap();

        synthi_gpu_record_original_host_path(
            host_path_id.as_ptr(),
            dispatch_entry_id.as_ptr(),
            true,
        );

        let records = original_host_path_records_snapshot();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].host_path_id, "host-main-loop");
        assert_eq!(records[0].dispatch_table_entry_id, "kernel-entry");
        assert_eq!(records[0].runtime_dispatch_table_entry_id, None);
        assert!(!records[0].dispatch_entry_runtime_verified);
        assert!(records[0].dispatch_boundary_observed);
        assert_eq!(records[0].attachment_provenance, "runtime_explicit");
        assert_eq!(records[0].generation, current_launch_generation());
        assert_eq!(records[0].runtime_session_id, runtime_session_id());
    }

    #[test]
    fn original_host_path_boundary_records_attachment_provenance() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let host_path_id = CString::new("host-render-loop").unwrap();
        let dispatch_entry_id = CString::new("kernel-entry").unwrap();
        let provenance = CString::new("source_instrumented").unwrap();

        synthi_gpu_record_original_host_path_with_provenance(
            host_path_id.as_ptr(),
            dispatch_entry_id.as_ptr(),
            provenance.as_ptr(),
            true,
        );

        let records = original_host_path_records_snapshot();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].host_path_id, "host-render-loop");
        assert_eq!(records[0].dispatch_table_entry_id, "kernel-entry");
        assert_eq!(records[0].runtime_dispatch_table_entry_id, None);
        assert!(!records[0].dispatch_entry_runtime_verified);
        assert!(records[0].dispatch_boundary_observed);
        assert_eq!(records[0].attachment_provenance, "source_instrumented");
        assert_eq!(records[0].runtime_session_id, runtime_session_id());
    }

    #[test]
    fn original_host_path_launch_wrapper_records_matching_launch_boundary() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let kernel = CString::new("trace_primary").unwrap();
        let host_path_id = CString::new("host-render-loop").unwrap();
        let dispatch_entry_id = CString::new("trace_primary:0x42").unwrap();
        let provenance = CString::new("source_instrumented").unwrap();
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        install_launch_dispatcher_with_metadata(
            Arc::new(TestDispatcher {
                should_fail: false,
                calls,
            }),
            GpuLaunchDispatcherMetadata {
                artifact_id: Some("artifact:sha256:host-path".to_string()),
                dispatch_table_hash: Some("0xfeed".to_string()),
                changed_symbols: vec!["trace_primary".to_string()],
                function_handle_ids: vec!["trace_primary:0x42".to_string()],
            },
        );
        let grid = [1_u32, 1, 1];
        let block = [64_u32, 1, 1];
        let value = 42_u32;
        let arg = SynthiGpuLaunchArg {
            value_ptr: (&value as *const u32).cast(),
            value_size: std::mem::size_of_val(&value),
            value_kind: SYNTHI_GPU_ARG_KIND_INTEGER,
        };

        let ok = synthi_gpu_launch_original_host_path_raw_arg_info_checked(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            grid.as_ptr().cast(),
            std::mem::size_of_val(&grid),
            block.as_ptr().cast(),
            std::mem::size_of_val(&block),
            0,
            0,
            &arg,
            1,
            current_launch_generation(),
            host_path_id.as_ptr(),
            dispatch_entry_id.as_ptr(),
            provenance.as_ptr(),
        );

        assert!(ok);
        let host_paths = original_host_path_records_snapshot();
        let launches = launch_records_snapshot();
        assert_eq!(host_paths.len(), 1);
        assert_eq!(launches.len(), 1);
        assert_eq!(host_paths[0].host_path_id, "host-render-loop");
        assert_eq!(host_paths[0].dispatch_table_entry_id, "trace_primary:0x42");
        assert_eq!(
            host_paths[0].runtime_dispatch_table_entry_id.as_deref(),
            Some("trace_primary:0x42")
        );
        assert!(host_paths[0].dispatch_entry_runtime_verified);
        assert!(host_paths[0].dispatch_boundary_observed);
        assert_eq!(host_paths[0].attachment_provenance, "source_instrumented");
        assert_eq!(host_paths[0].generation, launches[0].active_generation);
        assert_eq!(
            host_paths[0].runtime_session_id,
            launches[0].runtime_session_id
        );
        assert_eq!(launches[0].kernel_name, "trace_primary");
    }

    #[test]
    fn original_host_path_launch_wrapper_can_runtime_bind_dispatch_entry() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let kernel = CString::new("trace_primary").unwrap();
        let host_path_id = CString::new("host-render-loop").unwrap();
        let provenance = CString::new("source_instrumented").unwrap();
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        install_launch_dispatcher_with_metadata(
            Arc::new(TestDispatcher {
                should_fail: false,
                calls,
            }),
            GpuLaunchDispatcherMetadata {
                artifact_id: Some("artifact:sha256:host-path-auto".to_string()),
                dispatch_table_hash: Some("0xfeed".to_string()),
                changed_symbols: vec!["trace_primary".to_string()],
                function_handle_ids: vec!["trace_primary:0x77".to_string()],
            },
        );
        let grid = [1_u32, 1, 1];
        let block = [64_u32, 1, 1];
        let value = 42_u32;
        let arg = SynthiGpuLaunchArg {
            value_ptr: (&value as *const u32).cast(),
            value_size: std::mem::size_of_val(&value),
            value_kind: SYNTHI_GPU_ARG_KIND_INTEGER,
        };

        let ok = synthi_gpu_launch_original_host_path_raw_arg_info_checked(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            grid.as_ptr().cast(),
            std::mem::size_of_val(&grid),
            block.as_ptr().cast(),
            std::mem::size_of_val(&block),
            0,
            0,
            &arg,
            1,
            current_launch_generation(),
            host_path_id.as_ptr(),
            std::ptr::null(),
            provenance.as_ptr(),
        );

        assert!(ok);
        let host_paths = original_host_path_records_snapshot();
        let launches = launch_records_snapshot();
        assert_eq!(host_paths.len(), 1);
        assert_eq!(launches.len(), 1);
        assert_eq!(host_paths[0].host_path_id, "host-render-loop");
        assert_eq!(host_paths[0].dispatch_table_entry_id, "trace_primary:0x77");
        assert_eq!(
            host_paths[0].runtime_dispatch_table_entry_id.as_deref(),
            Some("trace_primary:0x77")
        );
        assert!(host_paths[0].dispatch_entry_runtime_verified);
        assert!(host_paths[0].dispatch_boundary_observed);
        assert_eq!(host_paths[0].attachment_provenance, "source_instrumented");
        assert_eq!(host_paths[0].generation, launches[0].active_generation);
        assert_eq!(
            host_paths[0].runtime_session_id,
            launches[0].runtime_session_id
        );
        assert_eq!(launches[0].kernel_name, "trace_primary");
    }

    #[test]
    fn original_host_path_launch_wrapper_defaults_to_runtime_provenance() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let kernel = CString::new("trace_primary").unwrap();
        let host_path_id = CString::new("host-render-loop").unwrap();
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        install_launch_dispatcher_with_metadata(
            Arc::new(TestDispatcher {
                should_fail: false,
                calls,
            }),
            GpuLaunchDispatcherMetadata {
                artifact_id: Some("artifact:sha256:host-path-default".to_string()),
                dispatch_table_hash: Some("0xfeed".to_string()),
                changed_symbols: vec!["trace_primary".to_string()],
                function_handle_ids: vec!["trace_primary:0x88".to_string()],
            },
        );
        let grid = [1_u32, 1, 1];
        let block = [64_u32, 1, 1];
        let value = 42_u32;
        let arg = SynthiGpuLaunchArg {
            value_ptr: (&value as *const u32).cast(),
            value_size: std::mem::size_of_val(&value),
            value_kind: SYNTHI_GPU_ARG_KIND_INTEGER,
        };

        let ok = synthi_gpu_launch_original_host_path_raw_arg_info_checked(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            grid.as_ptr().cast(),
            std::mem::size_of_val(&grid),
            block.as_ptr().cast(),
            std::mem::size_of_val(&block),
            0,
            0,
            &arg,
            1,
            current_launch_generation(),
            host_path_id.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
        );

        assert!(ok);
        let host_paths = original_host_path_records_snapshot();
        assert_eq!(host_paths.len(), 1);
        assert_eq!(host_paths[0].dispatch_table_entry_id, "trace_primary:0x88");
        assert!(host_paths[0].dispatch_entry_runtime_verified);
        assert_eq!(host_paths[0].attachment_provenance, "host_runtime_explicit");
    }

    #[test]
    fn source_location_launch_wrapper_binds_runtime_dispatch_entry() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let kernel = CString::new("trace_primary").unwrap();
        let host_path_id = CString::new("src/render_loop.cpp:42").unwrap();
        let provenance = CString::new("source_instrumented").unwrap();
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        install_launch_dispatcher_with_metadata(
            Arc::new(TestDispatcher {
                should_fail: false,
                calls,
            }),
            GpuLaunchDispatcherMetadata {
                artifact_id: Some("artifact:sha256:source-location".to_string()),
                dispatch_table_hash: Some("0xbeef".to_string()),
                changed_symbols: vec!["trace_primary".to_string()],
                function_handle_ids: vec!["trace_primary:0x99".to_string()],
            },
        );
        let grid = [1_u32, 1, 1];
        let block = [64_u32, 1, 1];
        let value = 42_u32;
        let arg = SynthiGpuLaunchArg {
            value_ptr: (&value as *const u32).cast(),
            value_size: std::mem::size_of_val(&value),
            value_kind: SYNTHI_GPU_ARG_KIND_INTEGER,
        };

        let ok = synthi_gpu_launch_source_location_raw_arg_info_checked(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            grid.as_ptr().cast(),
            std::mem::size_of_val(&grid),
            block.as_ptr().cast(),
            std::mem::size_of_val(&block),
            0,
            0,
            &arg,
            1,
            current_launch_generation(),
            host_path_id.as_ptr(),
            provenance.as_ptr(),
        );

        assert!(ok);
        let host_paths = original_host_path_records_snapshot();
        let launches = launch_records_snapshot();
        assert_eq!(host_paths.len(), 1);
        assert_eq!(launches.len(), 1);
        assert_eq!(host_paths[0].host_path_id, "src/render_loop.cpp:42");
        assert_eq!(host_paths[0].dispatch_table_entry_id, "trace_primary:0x99");
        assert_eq!(
            host_paths[0].runtime_dispatch_table_entry_id.as_deref(),
            Some("trace_primary:0x99")
        );
        assert!(host_paths[0].dispatch_entry_runtime_verified);
        assert_eq!(host_paths[0].attachment_provenance, "source_instrumented");
        assert_eq!(host_paths[0].generation, launches[0].active_generation);
        assert_eq!(
            host_paths[0].runtime_session_id,
            launches[0].runtime_session_id
        );
    }

    #[test]
    fn original_host_path_record_binds_to_latest_runtime_launch_boundary() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let kernel = CString::new("trace_primary").unwrap();
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        install_launch_dispatcher_with_metadata(
            Arc::new(TestDispatcher {
                should_fail: false,
                calls,
            }),
            GpuLaunchDispatcherMetadata {
                artifact_id: Some("artifact:sha256:host-path".to_string()),
                dispatch_table_hash: Some("0xfeed".to_string()),
                changed_symbols: vec!["trace_primary".to_string()],
                function_handle_ids: vec!["trace_primary:0x42".to_string()],
            },
        );

        let grid = [1_u32, 1, 1];
        let block = [64_u32, 1, 1];
        let value = 42_u32;
        let arg = SynthiGpuLaunchArg {
            value_ptr: (&value as *const u32).cast(),
            value_size: std::mem::size_of_val(&value),
            value_kind: SYNTHI_GPU_ARG_KIND_INTEGER,
        };
        assert!(synthi_gpu_launch_raw_arg_info_checked(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            grid.as_ptr().cast(),
            std::mem::size_of_val(&grid),
            block.as_ptr().cast(),
            std::mem::size_of_val(&block),
            0,
            0,
            &arg,
            1,
            current_launch_generation(),
        ));

        let host_path_id = CString::new("host-render-loop").unwrap();
        let dispatch_entry_id = CString::new("trace_primary:0x42").unwrap();
        let provenance = CString::new("runtime_explicit").unwrap();
        synthi_gpu_record_original_host_path_with_provenance(
            host_path_id.as_ptr(),
            dispatch_entry_id.as_ptr(),
            provenance.as_ptr(),
            true,
        );

        let host_paths = original_host_path_records_snapshot();
        let launches = launch_records_snapshot();
        assert_eq!(host_paths.len(), 1);
        assert_eq!(launches.len(), 1);
        assert_eq!(host_paths[0].host_path_id, "host-render-loop");
        assert_eq!(host_paths[0].dispatch_table_entry_id, "trace_primary:0x42");
        assert_eq!(
            host_paths[0].runtime_dispatch_table_entry_id.as_deref(),
            Some("trace_primary:0x42")
        );
        assert!(host_paths[0].dispatch_entry_runtime_verified);
        assert!(host_paths[0].dispatch_boundary_observed);
        assert_eq!(host_paths[0].generation, launches[0].active_generation);
        assert_eq!(
            host_paths[0].runtime_session_id,
            launches[0].runtime_session_id
        );
    }

    #[test]
    fn original_host_path_record_rejects_mismatched_runtime_dispatch_entry() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let kernel = CString::new("trace_primary").unwrap();
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        install_launch_dispatcher_with_metadata(
            Arc::new(TestDispatcher {
                should_fail: false,
                calls,
            }),
            GpuLaunchDispatcherMetadata {
                artifact_id: Some("artifact:sha256:host-path".to_string()),
                dispatch_table_hash: Some("0xfeed".to_string()),
                changed_symbols: vec!["trace_primary".to_string()],
                function_handle_ids: vec!["trace_primary:0x42".to_string()],
            },
        );

        let grid = [1_u32, 1, 1];
        let block = [64_u32, 1, 1];
        let value = 42_u32;
        let arg = SynthiGpuLaunchArg {
            value_ptr: (&value as *const u32).cast(),
            value_size: std::mem::size_of_val(&value),
            value_kind: SYNTHI_GPU_ARG_KIND_INTEGER,
        };

        let host_path_id = CString::new("host-render-loop").unwrap();
        let dispatch_entry_id = CString::new("host-declared-entry").unwrap();
        let provenance = CString::new("source_instrumented").unwrap();
        assert!(synthi_gpu_launch_original_host_path_raw_arg_info_checked(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            grid.as_ptr().cast(),
            std::mem::size_of_val(&grid),
            block.as_ptr().cast(),
            std::mem::size_of_val(&block),
            0,
            0,
            &arg,
            1,
            current_launch_generation(),
            host_path_id.as_ptr(),
            dispatch_entry_id.as_ptr(),
            provenance.as_ptr(),
        ));

        let host_paths = original_host_path_records_snapshot();
        assert_eq!(host_paths.len(), 1);
        assert_eq!(host_paths[0].dispatch_table_entry_id, "host-declared-entry");
        assert_eq!(
            host_paths[0].runtime_dispatch_table_entry_id.as_deref(),
            Some("trace_primary:0x42")
        );
        assert!(!host_paths[0].dispatch_entry_runtime_verified);
        assert!(host_paths[0].dispatch_boundary_observed);
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
        assert_eq!(launches[0].runtime_session_id, runtime_session_id());
        assert_eq!(launches[0].grid, (12, 2, 1));
        assert_eq!(launches[0].block, (256, 1, 1));
        assert_eq!(launches[0].arg_count, 4);
        assert_eq!(launches[0].arg_provenance.len(), 4);
        assert!(!launches[0].arg_provenance_complete);
        assert_eq!(launches[0].arg_provenance[0].kind, "missing-arg-storage");
        assert!(!launches[0].dispatched);
        assert_eq!(
            launches[0].dispatch_error.as_deref(),
            Some("no GPU launch dispatcher installed")
        );
        assert!(managed_buffers_snapshot()[0].dirty);
        assert!(original_host_path_records_snapshot().is_empty());
    }

    #[test]
    fn launch_arg_info_records_registered_pointer_and_scalar_provenance() {
        let _guard = test_guard_for_test();
        reset_for_test();
        let mut device_value = 7_u32;
        let name = CString::new("registered").unwrap();
        synthi_gpu_register_buffer(
            std::ptr::null_mut(),
            (&mut device_value as *mut u32).cast(),
            std::mem::size_of_val(&device_value),
            name.as_ptr(),
            std::ptr::null(),
        );

        let device_ptr = (&mut device_value as *mut u32).cast::<c_void>();
        let scalar = 42_u32;
        let args = [
            SynthiGpuLaunchArg {
                value_ptr: (&device_ptr as *const *mut c_void).cast(),
                value_size: std::mem::size_of_val(&device_ptr),
                value_kind: SYNTHI_GPU_ARG_KIND_POINTER,
            },
            SynthiGpuLaunchArg {
                value_ptr: (&scalar as *const u32).cast(),
                value_size: std::mem::size_of_val(&scalar),
                value_kind: SYNTHI_GPU_ARG_KIND_INTEGER,
            },
        ];
        let kernel = CString::new("with_provenance").unwrap();
        let dim = 1_u32;

        let ok = synthi_gpu_launch_raw_arg_info(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            0,
            0,
            args.as_ptr(),
            args.len(),
        );

        assert!(!ok);
        let launches = launch_records_snapshot();
        assert_eq!(launches.len(), 1);
        assert!(launches[0].arg_provenance_complete);
        assert_eq!(launches[0].arg_provenance[0].kind, "device-allocation");
        assert!(launches[0].arg_provenance[0]
            .allocation_id
            .as_deref()
            .is_some_and(|id| id.starts_with("runtime-allocation-")));
        assert_eq!(
            launches[0].arg_provenance[0].allocation_name.as_deref(),
            Some("registered")
        );
        assert_eq!(
            launches[0].arg_provenance[0].allocation_bytes,
            Some(std::mem::size_of_val(&device_value))
        );
        assert_eq!(launches[0].arg_provenance[0].allocation_offset, Some(0));
        assert_eq!(launches[0].arg_provenance[1].kind, "scalar-value");
        let details = arg_provenance_details(&launches[0].arg_provenance);
        assert!(details.contains("0:device-allocation:registered"));
        assert!(details.contains(":alloc_id=runtime-allocation-"));
        assert!(details.contains("alloc_bytes=4"));
        assert!(details.contains("alloc_offset=0"));
        assert!(details.contains("1:scalar-value:size=4"));
    }

    #[test]
    fn unnamed_registered_pointer_provenance_carries_runtime_allocation_identity() {
        let _guard = test_guard_for_test();
        reset_for_test();
        let mut device_value = 11_u32;
        synthi_gpu_register_buffer(
            std::ptr::null_mut(),
            (&mut device_value as *mut u32).cast(),
            std::mem::size_of_val(&device_value),
            std::ptr::null(),
            std::ptr::null(),
        );

        let device_ptr = (&mut device_value as *mut u32).cast::<c_void>();
        let args = [SynthiGpuLaunchArg {
            value_ptr: (&device_ptr as *const *mut c_void).cast(),
            value_size: std::mem::size_of_val(&device_ptr),
            value_kind: SYNTHI_GPU_ARG_KIND_POINTER,
        }];
        let kernel = CString::new("unnamed_registered").unwrap();
        let dim = 1_u32;

        let ok = synthi_gpu_launch_raw_arg_info(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            0,
            0,
            args.as_ptr(),
            args.len(),
        );

        assert!(!ok);
        let launches = launch_records_snapshot();
        assert!(launches[0].arg_provenance_complete);
        assert_eq!(launches[0].arg_provenance[0].kind, "device-allocation");
        assert!(launches[0].arg_provenance[0].allocation_name.is_none());
        let allocation_id = launches[0].arg_provenance[0]
            .allocation_id
            .as_deref()
            .unwrap();
        assert!(allocation_id.starts_with("runtime-allocation-"));
        let details = arg_provenance_details(&launches[0].arg_provenance);
        assert!(details.contains(&format!("0:device-allocation:alloc_id={allocation_id}")));
        assert!(details.contains("alloc_bytes=4"));
    }

    #[test]
    fn launch_arg_info_marks_unknown_pointer_sized_values_unproven() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let unknown_ptr = 0x1000usize as *mut c_void;
        let args = [SynthiGpuLaunchArg {
            value_ptr: (&unknown_ptr as *const *mut c_void).cast(),
            value_size: std::mem::size_of_val(&unknown_ptr),
            value_kind: SYNTHI_GPU_ARG_KIND_POINTER,
        }];
        let kernel = CString::new("unknown_ptr").unwrap();
        let dim = 1_u32;

        let ok = synthi_gpu_launch_raw_arg_info(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            0,
            0,
            args.as_ptr(),
            args.len(),
        );

        assert!(!ok);
        let launches = launch_records_snapshot();
        assert!(!launches[0].arg_provenance_complete);
        assert_eq!(launches[0].arg_provenance[0].kind, "unknown-pointer");
    }

    #[test]
    fn launch_arg_info_treats_pointer_sized_declared_scalar_as_proven() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let frame = 123_u64;
        let args = [SynthiGpuLaunchArg {
            value_ptr: (&frame as *const u64).cast(),
            value_size: std::mem::size_of_val(&frame),
            value_kind: SYNTHI_GPU_ARG_KIND_INTEGER,
        }];
        let kernel = CString::new("pointer_sized_scalar").unwrap();
        let dim = 1_u32;

        let ok = synthi_gpu_launch_raw_arg_info(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            0,
            0,
            args.as_ptr(),
            args.len(),
        );

        assert!(!ok);
        let launches = launch_records_snapshot();
        assert!(launches[0].arg_provenance_complete);
        assert_eq!(launches[0].arg_provenance[0].kind, "scalar-value");
    }

    #[test]
    fn legacy_launch_args_without_sizes_are_unproven() {
        let _guard = test_guard_for_test();
        reset_for_test();

        let scalar = 7_u32;
        let raw_args = [(&scalar as *const u32).cast::<c_void>()];
        let kernel = CString::new("legacy").unwrap();
        let dim = 1_u32;

        let ok = synthi_gpu_launch_raw(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            (&dim as *const u32).cast(),
            std::mem::size_of_val(&dim),
            0,
            0,
            raw_args.as_ptr(),
            raw_args.len(),
        );

        assert!(!ok);
        let launches = launch_records_snapshot();
        assert!(!launches[0].arg_provenance_complete);
        assert_eq!(launches[0].arg_provenance[0].kind, "legacy-unknown-size");
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
        assert!(launches[0].dispatch_timestamp_ms.is_some());
        assert_eq!(
            launches[0].expected_generation,
            launches[0].active_generation
        );

        assert!(original_host_path_records_snapshot().is_empty());
    }

    #[test]
    fn launch_records_dispatcher_artifact_binding_metadata() {
        let _guard = test_guard_for_test();
        reset_for_test();
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        let (_previous, generation) = install_launch_dispatcher_with_metadata(
            Arc::new(TestDispatcher {
                should_fail: false,
                calls: calls.clone(),
            }),
            GpuLaunchDispatcherMetadata {
                artifact_id: Some("artifact:sha256:test".to_string()),
                dispatch_table_hash: Some("0xabc".to_string()),
                changed_symbols: vec!["bound_kernel".to_string()],
                function_handle_ids: vec!["bound_kernel:0x10".to_string()],
            },
        );

        let kernel = CString::new("bound_kernel").unwrap();
        let dim = 1_u32;
        assert!(synthi_gpu_launch_raw(
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
        ));

        let launches = launch_records_snapshot();
        assert_eq!(launches.len(), 1);
        assert_eq!(launches[0].active_generation, generation);
        assert_eq!(
            launches[0].active_artifact_id.as_deref(),
            Some("artifact:sha256:test")
        );
        assert_eq!(launches[0].dispatch_table_hash.as_deref(), Some("0xabc"));
        assert_eq!(
            launches[0].dispatch_table_entry_id.as_deref(),
            Some("bound_kernel:0x10")
        );
        assert!(launches[0]
            .dispatcher_registration_id
            .as_deref()
            .is_some_and(|value| value.starts_with("dispatcher:sha256:")));
    }

    #[test]
    fn invalid_launch_dimensions_reject_before_dispatch() {
        let _guard = test_guard_for_test();
        reset_for_test();
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        install_launch_dispatcher(Arc::new(TestDispatcher {
            should_fail: false,
            calls: calls.clone(),
        }));

        let kernel = CString::new("invalid_dims").unwrap();
        let grid = [u32::MAX, 1, 1];
        let block = [16_u32, 16, 1];
        let ok = synthi_gpu_launch_raw(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            grid.as_ptr().cast(),
            std::mem::size_of_val(&grid),
            block.as_ptr().cast(),
            std::mem::size_of_val(&block),
            0,
            0,
            std::ptr::null(),
            1,
        );

        assert!(!ok);
        assert!(calls.lock().unwrap().is_empty());
        let launches = launch_records_snapshot();
        assert_eq!(launches.len(), 1);
        assert_eq!(launches[0].kernel_name, "invalid_dims");
        assert_eq!(launches[0].grid, (u32::MAX, 1, 1));
        assert_eq!(launches[0].block, (16, 16, 1));
        assert!(!launches[0].dispatched);
        let error = launches[0].dispatch_error.as_deref().unwrap_or_default();
        assert!(error.contains("gpu_launch_invalid_dimensions"));
        assert!(error.contains("grid[0] is sentinel-max"));
    }

    #[test]
    fn zero_launch_dimensions_reject_before_dispatch() {
        let _guard = test_guard_for_test();
        reset_for_test();
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        install_launch_dispatcher(Arc::new(TestDispatcher {
            should_fail: false,
            calls: calls.clone(),
        }));

        let kernel = CString::new("zero_dims").unwrap();
        let grid = [1_u32, 1, 1];
        let block = [0_u32, 16, 1];
        let ok = synthi_gpu_launch_raw(
            std::ptr::null_mut(),
            kernel.as_ptr(),
            grid.as_ptr().cast(),
            std::mem::size_of_val(&grid),
            block.as_ptr().cast(),
            std::mem::size_of_val(&block),
            0,
            0,
            std::ptr::null(),
            1,
        );

        assert!(!ok);
        assert!(calls.lock().unwrap().is_empty());
        let launches = launch_records_snapshot();
        assert_eq!(launches.len(), 1);
        assert_eq!(launches[0].kernel_name, "zero_dims");
        assert_eq!(launches[0].grid, (1, 1, 1));
        assert_eq!(launches[0].block, (1, 16, 1));
        assert!(!launches[0].dispatched);
        let error = launches[0].dispatch_error.as_deref().unwrap_or_default();
        assert!(error.contains("gpu_launch_invalid_dimensions"));
        assert!(error.contains("block[0] is zero"));
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
