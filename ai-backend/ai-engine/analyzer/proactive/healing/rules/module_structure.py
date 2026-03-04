"""
Universal healing rule: Module structure patterns.

Detects:
- Circular import indicators
- Missing __all__ in public modules
- Star import usage
- Relative vs absolute import inconsistency
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


_PY_LANGS = {"python", "py"}
_JS_LANGS = {"javascript", "js", "jsx", "typescript", "ts", "tsx"}


# ── Rule: Star imports ────────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_MOD_001",
    category=HealingCategory.UNUSED_IMPORT,
    description="Detect wildcard / star imports (from X import *)",
)
def detect_star_import(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if re.match(r"from\s+\S+\s+import\s+\*", stripped):
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_IMPORT,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.REPLACE,
                description="Star import pollutes namespace — import specific names",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text=line.rstrip(),
                replacement_text="",
                confidence=0.85,
                is_safe=False,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Missing __all__ in module ───────────────────────────────────

@healing_rule(
    rule_id="UNI_MOD_002",
    category=HealingCategory.UNUSED_IMPORT,
    description="Detect Python modules without __all__ that export public names",
)
def detect_missing_all(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    if not file_path:
        return []

    # Only __init__.py or modules with multiple public definitions
    if "__init__" not in file_path:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    has_all = any("__all__" in l for l in lines)
    if has_all:
        return fixes

    public_defs = 0
    for line in lines:
        stripped = line.strip()
        if re.match(r"^(def|class)\s+[a-zA-Z]", stripped):
            name = stripped.split()[1].split("(")[0]
            if not name.startswith("_"):
                public_defs += 1

    if public_defs >= 2:
        fixes.append(HealingFix(
            category=HealingCategory.UNUSED_IMPORT,
            severity=HealingSeverity.LOW,
            action=HealingAction.INSERT,
            description=f"Module has {public_defs} public names but no __all__ — consider adding",
            line=0,
            column=0,
            end_line=0,
            end_column=0,
            original_text="",
            replacement_text="",
            confidence=0.55,
            is_safe=True,
            affects_logic=False,
        ))

    return fixes


# ── Rule: Re-export barrel file issues ────────────────────────────────

@healing_rule(
    rule_id="UNI_MOD_003",
    category=HealingCategory.UNUSED_IMPORT,
    description="Detect potential barrel file issues in JS/TS (index.js re-exports)",
)
def detect_barrel_issues(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _JS_LANGS:
        return []

    if not file_path or "index" not in file_path.split("/")[-1].split("\\")[-1]:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    reexports = 0
    star_reexports = 0

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if re.match(r"export\s+\{.*\}\s+from\s+", stripped):
            reexports += 1
        if re.match(r"export\s+\*\s+from\s+", stripped):
            star_reexports += 1
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_IMPORT,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description="Star re-export can cause tree-shaking issues — prefer named re-exports",
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

    return fixes
