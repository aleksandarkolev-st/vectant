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
mod binary_state;
mod abi_version;
mod loader;
mod supervisor;
mod state_manager;
mod boundary;
mod reload_manager;
mod fast_refresh;
mod hmr_orchestrator;

use plugin_contract::{ModuleSlot, CORE_STATE_MAGIC, GUI_STATE_MAGIC, SYNTHI_CORE_ABI_VERSION, SYNTHI_GUI_ABI_VERSION};
use capability::{HmrCapability, detect_capabilities, HmrStatus};
use host_kv::{
    KV_STORE, SynthiHostContextV1, HostKvSchemaEvent,
    create_kv_api, read_schema_table, module_slot_to_u32,
};
use crash_recovery::{install_crash_handlers, execute_with_protection, 
                     HmrCrashStatus, generate_crash_report, set_current_lib_path};
use loader::{ModuleLoader, LoadResult};
use supervisor::{CrashSupervisor, RecoveryAction, SupervisorConfig};
use state_manager::StateManager;
use hmr_orchestrator::{HmrOrchestrator, SavedState};

// SDL2 Definitions
#[cfg(target_os = "linux")]
#[allow(non_camel_case_types)]
type SDL_Window = c_void;

#[cfg(target_os = "linux")]
#[repr(C)]
struct SDL_Event {
    data: [u8; 128], // Generous padding for SDL_Event union
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
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

// Import new HotApi types for v2 ABI
use plugin_contract::{
    HotApi, HotGetApiFn, HOT_GET_API_SYMBOL, RunnerApi, Event,
    HOT_API_VERSION, HOT_API_MIN_VERSION, MAX_STATE_ALIGNMENT, RUNNER_API_VERSION,
    LOG_INFO, LOG_WARN, LOG_ERROR,
};
use capability::{validate_hot_api, HotApiValidation, HotApiInfo};

// Legacy state container - used for backward compatibility with "main" module
// Now actively used in the main loop for app_state tracking
#[allow(dead_code)]
struct AppState {
    raw: *mut c_void,
    renderer: *mut c_void,
}

// Per-module state tracking for independent swaps
// Enhanced to track ABI version and CoreAPI pointer for proper HMR
// Now actively used in module_states HashMap
#[allow(dead_code)]
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

// ============================================================
// NEW HOTAPI-BASED MODULE STATE (v2 ABI)
// ============================================================

/// State for a module loaded via the new HotApi ABI
struct HotModuleState {
    /// Pointer to the HotApi table
    api_ptr: *const HotApi,
    /// Cached copy of HotApi info
    api_info: HotApiInfo,
    /// Aligned state memory (owned by runner)
    state_memory: Vec<u8>,
    /// Pointer to aligned state within state_memory
    state_ptr: *mut c_void,
    /// Build ID for snapshot correlation
    build_id: u64,
    /// Whether state has been initialized
    initialized: bool,
}

impl HotModuleState {
    /// Allocate state memory with proper alignment
    fn allocate_state(api: &HotApi) -> Result<(Vec<u8>, *mut c_void), String> {
        if api.state_size_bytes == 0 {
            return Ok((Vec::new(), std::ptr::null_mut()));
        }
        
        // Allocate extra space for alignment
        let extra = api.state_align_bytes;
        let total_size = api.state_size_bytes + extra;
        let mut memory = vec![0u8; total_size];
        
        // Find aligned address
        let base_addr = memory.as_mut_ptr() as usize;
        let aligned_addr = (base_addr + extra - 1) & !(api.state_align_bytes - 1);
        let state_ptr = aligned_addr as *mut c_void;
        
        Ok((memory, state_ptr))
    }
}

/// Result of the 3-mode hot reload algorithm
#[derive(Debug)]
enum HotReloadResult {
    /// Mode 1: Same version, state pointer reuse (fastest)
    SameVersion,
    /// Mode 2: Version changed, migration via serialized snapshot
    Migrated { preserved_fields: usize, new_fields: usize },
    /// Mode 3: Cold reload, state reset
    ColdReload { reason: String },
    /// Error during reload
    Error(String),
}

/// Runner API implementation
static RUNNER_API: RunnerApi = RunnerApi {
    struct_size: std::mem::size_of::<RunnerApi>() as u32,
    api_version: RUNNER_API_VERSION,
    log: Some(runner_log),
    get_time_ns: Some(runner_get_time_ns),
    _reserved: [0; 8],
};

/// Log callback for modules
unsafe extern "C" fn runner_log(level: u32, msg: *const u8, len: usize) {
    if msg.is_null() || len == 0 { return; }
    let bytes = std::slice::from_raw_parts(msg, len);
    if let Ok(s) = std::str::from_utf8(bytes) {
        let prefix = match level {
            LOG_ERROR => "[Module:ERROR]",
            LOG_WARN => "[Module:WARN]",
            LOG_INFO => "[Module:INFO]",
            _ => "[Module]",
        };
        eprintln!("{} {}", prefix, s);
    }
}

/// Get monotonic time in nanoseconds
unsafe extern "C" fn runner_get_time_ns() -> u64 {
    use std::time::{Instant, SystemTime, UNIX_EPOCH};
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

/// Perform the 3-mode hot reload algorithm for new HotApi modules
/// 
/// Mode 1: Same state_version + same abi_fingerprint -> reuse state pointer
/// Mode 2: Different version -> save via MsgPack, migrate, restore
/// Mode 3: Cold reload -> init fresh state
fn hot_reload_v2(
    new_lib: &Library,
    old_hot_state: Option<&mut HotModuleState>,
    old_msgpack: Option<&[u8]>,
    old_json: Option<&str>,
) -> Result<(HotModuleState, HotReloadResult), String> {
    // 1. Validate new module's HotApi
    let validation = validate_hot_api(new_lib);
    if !validation.has_hot_api {
        return Err("Module does not export hot_get_api".to_string());
    }
    if !validation.errors.is_empty() {
        return Err(format!("HotApi validation failed: {}", validation.errors.join(", ")));
    }
    
    let api_info = validation.api.ok_or("HotApi info not available")?;
    
    // Get the HotApi pointer
    let hot_get_api: Symbol<HotGetApiFn> = unsafe {
        new_lib.get(b"hot_get_api").map_err(|e| format!("Failed to get hot_get_api: {}", e))?
    };
    let api_ptr: *const HotApi = unsafe { hot_get_api() };
    if api_ptr.is_null() {
        return Err("hot_get_api() returned NULL".to_string());
    }
    let api = unsafe { &*api_ptr };
    
    // 2. Additional validation checks
    // Reject if struct_size < offset of last required field
    let min_struct_size = std::mem::offset_of!(HotApi, migrate) 
        + std::mem::size_of::<Option<plugin_contract::MigrateFn>>();
    if (api.struct_size as usize) < min_struct_size {
        return Err(format!(
            "struct_size {} too small - required fields end at offset {}",
            api.struct_size, min_struct_size
        ));
    }
    
    // Enforce state_align_bytes is power of two and <= max
    if !api.state_align_bytes.is_power_of_two() {
        return Err(format!("state_align_bytes {} is not a power of 2", api.state_align_bytes));
    }
    if api.state_align_bytes > MAX_STATE_ALIGNMENT {
        return Err(format!("state_align_bytes {} exceeds maximum {}", api.state_align_bytes, MAX_STATE_ALIGNMENT));
    }
    
    // 3. Allocate state memory
    let (state_memory, state_ptr) = HotModuleState::allocate_state(api)?;
    
    // 4. Determine reload mode
    let (reload_result, needs_init) = if let Some(old) = old_hot_state {
        // Check if same version + same fingerprint
        if old.api_info.state_version == api_info.state_version 
            && old.api_info.abi_fingerprint == api_info.abi_fingerprint
            && old.api_info.state_size_bytes == api_info.state_size_bytes {
            // Mode 1: Same version hot swap - can reuse state memory
            // Copy old state to new location
            if !old.state_ptr.is_null() && !state_ptr.is_null() {
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        old.state_ptr as *const u8,
                        state_ptr as *mut u8,
                        api.state_size_bytes.min(old.api_info.state_size_bytes),
                    );
                }
            }
            (HotReloadResult::SameVersion, false)
        } else if api.migrate.is_some() && (old_msgpack.is_some() || old_json.is_some()) {
            // Mode 2: Migration via serialized snapshot
            // CRITICAL: Use serialized data, NOT old struct pointer casting
            let migrate_fn = api.migrate.unwrap();
            
            let msgpack_ptr = old_msgpack.map(|b| b.as_ptr()).unwrap_or(std::ptr::null());
            let msgpack_len = old_msgpack.map(|b| b.len()).unwrap_or(0);
            let json_ptr = old_json.map(|s| s.as_ptr()).unwrap_or(std::ptr::null());
            let json_len = old_json.map(|s| s.len()).unwrap_or(0);
            
            let success = unsafe {
                migrate_fn(
                    old.state_ptr,          // old_blob (opaque, for size reference only)
                    old.api_info.state_version,
                    state_ptr,              // new_blob (write here)
                    api.state_version,
                    &RUNNER_API,
                    msgpack_ptr,
                    msgpack_len,
                    json_ptr,
                    json_len,
                )
            };
            
            if success {
                (HotReloadResult::Migrated { preserved_fields: 0, new_fields: 0 }, false)
            } else {
                // Migration failed, fall through to cold reload
                (HotReloadResult::ColdReload { reason: "Migration failed".to_string() }, true)
            }
        } else {
            // Mode 3: Cold reload
            (HotReloadResult::ColdReload { 
                reason: if api.migrate.is_none() { 
                    "No migrate function".to_string() 
                } else { 
                    "No serialized state".to_string() 
                }
            }, true)
        }
    } else {
        // First load - need init
        (HotReloadResult::ColdReload { reason: "First load".to_string() }, true)
    };
    
