#![allow(dead_code)]
#![allow(unused_imports)]

// ============================================================
// STATE MANAGER
// ============================================================
// Manages module state lifecycle, migration, and persistence.
// Part of the split runner responsibilities pattern.
//
// RESPONSIBILITIES:
// - Track state for each module/boundary
// - Coordinate state migration during HMR
// - Validate state invariants
// - Handle state persistence and restoration
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr;
use std::sync::Arc;

use crate::plugin_contract::ModuleSlot;
use crate::state_diff::{DiffConfig, DiffResult, diff_and_merge};
use crate::boundary::BoundaryId;

/// State pointer wrapper with metadata
#[derive(Debug, Clone)]
pub struct StateHandle {
    /// Raw pointer to state
    ptr: usize,
    /// Module this state belongs to
    module: ModuleSlot,
    /// Boundary within module (if using sub-module boundaries)
    boundary: Option<BoundaryId>,
    /// ABI version of the module that created this state
    abi_version: u32,
    /// Content hash of source when state was created
    source_hash: u64,
    /// JSON snapshot (if serializable)
    json_snapshot: Option<String>,
    /// Creation timestamp
    created_at: std::time::Instant,
    /// Last access timestamp
    last_access: std::time::Instant,
}

impl StateHandle {
    pub fn new(ptr: *mut c_void, module: ModuleSlot, abi_version: u32, source_hash: u64) -> Self {
        let now = std::time::Instant::now();
        Self {
            ptr: ptr as usize,
            module,
            boundary: None,
            abi_version,
            source_hash,
            json_snapshot: None,
            created_at: now,
            last_access: now,
        }
    }

    pub fn with_boundary(mut self, boundary: BoundaryId) -> Self {
        self.boundary = Some(boundary);
        self
    }

    pub fn with_json_snapshot(mut self, json: String) -> Self {
        self.json_snapshot = Some(json);
        self
    }

    pub fn as_ptr(&self) -> *mut c_void {
        self.ptr as *mut c_void
    }

    pub fn touch(&mut self) {
        self.last_access = std::time::Instant::now();
    }
}

/// Migration schema for state transitions
/// NOW WITH EXPLICIT VERSIONING AND DOWNGRADE PATHS
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationSchema {
    /// Schema version identifier
    pub schema_version: SchemaVersion,
    /// Source ABI version
    pub from_version: u32,
    /// Target ABI version
    pub to_version: u32,
    /// Fields to preserve
    pub preserve_fields: Vec<String>,
    /// Fields to reset
    pub reset_fields: Vec<String>,
    /// Field renames (old_name -> new_name)
    pub renames: HashMap<String, String>,
    /// Default values for new fields
    pub defaults: HashMap<String, serde_json::Value>,
    /// DOWNGRADE path - how to revert to previous version
    pub downgrade: Option<DowngradePath>,
    /// Whether this migration is reversible
    pub reversible: bool,
}

/// Explicit schema version with semantic versioning
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SchemaVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl SchemaVersion {
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self { major, minor, patch }
    }
    
    /// Check if this version can upgrade to target
    pub fn can_upgrade_to(&self, target: &SchemaVersion) -> bool {
        // Can upgrade within same major version, or to next major
        target.major >= self.major && 
        (target.major == self.major || target.major == self.major + 1)
    }
    
    /// Check if this version can downgrade to target
    pub fn can_downgrade_to(&self, target: &SchemaVersion) -> bool {
        // Can only downgrade within same major version
        target.major == self.major && target.minor <= self.minor
    }
}

impl std::fmt::Display for SchemaVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl Default for SchemaVersion {
    fn default() -> Self {
        Self::new(1, 0, 0)
    }
}

/// Downgrade path specification
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DowngradePath {
    /// Target version after downgrade
    pub target_version: SchemaVersion,
    /// Fields that will be lost in downgrade
    pub lost_fields: Vec<String>,
    /// Fields that need transformation
    pub transformations: HashMap<String, FieldTransformation>,
    /// Pre-downgrade validation
    pub pre_validation: Vec<String>,
    /// Whether data loss is acceptable
    pub allows_data_loss: bool,
}

/// Field transformation for migration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FieldTransformation {
    /// Remove the field
    Remove,
    /// Rename to another field
    Rename(String),
    /// Transform value using expression
    Transform(String),
    /// Set to default value
    Default(serde_json::Value),
    /// Merge into another field
    MergeInto(String),
}

impl MigrationSchema {
    pub fn identity(version: u32) -> Self {
        Self {
            schema_version: SchemaVersion::new(version, 0, 0),
            from_version: version,
            to_version: version,
            preserve_fields: vec![],
            reset_fields: vec![],
            renames: HashMap::new(),
            defaults: HashMap::new(),
            downgrade: None,
            reversible: true,
        }
    }
    
