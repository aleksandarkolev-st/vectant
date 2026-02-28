"""
Universal healing rule: Type annotation helpers.

Detects common type-annotation issues:
- Missing return type annotations on functions
- Obvious type mismatches (assigning wrong type to annotated var)
- Incomplete type annotations
Works across Python, TypeScript, and other typed languages.
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
_TS_LANGS = {"typescript", "ts", "tsx"}


# ── Rule: Missing return type annotation ──────────────────────────────

@healing_rule(
    rule_id="UNI_TYPE_001",
    category=HealingCategory.MISSING_RETURN_TYPE,
    description="Detect functions missing return type annotations",
)
def detect_missing_return_type(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect function definitions that lack a return type annotation."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        for idx, line in enumerate(lines):
            stripped = line.strip()
            # Match def func(args): without -> annotation
            m = re.match(r"^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*:\s*$", stripped)
            if m:
                func_name = m.group(2)
                # Skip dunder methods and test functions
                if func_name.startswith("__") or func_name.startswith("test_"):
                    continue
                # Suggest adding -> None as safe default
                col_pos = stripped.rindex(":")
                actual_col = len(line) - len(stripped) + col_pos

                fixes.append(HealingFix(
                    category=HealingCategory.MISSING_RETURN_TYPE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.INSERT,
                    description=f"Add return type annotation to '{func_name}'",
                    line=idx,
                    column=actual_col,
                    end_line=idx,
                    end_column=actual_col,
                    original_text=":",
                    replacement_text=" -> None:",
                    confidence=0.60,
                    is_safe=True,
                    affects_logic=False,
                ))

    elif lang in _TS_LANGS:
        for idx, line in enumerate(lines):
            stripped = line.strip()
            # Match function declarations without return type
            # function name(args) {
            m = re.match(
                r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*\{",
                stripped,
            )
            if m:
                func_name = m.group(1)
                # Check if there's a : ReturnType before {
                before_brace = stripped[:stripped.rindex("{")].strip()
                if not re.search(r"\)\s*:\s*\w+", before_brace):
                    brace_pos = stripped.rindex("{")
                    actual_col = len(line) - len(stripped) + brace_pos

                    fixes.append(HealingFix(
                        category=HealingCategory.MISSING_RETURN_TYPE,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.INSERT,
                        description=f"Add return type annotation to '{func_name}'",
                        line=idx,
                        column=actual_col,
                        end_line=idx,
                        end_column=actual_col,
                        original_text="",
                        replacement_text=": void ",
                        confidence=0.55,
                        is_safe=True,
                        affects_logic=False,
                    ))

            # Arrow function in const: const fn = (args) => {
            m = re.match(
                r"^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>\s*\{?",
                stripped,
            )
            if m:
                func_name = m.group(1)
                args = m.group(2).strip()
                # If args have no types, suggest adding types
                if args and ":" not in args:
                    fixes.append(HealingFix(
                        category=HealingCategory.MISSING_RETURN_TYPE,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.INSERT,
                        description=f"Consider adding parameter types to '{func_name}'",
                        line=idx,
                        column=0,
                        end_line=idx,
                        end_column=len(line),
                        original_text="",
                        replacement_text="",
                        confidence=0.45,
                        is_safe=True,
                        affects_logic=False,
                    ))

    return fixes


# ── Rule: Any type usage (TypeScript) ─────────────────────────────────

@healing_rule(
    rule_id="UNI_TYPE_002",
    category=HealingCategory.OBVIOUS_TYPE_MISMATCH,
    description="Detect usage of 'any' type in TypeScript",
)
def detect_any_type(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect explicit 'any' type annotations in TypeScript."""
    lang = language.lower()
    if lang not in _TS_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    pattern = re.compile(r":\s*any\b")

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("//") or stripped.startswith("/*"):
            continue

        for m in pattern.finditer(line):
            fixes.append(HealingFix(
                category=HealingCategory.OBVIOUS_TYPE_MISMATCH,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description="Avoid using 'any' — consider a more specific type",
                line=idx,
                column=m.start(),
                end_line=idx,
                end_column=m.end(),
                original_text=m.group(0),
                replacement_text=": unknown",
                confidence=0.65,
                is_safe=False,
                affects_logic=True,
            ))

    return fixes


# ── Rule: Python type: ignore overuse ─────────────────────────────────

@healing_rule(
    rule_id="UNI_TYPE_003",
    category=HealingCategory.OBVIOUS_TYPE_MISMATCH,
    description="Detect excessive type: ignore comments in Python",
)
def detect_type_ignore_overuse(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Flag lines with # type: ignore that may be hiding real type errors."""
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")
    ignore_count = 0

    for idx, line in enumerate(lines):
        if "# type: ignore" in line:
            ignore_count += 1
            if ignore_count > 5:
                m = re.search(r"#\s*type:\s*ignore", line)
                if m:
                    fixes.append(HealingFix(
                        category=HealingCategory.OBVIOUS_TYPE_MISMATCH,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.DELETE,
                        description="Excessive '# type: ignore' — consider fixing the actual type issue",
                        line=idx,
                        column=m.start(),
                        end_line=idx,
                        end_column=len(line),
                        original_text=m.group(0),
                        replacement_text="",
                        confidence=0.50,
                        is_safe=False,
                        affects_logic=False,
                    ))

    return fixes
