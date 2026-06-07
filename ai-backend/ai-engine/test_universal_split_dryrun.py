#!/usr/bin/env python3
"""
Phase 1 dry-run: universal split prompt + 5 test inputs covering the four
mitigation triads. Runs on the user's machine because Claude's sandbox is
IP-blocked from generativelanguage.googleapis.com.

Usage:
    export GEMINI_API_KEY=AIzaSy...
    cd ai-backend/ai-engine
    python3 test_universal_split_dryrun.py

Or hardcode API_KEY on line ~30 if you prefer.

Self-contained: only depends on Python 3 stdlib. Does not import from the
ai-engine project so you can run it before any production code changes.

Phase 1 gate (see HMR_AGNOSTIC_ULTRAPLAN.md §7 Phase 1):
  - 5/5 structural parses (JSON block + 4 files + arch cache + build manifest)
  - >= 4/5 mitigation-specific assertions
  - 3+ failures across the 5 tests aborts the AI-synthesized approach
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

API_KEY = os.environ.get("GEMINI_API_KEY", "")
MODEL = os.environ.get("SYNTHI_GEMINI_MODEL", "gemini-3.1-flash-lite")
TIMEOUT_SEC = 300.0
PROMPT_TEMPERATURE = 0.2
PROMPT_MAX_OUTPUT_TOKENS = 16384

if not API_KEY:
    print("ERROR: GEMINI_API_KEY not set.")
    print("  Run:  export GEMINI_API_KEY=<your-key>  and retry")
    print("  Or:   hardcode API_KEY on line 30 of this file")
    sys.exit(1)

URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"{MODEL}:generateContent?key={API_KEY}"
)

# ─────────────────────────────────────────────────────────────────────────────
# The universal split prompt (this is what Phase 1 is testing)
# ─────────────────────────────────────────────────────────────────────────────

UNIVERSAL_SPLIT_PROMPT = r"""
You are a C++ Hot-Module-Reload (HMR) Splitter+Adapter.

You will be given a single-file C++ application. Refactor it into 4 files
that work with a dynamic-linking HMR system. The system is LIBRARY-AGNOSTIC:
it could be SDL2, GLFW, SFML, raylib, a custom in-house engine, or even a
plain console app. Do NOT assume SDL2.

# THE 4 OUTPUT FILES

1. shared.h          - AppState struct + shared types + extern "C" prototypes.
                       Header-only. No executable code except inline accessors.

2. core.cpp          - logic and state mutation. Compiles to libcore.so.
                       NO windowing, NO rendering, NO main(), NO library init.

3. gui.cpp           - rendering and UI. Compiles to libgui.so.
                       Uses window/renderer passed in by host_runner.
                       Does NOT own window creation.
                       Does NOT call present/swap/flush - the runner handles it.
                       NO main(), NO library init.

4. host_runner.cpp   - process entry point. Compiles to a project-specific
                       executable that owns the window, event loop, and
                       present/swap/flush call. dlopen-loads libcore.so +
                       libgui.so, dlsym the lifecycle functions, calls them
                       every frame.

# THE ABI (extern "C", state as void*)

core.so exports:
  extern "C" void core_on_load(void* prev_state);
  extern "C" void core_on_update(void* state_ptr);
  extern "C" void core_on_event(void* state_ptr, void* event_ptr);
  extern "C" void core_on_unload(void* state_ptr);

gui.so exports:
  extern "C" void gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr);
  extern "C" void gui_on_render(void* state_ptr);
  extern "C" void gui_cleanup(void* state_ptr);

All state is passed as void*. Cast inside:
  AppState* state = (AppState*)state_ptr;

# STATE OWNERSHIP

AppState lives in STATIC STORAGE in core.cpp:

  static AppState app_state = {0};

  extern "C" void core_on_load(void* prev_state) {
      // Optionally migrate fields from prev_state into app_state
      // e.g. if (prev_state) { app_state.frame = ((AppState*)prev_state)->frame; }
  }

core_on_load does NOT return the pointer. The host runner takes the address
of app_state via dlsym of a symbol name you choose (e.g. "app_state") OR via
a getter function. Prefer the direct-symbol approach for simplicity:

  // In shared.h: extern "C" AppState app_state;  (forward declaration)
  // In core.cpp: AppState app_state = {0};       (actual definition, NOT static so dlsym can find it)

