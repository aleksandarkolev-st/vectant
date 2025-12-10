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
    fn SDL_Quit();
    fn SDL_GetError() -> *const i8;
}

const SDL_INIT_VIDEO: u32 = 0x00000020;
const SDL_WINDOW_SHOWN: u32 = 0x00000004;
const SDL_WINDOWPOS_UNDEFINED: c_int = 0x1FFF0000; // SDL_WINDOWPOS_UNDEFINED_MASK | 0
const SDL_RENDERER_ACCELERATED: u32 = 0x00000002;
const SDL_RENDERER_SOFTWARE: u32 = 0x00000001;
const SDL_PIXELFORMAT_RGBA8888: u32 = 373694468;
const SDL_TEXTUREACCESS_STREAMING: c_int = 1;


// Simple state container wrapper
struct AppState {
    raw: *mut c_void,
    renderer: *mut c_void,
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
    #[cfg(not(target_os = "linux"))]
    let (window, renderer) = (ptr::null_mut(), ptr::null_mut());
    let mut app_state = AppState { raw: std::ptr::null_mut(), renderer };
    let mut last_frame = Instant::now();
    let mut last_log = Instant::now();

    loop {
        // Poll SDL2 events
        #[cfg(target_os = "linux")]
        if !window.is_null() {
            unsafe {
                let mut event: SDL_Event = std::mem::zeroed();
                while SDL_PollEvent(&mut event) != 0 {
                    // Pass event to all loaded modules that export on_event
                    for lib in modules.values() {
                        // FIX: Disable passing SDL_Event to on_event because core.cpp expects XEvent.
                        // SDL_Event and XEvent are incompatible and have different sizes.
                        // Passing SDL_Event causes core.cpp to read garbage or out-of-bounds memory, leading to crashes.
                        /*
                        let event_func: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut SDL_Event)>, _> = lib.get(b"on_event");
                        if let Ok(f) = event_func {
                            f(app_state.raw, &mut event);
                        }
                        */
                    }
                }
            }
        }

        if last_log.elapsed() > Duration::from_secs(5) {
            println!("[Runner] Heartbeat. Modules: {}, FPS: {:.2}", modules.len(), 1.0 / last_frame.elapsed().as_secs_f64().max(0.001));
            last_log = Instant::now();
        }

        // Process all pending commands
        while let Ok(cmd) = rx.try_recv() {
            println!("[Runner] Processing command: {}", cmd);
            let parts: Vec<&str> = cmd.split_whitespace().collect();
            if parts.is_empty() { continue; }

            match parts[0] {
                "input" => {
                    #[cfg(target_os = "linux")]
                    if parts.len() >= 2 {
                        // Find the target window (plugin window)
                        if let Ok(tree_reply) = x11_conn.query_tree(x11_root).unwrap().reply() {
                             let target = tree_reply.children.last().copied().unwrap_or(x11_root);
                             
                             match parts[1] {
                                "motion" => {
                                    if parts.len() >= 4 {
                                        if let (Ok(x), Ok(y)) = (parts[2].parse::<i16>(), parts[3].parse::<i16>()) {
                                            let event = MotionNotifyEvent {
                                                response_type: MOTION_NOTIFY_EVENT,
                                                detail: 0.into(),
                                                sequence: 0,
                                                time: x11rb::CURRENT_TIME,
                                                root: x11_root,
                                                event: target,
                                                child: 0,
                                                root_x: x,
                                                root_y: y,
                                                event_x: x,
                                                event_y: y,
                                                state: 0u16.into(),
                                                same_screen: true,
                                            };
                                            x11_conn.send_event(false, target, EventMask::NO_EVENT, event).ok();
                                            x11_conn.flush().ok();
                                        }
                                    }
                                },
                                "button" => {
                                    if parts.len() >= 6 {
                                        let type_str = parts[2];
                                        let btn = parts[3].parse::<u8>().unwrap_or(1);
                                        let x = parts[4].parse::<i16>().unwrap_or(0);
                                        let y = parts[5].parse::<i16>().unwrap_or(0);
                                        
                                        let event_type = if type_str == "down" { BUTTON_PRESS_EVENT } else { BUTTON_RELEASE_EVENT };
                                        
                                        let event = ButtonPressEvent {
                                            response_type: event_type,
                                            detail: btn.into(),
                                            sequence: 0,
                                            time: x11rb::CURRENT_TIME,
                                            root: x11_root,
                                            event: target,
                                            child: 0,
                                            root_x: x,
                                            root_y: y,
                                            event_x: x,
                                            event_y: y,
                                            state: 0u16.into(),
                                            same_screen: true,
                                        };
                                        x11_conn.send_event(false, target, EventMask::NO_EVENT, event).ok();
                                        x11_conn.flush().ok();
                                    }
                                },
                                _ => {}
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
                        // Phase 4: Smooth Transition
                        eprintln!("[Runner] Opening library: {}", path);
                        #[cfg(unix)]
                        let lib_result = {
                            use libloading::os::unix::{Library, RTLD_NOW, RTLD_LOCAL};
                            Library::open(Some(path), RTLD_NOW | RTLD_LOCAL).map(|l| libloading::Library::from(l))
                        };
                        #[cfg(not(unix))]
                        let lib_result = Library::new(path);

                        match lib_result {
                            Ok(lib) => {
                                eprintln!("[Runner] Library opened. Resolving symbols...");
                                
                                // Check for on_load or entrypoint or on_update BEFORE unloading the old one
                                let load_func: Result<Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>, _> = lib.get(b"on_load");
                                let entry_func: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut c_void>, _> = lib.get(b"entrypoint");
                                let update_func: Result<Symbol<unsafe extern "C" fn(*mut c_void, f64)>, _> = lib.get(b"on_update");
                                
                                if load_func.is_err() && entry_func.is_err() && update_func.is_err() && name != "main" {
                                     eprintln!("[Runner] ERROR: New library missing required symbols. Aborting.");
                                     continue;
                                }

                                // Now it is safe to unload the old one
                                if let Some(old_lib) = modules.remove(name) {
                                     eprintln!("[Runner] Unloading old module '{}'...", name);
                                     loaded_paths.remove(name);
                                     let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = old_lib.get(b"on_unload");
                                     if let Ok(f) = func {
                                         eprintln!("[Runner] Calling on_unload...");
                                         f(app_state.raw);
                                         eprintln!("[Runner] on_unload finished.");
                                     }
                                }

                                // Initialize the new one
                                if let Ok(f) = load_func {
                                    eprintln!("[Runner] Found 'on_load'. Calling...");
                                    // FIX: Pass SDL_Renderer as window_ptr so the plugin can use it.
                                    // We rely on main.rs to patch the plugin code to cast this correctly.
                                    #[cfg(target_os = "linux")]
                                    let win_ptr = app_state.renderer;
                                    #[cfg(not(target_os = "linux"))]
                                    let win_ptr = app_state.renderer;
                                    
                                    app_state.raw = f(app_state.raw, win_ptr);
                                    eprintln!("[Runner] 'on_load' returned. AppState raw: {:p}", app_state.raw);
                                } else if let Ok(f) = entry_func {
                                     // Fallback
                                     eprintln!("[Runner] Found 'entrypoint'. Calling...");
                                     app_state.raw = f(app_state.raw);
                                     eprintln!("[Runner] 'entrypoint' returned. AppState raw: {:p}", app_state.raw);
                                }
                                
                                modules.insert(name.to_string(), lib);
                                loaded_paths.insert(name.to_string(), path.to_string());
                                eprintln!("[Runner] Module '{}' registered successfully.", name);
                            }
                            Err(e) => {
                                eprintln!("[Runner] Error loading library: {}", e);
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
                             unsafe {
                                 let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = lib.get(b"on_unload");
                                 if let Ok(f) = func {
                                     f(app_state.raw);
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

        // Clear screen
        #[cfg(target_os = "linux")]
        if !renderer.is_null() {
            unsafe {
                SDL_SetRenderDrawColor(renderer, 0, 0, 0, 255);
                SDL_RenderClear(renderer);
            }
        }

        // Run update loop for all loaded modules
        // Deterministic order: "core" first, then others sorted alphabetically
        let mut keys: Vec<String> = modules.keys().cloned().collect();
        keys.sort_by(|a, b| {
            if a == "core" { std::cmp::Ordering::Less }
            else if b == "core" { std::cmp::Ordering::Greater }
            else { a.cmp(b) }
        });

        for name in keys {
            if let Some(lib) = modules.get(&name) {
                unsafe {
                    let update_func: Result<Symbol<unsafe extern "C" fn(*mut c_void, f64)>, _> = lib.get(b"on_update");
                    match update_func {
                        Ok(f) => {
                            // Log once per second per module to prove it's being called
                            if last_log.elapsed() < Duration::from_millis(20) {
                                // println!("[Runner] Calling on_update for {}", name);
                            }
                            f(app_state.raw, dt);
                        },
                        Err(e) => {
                            // Only log this error once every 5 seconds to avoid spamming if it's missing
                            if last_log.elapsed() > Duration::from_secs(4) {
                                println!("[Runner] WARNING: Module '{}' does not export 'on_update': {}", name, e);
                            }
                        }
                    }

                    // Try to call on_render if it exists (Critical for GUI modules)
                    // Fallback to gui_render if on_render is missing (for backward compatibility)
                    let render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = lib.get(b"on_render");
                    let gui_render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = lib.get(b"gui_render");
                    
                    if let Ok(f) = render_func {
                        f(app_state.raw);
                    } else if let Ok(f) = gui_render_func {
                         // Only log this fallback once
                         if last_log.elapsed() > Duration::from_secs(4) {
                             eprintln!("[Runner] WARNING: Module '{}' uses 'gui_render' (deprecated). Please rename to 'on_render'.", name);
                         }
                         f(app_state.raw);
                    }
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            // Pixel Pump: Read from Xvfb via XShm
            // We capture the root window of the Xvfb screen
            if let Ok(cookie) = x11_conn.shm_get_image(x11_root, 0, 0, 800, 600, !0, u8::from(x11rb::protocol::xproto::ImageFormat::Z_PIXMAP), shm_seg, 0) {
                if let Ok(_reply) = cookie.reply() {
                    // Write raw bytes to stdout
                    let size = 800 * 600 * 4;
                    let slice = unsafe { std::slice::from_raw_parts(shm_ptr, size) };
                    io::stdout().write_all(slice).ok();
                    io::stdout().flush().ok();

                    // Update local SDL window
                    if !renderer.is_null() && !sdl_texture.is_null() {
                        unsafe {
                            SDL_UpdateTexture(sdl_texture, ptr::null(), shm_ptr as *const c_void, 800 * 4);
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
