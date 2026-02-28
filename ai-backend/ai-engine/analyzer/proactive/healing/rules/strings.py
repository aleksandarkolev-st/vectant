"""
Universal healing rule: String literal issues.

Detects and fixes common string-related problems:
- Inconsistent quote style within a file
- Unnecessary string concatenation that can be simplified
- Missing f-string prefix (Python)
- Template literal opportunities (JS/TS)
"""

from __future__ import annotations

import re
from typing import List, Dict

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


# ── Rule: Inconsistent quote style ────────────────────────────────────

@healing_rule(
    rule_id="UNI_STR_001",
    category=HealingCategory.MISMATCHED_QUOTES,
    description="Detect inconsistent quote style within a file (majority wins)",
)
def detect_inconsistent_quotes(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect files mixing single and double quotes inconsistently."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Count single vs double quote strings
    single_count = 0
    double_count = 0

    for line in lines:
        # Simple heuristic: count standalone string delimiters
        single_count += len(re.findall(r"(?<![\\])'\w", line))
        double_count += len(re.findall(r'(?<![\\])"\w', line))

    if single_count == 0 and double_count == 0:
        return fixes

    # Determine majority style
    if single_count > double_count * 1.5:
        dominant = "'"
        minority = '"'
    elif double_count > single_count * 1.5:
        dominant = '"'
        minority = "'"
    else:
        return fixes  # no clear majority

    # Now find minority-style strings and suggest conversion
    for idx, line in enumerate(lines):
        # Skip lines with both quote types (likely has embedded quotes)
        if "'" in line and '"' in line:
            continue

        # Find minority-quoted strings
        pattern = re.compile(
            rf"{re.escape(minority)}([^{re.escape(minority)}\\]*(?:\\.[^{re.escape(minority)}\\]*)*){re.escape(minority)}"
        )

        for m in pattern.finditer(line):
            content = m.group(1)
            # Skip if content contains the dominant quote (would need escaping)
            if dominant in content:
                continue

            original = m.group(0)
            replacement = dominant + content + dominant

            fixes.append(HealingFix(
                category=HealingCategory.MISMATCHED_QUOTES,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=f"Use {dominant} quotes for consistency (file uses {dominant} predominantly)",
                line=idx,
                column=m.start(),
                end_line=idx,
                end_column=m.end(),
                original_text=original,
                replacement_text=replacement,
                confidence=0.75,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Missing f-string prefix (Python) ────────────────────────────

@healing_rule(
    rule_id="UNI_STR_002",
    category=HealingCategory.UNCLOSED_STRING,
    description="Detect Python strings with {var} that are missing the f-prefix",
)
def detect_missing_fstring(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect Python strings that look like f-strings but lack the f prefix."""
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Match strings containing {identifier} that are NOT f-strings
    # e.g. "Hello {name}" instead of f"Hello {name}"
    fstring_pattern = re.compile(
        r'''(?<![fFbBrRuU])(['"])([^'"]*\{[a-zA-Z_]\w*\}[^'"]*)\1'''
    )

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue

        for m in fstring_pattern.finditer(line):
            quote = m.group(1)
            content = m.group(2)

            # Skip if it looks like a dict literal or format string
            if ".format(" in line:
                continue
            if "{{" in content or "}}" in content:
                continue  # escaped braces

            original = m.group(0)
            replacement = "f" + original

            fixes.append(HealingFix(
                category=HealingCategory.UNCLOSED_STRING,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.REPLACE,
                description=f"Add f-string prefix: {original[:30]}... → f{original[:30]}...",
                line=idx,
                column=m.start(),
                end_line=idx,
                end_column=m.end(),
                original_text=original,
                replacement_text=replacement,
                confidence=0.82,
                is_safe=False,  # changes runtime behaviour
                affects_logic=True,
            ))

    return fixes


# ── Rule: String concatenation simplification ─────────────────────────

@healing_rule(
    rule_id="UNI_STR_003",
    category=HealingCategory.UNCLOSED_STRING,
    description="Detect string concatenation that can be simplified",
)
def detect_string_concat(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect adjacent string literal concatenation like 'a' + 'b'."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Match: "str1" + "str2" or 'str1' + 'str2'
    concat_pattern = re.compile(
        r'''(['"])([^'"]*)\1\s*\+\s*\1([^'"]*)\1'''
    )

    for idx, line in enumerate(lines):
        for m in concat_pattern.finditer(line):
            quote = m.group(1)
            left = m.group(2)
            right = m.group(3)
            original = m.group(0)
            replacement = f"{quote}{left}{right}{quote}"

            fixes.append(HealingFix(
                category=HealingCategory.UNCLOSED_STRING,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description="Merge adjacent string literals",
                line=idx,
                column=m.start(),
                end_line=idx,
                end_column=m.end(),
                original_text=original,
                replacement_text=replacement,
                confidence=0.90,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Template literal opportunity (JS/TS) ────────────────────────

@healing_rule(
    rule_id="UNI_STR_004",
    category=HealingCategory.UNCLOSED_STRING,
    description="Detect JS/TS string concatenation with variables that can use template literals",
)
def detect_template_literal_opportunity(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect 'str' + var + 'str' patterns in JS/TS that can be template literals."""
    lang = language.lower()
    if lang not in _JS_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Simple pattern: "text" + variable + "text"
    pattern = re.compile(
        r"""(['"])([^'"]*)\1\s*\+\s*(\w+)\s*\+\s*\1([^'"]*)\1"""
    )

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("//"):
            continue

        for m in pattern.finditer(line):
            quote = m.group(1)
            left_text = m.group(2)
            variable = m.group(3)
            right_text = m.group(4)
            original = m.group(0)

            replacement = f"`{left_text}${{{variable}}}{right_text}`"

            fixes.append(HealingFix(
                category=HealingCategory.UNCLOSED_STRING,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=f"Use template literal instead of string concatenation",
                line=idx,
                column=m.start(),
                end_line=idx,
                end_column=m.end(),
                original_text=original,
                replacement_text=replacement,
                confidence=0.88,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes
