"""
Universal healing rule: API and interface consistency.

Detects:
- Inconsistent function signatures in related functions
- Missing error response handling (HTTP)
- REST naming convention violations
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


# ── Rule: Unhandled HTTP response ─────────────────────────────────────

@healing_rule(
    rule_id="UNI_API_001",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect fetch/axios calls without error handling for HTTP status",
)
def detect_unhandled_http(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _JS_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        # fetch() without .ok check or catch
        if "fetch(" in line and "await" in line:
            # Look ahead for response.ok or .catch or try
            has_check = False
            # Check surrounding context
            start = max(0, idx - 5)
            end = min(len(lines), idx + 10)
            context = "\n".join(lines[start:end])
            if any(kw in context for kw in [
                ".ok", "response.status", ".catch", "try {", "try{",
                ".then(", "status ===", "status !=="
            ]):
                has_check = True

            if not has_check:
                fixes.append(HealingFix(
                    category=HealingCategory.UNDECLARED_VARIABLE,
                    severity=HealingSeverity.MODERATE,
                    action=HealingAction.INSERT,
                    description="fetch() call without HTTP error status check",
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


# ── Rule: Inconsistent API response shape ─────────────────────────────

@healing_rule(
    rule_id="UNI_API_002",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect inconsistent API response shapes (mixed data/error patterns)",
)
def detect_inconsistent_response(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Look for res.json() or return {...} patterns with inconsistent keys
    if lang in _JS_LANGS:
        json_responses: list[tuple[int, set]] = []
        for idx, line in enumerate(lines):
            m = re.search(r"res\.(?:json|send)\s*\(\s*\{", line)
            if m:
                # Extract keys from the response object
                keys = set()
                brace_depth = 0
                for j in range(idx, min(idx + 10, len(lines))):
                    for km in re.finditer(r"(\w+)\s*:", lines[j]):
                        keys.add(km.group(1))
                    brace_depth += lines[j].count("{") - lines[j].count("}")
                    if brace_depth <= 0 and j > idx:
                        break
                json_responses.append((idx, keys))

        # Check if response shapes are inconsistent
        if len(json_responses) >= 3:
            has_data = sum(1 for _, keys in json_responses if "data" in keys)
            has_result = sum(1 for _, keys in json_responses if "result" in keys)
            if has_data > 0 and has_result > 0:
                for line_idx, keys in json_responses:
                    if "result" in keys and has_data > has_result:
                        fixes.append(HealingFix(
                            category=HealingCategory.UNDECLARED_VARIABLE,
                            severity=HealingSeverity.LOW,
                            action=HealingAction.REPLACE,
                            description="Inconsistent response key: 'result' vs 'data' used elsewhere",
                            line=line_idx,
                            column=0,
                            end_line=line_idx,
                            end_column=len(lines[line_idx]),
                            original_text="",
                            replacement_text="",
                            confidence=0.55,
                            is_safe=True,
                            affects_logic=False,
                        ))

    return fixes


# ── Rule: Missing Content-Type header ─────────────────────────────────

@healing_rule(
    rule_id="UNI_API_003",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect HTTP requests without Content-Type header for POST/PUT",
)
def detect_missing_content_type(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _JS_LANGS and lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        # Look for fetch/axios POST/PUT without explicit headers
        if lang in _JS_LANGS:
            if re.search(r"fetch\s*\([^)]*,\s*\{", line):
                context = "\n".join(lines[idx:min(idx + 8, len(lines))])
                if re.search(r"method\s*:\s*['\"](?:POST|PUT|PATCH)['\"]", context, re.IGNORECASE):
                    if "Content-Type" not in context and "content-type" not in context:
                        if "body:" in context or "body :" in context:
                            fixes.append(HealingFix(
                                category=HealingCategory.UNDECLARED_VARIABLE,
                                severity=HealingSeverity.MODERATE,
                                action=HealingAction.INSERT,
                                description="POST/PUT fetch without Content-Type header",
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

        elif lang in _PY_LANGS:
            if re.search(r"requests\.(post|put|patch)\s*\(", line):
                context = "\n".join(lines[idx:min(idx + 5, len(lines))])
                if "headers" not in context and "json=" not in context:
                    fixes.append(HealingFix(
                        category=HealingCategory.UNDECLARED_VARIABLE,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.INSERT,
                        description="HTTP POST/PUT without explicit headers or json= parameter",
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
