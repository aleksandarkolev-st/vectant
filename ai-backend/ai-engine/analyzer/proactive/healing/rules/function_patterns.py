"""
Universal healing rule: Function-level anti-patterns.

Detects common function-level issues:
- Global state mutation inside functions
- Functions with too many branches
- Mutable default arguments (Python)
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


# ── Rule: Mutable default argument (Python) ───────────────────────────

@healing_rule(
    rule_id="UNI_FN_001",
    category=HealingCategory.UNUSED_IMPORT,
    description="Detect mutable default arguments in Python functions",
)
def detect_mutable_default(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Catch def foo(bar=[]) or def foo(bar={}) patterns."""
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    mutable_defaults = re.compile(
        r"def\s+\w+\s*\([^)]*\b(\w+)\s*=\s*(\[\]|\{\})\s*[,)]"
    )

    for idx, line in enumerate(lines):
        for m in mutable_defaults.finditer(line):
            param_name = m.group(1)
            default_val = m.group(2)
            replacement = "None"
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_IMPORT,
                severity=HealingSeverity.CRITICAL,
                action=HealingAction.REPLACE,
                description=(
                    f"Mutable default argument '{param_name}={default_val}' — "
                    f"use '{param_name}=None' and initialise in body"
                ),
                line=idx,
                column=m.start(2),
                end_line=idx,
                end_column=m.end(2),
                original_text=default_val,
                replacement_text=replacement,
                confidence=0.92,
                is_safe=False,
                affects_logic=True,
            ))

    return fixes


# ── Rule: Excessive function branches ─────────────────────────────────

@healing_rule(
    rule_id="UNI_FN_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect functions with too many branches (cyclomatic complexity)",
)
def detect_excessive_branches(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Count branches inside a function and warn if > 10."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")
    max_branches = 10

    branch_kw = re.compile(
        r"\b(if|elif|else|for|while|except|catch|case|switch|&&|\|\|)\b"
    )

    if lang in _PY_LANGS:
        func_pattern = re.compile(r"^(\s*)(?:async\s+)?def\s+(\w+)")
    elif lang in _JS_LANGS:
        func_pattern = re.compile(
            r"^(\s*)(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=)"
        )
    else:
        func_pattern = re.compile(r"^(\s*)(?:\w+\s+)*(\w+)\s*\(")

    for idx, line in enumerate(lines):
        fm = func_pattern.match(line)
        if not fm:
            continue

        func_name = fm.group(2) or (fm.group(3) if fm.lastindex >= 3 else "unknown")
        func_indent = len(fm.group(1))
        branch_count = 0

        for j in range(idx + 1, min(idx + 200, len(lines))):
            jline = lines[j]
            if jline.strip() and (len(jline) - len(jline.lstrip())) <= func_indent:
                if lang in _PY_LANGS and j > idx + 1:
                    break
            branch_count += len(branch_kw.findall(jline))

        if branch_count > max_branches:
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=(
                    f"Function '{func_name}' has {branch_count} branches "
                    f"(max {max_branches}) — consider refactoring"
                ),
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text="",
                replacement_text="",
                confidence=0.50,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Nested function abuse ───────────────────────────────────────

@healing_rule(
    rule_id="UNI_FN_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect deeply nested function definitions",
)
def detect_nested_functions(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Flag functions defined 3+ levels deep."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")
    max_depth = 2

    if lang in _PY_LANGS:
        func_re = re.compile(r"^(\s*)(?:async\s+)?def\s+(\w+)")
    elif lang in _JS_LANGS:
        func_re = re.compile(r"^(\s*)(?:async\s+)?function\s+(\w+)")
    else:
        return fixes

    func_stack: list[int] = []

    for idx, line in enumerate(lines):
        fm = func_re.match(line)
        if not fm:
            continue

        indent = len(fm.group(1))
        func_name = fm.group(2)

        # Pop functions whose scope has ended
        while func_stack and func_stack[-1] >= indent:
            func_stack.pop()

        func_stack.append(indent)

        if len(func_stack) > max_depth:
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=(
                    f"Function '{func_name}' is nested {len(func_stack)} "
                    f"levels deep — consider extracting to module level"
                ),
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text="",
                replacement_text="",
                confidence=0.55,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes
