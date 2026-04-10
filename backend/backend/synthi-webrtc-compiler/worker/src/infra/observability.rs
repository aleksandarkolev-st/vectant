// ============================================================
// OBSERVABILITY AND DEBUGGING
// ============================================================
// Addresses requirement #10: Observability and debugging
//
// FEATURES:
// 1. Structured logs with reload IDs for correlation
// 2. Snapshot size and time metrics
// 3. Crash reason classification
// 4. Optional core dump capture
// 5. Tracing spans for debugging
// ============================================================


use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

// ============================================================
// RELOAD ID GENERATION
// Re-export from reload_protocol to avoid duplication
// ============================================================

// v2.1: Use ReloadId from reload_protocol for consistency
pub use crate::hmr::reload_protocol::ReloadId;

// ============================================================
// STRUCTURED LOGGING
// ============================================================

/// Log level
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

/// A structured log entry
#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    /// Timestamp (ISO 8601)
    pub timestamp: String,
    /// Log level
    pub level: LogLevel,
    /// Component producing the log
    pub component: &'static str,
    /// Human-readable message
    pub message: String,
    /// Reload ID for correlation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reload_id: Option<ReloadId>,
    /// Slot ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot_id: Option<String>,
    /// Additional context fields
    #[serde(flatten)]
    pub fields: HashMap<String, serde_json::Value>,
}

impl LogEntry {
    pub fn new(level: LogLevel, component: &'static str, message: impl Into<String>) -> Self {
        Self {
            timestamp: chrono_timestamp(),
            level,
            component,
            message: message.into(),
            reload_id: None,
            slot_id: None,
            fields: HashMap::new(),
        }
    }

    /// Add reload ID for correlation
    pub fn with_reload_id(mut self, id: ReloadId) -> Self {
        self.reload_id = Some(id);
        self
    }

    /// Add slot ID
    pub fn with_slot_id(mut self, id: impl Into<String>) -> Self {
        self.slot_id = Some(id.into());
        self
    }

    /// Add arbitrary field
    pub fn with_field(mut self, key: impl Into<String>, value: impl Serialize) -> Self {
        if let Ok(v) = serde_json::to_value(value) {
            self.fields.insert(key.into(), v);
        }
        self
    }

    /// Output as JSON
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| self.message.clone())
    }

    /// Output as human-readable
    pub fn to_human(&self) -> String {
        let level_str = match self.level {
            LogLevel::Trace => "TRACE",
            LogLevel::Debug => "DEBUG",
            LogLevel::Info => "INFO ",
            LogLevel::Warn => "WARN ",
            LogLevel::Error => "ERROR",
        };

        let mut parts = vec![format!(
            "{} [{}] [{}]",
            self.timestamp, level_str, self.component
        )];

        if let Some(ref rid) = self.reload_id {
            parts.push(format!("[{}]", rid));
        }
        if let Some(ref sid) = self.slot_id {
            parts.push(format!("[slot:{}]", sid));
        }

        parts.push(self.message.clone());

        if !self.fields.is_empty() {
            let fields_str: Vec<String> = self
                .fields
                .iter()
                .map(|(k, v)| format!("{}={}", k, v))
                .collect();
            parts.push(format!("{{{}}}", fields_str.join(", ")));
        }

        parts.join(" ")
    }
}

/// Logger that emits structured logs
pub struct StructuredLogger {
    /// Output format
    pub format: LogFormat,
    /// Minimum level to emit
    pub min_level: LogLevel,
    /// Output destination
    output: LogOutput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Json,
    Human,
}

enum LogOutput {
    Stderr,
    File(PathBuf),
}

impl StructuredLogger {
    pub fn new(format: LogFormat, min_level: LogLevel) -> Self {
        Self {
            format,
            min_level,
            output: LogOutput::Stderr,
        }
    }

    pub fn log(&self, entry: &LogEntry) {
        if (entry.level as u8) < (self.min_level as u8) {
            return;
        }

        let output = match self.format {
            LogFormat::Json => entry.to_json(),
            LogFormat::Human => entry.to_human(),
        };

        match &self.output {
            LogOutput::Stderr => eprintln!("{}", output),
            LogOutput::File(_path) => {
                // In production: append to file
                eprintln!("{}", output);
            }
        }
    }
}

