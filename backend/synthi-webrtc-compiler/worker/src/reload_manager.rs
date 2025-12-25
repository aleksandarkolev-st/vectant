// Reload manager now actively used via HmrOrchestrator
// Some advanced features (canary reload, circuit breakers) are still infrastructure
// for future integration - keeping dead_code allow for those
#![allow(dead_code)]

// ============================================================
// RELOAD MANAGER - COMPREHENSIVE HMR ORCHESTRATION
// ============================================================
// Addresses all HMR production concerns:
// - Reload class taxonomy (Safe/Warm/Cold)
// - Pre-reload snapshots for instant crash revert
// - Async task and background thread guardrails
// - In-flight request policies
// - Canary reload mode
// - Latency-aware reload decisions
// - Cascade hardening with circuit breakers
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
// rand is used via full path

// Import boundary types
pub use crate::boundary::BoundaryId;
use crate::state_manager::StateManager;

// ============================================================
// RELOAD CLASS TAXONOMY
// ============================================================
// Not all reloads are equal. Classify by safety and latency.

/// Reload classification - determines strategy and guardrails
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ReloadClass {
    /// SAFE RELOAD - Stateless, no side effects, instant
    /// - Pure function changes
    /// - Constant updates
    /// - Comment/whitespace only
    /// - Can reload while requests are in flight
    /// - No state migration needed
    /// - Target latency: <10ms
    Safe,
    
    /// WARM RELOAD - State preserved, minimal disruption
    /// - State schema unchanged
    /// - API signatures stable
    /// - Can migrate state in-place
    /// - Brief pause for in-flight requests
    /// - Target latency: <100ms
    Warm,
    
    /// COLD RELOAD - Full restart, state reset
    /// - Breaking API changes
    /// - State schema incompatible
    /// - Must drain all requests first
    /// - Full state reconstruction
    /// - Target latency: <1000ms
    Cold,
    
    /// CANARY RELOAD - Test new logic on subset
    /// - Shadow execution alongside old code
    /// - Compare outputs, don't serve from new
    /// - Promote to Warm/Cold after validation
    Canary,
}

impl ReloadClass {
    /// Maximum allowed latency for this reload class
    pub fn max_latency_ms(&self) -> u64 {
        match self {
            ReloadClass::Safe => 10,
            ReloadClass::Warm => 100,
            ReloadClass::Cold => 1000,
            ReloadClass::Canary => 5000, // Can be slow, it's shadow
        }
    }
    
    /// Whether to run semantic ABI tests for this class
    pub fn requires_semantic_tests(&self) -> bool {
        match self {
            ReloadClass::Safe => false,    // Skip for speed
            ReloadClass::Warm => true,     // Validate compatibility
            ReloadClass::Cold => true,     // Full validation
            ReloadClass::Canary => true,   // Always test canaries
        }
    }
    
    /// Whether in-flight requests must be drained first
    pub fn requires_request_drain(&self) -> bool {
        match self {
            ReloadClass::Safe => false,
            ReloadClass::Warm => false,  // Brief pause OK
            ReloadClass::Cold => true,   // Must drain
            ReloadClass::Canary => false,
        }
    }
    
    /// Whether async tasks must be stopped
    pub fn requires_task_shutdown(&self) -> bool {
        match self {
            ReloadClass::Safe => false,
            ReloadClass::Warm => false,
            ReloadClass::Cold => true,
            ReloadClass::Canary => false,
        }
    }
    
    /// Whether to create pre-reload snapshot
    pub fn requires_snapshot(&self) -> bool {
        match self {
            ReloadClass::Safe => false,  // Can always retry
            ReloadClass::Warm => true,   // Snapshot for rollback
            ReloadClass::Cold => true,   // Definitely snapshot
            ReloadClass::Canary => false, // Shadow only
        }
    }
}

/// Automatic reload class detection based on changes
#[derive(Debug, Clone)]
pub struct ReloadClassifier {
    /// Patterns that indicate safe reload
    safe_patterns: Vec<String>,
    /// Patterns that force cold reload
    cold_patterns: Vec<String>,
    /// Manual overrides per boundary (highest priority)
    boundary_overrides: HashMap<BoundaryId, ReloadClass>,
    /// File path pattern overrides (medium priority)
    path_overrides: Vec<(String, ReloadClass)>,
    /// Global override (lowest priority, for debugging)
    global_override: Option<ReloadClass>,
}

impl ReloadClassifier {
    pub fn new() -> Self {
        Self {
            safe_patterns: vec![
                "comment".to_string(),
                "whitespace".to_string(),
                "const_value".to_string(),
                "log_message".to_string(),
            ],
            cold_patterns: vec![
                "pub_fn_signature".to_string(),
                "state_struct".to_string(),
                "extern_c".to_string(),
                "abi_version".to_string(),
            ],
            boundary_overrides: HashMap::new(),
            path_overrides: Vec::new(),
            global_override: None,
        }
    }
    
    // =====================================================
    // MANUAL OVERRIDE HOOKS - Use when auto-detection fails
    // =====================================================
    
    /// Override classification for a specific boundary
    /// Use when auto-detection consistently gets it wrong
    pub fn set_boundary_override(&mut self, boundary_id: BoundaryId, class: ReloadClass) {
        self.boundary_overrides.insert(boundary_id, class);
    }
    
    /// Remove boundary override (revert to auto-detection)
    pub fn clear_boundary_override(&mut self, boundary_id: &BoundaryId) {
        self.boundary_overrides.remove(boundary_id);
    }
    
    /// Override classification for files matching a glob pattern
    /// Example: "**/*_test.rs" -> ReloadClass::Safe
    pub fn set_path_override(&mut self, pattern: String, class: ReloadClass) {
        // Remove existing pattern if present
        self.path_overrides.retain(|(p, _)| p != &pattern);
        self.path_overrides.push((pattern, class));
    }
    
    /// Set global override - FORCES all reloads to this class
    /// WARNING: Use only for debugging, disables safety checks
    pub fn set_global_override(&mut self, class: Option<ReloadClass>) {
        if class.is_some() {
            eprintln!(
                "WARNING: Global reload class override set to {:?}. \
                 This disables safety classification!",
                class
            );
        }
        self.global_override = class;
    }
    
    /// Check if a path matches any override patterns
    fn check_path_override(&self, file_path: &str) -> Option<ReloadClass> {
        for (pattern, class) in &self.path_overrides {
            if Self::glob_match(pattern, file_path) {
                return Some(*class);
            }
        }
        None
    }
    
    /// Simple glob matching (supports * and **)
    fn glob_match(pattern: &str, path: &str) -> bool {
        // Simplified glob: ** matches any path, * matches segment
        let pattern = pattern.replace("**", "§").replace("*", "[^/]*").replace("§", ".*");
        regex::Regex::new(&format!("^{}$", pattern))
            .map(|re| re.is_match(path))
            .unwrap_or(false)
    }
    
    /// Classify a reload based on what changed
    /// Priority: global_override > boundary_override > path_override > auto-detect
    pub fn classify(&self, changes: &ReloadChanges) -> ReloadClass {
        self.classify_with_context(changes, None, None)
    }
    
    /// Classify with full context for override checking
    pub fn classify_with_context(
        &self,
        changes: &ReloadChanges,
        boundary_id: Option<&BoundaryId>,
        file_path: Option<&str>,
    ) -> ReloadClass {
        // 1. Global override (debugging only)
        if let Some(class) = self.global_override {
            return class;
        }
        
        // 2. Boundary-specific override
        if let Some(bid) = boundary_id {
            if let Some(&class) = self.boundary_overrides.get(bid) {
                return class;
            }
        }
        
        // 3. Path pattern override
        if let Some(path) = file_path {
            if let Some(class) = self.check_path_override(path) {
                return class;
            }
        }
        
        // 4. Auto-detection (original logic)
        self.auto_classify(changes)
    }
    
    /// Original auto-classification logic (isolated for clarity)
    fn auto_classify(&self, changes: &ReloadChanges) -> ReloadClass {
        // Cold if any breaking changes
        if changes.has_breaking_api_change || 
           changes.has_state_schema_change ||
           !changes.removed_exports.is_empty() {
            return ReloadClass::Cold;
        }
        
        // Safe if only safe changes
        if changes.is_stateless_change && 
           changes.added_exports.is_empty() &&
           changes.modified_functions.iter().all(|f| !changes.api_functions.contains(f)) {
            return ReloadClass::Safe;
        }
        
        // Default to Warm
        ReloadClass::Warm
    }
    
    /// Get classification with confidence score (for debugging)
    pub fn classify_with_confidence(&self, changes: &ReloadChanges) -> (ReloadClass, ClassificationConfidence) {
        let class = self.auto_classify(changes);
        
        let confidence = if changes.has_breaking_api_change || changes.has_state_schema_change {
            ClassificationConfidence::High // Clear signals
        } else if changes.is_stateless_change && changes.modified_functions.is_empty() {
            ClassificationConfidence::High // Obviously safe
        } else if changes.modified_functions.len() > 5 {
            ClassificationConfidence::Low // Too many changes to be sure
        } else {
            ClassificationConfidence::Medium
        };
        
        (class, confidence)
    }
}

impl Default for ReloadClassifier {
    fn default() -> Self {
        Self::new()
    }
}

/// Confidence level for auto-classification
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClassificationConfidence {
    High,   // Clear signals, very likely correct
    Medium, // Reasonable guess
    Low,    // Many changes, uncertain - consider manual override
}

/// Detected changes for classification
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReloadChanges {
    pub modified_functions: HashSet<String>,
    pub api_functions: HashSet<String>,
    pub added_exports: HashSet<String>,
    pub removed_exports: HashSet<String>,
    pub has_breaking_api_change: bool,
    pub has_state_schema_change: bool,
    pub is_stateless_change: bool,
    /// File path for path-based overrides
    pub file_path: Option<String>,
    /// Explicit boundary ID for boundary overrides  
    pub boundary_id: Option<BoundaryId>,
}

// ============================================================
// PRE-RELOAD SNAPSHOTS
// ============================================================
// Snapshot everything before reload for instant crash revert
// OPTIMIZED: Validity tracking is O(1), not O(n)
// 
// STATE FORMAT: Snapshots store (build_id, bytes, format, state_version)
// - build_id: unique identifier for the module build
// - bytes: serialized state data (MsgPack preferred)
// - format: serialization format used (MsgPack/JSON)
// - state_version: module's state_version for migration

/// State snapshot format
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SnapshotFormat {
    /// MessagePack binary format (preferred, faster)
    MsgPack,
    /// JSON text format (fallback, debuggable)
    Json,
    /// Raw memory copy (only valid for same-version hot swap)
    RawMemory,
}

impl Default for SnapshotFormat {
    fn default() -> Self {
        SnapshotFormat::MsgPack
    }
}

/// Complete system snapshot for crash recovery
#[derive(Debug, Clone)]
pub struct ReloadSnapshot {
    pub snapshot_id: u64,
    pub created_at: Instant,
    pub reload_class: ReloadClass,
    
    /// State snapshots per boundary
    pub state_snapshots: HashMap<BoundaryId, StateSnapshot>,
    
    /// Module hashes before reload
    pub module_hashes: HashMap<String, u64>,
    
    /// In-flight request IDs (for replay)
    pub in_flight_requests: Vec<RequestSnapshot>,
    
    /// Async task states
    pub task_states: Vec<TaskSnapshot>,
    
    // VALIDITY: Use generation counter instead of per-snapshot bool
    // This makes invalidation O(1) instead of O(n)
    /// Generation when snapshot was created
    pub generation: u64,
    
    /// Reason if invalidated (lazy - set on access, not on invalidate)
    invalidation_reason: Option<String>,
}

impl ReloadSnapshot {
    /// Check validity against current generation (O(1))
    #[inline]
    pub fn is_valid(&self, current_valid_generation: u64) -> bool {
        self.generation >= current_valid_generation
    }
}

/// State snapshot with new format (build_id, bytes, format, state_version)
/// This replaces symbol-based state operations with serialized snapshot data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateSnapshot {
    pub boundary_id: BoundaryId,
    
    /// Unique identifier for the module build that created this state
    pub build_id: u64,
    
    /// Serialized state bytes (MsgPack or JSON)
    /// None if state was captured as handle only (lazy serialization)
    pub bytes: Option<Vec<u8>>,
    
    /// Format of the serialized bytes
    pub format: SnapshotFormat,
    
    /// Module's state_version when this snapshot was created
    /// Used for migration decisions
    pub state_version: u32,
    
    /// Legacy: state handle for lazy serialization
    /// Deprecated: prefer `bytes` for cross-version compatibility
    #[serde(skip)]
    pub state_handle: u64,
    
    /// Hash for quick equality check without deserialize
    pub state_hash: u64,
    
    /// ABI version of the module
    pub abi_version: u32,
    
    /// Hash of the source code
    pub source_hash: u64,
}

impl StateSnapshot {
    /// Create a new state snapshot with serialized bytes
    pub fn new(
        boundary_id: BoundaryId,
        build_id: u64,
        bytes: Vec<u8>,
        format: SnapshotFormat,
        state_version: u32,
    ) -> Self {
        // Compute hash of the bytes
        let state_hash = {
            use std::hash::{Hash, Hasher};
            use std::collections::hash_map::DefaultHasher;
            let mut hasher = DefaultHasher::new();
            bytes.hash(&mut hasher);
            hasher.finish()
        };
        
        Self {
            boundary_id,
            build_id,
            bytes: Some(bytes),
            format,
            state_version,
            state_handle: 0,
            state_hash,
            abi_version: 0,
            source_hash: 0,
        }
    }
    
