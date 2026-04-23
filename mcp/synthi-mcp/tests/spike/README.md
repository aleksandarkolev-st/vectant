# Synthi MCP — phase 0.5 spike harness

Five falsification experiments from `AGENT_MCP_ULTRAPLAN.md:1330-1368`.
Each has a named threshold that either **commits**, **falsifies**, or
**marginally commits** a plan decision. The spike is not done until
every experiment has a finding row in `PHASE_0_5_FINDINGS.md`.

## Modes

| Mode | Enables | Requires |
|------|---------|----------|
| `sim` *(default)* | Synthetic frames + injected build-log events. Measures MCP-layer correctness (cache, pHash, wait_hmr). Runs anywhere. | none |
| `live` | End-to-end against a live Synthi stack. Measures real worker HMR timings, encoder cadence, vision costs. | `docker-compose up -d` at repo root + (E4) `ANTHROPIC_API_KEY` |

Select via `SPIKE_MODE=live npm run spike:all`. Default is `sim`.

## Quick run

```bash
cd mcp/synthi-mcp
npm run build
npm run spike:all > findings.json
```

Or per-experiment:

```bash
npx tsx tests/spike/E1_frame_seq.ts
npx tsx tests/spike/E2_locator_cache.ts
npx tsx tests/spike/E2b_region_phash.ts
npx tsx tests/spike/E3_p99_load.ts
SPIKE_MODE=live npx tsx tests/spike/E4_cost_budget.ts
```

## Experiments

| ID | Sim output | Live extension | Gate |
|----|------------|----------------|------|
| **E1** | Simulated compile/frame race, sweeps fps × pipeline_budget. | Connect to real session, measure encoder frame ts_cap vs status arrival ts. | Frame-seq gate ship decision. |
| **E2** | 50 synthetic edit cycles, counter-style color transitions. | Real HMR cycles against `counter/` fixture. | `synthi_locate` cache vs stateless. |
| **E2b** | 50 synthetic frames with animated noise + stable panel region. | Particle demo fixture running. | Region-pHash vs full-frame, backend default. |
| **E3** | 10 parallel × 10 iter mock locate calls. | Real Anthropic multimodal calls. | `claude_api` vs `agent_side` default. |
| **E4** | Live-stub only (see file header). | 30-min Claude Code loop; cost projection. | Phase-2 `MAX_VISION_COST_USD_PER_HR`. |

## What sim mode tells you

The sim runner exercises the **mechanism** — cache correctness, pHash
stability under the shapes of input we expect, hamming thresholds, and
the classifier's handling of terminal vs non-terminal HMR events. It
catches bugs in the MCP's own code. It does not measure the real
encoder pipeline or the real Anthropic API, so numeric findings like
"claude_api p99 is 2.1 s" can only come from live mode.

If a sim-mode run gives you a finding (e.g., `regionHitRate: 1.0,
fullFrameHitRate: 0.0, ship`), treat it as evidence that the design
intent holds **given our model of the world**. Live mode is the only
way to confirm the model.

## Mapping sim verdicts to ultraplan decisions

```
E1.verdict = "falsify" → phase 1 drops the frame-seq gate
E1.verdict = "commit"  → phase 1 ships the encoder-timestamp gate
E2.verdict = "commit"  → ship LocateCache as designed
E2.verdict = "falsify" → strip the cache; synthi_locate is stateless
E2b.regionShipsDecision = "ship" → region-pHash lands in phase 1
E2b.backendDefault = "agent_side" → flip default in README + per-client configs
E3.verdict = "confirm" → claude_api stays default
E4 (live only) → phase-2 MAX_VISION_COST_USD_PER_HR default
```

All decisions are written to `PHASE_0_5_FINDINGS.md` (repo root) before
phase 1 begins.
