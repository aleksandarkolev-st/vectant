# Registered Direct Channels — Agent-to-Agent Negotiation Design

Status: proposal (not implemented)
Workstream: future extension of CodeSite coordination
Related: `docs/MULTI_HUMAN_MULTI_AGENT_SHARED_SESSION_PROOF_PLAN.md`, delivery security (`synthi/src/lib/codesite/deliverySecurity.js`), peer roster (`peerAgents` briefing section)

## 1. Problem & Motivation

Today, all agent-to-agent coordination flows through the CodeSite control
plane. This is deliberate:

- every interaction lands in the causal event timeline (auditable, digestible);
- identity, capability checks, and trust are enforced centrally;
- recognition is provider-agnostic and survives process churn.

The cost of mediation is latency and bandwidth: an interactive negotiation
(two agents iteratively negotiating a shared patch) would round-trip through
HTTP + Postgres for every message. For high-volume, low-latency exchange
(streaming partial diffs, joint planning), a direct pipe between the two
agent processes is materially faster.

**Goal:** allow two attached agents on the same project to open a direct,
high-bandwidth channel for real-time negotiation — without giving up the
audit trail, identity guarantees, or policy gates that make CodeSite safe.

**Non-goal:** free-form peer-to-peer mesh networking. All channels are
announced, governed, and logged. There is no unmanaged side channel.

## 2. Design Principles

1. **Governed handshake, fast pipe.** The control plane authorizes and logs
   channel establishment; the data plane runs directly between agents.
2. **No new identity system.** Channels reuse existing `csa_` scoped tokens,
   capabilities, and session bindings.
3. **Everything important is an event.** Open/close/summary are causal events;
   only ephemeral message payloads bypass the DB.
4. **Fail closed.** Unknown endpoints, non-allowlisted transports, or missing
   capabilities refuse the channel.
5. **Provider-agnostic.** The protocol speaks plain JSON over WebSocket or
   HTTP SSE; no vendor-native coupling.

## 3. Architecture Overview

```
Agent A (codex)                Control Plane                 Agent B (claude)
    |                              |                              |
    |-- POST /channels/request --->|                              |
    |   (toSession, purpose,       |-- policy gate:               |
    |    transport, endpointRef)   |   caps, routes, leases        |
    |                              |-- event: channel_requested -->|
    |                              |                              |
    |<--- channel_granted ---------+-- POST /channels/accept -----|
    |  {channelId, token, peers}   |<-- event: channel_accepted ---+
    |                              |                              |
    |<========= direct WebSocket/SSE transport ===================>|
    |   signed frames, ephemeral                                   |
    |                                                              |
    |-- POST /channels/close ------>|-- event: channel_closed -----|
    |   (summaryDigest, msgCount)  |                              |
```

- **Control plane**: authorizes, mints a short-lived channel token, records
  events, stores the channel record.
- **Data plane**: direct WebSocket (preferred) or SSE between the two agent
  processes at endpoints they advertise. Frames are HMAC-signed with the
  channel token; payloads are ephemeral and never persisted by CodeSite.

## 4. Data Model (Prisma additions)

```prisma
model CodeSiteAgentChannel {
  id               String   @id @default(cuid())
  projectId        String
  workspaceSlug    String
  fromSessionId    String
  toSessionId      String
  status           String   // requested | active | closed | rejected | expired
  purpose          String   // e.g. "patch_negotiation"
  transport        String   // "websocket" | "sse"
  endpointRef      String?  // advertised ws:// host:port of the responder
  channelTokenHash String   // hash of the minted channel token
  maxDurationMs    Int?
  openedAt         DateTime?
  closedAt         DateTime?
  summaryDigest    String?
  messageCount     Int      @default(0)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@index([projectId, status])
}
```

New event types (added to `CODE_SITE_EVENT_TYPES` in `policy.js`):
`channel_requested`, `channel_accepted`, `channel_rejected`,
`channel_closed`, `channel_violation`.

## 5. API Surface

All under `/api/workspace/[slug]/codesite/...`, agent-token authenticated via
the same `requireAgentTokenAuthority` path used by plans/transactions.

| Endpoint | Actor | Purpose |
|---|---|---|
| `POST agent-sessions/{id}/channels` | initiator | Request a channel: `{toSessionId, purpose, transport, endpointRef?, maxDurationMs?}` → 201 + channel record + one-time grant token for the responder |
| `POST agent-sessions/{id}/channels/{ch}/accept` | responder | Accept: advertises own `endpointRef`, activates the channel |
| `POST agent-sessions/{id}/channels/{ch}/reject` | responder | Reject with reason code |
| `POST agent-sessions/{id}/channels/{ch}/close` | either | Close with summary digest + message count |
| `GET projects/{pid}/channels?status=active` | members | Audit view of live/historical channels |

## 6. Policy Gates (control plane, at request time)

A channel is granted only if ALL hold:

1. **Capability**: both sessions hold `codesite.channels.open`.
2. **Membership & liveness**: both attached, tokens fresh (heartbeat gate).
3. **Route relevance** (optional tightening): the purpose references paths in
   both agents' plans/routes — prevents random cross-project chatter.
4. **Lease awareness**: if either agent holds an active mutation lease whose
   route intersects the other's, the channel may be flagged
   `negotiation_required` in tower instructions (ties into collision forecast).
5. **Zone rules**: class-A/B airspace negotiations require a governance permit
   (same gate as destructive mutations).
6. **Concurrency cap**: per-session limit (default 3 active channels) to
   prevent resource exhaustion; configurable via env
   `SYNTHI_CODESITE_MAX_ACTIVE_CHANNELS`.

Rejection emits `channel_rejected` with structured reason codes so agents can
adapt (e.g., fall back to mediated inbox messages).

## 7. Channel Token & Frame Security

- On acceptance, the control plane mints a **channel token**
  (`csc_<random>`), stores only its hash, and delivers it once to each side
  inside the accept response (over the already-authenticated API path).
- Every frame carries `ts`, `seq`, and `hmac(channelToken, ts|seq|payload)`.
  Receivers reject frames older than a replay window (default 30s) or with a
  bad MAC — mirrors the outbound-delivery signing scheme already shipped.
- Tokens expire with the channel (`maxDurationMs`, hard cap 30 min). Closing
  invalidates immediately; the close event records `summaryDigest` =
  SHA-256 over the transcript hash chain both sides maintained, so any later
  dispute about what was said can be checked against the digest without
  storing payloads.

## 8. Transport Contract

WebSocket preferred; SSE fallback. Frame envelope:

```json
{
  "v": 1,
  "type": "offer" | "counter" | "diff_chunk" | "ack" | "note" | "ping" | "close",
  "ts": "<iso>",
  "seq": 42,
  "mac": "<hex>",
  "payload": { }
}
```

- Payloads are opaque to CodeSite except `type`. Suggested conventions for
  patch negotiation (diff chunks reference the shadow merge patch-artifact
  schema) so a negotiated result can feed directly into
  `shadow-merge-simulate`.
- Either side may send `close`; both sides then call the control-plane close
  endpoint (first call wins, second is idempotent).

## 9. Observability & Abuse Controls

- Channel lifecycle events appear in the project timeline alongside everything
  else — the radar/tower UI can render live channels as connections between
  aircraft.
- `messageCount` and duration are recorded; a `channel_violation` event fires
  when the transport layer reports bad MACs/replay attempts (transport must
  self-report; the control plane cannot see frame contents).
- Rate limits reuse the existing `enforceRateLimit` buckets under a `channels`
  key.
- Kill switch: env `SYNTHI_CODESITE_CHANNELS_DISABLED=1` refuses all requests
  (default off until the feature ships).

## 10. Rollout Plan

1. **Phase 1 — records + events only** (no transport): API surface, Prisma
   model, policy gates, events. Agents can request/accept/close and the audit
   trail exists; data plane still mediated. Each piece its own commit.
2. **Phase 2 — WebSocket transport helper**: a small Node relay library in
   `synthi/scripts/` that two agent processes run to speak the framed protocol
   directly; MAC/replay logic unit-tested.
3. **Phase 3 — live proof script**: extend the fuzzer with channel scenarios
   (open/negotiate/close, tampered MAC rejected, expired token rejected,
   concurrency cap enforced); add §9-style canonical scenario with visual
   evidence.
4. **Phase 4 — UI**: tower radar shows live links; Analysis tab lists channel
   history with digests.

## 11. Explicitly Out of Scope

- Mesh/multi-party channels (only pairwise v1).
- Persisting message payloads.
- Cross-workspace or cross-project channels.
- Vendor-specific transport protocols.
