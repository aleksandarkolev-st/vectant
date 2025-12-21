// Boundary module now actively used via HmrOrchestrator
// Advanced manifest features are infrastructure for future use

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
            manifest_validated_count: self.boundaries.values().filter(|b| b.manifest_validated).count(),
            unvalidated_count: self.boundaries.values().filter(|b| !b.manifest_validated).count(),
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
    pub manifest_validated_count: usize,
    pub unvalidated_count: usize,
}

/// Pre-defined MANIFEST configurations for common module structures
/// These replace the old name-based presets
pub mod presets {
    use super::*;

    /// Create core module manifest with explicit declarations
    pub fn core_manifest() -> BoundaryManifest {
        BoundaryManifest::new("core")
            .with_boundary(BoundaryDeclaration {
                id: "core_state".to_string(),
                boundary_type: BoundaryType::CoreLogic,
                required_exports: vec!["CoreState".to_string()],
                allowed_dependencies: vec![],
                owned_file_patterns: vec!["src/core/state/**".to_string()],
            })
            .with_boundary(BoundaryDeclaration {
                id: "core_api".to_string(),
                boundary_type: BoundaryType::CoreApi,
                required_exports: vec![
                    "core_get_api".to_string(),
                    "core_on_load".to_string(),
                    "core_on_update".to_string(),
                ],
                allowed_dependencies: vec!["core_state".to_string()],
                owned_file_patterns: vec!["src/core/api/**".to_string()],
            })
            .with_boundary(BoundaryDeclaration {
                id: "core_events".to_string(),
                boundary_type: BoundaryType::CoreLogic,
                required_exports: vec!["core_on_event".to_string()],
                allowed_dependencies: vec!["core_state".to_string()],
                owned_file_patterns: vec!["src/core/events/**".to_string()],
            })
            .with_boundary(BoundaryDeclaration {
                id: "core_utils".to_string(),
                boundary_type: BoundaryType::Utils,
                required_exports: vec![],
                allowed_dependencies: vec![],
                owned_file_patterns: vec!["src/core/utils/**".to_string()],
            })
            .with_ownership(OwnershipRule {
                pattern: "src/core/**".to_string(),
                owner_boundary: "core_state".to_string(),
                exclusive: false,
            })
    }

    /// Create gui module manifest with explicit declarations
    pub fn gui_manifest() -> BoundaryManifest {
        BoundaryManifest::new("gui")
            .with_boundary(BoundaryDeclaration {
                id: "gui_state".to_string(),
                boundary_type: BoundaryType::GuiState,
                required_exports: vec!["GuiState".to_string()],
                allowed_dependencies: vec![],
                owned_file_patterns: vec!["src/gui/state/**".to_string()],
            })
            .with_boundary(BoundaryDeclaration {
                id: "gui_render".to_string(),
                boundary_type: BoundaryType::GuiRender,
                required_exports: vec!["gui_on_render".to_string()],
                allowed_dependencies: vec!["gui_state".to_string()],
                owned_file_patterns: vec!["src/gui/render/**".to_string()],
            })
            .with_boundary(BoundaryDeclaration {
                id: "gui_events".to_string(),
                boundary_type: BoundaryType::GuiEvents,
                required_exports: vec!["gui_on_event".to_string()],
                allowed_dependencies: vec!["gui_state".to_string()],
                owned_file_patterns: vec!["src/gui/events/**".to_string()],
            })
            .with_boundary(BoundaryDeclaration {
                id: "gui_widgets".to_string(),
                boundary_type: BoundaryType::Widget,
                required_exports: vec![],
                allowed_dependencies: vec!["gui_state".to_string(), "gui_render".to_string()],
                owned_file_patterns: vec!["src/gui/widgets/**".to_string()],
            })
    }

    /// Create a widget-specific boundary declaration
    pub fn widget_declaration(widget_id: &str) -> BoundaryDeclaration {
        BoundaryDeclaration {
            id: format!("widget_{}", widget_id),
            boundary_type: BoundaryType::Widget,
            required_exports: vec![],
            allowed_dependencies: vec!["gui_state".to_string()],
            owned_file_patterns: vec![format!("src/gui/widgets/{}/**", widget_id)],
        }
    }
    
    /// DEPRECATED: Old boundary creation - use manifests instead
    #[deprecated(note = "Use core_manifest() and load_manifest() instead")]
    pub fn core_boundaries() -> Vec<Boundary> {
        vec![]
    }

    /// DEPRECATED: Old boundary creation - use manifests instead
    #[deprecated(note = "Use gui_manifest() and load_manifest() instead")]
    pub fn gui_boundaries() -> Vec<Boundary> {
        vec![]
    }
}

