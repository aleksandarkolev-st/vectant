use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Debounce delay in milliseconds (for actual compilation trigger)
const DEBOUNCE_MS: u64 = 300;

/// Preemptive/speculative compilation delay in milliseconds
/// This is shorter than debounce - starts compile early but doesn't commit
const SPECULATIVE_DEBOUNCE_MS: u64 = 150;

/// Keystroke detection threshold (fast consecutive changes)
const KEYSTROKE_THRESHOLD_MS: u64 = 100;

/// Maximum debounce extension during burst typing
const MAX_EXTENDED_DEBOUNCE_MS: u64 = 2000;

/// Minimum time between consecutive events to consider "typing stopped"
const TYPING_STOPPED_MS: u64 = 500;

/// File change types for rebuild decision
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileChangeType {
    SharedHeader, // shared.h changed - rebuild both
    CoreSource,   // core.cpp changed - rebuild core (+ gui if ABI changed)
    GuiSource,    // gui.cpp changed - rebuild gui only
    MainSource,   // main source changed - rebuild main
    Other,        // other file - needs analysis
}

impl FileChangeType {
    pub fn from_path(path: &str) -> Self {
        let lower = path.to_lowercase();
        if lower.ends_with("shared.h") || lower.ends_with("shared.hpp") {
            FileChangeType::SharedHeader
        } else if lower.contains("core")
            && (lower.ends_with(".cpp") || lower.ends_with(".c") || lower.ends_with(".rs"))
        {
            FileChangeType::CoreSource
        } else if lower.contains("gui")
            && (lower.ends_with(".cpp") || lower.ends_with(".c") || lower.ends_with(".rs"))
        {
            FileChangeType::GuiSource
        } else if lower.ends_with(".cpp") || lower.ends_with(".c") || lower.ends_with(".rs") {
            FileChangeType::MainSource
        } else {
            FileChangeType::Other
        }
    }
}

/// Message sent from watcher to build system
#[derive(Debug, Clone)]
pub struct WatcherMessage {
    pub paths: Vec<String>,
    pub change_types: Vec<FileChangeType>,
    pub timestamp: Instant,
}

pub fn setup_watcher(path: &Path, tx: Sender<String>) -> notify::Result<RecommendedWatcher> {
    let (notify_tx, notify_rx) = std::sync::mpsc::channel();

    let mut watcher = RecommendedWatcher::new(notify_tx, Config::default())?;

    watcher.watch(path, RecursiveMode::Recursive)?;

    std::thread::spawn(move || {
        // Debounce state: track pending changes per file
        let mut pending: HashMap<String, Instant> = HashMap::new();
        let mut last_emit = Instant::now();

        loop {
            // Use a short timeout to check for debounce expiry
            match notify_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(event)) => {
                    let now = Instant::now();

                    // Filter for relevant events (modify/create)
                    use notify::EventKind;
                    let dominated =
                        matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_));

                    if !dominated {
                        continue;
                    }

                    // Add/update pending files
                    for path in event.paths {
                        if let Some(path_str) = path.to_str() {
                            // Skip build artifacts and temp files
                            if path_str.contains("/target/")
                                || path_str.contains("\\target\\")
                                || path_str.contains("/.")
                                || path_str.contains("\\.")
                                || path_str.ends_with(".so")
                                || path_str.ends_with(".dll")
                                || path_str.ends_with(".o")
                                || path_str.ends_with(".obj")
                                || path_str.contains("debug_ai_generated")
                            {
                                continue;
                            }
                            pending.insert(path_str.to_string(), now);
                        }
                    }
                }
                Ok(Err(e)) => {
                    println!("[Watcher] Error: {:?}", e);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // Check if any pending files have passed debounce threshold
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    println!("[Watcher] Channel disconnected");
                    break;
                }
            }

            // Check for debounce expiry
            let now = Instant::now();
            let debounce_duration = Duration::from_millis(DEBOUNCE_MS);

            // Collect files that have passed debounce threshold
            let mut ready: Vec<String> = Vec::new();
            pending.retain(|path, timestamp| {
                if now.duration_since(*timestamp) >= debounce_duration {
                    ready.push(path.clone());
                    false // Remove from pending
                } else {
                    true // Keep in pending
                }
            });

            // Emit coalesced changes
            if !ready.is_empty() && now.duration_since(last_emit) >= debounce_duration {
                // Determine what kind of rebuild is needed
                let mut has_shared = false;
                let mut has_core = false;
                let mut has_gui = false;

                for path in &ready {
                    match FileChangeType::from_path(path) {
                        FileChangeType::SharedHeader => has_shared = true,
                        FileChangeType::CoreSource => has_core = true,
                        FileChangeType::GuiSource => has_gui = true,
                        _ => {}
                    }
                }

                // Send a summary message indicating what changed
                // Format: "changed:<scope>:<paths>"
                // scope: "both", "core", "gui", "main"
                let scope = if has_shared {
                    "both"
                } else if has_core && has_gui {
                    "both"
                } else if has_core {
                    "core"
                } else if has_gui {
                    "gui"
                } else {
                    "main"
                };

                let message = format!("changed:{}:{}", scope, ready.join(","));
                if let Err(e) = tx.send(message) {
                    println!("[Watcher] Failed to send: {:?}", e);
                    break;
                }

                last_emit = now;
            }
        }
    });

    Ok(watcher)
}

