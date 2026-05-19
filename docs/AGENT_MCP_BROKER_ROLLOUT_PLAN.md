# Agent MCP Brokered TBR Attach — Execution Plan (Build-Ready)

**Status:** Execution-grade rollout spec.
**Scope:** Migrate from per-agent direct TBR/WebRTC attach to brokered attach with safe input control, measurable SLOs, explicit security boundaries, and deterministic failure handling.

---

## 1) Main recommendation (sequenced for safety)

Use a brokered stream attachment model as the target architecture, but migrate in two stages:

1. Move **read-only observation** paths to broker first (`screenshot`, `wait`, `health`, event subscriptions).
2. Cut over **state-changing input** only after broker-enforced leases, stale-frame rejection, normalized errors, and rollback controls are in place.

Shared visual inference follows after broker fanout is stable.

---

## 2) Required invariants (must always hold)

1. At most one active upstream media producer per session.
2. No state-changing input executes without a valid lease.
3. Input based on stale visual state is rejected.
4. Every state-changing action is traceable to `session_id`, `agent_id`, `frame_seq`, `lease_id`, and ack chain.
5. Slow subscribers must never degrade upstream ingest health.
6. Diff/vision evaluation must run in isolated worker pools and must not block broker ingest/fanout loops.
7. Broker must expose explicit recovering state; clients must fail closed while recovering.


---

## 3) Architecture context and constraints

Already available in current architecture:

- MCP lifecycle envelope, event log ring buffer, subscriptions, dispatch-ack plumbing, freshness checks.
- Worker/signaling peer identity and multi-peer routing primitives.
- Existing tool surface that must remain wire-compatible during migration.

Known risk center today:

- Duplicated stream and inference work under multi-agent usage.
- Contention and stale-vision-induced misclicks if input controls are not server-enforced.

---

## 4) Protocol contracts (minimum schema set)

These contracts are required before broker input cutover.

### 4.1 Frame event

```json
{
  "type": "frame",
  "event_id": 900120,
  "session_id": "s_123",
  "frame_seq": 10482,
  "frame_ts_ms": 1716031112345,
  "ingest_ts_ms": 1716031112351,
  "viewport": {"w": 1280, "h": 720, "dpr": 1.0},
  "is_keyframe": false
}
```

### 4.2 Lifecycle event

```json
{
  "type": "lifecycle",
  "event_id": 900121,
  "session_id": "s_123",
  "state": "running",
  "state_ts_ms": 1716031112380,
  "reason": "hmr_applied"
}
```

### 4.3 Health status

```json
{
  "session_id": "s_123",
  "broker_state": "ready",
  "upstream": {
    "connected": true,
    "last_frame_age_ms": 220,
    "rtt_ms": 48
  },
  "subscriber": {
    "lag_ms": 35,
    "queue_depth": 1,
    "dropped_frames": 2
  }
}
```

### 4.4 Input request / ack chain

```json
{
  "tool_call_id": "tc_456",
  "session_id": "s_123",
  "agent_id": "a_7",
  "lease_id": "l_99",
  "based_on_frame_seq": 10482,
  "action": {"tool": "synthi_mouse", "kind": "click", "x": 812, "y": 643},
  "postcondition": {"type": "dom_visible", "selector": "[data-testid='counter']", "text": "3"}
}
```

Ack levels:

- `transport_ack`: broker received command.
- `browser_ack`: runtime accepted/dispatched command.
- `effect_verified`: postcondition satisfied within timeout.

### 4.5 Lease state

```json
{
  "lease_id": "l_99",
  "session_id": "s_123",
  "owner": "a_7",
  "scope": ["mouse", "keyboard"],
  "expires_at_ms": 1716031119000,
  "preemptible": true,
  "priority": "normal",
  "reason": "checkout_flow"
}
```

### 4.6 Inference result envelope

```json
{
  "session_id": "s_123",
  "frame_seq": 10482,
  "frame_timestamp_ms": 1716031112345,
  "viewport_size": {"w": 1280, "h": 720},
  "device_pixel_ratio": 1.0,
  "model_version": "gdm-1.4.2",
  "confidence": 0.91,
  "coordinate_space": "frame_pixels",
  "expiry_ms": 1716031113345,
  "valid_for_input": true,
  "bbox": {"x": 780, "y": 620, "w": 90, "h": 40}
}
```

---

## 5) Error taxonomy (normalized)

All broker-mediated tools must emit normalized, grouped error codes.

### Session

- `SESSION_DISCONNECTED`
- `UPSTREAM_NO_FRAMES`
- `BROKER_RECOVERING`

### Input

- `FRAME_STALE`
- `INPUT_ACK_TIMEOUT`
- `EFFECT_NOT_VERIFIED`
- `UNSUPPORTED_POSTCONDITION_TYPE`

### Lease

- `LEASE_REQUIRED`
- `LEASE_DENIED`
- `LEASE_PREEMPTED`
- `LEASE_EXPIRED`

### Auth

- `UNAUTHORIZED`
- `FORBIDDEN`

### Replay/subscription

- `CURSOR_TOO_OLD`
- `SUBSCRIPTION_NOT_FOUND`
- `IDEMPOTENCY_CONFLICT`

### Producer

- `DUPLICATE_PRODUCER_REJECTED`

### Subscriber

- `SUBSCRIBER_LAGGING`

Rules:

- State-changing tools reject if no valid lease (`LEASE_REQUIRED`).
- State-changing tools reject if `based_on_frame_seq` fails freshness/material-change checks (`FRAME_STALE`).
- Unsupported postcondition types return `UNSUPPORTED_POSTCONDITION_TYPE`.
- Supported postconditions that fail within SLA return `EFFECT_NOT_VERIFIED`.

---

## 6) Security and access control (required before Phase B1)

### 6.1 AuthN/AuthZ

- Session-level authorization token mandatory for every subscriber.
- Role split: `read_only` vs `input_control`.
- Per-tool permission checks enforce role and lease requirements.

### 6.2 Tenant isolation

- Strict tenant/session partitioning in broker routing tables.
- No cross-session frame/event/log visibility.

### 6.3 Data handling and retention

- Frame/log retention defaults: short TTL in memory; persisted replay log policy explicitly configured.
- Secrets redaction pipeline for logs before fanout and persistence.
- Audit trail for every subscriber connect/disconnect and every state-changing tool call.

### 6.4 Inference-provider exposure

- Explicit policy flag per deployment for whether screenshots may be sent to third-party inference providers.
- Provider routing logged in audit events.

---

## 7) Failure model and expected behavior matrix

| Failure mode | Detection signal | Expected behavior | Client-visible error/state | Recovery target |
|---|---|---|---|---|
| Broker restart | broker heartbeat loss | Enter recovering; invalidate active leases; reject state-changing actions; require lease reacquire after resume | `BROKER_RECOVERING` | RTO ≤ 30s |
| Upstream WebRTC disconnect | no frames + peer disconnected | Freeze input, keep observation state flagged stale | `UPSTREAM_NO_FRAMES` | reconnect ≤ 15s |
| Subscriber reconnect | subscriber socket drop | Resume via resume token + event cursor | transient degraded health | resume ≤ 5s |
| Slow subscriber lag | lag_ms / queue depth threshold | Drop-old-frame policy per subscriber; protect upstream | `SUBSCRIBER_LAGGING` | no upstream impact |
| Worker crash | lifecycle crash event / disconnect | Require disruption ack before new input | lifecycle `crashed` + gated input | explicit operator/agent ack |
| Duplicate upstream attach | fencing conflict | reject stale/second producer; emit audit event | `DUPLICATE_PRODUCER_REJECTED` | immediate |
| Frame sequence gaps | non-monotonic or gap above threshold | Mark stale; require re-observe/re-locate for input | `FRAME_STALE` | next fresh sequence |
| Clock skew | ts sanity checks fail | staleness decisions rely on monotonic `frame_seq` as source-of-truth; timestamps are advisory/diagnostic only | health warning | bounded by seq checks |
| Human takeover mid-action | human input event + preemption policy | preempt/expire agent lease as configured | `LEASE_PREEMPTED` | immediate |
| Inference outage | backend error budget exceeded | fallback to cheap diff path or unverified locate mode | `EFFECT_NOT_VERIFIED`/backend error | fallback < 2s |
| Bad model coordinates | postcondition fails repeatedly | quarantine result; force re-locate or human assist path | `EFFECT_NOT_VERIFIED` | bounded retries |

