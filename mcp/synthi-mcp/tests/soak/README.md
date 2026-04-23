# Soak harness (Phase 3)

Long-running loop that exercises the MCP against a live session. Intended
for finding leaks, latency drift, and degradation that short unit +
integration tests can't see.

## What it does

Attaches to a running Synthi session, then loops for `SOAK_DURATION_MIN`
minutes. Each iteration:

1. `synthi_screenshot` (records frame bytes + age).
2. `synthi_locate` against a known fixture region (exercises region-pHash cache).
3. `synthi_wait({condition:"motion_settled", timeoutMs:500})` (exercises wait engine).
4. `synthi_snapshot` every Nth iteration (phase-3 persistence stress).
5. `synthi_get_usage` every 60 s, diff vs. baseline, log to the summary file.

On exit (timer or SIGINT) it writes:

- `soak-summary.json` — aggregate counters + latency histograms.
- `soak-events.ndjson` — per-iteration timings.

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `SOAK_DURATION_MIN` | 10 | How long to loop. |
| `SOAK_ITERATION_MS` | 2000 | Minimum sleep between iterations. |
| `SOAK_SNAPSHOT_EVERY` | 30 | Capture a snapshot every N iterations. |
| `SOAK_LOCATE_DESCRIPTION` | "the primary button" | `synthi_locate` description. |
| `SOAK_LOCATE_BBOX_HINT` | none | JSON `{x,y,w,h}` for `hints.prefer_region`. When set, works with the `mock` / `agent_side` backend without a vision API. |
| `SOAK_OUTPUT_DIR` | `./.soak` | Where the summary + ndjson go. |
| `SYNTHI_SESSION_ID` | *(required)* | Session to attach to. |
| `SYNTHI_SIGNALING_URL` | `ws://localhost:9000` | Signaling URL. |
| `SYNTHI_VISION_BACKEND` | `mock` | `mock` is recommended for soak — avoids $$ burn. |

## Run

```bash
cd mcp/synthi-mcp
npm run build
SYNTHI_SESSION_ID=my-soak-sess SOAK_DURATION_MIN=60 \
  SOAK_LOCATE_BBOX_HINT='{"x":150,"y":120,"w":500,"h":160}' \
  node tests/soak/soak_loop.mjs
```

Graceful stop: `Ctrl-C` once; the harness drains, writes its summary, and
exits cleanly.
