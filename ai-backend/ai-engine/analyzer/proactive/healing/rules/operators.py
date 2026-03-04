"""
Universal healing rule: Operator issues.

Detects common operator mistakes:
- Assignment in conditionals (= instead of ==)
- Accidental bitwise instead of logical operators
- Chained comparisons that could be simplified
- Null coalescing opportunities
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
_JS_LANGS = {"javascript", "js", "jsx", "typescript", "ts", "tsx"}
_C_STYLE_LANGS = {
    "javascript", "js", "jsx", "typescript", "ts", "tsx",
    "c", "cpp", "c++", "cxx", "java", "csharp", "cs",
    "go", "rust", "rs", "swift", "kotlin", "dart",
}


def _in_string_or_comment(line: str, pos: int, language: str) -> bool:
    """Quick heuristic for string/comment context."""
    prefix = line[:pos]
    if "#" in prefix and language.lower() in _PY_LANGS:
        return True
    if "//" in prefix:
        return True
    in_s = in_d = False
    for i, ch in enumerate(prefix):
        if i > 0 and prefix[i - 1] == "\\":
            continue
        if ch == "'" and not in_d:
            in_s = not in_s
        elif ch == '"' and not in_s:
            in_d = not in_d
    return in_s or in_d


# ── Rule: Assignment in conditional ───────────────────────────────────

@healing_rule(
    rule_id="UNI_OP_001",
    category=HealingCategory.EQUALITY_VS_ASSIGNMENT,
    description="Detect accidental assignment (=) instead of comparison (==) in conditionals",
)
def detect_assignment_in_conditional(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect `if (x = y)` which should likely be `if (x == y)`."""
    lang = language.lower()
    if lang in _PY_LANGS:
        return []  # Python doesn't allow assignment in conditionals (SyntaxError)

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("//"):
            continue

        # Match: if (... = ... ) or while (... = ...)
        m = re.search(r"\b(if|while)\s*\(([^)]+)\)", stripped)
        if m:
            condition = m.group(2)
            # Find single = that is NOT ==, !=, <=, >=, ===, !==
            for eq in re.finditer(r"(?<!=)(?<!!)(?<!<)(?<!>)=(?!=)", condition):
                abs_pos = m.start(2) + eq.start()
                actual_col = len(line) - len(stripped) + abs_pos

                if _in_string_or_comment(line, actual_col, language):
                    continue

                fixes.append(HealingFix(
                    category=HealingCategory.EQUALITY_VS_ASSIGNMENT,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.REPLACE,
                    description="Possible accidental assignment in conditional (= instead of ==)",
                    line=idx,
                    column=actual_col,
                    end_line=idx,
                    end_column=actual_col + 1,
                    original_text="=",
                    replacement_text="==",
                    confidence=0.85,
                    is_safe=False,
                    affects_logic=True,
                ))

    return fixes


# ── Rule: Bitwise vs logical operator ─────────────────────────────────

@healing_rule(
    rule_id="UNI_OP_002",
    category=HealingCategory.EQUALITY_VS_ASSIGNMENT,
    description="Detect potential bitwise operator (& |) used instead of logical (&& ||)",
)
def detect_bitwise_vs_logical(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect & or | in conditionals that should be && or ||."""
    lang = language.lower()
    if lang in _PY_LANGS:
        return []  # Python uses `and`/`or`, not && ||

    if lang not in _C_STYLE_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("//"):
            continue

        # Look for if/while conditions with single & or |
        m = re.search(r"\b(if|while)\s*\((.+)\)", stripped)
        if not m:
            continue

        condition = m.group(2)
        cond_start = m.start(2)

        # Single & (not &&)
        for op_match in re.finditer(r"(?<!&)&(?!&)", condition):
            abs_pos = cond_start + op_match.start()
            actual_col = len(line) - len(stripped) + abs_pos

            if _in_string_or_comment(line, actual_col, language):
                continue

            fixes.append(HealingFix(
                category=HealingCategory.EQUALITY_VS_ASSIGNMENT,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.REPLACE,
                description="Possible bitwise & instead of logical && in conditional",
                line=idx,
                column=actual_col,
                end_line=idx,
                end_column=actual_col + 1,
                original_text="&",
                replacement_text="&&",
                confidence=0.78,
                is_safe=False,
                affects_logic=True,
            ))

        # Single | (not ||)
        for op_match in re.finditer(r"(?<!\|)\|(?!\|)", condition):
            abs_pos = cond_start + op_match.start()
            actual_col = len(line) - len(stripped) + abs_pos

            if _in_string_or_comment(line, actual_col, language):
                continue

            fixes.append(HealingFix(
                category=HealingCategory.EQUALITY_VS_ASSIGNMENT,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.REPLACE,
                description="Possible bitwise | instead of logical || in conditional",
                line=idx,
                column=actual_col,
                end_line=idx,
                end_column=actual_col + 1,
                original_text="|",
                replacement_text="||",
                confidence=0.78,
                is_safe=False,
                affects_logic=True,
            ))

    return fixes


# ── Rule: Negation mistakes (!= vs = !) ──────────────────────────────

@healing_rule(
    rule_id="UNI_OP_003",
    category=HealingCategory.EQUALITY_VS_ASSIGNMENT,
    description="Detect =! which is likely meant to be !=",
)
def detect_negation_mistake(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect `=!` (assign negation) which is usually `!=` (not equal)."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        for m in re.finditer(r"=!", line):
            if _in_string_or_comment(line, m.start(), language):
                continue

            # Check it's not ==!
            if m.start() > 0 and line[m.start() - 1] == "=":
                continue

            fixes.append(HealingFix(
                category=HealingCategory.EQUALITY_VS_ASSIGNMENT,
                severity=HealingSeverity.CRITICAL,
                action=HealingAction.REPLACE,
                description="Likely typo: '=!' should be '!='",
                line=idx,
                column=m.start(),
                end_line=idx,
                end_column=m.end(),
                original_text="=!",
                replacement_text="!=",
                confidence=0.88,
                is_safe=False,
                affects_logic=True,
            ))

    return fixes
