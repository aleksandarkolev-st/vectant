"""
Universal healing rule: Concurrency and thread-safety patterns.

Detects:
- Shared mutable state without locks
- Race condition indicators
- Missing thread-safety annotations
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
_JAVA_LANGS = {"java"}
_GO_LANGS = {"go", "golang"}


# ── Rule: Global mutable state ────────────────────────────────────────

@healing_rule(
    rule_id="UNI_CONC_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect module-level mutable state that may cause concurrency issues",
)
def detect_global_mutable(code: str, language: str, file_path: str) -> List[HealingFix]:
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        for idx, line in enumerate(lines):
            indent = len(line) - len(line.lstrip())
            if indent > 0:
                continue
            stripped = line.strip()
            # Module-level mutable assignments
            if re.match(r"^[a-z_]\w*\s*=\s*(\[\]|\{\}|set\(\)|dict\(\)|list\(\))", stripped):
                var_name = stripped.split("=")[0].strip()
                # Check if it's mutated later
                for j in range(idx + 1, len(lines)):
                    if re.search(rf"\b{re.escape(var_name)}\.(append|extend|update|add|pop|remove|clear)\b", lines[j]):
                        fixes.append(HealingFix(
                            category=HealingCategory.UNUSED_VARIABLE,
                            severity=HealingSeverity.MODERATE,
                            action=HealingAction.REPLACE,
                            description=f"Module-level mutable '{var_name}' is mutated — potential concurrency issue",
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
                        break

    elif lang in _JS_LANGS:
        for idx, line in enumerate(lines):
            stripped = line.strip()
            # Module-level let with mutable structures
            m = re.match(r"^let\s+(\w+)\s*=\s*(\[\]|\{\}|new\s+Map|new\s+Set)", stripped)
            if m:
                var_name = m.group(1)
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"Module-level 'let {var_name}' with mutable structure — consider encapsulation",
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


# ── Rule: Missing goroutine error handling ────────────────────────────

@healing_rule(
    rule_id="UNI_CONC_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect Go goroutines without error/panic recovery",
)
def detect_goroutine_no_recover(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _GO_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        if not re.match(r"^\s*go\s+", line):
            continue

        # Check if the goroutine body has recover()
        has_recover = False
        brace_depth = 0
        for j in range(idx, min(idx + 20, len(lines))):
            brace_depth += lines[j].count("{") - lines[j].count("}")
            if "recover()" in lines[j]:
                has_recover = True
                break
            if brace_depth <= 0 and j > idx:
                break

        if not has_recover:
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.INSERT,
                description="Goroutine without recover() — panics will crash the program",
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


# ── Rule: Promise.all without error boundary ──────────────────────────

@healing_rule(
    rule_id="UNI_CONC_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect Promise.all without proper error handling",
)
def detect_promise_all_no_catch(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _JS_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        if "Promise.all(" not in line:
            continue

        # Check context for try/catch or .catch
        start = max(0, idx - 3)
        end = min(len(lines), idx + 5)
        context = "\n".join(lines[start:end])

        has_catch = any(kw in context for kw in [
            ".catch(", "try {", "try{", "Promise.allSettled"
        ])

        if not has_catch:
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.INSERT,
                description="Promise.all() without catch — one rejection fails all; consider allSettled",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text="",
                replacement_text="",
                confidence=0.75,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes
