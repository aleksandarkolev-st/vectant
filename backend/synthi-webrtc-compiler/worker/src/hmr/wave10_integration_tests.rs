// ============================================================
// WAVE 10 INTEGRATION TESTS
// ============================================================
// End-to-end scenarios for the adapter family system:
// registry → adapter creation → reload → state handoff.
// ============================================================

#[cfg(all(test, feature = "legacy_hmr_tests"))]
mod tests {
    use crate::hmr::adapter_matrix::AdapterMatrix;
    use crate::hmr::adapter_registry::{create_adapter_for_language, AdapterRegistry};
    use crate::hmr::adapter_trait::{
        Adapter, AdapterHealth, AdapterReloadRequest, AdapterReloadResult,
    };
    use crate::hmr::build_manifest::BuildManifest;
    use crate::hmr::dynlib_build_hooks::{post_build_hook, pre_build_hook};
    use crate::hmr::dynlib_reload::{orchestrate_dynlib_reload, DynLibReloadPhase};
    use crate::hmr::managed_runtime_hooks::{determine_reload_strategy, ReloadStrategy};
    use crate::hmr::process_swap_handoff::{execute_handoff, HandoffEnvelope};
    use crate::hmr::slot_manager::SlotId;

    fn test_manifest(artifact: &str) -> BuildManifest {
        BuildManifest {
            build_id: "b-1".into(),
            module_id: "mod_a".into(),
            artifact_path: Some(artifact.into()),
            artifact_hash: "abc123".into(),
            build_ms: 1000,
            compiler_version: "1.0".into(),
            warnings: vec![],
        }
    }

    fn reload_request(artifact: &str) -> AdapterReloadRequest {
        AdapterReloadRequest {
            reload_id: "r-1".into(),
            module_id: "mod_a".into(),
            changed_files: vec!["src/main.c".into()],
            build_manifest: test_manifest(artifact),
            artifact_blob: None,
            capsule_metadata: None,
            firewall_evidence: Default::default(),
            preserve_state: true,
            timeout_ms: 5000,
        }
    }

    // ── Scenario 1: Full DynLib pipeline ────────────────────

    #[test]
    fn scenario_dynlib_full_pipeline() {
        // Pre-build
        let pre = pre_build_hook("cpp", "game_engine", "/tmp/slot_a");
        assert!(pre.flags.position_independent);
        assert!(pre.output_filename.contains("game_engine"));

        // Post-build
        let post = post_build_hook("libgame_engine.so", 256 * 1024 * 1024).unwrap();
        assert!(post.symbols_valid);

        // Orchestrate reload
        let report = orchestrate_dynlib_reload(
            "r-1",
            "game_engine",
            &test_manifest("libgame_engine.so"),
            SlotId::Primary,
            true,
        );
        assert!(report.state_preserved);
        assert!(!report.rolled_back);
        assert_eq!(report.final_health, AdapterHealth::Healthy);

        // Verify all phases were executed
        let phases: Vec<_> = report.steps.iter().map(|s| s.phase).collect();
        assert!(phases.contains(&DynLibReloadPhase::Swap));
        assert!(phases.contains(&DynLibReloadPhase::Done));
    }

    // ── Scenario 2: ManagedRuntime strategy + adapter ───────

    #[test]
    fn scenario_managed_runtime_reload() {
        let strategy = determine_reload_strategy(&["Main.java".into(), "Config.java".into()], true);
        assert_eq!(strategy.strategy, ReloadStrategy::HotSwapClasses);

        // Use adapter from registry
        let mut adapter = create_adapter_for_language("java").unwrap();
        adapter.initialize().unwrap();

        let req = AdapterReloadRequest {
            reload_id: "r-2".into(),
            module_id: "app".into(),
            changed_files: vec!["Main.java".into()],
            build_manifest: test_manifest("app.jar"),
            artifact_blob: None,
            capsule_metadata: None,
            firewall_evidence: Default::default(),
            preserve_state: false,
            timeout_ms: 5000,
        };
        let result = adapter.reload(&req);
        assert!(matches!(result, AdapterReloadResult::Success { .. }));
    }

    // ── Scenario 3: ProcessSwap handoff ─────────────────────

    #[test]
    fn scenario_process_swap_handoff() {
        let state = b"application state snapshot";
        let report = execute_handoff("app", 1000, 1001, Some(state), 1, 5000);
        assert!(report.success);
        assert!(report.envelope_bytes > 0);

        // Also test the adapter
        let mut adapter = create_adapter_for_language("go").unwrap();
        adapter.initialize().unwrap();

        let req = AdapterReloadRequest {
            reload_id: "r-3".into(),
            module_id: "app".into(),
            changed_files: vec!["main.go".into()],
            build_manifest: test_manifest("/tmp/app_v2"),
            artifact_blob: None,
            capsule_metadata: None,
            firewall_evidence: Default::default(),
            preserve_state: false,
            timeout_ms: 5000,
        };
        let result = adapter.reload(&req);
        assert!(matches!(result, AdapterReloadResult::Success { .. }));
    }

    // ── Scenario 4: Registry has all expected adapters ──────

    #[test]
    fn scenario_registry_completeness() {
        let matrix = AdapterMatrix::default_matrix();
        let mut registry = AdapterRegistry::from_matrix(&matrix);

        // All languages from matrix should be present
        for lang in matrix.languages() {
            assert!(
                registry.get_info(lang).is_some(),
                "missing adapter for: {}",
                lang
            );
        }

        // Initialize all
        let results = registry.initialize_all();
        for (lang, result) in &results {
            assert!(
                result.is_ok(),
                "failed to init adapter for {}: {:?}",
                lang,
                result
            );
        }

        // Shutdown all
        let results = registry.shutdown_all();
        for (lang, result) in &results {
            assert!(
                result.is_ok(),
                "failed to shutdown adapter for {}: {:?}",
                lang,
                result
            );
        }
    }

    // ── Scenario 5: Handoff envelope integrity ──────────────

    #[test]
    fn scenario_envelope_integrity() {
        let payload = b"important state data".to_vec();
        let env = HandoffEnvelope::new("mod_a", 1, payload.clone(), 1000);

        // Valid
        assert!(env.validate().is_ok());

        // Tampered
        let mut tampered = env.clone();
        tampered.payload.push(0x42);
        assert!(tampered.validate().is_err());
    }
}
