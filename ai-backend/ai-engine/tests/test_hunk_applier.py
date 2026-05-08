"""
Unit tests for the hunk applier.

Run as a standalone script:
  python -m tests.test_hunk_applier

Or via pytest:
  pytest tests/test_hunk_applier.py
"""
from __future__ import annotations

import os
import sys

# Allow running without pytest from the ai-engine root
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analyzer.proactive.hunk_applier import (  # noqa: E402
    Hunk,
    HunkApplicationError,
    apply_hunks,
    content_hash,
)


def _expect(label: str, got, want):
    if got != want:
        raise AssertionError(f"{label}: got {got!r}, want {want!r}")


def test_no_hunks_returns_base():
    base = "a\nb\nc"
    _expect("identity", apply_hunks(base, []), base)


def test_single_line_replace():
    base = "a\nb\nc"
    out = apply_hunks(base, [Hunk(1, 2, ["B"])])
    _expect("replace middle", out, "a\nB\nc")


def test_insert_at_top():
    base = "a\nb"
    out = apply_hunks(base, [Hunk(0, 0, ["x", "y"])])
    _expect("insert top", out, "x\ny\na\nb")


def test_insert_at_bottom():
    base = "a\nb"
    out = apply_hunks(base, [Hunk(2, 2, ["c"])])
    _expect("insert bottom", out, "a\nb\nc")


def test_delete_range():
    base = "a\nb\nc\nd"
    out = apply_hunks(base, [Hunk(1, 3, [])])
    _expect("delete range", out, "a\nd")


def test_multiple_non_overlapping_hunks():
    base = "0\n1\n2\n3\n4\n5"
    hunks = [
        Hunk(1, 2, ["one"]),
        Hunk(4, 5, ["four"]),
    ]
    out = apply_hunks(base, hunks)
    _expect("multi-hunk", out, "0\none\n2\n3\nfour\n5")


def test_full_replace():
    base = "a\nb\nc"
    out = apply_hunks(base, [Hunk(0, 3, ["x", "y"])])
    _expect("full replace", out, "x\ny")


def test_trailing_newline_preserved():
    base = "a\nb\n"  # split -> ["a","b",""]
    out = apply_hunks(base, [Hunk(1, 2, ["B"])])
    _expect("trailing nl", out, "a\nB\n")


def test_empty_base_pure_insert():
    base = ""
    out = apply_hunks(base, [Hunk(0, 0, ["hello"])])
    # split("") -> [""] so length is 1; new_lines + [""] -> "hello\n"
    # But cursor lands at 0, hunk replaces [0,0) so we extend with new_lines
    # then extend with base_lines[0:] which is [""].
    _expect("empty base", out, "hello\n")


def test_overlapping_rejected():
    base = "a\nb\nc"
    try:
        apply_hunks(base, [Hunk(0, 2, ["x"]), Hunk(1, 3, ["y"])])
    except HunkApplicationError:
        return
    raise AssertionError("expected overlap to raise")


def test_out_of_bounds_rejected():
    base = "a\nb"
    try:
        apply_hunks(base, [Hunk(0, 5, ["x"])])
    except HunkApplicationError:
        return
    raise AssertionError("expected out-of-bounds to raise")


def test_invalid_range_rejected():
    try:
        Hunk(5, 3, [])
    except HunkApplicationError:
        return
    raise AssertionError("expected invalid range to raise")


def test_hash_matches_after_apply():
    base = "line0\nline1\nline2\n"
    new = apply_hunks(base, [Hunk(1, 2, ["LINE1!"])])
    _expect("hash matches", content_hash(new), content_hash("line0\nLINE1!\nline2\n"))


def main():
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    if failed:
        print(f"\n{failed} of {len(tests)} failed")
        sys.exit(1)
    print(f"\nall {len(tests)} passed")


if __name__ == "__main__":
    main()
