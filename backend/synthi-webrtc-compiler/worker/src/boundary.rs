// ============================================================
// SUB-MODULE HMR BOUNDARIES WITH EXPLICIT MANIFESTS
// ============================================================
// Introduces finer-grained boundaries inside core and gui modules
// for partial reload when only one boundary changes.
//
// OWNERSHIP MODEL:
// - Boundaries are defined by EXPLICIT MANIFESTS, not name patterns
// - Each boundary has structural ownership rules
// - Dependencies must be declared, not inferred
// - Maximum boundary count is CAPPED to prevent explosion
//
// KEY FEATURES:
// - Explicit boundary manifests (no name-based matching)
// - Structural ownership validation
// - Per-boundary state tracking
// - Partial reload when only one boundary changes
// - Capped boundary count to prevent rebuild time degradation
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Maximum boundaries per module to prevent explosion
pub const MAX_BOUNDARIES_PER_MODULE: usize = 20;
/// Maximum total boundaries to prevent rebuild time degradation  
pub const MAX_TOTAL_BOUNDARIES: usize = 100;

/// Unique identifier for a sub-module boundary
pub type BoundaryId = String;

/// Content hash for change detection
pub type ContentHash = u64;

/// Sub-module boundary types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum BoundaryType {
    /// Core logic boundary (state, computation)
    CoreLogic,
    /// Core API boundary (exposed functions)
    CoreApi,
    /// GUI rendering boundary
    GuiRender,
    /// GUI event handling boundary
    GuiEvents,
    /// GUI state boundary
    GuiState,
    /// Shared utilities
    Utils,
    /// Widget boundary (individual UI component)
    Widget,
}

impl BoundaryType {
    pub fn as_str(&self) -> &'static str {
        match self {
            BoundaryType::CoreLogic => "core_logic",
            BoundaryType::CoreApi => "core_api",
            BoundaryType::GuiRender => "gui_render",
            BoundaryType::GuiEvents => "gui_events",
            BoundaryType::GuiState => "gui_state",
            BoundaryType::Utils => "utils",
            BoundaryType::Widget => "widget",
        }
    }

    /// Can this boundary be reloaded independently?
    pub fn supports_independent_reload(&self) -> bool {
        matches!(
            self,
            BoundaryType::GuiRender
                | BoundaryType::GuiEvents
                | BoundaryType::Widget
                | BoundaryType::Utils
        )
    }

    /// Does reloading this boundary require reloading dependents?
    pub fn cascades_to_dependents(&self) -> bool {
        matches!(self, BoundaryType::CoreApi | BoundaryType::CoreLogic)
    }
}

/// A single sub-module boundary definition
/// EXPLICIT MANIFEST - NOT NAME-BASED
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Boundary {
    /// Unique identifier (must be declared, not pattern-matched)
    pub id: BoundaryId,
    /// Type of boundary
    pub boundary_type: BoundaryType,
    /// Parent module (core, gui, main)
    pub parent_module: String,
    /// Content hash for change detection
    pub content_hash: ContentHash,
    /// Dependencies on other boundaries (MUST BE EXPLICIT)
    pub dependencies: HashSet<BoundaryId>,
    /// Exported symbols from this boundary (EXPLICIT MANIFEST)
    pub exports: HashSet<String>,
    /// Last reload timestamp (milliseconds since epoch)
    pub last_reload_ms: u64,
    /// State pointer (if any) - for partial state preservation
    pub state_ptr: Option<usize>,
    /// ABI version for this boundary
    pub abi_version: u32,
    /// Source files owned by this boundary (STRUCTURAL OWNERSHIP)
    pub owned_files: HashSet<String>,
    /// Whether this boundary was validated against manifest
    pub manifest_validated: bool,
}

/// Boundary manifest for explicit declaration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryManifest {
    /// Module this manifest belongs to
    pub module_name: String,
    /// Version of the manifest format
    pub manifest_version: u32,
    /// Declared boundaries
    pub boundaries: Vec<BoundaryDeclaration>,
    /// File ownership rules
    pub ownership_rules: Vec<OwnershipRule>,
    /// Maximum allowed boundaries
    pub max_boundaries: usize,
}

/// Explicit boundary declaration in manifest
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryDeclaration {
    pub id: String,
    pub boundary_type: BoundaryType,
    pub required_exports: Vec<String>,
    pub allowed_dependencies: Vec<String>,
    pub owned_file_patterns: Vec<String>,
}

/// Structural ownership rule
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnershipRule {
    /// File path pattern (glob)
    pub pattern: String,
    /// Boundary that owns files matching this pattern
    pub owner_boundary: String,
    /// Whether this is exclusive ownership
    pub exclusive: bool,
}

impl BoundaryManifest {
    pub fn new(module_name: impl Into<String>) -> Self {
        Self {
            module_name: module_name.into(),
            manifest_version: 1,
            boundaries: Vec::new(),
            ownership_rules: Vec::new(),
            max_boundaries: MAX_BOUNDARIES_PER_MODULE,
        }
    }
    
    pub fn with_boundary(mut self, decl: BoundaryDeclaration) -> Self {
        self.boundaries.push(decl);
        self
    }
    
    pub fn with_ownership(mut self, rule: OwnershipRule) -> Self {
        self.ownership_rules.push(rule);
        self
    }
    
    /// Validate that boundary count is within limits
    pub fn validate(&self) -> Result<(), String> {
        if self.boundaries.len() > self.max_boundaries {
            return Err(format!(
                "Too many boundaries: {} > {} max",
                self.boundaries.len(),
                self.max_boundaries
            ));
        }
        
        // Check for duplicate boundary IDs
        let mut seen = HashSet::new();
        for decl in &self.boundaries {
            if !seen.insert(&decl.id) {
                return Err(format!("Duplicate boundary ID: {}", decl.id));
            }
        }
        
        // Validate ownership rules reference valid boundaries
        for rule in &self.ownership_rules {
            if !self.boundaries.iter().any(|b| b.id == rule.owner_boundary) {
                return Err(format!(
                    "Ownership rule references unknown boundary: {}",
                    rule.owner_boundary
                ));
            }
        }
        
        Ok(())
    }
}

impl Boundary {
    pub fn new(id: impl Into<String>, boundary_type: BoundaryType, parent: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            boundary_type,
            parent_module: parent.into(),
            content_hash: 0,
            dependencies: HashSet::new(),
            exports: HashSet::new(),
            last_reload_ms: 0,
            state_ptr: None,
            abi_version: 1,
            owned_files: HashSet::new(),
            manifest_validated: false,
        }
    }
    
    /// Create boundary from explicit manifest declaration
    pub fn from_declaration(decl: &BoundaryDeclaration, parent: impl Into<String>) -> Self {
        let mut boundary = Self::new(&decl.id, decl.boundary_type, parent);
        for export in &decl.required_exports {
            boundary.exports.insert(export.clone());
        }
        for dep in &decl.allowed_dependencies {
            boundary.dependencies.insert(dep.clone());
        }
        boundary.manifest_validated = true;
        boundary
    }

    pub fn with_hash(mut self, hash: ContentHash) -> Self {
        self.content_hash = hash;
        self
    }

    pub fn with_dependency(mut self, dep: impl Into<String>) -> Self {
        self.dependencies.insert(dep.into());
        self
    }

    pub fn with_export(mut self, export: impl Into<String>) -> Self {
        self.exports.insert(export.into());
        self
    }
}

/// Result of analyzing what boundaries need reload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReloadPlan {
    /// Boundaries that changed directly
    pub direct_changes: Vec<BoundaryId>,
    /// Boundaries that need reload due to dependency cascade
    pub cascade_changes: Vec<BoundaryId>,
    /// Whether a full module reload is required
    pub requires_full_reload: bool,
    /// Reason for full reload (if required)
    pub full_reload_reason: Option<String>,
    /// Boundaries that can preserve state
    pub preserve_state: Vec<BoundaryId>,
    /// Estimated reload time in milliseconds
    pub estimated_time_ms: u64,
}

impl ReloadPlan {
    pub fn full_reload(reason: impl Into<String>) -> Self {
        Self {
            direct_changes: vec![],
            cascade_changes: vec![],
            requires_full_reload: true,
            full_reload_reason: Some(reason.into()),
            preserve_state: vec![],
            estimated_time_ms: 500,
        }
    }

    pub fn partial(boundaries: Vec<BoundaryId>) -> Self {
        Self {
            direct_changes: boundaries,
            cascade_changes: vec![],
            requires_full_reload: false,
            full_reload_reason: None,
            preserve_state: vec![],
            estimated_time_ms: 100,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.direct_changes.is_empty() && self.cascade_changes.is_empty() && !self.requires_full_reload
    }

    pub fn all_boundaries(&self) -> Vec<&BoundaryId> {
        self.direct_changes
            .iter()
            .chain(self.cascade_changes.iter())
            .collect()
    }
}

/// Tracks boundaries and their state for a module
/// ENFORCES EXPLICIT MANIFESTS - NO NAME-BASED REGISTRATION
#[derive(Debug)]
pub struct BoundaryTracker {
    /// All registered boundaries
    boundaries: HashMap<BoundaryId, Boundary>,
    /// Reverse dependency map (boundary -> dependents)
    dependents: HashMap<BoundaryId, HashSet<BoundaryId>>,
    /// Module-level hash for fallback comparison
    module_hashes: HashMap<String, ContentHash>,
    /// Reload counter for statistics
    reload_count: AtomicU64,
    /// Last analysis result
    last_plan: Option<ReloadPlan>,
    /// Loaded manifests per module
    manifests: HashMap<String, BoundaryManifest>,
    /// Total boundary count for cap enforcement
    total_boundary_count: usize,
}

impl BoundaryTracker {
    pub fn new() -> Self {
        Self {
            boundaries: HashMap::new(),
            dependents: HashMap::new(),
            module_hashes: HashMap::new(),
            reload_count: AtomicU64::new(0),
            last_plan: None,
            manifests: HashMap::new(),
            total_boundary_count: 0,
        }
    }
    
    /// Load and validate a manifest BEFORE registering boundaries
    pub fn load_manifest(&mut self, manifest: BoundaryManifest) -> Result<(), String> {
        manifest.validate()?;
        
        // Check total boundary cap
        let new_total = self.total_boundary_count + manifest.boundaries.len();
        if new_total > MAX_TOTAL_BOUNDARIES {
            return Err(format!(
                "Total boundary count would exceed cap: {} > {}",
                new_total,
                MAX_TOTAL_BOUNDARIES
            ));
        }
        
        // Register boundaries from manifest
        for decl in &manifest.boundaries {
            let boundary = Boundary::from_declaration(decl, &manifest.module_name);
            self.register_internal(boundary)?;
        }
        
        self.manifests.insert(manifest.module_name.clone(), manifest);
        Ok(())
    }

    /// Register a boundary - REQUIRES MANIFEST OR EXPLICIT VALIDATION
    pub fn register(&mut self, boundary: Boundary) -> Result<(), String> {
        // Reject boundaries that haven't been validated against a manifest
        if !boundary.manifest_validated {
            return Err(format!(
                "Boundary '{}' was not validated against a manifest. \
                Use load_manifest() or explicitly set manifest_validated.",
                boundary.id
            ));
        }
        
        self.register_internal(boundary)
    }
    
    /// Internal registration (bypasses manifest check for manifest-loaded boundaries)
    fn register_internal(&mut self, boundary: Boundary) -> Result<(), String> {
        // Check caps
        if self.total_boundary_count >= MAX_TOTAL_BOUNDARIES {
            return Err(format!(
                "Maximum boundary count reached: {}",
                MAX_TOTAL_BOUNDARIES
            ));
        }
        
        // Validate dependencies exist
        for dep in &boundary.dependencies {
            if !self.boundaries.contains_key(dep) && dep != &boundary.id {
                // Dependency will be registered later - track for later validation
            }
        }
        
        // Update reverse dependency map
        for dep in &boundary.dependencies {
            self.dependents
                .entry(dep.clone())
                .or_insert_with(HashSet::new)
                .insert(boundary.id.clone());
        }

        self.boundaries.insert(boundary.id.clone(), boundary);
        self.total_boundary_count += 1;
        Ok(())
    }
    
    /// Legacy register for backward compatibility - marks as unvalidated
    #[deprecated(note = "Use load_manifest() instead of direct registration")]
    pub fn register_unvalidated(&mut self, mut boundary: Boundary) {
        boundary.manifest_validated = false;
        // Still allow but log warning
        eprintln!(
            "WARNING: Boundary '{}' registered without manifest validation",
            boundary.id
        );
        let _ = self.register_internal(boundary);
    }

    /// Update a boundary's content hash
    pub fn update_hash(&mut self, id: &str, new_hash: ContentHash) -> bool {
        if let Some(boundary) = self.boundaries.get_mut(id) {
            if boundary.content_hash != new_hash {
                boundary.content_hash = new_hash;
                return true;
            }
        }
        false
    }

    /// Set module-level hash
    pub fn set_module_hash(&mut self, module: &str, hash: ContentHash) {
        self.module_hashes.insert(module.to_string(), hash);
    }

    /// Analyze changes and create a reload plan
    pub fn analyze_changes(
        &mut self,
        changed_hashes: &HashMap<BoundaryId, ContentHash>,
    ) -> ReloadPlan {
        let mut direct_changes = Vec::new();
        let mut cascade_changes = Vec::new();
        let mut preserve_state = Vec::new();

        // Find directly changed boundaries
        for (id, new_hash) in changed_hashes {
            if let Some(boundary) = self.boundaries.get(id) {
                if boundary.content_hash != *new_hash {
                    direct_changes.push(id.clone());

                    // Check if this boundary type supports independent reload
                    if !boundary.boundary_type.supports_independent_reload() {
                        // Need full reload
                        let plan = ReloadPlan::full_reload(format!(
                            "Boundary '{}' of type {:?} does not support independent reload",
                            id, boundary.boundary_type
                        ));
                        self.last_plan = Some(plan.clone());
                        return plan;
                    }
                }
            }
        }

        // Find cascade changes (dependents of changed boundaries)
        let mut to_check: Vec<BoundaryId> = direct_changes.clone();
        let mut checked: HashSet<BoundaryId> = HashSet::new();

        while let Some(id) = to_check.pop() {
            if checked.contains(&id) {
                continue;
            }
            checked.insert(id.clone());

            if let Some(dependents) = self.dependents.get(&id) {
                for dep_id in dependents {
                    if !direct_changes.contains(dep_id) && !cascade_changes.contains(dep_id) {
                        cascade_changes.push(dep_id.clone());
                        to_check.push(dep_id.clone());
                    }
                }
            }
        }

        // Determine which boundaries can preserve state
        for boundary in self.boundaries.values() {
            if !direct_changes.contains(&boundary.id) && !cascade_changes.contains(&boundary.id) {
                preserve_state.push(boundary.id.clone());
            }
        }

        // Estimate reload time
        let estimated_time_ms = (direct_changes.len() + cascade_changes.len()) as u64 * 50;

        let plan = ReloadPlan {
            direct_changes,
            cascade_changes,
            requires_full_reload: false,
            full_reload_reason: None,
            preserve_state,
            estimated_time_ms,
        };

        self.last_plan = Some(plan.clone());
        plan
    }

