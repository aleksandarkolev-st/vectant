// ============================================================
// STRICT PLUGIN CONTRACT - THREAD & RESOURCE ENFORCEMENT
// ============================================================
// This module enforces that plugins follow a strict contract:
// - No arbitrary thread spawning
// - All async work through runner-provided APIs
// - Explicit quiescence hooks
// - Resource lifetime tracking
//
// RATIONALE:
// - dlclose is UB if threads are running
// - Callbacks into unloaded code cause crashes
// - TLS destructors in unloaded code cause crashes
// - Global singletons may hold references to unloaded code
//
// DESIGN:
// - Plugins must use runner-provided task API
// - Runner tracks all plugin-owned resources
// - Before unload, plugin must prove quiescence
// - If quiescence fails, refuse warm reload
// ============================================================

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

// ============================================================
// RUNNER-PROVIDED TASK API (plugins use this instead of spawning)
// ============================================================

/// Task handle returned when spawning
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TaskHandle(u64);

/// Task state
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    Pending,
    Running,
    Completed,
    Cancelled,
    Failed,
}

/// Task completion callback (called in runner context)
pub type TaskCompleteFn =
    unsafe extern "C" fn(handle: u64, result: *const c_void, user_data: *mut c_void);

/// Task info tracked by runner
struct TaskInfo {
    handle: TaskHandle,
    module_id: String,
    state: TaskState,
    started_at: Option<Instant>,
    completed_at: Option<Instant>,
}

/// Timer handle
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TimerHandle(u64);

/// Timer callback
pub type TimerCallbackFn = unsafe extern "C" fn(handle: u64, user_data: *mut c_void);

/// Timer info
struct TimerInfo {
    handle: TimerHandle,
    module_id: String,
    interval: Duration,
    repeating: bool,
    next_fire: Instant,
    cancelled: bool,
}

/// Callback registration handle
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CallbackHandle(u64);

/// Registered callback info
struct CallbackInfo {
    handle: CallbackHandle,
    module_id: String,
    callback_ptr: *const c_void,
    active: bool,
}

// ============================================================
// TASK REGISTRY - Central tracking of all plugin resources
// ============================================================

/// Central registry for all plugin-owned resources
pub struct PluginResourceRegistry {
    /// Active tasks by handle
    tasks: RwLock<HashMap<TaskHandle, TaskInfo>>,
    /// Active timers by handle
    timers: RwLock<HashMap<TimerHandle, TimerInfo>>,
    /// Registered callbacks by handle
    callbacks: RwLock<HashMap<CallbackHandle, CallbackInfo>>,
    /// Handle counter
    next_handle: AtomicU64,
    /// Per-module resource counts for quick lookup
    module_counts: RwLock<HashMap<String, ModuleResourceCount>>,
}

/// Resource counts per module
#[derive(Debug, Clone, Default)]
pub struct ModuleResourceCount {
    active_tasks: u32,
    pending_timers: u32,
    registered_callbacks: u32,
}

impl PluginResourceRegistry {
    pub fn new() -> Self {
        Self {
            tasks: RwLock::new(HashMap::new()),
            timers: RwLock::new(HashMap::new()),
            callbacks: RwLock::new(HashMap::new()),
            next_handle: AtomicU64::new(1),
            module_counts: RwLock::new(HashMap::new()),
        }
    }

    fn next_handle(&self) -> u64 {
        self.next_handle.fetch_add(1, Ordering::SeqCst)
    }

    /// Spawn a task owned by a module
    pub fn spawn_task(&self, module_id: &str) -> TaskHandle {
        let handle = TaskHandle(self.next_handle());

        let info = TaskInfo {
            handle,
            module_id: module_id.to_string(),
            state: TaskState::Pending,
            started_at: None,
            completed_at: None,
        };

        self.tasks.write().unwrap().insert(handle, info);
        self.increment_count(module_id, |c| c.active_tasks += 1);

        handle
    }

    /// Mark task as completed
    pub fn complete_task(&self, handle: TaskHandle, success: bool) {
        if let Some(info) = self.tasks.write().unwrap().get_mut(&handle) {
            info.state = if success {
                TaskState::Completed
            } else {
                TaskState::Failed
            };
            info.completed_at = Some(Instant::now());
            self.decrement_count(&info.module_id, |c| {
                c.active_tasks = c.active_tasks.saturating_sub(1)
            });
        }
    }

    /// Register a timer owned by a module
    pub fn register_timer(
        &self,
        module_id: &str,
        interval: Duration,
        repeating: bool,
    ) -> TimerHandle {
        let handle = TimerHandle(self.next_handle());

        let info = TimerInfo {
            handle,
            module_id: module_id.to_string(),
            interval,
            repeating,
            next_fire: Instant::now() + interval,
            cancelled: false,
        };

        self.timers.write().unwrap().insert(handle, info);
        self.increment_count(module_id, |c| c.pending_timers += 1);

        handle
    }

    /// Cancel a timer
    pub fn cancel_timer(&self, handle: TimerHandle) {
        if let Some(info) = self.timers.write().unwrap().get_mut(&handle) {
            if !info.cancelled {
                info.cancelled = true;
                self.decrement_count(&info.module_id, |c| {
                    c.pending_timers = c.pending_timers.saturating_sub(1)
                });
            }
        }
    }

    /// Register a callback owned by a module
    pub fn register_callback(
        &self,
        module_id: &str,
        callback_ptr: *const c_void,
    ) -> CallbackHandle {
        let handle = CallbackHandle(self.next_handle());

        let info = CallbackInfo {
            handle,
            module_id: module_id.to_string(),
            callback_ptr,
            active: true,
        };

        self.callbacks.write().unwrap().insert(handle, info);
        self.increment_count(module_id, |c| c.registered_callbacks += 1);

        handle
    }

    /// Unregister a callback
    pub fn unregister_callback(&self, handle: CallbackHandle) {
        if let Some(info) = self.callbacks.write().unwrap().remove(&handle) {
            if info.active {
                self.decrement_count(&info.module_id, |c| {
                    c.registered_callbacks = c.registered_callbacks.saturating_sub(1)
                });
            }
        }
    }

    /// Get resource counts for a module
    pub fn get_module_counts(&self, module_id: &str) -> ModuleResourceCount {
        self.module_counts
            .read()
            .unwrap()
            .get(module_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Check if module is quiescent (no active resources)
    pub fn is_module_quiescent(&self, module_id: &str) -> QuiescenceCheck {
        let counts = self.get_module_counts(module_id);

        QuiescenceCheck {
            is_quiescent: counts.active_tasks == 0
                && counts.pending_timers == 0
                && counts.registered_callbacks == 0,
            active_tasks: counts.active_tasks,
            pending_timers: counts.pending_timers,
            registered_callbacks: counts.registered_callbacks,
        }
    }

    /// Cancel all resources for a module
    pub fn cancel_module_resources(&self, module_id: &str) -> u32 {
        let mut cancelled = 0u32;

        // Cancel tasks
        {
            let mut tasks = self.tasks.write().unwrap();
            for info in tasks.values_mut() {
                if info.module_id == module_id && info.state == TaskState::Running {
                    info.state = TaskState::Cancelled;
                    cancelled += 1;
                }
            }
        }

        // Cancel timers
        {
            let mut timers = self.timers.write().unwrap();
            for info in timers.values_mut() {
                if info.module_id == module_id && !info.cancelled {
                    info.cancelled = true;
                    cancelled += 1;
                }
            }
        }

        // Deactivate callbacks
        {
            let mut callbacks = self.callbacks.write().unwrap();
            for info in callbacks.values_mut() {
                if info.module_id == module_id && info.active {
                    info.active = false;
                    cancelled += 1;
                }
            }
        }

        // Clear counts
        self.module_counts.write().unwrap().remove(module_id);

        cancelled
    }

    fn increment_count<F: FnOnce(&mut ModuleResourceCount)>(&self, module_id: &str, f: F) {
        let mut counts = self.module_counts.write().unwrap();
        let count = counts.entry(module_id.to_string()).or_default();
        f(count);
    }

    fn decrement_count<F: FnOnce(&mut ModuleResourceCount)>(&self, module_id: &str, f: F) {
        let mut counts = self.module_counts.write().unwrap();
        if let Some(count) = counts.get_mut(module_id) {
            f(count);
        }
    }
}

/// Result of quiescence check
#[derive(Debug, Clone)]
pub struct QuiescenceCheck {
    pub is_quiescent: bool,
    pub active_tasks: u32,
    pub pending_timers: u32,
    pub registered_callbacks: u32,
}

// ============================================================
// RUNNER API FOR PLUGINS (exposed via HotApi)
// ============================================================

/// Extended runner API with task management
/// Plugins MUST use these instead of spawning threads directly
#[repr(C)]
pub struct ExtendedRunnerApi {
    /// Base runner API (for compatibility)
    pub base_size: u32,
    pub base_version: u32,

    // === Task API (use instead of std::thread::spawn) ===
    /// Spawn a task (returns handle, calls callback on completion)
    /// Plugin must NOT call this after quiescence requested
    pub spawn_task: Option<
        unsafe extern "C" fn(
            task_fn: unsafe extern "C" fn(*mut c_void) -> *const c_void,
            arg: *mut c_void,
            on_complete: TaskCompleteFn,
            user_data: *mut c_void,
        ) -> u64,
    >,

    /// Cancel a task (best-effort, task may still complete)
    pub cancel_task: Option<unsafe extern "C" fn(handle: u64) -> bool>,

    /// Check if task is complete
    pub is_task_complete: Option<unsafe extern "C" fn(handle: u64) -> bool>,

    // === Timer API (use instead of sleep loops) ===
    /// Register a timer
    pub register_timer: Option<
        unsafe extern "C" fn(
            interval_ms: u32,
            repeating: bool,
            callback: TimerCallbackFn,
            user_data: *mut c_void,
        ) -> u64,
    >,

    /// Cancel a timer
    pub cancel_timer: Option<unsafe extern "C" fn(handle: u64)>,

    // === Callback Registration (for tracking) ===
    /// Register a callback with the runner
    /// Used to track callbacks for safe unloading
    pub register_callback: Option<unsafe extern "C" fn(callback_ptr: *const c_void) -> u64>,

    /// Unregister a callback
    pub unregister_callback: Option<unsafe extern "C" fn(handle: u64)>,

    // === Quiescence Protocol ===
    /// Called by runner when preparing to unload
    /// Plugin should start draining and return estimated time to quiescence
    pub on_quiescence_requested: Option<unsafe extern "C" fn(state: *mut c_void) -> u32>, // Returns estimated ms to quiescence

    /// Called to check if plugin is quiescent
    pub is_quiescent: Option<unsafe extern "C" fn(state: *mut c_void) -> bool>,

    /// Reserved for future extensions
    pub _reserved: [usize; 8],
}

// ============================================================
// CONTRACT VALIDATOR
// ============================================================

/// Validates that a module follows the strict plugin contract
pub struct ContractValidator {
    registry: Arc<PluginResourceRegistry>,
}

impl ContractValidator {
    pub fn new(registry: Arc<PluginResourceRegistry>) -> Self {
        Self { registry }
    }

    /// Validate that a module can be safely unloaded
    pub fn validate_for_unload(&self, module_id: &str, timeout: Duration) -> UnloadValidation {
        let start = Instant::now();

        // First check: immediate quiescence
        let check = self.registry.is_module_quiescent(module_id);

        if check.is_quiescent {
            return UnloadValidation {
                can_unload: true,
                reason: None,
                resources_cancelled: 0,
                wait_time: Duration::ZERO,
            };
        }

        // Second check: wait for quiescence
        eprintln!(
            "[Contract] Module {} not quiescent: {} tasks, {} timers, {} callbacks",
            module_id, check.active_tasks, check.pending_timers, check.registered_callbacks
        );

        // Request cancellation
        let cancelled = self.registry.cancel_module_resources(module_id);

        // Wait for cancellation to take effect
        while start.elapsed() < timeout {
            std::thread::sleep(Duration::from_millis(50));

            let check = self.registry.is_module_quiescent(module_id);
            if check.is_quiescent {
                return UnloadValidation {
                    can_unload: true,
                    reason: None,
                    resources_cancelled: cancelled,
                    wait_time: start.elapsed(),
                };
            }
        }

        // Final check
        let check = self.registry.is_module_quiescent(module_id);

        UnloadValidation {
            can_unload: false,
            reason: Some(format!(
                "Module still has {} active tasks, {} timers, {} callbacks after {}ms",
                check.active_tasks,
                check.pending_timers,
                check.registered_callbacks,
                timeout.as_millis()
            )),
            resources_cancelled: cancelled,
            wait_time: start.elapsed(),
        }
    }

    /// Force unload (unsafe, may cause crashes)
    pub fn force_unload(&self, module_id: &str) -> u32 {
        eprintln!(
            "[Contract] FORCE UNLOAD of {} - this may cause crashes!",
            module_id
        );
        self.registry.cancel_module_resources(module_id)
    }
}

/// Result of unload validation
#[derive(Debug, Clone)]
pub struct UnloadValidation {
    pub can_unload: bool,
    pub reason: Option<String>,
    pub resources_cancelled: u32,
    pub wait_time: Duration,
}

// ============================================================
// PLUGIN CONTRACT SYMBOLS
// ============================================================

/// Symbols that a contract-compliant plugin must export
pub mod contract_symbols {
    /// Check if plugin is quiescent (no active work)
    /// bool hot_is_quiescent(State* state)
    pub const IS_QUIESCENT: &[u8] = b"hot_is_quiescent\0";

    /// Request quiescence - plugin should start draining
    /// uint32_t hot_request_quiescence(State* state) -> estimated ms
    pub const REQUEST_QUIESCENCE: &[u8] = b"hot_request_quiescence\0";

    /// Cancel quiescence request - plugin can resume
    /// void hot_cancel_quiescence(State* state)
    pub const CANCEL_QUIESCENCE: &[u8] = b"hot_cancel_quiescence\0";

    /// Get module's self-reported resource counts
    /// void hot_get_resource_counts(uint32_t* tasks, uint32_t* timers, uint32_t* callbacks)
    pub const GET_RESOURCE_COUNTS: &[u8] = b"hot_get_resource_counts\0";
}

// ============================================================
// GLOBAL SINGLETON TRACKING
// ============================================================

/// Tracker for global singletons that must be cleaned up
pub struct SingletonTracker {
    singletons: RwLock<HashMap<String, SingletonInfo>>,
}

struct SingletonInfo {
    module_id: String,
    type_name: String,
    destructor: Option<unsafe extern "C" fn(*mut c_void)>,
    ptr: *mut c_void,
}

unsafe impl Send for SingletonInfo {}
unsafe impl Sync for SingletonInfo {}

impl SingletonTracker {
    pub fn new() -> Self {
        Self {
            singletons: RwLock::new(HashMap::new()),
        }
    }

    /// Register a singleton owned by a module
    pub fn register(
        &self,
        name: &str,
        module_id: &str,
        type_name: &str,
        ptr: *mut c_void,
        destructor: Option<unsafe extern "C" fn(*mut c_void)>,
    ) {
        let info = SingletonInfo {
            module_id: module_id.to_string(),
            type_name: type_name.to_string(),
            destructor,
            ptr,
        };

        self.singletons
            .write()
            .unwrap()
            .insert(name.to_string(), info);
    }

    /// Destroy all singletons for a module
    pub fn destroy_module_singletons(&self, module_id: &str) -> u32 {
        let mut destroyed = 0u32;
        let mut to_remove = Vec::new();

        {
            let singletons = self.singletons.read().unwrap();
            for (name, info) in singletons.iter() {
                if info.module_id == module_id {
                    to_remove.push(name.clone());
                }
            }
        }

        let mut singletons = self.singletons.write().unwrap();
        for name in to_remove {
            if let Some(info) = singletons.remove(&name) {
                if let Some(dtor) = info.destructor {
                    unsafe {
                        dtor(info.ptr);
                    }
                }
                destroyed += 1;
            }
        }

        destroyed
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resource_registry() {
        let registry = PluginResourceRegistry::new();

        // Spawn tasks
        let h1 = registry.spawn_task("test_module");
        let h2 = registry.spawn_task("test_module");

        let check = registry.is_module_quiescent("test_module");
        assert!(!check.is_quiescent);
        assert_eq!(check.active_tasks, 2);

        // Complete one task
        registry.complete_task(h1, true);

        let check = registry.is_module_quiescent("test_module");
        assert!(!check.is_quiescent);
        assert_eq!(check.active_tasks, 1);

        // Complete second task
        registry.complete_task(h2, true);

        let check = registry.is_module_quiescent("test_module");
        assert!(check.is_quiescent);
    }

    #[test]
    fn test_cancel_module_resources() {
        let registry = PluginResourceRegistry::new();

        registry.spawn_task("mod1");
        registry.spawn_task("mod1");
        registry.register_timer("mod1", Duration::from_secs(1), false);

        registry.spawn_task("mod2");

        // Cancel mod1
        let cancelled = registry.cancel_module_resources("mod1");
        assert!(cancelled > 0);

        // mod1 should be quiescent
        assert!(registry.is_module_quiescent("mod1").is_quiescent);

        // mod2 should still have resources
        assert!(!registry.is_module_quiescent("mod2").is_quiescent);
    }
}