    /// Create a lazy snapshot (handle only, serialize on revert)
    /// Deprecated: Use new() with serialized bytes instead
    pub fn new_lazy(boundary_id: BoundaryId, state_handle: u64) -> Self {
        Self {
            boundary_id,
            build_id: 0,
            bytes: None,
            format: SnapshotFormat::RawMemory,
            state_version: 0,
            state_handle,
            state_hash: 0,
            abi_version: 0,
            source_hash: 0,
        }
    }
    
    /// Check if this snapshot has serialized bytes
    pub fn has_bytes(&self) -> bool {
        self.bytes.is_some() && !self.bytes.as_ref().unwrap().is_empty()
    }
    
    /// Get the serialized bytes if available
    pub fn get_bytes(&self) -> Option<&[u8]> {
        self.bytes.as_deref()
    }
}

#[derive(Debug, Clone)]
pub struct RequestSnapshot {
    pub request_id: String,
    pub boundary_id: BoundaryId,
    pub started_at: Instant,
    pub payload_hash: u64,
}

#[derive(Debug, Clone)]
pub struct TaskSnapshot {
    pub task_id: String,
    pub task_type: AsyncTaskType,
    pub state: TaskState,
    pub checkpoint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsyncTaskType {
    BackgroundComputation,
    PeriodicUpdate,
    EventListener,
    StreamProcessor,
    FileWatcher,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    Running,
    Paused,
    Checkpointed,
    Terminated,
}

/// Snapshot manager with O(1) validity tracking
pub struct SnapshotManager {
    snapshots: VecDeque<ReloadSnapshot>,
    max_snapshots: usize,
    next_id: AtomicU64,
    /// Current generation counter
    current_generation: AtomicU64,
    /// Minimum valid generation (snapshots below this are invalid)
    /// Incrementing this invalidates all older snapshots in O(1)
    min_valid_generation: AtomicU64,
}

impl SnapshotManager {
    pub fn new(max_snapshots: usize) -> Self {
        Self {
            snapshots: VecDeque::new(),
            max_snapshots,
            next_id: AtomicU64::new(1),
            current_generation: AtomicU64::new(1),
            min_valid_generation: AtomicU64::new(1),
        }
    }
    
    /// Create a new snapshot before reload
    /// OPTIMIZED: Only stores handles, not full state
    /// For proper HMR, use create_snapshot_with_bytes instead
    pub fn create_snapshot(
        &mut self,
        reload_class: ReloadClass,
        _state_manager: &StateManager,
        boundaries: &[BoundaryId],
    ) -> u64 {
        let snapshot_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let generation = self.current_generation.fetch_add(1, Ordering::SeqCst);
        
        // Collect state snapshots - LAZY: only store handles
        let mut state_snapshots = HashMap::new();
        for boundary_id in boundaries {
            // Store handle only, no serialized bytes
            // For proper cross-version migration, use create_snapshot_with_bytes
            state_snapshots.insert(
                boundary_id.clone(), 
                StateSnapshot::new_lazy(boundary_id.clone(), snapshot_id)
            );
        }
        
        let snapshot = ReloadSnapshot {
            snapshot_id,
            created_at: Instant::now(),
            reload_class,
            state_snapshots,
            module_hashes: HashMap::new(),
            in_flight_requests: Vec::new(),
            task_states: Vec::new(),
            generation,
            invalidation_reason: None,
        };
        
        self.snapshots.push_back(snapshot);
        
        // Enforce retention
        while self.snapshots.len() > self.max_snapshots {
            self.snapshots.pop_front();
        }
        
        snapshot_id
    }
    
    /// Create a snapshot with serialized state bytes (preferred for HMR)
    /// This is the recommended method for cross-version migration
    pub fn create_snapshot_with_bytes(
        &mut self,
        reload_class: ReloadClass,
        boundary_states: Vec<(BoundaryId, u64, Vec<u8>, SnapshotFormat, u32)>, // (boundary_id, build_id, bytes, format, state_version)
    ) -> u64 {
        let snapshot_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let generation = self.current_generation.fetch_add(1, Ordering::SeqCst);
        
        let mut state_snapshots = HashMap::new();
        for (boundary_id, build_id, bytes, format, state_version) in boundary_states {
            state_snapshots.insert(
                boundary_id.clone(),
                StateSnapshot::new(boundary_id, build_id, bytes, format, state_version),
            );
        }
        
        let snapshot = ReloadSnapshot {
            snapshot_id,
            created_at: Instant::now(),
            reload_class,
            state_snapshots,
            module_hashes: HashMap::new(),
            in_flight_requests: Vec::new(),
            task_states: Vec::new(),
            generation,
            invalidation_reason: None,
        };
        
        self.snapshots.push_back(snapshot);
        
        // Enforce retention
        while self.snapshots.len() > self.max_snapshots {
            self.snapshots.pop_front();
        }
        
        snapshot_id
    }
    
    /// Revert to a snapshot after crash
    pub fn revert_to_snapshot(&mut self, snapshot_id: u64) -> Result<&ReloadSnapshot, String> {
        let min_gen = self.min_valid_generation.load(Ordering::SeqCst);
        
        let snapshot = self.snapshots
            .iter()
            .find(|s| s.snapshot_id == snapshot_id)
            .ok_or_else(|| format!("Snapshot {} not found", snapshot_id))?;
        
        // O(1) validity check
        if !snapshot.is_valid(min_gen) {
            return Err(format!(
                "Snapshot {} is invalid (generation {} < min {})",
                snapshot_id, snapshot.generation, min_gen
            ));
        }
        
        Ok(snapshot)
    }
    
    /// Invalidate all snapshots older than given generation - O(1)!
    /// Does NOT iterate through snapshots
    pub fn invalidate_before_generation(&self, generation: u64) {
        self.min_valid_generation.fetch_max(generation, Ordering::SeqCst);
    }
    
    /// Invalidate all snapshots before a snapshot ID - O(n) but only to find gen
    pub fn invalidate_before(&mut self, snapshot_id: u64, _reason: &str) {
        if let Some(snapshot) = self.snapshots.iter().find(|s| s.snapshot_id == snapshot_id) {
            // Invalidate by bumping min generation - O(1)
            self.invalidate_before_generation(snapshot.generation);
        }
    }
    
    /// Get most recent valid snapshot - O(n) but usually small
    pub fn latest_valid(&self) -> Option<&ReloadSnapshot> {
        let min_gen = self.min_valid_generation.load(Ordering::SeqCst);
        self.snapshots.iter().rev().find(|s| s.is_valid(min_gen))
    }
    
    /// Check validity without loading snapshot - O(1)
    #[inline]
    pub fn is_valid(&self, snapshot_id: u64) -> bool {
        let min_gen = self.min_valid_generation.load(Ordering::SeqCst);
        self.snapshots
            .iter()
            .find(|s| s.snapshot_id == snapshot_id)
            .map(|s| s.is_valid(min_gen))
            .unwrap_or(false)
    }
}

// ============================================================
// ASYNC TASK GUARDRAILS
// ============================================================
// Handle long-lived tasks during reload
// HARDENED: Detect unregistered tasks, enforce discipline

/// Registry for async tasks that must be managed during reload
/// ENFORCEMENT: Detects unregistered tasks via runtime scanning
pub struct AsyncTaskRegistry {
    tasks: HashMap<String, RegisteredTask>,
    shutdown_timeout: Duration,
    /// Track spawn points for unregistered task detection
    known_spawn_points: HashSet<String>,
    /// Violations detected (for alerting)
    violations: Vec<TaskViolation>,
    /// Whether to block reload on violations
    strict_mode: bool,
}

/// Violation of task registration discipline
#[derive(Debug, Clone)]
pub struct TaskViolation {
    pub detected_at: Instant,
    pub violation_type: TaskViolationType,
    pub boundary_id: Option<BoundaryId>,
    pub details: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskViolationType {
    /// Task spawned without registration
    UnregisteredSpawn,
    /// Task running longer than expected without checkpoint
    StaleTask,
    /// Task claims checkpoint support but never checkpoints
    FakeCheckpoint,
    /// Task ignoring shutdown signal
    IgnoringShutdown,
    /// Multiple tasks with same ID
    DuplicateId,
}

#[derive(Debug)]
pub struct RegisteredTask {
    pub task_id: String,
    pub task_type: AsyncTaskType,
    pub boundary_id: BoundaryId,
    pub supports_checkpoint: bool,
    pub supports_pause: bool,
    pub shutdown_signal: Arc<AtomicBool>,
    pub registered_at: Instant,
    /// Last checkpoint time (to detect fake checkpoint claims)
    pub last_checkpoint: Option<Instant>,
    /// Shutdown signaled at (to detect ignoring shutdown)
    pub shutdown_signaled_at: Option<Instant>,
}

impl AsyncTaskRegistry {
    pub fn new(shutdown_timeout: Duration) -> Self {
        Self {
            tasks: HashMap::new(),
            shutdown_timeout,
            known_spawn_points: HashSet::new(),
            violations: Vec::new(),
            strict_mode: false, // Default permissive
        }
    }
    
    /// Create strict registry that blocks on violations
    pub fn new_strict(shutdown_timeout: Duration) -> Self {
        Self {
            tasks: HashMap::new(),
            shutdown_timeout,
            known_spawn_points: HashSet::new(),
            violations: Vec::new(),
            strict_mode: true,
        }
    }
    
    /// Register a known spawn point (for static analysis)
    pub fn register_spawn_point(&mut self, location: String) {
        self.known_spawn_points.insert(location);
    }
    
    /// Register a task that must be managed during reload
    pub fn register(
        &mut self,
        task_id: String,
        task_type: AsyncTaskType,
        boundary_id: BoundaryId,
        supports_checkpoint: bool,
        supports_pause: bool,
    ) -> Arc<AtomicBool> {
        // Check for duplicate ID
        if self.tasks.contains_key(&task_id) {
            self.violations.push(TaskViolation {
                detected_at: Instant::now(),
                violation_type: TaskViolationType::DuplicateId,
                boundary_id: Some(boundary_id.clone()),
                details: format!("Task '{}' registered twice", task_id),
            });
        }
        
        let shutdown_signal = Arc::new(AtomicBool::new(false));
        
        self.tasks.insert(task_id.clone(), RegisteredTask {
            task_id,
            task_type,
            boundary_id,
            supports_checkpoint,
            supports_pause,
            shutdown_signal: shutdown_signal.clone(),
            registered_at: Instant::now(),
            last_checkpoint: None,
            shutdown_signaled_at: None,
        });
        
        shutdown_signal
    }
    
    /// Record a checkpoint (validates checkpoint claims)
    pub fn record_checkpoint(&mut self, task_id: &str) {
        if let Some(task) = self.tasks.get_mut(task_id) {
            task.last_checkpoint = Some(Instant::now());
        }
    }
    
    /// Detect violations - call periodically or before reload
    pub fn detect_violations(&mut self) {
        let now = Instant::now();
        
        for task in self.tasks.values() {
            // Check for stale tasks (running > 1 hour without checkpoint)
            if task.supports_checkpoint {
                let last_activity = task.last_checkpoint.unwrap_or(task.registered_at);
                if now.duration_since(last_activity) > Duration::from_secs(3600) {
                    self.violations.push(TaskViolation {
                        detected_at: now,
                        violation_type: TaskViolationType::StaleTask,
                        boundary_id: Some(task.boundary_id.clone()),
                        details: format!(
                            "Task '{}' claims checkpoint but hasn't checkpointed in >1h",
                            task.task_id
                        ),
                    });
                }
            }
            
            // Check for tasks ignoring shutdown signal
            if let Some(signaled_at) = task.shutdown_signaled_at {
                if now.duration_since(signaled_at) > self.shutdown_timeout {
                    self.violations.push(TaskViolation {
                        detected_at: now,
                        violation_type: TaskViolationType::IgnoringShutdown,
                        boundary_id: Some(task.boundary_id.clone()),
                        details: format!(
                            "Task '{}' ignoring shutdown signal for {:?}",
                            task.task_id,
                            now.duration_since(signaled_at)
                        ),
                    });
                }
            }
        }
    }
    
    /// Report an unregistered task spawn (call from instrumented code)
    pub fn report_unregistered_spawn(&mut self, spawn_location: &str, boundary_id: Option<BoundaryId>) {
        self.violations.push(TaskViolation {
            detected_at: Instant::now(),
            violation_type: TaskViolationType::UnregisteredSpawn,
            boundary_id,
            details: format!("Unregistered task spawn at: {}", spawn_location),
        });
    }
    
    /// Get current violations
    pub fn get_violations(&self) -> &[TaskViolation] {
        &self.violations
    }
    
    /// Clear violations (after handling)
    pub fn clear_violations(&mut self) {
        self.violations.clear();
    }
    
    /// Check if reload should be blocked due to violations
    pub fn should_block_reload(&self) -> bool {
        self.strict_mode && !self.violations.is_empty()
    }
    
