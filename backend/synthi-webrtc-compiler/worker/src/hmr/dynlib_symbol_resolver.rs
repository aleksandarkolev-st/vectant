// ============================================================
// DYNLIB SYMBOL RESOLVER
// ============================================================
// Resolves symbols from a loaded shared library and maps them
// to typed function pointers.  Used by the dynlib adapter to
// call into user code through the ABI contract.
// ============================================================

#![allow(dead_code)]

use std::collections::HashMap;

use crate::hmr::dynlib_abi_contract::{AbiHeader, DynLibAbiContract, canonical_abi_contract};

/// A resolved symbol with its address (simulated as u64).
#[derive(Debug, Clone)]
pub struct ResolvedSymbol {
    pub name: String,
    /// Function pointer address.
    pub address: u64,
    /// Whether this is a required or optional symbol.
    pub required: bool,
}

/// The set of resolved symbols from a loaded library.
#[derive(Debug, Clone)]
pub struct SymbolTable {
    symbols: HashMap<String, ResolvedSymbol>,
    /// ABI version reported by the library.
    pub abi_version: Option<AbiHeader>,
    /// Library path for diagnostics.
    pub library_path: String,
}

impl SymbolTable {
    pub fn new(library_path: &str) -> Self {
        Self {
            symbols: HashMap::new(),
            abi_version: None,
            library_path: library_path.to_string(),
        }
    }

    /// Insert a resolved symbol.
    pub fn insert(&mut self, name: &str, address: u64, required: bool) {
        self.symbols.insert(
            name.to_string(),
            ResolvedSymbol {
                name: name.to_string(),
                address,
                required,
            },
        );
    }

    /// Look up a symbol by name.
    pub fn get(&self, name: &str) -> Option<&ResolvedSymbol> {
        self.symbols.get(name)
    }

    /// Check if a symbol exists.
    pub fn has(&self, name: &str) -> bool {
        self.symbols.contains_key(name)
    }

    /// Get all symbol names.
    pub fn names(&self) -> Vec<&str> {
        self.symbols.keys().map(|s| s.as_str()).collect()
    }

    /// Count of resolved symbols.
    pub fn len(&self) -> usize {
        self.symbols.len()
    }

    pub fn is_empty(&self) -> bool {
        self.symbols.is_empty()
    }
}

/// Result of resolving symbols from a library.
#[derive(Debug, Clone)]
pub struct ResolveResult {
    pub table: SymbolTable,
    pub missing_required: Vec<String>,
    pub missing_optional: Vec<String>,
    pub capabilities: Vec<String>,
}

/// Resolve symbols from a library against the canonical ABI contract.
///
/// In production, this would dlopen and dlsym each symbol.  Here we
/// accept a list of "exported" symbol names and simulate resolution.
pub fn resolve_symbols(
    library_path: &str,
    exported_names: &[String],
) -> ResolveResult {
    let contract = canonical_abi_contract();
    resolve_symbols_with_contract(library_path, exported_names, &contract)
}

/// Resolve symbols against a specific contract.
pub fn resolve_symbols_with_contract(
    library_path: &str,
    exported_names: &[String],
    contract: &DynLibAbiContract,
) -> ResolveResult {
    let mut table = SymbolTable::new(library_path);
    let mut missing_required = Vec::new();
    let mut missing_optional = Vec::new();
    let mut capabilities = Vec::new();

    // Simulated address counter
    let mut addr: u64 = 0x1000;

    // Resolve required symbols
    for req in &contract.required {
        if exported_names.iter().any(|n| n == &req.name) {
            table.insert(&req.name, addr, true);
            addr += 0x100;
        } else {
            missing_required.push(req.name.clone());
        }
    }

    // Resolve optional symbols
    for opt in &contract.optional {
        if exported_names.iter().any(|n| n == &opt.name) {
            table.insert(&opt.name, addr, false);
            addr += 0x100;
            if !capabilities.contains(&opt.enables) {
                capabilities.push(opt.enables.clone());
            }
        } else {
            missing_optional.push(opt.name.clone());
        }
    }

    // Try to extract ABI version
    if table.has("hmr_get_abi_version") {
        table.abi_version = Some(contract.abi_version.clone());
    }

    ResolveResult {
        table,
        missing_required,
        missing_optional,
        capabilities,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_all_required() {
        let exported = vec![
            "hmr_get_abi_version".into(),
            "hmr_init".into(),
            "hmr_shutdown".into(),
            "hmr_on_update".into(),
            "hmr_on_render".into(),
        ];
        let result = resolve_symbols("libtest.so", &exported);
        assert!(result.missing_required.is_empty());
        assert_eq!(result.table.len(), 5);
        assert!(result.table.abi_version.is_some());
    }

    #[test]
    fn detect_missing_required() {
        let exported = vec!["hmr_init".into()];
        let result = resolve_symbols("libtest.so", &exported);
        assert!(!result.missing_required.is_empty());
        assert!(result.missing_required.contains(&"hmr_get_abi_version".into()));
    }

    #[test]
    fn detect_optional_capabilities() {
        let mut exported = vec![
            "hmr_get_abi_version".into(),
            "hmr_init".into(),
            "hmr_shutdown".into(),
            "hmr_on_update".into(),
            "hmr_on_render".into(),
            "hmr_get_state_json".into(),
            "hmr_set_state_json".into(),
        ];
        let result = resolve_symbols("libtest.so", &exported);
        assert!(result.capabilities.contains(&"state_preservation".into()));
    }

    #[test]
    fn symbol_lookup() {
        let exported = vec![
            "hmr_get_abi_version".into(),
            "hmr_init".into(),
            "hmr_shutdown".into(),
            "hmr_on_update".into(),
            "hmr_on_render".into(),
        ];
        let result = resolve_symbols("libtest.so", &exported);
        let sym = result.table.get("hmr_init").unwrap();
        assert!(sym.address > 0);
        assert!(sym.required);
    }
}
