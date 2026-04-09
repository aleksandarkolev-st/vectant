#![allow(dead_code)]
// ============================================================
// HMR ORCHESTRATOR - UNIFIED INTEGRATION MODULE
// ============================================================
// This module ties together all the previously "dead" infrastructure:
// - StateManager for centralized state lifecycle
// - ReloadManager for reload taxonomy and snapshots
// - CrashSupervisor for recovery policies
// - ModuleLoader for ABI-validated loading
// - BoundaryManifest for explicit boundaries
// - Binary state serialization (MessagePack)
// - Fast Refresh boundary checking (Next.js-style)
// - Source map resolution for crash locations
//
// USAGE:
//   let orchestrator = HmrOrchestrator::new();
//   orchestrator.register_module("core", path, manifest);
//   let result = orchestrator.hot_reload("core", new_path, changes);
// ============================================================

use std::collections::HashMap;
use std::ffi::{c_void, CStr, CString};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use libloading::{Library, Symbol};

use crate::compiler::source_map::SOURCE_MAP_CACHE;
use crate::hmr::binary_state::{MsgPackState, SchemaMigrationResult};
use crate::hmr::fast_refresh::{
    BoundaryCheckResult, BoundaryChecker, BoundaryViolationEvent, RefreshAction,
};
use crate::hmr::reload_manager::{
    AsyncTaskRegistry, ReloadChanges, ReloadClass, ReloadClassifier, ReloadSnapshot,
    SnapshotManager,
};
use crate::hmr::reload_protocol::{ReloadConfig, ReloadOperation};
use crate::hmr::state_diff::{migrate_state_with_config, DiffConfig};
use crate::hmr::state_manager::{MigrationResult, MigrationSchema, SchemaVersion, StateManager};
use crate::infra::crash_recovery::CrashInfo;
use crate::infra::observability::{
    LogEntry, LogFormat, LogLevel, MetricsAggregator, ReloadId, ReloadMetricsTracker,
    StructuredLogger,
};
use crate::runtime::loader::{LoadResult, ModuleLoader};
use crate::runtime::plugin_contract::ModuleSlot;
use crate::runtime::supervisor::{CrashSupervisor, RecoveryAction, SupervisorConfig};
use crate::safety::boundary::{Boundary, BoundaryId, BoundaryManifest, ReloadPlan};
use crate::safety::quiescence::{QuiescenceConfig, QuiescenceManager};

// Integration with the full HMR pipeline (planner, adapters, AI gate, candidates)
use crate::hmr::integration::HmrPipeline;
// use crate::quiescence::{QuiescenceManager, QuiescenceConfig}; // DUP
// use crate::reload_protocol::{ReloadOperation, ReloadConfig}; // DUP

// ============================================================
// HMR RESULT TYPES
// ============================================================

/// Result of an HMR operation
#[derive(Debug, Clone)]
pub struct HmrResult {
    pub success: bool,
    pub reload_class: ReloadClass,
    pub module: ModuleSlot,
    pub preserved_fields: Vec<String>,
    pub reset_fields: Vec<String>,
    pub new_fields: Vec<String>,
    pub duration_ms: u64,
    pub used_binary_serialization: bool,
    pub snapshot_id: Option<u64>,
    pub error: Option<String>,
    pub recovery_action: Option<RecoveryAction>,
}

impl HmrResult {
    pub fn success(module: ModuleSlot, reload_class: ReloadClass) -> Self {
        Self {
            success: true,
            reload_class,
            module,
            preserved_fields: vec![],
            reset_fields: vec![],
            new_fields: vec![],
            duration_ms: 0,
            used_binary_serialization: false,
            snapshot_id: None,
            error: None,
            recovery_action: None,
        }
    }

    pub fn failure(module: ModuleSlot, error: impl Into<String>) -> Self {
        Self {
            success: false,
            reload_class: ReloadClass::Cold,
            module,
            preserved_fields: vec![],
            reset_fields: vec![],
            new_fields: vec![],
            duration_ms: 0,
            used_binary_serialization: false,
            snapshot_id: None,
            error: Some(error.into()),
            recovery_action: None,
        }
    }

    pub fn with_migration(mut self, result: &SchemaMigrationResult) -> Self {
        self.preserved_fields = result.preserved.clone();
        self.new_fields = result.new_fields.clone();
        self.used_binary_serialization = true;
        self
    }

    pub fn with_json_migration(mut self, result: &MigrationResult) -> Self {
        self.preserved_fields = result.preserved_fields.clone();
        self.reset_fields = result.reset_fields.clone();
        self.used_binary_serialization = false;
        self
    }
}

/// Schema compatibility check result
#[derive(Debug, Clone)]
pub enum SchemaCompatibility {
    /// Schemas match - safe to reuse state pointer
    Compatible { hash: u64 },
    /// Schemas differ - need migration
    Incompatible { old_hash: u64, new_hash: u64 },
    /// New module missing hash - assume unsafe
    NewMissing { old_hash: u64 },
    /// Old module missing hash - first load
    OldMissing { new_hash: u64 },
    /// Neither has hash - legacy modules
    NeitherHasHash,
}

impl SchemaCompatibility {
    /// Returns true if state pointer can be safely reused
    pub fn is_compatible(&self) -> bool {
        matches!(
            self,
            SchemaCompatibility::Compatible { .. } | SchemaCompatibility::NeitherHasHash
        )
    }

    /// Returns true if cold reload is required
    pub fn requires_cold_reload(&self) -> bool {
        matches!(
            self,
            SchemaCompatibility::Incompatible { .. } | SchemaCompatibility::NewMissing { .. }
        )
    }
}

/// HMR status for frontend reporting
#[derive(Debug, Clone, serde::Serialize)]
pub struct HmrStatus {
    pub status: String,
    pub module: String,
    pub reload_class: String,
    pub preserved_fields: Vec<String>,
    pub new_fields: Vec<String>,
    pub duration_ms: u64,
    pub binary_state: bool,
    pub crash_count: u64,
    pub snapshot_available: bool,
}

impl From<&HmrResult> for HmrStatus {
    fn from(result: &HmrResult) -> Self {
        Self {
            status: if result.success {
                "hmr_success"
            } else {
                "hmr_failed"
            }
            .to_string(),
            module: result.module.as_str().to_string(),
            reload_class: format!("{:?}", result.reload_class),
            preserved_fields: result.preserved_fields.clone(),
            new_fields: result.new_fields.clone(),
            duration_ms: result.duration_ms,
            binary_state: result.used_binary_serialization,
            crash_count: 0,
            snapshot_available: result.snapshot_id.is_some(),
        }
    }
}

// ============================================================
// LIBRARY-BASED STATE OPERATION TYPES
// ============================================================

/// Result of a state save operation
#[derive(Debug, Clone)]
pub struct SavedState {
    pub binary: Option<Vec<u8>>,
    pub json: Option<String>,
    pub was_binary: bool,
    pub module: ModuleSlot,
}

/// Result of a state load operation
#[derive(Debug, Clone)]
pub struct LoadedState {
    pub state_ptr: *mut c_void,
    pub was_binary: bool,
    pub migration_result: Option<MigrationSummary>,
}

// Safety: LoadedState contains a raw pointer that is managed by the plugin
unsafe impl Send for LoadedState {}
unsafe impl Sync for LoadedState {}

/// Summary of migration for external use
#[derive(Debug, Clone)]
pub struct MigrationSummary {
    pub preserved_fields: Vec<String>,
    pub reset_fields: Vec<String>,
    pub new_fields: Vec<String>,
}

// ============================================================
// HMR ORCHESTRATOR - CENTRAL COORDINATION
// ============================================================

/// Central orchestrator that coordinates all HMR subsystems
pub struct HmrOrchestrator {
    // Core subsystems
    state_manager: StateManager,
    module_loader: ModuleLoader,
    crash_supervisor: CrashSupervisor,
    reload_classifier: ReloadClassifier,
    snapshot_manager: SnapshotManager,
    task_registry: AsyncTaskRegistry,

    // Fast Refresh boundary checking
    boundary_checker: BoundaryChecker,

    // Boundary management
    boundary_manifests: HashMap<ModuleSlot, BoundaryManifest>,
    active_boundaries: HashMap<BoundaryId, Boundary>,

    // Source code cache for boundary checking
    source_cache: HashMap<String, String>,

    // Configuration
    config: OrchestratorConfig,

    // Statistics
    stats: OrchestratorStats,

    // Feature flags
    binary_state_enabled: bool,
    strict_abi_validation: bool,
    snapshot_enabled: bool,
    fast_refresh_enabled: bool,

    // Observability (v2.1)
    logger: StructuredLogger,
    metrics_aggregator: MetricsAggregator,

    // Quiescence management (v2.1)
    quiescence_manager: Option<QuiescenceManager>,

    // Current reload operation (v2.1 state machine)
    current_reload: Option<ReloadOperation>,

    // HMR integration pipeline (adapters, planner, candidates, AI gate)
    hmr_pipeline: Option<HmrPipeline>,
}

/// Orchestrator configuration
#[derive(Debug, Clone)]
pub struct OrchestratorConfig {
    /// Prefer binary over JSON for state serialization
    pub prefer_binary_state: bool,
    /// Maximum snapshots to keep
    pub max_snapshots: usize,
    /// Maximum consecutive crashes before full restart
    pub max_consecutive_crashes: u32,
    /// Shutdown timeout for async tasks
    pub task_shutdown_timeout: Duration,
    /// Enable strict ABI validation
    pub strict_abi: bool,
    /// Maximum boundaries per module
    pub max_boundaries_per_module: usize,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            prefer_binary_state: true,
            max_snapshots: 10,
            max_consecutive_crashes: 3,
            task_shutdown_timeout: Duration::from_secs(5),
            strict_abi: false,
            max_boundaries_per_module: 20,
        }
    }
}

/// Orchestrator statistics
#[derive(Debug, Clone, Default)]
pub struct OrchestratorStats {
    pub total_reloads: u64,
    pub successful_reloads: u64,
    pub failed_reloads: u64,
    pub binary_migrations: u64,
    pub json_migrations: u64,
    pub snapshots_created: u64,
    pub snapshots_reverted: u64,
    pub crashes_recovered: u64,
    pub total_preserved_fields: u64,
    /// Average reload time in microseconds
    pub avg_reload_time_us: u64,
    /// Max reload time in microseconds
    pub max_reload_time_us: u64,
    /// Current reload ID (for correlation)
    pub current_reload_id: Option<u64>,
}

impl HmrOrchestrator {
    /// Create new orchestrator with default configuration
    pub fn new() -> Self {
        Self::with_config(OrchestratorConfig::default())
    }

    /// Create orchestrator with custom configuration
    pub fn with_config(config: OrchestratorConfig) -> Self {
        let supervisor_config = SupervisorConfig {
            max_consecutive_crashes: config.max_consecutive_crashes,
            crash_window: Duration::from_secs(60),
            detailed_logging: true,
            ..Default::default()
        };

        Self {
            state_manager: StateManager::new(),
            module_loader: ModuleLoader::new(),
            crash_supervisor: CrashSupervisor::new(supervisor_config),
            reload_classifier: ReloadClassifier::new(),
            snapshot_manager: SnapshotManager::new(config.max_snapshots),
            task_registry: AsyncTaskRegistry::new(config.task_shutdown_timeout),
            boundary_checker: BoundaryChecker::new(),
            boundary_manifests: HashMap::new(),
            active_boundaries: HashMap::new(),
            source_cache: HashMap::new(),
            config: config.clone(),
            stats: OrchestratorStats::default(),
            binary_state_enabled: config.prefer_binary_state,
            strict_abi_validation: config.strict_abi,
            snapshot_enabled: true,
            fast_refresh_enabled: true,
            // Observability (v2.1)
            logger: StructuredLogger::new(LogFormat::Human, LogLevel::Info),
            metrics_aggregator: MetricsAggregator::new(),
            // Quiescence and state machine (v2.1)
            quiescence_manager: None, // Initialized on first use
            current_reload: None,
            // HMR integration pipeline
            hmr_pipeline: None,
        }
    }

    // ============================================================
    // MODULE REGISTRATION
    // ============================================================

