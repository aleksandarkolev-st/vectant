#!/usr/bin/env python3
"""
ULTRAPLAN Phase 7 — universal split corpus test runner.

Sends each `.cpp` file in `tests/corpus/` to the running ai-engine's
`/refactor/split/verified` endpoint and asserts the returned manifest
matches the structural contract in `tests/corpus/expected.json`.

The assertions are deliberately loose (substring matches, allowed-value
sets) because exact AI output will drift across model versions —
the structural contract must hold regardless. See `corpus/README.md`
for the assertion semantics.

Prerequisites:
  - ai-engine running (default: http://localhost:8000)
  - GEMINI_API_KEY set in the ai-engine env (NOT here)

Usage:
  python3 tests/test_universal_split.py
  python3 tests/test_universal_split.py --url http://localhost:8000
  python3 tests/test_universal_split.py --only 01_sdl2_button.cpp

~11 real Gemini API calls, ~$0.05, ~1-3 minutes total. Exit 0 on full
pass, 1 on partial, 2 on full failure (zero passing).

Runs as a standalone script (no pytest dep). If pytest is installed,
`pytest tests/test_universal_split.py` also works via the `test_corpus_all`
wrapper at the bottom.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_BASE_URL = "http://localhost:8000"
TIMEOUT_SEC = 300.0

CORPUS_DIR = Path(__file__).parent / "corpus"
EXPECTED_PATH = CORPUS_DIR / "expected.json"


def load_expected() -> Dict[str, Any]:
    with open(EXPECTED_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    # Strip comment keys
    return {k: v for k, v in data.items() if not k.startswith("_")}


def list_corpus_files() -> List[Path]:
    """All .cpp files in the corpus dir, sorted by filename prefix."""
    return sorted(p for p in CORPUS_DIR.glob("*.cpp"))


# ─────────────────────────────────────────────────────────────────────────────
# HTTP
# ─────────────────────────────────────────────────────────────────────────────


def post_json(url: str, payload: dict, timeout_s: float) -> tuple[int, Any, float]:
    body_bytes = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body_bytes, method="POST",
        headers={"Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            elapsed = time.time() - t0
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return resp.status, json.loads(raw), elapsed
            except json.JSONDecodeError:
                return resp.status, raw, elapsed
    except urllib.error.HTTPError as e:
        elapsed = time.time() - t0
        body_text = e.read().decode("utf-8", errors="replace") if e.fp else str(e)
        try:
            return e.code, json.loads(body_text), elapsed
        except json.JSONDecodeError:
            return e.code, body_text, elapsed
    except Exception as e:
        elapsed = time.time() - t0
        return 0, f"{type(e).__name__}: {e}", elapsed


# ─────────────────────────────────────────────────────────────────────────────
# Assertions
# ─────────────────────────────────────────────────────────────────────────────


def _flag_contains_substring(flags: List[str], substring: str) -> bool:
    """True iff at least one flag contains `substring` (case-insensitive)."""
    needle = substring.lower()
    return any(needle in f.lower() for f in flags)


def check(name: str, condition: bool, detail: str = "") -> tuple[str, bool, str]:
    tag = "\033[32mPASS\033[0m" if condition else "\033[31mFAIL\033[0m"
    line = f"    [{tag}] {name}"
    if detail and not condition:
        line += f"\n           → {detail}"
    print(line)
    return (name, condition, detail)


def validate_corpus_entry(
    filename: str, body: Any, expected: Dict[str, Any]
) -> List[tuple[str, bool, str]]:
    out: List[tuple[str, bool, str]] = []

    expect_rejection = expected.get("expect_rejection", False)

    # Rejection path: the worker returns HTTP 422 for V1-unsupported
    # projects (multi-step builds, etc.). FastAPI's 422 responses carry
    # the rejection message in `body.detail` (string), so we search BOTH
    # the manifest path (for fat JSON responses) AND the detail path
    # (for lean 422s) before declaring the rejection marker missing.
    if expect_rejection:
        notes_keywords = expected.get("notes_keywords", [])
        # Fallback keyword set if expected.json lists none — catches
        # the common rejection phrases the Python side emits.
        fallback_keywords = ["moc", "q_object", "qt", "multi-step", "build_steps", "pre-compile"]
        search_keywords = notes_keywords or fallback_keywords

        manifest_notes = ""
        build_steps = None
        detail_str = ""

        if isinstance(body, dict):
            manifest = body.get("manifest") or {}
            if isinstance(manifest, dict):
                build_steps = manifest.get("build_steps")
                conf = manifest.get("confidence") or {}
                manifest_notes = str(conf.get("notes", "")).lower()
            # FastAPI 422 puts the rejection message here — check it too
            detail_str = str(body.get("detail", "")).lower()
        else:
            detail_str = str(body).lower()

        rejected_via_build_steps = bool(build_steps)
        rejected_via_notes = any(kw.lower() in manifest_notes for kw in search_keywords)
        rejected_via_detail = any(kw.lower() in detail_str for kw in search_keywords)

        out.append(check(
            "rejection marker present (build_steps OR notes OR detail mentions rejection keyword)",
            rejected_via_build_steps or rejected_via_notes or rejected_via_detail,
            f"build_steps={build_steps!r}, notes={manifest_notes[:120]!r}, detail={detail_str[:200]!r}",
        ))
        return out

    # Happy path: response should be a dict with manifest + result
    if not isinstance(body, dict):
        out.append(check("response is a JSON object", False, f"got {type(body).__name__}"))
        return out

    out.append(check("response has 'manifest' field", "manifest" in body))
    manifest = body.get("manifest")
    if not isinstance(manifest, dict) or not manifest:
        out.append(check("manifest is non-null dict", False))
        return out

    # Runner link flags — substring matches
    runner_flags = manifest.get("runner_link_flags") or []
    if not isinstance(runner_flags, list):
        runner_flags = []

    for sub in expected.get("flag_substrings", []):
        out.append(check(
            f"runner_link_flags contains substring {sub!r}",
            _flag_contains_substring(runner_flags, sub),
            f"got {runner_flags}",
        ))

    for sub in expected.get("forbidden_substrings", []):
        out.append(check(
            f"runner_link_flags does NOT contain substring {sub!r}",
            not _flag_contains_substring(runner_flags, sub),
            f"got {runner_flags} — AI confused libraries",
        ))

    # hot_reload_mode
    expected_modes = expected.get("hot_reload_mode", [])
    actual_mode = manifest.get("hot_reload_mode")
    if expected_modes:
        out.append(check(
            f"hot_reload_mode in {expected_modes}",
            actual_mode in expected_modes,
            f"got {actual_mode!r}",
        ))

    # Confidence
    conf = manifest.get("confidence") or {}
    expected_conf_runner = expected.get("confidence_runner_synthesis", [])
    actual_conf_runner = conf.get("runner_synthesis")
    if expected_conf_runner:
        out.append(check(
            f"confidence.runner_synthesis in {expected_conf_runner}",
            actual_conf_runner in expected_conf_runner,
            f"got {actual_conf_runner!r}",
        ))

    expected_conf_link = expected.get("confidence_link_flags", [])
    if expected_conf_link:
        actual_conf_link = conf.get("link_flags")
        out.append(check(
            f"confidence.link_flags in {expected_conf_link}",
            actual_conf_link in expected_conf_link,
            f"got {actual_conf_link!r}",
        ))

    # Notes keywords
    notes = str(conf.get("notes", "")).lower()
    for kw in expected.get("notes_keywords", []):
        out.append(check(
            f"confidence.notes mentions {kw!r}",
            kw.lower() in notes,
            f"notes: {notes[:150]}",
        ))

    # Sanity: host_runner content present in result
    result_str = body.get("result") or ""
    out.append(check(
        "result JSON contains host_runner block",
        "host_runner" in str(result_str),
    ))

    return out


# ─────────────────────────────────────────────────────────────────────────────
# Runner
# ─────────────────────────────────────────────────────────────────────────────


def run_entry(
    base_url: str, path: Path, expected: Dict[str, Any]
) -> tuple[bool, int, int, float]:
    source = path.read_text(encoding="utf-8")
    print(f"\n\033[1m─── {path.name} ({len(source)} chars) ───\033[0m")

    payload = {
        "code": source,
        "lang": "cpp",
        "verify": True,
        "auto_repair": True,
    }
    status, body, elapsed = post_json(
        f"{base_url}/refactor/split/verified",
        payload,
        timeout_s=TIMEOUT_SEC,
    )
    print(f"  HTTP {status}  elapsed {elapsed:.1f}s")

    # Print 422 body details for observability. When an entry that
    # expected a 200 hits a 422, we need to see the rejection reason
    # to know whether the test or the prompt is at fault.
    expect_rejection = expected.get("expect_rejection", False)
    if status == 422 and not expect_rejection:
        # Unexpected rejection — dump the detail so the failure mode is
        # visible without re-running with curl.
        if isinstance(body, dict):
            detail = body.get("detail", str(body))
        else:
            detail = str(body)
        # Truncate aggressively — rejection messages can be paragraph-long
        detail_short = str(detail)[:500]
        print(f"  \033[33m[422 rejection reason]\033[0m {detail_short}")

    # For expect_rejection entries, 422 is a PASS on the transport level
    # but we still validate the body to confirm the rejection reason.
    if status not in (200, 422):
        print(f"  \033[31mAPI error\033[0m: {str(body)[:400]}")
        return False, 0, 0, elapsed

    results = validate_corpus_entry(path.name, body, expected)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    all_ok = passed == total
    return all_ok, passed, total, elapsed


def main():
    parser = argparse.ArgumentParser(
        description="Phase 7 universal split corpus — live test runner"
    )
    parser.add_argument("--url", default=DEFAULT_BASE_URL)
    parser.add_argument("--only", default=None, help="run only the named file")
    args = parser.parse_args()

    base_url = args.url.rstrip("/")
    expected = load_expected()
    files = list_corpus_files()
    if args.only:
        files = [p for p in files if p.name == args.only]
        if not files:
            print(f"No corpus file matches --only={args.only!r}")
            sys.exit(1)

    print(f"\033[1mPhase 7 corpus — {len(files)} projects\033[0m")
    print(f"  Base URL:  {base_url}")
    print(f"  Expected:  {EXPECTED_PATH}")
    print()

    # Reachability check
    print("─── Reachability check ───")
    try:
        req = urllib.request.Request(f"{base_url}/", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            print(f"  \033[32mOK\033[0m — ai-engine responding ({resp.status})")
    except Exception as e:
        print(f"  \033[31mFAIL\033[0m — can't reach {base_url}")
        print(f"  Error: {type(e).__name__}: {e}")
        sys.exit(1)

    summary: List[tuple[str, bool, int, int, float]] = []
    for path in files:
        exp = expected.get(path.name)
        if exp is None:
            print(f"\n\033[33m[SKIP]\033[0m {path.name} — no entry in expected.json")
            continue
        all_ok, passed, total, elapsed = run_entry(base_url, path, exp)
        summary.append((path.name, all_ok, passed, total, elapsed))

    print()
    print("\033[1m" + "═" * 70 + "\033[0m")
    print("\033[1mPhase 7 CORPUS TEST SUMMARY\033[0m")
    print("\033[1m" + "═" * 70 + "\033[0m")

    total_passed = 0
    for name, all_ok, passed, total, elapsed in summary:
        tag = "\033[32mPASS\033[0m" if all_ok else "\033[31mFAIL\033[0m"
        print(f"  {tag}  {name:<40} {passed}/{total} ({elapsed:.1f}s)")
        if all_ok:
            total_passed += 1

    print()
    print(f"  Total: {total_passed}/{len(summary)} projects passed")

    if total_passed == len(summary) and summary:
        print("  \033[32m\033[1mVERDICT: PASS\033[0m — universal split corpus is green.")
        sys.exit(0)
    elif total_passed == 0 or not summary:
        print("  \033[31m\033[1mVERDICT: FAIL\033[0m — zero projects passed.")
        sys.exit(2)
    else:
        print(f"  \033[33m\033[1mVERDICT: PARTIAL\033[0m — {total_passed}/{len(summary)}")
        sys.exit(1)


# pytest wrapper for CI integration
def test_corpus_all():
    """pytest-compatible wrapper. Requires ai-engine running at
    $AI_ENGINE_URL (default http://localhost:8000).
    """
    base_url = os.environ.get("AI_ENGINE_URL", DEFAULT_BASE_URL).rstrip("/")
    expected = load_expected()
    files = list_corpus_files()
    failures = []
    for path in files:
        exp = expected.get(path.name)
        if exp is None:
            continue
        all_ok, passed, total, _ = run_entry(base_url, path, exp)
        if not all_ok:
            failures.append(f"{path.name}: {passed}/{total}")
    if failures:
        raise AssertionError("Corpus failures:\n  " + "\n  ".join(failures))


if __name__ == "__main__":
    main()
