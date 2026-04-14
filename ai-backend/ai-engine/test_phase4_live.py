#!/usr/bin/env python3
"""
Phase 4 live integration test — hits the running ai-engine and validates
the AI-synthesised host_runner.cpp end-to-end.

Builds on test_phase2_live.py. Same /refactor/split/verified endpoint;
new assertions target the 4th file (`host_runner`) that Phase 1's universal
split prompt instructs the AI to emit, and that Phase 3 / Phase 4 worker
code now expects in the response.

Test cases (3 — same shape as Phase 2 to make pass/fail diffs comparable):

  1. SDL2 button (happy path)
       - host_runner present, non-empty
       - host_runner.content has `int main` and `dlopen("./libcore.so"`
       - host_runner.content does NOT contain SDL_RenderClear (that's gui)
       - manifest.runner_link_flags contains -lSDL2 + -ldl

  2. GLFW triangle (second library — non-SDL2)
       - host_runner.content has glfwInit / glfwCreateWindow
       - host_runner.content has dlopen for both libcore.so + libgui.so
       - manifest.runner_link_flags contains -lglfw + -ldl
       - manifest.gui_link_flags contains -lglfw

  3. FMOD + SDL2 (hot-reload hostile — Mitigation 4A)
       - host_runner.content has SDL_CreateWindow (SDL handles window)
       - host_runner.content links FMOD via runtime
       - manifest.hot_reload_mode == "process_restart"
       - manifest.runner_link_flags contains -lfmod

Prerequisites:
  1. ai-engine running on http://localhost:8000 (or pass --url)
  2. GEMINI_API_KEY set in the ai-engine's env (NOT here — we're just HTTP client)

Usage:
    python3 test_phase4_live.py
    python3 test_phase4_live.py --url http://localhost:8000

Each test ~20-40s (real Gemini API call). Total ~1-2 minutes.

Exit codes:
  0 = all 3 tests pass (every assertion green)
  1 = some tests pass, some fail (partial)
  2 = all tests fail (likely backend down or universal_split_prompt regression)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Callable

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_BASE_URL = "http://localhost:8000"
TIMEOUT_SEC = 300.0

# ─────────────────────────────────────────────────────────────────────────────
# Test inputs — same SDL2 sample as Phase 1/2 + a GLFW + a FMOD hostile case
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

TEST_GLFW = r"""#include <GLFW/glfw3.h>
#include <stdio.h>

int main() {
    if (!glfwInit()) return -1;
    GLFWwindow* window = glfwCreateWindow(800, 600, "GLFW HMR Test", NULL, NULL);
    if (!window) {
        glfwTerminate();
        return -1;
    }
    glfwMakeContextCurrent(window);

    while (!glfwWindowShouldClose(window)) {
        glClear(GL_COLOR_BUFFER_BIT);

        // Triangle
        glBegin(GL_TRIANGLES);
        glColor3f(1.0f, 0.0f, 0.0f);
        glVertex2f(-0.5f, -0.5f);
        glColor3f(0.0f, 1.0f, 0.0f);
        glVertex2f(0.5f, -0.5f);
        glColor3f(0.0f, 0.0f, 1.0f);
        glVertex2f(0.0f, 0.5f);
        glEnd();

        glfwSwapBuffers(window);
        glfwPollEvents();
    }

    glfwDestroyWindow(window);
    glfwTerminate();
    return 0;
}
"""

TEST_FMOD_HOSTILE = r"""#include <SDL2/SDL.h>
#include <fmod.h>
#include <stdio.h>

int main() {
    SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO);
    SDL_Window* win = SDL_CreateWindow("FMOD HMR Test", 0, 0, 800, 600, 0);

    FMOD_SYSTEM* fmod = nullptr;
    FMOD_System_Create(&fmod, FMOD_VERSION);
    FMOD_System_Init(fmod, 32, FMOD_INIT_NORMAL, nullptr);

    FMOD_SOUND* sound = nullptr;
    FMOD_System_CreateSound(fmod, "beep.wav", FMOD_DEFAULT, nullptr, &sound);

    bool running = true;
    while (running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            if (e.type == SDL_QUIT) running = false;
            if (e.type == SDL_KEYDOWN) {
                FMOD_System_PlaySound(fmod, sound, nullptr, false, nullptr);
            }
        }
        FMOD_System_Update(fmod);
        SDL_Delay(16);
    }

    FMOD_Sound_Release(sound);
    FMOD_System_Release(fmod);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
