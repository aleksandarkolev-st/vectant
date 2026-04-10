use crate::runtime::capability::{validate_hot_api, HotApiInfo};
use crate::runtime::plugin_contract::{
    self, HotApi, HotGetApiFn, RunnerApi, LOG_ERROR, LOG_INFO, LOG_WARN, MAX_STATE_ALIGNMENT,
    RUNNER_API_VERSION,
};
use crate::safety::enhanced_fingerprint::{self, extract_fingerprint_from_module, AbiFingerprint};
use libloading::{Library, Symbol};
use std::ffi::c_void;

// ============================================================
// NEW HOTAPI-BASED MODULE STATE (v2 ABI)
// ============================================================

/// State for a module loaded via the new HotApi ABI
pub struct HotModuleState {
    /// Pointer to the HotApi table
    pub api_ptr: *const HotApi,
    /// Cached copy of HotApi info
    pub api_info: HotApiInfo,
    /// Aligned state memory (owned by runner)
    pub state_memory: Vec<u8>,
    /// Pointer to aligned state within state_memory
    pub state_ptr: *mut c_void,
    /// Build ID for snapshot correlation
    pub build_id: u64,
    /// Whether state has been initialized
    pub initialized: bool,
    /// Enhanced ABI fingerprint for safe state reuse
    /// CRITICAL: Used for robust SameVersion check
    pub full_fingerprint: Option<AbiFingerprint>,
    /// Path to the loaded library (for fingerprint extraction)
    pub lib_path: Option<String>,
}

impl HotModuleState {
    /// Allocate state memory with proper alignment
    pub fn allocate_state(api: &HotApi) -> Result<(Vec<u8>, *mut c_void), String> {
        if api.state_size_bytes == 0 {
            return Ok((Vec::new(), std::ptr::null_mut()));
        }

        // Allocate extra space for alignment
        let extra = api.state_align_bytes;
        let total_size = api.state_size_bytes + extra;
        let mut memory = vec![0u8; total_size];

        // Find aligned address
        let base_addr = memory.as_mut_ptr() as usize;
        let aligned_addr = (base_addr + extra - 1) & !(api.state_align_bytes - 1);
        let state_ptr = aligned_addr as *mut c_void;

        Ok((memory, state_ptr))
    }
}

/// Result of the 3-mode hot reload algorithm
#[derive(Debug)]
pub enum HotReloadResult {
    /// Mode 1: Same version, state pointer reuse (fastest)
    SameVersion,
    /// Mode 2: Version changed, migration via serialized snapshot
    Migrated {
        preserved_fields: usize,
        new_fields: usize,
    },
    /// Mode 3: Cold reload, state reset
    ColdReload { reason: String },
    /// Error during reload
    Error(String),
}

/// Runner API implementation
pub static RUNNER_API: RunnerApi = RunnerApi {
    struct_size: std::mem::size_of::<RunnerApi>() as u32,
    api_version: RUNNER_API_VERSION,
    log: Some(runner_log),
    get_time_ns: Some(runner_get_time_ns),
    _reserved: [0; 8],
};

/// Log callback for modules
unsafe extern "C" fn runner_log(level: u32, msg: *const u8, len: usize) {
    if msg.is_null() || len == 0 {
        return;
    }
    let bytes = std::slice::from_raw_parts(msg, len);
    if let Ok(s) = std::str::from_utf8(bytes) {
        let prefix = match level {
            LOG_ERROR => "[Module:ERROR]",
            LOG_WARN => "[Module:WARN]",
            LOG_INFO => "[Module:INFO]",
            _ => "[Module]",
        };
        eprintln!("{} {}", prefix, s);
    }
}

/// Get monotonic time in nanoseconds
unsafe extern "C" fn runner_get_time_ns() -> u64 {
    use std::time::Instant;
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

/// Perform the 3-mode hot reload algorithm for new HotApi modules
///
/// Mode 1: Same ABI fingerprint (ROBUST CHECK) -> reuse state pointer
///         CRITICAL: Now uses full AbiFingerprint including compiler, target, layout hash
/// Mode 2: Different version -> save via MsgPack, migrate, restore
/// Mode 3: Cold reload -> init fresh state
pub fn hot_reload_v2(
    new_lib: &Library,
    new_lib_path: Option<&str>,
    old_hot_state: Option<&mut HotModuleState>,
    old_msgpack: Option<&[u8]>,
    old_json: Option<&str>,
) -> Result<(HotModuleState, HotReloadResult), String> {
    // 1. Validate new module's HotApi
    let validation = validate_hot_api(new_lib);
    if !validation.has_hot_api {
        return Err("Module does not export hot_get_api".to_string());
    }
    if !validation.errors.is_empty() {
        return Err(format!(
            "HotApi validation failed: {}",
            validation.errors.join(", ")
        ));
    }

    let api_info = validation.api.ok_or("HotApi info not available")?;

    // Get the HotApi pointer
    let hot_get_api: Symbol<HotGetApiFn> = unsafe {
        new_lib
            .get(b"hot_get_api")
            .map_err(|e| format!("Failed to get hot_get_api: {}", e))?
    };
    let api_ptr: *const HotApi = unsafe { hot_get_api() };
    if api_ptr.is_null() {
        return Err("hot_get_api() returned NULL".to_string());
    }
    let api = unsafe { &*api_ptr };

    // 2. Additional validation checks
    // Reject if struct_size < offset of last required field
    let min_struct_size = std::mem::offset_of!(HotApi, migrate)
        + std::mem::size_of::<Option<plugin_contract::MigrateFn>>();
    if (api.struct_size as usize) < min_struct_size {
        return Err(format!(
            "struct_size {} too small - required fields end at offset {}",
            api.struct_size, min_struct_size
        ));
    }

    // Enforce state_align_bytes is power of two and <= max
    if !api.state_align_bytes.is_power_of_two() {
        return Err(format!(
            "state_align_bytes {} is not a power of 2",
            api.state_align_bytes
        ));
    }
    if api.state_align_bytes > MAX_STATE_ALIGNMENT {
        return Err(format!(
            "state_align_bytes {} exceeds maximum {}",
            api.state_align_bytes, MAX_STATE_ALIGNMENT
        ));
    }

    // 3. Extract FULL ABI fingerprint for robust compatibility check
    let new_fingerprint = if let Some(path) = new_lib_path {
        match extract_fingerprint_from_module(
            std::path::Path::new(path),
            api.state_version,
            api.abi_fingerprint,
            api.state_size_bytes,
        ) {
            Ok(fp) => Some(fp),
            Err(e) => {
                eprintln!("[HMR] Warning: Could not extract full fingerprint: {}", e);
                None
            }
        }
    } else {
        None
    };

    // 4. Allocate state memory
    let (state_memory, state_ptr) = HotModuleState::allocate_state(api)?;

    // 5. Determine reload mode using STRICT fingerprint comparison
    // CRITICAL: NO MEMCPY WITHOUT LAYOUT HASH
    // If we don't have a layout hash, we CANNOT safely memcpy state between versions.
    // The only options are: serialized migration or cold reload.
    let (reload_result, needs_init) = if let Some(old) = old_hot_state {
        // First: Check if we can even consider memcpy (same version, same everything)
        let basic_match = old.api_info.state_version == api_info.state_version
            && old.api_info.abi_fingerprint == api_info.abi_fingerprint
            && old.api_info.state_size_bytes == api_info.state_size_bytes;

        // ENHANCED CHECK: Use full AbiFingerprint if available
        let can_memcpy = match (&old.full_fingerprint, &new_fingerprint) {
            (Some(old_fp), Some(new_fp)) => {
                // MUST have layout_hash to memcpy
                if old_fp.layout_hash.is_none() || new_fp.layout_hash.is_none() {
                    eprintln!("[HMR] Cannot memcpy: layout_hash missing");
                    eprintln!("[HMR]   Old layout_hash: {:?}", old_fp.layout_hash);
                    eprintln!("[HMR]   New layout_hash: {:?}", new_fp.layout_hash);
                    false
                } else {
                    // Robust check using full fingerprint
                    let result = old_fp.is_compatible_for_memcpy(new_fp);
                    if !result.is_compatible() {
                        if let enhanced_fingerprint::CompatibilityResult::Incompatible { reasons } =
                            &result
                        {
                            eprintln!("[HMR] Fingerprint mismatch - memcpy BLOCKED:");
                            for reason in reasons {
                                eprintln!("[HMR]   - {}", reason);
                            }
                        }
                    }
                    result.is_compatible()
                }
            }
            _ => {
                // NO FALLBACK TO BASIC CHECK
                // This is the critical change - without full fingerprints, NO memcpy.
                eprintln!("[HMR] BLOCKED: Cannot memcpy without full fingerprint");
                eprintln!(
                    "[HMR]   Old fingerprint present: {}",
                    old.full_fingerprint.is_some()
                );
                eprintln!(
                    "[HMR]   New fingerprint present: {}",
                    new_fingerprint.is_some()
                );
                eprintln!("[HMR]   Will use serialized migration or cold reload");
                false
            }
        };

        if can_memcpy && basic_match {
            // Mode 1: Same version hot swap - ONLY if fingerprints fully match
            // Copy old state to new location
            if !old.state_ptr.is_null() && !state_ptr.is_null() {
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        old.state_ptr as *const u8,
                        state_ptr as *mut u8,
                        api.state_size_bytes.min(old.api_info.state_size_bytes),
                    );
                }
            }
            (HotReloadResult::SameVersion, false)
        } else if api.migrate.is_some() && (old_msgpack.is_some() || old_json.is_some()) {
            // Mode 2: Migration via serialized snapshot
            // This is the SAFE path - uses structured data, not raw memory
            let migrate_fn = api.migrate.unwrap();

            let msgpack_ptr = old_msgpack.map(|b| b.as_ptr()).unwrap_or(std::ptr::null());
            let msgpack_len = old_msgpack.map(|b| b.len()).unwrap_or(0);
            let json_ptr = old_json.map(|s| s.as_ptr()).unwrap_or(std::ptr::null());
            let json_len = old_json.map(|s| s.len()).unwrap_or(0);

            let success = unsafe {
                migrate_fn(
                    old.state_ptr, // old_blob (opaque, for size reference only)
                    old.api_info.state_version,
                    state_ptr, // new_blob (write here)
                    api.state_version,
                    &RUNNER_API,
                    msgpack_ptr,
                    msgpack_len,
                    json_ptr,
                    json_len,
                )
            };

            if success {
                eprintln!("[HMR] Migration via serialization succeeded");
                (
                    HotReloadResult::Migrated {
                        preserved_fields: 0,
                        new_fields: 0,
                    },
                    false,
                )
            } else {
                // Migration failed, fall through to cold reload
                eprintln!("[HMR] Migration failed, falling back to cold reload");
                (
                    HotReloadResult::ColdReload {
                        reason: "Migration failed".to_string(),
                    },
                    true,
                )
            }
        } else {
            // Mode 3: Cold reload - SAFE fallback
            let reason = if !can_memcpy && basic_match {
                "Cannot verify memory layout compatibility (no layout_hash)"
            } else if api.migrate.is_none() {
                "No migrate function"
            } else {
                "No serialized state available"
            };
            eprintln!("[HMR] Cold reload required: {}", reason);
            (
                HotReloadResult::ColdReload {
                    reason: reason.to_string(),
                },
                true,
            )
        }
    } else {
        // First load - need init
        (
            HotReloadResult::ColdReload {
                reason: "First load".to_string(),
            },
            true,
        )
    };

    // 5. Initialize if needed
    let initialized = if needs_init {
        if let Some(init_fn) = api.init {
            unsafe { init_fn(state_ptr, &RUNNER_API) }
        } else {
            false
        }
    } else {
        true
    };

    if !initialized && needs_init {
        return Err("Module init() failed".to_string());
    }

    let hot_state = HotModuleState {
        api_ptr,
        api_info,
        state_memory,
        state_ptr,
        build_id: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        initialized: true,
        // Store the full fingerprint for future comparisons
        full_fingerprint: new_fingerprint,
        lib_path: new_lib_path.map(|s| s.to_string()),
    };

    Ok((hot_state, reload_result))
}

