// ============================================================
// WAVE 09 INTEGRATION TESTS
// ============================================================
// End-to-end scenarios for AI hardening pipeline:
// request → validate → timeout → cache → circuit breaker →
// fallback → cost tracking.
// ============================================================

#![allow(dead_code)]

#[cfg(test)]
mod tests {
    use crate::hmr::ai_cache::{AiCache, AiCacheConfig};
    use crate::hmr::ai_circuit_breaker::{CircuitBreaker, CircuitBreakerConfig, CircuitCheckResult, CircuitState};
    use crate::hmr::ai_cost_tracker::{CostBudget, CostCheckResult, CostModel, CostTracker};
    use crate::hmr::ai_fallback_chain::{build_fallback_chain, FallbackAdvance, FallbackLevel, FallbackTracker};
    use crate::hmr::ai_request_contract::*;
    use crate::hmr::ai_response_validator::{validate_response, ResponseValidatorConfig, ResponseVerdict};
    use crate::hmr::ai_timeout_guardian::{TimeoutGuardian, TimeoutConfig};

    fn test_request() -> AiRequest {
        AiRequest {
            request_id: "req-001".into(),
            reason: AiRequestReason::SplitUnknown,
            priority: AiPriority::Medium,
            context: AiContext {
                module_id: "mod_a".into(),
                file_paths: vec!["src/main.rs".into()],
                source_snippets: vec![],
                errors: vec![],
                adapter_family: None,
                build_summary: None,
            },
            timeout_ms: 5000,
            fallback_available: true,
            attempt: 1,
            max_attempts: 3,
        }
    }

    fn ok_response() -> AiResponse {
        AiResponse {
            request_id: "req-001".into(),
            success: true,
            recommendation: Some(AiRecommendation::SplitSuggestion {
                core_files: vec!["src/engine.rs".into()],
                gui_files: vec!["src/render.rs".into()],
                shared_files: vec![],
            }),
            error: None,
            processing_ms: 500,
            model_id: Some("gpt-4".into()),
            tokens_used: Some(TokenUsage {
                prompt_tokens: 1000,
                completion_tokens: 500,
                total_tokens: 1500,
            }),
        }
    }

    // ── Scenario 1: Happy path — request → validate → cache ────

    #[test]
    fn scenario_happy_path() {
        let req = test_request();
        let resp = ok_response();

        // Validate request
        assert!(validate_request(&req).is_ok());

        // Validate response
        let config = ResponseValidatorConfig::default();
        assert_eq!(validate_response(&resp, &config), ResponseVerdict::Valid);

        // Cache the response
        let mut cache = AiCache::new(AiCacheConfig::default());
        cache.put(&req, resp.clone(), 1000);
        assert!(cache.get(&req, 2000).is_some());

        // Track cost
        let mut cost_tracker = CostTracker::new(CostModel::default(), CostBudget::default());
        cost_tracker.record("mod_a", 1000, 500, 500);
        assert!(cost_tracker.estimated_cost() > 0.0);
    }

    // ── Scenario 2: Circuit trips → fallback chain activated ────

    #[test]
    fn scenario_circuit_trip_fallback() {
        let mut cb = CircuitBreaker::new(CircuitBreakerConfig {
            failure_threshold: 2,
            open_duration_ms: 5000,
            ..Default::default()
        });

        // Two failures trip the circuit
        cb.record_failure(1000);
        cb.record_failure(2000);
        assert_eq!(cb.state(), CircuitState::Open);

        // Request is blocked
        let check = cb.check(3000);
        assert!(matches!(check, CircuitCheckResult::Block { .. }));

        // Activate fallback chain
        let chain = build_fallback_chain(AiRequestReason::SplitUnknown);
        let mut tracker = FallbackTracker::new(chain);

        // Skip RetryAi since circuit is open
        tracker.advance(); // retry 1
        tracker.advance(); // retry 2 → moves to cache
        assert!(matches!(
            tracker.current(),
            FallbackAdvance::Try(FallbackLevel::UseCachedResponse)
        ));
    }

    // ── Scenario 3: Timeout adapts from history ────

    #[test]
    fn scenario_adaptive_timeout() {
        let mut guardian = TimeoutGuardian::new(TimeoutConfig::default());

        // Feed history of fast responses
        for _ in 0..10 {
            guardian.record_response_time(100);
        }

        let decision = guardian.compute_timeout(AiPriority::High);
        // High priority: uses min of adaptive and base
        assert!(decision.timeout_ms <= 5000); // base for High
    }

    // ── Scenario 4: Cost budget prevents request ────

    #[test]
    fn scenario_cost_budget_block() {
        let mut tracker = CostTracker::new(
            CostModel::default(),
            CostBudget {
                max_total_tokens: 5000,
                max_cost: 1.0,
                warn_percent: 80,
            },
        );

        tracker.record("mod_a", 2000, 2000, 100);
        let result = tracker.check_budget(2000);
        assert!(matches!(result, CostCheckResult::Exceeded { .. }));
    }

    // ── Scenario 5: Invalid AI response rejected ────

    #[test]
    fn scenario_invalid_response_rejected() {
        let resp = AiResponse {
            request_id: "req-001".into(),
            success: true,
            recommendation: Some(AiRecommendation::HealingPatch {
                patches: vec![FilePatch {
                    file_path: "../../../etc/passwd".into(),
                    original: "".into(),
                    patched: "malicious".into(),
                }],
                confidence: 0.1,
            }),
            error: None,
            processing_ms: 100,
            model_id: None,
            tokens_used: None,
        };

        let config = ResponseValidatorConfig::default();
        let verdict = validate_response(&resp, &config);
        assert!(matches!(verdict, ResponseVerdict::Invalid(_)));
    }
}
