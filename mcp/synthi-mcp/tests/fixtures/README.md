# Synthi MCP fixtures

Monolithic user sources the MCP spike + integration tests edit to
exercise the AI-split + HMR pipeline end-to-end.

## What lives here

Each subdirectory holds a **single-file** C++ program the AI split
consumes at runtime. We do not ship pre-split artifacts — those are
what the worker produces via `POST /refactor/split/verified`.

## Library agnosticism

Synthi's HMR is library-agnostic by design — `UNIVERSAL_SPLIT_PROMPT`
handles SDL2 / GLFW / SFML / raylib / custom engines / plain console
apps. The fixtures happen to pick SDL2 because that is Synthi's most-
stable compile path today; the test harness does not know or care.
Drop in a GLFW / SFML variant of any `main.cpp` and the spike still
runs.

## Inventory

| Fixture | Static / animated | Used by |
|---|---|---|
| `counter/` | static | E1, E2, E3, E4, integration |
| `particle_demo/` | animated | E2b |
| `adversarial/` | static | `prompt_injection.test.ts`, `wm_class_spoof.test.ts` |

See each subdirectory's `README.md` for the observable signal and
per-experiment protocol.

## Where to add a new fixture

```text
tests/fixtures/<name>/
├── main.cpp      (monolithic user source; any supported library)
└── README.md     (observable signal + which experiments use it)
```

The spike harness resolves a fixture by name, reads `main.cpp`, and
issues collab-server file-write REST calls to apply edits.
