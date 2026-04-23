# Phase 0.5 — Findings

**Status:** template. Fill live-mode cells once `docker-compose up -d` + a real
`counter_sdl2` + particle-demo session have been run through the spike
harness (`mcp/synthi-mcp/tests/spike/`).

**Decision authority:** this file is the input to phase-1 scope freeze. Every
row here either commits, falsifies, or marginally-commits an ultraplan
decision. See `AGENT_MCP_ULTRAPLAN.md:1330-1368` for the protocol and
`mcp/synthi-mcp/tests/spike/README.md` for how to run.

---

## Run log

| Run # | Date | Mode | Commit | Environment |
|-------|------|------|--------|-------------|
| 1 | 2026-04-17 | sim | `01e6cc1c` | WSL2 Linux, no docker |
| _2_ | _TBD_ | live | _TBD_ | docker-compose up -d @ repo root |
| _3_ | _TBD_ | live | _TBD_ | Claude Code CLI + ANTHROPIC_API_KEY |

---

## E1 — Frame-seq gate necessity

**Gate:** stale-screenshot rate over 100 `wait_hmr` cycles (status-only).

| Rule | Action |
|------|--------|
| ≤ 2 stale | **Falsify** gate → phase 1 drops it, `synthi_wait({condition:"hmr"})` returns on status alone |
| ≥ 10 stale | **Commit** gate → phase 1 ships the encoder-timestamp gate (`{type:"frame-advance", frame_seq, ts_ms}` on build-log) |
| 3–9 | **Marginal** → commit + add E1b (re-run @ 30fps + VFR content before phase 1 closes) |

### Results

| Run | Mode | fps | pipeline_budget_ms | Stale | Stale rate | Verdict |
|-----|------|-----|---------------------|-------|------------|---------|
| 1 | sim  | 60 | 80 | 98 | 98 % | commit |
| _2_ | _live_ | _60_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

### Sim-run notes (run 1)

The sim models a worst-case race: the compile latency is random in
[30, 800] ms and the encoder frame most recently delivered at the
moment `wait_hmr` resolves is compared against `t_apply +
pipeline_budget_ms`. The 98 % stale rate is the sim saying *"under the
race model I built, nearly every status-only resolve is stale."*
That's mechanism, not magnitude — live-mode at 60 fps on counter is
what finalizes the decision. The sim outcome is consistent with the
ultraplan's hypothesis that the gate is needed.

### Proposed phase-1 action (pending live run)

Keep the ultraplan's default (commit the encoder-timestamp gate). If
live E1 produces ≤ 2 stale, remove `{type:"frame-advance"}` from the
phase-1 wire + adjust `synthi_wait` doc. Both README variants are
pre-drafted in the ultraplan so the flip is documentation-only.

---

## E2 — Locator cache hit rate (static UI)

**Gate:** (cached + region_match) / total dispatches, 50 edit cycles × 2 dispatches.

| Rule | Action |
|------|--------|
| < 30 % | **Falsify** cache → phase 1 ships `synthi_locate` stateless-per-call |
| > 70 % | **Commit** cache |
| 30–70 % | **Tune** TTL / pHash threshold / padding; ship tuned version |

### Results

| Run | Mode | Hits | Re-resolved | Rate | Verdict |
|-----|------|------|-------------|------|---------|
| 1 | sim | 65 | 35 | 65.0 % | tune |
| _2_ | _live_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

### Sim-run notes (run 1)

A synthetic counter that flips background RGB every edit cycle lands
near the upper edge of drift threshold 12 — about half the "after
edit" dispatches produce region-pHash hamming > 12, the other half
just inside. The `tune` verdict is a fair outcome for a fixture that
happens to sweep the threshold; tighter padding (e.g., ±10 %, floor
4 px) or narrower element bboxes would push the hit rate higher.

### Proposed phase-1 action (pending live run)

Ship the cache as designed; treat 30–70 % as a tuning task, not a
design flaw. If live E2 lands < 30 %, strip the cache path from
`synthi_locate` per ultraplan §4.13 fallback.

---

## E2b — Region-pHash vs full-frame vs `agent_side` (animated UI)

**Gate 1 (ship region):** `full-frame hit < 30 %` AND `region hit > 70 %`.
**Gate 2 (backend default):** region `claude_api` p99 < `agent_side` p99 + 200 ms → stay `claude_api`; else flip to `agent_side`.

### Results

| Run | Mode | Full-frame hit | Region hit | agent_side hit | Region p99 | agent_side p99 | Ship region? | Backend default |
|-----|------|----------------|------------|-----------------|------------|-----------------|--------------|------------------|
| 1 | sim | 8 % | 0 % | 0 % | 26 ms | 24 ms | skip | claude_api |
| _2_ | _live_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

### Sim-run notes (run 1)

The synthetic particle scene is adversarial: a panel in the top-right
corner is surrounded by dense animation that overflows into the
±20 %-padded region. Region-pHash drifts every frame; cache never
hits. Full-frame pHash is slightly stable (8 %) because the DCT
partially averages out sparse motion.

**The ultraplan's "region-pHash ships" premise assumes the padded
region is stable relative to the element.** For the particle_demo
case as currently authored, ±20 % padding + 8 px floor is too wide
— the padded band dips into the animated background. Two live-mode
follow-ups:

1. **Measure real particle_demo under default padding** — the
   directional signal from the sim is that region-pHash with wide
   padding struggles in dense animated scenes. If live agrees, we
   need either (a) narrower padding (±5 %, floor 4 px) or (b) a
   stability probe that measures padded-region pHash across 3
   consecutive non-edited frames and refuses to cache if they
   themselves drift > 12.

2. **Measure counter_sdl2 under default padding** — the spike should
   also run E2b against the static counter to give us a data point
   where the padded region is stable. That's closer to "real" region-
   pHash behavior.

### Proposed phase-1 action (pending live run)

Conservative: ship region-pHash behind an **adaptive padding**
defaulting to ±20 % with a 3-frame stability probe at cache-put time
— if the probe fails, fall back to full-frame cache or bypass the
cache entirely for that handle. This costs ~3 extra pHashes per
`synthi_locate` cold miss; cheap. Flip backend default once the
claude_api backend lands.

---

## E3 — `claude_api` p99 under load

**Gate:**

| Rule | Action |
|------|--------|
| p99 > 5 s | **Falsify** — flip default to `agent_side` |
| p99 < 2.5 s | **Confirm** |
| 2.5–5 s | Stay `claude_api` default + README recommendation "for interactive loops, set `preferred_vision_backend: 'agent_side'`" |

### Results

| Run | Mode | Backend | Concurrency | Iterations | p50 | p95 | p99 | Verdict |
|-----|------|---------|-------------|------------|-----|-----|-----|---------|
| 1 | sim  | mock   | 10 | 10 | 35 ms | 49 ms | 55 ms | confirm (mock is instant) |
| _2_ | _live_ | _claude_api_ | _10_ | _10_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

### Sim-run notes (run 1)

Mock backend has no network or DCT cost; its p99 is the orchestration
floor. Live p99 = orchestration + Anthropic API + DCT on the returned
bbox; it's strictly higher. The sim confirms the MCP-side layer is not
the bottleneck.

### Proposed phase-1 action (pending live run)

Both README variants are pre-drafted per ultraplan §E3 remediation
prep; picking the final default is a 5-minute swap once the live p99
is measured.

---

## E4 — Vision cost budget reality check *(live-only)*

**Gate:** hourly p50 projection against `MAX_VISION_COST_USD_PER_HR = 5`.

| Rule | Action |
|------|--------|
| p50 > $4/hr | **Raise** default to `ceiling(p95 + 25 % headroom)` |
| p50 < $1.50/hr | **Lower** default to `ceiling(p95 + 50 % headroom)` |
| $1.50 ≤ p50 ≤ $4 | **Confirm** $5; document p95 tail in README |

### Results

| Run | Mode | Duration | Windows | p50/hr | p95/hr | Proposed default | Verdict |
|-----|------|----------|---------|--------|--------|-------------------|---------|
| _1_ | _live_ | _30 min_ | _3 × 10min_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

### Notes

E4 is live-only by definition — it depends on Claude Code's real
invocation rate against an instrumented `claude_api` backend.

Prerequisites before this can run:
- Phase 1 `claude_api` real implementation lands.
- Phase 1 `synthi_get_usage` tool lands (so the harness can poll cost).
- `ANTHROPIC_API_KEY` + the counter fixture session are up.

### Proposed phase-2 action (pending phase-1 deliverables)

Keep phase 1 metrics-only. E4's output gates `PHASE_2`'s `quota_exceeded` default.

---

## Summary — what phase 1 locks in

| Decision | Status | Source |
|----------|--------|--------|
| Frame-seq gate in phase 1 | provisional **commit** (confirm with live E1) | E1 |
| `synthi_locate` cache | provisional **commit** (tune on live E2) | E2 |
| Region-pHash padding | conservative ship with **adaptive padding + stability probe** | E2b sim signal |
| Default vision backend | **claude_api** (live E3 finalizes) | E3 |
| `MAX_VISION_COST_USD_PER_HR` | deferred to phase-2 post-E4 | E4 |

---

## Open items for phase 1 exit

- [ ] Live E1 at 60 fps on counter_sdl2.
- [ ] Live E1b at 30 fps + VFR content (only if live E1 marginal).
- [ ] Live E2 on counter_sdl2.
- [ ] Live E2b on particle_demo with tuned padding (±5 % / ±10 % / stability probe).
- [ ] Live E3 with real Anthropic API.
- [ ] Live E4 (after phase 1 ships `claude_api` backend + `synthi_get_usage`).
- [ ] Ad-hoc: frame-age distribution end-to-end.
- [ ] Ad-hoc: two "browser" peers against signaling-server (confirm rejection behavior — Path A sanity).
- [ ] Ad-hoc: `pipeline_budget_ms` components (paint / encode / transport) via HMR overlay.
- [ ] Ad-hoc: input-queue depth (B2) under realistic compile durations.
- [ ] Ad-hoc: one-shot vs periodic pipeline_budget recalibration (F2).
- [ ] Ad-hoc: frame-interval p95 under VFR (F4).
