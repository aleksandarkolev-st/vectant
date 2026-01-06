// ============================================================
// QUIESCENCE PROTOCOL - SUBSYSTEM-SPECIFIC RULES
// ============================================================
// Addresses requirement #6: Quiescence is the real hard part. Specify it.
//
// PROBLEM:
// - "Stop everything" is not specific enough
// - Each subsystem has different shutdown requirements
// - Timeouts must be enforced, but durations vary
// - Some subsystems can "snapshot queue content", others cannot
//
// SOLUTION:
// - Define explicit quiescence rules per subsystem
// - Hard timeout with fallback to cold restart
// - Subsystem reports what it quiesced for debugging
// ============================================================

// #![allow(dead_code)] - REMOVED: This module is now wired up in main.rs

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

// ============================================================
// SUBSYSTEM DEFINITIONS
// ============================================================

/// Subsystem that must be quiesced before reload
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SubsystemId {
    /// Audio processing: callbacks, ring buffers, DSP threads
    Audio,
    /// Rendering: GPU work, render threads, frame queues
    Render,
    /// Input handling: event queues, gesture recognizers
    Input,
    /// Network I/O: connections, pending requests
    Network,
    /// File I/O: open handles, pending writes
    FileIO,
    /// Timers and schedulers
    Timers,
    /// Background worker threads
    Workers,
    /// Custom user-defined subsystem
    Custom(u32),
}

impl SubsystemId {
    pub fn as_str(&self) -> &'static str {
        match self {
            SubsystemId::Audio => "audio",
            SubsystemId::Render => "render",
            SubsystemId::Input => "input",
            SubsystemId::Network => "network",
            SubsystemId::FileIO => "file_io",
            SubsystemId::Timers => "timers",
            SubsystemId::Workers => "workers",
            SubsystemId::Custom(_) => "custom",
        }
    }
    
    /// Get default timeout for this subsystem
    pub fn default_timeout(&self) -> Duration {
        match self {
            SubsystemId::Audio => Duration::from_millis(500),   // Audio needs low latency
            SubsystemId::Render => Duration::from_secs(2),      // GPU fences can take time
            SubsystemId::Input => Duration::from_millis(100),   // Should be fast
            SubsystemId::Network => Duration::from_secs(5),     // Connections may need graceful close
            SubsystemId::FileIO => Duration::from_secs(3),      // Flush pending writes
            SubsystemId::Timers => Duration::from_millis(100),  // Just cancel
            SubsystemId::Workers => Duration::from_secs(2),     // Join threads
            SubsystemId::Custom(_) => Duration::from_secs(1),   // Default
        }
    }
}

// ============================================================
// QUIESCENCE REQUIREMENTS PER SUBSYSTEM
// ============================================================

/// Requirements for quiescing the Audio subsystem
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioQuiescenceReqs {
    /// Stop audio callback (REQUIRED)
    /// - Unregister from audio device
    /// - Wait for callback to complete (not just unregister)
    pub callback_stopped: bool,
    
    /// Flush ring buffers (REQUIRED for snapshot)
    /// - Process remaining samples OR discard
    /// - Record what was discarded for snapshot
    pub ring_buffer_flushed: bool,
    
    /// Acknowledge from audio driver (REQUIRED)
    /// - Some drivers need explicit stop + ack
    /// - Without ack, callback might still fire
    pub stop_acknowledged: bool,
    
    /// DSP threads joined (if any)
    pub dsp_threads_joined: u32,
    
    /// Samples discarded (for metrics)
    pub samples_discarded: u64,
    
    /// Snapshot includes audio state?
    /// - If false, audio will restart from silence
    pub audio_state_snapshotted: bool,
}

impl Default for AudioQuiescenceReqs {
    fn default() -> Self {
        Self {
            callback_stopped: false,
            ring_buffer_flushed: false,
            stop_acknowledged: false,
            dsp_threads_joined: 0,
            samples_discarded: 0,
            audio_state_snapshotted: false,
        }
    }
}

/// Requirements for quiescing the Render subsystem
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderQuiescenceReqs {
    /// GPU work fenced (REQUIRED)
    /// - Submit fence, wait for completion
    /// - All in-flight draws must complete
    pub gpu_work_fenced: bool,
    
    /// Render thread stopped (REQUIRED)
    /// - Signal stop, join thread
    pub render_thread_stopped: bool,
    
    /// Frame queue drained (REQUIRED)
    /// - Process or discard pending frames
    pub frame_queue_drained: bool,
    
    /// Swap chain idle
    pub swap_chain_idle: bool,
    
    /// Frames discarded (for metrics)
    pub frames_discarded: u32,
    
    /// Render state snapshotted?
    /// - Camera position, animation state, etc.
    pub render_state_snapshotted: bool,
}