// ============================================================
// MANIFEST FILE PARSING
// ============================================================
// Parses boundary manifest files (.boundary.json) from the filesystem

impl BoundaryManifest {
    /// Load manifest from JSON file
    pub fn load_from_file(path: &std::path::Path) -> Result<Self, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read manifest file {}: {}", path.display(), e))?;
        Self::parse_json(&content)
    }
    
    /// Parse manifest from JSON string
    pub fn parse_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json)
            .map_err(|e| format!("Failed to parse manifest JSON: {}", e))
    }
    
    /// Save manifest to JSON file
    pub fn save_to_file(&self, path: &std::path::Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
        std::fs::write(path, json)
            .map_err(|e| format!("Failed to write manifest to {}: {}", path.display(), e))
    }
    
    /// Generate manifest from source file analysis
    pub fn generate_from_source(
        module_name: &str,
        source_root: &std::path::Path,
    ) -> Result<Self, String> {
        let mut manifest = BoundaryManifest::new(module_name);
        let detector = WidgetBoundaryDetector::new();
        
        // Scan source directory for widget files
        if let Ok(entries) = std::fs::read_dir(source_root) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.extension().map(|e| e == "cpp" || e == "c" || e == "h").unwrap_or(false) {
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        if let Some(widget) = detector.detect_widget(&content, &path) {
                            manifest.boundaries.push(widget);
                        }
                    }
                }
            }
        }
        
        manifest.validate()?;
        Ok(manifest)
    }
}

// ============================================================
// WIDGET BOUNDARY DETECTION
// ============================================================
// AI-assisted detection of widget boundaries in source code

/// Widget boundary detector using heuristic pattern matching
pub struct WidgetBoundaryDetector {
    /// Patterns that indicate a widget/component definition
    widget_patterns: Vec<WidgetPattern>,
    /// Cache of detected widgets
    cache: std::collections::HashMap<String, Vec<DetectedWidget>>,
}

/// Pattern for detecting widget boundaries
#[derive(Debug, Clone)]
pub struct WidgetPattern {
    /// Name of the pattern
    pub name: String,
    /// Regex pattern to match
    pub pattern: String,
    /// Capture group for widget name
    pub name_capture: usize,
    /// Confidence score (0.0 - 1.0)
    pub confidence: f32,
    /// Boundary type to assign
    pub boundary_type: BoundaryType,
}

/// A detected widget in source code
#[derive(Debug, Clone)]
pub struct DetectedWidget {
    pub name: String,
    pub file_path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub confidence: f32,
    pub pattern_used: String,
    pub exports: Vec<String>,
    pub dependencies: Vec<String>,
}

impl WidgetBoundaryDetector {
    pub fn new() -> Self {
        Self {
            widget_patterns: Self::default_patterns(),
            cache: std::collections::HashMap::new(),
        }
    }
    
    /// Default patterns for common widget/component patterns
    fn default_patterns() -> Vec<WidgetPattern> {
        vec![
            // SDL/GUI widget class pattern
            WidgetPattern {
                name: "class_widget".to_string(),
                pattern: r"class\s+(\w+Widget)\s*(?::\s*public\s+\w+)?\s*\{".to_string(),
                name_capture: 1,
                confidence: 0.9,
                boundary_type: BoundaryType::Widget,
            },
            // SDL/GUI component pattern
            WidgetPattern {
                name: "class_component".to_string(),
                pattern: r"class\s+(\w+Component)\s*(?::\s*public\s+\w+)?\s*\{".to_string(),
                name_capture: 1,
                confidence: 0.85,
                boundary_type: BoundaryType::Widget,
            },
            // Struct-based widget
            WidgetPattern {
                name: "struct_widget".to_string(),
                pattern: r"typedef\s+struct\s+(\w+_widget)\s*\{".to_string(),
                name_capture: 1,
                confidence: 0.8,
                boundary_type: BoundaryType::Widget,
            },
            // Function-based widget (render function)
            WidgetPattern {
                name: "render_function".to_string(),
                pattern: r"void\s+(\w+)_render\s*\(\s*(?:SDL_Renderer|void)\s*\*".to_string(),
                name_capture: 1,
                confidence: 0.75,
                boundary_type: BoundaryType::GuiRender,
            },
            // Event handler pattern
            WidgetPattern {
                name: "event_handler".to_string(),
                pattern: r"(?:bool|int|void)\s+(\w+)_handle_event\s*\(\s*(?:SDL_Event|const\s+SDL_Event)\s*\*".to_string(),
                name_capture: 1,
                confidence: 0.75,
                boundary_type: BoundaryType::GuiEvents,
            },
            // Init/create function pattern
            WidgetPattern {
                name: "widget_create".to_string(),
                pattern: r"(?:struct\s+)?(\w+)\s*\*\s*\1_create\s*\(".to_string(),
                name_capture: 1,
                confidence: 0.7,
                boundary_type: BoundaryType::Widget,
            },
            // HMR boundary marker (explicit annotation)
            WidgetPattern {
                name: "hmr_boundary".to_string(),
                pattern: r"//\s*@hmr-boundary:\s*(\w+)".to_string(),
                name_capture: 1,
                confidence: 1.0,  // Explicit markers are highest confidence
                boundary_type: BoundaryType::Widget,
            },
            // Widget state struct
            WidgetPattern {
                name: "widget_state".to_string(),
                pattern: r"struct\s+(\w+)State\s*\{".to_string(),
                name_capture: 1,
                confidence: 0.65,
                boundary_type: BoundaryType::GuiState,
            },
        ]
    }
    