// ============================================================
// PREEMPTIVE/SPECULATIVE COMPILATION
// ============================================================
// Starts compilation early based on keystroke patterns.
// The speculative compile runs in background and can be
// cancelled if more changes arrive before completion.
// ============================================================

/// Configuration for preemptive compilation
#[derive(Debug, Clone)]
pub struct PreemptiveConfig {
    /// Enable preemptive compilation
    pub enabled: bool,
    /// Speculative compile delay after keystroke pause (ms)
    pub speculative_delay_ms: u64,
    /// Final commit delay (ms) - actual HMR swap
    pub commit_delay_ms: u64,
    /// Max speculative compiles before forcing commit
    pub max_speculative_count: u32,
}

impl Default for PreemptiveConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            speculative_delay_ms: SPECULATIVE_DEBOUNCE_MS,
            commit_delay_ms: DEBOUNCE_MS,
            max_speculative_count: 5,
        }
    }
}

/// State of a speculative compilation
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpeculativeState {
    /// No speculative compile in progress
    Idle,
    /// Speculative compile started
    Compiling,
    /// Compile finished, waiting for commit window
    Ready,
    /// Compile was invalidated by new changes
    Invalidated,
}

/// Message types for preemptive compilation
#[derive(Debug, Clone)]
pub enum PreemptiveMessage {
    /// Start speculative compilation
    StartSpeculative {
        paths: Vec<String>,
        scope: String,
        timestamp: Instant,
    },
    /// Cancel current speculative compile (new changes arrived)
    CancelSpeculative { reason: String },
    /// Commit the speculative compile result
    CommitSpeculative { paths: Vec<String>, scope: String },
    /// Regular change notification (backwards compatible)
    Changed { scope: String, paths: Vec<String> },
}

/// Preemptive watcher with speculative compilation support
pub struct PreemptiveWatcher {
    config: PreemptiveConfig,
    /// Current speculative state
    state: SpeculativeState,
    /// Files in current speculative compile
    speculative_files: Vec<String>,
    /// Scope of current speculative compile
    speculative_scope: String,
    /// When speculative compile started
    speculative_start: Option<Instant>,
    /// Number of speculative compiles since last commit
    speculative_count: u32,
    /// Cancellation flag (shared with compiler)
    cancel_flag: Arc<AtomicBool>,
    /// Last change timestamp per file
    pending: HashMap<String, Instant>,
    /// Last speculative trigger time
    last_speculative: Instant,
    /// Last commit time
    last_commit: Instant,
    /// Burst typing detection: track rapid consecutive changes
    burst_start: Option<Instant>,
    /// Number of changes in current burst
    burst_count: u32,
    /// Last change time (for burst detection)
    last_change: Instant,
}

impl PreemptiveWatcher {
    pub fn new(config: PreemptiveConfig) -> Self {
        Self {
            config,
            state: SpeculativeState::Idle,
            speculative_files: Vec::new(),
            speculative_scope: String::new(),
            speculative_start: None,
            speculative_count: 0,
            cancel_flag: Arc::new(AtomicBool::new(false)),
            pending: HashMap::new(),
            last_speculative: Instant::now(),
            last_commit: Instant::now(),
            burst_start: None,
            burst_count: 0,
            last_change: Instant::now(),
        }
    }

    /// Get the cancellation flag for sharing with compiler
    pub fn get_cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel_flag.clone()
    }

    /// Check if user is in a typing burst (rapid consecutive changes)
    fn is_burst_typing(&self) -> bool {
        if let Some(burst_start) = self.burst_start {
            // User is burst typing if: we're in a burst, haven't exceeded max time,
            // and had recent changes
            let burst_duration = burst_start.elapsed();
            let since_last = self.last_change.elapsed();

            burst_duration < Duration::from_millis(MAX_EXTENDED_DEBOUNCE_MS)
                && since_last < Duration::from_millis(TYPING_STOPPED_MS)
                && self.burst_count >= 3 // Need at least 3 rapid changes to be "burst"
        } else {
            false
        }
    }

    /// Get effective debounce time (extended during burst typing)
    fn effective_debounce(&self) -> Duration {
        if self.is_burst_typing() {
            // During burst typing, wait longer before committing
            // Scale up based on burst intensity, but cap at MAX_EXTENDED_DEBOUNCE_MS
            let base = self.config.commit_delay_ms;
            let extension = (self.burst_count as u64 * 50).min(500); // +50ms per burst event, max +500ms
            Duration::from_millis((base + extension).min(MAX_EXTENDED_DEBOUNCE_MS))
        } else {
            Duration::from_millis(self.config.commit_delay_ms)
        }
    }

    /// Record a file change
    pub fn record_change(&mut self, path: String) {
        let now = Instant::now();
        let since_last = now.duration_since(self.last_change);

        // Detect burst typing
        if since_last < Duration::from_millis(KEYSTROKE_THRESHOLD_MS) {
            // Rapid change - we're in a burst
            if self.burst_start.is_none() {
                self.burst_start = Some(now);
            }
            self.burst_count += 1;
        } else if since_last > Duration::from_millis(TYPING_STOPPED_MS) {
            // Gap in typing - reset burst state
            self.burst_start = None;
            self.burst_count = 0;
        }

        self.last_change = now;

        // If we have an active speculative compile, check if we should cancel it
        if self.state == SpeculativeState::Compiling {
            // Check if this is a different file than what we're compiling
            if !self.speculative_files.contains(&path) {
                // New file changed - cancel speculative compile
                self.cancel_speculative("New file changed");
            } else {
                // Same file changed again - cancel and restart
                self.cancel_speculative("File modified again");
            }
        }

        self.pending.insert(path, now);
    }

    /// Cancel the current speculative compilation
    fn cancel_speculative(&mut self, reason: &str) {
        if self.state == SpeculativeState::Compiling {
            self.cancel_flag.store(true, Ordering::SeqCst);
            self.state = SpeculativeState::Invalidated;
            println!("[Preemptive] Cancelled speculative compile: {}", reason);
        }
    }

    /// Check timers and return any messages to send
    pub fn check_timers(&mut self) -> Vec<PreemptiveMessage> {
        let now = Instant::now();
        let mut messages = Vec::new();

        if !self.config.enabled {
            // Fall back to simple debounce behavior
            return self.check_simple_debounce();
        }

        let speculative_duration = Duration::from_millis(self.config.speculative_delay_ms);
        let commit_duration = self.effective_debounce(); // Use adaptive debounce

        // Don't start speculative compiles during burst typing
        let allow_speculative = !self.is_burst_typing();

        // Collect files ready for speculative compile
        let mut speculative_ready: Vec<String> = Vec::new();
        let mut commit_ready: Vec<String> = Vec::new();

        for (path, timestamp) in &self.pending {
            let elapsed = now.duration_since(*timestamp);

            if elapsed >= commit_duration {
                commit_ready.push(path.clone());
            } else if elapsed >= speculative_duration {
                speculative_ready.push(path.clone());
            }
        }

        // Priority: commit over speculative
        if !commit_ready.is_empty() && now.duration_since(self.last_commit) >= commit_duration {
            // Ready to commit
            let scope = self.determine_scope(&commit_ready);

            // Remove committed files from pending
            for path in &commit_ready {
                self.pending.remove(path);
            }

            // If we have a ready speculative compile, commit it
            if self.state == SpeculativeState::Ready {
                messages.push(PreemptiveMessage::CommitSpeculative {
                    paths: commit_ready.clone(),
                    scope: scope.clone(),
                });
            } else {
                // No speculative result - do normal compile
                messages.push(PreemptiveMessage::Changed {
                    scope: scope.clone(),
                    paths: commit_ready.clone(),
                });
            }

            self.state = SpeculativeState::Idle;
            self.speculative_count = 0;
            self.last_commit = now;
            self.cancel_flag.store(false, Ordering::SeqCst);
        } else if !speculative_ready.is_empty()
            && self.state == SpeculativeState::Idle
            && now.duration_since(self.last_speculative) >= speculative_duration
            && self.speculative_count < self.config.max_speculative_count
            && allow_speculative
        // Don't speculate during burst typing
        {
            // Start speculative compile
            let scope = self.determine_scope(&speculative_ready);

            self.state = SpeculativeState::Compiling;
            self.speculative_files = speculative_ready.clone();
            self.speculative_scope = scope.clone();
            self.speculative_start = Some(now);
            self.speculative_count += 1;
            self.last_speculative = now;
            self.cancel_flag.store(false, Ordering::SeqCst);

            messages.push(PreemptiveMessage::StartSpeculative {
                paths: speculative_ready,
                scope,
                timestamp: now,
            });
        }

        messages
    }

    /// Mark speculative compile as complete
    pub fn speculative_complete(&mut self, success: bool) {
        if self.state == SpeculativeState::Compiling {
            if success && !self.cancel_flag.load(Ordering::SeqCst) {
                self.state = SpeculativeState::Ready;
                println!("[Preemptive] Speculative compile ready for commit");
            } else {
                self.state = SpeculativeState::Idle;
                println!("[Preemptive] Speculative compile failed or cancelled");
            }
        }
    }

    /// Simple debounce fallback when preemptive is disabled
    fn check_simple_debounce(&mut self) -> Vec<PreemptiveMessage> {
        let now = Instant::now();
        let debounce_duration = Duration::from_millis(self.config.commit_delay_ms);
        let mut messages = Vec::new();

        let mut ready: Vec<String> = Vec::new();
        self.pending.retain(|path, timestamp| {
            if now.duration_since(*timestamp) >= debounce_duration {
                ready.push(path.clone());
                false
            } else {
                true
            }
        });

        if !ready.is_empty() && now.duration_since(self.last_commit) >= debounce_duration {
            let scope = self.determine_scope(&ready);
            messages.push(PreemptiveMessage::Changed {
                scope,
                paths: ready,
            });
            self.last_commit = now;
        }

        messages
    }

    /// Determine compilation scope from changed files
    fn determine_scope(&self, paths: &[String]) -> String {
        let mut has_shared = false;
        let mut has_core = false;
        let mut has_gui = false;

        for path in paths {
            match FileChangeType::from_path(path) {
                FileChangeType::SharedHeader => has_shared = true,
                FileChangeType::CoreSource => has_core = true,
                FileChangeType::GuiSource => has_gui = true,
                _ => {}
            }
        }

        if has_shared {
            "both".to_string()
        } else if has_core && has_gui {
            "both".to_string()
        } else if has_core {
            "core".to_string()
        } else if has_gui {
            "gui".to_string()
        } else {
            "main".to_string()
        }
    }
}

