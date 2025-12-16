// ============================================================
// MOBILE BUILD ROUTING TYPES
// ============================================================
// Job routing schema for mobile builds (Flutter Android/iOS).
// Integrates with existing worker capability system.
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
    // Existing targets (from current system)
    CppNative,
    RustNative,
    Typescript,
    Python,
    
    // Flutter targets (v1)
    FlutterAndroidDebug,
    FlutterWeb,
    FlutterLinuxDesktop,
    
    // Flutter targets (v2 - requires signing)
    FlutterAndroidRelease,
    FlutterIosDebug,
    FlutterIosRelease,
    FlutterMacosDesktop,
    
    // Future
    FlutterWindowsDesktop,
}

impl BuildTarget {
    /// Returns the required OS for this build target
    pub fn required_os(&self) -> RequiredOS {
        match self {
            // iOS/macOS builds require macOS
            BuildTarget::FlutterIosDebug 
            | BuildTarget::FlutterIosRelease 
            | BuildTarget::FlutterMacosDesktop => RequiredOS::MacOS,
            
            // Windows builds require Windows
            BuildTarget::FlutterWindowsDesktop => RequiredOS::Windows,
            
            // Everything else can run on any supported OS
            _ => RequiredOS::Any,
        }
    }
    
    /// Returns minimum RAM requirement in GB
    pub fn min_ram_gb(&self) -> u32 {
        match self {
            BuildTarget::CppNative | BuildTarget::Typescript | BuildTarget::Python => 2,
            BuildTarget::RustNative => 4,
            BuildTarget::FlutterWeb | BuildTarget::FlutterLinuxDesktop => 3,
            BuildTarget::FlutterAndroidDebug | BuildTarget::FlutterAndroidRelease => 4,
            BuildTarget::FlutterIosDebug | BuildTarget::FlutterIosRelease => 8,
            BuildTarget::FlutterMacosDesktop | BuildTarget::FlutterWindowsDesktop => 6,
        }
    }
    
    /// Returns minimum disk space requirement in GB
    pub fn min_disk_gb(&self) -> u32 {
        match self {
            BuildTarget::CppNative | BuildTarget::Typescript | BuildTarget::Python => 1,
            BuildTarget::RustNative => 3,
            BuildTarget::FlutterWeb => 2,
            BuildTarget::FlutterLinuxDesktop => 3,
            BuildTarget::FlutterAndroidDebug | BuildTarget::FlutterAndroidRelease => 5,
            BuildTarget::FlutterIosDebug | BuildTarget::FlutterIosRelease => 10,
            BuildTarget::FlutterMacosDesktop | BuildTarget::FlutterWindowsDesktop => 5,
        }
    }
    
    /// Returns estimated build time in seconds (cold build)
    pub fn estimated_build_seconds(&self) -> u32 {
        match self {
            BuildTarget::CppNative => 30,
            BuildTarget::RustNative => 60,
            BuildTarget::Typescript => 15,
            BuildTarget::Python => 5,
            BuildTarget::FlutterWeb => 60,
            BuildTarget::FlutterLinuxDesktop => 90,
            BuildTarget::FlutterAndroidDebug => 120,
            BuildTarget::FlutterAndroidRelease => 180,
            BuildTarget::FlutterIosDebug => 180,
            BuildTarget::FlutterIosRelease => 240,
            BuildTarget::FlutterMacosDesktop => 120,
            BuildTarget::FlutterWindowsDesktop => 150,
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
                CapabilityClass::LinuxFlutterAndroid,
                CapabilityClass::MacOSFlutter,
            ],
            
            BuildTarget::FlutterAndroidDebug 
            | BuildTarget::FlutterAndroidRelease
            | BuildTarget::FlutterWeb
            | BuildTarget::FlutterLinuxDesktop => &[
                CapabilityClass::LinuxFlutterAndroid,
                CapabilityClass::MacOSFlutter,
            ],
            
            BuildTarget::FlutterIosDebug 
            | BuildTarget::FlutterIosRelease 
            | BuildTarget::FlutterMacosDesktop => &[
                CapabilityClass::MacOSFlutter,
            ],
            
            BuildTarget::FlutterWindowsDesktop => &[
                // Not yet supported
            ],
        }
    }
    
    /// Flutter build command for this target (if applicable)
    pub fn flutter_build_command(&self) -> Option<&'static str> {
        match self {
            BuildTarget::FlutterAndroidDebug => Some("flutter build apk --debug"),
            BuildTarget::FlutterAndroidRelease => Some("flutter build apk --release"),
            BuildTarget::FlutterIosDebug => Some("flutter build ios --debug --no-codesign"),
            BuildTarget::FlutterIosRelease => Some("flutter build ios --release"),
            BuildTarget::FlutterWeb => Some("flutter build web --release"),
            BuildTarget::FlutterLinuxDesktop => Some("flutter build linux --release"),
            BuildTarget::FlutterMacosDesktop => Some("flutter build macos --release"),
            BuildTarget::FlutterWindowsDesktop => Some("flutter build windows --release"),
            _ => None,
        }
    }
}

