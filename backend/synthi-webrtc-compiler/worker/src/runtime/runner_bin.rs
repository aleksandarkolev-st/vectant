use libloading::{Library, Symbol};
use std::collections::HashMap;
use std::ffi::{c_void, CString};
use std::io::{self, BufRead, Write};
use std::ptr;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
struct SendVoidPtr(pub usize);
unsafe impl Send for SendVoidPtr {}
unsafe impl Sync for SendVoidPtr {}

#[cfg(target_os = "linux")]
use std::process::Command;
#[cfg(target_os = "linux")]
use x11rb::connection::Connection;
#[cfg(target_os = "linux")]
use x11rb::protocol::shm::ConnectionExt as ShmConnectionExt;
#[cfg(target_os = "linux")]
use worker::runtime::platform::sdl_defs::*;

use worker::runtime::runner_logic;
// use worker::compiler::abi_version;
// use worker::hmr::binary_state;
// use worker::hmr::fast_refresh;
use worker::hmr::orchestrator as hmr_orchestrator;
use worker::infra::crash_recovery;
use worker::infra::host_kv;
use worker::runtime::capability;
use worker::runtime::loader;
// use worker::safety::boundary;
// use worker::compiler::source_map;
// use worker::hmr::reload_manager;
// use worker::hmr::state_diff;
use worker::hmr::state_manager;
use worker::runtime::supervisor;

// safety / hardening
use worker::runtime::process_isolation;
use worker::safety::enhanced_fingerprint;
// use worker::safety::strict_contract;

// public protocol + infra
// use worker::hmr::reload_protocol;
// use worker::hmr::state_type_id;
// use worker::infra::observability;
// use worker::safety::hardened_ipc;
// use worker::safety::quiescence;
// use worker::safety::restart_control;
// use worker::safety::security;
// use worker::safety::slot_isolation;

use worker::safety::hardened_ipc::{read_frame_validated, write_frame_with_checksum, IpcConfig};

use worker::compiler::plugin_contract::ModuleSlot as CompilerModuleSlot;
use worker::runtime::plugin_contract::{
    ModuleSlot, 
    // HotApi, HotGetApiFn, RunnerApi, CORE_STATE_MAGIC, GUI_STATE_MAGIC, LOG_ERROR,
    // LOG_INFO, LOG_WARN, MAX_STATE_ALIGNMENT, RUNNER_API_VERSION, SYNTHI_CORE_ABI_VERSION,
    // SYNTHI_GUI_ABI_VERSION,
};

fn to_compiler_slot(slot: ModuleSlot) -> CompilerModuleSlot {
    match slot {
        ModuleSlot::Core => CompilerModuleSlot::Core,
        ModuleSlot::Gui => CompilerModuleSlot::Gui,
        ModuleSlot::Main => CompilerModuleSlot::Main,
    }
}
use capability::{HmrStatus}; // Removed detect_capabilities

use crash_recovery::{
    generate_crash_report, install_crash_handlers, set_current_lib_path,
    HmrCrashStatus, execute_with_protection,
};

use hmr_orchestrator::{HmrOrchestrator}; // Removed SavedState

use host_kv::{
    create_kv_api, // Removed module_slot_to_u32, read_schema_table, KV_STORE, HostKvSchemaEvent, SynthiHostContextV1
};

use loader::{ModuleLoader}; // Removed LoadResult

use state_manager::StateManager;
use supervisor::{CrashSupervisor, RecoveryAction, SupervisorConfig};

// use enhanced_fingerprint::{extract_fingerprint_from_module}; // Removed AbiFingerprint

// use crate::runtime::hot_reload::v2::{
//     get_module_abi_version, hot_reload_v2, save_state_msgpack_v2, validate_state_magic,
//     HotModuleState, HotReloadResult, RUNNER_API,
// };
use worker::runtime::legacy_module_state::{AppState, ModuleState};

// ============================================================
// INDEPENDENT SWAP DOMAINS: Separate state for each module
// ============================================================
// Each module (core, gui) has its own state pointer.
// This allows:
// 1. GUI reload without touching core state
// 2. Core reload triggers GUI reload (ABI change)
// 3. State migration runs only for the affected module
// ============================================================

// Import new HotApi types for v2 ABI
// use capability::{validate_hot_api, HotApiInfo};

// ModuleState moved to legacy_module_state.rs

// HotModuleState moved to hot_reload/v2.rs

// HotReloadResult moved to hot_reload/v2.rs

// RUNNER_API moved to hot_reload/v2.rs

// hot_reload_v2 moved to hot_reload/v2.rs

// Helper functions moved to hot_reload/v2.rs

// Host context for passing window/renderer to plugins
// Now actively used when creating SynthiHostContextV1
#[repr(C)]
struct HostContext {
    window: *mut c_void,
    renderer: *mut c_void,
}

// Command enum to handle both legacy text commands and binary IPC messages
#[derive(Debug)]
enum RunnerCommand {
    Legacy(String),
    Ipc(process_isolation::IpcMessage),
}