    /// Register a module with its boundary manifest
    pub fn register_module(
        &mut self,
        slot: ModuleSlot,
        manifest: BoundaryManifest,
    ) -> Result<(), String> {
        // Validate manifest
        manifest.validate()?;

        // Create boundaries from declarations
        for decl in &manifest.boundaries {
            let boundary = Boundary::from_declaration(decl, slot.as_str());
            self.active_boundaries.insert(decl.id.clone(), boundary);
        }

        self.boundary_manifests.insert(slot, manifest);
        eprintln!(
            "[Orchestrator] Registered module {:?} with {} boundaries",
            slot,
            self.boundary_manifests
                .get(&slot)
                .map(|m| m.boundaries.len())
                .unwrap_or(0)
        );

        Ok(())
    }

    /// Register schema version for a module
    pub fn register_schema_version(&mut self, slot: ModuleSlot, version: SchemaVersion) {
        self.state_manager.register_schema_version(slot, version);
    }

    /// Register a migration schema with downgrade path
    pub fn register_migration(&mut self, schema: MigrationSchema) -> Result<(), String> {
        self.state_manager.register_migration(schema)
    }

    // ============================================================
    // HMR PIPELINE ACCESS
    // ============================================================

    /// Access the integration pipeline, creating it lazily on first use.
    pub fn pipeline(&mut self, preview_id: &str) -> &mut HmrPipeline {
        if self.hmr_pipeline.is_none() {
            self.hmr_pipeline = Some(HmrPipeline::new(preview_id));
        }
        self.hmr_pipeline.as_mut().unwrap()
    }

    /// Returns a reference to the current pipeline (if initialized).
    pub fn pipeline_ref(&self) -> Option<&HmrPipeline> {
        self.hmr_pipeline.as_ref()
    }

    // ============================================================
    // HOT MODULE REPLACEMENT
    // ============================================================

    /// Perform hot module replacement
    pub fn hot_reload(
        &mut self,
        slot: ModuleSlot,
        new_path: &Path,
        changes: &ReloadChanges,
        old_state_bytes: Option<&[u8]>,
        old_state_json: Option<&str>,
        new_field_names: &[String],
    ) -> HmrResult {
        let start = Instant::now();

        // Generate unique reload ID for correlation (v2.1 observability)
        let reload_id = ReloadId::new();
        self.stats.current_reload_id = Some(reload_id.as_u64());
        self.stats.total_reloads += 1;

        // v2.1: Create ReloadOperation for state machine tracking
        let reload_op = ReloadOperation::new(
            slot.as_str().to_string(),
            new_path.display().to_string(),
            ReloadConfig::default(),
        );
        self.current_reload = Some(reload_op);

        // Start metrics tracking
        let mut metrics_tracker = ReloadMetricsTracker::start(reload_id, slot.as_str());

        // Log reload start
        self.logger.log(
            &LogEntry::new(
                LogLevel::Info,
                "hmr",
                format!("Starting reload for {:?}", slot),
            )
            .with_reload_id(reload_id)
            .with_slot_id(slot.as_str())
            .with_field("path", new_path.display().to_string()),
        );

        // 1. Classify the reload
        let reload_class = self.reload_classifier.classify_with_context(
            changes,
            changes.boundary_id.as_ref(),
            changes.file_path.as_deref(),
        );

        eprintln!(
            "[Orchestrator] Hot reload {:?}: class={:?}",
            slot, reload_class
        );
        self.logger.log(
            &LogEntry::new(
                LogLevel::Debug,
                "hmr",
                format!("Reload class: {:?}", reload_class),
            )
            .with_reload_id(reload_id),
        );

        // 2. Create pre-reload snapshot (if needed)
        let snapshot_id = if reload_class.requires_snapshot() && self.snapshot_enabled {
            let boundaries: Vec<BoundaryId> = self
                .active_boundaries
                .iter()
                .filter(|(_, b)| b.parent_module == slot.as_str())
                .map(|(id, _)| id.clone())
                .collect();

            let id = self.snapshot_manager.create_snapshot(
                reload_class,
                &self.state_manager,
                &boundaries,
            );
            self.stats.snapshots_created += 1;
            Some(id)
        } else {
            None
        };

        // 3. Enter crash supervisor context
        self.crash_supervisor.enter_context(slot);

        // 4. Drain async tasks (if cold reload)
        if reload_class.requires_task_shutdown() {
            self.task_registry
                .shutdown_boundary(&slot.as_str().to_string());
            let _ = self
                .task_registry
                .prepare_for_reload(&slot.as_str().to_string(), ReloadClass::Cold);
        }

        // 5. Validate ABI (if strict mode)
        if self.strict_abi_validation {
            let content_hash = std::fs::metadata(new_path).map(|m| m.len()).unwrap_or(0);

            match self.module_loader.load(new_path, slot, content_hash) {
                LoadResult::Success {
                    module_id,
                    abi_version,
                } => {
                    eprintln!(
                        "[Orchestrator] ABI validation passed: {} v{}",
                        module_id, abi_version
                    );
                }
                LoadResult::AbiMismatch {
                    expected,
                    found,
                    details,
                } => {
                    self.crash_supervisor.exit_context();
                    self.stats.failed_reloads += 1;
                    return HmrResult::failure(
                        slot,
                        format!(
                            "ABI mismatch: expected v{}, found v{}. {}",
                            expected, found, details
                        ),
                    );
                }
                LoadResult::MissingSymbols { symbols } => {
                    eprintln!("[Orchestrator] Warning: Missing symbols: {:?}", symbols);
                    // Continue - might be optional symbols
                }
                LoadResult::LoadError { reason } => {
                    self.crash_supervisor.exit_context();
                    self.stats.failed_reloads += 1;
                    return HmrResult::failure(slot, reason);
                }
            }
            // Unload from module_loader since actual loading happens elsewhere
            // self.module_loader.unload(slot);
            // KEEP LOADED to enable fingerprint comparison on next reload!
        }

        // 6. Migrate state (prefer binary over JSON)
        let migration_result = if self.binary_state_enabled && old_state_bytes.is_some() {
            self.migrate_binary_state(slot, old_state_bytes.unwrap(), new_field_names)
        } else if old_state_json.is_some() {
            self.migrate_json_state(slot, old_state_json.unwrap(), new_field_names)
        } else {
            // No state to migrate
            Ok(MigratedState::None)
        };

        // 7. Handle migration result
        let result = match migration_result {
            Ok(migrated) => {
                self.crash_supervisor.exit_context();
                self.crash_supervisor.reset_crash_count();
                self.stats.successful_reloads += 1;

                let mut result = HmrResult::success(slot, reload_class);
                result.snapshot_id = snapshot_id;
                result.duration_ms = start.elapsed().as_millis() as u64;

                match migrated {
                    MigratedState::Binary(_bytes, schema_result) => {
                        result = result.with_migration(&schema_result);
                        self.stats.binary_migrations += 1;
                        self.stats.total_preserved_fields += schema_result.preserved.len() as u64;
                        metrics_tracker.record_snapshot(start.elapsed(), _bytes.len());
                    }
                    MigratedState::Json(json_result) => {
                        result = result.with_json_migration(&json_result);
                        self.stats.json_migrations += 1;
                        self.stats.total_preserved_fields +=
                            json_result.preserved_fields.len() as u64;
                    }
                    MigratedState::None => {}
                }

                result
            }
            Err(e) => {
                self.crash_supervisor.exit_context();
                self.stats.failed_reloads += 1;

                let mut result = HmrResult::failure(slot, e.clone());
                result.snapshot_id = snapshot_id;
                result.duration_ms = start.elapsed().as_millis() as u64;

                // Log failure with observability
                self.logger.log(
                    &LogEntry::new(LogLevel::Error, "hmr", format!("Reload failed: {}", e))
                        .with_reload_id(reload_id)
                        .with_slot_id(slot.as_str()),
                );

                result
            }
        };

        // 8. Log status
        eprintln!(
            "[Orchestrator] HMR complete: success={}, binary={}, preserved={}, duration={}ms",
            result.success,
            result.used_binary_serialization,
            result.preserved_fields.len(),
            result.duration_ms
        );
        // 8. Record metrics and log completion (v2.1 observability)
        self.metrics_aggregator
            .record(&metrics_tracker, result.success);

        // Update timing stats
        let duration_us = start.elapsed().as_micros() as u64;
        self.stats.max_reload_time_us = self.stats.max_reload_time_us.max(duration_us);
        if self.stats.avg_reload_time_us == 0 {
            self.stats.avg_reload_time_us = duration_us;
        } else {
            self.stats.avg_reload_time_us = (self.stats.avg_reload_time_us + duration_us) / 2;
        }

        self.logger.log(
            &LogEntry::new(
                if result.success {
                    LogLevel::Info
                } else {
                    LogLevel::Warn
                },
                "hmr",
                format!(
                    "Reload complete: success={}, binary={}, preserved={}",
                    result.success,
                    result.used_binary_serialization,
                    result.preserved_fields.len()
                ),
            )
            .with_reload_id(reload_id)
            .with_slot_id(slot.as_str())
            .with_field("duration_ms", result.duration_ms)
            .with_field("reload_class", format!("{:?}", reload_class)),
        );

        // Clear the current reload operation (v2.1)
        self.current_reload = None;
        self.stats.current_reload_id = None;

        result
    }

