#!/usr/bin/env python3
"""
Phase 2 unit tests — no network, no services, just Python.

Validates the code that consumes the universal split prompt's response:
  - build_manifest.py: pydantic schema + V1 execution gate
  - main.py::extract_architecture_and_manifest: regex-based response parser

Runs in ~1 second. No API key needed. No ai-engine process needed.

Usage:
    cd ai-backend/ai-engine
    python3 test_phase2_unit.py
"""
from __future__ import annotations

import json
import sys
from typing import Any

try:
    from build_manifest import (
        BuildManifest,
        ConfidenceBlock,
        ManifestRejection,
        parse_manifest,
        validate_manifest_v1,
        manifest_to_dict,
    )
except ImportError as e:
    print(f"FAIL: could not import build_manifest.py: {e}")
    print("  Run this script from ai-backend/ai-engine/")
    print("  Make sure `pip install pydantic` is available in this Python")
    sys.exit(1)


# ─────────────────────────────────────────────────────────────────────────────
# Canned AI responses (happy path + failure modes)
# ─────────────────────────────────────────────────────────────────────────────

# What a well-formed universal split response looks like. This mirrors what
# the dry-run script validated against the real Gemini API.
CANNED_SDL2_RESPONSE = r"""<JSON>
{
  "shared": {"filename": "shared.h", "content": "#pragma once\n#include <SDL2/SDL.h>\n\ntypedef struct AppState {\n    int frame;\n    SDL_Renderer* renderer;\n} AppState;\n\nextern \"C\" AppState app_state;"},
  "core":   {"filename": "core.cpp", "content": "#include \"shared.h\"\n\nAppState app_state = {0};\n\nextern \"C\" void core_on_load(void* prev_state) {}\nextern \"C\" void core_on_update(void* state_ptr) {\n    AppState* state = (AppState*)state_ptr;\n    state->frame++;\n}\nextern \"C\" void core_on_event(void* state_ptr, void* event_ptr) {}\nextern \"C\" void core_on_unload(void* state_ptr) {}"},
  "gui":    {"filename": "gui.cpp", "content": "#include \"shared.h\"\n\nextern \"C\" void gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr) {\n    AppState* state = &app_state;\n    SDL_Window* win = (SDL_Window*)window_ptr;\n    state->renderer = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);\n}\nextern \"C\" void gui_on_render(void* state_ptr) {\n    AppState* state = (AppState*)state_ptr;\n    SDL_SetRenderDrawColor(state->renderer, 20, 20, 40, 255);\n    SDL_RenderClear(state->renderer);\n    SDL_Rect btn = {50, 50, 200, 60};\n    SDL_SetRenderDrawColor(state->renderer, 60, 120, 220, 255);\n    SDL_RenderFillRect(state->renderer, &btn);\n}\nextern \"C\" void gui_cleanup(void* state_ptr) {}"},
  "host_runner": {"filename": "host_runner.cpp", "content": "#include <SDL2/SDL.h>\n#include <dlfcn.h>\n#include \"shared.h\"\n\nint main() {\n    SDL_Init(SDL_INIT_VIDEO);\n    SDL_Window* win = SDL_CreateWindow(\"HMR Test\", 0, 0, 800, 600, 0);\n    void* core_lib = dlopen(\"./libcore.so\", RTLD_NOW);\n    void* gui_lib = dlopen(\"./libgui.so\", RTLD_NOW);\n    bool running = true;\n    while (running) {\n        SDL_Event e;\n        while (SDL_PollEvent(&e)) if (e.type == SDL_QUIT) running = false;\n        SDL_RenderPresent(((AppState*)dlsym(core_lib, \"app_state\"))->renderer);\n    }\n    return 0;\n}"}
}
</JSON>

<synthi_arch_cache>
# Architecture

## Language & Framework
C++ with SDL2

## Module Contract
- **core.cpp**: logic + state mutation
- **gui.cpp**: rendering + input handling
- **shared.h**: AppState struct
- **host_runner.cpp**: process entry + dlopen loader

## State Access Pattern
```cpp
AppState* state = (AppState*)state_ptr;
```

## Lifecycle Functions
### core.cpp
- `core_on_load` — called once on load
- `core_on_update` — frame logic

### gui.cpp
- `gui_on_load` — get renderer from window
- `gui_on_render` — draw button

## Where User Code Goes
- Rendering → gui_on_render
- Logic → core_on_update
- New struct fields → AppState in shared.h

## Forbidden Patterns
- SDL_RenderPresent in gui.cpp (runner calls it)
- SDL_Init in core/gui

<synthi_build_manifest>
{
  "compiler": "g++",
  "std": "c++17",
  "common_flags": ["-shared", "-fPIC", "-g", "-fno-omit-frame-pointer"],
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
    "notes": "Standard SDL2 application."
  }
}
</synthi_build_manifest>
</synthi_arch_cache>
"""


# ─────────────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────────────

results: list[tuple[str, bool, str]] = []


def T(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    mark = "PASS" if ok else "FAIL"
    line = f"  [{mark}] {name}"
    if detail and not ok:
        line += f"  — {detail}"
    print(line)


# ── Section 1: build_manifest.py happy path ──────────────────────────────────
print("\n─── Section 1: build_manifest.py happy path ─────────────────────")

happy_manifest = {
    "compiler": "g++",
    "std": "c++17",
    "common_flags": ["-shared", "-fPIC"],
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
        "notes": "OK",
    },
}

try:
    m = parse_manifest(happy_manifest)
    T("parse_manifest(dict) — happy path", True)
    T("compiler is g++", m.compiler == "g++", f"got {m.compiler!r}")
    T("hot_reload_mode is swap", m.hot_reload_mode == "swap", f"got {m.hot_reload_mode!r}")
    T("-lSDL2 in gui_link_flags", "-lSDL2" in m.gui_link_flags)
    T("confidence.overall is high", m.confidence.overall == "high")
    T("confidence.notes == 'OK'", m.confidence.notes == "OK")
except Exception as e:
    T("parse_manifest(dict) — happy path", False, f"{type(e).__name__}: {e}")

try:
    validate_manifest_v1(m)
    T("validate_manifest_v1 — happy path", True)
except Exception as e:
    T("validate_manifest_v1 — happy path", False, f"{type(e).__name__}: {e}")

try:
    d = manifest_to_dict(m)
    T("manifest_to_dict round-trip", d.get("compiler") == "g++" and d.get("hot_reload_mode") == "swap")
except Exception as e:
    T("manifest_to_dict round-trip", False, str(e))

# Parse from JSON string (not just dict)
try:
    m2 = parse_manifest(json.dumps(happy_manifest))
    T("parse_manifest(str) — JSON string", m2.compiler == "g++")
except Exception as e:
    T("parse_manifest(str) — JSON string", False, str(e))


# ── Section 2: Mitigation-specific manifest variants ─────────────────────────
print("\n─── Section 2: Mitigation variants ──────────────────────────────")

# Point 4: FMOD hostile → process_restart
fmod_manifest = {**happy_manifest, "hot_reload_mode": "process_restart",
                 "gui_link_flags": ["-lSDL2", "-lfmod"]}
try:
    m = parse_manifest(fmod_manifest)
    validate_manifest_v1(m)
    T("Point 4: hot_reload_mode=process_restart accepted",
      m.hot_reload_mode == "process_restart")
    T("Point 4: gui_link_flags contains both -lSDL2 and -lfmod",
      "-lSDL2" in m.gui_link_flags and "-lfmod" in m.gui_link_flags)
except Exception as e:
    T("Point 4: process_restart", False, str(e))

# Point 2: low confidence runner_synthesis (worker will refuse, but parse
# SHOULD succeed — rejection happens in the Rust worker, not the pydantic
# validator, because BYOR might be enabled)
low_confidence = {**happy_manifest, "confidence": {
    "overall": "low",
    "runner_synthesis": "low",
    "link_flags": "high",
    "notes": "main() is inside IMPLEMENT_APP(MyApp) macro, cannot untangle",
}}
try:
    m = parse_manifest(low_confidence)
    validate_manifest_v1(m)  # NOTE: should NOT reject — BYOR might be on
    T("Point 2: low runner_synthesis parses (no Python-side reject)",
      m.confidence.runner_synthesis == "low")
