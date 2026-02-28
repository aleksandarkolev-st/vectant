"""
Tests for the AI healing agent subsystem.

Tests:
- AI response parser (JSON extraction, fix validation)
- Context collector (imports, related files)
- Agent confidence calibration
- Memory/feedback system
"""

import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# ─── Parser tests ─────────────────────────────────────────────────────

from analyzer.proactive.healing.ai_parser import (
    _extract_json_from_text,
    _fix_json_quirks,
    parse_detection_response,
    parse_validation_response,
    parse_batch_response,
)


class TestJSONExtraction:
    """Test extracting JSON from noisy LLM output."""

    def test_bare_json_array(self):
        text = '[{"line": 1, "description": "test"}]'
        assert _extract_json_from_text(text) == text

    def test_markdown_fenced_json(self):
        text = '```json\n[{"line": 1}]\n```'
        result = _extract_json_from_text(text)
        assert result.strip() == '[{"line": 1}]'

    def test_markdown_fenced_no_lang(self):
        text = '```\n[{"line": 1}]\n```'
        result = _extract_json_from_text(text)
        assert result.strip() == '[{"line": 1}]'

    def test_preamble_text(self):
        text = 'Here are the issues I found:\n[{"line": 1}]'
        result = _extract_json_from_text(text)
        assert '"line": 1' in result

    def test_postamble_text(self):
        text = '[{"line": 1}]\nNote: these are just suggestions.'
        result = _extract_json_from_text(text)
        assert '"line": 1' in result

    def test_empty_input(self):
        assert _extract_json_from_text("") == ""

    def test_nested_braces(self):
        text = '{"key": {"nested": "value"}}'
        result = _extract_json_from_text(text)
        parsed = json.loads(result)
        assert parsed["key"]["nested"] == "value"


class TestJSONQuirks:
    """Test fixing common JSON issues."""

    def test_trailing_comma_in_object(self):
        text = '{"a": 1, "b": 2,}'
        fixed = _fix_json_quirks(text)
        parsed = json.loads(fixed)
        assert parsed == {"a": 1, "b": 2}

    def test_trailing_comma_in_array(self):
        text = '[1, 2, 3,]'
        fixed = _fix_json_quirks(text)
        parsed = json.loads(fixed)
        assert parsed == [1, 2, 3]

    def test_single_line_comments(self):
        text = '{"a": 1 // this is a comment\n}'
        fixed = _fix_json_quirks(text)
        parsed = json.loads(fixed)
        assert parsed == {"a": 1}


class TestParseDetectionResponse:
    """Test parsing LLM detection responses into HealingFix objects."""

    SAMPLE_SOURCE = "x = 1\ny = None\nif x == y:\n    print('equal')\n"

    def test_valid_single_fix(self):
        response = json.dumps([{
            "line": 3,
            "original": "if x == y:",
            "replacement": "if x is y:",
            "description": "Use 'is' for None comparison",
            "category": "null_safety",
            "severity": "moderate",
            "confidence": 0.9,
        }])
        fixes = parse_detection_response(response, self.SAMPLE_SOURCE)
        assert len(fixes) == 1
        assert fixes[0].description.startswith("[AI]")
        assert fixes[0].confidence == 0.9

    def test_empty_response(self):
        assert parse_detection_response("", self.SAMPLE_SOURCE) == []
        assert parse_detection_response(None, self.SAMPLE_SOURCE) == []

    def test_invalid_json(self):
        assert parse_detection_response("not json at all", self.SAMPLE_SOURCE) == []

    def test_out_of_range_line(self):
        response = json.dumps([{
            "line": 999,
            "original": "foo",
            "replacement": "bar",
            "description": "test",
        }])
        fixes = parse_detection_response(response, self.SAMPLE_SOURCE)
        assert len(fixes) == 0

    def test_noop_fix_skipped(self):
        response = json.dumps([{
            "line": 1,
            "original": "x = 1",
            "replacement": "x = 1",
            "description": "no change",
        }])
        fixes = parse_detection_response(response, self.SAMPLE_SOURCE)
        assert len(fixes) == 0

    def test_fuzzy_line_matching(self):
        """Original text found 1 line away from indicated line."""
        response = json.dumps([{
            "line": 2,  # says line 2 but text is on line 3
            "original": "if x == y:",
            "replacement": "if x is y:",
            "description": "test",
        }])
        fixes = parse_detection_response(response, self.SAMPLE_SOURCE)
        assert len(fixes) == 1
        # Line should be adjusted to where text was actually found
        assert fixes[0].line == 2  # 0-indexed line 2 = source line 3

    def test_missing_original_text(self):
        response = json.dumps([{
            "line": 1,
            "original": "this text does not exist anywhere",
            "replacement": "bar",
            "description": "test",
        }])
        fixes = parse_detection_response(response, self.SAMPLE_SOURCE)
        assert len(fixes) == 0

    def test_multiple_fixes(self):
        response = json.dumps([
            {
                "line": 1,
                "original": "x = 1",
                "replacement": "x: int = 1",
                "description": "Add type hint",
                "category": "type_mismatch",
                "confidence": 0.8,
            },
            {
                "line": 3,
                "original": "if x == y:",
                "replacement": "if x is y:",
                "description": "None comparison",
                "category": "null_safety",
                "confidence": 0.9,
            },
        ])
        fixes = parse_detection_response(response, self.SAMPLE_SOURCE)
        assert len(fixes) == 2

    def test_markdown_wrapped_response(self):
        inner = json.dumps([{
            "line": 1,
            "original": "x = 1",
            "replacement": "x: int = 1",
            "description": "Add type",
        }])
        response = f"Here are the issues:\n```json\n{inner}\n```\nLet me know!"
        fixes = parse_detection_response(response, self.SAMPLE_SOURCE)
        assert len(fixes) == 1


class TestParseValidationResponse:
    """Test parsing validation responses."""

    def test_valid_response(self):
        response = json.dumps({
            "is_valid": True,
            "confidence": 0.85,
            "reason": "Fix is correct",
        })
        result = parse_validation_response(response)
        assert result["is_valid"] is True
        assert result["confidence"] == 0.85

    def test_invalid_json(self):
        result = parse_validation_response("not json")
        assert result["is_valid"] is False

    def test_empty_response(self):
        result = parse_validation_response("")
        assert result["is_valid"] is False

    def test_with_improved_replacement(self):
        response = json.dumps({
            "is_valid": True,
            "confidence": 0.9,
            "reason": "Good but can be improved",
            "improved_replacement": "x is None",
        })
        result = parse_validation_response(response)
        assert result["improved_replacement"] == "x is None"


class TestParseBatchResponse:
    """Test parsing batch detection responses."""

    def test_valid_batch(self):
        files = {
            "a.py": "x = 1\n",
            "b.py": "y = 2\n",
        }
        response = json.dumps({
            "a.py": [{
                "line": 1,
                "original": "x = 1",
                "replacement": "x: int = 1",
                "description": "type hint",
            }],
            "b.py": [],
        })
        results = parse_batch_response(response, files)
        assert "a.py" in results
        assert len(results["a.py"]) == 1

    def test_empty_batch(self):
        assert parse_batch_response("", {}) == {}


# ─── Context collector tests ──────────────────────────────────────────

from analyzer.proactive.healing.ai_context import (
    extract_imports,
    detect_language,
    find_test_pair,
    collect_project_hints,
)


class TestExtractImports:
    """Test import extraction from source code."""

    def test_python_import(self):
        source = "import os\nfrom pathlib import Path\n"
        imports = extract_imports(source, "python")
        assert "os" in imports
        assert "pathlib" in imports

    def test_javascript_import(self):
        source = "import React from 'react';\nconst fs = require('fs');\n"
        imports = extract_imports(source, "javascript")
        assert "react" in imports
        assert "fs" in imports

    def test_typescript_import(self):
        source = "import { useState } from 'react';\n"
        imports = extract_imports(source, "typescript")
        assert "react" in imports

    def test_rust_use(self):
        source = "use std::collections::HashMap;\n"
        imports = extract_imports(source, "rust")
        assert "std::collections::HashMap" in imports

    def test_unknown_language(self):
        source = "some code"
        imports = extract_imports(source, "brainfuck")
        assert imports == []


class TestDetectLanguage:
    """Test language detection from file extension."""

    def test_python(self):
        assert detect_language("foo.py") == "python"

    def test_javascript(self):
        assert detect_language("app.js") == "javascript"

    def test_typescript(self):
        assert detect_language("app.ts") == "typescript"

    def test_tsx(self):
        assert detect_language("Component.tsx") == "typescript"

    def test_unknown(self):
        assert detect_language("data.xyz") == "unknown"


class TestFindTestPair:
    """Test finding test file counterparts."""

    def test_python_test_pair(self, tmp_path):
        src = tmp_path / "engine.py"
        test = tmp_path / "test_engine.py"
        src.write_text("# source")
        test.write_text("# test")
        assert find_test_pair(str(src)) == str(test)

    def test_python_reverse(self, tmp_path):
        src = tmp_path / "engine.py"
        test = tmp_path / "test_engine.py"
        src.write_text("# source")
        test.write_text("# test")
        assert find_test_pair(str(test)) == str(src)

    def test_js_test_pair(self, tmp_path):
        src = tmp_path / "utils.js"
        test = tmp_path / "utils.test.js"
        src.write_text("// source")
        test.write_text("// test")
        assert find_test_pair(str(src)) == str(test)


# ─── Memory tests ─────────────────────────────────────────────────────

from analyzer.proactive.healing.ai_memory import (
    AIAgentMemory,
    FixFeedback,
    FeedbackType,
)


class TestAIAgentMemory:
    """Test the feedback-based learning memory."""

    def test_record_and_retrieve(self):
        memory = AIAgentMemory()
        memory.record_feedback(FixFeedback(
            rule_id="AI_NULL_SAFETY",
            category="null_safety",
            feedback=FeedbackType.ACCEPTED,
            confidence=0.8,
            language="python",
        ))
        stats = memory.get_pattern_stats("AI_NULL_SAFETY")
        assert stats["accepted"] == 1
        assert stats["total"] == 1

    def test_acceptance_rate(self):
        memory = AIAgentMemory()
        for _ in range(3):
            memory.record_feedback(FixFeedback(
                rule_id="AI_TEST",
                category="test",
                feedback=FeedbackType.ACCEPTED,
                confidence=0.8,
                language="python",
            ))
        memory.record_feedback(FixFeedback(
            rule_id="AI_TEST",
            category="test",
            feedback=FeedbackType.REJECTED,
            confidence=0.8,
            language="python",
        ))
        stats = memory.get_pattern_stats("AI_TEST")
        assert stats["acceptance_rate"] == 0.75

    def test_suppression_after_rejections(self):
        memory = AIAgentMemory()
        for _ in range(3):
            memory.record_feedback(FixFeedback(
                rule_id="AI_BAD_PATTERN",
                category="other",
                feedback=FeedbackType.REJECTED,
                confidence=0.8,
                language="python",
            ))
        assert memory.is_suppressed("AI_BAD_PATTERN")

    def test_unsuppress_on_acceptance(self):
        memory = AIAgentMemory()
        # First, suppress it
        for _ in range(3):
            memory.record_feedback(FixFeedback(
                rule_id="AI_REVIVED",
                category="other",
                feedback=FeedbackType.REJECTED,
                confidence=0.8,
                language="python",
            ))
        assert memory.is_suppressed("AI_REVIVED")

        # Now accept it twice (rate > 0.3 out of 5 total)
        for _ in range(2):
            memory.record_feedback(FixFeedback(
                rule_id="AI_REVIVED",
                category="other",
                feedback=FeedbackType.ACCEPTED,
                confidence=0.8,
                language="python",
            ))
        assert not memory.is_suppressed("AI_REVIVED")

    def test_confidence_adjustment_neutral(self):
        memory = AIAgentMemory()
        # No data → neutral (1.0)
        assert memory.get_confidence_adjustment("UNKNOWN") == 1.0

    def test_confidence_adjustment_boost(self):
        memory = AIAgentMemory()
        for _ in range(5):
            memory.record_feedback(FixFeedback(
                rule_id="AI_GOOD",
                category="test",
                feedback=FeedbackType.ACCEPTED,
                confidence=0.9,
                language="python",
            ))
        adj = memory.get_confidence_adjustment("AI_GOOD")
        assert adj > 1.0  # Should be boosted

    def test_confidence_adjustment_penalize(self):
        memory = AIAgentMemory()
        for _ in range(5):
            memory.record_feedback(FixFeedback(
                rule_id="AI_BAD",
                category="test",
                feedback=FeedbackType.REJECTED,
                confidence=0.9,
                language="python",
            ))
        adj = memory.get_confidence_adjustment("AI_BAD")
        assert adj < 1.0  # Should be penalized

    def test_persistence(self, tmp_path):
        path = str(tmp_path / "memory.json")

        # Save
        mem1 = AIAgentMemory(persist_path=path)
        mem1.record_feedback(FixFeedback(
            rule_id="AI_PERSIST",
            category="test",
            feedback=FeedbackType.ACCEPTED,
            confidence=0.8,
            language="python",
        ))

        # Load fresh
        mem2 = AIAgentMemory(persist_path=path)
        stats = mem2.get_pattern_stats("AI_PERSIST")
        assert stats is not None
        assert stats["accepted"] == 1

    def test_clear(self):
        memory = AIAgentMemory()
        memory.record_feedback(FixFeedback(
            rule_id="AI_CLEAR",
            category="test",
            feedback=FeedbackType.ACCEPTED,
            confidence=0.8,
            language="python",
        ))
        memory.clear()
        assert memory.get_pattern_stats("AI_CLEAR") is None
        assert memory.get_summary()["total_feedback"] == 0

    def test_summary(self):
        memory = AIAgentMemory()
        memory.record_feedback(FixFeedback(
            rule_id="AI_SUM",
            category="test",
            feedback=FeedbackType.ACCEPTED,
            confidence=0.8,
            language="python",
        ))
        summary = memory.get_summary()
        assert summary["total_feedback"] == 1
        assert summary["total_patterns"] == 1
        assert summary["overall_acceptance_rate"] == 1.0


# ─── Agent calibration tests ──────────────────────────────────────────

from analyzer.proactive.healing.ai_agent import AIHealingAgent, AIAgentConfig
from analyzer.proactive.healing.types import HealingFix, HealingCategory, HealingSeverity, HealingAction


class TestAgentCalibration:
    """Test the agent's confidence calibration logic."""

    def _make_fix(self, confidence=0.9, severity=HealingSeverity.MODERATE, rule_id="AI_TEST"):
        return HealingFix(
            category=HealingCategory.UNUSED_VARIABLE,
            severity=severity,
            action=HealingAction.REPLACE,
            description="test fix",
            line=0,
            column=0,
            end_line=0,
            end_column=5,
            original_text="foo",
            replacement_text="bar",
            confidence=confidence,
            is_safe=False,
            affects_logic=True,
            rule_id=rule_id,
        )

    def test_base_discount_applied(self):
        agent = AIHealingAgent(AIAgentConfig(confidence_discount=0.85))
        fix = self._make_fix(confidence=1.0)
        [calibrated] = agent._calibrate_confidence([fix])
        # Should be close to 0.85 (discount) * 1.0 (memory neutral) = 0.85
        assert calibrated.confidence < 1.0

    def test_critical_severity_boost(self):
        agent = AIHealingAgent(AIAgentConfig(confidence_discount=1.0))
        fix = self._make_fix(confidence=0.8, severity=HealingSeverity.CRITICAL)
        [calibrated] = agent._calibrate_confidence([fix])
        assert calibrated.confidence > 0.8

    def test_suppressed_fixes_filtered(self):
        agent = AIHealingAgent()
        # Suppress a pattern
        for _ in range(3):
            agent._memory.record_feedback(FixFeedback(
                rule_id="AI_SUPPRESS_ME",
                category="test",
                feedback=FeedbackType.REJECTED,
                confidence=0.9,
                language="python",
            ))

        fix = self._make_fix(rule_id="AI_SUPPRESS_ME")
        result = agent._calibrate_confidence([fix])
        assert len(result) == 0  # Suppressed!
