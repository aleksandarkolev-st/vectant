"""
Universal healing rule: Return statement patterns.

Detects common return-statement issues:
- Inconsistent return (some paths return value, others don't)
- Unnecessary else after return
- Implicit None return in functions that return values
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
_C_STYLE_LANGS = {
    "javascript", "js", "jsx", "typescript", "ts", "tsx",
    "c", "cpp", "c++", "cxx", "java", "csharp", "cs",
    "go", "rust", "rs", "swift", "kotlin", "dart",
}


# ── Rule: Unnecessary else after return ───────────────────────────────

@healing_rule(
    rule_id="UNI_RET_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect unnecessary 'else' after a return/throw statement",
)
def detect_unnecessary_else_after_return(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect else blocks that are unnecessary because the if-branch returns."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        for idx in range(len(lines) - 1):
            stripped = lines[idx].strip()
            if stripped.startswith("return ") or stripped == "return":
                # Check if next non-blank line is else:
                next_idx = idx + 1
                while next_idx < len(lines) and not lines[next_idx].strip():
                    next_idx += 1
                if next_idx < len(lines):
                    next_stripped = lines[next_idx].strip()
                    if next_stripped == "else:":
                        indent = len(lines[next_idx]) - len(lines[next_idx].lstrip())
                        # Verify indentation matches (same level as the if)
                        return_indent = len(lines[idx]) - len(lines[idx].lstrip())
                        if return_indent > indent:
                            continue  # return is inside the if block
                        fixes.append(HealingFix(
                            category=HealingCategory.UNUSED_VARIABLE,
                            severity=HealingSeverity.LOW,
                            action=HealingAction.DELETE,
                            description="Remove unnecessary 'else' after return statement",
                            line=next_idx,
                            column=0,
                            end_line=next_idx,
                            end_column=len(lines[next_idx]),
                            original_text=lines[next_idx],
                            replacement_text="",
                            confidence=0.82,
                            is_safe=True,
                            affects_logic=False,
                        ))

    elif lang in _C_STYLE_LANGS:
        for idx in range(len(lines) - 1):
            stripped = lines[idx].strip()
            if stripped.startswith("return ") or stripped.startswith("return;"):
                next_idx = idx + 1
                # Skip closing brace
                while next_idx < len(lines) and lines[next_idx].strip() in ("", "}"):
                    next_idx += 1
                if next_idx < len(lines):
                    next_stripped = lines[next_idx].strip()
                    if next_stripped.startswith("else") and ("{" in next_stripped or next_idx + 1 < len(lines)):
                        fixes.append(HealingFix(
                            category=HealingCategory.UNUSED_VARIABLE,
                            severity=HealingSeverity.LOW,
                            action=HealingAction.DELETE,
                            description="Remove unnecessary 'else' after return (early return pattern)",
                            line=next_idx,
                            column=0,
                            end_line=next_idx,
                            end_column=len(lines[next_idx]),
                            original_text=lines[next_idx],
                            replacement_text=lines[next_idx].replace("} else {", "").replace("else {", "").replace("} else", "").replace("else", ""),
                            confidence=0.75,
                            is_safe=True,
                            affects_logic=False,
                        ))

    return fixes


# ── Rule: Missing return in non-void function ─────────────────────────

@healing_rule(
    rule_id="UNI_RET_002",
    category=HealingCategory.MISSING_RETURN_TYPE,
    description="Detect functions that have some return-value paths but may fall through without returning",
)
def detect_inconsistent_return(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect functions where some paths return a value and others don't."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        # Find function definitions and check return consistency
        func_starts = []
        for idx, line in enumerate(lines):
            m = re.match(r"^(\s*)(async\s+)?def\s+(\w+)\s*\(", line)
            if m:
                indent = len(m.group(1))
                func_starts.append((idx, indent, m.group(3)))

        for i, (start, func_indent, name) in enumerate(func_starts):
            # Determine function end
            end = len(lines)
            if i + 1 < len(func_starts):
                end = func_starts[i + 1][0]
            else:
                # Find next line at same or less indentation
                for j in range(start + 1, len(lines)):
                    if lines[j].strip() and (len(lines[j]) - len(lines[j].lstrip())) <= func_indent:
                        end = j
                        break

            # Scan for returns
            has_return_value = False
            has_bare_return = False
            has_no_return_path = False

            for j in range(start + 1, end):
                stripped = lines[j].strip()
                if stripped.startswith("return ") and stripped != "return None":
                    has_return_value = True
                elif stripped == "return" or stripped == "return None":
                    has_bare_return = True

            if has_return_value and not has_bare_return:
                # Check if function can fall through
                last_code_line = ""
                for j in range(end - 1, start, -1):
                    if lines[j].strip():
                        last_code_line = lines[j].strip()
                        break
                if not last_code_line.startswith("return") and not last_code_line.startswith("raise"):
                    fixes.append(HealingFix(
                        category=HealingCategory.MISSING_RETURN_TYPE,
                        severity=HealingSeverity.MODERATE,
                        action=HealingAction.INSERT,
                        description=f"Function '{name}' may fall through without returning a value",
                        line=start,
                        column=0,
                        end_line=start,
                        end_column=len(lines[start]),
                        original_text="",
                        replacement_text="",
                        confidence=0.70,
                        is_safe=False,
                        affects_logic=False,
                    ))

    return fixes


# ── Rule: Return outside function (common beginner error) ─────────────

@healing_rule(
    rule_id="UNI_RET_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect return statements at module/global level",
)
def detect_return_outside_function(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect return statements at top level (outside any function)."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        for idx, line in enumerate(lines):
            stripped = line.strip()
            indent = len(line) - len(line.lstrip())
            if indent == 0 and (stripped.startswith("return ") or stripped == "return"):
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.DELETE,
                    description="'return' at module level — not inside any function",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text=stripped,
                    replacement_text="",
                    confidence=0.90,
                    is_safe=False,
                    affects_logic=True,
                ))

    return fixes
