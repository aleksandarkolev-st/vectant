# Slice 3 Phase 1 — Workspace Program Runtime Plan

Branch: `tool-compatibility` only.

Disk gate: do not run `next build`, `docker build`, or `docker compose build` during this slice.

## Scope

Phase 1 only: launch existing workspace commands as managed program sessions and surface each launch as one unified docked tab keyed by `programSessionId`.

This pass deliberately reuses existing runtime surfaces instead of inventing new ones:

- `backend/collab-server/terminalService.js#createHeadlessSession` is the Phase-1 CLI/TUI/background launch primitive.
- `backend/collab-server/proxyService.js` is the Phase-1 web-port surface.
- `synthi/src/components/docking-wm/` is the only docking family to extend for program tabs.
- `synthi/src/services/api.js#execTerminalCommand` is the current frontend contract that already talks to the headless PTY path; Phase 1 should fold this into managed program sessions rather than keep a separate ad hoc command-launch path.

## Locked Decisions

- `R-1`: `synthi.program.json` remains the Synthi superset, and later phases also detect/import `devcontainer.json`.
- `R-3`: docking dedupe must respect per-panel `allowMultiple`; Programs opt in, Connected Tools stays single-instance.
- `R-4`: keep Extensions, Connected Tools, and Programs as separate clearly labeled surfaces; no "Extend Synthi" hub in Phase 1.

## Explicit Non-Goals

- No Phase 2 marketplace/install UX or manifest execution.
- No Phase 3 auto-detected polished Programs marketplace UI.
- No Phase 4 GUI broker generalization.
- No Phase 5 publishing/signing/reputation.
- No host Docker socket exposure, no platform secret passthrough, no relaxed env scrubbing.

## Required Security Invariants

Every task below must preserve and test these constraints:

- Scrubbed child-process env denies Synthi platform, DB, GCS, K8s, and similar infrastructure secrets.
- No host Docker socket exposure.
- Runtime remains workspace-contained and rootless-compatible.
- Launch/install consent is recorded through `PermissionGrant` before first managed launch.
- Quotas, idle culling, output caps, and a kill switch land in the runtime manager from day one.
- Audit/event payloads stay redacted; raw secrets and raw command env never persist.

## Phase-1 Task Plan

### Task 1 — Docking multiplicity contract

Goal: make multi-instance program tabs possible without changing existing single-instance panels.

Implementation surface:

- `synthi/src/components/docking-wm/state/layout-slice.js`
- `synthi/src/components/docking-wm/utils/layout-ops.js`
- `synthi/src/components/docking-wm/state/panel-registry.js`
- `synthi/src/components/docking-wm/panels/panel-types.js`
- `synthi/src/components/docking-wm/panels/ide-panels.js`
- `synthi/src/components/docking-wm/__tests__/layout-ops.test.js`

Red -> green contract:

- Add failing tests proving `allowMultiple: true` panels can open multiple docked/floating instances keyed by distinct session data.
- Add failing tests proving `IDE_PANEL.INTEGRATIONS` remains single-instance.
- Refactor dedupe so it consults panel registration instead of hard-coding panel-type uniqueness.

Security review folded into task:

- Verify persisted layout data stores only public tab metadata (`programSessionId`, title, surface hints) and never raw commands, env blobs, or secrets.

Validation gate:

- `cd synthi && npx vitest run src/components/docking-wm`

### Task 2 — Prisma and server-side program data foundation

Goal: add the approved models and wire Phase-1 store helpers around existing Slice-1 primitives.

Implementation surface:

- `synthi/prisma/schema.prisma`
- new `synthi/src/lib/programs/store.js`
- new `synthi/src/lib/programs/__tests__/store.test.js`

Required models:

- `MarketplaceProgram`
- `ProgramVersion`
- `ProgramInstall`
- `ProgramSession`
- `PermissionGrant`
- `ProgramRuntimeEvent`

Phase-1 usage note:

- `ProgramSession`, `PermissionGrant`, and `ProgramRuntimeEvent` are live in Phase 1.
- `MarketplaceProgram`, `ProgramVersion`, and `ProgramInstall` land now as schema groundwork only; their behavioral rollout remains Phase 2+.

Design constraints:

- Reuse `EncryptedSecret` for any future program-supplied secrets; do not add plain-text secret columns.
- Generalize the existing `McpCallAudit` pattern for `ProgramRuntimeEvent`.
- Build authz on `WorkspaceMembership.role`.

Red -> green contract:

- Add failing store tests for launch-session creation, session transitions, permission-grant lookup/creation, and runtime-event append/read.
- Add schema, run client generation, make tests pass.

Security review folded into task:

- `PermissionGrant.scopesJson` and `ProgramRuntimeEvent.dataJson` must store redacted metadata only, never raw env or secret values.

Validation gate:

- `cd synthi && npx prisma generate`
- `cd synthi && prisma db push`
- `cd synthi && npx vitest run src/lib/programs`

### Task 3 — collab-server runtime manager over existing launch primitives

Goal: introduce one managed runtime authority that wraps existing headless PTY and proxy behavior.

Implementation surface:

- new `backend/collab-server/programRuntimeManager.js`
- `backend/collab-server/server.js`
- `backend/collab-server/terminalService.js`
- `backend/collab-server/proxyService.js`
- new `backend/collab-server/__tests__/programRuntimeManager.test.js`

Phase-1 behavior:

- Launch existing workspace commands through `createHeadlessSession`.
- Track program-session lifecycle (`starting`, `running`, `unhealthy`, `stopped`, `crashed`).
- Reuse port scanning/proxying for web surfaces.
- Add output caps, idle-cull timers, and a kill switch at the manager layer.

