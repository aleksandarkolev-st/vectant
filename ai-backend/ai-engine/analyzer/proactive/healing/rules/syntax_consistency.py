"""
Universal healing rule: Syntax consistency.

Detects miscellaneous syntax consistency issues:
- Inconsistent semicolon usage (some lines have, some don't)
- Missing/extra commas in object/array literals
- Dangling commas in function parameters
- Misplaced keywords
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

_JS_LANGS = {"javascript", "js", "jsx", "typescript", "ts", "tsx"}
_C_STYLE_SEMI = {
    "javascript", "js", "jsx", "typescript", "ts", "tsx",
    "c", "cpp", "c++", "cxx", "java", "csharp", "cs",
}


# ── Rule: Inconsistent semicolons in JS/TS ───────────────────────────

@healing_rule(
    rule_id="UNI_SYN_001",
    category=HealingCategory.MISSING_SEMICOLON,
    description="Detect inconsistent semicolon usage within a file (majority wins)",
)
def detect_inconsistent_semicolons(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect files where semicolons are used inconsistently."""
    lang = language.lower()
    if lang not in _JS_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Count lines ending with ; vs lines ending with non-; statement
    semi_count = 0
    no_semi_count = 0
    statement_lines = []

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("//") or stripped.startswith("/*") or stripped.startswith("*"):
            continue
        if stripped.endswith("{") or stripped.endswith("}") or stripped.endswith("(") or stripped.endswith(","):
            continue
        if stripped.startswith("import ") or stripped.startswith("export "):
            continue

        if stripped.endswith(";"):
            semi_count += 1
            statement_lines.append((idx, True))
        elif re.match(r".*\w.*$", stripped) and not stripped.endswith("{"):
            no_semi_count += 1
            statement_lines.append((idx, False))

    if semi_count == 0 or no_semi_count == 0:
        return fixes  # consistent

    # Determine majority
    use_semi = semi_count > no_semi_count

    for line_idx, has_semi in statement_lines:
        if use_semi and not has_semi:
            # Should have semicolon
            col = len(lines[line_idx].rstrip())
            fixes.append(HealingFix(
                category=HealingCategory.MISSING_SEMICOLON,
                severity=HealingSeverity.LOW,
                action=HealingAction.INSERT,
                description="Add semicolon for consistency (file uses semicolons)",
                line=line_idx,
                column=col,
                end_line=line_idx,
                end_column=col,
                original_text="",
                replacement_text=";",
                confidence=0.80,
                is_safe=True,
                affects_logic=False,
            ))
        elif not use_semi and has_semi:
            # Shouldn't have semicolon
            stripped = lines[line_idx].rstrip()
            if stripped.endswith(";"):
                col = len(stripped) - 1
                fixes.append(HealingFix(
                    category=HealingCategory.MISSING_SEMICOLON,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.DELETE,
                    description="Remove semicolon for consistency (file omits semicolons)",
                    line=line_idx,
                    column=col,
                    end_line=line_idx,
                    end_column=col + 1,
                    original_text=";",
                    replacement_text="",
                    confidence=0.80,
                    is_safe=True,
                    affects_logic=False,
                ))

    return fixes


# ── Rule: Missing comma in object/array ───────────────────────────────

@healing_rule(
    rule_id="UNI_SYN_002",
    category=HealingCategory.TRAILING_COMMA,
    description="Detect missing commas between object/array elements",
)
def detect_missing_comma(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect likely missing commas between elements."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()

    # Heuristic: look for lines inside {}/[] that don't end with ,
    in_block = 0
    in_array = 0

    for idx, line in enumerate(lines):
        stripped = line.strip()

        in_block += stripped.count("{") - stripped.count("}")
        in_array += stripped.count("[") - stripped.count("]")

        if (in_block > 0 or in_array > 0) and idx + 1 < len(lines):
            next_stripped = lines[idx + 1].strip()
            # Current line is a value, next line is also a value
            if (stripped and
                not stripped.endswith(",") and
                not stripped.endswith("{") and
                not stripped.endswith("[") and
                not stripped.endswith("(") and
                not stripped.endswith(":") and
                not stripped.startswith("//") and
                not stripped.startswith("#") and
                not stripped.startswith("}") and
                not stripped.startswith("]") and
                next_stripped and
                not next_stripped.startswith("}") and
                not next_stripped.startswith("]") and
                not next_stripped.startswith("//") and
                not next_stripped.startswith("#")):

                # Check if both lines look like key-value or array items
                if lang in _JS_LANGS or lang == "json":
                    if re.match(r'^[\w"\']+\s*:', stripped) and re.match(r'^[\w"\']+\s*:', next_stripped):
                        col = len(stripped)
                        actual_col = len(line.rstrip())
                        fixes.append(HealingFix(
                            category=HealingCategory.TRAILING_COMMA,
                            severity=HealingSeverity.MODERATE,
                            action=HealingAction.INSERT,
                            description="Likely missing comma between object properties",
                            line=idx,
                            column=actual_col,
                            end_line=idx,
                            end_column=actual_col,
                            original_text="",
                            replacement_text=",",
                            confidence=0.82,
                            is_safe=True,
                            affects_logic=False,
                        ))

    return fixes


# ── Rule: Extra comma before closing bracket ──────────────────────────

@healing_rule(
    rule_id="UNI_SYN_003",
    category=HealingCategory.TRAILING_COMMA,
    description="Detect trailing commas before ) in function calls/defs (non-standard in some contexts)",
)
def detect_trailing_comma_in_call(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect trailing commas before closing parenthesis in function calls."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()

    # In Python, trailing commas are valid but in C/Java they're not
    if lang in ("python", "py"):
        return fixes  # trailing commas are idiomatic in Python

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("//") or stripped.startswith("#"):
            continue

        # Find ,) pattern
        for m in re.finditer(r",\s*\)", line):
            fixes.append(HealingFix(
                category=HealingCategory.TRAILING_COMMA,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description="Remove trailing comma before closing parenthesis",
                line=idx,
                column=m.start(),
                end_line=idx,
                end_column=m.end(),
                original_text=m.group(0),
                replacement_text=")",
                confidence=0.88,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes
