use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use serde::{Serialize, Deserialize};
use uuid::Uuid;
use std::fs;
use std::time::SystemTime;
use std::sync::Arc;
use tokio::sync::Semaphore;

// ============================================================
// PARALLEL COMPILATION SUPPORT
// ============================================================
// Compiles independent source files in parallel using tokio::spawn
// while respecting CPU core limits and dependency ordering.
// ============================================================

/// Configuration for parallel compilation
#[derive(Debug, Clone)]
pub struct ParallelCompileConfig {
    /// Maximum concurrent compilations (default: num_cpus)
    pub max_parallel: usize,
    /// Whether to use parallel compilation
    pub enabled: bool,
}

impl Default for ParallelCompileConfig {
    fn default() -> Self {
        Self {
            max_parallel: num_cpus::get().max(2),
            enabled: true,
        }
    }
}

/// Compilation unit with dependencies
#[derive(Debug, Clone)]
pub struct CompilationUnit {
    /// Source file path
    pub source_path: PathBuf,
    /// Source content
    pub content: String,
    /// Module name (core, gui, main)
    pub module: String,
    /// Dependencies (other compilation units that must compile first)
    pub dependencies: Vec<String>,
    /// Unique identifier
    pub id: String,
}

/// Result of a single compilation
#[derive(Debug, Clone)]
pub struct CompilationResult {
    pub id: String,
    pub module: String,
    pub object_path: PathBuf,
    pub success: bool,
    pub error: Option<String>,
    pub duration_ms: u64,
    pub was_cached: bool,
}

/// Parallel compilation coordinator
pub struct ParallelCompiler {
    config: ParallelCompileConfig,
    semaphore: Arc<Semaphore>,
}

impl ParallelCompiler {
    pub fn new(config: ParallelCompileConfig) -> Self {
        let semaphore = Arc::new(Semaphore::new(config.max_parallel));
        Self { config, semaphore }
    }
    
    /// Compile multiple units in parallel, respecting dependencies
    pub async fn compile_parallel(
        &self,
        units: Vec<CompilationUnit>,
        output_dir: &Path,
        compiler: &str,
        base_flags: &[&str],
        headers: &[(&str, &str)],
    ) -> Vec<CompilationResult> {
        use tokio::task::JoinHandle;
        use std::time::Instant;
        
        if !self.config.enabled || units.len() <= 1 {
            // Fall back to sequential
            return self.compile_sequential(units, output_dir, compiler, base_flags, headers).await;
        }
        
        // Build dependency graph
        let dep_graph = self.build_dependency_graph(&units);
        
        // Topological sort to find compilation order
        let ordered = self.topological_sort(&units, &dep_graph);
        
        // Group units by dependency level for parallel execution
        let levels = self.group_by_level(&ordered, &dep_graph);
        
        let mut all_results = Vec::new();
        
        // Process each level in parallel
        for level in levels {
            let mut handles: Vec<JoinHandle<CompilationResult>> = Vec::new();
            
            for unit_id in level {
                let unit = units.iter().find(|u| u.id == unit_id).unwrap().clone();
                let sem = self.semaphore.clone();
                let output = output_dir.to_path_buf();
                let comp = compiler.to_string();
                let flags: Vec<String> = base_flags.iter().map(|s| s.to_string()).collect();
                let hdrs: Vec<(String, String)> = headers.iter()
                    .map(|(n, c)| (n.to_string(), c.to_string()))
                    .collect();
                
                let handle = tokio::spawn(async move {
                    // Acquire semaphore permit
                    let _permit = sem.acquire().await.unwrap();
                    
                    let start = Instant::now();
                    let result = compile_single_unit(&unit, &output, &comp, &flags, &hdrs).await;
                    let duration = start.elapsed().as_millis() as u64;
                    
                    match result {
                        Ok((path, cached)) => CompilationResult {
                            id: unit.id,
                            module: unit.module,
                            object_path: path,
                            success: true,
                            error: None,
                            duration_ms: duration,
                            was_cached: cached,
                        },
                        Err(e) => CompilationResult {
                            id: unit.id,
                            module: unit.module,
                            object_path: PathBuf::new(),
                            success: false,
                            error: Some(e),
                            duration_ms: duration,
                            was_cached: false,
                        },
                    }
                });
                
                handles.push(handle);
            }
            
            // Wait for this level to complete before moving to next
            for handle in handles {
                if let Ok(result) = handle.await {
                    all_results.push(result);
                }
            }
            
            // Check for failures - stop if any unit failed
            if all_results.iter().any(|r| !r.success) {
                break;
            }
        }
        
        all_results
    }
    
    /// Sequential compilation fallback
    async fn compile_sequential(
        &self,
        units: Vec<CompilationUnit>,
        output_dir: &Path,
        compiler: &str,
        base_flags: &[&str],
        headers: &[(&str, &str)],
    ) -> Vec<CompilationResult> {
        use std::time::Instant;
        
        let mut results = Vec::new();
        let flags: Vec<String> = base_flags.iter().map(|s| s.to_string()).collect();
        let hdrs: Vec<(String, String)> = headers.iter()
            .map(|(n, c)| (n.to_string(), c.to_string()))
            .collect();
        
        for unit in units {
            let start = Instant::now();
            let result = compile_single_unit(&unit, output_dir, compiler, &flags, &hdrs).await;
            let duration = start.elapsed().as_millis() as u64;
            
            let comp_result = match result {
                Ok((path, cached)) => CompilationResult {
                    id: unit.id,
                    module: unit.module,
                    object_path: path,
                    success: true,
                    error: None,
                    duration_ms: duration,
                    was_cached: cached,
                },
                Err(e) => CompilationResult {
                    id: unit.id.clone(),
                    module: unit.module.clone(),
                    object_path: PathBuf::new(),
                    success: false,
                    error: Some(e),
                    duration_ms: duration,
                    was_cached: false,
                },
            };
            
            let failed = !comp_result.success;
            results.push(comp_result);
            
            if failed {
                break;
            }
        }
        
        results
    }
    
    /// Build dependency graph from units
    fn build_dependency_graph(&self, units: &[CompilationUnit]) -> HashMap<String, Vec<String>> {
        let mut graph = HashMap::new();
        
        for unit in units {
            graph.insert(unit.id.clone(), unit.dependencies.clone());
        }
        
        graph
    }
    
    /// Topological sort of compilation units
    fn topological_sort(
        &self,
        units: &[CompilationUnit],
        graph: &HashMap<String, Vec<String>>,
    ) -> Vec<String> {
        let mut result = Vec::new();
        let mut visited = HashSet::new();
        let mut temp_visited = HashSet::new();
        
        fn visit(
            id: &str,
            graph: &HashMap<String, Vec<String>>,
            visited: &mut HashSet<String>,
            temp_visited: &mut HashSet<String>,
            result: &mut Vec<String>,
        ) {
            if visited.contains(id) {
                return;
            }
            if temp_visited.contains(id) {
                // Cycle detected - skip
                return;
            }
            
            temp_visited.insert(id.to_string());
            
            if let Some(deps) = graph.get(id) {
                for dep in deps {
                    visit(dep, graph, visited, temp_visited, result);
                }
            }
            
            temp_visited.remove(id);
            visited.insert(id.to_string());
            result.push(id.to_string());
        }
        
        for unit in units {
            visit(&unit.id, graph, &mut visited, &mut temp_visited, &mut result);
        }
        
        result
    }
    
    /// Group units by dependency level for parallel execution
    fn group_by_level(
        &self,
        ordered: &[String],
        graph: &HashMap<String, Vec<String>>,
    ) -> Vec<Vec<String>> {
        let mut levels: Vec<Vec<String>> = Vec::new();
        let mut assigned: HashMap<String, usize> = HashMap::new();
        
        for id in ordered {
            let deps = graph.get(id).map(|d| d.as_slice()).unwrap_or(&[]);
            
            // Find the max level of dependencies
            let max_dep_level = deps
                .iter()
                .filter_map(|dep| assigned.get(dep))
                .max()
                .copied()
                .unwrap_or(0);
            
            // This unit goes in the next level
            let level = if deps.is_empty() { 0 } else { max_dep_level + 1 };
            assigned.insert(id.clone(), level);
            
            // Ensure we have enough levels
            while levels.len() <= level {
                levels.push(Vec::new());
            }
            
            levels[level].push(id.clone());
        }
        
        levels
    }
}

/// Compile a single compilation unit
async fn compile_single_unit(
    unit: &CompilationUnit,
    output_dir: &Path,
    compiler: &str,
    flags: &[String],
    _headers: &[(String, String)],
) -> Result<(PathBuf, bool), String> {
    use tokio::process::Command;
    use std::hash::{Hash, Hasher};
    use std::collections::hash_map::DefaultHasher;
    
    // Generate object file name from content hash
    let mut hasher = DefaultHasher::new();
    unit.content.hash(&mut hasher);
    for flag in flags {
        flag.hash(&mut hasher);
    }
    let hash = hasher.finish();
    
    let object_path = output_dir.join(format!("{}_{:016x}.o", unit.module, hash));
    
    // Check if already exists (simple cache check)
    if object_path.exists() {
        return Ok((object_path, true));
    }
    
    // Write source to temp file
    let source_path = output_dir.join(format!("{}.cpp", unit.id));
    tokio::fs::write(&source_path, &unit.content).await
        .map_err(|e| format!("Failed to write source: {}", e))?;
    
    // Compile
    let mut cmd = Command::new(compiler);
    cmd.arg("-c")
       .arg("-fPIC")
       .args(flags)
       .arg(&source_path)
       .arg("-o")
       .arg(&object_path)
       .current_dir(output_dir);
    
    let output = cmd.output().await
        .map_err(|e| format!("Failed to run compiler: {}", e))?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }
    
    Ok((object_path, false))
}

/// Get summary statistics for parallel compilation
pub fn compile_summary(results: &[CompilationResult]) -> CompileSummary {
    let total = results.len();
    let succeeded = results.iter().filter(|r| r.success).count();
    let cached = results.iter().filter(|r| r.was_cached).count();
    let total_time_ms: u64 = results.iter().map(|r| r.duration_ms).sum();
    let max_time_ms = results.iter().map(|r| r.duration_ms).max().unwrap_or(0);
    
    CompileSummary {
        total_units: total,
        succeeded,
        failed: total - succeeded,
        cached,
        compiled: succeeded - cached,
        total_time_ms,
        wall_time_ms: max_time_ms, // Approximate for parallel
    }
}

/// Summary of compilation results
#[derive(Debug, Clone)]
pub struct CompileSummary {
    pub total_units: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub cached: usize,
    pub compiled: usize,
    pub total_time_ms: u64,
    pub wall_time_ms: u64,
}

