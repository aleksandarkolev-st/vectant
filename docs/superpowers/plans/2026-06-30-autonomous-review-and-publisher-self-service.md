# Autonomous Review Pipeline + Publisher Self-Service — Implementation Plan

> **For agentic workers:** TDD, task-by-task, one commit per task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the community-app review pipeline run autonomously (static + AI, hybrid inline/queued, with auto-reject) and give publishers a "My Apps" tab to track + control submissions.

**Architecture:** Reuse the Phase-1/2 orchestrator. `aiDecision` becomes 3-way (approve/reject/manual). The pipeline is extracted into a reusable `runPipeline(versionId, ctx, deps)` driven either **inline** (no-image submissions) or **fire-and-forget + cron sweep** (image submissions, via `processSubmission` + an internal `process-pending` route). The frontend gains a third Programs-panel view backed by the existing `GET /programs/submissions`, plus unpublish + a submit rewrite.

**Tech Stack:** Next.js API routes + vitest (mocked deps); React (repo's `react-dom/client` + jsdom test convention); Prisma store (mocked in unit tests).

**Test command (this box):** `cd synthi; $env:TEMP='D:\synthi-tmp';$env:TMP='D:\synthi-tmp';$env:TMPDIR='D:\synthi-tmp'; npx vitest run <filter> --pool=forks --no-file-parallelism --maxWorkers=1`

---

## File structure

**Modified (backend):** `aiReviewer.js` (3-way decision + reject threshold), `reviewOrchestrator.js` (`runPipeline` + `processSubmission` + hybrid `submitForReview` + auto-reject), `store.js` (`unpublishProgram`, tighten `getPublishedProgramVersion`, `listProcessableSubmissions`), `publish/route.js` (hybrid return + fire-and-forget).
**New (backend):** `app/api/internal/programs/process-pending/route.js` (sweep, internal-token), `app/api/workspace/[slug]/programs/unpublish/route.js`.
**Modified (frontend):** `programsClient.js`, `ProgramsPanel.jsx`, `store/StoreView.jsx` (CTA label).
**New (frontend):** `components/programs/myapps/MyAppsView.jsx`, `myapps/MyAppCard.jsx`, wire `FirstPublishTutorial`.
**Tests:** extend `aiReviewer.test.js`, `reviewOrchestrator.test.js`, `store.test.js`, `programRoutes.test.js`; new `processPendingRoute.test.js`, `myAppsView.test.jsx`.

---

## PHASE A — Autonomous backend

### Task A1: 3-way `aiDecision` (auto_approve | auto_reject | manual)

**Files:** Modify `synthi/src/lib/programs/aiReviewer.js`; Test `synthi/src/lib/programs/__tests__/aiReviewer.test.js`

- [ ] **Step 1: Replace the `aiDecision` describe block tests**

```js
describe('aiDecision (3-way)', () => {
  const opts = { lowThreshold: 0.3, highThreshold: 0.7 };
  it('auto-approves low risk + safe scopes + no flags', () => {
    expect(aiDecision({ riskScore: 0.1, flags: [] }, cfg({ permissions: ['program.launch'] }), opts)).toBe('auto_approve');
  });
  it('auto-rejects when risk >= high threshold', () => {
    expect(aiDecision({ riskScore: 0.9, flags: [] }, cfg(), opts)).toBe('auto_reject');
  });
  it('auto-rejects when any flag is present (even at low risk)', () => {
    expect(aiDecision({ riskScore: 0.0, flags: ['obfuscation'] }, cfg(), opts)).toBe('auto_reject');
  });
  it('routes the middle band (no flags) to manual', () => {
    expect(aiDecision({ riskScore: 0.5, flags: [] }, cfg(), opts)).toBe('manual');
  });
  it('routes a sensitive scope (low risk, no flags) to manual', () => {
    expect(aiDecision({ riskScore: 0.1, flags: [] }, cfg({ permissions: ['program.launch', 'network.outbound'] }), opts)).toBe('manual');
  });
});
```

- [ ] **Step 2: Run → fail** (`npx vitest run aiReviewer …`) — middle/sensitive now return `'manual'` (ok), but reject cases return `'manual'` (current 2-way) → fail.

- [ ] **Step 3: Implement** — replace `aiDecision` + add the reject threshold const:

```js
const DEFAULT_LOW = Number(process.env.PROGRAM_AI_RISK_THRESHOLD) || 0.3;
const DEFAULT_HIGH = Number(process.env.PROGRAM_AI_REJECT_THRESHOLD) || 0.7;

/**
 * Three-way autonomous decision (precedence: approve → reject → manual).
 * @returns {'auto_approve'|'auto_reject'|'manual'}
 */
export function aiDecision({ riskScore, flags = [] }, config, { lowThreshold = DEFAULT_LOW, highThreshold = DEFAULT_HIGH } = {}) {
  const perms = Array.isArray(config?.permissions) ? config.permissions : [];
  const hasSensitive = perms.some((p) => SENSITIVE_SCOPES.includes(p));
  const hasFlags = Array.isArray(flags) && flags.length > 0;
  if (riskScore <= lowThreshold && !hasFlags && !hasSensitive) return 'auto_approve';
  if (riskScore >= highThreshold || hasFlags) return 'auto_reject';
  return 'manual';
}
```

(Delete the now-unused single `DEFAULT_THRESHOLD` const if present.)

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(programs): 3-way AI decision (auto-approve/auto-reject/manual)`

---

### Task A2: Orchestrator — `runPipeline`, auto-reject, `processSubmission`, hybrid submit

**Files:** Modify `synthi/src/lib/programs/reviewOrchestrator.js`; Test `…/__tests__/reviewOrchestrator.test.js`

- [ ] **Step 1: Add failing tests** (the existing 12 stay; add these; extend `deps` with `aiDecide` returning `'auto_approve'` by default — already present):

```js
describe('runPipeline auto-reject', () => {
  it('flag ON + auto_reject → ai_review → rejected (records reasons)', async () => {
    deps.aiEnabled = true;
    deps.aiReview.mockResolvedValue({ riskScore: 0.9, flags: ['malware'], rationale: 'bad' });
    deps.aiDecide.mockReturnValue('auto_reject');
    const res = await submitForReview({ workspaceSlug: 'team', config: { ...containerConfig, runtimeType: 'web', launch: 'npm run dev', install: ['npm ci'] }, sourceImageRef: null, submittedByUserId: 'u1' }, deps);
    expect(res.reviewState).toBe('rejected');
    expect(deps.store.transitionReview).toHaveBeenCalledWith('ver1', expect.objectContaining({ fromState: 'ai_review', toState: 'rejected' }));
    expect(deps.reHost).not.toHaveBeenCalled();
  });
});

describe('submitForReview hybrid', () => {
  it('container submission returns queued (submitted) without running the pipeline inline', async () => {
    const res = await submitForReview({ workspaceSlug: 'team', config: containerConfig, sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1' }, deps);
    expect(res.reviewState).toBe('submitted');
    // gates/scan are NOT awaited inline for an image submission
    expect(deps.scanner).not.toHaveBeenCalled();
  });
  it('web submission runs inline to a terminal-ish state', async () => {
    deps.aiEnabled = false;
    const res = await submitForReview({ workspaceSlug: 'team', config: { ...containerConfig, runtimeType: 'web', launch: 'npm run dev', install: ['npm ci'] }, sourceImageRef: null, submittedByUserId: 'u1' }, deps);
    expect(res.reviewState).toBe('pending_review');
  });
});

describe('processSubmission', () => {
  it('drives a queued container row through scan → (flag off) pending_review', async () => {
    deps.aiEnabled = false;
    deps.store.getReviewVersionById.mockResolvedValue({ id: 'ver1', version: '1.0.0', reviewState: 'submitted', sourceImageRef: 'reg.io/me/tool:1', manifestJson: JSON.stringify(containerConfig), program: { id: 'prog1', publisher: 'team' } });
    const res = await processSubmission('ver1', deps);
    expect(deps.scanner).toHaveBeenCalledWith('reg.io/me/tool:1', expect.anything());
    expect(res.reviewState).toBe('pending_review');
  });
  it('returns the row state untouched for a terminal/human-queue row', async () => {
    deps.store.getReviewVersionById.mockResolvedValue({ id: 'ver1', reviewState: 'pending_review', manifestJson: JSON.stringify(containerConfig), program: { id: 'prog1', publisher: 'team' } });
    const res = await processSubmission('ver1', deps);
    expect(res.reviewState).toBe('pending_review');
    expect(deps.scanner).not.toHaveBeenCalled();
  });
});
```

Also import `processSubmission` in the test's import line.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — restructure `reviewOrchestrator.js`:

  (a) Extract the gates→scan→finishAfterScan body into `runPipeline`:

```js
const NONTERMINAL_QUEUEABLE = new Set(['submitted', 'scanning', 'ai_review']);

/** Full pipeline from a created submission: gates → scan → AI/decide. Idempotent
 *  via guarded transitions, so a re-drive of an advanced row is safe. */
async function runPipeline(versionId, { config, sourceImageRef }, deps) {
  const { store, hardGates, scanner } = deps;
  const gate = hardGates({ config, sourceImageRef });
  if (!gate.ok) {
    await store.transitionReview(versionId, { fromState: 'submitted', toState: 'rejected', actorUserId: null, reason: gate.reasons });
    return { versionId, reviewState: 'rejected', reasons: gate.reasons };
  }
  await store.transitionReview(versionId, { fromState: 'submitted', toState: 'scanning', actorUserId: null });

  let scanSummary = null;
  let scanPatch = {};
  if (IMAGE_RUNTIME_TYPES.has(config.runtimeType) && sourceImageRef) {
    const scan = await scanner(sourceImageRef, {});
    scanSummary = scan.summary;
    scanPatch = { scanReportJson: JSON.stringify(scan.summary || {}) };
    if (!scan.ok) {
      await store.transitionReview(versionId, { fromState: 'scanning', toState: 'rejected', actorUserId: null, reason: [{ code: 'cve_over_threshold', message: 'image failed CVE scan' }], patch: scanPatch });
      return { versionId, reviewState: 'rejected', reasons: [{ code: 'cve_over_threshold' }] };
    }
  }
  return finishAfterScan(versionId, { config, sourceImageRef, scanSummary, scanPatch }, deps);
}
```

  (b) Add the `auto_reject` branch in `finishAfterScan` (between auto_approve and the manual fallback):

```js
  const decision = aiDecide(ai, config);
  if (decision === 'auto_approve') {
    await store.transitionReview(versionId, { fromState: 'ai_review', toState: 'approved', actorUserId: 'system' });
    await store.transitionReview(versionId, { fromState: 'approved', toState: 'rehosting', actorUserId: 'system' });
    const row = await store.getReviewVersionById(versionId);
    return rehostAndPublish(row, JSON.parse(row.manifestJson), 'system', deps);
  }
  if (decision === 'auto_reject') {
    await store.transitionReview(versionId, { fromState: 'ai_review', toState: 'rejected', actorUserId: 'system', reason: [{ code: 'ai_auto_reject', message: (ai.flags || []).join(', ') || 'high risk' }], patch: { aiRiskJson } });
    return { versionId, reviewState: 'rejected', reasons: [{ code: 'ai_auto_reject' }] };
  }
  await store.transitionReview(versionId, { fromState: 'ai_review', toState: 'pending_review', actorUserId: null, patch: { aiRiskJson } });
  return { versionId, reviewState: 'pending_review' };
```

  (c) Rewrite `submitForReview` to hybrid:

```js
export async function submitForReview({ workspaceSlug, config, sourceImageRef = null, submittedByUserId }, deps = defaultDeps()) {
  const { store } = deps;
  const { version } = await store.createSubmission({ workspaceSlug, config, sourceImageRef, submittedByUserId });
  const ctx = { config, sourceImageRef };
  // Image submissions are slow (trivy + re-host) → queue them; the publish route
  // kicks off processing fire-and-forget and the cron sweep is the durable backstop.
  if (IMAGE_RUNTIME_TYPES.has(config.runtimeType) && sourceImageRef) {
    return { versionId: version.id, reviewState: 'submitted' };
  }
  return runPipeline(version.id, ctx, deps);
}
```

  (d) Add `processSubmission` (the worker entry):

```js
/** Worker entry: drive one queued/in-flight submission toward a terminal state.
 *  Resumable — runPipeline's guarded transitions no-op past steps; a row already
 *  in a human queue or terminal state is left untouched. */
export async function processSubmission(versionId, deps = defaultDeps()) {
  const { store } = deps;
  const row = await store.getReviewVersionById(versionId);
  if (!row) return { error: 'not_found' };
  if (!NONTERMINAL_QUEUEABLE.has(row.reviewState)) return { versionId, reviewState: row.reviewState };
  return runPipeline(versionId, { config: JSON.parse(row.manifestJson), sourceImageRef: row.sourceImageRef }, deps);
}
```

  Keep the existing `approveSubmission`/`rejectSubmission`/`rehostAndPublish`/`finishAfterScan` (finishAfterScan now contains the 3-way branch). Note the existing test "flag ON + manual decision … stores aiRiskJson" still passes (manual branch unchanged).

- [ ] **Step 4: Run → pass** (existing 12 + 5 new). Fix any existing test that assumed container submit ran inline — the "clean container submission lands in pending_review" test now expects the *queued* path; update it to drive via `processSubmission` or assert `'submitted'`. (Search the file for container `submitForReview` expectations and align.)
- [ ] **Step 5: Commit** `feat(programs): autonomous pipeline (runPipeline + processSubmission + auto-reject + hybrid submit)`

---

### Task A3: Store — unpublish + live-version resolution + processable list

**Files:** Modify `synthi/src/lib/programs/store.js`; Test `…/__tests__/store.test.js`

- [ ] **Step 1: Add failing tests**

```js
describe('unpublishProgram', () => {
  it('clears the live pointers (drops from marketplace)', async () => {
    h.prisma.marketplaceProgram.update.mockResolvedValue({ id: 'p1', publishedVersion: null });
    await unpublishProgram('@team/tool');
    expect(h.prisma.marketplaceProgram.update).toHaveBeenCalledWith({ where: { packageId: '@team/tool' }, data: { publishedVersion: null, publishedDigest: null } });
  });
});

describe('getPublishedProgramVersion (live version only)', () => {
  it('returns null when the requested version is not the live publishedVersion', async () => {
    h.prisma.marketplaceProgram.findUnique.mockResolvedValue({ id: 'p1', packageId: '@team/tool', publisher: 'team', publishedVersion: '2.0.0' });
    h.prisma.programVersion.findUnique.mockResolvedValue({ id: 'v1', reviewState: 'published', manifestJson: '{"launch":"x"}' });
    const found = await getPublishedProgramVersion('@team/tool', '1.0.0');
    expect(found).toBeNull();
  });
});

describe('listProcessableSubmissions', () => {
  it('lists non-terminal submissions for the sweep, bounded', async () => {
    h.prisma.programVersion.findMany.mockResolvedValue([{ id: 'ver1', reviewState: 'submitted' }]);
    const rows = await listProcessableSubmissions(50);
    expect(h.prisma.programVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { reviewState: { in: ['submitted', 'scanning', 'ai_review'] } },
      take: 50,
    }));
    expect(rows[0].id).toBe('ver1');
  });
});
```

Add `unpublishProgram, listProcessableSubmissions` to the import line. Update the existing `getPublishedProgramVersion` happy-path test mock to include `publishedVersion: '1.0.0'` on the program (so version === publishedVersion holds).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — add to `store.js`:

```js
/** Take a published program down: clear its live pointer (drops from marketplace). */
export async function unpublishProgram(packageId) {
  return prisma.marketplaceProgram.update({
    where: { packageId },
    data: { publishedVersion: null, publishedDigest: null },
  });
}

/** Non-terminal submissions for the autonomous sweep (bounded). */
export async function listProcessableSubmissions(limit = 50) {
  return prisma.programVersion.findMany({
    where: { reviewState: { in: ['submitted', 'scanning', 'ai_review'] } },
    orderBy: { submittedAt: 'asc' },
    take: limit,
  });
}
```

  And tighten `getPublishedProgramVersion` — after the `reviewState !== 'published'` guard:

```js
  if (versionRow.reviewState !== 'published') return null;
  // Only the currently-live version is installable (unpublish / supersede takes
  // effect immediately; no resurrecting an old reviewed digest).
  if (program.publishedVersion && program.publishedVersion !== version) return null;
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(programs): unpublish + live-version-only resolution + processable list`

---

### Task A4: Sweep route — `POST /api/internal/programs/process-pending`

**Files:** Create `synthi/src/app/api/internal/programs/process-pending/route.js`; Test `…/__tests__/processPendingRoute.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ listProcessable: vi.fn(), processSubmission: vi.fn() }));
vi.mock('@/lib/programs/store', () => ({ listProcessableSubmissions: h.listProcessable }));
vi.mock('@/lib/programs/reviewOrchestrator', () => ({ processSubmission: h.processSubmission }));
import { POST } from '../route.js';
const req = (token) => ({ headers: { get: (k) => (k.toLowerCase() === 'x-synthi-internal-token' ? token : null) } });

beforeEach(() => { vi.clearAllMocks(); process.env.SYNTHI_INTERNAL_API_TOKEN = 'secret'; });

it('401s without the internal token', async () => {
  const res = await POST(req(null));
  expect(res.status).toBe(401);
  expect(h.processSubmission).not.toHaveBeenCalled();
});
it('processes each non-terminal submission with a valid token', async () => {
  h.listProcessable.mockResolvedValue([{ id: 'ver1' }, { id: 'ver2' }]);
  h.processSubmission.mockResolvedValue({ reviewState: 'published' });
  const res = await POST(req('secret'));
  expect(res.status).toBe(200);
  expect(h.processSubmission).toHaveBeenCalledTimes(2);
  expect((await res.json()).processed).toBe(2);
});
it('503s when no internal token is configured (fail-closed)', async () => {
  delete process.env.SYNTHI_INTERNAL_API_TOKEN;
  const res = await POST(req('whatever'));
  expect(res.status).toBe(503);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```js
import { NextResponse } from 'next/server';
import { listProcessableSubmissions } from '@/lib/programs/store';
import { processSubmission } from '@/lib/programs/reviewOrchestrator';

export const runtime = 'nodejs';

// POST /api/internal/programs/process-pending — scheduler-triggered autonomous
// sweep. Internal shared-secret auth only; never publicly reachable.
export async function POST(req) {
  const configured = process.env.SYNTHI_INTERNAL_API_TOKEN;
  if (!configured) return NextResponse.json({ error: 'sweep_not_configured' }, { status: 503 });
  if (req.headers.get('x-synthi-internal-token') !== configured) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const rows = await listProcessableSubmissions(50);
  let processed = 0;
  for (const row of rows) {
    try { await processSubmission(row.id); processed += 1; } catch { /* best-effort; next sweep retries */ }
  }
  return NextResponse.json({ processed, scanned: rows.length });
}
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(programs): internal process-pending sweep route (autonomous backstop)`

---

### Task A5: Submit route (hybrid + fire-and-forget) + unpublish route

**Files:** Modify `synthi/src/app/api/workspace/[slug]/programs/publish/route.js`; Create `…/programs/unpublish/route.js`; Test extend `…/programs/__tests__/programRoutes.test.js`

- [ ] **Step 1: Add failing tests** (add `unpublishProgram: h.unpublishProgram` + `processSubmission: h.processSubmission` to mocks; `h.unpublishProgram`, `h.processSubmission` to hoisted; import `POST as POST_UNPUBLISH from '../unpublish/route.js'`):

```js
describe('POST /programs/publish kicks off processing for image submissions', () => {
  it('returns the queued submission (fire-and-forget already wired in orchestrator)', async () => {
    h.discoverManifest.mockResolvedValue({ config: { packageId: 'tool', version: '1.0.0', runtimeType: 'container', launch: 'docker run reg.io/me/tool:1' }, source: 'vectant.programs.json' });
    h.submitForReview.mockResolvedValue({ versionId: 'ver1', reviewState: 'submitted' });
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', { sourceImageRef: 'reg.io/me/tool:1' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    expect((await res.json()).submission.reviewState).toBe('submitted');
  });
});

describe('POST /programs/unpublish', () => {
  it('unpublishes for an owner/admin', async () => {
    h.unpublishProgram.mockResolvedValue({ id: 'p1', publishedVersion: null });
    const res = await POST_UNPUBLISH(req('http://x/api/workspace/team/programs/unpublish', { packageId: '@team/tool' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    expect(h.unpublishProgram).toHaveBeenCalledWith('@team/tool');
  });
  it('rejects a plain member (403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_UNPUBLISH(req('http://x/api/workspace/team/programs/unpublish', { packageId: '@team/tool' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.unpublishProgram).not.toHaveBeenCalled();
  });
  it('rejects unpublishing a program owned by another workspace (404/403)', async () => {
    const res = await POST_UNPUBLISH(req('http://x/api/workspace/team/programs/unpublish', { packageId: '@other/tool' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.unpublishProgram).not.toHaveBeenCalled();
  });
});
```

Also add `vi.mock('@/lib/programs/store', …)` entry `unpublishProgram: h.unpublishProgram` and the orchestrator mock `processSubmission: h.processSubmission`.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — the submit route already calls `submitForReview` (returns `{submission}`). Add fire-and-forget for the queued case, after building `submission`:

```js
  const submission = await submitForReview({ workspaceSlug: slug, config: discovered.config, sourceImageRef, submittedByUserId: actor.userId });
  // Image submissions come back queued; kick off processing without blocking the
  // response (the cron sweep is the durable backstop if this instance dies).
  if (submission?.reviewState === 'submitted' && submission.versionId) {
    void processSubmission(submission.versionId).catch(() => {});
  }
  return NextResponse.json({ submission });
```

(Import `processSubmission` from `@/lib/programs/reviewOrchestrator`.)

  Create `unpublish/route.js`:

```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { unpublishProgram } from '@/lib/programs/store';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/unpublish  { packageId }
// Owner/admin: take this workspace's published app down (drops from marketplace).
export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  let body = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }
  const packageId = typeof body.packageId === 'string' ? body.packageId : '';
  // A workspace can only unpublish ITS OWN programs (@<slug>/...).
  if (!packageId.startsWith(`@${slug}/`)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const program = await unpublishProgram(packageId);
  return NextResponse.json({ program });
}
```

- [ ] **Step 4: Run → pass** (`npx vitest run programRoutes …`).
- [ ] **Step 5: Commit** `feat(programs): hybrid submit fire-and-forget + owner unpublish route`

---

## PHASE B — Publisher self-service frontend

### Task B1: Client functions

**Files:** Modify `synthi/src/components/programs/programsClient.js`

- [ ] **Step 1** Add (no separate unit test — exercised by the panel/view tests in B2/B3):

```js
/** Submit this workspace's recipe (+ optional image ref) to the review gate. */
export async function submitForReview(workspaceSlug, { sourceImageRef } = {}) {
  return request(`${programsBase(workspaceSlug)}/publish`, {
    method: 'POST',
    body: JSON.stringify(sourceImageRef ? { sourceImageRef } : {}),
  });
}

/** List this workspace's submissions + their review status (redacted). */
export async function fetchMySubmissions(workspaceSlug) {
  if (!workspaceSlug) return [];
  const body = await request(`${programsBase(workspaceSlug)}/submissions`);
  return body.submissions || [];
}

/** Take a published app down (owner/admin). */
export async function unpublishProgram(workspaceSlug, packageId) {
  return request(`${programsBase(workspaceSlug)}/unpublish`, {
    method: 'POST',
    body: JSON.stringify({ packageId }),
  });
}
```

Keep `publishWorkspaceProgram` (now a thin alias of `submitForReview` with no image) or replace its call sites in B3.

- [ ] **Step 2: Commit** `feat(programs): client fns for submit/my-submissions/unpublish`

---

### Task B2: `MyAppsView` + `MyAppCard` (status board + actions + polling)

**Files:** Create `synthi/src/components/programs/myapps/MyAppsView.jsx`, `myapps/MyAppCard.jsx`; Test `…/__tests__/myAppsView.test.jsx`

- [ ] **Step 1: Write the failing test** (repo convention: `react-dom/client` + `act` + jsdom)

```jsx
/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MyAppsView from '../myapps/MyAppsView';

describe('MyAppsView', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = async (props) => { await act(async () => root.render(<MyAppsView {...props} />)); };

  const subs = [
    { versionId: 'v1', packageId: '@team/tool', reviewState: 'published', scanSummary: { decisiveCves: [] }, aiSummary: { riskScore: 0.1, flags: [] } },
    { versionId: 'v2', packageId: '@team/wip', reviewState: 'rejected', scanSummary: null, aiSummary: { riskScore: 0.9, flags: ['malware'] } },
    { versionId: 'v3', packageId: '@team/q', reviewState: 'submitted', scanSummary: null, aiSummary: null },
  ];

  it('renders a status badge + package for each submission', async () => {
    await render({ submissions: subs, onSubmitUpdate: () => {}, onUnpublish: () => {}, onRefresh: () => {} });
    expect(container.textContent).toMatch(/@team\/tool/);
    expect(container.textContent).toMatch(/published/i);
    expect(container.textContent).toMatch(/rejected/i);
    expect(container.textContent).toMatch(/queued|submitted|in review/i);
  });

  it('shows Unpublish only for a published app and calls back with its packageId', async () => {
    const onUnpublish = vi.fn();
    await render({ submissions: subs, onSubmitUpdate: () => {}, onUnpublish, onRefresh: () => {} });
    const btn = [...container.querySelectorAll('button')].find((b) => /unpublish/i.test(b.textContent));
    expect(btn).toBeTruthy();
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onUnpublish).toHaveBeenCalledWith('@team/tool');
  });

  it('renders an empty state when there are no submissions', async () => {
    await render({ submissions: [], onSubmitUpdate: () => {}, onUnpublish: () => {}, onRefresh: () => {} });
    expect(container.textContent).toMatch(/haven.t (published|submitted)|no apps/i);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `myapps/MyAppCard.jsx` (status badge + redacted reasons + per-state actions) and `myapps/MyAppsView.jsx` (list + empty state). Use `PROGRAM_STYLE` tokens for theming; derive a human label + colour per `reviewState` (`submitted`/`scanning`/`ai_review` → "In review", `pending_review` → "Awaiting human review", `published` → "Live", `rejected` → "Rejected"). `MyAppCard` shows `aiSummary` (riskScore + flags) + `scanSummary` (CVE counts) when present, an **Unpublish** button when `reviewState==='published'`, and a **Submit update** button always. Full code:

```jsx
'use client';
import { PROGRAM_STYLE } from '../programTokens';

const STATE_LABEL = {
  submitted: { text: 'Queued', tone: '#a0a0a8' },
  scanning: { text: 'Scanning', tone: '#c9a227' },
  ai_review: { text: 'AI review', tone: '#c9a227' },
  pending_review: { text: 'Awaiting human review', tone: '#c9a227' },
  approved: { text: 'Approving', tone: '#3a8' },
  rehosting: { text: 'Publishing', tone: '#3a8' },
  published: { text: 'Live', tone: '#2faa55' },
  rejected: { text: 'Rejected', tone: '#d9534f' },
};

export function MyAppCard({ sub, onSubmitUpdate, onUnpublish }) {
  const s = STATE_LABEL[sub.reviewState] || { text: sub.reviewState, tone: '#a0a0a8' };
  return (
    <div data-testid="my-app-card" style={{ padding: 12, borderRadius: 8, background: 'var(--bg-panel, #0d0d12)', display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <strong>{sub.packageId || '(unnamed)'}</strong>
        <span style={{ color: s.tone, fontSize: 12 }}>{s.text}</span>
      </div>
      {sub.scanSummary ? <div style={{ fontSize: 12, opacity: 0.75 }}>CVEs (≥ threshold): {(sub.scanSummary.decisiveCves || []).length}</div> : null}
      {sub.aiSummary ? <div style={{ fontSize: 12, opacity: 0.75 }}>AI risk: {sub.aiSummary.riskScore ?? '—'}{(sub.aiSummary.flags || []).length ? ` · flags: ${sub.aiSummary.flags.join(', ')}` : ''}</div> : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button type="button" onClick={() => onSubmitUpdate(sub)}>Submit update</button>
        {sub.reviewState === 'published' ? <button type="button" onClick={() => onUnpublish(sub.packageId)}>Unpublish</button> : null}
      </div>
    </div>
  );
}

export default function MyAppsView({ submissions = [], onSubmitUpdate, onUnpublish, onRefresh }) {
  if (!submissions.length) {
    return (
      <div style={{ ...PROGRAM_STYLE.panelShell, padding: 16, fontSize: 13, opacity: 0.8 }}>
        You haven’t published any apps yet. Publish one from the Store tab to see it here.
      </div>
    );
  }
  return (
    <div style={{ ...PROGRAM_STYLE.panelShell, padding: 12, display: 'grid', gap: 10, overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{submissions.length} app(s)</span>
        <button type="button" onClick={onRefresh}>Refresh</button>
      </div>
      {submissions.map((sub) => (
        <MyAppCard key={sub.versionId} sub={sub} onSubmitUpdate={onSubmitUpdate} onUnpublish={onUnpublish} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(programs): My Apps status board (badges, redacted reasons, actions)`

---

### Task B3: Wire the third tab + rewire publish + polling + tutorial

**Files:** Modify `synthi/src/components/programs/ProgramsPanel.jsx`, `store/StoreView.jsx`

- [ ] **Step 1** Extend `ProgramsPanel`:
  - import `MyAppsView`, `FirstPublishTutorial`, `submitForReview`, `fetchMySubmissions`, `unpublishProgram`.
  - state: `submissions`, `showTutorial`. Add `'myapps'` to the `view` union.
  - in `load()`, also `fetchMySubmissions(workspaceSlug).catch(() => [])` → `setSubmissions`.
  - **poll**: a `useEffect` that, while `view==='myapps'` and any submission is non-terminal (`['submitted','scanning','ai_review','approved','rehosting'].includes(reviewState)`), calls `load()` every 4s (clear on unmount/terminal).
  - replace `handlePublish` body:

```js
  const handlePublish = useCallback(async (sourceImageRef) => {
    if (!workspaceSlug) return;
    try {
      const { submission } = await submitForReview(workspaceSlug, { sourceImageRef });
      toast.success(submission?.reviewState === 'submitted' ? 'Submitted for review' : `Submission: ${submission?.reviewState}`);
      setView('myapps');
      await load();
    } catch (error) {
      if (error?.status === 422) toast.error(error.body?.message || 'Invalid manifest');
      else if (error?.status === 404) toast.error('No vectant.programs.json or devcontainer.json found in this workspace.');
      else if (error?.status === 403) toast.error('You are not allowed to publish.');
      else toast.error(error.body?.message || error.message || 'Failed to submit');
    }
  }, [load, workspaceSlug]);

  const handleSubmitUpdate = useCallback(() => { setShowTutorial(false); setView('store'); }, []);
  const handleUnpublish = useCallback(async (packageId) => {
    if (!workspaceSlug || !packageId) return;
    if (!window.confirm(`Unpublish ${packageId}? It will be removed from the marketplace.`)) return;
    try { await unpublishProgram(workspaceSlug, packageId); toast.success('Unpublished'); await load(); }
    catch (error) { toast.error(error.body?.message || error.message || 'Failed to unpublish'); }
  }, [load, workspaceSlug]);
```

  - render: a small tab strip (Library / Store / My Apps) when `canManage`; render `MyAppsView` for `view==='myapps'`; mount `<FirstPublishTutorial userId={...} open={showTutorial} onClose={() => setShowTutorial(false)} />`. The Store CTA opens the tutorial the first time (or directly submits). For the image ref, the Store submit affordance collects an optional `sourceImageRef` (a small inline input/prompt) and calls `handlePublish(ref)`.

  - In `StoreView.jsx`, relabel the `publish-program` button text "Publish" → "Submit for review" (keep `data-testid="publish-program"` so existing tests pass) and have `onPublish` accept the collected image ref.

- [ ] **Step 2** Verify existing panel tests still pass (`npx vitest run programsPanel …`) and adjust any that asserted the old publish toast/flow.
- [ ] **Step 3: Commit** `feat(programs): My Apps tab wired into Programs panel (submit/poll/unpublish/tutorial)`

---

### Task B4: Full verification
- [ ] Run `npx vitest run programs …` (all green) + `npx vitest run processPendingRoute …`.
- [ ] `node --check` the new/changed route files.
- [ ] Invariant map: auto-reject recoverable (orchestrator + My Apps re-submit), sweep internal-auth (processPendingRoute test), unpublish owner-only + own-workspace (programRoutes), live-version-only resolution (store), redaction (store `toReviewQueueItem`/`aiSummary` + My Apps shows only summaries).
- [ ] Final commit if needed.

---

## Self-review
- **Spec coverage:** 3-way decision (A1), hybrid + auto-reject + processSubmission (A2), unpublish + live-version resolution (A3), sweep (A4), submit fire-and-forget + unpublish route (A5), client + My Apps tab + rewire + polling + tutorial (B1–B3). All spec components mapped.
- **Type consistency:** `aiDecision(...) → 'auto_approve'|'auto_reject'|'manual'`; `processSubmission(versionId, deps) → {versionId,reviewState}`; `runPipeline(versionId,{config,sourceImageRef},deps)`; client `submitForReview(slug,{sourceImageRef})`, `fetchMySubmissions(slug)`, `unpublishProgram(slug,packageId)`; view union `'library'|'store'|'myapps'`.
- **Out of scope (not built):** managed queue/worker service, SSE push, threshold calibration, audit-timeline UI, trivy/crane-in-frontend-image (deploy task).
- **Known follow-up:** wire a real scheduler (k8s CronJob) to hit `process-pending`; ensure `trivy`/`crane` in the frontend runtime image (the existing inline path already needs them).
