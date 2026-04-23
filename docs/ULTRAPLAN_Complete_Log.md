# ULTRAPLAN: Library-Agnostic → Language-Agnostic HMR

## Complete Design Log (User ↔ Agent)

---

## Preamble — Agent's Internal Reasoning

> **Agent's thinking before proposing the plan:**

The agent enumerated every hardcoded C++/SDL2 assumption in the codebase and planned to generalize each one. This initially led to a sprawling plan touching 20+ files.

**Key insight #1:** Tier 2 `diff_patch`, `heal`, `speculative`, and `edit_applier` are already library-agnostic because they consume the architecture cache as their routing signal. The arch cache is free-form markdown emitted by the split prompt — it can describe GLFW just as easily as SDL2, if the split prompt knows how.

That means the entire "all C++ libraries" effort collapses down to three things:

1. Make the split prompt produce a correct arch cache for non-SDL libraries (so everything downstream routes correctly).
2. Make the compile stages link against the right library (`-lSDL2` vs `-lglfw` etc.).
3. Make the runner (the binary that owns window/renderer and calls the user's `.so`) library-aware.

Everything else — Tier 2, heal, speculative, edit_applier, the `handler.rs` state machine, the sidecar — stays exactly as-is.

**Key insight #2:** The existing 2500-line `SPLIT_GUI_PROMPT` is mostly SDL2 tuning that took a long time to get right. Replacing it wholesale would risk quality regression. Better: treat the SDL2 profile's `extra_instructions` as the current prompt verbatim, then incrementally extract common sections into the generic builder as more libraries are added. Zero regression on SDL2 day one.

**Key insight #3:** The runner binary is `AppState`-agnostic because `AppState` is owned by the user's `.so` via static storage — the runner just passes `void*` back and forth. So one pre-built runner per library can be shipped, selected at compile time. No per-project runner compilation needed.

**Refinement:** Library profiles should live in the Python `ai-engine` (where the split prompt authority is), not in the Rust worker. The worker just reads the chosen profile name from the sidecar and uses a small hardcoded lookup table for compile flags + runner binary path.

**Risks flagged:**
- (a) The SDL2 split prompt has been tuned with ~2500 lines of specific rules — rewriting it risks losing that tuning.
- (b) Different libraries have different ABI/calling conventions, so the `gui_on_load` signature may not generalize cleanly.
- (c) Runner templates per library = more binaries to build and ship.

---

## ULTRAPLAN v1 — YAML-Profile-Based Approach

### 1. Current Status Quo

The HMR pipeline currently assumes:

- **Language:** C++ only (`.cpp` / `.h`)
- **Library:** SDL2 only (`SDL_RenderPresent`, `SDL_Init`, `SDL_CreateWindow` owned by runner)
- **Module names:** literal strings `core.cpp`, `gui.cpp`, `shared.h`
- **Compiler:** `g++` with hardcoded flags
- **Runner:** one binary, hardcoded to SDL2 init/event/present cycle
- **Lifecycle ABI:** `core_on_load(void* prev_state)`, `gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)`, `gui_on_render(void* state_ptr)` — signatures baked into the split prompt

#### Hardcoded Locations (Audited)

| File | Hardcoded thing |
|------|-----------------|
| `ai-engine/llm/prompts.py::SPLIT_GUI_PROMPT` | ~2500 lines of SDL2-specific rules |
| `ai-engine/main.py::HealRequest` | expects `module_name ∈ {core, gui, shared}` |
| `worker/src/compiler/handler.rs::is_editing_split_file` | `core.` / `gui.` / `shared.` substring check |
| `worker/src/compiler/handler.rs` | reads/writes `core.cpp`/`gui.cpp`/`shared.h` by literal name |
| `worker/src/compiler/stages/compile_core.rs` | `g++ -shared -fPIC -rdynamic ...` |
| `worker/src/compiler/stages/compile_gui.rs` | same + `-lSDL2` |
| `worker/src/hmr/adapted_project.rs` | `detect_adapted_project` looks for `core.cpp`/`gui.cpp`/`shared.h` |
| `worker/src/hmr/speculative_diff_patch.rs` | skip list: `.ends_with("core.cpp")` / `gui.cpp` / `shared.h` |
| `worker/src/main.rs` file-sync handler | same skip list |
| Runner binary (external to worker repo) | owns `SDL_Init`, `SDL_CreateWindow`, `SDL_RenderPresent` |

#### Already Library-Agnostic (Don't Touch)

- `hmr::edit_applier` — pure string splicing
- `_build_full_diff_patch_prompt` — consumes arch cache, has no SDL text
- `format_heal_prompt` — consumes arch cache, no SDL text
- `hmr::speculative_diff_patch` — generic except the 3-line skip list
- `hmr::edit_classifier (sync)` — pure regex value patcher, not library-specific
- Architecture cache format — free-form markdown

### 2. Architectural Principle

> The architecture cache is the abstraction layer between the AI and everything downstream. If the split prompt emits a correct arch cache for a given library, every other component (Tier 2 diff_patch, heal, speculative) routes correctly without further code changes.

The refactor is therefore NOT about generalizing Tier 2 or heal. It's about:

1. Teaching the split prompt to recognize each library and produce a correct arch cache for it.
2. Teaching the compile stages to link the user's `.so` against the right library.
3. Shipping the right runner binary per library (the thing that owns the window/event loop).

### 3. Library Profile Abstraction

A library profile is a YAML file that carries everything the pipeline needs to know about a specific library. It lives in the Python `ai-engine` (since that's where the split prompt authority is) and a subset is mirrored into the worker's sidecar at first compile.

#### 3.1 Profile Schema

```yaml
# ai-backend/ai-engine/library_profiles/sdl2.yaml
name: sdl2
language: cpp
display_name: "SDL2"

# How to detect this library from user source code
detection:
  includes:
    - "SDL2/SDL.h"
    - "SDL.h"
  symbols:
    - "SDL_Init"
    - "SDL_CreateWindow"
  priority: 100  # higher priority wins when multiple profiles match

# Types used by the split modules
types:
  window_type: "SDL_Window*"
  renderer_type: "SDL_Renderer*"
  window_header: "SDL2/SDL.h"

# State access pattern (used verbatim in the split prompt)
state_access_pattern: |
  AppState* state = (AppState*)state_ptr;
  // Access: state->renderer, state->window, etc.

# Lifecycle function signatures the runner expects the user's .so to export
lifecycle_functions:
  core:
    - name: "core_on_load"
      signature: 'extern "C" void core_on_load(void* prev_state)'
      description: "Called once when the core module loads. Initialize state."
    - name: "core_on_update"
      signature: 'extern "C" void core_on_update(void* state_ptr)'
      description: "Called every frame to update state/logic."
    - name: "core_on_event"
      signature: 'extern "C" void core_on_event(void* state_ptr, void* event_ptr)'
      description: "Called for each SDL_Event the runner receives."
  gui:
    - name: "gui_on_load"
      signature: 'extern "C" void gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)'
      description: "Called once. Cast window_ptr to SDL_Window* and store the renderer."
    - name: "gui_on_render"
      signature: 'extern "C" void gui_on_render(void* state_ptr)'
      description: "Called every frame for rendering. Do NOT call SDL_RenderPresent."

# Patterns user code MUST NOT emit
forbidden_patterns:
  - pattern: "SDL_Init"
    reason: "Runner owns SDL_Init — user code must not initialize SDL."
  - pattern: "SDL_CreateWindow"
    reason: "Runner owns the window."
  - pattern: "SDL_RenderPresent"
    reason: "Runner calls SDL_RenderPresent after gui_on_render returns."
  - pattern: "#include <X11/"
    reason: "No X11 — this codebase uses SDL2 for all windowing."
  - pattern: "malloc(sizeof(AppState))"
    reason: "AppState must use static storage, not heap allocation."

# Compile configuration
compile:
  compiler: "g++"
  std: "c++17"
  base_flags:
    - "-shared"
    - "-fPIC"
    - "-D_POSIX_C_SOURCE=199309L"
    - "-g"
    - "-gdwarf-4"
    - "-fno-omit-frame-pointer"
    - "-fdiagnostics-format=json"
    - "-ldl"
    - "-pthread"
    - "-rdynamic"
  core_link_flags: []
  gui_link_flags: ["-lSDL2"]
  shared_link_flags: []

# Runner binary
runner:
  binary_name: "sdl2_runner"
  abi_version: 1
  runner_compile_flags:
    - "-std=c++17"
    - "-lSDL2"
    - "-ldl"
    - "-pthread"

# Library-specific tuning instructions for the split prompt
extra_instructions: |
  (the ~2500 lines of SDL2-specific split tuning from the current
  SPLIT_GUI_PROMPT, preserved verbatim to avoid regression)
```

#### 3.2 Starting Set of Profiles

Ship four to begin:

1. **sdl2.yaml** — migration target. Validates that the new pipeline produces SDL2 results identical to today.
2. **glfw.yaml** — proves the abstraction works for a second windowing library.
3. **sfml.yaml** — proves it works for a C++-class-based API (not pure C like SDL/GLFW).
4. **raylib.yaml** — proves it works for a self-contained library that owns its own window/event loop differently.

After validation, Dear ImGui, sokol, and nanovg follow the same pattern.

#### 3.3 Loader (Python)

```python
# ai-backend/ai-engine/library_profiles/detect.py

def detect_library(source: str) -> Optional[LibraryProfile]:
    """
    Detect which library a C++ source file uses.
    Scoring: each matching include/symbol adds priority points.
    The profile with the highest score wins.
    Returns None if no profile matches.
    """
    profiles = _load_all()
    scores: dict[str, int] = {}
    for name, profile in profiles.items():
        score = 0
        for inc in profile.detection.includes:
            if re.search(rf'#include\s*[<"]({re.escape(inc)})[>"]', source):
                score += 100
        for sym in profile.detection.symbols:
            if re.search(rf'\b{re.escape(sym)}\b', source):
                score += 10
        if score > 0:
            scores[name] = score + profile.detection.priority
    if not scores:
        return None
    best_name = max(scores, key=scores.get)
    return profiles[best_name]
```

### 4. Parameterized Split Prompt

`SPLIT_GUI_PROMPT` becomes a builder function that takes a `LibraryProfile` and produces the prompt text. The architecture cache emission instructions are unchanged.

```python
# ai-backend/ai-engine/llm/split_prompt_builder.py

def build_split_prompt(profile: LibraryProfile) -> str:
    parts = [
        _GENERIC_PREAMBLE,
        f"# LIBRARY: {profile.display_name} ({profile.name})",
        f"Language: {profile.language}",
        "## State access pattern",
        profile.state_access_pattern,
        "## Lifecycle functions...",
        # ... lifecycle functions from profile ...
        "## Forbidden patterns...",
        # ... forbidden patterns from profile ...
        "## Library-specific split rules",
        profile.extra_instructions,   # verbatim SDL2 tuning here
        _GENERIC_ARCH_CACHE_EMISSION,  # unchanged
    ]
    return "\n".join(parts)
```

### 5-9. Endpoint Dispatch, Worker Profile, Sidecar, Compile Stages, Adapted Project Detection

*(Detailed in the original plan — parameterizing the split endpoint, adding `library` field to the sidecar, making compile stages accept a profile parameter, etc.)*

### 10. Runner Binaries

```
worker/runners/
├── sdl2_runner.cpp       (existing, restructured)
├── glfw_runner.cpp       (new)
├── sfml_runner.cpp       (new)
├── raylib_runner.cpp     (new)
├── common/
│   ├── abi.h             (shared lifecycle signatures)
│   └── dylib_loader.h    (shared dlopen helper)
└── Makefile              (builds all four)
```

Each runner is ~150-300 lines of boilerplate — init library, load .so files, run event loop calling the lifecycle functions.

### 11. Frontend Changes (Minimal)

- Optional library picker in project creation modal
- 4 starter templates (one per library)
- Status bar shows detected library
- No changes to compile hooks (already library-agnostic)

### 12. Phased Rollout

| Phase | Scope | Value |
|-------|-------|-------|
| A (1 day) | 400 lines | Profile abstraction exists, SDL2 uses it with zero regression |
| B (1 day) | 150 lines | Auto-detection works, endpoint dispatches per profile |
| C (1 day) | 300 lines | Worker reads profile from sidecar, compiles with per-library flags |
| D (2-3 days) | 500 lines + 1 runner binary | GLFW end-to-end works |
| E (2-3 days) | 800 lines + 2 runner binaries | SFML + raylib work |
| F (ongoing) | ~0 lines, refactoring | Progressive profile deduplication |
| G (0.5 day) | 200 lines | Frontend library picker + templates |

**Total:** ~2500 lines across ~30 files, ~2 weeks. After Phase D (GLFW working) the system is production-viable for non-SDL projects.

### 13. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| SDL2 split quality regresses | Medium | Phase A literally copies SDL2 sections into `extra_instructions`. Unit test compares old vs new. |
| GLFW/SFML split quality is bad at first | High | Start minimal, iterate after measuring. Budget ~5 iterations per library. |
| Runner binaries increase shipping size | Low | Each <1MB. Four = <4MB. Acceptable. |
| Library ABI differences break lifecycle signature | Medium | Signatures only use `void*`. Handle quirks in `extra_instructions` + runner source. |
| Detection false positives | Low | Priority tiebreaker + manual override via `req.library`. |
| Worker and Python profiles drift | Medium | Cross-check test at startup. |

### 14. Approval Questions (Agent → User)

> 1. **Phase A regression strategy:** OK to treat existing 2500-line `SPLIT_GUI_PROMPT` as the SDL2 profile's `extra_instructions` verbatim? Safest way to avoid quality regression, with progressive cleanup in Phase F.
> 2. **Runner distribution:** Pre-build runners and ship as binaries (simpler, larger repo), or compile on worker startup (leaner repo, more complex bootstrap)?
> 3. **Starting library set:** SDL2 + GLFW + SFML + raylib — right cut? Could swap for Dear ImGui, sokol, nanovg, etc.

---

## THE PIVOT — User Challenges the Approach

### User's Counter-Argument

> If the goal is a truly universal platform, hardcoding four profiles (and eventually 10) in YAML files is just a stopgap. You want true, dynamic "0-to-1" agnosticism where a user can drop in a completely custom, in-house graphics framework and the system just handles it.

The user proposed a fundamentally different architecture:

#### 1. Delete `detect_library` Entirely

If we support any arbitrary library, the Python backend doesn't need to detect anything. Instead of Python guessing the library and feeding the AI a profile, **the AI reads the code and defines the profile on the fly.**

#### 2. Universal Split Prompt

Replace `extra_instructions` with a universal HMR teaching prompt. Teach the AI the *concept* of the ABI, rather than hardcoding library rules.

#### 3. AI-Synthesized Linker Flags

Expand the architecture cache to be machine-readable. The AI emits a JSON block inside the arch cache with exact compiler/linker flags, which the Rust worker parses and passes directly to `g++`.

#### 4. "Bring Your Own Runner" (BYOR)

Don't ship pre-built runners. During initial split, the AI generates `host_runner.cpp` directly from the user's code — rewriting their `main()` to inject `dlopen()` logic into their game loop.

**Why this is powerful:**
- Zero server-side configuration — no YAML profiles to maintain
- Ultimate flexibility — any framework, even one invented yesterday
- Simpler backend — delete the whole `library_profiles` directory

**The trade-off:** Trading *backend complexity* for *LLM reliability*.

---

## Agent Accepts the Pivot

> Yes, pivot. You're completely right — YAML profiles are a stopgap that caps the system at "libraries the maintainer has curated." The AI-synthesized approach is the real ceiling.

### Where the Proposal is Strictly Right

1. Delete `detect_library` and the whole `library_profiles/` idea. The AI reads the code once and describes it.
2. Machine-readable build manifest in the arch cache. Fenced JSON block inside `<synthi_arch_cache>`, parsed by Python and forwarded to worker.
3. Bring Your Own Runner. `host_runner.cpp` is a 4th split output generated from the user's original `main()`, not a pre-shipped binary.

### Agent Identifies Four Weak Spots

#### Weak Spot 1 — Runner Mutability During HMR

What happens when the user edits their event loop shape after the initial split?

| Option | Behavior |
|--------|----------|
| 1. Runner is a 4th Tier 2 target | Diff_patch may emit edits to `host_runner.cpp`. On runner edit, recompile runner (~1-2s) AND swap .so files. Total: ~4s. |
| 2. Runner is immutable during HMR | Runner edits require full re-split (Tier 3). Simpler but ~15s cost. |
| **3. Hybrid (recommended)** | **Tier 2 handles most runner edits; on apply failure, fall through to Tier 3.** |

**Decision: Option 3.** Slots cleanly into existing Tier 2 → Tier 3 fallback. ~50 lines of new code.

#### Weak Spot 2 — Build Manifest Format

**Problem:** Nesting a JSON fence inside `<synthi_arch_cache>` markdown is fragile to parse.

**Proposed solution:** A dedicated XML tag inside the arch cache:

```xml
<synthi_arch_cache>
# Architecture
...prose...

<synthi_build_manifest>
{
  "compiler": "g++",
  "std": "c++17",
  "common_flags": ["-shared", "-fPIC", ...],
  "core_link_flags": [],
  "gui_link_flags": ["-lSDL2"],
  "shared_link_flags": [],
  "runner_link_flags": ["-lSDL2", "-ldl"],
  "system_packages": ["libsdl2-dev"]
}
</synthi_build_manifest>
</synthi_arch_cache>
```

**Advantages:** Clean regex extraction (identical to existing `<synthi_arch_cache>` parsing). No risk of the AI confusing prose with JSON.

#### Weak Spot 3 — Trust But Verify the Manifest

Four-layer defense against AI hallucinating wrong linker flags:

1. **Python schema validation** — pydantic schema. Malformed → 400, one retry.
2. **Common-library few-shot examples** in the universal prompt — 5 short examples showing correct manifests for SDL2/GLFW/SFML/raylib/console.
3. **Heal on linker error** — if `g++` fails with `undefined reference`, extract missing symbols, call `/refactor/heal/manifest`, retry once. If still fails → Tier 3 re-split.
4. **Build manifest sidecar cache** — once a manifest compiles successfully, persist it. Subsequent compiles reuse cached manifest.

#### Weak Spot 4 — Test Corpus

10-project corpus for end-to-end validation:

1. `sdl2_button.cpp` — current demo
2. `glfw_triangle.cpp` — classic GLFW
3. `sfml_sprite.cpp` — SFML class-based
4. `raylib_circle.cpp` — self-contained
5. `imgui_demo.cpp` — immediate-mode UI
6. `sokol_pixel.cpp` — minimal example
7. `glfw_imgui.cpp` — compound linker flags
8. `custom_engine.cpp` — fake engine (`MyEngine.h` + `-lMyEngine`)
9. `console_app.cpp` — no graphics library at all
10. `opengl_raw.cpp` — raw OpenGL + GLFW

CI runs all 10 through `/refactor/split/verified` on every commit.

---

## Pivoted Plan Shape

### Phased Breakdown

| Phase | Lines | Days | Description |
|-------|-------|------|-------------|
| 1: Universal prompt | ~400 | 2 | Replaces `SPLIT_GUI_PROMPT` with universal HMR teaching prompt |
| 2: Manifest extraction | ~150 | 0.5 | `extract_architecture_and_manifest()`, pydantic model, sidecar schema |
| 3: Worker compile dispatch | ~300 | 1 | `BuildManifest` serde struct, parameterized compile stages |
| 4: Host runner compile | ~400 | 1-2 | `compile_runner.rs`, handler pipeline extension, runner dispatch |
| 5: Tier 2 4-module apply | ~200 | 1 | `edit_applier` extended to `host_runner`, runner recompile on change |
| 6: Manifest heal loop | ~250 | 1 | `/refactor/heal/manifest` endpoint, retry logic, Tier 3 fallback |
| 7: Test corpus + CI | ~300 + 10 samples | 1-2 | 10 test projects, `test_universal_split.py` |
| 8: Frontend cleanup | ~100 | 0.5 | Framework-hint field, status bar, starter templates |
| **Total** | **~2100 lines** | **~8-10 days** | |

---

## User Raises Four Real-World Failure Modes

### Failure Mode 1: Zero-Day Frameworks (LLM Knowledge Bound)

> If a user pastes code using a proprietary, closed-source internal company engine, the AI will not magically know its linker flags.

### Failure Mode 2: Hidden Entry Points

> Some heavy frameworks (wxWidgets, JUCE, macro-driven game engines) hide `main()` inside a macro (e.g., `IMPLEMENT_APP(MyApp)`).

### Failure Mode 3: Beyond Simple Linker Flags

> Qt requires MOC. Complex CMake steps break the simple manifest model. Agnosticism is limited to libraries that compile via a standard `g++` one-liner (~95% of typical C++ graphics/game frameworks).

### Failure Mode 4: Global State in Third-Party Libraries

> Some libraries rely on hidden global/static variables. Swapping the user's `.so` might desync those globals, causing segfaults on hot-reload.

---

## Agent's Mitigations (Four Triads)

### Triad 1: Zero-Day Frameworks

**A — Build hint scanning in the prompt:**

The universal prompt scans user source for explicit hints:
- `#pragma comment(lib, "X")` → add `-lX`
- `// LINK: -lX -L/opt/x/lib` → parse verbatim
- `// REQUIRES: libx-dev` → add to `system_packages`
- `// BUILD: g++ main.cpp -lmyengine -I/opt/engine/include` → authoritative

User hints ALWAYS override AI inference.

**B — `.synthi/build.json` escape hatch:**

Power users write a `build.json` in their project root. Worker uses it verbatim and skips AI manifest generation entirely.

```json
{
  "compiler": "g++",
  "common_flags": ["-std=c++17", "-shared", "-fPIC"],
  "core_link_flags": [],
  "gui_link_flags": ["-lMyInHouseEngine", "-L/opt/inhouse/lib"],
  "shared_link_flags": [],
  "runner_link_flags": ["-lMyInHouseEngine", "-L/opt/inhouse/lib"],
  "system_packages": ["libinhouse-dev"]
}
```

**C — Visible failure when AI guesses wrong:**

Error card with actionable options instead of opaque "compile failed":

> Link failed. The AI guessed these flags: `-lmyengine`. They didn't work. Either:
> - Add a `// LINK:` comment to your source with the correct flags
> - Create a `.synthi/build.json`
> - Pick a framework hint below: [SDL2] [GLFW] [SFML] ...

### Triad 2: Hidden Entry Points

**A — AI emits a confidence score:**

```json
"confidence": {
  "overall": "high",
  "runner_synthesis": "high" | "medium" | "low",
  "link_flags": "high" | "medium" | "low",
  "notes": "main() is inside IMPLEMENT_APP(MyApp) macro..."
}
```

If `runner_synthesis != "high"`, show warning BEFORE compile.

**B — "Bring Your Own Runner" user mode:**

User ticks "I'll provide the runner myself" or marks their `host_runner.cpp` with `// SYNTHI_USER_RUNNER`. AI skips runner generation and only splits core/gui/shared. User's hand-written runner loads the `.so` files via `dlopen`.

**C — Refuse-to-split with explicit error:**

If `confidence.runner_synthesis == "low"` AND no user-provided runner → refuse to proceed. Clear error: "This framework uses a hidden entry point. Switch to user-provided runner mode."

### Triad 3: Complex Build Systems (MOC, CMake)

**A — Forward-compatible multi-step schema (V2):**

V1 accepts a `build_steps` array shape but immediately rejects execution:

```json
{
  "build_steps": [
    {
      "name": "moc",
      "command": "moc",
      "args": ["mainwindow.h", "-o", "moc_mainwindow.cpp"],
      "inputs": ["mainwindow.h"],
      "outputs": ["moc_mainwindow.cpp"]
    },
    {
      "name": "compile_gui",
      "command": "g++",
      "args": ["-shared", "-fPIC", "gui.cpp", "-lQt5Widgets", "-o", "libgui.so"],
      "inputs": ["gui.cpp", "moc_mainwindow.cpp"],
      "outputs": ["libgui.so"]
    }
  ]
}
```

V1 error: "Multi-step builds (Qt/CMake) are not yet supported. Options: switch to a simpler framework, use BYOR mode, or wait for V2."

**B — "Delegate to user's build system" mode (V2):**

If project contains `CMakeLists.txt`, `Makefile`, `meson.build`, or `*.pro` — delegate entirely. Re-run user's build on edit, then swap changed `.so` files.

### Triad 4: Hot-Reload-Hostile Libraries

**A — Per-library safety knowledge in the prompt:**

```
HOT-RELOAD SAFETY (known):
  SWAP-SAFE:  SDL2, SDL3, GLFW, raylib, sokol, Dear ImGui, nanovg, stb_*
  CONDITIONAL: SFML (static handle pools), bgfx (stateful renderer context)
  HOSTILE:    FMOD, Wwise, Steam API, wxWidgets, Qt, JUCE
  Unknown:    use "swap" (crash recovery will auto-downgrade)
```

If detected library is hostile → emit `"hot_reload_mode": "process_restart"` in the manifest.

**B — `hot_reload_mode` manifest field:**

| Mode | Behavior |
|------|----------|
| `swap` (default) | `dlclose` old `.so`, `dlopen` new `.so`, no process restart |
| `process_restart` | Kill runner process on every edit, re-spawn with new binaries |
| `auto` | Start with `swap`; if runner crashes within 2s of reload, auto-downgrade to `process_restart` |

**C — Crash recovery auto-downgrade:**

If runner segfaults within 2s of a hot-reload → log warning → update in-memory manifest → restart in `process_restart` mode for the rest of the session. Next session starts fresh with `swap`.

Wall-clock cost: `process_restart` ~300-800ms vs `swap` ~50ms. Still fast, just less magical.

---

## User Approves All Four Triads

> **Point 1:** Go with A+B+C. They are a single, cohesive user journey when the AI fails: Detection (C) → Quick Fix (A) → Permanent Fix (B).
>
> **Point 2:** Go with A+B+C. Signal (A) → Guardrail (C) → Escape Hatch (B).
>
> **Point 3:** Graceful rejection (schema part of A) only. Enforce V1 boundary.
>
> **Point 4:** *(Not addressed in this message)*

---

## Agent's Final Refinements

### Refinement 1: BYOR File Marker

Dual mechanism:
- **Sentinel comment** at top of file: `// SYNTHI_USER_RUNNER — do not regenerate` (survives project exports)
- **Sidecar field**: `"user_runner": true` (fast path for worker, avoids file I/O)

### Refinement 2: Multi-Step Build Rejection Wording

> This project needs a pre-compile step that V1 doesn't support yet.
> We detected you're using [Qt / CMake / makefile-driven build].
>
> **Options:**
> 1. Switch to a simpler framework (SDL2, GLFW, raylib, SFML, ...)
> 2. Use "Bring Your Own Runner" mode and manage your build externally
> 3. Wait for V2 multi-step build support

### Refinement 3: Test Corpus Additions (10 → 15)

Additional test projects for the new mitigations:

11. `custom_engine_with_hint.cpp` — fake `MyEngine.h` + `// LINK: -lMyEngine` comment (verifies build-hint scanning)
12. `user_provided_runner/` — directory with pre-written `host_runner.cpp` marked `// SYNTHI_USER_RUNNER` (verifies BYOR mode)
13. `macro_main_wxwidgets.cpp` — fake `IMPLEMENT_APP(MyApp)` macro (verifies low-confidence refusal)
14. `qt_with_moc.cpp` — fake Qt project (verifies V1 rejection with clean error)
15. `fmod_audio.cpp` — fake FMOD init (verifies `hot_reload_mode = process_restart`)

---

## User Approves Point 4 + All Refinements

> **Point 4:** Ship the triad (A+B+C). It completely defangs the worst UX failure mode of C++ hot-reloading (random segfaults). Crash recovery (C) is the crown jewel — guarantees an unknown hostile library only ruins *one* reload attempt before auto-correction.
>
> **BYOR File Marker:** Approved. Sentinel + sidecar is the right balance.
>
> **Rejection Wording:** Approved. Actionable alternatives prevent churn.
>
> **Test Corpus Additions:** Approved. Testing mitigations is as important as happy paths.

---

## Final Locked-Down Plan

### Updated Scope Table

| Phase | Lines | Days | Changes vs. Pre-Feedback |
|-------|-------|------|--------------------------|
| 1: Universal prompt | ~500 | 2 | +build-hint scanning, +confidence field, +hot-reload safety knowledge |
| 2: Manifest extraction + schema | ~250 | 1 | +confidence subfield, +hot_reload_mode, +system_packages, +build.json escape hatch |
| 3: Worker compile dispatch | ~350 | 1 | +reject multi-step manifests gracefully, +system_packages hint |
| 4: Host runner compile | ~500 | 2 | +refuse-to-split on low confidence, +user-provided-runner mode |
| 5: Tier 2 4-module apply | ~200 | 1 | (unchanged) |
| 6: Manifest heal loop | ~300 | 1 | +user-facing error card when heal fails twice |
| 7: Test corpus + CI | ~400 + 15 samples | 2 | +5 extra test projects |
| 8: Frontend cleanup | ~200 | 0.5 | +framework-hint field, +confidence warning card, +user-runner checkbox |
| **Total** | **~2700 lines** | **~10-12 days** | +~600 lines, +2 days |

### V1 Scope Boundaries

**V1 handles:**
- Any library with a standard `g++` one-liner build (SDL2, GLFW, SFML, raylib, Dear ImGui, sokol, nanovg, stb, custom engines with `// LINK:` hints)
- Hostile libraries via `process_restart` fallback
- Zero-day/proprietary frameworks via `.synthi/build.json` escape hatch

**V1 explicitly rejects (with clear errors):**
- Qt (needs MOC)
- wxWidgets (hidden entry point)
- JUCE (hidden entry point)
- CMake-based projects

**V1 fails gracefully on (warnings, not errors):**
- Unknown library with no build hints → AI guesses, heal loop covers, if both fail → "provide hints" error card
- Framework with hidden `main()` macro → `confidence.runner_synthesis == "low"` → pre-compile warning

### V2 Markers (Deferred)

- Multi-step builds (`build_steps` execution)
- User's-build-system delegation (`cmake --build`, `make`, `qmake`)
- ~1000 more lines, separate milestone

---

## Universal Split Prompt (v0 — Dry Run Draft)

```
You are a C++ Hot-Module-Reload (HMR) Splitter+Adapter.

You will be given a single-file C++ application. Refactor it into 4 files that
work with a dynamic-linking HMR system:

1. shared.h          AppState struct + shared types + forward declarations
2. core.cpp          logic and state updates (NO windowing, NO rendering)
3. gui.cpp           rendering and UI (uses renderer/window passed in, does NOT own them)
4. host_runner.cpp   process entry point — owns windowing, event loop, dlopen-loads core.so + gui.so

THE ABI (extern "C", state passed as void*):

core.so exports:
  void core_on_load(void* prev_state);
  void core_on_update(void* state_ptr);
  void core_on_event(void* state_ptr, void* event_ptr);
  void core_on_unload(void* state_ptr);

gui.so exports:
  void gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr);
  void gui_on_render(void* state_ptr);      // MUST NOT call present/swap/flush
  void gui_cleanup(void* state_ptr);

STATE OWNERSHIP:
AppState lives in static storage in core.cpp:
  static AppState app_state = {0};
core_on_load returns &app_state. Host runner stores the pointer and passes it
to subsequent calls. When core.so reloads, prev_state is the OLD pointer so
you can migrate fields if needed.

HOST RUNNER:
host_runner.cpp rewrites the user's main() to:
- Keep their window/event init code VERBATIM (title, size, flags, renderer creation)
- Replace their logic/render calls with dlsym-resolved calls to core_on_update / gui_on_render
- Own the present/swap/flush call at the end of the frame
- dlopen both libcore.so and libgui.so on startup, dlclose on exit
- Call core_on_event for input events

FORBIDDEN:
- core.cpp: NO windowing, NO rendering, NO main()
- gui.cpp: NO window creation, NO present/swap/flush, NO main()
- shared.h: types and declarations only, no executable code

BUILD HINT SCANNING (read user source for these BEFORE guessing flags):
- #pragma comment(lib, "X")              → add "-lX" to gui_link_flags
- // LINK: -lX -L/path -I/path           → parse, add verbatim
- // REQUIRES: libx-dev                  → add to system_packages
- // BUILD: g++ main.cpp -lfoo           → treat as authoritative
User hints ALWAYS override your inference. Copy them VERBATIM.

HOT-RELOAD SAFETY (use this to pick hot_reload_mode):
  SWAP-SAFE:     SDL2, SDL3, GLFW, raylib, sokol, Dear ImGui, nanovg, stb_*
  HOSTILE:       FMOD, Wwise, Steam API, wxWidgets, Qt, JUCE
  Unknown:       use "swap" (crash recovery will auto-downgrade)

CONFIDENCE SIGNALS:
  runner_synthesis:
    "high"   — user has a plain int main() with a clear loop
    "medium" — main() has framework boilerplate but the core loop is isolable
    "low"    — main() is inside a macro (IMPLEMENT_APP, DECLARE_APPLICATION, ...)
  link_flags:
    "high"   — well-known library with standard flags
    "medium" — library known but setup varies
    "low"    — couldn't identify library, guessed from header names

OUTPUT FORMAT (strict):

First, a JSON object wrapped in <JSON>...</JSON>:

<JSON>
{
  "shared":      {"filename": "shared.h",       "content": "..."},
  "core":        {"filename": "core.cpp",       "content": "..."},
  "gui":         {"filename": "gui.cpp",        "content": "..."},
  "host_runner": {"filename": "host_runner.cpp","content": "..."}
}
</JSON>

Then the architecture cache with the build manifest nested inside:

<synthi_arch_cache>
# Architecture

## Language & Framework
(e.g., "C++ with SDL2")

## Module Contract
- **core.cpp**: logic + state mutation
- **gui.cpp**: rendering and UI
- **shared.h**: AppState struct + shared types
- **host_runner.cpp**: process entry + event loop + dlopen loader

## State Access Pattern
(code block showing cast pattern)

## Lifecycle Functions
(per-module function list)

## Where User Code Goes
(routing guide for Tier 2 diff_patch)

## Forbidden Patterns
(library-specific don'ts)

<synthi_build_manifest>
{
  "compiler": "g++",
  "std": "c++17",
  "common_flags": [...],
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
    "notes": "Standard SDL2 application..."
  }
}
</synthi_build_manifest>
</synthi_arch_cache>

Respond with the <JSON>...</JSON> block first, then
<synthi_arch_cache>...</synthi_arch_cache>. Nothing else.
```

---

## File-by-File Change List (Final)

### New Files

**Python:**
- `ai-engine/llm/universal_split_prompt.py` — the universal split prompt builder
- `ai-engine/models/build_manifest.py` — pydantic schema for `BuildManifest`
- `ai-engine/endpoints/heal_manifest.py` — `/refactor/heal/manifest` endpoint
- `ai-engine/tests/corpus/*.cpp` — 15 test projects
- `ai-engine/tests/test_universal_split.py` — CI validation runner

**Rust worker:**
- `worker/src/hmr/build_manifest.rs` — `BuildManifest` serde struct
- `worker/src/compiler/stages/compile_runner.rs` — host runner compile stage

**Frontend:**
- Framework-hint text field component
- Confidence warning card component
- User-runner checkbox component

### Modified Files

**Python:**
- `ai-engine/llm/prompts.py` — `SPLIT_GUI_PROMPT` replaced with universal prompt
- `ai-engine/main.py::refactor_split_verified` — manifest extraction, library/language in response
- `ai-engine/main.py::VerifiedAiRequest` — add optional `library` field

**Rust worker:**
- `worker/src/compiler/handler.rs` — write `build_manifest` to sidecar, pass to compile stages, add runner compile step, 4-module edit routing
- `worker/src/compiler/stages/compile_core.rs` — accept `BuildManifest` parameter
- `worker/src/compiler/stages/compile_gui.rs` — same
- `worker/src/hmr/adapted_project.rs` — check for `host_runner.cpp` presence
- `worker/src/hmr/speculative_diff_patch.rs` — add `host_runner.cpp` to split file reads
- `worker/src/compiler/stages/runner.rs` — pick workspace runner binary instead of shipped binary

### Deleted

- `library_profiles/` directory (never created — the pivot killed it before implementation)
- Pre-shipped runner binaries (replaced by AI-generated `host_runner.cpp`)

---

## Milestone 2 — Language Agnosticism (Deferred)

After library-agnostic C++ is shipped, the next step is multi-language. Same plan shape, broader scope:

- **Language profile** wrapping one or more library profiles
- **Per-language split prompts** — Python, Rust, TS split prompts
- **Per-language compile stages** — `compile_core_python.rs`, etc.
- **Per-language hot-reload strategies:**
  - C/C++/Rust (cdylib): dyn-lib hot-reload (existing)
  - Python: `importlib.reload()` via embedded Python runner
  - JS/TS: Vite dev server + ESM HMR
  - Go: no good hot-reload — fall back to rebuild + restart

**Estimated scope:** ~5000+ lines, ~1 month. Deferred until library agnosticism is validated in production.

---

## Success Definition

After all phases:

1. **SDL2 regression:** zero — produces identical splits + hot-reload behavior
2. **GLFW end-to-end:** new project compiles, splits, hot-reloads. Same 2-3s edit latency.
3. **SFML end-to-end:** same.
4. **raylib end-to-end:** same.
5. **Custom framework:** works with `// LINK:` hints or `.synthi/build.json`
6. **Hostile library:** auto-downgrades to `process_restart` mode after first crash
7. **Hidden entry point:** refuses with clear error + BYOR escape hatch
8. **Complex build system:** rejects with clean error + actionable options
9. **New library cost:** <4 hours for any standard `g++` framework
10. **Test corpus:** 15/15 passing in CI, zero regressions on merge

---

## Execution Order

> Agent's de-risk strategy: Draft the universal prompt first and dry-run it via direct API call against the SDL2 test project before touching any Rust. Only after the dry run passes quality do Phases 2-8 begin. Abort cheaply if the AI turns out to be less reliable than expected.

**Phase 1 first. Everything else follows only if the AI proves it can handle the split reliably.**