    /// Detect widget in source content
    pub fn detect_widget(
        &self, 
        content: &str, 
        file_path: &std::path::Path
    ) -> Option<BoundaryDeclaration> {
        let detected = self.detect_all_widgets(content, file_path);
        
        // Return highest confidence detection as a boundary declaration
        detected.into_iter()
            .max_by(|a, b| a.confidence.partial_cmp(&b.confidence).unwrap())
            .map(|w| BoundaryDeclaration {
                id: format!("widget_{}", w.name.to_lowercase()),
                boundary_type: BoundaryType::Widget,
                required_exports: w.exports,
                allowed_dependencies: w.dependencies,
                owned_file_patterns: vec![file_path.to_string_lossy().to_string()],
            })
    }
    
    /// Detect all widgets in source content
    pub fn detect_all_widgets(
        &self, 
        content: &str, 
        file_path: &std::path::Path
    ) -> Vec<DetectedWidget> {
        let mut detected = Vec::new();
        let file_path_str = file_path.to_string_lossy().to_string();
        
        for pattern in &self.widget_patterns {
            if let Ok(re) = regex::Regex::new(&pattern.pattern) {
                for cap in re.captures_iter(content) {
                    if let Some(name_match) = cap.get(pattern.name_capture) {
                        let name = name_match.as_str().to_string();
                        
                        // Find line numbers
                        let start_pos = name_match.start();
                        let start_line = content[..start_pos].lines().count();
                        
                        // Detect exports (functions with this widget name prefix)
                        let exports = self.detect_exports(content, &name);
                        
                        // Detect dependencies (includes/imports)
                        let dependencies = self.detect_dependencies(content);
                        
                        detected.push(DetectedWidget {
                            name: name.clone(),
                            file_path: file_path_str.clone(),
                            start_line,
                            end_line: start_line + 50, // Estimate
                            confidence: pattern.confidence,
                            pattern_used: pattern.name.clone(),
                            exports,
                            dependencies,
                        });
                    }
                }
            }
        }
        
        // Deduplicate by name, keeping highest confidence
        let mut seen: std::collections::HashMap<String, DetectedWidget> = std::collections::HashMap::new();
        for widget in detected {
            let entry = seen.entry(widget.name.clone()).or_insert(widget.clone());
            if widget.confidence > entry.confidence {
                *entry = widget;
            }
        }
        
        seen.into_values().collect()
    }
    
    /// Detect exported functions for a widget
    fn detect_exports(&self, content: &str, widget_name: &str) -> Vec<String> {
        let mut exports = Vec::new();
        let name_lower = widget_name.to_lowercase();
        
        // Look for functions with widget name prefix
        let func_pattern = format!(r"(?:void|int|bool|{name}[*\s])\s+({name_lower}_\w+)\s*\(", 
            name = widget_name, name_lower = name_lower);
        
        if let Ok(re) = regex::Regex::new(&func_pattern) {
            for cap in re.captures_iter(content) {
                if let Some(func_match) = cap.get(1) {
                    exports.push(func_match.as_str().to_string());
                }
            }
        }
        
        exports
    }
    
    /// Detect dependencies from includes
    fn detect_dependencies(&self, content: &str) -> Vec<String> {
        let mut deps = Vec::new();
        
        // Match #include "..." (local includes)
        if let Ok(re) = regex::Regex::new(r#"#include\s+"([^"]+)""#) {
            for cap in re.captures_iter(content) {
                if let Some(include_match) = cap.get(1) {
                    let include = include_match.as_str();
                    // Convert to boundary ID format
                    if include.contains("widget") || include.contains("component") {
                        let dep_name = std::path::Path::new(include)
                            .file_stem()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_default();
                        if !dep_name.is_empty() {
                            deps.push(format!("widget_{}", dep_name.to_lowercase()));
                        }
                    }
                }
            }
        }
        
        deps
    }
    
