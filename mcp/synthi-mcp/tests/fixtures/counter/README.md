# Fixture: `counter`

Static UI fixture for Synthi MCP spike experiments E1 / E2 / E3 / E4.

## Files

| File | Purpose |
|---|---|
| `main.cpp` | Monolithic single-file C++ program — the input the AI split processes at runtime via `POST /refactor/split/verified`. |

We deliberately do **not** ship a pre-split `core.cpp` / `gui.cpp` / `shared.h` — those are AI-generated artifacts produced by the worker every compile.

## Library agnostic

This fixture happens to use SDL2 because that is Synthi's most-stable
compile path today. `UNIVERSAL_SPLIT_PROMPT`
(`ai-backend/ai-engine/llm/prompts.py:2872`) accepts GLFW, SFML, raylib,
custom engines, and plain console apps. Swap `main.cpp` for a variant
that uses a different library and re-run the same spike harness — no
change needed in the test logic.

## Observable signal

`counter` controls two on-screen things:

1. Background RGB (`(counter*17, counter*53, counter*97) mod 256`).
2. Top-left position of an 80×80 white square.

So editing `counter = 0;` → `counter = 10;` produces a pHash-different
frame. The spike harness writes the edited source via collab-server's
file-write REST, blocks on `synthi_wait_hmr`, then screenshots and
compares.

## Reuse across experiments

| Experiment | What this fixture gives us |
|---|---|
| E1 (frame-seq gate necessity) | 100 wait_hmr cycles on a stable UI — stale-frame rate without the gate. |
| E2 (locator cache hit rate on static UI) | 50 edit-HMR cycles — region-pHash cache hit % for the white square's handle. |
| E3 (claude_api p99 under load) | Standard case; 10 parallel locate × 10 iters against a stable frame. |
| E4 (vision cost budget) | 30-min Claude Code loop; realistic agent usage on a predictable UI. |

E2b uses `../particle_demo/` instead.
