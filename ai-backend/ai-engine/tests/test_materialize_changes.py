"""
Tests for WorkspaceAnalyzer._materialize_changes.

Run as a standalone script:
  python -m tests.test_materialize_changes
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analyzer.proactive.hunk_applier import content_hash  # noqa: E402
from analyzer.proactive.types import FileChange, Hunk  # noqa: E402
from analyzer.proactive.workspace_analyzer import (  # noqa: E402
    HunkResolutionError,
    WorkspaceAnalyzer,
)


def _make_analyzer() -> WorkspaceAnalyzer:
    return WorkspaceAnalyzer(enable_ai=False)


def test_full_content_refreshes_baseline():
    a = _make_analyzer()
    base = "x\ny\nz"
    a._materialize_changes("ws1", [
        FileChange(
            path="a.py",
            content_hash=content_hash(base),
            change_type="modified",
            content=base,
        ),
    ])
    assert a._get_base_content("ws1", "a.py") == base, "baseline should be stored"


def test_hunks_apply_against_stored_baseline():
    a = _make_analyzer()
    base = "a\nb\nc"
    a._store_base_content("ws1", "a.py", base)

    new_content = "a\nB\nc"
    change = FileChange(
        path="a.py",
        content_hash=content_hash(new_content),
        change_type="modified",
        content=None,
        hunks=[Hunk(1, 2, ["B"])],
        base_hash=content_hash(base),
    )
    a._materialize_changes("ws1", [change])

    assert change.content == new_content, f"expected reconstructed content, got {change.content!r}"
    assert a._get_base_content("ws1", "a.py") == new_content, "baseline should advance"


def test_missing_baseline_raises():
    a = _make_analyzer()
    new_content = "a\nB\nc"
    change = FileChange(
        path="ghost.py",
        content_hash=content_hash(new_content),
        change_type="modified",
        content=None,
        hunks=[Hunk(0, 0, ["B"])],
        base_hash="deadbeef",
    )
    try:
        a._materialize_changes("ws1", [change])
    except HunkResolutionError as e:
        assert e.code == "BASELINE_MISSING", f"got code {e.code}"
        return
    raise AssertionError("expected HunkResolutionError")


def test_baseline_hash_mismatch_raises_and_drops_baseline():
    a = _make_analyzer()
    base = "a\nb\nc"
    a._store_base_content("ws1", "a.py", base)

    change = FileChange(
        path="a.py",
        content_hash="anything",
        change_type="modified",
        content=None,
        hunks=[Hunk(1, 2, ["B"])],
        base_hash="not-the-real-hash",
    )
    try:
        a._materialize_changes("ws1", [change])
    except HunkResolutionError as e:
        assert e.code == "BASELINE_MISMATCH"
        assert a._get_base_content("ws1", "a.py") is None, "baseline should be dropped"
        return
    raise AssertionError("expected HunkResolutionError")


def test_post_apply_hash_mismatch_raises():
    a = _make_analyzer()
    base = "a\nb\nc"
    a._store_base_content("ws1", "a.py", base)

    change = FileChange(
        path="a.py",
        content_hash="claimed-but-wrong",
        change_type="modified",
        content=None,
        hunks=[Hunk(1, 2, ["B"])],
        base_hash=content_hash(base),
    )
    try:
        a._materialize_changes("ws1", [change])
    except HunkResolutionError as e:
        assert e.code == "POST_APPLY_HASH_MISMATCH"
        assert a._get_base_content("ws1", "a.py") is None
        return
    raise AssertionError("expected HunkResolutionError")


def test_deletion_drops_baseline():
    a = _make_analyzer()
    a._store_base_content("ws1", "a.py", "old")
    a._materialize_changes("ws1", [
        FileChange(path="a.py", content_hash="", change_type="deleted"),
    ])
    assert a._get_base_content("ws1", "a.py") is None


def test_full_content_takes_priority_over_hunks():
    """If both content and hunks are present, content wins."""
    a = _make_analyzer()
    a._store_base_content("ws1", "a.py", "stale-base")
    full = "fresh\ncontent"
    change = FileChange(
        path="a.py",
        content_hash=content_hash(full),
        change_type="modified",
        content=full,
        hunks=[Hunk(0, 0, ["nope"])],
        base_hash="anything",
    )
    a._materialize_changes("ws1", [change])
    assert change.content == full
    assert a._get_base_content("ws1", "a.py") == full


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