    /// Unregister a completed task
    pub fn unregister(&mut self, task_id: &str) {
        self.tasks.remove(task_id);
    }
    
    /// Get tasks that will be affected by a boundary reload
    pub fn tasks_for_boundary(&self, boundary_id: &BoundaryId) -> Vec<&RegisteredTask> {
        self.tasks
            .values()
            .filter(|t| &t.boundary_id == boundary_id)
            .collect()
    }
    
    /// Prepare tasks for reload based on reload class
    pub fn prepare_for_reload(
        &mut self,
        boundary_id: &BoundaryId,
        reload_class: ReloadClass,
    ) -> TaskPreparationResult {
        // Run violation detection first
        self.detect_violations();
        let affected_tasks = self.tasks_for_boundary(boundary_id);
        
        let mut to_checkpoint = Vec::new();
        let mut to_pause = Vec::new();
        let mut to_terminate = Vec::new();
        let mut blocking = Vec::new();
        
        for task in affected_tasks {
            match reload_class {
                ReloadClass::Safe => {
                    // Safe reload - tasks can continue
                }
                ReloadClass::Warm => {
                    // Warm reload - pause if possible
                    if task.supports_pause {
                        to_pause.push(task.task_id.clone());
                    } else if task.supports_checkpoint {
                        to_checkpoint.push(task.task_id.clone());
                    } else {
                        blocking.push(task.task_id.clone());
                    }
                }
                ReloadClass::Cold => {
                    // Cold reload - terminate all
                    if task.supports_checkpoint {
                        to_checkpoint.push(task.task_id.clone());
                    }
                    to_terminate.push(task.task_id.clone());
                }
                ReloadClass::Canary => {
                    // Canary - shadow only, no task changes
                }
            }
        }
        
        TaskPreparationResult {
            to_checkpoint,
            to_pause,
            to_terminate,
            blocking_tasks: blocking.clone(),
            can_proceed: blocking.is_empty() || reload_class == ReloadClass::Cold,
        }
    }
    
    /// Signal shutdown to tasks (tracks timing for violation detection)
    pub fn signal_shutdown(&mut self, task_ids: &[String]) {
        let now = Instant::now();
        for task_id in task_ids {
            if let Some(task) = self.tasks.get_mut(task_id) {
                task.shutdown_signal.store(true, Ordering::SeqCst);
                task.shutdown_signaled_at = Some(now);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct TaskPreparationResult {
    pub to_checkpoint: Vec<String>,
    pub to_pause: Vec<String>,
    pub to_terminate: Vec<String>,
    pub blocking_tasks: Vec<String>,
    pub can_proceed: bool,
}

// ============================================================
// IN-FLIGHT REQUEST POLICY
// ============================================================
// Clear policy for what happens to requests during reload

/// Policy for handling in-flight requests during reload
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InFlightPolicy {
    /// Allow requests to complete with old code
    CompleteWithOld,
    /// Pause requests, resume after reload
    PauseAndResume,
    /// Fail requests with retryable error
    FailRetryable,
    /// Queue requests for replay after reload
    QueueForReplay,
    /// Drain all requests before reload
    DrainFirst,
}

impl InFlightPolicy {
    /// Get default policy for reload class
    pub fn for_reload_class(class: ReloadClass) -> Self {
        match class {
            ReloadClass::Safe => InFlightPolicy::CompleteWithOld,
            ReloadClass::Warm => InFlightPolicy::PauseAndResume,
            ReloadClass::Cold => InFlightPolicy::DrainFirst,
            ReloadClass::Canary => InFlightPolicy::CompleteWithOld,
        }
    }
}

/// Tracks in-flight requests for policy enforcement
pub struct RequestTracker {
    requests: HashMap<String, TrackedRequest>,
    boundary_requests: HashMap<BoundaryId, HashSet<String>>,
    policy: InFlightPolicy,
    drain_timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct TrackedRequest {
    pub request_id: String,
    pub boundary_id: BoundaryId,
    pub started_at: Instant,
    pub state: RequestState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestState {
    Active,
    Paused,
    Completing,
    Queued,
    Failed,
}

impl RequestTracker {
    pub fn new(policy: InFlightPolicy, drain_timeout: Duration) -> Self {
        Self {
            requests: HashMap::new(),
            boundary_requests: HashMap::new(),
            policy,
            drain_timeout,
        }
    }
    
    /// Track a new request
    pub fn track(&mut self, request_id: String, boundary_id: BoundaryId) {
        self.requests.insert(request_id.clone(), TrackedRequest {
            request_id: request_id.clone(),
            boundary_id: boundary_id.clone(),
            started_at: Instant::now(),
            state: RequestState::Active,
        });
        
        self.boundary_requests
            .entry(boundary_id)
            .or_insert_with(HashSet::new)
            .insert(request_id);
    }
    
    /// Untrack a completed request
    pub fn untrack(&mut self, request_id: &str) {
        if let Some(req) = self.requests.remove(request_id) {
            if let Some(set) = self.boundary_requests.get_mut(&req.boundary_id) {
                set.remove(request_id);
            }
        }
    }
    
    /// Get in-flight requests for a boundary
    pub fn requests_for_boundary(&self, boundary_id: &BoundaryId) -> Vec<&TrackedRequest> {
        self.boundary_requests
            .get(boundary_id)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| self.requests.get(id))
                    .collect()
            })
            .unwrap_or_default()
    }
    
    /// Check if boundary can reload given current requests
    pub fn can_reload(&self, boundary_id: &BoundaryId, class: ReloadClass) -> ReloadReadiness {
        let requests = self.requests_for_boundary(boundary_id);
        let active_count = requests.iter().filter(|r| r.state == RequestState::Active).count();
        
        let policy = InFlightPolicy::for_reload_class(class);
        
        match policy {
            InFlightPolicy::DrainFirst if active_count > 0 => {
                ReloadReadiness::MustWait {
                    reason: format!("{} requests must drain", active_count),
                    estimated_wait: self.estimate_drain_time(&requests),
                }
            }
            _ if active_count > 0 => {
                ReloadReadiness::CanProceed {
                    in_flight_count: active_count,
                    policy,
                }
            }
            _ => {
                ReloadReadiness::Ready
            }
        }
    }
    
    fn estimate_drain_time(&self, requests: &[&TrackedRequest]) -> Duration {
        // Estimate based on longest running request
        requests
            .iter()
            .map(|r| r.started_at.elapsed())
            .max()
            .unwrap_or(Duration::ZERO)
    }
    
    /// Apply policy to requests before reload
    pub fn apply_policy(&mut self, boundary_id: &BoundaryId, policy: InFlightPolicy) {
        let request_ids: Vec<String> = self.boundary_requests
            .get(boundary_id)
            .map(|ids| ids.iter().cloned().collect())
            .unwrap_or_default();
        
        for request_id in request_ids {
            if let Some(req) = self.requests.get_mut(&request_id) {
                req.state = match policy {
                    InFlightPolicy::CompleteWithOld => RequestState::Completing,
                    InFlightPolicy::PauseAndResume => RequestState::Paused,
                    InFlightPolicy::FailRetryable => RequestState::Failed,
                    InFlightPolicy::QueueForReplay => RequestState::Queued,
                    InFlightPolicy::DrainFirst => RequestState::Active, // Wait
                };
            }
        }
    }
}

#[derive(Debug, Clone)]
pub enum ReloadReadiness {
    Ready,
    CanProceed {
        in_flight_count: usize,
        policy: InFlightPolicy,
    },
    MustWait {
        reason: String,
        estimated_wait: Duration,
    },
}

// ============================================================
// CANARY RELOAD MODE
// ============================================================
// Test new code in shadow mode before promoting
// STRICT OUTPUT COMPARISON: Well-defined matching rules

/// Canary reload configuration
#[derive(Debug, Clone)]
pub struct CanaryConfig {
    /// Percentage of requests to route to canary (0-100)
    pub traffic_percentage: u8,
    /// Minimum requests before promotion decision
    pub min_requests: u32,
    /// Maximum error rate to allow promotion (0.0-1.0)
    pub max_error_rate: f64,
    /// Maximum latency increase factor (e.g., 1.5 = 50% slower OK)
    pub max_latency_factor: f64,
    /// Duration before auto-promote if healthy
    pub promotion_delay: Duration,
    /// Output comparison configuration (STRICT DEFINITION)
    pub output_comparison: OutputComparisonConfig,
}

/// STRICT OUTPUT COMPARISON CONFIGURATION
/// Defines exactly what "match" means for canary validation
#[derive(Debug, Clone)]
pub struct OutputComparisonConfig {
    /// Whether to compare outputs at all
    pub enabled: bool,
    /// Comparison mode - determines matching strictness
    pub mode: OutputComparisonMode,
    /// Fields to ignore in comparison (for timestamps, IDs, etc.)
    pub ignore_fields: Vec<String>,
    /// Maximum allowed difference for numeric fields (0.0 = exact)
    pub numeric_tolerance: f64,
    /// Whether order matters in arrays
    pub array_order_sensitive: bool,
    /// Maximum mismatch rate before rollback (0.0-1.0)
    pub max_mismatch_rate: f64,
    /// Sample rate for comparison (1.0 = all, 0.1 = 10%)
    pub sample_rate: f64,
}

/// Output comparison modes - STRICTLY DEFINED
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputComparisonMode {
    /// Byte-for-byte identical (strictest)
    Exact,
    /// JSON structural equality (ignores whitespace, key order)
    JsonStructural,
    /// JSON semantic equality (handles type coercion: "1" == 1)
    JsonSemantic,
    /// Hash comparison only (fast, catches major changes)
    HashOnly,
    /// Schema validation only (shape matches, values can differ)
    SchemaOnly,
    /// Custom comparator function
    Custom,
}

impl Default for OutputComparisonConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: OutputComparisonMode::JsonStructural,
            ignore_fields: vec![
                "timestamp".to_string(),
                "requestId".to_string(),
                "traceId".to_string(),
                "_meta".to_string(),
            ],
            numeric_tolerance: 0.0001, // For floating point
            array_order_sensitive: false,
            max_mismatch_rate: 0.01, // 1% mismatch triggers rollback
            sample_rate: 1.0, // Compare all by default
        }
    }
}

impl Default for CanaryConfig {
    fn default() -> Self {
        Self {
            traffic_percentage: 0,  // Shadow only by default
            min_requests: 100,
            max_error_rate: 0.01,
            max_latency_factor: 1.5,
            promotion_delay: Duration::from_secs(300),
            output_comparison: OutputComparisonConfig::default(),
        }
    }
}

/// Result of comparing old vs new output
#[derive(Debug, Clone)]
pub struct OutputComparisonResult {
    pub matches: bool,
    pub mode_used: OutputComparisonMode,
    pub differences: Vec<OutputDifference>,
    pub comparison_time_us: u64,
}

/// Specific difference found in output comparison
#[derive(Debug, Clone)]
pub struct OutputDifference {
    pub path: String,           // JSON path to difference: "response.items[2].value"
    pub diff_type: DiffType,
    pub old_value: String,      // Truncated to 100 chars
    pub new_value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffType {
    ValueMismatch,
    TypeMismatch,
    MissingField,
    ExtraField,
    ArrayLengthMismatch,
    NumericOutOfTolerance,
}

// ============================================================
// JSON COMPARISON HELPERS
// ============================================================

/// Compare two JSON values recursively with configurable comparison
fn compare_json_values(
    old: &serde_json::Value,
    new: &serde_json::Value,
    path: &str,
    config: &OutputComparisonConfig,
    semantic: bool,
) -> (bool, Vec<OutputDifference>) {
    let mut diffs = Vec::new();
    
    // Check if this field should be ignored
    if config.ignore_fields.iter().any(|f| path.ends_with(f)) {
        return (true, vec![]);
    }
    
    use serde_json::Value;
    
    match (old, new) {
        (Value::Null, Value::Null) => (true, vec![]),
        
        (Value::Bool(a), Value::Bool(b)) => {
            if a == b {
                (true, vec![])
            } else {
                diffs.push(OutputDifference {
                    path: path.to_string(),
                    diff_type: DiffType::ValueMismatch,
                    old_value: a.to_string(),
                    new_value: b.to_string(),
                });
                (false, diffs)
            }
        }
        
        (Value::Number(a), Value::Number(b)) => {
            // Handle numeric comparison with tolerance
            let a_f64 = a.as_f64().unwrap_or(0.0);
            let b_f64 = b.as_f64().unwrap_or(0.0);
            
            let matches = if config.numeric_tolerance > 0.0 {
                (a_f64 - b_f64).abs() <= config.numeric_tolerance
            } else {
                a == b
            };
            
            if matches {
                (true, vec![])
            } else if (a_f64 - b_f64).abs() <= config.numeric_tolerance {
                (true, vec![]) // Within tolerance
            } else {
                diffs.push(OutputDifference {
                    path: path.to_string(),
                    diff_type: DiffType::NumericOutOfTolerance,
                    old_value: truncate_value(&a.to_string(), 100),
                    new_value: truncate_value(&b.to_string(), 100),
                });
                (false, diffs)
            }
        }
        
        (Value::String(a), Value::String(b)) => {
            if a == b {
                (true, vec![])
            } else if semantic {
                // Semantic mode: try to parse as numbers
                if let (Ok(a_num), Ok(b_num)) = (a.parse::<f64>(), b.parse::<f64>()) {
                    if (a_num - b_num).abs() <= config.numeric_tolerance {
                        return (true, vec![]);
                    }
                }
                diffs.push(OutputDifference {
                    path: path.to_string(),
                    diff_type: DiffType::ValueMismatch,
                    old_value: truncate_value(a, 100),
                    new_value: truncate_value(b, 100),
                });
                (false, diffs)
            } else {
                diffs.push(OutputDifference {
                    path: path.to_string(),
                    diff_type: DiffType::ValueMismatch,
                    old_value: truncate_value(a, 100),
                    new_value: truncate_value(b, 100),
                });
                (false, diffs)
            }
        }
        
        // Semantic mode: allow type coercion between numbers and strings
        (Value::Number(a), Value::String(b)) if semantic => {
            if let Ok(b_num) = b.parse::<f64>() {
                let a_f64 = a.as_f64().unwrap_or(0.0);
                if (a_f64 - b_num).abs() <= config.numeric_tolerance {
                    return (true, vec![]);
                }
            }
            diffs.push(OutputDifference {
                path: path.to_string(),
                diff_type: DiffType::TypeMismatch,
                old_value: format!("number: {}", a),
                new_value: format!("string: {}", truncate_value(b, 50)),
            });
            (false, diffs)
        }
        
        (Value::String(a), Value::Number(b)) if semantic => {
            if let Ok(a_num) = a.parse::<f64>() {
                let b_f64 = b.as_f64().unwrap_or(0.0);
                if (a_num - b_f64).abs() <= config.numeric_tolerance {
                    return (true, vec![]);
                }
            }
            diffs.push(OutputDifference {
                path: path.to_string(),
                diff_type: DiffType::TypeMismatch,
                old_value: format!("string: {}", truncate_value(a, 50)),
                new_value: format!("number: {}", b),
            });
            (false, diffs)
        }
        
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() && config.array_order_sensitive {
                diffs.push(OutputDifference {
                    path: path.to_string(),
                    diff_type: DiffType::ArrayLengthMismatch,
                    old_value: format!("length {}", a.len()),
                    new_value: format!("length {}", b.len()),
                });
                return (false, diffs);
            }
            
            let mut all_match = true;
            
            if config.array_order_sensitive {
                for (i, (a_item, b_item)) in a.iter().zip(b.iter()).enumerate() {
                    let item_path = format!("{}[{}]", path, i);
                    let (matches, item_diffs) = compare_json_values(a_item, b_item, &item_path, config, semantic);
                    if !matches {
                        all_match = false;
                        diffs.extend(item_diffs);
                    }
                }
            } else {
                // Order insensitive: check that all items in old exist in new
                for (i, a_item) in a.iter().enumerate() {
                    let found = b.iter().any(|b_item| {
                        let (matches, _) = compare_json_values(a_item, b_item, "", config, semantic);
                        matches
                    });
                    if !found {
                        all_match = false;
                        diffs.push(OutputDifference {
                            path: format!("{}[{}]", path, i),
                            diff_type: DiffType::MissingField,
                            old_value: truncate_value(&a_item.to_string(), 100),
                            new_value: "(not found)".to_string(),
                        });
                    }
                }
                // Check for extra items in new
                for (i, b_item) in b.iter().enumerate() {
                    let found = a.iter().any(|a_item| {
                        let (matches, _) = compare_json_values(a_item, b_item, "", config, semantic);
                        matches
                    });
                    if !found {
                        all_match = false;
                        diffs.push(OutputDifference {
                            path: format!("{}[{}]", path, i),
                            diff_type: DiffType::ExtraField,
                            old_value: "(not found)".to_string(),
                            new_value: truncate_value(&b_item.to_string(), 100),
                        });
                    }
                }
            }
            
            (all_match, diffs)
        }
        
        (Value::Object(a), Value::Object(b)) => {
            let mut all_match = true;
            
            // Check all keys in old
            for (key, a_val) in a {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{}.{}", path, key)
                };
                
                // Skip ignored fields
                if config.ignore_fields.contains(key) {
                    continue;
                }
                
                match b.get(key) {
                    Some(b_val) => {
                        let (matches, child_diffs) = compare_json_values(a_val, b_val, &child_path, config, semantic);
                        if !matches {
                            all_match = false;
                            diffs.extend(child_diffs);
                        }
                    }
                    None => {
                        all_match = false;
                        diffs.push(OutputDifference {
                            path: child_path,
                            diff_type: DiffType::MissingField,
                            old_value: truncate_value(&a_val.to_string(), 100),
                            new_value: "(missing)".to_string(),
                        });
                    }
                }
            }
            
            // Check for extra keys in new
            for (key, b_val) in b {
                if config.ignore_fields.contains(key) {
                    continue;
                }
                
                if !a.contains_key(key) {
                    let child_path = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{}.{}", path, key)
                    };
                    all_match = false;
                    diffs.push(OutputDifference {
                        path: child_path,
                        diff_type: DiffType::ExtraField,
                        old_value: "(missing)".to_string(),
                        new_value: truncate_value(&b_val.to_string(), 100),
                    });
                }
            }
            
