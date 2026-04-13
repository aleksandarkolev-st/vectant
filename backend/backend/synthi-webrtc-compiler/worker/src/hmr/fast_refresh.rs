// Fast refresh is actively used by HmrOrchestrator for boundary checking

// ============================================================
// FAST REFRESH BOUNDARY DETECTION MODULE
// ============================================================
// Detects when code changes cross HMR boundaries, requiring
// a full reload instead of hot update. Inspired by Next.js
// Fast Refresh boundary detection.
//
// KEY FEATURES:
// - Signature change detection (function params, state struct)
// - Non-component export detection
// - Global state mutation detection
// - Clear user messaging for boundary violations
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Types of Fast Refresh boundary violations
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BoundaryViolation {
    /// State struct layout changed (fields added/removed/reordered)
    StateLayoutChanged {
        module: String,
        old_fields: Vec<String>,
        new_fields: Vec<String>,
    },
    /// Function signature changed (can't hot-swap)
    SignatureChanged {
        function: String,
        old_signature: String,
        new_signature: String,
    },
    /// Non-component export added (e.g., global function that's not a hook)
    NonComponentExport { export_name: String, reason: String },
    /// Global state was mutated outside of proper hooks
    GlobalStateMutation { variable: String, location: String },
    /// ABI version mismatch between modules
    AbiMismatch {
        module: String,
        expected: u32,
        found: u32,
    },
    /// CoreAPI changed (GUI must reload)
    CoreApiChanged { changed_functions: Vec<String> },
    /// Module removed (can't hot-remove)
    ModuleRemoved { module: String },
    /// New required dependency added
    NewDependency { module: String, dependency: String },
}

impl BoundaryViolation {
    pub fn message(&self) -> String {
        match self {
            BoundaryViolation::StateLayoutChanged {
                module,
                old_fields,
                new_fields,
            } => {
                let added: Vec<_> = new_fields
                    .iter()
                    .filter(|f| !old_fields.contains(f))
                    .collect();
                let removed: Vec<_> = old_fields
                    .iter()
                    .filter(|f| !new_fields.contains(f))
                    .collect();
                format!(
                    "State struct in {} changed: {} field(s) added, {} field(s) removed. Full reload required to preserve type safety.",
                    module, added.len(), removed.len()
                )
            }
            BoundaryViolation::SignatureChanged {
                function,
                old_signature,
                new_signature,
            } => {
                format!(
                    "Function '{}' signature changed from '{}' to '{}'. Full reload required.",
                    function, old_signature, new_signature
                )
            }
            BoundaryViolation::NonComponentExport {
                export_name,
                reason,
            } => {
                format!(
                    "Export '{}' is not HMR-compatible: {}. Consider wrapping in a component or moving to a separate module.",
                    export_name, reason
                )
            }
            BoundaryViolation::GlobalStateMutation { variable, location } => {
                format!(
                    "Global state '{}' modified at {}. Use state hooks for HMR-safe state management.",
                    variable, location
                )
            }
            BoundaryViolation::AbiMismatch {
                module,
                expected,
                found,
            } => {
                format!(
                    "ABI version mismatch in {}: expected v{}, found v{}. Full reload required.",
                    module, expected, found
                )
            }
            BoundaryViolation::CoreApiChanged { changed_functions } => {
                format!(
                    "CoreAPI changed ({}). GUI will reload with new API.",
                    changed_functions.join(", ")
                )
            }
            BoundaryViolation::ModuleRemoved { module } => {
                format!("Module '{}' was removed. Full reload required.", module)
            }
            BoundaryViolation::NewDependency { module, dependency } => {
                format!(
                    "Module '{}' now depends on '{}'. Dependency chain changed.",
                    module, dependency
                )
            }
        }
    }

    pub fn is_fatal(&self) -> bool {
        matches!(
            self,
            BoundaryViolation::StateLayoutChanged { .. }
                | BoundaryViolation::SignatureChanged { .. }
                | BoundaryViolation::AbiMismatch { .. }
                | BoundaryViolation::ModuleRemoved { .. }
        )
    }

    pub fn requires_full_reload(&self) -> bool {
        matches!(
            self,
            BoundaryViolation::StateLayoutChanged { .. }
                | BoundaryViolation::SignatureChanged { .. }
                | BoundaryViolation::AbiMismatch { .. }
                | BoundaryViolation::ModuleRemoved { .. }
                | BoundaryViolation::GlobalStateMutation { .. }
        )
    }
}

