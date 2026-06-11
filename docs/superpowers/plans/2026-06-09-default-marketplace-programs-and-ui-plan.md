# Default Marketplace Programs + Programs Panel UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed 7 official `@vectant/*` default programs (spanning web/background/tui/devcontainer) into the marketplace for every user, and restyle the whole Programs panel to be on-brand — with no store/route logic changes (Phase 5 already supports non-`local` publishers).

**Architecture:** A canonical `defaultPrograms.js` (single source of truth) builds + validates each default through the existing `parseProgramManifest` / `importDevcontainer`, and `ensureDefaultPrograms(prisma)` idempotently upserts them as `MarketplaceProgram` (`publisher:'vectant'`, `verified:true`) + `ProgramVersion`. An env-flag-gated `POST /api/programs/seed-defaults` route runs the seed inside Next's runtime. The Programs panel gains a Verified badge + a cohesive on-brand card system; all existing `data-testid`s and wiring are preserved.

**Tech Stack:** Next.js App Router API + React (`synthi/`, Vitest from the `synthi/` dir; jsdom via `react-dom/client` + `act`), Prisma/Postgres. Spec: `docs/superpowers/specs/2026-06-09-default-marketplace-programs-and-ui-design.md`.

**Constraints:** Branch `tool-compatibility` only (no merge/PR/finish). TDD only (`vitest` / `node --test` / `prisma generate|db push`); no `next build`/`docker build` without checking Docker free space. Run vitest from `synthi/` (v4.1.8 has the `@/` alias). Stage specific files only; every commit ends with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. No schema change. Don't touch the known noise files. `cd` explicitly each Bash call (git resets cwd to repo root).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `synthi/src/lib/programs/defaultPrograms.js` | canonical default catalog: recipes + `buildDefaultPrograms()` + `ensureDefaultPrograms(prisma)` | Create |
| `synthi/src/lib/programs/__tests__/defaultPrograms.test.js` | build/validate + upsert tests | Create |
| `synthi/src/app/api/programs/seed-defaults/route.js` | env-gated authenticated POST that runs the seed | Create |
| `synthi/src/app/api/programs/__tests__/seedDefaultsRoute.test.js` | route tests | Create |
| `synthi/src/components/programs/ProgramsPanel.jsx` | Verified badge + marketplace card redesign + panel-wide on-brand restyle | Modify |
| `synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx` | verified-badge test | Modify |
| `tasks/todo.md` | task tracking + review | Modify |

**Reference facts (verified in the codebase):**
- `parseProgramManifest(obj)` → `{ packageId, version, displayName, description, runtimeType, workingDir, install, launch, env, ports, surfaces, health, permissions, source, sourceHints }`. Required: `packageId`, `version`, `launch`. `KNOWN_SCOPES = ['program.launch','workspace.files.read','workspace.files.write','network.outbound','ports.expose']`. `SUPPORTED_RUNTIME_TYPES = ['web','cli','tui','background','gui']`.
- `importDevcontainer(dc)` → `{ config, strippedEnvKeys, warnings }`; `config.source='devcontainer.json'`, `config.sourceHints.containerImage` set from `dc.image`; `launch` from `postStartCommand` (else `sleep infinity`); `runtimeType` = `web` if `forwardPorts` else `background`; it sets `config.description=''` (no devcontainer description field).
- `publishProgram` in `store.js` is the upsert shape to mirror (where/update/create on `marketplaceProgram`, then `programVersion.upsert` with `programId_version`).
- `toPublicMarketplaceProgram` already returns `verified` + `description` + `installCount`. `listPublishedPrograms` returns `publisher != 'local'` rows. So `publisher:'vectant'` rows browse + install with **zero store/route changes**.
- Prisma client: `import prisma from '@/lib/prisma'` (default export).
- ProgramsPanel marketplace card currently renders `item.displayName || item.packageId` + `{item.packageId} · {item.installCount} installs` + an `install-published-${item.packageId}` button. The `data-testid="marketplace-item-${item.packageId}"` wrapper exists.

---

## Task 1: Default catalog module — recipes + `buildDefaultPrograms()`

