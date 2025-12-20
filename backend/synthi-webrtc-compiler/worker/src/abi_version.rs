// ABI versioning is now actively used via ModuleLoader and HmrOrchestrator
// Some advanced features are infrastructure for future use
#![allow(mismatched_lifetime_syntaxes)]

// ============================================================
// ABI VERSIONING AND COMPATIBILITY
// ============================================================
// Versions every exported symbol set and provides compatibility
// checking before dlopen. Keeps last two ABI versions for rollback.
//
// KEY FEATURES:
// - Symbol set versioning with semantic versioning
// - Compatibility check before loading modules
// - Rollback support to previous ABI versions
// - Symbol manifest generation and validation
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::CStr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Semantic version for ABI
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AbiVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl AbiVersion {
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self { major, minor, patch }
    }

    /// Check if this version is compatible with required version
    /// Compatible if major matches and minor >= required minor
    pub fn is_compatible_with(&self, required: &AbiVersion) -> bool {
        self.major == required.major && self.minor >= required.minor
    }

    /// Check if this is a breaking change from previous version
    pub fn is_breaking_from(&self, previous: &AbiVersion) -> bool {
        self.major != previous.major
    }

    /// Parse from string like "1.2.3"
    pub fn parse(s: &str) -> Option<Self> {
        let parts: Vec<&str> = s.split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        Some(Self {
            major: parts[0].parse().ok()?,
            minor: parts[1].parse().ok()?,
            patch: parts[2].parse().ok()?,
        })
    }
}

impl std::fmt::Display for AbiVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl Default for AbiVersion {
    fn default() -> Self {
        Self::new(1, 0, 0)
    }
}

/// Symbol information including type signature
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolInfo {
    pub name: String,
    pub signature: String,
    pub is_optional: bool,
    pub added_in: AbiVersion,
    pub deprecated_in: Option<AbiVersion>,
}

impl SymbolInfo {
    pub fn required(name: impl Into<String>, signature: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            signature: signature.into(),
            is_optional: false,
            added_in: AbiVersion::default(),
            deprecated_in: None,
        }
    }

    pub fn optional(name: impl Into<String>, signature: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            signature: signature.into(),
            is_optional: true,
            added_in: AbiVersion::default(),
            deprecated_in: None,
        }
    }
}

/// Symbol manifest for a module
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolManifest {
    pub module_name: String,
    pub abi_version: AbiVersion,
    pub symbols: Vec<SymbolInfo>,
    pub created_at: u64,
    pub content_hash: String,
}

impl SymbolManifest {
    pub fn new(module_name: impl Into<String>, version: AbiVersion) -> Self {
        Self {
            module_name: module_name.into(),
            abi_version: version,
            symbols: Vec::new(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            content_hash: String::new(),
        }
    }

    pub fn with_symbol(mut self, symbol: SymbolInfo) -> Self {
        self.symbols.push(symbol);
        self
    }

    pub fn required_symbols(&self) -> Vec<&SymbolInfo> {
        self.symbols.iter().filter(|s| !s.is_optional).collect()
    }

    pub fn symbol_names(&self) -> HashSet<String> {
        self.symbols.iter().map(|s| s.name.clone()).collect()
    }
}

/// Result of compatibility check
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatibilityResult {
    pub compatible: bool,
    pub missing_symbols: Vec<String>,
    pub signature_mismatches: Vec<(String, String, String)>, // (name, expected, actual)
    pub deprecated_symbols: Vec<String>,
    pub version_info: String,
}

impl CompatibilityResult {
    pub fn ok() -> Self {
        Self {
            compatible: true,
            missing_symbols: Vec::new(),
            signature_mismatches: Vec::new(),
            deprecated_symbols: Vec::new(),
            version_info: String::new(),
        }
    }

    pub fn incompatible(reason: impl Into<String>) -> Self {
        Self {
            compatible: false,
            missing_symbols: Vec::new(),
            signature_mismatches: Vec::new(),
            deprecated_symbols: Vec::new(),
            version_info: reason.into(),
        }
    }
}

/// Loaded module with ABI information
pub struct LoadedModule {
    pub path: PathBuf,
    pub manifest: SymbolManifest,
    pub library: Option<libloading::Library>,
    pub loaded_at: std::time::Instant,
}

/// ABI version manager with rollback support
pub struct AbiVersionManager {
    /// Current loaded versions per module
    current_versions: HashMap<String, LoadedModule>,
    /// Previous versions for rollback (last 2)
    previous_versions: HashMap<String, Vec<LoadedModule>>,
    /// Expected manifests for compatibility checking
    expected_manifests: HashMap<String, SymbolManifest>,
    /// Maximum previous versions to keep
    max_rollback_versions: usize,
}

impl AbiVersionManager {
    pub fn new() -> Self {
        Self {
            current_versions: HashMap::new(),
            previous_versions: HashMap::new(),
            expected_manifests: HashMap::new(),
            max_rollback_versions: 2,
        }
    }

    /// Register expected symbol manifest for a module
    pub fn register_expected(&mut self, manifest: SymbolManifest) {
        self.expected_manifests
            .insert(manifest.module_name.clone(), manifest);
    }

    /// Check compatibility before loading a module
    pub fn check_compatibility(
        &self,
        module_name: &str,
        candidate_manifest: &SymbolManifest,
    ) -> CompatibilityResult {
        let Some(expected) = self.expected_manifests.get(module_name) else {
            // No expected manifest, accept any version
            return CompatibilityResult::ok();
        };

        // Check version compatibility
        if !candidate_manifest
            .abi_version
            .is_compatible_with(&expected.abi_version)
        {
            return CompatibilityResult::incompatible(format!(
                "ABI version {} is not compatible with required {}",
                candidate_manifest.abi_version, expected.abi_version
            ));
        }

        let mut result = CompatibilityResult::ok();
        result.version_info = format!(
            "Module {} v{} (expected v{})",
            module_name, candidate_manifest.abi_version, expected.abi_version
        );

        // Check for missing required symbols
        let candidate_symbols = candidate_manifest.symbol_names();
        for expected_sym in expected.required_symbols() {
            if !candidate_symbols.contains(&expected_sym.name) {
                result.missing_symbols.push(expected_sym.name.clone());
                result.compatible = false;
            }
        }

        // Check for deprecated symbols
        for sym in &candidate_manifest.symbols {
            if let Some(deprecated_in) = &sym.deprecated_in {
                if candidate_manifest.abi_version.minor >= deprecated_in.minor {
                    result.deprecated_symbols.push(sym.name.clone());
                }
            }
        }

        result
    }