            (all_match, diffs)
        }
        
        // Type mismatch
        (a, b) => {
            diffs.push(OutputDifference {
                path: path.to_string(),
                diff_type: DiffType::TypeMismatch,
                old_value: truncate_value(&format!("{:?}", json_type_name(a)), 50),
                new_value: truncate_value(&format!("{:?}", json_type_name(b)), 50),
            });
            (false, diffs)
        }
    }
}

/// Compare JSON schemas (structure only, not values)
fn compare_json_schema(
    old: &serde_json::Value,
    new: &serde_json::Value,
    path: &str,
) -> (bool, Vec<OutputDifference>) {
    use serde_json::Value;
    
    let mut diffs = Vec::new();
    
    match (old, new) {
        // Same type primitives - always match for schema
        (Value::Null, Value::Null) |
        (Value::Bool(_), Value::Bool(_)) |
        (Value::Number(_), Value::Number(_)) |
        (Value::String(_), Value::String(_)) => (true, vec![]),
        
        (Value::Array(a), Value::Array(b)) => {
            // For schema comparison, just check first element types match
            match (a.first(), b.first()) {
                (Some(a_item), Some(b_item)) => {
                    compare_json_schema(a_item, b_item, &format!("{}[0]", path))
                }
                (None, None) => (true, vec![]),
                _ => {
                    diffs.push(OutputDifference {
                        path: path.to_string(),
                        diff_type: DiffType::ArrayLengthMismatch,
                        old_value: if a.is_empty() { "empty" } else { "non-empty" }.to_string(),
                        new_value: if b.is_empty() { "empty" } else { "non-empty" }.to_string(),
                    });
                    (false, diffs)
                }
            }
        }
        
        (Value::Object(a), Value::Object(b)) => {
            let mut all_match = true;
            
            // Check all keys exist and types match
            for (key, a_val) in a {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{}.{}", path, key)
                };
                
                match b.get(key) {
                    Some(b_val) => {
                        let (matches, child_diffs) = compare_json_schema(a_val, b_val, &child_path);
                        if !matches {
                            all_match = false;
                            diffs.extend(child_diffs);
                        }
                    }
                    None => {
                        all_match = false;
                        diffs.push(OutputDifference {
                            path: child_path,
                            diff_type: DiffType::MissingField,
                            old_value: json_type_name(a_val).to_string(),
                            new_value: "(missing)".to_string(),
                        });
                    }
                }
            }
            
            // Check for extra keys in new (optional for schema mode)
            for key in b.keys() {
                if !a.contains_key(key) {
                    let child_path = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{}.{}", path, key)
                    };
                    // Extra fields in schema mode are typically OK, but note them
                    diffs.push(OutputDifference {
                        path: child_path,
                        diff_type: DiffType::ExtraField,
                        old_value: "(missing)".to_string(),
                        new_value: json_type_name(b.get(key).unwrap()).to_string(),
                    });
                }
            }
            
            (all_match, diffs)
        }
        
        // Type mismatch
        (a, b) => {
            diffs.push(OutputDifference {
                path: path.to_string(),
                diff_type: DiffType::TypeMismatch,
                old_value: json_type_name(a).to_string(),
                new_value: json_type_name(b).to_string(),
            });
            (false, diffs)
        }
    }
}

/// Get JSON type name for error messages
fn json_type_name(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// Truncate a string for display
fn truncate_value(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len.saturating_sub(3)])
    }
}

/// Canary state for a boundary
pub struct CanaryState {
    pub boundary_id: BoundaryId,
    pub config: CanaryConfig,
    pub started_at: Instant,
    pub old_version_hash: u64,
    pub new_version_hash: u64,
    
    // Metrics
    pub old_requests: u32,
    pub new_requests: u32,
    pub old_errors: u32,
    pub new_errors: u32,
    pub old_latency_sum_ms: u64,
    pub new_latency_sum_ms: u64,
    
    // OUTPUT COMPARISON TRACKING (strict)
    pub comparisons_performed: u32,
    pub comparisons_matched: u32,
    pub comparisons_mismatched: u32,
    pub comparison_errors: u32,  // Comparison itself failed
    pub recent_mismatches: VecDeque<OutputComparisonResult>, // Last N for debugging
    
    // Decision
    pub decision: Option<CanaryDecision>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanaryDecision {
    Promote,
    Rollback,
    Continue,
}

impl CanaryState {
    pub fn new(boundary_id: BoundaryId, config: CanaryConfig, old_hash: u64, new_hash: u64) -> Self {
        Self {
            boundary_id,
            config,
            started_at: Instant::now(),
            old_version_hash: old_hash,
            new_version_hash: new_hash,
            old_requests: 0,
            new_requests: 0,
            old_errors: 0,
            new_errors: 0,
            old_latency_sum_ms: 0,
            new_latency_sum_ms: 0,
            comparisons_performed: 0,
            comparisons_matched: 0,
            comparisons_mismatched: 0,
            comparison_errors: 0,
            recent_mismatches: VecDeque::with_capacity(10),
            decision: None,
        }
    }
    
    /// Compare outputs using configured comparison mode
    pub fn compare_outputs(&self, old_output: &[u8], new_output: &[u8]) -> OutputComparisonResult {
        let start = Instant::now();
        let config = &self.config.output_comparison;
        
        let (matches, differences) = match config.mode {
            OutputComparisonMode::Exact => {
                let matches = old_output == new_output;
                let diffs = if matches {
                    vec![]
                } else {
                    vec![OutputDifference {
                        path: "<root>".to_string(),
                        diff_type: DiffType::ValueMismatch,
                        old_value: format!("{} bytes", old_output.len()),
                        new_value: format!("{} bytes", new_output.len()),
                    }]
                };
                (matches, diffs)
            }
            OutputComparisonMode::HashOnly => {
                use std::collections::hash_map::DefaultHasher;
                use std::hash::{Hash, Hasher};
                
                let mut h1 = DefaultHasher::new();
                old_output.hash(&mut h1);
                let old_hash = h1.finish();
                
                let mut h2 = DefaultHasher::new();
                new_output.hash(&mut h2);
                let new_hash = h2.finish();
                
                let matches = old_hash == new_hash;
                let diffs = if matches {
                    vec![]
                } else {
                    vec![OutputDifference {
                        path: "<hash>".to_string(),
                        diff_type: DiffType::ValueMismatch,
                        old_value: format!("{:016x}", old_hash),
                        new_value: format!("{:016x}", new_hash),
                    }]
                };
                (matches, diffs)
            }
            OutputComparisonMode::JsonStructural | 
            OutputComparisonMode::JsonSemantic => {
                // Parse JSON and compare structurally
                let old_json: Result<serde_json::Value, _> = serde_json::from_slice(old_output);
                let new_json: Result<serde_json::Value, _> = serde_json::from_slice(new_output);
                
                match (old_json, new_json) {
                    (Ok(old_val), Ok(new_val)) => {
                        let semantic = config.mode == OutputComparisonMode::JsonSemantic;
                        compare_json_values(
                            &old_val, 
                            &new_val, 
                            "", 
                            config,
                            semantic
                        )
                    }
                    (Err(_), Ok(_)) => {
                        (false, vec![OutputDifference {
                            path: "<root>".to_string(),
                            diff_type: DiffType::TypeMismatch,
                            old_value: "invalid JSON".to_string(),
                            new_value: "valid JSON".to_string(),
                        }])
                    }
                    (Ok(_), Err(_)) => {
                        (false, vec![OutputDifference {
                            path: "<root>".to_string(),
                            diff_type: DiffType::TypeMismatch,
                            old_value: "valid JSON".to_string(),
                            new_value: "invalid JSON".to_string(),
                        }])
                    }
                    (Err(_), Err(_)) => {
                        // Both not JSON, fall back to exact comparison
                        let matches = old_output == new_output;
                        let diffs = if matches { vec![] } else {
                            vec![OutputDifference {
                                path: "<binary>".to_string(),
                                diff_type: DiffType::ValueMismatch,
                                old_value: format!("{} bytes", old_output.len()),
                                new_value: format!("{} bytes", new_output.len()),
                            }]
                        };
                        (matches, diffs)
                    }
                }
            }
            OutputComparisonMode::SchemaOnly => {
                // Validate schema shapes match (types and structure, not values)
                let old_json: Result<serde_json::Value, _> = serde_json::from_slice(old_output);
                let new_json: Result<serde_json::Value, _> = serde_json::from_slice(new_output);
                
                match (old_json, new_json) {
                    (Ok(old_val), Ok(new_val)) => {
                        compare_json_schema(&old_val, &new_val, "")
                    }
                    _ => (false, vec![OutputDifference {
                        path: "<root>".to_string(),
                        diff_type: DiffType::TypeMismatch,
                        old_value: "JSON parse failed".to_string(),
                        new_value: "JSON parse failed".to_string(),
                    }])
                }
            }
            OutputComparisonMode::Custom => {
                // Custom comparator would be registered via callback
                // For now, default to exact comparison
                let matches = old_output == new_output;
                (matches, vec![])
            }
        };
        
        OutputComparisonResult {
            matches,
            mode_used: config.mode,
            differences,
            comparison_time_us: start.elapsed().as_micros() as u64,
        }
    }
    
    /// Record a request result (simple version)
    pub fn record_result(&mut self, is_new: bool, error: bool, latency_ms: u64) {
        if is_new {
            self.new_requests += 1;
            if error { self.new_errors += 1; }
            self.new_latency_sum_ms += latency_ms;
        } else {
            self.old_requests += 1;
            if error { self.old_errors += 1; }
            self.old_latency_sum_ms += latency_ms;
        }
    }
    
    /// Record a comparison result (strict version)
    pub fn record_comparison(&mut self, result: OutputComparisonResult) {
        self.comparisons_performed += 1;
        
        if result.matches {
            self.comparisons_matched += 1;
        } else {
            self.comparisons_mismatched += 1;
            
            // Keep recent mismatches for debugging
            if self.recent_mismatches.len() >= 10 {
                self.recent_mismatches.pop_front();
            }
            self.recent_mismatches.push_back(result);
        }
    }
    
    /// Record comparison error (comparison itself failed)
    pub fn record_comparison_error(&mut self) {
        self.comparison_errors += 1;
    }
    
    /// Get current mismatch rate
    pub fn mismatch_rate(&self) -> f64 {
        if self.comparisons_performed == 0 {
            return 0.0;
        }
        self.comparisons_mismatched as f64 / self.comparisons_performed as f64
    }
    
    /// Evaluate canary health and make decision
    pub fn evaluate(&mut self) -> CanaryDecision {
        // Not enough data yet
        if self.new_requests < self.config.min_requests {
            return CanaryDecision::Continue;
        }
        
        // Calculate metrics
        let new_error_rate = self.new_errors as f64 / self.new_requests as f64;
        
        let new_avg_latency = self.new_latency_sum_ms as f64 / self.new_requests as f64;
        let old_avg_latency = if self.old_requests > 0 {
            self.old_latency_sum_ms as f64 / self.old_requests as f64
        } else {
            new_avg_latency
        };
        
        // Check error rate
        if new_error_rate > self.config.max_error_rate {
            self.decision = Some(CanaryDecision::Rollback);
            return CanaryDecision::Rollback;
        }
        
        // Check latency
        if old_avg_latency > 0.0 && new_avg_latency / old_avg_latency > self.config.max_latency_factor {
            self.decision = Some(CanaryDecision::Rollback);
            return CanaryDecision::Rollback;
        }
        
        // Check output mismatches using STRICT comparison config
        if self.config.output_comparison.enabled {
            let mismatch_rate = self.mismatch_rate();
            let max_rate = self.config.output_comparison.max_mismatch_rate;
            
            if mismatch_rate > max_rate {
                self.decision = Some(CanaryDecision::Rollback);
                return CanaryDecision::Rollback;
            }
        }
        
        // Check promotion delay
        if self.started_at.elapsed() >= self.config.promotion_delay {
            self.decision = Some(CanaryDecision::Promote);
            return CanaryDecision::Promote;
        }
        
        CanaryDecision::Continue
    }
    
    /// Get detailed evaluation report for debugging
    pub fn evaluation_report(&self) -> CanaryEvaluationReport {
        let new_error_rate = if self.new_requests > 0 {
            self.new_errors as f64 / self.new_requests as f64
        } else {
            0.0
        };
        
        let new_avg_latency = if self.new_requests > 0 {
            self.new_latency_sum_ms as f64 / self.new_requests as f64
        } else {
            0.0
        };
        
        let old_avg_latency = if self.old_requests > 0 {
            self.old_latency_sum_ms as f64 / self.old_requests as f64
        } else {
            0.0
        };
        
        CanaryEvaluationReport {
            new_requests: self.new_requests,
            old_requests: self.old_requests,
            new_error_rate,
            old_error_rate: if self.old_requests > 0 {
                self.old_errors as f64 / self.old_requests as f64
            } else {
                0.0
            },
            new_avg_latency_ms: new_avg_latency,
            old_avg_latency_ms: old_avg_latency,
            latency_factor: if old_avg_latency > 0.0 {
                new_avg_latency / old_avg_latency
            } else {
                1.0
            },
            comparisons_performed: self.comparisons_performed,
            mismatch_rate: self.mismatch_rate(),
            comparison_errors: self.comparison_errors,
            elapsed: self.started_at.elapsed(),
            promotion_delay: self.config.promotion_delay,
            decision: self.decision,
        }
    }
}

/// Detailed canary evaluation report for debugging
#[derive(Debug, Clone)]
pub struct CanaryEvaluationReport {
    pub new_requests: u32,
    pub old_requests: u32,
    pub new_error_rate: f64,
    pub old_error_rate: f64,
    pub new_avg_latency_ms: f64,
    pub old_avg_latency_ms: f64,
    pub latency_factor: f64,
    pub comparisons_performed: u32,
    pub mismatch_rate: f64,
    pub comparison_errors: u32,
    pub elapsed: Duration,
    pub promotion_delay: Duration,
    pub decision: Option<CanaryDecision>,
}

/// Manages all active canary deployments
pub struct CanaryManager {
    canaries: HashMap<BoundaryId, CanaryState>,
}

impl CanaryManager {
    pub fn new() -> Self {
        Self {
            canaries: HashMap::new(),
        }
    }
    
    /// Start a canary deployment
    pub fn start_canary(
        &mut self,
        boundary_id: BoundaryId,
        config: CanaryConfig,
        old_hash: u64,
        new_hash: u64,
    ) {
        self.canaries.insert(
            boundary_id.clone(),
            CanaryState::new(boundary_id, config, old_hash, new_hash),
        );
    }
    
    /// Get canary state for routing decision
    pub fn get_canary(&self, boundary_id: &BoundaryId) -> Option<&CanaryState> {
        self.canaries.get(boundary_id)
    }
    
    /// Get mutable canary for recording results
    pub fn get_canary_mut(&mut self, boundary_id: &BoundaryId) -> Option<&mut CanaryState> {
        self.canaries.get_mut(boundary_id)
    }
    
    /// End a canary deployment
    pub fn end_canary(&mut self, boundary_id: &BoundaryId) -> Option<CanaryState> {
        self.canaries.remove(boundary_id)
    }
    
    /// Evaluate all canaries and return decisions
    pub fn evaluate_all(&mut self) -> Vec<(BoundaryId, CanaryDecision)> {
        self.canaries
            .iter_mut()
            .map(|(id, state)| (id.clone(), state.evaluate()))
            .collect()
    }
}

impl Default for CanaryManager {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================
// CASCADE RELOAD HARDENING
// ============================================================
// Prevent cascade bugs with circuit breakers and validation

/// Circuit breaker for cascade reloads
pub struct CascadeCircuitBreaker {
    /// Maximum cascade depth allowed
    max_depth: usize,
    /// Maximum boundaries in single cascade
    max_boundaries: usize,
    /// Cooldown between cascades
    cascade_cooldown: Duration,
    /// Recent cascades for rate limiting
    recent_cascades: VecDeque<CascadeEvent>,
    /// Current cascade depth
    current_depth: usize,
    /// Circuit breaker state
    state: CircuitState,
    /// Consecutive failures
    failure_count: u32,
    /// Failure threshold to trip
    failure_threshold: u32,
}

#[derive(Debug, Clone)]
pub struct CascadeEvent {
    pub started_at: Instant,
    pub depth: usize,
    pub boundaries: usize,
    pub success: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitState {
    Closed,      // Normal operation
    Open,        // Rejecting cascades
    HalfOpen,    // Testing recovery
}

impl CascadeCircuitBreaker {
    pub fn new(max_depth: usize, max_boundaries: usize) -> Self {
        Self {
            max_depth,
            max_boundaries,
            cascade_cooldown: Duration::from_secs(5),
            recent_cascades: VecDeque::new(),
            current_depth: 0,
            state: CircuitState::Closed,
            failure_count: 0,
            failure_threshold: 3,
        }
    }
    
    /// Check if cascade is allowed
    pub fn allow_cascade(&self, depth: usize, boundary_count: usize) -> CascadePermission {
        // Check circuit breaker state
        if self.state == CircuitState::Open {
            return CascadePermission::Denied {
                reason: "Circuit breaker is open".to_string(),
            };
        }
        
        // Check depth
        if depth > self.max_depth {
            return CascadePermission::Denied {
                reason: format!("Cascade depth {} exceeds max {}", depth, self.max_depth),
            };
        }
        
        // Check boundary count
        if boundary_count > self.max_boundaries {
            return CascadePermission::Denied {
                reason: format!("Boundary count {} exceeds max {}", boundary_count, self.max_boundaries),
            };
        }
        
        // Check cooldown
        if let Some(last) = self.recent_cascades.back() {
            if last.started_at.elapsed() < self.cascade_cooldown {
                return CascadePermission::Delayed {
                    wait: self.cascade_cooldown - last.started_at.elapsed(),
                };
            }
        }
        
        CascadePermission::Allowed
    }
    
    /// Start tracking a cascade
    pub fn start_cascade(&mut self) {
        self.current_depth += 1;
    }
    
    /// End cascade tracking
    pub fn end_cascade(&mut self, success: bool, boundaries: usize) {
        self.current_depth = self.current_depth.saturating_sub(1);
        
        self.recent_cascades.push_back(CascadeEvent {
            started_at: Instant::now(),
            depth: self.current_depth + 1,
            boundaries,
            success,
        });
        
        // Trim old events
        while self.recent_cascades.len() > 100 {
            self.recent_cascades.pop_front();
        }
        
        // Update circuit breaker
        if success {
            self.failure_count = 0;
            if self.state == CircuitState::HalfOpen {
                self.state = CircuitState::Closed;
            }
        } else {
            self.failure_count += 1;
            if self.failure_count >= self.failure_threshold {
                self.state = CircuitState::Open;
            }
        }
    }
    
    /// Reset circuit breaker (for testing recovery)
    pub fn reset(&mut self) {
        self.state = CircuitState::HalfOpen;
        self.failure_count = 0;
    }
}

#[derive(Debug, Clone)]
pub enum CascadePermission {
    Allowed,
    Delayed { wait: Duration },
    Denied { reason: String },
}

// ============================================================
// RELOAD MANAGER - ORCHESTRATES EVERYTHING
// ============================================================

/// Configuration for reload manager
#[derive(Debug, Clone)]
pub struct ReloadManagerConfig {
    /// Enable dev mode (less strict verification)
    pub dev_mode: bool,
    /// Maximum auto-repair depth (higher for multi-file)
    pub max_repair_depth: usize,
    /// Skip semantic tests for speed
    pub skip_semantic_tests: bool,
    /// Enable canary mode by default
    pub enable_canary: bool,
    /// Request drain timeout
    pub drain_timeout: Duration,
    /// Task shutdown timeout
    pub task_shutdown_timeout: Duration,
}

impl Default for ReloadManagerConfig {
    fn default() -> Self {
        Self {
            dev_mode: false,
            max_repair_depth: 1,
            skip_semantic_tests: false,
            enable_canary: false,
            drain_timeout: Duration::from_secs(30),
            task_shutdown_timeout: Duration::from_secs(10),
        }
    }
}

impl ReloadManagerConfig {
    /// Development configuration (faster, less strict)
    pub fn development() -> Self {
        Self {
            dev_mode: true,
            max_repair_depth: 3,  // Allow multi-file repairs
            skip_semantic_tests: true,  // Skip for speed
            enable_canary: false,
            drain_timeout: Duration::from_secs(5),
            task_shutdown_timeout: Duration::from_secs(5),
        }
    }
    
    /// Production configuration (strict, safe)
    pub fn production() -> Self {
        Self {
            dev_mode: false,
            max_repair_depth: 1,
            skip_semantic_tests: false,
            enable_canary: true,  // Use canary in prod
            drain_timeout: Duration::from_secs(30),
            task_shutdown_timeout: Duration::from_secs(30),
        }
    }
}

/// The main reload manager that orchestrates HMR
pub struct ReloadManager {
    pub config: ReloadManagerConfig,
    pub classifier: ReloadClassifier,
    pub snapshots: SnapshotManager,
    pub task_registry: AsyncTaskRegistry,
    pub request_tracker: RequestTracker,
    pub canary_manager: CanaryManager,
    pub cascade_breaker: CascadeCircuitBreaker,
    
    /// Debug trace collector for HMR failure analysis
    pub debug_collector: HmrDebugCollector,
    
    // Statistics
    pub stats: ReloadStats,
}

#[derive(Debug, Clone, Default)]
pub struct ReloadStats {
    pub total_reloads: u64,
    pub safe_reloads: u64,
    pub warm_reloads: u64,
    pub cold_reloads: u64,
    pub canary_reloads: u64,
    pub failed_reloads: u64,
    pub reverted_reloads: u64,
    pub avg_reload_ms: f64,
    pub max_reload_ms: u64,
    pub cascade_count: u64,
    pub circuit_trips: u64,
}

impl ReloadManager {
    pub fn new(config: ReloadManagerConfig) -> Self {
        // Create debug collector - only keep failures in prod, all in dev
        let mut debug_collector = HmrDebugCollector::new(100);
        if !config.dev_mode {
            debug_collector.set_failures_only_filter(500); // Keep slow (>500ms) or failed
        }
        
        Self {
            snapshots: SnapshotManager::new(10),
            task_registry: AsyncTaskRegistry::new(config.task_shutdown_timeout),
            request_tracker: RequestTracker::new(
                InFlightPolicy::PauseAndResume,
                config.drain_timeout,
            ),
            canary_manager: CanaryManager::new(),
            cascade_breaker: CascadeCircuitBreaker::new(5, 20),
            classifier: ReloadClassifier::new(),
            debug_collector,
            config,
            stats: ReloadStats::default(),
        }
    }
    
    /// Execute a reload with full orchestration and debug tracing
    pub fn execute_reload(
        &mut self,
        boundary_id: &BoundaryId,
        changes: &ReloadChanges,
        state_manager: &StateManager,
    ) -> Result<ReloadResult, ReloadError> {
        let start = Instant::now();
        
        // Start debug trace
        let mut trace = self.debug_collector.start_trace(boundary_id.clone());
        
        // 1. Classify the reload
        trace.phase_start(HmrPhase::Classification);
        let (auto_class, confidence) = self.classifier.classify_with_confidence(changes);
        let mut reload_class = self.classifier.classify_with_context(
            changes,
            Some(boundary_id),
            changes.file_path.as_deref(),
        );
        trace.decision(HmrPhase::Classification, "auto_class", &format!("{:?}", auto_class));
        trace.decision(HmrPhase::Classification, "confidence", &format!("{:?}", confidence));
        
        // Record if override was applied
        if reload_class != auto_class {
            trace.override_applied(
                HmrPhase::Classification,
                &format!("{:?}", auto_class),
                &format!("{:?}", reload_class),
            );
        }
        trace.phase_end(HmrPhase::Classification, start.elapsed());
        
        // 2. Check if canary mode should be used
        if self.config.enable_canary && reload_class == ReloadClass::Warm {
            reload_class = ReloadClass::Canary;
            trace.decision(HmrPhase::Classification, "canary_enabled", "true");
        }
        
        // 3. Check request readiness
        trace.phase_start(HmrPhase::RequestDrain);
        let readiness = self.request_tracker.can_reload(boundary_id, reload_class);
        match readiness {
            ReloadReadiness::MustWait { ref reason, ref estimated_wait } => {
                trace.warning(HmrPhase::RequestDrain, &format!("Must wait: {}", reason));
                trace.set_outcome(HmrOutcome::Blocked { reason: reason.clone() });
                self.debug_collector.complete_trace(trace);
                
                return Err(ReloadError::NotReady {
                    reason: reason.clone(),
                    estimated_wait: *estimated_wait,
                });
            }
            ReloadReadiness::CanProceed { policy, in_flight_count } => {
                trace.decision(HmrPhase::RequestDrain, "policy", &format!("{:?}", policy));
                trace.decision(HmrPhase::RequestDrain, "in_flight", &format!("{}", in_flight_count));
                self.request_tracker.apply_policy(boundary_id, policy);
            }
            ReloadReadiness::Ready => {
                trace.decision(HmrPhase::RequestDrain, "status", "ready");
            }
        }
        trace.phase_end(HmrPhase::RequestDrain, start.elapsed());
        
        // 4. Check cascade permission
        trace.phase_start(HmrPhase::Validation);
        if let CascadePermission::Denied { reason } = 
            self.cascade_breaker.allow_cascade(0, 1) {
            trace.error(HmrPhase::Validation, &format!("Cascade blocked: {}", reason), false);
            trace.set_outcome(HmrOutcome::Blocked { reason: reason.clone() });
            self.debug_collector.complete_trace(trace);
            
            return Err(ReloadError::CascadeBlocked { reason });
        }
        
        // 5. Prepare async tasks
        trace.phase_start(HmrPhase::TaskPrep);
        let task_prep = self.task_registry.prepare_for_reload(boundary_id, reload_class);
        trace.decision(HmrPhase::TaskPrep, "to_checkpoint", &format!("{}", task_prep.to_checkpoint.len()));
        trace.decision(HmrPhase::TaskPrep, "to_pause", &format!("{}", task_prep.to_pause.len()));
        trace.decision(HmrPhase::TaskPrep, "to_terminate", &format!("{}", task_prep.to_terminate.len()));
        
        // Check for task violations
        if self.task_registry.should_block_reload() {
            let violations = self.task_registry.get_violations();
            for v in violations {
                trace.warning(HmrPhase::TaskPrep, &format!("{:?}: {}", v.violation_type, v.details));
            }
        }
        
        if !task_prep.can_proceed {
            trace.error(HmrPhase::TaskPrep, "Tasks blocking reload", false);
            trace.set_outcome(HmrOutcome::Blocked { 
                reason: format!("Blocking tasks: {:?}", task_prep.blocking_tasks) 
            });
            self.debug_collector.complete_trace(trace);
            
            return Err(ReloadError::TasksBlocking {
                task_ids: task_prep.blocking_tasks,
            });
        }
        trace.phase_end(HmrPhase::TaskPrep, start.elapsed());
        
        // 6. Create snapshot if required
        trace.phase_start(HmrPhase::Snapshot);
        let snapshot_id = if reload_class.requires_snapshot() {
            let id = self.snapshots.create_snapshot(
                reload_class,
                state_manager,
                &[boundary_id.clone()],
            );
            trace.decision(HmrPhase::Snapshot, "snapshot_id", &format!("{}", id));
            Some(id)
        } else {
            trace.decision(HmrPhase::Snapshot, "snapshot", "skipped");
            None
        };
        trace.phase_end(HmrPhase::Snapshot, start.elapsed());
        
        // 7. Signal task shutdown/pause
        self.task_registry.signal_shutdown(&task_prep.to_terminate);
        
        // 8. Execute the reload
        trace.phase_start(HmrPhase::Reload);
        self.cascade_breaker.start_cascade();
        let reload_success = true; // Actual reload would happen here
        self.cascade_breaker.end_cascade(reload_success, 1);
        trace.phase_end(HmrPhase::Reload, start.elapsed());
        
        // 9. Update statistics
        let duration = start.elapsed();
        self.update_stats(reload_class, duration, reload_success);
        
        // 10. Check latency target
        if duration.as_millis() as u64 > reload_class.max_latency_ms() {
            trace.warning(
                HmrPhase::Reload,
                &format!(
                    "{:?} reload took {}ms, target was {}ms",
                    reload_class,
                    duration.as_millis(),
                    reload_class.max_latency_ms()
                ),
            );
        }
        
        // Record successful outcome
        trace.set_outcome(HmrOutcome::Success { reload_class, duration });
        self.debug_collector.complete_trace(trace);
        
        Ok(ReloadResult {
            reload_class,
            snapshot_id,
            duration,
            boundaries_reloaded: vec![boundary_id.clone()],
            tasks_affected: task_prep.to_terminate.len() + task_prep.to_pause.len(),
        })
    }
    
    /// Revert a failed reload
    pub fn revert_reload(&mut self, snapshot_id: u64) -> Result<(), ReloadError> {
        let _snapshot = self.snapshots.revert_to_snapshot(snapshot_id)
            .map_err(|e| ReloadError::RevertFailed { reason: e })?;
        
        // Would restore state from snapshot here
        self.stats.reverted_reloads += 1;
        
        Ok(())
    }
    
    fn update_stats(&mut self, class: ReloadClass, duration: Duration, success: bool) {
        self.stats.total_reloads += 1;
        
        match class {
            ReloadClass::Safe => self.stats.safe_reloads += 1,
            ReloadClass::Warm => self.stats.warm_reloads += 1,
            ReloadClass::Cold => self.stats.cold_reloads += 1,
            ReloadClass::Canary => self.stats.canary_reloads += 1,
        }
        
        if !success {
            self.stats.failed_reloads += 1;
        }
        
        let ms = duration.as_millis() as u64;
        if ms > self.stats.max_reload_ms {
            self.stats.max_reload_ms = ms;
        }
        
        // Rolling average
        let n = self.stats.total_reloads as f64;
        self.stats.avg_reload_ms = 
            (self.stats.avg_reload_ms * (n - 1.0) + ms as f64) / n;
    }
    
    // =====================================================
    // DEBUGGING & OBSERVABILITY METHODS
    // =====================================================
    
    /// Get recent HMR traces for debugging
    pub fn recent_traces(&self, count: usize) -> Vec<&HmrDebugTrace> {
        self.debug_collector.recent_traces(count)
    }
    
    /// Get failed HMR traces
    pub fn failed_traces(&self) -> Vec<&HmrDebugTrace> {
        self.debug_collector.failed_traces()
    }
    
    /// Get traces for a specific boundary
    pub fn traces_for_boundary(&self, boundary_id: &BoundaryId) -> Vec<&HmrDebugTrace> {
        self.debug_collector.traces_for_boundary(boundary_id)
    }
    
    /// Print summary of recent failures (for CLI debugging)
    pub fn print_failure_summary(&self) {
        let failed = self.failed_traces();
        if failed.is_empty() {
            println!("No HMR failures recorded.");
            return;
        }
        
        println!("=== HMR Failure Summary ({} failures) ===\n", failed.len());
        for trace in failed.iter().take(5) {
            println!("{}\n", trace.summary());
            println!("---");
        }
    }
    
    /// Export debug data as JSON for external tools
    pub fn export_debug_json(&self) -> String {
        self.debug_collector.export_json()
    }
    
    /// Set manual override for a boundary's reload class
    pub fn set_reload_override(&mut self, boundary_id: BoundaryId, class: ReloadClass) {
        self.classifier.set_boundary_override(boundary_id, class);
    }
    
    /// Clear manual override for a boundary
    pub fn clear_reload_override(&mut self, boundary_id: &BoundaryId) {
        self.classifier.clear_boundary_override(boundary_id);
    }
    
    /// Set path pattern override
    pub fn set_path_override(&mut self, pattern: String, class: ReloadClass) {
        self.classifier.set_path_override(pattern, class);
    }
    
    /// Get current task violations
    pub fn task_violations(&self) -> &[TaskViolation] {
        self.task_registry.get_violations()
    }
    
    /// Clear task violations
    pub fn clear_task_violations(&mut self) {
        self.task_registry.clear_violations();
    }
}

#[derive(Debug, Clone)]
pub struct ReloadResult {
    pub reload_class: ReloadClass,
    pub snapshot_id: Option<u64>,
    pub duration: Duration,
    pub boundaries_reloaded: Vec<BoundaryId>,
    pub tasks_affected: usize,
}

#[derive(Debug, Clone)]
pub enum ReloadError {
    NotReady {
        reason: String,
        estimated_wait: Duration,
    },
    CascadeBlocked {
        reason: String,
    },
    TasksBlocking {
        task_ids: Vec<String>,
    },
    RevertFailed {
        reason: String,
    },
    VerificationFailed {
        violations: Vec<String>,
    },
    Timeout {
        phase: String,
        duration: Duration,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_reload_class_latency() {
        assert_eq!(ReloadClass::Safe.max_latency_ms(), 10);
        assert_eq!(ReloadClass::Warm.max_latency_ms(), 100);
        assert_eq!(ReloadClass::Cold.max_latency_ms(), 1000);
    }
    
    #[test]
    fn test_classifier_safe() {
        let classifier = ReloadClassifier::new();
        let changes = ReloadChanges {
            is_stateless_change: true,
            ..Default::default()
        };
        assert_eq!(classifier.classify(&changes), ReloadClass::Safe);
    }
    
    #[test]
    fn test_classifier_cold() {
        let classifier = ReloadClassifier::new();
        let changes = ReloadChanges {
            has_breaking_api_change: true,
            ..Default::default()
        };
        assert_eq!(classifier.classify(&changes), ReloadClass::Cold);
    }
    
    #[test]
    fn test_cascade_breaker() {
        let mut breaker = CascadeCircuitBreaker::new(3, 10);
        
        assert!(matches!(breaker.allow_cascade(2, 5), CascadePermission::Allowed));
        assert!(matches!(
            breaker.allow_cascade(5, 5),
            CascadePermission::Denied { .. }
        ));
    }
    
    #[test]
    fn test_canary_evaluation() {
        let mut state = CanaryState::new(
            "test".to_string(),
            CanaryConfig {
                min_requests: 10,
                max_error_rate: 0.1,
                ..Default::default()
            },
            100,
            200,
        );
        
        // Not enough requests
        assert_eq!(state.evaluate(), CanaryDecision::Continue);
        
        // Add successful requests
        for _ in 0..15 {
            state.record_result(true, false, 50);
        }
        
        // Should still be continue (waiting for promotion delay)
        assert_eq!(state.evaluate(), CanaryDecision::Continue);
    }
}

// ============================================================
// HMR DEBUGGING & OBSERVABILITY
// ============================================================
// Because too many safeguards means debugging is nontrivial

/// Complete HMR event trace for debugging failures
#[derive(Debug, Clone)]
pub struct HmrDebugTrace {
    pub trace_id: u64,
    pub started_at: Instant,
    pub boundary_id: BoundaryId,
    pub events: Vec<HmrDebugEvent>,
    pub outcome: Option<HmrOutcome>,
}

#[derive(Debug, Clone)]
pub struct HmrDebugEvent {
    pub timestamp: Instant,
    pub phase: HmrPhase,
    pub event_type: HmrEventType,
    pub details: String,
    pub duration_us: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HmrPhase {
    Classification,
    Validation,
    Snapshot,
    TaskPrep,
    RequestDrain,
    Reload,
    StateRestore,
    Verification,
    Rollback,
}

#[derive(Debug, Clone)]
pub enum HmrEventType {
    PhaseStart,
    PhaseEnd,
    Decision { key: String, value: String },
    Warning { message: String },
    Error { message: String, recoverable: bool },
    Blocked { reason: String },
    Override { from: String, to: String },
    Metric { name: String, value: f64 },
}

#[derive(Debug, Clone)]
pub enum HmrOutcome {
    Success { reload_class: ReloadClass, duration: Duration },
    RolledBack { reason: String, snapshot_id: u64 },
    Failed { phase: HmrPhase, error: String },
    Blocked { reason: String },
}

impl HmrDebugTrace {
    pub fn new(trace_id: u64, boundary_id: BoundaryId) -> Self {
        Self {
            trace_id,
            started_at: Instant::now(),
            boundary_id,
            events: Vec::new(),
            outcome: None,
        }
    }
    
    /// Record phase start
    pub fn phase_start(&mut self, phase: HmrPhase) {
        self.events.push(HmrDebugEvent {
            timestamp: Instant::now(),
            phase,
            event_type: HmrEventType::PhaseStart,
            details: format!("{:?} started", phase),
            duration_us: None,
        });
    }
    
    /// Record phase end with duration
    pub fn phase_end(&mut self, phase: HmrPhase, duration: Duration) {
        self.events.push(HmrDebugEvent {
            timestamp: Instant::now(),
            phase,
            event_type: HmrEventType::PhaseEnd,
            details: format!("{:?} completed", phase),
            duration_us: Some(duration.as_micros() as u64),
        });
    }
    
    /// Record a decision point
    pub fn decision(&mut self, phase: HmrPhase, key: &str, value: &str) {
        self.events.push(HmrDebugEvent {
            timestamp: Instant::now(),
            phase,
            event_type: HmrEventType::Decision {
                key: key.to_string(),
                value: value.to_string(),
            },
            details: format!("{} = {}", key, value),
            duration_us: None,
        });
    }
    
    /// Record a warning
    pub fn warning(&mut self, phase: HmrPhase, message: &str) {
        self.events.push(HmrDebugEvent {
            timestamp: Instant::now(),
            phase,
            event_type: HmrEventType::Warning {
                message: message.to_string(),
            },
            details: message.to_string(),
            duration_us: None,
        });
    }
    
    /// Record an error
    pub fn error(&mut self, phase: HmrPhase, message: &str, recoverable: bool) {
        self.events.push(HmrDebugEvent {
            timestamp: Instant::now(),
            phase,
            event_type: HmrEventType::Error {
                message: message.to_string(),
                recoverable,
            },
            details: format!("{} (recoverable: {})", message, recoverable),
            duration_us: None,
        });
    }
    
    /// Record an override being applied
    pub fn override_applied(&mut self, phase: HmrPhase, from: &str, to: &str) {
        self.events.push(HmrDebugEvent {
            timestamp: Instant::now(),
            phase,
            event_type: HmrEventType::Override {
                from: from.to_string(),
                to: to.to_string(),
            },
            details: format!("Override: {} -> {}", from, to),
            duration_us: None,
        });
    }
    
    /// Record final outcome
    pub fn set_outcome(&mut self, outcome: HmrOutcome) {
        self.outcome = Some(outcome);
    }
    
    /// Get total duration
    pub fn total_duration(&self) -> Duration {
        self.started_at.elapsed()
    }
    
    /// Format as human-readable summary
    pub fn summary(&self) -> String {
        let mut lines = Vec::new();
        lines.push(format!(
            "HMR Trace #{} for boundary '{}'",
            self.trace_id, self.boundary_id
        ));
        lines.push(format!("Total duration: {:?}", self.total_duration()));
        
        // Phase timings
        lines.push("\nPhase timings:".to_string());
        for event in &self.events {
            if let HmrEventType::PhaseEnd = &event.event_type {
                if let Some(us) = event.duration_us {
                    lines.push(format!("  {:?}: {}μs", event.phase, us));
                }
            }
        }
        
        // Decisions made
        lines.push("\nKey decisions:".to_string());
        for event in &self.events {
            if let HmrEventType::Decision { key, value } = &event.event_type {
                lines.push(format!("  {} = {}", key, value));
            }
        }
        
        // Warnings and errors
        let warnings: Vec<_> = self.events.iter()
            .filter(|e| matches!(&e.event_type, HmrEventType::Warning { .. }))
            .collect();
        if !warnings.is_empty() {
            lines.push(format!("\nWarnings ({})::", warnings.len()));
            for w in warnings {
                lines.push(format!("  - {}", w.details));
            }
        }
        
        let errors: Vec<_> = self.events.iter()
            .filter(|e| matches!(&e.event_type, HmrEventType::Error { .. }))
            .collect();
        if !errors.is_empty() {
            lines.push(format!("\nErrors ({})::", errors.len()));
            for e in errors {
                lines.push(format!("  - {}", e.details));
            }
        }
        
        // Outcome
        lines.push("\nOutcome:".to_string());
        match &self.outcome {
            Some(HmrOutcome::Success { reload_class, duration }) => {
                lines.push(format!("  SUCCESS: {:?} reload in {:?}", reload_class, duration));
            }
            Some(HmrOutcome::RolledBack { reason, snapshot_id }) => {
                lines.push(format!("  ROLLED BACK: {} (snapshot #{})", reason, snapshot_id));
            }
            Some(HmrOutcome::Failed { phase, error }) => {
                lines.push(format!("  FAILED in {:?}: {}", phase, error));
            }
            Some(HmrOutcome::Blocked { reason }) => {
                lines.push(format!("  BLOCKED: {}", reason));
            }
            None => {
                lines.push("  (no outcome recorded)".to_string());
            }
        }
        
        lines.join("\n")
    }
}

/// Debug trace collector with retention
pub struct HmrDebugCollector {
    traces: VecDeque<HmrDebugTrace>,
    max_traces: usize,
    next_id: AtomicU64,
    /// Filter: only keep traces matching predicate
    filter: Option<Box<dyn Fn(&HmrDebugTrace) -> bool + Send + Sync>>,
}

impl HmrDebugCollector {
    pub fn new(max_traces: usize) -> Self {
        Self {
            traces: VecDeque::new(),
            max_traces,
            next_id: AtomicU64::new(1),
            filter: None,
        }
    }
    
    /// Only keep traces that had errors or took too long
    pub fn set_failures_only_filter(&mut self, max_duration_ms: u64) {
        self.filter = Some(Box::new(move |trace| {
            // Keep if has errors
            if trace.events.iter().any(|e| matches!(&e.event_type, HmrEventType::Error { .. })) {
                return true;
            }
            // Keep if failed or rolled back
            if matches!(&trace.outcome, Some(HmrOutcome::Failed { .. }) | Some(HmrOutcome::RolledBack { .. })) {
                return true;
            }
            // Keep if slow
            trace.total_duration().as_millis() as u64 > max_duration_ms
        }));
    }
    
    /// Start a new trace
    pub fn start_trace(&self, boundary_id: BoundaryId) -> HmrDebugTrace {
        let trace_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        HmrDebugTrace::new(trace_id, boundary_id)
    }
    
    /// Complete and store a trace
    pub fn complete_trace(&mut self, trace: HmrDebugTrace) {
        // Apply filter if set
        if let Some(ref filter) = self.filter {
            if !filter(&trace) {
                return; // Don't store
            }
        }
        
        self.traces.push_back(trace);
        
        // Enforce retention
        while self.traces.len() > self.max_traces {
            self.traces.pop_front();
        }
    }
    
    /// Get recent traces
    pub fn recent_traces(&self, count: usize) -> Vec<&HmrDebugTrace> {
        self.traces.iter().rev().take(count).collect()
    }
    
    /// Get traces for a specific boundary
    pub fn traces_for_boundary(&self, boundary_id: &BoundaryId) -> Vec<&HmrDebugTrace> {
        self.traces.iter()
            .filter(|t| &t.boundary_id == boundary_id)
            .collect()
    }
    
    /// Get failed traces only
    pub fn failed_traces(&self) -> Vec<&HmrDebugTrace> {
        self.traces.iter()
            .filter(|t| matches!(&t.outcome, Some(HmrOutcome::Failed { .. }) | Some(HmrOutcome::RolledBack { .. })))
            .collect()
    }
    