impl Default for RenderQuiescenceReqs {
    fn default() -> Self {
        Self {
            gpu_work_fenced: false,
            render_thread_stopped: false,
            frame_queue_drained: false,
            swap_chain_idle: false,
            frames_discarded: 0,
            render_state_snapshotted: false,
        }
    }
}

/// Requirements for quiescing the Input subsystem
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputQuiescenceReqs {
    /// Event queue drained OR snapshotted (REQUIRED)
    /// - Option A: Process all pending events
    /// - Option B: Snapshot queue content for replay
    pub queue_handled: bool,
    
    /// How queue was handled
    pub queue_handling: QueueHandling,
    
    /// Events in queue at quiescence
    pub events_pending: u32,
    
    /// Events snapshotted (if applicable)
    pub events_snapshotted: u32,
    
    /// Gesture recognizers reset
    pub gesture_state_reset: bool,
}

impl Default for InputQuiescenceReqs {
    fn default() -> Self {
        Self {
            queue_handled: false,
            queue_handling: QueueHandling::NotHandled,
            events_pending: 0,
            events_snapshotted: 0,
            gesture_state_reset: false,
        }
    }
}

/// How a queue was handled during quiescence
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum QueueHandling {
    /// Not handled yet
    NotHandled,
    /// All items processed normally
    Drained,
    /// Items discarded
    Discarded,
    /// Items included in snapshot for replay
    Snapshotted,
    /// Items sent to supervisor for external handling
    Forwarded,
}

/// Requirements for quiescing Network subsystem
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkQuiescenceReqs {
    /// All connections closed gracefully
    pub connections_closed: bool,
    
    /// Pending requests completed or cancelled
    pub requests_handled: bool,
    
    /// Connections open at quiescence
    pub connections_open: u32,
    
    /// Requests pending at quiescence
    pub requests_pending: u32,
    
    /// Requests cancelled (for metrics)
    pub requests_cancelled: u32,
}

impl Default for NetworkQuiescenceReqs {
    fn default() -> Self {
        Self {
            connections_closed: false,
            requests_handled: false,
            connections_open: 0,
            requests_pending: 0,
            requests_cancelled: 0,
        }
    }
}

// ============================================================
// QUIESCENCE STATE MACHINE
// ============================================================

/// State of quiescence for a subsystem
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum QuiescenceState {
    /// Normal operation
    Active,
    /// Quiescence requested, in progress
    Quiescing { started_at_ms: u64 },
    /// Successfully quiesced
    Quiescent { achieved_at_ms: u64, duration_ms: u64 },
    /// Failed to quiesce within timeout
    Failed { reason: String, elapsed_ms: u64 },
    /// Forcibly terminated (hard restart)
    Terminated,
}

/// Configuration for quiescence
#[derive(Debug, Clone)]
pub struct QuiescenceConfig {
    /// Per-subsystem timeouts
    pub subsystem_timeouts: HashMap<SubsystemId, Duration>,
    /// Global timeout (all subsystems must complete)
    pub global_timeout: Duration,
    /// Allow partial quiescence (some subsystems can fail)
    pub allow_partial: bool,
    /// Subsystems that MUST succeed (others can be force-terminated)
    pub required_subsystems: Vec<SubsystemId>,
    /// Action on timeout
    pub timeout_action: TimeoutAction,
}

impl Default for QuiescenceConfig {
    fn default() -> Self {
        let mut subsystem_timeouts = HashMap::new();
        subsystem_timeouts.insert(SubsystemId::Audio, Duration::from_millis(500));
        subsystem_timeouts.insert(SubsystemId::Render, Duration::from_secs(2));
        subsystem_timeouts.insert(SubsystemId::Input, Duration::from_millis(100));
        subsystem_timeouts.insert(SubsystemId::Network, Duration::from_secs(5));
        subsystem_timeouts.insert(SubsystemId::FileIO, Duration::from_secs(3));
        subsystem_timeouts.insert(SubsystemId::Timers, Duration::from_millis(100));
        subsystem_timeouts.insert(SubsystemId::Workers, Duration::from_secs(2));
        
        Self {
            subsystem_timeouts,
            global_timeout: Duration::from_secs(10),
            allow_partial: false,
            required_subsystems: vec![SubsystemId::Audio, SubsystemId::Render],
            timeout_action: TimeoutAction::ColdRestart,
        }
    }
}

/// Action to take on quiescence timeout
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TimeoutAction {
    /// Send Error(fatal=false), supervisor does cold restart
    ColdRestart,
    /// Send Error(fatal=true), supervisor does full restart
    FullRestart,
    /// Force-terminate subsystem and continue
    ForceTerminate,
    /// Abort reload, return to active state
    AbortReload,
}

// ============================================================
// QUIESCENCE MANAGER
// ============================================================