    // 5. Initialize if needed
    let initialized = if needs_init {
        if let Some(init_fn) = api.init {
            unsafe { init_fn(state_ptr, &RUNNER_API) }
        } else {
            false
        }
    } else {
        true
    };
    
    if !initialized && needs_init {
        return Err("Module init() failed".to_string());
    }
    
    let hot_state = HotModuleState {
        api_ptr,
        api_info,
        state_memory,
        state_ptr,
        build_id: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        initialized: true,
    };
    
    Ok((hot_state, reload_result))
}

/// Save state using size-then-write pattern (no module allocation)
fn save_state_msgpack_v2(hot_state: &HotModuleState) -> Option<Vec<u8>> {
    let api = unsafe { &*hot_state.api_ptr };
    
    let size_fn = api.save_state_msgpack_size?;
    let write_fn = api.save_state_msgpack_write?;
    
    // Get size
    let size = unsafe {
        size_fn(hot_state.state_ptr, hot_state.api_info.state_version, &RUNNER_API)
    };
    
    if size == 0 {
        return None;
    }
    
    // Allocate and write
    let mut buffer = vec![0u8; size];
    let mut written: usize = 0;
    
    let success = unsafe {
        write_fn(
            hot_state.state_ptr,
            hot_state.api_info.state_version,
            &RUNNER_API,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut written,
        )
    };
    
    if success && written <= buffer.len() {
        buffer.truncate(written);
        Some(buffer)
    } else {
        None
    }
}

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