/// Save state using size-then-write pattern (no module allocation)
pub fn save_state_msgpack_v2(hot_state: &HotModuleState) -> Option<Vec<u8>> {
    let api = unsafe { &*hot_state.api_ptr };

    let size_fn = api.save_state_msgpack_size?;
    let write_fn = api.save_state_msgpack_write?;

    // Get size
    let size = unsafe {
        size_fn(
            hot_state.state_ptr,
            hot_state.api_info.state_version,
            &RUNNER_API,
        )
    };

    if size == 0 {
        return None;
    }

    // Allocate and write
    let mut buffer = vec![0u8; size];
    let mut written: usize = 0;

    let success = unsafe {
        write_fn(
            hot_state.state_ptr,
            hot_state.api_info.state_version,
            &RUNNER_API,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut written,
        )
    };

    if success && written <= buffer.len() {
        buffer.truncate(written);
        Some(buffer)
    } else {
        None
    }
}

// Validation helper: check state header magic and size
pub unsafe fn validate_state_magic(state: *mut c_void, expected_magic: u32) -> bool {
    if state.is_null() {
        return false;
    }
    let magic = *(state as *const u32);
    magic == expected_magic
}

// Extract ABI version from state header (third u32 field)
pub unsafe fn get_module_abi_version(state: *mut c_void) -> u32 {
    if state.is_null() {
        return 0;
    }
    *((state as *const u32).add(2))
}
