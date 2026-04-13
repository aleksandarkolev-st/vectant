// Plugin contract defines the ABI - symbols are used via dlsym at runtime
// The dead_code warning is a false positive since these are FFI constants

use core::ffi::c_void;
use std::ffi::{c_char, c_double, c_uint};

// ============================================================
// SYNTHI PLUGIN ABI v2.1 - SINGLE-EXPORT ABI
// ============================================================
// This module defines the frozen ABI contract between the runner
// and dynamically loaded hot modules.
//
// KEY CHANGES IN v2.1:
// - Single export: hot_get_api() returns pointer to static HotApi table
// - All structs are #[repr(C)] for stable ABI
// - No SDL types - events are runner-defined POD
// - Migration uses serialized snapshots (MsgPack), not old struct pointers
// - Size-then-write pattern for allocation-free serialization
// - Added semantic_hash for reload safety (v2.1)
// - Added can_reuse_state hook (v2.1)
// - Explicit quiescence callbacks (v2.1)
//
// See PLUGIN_ABI.md for the full specification.
//
// ============================================================
// ABI OWNERSHIP AND ALLOCATION RULES
// ============================================================
//
// MEMORY OWNERSHIP RULES:
//
// 1. STATE MEMORY
//    - Runner allocates state memory (state_size_bytes, aligned to state_align_bytes)
//    - Runner owns state memory lifetime
//    - Module MUST NOT free state memory
//    - Module MUST NOT reallocate state memory
//    - On shutdown: runner calls shutdown(), then frees state
//
// 2. SNAPSHOT DATA (save_state_msgpack_write)
//    - Runner allocates output buffer
//    - Runner provides buffer capacity via out_cap
//    - Module writes directly to provided buffer (zero-copy)
//    - Module sets *out_written to actual bytes written
//    - Runner owns buffer - module MUST NOT free it
//
// 3. ERROR STRINGS
//    - Module allocates error strings via static buffers or module-owned heap
//    - Error strings are valid until next module call
//    - Runner MUST NOT free error strings
//    - Runner should copy if needed beyond next call
//
// 4. RUNNER API POINTERS
//    - RunnerApi pointer is valid for module lifetime
//    - Module MUST NOT free RunnerApi
//    - Module MUST NOT cache RunnerApi beyond shutdown
//
// ALIGNMENT RULES:
//    - state_align_bytes MUST be power of 2
//    - state_align_bytes MUST be <= MAX_STATE_ALIGNMENT (128)
//    - state_size_bytes MUST be multiple of state_align_bytes
//    - Runner guarantees state pointer meets alignment
//
// ERROR REPORTING:
//    - Functions return bool: true = success, false = error
//    - Error details via hot_get_last_error() (if provided)
//    - Or via error_message field in HotApi (v2.1+)
//
// VERSIONING RULES:
//    - struct_size field enables forward compatibility
//    - New fields MUST be added at end of struct
//    - Removed fields MUST be replaced with reserved padding
//    - api_version bump required for:
//      * Adding new required callbacks
//      * Changing existing callback signatures
//      * Changing struct layout
//    - state_version bump required for:
//      * Adding/removing state fields
//      * Changing state field types
//      * Changing state field semantics
//    - semantic_hash change required for:
//      * Changing field invariants (even if layout matches)
//      * Changing pointer ownership semantics
//      * Changing array size semantics
//
// ============================================================

/// Runner API version - bump when adding new runner services
pub const RUNNER_API_VERSION: u32 = 1;

/// Module API version - bump when HotApi structure changes
pub const HOT_API_VERSION: u32 = 2;

/// Minimum supported API version for backward compatibility
pub const HOT_API_MIN_VERSION: u32 = 2;

/// Legacy ABI version constants (for backward compat detection)
pub const SYNTHI_CORE_ABI_VERSION: u32 = 1;
pub const SYNTHI_GUI_ABI_VERSION: u32 = 1;
pub const SYNTHI_MIN_SUPPORTED_ABI: u32 = 1;

/// Host KV API version
pub const SYNTHI_HOST_KV_VERSION: u32 = 1;

/// Magic numbers for struct validation
pub const CORE_STATE_MAGIC: u32 = 0xDEADBEEF;
pub const GUI_STATE_MAGIC: u32 = 0x60108EEF; // "GUI BEEF"
pub const HOT_API_MAGIC: u64 = 0x484F5441_50495632; // "HOTAPIV2"

/// Maximum sane alignment (reject if state_align_bytes > this)
pub const MAX_STATE_ALIGNMENT: usize = 128;

/// Opaque state pointers
pub type StatePtr = *mut c_void;
pub type RendererPtr = *mut c_void;
pub type CoreApiPtr = *mut c_void;
pub type SdlEventPtr = *mut c_void;
pub type HostContextPtr = *const c_void;

// ============================================================
// RUNNER API - Services provided by the host to the module
// ============================================================

/// Log levels for runner logging service
pub const LOG_TRACE: u32 = 0;
pub const LOG_DEBUG: u32 = 1;
pub const LOG_INFO: u32 = 2;
pub const LOG_WARN: u32 = 3;
pub const LOG_ERROR: u32 = 4;

/// Runner-provided services available to modules
/// All services are allocation-free
#[repr(C)]
pub struct RunnerApi {
    /// Size of this struct (for versioning)
    pub struct_size: u32,
    /// Runner API version
    pub api_version: u32,
    /// Log a message (level, msg bytes, length)
    pub log: Option<unsafe extern "C" fn(level: u32, msg: *const u8, len: usize)>,
    /// Get monotonic time in nanoseconds
    pub get_time_ns: Option<unsafe extern "C" fn() -> u64>,
    /// Reserved for future use
    pub _reserved: [usize; 8],
}

impl RunnerApi {
    pub const fn new() -> Self {
        Self {
            struct_size: core::mem::size_of::<RunnerApi>() as u32,
            api_version: RUNNER_API_VERSION,
            log: None,
            get_time_ns: None,
            _reserved: [0; 8],
        }
    }
}

// ============================================================
// EVENT - Runner-defined POD for input events
// ============================================================

/// Event kinds (runner defines the semantics)
pub const EVENT_NONE: u32 = 0;
pub const EVENT_KEY_DOWN: u32 = 1;
pub const EVENT_KEY_UP: u32 = 2;
pub const EVENT_MOUSE_MOVE: u32 = 3;
pub const EVENT_MOUSE_DOWN: u32 = 4;
pub const EVENT_MOUSE_UP: u32 = 5;
pub const EVENT_QUIT: u32 = 6;
pub const EVENT_RESIZE: u32 = 7;
pub const EVENT_CUSTOM: u32 = 1000;

/// POD event structure - no SDL types
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Event {
    /// Event type (EVENT_* constants)
    pub kind: u32,
    /// First parameter (key code, mouse button, etc.)
    pub a: u32,
    /// Second parameter (x coordinate, modifier flags, etc.)
    pub b: u32,
    /// Third parameter (y coordinate, etc.)
    pub c: u32,
    /// Optional payload pointer (must be valid for event lifetime)
    pub payload_ptr: *const c_void,
    /// Payload length in bytes
    pub payload_len: usize,
}

impl Default for Event {
    fn default() -> Self {
        Self {
            kind: EVENT_NONE,
            a: 0,
            b: 0,
            c: 0,
            payload_ptr: core::ptr::null(),
            payload_len: 0,
        }
    }
}

// ============================================================
// FUNCTION POINTER TYPES FOR HotApi
// ============================================================

/// Initialize state. Called once when module is first loaded.
/// state: pointer to allocated state memory (state_size_bytes, aligned to state_align_bytes)
/// host: runner services
/// Returns true on success
pub type InitFn = unsafe extern "C" fn(state: *mut c_void, host: *const RunnerApi) -> bool;

/// Shutdown/cleanup state. Called before module unload.
pub type ShutdownFn = unsafe extern "C" fn(state: *mut c_void, host: *const RunnerApi);

/// Per-frame tick/update
pub type TickFn = unsafe extern "C" fn(state: *mut c_void, host: *const RunnerApi, dt: f32);

/// Render frame
pub type RenderFn = unsafe extern "C" fn(state: *mut c_void, host: *const RunnerApi);

/// Handle input event
pub type EventFn =
    unsafe extern "C" fn(state: *mut c_void, e: *const Event, host: *const RunnerApi);

/// Get serialized state size (for size-then-write pattern)
/// state: current state
/// state_version: module's state_version
/// host: runner services
/// Returns: number of bytes needed to serialize state
pub type SaveSizeFn =
    unsafe extern "C" fn(state: *const c_void, state_version: u32, host: *const RunnerApi) -> usize;

/// Write state as MsgPack to provided buffer (size-then-write pattern)
/// state: current state
/// state_version: module's state_version  
/// host: runner services
/// out: output buffer (caller allocated, at least save_state_msgpack_size bytes)
/// out_cap: capacity of output buffer
/// out_written: receives actual bytes written
/// Returns: true on success
pub type SaveWriteMsgpackFn = unsafe extern "C" fn(
    state: *const c_void,
    state_version: u32,
    host: *const RunnerApi,
    out: *mut u8,
    out_cap: usize,
    out_written: *mut usize,
) -> bool;

/// Write state as JSON to provided buffer (debug/fallback)
pub type SaveWriteJsonFn = unsafe extern "C" fn(
    state: *const c_void,
    state_version: u32,
    host: *const RunnerApi,
    out: *mut u8,
    out_cap: usize,
    out_written: *mut usize,
) -> bool;

/// Migrate state from old version to new version
///
/// CRITICAL: old_blob is OPAQUE - do NOT cast to old struct type!
/// Use old_msgpack or old_json as the canonical source for migration.
///
/// old_blob: pointer to old state memory (opaque, for size reference only)
/// old_ver: version of old state
/// new_blob: pointer to new state memory (write migrated state here)
/// new_ver: version of new state (this module's state_version)
/// host: runner services
/// old_msgpack: serialized old state in MsgPack format (preferred)
/// old_msgpack_len: length of MsgPack data
/// old_json: serialized old state in JSON format (fallback)
/// old_json_len: length of JSON data
/// Returns: true if migration succeeded
pub type MigrateFn = unsafe extern "C" fn(
    old_blob: *const c_void,
    old_ver: u32,
    new_blob: *mut c_void,
    new_ver: u32,
    host: *const RunnerApi,
    old_msgpack: *const u8,
    old_msgpack_len: usize,
    old_json: *const u8,
    old_json_len: usize,
) -> bool;

// ============================================================
// v2.1 NEW FUNCTION TYPES
// ============================================================

/// Check if state can be reused between old and new module versions.
/// This is SEPARATE from layout compatibility - even if layout matches,
/// semantic changes may require migration.
///
/// old_fingerprint: ABI fingerprint of old module
/// new_fingerprint: ABI fingerprint of new module (this module)
/// old_semantic_hash: semantic hash of old module state
/// Returns: true if state can be reused directly (memcpy-safe AND semantically compatible)
pub type CanReuseStateFn = unsafe extern "C" fn(
    old_fingerprint: u64,
    new_fingerprint: u64,
    old_semantic_hash: u64,
) -> bool;

/// Get the semantic hash for this module's state.
/// Semantic hash should change when:
/// - Field invariants change (even if layout matches)
/// - Pointer ownership semantics change
/// - Array size semantics change
/// - Any behavioral change that affects state interpretation
///
/// Returns: 64-bit semantic hash
pub type GetSemanticHashFn = unsafe extern "C" fn() -> u64;

/// Get the state type identifier string.
/// This should be a stable, unique identifier for the state type.
/// Format: "module::TypeName" (e.g., "synthi::core::CoreState")
///
/// Returns: pointer to null-terminated UTF-8 string (static lifetime)
pub type GetStateTypeIdFn = unsafe extern "C" fn() -> *const c_char;

/// Get precomputed layout hash.
/// This should be computed at build time from actual struct layout.
///
/// Returns: 64-bit layout hash
pub type GetLayoutHashFn = unsafe extern "C" fn() -> u64;

/// Enter quiescence mode. Called before hot reload.
/// Module must:
/// - Stop all callbacks and timers
/// - Join or cancel owned threads
/// - Drain message queues
/// - Flush pending I/O
///
/// state: current state
/// host: runner services
/// timeout_ms: hard timeout - MUST complete before this
/// Returns: true if quiescence achieved, false if failed
pub type EnterQuiescenceFn =
    unsafe extern "C" fn(state: *mut c_void, host: *const RunnerApi, timeout_ms: u32) -> bool;

/// Exit quiescence mode. Called after hot reload if reload was cancelled.
///
/// state: current state
/// host: runner services
pub type ExitQuiescenceFn = unsafe extern "C" fn(state: *mut c_void, host: *const RunnerApi);

/// Quiescence report structure
#[repr(C)]
pub struct QuiescenceReport {
    /// Number of timers stopped
    pub timers_stopped: u32,
    /// Number of callbacks unregistered
    pub callbacks_unregistered: u32,
    /// Number of threads joined
    pub threads_joined: u32,
    /// Number of queue items drained
    pub queue_items_drained: u32,
    /// Time taken to quiesce (microseconds)
    pub quiesce_time_us: u64,
    /// Error message if failed (null-terminated, or null if success)
    pub error_message: *const c_char,
}

/// Get detailed quiescence report.
///
/// state: current state
/// host: runner services
/// out_report: receives quiescence report
/// Returns: true if quiescent, false if not
pub type GetQuiescenceReportFn = unsafe extern "C" fn(
    state: *const c_void,
    host: *const RunnerApi,
    out_report: *mut QuiescenceReport,
) -> bool;

// ============================================================
// HotApi - THE SINGLE EXPORT TABLE (v2.1)
// ============================================================

/// The main API table exported by hot modules.
/// Single export: hot_get_api() returns pointer to this static table.
///
/// VERSIONING:
/// - struct_size allows forward compatibility
/// - New fields added at end for backward compatibility
/// - api_version bumped for breaking changes
#[repr(C)]
pub struct HotApi {
    /// Size of this struct in bytes (for version detection)
    /// CRITICAL: Check this before accessing fields added in later versions
    pub struct_size: u32,

    /// API version (must be >= HOT_API_MIN_VERSION)
    pub api_version: u32,

    /// State version (module-defined, for migration)
    pub state_version: u32,

    /// ABI fingerprint for fast compatibility check
    /// Should be stable hash of state layout + function signatures
    pub abi_fingerprint: u64,

    /// Size of state struct in bytes
    pub state_size_bytes: usize,

    /// Required alignment of state struct (must be power of 2, <= MAX_STATE_ALIGNMENT)
    pub state_align_bytes: usize,

    /// Minimum size for partial compatibility (0 if unused)
    pub state_min_size_bytes: usize,

    // === Lifecycle functions ===
    /// Initialize state (required)
    pub init: Option<InitFn>,

    /// Shutdown/cleanup (optional)
    pub shutdown: Option<ShutdownFn>,

    /// Per-frame tick (optional, but usually needed)
    pub tick: Option<TickFn>,

    /// Render frame (optional)
    pub render: Option<RenderFn>,

    /// Handle event (optional)
    pub event: Option<EventFn>,

    /// Migrate from old state version (optional but recommended)
    pub migrate: Option<MigrateFn>,

    // === State serialization (size-then-write pattern) ===
    /// Get MsgPack serialization size
    pub save_state_msgpack_size: Option<SaveSizeFn>,

    /// Write state as MsgPack
    pub save_state_msgpack_write: Option<SaveWriteMsgpackFn>,

    /// Get JSON serialization size (debug/fallback)
    pub save_state_json_size: Option<SaveSizeFn>,

    /// Write state as JSON (debug/fallback)
    pub save_state_json_write: Option<SaveWriteJsonFn>,

    // ============================================================
    // v2.1 ADDITIONS - Check struct_size before accessing
    // ============================================================
    /// Semantic hash for reload safety (v2.1+)
    /// Changes when state semantics change, even if layout matches.
    /// 0 = not provided (forces migration on any change)
    pub semantic_hash: u64,

    /// Check if state can be reused (v2.1+, optional)
    /// Called to verify both layout AND semantic compatibility.
    pub can_reuse_state: Option<CanReuseStateFn>,

    /// Get semantic hash (v2.1+, optional)
    /// Alternative to static semantic_hash field - can compute at runtime.
    pub get_semantic_hash: Option<GetSemanticHashFn>,

    /// Get state type identifier (v2.1+, optional but recommended)
    /// Returns stable type name for DWARF lookup.
    pub get_state_type_id: Option<GetStateTypeIdFn>,

    /// Get precomputed layout hash (v2.1+, optional)
    /// Should be computed at build time from actual struct layout.
    pub get_layout_hash: Option<GetLayoutHashFn>,

    /// Enter quiescence mode (v2.1+, optional but recommended)
    /// Called before hot reload to stop all activity.
    pub enter_quiescence: Option<EnterQuiescenceFn>,

    /// Exit quiescence mode (v2.1+, optional)
    /// Called if reload is cancelled.
    pub exit_quiescence: Option<ExitQuiescenceFn>,

    /// Get quiescence report (v2.1+, optional)
    /// Returns details about quiescence state.
    pub get_quiescence_report: Option<GetQuiescenceReportFn>,

    /// Error message from last failed operation (v2.1+)
    /// Pointer to static or thread-local null-terminated string.
    /// NULL if no error or not supported.
    pub error_message: *const c_char,

    /// Reserved for future expansion
    pub _reserved: [usize; 4],
}

/// Size of HotApi v2.0 (without v2.1 fields)
pub const HOT_API_V20_SIZE: usize = 136; // Approximate, adjust based on actual

impl HotApi {
    /// Create a new HotApi with default values
    pub const fn new() -> Self {
        Self {
            struct_size: core::mem::size_of::<HotApi>() as u32,
            api_version: HOT_API_VERSION,
            state_version: 1,
            abi_fingerprint: 0,
            state_size_bytes: 0,
            state_align_bytes: 8,
            state_min_size_bytes: 0,
            init: None,
            shutdown: None,
            tick: None,
            render: None,
            event: None,
            migrate: None,
            save_state_msgpack_size: None,
            save_state_msgpack_write: None,
            save_state_json_size: None,
            save_state_json_write: None,
            // v2.1 fields
            semantic_hash: 0,
            can_reuse_state: None,
            get_semantic_hash: None,
            get_state_type_id: None,
            get_layout_hash: None,
            enter_quiescence: None,
            exit_quiescence: None,
            get_quiescence_report: None,
            error_message: core::ptr::null(),
            _reserved: [0; 4],
        }
    }

    /// Check if this HotApi has v2.1 fields
    pub fn has_v21_fields(&self) -> bool {
        (self.struct_size as usize) >= core::mem::size_of::<HotApi>()
    }

    /// Get semantic hash (from field or function)
    pub unsafe fn get_semantic_hash_value(&self) -> u64 {
        if !self.has_v21_fields() {
            return 0;
        }
        if let Some(func) = self.get_semantic_hash {
            func()
        } else {
            self.semantic_hash
        }
    }

    /// Check if state can be reused
    pub unsafe fn check_can_reuse_state(
        &self,
        old_fingerprint: u64,
        new_fingerprint: u64,
        old_semantic_hash: u64,
    ) -> bool {
        if !self.has_v21_fields() {
            // v2.0 modules: only allow reuse if fingerprints match exactly
            return old_fingerprint == new_fingerprint;
        }

        if let Some(func) = self.can_reuse_state {
            func(old_fingerprint, new_fingerprint, old_semantic_hash)
        } else {
            // Default: require both fingerprint and semantic hash to match
            old_fingerprint == new_fingerprint
                && old_semantic_hash == self.get_semantic_hash_value()
        }
    }

    /// Validate that this HotApi meets minimum requirements
    pub fn validate(&self) -> Result<(), &'static str> {
        // Check struct_size is reasonable
        if (self.struct_size as usize) < core::mem::offset_of!(HotApi, migrate) {
            return Err("struct_size too small - missing required fields");
        }

        // Check API version
        if self.api_version < HOT_API_MIN_VERSION {
            return Err("api_version too old");
        }

        // Check alignment is power of 2
        if self.state_align_bytes == 0 || !self.state_align_bytes.is_power_of_two() {
            return Err("state_align_bytes must be a power of 2");
        }

        // Check alignment is sane
        if self.state_align_bytes > MAX_STATE_ALIGNMENT {
            return Err("state_align_bytes exceeds maximum");
        }

        // Check state size is aligned
        if self.state_size_bytes % self.state_align_bytes != 0 {
            return Err("state_size_bytes must be multiple of state_align_bytes");
        }

        // Must have init function
        if self.init.is_none() {
            return Err("init function is required");
        }

        Ok(())
    }

    /// Check if this module supports state serialization
    pub fn has_serialization(&self) -> bool {
        self.save_state_msgpack_size.is_some() && self.save_state_msgpack_write.is_some()
    }

    /// Check if this module supports migration
    pub fn has_migration(&self) -> bool {
        self.migrate.is_some()
    }
}

// ============================================================
// SINGLE EXPORT FUNCTION TYPE
// ============================================================

/// The single export that hot modules must provide
pub type HotGetApiFn = unsafe extern "C" fn() -> *const HotApi;

/// Symbol name for the single export
pub const HOT_GET_API_SYMBOL: &[u8] = b"hot_get_api\0";

// ============================================================
// PLACEHOLDER EXPORT (modules override this)
// ============================================================

/*
/// Default implementation - modules should replace this with their static table
#[no_mangle]
pub extern "C" fn hot_get_api() -> *const HotApi {
    // Return null to indicate no implementation
    // Real modules return &THEIR_HOT_API
    core::ptr::null()
}
*/

/// Module slot identifiers
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ModuleSlot {
    Core,
    Gui,
    Main, // Legacy single-module mode
}

impl ModuleSlot {
    pub fn as_str(&self) -> &'static str {
        match self {
            ModuleSlot::Core => "core",
            ModuleSlot::Gui => "gui",
            ModuleSlot::Main => "main",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "core" => Some(ModuleSlot::Core),
            "gui" => Some(ModuleSlot::Gui),
            "main" => Some(ModuleSlot::Main),
            _ => None,
        }
    }
}

/// Load result for module loading operations
#[derive(Debug, Clone)]
pub enum LoadResult {
    Success,
    Rejected { reason: String },
    AbiMismatch { expected: u32, got: u32 },
    MissingSymbol { symbol: String },
    InitFailed { reason: String },
}

// ============================================================
// CORE MODULE SYMBOLS
// ============================================================

pub mod core_symbols {
    use super::*;

    /// Symbol names for core module
    pub const ON_LOAD: &[u8] = b"core_on_load\0";
    pub const ON_UPDATE: &[u8] = b"core_on_update\0";
    pub const ON_EVENT: &[u8] = b"core_on_event\0";
    pub const ON_UNLOAD: &[u8] = b"core_on_unload\0";
    pub const GET_API: &[u8] = b"core_get_api\0";
    pub const GET_ABI_VERSION: &[u8] = b"core_get_abi_version\0";
    pub const ON_SAVE_STATE: &[u8] = b"core_on_save_state\0";
    pub const ON_LOAD_FROM_JSON: &[u8] = b"core_on_load_from_json\0";

    /// Returns a hash/checksum of the state struct layout.
    /// Used to verify binary compatibility before raw pointer reuse.
    pub const GET_STATE_SCHEMA_HASH: &[u8] = b"core_get_state_schema_hash\0";

    // ============================================================
    // BINARY SERIALIZATION SYMBOLS (fast MessagePack-based HMR)
    // ============================================================
    /// unsigned char* core_on_save_state_binary(CoreState* state, size_t* out_size)
    /// Returns heap-allocated buffer, caller must free. out_size receives byte count.
    pub const ON_SAVE_STATE_BINARY: &[u8] = b"core_on_save_state_binary\0";

    /// CoreState* core_on_load_from_binary(const unsigned char* data, size_t size)
    /// Returns heap-allocated state struct from binary data.
    pub const ON_LOAD_FROM_BINARY: &[u8] = b"core_on_load_from_binary\0";

    /// size_t core_get_state_binary_size()
    /// Returns expected binary state size (header + fields)
    pub const GET_STATE_BINARY_SIZE: &[u8] = b"core_get_state_binary_size\0";

    // ============================================================
    // HOST KV SYMBOLS (optional, for host-context-aware loading)
    // ============================================================
    /// CoreState* core_on_load_host(CoreState* prev, const SynthiHostContextV1* host_ctx)
    pub const ON_LOAD_HOST: &[u8] = b"core_on_load_host\0";
    /// uint32_t core_host_kv_schemas_len(void)
    pub const HOST_KV_SCHEMAS_LEN: &[u8] = b"core_host_kv_schemas_len\0";
    /// const SynthiNamespaceSchemaV1* core_host_kv_schemas(void)
    pub const HOST_KV_SCHEMAS: &[u8] = b"core_host_kv_schemas\0";

    /// Required symbols that MUST be present
    pub const REQUIRED: &[&[u8]] = &[ON_LOAD, ON_UPDATE, GET_API];

    /// Optional symbols
    pub const OPTIONAL: &[&[u8]] = &[
        ON_EVENT,
        ON_UNLOAD,
        GET_ABI_VERSION,
        ON_SAVE_STATE,
        ON_LOAD_FROM_JSON,
        GET_STATE_SCHEMA_HASH,
        ON_SAVE_STATE_BINARY,
        ON_LOAD_FROM_BINARY,
        GET_STATE_BINARY_SIZE, // Binary serialization
        ON_LOAD_HOST,
        HOST_KV_SCHEMAS_LEN,
        HOST_KV_SCHEMAS,
    ];

    // Function signatures
    /// CoreState* core_on_load(CoreState* prev, void* renderer)
    pub type OnLoadFn = unsafe extern "C" fn(StatePtr, RendererPtr) -> StatePtr;

    /// CoreState* core_on_load_host(CoreState* prev, const SynthiHostContextV1* host_ctx)
    pub type OnLoadHostFn = unsafe extern "C" fn(StatePtr, HostContextPtr) -> StatePtr;

    /// void core_on_update(CoreState* state, double dt)
    pub type OnUpdateFn = unsafe extern "C" fn(StatePtr, c_double);

    /// void core_on_event(CoreState* state, SDL_Event* event)
    pub type OnEventFn = unsafe extern "C" fn(StatePtr, SdlEventPtr);

    /// void core_on_unload(CoreState* state)
    pub type OnUnloadFn = unsafe extern "C" fn(StatePtr);

    /// CoreAPI* core_get_api(void)
    pub type GetApiFn = unsafe extern "C" fn() -> CoreApiPtr;

    /// uint32_t core_get_abi_version(void)
    pub type GetAbiVersionFn = unsafe extern "C" fn() -> c_uint;

    /// char* core_on_save_state(CoreState* state)
    pub type OnSaveStateFn = unsafe extern "C" fn(StatePtr) -> *mut c_char;

    /// CoreState* core_on_load_from_json(const char* json)
    pub type OnLoadFromJsonFn = unsafe extern "C" fn(*const c_char) -> StatePtr;

    /// uint64_t core_get_state_schema_hash(void)
    pub type GetStateSchemaHashFn = unsafe extern "C" fn() -> u64;

    // ============================================================
    // BINARY SERIALIZATION TYPE SIGNATURES (10-50x faster than JSON)
    // ============================================================

    /// unsigned char* core_on_save_state_binary(CoreState* state, size_t* out_size)
    /// Returns heap-allocated buffer, caller must free. out_size receives byte count.
    pub type OnSaveStateBinaryFn = unsafe extern "C" fn(StatePtr, *mut usize) -> *mut u8;

    /// CoreState* core_on_load_from_binary(const unsigned char* data, size_t size)
    /// Returns heap-allocated state struct from binary data.
    pub type OnLoadFromBinaryFn = unsafe extern "C" fn(*const u8, usize) -> StatePtr;

    /// size_t core_get_state_binary_size()
    /// Returns expected binary state size (header + fields)
    pub type GetStateBinarySizeFn = unsafe extern "C" fn() -> usize;

    /// uint32_t core_host_kv_schemas_len(void)
    pub type HostKvSchemasLenFn = unsafe extern "C" fn() -> c_uint;

    /// const SynthiNamespaceSchemaV1* core_host_kv_schemas(void)
    pub type HostKvSchemasFn = unsafe extern "C" fn() -> *const c_void;
}

// ============================================================
// GUI MODULE SYMBOLS
// ============================================================

pub mod gui_symbols {
    use super::*;

    /// Symbol names for gui module
    pub const ON_LOAD: &[u8] = b"gui_on_load\0";
    pub const ON_RENDER: &[u8] = b"gui_on_render\0";
    pub const ON_EVENT: &[u8] = b"gui_on_event\0";
    pub const ON_UNLOAD: &[u8] = b"gui_on_unload\0";
    pub const GET_ABI_VERSION: &[u8] = b"gui_get_abi_version\0";
    pub const ON_SAVE_STATE: &[u8] = b"gui_on_save_state\0";
    pub const ON_LOAD_FROM_JSON: &[u8] = b"gui_on_load_from_json\0";

    /// Returns a hash/checksum of the state struct layout.
    pub const GET_STATE_SCHEMA_HASH: &[u8] = b"gui_get_state_schema_hash\0";

    // ============================================================
    // BINARY SERIALIZATION SYMBOLS (fast MessagePack-based HMR)
    // ============================================================
    /// unsigned char* gui_on_save_state_binary(GuiState* state, size_t* out_size)
    pub const ON_SAVE_STATE_BINARY: &[u8] = b"gui_on_save_state_binary\0";

    /// GuiState* gui_on_load_from_binary(const unsigned char* data, size_t size)
    pub const ON_LOAD_FROM_BINARY: &[u8] = b"gui_on_load_from_binary\0";

    /// size_t gui_get_state_binary_size()
    pub const GET_STATE_BINARY_SIZE: &[u8] = b"gui_get_state_binary_size\0";

    // ============================================================
    // HOST KV SYMBOLS (optional, for host-context-aware loading)
    // ============================================================
    /// GuiState* gui_on_load_host(GuiState* prev, const SynthiHostContextV1* host_ctx)
    pub const ON_LOAD_HOST: &[u8] = b"gui_on_load_host\0";
    /// uint32_t gui_host_kv_schemas_len(void)
    pub const HOST_KV_SCHEMAS_LEN: &[u8] = b"gui_host_kv_schemas_len\0";
    /// const SynthiNamespaceSchemaV1* gui_host_kv_schemas(void)
    pub const HOST_KV_SCHEMAS: &[u8] = b"gui_host_kv_schemas\0";

    /// Required symbols that MUST be present
    pub const REQUIRED: &[&[u8]] = &[ON_LOAD, ON_RENDER];

    /// Optional symbols
    pub const OPTIONAL: &[&[u8]] = &[
        ON_EVENT,
        ON_UNLOAD,
        GET_ABI_VERSION,
        ON_SAVE_STATE,
        ON_LOAD_FROM_JSON,
        GET_STATE_SCHEMA_HASH,
        ON_SAVE_STATE_BINARY,
        ON_LOAD_FROM_BINARY,
        GET_STATE_BINARY_SIZE, // Binary serialization
        ON_LOAD_HOST,
        HOST_KV_SCHEMAS_LEN,
        HOST_KV_SCHEMAS,
    ];

    // Function signatures
    /// GuiState* gui_on_load(GuiState* prev, void* renderer, CoreAPI* api)
    pub type OnLoadFn = unsafe extern "C" fn(StatePtr, RendererPtr, CoreApiPtr) -> StatePtr;

    /// GuiState* gui_on_load_host(GuiState* prev, const SynthiHostContextV1* host_ctx)
    pub type OnLoadHostFn = unsafe extern "C" fn(StatePtr, HostContextPtr) -> StatePtr;

    /// void gui_on_render(GuiState* state)
    pub type OnRenderFn = unsafe extern "C" fn(StatePtr);

    /// void gui_on_event(GuiState* state, SDL_Event* event)
    pub type OnEventFn = unsafe extern "C" fn(StatePtr, SdlEventPtr);

    /// void gui_on_unload(GuiState* state)
    pub type OnUnloadFn = unsafe extern "C" fn(StatePtr);

    /// uint32_t gui_get_abi_version(void)
    pub type GetAbiVersionFn = unsafe extern "C" fn() -> c_uint;

    /// char* gui_on_save_state(GuiState* state)
    pub type OnSaveStateFn = unsafe extern "C" fn(StatePtr) -> *mut c_char;

    /// GuiState* gui_on_load_from_json(const char* json)
    pub type OnLoadFromJsonFn = unsafe extern "C" fn(*const c_char) -> StatePtr;

    /// uint64_t gui_get_state_schema_hash(void)
    pub type GetStateSchemaHashFn = unsafe extern "C" fn() -> u64;

