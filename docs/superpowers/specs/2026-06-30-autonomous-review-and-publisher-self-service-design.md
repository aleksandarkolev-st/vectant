# Autonomous Review Pipeline + Publisher Self-Service (Design)

- **Date:** 2026-06-30
- **Status:** Approved (brainstormed) — ready for planning
- **Branch:** `feat/docker-sysbox-engine`
- **Scope:** Make the community-app review pipeline run autonomously (static + AI checks, hybrid sync/async) and give publishers a self-service **"My Apps"** tab to track + control their submissions. Builds directly on the Phase-1 (hard gates + manual queue) and Phase-2 (advisory AI) work already merged.

## Problem

Three gaps remain after Phase 1 + 2:

1. **The frontend is out of sync with the review gate.** `ProgramsPanel.handlePublish` still calls `POST /publish` expecting `{ program }` and toasts "Published" immediately, but that route now returns `{ submission }` and routes through review. Publishing silently mis-reports.
2. **The pipeline runs inline + blocks.** `submitForReview` runs the whole pipeline (gates → trivy scan → AI → decide → re-host → publish) synchronously inside the HTTP request. A container scan + LLM call can take minutes — too slow and timeout-prone for a request.
3. **No publisher self-service.** A publisher can't see their submission's review status, the reasons it was rejected, or take an app down. There's no "their apps" surface.

The goal: a submission flows **autonomously** from submit to live (or to a recorded rejection) for the happy/clearly-bad paths, with humans only seeing the uncertain middle — and the publisher watches + controls it from a **My Apps** tab.

## Decisions (locked in brainstorming)

- **Hybrid execution.** No-image (web/CLI/TUI) submissions run the pipeline **inline** (fast). Image submissions (container/GUI) return immediately as **`submitted` (queued)** and are driven by a **background processor**.
- **Three-way autonomous decision** (after the deterministic gates + CVE scan pass): auto-approve clearly-safe, **auto-reject** clearly-dangerous, human queue for the uncertain middle + sensitive scopes.
- **Worker = fire-and-forget + cron sweep.** The publish route kicks off async processing after responding; an internal `process-pending` route (scheduler-triggered) re-drives stuck rows. Reuses the existing idempotent/resumable orchestrator — no new service.
- **My Apps = status + manage.** Live status board + scan/AI reasons (redacted) + **Submit update** + **Unpublish**.
- **Auto-reject is recoverable.** A rejected publisher sees the reason and re-submits a fixed version; nothing is a dead-end.

## Decision matrix (`aiDecision`, 3-way)

Runs only on a submission that already passed hard gates + CVE scan. Thresholds env-tunable (`PROGRAM_AI_RISK_THRESHOLD` low default `0.3`; `PROGRAM_AI_REJECT_THRESHOLD` high default `0.7`).

| Condition | Outcome |
|---|---|
| `riskScore ≤ low` AND no flags AND no sensitive scope | **`auto_approve`** → rehosting → published |
| `riskScore ≥ high` OR any AI flag | **`auto_reject`** (reasons recorded) |
| otherwise (middle risk, or any sensitive scope) | **`manual`** → pending_review |

Sensitive scopes: `network.outbound`, `workspace.files.write`, `ports.expose` (unchanged from Phase 2). Flag OFF (`PROGRAM_AI_REVIEW_ENABLED=false`) ⇒ no AI step; every clean submission → manual queue (Phase-1 behavior preserved).

## State machine (updated)

```
submitted                         (queued; image submissions sit here until the worker runs)
  → scanning   (hard gates: schema/scope/host-escape/metadata; CVE scan)
      ├─ hard-gate / metadata fail → rejected
      ├─ over-threshold CVE        → rejected
      └─ pass → ai_review*                              (* only when AI enabled)
              ├─ auto_approve → approved → rehosting → published
              ├─ auto_reject  → rejected   (NEW edge)
              └─ manual       → pending_review
pending_review (human)
  ├─ approve → approved → rehosting → published
  └─ reject  → rejected
published
  └─ unpublish → (program.publishedVersion cleared; drops from marketplace)   (NEW)
```

`submitted` doubles as the queue marker (no new "queued" state). The only new transition is `ai_review → rejected` (auto-reject). Unpublish is a program-level action, not a version state.

## Components (isolated, independently testable)

### Backend

1. **`aiDecision` → 3-way** (`aiReviewer.js`): returns `'auto_approve' | 'auto_reject' | 'manual'` per the matrix above. Pure; unit-tested.
2. **Orchestrator auto-reject + async** (`reviewOrchestrator.js`):
   - `finishAfterScan` handles the new `auto_reject` branch (`ai_review → rejected` with AI reasons + `aiRiskJson`).
   - `submitForReview` splits hybrid: always `createSubmission`; if the runtime is no-image → run inline to a terminal state; if image → return `{ reviewState: 'submitted' }` and let the worker drive it.
   - New `processSubmission(versionId, deps)` — idempotent driver that advances one queued submission from its current state (scanning → ai_review → decide → rehost/publish). Resumable: guarded transitions mean a re-drive of an already-advanced row is a no-op.
3. **Sweep route** `POST /api/internal/programs/process-pending` — internal-shared-secret auth (reuse `SYNTHI_INTERNAL_API_TOKEN` / the internal-token pattern). Lists rows in non-terminal states (`submitted`/`scanning`/`ai_review`) and calls `processSubmission` for each. Idempotent; scheduler-triggered (k8s CronJob / external). Bounded batch size.
4. **Submit route** (`publish/route.js`) — returns `{ submission }`; for image submissions kicks off `processSubmission` fire-and-forget after responding (best-effort; the sweep is the durable backstop).
5. **Unpublish route** `POST /api/workspace/[slug]/programs/unpublish` `{ packageId }` — owner/admin (`canWriteScope`). Clears `MarketplaceProgram.publishedVersion`/`publishedDigest` (drops from marketplace). Store helper `unpublishProgram(packageId)`.
6. **Resolution tightening** (`store.getPublishedProgramVersion`): only resolve the **currently-live** version — require `version === program.publishedVersion` (in addition to `reviewState==='published'`). Makes unpublish take effect immediately for new installs and enforces "only the live, reviewed digest is installable."

### Frontend

7. **My Apps tab** (`ProgramsPanel` gains a third `view: 'myapps'`; new `MyAppsView` + `MyAppCard`): owner/admin only. Lists the workspace's submissions (`GET /programs/submissions`) with a live **status badge**, the redacted **scan + AI summary**, and actions **Submit update** (re-runs the publish/submit flow) + **Unpublish**. **Polls** every few seconds while any app is in a non-terminal state.
8. **Client functions** (`programsClient.js`): `fetchMySubmissions(slug)`, `submitForReview(slug, { sourceImageRef })` (replaces the misnamed publish call + carries the image ref), `unpublishProgram(slug, packageId)`.
9. **Rewire publish** — Store tab CTA becomes "Submit for review"; on submit, switch to the My Apps tab so the publisher sees the submission land.
10. **First-publish tutorial wiring** — show `FirstPublishTutorial` (already built) the first time the publisher opens the submit flow.

## Security invariants (each test-pinned; carries forward Phase 1/2 + adds)

- Static rejects stay deterministic + fail-closed (hard gates / CVE) — the AI never overrides a static reject.
- Auto-reject records machine-readable reasons (AI flags / score) and is **recoverable** (re-submit a new version).
- The sweep route is **internal-auth only** (shared secret); never publicly reachable.
- Unpublish is **owner/admin-only**; clears the live pointer so the app stops being installable immediately.
- Only the **currently-live** (`publishedVersion`) digest is resolvable for install (no resurrecting old/superseded digests).
- My Apps + status responses stay **redacted** (riskScore/flags/CVE counts; never raw AI rationale or scan paths).
- `processSubmission` is **idempotent/resumable** (guarded transitions) — a double-trigger (fire-and-forget + sweep) never double-publishes or double-rehosts.

## Reuse / touchpoints

- `reviewOrchestrator.js`, `aiReviewer.js`, `store.js` (review CRUD + `getPublishedProgramVersion`), `hardGates.js`, `imageScanner.js`, `reHoster.js` — all from Phase 1/2.
- `ProgramsPanel.jsx`, `programsClient.js`, `store/StoreView.jsx`, `library/` views, `FirstPublishTutorial.jsx`, `programTokens.js`.
- Internal-token pattern (`SYNTHI_INTERNAL_API_TOKEN`, `internalAiAuth.js`).

## Out of scope (later)

- A managed queue / dedicated worker service (fire-and-forget + cron sweep is the MVP).
- Real-time push (SSE/WS) for status — polling is the MVP.
- Threshold auto-calibration from outcomes.
- Per-app analytics/audit-timeline UI (the `ProgramReviewEvent` audit rows exist; surfacing a timeline is a later UI).
- Ensuring `trivy`/`crane` are in the frontend runtime image — a deploy/Dockerfile task, tracked separately.

## Phasing

- **Phase A (backend autonomy):** 3-way `aiDecision`, orchestrator auto-reject + `processSubmission` + hybrid submit, `process-pending` sweep, unpublish + resolution tightening.
- **Phase B (frontend self-service):** My Apps tab + client fns + publish rewire + tutorial wiring + polling.

Built in that order so the frontend lands on a working autonomous backend.