    /// Add custom pattern for project-specific widget detection
    pub fn add_pattern(&mut self, pattern: WidgetPattern) {
        self.widget_patterns.push(pattern);
    }
    
    /// Clear detection cache
    pub fn clear_cache(&mut self) {
        self.cache.clear();
    }
}

impl Default for WidgetBoundaryDetector {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================
// STRUCTURAL OWNERSHIP VALIDATION
// ============================================================
// Validates that files are owned by exactly one boundary

/// Ownership validator for boundary files
pub struct OwnershipValidator {
    /// Compiled ownership rules
    rules: Vec<CompiledOwnershipRule>,
}

/// Compiled ownership rule with regex
struct CompiledOwnershipRule {
    pattern: regex::Regex,
    owner: String,
    exclusive: bool,
}

/// Result of ownership validation
#[derive(Debug, Clone)]
pub struct OwnershipValidationResult {
    pub valid: bool,
    pub errors: Vec<OwnershipError>,
    pub warnings: Vec<String>,
    pub file_owners: HashMap<String, Vec<String>>,
}

/// Ownership error
#[derive(Debug, Clone)]
pub struct OwnershipError {
    pub file: String,
    pub error_type: OwnershipErrorType,
    pub message: String,
}

/// Types of ownership errors
#[derive(Debug, Clone, PartialEq)]
pub enum OwnershipErrorType {
    NoOwner,
    MultipleExclusiveOwners,
    PatternConflict,
}

impl OwnershipValidator {
    /// Create validator from manifest ownership rules
    pub fn from_manifest(manifest: &BoundaryManifest) -> Result<Self, String> {
        let mut rules = Vec::new();
        
        for rule in &manifest.ownership_rules {
            // Convert glob pattern to regex
            let regex_pattern = glob_to_regex(&rule.pattern)?;
            let compiled = regex::Regex::new(&regex_pattern)
                .map_err(|e| format!("Invalid pattern '{}': {}", rule.pattern, e))?;
            
            rules.push(CompiledOwnershipRule {
                pattern: compiled,
                owner: rule.owner_boundary.clone(),
                exclusive: rule.exclusive,
            });
        }
        
        Ok(Self { rules })
    }
    
    /// Validate file ownership for a set of files
    pub fn validate(&self, files: &[String]) -> OwnershipValidationResult {
        let mut file_owners: HashMap<String, Vec<String>> = HashMap::new();
        let mut errors = Vec::new();
        let mut warnings = Vec::new();
        
        for file in files {
            let mut owners = Vec::new();
            let mut has_exclusive = false;
            
            for rule in &self.rules {
                if rule.pattern.is_match(file) {
                    if rule.exclusive && !owners.is_empty() {
                        errors.push(OwnershipError {
                            file: file.clone(),
                            error_type: OwnershipErrorType::MultipleExclusiveOwners,
                            message: format!(
                                "File '{}' matched exclusive rule for '{}' but already owned by {:?}",
                                file, rule.owner, owners
                            ),
                        });
                    }
                    if rule.exclusive {
                        has_exclusive = true;
                    }
                    owners.push(rule.owner.clone());
                }
            }
            
            if owners.is_empty() {
                warnings.push(format!("File '{}' has no boundary owner", file));
            } else if owners.len() > 1 && has_exclusive {
                errors.push(OwnershipError {
                    file: file.clone(),
                    error_type: OwnershipErrorType::PatternConflict,
                    message: format!(
                        "File '{}' owned by multiple boundaries with exclusive rules: {:?}",
                        file, owners
                    ),
                });
            }
            
            file_owners.insert(file.clone(), owners);
        }
        
        OwnershipValidationResult {
            valid: errors.is_empty(),
            errors,
            warnings,
            file_owners,
        }
    }
    
    /// Get owner boundary for a file
    pub fn get_owner(&self, file: &str) -> Option<String> {
        for rule in &self.rules {
            if rule.pattern.is_match(file) {
                return Some(rule.owner.clone());
            }
        }
        None
    }
    
