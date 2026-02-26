"""
Universal healing rule: Encoding & line-ending issues.

Detects:
- BOM characters in files
- Mixed line endings (CR/LF)
- Non-ASCII characters in identifiers
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


# ── Rule: BOM character detection ─────────────────────────────────────

@healing_rule(
    rule_id="UNI_ENC_001",
    category=HealingCategory.TRAILING_WHITESPACE,
    description="Detect BOM (byte-order-mark) at start of file",
)
def detect_bom(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Flag UTF-8 BOM marker that can cause parser issues."""
    fixes: List[HealingFix] = []

    if code.startswith("\ufeff"):
        fixes.append(HealingFix(
            category=HealingCategory.TRAILING_WHITESPACE,
            severity=HealingSeverity.MODERATE,
            action=HealingAction.DELETE,
            description="File starts with UTF-8 BOM — remove for compatibility",
            line=0,
            column=0,
            end_line=0,
            end_column=1,
            original_text="\ufeff",
            replacement_text="",
            confidence=0.95,
            is_safe=True,
            affects_logic=False,
        ))

    return fixes


# ── Rule: Mixed line endings ──────────────────────────────────────────

@healing_rule(
    rule_id="UNI_ENC_002",
    category=HealingCategory.TRAILING_WHITESPACE,
    description="Detect mixed line endings (CR/LF) in the same file",
)
def detect_mixed_line_endings(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Flag files with inconsistent line endings."""
    fixes: List[HealingFix] = []

    crlf_count = code.count("\r\n")
    # After removing \r\n, count lone \n
    remaining = code.replace("\r\n", "")
    lf_count = remaining.count("\n")
    cr_count = remaining.count("\r")

    total = crlf_count + lf_count + cr_count
    if total == 0:
        return fixes

    has_crlf = crlf_count > 0
    has_lf = lf_count > 0
    has_cr = cr_count > 0

    mixed_types = sum([has_crlf, has_lf, has_cr])

    if mixed_types > 1:
        dominant = "LF"
        if crlf_count > lf_count:
            dominant = "CRLF"

        fixes.append(HealingFix(
            category=HealingCategory.TRAILING_WHITESPACE,
            severity=HealingSeverity.MODERATE,
            action=HealingAction.REPLACE,
            description=f"Mixed line endings detected — normalise to {dominant}",
            line=0,
            column=0,
            end_line=0,
            end_column=0,
            original_text="",
            replacement_text="",
            confidence=0.90,
            is_safe=True,
            affects_logic=False,
        ))

    return fixes


# ── Rule: Non-ASCII in identifiers ────────────────────────────────────

@healing_rule(
    rule_id="UNI_ENC_003",
    category=HealingCategory.TRAILING_WHITESPACE,
    description="Detect non-ASCII characters in identifiers (homoglyphs, accidental Unicode)",
)
def detect_non_ascii_identifiers(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Flag look-alike Unicode characters that slip into code."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Common homoglyphs (Cyrillic, Greek, etc. that look like Latin)
    homoglyphs = {
        "\u0410": "A", "\u0412": "B", "\u0421": "C", "\u0415": "E",
        "\u041d": "H", "\u041a": "K", "\u041c": "M", "\u041e": "O",
        "\u0420": "P", "\u0422": "T", "\u0425": "X",
        "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p",
        "\u0441": "c", "\u0443": "y", "\u0445": "x",
        "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
        "\u2013": "-", "\u2014": "-",
        "\u00a0": " ",  # non-breaking space
    }

    for idx, line in enumerate(lines):
        # Skip string contents — only check structure
        stripped = line.strip()
        if stripped.startswith(("#", "//", "/*", "*", "'''", '"""')):
            continue

        for pos, ch in enumerate(line):
            if ch in homoglyphs:
                replacement = homoglyphs[ch]
                fixes.append(HealingFix(
                    category=HealingCategory.TRAILING_WHITESPACE,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.REPLACE,
                    description=f"Homoglyph character U+{ord(ch):04X} found — replace with ASCII '{replacement}'",
                    line=idx,
                    column=pos,
                    end_line=idx,
                    end_column=pos + 1,
                    original_text=ch,
                    replacement_text=replacement,
                    confidence=0.93,
                    is_safe=True,
                    affects_logic=False,
                ))

    return fixes
