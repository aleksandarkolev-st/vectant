"""
Universal healing rule: Dead code detection.

Detects unreachable code after return/break/continue statements,
unused function parameters, and empty function bodies across all
languages.
"""

from __future__ import annotations

import re
from typing import List

from ..types import (
    HealingCategory,
    HealingSeverity,
    HealingAction,
    HealingFix,
)
from ..rule_registry import healing_rule


# ── Language sets ──────────────────────────────────────────────────────

_PY_LANGS = {"python", "py"}
_C_STYLE_LANGS = {
    "javascript", "js", "jsx", "typescript", "ts", "tsx",
    "c", "cpp", "c++", "cxx", "java", "csharp", "cs",
    "go", "rust", "rs", "swift", "kotlin", "dart", "scala", "php",
}


# ── Rule: Unreachable code after return ───────────────────────────────

@healing_rule(
    rule_id="UNI_DEAD_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect unreachable code after return/break/continue/throw",
)
def detect_unreachable_code(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect code immediately after unconditional return/break/continue."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()

    # Terminal statements by language
    terminals = {"return", "break", "continue", "throw"}
    if lang in _PY_LANGS:
        terminals.add("raise")

    prev_was_terminal = False
    prev_indent = -1
    terminal_line = -1

    for idx, line in enumerate(lines):
        stripped = line.strip()

        if not stripped:
            continue

        # Skip comments
        if stripped.startswith("#") or stripped.startswith("//") or stripped.startswith("/*"):
            continue

        current_indent = len(line) - len(line.lstrip())

        if prev_was_terminal and current_indent >= prev_indent:
            # Code at same or deeper indent after a terminal — unreachable
            # But skip closing brackets
            if stripped in ("}", ")", "]", "end", "else:", "elif", "except:", "except", "finally:", "catch", "else {", "else"):
                prev_was_terminal = False
                continue

            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.DELETE,
                description=f"Unreachable code after line {terminal_line + 1}",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text=stripped,
                replacement_text="",
                confidence=0.80,
                is_safe=False,
                affects_logic=False,
            ))
            continue

        # Check if this line is a terminal statement
        first_word = stripped.split("(")[0].split(" ")[0].rstrip(";")
        if first_word in terminals:
            prev_was_terminal = True
            prev_indent = current_indent
            terminal_line = idx
        else:
            prev_was_terminal = False

    return fixes


# ── Rule: Empty function/method bodies ────────────────────────────────

@healing_rule(
    rule_id="UNI_DEAD_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect empty function/method bodies that may be unimplemented",
)
def detect_empty_functions(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect functions with empty bodies (no implementation)."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()

    if lang in _PY_LANGS:
        # Python: def func(): followed by only pass or ...
        for idx, line in enumerate(lines):
            stripped = line.strip()
            if re.match(r"^(async\s+)?def\s+\w+", stripped) and stripped.endswith(":"):
                # Check next non-empty line
                next_idx = idx + 1
                while next_idx < len(lines) and not lines[next_idx].strip():
                    next_idx += 1
                if next_idx < len(lines):
                    next_stripped = lines[next_idx].strip()
                    if next_stripped in ("pass", "..."):
                        # Check if there's nothing after pass/...
                        after_idx = next_idx + 1
                        while after_idx < len(lines) and not lines[after_idx].strip():
                            after_idx += 1
                        body_indent = len(lines[next_idx]) - len(lines[next_idx].lstrip())
                        func_indent = len(line) - len(line.lstrip())
                        if after_idx >= len(lines) or (len(lines[after_idx]) - len(lines[after_idx].lstrip())) <= func_indent:
                            fixes.append(HealingFix(
                                category=HealingCategory.UNUSED_VARIABLE,
                                severity=HealingSeverity.LOW,
                                action=HealingAction.INSERT,
                                description=f"Empty function body — consider adding implementation or docstring",
                                line=idx,
                                column=0,
                                end_line=next_idx,
                                end_column=len(lines[next_idx]),
                                original_text="",
                                replacement_text="",
                                confidence=0.60,
                                is_safe=True,
                                affects_logic=False,
                            ))

    elif lang in _C_STYLE_LANGS:
        # C-style: function() { } with nothing between braces
        for idx, line in enumerate(lines):
            stripped = line.strip()
            # Single-line empty: function() {}
            if re.match(r"^.*\w+\s*\([^)]*\)\s*\{\s*\}\s*$", stripped):
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.INSERT,
                    description="Empty function body — consider adding implementation",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text="",
                    replacement_text="",
                    confidence=0.60,
                    is_safe=True,
                    affects_logic=False,
                ))
            # Multi-line: { on this line, } on next non-empty line
            elif stripped.endswith("{"):
                next_idx = idx + 1
                while next_idx < len(lines) and not lines[next_idx].strip():
                    next_idx += 1
                if next_idx < len(lines) and lines[next_idx].strip() == "}":
                    fixes.append(HealingFix(
                        category=HealingCategory.UNUSED_VARIABLE,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.INSERT,
                        description="Empty function body — consider adding implementation",
                        line=idx,
                        column=0,
                        end_line=next_idx,
                        end_column=len(lines[next_idx]),
                        original_text="",
                        replacement_text="",
                        confidence=0.60,
                        is_safe=True,
                        affects_logic=False,
                    ))

    return fixes


# ── Rule: Duplicate adjacent lines ────────────────────────────────────

@healing_rule(
    rule_id="UNI_DEAD_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect exact duplicate adjacent non-blank lines",
)
def detect_duplicate_adjacent_lines(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect exact duplicate consecutive lines (likely copy-paste error)."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx in range(1, len(lines)):
        current = lines[idx].strip()
        previous = lines[idx - 1].strip()

        if not current:
            continue

        # Skip common patterns that legitimately repeat
        if current in ("}", ")", "]", "pass", "break", "continue", "return"):
            continue

        if current == previous:
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.DELETE,
                description=f"Duplicate line (same as line {idx}): {current[:50]}",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(lines[idx]),
                original_text=lines[idx],
                replacement_text="",
                confidence=0.78,
                is_safe=False,
                affects_logic=True,
            ))

    return fixes
