"""
Universal healing rule: Whitespace and indentation.

Detects and fixes indentation inconsistencies, mixed tabs/spaces,
excessive blank lines, and other whitespace issues across all languages.
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


# ── Rule: Mixed tabs and spaces ───────────────────────────────────────

@healing_rule(
    rule_id="UNI_WS_001",
    category=HealingCategory.INCONSISTENT_INDENTATION,
    description="Detect lines that mix tabs and spaces for indentation",
)
def detect_mixed_indentation(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect lines where indentation mixes tabs and spaces."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        if not line or not line[0] in (" ", "\t"):
            continue

        # Get the leading whitespace
        leading = ""
        for ch in line:
            if ch in (" ", "\t"):
                leading += ch
            else:
                break

        if not leading:
            continue

        has_tabs = "\t" in leading
        has_spaces = " " in leading

        if has_tabs and has_spaces:
            # Convert to spaces (4 per tab) — most universal convention
            fixed_leading = leading.replace("\t", "    ")
            fixed_line = fixed_leading + line[len(leading):]

            fixes.append(HealingFix(
                category=HealingCategory.INCONSISTENT_INDENTATION,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description="Fix mixed tabs and spaces (convert tabs to 4 spaces)",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text=line,
                replacement_text=fixed_line,
                confidence=0.90,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Excessive blank lines ───────────────────────────────────────

@healing_rule(
    rule_id="UNI_WS_002",
    category=HealingCategory.TRAILING_WHITESPACE,
    description="Detect more than 2 consecutive blank lines",
)
def detect_excessive_blank_lines(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect runs of more than 2 consecutive blank lines."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    blank_run_start = -1
    blank_count = 0

    for idx, line in enumerate(lines):
        if line.strip() == "":
            if blank_count == 0:
                blank_run_start = idx
            blank_count += 1
        else:
            if blank_count > 2:
                # Keep 2 blank lines, remove the rest
                excess_start = blank_run_start + 2
                excess_end = blank_run_start + blank_count - 1
                excess_count = blank_count - 2

                fixes.append(HealingFix(
                    category=HealingCategory.TRAILING_WHITESPACE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.DELETE,
                    description=f"Remove {excess_count} excess blank line(s) (max 2 consecutive)",
                    line=excess_start,
                    column=0,
                    end_line=excess_end,
                    end_column=0,
                    original_text="\n" * excess_count,
                    replacement_text="",
                    confidence=0.95,
                    is_safe=True,
                    affects_logic=False,
                ))
            blank_count = 0

    return fixes


# ── Rule: Whitespace-only lines ───────────────────────────────────────

@healing_rule(
    rule_id="UNI_WS_003",
    category=HealingCategory.TRAILING_WHITESPACE,
    description="Detect lines that contain only whitespace (should be truly empty)",
)
def detect_whitespace_only_lines(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect lines that are only whitespace but not empty."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        if line and line.strip() == "":
            fixes.append(HealingFix(
                category=HealingCategory.TRAILING_WHITESPACE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description="Remove whitespace from blank line",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text=line,
                replacement_text="",
                confidence=1.0,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Inconsistent indentation width ──────────────────────────────

@healing_rule(
    rule_id="UNI_WS_004",
    category=HealingCategory.INCONSISTENT_INDENTATION,
    description="Detect indentation that doesn't match the file's dominant indent width",
)
def detect_inconsistent_indent_width(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect lines whose indent width is inconsistent with the file."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()

    # Tabs-based languages skip this check
    if lang in {"go", "makefile", "make"}:
        return fixes

    # Determine dominant indent: count indent increments
    indent_counts = {2: 0, 4: 0}
    prev_indent = 0
    for line in lines:
        if not line.strip():
            continue
        spaces = len(line) - len(line.lstrip(" "))
        if "\t" in line[:spaces]:
            continue  # mixed — handled by UNI_WS_001
        diff = spaces - prev_indent
        if diff > 0:
            if diff == 2:
                indent_counts[2] += 1
            elif diff == 4:
                indent_counts[4] += 1
        prev_indent = spaces

    dominant = 4 if indent_counts[4] >= indent_counts[2] else 2

    # Now check for lines that use the non-dominant width
    for idx, line in enumerate(lines):
        if not line.strip():
            continue
        spaces = len(line) - len(line.lstrip(" "))
        if "\t" in line[:spaces]:
            continue
        if spaces == 0:
            continue
        if spaces % dominant != 0:
            # This line has an odd indentation
            nearest = round(spaces / dominant) * dominant
            if nearest == spaces:
                continue
            new_leading = " " * nearest
            fixed = new_leading + line.lstrip(" ")
            fixes.append(HealingFix(
                category=HealingCategory.INCONSISTENT_INDENTATION,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=f"Fix indentation: {spaces} spaces → {nearest} spaces (dominant indent: {dominant})",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text=line,
                replacement_text=fixed,
                confidence=0.80,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes
