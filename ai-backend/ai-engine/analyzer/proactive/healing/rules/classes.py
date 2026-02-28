"""
Universal healing rule: Class and OOP patterns.

Detects common class/object-oriented anti-patterns:
- Missing self/this parameter
- Unused class methods
- God class detection (too many methods)
- Missing super().__init__() calls
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


# ── Rule: Missing self parameter (Python) ─────────────────────────────

@healing_rule(
    rule_id="UNI_CLS_001",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect Python instance methods missing 'self' parameter",
)
def detect_missing_self(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect methods inside a class that lack self as first parameter."""
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    in_class = False
    class_indent = 0

    for idx, line in enumerate(lines):
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())

        # Track class context
        if re.match(r"^class\s+\w+", stripped):
            in_class = True
            class_indent = indent
            continue

        if in_class and stripped and indent <= class_indent and not stripped.startswith("#"):
            in_class = False

        if not in_class:
            continue

        # Check method definitions
        m = re.match(r"^(\s*)def\s+(\w+)\s*\(([^)]*)\)", line)
        if not m:
            continue

        method_name = m.group(2)
        params = m.group(3).strip()

        # Skip static methods and class methods (check decorator above)
        if idx > 0:
            prev = lines[idx - 1].strip()
            if prev in ("@staticmethod", "@classmethod"):
                continue

        # Skip dunder methods with no params
        if method_name.startswith("__") and method_name.endswith("__"):
            if not params:
                # Even dunder methods need self (except very rare cases)
                fixes.append(HealingFix(
                    category=HealingCategory.UNDECLARED_VARIABLE,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.INSERT,
                    description=f"Method '{method_name}' missing 'self' parameter",
                    line=idx,
                    column=line.index("(") + 1,
                    end_line=idx,
                    end_column=line.index("(") + 1,
                    original_text="",
                    replacement_text="self",
                    confidence=0.90,
                    is_safe=True,
                    affects_logic=False,
                ))
            continue

        # Regular methods should start with self
        first_param = params.split(",")[0].strip().split(":")[0].strip() if params else ""
        if first_param != "self":
            paren_pos = line.index("(")
            fixes.append(HealingFix(
                category=HealingCategory.UNDECLARED_VARIABLE,
                severity=HealingSeverity.CRITICAL,
                action=HealingAction.INSERT,
                description=f"Method '{method_name}' missing 'self' parameter",
                line=idx,
                column=paren_pos + 1,
                end_line=idx,
                end_column=paren_pos + 1,
                original_text="",
                replacement_text="self, " if params else "self",
                confidence=0.88,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Missing super().__init__() ──────────────────────────────────

@healing_rule(
    rule_id="UNI_CLS_002",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect child classes that override __init__ without calling super().__init__()",
)
def detect_missing_super_init(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect classes that inherit and override __init__ without super() call."""
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        # Find classes with base classes
        m = re.match(r"^class\s+(\w+)\s*\(([^)]+)\)\s*:", line)
        if not m:
            continue
        class_name = m.group(1)
        bases = m.group(2).strip()

        # Skip if base is just object
        if bases in ("object", ""):
            continue

        class_indent = len(line) - len(line.lstrip())

        # Find __init__ in this class
        init_line = -1
        for j in range(idx + 1, len(lines)):
            jline = lines[j]
            jindent = len(jline) - len(jline.lstrip())
            if jline.strip() and jindent <= class_indent:
                break
            if re.match(r"^\s+def\s+__init__\s*\(", jline):
                init_line = j
                break

        if init_line < 0:
            continue

        # Check if super().__init__ is called
        init_indent = len(lines[init_line]) - len(lines[init_line].lstrip())
        has_super = False
        for j in range(init_line + 1, len(lines)):
            jline = lines[j]
            jindent = len(jline) - len(jline.lstrip())
            if jline.strip() and jindent <= init_indent:
                break
            if "super().__init__" in jline or "super().__init__" in jline:
                has_super = True
                break
            if f"{bases.split(',')[0].strip()}.__init__" in jline:
                has_super = True
                break

        if not has_super:
            fixes.append(HealingFix(
                category=HealingCategory.UNDECLARED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.INSERT,
                description=f"'{class_name}.__init__' doesn't call super().__init__()",
                line=init_line,
                column=0,
                end_line=init_line,
                end_column=len(lines[init_line]),
                original_text="",
                replacement_text="",
                confidence=0.80,
                is_safe=False,
                affects_logic=True,
            ))

    return fixes


# ── Rule: God class (too many methods) ────────────────────────────────

@healing_rule(
    rule_id="UNI_CLS_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect classes with too many methods (> 15) suggesting refactoring",
)
def detect_god_class(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect classes with an excessive number of methods."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")
    max_methods = 15

    if lang in _PY_LANGS:
        for idx, line in enumerate(lines):
            m = re.match(r"^class\s+(\w+)", line)
            if not m:
                continue
            class_name = m.group(1)
            class_indent = len(line) - len(line.lstrip())

            method_count = 0
            for j in range(idx + 1, len(lines)):
                jline = lines[j]
                if jline.strip() and (len(jline) - len(jline.lstrip())) <= class_indent:
                    break
                if re.match(r"^\s+(?:async\s+)?def\s+\w+", jline):
                    method_count += 1

            if method_count > max_methods:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"Class '{class_name}' has {method_count} methods (max {max_methods}) — consider splitting",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text="",
                    replacement_text="",
                    confidence=0.50,
                    is_safe=True,
                    affects_logic=False,
                ))

    elif lang in _JS_LANGS:
        for idx, line in enumerate(lines):
            m = re.match(r"^\s*(?:export\s+)?class\s+(\w+)", line)
            if not m:
                continue
            class_name = m.group(1)
            depth = 0
            method_count = 0
            for j in range(idx, len(lines)):
                depth += lines[j].count("{") - lines[j].count("}")
                if re.match(r"^\s+(?:async\s+)?(?:static\s+)?\w+\s*\(", lines[j]) and j > idx:
                    method_count += 1
                if depth == 0 and j > idx:
                    break

            if method_count > max_methods:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"Class '{class_name}' has {method_count} methods (max {max_methods}) — consider splitting",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text="",
                    replacement_text="",
                    confidence=0.50,
                    is_safe=True,
                    affects_logic=False,
                ))

    return fixes
