# Universal Split Corpus — ULTRAPLAN Phase 7

Test corpus for the library-agnostic universal split prompt. Each `.cpp`
file is a representative C++ project covering a distinct library or
architectural pattern. The pytest suite in
`ai-backend/ai-engine/tests/test_universal_split.py` sends each file to
the running ai-engine's `/refactor/split/verified` endpoint and asserts
the returned manifest matches `expected.json`.

The **point** of this corpus is to prove the universal split prompt
handles libraries it was NOT specifically trained on. The assertion
granularity is deliberately loose — we check for substring matches in
link flags (`"sdl"` matches `"-lSDL2"`, `"-lSDL2main"`, `"-lsdl2"`) and
allowed-value sets for confidence / hot-reload-mode rather than exact
string matches — because the AI's exact output will drift across model
versions and locales, but the structural contract must hold.

## Corpus entries

| # | File | Library | Tests |
|---|---|---|---|
| 01 | `01_sdl2_button.cpp` | SDL2 | happy path, swap mode, high confidence |
| 02 | `02_glfw_triangle.cpp` | GLFW + raw OpenGL | second library (non-SDL2), verifies no library leakage |
| 03 | `03_custom_engine_with_hint.cpp` | custom `my_engine` | Mitigation 1A — `// LINK:` hint copied verbatim, confidence.link_flags=high |
| 04 | `04_macro_main_wxwidgets.cpp` | wxWidgets | Mitigation 2A — `IMPLEMENT_APP` macro triggers low runner_synthesis confidence |
| 05 | `05_fmod_hostile.cpp` | FMOD + SDL2 | Mitigation 4A — hot_reload_mode=process_restart, both libs linked |
| 06 | `06_sfml_sprite.cpp` | SFML | class-based C++ API with RAII objects |
| 07 | `07_raylib_circle.cpp` | raylib | self-contained modern library |
| 08 | `08_imgui_sdl.cpp` | ImGui + SDL2 + OpenGL | stacked libraries, AI should note imgui as inline-compiled |
| 09 | `09_sokol_pixel.cpp` | sokol | single-header graphics, tests header-only recognition |
| 10 | `10_console_app.cpp` | none (console) | no graphics, runner synthesised from plain `main()` |
| 11 | `11_qt_with_moc.cpp` | Qt | Mitigation 3 — multi-step build, MUST reject cleanly |

**Not in V1 corpus** (covered by other tests):
- BYOR project (`host_runner.cpp` with `// SYNTHI_USER_RUNNER` sentinel) — tested by Phase 4 unit tests in `worker/tests/phase4_host_runner.rs`
- `.synthi/build.json` override (Mitigation 1B) — post-V1 per ULTRAPLAN §6

## Running

```bash
# 1. Start the ai-engine with a valid GEMINI_API_KEY
cd ai-backend/ai-engine
export GEMINI_API_KEY=<your-key>
python3 main.py  # or uvicorn main:app --host 0.0.0.0 --port 8000

# 2. In another shell, run the corpus suite
cd ai-backend/ai-engine
python3 tests/test_universal_split.py

# Optional: point at a non-local ai-engine
python3 tests/test_universal_split.py --url http://localhost:8000
```

One real Gemini API call per corpus entry (~11 calls). At ~$0.005
per call, a full run costs ~$0.05. CI gates this behind a
prompt-touching PR to avoid burning tokens on unrelated changes.

## Assertion semantics

For each entry, `expected.json` defines:

- **`flag_substrings`**: case-insensitive substrings the `runner_link_flags`
  array MUST contain. Matches partial library names so `"sdl"` satisfies
  `"-lSDL2"`, `"-lsdl"`, `"-lSDL2main"` etc.
- **`forbidden_substrings`**: substrings the `runner_link_flags` must NOT
  contain. Catches library confusion (e.g. a GLFW project accidentally
  linking SDL2).
- **`confidence_runner_synthesis`**: allowed set of values
  {`high`, `medium`, `low`} — the AI's self-reported confidence in its
  runner synthesis.
- **`hot_reload_mode`**: allowed set of values
  {`swap`, `process_restart`, `auto`}.
- **`notes_keywords`**: substrings that MUST appear in `confidence.notes`
  (used for rejection cases — wxWidgets entry requires "IMPLEMENT_APP"
  / "macro" etc. in the notes).
- **`confidence_link_flags`**: optional — for entries with explicit
  `// LINK:` hints, we expect confidence.link_flags to be `high`.
- **`expect_rejection`**: optional — true for entries that should be
  rejected (e.g. `11_qt_with_moc.cpp` via `build_steps` non-empty).
  When true, the test accepts either an HTTP 422 or a manifest with
  a non-empty `build_steps` field or notes mentioning "moc"/"Q_OBJECT".

The suite does NOT assert exact string equality against any AI output —
that would be brittle across model versions. It only checks structural
contracts that must hold regardless of exact wording.