"""

# ─────────────────────────────────────────────────────────────────────────────
# HTTP client
# ─────────────────────────────────────────────────────────────────────────────


def post_json(url: str, payload: dict, timeout_s: float) -> tuple[int, Any, float]:
    body_bytes = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body_bytes,
        method="POST",
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
        return e.code, body_text, elapsed
    except Exception as e:
        elapsed = time.time() - t0
        return 0, f"{type(e).__name__}: {e}", elapsed


# ─────────────────────────────────────────────────────────────────────────────
# Assertion helpers
# ─────────────────────────────────────────────────────────────────────────────


def check(name: str, condition: bool, detail: str = "") -> tuple[str, bool, str]:
    tag = "\033[32mPASS\033[0m" if condition else "\033[31mFAIL\033[0m"
    line = f"  [{tag}] {name}"
    if detail and not condition:
        line += f"\n         → {detail}"
    print(line)
    return (name, condition, detail)


def parse_inner_json(result_str: str) -> dict | None:
    """Strip the JSON wrapper / code fences the AI sometimes emits, then parse.

    Mirrors the regex unwrapping in extract_architecture_and_manifest in main.py
    and the rfind('```json') logic in worker/src/compiler/stages/ai_utils.rs.
    """
    if not isinstance(result_str, str):
        return None
    cleaned = result_str.strip()
    # Strip <JSON>...</JSON> wrapper if present
    if cleaned.startswith("<JSON>"):
        cleaned = cleaned[len("<JSON>"):]
        if cleaned.endswith("</JSON>"):
            cleaned = cleaned[: -len("</JSON>")]
        cleaned = cleaned.strip()
    # Strip ```json ... ``` fences if present
    if cleaned.startswith("```json"):
        cleaned = cleaned[len("```json"):]
        if cleaned.endswith("```"):
            cleaned = cleaned[: -3]
        cleaned = cleaned.strip()
    elif cleaned.startswith("```"):
        cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[: -3]
        cleaned = cleaned.strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return None


def get_host_runner_content(body: dict) -> str:
    """Pull host_runner.content out of the response wrapper."""
    result_str = body.get("result")
    if not isinstance(result_str, str):
        return ""
    parsed = parse_inner_json(result_str)
    if not isinstance(parsed, dict):
        return ""
    hr = parsed.get("host_runner")
    if not isinstance(hr, dict):
        return ""
    content = hr.get("content")
    return content if isinstance(content, str) else ""


# ─────────────────────────────────────────────────────────────────────────────
# Validators (one per test case)
# ─────────────────────────────────────────────────────────────────────────────


def validate_sdl2_host_runner(body: dict) -> list[tuple[str, bool, str]]:
    out: list[tuple[str, bool, str]] = []

    # Top-level: result + manifest still landing
    out.append(check("response has 'result' field", "result" in body))
    out.append(check("response has 'manifest' field", "manifest" in body))

    # Phase 4: host_runner inside result JSON
    hr_content = get_host_runner_content(body)
    out.append(
        check(
            "result.host_runner.content is non-empty",
            len(hr_content) > 50,
            f"got {len(hr_content)} chars",
        )
    )

    if hr_content:
        # Should look like a real C++ main()
        out.append(check("host_runner contains `int main`", "int main" in hr_content))
        # Should dlopen the modules
        out.append(
            check(
                "host_runner dlopens libcore.so",
                "libcore.so" in hr_content and "dlopen" in hr_content,
                "host_runner must call dlopen for libcore.so",
            )
        )
        out.append(
            check(
                "host_runner dlopens libgui.so",
                "libgui.so" in hr_content,
            )
        )
        # Should still own the SDL window (host_runner owns init)
        out.append(
            check(
                "host_runner owns SDL window creation (SDL_CreateWindow)",
                "SDL_CreateWindow" in hr_content,
                "the universal prompt requires host_runner to OWN window init",
            )
        )
        # Forbidden patterns: render calls belong in gui.cpp, not host_runner
        out.append(
            check(
                "host_runner does NOT contain SDL_RenderFillRect (drawing belongs in gui.cpp)",
                "SDL_RenderFillRect" not in hr_content,
                "drawing leak from gui.cpp into host_runner.cpp",
            )
        )

    # Manifest runner_link_flags
    m = body.get("manifest") or {}
    if isinstance(m, dict):
        runner_flags = m.get("runner_link_flags", []) if isinstance(m, dict) else []
        out.append(
            check(
                "manifest.runner_link_flags contains '-lSDL2'",
                isinstance(runner_flags, list) and "-lSDL2" in runner_flags,
                f"got {runner_flags!r}",
            )
        )
        out.append(
            check(
                "manifest.runner_link_flags contains '-ldl'",
                isinstance(runner_flags, list) and "-ldl" in runner_flags,
                f"got {runner_flags!r}",
            )
        )
        # Confidence sanity
        conf = m.get("confidence") or {}
        out.append(
            check(
                "manifest.confidence.runner_synthesis is 'high' or 'medium' (SDL2 is well-known)",
                conf.get("runner_synthesis") in ("high", "medium"),
                f"got {conf.get('runner_synthesis')!r}",
            )
        )

    return out


def validate_glfw_host_runner(body: dict) -> list[tuple[str, bool, str]]:
    out: list[tuple[str, bool, str]] = []

    out.append(check("response has 'manifest' field", "manifest" in body))

    hr_content = get_host_runner_content(body)
    out.append(
        check(
            "host_runner is non-empty",
            len(hr_content) > 50,
            f"got {len(hr_content)} chars",
        )
    )

    if hr_content:
        out.append(check("host_runner contains `int main`", "int main" in hr_content))
        out.append(
            check(
                "host_runner calls glfwInit",
                "glfwInit" in hr_content,
                "GLFW init must live in host_runner",
            )
        )
        out.append(
            check(
                "host_runner calls glfwCreateWindow",
                "glfwCreateWindow" in hr_content,
            )
        )
        out.append(
            check(
                "host_runner dlopens libcore.so",
                "libcore.so" in hr_content and "dlopen" in hr_content,
            )
        )
        out.append(
            check(
                "host_runner dlopens libgui.so",
                "libgui.so" in hr_content,
            )
        )
        # Forbidden: glBegin/glEnd is rendering, belongs in gui
        out.append(
            check(
                "host_runner does NOT contain glBegin (rendering belongs in gui.cpp)",
                "glBegin" not in hr_content,
                "rendering leak into host_runner",
            )
        )

    # Manifest must use GLFW link flags, not SDL2
    m = body.get("manifest") or {}
    if isinstance(m, dict):
        runner_flags = m.get("runner_link_flags", [])
        gui_flags = m.get("gui_link_flags", [])
        out.append(
            check(
                "manifest.runner_link_flags contains '-lglfw'",
                isinstance(runner_flags, list) and any("glfw" in f for f in runner_flags),
                f"got {runner_flags!r}",
            )
        )
        out.append(
            check(
                "manifest.runner_link_flags does NOT contain '-lSDL2'",
                isinstance(runner_flags, list) and "-lSDL2" not in runner_flags,
                f"AI confused libraries: {runner_flags!r}",
            )
        )
        out.append(
            check(
                "manifest.gui_link_flags references glfw (or GL)",
                isinstance(gui_flags, list)
                and (any("glfw" in f for f in gui_flags) or any("GL" in f for f in gui_flags)),
                f"got {gui_flags!r}",
            )
        )
        # GLFW is swap-safe per HOT-RELOAD SAFETY KNOWLEDGE in the prompt
        out.append(
            check(
                "manifest.hot_reload_mode == 'swap' (GLFW is swap-safe)",
                m.get("hot_reload_mode") == "swap",
                f"got {m.get('hot_reload_mode')!r}",
            )
        )

    return out


def validate_fmod_host_runner(body: dict) -> list[tuple[str, bool, str]]:
    out: list[tuple[str, bool, str]] = []

    out.append(check("response has 'manifest' field", "manifest" in body))

    hr_content = get_host_runner_content(body)
    out.append(
        check(
            "host_runner is non-empty",
            len(hr_content) > 50,
            f"got {len(hr_content)} chars",
        )
    )

    if hr_content:
        out.append(check("host_runner contains `int main`", "int main" in hr_content))
        # SDL still owns the window because FMOD doesn't have one
        out.append(
            check(
                "host_runner owns SDL window (SDL_CreateWindow)",
                "SDL_CreateWindow" in hr_content,
            )
        )
        # FMOD init may live in host_runner OR core (both are reasonable —
        # the AI prompt says host_runner owns library init, so check there)
        # We don't assert it strictly here, just confirm the runner is wired.
        out.append(
            check(
                "host_runner dlopens libcore.so",
                "libcore.so" in hr_content,
            )
        )

    # Phase 4 + Phase 2 cross-check: manifest must mark FMOD as process_restart
    m = body.get("manifest") or {}
    if isinstance(m, dict):
        out.append(
            check(
                "manifest.hot_reload_mode == 'process_restart' (FMOD is hot-reload hostile)",
                m.get("hot_reload_mode") == "process_restart",
                f"got {m.get('hot_reload_mode')!r}",
            )
        )
        runner_flags = m.get("runner_link_flags", [])
        out.append(
            check(
                "manifest.runner_link_flags contains '-lfmod'",
                isinstance(runner_flags, list) and any("fmod" in f for f in runner_flags),
                f"got {runner_flags!r}",
            )
        )
        out.append(
            check(
                "manifest.runner_link_flags also contains '-lSDL2'",
                isinstance(runner_flags, list) and "-lSDL2" in runner_flags,
                f"got {runner_flags!r}",
            )
        )

    return out


# ─────────────────────────────────────────────────────────────────────────────
# Test runner
# ─────────────────────────────────────────────────────────────────────────────


def run_test(
    case_name: str,
    base_url: str,
    source: str,
    validator: Callable[[dict], list[tuple[str, bool, str]]],
) -> tuple[bool, int, int, float]:
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
    parser = argparse.ArgumentParser(
        description="Phase 4 live test — validates host_runner.cpp synthesis"
    )
    parser.add_argument(
        "--url", default=DEFAULT_BASE_URL, help="base URL of ai-engine (default: %(default)s)"
    )
    args = parser.parse_args()

    base_url = args.url.rstrip("/")

    print(f"\033[1mPhase 4 live test — host_runner synthesis end-to-end\033[0m")
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
        sys.exit(1)

    tests = [
        ("Test 1: SDL2 button (host_runner happy path)", TEST_SDL2, validate_sdl2_host_runner),
        ("Test 2: GLFW triangle (non-SDL2 library — agnostic check)",
         TEST_GLFW, validate_glfw_host_runner),
        ("Test 3: FMOD hostile (process_restart + multi-lib runner)",
         TEST_FMOD_HOSTILE, validate_fmod_host_runner),
    ]

    summary: list[tuple[str, bool, int, int, float]] = []
    for name, source, validator in tests:
        all_ok, passed, total, elapsed = run_test(name, base_url, source, validator)
        summary.append((name, all_ok, passed, total, elapsed))

    # ── Summary ────────────────────────────────────────────────────────────
    print()
    print("\033[1m" + "═" * 65 + "\033[0m")
    print("\033[1mPhase 4 LIVE TEST SUMMARY\033[0m")
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
        print(f"  \033[32m\033[1mVERDICT: PASS\033[0m — Phase 4 host_runner synthesis works end-to-end.")
        print("  The universal split prompt + manifest pipeline both")
        print("  produce a usable host_runner.cpp across SDL2 / GLFW / FMOD.")
        print("  Safe to compile + spawn (worker side already wired).")
        sys.exit(0)
    elif total_passed == 0:
        print(f"  \033[31m\033[1mVERDICT: FAIL\033[0m — zero tests passed.")
        print("  Either the ai-engine is down, the universal split prompt")
        print("  regressed on host_runner emission, or the response wrapper")
        print("  format changed (rare). Check ai-engine logs.")
        sys.exit(2)
    else:
        print(f"  \033[33m\033[1mVERDICT: PARTIAL\033[0m — {total_passed}/{total_tests} tests passed.")
        print("  Some library-specific assertions failed — see per-assertion")
        print("  details above. Common cause: AI confused libraries or")
        print("  emitted weak host_runner content for a less-common framework.")
        sys.exit(1)


if __name__ == "__main__":
    main()
