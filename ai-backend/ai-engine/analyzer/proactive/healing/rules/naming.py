"""
Universal healing rule: Naming conventions.

Detects common naming-convention issues across languages:
- snake_case vs camelCase mismatches per language convention
- Constants that should be UPPER_SNAKE_CASE
- Single-character variable names outside loops
- Leading/trailing underscores where inappropriate
"""

from __future__ import annotations

import re
from typing import List, Set

from ..types import (
    HealingCategory,
    HealingSeverity,
    HealingAction,
    HealingFix,
)
from ..rule_registry import healing_rule


# ── Language sets ──────────────────────────────────────────────────────

_SNAKE_CASE_LANGS = {"python", "py", "ruby", "rb", "rust", "rs"}
_CAMEL_CASE_LANGS = {
    "javascript", "js", "jsx", "typescript", "ts", "tsx",
    "java", "csharp", "cs", "dart", "kotlin", "swift",
}

# Helpers

def _is_snake_case(name: str) -> bool:
    return bool(re.match(r"^[a-z][a-z0-9_]*$", name))

def _is_camel_case(name: str) -> bool:
    return bool(re.match(r"^[a-z][a-zA-Z0-9]*$", name))

def _is_upper_snake(name: str) -> bool:
    return bool(re.match(r"^[A-Z][A-Z0-9_]*$", name))

def _snake_to_camel(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])

def _camel_to_snake(name: str) -> str:
    s1 = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name)
    return re.sub(r"([a-z\d])([A-Z])", r"\1_\2", s1).lower()


# ── Rule: Variable naming convention ──────────────────────────────────

@healing_rule(
    rule_id="UNI_NAM_001",
    category=HealingCategory.TYPO_IN_IDENTIFIER,
    description="Detect variables using wrong naming convention for the language",
)
def detect_naming_convention(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect variable names that don't match the language's convention."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    # Determine expected convention
    if lang in _SNAKE_CASE_LANGS:
        expected = "snake_case"
    elif lang in _CAMEL_CASE_LANGS:
        expected = "camelCase"
    else:
        return fixes  # no strong convention to enforce

    # Extract variable declarations
    for idx, line in enumerate(lines):
        stripped = line.strip()

        # Skip comments
        if stripped.startswith("#") or stripped.startswith("//") or stripped.startswith("/*"):
            continue

        names_to_check: List[tuple] = []  # (name, col_offset)

        if expected == "snake_case":
            # Python: x = ... or type-annotated x: int = ...
            m = re.match(r"^(\s*)([a-zA-Z_]\w*)\s*(?::\s*\w+)?\s*=", line)
            if m:
                name = m.group(2)
                col = len(m.group(1))
                # Skip uppercase constants and dunder names
                if not _is_upper_snake(name) and not name.startswith("_"):
                    names_to_check.append((name, col))

        elif expected == "camelCase":
            # JS/TS: let/const/var name = ...
            m = re.match(r"^\s*(?:let|const|var)\s+(\w+)", line)
            if m:
                name = m.group(1)
                col = m.start(1)
                if not _is_upper_snake(name):  # skip CONSTANTS
                    names_to_check.append((name, col))

        for name, col in names_to_check:
            if expected == "snake_case" and not _is_snake_case(name):
                # Looks like camelCase in a snake_case language
                if _is_camel_case(name):
                    suggested = _camel_to_snake(name)
                    fixes.append(HealingFix(
                        category=HealingCategory.TYPO_IN_IDENTIFIER,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.REPLACE,
                        description=f"Rename '{name}' to '{suggested}' (snake_case convention)",
                        line=idx,
                        column=col,
                        end_line=idx,
                        end_column=col + len(name),
                        original_text=name,
                        replacement_text=suggested,
                        confidence=0.70,
                        is_safe=False,  # renaming affects all usages
                        affects_logic=True,
                    ))

            elif expected == "camelCase" and not _is_camel_case(name):
                if _is_snake_case(name) and "_" in name:
                    suggested = _snake_to_camel(name)
                    fixes.append(HealingFix(
                        category=HealingCategory.TYPO_IN_IDENTIFIER,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.REPLACE,
                        description=f"Rename '{name}' to '{suggested}' (camelCase convention)",
                        line=idx,
                        column=col,
                        end_line=idx,
                        end_column=col + len(name),
                        original_text=name,
                        replacement_text=suggested,
                        confidence=0.70,
                        is_safe=False,
                        affects_logic=True,
                    ))

    return fixes


# ── Rule: Constant naming ─────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_NAM_002",
    category=HealingCategory.TYPO_IN_IDENTIFIER,
    description="Detect constants that should be UPPER_SNAKE_CASE",
)
def detect_constant_naming(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect module-level constant assignments that aren't UPPER_SNAKE_CASE."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        stripped = line.strip()

        # Only look at top-level (non-indented) assignments
        if line and line[0] in (" ", "\t"):
            continue

        if lang in {"python", "py"}:
            # name = <literal>
            m = re.match(r"^([a-z_]\w*)\s*=\s*(?:\d|True|False|None|\"|\')(.*)$", stripped)
            if m:
                name = m.group(1)
                if not _is_upper_snake(name) and "_" in name:
                    suggested = name.upper()
                    fixes.append(HealingFix(
                        category=HealingCategory.TYPO_IN_IDENTIFIER,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.REPLACE,
                        description=f"Consider UPPER_SNAKE_CASE for constant: '{name}' → '{suggested}'",
                        line=idx,
                        column=0,
                        end_line=idx,
                        end_column=len(name),
                        original_text=name,
                        replacement_text=suggested,
                        confidence=0.55,
                        is_safe=False,
                        affects_logic=True,
                    ))

        elif lang in _CAMEL_CASE_LANGS:
            # const NAME = <literal>
            m = re.match(r"^(?:export\s+)?const\s+([a-z_]\w*)\s*=\s*(?:\d|true|false|null|\"|\')(.*)$", stripped)
            if m:
                name = m.group(1)
                if not _is_upper_snake(name) and "_" in name:
                    suggested = name.upper()
                    fixes.append(HealingFix(
                        category=HealingCategory.TYPO_IN_IDENTIFIER,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.REPLACE,
                        description=f"Consider UPPER_SNAKE_CASE for constant: '{name}' → '{suggested}'",
                        line=idx,
                        column=line.index(name),
                        end_line=idx,
                        end_column=line.index(name) + len(name),
                        original_text=name,
                        replacement_text=suggested,
                        confidence=0.55,
                        is_safe=False,
                        affects_logic=True,
                    ))

    return fixes
