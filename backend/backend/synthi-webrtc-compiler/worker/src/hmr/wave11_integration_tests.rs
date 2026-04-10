// ============================================================
// WAVE 11 INTEGRATION TESTS — DynLib family deep-dive
// ============================================================
// End-to-end scenarios covering the DynLib adapter's full
// lifecycle: ABI contract → symbol resolve → preload validate →
// state bridge → crash isolation → metrics → rollback → language
// profiles.
// ============================================================


#[cfg(test)]
mod tests {
    use crate::hmr::dynlib_abi_contract::{
        canonical_abi_contract, validate_symbols_against_contract, AbiHeader,
    };
    use crate::hmr::dynlib_crash_isolation::{CrashGuard, CrashIsolationConfig, CrashKind};
    use crate::hmr::dynlib_language_profiles::{detect_language, profile_for, DynLibLanguage};
    use crate::hmr::dynlib_metrics::{DynLibMetrics, DynLibPhaseMetric};
    use crate::hmr::dynlib_preload_validator::{validate_preload, PreloadConfig};
    use crate::hmr::dynlib_rollback::{execute_rollback, FailurePhase, RollbackAction, RollbackConfig};
    use crate::hmr::dynlib_state_bridge::{
        DynLibStateBridge, StateCapabilities, StateBridgeConfig, StateFormat,
    };
    use crate::hmr::dynlib_symbol_resolver::resolve_symbols;

    // --------------------------------------------------------
    // Scenario 1: Full happy-path DynLib reload lifecycle
    // --------------------------------------------------------
    #[test]
    fn scenario_happy_path_dynlib_reload() {
        // 1. Detect language from changed files.
        let files = vec!["src/module.c".into(), "src/module.h".into()];
        let lang = detect_language(&files).unwrap();
        assert_eq!(lang, DynLibLanguage::C);

        let profile = profile_for(lang);
        assert!(!profile.needs_extern_c);

        // 2. Preload validation.
        let contract = canonical_abi_contract();
        let exports: Vec<String> = contract.required.iter().map(|s| s.name.clone()).collect();
        let result = validate_preload(
            "libmodule.so",
            4096,
            &exports,
            Some(&AbiHeader::CURRENT),
            &PreloadConfig::default(),
        );
        assert!(result.valid);

        // 3. Symbol resolution.
        let resolve = resolve_symbols(&exports);
        assert!(resolve.missing_required.is_empty());

        // 4. ABI contract validation.
        let abi_result = validate_symbols_against_contract(&exports, &contract);
        assert!(abi_result.valid);

        // 5. State bridge: export → import.
        let caps = StateCapabilities { json: true, binary: false };
        let bridge = DynLibStateBridge::new(StateBridgeConfig::default(), caps);
        let exported = bridge.export_state(b"game_state").unwrap();
        let imported = bridge.import_state(&exported).unwrap();
        assert!(imported.validated);

        // 6. Metrics.
        let mut metrics = DynLibMetrics::new();
        metrics.record(DynLibPhaseMetric::Load, 5.0, 1000);
        metrics.record(DynLibPhaseMetric::Swap, 2.0, 1010);
        metrics.record_reload(12.0, 1020, 1024);
        assert_eq!(metrics.reload_count, 1);
    }

    // --------------------------------------------------------
    // Scenario 2: Crash during health check → rollback
    // --------------------------------------------------------
    #[test]
    fn scenario_crash_then_rollback() {
        let mut guard = CrashGuard::new(CrashIsolationConfig::default());

        // Simulate health check crash.
        let crash = guard.guarded_call("hmr_on_render", Err(CrashKind::Segfault), 500, true);
        assert!(crash.is_err());

        // Rollback triggered at HealthCheck phase.
        let report = execute_rollback(
            FailurePhase::HealthCheck,
            true,
            &RollbackConfig::default(),
            8,
        );
        assert_eq!(report.action_taken, RollbackAction::RevertSlotAndRestoreState);
        assert!(report.state_restored);
    }

    // --------------------------------------------------------
    // Scenario 3: C++ module needing extern "C"
    // --------------------------------------------------------
    #[test]
    fn scenario_cpp_extern_c_requirement() {
        let profile = profile_for(DynLibLanguage::Cpp);
        assert!(profile.needs_extern_c);

        // Despite C++ mangling, HMR symbols are extern "C" so no mangling.
        let exports = vec![
            "hmr_get_abi_version".into(),
            "hmr_init".into(),
            "hmr_shutdown".into(),
            "hmr_on_update".into(),
            "hmr_on_render".into(),
        ];
        let contract = canonical_abi_contract();
        let abi = validate_symbols_against_contract(&exports, &contract);
        assert!(abi.valid, "C++ with extern C should pass ABI validation");
    }

    // --------------------------------------------------------
    // Scenario 4: Multiple crashes → permanent fault
    // --------------------------------------------------------
    #[test]
    fn scenario_permanent_fault_after_repeated_crashes() {
        let mut guard = CrashGuard::new(CrashIsolationConfig {
            max_consecutive_crashes: 3,
            ..Default::default()
        });

        for i in 0..3 {
            let _ = guard.guarded_call(
                "hmr_on_update",
                Err(CrashKind::Abort),
                100 * (i + 1) as u64,
                false,
            );
        }

        assert!(guard.is_faulted());
        assert_eq!(guard.total_crashes(), 3);

        // Any further call is rejected.
        let result = guard.guarded_call("hmr_on_update", Ok(0), 500, false);
        assert!(result.is_err());

        // Escalation: cold reload needed.
        let mut metrics = DynLibMetrics::new();
        metrics.record_failed_reload();
        assert_eq!(metrics.failed_reload_count, 1);
    }

    // --------------------------------------------------------
    // Scenario 5: Binary state preference over JSON
    // --------------------------------------------------------
    #[test]
    fn scenario_binary_state_preference() {
        let caps = StateCapabilities { json: true, binary: true };
        let bridge = DynLibStateBridge::new(StateBridgeConfig::default(), caps);

        assert_eq!(bridge.format(), Some(StateFormat::Binary));

        let exported = bridge.export_state(b"\x92\xa5hello\xa5world").unwrap();
        assert_eq!(exported.format, StateFormat::Binary);
    }
}