When core.so reloads, the NEW core.so's storage is fresh. core_on_load(prev_state)
receives the OLD pointer so it can migrate fields if the struct layout changed.

# HOST RUNNER GENERATION

You REWRITE the user's main() into host_runner.cpp. The host runner must:

1. Keep window/event init code VERBATIM from the user's main()
   (preserve title, size, flags, renderer creation)
2. Replace logic/render calls with dlsym-resolved calls to
   core_on_update / gui_on_render
3. Own the present/swap/flush call at the end of each frame
4. dlopen("./libcore.so", RTLD_NOW) and dlopen("./libgui.so", RTLD_NOW) on startup
5. dlsym the lifecycle functions; store function pointers
6. Look up app_state via dlsym (or call a getter); stash the AppState*
7. Call core_on_load(nullptr) and gui_on_load(nullptr, window_ptr, nullptr)
8. Per frame: core_on_update(&app_state), gui_on_render(&app_state), present/swap
9. Per event: core_on_event(&app_state, &event)
10. On exit: gui_cleanup, core_on_unload, dlclose, destroy window

The user's main() is COMPLETELY REMOVED from core.cpp and gui.cpp.
It lives (rewritten) in host_runner.cpp only.

# FORBIDDEN PATTERNS (per module)

core.cpp:
  - NO window creation (SDL_CreateWindow, glfwCreateWindow, etc.)
  - NO rendering calls
  - NO library init (SDL_Init, glfwInit, etc.)
  - NO main()

gui.cpp:
  - NO window creation
  - NO present/swap/flush (SDL_RenderPresent, glfwSwapBuffers, etc.)
  - NO library init
  - NO main()

shared.h:
  - Types and forward declarations only. No function bodies
    except inline accessors.
  - NO main()

host_runner.cpp:
  - Owns EVERYTHING the split modules are forbidden from.

# BUILD HINT SCANNING (read user source before guessing flags)

Before synthesizing link flags, SCAN the user's source for explicit build
hints. If present, copy them VERBATIM into the manifest rather than guessing:

  #pragma comment(lib, "X")          -> add "-lX" to gui_link_flags
  // LINK: -lX -L/path -I/path       -> parse, copy verbatim into gui_link_flags
  // REQUIRES: libx-dev              -> add to system_packages
  // BUILD: g++ main.cpp -lfoo       -> treat as authoritative

User hints ALWAYS override your inference. Copy them VERBATIM.
If a hint is present, set confidence.link_flags = "high" because the user
told you what they need.

# HOT-RELOAD SAFETY KNOWLEDGE

Some libraries hold hidden global/static state that desyncs when their .so
files are swapped mid-run. For these, the system uses process_restart instead
of swap mode. Use this knowledge to set "hot_reload_mode" in the manifest:

SWAP-SAFE (use "swap"):
  SDL2, SDL3, GLFW, raylib, sokol, Dear ImGui, nanovg, stb_*, bgfx, MiniFB,
  pure OpenGL with GLFW context, custom engines with simple state

HOT-RELOAD HOSTILE (use "process_restart"):
  FMOD, FMOD Studio, Wwise, OpenAL-soft, Steam API, wxWidgets, Qt, JUCE,
  any audio library with persistent global mixing state,
  any GUI framework with global event dispatchers

Unknown libraries: use "swap" and let the worker auto-downgrade on crash.

# CONFIDENCE FIELD (required in the build manifest)

confidence.runner_synthesis:
  "high"   - user has a plain int main() with a clear loop, easily isolated
  "medium" - main() has framework boilerplate but you could find the core loop
  "low"    - main() is hidden inside a macro (IMPLEMENT_APP, DECLARE_APPLICATION,
             START_JUCE_APPLICATION, WX_APP, etc.) or behind a framework-specific
             pattern that prevents a clean rewrite

confidence.link_flags:
  "high"   - well-known library OR user provided explicit // LINK: hint
  "medium" - library identified but standard flags vary by distro
  "low"    - couldn't identify library; guessed from header names

confidence.overall: minimum of the two above
confidence.notes: free-form explanation of any low confidences

If confidence.runner_synthesis is "low", the worker will REFUSE to compile
the result and ask the user to provide their own host_runner.cpp via the
"Bring Your Own Runner" mode. This is the correct outcome - better to fail
visibly than silently generate broken code.

# OUTPUT FORMAT (strict)

Respond with EXACTLY two blocks in this order, nothing else:

Block 1: a JSON object wrapped in <JSON>...</JSON> tags containing the 4 files:

<JSON>
{
  "shared":      {"filename": "shared.h",       "content": "<full file content as a JSON string>"},
  "core":        {"filename": "core.cpp",       "content": "<full file content>"},
  "gui":         {"filename": "gui.cpp",        "content": "<full file content>"},
  "host_runner": {"filename": "host_runner.cpp","content": "<full file content>"}
}
</JSON>

Block 2: the architecture cache, with the build manifest nested inside:

<synthi_arch_cache>
# Architecture

## Language & Framework
(one line, e.g. "C++ with SDL2", "C++ with GLFW + OpenGL", "C++ console app")

## Module Contract
- **core.cpp**: (what this module owns)
- **gui.cpp**: (what this module owns)
- **shared.h**: (what this header owns)
- **host_runner.cpp**: (process entry, event loop, dlopen loader)

## State Access Pattern
```cpp
AppState* state = (AppState*)state_ptr;
```

## Lifecycle Functions
### core.cpp
- `core_on_load(void* prev_state)` - ...
- `core_on_update(void* state_ptr)` - ...
- `core_on_event(void* state_ptr, void* event_ptr)` - ...
- `core_on_unload(void* state_ptr)` - ...

### gui.cpp
- `gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)` - ...
- `gui_on_render(void* state_ptr)` - ...
- `gui_cleanup(void* state_ptr)` - ...

## Where User Code Goes
- Rendering code -> gui_on_render
- State updates / logic -> core_on_update
- Event handling -> core_on_event
- New struct fields -> AppState in shared.h
- Window setup / framework init -> host_runner.cpp

