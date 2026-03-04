"""
Universal healing rule: Documentation patterns.

Detects missing or incomplete documentation:
- Public functions without docstrings/JSDoc
- Missing module/file-level documentation
- Outdated documentation (parameter mismatch)
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


# ── Rule: Missing function docstring ──────────────────────────────────

@healing_rule(
    rule_id="UNI_DOC_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect public functions missing docstrings or documentation comments",
)
def detect_missing_docstring(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect public function/method definitions without documentation."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if lang in _PY_LANGS:
        for idx, line in enumerate(lines):
            m = re.match(r"^(\s*)(async\s+)?def\s+(\w+)\s*\(", line)
            if not m:
                continue
            func_name = m.group(3)
            indent = len(m.group(1))

            # Skip private functions
            if func_name.startswith("_"):
                continue

            # Check next non-blank line for docstring
            next_idx = idx + 1
            while next_idx < len(lines) and not lines[next_idx].strip():
                next_idx += 1

            has_docstring = False
            if next_idx < len(lines):
                next_stripped = lines[next_idx].strip()
                if next_stripped.startswith('"""') or next_stripped.startswith("'''"):
                    has_docstring = True

            if not has_docstring:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.INSERT,
                    description=f"Add docstring to public function '{func_name}'",
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

    elif lang in _JS_LANGS:
        for idx, line in enumerate(lines):
            stripped = line.strip()
            # Function declarations
            is_func = bool(re.match(r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)", stripped))
            # Arrow function assignments
            is_arrow = bool(re.match(r"^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(", stripped))

            if is_func or is_arrow:
                # Check line above for JSDoc comment
                has_jsdoc = False
                check_idx = idx - 1
                while check_idx >= 0 and not lines[check_idx].strip():
                    check_idx -= 1
                if check_idx >= 0:
                    prev = lines[check_idx].strip()
                    if prev.endswith("*/") or prev.startswith("/**") or prev.startswith("*"):
                        has_jsdoc = True

                if not has_jsdoc:
                    func_m = re.match(r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)", stripped) or \
                             re.match(r"^(?:export\s+)?(?:const|let)\s+(\w+)", stripped)
                    fname = func_m.group(1) if func_m else "function"

                    # Skip private/internal
                    if fname.startswith("_"):
                        continue

                    fixes.append(HealingFix(
                        category=HealingCategory.UNUSED_VARIABLE,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.INSERT,
                        description=f"Add JSDoc comment to '{fname}'",
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

    return fixes


# ── Rule: Missing module docstring ────────────────────────────────────

@healing_rule(
    rule_id="UNI_DOC_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect files missing a module-level docstring or file header comment",
)
def detect_missing_module_doc(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect files that lack a top-level documentation comment."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    if not lines:
        return fixes

    # Find first non-blank, non-shebang, non-encoding line
    first_code = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped and not stripped.startswith("#!") and not stripped.startswith("# -*-"):
            first_code = i
            break

    first = lines[first_code].strip() if first_code < len(lines) else ""

    has_doc = False

    if lang in _PY_LANGS:
        if first.startswith('"""') or first.startswith("'''"):
            has_doc = True
    elif lang in _JS_LANGS:
        if first.startswith("/**") or first.startswith("//"):
            has_doc = True
    else:
        # Generic: check for comment at top
        if first.startswith("//") or first.startswith("#") or first.startswith("/*") or first.startswith("--"):
            has_doc = True

    if not has_doc:
        fixes.append(HealingFix(
            category=HealingCategory.UNUSED_VARIABLE,
            severity=HealingSeverity.LOW,
            action=HealingAction.INSERT,
            description="Add module/file-level documentation comment",
            line=0,
            column=0,
            end_line=0,
            end_column=0,
            original_text="",
            replacement_text="",
            confidence=0.45,
            is_safe=True,
            affects_logic=False,
        ))

    return fixes


# ── Rule: Outdated docstring parameters ───────────────────────────────

@healing_rule(
    rule_id="UNI_DOC_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect docstrings mentioning parameters that no longer exist in the function signature",
)
def detect_outdated_docstring(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect docstrings that reference parameters not in the function signature."""
    fixes: List[HealingFix] = []
    lang = language.lower()

    if lang not in {"python", "py"}:
        return fixes

    lines = code.split("\n")

    for idx, line in enumerate(lines):
        m = re.match(r"^\s*def\s+\w+\s*\(([^)]*)\)", line)
        if not m:
            continue

        # Extract param names from signature
        sig_params = set()
        for p in m.group(1).split(","):
            p = p.strip().split(":")[0].split("=")[0].strip()
            if p and p not in ("self", "cls", "*", "**"):
                if p.startswith("*"):
                    p = p.lstrip("*")
                if p:
                    sig_params.add(p)

        # Look for docstring
        doc_start = idx + 1
        while doc_start < len(lines) and not lines[doc_start].strip():
            doc_start += 1

        if doc_start >= len(lines):
            continue

        doc_first = lines[doc_start].strip()
        if not (doc_first.startswith('"""') or doc_first.startswith("'''")):
            continue

        # Scan docstring for :param x: or Args: x: patterns
        doc_idx = doc_start
        doc_params = set()
        while doc_idx < len(lines):
            dl = lines[doc_idx].strip()
            # :param name:
            pm = re.findall(r":param\s+(\w+):", dl)
            doc_params.update(pm)
            # Google-style: name (type):  or  name:
            pm2 = re.findall(r"^\s+(\w+)\s*(?:\([^)]*\))?\s*:", dl)
            doc_params.update(pm2)

            if doc_idx > doc_start and (dl.endswith('"""') or dl.endswith("'''")):
                break
            doc_idx += 1

        # Find params in docstring but not in signature
        stale = doc_params - sig_params
        if stale:
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=f"Docstring mentions params not in signature: {', '.join(sorted(stale))}",
                line=doc_start,
                column=0,
                end_line=doc_idx,
                end_column=len(lines[doc_idx]) if doc_idx < len(lines) else 0,
                original_text="",
                replacement_text="",
                confidence=0.78,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes
