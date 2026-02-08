// ============================================================
// MOBILE EMULATOR ROUTING TYPES
// ============================================================
// Job routing schema for mobile emulator execution.
// Integrates with existing worker capability system.
// Emulator-only: no standalone builds, always run in emulator.
// Supports: React Native, Native Android (Java/Kotlin), Flutter
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================
// BUILD TARGETS
// ============================================================

/// Supported build targets for the worker system
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuildTarget {
    // Existing non-mobile targets (from current system)
    CppNative,
    RustNative,
    Typescript,
    Python,

    // Mobile emulator targets - build APK and run in Android emulator
    ReactNativeAndroidEmulator,
    
    // Native Android (Java/Kotlin) emulator target
    NativeAndroidEmulator,
    
    // Flutter Android emulator target (Phase 2)
    FlutterAndroidEmulator,
}

impl BuildTarget {
    /// Returns the required OS for this build target
    pub fn required_os(&self) -> RequiredOS {
        match self {
            // Android emulator requires Linux (headless, software rendering)
            BuildTarget::ReactNativeAndroidEmulator => RequiredOS::Linux,
            BuildTarget::NativeAndroidEmulator => RequiredOS::Linux,
            BuildTarget::FlutterAndroidEmulator => RequiredOS::Linux,
            // Everything else can run on any supported OS
            _ => RequiredOS::Any,
        }
    }

    /// Returns minimum RAM requirement in GB
    pub fn min_ram_gb(&self) -> u32 {
        match self {
            BuildTarget::CppNative | BuildTarget::Typescript | BuildTarget::Python => 2,
            BuildTarget::RustNative => 4,
            // Emulator requires 6GB (emulator process + app + Gradle + node/dart)
            BuildTarget::ReactNativeAndroidEmulator => 6,
            // Native Android needs less RAM (no Metro bundler/Node.js)
            BuildTarget::NativeAndroidEmulator => 5,
            // Flutter needs similar to React Native
            BuildTarget::FlutterAndroidEmulator => 6,
        }
    }

    /// Returns minimum disk space requirement in GB
    pub fn min_disk_gb(&self) -> u32 {
        match self {
            BuildTarget::CppNative | BuildTarget::Typescript | BuildTarget::Python => 1,
            BuildTarget::RustNative => 3,
            // Emulator needs: system image (2GB) + AVD (2GB) + node_modules (1GB) + Gradle (3GB)
            BuildTarget::ReactNativeAndroidEmulator => 10,
            // Native Android needs less (no node_modules)
            BuildTarget::NativeAndroidEmulator => 8,
            // Flutter needs: Flutter SDK (2GB) + pub cache (1GB) + Gradle (3GB) + emulator
            BuildTarget::FlutterAndroidEmulator => 12,
        }
    }

    /// Returns estimated execution time in seconds
    pub fn estimated_execution_seconds(&self) -> u32 {
        match self {
            BuildTarget::CppNative => 30,
            BuildTarget::RustNative => 60,
            BuildTarget::Typescript => 15,
            BuildTarget::Python => 5,
            // Emulator: boot (~120s) + npm install (~60s) + gradle (~120s) + app launch (~30s)
            BuildTarget::ReactNativeAndroidEmulator => 330,
            // Native Android: boot (~120s) + gradle (~180s) + app launch (~30s)
            BuildTarget::NativeAndroidEmulator => 330,
            // Flutter: boot (~120s) + pub get (~30s) + flutter build (~180s) + app launch (~30s)
            BuildTarget::FlutterAndroidEmulator => 360,
        }
    }

    /// Returns compatible capability classes for this target
    pub fn compatible_capabilities(&self) -> &'static [CapabilityClass] {
        match self {
            BuildTarget::CppNative
            | BuildTarget::RustNative
            | BuildTarget::Typescript
            | BuildTarget::Python => &[
                CapabilityClass::LinuxBasic,
                CapabilityClass::LinuxAndroidEmulator,
            ],

            // All Android emulator targets require Android emulator capability
            BuildTarget::ReactNativeAndroidEmulator => &[CapabilityClass::LinuxAndroidEmulator],
            BuildTarget::NativeAndroidEmulator => &[CapabilityClass::LinuxAndroidEmulator],
            BuildTarget::FlutterAndroidEmulator => &[CapabilityClass::LinuxAndroidEmulator],
        }
    }

    /// Whether this is a mobile/emulator target
    pub fn is_mobile_target(&self) -> bool {
        matches!(
            self,
            BuildTarget::ReactNativeAndroidEmulator
                | BuildTarget::NativeAndroidEmulator
                | BuildTarget::FlutterAndroidEmulator
        )
    }

    /// Returns the mobile platform type for this target
    pub fn mobile_platform(&self) -> Option<MobilePlatform> {
        match self {
            BuildTarget::ReactNativeAndroidEmulator => Some(MobilePlatform::ReactNative),
            BuildTarget::NativeAndroidEmulator => Some(MobilePlatform::NativeAndroid),
            BuildTarget::FlutterAndroidEmulator => Some(MobilePlatform::Flutter),
            _ => None,
        }
    }
}

/// Mobile platform type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobilePlatform {
    /// React Native (JavaScript/TypeScript)
    ReactNative,
    /// Native Android (Java/Kotlin)
    NativeAndroid,
    /// Flutter (Dart)
    Flutter,
}

// ============================================================
// CAPABILITY CLASSES
// ============================================================

/// Worker capability class (determines what jobs can run)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityClass {
    /// Basic Linux worker: C++, Rust, TypeScript, Python only
    LinuxBasic,

    /// Linux with Android SDK + Emulator (all mobile targets)
    /// Includes: Node.js, npm, Java, Android SDK, cmdline-tools, emulator, 
    /// system-images, Flutter SDK (optional)
    LinuxAndroidEmulator,
}

impl CapabilityClass {
    /// Returns all build targets this class supports
    pub fn supported_targets(&self) -> Vec<BuildTarget> {
        match self {
            CapabilityClass::LinuxBasic => vec![
                BuildTarget::CppNative,
                BuildTarget::RustNative,
                BuildTarget::Typescript,
                BuildTarget::Python,
            ],
            CapabilityClass::LinuxAndroidEmulator => vec![
                BuildTarget::CppNative,
                BuildTarget::RustNative,
                BuildTarget::Typescript,
                BuildTarget::Python,
                // Mobile emulator targets
                BuildTarget::ReactNativeAndroidEmulator,
                BuildTarget::NativeAndroidEmulator,
                BuildTarget::FlutterAndroidEmulator,
            ],
        }
    }

    /// Whether this capability class supports mobile development
    pub fn supports_mobile(&self) -> bool {
        matches!(self, CapabilityClass::LinuxAndroidEmulator)
    }

    /// Required toolchains for this capability class
    pub fn required_toolchains(&self) -> &'static [&'static str] {
        match self {
            CapabilityClass::LinuxBasic => &["gcc", "rustc", "node", "python3"],
            CapabilityClass::LinuxAndroidEmulator => &[
                "gcc",
                "rustc",
                "node",
                "python3",
                "java",
                "adb",
                "emulator",
                "avdmanager",
                "npx",
                "gradle",
            ],
        }
    }

    /// Optional toolchains that enhance capability
    pub fn optional_toolchains(&self) -> &'static [&'static str] {
        match self {
            CapabilityClass::LinuxBasic => &[],
            CapabilityClass::LinuxAndroidEmulator => &["flutter", "dart"],
        }
    }
}

// ============================================================
// EMULATOR CAPABILITY FLAGS
// ============================================================

/// Detailed emulator capabilities for a worker
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmulatorCapabilities {
    /// Whether Android emulator is available
    pub android_emulator: bool,

    /// Whether KVM hardware acceleration is available
    pub kvm_available: bool,

    /// Installed system images (e.g., ["system-images;android-34;google_apis;x86_64"])
    pub system_images: Vec<String>,

    /// Pre-created AVD names
    pub avd_names: Vec<String>,

    /// Maximum concurrent emulators (usually 1 per worker)
    pub max_concurrent: u32,

    /// Current running emulator count
    pub current_running: u32,
}

/// Required OS for a build target
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequiredOS {
    Any,
    Linux,
    MacOS,
    Windows,
}

// ============================================================
// WORKER STATE
// ============================================================

/// Worker health status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkerHealth {
    /// Ready to accept jobs
    Ready,
    /// Currently processing a job
    Busy,
    /// Draining (finishing current job, not accepting new)
    Draining,
    /// Health check failed
    Unhealthy,
    /// Not responding to heartbeats
    Offline,
}

/// Toolchain version information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolchainInfo {
    pub version: String,
    pub path: String,
}

/// Resource availability on worker
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceInfo {
    pub disk_available_gb: f64,
    pub ram_total_gb: f64,
    pub ram_available_gb: f64,
    pub cpu_cores: u32,
    pub cpu_load_percent: f64,
}

/// Cache state for affinity routing
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WarmCacheInfo {
    /// Recently built workspace IDs (max 10)
    pub workspace_ids: Vec<String>,
    /// Cached Flutter SDK version
    pub flutter_version: Option<String>,
    /// Whether Gradle home (~/.gradle) is populated
    pub gradle_home_populated: bool,
}

/// Worker capability report (sent on registration and heartbeat)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerCapabilityReport {
    #[serde(rename = "type")]
    pub msg_type: String, // "capability_report"

    pub worker_id: String,
    pub capability_class: CapabilityClass,

    pub os: OSInfo,
    pub toolchains: HashMap<String, ToolchainInfo>,
    pub build_targets: Vec<BuildTarget>,
    pub resources: ResourceInfo,
    pub warm_caches: WarmCacheInfo,

    pub health: WorkerHealth,
    pub current_job_id: Option<String>,
    pub jobs_completed_total: u64,

    pub registered_at: String,
    pub last_heartbeat: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OSInfo {
    #[serde(rename = "type")]
    pub os_type: String, // "linux", "macos", "windows"
    pub distro: Option<String>,
    pub version: String,
    pub arch: String, // "x86_64", "arm64"
}

// ============================================================
// JOB REQUEST
// ============================================================