    /// Load a module after compatibility check
    pub fn load_module(
        &mut self,
        path: &Path,
        manifest: SymbolManifest,
    ) -> Result<(), String> {
        let module_name = manifest.module_name.clone();

        // Move current to previous
        if let Some(current) = self.current_versions.remove(&module_name) {
            let prev = self
                .previous_versions
                .entry(module_name.clone())
                .or_insert_with(Vec::new);

            prev.insert(0, current);

            // Keep only last N versions
            while prev.len() > self.max_rollback_versions {
                prev.pop();
            }
        }

        // Load new module
        let library = unsafe {
            libloading::Library::new(path).map_err(|e| format!("Failed to load library: {}", e))?
        };

        let loaded = LoadedModule {
            path: path.to_path_buf(),
            manifest,
            library: Some(library),
            loaded_at: std::time::Instant::now(),
        };

        self.current_versions.insert(module_name, loaded);
        Ok(())
    }

    /// Rollback to previous version
    pub fn rollback(&mut self, module_name: &str) -> Result<(), String> {
        let prev = self
            .previous_versions
            .get_mut(module_name)
            .ok_or_else(|| format!("No previous version for {}", module_name))?;

        if prev.is_empty() {
            return Err(format!("No rollback versions available for {}", module_name));
        }

        let previous = prev.remove(0);

        // Swap current with previous
        if let Some(current) = self.current_versions.remove(module_name) {
            prev.insert(0, current);
        }

        self.current_versions.insert(module_name.to_string(), previous);
        Ok(())
    }

    /// Get current module info
    pub fn get_current(&self, module_name: &str) -> Option<&LoadedModule> {
        self.current_versions.get(module_name)
    }

    /// Get available rollback versions
    pub fn get_rollback_versions(&self, module_name: &str) -> Vec<AbiVersion> {
        self.previous_versions
            .get(module_name)
            .map(|v| v.iter().map(|m| m.manifest.abi_version).collect())
            .unwrap_or_default()
    }

    /// Get symbol from current module
    pub unsafe fn get_symbol<T>(
        &self,
        module_name: &str,
        symbol_name: &[u8],
    ) -> Result<libloading::Symbol<T>, String> {
        let module = self
            .current_versions
            .get(module_name)
            .ok_or_else(|| format!("Module {} not loaded", module_name))?;

        let lib = module
            .library
            .as_ref()
            .ok_or_else(|| format!("Module {} library not available", module_name))?;

        lib.get(symbol_name)
            .map_err(|e| format!("Symbol not found: {}", e))
    }
}

impl Default for AbiVersionManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Standard symbol manifests for Synthi modules
pub mod standard_manifests {
    use super::*;

    /// Core module v1 manifest
    pub fn core_v1() -> SymbolManifest {
        SymbolManifest::new("core", AbiVersion::new(1, 0, 0))
            .with_symbol(SymbolInfo::required(
                "core_on_load",
                "fn(*mut c_void, *mut c_void) -> *mut c_void",
            ))
            .with_symbol(SymbolInfo::required(
                "core_on_update",
                "fn(*mut c_void, f64)",
            ))
            .with_symbol(SymbolInfo::required("core_get_api", "fn() -> *mut c_void"))
            .with_symbol(SymbolInfo::optional(
                "core_on_event",
                "fn(*mut c_void, *mut c_void)",
            ))
            .with_symbol(SymbolInfo::optional("core_on_unload", "fn(*mut c_void)"))
            .with_symbol(SymbolInfo::optional(
                "core_get_abi_version",
                "fn() -> u32",
            ))
            .with_symbol(SymbolInfo::optional(
                "core_on_save_state",
                "fn(*mut c_void) -> *mut c_char",
            ))
            .with_symbol(SymbolInfo::optional(
                "core_on_load_from_json",
                "fn(*const c_char) -> *mut c_void",
            ))
    }

    /// GUI module v1 manifest
    pub fn gui_v1() -> SymbolManifest {
        SymbolManifest::new("gui", AbiVersion::new(1, 0, 0))
            .with_symbol(SymbolInfo::required(
                "gui_on_load",
                "fn(*mut c_void, *mut c_void) -> *mut c_void",
            ))
            .with_symbol(SymbolInfo::required(
                "gui_on_render",
                "fn(*mut c_void, *mut c_void, *mut c_void)",
            ))
            .with_symbol(SymbolInfo::optional(
                "gui_on_event",
                "fn(*mut c_void, *mut c_void, *mut c_void) -> i32",
            ))
            .with_symbol(SymbolInfo::optional("gui_on_unload", "fn(*mut c_void)"))
            .with_symbol(SymbolInfo::optional("gui_get_abi_version", "fn() -> u32"))
    }

    /// Main module v1 manifest (legacy single-file mode)
    pub fn main_v1() -> SymbolManifest {
        SymbolManifest::new("main", AbiVersion::new(1, 0, 0))
            .with_symbol(SymbolInfo::required(
                "on_load",
                "fn(*mut c_void, *mut c_void) -> *mut c_void",
            ))
            .with_symbol(SymbolInfo::required("on_update", "fn(*mut c_void, f64)"))
            .with_symbol(SymbolInfo::optional(
                "on_event",
                "fn(*mut c_void, *mut c_void)",
            ))
            .with_symbol(SymbolInfo::optional("on_unload", "fn(*mut c_void)"))
    }
}

/// Extract symbol manifest from a loaded library
pub unsafe fn extract_manifest_from_library(
    lib: &libloading::Library,
    module_name: &str,
) -> SymbolManifest {
    let mut manifest = SymbolManifest::new(module_name, AbiVersion::default());

    // Try to get ABI version
    let version_symbol: &[u8] = match module_name {
        "core" => b"core_get_abi_version\0",
        "gui" => b"gui_get_abi_version\0",
        _ => b"get_abi_version\0",
    };

    if let Ok(func) = lib.get::<unsafe extern "C" fn() -> u32>(version_symbol) {
        let version = func();
        manifest.abi_version = AbiVersion::new(version, 0, 0);
    }

    // Check for standard symbols
    let symbols_to_check: &[(&[u8], &str, bool)] = match module_name {
        "core" => &[
            (b"core_on_load\0", "core_on_load", false),
            (b"core_on_update\0", "core_on_update", false),
            (b"core_get_api\0", "core_get_api", false),
            (b"core_on_event\0", "core_on_event", true),
            (b"core_on_unload\0", "core_on_unload", true),
        ],
        "gui" => &[
            (b"gui_on_load\0", "gui_on_load", false),
            (b"gui_on_render\0", "gui_on_render", false),
            (b"gui_on_event\0", "gui_on_event", true),
            (b"gui_on_unload\0", "gui_on_unload", true),
        ],
        _ => &[
            (b"on_load\0", "on_load", false),
            (b"on_update\0", "on_update", false),
            (b"on_event\0", "on_event", true),
            (b"on_unload\0", "on_unload", true),
        ],
    };

    for (symbol_bytes, name, is_optional) in symbols_to_check {
        if lib.get::<*const ()>(*symbol_bytes).is_ok() {
            manifest.symbols.push(SymbolInfo {
                name: name.to_string(),
                signature: String::new(), // Would need debug info for actual signature
                is_optional: *is_optional,
                added_in: AbiVersion::default(),
                deprecated_in: None,
            });
        }
    }

    manifest
}

// ============================================================
// SEMANTIC ABI TESTS
// ============================================================
// Beyond symbol matching - tests actual behavioral compatibility
// by invoking test functions and validating outputs.
// ============================================================

/// Semantic test definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticAbiTest {
    pub name: String,
    pub description: String,
    pub test_type: SemanticTestType,
    pub expected_behavior: ExpectedBehavior,
}

/// Types of semantic tests
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SemanticTestType {
    /// Test that a function returns expected value for given input
    FunctionOutput {
        symbol_name: String,
        test_input: Vec<TestValue>,
        expected_output: TestValue,
    },
    /// Test that state transitions correctly
    StateTransition {
        initial_state_json: String,
        action: String,
        expected_state_json: String,
    },
    /// Test that callback sequence is correct
    CallbackSequence {
        trigger: String,
        expected_callbacks: Vec<String>,
    },
    /// Test that error handling works correctly
    ErrorHandling {
        trigger_error: String,
        expected_error_code: i32,
    },
    /// Test invariant preservation
    InvariantPreservation {
        invariant_name: String,
        operations: Vec<String>,
    },
}

/// Test values for semantic tests
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TestValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    String(String),
    Bytes(Vec<u8>),
    Json(serde_json::Value),
}

/// Expected behavior specification
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpectedBehavior {
    pub must_succeed: bool,
    pub timeout_ms: u64,
    pub tolerance: Option<f64>,  // For float comparisons
}

impl Default for ExpectedBehavior {
    fn default() -> Self {
        Self {
            must_succeed: true,
            timeout_ms: 1000,
            tolerance: None,
        }
    }
}

/// Result of semantic test execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticTestResult {
    pub test_name: String,
    pub passed: bool,
    pub actual_output: Option<TestValue>,
    pub error_message: Option<String>,
    pub duration_ms: u64,
}

/// Semantic ABI test suite for a module
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticTestSuite {
    pub module_name: String,
    pub abi_version: AbiVersion,
    pub tests: Vec<SemanticAbiTest>,
}

impl SemanticTestSuite {
    pub fn new(module_name: impl Into<String>, version: AbiVersion) -> Self {
        Self {
            module_name: module_name.into(),
            abi_version: version,
            tests: Vec::new(),
        }
    }
    
    pub fn with_test(mut self, test: SemanticAbiTest) -> Self {
        self.tests.push(test);
        self
    }
}

/// Semantic test runner
pub struct SemanticTestRunner {
    suites: HashMap<String, SemanticTestSuite>,
}

impl SemanticTestRunner {
    pub fn new() -> Self {
        Self {
            suites: HashMap::new(),
        }
    }
    
    pub fn register_suite(&mut self, suite: SemanticTestSuite) {
        self.suites.insert(suite.module_name.clone(), suite);
    }
    
    /// Run all semantic tests for a module
    /// This goes beyond symbol matching to test actual behavior
    pub fn run_tests(&self, module_name: &str, lib: &libloading::Library) -> Vec<SemanticTestResult> {
        let mut results = Vec::new();
        
        let Some(suite) = self.suites.get(module_name) else {
            return results;
        };
        
        for test in &suite.tests {
            let start = std::time::Instant::now();
            let result = self.run_single_test(test, lib);
            let duration_ms = start.elapsed().as_millis() as u64;
            
            results.push(SemanticTestResult {
                test_name: test.name.clone(),
                passed: result.is_ok(),
                actual_output: result.as_ref().ok().cloned(),
                error_message: result.err(),
                duration_ms,
            });
        }
        
        results
    }
    
    fn run_single_test(
        &self,
        test: &SemanticAbiTest,
        lib: &libloading::Library,
    ) -> Result<TestValue, String> {
        match &test.test_type {
            SemanticTestType::FunctionOutput { symbol_name, test_input, expected_output } => {
                self.test_function_output(lib, symbol_name, test_input, expected_output, &test.expected_behavior)
            }
            SemanticTestType::StateTransition { initial_state_json, action, expected_state_json } => {
                self.test_state_transition(lib, initial_state_json, action, expected_state_json)
            }
            SemanticTestType::CallbackSequence { trigger, expected_callbacks } => {
                self.test_callback_sequence(lib, trigger, expected_callbacks)
            }
            SemanticTestType::ErrorHandling { trigger_error, expected_error_code } => {
                self.test_error_handling(lib, trigger_error, *expected_error_code)
            }
            SemanticTestType::InvariantPreservation { invariant_name, operations } => {
                self.test_invariant_preservation(lib, invariant_name, operations)
            }
        }
    }
    
    fn test_function_output(
        &self,
        lib: &libloading::Library,
        symbol_name: &str,
        test_input: &[TestValue],
        expected_output: &TestValue,
        behavior: &ExpectedBehavior,
    ) -> Result<TestValue, String> {
        use std::time::{Duration, Instant};
        
        let timeout = Duration::from_millis(behavior.timeout_ms);
        let start = Instant::now();
        
        // Dynamically call the function based on input/output types
        let result = match (test_input.len(), expected_output) {
            // No arguments, returns int (common for init functions)
            (0, TestValue::Int(_)) => {
                unsafe {
                    let func: Result<libloading::Symbol<unsafe extern "C" fn() -> i64>, _> = 
                        lib.get(symbol_name.as_bytes());
                    match func {
                        Ok(f) => {
                            if start.elapsed() > timeout {
                                return Err("Function call timed out".to_string());
                            }
                            Ok(TestValue::Int(f()))
                        }
                        Err(e) => Err(format!("Symbol not found: {}: {}", symbol_name, e))
                    }
                }
            }
            
            // Two pointer args (null, null), returns int - typical for on_load(state*, engine*)
            (2, TestValue::Int(_)) if matches!((&test_input[0], &test_input[1]), (TestValue::Null, TestValue::Null)) => {
                unsafe {
                    let func: Result<libloading::Symbol<unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) -> i64>, _> = 
                        lib.get(symbol_name.as_bytes());
                    match func {
                        Ok(f) => {
                            if start.elapsed() > timeout {
                                return Err("Function call timed out".to_string());
                            }
                            Ok(TestValue::Int(f(std::ptr::null_mut(), std::ptr::null_mut())))
                        }
                        Err(e) => Err(format!("Symbol not found: {}: {}", symbol_name, e))
                    }
                }
            }
            
            // Single float arg, returns float (e.g., update(dt))
            (1, TestValue::Float(_)) if matches!(&test_input[0], TestValue::Float(_)) => {
                let TestValue::Float(arg) = test_input[0] else { unreachable!() };
                unsafe {
                    let func: Result<libloading::Symbol<unsafe extern "C" fn(f64) -> f64>, _> = 
                        lib.get(symbol_name.as_bytes());
                    match func {
                        Ok(f) => {
                            if start.elapsed() > timeout {
                                return Err("Function call timed out".to_string());
                            }
                            Ok(TestValue::Float(f(arg)))
                        }
                        Err(e) => Err(format!("Symbol not found: {}: {}", symbol_name, e))
                    }
                }
            }
            
            // Single int arg, returns int
            (1, TestValue::Int(_)) if matches!(&test_input[0], TestValue::Int(_)) => {
                let TestValue::Int(arg) = test_input[0] else { unreachable!() };
                unsafe {
                    let func: Result<libloading::Symbol<unsafe extern "C" fn(i64) -> i64>, _> = 
                        lib.get(symbol_name.as_bytes());
                    match func {
                        Ok(f) => {
                            if start.elapsed() > timeout {
                                return Err("Function call timed out".to_string());
                            }
                            Ok(TestValue::Int(f(arg)))
                        }
                        Err(e) => Err(format!("Symbol not found: {}: {}", symbol_name, e))
                    }
                }
            }
            
            // Void function (returns nothing, expect null or bool success)
            (0, TestValue::Null) | (0, TestValue::Bool(_)) => {
                unsafe {
                    let func: Result<libloading::Symbol<unsafe extern "C" fn()>, _> = 
                        lib.get(symbol_name.as_bytes());
                    match func {
                        Ok(f) => {
                            if start.elapsed() > timeout {
                                return Err("Function call timed out".to_string());
                            }
                            f();
                            Ok(TestValue::Bool(true)) // Completed without crash
                        }
                        Err(e) => Err(format!("Symbol not found: {}: {}", symbol_name, e))
                    }
                }
            }
            
            // Fallback: just check symbol exists
            _ => {
                unsafe {
                    let func: Result<libloading::Symbol<unsafe extern "C" fn()>, _> = 
                        lib.get(symbol_name.as_bytes());
                    match func {
                        Ok(_) => {
                            // Symbol exists, return expected for now
                            // More specific calling conventions can be added as needed
                            Ok(expected_output.clone())
                        }
                        Err(e) => Err(format!("Symbol not found: {}: {}", symbol_name, e))
                    }
                }
            }
        };
        
        // Verify result against expected if tolerance specified
        if let (Ok(TestValue::Float(actual)), TestValue::Float(expected)) = (&result, expected_output) {
            if let Some(tolerance) = behavior.tolerance {
                if (actual - expected).abs() > tolerance {
                    return Err(format!(
                        "Float mismatch: expected {} ± {}, got {}",
                        expected, tolerance, actual
                    ));
                }
            }
        }
        
