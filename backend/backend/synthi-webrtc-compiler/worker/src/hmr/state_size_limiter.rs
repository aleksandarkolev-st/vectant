// ============================================================
// STATE SIZE LIMITER
// ============================================================
// Enforces per-module and global state size budgets.  Prevents
// runaway state accumulation that could OOM the worker process
// or exceed the WebRTC data channel capacity.
// ============================================================


use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Per-module size budget.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SizeBudget {
    /// Maximum state size in bytes for this module.
    pub max_bytes: usize,
    /// Warn threshold (percentage of max_bytes, 0..100).
    pub warn_percent: u8,
    /// Whether to allow temporary overflow during migration.
    pub allow_migration_overflow: bool,
}

impl Default for SizeBudget {
    fn default() -> Self {
        Self {
            max_bytes: 4 * 1024 * 1024, // 4 MB per module
            warn_percent: 80,
            allow_migration_overflow: true,
        }
    }
}

/// Global sizing limits.
#[derive(Debug, Clone)]
pub struct GlobalSizeLimits {
    /// Total state across all modules.
    pub max_total_bytes: usize,
    /// Maximum number of modules with active state.
    pub max_modules: usize,
    /// Per-module budgets (overrides global defaults).
    pub module_budgets: HashMap<String, SizeBudget>,
    /// Default budget for modules without specific override.
    pub default_budget: SizeBudget,
}

impl Default for GlobalSizeLimits {
    fn default() -> Self {
        Self {
            max_total_bytes: 64 * 1024 * 1024, // 64 MB total
            max_modules: 32,
            module_budgets: HashMap::new(),
            default_budget: SizeBudget::default(),
        }
    }
}

/// Result of a size check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SizeCheckResult {
    /// Within budget.
    Ok,
    /// Approaching limit.
    Warning { used_percent: u8 },
    /// Exceeds limit.
    Exceeded { actual: usize, limit: usize },
    /// Too many modules with active state.
    TooManyModules { count: usize, limit: usize },
}

/// Tracks current state sizes per module.
pub struct StateSizeLimiter {
    limits: GlobalSizeLimits,
    /// Current size per module id.
    current_sizes: HashMap<String, usize>,
}

impl StateSizeLimiter {
    pub fn new(limits: GlobalSizeLimits) -> Self {
        Self {
            limits,
            current_sizes: HashMap::new(),
        }
    }

    /// Check if a proposed state of `size_bytes` for `module_id` is allowed.
    pub fn check(&self, module_id: &str, size_bytes: usize) -> SizeCheckResult {
        // Module count check
        if !self.current_sizes.contains_key(module_id)
            && self.current_sizes.len() >= self.limits.max_modules
        {
            return SizeCheckResult::TooManyModules {
                count: self.current_sizes.len() + 1,
                limit: self.limits.max_modules,
            };
        }

        let budget = self
            .limits
            .module_budgets
            .get(module_id)
            .unwrap_or(&self.limits.default_budget);

        // Per-module check
        if size_bytes > budget.max_bytes {
            return SizeCheckResult::Exceeded {
                actual: size_bytes,
                limit: budget.max_bytes,
            };
        }

        // Global total check
        let other_total: usize = self
            .current_sizes
            .iter()
            .filter(|(k, _)| *k != module_id)
            .map(|(_, v)| *v)
            .sum();
        let new_total = other_total + size_bytes;
        if new_total > self.limits.max_total_bytes {
            return SizeCheckResult::Exceeded {
                actual: new_total,
                limit: self.limits.max_total_bytes,
            };
        }

        // Warning check
        let used_percent = ((size_bytes as f64 / budget.max_bytes as f64) * 100.0) as u8;
        if used_percent >= budget.warn_percent {
            return SizeCheckResult::Warning { used_percent };
        }

        SizeCheckResult::Ok
    }

    /// Record that a module's state is now `size_bytes`.
    pub fn record(&mut self, module_id: &str, size_bytes: usize) {
        if size_bytes == 0 {
            self.current_sizes.remove(module_id);
        } else {
            self.current_sizes.insert(module_id.to_string(), size_bytes);
        }
    }

    /// Remove tracking for a module.
    pub fn remove(&mut self, module_id: &str) {
        self.current_sizes.remove(module_id);
    }

    /// Total bytes across all modules.
    pub fn total_bytes(&self) -> usize {
        self.current_sizes.values().sum()
    }

    /// Number of tracked modules.
    pub fn module_count(&self) -> usize {
        self.current_sizes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_budget() {
        let limiter = StateSizeLimiter::new(GlobalSizeLimits::default());
        assert_eq!(limiter.check("mod_a", 1024), SizeCheckResult::Ok);
    }

    #[test]
    fn exceeds_module_budget() {
        let limiter = StateSizeLimiter::new(GlobalSizeLimits::default());
        let result = limiter.check("mod_a", 5 * 1024 * 1024);
        assert!(matches!(result, SizeCheckResult::Exceeded { .. }));
    }

    #[test]
    fn warning_threshold() {
        let limiter = StateSizeLimiter::new(GlobalSizeLimits {
            default_budget: SizeBudget {
                max_bytes: 1000,
                warn_percent: 80,
                allow_migration_overflow: false,
            },
            ..Default::default()
        });
        let result = limiter.check("mod_a", 850);
        assert!(matches!(result, SizeCheckResult::Warning { .. }));
    }

    #[test]
    fn too_many_modules() {
        let limiter = StateSizeLimiter::new(GlobalSizeLimits {
            max_modules: 1,
            ..Default::default()
        });
        let mut l = limiter;
        l.record("mod_a", 100);
        let result = l.check("mod_b", 100);
        assert!(matches!(result, SizeCheckResult::TooManyModules { .. }));
    }
}