/// Manages quiescence across all subsystems
pub struct QuiescenceManager {
    config: QuiescenceConfig,
    states: HashMap<SubsystemId, QuiescenceState>,
    started_at: Option<Instant>,
    /// Callbacks for subsystem quiescence
    quiescence_handlers: HashMap<SubsystemId, Box<dyn QuiescenceHandler>>,
}

/// Handler for subsystem quiescence
pub trait QuiescenceHandler: Send {
    /// Request quiescence for this subsystem
    fn request_quiescence(&mut self) -> Result<(), String>;
    
    /// Check if quiescence is complete
    fn is_quiescent(&self) -> bool;
    
    /// Get detailed report
    fn get_report(&self) -> SubsystemQuiescenceReport;
    
    /// Force terminate (if timeout)
    fn force_terminate(&mut self);
    
    /// Exit quiescence (if reload cancelled)
    fn exit_quiescence(&mut self);
}

/// Detailed report from a subsystem
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubsystemQuiescenceReport {
    pub subsystem: SubsystemId,
    pub state: QuiescenceState,
    pub items_flushed: u32,
    pub items_discarded: u32,
    pub threads_joined: u32,
    pub duration_ms: u64,
    pub error: Option<String>,
    /// Subsystem-specific details (JSON for flexibility)
    pub details: String,
}

impl QuiescenceManager {
    pub fn new(config: QuiescenceConfig) -> Self {
        Self {
            config,
            states: HashMap::new(),
            started_at: None,
            quiescence_handlers: HashMap::new(),
        }
    }
    
    /// Register a handler for a subsystem
    pub fn register_handler(&mut self, id: SubsystemId, handler: Box<dyn QuiescenceHandler>) {
        self.quiescence_handlers.insert(id, handler);
        self.states.insert(id, QuiescenceState::Active);
    }
    
    /// Start quiescence process for all subsystems
    pub fn start_quiescence(&mut self) -> Result<(), String> {
        if self.started_at.is_some() {
            return Err("Quiescence already in progress".to_string());
        }
        
        self.started_at = Some(Instant::now());
        let now_ms = timestamp_ms();
        
        // Request quiescence from all handlers
        let mut errors = Vec::new();
        for (id, handler) in &mut self.quiescence_handlers {
            self.states.insert(*id, QuiescenceState::Quiescing { started_at_ms: now_ms });
            
            if let Err(e) = handler.request_quiescence() {
                errors.push(format!("{}: {}", id.as_str(), e));
            }
        }
        
        if !errors.is_empty() && !self.config.allow_partial {
            return Err(format!("Quiescence failed: {}", errors.join(", ")));
        }
        
        Ok(())
    }
    
    /// Poll for quiescence completion
    /// Returns Ok(true) if all done, Ok(false) if still waiting, Err if failed
    pub fn poll(&mut self) -> Result<bool, QuiescenceError> {
        let started = self.started_at.ok_or(QuiescenceError::NotStarted)?;
        let elapsed = started.elapsed();
        let now_ms = timestamp_ms();
        
        // Check global timeout
        if elapsed > self.config.global_timeout {
            return Err(QuiescenceError::GlobalTimeout {
                elapsed_ms: elapsed.as_millis() as u64,
                timeout_ms: self.config.global_timeout.as_millis() as u64,
            });
        }
        
        let mut all_done = true;
        let mut failures = Vec::new();
        
        for (id, handler) in &mut self.quiescence_handlers {
            let timeout = self.config.subsystem_timeouts
                .get(id)
                .copied()
                .unwrap_or(id.default_timeout());
            
            match self.states.get(id) {
                Some(QuiescenceState::Quiescing { started_at_ms }) => {
                    let subsystem_elapsed = now_ms.saturating_sub(*started_at_ms);
                    
                    if handler.is_quiescent() {
                        // Success
                        self.states.insert(*id, QuiescenceState::Quiescent {
                            achieved_at_ms: now_ms,
                            duration_ms: subsystem_elapsed,
                        });
                    } else if subsystem_elapsed > timeout.as_millis() as u64 {
                        // Timeout
                        let is_required = self.config.required_subsystems.contains(id);
                        
                        if is_required {
                            self.states.insert(*id, QuiescenceState::Failed {
                                reason: "Timeout".to_string(),
                                elapsed_ms: subsystem_elapsed,
                            });
                            failures.push(*id);
                        } else {
                            // Force terminate non-required
                            handler.force_terminate();
                            self.states.insert(*id, QuiescenceState::Terminated);
                        }
                    } else {
                        all_done = false;
                    }
                }
                Some(QuiescenceState::Quiescent { .. }) => {
                    // Already done
                }
                Some(QuiescenceState::Failed { .. }) => {
                    failures.push(*id);
                }
                _ => {
                    all_done = false;
                }
            }
        }
        
        if !failures.is_empty() {
            return Err(QuiescenceError::SubsystemFailed {
                subsystems: failures,
            });
        }
        
        Ok(all_done)
    }
    
