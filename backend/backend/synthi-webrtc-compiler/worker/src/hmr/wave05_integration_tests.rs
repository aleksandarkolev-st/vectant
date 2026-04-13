// ============================================================
// WAVE 05 INTEGRATION TESTS
// ============================================================
// End-to-end scenarios testing the full dynamic library swap
// pipeline: eligibility → coordinator → slot → validate →
// rollback / promote.
// ============================================================


#[cfg(test)]
mod tests {
    use crate::hmr::dynlib_swap::{SwapCommand, SwapPhase};
    use crate::hmr::health_check::HealthCheckResult;
    use crate::hmr::hmr_eligibility::{check_hmr_eligibility, HmrEligibilityInput};
    use crate::hmr::hot_swap_coordinator::{
        HotSwapConfig, HotSwapOutcome, HotSwapTracker, PhaseTiming,
    };
    use crate::hmr::slot_manager::{LibSlot, SlotManager};
    use crate::hmr::swap_rollback::{plan_rollback, SwapRollbackReason};
    use crate::hmr::symbol_validation::validate_symbols;

    // ── Scenario 1 ─ Happy path: eligible → swap → promote ──────

    #[test]
    fn scenario_happy_path_swap() {
        // Step 1: Check eligibility
        let input = HmrEligibilityInput {
            language: "rust".to_string(),
            adapter_family: "DynamicLibrary".to_string(),
            capability_tier: 2,
            abi_version: "1.0".to_string(),
            has_snapshot_support: true,
            hmr_kill_switch: false,
            compile_error: false,
            preview_active: true,
        };
        let eligibility = check_hmr_eligibility(&input);
        assert!(eligibility.eligible, "Should be eligible for HMR");

        // Step 2: Validate symbols
        let exported = vec![
            "hmr_get_state_json".to_string(),
            "hmr_set_state_json".to_string(),
            "on_update".to_string(),
            "on_render".to_string(),
            "on_event".to_string(),
        ];
        let required = vec![
            "hmr_get_state_json".to_string(),
            "hmr_set_state_json".to_string(),
            "on_update".to_string(),
        ];
        let validation = validate_symbols(&exported, &required);
        assert!(validation.valid, "Symbol validation should pass");

        // Step 3: Slot management
        let mut sm = SlotManager::new();
        let standby = sm.prepare_standby("/tmp/new_lib.so".to_string());
        assert_eq!(standby.slot, LibSlot::Standby);

        // Step 4: Swap
        sm.swap();
        let primary = sm.primary();
        assert!(
            primary.lib_path.as_deref() == Some("/tmp/new_lib.so"),
            "After swap, primary should hold new lib"
        );

        // Step 5: Phase tracking
        let mut tracker = HotSwapTracker::new("gui_v1");
        tracker.advance(SwapPhase::Quiescing, 0);
        tracker.advance(SwapPhase::Snapshotting, 40);
        tracker.advance(SwapPhase::Swapping, 120);
        tracker.advance(SwapPhase::Restoring, 300);
        tracker.advance(SwapPhase::Resuming, 380);
        tracker.advance(SwapPhase::Completed, 390);
        assert_eq!(tracker.timing.quiesce_ms, 40);

        // Step 6: Build success outcome
        let timing = PhaseTiming {
            quiesce_ms: 40,
            snapshot_ms: 80,
            load_ms: 180,
            validate_ms: 10,
            restore_ms: 80,
            health_check_ms: 0,
            resume_ms: 10,
        };
        let outcome = HotSwapOutcome::success(
            "gui_v1".to_string(),
            validation,
            HealthCheckResult::Pass,
            timing,
        );
        assert!(outcome.success);
        assert!(!outcome.exceeds_warm_budget());
    }

    // ── Scenario 2 ─ Symbol validation failure → rollback ───────

    #[test]
    fn scenario_symbol_failure_rollback() {
        let exported = vec!["on_update".to_string()]; // missing state serialization
        let required = vec![
            "hmr_get_state_json".to_string(),
            "hmr_set_state_json".to_string(),
            "on_update".to_string(),
        ];
        let validation = validate_symbols(&exported, &required);
        assert!(!validation.valid);

        // Rollback because symbols are wrong
        let record = plan_rollback(
            "core_v1",
            SwapPhase::Swapping,
            SwapRollbackReason::SymbolValidationFailed {
                missing: validation.missing.clone(),
            },
            LibSlot::Primary,
            false,
        );
        assert!(record.is_clean());
        assert!(record.reason.is_permanent());
    }

    // ── Scenario 3 ─ Health check failure post-swap ─────────────

    #[test]
    fn scenario_health_check_failure() {
        let record = plan_rollback(
            "gui_v1",
            SwapPhase::Restoring,
            SwapRollbackReason::HealthCheckFailed {
                message: "render loop hung".to_string(),
            },
            LibSlot::Primary,
            true,
        );
        // Failed during Restoring — old lib not intact
        assert!(!record.is_clean());
        assert!(record.needs_restart());
        assert!(!record.reason.is_permanent()); // health failure is transient
    }

    // ── Scenario 4 ─ Kill switch blocks eligibility ─────────────

    #[test]
    fn scenario_kill_switch() {
        let input = HmrEligibilityInput {
            language: "rust".to_string(),
            adapter_family: "DynamicLibrary".to_string(),
            capability_tier: 2,
            abi_version: "1.0".to_string(),
            has_snapshot_support: true,
            hmr_kill_switch: true,
            compile_error: false,
            preview_active: true,
        };
        let eligibility = check_hmr_eligibility(&input);
        assert!(!eligibility.eligible);
        assert!(eligibility
            .reasons
            .iter()
            .any(|r| r.contains("kill switch")));
    }

    // ── Scenario 5 ─ SwapCommand round-trip ─────────────────────

    #[test]
    fn scenario_swap_command_serde() {
        let cmd = SwapCommand::Quiesce {
            timeout_ms: 500,
            module: "gui_v1".to_string(),
        };
        let json = serde_json::to_string(&cmd).expect("serialize");
        let back: SwapCommand = serde_json::from_str(&json).expect("deserialize");
        match back {
            SwapCommand::Quiesce { timeout_ms, module } => {
                assert_eq!(timeout_ms, 500);
                assert_eq!(module, "gui_v1");
            }
            _ => panic!("Wrong variant"),
        }
    }
}