// Convenience macros would go here in real implementation
// For now, provide helper functions

pub fn log_info(logger: &StructuredLogger, component: &'static str, msg: impl Into<String>) {
    logger.log(&LogEntry::new(LogLevel::Info, component, msg));
}

pub fn log_error(logger: &StructuredLogger, component: &'static str, msg: impl Into<String>) {
    logger.log(&LogEntry::new(LogLevel::Error, component, msg));
}

// ============================================================
// METRICS COLLECTION
// ============================================================

/// Metrics for reload operations
#[derive(Debug, Clone, Serialize, Default)]
pub struct ReloadMetrics {
    /// Total reloads attempted
    pub total_reloads: u64,
    /// Successful reloads
    pub successful_reloads: u64,
    /// Failed reloads
    pub failed_reloads: u64,
    /// Reloads that required fallback
    pub fallback_reloads: u64,

    // Timing metrics (in microseconds)
    /// Average quiescence time
    pub avg_quiescence_time_us: u64,
    /// Max quiescence time
    pub max_quiescence_time_us: u64,
    /// Average snapshot time
    pub avg_snapshot_time_us: u64,
    /// Max snapshot time
    pub max_snapshot_time_us: u64,
    /// Average restore time
    pub avg_restore_time_us: u64,
    /// Max restore time
    pub max_restore_time_us: u64,
    /// Average total reload time
    pub avg_total_reload_time_us: u64,
    /// Max total reload time
    pub max_total_reload_time_us: u64,

    // Size metrics (in bytes)
    /// Average snapshot size
    pub avg_snapshot_size_bytes: u64,
    /// Max snapshot size
    pub max_snapshot_size_bytes: u64,
    /// Total bytes transferred
    pub total_bytes_transferred: u64,
}

/// Tracks metrics for a single reload operation
pub struct ReloadMetricsTracker {
    pub reload_id: ReloadId,
    pub slot_id: String,
    start_time: Instant,
    quiescence_duration: Option<Duration>,
    snapshot_duration: Option<Duration>,
    restore_duration: Option<Duration>,
    snapshot_size: Option<usize>,
}

impl ReloadMetricsTracker {
    pub fn start(reload_id: ReloadId, slot_id: impl Into<String>) -> Self {
        Self {
            reload_id,
            slot_id: slot_id.into(),
            start_time: Instant::now(),
            quiescence_duration: None,
            snapshot_duration: None,
            restore_duration: None,
            snapshot_size: None,
        }
    }

    pub fn record_quiescence(&mut self, duration: Duration) {
        self.quiescence_duration = Some(duration);
    }

    pub fn record_snapshot(&mut self, duration: Duration, size: usize) {
        self.snapshot_duration = Some(duration);
        self.snapshot_size = Some(size);
    }

    pub fn record_restore(&mut self, duration: Duration) {
        self.restore_duration = Some(duration);
    }

    pub fn total_duration(&self) -> Duration {
        self.start_time.elapsed()
    }

    /// Convert to a log entry
    pub fn to_log_entry(&self, success: bool) -> LogEntry {
        let level = if success {
            LogLevel::Info
        } else {
            LogLevel::Error
        };
        let message = if success {
            "Reload completed successfully"
        } else {
            "Reload failed"
        };

        let mut entry = LogEntry::new(level, "metrics", message)
            .with_reload_id(self.reload_id)
            .with_slot_id(&self.slot_id)
            .with_field("total_ms", self.total_duration().as_millis());

        if let Some(d) = self.quiescence_duration {
            entry = entry.with_field("quiescence_ms", d.as_millis());
        }
        if let Some(d) = self.snapshot_duration {
            entry = entry.with_field("snapshot_ms", d.as_millis());
        }
        if let Some(d) = self.restore_duration {
            entry = entry.with_field("restore_ms", d.as_millis());
        }
        if let Some(s) = self.snapshot_size {
            entry = entry.with_field("snapshot_bytes", s);
        }

        entry
    }
}

