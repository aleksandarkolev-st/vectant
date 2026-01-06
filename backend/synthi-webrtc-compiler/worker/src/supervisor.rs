// Crash supervisor is now actively used in runner_bin.rs and HmrOrchestrator
// #![allow(dead_code)] - REMOVED: This module is now wired up
#![allow(dead_code)]

// ============================================================
// CRASH SUPERVISOR
// ============================================================
// Manages crash detection, recovery, and process isolation.
// Part of the split runner responsibilities pattern.
//
// RESPONSIBILITIES:
// - Monitor plugin execution for crashes
// - Coordinate crash recovery and state restoration
// - Manage process isolation boundaries
// - Report crash diagnostics
// ============================================================

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use crate::crash_recovery::{CrashInfo, ProtectionMode};
use crate::plugin_contract::ModuleSlot;

// Note: observability imports available if needed in future:
// use crate::observability::{CrashReason, CrashEvent as ObsCrashEvent, LogLevel, LogEntry, StructuredLogger, LogFormat};

/// Crash event for tracking
#[derive(Debug, Clone)]
pub struct CrashEvent {
    pub timestamp: Instant,
    pub module: ModuleSlot,
    pub signal: i32,
    pub signal_name: String,
    pub recovered: bool,
    pub recovery_action: RecoveryAction,
    pub source_location: Option<String>,
}

/// Recovery action taken after crash
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryAction {
    /// Hot-reloaded the module
    HotReload,
    /// Rolled back to previous version
    Rollback,
    /// Restarted with clean state
    CleanRestart,
    /// Full process restart required
    FullRestart,
    /// Crash was fatal, no recovery possible
    Fatal,
}

/// Crash supervisor configuration
#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    /// Maximum consecutive crashes before escalating
    pub max_consecutive_crashes: u32,
    /// Time window for counting consecutive crashes
    pub crash_window: Duration,
    /// Protection mode for plugin execution
    pub protection_mode: ProtectionMode,
    /// Enable detailed crash logging
    pub detailed_logging: bool,
    /// Maximum crash history to keep
    pub max_history: usize,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            max_consecutive_crashes: 3,
            crash_window: Duration::from_secs(60),
            protection_mode: ProtectionMode::default(),
            detailed_logging: true,
            max_history: 100,
        }
    }
}

/// Crash statistics
#[derive(Debug, Clone, Default)]
pub struct CrashStats {
    pub total_crashes: u64,
    pub recovered_crashes: u64,
    pub fatal_crashes: u64,
    pub crashes_by_module: std::collections::HashMap<String, u64>,
    pub last_crash: Option<Instant>,
    pub uptime_since_last_crash: Option<Duration>,
}

/// Crash supervisor manages crash detection and recovery
pub struct CrashSupervisor {
    config: SupervisorConfig,
    /// Crash history (ring buffer)
    crash_history: VecDeque<CrashEvent>,
    /// Consecutive crash counter
    consecutive_crashes: AtomicU32,
    /// Last crash time (for window calculation)
    last_crash_time: Option<Instant>,
    /// Is currently in recovery mode
    in_recovery: AtomicBool,
    /// Current module being executed (for crash attribution)
    current_module: Option<ModuleSlot>,
    /// Statistics
    stats: CrashStats,
}

impl CrashSupervisor {
    pub fn new(config: SupervisorConfig) -> Self {
        Self {
            config,
            crash_history: VecDeque::with_capacity(100),
            consecutive_crashes: AtomicU32::new(0),
            last_crash_time: None,
            in_recovery: AtomicBool::new(false),
            current_module: None,
            stats: CrashStats::default(),
        }
    }

    /// Enter supervised execution context
    pub fn enter_context(&mut self, module: ModuleSlot) {
        self.current_module = Some(module);
    }

    /// Exit supervised execution context
    pub fn exit_context(&mut self) {
        self.current_module = None;
    }

    /// Report a crash event
    pub fn report_crash(&mut self, crash_info: &CrashInfo) -> RecoveryAction {
        let now = Instant::now();
        let module = self.current_module.unwrap_or(ModuleSlot::Main);

        // Update consecutive crash count
        if let Some(last_time) = self.last_crash_time {
            if now.duration_since(last_time) > self.config.crash_window {
                // Outside window, reset counter
                self.consecutive_crashes.store(1, Ordering::SeqCst);
            } else {
                self.consecutive_crashes.fetch_add(1, Ordering::SeqCst);
            }
        } else {
            self.consecutive_crashes.store(1, Ordering::SeqCst);
        }
        self.last_crash_time = Some(now);

        // Determine recovery action
        let consecutive = self.consecutive_crashes.load(Ordering::SeqCst);
        let action = self.determine_recovery_action(consecutive, &module);

        // Record event
        let event = CrashEvent {
            timestamp: now,
            module,
            signal: crash_info.signal,
            signal_name: crash_info.signal_name.clone(),
            recovered: action != RecoveryAction::Fatal,
            recovery_action: action,
            source_location: crash_info.source_location_str(),
        };

        self.record_event(event);
        self.update_stats(module, action);

        if self.config.detailed_logging {
            eprintln!(
                "[Supervisor] Crash in {:?}: {} (consecutive: {}, action: {:?})",
                module, crash_info.signal_name, consecutive, action
            );
            if let Some(loc) = &crash_info.source_location_str() {
                eprintln!("[Supervisor] Location: {}", loc);
            }
        }

        action
    }

    /// Determine the appropriate recovery action
    fn determine_recovery_action(&self, consecutive: u32, _module: &ModuleSlot) -> RecoveryAction {
        if consecutive >= self.config.max_consecutive_crashes {
            // Too many crashes, escalate
            return RecoveryAction::FullRestart;
        }

        match consecutive {
            1 => {
                // First crash, try hot reload
                RecoveryAction::HotReload
            }
            2 => {
                // Second crash, try rollback
                RecoveryAction::Rollback
            }
            _ => {
                // Third+ crash, clean restart
                RecoveryAction::CleanRestart
            }
        }
    }

    /// Record a crash event
    fn record_event(&mut self, event: CrashEvent) {
        // Keep history bounded
        while self.crash_history.len() >= self.config.max_history {
            self.crash_history.pop_front();
        }
        self.crash_history.push_back(event);
    }

    /// Update statistics
    fn update_stats(&mut self, module: ModuleSlot, action: RecoveryAction) {
        self.stats.total_crashes += 1;

        if action == RecoveryAction::Fatal {
            self.stats.fatal_crashes += 1;
        } else {
            self.stats.recovered_crashes += 1;
        }

        *self
            .stats
            .crashes_by_module
            .entry(module.as_str().to_string())
            .or_insert(0) += 1;

        self.stats.last_crash = Some(Instant::now());
    }

    /// Check if we should force a full restart
    pub fn should_force_restart(&self) -> bool {
        self.consecutive_crashes.load(Ordering::SeqCst) >= self.config.max_consecutive_crashes
    }

    /// Reset crash counter (call after successful recovery)
    pub fn reset_crash_count(&self) {
        self.consecutive_crashes.store(0, Ordering::SeqCst);
    }

    /// Get crash statistics
    pub fn get_stats(&self) -> CrashStats {
        let mut stats = self.stats.clone();
        if let Some(last) = stats.last_crash {
            stats.uptime_since_last_crash = Some(Instant::now().duration_since(last));
        }
        stats
    }

    /// Get recent crash history
    pub fn get_history(&self, count: usize) -> Vec<&CrashEvent> {
        self.crash_history.iter().rev().take(count).collect()
    }

    /// Generate crash report for debugging
    pub fn generate_report(&self) -> String {
        let stats = self.get_stats();
        let recent = self.get_history(5);

        let mut report = String::new();
        report.push_str("=== Crash Supervisor Report ===\n\n");
        report.push_str(&format!("Total crashes: {}\n", stats.total_crashes));
        report.push_str(&format!("Recovered: {}\n", stats.recovered_crashes));
        report.push_str(&format!("Fatal: {}\n", stats.fatal_crashes));
        report.push_str(&format!(
            "Consecutive: {}\n",
            self.consecutive_crashes.load(Ordering::SeqCst)
        ));

        if !stats.crashes_by_module.is_empty() {
            report.push_str("\nCrashes by module:\n");
            for (module, count) in &stats.crashes_by_module {
                report.push_str(&format!("  {}: {}\n", module, count));
            }
        }

        if !recent.is_empty() {
            report.push_str("\nRecent crashes:\n");
            for event in recent {
                report.push_str(&format!(
                    "  [{:?}] {} in {:?} -> {:?}\n",
                    event.timestamp.elapsed(),
                    event.signal_name,
                    event.module,
                    event.recovery_action
                ));
            }
        }

        report
    }
}

impl Default for CrashSupervisor {
    fn default() -> Self {
        Self::new(SupervisorConfig::default())
    }
}

/// Interface trait for crash supervision (for dependency injection/testing)
pub trait CrashSupervisorInterface: Send + Sync {
    fn enter_context(&mut self, module: ModuleSlot);
    fn exit_context(&mut self);
    fn report_crash(&mut self, crash_info: &CrashInfo) -> RecoveryAction;
    fn should_force_restart(&self) -> bool;
    fn reset_crash_count(&self);
}

impl CrashSupervisorInterface for CrashSupervisor {
    fn enter_context(&mut self, module: ModuleSlot) {
        CrashSupervisor::enter_context(self, module)
    }

    fn exit_context(&mut self) {
        CrashSupervisor::exit_context(self)
    }

    fn report_crash(&mut self, crash_info: &CrashInfo) -> RecoveryAction {
        CrashSupervisor::report_crash(self, crash_info)
    }

    fn should_force_restart(&self) -> bool {
        CrashSupervisor::should_force_restart(self)
    }

    fn reset_crash_count(&self) {
        CrashSupervisor::reset_crash_count(self)
    }
}