// Host context for passing window/renderer to plugins
// Now actively used when creating SynthiHostContextV1
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
    let (_xvfb_proc, x11_conn, _x11_screen_num, x11_root) = {
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
                            if let Some(slot) = slot {
                                // Generate a simple hash for tracking (real hash from file)
                                let content_hash = std::fs::metadata(path)
                                    .map(|m| m.len())
                                    .unwrap_or(0);
                                
                                match module_loader.load(std::path::Path::new(path), slot, content_hash) {
                                    LoadResult::Success { module_id, abi_version } => {
                                        eprintln!("[Runner] [Loader] ABI validation passed: {} v{}", module_id, abi_version);
                                    }
                                    LoadResult::AbiMismatch { expected, found, details } => {
                                        eprintln!("[Runner] [Loader] ABI MISMATCH: expected v{}, found v{}. {}", 
                                            expected, found, details);
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
                                module_loader.unload(slot);
                            }
                        }
                        
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
                                        let _core_get_api: Result<Symbol<unsafe extern "C" fn() -> *mut c_void>, _> = new_lib.get(b"core_get_api");
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
                                let module_prev_state = module_states.get(name).map(|s| s.state_ptr).unwrap_or(std::ptr::null_mut());
                                
                                if let Some(old_lib) = modules.remove(name) {
                                    eprintln!("[Runner] [HMR] Phase 2: Saving state via orchestrator for '{}'...", name);
                                    
                                    // Save state BEFORE any cleanup - use module-specific state
                                    let state_to_save = if !module_prev_state.is_null() { module_prev_state } else { app_state.raw };
                                    
                                    // Use orchestrator for unified save (binary-first with JSON fallback)
                                    saved_state = Some(orchestrator.save_module_state(
                                        slot.unwrap_or(ModuleSlot::Main),
                                        &old_lib,
                                        state_to_save,
                                    ));
                                    
                                    if let Some(ref ss) = saved_state {
                                        if ss.was_binary {
                                            eprintln!("[Runner] [HMR] State saved via BINARY path ({} bytes)", 
                                                ss.binary.as_ref().map(|b| b.len()).unwrap_or(0));
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

                                // ============================================================
                                // Schema Compatibility Check (via Orchestrator helper)
                                // ============================================================
                                // The orchestrator checks if the old and new schemas are compatible.
                                // If incompatible, we force cold reload (NULL state to on_load).
                                // JSON migration can still rescue data by parsing into new layout.
                                // ============================================================
                                let mut _force_cold_reload = false;
                                
                                if old_schema_hash != 0 && new_schema_hash != 0 && old_schema_hash != new_schema_hash {
                                    eprintln!("[Runner] [HMR] CRITICAL: Schema hash mismatch (Old: {:016X}, New: {:016X})", old_schema_hash, new_schema_hash);
                                    eprintln!("[Runner] [HMR] Forcing COLD RELOAD - JSON migration will attempt data rescue.");
                                    
                                    let status = HmrStatus::rejected(name, &format!("Schema mismatch (Cold Reload): {:016X} -> {:016X}", old_schema_hash, new_schema_hash));
                                    eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                                    _force_cold_reload = true;
                                    new_state = std::ptr::null_mut();
                                } else if new_schema_hash == 0 && old_schema_hash != 0 {
                                    eprintln!("[Runner] [HMR] WARNING: New module missing schema hash. Assuming unsafe.");
                                    
                                    let status = HmrStatus::rejected(name, "Missing schema hash (Cold Reload)");
                                    eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                                    _force_cold_reload = true;
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
                                let mut _state_restored = false;
                                
                                if let Some(ref ss) = saved_state {
                                    // Get template JSON for field-level diffing (if JSON path needed)
                                    let template_json = orchestrator.get_template_json(
                                        slot.unwrap_or(ModuleSlot::Main),
                                        &new_lib,
                                    );
                                    
                                    // Use orchestrator to load state
                                    let loaded = orchestrator.load_module_state(
                                        slot.unwrap_or(ModuleSlot::Main),
                                        &new_lib,
                                        ss,
                                        template_json.as_deref(),
                                    );
                                    
                                    if !loaded.state_ptr.is_null() {
                                        new_state = loaded.state_ptr;
                                        _state_restored = true;
                                        
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
                                let has_host_kv_support: bool;
                                
                                if let Some(ref sid) = session_id {
                                    // Read schema table from module
                                    let schemas = read_schema_table(&new_lib, module_slot);
                                    has_host_kv_support = !schemas.is_empty();
                                    
                                    if !schemas.is_empty() {
                                        eprintln!("[Runner] [HOST-KV] Module '{}' declares {} namespaces: {:?}", 
                                                 name, schemas.len(), schemas.iter().map(|(ns, _)| ns).collect::<Vec<_>>());
                                        
                                        // Register schemas and handle any resets
                                        let host_kv_events = KV_STORE.register_schemas(sid, module_slot_to_u32(module_slot), &schemas);
                                        
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
                                        state_preserved: state_will_preserve && saved_state.is_some(),
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
                                let force_restart = is_fatal || 
                                    recovery_action == RecoveryAction::FullRestart ||
                                    recovery_action == RecoveryAction::Fatal ||
                                    (supervisor_enabled && crash_supervisor.should_force_restart());
                                
                                let status = HmrCrashStatus::from_crash(&crash_info, !force_restart);
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
                                if recovery_action == RecoveryAction::HotReload && supervisor_enabled {
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
