# Soak harness (Phase 3)

Long-running loop that exercises the MCP against a live session. Intended
for finding leaks, latency drift, and degradation that short unit and
integration tests cannot see.

## What it does

Attaches to a running Synthi session, then loops for `SOAK_DURATION_MIN`
minutes. Each iteration:

1. `synthi_screenshot` records frame bytes and age.
2. `synthi_locate` runs against a known fixture region and exercises the region-pHash cache.
3. `synthi_wait({condition:"motion_settled", timeoutMs:500})` exercises the wait engine.
4. `synthi_snapshot` runs every Nth iteration for phase-3 persistence stress.
5. `synthi_get_usage` runs before attach, after attach, during the loop, and after detach so runtime resources can be checked for post-detach leaks.

On exit, whether by timer or `Ctrl-C`, it writes:

- `soak-summary.json` - aggregate counters, latency histograms, process memory growth, usage-counter deltas, and post-detach runtime resource leak counters.
- `soak-events.ndjson` - per-iteration timings.

Release-gate verification expects `runtime_resources.post_detach_observed=true`,
`runtime_resources.browser_session_leak_count=0`, and
`runtime_resources.frame_sink_leak_count=0`.

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `SOAK_DURATION_MIN` | 10 | How long to loop. |
| `SOAK_ITERATION_MS` | 2000 | Minimum sleep between iterations. |
| `SOAK_SNAPSHOT_EVERY` | 30 | Capture a snapshot every N iterations. |
| `SOAK_LOCATE_DESCRIPTION` | "the primary button" | `synthi_locate` description. |
| `SOAK_LOCATE_BBOX_HINT` | none | JSON `{x,y,w,h}` for `hints.prefer_region`. When set, works with the `mock` / `agent_side` backend without a vision API. |
| `SOAK_OUTPUT_DIR` | `./.soak` | Where the summary and ndjson go. |
| `SYNTHI_SESSION_ID` | *(required)* | Session to attach to. |
| `SYNTHI_SIGNALING_URL` | `ws://localhost:9000` | Signaling URL. |
| `SYNTHI_VISION_BACKEND` | `mock` | `mock` is recommended for soak because it avoids spend. |

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
