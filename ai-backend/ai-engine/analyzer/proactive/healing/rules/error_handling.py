"""
Universal healing rule: Error handling patterns.

Detects common error-handling anti-patterns:
- Empty except/catch blocks
- Bare except (Python) or generic catch (JS/TS)
- Missing error parameter in catch blocks
- Swallowed errors (caught but not logged or re-raised)
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
_C_STYLE_LANGS = {
    "javascript", "js", "jsx", "typescript", "ts", "tsx",
    "java", "csharp", "cs", "kotlin", "swift", "dart",
}


# ── Rule: Empty catch/except block ────────────────────────────────────

@healing_rule(
    rule_id="UNI_ERR_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect empty except/catch blocks that silently swallow errors",
)
def detect_empty_error_handler(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect empty except/catch blocks."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        for idx, line in enumerate(lines):
            stripped = line.strip()
            if re.match(r"^except(\s+\w+)?(\s+as\s+\w+)?\s*:\s*$", stripped):
                # Check if next line is pass or empty
                next_idx = idx + 1
                while next_idx < len(lines) and not lines[next_idx].strip():
                    next_idx += 1
                if next_idx < len(lines):
                    next_stripped = lines[next_idx].strip()
                    if next_stripped in ("pass", "..."):
                        indent = len(line) - len(line.lstrip())
                        fixes.append(HealingFix(
                            category=HealingCategory.UNUSED_VARIABLE,
                            severity=HealingSeverity.MODERATE,
                            action=HealingAction.INSERT,
                            description="Empty except block — add logging or re-raise the exception",
                            line=next_idx,
                            column=0,
                            end_line=next_idx,
                            end_column=len(lines[next_idx]),
                            original_text=next_stripped,
                            replacement_text=" " * (indent + 4) + "raise  # TODO: handle or log this exception",
                            confidence=0.70,
                            is_safe=False,
                            affects_logic=True,
                        ))

    elif lang in _C_STYLE_LANGS:
        for idx, line in enumerate(lines):
            stripped = line.strip()
            if re.match(r"^catch\s*\(", stripped):
                # Find the opening brace
                brace_line = idx
                while brace_line < len(lines) and "{" not in lines[brace_line]:
                    brace_line += 1
                if brace_line < len(lines):
                    # Check next non-empty line after {
                    next_idx = brace_line + 1
                    while next_idx < len(lines) and not lines[next_idx].strip():
                        next_idx += 1
                    if next_idx < len(lines) and lines[next_idx].strip() == "}":
                        fixes.append(HealingFix(
                            category=HealingCategory.UNUSED_VARIABLE,
                            severity=HealingSeverity.MODERATE,
                            action=HealingAction.INSERT,
                            description="Empty catch block — add error handling",
                            line=brace_line,
                            column=0,
                            end_line=next_idx,
                            end_column=len(lines[next_idx]),
                            original_text="",
                            replacement_text="",
                            confidence=0.70,
                            is_safe=False,
                            affects_logic=True,
                        ))

    return fixes


# ── Rule: Bare except (Python) ────────────────────────────────────────

@healing_rule(
    rule_id="UNI_ERR_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect bare 'except:' in Python (should specify exception type)",
)
def detect_bare_except(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect Python bare except clauses that catch everything."""
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "except:" or stripped == "except :":
            indent = len(line) - len(line.lstrip())
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.REPLACE,
                description="Replace bare 'except:' with 'except Exception:' (PEP 8 E722)",
                line=idx,
                column=indent,
                end_line=idx,
                end_column=indent + len(stripped),
                original_text=stripped,
                replacement_text="except Exception:",
                confidence=0.92,
                is_safe=True,
                affects_logic=False,  # Exception still catches all user exceptions
            ))

    return fixes


# ── Rule: Missing error parameter in catch ────────────────────────────

@healing_rule(
    rule_id="UNI_ERR_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect catch blocks without an error parameter",
)
def detect_missing_error_param(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect catch blocks that don't capture the error object."""
    lang = language.lower()
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    if lang in _PY_LANGS:
        for idx, line in enumerate(lines):
            stripped = line.strip()
            # except SomeError: without "as"
            m = re.match(r"^except\s+(\w+)\s*:\s*$", stripped)
            if m:
                exc_type = m.group(1)
                if exc_type not in ("Exception", "BaseException"):
                    indent = len(line) - len(line.lstrip())
                    fixes.append(HealingFix(
                        category=HealingCategory.UNUSED_VARIABLE,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.REPLACE,
                        description=f"Add 'as e' to capture the {exc_type} instance",
                        line=idx,
                        column=indent,
                        end_line=idx,
                        end_column=indent + len(stripped),
                        original_text=stripped,
                        replacement_text=f"except {exc_type} as e:",
                        confidence=0.75,
                        is_safe=True,
                        affects_logic=False,
                    ))

    elif lang in _C_STYLE_LANGS:
        for idx, line in enumerate(lines):
            stripped = line.strip()
            # catch { or catch() {  (no parameter)
            if re.match(r"^catch\s*\(\s*\)\s*\{?$", stripped) or re.match(r"^catch\s*\{$", stripped):
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description="Add error parameter to catch block",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text=stripped,
                    replacement_text=stripped.replace("catch", "catch (error)", 1) if "(" not in stripped else stripped.replace("()", "(error)"),
                    confidence=0.80,
                    is_safe=True,
                    affects_logic=False,
                ))

    return fixes


# ── Rule: Promise without catch (JS/TS) ──────────────────────────────

@healing_rule(
    rule_id="UNI_ERR_004",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect Promise chains without .catch() in JS/TS",
)
def detect_uncaught_promise(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect .then() chains without a .catch() handler."""
    lang = language.lower()
    if lang not in {"javascript", "js", "jsx", "typescript", "ts", "tsx"}:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("//"):
            continue

        # Look for .then( without a .catch( on the same or next few lines
        if ".then(" in stripped and ".catch(" not in stripped:
            # Check next 3 lines for .catch
            has_catch = False
            for lookahead in range(1, 4):
                if idx + lookahead < len(lines):
                    if ".catch(" in lines[idx + lookahead]:
                        has_catch = True
                        break
            if not has_catch:
                col = line.index(".then(")
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.MODERATE,
                    action=HealingAction.INSERT,
                    description="Promise chain missing .catch() — unhandled rejection",
                    line=idx,
                    column=col,
                    end_line=idx,
                    end_column=len(line),
                    original_text="",
                    replacement_text="",
                    confidence=0.72,
                    is_safe=False,
                    affects_logic=False,
                ))

    return fixes