/// Fast Refresh boundary check result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryCheckResult {
    /// Whether HMR can proceed
    pub can_hmr: bool,
    /// Violations found (may still be able to HMR with warnings)
    pub violations: Vec<BoundaryViolation>,
    /// Human-readable summary
    pub summary: String,
    /// Recommended action
    pub action: RefreshAction,
}

/// Recommended refresh action
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RefreshAction {
    /// Safe to hot-reload
    HotReload,
    /// Hot-reload with warnings
    HotReloadWithWarnings,
    /// Must reload GUI only (core API changed)
    ReloadGui,
    /// Must do full reload
    FullReload,
    /// Fatal - must restart process
    Restart,
}

/// Extracted function signature
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FunctionSignature {
    pub name: String,
    pub return_type: String,
    pub params: Vec<(String, String)>, // (name, type)
    pub is_extern_c: bool,
}

impl FunctionSignature {
    pub fn to_string(&self) -> String {
        let params: Vec<String> = self
            .params
            .iter()
            .map(|(name, ty)| format!("{} {}", ty, name))
            .collect();
        format!("{} {}({})", self.return_type, self.name, params.join(", "))
    }
}

/// Extracted state struct info
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateStructInfo {
    pub name: String,
    pub fields: Vec<(String, String)>, // (name, type)
    pub has_magic: bool,
    pub has_abi_version: bool,
}

/// Module analysis for boundary checking
#[derive(Debug, Clone, Default)]
pub struct ModuleAnalysis {
    pub functions: HashMap<String, FunctionSignature>,
    pub state_structs: HashMap<String, StateStructInfo>,
    pub exports: HashSet<String>,
    pub global_vars: HashSet<String>,
    pub dependencies: HashSet<String>,
    pub abi_version: Option<u32>,
}

/// Fast Refresh boundary checker
pub struct BoundaryChecker {
    /// Previous module analyses (for comparison)
    previous: HashMap<String, ModuleAnalysis>,
}

impl BoundaryChecker {
    pub fn new() -> Self {
        Self {
            previous: HashMap::new(),
        }
    }

    /// Analyze source code and extract boundary-relevant information
    pub fn analyze_source(&self, source: &str, _module_name: &str) -> ModuleAnalysis {
        let mut analysis = ModuleAnalysis::default();

        // Extract function signatures
        analysis.functions = self.extract_functions(source);

        // Extract state structs
        analysis.state_structs = self.extract_state_structs(source);

        // Extract exports (extern "C" functions)
        analysis.exports = self.extract_exports(source);

        // Extract global variables
        analysis.global_vars = self.extract_globals(source);

        // Extract ABI version
        analysis.abi_version = self.extract_abi_version(source);

        // Extract dependencies (#include directives, extern declarations)
        analysis.dependencies = self.extract_dependencies(source);

        analysis
    }

    /// Check if changes cross HMR boundaries
    pub fn check_boundaries(&mut self, module_name: &str, new_source: &str) -> BoundaryCheckResult {
        let new_analysis = self.analyze_source(new_source, module_name);
        let mut violations = Vec::new();

        // Check against previous version if available
        if let Some(old_analysis) = self.previous.get(module_name) {
            // Check state struct changes
            for (name, new_struct) in &new_analysis.state_structs {
                if let Some(old_struct) = old_analysis.state_structs.get(name) {
                    if old_struct.fields != new_struct.fields {
                        violations.push(BoundaryViolation::StateLayoutChanged {
                            module: module_name.to_string(),
                            old_fields: old_struct.fields.iter().map(|(n, _)| n.clone()).collect(),
                            new_fields: new_struct.fields.iter().map(|(n, _)| n.clone()).collect(),
                        });
                    }
                }
            }

            // Check function signature changes for exports
            for export in &new_analysis.exports {
                if let (Some(new_sig), Some(old_sig)) = (
                    new_analysis.functions.get(export),
                    old_analysis.functions.get(export),
                ) {
                    if new_sig.params != old_sig.params
                        || new_sig.return_type != old_sig.return_type
                    {
                        violations.push(BoundaryViolation::SignatureChanged {
                            function: export.clone(),
                            old_signature: old_sig.to_string(),
                            new_signature: new_sig.to_string(),
                        });
                    }
                }
            }

            // Check ABI version
            if let (Some(old_abi), Some(new_abi)) =
                (old_analysis.abi_version, new_analysis.abi_version)
            {
                if old_abi != new_abi {
                    violations.push(BoundaryViolation::AbiMismatch {
                        module: module_name.to_string(),
                        expected: old_abi,
                        found: new_abi,
                    });
                }
            }

            // Check for new dependencies
            for dep in &new_analysis.dependencies {
                if !old_analysis.dependencies.contains(dep) {
                    violations.push(BoundaryViolation::NewDependency {
                        module: module_name.to_string(),
                        dependency: dep.clone(),
                    });
                }
            }

            // Check for CoreAPI changes (if this is core module)
            if module_name == "core" {
                let old_api_funcs: HashSet<_> = old_analysis
                    .exports
                    .iter()
                    .filter(|e| e.starts_with("core_"))
                    .collect();
                let new_api_funcs: HashSet<_> = new_analysis
                    .exports
                    .iter()
                    .filter(|e| e.starts_with("core_"))
                    .collect();

                let changed: Vec<String> = old_api_funcs
                    .symmetric_difference(&new_api_funcs)
                    .map(|s| (*s).clone())
                    .collect();

                if !changed.is_empty() {
                    violations.push(BoundaryViolation::CoreApiChanged {
                        changed_functions: changed,
                    });
                }
            }
        }

        // Check for non-component exports (functions that aren't lifecycle hooks)
        let lifecycle_hooks = [
            "on_load",
            "on_update",
            "on_unload",
            "on_event",
            "on_render",
            "on_save_state",
            "on_load_from_json",
            "core_on_load",
            "core_on_update",
            "core_on_unload",
            "core_on_event",
            "core_get_api",
            "core_get_abi_version",
            "core_on_save_state",
            "core_on_load_from_json",
            "gui_on_load",
            "gui_on_render",
            "gui_on_event",
            "gui_on_unload",
            "gui_on_save_state",
            "gui_on_load_from_json",
            "gui_get_abi_version",
            "entrypoint",
            "main",
        ];

        for export in &new_analysis.exports {
            if !lifecycle_hooks.contains(&export.as_str()) && !export.starts_with("_") {
                // Check if it's a helper function (indicated by lowercase, no underscores at start)
                // These might be internal and could cause issues
                let is_suspicious = !export.contains("_")
                    || export.starts_with("get_")
                    || export.starts_with("set_");
                if is_suspicious {
                    violations.push(BoundaryViolation::NonComponentExport {
                        export_name: export.clone(),
                        reason: "Function exported but not a lifecycle hook. May cause issues on reload.".to_string(),
                    });
                }
            }
        }

        // Check for global state mutations
        for global in &new_analysis.global_vars {
            // Check if global is modified outside of on_load
            if self.check_global_mutation(new_source, global) {
                violations.push(BoundaryViolation::GlobalStateMutation {
                    variable: global.clone(),
                    location: "outside lifecycle hooks".to_string(),
                });
            }
        }

        // Store new analysis for next comparison
        self.previous.insert(module_name.to_string(), new_analysis);

        // Determine action
        let (can_hmr, action, summary) = self.determine_action(&violations);

        BoundaryCheckResult {
            can_hmr,
            violations,
            summary,
            action,
        }
    }

    /// Update stored analysis after successful HMR
    pub fn update_baseline(&mut self, module_name: &str, source: &str) {
        let analysis = self.analyze_source(source, module_name);
        self.previous.insert(module_name.to_string(), analysis);
    }

    /// Clear stored analysis for a module
    pub fn clear_module(&mut self, module_name: &str) {
        self.previous.remove(module_name);
    }

    /// Clear all stored analyses
    pub fn clear_all(&mut self) {
        self.previous.clear();
    }

