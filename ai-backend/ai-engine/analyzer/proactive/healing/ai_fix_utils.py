"""
Fix deduplication and grouping utilities.

When multiple analysis modes (regex + AI, or multiple AI passes)
find overlapping issues, we need to merge / deduplicate them
before showing to the user.

Also groups fixes by file and severity for batch presentation.
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional, Tuple
from collections import defaultdict

logger = logging.getLogger("healing.ai_fix_utils")

# Severity ordering (higher = more severe)
SEVERITY_ORDER = {
    "critical": 5,
    "high": 4,
    "moderate": 3,
    "low": 2,
    "trivial": 1,
}


def _fix_key(fix) -> str:
    """Generate a dedup key from a fix's location and category."""
    line = getattr(fix, "line", None) or getattr(fix, "start_line", 0)
    end_line = getattr(fix, "end_line", line)
    category = getattr(fix, "category", "") or ""
    return f"{line}:{end_line}:{category}"


def deduplicate_fixes(fixes: list) -> list:
    """
    Remove duplicate fixes that target the same line + category.

    When two fixes overlap, keep the one with higher confidence.
    """
    seen: Dict[str, object] = {}

    for fix in fixes:
        key = _fix_key(fix)
        existing = seen.get(key)

        if existing is None:
            seen[key] = fix
        else:
            # Keep the higher-confidence one
            existing_conf = getattr(existing, "confidence", 0) or 0
            new_conf = getattr(fix, "confidence", 0) or 0
            if new_conf > existing_conf:
                seen[key] = fix

    result = list(seen.values())
    logger.debug("Deduplication: %d → %d fixes", len(fixes), len(result))
    return result


def merge_fix_lists(*fix_lists: list) -> list:
    """
    Merge multiple fix lists (e.g. regex + AI) and deduplicate.

    Fixes from later lists take priority when confidence is equal.
    """
    combined = []
    for fl in fix_lists:
        combined.extend(fl or [])
    return deduplicate_fixes(combined)


def group_by_file(fixes: list) -> Dict[str, list]:
    """Group fixes by file path."""
    groups: Dict[str, list] = defaultdict(list)
    for fix in fixes:
        fp = getattr(fix, "file_path", None) or "unknown"
        groups[fp].append(fix)
    return dict(groups)


def group_by_severity(fixes: list) -> Dict[str, list]:
    """Group fixes by severity level."""
    groups: Dict[str, list] = defaultdict(list)
    for fix in fixes:
        sev = getattr(fix, "severity", "moderate") or "moderate"
        groups[sev].append(fix)
    return dict(groups)


def sort_by_severity(fixes: list, descending: bool = True) -> list:
    """Sort fixes by severity (most severe first by default)."""
    def key_fn(fix):
        sev = getattr(fix, "severity", "moderate") or "moderate"
        return SEVERITY_ORDER.get(sev, 2)

    return sorted(fixes, key=key_fn, reverse=descending)


def sort_by_line(fixes: list) -> list:
    """Sort fixes by line number (ascending)."""
    def key_fn(fix):
        return getattr(fix, "line", 0) or getattr(fix, "start_line", 0) or 0
    return sorted(fixes, key=key_fn)


def count_by_category(fixes: list) -> Dict[str, int]:
    """Count fixes per category."""
    counts: Dict[str, int] = defaultdict(int)
    for fix in fixes:
        cat = getattr(fix, "category", "other") or "other"
        counts[cat] += 1
    return dict(counts)


def safe_fixes(fixes: list) -> list:
    """Return only fixes marked as safe to auto-apply."""
    return [f for f in fixes if getattr(f, "is_safe", False)]


def unsafe_fixes(fixes: list) -> list:
    """Return fixes that require manual review."""
    return [f for f in fixes if not getattr(f, "is_safe", False)]


def fixes_summary(fixes: list) -> Dict:
    """Generate a summary dict for a list of fixes."""
    return {
        "total": len(fixes),
        "safe": len(safe_fixes(fixes)),
        "unsafe": len(unsafe_fixes(fixes)),
        "by_severity": {
            sev: len(group)
            for sev, group in group_by_severity(fixes).items()
        },
        "by_category": count_by_category(fixes),
        "avg_confidence": (
            sum(getattr(f, "confidence", 0) or 0 for f in fixes) / len(fixes)
            if fixes
            else 0
        ),
    }
