// ============================================================
// AI COST TRACKER
// ============================================================
// Tracks token usage and estimated cost per session/module.
// Enforces per-session budgets to prevent runaway AI spending.
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Cost model coefficients.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostModel {
    /// Cost per 1K prompt tokens (USD).
    pub prompt_cost_per_1k: f64,
    /// Cost per 1K completion tokens (USD).
    pub completion_cost_per_1k: f64,
    /// Currency label.
    pub currency: String,
}

impl Default for CostModel {
    fn default() -> Self {
        Self {
            prompt_cost_per_1k: 0.01,
            completion_cost_per_1k: 0.03,
            currency: "USD".into(),
        }
    }
}

/// Per-session budget configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostBudget {
    /// Maximum total tokens per session.
    pub max_total_tokens: u64,
    /// Maximum estimated cost per session (USD).
    pub max_cost: f64,
    /// Warning threshold (percentage).
    pub warn_percent: u8,
}

impl Default for CostBudget {
    fn default() -> Self {
        Self {
            max_total_tokens: 500_000,
            max_cost: 5.0,
            warn_percent: 80,
        }
    }
}

/// Budget check result.
#[derive(Debug, Clone, PartialEq)]
pub enum CostCheckResult {
    /// Within budget.
    Ok,
    /// Approaching limit.
    Warning { used_percent: u8 },
    /// Budget exceeded.
    Exceeded { actual: f64, limit: f64 },
}

/// Accumulated usage for a single module.
#[derive(Debug, Clone, Default)]
pub struct ModuleUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub request_count: u32,
    pub total_processing_ms: u64,
}

/// Tracks AI costs across a session.
pub struct CostTracker {
    model: CostModel,
    budget: CostBudget,
    /// Per-module accumulation.
    module_usage: HashMap<String, ModuleUsage>,
    /// Global totals.
    total_prompt_tokens: u64,
    total_completion_tokens: u64,
    total_requests: u32,
}

impl CostTracker {
    pub fn new(model: CostModel, budget: CostBudget) -> Self {
        Self {
            model,
            budget,
            module_usage: HashMap::new(),
            total_prompt_tokens: 0,
            total_completion_tokens: 0,
            total_requests: 0,
        }
    }

    /// Record token usage from an AI response.
    pub fn record(
        &mut self,
        module_id: &str,
        prompt_tokens: u32,
        completion_tokens: u32,
        processing_ms: u64,
    ) {
        self.total_prompt_tokens += prompt_tokens as u64;
        self.total_completion_tokens += completion_tokens as u64;
        self.total_requests += 1;

        let usage = self.module_usage.entry(module_id.to_string()).or_default();
        usage.prompt_tokens += prompt_tokens as u64;
        usage.completion_tokens += completion_tokens as u64;
        usage.request_count += 1;
        usage.total_processing_ms += processing_ms;
    }

    /// Check if a proposed request is within budget.
    pub fn check_budget(&self, estimated_tokens: u32) -> CostCheckResult {
        let future_total =
            self.total_prompt_tokens + self.total_completion_tokens + estimated_tokens as u64;

        // Token limit check
        if future_total > self.budget.max_total_tokens {
            return CostCheckResult::Exceeded {
                actual: future_total as f64,
                limit: self.budget.max_total_tokens as f64,
            };
        }

        // Cost limit check
        let current_cost = self.estimated_cost();
        let per_token_cost =
            (self.model.prompt_cost_per_1k + self.model.completion_cost_per_1k) / 2000.0;
        let future_cost = current_cost + (estimated_tokens as f64 * per_token_cost);
        if future_cost > self.budget.max_cost {
            return CostCheckResult::Exceeded {
                actual: future_cost,
                limit: self.budget.max_cost,
            };
        }

        // Warning check
        let used_percent =
            ((future_total as f64 / self.budget.max_total_tokens as f64) * 100.0) as u8;
        if used_percent >= self.budget.warn_percent {
            return CostCheckResult::Warning { used_percent };
        }

        CostCheckResult::Ok
    }

    /// Estimated cost so far.
    pub fn estimated_cost(&self) -> f64 {
        let prompt_cost = self.total_prompt_tokens as f64 * self.model.prompt_cost_per_1k / 1000.0;
        let completion_cost =
            self.total_completion_tokens as f64 * self.model.completion_cost_per_1k / 1000.0;
        prompt_cost + completion_cost
    }

    /// Total tokens used.
    pub fn total_tokens(&self) -> u64 {
        self.total_prompt_tokens + self.total_completion_tokens
    }

    /// Number of requests made.
    pub fn request_count(&self) -> u32 {
        self.total_requests
    }

    /// Usage per module.
    pub fn module_usage(&self, module_id: &str) -> Option<&ModuleUsage> {
        self.module_usage.get(module_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_budget() {
        let tracker = CostTracker::new(CostModel::default(), CostBudget::default());
        assert_eq!(tracker.check_budget(1000), CostCheckResult::Ok);
    }

    #[test]
    fn exceeds_token_budget() {
        let mut tracker = CostTracker::new(
            CostModel::default(),
            CostBudget {
                max_total_tokens: 1000,
                ..Default::default()
            },
        );
        tracker.record("mod_a", 500, 400, 100);
        let result = tracker.check_budget(200);
        assert!(matches!(result, CostCheckResult::Exceeded { .. }));
    }

    #[test]
    fn cost_accumulates() {
        let mut tracker = CostTracker::new(CostModel::default(), CostBudget::default());
        tracker.record("mod_a", 1000, 500, 200);
        tracker.record("mod_b", 2000, 1000, 300);
        assert_eq!(tracker.total_tokens(), 4500);
        assert_eq!(tracker.request_count(), 2);
        assert!(tracker.estimated_cost() > 0.0);
    }
}
