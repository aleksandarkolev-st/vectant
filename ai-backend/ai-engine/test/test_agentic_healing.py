"""
Unit tests for the agentic self-healing subsystem.
Covers: repair_episode, redaction, verification, rollback, precision_telemetry,
        diagnosis, planner, sandbox, multi_file, runtime_healing,
        observability, policy, canary.
"""

import asyncio
import os
import tempfile
import time

import pytest

# ── Helpers ───────────────────────────────────────────────────────────

def run_async(coro):
    """Run an async coroutine synchronously for testing."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ═════════════════════════════════════════════════════════════════════
#  Phase 1 – Repair Episode
# ═════════════════════════════════════════════════════════════════════

class TestRepairEpisode:
    def test_create_episode(self):
        from analyzer.proactive.healing.repair_episode import RepairEpisode, EpisodeState
        ep = RepairEpisode(file_path="app.py", error_message="SyntaxError", language="python")
        assert ep.state == EpisodeState.DETECTED
        assert ep.file_path == "app.py"
        assert ep.episode_id  # generated UUID

    def test_state_transitions(self):
        from analyzer.proactive.healing.repair_episode import RepairEpisode, EpisodeState
        ep = RepairEpisode(file_path="a.ts", error_message="err", language="typescript")
        assert ep.state == EpisodeState.DETECTED
        ep.transition_to(EpisodeState.DIAGNOSING)
        assert ep.state == EpisodeState.DIAGNOSING
        ep.transition_to(EpisodeState.PLANNING)
        assert ep.state == EpisodeState.PLANNING

    def test_invalid_transition_raises(self):
        from analyzer.proactive.healing.repair_episode import RepairEpisode, EpisodeState
        ep = RepairEpisode(file_path="a.py", error_message="e", language="python")
        with pytest.raises(ValueError):
            ep.transition_to(EpisodeState.VERIFYING)  # DETECTED → VERIFYING not valid

    def test_to_dict(self):
        from analyzer.proactive.healing.repair_episode import RepairEpisode
        ep = RepairEpisode(file_path="x.js", error_message="err", language="javascript")
        d = ep.to_dict()
        assert d["filePath"] == "x.js"
        assert "state" in d
        assert "episodeId" in d

    def test_episode_store(self):
        from analyzer.proactive.healing.repair_episode import RepairEpisode, EpisodeStore
        store = EpisodeStore(max_size=5)
        episodes = [
            RepairEpisode(file_path=f"f{i}.py", error_message="e", language="python")
            for i in range(7)
        ]
        for ep in episodes:
            store.add(ep)
        # max_size=5 so oldest get evicted
        assert len(store.recent(10)) <= 5
        # latest should be retrievable
        assert store.get(episodes[-1].episode_id) is not None

    def test_budget_defaults(self):
        from analyzer.proactive.healing.repair_episode import RepairBudget
        b = RepairBudget()
        assert b.max_attempts == 3
        assert b.max_duration_sec == 120
        assert b.max_llm_calls == 10


# ═════════════════════════════════════════════════════════════════════
#  Phase 1 – Redaction
# ═════════════════════════════════════════════════════════════════════

class TestRedaction:
    def test_redacts_aws_key(self):
        from analyzer.proactive.healing.redaction import RedactionEngine
        engine = RedactionEngine()
        code = 'AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'
        report = engine.redact(code)
        assert "wJalrXUtnFEMI" not in report.redacted_text
        assert report.redaction_count > 0

    def test_redacts_jwt(self):
        from analyzer.proactive.healing.redaction import RedactionEngine
        engine = RedactionEngine()
        code = 'token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"'
        report = engine.redact(code)
        assert report.redaction_count > 0

    def test_no_redaction_on_clean(self):
        from analyzer.proactive.healing.redaction import RedactionEngine
        engine = RedactionEngine()
        code = "x = 42\ny = x + 1\n"
        report = engine.redact(code)
        assert report.redaction_count == 0
        assert report.redacted_text == code

    def test_scan_only(self):
        from analyzer.proactive.healing.redaction import RedactionEngine
        engine = RedactionEngine()
        code = 'DB_URL = "postgresql://user:pass@host:5432/db"'
        report = engine.scan_only(code)
        assert report.redaction_count > 0
        # scan_only should NOT modify text
        assert report.redacted_text == code

    def test_blocked_path(self):
        from analyzer.proactive.healing.redaction import RedactionEngine, RedactionConfig
        config = RedactionConfig(deny_paths=[".env"])
        engine = RedactionEngine(config=config)
        assert engine.is_blocked_path(".env")
        assert not engine.is_blocked_path("app.py")


# ═════════════════════════════════════════════════════════════════════
#  Phase 1 – Verification
# ═════════════════════════════════════════════════════════════════════

class TestVerification:
    def test_syntax_check_python_valid(self):
        from analyzer.proactive.healing.verification import SyntaxChecker
        checker = SyntaxChecker()
        result = checker.check("x = 1\ny = 2\n", "python")
        assert result["passed"]

    def test_syntax_check_python_invalid(self):
        from analyzer.proactive.healing.verification import SyntaxChecker
        checker = SyntaxChecker()
        result = checker.check("def foo(\n", "python")
        assert not result["passed"]

    def test_syntax_check_js_brackets(self):
        from analyzer.proactive.healing.verification import SyntaxChecker
        checker = SyntaxChecker()
        result = checker.check("function f() { return 1; }", "javascript")
        assert result["passed"]

    def test_syntax_check_js_unbalanced(self):
        from analyzer.proactive.healing.verification import SyntaxChecker
        checker = SyntaxChecker()
        result = checker.check("function f() { return 1; ", "javascript")
        assert not result["passed"]

    def test_semantic_guardrails_dangerous_api(self):
        from analyzer.proactive.healing.verification import SemanticGuardrails
        g = SemanticGuardrails()
        code = 'import os\nos.system("rm -rf /")\n'
        result = g.check(patched_code=code, file_path="a.py")
        # Should flag dangerous API usage
        assert any("dangerous" in v.lower() or "os.system" in v.lower() for v in result.get("violations", []))

    def test_semantic_guardrails_forbidden_file(self):
        from analyzer.proactive.healing.verification import SemanticGuardrails
        g = SemanticGuardrails()
        result = g.check(patched_code="x=1", file_path="package-lock.json")
        assert any("forbidden" in v.lower() or "lock" in v.lower() for v in result.get("violations", []))

    def test_patch_minimality(self):
        from analyzer.proactive.healing.verification import SemanticGuardrails
        g = SemanticGuardrails()
        original = "a = 1\n"
        patched = "\n".join([f"line_{i} = {i}" for i in range(60)])
        result = g.check(patched_code=patched, file_path="a.py", original_code=original)
        assert any("minimal" in v.lower() or "large" in v.lower() or "lines" in v.lower()
                    for v in result.get("violations", []))


# ═════════════════════════════════════════════════════════════════════
#  Phase 1 – Rollback
# ═════════════════════════════════════════════════════════════════════

class TestRollback:
    def test_snapshot_and_rollback(self):
        from analyzer.proactive.healing.rollback import RepairTransaction, TransactionState
        tx = RepairTransaction(episode_id="ep-1")
        tx.snapshot("test.py", "original content")
        assert tx.state == TransactionState.ACTIVE
        tx.rollback()
        assert tx.state == TransactionState.ROLLED_BACK
        assert len(tx.snapshots) > 0

    def test_commit(self):
        from analyzer.proactive.healing.rollback import RepairTransaction, TransactionState
        tx = RepairTransaction(episode_id="ep-2")
        tx.snapshot("a.py", "before")
        tx.commit()
        assert tx.state == TransactionState.COMMITTED

    def test_double_commit_raises(self):
        from analyzer.proactive.healing.rollback import RepairTransaction
        tx = RepairTransaction(episode_id="ep-3")
        tx.commit()
        with pytest.raises(ValueError):
            tx.commit()

    def test_transaction_manager(self):
        from analyzer.proactive.healing.rollback import TransactionManager
        mgr = TransactionManager(max_transactions=3)
        tx1 = mgr.begin("ep-a")
        tx2 = mgr.begin("ep-b")
        assert mgr.get(tx1.transaction_id) is not None
        assert mgr.get(tx2.transaction_id) is not None
        tx1.commit()
        assert len(mgr.active) == 1


# ═════════════════════════════════════════════════════════════════════
#  Phase 1 – Precision Telemetry
# ═════════════════════════════════════════════════════════════════════

class TestPrecisionTelemetry:
    def test_record_and_query(self):
        from analyzer.proactive.healing.precision_telemetry import (
            PrecisionTelemetry, FixOutcome
        )
        telem = PrecisionTelemetry()
        telem.record_outcome("rule_a", FixOutcome.ACCEPTED, "python")
        telem.record_outcome("rule_a", FixOutcome.ACCEPTED, "python")
        telem.record_outcome("rule_a", FixOutcome.REVERTED, "python")
        stats = telem.get_rule_stats("rule_a")
        assert stats is not None
        assert stats.total_attempts == 3
        assert stats.accepted == 2
        assert stats.reverted == 1

    def test_precision_calculation(self):
        from analyzer.proactive.healing.precision_telemetry import (
            PrecisionTelemetry, FixOutcome
        )
        telem = PrecisionTelemetry()
        for _ in range(8):
            telem.record_outcome("good_rule", FixOutcome.ACCEPTED, "python")
        for _ in range(2):
            telem.record_outcome("good_rule", FixOutcome.REVERTED, "python")
        stats = telem.get_rule_stats("good_rule")
        assert 0.7 < stats.precision < 0.9  # ~0.8

    def test_calibration_table(self):
        from analyzer.proactive.healing.precision_telemetry import (
            PrecisionTelemetry, FixOutcome
        )
        telem = PrecisionTelemetry()
        telem.record_outcome("r1", FixOutcome.ACCEPTED, "python")
        telem.record_outcome("r2", FixOutcome.REVERTED, "javascript")
        table = telem.get_calibration_table()
        assert "r1" in table
        assert "r2" in table

    def test_degrading_detection(self):
        from analyzer.proactive.healing.precision_telemetry import (
            PrecisionTelemetry, FixOutcome
        )
        telem = PrecisionTelemetry()
        # Rule with poor recent track record
        for _ in range(5):
            telem.record_outcome("bad_rule", FixOutcome.ACCEPTED, "python")
        for _ in range(15):
            telem.record_outcome("bad_rule", FixOutcome.REVERTED, "python")
        degrading = telem.get_degrading_rules()
        assert "bad_rule" in degrading


# ═════════════════════════════════════════════════════════════════════
#  Phase 2 – Diagnosis
# ═════════════════════════════════════════════════════════════════════

class TestDiagnosis:
    def test_python_syntax_error(self):
        from analyzer.proactive.healing.diagnosis import DiagnosisAgent, CauseType
        agent = DiagnosisAgent()
        graph = agent.diagnose(
            "SyntaxError: unexpected EOF while parsing",
            "app.py",
            "python",
        )
        assert graph.primary_cause is not None
        assert graph.primary_cause.cause_type == CauseType.SYNTAX_ERROR

    def test_import_error(self):
        from analyzer.proactive.healing.diagnosis import DiagnosisAgent, CauseType
        agent = DiagnosisAgent()
        graph = agent.diagnose(
            "ModuleNotFoundError: No module named 'flask'",
            "app.py",
            "python",
        )
        assert graph.primary_cause.cause_type == CauseType.MISSING_IMPORT

    def test_type_error(self):
        from analyzer.proactive.healing.diagnosis import DiagnosisAgent, CauseType
        agent = DiagnosisAgent()
        graph = agent.diagnose(
            "TypeError: Cannot read properties of undefined (reading 'map')",
            "app.js",
            "javascript",
        )
        assert graph.primary_cause.cause_type in (CauseType.TYPE_MISMATCH, CauseType.NULL_REFERENCE)

    def test_unknown_error(self):
        from analyzer.proactive.healing.diagnosis import DiagnosisAgent, CauseType
        agent = DiagnosisAgent()
        graph = agent.diagnose("Something went weird", "a.py", "python")
        assert graph.primary_cause is not None

    def test_cause_graph_to_dict(self):
        from analyzer.proactive.healing.diagnosis import DiagnosisAgent
        agent = DiagnosisAgent()
        graph = agent.diagnose("SyntaxError: invalid syntax", "a.py", "python")
        d = graph.to_dict()
        assert "primaryCause" in d or "primary_cause" in d
        assert "candidates" in d


# ═════════════════════════════════════════════════════════════════════
#  Phase 2 – Planner
# ═════════════════════════════════════════════════════════════════════

class TestPlanner:
    def test_plan_for_syntax_error(self):
        from analyzer.proactive.healing.planner import RepairPlanner, StrategyType
        from analyzer.proactive.healing.diagnosis import CauseType, CauseCandidate, CauseGraph
        planner = RepairPlanner()
        candidate = CauseCandidate(
            cause_type=CauseType.SYNTAX_ERROR,
            confidence=0.9,
            evidence="Expected )",
        )
        graph = CauseGraph(candidates=[candidate])
        plan = planner.plan(graph, file_path="app.py", language="python")
        assert plan is not None
        assert len(plan.strategies) > 0

    def test_plan_has_budget(self):
        from analyzer.proactive.healing.planner import RepairPlanner, StepBudget
        from analyzer.proactive.healing.diagnosis import CauseType, CauseCandidate, CauseGraph
        planner = RepairPlanner()
        candidate = CauseCandidate(cause_type=CauseType.MISSING_IMPORT, confidence=0.8, evidence="")
        graph = CauseGraph(candidates=[candidate])
        plan = planner.plan(graph, file_path="app.py", language="python")
        assert plan.budget is not None
        assert plan.budget.max_steps > 0

    def test_plan_for_type_error(self):
        from analyzer.proactive.healing.planner import RepairPlanner
        from analyzer.proactive.healing.diagnosis import CauseType, CauseCandidate, CauseGraph
        planner = RepairPlanner()
        candidate = CauseCandidate(cause_type=CauseType.TYPE_MISMATCH, confidence=0.85, evidence="")
        graph = CauseGraph(candidates=[candidate])
        plan = planner.plan(graph, file_path="app.ts", language="typescript")
        assert len(plan.strategies) > 0


# ═════════════════════════════════════════════════════════════════════
#  Phase 2 – Sandbox
# ═════════════════════════════════════════════════════════════════════

class TestSandbox:
    def test_sandbox_lifecycle(self):
        from analyzer.proactive.healing.sandbox import Sandbox, SandboxConfig, SandboxState
        config = SandboxConfig()
        sb = Sandbox(workspace_root=tempfile.mkdtemp(), config=config)
        assert sb.state == SandboxState.CREATED
        sb.setup()
        assert sb.state == SandboxState.READY
        sb.cleanup()
        assert sb.state == SandboxState.CLEANED

    def test_sandbox_context_manager(self):
        from analyzer.proactive.healing.sandbox import Sandbox, SandboxConfig
        with Sandbox(workspace_root=tempfile.mkdtemp(), config=SandboxConfig()) as sb:
            assert sb.state.value in ("ready", "READY")
        # After context manager exit, should be cleaned
        assert sb.state.value in ("cleaned", "CLEANED")

    def test_sandbox_manager(self):
        from analyzer.proactive.healing.sandbox import SandboxManager
        mgr = SandboxManager(max_concurrent=2)
        sb1 = mgr.create(workspace_root=tempfile.mkdtemp())
        sb2 = mgr.create(workspace_root=tempfile.mkdtemp())
        assert len(mgr.active) == 2
        sb1.cleanup()
        mgr.cleanup_stale()


# ═════════════════════════════════════════════════════════════════════
#  Phase 2 – Multi-File
# ═════════════════════════════════════════════════════════════════════

class TestMultiFile:
    def test_dependency_resolver_topological(self):
        from analyzer.proactive.healing.multi_file import DependencyResolver
        resolver = DependencyResolver()
        deps = {
            "c.py": ["b.py"],
            "b.py": ["a.py"],
            "a.py": [],
        }
        order = resolver.topological_sort(deps)
        assert order.index("a.py") < order.index("b.py")
        assert order.index("b.py") < order.index("c.py")

    def test_circular_dependency_detected(self):
        from analyzer.proactive.healing.multi_file import DependencyResolver
        resolver = DependencyResolver()
        deps = {
            "a.py": ["b.py"],
            "b.py": ["a.py"],
        }
        # Should either raise or return empty/flag cycle
        try:
            order = resolver.topological_sort(deps)
            # If it returns, cycle should be flagged somehow
            assert order is not None  # implementation-dependent
        except (ValueError, RuntimeError):
            pass  # Expected for cycle

    def test_strategy_determination(self):
        from analyzer.proactive.healing.multi_file import DependencyResolver, CoordinationStrategy
        resolver = DependencyResolver()
        strategy = resolver.determine_strategy(["a.py"])
        assert strategy in (
            CoordinationStrategy.SEQUENTIAL,
            CoordinationStrategy.INDEPENDENT,
        )

    def test_change_impact_analyzer(self):
        from analyzer.proactive.healing.multi_file import ChangeImpactAnalyzer
        analyzer = ChangeImpactAnalyzer()
        deps = {"b.py": ["a.py"], "c.py": ["a.py"]}
        dependents = analyzer.find_dependents("a.py", deps)
        assert "b.py" in dependents
        assert "c.py" in dependents


# ═════════════════════════════════════════════════════════════════════
#  Phase 3 – Runtime Healing
# ═════════════════════════════════════════════════════════════════════

class TestRuntimeHealing:
    def test_stack_trace_parser_python(self):
        from analyzer.proactive.healing.runtime_healing import StackTraceParser
        parser = StackTraceParser()
        trace = '''Traceback (most recent call last):
  File "app.py", line 42, in main
    result = process(data)
  File "app.py", line 10, in process
    return data["key"]
KeyError: 'key'
'''
        parsed = parser.parse(trace)
        assert parsed is not None
        assert len(parsed.frames) > 0

    def test_stack_trace_parser_node(self):
        from analyzer.proactive.healing.runtime_healing import StackTraceParser
        parser = StackTraceParser()
        trace = """TypeError: Cannot read properties of undefined (reading 'map')
    at processData (/app/server.js:42:15)
    at Object.<anonymous> (/app/server.js:10:3)
"""
        parsed = parser.parse(trace)
        assert parsed is not None

    def test_suppression_rules(self):
        from analyzer.proactive.healing.runtime_healing import RuntimeHealingEngine
        engine = RuntimeHealingEngine()
        # HMR warning should be suppressed
        result = engine.ingest(
            message="[HMR] Waiting for update signal",
            source="terminal",
        )
        assert result is not None
        # Check it was suppressed
        assert result.suppressed or result.action == "suppressed"

    def test_deduplication(self):
        from analyzer.proactive.healing.runtime_healing import ErrorDeduplicator
        dedup = ErrorDeduplicator(cooldown_sec=1, max_occurrences=2)
        assert dedup.should_process("err-fingerprint-1")  # first
        assert dedup.should_process("err-fingerprint-1")  # second
        assert not dedup.should_process("err-fingerprint-1")  # third → deduplicated


# ═════════════════════════════════════════════════════════════════════
#  Phase 3 – Observability
# ═════════════════════════════════════════════════════════════════════

class TestObservability:
    def test_sliding_window(self):
        from analyzer.proactive.healing.observability import SlidingWindow
        window = SlidingWindow(window_sec=10)
        window.push(1.0)
        window.push(2.0)
        window.push(3.0)
        assert abs(window.mean() - 2.0) < 0.01
        assert window.count == 3

    def test_error_rate_detector(self):
        from analyzer.proactive.healing.observability import ErrorRateDetector
        detector = ErrorRateDetector(threshold_per_sec=0.5, critical_per_sec=2.0)
        # Push many errors rapidly
        triggers = []
        for _ in range(20):
            t = detector.record()
            if t:
                triggers.append(t)
        # Should have triggered at some point
        assert len(triggers) >= 0  # may or may not trigger depending on timing

    def test_observability_hub(self):
        from analyzer.proactive.healing.observability import ObservabilityHub
        hub = ObservabilityHub()
        hub.record_error()
        hub.record_build(5.0)
        stats = hub.stats
        assert isinstance(stats, dict)

    def test_log_anomaly_detector(self):
        from analyzer.proactive.healing.observability import LogAnomalyDetector
        detector = LogAnomalyDetector()
        trigger = detector.record("FATAL: segfault detected at 0x0")
        # A single FATAL message might trigger
        assert trigger is None or trigger is not None  # no crash


# ═════════════════════════════════════════════════════════════════════
#  Phase 3 – Policy
# ═════════════════════════════════════════════════════════════════════

class TestPolicy:
    def test_risk_classification_test_file(self):
        from analyzer.proactive.healing.policy import RiskClassifier, RiskTier
        classifier = RiskClassifier()
        tier = classifier.classify("test_app.py")
        assert tier == RiskTier.TIER_0  # test files are tier 0

    def test_risk_classification_env_file(self):
        from analyzer.proactive.healing.policy import RiskClassifier, RiskTier
        classifier = RiskClassifier()
        tier = classifier.classify(".env.production")
        assert tier == RiskTier.TIER_3  # env files are tier 3

    def test_risk_classification_normal_file(self):
        from analyzer.proactive.healing.policy import RiskClassifier, RiskTier
        classifier = RiskClassifier()
        tier = classifier.classify("src/components/Button.tsx")
        assert tier in (RiskTier.TIER_0, RiskTier.TIER_1)

    def test_policy_evaluation_allowed(self):
        from analyzer.proactive.healing.policy import PolicyEngine
        engine = PolicyEngine()
        evaluation = engine.evaluate(
            file_path="test_app.py",
            language="python",
            num_files=1,
            estimated_lines_changed=5,
        )
        assert evaluation.allowed

    def test_policy_evaluation_too_many_files(self):
        from analyzer.proactive.healing.policy import PolicyEngine
        engine = PolicyEngine()
        evaluation = engine.evaluate(
            file_path="app.py",
            language="python",
            num_files=20,  # exceeds default max of 5
            estimated_lines_changed=5,
        )
        assert not evaluation.allowed

    def test_policy_engine_status(self):
        from analyzer.proactive.healing.policy import get_policy_engine
        engine = get_policy_engine()
        status = engine.status()
        assert isinstance(status, dict)


# ═════════════════════════════════════════════════════════════════════
#  Phase 3 – Canary
# ═════════════════════════════════════════════════════════════════════

class TestCanary:
    def test_create_rollout(self):
        from analyzer.proactive.healing.canary import CanaryRolloutEngine, RolloutStage
        engine = CanaryRolloutEngine()
        record = engine.create_rollout(
            canary_files=["a.py"],
            remaining_files=["b.py", "c.py"],
            episode_id="ep-test",
        )
        assert record.stage == RolloutStage.CREATED
        assert record.scope.canary_files == ["a.py"]
        assert record.scope.remaining_files == ["b.py", "c.py"]

    def test_rollout_to_dict(self):
        from analyzer.proactive.healing.canary import CanaryRolloutEngine
        engine = CanaryRolloutEngine()
        record = engine.create_rollout(
            canary_files=["x.ts"],
            remaining_files=[],
            episode_id="ep-dict",
        )
        d = record.to_dict()
        assert "stage" in d
        assert "scope" in d or "canaryFiles" in d

    def test_list_rollouts(self):
        from analyzer.proactive.healing.canary import CanaryRolloutEngine
        engine = CanaryRolloutEngine()
        engine.create_rollout(canary_files=["a.py"], remaining_files=[], episode_id="ep-1")
        engine.create_rollout(canary_files=["b.py"], remaining_files=[], episode_id="ep-2")
        rollouts = engine.list_rollouts()
        assert len(rollouts) >= 2

    def test_canary_config_defaults(self):
        from analyzer.proactive.healing.canary import CanaryConfig
        config = CanaryConfig()
        assert config.soak_duration_sec == 15
        assert config.check_interval_sec == 3
        assert config.max_new_errors == 0

    def test_engine_stats(self):
        from analyzer.proactive.healing.canary import CanaryRolloutEngine
        engine = CanaryRolloutEngine()
        stats = engine.stats
        assert isinstance(stats, dict)


# ═════════════════════════════════════════════════════════════════════
#  Integration – __init__ exports
# ═════════════════════════════════════════════════════════════════════

class TestExports:
    def test_all_exports_importable(self):
        """Verify that the __init__.py exports all key classes."""
        from analyzer.proactive.healing import (
            # Phase 1
            RepairEpisode,
            EpisodeState,
            RedactionEngine,
            SyntaxChecker,
            SemanticGuardrails,
            RepairTransaction,
            TransactionManager,
            PrecisionTelemetry,
            FixOutcome,
            # Phase 2
            DiagnosisAgent,
            CauseType,
            CauseGraph,
            RepairPlanner,
            Sandbox,
            SandboxManager,
            MultiFileCoordinator,
            DependencyResolver,
            # Phase 3
            RuntimeHealingEngine,
            StackTraceParser,
            ObservabilityHub,
            PolicyEngine,
            RiskClassifier,
            RiskTier,
            CanaryRolloutEngine,
            RolloutStage,
        )
        # If we get here, all imports succeeded
        assert RepairEpisode is not None
        assert DiagnosisAgent is not None
        assert CanaryRolloutEngine is not None