    /// Create a new migration schema with explicit versioning
    pub fn new(from: SchemaVersion, to: SchemaVersion) -> Self {
        Self {
            schema_version: to,
            from_version: from.major * 1000 + from.minor,
            to_version: to.major * 1000 + to.minor,
            preserve_fields: vec![],
            reset_fields: vec![],
            renames: HashMap::new(),
            defaults: HashMap::new(),
            downgrade: None,
            reversible: false,
        }
    }
    
    /// Add a downgrade path - REQUIRED for forward compatibility
    pub fn with_downgrade(mut self, path: DowngradePath) -> Self {
        self.downgrade = Some(path);
        self.reversible = true;
        self
    }
    
    /// Check if this schema can be safely applied
    pub fn validate(&self) -> Result<(), String> {
        // Must have downgrade path for non-identity migrations
        if self.from_version != self.to_version && self.downgrade.is_none() {
            return Err(format!(
                "Migration from {} to {} requires a downgrade path",
                self.from_version, self.to_version
            ));
        }
        
        // Check that renames don't conflict with preserve/reset
        for old_name in self.renames.keys() {
            if self.reset_fields.contains(old_name) {
                return Err(format!("Field '{}' cannot be both renamed and reset", old_name));
            }
        }
        
        Ok(())
    }
}

/// Result of state migration
#[derive(Debug, Clone)]
pub struct MigrationResult {
    pub success: bool,
    pub new_state_json: Option<String>,
    pub preserved_fields: Vec<String>,
    pub reset_fields: Vec<String>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

impl MigrationResult {
    pub fn success(json: String, diff: &DiffResult) -> Self {
        Self {
            success: true,
            new_state_json: Some(json),
            preserved_fields: diff.preserved_fields.clone(),
            reset_fields: diff.reset_fields.clone(),
            error: None,
            duration_ms: 0,
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            success: false,
            new_state_json: None,
            preserved_fields: vec![],
            reset_fields: vec![],
            error: Some(error.into()),
            duration_ms: 0,
        }
    }
}

/// State invariant checker
pub trait StateInvariant: Send + Sync {
    /// Check if state satisfies the invariant
    fn check(&self, state_json: &serde_json::Value) -> Result<(), String>;
    
    /// Name of the invariant for error messages
    fn name(&self) -> &str;
}

/// Common invariant: required fields must exist
pub struct RequiredFieldsInvariant {
    fields: Vec<String>,
}

impl RequiredFieldsInvariant {
    pub fn new(fields: Vec<String>) -> Self {
        Self { fields }
    }
}

impl StateInvariant for RequiredFieldsInvariant {
    fn check(&self, state_json: &serde_json::Value) -> Result<(), String> {
        for field in &self.fields {
            if state_json.get(field).is_none() {
                return Err(format!("Required field '{}' missing", field));
            }
        }
        Ok(())
    }

    fn name(&self) -> &str {
        "RequiredFields"
    }
}

/// Common invariant: magic number validation
pub struct MagicNumberInvariant {
    field: String,
    expected: u32,
}

impl MagicNumberInvariant {
    pub fn new(field: impl Into<String>, expected: u32) -> Self {
        Self {
            field: field.into(),
            expected,
        }
    }
}

impl StateInvariant for MagicNumberInvariant {
    fn check(&self, state_json: &serde_json::Value) -> Result<(), String> {
        if let Some(value) = state_json.get(&self.field) {
            if let Some(num) = value.as_u64() {
                if num as u32 == self.expected {
                    return Ok(());
                }
                return Err(format!(
                    "Magic number mismatch: expected {}, got {}",
                    self.expected, num
                ));
            }
        }
        Err(format!("Magic number field '{}' not found or invalid", self.field))
    }

    fn name(&self) -> &str {
        "MagicNumber"
    }
}

/// State manager coordinates all state operations
/// REQUIRES EXPLICIT VERSIONING AND DOWNGRADE PATHS
pub struct StateManager {
    /// Current state handles per module
    states: HashMap<ModuleSlot, StateHandle>,
    /// Boundary-level states
    boundary_states: HashMap<BoundaryId, StateHandle>,
    /// Migration schemas indexed by (from_version, to_version)
    migration_schemas: HashMap<(u32, u32), MigrationSchema>,
    /// State invariants per module
    invariants: HashMap<ModuleSlot, Vec<Box<dyn StateInvariant>>>,
    /// State history for rollback
    state_history: HashMap<ModuleSlot, Vec<StateHandle>>,
    /// Maximum history depth
    max_history: usize,
    /// Registered schema versions per module
    schema_versions: HashMap<ModuleSlot, SchemaVersion>,
    /// Whether to enforce downgrade path requirements
    require_downgrade_paths: bool,
}

impl StateManager {
    pub fn new() -> Self {
        Self {
            states: HashMap::new(),
            boundary_states: HashMap::new(),
            migration_schemas: HashMap::new(),
            invariants: HashMap::new(),
            state_history: HashMap::new(),
            max_history: 5,
            schema_versions: HashMap::new(),
            require_downgrade_paths: true,  // ENFORCE BY DEFAULT
        }
    }
    
