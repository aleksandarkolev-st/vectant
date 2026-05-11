"""
Hunk-level diff application for incremental workspace analysis.

A Hunk replaces a half-open line range [start_line, end_line) of a base
document with a list of replacement lines. Multiple hunks describing one
transformation must be sorted by start_line and non-overlapping, all
computed against the same baseline.

The applier reconstructs the new full document so the rest of the analysis
pipeline is unchanged. Callers verify the result hash matches the
client-claimed content_hash; mismatches mean the baseline diverged and the
client must resend full content.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import List


class HunkApplicationError(Exception):
    """Raised when a hunk list cannot be safely applied to a base document."""


@dataclass
class Hunk:
    start_line: int
    end_line: int
    new_lines: List[str]

    def __post_init__(self):
        if self.start_line < 0 or self.end_line < self.start_line:
            raise HunkApplicationError(
                f"invalid hunk range [{self.start_line}, {self.end_line})"
            )


def _split_lines_keep_trailing(content: str) -> List[str]:
    """Split content into lines without keeping line terminators.

    A trailing newline produces an extra empty string so that the round-trip
    `"\\n".join(_split_lines_keep_trailing(s)) == s` holds for any string.
    """
    return content.split("\n")


def apply_hunks(base_content: str, hunks: List[Hunk]) -> str:
    """Apply an ordered list of hunks to base_content and return the result.

    Hunks must be sorted by start_line ascending and non-overlapping. Each
    hunk's end_line must not exceed the base line count.
    """
    base_lines = _split_lines_keep_trailing(base_content)
    base_len = len(base_lines)

    out: List[str] = []
    cursor = 0

    for i, hunk in enumerate(hunks):
        if hunk.start_line < cursor:
            raise HunkApplicationError(
                f"hunk {i} starts at {hunk.start_line} but cursor is {cursor} "
                f"(overlapping or out-of-order)"
            )
        if hunk.end_line > base_len:
            raise HunkApplicationError(
                f"hunk {i} end_line {hunk.end_line} exceeds base length {base_len}"
            )

        out.extend(base_lines[cursor:hunk.start_line])
        out.extend(hunk.new_lines)
        cursor = hunk.end_line

    out.extend(base_lines[cursor:])
    return "\n".join(out)


def content_hash(content: str) -> str:
    """SHA-256 (truncated) — matches FileContext hashing in types.py."""
    return hashlib.sha256(content.encode()).hexdigest()[:16]
