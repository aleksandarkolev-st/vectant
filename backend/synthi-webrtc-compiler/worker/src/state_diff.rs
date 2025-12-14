// ============================================================
// FIELD-LEVEL STATE DIFFING MODULE
// ============================================================
// Provides intelligent state migration that preserves unchanged
// fields during HMR, similar to Next.js Fast Refresh preserving
// React hooks state.
//
// KEY FEATURES:
// - JSON-based field diffing (works with any serializable state)
// - Selective field preservation (keep unchanged, update changed)
// - Type-safe field migration with fallbacks
// - Supports nested objects and arrays
// ============================================================

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;

/// Result of state diffing operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffResult {
    /// Fields that were preserved from old state
    pub preserved_fields: Vec<String>,
    /// Fields that were updated/reset
    pub reset_fields: Vec<String>,
    /// Fields that are new in the new state
    pub new_fields: Vec<String>,
    /// Fields that were removed
    pub removed_fields: Vec<String>,
    /// The merged state JSON
    pub merged_state: Value,
}

/// Configuration for state diffing
#[derive(Debug, Clone, Default)]
pub struct DiffConfig {
    /// Fields that should always be reset (never preserved)
    /// Use dot notation for nested fields: "gui.animation_frame"
    pub always_reset: HashSet<String>,
    
    /// Fields that should always be preserved if present
    pub always_preserve: HashSet<String>,
    
    /// Whether to preserve arrays by reference (vs deep merge)
    pub preserve_arrays: bool,
    
    /// Maximum depth for nested object diffing
    pub max_depth: usize,
}

impl DiffConfig {
    pub fn new() -> Self {
        Self {
            always_reset: HashSet::new(),
            always_preserve: HashSet::new(),
            preserve_arrays: true,
            max_depth: 10,
        }
    }
    
    /// Create config optimized for GUI state
    pub fn for_gui() -> Self {
        let mut config = Self::new();
        // GUI state that should reset on reload
        config.always_reset.insert("animation_frame".to_string());
        config.always_reset.insert("hover_state".to_string());
        config.always_reset.insert("transient_ui".to_string());
        config
    }
    
    /// Create config optimized for Core state
    pub fn for_core() -> Self {
        let mut config = Self::new();
        // Core state that should always be preserved
        config.always_preserve.insert("x".to_string());
        config.always_preserve.insert("y".to_string());
        config.always_preserve.insert("position".to_string());
        config.always_preserve.insert("velocity".to_string());
        config.always_preserve.insert("game_state".to_string());
        config.always_preserve.insert("user_data".to_string());
        config
    }
}

/// Diff two JSON states and merge them intelligently
/// 
/// Strategy:
/// 1. If a field exists in both and values are equal → preserve from old
/// 2. If a field exists in both but values differ:
///    - If in always_reset → use new value
///    - If in always_preserve → use old value
///    - Otherwise → use new value (code changed, state should update)
/// 3. If field only in old → preserve it (user data)
/// 4. If field only in new → use new value (new feature)
pub fn diff_and_merge(
    old_state: &Value,
    new_state_template: &Value,
    config: &DiffConfig,
) -> DiffResult {
    let mut preserved = Vec::new();
    let mut reset = Vec::new();
    let mut new_fields = Vec::new();
    let mut removed = Vec::new();
    
    let merged = diff_value(
        old_state,
        new_state_template,
        config,
        "",
        0,
        &mut preserved,
        &mut reset,
        &mut new_fields,
        &mut removed,
    );
    
    DiffResult {
        preserved_fields: preserved,
        reset_fields: reset,
        new_fields,
        removed_fields: removed,
        merged_state: merged,
    }
}

fn diff_value(
    old: &Value,
    new: &Value,
    config: &DiffConfig,
    path: &str,
    depth: usize,
    preserved: &mut Vec<String>,
    reset: &mut Vec<String>,
    new_fields: &mut Vec<String>,
    removed: &mut Vec<String>,
) -> Value {
    if depth > config.max_depth {
        // Too deep, just use new value
        return new.clone();
    }
    
    match (old, new) {
        // Both are objects - merge recursively
        (Value::Object(old_map), Value::Object(new_map)) => {
            let merged = diff_objects(
                old_map, new_map, config, path, depth,
                preserved, reset, new_fields, removed
            );
            Value::Object(merged)
        }
        
        // Both are arrays
        (Value::Array(old_arr), Value::Array(new_arr)) => {
            if config.preserve_arrays && !config.always_reset.contains(path) {
                // Preserve old array contents
                preserved.push(path.to_string());
                Value::Array(old_arr.clone())
            } else {
                // Use new array
                reset.push(path.to_string());
                Value::Array(new_arr.clone())
            }
        }
        
        // Same primitive type - compare values
        (old_val, new_val) if std::mem::discriminant(old_val) == std::mem::discriminant(new_val) => {
            if old_val == new_val {
                // Values are equal - preserve
                preserved.push(path.to_string());
                old_val.clone()
            } else if config.always_preserve.contains(path) {
                // Force preserve
                preserved.push(path.to_string());
                old_val.clone()
            } else if config.always_reset.contains(path) {
                // Force reset
                reset.push(path.to_string());
                new_val.clone()
            } else {
                // Default: use new value (code changed)
                reset.push(path.to_string());
                new_val.clone()
            }
        }
        
        // Different types - use new value
        (_, new_val) => {
            reset.push(path.to_string());
            new_val.clone()
        }
    }
}

fn diff_objects(
    old_map: &Map<String, Value>,
    new_map: &Map<String, Value>,
    config: &DiffConfig,
    parent_path: &str,
    depth: usize,
    preserved: &mut Vec<String>,
    reset: &mut Vec<String>,
    new_fields: &mut Vec<String>,
    removed: &mut Vec<String>,
) -> Map<String, Value> {
    let mut result = Map::new();
    let mut seen_keys = HashSet::new();
    
    // Process fields from new template
    for (key, new_val) in new_map {
        seen_keys.insert(key.clone());
        let field_path = if parent_path.is_empty() {
            key.clone()
        } else {
            format!("{}.{}", parent_path, key)
        };
        
        if let Some(old_val) = old_map.get(key) {
            // Field exists in both
            let merged_val = diff_value(
                old_val, new_val, config, &field_path, depth + 1,
                preserved, reset, new_fields, removed
            );
            result.insert(key.clone(), merged_val);
        } else {
            // New field
            new_fields.push(field_path);
            result.insert(key.clone(), new_val.clone());
        }
    }
    
    // Check for fields only in old (preserve user data)
    for (key, old_val) in old_map {
        if !seen_keys.contains(key) {
            let field_path = if parent_path.is_empty() {
                key.clone()
            } else {
                format!("{}.{}", parent_path, key)
            };
            
            // Skip special fields that shouldn't be preserved
            if key == "magic" || key == "struct_size" || key == "abi_version" {
                continue;
            }
            
            // Preserve user data fields
            preserved.push(field_path);
            result.insert(key.clone(), old_val.clone());
        }
    }
    
    result
}

/// Generate a state migration report for logging
pub fn generate_migration_report(diff: &DiffResult) -> String {
    let mut report = String::new();
    
    report.push_str("[State Migration]\n");
    
    if !diff.preserved_fields.is_empty() {
        report.push_str(&format!("  Preserved ({}):", diff.preserved_fields.len()));
        for (i, field) in diff.preserved_fields.iter().take(5).enumerate() {
            if i > 0 { report.push_str(","); }
            report.push_str(&format!(" {}", field));
        }
        if diff.preserved_fields.len() > 5 {
            report.push_str(&format!(" (+{} more)", diff.preserved_fields.len() - 5));
        }
        report.push('\n');
    }
    
    if !diff.reset_fields.is_empty() {
        report.push_str(&format!("  Reset ({}):", diff.reset_fields.len()));
        for (i, field) in diff.reset_fields.iter().take(5).enumerate() {
            if i > 0 { report.push_str(","); }
            report.push_str(&format!(" {}", field));
        }
        if diff.reset_fields.len() > 5 {
            report.push_str(&format!(" (+{} more)", diff.reset_fields.len() - 5));
        }
        report.push('\n');
    }
    
    if !diff.new_fields.is_empty() {
        report.push_str(&format!("  New fields: {:?}\n", diff.new_fields));
    }
    
    report
}

/// Quick check if state structs are compatible (same magic/abi)
pub fn check_state_compatibility(old_json: &str, new_json: &str) -> Result<bool, String> {
    let old: Value = serde_json::from_str(old_json)
        .map_err(|e| format!("Failed to parse old state: {}", e))?;
    let new: Value = serde_json::from_str(new_json)
        .map_err(|e| format!("Failed to parse new state: {}", e))?;
    
    // Check magic numbers match
    let old_magic = old.get("magic").and_then(|v| v.as_u64());
    let new_magic = new.get("magic").and_then(|v| v.as_u64());
    
    if old_magic != new_magic {
        return Ok(false);
    }
    
    // Check ABI versions are compatible
    let old_abi = old.get("abi_version").and_then(|v| v.as_u64()).unwrap_or(1);
    let new_abi = new.get("abi_version").and_then(|v| v.as_u64()).unwrap_or(1);
    
    if new_abi < old_abi {
        // Downgrade not supported
        return Ok(false);
    }
    
    Ok(true)
}

/// Merge old state into new state template, preserving compatible fields
pub fn migrate_state(
    old_state_json: &str,
    new_state_template_json: &str,
    module_type: &str,
) -> Result<(String, DiffResult), String> {
    let old: Value = serde_json::from_str(old_state_json)
        .map_err(|e| format!("Failed to parse old state: {}", e))?;
    let new: Value = serde_json::from_str(new_state_template_json)
        .map_err(|e| format!("Failed to parse new state: {}", e))?;
    
    let config = match module_type {
        "core" => DiffConfig::for_core(),
        "gui" => DiffConfig::for_gui(),
        _ => DiffConfig::new(),
    };
    
    let diff = diff_and_merge(&old, &new, &config);
    let merged_json = serde_json::to_string(&diff.merged_state)
        .map_err(|e| format!("Failed to serialize merged state: {}", e))?;
    
    Ok((merged_json, diff))
}

// ============================================================
// C FFI FOR RUNNER INTEGRATION
// ============================================================

/// Migrate state JSON (C-compatible wrapper)
/// Returns allocated JSON string that must be freed by caller
#[no_mangle]
pub extern "C" fn synthi_migrate_state(
    old_json_ptr: *const std::ffi::c_char,
    new_json_ptr: *const std::ffi::c_char,
    module_type_ptr: *const std::ffi::c_char,
) -> *mut std::ffi::c_char {
    use std::ffi::{CStr, CString};
    
    unsafe {
        let old_json = match CStr::from_ptr(old_json_ptr).to_str() {
            Ok(s) => s,
            Err(_) => return std::ptr::null_mut(),
        };
        let new_json = match CStr::from_ptr(new_json_ptr).to_str() {
            Ok(s) => s,
            Err(_) => return std::ptr::null_mut(),
        };
        let module_type = match CStr::from_ptr(module_type_ptr).to_str() {
            Ok(s) => s,
            Err(_) => "main",
        };
        
        match migrate_state(old_json, new_json, module_type) {
            Ok((merged, _)) => {
                match CString::new(merged) {
                    Ok(cstr) => cstr.into_raw(),
                    Err(_) => std::ptr::null_mut(),
                }
            }
            Err(_) => std::ptr::null_mut(),
        }
    }
}

/// Free migrated state JSON
#[no_mangle]
pub extern "C" fn synthi_free_migrated_state(ptr: *mut std::ffi::c_char) {
    if !ptr.is_null() {
        unsafe {
            let _ = std::ffi::CString::from_raw(ptr);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    
    #[test]
    fn test_simple_merge() {
        let old = json!({
            "x": 100,
            "y": 200,
            "dx": 5
        });
        
        let new = json!({
            "x": 0,
            "y": 0,
            "dx": 0,
            "new_field": "hello"
        });
        
        let config = DiffConfig::for_core();
        let result = diff_and_merge(&old, &new, &config);
        
        // x, y should be preserved (in always_preserve)
        assert_eq!(result.merged_state["x"], 100);
        assert_eq!(result.merged_state["y"], 200);
        // dx should reset (not in always_preserve, values differ)
        assert_eq!(result.merged_state["dx"], 0);
        // new_field should be added
        assert_eq!(result.merged_state["new_field"], "hello");
    }
    
    #[test]
    fn test_nested_merge() {
        let old = json!({
            "position": {
                "x": 100,
                "y": 200
            },
            "velocity": {
                "dx": 5,
                "dy": -3
            }
        });
        
        let new = json!({
            "position": {
                "x": 0,
                "y": 0,
                "z": 0
            },
            "velocity": {
                "dx": 0,
                "dy": 0
            }
        });
        
        let config = DiffConfig::for_core();
        let result = diff_and_merge(&old, &new, &config);
        
        // Position should be preserved
        assert_eq!(result.merged_state["position"]["x"], 100);
        assert_eq!(result.merged_state["position"]["y"], 200);
        // z is new
        assert_eq!(result.merged_state["position"]["z"], 0);
    }
    
    #[test]
    fn test_always_reset() {
        let old = json!({
            "x": 100,
            "animation_frame": 42
        });
        
        let new = json!({
            "x": 0,
            "animation_frame": 0
        });
        
        let config = DiffConfig::for_gui();
        let result = diff_and_merge(&old, &new, &config);
        
        // animation_frame should always reset
        assert_eq!(result.merged_state["animation_frame"], 0);
    }
    
    #[test]
    fn test_migration_report() {
        let result = DiffResult {
            preserved_fields: vec!["x".to_string(), "y".to_string()],
            reset_fields: vec!["dx".to_string()],
            new_fields: vec!["new_field".to_string()],
            removed_fields: vec![],
            merged_state: json!({}),
        };
        
        let report = generate_migration_report(&result);
        assert!(report.contains("Preserved (2)"));
        assert!(report.contains("Reset (1)"));
    }
}
