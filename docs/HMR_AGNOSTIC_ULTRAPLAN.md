# ULTRAPLAN: AI-Synthesized Library- and Language-Agnostic HMR

**Status**: Awaiting Phase 1 dry-run validation.
**Scope (Milestone 1)**: ~2700 lines across ~30 files, ~10-12 days for library-agnostic C++.
**Scope (Milestone 2, deferred)**: ~5000 lines, ~1 month for multi-language (Python/Rust/JS/TS/Go).

---

## 0. TL;DR

The HMR pipeline currently works only for C++ + SDL2 because:

1. `SPLIT_GUI_PROMPT` is ~2500 lines of SDL2-specific tuning
2. The compiler stages hardcode `g++ -lSDL2`
3. The runner binary hardcodes `SDL_Init` / `SDL_CreateWindow` / `SDL_RenderPresent`
4. File names `core.cpp` / `gui.cpp` / `shared.h` are literal strings across ~8 files
5. Hot-reload hostile libraries (FMOD, Wwise, Qt, wxWidgets, JUCE) will segfault on `.so` swap

**The insight that collapses the refactor**: Tier 2 diff_patch, heal, speculative, and edit_applier are already library-agnostic because they consume the architecture cache as their routing signal. The arch cache is free-form markdown — it can describe GLFW / Vulkan / raylib / a custom engine just as easily as SDL2 *if the split prompt knows how*.

**The approach**: instead of hardcoding YAML profiles per library, we let the AI **synthesize everything** — the split, the build manifest (compiler flags), and the `host_runner.cpp` itself. The backend delivers one universal split prompt, parses a machine-readable build manifest the AI emits, and runs whatever compile command the manifest specifies. Zero backend configuration per library. True 0-to-1 agnosticism: a user can paste a framework they invented yesterday and HMR Just Works, provided the AI understands standard C++ dynamic linking.

**The failure modes are bounded by four mitigation triads**:

- **Point 1 — Zero-day frameworks**: build-hint scanning + `.synthi/build.json` escape hatch + visible error card on link failure
- **Point 2 — Hidden entry points**: AI-emitted confidence field + Bring Your Own Runner mode + worker refuses on low confidence
- **Point 3 — Multi-step builds**: forward-compatible `build_steps` schema + V1 rejects with actionable error; V2 executes
- **Point 4 — Hot-reload hostile libraries**: pre-baked safety knowledge + `hot_reload_mode` field + crash-recovery auto-downgrade

**Phase 1 is a dry-run gate**: 5 test inputs (1 happy path + 4 mitigation triads). Pass = 5/5 structural parses + ≥4/5 mitigation assertions. **3+ failures aborts** the AI-synthesized approach and falls back to the YAML-profile plan.

---

## 1. Current state — where C++/SDL2 is hardcoded

| File | What's hardcoded |
|---|---|
| `ai-backend/ai-engine/llm/prompts.py::SPLIT_GUI_PROMPT` | ~2500 lines of SDL2-specific rules: `AppState` struct layout, `gui_on_load` signature, "NO `SDL_RenderPresent`", "NO `#include <X11/...>`", Host KV schema hooks |
| `ai-backend/ai-engine/main.py::HealRequest` | `module_name ∈ {core, gui, shared}` |
| `worker/src/compiler/handler.rs::is_editing_split_file` | `fname.contains("core.") \|\| fname.contains("gui.") \|\| fname.contains("shared.")` |
| `worker/src/compiler/handler.rs` | reads/writes `core.cpp` / `gui.cpp` / `shared.h` by literal name |
| `worker/src/compiler/stages/compile_core.rs` | `system_command("g++")` + fixed flags |
| `worker/src/compiler/stages/compile_gui.rs` | same + `-lSDL2` hardcoded |
| `worker/src/hmr/adapted_project.rs::detect_adapted_project` | `core.cpp` / `gui.cpp` / `shared.h` existence check |
| `worker/src/hmr/speculative_diff_patch.rs` | skip list: `ends_with("core.cpp") \|\| "gui.cpp" \|\| "shared.h"` |
| `worker/src/main.rs` file-sync handler | same skip list |
| Runner binary (external) | owns `SDL_Init`, `SDL_CreateWindow`, `SDL_RenderPresent` |

### Already library-agnostic (do not touch)

- `hmr::edit_applier` — pure string splicing
- `_build_full_diff_patch_prompt` — generic text, routes via arch cache
- `format_heal_prompt` — generic, injects arch cache "Forbidden Patterns"
- `hmr::speculative_diff_patch` — generic minus the 3-line skip list
- `hmr::edit_classifier` (sync) — pure regex value patcher
- Architecture cache format itself — free-form markdown
- `classify_loop` — boolean flag logic
- Tier 3 fallback chain

**The architectural lever**: Tier 2 diff_patch hot-path is already agnostic. The refactor is about making the *split* phase and *compile* phase catch up.

---

## 2. Core architectural principle

> **The architecture cache is the abstraction layer between the AI and everything downstream.** If the split prompt emits a correct arch cache for any given library, every other component routes correctly without further code changes.

The refactor is three things:

1. **Teach the split prompt to produce a correct arch cache for any C++ library** — universal prompt, not per-library profiles
2. **Teach compile stages to link against the right library** — consume an AI-emitted build manifest
3. **Generate `host_runner.cpp` per-project** — the AI rewrites the user's `main()` into a dlopen loader

### 2.1 Why AI-synthesized over YAML profiles

Originally considered: `library_profiles/` directory with one YAML per library. Backend detects library from `#include` and dispatches.

**Rejected** because it caps the system at libraries we've pre-profiled. Users with custom in-house engines, brand-new frameworks, or obscure libraries get no support. It's a stopgap.

**AI-synthesized wins**:
- User pastes an in-house engine the LLM has never seen
- The LLM infers `-lMyCustomEngine` from `#include` lines or a `// LINK:` hint
- No backend code change ever needed to support a new library

**AI-synthesized loses** (each with matched mitigation):
- LLM hallucinates wrong linker flag → Point 1 triad (hints + escape hatch + error card)
- LLM can't untangle macro-driven `main()` → Point 2 triad (confidence + refuse + BYOR)
- Library needs multi-step build → Point 3 (V1 rejects, V2 executes)
- Library is hot-reload hostile → Point 4 triad (knowledge + mode + auto-downgrade)

---

## 3. The four output files and the ABI

### 3.1 Files

1. **`shared.h`** — `AppState` struct + shared types + `extern "C"` prototypes. Header-only.
2. **`core.cpp`** — logic and state mutation. Compiles to `libcore.so`. No windowing, no rendering, no `main()`.
3. **`gui.cpp`** — rendering and UI. Compiles to `libgui.so`. Uses window/renderer passed in. No present/swap. No `main()`.
4. **`host_runner.cpp`** — process entry point. Compiles to per-project executable. Owns window, event loop, present/swap. `dlopen`s `libcore.so` + `libgui.so`.

### 3.2 ABI (`extern "C"`, state as `void*`)

```cpp
// core.so
void core_on_load(void* prev_state);
void core_on_update(void* state_ptr);
void core_on_event(void* state_ptr, void* event_ptr);
void core_on_unload(void* state_ptr);

// gui.so
void gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr);
void gui_on_render(void* state_ptr);
void gui_cleanup(void* state_ptr);
```

Cast inside: `AppState* state = (AppState*)state_ptr;`

### 3.3 State ownership

```cpp
// core.cpp
static AppState app_state = {0};

extern "C" void core_on_load(void* prev_state) {
    // Optionally migrate fields from prev_state into app_state
}
```

On reload, new `.so`'s static storage is fresh — `core_on_load(prev_state)` receives the OLD pointer so it can migrate fields. Library-agnostic because `void*` carries no library information.

### 3.4 Host runner lifecycle

`host_runner.cpp` is AI-generated from user `main()`. Must:

1. Own window creation (preserve user's title, size, flags)
2. Own event loop (preserve user's event handling shape)
3. Own present/swap/flush
4. `dlopen("./libcore.so", RTLD_NOW)` + `dlopen("./libgui.so", RTLD_NOW)` on startup
5. `dlsym` lifecycle functions; store pointers
6. Call `core_on_load(nullptr)`, stash `AppState*`
7. Call `gui_on_load(nullptr, window_ptr, nullptr)` on startup
8. Per frame: `core_on_update(state)`, `gui_on_render(state)`, present/swap
9. Per event: `core_on_event(state, &event)`
10. On exit: `gui_cleanup`, `core_on_unload`, `dlclose`, destroy window

User's original `main()` is COMPLETELY REMOVED from `core.cpp` and `gui.cpp`.

---

## 4. Build manifest schema

### 4.1 Nested XML tag inside arch cache

```
<synthi_arch_cache>
# Architecture

## Language & Framework
C++ with SDL2.

## Module Contract
...

## State Access Pattern
```cpp
AppState* state = (AppState*)state_ptr;
```

## Lifecycle Functions
...

## Where User Code Goes
...

## Forbidden Patterns
...

<synthi_build_manifest>
{
  "compiler": "g++",
  "std": "c++17",
  "common_flags": ["-shared", "-fPIC", "-g", "-gdwarf-4",
                   "-fno-omit-frame-pointer", "-fdiagnostics-format=json"],
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
```

**Why nested XML tag vs fenced JSON block**: easier to parse (same regex shape), impossible to collide with prose, fails cleanly if truncated.

### 4.2 Pydantic schema

```python
class ConfidenceBlock(BaseModel):
    overall: Literal["high", "medium", "low"]
    runner_synthesis: Literal["high", "medium", "low"]
    link_flags: Literal["high", "medium", "low"]
    notes: str = ""

class BuildManifest(BaseModel):
    compiler: Literal["g++", "clang++"] = "g++"
    std: str = "c++17"
    common_flags: List[str] = []
    core_link_flags: List[str] = []
    gui_link_flags: List[str] = []
    shared_link_flags: List[str] = []
    runner_link_flags: List[str] = []
    system_packages: List[str] = []
    hot_reload_mode: Literal["swap", "process_restart", "auto"] = "swap"
    confidence: ConfidenceBlock
    # Forward-compat for V2. V1 REJECTS non-empty build_steps.
    build_steps: Optional[List[dict]] = None
```

---

## 5. The four mitigation triads

### 5.1 Point 1 — Zero-day frameworks

**Triad A + B + C**: detection → quick fix → permanent fix. All ship in V1.

**A — Build hint scanning in source comments**:

| Hint | Action |
|---|---|
| `#pragma comment(lib, "X")` | add `-lX` to `gui_link_flags` |
| `// LINK: -lX -L/path -I/path` | parse, copy VERBATIM |
| `// REQUIRES: libx-dev` | add to `system_packages` |
| `// BUILD: g++ main.cpp -lfoo` | authoritative compile command |

User hints ALWAYS override AI inference. If any hint present, `confidence.link_flags = "high"`.

**B — `.synthi/build.json` escape hatch**:

Power users commit a manifest to their repo. Worker reads it VERBATIM, skips AI manifest generation entirely.

```json
{
  "compiler": "g++",
  "gui_link_flags": ["-lMyInHouseEngine", "-L/opt/inhouse/lib"],
  "runner_link_flags": ["-lMyInHouseEngine", "-L/opt/inhouse/lib"],
  "system_packages": ["libinhouse-dev"],
  "hot_reload_mode": "swap"
}
```

**C — Visible error card on link failure**:

> **Link failed.** The AI guessed `-lmyengine`. It didn't work.
>
> **Options:**
> - Add a `// LINK: -lcorrect-flag` comment to your source
> - Create `.synthi/build.json` with the correct flags
> - Or pick a known framework: [SDL2] [GLFW] [SFML] [raylib]

**User journey**: C shows the problem → A gives quick fix → B is the permanent fix once they're tired of comments.

### 5.2 Point 2 — Hidden entry points (`IMPLEMENT_APP`, JUCE, Qt macros)

**Triad A + B + C**: signal → guardrail → escape hatch.

**A — AI emits `confidence.runner_synthesis`**:

- `"high"` — plain `int main()` with clear loop
- `"medium"` — framework boilerplate but core loop isolable
- `"low"` — macro-driven entry point (`IMPLEMENT_APP`, `DECLARE_APPLICATION`, ...)

Plus `confidence.notes` free-form explanation.

**B — Bring Your Own Runner mode** (dual marker):

- **In-file sentinel**: `// SYNTHI_USER_RUNNER` at the top of `host_runner.cpp` — source of truth, survives git/export/copy
- **Sidecar flag**: `"user_runner": true` in `.synthi_split_meta.json` — fast-path for the Rust worker

If either is set, the AI skips runner generation on re-split. The user's hand-written runner loads `libcore.so` / `libgui.so` via `dlopen` themselves.

**C — Worker refuses on low confidence**:

> **Runner synthesis failed (low confidence).** Your project uses a macro-driven entry point (`IMPLEMENT_APP(...)`) that the AI can't safely untangle.
>
> **Options:**
> - Enable "Bring Your Own Runner" mode and write your own `host_runner.cpp` with `// SYNTHI_USER_RUNNER` at the top
> - Switch to a framework with a plain `int main()` (SDL2, GLFW, raylib, SFML, ...)
> - (Advanced) Manually expand the macro into a concrete `main()`

**User journey**: A (signal) → C (guardrail — no silent failure) → B (escape hatch).

### 5.3 Point 3 — Complex build systems (Qt MOC, CMake, multi-step)

**V1 ships Graceful Rejection only.**

Schema forward-compatible; V1 validator rejects execution with actionable error:

```
This project needs a pre-compile step that V1 doesn't support yet.

We detected: [Qt MOC / CMakeLists.txt / Makefile / meson.build].
V1 only supports frameworks that compile with a single `g++` invocation.

Options:
- Switch to a simpler framework (SDL2, GLFW, raylib, SFML, ...)
- Use "Bring Your Own Runner" mode and manage your build externally,
  letting Synthi just swap the `.so` files after your build runs
- Wait for V2 multi-step build support (ETA: after V1 ships)
```

V2 schema shape (accepted by V1 parser, rejected by V1 validator):

```json
{
  "build_steps": [
    {"name": "moc", "command": "moc",
     "args": ["mainwindow.h", "-o", "moc_mainwindow.cpp"]},
    {"name": "compile_gui", "command": "g++",
     "args": ["-shared", "-fPIC", "moc_mainwindow.cpp", "gui.cpp",
              "-lQt5Widgets", "-o", "libgui.so"]}
  ]
}
```

### 5.4 Point 4 — Hot-reload hostile libraries

**Triad A + B + C**: safety knowledge → mode lever → crash recovery.

**A — Pre-baked safety knowledge in the prompt**:

```
SWAP-SAFE (use "swap"):
  SDL2, SDL3, GLFW, raylib, sokol, Dear ImGui, nanovg, stb_*, bgfx, MiniFB,
  pure OpenGL with GLFW context

HOT-RELOAD HOSTILE (use "process_restart"):
  FMOD, FMOD Studio, Wwise, OpenAL-soft, Steam API, wxWidgets, Qt, JUCE,
  any audio library with persistent global mixing state,
  any GUI framework with global event dispatchers

Unknown libraries: default to "swap". Crash recovery will auto-downgrade
to "process_restart" if the runner segfaults within 2s of a reload.
```

**B — `hot_reload_mode` field**:

- `"swap"` — `dlclose` old, `dlopen` new. Fast (~50ms). Standard.
- `"process_restart"` — kill runner, re-spawn with new `.so`. Slower (~300-800ms) but correct.
- `"auto"` — start with swap; auto-downgrade on crash.

**C — Crash recovery auto-downgrade**:

`hmr/dynlib_crash_isolation.rs` (already exists). Extend:

1. On runner segfault within 2s of reload → downgrade in-memory `hot_reload_mode` to `process_restart`
2. Log `[HMR] runner crashed after reload — auto-downgrading to process_restart mode for this session`
3. Restart runner in restart-mode for rest of session
4. Next session starts fresh

**The crown jewel**: even for unknown hostile libraries (where A can't help), C guarantees the system self-corrects after exactly one failed reload.

---

## 6. The three refinements

### 6.1 BYOR file marker — dual sentinel + sidecar

Both ship in V1. See §5.2 Mitigation B.

### 6.2 Rejection error wording — actionable options

Every refusal path emits an error card with **three concrete options**, not a dead-end message. Specific wording in §5.

### 6.3 Test corpus — 15 projects

| # | Project | Validates | Phase |
|---|---|---|---|
| 1 | `sdl2_button.cpp` | Happy path — no regression | Phase 1 dry-run |
| 2 | `glfw_triangle.cpp` | Second library | Phase 1 dry-run |
| 3 | `custom_engine_with_hint.cpp` | Mitigation 1A | Phase 1 dry-run |
| 4 | `macro_main_wxwidgets.cpp` | Mitigation 2A/C | Phase 1 dry-run |
| 5 | `fmod_hostile.cpp` | Mitigation 4A | Phase 1 dry-run |
| 6 | `sfml_sprite.cpp` | Class-based C++ API | Phase 7 |
| 7 | `raylib_circle.cpp` | Self-contained library | Phase 7 |
| 8 | `imgui_demo.cpp` | Immediate-mode UI | Phase 7 |
| 9 | `sokol_pixel.cpp` | Minimal sokol | Phase 7 |
| 10 | `glfw_imgui.cpp` | Stacked libraries | Phase 7 |
| 11 | `user_provided_runner/` | Mitigation 2B (BYOR) | Phase 7 |
| 12 | `qt_with_moc.cpp` | Mitigation 3 (reject cleanly) | Phase 7 |
| 13 | `console_app.cpp` | No graphics | Phase 7 |
| 14 | `opengl_raw.cpp` | Raw OpenGL + GLFW | Phase 7 |
| 15 | `.synthi/build.json` override | Mitigation 1B | Phase 7 |

---

## 7. The eight phases

### Phase 1 — Universal split prompt + dry-run (~2 days, ~500 lines)

**Goal**: prove the universal prompt works on 5 representative tests. Cheap abort point.

**Files**:
- `ai-backend/ai-engine/llm/prompts.py` — new `UNIVERSAL_SPLIT_PROMPT` (~300 lines) teaching ABI, state ownership, host runner generation, forbidden patterns, build hint scanning, hot-reload safety, confidence field, output format, 3 few-shot examples (SDL2, GLFW, console app)
- `ai-backend/ai-engine/test_universal_split_dryrun.py` — uncommitted. Self-contained: prompt + 5 test inputs + Gemini API caller + validators + pass/fail report

**Phase 1 gate**:
- 5/5 structural parses (valid `<JSON>` + 4 files + valid `<synthi_arch_cache>` + valid `<synthi_build_manifest>`)
- ≥4/5 mitigation-specific assertions
- **3+ failures = ABORT** and fall back to YAML-profile plan

**The 5 tests**:

| # | Test | Expected |
|---|---|---|
| 1 | `sdl2_button.cpp` | `-lSDL2` in gui_link_flags; host_runner has SDL_Init/SDL_CreateWindow/SDL_RenderPresent/dlopen; core has no SDL_Init; gui has no SDL_RenderPresent; confidence.overall="high"; hot_reload_mode="swap" |
| 2 | `glfw_triangle.cpp` | `-lglfw` in gui_link_flags; host_runner has glfwInit/glfwSwapBuffers; confidence high; swap mode |
| 3 | `custom_engine_with_hint.cpp` | AI reads `// LINK: -lMyCustomEngine` from source, copies VERBATIM; `system_packages` has `libinhouse-dev`; confidence.link_flags="high" |
| 4 | `macro_main_wxwidgets.cpp` | `IMPLEMENT_APP(MyApp)` in source; confidence.runner_synthesis ∈ {"low","medium"}; notes mentions macro |
| 5 | `fmod_hostile.cpp` | FMOD init; hot_reload_mode="process_restart"; gui_link_flags has `-lfmod` |

**Per-test assertions** (see full plan for complete list):

Generic: response 200, JSON parses, 4 files, content > 20 chars, arch cache extractable, manifest extractable, manifest JSON parses, required fields present.

Test-specific: library link flags, host_runner contents, forbidden-pattern absence, confidence fields, hot_reload_mode.

**Abort**: if 3+ failures across the 5 tests → AI isn't capable enough. Fall back to YAML-profile plan. No code committed until Phase 1 passes.

### Phase 2 — Manifest extraction + pydantic schema (~0.5 day, ~150 lines)

**Files**:
- `ai-backend/ai-engine/build_manifest.py` — NEW. `BuildManifest`, `ConfidenceBlock`, `validate_manifest_v1()` rejects `build_steps`
- `ai-backend/ai-engine/main.py::extract_architecture_and_manifest()` — NEW helper
- `ai-backend/ai-engine/main.py::refactor_split_verified` — uses universal prompt, calls extractor, validates manifest, returns `{"result", "architecture", "manifest"}`

### Phase 3 — Worker compile dispatch (~1 day, ~300 lines)

**Files**:
- `worker/src/hmr/build_manifest.rs` — NEW. `BuildManifest` serde struct. Reads from sidecar.
- `worker/src/hmr/mod.rs` — register
- `worker/src/compiler/handler.rs` — extract manifest from `perform_ai_split`, persist to sidecar, thread through to compile stages
- `worker/src/compiler/stages/compile_core.rs` — `compile_core(..., manifest)`, uses manifest flags
- `worker/src/compiler/stages/compile_gui.rs` — same
- `worker/src/compiler/stages/compile_shared.rs` — NEW if needed
- Backwards compat: sidecar with no manifest → SDL2 default

### Phase 4 — Host runner compilation (~1-2 days, ~400 lines)

**Files**:
- `worker/src/compiler/stages/compile_runner.rs` — NEW. Takes `host_runner.cpp` + `manifest.runner_link_flags`, produces executable
- `worker/src/compiler/handler.rs` — after `.so` compiles, call `compile_runner`. Only rebuilds on content hash change.
- `worker/src/compiler/stages/runner.rs` — load runner binary from workspace (not shipped)
- `worker/src/hmr/adapted_project.rs::detect_adapted_project` — checks for 4 files including `host_runner.cpp`
- **BYOR mode**: sentinel `// SYNTHI_USER_RUNNER` + sidecar `"user_runner": true`. If set, skip regeneration.

### Phase 5 — Tier 2 4-module apply (~1 day, ~200 lines)

**Files**:
- `worker/src/hmr/edit_applier.rs::Edit::module` — add `"host_runner"`
- `worker/src/compiler/handler.rs::apply_edit_list` — 4th target
- After apply: if `host_runner.cpp` changed by hash, invoke `compile_runner`, re-spawn runner process
- `worker/src/hmr/speculative_diff_patch.rs` — include `host_runner.cpp` in read

### Phase 6 — Build-failure heal loop (~1 day, ~300 lines)

**Files**:
- `ai-backend/ai-engine/main.py` — NEW endpoint `POST /refactor/heal/manifest`. Takes `(current_manifest, compiler_errors, source_excerpt)`, returns `updated_manifest`
- `worker/src/compiler/stages/compile_core.rs` + `compile_gui.rs` — on `undefined reference`, extract symbols, call `perform_ai_heal_manifest`, retry once
- `worker/src/compiler/stages/ai_utils.rs::perform_ai_heal_manifest` — NEW
- Visible error card on second failure (Point 1C)

### Phase 7 — Full test corpus + CI (~1-2 days, ~400 lines + 15 samples)

**Files**:
- `ai-backend/ai-engine/tests/corpus/*.cpp` — 15 stub projects
- `ai-backend/ai-engine/tests/test_universal_split.py` — pytest suite
- `.github/workflows/universal-split-test.yml` — runs on every PR touching prompts or manifest

### Phase 8 — Frontend cleanup (~0.5 day, ~200 lines)

**Files**:
- `synthi/src/components/project/CreateProjectModal.tsx` — remove library picker, add optional framework hint
- `synthi/src/components/project/ProjectSettings.tsx` — BYOR checkbox
- `synthi/src/components/compile/CompileErrorCard.tsx` — NEW (three-option error cards)
- `synthi/src/components/compile/ConfidenceWarning.tsx` — NEW (medium confidence pre-compile nudge)
- Status bar reads framework from arch cache

---

## 8. Files touched — full list

### New
**Python**: `build_manifest.py`, 15 corpus stubs, `test_universal_split.py`, `test_universal_split_dryrun.py` (Phase 1)
**Rust**: `hmr/build_manifest.rs`, `compiler/stages/compile_runner.rs`, `compiler/stages/compile_shared.rs`
**Frontend**: `CompileErrorCard.tsx`, `ConfidenceWarning.tsx`
**CI**: `universal-split-test.yml`

### Modified
**Python**: `llm/prompts.py` (full rewrite), `main.py` (extract, refactor_split_verified, refactor_heal_manifest)
**Rust**: `hmr/mod.rs`, `compiler/handler.rs`, `compiler/stages/ai_utils.rs`, `compiler/stages/compile_core.rs`, `compiler/stages/compile_gui.rs`, `compiler/stages/runner.rs`, `hmr/adapted_project.rs`, `hmr/speculative_diff_patch.rs`, `hmr/edit_applier.rs`, `hmr/dynlib_reload.rs`, `hmr/dynlib_crash_isolation.rs`
**Frontend**: `CreateProjectModal.tsx`, `ProjectSettings.tsx`, `StatusBar.tsx`

---

## 9. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Universal prompt produces worse SDL2 output than hand-tuned `SPLIT_GUI_PROMPT` | Medium | Phase 1 Test 1 catches it. Port valuable SDL2 rules as generic rules. |
| AI guesses wrong linker flag for zero-day framework | Medium | Point 1 triad: `// LINK:` hint, `build.json`, error card |
| AI can't untangle macro-driven `main()` | High (for Qt/wxWidgets/JUCE) | Point 2 triad: confidence → refuse → BYOR |
| AI emits malformed JSON manifest | Low-Medium | Pydantic validator. One retry. Second failure → Tier 3 re-split. |
| Manifest has `build_steps` for Qt MOC | Expected | V1 rejects cleanly. V2 executes. |
| Runner segfaults on `.so` swap | Medium | Point 4 triad: knowledge → `process_restart` → auto-downgrade |
| Host runner regenerated on re-split, losing user edits | Low | BYOR is the escape hatch |
| Test corpus not representative | Medium | 15 projects span the space; add more as gaps emerge |
| API key leaks in dry-run | Low | Env var only, not committed, rotate after dry-run |
| V1 scope creeps into V2 | Medium | Hard boundary: library-agnostic C++ only, single-step `g++` only |

---

## 10. Success criteria

1. **SDL2 regression**: current demo unchanged, ~2s edit latency
2. **GLFW end-to-end**: compiles, splits, hot-reloads at 2-3s
3. **SFML end-to-end**: same
4. **raylib end-to-end**: same
5. **Custom engine with hint**: compiles and reloads (Mitigation 1A)
6. **Qt project**: rejects cleanly with error card (Mitigation 3)
7. **wxWidgets macro**: refuses with low-confidence card + BYOR option (Mitigation 2A+C)
8. **FMOD-hostile**: compiles with `process_restart`, survives edits (Mitigation 4A+B)
9. **Crash recovery**: segfault → auto-downgrade (Mitigation 4C)
10. **Cost of 16th library**: <1 hour (corpus entry, not code)
11. **Library picker removed from frontend**

---

## 11. Scope

### Milestone 1 — Library-agnostic C++

| Phase | Days | Lines |
|---|---|---|
| 1: Universal split prompt + dry-run | 2 | ~500 |
| 2: Manifest extraction + schema | 0.5 | ~150 |
| 3: Worker compile dispatch | 1 | ~300 |
| 4: Host runner compilation | 1-2 | ~400 |
| 5: Tier 2 4-module apply | 1 | ~200 |
| 6: Manifest heal loop | 1 | ~300 |
| 7: Test corpus + CI | 1-2 | ~400 + 15 samples |
| 8: Frontend cleanup | 0.5 | ~200 |
| **Total V1** | **~10-12 days** | **~2700 lines** |

**V1 does NOT ship**: multi-step builds, Python/Rust/JS/TS/Go, runner sharing, `build.json` GUI editor.

### Milestone 2 — Multi-language (deferred)

~5000 lines, ~1 month. Per-language split prompts + hot-reload strategies + file extensions.

Key questions for M2:

- **Python**: `importlib.reload()` or re-`exec` runner? Import caching makes true hot-swap tricky.
- **Rust**: compile `cdylib`, `dlopen` like C++. Same pattern, different compiler.
- **JS/TS**: delegate to Vite's HMR? Or Node `--watch`? Different concept entirely.
- **Go**: no good `.so` hot-reload. Degrades to `process_restart` for all Go.

Each is orthogonal design. M2 gets its own ULTRAPLAN when V1 ships.

---

## 12. Phase 1 dry-run procedure

1. **Claude writes** `ai-backend/ai-engine/test_universal_split_dryrun.py`: full `UNIVERSAL_SPLIT_PROMPT` + 5 test inputs + Gemini REST caller + validators + pass/fail report
2. **User runs** on their machine: `GEMINI_API_KEY=<key> python3 test_universal_split_dryrun.py`
3. **User pastes output**
4. **Claude analyzes** against the Phase 1 gate
5. **Go/no-go** on Phases 2-8

Claude's sandbox cannot reach `generativelanguage.googleapis.com` (IP-blocked at Google's edge), so the dry run happens on the user's machine. Only manual step in the 8-phase pipeline.

---

## 13. Post-V1

- **Easy wins**: Dear ImGui, sokol, bgfx, nanovg — each is a corpus test
- **BYOR ecosystem**: power users ship `.synthi/build.json` + `// SYNTHI_USER_RUNNER` as team templates
- **Community corpus**: users submit tests for their framework
- **V2 multi-step builds**: start with Qt based on V1 rejection telemetry
- **Milestone 2 unblocked**: universal prompt + manifest dispatch + BYOR + crash recovery all transfer to other languages

---

**This plan is final. Decisions locked. Phase 1 dry-run script is the next action.**