/// Aggregates metrics across multiple reloads
pub struct MetricsAggregator {
    metrics: ReloadMetrics,
    // Running stats for averages
    quiescence_sum_us: u64,
    snapshot_sum_us: u64,
    restore_sum_us: u64,
    total_sum_us: u64,
    snapshot_size_sum: u64,
    sample_count: u64,
}

impl MetricsAggregator {
    pub fn new() -> Self {
        Self {
            metrics: ReloadMetrics::default(),
            quiescence_sum_us: 0,
            snapshot_sum_us: 0,
            restore_sum_us: 0,
            total_sum_us: 0,
            snapshot_size_sum: 0,
            sample_count: 0,
        }
    }

    pub fn record(&mut self, tracker: &ReloadMetricsTracker, success: bool) {
        self.metrics.total_reloads += 1;

        if success {
            self.metrics.successful_reloads += 1;
        } else {
            self.metrics.failed_reloads += 1;
        }

        // Update running stats
        self.sample_count += 1;

        if let Some(d) = tracker.quiescence_duration {
            let us = d.as_micros() as u64;
            self.quiescence_sum_us += us;
            self.metrics.max_quiescence_time_us = self.metrics.max_quiescence_time_us.max(us);
            self.metrics.avg_quiescence_time_us = self.quiescence_sum_us / self.sample_count;
        }

        if let Some(d) = tracker.snapshot_duration {
            let us = d.as_micros() as u64;
            self.snapshot_sum_us += us;
            self.metrics.max_snapshot_time_us = self.metrics.max_snapshot_time_us.max(us);
            self.metrics.avg_snapshot_time_us = self.snapshot_sum_us / self.sample_count;
        }

        if let Some(d) = tracker.restore_duration {
            let us = d.as_micros() as u64;
            self.restore_sum_us += us;
            self.metrics.max_restore_time_us = self.metrics.max_restore_time_us.max(us);
            self.metrics.avg_restore_time_us = self.restore_sum_us / self.sample_count;
        }

        let total_us = tracker.total_duration().as_micros() as u64;
        self.total_sum_us += total_us;
        self.metrics.max_total_reload_time_us = self.metrics.max_total_reload_time_us.max(total_us);
        self.metrics.avg_total_reload_time_us = self.total_sum_us / self.sample_count;

        if let Some(s) = tracker.snapshot_size {
            self.snapshot_size_sum += s as u64;
            self.metrics.max_snapshot_size_bytes =
                self.metrics.max_snapshot_size_bytes.max(s as u64);
            self.metrics.avg_snapshot_size_bytes = self.snapshot_size_sum / self.sample_count;
            self.metrics.total_bytes_transferred += s as u64;
        }
    }

    pub fn record_fallback(&mut self) {
        self.metrics.fallback_reloads += 1;
    }

    pub fn get_metrics(&self) -> &ReloadMetrics {
        &self.metrics
    }
}

impl Default for MetricsAggregator {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================
// CRASH CLASSIFICATION
// ============================================================

/// Classification of crash reasons
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub enum CrashReason {
    /// Normal exit (not really a crash)
    NormalExit { code: i32 },
    /// Segmentation fault
    Segfault { address: Option<u64> },
    /// Bus error
    BusError,
    /// Floating point exception
    FloatingPointException,
    /// Illegal instruction
    IllegalInstruction,
    /// Abort (usually assertion failure or panic)
    Abort,
    /// Killed by SIGKILL (OOM or timeout)
    Killed,
    /// Terminated by SIGTERM
    Terminated,
    /// Timeout during operation
    Timeout { operation: String, duration_ms: u64 },
    /// IPC protocol error
    IpcError { detail: String },
    /// Module load failure
    ModuleLoadError { detail: String },
    /// State restore failure
    StateRestoreError { detail: String },
    /// Unknown signal
    UnknownSignal { signal: i32 },
    /// Unknown error
    Unknown { detail: String },
}

impl CrashReason {
    /// Create from Unix signal number
    #[cfg(unix)]
    pub fn from_signal(signal: i32) -> Self {
        match signal {
            11 => Self::Segfault { address: None }, // SIGSEGV
            7 => Self::BusError,                    // SIGBUS
            8 => Self::FloatingPointException,      // SIGFPE
            4 => Self::IllegalInstruction,          // SIGILL
            6 => Self::Abort,                       // SIGABRT
            9 => Self::Killed,                      // SIGKILL
            15 => Self::Terminated,                 // SIGTERM
            _ => Self::UnknownSignal { signal },
        }
    }

    /// Create from exit status
    pub fn from_exit_code(code: i32) -> Self {
        Self::NormalExit { code }
    }

    /// Is this a recoverable crash?
    pub fn is_recoverable(&self) -> bool {
        match self {
            Self::NormalExit { code } => *code == 0,
            Self::Timeout { .. } => true,
            Self::IpcError { .. } => true,
            Self::ModuleLoadError { .. } => true,
            Self::StateRestoreError { .. } => true,
            Self::Terminated => true,
            // Memory errors are usually not recoverable without code fix
            Self::Segfault { .. } => false,
            Self::BusError => false,
            Self::FloatingPointException => false,
            Self::IllegalInstruction => false,
            Self::Abort => false,
            Self::Killed => true, // OOM might be transient
            Self::UnknownSignal { .. } => false,
            Self::Unknown { .. } => false,
        }
    }

    /// Get human-readable description
    pub fn description(&self) -> String {
        match self {
            Self::NormalExit { code } => format!("Normal exit with code {}", code),
            Self::Segfault { address } => match address {
                Some(addr) => format!("Segmentation fault at 0x{:x}", addr),
                None => "Segmentation fault".to_string(),
            },
            Self::BusError => "Bus error (misaligned access)".to_string(),
            Self::FloatingPointException => "Floating point exception".to_string(),
            Self::IllegalInstruction => "Illegal instruction".to_string(),
            Self::Abort => "Aborted (assertion/panic)".to_string(),
            Self::Killed => "Killed (SIGKILL - possible OOM)".to_string(),
            Self::Terminated => "Terminated (SIGTERM)".to_string(),
            Self::Timeout {
                operation,
                duration_ms,
            } => {
                format!("Timeout after {}ms during {}", duration_ms, operation)
            }
            Self::IpcError { detail } => format!("IPC error: {}", detail),
            Self::ModuleLoadError { detail } => format!("Module load failed: {}", detail),
            Self::StateRestoreError { detail } => format!("State restore failed: {}", detail),
            Self::UnknownSignal { signal } => format!("Unknown signal {}", signal),
            Self::Unknown { detail } => format!("Unknown error: {}", detail),
        }
    }
}

/// Record of a crash event
#[derive(Debug, Clone, Serialize)]
pub struct CrashEvent {
    pub timestamp: String,
    pub reload_id: Option<ReloadId>,
    pub slot_id: String,
    pub reason: CrashReason,
    pub recoverable: bool,
    pub module_path: Option<PathBuf>,
    pub uptime_secs: u64,
    pub core_dump_path: Option<PathBuf>,
}

impl CrashEvent {
    pub fn new(slot_id: impl Into<String>, reason: CrashReason) -> Self {
        Self {
            timestamp: chrono_timestamp(),
            reload_id: None,
            slot_id: slot_id.into(),
            recoverable: reason.is_recoverable(),
            reason,
            module_path: None,
            uptime_secs: 0,
            core_dump_path: None,
        }
    }

    pub fn with_reload_id(mut self, id: ReloadId) -> Self {
        self.reload_id = Some(id);
        self
    }

    pub fn with_module(mut self, path: PathBuf) -> Self {
        self.module_path = Some(path);
        self
    }

    pub fn with_uptime(mut self, secs: u64) -> Self {
        self.uptime_secs = secs;
        self
    }

    pub fn with_core_dump(mut self, path: PathBuf) -> Self {
        self.core_dump_path = Some(path);
        self
    }