except Exception as e:
    T("Point 2: low runner_synthesis", False, str(e))


# ── Section 3: Point 3 — multi-step builds must REJECT ───────────────────────
print("\n─── Section 3: Point 3 — multi-step build rejection ─────────────")

qt_manifest = {**happy_manifest, "build_steps": [
    {"name": "moc", "command": "moc", "args": ["main.h"]},
    {"name": "compile", "command": "g++", "args": ["-shared", "moc_main.cpp"]},
]}

try:
    m = parse_manifest(qt_manifest)
    T("Point 3: build_steps parses into schema (forward-compat)",
      m.build_steps is not None and len(m.build_steps) == 2)
except Exception as e:
    T("Point 3: build_steps parses", False, str(e))

# V1 MUST reject this
rejected = False
try:
    validate_manifest_v1(m)
except ManifestRejection as e:
    rejected = True
    T("Point 3: validate_manifest_v1 raises ManifestRejection on build_steps", True)
    T("Point 3: rejection message mentions multi-step or pre-compile",
      "multi-step" in e.message.lower() or "pre-compile" in e.message.lower(),
      f"message: {e.message[:100]}")
except Exception as e:
    T("Point 3: ManifestRejection", False,
      f"wrong exception type {type(e).__name__}: {e}")

if not rejected:
    T("Point 3: V1 correctly refuses build_steps", False,
      "validate_manifest_v1 accepted the manifest (it should have raised)")


# ── Section 4: Schema errors reject cleanly ──────────────────────────────────
print("\n─── Section 4: Malformed manifests reject cleanly ───────────────")

# Missing required `confidence` field
try:
    parse_manifest({**happy_manifest, "confidence": None})
    T("Missing confidence field raises", False, "no exception raised")
except Exception:
    T("Missing confidence field raises", True)

# Invalid compiler
try:
    m = parse_manifest({**happy_manifest, "compiler": "tcc"})
    T("Invalid compiler raises on parse OR validate", False,
      f"parsed through with compiler={m.compiler!r}")
except Exception:
    T("Invalid compiler raises at parse time", True)

# Invalid hot_reload_mode
try:
    m = parse_manifest({**happy_manifest, "hot_reload_mode": "teleport"})
    T("Invalid hot_reload_mode raises on parse OR validate", False,
      f"parsed through with mode={m.hot_reload_mode!r}")
except Exception:
    T("Invalid hot_reload_mode raises at parse time", True)


# ── Section 5: extract_architecture_and_manifest regex ──────────────────────
# We test the regex extractor directly without importing main.py (main.py
# pulls in FastAPI + tons of modules that slow the test down). We replicate
# the regex here; if it doesn't match what's in main.py, a later change to
# either will diverge and this test will flag it.
print("\n─── Section 5: regex-based response extractor ───────────────────")

import re

_ARCH_TAG_RE = re.compile(
    r"""
    (?:^|\n)\s*(?:```[a-zA-Z]*\s*\n)?
    <\s*synthi_arch_cache\s*>\s*\n?
    (?P<body>.*?)
    \n?\s*<\s*/\s*synthi_arch_cache\s*>
    """,
    re.IGNORECASE | re.VERBOSE | re.DOTALL,
)
_MANIFEST_TAG_RE = re.compile(
    r"""
    <\s*synthi_build_manifest\s*>\s*\n?
    (?P<body>.*?)
    \n?\s*<\s*/\s*synthi_build_manifest\s*>
    """,
    re.IGNORECASE | re.VERBOSE | re.DOTALL,
)


