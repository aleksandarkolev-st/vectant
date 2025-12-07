use libloading::{Library, Symbol};
use std::io::{self, BufRead, Write};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use std::ffi::{c_void, c_int, c_uint, c_ulong, c_long};
use std::ptr;
use std::collections::HashMap;

mod plugin_contract;

// X11 Definitions
#[cfg(target_os = "linux")]
type Display = c_void;
#[cfg(target_os = "linux")]
type Window = c_ulong;

#[cfg(target_os = "linux")]
#[repr(C)]
struct XEvent {
    pad: [c_long; 24],
}

#[cfg(target_os = "linux")]
#[link(name = "X11")]
extern "C" {
    fn XOpenDisplay(display_name: *const i8) -> *mut Display;
    fn XCloseDisplay(display: *mut Display) -> c_int;
    fn XCreateSimpleWindow(display: *mut Display, parent: Window, x: c_int, y: c_int, width: c_uint, height: c_uint, border_width: c_uint, border: c_ulong, background: c_ulong) -> Window;
    fn XMapWindow(display: *mut Display, w: Window) -> c_int;
    fn XNextEvent(display: *mut Display, event: *mut XEvent) -> c_int;
    fn XPending(display: *mut Display) -> c_int;
    fn XDefaultRootWindow(display: *mut Display) -> Window;
    fn XDefaultScreen(display: *mut Display) -> c_int;
    fn XBlackPixel(display: *mut Display, screen_number: c_int) -> c_ulong;
    fn XWhitePixel(display: *mut Display, screen_number: c_int) -> c_ulong;
    fn XFlush(display: *mut Display) -> c_int;
    fn XCreateGC(display: *mut Display, d: Window, valuemask: c_ulong, values: *mut c_void) -> *mut c_void;
    fn XSetForeground(display: *mut Display, gc: *mut c_void, foreground: c_ulong) -> c_int;
    fn XDrawString(display: *mut Display, d: Window, gc: *mut c_void, x: c_int, y: c_int, string: *const i8, length: c_int) -> c_int;
    fn XFreeGC(display: *mut Display, gc: *mut c_void) -> c_int;
    fn XClearWindow(display: *mut Display, w: Window) -> c_int;
}

// Simple state container wrapper
struct AppState {
    raw: *mut c_void,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

fn main() {
    // Initialize GStreamer
    if let Err(e) = gstreamer::init() {
        eprintln!("Failed to initialize GStreamer: {}", e);
    } else {
        println!("GStreamer initialized.");
    }
    let _ = io::stdout().flush();

    // Initialize X11
    // We do NOT create a window here anymore. The runner should be invisible
    // and let the loaded library create its own window if needed.
    #[cfg(target_os = "linux")]
    let (display, _window) = unsafe {
        println!("Attempting to open X11 display...");
        let d = XOpenDisplay(ptr::null());
        if d.is_null() {
            eprintln!("Cannot open display: XOpenDisplay returned NULL");
            (ptr::null_mut(), 0)
        } else {
            println!("XOpenDisplay successful. Display ptr: {:p}", d);
            // We don't create a window, just return the display connection
            // so we can poll events if needed (though without a window we won't get many)
            (d, 0)
        }
    };

    println!("Runner started. Waiting for commands...");

    let (tx, rx) = mpsc::channel::<String>();
    
    // Spawn stdin reader thread
    thread::spawn(move || {
        println!("Stdin reader thread started");
        let stdin = io::stdin();
        let mut handle = stdin.lock();
        let mut line = String::new();
        loop {
            match handle.read_line(&mut line) {
                Ok(0) => {
                    println!("Stdin closed (EOF)");
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim().to_string();
                    if !trimmed.is_empty() {
                        println!("Stdin received: {}", trimmed);
                        if let Err(e) = tx.send(trimmed) {
                            println!("Failed to send command to main thread: {}", e);
                            break;
                        }
                    }
                    line.clear();
                }
                Err(e) => {
                    println!("Error reading stdin: {}", e);
                    break;
                }
            }
        }
        println!("Stdin reader thread exited");
    });

    let mut modules: HashMap<String, Library> = HashMap::new();
    let mut loaded_paths: HashMap<String, String> = HashMap::new();
    let mut app_state = AppState { raw: std::ptr::null_mut() };
    let mut last_frame = Instant::now();
    let mut last_log = Instant::now();

    loop {
        // Poll X11 events
        #[cfg(target_os = "linux")]
        if !display.is_null() {
            unsafe {
                while XPending(display) > 0 {
                    let mut event: XEvent = std::mem::zeroed();
                    XNextEvent(display, &mut event);
                    // Drain events to keep window responsive
                }
            }
        }

        if last_log.elapsed() > Duration::from_secs(5) {
            println!("Runner loop alive. Modules loaded: {}", modules.len());
            last_log = Instant::now();
        }

        // Process all pending commands
        while let Ok(cmd) = rx.try_recv() {
            let parts: Vec<&str> = cmd.split_whitespace().collect();
            if parts.is_empty() { continue; }

            match parts[0] {
                "load" => {
                    // usage: load <name> <path>
                    // fallback: load <path> -> name="main"
                    let (name, path) = if parts.len() >= 3 {
                        (parts[1], parts[2])
                    } else if parts.len() == 2 {
                        ("main", parts[1])
                    } else {
                        println!("Invalid load command");
                        continue;
                    };

                    println!("Loading module '{}' from {}", name, path);

                    if let Some(current_path) = loaded_paths.get(name) {
                        if current_path == path {
                            println!("Module '{}' already loaded from {}. Skipping reload.", name, path);
                            continue;
                        }
                    }

                    unsafe {
                        // Phase 4: Smooth Transition
                        // We do NOT clear the window here. By doing nothing, the last frame
                        // remains on screen (persisted by X server or compositor) until
                        // the new library loads and draws the next frame.

                        // NOTE: We moved unload logic inside the success block of loading the new library
                        // to ensure we don't unload if the new one fails.


                        // Load new library
                        // We use RTLD_LOCAL to avoid symbol pollution and allow side-by-side loading during transition
                        #[cfg(unix)]
                        let lib_result = {
                            use libloading::os::unix::{Library, RTLD_NOW, RTLD_LOCAL};
                            Library::open(Some(path), RTLD_NOW | RTLD_LOCAL).map(|l| libloading::Library::from(l))
                        };
                        #[cfg(not(unix))]
                        let lib_result = Library::new(path);

                        match lib_result {
                            Ok(lib) => {
                                println!("Library loaded successfully. Checking for symbols...");
                                
                                // Check for on_load or entrypoint BEFORE unloading the old one
                                let load_func: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut c_void>, _> = lib.get(b"on_load");
                                let entry_func: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut c_void>, _> = lib.get(b"entrypoint");
                                
                                if load_func.is_err() && entry_func.is_err() && name != "main" {
                                     println!("New library missing required symbols (on_load/entrypoint). Aborting reload to preserve state.");
                                     continue;
                                }

                                // Now it is safe to unload the old one
                                if let Some(old_lib) = modules.remove(name) {
                                     loaded_paths.remove(name);
                                     let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = old_lib.get(b"on_unload");
                                     if let Ok(f) = func {
                                         println!("Calling on_unload for {}...", name);
                                         f(app_state.raw);
                                     }
                                }

                                // Initialize the new one
                                if let Ok(f) = load_func {
                                    println!("Found 'on_load' symbol. Calling it...");
                                    app_state.raw = f(app_state.raw);
                                    println!("'on_load' returned. AppState raw: {:p}", app_state.raw);
                                } else if let Ok(f) = entry_func {
                                     // Fallback
                                     println!("Found 'entrypoint' symbol. Calling it...");
                                     app_state.raw = f(app_state.raw);
                                     println!("'entrypoint' returned. AppState raw: {:p}", app_state.raw);
                                }
                                
                                modules.insert(name.to_string(), lib);
                                loaded_paths.insert(name.to_string(), path.to_string());
                                println!("Module '{}' registered.", name);
                            }
                            Err(e) => {
                                println!("Error loading library: {}", e);
                            }
                        }
                    }
                "unload" => {
                    if parts.len() == 2 {
                        let name = parts[1];
                        if let Some(lib) = modules.remove(name) {
                             loaded_paths.remove(name);
                             unsafe {ib) = modules.remove(name) {
                             unsafe {
                                 let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = lib.get(b"on_unload");
                                 if let Ok(f) = func {
                                     f(app_state.raw);
                                 }
                             }
                             println!("Unloaded module {}", name);
                        }
                    }
                },
                "quit" => {
                    println!("Quitting runner.");
                    #[cfg(target_os = "linux")]
                    if !display.is_null() {
                        unsafe { XCloseDisplay(display); }
                    }
                    return;
                },
                _ => {}
            }
        }

        // Calculate delta time
        let now = Instant::now();
        let dt = now.duration_since(last_frame).as_secs_f64();
        last_frame = now;

        // Run update loop for all loaded modules
        // We iterate over keys to avoid borrowing issues if we needed to mutate map (we don't here)
        // But we need to iterate values.
        for (name, lib) in &modules {
            unsafe {
                let update_func: Result<Symbol<unsafe extern "C" fn(*mut c_void, f64)>, _> = lib.get(b"on_update");
                if let Ok(f) = update_func {
                    // Uncomment to debug update loop (spammy)
                    // println!("Calling on_update for {}", name);
                    f(app_state.raw, dt);
                }
            }
        }

        // Cap at ~60 FPS
        let elapsed = now.elapsed();
        if elapsed < Duration::from_millis(16) {
            thread::sleep(Duration::from_millis(16) - elapsed);
        }
    }
}