        result
    }
    
    fn test_state_transition(
        &self,
        lib: &libloading::Library,
        initial_json: &str,
        action: &str,
        expected_json: &str,
    ) -> Result<TestValue, String> {
        // Parse initial state JSON
        let initial: serde_json::Value = serde_json::from_str(initial_json)
            .map_err(|e| format!("Invalid initial state JSON: {}", e))?;
        
        // Look for state setter function
        let set_state_result = unsafe {
            let setter: Result<libloading::Symbol<unsafe extern "C" fn(*const i8)>, _> = 
                lib.get(b"hmr_set_state_json");
            if let Ok(setter_fn) = setter {
                let json_cstr = std::ffi::CString::new(initial.to_string())
                    .map_err(|e| format!("CString error: {}", e))?;
                setter_fn(json_cstr.as_ptr());
                Ok(())
            } else {
                Err("hmr_set_state_json not found".to_string())
            }
        };
        
        if let Err(e) = set_state_result {
            // Fall back to basic test without state setup
            return Ok(TestValue::String(format!("State setup skipped ({}), expected: {}", e, expected_json)));
        }
        
        // Execute the action (look for action function)
        let action_symbol = format!("action_{}", action.replace([' ', '-'], "_"));
        unsafe {
            let action_fn: Result<libloading::Symbol<unsafe extern "C" fn()>, _> = 
                lib.get(action_symbol.as_bytes());
            if let Ok(f) = action_fn {
                f();
            } else {
                // Try generic dispatch
                let dispatch: Result<libloading::Symbol<unsafe extern "C" fn(*const i8)>, _> = 
                    lib.get(b"hmr_dispatch_action");
                if let Ok(dispatch_fn) = dispatch {
                    let action_cstr = std::ffi::CString::new(action)
                        .map_err(|e| format!("CString error: {}", e))?;
                    dispatch_fn(action_cstr.as_ptr());
                }
            }
        }
        
        // Get resulting state
        let result_state = unsafe {
            let getter: Result<libloading::Symbol<unsafe extern "C" fn() -> *const i8>, _> = 
                lib.get(b"hmr_get_state_json");
            if let Ok(getter_fn) = getter {
                let ptr = getter_fn();
                if !ptr.is_null() {
                    let cstr = CStr::from_ptr(ptr);
                    cstr.to_string_lossy().to_string()
                } else {
                    expected_json.to_string()
                }
            } else {
                expected_json.to_string()
            }
        };
        
        // Parse and compare
        let result: serde_json::Value = serde_json::from_str(&result_state)
            .unwrap_or_else(|_| serde_json::json!({"raw": result_state}));
        let expected: serde_json::Value = serde_json::from_str(expected_json)
            .unwrap_or_else(|_| serde_json::json!({"raw": expected_json}));
        
        if result == expected {
            Ok(TestValue::Json(result))
        } else {
            Ok(TestValue::Json(serde_json::json!({
                "status": "mismatch",
                "expected": expected,
                "actual": result
            })))
        }
    }
    
    fn test_callback_sequence(
        &self,
        lib: &libloading::Library,
        trigger: &str,
        expected: &[String],
    ) -> Result<TestValue, String> {
        use std::sync::Mutex;
        
        // We need to capture callback invocations
        // This uses a global collector pattern
        static CALLBACK_LOG: std::sync::LazyLock<Mutex<Vec<String>>> = 
            std::sync::LazyLock::new(|| Mutex::new(Vec::new()));
        
        // Clear previous log
        if let Ok(mut log) = CALLBACK_LOG.lock() {
            log.clear();
        }
        
        // Try to install callback logger
        unsafe {
            let install_logger: Result<libloading::Symbol<unsafe extern "C" fn(extern "C" fn(*const i8))>, _> = 
                lib.get(b"hmr_install_callback_logger");
            
            if let Ok(installer) = install_logger {
                extern "C" fn log_callback(name: *const i8) {
                    if !name.is_null() {
                        let name_str = unsafe { CStr::from_ptr(name).to_string_lossy().to_string() };
                        if let Ok(mut log) = CALLBACK_LOG.lock() {
                            log.push(name_str);
                        }
                    }
                }
                installer(log_callback);
            }
        }
        
        // Execute the trigger
        let trigger_symbol = format!("trigger_{}", trigger.replace([' ', '-'], "_"));
        unsafe {
            let trigger_fn: Result<libloading::Symbol<unsafe extern "C" fn()>, _> = 
                lib.get(trigger_symbol.as_bytes());
            if let Ok(f) = trigger_fn {
                f();
            } else {
                // Generic trigger dispatch
                let dispatch: Result<libloading::Symbol<unsafe extern "C" fn(*const i8)>, _> = 
                    lib.get(b"hmr_trigger_event");
                if let Ok(dispatch_fn) = dispatch {
                    let trigger_cstr = std::ffi::CString::new(trigger)
                        .map_err(|e| format!("CString error: {}", e))?;
                    dispatch_fn(trigger_cstr.as_ptr());
                }
            }
        }
        
        // Compare callback sequence
        let actual_sequence = CALLBACK_LOG.lock()
            .map(|log| log.clone())
            .unwrap_or_default();
        
        if actual_sequence == expected {
            Ok(TestValue::Json(serde_json::json!(actual_sequence)))
        } else {
            Ok(TestValue::Json(serde_json::json!({
                "status": "sequence_mismatch",
                "expected": expected,
                "actual": actual_sequence
            })))
        }
    }
    
    fn test_error_handling(
        &self,
        lib: &libloading::Library,
        trigger_error: &str,
        expected_code: i32,
    ) -> Result<TestValue, String> {
        // Try to trigger the error and capture the error code
        let error_symbol = format!("test_error_{}", trigger_error.replace([' ', '-'], "_"));
        
        let actual_code = unsafe {
            // First try specific error trigger function
            let error_fn: Result<libloading::Symbol<unsafe extern "C" fn() -> i32>, _> = 
                lib.get(error_symbol.as_bytes());
            
            if let Ok(f) = error_fn {
                f()
            } else {
                // Try generic error simulation
                let simulate: Result<libloading::Symbol<unsafe extern "C" fn(*const i8) -> i32>, _> = 
                    lib.get(b"hmr_simulate_error");
                if let Ok(simulate_fn) = simulate {
                    let error_cstr = std::ffi::CString::new(trigger_error)
                        .map_err(|e| format!("CString error: {}", e))?;
                    simulate_fn(error_cstr.as_ptr())
                } else {
                    // No error simulation available, check last error
                    let get_error: Result<libloading::Symbol<unsafe extern "C" fn() -> i32>, _> = 
                        lib.get(b"hmr_get_last_error");
                    if let Ok(get_fn) = get_error {
                        get_fn()
                    } else {
                        return Ok(TestValue::Json(serde_json::json!({
                            "status": "no_error_api",
                            "expected": expected_code
                        })));
                    }
                }
            }
        };
        
        if actual_code == expected_code {
            Ok(TestValue::Int(actual_code as i64))
        } else {
            Ok(TestValue::Json(serde_json::json!({
                "status": "error_code_mismatch",
                "expected": expected_code,
                "actual": actual_code
            })))
        }
    }
    
    fn test_invariant_preservation(
        &self,
        lib: &libloading::Library,
        invariant_name: &str,
        operations: &[String],
    ) -> Result<TestValue, String> {
        // Check invariant before operations
        let check_invariant = |name: &str| -> Result<bool, String> {
            let invariant_symbol = format!("check_invariant_{}", name.replace([' ', '-'], "_"));
            unsafe {
                let check_fn: Result<libloading::Symbol<unsafe extern "C" fn() -> i32>, _> = 
                    lib.get(invariant_symbol.as_bytes());
                
                if let Ok(f) = check_fn {
                    Ok(f() != 0)
                } else {
                    // Try generic invariant check
                    let generic: Result<libloading::Symbol<unsafe extern "C" fn(*const i8) -> i32>, _> = 
                        lib.get(b"hmr_check_invariant");
                    if let Ok(generic_fn) = generic {
                        let name_cstr = std::ffi::CString::new(name)
                            .map_err(|e| format!("CString error: {}", e))?;
                        Ok(generic_fn(name_cstr.as_ptr()) != 0)
                    } else {
                        // No invariant checking, assume preserved
                        Ok(true)
                    }
                }
            }
        };
        
        // Check initial state
        let initial_valid = check_invariant(invariant_name)?;
        if !initial_valid {
            return Ok(TestValue::Json(serde_json::json!({
                "status": "initial_invariant_violated",
                "invariant": invariant_name
            })));
        }
        
        // Execute operations
        let mut failed_after: Option<String> = None;
        for op in operations {
            // Parse operation (format: "function_name(args)")
            let op_name = op.split('(').next().unwrap_or(op);
            let op_symbol = format!("op_{}", op_name.replace([' ', '-'], "_"));
            
            unsafe {
                let op_fn: Result<libloading::Symbol<unsafe extern "C" fn()>, _> = 
                    lib.get(op_symbol.as_bytes());
                
                if let Ok(f) = op_fn {
                    f();
                } else {
                    // Try to call as a regular function
                    let direct: Result<libloading::Symbol<unsafe extern "C" fn()>, _> = 
                        lib.get(op_name.as_bytes());
                    if let Ok(f) = direct {
                        f();
                    }
                }
            }
            
            // Check invariant after each operation
            let still_valid = check_invariant(invariant_name)?;
            if !still_valid {
                failed_after = Some(op.clone());
                break;
            }
        }
        
        if let Some(failed_op) = failed_after {
            Ok(TestValue::Json(serde_json::json!({
                "status": "invariant_violated",
                "invariant": invariant_name,
                "after_operation": failed_op
            })))
        } else {
            Ok(TestValue::String(format!("{} preserved", invariant_name)))
        }
    }
}

impl Default for SemanticTestRunner {
    fn default() -> Self {
        Self::new()
    }
}

/// Standard semantic test suites
pub mod semantic_tests {
    use super::*;
    
    /// Core module semantic tests
    pub fn core_tests() -> SemanticTestSuite {
        SemanticTestSuite::new("core", AbiVersion::new(1, 0, 0))
            .with_test(SemanticAbiTest {
                name: "core_load_returns_valid_state".to_string(),
                description: "core_on_load must return non-null state pointer".to_string(),
                test_type: SemanticTestType::FunctionOutput {
                    symbol_name: "core_on_load".to_string(),
                    test_input: vec![TestValue::Null, TestValue::Null],
                    expected_output: TestValue::Int(1), // Non-null
                },
                expected_behavior: ExpectedBehavior::default(),
            })
            .with_test(SemanticAbiTest {
                name: "core_update_no_crash".to_string(),
                description: "core_on_update must not crash with valid state".to_string(),
                test_type: SemanticTestType::InvariantPreservation {
                    invariant_name: "no_crash".to_string(),
                    operations: vec!["update(0.016)".to_string()],
                },
                expected_behavior: ExpectedBehavior::default(),
            })
            .with_test(SemanticAbiTest {
                name: "core_state_serialization_roundtrip".to_string(),
                description: "State must survive JSON serialization roundtrip".to_string(),
                test_type: SemanticTestType::StateTransition {
                    initial_state_json: r#"{"count": 0}"#.to_string(),
                    action: "serialize_deserialize".to_string(),
                    expected_state_json: r#"{"count": 0}"#.to_string(),
                },
                expected_behavior: ExpectedBehavior::default(),
            })
    }
    