fn main() {
    // ============================================================
    // EXECUTION MODE CHECK - PROCESS ISOLATION IS DEFAULT
    // ============================================================
    // This runner operates in one of two modes:
    // 1. PROCESS-ISOLATED (default): Run as a supervised child process
    //    - Safe: dlclose UB is contained in disposable process
    //    - Automatic restart on crash
    //    - State preserved via IPC snapshots
    //
    // 2. UNSAFE IN-PROCESS (legacy, deprecated): Direct library loading
    //    - DANGEROUS: dlclose UB can corrupt parent process
    //    - Only enabled with SYNTHI_UNSAFE_INPROCESS=1
    //    - Exists only for debugging/profiling where isolation overhead is unacceptable
    // ============================================================
    let execution_mode = process_isolation::ExecutionMode::from_env();

    match execution_mode {
        process_isolation::ExecutionMode::ProcessIsolated => {
            // This is the SAFE path - we should be running under a supervisor.
            // If we're the top-level process, we need to spawn a supervisor.
            if std::env::var("SYNTHI_SUPERVISED").is_err() {
                // We are the top-level process - start the supervisor
                eprintln!("[Runner] Starting in PROCESS-ISOLATED mode (safe default)");
                eprintln!("[Runner] Spawning supervisor to manage worker process...");

                // Mark that we're now supervising
                std::env::set_var("SYNTHI_SUPERVISED", "1");

                let config = process_isolation::IsolationConfig::default();
                let mut supervisor = process_isolation::ProcessSupervisor::new(config);

                if let Err(e) = supervisor.start() {
                    eprintln!("[Runner] FATAL: Failed to start supervisor: {}", e);
                    std::process::exit(1);
                }

                // Run the full supervisor event loop
                eprintln!("[Runner] Supervisor started, entering event loop");
                if let Err(e) = supervisor.run_event_loop() {
                    eprintln!("[Runner] Supervisor event loop error: {}", e);
                    std::process::exit(1);
                }

                eprintln!("[Runner] Supervisor event loop completed, exiting");
                std::process::exit(0);
            } else {
                eprintln!("[Runner] Running as supervised worker process (PID: {})", std::process::id());
                // v2.1: Verify we are receiving the correct environment
                if let Ok(parent_pid) = std::env::var("SYNTHI_SUPERVISOR_PID") {
                    eprintln!("[Runner] Managed by supervisor PID: {}", parent_pid);
                }
            }
        }
        #[allow(deprecated)]
        process_isolation::ExecutionMode::UnsafeInProcess => {
            // UNSAFE PATH - User explicitly opted in
            eprintln!("[Runner] ============================================================");
            eprintln!("[Runner] WARNING: Running in UNSAFE IN-PROCESS mode");
            eprintln!("[Runner] This mode is DEPRECATED and may cause process corruption");
            eprintln!("[Runner] dlclose UB can corrupt memory, leak resources, crash randomly");
            eprintln!("[Runner] Use SYNTHI_UNSAFE_INPROCESS=1 only for debugging");
            eprintln!("[Runner] ============================================================");
        }
    }

    // Install crash handlers for runtime error recovery
    eprintln!("[Runner] Installing crash handlers...");
    if let Err(e) = install_crash_handlers() {
        eprintln!("[Runner] Warning: Failed to install crash handlers: {}", e);
    } else {
        eprintln!("[Runner] Crash handlers installed successfully");
    }

    // When DISPLAY is pre-set, the worker manages Xvfb, GStreamer, and video
    // streaming.  Skip creating our own Xvfb / X11 connection / SHM since the
    // worker captures frames via GStreamer ximagesrc.  BUT we still need an SDL
    // window + renderer so loaded modules can render into the worker's Xvfb.
    #[cfg(target_os = "linux")]
    let worker_managed_display = !std::env::var("DISPLAY").unwrap_or_default().is_empty();
    #[cfg(not(target_os = "linux"))]
    let worker_managed_display = false;

    #[cfg(target_os = "linux")]
    let (_xvfb_proc, x11_conn, _x11_screen_num, x11_root) = if !worker_managed_display {
        let mut cmd = Command::new("Xvfb");
        cmd.args(&[":99", "-screen", "0", "800x600x24"]);
        let c = cmd.spawn().ok();
        thread::sleep(Duration::from_millis(100));
        std::env::set_var("DISPLAY", ":99");
        let (conn, screen_num) = x11rb::connect(Some(":99")).expect("Failed to connect to X11");
        let root = conn.setup().roots[screen_num].root;
        (c, Some(conn), screen_num, root)
    } else {
        eprintln!("[Runner] Worker manages display — skipping Xvfb/X11/SHM (worker captures via ximagesrc)");
        (None, None, 0, 0u32)
    };

    #[cfg(target_os = "linux")]
    let (shm_seg, shm_ptr) = if let Some(ref conn) = x11_conn {
        let size = 800 * 600 * 4;
        let (id, ptr) = worker::runtime::runner::capture::create_shm_segment(size).expect("Failed to create SHM");
        let seg = conn.generate_id().unwrap();
        conn.shm_attach(seg, id as u32, false).unwrap();
        (seg, ptr)
    } else {
        (0u32, ptr::null_mut())
    };

    // Always init SDL2 — modules need a renderer to draw into.
    // When worker manages display, the SDL window renders into the worker's Xvfb
    // and the worker's GStreamer ximagesrc captures it automatically.
    #[cfg(target_os = "linux")]
    let (window, renderer) = unsafe { init_sdl() };

    #[cfg(target_os = "linux")]
    let _sdl_texture = unsafe {
        if !renderer.is_null() {
            SDL_CreateTexture(
                renderer,
                SDL_PIXELFORMAT_RGBA8888,
                SDL_TEXTUREACCESS_STREAMING,
                800,
                600,
            )
        } else {
            ptr::null_mut()
        }
    };

    // Initialize GStreamer
    if let Err(e) = gstreamer::init() {
        eprintln!("Failed to initialize GStreamer: {}", e);
    } else {
        eprintln!("GStreamer initialized.");
    }
    let _ = io::stdout().flush();

    eprintln!("Runner started. Waiting for commands...");

    let (tx, rx) = mpsc::channel::<RunnerCommand>();

    // Frame pipe to stdout (non-blocking for the main loop)
    // We keep the channel tiny and drop frames when the pipe is backed up so on_update keeps running.
    #[cfg(target_os = "linux")]
    let (frame_tx, frame_rx) = mpsc::sync_channel::<Vec<u8>>(2);

    // Dedicated writer so rendering never blocks on stdout backpressure
    #[cfg(target_os = "linux")]
    {
        // Only spawn video writer if NOT in ProcessIsolated mode to prevent IPC corruption
        if !matches!(
            execution_mode,
            process_isolation::ExecutionMode::ProcessIsolated
        ) {
            std::thread::spawn(move || {
                let mut stdout = io::stdout();
                while let Ok(buf) = frame_rx.recv() {
                    if let Err(e) = stdout.write_all(&buf) {
                        eprintln!("[Runner] stdout writer error: {}", e);
                        break;
                    }
                    let _ = stdout.flush();
                }
            });
        } else {
            eprintln!("[Runner] Raw video output DISABLED in ProcessIsolated mode (IPC active)");
        }
    }

    // Spawn input reader thread based on execution mode
    let tx_clone = tx.clone();
    let mode_for_thread = execution_mode;

    // Spawn stdin reader thread
    thread::spawn(move || {
        eprintln!("Input reader thread started (Mode: {:?})", mode_for_thread);
        let stdin = io::stdin();
        let mut handle = stdin.lock();

        match mode_for_thread {
            process_isolation::ExecutionMode::ProcessIsolated => {
                // Binary IPC reader (MsgPack frames)
                // Use default config for now
                let config = IpcConfig::default();

                loop {
                    match read_frame_validated(&mut handle, &config, None) {
                        Ok(payload) => {
                            // Deserialize MsgPack
                            match rmp_serde::from_slice::<process_isolation::IpcMessage>(&payload) {
                                Ok(msg) => {
                                    if let Err(e) = tx_clone.send(RunnerCommand::Ipc(msg)) {
                                        eprintln!("Failed to send IPC command: {}", e);
                                        break;
                                    }
                                }
                                Err(e) => eprintln!("IPC Deserialization error: {}", e),
                            }
                        }
                        Err(e) => {
                            // Check if it's EOF
                            if matches!(e, worker::safety::hardened_ipc::IpcError::ConnectionClosed)
                            {
                                eprintln!("IPC connection closed (EOF)");
                            } else {
                                eprintln!("IPC Read error: {:?}", e);
                            }
                            break;
                        }
                    }
                }
            }
            #[allow(deprecated)]
            process_isolation::ExecutionMode::UnsafeInProcess => {
                // Legacy text reader
                let mut line = String::new();
                loop {
                    match handle.read_line(&mut line) {
                        Ok(0) => {
                            eprintln!("Stdin closed (EOF)");
                            break;
                        }
                        Ok(_) => {
                            let trimmed = line.trim().to_string();
                            if !trimmed.is_empty() {
                                eprintln!("Stdin received: {}", trimmed);
                                if let Err(e) = tx_clone.send(RunnerCommand::Legacy(trimmed)) {
                                    eprintln!("Failed to send command to main thread: {}", e);
                                    break;
                                }
                            }
                            line.clear();
                        }
                        Err(e) => {
                            eprintln!("Error reading stdin: {}", e);
                            break;
                        }
                    }
                }
            }
        }
        eprintln!("Input reader thread exited");
    });

    let mut modules: HashMap<String, Library> = HashMap::new();
    let mut loaded_paths: HashMap<String, String> = HashMap::new();
    // Independent swap: Track state per module
    let mut module_states: HashMap<String, ModuleState> = HashMap::new();

    // ============================================================
    // MODULE LOADER WITH ABI VALIDATION
    // ============================================================
    // ModuleLoader provides:
    // - ABI compatibility checking before load
    // - Symbol manifest validation
    // - Rollback support to previous versions
    // - Load history for debugging
    // Note: We still use the modules HashMap for actual library storage
    // because ModuleLoader integration is gradual - it validates but
    // the existing loading code handles state transfer and lifecycle.
    let mut module_loader = ModuleLoader::new();
    let loader_enabled = std::env::var("SYNTHI_LOADER_VALIDATION").is_ok();
    if loader_enabled {
        eprintln!("[Runner] ModuleLoader ABI validation ENABLED");
    }

    // ============================================================
    // CRASH SUPERVISOR
    // ============================================================
    // CrashSupervisor coordinates crash recovery with policies:
    // - First crash: attempt hot reload
    // - Second crash: rollback to previous version
    // - Third+ crash: clean restart
    // - Too many crashes: full restart required
    let mut crash_supervisor = CrashSupervisor::new(SupervisorConfig {
        max_consecutive_crashes: 3,
        crash_window: Duration::from_secs(60),
        detailed_logging: true,
        ..Default::default()
    });
    let supervisor_enabled = std::env::var("SYNTHI_CRASH_SUPERVISOR").is_ok() || true; // Enable by default
    if supervisor_enabled {
        eprintln!("[Runner] CrashSupervisor ENABLED (max_crashes=3, window=60s)");
    }

    // ============================================================
    // STATE MANAGER
    // ============================================================
    // StateManager tracks state per module for centralized lifecycle management
    let _state_manager = StateManager::new();
    eprintln!("[Runner] StateManager initialized");

    // ============================================================
    // HMR ORCHESTRATOR (Unified State/Reload Management)
    // ============================================================
    // The orchestrator consolidates:
    // - State save/load (binary-first with JSON fallback)
    // - Reload classification (Safe/Warm/Cold)
    // - Schema compatibility checking
    // - Crash recovery coordination
    // ============================================================
    let mut orchestrator = HmrOrchestrator::new();
    eprintln!("[Runner] HmrOrchestrator initialized (binary_state=ENABLED)");

    #[cfg(not(target_os = "linux"))]
    let (window, renderer) = (ptr::null_mut(), ptr::null_mut());
    let mut app_state = AppState {
        raw: std::ptr::null_mut(),
        renderer,
    };
    let mut last_frame = Instant::now();
    let mut last_log = Instant::now();
    let mut frame_count: u64 = 0;
    let mut frames_sent: u64 = 0;
    let mut last_frame_log = Instant::now();

    // ============================================================
    // HOST KV STATE
    // ============================================================
    // Session ID for Host KV scoping. Must be set via "set_session" command
    // before loading modules that use Host KV.
    // Read session from env var (set by worker when spawning us) as initial
    // fallback. The worker also sends a 'set_session' text command, but
    // having the env var ensures session is available immediately for the
    // first module loads without a race against stdin ordering.
    let mut session_id: Option<String> = std::env::var("SYNTHI_SESSION_ID").ok();
    let mut session_id_cstring: Option<CString> = session_id
        .as_ref()
        .and_then(|s| CString::new(s.clone()).ok());
    if let Some(ref sid) = session_id {
        eprintln!("[Runner] Session ID from env: {}", sid);
    }
    let kv_api = create_kv_api();

    #[cfg(target_os = "linux")]
    eprintln!("[Runner] Frame capture enabled (Linux build)");
    #[cfg(not(target_os = "linux"))]
    eprintln!("[Runner] Frame capture DISABLED (non-Linux build)");

    // Notify supervisor that we are ready (if in isolated mode)
    if let process_isolation::ExecutionMode::ProcessIsolated = execution_mode {
        let mut stdout = io::stdout();
        let msg = process_isolation::IpcMessage::Ready;
        let payload = rmp_serde::to_vec(&msg).unwrap();

        if let Err(e) = write_frame_with_checksum(&mut stdout, &payload) {
            eprintln!("[Runner] Failed to send Ready message: {}", e);
        } else {
            let _ = stdout.flush();
            eprintln!("[Runner] Sent Ready message to supervisor");
        }
    }

    loop {
        // Poll SDL2 events and pass them to loaded modules
        #[cfg(target_os = "linux")]
        if !window.is_null() {
            unsafe {
                let mut event: SDL_Event = std::mem::zeroed();
                while SDL_PollEvent(&mut event) != 0 {
                    // SPLIT MODE: Events go to core module with core's state.
                    // Core handles button clicks, key presses, etc. that affect app state.
                    // GUI module can also receive events for hover/focus handling.
                    // Pass SDL_Event to all loaded modules that export on_event
                    // The plugin's on_event expects SDL_Event* (not XEvent*)
                    // Plugins MUST be compiled to expect SDL_Event, not XEvent
                    for (name, lib) in modules.iter() {
                        let event_func: Result<
                            Symbol<unsafe extern "C" fn(*mut c_void, *mut SDL_Event)>,
                            _,
                        > = lib.get(b"on_event");
                        if let Ok(f) = event_func {
                            // CRITICAL FIX: In split mode, both core and GUI should receive
                            // core's state for events. Core handles state changes (pause, quit),
                            // and if GUI has on_event it should also see core's state.
                            let state_ptr =
                                if modules.contains_key("core") && !app_state.raw.is_null() {
                                    // Split mode: use core's state for all event handlers
                                    app_state.raw
                                } else if name == "gui" {
                                    // GUI-only mode: use GUI's own state
                                    module_states
                                        .get(name)
                                        .map(|s| s.state_ptr)
                                        .unwrap_or(app_state.raw)
                                } else {
                                    app_state.raw
                                };
                            f(state_ptr, &mut event);
                        }
                    }
                }
            }
        }

        if last_log.elapsed() > Duration::from_secs(5) {
            // Keep stdout clean for raw frame bytes; log diagnostics to stderr instead.
            eprintln!(
                "[Runner] Heartbeat. Modules: {}, FPS: {:.2}",
                modules.len(),
                1.0 / last_frame.elapsed().as_secs_f64().max(0.001)
            );
            last_log = Instant::now();
        }

        // Process all pending commands
        while let Ok(cmd_wrapper) = rx.try_recv() {
            let cmd = match cmd_wrapper {
                RunnerCommand::Legacy(c) => c,
                RunnerCommand::Ipc(msg) => {
                    match msg {
                        process_isolation::IpcMessage::LoadModule { slot, path, .. } => {
                            format!("load {} {}", slot, path)
                        }
                        process_isolation::IpcMessage::ReloadModule { slot, path, .. } => {
                            format!("reload {} {}", slot, path)
                        }
                        process_isolation::IpcMessage::InputEvent { kind, a, b, c } => {
                            // Map numeric events back to legacy string commands
                            match kind {
                                0 => format!("input motion {} {}", a, b), // x, y
                                1 => format!(
                                    "input button {} {} {} {}",
                                    if b == 1 { "down" } else { "up" }, // state
                                    a,                                  // button
                                    (c >> 16) as i16,
                                    (c & 0xFFFF) as i16
                                ), // x, y packed
                                2 => format!(
                                    "input key {} {}",
                                    if a == 1 { "down" } else { "up" },
                                    b
                                ), // state, keycode
                                _ => String::new(),
                            }
                        }
                        process_isolation::IpcMessage::Ping { seq } => {
                            eprintln!("[Runner] Ping received (seq={})", seq);
                            String::new()
                        }
                        _ => {
                            eprintln!("[Runner] Unhandled IPC message: {:?}", msg);
                            String::new()
                        }
                    }
                }
            };

            if cmd.is_empty() {
                continue;
            }

            // Route command logs to stderr so stdout stays dedicated to the video stream.
            eprintln!("[Runner] Processing command: {}", cmd);
            let parts: Vec<&str> = cmd.split_whitespace().collect();
            if parts.is_empty() {
                continue;
            }

            match parts[0] {
                // ============================================================
                // SET_SESSION COMMAND - Must be called before loading Host KV modules
                // ============================================================
                "set_session" => {
                    if parts.len() >= 2 {
                        let new_session = parts[1].to_string();

                        // Reject session change if already set (prevent silent keyspace switch)
                        if let Some(ref existing) = session_id {
                            if existing != &new_session {
                                eprintln!("[Runner] [HOST-KV] ERROR: Cannot change session_id mid-run (current: {}, requested: {})", existing, new_session);
                                continue;
                            }
                            // Same session, no-op
                            eprintln!("[Runner] [HOST-KV] Session already set: {}", new_session);
                            continue;
                        }

                        // Set the session
                        session_id = Some(new_session.clone());
                        session_id_cstring = CString::new(new_session.clone()).ok();

                        eprintln!("[Runner] [HOST-KV] Session set: {}", new_session);

                        // Emit status event
                        let status = HmrStatus::host_kv_ready(&new_session, "pending");
                        eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                    } else {
                        eprintln!(
                            "[Runner] [HOST-KV] ERROR: set_session requires session_id argument"
                        );
                    }
                }

                "input" => {
                    #[cfg(target_os = "linux")]
                    if parts.len() >= 2 {
                        // Create SDL events and push them to SDL's event queue
                        // This ensures they get picked up by SDL_PollEvent and passed to on_event
                        unsafe {
                            match parts[1] {
                                "motion" => {
                                    if parts.len() >= 4 {
                                        if let (Ok(x), Ok(y)) =
                                            (parts[2].parse::<i32>(), parts[3].parse::<i32>())
                                        {
                                            // Create SDL_MouseMotionEvent
                                            let mut event: SDL_Event = std::mem::zeroed();
                                            let event_ptr = event.data.as_mut_ptr();
                                            // SDL_MouseMotionEvent layout:
                                            // type (u32), timestamp (u32), windowID (u32), which (u32), state (u32), x (i32), y (i32), xrel (i32), yrel (i32)
                                            *(event_ptr as *mut u32) = SDL_MOUSEMOTION;
                                            *(event_ptr.add(4) as *mut u32) = 0; // timestamp
                                            *(event_ptr.add(8) as *mut u32) = 0; // windowID
                                            *(event_ptr.add(12) as *mut u32) = 0; // which (mouse)
                                            *(event_ptr.add(16) as *mut u32) = 0; // state (button mask)
                                            *(event_ptr.add(20) as *mut i32) = x; // x
                                            *(event_ptr.add(24) as *mut i32) = y; // y
                                            *(event_ptr.add(28) as *mut i32) = 0; // xrel
                                            *(event_ptr.add(32) as *mut i32) = 0; // yrel

                                            SDL_PushEvent(&mut event);
                                            eprintln!(
                                                "[Runner] Pushed SDL mouse motion event: ({}, {})",
                                                x, y
                                            );
                                        }
                                    }
                                }
                                "button" => {
                                    if parts.len() >= 6 {
                                        let type_str = parts[2];
                                        let btn = parts[3].parse::<u8>().unwrap_or(1);
                                        let x = parts[4].parse::<i32>().unwrap_or(0);
                                        let y = parts[5].parse::<i32>().unwrap_or(0);

                                        let event_type = if type_str == "down" {
                                            SDL_MOUSEBUTTONDOWN
                                        } else {
                                            SDL_MOUSEBUTTONUP
                                        };

                                        // Create SDL_MouseButtonEvent
                                        let mut event: SDL_Event = std::mem::zeroed();
                                        let event_ptr = event.data.as_mut_ptr();
                                        // SDL_MouseButtonEvent layout:
                                        // type (u32), timestamp (u32), windowID (u32), which (u32), button (u8), state (u8), clicks (u8), padding (u8), x (i32), y (i32)
                                        *(event_ptr as *mut u32) = event_type;
                                        *(event_ptr.add(4) as *mut u32) = 0; // timestamp
                                        *(event_ptr.add(8) as *mut u32) = 0; // windowID
                                        *(event_ptr.add(12) as *mut u32) = 0; // which (mouse)
                                        *(event_ptr.add(16) as *mut u8) = btn; // button
                                        *(event_ptr.add(17) as *mut u8) =
                                            if type_str == "down" { 1 } else { 0 }; // state
                                        *(event_ptr.add(18) as *mut u8) = 1; // clicks
                                        *(event_ptr.add(20) as *mut i32) = x; // x
                                        *(event_ptr.add(24) as *mut i32) = y; // y

                                        SDL_PushEvent(&mut event);
                                        eprintln!(
                                            "[Runner] Pushed SDL mouse {} event: btn={}, ({}, {})",
                                            type_str, btn, x, y
                                        );
                                    }
                                }
                                "key" => {
                                    if parts.len() >= 4 {
                                        let type_str = parts[2];
                                        let keycode = parts[3].parse::<i32>().unwrap_or(0);

                                        let event_type = if type_str == "down" {
                                            SDL_KEYDOWN
                                        } else {
                                            SDL_KEYUP
                                        };

                                        // Create SDL_KeyboardEvent
                                        let mut event: SDL_Event = std::mem::zeroed();
                                        let event_ptr = event.data.as_mut_ptr();
                                        // SDL_KeyboardEvent layout:
                                        // type (u32), timestamp (u32), windowID (u32), state (u8), repeat (u8), padding (u16), keysym (SDL_Keysym)
                                        // SDL_Keysym: scancode (u32), sym (i32), mod (u16), unused (u32)
                                        *(event_ptr as *mut u32) = event_type;
                                        *(event_ptr.add(4) as *mut u32) = 0; // timestamp
                                        *(event_ptr.add(8) as *mut u32) = 0; // windowID
                                        *(event_ptr.add(12) as *mut u8) =
                                            if type_str == "down" { 1 } else { 0 }; // state
                                        *(event_ptr.add(13) as *mut u8) = 0; // repeat
                                                                             // keysym starts at offset 16
                                        *(event_ptr.add(16) as *mut u32) = keycode as u32; // scancode
                                        *(event_ptr.add(20) as *mut i32) = keycode; // sym (SDLK_*)
                                        *(event_ptr.add(24) as *mut u16) = 0; // mod

                                        SDL_PushEvent(&mut event);
                                        eprintln!(
                                            "[Runner] Pushed SDL key {} event: keycode={}",
                                            type_str, keycode
                                        );
                                    }
                                }
                                _ => {
                                    eprintln!("[Runner] Unknown input type: {}", parts[1]);
                                }
                            }
                        }
                    }
                }
                "load" => {
                    // usage: load <name> <path>
                    // fallback: load <path> -> name="main"
                    let (name, path) = if parts.len() >= 3 {
                        (parts[1], parts[2])
                    } else if parts.len() == 2 {
                        ("main", parts[1])
                    } else {
                        eprintln!("[Runner] Invalid load command format");
                        continue;
                    };

                    eprintln!("[Runner] Loading module '{}' from {}", name, path);

                    if let Some(current_path) = loaded_paths.get(name) {
                        if current_path == path {
                            eprintln!(
                                "[Runner] Module '{}' already loaded from {}. Skipping.",
                                name, path
                            );
                            continue;
                        }
                    }

                    unsafe {
                        runner_logic::process_load_command(
                            name,
                            path,
                            &mut modules,
                            &mut loaded_paths,
                            &mut module_states,
                            &mut app_state,
                            &mut module_loader,
                            &mut orchestrator,
                            &session_id,
                            &session_id_cstring,
                            &kv_api,
                            loader_enabled,
                            supervisor_enabled,
                        );
                    }
                }
                "unload" => {
                    if parts.len() == 2 {
                        let name = parts[1];
                        eprintln!("[Runner] Unloading module '{}'", name);
                        if let Some(lib) = modules.remove(name) {
                            loaded_paths.remove(name);
                            // Get module's own state for unload
                            let module_state_ptr = module_states
                                .get(name)
                                .map(|s| s.state_ptr)
                                .unwrap_or(std::ptr::null_mut());
                            module_states.remove(name);
                            unsafe {
                                // Prefer ABI-prefixed unload symbols, fall back to legacy.
                                let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                                    if name == "core" {
                                        lib.get(b"core_on_unload")
                                            .or_else(|_| lib.get(b"on_unload"))
                                    } else if name == "gui" {
                                        lib.get(b"gui_on_unload").or_else(|_| lib.get(b"on_unload"))
                                    } else {
                                        lib.get(b"on_unload")
                                    };
                                if let Ok(f) = func {
                                    f(module_state_ptr);
                                }
                            }
                            eprintln!("[Runner] Unloaded module {}", name);
                        }
                    }
                }
                "quit" => {
                    eprintln!("[Runner] Quitting.");
                    #[cfg(target_os = "linux")]
                    unsafe {
                        SDL_Quit();
                    }
                    return;
                }
                _ => {}
            }
        }

        // Calculate delta time
        let now = Instant::now();
        let dt = now.duration_since(last_frame).as_secs_f64();
        last_frame = now;

        // NOTE: Do NOT clear screen here - let the user's gui_render handle it.
        // Clearing here and in gui_render can cause timing issues.

        // Run update loop for all loaded modules
        // INDEPENDENT SWAP: Each module gets called with its own state pointer.
        // - "core" and "main" use app_state.raw (backward compatible)
        // - "gui" uses its own module_states["gui"].state_ptr
        // Deterministic order: "core" first, then others sorted alphabetically
        let mut keys: Vec<String> = modules.keys().cloned().collect();
        keys.sort_by(|a, b| {
            if a == "core" {
                std::cmp::Ordering::Less
            } else if b == "core" {
                std::cmp::Ordering::Greater
            } else {
                a.cmp(b)
            }
        });

        for name in &keys {
            if let Some(lib) = modules.get(name) {
                unsafe {
                    // Try new symbol names first, then legacy
                    let update_func: Option<Symbol<unsafe extern "C" fn(*mut c_void, f64)>> =
                        if name == "core" {
                            lib.get(b"core_on_update")
                                .ok()
                                .or_else(|| lib.get(b"on_update").ok())
                        } else if name == "gui" {
                            // GUI doesn't have on_update in new ABI (only on_render)
                            lib.get(b"gui_on_update")
                                .ok()
                                .or_else(|| lib.get(b"on_update").ok())
                        } else {
                            lib.get(b"on_update").ok()
                        };

                    if let Some(f) = update_func {
                        // INDEPENDENT SWAP: Use module-specific state for GUI
                        let state_ptr = if name == "gui" {
                            module_states
                                .get(name)
                                .map(|s| s.state_ptr)
                                .unwrap_or(app_state.raw)
                        } else {
                            // For core/main, use shared app_state.raw
                            app_state.raw
                        };

                        // Execute with crash protection on Linux
                        #[cfg(unix)]
                        {
                            let module_name = name.clone();
                            // Set current library path for source map lookup on crash
                            if let Some(lib_path) = loaded_paths.get(name) {
                                set_current_lib_path(lib_path);
                            }

                            // Enter crash supervisor context for this module
                            if supervisor_enabled {
                                let slot = ModuleSlot::from_str(name).unwrap_or(ModuleSlot::Main);
                                crash_supervisor.enter_context(slot);
                            }

                            let state_ptr_wrapper = SendVoidPtr(state_ptr as usize);
                            let func_ptr = *f;
                            let result = execute_with_protection(&module_name, move || {
                                let state_ptr = state_ptr_wrapper.0 as *mut std::ffi::c_void;
                                func_ptr(state_ptr, dt);
                            });

                            // Exit crash supervisor context
                            if supervisor_enabled {
                                crash_supervisor.exit_context();
                            }

                            if let Err(crash_info) = result {
                                // Crash recovered! Log and continue with old module
                                eprintln!("{}", generate_crash_report(&crash_info));

                                // Use CrashSupervisor to determine recovery action
                                let recovery_action = if supervisor_enabled {
                                    crash_supervisor.report_crash(&crash_info)
                                } else {
                                    RecoveryAction::HotReload
                                };

                                // CRITICAL SAFETY CHECK:
                                // If the crash was caused by memory corruption (SIGSEGV, SIGBUS, etc.),
                                // we MUST NOT continue in the same process, as the heap state is undefined.
                                let is_fatal = crash_info.is_fatal_memory_error();
                                let force_restart = is_fatal
                                    || recovery_action == RecoveryAction::FullRestart
                                    || recovery_action == RecoveryAction::Fatal
                                    || (supervisor_enabled
                                        && crash_supervisor.should_force_restart());

                                let status =
                                    HmrCrashStatus::from_crash(&crash_info, !force_restart);
                                eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                                eprintln!("[Runner] Recovery action: {:?}", recovery_action);

                                if force_restart {
                                    if is_fatal {
                                        eprintln!("[Runner] Fatal memory corruption detected ({:?}). Forcing cold restart.", crash_info.signal_name);
                                    } else {
                                        eprintln!("[Runner] Too many consecutive crashes (action={:?}). Exiting.", recovery_action);
                                    }
                                    std::process::exit(1);
                                }

                                // On successful hot reload, reset crash count
                                if recovery_action == RecoveryAction::HotReload
                                    && supervisor_enabled
                                {
                                    // Don't reset here - reset after successful reload
                                }

                                // Skip this module for now, continue with others
                                continue;
                            }

                            // Successful execution - reset crash count if supervisor enabled
                            // Note: We only reset on successful frame completion, not per-module
                        }

                        #[cfg(not(unix))]
                        {
                            f(state_ptr, dt);
                        }
                    }
                }
            }
        }

        // Render pass:
        // SPLIT MODE: GUI renders core's state (app_state.raw) since core owns the
        // application data (x, y, dx, paused, etc.). GUI only handles presentation.
        // The GUI's own state (module_states["gui"]) is for GUI-specific data like
        // cached textures, hover states, etc. - but core state drives the rendering.
        //
        // For non-split mode (main): Call main's on_render/gui_render.

        // Check if GUI module has an independent on_render
        if let Some(lib) = modules.get("gui") {
            unsafe {
                // Try new symbol first, then legacy
                let render_func: Option<Symbol<unsafe extern "C" fn(*mut c_void)>> = lib
                    .get(b"gui_on_render")
                    .ok()
                    .or_else(|| lib.get(b"on_render").ok())
                    .or_else(|| lib.get(b"gui_render").ok());

                // CRITICAL FIX: In split mode (core+gui), GUI must render core's state
                // because core owns application data (x, y, dx, paused, etc.).
                // Only fall back to GUI's own state if core is not loaded.
                let render_state = if modules.contains_key("core") && !app_state.raw.is_null() {
                    // Split mode: render core's state (has animation data)
                    app_state.raw
                } else {
                    // GUI-only mode: render GUI's own state
                    module_states
                        .get("gui")
                        .map(|s| s.state_ptr)
                        .unwrap_or(app_state.raw)
                };

                if let Some(f) = render_func {
                    f(render_state);
                }
            }
        } else if let Some(lib) = modules.get("core") {
            unsafe {
                // Core may export on_render that calls ptr_gui_render internally
                let render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                    lib.get(b"on_render");
                if let Ok(f) = render_func {
                    f(app_state.raw);
                }
                // If core doesn't have on_render, that's OK - core's on_update handles rendering
            }
        } else if let Some(lib) = modules.get("main") {
            // Fallback for non-split mode: call main's render
            unsafe {
                let render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                    lib.get(b"on_render");
                let gui_render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                    lib.get(b"gui_render");

                if let Ok(f) = render_func {
                    f(app_state.raw);
                } else if let Ok(f) = gui_render_func {
                    f(app_state.raw);
                }
            }
        }

        // Present the SDL renderer BEFORE capturing from Xvfb
        // This ensures the plugin's rendering is visible in the capture
        #[cfg(target_os = "linux")]
        if !renderer.is_null() {
            unsafe {
                SDL_RenderPresent(renderer);
            }
        }

        #[cfg(target_os = "linux")]
        if let Some(ref conn) = x11_conn {
             worker::runtime::runner::capture::capture_frame(
                 conn,
                 x11_root,
                 shm_seg,
                 shm_ptr,
                 &frame_tx,
                 &mut frame_count,
                 &mut frames_sent,
                 &mut last_frame_log
             );
        }

        // Cap at ~60 FPS
        let elapsed = now.elapsed();
        if elapsed < Duration::from_millis(16) {
            thread::sleep(Duration::from_millis(16) - elapsed);
        }
    } // end of loop
} // end of main