---

## 8) Freshness semantics by tool

| Tool / operation | Max frame age |
|---|---|
| `synthi_screenshot` | 1000 ms |
| `describe` | 2000 ms |
| `locate` for observation | 1000 ms |
| `locate` before input | 500 ms |
| `click`/`type`/`drag` | must include fresh `based_on_frame_seq` + valid lease |

Additional rule for input (default invalidation policy; configurable):

- Cross-host staleness authority is `frame_seq` (not wall-clock) for distributed comparisons.

- frame age > 500ms, or
- viewport size or DPR changed, or
- `frame_seq` gap > 1 since locate frame, or
- ROI perceptual diff above configured threshold.

If any condition triggers, input is rejected and re-location is required.

---

## 9) Lease protocol (D0 minimum + D1 enhancements)

### 9.1 D0 minimal enforceable lease (required before input cutover)

- Fields: `lease_id`, `owner`, `scope`, `expires_at_ms`, `preemptible`, `reason`.
- `owner` is server-derived from authenticated principal; client-provided owner identity is rejected.
- Max lease duration: 15s default, renewable up to 60s total continuous ownership.
- Renewal must occur before expiry; otherwise lease auto-released.
- Client guidance: renew proactively at <=50% of lease TTL remaining (or at least 2s before expiry for short leases).
- Server policy for in-flight edge: requests received with lease-expiry delta <=100ms MAY be accepted via a bounded grace window **only if** request ingestion timestamp is before expiry; otherwise return `LEASE_EXPIRED`.
- State-changing calls without active matching-scope lease are rejected.

### 9.2 D1 advanced lease behavior (post-cutover hardening)

- Priority classes (`normal`, `urgent_human_override`).
- Fairness queue and starvation bounds.
- Reentrant lease semantics per owner.
- Forced release API with auditable reason.
- Lease-loss notifications to subscribers and in event log.
- Optional action batching under a lease window.

---

## 10) Metrics and SLO acceptance gates

| Area | Target |
|---|---|
| Input ack timeout rate | < 0.5% |
| Fresh screenshot age | p95 < 750 ms |
| Broker fanout latency | p95 < 150 ms |
| Locate cache hit latency | p95 < 300 ms |
| Duplicate inference reduction (3-agent sessions) | > 60% |
| Subscriber frame drops | reported per subscriber; alert at > 5%/5min |
| Broker recovery time (restart) | p95 < 30s |
| Input postcondition verification success | > 98% in canary suites |

No phase exits without measured pass against its mapped SLOs.

---

## 11) Rollout controls (canary + rollback)

- Feature flag per session for broker routing.
- Shadow broker mode (read-only mirror, no control) before cutover.
- Dual-read screenshot comparison (direct vs broker) on canary sessions.
- Canary progression: internal sessions → selected external low-risk sessions → general rollout.
- Kill switch: immediate per-session fallback to direct attach.
- Compatibility matrix maintained for older MCP clients.

---

## 12) Test plan (required scenarios)

Minimum acceptance tests before broad rollout:

1. Two agents attempt conflicting clicks concurrently.
2. Human interrupts while agent is typing.
3. Broker restarts during `wait`.
4. Stale frame detected just before click.
5. Subscriber falls 10s behind and recovers.
6. Inference cache returns old locate; system rejects stale-based input.
7. Upstream reconnect with changed viewport/dpr.
8. Event replay reconstructs a failed action timeline end-to-end.
9. Five agents observe one session for 30 minutes (soak).

Each test must assert error taxonomy consistency and correlation IDs in logs.

---

## 13) Event replay and traceability

Minimum traceability/replay is required in **Phase B0.5** (before B1 input cutover):

- Replay cursor model for resume/replay of recent history.
- Correlation IDs on every tool call and ack chain.

Phase B2 then extends this with long-horizon replay retention, richer queryability, and observability hardening.

Every state-changing call must record:

- `tool_call_id`
- `session_id`
- `agent_id`
- `frame_seq`
- `lease_id`
- `input_ack_id`
- timestamps: `received_at`, `dispatched_at`, `browser_acked_at`, `verified_at`

---

## 14) Shared inference sequencing (cost-aware)

Phase C starts with cheap mechanisms first, and all diff/vision work runs off the broker main event loop via a bounded worker pool to protect fanout latency SLOs:

1. Frame sequence/timestamp checks.
2. Perceptual hash / pixel-diff.
3. ROI diff around target.
4. Model-based scene change only when uncertainty remains.

Do not spend model budget where deterministic image-diff primitives are sufficient.

---

## 15) Revised phased rollout order

### Phase A: Foundation hardening

- Ack levels (`transport_ack`, `browser_ack`, `effect_verified`), freshness rules, health contract, error taxonomy.

### Phase B0: Broker read-only fanout

- Broker serves screenshot/wait/health/events only.
- Shadow + dual-read validation in canaries.

### Phase B0.5: Minimal traceability + replay cursor

- Correlation IDs, frame-seq and lease-id logging, ack timestamps, replay cursor, failed-action timeline (short horizon).
- Required before B1 input cutover.

### Phase D0: Minimal enforced lease

- Server-enforced lease protocol live for state-changing calls.

### Phase B1: Broker input cutover

- State-changing input routed through broker only after D0 pass + rollback controls live.

### Phase B2: Long-horizon replay + observability hardening

- Replay retention hardening, restart recovery drills, full dashboard coverage, richer postmortem query workflows.

### Phase C: Shared frame cache + cheap visual dedupe

- Cache and deterministic diffs first.

### Phase C2: Shared model inference + cost controls

- Introduce model-backed inference where deterministic checks are insufficient.

### Phase D1: Advanced arbitration and disruption workflow

- Human preemption policy refinements, fairness/starvation controls, deterministic postmortem workflows.

---

## 16) Exit criteria by phase

- **A exit:** normalized errors emitted; ack chain complete; freshness gates enforced for all relevant tools.
- **B0 exit:** broker read-only parity with direct path in canary dual-read checks.
- **B0.5 exit:** replay cursor, correlation IDs, frame_seq/lease_id logging, ack timestamps, resume test, and failed-action timeline reconstruction pass.
- **D0 exit:** zero state-changing actions accepted without valid lease.
- **B1 exit:** broker input cutover passes conflict/human-interrupt/stale-frame tests.
- **B2 exit:** restart + replay tests meet RTO/SLO targets.
- **C/C2 exit:** duplicate inference reduction and latency/cost targets met.
- **D1 exit:** fairness/preemption/starvation tests pass with no regressions.

---

## 17) Bottom line

The brokered architecture remains the right direction. The safe path is:

- read-only broker first,
- enforce leases before input cutover,
- ship measurable SLO gates,
- include security, failure matrix, replayability, canary controls, and hard rollback,
- then layer shared inference in cost-aware order.

This document is intended to be implementation-grade, not just directional.


---

## 18) Stream semantics and ordering guarantees

### 18.1 Event model

- **Control stream (ordered, replayable):** lifecycle, input/ack, lease, health transitions, security/audit markers.
- **Frame stream (high-throughput, lossy):** frame metadata + payload references.
- Frame metadata may carry both `event_id` and `frame_seq`; dedupe prefers `session_id+event_id` when present, otherwise `session_id+frame_seq`.

### 18.2 Ordering guarantees

- Total order per session for **control events** via monotonic `event_id`.
- Frame payload delivery is best-effort; frame metadata carries monotonic `frame_seq`.
- Lifecycle can arrive after newer frames; clients must treat lifecycle as authoritative for control state but not as a frame-order anchor.

### 18.3 Delivery and dedupe

- Control events: **at-least-once** delivery with replay support.
- Frame payloads: **drop-old/best-effort** per subscriber queue policy.
- Dedupe key: `session_id + event_id` (control), `session_id + frame_seq` (frame metadata).

### 18.4 Gap handling

- If control-event gap detected, client must `resume` from last seen `event_id`.
- If frame-seq gap crosses configured threshold, any pending input becomes invalid until re-observe/re-locate.

---

## 19) Broker API contracts (request/response + idempotency)

All mutating requests require the common envelope fields:

- `protocol_version`
- `request_id` (client-generated correlation id)
- `idempotency_key` (retry safety key)

Examples below include these fields explicitly.



Idempotency policy:

- Scope: `auth_principal + endpoint + session_id`.
- Payload mismatch with same key returns `IDEMPOTENCY_CONFLICT`.
- Retention: idempotency records kept for 15 minutes (configurable).
### 19.1 subscribe

Request: `{protocol_version, request_id, idempotency_key, session_id, topics:[...], cursor?}`
Response: `{subscription_id, accepted_topics, replay_start_event_id}`
Errors: `SESSION_DISCONNECTED`, `BROKER_RECOVERING`, `UNAUTHORIZED`, `FORBIDDEN`, `CURSOR_TOO_OLD`.
Idempotency: same `idempotency_key` returns same `subscription_id` if still active.

### 19.2 unsubscribe

Request: `{protocol_version, request_id, idempotency_key, subscription_id}`
Response: `{ok:true}`
Errors: `SUBSCRIPTION_NOT_FOUND` (idempotent success semantics allowed).

### 19.3 resume

Request: `{protocol_version, request_id, idempotency_key, subscription_id, last_seen_event_id}`
Response: `{resumed_from_event_id, gap_detected:boolean}`
Errors: `CURSOR_TOO_OLD` (client must full-resync).

### 19.4 acquire_lease

Request: `{protocol_version, request_id, idempotency_key, session_id, scope, lease_ms, reason, preemptible}` (`owner` is derived server-side from auth principal)
Response: `{lease_id, expires_at_ms}`
Errors: `LEASE_DENIED`, `UNAUTHORIZED`, `BROKER_RECOVERING`.
Idempotency: retries with same key return same active lease grant when possible.

### 19.5 renew_lease

Request: `{protocol_version, request_id, idempotency_key, lease_id, extend_ms}`
Response: `{lease_id, expires_at_ms}`
Errors: `LEASE_PREEMPTED`, `LEASE_EXPIRED`.
Race rule: renew after expiry fails deterministically with `LEASE_EXPIRED`.

### 19.6 release_lease

Request: `{protocol_version, request_id, idempotency_key, lease_id}`
Response: `{released:true|false, reason}`
Idempotency: release-after-expiry returns `{released:false, reason:"already_expired"}` (not error).

### 19.7 force_release_lease (admin)

Request: `{protocol_version, request_id, idempotency_key, lease_id, reason}`
Response: `{released:true, forced_by}`
Errors: `FORBIDDEN` for non-admin.

### 19.8 replay

Request: `{protocol_version, request_id, idempotency_key, session_id, from_event_id, to_event_id?, limit}`
Response: `{events:[...], next_event_id?}` (max `limit=500` per call; redacted fields omitted per role policy).
Errors: `CURSOR_TOO_OLD`, `FORBIDDEN`, `BROKER_RECOVERING`.

### 19.9 health pull + push

- Pull endpoint: `get_health(session_id, subscriber_id?)`.
- If caller is a subscriber, `subscriber_id` is derived from auth context (client-supplied value ignored).
- If caller is admin and `subscriber_id` omitted, return aggregate + per-subscriber summary.
- Push topic: `health_updates` emits only state changes.
- Same envelope shape for pull and push.

### 19.10 fallback / kill-switch control

Request: `{protocol_version, request_id, idempotency_key, session_id, mode, reason}` where `mode ∈ {broker_read_only_fallback, direct_attach_single_agent_only, input_disabled_fallback, full_direct_attach}`.
Response: `{applied_mode, producer_epoch, safety_checks_passed}`.
`full_direct_attach` is rejected unless broker producer teardown confirmation is true.

### 19.11 dispatch_input

Request: `{protocol_version, request_id, idempotency_key, session_id, lease_id, based_on_frame_seq, action, postcondition?, timeout_ms?}`
Response: `{transport_ack, browser_ack?, effect_verified?, unverified?, ack_chain, final_frame_seq?}`
Execution rule: postcondition verification is asynchronous; broker ingress/fanout/event-loop threads must not block on verifier execution.
Errors: `LEASE_REQUIRED`, `LEASE_EXPIRED`, `LEASE_PREEMPTED`, `FRAME_STALE`, `INPUT_ACK_TIMEOUT`, `EFFECT_NOT_VERIFIED`, `UNSUPPORTED_POSTCONDITION_TYPE`, `BROKER_RECOVERING`, `UNAUTHORIZED`, `FORBIDDEN`.

---

## 20) Duplicate producer fencing (deterministic)

Add producer-fencing fields to upstream attach state:

- `producer_id`
- `producer_epoch` (monotonic per session)
- `fencing_token` (opaque capability)

Rules:

1. Only current `(producer_id, producer_epoch, fencing_token)` may write upstream media/control.
2. Stale producer writes are rejected deterministically with `DUPLICATE_PRODUCER_REJECTED`.
3. Duplicate attach attempt never maps to `BROKER_RECOVERING`; it is a policy/fencing violation.
4. Every rejection emits an auditable control event with actor identity.

---

## 21) Postcondition classes and verifier ownership

Allowed postcondition types:

1. **DOM-based** (when runtime exposes structure) — verifier: runtime adapter.
2. **Pixel/vision-based** — verifier: broker vision module.
3. **URL/location-based** — verifier: runtime/navigation adapter.
4. **Lifecycle/event-based** — verifier: control-event stream evaluator.
5. **Custom app signal** (stdout/log markers) — verifier: log/event matcher.

Rules:

- If requested postcondition type is unsupported for the current session capability profile, return `UNSUPPORTED_POSTCONDITION_TYPE`.
- State-changing actions without postcondition return explicit `unverified:true` in response.

---

## 22) Security hardening details + permission matrix

### 22.1 Token/service security requirements

- Token format: JWT or equivalent signed bearer token.
- Validate `iss`, `aud`, `exp`, and signature on every request.
- Token expiry enforced server-side; revoked tokens denied immediately.
- Service-to-service auth required between broker and downstream services.
- TLS required in transit; replay logs encrypted at rest.
- Audit log immutability required (append-only with integrity checks).
- Redaction failure behavior: fail closed for persistence; emit security alert.

### 22.2 Capability permission matrix

| Capability | read_only | input_control | admin |
|---|---|---|---|
| Subscribe frames | yes | yes | yes |
| Subscribe logs | limited | limited | yes |
| Acquire lease | no | yes | yes |
| Renew/release own lease | no | yes | yes |
| Force release lease | no | no | yes |
| Invoke state-changing input | no | yes (with valid lease) | yes (with valid lease or audited force-acquire) |
| Replay persisted logs | no | limited (own session scope) | yes |
| Toggle fallback mode | no | no | yes |

---

## 23) SLO metric definitions (unambiguous)

For each SLO metric, define: `name`, `numerator`, `denominator`, `start_ts`, `end_ts`, `exclusions`, `window`, `owner`, `alert_threshold`.

### 23.1 broker_fanout_latency_p95

- Numerator: per-event `(subscriber_emit_ts - ingest_ts)` samples for control + frame metadata events.
- Denominator: total delivered events in window.
- Exclusions: sessions in `BROKER_RECOVERING` state.
- Window: 5m rolling; Owner: Broker team; Alert: p95 > 150ms for 3 windows.

### 23.2 screenshot_age_p95

- Numerator: `(tool_response_ts - frame_ts_of_returned_image)`.
- Denominator: successful screenshot responses.
- Exclusions: explicit stale-test scenarios in canary suites.
- Window: 5m; Alert: p95 > 750ms.

### 23.3 input_ack_timeout_rate

- Numerator: input calls lacking browser_ack within SLA.
- Denominator: total state-changing input calls.
- Window: 15m; Alert: >0.5%.

### 23.4 input_postcondition_success_rate

- Numerator: state-changing calls with `effect_verified=true`.
- Denominator: state-changing calls that supplied a supported postcondition.
- Exclusions: known app-bug-tagged runs (tracked separately).
- Window: 1h; Alert: <98%.

### 23.5 duplicate_inference_reduction

- Baseline: direct-attach 3-agent canary median inference calls per minute over matched scenario.
- Numerator: baseline calls - broker calls.
- Denominator: baseline calls.
- Window: daily canary comparison; Alert: <60% reduction.



### 23.6 locate_cache_hit_latency_p95

- Numerator: `(locate_response_ts - locate_request_ts)` for cache-hit locate responses.
- Denominator: total cache-hit locate responses.
- Exclusions: cache-disabled experiments.
- Window: 5m; Alert: p95 > 300ms.

### 23.7 subscriber_frame_drop_rate

- Numerator: dropped frames per subscriber in window.
- Denominator: frames offered to that subscriber in window.
- Exclusions: subscribers explicitly marked paused.
- Window: 5m; Alert: >5% for 5m.

### 23.8 broker_recovery_time_p95

- Numerator: `(broker_ready_ts - recovery_start_ts)` per recovery incident.
- Denominator: recovery incidents in window.
- Exclusions: planned maintenance windows with approved override.
- Window: daily; Alert: p95 > 30s.
---

## 24) Replay/traceability minimum moved before input cutover

**Mandatory by end of B0/D0 (before B1 input cutover):**

- Correlation IDs on every tool call.
- Frame sequence logging for every input decision.
- Lease ID logging for every state-changing request.
- Ack timestamps (`received_at`, `dispatched_at`, `browser_acked_at`, `verified_at|unverified_at`).
- Replay cursor (`last_event_id`) support for resume/replay.
- Failed-action timeline reconstruction for the last N minutes.

B2 then adds long-horizon replay, retention tuning, and richer postmortem tooling.

---

## 25) Rollback modes with invariant-safe fencing

Supported fallback modes:

1. `broker_read_only_fallback`
2. `direct_attach_single_agent_only`
3. `input_disabled_fallback`
4. `full_direct_attach`

Safety rules:

- `full_direct_attach` allowed only after broker producer teardown is confirmed and fencing epoch advanced.
- During any fallback, invariant "at most one active upstream producer" must remain true.
- Fallback transitions emit auditable lifecycle events with operator identity.

---

## 26) Additional required tests before production-ready

Add these scenarios to §12 acceptance suite:

1. Lease acquire retry storm (idempotency correctness).
2. Broker restart while lease is held.
3. Token revoked during active subscription.
4. Replay-log redaction failure behavior.
5. Duplicate producer race with fencing enforcement.
6. Clock skew + reconnect sequence-gap handling.
7. Stale inference result with same prompt but changed DPR.
8. Client reconnect after missed lease-loss notification.
9. Fallback broker→direct attach during input-disabled state.

No production-ready signoff without pass on these tests.
