"""
HTTP-layer regression tests for hunk-based incremental analysis.

Drives the FastAPI app via TestClient so the schema, endpoint mapping,
analyzer pipeline, and HunkResolutionError -> 409 translation all run
together. Catches regressions where the wire format and the analyzer
disagree.

Run as a standalone script:
  python -m tests.test_incremental_hunks_http
"""
from __future__ import annotations

import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _hash(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()[:16]


def _client():
    from fastapi.testclient import TestClient
    import main
    return TestClient(main.app)


def test_409_when_no_baseline():
    client = _client()
    r = client.post(
        "/analyze/workspace/incremental",
        json={
            "workspace_id": "ws-http-1",
            "changed_files": [{
                "path": "a.py",
                "content_hash": "abc",
                "change_type": "modified",
                "hunks": [{"start_line": 0, "end_line": 0, "new_lines": ["x"]}],
                "base_hash": "anything",
            }],
            "all_files": [],
            "incremental": True,
        },
    )
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "hunk_resolution_failed"
    assert detail["code"] == "BASELINE_MISSING"
    assert detail["path"] == "a.py"


def test_round_trip_full_then_hunk():
    client = _client()
    ws = "ws-http-2"
    initial = "a=1\nb=2\n"
    new = "a=1\nb=99\n"

    r1 = client.post(
        "/analyze/workspace/incremental",
        json={
            "workspace_id": ws,
            "changed_files": [{
                "path": "a.py",
                "content_hash": _hash(initial),
                "change_type": "modified",
                "content": initial,
                "language": "python",
            }],
            "all_files": [{"path": "a.py", "content": initial, "language": "python"}],
            "incremental": True,
        },
    )
    assert r1.status_code == 200, r1.text

    r2 = client.post(
        "/analyze/workspace/incremental",
        json={
            "workspace_id": ws,
            "changed_files": [{
                "path": "a.py",
                "content_hash": _hash(new),
                "change_type": "modified",
                "language": "python",
                "hunks": [{"start_line": 1, "end_line": 2, "new_lines": ["b=99"]}],
                "base_hash": _hash(initial),
            }],
            "all_files": [],
            "incremental": True,
        },
    )
    assert r2.status_code == 200, r2.text
    assert "a.py" in r2.json().get("files", {}), "file missing from analysis result"


def test_legacy_full_content_path_still_works():
    client = _client()
    ws = "ws-http-3"
    for src in ("x=1", "x=2", "x=3"):
        r = client.post(
            "/analyze/workspace/incremental",
            json={
                "workspace_id": ws,
                "changed_files": [{
                    "path": "a.py",
                    "content_hash": _hash(src),
                    "change_type": "modified",
                    "content": src,
                    "language": "python",
                }],
                "all_files": [{"path": "a.py", "content": src, "language": "python"}],
                "incremental": True,
            },
        )
        assert r.status_code == 200, r.text


def test_post_apply_hash_mismatch_409():
    client = _client()
    ws = "ws-http-4"
    initial = "a\nb\nc\n"
    client.post(
        "/analyze/workspace/incremental",
        json={
            "workspace_id": ws,
            "changed_files": [{
                "path": "a.py",
                "content_hash": _hash(initial),
                "change_type": "modified",
                "content": initial,
                "language": "python",
            }],
            "all_files": [{"path": "a.py", "content": initial, "language": "python"}],
            "incremental": True,
        },
    )

    # Send hunks that DO apply against the baseline but claim a wrong content_hash.
    r = client.post(
        "/analyze/workspace/incremental",
        json={
            "workspace_id": ws,
            "changed_files": [{
                "path": "a.py",
                "content_hash": "totally-bogus",
                "change_type": "modified",
                "language": "python",
                "hunks": [{"start_line": 1, "end_line": 2, "new_lines": ["B"]}],
                "base_hash": _hash(initial),
            }],
            "all_files": [],
            "incremental": True,
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "POST_APPLY_HASH_MISMATCH"


def main():
    cases = [
        test_409_when_no_baseline,
        test_round_trip_full_then_hunk,
        test_legacy_full_content_path_still_works,
        test_post_apply_hash_mismatch_409,
    ]
    failed = 0
    for fn in cases:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"FAIL {fn.__name__}: unexpected {type(e).__name__}: {e}")
    if failed:
        print(f"\n{failed} of {len(cases)} failed")
        sys.exit(1)
    print(f"\nall {len(cases)} passed")


if __name__ == "__main__":
    main()
