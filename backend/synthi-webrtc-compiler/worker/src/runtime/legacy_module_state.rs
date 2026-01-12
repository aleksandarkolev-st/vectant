use std::ffi::c_void;

// Per-module state tracking for independent swaps
// Enhanced to track ABI version and CoreAPI pointer for proper HMR
// Now actively used in module_states HashMap
pub struct ModuleState {
    pub state_ptr: *mut c_void,    // Module's own state (CoreState or GuiState)
    pub abi_version: u32,          // ABI version reported by the module
    pub schema_hash: u64,          // Schema hash for strict binary compatibility check
    pub core_api_ptr: *mut c_void, // For GUI: pointer to CoreAPI from core module
}

impl Default for ModuleState {
    fn default() -> Self {
        ModuleState {
            state_ptr: std::ptr::null_mut(),
            abi_version: 0,
            schema_hash: 0,
            core_api_ptr: std::ptr::null_mut(),
        }
    }
}

unsafe impl Send for ModuleState {}
unsafe impl Sync for ModuleState {}

// Legacy state container - used for backward compatibility with "main" module
// Now actively used in the main loop for app_state tracking
pub struct AppState {
    pub raw: *mut c_void,
    pub renderer: *mut c_void,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}
