"""
Universal healing rule: Exception & error hierarchy patterns.

Detects:
- Overly broad exception types
- Re-raising without chaining
- Exception swallowing (catch + pass/continue)
- Wrong error type thrown
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


# ── Rule: Overly broad exception catch ────────────────────────────────

@healing_rule(
    rule_id="UNI_EXC_001",
    category=HealingCategory.MISSING_SEMICOLON,
    description="Detect overly broad exception catches (catch Exception / catch Error)",
)
def detect_broad_exception(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Flag catches that are too generic."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        pattern = re.compile(r"^\s*except\s+(Exception|BaseException)\s*(as\s+\w+)?\s*:")
        for idx, line in enumerate(lines):
            m = pattern.match(line)
            if m:
                exc_type = m.group(1)
                fixes.append(HealingFix(
                    category=HealingCategory.MISSING_SEMICOLON,
                    severity=HealingSeverity.MODERATE,
                    action=HealingAction.REPLACE,
                    description=f"Catching '{exc_type}' is too broad — use specific exception",
                    line=idx,
                    column=m.start(1),
                    end_line=idx,
                    end_column=m.end(1),
                    original_text=exc_type,
                    replacement_text=exc_type,
                    confidence=0.70,
                    is_safe=True,
                    affects_logic=False,
                ))

    elif lang in _JS_LANGS:
        # catch(e) with no type check at all → warn
        pattern = re.compile(r"^\s*\}\s*catch\s*\(\s*\w+\s*\)\s*\{")
        for idx, line in enumerate(lines):
            if pattern.match(line):
                # Check if the next lines do instanceof check
                has_type_check = False
                for j in range(idx + 1, min(idx + 5, len(lines))):
                    if "instanceof" in lines[j]:
                        has_type_check = True
                        break
                if not has_type_check:
                    fixes.append(HealingFix(
                        category=HealingCategory.MISSING_SEMICOLON,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.REPLACE,
                        description="Generic catch without type checking — consider instanceof guard",
                        line=idx,
                        column=0,
                        end_line=idx,
                        end_column=len(line),
                        original_text="",
                        replacement_text="",
                        confidence=0.55,
                        is_safe=True,
                        affects_logic=False,
                    ))

    elif lang in _JAVA_LANGS:
        pattern = re.compile(r"^\s*\}\s*catch\s*\(\s*(Exception|Throwable)\s+\w+\s*\)")
        for idx, line in enumerate(lines):
            m = pattern.match(line)
            if m:
                exc_type = m.group(1)
                fixes.append(HealingFix(
                    category=HealingCategory.MISSING_SEMICOLON,
                    severity=HealingSeverity.MODERATE,
                    action=HealingAction.REPLACE,
                    description=f"Catching '{exc_type}' is too broad — use specific exception",
                    line=idx,
                    column=m.start(1),
                    end_line=idx,
                    end_column=m.end(1),
                    original_text=exc_type,
                    replacement_text=exc_type,
                    confidence=0.70,
                    is_safe=True,
                    affects_logic=False,
                ))

    return fixes


# ── Rule: Exception swallowing ────────────────────────────────────────

@healing_rule(
    rule_id="UNI_EXC_002",
    category=HealingCategory.MISSING_SEMICOLON,
    description="Detect catch blocks that silently swallow exceptions (pass/continue/empty)",
)
def detect_exception_swallowing(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Flag catch blocks with only pass, continue, or nothing."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        for idx, line in enumerate(lines):
            if re.match(r"^\s*except\b", line):
                # Check the body
                except_indent = len(line) - len(line.lstrip())
                body_lines = []
                for j in range(idx + 1, min(idx + 5, len(lines))):
                    jline = lines[j]
                    if not jline.strip():
                        continue
                    jindent = len(jline) - len(jline.lstrip())
                    if jindent <= except_indent:
                        break
                    body_lines.append(jline.strip())

                if body_lines == ["pass"] or body_lines == ["continue"] or not body_lines:
                    fixes.append(HealingFix(
                        category=HealingCategory.MISSING_SEMICOLON,
                        severity=HealingSeverity.CRITICAL,
                        action=HealingAction.REPLACE,
                        description="Exception silently swallowed — add logging or re-raise",
                        line=idx,
                        column=0,
                        end_line=idx,
                        end_column=len(line),
                        original_text="",
                        replacement_text="",
                        confidence=0.85,
                        is_safe=True,
                        affects_logic=False,
                    ))

    elif lang in _JS_LANGS:
        for idx, line in enumerate(lines):
            if re.match(r"^\s*\}\s*catch\s*\(", line):
                # Look for empty catch block or just a comment
                brace_depth = line.count("{") - line.count("}")
                body_lines = []
                for j in range(idx + 1, min(idx + 10, len(lines))):
                    jline = lines[j].strip()
                    brace_depth += lines[j].count("{") - lines[j].count("}")
                    if jline and not jline.startswith("//") and jline != "}":
                        body_lines.append(jline)
                    if brace_depth <= 0:
                        break

                if not body_lines:
                    fixes.append(HealingFix(
                        category=HealingCategory.MISSING_SEMICOLON,
                        severity=HealingSeverity.CRITICAL,
                        action=HealingAction.REPLACE,
                        description="Exception silently swallowed in catch block",
                        line=idx,
                        column=0,
                        end_line=idx,
                        end_column=len(line),
                        original_text="",
                        replacement_text="",
                        confidence=0.85,
                        is_safe=True,
                        affects_logic=False,
                    ))

    return fixes


# ── Rule: Re-raise without chaining (Python) ─────────────────────────

@healing_rule(
    rule_id="UNI_EXC_003",
    category=HealingCategory.MISSING_SEMICOLON,
    description="Detect raise inside except block without 'from' chaining (PEP 3134)",
)
def detect_unchained_reraise(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Flag `raise SomeError()` inside except that should use `from`."""
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")
    in_except = False
    except_indent = 0

    for idx, line in enumerate(lines):
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())

        if re.match(r"^except\b", stripped):
            in_except = True
            except_indent = indent
            continue

        if in_except and stripped and indent <= except_indent:
            in_except = False

        if not in_except:
            continue

        # Check for raise that isn't bare and doesn't use 'from'
        raise_m = re.match(r"^(\s*)raise\s+(\w+)\(.*\)\s*$", line)
        if raise_m and " from " not in line:
            fixes.append(HealingFix(
                category=HealingCategory.MISSING_SEMICOLON,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.REPLACE,
                description="Raise inside except should chain with 'from' (PEP 3134)",
                line=idx,
                column=0,
                end_line=idx,
                end_column=len(line),
                original_text=line.rstrip(),
                replacement_text=line.rstrip() + " from e",
                confidence=0.65,
                is_safe=False,
                affects_logic=False,
            ))

    return fixes
