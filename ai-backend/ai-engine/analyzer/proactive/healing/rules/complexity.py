"""
Universal healing rule: Complexity analysis.

Detects functions and methods that are too complex:
- Excessive nesting depth
- Too many parameters
- Function body too long
- Cyclomatic complexity heuristic
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


# ── Rule: Excessive nesting ───────────────────────────────────────────

@healing_rule(
    rule_id="UNI_CMPLX_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect code with excessive nesting depth (> 4 levels)",
)
def detect_deep_nesting(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect lines with excessive indentation depth."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()
    max_depth = 4

    # Determine indent unit
    if lang in ("go",):
        indent_unit = 1  # tab
    else:
        indent_unit = 4  # spaces

    flagged_ranges = set()

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue

        # Calculate depth
        leading = len(line) - len(line.lstrip())
        if "\t" in line[:leading]:
            depth = line[:leading].count("\t")
        else:
            depth = leading // indent_unit

        if depth > max_depth and idx not in flagged_ranges:
            flagged_ranges.add(idx)
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=f"Nesting depth {depth} exceeds maximum {max_depth} — consider extracting to a function",
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


# ── Rule: Too many function parameters ────────────────────────────────

@healing_rule(
    rule_id="UNI_CMPLX_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect functions with too many parameters (> 5)",
)
def detect_too_many_params(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect function definitions with more than 5 parameters."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()
    max_params = 5

    for idx, line in enumerate(lines):
        stripped = line.strip()

        # Python
        if lang in ("python", "py"):
            m = re.match(r"^(async\s+)?def\s+(\w+)\s*\((.+)\)\s*(?:->.*)?:\s*$", stripped)
            if m:
                func_name = m.group(2)
                params_str = m.group(3)
                params = [p.strip() for p in params_str.split(",") if p.strip()]
                # Exclude self, cls
                params = [p for p in params if p not in ("self", "cls")]
                if len(params) > max_params:
                    fixes.append(HealingFix(
                        category=HealingCategory.UNUSED_VARIABLE,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.REPLACE,
                        description=f"Function '{func_name}' has {len(params)} params (max {max_params}) — consider using a dataclass/dict",
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
        else:
            # C-style function declaration
            m = re.match(r"^.*\b(\w+)\s*\(([^)]+)\)\s*[{:]?\s*$", stripped)
            if m and not stripped.startswith("if") and not stripped.startswith("while") and not stripped.startswith("for"):
                func_name = m.group(1)
                params_str = m.group(2)
                params = [p.strip() for p in params_str.split(",") if p.strip()]
                if len(params) > max_params:
                    fixes.append(HealingFix(
                        category=HealingCategory.UNUSED_VARIABLE,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.REPLACE,
                        description=f"Function '{func_name}' has {len(params)} params (max {max_params}) — consider refactoring",
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


# ── Rule: Function too long ───────────────────────────────────────────

@healing_rule(
    rule_id="UNI_CMPLX_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect functions longer than 50 lines",
)
def detect_long_function(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect functions/methods with too many lines."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()
    max_lines = 50

    if lang in ("python", "py"):
        # Find function definitions
        for idx, line in enumerate(lines):
            m = re.match(r"^(\s*)(async\s+)?def\s+(\w+)", line)
            if not m:
                continue
            func_indent = len(m.group(1))
            func_name = m.group(3)

            # Find function end
            func_end = idx + 1
            while func_end < len(lines):
                if lines[func_end].strip() and (len(lines[func_end]) - len(lines[func_end].lstrip())) <= func_indent:
                    break
                func_end += 1

            length = func_end - idx
            if length > max_lines:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"Function '{func_name}' is {length} lines (max {max_lines}) — consider splitting",
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

    else:
        # C-style: count lines between { }
        brace_stack = []
        func_starts = {}

        for idx, line in enumerate(lines):
            stripped = line.strip()
            # Heuristic: function starts with identifier(params) {
            if re.match(r"^.*\b\w+\s*\([^)]*\)\s*\{", stripped):
                brace_stack.append(idx)
                func_starts[idx] = stripped

            for ch in stripped:
                if ch == "{":
                    if idx not in [s for s in brace_stack]:
                        brace_stack.append(idx)
                elif ch == "}":
                    if brace_stack:
                        start = brace_stack.pop()
                        length = idx - start
                        if start in func_starts and length > max_lines:
                            fixes.append(HealingFix(
                                category=HealingCategory.UNUSED_VARIABLE,
                                severity=HealingSeverity.LOW,
                                action=HealingAction.REPLACE,
                                description=f"Function is {length} lines (max {max_lines}) — consider splitting",
                                line=start,
                                column=0,
                                end_line=start,
                                end_column=len(lines[start]),
                                original_text="",
                                replacement_text="",
                                confidence=0.50,
                                is_safe=True,
                                affects_logic=False,
                            ))

    return fixes
