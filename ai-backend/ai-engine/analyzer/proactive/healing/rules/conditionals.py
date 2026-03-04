"""
Universal healing rule: Conditional patterns.

Detects common conditional anti-patterns:
- Redundant conditions (if x then true else false)
- Nested ternary operators
- Unnecessary negation
- Empty if/else blocks
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


# ── Rule: Redundant boolean conditional ───────────────────────────────

@healing_rule(
    rule_id="UNI_COND_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect 'if x: return True else: return False' → 'return x'",
)
def detect_redundant_conditional(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect if/else blocks that just return True/False."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        for idx in range(len(lines) - 3):
            l1 = lines[idx].strip()
            # if <condition>:
            m = re.match(r"^if\s+(.+):\s*$", l1)
            if not m:
                continue
            condition = m.group(1)

            l2 = lines[idx + 1].strip() if idx + 1 < len(lines) else ""
            l3 = lines[idx + 2].strip() if idx + 2 < len(lines) else ""
            l4 = lines[idx + 3].strip() if idx + 3 < len(lines) else ""

            if l2 == "return True" and l3 == "else:" and l4 == "return False":
                indent = len(lines[idx]) - len(lines[idx].lstrip())
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"Simplify 'if {condition}: return True else: return False' → 'return bool({condition})'",
                    line=idx,
                    column=0,
                    end_line=idx + 3,
                    end_column=len(lines[idx + 3]),
                    original_text="",
                    replacement_text=" " * indent + f"return bool({condition})",
                    confidence=0.90,
                    is_safe=True,
                    affects_logic=False,
                ))
            elif l2 == "return False" and l3 == "else:" and l4 == "return True":
                indent = len(lines[idx]) - len(lines[idx].lstrip())
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"Simplify 'if {condition}: return False else: return True' → 'return not {condition}'",
                    line=idx,
                    column=0,
                    end_line=idx + 3,
                    end_column=len(lines[idx + 3]),
                    original_text="",
                    replacement_text=" " * indent + f"return not {condition}",
                    confidence=0.90,
                    is_safe=True,
                    affects_logic=False,
                ))

    elif lang in _JS_LANGS:
        for idx, line in enumerate(lines):
            stripped = line.strip()
            # Ternary: condition ? true : false
            m = re.match(r"return\s+(.+)\s*\?\s*true\s*:\s*false\s*;?$", stripped)
            if m:
                condition = m.group(1)
                indent = len(line) - len(line.lstrip())
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"Simplify 'condition ? true : false' → 'Boolean(condition)'",
                    line=idx,
                    column=indent,
                    end_line=idx,
                    end_column=len(line),
                    original_text=stripped,
                    replacement_text=f"return Boolean({condition});",
                    confidence=0.90,
                    is_safe=True,
                    affects_logic=False,
                ))

    return fixes


# ── Rule: Nested ternary ──────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_COND_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect nested ternary operators (hard to read)",
)
def detect_nested_ternary(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect nested ternary/conditional expressions."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()

    if lang in _PY_LANGS:
        # Python: x if cond1 else (y if cond2 else z)
        pattern = re.compile(r"\bif\b.+\belse\b.+\bif\b.+\belse\b")
    elif lang in _C_STYLE_LANGS:
        # C-style: cond1 ? x : cond2 ? y : z
        pattern = re.compile(r"\?.+\?.+:")
    else:
        return fixes

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("//"):
            continue

        if pattern.search(stripped):
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description="Nested ternary expression — consider using if/else for readability",
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


# ── Rule: Empty if/else block ─────────────────────────────────────────

@healing_rule(
    rule_id="UNI_COND_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect empty if or else blocks with no implementation",
)
def detect_empty_conditional(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect empty if/else blocks."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        for idx, line in enumerate(lines):
            stripped = line.strip()
            if re.match(r"^(if|elif|else)\b.*:\s*$", stripped):
                next_idx = idx + 1
                while next_idx < len(lines) and not lines[next_idx].strip():
                    next_idx += 1
                if next_idx < len(lines) and lines[next_idx].strip() in ("pass", "..."):
                    fixes.append(HealingFix(
                        category=HealingCategory.UNUSED_VARIABLE,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.INSERT,
                        description=f"Empty '{stripped.split()[0]}' block — add implementation or remove",
                        line=idx,
                        column=0,
                        end_line=next_idx,
                        end_column=len(lines[next_idx]),
                        original_text="",
                        replacement_text="",
                        confidence=0.65,
                        is_safe=True,
                        affects_logic=False,
                    ))

    elif lang in _C_STYLE_LANGS:
        for idx, line in enumerate(lines):
            stripped = line.strip()
            if re.match(r"^(if|else\s+if|else)\s*[\({]", stripped):
                # Find the opening brace
                brace_idx = idx
                while brace_idx < len(lines) and "{" not in lines[brace_idx]:
                    brace_idx += 1
                if brace_idx < len(lines):
                    next_idx = brace_idx + 1
                    while next_idx < len(lines) and not lines[next_idx].strip():
                        next_idx += 1
                    if next_idx < len(lines) and lines[next_idx].strip() == "}":
                        fixes.append(HealingFix(
                            category=HealingCategory.UNUSED_VARIABLE,
                            severity=HealingSeverity.LOW,
                            action=HealingAction.INSERT,
                            description="Empty conditional block — add implementation or remove",
                            line=idx,
                            column=0,
                            end_line=next_idx,
                            end_column=len(lines[next_idx]),
                            original_text="",
                            replacement_text="",
                            confidence=0.65,
                            is_safe=True,
                            affects_logic=False,
                        ))

    return fixes
