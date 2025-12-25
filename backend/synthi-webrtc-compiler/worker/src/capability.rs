#![allow(dead_code)]

// ============================================================
// CAPABILITY DETECTION MODULE
// ============================================================
// Inspects compiled library exports to determine HMR capability
// deterministically, replacing source-text string heuristics.
//
// DESIGN RATIONALE:
// - Next.js-like HMR detects capability from built artifacts, not source
// - This allows HMR to "just work" without users needing special code shape
// - We can also generate shims to make non-HMR code HMR-capable
// ============================================================

use std::path::Path;
use libloading::{Library, Symbol};
use std::ffi::c_void;

/// HMR capability level detected from exports
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HmrCapability {
    /// Full HMR: has on_load + on_update + state serialization
    Full,
    /// Partial HMR: has on_load + on_update but no state serialization
    /// State will be reset on reload
    Partial,
    /// Render-only: has on_load + render function but no on_update
    /// Can reload but runs as "one-shot" render
    RenderOnly,
    /// Blocking: has entrypoint/main but no on_update loop
    /// Requires full restart on code change
    Blocking,
    /// Invalid: missing required symbols entirely
    Invalid,
}

impl HmrCapability {
    /// Whether this capability level supports hot module replacement
    pub fn supports_hmr(&self) -> bool {
        matches!(self, HmrCapability::Full | HmrCapability::Partial | HmrCapability::RenderOnly)
    }
    
    /// Whether state can be preserved across reloads
    pub fn preserves_state(&self) -> bool {
        matches!(self, HmrCapability::Full)
    }
    
    /// Human-readable description for frontend
    pub fn description(&self) -> &'static str {
        match self {
            HmrCapability::Full => "Full HMR (state preserved)",
            HmrCapability::Partial => "Partial HMR (state reset on reload)",
            HmrCapability::RenderOnly => "Render-only (no update loop)",
            HmrCapability::Blocking => "Blocking app (requires full restart)",
            HmrCapability::Invalid => "Invalid module (missing exports)",
        }
    }
}

/// Module type detected from exports
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleType {
    /// New-style core module (core_on_load, core_on_update, core_get_api)
    Core,
    /// New-style GUI module (gui_on_load, gui_on_render)
    Gui,
    /// Legacy main module (on_load/entrypoint + on_update)
    Main,
    /// Unknown/invalid module
    Unknown,
}

/// Complete capability report for a compiled library
#[derive(Debug, Clone)]
pub struct CapabilityReport {
    pub module_type: ModuleType,
    pub hmr_capability: HmrCapability,
    pub abi_version: Option<u32>,
    pub exports: ExportSet,
    pub warnings: Vec<String>,
    pub can_shim: bool, // Whether we can auto-generate a shim to make it HMR-capable
    pub has_host_kv: bool, // Whether module supports Host KV API
    pub uses_host_context: bool, // Whether module uses *_on_load_host
}

/// Set of detected exports in a library
#[derive(Debug, Clone, Default)]
pub struct ExportSet {
    // Core module exports
    pub core_on_load: bool,
    pub core_on_update: bool,
    pub core_on_event: bool,
    pub core_on_unload: bool,
    pub core_get_api: bool,
    pub core_get_abi_version: bool,
    pub core_on_save_state: bool,
    pub core_on_load_from_json: bool,
    // Core Host KV exports
    pub core_on_load_host: bool,
    pub core_host_kv_schemas_len: bool,
    pub core_host_kv_schemas: bool,
    
    // GUI module exports
    pub gui_on_load: bool,
    pub gui_on_render: bool,
    pub gui_on_event: bool,
    pub gui_on_unload: bool,
    pub gui_get_abi_version: bool,
    pub gui_on_save_state: bool,
    pub gui_on_load_from_json: bool,
    // GUI Host KV exports
    pub gui_on_load_host: bool,
    pub gui_host_kv_schemas_len: bool,
    pub gui_host_kv_schemas: bool,
    
    // Legacy exports
    pub on_load: bool,
    pub entrypoint: bool,
    pub on_update: bool,
    pub on_event: bool,
    pub on_unload: bool,
    pub on_save_state: bool,
    pub on_load_from_json: bool,
    pub gui_render: bool,
    pub on_render: bool,
    // Legacy Host KV exports
    pub on_load_host: bool,
    pub host_kv_schemas_len: bool,
    pub host_kv_schemas: bool,
    
    // Blocking app indicators
    pub main: bool,  // Has `main` symbol (C/C++ entry point)
}

impl ExportSet {
    /// Check if this is a new-style core module
    pub fn is_core_module(&self) -> bool {
        self.core_on_load && self.core_on_update
    }
    
    /// Check if this is a new-style GUI module
    pub fn is_gui_module(&self) -> bool {
        self.gui_on_load && self.gui_on_render
    }
    
    /// Check if this has any HMR hooks
    pub fn has_hmr_hooks(&self) -> bool {
        self.on_update || self.core_on_update || self.gui_on_render
    }
    
    /// Check if this has state serialization
    pub fn has_state_serialization(&self) -> bool {
        (self.on_save_state && self.on_load_from_json) ||
        (self.core_on_save_state && self.core_on_load_from_json) ||
        (self.gui_on_save_state && self.gui_on_load_from_json)
    }
    
    /// Check if this is a blocking/one-shot app
    pub fn is_blocking(&self) -> bool {
        // Has main/entrypoint but no on_update
        (self.main || self.entrypoint) && !self.on_update && !self.core_on_update
    }
    
    /// Check if this module supports Host KV
    pub fn has_host_kv(&self) -> bool {
        // Has on_load_host OR has schema exports
        self.core_on_load_host || self.gui_on_load_host || self.on_load_host ||
        (self.core_host_kv_schemas_len && self.core_host_kv_schemas) ||
        (self.gui_host_kv_schemas_len && self.gui_host_kv_schemas) ||
        (self.host_kv_schemas_len && self.host_kv_schemas)
    }
    
    /// Check if this module uses host context loading (preferred path)
    pub fn uses_host_context(&self) -> bool {
        self.core_on_load_host || self.gui_on_load_host || self.on_load_host
    }
    
    /// Check if this module has schema table exports
    pub fn has_schema_table(&self) -> bool {
        (self.core_host_kv_schemas_len && self.core_host_kv_schemas) ||
        (self.gui_host_kv_schemas_len && self.gui_host_kv_schemas) ||
        (self.host_kv_schemas_len && self.host_kv_schemas)
    }
}

/// Inspect a compiled library and detect its capabilities
/// 
/// This is the main entry point for capability detection.
/// Call this AFTER compilation succeeds to determine HMR behavior.
pub fn detect_capabilities(lib_path: &Path) -> Result<CapabilityReport, String> {
    // Safety: We're loading a library just to check exports, then dropping it
    // The library should not have side effects in its static initialization
    let lib = unsafe {
        #[cfg(unix)]
        {
            use libloading::os::unix::{Library as UnixLib, RTLD_NOW, RTLD_LOCAL};
            UnixLib::open(Some(lib_path), RTLD_NOW | RTLD_LOCAL)
                .map(|l| Library::from(l))
                .map_err(|e| format!("Failed to load library: {}", e))?
        }
        #[cfg(not(unix))]
        {
            Library::new(lib_path)
                .map_err(|e| format!("Failed to load library: {}", e))?
        }
    };
    
    let exports = probe_exports(&lib);
    let abi_version = probe_abi_version(&lib, &exports);
    let (module_type, hmr_capability) = classify_module(&exports);
    let warnings = generate_warnings(&exports, &module_type, &hmr_capability);
    let can_shim = can_generate_shim(&exports);
    let has_host_kv = exports.has_host_kv();
    let uses_host_context = exports.uses_host_context();
    
    Ok(CapabilityReport {
        module_type,
        hmr_capability,
        abi_version,
        exports,
        warnings,
        can_shim,
        has_host_kv,
        uses_host_context,
    })
}

/// Probe all known symbols in the library
fn probe_exports(lib: &Library) -> ExportSet {
    let mut exports = ExportSet::default();
    
    // Type aliases for cleaner probing
    type VoidFn = unsafe extern "C" fn();
    type LoadFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
    type LoadHostFn = unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void;
    type UpdateFn = unsafe extern "C" fn(*mut c_void, f64);
    type EventFn = unsafe extern "C" fn(*mut c_void, *mut c_void);
    type UnloadFn = unsafe extern "C" fn(*mut c_void);
    type GetApiFn = unsafe extern "C" fn() -> *mut c_void;
    type GetAbiFn = unsafe extern "C" fn() -> u32;
    type SaveStateFn = unsafe extern "C" fn(*mut c_void) -> *mut i8;
    type LoadFromJsonFn = unsafe extern "C" fn(*const i8) -> *mut c_void;
    type EntrypointFn = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
    type RenderFn = unsafe extern "C" fn(*mut c_void);
    type GuiLoadFn = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void;
    type SchemaLenFn = unsafe extern "C" fn() -> u32;
    type SchemasFn = unsafe extern "C" fn() -> *const c_void;
    
    unsafe {
        // Core module exports
        exports.core_on_load = lib.get::<Symbol<LoadFn>>(b"core_on_load").is_ok();
        exports.core_on_update = lib.get::<Symbol<UpdateFn>>(b"core_on_update").is_ok();
        exports.core_on_event = lib.get::<Symbol<EventFn>>(b"core_on_event").is_ok();
        exports.core_on_unload = lib.get::<Symbol<UnloadFn>>(b"core_on_unload").is_ok();
        exports.core_get_api = lib.get::<Symbol<GetApiFn>>(b"core_get_api").is_ok();
        exports.core_get_abi_version = lib.get::<Symbol<GetAbiFn>>(b"core_get_abi_version").is_ok();
        exports.core_on_save_state = lib.get::<Symbol<SaveStateFn>>(b"core_on_save_state").is_ok();
        exports.core_on_load_from_json = lib.get::<Symbol<LoadFromJsonFn>>(b"core_on_load_from_json").is_ok();
        // Core Host KV exports
        exports.core_on_load_host = lib.get::<Symbol<LoadHostFn>>(b"core_on_load_host").is_ok();
        exports.core_host_kv_schemas_len = lib.get::<Symbol<SchemaLenFn>>(b"core_host_kv_schemas_len").is_ok();
        exports.core_host_kv_schemas = lib.get::<Symbol<SchemasFn>>(b"core_host_kv_schemas").is_ok();
        
        // GUI module exports
        exports.gui_on_load = lib.get::<Symbol<GuiLoadFn>>(b"gui_on_load").is_ok();
        exports.gui_on_render = lib.get::<Symbol<RenderFn>>(b"gui_on_render").is_ok();
        exports.gui_on_event = lib.get::<Symbol<EventFn>>(b"gui_on_event").is_ok();
        exports.gui_on_unload = lib.get::<Symbol<UnloadFn>>(b"gui_on_unload").is_ok();
        exports.gui_get_abi_version = lib.get::<Symbol<GetAbiFn>>(b"gui_get_abi_version").is_ok();
        exports.gui_on_save_state = lib.get::<Symbol<SaveStateFn>>(b"gui_on_save_state").is_ok();
        exports.gui_on_load_from_json = lib.get::<Symbol<LoadFromJsonFn>>(b"gui_on_load_from_json").is_ok();
        // GUI Host KV exports
        exports.gui_on_load_host = lib.get::<Symbol<LoadHostFn>>(b"gui_on_load_host").is_ok();
        exports.gui_host_kv_schemas_len = lib.get::<Symbol<SchemaLenFn>>(b"gui_host_kv_schemas_len").is_ok();
        exports.gui_host_kv_schemas = lib.get::<Symbol<SchemasFn>>(b"gui_host_kv_schemas").is_ok();
        
        // Legacy exports
        exports.on_load = lib.get::<Symbol<LoadFn>>(b"on_load").is_ok();
        exports.entrypoint = lib.get::<Symbol<EntrypointFn>>(b"entrypoint").is_ok();
        exports.on_update = lib.get::<Symbol<UpdateFn>>(b"on_update").is_ok();
        exports.on_event = lib.get::<Symbol<EventFn>>(b"on_event").is_ok();
        exports.on_unload = lib.get::<Symbol<UnloadFn>>(b"on_unload").is_ok();
        exports.on_save_state = lib.get::<Symbol<SaveStateFn>>(b"on_save_state").is_ok();
        exports.on_load_from_json = lib.get::<Symbol<LoadFromJsonFn>>(b"on_load_from_json").is_ok();
        exports.gui_render = lib.get::<Symbol<RenderFn>>(b"gui_render").is_ok();
        exports.on_render = lib.get::<Symbol<RenderFn>>(b"on_render").is_ok();
        // Legacy Host KV exports
        exports.on_load_host = lib.get::<Symbol<LoadHostFn>>(b"on_load_host").is_ok();
        exports.host_kv_schemas_len = lib.get::<Symbol<SchemaLenFn>>(b"host_kv_schemas_len").is_ok();
        exports.host_kv_schemas = lib.get::<Symbol<SchemasFn>>(b"host_kv_schemas").is_ok();
        
        // Blocking app indicator
        exports.main = lib.get::<Symbol<VoidFn>>(b"main").is_ok();
    }
    
    exports
}

/// Try to get ABI version from the library
fn probe_abi_version(lib: &Library, exports: &ExportSet) -> Option<u32> {
    unsafe {
        if exports.core_get_abi_version {
            if let Ok(f) = lib.get::<Symbol<unsafe extern "C" fn() -> u32>>(b"core_get_abi_version") {
                return Some(f());
            }
        }
        if exports.gui_get_abi_version {
            if let Ok(f) = lib.get::<Symbol<unsafe extern "C" fn() -> u32>>(b"gui_get_abi_version") {
                return Some(f());
            }
        }
    }
    None
}

/// Classify module type and HMR capability based on exports
fn classify_module(exports: &ExportSet) -> (ModuleType, HmrCapability) {
    // New-style core module
    if exports.is_core_module() {
        let capability = if exports.core_on_save_state && exports.core_on_load_from_json {
            HmrCapability::Full
        } else {
            HmrCapability::Partial
        };
        return (ModuleType::Core, capability);
    }
    
    // New-style GUI module
    if exports.is_gui_module() {
        let capability = if exports.gui_on_save_state && exports.gui_on_load_from_json {
            HmrCapability::Full
        } else {
            HmrCapability::Partial
        };
        return (ModuleType::Gui, capability);
    }
    
    // Legacy main module with on_update (HMR-capable)
    if (exports.on_load || exports.entrypoint) && exports.on_update {
        let capability = if exports.on_save_state && exports.on_load_from_json {
            HmrCapability::Full
        } else {
            HmrCapability::Partial
        };
        return (ModuleType::Main, capability);
    }
    
    // Legacy main module with render but no update (render-only)
    if (exports.on_load || exports.entrypoint) && (exports.gui_render || exports.on_render) {
        return (ModuleType::Main, HmrCapability::RenderOnly);
    }
    
    // Blocking app (has entry but no update)
    if exports.entrypoint || exports.main {
        return (ModuleType::Main, HmrCapability::Blocking);
    }
    
    // Invalid - missing essential exports
    (ModuleType::Unknown, HmrCapability::Invalid)
}

/// Generate warnings based on module analysis
fn generate_warnings(exports: &ExportSet, module_type: &ModuleType, capability: &HmrCapability) -> Vec<String> {
    let mut warnings = Vec::new();
    
    // Warn about missing state serialization
    if *capability == HmrCapability::Partial {
        warnings.push("Missing state serialization (on_save_state/on_load_from_json). State will reset on hot reload.".to_string());
    }
    
    // Warn about blocking apps
    if *capability == HmrCapability::Blocking {
        warnings.push("Blocking app detected (no on_update). Requires full restart on code changes.".to_string());
    }
    
    // Warn about render-only
    if *capability == HmrCapability::RenderOnly {
        warnings.push("Render-only module (no on_update). Consider adding update loop for interactive apps.".to_string());
    }
    
    // Warn about missing event handler
    if !exports.on_event && !exports.core_on_event && !exports.gui_on_event {
        if *capability != HmrCapability::Blocking && *capability != HmrCapability::Invalid {
            warnings.push("No event handler exported. Input events will not be processed.".to_string());
        }
    }
    
    // Warn about missing ABI version
    if !exports.core_get_abi_version && !exports.gui_get_abi_version {
        match module_type {
            ModuleType::Core => warnings.push("Core module missing core_get_abi_version. ABI compatibility cannot be verified.".to_string()),
            ModuleType::Gui => warnings.push("GUI module missing gui_get_abi_version. ABI compatibility cannot be verified.".to_string()),
            _ => {}
        }
    }
    
    warnings
}

/// Determine if we can generate a shim to make this module HMR-capable
fn can_generate_shim(exports: &ExportSet) -> bool {
    // We can shim blocking apps if they have entrypoint or main
    // The shim will wrap the blocking call in an on_update loop
    (exports.entrypoint || exports.main) && !exports.on_update
}

/// Quick check if a compiled library supports HMR (without full report)
pub fn supports_hmr(lib_path: &Path) -> bool {
    detect_capabilities(lib_path)
        .map(|r| r.hmr_capability.supports_hmr())
        .unwrap_or(false)
}

/// Quick check if a compiled library is a blocking app
pub fn is_blocking(lib_path: &Path) -> bool {
    detect_capabilities(lib_path)
        .map(|r| r.hmr_capability == HmrCapability::Blocking)
        .unwrap_or(false)
}

// ============================================================
// NEW SINGLE-EXPORT ABI VALIDATION (v2.0)
// ============================================================
// The new ABI uses a single export: hot_get_api() -> *const HotApi
// This replaces the multi-symbol legacy ABI.
// ============================================================

use crate::plugin_contract::{
    HotApi, HotGetApiFn, HOT_GET_API_SYMBOL, HOT_API_VERSION, HOT_API_MIN_VERSION,
    MAX_STATE_ALIGNMENT,
};

/// Result of validating a new-style hot module
#[derive(Debug, Clone)]
pub struct HotApiValidation {
    /// Whether the module exports hot_get_api
    pub has_hot_api: bool,
    /// Pointer to the HotApi table (if valid)
    pub api: Option<HotApiInfo>,
    /// Validation errors
    pub errors: Vec<String>,
    /// Validation warnings
    pub warnings: Vec<String>,
}

/// Information extracted from HotApi table
#[derive(Debug, Clone)]
pub struct HotApiInfo {
    pub struct_size: u32,
    pub api_version: u32,
    pub state_version: u32,
    pub abi_fingerprint: u64,
    pub state_size_bytes: usize,
    pub state_align_bytes: usize,
    pub has_init: bool,
    pub has_shutdown: bool,
    pub has_tick: bool,
    pub has_render: bool,
    pub has_event: bool,
    pub has_migrate: bool,
    pub has_msgpack_serialization: bool,
    pub has_json_serialization: bool,
}

/// Validate a new-style hot module that exports hot_get_api
pub fn validate_hot_api(lib: &Library) -> HotApiValidation {
    let mut result = HotApiValidation {
        has_hot_api: false,
        api: None,
        errors: Vec::new(),
        warnings: Vec::new(),
    };
    
    // Try to get the hot_get_api symbol
    let hot_get_api: Result<Symbol<HotGetApiFn>, _> = unsafe {
        lib.get(b"hot_get_api")
    };
    
    let hot_get_api = match hot_get_api {
        Ok(f) => {
            result.has_hot_api = true;
            f
        }
        Err(_) => {
            // Not a new-style module, might be legacy
            result.warnings.push("Module does not export hot_get_api - may be legacy ABI".to_string());
            return result;
        }
    };
    
    // Call hot_get_api to get the table pointer
    let api_ptr: *const HotApi = unsafe { hot_get_api() };
    
    if api_ptr.is_null() {
        result.errors.push("hot_get_api() returned NULL".to_string());
        return result;
    }
    
    // Read and validate the HotApi table
    let api = unsafe { &*api_ptr };
    
    // 1. Validate struct_size (must be at least minimum required)
    let min_size = std::mem::offset_of!(HotApi, migrate) + std::mem::size_of::<Option<crate::plugin_contract::MigrateFn>>();
    if (api.struct_size as usize) < min_size {
        result.errors.push(format!(
            "struct_size {} too small - minimum required is {} (missing required fields)",
            api.struct_size, min_size
        ));
        return result;
    }
    
    // 2. Validate API version
    if api.api_version < HOT_API_MIN_VERSION {
        result.errors.push(format!(
            "api_version {} is too old - minimum supported is {}",
            api.api_version, HOT_API_MIN_VERSION
        ));
        return result;
    }
    
    if api.api_version > HOT_API_VERSION {
        result.warnings.push(format!(
            "api_version {} is newer than runner ({}) - some features may not be supported",
            api.api_version, HOT_API_VERSION
        ));
    }
    
    // 3. Validate state_align_bytes is power of 2
    if api.state_align_bytes == 0 || !api.state_align_bytes.is_power_of_two() {
        result.errors.push(format!(
            "state_align_bytes {} is not a power of 2",
            api.state_align_bytes
        ));
        return result;
    }
    
    // 4. Validate state_align_bytes is within sane range
    if api.state_align_bytes > MAX_STATE_ALIGNMENT {
        result.errors.push(format!(
            "state_align_bytes {} exceeds maximum {}",
            api.state_align_bytes, MAX_STATE_ALIGNMENT
        ));
        return result;
    }
    
    // 5. Validate state_size_bytes is multiple of alignment
    if api.state_size_bytes % api.state_align_bytes != 0 {
        result.errors.push(format!(
            "state_size_bytes {} is not a multiple of state_align_bytes {}",
            api.state_size_bytes, api.state_align_bytes
        ));
        return result;
    }
    
    // 6. Check required init function
    if api.init.is_none() {
        result.errors.push("init function is required but missing".to_string());
        return result;
    }
    
    // Build HotApiInfo
    result.api = Some(HotApiInfo {
        struct_size: api.struct_size,
        api_version: api.api_version,
        state_version: api.state_version,
        abi_fingerprint: api.abi_fingerprint,
        state_size_bytes: api.state_size_bytes,
        state_align_bytes: api.state_align_bytes,
        has_init: api.init.is_some(),
        has_shutdown: api.shutdown.is_some(),
        has_tick: api.tick.is_some(),
        has_render: api.render.is_some(),
        has_event: api.event.is_some(),
        has_migrate: api.migrate.is_some(),
        has_msgpack_serialization: api.save_state_msgpack_size.is_some() && api.save_state_msgpack_write.is_some(),
        has_json_serialization: api.save_state_json_size.is_some() && api.save_state_json_write.is_some(),
    });
    
    // Add warnings for missing optional but recommended features
    if api.migrate.is_none() {
        result.warnings.push("migrate function not provided - cross-version state migration will fail".to_string());
    }
    
    if api.save_state_msgpack_size.is_none() || api.save_state_msgpack_write.is_none() {
        result.warnings.push("MsgPack serialization not provided - state cannot be preserved across reloads".to_string());
    }
    
    result
}

/// Detect capabilities including new-style HotApi
pub fn detect_capabilities_v2(lib_path: &Path) -> Result<(CapabilityReport, Option<HotApiValidation>), String> {
    let lib = unsafe {
        #[cfg(unix)]
        {
            use libloading::os::unix::{Library as UnixLib, RTLD_NOW, RTLD_LOCAL};
            UnixLib::open(Some(lib_path), RTLD_NOW | RTLD_LOCAL)
                .map(|l| Library::from(l))
                .map_err(|e| format!("Failed to load library: {}", e))?
        }
        #[cfg(not(unix))]
        {
            Library::new(lib_path)
                .map_err(|e| format!("Failed to load library: {}", e))?
        }
    };
    
    // First try new-style HotApi
    let hot_validation = validate_hot_api(&lib);
    
    if hot_validation.has_hot_api && hot_validation.errors.is_empty() {
        // New-style module - create capability report from HotApiInfo
        let api_info = hot_validation.api.as_ref().unwrap();
        
        let report = CapabilityReport {
            module_type: ModuleType::Main, // New API doesn't distinguish core/gui
            hmr_capability: if api_info.has_msgpack_serialization {
                HmrCapability::Full
            } else {
                HmrCapability::Partial
            },
            abi_version: Some(api_info.api_version),
            exports: ExportSet::default(), // Legacy exports not used
            warnings: hot_validation.warnings.clone(),
            can_shim: false,
            has_host_kv: false, // TODO: Add to HotApi
            uses_host_context: false,
        };
        
        return Ok((report, Some(hot_validation)));
    }
    
    // Fall back to legacy detection
    let exports = probe_exports(&lib);
    let abi_version = probe_abi_version(&lib, &exports);
    let (module_type, hmr_capability) = classify_module(&exports);
    let warnings = generate_warnings(&exports, &module_type, &hmr_capability);
    let can_shim = can_generate_shim(&exports);
    let has_host_kv = exports.has_host_kv();
    let uses_host_context = exports.uses_host_context();
    
    let report = CapabilityReport {
        module_type,
        hmr_capability,
        abi_version,
        exports,
        warnings,
        can_shim,
        has_host_kv,
        uses_host_context,
    };
    
    Ok((report, Some(hot_validation)))
}

// ============================================================
// STRUCTURED HMR STATUS EVENTS
// ============================================================
// Protocol for sending HMR status to the frontend
// ============================================================

use serde::{Serialize, Deserialize};

/// HMR operation result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum HmrStatus {
    /// HMR successfully applied
    Applied {
        module: String,
        capability: String,
        state_preserved: bool,
    },
    /// HMR rejected - fallback to full reload
    Rejected {
        module: String,
        reason: String,
        fallback: String,
    },
    /// Compilation failed
    CompileError {
        module: String,
        errors: Vec<String>,
    },
    /// Full reload required
    FullReloadRequired {
        reason: String,
    },
    /// Capability detection result
    CapabilityDetected {
        module: String,
        module_type: String,
        capability: String,
        can_shim: bool,
        warnings: Vec<String>,
        has_host_kv: bool,
    },
    // ============================================================
    // HOST KV STATUS EVENTS
    // ============================================================
    /// Host KV is ready (session set, context available)
    HostKvReady {
        session_id: String,
        module_slot: String,
    },
    /// Namespaces preserved on reload
    HostKvPreserved {
        module: String,
        namespaces: Vec<String>,
    },
    /// Schema mismatch caused namespace reset
    HostKvResetSchemaMismatch {
        module: String,
        namespace: String,
        old_schema: u64,
        new_schema: u64,
    },
    /// Write rejected (quota or invalid namespace)
    HostKvWriteRejected {
        module: String,
        namespace: String,
        key: String,
        reason: String,
    },
    // ============================================================
    // STATE MIGRATION STATUS EVENTS
    // ============================================================
    /// Field-level state migration applied (like Next.js Fast Refresh)
    StateMigrated {
        module: String,
        preserved_count: usize,
        reset_count: usize,
        new_count: usize,
    },
}

impl HmrStatus {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
    
    pub fn applied(module: &str, report: &CapabilityReport) -> Self {
        HmrStatus::Applied {
            module: module.to_string(),
            capability: report.hmr_capability.description().to_string(),
            state_preserved: report.hmr_capability.preserves_state(),
        }
    }
    
    pub fn rejected(module: &str, reason: &str) -> Self {
        HmrStatus::Rejected {
            module: module.to_string(),
            reason: reason.to_string(),
            fallback: "Full restart".to_string(),
        }
    }
    
    /// Create a rejected status with custom fallback action
    pub fn rejected_with_fallback(module: &str, reason: &str, fallback: &str) -> Self {
        HmrStatus::Rejected {
            module: module.to_string(),
            reason: reason.to_string(),
            fallback: fallback.to_string(),
        }
    }
    
    /// Create a compile error status
    pub fn compile_error(module: &str, errors: Vec<String>) -> Self {
        HmrStatus::CompileError {
            module: module.to_string(),
            errors,
        }
    }
    
    /// Create a full reload required status
    pub fn full_reload(reason: &str) -> Self {
        HmrStatus::FullReloadRequired {
            reason: reason.to_string(),
        }
    }
    
    pub fn capability_detected(module: &str, report: &CapabilityReport) -> Self {
        HmrStatus::CapabilityDetected {
            module: module.to_string(),
            module_type: format!("{:?}", report.module_type),
            capability: report.hmr_capability.description().to_string(),
            can_shim: report.can_shim,
            warnings: report.warnings.clone(),
            has_host_kv: report.has_host_kv,
        }
    }
    
    /// Create host KV ready status
    pub fn host_kv_ready(session_id: &str, module_slot: &str) -> Self {
        HmrStatus::HostKvReady {
            session_id: session_id.to_string(),
            module_slot: module_slot.to_string(),
        }
    }
    
    /// Create host KV preserved status
    pub fn host_kv_preserved(module: &str, namespaces: Vec<String>) -> Self {
        HmrStatus::HostKvPreserved {
            module: module.to_string(),
            namespaces,
        }
    }
    
    /// Create host KV schema mismatch reset status
    pub fn host_kv_reset_schema(module: &str, namespace: &str, old_schema: u64, new_schema: u64) -> Self {
        HmrStatus::HostKvResetSchemaMismatch {
            module: module.to_string(),
            namespace: namespace.to_string(),
            old_schema,
            new_schema,
        }
    }
    
    /// Create host KV write rejected status
    pub fn host_kv_write_rejected(module: &str, namespace: &str, key: &str, reason: &str) -> Self {
        HmrStatus::HostKvWriteRejected {
            module: module.to_string(),
            namespace: namespace.to_string(),
            key: key.to_string(),
            reason: reason.to_string(),
        }
    }
    
    /// Create state migrated status (field-level diffing applied)
    pub fn state_migrated(module: &str, preserved_count: usize, reset_count: usize, new_count: usize) -> Self {
        HmrStatus::StateMigrated {
            module: module.to_string(),
            preserved_count,
            reset_count,
            new_count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_export_set_classification() {
        let mut exports = ExportSet::default();
        
        // Empty exports -> not HMR capable
        assert!(!exports.has_hmr_hooks());
        assert!(!exports.has_state_serialization());
        assert!(!exports.is_blocking());
        
        // With on_update -> HMR capable
        exports.on_update = true;
        assert!(exports.has_hmr_hooks());
        
        // With state serialization
        exports.on_save_state = true;
        exports.on_load_from_json = true;
        assert!(exports.has_state_serialization());
        
        // With main but no on_update -> blocking
        exports.on_update = false;
        exports.main = true;
        assert!(exports.is_blocking());
    }
    
    #[test]
    fn test_hmr_capability_properties() {
        assert!(HmrCapability::Full.supports_hmr());
        assert!(HmrCapability::Full.preserves_state());
        
        assert!(HmrCapability::Partial.supports_hmr());
        assert!(!HmrCapability::Partial.preserves_state());
        
        assert!(!HmrCapability::Blocking.supports_hmr());
        assert!(!HmrCapability::Blocking.preserves_state());
    }
}