    /// Get full quiescence report
    pub fn get_report(&self) -> FullQuiescenceReport {
        let mut subsystem_reports = Vec::new();
        
        for (_id, handler) in &self.quiescence_handlers {
            subsystem_reports.push(handler.get_report());
        }
        
        let total_duration = self.started_at
            .map(|s| s.elapsed().as_millis() as u64)
            .unwrap_or(0);
        
        let all_quiescent = self.states.values()
            .all(|s| matches!(s, QuiescenceState::Quiescent { .. } | QuiescenceState::Terminated));
        
        FullQuiescenceReport {
            all_quiescent,
            total_duration_ms: total_duration,
            subsystems: subsystem_reports,
            timeout_action: self.config.timeout_action,
        }
    }
    
    /// Cancel quiescence and return to active state
    pub fn cancel(&mut self) {
        for handler in self.quiescence_handlers.values_mut() {
            handler.exit_quiescence();
        }
        
        for state in self.states.values_mut() {
            *state = QuiescenceState::Active;
        }
        
        self.started_at = None;
    }
}

/// Errors during quiescence
#[derive(Debug, Clone)]
pub enum QuiescenceError {
    /// Quiescence not started
    NotStarted,
    /// Global timeout exceeded
    GlobalTimeout { elapsed_ms: u64, timeout_ms: u64 },
    /// One or more required subsystems failed
    SubsystemFailed { subsystems: Vec<SubsystemId> },
}

impl std::fmt::Display for QuiescenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QuiescenceError::NotStarted => write!(f, "Quiescence not started"),
            QuiescenceError::GlobalTimeout { elapsed_ms, timeout_ms } => {
                write!(f, "Global timeout: {}ms > {}ms", elapsed_ms, timeout_ms)
            }
            QuiescenceError::SubsystemFailed { subsystems } => {
                let names: Vec<_> = subsystems.iter().map(|s| s.as_str()).collect();
                write!(f, "Subsystems failed: {}", names.join(", "))
            }
        }
    }
}

/// Full quiescence report
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullQuiescenceReport {
    pub all_quiescent: bool,
    pub total_duration_ms: u64,
    pub subsystems: Vec<SubsystemQuiescenceReport>,
    pub timeout_action: TimeoutAction,
}

/// Get current timestamp in milliseconds
fn timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ============================================================
// EXAMPLE HANDLERS
// ============================================================

/// Example: No-op handler for testing
pub struct NoOpQuiescenceHandler {
    subsystem: SubsystemId,
    quiescent: bool,
}

impl NoOpQuiescenceHandler {
    pub fn new(subsystem: SubsystemId) -> Self {
        Self { subsystem, quiescent: false }
    }
}

impl QuiescenceHandler for NoOpQuiescenceHandler {
    fn request_quiescence(&mut self) -> Result<(), String> {
        self.quiescent = true;
        Ok(())
    }
    
    fn is_quiescent(&self) -> bool {
        self.quiescent
    }
    
    fn get_report(&self) -> SubsystemQuiescenceReport {
        SubsystemQuiescenceReport {
            subsystem: self.subsystem,
            state: if self.quiescent {
                QuiescenceState::Quiescent { achieved_at_ms: 0, duration_ms: 0 }
            } else {
                QuiescenceState::Active
            },
            items_flushed: 0,
            items_discarded: 0,
            threads_joined: 0,
            duration_ms: 0,
            error: None,
            details: "{}".to_string(),
        }
    }
    
    fn force_terminate(&mut self) {
        self.quiescent = true;
    }
    
    fn exit_quiescence(&mut self) {
        self.quiescent = false;
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_quiescence_flow() {
        let config = QuiescenceConfig::default();
        let mut manager = QuiescenceManager::new(config);
        
        // Register handlers
        manager.register_handler(
            SubsystemId::Audio,
            Box::new(NoOpQuiescenceHandler::new(SubsystemId::Audio))
        );
        manager.register_handler(
            SubsystemId::Render,
            Box::new(NoOpQuiescenceHandler::new(SubsystemId::Render))
        );
        
        // Start quiescence
        manager.start_quiescence().unwrap();
        
        // Should complete immediately with no-op handlers
        let result = manager.poll().unwrap();
        assert!(result);
        
        // Report should show all quiescent
        let report = manager.get_report();
        assert!(report.all_quiescent);
    }
    
    #[test]
    fn test_subsystem_defaults() {
        assert!(SubsystemId::Audio.default_timeout() < SubsystemId::Network.default_timeout());
        assert!(SubsystemId::Input.default_timeout() < SubsystemId::FileIO.default_timeout());
    }
}
