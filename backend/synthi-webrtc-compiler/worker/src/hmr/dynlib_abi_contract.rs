// ============================================================
// DYNLIB ABI CONTRACT
// ============================================================
// Defines the exact ABI that every dynamically-loaded library
// must expose for HMR to work.  This is the canonical list of
// required + optional symbols, their C signatures, and the
// versioning scheme.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// ABI version header that every dynlib must expose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AbiHeader {
    /// Major version — must match exactly.
    pub major: u32,
    /// Minor version — loader accepts minor >= expected.
    pub minor: u32,
    /// Patch — informational only.
    pub patch: u32,
}

impl AbiHeader {
    pub const CURRENT: AbiHeader = AbiHeader {
        major: 1,
        minor: 0,
        patch: 0,
    };

    /// Check compatibility: same major, new minor >= expected.
    pub fn is_compatible_with(&self, expected: &AbiHeader) -> bool {
        self.major == expected.major && self.minor >= expected.minor
    }
}

impl std::fmt::Display for AbiHeader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Required symbol that every dynlib must export.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequiredSymbol {
    /// Symbol name (e.g. "hmr_get_abi_version").
    pub name: String,
    /// Human-readable signature for documentation.
    pub signature: String,
    /// Why this symbol is needed.
    pub purpose: String,
}

/// Optional symbol that enables extra capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptionalSymbol {
    pub name: String,
    pub signature: String,
    pub purpose: String,
    /// Capability this symbol enables.
    pub enables: String,
}

/// The full ABI contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynLibAbiContract {
    pub abi_version: AbiHeader,
    pub required: Vec<RequiredSymbol>,
    pub optional: Vec<OptionalSymbol>,
}

/// Build the canonical ABI contract.
pub fn canonical_abi_contract() -> DynLibAbiContract {
    DynLibAbiContract {
        abi_version: AbiHeader::CURRENT,
        required: vec![
            RequiredSymbol {
                name: "hmr_get_abi_version".into(),
                signature: "fn() -> u32".into(),
                purpose: "Returns packed ABI version (major<<16 | minor<<8 | patch)".into(),
            },
            RequiredSymbol {
                name: "hmr_init".into(),
                signature: "fn() -> i32".into(),
                purpose: "Called once after dlopen; returns 0 on success".into(),
            },
            RequiredSymbol {
                name: "hmr_shutdown".into(),
                signature: "fn() -> i32".into(),
                purpose: "Called before dlclose; cleanup resources".into(),
            },
            RequiredSymbol {
                name: "hmr_on_update".into(),
                signature: "fn(dt_ms: u32) -> i32".into(),
                purpose: "Frame-tick update; returns 0 to continue, negative to signal error".into(),
            },
            RequiredSymbol {
                name: "hmr_on_render".into(),
                signature: "fn() -> i32".into(),
                purpose: "Render call; returns 0 on success".into(),
            },
        ],
        optional: vec![
            OptionalSymbol {
                name: "hmr_get_state_json".into(),
                signature: "fn(buf: *mut u8, buf_len: usize) -> i32".into(),
                purpose: "Serialize current state to JSON; returns bytes written or negative on error".into(),
                enables: "state_preservation".into(),
            },
            OptionalSymbol {
                name: "hmr_set_state_json".into(),
                signature: "fn(buf: *const u8, buf_len: usize) -> i32".into(),
                purpose: "Restore state from JSON; returns 0 on success".into(),
                enables: "state_preservation".into(),
            },
            OptionalSymbol {
                name: "hmr_get_state_binary".into(),
                signature: "fn(buf: *mut u8, buf_len: usize) -> i32".into(),
                purpose: "Serialize state in binary format (MessagePack); faster than JSON".into(),
                enables: "binary_state".into(),
            },
            OptionalSymbol {
                name: "hmr_set_state_binary".into(),
                signature: "fn(buf: *const u8, buf_len: usize) -> i32".into(),
                purpose: "Restore state from binary format".into(),
                enables: "binary_state".into(),
            },
            OptionalSymbol {
                name: "hmr_on_event".into(),
                signature: "fn(event_type: u32, data: *const u8, data_len: usize) -> i32".into(),
                purpose: "Handle external events (input, network, etc.)".into(),
                enables: "event_dispatch".into(),
            },
            OptionalSymbol {
                name: "hmr_healthcheck".into(),
                signature: "fn() -> i32".into(),
                purpose: "Quick health check; 0 = healthy, 1 = degraded, negative = faulted".into(),
                enables: "health_monitoring".into(),
            },
        ],
    }
}

/// Validate that a set of exported symbols satisfies the contract.
pub fn validate_symbols_against_contract(
    exported: &[String],
    contract: &DynLibAbiContract,
) -> AbiValidationResult {
    let mut missing_required = Vec::new();
    let mut available_optional = Vec::new();

    for req in &contract.required {
        if !exported.iter().any(|s| s == &req.name) {
            missing_required.push(req.name.clone());
        }
    }

    for opt in &contract.optional {
        if exported.iter().any(|s| s == &opt.name) {
            available_optional.push(opt.enables.clone());
        }
    }

    AbiValidationResult {
        valid: missing_required.is_empty(),
        missing_required,
        available_capabilities: available_optional,
    }
}

/// Result of ABI validation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbiValidationResult {
    pub valid: bool,
    pub missing_required: Vec<String>,
    pub available_capabilities: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_header_compatibility() {
        let current = AbiHeader::CURRENT;
        let same = AbiHeader { major: 1, minor: 0, patch: 0 };
        assert!(same.is_compatible_with(&current));

        let newer_minor = AbiHeader { major: 1, minor: 1, patch: 0 };
        assert!(newer_minor.is_compatible_with(&current));

        let different_major = AbiHeader { major: 2, minor: 0, patch: 0 };
        assert!(!different_major.is_compatible_with(&current));
    }

    #[test]
    fn full_symbol_set_valid() {
        let contract = canonical_abi_contract();
        let exported: Vec<String> = contract.required.iter().map(|r| r.name.clone()).collect();
        let result = validate_symbols_against_contract(&exported, &contract);
        assert!(result.valid);
        assert!(result.missing_required.is_empty());
    }

    #[test]
    fn missing_symbol_invalid() {
        let contract = canonical_abi_contract();
        let exported = vec!["hmr_get_abi_version".into(), "hmr_init".into()];
        let result = validate_symbols_against_contract(&exported, &contract);
        assert!(!result.valid);
        assert!(!result.missing_required.is_empty());
    }

    #[test]
    fn optional_capabilities_detected() {
        let contract = canonical_abi_contract();
        let mut exported: Vec<String> = contract.required.iter().map(|r| r.name.clone()).collect();
        exported.push("hmr_get_state_json".into());
        exported.push("hmr_healthcheck".into());

        let result = validate_symbols_against_contract(&exported, &contract);
        assert!(result.valid);
        assert!(result.available_capabilities.contains(&"state_preservation".into()));
        assert!(result.available_capabilities.contains(&"health_monitoring".into()));
    }
}