## Forbidden Patterns
(library-specific don'ts - e.g., "don't call SDL_RenderPresent, the runner does it")

<synthi_build_manifest>
{
  "compiler": "g++",
  "std": "c++17",
  "common_flags": ["-shared", "-fPIC", "-g", "-fno-omit-frame-pointer",
                   "-fdiagnostics-format=json"],
  "core_link_flags": [],
  "gui_link_flags": ["-lSDL2"],
  "shared_link_flags": [],
  "runner_link_flags": ["-lSDL2", "-ldl"],
  "system_packages": ["libsdl2-dev"],
  "hot_reload_mode": "swap",
  "confidence": {
    "overall": "high",
    "runner_synthesis": "high",
    "link_flags": "high",
    "notes": "Standard SDL2 application with a plain int main() and a clear render loop."
  }
}
</synthi_build_manifest>
</synthi_arch_cache>

# CRITICAL RULES

- Respond with the <JSON>...</JSON> block FIRST, then <synthi_arch_cache>...</synthi_arch_cache>.
- NO prose before, between, or after the two blocks.
- NO markdown headers outside the arch cache.
- The build manifest MUST be valid JSON parseable by Python json.loads.
- All four files must be present in the JSON, even if some are nearly empty.
- Preserve the user's intent: button colors, sizes, frame timing, etc. must
  survive the split unchanged.

# USER SOURCE

```cpp
{USER_CODE}
```
""".strip()


# ─────────────────────────────────────────────────────────────────────────────
# Test inputs — 5 cases covering happy path + four mitigation triads
# ─────────────────────────────────────────────────────────────────────────────

TEST_SDL2_BUTTON = r"""#include <SDL2/SDL.h>
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

TEST_GLFW_TRIANGLE = r"""#include <GLFW/glfw3.h>

int main() {
    if (!glfwInit()) return -1;

    GLFWwindow* window = glfwCreateWindow(800, 600, "HMR GLFW Test", NULL, NULL);
    if (!window) { glfwTerminate(); return -1; }

    glfwMakeContextCurrent(window);

    while (!glfwWindowShouldClose(window)) {
        glfwPollEvents();

        glClearColor(0.1f, 0.1f, 0.2f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);

        glBegin(GL_TRIANGLES);
            glColor3f(1.0f, 0.0f, 0.0f); glVertex2f(-0.5f, -0.5f);
            glColor3f(0.0f, 1.0f, 0.0f); glVertex2f( 0.5f, -0.5f);
            glColor3f(0.0f, 0.0f, 1.0f); glVertex2f( 0.0f,  0.5f);
        glEnd();

        glfwSwapBuffers(window);
    }

    glfwDestroyWindow(window);
    glfwTerminate();
    return 0;
}
"""

# Point 1A — build hint scanning: user has an in-house engine with explicit
# // LINK: / // REQUIRES: hints. The AI has NEVER heard of MyCustomEngine but
# should copy the hints verbatim.
TEST_CUSTOM_ENGINE_WITH_HINT = r"""// LINK: -lMyCustomEngine -L/opt/inhouse/lib
// REQUIRES: libinhouse-dev
// BUILD: g++ main.cpp -lMyCustomEngine -L/opt/inhouse/lib -I/opt/inhouse/include
#include "MyCustomEngine.h"
#include <stdio.h>

int main() {
    MCE_Init();
    MCE_Window* w = MCE_CreateWindow("Engine Test", 800, 600);
    MCE_Renderer* r = MCE_GetRenderer(w);

    bool running = true;
    while (running) {
        MCE_Event e;
        while (MCE_PollEvent(w, &e)) {
            if (e.type == MCE_QUIT) running = false;
        }

        MCE_SetColor(r, 30, 30, 50);
        MCE_Clear(r);

        MCE_DrawRect(r, 100, 100, 200, 150, 0xFFAA33);

        MCE_Present(r);
    }

    MCE_DestroyWindow(w);
    MCE_Shutdown();
    return 0;
}
"""

# Point 2A/C — confidence = low: main() is hidden inside IMPLEMENT_APP macro.
# The AI should set confidence.runner_synthesis to "low" (or "medium" as a
# hedge) and mention the macro in notes. Worker will refuse to compile.
TEST_MACRO_MAIN_WXWIDGETS = r"""#include <wx/wx.h>

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

# Point 4A — hot-reload hostile: FMOD layered on top of SDL2. The AI should
# detect FMOD and set hot_reload_mode to "process_restart" because FMOD
# holds global mixer state that desyncs on .so swap.
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
# Response structure and parsers
# ─────────────────────────────────────────────────────────────────────────────

JSON_RE = re.compile(r"<JSON>\s*\n?(.*?)\n?\s*</JSON>", re.DOTALL | re.IGNORECASE)
ARCH_RE = re.compile(
    r"<\s*synthi_arch_cache\s*>\s*\n?(.*?)\n?\s*<\s*/\s*synthi_arch_cache\s*>",
    re.DOTALL | re.IGNORECASE,
)
MANIFEST_RE = re.compile(
    r"<\s*synthi_build_manifest\s*>\s*\n?(.*?)\n?\s*<\s*/\s*synthi_build_manifest\s*>",
    re.DOTALL | re.IGNORECASE,
)


@dataclass
class ParsedResponse:
    raw_text: str
    files: dict[str, dict[str, str]] = field(default_factory=dict)
    arch_md: str = ""
    manifest: dict[str, Any] = field(default_factory=dict)
    parse_errors: list[str] = field(default_factory=list)

    @property
    def structural_ok(self) -> bool:
        return not self.parse_errors


def parse_response(raw_text: str) -> ParsedResponse:
    pr = ParsedResponse(raw_text=raw_text)

    # Extract JSON block (the 4 files)
    json_match = JSON_RE.search(raw_text)
    if not json_match:
        pr.parse_errors.append("missing <JSON>...</JSON> block")
    else:
        try:
            pr.files = json.loads(json_match.group(1).strip())
        except json.JSONDecodeError as e:
            pr.parse_errors.append(f"<JSON> block not valid JSON: {e}")

    # Validate the 4 files are present with content
    for key in ("shared", "core", "gui", "host_runner"):
        entry = pr.files.get(key)
        if not isinstance(entry, dict):
            pr.parse_errors.append(f"files[{key!r}] missing or not a dict")
            continue
        content = entry.get("content")
        if not isinstance(content, str) or len(content) < 20:
            pr.parse_errors.append(
                f"files[{key!r}].content missing or < 20 chars"
            )

    # Extract architecture cache
    arch_match = ARCH_RE.search(raw_text)
    if not arch_match:
        pr.parse_errors.append("missing <synthi_arch_cache>...</synthi_arch_cache>")
    else:
        pr.arch_md = arch_match.group(1).strip()

    # Extract build manifest from within the arch cache
    manifest_match = MANIFEST_RE.search(raw_text)
    if not manifest_match:
        pr.parse_errors.append("missing <synthi_build_manifest>...</synthi_build_manifest>")
    else:
        manifest_raw = manifest_match.group(1).strip()
        try:
            pr.manifest = json.loads(manifest_raw)
        except json.JSONDecodeError as e:
            pr.parse_errors.append(f"<synthi_build_manifest> not valid JSON: {e}")
            # Try to strip trailing commas / comments as a fallback
            cleaned = re.sub(r",(\s*[}\]])", r"\1", manifest_raw)
            try:
                pr.manifest = json.loads(cleaned)
                pr.parse_errors.pop()  # recovered
            except Exception:
                pass

    # Validate manifest required fields (if it parsed at all)
    if pr.manifest:
        required = {
            "compiler",
            "common_flags",
            "gui_link_flags",
            "runner_link_flags",
            "hot_reload_mode",
            "confidence",
        }
        missing = required - set(pr.manifest.keys())
        if missing:
            pr.parse_errors.append(f"manifest missing fields: {sorted(missing)}")
        conf = pr.manifest.get("confidence", {})
        for cf in ("overall", "runner_synthesis", "link_flags"):
            if cf not in conf:
                pr.parse_errors.append(f"manifest.confidence missing {cf!r}")

    return pr


# ─────────────────────────────────────────────────────────────────────────────
# Test case definitions with per-test assertions
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class Assertion:
    name: str
    passed: bool
    detail: str = ""


@dataclass
class TestCase:
    name: str
    code: str
    validates: str
    assertions: Callable[[ParsedResponse], list[Assertion]]


def _get_content(pr: ParsedResponse, key: str) -> str:
    entry = pr.files.get(key, {})
    return entry.get("content", "") if isinstance(entry, dict) else ""


def _in(substr: str, haystack: str) -> bool:
    return substr in haystack


def _any_flag(manifest_key: str, substrs: list[str], pr: ParsedResponse) -> bool:
    flags = pr.manifest.get(manifest_key, [])
    if not isinstance(flags, list):
        return False
    joined = " ".join(str(f) for f in flags)
    return any(s in joined for s in substrs)


def assertions_sdl2(pr: ParsedResponse) -> list[Assertion]:
    out: list[Assertion] = []
    host = _get_content(pr, "host_runner")
    core = _get_content(pr, "core")
    gui = _get_content(pr, "gui")
    m = pr.manifest

    out.append(Assertion(
        "-lSDL2 in gui_link_flags",
        _any_flag("gui_link_flags", ["-lSDL2"], pr),
    ))
    out.append(Assertion(
        "host_runner contains SDL_Init",
        _in("SDL_Init", host),
    ))
    out.append(Assertion(
        "host_runner contains SDL_CreateWindow",
        _in("SDL_CreateWindow", host),
    ))
    out.append(Assertion(
        "host_runner contains SDL_RenderPresent",
        _in("SDL_RenderPresent", host),
    ))
    out.append(Assertion(
        "host_runner contains dlopen",
        _in("dlopen", host),
    ))
    out.append(Assertion(
        "core.cpp does NOT contain SDL_Init",
        not _in("SDL_Init", core),
    ))
    out.append(Assertion(
        "gui.cpp does NOT contain SDL_RenderPresent",
        not _in("SDL_RenderPresent", gui),
    ))
    out.append(Assertion(
        'confidence.overall == "high"',
        m.get("confidence", {}).get("overall") == "high",
    ))
    out.append(Assertion(
        'hot_reload_mode == "swap"',
        m.get("hot_reload_mode") == "swap",
    ))
    return out


def assertions_glfw(pr: ParsedResponse) -> list[Assertion]:
    out: list[Assertion] = []
    host = _get_content(pr, "host_runner")
    core = _get_content(pr, "core")
    m = pr.manifest

    out.append(Assertion(
        "-lglfw in gui_link_flags or runner_link_flags",
        _any_flag("gui_link_flags", ["-lglfw"], pr)
        or _any_flag("runner_link_flags", ["-lglfw"], pr),
    ))
    out.append(Assertion(
        "host_runner contains glfwInit",
        _in("glfwInit", host),
    ))
    out.append(Assertion(
        "host_runner contains glfwSwapBuffers",
        _in("glfwSwapBuffers", host),
    ))
    out.append(Assertion(
        "core.cpp does NOT contain glfwInit",
        not _in("glfwInit", core),
    ))
    out.append(Assertion(
        'confidence.overall in {"high","medium"}',
        m.get("confidence", {}).get("overall") in ("high", "medium"),
    ))
    out.append(Assertion(
        'hot_reload_mode == "swap"',
        m.get("hot_reload_mode") == "swap",
    ))
    return out


def assertions_custom_hint(pr: ParsedResponse) -> list[Assertion]:
    out: list[Assertion] = []
    m = pr.manifest

    out.append(Assertion(
        "-lMyCustomEngine in gui_link_flags",
        _any_flag("gui_link_flags", ["-lMyCustomEngine"], pr),
    ))
    out.append(Assertion(
        "-L/opt/inhouse/lib in gui_link_flags (from // LINK: hint)",
        _any_flag("gui_link_flags", ["/opt/inhouse/lib"], pr),
    ))
    sys_pkgs = m.get("system_packages", [])
    out.append(Assertion(
        'system_packages contains "libinhouse-dev"',
        isinstance(sys_pkgs, list)
        and any("libinhouse-dev" in str(p) for p in sys_pkgs),
    ))
    out.append(Assertion(
        'confidence.link_flags == "high" (because hint was explicit)',
        m.get("confidence", {}).get("link_flags") == "high",
    ))
    return out


def assertions_macro_main(pr: ParsedResponse) -> list[Assertion]:
    out: list[Assertion] = []
    conf = pr.manifest.get("confidence", {})
    notes = str(conf.get("notes", "")).lower()

    out.append(Assertion(
        'confidence.runner_synthesis in {"low","medium"}',
        conf.get("runner_synthesis") in ("low", "medium"),
        f"actual: {conf.get('runner_synthesis')!r}",
    ))
    out.append(Assertion(
        "confidence.notes mentions macro / IMPLEMENT_APP / wxWidgets",
        any(kw in notes for kw in ("macro", "implement_app", "wxapp", "wxwidgets")),
    ))
    # Defensive: the runner_synthesis confidence alone is the primary signal;
    # overall confidence is often set to match runner_synthesis in low cases.
    out.append(Assertion(
        'confidence.overall in {"low","medium"}',
        conf.get("overall") in ("low", "medium"),
        f"actual: {conf.get('overall')!r}",
    ))
    return out


def assertions_fmod_hostile(pr: ParsedResponse) -> list[Assertion]:
    out: list[Assertion] = []
    m = pr.manifest
    conf = m.get("confidence", {})
    notes = str(conf.get("notes", "")).lower()

    out.append(Assertion(
        'hot_reload_mode == "process_restart"',
        m.get("hot_reload_mode") == "process_restart",
        f"actual: {m.get('hot_reload_mode')!r}",
    ))
    out.append(Assertion(
        "-lfmod in gui_link_flags or runner_link_flags",
        _any_flag("gui_link_flags", ["-lfmod"], pr)
        or _any_flag("runner_link_flags", ["-lfmod"], pr),
    ))
    out.append(Assertion(
        "-lSDL2 in gui_link_flags (FMOD layered on SDL2)",
        _any_flag("gui_link_flags", ["-lSDL2"], pr),
    ))
    out.append(Assertion(
        "confidence.notes mentions FMOD / hostile / process restart",
        any(kw in notes for kw in ("fmod", "hostile", "process_restart", "global")),
    ))
    return out


TEST_CASES: list[TestCase] = [
    TestCase(
        name="1. sdl2_button (happy path)",
        code=TEST_SDL2_BUTTON,
        validates="Happy path — no regression from today's SDL2 pipeline",
        assertions=assertions_sdl2,
    ),
    TestCase(
        name="2. glfw_triangle (second library)",
        code=TEST_GLFW_TRIANGLE,
        validates="AI generalizes beyond SDL2",
        assertions=assertions_glfw,
    ),
    TestCase(
        name="3. custom_engine_with_hint (Mitigation 1A)",
        code=TEST_CUSTOM_ENGINE_WITH_HINT,
        validates="AI reads // LINK: hints from source and copies verbatim",
        assertions=assertions_custom_hint,
    ),
    TestCase(
        name="4. macro_main_wxwidgets (Mitigation 2A/C)",
        code=TEST_MACRO_MAIN_WXWIDGETS,
        validates="AI emits confidence.runner_synthesis=low for macro-driven main()",
        assertions=assertions_macro_main,
    ),
    TestCase(
        name="5. fmod_hostile (Mitigation 4A)",
        code=TEST_FMOD_HOSTILE,
        validates='AI emits hot_reload_mode="process_restart" for FMOD',
        assertions=assertions_fmod_hostile,
    ),
]


# ─────────────────────────────────────────────────────────────────────────────
# Gemini REST API caller (stdlib only)
# ─────────────────────────────────────────────────────────────────────────────


def call_gemini(user_code: str, timeout_s: float = TIMEOUT_SEC) -> tuple[int, str, float]:
    """Returns (status, text_or_error, elapsed_s)."""
    prompt = UNIVERSAL_SPLIT_PROMPT.replace("{USER_CODE}", user_code)

    body = {
        "contents": [
            {"role": "user", "parts": [{"text": prompt}]}
        ],
        "generationConfig": {
            "temperature": PROMPT_TEMPERATURE,
            "topP": 0.8,
            "topK": 40,
            "maxOutputTokens": PROMPT_MAX_OUTPUT_TOKENS,
        },
    }

    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            elapsed = time.time() - t0
            try:
                data = json.loads(raw)
                candidates = data.get("candidates", [])
                if not candidates:
                    err = (
                        "no candidates in response; prompt_feedback="
                        + json.dumps(data.get("promptFeedback", {}))[:200]
                    )
                    return resp.status, err, elapsed
                parts = candidates[0].get("content", {}).get("parts", [])
                text = "".join(p.get("text", "") for p in parts)
                return resp.status, text, elapsed
            except json.JSONDecodeError:
                return resp.status, raw, elapsed
    except urllib.error.HTTPError as e:
        elapsed = time.time() - t0
        body_str = ""
        try:
            body_str = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        return e.code, f"HTTPError {e.code}: {body_str}", elapsed
    except urllib.error.URLError as e:
        elapsed = time.time() - t0
        return -1, f"URLError: {e.reason}", elapsed
    except Exception as e:
        elapsed = time.time() - t0
        return -2, f"{type(e).__name__}: {e}", elapsed


# ─────────────────────────────────────────────────────────────────────────────
# Main runner
# ─────────────────────────────────────────────────────────────────────────────

C_GREEN = "\033[32m"
C_RED = "\033[31m"
C_YELLOW = "\033[33m"
C_BOLD = "\033[1m"
C_DIM = "\033[2m"
C_RESET = "\033[0m"


def mark(ok: bool) -> str:
    return f"{C_GREEN}PASS{C_RESET}" if ok else f"{C_RED}FAIL{C_RESET}"


def run():
    print(f"{C_BOLD}Phase 1 dry-run — universal split prompt{C_RESET}")
    print(f"  Model:       {MODEL}")
    print(f"  Endpoint:    {URL.split('?')[0]}")
    print(f"  API key:     {API_KEY[:4]}...{API_KEY[-4:]} (length {len(API_KEY)})")
    print(f"  Timeout:     {TIMEOUT_SEC}s per call")
    print()

    overall_results: list[tuple[TestCase, ParsedResponse | None, list[Assertion], float, int]] = []

    for i, tc in enumerate(TEST_CASES, 1):
        print(f"{C_BOLD}─── Test {i}/5: {tc.name} ───{C_RESET}")
        print(f"  Validates: {tc.validates}")
        print(f"  Source:    {len(tc.code)} chars")
        print(f"  Calling Gemini ...")

        status, text_or_err, elapsed = call_gemini(tc.code)

        if status != 200:
            print(f"  {C_RED}API error{C_RESET}: status={status}, elapsed={elapsed:.1f}s")
            print(f"  {C_DIM}{text_or_err[:500]}{C_RESET}")
            overall_results.append((tc, None, [], elapsed, status))
            print()
            continue

        print(
            f"  API OK: {elapsed:.1f}s, "
            f"response {len(text_or_err)} chars"
        )

        pr = parse_response(text_or_err)

        if not pr.structural_ok:
            print(f"  {C_RED}Structural parse failed:{C_RESET}")
            for err in pr.parse_errors:
                print(f"    - {err}")
            overall_results.append((tc, pr, [], elapsed, status))
            print()
            continue

        print(f"  Structural parse: {C_GREEN}OK{C_RESET}")
        print(f"    - JSON block: 4 files present "
              f"(shared={len(_get_content(pr, 'shared'))}ch, "
              f"core={len(_get_content(pr, 'core'))}ch, "
              f"gui={len(_get_content(pr, 'gui'))}ch, "
              f"host_runner={len(_get_content(pr, 'host_runner'))}ch)")
        print(f"    - arch cache: {len(pr.arch_md)} chars")
        print(f"    - build manifest: parsed "
              f"(compiler={pr.manifest.get('compiler')!r}, "
              f"hot_reload_mode={pr.manifest.get('hot_reload_mode')!r})")

        # Run per-test assertions
        asserts = tc.assertions(pr)
        passed = sum(1 for a in asserts if a.passed)
        total = len(asserts)
        print(f"  Mitigation assertions: {passed}/{total}")
        for a in asserts:
            marker = (
                f"    {C_GREEN}✓{C_RESET} " if a.passed
                else f"    {C_RED}✗{C_RESET} "
            )
            line = f"{marker}{a.name}"
            if not a.passed and a.detail:
                line += f" {C_DIM}({a.detail}){C_RESET}"
            print(line)

        overall_results.append((tc, pr, asserts, elapsed, status))
        print()

    # ── Summary ────────────────────────────────────────────────────────────
    print(f"{C_BOLD}══════════════════════════════════════════════════════════════{C_RESET}")
    print(f"{C_BOLD}PHASE 1 SUMMARY{C_RESET}")
    print(f"{C_BOLD}══════════════════════════════════════════════════════════════{C_RESET}")

    structural_passes = 0
    mitigation_pass_tests = 0
    failures = 0

    for tc, pr, asserts, elapsed, status in overall_results:
        structural_ok = pr is not None and pr.structural_ok
        if structural_ok:
            structural_passes += 1

        if not asserts:
            # Structural failure or API error
            passed = 0
            total = 0
            mitigation_ok = False
        else:
            passed = sum(1 for a in asserts if a.passed)
            total = len(asserts)
            # Test passes its mitigation check if >= ceil(total * 0.7)
            threshold = max(1, (total * 2 + 2) // 3)  # ≈ 66% of assertions
            mitigation_ok = passed >= threshold
            if mitigation_ok:
                mitigation_pass_tests += 1

        if not (structural_ok and mitigation_ok):
            failures += 1

        struct_tag = (
            f"{C_GREEN}struct OK{C_RESET}" if structural_ok
            else f"{C_RED}struct FAIL{C_RESET}"
        )
        mitig_tag = (
            f"{C_GREEN}mitigation {passed}/{total}{C_RESET}"
            if mitigation_ok
            else f"{C_RED}mitigation {passed}/{total}{C_RESET}"
        )
        print(f"  {tc.name}")
        print(f"     {struct_tag} | {mitig_tag} | {elapsed:.1f}s")

    print()
    print(f"  Structural parses:         {structural_passes}/5")
    print(f"  Mitigation assertions:     {mitigation_pass_tests}/5 tests passed (>=66% of assertions each)")
    print(f"  Full test failures:        {failures}/5")
    print()

    # ── Phase 1 gate ────────────────────────────────────────────────────────
    gate_struct = structural_passes == 5
    gate_mitig = mitigation_pass_tests >= 4
    gate_abort = failures >= 3

    print(f"{C_BOLD}Phase 1 gate:{C_RESET}")
    print(f"  [{mark(gate_struct)}] 5/5 structural parses"
          f"  (actual: {structural_passes}/5)")
    print(f"  [{mark(gate_mitig)}] >=4/5 mitigation pass"
          f"  (actual: {mitigation_pass_tests}/5)")
    print(f"  [{C_RED}ABORT{C_RESET} if 3+ failures]"
          f" (actual failures: {failures}/5)")
    print()

    if gate_abort:
        print(f"{C_RED}{C_BOLD}VERDICT: ABORT.{C_RESET}")
        print("  3+ tests failed. The AI-synthesized approach is not reliable enough.")
        print("  Fall back to the YAML-profile plan.")
        sys.exit(2)
    elif gate_struct and gate_mitig:
        print(f"{C_GREEN}{C_BOLD}VERDICT: PASS.{C_RESET}")
        print("  Proceed to Phase 2 (manifest extraction + pydantic schema).")
        sys.exit(0)
    else:
        print(f"{C_YELLOW}{C_BOLD}VERDICT: PARTIAL.{C_RESET}")
        print("  Not enough failures to abort, but not clean enough to proceed.")
        print("  Iterate on the universal prompt and retry.")
        print("  (Structural pass is mandatory. Mitigation pass needs >=4/5.)")
        sys.exit(1)


if __name__ == "__main__":
    run()
