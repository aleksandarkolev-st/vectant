use crate::hmr::orchestrator::{HmrOrchestrator, SavedState};
use crate::runtime::capability::{detect_capabilities, HmrCapability, HmrStatus};
use crate::runtime::legacy_module_state::{AppState, ModuleState};
use crate::runtime::loader::{LoadResult, ModuleLoader};
use crate::runtime::plugin_contract::{
    ModuleSlot, CORE_STATE_MAGIC, GUI_STATE_MAGIC, SYNTHI_CORE_ABI_VERSION, SYNTHI_GUI_ABI_VERSION,
};
use libloading::{Library, Symbol};
use std::collections::HashMap;
use std::ffi::{c_void, CString};

use crate::runtime::hot_reload::v2::{get_module_abi_version, validate_state_magic};
use crate::runtime::runner::validator;

// Host KV
use crate::infra::host_kv::{
    module_slot_to_u32, read_schema_table, HostKvApiV1, HostKvSchemaEvent,
    SynthiHostContextV1, KV_STORE,
};

pub unsafe fn process_load_command(
    name: &str,
    path: &str,
    modules: &mut HashMap<String, Library>,
    loaded_paths: &mut HashMap<String, String>,
    module_states: &mut HashMap<String, ModuleState>,
    app_state: &mut AppState,
    module_loader: &mut ModuleLoader,
    orchestrator: &mut HmrOrchestrator,
    session_id: &Option<String>,
    session_id_cstring: &Option<CString>,
    kv_api: &HostKvApiV1,
    loader_enabled: bool,
    _supervisor_enabled: bool, // Passed but maybe not used in load logic?
) {
    eprintln!("[Runner] Loading module '{}' from {}", name, path);

    if let Some(current_path) = loaded_paths.get(name) {
        if current_path == path {
            eprintln!(
                "[Runner] Module '{}' already loaded from {}. Skipping.",
                name, path
            );
            return;
        }
    }

    // Define module_slot early for use in all scopes
    let module_slot = ModuleSlot::from_str(name).unwrap_or(ModuleSlot::Main);

    // ============================================================
    // ATOMIC-SWAP HMR: Zero-flicker hot module replacement
    // ============================================================
    // Strategy:
    // 1. Validate ABI compatibility (if loader enabled)
    // 2. Load NEW library while OLD is still active (old keeps rendering)
    // 3. Save state from OLD module
    // 4. Pre-initialize NEW module with saved state + graphics
    // 5. ATOMIC SWAP: Replace module reference in single operation
    // 6. Defer OLD module cleanup (on_unload + drop) until after swap
    // ============================================================

    // ============================================================
    // PRE-LOAD ABI VALIDATION (Optional, enabled via env var)
    // ============================================================
    // Use ModuleLoader to check ABI compatibility before loading.
    // This catches symbol mismatches and ABI version errors early.
    if loader_enabled {
        let slot = ModuleSlot::from_str(name);
        if let Some(_slot) = slot {
            // Generate a simple hash for tracking (real hash from file)
            let content_hash = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

            match module_loader.load(
                std::path::Path::new(path),
                module_slot,
                content_hash,
            ) {
                LoadResult::Success {
                    module_id,
                    abi_version,
                } => {
                    eprintln!(
                        "[Runner] [Loader] ABI validation passed: {} v{}",
                        module_id, abi_version
                    );
                }
                LoadResult::AbiMismatch {
                    expected,
                    found,
                    details,
                } => {
                    eprintln!(
                        "[Runner] [Loader] ABI MISMATCH: expected v{}, found v{}. {}",
                        expected, found, details
                    );
                    eprintln!("[Runner] [Loader] Continuing with legacy loading...");
                }
                LoadResult::MissingSymbols { symbols } => {
                    eprintln!("[Runner] [Loader] WARNING: Missing symbols: {:?}", symbols);
                    eprintln!("[Runner] [Loader] Continuing with legacy loading...");
                }
                LoadResult::LoadError { reason } => {
                    eprintln!("[Runner] [Loader] Load validation error: {}", reason);
                    // Don't fail - let legacy loader try
                }
            }
            // Unload from module_loader since we'll use legacy loading
            // module_loader.unload(slot);
            // KEEP LOADED in module_loader to enable fingerprint comparison on next reload!
            // Since we use unique filenames per build, holding the handle is safe.
        }
    }

    eprintln!(
        "[Runner] [HMR] Phase 1: Loading new library (old still active): {}",
        path
    );
    #[cfg(unix)]
    let lib_result = {
        use libloading::os::unix::{Library, RTLD_LOCAL, RTLD_NOW};
        Library::open(Some(path), RTLD_NOW | RTLD_LOCAL).map(|l| libloading::Library::from(l))
    };
    #[cfg(not(unix))]
    let lib_result = Library::new(path);

    match lib_result {
        Ok(new_lib) => {
            eprintln!("[Runner] [HMR] New library opened. Validating symbols...");

            // ============================================================
            // SYMBOL VALIDATION: Check for new prefixed or legacy symbols
            // ============================================================
            // New ABI v1.0: core_on_load, gui_on_load, etc.
            // Legacy: on_load, entrypoint, on_update, etc.
            // ============================================================

            let slot = ModuleSlot::from_str(name);
            let info = validator::validate_symbols(&new_lib, name);
            let has_required_symbols = info.has_required_symbols;
            let module_abi_version = info.module_abi_version;
            if module_abi_version > 0 && (name == "core" || name == "gui") {
                eprintln!(
                    "[Runner] [HMR] {} reports ABI version: {}",
                    name, module_abi_version
                );
            }

            if !has_required_symbols {
                eprintln!("[Runner] [HMR] ERROR: Module '{}' missing required symbols. Aborting HMR (old module continues).", name);
                eprintln!("[Runner] [HMR] Expected: {} = core_on_load+core_on_update | gui = gui_on_load+gui_on_render | main = on_load+on_update", name);

                // Send structured HMR rejection event
                let status = HmrStatus::rejected(name, "Missing required symbols");
                eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                return;
            }

            // ============================================================
            // EXPORT-BASED CAPABILITY DETECTION
            // ============================================================
            // Use the capability module to get detailed HMR capability info
            // ============================================================
            let capability_report = detect_capabilities(std::path::Path::new(path));
            let hmr_capability = capability_report
                .as_ref()
                .map(|r| r.hmr_capability)
                .unwrap_or(HmrCapability::Partial);

            let state_will_preserve = hmr_capability.preserves_state();
            eprintln!(
                "[Runner] [HMR] Capability: {:?}, state_preserve={}",
                hmr_capability, state_will_preserve
            );

            // Check ABI version compatibility (if reported)
            if module_abi_version > 0 {
                let expected_abi = match slot {
                    Some(ModuleSlot::Core) => SYNTHI_CORE_ABI_VERSION,
                    Some(ModuleSlot::Gui) => SYNTHI_GUI_ABI_VERSION,
                    _ => 1,
                };
                if module_abi_version > expected_abi {
                    eprintln!("[Runner] [HMR] WARNING: Module ABI version {} > runner supported {}. May have issues.", module_abi_version, expected_abi);
                }
            }

            let is_reload = modules.contains_key(name) || !modules.is_empty();
            eprintln!(
                "[Runner] [HMR] is_reload={} for module '{}', modules.keys={:?}",
                is_reload,
                name,
                modules.keys().collect::<Vec<_>>()
            );

            // Collect modules to remove for mode switching (but don't remove yet!)
            let mut deferred_unloads: Vec<(String, Library)> = Vec::new();

            if name == "main" {
                // Switching to non-split mode: will unload core and gui AFTER swap
                let modules_to_remove: Vec<String> =
                    modules.keys().filter(|k| *k != "main").cloned().collect();
                for old_name in modules_to_remove {
                    if let Some(old_lib) = modules.remove(&old_name) {
                        eprintln!(
                            "[Runner] [HMR] Deferring unload of '{}' (mode switch to main)",
                            old_name
                        );
                        loaded_paths.remove(&old_name);
                        deferred_unloads.push((old_name, old_lib));
                    }
                }
            } else if name == "core" || name == "gui" {
                // Switching to split mode: will unload main AFTER swap
                if let Some(old_lib) = modules.remove("main") {
                    eprintln!("[Runner] [HMR] Deferring unload of 'main' (mode switch to split)");
                    loaded_paths.remove("main");
                    deferred_unloads.push(("main".to_string(), old_lib));
                }
            }

            // ============================================================
            // Phase 2: Save state from OLD module (via Orchestrator)
            // ============================================================
            // The orchestrator handles:
            // - Binary vs JSON serialization (binary preferred for speed)
            // - Memory management (free C-allocated buffers)
            // - Statistics tracking
            // ============================================================
            let mut saved_state: Option<SavedState> = None;
            let mut old_lib_for_cleanup: Option<Library> = None;

            // Get the module-specific state (not the shared app_state.raw)
            let module_prev_state = module_states
                .get(name)
                .map(|s| s.state_ptr)
                .unwrap_or(std::ptr::null_mut());

            if let Some(old_lib) = modules.remove(name) {
                eprintln!(
                    "[Runner] [HMR] Phase 2: Saving state via orchestrator for '{}'...",
                    name
                );

                // Save state BEFORE any cleanup - use module-specific state
                let state_to_save = if !module_prev_state.is_null() {
                    module_prev_state
                } else {
                    app_state.raw
                };

                // Use orchestrator for unified save (binary-first with JSON fallback)
                saved_state = Some(orchestrator.save_module_state(
                    module_slot,
                    &old_lib,
                    state_to_save,
                ));

                if let Some(ref ss) = saved_state {
                    if ss.was_binary {
                        eprintln!(
                            "[Runner] [HMR] State saved via BINARY path ({} bytes)",
                            ss.binary.as_ref().map(|b| b.len()).unwrap_or(0)
                        );
                    } else if ss.json.is_some() {
                        eprintln!("[Runner] [HMR] State saved via JSON path");
                    }
                }

                loaded_paths.remove(name);
                // Store old lib for deferred cleanup
                old_lib_for_cleanup = Some(old_lib);
            }

            // ============================================================
            // Phase 3: Pre-initialize NEW module (prepare new state)
            // ============================================================
            // INDEPENDENT SWAP: GUI module gets its own state.
            // For "gui" module, we also pass the CoreAPI pointer
            // so GUI can access core state safely.
            // ============================================================
            eprintln!(
                "[Runner] [HMR] Phase 3: Pre-initializing new module '{}'...",
                name
            );

            // Use passed app_state.renderer as win_ptr
            let win_ptr = app_state.renderer;
            // NOTE: On non-linux this might be null.

            // Start with module's previous state or null for fresh init
            let mut new_state: *mut c_void = module_prev_state;
            let mut core_api_ptr: *mut c_void = std::ptr::null_mut();

            // ============================================================
            // SCHEMA HASH VERIFICATION (STRICT ABI CHECK)
            // ============================================================
            // Before reusing the raw state pointer, we MUST verify that the
            // struct layout hasn't changed. We use a hash provided by the
            // compiler/plugin for this.
            // ============================================================
            let old_schema_hash = module_states.get(name).map(|s| s.schema_hash).unwrap_or(0);
            let mut new_schema_hash: u64 = 0;

            let get_schema_hash: Result<Symbol<unsafe extern "C" fn() -> u64>, _> =
                if name == "core" {
                    new_lib.get(b"core_get_state_schema_hash")
                } else if name == "gui" {
                    new_lib.get(b"gui_get_state_schema_hash")
                } else {
                    Err(libloading::Error::DlSymUnknown)
                }; // Legacy doesn't support this

            if let Ok(f) = get_schema_hash {
                new_schema_hash = f();
                eprintln!(
                    "[Runner] [HMR] Module '{}' schema hash: {:016X}",
                    name, new_schema_hash
                );
            }

            // ============================================================
            // Schema Compatibility Check (via Orchestrator helper)
            // ============================================================
            // The orchestrator checks if the old and new schemas are compatible.
            // If incompatible, we force cold reload (NULL state to on_load).
            // JSON migration can still rescue data by parsing into new layout.
            // ============================================================

            if old_schema_hash != 0 && new_schema_hash != 0 && old_schema_hash != new_schema_hash {
                eprintln!(
                    "[Runner] [HMR] CRITICAL: Schema hash mismatch (Old: {:016X}, New: {:016X})",
                    old_schema_hash, new_schema_hash
                );
                eprintln!(
                    "[Runner] [HMR] Forcing COLD RELOAD - JSON migration will attempt data rescue."
                );

                let status = HmrStatus::rejected(
                    name,
                    &format!(
                        "Schema mismatch (Cold Reload): {:016X} -> {:016X}",
                        old_schema_hash, new_schema_hash
                    ),
                );
                eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                new_state = std::ptr::null_mut();
            } else if new_schema_hash == 0 && old_schema_hash != 0 {
                eprintln!(
                    "[Runner] [HMR] WARNING: New module missing schema hash. Assuming unsafe."
                );

                let status = HmrStatus::rejected(name, "Missing schema hash (Cold Reload)");
                eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                new_state = std::ptr::null_mut();
            }

            // ============================================================
            // State Restoration (via Orchestrator)
            // ============================================================
            // The orchestrator handles:
            // - Binary load (fast path, 10-50x faster)
            // - JSON load with field-level diffing (fallback)
            // - Template generation for migration
            // ============================================================

            if let Some(ref ss) = saved_state {
                // Get template JSON for field-level diffing (if JSON path needed)
                let template_json =
                    orchestrator.get_template_json(module_slot, &new_lib);

                // Use orchestrator to load state
                let loaded = orchestrator.load_module_state(
                    module_slot,
                    &new_lib,
                    ss,
                    template_json.as_deref(),
                );

                if !loaded.state_ptr.is_null() {
                    new_state = loaded.state_ptr;

                    // Report migration results
                    if let Some(ref migration) = loaded.migration_result {
                        let report = format!(
                            "preserved={}, reset={}, new={}",
                            migration.preserved_fields.len(),
                            migration.reset_fields.len(),
                            migration.new_fields.len()
                        );
                        eprintln!("[Runner] [HMR] State migrated via orchestrator: {}", report);

                        let status = HmrStatus::state_migrated(
                            name,
                            migration.preserved_fields.len(),
                            migration.reset_fields.len(),
                            migration.new_fields.len(),
                        );
                        eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                    } else if loaded.was_binary {
                        let status = HmrStatus::state_migrated(name, 0, 0, 0);
                        eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                        eprintln!("[Runner] [HMR] Binary state restored successfully");
                    }
                } else {
                    eprintln!("[Runner] [HMR] Orchestrator load returned NULL - fresh init");
                }
            }

            // Get CoreAPI pointer from core module (for GUI initialization)
            if name == "gui" {
                if let Some(core_lib) = modules.get("core") {
                    let get_api_new: Result<Symbol<unsafe extern "C" fn() -> *mut c_void>, _> =
                        core_lib.get(b"core_get_api");
                    let get_api_legacy: Result<Symbol<unsafe extern "C" fn() -> *mut c_void>, _> =
                        core_lib.get(b"get_core_api");
                    if let Ok(f) = get_api_new.or(get_api_legacy) {
                        core_api_ptr = f();
                        eprintln!(
                            "[Runner] [HMR] Got CoreAPI pointer for GUI: {:p}",
                            core_api_ptr
                        );
                    }
                }
            }

            // ============================================================
            // HOST KV: Read and register schema table BEFORE calling load
            // ============================================================
            // This allows the module to write to KV during on_load
            // ============================================================
            let _module_slot_compiler = to_compiler_slot(module_slot);
            let mut has_host_kv_support = false;

            if let Some(ref sid) = session_id {
                // Read schema table from module
                let schemas = read_schema_table(&new_lib, module_slot);
                has_host_kv_support = !schemas.is_empty();

                if !schemas.is_empty() {
                    eprintln!(
                        "[Runner] [HOST-KV] Module '{}' declares {} namespaces: {:?}",
                        name,
                        schemas.len(),
                        schemas.iter().map(|(ns, _)| ns).collect::<Vec<_>>()
                    );

                    // Register schemas and handle any resets
                    let host_kv_events = KV_STORE.register_schemas(
                        sid,
                        module_slot_to_u32(module_slot),
                        &schemas,
                    );

                    // Emit HMR status for schema events
                    for event in &host_kv_events {
                        match event {
                            HostKvSchemaEvent::SchemaMismatchReset {
                                namespace,
                                old_schema,
                                new_schema,
                            } => {
                                let status = HmrStatus::host_kv_reset_schema(
                                    name,
                                    namespace,
                                    *old_schema,
                                    *new_schema,
                                );
                                eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                            }
                            HostKvSchemaEvent::NamespacePreserved { namespace } => {
                                eprintln!("[Runner] [HOST-KV] Namespace '{}' preserved (schema unchanged)", namespace);
                            }
                            HostKvSchemaEvent::NamespaceRegistered {
                                namespace,
                                schema_id,
                            } => {
                                eprintln!(
                                    "[Runner] [HOST-KV] Namespace '{}' registered (schema={})",
                                    namespace, schema_id
                                );
                            }
                            HostKvSchemaEvent::InvalidNamespace { namespace, reason } => {
                                eprintln!(
                                    "[Runner] [HOST-KV] WARNING: Invalid namespace '{}': {}",
                                    namespace, reason
                                );
                            }
                        }
                    }
                } else {
                    eprintln!(
                        "[Runner] [HOST-KV] Module '{}' does not export schema table",
                        name
                    );
                }
            } else {
                has_host_kv_support = false;
                // Check if module tries to use Host KV without session set
                let schemas = read_schema_table(&new_lib, module_slot);
                if !schemas.is_empty() {
                    eprintln!("[Runner] [HOST-KV] WARNING: Module '{}' exports schema table but no session set! Host KV will not work.", name);
                    eprintln!("[Runner] [HOST-KV] Call 'set_session <session_id>' before loading modules that use Host KV.");
                }
            }

            // ============================================================
            // Initialize module - prefer *_on_load_host if available
            // ============================================================
            match slot {
                Some(ModuleSlot::Core) => {
                    // Try core_on_load_host first
                    let core_load_host: Result<
                        Symbol<unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void>,
                        _,
                    > = new_lib.get(b"core_on_load_host");
                    let core_load: Result<
                        Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>,
                        _,
                    > = new_lib.get(b"core_on_load");
                    let legacy_load: Result<
                        Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>,
                        _,
                    > = new_lib.get(b"on_load");

                    if core_load_host.is_ok()
                        && session_id.is_some()
                        && session_id_cstring.is_some()
                    {
                        let f = core_load_host.unwrap();
                        let sid_cstr = session_id_cstring.as_ref().unwrap();
                        let host_ctx = SynthiHostContextV1::new(
                            kv_api,
                            sid_cstr,
                            module_slot,
                            win_ptr,
                            win_ptr,
                        );
                        eprintln!(
                            "[Runner] [HMR] Calling core_on_load_host with Host KV context..."
                        );
                        new_state = f(new_state, &host_ctx as *const _ as *const c_void);
                    } else if let Ok(f) = core_load {
                        eprintln!("[Runner] [HMR] Calling core_on_load...");
                        new_state = f(new_state, win_ptr);
                    } else if let Ok(f) = legacy_load {
                        eprintln!("[Runner] [HMR] Calling legacy on_load for core...");
                        new_state = f(new_state, win_ptr);
                    }
                    eprintln!(
                        "[Runner] [HMR] Core module initialized. State: {:p}",
                        new_state
                    );
                }
                Some(ModuleSlot::Gui) => {
                    // Try gui_on_load_host first
                    let gui_load_host: Result<
                        Symbol<unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void>,
                        _,
                    > = new_lib.get(b"gui_on_load_host");
                    let gui_load: Result<
                        Symbol<
                            unsafe extern "C" fn(
                                *mut c_void,
                                *mut c_void,
                                *mut c_void,
                            ) -> *mut c_void,
                        >,
                        _,
                    > = new_lib.get(b"gui_on_load");
                    let legacy_load: Result<
                        Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>,
                        _,
                    > = new_lib.get(b"on_load");

                    if gui_load_host.is_ok() && session_id.is_some() && session_id_cstring.is_some()
                    {
                        let f = gui_load_host.unwrap();
                        let sid_cstr = session_id_cstring.as_ref().unwrap();
                        let host_ctx = SynthiHostContextV1::new(
                            kv_api,
                            sid_cstr,
                            module_slot,
                            win_ptr,
                            win_ptr,
                        );
                        eprintln!(
                            "[Runner] [HMR] Calling gui_on_load_host with Host KV context..."
                        );
                        new_state = f(new_state, &host_ctx as *const _ as *const c_void);
                    } else if let Ok(f) = gui_load {
                        eprintln!("[Runner] [HMR] Calling gui_on_load with CoreAPI...");
                        new_state = f(new_state, win_ptr, core_api_ptr);
                    } else if let Ok(f) = legacy_load {
                        eprintln!("[Runner] [HMR] Calling legacy on_load for gui...");
                        new_state = f(new_state, win_ptr);
                    }
                    eprintln!(
                        "[Runner] [HMR] GUI module initialized. State: {:p}",
                        new_state
                    );
                }
                Some(ModuleSlot::Main) | None => {
                    // Try on_load_host first for legacy main module
                    let load_host: Result<
                        Symbol<unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void>,
                        _,
                    > = new_lib.get(b"on_load_host");
                    let legacy_load: Result<
                        Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>,
                        _,
                    > = new_lib.get(b"on_load");
                    let legacy_entry: Result<
                        Symbol<unsafe extern "C" fn(*mut c_void) -> *mut c_void>,
                        _,
                    > = new_lib.get(b"entrypoint");

                    if load_host.is_ok() && session_id.is_some() && session_id_cstring.is_some() {
                        let f = load_host.unwrap();
                        let sid_cstr = session_id_cstring.as_ref().unwrap();
                        let host_ctx = SynthiHostContextV1::new(
                            kv_api,
                            sid_cstr,
                            module_slot,
                            win_ptr,
                            win_ptr,
                        );
                        eprintln!("[Runner] [HMR] Calling on_load_host with Host KV context...");
                        new_state = f(new_state, &host_ctx as *const _ as *const c_void);
                    } else if let Ok(f) = legacy_load {
                        eprintln!("[Runner] [HMR] Calling on_load on main module...");
                        new_state = f(new_state, win_ptr);
                    } else if let Ok(f) = legacy_entry {
                        if !is_reload {
                            eprintln!("[Runner] [HMR] Calling entrypoint (first load only)...");
                            new_state = f(new_state);
                        } else {
                            eprintln!(
                                "[Runner] [HMR] Skipping entrypoint on reload (would block)."
                            );
                        }
                    }
                    eprintln!(
                        "[Runner] [HMR] Main module initialized. State: {:p}",
                        new_state
                    );
                }
            }

            // ============================================================
            // HOST KV: Emit preserved namespaces status
            // ============================================================
            if has_host_kv_support && session_id.is_some() {
                let sid = session_id.as_ref().unwrap();
                let preserved_namespaces = KV_STORE.get_preserved_namespaces(
                    sid,
                    module_slot_to_u32(module_slot),
                );
                if !preserved_namespaces.is_empty() {
                    let status = HmrStatus::host_kv_preserved(name, preserved_namespaces);
                    eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                }
            }

            // ============================================================
            // VALIDATE on_load RETURN POINTER (CRITICAL FOR HMR)
            // ============================================================
            if !module_prev_state.is_null()
                && !new_state.is_null()
                && new_state != module_prev_state
            {
                eprintln!("[Runner] [HMR] WARNING: on_load returned different pointer!");
                eprintln!("[Runner] [HMR]   prev_state: {:p}", module_prev_state);
                eprintln!("[Runner] [HMR]   new_state:  {:p}", new_state);
                eprintln!(
                    "[Runner] [HMR]   This suggests module used malloc instead of static variable."
                );
                eprintln!(
                    "[Runner] [HMR]   State preservation may not work correctly on next reload."
                );
            }

            // Validate state header after initialization
            if !new_state.is_null() {
                let expected_magic = match slot {
                    Some(ModuleSlot::Core) => CORE_STATE_MAGIC,
                    Some(ModuleSlot::Gui) => GUI_STATE_MAGIC,
                    _ => CORE_STATE_MAGIC, // Legacy uses same magic
                };
                let magic_ok = validate_state_magic(new_state, expected_magic);
                let state_abi = get_module_abi_version(new_state);

                if magic_ok {
                    eprintln!(
                        "[Runner] [HMR] State validated: magic OK, ABI version = {}",
                        state_abi
                    );

                    // Cross-check state ABI vs module-reported ABI
                    if module_abi_version > 0 && state_abi > 0 && module_abi_version != state_abi {
                        eprintln!("[Runner] [HMR] WARNING: Module ABI ({}) != state ABI ({}). Possible state corruption.", 
                                    module_abi_version, state_abi);
                    }

                    // Check for major version incompatibility
                    let expected_abi = match slot {
                        Some(ModuleSlot::Core) => SYNTHI_CORE_ABI_VERSION,
                        Some(ModuleSlot::Gui) => SYNTHI_GUI_ABI_VERSION,
                        _ => 1,
                    };
                    if state_abi > expected_abi {
                        eprintln!("[Runner] [HMR] WARNING: State ABI {} > runner supported {}. HMR may have issues - consider full reload.", 
                                    state_abi, expected_abi);
                    }
                } else {
                    // Magic mismatch - could be legacy format, try to continue gracefully
                    eprintln!("[Runner] [HMR] WARNING: State magic mismatch (expected 0x{:08X}). May be legacy format.", expected_magic);
                    eprintln!("[Runner] [HMR] Continuing with module load - HMR state preservation may not work correctly.");
                }
            }

            // ============================================================
            // Phase 4: ATOMIC SWAP - Single operation, no gap
            // ============================================================
            eprintln!(
                "[Runner] [HMR] Phase 4: ATOMIC SWAP executing for '{}'...",
                name
            );

            // This is the critical section - happens in one "instant"
            modules.insert(name.to_string(), new_lib);
            loaded_paths.insert(name.to_string(), path.to_string());

            // Store module-specific state with ABI version and CoreAPI pointer
            module_states.insert(
                name.to_string(),
                ModuleState {
                    state_ptr: new_state,
                    abi_version: module_abi_version,
                    schema_hash: new_schema_hash,
                    core_api_ptr: if name == "gui" {
                        core_api_ptr
                    } else {
                        std::ptr::null_mut()
                    },
                },
            );

            // For "core" or "main", also update the shared app_state.raw
            // GUI should NOT update app_state.raw - it has its own state
            if name == "core" || name == "main" {
                app_state.raw = new_state;
                eprintln!("[Runner] [HMR] Updated shared app_state.raw for '{}'", name);
            } else {
                eprintln!(
                    "[Runner] [HMR] Module '{}' has independent state (not updating app_state.raw)",
                    name
                );
            }

            eprintln!(
                "[Runner] [HMR] ATOMIC SWAP complete. Module '{}' is now active. ABI={}",
                name, module_abi_version
            );

            // ============================================================
            // Phase 5: Deferred cleanup of OLD module(s)
            // ============================================================
            if let Some(old_lib) = old_lib_for_cleanup {
                eprintln!(
                    "[Runner] [HMR] Phase 5: Cleaning up old module '{}'...",
                    name
                );

                if name == "gui" {
                    let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = old_lib
                        .get(b"gui_on_unload")
                        .or_else(|_| old_lib.get(b"on_unload"));
                    if let Ok(f) = func {
                        f(module_prev_state);
                        eprintln!("[Runner] [HMR] GUI on_unload called with its own state");
                    }
                } else if name != "core" {
                    let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                        old_lib.get(b"on_unload");
                    if let Ok(f) = func {
                        f(std::ptr::null_mut());
                    }
                } else {
                    eprintln!("[Runner] [HMR] Skipping on_unload for 'core' (would dlclose gui.so needed by new core)");
                }
            }

            // Cleanup any modules from mode switching
            for (old_name, old_lib) in deferred_unloads {
                eprintln!("[Runner] [HMR] Deferred cleanup of '{}'...", old_name);
                let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                    if old_name == "gui" {
                        old_lib
                            .get(b"gui_on_unload")
                            .or_else(|_| old_lib.get(b"on_unload"))
                    } else if old_name == "core" {
                        old_lib
                            .get(b"core_on_unload")
                            .or_else(|_| old_lib.get(b"on_unload"))
                    } else {
                        old_lib.get(b"on_unload")
                    };
                if let Ok(f) = func {
                    f(std::ptr::null_mut());
                }
            }

            eprintln!(
                "[Runner] [HMR] Hot reload complete for '{}'. Zero-flicker swap successful.",
                name
            );

            // ============================================================
            // STRUCTURED HMR STATUS FEEDBACK
            // ============================================================
            if let Ok(ref _report) = capability_report {
                let status = HmrStatus::Applied {
                    module: name.to_string(),
                    capability: hmr_capability.description().to_string(),
                    state_preserved: state_will_preserve
                        && saved_state.as_ref().and_then(|s| s.json.as_ref()).is_some(),
                };
                eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
            }
        }
        Err(e) => {
            eprintln!(
                "[Runner] [HMR] Error loading new library (old module continues): {}",
                e
            );

            // Send rejection status
            let status = HmrStatus::rejected(name, &format!("Load error: {}", e));
            eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
        }
    }
}
