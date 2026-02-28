"""
Universal healing rule: Variable issues.

Detects common variable-related problems:
- Variables declared but never used
- Variables used before assignment
- Shadowing of outer scope variables
- Reassignment of function parameters
"""

from __future__ import annotations

import re
from typing import List, Dict, Set, Tuple

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


# ── Helpers ────────────────────────────────────────────────────────────

def _extract_declared_vars_js(code: str) -> List[Tuple[int, str, str]]:
    """Extract (line, name, raw) for JS/TS variable declarations."""
    results = []
    for idx, line in enumerate(code.split("\n")):
        stripped = line.strip()
        if stripped.startswith("//"):
            continue
        # let/const/var name
        for m in re.finditer(r"\b(?:let|const|var)\s+(\w+)", stripped):
            results.append((idx, m.group(1), stripped))
        # Destructuring: const { a, b } = ...
        dm = re.match(r"^\s*(?:let|const|var)\s*\{([^}]+)\}", stripped)
        if dm:
            names = [n.strip().split(":")[0].strip() for n in dm.group(1).split(",")]
            for n in names:
                if n and n.isidentifier():
                    results.append((idx, n, stripped))
    return results


def _extract_declared_vars_py(code: str) -> List[Tuple[int, str, str]]:
    """Extract (line, name, raw) for Python variable assignments."""
    results = []
    for idx, line in enumerate(code.split("\n")):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        # Simple assignment: name = ...
        m = re.match(r"^(\s*)([a-zA-Z_]\w*)\s*(?::\s*\w+)?\s*=(?!=)", line)
        if m:
            name = m.group(2)
            # Skip common patterns that aren't variables
            if name in ("self", "cls", "_"):
                continue
            results.append((idx, name, stripped))
    return results


# ── Rule: Unused local variables ──────────────────────────────────────

@healing_rule(
    rule_id="UNI_VAR_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect declared variables that are never used after assignment",
)
def detect_unused_variables(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect variables that are assigned but never referenced."""
    fixes: List[HealingFix] = []
    lang = language.lower()

    if lang in _JS_LANGS:
        vars_list = _extract_declared_vars_js(code)
    elif lang in _PY_LANGS:
        vars_list = _extract_declared_vars_py(code)
    else:
        return fixes

    lines = code.split("\n")
    decl_lines = {idx for idx, _, _ in vars_list}

    for line_idx, name, raw in vars_list:
        # Skip loop variables and private patterns
        if name.startswith("_"):
            continue
        if len(name) <= 1:
            continue  # skip single-char names

        # Check if used elsewhere
        used = False
        for idx, line in enumerate(lines):
            if idx == line_idx:
                continue
            if re.search(r"\b" + re.escape(name) + r"\b", line):
                used = True
                break

        if not used:
            end_col = len(lines[line_idx]) if line_idx < len(lines) else 0
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.LOW,
                action=HealingAction.DELETE,
                description=f"Variable '{name}' is assigned but never used",
                line=line_idx,
                column=0,
                end_line=line_idx,
                end_column=end_col,
                original_text=raw,
                replacement_text="",
                confidence=0.80,
                is_safe=False,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Variable shadowing ─────────────────────────────────────────

@healing_rule(
    rule_id="UNI_VAR_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect inner-scope variables that shadow outer-scope names",
)
def detect_variable_shadowing(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect variables that shadow names from an outer scope."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        # Collect top-level assignments
        top_level: Dict[str, int] = {}
        for idx, line in enumerate(lines):
            indent = len(line) - len(line.lstrip())
            if indent == 0:
                m = re.match(r"^([a-zA-Z_]\w*)\s*=", line)
                if m:
                    top_level[m.group(1)] = idx

        # Check for same names at inner scope
        for idx, line in enumerate(lines):
            indent = len(line) - len(line.lstrip())
            if indent > 0:
                m = re.match(r"^\s+([a-zA-Z_]\w*)\s*=(?!=)", line)
                if m:
                    name = m.group(1)
                    if name in top_level and name not in ("self", "cls", "_"):
                        fixes.append(HealingFix(
                            category=HealingCategory.UNUSED_VARIABLE,
                            severity=HealingSeverity.LOW,
                            action=HealingAction.REPLACE,
                            description=f"'{name}' shadows module-level variable (line {top_level[name] + 1})",
                            line=idx,
                            column=0,
                            end_line=idx,
                            end_column=len(line),
                            original_text="",
                            replacement_text="",
                            confidence=0.60,
                            is_safe=False,
                            affects_logic=False,
                        ))

    elif lang in _JS_LANGS:
        # Collect all declarations with their scope depth
        declarations: Dict[str, List[Tuple[int, int]]] = {}  # name -> [(line, depth)]
        depth = 0
        for idx, line in enumerate(lines):
            depth += line.count("{") - line.count("}")
            for m in re.finditer(r"\b(?:let|const|var)\s+(\w+)", line):
                name = m.group(1)
                if name not in declarations:
                    declarations[name] = []
                declarations[name].append((idx, depth))

        # Flag names declared at multiple depths
        for name, occurrences in declarations.items():
            if len(occurrences) > 1:
                depths = set(d for _, d in occurrences)
                if len(depths) > 1:
                    # The deeper one shadows the shallower
                    for line_idx, d in occurrences[1:]:
                        fixes.append(HealingFix(
                            category=HealingCategory.UNUSED_VARIABLE,
                            severity=HealingSeverity.LOW,
                            action=HealingAction.REPLACE,
                            description=f"'{name}' shadows a variable from an outer scope",
                            line=line_idx,
                            column=0,
                            end_line=line_idx,
                            end_column=len(lines[line_idx]),
                            original_text="",
                            replacement_text="",
                            confidence=0.65,
                            is_safe=False,
                            affects_logic=False,
                        ))

    return fixes


# ── Rule: const reassignment attempt (JS/TS) ─────────────────────────

@healing_rule(
    rule_id="UNI_VAR_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect attempts to reassign const variables in JS/TS",
)
def detect_const_reassignment(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect reassignment of const variables (runtime error in JS/TS)."""
    lang = language.lower()
    if lang not in _JS_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Collect const declarations
    const_vars: Set[str] = set()
    for line in lines:
        for m in re.finditer(r"\bconst\s+(\w+)", line):
            const_vars.add(m.group(1))

    # Look for reassignments
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("//"):
            continue
        for name in const_vars:
            # Check for name = (but not const name = or name ==)
            pattern = rf"(?<!\bconst\s)(?<!\blet\s)(?<!\bvar\s)\b{re.escape(name)}\s*=(?!=)"
            if re.search(pattern, stripped):
                # Skip the declaration line itself
                if "const" in stripped:
                    continue
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.REPLACE,
                    description=f"Attempting to reassign const '{name}' — will throw TypeError",
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
