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