    /// Migrate state using binary (MessagePack) serialization
    fn migrate_binary_state(
        &mut self,
        slot: ModuleSlot,
        old_bytes: &[u8],
        new_field_names: &[String],
    ) -> Result<MigratedState, String> {
        // Create default state for new fields
        let new_defaults = MsgPackState::new(1, 0);

        let (new_bytes, result) = self.state_manager.migrate_binary(
            slot,
            old_bytes,
            new_field_names,
            &new_defaults,
            1, // from_version
            1, // to_version
        )?;

        Ok(MigratedState::Binary(new_bytes, result))
    }

    /// Migrate state using JSON serialization (fallback)
    fn migrate_json_state(
        &mut self,
        slot: ModuleSlot,
        old_json: &str,
        new_field_names: &[String],
    ) -> Result<MigratedState, String> {
        // Build new template JSON from field names
        let template_obj: serde_json::Map<String, serde_json::Value> = new_field_names
            .iter()
            .map(|name| (name.clone(), serde_json::Value::Null))
            .collect();
        let template_json = serde_json::to_string(&template_obj)
            .map_err(|e| format!("Failed to build template: {}", e))?;

        let result = self.state_manager.migrate(
            slot,
            old_json,
            &template_json,
            1, // from_version
            1, // to_version
        );

        if result.success {
            Ok(MigratedState::Json(result))
        } else {
            Err(result
                .error
                .unwrap_or_else(|| "Migration failed".to_string()))
        }
    }

    // ============================================================
    // LIBRARY-BASED STATE OPERATIONS (for runner_bin.rs integration)
    // ============================================================
    // These methods work directly with libloading::Library references,
    // allowing runner_bin.rs to delegate state save/load to the orchestrator.
    // ============================================================

    /// Save module state using the best available method (binary first, JSON fallback)
    ///
    /// # Arguments
    /// * `slot` - Module slot (Core, Gui, Main)
    /// * `lib` - Reference to the loaded library
    /// * `state_ptr` - Pointer to the state to save
    ///
    /// # Returns
    /// SavedState containing binary and/or JSON representation
    pub fn save_module_state(
        &mut self,
        slot: ModuleSlot,
        lib: &Library,
        state_ptr: *mut c_void,
    ) -> SavedState {
        let mut result = SavedState {
            binary: None,
            json: None,
            was_binary: false,
            module: slot,
        };

        if state_ptr.is_null() {
            eprintln!(
                "[Orchestrator] save_module_state: NULL state pointer for {:?}",
                slot
            );
            return result;
        }

        // Try binary save first (fast path)
        let binary_symbol = match slot {
            ModuleSlot::Core => b"core_on_save_state_binary\0".as_slice(),
            ModuleSlot::Gui => b"gui_on_save_state_binary\0".as_slice(),
            ModuleSlot::Main => b"on_save_state_binary\0".as_slice(),
        };

        unsafe {
            let save_binary: Result<
                Symbol<unsafe extern "C" fn(*mut c_void, *mut usize) -> *mut u8>,
                _,
            > = lib.get(&binary_symbol[..binary_symbol.len() - 1]);

            if let Ok(f) = save_binary {
                let mut size: usize = 0;
                let ptr = f(state_ptr, &mut size);
                if !ptr.is_null() && size > 0 {
                    let data = std::slice::from_raw_parts(ptr, size).to_vec();
                    result.binary = Some(data);
                    result.was_binary = true;
                    self.stats.binary_migrations += 1;
                    eprintln!(
                        "[Orchestrator] Binary state saved for {:?}: {} bytes",
                        slot, size
                    );

                    // Free the C-allocated buffer
                    libc::free(ptr as *mut c_void);
                    return result;
                }
            }
        }

        // Fall back to JSON save
        let json_symbol = match slot {
            ModuleSlot::Core => b"core_on_save_state\0".as_slice(),
            ModuleSlot::Gui => b"gui_on_save_state\0".as_slice(),
            ModuleSlot::Main => b"on_save_state\0".as_slice(),
        };

        unsafe {
            let save_json: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut i8>, _> =
                lib.get(&json_symbol[..json_symbol.len() - 1]);

            if let Ok(f) = save_json {
                let ptr = f(state_ptr);
                if !ptr.is_null() {
                    if let Ok(json_str) = CStr::from_ptr(ptr).to_str() {
                        result.json = Some(json_str.to_string());
                        self.stats.json_migrations += 1;
                        eprintln!(
                            "[Orchestrator] JSON state saved for {:?}: {} chars",
                            slot,
                            json_str.len()
                        );
                    }
                    libc::free(ptr as *mut c_void);
                }
            }
        }

        result
    }

    /// Load module state with automatic migration
    ///
    ///
    /// MIGRATION PRIORITY (highest to lowest):
    /// 1. Module-provided binary migration (hot_migrate in HotApi)
    /// 2. Module-provided JSON migration (on_load_from_json with version param)
    /// 3. Worker diff-and-merge (fallback, least reliable)
    ///
    /// # Arguments
    /// * `slot` - Module slot (Core, Gui, Main)
    /// * `new_lib` - Reference to the NEW library to load into
    /// * `saved` - Previously saved state from save_module_state()
    /// * `template_json` - Optional JSON template for field-level diffing
    ///
    /// # Returns
    /// LoadedState with new state pointer and migration details
    pub fn load_module_state(
        &mut self,
        slot: ModuleSlot,
        new_lib: &Library,
        saved: &SavedState,
        template_json: Option<&str>,
    ) -> LoadedState {
        let mut result = LoadedState {
            state_ptr: std::ptr::null_mut(),
            was_binary: false,
            migration_result: None,
        };

        // PRIORITY 1: Try module-provided binary migration first (fastest, most reliable)
        // The module's migrate function understands its own schema best
        if let Some(ref binary_data) = saved.binary {
            let migrate_symbol = match slot {
                ModuleSlot::Core => b"core_migrate_state\0".as_slice(),
                ModuleSlot::Gui => b"gui_migrate_state\0".as_slice(),
                ModuleSlot::Main => b"migrate_state\0".as_slice(),
            };

            unsafe {
                // Try module-provided migrate first
                let migrate_fn: Result<
                    Symbol<unsafe extern "C" fn(*const u8, usize, u32, u32) -> *mut c_void>,
                    _,
                > = new_lib.get(&migrate_symbol[..migrate_symbol.len() - 1]);

                if let Ok(f) = migrate_fn {
                    // Module-provided migration is PREFERRED
                    eprintln!(
                        "[Orchestrator] Using module-provided binary migration for {:?}",
                        slot
                    );
                    result.state_ptr = f(binary_data.as_ptr(), binary_data.len(), 0, 0);
                    if !result.state_ptr.is_null() {
                        result.was_binary = true;
                        result.migration_result = Some(MigrationSummary {
                            preserved_fields: vec!["<module-provided>".to_string()],
                            reset_fields: vec![],
                            new_fields: vec![],
                        });
                        eprintln!(
                            "[Orchestrator] Module-provided migration succeeded for {:?}",
                            slot
                        );
                        return result;
                    }
                    eprintln!(
                        "[Orchestrator] Module-provided migration returned null, falling back"
                    );
                }
            }

            // Fallback: standard binary load (no migration)
            let load_symbol = match slot {
                ModuleSlot::Core => b"core_on_load_from_binary\0".as_slice(),
                ModuleSlot::Gui => b"gui_on_load_from_binary\0".as_slice(),
                ModuleSlot::Main => b"on_load_from_binary\0".as_slice(),
            };

            unsafe {
                let load_binary: Result<
                    Symbol<unsafe extern "C" fn(*const u8, usize) -> *mut c_void>,
                    _,
                > = new_lib.get(&load_symbol[..load_symbol.len() - 1]);

                if let Ok(f) = load_binary {
                    result.state_ptr = f(binary_data.as_ptr(), binary_data.len());
                    if !result.state_ptr.is_null() {
                        result.was_binary = true;
                        eprintln!("[Orchestrator] Binary state loaded for {:?}", slot);
                        return result;
                    }
                }
            }
        }

        // PRIORITY 2: Try module-provided JSON migration
        if let Some(ref json_str) = saved.json {
            // Check if module has versioned JSON migration
            let migrate_json_symbol = match slot {
                ModuleSlot::Core => b"core_migrate_from_json\0".as_slice(),
                ModuleSlot::Gui => b"gui_migrate_from_json\0".as_slice(),
                ModuleSlot::Main => b"migrate_from_json\0".as_slice(),
            };

            unsafe {
                let migrate_json: Result<
                    Symbol<unsafe extern "C" fn(*const i8, u32, u32) -> *mut c_void>,
                    _,
                > = new_lib.get(&migrate_json_symbol[..migrate_json_symbol.len() - 1]);

                if let Ok(f) = migrate_json {
                    eprintln!(
                        "[Orchestrator] Using module-provided JSON migration for {:?}",
                        slot
                    );
                    if let Ok(cstring) = CString::new(json_str.as_str()) {
                        result.state_ptr = f(cstring.as_ptr(), 0, 0);
                        if !result.state_ptr.is_null() {
                            result.migration_result = Some(MigrationSummary {
                                preserved_fields: vec!["<module-provided>".to_string()],
                                reset_fields: vec![],
                                new_fields: vec![],
                            });
                            eprintln!(
                                "[Orchestrator] Module-provided JSON migration succeeded for {:?}",
                                slot
                            );
                            return result;
                        }
                    }
                }
            }

            // PRIORITY 3 (FALLBACK): Worker diff-and-merge
            // This is LESS RELIABLE because the worker guesses at field semantics
            eprintln!("[Orchestrator] WARNING: Using worker diff-merge for {:?} (module migration unavailable)", slot);

            let final_json = if let Some(template) = template_json {
                match self.diff_and_migrate_json(slot, json_str, template) {
                    Ok((migrated, summary)) => {
                        result.migration_result = Some(summary);
                        migrated
                    }
                    Err(e) => {
                        eprintln!(
                            "[Orchestrator] JSON migration failed: {}, using original",
                            e
                        );
                        eprintln!(
                            "[Orchestrator] Worker diff failed: {}, using original JSON",
                            e
                        );
                        json_str.clone()
                    }
                }
            } else {
                json_str.clone()
            };

            let load_symbol = match slot {
                ModuleSlot::Core => b"core_on_load_from_json\0".as_slice(),
                ModuleSlot::Gui => b"gui_on_load_from_json\0".as_slice(),
                ModuleSlot::Main => b"on_load_from_json\0".as_slice(),
            };

            unsafe {
                let load_json: Result<Symbol<unsafe extern "C" fn(*const i8) -> *mut c_void>, _> =
                    new_lib.get(&load_symbol[..load_symbol.len() - 1]);

                if let Ok(f) = load_json {
                    if let Ok(cstring) = CString::new(final_json) {
                        result.state_ptr = f(cstring.as_ptr());
                        eprintln!("[Orchestrator] JSON state loaded for {:?}", slot);
                    }
                }
            }
        }

        result
    }

