use libloading::{Library, Symbol};
use std::collections::HashSet;
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
    pub resolved_contract: Option<ResolvedModuleContract>,
    pub effective_contract: Option<EffectiveModuleContract>,
    pub effective_contract_error: Option<EffectiveModuleContractError>,
    pub has_gpu_contract: bool,
    pub has_gpu_state_serialization: bool,
    pub missing_gpu_contract_symbols: Vec<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectiveModuleContract {
    Core,
    Gui,
    Legacy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleAbi {
    CorePrefixed,
    GuiPrefixed,
    GuiLegacy,
    Legacy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedModuleContract {
    pub role: EffectiveModuleContract,
    pub lifecycle_abi: LifecycleAbi,
}

impl EffectiveModuleContract {
    pub fn owns_gpu_host_contract(self) -> bool {
        matches!(self, Self::Core | Self::Legacy)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectiveModuleContractError {
    Empty,
    Incomplete,
    Ambiguous,
}

/// Lifecycle exports observed in a candidate module.
///
/// This is deliberately data-only so classification can be tested without a
/// dynamic library. Artifact names and metadata are not inputs to the result.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LifecycleExportPresence {
    pub core_on_load: bool,
    pub core_on_update: bool,
    pub core_get_api: bool,
    pub gui_on_load: bool,
    pub gui_on_render: bool,
    pub on_load: bool,
    pub entrypoint: bool,
    pub on_update: bool,
    pub gui_render: bool,
    pub on_render: bool,
}

impl LifecycleExportPresence {
    pub fn from_symbol_names<I, S>(symbols: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let symbols = symbols
            .into_iter()
            .map(|symbol| symbol.as_ref().to_string())
            .collect::<HashSet<_>>();
        let has = |name: &str| symbols.contains(name);

        Self {
            core_on_load: has("core_on_load"),
            core_on_update: has("core_on_update"),
            core_get_api: has("core_get_api"),
            gui_on_load: has("gui_on_load"),
            gui_on_render: has("gui_on_render"),
            on_load: has("on_load"),
            entrypoint: has("entrypoint"),
            on_update: has("on_update"),
            gui_render: has("gui_render"),
            on_render: has("on_render"),
        }
    }

    unsafe fn probe(lib: &Library) -> Self {
        type CoreLoadFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
        type CoreUpdateFn = unsafe extern "C" fn(*mut c_void, f64);
        type CoreGetApiFn = unsafe extern "C" fn() -> *mut c_void;
        type GuiLoadFn = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void;
        type RenderFn = unsafe extern "C" fn(*mut c_void);
        type LegacyLoadFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
        type LegacyEntrypointFn = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
        type LegacyUpdateFn = unsafe extern "C" fn(*mut c_void, f64);

        Self {
            core_on_load: lib.get::<Symbol<CoreLoadFn>>(b"core_on_load").is_ok(),
            core_on_update: lib.get::<Symbol<CoreUpdateFn>>(b"core_on_update").is_ok(),
            core_get_api: lib.get::<Symbol<CoreGetApiFn>>(b"core_get_api").is_ok(),
            gui_on_load: lib.get::<Symbol<GuiLoadFn>>(b"gui_on_load").is_ok(),
            gui_on_render: lib.get::<Symbol<RenderFn>>(b"gui_on_render").is_ok(),
            on_load: lib.get::<Symbol<LegacyLoadFn>>(b"on_load").is_ok(),
            entrypoint: lib.get::<Symbol<LegacyEntrypointFn>>(b"entrypoint").is_ok(),
            on_update: lib.get::<Symbol<LegacyUpdateFn>>(b"on_update").is_ok(),
            gui_render: lib.get::<Symbol<RenderFn>>(b"gui_render").is_ok(),
            on_render: lib.get::<Symbol<RenderFn>>(b"on_render").is_ok(),
        }
    }
}

pub fn classify_resolved_module_contract(
    exports: LifecycleExportPresence,
) -> Result<ResolvedModuleContract, EffectiveModuleContractError> {
    let core_observed = exports.core_on_load || exports.core_on_update || exports.core_get_api;
    let core_complete = exports.core_on_load && exports.core_on_update && exports.core_get_api;

    let gui_observed = exports.gui_on_load || exports.gui_on_render;
    let gui_complete = exports.gui_on_load && exports.gui_on_render;

    let legacy_gui_observed = exports.gui_render || exports.on_render;
    let legacy_gui_complete = (exports.on_load || exports.entrypoint) && legacy_gui_observed;

    // `on_load` is shared by the two legacy sets. It only identifies the
    // update lifecycle when paired with an update-only export; otherwise a
    // bare load export remains an incomplete legacy contract.
    let legacy_observed =
        exports.on_update || ((exports.on_load || exports.entrypoint) && !legacy_gui_observed);
    let legacy_complete = (exports.on_load || exports.entrypoint) && exports.on_update;

    let observed = [
        (
            core_observed,
            core_complete,
            ResolvedModuleContract {
                role: EffectiveModuleContract::Core,
                lifecycle_abi: LifecycleAbi::CorePrefixed,
            },
        ),
        (
            gui_observed,
            gui_complete,
            ResolvedModuleContract {
                role: EffectiveModuleContract::Gui,
                lifecycle_abi: LifecycleAbi::GuiPrefixed,
            },
        ),
        (
            legacy_gui_observed,
            legacy_gui_complete,
            ResolvedModuleContract {
                role: EffectiveModuleContract::Gui,
                lifecycle_abi: LifecycleAbi::GuiLegacy,
            },
        ),
        (
            legacy_observed,
            legacy_complete,
            ResolvedModuleContract {
                role: EffectiveModuleContract::Legacy,
                lifecycle_abi: LifecycleAbi::Legacy,
            },
        ),
    ];

    if !observed.iter().any(|(present, _, _)| *present) {
        return Err(EffectiveModuleContractError::Empty);
    }
    if observed
        .iter()
        .any(|(present, complete, _)| *present && !*complete)
    {
        return Err(EffectiveModuleContractError::Incomplete);
    }

    let complete_contracts: Vec<_> = observed
        .iter()
        .filter_map(|(present, complete, contract)| (*present && *complete).then_some(*contract))
        .collect();
    if complete_contracts.len() != 1 {
        return Err(EffectiveModuleContractError::Ambiguous);
    }

    Ok(complete_contracts[0])
}

pub fn classify_effective_module_contract(
    exports: LifecycleExportPresence,
) -> Result<EffectiveModuleContract, EffectiveModuleContractError> {
    classify_resolved_module_contract(exports).map(|contract| contract.role)
}

pub unsafe fn validate_symbols(new_lib: &Library, _name: &str) -> ValidationInfo {
    validate_symbols_with_gpu_contract(new_lib, _name, false)
}

pub unsafe fn validate_symbols_with_gpu_contract(
    new_lib: &Library,
    _name: &str,
    require_gpu_contract: bool,
) -> ValidationInfo {
    let contract_result =
        classify_resolved_module_contract(unsafe { LifecycleExportPresence::probe(new_lib) });
    let (resolved_contract, effective_contract, effective_contract_error) = match contract_result {
        Ok(contract) => (Some(contract), Some(contract.role), None),
        Err(error) => (None, None, Some(error)),
    };
    let mut has_required_symbols = effective_contract.is_some();
    let module_abi_version = unsafe { module_abi_version(new_lib, resolved_contract) };

    let gpu_presence = unsafe { GpuHostContractPresence::probe(new_lib) };
    let gpu_contract_required = require_gpu_contract
        && effective_contract.is_some_and(EffectiveModuleContract::owns_gpu_host_contract);
    let missing_gpu_contract_symbols =
        missing_gpu_host_contract_symbols(&gpu_presence, gpu_contract_required);
    if !missing_gpu_contract_symbols.is_empty() {
        has_required_symbols = false;
    }

    ValidationInfo {
        has_required_symbols,
        module_abi_version,
        resolved_contract,
        effective_contract,
        effective_contract_error,
        has_gpu_contract: gpu_presence.has_required_contract(),
        has_gpu_state_serialization: gpu_presence.has_state_serialization(),
        missing_gpu_contract_symbols,
    }
}

unsafe fn module_abi_version(
    lib: &Library,
    resolved_contract: Option<ResolvedModuleContract>,
) -> u32 {
    let Some(symbol) = resolved_contract.and_then(module_abi_version_symbol) else {
        return 0;
    };
    let get_abi: Result<Symbol<unsafe extern "C" fn() -> c_uint>, _> = lib.get(symbol);
    get_abi.map_or(0, |f| f())
}

fn module_abi_version_symbol(contract: ResolvedModuleContract) -> Option<&'static [u8]> {
    match contract.lifecycle_abi {
        LifecycleAbi::CorePrefixed => Some(b"core_get_abi_version"),
        LifecycleAbi::GuiPrefixed => Some(b"gui_get_abi_version"),
        LifecycleAbi::GuiLegacy | LifecycleAbi::Legacy => None,
    }
}

pub fn workspace_requires_gpu_contract() -> bool {
    // Sidecars are policy hints only. They never select an ABI family or
    // contribute export evidence to the accepted effective contract.
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

pub fn module_requires_gpu_contract(contract: EffectiveModuleContract) -> bool {
    contract.owns_gpu_host_contract()
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
    fn classifier_accepts_each_complete_existing_lifecycle_set() {
        let cases = [
            (
                LifecycleExportPresence {
                    core_on_load: true,
                    core_on_update: true,
                    core_get_api: true,
                    ..Default::default()
                },
                EffectiveModuleContract::Core,
            ),
            (
                LifecycleExportPresence {
                    gui_on_load: true,
                    gui_on_render: true,
                    ..Default::default()
                },
                EffectiveModuleContract::Gui,
            ),
            (
                LifecycleExportPresence {
                    on_load: true,
                    gui_render: true,
                    ..Default::default()
                },
                EffectiveModuleContract::Gui,
            ),
            (
                LifecycleExportPresence {
                    on_load: true,
                    on_render: true,
                    ..Default::default()
                },
                EffectiveModuleContract::Gui,
            ),
            (
                LifecycleExportPresence {
                    entrypoint: true,
                    on_render: true,
                    ..Default::default()
                },
                EffectiveModuleContract::Gui,
            ),
            (
                LifecycleExportPresence {
                    on_load: true,
                    on_update: true,
                    ..Default::default()
                },
                EffectiveModuleContract::Legacy,
            ),
            (
                LifecycleExportPresence {
                    entrypoint: true,
                    on_update: true,
                    ..Default::default()
                },
                EffectiveModuleContract::Legacy,
            ),
        ];

        for (exports, expected) in cases {
            assert_eq!(classify_effective_module_contract(exports), Ok(expected));
        }
    }

    #[test]
    fn resolved_contract_preserves_the_observed_lifecycle_abi() {
        let cases = [
            (
                LifecycleExportPresence {
                    core_on_load: true,
                    core_on_update: true,
                    core_get_api: true,
                    ..Default::default()
                },
                ResolvedModuleContract {
                    role: EffectiveModuleContract::Core,
                    lifecycle_abi: LifecycleAbi::CorePrefixed,
                },
            ),
            (
                LifecycleExportPresence {
                    gui_on_load: true,
                    gui_on_render: true,
                    ..Default::default()
                },
                ResolvedModuleContract {
                    role: EffectiveModuleContract::Gui,
                    lifecycle_abi: LifecycleAbi::GuiPrefixed,
                },
            ),
            (
                LifecycleExportPresence {
                    on_load: true,
                    gui_render: true,
                    ..Default::default()
                },
                ResolvedModuleContract {
                    role: EffectiveModuleContract::Gui,
                    lifecycle_abi: LifecycleAbi::GuiLegacy,
                },
            ),
            (
                LifecycleExportPresence {
                    entrypoint: true,
                    on_render: true,
                    ..Default::default()
                },
                ResolvedModuleContract {
                    role: EffectiveModuleContract::Gui,
                    lifecycle_abi: LifecycleAbi::GuiLegacy,
                },
            ),
            (
                LifecycleExportPresence {
                    entrypoint: true,
                    on_update: true,
                    ..Default::default()
                },
                ResolvedModuleContract {
                    role: EffectiveModuleContract::Legacy,
                    lifecycle_abi: LifecycleAbi::Legacy,
                },
            ),
        ];

        for (exports, expected) in cases {
            assert_eq!(classify_resolved_module_contract(exports), Ok(expected));
            assert_eq!(
                classify_effective_module_contract(exports),
                Ok(expected.role)
            );
        }
    }

    #[test]
    fn observed_symbol_tables_feed_the_same_fail_closed_classifier() {
        let arbitrary_core_exports = [
            "tenant_specific_symbol",
            "core_on_load",
            "core_on_update",
            "core_get_api",
            "another_unrelated_export",
        ];
        assert_eq!(
            classify_resolved_module_contract(LifecycleExportPresence::from_symbol_names(
                arbitrary_core_exports
            )),
            Ok(ResolvedModuleContract {
                role: EffectiveModuleContract::Core,
                lifecycle_abi: LifecycleAbi::CorePrefixed,
            })
        );

        let legacy_render_exports = ["entrypoint", "on_render", "on_render"];
        assert_eq!(
            classify_resolved_module_contract(LifecycleExportPresence::from_symbol_names(
                legacy_render_exports
            )),
            Ok(ResolvedModuleContract {
                role: EffectiveModuleContract::Gui,
                lifecycle_abi: LifecycleAbi::GuiLegacy,
            })
        );

        let mixed_exports = [
            "core_on_load",
            "core_on_update",
            "core_get_api",
            "gui_on_load",
            "gui_on_render",
        ];
        assert_eq!(
            classify_resolved_module_contract(LifecycleExportPresence::from_symbol_names(
                mixed_exports
            )),
            Err(EffectiveModuleContractError::Ambiguous)
        );

        assert_eq!(
            LifecycleExportPresence::from_symbol_names(["unrelated_export"]),
            LifecycleExportPresence::default()
        );
    }

    #[test]
    fn resolved_contract_rejects_prefixed_and_legacy_gui_abi_mixtures() {
        let exports = LifecycleExportPresence {
            gui_on_load: true,
            gui_on_render: true,
            on_load: true,
            on_render: true,
            ..Default::default()
        };

        assert_eq!(
            classify_resolved_module_contract(exports),
            Err(EffectiveModuleContractError::Ambiguous)
        );
    }

    #[test]
    fn abi_version_symbol_is_selected_by_observed_lifecycle_abi() {
        let contract = |role, lifecycle_abi| ResolvedModuleContract {
            role,
            lifecycle_abi,
        };

        assert_eq!(
            module_abi_version_symbol(contract(
                EffectiveModuleContract::Core,
                LifecycleAbi::CorePrefixed,
            )),
            Some(b"core_get_abi_version".as_slice())
        );
        assert_eq!(
            module_abi_version_symbol(contract(
                EffectiveModuleContract::Gui,
                LifecycleAbi::GuiPrefixed,
            )),
            Some(b"gui_get_abi_version".as_slice())
        );
        assert_eq!(
            module_abi_version_symbol(contract(
                EffectiveModuleContract::Gui,
                LifecycleAbi::GuiLegacy,
            )),
            None
        );
        assert_eq!(
            module_abi_version_symbol(contract(
                EffectiveModuleContract::Legacy,
                LifecycleAbi::Legacy,
            )),
            None
        );
    }

    #[test]
    fn arbitrary_metadata_never_changes_export_based_classification() {
        let exports = LifecycleExportPresence {
            core_on_load: true,
            core_on_update: true,
            core_get_api: true,
            ..Default::default()
        };

        // The classifier intentionally has no name, project, backend, or
        // language parameter. These opaque metadata values cannot select a
        // different result from the same observed exports.
        for _metadata in [
            "core",
            "gui",
            "main",
            "unfamiliar-engine",
            "project-42",
            "rocm",
            "typescript",
        ] {
            assert_eq!(
                classify_effective_module_contract(exports),
                Ok(EffectiveModuleContract::Core)
            );
        }
    }

    #[test]
    fn classifier_rejects_empty_and_every_incomplete_lifecycle_set() {
        let cases = [
            (
                LifecycleExportPresence::default(),
                EffectiveModuleContractError::Empty,
            ),
            (
                LifecycleExportPresence {
                    core_on_load: true,
                    core_on_update: true,
                    ..Default::default()
                },
                EffectiveModuleContractError::Incomplete,
            ),
            (
                LifecycleExportPresence {
                    gui_on_load: true,
                    ..Default::default()
                },
                EffectiveModuleContractError::Incomplete,
            ),
            (
                LifecycleExportPresence {
                    on_load: true,
                    ..Default::default()
                },
                EffectiveModuleContractError::Incomplete,
            ),
            (
                LifecycleExportPresence {
                    entrypoint: true,
                    ..Default::default()
                },
                EffectiveModuleContractError::Incomplete,
            ),
            (
                LifecycleExportPresence {
                    on_update: true,
                    ..Default::default()
                },
                EffectiveModuleContractError::Incomplete,
            ),
            (
                LifecycleExportPresence {
                    gui_render: true,
                    ..Default::default()
                },
                EffectiveModuleContractError::Incomplete,
            ),
            (
                LifecycleExportPresence {
                    on_render: true,
                    ..Default::default()
                },
                EffectiveModuleContractError::Incomplete,
            ),
        ];

        for (exports, expected) in cases {
            assert_eq!(classify_effective_module_contract(exports), Err(expected));
        }
    }

    #[test]
    fn classifier_fails_closed_for_conflicting_or_mixed_lifecycle_sets() {
        let complete_core_and_gui = LifecycleExportPresence {
            core_on_load: true,
            core_on_update: true,
            core_get_api: true,
            gui_on_load: true,
            gui_on_render: true,
            ..Default::default()
        };
        assert_eq!(
            classify_effective_module_contract(complete_core_and_gui),
            Err(EffectiveModuleContractError::Ambiguous)
        );

        let two_gui_abi_sets = LifecycleExportPresence {
            gui_on_load: true,
            gui_on_render: true,
            on_load: true,
            gui_render: true,
            ..Default::default()
        };
        assert_eq!(
            classify_effective_module_contract(two_gui_abi_sets),
            Err(EffectiveModuleContractError::Ambiguous)
        );

        let complete_core_with_partial_legacy = LifecycleExportPresence {
            core_on_load: true,
            core_on_update: true,
            core_get_api: true,
            entrypoint: true,
            ..Default::default()
        };
        assert_eq!(
            classify_effective_module_contract(complete_core_with_partial_legacy),
            Err(EffectiveModuleContractError::Incomplete)
        );

        let legacy_update_and_legacy_gui = LifecycleExportPresence {
            on_load: true,
            on_update: true,
            gui_render: true,
            ..Default::default()
        };
        assert_eq!(
            classify_effective_module_contract(legacy_update_and_legacy_gui),
            Err(EffectiveModuleContractError::Ambiguous)
        );
    }

    #[test]
    fn classifier_is_fail_closed_for_every_lifecycle_export_combination() {
        const CORE_LOAD: u16 = 1 << 0;
        const CORE_UPDATE: u16 = 1 << 1;
        const CORE_API: u16 = 1 << 2;
        const GUI_LOAD: u16 = 1 << 3;
        const GUI_RENDER: u16 = 1 << 4;
        const LOAD: u16 = 1 << 5;
        const ENTRYPOINT: u16 = 1 << 6;
        const UPDATE: u16 = 1 << 7;
        const LEGACY_GUI_RENDER: u16 = 1 << 8;
        const LEGACY_ON_RENDER: u16 = 1 << 9;

        let core = CORE_LOAD | CORE_UPDATE | CORE_API;
        let gui = GUI_LOAD | GUI_RENDER;
        for bits in 0..(1 << 10) {
            let exports = LifecycleExportPresence {
                core_on_load: bits & CORE_LOAD != 0,
                core_on_update: bits & CORE_UPDATE != 0,
                core_get_api: bits & CORE_API != 0,
                gui_on_load: bits & GUI_LOAD != 0,
                gui_on_render: bits & GUI_RENDER != 0,
                on_load: bits & LOAD != 0,
                entrypoint: bits & ENTRYPOINT != 0,
                on_update: bits & UPDATE != 0,
                gui_render: bits & LEGACY_GUI_RENDER != 0,
                on_render: bits & LEGACY_ON_RENDER != 0,
            };

            let expected = if bits == core {
                Some(EffectiveModuleContract::Core)
            } else if bits == gui {
                Some(EffectiveModuleContract::Gui)
            } else if bits & !(LOAD | ENTRYPOINT | LEGACY_GUI_RENDER | LEGACY_ON_RENDER) == 0
                && bits & (LOAD | ENTRYPOINT) != 0
                && bits & (LEGACY_GUI_RENDER | LEGACY_ON_RENDER) != 0
            {
                Some(EffectiveModuleContract::Gui)
            } else if bits & !(LOAD | ENTRYPOINT | UPDATE) == 0
                && bits & UPDATE != 0
                && bits & (LOAD | ENTRYPOINT) != 0
            {
                Some(EffectiveModuleContract::Legacy)
            } else {
                None
            };

            match expected {
                Some(contract) => {
                    assert_eq!(classify_effective_module_contract(exports), Ok(contract))
                }
                None => assert!(classify_effective_module_contract(exports).is_err()),
            }
        }
    }

    #[test]
    fn gpu_host_contract_ownership_comes_from_the_effective_contract() {
        assert!(module_requires_gpu_contract(EffectiveModuleContract::Core));
        assert!(module_requires_gpu_contract(
            EffectiveModuleContract::Legacy
        ));
        assert!(!module_requires_gpu_contract(EffectiveModuleContract::Gui));
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
    fn manifests_are_policy_hints_not_contract_evidence() {
        assert!(sidecar_requires_gpu_contract_from_str(
            r#"{"gpu":{"backend":"any-opaque-metadata"}}"#
        ));
        assert_eq!(
            classify_effective_module_contract(LifecycleExportPresence::default()),
            Err(EffectiveModuleContractError::Empty)
        );
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
