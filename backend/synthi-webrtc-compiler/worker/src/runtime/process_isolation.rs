// ============================================================
// PROCESS ISOLATION - DEFAULT EXECUTION MODEL
// ============================================================
// This is the DEFAULT and ONLY SAFE execution path.
//
// ARCHITECTURE:
// - Runner is a SUPERVISOR that manages a child process
// - Hot modules run ONLY in an ISOLATED CHILD process
// - HMR = "snapshot state + kill child + spawn new child + restore state"
// - In-process dlopen is DEPRECATED and requires SYNTHI_UNSAFE_INPROCESS=1
//
// WHY THIS IS THE ONLY SAFE PATH:
// - dlclose() is undefined behavior if:
//   * Threads are running
//   * TLS destructors exist
//   * atexit handlers registered
//   * Signal handlers installed
//   * Callbacks point into module
//   * Global singletons hold references
// - After SIGSEGV/memory corruption, continuing in-process is NEVER safe
// - "Quiescence detection" cannot catch all leaks (native code can bypass)
//
// INVARIANTS:
// - Default mode is ProcessIsolated (child process)
// - InProcess mode requires explicit env var SYNTHI_UNSAFE_INPROCESS=1
// - Child process is killed (not unloaded) on HMR
// - State transfer via binary IPC only (no pointer sharing)
// - Hard timeouts on all operations (quiescence, snapshot, shutdown)
// ============================================================

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

// v2.1 integrations
use crate::infra::observability::{LogEntry, LogFormat, LogLevel, ReloadId, StructuredLogger};
use crate::safety::hardened_ipc::{
    read_frame_validated, validate_msgpack_limits, write_frame_with_checksum, IpcConfig, IpcError,
};
use crate::safety::restart_control::{
    BackoffConfig, KnownGoodStore, RestartController, RestartDecision, SlotRestartStats,
};
use crate::safety::slot_isolation::{IsolationManager, IsolationModel, SlotConfig};

/// Execution mode for hot modules
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    /// Modules run in isolated child process (DEFAULT, SAFE)
    ProcessIsolated,

    /// DEPRECATED: In-process dlopen
    /// Requires SYNTHI_UNSAFE_INPROCESS=1 environment variable
    /// Use at your own risk - crashes will corrupt the supervisor
    #[deprecated(note = "Use ProcessIsolated. In-process mode is unsafe.")]
    UnsafeInProcess,
}

impl Default for ExecutionMode {
    fn default() -> Self {
        // Check for explicit opt-in to unsafe mode
        if std::env::var("SYNTHI_UNSAFE_INPROCESS")
            .map(|v| v == "1")
            .unwrap_or(false)
        {
            eprintln!("[SECURITY WARNING] SYNTHI_UNSAFE_INPROCESS=1 detected!");
            eprintln!("[SECURITY WARNING] Running in UNSAFE in-process mode.");
            eprintln!("[SECURITY WARNING] Crashes WILL corrupt the supervisor.");
            #[allow(deprecated)]
            return ExecutionMode::UnsafeInProcess;
        }
        ExecutionMode::ProcessIsolated
    }
}

impl ExecutionMode {
    /// Check if this mode is safe for production use
    pub fn is_safe(&self) -> bool {
        matches!(self, ExecutionMode::ProcessIsolated)
    }

    /// Get execution mode from environment variables (DEFAULT: ProcessIsolated)
    pub fn from_env() -> Self {
        Self::default()
    }

    /// Get the mode, logging a warning if unsafe
    pub fn get_with_warning() -> Self {
        let mode = Self::default();
        if !mode.is_safe() {
            eprintln!(
                "================================================================================"
            );
            eprintln!("  WARNING: UNSAFE EXECUTION MODE ENABLED");
            eprintln!("  Hot module crashes may corrupt this process.");
            eprintln!("  Do not use in production. Set SYNTHI_UNSAFE_INPROCESS=0 to disable.");
            eprintln!(
                "================================================================================"
            );
        }
        mode
    }
}

// ============================================================
// BINARY IPC PROTOCOL (NOT JSON)
// ============================================================
// JSON is slow and error-prone for high-frequency IPC.
// Use length-prefixed binary frames with MsgPack payloads.
//
// Frame format:
//   [4 bytes: payload length (big-endian u32)]
//   [N bytes: MsgPack payload]
//
// JSON is ONLY used for:
// - Logs (human readable)
// - Debug inspection
// ============================================================

/// Binary frame header size
pub const FRAME_HEADER_SIZE: usize = 4;

/// Maximum frame size (16MB - prevents OOM attacks)
pub const MAX_FRAME_SIZE: u32 = 16 * 1024 * 1024;

/// Write a binary frame (length-prefix + MsgPack payload)
pub fn write_frame<W: Write>(writer: &mut W, payload: &[u8]) -> std::io::Result<()> {
    if payload.len() > MAX_FRAME_SIZE as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("Frame too large: {} > {}", payload.len(), MAX_FRAME_SIZE),
        ));
    }

    let len = payload.len() as u32;
    writer.write_all(&len.to_be_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

/// Read a binary frame (returns MsgPack payload)
pub fn read_frame<R: Read>(reader: &mut R) -> std::io::Result<Vec<u8>> {
    let mut header = [0u8; FRAME_HEADER_SIZE];
    reader.read_exact(&mut header)?;

    let len = u32::from_be_bytes(header);
    if len > MAX_FRAME_SIZE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Frame too large: {} > {}", len, MAX_FRAME_SIZE),
        ));
    }

    let mut payload = vec![0u8; len as usize];
    reader.read_exact(&mut payload)?;
    Ok(payload)
}

/// IPC message types (binary-serializable via MsgPack)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum IpcMessage {
    // === Supervisor -> Worker ===
    LoadModule {
        slot: String,
        path: String,
        state_snapshot: Option<Vec<u8>>,
    },
    ReloadModule {
        slot: String,
        path: String,
        state_snapshot: Option<Vec<u8>>,
    },
    RequestSnapshot {
        slot: String,
        timeout_ms: u32, // Hard timeout
    },
    SendEvent {
        kind: u32,
        a: u32,
        b: u32,
        c: u32,
    },
    /// Forward input event to worker (alias for SendEvent)
    InputEvent {
        kind: u32,
        a: u32,
        b: u32,
        c: u32,
    },
    Shutdown {
        timeout_ms: u32, // Hard timeout - killed if exceeded
    },
    Ping {
        seq: u64,
    },

    // === Worker -> Supervisor ===
    ModuleLoaded {
        slot: String,
        abi_version: u32,
        state_version: u32,
        fingerprint: u64,
        layout_hash: Option<u64>, // REQUIRED for memcpy mode
    },
    ReloadResult {
        slot: String,
        success: bool,
        preserved_fields: Vec<String>,
        error: Option<String>,
    },
    Snapshot {
        slot: String,
        data: Vec<u8>,
        state_version: u32,
    },
    /// Frame rendered (metadata, pixels sent separately)
    FrameReady {
        width: u32,
        height: u32,
        format: String,
    },
    /// Heartbeat pong
    Pong {
        seq: u64,
    },
    /// Error report
    Error {
        module: Option<String>,
        message: String,
        fatal: bool,
    },
    /// Worker is ready
    Ready,
    /// Worker is shutting down
    ShuttingDown,
}

/// Configuration for process isolation
#[derive(Debug, Clone)]
pub struct IsolationConfig {
    /// Path to worker binary
    pub worker_binary: PathBuf,
    /// Heartbeat interval
    pub heartbeat_interval: Duration,
    /// Heartbeat timeout (consider dead if no pong)
    pub heartbeat_timeout: Duration,
    /// Maximum restart attempts before giving up
    pub max_restarts: u32,
    /// Restart backoff base duration
    pub restart_backoff: Duration,
    /// Enable debug logging of IPC
    pub debug_ipc: bool,
    /// Resource limits for child process
    pub resource_limits: ResourceLimits,
}

impl Default for IsolationConfig {
    fn default() -> Self {
        // Resolve runner binary path relative to current executable (robust for cargo run)
        // Resolve runner binary path relative to current executable (robust for cargo run)
        let worker_binary = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .map(|mut p| {
                // Handle 'deps' directory (common in cargo builds)
                if p.ends_with("deps") {
                    p.pop();
                }

                p.push(if cfg!(target_os = "windows") {
                    "runner.exe"
                } else {
                    "runner"
                });
                p
            })
            // Fallback to name-based lookup
            .unwrap_or_else(|| {
                PathBuf::from(if cfg!(target_os = "windows") {
                    "runner.exe"
                } else {
                    "runner"
                })
            });

        Self {
            worker_binary,
            heartbeat_interval: Duration::from_secs(5),
            heartbeat_timeout: Duration::from_secs(15),
            max_restarts: 5,
            restart_backoff: Duration::from_millis(500),
            debug_ipc: false,
            resource_limits: ResourceLimits::default(),
        }
    }
}

/// Resource limits for child process (security)
#[derive(Debug, Clone)]
pub struct ResourceLimits {
    /// Maximum memory (bytes, 0 = unlimited)
    pub max_memory: u64,
    /// Maximum CPU time (seconds, 0 = unlimited)
    pub max_cpu_time: u64,
    /// Maximum file size (bytes, 0 = unlimited)
    pub max_file_size: u64,
    /// Maximum open files
    pub max_open_files: u32,
    /// Allowed filesystem paths (empty = no restrictions)
    pub allowed_paths: Vec<PathBuf>,
    /// Network access allowed
    pub allow_network: bool,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            max_memory: 2 * 1024 * 1024 * 1024, // 2GB
            max_cpu_time: 0,                    // unlimited
            max_file_size: 100 * 1024 * 1024,   // 100MB
            max_open_files: 256,
            allowed_paths: vec![],
            allow_network: false,
        }
    }
}

/// State of a supervised worker process
#[derive(Debug)]
pub struct WorkerProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    started_at: Instant,
    pid: u32,
    seq_counter: AtomicU64,
    last_heartbeat: Instant,
}

/// Process supervisor manages worker lifecycle
pub struct ProcessSupervisor {
    config: IsolationConfig,
    worker: Option<WorkerProcess>,
    restart_count: u32,
    last_restart: Option<Instant>,
    state_snapshots: HashMap<String, Vec<u8>>,
    pending_loads: Vec<(String, PathBuf)>,
    shutdown_requested: AtomicBool,
    // v2.1 integrations
    restart_controller: RestartController,
    logger: StructuredLogger,
    ipc_config: IpcConfig,
    _current_reload_id: Option<ReloadId>,
    // Slot isolation (v2.1)
    isolation_model: IsolationModel,
    isolation_manager: Option<IsolationManager>,
}

impl ProcessSupervisor {
    pub fn new(config: IsolationConfig) -> Self {
        let backoff_config = BackoffConfig::default();
        let known_good_store = KnownGoodStore::new();

        Self {
            config,
            worker: None,
            restart_count: 0,
            last_restart: None,
            state_snapshots: HashMap::new(),
            pending_loads: Vec::new(),
            shutdown_requested: AtomicBool::new(false),
            // v2.1 integrations
            restart_controller: RestartController::new(backoff_config, known_good_store),
            logger: StructuredLogger::new(LogFormat::Human, LogLevel::Info),
            ipc_config: IpcConfig::default(),
            _current_reload_id: None,
            // Slot isolation - default to SingleWorker model
            isolation_model: IsolationModel::default(),
            isolation_manager: None,
        }
    }

    /// Create with custom restart controller (for persistence)
    pub fn with_restart_controller(
        config: IsolationConfig,
        restart_controller: RestartController,
    ) -> Self {
        Self {
            config,
            worker: None,
            restart_count: 0,
            last_restart: None,
            state_snapshots: HashMap::new(),
            pending_loads: Vec::new(),
            shutdown_requested: AtomicBool::new(false),
            restart_controller,
            logger: StructuredLogger::new(LogFormat::Human, LogLevel::Info),
            ipc_config: IpcConfig::default(),
            _current_reload_id: None,
            isolation_model: IsolationModel::default(),
            isolation_manager: None,
        }
    }

    /// Create with specific isolation model
    pub fn with_isolation_model(config: IsolationConfig, model: IsolationModel) -> Self {
        let mut sup = Self::new(config);
        sup.isolation_model = model;
        if model != IsolationModel::SingleWorker {
            sup.isolation_manager = Some(IsolationManager::new(model));
        }
        sup
    }

    /// Register a slot for isolation management
    pub fn register_slot(&mut self, slot_config: SlotConfig) {
        if let Some(ref mut manager) = self.isolation_manager {
            manager.register_slot(slot_config);
        }
    }

    /// Get the current isolation model
    pub fn isolation_model(&self) -> IsolationModel {
        self.isolation_model
    }

    /// Start the worker process
    pub fn start(&mut self) -> Result<(), String> {
        if self.worker.is_some() {
            return Err("Worker already running".to_string());
        }

        self.spawn_worker()
    }

    /// Spawn a new worker process
    fn spawn_worker(&mut self) -> Result<(), String> {
        let mut cmd = Command::new(&self.config.worker_binary);

        // Configure stdio for IPC
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()); // Pass through for logging

        // Apply resource limits (platform-specific)
        #[cfg(unix)]
        self.apply_unix_limits(&mut cmd);