    /// Internal: Perform JSON diff and merge with config
    fn diff_and_migrate_json(
        &self,
        slot: ModuleSlot,
        old_json: &str,
        template_json: &str,
    ) -> Result<(String, MigrationSummary), String> {
        let config = match slot {
            ModuleSlot::Core => DiffConfig::for_core(),
            ModuleSlot::Gui => DiffConfig::for_gui(),
            ModuleSlot::Main => DiffConfig::new(),
        };

        let (merged_str, diff_result) =
            migrate_state_with_config(old_json, template_json, &config)?;

        let summary = MigrationSummary {
            preserved_fields: diff_result.preserved_fields.clone(),
            reset_fields: diff_result.reset_fields.clone(),
            new_fields: diff_result.new_fields.clone(),
        };

        Ok((merged_str, summary))
    }

    /// Get a template JSON from a fresh state (for field-level diffing)
    pub fn get_template_json(&self, slot: ModuleSlot, lib: &Library) -> Option<String> {
        // Get on_load to create fresh state
        let load_symbol = match slot {
            ModuleSlot::Core => b"core_on_load\0".as_slice(),
            ModuleSlot::Gui => b"gui_on_load\0".as_slice(),
            ModuleSlot::Main => b"on_load\0".as_slice(),
        };

        // Get save_to_json to serialize
        let save_symbol = match slot {
            ModuleSlot::Core => b"core_on_save_to_json\0".as_slice(),
            ModuleSlot::Gui => b"gui_on_save_to_json\0".as_slice(),
            ModuleSlot::Main => b"on_save_to_json\0".as_slice(),
        };

        // Get unload to clean up
        let unload_symbol = match slot {
            ModuleSlot::Core => b"core_on_unload\0".as_slice(),
            ModuleSlot::Gui => b"gui_on_unload\0".as_slice(),
            ModuleSlot::Main => b"on_unload\0".as_slice(),
        };

        unsafe {
            let load_fn: Result<
                Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void>,
                _,
            > = lib.get(&load_symbol[..load_symbol.len() - 1]);
            let save_fn: Result<Symbol<unsafe extern "C" fn(*mut c_void) -> *mut i8>, _> =
                lib.get(&save_symbol[..save_symbol.len() - 1]);

            if let (Ok(load), Ok(save)) = (load_fn, save_fn) {
                // Create fresh state
                let template_state = load(std::ptr::null_mut(), std::ptr::null_mut());
                if template_state.is_null() {
                    return None;
                }

                // Serialize to JSON
                let json_ptr = save(template_state);
                let result = if !json_ptr.is_null() {
                    CStr::from_ptr(json_ptr)
                        .to_str()
                        .ok()
                        .map(|s| s.to_string())
                } else {
                    None
                };

                // Clean up
                if !json_ptr.is_null() {
                    libc::free(json_ptr as *mut c_void);
                }

                let unload_fn: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                    lib.get(&unload_symbol[..unload_symbol.len() - 1]);
                if let Ok(unload) = unload_fn {
                    unload(template_state);
                }

                return result;
            }
        }

        None
    }

    /// Check schema hash compatibility between old and new module
    pub fn check_schema_compatibility(
        &self,
        slot: ModuleSlot,
        old_lib: &Library,
        new_lib: &Library,
    ) -> SchemaCompatibility {
        let get_hash_symbol = match slot {
            ModuleSlot::Core => b"core_get_state_schema_hash\0".as_slice(),
            ModuleSlot::Gui => b"gui_get_state_schema_hash\0".as_slice(),
            ModuleSlot::Main => b"get_state_schema_hash\0".as_slice(),
        };

        unsafe {
            let old_hash_fn: Result<Symbol<unsafe extern "C" fn() -> u64>, _> =
                old_lib.get(&get_hash_symbol[..get_hash_symbol.len() - 1]);
            let new_hash_fn: Result<Symbol<unsafe extern "C" fn() -> u64>, _> =
                new_lib.get(&get_hash_symbol[..get_hash_symbol.len() - 1]);

            match (old_hash_fn.ok(), new_hash_fn.ok()) {
                (Some(old_fn), Some(new_fn)) => {
                    let old_hash = old_fn();
                    let new_hash = new_fn();
                    if old_hash == new_hash {
                        SchemaCompatibility::Compatible { hash: old_hash }
                    } else {
                        SchemaCompatibility::Incompatible { old_hash, new_hash }
                    }
                }
                (Some(old_fn), None) => SchemaCompatibility::NewMissing { old_hash: old_fn() },
                (None, Some(new_fn)) => SchemaCompatibility::OldMissing { new_hash: new_fn() },
                (None, None) => SchemaCompatibility::NeitherHasHash,
            }
        }
    }

    // ============================================================
    // CRASH RECOVERY
    // ============================================================

    /// Report a crash and get recovery action
    pub fn report_crash(&mut self, crash_info: &CrashInfo) -> RecoveryAction {
        let action = self.crash_supervisor.report_crash(crash_info);

        match action {
            RecoveryAction::HotReload => {
                eprintln!("[Orchestrator] Crash recovery: attempting hot reload");
            }
            RecoveryAction::Rollback => {
                eprintln!("[Orchestrator] Crash recovery: rolling back to snapshot");
                if let Some(snapshot) = self.snapshot_manager.latest_valid() {
                    eprintln!("[Orchestrator] Using snapshot {}", snapshot.snapshot_id);
                    self.stats.snapshots_reverted += 1;
                }
            }
            RecoveryAction::CleanRestart => {
                eprintln!("[Orchestrator] Crash recovery: clean restart required");
            }
            RecoveryAction::FullRestart => {
                eprintln!("[Orchestrator] Crash recovery: FULL RESTART required");
            }
            RecoveryAction::Fatal => {
                eprintln!("[Orchestrator] Crash recovery: FATAL - no recovery possible");
            }
        }

        self.stats.crashes_recovered += 1;
        action
    }

    /// Revert to a previous snapshot
    pub fn revert_to_snapshot(&mut self, snapshot_id: u64) -> Result<&ReloadSnapshot, String> {
        let snapshot = self.snapshot_manager.revert_to_snapshot(snapshot_id)?;
        self.stats.snapshots_reverted += 1;
        Ok(snapshot)
    }

    /// Check if we should force a full restart
    pub fn should_force_restart(&self) -> bool {
        self.crash_supervisor.should_force_restart()
    }

    // ============================================================
    // BOUNDARY MANAGEMENT
    // ============================================================

    /// Plan a partial reload based on what changed
    pub fn plan_reload(&self, changes: &ReloadChanges) -> ReloadPlan {
        // If no boundary manifest, require full reload
        let Some(boundary_id) = &changes.boundary_id else {
            return ReloadPlan::full_reload("No boundary information");
        };

        let Some(boundary) = self.active_boundaries.get(boundary_id) else {
            return ReloadPlan::full_reload(format!("Unknown boundary: {}", boundary_id));
        };

        // Check if boundary supports independent reload
        if !boundary.boundary_type.supports_independent_reload() {
            return ReloadPlan::full_reload(format!(
                "Boundary type {:?} requires full reload",
                boundary.boundary_type
            ));
        }

        // Plan partial reload
        let mut plan = ReloadPlan::partial(vec![boundary_id.clone()]);

        // Add cascade dependencies if needed
        if boundary.boundary_type.cascades_to_dependents() {
            for (id, b) in &self.active_boundaries {
                if b.dependencies.contains(boundary_id) {
                    plan.cascade_changes.push(id.clone());
                }
            }
        }

        plan
    }

    /// Update boundary content hash after reload
    pub fn update_boundary_hash(&mut self, boundary_id: &BoundaryId, new_hash: u64) {
        if let Some(boundary) = self.active_boundaries.get_mut(boundary_id) {
            boundary.content_hash = new_hash;
            boundary.last_reload_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
        }
    }

    // ============================================================
    // ASYNC TASK MANAGEMENT
    // ============================================================

    /// Register an async task
    pub fn register_task(
        &mut self,
        task_id: String,
        boundary_id: BoundaryId,
        supports_checkpoint: bool,
    ) -> Arc<AtomicBool> {
        use crate::hmr::reload_manager::AsyncTaskType;
        self.task_registry.register(
            task_id,
            AsyncTaskType::BackgroundComputation,
            boundary_id,
            supports_checkpoint,
            false, // supports_pause
        )
    }

    /// Unregister a task
    pub fn unregister_task(&mut self, task_id: &str) {
        self.task_registry.unregister(task_id);
    }

    // ============================================================
    // STATISTICS AND DIAGNOSTICS
    // ============================================================

    /// Get orchestrator statistics
    pub fn get_stats(&self) -> &OrchestratorStats {
        &self.stats
    }

    /// Get crash report
    pub fn get_crash_report(&self) -> String {
        self.crash_supervisor.generate_report()
    }

    /// Get HMR status for frontend
    pub fn get_status(&self, result: &HmrResult) -> HmrStatus {
        let mut status: HmrStatus = result.into();
        status.crash_count = self.crash_supervisor.get_stats().total_crashes;
        status.snapshot_available = self.snapshot_manager.latest_valid().is_some();
        status
    }

    // ============================================================
    // FAST REFRESH BOUNDARY CHECKING
    // ============================================================

    /// Check if source changes cross HMR boundaries (Fast Refresh style)
    /// Returns violations that may prevent hot reload
    pub fn check_fast_refresh_boundaries(
        &mut self,
        module_name: &str,
        new_source: &str,
    ) -> BoundaryCheckResult {
        if !self.fast_refresh_enabled {
            // Skip boundary checking if disabled
            return BoundaryCheckResult {
                can_hmr: true,
                violations: vec![],
                summary: "Fast Refresh checking disabled".to_string(),
                action: RefreshAction::HotReload,
            };
        }

        let result = self
            .boundary_checker
            .check_boundaries(module_name, new_source);

        // Log violations
        if !result.violations.is_empty() {
            eprintln!(
                "[Orchestrator] Fast Refresh boundary check for '{}': {} violation(s)",
                module_name,
                result.violations.len()
            );
            for violation in &result.violations {
                use crate::hmr::fast_refresh::BoundaryViolation;
                let v: &BoundaryViolation = violation;
                eprintln!("  - {}", v.message());
            }
        }

        // Update source cache on successful check
        if result.can_hmr {
            self.source_cache
                .insert(module_name.to_string(), new_source.to_string());
        }

        result
    }

    /// Get boundary violation event for frontend notification
    pub fn get_boundary_violation_event(
        &self,
        module_name: &str,
        result: &BoundaryCheckResult,
    ) -> BoundaryViolationEvent {
        BoundaryViolationEvent::from_check(module_name, result)
    }

    /// Update Fast Refresh baseline after successful HMR
    pub fn update_fast_refresh_baseline(&mut self, module_name: &str, source: &str) {
        self.boundary_checker.update_baseline(module_name, source);
        self.source_cache
            .insert(module_name.to_string(), source.to_string());
    }