**Files:**
- Create: `synthi/src/lib/programs/defaultPrograms.js`
- Test: `synthi/src/lib/programs/__tests__/defaultPrograms.test.js`

- [ ] **Step 1: Write the failing test**

Create `synthi/src/lib/programs/__tests__/defaultPrograms.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROGRAM_RECIPES, buildDefaultPrograms } from '../defaultPrograms';
import { SUPPORTED_RUNTIME_TYPES, KNOWN_SCOPES } from '../manifest';

describe('buildDefaultPrograms', () => {
  const built = buildDefaultPrograms();

  it('builds one valid @vectant/<name> program per recipe', () => {
    expect(built.length).toBe(DEFAULT_PROGRAM_RECIPES.length);
    expect(built.length).toBe(7);
    for (const { packageId, config } of built) {
      expect(packageId).toMatch(/^@vectant\/[a-z0-9._-]+$/);
      expect(SUPPORTED_RUNTIME_TYPES).toContain(config.runtimeType);
      expect(typeof config.launch).toBe('string');
      expect(config.launch.length).toBeGreaterThan(0);
      expect(config.version).toBe('1.0.0');
      expect(config.displayName.length).toBeGreaterThan(0);
      expect(config.description.length).toBeGreaterThan(0);
      for (const scope of config.permissions) expect(KNOWN_SCOPES).toContain(scope);
    }
  });

  it('spans non-web runtime types (background + tui with no ports)', () => {
    const byId = Object.fromEntries(built.map((b) => [b.packageId, b.config]));
    expect(byId['@vectant/node-worker'].runtimeType).toBe('background');
    expect(byId['@vectant/node-worker'].ports).toEqual([]);
    expect(byId['@vectant/lazygit'].runtimeType).toBe('tui');
    expect(byId['@vectant/lazygit'].ports).toEqual([]);
  });

  it('builds the Dev Container default via the devcontainer importer', () => {
    const dc = built.find((b) => b.packageId === '@vectant/devcontainer').config;
    expect(dc.source).toBe('devcontainer.json');
    expect(dc.sourceHints.containerImage).toMatch(/devcontainers/);
    expect(dc.ports).toContain(3000);
    expect(dc.launch).toBe('npm run dev');
    expect(dc.description.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/defaultPrograms.test.js`
Expected: FAIL — `defaultPrograms` module not found.

- [ ] **Step 3: Implement `defaultPrograms.js` (recipes + builder)**

Create `synthi/src/lib/programs/defaultPrograms.js`:

```js
/**
 * @fileoverview Canonical default marketplace catalog (single source of truth).
 *
 * These ship for every user as official `@vectant/*` programs (publisher
 * 'vectant', verified). Each recipe is validated through the SAME fail-closed
 * path as any user recipe — `parseProgramManifest` for manifest recipes,
 * `importDevcontainer` for the Dev Container. Real container execution is NOT
 * introduced here; the Dev Container runs in the managed session today (native
 * Docker is a separate future slice — see tasks/todo.md backlog).
 */

import { parseProgramManifest } from './manifest';
import { importDevcontainer } from './devcontainer';

const WEB_SCOPES = ['program.launch', 'network.outbound', 'ports.expose'];

/**
 * @typedef {{ name: string, kind: 'manifest'|'devcontainer', recipe: object, description?: string }} DefaultRecipe
 */

