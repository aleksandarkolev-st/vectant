// ============================================================
// ADAPTER FAMILY & CAPABILITY TIER MATRIX
// ============================================================
// Every compiled language maps to an adapter family and a
// capability tier. The planner branches on these, not on
// scattered language-name conditionals.
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Adapter family — groups languages by their reload mechanism.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterFamily {
    /// C, C++, Rust, Zig — dlopen/dlclose in-process swap.
    DynamicLibrary,
    /// Java, Kotlin/JVM, C#/.NET — managed host lifecycle.
    ManagedRuntime,
    /// Go, Swift — snapshot export via IPC, candidate process.
    ProcessSwap,
}

impl AdapterFamily {
    /// Best-case capability tier for this family.
    pub fn max_capability_tier(&self) -> CapabilityTier {
        match self {
            Self::DynamicLibrary => CapabilityTier::Tier3,
            Self::ManagedRuntime => CapabilityTier::Tier2,
            Self::ProcessSwap => CapabilityTier::Tier1,
        }
    }

    /// Parse from a string representation (case-insensitive, supports multiple formats).
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().replace('-', "_").as_str() {
            "dynamic_library" | "dynamiclibrary" | "dynlib" => Some(Self::DynamicLibrary),
            "managed_runtime" | "managedruntime" | "managed" => Some(Self::ManagedRuntime),
            "process_swap" | "processswap" | "procswap" => Some(Self::ProcessSwap),
            _ => None,
        }
    }
}

/// Capability tier — declares the best reload mode available.
///
/// Tier 0: compile + full restart inside the same preview session.
/// Tier 1: process swap with state handoff.
/// Tier 2: managed reload or host-controlled slot reload.
/// Tier 3: warm in-process artifact swap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum CapabilityTier {
    #[serde(rename = "tier_0")]
    Tier0 = 0,
    #[serde(rename = "tier_1")]
    Tier1 = 1,
    #[serde(rename = "tier_2")]
    Tier2 = 2,
    #[serde(rename = "tier_3")]
    Tier3 = 3,
}

impl CapabilityTier {
    /// Returns true if this tier supports in-process warm reload.
    pub fn supports_warm_reload(&self) -> bool {
        *self >= Self::Tier3
    }

    /// Returns true if this tier supports managed slot reload.
    pub fn supports_managed_reload(&self) -> bool {
        *self >= Self::Tier2
    }

    /// Returns true if this tier supports process swap with handoff.
    pub fn supports_process_swap(&self) -> bool {
        *self >= Self::Tier1
    }
}

/// Describes one language adapter's capabilities and requirements.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdapterDescriptor {
    /// The language this adapter handles (e.g. "cpp", "java", "rust").
    pub language: String,
    /// Which family this adapter belongs to.
    pub family: AdapterFamily,
    /// Highest tier this adapter can achieve.
    pub capability_tier: CapabilityTier,
    /// Snapshot modes this adapter supports (ordered by preference).
    pub snapshot_modes: Vec<String>,
    /// Healthcheck strategy this adapter uses.
    pub healthcheck_strategy: String,
    /// What happens when the adapter cannot achieve its declared tier.
    pub fallback_behavior: String,
}

/// The full adapter capability matrix.
///
/// Built once at startup and consulted by the planner for every
/// reload decision.
pub struct AdapterMatrix {
    adapters: HashMap<String, AdapterDescriptor>,
}

impl AdapterMatrix {
    /// Build the default matrix with all known adapters.
    pub fn default_matrix() -> Self {
        let mut adapters = HashMap::new();

        adapters.insert("cpp".into(), AdapterDescriptor {
            language: "cpp".into(),
            family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier3,
            snapshot_modes: vec!["binary".into(), "json".into()],
            healthcheck_strategy: "first_tick".into(),
            fallback_behavior: "cold_reload".into(),
        });

        adapters.insert("c".into(), AdapterDescriptor {
            language: "c".into(),
            family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier3,
            snapshot_modes: vec!["binary".into(), "json".into()],
            healthcheck_strategy: "first_tick".into(),
            fallback_behavior: "cold_reload".into(),
        });

        adapters.insert("rust".into(), AdapterDescriptor {
            language: "rust".into(),
            family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier3,
            snapshot_modes: vec!["binary".into(), "json".into()],
            healthcheck_strategy: "first_tick".into(),
            fallback_behavior: "cold_reload".into(),
        });

        adapters.insert("zig".into(), AdapterDescriptor {
            language: "zig".into(),
            family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier3,
            snapshot_modes: vec!["binary".into()],
            healthcheck_strategy: "symbol_check".into(),
            fallback_behavior: "full_restart".into(),
        });

        adapters.insert("java".into(), AdapterDescriptor {
            language: "java".into(),
            family: AdapterFamily::ManagedRuntime,
            capability_tier: CapabilityTier::Tier0,
            snapshot_modes: vec!["json".into()],
            healthcheck_strategy: "startup_sequence".into(),
            fallback_behavior: "full_restart".into(),
        });

        adapters.insert("kotlin".into(), AdapterDescriptor {
            language: "kotlin".into(),
            family: AdapterFamily::ManagedRuntime,
            capability_tier: CapabilityTier::Tier0,
            snapshot_modes: vec!["json".into()],
            healthcheck_strategy: "startup_sequence".into(),
            fallback_behavior: "full_restart".into(),
        });

        adapters.insert("go".into(), AdapterDescriptor {
            language: "go".into(),
            family: AdapterFamily::ProcessSwap,
            capability_tier: CapabilityTier::Tier1,
            snapshot_modes: vec!["json".into()],
            healthcheck_strategy: "startup_sequence".into(),
            fallback_behavior: "full_restart".into(),
        });

        adapters.insert("swift".into(), AdapterDescriptor {
            language: "swift".into(),
            family: AdapterFamily::ProcessSwap,
            capability_tier: CapabilityTier::Tier1,
            snapshot_modes: vec!["json".into()],
            healthcheck_strategy: "startup_sequence".into(),
            fallback_behavior: "full_restart".into(),
        });

        Self { adapters }
    }

    /// Look up the adapter descriptor for a language.
    pub fn get(&self, language: &str) -> Option<&AdapterDescriptor> {
        self.adapters.get(language)
    }

    /// Register a new adapter at runtime.
    pub fn register(&mut self, descriptor: AdapterDescriptor) {
        self.adapters.insert(descriptor.language.clone(), descriptor);
    }

    /// List all known language keys.
    pub fn languages(&self) -> Vec<&str> {
        self.adapters.keys().map(|s| s.as_str()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_matrix_contains_cpp() {
        let matrix = AdapterMatrix::default_matrix();
        let cpp = matrix.get("cpp").unwrap();
        assert_eq!(cpp.family, AdapterFamily::DynamicLibrary);
        assert_eq!(cpp.capability_tier, CapabilityTier::Tier3);
        assert!(cpp.capability_tier.supports_warm_reload());
    }

    #[test]
    fn java_is_tier0() {
        let matrix = AdapterMatrix::default_matrix();
        let java = matrix.get("java").unwrap();
        assert_eq!(java.family, AdapterFamily::ManagedRuntime);
        assert_eq!(java.capability_tier, CapabilityTier::Tier0);
        assert!(!java.capability_tier.supports_warm_reload());
        assert!(!java.capability_tier.supports_process_swap());
    }

    #[test]
    fn tier_ordering() {
        assert!(CapabilityTier::Tier3 > CapabilityTier::Tier2);
        assert!(CapabilityTier::Tier2 > CapabilityTier::Tier1);
        assert!(CapabilityTier::Tier1 > CapabilityTier::Tier0);
    }

    #[test]
    fn adapter_family_max_tier() {
        assert_eq!(AdapterFamily::DynamicLibrary.max_capability_tier(), CapabilityTier::Tier3);
        assert_eq!(AdapterFamily::ManagedRuntime.max_capability_tier(), CapabilityTier::Tier2);
        assert_eq!(AdapterFamily::ProcessSwap.max_capability_tier(), CapabilityTier::Tier1);
    }
}
