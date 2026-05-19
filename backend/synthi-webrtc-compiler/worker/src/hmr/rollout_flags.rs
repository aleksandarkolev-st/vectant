// ============================================================
// FEATURE FLAGS & KILL SWITCHES PER ADAPTER FAMILY
// ============================================================
// Rollout guardrails that let the team enable better reload
// modes safely per adapter family. Kill switches disable
// specific reload modes without shipping a code revert.
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::planner_decision::ReloadDecision;

/// Configuration for one adapter family's rollout.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdapterRolloutConfig {
    /// Whether this adapter family is enabled at all.
    pub enabled: bool,
    /// Maximum capability tier allowed for this family.
    /// Even if the adapter claims Tier3, this caps what the planner may use.
    pub max_allowed_tier: CapabilityTier,
    /// Kill switches: if `true`, the corresponding reload mode is disabled.
    pub kill_warm_reload: bool,
    pub kill_cold_reload: bool,
    pub kill_managed_reload: bool,
    pub kill_process_swap: bool,
    /// Force all reloads for this family to use this decision, overriding the planner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forced_fallback: Option<ReloadDecision>,
    /// Percentage of sessions to enable warm reload for (0–100).
    /// 100 = all sessions, 0 = no sessions. Used for gradual rollout.
    pub warm_reload_rollout_pct: u8,
}

impl Default for AdapterRolloutConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_allowed_tier: CapabilityTier::Tier3,
            kill_warm_reload: false,
            kill_cold_reload: false,
            kill_managed_reload: false,
            kill_process_swap: false,
            forced_fallback: None,
            warm_reload_rollout_pct: 100,
        }
    }
}

impl AdapterRolloutConfig {
    /// Returns `true` if the given reload decision is killed by a switch.
    pub fn is_killed(&self, decision: ReloadDecision) -> bool {
        match decision {
            ReloadDecision::WarmReload => self.kill_warm_reload,
            ReloadDecision::ColdReload => self.kill_cold_reload,
            ReloadDecision::ManagedReload => self.kill_managed_reload,
            ReloadDecision::ProcessSwap => self.kill_process_swap,
            ReloadDecision::FullRestart | ReloadDecision::RejectBuild => false,
        }
    }

    /// Returns the effective max tier, capped by this config.
    pub fn effective_tier(&self, declared: CapabilityTier) -> CapabilityTier {
        if declared > self.max_allowed_tier {
            self.max_allowed_tier
        } else {
            declared
        }
    }
}

/// Global rollout configuration across all adapter families.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RolloutConfig {
    /// Per-family configs.
    pub families: HashMap<String, AdapterRolloutConfig>,
    /// Global kill switch — disables all HMR, forcing full restart everywhere.
    pub global_kill_hmr: bool,
    /// Global flag: skip AI in hot path even when adapted-project mode is missing.
    pub force_no_ai_hot_path: bool,
}

impl Default for RolloutConfig {
    fn default() -> Self {
        let mut families = HashMap::new();
        families.insert("dynamic_library".into(), AdapterRolloutConfig::default());
        families.insert(
            "managed_runtime".into(),
            AdapterRolloutConfig {
                max_allowed_tier: CapabilityTier::Tier0,
                ..Default::default()
            },
        );
        families.insert(
            "process_swap".into(),
            AdapterRolloutConfig {
                max_allowed_tier: CapabilityTier::Tier1,
                ..Default::default()
            },
        );

        Self {
            families,
            global_kill_hmr: false,
            force_no_ai_hot_path: false,
        }
    }
}

impl RolloutConfig {
    /// Get the rollout config for a family, falling back to a restrictive default.
    pub fn get_family(&self, family: &AdapterFamily) -> &AdapterRolloutConfig {
        let key = match family {
            AdapterFamily::DynamicLibrary => "dynamic_library",
            AdapterFamily::ManagedRuntime => "managed_runtime",
            AdapterFamily::ProcessSwap => "process_swap",
        };
        self.families.get(key).unwrap_or(&RESTRICTIVE_DEFAULT)
    }
}

/// A restrictive fallback for unknown adapter families.
static RESTRICTIVE_DEFAULT: AdapterRolloutConfig = AdapterRolloutConfig {
    enabled: false,
    max_allowed_tier: CapabilityTier::Tier0,
    kill_warm_reload: true,
    kill_cold_reload: false,
    kill_managed_reload: true,
    kill_process_swap: true,
    forced_fallback: Some(ReloadDecision::FullRestart),
    warm_reload_rollout_pct: 0,
};

/// Thread-safe, runtime-mutable rollout config store.
///
/// Used by the planner to read current flags. Can be updated
/// at runtime via an admin endpoint or environment reload.
pub struct RolloutFlags {
    inner: Arc<RwLock<RolloutConfig>>,
}

impl RolloutFlags {
    pub fn new(config: RolloutConfig) -> Self {
        Self {
            inner: Arc::new(RwLock::new(config)),
        }
    }

    pub fn default_flags() -> Self {
        Self::new(RolloutConfig::default())
    }

    /// Alias for `default_flags()` — used by planner tests.
    pub fn new_defaults() -> Self {
        Self::default_flags()
    }

    pub fn read(&self) -> std::sync::RwLockReadGuard<'_, RolloutConfig> {
        self.inner.read().unwrap()
    }

    pub fn update(&self, new_config: RolloutConfig) {
        let mut guard = self.inner.write().unwrap();
        *guard = new_config;
    }

    /// Returns true when the global HMR kill switch is active.
    pub fn is_hmr_killed(&self) -> bool {
        self.inner.read().unwrap().global_kill_hmr
    }

    /// Returns true when the kill switch for a specific adapter family is active.
    pub fn is_family_killed(&self, family: &AdapterFamily) -> bool {
        let guard = self.inner.read().unwrap();
        !guard.get_family(family).enabled
    }

    /// String-based variant of `is_family_killed` for BuildManifest interop.
    pub fn is_family_killed_str(&self, family_str: &str) -> bool {
        match AdapterFamily::from_str(family_str) {
            Some(family) => self.is_family_killed(&family),
            None => true, // Unknown families are killed by default
        }
    }

    /// Returns the forced fallback decision string for a family, if one is set.
    pub fn forced_fallback_for(&self, family: &AdapterFamily) -> Option<String> {
        let guard = self.inner.read().unwrap();
        let cfg = guard.get_family(family);
        cfg.forced_fallback.as_ref().map(|d| match d {
            ReloadDecision::ColdReload => "cold_reload".into(),
            ReloadDecision::ProcessSwap => "process_swap".into(),
            ReloadDecision::FullRestart => "full_restart".into(),
            ReloadDecision::ManagedReload => "managed_reload".into(),
            ReloadDecision::WarmReload => "warm_reload".into(),
            ReloadDecision::RejectBuild => "reject_build".into(),
        })
    }

    /// String-based variant of `forced_fallback_for` for BuildManifest interop.
    pub fn forced_fallback_for_str(&self, family_str: &str) -> Option<String> {
        match AdapterFamily::from_str(family_str) {
            Some(family) => self.forced_fallback_for(&family),
            None => Some("full_restart".into()),
        }
    }

    /// Set the global kill switch at runtime.
    pub fn set_global_kill(&self, killed: bool) {
        let mut guard = self.inner.write().unwrap();
        guard.global_kill_hmr = killed;
    }
}

impl Clone for RolloutFlags {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_allows_warm() {
        let cfg = AdapterRolloutConfig::default();
        assert!(!cfg.is_killed(ReloadDecision::WarmReload));
        assert_eq!(cfg.warm_reload_rollout_pct, 100);
    }

    #[test]
    fn kill_switch_blocks_warm() {
        let cfg = AdapterRolloutConfig {
            kill_warm_reload: true,
            ..Default::default()
        };
        assert!(cfg.is_killed(ReloadDecision::WarmReload));
        assert!(!cfg.is_killed(ReloadDecision::ColdReload));
    }

    #[test]
    fn effective_tier_caps() {
        let cfg = AdapterRolloutConfig {
            max_allowed_tier: CapabilityTier::Tier1,
            ..Default::default()
        };
        assert_eq!(
            cfg.effective_tier(CapabilityTier::Tier3),
            CapabilityTier::Tier1
        );
        assert_eq!(
            cfg.effective_tier(CapabilityTier::Tier0),
            CapabilityTier::Tier0
        );
    }

    #[test]
    fn global_defaults() {
        let rc = RolloutConfig::default();
        assert!(!rc.global_kill_hmr);
        assert!(!rc.force_no_ai_hot_path);
        assert!(rc.families.contains_key("dynamic_library"));
    }

    #[test]
    fn rollout_flags_update() {
        let flags = RolloutFlags::default_flags();
        assert!(!flags.read().global_kill_hmr);
        flags.update(RolloutConfig {
            global_kill_hmr: true,
            ..Default::default()
        });
        assert!(flags.read().global_kill_hmr);
    }
}
