# Slice 3 Phase 5 v1 — Open Marketplace (Publish + Browse + Install) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn workspace-local programs into a shareable catalog: an owner/admin **publishes** a workspace's `vectant.programs.json` as `@<slug>/<name>`, any workspace can **browse/search** the global published catalog, and **install** a published program (cross-workspace) through the existing consent flow — with `installCount` as the reputation signal.

**Architecture:** Extends the Phase-2 marketplace foundation (`MarketplaceProgram` / `ProgramVersion` / `ProgramInstall`). A published program is a `MarketplaceProgram` with `publisher = <slug>` and `packageId = @<slug>/<name>` (vs the local `publisher='local'`, `local:<slug>:<id>`). Four additive columns carry display + reputation metadata; new store helpers + API routes + UI handle publish/browse/install. The published manifest is re-validated through `parseProgramManifest` on install (same fail-closed rules), and projections never leak `manifestJson`.

**Tech Stack:** Next.js App Router API + React (`synthi/`, Vitest from the `synthi/` dir; jsdom via `react-dom/client` + `act`), Prisma/Postgres (`prisma db push`, no migrations dir).

**Constraints (carried from Phases 1–4):**
- Branch `tool-compatibility` only — no branch/merge/PR/finish.
- Disk gate: **TDD only** (`vitest` / `node --test` / `prisma generate|db push`). NO `next build` / `docker build`.
- Run `@/`-dependent suites from `synthi/` (vitest v4.1.8 has the alias). `cd` explicitly each Bash call.
- Stage specific files only (never `git add -A`). Every commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Don't touch the known pre-existing dirty/untracked noise files.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `synthi/prisma/schema.prisma` | `MarketplaceProgram` += displayName/description/publishedByUserId/installCount | Modify |
| `synthi/src/lib/programs/manifest.js` | optional `description` field on the normalized config | Modify |
| `synthi/src/lib/programs/__tests__/manifest.test.js` | description test | Modify |
| `synthi/src/lib/programs/store.js` | publishProgram / listPublishedPrograms / getPublishedProgramVersion / incrementInstallCount / toPublicMarketplaceProgram | Modify |
| `synthi/src/lib/programs/__tests__/store.test.js` | store tests (+ extend the prisma mock) | Modify |
| `synthi/src/lib/programs/runtimeClient.js` | (none — publish reuses discoverManifest) | — |
| `synthi/src/app/api/workspace/[slug]/programs/publish/route.js` | POST publish (owner/admin) | Create |
| `synthi/src/app/api/workspace/[slug]/programs/marketplace/route.js` | GET → global published catalog (search) | Modify |
| `synthi/src/app/api/workspace/[slug]/programs/install/route.js` | install a published `{packageId,version}` OR the workspace manifest | Modify |
| `synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js` | route tests | Modify |
| `synthi/src/components/programs/programsClient.js` | publishWorkspaceProgram / fetchMarketplace / installPublishedProgram | Modify |
| `synthi/src/components/programs/ProgramsPanel.jsx` | Publish action + Marketplace browse/install section | Modify |
| `synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx` | publish + marketplace UI tests | Modify |
| `tasks/todo.md` | Phase-5 checklist + review | Modify |

**Contract:** published `MarketplaceProgram` = `{ packageId: '@<slug>/<name>', publisher: '<slug>', verified, latestVersion, displayName, description, publishedByUserId, installCount }`. `toPublicMarketplaceProgram` allow-lists those fields; **never** `versions`/`manifestJson`.

---

## Task 1: Schema + manifest `description`

**Files:**
- Modify: `synthi/prisma/schema.prisma`
- Modify: `synthi/src/lib/programs/manifest.js`
- Test: `synthi/src/lib/programs/__tests__/manifest.test.js`

- [ ] **Step 1: Write the failing manifest test**

In `synthi/src/lib/programs/__tests__/manifest.test.js`, add inside the top-level describe:

```js
  it('normalizes an optional description (trimmed, defaults to empty string)', () => {
    const cfg = parseProgramManifest({ packageId: 'web', version: '1.0.0', launch: 'npm run dev', description: '  A dev server  ' });
    expect(cfg.description).toBe('A dev server');
    const noDesc = parseProgramManifest({ packageId: 'web', version: '1.0.0', launch: 'npm run dev' });
    expect(noDesc.description).toBe('');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/manifest.test.js`
Expected: FAIL — `cfg.description` is `undefined`.

- [ ] **Step 3: Implement the description normalizer**

In `synthi/src/lib/programs/manifest.js`, add a normalizer near `normalizeDisplayName`:

```js
function normalizeDescription(description) {
  return typeof description === 'string' ? description.trim() : '';
}
```

In `parseProgramManifest`, compute and include it:

```js
  const displayName = normalizeDisplayName(obj.displayName, packageId);
  const description = normalizeDescription(obj.description);
```