/// Setup watcher with preemptive compilation support
pub fn setup_preemptive_watcher(
    path: &Path,
    tx: Sender<PreemptiveMessage>,
    config: PreemptiveConfig,
) -> notify::Result<(RecommendedWatcher, Arc<AtomicBool>)> {
    let (notify_tx, notify_rx) = std::sync::mpsc::channel();

    let mut watcher = RecommendedWatcher::new(notify_tx, Config::default())?;
    watcher.watch(path, RecursiveMode::Recursive)?;

    let mut preemptive = PreemptiveWatcher::new(config);
    let cancel_flag = preemptive.get_cancel_flag();

    std::thread::spawn(move || {
        loop {
            // Short timeout for responsive timer checks
            match notify_rx.recv_timeout(Duration::from_millis(25)) {
                Ok(Ok(event)) => {
                    use notify::EventKind;
                    let dominated =
                        matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_));

                    if !dominated {
                        continue;
                    }

                    for path in event.paths {
                        if let Some(path_str) = path.to_str() {
                            // Skip build artifacts
                            if path_str.contains("/target/")
                                || path_str.contains("\\target\\")
                                || path_str.contains("/.")
                                || path_str.contains("\\.")
                                || path_str.ends_with(".so")
                                || path_str.ends_with(".dll")
                                || path_str.ends_with(".o")
                                || path_str.ends_with(".obj")
                                || path_str.contains("debug_ai_generated")
                            {
                                continue;
                            }
                            preemptive.record_change(path_str.to_string());
                        }
                    }
                }
                Ok(Err(e)) => {
                    println!("[Preemptive Watcher] Error: {:?}", e);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // Check timers
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    println!("[Preemptive Watcher] Channel disconnected");
                    break;
                }
            }

            // Check timers and send messages
            for message in preemptive.check_timers() {
                if let Err(e) = tx.send(message) {
                    println!("[Preemptive Watcher] Failed to send: {:?}", e);
                    break;
                }
            }
        }
    });

    Ok((watcher, cancel_flag))
}