impl CompileSummary {
    pub fn to_string(&self) -> String {
        format!(
            "[Compile] {}/{} succeeded ({} cached, {} compiled) in {}ms (wall: {}ms)",
            self.succeeded,
            self.total_units,
            self.cached,
            self.compiled,
            self.total_time_ms,
            self.wall_time_ms
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleInfo {
    pub id: String,
    pub path: String,
    pub parents: Vec<String>,
    pub children: Vec<String>,
    pub last_modified: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleGraph {
    pub modules: HashMap<String, ModuleInfo>,
    pub entry_point: String,
}

impl ModuleGraph {
    pub fn new(entry_point: String) -> Self {
        Self {
            modules: HashMap::new(),
            entry_point,
        }
    }

    pub fn add_module(&mut self, path: String, children: Vec<String>) {
        let id = path.clone(); // Use path as ID for simplicity
        let module = ModuleInfo {
            id: id.clone(),
            path: path.clone(),
            parents: Vec::new(),
            children: children.clone(),
            last_modified: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs(),
        };
        self.modules.insert(id.clone(), module);

        // Update parents
        for child in children {
            if let Some(child_module) = self.modules.get_mut(&child) {
                if !child_module.parents.contains(&id) {
                    child_module.parents.push(id.clone());
                }
            } else {
                // Child doesn't exist yet, create a placeholder or handle later
                // For now, we assume we process files in an order or handle this in a second pass
                // But simpler: just store the relationship
            }
        }
    }
    
    // Rebuild parents from children
    pub fn rebuild_parents(&mut self) {
        let mut parent_map: HashMap<String, Vec<String>> = HashMap::new();
        for (id, module) in &self.modules {
            for child in &module.children {
                parent_map.entry(child.clone()).or_default().push(id.clone());
            }
        }
        
        for (id, module) in self.modules.iter_mut() {
            if let Some(parents) = parent_map.get(id) {
                module.parents = parents.clone();
            } else {
                module.parents.clear();
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateManifest {
    pub session_id: String,
    pub timestamp: u64,
    pub changed_modules: Vec<String>,
    pub removed_modules: Vec<String>,
    pub reload_needed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePayload {
    pub manifest: UpdateManifest,
    pub modules: HashMap<String, String>, // id -> content
}

pub struct BuildSession {
    pub session_id: String,
    pub graph: ModuleGraph,
    pub workspace_root: PathBuf,
    pub session_hash: String,
}

impl BuildSession {
    pub fn new(workspace_root: PathBuf) -> Self {
        let session_id = Uuid::new_v4().to_string();
        let session_hash = Uuid::new_v4().to_string(); // Simple hash for now
        Self {
            session_id,
            graph: ModuleGraph::new("".to_string()),
            workspace_root,
            session_hash,
        }
    }

    pub fn scan_dependencies(&mut self, entry_file: &str) {
        // This is a simplified dependency scanner.
        // In a real world, we'd use a proper parser for the language.
        // Here we just look for #include "..." or import ...
        
        let mut visited = HashSet::new();
        let mut queue = vec![entry_file.to_string()];
        
        self.graph.entry_point = entry_file.to_string();
        self.graph.modules.clear();

        while let Some(file_path) = queue.pop() {
            if visited.contains(&file_path) {
                continue;
            }
            visited.insert(file_path.clone());

            let full_path = self.workspace_root.join(&file_path);
            if let Ok(content) = fs::read_to_string(&full_path) {
                let children = self.parse_imports(&content, &file_path);
                self.graph.add_module(file_path.clone(), children.clone());
                
                for child in children {
                    if !visited.contains(&child) {
                        queue.push(child);
                    }
                }
            }
        }
        
        self.graph.rebuild_parents();
    }

    fn parse_imports(&self, content: &str, _current_file: &str) -> Vec<String> {
        let mut imports = Vec::new();
        // Very basic parser
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with("#include \"") {
                if let Some(end) = line[10..].find('"') {
                    let import = &line[10..10+end];
                    // Resolve relative path
                    // For simplicity, assume flat or relative to root for now, 
                    // or implement basic relative path resolution
                    imports.push(import.to_string());
                }
            }
            // Add other languages as needed (e.g. Rust mod/use, JS import)
        }
        imports
    }

    pub fn incremental_compile(&mut self, changed_files: Vec<String>) -> Option<UpdatePayload> {
        // 1. Identify affected modules
        // For now, we just take the changed files. 
        // In a real system, we'd traverse up the parents to see what needs recompilation.
        
        let mut reload_needed = false;
        let mut affected_modules = HashSet::new();
        for file in &changed_files {
            if file.ends_with("Cargo.toml") || file.ends_with("package.json") {
                reload_needed = true;
            }
            affected_modules.insert(file.clone());
            // Add parents? If we are just sending updated code for HMR, maybe just the file.
            // If we are recompiling a binary, we need to re-link.
            // The request says "outputs only changed modules".
        }

        if affected_modules.is_empty() {
            return None;
        }

        let mut modules_content = HashMap::new();
        for module_id in &affected_modules {
            let full_path = self.workspace_root.join(module_id);
            if let Ok(content) = fs::read_to_string(full_path) {
                modules_content.insert(module_id.clone(), content);
            }
        }

        let manifest = UpdateManifest {
            session_id: self.session_id.clone(),
            timestamp: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs(),
            changed_modules: affected_modules.into_iter().collect(),
            removed_modules: Vec::new(), // Handle deletions later
            reload_needed,
        };

        Some(UpdatePayload {
            manifest,
            modules: modules_content,
        })
    }
    
    pub fn validate_session(&self, hash: &str) -> bool {
        self.session_hash == hash
    }
}

// ============================================================
// REBUILD DECISION MATRIX
// ============================================================
// Determines what needs to be rebuilt based on file changes
// ============================================================

/// What modules need to be rebuilt
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RebuildScope {
    /// Nothing changed
    None,
    /// Only GUI needs rebuild (core state preserved)
    GuiOnly,
    /// Only Core needs rebuild (will trigger GUI reload too due to ABI)
    CoreOnly,
    /// Both modules need rebuild
    Both,
    /// Full reload required (entry point or shared header changed)
    FullReload,
}

impl RebuildScope {
    /// Combine two scopes (take the more extensive one)
    pub fn merge(&self, other: &RebuildScope) -> RebuildScope {
        match (self, other) {
            (RebuildScope::None, x) | (x, RebuildScope::None) => x.clone(),
            (RebuildScope::FullReload, _) | (_, RebuildScope::FullReload) => RebuildScope::FullReload,
            (RebuildScope::Both, _) | (_, RebuildScope::Both) => RebuildScope::Both,
            (RebuildScope::CoreOnly, _) | (_, RebuildScope::CoreOnly) => RebuildScope::Both,
            (RebuildScope::GuiOnly, RebuildScope::GuiOnly) => RebuildScope::GuiOnly,
        }
    }
}

/// Content hashes for change detection
#[derive(Debug, Clone, Default)]
pub struct ModuleHashes {
    pub shared_hash: u64,
    pub core_hash: u64,
    pub gui_hash: u64,
    pub main_hash: u64,
}

impl ModuleHashes {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Determine rebuild scope from changed files
pub fn determine_rebuild_scope(
    changed_files: &[String],
    prev_hashes: &ModuleHashes,
    new_hashes: &ModuleHashes,
) -> RebuildScope {
    let mut scope = RebuildScope::None;
    
    for file in changed_files {
        let file_lower = file.to_lowercase();
        
        // Check file type and merge scopes
        let file_scope = if file_lower.ends_with("shared.h") || file_lower.ends_with("shared.hpp") {
            // Shared header changed - need to rebuild both
            RebuildScope::FullReload
        } else if file_lower.contains("core") && is_source_file(&file_lower) {
            // Core source changed
            if prev_hashes.shared_hash != new_hashes.shared_hash {
                // ABI might have changed - full reload
                RebuildScope::FullReload
            } else {
                RebuildScope::CoreOnly
            }
        } else if file_lower.contains("gui") && is_source_file(&file_lower) {
            // GUI source changed - can swap independently
            RebuildScope::GuiOnly
        } else if is_source_file(&file_lower) {
            // Other source file (main or unknown)
            RebuildScope::Both
        } else {
            RebuildScope::None
        };
        
        scope = scope.merge(&file_scope);
    }
    
    // Additional hash-based checks
    if prev_hashes.shared_hash != new_hashes.shared_hash {
        scope = RebuildScope::FullReload;
    }
    
    scope
}

fn is_source_file(path: &str) -> bool {
    path.ends_with(".cpp") || 
    path.ends_with(".c") || 
    path.ends_with(".h") || 
    path.ends_with(".hpp") ||
    path.ends_with(".rs") ||
    path.ends_with(".py") ||
    path.ends_with(".js") ||
    path.ends_with(".ts")
}

// ============================================================
// COMPONENT-LEVEL GRANULARITY (Widget Splitting)
// ============================================================
// Detects widget boundaries in GUI code and creates separate
// compilation units for each widget. Each widget becomes a
// separate .so with its own widget_on_render() entry point.
// ============================================================

/// Detected widget component
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetComponent {
    /// Unique widget identifier (e.g., "slider_widget", "button_panel")
    pub id: String,
    /// Widget class/struct name as found in source (or synthetic name for functions)
    pub class_name: String,
    /// Source file containing the widget
    pub source_file: String,
    /// Line range in source (start, end)
    pub line_range: (usize, usize),
    /// Extracted widget code
    pub code: String,
    /// Dependencies on other widgets
    pub dependencies: Vec<String>,
    /// State variables this widget uses
    pub state_vars: Vec<String>,
    /// Generated entry point function name
    pub entry_point: String,
    /// Whether this is a class-based widget (true) or a standalone function (false)
    pub is_class_based: bool,
    /// The original function name (if function-based)
    pub original_function: Option<String>,
}

/// Widget detection results
#[derive(Debug, Clone)]
pub struct WidgetAnalysis {
    /// Detected widgets
    pub widgets: Vec<WidgetComponent>,
    /// Shared state structure (needs to be in core module)
    pub shared_state: SharedWidgetState,
    /// Widget dependency graph
    pub dependency_graph: HashMap<String, Vec<String>>,
    /// Shared context code (helper functions, includes, typedefs) that widgets depend on
    pub shared_context_code: String,
}

/// Shared state between widgets
#[derive(Debug, Clone, Default)]
pub struct SharedWidgetState {
    /// State variable names and types
    pub variables: Vec<(String, String)>,
    /// Generated shared header content
    pub header_code: String,
}

/// Widget detector for GUI code
pub struct WidgetDetector {
    /// Pattern matchers for widget detection
    patterns: WidgetPatterns,
}

/// Patterns for detecting different widget types
#[derive(Debug, Clone)]
struct WidgetPatterns {
    /// SDL2 widget patterns
    sdl2_render_patterns: Vec<String>,
    /// Class/struct patterns that indicate widgets
    widget_class_patterns: Vec<String>,
    /// Function patterns that indicate render methods
    render_func_patterns: Vec<String>,
    /// State access patterns
    state_patterns: Vec<String>,
}

impl Default for WidgetPatterns {
    fn default() -> Self {
        Self {
            sdl2_render_patterns: vec![
                "SDL_RenderFillRect".into(),
                "SDL_RenderCopy".into(),
                "SDL_RenderDrawRect".into(),
                "SDL_RenderDrawLine".into(),
                "SDL_SetRenderDrawColor".into(),
            ],
            widget_class_patterns: vec![
                "Widget".into(),
                "Panel".into(),
                "Button".into(),
                "Slider".into(),
                "Control".into(),
                "View".into(),
                "Component".into(),
            ],
            render_func_patterns: vec![
                "render".into(),
                "draw".into(),
                "on_render".into(),
                "paint".into(),
                "display".into(),
            ],
            state_patterns: vec![
                "state->".into(),
                "state.".into(),
                "shared_state".into(),
                "app_state".into(),
            ],
        }
    }
}

impl WidgetDetector {
    pub fn new() -> Self {
        Self {
            patterns: WidgetPatterns::default(),
        }
    }
    
    /// Analyze GUI source code and detect widget boundaries
    pub fn analyze(&self, source_code: &str, source_file: &str) -> WidgetAnalysis {
        let lines: Vec<&str> = source_code.lines().collect();
        let mut widgets = Vec::new();
        let mut shared_vars: Vec<(String, String)> = Vec::new();
        
        // Phase 1: Find widget class/struct definitions
        let widget_regions = self.find_widget_regions(&lines);
        
        // Phase 2: Extract each widget's code and analyze dependencies
        for (class_name, start_line, end_line, is_class_based, original_func) in &widget_regions {
            let widget_code = lines[*start_line..=*end_line].join("\n");
            let id = self.generate_widget_id(class_name);
            let entry_point = format!("{}_on_render", id);
            
            // Find state variable accesses
            let state_vars = self.extract_state_accesses(&widget_code);
            for var in &state_vars {
                if !shared_vars.iter().any(|(n, _)| n == var) {
                    // Infer type (simplified - in production use proper parsing)
                    let var_type = self.infer_state_type(var, &widget_code);
                    shared_vars.push((var.clone(), var_type));
                }
            }
            
            // Find dependencies on other widgets
            let dependencies = self.extract_widget_dependencies(&widget_code, class_name);
            
            // Generate the component code with entry point wrapper
            let component_code = self.generate_widget_module(class_name, &widget_code, &entry_point, &state_vars, *is_class_based, original_func.as_deref());
            
            widgets.push(WidgetComponent {
                id,
                class_name: class_name.clone(),
                source_file: source_file.to_string(),
                line_range: (start_line + 1, end_line + 1), // 1-indexed
                code: component_code,
                dependencies,
                state_vars,
                entry_point,
                is_class_based: *is_class_based,
                original_function: original_func.clone(),
            });
        }
        
        // Build dependency graph
        let mut dependency_graph = HashMap::new();
        for widget in &widgets {
            dependency_graph.insert(widget.id.clone(), widget.dependencies.clone());
        }
        
        // Generate shared state header
        let shared_state = SharedWidgetState {
            variables: shared_vars.clone(),
            header_code: self.generate_shared_state_header(&shared_vars),
        };
        
        // Phase 3: Extract shared context code (non-widget functions, includes, typedefs)
        // This is everything in the source that ISN'T a widget - helper functions, type definitions, etc.
        // Convert widget_regions to the format expected by extract_shared_context
        let regions_for_context: Vec<(String, usize, usize)> = widget_regions.iter()
            .map(|(name, start, end, _, _)| (name.clone(), *start, *end))
            .collect();
        let shared_context_code = self.extract_shared_context(&lines, &regions_for_context);
        
        WidgetAnalysis {
            widgets,
            shared_state,
            dependency_graph,
            shared_context_code,
        }
    }
    
    /// Find regions in code that define widgets
    /// Returns: Vec<(class_name, start_line, end_line, is_class_based, original_function_name)>
    fn find_widget_regions(&self, lines: &[&str]) -> Vec<(String, usize, usize, bool, Option<String>)> {
        let mut regions = Vec::new();
        let mut i = 0;
        
        // Functions that should NOT be treated as widgets (they're helpers or lifecycle hooks)
        let excluded_functions = [
            "draw_text", "get_glyph", "init", "setup", "cleanup", "destroy",
            "gui_on_load", "gui_on_unload", "gui_on_event", "gui_on_save_state",
            "core_on_load", "core_on_unload", "core_on_update", "core_on_event",
            "on_load", "on_unload", "on_update", "on_event", "on_save_state",
            "main", "_user_main", "SDL_main",
        ];
        
        while i < lines.len() {
            let line = lines[i].trim();
            
            // Check for class/struct definition
            if let Some(class_name) = self.extract_class_name(line) {
                // Verify it's a widget by checking patterns
                if self.is_widget_class(&class_name) {
                    // Find the end of the class definition
                    if let Some(end_line) = self.find_class_end(lines, i) {
                        regions.push((class_name, i, end_line, true, None));
                        i = end_line;
                    }
                }
            }
            
            // Also look for standalone render functions - but be more selective
            if let Some(func_name) = self.extract_function_name(line) {
                // Skip excluded functions
                let is_excluded = excluded_functions.iter().any(|ex| func_name.to_lowercase() == ex.to_lowercase());
                
                // Only consider functions that look like top-level widget entry points
                // They should have "widget" in the name OR be gui_on_render specifically
                let is_widget_entry = func_name.to_lowercase().contains("widget") 
                    || func_name == "gui_on_render"
                    || (func_name.to_lowercase().ends_with("_on_render") && !is_excluded);
                
                if is_widget_entry && !is_excluded {
                    if self.patterns.render_func_patterns.iter().any(|p| func_name.to_lowercase().contains(p)) {
                        // Check if this function contains SDL rendering calls
                        if let Some(end_line) = self.find_function_end(lines, i) {
                            let func_code: String = lines[i..=end_line].join("\n");
                            if self.contains_render_calls(&func_code) {
                                // Create synthetic widget for standalone render function
                                let widget_name = format!("{}_widget", func_name.to_lowercase());
                                regions.push((widget_name, i, end_line, false, Some(func_name)));
                                i = end_line;
                            }
                        }
                    }
                }
            }
            
            i += 1;
        }
        
        regions
    }
    
    /// Extract class name from a line
    fn extract_class_name(&self, line: &str) -> Option<String> {
        // Match: class ClassName ... or struct StructName ...
        let _patterns = [
            (r"class\s+(\w+)", 6),  // "class " prefix
            (r"struct\s+(\w+)", 7), // "struct " prefix
        ];
        
        let patterns: &[(&[u8], usize)] = &[(b"class ", 6), (b"struct ", 7)];
        for (prefix, skip) in patterns {
            let bytes = line.as_bytes();
            if let Some(pos) = bytes.windows(prefix.len()).position(|w| w == *prefix) {
                let rest = &line[pos + skip..];
                // Extract word
                let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                if !name.is_empty() {
                    return Some(name);
                }
            }
        }
        None
    }
    
    /// Extract function name from a line
    fn extract_function_name(&self, line: &str) -> Option<String> {
        // Simple heuristic: look for pattern like "type function_name(" or "function_name("
        if let Some(paren_pos) = line.find('(') {
            let before_paren = &line[..paren_pos].trim_end();
            // Get last word before parenthesis
            if let Some(name) = before_paren.split_whitespace().last() {
                let name = name.trim_start_matches('*').trim_start_matches('&');
                if !name.is_empty() && !["if", "while", "for", "switch", "return"].contains(&name) {
                    return Some(name.to_string());
                }
            }
        }
        None
    }
    
    /// Check if class name looks like a widget
    fn is_widget_class(&self, class_name: &str) -> bool {
        self.patterns.widget_class_patterns.iter()
            .any(|pattern| class_name.contains(pattern))
    }
    
    /// Find the end of a class definition
    fn find_class_end(&self, lines: &[&str], start: usize) -> Option<usize> {
        let mut brace_count = 0;
        let mut found_open = false;
        
        for i in start..lines.len() {
            for ch in lines[i].chars() {
                if ch == '{' {
                    brace_count += 1;
                    found_open = true;
                } else if ch == '}' {
                    brace_count -= 1;
                }
            }
            
            if found_open && brace_count == 0 {
                return Some(i);
            }
        }
        None
    }
    
    /// Find the end of a function definition
    fn find_function_end(&self, lines: &[&str], start: usize) -> Option<usize> {
        self.find_class_end(lines, start) // Same logic
    }
    
    /// Check if code contains SDL render calls
    fn contains_render_calls(&self, code: &str) -> bool {
        self.patterns.sdl2_render_patterns.iter()
            .any(|pattern| code.contains(pattern))
    }
    
    /// Extract state variable accesses from code
    fn extract_state_accesses(&self, code: &str) -> Vec<String> {
        let mut vars = Vec::new();
        
        // Look for state->varname or state.varname patterns
        for pattern in &self.patterns.state_patterns {
            let _base = pattern.trim_end_matches(|c| c == '-' || c == '>' || c == '.');
            
            // Find all occurrences
            let mut search_start = 0;
            while let Some(pos) = code[search_start..].find(pattern) {
                let abs_pos = search_start + pos + pattern.len();
                if abs_pos < code.len() {
                    // Extract variable name
                    let rest = &code[abs_pos..];
                    let var_name: String = rest.chars()
                        .take_while(|c| c.is_alphanumeric() || *c == '_')
                        .collect();
                    
                    if !var_name.is_empty() && !vars.contains(&var_name) {
                        vars.push(var_name);
                    }
                }
                search_start = abs_pos;
            }
        }
        
        vars
    }
    
    /// Infer variable type from usage (simplified)
    fn infer_state_type(&self, var_name: &str, _code: &str) -> String {
        // Very simplified type inference
        let var_lower = var_name.to_lowercase();
        
        if var_lower.contains("count") || var_lower.contains("num") || var_lower.contains("index") {
            "int".to_string()
        } else if var_lower.contains("value") || var_lower.contains("position") || var_lower.contains("slider") {
            "float".to_string()
        } else if var_lower.contains("enabled") || var_lower.contains("visible") || var_lower.contains("active") {
            "bool".to_string()
        } else if var_lower.contains("text") || var_lower.contains("label") || var_lower.contains("name") {
            "std::string".to_string()
        } else {
            // Default to int
            "int".to_string()
        }
    }
    
    /// Extract dependencies on other widgets
    fn extract_widget_dependencies(&self, code: &str, self_class: &str) -> Vec<String> {
        let mut deps = Vec::new();
        
        for pattern in &self.patterns.widget_class_patterns {
            // Look for references to other widget types
            let search = format!("{}", pattern);
            if code.contains(&search) && !self_class.contains(pattern) {
                // Find actual class names
                let words: Vec<&str> = code.split(|c: char| !c.is_alphanumeric() && c != '_').collect();
                for word in words {
                    if word.contains(pattern) && word != self_class {
                        let dep_id = self.generate_widget_id(word);
                        if !deps.contains(&dep_id) {
                            deps.push(dep_id);
                        }
                    }
                }
            }
        }
        
        deps
    }
    
    /// Generate widget ID from class name
    fn generate_widget_id(&self, class_name: &str) -> String {
        // Convert PascalCase/CamelCase to snake_case
        let mut result = String::new();
        for (i, ch) in class_name.chars().enumerate() {
            if ch.is_uppercase() && i > 0 {
                result.push('_');
            }
            result.push(ch.to_ascii_lowercase());
        }
        result
    }
    
    /// Convert to PascalCase
    fn to_pascal_case(&self, name: &str) -> String {
        let mut result = String::new();
        let mut capitalize_next = true;
        
        for ch in name.chars() {
            if ch == '_' || ch == '-' {
                capitalize_next = true;
            } else if capitalize_next {
                result.push(ch.to_ascii_uppercase());
                capitalize_next = false;
            } else {
                result.push(ch);
            }
        }
        
        result
    }
    
    /// Generate widget module code with entry point
    fn generate_widget_module(
        &self,
        class_name: &str,
        original_code: &str,
        entry_point: &str,
        _state_vars: &[String],
        state_vars: &[String],
        is_class_based: bool,
        original_function: Option<&str>,
    ) -> String {
        let mut code = String::new();
        
        // Header with includes - include shared.h for AppState and other shared types
        code.push_str("// Auto-generated widget module\n");
        code.push_str("#include <SDL2/SDL.h>\n");
        code.push_str("#include <stdint.h>\n");
        code.push_str("#include <string.h>\n");
        code.push_str("#include <stdio.h>\n");
        code.push_str("#include <stdlib.h>\n\n");
        
        // Try to include shared.h if it exists (for AppState definition)
        code.push_str("// Include shared state definitions\n");
        code.push_str("#if __has_include(\"shared.h\")\n");
        code.push_str("#include \"shared.h\"\n");
        code.push_str("#endif\n\n");
        
        // Include widget shared state header
        code.push_str("#include \"widget_shared_state.h\"\n\n");
        
        // Include the shared context header with helper functions (get_glyph, draw_text, etc.)
        code.push_str("// Include shared context for widget dependencies\n");
        code.push_str("#include \"widget_context.h\"\n\n");
        
        // Include the full GUI header for any additional types
        code.push_str("// Include full GUI header if available\n");
        code.push_str("#if __has_include(\"gui.h\")\n");
        code.push_str("#include \"gui.h\"\n");
        code.push_str("#endif\n\n");
        
        // Original widget code
        code.push_str("// Original widget code\n");
        code.push_str(original_code);
        code.push_str("\n\n");
        
        // Generate entry point wrapper
        code.push_str("// Widget entry point\n");
        code.push_str(&format!(
            "extern \"C\" void {}(SDL_Renderer* renderer, WidgetSharedState* state) {{\n",
            entry_point
        ));
        code.push_str("    (void)renderer; (void)state; // Suppress unused warnings\n");
        
        if is_class_based {
            // For class-based widgets, instantiate the class and call render
            code.push_str(&format!("    static {} widget;\n", class_name));
            code.push_str("    widget.render(renderer, state);\n");
        } else if let Some(func_name) = original_function {
            // For function-based widgets, we need to call them correctly based on signature
            // Check if the function takes (void* state_ptr) - the gui_on_render signature
            let code_lower = original_code.to_lowercase();
            let func_lower = func_name.to_lowercase();
            
            if code_lower.contains(&format!("void {}(void*", func_lower)) 
               || code_lower.contains(&format!("{} (void*", func_lower))
               || original_code.contains("void* state_ptr") {
                // gui_on_render style: void gui_on_render(void* state_ptr)
                code.push_str(&format!("    // Function takes void* state_ptr\n"));
                code.push_str(&format!("    {}((void*)state);\n", func_name));
            } else if code_lower.contains(&format!("void {}(sdl_renderer*", func_lower))
                    || original_code.contains("SDL_Renderer* renderer") {
                // Check if it takes (SDL_Renderer*, WidgetSharedState*)
                if original_code.contains("WidgetSharedState*") {
                    code.push_str(&format!("    // Function takes SDL_Renderer*, WidgetSharedState*\n"));
                    code.push_str(&format!("    {}(renderer, state);\n", func_name));
                } else {
                    // Just takes SDL_Renderer*
                    code.push_str(&format!("    // Function takes SDL_Renderer*\n"));
                    code.push_str(&format!("    {}(renderer);\n", func_name));
                }
            } else {
                // Unknown signature - call with state cast to void*
                code.push_str(&format!("    // Unknown signature - passing state as void*\n"));
                code.push_str(&format!("    {}((void*)state);\n", func_name));
            }
        }
        
        code.push_str("}\n\n");
        
        // Export symbol
        code.push_str(&format!(
            "extern \"C\" const char* widget_name() {{ return \"{}\"; }}\n",
            class_name
        ));
        
        code
    }
    
    /// Generate shared state header
    fn generate_shared_state_header(&self, variables: &[(String, String)]) -> String {
        let mut code = String::new();
        
        code.push_str("// Auto-generated widget shared state\n");
        code.push_str("#pragma once\n\n");
        code.push_str("#include <string>\n\n");
        code.push_str("struct WidgetSharedState {\n");
        
        for (name, var_type) in variables {
            code.push_str(&format!("    {} {};\n", var_type, name));
        }
        
        // Default constructor
        code.push_str("\n    WidgetSharedState() :\n");
        let init_list: Vec<String> = variables.iter()
            .map(|(name, var_type)| {
                let default_val = match var_type.as_str() {
                    "int" => "0",
                    "float" => "0.0f",
                    "bool" => "false",
                    "std::string" => "\"\"",
                    _ => "{}",
                };
                format!("        {}({})", name, default_val)
            })
            .collect();
        code.push_str(&init_list.join(",\n"));
        code.push_str("\n    {}\n");
        code.push_str("};\n");
        
        code
    }
    
    /// Extract shared context code (non-widget code) that widgets depend on.
    /// This includes: includes, typedefs, helper functions, structs that aren't widgets
    fn extract_shared_context(&self, lines: &[&str], widget_regions: &[(String, usize, usize)]) -> String {
        let mut context_code = String::new();
        
        // Header for the shared context
        context_code.push_str("// Auto-generated shared context for widgets\n");
        context_code.push_str("// Contains helper functions, includes, and non-widget code\n");
        context_code.push_str("#pragma once\n\n");
        
        // CRITICAL: Add ABI version constants that widgets depend on
        context_code.push_str("// Synthi ABI version constants\n");
        context_code.push_str("#ifndef SYNTHI_ABI_VERSION\n");
        context_code.push_str("#define SYNTHI_ABI_VERSION 1\n");
        context_code.push_str("#endif\n\n");
        
        context_code.push_str("#ifndef CORE_STATE_MAGIC\n");
        context_code.push_str("#define CORE_STATE_MAGIC 0xDEADBEEF\n");
        context_code.push_str("#endif\n\n");
        
        context_code.push_str("#ifndef GUI_STATE_MAGIC\n");
        context_code.push_str("#define GUI_STATE_MAGIC 0x60108EEF\n");
        context_code.push_str("#endif\n\n");
        
        // Standard includes that widgets commonly need
        context_code.push_str("#include <SDL2/SDL.h>\n");
        context_code.push_str("#include <stdint.h>\n");
        context_code.push_str("#include <string.h>\n");
        context_code.push_str("#include <stdio.h>\n");
        context_code.push_str("#include <stdlib.h>\n");
        context_code.push_str("#include <stdbool.h>\n\n");
        
        // Add fallback AppState definition if not defined elsewhere
        // This ensures widgets that reference AppState can compile
        context_code.push_str("// Fallback AppState definition for widget compatibility\n");
        context_code.push_str("#ifndef WIDGET_APPSTATE_DEFINED\n");
        context_code.push_str("#define WIDGET_APPSTATE_DEFINED\n");
        context_code.push_str("typedef struct AppState {\n");
        context_code.push_str("    uint32_t magic;\n");
        context_code.push_str("    uint32_t struct_size;\n");
        context_code.push_str("    uint32_t abi_version;\n");
        context_code.push_str("    SDL_Renderer* renderer;\n");
        context_code.push_str("    int running;\n");
        context_code.push_str("    int btn_x, btn_y, btn_w, btn_h;\n");
        context_code.push_str("    int click_count;\n");
        context_code.push_str("    void* user_data;\n");
        context_code.push_str("} AppState;\n");
        context_code.push_str("#endif\n\n");
        
        // Create a set of line ranges that are widgets (to exclude them)
        let mut widget_line_set: std::collections::HashSet<usize> = std::collections::HashSet::new();
        for (_, start, end) in widget_regions {
            for line_num in *start..=*end {
                widget_line_set.insert(line_num);
            }
        }
        
        // Track which functions we're skipping (gui_on_load should NOT be in widget context)
        let excluded_functions = ["gui_on_load", "core_on_load", "on_load"];
        
        // Extract non-widget code
        let mut i = 0;
        while i < lines.len() {
            if widget_line_set.contains(&i) {
                i += 1;
                continue;
            }
            
            let line = lines[i];
            let trimmed = line.trim();
            
            // Skip empty lines at this phase
            if trimmed.is_empty() {
                i += 1;
                continue;
            }
            
            // Include #include directives
            if trimmed.starts_with("#include") {
                context_code.push_str(line);
                context_code.push('\n');
                i += 1;
                continue;
            }
            
            // Include #define directives
            if trimmed.starts_with("#define") || trimmed.starts_with("#ifndef") || 
               trimmed.starts_with("#ifdef") || trimmed.starts_with("#endif") {
                context_code.push_str(line);
                context_code.push('\n');
                i += 1;
                continue;
            }
            
            // Include typedef
            if trimmed.starts_with("typedef") {
                context_code.push_str(line);
                context_code.push('\n');
                // Handle multi-line typedef
                if !trimmed.ends_with(';') {
                    i += 1;
                    while i < lines.len() && !lines[i].trim().ends_with(';') {
                        context_code.push_str(lines[i]);
                        context_code.push('\n');
                        i += 1;
                    }
                    if i < lines.len() {
                        context_code.push_str(lines[i]);
                        context_code.push('\n');
                    }
                }
                i += 1;
                continue;
            }
            
            // Include struct/class definitions that aren't widgets
            if (trimmed.starts_with("struct") || trimmed.starts_with("class")) && !widget_line_set.contains(&i) {
                if let Some(class_name) = self.extract_class_name(trimmed) {
                    if !self.is_widget_class(&class_name) {
                        // Include this struct/class
                        if let Some(end) = self.find_class_end(lines, i) {
                            for j in i..=end {
                                context_code.push_str(lines[j]);
                                context_code.push('\n');
                            }
                            i = end + 1;
                            continue;
                        }
                    }
                }
            }
            
            // Include function definitions (helper functions like get_glyph, draw_text)
            // BUT skip lifecycle functions like gui_on_load that have complex dependencies
            if self.looks_like_function_def(trimmed) && !widget_line_set.contains(&i) {
                // Check if this is an excluded function
                let should_exclude = excluded_functions.iter().any(|f| trimmed.contains(f));
                
                if !should_exclude {
                    // Check it's not inside a widget
                    if let Some(end) = self.find_function_end(lines, i) {
                        // Verify this function is not part of any widget region
                        let is_in_widget = widget_regions.iter().any(|(_, ws, we)| i >= *ws && i <= *we);
                        if !is_in_widget {
                            for j in i..=end {
                                context_code.push_str(lines[j]);
                                context_code.push('\n');
                            }
                            i = end + 1;
                            continue;
                        }
                    }
                } else {
                    // Skip this function entirely
                    if let Some(end) = self.find_function_end(lines, i) {
                        i = end + 1;
                        continue;
                    }
                }
            }
            
            // Include global variables - handle multi-line array initializations
            if self.looks_like_global_var(trimmed) && !widget_line_set.contains(&i) {
                // Check if this is a multi-line array initialization
                if trimmed.contains("= {") && !trimmed.ends_with("};") {
                    // Multi-line array - find the closing brace
                    context_code.push_str(line);
                    context_code.push('\n');
                    i += 1;
                    let mut brace_count = 1;
                    while i < lines.len() && brace_count > 0 {
                        let inner_line = lines[i];
                        for ch in inner_line.chars() {
                            if ch == '{' {
                                brace_count += 1;
                            } else if ch == '}' {
                                brace_count -= 1;
                            }
                        }
                        context_code.push_str(inner_line);
                        context_code.push('\n');
                        i += 1;
                    }
                    continue;
                } else {
                    context_code.push_str(line);
                    context_code.push('\n');
                }
            }
            
            i += 1;
        }
        
        context_code
    }
    
    /// Check if a line looks like a function definition
    fn looks_like_function_def(&self, line: &str) -> bool {
        // Simple heuristic: has a '(' and ends with '{' or has return type before name(
        if line.contains('(') && !line.starts_with("if") && !line.starts_with("while") &&
           !line.starts_with("for") && !line.starts_with("switch") && !line.starts_with("//") {
            // Check for common function patterns
            let has_brace = line.ends_with('{') || line.ends_with(')');
            let has_type = line.contains("void") || line.contains("int") || line.contains("bool") ||
                          line.contains("char") || line.contains("float") || line.contains("double") ||
                          line.contains("uint") || line.contains("const");
            return has_brace || has_type;
        }
        false
    }
    
    /// Check if a line looks like a global variable declaration
    fn looks_like_global_var(&self, line: &str) -> bool {
        // Simple heuristic: starts with type keywords and has = or ;
        let trimmed = line.trim();
        
        // Skip lines that look like function definitions
        if trimmed.contains('(') && !trimmed.contains("= {") {
            return false;
        }
        
        // Check for common global variable patterns
        let has_storage_class = trimmed.starts_with("static") || trimmed.starts_with("const") ||
                                trimmed.starts_with("extern");
        let has_type = trimmed.contains("int ") || trimmed.contains("bool ") ||
                       trimmed.contains("float ") || trimmed.contains("char ") ||
                       trimmed.contains("uint8_t") || trimmed.contains("uint16_t") ||
                       trimmed.contains("uint32_t") || trimmed.contains("int8_t") ||
                       trimmed.contains("size_t") || trimmed.contains("double ");
        
        if has_storage_class || has_type {
            return trimmed.contains('=') || trimmed.ends_with(';');
        }
        false
    }
}

/// Widget compilation manager
pub struct WidgetCompiler {
    detector: WidgetDetector,
    output_dir: PathBuf,
}

impl WidgetCompiler {
    pub fn new(output_dir: PathBuf) -> Self {
        Self {
            detector: WidgetDetector::new(),
            output_dir,
        }
    }
    
    /// Compile GUI code into separate widget modules
    pub async fn compile_widgets(
        &self,
        gui_source: &str,
        source_file: &str,
        compiler: &str,
        base_flags: &[&str],
    ) -> Result<Vec<WidgetCompilationResult>, String> {
        // Analyze the GUI source
        let analysis = self.detector.analyze(gui_source, source_file);
        
        if analysis.widgets.is_empty() {
            return Ok(Vec::new());
        }
        
        // Write shared state header
        let shared_header_path = self.output_dir.join("widget_shared_state.h");
        tokio::fs::write(&shared_header_path, &analysis.shared_state.header_code).await
            .map_err(|e| format!("Failed to write shared state header: {}", e))?;
        
        // Write shared context header (helper functions, non-widget code)
        let context_header_path = self.output_dir.join("widget_context.h");
        tokio::fs::write(&context_header_path, &analysis.shared_context_code).await
            .map_err(|e| format!("Failed to write shared context header: {}", e))?;
        
        // Compile each widget
        let mut results = Vec::new();
        
        for widget in &analysis.widgets {
            let result = self.compile_single_widget(widget, compiler, base_flags).await;
            results.push(result);
        }
        
        Ok(results)
    }
    
    /// Compile a single widget module
    async fn compile_single_widget(
        &self,
        widget: &WidgetComponent,
        compiler: &str,
        base_flags: &[&str],
    ) -> WidgetCompilationResult {
        use tokio::process::Command;
        use std::time::Instant;
        
        let start = Instant::now();
        
        // Write widget source
        let source_path = self.output_dir.join(format!("{}.cpp", widget.id));
        if let Err(e) = tokio::fs::write(&source_path, &widget.code).await {
            return WidgetCompilationResult {
                widget_id: widget.id.clone(),
                success: false,
                so_path: None,
                error: Some(format!("Failed to write source: {}", e)),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
        
        // Compile to object file
        let obj_path = self.output_dir.join(format!("{}.o", widget.id));
        let mut compile_cmd = Command::new(compiler);
        compile_cmd
            .arg("-c")
            .arg("-fPIC")
            .args(base_flags)
            .arg("-I").arg(&self.output_dir) // For shared state header
            .arg(&source_path)
            .arg("-o").arg(&obj_path)
            .current_dir(&self.output_dir);
        
        let compile_output = match compile_cmd.output().await {
            Ok(o) => o,
            Err(e) => {
                return WidgetCompilationResult {
                    widget_id: widget.id.clone(),
                    success: false,
                    so_path: None,
                    error: Some(format!("Failed to run compiler: {}", e)),
                    duration_ms: start.elapsed().as_millis() as u64,
                };
            }
        };
        
        if !compile_output.status.success() {
            return WidgetCompilationResult {
                widget_id: widget.id.clone(),
                success: false,
                so_path: None,
                error: Some(String::from_utf8_lossy(&compile_output.stderr).to_string()),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
        
        // Link to .so
        let so_path = self.output_dir.join(format!("lib{}_widget.so", widget.id));
        let mut link_cmd = Command::new(compiler);
        link_cmd
            .arg("-shared")
            .arg("-fPIC")
            .arg(&obj_path)
            .arg("-o").arg(&so_path)
            .arg("-lSDL2")
            .current_dir(&self.output_dir);
        
        let link_output = match link_cmd.output().await {
            Ok(o) => o,
            Err(e) => {
                return WidgetCompilationResult {
                    widget_id: widget.id.clone(),
                    success: false,
                    so_path: None,
                    error: Some(format!("Failed to link: {}", e)),
                    duration_ms: start.elapsed().as_millis() as u64,
                };
            }
        };
        
        if !link_output.status.success() {
            return WidgetCompilationResult {
                widget_id: widget.id.clone(),
                success: false,
                so_path: None,
                error: Some(String::from_utf8_lossy(&link_output.stderr).to_string()),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
        
        WidgetCompilationResult {
            widget_id: widget.id.clone(),
            success: true,
            so_path: Some(so_path),
            error: None,
            duration_ms: start.elapsed().as_millis() as u64,
        }
    }
}

/// Result of compiling a single widget
#[derive(Debug, Clone)]
pub struct WidgetCompilationResult {
    pub widget_id: String,
    pub success: bool,
    pub so_path: Option<PathBuf>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

/// Summary of widget compilation
#[derive(Debug, Clone)]
pub struct WidgetCompileSummary {
    pub total_widgets: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub total_time_ms: u64,
}

impl WidgetCompileSummary {
    pub fn from_results(results: &[WidgetCompilationResult]) -> Self {
        Self {
            total_widgets: results.len(),
            succeeded: results.iter().filter(|r| r.success).count(),
            failed: results.iter().filter(|r| !r.success).count(),
            total_time_ms: results.iter().map(|r| r.duration_ms).sum(),
        }
    }
}

/// Calculate hash for file content
pub fn hash_content(content: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    hasher.finish()
}

/// Analyze workspace and compute hashes for all relevant files
pub fn compute_module_hashes(workspace_root: &Path) -> ModuleHashes {
    let mut hashes = ModuleHashes::new();
    
    // Check each file type separately to avoid multiple mutable borrows
    for filename in ["shared.h", "shared.hpp"] {
        let path = workspace_root.join(filename);
        if let Ok(content) = fs::read_to_string(&path) {
            hashes.shared_hash = hash_content(&content);
        }
    }
    
    for filename in ["core.cpp", "core.c"] {
        let path = workspace_root.join(filename);
        if let Ok(content) = fs::read_to_string(&path) {
            hashes.core_hash = hash_content(&content);
        }
    }
    
    for filename in ["gui.cpp", "gui.c"] {
        let path = workspace_root.join(filename);
        if let Ok(content) = fs::read_to_string(&path) {
            hashes.gui_hash = hash_content(&content);
        }
    }
    
    for filename in ["main.cpp", "main.c"] {
        let path = workspace_root.join(filename);
        if let Ok(content) = fs::read_to_string(&path) {
            hashes.main_hash = hash_content(&content);
        }
    }
    
    hashes
}
