"""
Universal healing rule: Performance anti-patterns.

Detects:
- Concatenation in loops
- Expensive operations inside loops
- Unnecessary re-creation of objects
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


# ── Rule: String concatenation in loop ────────────────────────────────

@healing_rule(
    rule_id="UNI_PERF_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect string concatenation inside loops (use join/builder instead)",
)
def detect_string_concat_loop(code: str, language: str, file_path: str) -> List[HealingFix]:
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    in_loop = False
    loop_indent = 0

    loop_re = (
        re.compile(r"^\s*(for|while)\b")
        if lang in _PY_LANGS
        else re.compile(r"^\s*(for|while|forEach)\b")
    )

    for idx, line in enumerate(lines):
        indent = len(line) - len(line.lstrip())

        if loop_re.match(line):
            in_loop = True
            loop_indent = indent
            continue

        if in_loop and line.strip() and indent <= loop_indent:
            in_loop = False

        if not in_loop:
            continue

        # string += or string = string + ...
        if re.search(r"\w+\s*\+=\s*['\"]", line) or re.search(r"\w+\s*=\s*\w+\s*\+\s*['\"]", line):
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.REPLACE,
                description="String concatenation in loop — use list/join or StringBuilder",
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


# ── Rule: Regex compilation inside loop ───────────────────────────────

@healing_rule(
    rule_id="UNI_PERF_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect regex compilation inside loops (should be pre-compiled)",
)
def detect_regex_in_loop(code: str, language: str, file_path: str) -> List[HealingFix]:
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    in_loop = False
    loop_indent = 0
    loop_line = 0

    loop_re = re.compile(r"^\s*(for|while)\b")

    regex_patterns = {
        "py": re.compile(r"re\.(compile|search|match|findall|sub)\s*\("),
        "js": re.compile(r"new\s+RegExp\s*\("),
    }

    pattern = None
    if lang in _PY_LANGS:
        pattern = regex_patterns["py"]
    elif lang in _JS_LANGS:
        pattern = regex_patterns["js"]

    if pattern is None:
        return fixes

    for idx, line in enumerate(lines):
        indent = len(line) - len(line.lstrip())

        if loop_re.match(line):
            in_loop = True
            loop_indent = indent
            loop_line = idx
            continue

        if in_loop and line.strip() and indent <= loop_indent and idx > loop_line:
            in_loop = False

        if not in_loop:
            continue

        if pattern.search(line):
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.REPLACE,
                description="Regex compilation inside loop — pre-compile outside the loop",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text="",
                replacement_text="",
                confidence=0.82,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Unnecessary list() on already-iterable ──────────────────────

@healing_rule(
    rule_id="UNI_PERF_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect unnecessary list() wrapping of iterables",
)
def detect_unnecessary_list(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # for x in list(dict.keys()) → just for x in dict
    pattern = re.compile(r"for\s+\w+\s+in\s+list\((.+?)\)\s*:")

    for idx, line in enumerate(lines):
        m = pattern.search(line)
        if m:
            inner = m.group(1)
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=f"Unnecessary list() wrapping — iterate directly over {inner}",
                line=idx,
                column=m.start(),
                end_line=idx,
                end_column=m.end(),
                original_text=m.group(0),
                replacement_text=m.group(0).replace(f"list({inner})", inner),
                confidence=0.80,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes
