#![allow(dead_code)]

use std::ffi::{c_void, c_double, c_char, c_uint};

// ============================================================
// SYNTHI PLUGIN ABI v1.0
// ============================================================
// This module defines the frozen ABI contract between the runner
// and dynamically loaded plugin modules (core, gui, main).
// See PLUGIN_ABI.md for the full specification.
// ============================================================

/// ABI version constants
pub const SYNTHI_CORE_ABI_VERSION: u32 = 1;
pub const SYNTHI_GUI_ABI_VERSION: u32 = 1;
pub const SYNTHI_MIN_SUPPORTED_ABI: u32 = 1;

/// Host KV API version
pub const SYNTHI_HOST_KV_VERSION: u32 = 1;

/// Magic numbers for struct validation
pub const CORE_STATE_MAGIC: u32 = 0xDEADBEEF;
pub const GUI_STATE_MAGIC: u32 = 0x60108EEF; // "GUI BEEF"

/// Opaque state pointers
pub type StatePtr = *mut c_void;
pub type RendererPtr = *mut c_void;
pub type CoreApiPtr = *mut c_void;
pub type SdlEventPtr = *mut c_void;
pub type HostContextPtr = *const c_void;

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
        ON_EVENT, ON_UNLOAD, GET_ABI_VERSION, 
        ON_SAVE_STATE, ON_LOAD_FROM_JSON, GET_STATE_SCHEMA_HASH,
        ON_SAVE_STATE_BINARY, ON_LOAD_FROM_BINARY, GET_STATE_BINARY_SIZE,  // Binary serialization
        ON_LOAD_HOST, HOST_KV_SCHEMAS_LEN, HOST_KV_SCHEMAS
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
        ON_EVENT, ON_UNLOAD, GET_ABI_VERSION, 
        ON_SAVE_STATE, ON_LOAD_FROM_JSON, GET_STATE_SCHEMA_HASH,
        ON_SAVE_STATE_BINARY, ON_LOAD_FROM_BINARY, GET_STATE_BINARY_SIZE,  // Binary serialization
        ON_LOAD_HOST, HOST_KV_SCHEMAS_LEN, HOST_KV_SCHEMAS
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
pub fn check_abi_compatibility(module_version: u32, min_supported: u32, max_supported: u32) -> LoadResult {
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
            (RebuildScope::FullReload, _) | (_, RebuildScope::FullReload) => RebuildScope::FullReload,
            (RebuildScope::Both, _) | (_, RebuildScope::Both) => RebuildScope::Both,
            (RebuildScope::CoreOnly, _) | (_, RebuildScope::CoreOnly) => RebuildScope::Both,
            (RebuildScope::GuiOnly, RebuildScope::GuiOnly) => RebuildScope::GuiOnly,
        }
    }
    
    /// Check if core needs to be rebuilt
    pub fn includes_core(&self) -> bool {
        matches!(self, RebuildScope::CoreOnly | RebuildScope::Both | RebuildScope::FullReload)
    }
    
    /// Check if gui needs to be rebuilt
    pub fn includes_gui(&self) -> bool {
        matches!(self, RebuildScope::GuiOnly | RebuildScope::Both | RebuildScope::FullReload)
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
        assert_eq!(RebuildScope::None.merge(&RebuildScope::GuiOnly), RebuildScope::GuiOnly);
        assert_eq!(RebuildScope::GuiOnly.merge(&RebuildScope::CoreOnly), RebuildScope::Both);
        assert_eq!(RebuildScope::Both.merge(&RebuildScope::GuiOnly), RebuildScope::Both);
        assert_eq!(RebuildScope::FullReload.merge(&RebuildScope::GuiOnly), RebuildScope::FullReload);
    }
}
