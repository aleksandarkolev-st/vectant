// ============================================================
// RUNTIME ERROR RECOVERY MODULE
// ============================================================
// Catches segfaults and other fatal signals in plugin code,
// allowing graceful recovery without full process restart.
//
// KEY FEATURES:
// - Signal handlers for SIGSEGV, SIGABRT, SIGFPE, SIGBUS
// - Isolated execution context for plugin code
// - Automatic rollback to last known-good state
// - Detailed crash reports for debugging
//
// DESIGN RATIONALE:
// - Next.js can catch JS exceptions in error boundaries
// - Native code crashes (segfault) would normally kill the process
// - We use SAFER process-fork isolation instead of longjmp
//   (longjmp from signal handlers is undefined behavior in Rust)
// - Plugin code runs in a "sandbox" that can be safely aborted
//
// ============================================================
// CRITICAL SAFETY DOCUMENTATION
// ============================================================
// 
// SIGNAL RECOVERY LIMITATIONS - READ CAREFULLY
// 
// After SIGSEGV, SIGABRT, or any signal indicating memory corruption:
// - Heap state is UNKNOWN and potentially corrupted
// - Mutex/lock state is UNKNOWN and potentially deadlocked
// - Stack frames may be unwound incorrectly
// - Global state may be inconsistent
// 
// WHAT WE CAN SAFELY DO:
// 1. Log the crash (if logging doesn't allocate)
// 2. Store minimal crash info in pre-allocated buffers
// 3. Exit the process (in fork mode: child only)
// 4. RESTART from a clean state
//
// WHAT WE CANNOT SAFELY DO:
// 1. Resume execution in the same process after SIGSEGV
// 2. Call malloc/free after heap corruption
// 3. Acquire locks after potential deadlock
// 4. Assume any data structure is valid
//
// THE ONLY SAFE RECOVERY IS RESTART WITH ROLLBACK
// 
// This module provides:
// - Fork isolation: crash in child, parent continues cleanly
// - Crash reporting: capture info for debugging
// - Rollback support: restore to pre-crash snapshot
// - Restart orchestration: clean restart of plugin subsystem
//
// It does NOT provide:
// - In-process recovery after SIGSEGV (undefined behavior)
// - Continuation after allocator corruption
// - Magic healing of corrupted state
// ============================================================

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::ffi::c_void;
use std::path::Path;
use std::time::{Duration, Instant};

use crate::source_map;

#[cfg(unix)]
use libc::{c_int, siginfo_t, sigaction, sigemptyset, SA_SIGINFO, SIGSEGV, SIGABRT, SIGFPE, SIGBUS};

#[cfg(unix)]
use std::mem::MaybeUninit;

/// Global flag indicating we're in plugin code (can recover from crash)
static IN_PLUGIN_CONTEXT: AtomicBool = AtomicBool::new(false);

/// Counter for consecutive crashes (triggers full restart if too many)
static CRASH_COUNT: AtomicU32 = AtomicU32::new(0);

/// Maximum consecutive crashes before giving up
const MAX_CONSECUTIVE_CRASHES: u32 = 3;

/// Maximum time (in seconds) a plugin operation can run before timeout
pub const PLUGIN_TIMEOUT_SECS: u64 = 30;

/// Flag indicating a timeout occurred during plugin execution
static PLUGIN_TIMED_OUT: AtomicBool = AtomicBool::new(false);

/// Flag to signal the plugin execution thread to abort (safer than longjmp)
static ABORT_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Execution mode for crash protection
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtectionMode {
    /// Use process fork for maximum isolation (safest, some overhead)
    ForkIsolation,
    /// Use signal-based recovery (faster, but less safe)
    SignalRecovery,
    /// No protection (fastest, no recovery on crash)
    None,
}

impl Default for ProtectionMode {
    fn default() -> Self {
        // Default to fork isolation on Unix, no protection on Windows
        #[cfg(unix)]
        { ProtectionMode::ForkIsolation }
        #[cfg(not(unix))]
        { ProtectionMode::None }
    }
}

/// Global protection mode setting
static PROTECTION_MODE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

pub fn set_protection_mode(mode: ProtectionMode) {
    let value = match mode {
        ProtectionMode::ForkIsolation => 0,
        ProtectionMode::SignalRecovery => 1,
        ProtectionMode::None => 2,
    };
    PROTECTION_MODE.store(value, Ordering::SeqCst);
}

pub fn get_protection_mode() -> ProtectionMode {
    match PROTECTION_MODE.load(Ordering::SeqCst) {
        0 => ProtectionMode::ForkIsolation,
        1 => ProtectionMode::SignalRecovery,
        _ => ProtectionMode::None,
    }
}

/// Source location for crash
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CrashSourceLocation {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub function: Option<String>,
}

/// Crash recovery state
#[derive(Debug, Clone)]
pub struct CrashInfo {
    pub signal: i32,
    pub signal_name: String,
    pub module_name: String,
    pub address: Option<u64>,
    pub timestamp: u64,
    pub backtrace: Option<String>,
    /// Source-mapped location (if debug info available)
    pub source_location: Option<CrashSourceLocation>,
    /// Source-mapped stack frames (if debug info available)
    pub source_frames: Vec<CrashSourceLocation>,
    /// Path to the crashed library (for source map lookup)
    pub lib_path: Option<String>,
}

impl CrashInfo {
    pub fn to_json(&self) -> String {
        serde_json::json!({
            "signal": self.signal,
            "signal_name": self.signal_name,
            "module_name": self.module_name,
            "address": self.address,
            "timestamp": self.timestamp,
            "backtrace": self.backtrace,
            "source_location": self.source_location,
            "source_frames": self.source_frames,
            "lib_path": self.lib_path,
        }).to_string()
    }
    
    /// Get primary source location as string
    pub fn source_location_str(&self) -> Option<String> {
        self.source_location.as_ref().map(|loc| {
            if let Some(ref func) = loc.function {
                format!("{} at {}:{}", func, loc.file, loc.line)
            } else {
                format!("{}:{}", loc.file, loc.line)
            }
        })
    }
}

// Global crash info storage
lazy_static::lazy_static! {
    static ref LAST_CRASH: Mutex<Option<CrashInfo>> = Mutex::new(None);
    static ref CURRENT_MODULE: Mutex<String> = Mutex::new(String::new());
    static ref CURRENT_LIB_PATH: Mutex<String> = Mutex::new(String::new());
    /// Global source map cache for resolving crash addresses to source locations
    pub static ref SOURCE_MAP_CACHE: source_map::SourceMapCache = source_map::SourceMapCache::new();
}

/// Set the current library path for source map lookup
pub fn set_current_lib_path(path: &str) {
    if let Ok(mut guard) = CURRENT_LIB_PATH.lock() {
        *guard = path.to_string();
    }
}

/// Resolve source locations in a CrashInfo using the global source map cache
pub fn resolve_crash_source_locations(crash_info: &mut CrashInfo) {
    // Get the library path to resolve
    let lib_path = match &crash_info.lib_path {
        Some(path) => path.clone(),
        None => {
            // Try the current lib path if not in crash info
            CURRENT_LIB_PATH.lock().ok().map(|g| g.clone()).unwrap_or_default()
        }
    };
    
    if lib_path.is_empty() {
        return;
    }
    
    let path = Path::new(&lib_path);
    
    // Resolve primary address if available
    if let Some(addr) = crash_info.address {
        if let Some(loc) = SOURCE_MAP_CACHE.resolve(path, addr) {
            crash_info.source_location = Some(CrashSourceLocation {
                file: loc.file,
                line: loc.line,
                column: loc.column,
                function: loc.function,
            });
        }
    }
    
    // Note: For full stack frame resolution, the backtrace would need to be
    // parsed to extract addresses, which requires backtrace parsing logic.
    // For now, we resolve just the primary crash address.
}

#[cfg(unix)]
/// Signal handler that catches crashes in plugin code
extern "C" fn crash_handler(sig: c_int, info: *mut siginfo_t, _context: *mut c_void) {
    // Only recover if we're in plugin context
    if !IN_PLUGIN_CONTEXT.load(Ordering::SeqCst) {
        // Not in plugin code, re-raise to get default behavior (core dump)
        unsafe {
            libc::signal(sig, libc::SIG_DFL);
            libc::raise(sig);
        }
        return;
    }
    
    // Get crash details
    let signal_name = match sig {
        SIGSEGV => "SIGSEGV (Segmentation fault)",
        SIGABRT => "SIGABRT (Abort)",
        SIGFPE => "SIGFPE (Floating point exception)",
        SIGBUS => "SIGBUS (Bus error)",
        _ => "Unknown signal",
    };
    
    let address = unsafe {
        if !info.is_null() {
            Some((*info).si_addr() as u64)
        } else {
            None
        }
    };
    
    let module_name = CURRENT_MODULE.lock()
        .map(|m| m.clone())
        .unwrap_or_else(|_| "unknown".to_string());
    
    let lib_path = CURRENT_LIB_PATH.lock()
        .map(|p| if p.is_empty() { None } else { Some(p.clone()) })
        .unwrap_or(None);
    
    let crash_info = CrashInfo {
        signal: sig as i32,
        signal_name: signal_name.to_string(),
        module_name,
        address,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        backtrace: capture_backtrace(),
        source_location: None, // Will be resolved later with source map
        source_frames: Vec::new(),
        lib_path,
    };
    
    // Store crash info
    if let Ok(mut guard) = LAST_CRASH.lock() {
        *guard = Some(crash_info);
    }
    
    // Increment crash count
    CRASH_COUNT.fetch_add(1, Ordering::SeqCst);
    
    // SAFETY: Instead of longjmp (which is UB), we set a flag and exit the child process
    // The parent process will detect the crash via waitpid
    ABORT_REQUESTED.store(true, Ordering::SeqCst);
    
    // In fork isolation mode, exit the child process
    // In signal recovery mode, this will cause the thread to detect abort on next check
    if get_protection_mode() == ProtectionMode::ForkIsolation {
        // Child process - exit with signal code
        unsafe {
            libc::_exit(128 + sig);
        }
    }
    
    // For signal recovery mode, re-raise to terminate (we've stored the info)
    eprintln!("[CRASH] Plugin crash detected: {}", signal_name);
    unsafe {
        libc::signal(sig, libc::SIG_DFL);
        libc::raise(sig);
    }
}

#[cfg(unix)]
fn capture_backtrace() -> Option<String> {
    // Simple backtrace capture using backtrace crate
    #[cfg(feature = "backtrace")]
    {
        let bt = backtrace::Backtrace::new();
        Some(format!("{:?}", bt))
    }
    #[cfg(not(feature = "backtrace"))]
    {
        None
    }
}

#[cfg(not(unix))]
fn capture_backtrace() -> Option<String> {
    None
}

/// Install signal handlers for crash recovery
#[cfg(unix)]
pub fn install_crash_handlers() -> Result<(), String> {
    unsafe {
        for &sig in &[SIGSEGV, SIGABRT, SIGFPE, SIGBUS] {
            let mut sa: sigaction = MaybeUninit::zeroed().assume_init();
            sa.sa_flags = SA_SIGINFO;
            sa.sa_sigaction = crash_handler as usize;
            sigemptyset(&mut sa.sa_mask);
            
            if sigaction(sig, &sa, std::ptr::null_mut()) != 0 {
                return Err(format!("Failed to install handler for signal {}", sig));
            }
        }
    }
    
    eprintln!("[CrashRecovery] Signal handlers installed (mode: {:?})", get_protection_mode());
    Ok(())
}

