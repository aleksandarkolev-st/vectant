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
use worker::runtime::platform::sdl_defs::*;
#[cfg(target_os = "linux")]
use x11rb::connection::Connection;
#[cfg(target_os = "linux")]
use x11rb::protocol::shm::ConnectionExt as ShmConnectionExt;
#[cfg(target_os = "linux")]
use x11rb::protocol::xtest::ConnectionExt as XTestConnectionExt;

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

use capability::HmrStatus;
use worker::runtime::plugin_contract::{
    ModuleSlot,
    // HotApi, HotGetApiFn, RunnerApi, CORE_STATE_MAGIC, GUI_STATE_MAGIC, LOG_ERROR,
    // LOG_INFO, LOG_WARN, MAX_STATE_ALIGNMENT, RUNNER_API_VERSION, SYNTHI_CORE_ABI_VERSION,
    // SYNTHI_GUI_ABI_VERSION,
}; // Removed detect_capabilities

use crash_recovery::{
    execute_with_protection, generate_crash_report, install_crash_handlers, set_current_lib_path,
    set_protection_mode, HmrCrashStatus, ProtectionMode,
};

use hmr_orchestrator::HmrOrchestrator; // Removed SavedState

use host_kv::{
    create_kv_api, // Removed module_slot_to_u32, read_schema_table, KV_STORE, HostKvSchemaEvent, SynthiHostContextV1
};

use loader::ModuleLoader; // Removed LoadResult

use state_manager::StateManager;
use supervisor::{CrashSupervisor, RecoveryAction, SupervisorConfig};

#[cfg(feature = "gpu-hmr")]
use worker::hmr::adapter_trait::{Adapter, AdapterReloadRequest};
#[cfg(feature = "gpu-hmr")]
use worker::hmr::build_manifest::{BuildManifest, BuildSlot, SnapshotMode};
#[cfg(feature = "gpu-hmr")]
use worker::hmr::gpu_module_adapter::{GpuModuleAdapter, GpuModuleAdapterConfig, GpuVendor};

// use enhanced_fingerprint::{extract_fingerprint_from_module}; // Removed AbiFingerprint

// use crate::runtime::hot_reload::v2::{
//     get_module_abi_version, hot_reload_v2, save_state_msgpack_v2, validate_state_magic,
//     HotModuleState, HotReloadResult, RUNNER_API,
// };
use worker::debug_log;
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

// Command enum to handle both legacy text commands and binary IPC messages
#[derive(Debug)]
enum RunnerCommand {
    Legacy(String),
    Ipc(process_isolation::IpcMessage),
}

/// ULTRAPLAN Lightning Phase 10g.2 — backend selection for runtime.
///
/// Runs the WindowBackend selector against the real workspace
/// sidecar + manifest AND returns the chosen backend so main() can
/// actually use it for window creation. Supersedes the
/// observability-only Phase 10g.1 helper (`log_phase10g_backend_selection`).
///
/// Reads the sidecar at `./.synthi_split_meta.json` (relative to
/// the runner's cwd, inherited from the worker's workspace_path).
/// Extracts `architecture` + `compile_manifest.runner_link_flags`
/// and feeds them to `select_backend`.
///
/// Returns:
///   - `Some(SelectedBackend)` when the sidecar parsed cleanly
///     and the selector produced a decision. The caller inspects
///     `.backend.name()` to decide which init path to take.
///   - `None` when the sidecar is missing, unparseable, or
///     otherwise unusable. The caller falls back to the legacy
///     `init_sdl()` path.
///
/// Side effects: logs the decision + inputs to stderr for
/// observability. Every error path also logs before returning None.
fn select_backend_for_runner() -> Option<worker::runtime::backends::selector::SelectedBackend> {
    use worker::runtime::backends::selector::{select_backend, SelectorInputs};

    let sidecar_path = std::path::PathBuf::from(".synthi_split_meta.json");
    let raw = match std::fs::read_to_string(&sidecar_path) {
        Ok(s) => s,
        Err(_) => {
            eprintln!(
                "[Phase 10g] sidecar {} not found — falling back to legacy init_sdl path",
                sidecar_path.display()
            );
            return None;
        }
    };
    let sidecar: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[Phase 10g] sidecar parse failed ({}) — falling back to legacy init_sdl path",
                e
            );
            return None;
        }
    };

    let architecture = sidecar
        .get("architecture")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let link_flags: Vec<String> = sidecar
        .get("compile_manifest")
        .and_then(|m| m.get("runner_link_flags"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let inputs = SelectorInputs {
        arch_cache: architecture,
        link_flags: &link_flags,
    };
    let selected = select_backend(inputs);

    eprintln!(
        "[Phase 10g] Backend selector: picked={} (layer={:?}, display={:?})",
        selected.backend.name(),
        selected.matched_layer,
        selected.framework_display
    );
    eprintln!(
        "[Phase 10g] Inputs: arch_cache={} chars, link_flags={:?}",
        architecture.len(),
        link_flags
    );
    Some(selected)
}

fn main() {
    // ULTRAPLAN Lightning Phase 10g.2 — run the backend selector
    // and keep the result for window creation below. `None` means
    // no sidecar was found (e.g. BYOR or pre-Phase-1 project);
    // we fall back to the legacy `init_sdl()` path in that case.
    //
    // The Box<dyn WindowBackend> is held in `selected_runtime_backend`
    // for the whole lifetime of main() — dropping it would unload
    // any dlopen'd library the backend holds (GLFW/raylib/SFML in
    // future wiring). For the SDL2 MVP this is belt-and-braces since
    // sdl_defs.rs already static-links libSDL2, but the pattern is
    // correct for the non-SDL backends we'll wire next.
    let mut selected_runtime_backend = select_backend_for_runner();

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
                debug_log!("[Runner] Starting in PROCESS-ISOLATED mode (safe default)");
                debug_log!("[Runner] Spawning supervisor to manage worker process...");

                // Mark that we're now supervising
                std::env::set_var("SYNTHI_SUPERVISED", "1");

                let config = process_isolation::IsolationConfig::default();
                let mut supervisor = process_isolation::ProcessSupervisor::new(config);

                if let Err(e) = supervisor.start() {
                    eprintln!("[Runner] FATAL: Failed to start supervisor: {}", e);
                    std::process::exit(1);
                }

                // Run the full supervisor event loop
                debug_log!("[Runner] Supervisor started, entering event loop");
                if let Err(e) = supervisor.run_event_loop() {
                    eprintln!("[Runner] Supervisor event loop error: {}", e);
                    std::process::exit(1);
                }

                debug_log!("[Runner] Supervisor event loop completed, exiting");
                std::process::exit(0);
            } else {
                debug_log!(
                    "[Runner] Running as supervised worker process (PID: {})",
                    std::process::id()
                );
                // v2.1: Verify we are receiving the correct environment
                if let Ok(parent_pid) = std::env::var("SYNTHI_SUPERVISOR_PID") {
                    debug_log!("[Runner] Managed by supervisor PID: {}", parent_pid);
                }
            }
        }
        #[allow(deprecated)]
        process_isolation::ExecutionMode::UnsafeInProcess => {
            // UNSAFE PATH - User explicitly opted in
            debug_log!("[Runner] ============================================================");
            eprintln!("[Runner] WARNING: Running in UNSAFE IN-PROCESS mode");
            debug_log!("[Runner] This mode is DEPRECATED and may cause process corruption");
            eprintln!("[Runner] dlclose UB can corrupt memory, leak resources, crash randomly");
            debug_log!("[Runner] Use SYNTHI_UNSAFE_INPROCESS=1 only for debugging");
            debug_log!("[Runner] ============================================================");
        }
    }

    // Install crash handlers for runtime error recovery
    // IMPORTANT: Set protection mode to SignalRecovery BEFORE installing handlers.
    // The runner uses thread-based execution (execute_with_protection spawns threads),
    // NOT fork-based isolation. ForkIsolation mode would call _exit() in the signal
    // handler, killing the entire runner process instead of just the crashed thread.
    eprintln!("[Runner] Installing crash handlers...");
    set_protection_mode(ProtectionMode::SignalRecovery);
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
        // Worker manages Xvfb — we still need an X11 connection for XTest
        // input injection (fake_input for mouse events).
        let display_str = std::env::var("DISPLAY").unwrap_or_else(|_| ":99".to_string());
        debug_log!(
            "[Runner] Worker manages display — connecting to {} for XTest input injection",
            display_str
        );
        match x11rb::connect(Some(&display_str)) {
            Ok((conn, screen_num)) => {
                let root = conn.setup().roots[screen_num].root;
                (None, Some(conn), screen_num, root)
            }
            Err(e) => {
                eprintln!(
                    "[Runner] Failed to connect to X11 display {}: {}. Mouse input disabled.",
                    display_str, e
                );
                (None, None, 0, 0u32)
            }
        }
    };

    // Initialize XTest extension for mouse input injection.
    // XTest fake_input bypasses window-manager passive grabs (with grab_control),
    // eliminating the WM interference that caused xdotool clicks to clear windows.
    // Also avoids spawning a process per event (5-10ms overhead + race conditions).
    #[cfg(target_os = "linux")]
    let xtest_ready = if let Some(ref conn) = x11_conn {
        match conn.xtest_get_version(2, 2u16) {
            Ok(cookie) => {
                match cookie.reply() {
                    Ok(ver) => {
                        debug_log!(
                            "[Runner] XTest extension v{}.{} available",
                            ver.major_version,
                            ver.minor_version
                        );
                        // Enable grab bypass: XTest events will not activate passive grabs
                        // (e.g. matchbox-WM's button grabs for click-to-focus). Without this,
                        // the WM intercepts every button event before the app sees it.
                        match conn.xtest_grab_control(true) {
                            Ok(_) => {
                                let _ = conn.flush();
                                debug_log!("[Runner] XTest grab_control(impervious=true) — WM grabs bypassed");
                                true
                            }
                            Err(e) => {
                                eprintln!("[Runner] XTest grab_control failed: {}. Falling back to xdotool.", e);
                                false
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "[Runner] XTest get_version failed: {}. Mouse input may not work.",
                            e
                        );
                        false
                    }
                }
            }
            Err(e) => {
                debug_log!(
                    "[Runner] XTest extension not available: {}. Mouse input may not work.",
                    e
                );
                false
            }
        }
    } else {
        false
    };

    // SHM is only needed when runner manages its own display (for frame capture).
    // When the worker manages display, GStreamer ximagesrc handles capture.
    #[cfg(target_os = "linux")]
    let (shm_seg, shm_ptr) = if !worker_managed_display {
        if let Some(ref conn) = x11_conn {
            let size = 800 * 600 * 4;
            let (id, ptr) = worker::runtime::runner::capture::create_shm_segment(size)
                .expect("Failed to create SHM");
            let seg = conn.generate_id().unwrap();
            conn.shm_attach(seg, id as u32, false).unwrap();
            (seg, ptr)
        } else {
            (0u32, ptr::null_mut())
        }
    } else {
        (0u32, ptr::null_mut())
    };

    // ULTRAPLAN Lightning Phase 10g.2-10g.4 — backend init via
    // WindowBackend trait. The selector picks a backend from the
    // sidecar; the trait's init + create_window run. For SDL2 we
    // also extract the raw_ptr/renderer_ptr into the legacy
    // `(window, renderer)` tuple so the existing SDL-specific
    // downstream code (sdl_window_id lookup, xdotool input
    // injection, etc.) keeps working. For non-SDL2 backends the
    // `window`/`renderer` tuple stays null — the runner operates
    // through the trait surface only, and SDL-specific downstream
    // code is gated on the null check (Phase 10g.4 — sdl_window_id
    // and the deleted _sdl_texture block).
    //
    // When the selector returns None (no sidecar — BYOR or smoke
    // test path) we fall back to the legacy init_sdl() path with
    // a null runtime_handle. Non-SDL backends have no legacy
    // fallback (the host needs to know the library shape) so an
    // init failure just propagates and the runner exits.
    #[cfg(target_os = "linux")]
    let mut runtime_handle: Option<worker::runtime::window_backend::WindowHandle> = None;
    #[cfg(target_os = "linux")]
    let (window, renderer) = {
        use worker::runtime::window_backend::{WindowBackend, WindowFlags};
        if let Some(selected) = selected_runtime_backend.as_mut() {
            let backend_name = selected.backend.name().to_string();
            match selected.backend.init() {
                Ok(()) => {
                    match selected.backend.create_window(
                        "Synthi Runner",
                        800,
                        600,
                        WindowFlags::default(),
                    ) {
                        Ok(handle) => {
                            eprintln!(
                                "[Phase 10g.4] WindowBackend trait created {} window \
                                 (win={:p}, renderer={:p}, x11_id={:?})",
                                backend_name,
                                handle.raw_ptr,
                                handle.renderer_ptr,
                                handle.x11_window_id,
                            );
                            // For SDL2, extract raw pointers for the
                            // legacy downstream call sites; for non-SDL
                            // backends the SDL-specific pointers stay
                            // null and downstream code branches on
                            // sdl_window_id / runtime_handle accordingly.
                            let (win, ren) = if backend_name == "SDL2" {
                                (handle.raw_ptr as *mut SDL_Window, handle.renderer_ptr)
                            } else {
                                (ptr::null_mut(), ptr::null_mut())
                            };
                            runtime_handle = Some(handle);
                            (win, ren)
                        }
                        Err(e) => {
                            eprintln!(
                                "[Phase 10g.4] WindowBackend create_window failed for {} ({}) — \
                                 falling back to legacy init_sdl (only safe for SDL2 projects)",
                                backend_name, e
                            );
                            unsafe { init_sdl() }
                        }
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[Phase 10g.4] WindowBackend init failed for {} ({}) — \
                         falling back to legacy init_sdl (only safe for SDL2 projects)",
                        backend_name, e
                    );
                    unsafe { init_sdl() }
                }
            }
        } else {
            // No sidecar. Happens on BYOR projects, smoke tests,
            // and any manual runner invocation without a workspace.
            // Default to SDL2 via the legacy init_sdl path — this
            // preserves pre-Phase-10g behavior for anything the
            // selector can't inspect.
            eprintln!(
                "[Phase 10g.4] No selector decision (no sidecar) — \
                 defaulting to legacy init_sdl path"
            );
            unsafe { init_sdl() }
        }
    };

    // Cache the SDL window ID for injected events (SDL assigns IDs starting
    // from 1). Using windowID=0 in injected events causes them to target a
    // non-existent window.
    //
    // ULTRAPLAN Lightning Phase 10g.4 — this ID is ONLY meaningful when
    // the backend is SDL2. Non-SDL backends (GLFW/raylib/SFML) don't speak
    // SDL_Event and won't receive xdotool-style input forwarding through
    // this ID; they use the X11-level input injection via x11_conn + XTest
    // instead. For those backends we leave sdl_window_id=0 and the event
    // injection path skips SDL entirely.
    #[cfg(target_os = "linux")]
    let sdl_window_id: u32 = {
        let backend_is_sdl2 = selected_runtime_backend
            .as_ref()
            .map(|s| s.backend.name() == "SDL2")
            .unwrap_or(true); // legacy init_sdl fallback is SDL2 by construction
        if backend_is_sdl2 && !window.is_null() {
            unsafe { SDL_GetWindowID(window as *mut SDL_Window) }
        } else {
            0
        }
    };
    #[cfg(not(target_os = "linux"))]
    let sdl_window_id: u32 = 0;

    // Phase 10g.4 — the SDL_CreateTexture block was dead code. The
    // texture handle was bound to `_sdl_texture` and never read
    // downstream (actual frame capture uses XShmGetImage via the
    // worker-managed GStreamer pipeline). Dropped entirely. If a
    // future rev needs an in-runner SDL texture pipeline for
    // headless-runner capture mode, it should go behind the
    // WindowBackend trait so non-SDL backends have an equivalent.

    // Initialize GStreamer
    if let Err(e) = gstreamer::init() {
        eprintln!("Failed to initialize GStreamer: {}", e);
    } else {
        debug_log!("GStreamer initialized.");
    }
    let _ = io::stdout().flush();

    debug_log!("Runner started. Waiting for commands...");

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
            debug_log!("[Runner] Raw video output DISABLED in ProcessIsolated mode (IPC active)");
        }
    }

    // Spawn input reader thread based on execution mode
    let tx_clone = tx.clone();
    let mode_for_thread = execution_mode;

    // Spawn stdin reader thread
    thread::spawn(move || {
        debug_log!("Input reader thread started (Mode: {:?})", mode_for_thread);
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
                                debug_log!("IPC connection closed (EOF)");
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
                            debug_log!("Stdin closed (EOF)");
                            break;
                        }
                        Ok(_) => {
                            let trimmed = line.trim().to_string();
                            if !trimmed.is_empty() {
                                debug_log!("Stdin received: {}", trimmed);
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
        debug_log!("Input reader thread exited");
    });

    let mut modules: HashMap<String, Library> = HashMap::new();
    let mut loaded_paths: HashMap<String, String> = HashMap::new();
    // Independent swap: Track state per module
    let mut module_states: HashMap<String, ModuleState> = HashMap::new();
    // Flicker prevention: skip render for one frame after a module load
    // so the new module's on_load has executed before on_render is called.
    let mut skip_render_frames: u32 = 0;

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
        debug_log!("[Runner] ModuleLoader ABI validation ENABLED");
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
    debug_log!("[Runner] StateManager initialized");

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
    debug_log!("[Runner] HmrOrchestrator initialized (binary_state=ENABLED)");

    #[cfg(not(target_os = "linux"))]
    let (window, renderer) = (ptr::null_mut(), ptr::null_mut());
    let mut app_state = AppState {
        raw: std::ptr::null_mut(),
        renderer,
    };
    let mut last_frame = Instant::now();
    let mut last_log = Instant::now();
    let mut last_motion_time = Instant::now();
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
        debug_log!("[Runner] Session ID from env: {}", sid);
    }
    let kv_api = create_kv_api();
    #[cfg(feature = "gpu-hmr")]
    let mut gpu_adapters: HashMap<String, GpuModuleAdapter> = HashMap::new();

    #[cfg(target_os = "linux")]
    debug_log!("[Runner] Frame capture enabled (Linux build)");
    #[cfg(not(target_os = "linux"))]
    debug_log!("[Runner] Frame capture DISABLED (non-Linux build)");

    // Notify supervisor that we are ready (if in isolated mode)
    if let process_isolation::ExecutionMode::ProcessIsolated = execution_mode {
        let mut stdout = io::stdout();
        let msg = process_isolation::IpcMessage::Ready;
        let payload = rmp_serde::to_vec(&msg).unwrap();

        if let Err(e) = write_frame_with_checksum(&mut stdout, &payload) {
            eprintln!("[Runner] Failed to send Ready message: {}", e);
        } else {
            let _ = stdout.flush();
            debug_log!("[Runner] Sent Ready message to supervisor");
        }
    }

    loop {
        // Poll SDL2 events and pass them to loaded modules.
        //
        // ULTRAPLAN Lightning Phase 10g.3b — route through the
        // WindowBackend trait's pump_events when a runtime_handle
        // was established (selector picked SDL2). Each event's
        // Raw payload is a pointer into sdl2_backend's event_arena
        // (stable until the NEXT pump_events call), which we cast
        // back to *mut SDL_Event for dispatch to user modules.
        // Behaviorally identical to the legacy SDL_PollEvent loop
        // for SDL2, but the dispatch surface is now library-agnostic
        // — a GLFW backend would pump glfw events, a raylib backend
        // would pump raylib events, etc.
        //
        // Fallback: when no runtime_handle is held (no sidecar
        // / non-SDL2 selector / trait init failure), run the
        // legacy direct SDL_PollEvent path. Drained events go
        // into a local Vec<SDL_Event> that outlives the pointer
        // collection used for dispatch.
        #[cfg(target_os = "linux")]
        if !window.is_null() {
            // Collect event pointers from whichever source. The
            // storage behind the pointers lives in either
            // sdl2_backend's event_arena (trait path) or the local
            // `legacy_drained` Vec (fallback path), both of which
            // outlive `event_ptrs`.
            let mut trait_events_buf: Vec<worker::runtime::window_backend::BackendEvent> =
                Vec::new();
            let mut legacy_drained: Vec<SDL_Event> = Vec::new();
            let used_trait = {
                use worker::runtime::window_backend::WindowBackend;
                if let (Some(_handle), Some(selected)) =
                    (runtime_handle.as_ref(), selected_runtime_backend.as_mut())
                {
                    selected.backend.pump_events(&mut trait_events_buf);
                    true
                } else {
                    false
                }
            };
            // ULTRAPLAN Lightning Phase 10g.5 — event_ptrs is now
            // typed as `*mut c_void` rather than `*mut SDL_Event`.
            // The pointer content is unchanged (it still points at
            // an SDL_Event for the SDL2 backend, and at GLFW /
            // raylib / SFML event data for those backends when the
            // runner is eventually paired with library-specific
            // user modules via Phase 10g.5 prompt changes). User
            // modules cast the `void*` to their library's event
            // type based on which library they were compiled
            // against — the same contract every library-agnostic
            // HMR runtime uses. SDL2 modules stay backward-compat
            // because `void core_on_event(void* state, void* evt)`
            // already takes a void*; only the Rust-side Symbol
            // type changed.
            let event_ptrs: Vec<*mut c_void> = if used_trait {
                use worker::runtime::window_backend::BackendEvent;
                trait_events_buf
                    .iter()
                    .filter_map(|ev| match ev {
                        BackendEvent::Raw { payload, .. } => Some(*payload as *mut c_void),
                        // Quit and Resized don't carry a Raw pointer;
                        // they're handled elsewhere by the runner
                        // (Quit → core state mutation via the Raw
                        // counterpart that SDL2Backend double-emits
                        // for SDL_QUIT).
                        _ => None,
                    })
                    .collect()
            } else {
                unsafe {
                    loop {
                        let mut event: SDL_Event = std::mem::zeroed();
                        if SDL_PollEvent(&mut event) == 0 {
                            break;
                        }
                        legacy_drained.push(event);
                    }
                }
                legacy_drained
                    .iter()
                    .map(|e| e as *const SDL_Event as *mut c_void)
                    .collect()
            };

            for &event_ptr in &event_ptrs {
                unsafe {
                    // SPLIT MODE: Events go to core module with core's state.
                    // Core handles button clicks, key presses, etc. that affect app state.
                    // GUI module can also receive events for hover/focus handling.
                    // Pass the opaque event pointer to every loaded module that
                    // exports on_event. The module casts to its library's
                    // event type (SDL_Event for SDL2 projects, GLFW event
                    // payload for GLFW projects, etc.) — the runner stays
                    // library-agnostic (Phase 10g.5).
                    for (name, lib) in modules.iter() {
                        let event_func: Result<
                            Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void)>,
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

                            // BUG FIX: Wrap on_event in crash protection, same as on_update.
                            // Previously this was a bare call — if user_event() crashed
                            // (SIGSEGV, etc.), the entire runner process died without recovery,
                            // causing the GUI app to "disappear" on click.
                            #[cfg(unix)]
                            {
                                let module_name = name.clone();
                                if let Some(lib_path) = loaded_paths.get(name) {
                                    set_current_lib_path(lib_path);
                                }
                                let state_ptr_wrapper = SendVoidPtr(state_ptr as usize);
                                // Phase 10g.3b: `event` is now a `&mut SDL_Event`
                                // re-borrowed from an event pointer yielded by
                                // pump_events / legacy drain, so the cast is
                                // event_ptr (already *mut SDL_Event). We wrap
                                // the raw pointer directly, skipping the
                                // &mut → ptr re-cast the old stack-local path
                                // used to do.
                                let event_ptr_wrapper = SendVoidPtr(event_ptr as usize);
                                let func_ptr = *f;
                                let result = execute_with_protection(&module_name, move || {
                                    let sp = state_ptr_wrapper.0 as *mut std::ffi::c_void;
                                    // Phase 10g.5 — opaque void* so the
                                    // same dispatch path works for any
                                    // backend's event payload. Module
                                    // casts based on its own #include.
                                    let ep = event_ptr_wrapper.0 as *mut std::ffi::c_void;
                                    func_ptr(sp, ep);
                                });
                                if let Err(crash_info) = result {
                                    eprintln!("{}", generate_crash_report(&crash_info));
                                    let status = HmrCrashStatus::from_crash(&crash_info, true);
                                    debug_log!("[Runner] [HMR-STATUS] {}", status.to_json());
                                    eprintln!(
                                        "[Runner] on_event crash in module '{}' — continuing",
                                        name
                                    );
                                    // Don't kill the runner; skip this module's event and continue
                                }
                            }
                            #[cfg(not(unix))]
                            {
                                f(state_ptr, &mut event);
                            }
                        }
                    }
                }
            }
        }

        if last_log.elapsed() > Duration::from_secs(5) {
            // Keep stdout clean for raw frame bytes; log diagnostics to stderr instead.
            debug_log!(
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
                            debug_log!("[Runner] Ping received (seq={})", seq);
                            String::new()
                        }
                        _ => {
                            debug_log!("[Runner] Unhandled IPC message: {:?}", msg);
                            String::new()
                        }
                    }
                }
            };

            if cmd.is_empty() {
                continue;
            }

            // Route command logs to stderr so stdout stays dedicated to the video stream.
            debug_log!("[Runner] Processing command: {}", cmd);
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
                            debug_log!("[Runner] [HOST-KV] Session already set: {}", new_session);
                            continue;
                        }

                        // Set the session
                        session_id = Some(new_session.clone());
                        session_id_cstring = CString::new(new_session.clone()).ok();

                        debug_log!("[Runner] [HOST-KV] Session set: {}", new_session);

                        // Emit status event
                        let status = HmrStatus::host_kv_ready(&new_session, "pending");
                        debug_log!("[Runner] [HMR-STATUS] {}", status.to_json());
                    } else {
                        debug_log!(
                            "[Runner] [HOST-KV] ERROR: set_session requires session_id argument"
                        );
                    }
                }

                "input" => {
                    #[cfg(target_os = "linux")]
                    if parts.len() >= 2 {
                        // XTest fake_input for mouse; SDL_PushEvent for keyboard.
                        //
                        // XTest with grab_control(impervious=true) bypasses
                        // window-manager passive grabs entirely. This fixes the
                        // issue where matchbox-WM intercepted xdotool button
                        // events, causing the user's X11 app to redraw incorrectly
                        // (text/components disappearing on click).
                        //
                        // XTest also eliminates per-event process spawning (~5-10ms
                        // xdotool overhead) and race conditions between concurrent
                        // xdotool processes.
                        //
                        // XTest event types:
                        //   2 = KeyPress, 3 = KeyRelease
                        //   4 = ButtonPress, 5 = ButtonRelease
                        //   6 = MotionNotify
                        match parts[1] {
                            "motion" => {
                                if parts.len() >= 4 {
                                    // Rate-limit motion to ~60fps
                                    let now = Instant::now();
                                    if now.duration_since(last_motion_time).as_millis() >= 16 {
                                        last_motion_time = now;
                                        let x = parts[2].parse::<i16>().unwrap_or(0);
                                        let y = parts[3].parse::<i16>().unwrap_or(0);
                                        if xtest_ready {
                                            if let Some(ref conn) = x11_conn {
                                                // MotionNotify: detail=0, root_x/root_y = target position, deviceid=0 (server default)
                                                let _ = conn
                                                    .xtest_fake_input(6, 0, 0, x11_root, x, y, 0);
                                                let _ = conn.flush();
                                            }
                                        }
                                    }
                                }
                            }
                            "button" => {
                                if parts.len() >= 6 {
                                    let type_str = parts[2];
                                    let btn: u8 = parts[3].parse().unwrap_or(1);
                                    let x = parts[4].parse::<i16>().unwrap_or(0);
                                    let y = parts[5].parse::<i16>().unwrap_or(0);

                                    if xtest_ready {
                                        if let Some(ref conn) = x11_conn {
                                            // Warp pointer to click position first,
                                            // then send button event (which fires at
                                            // the current pointer position).
                                            let _ =
                                                conn.xtest_fake_input(6, 0, 0, x11_root, x, y, 0);
                                            let event_type: u8 =
                                                if type_str == "down" { 4 } else { 5 };
                                            let _ = conn.xtest_fake_input(
                                                event_type, btn, 0, x11_root, 0, 0, 0,
                                            );
                                            let _ = conn.flush();
                                        }
                                    }
                                }
                            }
                            "key" => {
                                if parts.len() >= 4 {
                                    let type_str = parts[2];
                                    let keycode = parts[3].parse::<i32>().unwrap_or(0);

                                    // For keyboard events, use SDL_PushEvent since
                                    // xdotool uses X11 keysyms which differ from SDL
                                    // keycodes. SDL_PushEvent works reliably for keyboard
                                    // events processed via SDL_PollEvent / on_event.
                                    unsafe {
                                        let event_type = if type_str == "down" {
                                            SDL_KEYDOWN
                                        } else {
                                            SDL_KEYUP
                                        };

                                        let mut event: SDL_Event = std::mem::zeroed();
                                        let event_ptr = event.data.as_mut_ptr();
                                        *(event_ptr as *mut u32) = event_type;
                                        *(event_ptr.add(4) as *mut u32) = 0; // timestamp
                                        *(event_ptr.add(8) as *mut u32) = sdl_window_id; // windowID
                                        *(event_ptr.add(12) as *mut u8) =
                                            if type_str == "down" { 1 } else { 0 };
                                        *(event_ptr.add(13) as *mut u8) = 0; // repeat
                                        *(event_ptr.add(16) as *mut u32) = keycode as u32; // scancode
                                        *(event_ptr.add(20) as *mut i32) = keycode; // sym
                                        *(event_ptr.add(24) as *mut u16) = 0; // mod

                                        SDL_PushEvent(&mut event);
                                    }
                                }
                            }
                            _ => {
                                debug_log!("[Runner] Unknown input type: {}", parts[1]);
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

                    debug_log!("[Runner] Loading module '{}' from {}", name, path);

                    if let Some(current_path) = loaded_paths.get(name) {
                        if current_path == path {
                            debug_log!(
                                "[Runner] Module '{}' already loaded from {}. Skipping.",
                                name,
                                path
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
                        );
                    }
                    // Skip render for 1 frame to let on_load initialize state
                    // before on_render uses it — prevents flicker
                    skip_render_frames = 1;
                }
                "load_device" => {
                    // usage: load_device <cuda|rocm|hip> <cubin|hsaco> <kernel1,kernel2,...|->
                    #[cfg(feature = "gpu-hmr")]
                    {
                        if parts.len() < 3 {
                            eprintln!("[Runner] [GPU HMR] Invalid load_device command format");
                            continue;
                        }

                        let vendor_raw = parts[1];
                        let artifact_path = parts[2];
                        let kernels_arg = parts.get(3).copied().unwrap_or("-");
                        let kernels: Vec<String> = kernels_arg
                            .split(',')
                            .filter(|s| !s.trim().is_empty() && *s != "-")
                            .map(|s| s.trim().to_string())
                            .collect();

                        let (language, vendor) = match vendor_raw {
                            "cuda" => ("cuda", GpuVendor::Cuda),
                            "rocm" | "hip" => ("rocm", GpuVendor::Rocm),
                            other => {
                                eprintln!("[Runner] [GPU HMR] Unknown device vendor '{}'", other);
                                continue;
                            }
                        };

                        if !gpu_adapters.contains_key(language) {
                            let mut adapter = GpuModuleAdapter::new(GpuModuleAdapterConfig {
                                vendor,
                                ..Default::default()
                            });
                            if let Err(e) = adapter.initialize() {
                                eprintln!(
                                    "[Runner] [GPU HMR] Device adapter init failed vendor={}: {}",
                                    language, e
                                );
                            }
                            gpu_adapters.insert(language.to_string(), adapter);
                        }

                        let artifact_hash = std::fs::metadata(artifact_path)
                            .map(|m| m.len().to_string())
                            .unwrap_or_else(|_| "unknown".to_string());
                        let manifest = BuildManifest::for_language(
                            session_id
                                .clone()
                                .unwrap_or_else(|| "runner-gpu".to_string()),
                            language,
                        )
                        .with_slot(BuildSlot::Custom("device".into()))
                        .with_artifact(artifact_path, &artifact_hash)
                        .with_abi_version(&kernels.join("|"))
                        .with_state_schema_hash(&artifact_hash)
                        .with_dirty_units(vec![if vendor == GpuVendor::Cuda {
                            "device.cu".to_string()
                        } else {
                            "device.hip".to_string()
                        }])
                        .with_exported_symbols(kernels.clone())
                        .with_capabilities(vec![
                            "gpu_sidecar_module".to_string(),
                            "synthi_gpu_launch".to_string(),
                        ])
                        .with_snapshot_modes(vec![SnapshotMode::Binary]);

                        let req = AdapterReloadRequest {
                            reload_id: format!("runner-device-{}-{}", language, frame_count),
                            module_id: "device".into(),
                            changed_files: manifest.dirty_units.clone().unwrap_or_default(),
                            build_manifest: manifest,
                            preserve_state: true,
                            timeout_ms: 5000,
                        };

                        if let Some(adapter) = gpu_adapters.get_mut(language) {
                            let result = adapter.reload(&req);
                            eprintln!(
                                "[Runner] [GPU HMR] Device sidecar reload vendor={} artifact={} kernels={} result={:?}",
                                language,
                                artifact_path,
                                kernels.join(","),
                                result
                            );
                        }
                    }

                    #[cfg(not(feature = "gpu-hmr"))]
                    {
                        eprintln!(
                            "[Runner] [GPU HMR] load_device ignored; runner built without gpu-hmr"
                        );
                    }
                }
                "unload" => {
                    if parts.len() == 2 {
                        let name = parts[1];
                        debug_log!("[Runner] Unloading module '{}'", name);
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
                            debug_log!("[Runner] Unloaded module {}", name);
                        }
                    }
                }
                "quit" => {
                    debug_log!("[Runner] Quitting.");
                    // ULTRAPLAN Lightning Phase 10g.3c — route
                    // shutdown through the WindowBackend trait when
                    // the trait path was taken (runtime_handle is
                    // Some). Calls destroy_window with the stored
                    // handle, then shutdown to release any dlopen'd
                    // library (critical for GLFW/raylib/SFML future
                    // wiring; a no-op for SDL2 since sdl_defs.rs
                    // static-links libSDL2).
                    //
                    // Fallback path (no runtime_handle) still calls
                    // SDL_Quit directly, preserving pre-10g.2
                    // behavior for BYOR / sidecar-less runs.
                    #[cfg(target_os = "linux")]
                    {
                        use worker::runtime::window_backend::WindowBackend;
                        let handled_via_trait = if let (Some(handle), Some(selected)) =
                            (runtime_handle.take(), selected_runtime_backend.as_mut())
                        {
                            selected.backend.destroy_window(handle);
                            selected.backend.shutdown();
                            true
                        } else {
                            false
                        };
                        if !handled_via_trait {
                            unsafe {
                                SDL_Quit();
                            }
                        }
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

                                // Check if supervisor thinks we should restart
                                // (too many consecutive crashes without recovery).
                                // NOTE: We intentionally do NOT treat SIGSEGV as
                                // unconditionally fatal because our thread-based
                                // crash protection isolates the crash to the plugin
                                // thread.  The runner's own heap and SDL state are
                                // safe since the faulting thread is terminated via
                                // pthread_exit and never touches shared state again.
                                let force_restart = recovery_action == RecoveryAction::FullRestart
                                    || recovery_action == RecoveryAction::Fatal
                                    || (supervisor_enabled
                                        && crash_supervisor.should_force_restart());

                                let status =
                                    HmrCrashStatus::from_crash(&crash_info, !force_restart);
                                debug_log!("[Runner] [HMR-STATUS] {}", status.to_json());
                                debug_log!("[Runner] Recovery action: {:?}", recovery_action);

                                if force_restart {
                                    eprintln!("[Runner] Too many consecutive crashes (action={:?}). Exiting for cold restart.", recovery_action);
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
        // BUG FIX: Wrap all on_render calls in crash protection. Previously
        // a click that corrupted module state would cause an unprotected
        // on_render to SIGSEGV, killing the runner process ("app disappears
        // when user clicks a button").
        //
        // Flicker prevention: after a module load, skip rendering for one
        // frame so on_load has time to initialize state.  The previous
        // frame stays visible on the X11 framebuffer (ximagesrc captures it).
        if skip_render_frames > 0 {
            skip_render_frames -= 1;
        } else if let Some(lib) = modules.get("gui") {
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
                    app_state.raw
                } else {
                    module_states
                        .get("gui")
                        .map(|s| s.state_ptr)
                        .unwrap_or(app_state.raw)
                };

                if let Some(f) = render_func {
                    #[cfg(unix)]
                    {
                        if let Some(lib_path) = loaded_paths.get("gui") {
                            set_current_lib_path(lib_path);
                        }
                        let state_ptr_wrapper = SendVoidPtr(render_state as usize);
                        let func_ptr = *f;
                        let result = execute_with_protection("gui_render", move || {
                            let sp = state_ptr_wrapper.0 as *mut std::ffi::c_void;
                            func_ptr(sp);
                        });
                        if let Err(crash_info) = result {
                            eprintln!("{}", generate_crash_report(&crash_info));
                            let status = HmrCrashStatus::from_crash(&crash_info, true);
                            debug_log!("[Runner] [HMR-STATUS] {}", status.to_json());
                            eprintln!("[Runner] on_render crash in module 'gui' — continuing");
                        }
                    }
                    #[cfg(not(unix))]
                    {
                        f(render_state);
                    }
                }
            }
        } else if let Some(lib) = modules.get("core") {
            unsafe {
                let render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                    lib.get(b"on_render");
                if let Ok(f) = render_func {
                    #[cfg(unix)]
                    {
                        if let Some(lib_path) = loaded_paths.get("core") {
                            set_current_lib_path(lib_path);
                        }
                        let state_ptr_wrapper = SendVoidPtr(app_state.raw as usize);
                        let func_ptr = *f;
                        let result = execute_with_protection("core_render", move || {
                            let sp = state_ptr_wrapper.0 as *mut std::ffi::c_void;
                            func_ptr(sp);
                        });
                        if let Err(crash_info) = result {
                            eprintln!("{}", generate_crash_report(&crash_info));
                            let status = HmrCrashStatus::from_crash(&crash_info, true);
                            debug_log!("[Runner] [HMR-STATUS] {}", status.to_json());
                            eprintln!("[Runner] on_render crash in module 'core' — continuing");
                        }
                    }
                    #[cfg(not(unix))]
                    {
                        f(app_state.raw);
                    }
                }
            }
        } else if let Some(lib) = modules.get("main") {
            unsafe {
                let render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                    lib.get(b"on_render");
                let gui_render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                    lib.get(b"gui_render");

                let func_to_call: Option<Symbol<unsafe extern "C" fn(*mut c_void)>> =
                    if let Ok(f) = render_func {
                        Some(f)
                    } else if let Ok(f) = gui_render_func {
                        Some(f)
                    } else {
                        None
                    };

                if let Some(f) = func_to_call {
                    #[cfg(unix)]
                    {
                        if let Some(lib_path) = loaded_paths.get("main") {
                            set_current_lib_path(lib_path);
                        }
                        let state_ptr_wrapper = SendVoidPtr(app_state.raw as usize);
                        let func_ptr = *f;
                        let result = execute_with_protection("main_render", move || {
                            let sp = state_ptr_wrapper.0 as *mut std::ffi::c_void;
                            func_ptr(sp);
                        });
                        if let Err(crash_info) = result {
                            eprintln!("{}", generate_crash_report(&crash_info));
                            let status = HmrCrashStatus::from_crash(&crash_info, true);
                            debug_log!("[Runner] [HMR-STATUS] {}", status.to_json());
                            eprintln!("[Runner] on_render crash in module 'main' — continuing");
                        }
                    }
                    #[cfg(not(unix))]
                    {
                        f(app_state.raw);
                    }
                }
            }
        }

        // Present the SDL renderer BEFORE capturing from Xvfb.
        // This ensures the plugin's rendering is visible in the capture.
        //
        // ULTRAPLAN Lightning Phase 10g.3a — route through the
        // WindowBackend trait when runtime_handle is Some (set by
        // 10g.2 when the selector picked SDL2). For SDL2 the trait
        // call is behaviorally identical to SDL_RenderPresent with
        // the same renderer pointer, but it exercises the trait
        // surface so future non-SDL backends can swap in without
        // touching the main loop. Falls back to direct
        // SDL_RenderPresent when no handle is held (sidecar-less
        // path or non-SDL2 selector decision).
        #[cfg(target_os = "linux")]
        {
            use worker::runtime::window_backend::WindowBackend;
            let mut presented_via_trait = false;
            if let (Some(handle), Some(selected)) =
                (runtime_handle.as_ref(), selected_runtime_backend.as_mut())
            {
                if let Err(e) = selected.backend.present_frame(handle) {
                    eprintln!(
                        "[Phase 10g.3a] WindowBackend present_frame failed ({}) — \
                         falling back to direct SDL_RenderPresent for this frame",
                        e
                    );
                } else {
                    presented_via_trait = true;
                }
            }
            if !presented_via_trait && !renderer.is_null() {
                unsafe {
                    SDL_RenderPresent(renderer);
                }
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
                &mut last_frame_log,
            );
        }

        // Cap at ~60 FPS
        let elapsed = now.elapsed();
        if elapsed < Duration::from_millis(16) {
            thread::sleep(Duration::from_millis(16) - elapsed);
        }
    } // end of loop
} // end of main