    /// Export all traces as JSON for external analysis
    pub fn export_json(&self) -> String {
        // Would serialize to JSON
        format!("{{\"trace_count\": {}}}", self.traces.len())
    }
}

// ============================================================
// ASYNC TASK DETERMINISTIC REPLAY
// ============================================================
// Warm reload correctness requires deterministic replay of async
// tasks. Without it, warm reload is probabilistic.
// ============================================================

/// Recorded async operation for replay
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsyncOperation {
    pub op_id: u64,
    pub task_id: String,
    pub op_type: AsyncOpType,
    pub timestamp_us: u64,
    pub input_hash: u64,
    pub output_hash: Option<u64>,
    pub duration_us: u64,
    /// Serialized input for replay
    pub input_data: Option<Vec<u8>>,
    /// Serialized output for verification
    pub output_data: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AsyncOpType {
    /// Timer/delay operation
    Timer,
    /// I/O operation (file, network)
    Io,
    /// Message send/receive
    Message,
    /// State mutation
    StateMutation,
    /// External call (API, etc.)
    ExternalCall,
    /// Random number generation (needs seed replay)
    Random,
}

/// Replay log for a task
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskReplayLog {
    pub task_id: String,
    pub boundary_id: BoundaryId,
    pub created_at: u64,
    pub operations: Vec<AsyncOperation>,
    /// Random seed used (for deterministic replay of random ops)
    pub random_seed: u64,
    /// Checkpoint intervals (for partial replay)
    pub checkpoints: Vec<TaskCheckpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskCheckpoint {
    pub checkpoint_id: u64,
    pub op_index: usize,
    pub timestamp_us: u64,
    pub state_hash: u64,
    /// Serialized state at checkpoint
    pub state_data: Option<Vec<u8>>,
}

/// Replay mode for async tasks
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayMode {
    /// Full replay from start
    Full,
    /// Replay from nearest checkpoint
    FromCheckpoint,
    /// Skip replay, just restore state
    StateOnly,
    /// Verify replay matches log (for testing)
    VerifyOnly,
}

/// Async task replay engine
pub struct TaskReplayEngine {
    /// Recorded logs per task
    logs: HashMap<String, TaskReplayLog>,
    /// Max operations to record per task
    max_ops_per_task: usize,
    /// Checkpoint interval (operations)
    checkpoint_interval: usize,
    /// Whether to record input/output data (expensive)
    record_data: bool,
    /// Replay statistics
    stats: ReplayStats,
}

#[derive(Debug, Clone, Default)]
pub struct ReplayStats {
    pub total_replays: u64,
    pub successful_replays: u64,
    pub failed_replays: u64,
    pub checkpoint_restores: u64,
    pub full_replays: u64,
    pub average_replay_time_us: u64,
    pub divergence_count: u64,
}

impl TaskReplayEngine {
    pub fn new() -> Self {
        Self {
            logs: HashMap::new(),
            max_ops_per_task: 10000,
            checkpoint_interval: 100,
            record_data: false,  // Default: hash only for performance
            stats: ReplayStats::default(),
        }
    }
    
    /// Enable full data recording (expensive but enables exact replay)
    pub fn with_data_recording(mut self) -> Self {
        self.record_data = true;
        self
    }
    
    /// Start recording for a task
    pub fn start_recording(&mut self, task_id: String, boundary_id: BoundaryId) {
        let log = TaskReplayLog {
            task_id: task_id.clone(),
            boundary_id,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_micros() as u64,
            operations: Vec::new(),
            random_seed: rand::random(),
            checkpoints: Vec::new(),
        };
        self.logs.insert(task_id, log);
    }
    
    /// Record an async operation
    pub fn record_operation(
        &mut self,
        task_id: &str,
        op_type: AsyncOpType,
        input: &impl serde::Serialize,
        output: Option<&impl serde::Serialize>,
        duration_us: u64,
    ) {
        let Some(log) = self.logs.get_mut(task_id) else {
            return;
        };
        
        // Check limit
        if log.operations.len() >= self.max_ops_per_task {
            // Could either stop recording or evict old ops
            return;
        }
        
        let op_id = log.operations.len() as u64;
        
        // Compute hashes
        let input_hash = Self::hash_value(input);
        let output_hash = output.map(Self::hash_value);
        
        // Optionally record full data
        let input_data = if self.record_data {
            serde_json::to_vec(input).ok()
        } else {
            None
        };
        let output_data = if self.record_data && output.is_some() {
            output.and_then(|o| serde_json::to_vec(o).ok())
        } else {
            None
        };
        
        let timestamp_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64;
        
        log.operations.push(AsyncOperation {
            op_id,
            task_id: task_id.to_string(),
            op_type,
            timestamp_us,
            input_hash,
            output_hash,
            duration_us,
            input_data,
            output_data,
        });
        
        // Create checkpoint if needed
        if log.operations.len() % self.checkpoint_interval == 0 {
            log.checkpoints.push(TaskCheckpoint {
                checkpoint_id: log.checkpoints.len() as u64,
                op_index: log.operations.len(),
                timestamp_us,
                state_hash: 0,  // Would be computed from actual state
                state_data: None,
            });
        }
    }
    
    fn hash_value<T: serde::Serialize>(value: &T) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        
        let mut hasher = DefaultHasher::new();
        if let Ok(json) = serde_json::to_string(value) {
            json.hash(&mut hasher);
        }
        hasher.finish()
    }
    
    /// Get replay log for a task
    pub fn get_log(&self, task_id: &str) -> Option<&TaskReplayLog> {
        self.logs.get(task_id)
    }
    
    /// Prepare replay plan for warm reload
    pub fn prepare_replay(
        &self,
        task_id: &str,
        mode: ReplayMode,
    ) -> Option<ReplayPlan> {
        let log = self.logs.get(task_id)?;
        
        match mode {
            ReplayMode::Full => {
                Some(ReplayPlan {
                    task_id: task_id.to_string(),
                    start_op_index: 0,
                    ops_to_replay: log.operations.len(),
                    checkpoint: None,
                    random_seed: log.random_seed,
                })
            }
            ReplayMode::FromCheckpoint => {
                let checkpoint = log.checkpoints.last()?;
                Some(ReplayPlan {
                    task_id: task_id.to_string(),
                    start_op_index: checkpoint.op_index,
                    ops_to_replay: log.operations.len() - checkpoint.op_index,
                    checkpoint: Some(checkpoint.clone()),
                    random_seed: log.random_seed,
                })
            }
            ReplayMode::StateOnly => {
                Some(ReplayPlan {
                    task_id: task_id.to_string(),
                    start_op_index: log.operations.len(),
                    ops_to_replay: 0,
                    checkpoint: log.checkpoints.last().cloned(),
                    random_seed: log.random_seed,
                })
            }
            ReplayMode::VerifyOnly => {
                Some(ReplayPlan {
                    task_id: task_id.to_string(),
                    start_op_index: 0,
                    ops_to_replay: log.operations.len(),
                    checkpoint: None,
                    random_seed: log.random_seed,
                })
            }
        }
    }
    
    /// Get replay statistics
    pub fn stats(&self) -> &ReplayStats {
        &self.stats
    }
    
    /// Clear logs for a task
    pub fn clear_task(&mut self, task_id: &str) {
        self.logs.remove(task_id);
    }
    
    /// Clear logs for all tasks in a boundary
    pub fn clear_boundary(&mut self, boundary_id: &BoundaryId) {
        self.logs.retain(|_, log| &log.boundary_id != boundary_id);
    }
}

impl Default for TaskReplayEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Plan for replaying a task
#[derive(Debug, Clone)]
pub struct ReplayPlan {
    pub task_id: String,
    pub start_op_index: usize,
    pub ops_to_replay: usize,
    pub checkpoint: Option<TaskCheckpoint>,
    pub random_seed: u64,
}

// ============================================================
// RELOAD CLASSIFICATION METRICS
// ============================================================
// Track misclassified reloads to tune ReloadClassifier confidence.
// Without metrics, classifier confidence is meaningless.
// ============================================================

/// Metrics for reload classification accuracy
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClassificationMetrics {
    /// Total classifications made
    pub total_classifications: u64,
    /// Classifications by class
    pub by_class: HashMap<String, ClassStats>,
    /// Misclassifications (predicted != actual)
    pub misclassifications: Vec<Misclassification>,
    /// Rolling accuracy (last N classifications)
    pub rolling_accuracy: f64,
    /// Confidence calibration data
    pub calibration: CalibrationData,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClassStats {
    pub predicted_count: u64,
    pub actual_count: u64,
    pub correct_count: u64,
    pub false_positive_count: u64,
    pub false_negative_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Misclassification {
    pub timestamp: u64,
    pub boundary_id: String,
    pub predicted: String,
    pub actual: String,
    pub confidence: f64,
    pub reason: String,
    /// Changes that caused the misclassification
    pub changes: ReloadChanges,
}

/// Calibration data for confidence scores
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CalibrationData {
    /// Binned accuracy by confidence level
    /// Key: confidence bucket (0.0-0.1, 0.1-0.2, etc.)
    /// Value: (correct, total) in that bucket
    pub buckets: HashMap<u8, (u64, u64)>,
}

impl CalibrationData {
    /// Record a prediction outcome
    pub fn record(&mut self, confidence: f64, correct: bool) {
        let bucket = (confidence * 10.0).floor() as u8;
        let bucket = bucket.min(9);  // Cap at 0.9-1.0 bucket
        
        let entry = self.buckets.entry(bucket).or_insert((0, 0));
        if correct {
            entry.0 += 1;
        }
        entry.1 += 1;
    }
    
    /// Get calibration error (how far confidence is from actual accuracy)
    pub fn calibration_error(&self) -> f64 {
        let mut total_error = 0.0;
        let mut total_samples = 0u64;
        
        for (bucket, (correct, total)) in &self.buckets {
            if *total == 0 {
                continue;
            }
            
            let expected_accuracy = (*bucket as f64 + 0.5) / 10.0;
            let actual_accuracy = *correct as f64 / *total as f64;
            
            total_error += (*total as f64) * (expected_accuracy - actual_accuracy).abs();
            total_samples += total;
        }
        
        if total_samples == 0 {
            0.0
        } else {
            total_error / total_samples as f64
        }
    }
}

/// Classification metrics tracker
pub struct ClassificationTracker {
    metrics: ClassificationMetrics,
    /// Window for rolling accuracy
    recent_predictions: VecDeque<bool>,
    window_size: usize,
    /// Max misclassifications to keep
    max_misclassifications: usize,
}

impl ClassificationTracker {
    pub fn new() -> Self {
        Self {
            metrics: ClassificationMetrics::default(),
            recent_predictions: VecDeque::new(),
            window_size: 100,
            max_misclassifications: 1000,
        }
    }
    
    /// Record a classification prediction
    pub fn record_prediction(
        &mut self,
        _boundary_id: &BoundaryId,
        predicted: ReloadClass,
        _confidence: ClassificationConfidence,
        _changes: &ReloadChanges,
    ) -> u64 {
        self.metrics.total_classifications += 1;
        
        let class_key = format!("{:?}", predicted);
        let stats = self.metrics.by_class.entry(class_key).or_default();
        stats.predicted_count += 1;
        
        self.metrics.total_classifications
    }
    
    /// Record actual outcome after reload
    pub fn record_outcome(
        &mut self,
        _prediction_id: u64,
        boundary_id: &BoundaryId,
        predicted: ReloadClass,
        actual: ReloadClass,
        confidence: ClassificationConfidence,
        changes: &ReloadChanges,
    ) {
        let correct = predicted == actual;
        
        // Update class stats
        let predicted_key = format!("{:?}", predicted);
        let actual_key = format!("{:?}", actual);
        
        if let Some(stats) = self.metrics.by_class.get_mut(&predicted_key) {
            if correct {
                stats.correct_count += 1;
            } else {
                stats.false_positive_count += 1;
            }
        }
        
        let actual_stats = self.metrics.by_class.entry(actual_key.clone()).or_default();
        actual_stats.actual_count += 1;
        if !correct {
            actual_stats.false_negative_count += 1;
        }
        
        // Record misclassification
        if !correct {
            let confidence_value = match confidence {
                ClassificationConfidence::High => 0.9,
                ClassificationConfidence::Medium => 0.6,
                ClassificationConfidence::Low => 0.3,
            };
            
            self.metrics.misclassifications.push(Misclassification {
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
                boundary_id: format!("{:?}", boundary_id),
                predicted: predicted_key,
                actual: actual_key,
                confidence: confidence_value,
                reason: Self::analyze_misclassification(&predicted, &actual, changes),
                changes: changes.clone(),
            });
            
            // Enforce retention
            while self.metrics.misclassifications.len() > self.max_misclassifications {
                self.metrics.misclassifications.remove(0);
            }
        }
        
        // Update rolling accuracy
        self.recent_predictions.push_back(correct);
        while self.recent_predictions.len() > self.window_size {
            self.recent_predictions.pop_front();
        }
        
        let correct_count = self.recent_predictions.iter().filter(|&&c| c).count();
        self.metrics.rolling_accuracy = correct_count as f64 / self.recent_predictions.len() as f64;
        
        // Update calibration
        let confidence_value = match confidence {
            ClassificationConfidence::High => 0.9,
            ClassificationConfidence::Medium => 0.6,
            ClassificationConfidence::Low => 0.3,
        };
        self.metrics.calibration.record(confidence_value, correct);
    }
    
    fn analyze_misclassification(
        predicted: &ReloadClass,
        actual: &ReloadClass,
        changes: &ReloadChanges,
    ) -> String {
        match (predicted, actual) {
            (ReloadClass::Safe, ReloadClass::Warm) => {
                "Predicted safe but state migration was needed".to_string()
            }
            (ReloadClass::Safe, ReloadClass::Cold) => {
                "Predicted safe but breaking changes detected at runtime".to_string()
            }
            (ReloadClass::Warm, ReloadClass::Cold) => {
                format!(
                    "Predicted warm but cold required. Breaking changes: API={}, State={}",
                    changes.has_breaking_api_change,
                    changes.has_state_schema_change
                )
            }
            (ReloadClass::Warm, ReloadClass::Safe) => {
                "Over-classified as warm when safe would suffice".to_string()
            }
            (ReloadClass::Cold, ReloadClass::Warm) => {
                "Over-classified as cold when warm would suffice".to_string()
            }
            _ => format!("Predicted {:?}, actual {:?}", predicted, actual),
        }
    }
    
    /// Get current metrics
    pub fn metrics(&self) -> &ClassificationMetrics {
        &self.metrics
    }
    
    /// Get accuracy for a specific class
    pub fn class_accuracy(&self, class: ReloadClass) -> Option<f64> {
        let key = format!("{:?}", class);
        self.metrics.by_class.get(&key).map(|stats| {
            if stats.predicted_count == 0 {
                1.0  // No predictions = perfect (vacuously true)
            } else {
                stats.correct_count as f64 / stats.predicted_count as f64
            }
        })
    }
    
    /// Get precision for a class (correct / predicted)
    pub fn class_precision(&self, class: ReloadClass) -> Option<f64> {
        self.class_accuracy(class)  // Same as accuracy for our use case
    }
    
    /// Get recall for a class (correct / actual)
    pub fn class_recall(&self, class: ReloadClass) -> Option<f64> {
        let key = format!("{:?}", class);
        self.metrics.by_class.get(&key).map(|stats| {
            if stats.actual_count == 0 {
                1.0
            } else {
                stats.correct_count as f64 / stats.actual_count as f64
            }
        })
    }
    
    /// Export metrics as JSON
    pub fn export_json(&self) -> String {
        serde_json::to_string_pretty(&self.metrics).unwrap_or_default()
    }
    
    /// Get suggestions for improving classifier based on misclassifications
    pub fn get_improvement_suggestions(&self) -> Vec<String> {
        let mut suggestions = Vec::new();
        
        // Check calibration error
        let cal_error = self.metrics.calibration.calibration_error();
        if cal_error > 0.1 {
            suggestions.push(format!(
                "High calibration error ({:.2}). Confidence scores don't match actual accuracy.",
                cal_error
            ));
        }
        
        // Check for systematic misclassifications
        for (class, stats) in &self.metrics.by_class {
            if stats.predicted_count > 10 {
                let precision = stats.correct_count as f64 / stats.predicted_count as f64;
                if precision < 0.8 {
                    suggestions.push(format!(
                        "Class {} has low precision ({:.2}). Consider stricter classification rules.",
                        class, precision
                    ));
                }
            }
        }
        
        // Analyze recent misclassifications
        let recent_misses: Vec<_> = self.metrics.misclassifications.iter()
            .rev()
            .take(20)
            .collect();
        
        // Check for patterns
        let safe_to_warm = recent_misses.iter()
            .filter(|m| m.predicted == "Safe" && m.actual == "Warm")
            .count();
        
        if safe_to_warm > 5 {
            suggestions.push(
                "Frequent Safe->Warm misclassifications. State changes may not be detected properly.".to_string()
            );
        }
        
        suggestions
    }
}

impl Default for ClassificationTracker {
    fn default() -> Self {
        Self::new()
    }
}

