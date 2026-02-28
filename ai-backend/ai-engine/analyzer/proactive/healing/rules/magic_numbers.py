"""
Universal healing rule: Magic number and constant extraction.

Detects:
- Magic numbers in code (unexplained numeric literals)
- Hardcoded URLs/paths
- Hardcoded configuration values
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
_C_LANGS = {"c", "cpp", "c++", "java", "csharp", "cs", "go", "rust", "rs"}


# Commonly acceptable "non-magic" numbers
_ALLOWED_NUMBERS = {0, 1, 2, -1, 0.0, 1.0, 100, 0.5}


# ── Rule: Magic numbers ──────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_MAGIC_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect unexplained magic numbers that should be named constants",
)
def detect_magic_numbers(code: str, language: str, file_path: str) -> List[HealingFix]:
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    # Skip config/settings/constant files
    if file_path and re.search(r"(config|settings|constants|const)\.", file_path, re.IGNORECASE):
        return fixes

    for idx, line in enumerate(lines):
        stripped = line.strip()

        # Skip comments, imports, constant definitions
        if stripped.startswith(("#", "//", "/*", "*", "import", "from")):
            continue

        # Skip constant assignments (UPPER_CASE = ...)
        if re.match(r"^[A-Z_][A-Z0-9_]*\s*=", stripped):
            continue

        # Skip const declarations
        if re.match(r"^\s*(?:const|final|static final)\s+", line):
            continue

        # Find numeric literals
        for m in re.finditer(r"(?<![.\w])(-?\d+\.?\d*)\b", line):
            try:
                num = float(m.group(1))
            except ValueError:
                continue

            if num in _ALLOWED_NUMBERS:
                continue

            # Skip array indices, common ports, HTTP codes
            if num in {80, 443, 8080, 3000, 200, 201, 204, 301, 302, 400, 401, 403, 404, 500}:
                continue

            # Skip if in a string
            before = line[:m.start()]
            if before.count("'") % 2 == 1 or before.count('"') % 2 == 1:
                continue

            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=f"Magic number {m.group(1)} — extract to named constant",
                line=idx,
                column=m.start(),
                end_line=idx,
                end_column=m.end(),
                original_text=m.group(1),
                replacement_text=m.group(1),
                confidence=0.55,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Hardcoded URLs ─────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_MAGIC_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect hardcoded URLs that should be configuration",
)
def detect_hardcoded_urls(code: str, language: str, file_path: str) -> List[HealingFix]:
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Skip config/env files
    if file_path and re.search(r"(\.env|config|settings)", file_path, re.IGNORECASE):
        return fixes

    url_re = re.compile(r'["\']https?://[^"\']+["\']')

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith(("#", "//", "/*", "*")):
            continue

        for m in url_re.finditer(line):
            url = m.group(0)
            # Skip localhost for dev
            if "localhost" in url or "127.0.0.1" in url or "example.com" in url:
                continue

            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.REPLACE,
                description="Hardcoded URL — move to configuration/environment variable",
                line=idx,
                column=m.start(),
                end_line=idx,
                end_column=m.end(),
                original_text=url,
                replacement_text=url,
                confidence=0.65,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Hardcoded file paths ────────────────────────────────────────

@healing_rule(
    rule_id="UNI_MAGIC_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect hardcoded absolute file paths",
)
def detect_hardcoded_paths(code: str, language: str, file_path: str) -> List[HealingFix]:
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    if file_path and re.search(r"(\.env|config|settings|docker|Makefile)", file_path, re.IGNORECASE):
        return fixes

    path_re = re.compile(r'["\'](?:/(?:home|usr|var|etc|opt|tmp)|[A-Z]:\\)[^"\']*["\']')

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith(("#", "//", "/*", "*")):
            continue

        for m in path_re.finditer(line):
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.REPLACE,
                description="Hardcoded absolute path — use config or path.join()",
                line=idx,
                column=m.start(),
                end_line=idx,
                end_column=m.end(),
                original_text=m.group(0),
                replacement_text=m.group(0),
                confidence=0.70,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes
