#!/usr/bin/env python3
"""
Phase 2 live integration test — hits the running ai-engine.

Exercises the full /refactor/split/verified handler end-to-end:
  Python main.py -> universal split prompt -> Gemini API ->
  extract_architecture_and_manifest -> pydantic validate ->
  returns {result, architecture, manifest}

Runs 3 test cases that cover the happy path + two mitigation triads:
  1. SDL2 button              — happy path, high confidence, swap mode
  4. wxWidgets IMPLEMENT_APP  — Mitigation 2A (low confidence detection)
  5. FMOD + SDL2              — Mitigation 4A (hot_reload_mode=process_restart)

Prerequisites:
  1. ai-engine running:
       cd ai-backend/ai-engine
       export GEMINI_API_KEY=<your-key>
       python3 main.py     # or: uvicorn main:app --host 0.0.0.0 --port 8000
  2. GEMINI_API_KEY set in the ai-engine's env (not here)

Usage:
    python3 test_phase2_live.py
    python3 test_phase2_live.py --url http://localhost:8000

Each case ~20-40s (real Gemini API call). Total ~1-2 minutes.

This does NOT need GEMINI_API_KEY set in THIS shell — the ai-engine
already has it. We're just the HTTP client.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from typing import Any

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_BASE_URL = "http://localhost:8000"
TIMEOUT_SEC = 300.0

# ─────────────────────────────────────────────────────────────────────────────
# Test inputs (three most informative cases from the 5 Phase 1 tests)
# ─────────────────────────────────────────────────────────────────────────────

TEST_SDL2 = r"""#include <SDL2/SDL.h>
#include <stdio.h>

int main() {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* win = SDL_CreateWindow("HMR Test", 0, 0, 800, 600, 0);
    SDL_Renderer* r = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);

    bool running = true;
    int frame = 0;

    while (running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            if (e.type == SDL_QUIT) running = false;
        }

        frame++;

        SDL_SetRenderDrawColor(r, 20, 20, 40, 255);
        SDL_RenderClear(r);

        SDL_Rect btn = {50, 50, 200, 60};
        SDL_SetRenderDrawColor(r, 60, 120, 220, 255);
        SDL_RenderFillRect(r, &btn);

        SDL_RenderPresent(r);
        SDL_Delay(16);
    }

    SDL_DestroyRenderer(r);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
"""

TEST_MACRO_WX = r"""#include <wx/wx.h>

class MyApp : public wxApp {
public:
    virtual bool OnInit() override {
        wxFrame* frame = new wxFrame(nullptr, wxID_ANY, "Hello wxWidgets",
                                     wxDefaultPosition, wxSize(800, 600));
        frame->SetBackgroundColour(wxColour(30, 30, 50));

        wxButton* btn = new wxButton(frame, wxID_ANY, "Click me",
                                     wxPoint(50, 50), wxSize(200, 60));
        btn->SetBackgroundColour(wxColour(60, 120, 220));

        frame->Show(true);
        return true;
    }
};

IMPLEMENT_APP(MyApp)
"""

TEST_FMOD_HOSTILE = r"""#include <SDL2/SDL.h>
#include <fmod.h>
#include <stdio.h>

int main() {
    SDL_Init(SDL_INIT_VIDEO);

    FMOD_SYSTEM* fmod = NULL;
    FMOD_System_Create(&fmod, FMOD_VERSION);
    FMOD_System_Init(fmod, 32, FMOD_INIT_NORMAL, NULL);

    FMOD_SOUND* sound = NULL;
    FMOD_System_CreateSound(fmod, "bgm.ogg", FMOD_DEFAULT, NULL, &sound);
    FMOD_System_PlaySound(fmod, sound, NULL, 0, NULL);

    SDL_Window* win = SDL_CreateWindow("HMR + FMOD", 0, 0, 800, 600, 0);
    SDL_Renderer* r = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);

    bool running = true;
    while (running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) if (e.type == SDL_QUIT) running = false;

        FMOD_System_Update(fmod);

        SDL_SetRenderDrawColor(r, 20, 20, 40, 255);
        SDL_RenderClear(r);
        SDL_RenderPresent(r);
    }

    FMOD_Sound_Release(sound);
    FMOD_System_Release(fmod);
    SDL_DestroyRenderer(r);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
"""

# ─────────────────────────────────────────────────────────────────────────────
# HTTP client
# ─────────────────────────────────────────────────────────────────────────────


def post_json(url: str, payload: dict, timeout_s: float = TIMEOUT_SEC) -> tuple[int, Any, float]:
    """POST JSON to the given URL, return (status, body_or_text, elapsed_s)."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            elapsed = time.time() - t0
            try:
                return resp.status, json.loads(raw), elapsed
            except json.JSONDecodeError:
                return resp.status, raw, elapsed
    except urllib.error.HTTPError as e:
        elapsed = time.time() - t0
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        try:
            return e.code, json.loads(body), elapsed
        except Exception:
            return e.code, body, elapsed
    except urllib.error.URLError as e:
        elapsed = time.time() - t0
        return -1, f"URLError: {e.reason}", elapsed
    except Exception as e:
        elapsed = time.time() - t0
        return -2, f"{type(e).__name__}: {e}", elapsed


# ─────────────────────────────────────────────────────────────────────────────
# Validators — per-test assertions
# ─────────────────────────────────────────────────────────────────────────────


def check(name: str, condition: bool, detail: str = "") -> tuple[str, bool, str]:
    mark = "\033[32mPASS\033[0m" if condition else "\033[31mFAIL\033[0m"
    line = f"    [{mark}] {name}"
    if detail and not condition:
        line += f"  — {detail}"
    print(line)
    return (name, condition, detail)


def validate_happy_sdl2(body: dict) -> list[tuple[str, bool, str]]:
    out: list[tuple[str, bool, str]] = []

    # Top-level response shape
    out.append(check("response has 'result' field", "result" in body))
    out.append(check("response has 'architecture' field", "architecture" in body))
    out.append(check("response has 'manifest' field (Phase 2 NEW)", "manifest" in body))
    out.append(check("response 'verified' is True", body.get("verified") is True))

    # Manifest shape
    m = body.get("manifest") or {}
    out.append(check("manifest is non-null dict", isinstance(m, dict) and len(m) > 0,
                     f"got: {type(m).__name__}, content: {str(m)[:100]}"))

    if isinstance(m, dict) and m:
        out.append(check("manifest.compiler == 'g++'",
                         m.get("compiler") == "g++",
                         f"got {m.get('compiler')!r}"))
        out.append(check("manifest.std == 'c++17' (or similar)",
                         isinstance(m.get("std"), str) and m["std"].startswith("c++")))
        out.append(check("manifest.hot_reload_mode == 'swap'",
                         m.get("hot_reload_mode") == "swap",
                         f"got {m.get('hot_reload_mode')!r}"))

        gui_flags = m.get("gui_link_flags", [])
        out.append(check("manifest.gui_link_flags contains '-lSDL2'",
                         isinstance(gui_flags, list) and "-lSDL2" in gui_flags,
                         f"got {gui_flags!r}"))

        runner_flags = m.get("runner_link_flags", [])
        out.append(check("manifest.runner_link_flags contains '-lSDL2'",
                         isinstance(runner_flags, list) and "-lSDL2" in runner_flags,
                         f"got {runner_flags!r}"))

        conf = m.get("confidence") or {}
        out.append(check("manifest.confidence.overall == 'high'",
                         conf.get("overall") == "high",
                         f"got {conf.get('overall')!r}"))
        out.append(check("manifest.confidence.runner_synthesis == 'high'",
                         conf.get("runner_synthesis") == "high",
                         f"got {conf.get('runner_synthesis')!r}"))

    # Architecture cache sanity (free-form markdown, but should be non-empty
    # and mention SDL2)
    arch = body.get("architecture") or ""
    out.append(check("architecture is non-empty markdown (>100 chars)",
                     isinstance(arch, str) and len(arch) > 100,
                     f"got {len(arch) if isinstance(arch, str) else 0} chars"))
    out.append(check("architecture does NOT contain <synthi_build_manifest> "
                     "(manifest block stripped out)",
                     "<synthi_build_manifest>" not in arch))

    # Result sanity (raw JSON string with 4 files)
    result_str = body.get("result") or ""
    out.append(check("result contains all 4 file keys",
                     all(k in str(result_str) for k in ["shared", "core", "gui", "host_runner"]),
                     "some keys missing from result"))

    return out


def validate_macro_wxwidgets(body: dict) -> list[tuple[str, bool, str]]:
    """wxWidgets IMPLEMENT_APP — AI should detect macro and set low confidence."""
    out: list[tuple[str, bool, str]] = []

    out.append(check("response has 'manifest' field", "manifest" in body))
    m = body.get("manifest") or {}
    out.append(check("manifest is non-null dict", isinstance(m, dict) and len(m) > 0))

    if isinstance(m, dict) and m:
        conf = m.get("confidence") or {}
        runner_synth = conf.get("runner_synthesis")
        out.append(check(
            'confidence.runner_synthesis in {"low","medium"} '
            "(IMPLEMENT_APP hides main)",
            runner_synth in ("low", "medium"),
            f"got {runner_synth!r} — AI should have flagged the macro",
        ))

        notes = str(conf.get("notes", "")).lower()
        out.append(check(
            'confidence.notes mentions macro / implement_app / wxapp / wxwidgets',
            any(kw in notes for kw in ("macro", "implement_app", "wxapp", "wxwidgets")),
            f"notes: {notes[:150]}",
        ))

        overall = conf.get("overall")
        out.append(check(
            'confidence.overall in {"low","medium"}',
            overall in ("low", "medium"),
            f"got {overall!r}",
        ))

    return out


def validate_fmod_hostile(body: dict) -> list[tuple[str, bool, str]]:
    """FMOD on top of SDL2 — AI should detect hostile library, set process_restart."""
    out: list[tuple[str, bool, str]] = []

    out.append(check("response has 'manifest' field", "manifest" in body))
    m = body.get("manifest") or {}
    out.append(check("manifest is non-null dict", isinstance(m, dict) and len(m) > 0))

    if isinstance(m, dict) and m:
        out.append(check(
            'hot_reload_mode == "process_restart" (FMOD is hostile)',
            m.get("hot_reload_mode") == "process_restart",
            f"got {m.get('hot_reload_mode')!r} — AI should have flagged FMOD",
        ))

        gui_flags = m.get("gui_link_flags", []) or []
        runner_flags = m.get("runner_link_flags", []) or []
        all_flags = (
            (" ".join(str(f) for f in gui_flags))
            + " "
            + (" ".join(str(f) for f in runner_flags))
        )
        out.append(check("-lfmod in gui_link_flags or runner_link_flags",
                         "-lfmod" in all_flags,
                         f"flags: gui={gui_flags!r} runner={runner_flags!r}"))
        out.append(check("-lSDL2 in gui_link_flags (FMOD layered on SDL2)",
                         "-lSDL2" in all_flags))

        conf = m.get("confidence") or {}
        notes = str(conf.get("notes", "")).lower()
        out.append(check(
            "confidence.notes mentions FMOD / hostile / process_restart / global",
            any(kw in notes for kw in
                ("fmod", "hostile", "process_restart", "process restart", "global")),
            f"notes: {notes[:150]}",
        ))

    return out


# ─────────────────────────────────────────────────────────────────────────────
# Test orchestrator
# ─────────────────────────────────────────────────────────────────────────────


def run_test(
    case_name: str,
    base_url: str,
    source: str,
    validator,
) -> tuple[bool, int, int, float]:
    """Returns (all_passed, pass_count, total, elapsed_s)."""
    print(f"\n\033[1m─── {case_name} ───\033[0m")
    print(f"  Source: {len(source)} chars")
    print(f"  POST {base_url}/refactor/split/verified")

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

    if status != 200:
        print(f"  \033[31mAPI error\033[0m: {str(body)[:400]}")
        return False, 0, 0, elapsed

    if not isinstance(body, dict):
        print(f"  \033[31mResponse is not JSON dict\033[0m: {str(body)[:200]}")
        return False, 0, 0, elapsed

    results = validator(body)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    all_ok = passed == total
    return all_ok, passed, total, elapsed


def main():
    parser = argparse.ArgumentParser(description="Phase 2 live test — ai-engine /refactor/split/verified")
    parser.add_argument("--url", default=DEFAULT_BASE_URL, help="base URL of ai-engine (default: %(default)s)")
    args = parser.parse_args()

    base_url = args.url.rstrip("/")

    print(f"\033[1mPhase 2 live test — ai-engine /refactor/split/verified\033[0m")
    print(f"  Base URL:  {base_url}")
    print(f"  Timeout:   {TIMEOUT_SEC}s per request")
    print()

    # Sanity: can we reach the server at all?
    print("─── Reachability check ───")
    try:
        req = urllib.request.Request(f"{base_url}/", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            print(f"  \033[32mOK\033[0m — ai-engine responding ({resp.status})")
    except Exception as e:
        print(f"  \033[31mFAIL\033[0m — can't reach {base_url}")
        print(f"  Error: {type(e).__name__}: {e}")
        print()
        print("  Start the ai-engine first:")
        print("    cd ai-backend/ai-engine")
        print("    export GEMINI_API_KEY=<your-key>")
        print("    python3 main.py")
        print("  (or: uvicorn main:app --host 0.0.0.0 --port 8000)")
        sys.exit(1)

    # Run the 3 tests
    tests = [
        ("Test 1: SDL2 button (happy path)", TEST_SDL2, validate_happy_sdl2),
        ("Test 2: wxWidgets IMPLEMENT_APP (Mitigation 2A — low confidence)",
         TEST_MACRO_WX, validate_macro_wxwidgets),
        ("Test 3: FMOD hostile (Mitigation 4A — process_restart)",
         TEST_FMOD_HOSTILE, validate_fmod_hostile),
    ]

    summary: list[tuple[str, bool, int, int, float]] = []
    for name, source, validator in tests:
        all_ok, passed, total, elapsed = run_test(name, base_url, source, validator)
        summary.append((name, all_ok, passed, total, elapsed))

    # ── Summary ────────────────────────────────────────────────────────────
    print()
    print("\033[1m" + "═" * 65 + "\033[0m")
    print("\033[1mPhase 2 LIVE TEST SUMMARY\033[0m")
    print("\033[1m" + "═" * 65 + "\033[0m")

    total_passed = 0
    total_tests = len(summary)
    for name, all_ok, passed, total, elapsed in summary:
        tag = "\033[32mPASS\033[0m" if all_ok else "\033[31mFAIL\033[0m"
        print(f"  {tag}  {name}")
        print(f"         {passed}/{total} assertions  |  {elapsed:.1f}s")
        if all_ok:
            total_passed += 1

    print()
    print(f"  Tests passed: {total_passed}/{total_tests}")

    if total_passed == total_tests:
        print(f"  \033[32m\033[1mVERDICT: PASS\033[0m — Phase 2 wire-up works end-to-end.")
        print("  The /refactor/split/verified endpoint produces the new")
        print("  `manifest` field. Safe to proceed to Phase 3 (Rust worker).")
        sys.exit(0)
    elif total_passed == 0:
        print(f"  \033[31m\033[1mVERDICT: FAIL\033[0m — zero tests passed.")
        print("  Something is broken in the handler wire-up.")
        print("  Check ai-engine logs for errors during the requests.")
        sys.exit(2)
    else:
        print(f"  \033[33m\033[1mVERDICT: PARTIAL\033[0m — {total_passed}/{total_tests} tests passed.")
        print("  Some mitigation-specific assertions failed.")
        print("  See per-assertion details above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
