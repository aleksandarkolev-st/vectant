// ============================================================
// WAVE 04 INTEGRATION SCENARIOS
// ============================================================
// End-to-end test stubs verifying the AI hot path extraction:
// adapted project detection → loop classification → AI gate →
// bypass → deterministic compile path.
// ============================================================

#[cfg(test)]
mod tests {
    use crate::hmr::adapted_project::{detect_adapted_project, AdaptedProjectStatus};
    use crate::hmr::ai_bypass::{check_ai_bypass, AiBypassResult, CachedSplitResult, SplitCache};
    use crate::hmr::ai_gate::AiGate;
    use crate::hmr::compile_enrichment::CompileEnrichment;
    use crate::hmr::deterministic_compile::{
        determine_deterministic_scope, validate_deterministic_input, DeterministicCompileInput,
        DeterministicRebuildScope,
    };
    use crate::hmr::loop_b_triggers::{evaluate_triggers, LoopBTrigger};
    use crate::hmr::loop_classifier::{classify_loop, CompileLoop, LoopClassifierInput};
    use crate::hmr::rollout_flags::RolloutFlags;
    use std::path::PathBuf;

    /// Scenario: Adapted project uses deterministic Loop A, AI is bypassed.
    #[test]
    fn scenario_adapted_project_loop_a() {
        // 1. Detect adapted project
        let adapted = AdaptedProjectStatus::adapted(
            PathBuf::from("core.cpp"),
            PathBuf::from("gui.cpp"),
            Some(PathBuf::from("shared.h")),
        )
        .with_split_hash("source_hash_1".into());

        // 2. Classify loop
        let flags = RolloutFlags::new_defaults();
        let input = LoopClassifierInput {
            adapted_status: &adapted,
            current_source_hash: Some("source_hash_1"),
            rollout_flags: &flags,
            consecutive_failures: 0,
            failure_rescue_threshold: 3,
            user_requested_ai: false,
            user_requested_deterministic: false,
        };
        let classification = classify_loop(&input);
        assert_eq!(classification.loop_type, CompileLoop::LoopA);

        // 3. AI gate blocks
        let gate = AiGate::new();
        let cache = SplitCache::new(10);
        cache.put(CachedSplitResult {
            source_hash: "source_hash_1".into(),
            core_code: "// core".into(),
            gui_code: "// gui".into(),
            shared_code: None,
            language: "cpp".into(),
            cached_at: 1000,
        });

        let bypass = check_ai_bypass(
            &gate,
            &cache,
            classification.loop_type,
            "source_hash_1",
        );
        assert!(matches!(bypass, AiBypassResult::UseCached(_)));

        // 4. Enrichment reflects deterministic path
        let enrichment = CompileEnrichment::from_classification(
            classification,
            adapted,
            Some("source_hash_1".into()),
        );
        assert!(enrichment.is_deterministic());
        assert!(!enrichment.use_ai_split);
    }

    /// Scenario: New project triggers Loop B, AI is allowed.
    #[test]
    fn scenario_new_project_loop_b() {
        let adapted = AdaptedProjectStatus::not_adapted("no split files");
        let flags = RolloutFlags::new_defaults();

        let input = LoopClassifierInput {
            adapted_status: &adapted,
            current_source_hash: None,
            rollout_flags: &flags,
            consecutive_failures: 0,
            failure_rescue_threshold: 3,
            user_requested_ai: false,
            user_requested_deterministic: false,
        };
        let classification = classify_loop(&input);
        assert_eq!(classification.loop_type, CompileLoop::LoopB);

        // AI gate allows
        let gate = AiGate::new();
        let cache = SplitCache::new(10);
        let bypass = check_ai_bypass(
            &gate,
            &cache,
            classification.loop_type,
            "any_hash",
        );
        assert!(matches!(bypass, AiBypassResult::Proceed));

        // Trigger conditions confirm
        let trigger = evaluate_triggers(false, false, false, 0, 3, false, false);
        assert_eq!(trigger, Some(LoopBTrigger::InitialAdaptation));
    }

    /// Scenario: Failure rescue escalates to Loop B.
    #[test]
    fn scenario_failure_rescue() {
        let adapted = AdaptedProjectStatus::adapted(
            PathBuf::from("core.cpp"),
            PathBuf::from("gui.cpp"),
            None,
        )
        .with_split_hash("h1".into());

        let flags = RolloutFlags::new_defaults();
        let input = LoopClassifierInput {
            adapted_status: &adapted,
            current_source_hash: Some("h1"),
            rollout_flags: &flags,
            consecutive_failures: 5,
            failure_rescue_threshold: 3,
            user_requested_ai: false,
            user_requested_deterministic: false,
        };
        let classification = classify_loop(&input);
        assert_eq!(classification.loop_type, CompileLoop::LoopB);

        let enrichment = CompileEnrichment::from_classification(
            classification,
            adapted,
            Some("h1".into()),
        );
        assert!(enrichment.is_ai_assisted());
        assert!(enrichment.use_ai_split);
    }

    /// Scenario: Deterministic scope detection.
    #[test]
    fn scenario_deterministic_scope() {
        let adapted = AdaptedProjectStatus::adapted(
            PathBuf::from("core.cpp"),
            PathBuf::from("gui.cpp"),
            None,
        );
        let input = DeterministicCompileInput {
            adapted,
            language: "cpp".into(),
            workspace_dir: PathBuf::from("/ws"),
            output_dir: PathBuf::from("/ws/out"),
            compiler_flags: vec![],
            use_cache: true,
            preview_id: "p1".into(),
        };
        assert!(validate_deterministic_input(&input).is_ok());

        let scope = determine_deterministic_scope(
            &input,
            Some("core_v1"),
            Some("gui_v1"),
            Some("shared_v1"),
            "core_v2",
            "gui_v1",
            "shared_v1",
        );
        assert_eq!(scope, DeterministicRebuildScope::CoreOnly);
    }
}
