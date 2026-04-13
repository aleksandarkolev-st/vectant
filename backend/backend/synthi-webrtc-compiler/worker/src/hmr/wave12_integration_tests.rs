// ============================================================
// WAVE 12 INTEGRATION TESTS — Managed & process-swap families,
// adapter lifecycle FSM, final summary
// ============================================================
// End-to-end scenarios covering the complete adapter ecosystem:
// managed agent protocol, JVM/CLR reload strategies, process
// swap handoff chain, and the unified lifecycle FSM.
// ============================================================


#[cfg(test)]
mod tests {
    use crate::hmr::adapter_lifecycle_fsm::{
        AdapterLifecycleFsm, AdapterLifecycleState, LifecycleEvent,
    };
    use crate::hmr::managed_agent_protocol::{
        validate_handshake, AgentCommand, AgentResponse, ProtocolFrame, AGENT_PROTOCOL_VERSION,
    };
    use crate::hmr::managed_classloader_strategy::{
        decide_jvm_strategy, ClassChange, ClassChangeKind, JvmReloadStrategy, JvmStrategyConfig,
    };
    use crate::hmr::managed_dotnet_reload::{
        decide_dotnet_strategy, AssemblyChange, AssemblyChangeKind, DotNetReloadStrategy,
        DotNetStrategyConfig,
    };
    use crate::hmr::managed_health_probe::{
        HealthProbeConfig, ManagedHealthProbe, ManagedHealthStatus, RuntimeMetrics,
    };
    use crate::hmr::process_swap_drain::{
        evaluate_drain, DrainConfig, DrainOutcome, DrainSnapshot,
    };
    use crate::hmr::process_swap_socket_handoff::{
        execute_socket_handoff, plan_socket_handoff, SocketDescriptor, SocketHandoffConfig,
        SocketKind,
    };
    use crate::hmr::process_swap_state_transfer::{
        execute_state_transfer, select_transport, StatePayload, StateTransferConfig,
        StateTransport,
    };

    // --------------------------------------------------------
    // Scenario 1: Full JVM hot-swap lifecycle
    // --------------------------------------------------------
    #[test]
    fn scenario_jvm_hotswap_lifecycle() {
        // 1. Validate protocol handshake.
        assert!(validate_handshake(AGENT_PROTOCOL_VERSION, AGENT_PROTOCOL_VERSION).is_ok());

        // 2. Body-only changes → HotSwap strategy.
        let changes = vec![
            ClassChange {
                class_name: "com.example.Service".into(),
                kind: ClassChangeKind::BodyOnly,
            },
            ClassChange {
                class_name: "com.example.Handler".into(),
                kind: ClassChangeKind::BodyOnly,
            },
        ];
        let decision = decide_jvm_strategy(&changes, &JvmStrategyConfig::default());
        assert_eq!(decision.strategy, JvmReloadStrategy::HotSwap);

        // 3. Health probe after reload.
        let mut probe = ManagedHealthProbe::new(HealthProbeConfig::default());
        let metrics = RuntimeMetrics {
            heap_used_bytes: 200 * 1024 * 1024,
            heap_max_bytes: 512 * 1024 * 1024,
            gc_pause_count: 0,
            gc_pause_total_ms: 0,
            thread_count: 25,
            ping_ok: true,
            ping_rtt_ms: 3,
        };
        let health = probe.evaluate(metrics);
        assert_eq!(health.status, ManagedHealthStatus::Healthy);

        // 4. FSM tracks the reload.
        let mut fsm = AdapterLifecycleFsm::new();
        fsm.apply(LifecycleEvent::Initialize, 100).unwrap();
        fsm.apply(LifecycleEvent::InitializeComplete, 200).unwrap();
        fsm.apply(LifecycleEvent::BeginReload, 300).unwrap();
        fsm.apply(LifecycleEvent::ReloadComplete, 400).unwrap();
        assert_eq!(fsm.state(), AdapterLifecycleState::Ready);
        assert_eq!(fsm.reload_count(), 1);
    }