/// Speculative compilation result cache
#[derive(Debug)]
pub struct SpeculativeCache {
    /// Cached compilation results by content hash
    results: HashMap<u64, SpeculativeCacheEntry>,
    /// Maximum cache entries
    max_entries: usize,
}

#[derive(Debug, Clone)]
pub struct SpeculativeCacheEntry {
    /// Content hash that was compiled
    pub content_hash: u64,
    /// Path to compiled object/library
    pub artifact_path: String,
    /// When this was compiled
    pub timestamp: Instant,
    /// Whether compilation succeeded
    pub success: bool,
    /// Compilation scope (core, gui, etc)
    pub scope: String,
}

impl SpeculativeCache {
    pub fn new(max_entries: usize) -> Self {
        Self {
            results: HashMap::new(),
            max_entries,
        }
    }

    /// Store a speculative compilation result
    pub fn store(&mut self, hash: u64, entry: SpeculativeCacheEntry) {
        // Evict oldest if at capacity
        if self.results.len() >= self.max_entries {
            if let Some(oldest_key) = self
                .results
                .iter()
                .min_by_key(|(_, e)| e.timestamp)
                .map(|(k, _)| *k)
            {
                self.results.remove(&oldest_key);
            }
        }

        self.results.insert(hash, entry);
    }

    /// Try to get a cached speculative result
    pub fn get(&self, hash: u64) -> Option<&SpeculativeCacheEntry> {
        self.results.get(&hash)
    }

    /// Check if we have a valid cached result
    pub fn has_valid(&self, hash: u64, max_age: Duration) -> bool {
        if let Some(entry) = self.results.get(&hash) {
            entry.success && entry.timestamp.elapsed() < max_age
        } else {
            false
        }
    }

    /// Clear all cached results
    pub fn clear(&mut self) {
        self.results.clear();
    }

    /// Remove entries older than max_age
    pub fn cleanup(&mut self, max_age: Duration) {
        self.results
            .retain(|_, entry| entry.timestamp.elapsed() < max_age);
    }
}
