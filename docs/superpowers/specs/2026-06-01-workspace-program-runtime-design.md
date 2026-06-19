# Slice 3 (revised) — Workspace Program Runtime & Marketplace

**Date:** 2026-06-01
**Status:** Approved design direction, pending implementation plan
**Supersedes:** the original Roadmap **Slice 3 ("Workspace toolchains — Docker/K8s CLIs, devcontainers
spec inside workspace")** in `docs/superpowers/specs/2026-05-31-external-mcp-client-design.md`. That
one-line slice is replaced by this fuller design. The roadmap table in the Slice 1 doc is updated to
point here.
**Companion to:** `docs/AGENT_MCP_BROKER_ROLLOUT_PLAN.md` (the broker). This document does NOT fold
into the broker plan: the broker remains the safe visual/input transport; this layer owns marketplace
install, runtime lifecycle, program surfaces, and workspace UX.

---

## Context

Synthi's external-tool initiative spans four user-confirmed directions; the roadmap decomposes them
into 7 slices (see the Slice 1 design doc). This document covers the **"run toolchains in workspace"**
direction. Where Slice 1 lets the AI **call remote tools** (functions over MCP/HTTPS), this slice lets
users and the AI **run real programs inside the managed workspace** — web apps, CLIs, TUIs, GUI apps,
and Docker-like workloads — installed from a marketplace and launched into first-class docked tabs.

The ambition is a **Program Runtime**, not a prettier terminal: install → launch → a unified docked
tab with the app surface, logs, terminal, ports, health, and lifecycle controls.

### Relationship to the rest of the roadmap (no conflicts; one subsumption)

Reviewed against all 7 slices:

- **Slice 1 (External MCP client):** complementary, different plane. Slice 1 speaks MCP to *remote*
  servers from `synthi/`; this runtime spawns *local* processes from `collab-server`. This slice
  **reuses** Slice 1's foundation (see "Reuse" below). No function in Slice 1 is nullified.
- **Slice 2 (Git providers / OAuth / webhooks):** complementary. Running `git`/`gh` as a program
  performs some Git actions, but cannot replace provider OAuth APIs or **inbound webhooks**.
- **Slice 3 (Workspace toolchains):** **this document subsumes it.** Slice 3 becomes a strict subset.
- **Slice 4 (Deploy targets):** built **on** this runtime — `docker push`/`kubectl`/PaaS CLIs run as
  managed program sessions. See "Cross-slice reconciliation" for the credential nuance.
- **Slice 5 (Make Synthi drivable):** the optional `synthi_list_programs` / `synthi_launch_program` /
  `synthi_stop_program` MCP **tools belong to Slice 5's drivable MCP *server***, added there; the
  broker's existing tools handle visual observation/input. Additive to Slice 1's `ext_<i>` model.
- **Slice 6 (DAP/debugging):** orthogonal (own protocol + UX).
- **Slice 7 (Observability):** synergy — runtime events/quotas can feed OpenTelemetry export.

### Existing systems this slice builds on (verified)

- **collab-server** already provides terminal/headless **PTY** support, **port proxying** (incl.
  WebSocket/HMR), and the **Xvfb/GStreamer/WebRTC** path for GUI capture. This slice adds a
  `ProgramRuntimeManager` over those primitives rather than inventing new transports.
- **The broker** (`AGENT_MCP_BROKER_ROLLOUT_PLAN.md`) owns the visual session + human/agent input
  **lease/freshness** model. GUI programs route input through it; this slice does not duplicate it.
- **Frontend** docking window manager with `registerPanel()` + `IDE_PANEL` constants; Postgres+Prisma;
  the encrypted credential precedent reused/extended by Slice 1 (`EncryptedSecret` vault).
- **Slice 1 foundation (in progress on `tool-compatibility`):** `EncryptedSecret` vault (designed
  generic for exactly this), `WorkspaceMembership.role` (added in Slice 1 addendum R1), and the
  audit-table pattern (`McpCallAudit`).

## Goal

Let a workspace member install marketplace **programs** into a managed Synthi workspace, launch them
from the IDE, and interact with each launch in a unified docked tab (app surface + logs + terminal +
ports + health + lifecycle), with per-workspace install scope and permission consent.

## Non-Goals (explicitly out of this slice)

- Replacing the broker's visual transport (reused, not rebuilt).
- Replacing Open VSX **IDE extensions** — these are *runnable workspace programs*, a separate concept
  and a separate sidebar surface. Do not mix the two registries.
- Account/team-global installs in v1 (installs are **workspace-scoped**; promotion is later).
- Exposing the **host** Docker socket or any Synthi infrastructure runtime (see Security).
- Marketplace publishing/signing/reputation (deferred to the final rollout phase).
- Slice 1's remote MCP tool-calling (separate slice; this is local execution).

## Success Criteria

1. A workspace member can browse a **Programs** sidebar (Marketplace / Installed / Running / Recent),
   install a program (workspace-scoped, after permission consent), and launch it.
2. A launch opens **one unified docked program tab by default**, keyed by `programSessionId`, showing
   the primary surface (iframe for web ports, video stream for GUI, xterm for TUI/CLI, logs for
   background services) plus App / Logs / Terminal / Ports / Health / Settings.
3. Multiple programs can run at once, each with its own tab; tab chrome offers stop, restart,
   float, popout, copy-URL, attach-shell, clear-logs.
4. Process state is always visible: `installing | starting | running | unhealthy | stopped | crashed`.
5. Installs/recent sessions persist in Postgres; only transient stream/socket details stay in memory.
6. Programs can read/write **workspace files** and use **declared** ports/network, and are denied
   Synthi platform/DB/GCS/K8s secrets and the host Docker socket (verified by a security test).
7. Quotas, idle culling, output limits, a kill switch, and audit events exist from day one.
8. All new code paths have unit/integration/security/UI/broker tests (see Test Plan).

---

## Architecture

### Component diagram

```
┌─ Frontend ───────────────────────────────┐      collab-server
│ Programs sidebar (Marketplace/Installed/  │   ┌──────────────────────────────┐
│   Running/Recent)                          │   │ ProgramRuntimeManager        │
│ Program panel — MULTI-tab (per session):   │◄─►│  install / launch / stop /   │
│   App | Logs | Terminal | Ports | Health   │ws │  restart / observe           │
│   | Settings   (float / popout / kill)     │   │   ├─ PTY (CLI/TUI)            │
└───────────────┬────────────────────────────┘   │   ├─ port proxy (web/HMR)    │
                │ /api/workspace/:slug/programs/*  │   └─ Xvfb/GStreamer/WebRTC   │
                ▼                                   │       → broker (lease/fresh) │
        Next.js API routes ──► Postgres (Prisma)    └──────────────┬───────────────┘
        (marketplace, install,   program models                    │ rootless/sidecar
         launch, session ctrl)                                     ▼ (NO host docker sock)
                                                          workspace-contained runtime
```

### Components

**a. `ProgramRuntimeManager` (collab-server).** Installs, launches, stops, restarts, and observes
workspace programs. Dispatches by `runtimeType`:
- **CLI/TUI** → reuse PTY.
- **web** → reuse port proxy (incl. WebSocket/HMR).
- **GUI** → reuse Xvfb/GStreamer/WebRTC, routing visual input through the **broker** lease/freshness
  model.
- **background service** → logs-only surface.
Persists installed programs + recent sessions in Postgres; keeps only transient stream/socket detail
in memory.

**b. Recipe manifest — `synthi.program.json`.** Declares: package id, install commands, launch
commands, `runtimeType`, working directory, env vars, ports, surfaces, health checks, resource hints,
permissions. (See "Cross-slice reconciliation R-1" re: also honoring the **devcontainer** standard.)

**c. Program model (Postgres/Prisma).** Marketplace package, version, install record, launch session,
permission grant, runtime event. (Sketch in Data Model.)

**d. Programs sidebar (frontend).** Separate from VS Code Extensions: Marketplace, Installed, Running,
Recent. Marketplace entries show verified/unverified, publisher, version, permissions, required
tools, exposed ports, last update.

**e. Unified program panel (frontend).** A new dockable panel type allowing **multiple tabs keyed by
`programSessionId`**. Primary surface first; compact sub-tabs/segmented control for App/Logs/Terminal/
Ports/Health/Settings; dense familiar controls. **Docking dedupe must special-case this type**
(see R-3).

**f. API surface (Next.js).** CRUD + lifecycle (see Public Interfaces).

### Data model (sketch — finalized in the implementation plan)

```
MarketplaceProgram   { id, packageId(unique), publisher, verified, latestVersion, ... }
ProgramVersion       { id, programId→, version, manifest(json), requiredTools[], ports[], ... }
ProgramInstall       { id, workspaceSlug, programId→, version, status, installedByUserId, grantId→, createdAt }
ProgramSession       { id, installId→, workspaceSlug, runtimeType, state, startedByUserId,
                       startedAt, endedAt, lastHealthState, lastHealthAt }   // state = the 8 events
PermissionGrant      { id, workspaceSlug, installId→, scopesJson, grantedByUserId, grantedAt }
ProgramRuntimeEvent  { id, sessionId→, type, dataJson(redacted), createdAt }  // append-only audit
```
Reuse Slice 1's `EncryptedSecret` for any program-supplied secrets (kubeconfig, registry creds, etc.).

---

## Security model

- **Trusted-workspace boundary only.** Programs are trusted with the user's **workspace files** and
  **declared** network/ports — NOT with Synthi infrastructure.
- **Hard secret denial.** Programs must never receive Synthi platform secrets, DB credentials, GCS
  credentials, Kubernetes credentials, or the **host Docker socket**. The launcher constructs a
  scrubbed env (denylist of platform vars) — verified by a security test.
- **Docker-like workloads** use a **workspace-contained rootless runtime or sidecar**, never the host
  runtime.
- **Consent before install/first launch.** Every package declares permissions + runtime requirements;
  consent is required and recorded as a `PermissionGrant`.
- **From day one:** quotas, idle culling, output/log size limits, a kill switch, and append-only
  audit events (`ProgramRuntimeEvent`).
- **Authorization** builds on `WorkspaceMembership.role` (from Slice 1 R1): install/uninstall/launch
  are workspace mutations → require role ∈ {owner, admin} (or a dedicated capability), while viewing
  Running/Recent is member-level. (Final matrix in the plan.)

---

## Cross-slice reconciliation (decisions to make deliberately)

These are the only friction points found in the all-slices review. None block Slice 1; all are
coordination items for this slice's implementation plan.

- **R-1 — Manifest vs the open-protocols ethos.** The whole initiative favors *open* standards. A
  proprietary `synthi.program.json` cuts against that if it's the *only* format. **Decision for the
  plan:** treat `synthi.program.json` as Synthi's superset, but also **detect/import devcontainer
  `devcontainer.json`** where present (the original Slice 3 explicitly named devcontainers). At
  minimum, document the mapping so devcontainer projects aren't second-class.
- **R-2 — Slice 4 deploy credentials.** The "no K8s/registry/Docker creds" rule must distinguish
  **Synthi infra secrets** (always denied) from **user-supplied deploy creds** pulled from the
  `EncryptedSecret` vault (allowed, scoped, for Slice 4's `docker push`/`kubectl`). Otherwise the
  rule accidentally blocks Slice 4. The denylist is platform-secret-shaped, not "all creds."
- **R-3 — Docking dedupe must be opt-in per panel type.** Slice 1's Task 12 registers a
  **single-instance** `IDE_PANEL.INTEGRATIONS` relying on the default dedupe. This slice needs
  **multi-instance** tabs keyed by `programSessionId`. The change MUST be a per-panel-type flag (e.g.
  `allowMultiple: true` on the Programs panel) so the default single-instance behavior — and the
  Integrations panel — are untouched.
- **R-4 — Information architecture.** After Slice 1 + this slice ship, users see three "add
  capability" surfaces: **Extensions** (Open VSX), **Connected Tools / Integrations** (remote MCP),
  **Programs** (runnable marketplace). Keep them clearly labeled and distinct; consider a unified
  "Extend Synthi" hub with three sections. Decide before the Programs sidebar ships.
- **R-5 — "MCP" overloading.** "MCP" now means remote servers we *connect to* (Slice 1 hub client)
  AND synthi-mcp the *server* we *expose* (Slice 5, host of the `synthi_*` program tools). Keep the
  vocabulary crisp in docs/UI.

## Reuse of Slice 1 foundation (do not reinvent)

- **`EncryptedSecret` vault** — store program-supplied secrets here (it was explicitly designed
  generic "so later slices store kubeconfigs, registry creds, OAuth refresh tokens").
- **`WorkspaceMembership.role`** — the authz primitive for consent/permission gating.
- **Audit-table pattern** (`McpCallAudit`) — generalize to `ProgramRuntimeEvent`.

---

## Rollout (phased; ships value each phase)

1. **Phase 1:** launch existing workspace commands as managed program sessions → unified tabs.
2. **Phase 2:** recipe install/launch manifests (`synthi.program.json` + devcontainer import) +
   persisted installs.
3. **Phase 3:** web-port auto-detection + polished Program tab UX.
4. **Phase 4:** generalize GUI capture through the broker.
5. **Phase 5:** open marketplace publishing, signing, reputation, abuse controls.

## Public interfaces

Manifest: `synthi.program.json` (+ devcontainer import).
```
GET  /api/workspace/:slug/programs/marketplace
GET  /api/workspace/:slug/programs/installed
POST /api/workspace/:slug/programs/install
POST /api/workspace/:slug/programs/:installId/launch
POST /api/workspace/:slug/program-sessions/:sessionId/stop
POST /api/workspace/:slug/program-sessions/:sessionId/restart
GET  /api/workspace/:slug/program-sessions/:sessionId/events
```
Event states: `installing, installed, starting, running, unhealthy, stopped, crashed, removed`.
Optional later (Slice 5 server): `synthi_list_programs`, `synthi_launch_program`, `synthi_stop_program`.

## Test plan

- **Unit:** manifest validation, permission prompts, session state transitions, **layout dedupe rules
  (R-3)**, event serialization.
- **Integration:** web launch, TUI launch, long-running CLI service, GUI stream, stop/restart, crash
  recovery, port-proxy WebSocket/HMR.
- **Security:** path traversal, blocked platform env vars (R-2 denylist), workspace-only filesystem
  access, runaway output, idle culling, denied host Docker access.
- **UI:** docked default launch, float, popout, reconnect, multiple running programs, install/
  uninstall, empty/error states, responsive behavior.
- **Broker:** shared visual session, human input, agent input lease, stale-frame rejection,
  program-session event replay.

## Assumptions

- "Any program" = any program runnable inside the managed workspace boundary.
- "Open marketplace" = open publishing with permission disclosure + trust labels, not silent
  privileged execution.
- "Trust workspace" = trusting the program with the user's workspace files, not Synthi infrastructure.
- Installs are per-workspace unless explicitly promoted later to account/team scope.

## Implementation note

This is a **separate initiative** from Slice 1: it lives in `collab-server` + new frontend surfaces,
and should be implemented on its **own branch** (companion to the broker rollout), not on
`tool-compatibility`. It depends only on Slice 1's foundation models being present; it can otherwise
proceed in parallel.
