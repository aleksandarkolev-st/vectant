use libloading::{Library, Symbol};
use std::io::{self, BufRead, Write};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use std::ffi::{c_void, c_int, c_uint, CString};
use std::ptr;
use std::collections::HashMap;

// Wrapper types to make raw pointers thread-safe to move across threads
#[derive(Clone, Copy)]
struct SendVoidPtr(pub usize);
unsafe impl Send for SendVoidPtr {}
unsafe impl Sync for SendVoidPtr {}

#[cfg(target_os = "linux")]
use std::process::Command;

#[cfg(target_os = "linux")]
use x11rb::connection::Connection;
#[cfg(target_os = "linux")]
use x11rb::protocol::xproto::*;
#[cfg(target_os = "linux")]
use x11rb::protocol::shm::ConnectionExt as ShmConnectionExt;

mod plugin_contract;
mod capability;
mod host_kv;
mod state_diff;
mod crash_recovery;
mod source_map;

use plugin_contract::{ModuleSlot, CORE_STATE_MAGIC, GUI_STATE_MAGIC, SYNTHI_CORE_ABI_VERSION, SYNTHI_GUI_ABI_VERSION};
use capability::{HmrCapability, detect_capabilities, HmrStatus};
use host_kv::{
    KV_STORE, SynthiHostContextV1, HostKvSchemaEvent,
    create_kv_api, read_schema_table, module_slot_to_u32,
};
use state_diff::{migrate_state, generate_migration_report};
use crash_recovery::{install_crash_handlers, execute_with_protection, should_force_restart, 
                     reset_crash_count, HmrCrashStatus, generate_crash_report, set_current_lib_path};

// SDL2 Definitions
#[cfg(target_os = "linux")]
type SDL_Window = c_void;

#[cfg(target_os = "linux")]
#[repr(C)]
struct SDL_Event {
    data: [u8; 128], // Generous padding for SDL_Event union
}

#[cfg(target_os = "linux")]
#[link(name = "SDL2")]
extern "C" {
    fn SDL_Init(flags: u32) -> c_int;
    fn SDL_CreateWindow(title: *const i8, x: c_int, y: c_int, w: c_int, h: c_int, flags: u32) -> *mut SDL_Window;
    fn SDL_CreateRenderer(window: *mut SDL_Window, index: c_int, flags: u32) -> *mut c_void;
    fn SDL_RenderReadPixels(renderer: *mut c_void, rect: *const c_void, format: u32, pixels: *mut c_void, pitch: c_int) -> c_int;
    fn SDL_RenderPresent(renderer: *mut c_void);
    fn SDL_SetRenderDrawColor(renderer: *mut c_void, r: u8, g: u8, b: u8, a: u8) -> c_int;
    fn SDL_RenderClear(renderer: *mut c_void) -> c_int;
    fn SDL_CreateTexture(renderer: *mut c_void, format: u32, access: c_int, w: c_int, h: c_int) -> *mut c_void;
    fn SDL_UpdateTexture(texture: *mut c_void, rect: *const c_void, pixels: *const c_void, pitch: c_int) -> c_int;
    fn SDL_RenderCopy(renderer: *mut c_void, texture: *mut c_void, srcrect: *const c_void, dstrect: *const c_void) -> c_int;
    fn SDL_PollEvent(event: *mut SDL_Event) -> c_int;
    fn SDL_PushEvent(event: *mut SDL_Event) -> c_int;
    fn SDL_Quit();
    fn SDL_GetError() -> *const i8;
}

// SDL2 Event Types
#[cfg(target_os = "linux")]
const SDL_MOUSEMOTION: u32 = 0x400;
#[cfg(target_os = "linux")]
const SDL_MOUSEBUTTONDOWN: u32 = 0x401;
#[cfg(target_os = "linux")]
const SDL_MOUSEBUTTONUP: u32 = 0x402;
#[cfg(target_os = "linux")]
const SDL_KEYDOWN: u32 = 0x300;
#[cfg(target_os = "linux")]
const SDL_KEYUP: u32 = 0x301;

const SDL_INIT_VIDEO: u32 = 0x00000020;
const SDL_WINDOW_SHOWN: u32 = 0x00000004;
const SDL_WINDOWPOS_UNDEFINED: c_int = 0x1FFF0000; // SDL_WINDOWPOS_UNDEFINED_MASK | 0
const SDL_RENDERER_ACCELERATED: u32 = 0x00000002;
const SDL_RENDERER_SOFTWARE: u32 = 0x00000001;
const SDL_PIXELFORMAT_RGBA8888: u32 = 373694468;
const SDL_TEXTUREACCESS_STREAMING: c_int = 1;


// ============================================================
// INDEPENDENT SWAP DOMAINS: Separate state for each module
// ============================================================
// Each module (core, gui) has its own state pointer.
// This allows:
// 1. GUI reload without touching core state
// 2. Core reload triggers GUI reload (ABI change)
// 3. State migration runs only for the affected module
// ============================================================

// Legacy state container - still used for backward compatibility with "main" module
struct AppState {
    raw: *mut c_void,
    renderer: *mut c_void,
}

// Per-module state tracking for independent swaps
// Enhanced to track ABI version and CoreAPI pointer for proper HMR
struct ModuleState {
    state_ptr: *mut c_void,      // Module's own state (CoreState or GuiState)
    abi_version: u32,            // ABI version reported by the module
    schema_hash: u64,            // Schema hash for strict binary compatibility check
    core_api_ptr: *mut c_void,   // For GUI: pointer to CoreAPI from core module
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

// Validation helper: check state header magic and size
unsafe fn validate_state_magic(state: *mut c_void, expected_magic: u32) -> bool {
    if state.is_null() { return false; }
    let magic = *(state as *const u32);
    magic == expected_magic
}

// Extract ABI version from state header (third u32 field)
unsafe fn get_module_abi_version(state: *mut c_void) -> u32 {
    if state.is_null() { return 0; }
    *((state as *const u32).add(2))
}

#[repr(C)]
struct HostContext {
    window: *mut c_void,
    renderer: *mut c_void,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

#[cfg(target_os = "linux")]
fn create_shm_segment(size: usize) -> Option<(i32, *mut u8)> {
    unsafe {
        let shmid = libc::shmget(libc::IPC_PRIVATE, size, libc::IPC_CREAT | 0o777);
        if shmid == -1 { return None; }
        let ptr = libc::shmat(shmid, ptr::null(), 0);
        if ptr == ( -1 as isize as *mut c_void ) {
            libc::shmctl(shmid, libc::IPC_RMID, ptr::null_mut());
            return None;
        }
        // Mark for destruction
        libc::shmctl(shmid, libc::IPC_RMID, ptr::null_mut());
        Some((shmid, ptr as *mut u8))
    }
}

fn main() {
    // Install crash handlers for runtime error recovery
    if let Err(e) = install_crash_handlers() {
        eprintln!("[Runner] Warning: Failed to install crash handlers: {}", e);
    }
    
    // Spawn Xvfb and setup X11
    #[cfg(target_os = "linux")]
    let (_xvfb_proc, x11_conn, x11_screen_num, x11_root) = {
        let mut cmd = Command::new("Xvfb");
        cmd.args(&[":99", "-screen", "0", "800x600x24"]);
        let child = cmd.spawn().ok();
        thread::sleep(Duration::from_millis(100));
        std::env::set_var("DISPLAY", ":99");
        let (conn, screen_num) = x11rb::connect(Some(":99")).expect("Failed to connect to X11");
        let root = conn.setup().roots[screen_num].root;
        (child, conn, screen_num, root)
    };

    #[cfg(target_os = "linux")]
    let (shm_seg, shm_ptr) = {
        let size = 800 * 600 * 4;
        let (id, ptr) = create_shm_segment(size).expect("Failed to create SHM");
        let seg = x11_conn.generate_id().unwrap();
        x11_conn.shm_attach(seg, id as u32, false).unwrap();
        (seg, ptr)
    };

    // Initialize SDL2
    #[cfg(target_os = "linux")]
    let (window, renderer) = unsafe {
        if SDL_Init(SDL_INIT_VIDEO) < 0 {
            eprintln!("SDL_Init failed");
            (ptr::null_mut(), ptr::null_mut())
        } else {
            eprintln!("SDL_Init successful.");
            // Create the window here so we can pass it to the shared library
            let title = std::ffi::CString::new("Synthi Runner").unwrap();
            let win = SDL_CreateWindow(
                title.as_ptr(),
                SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,
                800, 600,
                SDL_WINDOW_SHOWN
            );
            if win.is_null() {
                eprintln!("SDL_CreateWindow failed");
                (ptr::null_mut(), ptr::null_mut())
            } else {
                eprintln!("SDL_CreateWindow successful. Window ptr: {:p}", win);
                let ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);
                let ren = if ren.is_null() {
                    SDL_CreateRenderer(win, -1, SDL_RENDERER_SOFTWARE)
                } else {
                    ren
                };
                if ren.is_null() {
                    eprintln!("SDL_CreateRenderer failed");
                }
                (win, ren)
            }
        }
    };

    #[cfg(target_os = "linux")]
    let sdl_texture = unsafe {
        if !renderer.is_null() {
            SDL_CreateTexture(renderer, SDL_PIXELFORMAT_RGBA8888, SDL_TEXTUREACCESS_STREAMING, 800, 600)
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

    let (tx, rx) = mpsc::channel::<String>();

    // Frame pipe to stdout (non-blocking for the main loop)
    // We keep the channel tiny and drop frames when the pipe is backed up so on_update keeps running.
    #[cfg(target_os = "linux")]
    let (frame_tx, frame_rx) = mpsc::sync_channel::<Vec<u8>>(2);

    // Dedicated writer so rendering never blocks on stdout backpressure
    #[cfg(target_os = "linux")]
    {
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
    }
    
    // Spawn stdin reader thread
    thread::spawn(move || {
        eprintln!("Stdin reader thread started");
        let stdin = io::stdin();
        let mut handle = stdin.lock();
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
                        if let Err(e) = tx.send(trimmed) {
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
        eprintln!("Stdin reader thread exited");
    });

    let mut modules: HashMap<String, Library> = HashMap::new();
    let mut loaded_paths: HashMap<String, String> = HashMap::new();
    // Independent swap: Track state per module
    let mut module_states: HashMap<String, ModuleState> = HashMap::new();
    #[cfg(not(target_os = "linux"))]
    let (window, renderer) = (ptr::null_mut(), ptr::null_mut());
    let mut app_state = AppState { raw: std::ptr::null_mut(), renderer };
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
    let mut session_id: Option<String> = None;
    let mut session_id_cstring: Option<CString> = None;
    let kv_api = create_kv_api();
    
    #[cfg(target_os = "linux")]
    eprintln!("[Runner] Frame capture enabled (Linux build)");
    #[cfg(not(target_os = "linux"))]
    eprintln!("[Runner] Frame capture DISABLED (non-Linux build)");

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
                        let event_func: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut SDL_Event)>, _> = lib.get(b"on_event");
                        if let Ok(f) = event_func {
                            // CRITICAL FIX: In split mode, both core and GUI should receive
                            // core's state for events. Core handles state changes (pause, quit),
                            // and if GUI has on_event it should also see core's state.
                            let state_ptr = if modules.contains_key("core") && !app_state.raw.is_null() {
                                // Split mode: use core's state for all event handlers
                                app_state.raw
                            } else if name == "gui" {
                                // GUI-only mode: use GUI's own state
                                module_states.get(name).map(|s| s.state_ptr).unwrap_or(app_state.raw)
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
            eprintln!("[Runner] Heartbeat. Modules: {}, FPS: {:.2}", modules.len(), 1.0 / last_frame.elapsed().as_secs_f64().max(0.001));
            last_log = Instant::now();
        }

        // Process all pending commands
        while let Ok(cmd) = rx.try_recv() {
            // Route command logs to stderr so stdout stays dedicated to the video stream.
            eprintln!("[Runner] Processing command: {}", cmd);
            let parts: Vec<&str> = cmd.split_whitespace().collect();
            if parts.is_empty() { continue; }

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
                        eprintln!("[Runner] [HOST-KV] ERROR: set_session requires session_id argument");
                    }
                },
                
                "input" => {
                    #[cfg(target_os = "linux")]
                    if parts.len() >= 2 {
                        // Create SDL events and push them to SDL's event queue
                        // This ensures they get picked up by SDL_PollEvent and passed to on_event
                        unsafe {
                            match parts[1] {
                                "motion" => {
                                    if parts.len() >= 4 {
                                        if let (Ok(x), Ok(y)) = (parts[2].parse::<i32>(), parts[3].parse::<i32>()) {
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
                                            eprintln!("[Runner] Pushed SDL mouse motion event: ({}, {})", x, y);
                                        }
                                    }
                                },
                                "button" => {
                                    if parts.len() >= 6 {
                                        let type_str = parts[2];
                                        let btn = parts[3].parse::<u8>().unwrap_or(1);
                                        let x = parts[4].parse::<i32>().unwrap_or(0);
                                        let y = parts[5].parse::<i32>().unwrap_or(0);
                                        
                                        let event_type = if type_str == "down" { SDL_MOUSEBUTTONDOWN } else { SDL_MOUSEBUTTONUP };
                                        
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
                                        *(event_ptr.add(17) as *mut u8) = if type_str == "down" { 1 } else { 0 }; // state
                                        *(event_ptr.add(18) as *mut u8) = 1; // clicks
                                        *(event_ptr.add(20) as *mut i32) = x; // x
                                        *(event_ptr.add(24) as *mut i32) = y; // y
                                        
                                        SDL_PushEvent(&mut event);
                                        eprintln!("[Runner] Pushed SDL mouse {} event: btn={}, ({}, {})", type_str, btn, x, y);
                                    }
                                },
                                "key" => {
                                    if parts.len() >= 4 {
                                        let type_str = parts[2];
                                        let keycode = parts[3].parse::<i32>().unwrap_or(0);
                                        
                                        let event_type = if type_str == "down" { SDL_KEYDOWN } else { SDL_KEYUP };
                                        
                                        // Create SDL_KeyboardEvent
                                        let mut event: SDL_Event = std::mem::zeroed();
                                        let event_ptr = event.data.as_mut_ptr();
                                        // SDL_KeyboardEvent layout:
                                        // type (u32), timestamp (u32), windowID (u32), state (u8), repeat (u8), padding (u16), keysym (SDL_Keysym)
                                        // SDL_Keysym: scancode (u32), sym (i32), mod (u16), unused (u32)
                                        *(event_ptr as *mut u32) = event_type;
                                        *(event_ptr.add(4) as *mut u32) = 0; // timestamp
                                        *(event_ptr.add(8) as *mut u32) = 0; // windowID
                                        *(event_ptr.add(12) as *mut u8) = if type_str == "down" { 1 } else { 0 }; // state
                                        *(event_ptr.add(13) as *mut u8) = 0; // repeat
                                        // keysym starts at offset 16
                                        *(event_ptr.add(16) as *mut u32) = keycode as u32; // scancode
                                        *(event_ptr.add(20) as *mut i32) = keycode; // sym (SDLK_*)
                                        *(event_ptr.add(24) as *mut u16) = 0; // mod
                                        
                                        SDL_PushEvent(&mut event);
                                        eprintln!("[Runner] Pushed SDL key {} event: keycode={}", type_str, keycode);
                                    }
                                },
                                _ => {
                                    eprintln!("[Runner] Unknown input type: {}", parts[1]);
                                }
                            }
                        }
                    }
                },
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
                            eprintln!("[Runner] Module '{}' already loaded from {}. Skipping.", name, path);
                            continue;
                        }
                    }

                    unsafe {
                        // ============================================================
                        // ATOMIC-SWAP HMR: Zero-flicker hot module replacement
                        // ============================================================
                        // Strategy:
                        // 1. Load NEW library while OLD is still active (old keeps rendering)
                        // 2. Save state from OLD module
                        // 3. Pre-initialize NEW module with saved state + graphics
                        // 4. ATOMIC SWAP: Replace module reference in single operation
                        // 5. Defer OLD module cleanup (on_unload + drop) until after swap
                        // ============================================================
                        
                        eprintln!("[Runner] [HMR] Phase 1: Loading new library (old still active): {}", path);
                        #[cfg(unix)]
                        let lib_result = {
                            use libloading::os::unix::{Library, RTLD_NOW, RTLD_LOCAL};
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
                                let mut has_required_symbols = false;
                                let mut module_abi_version: u32 = 0;
                                
                                match slot {
                                    Some(ModuleSlot::Core) => {
                                        // Core module: require core_on_load, core_on_update, core_get_api
                                        // OR legacy on_load/on_update for backward compat
                                        let core_load: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>, _> = new_lib.get(b"core_on_load");
                                        let core_update: Result<Symbol<unsafe extern "C" fn(*mut c_void, f64)>, _> = new_lib.get(b"core_on_update");
                                        let core_get_api: Result<Symbol<unsafe extern "C" fn() -> *mut c_void>, _> = new_lib.get(b"core_get_api");
                                        let legacy_load: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>, _> = new_lib.get(b"on_load");
                                        let legacy_update: Result<Symbol<unsafe extern "C" fn(*mut c_void, f64)>, _> = new_lib.get(b"on_update");
                                        
                                        if (core_load.is_ok() && core_update.is_ok()) || (legacy_load.is_ok() && legacy_update.is_ok()) {
                                            has_required_symbols = true;
                                        }
                                        
                                        // Try to get ABI version
                                        let get_abi: Result<Symbol<unsafe extern "C" fn() -> c_uint>, _> = new_lib.get(b"core_get_abi_version");
                                        if let Ok(f) = get_abi {
                                            module_abi_version = f();
                                            eprintln!("[Runner] [HMR] Core reports ABI version: {}", module_abi_version);
                                        }
                                    },
                                    Some(ModuleSlot::Gui) => {
                                        // GUI module: require gui_on_load, gui_on_render
                                        // OR legacy on_load + gui_render for backward compat
                                        let gui_load: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void>, _> = new_lib.get(b"gui_on_load");
                                        let gui_render: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = new_lib.get(b"gui_on_render");
                                        let legacy_load: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>, _> = new_lib.get(b"on_load");
                                        let legacy_render: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = new_lib.get(b"gui_render");
                                        let legacy_on_render: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = new_lib.get(b"on_render");
                                        
                                        if (gui_load.is_ok() && gui_render.is_ok()) || 
                                           (legacy_load.is_ok() && (legacy_render.is_ok() || legacy_on_render.is_ok())) {
                                            has_required_symbols = true;
                                        }
                                        
                                        // Try to get ABI version
                                        let get_abi: Result<Symbol<unsafe extern "C" fn() -> c_uint>, _> = new_lib.get(b"gui_get_abi_version");
                                        if let Ok(f) = get_abi {
                                            module_abi_version = f();
                                            eprintln!("[Runner] [HMR] GUI reports ABI version: {}", module_abi_version);
                                        }
                                    },
                                    Some(ModuleSlot::Main) | None => {
                                        // Legacy main module: require on_load or entrypoint + on_update
                                        let legacy_load: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>, _> = new_lib.get(b"on_load");
                                        let legacy_entry: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut c_void>, _> = new_lib.get(b"entrypoint");
                                        let legacy_update: Result<Symbol<unsafe extern "C" fn(*mut c_void, f64)>, _> = new_lib.get(b"on_update");
                                        
                                        if (legacy_load.is_ok() || legacy_entry.is_ok()) && legacy_update.is_ok() {
                                            has_required_symbols = true;
                                        } else if legacy_load.is_ok() || legacy_entry.is_ok() {
                                            // Allow modules with just load/entrypoint (render-only modules)
                                            has_required_symbols = true;
                                        }
                                    }
                                }
                                
                                if !has_required_symbols {
                                    eprintln!("[Runner] [HMR] ERROR: Module '{}' missing required symbols. Aborting HMR (old module continues).", name);
                                    eprintln!("[Runner] [HMR] Expected: {} = core_on_load+core_on_update | gui = gui_on_load+gui_on_render | main = on_load+on_update", name);
                                    
                                    // Send structured HMR rejection event
                                    let status = HmrStatus::rejected(name, "Missing required symbols");
                                    eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                                    continue;
                                }
                                
                                // ============================================================
                                // EXPORT-BASED CAPABILITY DETECTION
                                // ============================================================
                                // Use the capability module to get detailed HMR capability info
                                // ============================================================
                                let capability_report = detect_capabilities(std::path::Path::new(path));
                                let hmr_capability = capability_report.as_ref()
                                    .map(|r| r.hmr_capability)
                                    .unwrap_or(HmrCapability::Partial);
                                
                                let state_will_preserve = hmr_capability.preserves_state();
                                eprintln!("[Runner] [HMR] Capability: {:?}, state_preserve={}", hmr_capability, state_will_preserve);
                                
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
                                eprintln!("[Runner] [HMR] is_reload={} for module '{}', modules.keys={:?}", is_reload, name, modules.keys().collect::<Vec<_>>());
                                
                                // Collect modules to remove for mode switching (but don't remove yet!)
                                let mut deferred_unloads: Vec<(String, Library)> = Vec::new();
                                
                                if name == "main" {
                                    // Switching to non-split mode: will unload core and gui AFTER swap
                                    let modules_to_remove: Vec<String> = modules.keys()
                                        .filter(|k| *k != "main")
                                        .cloned()
                                        .collect();
                                    for old_name in modules_to_remove {
                                        if let Some(old_lib) = modules.remove(&old_name) {
                                            eprintln!("[Runner] [HMR] Deferring unload of '{}' (mode switch to main)", old_name);
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
                                // Phase 2: Save state from OLD module (while it's still valid)
                                // ============================================================
                                // INDEPENDENT SWAP: Each module has its own state pointer.
                                // We save/restore the state specific to this module only.
                                // ============================================================
                                let mut json_state: Option<std::ffi::CString> = None;
                                let mut old_lib_for_cleanup: Option<Library> = None;
                                
                                // Get the module-specific state (not the shared app_state.raw)
                                let module_prev_state = module_states.get(name).map(|s| s.state_ptr).unwrap_or(std::ptr::null_mut());
                                
                                if let Some(old_lib) = modules.remove(name) {
                                    eprintln!("[Runner] [HMR] Phase 2: Saving state from old module '{}'...", name);
                                    
                                    // Save state BEFORE any cleanup - use module-specific state
                                    // Prefer ABI-prefixed symbols, fall back to legacy.
                                    let save_func: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut std::ffi::c_char>, _> =
                                        if name == "core" {
                                            old_lib.get(b"core_on_save_state").or_else(|_| old_lib.get(b"on_save_state"))
                                        } else if name == "gui" {
                                            old_lib.get(b"gui_on_save_state").or_else(|_| old_lib.get(b"on_save_state"))
                                        } else {
                                            old_lib.get(b"on_save_state")
                                        };
                                    if let Ok(f) = save_func {
                                        // Use module's own state for save, not the shared app_state.raw
                                        let state_to_save = if !module_prev_state.is_null() { module_prev_state } else { app_state.raw };
                                        let ptr = f(state_to_save);
                                        if !ptr.is_null() {
                                            let c_str = std::ffi::CStr::from_ptr(ptr);
                                            json_state = Some(c_str.to_owned());
                                            eprintln!("[Runner] [HMR] State saved for module '{}': {:?}", name, c_str);
                                            libc::free(ptr as *mut c_void);
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
                                eprintln!("[Runner] [HMR] Phase 3: Pre-initializing new module '{}'...", name);
                                
                                #[cfg(target_os = "linux")]
                                let win_ptr = renderer;
                                #[cfg(not(target_os = "linux"))]
                                let win_ptr = std::ptr::null_mut();
                                
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
                                    if name == "core" { new_lib.get(b"core_get_state_schema_hash") }
                                    else if name == "gui" { new_lib.get(b"gui_get_state_schema_hash") }
                                    else { Err(libloading::Error::DlSymUnknown) }; // Legacy doesn't support this

                                if let Ok(f) = get_schema_hash {
                                    new_schema_hash = f();
                                    eprintln!("[Runner] [HMR] Module '{}' schema hash: {:016X}", name, new_schema_hash);
                                }

                                if old_schema_hash != 0 && new_schema_hash != 0 && old_schema_hash != new_schema_hash {
                                    eprintln!("[Runner] [HMR] CRITICAL: Schema hash mismatch (Old: {:016X}, New: {:016X})", old_schema_hash, new_schema_hash);
                                    eprintln!("[Runner] [HMR] The struct layout has changed. Reusing the raw state pointer would cause a crash.");
                                    eprintln!("[Runner] [HMR] Forcing COLD RELOAD for state (passing NULL to on_load).");
                                    
                                    // Force fresh initialization.
                                    // Note: JSON migration (below) can still rescue the data if available,
                                    // because it parses into the NEW struct layout.
                                    new_state = std::ptr::null_mut(); 
                                } else if new_schema_hash == 0 && old_schema_hash != 0 {
                                    eprintln!("[Runner] [HMR] WARNING: New module missing schema hash. Assuming unsafe.");
                                    new_state = std::ptr::null_mut();
                                }
                                
                                // If we have saved state, restore it to new module
                                // Try new symbol name first, then legacy
                                // Use field-level diffing for intelligent state migration
                                if let Some(ref json) = json_state {
                                    let load_json_new: Result<Symbol<unsafe extern "C" fn(*const std::ffi::c_char) -> *mut c_void>, _> = 
                                        if name == "core" { new_lib.get(b"core_on_load_from_json") }
                                        else if name == "gui" { new_lib.get(b"gui_on_load_from_json") }
                                        else { new_lib.get(b"on_load_from_json") };
                                    let load_json_legacy: Result<Symbol<unsafe extern "C" fn(*const std::ffi::c_char) -> *mut c_void>, _> = new_lib.get(b"on_load_from_json");
                                    
                                    if let Ok(f) = load_json_new.or(load_json_legacy) {
                                        let old_json_str = json.to_str().unwrap_or("{}");
                                        
                                        // ============================================================
                                        // FIELD-LEVEL STATE DIFFING
                                        // ============================================================
                                        // Try to get a "default" state from the new module to use as template.
                                        // This allows field-level diffing like Next.js Fast Refresh.
                                        // ============================================================
                                        let mut use_field_diff = false;
                                        let mut migrated_json_cstring: Option<CString> = None;
                                        
                                        // Get on_load symbol to create a fresh template state
                                        let load_new: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>, _> = 
                                            if name == "core" { new_lib.get(b"core_on_load") }
                                            else if name == "gui" { new_lib.get(b"gui_on_load") }
                                            else { new_lib.get(b"on_load") };
                                        let load_legacy: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>, _> = 
                                            new_lib.get(b"on_load");
                                        
                                        // Get on_save_to_json to serialize template state
                                        let save_json_new: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut i8>, _> = 
                                            if name == "core" { new_lib.get(b"core_on_save_to_json") }
                                            else if name == "gui" { new_lib.get(b"gui_on_save_to_json") }
                                            else { new_lib.get(b"on_save_to_json") };
                                        let save_json_legacy: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut i8>, _> = 
                                            new_lib.get(b"on_save_to_json");
                                        
                                        // If both symbols exist, we can do field-level diffing
                                        if let (Ok(load_fn), Ok(save_fn)) = (load_new.or(load_legacy), save_json_new.or(save_json_legacy)) {
                                            // Create a fresh state with default values (the "template")
                                            let template_state = load_fn(std::ptr::null_mut(), std::ptr::null_mut());
                                            
                                            if !template_state.is_null() {
                                                // Serialize template state to JSON
                                                let template_json_ptr = save_fn(template_state);
                                                
                                                if !template_json_ptr.is_null() {
                                                    let template_json_cstr = std::ffi::CStr::from_ptr(template_json_ptr);
                                                    if let Ok(template_json_str) = template_json_cstr.to_str() {
                                                        // Perform field-level state migration
                                                        let module_type = if name == "core" { "core" } else if name == "gui" { "gui" } else { "main" };
                                                        
                                                        match migrate_state(old_json_str, template_json_str, module_type) {
                                                            Ok((merged_json, diff_result)) => {
                                                                // Log migration report
                                                                let report = generate_migration_report(&diff_result);
                                                                eprintln!("[Runner] [HMR] Field-level state migration for '{}':", name);
                                                                eprintln!("{}", report);
                                                                
                                                                // Emit HMR status with migration details
                                                                let status = HmrStatus::state_migrated(
                                                                    name, 
                                                                    diff_result.preserved_fields.len(), 
                                                                    diff_result.reset_fields.len(),
                                                                    diff_result.new_fields.len()
                                                                );
                                                                eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                                                                
                                                                // Prepare the migrated JSON for loading
                                                                migrated_json_cstring = CString::new(merged_json).ok();
                                                                use_field_diff = true;
                                                            }
                                                            Err(e) => {
                                                                eprintln!("[Runner] [HMR] Field-level diff failed for '{}': {}", name, e);
                                                            }
                                                        }
                                                    }
                                                    
                                                    // Free the template JSON (if the module provides a free function)
                                                    let free_json: Result<Symbol<unsafe extern "C" fn(*mut i8)>, _> = new_lib.get(b"synthi_free_json");
                                                    if let Ok(free_fn) = free_json {
                                                        free_fn(template_json_ptr);
                                                    }
                                                }
                                                
                                                // Free the template state (if the module provides an unload function)
                                                let unload: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = 
                                                    if name == "core" { new_lib.get(b"core_on_unload") }
                                                    else if name == "gui" { new_lib.get(b"gui_on_unload") }
                                                    else { new_lib.get(b"on_unload") };
                                                if let Ok(unload_fn) = unload {
                                                    unload_fn(template_state);
                                                }
                                            }
                                        }
                                        
                                        // Load state (either migrated or original)
                                        let final_json_ptr = if use_field_diff {
                                            if let Some(ref migrated) = migrated_json_cstring {
                                                migrated.as_ptr()
                                            } else {
                                                json.as_ptr()
                                            }
                                        } else {
                                            json.as_ptr()
                                        };
                                        
                                        eprintln!("[Runner] [HMR] Restoring state from JSON into new module '{}' (field_diff={})...", name, use_field_diff);
                                        new_state = f(final_json_ptr);
                                    }
                                }
                                
                                // Get CoreAPI pointer from core module (for GUI initialization)
                                if name == "gui" {
                                    if let Some(core_lib) = modules.get("core") {
                                        let get_api_new: Result<Symbol<unsafe extern "C" fn() -> *mut c_void>, _> = core_lib.get(b"core_get_api");
                                        let get_api_legacy: Result<Symbol<unsafe extern "C" fn() -> *mut c_void>, _> = core_lib.get(b"get_core_api");
                                        if let Ok(f) = get_api_new.or(get_api_legacy) {
                                            core_api_ptr = f();
                                            eprintln!("[Runner] [HMR] Got CoreAPI pointer for GUI: {:p}", core_api_ptr);
                                        }
                                    }
                                }
                                
                                // ============================================================
                                // HOST KV: Read and register schema table BEFORE calling load
                                // ============================================================
                                // This allows the module to write to KV during on_load
                                // ============================================================
                                let module_slot = slot.unwrap_or(ModuleSlot::Main);
                                let mut host_kv_events: Vec<HostKvSchemaEvent> = Vec::new();
                                let has_host_kv_support: bool;
                                
                                if let Some(ref sid) = session_id {
                                    // Read schema table from module
                                    let schemas = read_schema_table(&new_lib, module_slot);
                                    has_host_kv_support = !schemas.is_empty();
                                    
                                    if !schemas.is_empty() {
                                        eprintln!("[Runner] [HOST-KV] Module '{}' declares {} namespaces: {:?}", 
                                                 name, schemas.len(), schemas.iter().map(|(ns, _)| ns).collect::<Vec<_>>());
                                        
                                        // Register schemas and handle any resets
                                        host_kv_events = KV_STORE.register_schemas(sid, module_slot_to_u32(module_slot), &schemas);
                                        
                                        // Emit HMR status for schema events
                                        for event in &host_kv_events {
                                            match event {
                                                HostKvSchemaEvent::SchemaMismatchReset { namespace, old_schema, new_schema } => {
                                                    let status = HmrStatus::host_kv_reset_schema(name, namespace, *old_schema, *new_schema);
                                                    eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                                                },
                                                HostKvSchemaEvent::NamespacePreserved { namespace } => {
                                                    eprintln!("[Runner] [HOST-KV] Namespace '{}' preserved (schema unchanged)", namespace);
                                                },
                                                HostKvSchemaEvent::NamespaceRegistered { namespace, schema_id } => {
                                                    eprintln!("[Runner] [HOST-KV] Namespace '{}' registered (schema={})", namespace, schema_id);
                                                },
                                                HostKvSchemaEvent::InvalidNamespace { namespace, reason } => {
                                                    eprintln!("[Runner] [HOST-KV] WARNING: Invalid namespace '{}': {}", namespace, reason);
                                                },
                                            }
                                        }
                                    } else {
                                        eprintln!("[Runner] [HOST-KV] Module '{}' does not export schema table", name);
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
                                // Selection rules:
                                // 1. If *_on_load_host exists, call it with SynthiHostContextV1
                                // 2. Else call existing *_on_load unchanged
                                // ============================================================
                                match slot {
                                    Some(ModuleSlot::Core) => {
                                        // Try core_on_load_host first
                                        let core_load_host: Result<Symbol<unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void>, _> = new_lib.get(b"core_on_load_host");
                                        let core_load: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>, _> = new_lib.get(b"core_on_load");
                                        let legacy_load: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>, _> = new_lib.get(b"on_load");
                                        
                                        if core_load_host.is_ok() && session_id.is_some() && session_id_cstring.is_some() {
                                            let f = core_load_host.unwrap();
                                            let sid_cstr = session_id_cstring.as_ref().unwrap();
                                            let host_ctx = SynthiHostContextV1::new(
                                                &kv_api, sid_cstr, module_slot, win_ptr, win_ptr);
                                            eprintln!("[Runner] [HMR] Calling core_on_load_host with Host KV context...");
                                            new_state = f(new_state, &host_ctx as *const _ as *const c_void);
                                        } else if let Ok(f) = core_load {
                                            eprintln!("[Runner] [HMR] Calling core_on_load...");
                                            new_state = f(new_state, win_ptr);
                                        } else if let Ok(f) = legacy_load {
                                            eprintln!("[Runner] [HMR] Calling legacy on_load for core...");
                                            new_state = f(new_state, win_ptr);
                                        }
                                        eprintln!("[Runner] [HMR] Core module initialized. State: {:p}", new_state);
                                    },
                                    Some(ModuleSlot::Gui) => {
                                        // Try gui_on_load_host first
                                        let gui_load_host: Result<Symbol<unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void>, _> = new_lib.get(b"gui_on_load_host");
                                        let gui_load: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void>, _> = new_lib.get(b"gui_on_load");
                                        let legacy_load: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>, _> = new_lib.get(b"on_load");
                                        
                                        if gui_load_host.is_ok() && session_id.is_some() && session_id_cstring.is_some() {
                                            let f = gui_load_host.unwrap();
                                            let sid_cstr = session_id_cstring.as_ref().unwrap();
                                            let host_ctx = SynthiHostContextV1::new(
                                                &kv_api, sid_cstr, module_slot, win_ptr, win_ptr);
                                            eprintln!("[Runner] [HMR] Calling gui_on_load_host with Host KV context...");
                                            new_state = f(new_state, &host_ctx as *const _ as *const c_void);
                                        } else if let Ok(f) = gui_load {
                                            eprintln!("[Runner] [HMR] Calling gui_on_load with CoreAPI...");
                                            new_state = f(new_state, win_ptr, core_api_ptr);
                                        } else if let Ok(f) = legacy_load {
                                            eprintln!("[Runner] [HMR] Calling legacy on_load for gui...");
                                            new_state = f(new_state, win_ptr);
                                        }
                                        eprintln!("[Runner] [HMR] GUI module initialized. State: {:p}", new_state);
                                    },
                                    Some(ModuleSlot::Main) | None => {
                                        // Try on_load_host first for legacy main module
                                        let load_host: Result<Symbol<unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void>, _> = new_lib.get(b"on_load_host");
                                        let legacy_load: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>, _> = new_lib.get(b"on_load");
                                        let legacy_entry: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut c_void>, _> = new_lib.get(b"entrypoint");
                                        
                                        if load_host.is_ok() && session_id.is_some() && session_id_cstring.is_some() {
                                            let f = load_host.unwrap();
                                            let sid_cstr = session_id_cstring.as_ref().unwrap();
                                            let host_ctx = SynthiHostContextV1::new(
                                                &kv_api, sid_cstr, module_slot, win_ptr, win_ptr);
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
                                                eprintln!("[Runner] [HMR] Skipping entrypoint on reload (would block).");
                                            }
                                        }
                                        eprintln!("[Runner] [HMR] Main module initialized. State: {:p}", new_state);
                                    }
                                }
                                
                                // ============================================================
                                // HOST KV: Emit preserved namespaces status
                                // ============================================================
                                if has_host_kv_support && session_id.is_some() {
                                    let sid = session_id.as_ref().unwrap();
                                    let preserved_namespaces = KV_STORE.get_preserved_namespaces(sid, module_slot_to_u32(module_slot));
                                    if !preserved_namespaces.is_empty() {
                                        let status = HmrStatus::host_kv_preserved(name, preserved_namespaces);
                                        eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                                    }
                                }
                                
                                // ============================================================
                                // VALIDATE on_load RETURN POINTER (CRITICAL FOR HMR)
                                // ============================================================
                                // The on_load function MUST return the same pointer when prev_state
                                // is valid. If it returns a different pointer (e.g., from malloc),
                                // state won't be preserved properly on next HMR cycle.
                                // ============================================================
                                if !module_prev_state.is_null() && !new_state.is_null() && new_state != module_prev_state {
                                    eprintln!("[Runner] [HMR] WARNING: on_load returned different pointer!");
                                    eprintln!("[Runner] [HMR]   prev_state: {:p}", module_prev_state);
                                    eprintln!("[Runner] [HMR]   new_state:  {:p}", new_state);
                                    eprintln!("[Runner] [HMR]   This suggests module used malloc instead of static variable.");
                                    eprintln!("[Runner] [HMR]   State preservation may not work correctly on next reload.");
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
                                        eprintln!("[Runner] [HMR] State validated: magic OK, ABI version = {}", state_abi);
                                        
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
                                // INDEPENDENT SWAP: Store state in module-specific slot.
                                // For "core" module, also update shared app_state.raw for
                                // backward compatibility with on_update/on_event calls.
                                // For "gui" module, only update the gui's module_states entry.
                                // This allows GUI reload without affecting core state.
                                // ============================================================
                                eprintln!("[Runner] [HMR] Phase 4: ATOMIC SWAP executing for '{}'...", name);
                                
                                // This is the critical section - happens in one "instant"
                                // The main loop won't see an empty modules map
                                modules.insert(name.to_string(), new_lib);
                                loaded_paths.insert(name.to_string(), path.to_string());
                                
                                // Store module-specific state with ABI version and CoreAPI pointer
                                module_states.insert(name.to_string(), ModuleState { 
                                    state_ptr: new_state,
                                    abi_version: module_abi_version,
                                    schema_hash: new_schema_hash,
                                    core_api_ptr: if name == "gui" { core_api_ptr } else { std::ptr::null_mut() },
                                });
                                
                                // For "core" or "main", also update the shared app_state.raw
                                // GUI should NOT update app_state.raw - it has its own state
                                if name == "core" || name == "main" {
                                    app_state.raw = new_state;
                                    eprintln!("[Runner] [HMR] Updated shared app_state.raw for '{}'", name);
                                } else {
                                    eprintln!("[Runner] [HMR] Module '{}' has independent state (not updating app_state.raw)", name);
                                }
                                
                                eprintln!("[Runner] [HMR] ATOMIC SWAP complete. Module '{}' is now active. ABI={}", name, module_abi_version);
                                
                                // ============================================================
                                // Phase 5: Deferred cleanup of OLD module(s)
                                // ============================================================
                                // INDEPENDENT SWAP: Each module cleans up its own resources.
                                // GUI cleanup should NOT affect core's internal gui_lib handle.
                                // Core cleanup should NOT call dlclose on gui.so (new core uses it).
                                // ============================================================
                                // Now that new module is active, we can safely cleanup old ones
                                // The main loop is already using the new module
                                
                                if let Some(old_lib) = old_lib_for_cleanup {
                                    eprintln!("[Runner] [HMR] Phase 5: Cleaning up old module '{}'...", name);
                                    
                                    // INDEPENDENT SWAP: GUI module cleanup is safe - it doesn't affect core
                                    // Core module cleanup must NOT call on_unload (would dlclose gui.so)
                                    if name == "gui" {
                                        // GUI cleanup is always safe - it only touches GuiState
                                        // Prefer ABI-prefixed unload symbol, fall back to legacy.
                                        let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                                            old_lib.get(b"gui_on_unload").or_else(|_| old_lib.get(b"on_unload"));
                                        if let Ok(f) = func {
                                            // Pass the old GUI state for cleanup
                                            f(module_prev_state);
                                            eprintln!("[Runner] [HMR] GUI on_unload called with its own state");
                                        }
                                    } else if name != "core" {
                                        // For other modules (not core, not gui), call on_unload normally
                                        let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = old_lib.get(b"on_unload");
                                        if let Ok(f) = func {
                                            f(std::ptr::null_mut()); // Pass null to signal "don't touch state"
                                        }
                                    } else {
                                        // Core: Skip on_unload to avoid dlclose(gui_lib) conflict
                                        eprintln!("[Runner] [HMR] Skipping on_unload for 'core' (would dlclose gui.so needed by new core)");
                                    }
                                    // old_lib drops here, unloading the shared library
                                }
                                
                                // Cleanup any modules from mode switching
                                for (old_name, old_lib) in deferred_unloads {
                                    eprintln!("[Runner] [HMR] Deferred cleanup of '{}'...", old_name);
                                    // Mode-switch unloads are legacy modules; still prefer known ABI symbol names.
                                    let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                                        if old_name == "gui" {
                                            old_lib.get(b"gui_on_unload").or_else(|_| old_lib.get(b"on_unload"))
                                        } else if old_name == "core" {
                                            old_lib.get(b"core_on_unload").or_else(|_| old_lib.get(b"on_unload"))
                                        } else {
                                            old_lib.get(b"on_unload")
                                        };
                                    if let Ok(f) = func {
                                        f(std::ptr::null_mut());
                                    }
                                    // old_lib drops here
                                }
                                
                                eprintln!("[Runner] [HMR] Hot reload complete for '{}'. Zero-flicker swap successful.", name);
                                
                                // ============================================================
                                // STRUCTURED HMR STATUS FEEDBACK
                                // ============================================================
                                // Send detailed HMR status to stdout for the main process
                                // ============================================================
                                if let Ok(ref _report) = capability_report {
                                    let status = HmrStatus::Applied {
                                        module: name.to_string(),
                                        capability: hmr_capability.description().to_string(),
                                        state_preserved: state_will_preserve && json_state.is_some(),
                                    };
                                    eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                                }
                            }
                            Err(e) => {
                                eprintln!("[Runner] [HMR] Error loading new library (old module continues): {}", e);
                                
                                // Send rejection status
                                let status = HmrStatus::rejected(name, &format!("Load error: {}", e));
                                eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                            }
                        }
                    }
                },
                "unload" => {
                    if parts.len() == 2 {
                        let name = parts[1];
                        eprintln!("[Runner] Unloading module '{}'", name);
                        if let Some(lib) = modules.remove(name) {
                             loaded_paths.remove(name);
                             // Get module's own state for unload
                             let module_state_ptr = module_states.get(name).map(|s| s.state_ptr).unwrap_or(std::ptr::null_mut());
                             module_states.remove(name);
                             unsafe {
                                 // Prefer ABI-prefixed unload symbols, fall back to legacy.
                                 let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                                     if name == "core" {
                                         lib.get(b"core_on_unload").or_else(|_| lib.get(b"on_unload"))
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
                    unsafe { SDL_Quit(); }
                    return;
                },
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
            if a == "core" { std::cmp::Ordering::Less }
            else if b == "core" { std::cmp::Ordering::Greater }
            else { a.cmp(b) }
        });

        for name in &keys {
            if let Some(lib) = modules.get(name) {
                unsafe {
                    // Try new symbol names first, then legacy
                    let update_func: Option<Symbol<unsafe extern "C" fn(*mut c_void, f64)>> = 
                        if name == "core" {
                            lib.get(b"core_on_update").ok().or_else(|| lib.get(b"on_update").ok())
                        } else if name == "gui" {
                            // GUI doesn't have on_update in new ABI (only on_render)
                            lib.get(b"gui_on_update").ok().or_else(|| lib.get(b"on_update").ok())
                        } else {
                            lib.get(b"on_update").ok()
                        };
                    
                    if let Some(f) = update_func {
                        // INDEPENDENT SWAP: Use module-specific state for GUI
                        let state_ptr = if name == "gui" {
                            module_states.get(name).map(|s| s.state_ptr).unwrap_or(app_state.raw)
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
                            
                            let state_ptr_wrapper = SendVoidPtr(state_ptr as usize);
                            let func_ptr = *f;
                            let result = execute_with_protection(&module_name, move || {
                                let state_ptr = state_ptr_wrapper.0 as *mut std::ffi::c_void;
                                func_ptr(state_ptr, dt);
                            });
                            
                            if let Err(crash_info) = result {
                                // Crash recovered! Log and continue with old module
                                eprintln!("{}", generate_crash_report(&crash_info));
                                
                                // CRITICAL SAFETY CHECK:
                                // If the crash was caused by memory corruption (SIGSEGV, SIGBUS, etc.),
                                // we MUST NOT continue in the same process, as the heap state is undefined.
                                // We must force a cold restart regardless of the crash count.
                                let is_fatal = crash_info.is_fatal_memory_error();
                                let force_restart = is_fatal || should_force_restart();
                                
                                let status = HmrCrashStatus::from_crash(&crash_info, !force_restart);
                                eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                                
                                if force_restart {
                                    if is_fatal {
                                        eprintln!("[Runner] Fatal memory corruption detected ({:?}). Forcing cold restart.", crash_info.signal_name);
                                    } else {
                                        eprintln!("[Runner] Too many consecutive crashes. Exiting.");
                                    }
                                    std::process::exit(1);
                                }
                                
                                // Skip this module for now, continue with others
                                // Do NOT reset crash count here, otherwise the limit will never be reached!
                                // reset_crash_count(); 
                                continue;
                            }
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
                let render_func: Option<Symbol<unsafe extern "C" fn(*mut c_void)>> = 
                    lib.get(b"gui_on_render").ok()
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
                    module_states.get("gui").map(|s| s.state_ptr).unwrap_or(app_state.raw)
                };
                
                if let Some(f) = render_func {
                    f(render_state);
                }
            }
        } else if let Some(lib) = modules.get("core") {
            unsafe {
                // Core may export on_render that calls ptr_gui_render internally
                let render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = lib.get(b"on_render");
                if let Ok(f) = render_func {
                    f(app_state.raw);
                }
                // If core doesn't have on_render, that's OK - core's on_update handles rendering
            }
        } else if let Some(lib) = modules.get("main") {
            // Fallback for non-split mode: call main's render
            unsafe {
                let render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = lib.get(b"on_render");
                let gui_render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = lib.get(b"gui_render");
                
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
        {
            // Pixel Pump: Read from Xvfb via XShm
            // We need to capture from the plugin's window, not root.
            // Root window captures don't include child windows unless a compositor is running.
            // Query the window tree to find the plugin's window (child of root).
            let target_window = if let Ok(tree_reply) = x11_conn.query_tree(x11_root) {
                if let Ok(reply) = tree_reply.reply() {
                    // Find a mapped child window that's not the SDL window
                    // The plugin's window should be the most recently mapped non-SDL window
                    let mut found_window = None;
                    
                    // Log window count periodically
                    if last_frame_log.elapsed() > Duration::from_secs(4) {
                        eprintln!("[Runner] query_tree found {} children of root", reply.children.len());
                    }
                    
                    for &child in reply.children.iter().rev() {
                        // Check if window is mapped (viewable)
                        if let Ok(attrs) = x11_conn.get_window_attributes(child) {
                            if let Ok(attr_reply) = attrs.reply() {
                                if attr_reply.map_state == x11rb::protocol::xproto::MapState::VIEWABLE {
                                    found_window = Some(child);
                                    break;
                                }
                            }
                        }
                    }
                    if last_frame_log.elapsed() > Duration::from_secs(4) {
                        eprintln!("[Runner] Found viewable window: {:?}", found_window);
                    }
                    found_window.unwrap_or(x11_root)
                } else {
                    if last_frame_log.elapsed() > Duration::from_secs(4) {
                        eprintln!("[Runner] query_tree reply failed");
                    }
                    x11_root
                }
            } else {
                if last_frame_log.elapsed() > Duration::from_secs(4) {
                    eprintln!("[Runner] query_tree failed");
                }
                x11_root
            };

            // The output must always be 800x600 to match the GStreamer pipeline caps
            const OUTPUT_W: u16 = 800;
            const OUTPUT_H: u16 = 600;
            
            // Get the actual window size to capture
            let (win_w, win_h): (u16, u16) = if target_window != x11_root {
                if let Ok(geom) = x11_conn.get_geometry(target_window) {
                    if let Ok(g) = geom.reply() {
                        if last_frame_log.elapsed() > Duration::from_secs(4) {
                            eprintln!("[Runner] Target window geometry: {}x{}", g.width, g.height);
                        }
                        (g.width, g.height)
                    } else {
                        (OUTPUT_W, OUTPUT_H)
                    }
                } else {
                    (OUTPUT_W, OUTPUT_H)
                }
            } else {
                (OUTPUT_W, OUTPUT_H)
            };

            // Capture size is the minimum of window size and output size
            let capture_w = win_w.min(OUTPUT_W);
            let capture_h = win_h.min(OUTPUT_H);

            // Capture from the target window (plugin's window, or root as fallback)
            if let Ok(cookie) = x11_conn.shm_get_image(
                target_window,
                0, 0,
                capture_w, capture_h,
                !0,
                u8::from(x11rb::protocol::xproto::ImageFormat::Z_PIXMAP),
                shm_seg,
                0
            ) {
                if let Ok(_reply) = cookie.reply() {
                    // If captured size differs from output size, we need to reformat
                    // the buffer to have 800-pixel row stride for the pipeline
                    let output_size = (OUTPUT_W as usize) * (OUTPUT_H as usize) * 4;
                    
                    let frame_data = if capture_w == OUTPUT_W && capture_h == OUTPUT_H {
                        // Perfect match, use directly
                        unsafe { std::slice::from_raw_parts(shm_ptr, output_size).to_vec() }
                    } else {
                        // Need to convert: captured rows have capture_w*4 bytes,
                        // but output rows need OUTPUT_W*4 bytes
                        let mut output_buf = vec![0u8; output_size];
                        let capture_stride = (capture_w as usize) * 4;
                        let output_stride = (OUTPUT_W as usize) * 4;
                        
                        for y in 0..(capture_h as usize) {
                            let src_offset = y * capture_stride;
                            let dst_offset = y * output_stride;
                            unsafe {
                                ptr::copy_nonoverlapping(
                                    shm_ptr.add(src_offset),
                                    output_buf.as_mut_ptr().add(dst_offset),
                                    capture_stride
                                );
                            }
                        }
                        output_buf
                    };
                    
                    frame_count += 1;
                    
                    // Drop frame if stdout is backed up; keep the app loop unblocked
                    match frame_tx.try_send(frame_data.clone()) {
                        Ok(_) => { frames_sent += 1; }
                        Err(_) => { /* Channel full or closed; skip this frame */ }
                    }
                    
                    // Log frame stats periodically (using separate timer)
                    if last_frame_log.elapsed() > Duration::from_secs(5) {
                        eprintln!("[Runner] Frame stats: captured={}, sent={}, dropped={}", 
                            frame_count, frames_sent, frame_count - frames_sent);
                        last_frame_log = Instant::now();
                    }

                    // Update local SDL window
                    if !renderer.is_null() && !sdl_texture.is_null() {
                        unsafe {
                            SDL_UpdateTexture(sdl_texture, ptr::null(), frame_data.as_ptr() as *const c_void, (OUTPUT_W as i32) * 4);
                            SDL_RenderCopy(renderer, sdl_texture, ptr::null(), ptr::null());
                            SDL_RenderPresent(renderer);
                        }
                    }
                }
            }
        }

        // Cap at ~60 FPS
        let elapsed = now.elapsed();
        if elapsed < Duration::from_millis(16) {
            thread::sleep(Duration::from_millis(16) - elapsed);
        }
    } // end of loop
} // end of main