    /// Convert to log entry
    pub fn to_log_entry(&self) -> LogEntry {
        let mut entry = LogEntry::new(LogLevel::Error, "crash", self.reason.description())
            .with_slot_id(&self.slot_id)
            .with_field("recoverable", self.recoverable)
            .with_field("uptime_secs", self.uptime_secs);

        if let Some(ref rid) = self.reload_id {
            entry = entry.with_reload_id(*rid);
        }
        if let Some(ref path) = self.module_path {
            entry = entry.with_field("module", path.display().to_string());
        }
        if let Some(ref path) = self.core_dump_path {
            entry = entry.with_field("core_dump", path.display().to_string());
        }

        entry
    }
}

// ============================================================
// CORE DUMP CAPTURE
// ============================================================

/// Configuration for core dump capture
#[derive(Debug, Clone)]
pub struct CoreDumpConfig {
    /// Whether to capture core dumps
    pub enabled: bool,
    /// Directory to store core dumps
    pub directory: PathBuf,
    /// Maximum number of core dumps to keep
    pub max_dumps: usize,
    /// Maximum size per dump (0 = unlimited)
    pub max_size_bytes: u64,
}

impl Default for CoreDumpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            directory: PathBuf::from("/tmp/synthi-cores"),
            max_dumps: 10,
            max_size_bytes: 512 * 1024 * 1024, // 512 MB
        }
    }
}

/// Manages core dump capture
pub struct CoreDumpManager {
    config: CoreDumpConfig,
}

impl CoreDumpManager {
    pub fn new(config: CoreDumpConfig) -> Self {
        if config.enabled {
            let _ = std::fs::create_dir_all(&config.directory);
        }
        Self { config }
    }

    /// Set up core dump capture for child process
    #[cfg(unix)]
    pub fn setup_for_child(&self) -> std::io::Result<()> {
        if !self.config.enabled {
            return Ok(());
        }

        // Set core dump size limit
        // In real implementation:
        // use nix::sys::resource::{setrlimit, Resource};
        // setrlimit(Resource::RLIMIT_CORE, self.config.max_size_bytes, self.config.max_size_bytes)?;

        eprintln!(
            "[CoreDump] Would enable core dumps up to {} bytes",
            self.config.max_size_bytes
        );

        Ok(())
    }

    /// Check for and collect core dump after crash
    pub fn collect_core_dump(&self, slot_id: &str, pid: u32) -> Option<PathBuf> {
        if !self.config.enabled {
            return None;
        }

        // Look for core dump in common locations
        let potential_paths = [
            PathBuf::from(format!("/tmp/core.{}", pid)),
            PathBuf::from(format!("core.{}", pid)),
            PathBuf::from("core"),
        ];

        for src_path in &potential_paths {
            if src_path.exists() {
                let dest_name = format!(
                    "core-{}-{}-{}.dump",
                    slot_id,
                    pid,
                    chrono_timestamp().replace(':', "-")
                );
                let dest_path = self.config.directory.join(dest_name);

                if let Ok(_) = std::fs::rename(src_path, &dest_path) {
                    self.cleanup_old_dumps();
                    return Some(dest_path);
                }
            }
        }

        None
    }

