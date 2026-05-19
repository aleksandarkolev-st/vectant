use crate::runtime::plugin_contract::ModuleSlot;
use libloading::{Library, Symbol};
use std::ffi::{c_uint, c_void};
use std::path::Path;

const GPU_HOST_CONTRACT_REQUIRED_SYMBOLS: &[&str] = &[
    "device_descriptor",
    "device_on_load",
    "device_kernel_sig_hash",
];

const GPU_HOST_CONTRACT_STATE_SYMBOLS: &[&str] = &["device_save_size", "device_save_write"];

pub struct ValidationInfo {
    pub has_required_symbols: bool,
    pub module_abi_version: u32,
    pub has_gpu_contract: bool,
    pub has_gpu_state_serialization: bool,
    pub missing_gpu_contract_symbols: Vec<&'static str>,
}

pub unsafe fn validate_symbols(new_lib: &Library, name: &str) -> ValidationInfo {
    validate_symbols_with_gpu_contract(new_lib, name, false)
}

pub unsafe fn validate_symbols_with_gpu_contract(
    new_lib: &Library,
    name: &str,
    require_gpu_contract: bool,
) -> ValidationInfo {
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
            let core_update: Result<Symbol<unsafe extern "C" fn(*mut c_void, f64)>, _> =
                new_lib.get(b"core_on_update");
            let _core_get_api: Result<Symbol<unsafe extern "C" fn() -> *mut c_void>, _> =
                new_lib.get(b"core_get_api");
            let legacy_load: Result<
                Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>,
                _,
            > = new_lib.get(b"on_load");
            let legacy_update: Result<Symbol<unsafe extern "C" fn(*mut c_void, f64)>, _> =
                new_lib.get(b"on_update"); // Legacy

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

    let gpu_presence = unsafe { GpuHostContractPresence::probe(new_lib) };
    let gpu_contract_required = require_gpu_contract && module_requires_gpu_contract(name);
    let missing_gpu_contract_symbols =
        missing_gpu_host_contract_symbols(&gpu_presence, gpu_contract_required);
    if !missing_gpu_contract_symbols.is_empty() {
        has_required_symbols = false;
    }

    ValidationInfo {
        has_required_symbols,
        module_abi_version,
        has_gpu_contract: gpu_presence.has_required_contract(),
        has_gpu_state_serialization: gpu_presence.has_state_serialization(),
        missing_gpu_contract_symbols,
    }
}

pub fn workspace_requires_gpu_contract() -> bool {
    sidecar_path_requires_gpu_contract(Path::new(".synthi_split_meta.json"))
        || sidecar_path_requires_gpu_contract(Path::new(".synthi/build_manifest.json"))
}

pub fn sidecar_path_requires_gpu_contract(path: &Path) -> bool {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return false,
    };
    sidecar_requires_gpu_contract_from_str(&raw)
}

pub fn sidecar_requires_gpu_contract_from_str(raw: &str) -> bool {
    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => return false,
    };
    value_has_gpu_manifest(&value)
}

fn value_has_gpu_manifest(value: &serde_json::Value) -> bool {
    let direct_gpu = value.get("gpu").is_some_and(|gpu| !gpu.is_null());
    let sidecar_gpu = value
        .get("compile_manifest")
        .and_then(|manifest| manifest.get("gpu"))
        .is_some_and(|gpu| !gpu.is_null());
    direct_gpu || sidecar_gpu
}

pub fn module_requires_gpu_contract(name: &str) -> bool {
    matches!(
        ModuleSlot::from_str(name).unwrap_or(ModuleSlot::Main),
        ModuleSlot::Core | ModuleSlot::Main
    )
}

#[derive(Debug, Clone, Copy, Default)]
pub struct GpuHostContractPresence {
    pub device_descriptor: bool,
    pub device_on_load: bool,
    pub device_save_size: bool,
    pub device_save_write: bool,
    pub device_kernel_sig_hash: bool,
}

impl GpuHostContractPresence {
    unsafe fn probe(lib: &Library) -> Self {
        type DeviceDescriptorFn = unsafe extern "C" fn() -> *const c_void;
        type DeviceOnLoadFn = unsafe extern "C" fn(*const u8, usize);
        type DeviceSaveSizeFn = unsafe extern "C" fn() -> usize;
        type DeviceSaveWriteFn = unsafe extern "C" fn(*mut u8, usize);
        type DeviceKernelSigHashFn = unsafe extern "C" fn(*const i8) -> u64;

        Self {
            device_descriptor: lib
                .get::<Symbol<DeviceDescriptorFn>>(b"device_descriptor")
                .is_ok(),
            device_on_load: lib.get::<Symbol<DeviceOnLoadFn>>(b"device_on_load").is_ok(),
            device_save_size: lib
                .get::<Symbol<DeviceSaveSizeFn>>(b"device_save_size")
                .is_ok(),
            device_save_write: lib
                .get::<Symbol<DeviceSaveWriteFn>>(b"device_save_write")
                .is_ok(),
            device_kernel_sig_hash: lib
                .get::<Symbol<DeviceKernelSigHashFn>>(b"device_kernel_sig_hash")
                .is_ok(),
        }
    }

    pub fn has_required_contract(&self) -> bool {
        self.device_descriptor && self.device_on_load && self.device_kernel_sig_hash
    }

    pub fn has_state_serialization(&self) -> bool {
        GPU_HOST_CONTRACT_STATE_SYMBOLS
            .iter()
            .all(|symbol| match *symbol {
                "device_save_size" => self.device_save_size,
                "device_save_write" => self.device_save_write,
                _ => false,
            })
    }
}

pub fn missing_gpu_host_contract_symbols(
    presence: &GpuHostContractPresence,
    required: bool,
) -> Vec<&'static str> {
    if !required {
        return Vec::new();
    }

    GPU_HOST_CONTRACT_REQUIRED_SYMBOLS
        .iter()
        .copied()
        .filter(|symbol| match *symbol {
            "device_descriptor" => !presence.device_descriptor,
            "device_on_load" => !presence.device_on_load,
            "device_kernel_sig_hash" => !presence.device_kernel_sig_hash,
            _ => false,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_contract_is_required_only_for_state_owning_host_modules() {
        assert!(module_requires_gpu_contract("core"));
        assert!(module_requires_gpu_contract("main"));
        assert!(module_requires_gpu_contract("unknown-slot"));
        assert!(!module_requires_gpu_contract("gui"));
    }

    #[test]
    fn sidecar_gpu_manifest_detection_accepts_sidecar_and_manifest_shapes() {
        assert!(sidecar_requires_gpu_contract_from_str(
            r#"{"compile_manifest":{"gpu":{"vendor":"cuda"}}}"#
        ));
        assert!(sidecar_requires_gpu_contract_from_str(
            r#"{"gpu":{"vendor":"rocm"}}"#
        ));
        assert!(!sidecar_requires_gpu_contract_from_str(
            r#"{"compile_manifest":{"compiler":"clang++"}}"#
        ));
        assert!(!sidecar_requires_gpu_contract_from_str(
            r#"{"compile_manifest":{"gpu":null}}"#
        ));
        assert!(!sidecar_requires_gpu_contract_from_str("not-json"));
    }

    #[test]
    fn missing_gpu_host_contract_symbols_reports_only_required_callbacks() {
        let presence = GpuHostContractPresence {
            device_descriptor: true,
            device_on_load: false,
            device_save_size: true,
            device_save_write: false,
            device_kernel_sig_hash: true,
        };
        assert_eq!(
            missing_gpu_host_contract_symbols(&presence, true),
            vec!["device_on_load"]
        );
        assert!(missing_gpu_host_contract_symbols(&presence, false).is_empty());
    }

    #[test]
    fn gpu_state_serialization_requires_size_and_write() {
        let partial = GpuHostContractPresence {
            device_save_size: true,
            ..Default::default()
        };
        assert!(!partial.has_state_serialization());

        let complete = GpuHostContractPresence {
            device_save_size: true,
            device_save_write: true,
            ..Default::default()
        };
        assert!(complete.has_state_serialization());
    }
}
