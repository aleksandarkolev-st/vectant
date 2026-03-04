"""
Universal healing rule: Line length and formatting.

Detects and suggests fixes for overly long lines, missing spacing
around operators, and other formatting issues that apply universally.
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


# ── Rule: Line too long ───────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_FMT_001",
    category=HealingCategory.TRAILING_WHITESPACE,
    description="Detect lines exceeding maximum line length (120 chars default)",
)
def detect_long_lines(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect lines that exceed the maximum recommended length."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()

    # Adjust max length by language convention
    if lang in ("python", "py"):
        max_len = 88  # black default
    elif lang in ("go",):
        return fixes  # Go doesn't enforce line length
    else:
        max_len = 120  # general default

    for idx, line in enumerate(lines):
        # Skip URLs and long strings
        stripped = line.strip()
        if "http://" in stripped or "https://" in stripped:
            continue
        if stripped.startswith("#") or stripped.startswith("//"):
            continue
        if stripped.startswith("import ") or stripped.startswith("from "):
            continue

        if len(line) > max_len:
            fixes.append(HealingFix(
                category=HealingCategory.TRAILING_WHITESPACE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=f"Line is {len(line)} chars (max {max_len}) — consider breaking it up",
                line=idx,
                column=max_len,
                end_line=idx,
                end_column=len(line),
                original_text="",
                replacement_text="",
                confidence=0.50,  # low confidence — just informational
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Missing space around operators ──────────────────────────────

@healing_rule(
    rule_id="UNI_FMT_002",
    category=HealingCategory.TRAILING_WHITESPACE,
    description="Detect missing spaces around binary operators (=, +, -, etc.)",
)
def detect_missing_operator_spaces(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect missing spaces around assignment and comparison operators."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()

    # Skip languages where spacing is less conventional
    if lang in ("go", "makefile", "make"):
        return fixes

    # Operators that should have spaces around them
    # We only check assignment-like ones to be safe
    patterns = [
        # x=y → x = y  (but NOT ==, !=, <=, >=, +=, -=, etc.)
        (r"(\w)=(\w)", r"\1 = \2", "Add spaces around '='"),
    ]

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("//") or stripped.startswith("/*"):
            continue

        for pattern, repl, desc in patterns:
            for m in re.finditer(pattern, line):
                # Skip if this is part of ==, !=, <=, >=, +=, -=, etc.
                pos = m.start() + 1  # position of =
                if pos > 0 and line[pos - 1] in ("=", "!", "<", ">", "+", "-", "*", "/", "%", "&", "|", "^"):
                    continue
                if pos + 1 < len(line) and line[pos + 1] == "=":
                    continue

                # Skip inside strings
                in_s = in_d = False
                for i in range(pos):
                    if i > 0 and line[i - 1] == "\\":
                        continue
                    if line[i] == "'" and not in_d:
                        in_s = not in_s
                    elif line[i] == '"' and not in_s:
                        in_d = not in_d
                if in_s or in_d:
                    continue

                # Skip keyword arguments in Python
                if lang in ("python", "py"):
                    # Check if we're inside function call parens
                    depth = 0
                    for i in range(pos):
                        if line[i] == "(":
                            depth += 1
                        elif line[i] == ")":
                            depth -= 1
                    if depth > 0:
                        continue

                original = m.group(0)
                replacement = re.sub(pattern, repl, original)

                fixes.append(HealingFix(
                    category=HealingCategory.TRAILING_WHITESPACE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=desc,
                    line=idx,
                    column=m.start(),
                    end_line=idx,
                    end_column=m.end(),
                    original_text=original,
                    replacement_text=replacement,
                    confidence=0.80,
                    is_safe=True,
                    affects_logic=False,
                ))

    return fixes


# ── Rule: Multiple statements on one line ─────────────────────────────

@healing_rule(
    rule_id="UNI_FMT_003",
    category=HealingCategory.TRAILING_WHITESPACE,
    description="Detect multiple statements on a single line (separated by ;)",
)
def detect_multi_statement_line(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect multiple statements on one line separated by semicolons."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()

    # Skip languages where this is normal
    if lang in ("c", "cpp", "c++", "cxx"):
        return fixes

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("//"):
            continue

        # Count semicolons that are not in strings
        semi_count = 0
        in_s = in_d = False
        for i, ch in enumerate(stripped):
            if i > 0 and stripped[i - 1] == "\\":
                continue
            if ch == "'" and not in_d:
                in_s = not in_s
            elif ch == '"' and not in_s:
                in_d = not in_d
            elif ch == ";" and not in_s and not in_d:
                semi_count += 1

        # For C-style languages, 2+ semicolons = multiple statements
        # For Python, any semicolon = multiple statements
        threshold = 1 if lang in ("python", "py") else 2

        if semi_count >= threshold:
            fixes.append(HealingFix(
                category=HealingCategory.TRAILING_WHITESPACE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=f"Multiple statements on one line ({semi_count} semicolons) — consider splitting",
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
