use crate::runtime::hot_reload::v2::HotModuleState;
use crate::runtime::legacy_module_state::ModuleState;
use crate::runtime::platform::sdl_defs::SDL_Window;
use libloading::Library;
use std::collections::HashMap;
use std::ffi::c_void;

pub struct RunnerContext {
    pub modules: HashMap<String, Library>,
    pub module_states: HashMap<String, ModuleState>,
    pub hot_module_states: HashMap<String, HotModuleState>,
    pub loaded_paths: HashMap<String, String>,
    pub app_state_raw: *mut c_void, // app_state.raw
    pub renderer: *mut c_void,
    pub window: *mut SDL_Window,
    // Add other fields as needed from main()
}

impl Default for RunnerContext {
    fn default() -> Self {
        Self {
            modules: HashMap::new(),
            module_states: HashMap::new(),
            hot_module_states: HashMap::new(),
            loaded_paths: HashMap::new(),
            app_state_raw: std::ptr::null_mut(),
            renderer: std::ptr::null_mut(),
            window: std::ptr::null_mut(),
        }
    }
}
