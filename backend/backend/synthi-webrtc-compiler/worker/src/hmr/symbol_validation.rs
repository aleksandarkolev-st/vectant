// ============================================================
// SYMBOL RESOLUTION AND VALIDATION
// ============================================================
// Validates that a newly loaded dynamic library exports all
// required ABI symbols before promoting it to active.
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Required symbols for each module type.
pub const CORE_REQUIRED_SYMBOLS: &[&str] = &[
    "hmr_get_state_json",
    "hmr_set_state_json",
    "on_update",
];

pub const GUI_REQUIRED_SYMBOLS: &[&str] = &[
    "hmr_get_state_json",
    "hmr_set_state_json",
    "on_render",
    "on_event",
];

pub const OPTIONAL_SYMBOLS: &[&str] = &[
    "hmr_dispatch_action",
    "hmr_install_callback_logger",
    "hmr_get_version",
    "on_load",
    "on_unload",
];

/// Result of symbol validation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolValidationResult {
    /// Whether all required symbols were found.
    pub valid: bool,

    /// Required symbols that were found.
    pub found_required: Vec<String>,

    /// Required symbols that were missing.
    pub missing_required: Vec<String>,

    /// Optional symbols that were found (bonus capabilities).
    pub found_optional: Vec<String>,

    /// Total symbols exported by the library.
    pub total_exported: usize,
}

impl SymbolValidationResult {
    /// Whether the library supports state serialization.
    pub fn has_state_serialization(&self) -> bool {
        self.found_required.contains(&"hmr_get_state_json".to_string())
            && self.found_required.contains(&"hmr_set_state_json".to_string())
    }

    /// Whether the library has an on_load hook.
    pub fn has_on_load(&self) -> bool {
        self.found_optional.contains(&"on_load".to_string())
    }

    /// Whether the library has an on_unload hook.
    pub fn has_on_unload(&self) -> bool {
        self.found_optional.contains(&"on_unload".to_string())
    }
}

/// Validate exported symbols against a required set.
///
/// `exported` is the set of symbol names the library actually exports.
/// `required` is the set of symbols it must have.
pub fn validate_symbols(
    exported: &[String],
    required: &[&str],
) -> SymbolValidationResult {
    let exported_set: HashSet<&str> = exported.iter().map(|s| s.as_str()).collect();

    let found_required: Vec<String> = required
        .iter()
        .filter(|s| exported_set.contains(**s))
        .map(|s| s.to_string())
        .collect();

    let missing_required: Vec<String> = required
        .iter()
        .filter(|s| !exported_set.contains(**s))
        .map(|s| s.to_string())
        .collect();

    let found_optional: Vec<String> = OPTIONAL_SYMBOLS
        .iter()
        .filter(|s| exported_set.contains(**s))
        .map(|s| s.to_string())
        .collect();

    SymbolValidationResult {
        valid: missing_required.is_empty(),
        found_required,
        missing_required,
        found_optional,
        total_exported: exported.len(),
    }
}

/// Validate symbols for a core module.
pub fn validate_core_symbols(exported: &[String]) -> SymbolValidationResult {
    validate_symbols(exported, CORE_REQUIRED_SYMBOLS)
}

/// Validate symbols for a GUI module.
pub fn validate_gui_symbols(exported: &[String]) -> SymbolValidationResult {
    validate_symbols(exported, GUI_REQUIRED_SYMBOLS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn syms(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn valid_core_module() {
        let exported = syms(&[
            "hmr_get_state_json",
            "hmr_set_state_json",
            "on_update",
            "on_load",
        ]);
        let result = validate_core_symbols(&exported);
        assert!(result.valid);
        assert!(result.missing_required.is_empty());
        assert!(result.has_state_serialization());
        assert!(result.has_on_load());
    }

    #[test]
    fn missing_on_update() {
        let exported = syms(&["hmr_get_state_json", "hmr_set_state_json"]);
        let result = validate_core_symbols(&exported);
        assert!(!result.valid);
        assert_eq!(result.missing_required, vec!["on_update".to_string()]);
    }

    #[test]
    fn valid_gui_module() {
        let exported = syms(&[
            "hmr_get_state_json",
            "hmr_set_state_json",
            "on_render",
            "on_event",
        ]);
        let result = validate_gui_symbols(&exported);
        assert!(result.valid);
    }

    #[test]
    fn gui_missing_on_event() {
        let exported = syms(&["hmr_get_state_json", "hmr_set_state_json", "on_render"]);
        let result = validate_gui_symbols(&exported);
        assert!(!result.valid);
        assert!(result.missing_required.contains(&"on_event".to_string()));
    }
}