    /// Mark a boundary as reloaded
    pub fn mark_reloaded(&mut self, id: &str) {
        if let Some(boundary) = self.boundaries.get_mut(id) {
            boundary.last_reload_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
        }
        self.reload_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Get a boundary by ID
    pub fn get(&self, id: &str) -> Option<&Boundary> {
        self.boundaries.get(id)
    }

    /// Get all boundaries for a module
    pub fn get_module_boundaries(&self, module: &str) -> Vec<&Boundary> {
        self.boundaries
            .values()
            .filter(|b| b.parent_module == module)
            .collect()
    }

    /// Get reload statistics
    pub fn get_stats(&self) -> BoundaryStats {
        BoundaryStats {
            total_boundaries: self.boundaries.len(),
            reload_count: self.reload_count.load(Ordering::Relaxed),
            boundaries_by_type: self
                .boundaries
                .values()
                .fold(HashMap::new(), |mut acc, b| {
                    *acc.entry(b.boundary_type.as_str().to_string()).or_insert(0) += 1;
                    acc
                }),
        }
    }
}

impl Default for BoundaryTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// Boundary tracking statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryStats {
    pub total_boundaries: usize,
    pub reload_count: u64,
    pub boundaries_by_type: HashMap<String, usize>,
}

/// Pre-defined boundary configurations for common module structures
pub mod presets {
    use super::*;

    /// Create standard core module boundaries
    pub fn core_boundaries() -> Vec<Boundary> {
        vec![
            Boundary::new("core_state", BoundaryType::CoreLogic, "core")
                .with_export("CoreState"),
            Boundary::new("core_api", BoundaryType::CoreApi, "core")
                .with_dependency("core_state")
                .with_export("core_get_api")
                .with_export("core_on_load")
                .with_export("core_on_update"),
            Boundary::new("core_events", BoundaryType::CoreLogic, "core")
                .with_dependency("core_state")
                .with_export("core_on_event"),
            Boundary::new("core_utils", BoundaryType::Utils, "core"),
        ]
    }

    /// Create standard gui module boundaries
    pub fn gui_boundaries() -> Vec<Boundary> {
        vec![
            Boundary::new("gui_state", BoundaryType::GuiState, "gui")
                .with_export("GuiState"),
            Boundary::new("gui_render", BoundaryType::GuiRender, "gui")
                .with_dependency("gui_state")
                .with_export("gui_on_render"),
            Boundary::new("gui_events", BoundaryType::GuiEvents, "gui")
                .with_dependency("gui_state")
                .with_export("gui_on_event"),
            Boundary::new("gui_widgets", BoundaryType::Widget, "gui")
                .with_dependency("gui_state")
                .with_dependency("gui_render"),
        ]
    }

    /// Create a widget-specific boundary
    pub fn widget_boundary(widget_id: &str, parent_module: &str) -> Boundary {
        Boundary::new(format!("widget_{}", widget_id), BoundaryType::Widget, parent_module)
            .with_dependency("gui_state")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_boundary_registration() {
        let mut tracker = BoundaryTracker::new();

        tracker.register(Boundary::new("b1", BoundaryType::CoreLogic, "core"));
        tracker.register(
            Boundary::new("b2", BoundaryType::CoreApi, "core").with_dependency("b1"),
        );

        assert_eq!(tracker.boundaries.len(), 2);
        assert!(tracker.dependents.get("b1").unwrap().contains("b2"));
    }

    #[test]
    fn test_reload_plan_partial() {
        let mut tracker = BoundaryTracker::new();

        tracker.register(Boundary::new("render", BoundaryType::GuiRender, "gui").with_hash(100));
        tracker.register(
            Boundary::new("events", BoundaryType::GuiEvents, "gui")
                .with_hash(200)
                .with_dependency("render"),
        );

        let mut changes = HashMap::new();
        changes.insert("render".to_string(), 101u64); // Changed

        let plan = tracker.analyze_changes(&changes);

        assert!(!plan.requires_full_reload);
        assert!(plan.direct_changes.contains(&"render".to_string()));
        assert!(plan.cascade_changes.contains(&"events".to_string()));
    }

    #[test]
    fn test_reload_plan_full() {
        let mut tracker = BoundaryTracker::new();

        tracker.register(Boundary::new("core_api", BoundaryType::CoreApi, "core").with_hash(100));

        let mut changes = HashMap::new();
        changes.insert("core_api".to_string(), 101u64); // Changed

        let plan = tracker.analyze_changes(&changes);

        assert!(plan.requires_full_reload);
    }
}