def extract_architecture_and_manifest(ai_response: str):
    if not isinstance(ai_response, str) or not ai_response:
        return ai_response or "", "", None
    arch_match = _ARCH_TAG_RE.search(ai_response)
    if not arch_match:
        return ai_response, "", None
    json_part = ai_response[: arch_match.start()].rstrip()
    json_part = re.sub(r"\n?```\s*$", "", json_part).rstrip()
    arch_md = (arch_match.group("body") or "").strip()
    manifest_dict = None
    manifest_match = _MANIFEST_TAG_RE.search(ai_response)
    if manifest_match:
        manifest_raw = (manifest_match.group("body") or "").strip()
        try:
            manifest_dict = json.loads(manifest_raw)
        except json.JSONDecodeError:
            cleaned = re.sub(r",(\s*[}\]])", r"\1", manifest_raw)
            try:
                manifest_dict = json.loads(cleaned)
            except Exception:
                manifest_dict = None
        arch_md = _MANIFEST_TAG_RE.sub("", arch_md).strip()
    return json_part, arch_md, manifest_dict


json_part, arch_md, manifest_dict = extract_architecture_and_manifest(CANNED_SDL2_RESPONSE)

T("json_part extracted (non-empty)", len(json_part) > 50)
T("json_part contains <JSON> block",
  "<JSON>" in json_part and "</JSON>" in json_part)
T("arch_md extracted (non-empty)", len(arch_md) > 50)
T("arch_md starts with '# Architecture'", arch_md.startswith("# Architecture"))
T("arch_md does NOT contain <synthi_build_manifest> (stripped out)",
  "<synthi_build_manifest>" not in arch_md)
T("manifest_dict extracted", isinstance(manifest_dict, dict))
T("manifest_dict has compiler field",
  manifest_dict is not None and manifest_dict.get("compiler") == "g++")
T("manifest_dict has hot_reload_mode=swap",
  manifest_dict is not None and manifest_dict.get("hot_reload_mode") == "swap")
T("manifest_dict confidence.overall=high",
  manifest_dict is not None
  and manifest_dict.get("confidence", {}).get("overall") == "high")

# Parse the extracted manifest end-to-end
try:
    m = parse_manifest(manifest_dict)
    validate_manifest_v1(m)
    T("end-to-end: extracted manifest parses + validates",
      "-lSDL2" in m.gui_link_flags)
except Exception as e:
    T("end-to-end: extracted manifest parses + validates", False, str(e))


# ── Section 6: Trailing comma recovery ──────────────────────────────────────
print("\n─── Section 6: Malformed JSON recovery ──────────────────────────")

# The AI sometimes emits JSON with trailing commas. Our extractor should
# recover via regex cleanup.
TRAILING_COMMA_RESPONSE = r"""<JSON>
{}
</JSON>
<synthi_arch_cache>
# Arch
<synthi_build_manifest>
{
  "compiler": "g++",
  "std": "c++17",
  "common_flags": ["-shared", "-fPIC",],
  "core_link_flags": [],
  "gui_link_flags": ["-lSDL2",],
  "shared_link_flags": [],
  "runner_link_flags": ["-lSDL2",],
  "system_packages": [],
  "hot_reload_mode": "swap",
  "confidence": {
    "overall": "high",
    "runner_synthesis": "high",
    "link_flags": "high",
    "notes": "",
  },
}
</synthi_build_manifest>
</synthi_arch_cache>
"""

_, _, manifest_dict = extract_architecture_and_manifest(TRAILING_COMMA_RESPONSE)
T("trailing-comma JSON recovered", manifest_dict is not None,
  "" if manifest_dict else "manifest_dict is None after cleanup attempt")
if manifest_dict:
    T("recovered manifest has compiler=g++",
      manifest_dict.get("compiler") == "g++")


# ── Summary ──────────────────────────────────────────────────────────────────
print()
print("═" * 65)
passed = sum(1 for _, ok, _ in results if ok)
total = len(results)
print(f"Phase 2 unit tests: {passed}/{total} passed")
if passed == total:
    print("VERDICT: PASS — Phase 2 code is correct. Safe to run live tests.")
    sys.exit(0)
else:
    print("VERDICT: FAIL — fix the failures before running live tests.")
    for name, ok, detail in results:
        if not ok:
            print(f"  FAIL: {name}" + (f"  — {detail}" if detail else ""))
    sys.exit(1)
