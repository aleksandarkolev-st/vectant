"""
Universal healing rule: Loop patterns.

Detects common loop anti-patterns:
- Infinite loops without break conditions
- Loop variable not used in body
- Range(len()) pattern in Python (should use enumerate)
- Off-by-one in range bounds
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


# ── Rule: Python range(len()) pattern ─────────────────────────────────

@healing_rule(
    rule_id="UNI_LOOP_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect for i in range(len(x)) — prefer enumerate(x) in Python",
)
def detect_range_len(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect for i in range(len(x)) which should be for i, item in enumerate(x)."""
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    pattern = re.compile(r"for\s+(\w+)\s+in\s+range\s*\(\s*len\s*\(\s*(\w+)\s*\)\s*\)")

    for idx, line in enumerate(lines):
        for m in pattern.finditer(line):
            var = m.group(1)
            iterable = m.group(2)
            col = m.start()

            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=f"Use enumerate({iterable}) instead of range(len({iterable}))",
                line=idx,
                column=col,
                end_line=idx,
                end_column=col + len(m.group(0)),
                original_text=m.group(0),
                replacement_text=f"for {var}, item in enumerate({iterable})",
                confidence=0.85,
                is_safe=False,
                affects_logic=True,
            ))

    return fixes


# ── Rule: Unused loop variable ────────────────────────────────────────

@healing_rule(
    rule_id="UNI_LOOP_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect loop variables that are never used inside the loop body",
)
def detect_unused_loop_variable(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect loop variables that are declared but never referenced in the body."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        for idx, line in enumerate(lines):
            m = re.match(r"^(\s*)for\s+(\w+)\s+in\s+(.+):\s*$", line)
            if not m:
                continue
            indent = len(m.group(1))
            var_name = m.group(2)
            if var_name == "_":
                continue  # convention for unused

            # Scan the loop body
            used = False
            for j in range(idx + 1, len(lines)):
                body_line = lines[j]
                if body_line.strip() == "":
                    continue
                body_indent = len(body_line) - len(body_line.lstrip())
                if body_indent <= indent and body_line.strip():
                    break
                if re.search(r"\b" + re.escape(var_name) + r"\b", body_line):
                    used = True
                    break

            if not used:
                col = m.start(2)
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"Loop variable '{var_name}' is unused — use '_' instead",
                    line=idx,
                    column=col,
                    end_line=idx,
                    end_column=col + len(var_name),
                    original_text=var_name,
                    replacement_text="_",
                    confidence=0.88,
                    is_safe=True,
                    affects_logic=False,
                ))

    elif lang in _JS_LANGS:
        for idx, line in enumerate(lines):
            # for (const item of array)
            m = re.match(r"^\s*for\s*\(\s*(?:const|let|var)\s+(\w+)\s+of\s+", line)
            if not m:
                continue
            var_name = m.group(1)
            # Simple check: is var used in next 20 lines?
            used = False
            for j in range(idx + 1, min(idx + 20, len(lines))):
                if re.search(r"\b" + re.escape(var_name) + r"\b", lines[j]):
                    used = True
                    break
            if not used:
                col = m.start(1)
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"Loop variable '{var_name}' appears unused — consider using '_'",
                    line=idx,
                    column=col,
                    end_line=idx,
                    end_column=col + len(var_name),
                    original_text=var_name,
                    replacement_text="_",
                    confidence=0.75,
                    is_safe=False,
                    affects_logic=False,
                ))

    return fixes


# ── Rule: while True without break ────────────────────────────────────

@healing_rule(
    rule_id="UNI_LOOP_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect while True loops that may be missing a break condition",
)
def detect_infinite_loop(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect while True / while(true) loops without break."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        stripped = line.strip()

        is_infinite = False
        if lang in _PY_LANGS and stripped.startswith("while True:"):
            is_infinite = True
        elif stripped in ("while (true) {", "while(true){", "while (true){", "while(true) {"):
            is_infinite = True
        elif stripped == "for (;;) {" or stripped == "for(;;){":
            is_infinite = True

        if not is_infinite:
            continue

        # Determine indent
        base_indent = len(line) - len(line.lstrip())

        # Scan body for break
        has_break = False
        body_end = min(idx + 100, len(lines))  # cap scan
        for j in range(idx + 1, body_end):
            body = lines[j]
            if body.strip() == "":
                continue
            body_indent = len(body) - len(body.lstrip())
            if body_indent <= base_indent and body.strip():
                break
            if "break" in body.strip():
                has_break = True
                break

        if not has_break:
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.INSERT,
                description="Infinite loop without 'break' — may run forever",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text="",
                replacement_text="",
                confidence=0.65,
                is_safe=False,
                affects_logic=False,
            ))

    return fixes
