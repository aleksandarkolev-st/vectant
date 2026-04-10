// ============================================================
// RESTART CONTROL - BACKOFF, FALLBACK, AND LOOP PREVENTION
// ============================================================
// Addresses requirement #8: Restart-loop control that is operationally sane
//
// PROBLEMS ADDRESSED:
// - Naive retry leads to infinite restart loops
// - Constant restarts DoS the system
// - No fallback means stuck on broken builds
// - Manual intervention required too often
//
// SOLUTIONS:
// 1. Exponential backoff with jitter
// 2. Persist last known good module path per slot
// 3. Auto-fallback to last good build after N failures
// 4. Circuit breaker pattern for repeated failures
// ============================================================


use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

// ============================================================
// BACKOFF CONFIGURATION
// ============================================================

/// Configuration for restart backoff
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackoffConfig {
    /// Initial backoff duration
    pub initial_backoff: Duration,
    /// Maximum backoff duration
    pub max_backoff: Duration,
    /// Backoff multiplier (e.g., 2.0 for doubling)
    pub multiplier: f64,
    /// Jitter factor (0.0 to 1.0)
    /// Actual backoff = base * (1 + random(-jitter, +jitter))
    pub jitter: f64,
    /// Number of failures before circuit breaker opens
    pub circuit_breaker_threshold: u32,
    /// Time to wait before attempting to close circuit breaker
    pub circuit_breaker_timeout: Duration,
    /// Number of failures before auto-fallback
    pub fallback_threshold: u32,
    /// Reset failure count after this duration of success
    pub success_reset_duration: Duration,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            initial_backoff: Duration::from_millis(500),
            max_backoff: Duration::from_secs(30),
            multiplier: 2.0,
            jitter: 0.2,
            circuit_breaker_threshold: 5,
            circuit_breaker_timeout: Duration::from_secs(60),
            fallback_threshold: 3,
            success_reset_duration: Duration::from_secs(300), // 5 minutes
        }
    }
}

// ============================================================
// LAST KNOWN GOOD TRACKING
// ============================================================

/// Information about a known-good module build
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownGoodModule {
    /// Path to the module file
    pub path: PathBuf,
    /// Content hash for verification
    pub content_hash: u64,
    /// When this was marked as good
    pub marked_at: u64, // Unix timestamp
    /// ABI version
    pub abi_version: u32,
    /// State version
    pub state_version: u32,
    /// How long it ran successfully
    pub uptime_secs: u64,
    /// Optional: backed up snapshot
    pub snapshot_path: Option<PathBuf>,
}

/// Storage for last known good modules
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownGoodStore {
    /// Slot ID -> known good info
    pub modules: HashMap<String, KnownGoodModule>,
    /// Path to persistence file
    #[serde(skip)]
    pub persistence_path: Option<PathBuf>,
}

impl KnownGoodStore {
    pub fn new() -> Self {
        Self {
            modules: HashMap::new(),
            persistence_path: None,
        }
    }

    pub fn with_persistence(path: PathBuf) -> Self {
        let mut store = Self::new();
        store.persistence_path = Some(path.clone());

        // Try to load existing data
        if path.exists() {
            if let Ok(data) = std::fs::read_to_string(&path) {
                if let Ok(loaded) = serde_json::from_str::<HashMap<String, KnownGoodModule>>(&data)
                {
                    store.modules = loaded;
                }
            }
        }

        store
    }

    /// Mark a module as known good
    pub fn mark_good(
        &mut self,
        slot_id: &str,
        path: PathBuf,
        content_hash: u64,
        abi_version: u32,
        state_version: u32,
        uptime_secs: u64,
    ) {
        let info = KnownGoodModule {
            path,
            content_hash,
            marked_at: current_timestamp(),
            abi_version,
            state_version,
            uptime_secs,
            snapshot_path: None,
        };

        self.modules.insert(slot_id.to_string(), info);
        self.persist();
    }

    /// Get last known good for a slot
    pub fn get(&self, slot_id: &str) -> Option<&KnownGoodModule> {
        self.modules.get(slot_id)
    }

    /// Check if known good exists and is still valid
    pub fn is_valid(&self, slot_id: &str) -> bool {
        if let Some(info) = self.modules.get(slot_id) {
            // Check file still exists
            info.path.exists()
        } else {
            false
        }
    }

    fn persist(&self) {
        if let Some(ref path) = self.persistence_path {
            if let Ok(data) = serde_json::to_string_pretty(&self.modules) {
                let _ = std::fs::write(path, data);
            }
        }
    }
}

impl Default for KnownGoodStore {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================
// RESTART CONTROLLER
// ============================================================

/// Controls restart behavior for a slot
pub struct RestartController {
    config: BackoffConfig,
    /// Per-slot state
    slot_states: HashMap<String, SlotRestartState>,
    /// Known good module storage
    known_good: KnownGoodStore,
}

/// Restart state for a single slot
#[derive(Debug, Clone)]
pub struct SlotRestartState {
    /// Consecutive failures
    pub failure_count: u32,
    /// Last failure time
    pub last_failure: Option<Instant>,
    /// Last success time
    pub last_success: Option<Instant>,
    /// Current backoff duration
    pub current_backoff: Duration,
    /// Circuit breaker state
    pub circuit_state: CircuitBreakerState,
    /// Whether we're in fallback mode
    pub in_fallback: bool,
    /// Total restarts
    pub total_restarts: u64,
    /// Total failures
    pub total_failures: u64,
}

impl Default for SlotRestartState {
    fn default() -> Self {
        Self {
            failure_count: 0,
            last_failure: None,
            last_success: None,
            current_backoff: Duration::from_millis(500),
            circuit_state: CircuitBreakerState::Closed,
            in_fallback: false,
            total_restarts: 0,
            total_failures: 0,
        }
    }
}

/// Circuit breaker state
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitBreakerState {
    /// Normal operation - restarts allowed
    Closed,
    /// Too many failures - restarts blocked
    Open { opened_at: Instant },
    /// Testing if system recovered
    HalfOpen,
}

/// Decision from the restart controller
#[derive(Debug, Clone)]
pub enum RestartDecision {
    /// Restart immediately with new module
    RestartNow { module_path: PathBuf },
    /// Wait before restarting
    WaitThenRestart {
        delay: Duration,
        module_path: PathBuf,
        reason: String,
    },
    /// Fallback to last known good
    FallbackToKnownGood {
        module_path: PathBuf,
        reason: String,
    },
    /// Circuit breaker open - don't restart
    CircuitOpen {
        retry_after: Duration,
        reason: String,
    },
    /// Manual intervention required
    ManualIntervention { reason: String },
}

impl RestartController {
    pub fn new(config: BackoffConfig, known_good: KnownGoodStore) -> Self {
        Self {
            config,
            slot_states: HashMap::new(),
            known_good,
        }
    }

    /// Get or create state for a slot
    fn get_state(&mut self, slot_id: &str) -> &mut SlotRestartState {
        self.slot_states
            .entry(slot_id.to_string())
            .or_insert_with(SlotRestartState::default)
    }

    /// Record a failure and get restart decision
    pub fn record_failure(
        &mut self,
        slot_id: &str,
        new_module_path: &PathBuf,
        error: &str,
    ) -> RestartDecision {
        // Copy config values to avoid borrow conflicts
        let circuit_breaker_timeout = self.config.circuit_breaker_timeout;
        let circuit_breaker_threshold = self.config.circuit_breaker_threshold;
        let fallback_threshold = self.config.fallback_threshold;

        let now = Instant::now();

        // Get state and update failure counts
        let state = self.get_state(slot_id);
        state.failure_count += 1;
        state.total_failures += 1;
        state.last_failure = Some(now);

        let failure_count = state.failure_count;
        let circuit_state = state.circuit_state;

        eprintln!(
            "[RestartControl] Slot '{}' failure #{}: {}",
            slot_id, failure_count, error
        );

        // Check circuit breaker
        match circuit_state {
            CircuitBreakerState::Open { opened_at } => {
                let elapsed = now.duration_since(opened_at);
                if elapsed >= circuit_breaker_timeout {
                    // Try half-open
                    let state = self.get_state(slot_id);
                    state.circuit_state = CircuitBreakerState::HalfOpen;
                    eprintln!(
                        "[RestartControl] Circuit breaker half-open for '{}'",
                        slot_id
                    );
                } else {
                    let retry_after = circuit_breaker_timeout - elapsed;
                    return RestartDecision::CircuitOpen {
                        retry_after,
                        reason: format!(
                            "Circuit breaker open after {} failures. Retry in {:?}",
                            failure_count, retry_after
                        ),
                    };
                }
            }
            CircuitBreakerState::HalfOpen => {
                // Failed during half-open, go back to open
                let state = self.get_state(slot_id);
                state.circuit_state = CircuitBreakerState::Open { opened_at: now };
                return RestartDecision::CircuitOpen {
                    retry_after: circuit_breaker_timeout,
                    reason: "Failed during circuit breaker test".to_string(),
                };
            }
            CircuitBreakerState::Closed => {
                // Check if we should open circuit breaker
                if failure_count >= circuit_breaker_threshold {
                    let state = self.get_state(slot_id);
                    state.circuit_state = CircuitBreakerState::Open { opened_at: now };
                    eprintln!(
                        "[RestartControl] Circuit breaker OPEN for '{}' after {} failures",
                        slot_id, failure_count
                    );
                    return RestartDecision::CircuitOpen {
                        retry_after: circuit_breaker_timeout,
                        reason: format!(
                            "Circuit breaker opened after {} consecutive failures",
                            failure_count
                        ),
                    };
                }
            }
        }

        // Check if we should fallback
        if failure_count >= fallback_threshold {
            if let Some(known_good) = self.known_good.get(slot_id) {
                if known_good.path.exists() && known_good.path != *new_module_path {
                    let fallback_path = known_good.path.clone();
                    let marked_at = known_good.marked_at;
                    let state = self.get_state(slot_id);
                    state.in_fallback = true;
                    eprintln!(
                        "[RestartControl] Falling back to known good for '{}': {:?}",
                        slot_id, fallback_path
                    );
                    return RestartDecision::FallbackToKnownGood {
                        module_path: fallback_path,
                        reason: format!(
                            "Auto-fallback after {} failures. Using build from {}",
                            failure_count,
                            format_timestamp(marked_at)
                        ),
                    };
                }
            }
        }

        // Calculate backoff
        let base_backoff = self.calculate_backoff(failure_count);
        let jittered_backoff = self.apply_jitter(base_backoff);
        let state = self.get_state(slot_id);
        state.current_backoff = jittered_backoff;

        RestartDecision::WaitThenRestart {
            delay: jittered_backoff,
            module_path: new_module_path.clone(),
            reason: format!(
                "Backoff after failure #{}: waiting {:?}",
                failure_count, jittered_backoff
            ),
        }
    }

    /// Record a successful start
    pub fn record_success(&mut self, slot_id: &str, module_path: &PathBuf) {
        // Copy config values to avoid borrow conflicts
        let success_reset_duration = self.config.success_reset_duration;
        let initial_backoff = self.config.initial_backoff;

        let now = Instant::now();

        // Get initial state values
        let state = self.get_state(slot_id);
        let last_success = state.last_success;
        let circuit_state = state.circuit_state;

        // Check if this counts as "stable" (ran for success_reset_duration)
        let should_mark_good = if let Some(last_success_time) = last_success {
            now.duration_since(last_success_time) >= success_reset_duration
        } else {
            true
        };

        // Reset failure count and update state
        state.failure_count = 0;
        state.last_success = Some(now);
        state.current_backoff = initial_backoff;
        state.in_fallback = false;
        state.total_restarts += 1;

        // Close circuit breaker
        if circuit_state != CircuitBreakerState::Closed {
            eprintln!("[RestartControl] Circuit breaker CLOSED for '{}'", slot_id);
            state.circuit_state = CircuitBreakerState::Closed;
        }

        // Mark as known good if stable (drop the mutable borrow first)
        if should_mark_good {
            // Note: In real implementation, get these from the actual module
            self.known_good.mark_good(
                slot_id,
                module_path.clone(),
                0, // content_hash
                0, // abi_version
                0, // state_version
                success_reset_duration.as_secs(),
            );
            eprintln!(
                "[RestartControl] Marked '{}' as known good: {:?}",
                slot_id, module_path
            );
        }
    }

    fn calculate_backoff(&self, failure_count: u32) -> Duration {
        let base = self.config.initial_backoff.as_millis() as f64;
        let multiplied = base * self.config.multiplier.powi(failure_count as i32 - 1);
        let capped = multiplied.min(self.config.max_backoff.as_millis() as f64);
        Duration::from_millis(capped as u64)
    }

    fn apply_jitter(&self, base: Duration) -> Duration {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        // Simple pseudo-random jitter based on current time
        let mut hasher = DefaultHasher::new();
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .hash(&mut hasher);
        let hash = hasher.finish();

        // Convert to -jitter..+jitter range
        let random_factor = (hash as f64 / u64::MAX as f64) * 2.0 - 1.0; // -1.0 to 1.0
        let jitter_amount = random_factor * self.config.jitter;

        let adjusted = base.as_millis() as f64 * (1.0 + jitter_amount);
        Duration::from_millis(adjusted.max(0.0) as u64)
    }

    /// Get statistics for a slot
    pub fn get_stats(&self, slot_id: &str) -> Option<SlotRestartStats> {
        self.slot_states.get(slot_id).map(|state| SlotRestartStats {
            failure_count: state.failure_count,
            total_restarts: state.total_restarts,
            total_failures: state.total_failures,
            current_backoff: state.current_backoff,
            circuit_state: match state.circuit_state {
                CircuitBreakerState::Closed => "closed",
                CircuitBreakerState::Open { .. } => "open",
                CircuitBreakerState::HalfOpen => "half_open",
            },
            in_fallback: state.in_fallback,
            has_known_good: self.known_good.is_valid(slot_id),
        })
    }
}

/// Statistics about restart behavior
#[derive(Debug, Clone, Serialize)]
pub struct SlotRestartStats {
    pub failure_count: u32,
    pub total_restarts: u64,
    pub total_failures: u64,
    pub current_backoff: Duration,
    pub circuit_state: &'static str,
    pub in_fallback: bool,
    pub has_known_good: bool,
}

/// Get current Unix timestamp
fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Format timestamp for display
fn format_timestamp(ts: u64) -> String {
    // Simple formatting - in production use chrono
    let secs_ago = current_timestamp().saturating_sub(ts);
    if secs_ago < 60 {
        format!("{}s ago", secs_ago)
    } else if secs_ago < 3600 {
        format!("{}m ago", secs_ago / 60)
    } else if secs_ago < 86400 {
        format!("{}h ago", secs_ago / 3600)
    } else {
        format!("{}d ago", secs_ago / 86400)
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backoff_calculation() {
        let config = BackoffConfig {
            initial_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(10),
            multiplier: 2.0,
            jitter: 0.0, // No jitter for deterministic test
            ..Default::default()
        };

        let controller = RestartController::new(config, KnownGoodStore::new());

        assert_eq!(controller.calculate_backoff(1), Duration::from_millis(100));
        assert_eq!(controller.calculate_backoff(2), Duration::from_millis(200));
        assert_eq!(controller.calculate_backoff(3), Duration::from_millis(400));
        assert_eq!(controller.calculate_backoff(4), Duration::from_millis(800));
    }

    #[test]
    fn test_circuit_breaker() {
        let config = BackoffConfig {
            circuit_breaker_threshold: 3,
            circuit_breaker_timeout: Duration::from_millis(100),
            ..Default::default()
        };

        let mut controller = RestartController::new(config, KnownGoodStore::new());
        let path = PathBuf::from("/test/module.so");

        // First two failures should allow restart
        let d1 = controller.record_failure("test", &path, "error 1");
        assert!(matches!(d1, RestartDecision::WaitThenRestart { .. }));

        let d2 = controller.record_failure("test", &path, "error 2");
        assert!(matches!(d2, RestartDecision::WaitThenRestart { .. }));

        // Third failure should open circuit
        let d3 = controller.record_failure("test", &path, "error 3");
        assert!(matches!(d3, RestartDecision::CircuitOpen { .. }));
    }

    #[test]
    fn test_success_resets_count() {
        let config = BackoffConfig::default();
        let mut controller = RestartController::new(config, KnownGoodStore::new());
        let path = PathBuf::from("/test/module.so");

        // Record some failures
        controller.record_failure("test", &path, "error 1");
        controller.record_failure("test", &path, "error 2");

        assert_eq!(controller.slot_states.get("test").unwrap().failure_count, 2);

        // Success should reset
        controller.record_success("test", &path);

        assert_eq!(controller.slot_states.get("test").unwrap().failure_count, 0);
    }
}
