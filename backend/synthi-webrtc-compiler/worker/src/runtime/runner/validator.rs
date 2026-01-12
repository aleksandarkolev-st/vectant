use std::ffi::{c_uint, c_void};
use libloading::{Library, Symbol};
use crate::runtime::plugin_contract::{ModuleSlot, SYNTHI_CORE_ABI_VERSION, SYNTHI_GUI_ABI_VERSION};

pub struct ValidationInfo {
    pub has_required_symbols: bool,
    pub module_abi_version: u32,
}

pub unsafe fn validate_symbols(new_lib: &Library, name: &str) -> ValidationInfo {
    let slot = ModuleSlot::from_str(name);
    let mut has_required_symbols = false;
    let mut module_abi_version: u32 = 0;

    match slot {
        Some(ModuleSlot::Core) => {
            // Core module: require core_on_load, core_on_update, core_get_api
            // OR legacy on_load/on_update for backward compat
            let core_load: Result<
                Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>,
                _,
            > = new_lib.get(b"core_on_load");
            let core_update: Result<
                Symbol<unsafe extern "C" fn(*mut c_void, f64)>,
                _,
            > = new_lib.get(b"core_on_update");
            let _core_get_api: Result<
                Symbol<unsafe extern "C" fn() -> *mut c_void>,
                _,
            > = new_lib.get(b"core_get_api");
            let legacy_load: Result<
                Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>,
                _,
            > = new_lib.get(b"on_load");
            let legacy_update: Result<
                Symbol<unsafe extern "C" fn(*mut c_void, f64)>,
                _,
            > = new_lib.get(b"on_update"); // Legacy

            if (core_load.is_ok() && core_update.is_ok())
                || (legacy_load.is_ok() && legacy_update.is_ok())
            {
                has_required_symbols = true;
            }

            // Try to get ABI version
            let get_abi: Result<Symbol<unsafe extern "C" fn() -> c_uint>, _> =
                new_lib.get(b"core_get_abi_version");
            if let Ok(f) = get_abi {
                module_abi_version = f();
            }
        }
        Some(ModuleSlot::Gui) => {
            // GUI module: require gui_on_load, gui_on_render
            // OR legacy on_load + gui_render for backward compat
            let gui_load: Result<
                Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void>,
                _,
            > = new_lib.get(b"gui_on_load");
            let gui_render: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                new_lib.get(b"gui_on_render");
            let legacy_load: Result<
                Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>,
                _,
            > = new_lib.get(b"on_load");
            let legacy_render: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                new_lib.get(b"gui_render");
            let legacy_on_render: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                new_lib.get(b"on_render");

            if (gui_load.is_ok() && gui_render.is_ok())
                || (legacy_load.is_ok() && (legacy_render.is_ok() || legacy_on_render.is_ok()))
            {
                has_required_symbols = true;
            }

            // Try to get ABI version
            let get_abi: Result<Symbol<unsafe extern "C" fn() -> c_uint>, _> =
                new_lib.get(b"gui_get_abi_version");
            if let Ok(f) = get_abi {
                module_abi_version = f();
            }
        }
        Some(ModuleSlot::Main) | None => {
            // Legacy main module: require on_load or entrypoint + on_update
            let legacy_load: Result<
                Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>,
                _,
            > = new_lib.get(b"on_load");
            let legacy_entry: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut c_void>, _> =
                new_lib.get(b"entrypoint");
            let legacy_update: Result<Symbol<unsafe extern "C" fn(*mut c_void, f64)>, _> =
                new_lib.get(b"on_update");

            if (legacy_load.is_ok() || legacy_entry.is_ok()) && legacy_update.is_ok() {
                has_required_symbols = true;
            } else if legacy_load.is_ok() || legacy_entry.is_ok() {
                // Allow modules with just load/entrypoint (render-only modules)
                has_required_symbols = true;
            }
        }
    }
    
    ValidationInfo {
        has_required_symbols,
        module_abi_version
    }
}
