use libloading::{Library, Symbol};
use std::io::{self, BufRead, Write};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use std::ffi::{c_void, c_int, c_uint, c_ulong, c_long};
use std::ptr;
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::process::Command;

#[cfg(target_os = "linux")]
use x11rb::connection::Connection;
#[cfg(target_os = "linux")]
use x11rb::protocol::xproto::*;
#[cfg(target_os = "linux")]
use x11rb::protocol::shm::{self, ConnectionExt as ShmConnectionExt};

mod plugin_contract;

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
struct ModuleState {
    state_ptr: *mut c_void,  // Module's own state (CoreState or GuiState)
}

impl Default for ModuleState {
    fn default() -> Self {
        ModuleState { state_ptr: std::ptr::null_mut() }
    }
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
                    // INDEPENDENT SWAP: Pass events with module-specific state
                    // Pass SDL_Event to all loaded modules that export on_event
                    // The plugin's on_event expects SDL_Event* (not XEvent*)
                    // Plugins MUST be compiled to expect SDL_Event, not XEvent
                    for (name, lib) in modules.iter() {
                        let event_func: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut SDL_Event)>, _> = lib.get(b"on_event");
                        if let Ok(f) = event_func {
                            // Use module-specific state for GUI
                            let state_ptr = if name == "gui" {
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
                                
                                // Validate new library has required symbols BEFORE any state changes
                                let new_load_func: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>, _> = new_lib.get(b"on_load");
                                let new_entry_func: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut c_void>, _> = new_lib.get(b"entrypoint");
                                let new_update_func: Result<Symbol<unsafe extern "C" fn(*mut c_void, f64)>, _> = new_lib.get(b"on_update");
                                
                                if new_load_func.is_err() && new_entry_func.is_err() && new_update_func.is_err() && name != "main" {
                                     eprintln!("[Runner] [HMR] ERROR: New library missing required symbols. Aborting HMR (old module continues).");
                                     continue;
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
                                    let save_func: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut std::ffi::c_char>, _> = old_lib.get(b"on_save_state");
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
                                // For "gui" module, we also pass the core state pointer
                                // so GUI can read (but not modify) core state.
                                // ============================================================
                                eprintln!("[Runner] [HMR] Phase 3: Pre-initializing new module '{}'...", name);
                                
                                #[cfg(target_os = "linux")]
                                let win_ptr = renderer;
                                #[cfg(not(target_os = "linux"))]
                                let win_ptr = std::ptr::null_mut();
                                
                                // Start with module's previous state or null for fresh init
                                let mut new_state: *mut c_void = module_prev_state;
                                
                                // If we have saved state, restore it to new module
                                if let Some(ref json) = json_state {
                                    let load_json_func: Result<Symbol<unsafe extern "C" fn(*const std::ffi::c_char) -> *mut c_void>, _> = new_lib.get(b"on_load_from_json");
                                    if let Ok(f) = load_json_func {
                                        eprintln!("[Runner] [HMR] Restoring state from JSON into new module '{}'...", name);
                                        new_state = f(json.as_ptr());
                                    }
                                }
                                
                                // Initialize graphics on new module
                                let new_load_func: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>, _> = new_lib.get(b"on_load");
                                let new_entry_func: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut c_void>, _> = new_lib.get(b"entrypoint");
                                
                                if let Ok(f) = new_load_func {
                                    eprintln!("[Runner] [HMR] Calling on_load on new module (graphics init)...");
                                    new_state = f(new_state, win_ptr);
                                    eprintln!("[Runner] [HMR] New module on_load complete. State: {:p}", new_state);
                                } else if let Ok(f) = new_entry_func {
                                    if !is_reload {
                                        eprintln!("[Runner] [HMR] Calling entrypoint (first load only)...");
                                        new_state = f(new_state);
                                    } else {
                                        eprintln!("[Runner] [HMR] Skipping entrypoint on reload (would block).");
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
                                
                                // Store module-specific state
                                module_states.insert(name.to_string(), ModuleState { state_ptr: new_state });
                                
                                // For "core" or "main", also update the shared app_state.raw
                                // GUI should NOT update app_state.raw - it has its own state
                                if name == "core" || name == "main" {
                                    app_state.raw = new_state;
                                    eprintln!("[Runner] [HMR] Updated shared app_state.raw for '{}'", name);
                                } else {
                                    eprintln!("[Runner] [HMR] Module '{}' has independent state (not updating app_state.raw)", name);
                                }
                                
                                eprintln!("[Runner] [HMR] ATOMIC SWAP complete. Module '{}' is now active.", name);
                                
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
                                        let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = old_lib.get(b"on_unload");
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
                                    let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = old_lib.get(b"on_unload");
                                    if let Ok(f) = func {
                                        f(std::ptr::null_mut());
                                    }
                                    // old_lib drops here
                                }
                                
                                eprintln!("[Runner] [HMR] Hot reload complete for '{}'. Zero-flicker swap successful.", name);
                            }
                            Err(e) => {
                                eprintln!("[Runner] [HMR] Error loading new library (old module continues): {}", e);
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
                                 let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = lib.get(b"on_unload");
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
                    let update_func: Result<Symbol<unsafe extern "C" fn(*mut c_void, f64)>, _> = lib.get(b"on_update");
                    match update_func {
                        Ok(f) => {
                            // INDEPENDENT SWAP: Use module-specific state for GUI
                            let state_ptr = if name == "gui" {
                                module_states.get(name).map(|s| s.state_ptr).unwrap_or(app_state.raw)
                            } else {
                                // For core/main, use shared app_state.raw
                                app_state.raw
                            };
                            f(state_ptr, dt);
                        },
                        Err(_) => {
                            // Module doesn't have on_update - that's fine for GUI-only modules
                        }
                    }
                }
            }
        }
        
        // Render pass: 
        // INDEPENDENT SWAP: For GUI-only updates, call gui's on_render with gui's state.
        // For split mode (core+gui): Core's on_update already calls gui internally via dlsym.
        //   We need to call on_render on core to trigger rendering.
        // For non-split mode (main): Call main's on_render/gui_render.
        
        // Check if GUI module has an independent on_render
        if let Some(lib) = modules.get("gui") {
            unsafe {
                let render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = lib.get(b"on_render");
                let gui_render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = lib.get(b"gui_render");
                
                // Get GUI's own state
                let gui_state = module_states.get("gui").map(|s| s.state_ptr).unwrap_or(app_state.raw);
                
                if let Ok(f) = render_func {
                    f(gui_state);
                } else if let Ok(f) = gui_render_func {
                    f(gui_state);
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