/** @type {DefaultRecipe[]} */
export const DEFAULT_PROGRAM_RECIPES = [
  {
    name: 'nextjs-dev',
    kind: 'manifest',
    recipe: {
      packageId: 'nextjs-dev', version: '1.0.0',
      displayName: 'Next.js Dev Server',
      description: 'Next.js development server with hot reload (port 3000).',
      runtimeType: 'web', install: ['npm install'], launch: 'npm run dev',
      ports: [3000], permissions: WEB_SCOPES,
    },
  },
  {
    name: 'vite-react',
    kind: 'manifest',
    recipe: {
      packageId: 'vite-react', version: '1.0.0',
      displayName: 'Vite + React',
      description: 'Vite + React dev server with fast HMR (port 5173).',
      runtimeType: 'web', install: ['npm install'], launch: 'npm run dev',
      ports: [5173], permissions: WEB_SCOPES,
    },
  },
  {
    name: 'flask-api',
    kind: 'manifest',
    recipe: {
      packageId: 'flask-api', version: '1.0.0',
      displayName: 'Flask API',
      description: 'Python Flask API server (port 5000).',
      runtimeType: 'web', install: ['pip install -r requirements.txt'],
      launch: 'flask run --host 0.0.0.0 --port 5000',
      ports: [5000], permissions: WEB_SCOPES,
    },
  },
  {
    name: 'static-site',
    kind: 'manifest',
    recipe: {
      packageId: 'static-site', version: '1.0.0',
      displayName: 'Static Site',
      description: 'Static file server for HTML/CSS/JS (port 8080).',
      runtimeType: 'web', install: [], launch: 'npx http-server -p 8080',
      ports: [8080], permissions: WEB_SCOPES,
    },
  },
  {
    name: 'node-worker',
    kind: 'manifest',
    recipe: {
      packageId: 'node-worker', version: '1.0.0',
      displayName: 'Background Worker',
      description: 'Background Node.js worker process (no web port).',
      runtimeType: 'background', install: ['npm install'], launch: 'node worker.js',
      ports: [], permissions: ['program.launch', 'network.outbound'],
    },
  },
  {
    name: 'lazygit',
    kind: 'manifest',
    recipe: {
      packageId: 'lazygit', version: '1.0.0',
      displayName: 'lazygit (Git TUI)',
      description: 'lazygit terminal UI for Git.',
      runtimeType: 'tui', install: [], launch: 'lazygit',
      ports: [], permissions: ['program.launch'],
    },
  },
  {
    name: 'devcontainer',
    kind: 'devcontainer',
    description:
      "Containerized dev environment (devcontainer.json / Docker image). Runs in Vectant's managed runtime today; native Docker execution is on the roadmap.",
    recipe: {
      name: 'Dev Container', version: '1.0.0',
      image: 'mcr.microsoft.com/devcontainers/universal:2',
      forwardPorts: [3000],
      postCreateCommand: 'npm install',
      postStartCommand: 'npm run dev',
    },
  },
];

/**
 * Build the validated default catalog. Manifest recipes go through
 * parseProgramManifest; the devcontainer recipe through importDevcontainer.
 * @returns {{ packageId: string, config: object }[]}
 */
export function buildDefaultPrograms() {
  return DEFAULT_PROGRAM_RECIPES.map((entry) => {
    let config;
    if (entry.kind === 'devcontainer') {
      config = importDevcontainer(entry.recipe).config;
      if (entry.description) config.description = entry.description;
    } else {
      config = parseProgramManifest(entry.recipe);
    }
    return { packageId: `@vectant/${entry.name}`, config };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/defaultPrograms.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/HP/source/repos/synthi-ide
git add synthi/src/lib/programs/defaultPrograms.js "synthi/src/lib/programs/__tests__/defaultPrograms.test.js"
git commit -m "feat(programs): canonical default marketplace catalog (web/background/tui/devcontainer)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `ensureDefaultPrograms(prisma)` — idempotent upsert

**Files:**
- Modify: `synthi/src/lib/programs/defaultPrograms.js`
- Test: `synthi/src/lib/programs/__tests__/defaultPrograms.test.js`

- [ ] **Step 1: Write the failing test**

Append to `synthi/src/lib/programs/__tests__/defaultPrograms.test.js` (add `beforeEach`, `vi` to the vitest import line: `import { beforeEach, describe, expect, it, vi } from 'vitest';`):

```js
import { ensureDefaultPrograms } from '../defaultPrograms';

describe('ensureDefaultPrograms', () => {
  function makePrisma() {
    return {
      marketplaceProgram: { upsert: vi.fn(async ({ where }) => ({ id: `prog_${where.packageId}`, packageId: where.packageId })) },
      programVersion: { upsert: vi.fn(async () => ({ id: 'ver1' })) },
    };
  }

  it('upserts each default as a verified vectant program + its version', async () => {
    const prisma = makePrisma();
    const seeded = await ensureDefaultPrograms(prisma);

    expect(seeded).toContain('@vectant/nextjs-dev');
    expect(seeded.length).toBe(7);
    expect(prisma.marketplaceProgram.upsert).toHaveBeenCalledTimes(7);
    expect(prisma.programVersion.upsert).toHaveBeenCalledTimes(7);

    const arg = prisma.marketplaceProgram.upsert.mock.calls.find(
      (c) => c[0].where.packageId === '@vectant/nextjs-dev',
    )[0];
    expect(arg.create).toMatchObject({ packageId: '@vectant/nextjs-dev', publisher: 'vectant', verified: true, latestVersion: '1.0.0' });
    expect(arg.update).toMatchObject({ verified: true, latestVersion: '1.0.0' });
  });

  it('never writes installCount on update (preserves reputation on re-seed)', async () => {
    const prisma = makePrisma();
    await ensureDefaultPrograms(prisma);
    for (const call of prisma.marketplaceProgram.upsert.mock.calls) {
      expect(call[0].update).not.toHaveProperty('installCount');
      expect(call[0].create).not.toHaveProperty('installCount');
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/defaultPrograms.test.js`
Expected: FAIL — `ensureDefaultPrograms` is not exported.

- [ ] **Step 3: Implement `ensureDefaultPrograms`**

Append to `synthi/src/lib/programs/defaultPrograms.js`:

```js
/**
 * Idempotently upsert the default catalog. Mirrors store.publishProgram's
 * upsert shape but with publisher 'vectant' + verified true. The `update`
 * clause deliberately omits installCount so re-seeding preserves reputation.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<string[]>} the upserted packageIds
 */
export async function ensureDefaultPrograms(prisma) {
  const built = buildDefaultPrograms();
  const seeded = [];
  for (const { packageId, config } of built) {
    const program = await prisma.marketplaceProgram.upsert({
      where: { packageId },
      update: {
        verified: true,
        displayName: config.displayName,
        description: config.description || null,
        latestVersion: config.version,
      },
      create: {
        packageId,
        publisher: 'vectant',
        verified: true,
        displayName: config.displayName,
        description: config.description || null,
        latestVersion: config.version,
        publishedByUserId: null,
      },
    });
    await prisma.programVersion.upsert({
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
    seeded.push(packageId);
  }
  return seeded;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/defaultPrograms.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/HP/source/repos/synthi-ide
git add synthi/src/lib/programs/defaultPrograms.js "synthi/src/lib/programs/__tests__/defaultPrograms.test.js"
git commit -m "feat(programs): ensureDefaultPrograms idempotent upsert (preserves installCount)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Seed API route (env-gated, authenticated)

**Files:**
- Create: `synthi/src/app/api/programs/seed-defaults/route.js`
- Test: `synthi/src/app/api/programs/__tests__/seedDefaultsRoute.test.js`

- [ ] **Step 1: Write the failing test**

Create `synthi/src/app/api/programs/__tests__/seedDefaultsRoute.test.js`:

```js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  ensureDefaultPrograms: vi.fn(),
}));

vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/programs/defaultPrograms', () => ({ ensureDefaultPrograms: h.ensureDefaultPrograms }));

import { POST } from '../seed-defaults/route.js';

const prevFlag = process.env.ENABLE_PROGRAM_SEED;

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'u1', email: 'a@b.c' });
  h.ensureDefaultPrograms.mockResolvedValue(['@vectant/nextjs-dev']);
  delete process.env.ENABLE_PROGRAM_SEED;
});
afterEach(() => {
  if (prevFlag === undefined) delete process.env.ENABLE_PROGRAM_SEED;
  else process.env.ENABLE_PROGRAM_SEED = prevFlag;
});

describe('POST /api/programs/seed-defaults', () => {
  it('returns 401 when unauthenticated', async () => {
    process.env.ENABLE_PROGRAM_SEED = '1';
    h.actor.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
    expect(h.ensureDefaultPrograms).not.toHaveBeenCalled();
  });

  it('returns 404 when the seed flag is not enabled', async () => {
    const res = await POST();
    expect(res.status).toBe(404);
    expect(h.ensureDefaultPrograms).not.toHaveBeenCalled();
  });

  it('seeds when authenticated and the flag is enabled', async () => {
    process.env.ENABLE_PROGRAM_SEED = '1';
    const res = await POST();
    expect(res.status).toBe(200);
    expect(h.ensureDefaultPrograms).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.seeded).toEqual(['@vectant/nextjs-dev']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run "src/app/api/programs/__tests__/seedDefaultsRoute.test.js"`
Expected: FAIL — route module missing.

- [ ] **Step 3: Create the route**

Create `synthi/src/app/api/programs/seed-defaults/route.js`:

```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import prisma from '@/lib/prisma';
import { ensureDefaultPrograms } from '@/lib/programs/defaultPrograms';

export const runtime = 'nodejs';

// POST /api/programs/seed-defaults
// Idempotently seed the official @vectant/* default catalog. Inert unless the
// operator sets ENABLE_PROGRAM_SEED=1 (so it can't be triggered casually), and
// still requires an authenticated session.
export async function POST() {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (process.env.ENABLE_PROGRAM_SEED !== '1') {
    return NextResponse.json({ error: 'seed_disabled' }, { status: 404 });
  }

  const seeded = await ensureDefaultPrograms(prisma);
  return NextResponse.json({ seeded, count: seeded.length });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run "src/app/api/programs/__tests__/seedDefaultsRoute.test.js"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/HP/source/repos/synthi-ide
git add "synthi/src/app/api/programs/seed-defaults/route.js" "synthi/src/app/api/programs/__tests__/seedDefaultsRoute.test.js"
git commit -m "feat(programs): env-gated authenticated seed-defaults API route

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: UI — Verified badge + marketplace card redesign

**Files:**
- Modify: `synthi/src/components/programs/ProgramsPanel.jsx`
- Test: `synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx`

- [ ] **Step 1: Write the failing test**

In `synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx`, add after the existing `'lists the published catalog and installs a published program'` test:

```js
  it('shows a Verified badge only on verified marketplace programs and renders descriptions', async () => {
    h.fetchMarketplace.mockResolvedValue([
      { id: 'p1', packageId: '@vectant/nextjs-dev', publisher: 'vectant', displayName: 'Next.js Dev Server', description: 'Next.js development server with hot reload (port 3000).', installCount: 12, verified: true, latestVersion: '1.0.0' },
      { id: 'p2', packageId: '@other/web', publisher: 'other', displayName: 'Web', description: 'A community app', installCount: 1, verified: false, latestVersion: '1.0.0' },
    ]);
    await render();

    expect(byTestId(container, 'verified-badge-@vectant/nextjs-dev')).not.toBeNull();
    expect(byTestId(container, 'verified-badge-@other/web')).toBeNull();
    expect(byTestId(container, 'marketplace-item-@vectant/nextjs-dev').textContent).toContain('Next.js development server');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/components/programs/__tests__/programsPanelInstall.test.jsx`
Expected: FAIL — `verified-badge-@vectant/nextjs-dev` not found.

- [ ] **Step 3: Implement the redesigned marketplace card**

In `synthi/src/components/programs/ProgramsPanel.jsx`, first add `ShieldCheck` is already imported; ensure `BadgeCheck` is available — use the already-imported `ShieldCheck` for the badge. Replace the marketplace `marketplace.map((item) => (...))` block (the card markup inside the Marketplace `<section>`) with:

```jsx
            marketplace.map((item) => (
              <div
                key={item.packageId}
                data-testid={`marketplace-item-${item.packageId}`}
                className="group rounded-lg border px-3 py-2.5 flex items-center justify-between gap-3 transition-colors"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
              >
                <div className="min-w-0 flex items-start gap-2.5">
                  <div
                    className="mt-0.5 h-8 w-8 shrink-0 rounded-md flex items-center justify-center"
                    style={{ background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' }}
                  >
                    <Package className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-sm font-medium truncate">{item.displayName || item.packageId}</span>
                      {item.verified ? (
                        <span
                          data-testid={`verified-badge-${item.packageId}`}
                          title="Official Vectant program"
                          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
                          style={{ background: 'var(--brand-gradient-horizontal)', color: '#fff' }}
                        >
                          <ShieldCheck className="w-3 h-3" /> Verified
                        </span>
                      ) : null}
                    </div>
                    {item.description ? (
                      <div className="text-[11px] mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                        {item.description}
                      </div>
                    ) : null}
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {item.packageId} · {item.installCount || 0} installs
                    </div>
                  </div>
                </div>
                {canManage ? (
                  <button
                    type="button"
                    data-testid={`install-published-${item.packageId}`}
                    onClick={() => handleInstallPublished(item, undefined)}
                    className="shrink-0 h-7 px-2.5 rounded-md border text-[11px] inline-flex items-center gap-1 transition-colors"
                    style={{ borderColor: 'var(--border-medium)', color: 'var(--text-primary)' }}
                  >
                    <Download className="w-3 h-3" /> Install
                  </button>
                ) : null}
              </div>
            ))
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/components/programs/__tests__/programsPanelInstall.test.jsx`
Expected: PASS (existing + the new verified-badge test).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/HP/source/repos/synthi-ide
git add synthi/src/components/programs/ProgramsPanel.jsx "synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx"
git commit -m "feat(programs): marketplace card redesign + Verified badge + descriptions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: UI — cohesive on-brand panel restyle (visual polish)

> Presentational pass. No new behavior — guarded by the full programs suite staying green and all `data-testid`s preserved. Apply token-based styling consistently across the panel's sections.

**Files:**
- Modify: `synthi/src/components/programs/ProgramsPanel.jsx`

- [ ] **Step 1: Add a shared section-header element**

In `ProgramsPanel.jsx`, add this presentational helper above `export default function ProgramsPanel()`:

```jsx
function SectionHeader({ icon: Icon, label, count }) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="text-xs font-semibold uppercase tracking-wider inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
        {Icon ? <Icon className="w-3.5 h-3.5" /> : null} {label}
      </h3>
      {typeof count === 'number' ? (
        <span className="text-[11px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)' }}>{count}</span>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Use `SectionHeader` for the Installed / Marketplace / Running / Recent headers**

Replace each section's inline header `<div className="flex items-center justify-between">…</div>` block with `<SectionHeader …>`:
- Installed: `<SectionHeader icon={Package} label="Installed" count={installs.length} />`
- Marketplace: `<SectionHeader icon={Store} label="Marketplace" count={marketplace.length} />` — keep the search `<input>` directly after it inside the same header row (wrap header + input in a `flex items-center justify-between gap-2` container as today).
- Running: `<SectionHeader label="Running" count={sections.running.length} />`
- Recent: `<SectionHeader label="Recent" count={sections.recent.length} />`

(Keep the `Store` import already added in Phase 5; `Package` is imported.)

- [ ] **Step 3: Polish the panel header, Launch Command form, and action buttons**

Apply these token-consistent tweaks (no structural/testid changes):
- Panel header bar: keep as-is (already on-brand).
- Launch Command card + Install-from-manifest card + Publish button: ensure consistent radius (`rounded-lg`), border `var(--border-subtle)`, surface `var(--bg-surface)`, and that primary actions use `background: 'var(--brand-gradient-horizontal)'` while secondary use `border` + `var(--text-primary)` (the Launch button already uses the gradient; leave it).
- Empty states (Installed / Marketplace / Running / Recent "No …"): give each the same chrome — `rounded-lg border px-3 py-4 text-xs` with `borderColor: 'var(--border-subtle)'`, `color: 'var(--text-muted)'` (Marketplace + Running + Recent already match; align the Installed empty state to it if different).
- Add `@media (prefers-reduced-motion: reduce)` safety: since transitions are limited to `transition-colors` (color only), no motion changes are needed — leave as-is.

- [ ] **Step 4: Run the full programs component suite (must stay green)**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/components/programs`
Expected: PASS (all existing + Task-4 test). No testid regressions.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/HP/source/repos/synthi-ide
git add synthi/src/components/programs/ProgramsPanel.jsx
git commit -m "style(programs): cohesive on-brand Programs panel (shared section headers + chrome)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Regression + live seed + live verification + review

**Files:**
- Modify: `tasks/todo.md`

- [ ] **Step 1: Targeted suites**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs "src/app/api/programs" "src/app/api/workspace/[slug]/programs" src/components/programs`
Expected: PASS.

- [ ] **Step 2: Backend unchanged sanity check**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --test backend/collab-server/__tests__/programRuntimeManager.test.js`
Expected: PASS — 21 (no backend changes).

- [ ] **Step 3: Full regression**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run`
Expected: PASS — accept ONLY the known empty `src/lib/__tests__/preview-store.test.js` stub failure.

- [ ] **Step 4: Prisma confirm (no schema change)**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx prisma generate && npx prisma db push`
Expected: client generated; db push "already in sync".

- [ ] **Step 5: Live — rebuild frontend (disk-gated)**

Check Docker free space first: `docker system df`. If build cache is reclaimable, prune per the user's earlier choice (`docker builder prune -f && docker image prune -f`). Then:
Run: `cd /c/Users/HP/source/repos/synthi-ide && docker compose build frontend` (run in background; monitor `df -h /c`).
Expected: exit 0.

- [ ] **Step 6: Live — enable seed flag, recreate, seed, verify**

1. Add `ENABLE_PROGRAM_SEED: "1"` to the `frontend` service `environment` in `docker-compose.yml` (temporary).
2. `cd /c/Users/HP/source/repos/synthi-ide && docker compose up -d frontend` (recreate with new image + flag).
3. In the authenticated browser (Chrome MCP), POST the seed route:
   `fetch('/api/programs/seed-defaults', { method: 'POST' }).then(r => r.json())` → expect `{ count: 7, seeded: [...] }`.
4. Browse a workspace's marketplace: `fetch('/api/workspace/<slug>/programs/marketplace').then(r=>r.json())` → confirm the 7 `@vectant/*` with `verified:true`.
5. Open the Programs panel UI in a workspace and confirm the Verified badges + descriptions render; install one default through the consent prompt and confirm `installCount` bumps.
6. Revert the flag: remove `ENABLE_PROGRAM_SEED` from `docker-compose.yml`, `docker compose up -d frontend` to recreate without it. (The seeded rows persist.)

- [ ] **Step 7: Review + commit**

Record results in `tasks/todo.md` (new "Default programs + UI" review section: tasks done, suite counts, live verification, deviations). Then:

```bash
cd /c/Users/HP/source/repos/synthi-ide
git add tasks/todo.md
git commit -m "docs: default marketplace programs + Programs panel UI — complete

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** — Default catalog/single-source (T1), idempotent seed preserving installCount (T2), seed runner as env-gated route (T3), Verified badge + card redesign + non-web/description rendering (T4), whole-panel on-brand restyle (T5), regression + live seed/verify + review (T6). Non-web (background/tui) + Dev Container via importDevcontainer covered in T1 tests. No store/route logic changes (relies on Phase-5 paths) — matches spec. ✅

**2. Placeholder scan** — every code step contains complete code; the only descriptive step (T5 Step 3) lists exact token/class changes, not vague "make it nicer". ✅

**3. Type consistency** — `DEFAULT_PROGRAM_RECIPES`/`buildDefaultPrograms()`/`ensureDefaultPrograms(prisma)` names match across T1–T3 + route. `@vectant/<name>` packageIds consistent. `verified-badge-${item.packageId}` testid matches T4 test + impl. Route path `/api/programs/seed-defaults` consistent T3 + T6. `ENABLE_PROGRAM_SEED` flag consistent T3 + T6. Upsert shape mirrors `publishProgram` (`programId_version`). ✅

**4. Test independence** — defaultPrograms tests use a local prisma stub; route test mocks session+prisma+ensureDefaultPrograms + toggles the env flag; UI test uses the jsdom harness. No live DB/network in the suite. ✅