    /// Create without downgrade enforcement (for testing only)
    #[cfg(test)]
    pub fn new_without_downgrade_enforcement() -> Self {
        let mut mgr = Self::new();
        mgr.require_downgrade_paths = false;
        mgr
    }
    
    /// Register current schema version for a module
    pub fn register_schema_version(&mut self, module: ModuleSlot, version: SchemaVersion) {
        self.schema_versions.insert(module, version);
    }
    
    /// Get current schema version for a module
    pub fn get_schema_version(&self, module: ModuleSlot) -> Option<&SchemaVersion> {
        self.schema_versions.get(&module)
    }

    /// Register a state handle for a module
    pub fn register_state(&mut self, handle: StateHandle) {
        let module = handle.module;
        
        // Move current to history if exists
        if let Some(current) = self.states.remove(&module) {
            let history = self.state_history.entry(module).or_insert_with(Vec::new);
            history.insert(0, current);
            
            // Trim history
            while history.len() > self.max_history {
                history.pop();
            }
        }
        
        self.states.insert(module, handle);
    }

    /// Register a boundary-level state
    pub fn register_boundary_state(&mut self, boundary: BoundaryId, handle: StateHandle) {
        self.boundary_states.insert(boundary, handle);
    }

    /// Get current state for a module
    pub fn get_state(&mut self, module: ModuleSlot) -> Option<&mut StateHandle> {
        self.states.get_mut(&module).map(|h| {
            h.touch();
            h
        })
    }

    /// Get boundary state
    pub fn get_boundary_state(&mut self, boundary: &BoundaryId) -> Option<&mut StateHandle> {
        self.boundary_states.get_mut(boundary).map(|h| {
            h.touch();
            h
        })
    }

    /// Register a migration schema - VALIDATES DOWNGRADE PATH REQUIREMENT
    pub fn register_migration(&mut self, schema: MigrationSchema) -> Result<(), String> {
        // Validate schema
        schema.validate()?;
        
        // Enforce downgrade path requirement
        if self.require_downgrade_paths && 
           schema.from_version != schema.to_version && 
           schema.downgrade.is_none() 
        {
            return Err(format!(
                "Migration from v{} to v{} rejected: downgrade path required",
                schema.from_version, schema.to_version
            ));
        }
        
        self.migration_schemas.insert(
            (schema.from_version, schema.to_version),
            schema,
        );
        Ok(())
    }
    
    /// Register migration without downgrade validation (legacy support)
    #[deprecated(note = "Use register_migration() with downgrade path")]
    pub fn register_migration_unchecked(&mut self, schema: MigrationSchema) {
        self.migration_schemas.insert(
            (schema.from_version, schema.to_version),
            schema,
        );
    }

    /// Register an invariant for a module
    pub fn add_invariant(&mut self, module: ModuleSlot, invariant: Box<dyn StateInvariant>) {
        self.invariants
            .entry(module)
            .or_insert_with(Vec::new)
            .push(invariant);
    }