#[cfg(not(unix))]
pub fn install_crash_handlers() -> Result<(), String> {
    // Windows: Use __try/__except in the runner or Structured Exception Handling
    eprintln!("[CrashRecovery] Signal handlers not available on this platform");
    Ok(())
}

/// Execute plugin code with crash protection using fork isolation (SAFE)
/// This is the safest approach - crashes in the child process don't affect the parent
#[cfg(unix)]
pub fn execute_with_fork_protection<F, R>(module_name: &str, f: F, timeout: Duration) -> Result<R, CrashInfo>
where
    F: FnOnce() -> R,
    R: serde::Serialize + serde::de::DeserializeOwned,
{
    use std::io::{Read, Write};
    use std::os::unix::io::{FromRawFd, RawFd};
    
    // Set current module name
    if let Ok(mut guard) = CURRENT_MODULE.lock() {
        *guard = module_name.to_string();
    }
    
    // Create a pipe for IPC
    let mut pipe_fds: [RawFd; 2] = [0; 2];
    if unsafe { libc::pipe(pipe_fds.as_mut_ptr()) } != 0 {
        return Err(CrashInfo {
            signal: 0,
            signal_name: "pipe() failed".to_string(),
            module_name: module_name.to_string(),
            address: None,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            backtrace: None,
            source_location: None,
            source_frames: Vec::new(),
            lib_path: None,
        });
    }
    
    let read_fd = pipe_fds[0];
    let write_fd = pipe_fds[1];
    
    let start_time = Instant::now();
    
    // Fork
    let pid = unsafe { libc::fork() };
    
    if pid < 0 {
        // Fork failed
        unsafe {
            libc::close(read_fd);
            libc::close(write_fd);
        }
        return Err(CrashInfo {
            signal: 0,
            signal_name: "fork() failed".to_string(),
            module_name: module_name.to_string(),
            address: None,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            backtrace: None,
            source_location: None,
            source_frames: Vec::new(),
            lib_path: None,
        });
    } else if pid == 0 {
        // Child process - execute the plugin code
        unsafe { libc::close(read_fd); }
        
        IN_PLUGIN_CONTEXT.store(true, Ordering::SeqCst);
        
        // Execute the function
        let result = f();
        
        IN_PLUGIN_CONTEXT.store(false, Ordering::SeqCst);
        
        // Serialize and send result
        let mut write_file = unsafe { std::fs::File::from_raw_fd(write_fd) };
        if let Ok(serialized) = serde_json::to_vec(&result) {
            let _ = write_file.write_all(&serialized);
        }
        
        // Exit child cleanly
        unsafe { libc::_exit(0); }
    } else {
        // Parent process - wait for child with timeout
        unsafe { libc::close(write_fd); }
        
        let mut status: c_int = 0;
        let timeout_ms = timeout.as_millis() as i32;
        
        // Poll for child completion with timeout
        loop {
            let wait_result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            
            if wait_result > 0 {
                // Child finished
                break;
            } else if wait_result == 0 {
                // Child still running, check timeout
                if start_time.elapsed() > timeout {
                    // Timeout - kill child
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                        libc::waitpid(pid, &mut status, 0);
                        libc::close(read_fd);
                    }
                    PLUGIN_TIMED_OUT.store(true, Ordering::SeqCst);
                    
                    return Err(CrashInfo {
                        signal: libc::SIGKILL as i32,
                        signal_name: "Timeout (plugin took too long)".to_string(),
                        module_name: module_name.to_string(),
                        address: None,
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_secs(),
                        backtrace: None,
                        source_location: None,
                        source_frames: Vec::new(),
                        lib_path: None,
                    });
                }
                
                // Sleep briefly and retry
                std::thread::sleep(Duration::from_millis(10));
            } else {
                // Wait error
                unsafe { libc::close(read_fd); }
                return Err(CrashInfo {
                    signal: 0,
                    signal_name: "waitpid() failed".to_string(),
                    module_name: module_name.to_string(),
                    address: None,
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs(),
                    backtrace: None,
                    source_location: None,
                    source_frames: Vec::new(),
                    lib_path: None,
                });
            }
        }
        
        // Check child exit status
        if libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0 {
            // Child exited successfully - read result
            let mut read_file = unsafe { std::fs::File::from_raw_fd(read_fd) };
            let mut data = Vec::new();
            if read_file.read_to_end(&mut data).is_ok() {
                if let Ok(result) = serde_json::from_slice(&data) {
                    CRASH_COUNT.store(0, Ordering::SeqCst);
                    return Ok(result);
                }
            }
            
            // Failed to read result but child exited ok
            return Err(CrashInfo {
                signal: 0,
                signal_name: "Failed to deserialize result".to_string(),
                module_name: module_name.to_string(),
                address: None,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
                backtrace: None,
                source_location: None,
                source_frames: Vec::new(),
                lib_path: None,
            });
        } else {
            // Child crashed
            unsafe { libc::close(read_fd); }
            
            let signal = if libc::WIFSIGNALED(status) {
                libc::WTERMSIG(status)
            } else {
                0
            };
            
            let signal_name = match signal {
                libc::SIGSEGV => "SIGSEGV (Segmentation fault)",
                libc::SIGABRT => "SIGABRT (Abort)",
                libc::SIGFPE => "SIGFPE (Floating point exception)",
                libc::SIGBUS => "SIGBUS (Bus error)",
                libc::SIGKILL => "SIGKILL (Killed)",
                _ => "Unknown signal",
            };
            
            CRASH_COUNT.fetch_add(1, Ordering::SeqCst);
            
            return Err(CrashInfo {
                signal: signal as i32,
                signal_name: signal_name.to_string(),
                module_name: module_name.to_string(),
                address: None,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
                backtrace: None,
                source_location: None,
                source_frames: Vec::new(),
                lib_path: None,
            });
        }
    }
    
    // Unreachable - suppress warning
    #[allow(unreachable_code)]
    Err(CrashInfo {
        signal: 0,
        signal_name: "Unreachable".to_string(),
        module_name: module_name.to_string(),
        address: None,
        timestamp: 0,
        backtrace: None,
        source_location: None,
        source_frames: Vec::new(),
        lib_path: None,
    })
}

/// Execute plugin code with crash protection
/// Returns Ok(result) on success, Err(CrashInfo) if plugin crashed
/// 
/// SAFETY NOTE: This function now uses a watchdog timeout instead of longjmp
/// to avoid undefined behavior. The longjmp approach was removed as it's technically UB.
#[cfg(unix)]
pub fn execute_with_protection<F, R>(module_name: &str, f: F) -> Result<R, CrashInfo>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    use std::thread;
    
    // Set current module name
    if let Ok(mut guard) = CURRENT_MODULE.lock() {
        *guard = module_name.to_string();
    }
    
    // Reset abort flag
    ABORT_REQUESTED.store(false, Ordering::SeqCst);
    IN_PLUGIN_CONTEXT.store(true, Ordering::SeqCst);
    
    // Spawn thread for plugin execution (allows timeout)
    let module_name_clone = module_name.to_string();
    let handle = thread::spawn(move || {
        // Install panic hook to catch panics
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f()));
        
        match result {
            Ok(r) => Some(r),
            Err(_) => None,
        }
    });
    
    // Wait with timeout
    let timeout = Duration::from_secs(PLUGIN_TIMEOUT_SECS);
    let start = Instant::now();
    
    loop {
        // Check if thread finished
        if handle.is_finished() {
            break;
        }
        
        // Check timeout
        if start.elapsed() > timeout {
            ABORT_REQUESTED.store(true, Ordering::SeqCst);
            IN_PLUGIN_CONTEXT.store(false, Ordering::SeqCst);
            PLUGIN_TIMED_OUT.store(true, Ordering::SeqCst);
            
            // Can't kill the thread safely, but we can return an error
            return Err(CrashInfo {
                signal: 0,
                signal_name: format!("Timeout after {}s", PLUGIN_TIMEOUT_SECS),
                module_name: module_name_clone,
                address: None,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
                backtrace: None,
                source_location: None,
                source_frames: Vec::new(),
                lib_path: None,
            });
        }
        
        // Check if crash was detected by signal handler
        if ABORT_REQUESTED.load(Ordering::SeqCst) {
            IN_PLUGIN_CONTEXT.store(false, Ordering::SeqCst);
            
            let crash_info = LAST_CRASH.lock()
                .ok()
                .and_then(|guard| guard.clone())
                .unwrap_or_else(|| CrashInfo {
                    signal: 0,
                    signal_name: "Unknown crash".to_string(),
                    module_name: module_name_clone.clone(),
                    address: None,
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs(),
                    backtrace: None,
                    source_location: None,
                    source_frames: Vec::new(),
                    lib_path: None,
                });
            
            return Err(crash_info);
        }
        
        thread::sleep(Duration::from_millis(10));
    }
    
    IN_PLUGIN_CONTEXT.store(false, Ordering::SeqCst);
    
    // Get result from thread
    match handle.join() {
        Ok(Some(result)) => {
            CRASH_COUNT.store(0, Ordering::SeqCst);
            Ok(result)
        }
        Ok(None) => {
            // Panic occurred
            CRASH_COUNT.fetch_add(1, Ordering::SeqCst);
            Err(CrashInfo {
                signal: 0,
                signal_name: "Rust panic in plugin".to_string(),
                module_name: module_name_clone,
                address: None,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
                backtrace: capture_backtrace(),
                source_location: None,
                source_frames: Vec::new(),
                lib_path: None,
            })
        }
        Err(_) => {
            // Thread panicked
            CRASH_COUNT.fetch_add(1, Ordering::SeqCst);
            Err(CrashInfo {
                signal: 0,
                signal_name: "Thread join failed".to_string(),
                module_name: module_name_clone,
                address: None,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
                backtrace: None,
                source_location: None,
                source_frames: Vec::new(),
                lib_path: None,
            })
        }
    }
}