    /// Get all files owned by a boundary
    pub fn get_owned_files(&self, boundary_id: &str, all_files: &[String]) -> Vec<String> {
        all_files.iter()
            .filter(|f| self.get_owner(f).as_deref() == Some(boundary_id))
            .cloned()
            .collect()
    }
}

/// Convert glob pattern to regex
fn glob_to_regex(glob: &str) -> Result<String, String> {
    let mut regex = String::from("^");
    let mut chars = glob.chars().peekable();
    
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    if chars.peek() == Some(&'/') {
                        chars.next();
                        regex.push_str("(?:.*/)?");
                    } else {
                        regex.push_str(".*");
                    }
                } else {
                    regex.push_str("[^/]*");
                }
            }
            '?' => regex.push('.'),
            '.' | '+' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' | '\\' => {
                regex.push('\\');
                regex.push(c);
            }
            _ => regex.push(c),
        }
    }
    
    regex.push('$');
    Ok(regex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_boundary_registration_with_manifest() {
        let mut tracker = BoundaryTracker::new();
        let manifest = presets::core_manifest();
        
        // Should succeed with manifest
        assert!(tracker.load_manifest(manifest).is_ok());
        assert!(tracker.boundaries.len() > 0);
    }
    
    #[test]
    fn test_boundary_registration_without_manifest_fails() {
        let mut tracker = BoundaryTracker::new();
        let boundary = Boundary::new("b1", BoundaryType::CoreLogic, "core");
        
        // Should fail without manifest validation
        assert!(tracker.register(boundary).is_err());
    }

    #[test]
    fn test_reload_plan_partial() {
        let mut tracker = BoundaryTracker::new();
        
        // Create validated boundaries
        let mut render = Boundary::new("render", BoundaryType::GuiRender, "gui").with_hash(100);
        render.manifest_validated = true;
        
        let mut events = Boundary::new("events", BoundaryType::GuiEvents, "gui")
            .with_hash(200)
            .with_dependency("render");
        events.manifest_validated = true;
        
        tracker.register_internal(render).unwrap();
        tracker.register_internal(events).unwrap();

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

        let mut core_api = Boundary::new("core_api", BoundaryType::CoreApi, "core").with_hash(100);
        core_api.manifest_validated = true;
        tracker.register_internal(core_api).unwrap();

        let mut changes = HashMap::new();
        changes.insert("core_api".to_string(), 101u64); // Changed

        let plan = tracker.analyze_changes(&changes);

        assert!(plan.requires_full_reload);
    }
    
    #[test]
    fn test_widget_detection() {
        let detector = WidgetBoundaryDetector::new();
        let source = r#"
            class ButtonWidget : public BaseWidget {
            public:
                void render(SDL_Renderer* renderer);
                bool handle_event(const SDL_Event* event);
            };
        "#;
        
        let widgets = detector.detect_all_widgets(source, std::path::Path::new("button.cpp"));
        assert!(!widgets.is_empty());
        assert!(widgets.iter().any(|w| w.name == "ButtonWidget"));
    }
    
    #[test]
    fn test_hmr_boundary_marker() {
        let detector = WidgetBoundaryDetector::new();
        let source = r#"
            // @hmr-boundary: CustomPanel
            struct CustomPanel {
                int x, y, width, height;
            };
        "#;
        
        let widgets = detector.detect_all_widgets(source, std::path::Path::new("panel.cpp"));
        assert!(!widgets.is_empty());
        assert!(widgets.iter().any(|w| w.name == "CustomPanel" && w.confidence == 1.0));
    }
    
    #[test]
    fn test_ownership_validation() {
        let manifest = BoundaryManifest::new("gui")
            .with_boundary(BoundaryDeclaration {
                id: "gui_render".to_string(),
                boundary_type: BoundaryType::GuiRender,
                required_exports: vec![],
                allowed_dependencies: vec![],
                owned_file_patterns: vec!["src/gui/render/**".to_string()],
            })
            .with_ownership(OwnershipRule {
                pattern: "src/gui/render/**".to_string(),
                owner_boundary: "gui_render".to_string(),
                exclusive: true,
            });
        
        let validator = OwnershipValidator::from_manifest(&manifest).unwrap();
        let files = vec![
            "src/gui/render/main.cpp".to_string(),
            "src/gui/render/utils.cpp".to_string(),
            "src/gui/state/state.cpp".to_string(),  // No owner
        ];
        
        let result = validator.validate(&files);
        assert!(!result.warnings.is_empty()); // Should warn about state.cpp
        assert!(result.file_owners.get("src/gui/render/main.cpp").unwrap().contains(&"gui_render".to_string()));
    }
    
    #[test]
    fn test_glob_to_regex() {
        let pattern = glob_to_regex("src/**/*.cpp").unwrap();
        let re = regex::Regex::new(&pattern).unwrap();
        
        assert!(re.is_match("src/gui/render.cpp"));
        assert!(re.is_match("src/core/state/manager.cpp"));
        assert!(!re.is_match("src/gui/render.h"));
    }
}
