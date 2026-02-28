"""
Universal healing rule: React and JSX specific patterns.

Detects:
- Missing key prop in list rendering
- useState setter misuse
- useEffect missing dependency array
- Direct state mutation
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


_JSX_LANGS = {"javascript", "js", "jsx", "typescript", "ts", "tsx"}


# ── Rule: Missing key prop ────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_REACT_001",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect .map() rendering JSX without key prop",
)
def detect_missing_key(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _JSX_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        # Look for .map( returning JSX
        if ".map(" not in line:
            continue

        # Check if the returned JSX element has a key prop
        has_key = False
        depth = 0
        for j in range(idx, min(idx + 10, len(lines))):
            jline = lines[j]
            if "key=" in jline or "key =" in jline:
                has_key = True
                break
            depth += jline.count("(") - jline.count(")")
            if depth <= 0 and j > idx:
                break

        # Check if JSX is returned (has < inside the map)
        map_block = "\n".join(lines[idx:min(idx + 10, len(lines))])
        has_jsx = bool(re.search(r"<\w+", map_block))

        if has_jsx and not has_key:
            fixes.append(HealingFix(
                category=HealingCategory.UNDECLARED_VARIABLE,
                severity=HealingSeverity.CRITICAL,
                action=HealingAction.INSERT,
                description="JSX elements in .map() missing 'key' prop",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text="",
                replacement_text="",
                confidence=0.88,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: useEffect missing deps ──────────────────────────────────────

@healing_rule(
    rule_id="UNI_REACT_002",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect useEffect calls without dependency array",
)
def detect_useeffect_no_deps(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _JSX_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        if "useEffect(" not in line:
            continue

        # Check if there's a dependency array
        paren_depth = 0
        found_comma = False
        found_bracket = False

        for j in range(idx, min(idx + 20, len(lines))):
            for ch in lines[j]:
                if ch == "(":
                    paren_depth += 1
                elif ch == ")":
                    paren_depth -= 1
                    if paren_depth == 0:
                        break
                elif ch == "," and paren_depth == 1:
                    found_comma = True
                elif ch == "[" and found_comma:
                    found_bracket = True
            if paren_depth == 0:
                break

        if not found_comma and not found_bracket:
            fixes.append(HealingFix(
                category=HealingCategory.UNDECLARED_VARIABLE,
                severity=HealingSeverity.CRITICAL,
                action=HealingAction.INSERT,
                description="useEffect without dependency array runs on every render",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text="",
                replacement_text="",
                confidence=0.85,
                is_safe=False,
                affects_logic=True,
            ))

    return fixes


# ── Rule: Direct state mutation ───────────────────────────────────────

@healing_rule(
    rule_id="UNI_REACT_003",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect direct mutation of React state (push/splice on state array)",
)
def detect_state_mutation(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _JSX_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Find useState declarations
    state_vars: set[str] = set()
    for line in lines:
        m = re.search(r"const\s+\[(\w+),\s*set\w+\]\s*=\s*useState", line)
        if m:
            state_vars.add(m.group(1))

    if not state_vars:
        return fixes

    # Check for direct mutations
    mutation_methods = {"push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill"}

    for idx, line in enumerate(lines):
        for var in state_vars:
            for method in mutation_methods:
                pattern = f"{var}.{method}("
                if pattern in line:
                    fixes.append(HealingFix(
                        category=HealingCategory.UNDECLARED_VARIABLE,
                        severity=HealingSeverity.CRITICAL,
                        action=HealingAction.REPLACE,
                        description=f"Direct mutation of state '{var}' via .{method}() — use setState with spread",
                        line=idx,
                        column=line.index(pattern),
                        end_line=idx,
                        end_column=line.index(pattern) + len(pattern),
                        original_text=pattern,
                        replacement_text=pattern,
                        confidence=0.90,
                        is_safe=False,
                        affects_logic=True,
                    ))

            # Check for direct property assignment
            prop_m = re.search(rf"{var}\.\w+\s*=\s*", line)
            if prop_m and f"set{var[0].upper()}{var[1:]}" not in line:
                fixes.append(HealingFix(
                    category=HealingCategory.UNDECLARED_VARIABLE,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.REPLACE,
                    description=f"Direct mutation of state '{var}' property — use setState with spread",
                    line=idx,
                    column=prop_m.start(),
                    end_line=idx,
                    end_column=prop_m.end(),
                    original_text="",
                    replacement_text="",
                    confidence=0.85,
                    is_safe=False,
                    affects_logic=True,
                ))

    return fixes
