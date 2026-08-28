# Channel Modes — Tradeoff Guide for Session-Type Selection

Status: proposal (design only, no code)
Companion to: `docs/REGISTERED_DIRECT_CHANNELS_DESIGN.md`

## 1. Why This Exists

When creating an agent session (or configuring a project's coordination
policy), operators choose how agents may communicate. The choice is a
tradeoff between **security/auditability** and **speed/flexibility**. This
document defines the modes and the guidance surfaced in the UI so the person
clicking "create session" understands what they're trading.

Enterprise deployments (regulated repos, compliance requirements) should
prefer the stricter end; small teams prototyping fast should prefer the
looser end. The system must make the tradeoff explicit at selection time —
not buried in docs.

## 2. The Four Channel Modes

### Mode 1: `mediated_only` (most secure, slowest)
- All messages flow through the control plane; every payload is persisted as
  events with digests.
- No direct transport is ever opened. Direct-channel requests are refused.
- **Auditability:** complete — every message is a queryable event.
- **Latency:** highest (HTTP + DB round-trip per message).
- **Best for:** regulated enterprises, class-A/B airspace projects, any
  environment where message content itself must be auditable or discoverable.
- **UI hint text:** *"Every agent message is recorded and auditable. Slowest
  option. Choose for regulated/compliance workloads."*

### Mode 2: `registered_direct` (balanced — the design default)
- Pairwise direct channels allowed, but only via the governed handshake:
  control-plane authorization, capability checks, HMAC-signed frames,
  lifecycle events with summary digests. Payloads are ephemeral.
- **Auditability:** strong — who talked to whom, when, how long, transcript
  digest; but not per-message content.
- **Latency:** low once the channel is open (direct WebSocket).
- **Best for:** most teams. Fast negotiation without losing oversight of the
  social graph and outcomes.
- **UI hint text:** *"Agents negotiate directly after a governed handshake.
  Who-talked-to-whom is audited; message contents are not stored. Balanced
  speed and oversight."*

### Mode 3: `direct_preferred` (fast, lighter audit)
- Like Mode 2 but agents MAY auto-open channels when tower signals indicate
  route intersection, without a per-channel human-visible prompt. Control
  plane still logs opens/closes and enforces caps/tokens.
- **Auditability:** moderate — lifecycle logged, contents ephemeral, and
  channel frequency can spike (noisy for auditors).
- **Latency:** lowest for negotiation-heavy workflows.
- **Best for:** small teams, high-trust internal environments, rapid
  prototyping where iteration speed dominates.
- **UI hint text:** *"Agents open channels automatically when working on
  overlapping routes. Fastest collaboration; produces more traffic to audit
  after the fact."*

### Mode 4: `open_local` (development only)
- For local/dev stacks: same frame guards as other modes (MAC verification,
  replay windows, sequence enforcement stay ON — they cost nothing and keep
  the protocol honest); what is relaxed is policy: localhost endpoint refs
  are accepted without allowlist checks, and violation reporting is advisory.
- Never valid in production: the control plane refuses this mode whenever
  `NODE_ENV=production` (hard gate, not config).
- **Best for:** hacking on the protocol itself, demos, local proof scripts.
- **UI hint text:** *"Dev only. Minimal guards so you can experiment with the
  protocol. Automatically disabled in production builds."*

## 3. Selection Matrix (surfaced in the UI)

| You care about… | Pick |
|---|---|
| Compliance, message-level audit | `mediated_only` |
| Speed + oversight balance (default) | `registered_direct` |
| Raw iteration speed, small team | `direct_preferred` |
| Local dev / protocol hacking | `open_local` |

Additional UI elements at selection time:
- A one-line tradeoff sentence per mode (the hint texts above).
- A warning badge if the project contains class-A/B airspace zones while a
  mode below `mediated_only` is chosen ("restricted airspace + ephemeral
  channels may conflict with your governance policy").
- An env-level floor: `SYNTHI_CODESITE_MIN_CHANNEL_MODE` can forbid weaker
  modes workspace-wide regardless of UI selection (enterprise admins pin the
  floor; the UI greys out disallowed options rather than letting users pick
  something that will be rejected).

## 5. Where This Appears in the UI

**Implemented placement:** the mode is chosen at **project creation time**
(the "How should agents in this project coordinate?" picker on the CodeSite
setup card). It is a project-level policy: every agent session attached to
that project inherits it, and the control plane enforces it at channel
request time regardless of where the request originates (UI button, agent,
or API).

The original plan below describes attach-time selection for per-session
overrides; that remains future work. The project-level picker ships today.

### Original plan (per-session selection)

The selection happens at **agent session attach time** — the moment a user
connects a Codex/Claude instance to a project. Today that flow collects:
owner, collaboration session, terminal session, provider, provider session
ref, callsign, capabilities, and subscriptions
(`backend/collab-server/agentSessionAttachService.js` → control-plane
`attachAgentSession`). The channel mode choice joins this exact step.

### 5.1 Placement

In the attach form/flow, immediately after the agent-type/provider picker and
before the capability list, render a **"Coordination mode"** radio group with
the four modes from §2. Default: `registered_direct`.

### 5.2 Per-option explainer card (what the user sees)

Each radio option renders as an expandable card containing:

| Element | Content |
|---|---|
| Mode name + icon | e.g. 🛡️ Mediated only / ⚖️ Registered direct / ⚡ Direct preferred / 🧪 Open local |
| One-liner | The §2 hint text verbatim ("Every agent message is recorded…") |
| Speed meter | 1–4 dots visualizing relative latency (mediated=1 … direct_preferred=4) |
| Audit meter | 1–4 dots visualizing relative auditability (mediated=4 … direct=1) |
| "Best for" line | The §2 best-for sentence, personalized where possible |

**Personalization rule:** if the project's zone policy contains class-A/B
zones, the cards for modes below `mediated_only` additionally render:
*"⚠️ This project includes restricted airspace. Messages in these zones are
governed regardless of mode; mediated_only gives full message audit."* If the
workspace has fewer than 3 members, append to fast modes: *"Small team —
speed-focused mode fits."*

### 5.3 Presets by team profile (quick-pick chips)

Above the radios, three one-click presets set expectations by audience:

| Chip | Sets mode | Caption |
|---|---|---|
| 🏢 Enterprise | `mediated_only` | "Full message audit. Compliance-first. Slowest." |
| 👥 Team (default) | `registered_direct` | "Fast negotiation, governed handshake." |
| 🚀 Solo / Prototype | `direct_preferred` | "Maximum speed. Lightest audit."

### 5.4 Enforcement surfacing

- If a workspace floor (`SYNTHI_CODESITE_MIN_CHANNEL_MODE`) forbids the
  selected mode, the weaker options render greyed-out with the reason
  ("Pinned by workspace policy") rather than letting the user pick something
  that will be rejected server-side.
- After attach, the chosen mode is displayed on the session card in the Live
  tab (small badge next to callsign), so operators can see at a glance what
  guarantees each connected agent operates under.

### 5.5 Copy deck (exact strings for implementation)

- Section title: **"How should agents in this project coordinate?"**
- Subtitle: *"This trades speed against auditability. You can change it per
  project later; existing channels keep their guarantees."*
- Learn-more link target: this document.

For `direct_preferred`, auto-open is capability-gated on
`codesite.channels.open` for both peers and records `channel_auto_opened`
audit events.

## 6. Interaction With Existing Gates

- Mode never bypasses identity/capability/membership checks — those apply in
  all modes.
- Zone rules compose: class-A/B negotiations require permits even in
  `direct_preferred`.
- The kill switch (`SYNTHI_CODESITE_CHANNELS_DISABLED`) overrides everything.

## 7. Rollout

Phase 1 of the channels design ships with mode plumbing: the project record
gains a `channelMode` field (default `registered_direct`), the API validates
requested transports against it, and the session/project creation UI shows
this guide's selection matrix. Later phases inherit the mode automatically.
