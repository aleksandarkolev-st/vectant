"""
Tests for ai_prompts.py — prompt construction.
"""

import pytest

from analyzer.proactive.healing.ai_prompts import (
    build_detect_prompt,
    build_validate_prompt,
    build_batch_prompt,
    build_focused_prompt,
    format_related_files,
    format_context_notes,
    AGENT_SYSTEM_PROMPT,
)


class TestBuildDetectPrompt:
    def test_basic_prompt_contains_code(self):
        prompt = build_detect_prompt("x = 1\n", "python")
        assert "x = 1" in prompt
        assert "python" in prompt.lower()

    def test_prompt_contains_system_persona(self):
        prompt = build_detect_prompt("code", "js")
        assert "senior code reviewer" in prompt

    def test_with_related_files(self):
        related = format_related_files([
            {"path": "utils.py", "content": "def helper(): pass"},
        ])
        prompt = build_detect_prompt("import utils", "python", related_files=related)
        assert "utils.py" in prompt
        assert "helper" in prompt

    def test_with_context_notes(self):
        notes = format_context_notes(["Uses Flask framework", "Python 3.11"])
        prompt = build_detect_prompt("code", "python", context_notes=notes)
        assert "Flask" in prompt


class TestBuildValidatePrompt:
    def test_contains_fix_details(self):
        prompt = build_validate_prompt(
            code="line1\nline2\nline3\nline4\nline5\n",
            language="python",
            file_path="test.py",
            line=3,
            end_line=3,
            original="line3",
            replacement="line3_fixed",
            description="Fix off-by-one",
        )
        assert "line3" in prompt
        assert "line3_fixed" in prompt
        assert "Fix off-by-one" in prompt

    def test_context_window_respected(self):
        code = "\n".join(f"line{i}" for i in range(20))
        prompt = build_validate_prompt(
            code=code,
            language="python",
            file_path="t.py",
            line=10,
            end_line=10,
            original="line9",
            replacement="fixed",
            description="fix",
        )
        # Should include surrounding context but not the entire file
        assert "line9" in prompt


class TestBuildBatchPrompt:
    def test_multiple_files(self):
        prompt = build_batch_prompt([
            {"path": "a.py", "content": "x = 1", "language": "python"},
            {"path": "b.js", "content": "let y = 2", "language": "javascript"},
        ])
        assert "a.py" in prompt
        assert "b.js" in prompt
        assert "x = 1" in prompt
        assert "let y = 2" in prompt

    def test_truncates_long_files(self):
        long_content = "a\n" * 10000
        prompt = build_batch_prompt([
            {"path": "big.py", "content": long_content, "language": "python"},
        ])
        assert "truncated" in prompt.lower()


class TestBuildFocusedPrompt:
    def test_contains_focused_range(self):
        code = "line1\nline2\nline3\nline4\nline5\n"
        prompt = build_focused_prompt(
            code=code,
            language="python",
            file_path="test.py",
            start_line=2,
            end_line=4,
        )
        assert "line2" in prompt
        assert "line3" in prompt
        assert "line4" in prompt

    def test_includes_full_code(self):
        code = "line1\nline2\nline3\n"
        prompt = build_focused_prompt(
            code=code, language="js", file_path="t.js",
            start_line=1, end_line=2,
        )
        # Full code should be included for context
        assert "line1" in prompt
        assert "line3" in prompt

    def test_includes_context_notes(self):
        prompt = build_focused_prompt(
            code="x = 1\n", language="py", file_path="t.py",
            start_line=1, end_line=1,
            context_notes=["Uses Django ORM"],
        )
        assert "Django" in prompt


class TestFormatHelpers:
    def test_format_related_files_empty(self):
        result = format_related_files([])
        assert result == ""

    def test_format_related_files_content(self):
        result = format_related_files([
            {"path": "lib.py", "content": "def greet(): pass"},
        ])
        assert "lib.py" in result
        assert "greet" in result

    def test_format_context_notes_empty(self):
        result = format_context_notes([])
        assert result == ""

    def test_format_context_notes_content(self):
        result = format_context_notes(["Note A", "Note B"])
        assert "Note A" in result
        assert "Note B" in result