/// Build job request from client
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildJobRequest {
    pub job_id: String,
    pub workspace_id: String,
    pub user_id: String,

    pub build: BuildSpec,
    pub source: SourceSpec,
    pub routing: Option<RoutingHints>,
    pub output: OutputSpec,

    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildSpec {
    pub target: BuildTarget,
    pub variant: BuildVariant,
    pub project_root: String,
    pub entry_point: String,
    pub extra_args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildVariant {
    Debug,
    Release,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SourceSpec {
    /// Inline source files (for small projects)
    Inline { files: Vec<SourceFile> },
    /// Reference to GCS bucket
    Gcs { bucket: String, prefix: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RoutingHints {
    /// Prefer specific worker (for cache affinity)
    pub preferred_worker_id: Option<String>,
    /// Require specific capability class
    pub required_capability: Option<CapabilityClass>,
    /// Maximum queue wait time in seconds
    pub max_queue_seconds: Option<u32>,
    /// Priority (0-100, higher = more urgent)
    pub priority: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputSpec {
    pub artifact_destination: ArtifactDestination,
    pub stream_logs: bool,
    pub webrtc_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ArtifactDestination {
    Gcs { bucket: String, prefix: String },
    PresignedUrl { callback_url: String },
}

// ============================================================
// ROUTING DECISION
// ============================================================

/// Routing decision made by dispatcher
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingDecision {
    pub job_id: String,
    pub decision: RoutingOutcome,
    pub evaluated_workers: Vec<WorkerEvaluation>,
    pub decided_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum RoutingOutcome {
    Routed {
        worker_id: String,
        reason: String,
    },
    Queued {
        queue_position: u32,
        estimated_wait_seconds: u32,
    },
    Rejected {
        error_code: RoutingErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerEvaluation {
    pub worker_id: String,
    pub eligible: bool,
    pub rejection_reason: Option<String>,
    pub score: Option<f64>,
}

/// Routing error codes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RoutingErrorCode {
    /// No workers have required capability
    NoCapableWorkers,
    /// Capable workers exist but all busy
    AllWorkersBusy,
    /// e.g., iOS build requested but no macOS workers
    OsConstraintFailed,
    /// Workers exist but lack RAM/disk
    ResourceInsufficient,
    /// Job waited too long in queue
    QueueTimeout,
    /// Unknown build target
    InvalidTarget,
    /// Source workspace doesn't exist
    WorkspaceNotFound,
}

impl RoutingErrorCode {
    /// Whether this error is retryable
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            RoutingErrorCode::NoCapableWorkers
                | RoutingErrorCode::AllWorkersBusy
                | RoutingErrorCode::ResourceInsufficient
                | RoutingErrorCode::QueueTimeout
        )
    }

    /// Suggested HTTP status code
    pub fn http_status(&self) -> u16 {
        match self {
            RoutingErrorCode::NoCapableWorkers => 503,
            RoutingErrorCode::AllWorkersBusy => 503,
            RoutingErrorCode::OsConstraintFailed => 400,
            RoutingErrorCode::ResourceInsufficient => 503,
            RoutingErrorCode::QueueTimeout => 408,
            RoutingErrorCode::InvalidTarget => 400,
            RoutingErrorCode::WorkspaceNotFound => 404,
        }
    }
}

// ============================================================
// ROUTING ALGORITHM
// ============================================================

/// Router for matching jobs to workers
pub struct JobRouter {
    /// Minimum score difference to prefer a worker
    pub affinity_threshold: f64,
}

impl Default for JobRouter {
    fn default() -> Self {
        Self {
            affinity_threshold: 10.0,
        }
    }
}

impl JobRouter {
    /// Score a worker for a job (higher = better match)
    pub fn score_worker(&self, worker: &WorkerCapabilityReport, job: &BuildJobRequest) -> f64 {
        let mut score = 0.0;

        // Base availability score
        match worker.health {
            WorkerHealth::Ready => score += 100.0,
            WorkerHealth::Busy => score += 0.0,
            _ => return -1000.0, // Ineligible
        }

        // Cache affinity
        if worker.warm_caches.workspace_ids.contains(&job.workspace_id) {
            score += 50.0; // Major win for incremental builds
        }

        // Resource headroom
        let ram_ratio = worker.resources.ram_available_gb / worker.resources.ram_total_gb;
        score += ram_ratio * 20.0;

        let disk_headroom = (worker.resources.disk_available_gb / 50.0).min(1.0);
        score += disk_headroom * 10.0;

        // Preferred worker bonus
        if let Some(ref hints) = job.routing {
            if hints.preferred_worker_id.as_ref() == Some(&worker.worker_id) {
                score += 200.0;
            }
        }

        // Load balancing (prefer less loaded)
        score -= worker.resources.cpu_load_percent * 0.5;

        score
    }

    /// Check if a worker is eligible for a job
    pub fn is_eligible(
        &self,
        worker: &WorkerCapabilityReport,
        job: &BuildJobRequest,
    ) -> Result<(), String> {
        let target = job.build.target;

        // Capability check
        let compatible = target.compatible_capabilities();
        if !compatible.contains(&worker.capability_class) {
            return Err(format!(
                "capability mismatch: {} not in {:?}",
                worker.capability_class as u8, compatible
            ));
        }

        // OS check
        let required_os = target.required_os();
        if required_os != RequiredOS::Any {
            let worker_os = match worker.os.os_type.as_str() {
                "linux" => RequiredOS::Linux,
                "macos" => RequiredOS::MacOS,
                "windows" => RequiredOS::Windows,
                _ => return Err(format!("unknown OS: {}", worker.os.os_type)),
            };
            if required_os != worker_os {
                return Err(format!(
                    "OS mismatch: need {:?}, have {:?}",
                    required_os, worker_os
                ));
            }
        }

        // Health check
        if !matches!(worker.health, WorkerHealth::Ready | WorkerHealth::Busy) {
            return Err(format!("unhealthy: {:?}", worker.health));
        }

        // Resource check
        let min_disk = target.min_disk_gb() as f64;
        if worker.resources.disk_available_gb < min_disk {
            return Err(format!(
                "insufficient disk: need {}GB, have {}GB",
                min_disk, worker.resources.disk_available_gb
            ));
        }

        let min_ram = target.min_ram_gb() as f64;
        if worker.resources.ram_available_gb < min_ram {
            return Err(format!(
                "insufficient RAM: need {}GB, have {}GB",
                min_ram, worker.resources.ram_available_gb
            ));
        }

        Ok(())
    }
}

// ============================================================
// JOB RESULT
// ============================================================

/// Result of a job execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobResult {
    pub job_id: String,
    pub status: JobStatus,
    pub emulator_session: Option<EmulatorSessionInfo>,
    pub logs: Vec<LogEntry>,
    pub diagnostics: Vec<Diagnostic>,
    pub timing: JobTiming,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    /// Job completed successfully (emulator running, app launched)
    Running,
    /// Job completed, session ended normally
    Completed,
    /// Job failed during build or emulator boot
    Failed,
    /// Job was cancelled by user
    Cancelled,
    /// Job hit hard timeout
    Timeout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: LogLevel,
    pub source: LogSource,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogSource {
    /// Metro bundler output (React Native)
    Metro,
    /// Gradle build output
    Gradle,
    /// Android emulator output
    Emulator,
    /// App logcat output
    Logcat,
    /// Worker system logs
    Worker,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub severity: String,
    pub message: String,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
    Hint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobTiming {
    pub queued_at: String,
    pub started_at: String,
    pub boot_completed_at: Option<String>,
    pub app_launched_at: Option<String>,
    pub completed_at: Option<String>,
    pub queue_duration_ms: u64,
    pub boot_duration_ms: Option<u64>,
    pub build_duration_ms: Option<u64>,
}

// ============================================================
// EMULATOR SESSION TYPES
// ============================================================

/// Emulator session state for tracking running emulators
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmulatorSessionState {
    /// Emulator is starting up (booting)
    Booting,
    /// Emulator is ready, app not yet installed
    Ready,
    /// App is installed and running
    Running,
    /// Emulator is shutting down
    ShuttingDown,
    /// Session terminated (normal or error)
    Terminated,
}

/// Emulator session info for job tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmulatorSessionInfo {
    pub session_id: String,
    pub job_id: String,
    pub avd_name: String,
    pub state: EmulatorSessionState,
    pub emulator_pid: Option<u32>,
    pub adb_port: Option<u16>,
    pub boot_started_at: Option<String>,
    pub app_started_at: Option<String>,
}

/// React Native project detection result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactNativeProjectInfo {
    pub is_react_native_project: bool,
    pub package_json_path: Option<String>,
    pub app_name: Option<String>,
    pub app_id: Option<String>, // e.g., "com.example.myapp"
    pub react_native_version: Option<String>,
    pub min_sdk_version: Option<u32>,
}

/// Android SDK health check result (for React Native)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AndroidSdkHealth {
    pub sdk_path: Option<String>,
    pub node_ok: bool,
    pub adb_ok: bool,
    pub emulator_ok: bool,
    pub avdmanager_ok: bool,
    pub java_ok: bool,
    pub system_images: Vec<String>,
    pub available_avds: Vec<String>,
    pub issues: Vec<String>,
}

impl AndroidSdkHealth {
    /// Returns true if the SDK is ready for emulator execution
    pub fn is_ready(&self) -> bool {
        self.node_ok
            && self.adb_ok
            && self.emulator_ok
            && self.avdmanager_ok
            && self.java_ok
            && !self.system_images.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_emulator_target_requirements() {
        // All emulator targets require Linux
        assert_eq!(
            BuildTarget::ReactNativeAndroidEmulator.required_os(),
            RequiredOS::Linux
        );
        assert_eq!(
            BuildTarget::NativeAndroidEmulator.required_os(),
            RequiredOS::Linux
        );
        assert_eq!(
            BuildTarget::FlutterAndroidEmulator.required_os(),
            RequiredOS::Linux
        );
        // Non-mobile targets can run anywhere
        assert_eq!(BuildTarget::CppNative.required_os(), RequiredOS::Any);
        // Resource requirements
        assert_eq!(BuildTarget::ReactNativeAndroidEmulator.min_ram_gb(), 6);
        assert_eq!(BuildTarget::NativeAndroidEmulator.min_ram_gb(), 5);
        assert_eq!(BuildTarget::FlutterAndroidEmulator.min_ram_gb(), 6);
        assert_eq!(BuildTarget::ReactNativeAndroidEmulator.min_disk_gb(), 10);
        assert_eq!(BuildTarget::NativeAndroidEmulator.min_disk_gb(), 8);
        assert_eq!(BuildTarget::FlutterAndroidEmulator.min_disk_gb(), 12);
        assert_eq!(BuildTarget::CppNative.min_ram_gb(), 2);
    }

    #[test]
    fn test_capability_compatibility() {
        // All emulator targets require Android emulator capability
        let rn_targets = BuildTarget::ReactNativeAndroidEmulator.compatible_capabilities();
        assert!(rn_targets.contains(&CapabilityClass::LinuxAndroidEmulator));
        assert!(!rn_targets.contains(&CapabilityClass::LinuxBasic));

        let native_targets = BuildTarget::NativeAndroidEmulator.compatible_capabilities();
        assert!(native_targets.contains(&CapabilityClass::LinuxAndroidEmulator));

        let flutter_targets = BuildTarget::FlutterAndroidEmulator.compatible_capabilities();
        assert!(flutter_targets.contains(&CapabilityClass::LinuxAndroidEmulator));

        // Basic targets work on both capability classes
        let cpp_targets = BuildTarget::CppNative.compatible_capabilities();
        assert!(cpp_targets.contains(&CapabilityClass::LinuxBasic));
        assert!(cpp_targets.contains(&CapabilityClass::LinuxAndroidEmulator));
    }

    #[test]
    fn test_capability_class_mobile_support() {
        assert!(CapabilityClass::LinuxAndroidEmulator.supports_mobile());
        assert!(!CapabilityClass::LinuxBasic.supports_mobile());
    }

    #[test]
    fn test_mobile_platform() {
        assert_eq!(
            BuildTarget::ReactNativeAndroidEmulator.mobile_platform(),
            Some(MobilePlatform::ReactNative)
        );
        assert_eq!(
            BuildTarget::NativeAndroidEmulator.mobile_platform(),
            Some(MobilePlatform::NativeAndroid)
        );
        assert_eq!(
            BuildTarget::FlutterAndroidEmulator.mobile_platform(),
            Some(MobilePlatform::Flutter)
        );
        assert_eq!(BuildTarget::CppNative.mobile_platform(), None);
    }

    #[test]
    fn test_is_mobile_target() {
        assert!(BuildTarget::ReactNativeAndroidEmulator.is_mobile_target());
        assert!(BuildTarget::NativeAndroidEmulator.is_mobile_target());
        assert!(BuildTarget::FlutterAndroidEmulator.is_mobile_target());
        assert!(!BuildTarget::CppNative.is_mobile_target());
        assert!(!BuildTarget::Python.is_mobile_target());
    }

    #[test]
    fn test_routing_error_retryable() {
        assert!(RoutingErrorCode::AllWorkersBusy.is_retryable());
        assert!(!RoutingErrorCode::InvalidTarget.is_retryable());
    }
}
