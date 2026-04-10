// ============================================================
// ADAPTER REGISTRY & FACTORY
// ============================================================
// Central registry that maps languages to concrete adapter
// instances.  The planner asks for an adapter by language and
// receives a dyn Adapter.
// ============================================================


use std::collections::HashMap;

use crate::hmr::adapter_matrix::AdapterMatrix;
use crate::hmr::adapter_trait::{Adapter, AdapterInfo};
use crate::hmr::dynlib_adapter::{DynLibAdapter, DynLibAdapterConfig};
use crate::hmr::managed_runtime_adapter::{ManagedRuntimeAdapter, ManagedRuntimeConfig, ManagedRuntimeKind};
use crate::hmr::process_swap_adapter::{ProcessSwapAdapter, ProcessSwapConfig};

/// A factory that creates the default adapter for a language.
pub fn create_adapter_for_language(language: &str) -> Option<Box<dyn Adapter>> {
    match language {
        "c" | "cpp" | "rust" | "zig" => {
            let config = DynLibAdapterConfig {
                languages: vec![language.into()],
                ..Default::default()
            };
            Some(Box::new(DynLibAdapter::new(config)))
        }
        "java" | "kotlin" => {
            let config = ManagedRuntimeConfig {
                languages: vec![language.into()],
                runtime_kind: ManagedRuntimeKind::Jvm,
                ..Default::default()
            };
            Some(Box::new(ManagedRuntimeAdapter::new(config)))
        }
        "csharp" => {
            let config = ManagedRuntimeConfig {
                languages: vec!["csharp".into()],
                runtime_kind: ManagedRuntimeKind::DotNet,
                ..Default::default()
            };
            Some(Box::new(ManagedRuntimeAdapter::new(config)))
        }
        "go" | "swift" => {
            let config = ProcessSwapConfig {
                languages: vec![language.into()],
                ..Default::default()
            };
            Some(Box::new(ProcessSwapAdapter::new(config)))
        }
        _ => None,
    }
}

/// Adapter registry: holds initialized adapters for active languages.
pub struct AdapterRegistry {
    adapters: HashMap<String, Box<dyn Adapter>>,
}

impl AdapterRegistry {
    pub fn new() -> Self {
        Self {
            adapters: HashMap::new(),
        }
    }

    /// Build a registry from the adapter matrix with all known languages.
    pub fn from_matrix(matrix: &AdapterMatrix) -> Self {
        let mut registry = Self::new();
        for lang in matrix.languages() {
            if let Some(adapter) = create_adapter_for_language(lang) {
                registry.adapters.insert(lang.to_string(), adapter);
            }
        }
        registry
    }

    /// Get an adapter for a language (mutable for reload calls).
    pub fn get_mut(&mut self, language: &str) -> Option<&mut Box<dyn Adapter>> {
        self.adapters.get_mut(language)
    }

    /// Get adapter info (immutable).
    pub fn get_info(&self, language: &str) -> Option<AdapterInfo> {
        self.adapters.get(language).map(|a| a.info())
    }

    /// Register a custom adapter for a language.
    pub fn register(&mut self, language: &str, adapter: Box<dyn Adapter>) {
        self.adapters.insert(language.to_string(), adapter);
    }

    /// Initialize all adapters.
    pub fn initialize_all(&mut self) -> Vec<(String, Result<(), String>)> {
        let mut results = Vec::new();
        for (lang, adapter) in self.adapters.iter_mut() {
            results.push((lang.clone(), adapter.initialize()));
        }
        results
    }

    /// Shutdown all adapters.
    pub fn shutdown_all(&mut self) -> Vec<(String, Result<(), String>)> {
        let mut results = Vec::new();
        for (lang, adapter) in self.adapters.iter_mut() {
            results.push((lang.clone(), adapter.shutdown()));
        }
        results
    }

    /// List all registered languages.
    pub fn languages(&self) -> Vec<&str> {
        self.adapters.keys().map(|s| s.as_str()).collect()
    }

    /// Number of registered adapters.
    pub fn len(&self) -> usize {
        self.adapters.len()
    }

    /// Whether registry is empty.
    pub fn is_empty(&self) -> bool {
        self.adapters.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factory_creates_dynlib() {
        let adapter = create_adapter_for_language("cpp").unwrap();
        assert_eq!(adapter.info().name, "dynlib");
    }

    #[test]
    fn factory_creates_managed() {
        let adapter = create_adapter_for_language("java").unwrap();
        assert_eq!(adapter.info().name, "managed_jvm");
    }

    #[test]
    fn factory_creates_process_swap() {
        let adapter = create_adapter_for_language("go").unwrap();
        assert_eq!(adapter.info().name, "process_swap");
    }

    #[test]
    fn factory_returns_none_for_unknown() {
        assert!(create_adapter_for_language("brainfuck").is_none());
    }

    #[test]
    fn registry_from_matrix() {
        let matrix = AdapterMatrix::default_matrix();
        let registry = AdapterRegistry::from_matrix(&matrix);
        assert!(registry.len() >= 6); // c, cpp, rust, zig, java, kotlin, go, swift
        assert!(registry.get_info("cpp").is_some());
        assert!(registry.get_info("go").is_some());
    }

    #[test]
    fn registry_initialize_all() {
        let matrix = AdapterMatrix::default_matrix();
        let mut registry = AdapterRegistry::from_matrix(&matrix);
        let results = registry.initialize_all();
        for (lang, result) in &results {
            assert!(result.is_ok(), "failed to initialize {}: {:?}", lang, result);
        }
    }
}
