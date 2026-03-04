"""
Universal healing rule: Async/await patterns.

Detects common async/await anti-patterns:
- Missing await on async calls
- Unnecessary async on non-awaiting functions
- async forEach (should use for...of)
- Floating promises (no await or return)
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


# ── Rule: Missing await ──────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_ASYNC_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect likely missing 'await' on async function calls",
)
def detect_missing_await(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect calls to functions named with async patterns that lack await."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    # Collect known async function names in the file
    async_funcs = set()

    if lang in _PY_LANGS:
        for line in lines:
            m = re.match(r"^\s*async\s+def\s+(\w+)", line)
            if m:
                async_funcs.add(m.group(1))

        for idx, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            for func in async_funcs:
                # Look for func( without preceding await
                pattern = rf"(?<!await\s)(?<!await\s\s)\b{re.escape(func)}\s*\("
                for m in re.finditer(pattern, stripped):
                    # Skip the definition line itself
                    if "async def" in stripped:
                        continue
                    # Skip if it's in a decorator
                    if stripped.startswith("@"):
                        continue

                    col = len(line) - len(stripped) + m.start()
                    fixes.append(HealingFix(
                        category=HealingCategory.UNUSED_VARIABLE,
                        severity=HealingSeverity.MODERATE,
                        action=HealingAction.INSERT,
                        description=f"Missing 'await' before async function '{func}'",
                        line=idx,
                        column=col,
                        end_line=idx,
                        end_column=col,
                        original_text="",
                        replacement_text="await ",
                        confidence=0.72,
                        is_safe=False,
                        affects_logic=True,
                    ))

    elif lang in _JS_LANGS:
        for line in lines:
            m = re.match(r"^\s*(?:export\s+)?(?:const|let|var|function)\s+(?:async\s+)?(\w+)\s*=?\s*async", line)
            if m:
                async_funcs.add(m.group(1))
            m = re.match(r"^\s*async\s+function\s+(\w+)", line)
            if m:
                async_funcs.add(m.group(1))

        for idx, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith("//"):
                continue
            for func in async_funcs:
                pattern = rf"(?<!await\s)\b{re.escape(func)}\s*\("
                for m in re.finditer(pattern, stripped):
                    if "async" in stripped and "function" in stripped:
                        continue
                    col = len(line) - len(stripped) + m.start()
                    fixes.append(HealingFix(
                        category=HealingCategory.UNUSED_VARIABLE,
                        severity=HealingSeverity.MODERATE,
                        action=HealingAction.INSERT,
                        description=f"Missing 'await' before async function '{func}'",
                        line=idx,
                        column=col,
                        end_line=idx,
                        end_column=col,
                        original_text="",
                        replacement_text="await ",
                        confidence=0.70,
                        is_safe=False,
                        affects_logic=True,
                    ))

    return fixes


# ── Rule: Unnecessary async ──────────────────────────────────────────

@healing_rule(
    rule_id="UNI_ASYNC_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect async functions that never use await",
)
def detect_unnecessary_async(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect async functions that don't contain any await expression."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        for idx, line in enumerate(lines):
            m = re.match(r"^(\s*)async\s+def\s+(\w+)", line)
            if not m:
                continue
            func_indent = len(m.group(1))
            func_name = m.group(2)

            # Scan body for await
            has_await = False
            for j in range(idx + 1, len(lines)):
                body = lines[j]
                if body.strip() and (len(body) - len(body.lstrip())) <= func_indent:
                    break
                if "await " in body:
                    has_await = True
                    break

            if not has_await:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"async function '{func_name}' never uses await — consider removing async",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text="",
                    replacement_text="",
                    confidence=0.75,
                    is_safe=False,
                    affects_logic=True,
                ))

    elif lang in _JS_LANGS:
        for idx, line in enumerate(lines):
            stripped = line.strip()
            is_async = bool(re.match(r"^(?:export\s+)?async\s+function\s+(\w+)", stripped))
            if not is_async:
                continue

            fm = re.match(r"^(?:export\s+)?async\s+function\s+(\w+)", stripped)
            func_name = fm.group(1)

            # Scan for closing brace
            depth = 0
            has_await = False
            for j in range(idx, len(lines)):
                depth += lines[j].count("{") - lines[j].count("}")
                if "await " in lines[j]:
                    has_await = True
                    break
                if depth == 0 and j > idx:
                    break

            if not has_await:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"async function '{func_name}' never uses await",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text="",
                    replacement_text="",
                    confidence=0.75,
                    is_safe=False,
                    affects_logic=True,
                ))

    return fixes


# ── Rule: async forEach (JS/TS) ──────────────────────────────────────

@healing_rule(
    rule_id="UNI_ASYNC_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect .forEach with async callback (should use for...of)",
)
def detect_async_foreach(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect .forEach(async ...) which doesn't properly await."""
    lang = language.lower()
    if lang not in _JS_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        if ".forEach(async" in line or ".forEach( async" in line:
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.REPLACE,
                description="forEach with async callback doesn't await — use for...of loop instead",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text="",
                replacement_text="",
                confidence=0.88,
                is_safe=False,
                affects_logic=True,
            ))

    return fixes
