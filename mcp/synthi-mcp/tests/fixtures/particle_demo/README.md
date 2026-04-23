# Fixture: `particle_demo`

Animated UI fixture for Synthi MCP spike experiment E2b.

## Files

| File | Purpose |
|---|---|
| `main.cpp` | Monolithic single-file C++ program. AI-split + HMR at runtime. |

## Library agnostic

Same note as `../counter/README.md` — this happens to be SDL2 for
compile-path stability, not because the spike assumes SDL2.

## Observable signal

Two-layer scene designed to stress pHash caches in opposite directions:

1. **Particle field (animated).** 200 bouncing 3×3 squares cover the
   majority of the 800×600 window. Between any two consecutive frames,
   a full-frame pHash will show drift even with **no** source edit.
   This is the input that falsifies a full-frame-only cache.

2. **Static UI panel (non-animated).** A 130×60 rect anchored at
   `(650,20)` whose color is controlled by `panel_r / panel_g / panel_b`.
   The rect never moves — only its color changes when the source is
   edited. That means a region-pHash keyed on the panel's bbox is
   invariant across frames within a single "edit session", and flips
   only when the source is actually edited.

## How the spike uses this

E2b dispatches `synthi_mouse({handle:"panel"})` 50 times under three
backend configurations:

| Strategy | Expected behavior |
|---|---|
| Full-frame pHash cache | Very low hit % (cache entry invalidates every frame because the particle field moved). |
| Region-pHash cache (±20% padding, 8px floor) around the panel | High hit % because only the panel's pixels matter for the handle identity. |
| `preferred_vision_backend: "agent_side"` | No server-side cache; latency-per-dispatch distribution is the interesting metric. |

Decision rules from the ultraplan:

- **Region-pHash ships** if full-frame <30% AND region >70%.
- **Default backend stays `claude_api`** if region-pHash p99 dispatch
  latency < `agent_side` p99 + 200 ms.
- **Default flips to `agent_side`** otherwise.

See `../../PHASE_0_5_FINDINGS.md` (in repo root) for results.
