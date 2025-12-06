use libloading::{Library, Symbol};
use std::io::{self, BufRead};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::ffi::c_void;

#[cfg(target_os = "linux")]
#[link(name = "X11")]
extern "C" {
    // Force linking X11
    fn XOpenDisplay(display_name: *const i8) -> *mut c_void;
}

// Simple state container wrapper
struct AppState {
    raw: *mut c_void,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

fn main() {
    // Ensure X11 is linked
    #[cfg(target_os = "linux")]
    unsafe {
        let _ = XOpenDisplay as *const ();
    }

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

    loop {
        // Process all pending commands
        while let Ok(cmd) = rx.try_recv() {
            if cmd.starts_with("load ") {
                let path = &cmd[5..];
                println!("Loading library: {}", path);

                unsafe {
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
                return;
            }
        }

        // Run update loop if library is loaded
        if let Some(lib) = &current_lib {
            unsafe {
                let update_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> = lib.get(b"on_update");
                if let Ok(f) = update_func {
                    f(app_state.raw);
                }
            }
        }

        // Cap at ~60 FPS
        thread::sleep(Duration::from_millis(16));
    }
}
