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
// - We use signal handlers + longjmp to recover from crashes
// - Plugin code runs in a "sandbox" that can be safely aborted
// ============================================================

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::ffi::c_void;

#[cfg(unix)]
use libc::{c_int, siginfo_t, sigaction, sigemptyset, SA_SIGINFO, SIGSEGV, SIGABRT, SIGFPE, SIGBUS};

#[cfg(unix)]
use setjmp;

#[cfg(unix)]
use std::mem::MaybeUninit;

/// Global flag indicating we're in plugin code (can recover from crash)
static IN_PLUGIN_CONTEXT: AtomicBool = AtomicBool::new(false);

/// Counter for consecutive crashes (triggers full restart if too many)
static CRASH_COUNT: AtomicU32 = AtomicU32::new(0);

/// Maximum consecutive crashes before giving up
const MAX_CONSECUTIVE_CRASHES: u32 = 3;

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

/// Global crash info storage
lazy_static::lazy_static! {
    static ref LAST_CRASH: Mutex<Option<CrashInfo>> = Mutex::new(None);
    static ref CURRENT_MODULE: Mutex<String> = Mutex::new(String::new());
    static ref CURRENT_LIB_PATH: Mutex<String> = Mutex::new(String::new());
}

/// Set the current library path for source map lookup
pub fn set_current_lib_path(path: &str) {
    if let Ok(mut guard) = CURRENT_LIB_PATH.lock() {
        *guard = path.to_string();
    }
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
    
    // Signal the recovery mechanism
    // We use a thread-local flag + longjmp to recover
    unsafe {
        // Mark that we should recover
        SHOULD_RECOVER.with(|flag| flag.set(true));
        
        // longjmp back to the safe point
        RECOVERY_POINT.with(|jmp_buf| {
            if !jmp_buf.borrow().is_null() {
                setjmp::longjmp(*jmp_buf.borrow() as *mut setjmp::jmp_buf, 1);
            }
        });
    }
    
    // If longjmp failed, we have no choice but to abort
    eprintln!("[CRASH] Fatal: Could not recover from {}", signal_name);
    unsafe {
        libc::signal(sig, libc::SIG_DFL);
        libc::raise(sig);
    }
}

#[cfg(unix)]
thread_local! {
    static RECOVERY_POINT: std::cell::RefCell<*mut c_void> = std::cell::RefCell::new(std::ptr::null_mut());
    static SHOULD_RECOVER: std::cell::Cell<bool> = std::cell::Cell::new(false);
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
    
    eprintln!("[CrashRecovery] Signal handlers installed");
    Ok(())
}

#[cfg(not(unix))]
pub fn install_crash_handlers() -> Result<(), String> {
    // Windows: Use __try/__except in the runner or Structured Exception Handling
    eprintln!("[CrashRecovery] Signal handlers not available on this platform");
    Ok(())
}

/// Execute plugin code with crash protection
/// Returns Ok(result) on success, Err(CrashInfo) if plugin crashed
#[cfg(unix)]
pub fn execute_with_protection<F, R>(module_name: &str, f: F) -> Result<R, CrashInfo>
where
    F: FnOnce() -> R,
{
    use std::mem::MaybeUninit;
    
    // Set current module name
    if let Ok(mut guard) = CURRENT_MODULE.lock() {
        *guard = module_name.to_string();
    }
    
    // Allocate jump buffer on stack
    let mut jmp_buf: MaybeUninit<setjmp::jmp_buf> = MaybeUninit::uninit();
    
    unsafe {
        // Set recovery point
        RECOVERY_POINT.with(|rp| {
            *rp.borrow_mut() = jmp_buf.as_mut_ptr() as *mut c_void;
        });
        
        // Clear recovery flag
        SHOULD_RECOVER.with(|flag| flag.set(false));
        
        // Mark that we're in plugin context
        IN_PLUGIN_CONTEXT.store(true, Ordering::SeqCst);
        
        // Set up the jump point
        let setjmp_result = setjmp::setjmp(jmp_buf.as_mut_ptr());
        
        if setjmp_result == 0 {
            // Normal execution path
            let result = f();
            
            // Cleanup
            IN_PLUGIN_CONTEXT.store(false, Ordering::SeqCst);
            RECOVERY_POINT.with(|rp| {
                *rp.borrow_mut() = std::ptr::null_mut();
            });
            
            // Reset crash count on success
            CRASH_COUNT.store(0, Ordering::SeqCst);
            
            Ok(result)
        } else {
            // Returned from longjmp (crash recovery path)
            IN_PLUGIN_CONTEXT.store(false, Ordering::SeqCst);
            RECOVERY_POINT.with(|rp| {
                *rp.borrow_mut() = std::ptr::null_mut();
            });
            
            // Get crash info
            let crash_info = LAST_CRASH.lock()
                .ok()
                .and_then(|guard| guard.clone())
                .unwrap_or_else(|| CrashInfo {
                    signal: 0,
                    signal_name: "Unknown".to_string(),
                    module_name: module_name.to_string(),
                    address: None,
                    timestamp: 0,
                    backtrace: None,
                    source_location: None,
                    source_frames: Vec::new(),
                    lib_path: None,
                });
            
            Err(crash_info)
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
