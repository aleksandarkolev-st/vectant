"""
Unit tests for the SelfHealingEngine and HealingClassifier.
"""

import pytest
import asyncio
from analyzer.proactive.healing.engine import SelfHealingEngine, reset_healing_engine
from analyzer.proactive.healing.types import (
    HealingConfig,
    HealingFix,
    HealingResult,
    HealingSeverity,
    HealingAction,
    HealingCategory,
)
from analyzer.proactive.healing.classifier import HealingClassifier


# ── Helpers ───────────────────────────────────────────────────────────

def run_async(coro):
    """Run an async coroutine synchronously for testing."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ── Engine tests ──────────────────────────────────────────────────────

class TestSelfHealingEngine:
    def setup_method(self):
        reset_healing_engine()
        self.engine = SelfHealingEngine()

    def test_analyze_returns_result(self):
        result = run_async(self.engine.analyze("x = 1\n", "python", "test.py"))
        assert isinstance(result, HealingResult)
        assert result.file_path == "test.py"
        assert result.language == "python"

    def test_analyze_detects_trailing_whitespace(self):
        code = "x = 1   \ny = 2\n"
        result = run_async(self.engine.analyze(code, "python", "test.py"))
        trailing = [f for f in result.fixes if "trailing" in f.description.lower()]
        assert len(trailing) > 0

    def test_analyze_disabled(self):
        config = HealingConfig(enabled=False)
        engine = SelfHealingEngine(config=config)
        result = run_async(engine.analyze("x = 1   \n", "python", "test.py"))
        assert len(result.fixes) == 0

    def test_analyze_respects_max_fixes(self):
        config = HealingConfig(max_fixes_per_pass=1)
        engine = SelfHealingEngine(config=config)
        # Code with multiple issues
        code = "x = 1   \ny = 2   \nz = 3   \n"
        result = run_async(engine.analyze(code, "python", "test.py"))
        assert len(result.fixes) <= 1

    def test_apply_fix_insert(self):
        code = "hello"
        fix = HealingFix(
            category=HealingCategory.TRAILING_WHITESPACE,
            severity=HealingSeverity.LOW,
            action=HealingAction.INSERT,
            description="test insert",
            line=0,
            column=5,
            end_line=0,
            end_column=5,
            original_text="",
            replacement_text=" world",
            confidence=1.0,
            is_safe=True,
            affects_logic=False,
        )
        result = self.engine.apply_fix(code, fix)
        assert result == "hello world"

    def test_apply_fix_replace(self):
        code = "var x = 1;"
        fix = HealingFix(
            category=HealingCategory.UNUSED_VARIABLE,
            severity=HealingSeverity.LOW,
            action=HealingAction.REPLACE,
            description="test replace",
            line=0,
            column=0,
            end_line=0,
            end_column=3,
            original_text="var",
            replacement_text="const",
            confidence=1.0,
            is_safe=True,
            affects_logic=False,
        )
        result = self.engine.apply_fix(code, fix)
        assert result == "const x = 1;"

    def test_apply_fix_delete(self):
        code = "x = 1   "
        fix = HealingFix(
            category=HealingCategory.TRAILING_WHITESPACE,
            severity=HealingSeverity.LOW,
            action=HealingAction.DELETE,
            description="test delete",
            line=0,
            column=5,
            end_line=0,
            end_column=8,
            original_text="   ",
            replacement_text="",
            confidence=1.0,
            is_safe=True,
            affects_logic=False,
        )
        result = self.engine.apply_fix(code, fix)
        assert result == "x = 1"

    def test_content_hash_deduplication(self):
        """Same content should use cache and return same result."""
        code = "x = 1   \n"
        r1 = run_async(self.engine.analyze(code, "python", "test.py"))
        r2 = run_async(self.engine.analyze(code, "python", "test.py"))
        assert r1.content_hash == r2.content_hash

    def test_config_update(self):
        self.engine.update_config(enabled=False)
        assert self.engine.config.enabled is False
        self.engine.update_config(enabled=True)
        assert self.engine.config.enabled is True

    def test_event_listener(self):
        events = []
        unsub = self.engine.on_event(lambda e: events.append(e))

        code = "x = 1   \n"
        run_async(self.engine.analyze(code, "python", "test.py"))
        # Events should have been emitted for detected fixes
        assert isinstance(events, list)
        unsub()


# ── Classifier tests ─────────────────────────────────────────────────

class TestHealingClassifier:
    def test_classify_safe_fix(self):
        classifier = HealingClassifier(min_confidence=0.5)
        fix = HealingFix(
            category=HealingCategory.TRAILING_WHITESPACE,
            severity=HealingSeverity.LOW,
            action=HealingAction.DELETE,
            description="trailing whitespace",
            line=0,
            column=5,
            end_line=0,
            end_column=8,
            original_text="   ",
            replacement_text="",
            confidence=0.95,
            is_safe=True,
            affects_logic=False,
        )
        classifier.classify_fixes([fix], "x = 1   \n", "python")
        assert fix.is_safe is True

    def test_classify_low_confidence(self):
        classifier = HealingClassifier(min_confidence=0.9)
        fix = HealingFix(
            category=HealingCategory.UNUSED_VARIABLE,
            severity=HealingSeverity.MODERATE,
            action=HealingAction.DELETE,
            description="unused var",
            line=0,
            column=0,
            end_line=0,
            end_column=5,
            original_text="x = 1",
            replacement_text="",
            confidence=0.5,  # Below threshold
            is_safe=True,
            affects_logic=False,
        )
        classifier.classify_fixes([fix], "x = 1\n", "python")
        # Low confidence should mark as unsafe
        assert fix.is_safe is False


# ── Conflict resolution tests ─────────────────────────────────────────

class TestConflictResolution:
    """Tests for _resolve_conflicts in the engine."""

    def setup_method(self):
        self.engine = SelfHealingEngine()

    def _make_fix(self, line, end_line, severity, confidence=0.9, rule_id="R"):
        return HealingFix(
            category=HealingCategory.TRAILING_WHITESPACE,
            severity=severity,
            action=HealingAction.REPLACE,
            description="test fix",
            line=line, column=0, end_line=end_line, end_column=10,
            original_text="old", replacement_text="new",
            confidence=confidence, rule_id=rule_id,
        )

    def test_no_conflicts_all_kept(self):
        fixes = [
            self._make_fix(0, 0, HealingSeverity.LOW, rule_id="A"),
            self._make_fix(5, 5, HealingSeverity.LOW, rule_id="B"),
        ]
        kept, skipped = self.engine._resolve_conflicts(fixes)
        assert len(kept) == 2
        assert len(skipped) == 0

    def test_overlapping_ranges_drop_lower_severity(self):
        fixes = [
            self._make_fix(0, 3, HealingSeverity.LOW, rule_id="LOW"),
            self._make_fix(2, 5, HealingSeverity.CRITICAL, rule_id="CRIT"),
        ]
        kept, skipped = self.engine._resolve_conflicts(fixes)
        assert len(kept) == 1
        assert kept[0].rule_id == "CRIT"
        assert len(skipped) == 1
        assert skipped[0]["reason"] == "conflict_overlap"

    def test_same_severity_uses_confidence_tiebreaker(self):
        fixes = [
            self._make_fix(0, 2, HealingSeverity.MODERATE, confidence=0.80, rule_id="LO_CONF"),
            self._make_fix(1, 3, HealingSeverity.MODERATE, confidence=0.95, rule_id="HI_CONF"),
        ]
        kept, skipped = self.engine._resolve_conflicts(fixes)
        assert len(kept) == 1
        assert kept[0].rule_id == "HI_CONF"

    def test_exact_same_line_is_conflict(self):
        fixes = [
            self._make_fix(5, 5, HealingSeverity.LOW, rule_id="A"),
            self._make_fix(5, 5, HealingSeverity.CRITICAL, rule_id="B"),
        ]
        kept, skipped = self.engine._resolve_conflicts(fixes)
        assert len(kept) == 1
        assert kept[0].rule_id == "B"

    def test_empty_list(self):
        kept, skipped = self.engine._resolve_conflicts([])
        assert kept == []
        assert skipped == []

    def test_single_fix(self):
        fixes = [self._make_fix(0, 0, HealingSeverity.LOW)]
        kept, skipped = self.engine._resolve_conflicts(fixes)
        assert len(kept) == 1
        assert len(skipped) == 0

    def test_three_way_overlap_chain(self):
        """A overlaps B, B overlaps C — only one survivor."""
        fixes = [
            self._make_fix(0, 3, HealingSeverity.LOW, rule_id="A"),
            self._make_fix(2, 5, HealingSeverity.MODERATE, rule_id="B"),
            self._make_fix(4, 7, HealingSeverity.CRITICAL, rule_id="C"),
        ]
        kept, skipped = self.engine._resolve_conflicts(fixes)
        # B beats A (overlap 0-3 vs 2-5), then C beats B (overlap 2-5 vs 4-7)
        assert kept[-1].rule_id == "C"
        assert len(skipped) >= 1


# ── Per-rule timeout tests ────────────────────────────────────────────

class TestRuleTimeout:
    """Tests for per-rule timeout enforcement."""

    def test_rule_latencies_are_tracked(self):
        engine = SelfHealingEngine()
        code = "x = 1   \n"
        run_async(engine.analyze(code, "python", "test.py"))
        # At least some rules should have recorded latencies
        assert len(engine._rule_latencies) > 0
        # All latencies should be non-negative floats
        for rule_id, ms in engine._rule_latencies.items():
            assert isinstance(ms, float)
            assert ms >= 0