and add `description,` to the returned object (right after `displayName,`):

```js
    displayName,
    description,
    runtimeType,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/manifest.test.js`
Expected: PASS.

- [ ] **Step 5: Add the schema columns**

In `synthi/prisma/schema.prisma`, extend `model MarketplaceProgram` (after `latestVersion String`):

```prisma
  displayName       String?
  description       String?
  publishedByUserId String?
  installCount      Int      @default(0)
```

- [ ] **Step 6: Apply the schema + regenerate**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx prisma generate && npx prisma db push`
Expected: client regenerated; db push applies the 4 new columns (output mentions the added fields, ends success). If it reports "already in sync" the edit didn't save — re-check.

- [ ] **Step 7: Commit**

```bash
git add synthi/prisma/schema.prisma synthi/src/lib/programs/manifest.js "synthi/src/lib/programs/__tests__/manifest.test.js"
git commit -m "feat(slice3-p5): marketplace publish/reputation columns + manifest description

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Store — `publishProgram` + `toPublicMarketplaceProgram`

**Files:**
- Modify: `synthi/src/lib/programs/store.js`
- Test: `synthi/src/lib/programs/__tests__/store.test.js`

- [ ] **Step 1: Extend the prisma mock + write the failing tests**

In `synthi/src/lib/programs/__tests__/store.test.js`, extend the hoisted prisma mock's `marketplaceProgram` to include `update` and `findUnique`:

```js
    marketplaceProgram: { upsert: vi.fn(), findMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
```

Add `publishProgram`, `toPublicMarketplaceProgram` to the import list from `../store`, then add:

```js
describe('publishProgram', () => {
  it('publishes under the @slug/<name> namespace with publisher = slug', async () => {
    h.prisma.marketplaceProgram.upsert.mockResolvedValue({ id: 'prog1', packageId: '@team/web', publisher: 'team' });
    h.prisma.programVersion.upsert.mockResolvedValue({ id: 'ver1' });
    const config = { packageId: 'web', version: '1.2.0', displayName: 'Web', description: 'A dev server', launch: 'npm run dev', ports: [3000] };

    const { program } = await publishProgram({ workspaceSlug: 'team', config, publishedByUserId: 'u1' });

    expect(program.packageId).toBe('@team/web');
    const upsertArg = h.prisma.marketplaceProgram.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({ packageId: '@team/web' });
    expect(upsertArg.create).toMatchObject({ packageId: '@team/web', publisher: 'team', publishedByUserId: 'u1', displayName: 'Web', description: 'A dev server', latestVersion: '1.2.0' });
    const verArg = h.prisma.programVersion.upsert.mock.calls[0][0];
    expect(verArg.where).toEqual({ programId_version: { programId: 'prog1', version: '1.2.0' } });
  });
});

describe('toPublicMarketplaceProgram', () => {
  it('allow-lists display/reputation fields and never leaks versions/manifest', () => {
    const pub = toPublicMarketplaceProgram({
      id: 'p1', packageId: '@team/web', publisher: 'team', verified: true, latestVersion: '1.0.0',
      displayName: 'Web', description: 'd', installCount: 7,
      versions: [{ manifestJson: 'SECRET' }], publishedByUserId: 'u1',
    });
    expect(pub).toEqual({ id: 'p1', packageId: '@team/web', publisher: 'team', verified: true, latestVersion: '1.0.0', displayName: 'Web', description: 'd', installCount: 7 });
    expect(pub.versions).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain('SECRET');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/store.test.js`
Expected: FAIL — `publishProgram`/`toPublicMarketplaceProgram` are not exported.

- [ ] **Step 3: Implement in `store.js`**

Add after `upsertLocalProgram` (keep the local helpers together):

