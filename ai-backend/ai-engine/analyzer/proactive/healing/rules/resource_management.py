"""
Universal healing rule: Resource management patterns.

Detects:
- Unclosed file handles / connections
- Missing context managers (Python with-statement)
- Missing finally blocks for cleanup
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


# ── Rule: open() without context manager ──────────────────────────────

@healing_rule(
    rule_id="UNI_RES_001",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect file open() calls not wrapped in a context manager",
)
def detect_open_without_with(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Flag bare f = open(...) that should be 'with open(...) as f'."""
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        stripped = line.strip()
        # Match assignment-style open
        m = re.match(r"^(\s*)(\w+)\s*=\s*open\((.+)\)\s*$", line)
        if not m:
            continue

        # Skip if already inside a 'with' line
        if stripped.startswith("with "):
            continue

        var_name = m.group(2)
        open_args = m.group(3)
        indent = m.group(1)

        fixes.append(HealingFix(
            category=HealingCategory.UNDECLARED_VARIABLE,
            severity=HealingSeverity.CRITICAL,
            action=HealingAction.REPLACE,
            description=f"Use context manager: 'with open({open_args}) as {var_name}:'",
            line=idx,
            column=0,
            end_line=idx,
            end_column=len(line),
            original_text=line.rstrip(),
            replacement_text=f"{indent}with open({open_args}) as {var_name}:",
            confidence=0.90,
            is_safe=False,
            affects_logic=True,
        ))

    return fixes


# ── Rule: Missing finally for cleanup ─────────────────────────────────

@healing_rule(
    rule_id="UNI_RES_002",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect try blocks with resource acquisition but no finally cleanup",
)
def detect_missing_finally(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Flag try blocks that open resources without finally."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    resource_kws = [
        "open(", "connect(", "cursor(", "socket(",
        "acquire(", "createConnection(", "createPool(",
        "new WebSocket(", "new Connection(", "createServer(",
    ]

    if lang in _PY_LANGS:
        for idx, line in enumerate(lines):
            if not re.match(r"^\s*try\s*:", line):
                continue
            try_indent = len(line) - len(line.lstrip())
            has_resource = False
            has_finally = False

            for j in range(idx + 1, min(idx + 30, len(lines))):
                jline = lines[j]
                jindent = len(jline) - len(jline.lstrip())
                if jline.strip() and jindent <= try_indent and j > idx + 1:
                    if jline.strip().startswith("finally"):
                        has_finally = True
                    elif jline.strip().startswith(("except", "else")):
                        continue
                    else:
                        break
                for kw in resource_kws:
                    if kw in jline:
                        has_resource = True

            if has_resource and not has_finally:
                fixes.append(HealingFix(
                    category=HealingCategory.UNDECLARED_VARIABLE,
                    severity=HealingSeverity.MODERATE,
                    action=HealingAction.INSERT,
                    description="try block acquires resource without finally for cleanup",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text="",
                    replacement_text="",
                    confidence=0.65,
                    is_safe=True,
                    affects_logic=False,
                ))

    elif lang in _JS_LANGS:
        for idx, line in enumerate(lines):
            if not re.match(r"^\s*try\s*\{", line):
                continue
            brace_depth = line.count("{") - line.count("}")
            has_resource = False
            has_finally = False

            for j in range(idx + 1, min(idx + 40, len(lines))):
                jline = lines[j]
                brace_depth += jline.count("{") - jline.count("}")
                for kw in resource_kws:
                    if kw in jline:
                        has_resource = True
                if "finally" in jline.strip():
                    has_finally = True
                if brace_depth <= 0:
                    break

            if has_resource and not has_finally:
                fixes.append(HealingFix(
                    category=HealingCategory.UNDECLARED_VARIABLE,
                    severity=HealingSeverity.MODERATE,
                    action=HealingAction.INSERT,
                    description="try block acquires resource without finally for cleanup",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text="",
                    replacement_text="",
                    confidence=0.65,
                    is_safe=True,
                    affects_logic=False,
                ))

    return fixes


# ── Rule: Unclosed event listener ─────────────────────────────────────

@healing_rule(
    rule_id="UNI_RES_003",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect addEventListener without matching removeEventListener",
)
def detect_unclosed_listener(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Flag addEventListener without corresponding removeEventListener."""
    lang = language.lower()
    if lang not in _JS_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    add_re = re.compile(r"\.addEventListener\(\s*['\"](\w+)['\"]")
    remove_re = re.compile(r"\.removeEventListener\(\s*['\"](\w+)['\"]")

    added_events: dict[str, int] = {}
    removed_events: set[str] = set()

    for idx, line in enumerate(lines):
        for m in add_re.finditer(line):
            event = m.group(1)
            if event not in added_events:
                added_events[event] = idx
        for m in remove_re.finditer(line):
            removed_events.add(m.group(1))

    for event, line_idx in added_events.items():
        if event not in removed_events:
            fixes.append(HealingFix(
                category=HealingCategory.UNDECLARED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.INSERT,
                description=f"addEventListener('{event}') has no matching removeEventListener",
                line=line_idx,
                column=0,
                end_line=line_idx,
                end_column=len(lines[line_idx]),
                original_text="",
                replacement_text="",
                confidence=0.60,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes
