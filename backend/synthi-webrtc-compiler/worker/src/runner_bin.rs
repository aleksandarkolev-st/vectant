use libloading::{Library, Symbol};
use std::io::{self, BufRead};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use std::ffi::{c_void, c_int, c_uint, c_ulong, c_long};
use std::ptr;

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

    // Initialize X11
    #[cfg(target_os = "linux")]
    let (display, _window) = unsafe {
        let d = XOpenDisplay(ptr::null());
        if d.is_null() {
            eprintln!("Cannot open display");
            (ptr::null_mut(), 0)
        } else {
            let s = XDefaultScreen(d);
            let root = XDefaultRootWindow(d);
            let black = XBlackPixel(d, s);
            let white = XWhitePixel(d, s);
            let w = XCreateSimpleWindow(d, root, 0, 0, 1280, 720, 0, white, black);
            XMapWindow(d, w);
            XFlush(d);
            println!("X11 Window created.");
            (d, w)
        }
    };

    println!("Runner started. Waiting for commands...");

    let (tx, rx) = mpsc::channel::<String>();
    
    // Spawn stdin reader thread
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut handle = stdin.lock();
        let mut line = String::new();
        while handle.read_line(&mut line).unwrap() > 0 {
            let trimmed = line.trim().to_string();
            if !trimmed.is_empty() {
                if let Err(_) = tx.send(trimmed) {
                    break;
                }
            }
            line.clear();
        }
    });

    let mut current_lib: Option<Library> = None;
    let mut app_state = AppState { raw: std::ptr::null_mut() };
    let mut last_frame = Instant::now();

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

        // Process all pending commands
        while let Ok(cmd) = rx.try_recv() {
            if cmd.starts_with("load ") {
                let path = &cmd[5..];
                println!("Loading library: {}", path);

                unsafe {
                    // Phase 4: Smooth Transition
                    // We do NOT clear the window here. By doing nothing, the last frame
                    // remains on screen (persisted by X server or compositor) until
                    // the new library loads and draws the next frame.

                    // Unload previous library if exists
                    if let Some(lib) = &current_lib {
                         let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = lib.get(b"on_unload");
                         if let Ok(f) = func {
                             println!("Calling on_unload...");
                             f(app_state.raw);
                         }
                    }
                    // Drop old lib to unload it
                    current_lib = None;

                    // Load new library
                    #[cfg(unix)]
                    let lib_result = {
                        use libloading::os::unix::{Library, RTLD_NOW, RTLD_GLOBAL};
                        Library::open(Some(path), RTLD_NOW | RTLD_GLOBAL).map(|l| libloading::Library::from(l))
                    };
                    #[cfg(not(unix))]
                    let lib_result = Library::new(path);

                    match lib_result {
                        Ok(lib) => {
                            // Try on_load first
                            let load_func: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut c_void>, _> = lib.get(b"on_load");
                            if let Ok(f) = load_func {
                                println!("Calling on_load...");
                                app_state.raw = f(app_state.raw);
                            } else {
                                // Fallback to entrypoint for backward compatibility
                                let entry_func: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut c_void>, _> = lib.get(b"entrypoint");
                                if let Ok(f) = entry_func {
                                     println!("Calling entrypoint...");
                                     app_state.raw = f(app_state.raw);
                                }
                            }
                            current_lib = Some(lib);
                            println!("Library loaded successfully.");
                        }
                        Err(e) => {
                            println!("Error loading library: {}", e);
                        }
                    }
                }
            } else if cmd == "quit" {
                println!("Quitting runner.");
                #[cfg(target_os = "linux")]
                if !display.is_null() {
                    unsafe { XCloseDisplay(display); }
                }
                return;
            }
        }

        // Calculate delta time
        let now = Instant::now();
        let dt = now.duration_since(last_frame).as_secs_f64();
        last_frame = now;

        // Run update loop if library is loaded
        if let Some(lib) = &current_lib {
            unsafe {
                let update_func: Result<Symbol<unsafe extern "C" fn(*mut c_void, f64)>, _> = lib.get(b"on_update");
                if let Ok(f) = update_func {
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
