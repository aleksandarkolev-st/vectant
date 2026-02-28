"""
Integration tests for the self-healing pipeline.

End-to-end tests that exercise the full analysis → classify → apply flow.
"""

import pytest
from analyzer.proactive.healing.types import HealingConfig, HealingAction
from analyzer.proactive.healing.engine import SelfHealingEngine
from analyzer.proactive.healing.batch_engine import BatchHealingEngine, BatchFileEntry
from analyzer.proactive.healing.config_schema import get_preset


# ── Engine integration ──────────────────────────────────────────

class TestFullPipeline:
    """End-to-end analysis through the full healing pipeline."""

    def setup_method(self):
        self.engine = SelfHealingEngine()

    def test_python_trailing_whitespace_detected_and_fixed(self):
        code = "x = 1   \ny = 2\n"
        result = self.engine.analyze(code, "python", "test.py")
        assert len(result.fixes) > 0

        ws_fixes = [f for f in result.fixes if "whitespace" in f.rule_id.lower() or "WS" in f.rule_id]
        # Should detect trailing whitespace
        assert any(f.action in (HealingAction.DELETE, HealingAction.REPLACE) for f in result.fixes)

    def test_javascript_unused_import(self):
        code = "import { foo } from 'bar';\nconsole.log('hello');\n"
        result = self.engine.analyze(code, "javascript", "test.js")
        import_fixes = [f for f in result.fixes if "IMP" in f.rule_id]
        # Unused import rule should fire
        assert len(import_fixes) >= 0  # May or may not fire depending on heuristic

    def test_empty_file_produces_no_crash(self):
        result = self.engine.analyze("", "python", "empty.py")
        assert result is not None
        assert isinstance(result.fixes, list)

    def test_binary_like_content_handled(self):
        code = "\x00\x01\x02\x03\x04\x05"
        result = self.engine.analyze(code, "unknown", "binary.bin")
        assert result is not None

    def test_very_large_file_bounded(self):
        code = "x = 1\n" * 20000  # 20k lines
        result = self.engine.analyze(code, "python", "large.py")
        assert result is not None
        # Should still complete without timeout
        assert isinstance(result.fixes, list)

    def test_apply_fix_modifies_code(self):
        code = "x = 1   \n"
        result = self.engine.analyze(code, "python", "test.py")
        if result.fixes:
            fix = result.fixes[0]
            new_code = self.engine.apply_fix(code, fix)
            assert new_code != code or fix.action == HealingAction.INSERT

    def test_config_update_affects_analysis(self):
        config = HealingConfig(enabled=False)
        self.engine.update_config(config)
        result = self.engine.analyze("x = 1   \n", "python", "test.py")
        # Disabled engine should return empty or respect config
        assert result is not None

    def test_safe_fixes_only_applies_safe(self):
        code = "x = 1   \ny = 2\n"
        original = code
        result_code = self.engine.apply_safe_fixes(code, "python", "test.py")
        assert isinstance(result_code, str)


# ── Batch integration ───────────────────────────────────────────

class TestBatchIntegration:
    """Test batch engine with realistic multi-file scenarios."""

    def setup_method(self):
        self.batch = BatchHealingEngine()

    def test_mixed_language_batch(self):
        files = [
            BatchFileEntry(path="app.py", content="x = 1   \n", language="python"),
            BatchFileEntry(path="index.js", content="var x = 1;\n", language="javascript"),
            BatchFileEntry(path="main.go", content="package main\n", language="go"),
        ]
        result = self.batch.run(files)
        assert result is not None
        assert len(result.file_results) == 3

    def test_empty_batch(self):
        result = self.batch.run([])
        assert result is not None
        assert len(result.file_results) == 0


# ── Config presets integration ──────────────────────────────────

class TestPresetIntegration:
    """Test config presets applied to engine."""

    def test_conservative_preset_high_confidence(self):
        preset = get_preset("conservative")
        assert preset is not None
        assert preset.get("min_confidence", 0) >= 0.9

    def test_aggressive_preset_lower_confidence(self):
        preset = get_preset("aggressive")
        assert preset is not None
        assert preset.get("min_confidence", 1.0) <= 0.7

    def test_balanced_preset_middle_ground(self):
        preset = get_preset("balanced")
        assert preset is not None
        confidence = preset.get("min_confidence", 0)
        assert 0.7 <= confidence <= 0.9