    // --------------------------------------------------------
    // Scenario 2: .NET structural change → ALC reload
    // --------------------------------------------------------
    #[test]
    fn scenario_dotnet_structural_change() {
        let changes = vec![AssemblyChange {
            assembly_name: "MyApp.dll".into(),
            kind: AssemblyChangeKind::NewReference,
        }];
        let decision = decide_dotnet_strategy(&changes, &DotNetStrategyConfig::default());
        assert_eq!(decision.strategy, DotNetReloadStrategy::AssemblyContextReload);
    }

    // --------------------------------------------------------
    // Scenario 3: Process-swap with socket handoff + drain
    // --------------------------------------------------------
    #[test]
    fn scenario_process_swap_full_cycle() {
        // 1. Plan socket handoff.
        let sockets = vec![SocketDescriptor {
            id: "http".into(),
            bind_address: "0.0.0.0".into(),
            port: 8080,
            kind: SocketKind::Tcp,
        }];
        let plans = plan_socket_handoff(&sockets, &SocketHandoffConfig::default());
        assert_eq!(plans.len(), 1);

        // 2. Execute socket handoff.
        let handoff = execute_socket_handoff(&plans[0], 15, true);
        assert!(handoff.success);

        // 3. State transfer.
        let payload = StatePayload::from_bytes(b"app-state-v1".to_vec(), false);
        let transport = select_transport(payload.data.len(), &StateTransferConfig::default());
        assert_eq!(transport, StateTransport::StdioPipe);
        let transfer = execute_state_transfer(&payload, transport, 8);
        assert!(transfer.success);

        // 4. Drain old process.
        let snapshot = DrainSnapshot {
            initial_in_flight: 5,
            current_in_flight: 0,
            elapsed_ms: 300,
        };
        let drain = evaluate_drain(&snapshot, &DrainConfig::default());
        assert_eq!(drain.outcome, DrainOutcome::Completed);

        // 5. FSM tracks lifecycle.
        let mut fsm = AdapterLifecycleFsm::new();
        fsm.apply(LifecycleEvent::Initialize, 100).unwrap();
        fsm.apply(LifecycleEvent::InitializeComplete, 200).unwrap();
        fsm.apply(LifecycleEvent::BeginReload, 300).unwrap();
        fsm.apply(LifecycleEvent::ReloadComplete, 400).unwrap();
        assert_eq!(fsm.reload_count(), 1);
    }

    // --------------------------------------------------------
    // Scenario 4: Managed runtime fault → shutdown
    // --------------------------------------------------------
    #[test]
    fn scenario_managed_fault_to_shutdown() {
        let mut fsm = AdapterLifecycleFsm::new();
        fsm.apply(LifecycleEvent::Initialize, 100).unwrap();
        fsm.apply(LifecycleEvent::InitializeComplete, 200).unwrap();
        fsm.apply(LifecycleEvent::BeginReload, 300).unwrap();
        fsm.apply(LifecycleEvent::ReloadFailed, 400).unwrap();
        assert_eq!(fsm.state(), AdapterLifecycleState::Faulted);

        // Shutdown from faulted state.
        fsm.apply(LifecycleEvent::BeginShutdown, 500).unwrap();
        fsm.apply(LifecycleEvent::ShutdownComplete, 600).unwrap();
        assert_eq!(fsm.state(), AdapterLifecycleState::Terminated);
    }

    // --------------------------------------------------------
    // Scenario 5: Protocol frame serialization roundtrip
    // --------------------------------------------------------
    #[test]
    fn scenario_protocol_frame_roundtrip() {
        let cmd = AgentCommand::PrepareReload {
            reload_id: "r-001".into(),
            artifact_path: "/tmp/myapp.jar".into(),
            changed_classes: vec!["com.example.Foo".into()],
        };
        let frame = ProtocolFrame::command(1, cmd);
        let json = serde_json::to_string(&frame).unwrap();
        let parsed: ProtocolFrame = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.sequence, 1);

        let resp_frame = ProtocolFrame::response(
            1,
            AgentResponse::ReloadPrepared {
                reload_id: "r-001".into(),
                classes_affected: 1,
            },
        );
        let resp_json = serde_json::to_string(&resp_frame).unwrap();
        assert!(resp_json.contains("r-001"));
    }
}
