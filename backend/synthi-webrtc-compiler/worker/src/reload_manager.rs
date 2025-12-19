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
        }
    }
    
    /// Classify a reload based on what changed
    pub fn classify(&self, changes: &ReloadChanges) -> ReloadClass {
        // Cold if any breaking changes
        if changes.has_breaking_api_change || 
           changes.has_state_schema_change ||
           changes.removed_exports.len() > 0 {
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
}

impl Default for ReloadClassifier {
    fn default() -> Self {
        Self::new()
    }
}

/// Detected changes for classification
#[derive(Debug, Clone, Default)]
pub struct ReloadChanges {
    pub modified_functions: HashSet<String>,
    pub api_functions: HashSet<String>,
    pub added_exports: HashSet<String>,
    pub removed_exports: HashSet<String>,
    pub has_breaking_api_change: bool,
    pub has_state_schema_change: bool,
    pub is_stateless_change: bool,
}

// ============================================================
// PRE-RELOAD SNAPSHOTS
// ============================================================
// Snapshot everything before reload for instant crash revert

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
    
    /// Whether snapshot is still valid for revert
    pub valid: bool,
    
    /// Reason if invalidated
    pub invalidation_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateSnapshot {
    pub boundary_id: BoundaryId,
    pub json_state: String,
    pub abi_version: u32,
    pub source_hash: u64,
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

/// Snapshot manager with retention policy
pub struct SnapshotManager {
    snapshots: VecDeque<ReloadSnapshot>,
    max_snapshots: usize,
    next_id: AtomicU64,
}

impl SnapshotManager {
    pub fn new(max_snapshots: usize) -> Self {
        Self {
            snapshots: VecDeque::new(),
            max_snapshots,
            next_id: AtomicU64::new(1),
        }
    }
    
    /// Create a new snapshot before reload
    pub fn create_snapshot(
        &mut self,
        reload_class: ReloadClass,
        state_manager: &StateManager,
        boundaries: &[BoundaryId],
    ) -> u64 {
        let snapshot_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        
        // Collect state snapshots
        let mut state_snapshots = HashMap::new();
        for boundary_id in boundaries {
            // Would serialize actual state here
            state_snapshots.insert(boundary_id.clone(), StateSnapshot {
                boundary_id: boundary_id.clone(),
                json_state: "{}".to_string(), // Placeholder
                abi_version: 1,
                source_hash: 0,
            });
        }
        
        let snapshot = ReloadSnapshot {
            snapshot_id,
            created_at: Instant::now(),
            reload_class,
            state_snapshots,
            module_hashes: HashMap::new(),
            in_flight_requests: Vec::new(),
            task_states: Vec::new(),
            valid: true,
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
        let snapshot = self.snapshots
            .iter()
            .find(|s| s.snapshot_id == snapshot_id)
            .ok_or_else(|| format!("Snapshot {} not found", snapshot_id))?;
        
        if !snapshot.valid {
            return Err(format!(
                "Snapshot {} is invalid: {}",
                snapshot_id,
                snapshot.invalidation_reason.as_deref().unwrap_or("unknown")
            ));
        }
        
        Ok(snapshot)
    }
    
    /// Invalidate all snapshots older than given one
    pub fn invalidate_before(&mut self, snapshot_id: u64, reason: &str) {
        for snapshot in self.snapshots.iter_mut() {
            if snapshot.snapshot_id < snapshot_id {
                snapshot.valid = false;
                snapshot.invalidation_reason = Some(reason.to_string());
            }
        }
    }
    
    /// Get most recent valid snapshot
    pub fn latest_valid(&self) -> Option<&ReloadSnapshot> {
        self.snapshots.iter().rev().find(|s| s.valid)
    }
}

// ============================================================
// ASYNC TASK GUARDRAILS
// ============================================================
// Handle long-lived tasks during reload

/// Registry for async tasks that must be managed during reload
pub struct AsyncTaskRegistry {
    tasks: HashMap<String, RegisteredTask>,
    shutdown_timeout: Duration,
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
}

impl AsyncTaskRegistry {
    pub fn new(shutdown_timeout: Duration) -> Self {
        Self {
            tasks: HashMap::new(),
            shutdown_timeout,
        }
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
        let shutdown_signal = Arc::new(AtomicBool::new(false));
        
        self.tasks.insert(task_id.clone(), RegisteredTask {
            task_id,
            task_type,
            boundary_id,
            supports_checkpoint,
            supports_pause,
            shutdown_signal: shutdown_signal.clone(),
            registered_at: Instant::now(),
        });
        
        shutdown_signal
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
        &self,
        boundary_id: &BoundaryId,
        reload_class: ReloadClass,
    ) -> TaskPreparationResult {
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
            blocking_tasks: blocking,
            can_proceed: blocking.is_empty() || reload_class == ReloadClass::Cold,
        }
    }
    
    /// Signal shutdown to tasks
    pub fn signal_shutdown(&self, task_ids: &[String]) {
        for task_id in task_ids {
            if let Some(task) = self.tasks.get(task_id) {
                task.shutdown_signal.store(true, Ordering::SeqCst);
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
    /// Whether to compare outputs
    pub compare_outputs: bool,
}

impl Default for CanaryConfig {
    fn default() -> Self {
        Self {
            traffic_percentage: 0,  // Shadow only by default
            min_requests: 100,
            max_error_rate: 0.01,
            max_latency_factor: 1.5,
            promotion_delay: Duration::from_secs(300),
            compare_outputs: true,
        }
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
    pub output_mismatches: u32,
    
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
            output_mismatches: 0,
            decision: None,
        }
    }
    
    /// Record a request result
    pub fn record_result(&mut self, is_new: bool, error: bool, latency_ms: u64, output_match: Option<bool>) {
        if is_new {
            self.new_requests += 1;
            if error { self.new_errors += 1; }
            self.new_latency_sum_ms += latency_ms;
        } else {
            self.old_requests += 1;
            if error { self.old_errors += 1; }
            self.old_latency_sum_ms += latency_ms;
        }
        
        if let Some(false) = output_match {
            self.output_mismatches += 1;
        }
    }
    
    /// Evaluate canary health and make decision
    pub fn evaluate(&mut self) -> CanaryDecision {
        // Not enough data yet
        if self.new_requests < self.config.min_requests {
            return CanaryDecision::Continue;
        }
        
        // Calculate metrics
        let new_error_rate = self.new_errors as f64 / self.new_requests as f64;
        let old_error_rate = if self.old_requests > 0 {
            self.old_errors as f64 / self.old_requests as f64
        } else {
            0.0
        };
        
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
        
        // Check output mismatches if comparing
        if self.config.compare_outputs {
            let mismatch_rate = self.output_mismatches as f64 / self.new_requests as f64;
            if mismatch_rate > 0.01 {
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
            config,
            stats: ReloadStats::default(),
        }
    }
    
    /// Execute a reload with full orchestration
    pub fn execute_reload(
        &mut self,
        boundary_id: &BoundaryId,
        changes: &ReloadChanges,
        state_manager: &StateManager,
    ) -> Result<ReloadResult, ReloadError> {
        let start = Instant::now();
        
        // 1. Classify the reload
        let mut reload_class = self.classifier.classify(changes);
        
        // 2. Check if canary mode should be used
        if self.config.enable_canary && reload_class == ReloadClass::Warm {
            reload_class = ReloadClass::Canary;
        }
        
        // 3. Check request readiness
        let readiness = self.request_tracker.can_reload(boundary_id, reload_class);
        match readiness {
            ReloadReadiness::MustWait { reason, estimated_wait } => {
                return Err(ReloadError::NotReady {
                    reason,
                    estimated_wait,
                });
            }
            ReloadReadiness::CanProceed { policy, .. } => {
                self.request_tracker.apply_policy(boundary_id, policy);
            }
            ReloadReadiness::Ready => {}
        }
        
        // 4. Check cascade permission
        if let CascadePermission::Denied { reason } = 
            self.cascade_breaker.allow_cascade(0, 1) {
            return Err(ReloadError::CascadeBlocked { reason });
        }
        
        // 5. Prepare async tasks
        let task_prep = self.task_registry.prepare_for_reload(boundary_id, reload_class);
        if !task_prep.can_proceed {
            return Err(ReloadError::TasksBlocking {
                task_ids: task_prep.blocking_tasks,
            });
        }
        
        // 6. Create snapshot if required
        let snapshot_id = if reload_class.requires_snapshot() {
            Some(self.snapshots.create_snapshot(
                reload_class,
                state_manager,
                &[boundary_id.clone()],
            ))
        } else {
            None
        };
        
        // 7. Signal task shutdown/pause
        self.task_registry.signal_shutdown(&task_prep.to_terminate);
        
        // 8. Execute the reload (placeholder - actual reload logic elsewhere)
        self.cascade_breaker.start_cascade();
        let reload_success = true; // Actual reload would happen here
        self.cascade_breaker.end_cascade(reload_success, 1);
        
        // 9. Update statistics
        let duration = start.elapsed();
        self.update_stats(reload_class, duration, reload_success);
        
        // 10. Check latency target
        if duration.as_millis() as u64 > reload_class.max_latency_ms() {
            eprintln!(
                "WARNING: {} reload took {}ms, target was {}ms",
                format!("{:?}", reload_class),
                duration.as_millis(),
                reload_class.max_latency_ms()
            );
        }
        
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
        let snapshot = self.snapshots.revert_to_snapshot(snapshot_id)
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
            state.record_result(true, false, 50, Some(true));
        }
        
        // Should still be continue (waiting for promotion delay)
        assert_eq!(state.evaluate(), CanaryDecision::Continue);
    }
}