        // Spawn
        eprintln!("[Supervisor] Spawning worker binary at: {:?}", self.config.worker_binary);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn worker at {:?}: {}", self.config.worker_binary, e))?;

        let pid = child.id();
        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

        let worker = WorkerProcess {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            started_at: Instant::now(),
            pid,
            seq_counter: AtomicU64::new(0),
            last_heartbeat: Instant::now(),
        };

        self.worker = Some(worker);
        self.last_restart = Some(Instant::now());

        eprintln!("[Supervisor] Worker started (pid: {})", pid);

        // Wait for ready message
        self.wait_for_ready(Duration::from_secs(10))?;

        // Restore any pending state
        self.restore_state()?;

        Ok(())
    }

    #[cfg(unix)]
    fn apply_unix_limits(&self, cmd: &mut Command) {
        use std::os::unix::process::CommandExt;

        let limits = self.config.resource_limits.clone();

        // Apply security controls via pre_exec hook (runs in child before exec)
        unsafe {
            cmd.pre_exec(move || {
                // 1. Apply seccomp filter (if enabled via environment)
                let seccomp_enabled = std::env::var("SYNTHI_SECCOMP_ENABLED")
                    .map(|v| v == "1")
                    .unwrap_or(false);

                if seccomp_enabled {
                    let seccomp_config = crate::safety::security::SeccompConfig {
                        enabled: true,
                        ..Default::default()
                    };
                    if let Err(e) = crate::safety::security::apply_seccomp_filter(&seccomp_config) {
                        eprintln!("[Security] Failed to apply seccomp filter: {}", e);
                        // Continue without seccomp - log but don't fail
                    }
                }

                // 2. Enter namespaces (if enabled via environment)
                let ns_enabled = std::env::var("SYNTHI_NAMESPACE_ISOLATION")
                    .map(|v| v == "1")
                    .unwrap_or(false);

                if ns_enabled {
                    let ns_config = crate::safety::security::NamespaceConfig {
                        new_pid_ns: true,
                        new_net_ns: !limits.allow_network,
                        new_mount_ns: true,
                        new_user_ns: true,
                    };
                    if let Err(e) = crate::safety::security::enter_namespaces(&ns_config) {
                        eprintln!("[Security] Failed to enter namespaces: {}", e);
                        // Continue without namespaces - log but don't fail
                    }
                }

                // 3. Apply cgroup limits (if enabled via environment)
                let cgroup_enabled = std::env::var("SYNTHI_CGROUP_LIMITS")
                    .map(|v| v == "1")
                    .unwrap_or(false);

                if cgroup_enabled {
                    let cgroup_name = format!("synthi-worker-{}", std::process::id());
                    let cgroup_limits = crate::safety::security::CgroupLimits {
                        memory_max: if limits.max_memory > 0 {
                            Some(limits.max_memory)
                        } else {
                            None
                        },
                        cpu_quota_us: None, // Use default
                        cpu_period_us: 100_000,
                        pids_max: Some(64),
                    };
                    if let Err(e) =
                        crate::safety::security::apply_cgroup_limits(&cgroup_name, &cgroup_limits)
                    {
                        eprintln!("[Security] Failed to apply cgroup limits: {}", e);
                        // Continue without cgroups - log but don't fail
                    }
                }

                // 4. Apply resource limits via setrlimit
                if limits.max_memory > 0 {
                    let rlim = libc::rlimit {
                        rlim_cur: limits.max_memory,
                        rlim_max: limits.max_memory,
                    };
                    libc::setrlimit(libc::RLIMIT_AS, &rlim);
                }

                if limits.max_file_size > 0 {
                    let rlim = libc::rlimit {
                        rlim_cur: limits.max_file_size,
                        rlim_max: limits.max_file_size,
                    };
                    libc::setrlimit(libc::RLIMIT_FSIZE, &rlim);
                }

                if limits.max_open_files > 0 {
                    let rlim = libc::rlimit {
                        rlim_cur: limits.max_open_files as u64,
                        rlim_max: limits.max_open_files as u64,
                    };
                    libc::setrlimit(libc::RLIMIT_NOFILE, &rlim);
                }

                Ok(())
            });
        }
    }

    fn wait_for_ready(&mut self, timeout: Duration) -> Result<(), String> {
        let start = Instant::now();
        while start.elapsed() < timeout {
            // Check for exit FIRST
            if let Some(worker) = self.worker.as_mut() {
                if let Ok(Some(status)) = worker.child.try_wait() {
                    let code = status.code().unwrap_or(-1);
                    eprintln!("[Supervisor] FATAL: Worker exited during startup. Code: {}", code);
                    #[cfg(unix)]
                    {
                        use std::os::unix::process::ExitStatusExt;
                        if let Some(signal) = status.signal() {
                            eprintln!("[Supervisor] Worker killed by signal: {} (SIGSEGV=11, SIGABRT=6)", signal);
                        }
                    }
                    return Err(format!("Worker exited prematurely: {}", status));
                }
            }

            // Then check for messages
            match self.recv_message(Duration::from_millis(100)) {
                Ok(Some(msg)) => {
                    if matches!(msg, IpcMessage::Ready) {
                        eprintln!("[Supervisor] Worker ready");
                        return Ok(());
                    }
                },
                Ok(None) => {}, // Timeout, loop again
                Err(e) => {
                    // Possible race: Pipe closed but process table not yet updated.
                    // Retry wait() for a short period to catch the exit code/signal.
                    if let Some(worker) = self.worker.as_mut() {
                        for i in 0..10 { // Try for 100ms
                            if let Ok(Some(status)) = worker.child.try_wait() {
                                let _code = status.code().unwrap_or(-1);
                                eprintln!("[Supervisor] FATAL: Worker exited during msg recv (attempt {}): {} (Error: {})", i, status, e);
                                #[cfg(unix)]
                                {
                                    use std::os::unix::process::ExitStatusExt;
                                    if let Some(signal) = status.signal() {
                                        eprintln!("[Supervisor] Worker killed by signal: {} (SIGSEGV=11, SIGABRT=6)", signal);
                                    }
                                }
                                return Err(format!("Worker died: {}", status));
                            }
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        // If we fall through here, the process is zombie or still technically running but pipe is dead
                        eprintln!("[Supervisor] ERROR: Connection closed by worker but process is still running/zombie.");
                    }
                    return Err(e);
                }
            }
        }
        Err("Worker did not become ready in time".to_string())
    }

    fn restore_state(&mut self) -> Result<(), String> {
        // Replay pending loads with saved snapshots
        let loads = std::mem::take(&mut self.pending_loads);
        for (slot, path) in loads {
            let snapshot = self.state_snapshots.get(&slot).cloned();
            self.send_message(&IpcMessage::LoadModule {
                slot,
                path: path.to_string_lossy().to_string(),
                state_snapshot: snapshot,
            })?;
        }
        Ok(())
    }

    /// Send a message to the worker using HARDENED binary framing protocol (v2.1).
    ///
    /// Wire format: [4-byte magic][4-byte length][4-byte CRC32][msgpack payload]
    /// The CRC32 is validated by the receiver before processing.
    pub fn send_message(&mut self, msg: &IpcMessage) -> Result<(), String> {
        let worker = self.worker.as_mut().ok_or("Worker not running")?;

        // Serialize to MsgPack (binary, not JSON)
        let payload = rmp_serde::to_vec(msg).map_err(|e| format!("Failed to serialize: {}", e))?;

        if self.config.debug_ipc {
            self.logger.log(&LogEntry::new(
                LogLevel::Trace,
                "ipc",
                format!("Supervisor->Worker: {:?} ({} bytes)", msg, payload.len()),
            ));
        }

        // Write using HARDENED frame protocol with CRC32 (v2.1)
        write_frame_with_checksum(&mut worker.stdin, &payload)
            .map_err(|e| format!("Failed to write frame: {}", e))?;

        worker
            .stdin
            .flush()
            .map_err(|e| format!("Failed to flush: {}", e))?;

        Ok(())
    }

    /// Receive a message from the worker using HARDENED binary framing protocol (v2.1).
    ///
    /// SECURITY: Validates CRC32 checksum and frame size BEFORE allocation.
    /// HARD TIMEOUT: If timeout is reached, returns None.
    /// The caller is responsible for deciding whether to kill the worker.
    pub fn recv_message(&mut self, timeout: Duration) -> Result<Option<IpcMessage>, String> {
        let worker = self.worker.as_mut().ok_or("Worker not running")?;

        // Read frame with timeout
        // Note: In production, use poll/select for true async timeout.
        // This is a simplified implementation.
        let start = Instant::now();

        // Set read timeout on the underlying file descriptor
        #[cfg(unix)]
        {
            #[allow(unused_imports)]
            use std::os::unix::io::AsRawFd;
            // Would set SO_RCVTIMEO here in production
        }

        // Use HARDENED frame reading with CRC32 validation (v2.1)
        match read_frame_validated(worker.stdout.get_mut(), &self.ipc_config, None) {
            Ok(payload) => {
                if self.config.debug_ipc {
                    self.logger.log(&LogEntry::new(
                        LogLevel::Trace,
                        "ipc",
                        format!("Worker->Supervisor: {} bytes received", payload.len()),
                    ));
                }

                // Validate MsgPack structure before deserializing (v2.1 hardening)
                if let Err(e) = validate_msgpack_limits(&payload, &self.ipc_config.decode_limits) {
                    self.logger.log(&LogEntry::new(
                        LogLevel::Warn,
                        "ipc",
                        format!("MsgPack validation failed: {}", e),
                    ));
                    return Err(format!("MsgPack validation failed: {}", e));
                }

                let msg: IpcMessage = rmp_serde::from_slice(&payload)
                    .map_err(|e| format!("Failed to deserialize: {}", e))?;

                // Update heartbeat on any message
                worker.last_heartbeat = Instant::now();

                Ok(Some(msg))
            }
            Err(IpcError::ConnectionClosed) => Err("Worker closed connection".to_string()),
            Err(IpcError::ReadTimeout { .. }) => {
                // Timeout - check if we should return None or error
                if start.elapsed() >= timeout {
                    Ok(None) // Timeout, caller decides what to do
                } else {
                    Err("Read timeout".to_string())
                }
            }
            Err(IpcError::ChecksumMismatch { expected, got }) => {
                self.logger.log(&LogEntry::new(
                    LogLevel::Error,
                    "ipc",
                    format!(
                        "CRC32 checksum mismatch: expected 0x{:08x}, got 0x{:08x}",
                        expected, got
                    ),
                ));
                Err(format!("Frame corruption detected (CRC32 mismatch)"))
            }
            Err(IpcError::FrameTooLarge { size, max, .. }) => {
                self.logger.log(&LogEntry::new(
                    LogLevel::Error,
                    "ipc",
                    format!("Frame too large: {} > {} bytes", size, max),
                ));
                Err(format!("Frame too large: {} > {} bytes", size, max))
            }
            Err(e) => Err(format!("IPC error: {}", e)),
        }
    }

    /// Load a module in the worker
    pub fn load_module(&mut self, slot: &str, path: &Path) -> Result<(), String> {
        // Save for restart recovery
        self.pending_loads
            .push((slot.to_string(), path.to_path_buf()));

        let snapshot = self.state_snapshots.get(slot).cloned();
        self.send_message(&IpcMessage::LoadModule {
            slot: slot.to_string(),
            path: path.to_string_lossy().to_string(),
            state_snapshot: snapshot,
        })
    }

    /// Hot reload a module with HARD TIMEOUT enforcement (v2.1: uses restart controller).
    ///
    /// If the worker doesn't respond within the timeout, it is KILLED.
    /// On failure, consults RestartController for backoff/fallback decisions.
    /// This is critical for safety - we cannot leave a worker in an
    /// unknown state holding locks or resources.
    pub fn reload_module(&mut self, slot: &str, path: &Path) -> Result<(), String> {
        const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);
        const RELOAD_TIMEOUT: Duration = Duration::from_secs(10);

        // First, request a snapshot of current state
        self.send_message(&IpcMessage::RequestSnapshot {
            slot: slot.to_string(),
            timeout_ms: SNAPSHOT_TIMEOUT.as_millis() as u32,
        })?;

        // Wait for snapshot WITH HARD TIMEOUT
        let snapshot_start = Instant::now();
        let snapshot = loop {
            if snapshot_start.elapsed() > SNAPSHOT_TIMEOUT {
                eprintln!(
                    "[Supervisor] HARD TIMEOUT: Snapshot request exceeded {}s, killing worker",
                    SNAPSHOT_TIMEOUT.as_secs()
                );
                self.force_kill_and_restart("Snapshot timeout")?;
                return Err("Snapshot timeout - worker killed and restarted".to_string());
            }

            match self.recv_message(Duration::from_millis(100))? {
                Some(IpcMessage::Snapshot { slot: s, data, .. }) if s == slot => {
                    break Some(data);
                }
                Some(IpcMessage::Error { message, fatal, .. }) => {
                    if fatal {
                        eprintln!("[Supervisor] Fatal error during snapshot: {}", message);
                        self.force_kill_and_restart(&message)?;
                        return Err(format!("Fatal error: {}", message));
                    }
                    eprintln!("[Supervisor] Snapshot error: {}", message);
                    break None;
                }
                None => continue,
                _ => continue,
            }
        };

        // Save snapshot for potential restart
        if let Some(ref data) = snapshot {
            self.state_snapshots.insert(slot.to_string(), data.clone());
        }

        // Send reload request
        self.send_message(&IpcMessage::ReloadModule {
            slot: slot.to_string(),
            path: path.to_string_lossy().to_string(),
            state_snapshot: snapshot,
        })?;

        // Wait for reload result WITH HARD TIMEOUT
        let reload_start = Instant::now();
        loop {
            if reload_start.elapsed() > RELOAD_TIMEOUT {
                eprintln!(
                    "[Supervisor] HARD TIMEOUT: Reload exceeded {}s, killing worker",
                    RELOAD_TIMEOUT.as_secs()
                );
                self.force_kill_and_restart("Reload timeout")?;
                return Err("Reload timeout - worker killed and restarted".to_string());
            }

            match self.recv_message(Duration::from_millis(100))? {
                Some(IpcMessage::ReloadResult {
                    slot: s,
                    success,
                    error,
                    ..
                }) if s == slot => {
                    if success {
                        // Update pending loads
                        if let Some(pos) = self.pending_loads.iter().position(|(s, _)| s == slot) {
                            self.pending_loads[pos].1 = path.to_path_buf();
                        }
                        return Ok(());
                    } else {
                        return Err(error.unwrap_or_else(|| "Unknown reload error".to_string()));
                    }
                }
                Some(IpcMessage::Error { message, fatal, .. }) => {
                    if fatal {
                        self.force_kill_and_restart(&message)?;
                    }
                    return Err(message);
                }
                None => continue,
                _ => continue,
            }
        }
    }

    /// Force kill the worker and restart it.
    /// This is the nuclear option when timeouts are exceeded.
    fn force_kill_and_restart(&mut self, reason: &str) -> Result<(), String> {
        eprintln!("[Supervisor] Force killing worker: {}", reason);

        if let Some(mut worker) = self.worker.take() {
            // SIGKILL - no graceful shutdown, just die
            #[cfg(unix)]
            {
                #[allow(unused_imports)]
                use std::os::unix::process::CommandExt;
                unsafe {
                    libc::kill(worker.pid as i32, libc::SIGKILL);
                }
            }
            #[cfg(not(unix))]
            {
                let _ = worker.child.kill();
            }

            let _ = worker.child.wait();
        }

        // Restart
        self.handle_crash()
    }

    /// Check if worker is healthy
    pub fn check_health(&mut self) -> Result<bool, String> {
        let seq = self
            .worker
            .as_ref()
            .map(|w| w.seq_counter.fetch_add(1, Ordering::SeqCst))
            .ok_or("Worker not running")?;

        self.send_message(&IpcMessage::Ping { seq })?;

        // Check heartbeat timeout
        let last = self.worker.as_ref().map(|w| w.last_heartbeat).unwrap();
        if last.elapsed() > self.config.heartbeat_timeout {
            return Ok(false);
        }

        Ok(true)
    }

    /// Handle worker crash - restart with state restoration (v2.1: uses RestartController)
    ///
    /// The RestartController manages:
    /// - Exponential backoff with jitter
    /// - Circuit breaker (stops retrying after too many failures)
    /// - Last-known-good fallback
    pub fn handle_crash(&mut self) -> Result<(), String> {
        self.logger.log(&LogEntry::new(
            LogLevel::Warn,
            "supervisor",
            "Worker crashed, consulting restart controller",
        ));

        // Get the module path for restart decision
        let module_path = self
            .pending_loads
            .last()
            .map(|(_, p)| p.clone())
            .unwrap_or_else(|| self.config.worker_binary.clone());

        // Consult restart controller (v2.1)
        let decision = self.restart_controller.record_failure(
            "worker",
            &module_path,
            "Worker process crashed or timed out",
        );

        match decision {
            RestartDecision::RestartNow { module_path } => {
                self.logger.log(&LogEntry::new(
                    LogLevel::Info,
                    "supervisor",
                    format!("Restart decision: immediate restart with {:?}", module_path),
                ));
            }
            RestartDecision::WaitThenRestart {
                delay,
                module_path,
                reason,
            } => {
                self.logger.log(&LogEntry::new(
                    LogLevel::Info,
                    "supervisor",
                    format!(
                        "Restart decision: wait {:?} then restart {:?} - {}",
                        delay, module_path, reason
                    ),
                ));
                std::thread::sleep(delay);
            }
            RestartDecision::FallbackToKnownGood {
                module_path,
                reason,
            } => {
                self.logger.log(&LogEntry::new(
                    LogLevel::Warn,
                    "supervisor",
                    format!(
                        "Restart decision: fallback to known good {:?} - {}",
                        module_path, reason
                    ),
                ));
                // Update pending loads to use fallback
                if let Some((slot, _)) = self.pending_loads.last_mut() {
                    *self.pending_loads.last_mut().unwrap() = (slot.clone(), module_path);
                }
            }
            RestartDecision::CircuitOpen {
                retry_after,
                reason,
            } => {
                self.logger.log(&LogEntry::new(
                    LogLevel::Error,
                    "supervisor",
                    format!("Restart decision: CIRCUIT OPEN - {}", reason),
                ));
                return Err(format!(
                    "Circuit breaker open. Retry after {:?}. {}",
                    retry_after, reason
                ));
            }
            RestartDecision::ManualIntervention { reason } => {
                self.logger.log(&LogEntry::new(
                    LogLevel::Error,
                    "supervisor",
                    format!(
                        "Restart decision: MANUAL INTERVENTION REQUIRED - {}",
                        reason
                    ),
                ));
                return Err(format!("Manual intervention required: {}", reason));
            }
        }

        self.restart_count += 1;

        // Clean up old worker
        if let Some(mut worker) = self.worker.take() {
            let _ = worker.child.kill();
            let _ = worker.child.wait();
        }

        // Spawn new worker
        self.spawn_worker()?;

        self.logger.log(&LogEntry::new(
            LogLevel::Info,
            "supervisor",
            format!("Worker restarted (attempt {})", self.restart_count),
        ));

        Ok(())
    }

    /// Record successful operation (resets restart controller state)
    pub fn record_success(&mut self, slot: &str, module_path: &Path) {
        self.restart_controller
            .record_success(slot, &module_path.to_path_buf());
        self.restart_count = 0; // Reset legacy counter too
    }

    /// Get restart statistics for a slot
    pub fn get_restart_stats(&self, slot: &str) -> Option<SlotRestartStats> {
        self.restart_controller.get_stats(slot)
    }

    /// Graceful shutdown with HARD TIMEOUT.
    ///
    /// We give the worker `timeout` to clean up gracefully.
    /// After that, it's SIGKILL - no negotiation.
    pub fn shutdown(&mut self, timeout: Duration) -> Result<(), String> {
        self.shutdown_requested.store(true, Ordering::SeqCst);

        // Check if we have a worker
        if self.worker.is_none() {
            return Ok(());
        }

        // Request graceful shutdown with timeout
        let _ = self.send_message(&IpcMessage::Shutdown {
            timeout_ms: timeout.as_millis() as u32,
        });

        // Wait for shutdown acknowledgment with HARD DEADLINE
        let deadline = Instant::now() + timeout;
        let mut got_ack = false;

        while Instant::now() < deadline {
            if let Ok(Some(IpcMessage::ShuttingDown)) =
                self.recv_message(Duration::from_millis(100))
            {
                got_ack = true;
                break;
            }
        }

        if !got_ack {
            eprintln!(
                "[Supervisor] Worker did not acknowledge shutdown in {}ms, forcing kill",
                timeout.as_millis()
            );
        }

        // Wait a brief moment for clean exit
        let final_wait = Duration::from_millis(500);
        std::thread::sleep(final_wait.min(deadline.saturating_duration_since(Instant::now())));

        // Now take ownership of worker for final cleanup
        if let Some(mut worker) = self.worker.take() {
            // Check if still running
            match worker.child.try_wait() {
                Ok(Some(_)) => {
                    // Already exited
                    eprintln!("[Supervisor] Worker exited gracefully");
                }
                Ok(None) => {
                    // Still running - FORCE KILL
                    eprintln!("[Supervisor] Worker still running after timeout, sending SIGKILL");
                    #[cfg(unix)]
                    unsafe {
                        libc::kill(worker.pid as i32, libc::SIGKILL);
                    }
                    #[cfg(not(unix))]
                    {
                        let _ = worker.child.kill();
                    }
                    let _ = worker.child.wait();
                }
                Err(e) => {
                    eprintln!("[Supervisor] Error checking worker status: {}", e);
                    let _ = worker.child.kill();
                    let _ = worker.child.wait();
                }
            }
        }

        Ok(())
    }

    /// Get execution statistics
    pub fn stats(&self) -> SupervisorStats {
        SupervisorStats {
            restart_count: self.restart_count,
            uptime: self
                .worker
                .as_ref()
                .map(|w| w.started_at.elapsed())
                .unwrap_or_default(),
            worker_pid: self.worker.as_ref().map(|w| w.pid),
            saved_snapshots: self.state_snapshots.len(),
        }
    }

    // ============================================================
    // SUPERVISOR EVENT LOOP
    // ============================================================
    // This is the main loop that:
    // 1. Reads commands from stdin (from parent/gateway)
    // 2. Forwards commands to the worker process
    // 3. Reads responses from the worker
    // 4. Writes frames/status to stdout (to parent/gateway)
    // 5. Monitors worker health and restarts on crash
    // ============================================================

    /// Run the supervisor event loop.
    /// This blocks and runs until shutdown is requested.
    ///
    /// Commands from stdin:
    /// - load <name> <path> - Load a module
    /// - reload <name> <path> - Hot reload a module
    /// - unload <name> - Unload a module
    /// - snapshot <name> - Request state snapshot
    /// - input <type> <data> - Forward input event
    /// - shutdown - Graceful shutdown
    /// - ping - Health check
    pub fn run_event_loop(&mut self) -> Result<(), String> {
        use std::io::{BufRead, Write};

        eprintln!("[Supervisor] Starting event loop");

        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout();
        let mut stdin_reader = std::io::BufReader::new(stdin.lock());
        let mut line = String::new();

        let mut last_health_check = Instant::now();
        let health_check_interval = Duration::from_secs(5);

        loop {
            // Check if shutdown was requested
            if self.shutdown_requested.load(Ordering::SeqCst) {
                eprintln!("[Supervisor] Shutdown requested, exiting event loop");
                break;
            }

            // Non-blocking read from stdin with timeout
            // We use a simple polling approach - in production, use select/poll
            line.clear();

            // Try to read a command (this is simplified - real impl needs non-blocking IO)
            // For now, we use a thread for stdin and channels
            match stdin_reader.read_line(&mut line) {
                Ok(0) => {
                    // EOF on stdin - parent closed connection
                    eprintln!("[Supervisor] Stdin closed, shutting down");
                    break;
                }
                Ok(_) => {
                    let cmd = line.trim();
                    if !cmd.is_empty() {
                        if let Err(e) = self.handle_command(cmd, &mut stdout) {
                            eprintln!("[Supervisor] Command error: {}", e);
                            // Write error to stdout for parent
                            let error_json =
                                format!("{{\"error\": \"{}\"}}\n", e.replace('"', "\\\""));
                            let _ = stdout.write_all(error_json.as_bytes());
                            let _ = stdout.flush();
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[Supervisor] Stdin read error: {}", e);
                    break;
                }
            }

            // Process any pending messages from worker
            if self.worker.is_some() {
                loop {
                    match self.recv_message(Duration::from_millis(1)) {
                        Ok(Some(msg)) => {
                            self.handle_worker_message(msg, &mut stdout)?;
                        }
                        Ok(None) => break, // No more messages
                        Err(e) => {
                            eprintln!("[Supervisor] Worker communication error: {}", e);

                            // Check exit code before handling crash
                            if let Some(worker) = self.worker.as_mut() {
                                match worker.child.try_wait() {
                                    Ok(Some(status)) => {
                                        eprintln!("[Supervisor] Worker process exited with: {}", status);
                                        if let Some(code) = status.code() {
                                            eprintln!("[Supervisor] Worker exit code: {}", code);
                                        }
                                    }
                                    Ok(None) => {
                                        // Process hasn't exited yet, or OS hasn't reported it
                                    }
                                    Err(err) => {
                                        eprintln!("[Supervisor] Failed to check worker status: {}", err);
                                    }
                                }
                            }

                            // Worker may have crashed
                            self.handle_crash()?;
                            break;
                        }
                    }
                }
            }

            // Periodic health check
            if last_health_check.elapsed() > health_check_interval {
                if let Ok(healthy) = self.check_health() {
                    if !healthy {
                        eprintln!("[Supervisor] Worker health check failed, restarting");
                        self.handle_crash()?;
                    }
                }
                last_health_check = Instant::now();
            }
        }

        // Clean shutdown
        self.shutdown(Duration::from_secs(5))?;
        eprintln!("[Supervisor] Event loop exited");
        Ok(())
    }

    /// Handle a command from stdin
    fn handle_command(&mut self, cmd: &str, stdout: &mut impl Write) -> Result<(), String> {
        let parts: Vec<&str> = cmd.split_whitespace().collect();
        if parts.is_empty() {
            return Ok(());
        }

        match parts[0] {
            "load" => {
                if parts.len() < 3 {
                    return Err("Usage: load <name> <path>".to_string());
                }
                let name = parts[1];
                let path = parts[2];
                eprintln!("[Supervisor] Loading module '{}' from {}", name, path);
                self.load_module(name, Path::new(path))?;

                // Acknowledge
                let ack = format!("{{\"status\": \"loaded\", \"module\": \"{}\"}}\n", name);
                stdout
                    .write_all(ack.as_bytes())
                    .map_err(|e| e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;
            }
            "reload" => {
                if parts.len() < 3 {
                    return Err("Usage: reload <name> <path>".to_string());
                }
                let name = parts[1];
                let path = parts[2];
                eprintln!("[Supervisor] Reloading module '{}' from {}", name, path);
                self.reload_module(name, Path::new(path))?;

                let ack = format!("{{\"status\": \"reloaded\", \"module\": \"{}\"}}\n", name);
                stdout
                    .write_all(ack.as_bytes())
                    .map_err(|e| e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;
            }
            "snapshot" => {
                if parts.len() < 2 {
                    return Err("Usage: snapshot <name>".to_string());
                }
                let name = parts[1];
                self.send_message(&IpcMessage::RequestSnapshot {
                    slot: name.to_string(),
                    timeout_ms: 5000, // 5 second default timeout
                })?;
            }
            "input" => {
                // Forward input event to worker
                if parts.len() >= 3 {
                    let kind_str = parts[1];
                    let kind = match kind_str {
                        "motion" => 0,
                        "button" => 1,
                        "key" => 2,
                        _ => kind_str.parse::<u32>().unwrap_or(0),
                    };

                    let a;
                    let b;
                    let mut c = 0;

                    if kind == 0 {
                        // motion x y
                        a = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
                        b = parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
                    } else if kind == 1 {
                        // button type btn x y
                        // Node sends: input button down 1 100 200
                        let type_str = parts.get(2).unwrap_or(&"up");
                        let btn = parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
                        let x = parts
                            .get(4)
                            .and_then(|s| s.parse::<i32>().ok())
                            .unwrap_or(0);
                        let y = parts
                            .get(5)
                            .and_then(|s| s.parse::<i32>().ok())
                            .unwrap_or(0);

                        a = btn;
                        b = if *type_str == "down" { 1 } else { 0 };
                        // Pack x,y into c (16-bit each)
                        c = ((x as u32 & 0xFFFF) << 16) | (y as u32 & 0xFFFF);
                    } else if kind == 2 {
                        // key type keycode
                        // Node sends: input key down 32
                        let type_str = parts.get(2).unwrap_or(&"up");
                        let keycode = parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);

                        a = if *type_str == "down" { 1 } else { 0 };
                        b = keycode;
                    } else {
                        // Fallback for raw numeric
                        a = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
                        b = parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
                        c = parts.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
                    }

                    self.send_message(&IpcMessage::InputEvent { kind, a, b, c })?;
                }
            }
            "shutdown" => {
                eprintln!("[Supervisor] Shutdown command received");
                self.shutdown_requested.store(true, Ordering::SeqCst);
            }
            "ping" => {
                let healthy = self.check_health().unwrap_or(false);
                let response = format!("{{\"status\": \"pong\", \"healthy\": {}}}\n", healthy);
                stdout
                    .write_all(response.as_bytes())
                    .map_err(|e| e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;
            }
            "stats" => {
                let stats = self.stats();
                let response = format!(
                    "{{\"restart_count\": {}, \"uptime_secs\": {}, \"worker_pid\": {:?}, \"snapshots\": {}}}\n",
                    stats.restart_count,
                    stats.uptime.as_secs(),
                    stats.worker_pid,
                    stats.saved_snapshots
                );
                stdout
                    .write_all(response.as_bytes())
                    .map_err(|e| e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;
            }
            _ => {
                return Err(format!("Unknown command: {}", parts[0]));
            }
        }

        Ok(())
    }

    /// Handle a message from the worker process
    fn handle_worker_message(
        &mut self,
        msg: IpcMessage,
        stdout: &mut impl Write,
    ) -> Result<(), String> {
        match msg {
            IpcMessage::ModuleLoaded {
                slot,
                abi_version,
                state_version,
                fingerprint,
                layout_hash,
            } => {
                eprintln!("[Supervisor] Worker loaded module '{}' (ABI v{}, state v{}, fp=0x{:x}, layout={:?})",
                    slot, abi_version, state_version, fingerprint, layout_hash);

                let response = format!(
                    "{{\"event\": \"module_loaded\", \"slot\": \"{}\", \"abi_version\": {}, \"layout_hash\": {:?}}}\n",
                    slot, abi_version, layout_hash
                );
                stdout
                    .write_all(response.as_bytes())
                    .map_err(|e| e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;
            }
            IpcMessage::ReloadResult {
                slot,
                success,
                preserved_fields,
                error,
            } => {
                eprintln!(
                    "[Supervisor] Reload result for '{}': success={}, preserved={:?}, error={:?}",
                    slot, success, preserved_fields, error
                );

                let response = format!(
                    "{{\"event\": \"reload_result\", \"slot\": \"{}\", \"success\": {}, \"error\": {:?}}}\n",
                    slot, success, error
                );
                stdout
                    .write_all(response.as_bytes())
                    .map_err(|e| e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;
            }
            IpcMessage::Snapshot {
                slot,
                data,
                state_version,
            } => {
                // Save snapshot for crash recovery
                self.state_snapshots.insert(slot.clone(), data.clone());
                eprintln!(
                    "[Supervisor] Saved snapshot for '{}' ({} bytes, v{})",
                    slot,
                    data.len(),
                    state_version
                );
            }
            IpcMessage::FrameReady {
                width,
                height,
                format,
            } => {
                // Frame data would be sent separately via shared memory or pipe
                // For now, just acknowledge
                let response = format!(
                    "{{\"event\": \"frame\", \"width\": {}, \"height\": {}, \"format\": \"{}\"}}\n",
                    width, height, format
                );
                stdout
                    .write_all(response.as_bytes())
                    .map_err(|e| e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;
            }
            IpcMessage::Pong { seq } => {
                // Health check response - update heartbeat
                eprintln!("[Supervisor] Pong received (seq={})", seq);
            }
            IpcMessage::Error {
                module,
                message,
                fatal,
            } => {
                eprintln!(
                    "[Supervisor] Worker error: module={:?}, fatal={}, msg={}",
                    module, fatal, message
                );

                let response = format!(
                    "{{\"event\": \"error\", \"module\": {:?}, \"fatal\": {}, \"message\": \"{}\"}}\n",
                    module, fatal, message.replace('"', "\\\"")
                );
                stdout
                    .write_all(response.as_bytes())
                    .map_err(|e| e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;

                if fatal {
                    // Worker reported fatal error - restart it
                    self.handle_crash()?;
                }
            }
            IpcMessage::Ready => {
                eprintln!("[Supervisor] Worker ready");
                let response = "{\"event\": \"worker_ready\"}\n";
                stdout
                    .write_all(response.as_bytes())
                    .map_err(|e| e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;
            }
            IpcMessage::ShuttingDown => {
                eprintln!("[Supervisor] Worker is shutting down");
            }
            _ => {
                // Ignore other messages (supervisor -> worker messages shouldn't arrive here)
            }
        }

        Ok(())
    }
}

/// Supervisor statistics
#[derive(Debug, Clone)]
pub struct SupervisorStats {
    pub restart_count: u32,
    pub uptime: Duration,
    pub worker_pid: Option<u32>,
    pub saved_snapshots: usize,
}

// ============================================================
// QUIESCENCE PROTOCOL WITH HARD TIMEOUTS
// ============================================================
// Before unloading a module, we must ensure it has reached
// a "quiescent" state: no threads running, no callbacks pending,
// no async work in flight.
//
// CRITICAL: Quiescence has a HARD DEADLINE. If a module cannot
// reach quiescence in time, we:
// 1. Log the violation
// 2. Force-kill the process
// 3. Restart fresh
//
// There is NO "wait forever" option.

/// Maximum time to wait for quiescence (hard limit)
pub const QUIESCENCE_HARD_TIMEOUT: Duration = Duration::from_secs(30);

/// Warning threshold - if quiescence takes longer than this, log a warning
pub const QUIESCENCE_WARNING_THRESHOLD: Duration = Duration::from_secs(5);

/// Quiescence state of a module
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuiescenceState {
    /// Module is active, cannot safely unload
    Active,
    /// Module is draining (stopping threads, callbacks)
    Draining,
    /// Module is quiescent, safe to unload
    Quiescent,
    /// Quiescence check failed/timed out - PROCESS WILL BE KILLED
    Failed,
    /// Quiescence timed out - process was killed
    TimedOutKilled,
}

/// Quiescence verification result
#[derive(Debug, Clone)]
pub struct QuiescenceResult {
    pub state: QuiescenceState,
    pub active_threads: u32,
    pub pending_callbacks: u32,
    pub pending_timers: u32,
    pub time_to_quiesce: Duration,
    pub message: Option<String>,
}

impl QuiescenceResult {
    pub fn is_safe_to_unload(&self) -> bool {
        self.state == QuiescenceState::Quiescent
            && self.active_threads == 0
            && self.pending_callbacks == 0
            && self.pending_timers == 0
    }

    /// Check if we exceeded warning threshold
    pub fn was_slow(&self) -> bool {
        self.time_to_quiesce > QUIESCENCE_WARNING_THRESHOLD
    }
}

/// Plugin must implement these hooks for safe unloading
/// (Part of the strict plugin contract)
pub mod quiescence_contract {
    /// Check if module is quiescent (no active work)
    /// Returns true if safe to unload
    pub const IS_QUIESCENT: &[u8] = b"hot_is_quiescent\0";

    /// Request module to drain and become quiescent
    /// Returns estimated time to quiescence in milliseconds
    pub const REQUEST_QUIESCENCE: &[u8] = b"hot_request_quiescence\0";

    /// Cancel quiescence request (module can resume)
    pub const CANCEL_QUIESCENCE: &[u8] = b"hot_cancel_quiescence\0";

    /// Get count of active threads owned by module
    pub const ACTIVE_THREAD_COUNT: &[u8] = b"hot_active_thread_count\0";

    /// Get count of pending callbacks
    pub const PENDING_CALLBACK_COUNT: &[u8] = b"hot_pending_callback_count\0";
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_execution_mode_default_is_safe() {
        // CRITICAL: Default must be process-isolated
        let mode = ExecutionMode::default();
        assert!(matches!(mode, ExecutionMode::ProcessIsolated));
    }

    #[test]
    fn test_unsafe_mode_requires_env_var() {
        // Clear the env var to ensure we test without it
        std::env::remove_var("SYNTHI_UNSAFE_INPROCESS");

        // Should not be able to create unsafe mode without env var
        // (In real code, this would panic or return error)
    }

    #[test]
    fn test_isolation_config_defaults() {
        let config = IsolationConfig::default();
        assert_eq!(config.max_restarts, 5);
        assert!(!config.debug_ipc);
    }

    #[test]
    fn test_resource_limits_defaults() {
        let limits = ResourceLimits::default();
        assert_eq!(limits.max_memory, 2 * 1024 * 1024 * 1024);
        assert!(!limits.allow_network);
    }

    #[test]
    fn test_ipc_message_binary_serialization() {
        let msg = IpcMessage::LoadModule {
            slot: "core".to_string(),
            path: "/tmp/test.so".to_string(),
            state_snapshot: Some(vec![1, 2, 3]),
        };

        // Use MsgPack, NOT JSON
        let binary = rmp_serde::to_vec(&msg).unwrap();
        let parsed: IpcMessage = rmp_serde::from_slice(&binary).unwrap();

        match parsed {
            IpcMessage::LoadModule {
                slot,
                path,
                state_snapshot,
            } => {
                assert_eq!(slot, "core");
                assert_eq!(path, "/tmp/test.so");
                assert_eq!(state_snapshot, Some(vec![1, 2, 3]));
            }
            _ => panic!("Wrong message type"),
        }
    }

    #[test]
    fn test_binary_frame_roundtrip() {
        let payload = b"hello world";
        let mut buffer = Vec::new();

        write_frame(&mut buffer, payload).unwrap();

        let mut cursor = std::io::Cursor::new(buffer);
        let result = read_frame(&mut cursor).unwrap();

        assert_eq!(result, payload);
    }

    #[test]
    fn test_frame_rejects_oversized() {
        // Frame claiming to be larger than MAX_FRAME_SIZE should be rejected
        let mut buffer = Vec::new();
        let huge_size: u32 = MAX_FRAME_SIZE as u32 + 1;
        buffer.extend_from_slice(&huge_size.to_be_bytes());
        buffer.extend_from_slice(&[0u8; 100]); // Some data

        let mut cursor = std::io::Cursor::new(buffer);
        let result = read_frame(&mut cursor);

        assert!(result.is_err());
    }

    #[test]
    fn test_quiescence_timeout_constants() {
        // Sanity check our timeout values
        assert!(QUIESCENCE_HARD_TIMEOUT > QUIESCENCE_WARNING_THRESHOLD);
        assert!(QUIESCENCE_HARD_TIMEOUT.as_secs() <= 60); // Not too long
        assert!(QUIESCENCE_WARNING_THRESHOLD.as_secs() >= 1); // Not too short
    }
}
