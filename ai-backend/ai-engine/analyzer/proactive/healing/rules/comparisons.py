"""
Universal healing rule: Comparison patterns.

Detects and fixes common comparison anti-patterns across languages:
- Python: == None → is None, == True → is True
- JS/TS: == → === (strict equality) where appropriate
- Any language: Yoda conditions, redundant boolean comparisons
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


# ── Helpers ────────────────────────────────────────────────────────────

def _in_string_or_comment(line: str, start: int, language: str) -> bool:
    """Quick heuristic: is position *start* inside a string or comment?"""
    lang = language.lower()
    prefix = line[:start]

    # Line comment
    if lang in _PY_LANGS and "#" in prefix:
        return prefix.index("#") < start
    if "//" in prefix:
        return prefix.index("//") < start

    # Rough string check (count unescaped quotes)
    in_single = False
    in_double = False
    for i, ch in enumerate(prefix):
        if i > 0 and prefix[i - 1] == "\\":
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double

    return in_single or in_double


# ── Rule: Python identity comparison ──────────────────────────────────

@healing_rule(
    rule_id="UNI_CMP_001",
    category=HealingCategory.COMPARISON_TO_NONE,
    description="Use 'is None' / 'is not None' instead of == / != None (PEP 8)",
)
def detect_comparison_to_none(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect == None / != None in Python (should be is / is not)."""
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    patterns = [
        (r"==\s*None\b", "== None", "is None"),
        (r"!=\s*None\b", "!= None", "is not None"),
        (r"==\s*True\b", "== True", "is True"),
        (r"==\s*False\b", "== False", "is False"),
        (r"!=\s*True\b", "!= True", "is not True"),
        (r"!=\s*False\b", "!= False", "is not False"),
    ]

    for idx, line in enumerate(lines):
        for pattern, old_desc, replacement in patterns:
            for m in re.finditer(pattern, line):
                if _in_string_or_comment(line, m.start(), language):
                    continue
                fixes.append(HealingFix(
                    category=HealingCategory.COMPARISON_TO_NONE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"Use '{replacement}' instead of '{old_desc}' (PEP 8)",
                    line=idx,
                    column=m.start(),
                    end_line=idx,
                    end_column=m.end(),
                    original_text=m.group(0),
                    replacement_text=replacement,
                    confidence=0.95,
                    is_safe=True,
                    affects_logic=False,
                ))

    return fixes


# ── Rule: JS/TS strict equality ───────────────────────────────────────

@healing_rule(
    rule_id="UNI_CMP_002",
    category=HealingCategory.EQUALITY_VS_ASSIGNMENT,
    description="Prefer === over == and !== over != in JavaScript / TypeScript",
)
def detect_loose_equality(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect == / != in JS/TS that should be === / !==."""
    lang = language.lower()
    if lang not in _JS_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Match == or != but NOT === or !==
    pattern = re.compile(r"(?<!=)(?<!!)(==|!=)(?!=)")

    for idx, line in enumerate(lines):
        for m in pattern.finditer(line):
            if _in_string_or_comment(line, m.start(), language):
                continue

            op = m.group(0)
            strict = "===" if op == "==" else "!=="

            fixes.append(HealingFix(
                category=HealingCategory.EQUALITY_VS_ASSIGNMENT,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.REPLACE,
                description=f"Use strict equality '{strict}' instead of '{op}'",
                line=idx,
                column=m.start(),
                end_line=idx,
                end_column=m.end(),
                original_text=op,
                replacement_text=strict,
                confidence=0.88,
                is_safe=False,  # can change runtime behaviour
                affects_logic=True,
            ))

    return fixes


# ── Rule: Redundant boolean comparison ────────────────────────────────

@healing_rule(
    rule_id="UNI_CMP_003",
    category=HealingCategory.COMPARISON_TO_NONE,
    description="Remove redundant boolean comparisons like if (x == true) → if (x)",
)
def detect_redundant_boolean(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect redundant boolean comparisons in any language."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()

    # JS/TS: x === true → x
    if lang in _JS_LANGS:
        pats = [
            (r"(\w+)\s*===\s*true\b", r"\1", "Remove redundant '=== true'"),
            (r"(\w+)\s*===\s*false\b", r"!\1", "Simplify '=== false' to negation"),
        ]
    elif lang in _PY_LANGS:
        pats = [
            (r"(\w+)\s+is\s+True\b", r"\1", "Remove redundant 'is True' (PEP 8)"),
            (r"(\w+)\s+is\s+False\b", r"not \1", "Simplify 'is False' to 'not'"),
        ]
    else:
        return fixes

    for idx, line in enumerate(lines):
        for pattern, repl, desc in pats:
            for m in re.finditer(pattern, line):
                if _in_string_or_comment(line, m.start(), language):
                    continue
                replacement = re.sub(pattern, repl, m.group(0))
                fixes.append(HealingFix(
                    category=HealingCategory.COMPARISON_TO_NONE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=desc,
                    line=idx,
                    column=m.start(),
                    end_line=idx,
                    end_column=m.end(),
                    original_text=m.group(0),
                    replacement_text=replacement,
                    confidence=0.85,
                    is_safe=True,
                    affects_logic=False,
                ))

    return fixes