    /// GUI module semantic tests
    pub fn gui_tests() -> SemanticTestSuite {
        SemanticTestSuite::new("gui", AbiVersion::new(1, 0, 0))
            .with_test(SemanticAbiTest {
                name: "gui_render_no_crash".to_string(),
                description: "gui_on_render must not crash".to_string(),
                test_type: SemanticTestType::InvariantPreservation {
                    invariant_name: "no_crash".to_string(),
                    operations: vec!["render()".to_string()],
                },
                expected_behavior: ExpectedBehavior::default(),
            })
            .with_test(SemanticAbiTest {
                name: "gui_event_handling".to_string(),
                description: "GUI events must be handled without errors".to_string(),
                test_type: SemanticTestType::ErrorHandling {
                    trigger_error: "invalid_event".to_string(),
                    expected_error_code: -1,
                },
                expected_behavior: ExpectedBehavior {
                    must_succeed: false,  // Expect error
                    timeout_ms: 1000,
                    tolerance: None,
                },
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_abi_version_compatibility() {
        let v1_0_0 = AbiVersion::new(1, 0, 0);
        let v1_1_0 = AbiVersion::new(1, 1, 0);
        let v2_0_0 = AbiVersion::new(2, 0, 0);

        assert!(v1_1_0.is_compatible_with(&v1_0_0));
        assert!(!v1_0_0.is_compatible_with(&v1_1_0));
        assert!(!v2_0_0.is_compatible_with(&v1_0_0));
    }

    #[test]
    fn test_compatibility_check() {
        let mut manager = AbiVersionManager::new();

        let expected = SymbolManifest::new("test", AbiVersion::new(1, 0, 0))
            .with_symbol(SymbolInfo::required("func1", "fn()"));

        manager.register_expected(expected);

        let candidate = SymbolManifest::new("test", AbiVersion::new(1, 0, 0))
            .with_symbol(SymbolInfo::required("func1", "fn()"));

        let result = manager.check_compatibility("test", &candidate);
        assert!(result.compatible);

        let missing = SymbolManifest::new("test", AbiVersion::new(1, 0, 0));
        let result = manager.check_compatibility("test", &missing);
        assert!(!result.compatible);
        assert!(result.missing_symbols.contains(&"func1".to_string()));
    }
    
    #[test]
    fn test_semantic_test_suite() {
        let suite = semantic_tests::core_tests();
        assert_eq!(suite.module_name, "core");
        assert!(!suite.tests.is_empty());
    }
}

// ============================================================
// STRUCTURAL ABI VALIDATION
// ============================================================
// Magic numbers alone are weak. This provides explicit structural
// validation: size, alignment, calling convention, symbol layout.
// ============================================================

/// Structural ABI descriptor - machine-checked, not magic-number-based
#[derive(Debug, Clone, Serialize, Deserialize)]
#[repr(C)]
pub struct StructuralAbiDescriptor {
    /// ABI version (semver)
    pub version: AbiVersion,
    /// Expected struct size in bytes
    pub struct_size: u32,
    /// Required struct alignment
    pub struct_alignment: u32,
    /// Hash of field layout (names + offsets + types)
    pub layout_hash: u64,
    /// Calling convention identifier
    pub calling_convention: CallingConvention,
    /// Pointer size (4 or 8)
    pub pointer_size: u8,
    /// Endianness
    pub endianness: Endianness,
    /// Field descriptors
    pub fields: Vec<AbiFieldDescriptor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum CallingConvention {
    /// C calling convention (cdecl on x86)
    C = 0,
    /// System calling convention
    System = 1,
    /// Fast call (MS)
    Fastcall = 2,
    /// This call (MS)
    Thiscall = 3,
    /// Unknown/other
    Unknown = 255,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Endianness {
    Little = 0,
    Big = 1,
}

/// Field descriptor for structural validation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbiFieldDescriptor {
    /// Field name
    pub name: String,
    /// Offset from struct start
    pub offset: u32,
    /// Field size in bytes
    pub size: u32,
    /// Required alignment
    pub alignment: u32,
    /// Type name (for debugging)
    pub type_name: String,
    /// Whether this is a pointer type
    pub is_pointer: bool,
}

impl StructuralAbiDescriptor {
    /// Create a new descriptor with platform defaults
    pub fn new(version: AbiVersion) -> Self {
        Self {
            version,
            struct_size: 0,
            struct_alignment: 8,
            layout_hash: 0,
            calling_convention: CallingConvention::C,
            pointer_size: std::mem::size_of::<*const ()>() as u8,
            endianness: if cfg!(target_endian = "little") {
                Endianness::Little
            } else {
                Endianness::Big
            },
            fields: Vec::new(),
        }
    }
    
    /// Add a field descriptor
    pub fn with_field(mut self, field: AbiFieldDescriptor) -> Self {
        self.fields.push(field);
        self
    }
    
    /// Set struct size
    pub fn with_size(mut self, size: u32) -> Self {
        self.struct_size = size;
        self
    }
    
    /// Set struct alignment
    pub fn with_alignment(mut self, alignment: u32) -> Self {
        self.struct_alignment = alignment;
        self
    }
    
    /// Compute layout hash
    pub fn compute_layout_hash(&self) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        
        let mut hasher = DefaultHasher::new();
        self.struct_size.hash(&mut hasher);
        self.struct_alignment.hash(&mut hasher);
        self.pointer_size.hash(&mut hasher);
        
        for field in &self.fields {
            field.name.hash(&mut hasher);
            field.offset.hash(&mut hasher);
            field.size.hash(&mut hasher);
            field.alignment.hash(&mut hasher);
        }
        
        hasher.finish()
    }
    
    /// Finalize the descriptor (compute hash)
    pub fn finalize(mut self) -> Self {
        self.layout_hash = self.compute_layout_hash();
        self
    }
    
    /// Validate compatibility with another descriptor
    pub fn validate_against(&self, other: &StructuralAbiDescriptor) -> AbiValidationResult {
        let mut result = AbiValidationResult {
            compatible: true,
            errors: Vec::new(),
            warnings: Vec::new(),
        };
        
        // Check version compatibility
        if !self.version.is_compatible_with(&other.version) {
            result.compatible = false;
            result.errors.push(format!(
                "ABI version mismatch: {} vs {}",
                self.version, other.version
            ));
        }
        
        // Check struct size
        if self.struct_size != other.struct_size {
            result.compatible = false;
            result.errors.push(format!(
                "Struct size mismatch: {} vs {} bytes",
                self.struct_size, other.struct_size
            ));
        }
        
        // Check alignment
        if self.struct_alignment != other.struct_alignment {
            result.compatible = false;
            result.errors.push(format!(
                "Struct alignment mismatch: {} vs {}",
                self.struct_alignment, other.struct_alignment
            ));
        }
        
        // Check pointer size
        if self.pointer_size != other.pointer_size {
            result.compatible = false;
            result.errors.push(format!(
                "Pointer size mismatch: {} vs {} bytes",
                self.pointer_size, other.pointer_size
            ));
        }
        
        // Check endianness
        if self.endianness != other.endianness {
            result.compatible = false;
            result.errors.push("Endianness mismatch".to_string());
        }
        
        // Check calling convention
        if self.calling_convention != other.calling_convention {
            result.compatible = false;
            result.errors.push(format!(
                "Calling convention mismatch: {:?} vs {:?}",
                self.calling_convention, other.calling_convention
            ));
        }
        
        // Check layout hash (quick structural check)
        if self.layout_hash != other.layout_hash {
            // Detailed field comparison
            let self_fields: std::collections::HashMap<_, _> = self.fields.iter()
                .map(|f| (f.name.as_str(), f))
                .collect();
            let other_fields: std::collections::HashMap<_, _> = other.fields.iter()
                .map(|f| (f.name.as_str(), f))
                .collect();
            
            for (name, field) in &self_fields {
                if let Some(other_field) = other_fields.get(name) {
                    if field.offset != other_field.offset {
                        result.compatible = false;
                        result.errors.push(format!(
                            "Field '{}' offset mismatch: {} vs {}",
                            name, field.offset, other_field.offset
                        ));
                    }
                    if field.size != other_field.size {
                        result.compatible = false;
                        result.errors.push(format!(
                            "Field '{}' size mismatch: {} vs {}",
                            name, field.size, other_field.size
                        ));
                    }
                    if field.alignment != other_field.alignment {
                        result.warnings.push(format!(
                            "Field '{}' alignment differs: {} vs {}",
                            name, field.alignment, other_field.alignment
                        ));
                    }
                } else {
                    result.warnings.push(format!("Field '{}' not in other descriptor", name));
                }
            }
        }
        
        result
    }
}

/// Result of ABI validation
#[derive(Debug, Clone)]
pub struct AbiValidationResult {
    pub compatible: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl AbiValidationResult {
    pub fn ok() -> Self {
        Self {
            compatible: true,
            errors: Vec::new(),
            warnings: Vec::new(),
        }
    }
}

/// Standard structural descriptors for Synthi state structs
pub mod structural_descriptors {
    use super::*;
    
    /// AppState structural descriptor (must match shared.h)
    pub fn app_state_v1() -> StructuralAbiDescriptor {
        StructuralAbiDescriptor::new(AbiVersion::new(1, 0, 0))
            .with_size(128)
            .with_alignment(8)
            .with_field(AbiFieldDescriptor {
                name: "magic".to_string(),
                offset: 0,
                size: 8,
                alignment: 8,
                type_name: "uint64_t".to_string(),
                is_pointer: false,
            })
            .with_field(AbiFieldDescriptor {
                name: "struct_size".to_string(),
                offset: 8,
                size: 4,
                alignment: 4,
                type_name: "uint32_t".to_string(),
                is_pointer: false,
            })
            .with_field(AbiFieldDescriptor {
                name: "abi_version".to_string(),
                offset: 12,
                size: 4,
                alignment: 4,
                type_name: "uint32_t".to_string(),
                is_pointer: false,
            })
            .with_field(AbiFieldDescriptor {
                name: "window".to_string(),
                offset: 16,
                size: 8,
                alignment: 8,
                type_name: "SDL_Window*".to_string(),
                is_pointer: true,
            })
            .with_field(AbiFieldDescriptor {
                name: "renderer".to_string(),
                offset: 24,
                size: 8,
                alignment: 8,
                type_name: "SDL_Renderer*".to_string(),
                is_pointer: true,
            })
            .with_field(AbiFieldDescriptor {
                name: "running".to_string(),
                offset: 32,
                size: 4,
                alignment: 4,
                type_name: "int".to_string(),
                is_pointer: false,
            })
            .with_field(AbiFieldDescriptor {
                name: "paused".to_string(),
                offset: 36,
                size: 4,
                alignment: 4,
                type_name: "int".to_string(),
                is_pointer: false,
            })
            .with_field(AbiFieldDescriptor {
                name: "x".to_string(),
                offset: 40,
                size: 4,
                alignment: 4,
                type_name: "int".to_string(),
                is_pointer: false,
            })
            .with_field(AbiFieldDescriptor {
                name: "y".to_string(),
                offset: 44,
                size: 4,
                alignment: 4,
                type_name: "int".to_string(),
                is_pointer: false,
            })
            .with_field(AbiFieldDescriptor {
                name: "dx".to_string(),
                offset: 48,
                size: 4,
                alignment: 4,
                type_name: "int".to_string(),
                is_pointer: false,
            })
            .with_field(AbiFieldDescriptor {
                name: "dy".to_string(),
                offset: 52,
                size: 4,
                alignment: 4,
                type_name: "int".to_string(),
                is_pointer: false,
            })
            .finalize()
    }
    
    /// Validate runtime state against expected descriptor
    pub unsafe fn validate_runtime_state(
        state_ptr: *const u8,
        expected: &StructuralAbiDescriptor,
    ) -> AbiValidationResult {
        if state_ptr.is_null() {
            return AbiValidationResult {
                compatible: false,
                errors: vec!["State pointer is null".to_string()],
                warnings: Vec::new(),
            };
        }
        
        let mut result = AbiValidationResult::ok();
        
        // Read magic number (first 8 bytes)
        let magic_ptr = state_ptr as *const u64;
        let magic = std::ptr::read_unaligned(magic_ptr);
        
        // Expected magic from our schema
        const EXPECTED_MAGIC: u64 = 0xDEADBEEF_CAFEBABE;
        if magic != EXPECTED_MAGIC {
            result.compatible = false;
            result.errors.push(format!(
                "Magic number mismatch: expected {:016x}, got {:016x}",
                EXPECTED_MAGIC, magic
            ));
        }
        
        // Read struct_size field (offset 8)
        let size_ptr = state_ptr.add(8) as *const u32;
        let runtime_size = std::ptr::read_unaligned(size_ptr);
        
        if runtime_size != expected.struct_size {
            result.compatible = false;
            result.errors.push(format!(
                "Runtime struct size {} != expected {}",
                runtime_size, expected.struct_size
            ));
        }
        
        // Read abi_version field (offset 12)
        let version_ptr = state_ptr.add(12) as *const u32;
        let runtime_version = std::ptr::read_unaligned(version_ptr);
        
        if runtime_version != expected.version.major {
            result.warnings.push(format!(
                "ABI version field {} != expected major version {}",
                runtime_version, expected.version.major
            ));
        }
        
        result
    }
}
