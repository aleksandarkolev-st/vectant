"""
Universal healing rule: Testing anti-patterns.

Detects:
- assert vs assertEqual/expect usage
- Missing assertion in test functions
- Test function without assertion
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


_PY_LANGS = {"python", "py"}
_JS_LANGS = {"javascript", "js", "jsx", "typescript", "ts", "tsx"}


# ── Rule: Bare assert in test ─────────────────────────────────────────

@healing_rule(
    rule_id="UNI_TEST_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect bare assert statements in tests (should use assertEqual etc.)",
)
def detect_bare_assert(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Flag plain 'assert x == y' when unittest assertions exist."""
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    # Only apply to test files
    if not file_path or not re.search(r"test[_.]|_test\.py$", file_path, re.IGNORECASE):
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Check if the file uses unittest
    uses_unittest = any("unittest" in l or "TestCase" in l for l in lines[:30])
    if not uses_unittest:
        return fixes

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if re.match(r"^assert\s+\w+\s*==\s*", stripped):
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description="Use self.assertEqual() instead of bare assert ==",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text="",
                replacement_text="",
                confidence=0.75,
                is_safe=True,
                affects_logic=False,
            ))
        elif re.match(r"^assert\s+\w+\s+is\s+None", stripped):
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description="Use self.assertIsNone() instead of bare assert is None",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text="",
                replacement_text="",
                confidence=0.75,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Test function without assertion ─────────────────────────────

@healing_rule(
    rule_id="UNI_TEST_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect test functions/methods with no assertions",
)
def detect_test_no_assertion(code: str, language: str, file_path: str) -> List[HealingFix]:
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if not file_path or not re.search(r"test[_.]|\.test\.|\.spec\.|_test\.", file_path, re.IGNORECASE):
        return []

    assertion_kws = {
        "assert", "assertEqual", "assertTrue", "assertFalse",
        "assertRaises", "assertIs", "assertIn", "expect(",
        "should.", "toBe(", "toEqual(", "toHaveBeenCalled",
        "assert.", "chai.", "sinon.",
    }

    if lang in _PY_LANGS:
        func_re = re.compile(r"^(\s*)(?:async\s+)?def\s+(test_\w+)\s*\(")
    elif lang in _JS_LANGS:
        func_re = re.compile(r"^\s*(?:it|test)\s*\(\s*['\"]")
    else:
        return fixes

    for idx, line in enumerate(lines):
        fm = func_re.match(line)
        if not fm:
            continue

        if lang in _PY_LANGS:
            func_name = fm.group(2)
            func_indent = len(fm.group(1))
            has_assertion = False

            for j in range(idx + 1, min(idx + 50, len(lines))):
                jline = lines[j]
                if jline.strip() and (len(jline) - len(jline.lstrip())) <= func_indent and j > idx + 1:
                    break
                if any(kw in jline for kw in assertion_kws):
                    has_assertion = True
                    break

            if not has_assertion:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.MODERATE,
                    action=HealingAction.REPLACE,
                    description=f"Test '{func_name}' has no assertions",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text="",
                    replacement_text="",
                    confidence=0.70,
                    is_safe=True,
                    affects_logic=False,
                ))

        elif lang in _JS_LANGS:
            brace_depth = 0
            has_assertion = False
            for j in range(idx, min(idx + 50, len(lines))):
                brace_depth += lines[j].count("{") - lines[j].count("}")
                if any(kw in lines[j] for kw in assertion_kws):
                    has_assertion = True
                    break
                if brace_depth <= 0 and j > idx:
                    break

            if not has_assertion:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.MODERATE,
                    action=HealingAction.REPLACE,
                    description="Test case has no assertions (expect/assert)",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text="",
                    replacement_text="",
                    confidence=0.70,
                    is_safe=True,
                    affects_logic=False,
                ))

    return fixes


# ── Rule: console.log in tests ────────────────────────────────────────

@healing_rule(
    rule_id="UNI_TEST_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect console.log/print left in test files",
)
def detect_debug_in_tests(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if not file_path or not re.search(r"test[_.]|\.test\.|\.spec\.|_test\.", file_path, re.IGNORECASE):
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    debug_re = None
    if lang in _PY_LANGS:
        debug_re = re.compile(r"^\s*print\s*\(")
    elif lang in _JS_LANGS:
        debug_re = re.compile(r"^\s*console\.(log|warn|info|debug)\s*\(")

    if not debug_re:
        return fixes

    for idx, line in enumerate(lines):
        if debug_re.match(line):
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.LOW,
                action=HealingAction.DELETE,
                description="Debug output left in test file — remove before commit",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text=line.rstrip(),
                replacement_text="",
                confidence=0.80,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes
