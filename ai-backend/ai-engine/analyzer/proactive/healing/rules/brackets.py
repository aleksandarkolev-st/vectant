"""
Universal healing rule: Bracket / parenthesis / brace matching.

Detects unmatched opening and closing brackets, parentheses, and braces
across all languages that use them.  Context-aware: skips strings and
comments.
"""

from __future__ import annotations

import re
from typing import List, Tuple

from ..types import (
    HealingCategory,
    HealingSeverity,
    HealingAction,
    HealingFix,
)
from ..rule_registry import healing_rule


# ── Helpers ────────────────────────────────────────────────────────────

_OPEN_TO_CLOSE = {"(": ")", "[": "]", "{": "}"}
_CLOSE_TO_OPEN = {v: k for k, v in _OPEN_TO_CLOSE.items()}
_ALL_BRACKETS = set(_OPEN_TO_CLOSE.keys()) | set(_CLOSE_TO_OPEN.keys())

# Line-comment prefixes by language family
_LINE_COMMENTS = {
    "python": "#", "py": "#", "ruby": "#", "rb": "#", "perl": "#",
    "shell": "#", "sh": "#", "bash": "#", "zsh": "#", "powershell": "#",
    "r": "#", "yaml": "#", "yml": "#", "toml": "#",
}

_SLASH_COMMENT_LANGS = {
    "javascript", "js", "jsx", "typescript", "ts", "tsx",
    "c", "cpp", "c++", "cxx", "java", "csharp", "cs",
    "go", "rust", "rs", "swift", "kotlin", "dart", "scala",
    "php",
}


def _strip_strings_and_comments(code: str, language: str) -> str:
    """Replace string contents and comments with spaces, preserving positions."""
    lang = language.lower()
    result = list(code)
    i = 0
    length = len(code)

    while i < length:
        ch = code[i]

        # Line comments
        if ch == "#" and lang in _LINE_COMMENTS:
            while i < length and code[i] != "\n":
                result[i] = " "
                i += 1
            continue

        if ch == "/" and i + 1 < length:
            nxt = code[i + 1]
            if nxt == "/" and lang in _SLASH_COMMENT_LANGS:
                while i < length and code[i] != "\n":
                    result[i] = " "
                    i += 1
                continue
            if nxt == "*" and lang in _SLASH_COMMENT_LANGS:
                result[i] = " "
                result[i + 1] = " "
                i += 2
                while i < length:
                    if code[i] == "*" and i + 1 < length and code[i + 1] == "/":
                        result[i] = " "
                        result[i + 1] = " "
                        i += 2
                        break
                    result[i] = " "
                    i += 1
                continue

        # Strings
        if ch in ('"', "'", "`"):
            quote = ch
            # Triple-quote (Python)
            if lang in {"python", "py"} and i + 2 < length and code[i + 1] == quote and code[i + 2] == quote:
                result[i] = " "
                result[i + 1] = " "
                result[i + 2] = " "
                i += 3
                while i < length:
                    if code[i] == quote and i + 2 < length and code[i + 1] == quote and code[i + 2] == quote:
                        result[i] = " "
                        result[i + 1] = " "
                        result[i + 2] = " "
                        i += 3
                        break
                    result[i] = " "
                    i += 1
                continue

            # Template literal (JS/TS)
            if quote == "`" and lang in {"javascript", "js", "jsx", "typescript", "ts", "tsx"}:
                result[i] = " "
                i += 1
                while i < length:
                    if code[i] == "\\" and i + 1 < length:
                        result[i] = " "
                        result[i + 1] = " "
                        i += 2
                        continue
                    if code[i] == "`":
                        result[i] = " "
                        i += 1
                        break
                    result[i] = " "
                    i += 1
                continue

            # Regular string
            result[i] = " "
            i += 1
            while i < length:
                if code[i] == "\\" and i + 1 < length:
                    result[i] = " "
                    result[i + 1] = " "
                    i += 2
                    continue
                if code[i] == quote:
                    result[i] = " "
                    i += 1
                    break
                if code[i] == "\n":
                    break
                result[i] = " "
                i += 1
            continue

        i += 1

    return "".join(result)


def _find_unmatched(cleaned: str) -> List[Tuple[int, int, str]]:
    """Return (line, col, bracket) for every unmatched bracket."""
    lines = cleaned.split("\n")
    stack: List[Tuple[str, int, int]] = []  # (bracket, line, col)
    unmatched = []

    for line_idx, line in enumerate(lines):
        for col_idx, ch in enumerate(line):
            if ch in _OPEN_TO_CLOSE:
                stack.append((ch, line_idx, col_idx))
            elif ch in _CLOSE_TO_OPEN:
                if stack and stack[-1][0] == _CLOSE_TO_OPEN[ch]:
                    stack.pop()
                else:
                    unmatched.append((line_idx, col_idx, ch))

    # Remaining stack entries are unmatched openers
    for bracket, line_idx, col_idx in stack:
        unmatched.append((line_idx, col_idx, bracket))

    return unmatched


# ── Rule: Unmatched brackets ──────────────────────────────────────────

@healing_rule(
    rule_id="UNI_BRK_001",
    category=HealingCategory.MISSING_BRACKET,
    description="Detect unmatched brackets, parentheses, and braces",
)
def detect_unmatched_brackets(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Universal unmatched-bracket detection.

    Strips strings and comments first so that brackets inside
    literals are not counted.
    """
    cleaned = _strip_strings_and_comments(code, language)
    issues = _find_unmatched(cleaned)
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for line_idx, col_idx, bracket in issues:
        if bracket in _OPEN_TO_CLOSE:
            # Unmatched opener → suggest inserting a closer
            closer = _OPEN_TO_CLOSE[bracket]
            # Insert at end of file (simplest safe location)
            last_line = len(lines) - 1
            last_col = len(lines[last_line]) if lines else 0

            fixes.append(HealingFix(
                category=HealingCategory.MISSING_BRACKET,
                severity=HealingSeverity.CRITICAL,
                action=HealingAction.INSERT,
                description=f"Add missing closing '{closer}' to match '{bracket}' at line {line_idx + 1}",
                line=last_line,
                column=last_col,
                end_line=last_line,
                end_column=last_col,
                original_text="",
                replacement_text=closer,
                confidence=0.80,
                is_safe=False,  # inserting brackets can change semantics
                affects_logic=True,
            ))
        else:
            # Unmatched closer → suggest removing it
            fixes.append(HealingFix(
                category=HealingCategory.MISSING_BRACKET,
                severity=HealingSeverity.CRITICAL,
                action=HealingAction.DELETE,
                description=f"Remove unmatched closing '{bracket}' at line {line_idx + 1}",
                line=line_idx,
                column=col_idx,
                end_line=line_idx,
                end_column=col_idx + 1,
                original_text=bracket,
                replacement_text="",
                confidence=0.75,
                is_safe=False,
                affects_logic=True,
            ))

    return fixes