// ============================================================
// CAPABILITY CLASSES
// ============================================================

/// Worker capability class (determines what can be built)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityClass {
    /// Basic Linux worker: C++, Rust, TypeScript, Python
    LinuxBasic,
    
    /// Linux with Flutter + Android SDK
    LinuxFlutterAndroid,
    
    /// macOS with Flutter + Xcode (can build iOS)
    MacOSFlutter,
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
            CapabilityClass::LinuxFlutterAndroid => vec![
                BuildTarget::CppNative,
                BuildTarget::RustNative,
                BuildTarget::Typescript,
                BuildTarget::Python,
                BuildTarget::FlutterAndroidDebug,
                BuildTarget::FlutterAndroidRelease,
                BuildTarget::FlutterWeb,
                BuildTarget::FlutterLinuxDesktop,
            ],
            CapabilityClass::MacOSFlutter => vec![
                BuildTarget::CppNative,
                BuildTarget::RustNative,
                BuildTarget::Typescript,
                BuildTarget::Python,
                BuildTarget::FlutterAndroidDebug,
                BuildTarget::FlutterAndroidRelease,
                BuildTarget::FlutterWeb,
                BuildTarget::FlutterIosDebug,
                BuildTarget::FlutterIosRelease,
                BuildTarget::FlutterMacosDesktop,
            ],
        }
    }
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
    pub fn score_worker(
        &self,
        worker: &WorkerCapabilityReport,
        job: &BuildJobRequest,
    ) -> f64 {
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
                worker.capability_class as u8,
                compatible
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
// BUILD RESULT
// ============================================================

/// Result of a build job
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildJobResult {
    pub job_id: String,
    pub status: BuildStatus,
    pub artifact: Option<BuildArtifact>,
    pub logs: Vec<BuildLogEntry>,
    pub diagnostics: Vec<BuildDiagnostic>,
    pub timing: BuildTiming,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildStatus {
    Success,
    Failed,
    Cancelled,
    Timeout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildArtifact {
    /// Artifact type (e.g., "apk", "ipa", "web", "so")
    pub artifact_type: String,
    /// Download URL (presigned)
    pub url: String,
    /// File size in bytes
    pub size_bytes: u64,
    /// SHA256 hash
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildLogEntry {
    pub timestamp: String,
    pub level: LogLevel,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildDiagnostic {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub severity: DiagnosticSeverity,
    pub message: String,
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
pub struct BuildTiming {
    pub queued_at: String,
    pub started_at: String,
    pub completed_at: String,
    pub queue_duration_ms: u64,
    pub build_duration_ms: u64,
}

// ============================================================
// FLUTTER-SPECIFIC TYPES
// ============================================================

/// Flutter project detection result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlutterProjectInfo {
    pub is_flutter_project: bool,
    pub pubspec_path: Option<String>,
    pub flutter_version_constraint: Option<String>,
    pub platforms: Vec<FlutterPlatform>,
    pub dependencies: Vec<String>,
    pub dev_dependencies: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlutterPlatform {
    Android,
    Ios,
    Web,
    Linux,
    Macos,
    Windows,
}

/// Flutter doctor result (for health checks)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlutterDoctorResult {
    pub flutter_ok: bool,
    pub dart_ok: bool,
    pub android_toolchain_ok: bool,
    pub xcode_ok: bool,
    pub issues: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_build_target_requirements() {
        assert_eq!(BuildTarget::FlutterIosDebug.required_os(), RequiredOS::MacOS);
        assert_eq!(BuildTarget::FlutterAndroidDebug.required_os(), RequiredOS::Any);
        assert_eq!(BuildTarget::CppNative.min_ram_gb(), 2);
        assert_eq!(BuildTarget::FlutterIosDebug.min_ram_gb(), 8);
    }
    
    #[test]
    fn test_capability_compatibility() {
        let targets = BuildTarget::FlutterIosDebug.compatible_capabilities();
        assert!(targets.contains(&CapabilityClass::MacOSFlutter));
        assert!(!targets.contains(&CapabilityClass::LinuxFlutterAndroid));
    }
    
    #[test]
    fn test_routing_error_retryable() {
        assert!(RoutingErrorCode::AllWorkersBusy.is_retryable());
        assert!(!RoutingErrorCode::InvalidTarget.is_retryable());
    }
}