    fn determine_action(&self, violations: &[BoundaryViolation]) -> (bool, RefreshAction, String) {
        if violations.is_empty() {
            return (
                true,
                RefreshAction::HotReload,
                "Safe to hot reload".to_string(),
            );
        }

        let fatal_count = violations.iter().filter(|v| v.is_fatal()).count();
        let reload_required = violations
            .iter()
            .filter(|v| v.requires_full_reload())
            .count();
        let core_api_changed = violations
            .iter()
            .any(|v| matches!(v, BoundaryViolation::CoreApiChanged { .. }));

        if fatal_count > 0 {
            let summary = format!(
                "Fast Refresh boundary crossed: {} fatal violation(s). Full reload required.",
                fatal_count
            );
            (false, RefreshAction::FullReload, summary)
        } else if core_api_changed {
            (
                true,
                RefreshAction::ReloadGui,
                "Core API changed. GUI will reload with new API.".to_string(),
            )
        } else if reload_required > 0 {
            let summary = format!(
                "Fast Refresh boundary crossed: {} violation(s) require full reload.",
                reload_required
            );
            (false, RefreshAction::FullReload, summary)
        } else {
            let summary = format!(
                "Hot reload with {} warning(s). State should be preserved.",
                violations.len()
            );
            (true, RefreshAction::HotReloadWithWarnings, summary)
        }
    }

    // ============================================================
    // SOURCE PARSING HELPERS
    // ============================================================

    fn extract_functions(&self, source: &str) -> HashMap<String, FunctionSignature> {
        let mut functions = HashMap::new();

        // Simple regex-like parsing for C/C++ function declarations
        // Pattern: [extern "C"] return_type function_name(params)
        let lines: Vec<&str> = source.lines().collect();
        let mut i = 0;

        while i < lines.len() {
            let line = lines[i].trim();

            // Check for extern "C" functions
            if line.contains("extern \"C\"")
                || line.starts_with("void ")
                || line.starts_with("int ")
                || line.starts_with("char* ")
                || line.starts_with("void* ")
                || line.starts_with("uint32_t ")
            {
                if let Some(sig) = self.parse_function_line(line) {
                    functions.insert(sig.name.clone(), sig);
                }
            }

            i += 1;
        }

        functions
    }

    fn parse_function_line(&self, line: &str) -> Option<FunctionSignature> {
        // Very simplified C/C++ function parsing
        let is_extern_c = line.contains("extern \"C\"");
        let cleaned = line.replace("extern \"C\"", "").trim().to_string();

        // Find function name and params
        if let Some(paren_start) = cleaned.find('(') {
            if let Some(paren_end) = cleaned.find(')') {
                let before_paren = cleaned[..paren_start].trim();
                let params_str = &cleaned[paren_start + 1..paren_end];

                // Split return type and name
                let parts: Vec<&str> = before_paren.split_whitespace().collect();
                if parts.len() >= 2 {
                    let name = parts[parts.len() - 1].trim_start_matches('*').to_string();
                    let return_type = parts[..parts.len() - 1].join(" ");

                    // Parse params
                    let params: Vec<(String, String)> = if params_str.trim().is_empty()
                        || params_str.trim() == "void"
                    {
                        Vec::new()
                    } else {
                        params_str
                            .split(',')
                            .filter_map(|p| {
                                let parts: Vec<&str> = p.trim().split_whitespace().collect();
                                if parts.len() >= 2 {
                                    let name =
                                        parts[parts.len() - 1].trim_start_matches('*').to_string();
                                    let ty = parts[..parts.len() - 1].join(" ");
                                    Some((name, ty))
                                } else if parts.len() == 1 {
                                    Some(("".to_string(), parts[0].to_string()))
                                } else {
                                    None
                                }
                            })
                            .collect()
                    };

                    return Some(FunctionSignature {
                        name,
                        return_type,
                        params,
                        is_extern_c,
                    });
                }
            }
        }

        None
    }

    fn extract_state_structs(&self, source: &str) -> HashMap<String, StateStructInfo> {
        let mut structs = HashMap::new();

        // Look for CoreState, GuiState, AppState structs
        let state_patterns = ["CoreState", "GuiState", "AppState", "WidgetState"];

        for pattern in state_patterns {
            if let Some(info) = self.parse_struct(source, pattern) {
                structs.insert(pattern.to_string(), info);
            }
        }

        structs
    }

    fn parse_struct(&self, source: &str, struct_name: &str) -> Option<StateStructInfo> {
        // Find struct/typedef struct definition
        let patterns = [
            format!("struct {} {{", struct_name),
            format!("typedef struct {} {{", struct_name),
            format!("typedef struct {{"), // anonymous struct typedef'd to name
        ];

        for pattern in patterns {
            if let Some(start) = source.find(&pattern) {
                // Find the closing brace
                let after_start = &source[start..];
                let mut brace_count = 0;
                let mut end_pos = None;

                for (i, c) in after_start.char_indices() {
                    match c {
                        '{' => brace_count += 1,
                        '}' => {
                            brace_count -= 1;
                            if brace_count == 0 {
                                end_pos = Some(i);
                                break;
                            }
                        }
                        _ => {}
                    }
                }

                if let Some(end) = end_pos {
                    let struct_body = &after_start[..end + 1];
                    let fields = self.extract_struct_fields(struct_body);

                    return Some(StateStructInfo {
                        name: struct_name.to_string(),
                        fields,
                        has_magic: struct_body.contains("magic"),
                        has_abi_version: struct_body.contains("abi_version"),
                    });
                }
            }
        }

        None
    }

    fn extract_struct_fields(&self, struct_body: &str) -> Vec<(String, String)> {
        let mut fields = Vec::new();

        // Simple field extraction: type name;
        for line in struct_body.lines() {
            let line = line.trim();

            // Skip comments and empty lines
            if line.is_empty()
                || line.starts_with("//")
                || line.starts_with("/*")
                || line.starts_with("*")
            {
                continue;
            }

            // Skip struct opening/closing
            if line.contains("{")
                || line == "}"
                || line.starts_with("typedef")
                || line.starts_with("struct")
            {
                continue;
            }

            // Parse field: type name;
            if let Some(semi) = line.find(';') {
                let field_decl = line[..semi].trim();
                let parts: Vec<&str> = field_decl.split_whitespace().collect();

                if parts.len() >= 2 {
                    let name = parts[parts.len() - 1].trim_start_matches('*').to_string();
                    let ty = parts[..parts.len() - 1].join(" ");
                    fields.push((name, ty));
                }
            }
        }

        fields
    }

    fn extract_exports(&self, source: &str) -> HashSet<String> {
        let mut exports = HashSet::new();

        // Find all extern "C" function declarations
        for line in source.lines() {
            let line = line.trim();
            if line.contains("extern \"C\"") {
                if let Some(sig) = self.parse_function_line(line) {
                    exports.insert(sig.name);
                }
            }
        }

        exports
    }

    fn extract_globals(&self, source: &str) -> HashSet<String> {
        let mut globals = HashSet::new();

        // Look for global variable declarations (outside of functions)
        // This is a simplified heuristic
        let mut in_function = false;
        let mut brace_count = 0;

        for line in source.lines() {
            let line = line.trim();

            // Track function scope
            if line.contains("{") {
                brace_count += line.matches("{").count() as i32;
                if brace_count == 1 {
                    in_function = true;
                }
            }
            if line.contains("}") {
                brace_count -= line.matches("}").count() as i32;
                if brace_count == 0 {
                    in_function = false;
                }
            }

            // Look for global variables (at top level)
            if !in_function && brace_count == 0 {
                // Pattern: static type name = ... or type name = ...
                if (line.starts_with("static ")
                    || line.starts_with("int ")
                    || line.starts_with("float ")
                    || line.starts_with("double ")
                    || line.starts_with("char ")
                    || line.starts_with("bool "))
                    && line.contains("=")
                    && line.contains(";")
                    && !line.contains("(")
                // Not a function
                {
                    let parts: Vec<&str> = line
                        .split("=")
                        .next()
                        .unwrap_or("")
                        .split_whitespace()
                        .collect();
                    if parts.len() >= 2 {
                        let name = parts[parts.len() - 1]
                            .trim_start_matches('*')
                            .trim_end_matches(';');
                        globals.insert(name.to_string());
                    }
                }
            }
        }

        globals
    }

    fn extract_abi_version(&self, source: &str) -> Option<u32> {
        // Look for ABI version constant or field
        // Pattern: abi_version = N or SYNTHI_*_ABI_VERSION

        if let Some(pos) = source.find("abi_version") {
            let after = &source[pos..];
            // Find the number
            for part in after.split(|c: char| !c.is_ascii_digit()) {
                if let Ok(v) = part.parse::<u32>() {
                    if v > 0 && v < 100 {
                        return Some(v);
                    }
                }
            }
        }

        // Check for ABI version defines
        if source.contains("SYNTHI_CORE_ABI_VERSION") || source.contains("SYNTHI_GUI_ABI_VERSION") {
            return Some(1); // Assume v1 if using the constants
        }

        None
    }

    fn extract_dependencies(&self, source: &str) -> HashSet<String> {
        let mut deps = HashSet::new();

        for line in source.lines() {
            let line = line.trim();

            // #include directives
            if line.starts_with("#include") {
                if let Some(start) = line.find('"').or_else(|| line.find('<')) {
                    let end_char = if line.contains('"') { '"' } else { '>' };
                    if let Some(end) = line[start + 1..].find(end_char) {
                        let include = &line[start + 1..start + 1 + end];
                        deps.insert(include.to_string());
                    }
                }
            }
        }

        deps
    }

    fn check_global_mutation(&self, source: &str, global: &str) -> bool {
        // Check if global is modified outside of lifecycle hooks
        // This is a heuristic - check for assignments to the global
        let assignment_pattern = format!("{} =", global);
        let increment_pattern = format!("{}++", global);
        let decrement_pattern = format!("{}--", global);

        let mut in_lifecycle = false;
        let lifecycle_names = [
            "on_load",
            "on_update",
            "on_unload",
            "on_event",
            "core_on_load",
            "core_on_update",
            "gui_on_load",
            "gui_on_render",
        ];

        for line in source.lines() {
            let line = line.trim();

            // Check if entering a lifecycle function
            for name in lifecycle_names {
                if line.contains(&format!("{} (", name)) || line.contains(&format!("{}(", name)) {
                    in_lifecycle = true;
                    break;
                }
            }

            // Check for closing brace at function level (simplified)
            if line == "}" {
                in_lifecycle = false;
            }

            // Check for mutations outside lifecycle
            if !in_lifecycle {
                if line.contains(&assignment_pattern)
                    || line.contains(&increment_pattern)
                    || line.contains(&decrement_pattern)
                {
                    return true;
                }
            }
        }

        false
    }
}

/// HMR status event for boundary violations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryViolationEvent {
    pub module: String,
    pub violations: Vec<BoundaryViolation>,
    pub action: RefreshAction,
    pub summary: String,
    pub can_proceed: bool,
}

impl BoundaryViolationEvent {
    pub fn from_check(module: &str, result: &BoundaryCheckResult) -> Self {
        Self {
            module: module.to_string(),
            violations: result.violations.clone(),
            action: result.action.clone(),
            summary: result.summary.clone(),
            can_proceed: result.can_hmr,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_boundary_checker_no_previous() {
        let mut checker = BoundaryChecker::new();
        let source = r#"
            extern "C" void* core_on_load(void* prev, void* ctx) {
                return prev;
            }
            extern "C" void core_on_update(void* state, double dt) {
            }
        "#;

        let result = checker.check_boundaries("core", source);
        assert!(result.can_hmr);
        assert_eq!(result.action, RefreshAction::HotReload);
    }

    #[test]
    fn test_state_layout_change() {
        let mut checker = BoundaryChecker::new();

        let old_source = r#"
            struct CoreState {
                uint32_t magic;
                int x;
                int y;
            };
            extern "C" void* core_on_load(void* prev, void* ctx) { return prev; }
        "#;

        let new_source = r#"
            struct CoreState {
                uint32_t magic;
                int x;
                int y;
                int z;  // New field!
            };
            extern "C" void* core_on_load(void* prev, void* ctx) { return prev; }
        "#;

        // First check establishes baseline
        let _ = checker.check_boundaries("core", old_source);

        // Second check should detect the change
        let result = checker.check_boundaries("core", new_source);
        assert!(!result.can_hmr);
        assert!(result
            .violations
            .iter()
            .any(|v| matches!(v, BoundaryViolation::StateLayoutChanged { .. })));
    }

    #[test]
    fn test_signature_change() {
        let mut checker = BoundaryChecker::new();

        let old_source = r#"
            extern "C" void core_on_update(void* state, double dt) {
            }
        "#;

        let new_source = r#"
            extern "C" void core_on_update(void* state, double dt, int extra_param) {
            }
        "#;

        let _ = checker.check_boundaries("core", old_source);
        let result = checker.check_boundaries("core", new_source);

        assert!(result
            .violations
            .iter()
            .any(|v| matches!(v, BoundaryViolation::SignatureChanged { .. })));
    }
}