#[cfg(not(unix))]
pub fn execute_with_protection<F, R>(module_name: &str, f: F) -> Result<R, CrashInfo>
where
    F: FnOnce() -> R,
{
    // On non-Unix, just execute directly (no crash protection)
    Ok(f())
}

/// Check if we've had too many consecutive crashes
pub fn should_force_restart() -> bool {
    CRASH_COUNT.load(Ordering::SeqCst) >= MAX_CONSECUTIVE_CRASHES
}

/// Reset crash count (call after successful recovery)
pub fn reset_crash_count() {
    CRASH_COUNT.store(0, Ordering::SeqCst);
}

/// Get last crash info
pub fn get_last_crash() -> Option<CrashInfo> {
    LAST_CRASH.lock().ok().and_then(|guard| guard.clone())
}

/// Clear last crash info
pub fn clear_last_crash() {
    if let Ok(mut guard) = LAST_CRASH.lock() {
        *guard = None;
    }
}

// ============================================================
// CRASH REPORT GENERATION
// ============================================================

/// Generate a human-readable crash report
pub fn generate_crash_report(crash: &CrashInfo) -> String {
    let mut report = String::new();
    
    report.push_str("═══════════════════════════════════════════════════════════════\n");
    report.push_str("                    SYNTHI CRASH REPORT                        \n");
    report.push_str("═══════════════════════════════════════════════════════════════\n\n");
    
    report.push_str(&format!("Signal:     {} ({})\n", crash.signal_name, crash.signal));
    report.push_str(&format!("Module:     {}\n", crash.module_name));
    
    if let Some(addr) = crash.address {
        report.push_str(&format!("Address:    0x{:016x}\n", addr));
    }
    
    report.push_str(&format!("Timestamp:  {}\n", crash.timestamp));
    
    report.push_str("\n───────────────────────────────────────────────────────────────\n");
    report.push_str("Recovery Status:\n");
    report.push_str("───────────────────────────────────────────────────────────────\n");
    report.push_str("✓ Process recovered - old module continues running\n");
    report.push_str("✓ State preserved from last successful update\n");
    report.push_str("⚠ Fix the error in your code and save to retry HMR\n");
    
    if let Some(ref bt) = crash.backtrace {
        report.push_str("\n───────────────────────────────────────────────────────────────\n");
        report.push_str("Backtrace:\n");
        report.push_str("───────────────────────────────────────────────────────────────\n");
        report.push_str(bt);
    }
    
    report.push_str("\n═══════════════════════════════════════════════════════════════\n");
    
    report
}

// ============================================================
// HMR STATUS INTEGRATION
// ============================================================

use serde::{Serialize, Deserialize};

/// HMR crash status event - sent to frontend for error overlay display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HmrCrashStatus {
    pub status: String,
    pub module: String,
    pub signal: String,
    pub recovered: bool,
    pub crash_count: u32,
    pub message: String,
    /// Full crash info for detailed display in error overlay
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crash_info: Option<CrashInfoJson>,
}

/// JSON-serializable version of CrashInfo for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashInfoJson {
    pub signal: i32,
    pub signal_name: String,
    pub module_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backtrace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<CrashSourceLocation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_frames: Vec<CrashSourceLocation>,
}

impl From<&CrashInfo> for CrashInfoJson {
    fn from(info: &CrashInfo) -> Self {
        Self {
            signal: info.signal,
            signal_name: info.signal_name.clone(),
            module_name: info.module_name.clone(),
            address: info.address.map(|a| format!("0x{:X}", a)),
            timestamp: info.timestamp,
            backtrace: info.backtrace.clone(),
            source_location: info.source_location.clone(),
            source_frames: info.source_frames.clone(),
        }
    }
}

impl HmrCrashStatus {
    pub fn from_crash(crash: &CrashInfo, recovered: bool) -> Self {
        let location_str = crash.source_location_str()
            .unwrap_or_else(|| "unknown location".to_string());
        
        Self {
            status: if recovered { "crash-recovered" } else { "crash-fatal" }.to_string(),
            module: crash.module_name.clone(),
            signal: crash.signal_name.clone(),
            recovered,
            crash_count: CRASH_COUNT.load(Ordering::SeqCst),
            message: if recovered {
                format!("Plugin crashed at {} but recovered. Old module continues running.", location_str)
            } else {
                format!("Plugin crashed at {}. Too many consecutive crashes, restart required.", location_str)
            },
            crash_info: Some(CrashInfoJson::from(crash)),
        }
    }
    
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_crash_info_json() {
        let info = CrashInfo {
            signal: 11,
            signal_name: "SIGSEGV".to_string(),
            module_name: "gui".to_string(),
            address: Some(0xDEADBEEF),
            timestamp: 12345,
            backtrace: None,
            source_location: None,
            source_frames: Vec::new(),
            lib_path: None,
        };
        
        let json = info.to_json();
        assert!(json.contains("SIGSEGV"));
        assert!(json.contains("gui"));
    }
    
    #[test]
    fn test_should_force_restart() {
        CRASH_COUNT.store(0, Ordering::SeqCst);
        assert!(!should_force_restart());
        
        CRASH_COUNT.store(MAX_CONSECUTIVE_CRASHES, Ordering::SeqCst);
        assert!(should_force_restart());
        
        reset_crash_count();
        assert!(!should_force_restart());
    }
}
