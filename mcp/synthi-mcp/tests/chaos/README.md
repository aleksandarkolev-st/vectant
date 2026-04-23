# Chaos suite — phase 2e

Structured fault-injection tests that run the MCP + worker under
degraded-network / flapping-process / corrupted-payload conditions and
assert the correctness table still holds.

**Status: scaffold.** The harness + scenario registry are in tree;
individual scenarios are the phase-2e landing (per
`PHASE_2_PLUS_BACKLOG.md:G3` sub-phase 2e, ~1 week).

## Why a separate suite

The integration suite (`tests/integration/`) runs under `docker-compose up -d`
against a cooperating stack. Chaos breaks that assumption deliberately:

- **Latency injection** — `tc netem` on the signaling / worker bridge to
  push signaling-response tails from 5ms to 500ms. Asserts the MCP's
  attach-budget + frame-age SLA still degrade gracefully.
- **Data-channel packet loss** — inject 5% / 20% / 50% random drop on
  the worker→browser DC. Asserts input-dispatch-ack timeout + retry
  logic surfaces `input_ack_timeout` at the right threshold.
- **Frame freeze** — pause the worker's GStreamer pipeline for 10s.
  Asserts `frame_stale` (priority 7 in the correctness ladder) fires
  with the right evidence.
- **Worker kill** — SIGKILL the worker process mid-session. Asserts
  the MCP surfaces `session_terminated` + the correct
  `required_tool_call: synthi_attach` remediation.
- **Signaling-server partition** — drop the MCP↔signaling WS for 5s,
  restore. Asserts `synthi_reconnect` recovers without losing the
  event log (ultraplan §Reconnect preservation).
- **Redis eviction mid-session** — flush the session map on the shared
  Redis instance. Asserts `session_migrating` fires for any peer that
  was mid-operation; `session_not_ready` for a fresh attach.
- **Payload corruption** — inject one invalid UTF-8 byte into a
  `build-log` message. Asserts the injection-heuristic prescreen
  flags it and the MCP keeps going.

Each scenario is one deterministic reproduction; assertions are of the
form "correctness ladder surfaced error X with evidence Y" rather than
"MCP was slow." Chaos is about whether the contract holds under duress,
not about perf numbers.

## Layout

```
tests/chaos/
├── README.md                 ← this file
├── runner.mjs                ← scenario dispatcher + assertion harness
└── scenarios/
    ├── _template.mjs         ← shape every scenario conforms to
    ├── latency_injection.mjs (planned)
    ├── dc_packet_loss.mjs    (planned)
    ├── frame_freeze.mjs      (planned)
    ├── worker_kill.mjs       (planned)
    ├── signaling_partition.mjs (planned)
    ├── redis_eviction.mjs    (planned)
    └── payload_corruption.mjs (planned)
```

## Running (when populated)

```bash
# against a live docker-compose stack
SYNTHI_CHAOS_DOCKER_PROJECT=synthi-ide \
SYNTHI_SIGNALING_URL=ws://localhost:9000 \
  node tests/chaos/runner.mjs

# run one scenario
node tests/chaos/runner.mjs --only worker_kill

# increase iteration count for soak-ish runs
node tests/chaos/runner.mjs --iterations 10
```

Phase-2e landing adds a `ci-chaos` GitHub Actions workflow that runs
the full suite nightly against a docker-compose stack spun up in CI.
Per-PR runs are opt-in (`[run-chaos]` label) because the failure modes
are load-bearing but slow to reproduce (~10 min for the full suite).

## Not in scope

- **Performance regression** is a different tool (`H1` in the phase-2+
  backlog: `benchmarks/` + baseline comparison).
- **Long-haul soak** is phase 3 (`layer 5` per ultraplan §Testing).
- **Multi-agent stress** gated on phase-2c broker; chaos runs one
  agent per scenario today.