    /// Migrate state from old version to new version
    pub fn migrate(
        &mut self,
        module: ModuleSlot,
        old_state_json: &str,
        new_template_json: &str,
        from_version: u32,
        to_version: u32,
    ) -> MigrationResult {
        let start = std::time::Instant::now();
        
        // 1. Parse JSON
        let old_state: serde_json::Value = match serde_json::from_str(old_state_json) {
            Ok(v) => v,
            Err(e) => return MigrationResult::failure(format!("Failed to parse old state: {}", e)),
        };
        
        let new_template: serde_json::Value = match serde_json::from_str(new_template_json) {
            Ok(v) => v,
            Err(e) => return MigrationResult::failure(format!("Failed to parse new template: {}", e)),
        };

        // 2. Get migration schema (or use identity)
        let schema = self.migration_schemas
            .get(&(from_version, to_version))
            .cloned()
            .unwrap_or_else(|| MigrationSchema::identity(to_version));
        
        // 2.5 ENFORCE: Non-identity migrations must have been registered with downgrade path
        if self.require_downgrade_paths && 
           from_version != to_version && 
           schema.downgrade.is_none() 
        {
            return MigrationResult::failure(format!(
                "Cannot migrate from v{} to v{}: no downgrade path registered. \
                Register migration schema with downgrade path first.",
                from_version, to_version
            ));
        }

        // 3. Apply field renames
        let mut old_renamed = old_state.clone();
        if let Some(obj) = old_renamed.as_object_mut() {
            for (old_name, new_name) in &schema.renames {
                if let Some(value) = obj.remove(old_name) {
                    obj.insert(new_name.clone(), value);
                }
            }
        }

        // 4. Diff and merge
        let diff_config = match module {
            ModuleSlot::Core => DiffConfig::for_core(),
            ModuleSlot::Gui => DiffConfig::for_gui(),
            _ => DiffConfig::new(),
        };
        
        let diff = diff_and_merge(&old_renamed, &new_template, &diff_config);

        // 5. Apply defaults for new fields
        let mut merged = diff.merged_state.clone();
        if let Some(obj) = merged.as_object_mut() {
            for (field, default) in &schema.defaults {
                if !obj.contains_key(field) {
                    obj.insert(field.clone(), default.clone());
                }
            }
        }

        // 6. Validate invariants
        if let Err(e) = self.validate_invariants(module, &merged) {
            return MigrationResult::failure(format!("Invariant violation: {}", e));
        }

        // 7. Serialize result
        let result_json = match serde_json::to_string(&merged) {
            Ok(s) => s,
            Err(e) => return MigrationResult::failure(format!("Failed to serialize: {}", e)),
        };

        let mut result = MigrationResult::success(result_json, &diff);
        result.duration_ms = start.elapsed().as_millis() as u64;
        result
    }

    /// Validate state against all registered invariants
    pub fn validate_invariants(
        &self,
        module: ModuleSlot,
        state: &serde_json::Value,
    ) -> Result<(), String> {
        if let Some(invariants) = self.invariants.get(&module) {
            for invariant in invariants {
                if let Err(e) = invariant.check(state) {
                    return Err(format!("{}: {}", invariant.name(), e));
                }
            }
        }
        Ok(())
    }

    /// Rollback to previous state
    pub fn rollback(&mut self, module: ModuleSlot) -> Option<StateHandle> {
        let history = self.state_history.get_mut(&module)?;
        if history.is_empty() {
            return None;
        }

        let previous = history.remove(0);
        
        // Swap current with previous
        if let Some(current) = self.states.remove(&module) {
            history.insert(0, current);
        }
        
        self.states.insert(module, previous.clone());
        Some(previous)
    }

    /// Clear state for a module
    pub fn clear(&mut self, module: ModuleSlot) {
        self.states.remove(&module);
    }

    /// Clear all boundary states for a module
    pub fn clear_boundary_states(&mut self, parent_module: &str) {
        self.boundary_states.retain(|k, _| !k.starts_with(parent_module));
    }

    /// Get state statistics
    pub fn get_stats(&self) -> StateManagerStats {
        StateManagerStats {
            module_states: self.states.len(),
            boundary_states: self.boundary_states.len(),
            history_depth: self.state_history.values().map(|v| v.len()).sum(),
            invariants_registered: self.invariants.values().map(|v| v.len()).sum(),
        }
    }
}

impl Default for StateManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Statistics for state manager
#[derive(Debug, Clone)]
pub struct StateManagerStats {
    pub module_states: usize,
    pub boundary_states: usize,
    pub history_depth: usize,
    pub invariants_registered: usize,
}

/// Interface trait for state management (for dependency injection/testing)
pub trait StateManagerInterface: Send + Sync {
    fn register_state(&mut self, handle: StateHandle);
    fn get_state(&mut self, module: ModuleSlot) -> Option<*mut c_void>;
    fn migrate(
        &mut self,
        module: ModuleSlot,
        old_state_json: &str,
        new_template_json: &str,
        from_version: u32,
        to_version: u32,
    ) -> MigrationResult;
    fn rollback(&mut self, module: ModuleSlot) -> bool;
}

impl StateManagerInterface for StateManager {
    fn register_state(&mut self, handle: StateHandle) {
        StateManager::register_state(self, handle)
    }

    fn get_state(&mut self, module: ModuleSlot) -> Option<*mut c_void> {
        StateManager::get_state(self, module).map(|h| h.as_ptr())
    }

    fn migrate(
        &mut self,
        module: ModuleSlot,
        old_state_json: &str,
        new_template_json: &str,
        from_version: u32,
        to_version: u32,
    ) -> MigrationResult {
        StateManager::migrate(self, module, old_state_json, new_template_json, from_version, to_version)
    }

    fn rollback(&mut self, module: ModuleSlot) -> bool {
        StateManager::rollback(self, module).is_some()
    }
}
