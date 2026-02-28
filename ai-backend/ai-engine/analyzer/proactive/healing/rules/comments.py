"""
Universal healing rule: Comment formatting.

Detects and fixes common comment issues: missing space after comment
delimiter, TODO/FIXME/HACK formatting, commented-out code blocks,
and comment style consistency.
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

_HASH_COMMENT_LANGS = {
    "python", "py", "ruby", "rb", "perl", "pl",
    "shell", "sh", "bash", "zsh", "powershell", "ps1",
    "r", "yaml", "yml", "toml", "coffeescript",
}

_SLASH_COMMENT_LANGS = {
    "javascript", "js", "jsx", "typescript", "ts", "tsx",
    "c", "cpp", "c++", "cxx", "java", "csharp", "cs",
    "go", "rust", "rs", "swift", "kotlin", "dart", "scala", "php",
}

_DASH_COMMENT_LANGS = {"lua", "haskell", "sql"}


# ── Rule: Missing space after comment delimiter ───────────────────────

@healing_rule(
    rule_id="UNI_CMT_001",
    category=HealingCategory.TRAILING_WHITESPACE,
    description="Add missing space after comment delimiter (# → # , // → // )",
)
def detect_missing_comment_space(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect comments that lack a space after the delimiter."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        stripped = line.lstrip()

        # Hash comments
        if lang in _HASH_COMMENT_LANGS:
            if stripped.startswith("#") and not stripped.startswith("# ") and not stripped.startswith("#!"):
                # Skip shebangs (#!) and empty comments (#\n)
                if len(stripped) > 1 and stripped[1] != " " and stripped[1] != "\n":
                    col = len(line) - len(stripped)
                    fixes.append(HealingFix(
                        category=HealingCategory.TRAILING_WHITESPACE,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.REPLACE,
                        description="Add space after '#' comment delimiter",
                        line=idx,
                        column=col,
                        end_line=idx,
                        end_column=col + 1,
                        original_text="#",
                        replacement_text="# ",
                        confidence=0.92,
                        is_safe=True,
                        affects_logic=False,
                    ))

        # Slash comments
        if lang in _SLASH_COMMENT_LANGS:
            if stripped.startswith("//") and not stripped.startswith("// ") and not stripped.startswith("///"):
                if len(stripped) > 2 and stripped[2] != " " and stripped[2] != "\n":
                    col = len(line) - len(stripped)
                    fixes.append(HealingFix(
                        category=HealingCategory.TRAILING_WHITESPACE,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.REPLACE,
                        description="Add space after '//' comment delimiter",
                        line=idx,
                        column=col,
                        end_line=idx,
                        end_column=col + 2,
                        original_text="//",
                        replacement_text="// ",
                        confidence=0.92,
                        is_safe=True,
                        affects_logic=False,
                    ))

        # Dash comments (Lua: --, SQL: --, Haskell: --)
        if lang in _DASH_COMMENT_LANGS:
            if stripped.startswith("--") and not stripped.startswith("-- "):
                if len(stripped) > 2 and stripped[2] != " " and stripped[2] != "-":
                    col = len(line) - len(stripped)
                    fixes.append(HealingFix(
                        category=HealingCategory.TRAILING_WHITESPACE,
                        severity=HealingSeverity.LOW,
                        action=HealingAction.REPLACE,
                        description="Add space after '--' comment delimiter",
                        line=idx,
                        column=col,
                        end_line=idx,
                        end_column=col + 2,
                        original_text="--",
                        replacement_text="-- ",
                        confidence=0.92,
                        is_safe=True,
                        affects_logic=False,
                    ))

    return fixes


# ── Rule: TODO/FIXME/HACK formatting ─────────────────────────────────

@healing_rule(
    rule_id="UNI_CMT_002",
    category=HealingCategory.TRAILING_WHITESPACE,
    description="Normalise TODO / FIXME / HACK / XXX tags in comments",
)
def detect_todo_formatting(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect inconsistently formatted TODO/FIXME/HACK tags."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Match variations: todo, Todo, fixme, Fixme, hack, Hack, xxx
    tag_pattern = re.compile(
        r"\b(todo|fixme|hack|xxx)\b(?:\s*:)?",
        re.IGNORECASE,
    )

    for idx, line in enumerate(lines):
        # Only process in comments (rough heuristic: line has # or //)
        if "#" not in line and "//" not in line and "--" not in line:
            continue

        for m in tag_pattern.finditer(line):
            tag = m.group(1)
            full_match = m.group(0)
            upper_tag = tag.upper()

            # Tag should be uppercase and followed by ":"
            expected = upper_tag + ":"
            if full_match.rstrip() == expected:
                continue

            if tag != upper_tag or ":" not in full_match:
                fixes.append(HealingFix(
                    category=HealingCategory.TRAILING_WHITESPACE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"Normalise '{tag}' to '{upper_tag}:'",
                    line=idx,
                    column=m.start(),
                    end_line=idx,
                    end_column=m.end(),
                    original_text=full_match,
                    replacement_text=expected,
                    confidence=0.85,
                    is_safe=True,
                    affects_logic=False,
                ))

    return fixes


# ── Rule: Large commented-out code blocks ─────────────────────────────

@healing_rule(
    rule_id="UNI_CMT_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect large blocks of commented-out code (5+ lines)",
)
def detect_commented_out_code(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect large blocks of commented-out code that should be removed."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    lang = language.lower()

    # Determine comment prefix
    if lang in _HASH_COMMENT_LANGS:
        prefix = "#"
    elif lang in _SLASH_COMMENT_LANGS:
        prefix = "//"
    elif lang in _DASH_COMMENT_LANGS:
        prefix = "--"
    else:
        return fixes

    run_start = -1
    run_count = 0
    threshold = 5  # Minimum lines to flag

    for idx, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith(prefix):
            if run_count == 0:
                run_start = idx
            run_count += 1
        else:
            if run_count >= threshold:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.DELETE,
                    description=f"Consider removing {run_count} lines of commented-out code",
                    line=run_start,
                    column=0,
                    end_line=run_start + run_count - 1,
                    end_column=len(lines[run_start + run_count - 1]),
                    original_text="",
                    replacement_text="",
                    confidence=0.65,
                    is_safe=False,  # user may want to keep
                    affects_logic=False,
                ))
            run_count = 0

    # Handle block at end of file
    if run_count >= threshold:
        fixes.append(HealingFix(
            category=HealingCategory.UNUSED_VARIABLE,
            severity=HealingSeverity.LOW,
            action=HealingAction.DELETE,
            description=f"Consider removing {run_count} lines of commented-out code",
            line=run_start,
            column=0,
            end_line=run_start + run_count - 1,
            end_column=len(lines[run_start + run_count - 1]),
            original_text="",
            replacement_text="",
            confidence=0.65,
            is_safe=False,
            affects_logic=False,
        ))

    return fixes