```js
// ── Published marketplace helpers (Phase 5) ──
//
// A *published* program is a MarketplaceProgram whose publisher is the source
// workspace slug and whose packageId is namespaced `@<slug>/<name>` — distinct
// from the workspace-local `publisher='local'` / `local:<slug>:<id>` rows.

/** Build the published packageId for a workspace's program. */
export function publishedPackageId(workspaceSlug, packageId) {
  return `@${workspaceSlug}/${packageId}`;
}

/**
 * Publish (or re-publish) a workspace program from its NormalizedProgramConfig.
 * Idempotent upsert; re-publishing the same version updates its manifest, a new
 * version bumps `latestVersion`.
 */
export async function publishProgram({ workspaceSlug, config, publishedByUserId }) {
  const packageId = publishedPackageId(workspaceSlug, config.packageId);

  const program = await prisma.marketplaceProgram.upsert({
    where: { packageId },
    update: {
      latestVersion: config.version,
      displayName: config.displayName || config.packageId,
      description: config.description || null,
      publishedByUserId,
    },
    create: {
      packageId,
      publisher: workspaceSlug,
      verified: false,
      latestVersion: config.version,
      displayName: config.displayName || config.packageId,
      description: config.description || null,
      publishedByUserId,
    },
  });

  const version = await prisma.programVersion.upsert({
    where: { programId_version: { programId: program.id, version: config.version } },
    update: {
      manifestJson: JSON.stringify(config),
      requiredTools: [],
      ports: (config.ports || []).map((p) => String(p)),
    },
    create: {
      programId: program.id,
      version: config.version,
      manifestJson: JSON.stringify(config),
      requiredTools: [],
      ports: (config.ports || []).map((p) => String(p)),
    },
  });

  return { program, version };
}

/** Allow-listed public projection of a published program (never the manifest). */
export function toPublicMarketplaceProgram(row) {
  if (!row) return row;
  return {
    id: row.id,
    packageId: row.packageId,
    publisher: row.publisher,
    verified: row.verified,
    latestVersion: row.latestVersion,
    displayName: row.displayName ?? null,
    description: row.description ?? null,
    installCount: row.installCount ?? 0,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/lib/programs/store.js "synthi/src/lib/programs/__tests__/store.test.js"
git commit -m "feat(slice3-p5): publishProgram + toPublicMarketplaceProgram store helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Store — browse/search + version lookup + install count

**Files:**
- Modify: `synthi/src/lib/programs/store.js`
- Test: `synthi/src/lib/programs/__tests__/store.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `synthi/src/lib/programs/__tests__/store.test.js` (import `listPublishedPrograms`, `getPublishedProgramVersion`, `incrementInstallCount`):

```js
describe('listPublishedPrograms', () => {
  it('returns published programs (publisher != local) filtered by query, ordered by installCount', async () => {
    h.prisma.marketplaceProgram.findMany.mockResolvedValue([
      { id: 'p1', packageId: '@team/web', publisher: 'team', verified: false, latestVersion: '1.0.0', displayName: 'Web', description: null, installCount: 5 },
    ]);

    const list = await listPublishedPrograms({ q: 'web', limit: 10 });

    const arg = h.prisma.marketplaceProgram.findMany.mock.calls[0][0];
    expect(arg.where.publisher).toEqual({ not: 'local' });
    expect(arg.where.OR).toEqual([
      { packageId: { contains: 'web', mode: 'insensitive' } },
      { displayName: { contains: 'web', mode: 'insensitive' } },
      { publisher: { contains: 'web', mode: 'insensitive' } },
    ]);
    expect(arg.orderBy).toEqual({ installCount: 'desc' });
    expect(arg.take).toBe(10);
    expect(list[0]).toEqual({ id: 'p1', packageId: '@team/web', publisher: 'team', verified: false, latestVersion: '1.0.0', displayName: 'Web', description: null, installCount: 5 });
  });

  it('omits the OR clause when no query is given', async () => {
    h.prisma.marketplaceProgram.findMany.mockResolvedValue([]);
    await listPublishedPrograms({});
    const arg = h.prisma.marketplaceProgram.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ publisher: { not: 'local' } });
  });
});

describe('getPublishedProgramVersion', () => {
  it('resolves a published program + version + parsed config', async () => {
    h.prisma.marketplaceProgram.findUnique.mockResolvedValue({ id: 'p1', packageId: '@team/web', publisher: 'team' });
    h.prisma.programVersion.findUnique.mockResolvedValue({ id: 'v1', manifestJson: JSON.stringify({ packageId: 'web', version: '1.0.0', launch: 'npm run dev', permissions: ['program.launch'] }) });

    const found = await getPublishedProgramVersion('@team/web', '1.0.0');

    expect(found.program.id).toBe('p1');
    expect(found.config.launch).toBe('npm run dev');
    expect(h.prisma.programVersion.findUnique).toHaveBeenCalledWith({ where: { programId_version: { programId: 'p1', version: '1.0.0' } } });
  });

  it('returns null for a local (non-published) packageId', async () => {
    h.prisma.marketplaceProgram.findUnique.mockResolvedValue({ id: 'p1', packageId: 'local:team:web', publisher: 'local' });
    const found = await getPublishedProgramVersion('local:team:web', '1.0.0');
    expect(found).toBeNull();
  });
});

describe('incrementInstallCount', () => {
  it('atomically increments the program installCount', async () => {
    h.prisma.marketplaceProgram.update.mockResolvedValue({ id: 'p1', installCount: 6 });
    await incrementInstallCount('p1');
    expect(h.prisma.marketplaceProgram.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { installCount: { increment: 1 } } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/store.test.js`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement in `store.js`** (after the Task-2 helpers)

```js
/** Browse/search the global published catalog (publisher != 'local'). */
export async function listPublishedPrograms({ q = '', limit = 50 } = {}) {
  const trimmed = String(q || '').trim();
  const rows = await prisma.marketplaceProgram.findMany({
    where: {
      publisher: { not: 'local' },
      ...(trimmed
        ? {
            OR: [
              { packageId: { contains: trimmed, mode: 'insensitive' } },
              { displayName: { contains: trimmed, mode: 'insensitive' } },
              { publisher: { contains: trimmed, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { installCount: 'desc' },
    take: limit,
  });
  return rows.map(toPublicMarketplaceProgram);
}

/** Resolve a published program + version + parsed manifest config (or null). */
export async function getPublishedProgramVersion(packageId, version) {
  const program = await prisma.marketplaceProgram.findUnique({ where: { packageId } });
  if (!program || program.publisher === 'local') return null;
  const versionRow = await prisma.programVersion.findUnique({
    where: { programId_version: { programId: program.id, version } },
  });
  if (!versionRow || !versionRow.manifestJson) return null;
  const config = parseJsonText(versionRow.manifestJson, null);
  if (!config) return null;
  return { program, version: versionRow, config };
}

/** Bump a program's denormalized install counter (reputation signal). */
export async function incrementInstallCount(programId) {
  return prisma.marketplaceProgram.update({
    where: { id: programId },
    data: { installCount: { increment: 1 } },
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/lib/programs/store.js "synthi/src/lib/programs/__tests__/store.test.js"
git commit -m "feat(slice3-p5): catalog browse/search + published version lookup + install count

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: API — publish route + catalog browse route

**Files:**
- Create: `synthi/src/app/api/workspace/[slug]/programs/publish/route.js`
- Modify: `synthi/src/app/api/workspace/[slug]/programs/marketplace/route.js`
- Test: `synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js`

- [ ] **Step 1: Write the failing tests**

In `programRoutes.test.js`, extend the hoisted `h` mock with the new store fns + import the publish route. Add to the `vi.hoisted` object: `publishProgram: vi.fn(), listPublishedPrograms: vi.fn(), getPublishedProgramVersion: vi.fn(), incrementInstallCount: vi.fn()`. Add them to the `@/lib/programs/store` mock factory. Add the import `import { POST as POST_PUBLISH } from '../publish/route.js';`. Then add:

```js
describe('POST /programs/publish', () => {
  it('publishes the workspace manifest for an owner/admin', async () => {
    h.discoverManifest.mockResolvedValue({ config: { packageId: 'web', version: '1.0.0', displayName: 'Web', description: 'd', permissions: ['program.launch'] }, source: 'vectant.programs.json' });
    h.publishProgram.mockResolvedValue({ program: { id: 'p1', packageId: '@team/web', publisher: 'team', verified: false, latestVersion: '1.0.0', displayName: 'Web', description: 'd', installCount: 0 } });

    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', {}, 'POST'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    expect(h.publishProgram).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', publishedByUserId: 'u1' }));
    const body = await res.json();
    expect(body.program).toMatchObject({ packageId: '@team/web', publisher: 'team' });
  });

  it('rejects publish for a plain member (403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.publishProgram).not.toHaveBeenCalled();
  });

  it('returns 404 when there is no workspace manifest to publish', async () => {
    h.discoverManifest.mockResolvedValue(null);
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(404);
  });
});
```

And replace the existing `GET /programs/marketplace` describe block's first test to assert the **published catalog** (the route now returns published programs, with `q`):

```js
describe('GET /programs/marketplace', () => {
  it('returns the published catalog (search) for a member', async () => {
    h.listPublishedPrograms.mockResolvedValue([
      { id: 'p1', packageId: '@team/web', publisher: 'team', verified: false, latestVersion: '1.0.0', displayName: 'Web', description: null, installCount: 3 },
    ]);

    const res = await GET_MARKETPLACE(req('http://x/api/workspace/team/programs/marketplace?q=web'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    expect(h.listPublishedPrograms).toHaveBeenCalledWith({ q: 'web' });
    const body = await res.json();
    expect(body.programs[0]).toMatchObject({ packageId: '@team/web', publisher: 'team', installCount: 3 });
  });

  it('rejects a non-member', async () => {
    h.canRead.mockResolvedValue(false);
    const res = await GET_MARKETPLACE(req('http://x/api/workspace/team/programs/marketplace'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.listPublishedPrograms).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run "src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js"`
Expected: FAIL — publish route module missing / marketplace still calls `listLocalPrograms`.

- [ ] **Step 3: Create the publish route**

Create `synthi/src/app/api/workspace/[slug]/programs/publish/route.js`:

```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { publishProgram, toPublicMarketplaceProgram } from '@/lib/programs/store';
import { discoverManifest } from '@/lib/programs/runtimeClient';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/publish
// Owner/admin: publish this workspace's recipe to the catalog as @<slug>/<name>.
export async function POST(_req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let discovered;
  try {
    discovered = await discoverManifest(slug, actor.userId);
  } catch (error) {
    if (error?.name === 'ProgramManifestError') {
      return NextResponse.json({ error: 'manifest_invalid', code: error.code, field: error.field, message: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: 'program_runtime_unreachable', message: error?.message || 'program runtime error' }, { status: 502 });
  }
  if (!discovered) {
    return NextResponse.json({ error: 'manifest_not_found' }, { status: 404 });
  }

  const { program } = await publishProgram({
    workspaceSlug: slug,
    config: discovered.config,
    publishedByUserId: actor.userId,
  });

  return NextResponse.json({ program: toPublicMarketplaceProgram(program) });
}
```

- [ ] **Step 4: Rewrite the marketplace route to return the published catalog**

Replace `synthi/src/app/api/workspace/[slug]/programs/marketplace/route.js` with:

```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { listPublishedPrograms } from '@/lib/programs/store';

export const runtime = 'nodejs';

// GET /api/workspace/:slug/programs/marketplace?q=
// Member-readable: browse/search the global published catalog.
export async function GET(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canReadScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const q = new URL(req.url).searchParams.get('q') || '';
  const programs = await listPublishedPrograms({ q });
  return NextResponse.json({ programs });
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run "src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "synthi/src/app/api/workspace/[slug]/programs/publish/route.js" "synthi/src/app/api/workspace/[slug]/programs/marketplace/route.js" "synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js"
git commit -m "feat(slice3-p5): publish route + catalog browse route

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: API — install a published program

**Files:**
- Modify: `synthi/src/app/api/workspace/[slug]/programs/install/route.js`
- Test: `synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js`

- [ ] **Step 1: Write the failing tests**

Add to the install describe in `programRoutes.test.js`:

```js
  it('installs a published program by packageId+version and bumps installCount', async () => {
    h.getPublishedProgramVersion.mockResolvedValue({
      program: { id: 'pubprog', packageId: '@other/web', publisher: 'other' },
      version: { id: 'v1' },
      config: { packageId: 'web', version: '1.0.0', permissions: ['program.launch'] },
    });
    h.listPermissionGrants.mockResolvedValue([{ id: 'g0', scopes: ['program.launch'] }]);
    h.createInstall.mockResolvedValue({ id: 'inst2', version: '1.0.0', status: 'installed' });

    const res = await POST_INSTALL(
      req('http://x/api/workspace/team/programs/install', { packageId: '@other/web', version: '1.0.0' }, 'POST'),
      ctx({ slug: 'team' }),
    );

    expect(res.status).toBe(200);
    expect(h.discoverManifest).not.toHaveBeenCalled();
    expect(h.createInstall).toHaveBeenCalledWith(expect.objectContaining({ programId: 'pubprog', version: '1.0.0', status: 'installed' }));
    expect(h.incrementInstallCount).toHaveBeenCalledWith('pubprog');
  });

  it('returns 404 when the published program/version is not found', async () => {
    h.getPublishedProgramVersion.mockResolvedValue(null);
    const res = await POST_INSTALL(
      req('http://x/api/workspace/team/programs/install', { packageId: '@other/web', version: '9.9.9', grantScopes: ['program.launch'] }, 'POST'),
      ctx({ slug: 'team' }),
    );
    expect(res.status).toBe(404);
  });

  it('does not bump installCount for a local workspace-manifest install', async () => {
    h.discoverManifest.mockResolvedValue(manifest);
    h.listPermissionGrants.mockResolvedValue([{ id: 'g0', scopes: ['program.launch', 'network.outbound'] }]);
    h.upsertLocalProgram.mockResolvedValue({ program: { id: 'prog1', packageId: 'local:team:web', publisher: 'local' } });
    h.createInstall.mockResolvedValue({ id: 'inst1', version: '1.0.0', status: 'installed' });

    await POST_INSTALL(req('http://x/api/workspace/team/programs/install', {}, 'POST'), ctx({ slug: 'team' }));
    expect(h.incrementInstallCount).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run "src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js"`
Expected: FAIL — install route ignores `packageId`/doesn't call `getPublishedProgramVersion`/`incrementInstallCount`.

- [ ] **Step 3: Rewrite the install route to support both paths**

Replace the body of `POST` in `synthi/src/app/api/workspace/[slug]/programs/install/route.js` (keep the imports; add `getPublishedProgramVersion`, `incrementInstallCount` to the store import, and `upsertLocalProgram` stays):

```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import {
  listPermissionGrants,
  createPermissionGrant,
  upsertLocalProgram,
  createInstall,
  toPublicInstall,
  getPublishedProgramVersion,
  incrementInstallCount,
} from '@/lib/programs/store';
import { discoverManifest } from '@/lib/programs/runtimeClient';
import { normalizeGrantScopes, PROGRAM_LAUNCH_SCOPE } from '@/lib/programs/routeHelpers';

export const runtime = 'nodejs';

function grantCoversScopes(grant, requiredScopes) {
  const scopes = Array.isArray(grant?.scopes) ? grant.scopes : [];
  return requiredScopes.every((scope) => scopes.includes(scope));
}

// POST /api/workspace/:slug/programs/install
// Owner/admin. Two paths, both gated by a consent PermissionGrant covering the
// manifest's declared scopes:
//   - published install: body { packageId, version } → manifest from the catalog
//   - local install:     no packageId → discover the workspace recipe
export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));

  let config;
  let programId;
  let publishedProgramId = null;

  if (body.packageId && body.version) {
    const found = await getPublishedProgramVersion(body.packageId, body.version);
    if (!found) {
      return NextResponse.json({ error: 'program_not_found' }, { status: 404 });
    }
    config = found.config;
    programId = found.program.id;
    publishedProgramId = found.program.id;
  } else {
    let discovered;
    try {
      discovered = await discoverManifest(slug, actor.userId);
    } catch (error) {
      if (error?.name === 'ProgramManifestError') {
        return NextResponse.json({ error: 'manifest_invalid', code: error.code, field: error.field, message: error.message }, { status: 422 });
      }
      return NextResponse.json({ error: 'program_runtime_unreachable', message: error?.message || 'program runtime error' }, { status: 502 });
    }
    if (!discovered) {
      return NextResponse.json({ error: 'manifest_not_found' }, { status: 404 });
    }
    config = discovered.config;
    const { program } = await upsertLocalProgram({ workspaceSlug: slug, config });
    programId = program.id;
  }

  const requiredScopes = Array.isArray(config.permissions) && config.permissions.length
    ? config.permissions
    : [PROGRAM_LAUNCH_SCOPE];

  const existingGrants = await listPermissionGrants({ workspaceSlug: slug });
  let grant = existingGrants.find((candidate) => grantCoversScopes(candidate, requiredScopes)) || null;

  if (!grant) {
    const requestedScopes = normalizeGrantScopes(body.grantScopes);
    const coversRequired = requiredScopes.every((scope) => requestedScopes.includes(scope));
    if (!coversRequired) {
      return NextResponse.json(
        { error: 'consent_required', code: 'consent_required', requested: requiredScopes },
        { status: 409 },
      );
    }
    const scopes = requestedScopes.includes(PROGRAM_LAUNCH_SCOPE)
      ? requestedScopes
      : [PROGRAM_LAUNCH_SCOPE, ...requestedScopes];
    grant = await createPermissionGrant({ workspaceSlug: slug, scopes, grantedByUserId: actor.userId });
  }

  const install = await createInstall({
    programId,
    workspaceSlug: slug,
    version: config.version,
    installedByUserId: actor.userId,
    grantId: grant.id,
    status: 'installed',
  });

  if (publishedProgramId) {
    await incrementInstallCount(publishedProgramId);
  }

  return NextResponse.json({
    install: toPublicInstall({ ...install, program: { id: programId, packageId: body.packageId || null } }),
    program: { id: programId },
    grant,
  });
}
```

> Note: the local-install response previously echoed `program.packageId/publisher` from `upsertLocalProgram`. To keep both paths uniform and avoid a second lookup, the response now returns `{ id: programId }`; the existing local-install test asserts `body.install` via `toPublicInstall` and `body.grant` — confirm those still pass (they assert `id`, `version`, `status`, and `grant.id`, which are unaffected). If a test asserts the local `packageId`, keep passing the local program through `toPublicInstall` for that branch (the published branch has no local packageId to echo).

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run "src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js"`
Expected: PASS. If the pre-existing local-install test asserted `body.install.packageId === 'local:team:web'`, restore that branch's program echo: in the local path keep a `programRow` and pass `{ ...install, program: programRow }` to `toPublicInstall`.

- [ ] **Step 5: Commit**

```bash
git add "synthi/src/app/api/workspace/[slug]/programs/install/route.js" "synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js"
git commit -m "feat(slice3-p5): install published catalog programs + bump installCount

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: UI — Publish action + Marketplace browse/install

**Files:**
- Modify: `synthi/src/components/programs/programsClient.js`
- Modify: `synthi/src/components/programs/ProgramsPanel.jsx`
- Test: `synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx`

- [ ] **Step 1: Add the client functions**

In `synthi/src/components/programs/programsClient.js`, after `installWorkspaceProgram`:

```js
export async function publishWorkspaceProgram(workspaceSlug) {
  return request(`${programsBase(workspaceSlug)}/publish`, { method: 'POST', body: JSON.stringify({}) });
}

export async function fetchMarketplace(workspaceSlug, q = '') {
  if (!workspaceSlug) return [];
  const suffix = q ? `?q=${encodeURIComponent(q)}` : '';
  const body = await request(`${programsBase(workspaceSlug)}/marketplace${suffix}`);
  return body.programs || [];
}

export async function installPublishedProgram(workspaceSlug, packageId, version, grantScopes) {
  return request(`${programsBase(workspaceSlug)}/install`, {
    method: 'POST',
    body: JSON.stringify({ packageId, version, ...(grantScopes ? { grantScopes } : {}) }),
  });
}
```

- [ ] **Step 2: Write the failing UI tests**

In `synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx`, extend the hoisted `h` with `publishWorkspaceProgram: vi.fn()`, `fetchMarketplace: vi.fn()`, `installPublishedProgram: vi.fn()` and add them to the `../programsClient` mock factory. In `beforeEach`, default `h.fetchMarketplace.mockResolvedValue([])`. Add:

```js
  it('publishes the workspace program when an owner clicks Publish', async () => {
    h.publishWorkspaceProgram.mockResolvedValue({ program: { packageId: '@team/web', publisher: 'team' } });
    await render();
    await act(async () => { byTestId(container, 'publish-program').click(); });
    await flush();
    expect(h.publishWorkspaceProgram).toHaveBeenCalledWith('team');
  });

  it('lists the published catalog and installs a published program', async () => {
    h.fetchMarketplace.mockResolvedValue([{ id: 'p1', packageId: '@other/web', publisher: 'other', displayName: 'Web', installCount: 4, verified: false, latestVersion: '1.0.0' }]);
    h.installPublishedProgram.mockResolvedValue({ install: { id: 'inst9', packageId: '@other/web', version: '1.0.0', status: 'installed' } });
    await render();
    const card = byTestId(container, 'marketplace-item-@other/web');
    expect(card).not.toBeNull();
    await act(async () => { byTestId(container, 'install-published-@other/web').click(); });
    await flush();
    expect(h.installPublishedProgram).toHaveBeenCalledWith('team', '@other/web', '1.0.0', undefined);
  });

  it('hides the Publish action for a plain member', async () => {
    h.state.workspace.role = 'member';
    await render();
    expect(byTestId(container, 'publish-program')).toBeNull();
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/components/programs/__tests__/programsPanelInstall.test.jsx`
Expected: FAIL — testids not present.

- [ ] **Step 4: Implement the UI in `ProgramsPanel.jsx`**

Add imports (`publishWorkspaceProgram`, `fetchMarketplace`, `installPublishedProgram` from `./programsClient`; the `Store`/`UploadCloud` lucide icons if desired). Add state + load:

```js
  const [marketplace, setMarketplace] = useState([]);
  const [marketQuery, setMarketQuery] = useState('');
  const [publishing, setPublishing] = useState(false);
```

In the existing `load()` (where sessions+installs are fetched in parallel), also fetch the catalog:

```js
      const [nextSessions, nextInstalls, nextMarket] = await Promise.all([
        fetchProgramSessions(workspaceSlug),
        fetchInstalledPrograms(workspaceSlug),
        fetchMarketplace(workspaceSlug, marketQuery),
      ]);
      setMarketplace(Array.isArray(nextMarket) ? nextMarket : []);
```

Add handlers:

```js
  const handlePublish = useCallback(async () => {
    setPublishing(true);
    try {
      const { program } = await publishWorkspaceProgram(workspaceSlug);
      toast.success(`Published ${program?.packageId || 'program'}`);
      await load();
    } catch (error) {
      if (error?.status === 422) toast.error(error.body?.message || 'Invalid manifest');
      else if (error?.status === 404) toast.error('No vectant.programs.json or devcontainer.json found in this workspace.');
      else toast.error(error.body?.message || error.message || 'Failed to publish');
    } finally {
      setPublishing(false);
    }
  }, [load, workspaceSlug]);

  const handleInstallPublished = useCallback(async (item, grantScopes) => {
    try {
      await installPublishedProgram(workspaceSlug, item.packageId, item.latestVersion, grantScopes);
      toast.success(`Installed ${item.packageId}`);
      await load();
    } catch (error) {
      if (error?.status === 409) setConsent({ requested: error.body?.requested || [], published: item });
      else toast.error(error.body?.message || error.message || 'Failed to install');
    }
  }, [load, workspaceSlug]);
```

Render (gated by `canManage`): a Publish button in the toolbar near "Install from manifest", and a Marketplace section listing `marketplace` items:

```jsx
        {canManage ? (
          <button type="button" data-testid="publish-program" onClick={handlePublish} disabled={publishing}
            className="h-8 px-3 rounded border text-xs inline-flex items-center gap-1.5"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
            Publish to marketplace
          </button>
        ) : null}

        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Marketplace</div>
          {marketplace.length === 0 ? (
            <div className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>No published programs yet.</div>
          ) : marketplace.map((item) => (
            <div key={item.packageId} data-testid={`marketplace-item-${item.packageId}`}
              className="rounded-md border px-3 py-2 mt-2 flex items-center justify-between gap-3"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
              <div className="min-w-0">
                <div className="text-sm truncate">{item.displayName || item.packageId}</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{item.packageId} · {item.installCount} installs</div>
              </div>
              {canManage ? (
                <button type="button" data-testid={`install-published-${item.packageId}`}
                  onClick={() => handleInstallPublished(item, undefined)}
                  className="h-7 px-2 rounded border text-[11px]"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
                  Install
                </button>
              ) : null}
            </div>
          ))}
        </div>
```

(If the existing consent prompt's approve handler only re-submits manifest installs, extend it: when `consent.published` is set, `handleInstallPublished(consent.published, consent.requested)` on approve; else the existing manifest path.)

- [ ] **Step 5: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/components/programs/__tests__/programsPanelInstall.test.jsx`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 6: Commit**

```bash
git add synthi/src/components/programs/programsClient.js synthi/src/components/programs/ProgramsPanel.jsx "synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx"
git commit -m "feat(slice3-p5): Programs panel publish action + marketplace browse/install

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Regression + security sweep + review

**Files:**
- Modify: `tasks/todo.md`

- [ ] **Step 1: Targeted suites**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs "src/app/api/workspace/[slug]/programs" src/components/programs`
Expected: PASS.

- [ ] **Step 2: Backend unchanged sanity check**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --test backend/collab-server/__tests__/programRuntimeManager.test.js`
Expected: PASS — 21 (no backend changes this phase).

- [ ] **Step 3: Full regression**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run`
Expected: PASS — accept ONLY the known empty `src/lib/__tests__/preview-store.test.js` stub failure.

- [ ] **Step 4: Prisma confirm**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx prisma generate && npx prisma db push`
Expected: client generated; db push "already in sync" (Task 1 already applied the columns).

- [ ] **Step 5: Security checklist (each pinned by a test)**

Record in `tasks/todo.md`:
- Publish/install require owner/admin (`canWriteScope`); browse requires member (`canReadScope`). (route tests)
- Published install still gates on consent → `PermissionGrant` covering the manifest's declared scopes (409 otherwise). (route test)
- `toPublicMarketplaceProgram` never leaks `manifestJson`/`versions`. (store test)
- Published manifests are parsed through `parseProgramManifest` (at publish-time via discoverManifest) — same fail-closed validation; install reads the already-validated stored config. (route + store)
- Namespace `@<slug>/...` prevents cross-workspace name squatting; `publisher != 'local'` cleanly separates catalog from local rows. (store test)

- [ ] **Step 6: Phase-5 review + mark tasks in `tasks/todo.md`**, then commit:

```bash
git add tasks/todo.md
git commit -m "docs(slice3-p5): open-marketplace v1 complete — publish/browse/install

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## DEFERRED — later Phase-5 follow-ups (not in v1)

> Documented so they aren't lost; each is its own slice with its own tests.

- [ ] **Cryptographic signing + verify** — sign a `ProgramVersion` (publisher key or server key); verify on install; show a signed/verified badge. Needs a key-management design.
- [ ] **Ratings / reviews** — a `ProgramReview` model (rating + text), aggregate score, moderation; sort/filter by rating.
- [ ] **Abuse controls** — report a program, a `disabled`/`disabledReason` flag on `MarketplaceProgram` (hide disabled from browse + block install), publish rate-limits (reuse the Slice-1 rate-limit infra), takedown.
- [ ] **Visibility** — private/unlisted publishing (per-workspace or org-scoped catalogs) vs the current global catalog.
- [ ] **Version pinning / update flow** — install a specific version, surface "update available" when `latestVersion` advances.

---

## Self-Review

**1. Spec coverage** — Publish (T2 store + T4 route + T6 UI), Browse/search (T3 store + T4 route + T6 UI), Install-from-catalog (T3+T5 + T6), Reputation = installCount (T3 store + T5 bump + T6 display). Signing/reviews/abuse explicitly deferred. Schema + manifest description (T1). ✅ no v1 gaps.

**2. Placeholder scan** — every code step is complete. The one conditional note (local-install `packageId` echo in T5 Step 4) gives the exact fallback code, not a vague "handle it".

**3. Type consistency** — `publishedPackageId(slug, id) → '@slug/id'`; `publishProgram(...) → { program, version }`; `listPublishedPrograms({q,limit}) → toPublicMarketplaceProgram[]`; `getPublishedProgramVersion(packageId, version) → { program, version, config } | null`; `incrementInstallCount(programId)`. Routes/UI/tests use these exact names. `toPublicMarketplaceProgram` field set is identical across store test, route, and UI.

**4. Test independence** — store tests drive the hoisted prisma mock; route tests mock store+session+scope+runtimeClient; UI tests use the jsdom harness. No live DB/network/Docker.