    /// Clear Fast Refresh state for a module
    pub fn clear_fast_refresh_module(&mut self, module_name: &str) {
        self.boundary_checker.clear_module(module_name);
        self.source_cache.remove(module_name);
    }

    // ============================================================
    // SOURCE MAP INTEGRATION
    // ============================================================

    /// Load source map for a library (for crash location resolution)
    pub fn load_source_map(&self, lib_path: &Path) -> Result<(), String> {
        SOURCE_MAP_CACHE.load(lib_path)
    }

    /// Invalidate source map cache for a library (call after rebuild)
    pub fn invalidate_source_map(&self, lib_path: &Path) {
        SOURCE_MAP_CACHE.invalidate(lib_path);
    }

    /// Get source-mapped crash location
    pub fn resolve_crash_location(
        &self,
        lib_path: &Path,
        address: u64,
    ) -> Option<crate::compiler::source_map::SourceLocation> {
        SOURCE_MAP_CACHE.resolve(lib_path, address)
    }

    // ============================================================
    // CONFIGURATION
    // ============================================================

    /// Enable/disable binary state serialization
    pub fn set_binary_state(&mut self, enabled: bool) {
        self.binary_state_enabled = enabled;
        eprintln!(
            "[Orchestrator] Binary state serialization: {}",
            if enabled { "ENABLED" } else { "DISABLED" }
        );
    }

    /// Enable/disable strict ABI validation
    pub fn set_strict_abi(&mut self, enabled: bool) {
        self.strict_abi_validation = enabled;
    }

    /// Enable/disable snapshots
    pub fn set_snapshots(&mut self, enabled: bool) {
        self.snapshot_enabled = enabled;
    }

    /// Enable/disable Fast Refresh boundary checking
    pub fn set_fast_refresh(&mut self, enabled: bool) {
        self.fast_refresh_enabled = enabled;
        eprintln!(
            "[Orchestrator] Fast Refresh boundary checking: {}",
            if enabled { "ENABLED" } else { "DISABLED" }
        );
    }

    /// Set reload class override for a boundary
    pub fn set_reload_class_override(&mut self, boundary_id: BoundaryId, class: ReloadClass) {
        self.reload_classifier
            .set_boundary_override(boundary_id, class);
    }

    // ============================================================
    // OBSERVABILITY ACCESSORS (v2.1)
    // ============================================================

    /// Get reload metrics
    pub fn get_reload_metrics(&self) -> &crate::infra::observability::ReloadMetrics {
        self.metrics_aggregator.get_metrics()
    }

    /// Get current reload ID (if a reload is in progress)
    pub fn current_reload_id(&self) -> Option<u64> {
        self.stats.current_reload_id
    }

    /// Initialize quiescence manager if needed (v2.1)
    pub fn init_quiescence(&mut self) {
        if self.quiescence_manager.is_none() {
            self.quiescence_manager = Some(QuiescenceManager::new(QuiescenceConfig::default()));
            self.logger.log(&LogEntry::new(
                LogLevel::Info,
                "orchestrator",
                "Quiescence manager initialized",
            ));
        }
    }

    /// Get quiescence manager reference (v2.1)
    pub fn quiescence_manager(&mut self) -> Option<&mut QuiescenceManager> {
        self.quiescence_manager.as_mut()
    }
}

impl Default for HmrOrchestrator {
    fn default() -> Self {
        Self::new()
    }
}

/// Migrated state result
#[allow(dead_code)]
enum MigratedState {
    Binary(Vec<u8>, SchemaMigrationResult),
    Json(MigrationResult),
    None,
}

// ============================================================
// ASYNC TASK REGISTRY EXTENSIONS
// ============================================================

impl AsyncTaskRegistry {
    /// Register a task and return its shutdown signal
    pub fn register_task(
        &mut self,
        task_id: String,
        boundary_id: BoundaryId,
        supports_checkpoint: bool,
    ) -> Arc<AtomicBool> {
        use crate::hmr::reload_manager::AsyncTaskType;

        self.register(
            task_id,
            AsyncTaskType::BackgroundComputation,
            boundary_id,
            supports_checkpoint,
            false,
        )
    }

    /// Unregister a task
    pub fn unregister_task(&mut self, task_id: &str) {
        self.unregister(task_id);
    }

    /// Shutdown all tasks for a boundary
    pub fn shutdown_boundary(&mut self, boundary_id: &str) {
        let boundary_id: BoundaryId = boundary_id.to_string();
        let task_ids: Vec<String> = self
            .tasks_for_boundary(&boundary_id)
            .into_iter()
            .map(|t| t.task_id.clone())
            .collect();

        self.signal_shutdown(&task_ids);
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_orchestrator_creation() {
        let orchestrator = HmrOrchestrator::new();
        assert!(orchestrator.binary_state_enabled);
        assert!(orchestrator.fast_refresh_enabled);
    }

    #[test]
    fn test_reload_classification() {
        let orchestrator = HmrOrchestrator::new();
        let changes = ReloadChanges::default();
        let class = orchestrator.reload_classifier.classify(&changes);
        assert_eq!(class, ReloadClass::Warm);
    }

    #[test]
    fn test_hmr_result() {
        let result = HmrResult::success(ModuleSlot::Core, ReloadClass::Safe);
        assert!(result.success);
        assert!(!result.used_binary_serialization);
    }

    #[test]
    fn test_fast_refresh_integration() {
        let mut orchestrator = HmrOrchestrator::new();

        // First check establishes baseline
        let source1 = r#"
            extern "C" void* core_on_load(void* prev, void* ctx) { return prev; }
            extern "C" void core_on_update(void* state, double dt) { }
        "#;
        let result1 = orchestrator.check_fast_refresh_boundaries("core", source1);
        assert!(result1.can_hmr);

        // Same source should still be safe
        let result2 = orchestrator.check_fast_refresh_boundaries("core", source1);
        assert!(result2.can_hmr);
    }

    #[test]
    fn test_source_map_integration() {
        let orchestrator = HmrOrchestrator::new();
        // Source map operations should not panic even on non-existent files
        let path = std::path::Path::new("/nonexistent/lib.so");
        let result = orchestrator.resolve_crash_location(path, 0x1234);
        assert!(result.is_none());
    }
}