    // ============================================================
    // BINARY SERIALIZATION TYPE SIGNATURES (10-50x faster than JSON)
    // ============================================================

    /// unsigned char* gui_on_save_state_binary(GuiState* state, size_t* out_size)
    pub type OnSaveStateBinaryFn = unsafe extern "C" fn(StatePtr, *mut usize) -> *mut u8;

    /// GuiState* gui_on_load_from_binary(const unsigned char* data, size_t size)
    pub type OnLoadFromBinaryFn = unsafe extern "C" fn(*const u8, usize) -> StatePtr;

    /// size_t gui_get_state_binary_size()
    pub type GetStateBinarySizeFn = unsafe extern "C" fn() -> usize;

    /// uint32_t gui_host_kv_schemas_len(void)
    pub type HostKvSchemasLenFn = unsafe extern "C" fn() -> c_uint;

    /// const SynthiNamespaceSchemaV1* gui_host_kv_schemas(void)
    pub type HostKvSchemasFn = unsafe extern "C" fn() -> *const c_void;
}

// ============================================================
// LEGACY MAIN MODULE SYMBOLS (backward compatibility)
// ============================================================

pub mod legacy_symbols {
    use super::*;

    /// Symbol names for legacy main module
    pub const ON_LOAD: &[u8] = b"on_load\0";
    pub const ENTRYPOINT: &[u8] = b"entrypoint\0";
    pub const ON_UPDATE: &[u8] = b"on_update\0";
    pub const ON_EVENT: &[u8] = b"on_event\0";
    pub const ON_UNLOAD: &[u8] = b"on_unload\0";
    pub const ON_SAVE_STATE: &[u8] = b"on_save_state\0";
    pub const ON_LOAD_FROM_JSON: &[u8] = b"on_load_from_json\0";
    pub const GUI_RENDER: &[u8] = b"gui_render\0";
    pub const ON_RENDER: &[u8] = b"on_render\0";

    // ============================================================
    // BINARY SERIALIZATION SYMBOLS (fast MessagePack-based HMR)
    // ============================================================
    /// unsigned char* on_save_state_binary(void* state, size_t* out_size)
    pub const ON_SAVE_STATE_BINARY: &[u8] = b"on_save_state_binary\0";

    /// void* on_load_from_binary(const unsigned char* data, size_t size)
    pub const ON_LOAD_FROM_BINARY: &[u8] = b"on_load_from_binary\0";

    /// size_t get_state_binary_size()
    pub const GET_STATE_BINARY_SIZE: &[u8] = b"get_state_binary_size\0";

    // ============================================================
    // HOST KV SYMBOLS (optional, for host-context-aware loading)
    // ============================================================
    /// void* on_load_host(void* prev, const SynthiHostContextV1* host_ctx)
    pub const ON_LOAD_HOST: &[u8] = b"on_load_host\0";
    /// uint32_t host_kv_schemas_len(void)
    pub const HOST_KV_SCHEMAS_LEN: &[u8] = b"host_kv_schemas_len\0";
    /// const SynthiNamespaceSchemaV1* host_kv_schemas(void)
    pub const HOST_KV_SCHEMAS: &[u8] = b"host_kv_schemas\0";

    // Function signatures (same as before for backward compatibility)
    pub type OnLoadFn = unsafe extern "C" fn(StatePtr, RendererPtr) -> StatePtr;
    pub type OnLoadHostFn = unsafe extern "C" fn(StatePtr, HostContextPtr) -> StatePtr;
    pub type EntrypointFn = unsafe extern "C" fn(StatePtr) -> StatePtr;
    pub type OnUpdateFn = unsafe extern "C" fn(StatePtr, c_double);
    pub type OnEventFn = unsafe extern "C" fn(StatePtr, SdlEventPtr);
    pub type OnUnloadFn = unsafe extern "C" fn(StatePtr);
    pub type OnSaveStateFn = unsafe extern "C" fn(StatePtr) -> *mut c_char;
    pub type OnLoadFromJsonFn = unsafe extern "C" fn(*const c_char) -> StatePtr;
    pub type RenderFn = unsafe extern "C" fn(StatePtr);
    pub type HostKvSchemasLenFn = unsafe extern "C" fn() -> c_uint;
    pub type HostKvSchemasFn = unsafe extern "C" fn() -> *const c_void;

    // ============================================================
    // BINARY SERIALIZATION TYPE SIGNATURES
    // ============================================================

    /// unsigned char* on_save_state_binary(void* state, size_t* out_size)
    pub type OnSaveStateBinaryFn = unsafe extern "C" fn(StatePtr, *mut usize) -> *mut u8;

    /// void* on_load_from_binary(const unsigned char* data, size_t size)
    pub type OnLoadFromBinaryFn = unsafe extern "C" fn(*const u8, usize) -> StatePtr;

    /// size_t get_state_binary_size()
    pub type GetStateBinarySizeFn = unsafe extern "C" fn() -> usize;
}

// ============================================================
// MODULE STATE TRACKING
// ============================================================

/// Per-module state tracking for independent swaps
#[derive(Debug)]
pub struct ModuleInfo {
    /// The module's own state pointer
    pub state_ptr: StatePtr,
    /// Path to the loaded library
    pub loaded_path: String,
    /// ABI version reported by the module
    pub abi_version: u32,
    /// Content hash for change detection
    pub content_hash: u64,
}

impl Default for ModuleInfo {
    fn default() -> Self {
        ModuleInfo {
            state_ptr: std::ptr::null_mut(),
            loaded_path: String::new(),
            abi_version: 0,
            content_hash: 0,
        }
    }
}

unsafe impl Send for ModuleInfo {}
unsafe impl Sync for ModuleInfo {}

// ============================================================
// VALIDATION HELPERS
// ============================================================

/// Check if a state pointer has valid magic and struct size
pub unsafe fn validate_state_header(
    state: StatePtr,
    expected_magic: u32,
    expected_size: u32,
) -> bool {
    if state.is_null() {
        return false;
    }

    // First two u32 fields are magic and struct_size
    let header = state as *const u32;
    let magic = *header;
    let struct_size = *header.add(1);

    magic == expected_magic && struct_size == expected_size
}

/// Extract ABI version from state header (third u32 field)
pub unsafe fn get_state_abi_version(state: StatePtr) -> Option<u32> {
    if state.is_null() {
        return None;
    }

    let header = state as *const u32;
    Some(*header.add(2))
}

/// Check ABI version compatibility
pub fn check_abi_compatibility(
    module_version: u32,
    min_supported: u32,
    max_supported: u32,
) -> LoadResult {
    if module_version < min_supported {
        LoadResult::AbiMismatch {
            expected: min_supported,
            got: module_version,
        }
    } else if module_version > max_supported {
        LoadResult::AbiMismatch {
            expected: max_supported,
            got: module_version,
        }
    } else {
        LoadResult::Success
    }
}

// ============================================================
// REBUILD DECISION TYPES
// ============================================================

/// What modules need to be rebuilt
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RebuildScope {
    /// Nothing changed
    None,
    /// Only GUI needs rebuild (core state preserved)
    GuiOnly,
    /// Only Core needs rebuild (triggers GUI reload too)
    CoreOnly,
    /// Both modules need rebuild
    Both,
    /// Full reload required (ABI break)
    FullReload,
}

impl RebuildScope {
    /// Combine two scopes (take the more extensive one)
    pub fn merge(&self, other: &RebuildScope) -> RebuildScope {
        match (self, other) {
            (RebuildScope::None, x) | (x, RebuildScope::None) => x.clone(),
            (RebuildScope::FullReload, _) | (_, RebuildScope::FullReload) => {
                RebuildScope::FullReload
            }
            (RebuildScope::Both, _) | (_, RebuildScope::Both) => RebuildScope::Both,
            (RebuildScope::CoreOnly, _) | (_, RebuildScope::CoreOnly) => RebuildScope::Both,
            (RebuildScope::GuiOnly, RebuildScope::GuiOnly) => RebuildScope::GuiOnly,
        }
    }

    /// Check if core needs to be rebuilt
    pub fn includes_core(&self) -> bool {
        matches!(
            self,
            RebuildScope::CoreOnly | RebuildScope::Both | RebuildScope::FullReload
        )
    }

    /// Check if gui needs to be rebuilt
    pub fn includes_gui(&self) -> bool {
        matches!(
            self,
            RebuildScope::GuiOnly | RebuildScope::Both | RebuildScope::FullReload
        )
    }
}

// ============================================================
// LEGACY FFI MODULE (backward compatibility)
// ============================================================

/// C-ABI compatible function signatures that the dynamic library must export.
/// DEPRECATED: Use core_symbols, gui_symbols, or legacy_symbols instead.
pub mod ffi {
    use super::StatePtr;
    use std::ffi::{c_double, c_uint};

    /// Symbol names expected by the host
    pub const ON_LOAD_SYMBOL: &[u8] = b"on_load\0";
    pub const ON_UPDATE_SYMBOL: &[u8] = b"on_update\0";
    pub const ON_UNLOAD_SYMBOL: &[u8] = b"on_unload\0";
    pub const GET_VERSION_SYMBOL: &[u8] = b"get_version\0";

    /// Initialize or migrate state.
    pub type OnLoadFn = unsafe extern "C" fn(StatePtr, StatePtr) -> StatePtr;

    /// Run logic for one frame.
    pub type OnUpdateFn = unsafe extern "C" fn(StatePtr, c_double);

    /// Prepare for code replacement.
    pub type OnUnloadFn = unsafe extern "C" fn(StatePtr);

    /// To verify the reload happened.
    pub type GetVersionFn = unsafe extern "C" fn() -> c_uint;
}

/// A standard trait that user code can implement.
/// DEPRECATED: This trait is for reference only.
pub trait HostGuestContract {
    unsafe fn on_load(prev_state: StatePtr, window_ptr: StatePtr) -> StatePtr;
    unsafe fn on_update(state: StatePtr, delta_time: f64);
    unsafe fn on_unload(state: StatePtr);
    fn get_version() -> u32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_module_slot_roundtrip() {
        assert_eq!(ModuleSlot::from_str("core"), Some(ModuleSlot::Core));
        assert_eq!(ModuleSlot::from_str("gui"), Some(ModuleSlot::Gui));
        assert_eq!(ModuleSlot::from_str("main"), Some(ModuleSlot::Main));
        assert_eq!(ModuleSlot::from_str("invalid"), None);
    }

    #[test]
    fn test_rebuild_scope_merge() {
        assert_eq!(
            RebuildScope::None.merge(&RebuildScope::GuiOnly),
            RebuildScope::GuiOnly
        );
        assert_eq!(
            RebuildScope::GuiOnly.merge(&RebuildScope::CoreOnly),
            RebuildScope::Both
        );
        assert_eq!(
            RebuildScope::Both.merge(&RebuildScope::GuiOnly),
            RebuildScope::Both
        );
        assert_eq!(
            RebuildScope::FullReload.merge(&RebuildScope::GuiOnly),
            RebuildScope::FullReload
        );
    }
}