Red -> green contract:

- Add failing tests for session creation, state transitions, stop/restart, output truncation, idle culling, and web-port metadata capture.
- Implement a runtime manager that becomes the single collab-server owner of managed program sessions.

Security review folded into task:

- Add tests proving the spawned child env excludes platform secrets and does not expose the host Docker socket path.

Validation gate:

- `node --test backend/collab-server/__tests__/programRuntimeManager.test.js`

### Task 4 — Next.js API and permission-gated Phase-1 contracts

Goal: expose managed program sessions through server-side routes, not direct browser access to collab-server internals.

Implementation surface:

- new `synthi/src/app/api/workspace/[slug]/program-sessions/route.js`
- new `synthi/src/app/api/workspace/[slug]/program-sessions/[sessionId]/route.js`
- new `synthi/src/app/api/workspace/[slug]/program-sessions/[sessionId]/events/route.js`
- new `synthi/src/app/api/workspace/[slug]/program-sessions/__tests__/programSessionRoutes.test.js`
- `synthi/src/lib/programs/store.js`

Phase-1 contract:

- `GET /api/workspace/:slug/program-sessions` — running + recent sessions.
- `POST /api/workspace/:slug/program-sessions` — launch an existing workspace command as a managed session.
- `POST /api/workspace/:slug/program-sessions/:sessionId/stop`
- `POST /api/workspace/:slug/program-sessions/:sessionId/restart`
- `GET /api/workspace/:slug/program-sessions/:sessionId/events`

Red -> green contract:

- Add failing route tests for owner/admin launch-stop-restart, member read access, missing-consent rejection, and redacted event payloads.
- Implement the routes against the new store/runtime manager.

Security review folded into task:

- Consent is required before first launch and recorded as a `PermissionGrant`.
- Mutation routes require `WorkspaceMembership.role ∈ {owner, admin}`; member access is read-only.

Validation gate:

- `cd synthi && npx vitest run src/app/api/workspace`

### Task 5 — Minimal Programs surface for Phase 1

Goal: add a separate Programs surface without dragging marketplace scope into this pass.

Implementation surface:

- new `synthi/src/components/programs/ProgramsPanel.jsx`
- new `synthi/src/components/programs/__tests__/ProgramsPanel.test.jsx`
- `synthi/src/components/docking-wm/panels/panel-wrappers.jsx`
- `synthi/src/components/docking-wm/components/DockingActivityBar.jsx`
- `synthi/src/components/docking-wm/hooks/use-activity-bar-docking.js`

Phase-1 UI only:

- Separate Programs entry in the activity bar per `R-4`.
- Minimal panel with `Launch Command`, `Running`, and `Recent` sections.
- No marketplace/install tabs yet.

Red -> green contract:

- Add failing UI tests for launcher submission, permission prompt gating, running/recent render, and activity-bar open/focus behavior.
- Implement the minimal Programs panel.

Security review folded into task:

- Only owner/admin users can submit launches from the UI; members get read-only running/recent views.
- The UI must not echo scrubbed env or sensitive payloads back to the user.

Validation gate:

- `cd synthi && npx vitest run src/components/programs`

### Task 6 — Unified program session tab

Goal: surface each managed launch as a multi-instance docked tab keyed by `programSessionId`.

Implementation surface:

- new `synthi/src/components/programs/ProgramSessionPanel.jsx`
- new `synthi/src/components/programs/__tests__/ProgramSessionPanel.test.jsx`
- `synthi/src/components/docking-wm/panels/ide-panels.js`
- `synthi/src/components/docking-wm/panels/panel-types.js`
- new `synthi/src/services/programSessionClient.js`

Phase-1 session UI:

- One tab per `programSessionId` with sub-tabs: `App`, `Logs`, `Terminal`, `Ports`, `Health`, `Settings`.
- `Terminal` reuses the existing terminal/session attach path.
- `App` reuses existing proxied web-port surfaces.
- `Logs`/`Health`/`Ports` read runtime-event and port metadata from the Phase-1 API.

Red -> green contract:

- Add failing tests for multi-instance session tabs, session re-open/focus rules, terminal attach, web-port surface rendering, and stop/restart controls.
- Implement the session tab wrapper and client logic.

Security review folded into task:

- Sandbox any iframe/web surface appropriately.
- Do not render raw secret-bearing event payloads in any sub-tab.

Validation gate:

- `cd synthi && npx vitest run src/components/programs src/components/docking-wm`

### Task 7 — End-to-end regression and security sweep

Goal: prove Phase 1 works without widening scope into later phases.

Validation bundle:

- `cd synthi && npx prisma generate`
- `cd synthi && prisma db push`
- `cd synthi && npx vitest run src/lib/programs src/app/api/workspace src/components/programs src/components/docking-wm`
- `node --test backend/collab-server/__tests__/programRuntimeManager.test.js`
- `cd synthi && npx vitest run` and accept only the known pre-existing empty `src/lib/__tests__/preview-store.test.js` stub failure

Security checklist:

- env scrub denylist verified by test
- docker-socket denial verified by test
- output cap verified by test
- idle-culling verified by test
- role/consent gates verified by route + UI tests

## Execution Loop

For each task:

1. Write/expand the failing targeted tests first.
2. Implement the smallest slice that turns the target green.
3. Run the focused validation gate immediately after the first substantive edit.
4. Run a spec-review / quality-review pass before moving to the next task.
5. Commit on `tool-compatibility` with specific staged files only and the required `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

## Check-In Rule

Do not start implementation until the user reviews this Phase-1 plan and confirms the task order or requested adjustments.