"""
Universal healing rule: Accessibility (a11y) patterns.

Detects:
- Missing alt attribute on images
- Missing aria labels on interactive elements
- Empty href links
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


_JSX_LANGS = {"javascript", "js", "jsx", "typescript", "ts", "tsx", "html", "vue", "svelte"}


# ── Rule: Missing alt attribute ───────────────────────────────────────

@healing_rule(
    rule_id="UNI_A11Y_001",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect <img> tags without alt attribute",
)
def detect_missing_alt(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _JSX_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        # Find <img tags
        img_matches = list(re.finditer(r"<img\b", line, re.IGNORECASE))
        for m in img_matches:
            # Read ahead to find the closing > or />
            tag_content = ""
            for j in range(idx, min(idx + 5, len(lines))):
                tag_content += lines[j]
                if ">" in lines[j][m.end() if j == idx else 0:]:
                    break

            if "alt=" not in tag_content.lower() and "alt =" not in tag_content.lower():
                fixes.append(HealingFix(
                    category=HealingCategory.UNDECLARED_VARIABLE,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.INSERT,
                    description="<img> missing 'alt' attribute — required for accessibility",
                    line=idx,
                    column=m.start(),
                    end_line=idx,
                    end_column=m.end(),
                    original_text="",
                    replacement_text="",
                    confidence=0.95,
                    is_safe=True,
                    affects_logic=False,
                ))

    return fixes


# ── Rule: Empty href ─────────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_A11Y_002",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect <a> tags with empty or '#' href",
)
def detect_empty_href(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _JSX_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    empty_href = re.compile(r'<a\b[^>]*href\s*=\s*["\']#?["\']', re.IGNORECASE)

    for idx, line in enumerate(lines):
        for m in empty_href.finditer(line):
            fixes.append(HealingFix(
                category=HealingCategory.UNDECLARED_VARIABLE,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.REPLACE,
                description="<a> with empty/# href — use <button> for actions, or provide real URL",
                line=idx,
                column=m.start(),
                end_line=idx,
                end_column=m.end(),
                original_text="",
                replacement_text="",
                confidence=0.80,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Missing aria-label on buttons ───────────────────────────────

@healing_rule(
    rule_id="UNI_A11Y_003",
    category=HealingCategory.UNDECLARED_VARIABLE,
    description="Detect icon-only buttons without aria-label",
)
def detect_missing_aria_label(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _JSX_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        # Find button tags
        btn_matches = list(re.finditer(r"<button\b", line, re.IGNORECASE))
        for m in btn_matches:
            # Read the full button element
            tag_content = ""
            for j in range(idx, min(idx + 5, len(lines))):
                tag_content += lines[j] + " "
                if ">" in lines[j][m.end() if j == idx else 0:]:
                    break

            # Check if it's an icon-only button (no text content, has icon/svg child)
            has_label = any(attr in tag_content.lower() for attr in [
                "aria-label", "aria-labelledby", "title="
            ])

            # Check for icon children (svg, i.icon, span.icon)
            close_idx = tag_content.find(">")
            if close_idx >= 0:
                after_open = tag_content[close_idx:]
                has_icon = bool(re.search(r"<(?:svg|i|Icon|img)\b", after_open))
                # Check for visible text
                text_content = re.sub(r"<[^>]+>", "", after_open).strip()
                text_content = text_content.replace("</button>", "").strip()

                if has_icon and not text_content and not has_label:
                    fixes.append(HealingFix(
                        category=HealingCategory.UNDECLARED_VARIABLE,
                        severity=HealingSeverity.CRITICAL,
                        action=HealingAction.INSERT,
                        description="Icon-only <button> missing aria-label for screen readers",
                        line=idx,
                        column=m.start(),
                        end_line=idx,
                        end_column=m.end(),
                        original_text="",
                        replacement_text="",
                        confidence=0.80,
                        is_safe=True,
                        affects_logic=False,
                    ))

    return fixes
