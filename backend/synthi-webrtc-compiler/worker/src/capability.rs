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
    
    // GUI module exports
    pub gui_on_load: bool,
    pub gui_on_render: bool,
    pub gui_on_event: bool,
    pub gui_on_unload: bool,
    pub gui_get_abi_version: bool,
    pub gui_on_save_state: bool,
    pub gui_on_load_from_json: bool,
    
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
    
    Ok(CapabilityReport {
        module_type,
        hmr_capability,
        abi_version,
        exports,
        warnings,
        can_shim,
    })
}

/// Probe all known symbols in the library
fn probe_exports(lib: &Library) -> ExportSet {
    let mut exports = ExportSet::default();
    
    // Type aliases for cleaner probing
    type VoidFn = unsafe extern "C" fn();
    type LoadFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
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
        
        // GUI module exports
        exports.gui_on_load = lib.get::<Symbol<GuiLoadFn>>(b"gui_on_load").is_ok();
        exports.gui_on_render = lib.get::<Symbol<RenderFn>>(b"gui_on_render").is_ok();
        exports.gui_on_event = lib.get::<Symbol<EventFn>>(b"gui_on_event").is_ok();
        exports.gui_on_unload = lib.get::<Symbol<UnloadFn>>(b"gui_on_unload").is_ok();
        exports.gui_get_abi_version = lib.get::<Symbol<GetAbiFn>>(b"gui_get_abi_version").is_ok();
        exports.gui_on_save_state = lib.get::<Symbol<SaveStateFn>>(b"gui_on_save_state").is_ok();
        exports.gui_on_load_from_json = lib.get::<Symbol<LoadFromJsonFn>>(b"gui_on_load_from_json").is_ok();
        
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
