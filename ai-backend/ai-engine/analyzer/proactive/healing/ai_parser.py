"""
AI response parser.

Parses raw LLM text output into structured HealingFix objects.
Handles JSON extraction from noisy LLM responses (markdown fences,
preamble text, trailing commas, etc.).
"""

from __future__ import annotations

import json
import re
import logging
from typing import Any, Dict, List, Optional, Tuple

from .types import (
    HealingCategory,
    HealingSeverity,
    HealingAction,
    HealingFix,
)

logger = logging.getLogger("healing.ai_parser")

# ── Category mapping ──────────────────────────────────────────────────

_AI_CATEGORY_MAP: Dict[str, HealingCategory] = {
    "logic_error": HealingCategory.EQUALITY_VS_ASSIGNMENT,
    "null_safety": HealingCategory.COMPARISON_TO_NONE,
    "type_mismatch": HealingCategory.OBVIOUS_TYPE_MISMATCH,
    "missing_await": HealingCategory.MISSING_SEMICOLON,  # reuse
    "resource_leak": HealingCategory.UNUSED_VARIABLE,     # reuse
    "api_misuse": HealingCategory.UNDECLARED_VARIABLE,    # reuse
    "off_by_one": HealingCategory.EQUALITY_VS_ASSIGNMENT,
    "error_handling": HealingCategory.MISSING_BRACKET,    # reuse
    "variable_misuse": HealingCategory.UNDECLARED_VARIABLE,
    "security": HealingCategory.UNDECLARED_VARIABLE,
    "concurrency": HealingCategory.UNDECLARED_VARIABLE,
    "other": HealingCategory.UNUSED_VARIABLE,
}

_SEVERITY_MAP: Dict[str, HealingSeverity] = {
    "critical": HealingSeverity.CRITICAL,
    "moderate": HealingSeverity.MODERATE,
    "low": HealingSeverity.LOW,
}


# ── JSON extraction ───────────────────────────────────────────────────

def _extract_json_from_text(text: str) -> str:
    """
    Extract JSON content from potentially noisy LLM output.

    Handles:
    - Markdown code fences (```json ... ```)
    - Preamble/postamble text around the JSON
    - Bare JSON arrays or objects
    """
    text = text.strip()

    # Try to extract from markdown fences
    fence_match = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", text)
    if fence_match:
        text = fence_match.group(1).strip()

    # Find the first [ or { and match to its closing counterpart
    for start_idx, char in enumerate(text):
        if char == "[":
            return _extract_balanced(text, start_idx, "[", "]")
        if char == "{":
            return _extract_balanced(text, start_idx, "{", "}")

    return text


def _extract_balanced(text: str, start: int, open_ch: str, close_ch: str) -> str:
    """Extract balanced brackets/braces from text."""
    depth = 0
    in_string = False
    escape = False

    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"' and not escape:
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]

    # If unbalanced, return from start to end
    return text[start:]


def _fix_json_quirks(text: str) -> str:
    """Fix common JSON issues from LLM output."""
    # Remove trailing commas before } or ]
    text = re.sub(r",\s*([}\]])", r"\1", text)
    # Remove single-line comments
    text = re.sub(r"//[^\n]*", "", text)
    return text


# ── Parse detection response ─────────────────────────────────────────

def parse_detection_response(
    raw_text: str,
    source_code: str,
    file_path: str = "untitled",
) -> List[HealingFix]:
    """
    Parse an LLM detection response into HealingFix objects.

    Validates each fix against the actual source code:
    - Line numbers must be in range
    - Original text must appear near the indicated line
    - Replacement text must differ from original
    """
    if not raw_text or not raw_text.strip():
        return []

    json_text = _extract_json_from_text(raw_text)
    json_text = _fix_json_quirks(json_text)

    try:
        parsed = json.loads(json_text)
    except json.JSONDecodeError as e:
        logger.warning(f"Failed to parse AI response as JSON: {e}")
        logger.debug(f"Raw text: {raw_text[:500]}")
        return []

    if not isinstance(parsed, list):
        logger.warning(f"AI response is not a JSON array: {type(parsed)}")
        return []

    source_lines = source_code.split("\n")
    fixes: List[HealingFix] = []

    for idx, item in enumerate(parsed):
        if not isinstance(item, dict):
            continue

        fix = _parse_single_fix(item, source_lines, file_path, idx)
        if fix is not None:
            fixes.append(fix)

    logger.info(f"Parsed {len(fixes)} AI-detected fixes from {len(parsed)} raw items")
    return fixes


def _parse_single_fix(
    item: Dict[str, Any],
    source_lines: List[str],
    file_path: str,
    idx: int,
) -> Optional[HealingFix]:
    """Parse and validate a single fix from the AI response."""
    # Required fields
    line = item.get("line")
    original = item.get("original", "")
    replacement = item.get("replacement", "")
    description = item.get("description", "AI-detected issue")

    if line is None:
        logger.debug(f"Fix #{idx}: missing 'line' field")
        return None

    # Convert to 0-indexed
    line_0 = int(line) - 1
    end_line_0 = int(item.get("end_line", line)) - 1

    # Validate line range
    if line_0 < 0 or line_0 >= len(source_lines):
        logger.debug(f"Fix #{idx}: line {line} out of range (file has {len(source_lines)} lines)")
        return None

    end_line_0 = min(end_line_0, len(source_lines) - 1)

    # Validate original text exists near the indicated line
    original_stripped = original.strip()
    if original_stripped:
        found_line = _find_original_text(original_stripped, source_lines, line_0, search_radius=3)
        if found_line is None:
            logger.debug(
                f"Fix #{idx}: original text not found near line {line}: "
                f"'{original_stripped[:60]}'"
            )
            return None
        # Adjust line if we found it nearby
        if found_line != line_0:
            offset = found_line - line_0
            line_0 = found_line
            end_line_0 += offset

    # Skip no-op fixes
    if original.strip() == replacement.strip():
        logger.debug(f"Fix #{idx}: original == replacement, skipping")
        return None

    # Determine action
    if not original_stripped and replacement.strip():
        action = HealingAction.INSERT
    elif original_stripped and not replacement.strip():
        action = HealingAction.DELETE
    else:
        action = HealingAction.REPLACE

    # Compute column positions
    if original_stripped and line_0 < len(source_lines):
        col_start = source_lines[line_0].find(original_stripped)
        if col_start < 0:
            col_start = 0
        col_end = col_start + len(original_stripped)
    else:
        col_start = 0
        col_end = len(source_lines[line_0]) if line_0 < len(source_lines) else 0

    # Map category
    cat_str = item.get("category", "other").lower()
    category = _AI_CATEGORY_MAP.get(cat_str, HealingCategory.UNUSED_VARIABLE)

    # Map severity
    sev_str = item.get("severity", "moderate").lower()
    severity = _SEVERITY_MAP.get(sev_str, HealingSeverity.MODERATE)

    # Confidence from AI
    confidence = float(item.get("confidence", 0.7))
    confidence = max(0.0, min(1.0, confidence))

    return HealingFix(
        category=category,
        severity=severity,
        action=action,
        description=f"[AI] {description}",
        line=line_0,
        column=col_start,
        end_line=end_line_0,
        end_column=col_end,
        original_text=original,
        replacement_text=replacement,
        confidence=confidence,
        is_safe=False,  # AI fixes always start as unsafe — classifier decides
        affects_logic=True,  # Assume AI fixes affect logic until proven otherwise
        rule_id=f"AI_{cat_str.upper()}",
    )


def _find_original_text(
    text: str,
    source_lines: List[str],
    expected_line: int,
    search_radius: int = 3,
) -> Optional[int]:
    """
    Find the line containing the original text, searching near the
    expected line.  Returns the 0-indexed line number, or None.
    """
    start = max(0, expected_line - search_radius)
    end = min(len(source_lines), expected_line + search_radius + 1)

    for i in range(start, end):
        if text in source_lines[i]:
            return i

    # Also try joining consecutive lines (for multi-line originals)
    for i in range(start, end - 1):
        combined = source_lines[i] + "\n" + source_lines[i + 1]
        if text in combined:
            return i

    return None


# ── Parse validation response ─────────────────────────────────────────

def parse_validation_response(raw_text: str) -> Dict[str, Any]:
    """
    Parse an LLM validation response.

    Returns dict with: is_valid, confidence, reason, improved_replacement
    """
    if not raw_text:
        return {"is_valid": False, "confidence": 0.0, "reason": "Empty response"}

    json_text = _extract_json_from_text(raw_text)
    json_text = _fix_json_quirks(json_text)

    try:
        parsed = json.loads(json_text)
    except json.JSONDecodeError:
        logger.warning("Failed to parse validation response")
        return {"is_valid": False, "confidence": 0.0, "reason": "Parse error"}

    if not isinstance(parsed, dict):
        return {"is_valid": False, "confidence": 0.0, "reason": "Not a JSON object"}

    return {
        "is_valid": bool(parsed.get("is_valid", False)),
        "confidence": float(parsed.get("confidence", 0.0)),
        "reason": str(parsed.get("reason", "")),
        "improved_replacement": parsed.get("improved_replacement"),
    }


# ── Parse batch response ──────────────────────────────────────────────

def parse_batch_response(
    raw_text: str,
    files: Dict[str, str],
) -> Dict[str, List[HealingFix]]:
    """
    Parse a batch detection response.

    Returns dict of file_path -> List[HealingFix].
    """
    if not raw_text:
        return {}

    json_text = _extract_json_from_text(raw_text)
    json_text = _fix_json_quirks(json_text)

    try:
        parsed = json.loads(json_text)
    except json.JSONDecodeError:
        logger.warning("Failed to parse batch AI response")
        return {}

    if not isinstance(parsed, dict):
        return {}

    results: Dict[str, List[HealingFix]] = {}

    for path, items in parsed.items():
        if not isinstance(items, list):
            continue
        source = files.get(path, "")
        if not source:
            continue
        fixes = parse_detection_response(
            json.dumps(items), source, file_path=path
        )
        if fixes:
            results[path] = fixes

    return results
