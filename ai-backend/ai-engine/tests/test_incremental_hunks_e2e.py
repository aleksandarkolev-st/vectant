"""
End-to-end integration test for hunk-based incremental analysis.

Drives the WorkspaceAnalyzer directly (no HTTP) through a realistic
sequence:

  1. Initial full-content request establishes baseline.
  2. Hunk-only follow-up is materialized against the baseline and analyzed.
  3. Stale-baseline scenario raises HunkResolutionError.

This catches integration regressions where the schema, applier, baseline
store, and analyze_incremental flow disagree.

Run as a standalone script:
  python -m tests.test_incremental_hunks_e2e
"""
from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analyzer.proactive.hunk_applier import content_hash  # noqa: E402
from analyzer.proactive.types import (  # noqa: E402
    FileChange,
    FileContext,
    Hunk,
    WorkspaceAnalysisRequest,
)
from analyzer.proactive.workspace_analyzer import (  # noqa: E402
    HunkResolutionError,
    WorkspaceAnalyzer,
)


WORKSPACE_ID = "ws-e2e"


def _request(
    *,
    changed: list[FileChange],
    all_files: list[FileContext],
    incremental: bool = True,
) -> WorkspaceAnalysisRequest:
    return WorkspaceAnalysisRequest(
        workspace_id=WORKSPACE_ID,
        changed_files=changed,
        all_files=all_files,
        incremental=incremental,
        analyze_dependents=False,
        include_ai=False,
        max_diagnostics_per_file=50,
        max_total_diagnostics=200,
    )


async def _run_initial_then_hunk():
    a = WorkspaceAnalyzer(enable_ai=False)
    initial = "def hello():\n    return 'world'\n"
    initial_hash = content_hash(initial)

    # 1. Initial full-content request establishes baseline.
    req1 = _request(
        changed=[
            FileChange(
                path="hello.py",
                content_hash=initial_hash,
                change_type="modified",
                content=initial,
                language="python",
            ),
        ],
        all_files=[FileContext(path="hello.py", content=initial, language="python")],
    )
    result1 = await a.analyze_incremental(req1)
    assert "hello.py" in result1.files, "initial analysis missing file"
    assert a._get_base_content(WORKSPACE_ID, "hello.py") == initial, "baseline not stored"

    # 2. Hunk-only follow-up: replace return value.
    new_content = "def hello():\n    return 'hunked'\n"
    new_hash = content_hash(new_content)
    hunk = Hunk(start_line=1, end_line=2, new_lines=["    return 'hunked'"])
    req2 = _request(
        changed=[
            FileChange(
                path="hello.py",
                content_hash=new_hash,
                change_type="modified",
                content=None,
                language="python",
                hunks=[hunk],
                base_hash=initial_hash,
            ),
        ],
        all_files=[FileContext(path="hello.py", content=new_content, language="python")],
    )
    result2 = await a.analyze_incremental(req2)
    assert "hello.py" in result2.files, "hunk-only analysis missing file"
    assert a._get_base_content(WORKSPACE_ID, "hello.py") == new_content, (
        "baseline did not advance after hunk apply"
    )


async def _run_stale_baseline():
    a = WorkspaceAnalyzer(enable_ai=False)
    a._store_base_content(WORKSPACE_ID, "x.py", "real-base\n")

    new_content = "irrelevant"
    req = _request(
        changed=[
            FileChange(
                path="x.py",
                content_hash=content_hash(new_content),
                change_type="modified",
                content=None,
                language="python",
                hunks=[Hunk(0, 1, ["whatever"])],
                base_hash="not-the-real-hash",
            ),
        ],
        all_files=[],
    )
    raised = False
    try:
        await a.analyze_incremental(req)
    except HunkResolutionError as e:
        raised = True
        assert e.code == "BASELINE_MISMATCH"
        assert e.path == "x.py"
    assert raised, "expected HunkResolutionError on stale baseline"
    assert a._get_base_content(WORKSPACE_ID, "x.py") is None, (
        "stale baseline should be dropped after mismatch"
    )


async def _run_missing_baseline():
    a = WorkspaceAnalyzer(enable_ai=False)
    req = _request(
        changed=[
            FileChange(
                path="ghost.py",
                content_hash="abc",
                change_type="modified",
                content=None,
                hunks=[Hunk(0, 0, ["x"])],
                base_hash="anything",
            ),
        ],
        all_files=[],
    )
    raised = False
    try:
        await a.analyze_incremental(req)
    except HunkResolutionError as e:
        raised = True
        assert e.code == "BASELINE_MISSING"
    assert raised, "expected HunkResolutionError on missing baseline"


async def _run_all_files_seeds_baseline():
    """First incremental request whose all_files carries content should
    seed the baseline so a subsequent hunk-only request can apply."""
    a = WorkspaceAnalyzer(enable_ai=False)
    initial = "x = 1\ny = 2\n"
    # No changed_files at all — just a full-context request.
    req1 = _request(
        changed=[],
        all_files=[FileContext(path="m.py", content=initial, language="python")],
        incremental=False,
    )
    await a.analyze(req1)
    assert a._get_base_content(WORKSPACE_ID, "m.py") == initial, (
        "all_files content should seed baseline via analyze()"
    )

    # Now a hunk-only request should succeed.
    new_content = "x = 1\ny = 99\n"
    req2 = _request(
        changed=[
            FileChange(
                path="m.py",
                content_hash=content_hash(new_content),
                change_type="modified",
                content=None,
                language="python",
                hunks=[Hunk(1, 2, ["y = 99"])],
                base_hash=content_hash(initial),
            ),
        ],
        all_files=[],
    )
    await a.analyze_incremental(req2)
    assert a._get_base_content(WORKSPACE_ID, "m.py") == new_content


async def main():
    cases = [
        ("initial then hunk", _run_initial_then_hunk),
        ("stale baseline", _run_stale_baseline),
        ("missing baseline", _run_missing_baseline),
        ("all_files seeds baseline", _run_all_files_seeds_baseline),
    ]
    failed = 0
    for label, fn in cases:
        try:
            await fn()
            print(f"PASS {label}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {label}: {e}")
        except Exception as e:
            failed += 1
            print(f"FAIL {label}: unexpected {type(e).__name__}: {e}")
    if failed:
        print(f"\n{failed} of {len(cases)} failed")
        sys.exit(1)
    print(f"\nall {len(cases)} passed")


if __name__ == "__main__":
    asyncio.run(main())