    /// Remove old core dumps to stay under limit
    fn cleanup_old_dumps(&self) {
        let entries: Vec<_> = std::fs::read_dir(&self.config.directory)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "dump"))
            .collect();

        if entries.len() > self.config.max_dumps {
            // Sort by modification time and remove oldest
            let mut with_times: Vec<_> = entries
                .iter()
                .filter_map(|e| {
                    e.metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .map(|t| (e.path(), t))
                })
                .collect();

            with_times.sort_by_key(|(_, t)| *t);

            for (path, _) in with_times
                .iter()
                .take(entries.len() - self.config.max_dumps)
            {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

// ============================================================
// TRACING SPANS
// ============================================================

/// A tracing span for detailed debugging
#[derive(Debug)]
pub struct Span {
    pub name: &'static str,
    pub reload_id: Option<ReloadId>,
    pub slot_id: Option<String>,
    pub start: Instant,
    pub fields: HashMap<String, String>,
}

impl Span {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            reload_id: None,
            slot_id: None,
            start: Instant::now(),
            fields: HashMap::new(),
        }
    }

    pub fn with_reload_id(mut self, id: ReloadId) -> Self {
        self.reload_id = Some(id);
        self
    }

    pub fn with_slot_id(mut self, id: impl Into<String>) -> Self {
        self.slot_id = Some(id.into());
        self
    }

    pub fn record(&mut self, key: &str, value: impl std::fmt::Display) {
        self.fields.insert(key.to_string(), value.to_string());
    }

    /// End span and return duration
    pub fn end(self) -> Duration {
        let duration = self.start.elapsed();

        // Log the span completion
        let mut msg = format!("Span '{}' completed in {:?}", self.name, duration);
        if !self.fields.is_empty() {
            let fields_str: Vec<String> = self
                .fields
                .iter()
                .map(|(k, v)| format!("{}={}", k, v))
                .collect();
            msg.push_str(&format!(" {{{}}}", fields_str.join(", ")));
        }

        eprintln!("[Trace] {}", msg);

        duration
    }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/// Get current timestamp in ISO 8601 format
fn chrono_timestamp() -> String {
    // Simple implementation without chrono crate
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();

    let secs = now.as_secs();
    let millis = now.subsec_millis();

    // Very basic formatting - in production use chrono
    format!("{}.{:03}Z", secs, millis)
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reload_id_generation() {
        let id1 = ReloadId::new();
        let id2 = ReloadId::new();
        assert_ne!(id1, id2);
        assert!(id2.as_u64() > id1.as_u64());
    }

    #[test]
    fn test_log_entry_formatting() {
        let entry = LogEntry::new(LogLevel::Info, "test", "Test message")
            .with_reload_id(ReloadId(42))
            .with_slot_id("slot-1")
            .with_field("count", 123);

        let json = entry.to_json();
        assert!(json.contains("\"level\":\"info\""));
        assert!(json.contains("\"component\":\"test\""));
        assert!(json.contains("\"message\":\"Test message\""));

        let human = entry.to_human();
        assert!(human.contains("[INFO ]"));
        assert!(human.contains("[test]"));
        assert!(human.contains("reload-0000002a"));
    }

    #[test]
    fn test_crash_reason_classification() {
        let segfault = CrashReason::Segfault {
            address: Some(0xdeadbeef),
        };
        assert!(!segfault.is_recoverable());
        assert!(segfault.description().contains("0xdeadbeef"));

        let timeout = CrashReason::Timeout {
            operation: "quiescence".to_string(),
            duration_ms: 5000,
        };
        assert!(timeout.is_recoverable());
    }

    #[test]
    fn test_metrics_aggregation() {
        let mut aggregator = MetricsAggregator::new();

        let mut tracker1 = ReloadMetricsTracker::start(ReloadId::new(), "slot-1");
        tracker1.record_quiescence(Duration::from_millis(100));
        tracker1.record_snapshot(Duration::from_millis(200), 1000);
        aggregator.record(&tracker1, true);

        let mut tracker2 = ReloadMetricsTracker::start(ReloadId::new(), "slot-1");
        tracker2.record_quiescence(Duration::from_millis(200));
        tracker2.record_snapshot(Duration::from_millis(400), 2000);
        aggregator.record(&tracker2, true);

        let metrics = aggregator.get_metrics();
        assert_eq!(metrics.total_reloads, 2);
        assert_eq!(metrics.successful_reloads, 2);
        assert_eq!(metrics.avg_quiescence_time_us, 150_000); // average of 100ms and 200ms
        assert_eq!(metrics.max_snapshot_size_bytes, 2000);
    }

    #[test]
    fn test_span() {
        let mut span = Span::new("test_operation")
            .with_reload_id(ReloadId(1))
            .with_slot_id("test-slot");

        span.record("items_processed", 42);

        std::thread::sleep(Duration::from_millis(10));
        let duration = span.end();

        assert!(duration >= Duration::from_millis(10));
    }
}
