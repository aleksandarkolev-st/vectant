# Make Default Programs Runnable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make installed programs actually run in a workspace and show in the App tab — by fixing the program-runtime to use the IDE's workspace directory, allowing the App-tab iframe through CSP, and letting the `@vectant/*` defaults scaffold a minimal starter project.

**Architecture:** Three layered components in dependency order. (1) `resolveActor()` exposes `workspaceUserId = session.user.id || email` and the program-runtime cwd callers use it (DB records keep the cuid). (2) A testable CSP builder adds the collab origin to `frame-src`. (3) Server-side scaffold templates + an owner-gated scaffold route + a "Set up project" UI action write minimal starter files (only-if-missing) then launch.

**Tech Stack:** Next.js App Router API + React (`synthi/`, Vitest from `synthi/`), collab-server (`backend/collab-server/`, `node --test`), Prisma (no schema change). Spec: `docs/superpowers/specs/2026-06-09-make-default-programs-runnable-design.md`.

**Constraints:** Branch `tool-compatibility` only (no merge/PR/finish). TDD only (`vitest` / `node --test`); no `next build`/`docker build` without checking Docker free space. Run vitest from `synthi/` (`cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run …`); quote paths with `[`/`]`; re-`cd` each call (git resets cwd to repo root). Stage specific files only (never `git add -A`); every commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. No schema change. Don't touch the known noise files.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `synthi/src/lib/integrations/session.js` | `resolveActor()` += `workspaceUserId` | Modify |
| `synthi/src/lib/integrations/__tests__/session.test.js` | resolveActor test | Create |
| `synthi/src/app/api/workspace/[slug]/programs/publish/route.js` | discoverManifest uses workspaceUserId | Modify |
| `synthi/src/app/api/workspace/[slug]/programs/install/route.js` | discoverManifest uses workspaceUserId | Modify |
| `synthi/src/app/api/workspace/[slug]/programs/[installId]/launch/route.js` | launch uses workspaceUserId | Modify |
| `synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js` | assert workspaceUserId threading | Modify |
| `synthi/src/lib/security/csp.js` | `buildContentSecurityPolicy(collabUrl)` | Create |
| `synthi/src/lib/security/__tests__/csp.test.js` | CSP builder test | Create |
| `synthi/next.config.mjs` | use the CSP builder | Modify |
| `synthi/src/lib/programs/scaffoldTemplates.js` | starter templates + lookup helpers | Create |
| `synthi/src/lib/programs/__tests__/scaffoldTemplates.test.js` | template tests | Create |
| `backend/collab-server/scaffold.js` | `applyScaffoldFiles(cwd, files)` (write-missing + path-guard) | Create |
| `backend/collab-server/__tests__/scaffold.test.js` | scaffold writer tests | Create |
| `backend/collab-server/server.js` | `POST /program-runtime/:slug/scaffold` | Modify |
| `synthi/src/lib/programs/runtimeClient.js` | `scaffoldProgram(...)` | Modify |
| `synthi/src/app/api/workspace/[slug]/programs/scaffold/route.js` | owner-gated scaffold route | Create |
| `synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js` | scaffold route tests | Modify |
| `synthi/src/components/programs/programsClient.js` | `scaffoldProgram(slug, packageId)` | Modify |
| `synthi/src/components/programs/ProgramsPanel.jsx` | "Set up project" action | Modify |
| `synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx` | scaffold UI test | Modify |
| `tasks/todo.md` | review | Modify |

**Reference facts (verified):**
- `resolveActor()` currently: `const session = await getServerSession(authOptions); const email = session?.user?.email; … const user = await prisma.user.findUnique({ where:{email}, select:{id:true,email:true} }); return { userId: user.id, email: user.email };`
- The launch route calls `launchInstalledProgram({ workspaceSlug: slug, sessionId, config, userId: actor.userId, title })` and `createProgramSession({ …, startedByUserId: actor.userId })`. Only the `launchInstalledProgram` `userId` changes to `actor.workspaceUserId`; `startedByUserId` stays `actor.userId`.
- install/publish routes call `discoverManifest(slug, actor.userId)` → change to `actor.workspaceUserId`. Install's `createInstall({ installedByUserId: actor.userId })` + `createPermissionGrant({ grantedByUserId: actor.userId })` stay on the cuid.
- collab-server is a raw `http` handler; the manifest route matches `^\/program-runtime\/([^/]+)\/manifest$` and uses `resolveWorkspaceCwd(slug, userId)` from `./terminalService`. Add a sibling `scaffold` POST match before/after it.
- `next.config.mjs` builds `const contentSecurityPolicy = [ …, "frame-src 'self' blob:", … ].join('; ')` then uses it in `headers()`.
- programRoutes.test.js harness: `req(url, body, method)`, `ctx(params)`, hoisted `h` with `actor/canRead/canWrite/discoverManifest/...`; `beforeEach` sets `h.actor.mockResolvedValue({ userId: 'u1', email: 'a@b.c' })`.

---

## Task 1: `resolveActor()` exposes `workspaceUserId`

**Files:**
- Modify: `synthi/src/lib/integrations/session.js`
- Test: `synthi/src/lib/integrations/__tests__/session.test.js`

- [ ] **Step 1: Write the failing test**

Create `synthi/src/lib/integrations/__tests__/session.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getServerSession: vi.fn(), findUnique: vi.fn() }));

vi.mock('next-auth', () => ({ getServerSession: h.getServerSession }));
vi.mock('@/app/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/prisma', () => ({ default: { user: { findUnique: h.findUnique } } }));

import { resolveActor } from '../session';

beforeEach(() => {
  vi.clearAllMocks();
  h.findUnique.mockResolvedValue({ id: 'cuid_db', email: 'a@b.c' });
});

describe('resolveActor', () => {
  it('returns the DB userId plus workspaceUserId = session.user.id (the IDE repo-dir id)', async () => {
    h.getServerSession.mockResolvedValue({ user: { id: '242593757', email: 'a@b.c' } });
    const actor = await resolveActor();
    expect(actor).toEqual({ userId: 'cuid_db', email: 'a@b.c', workspaceUserId: '242593757' });
  });

  it('falls back workspaceUserId to email when session.user.id is absent (mirrors the IDE)', async () => {
    h.getServerSession.mockResolvedValue({ user: { email: 'a@b.c' } });
    const actor = await resolveActor();
    expect(actor.workspaceUserId).toBe('a@b.c');
  });

  it('returns null when unauthenticated', async () => {
    h.getServerSession.mockResolvedValue(null);
    expect(await resolveActor()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/integrations/__tests__/session.test.js`
Expected: FAIL — `workspaceUserId` is undefined.

- [ ] **Step 3: Implement**

Replace the body of `resolveActor` in `synthi/src/lib/integrations/session.js`:

```js
export async function resolveActor() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) return null;
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) return null;
  // workspaceUserId mirrors the value the IDE uses to name the workspace repo dir
  // (page.jsx / Editor.jsx / TerminalPane.jsx all use `session.user.id || email`).
  // Distinct from `userId` (the DB User.id / cuid used for DB FK records).
  const workspaceUserId = session.user.id || email;
  return { userId: user.id, email: user.email, workspaceUserId };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/integrations/__tests__/session.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/HP/source/repos/synthi-ide
git add synthi/src/lib/integrations/session.js "synthi/src/lib/integrations/__tests__/session.test.js"
git commit -m "feat(programs): resolveActor exposes workspaceUserId (IDE repo-dir id)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Thread `workspaceUserId` into program-runtime cwd callers

**Files:**
- Modify: `synthi/src/app/api/workspace/[slug]/programs/publish/route.js`
- Modify: `synthi/src/app/api/workspace/[slug]/programs/install/route.js`
- Modify: `synthi/src/app/api/workspace/[slug]/programs/[installId]/launch/route.js`
- Test: `synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js`

- [ ] **Step 1: Update the test expectations (failing)**

In `programRoutes.test.js`:
(a) In `beforeEach`, change the actor mock to include the workspace id:
```js
  h.actor.mockResolvedValue({ userId: 'u1', email: 'a@b.c', workspaceUserId: 'gh1' });
```
(b) In the install test that asserts manifest discovery, change:
```js
    expect(h.discoverManifest).toHaveBeenCalledWith('team', 'u1');
```
to:
```js
    expect(h.discoverManifest).toHaveBeenCalledWith('team', 'gh1');
```
(c) In the launch test (`'launches an install from its stored manifest for an owner/admin'`), strengthen the `launchInstalledProgram` assertion to include the workspace id:
```js
    expect(h.launchInstalledProgram).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', sessionId: 'ps1', userId: 'gh1' }));
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run "src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js"`
Expected: FAIL — discoverManifest/launchInstalledProgram still called with `'u1'`/`actor.userId`.

- [ ] **Step 3: Implement (3 routes)**

In `publish/route.js`, change the discovery call:
```js
    discovered = await discoverManifest(slug, actor.workspaceUserId);
```
In `install/route.js`, change the discovery call (inside the local-install branch):
```js
      discovered = await discoverManifest(slug, actor.workspaceUserId);
```
In `[installId]/launch/route.js`, change ONLY the `launchInstalledProgram` userId (leave `startedByUserId: actor.userId`):
```js
    const snapshot = await launchInstalledProgram({
      workspaceSlug: slug,
      sessionId: session.id,
      config,
      userId: actor.workspaceUserId,
      title: config.displayName || null,
    });
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run "src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js"`
Expected: PASS (all program route tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/HP/source/repos/synthi-ide
git add "synthi/src/app/api/workspace/[slug]/programs/publish/route.js" "synthi/src/app/api/workspace/[slug]/programs/install/route.js" "synthi/src/app/api/workspace/[slug]/programs/[installId]/launch/route.js" "synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js"
git commit -m "fix(programs): resolve workspace cwd by workspaceUserId so launch/publish/install hit the IDE dir

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: App-tab CSP fix

**Files:**
- Create: `synthi/src/lib/security/csp.js`
- Test: `synthi/src/lib/security/__tests__/csp.test.js`
- Modify: `synthi/next.config.mjs`

- [ ] **Step 1: Write the failing test**

Create `synthi/src/lib/security/__tests__/csp.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy } from '../csp';

function frameSrc(csp) {
  return csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src '));
}

describe('buildContentSecurityPolicy', () => {
  it('adds the collab-server origin to frame-src', () => {
    const csp = buildContentSecurityPolicy('http://localhost:1234');
    expect(frameSrc(csp)).toBe("frame-src 'self' blob: http://localhost:1234");
  });

  it('uses only the origin (strips path) and supports https', () => {
    const csp = buildContentSecurityPolicy('https://collab.example.com/base/');
    expect(frameSrc(csp)).toBe("frame-src 'self' blob: https://collab.example.com");
  });

  it('falls back to self + blob when the url is missing or invalid', () => {
    expect(frameSrc(buildContentSecurityPolicy(''))).toBe("frame-src 'self' blob:");
    expect(frameSrc(buildContentSecurityPolicy('not a url'))).toBe("frame-src 'self' blob:");
  });

  it('preserves the other directives', () => {
    const csp = buildContentSecurityPolicy('http://localhost:1234');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/security/__tests__/csp.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the helper**

Create `synthi/src/lib/security/csp.js`:

```js
/**
 * Build the app Content-Security-Policy. `frame-src` must include the
 * collab-server origin so the program App tab can embed the proxied port
 * (`<collab>/port/<N>/`); without it the cross-origin iframe is blocked.
 * @param {string} collabUrl - e.g. NEXT_PUBLIC_COLLAB_SERVER_URL
 * @returns {string} CSP header value
 */
export function buildContentSecurityPolicy(collabUrl) {
  let collabOrigin = null;
  try {
    if (collabUrl) collabOrigin = new URL(collabUrl).origin;
  } catch {
    collabOrigin = null;
  }
  const frameSrc = ["'self'", 'blob:', collabOrigin].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' http: https: ws: wss: blob:",
    "worker-src 'self' blob:",
    `frame-src ${frameSrc}`,
    "media-src 'self' blob: data:",
  ].join('; ');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/security/__tests__/csp.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire `next.config.mjs`**

In `synthi/next.config.mjs`: add the import near the top (after the existing `import` lines):
```js
import { buildContentSecurityPolicy } from './src/lib/security/csp.js';
```
Replace the inline `const contentSecurityPolicy = [ … ].join('; ');` block (the array literal lines) with:
```js
const contentSecurityPolicy = buildContentSecurityPolicy(
  process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234',
);
```
Leave the `headers()` usage of `contentSecurityPolicy` unchanged.

- [ ] **Step 6: Sanity-check the config parses**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && node --input-type=module -e "import('./src/lib/security/csp.js').then(m=>console.log(m.buildContentSecurityPolicy('http://localhost:1234').includes('http://localhost:1234') ? 'OK' : 'MISSING'))"`
Expected: prints `OK`.

- [ ] **Step 7: Commit**

```bash
cd /c/Users/HP/source/repos/synthi-ide
git add synthi/src/lib/security/csp.js "synthi/src/lib/security/__tests__/csp.test.js" synthi/next.config.mjs
git commit -m "fix(security): allow collab-server origin in CSP frame-src for the App tab

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Scaffold templates module

**Files:**
- Create: `synthi/src/lib/programs/scaffoldTemplates.js`
- Test: `synthi/src/lib/programs/__tests__/scaffoldTemplates.test.js`

- [ ] **Step 1: Write the failing test**

Create `synthi/src/lib/programs/__tests__/scaffoldTemplates.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { SCAFFOLD_TEMPLATES, getScaffoldTemplate, SCAFFOLDABLE_PACKAGE_IDS } from '../scaffoldTemplates';

describe('scaffoldTemplates', () => {
  it('has a template for each scaffoldable default; every file has a relative path + contents', () => {
    expect(SCAFFOLDABLE_PACKAGE_IDS).toEqual(
      expect.arrayContaining(['@vectant/nextjs-dev', '@vectant/vite-react', '@vectant/flask-api', '@vectant/static-site', '@vectant/node-worker']),
    );
    for (const id of SCAFFOLDABLE_PACKAGE_IDS) {
      const files = getScaffoldTemplate(id);
      expect(Array.isArray(files)).toBe(true);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        expect(typeof f.path).toBe('string');
        expect(f.path.length).toBeGreaterThan(0);
        expect(f.path.startsWith('/')).toBe(false);
        expect(f.path.split(/[\\/]/)).not.toContain('..');
        expect(typeof f.contents).toBe('string');
        expect(f.contents.length).toBeGreaterThan(0);
      }
    }
  });

  it('every package.json template is valid JSON', () => {
    for (const id of SCAFFOLDABLE_PACKAGE_IDS) {
      for (const f of getScaffoldTemplate(id)) {
        if (f.path === 'package.json') expect(() => JSON.parse(f.contents)).not.toThrow();
      }
    }
  });

  it('returns null for non-scaffoldable / unknown packageIds', () => {
    expect(getScaffoldTemplate('@vectant/lazygit')).toBeNull();
    expect(getScaffoldTemplate('@vectant/devcontainer')).toBeNull();
    expect(getScaffoldTemplate('@other/web')).toBeNull();
    expect(getScaffoldTemplate(undefined)).toBeNull();
  });

  it('SCAFFOLD_TEMPLATES is keyed by bare default name', () => {
    expect(Object.keys(SCAFFOLD_TEMPLATES)).toEqual(
      expect.arrayContaining(['nextjs-dev', 'vite-react', 'flask-api', 'static-site', 'node-worker']),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/scaffoldTemplates.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the templates**

Create `synthi/src/lib/programs/scaffoldTemplates.js`:

```js
/**
 * Minimal inline starter templates for the scaffoldable @vectant/* defaults.
 * Each template is a list of { path, contents } files. They are written
 * server-side, ONLY when the file is missing (never clobbered) — see the
 * collab-server scaffold writer. Templates are deliberately tiny: just enough
 * for the default's launch command to run.
 */

const NEXTJS = [
  {
    path: 'package.json',
    contents: JSON.stringify(
      {
        name: 'vectant-nextjs-starter', version: '0.1.0', private: true,
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: { next: '^14.2.0', react: '^18.3.0', 'react-dom': '^18.3.0' },
      },
      null,
      2,
    ) + '\n',
  },
  {
    path: 'app/layout.js',
    contents: `export const metadata = { title: 'Vectant Next.js Starter' };\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
  },
  {
    path: 'app/page.js',
    contents: `export default function Page() {\n  return (\n    <main style={{ fontFamily: 'system-ui', padding: 48 }}>\n      <h1>Next.js is running 🎉</h1>\n      <p>Edit app/page.js and save to see changes.</p>\n    </main>\n  );\n}\n`,
  },
];

const VITE_REACT = [
  {
    path: 'package.json',
    contents: JSON.stringify(
      {
        name: 'vectant-vite-react-starter', version: '0.1.0', private: true, type: 'module',
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        dependencies: { react: '^18.3.0', 'react-dom': '^18.3.0' },
        devDependencies: { vite: '^5.2.0', '@vitejs/plugin-react': '^4.3.0' },
      },
      null,
      2,
    ) + '\n',
  },
  {
    path: 'vite.config.js',
    contents: `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()], server: { host: true, port: 5173 } });\n`,
  },
  {
    path: 'index.html',
    contents: `<!doctype html>\n<html>\n  <head><meta charset="utf-8" /><title>Vite + React</title></head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`,
  },
  {
    path: 'src/main.jsx',
    contents: `import React from 'react';\nimport { createRoot } from 'react-dom/client';\n\ncreateRoot(document.getElementById('root')).render(\n  <main style={{ fontFamily: 'system-ui', padding: 48 }}>\n    <h1>Vite + React is running ⚡</h1>\n    <p>Edit src/main.jsx and save.</p>\n  </main>,\n);\n`,
  },
];

const FLASK = [
  {
    path: 'requirements.txt',
    contents: `flask>=3.0\n`,
  },
  {
    path: 'app.py',
    contents: `from flask import Flask\n\napp = Flask(__name__)\n\n\n@app.get("/")\ndef index():\n    return "Flask is running 🐍"\n`,
  },
];

const STATIC_SITE = [
  {
    path: 'index.html',
    contents: `<!doctype html>\n<html>\n  <head><meta charset="utf-8" /><title>Static Site</title></head>\n  <body style="font-family: system-ui; padding: 48px;">\n    <h1>Static site is serving 📄</h1>\n    <p>Edit index.html and refresh.</p>\n  </body>\n</html>\n`,
  },
];

const NODE_WORKER = [
  {
    path: 'package.json',
    contents: JSON.stringify(
      { name: 'vectant-worker-starter', version: '0.1.0', private: true, scripts: { start: 'node worker.js' } },
      null,
      2,
    ) + '\n',
  },
  {
    path: 'worker.js',
    contents: `let n = 0;\nconsole.log('worker started');\nsetInterval(() => {\n  n += 1;\n  console.log('tick', n, new Date().toISOString());\n}, 5000);\n`,
  },
];

/** Templates keyed by the bare default name (matches @vectant/<name>). */
export const SCAFFOLD_TEMPLATES = {
  'nextjs-dev': NEXTJS,
  'vite-react': VITE_REACT,
  'flask-api': FLASK,
  'static-site': STATIC_SITE,
  'node-worker': NODE_WORKER,
};

/** The packageIds that have a scaffold template (used by the route + UI). */
export const SCAFFOLDABLE_PACKAGE_IDS = Object.keys(SCAFFOLD_TEMPLATES).map((name) => `@vectant/${name}`);

/** Look up a scaffold template by published packageId (@vectant/<name>) → files | null. */
export function getScaffoldTemplate(packageId) {
  if (typeof packageId !== 'string') return null;
  const match = /^@vectant\/(.+)$/.exec(packageId);
  if (!match) return null;
  return SCAFFOLD_TEMPLATES[match[1]] || null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/scaffoldTemplates.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/HP/source/repos/synthi-ide
git add synthi/src/lib/programs/scaffoldTemplates.js "synthi/src/lib/programs/__tests__/scaffoldTemplates.test.js"
git commit -m "feat(programs): minimal inline scaffold templates for the @vectant/* defaults

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: collab-server scaffold writer + endpoint

**Files:**
- Create: `backend/collab-server/scaffold.js`
- Test: `backend/collab-server/__tests__/scaffold.test.js`
- Modify: `backend/collab-server/server.js`

- [ ] **Step 1: Write the failing test**

Create `backend/collab-server/__tests__/scaffold.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyScaffoldFiles } = require('../scaffold');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'));
}

test('writes missing files and reports them', () => {
  const cwd = tmpDir();
  const res = applyScaffoldFiles(cwd, [
    { path: 'package.json', contents: '{}' },
    { path: 'src/main.js', contents: 'console.log(1)' },
  ]);
  assert.deepStrictEqual(res.written.sort(), ['package.json', 'src/main.js']);
  assert.deepStrictEqual(res.skipped, []);
  assert.strictEqual(fs.readFileSync(path.join(cwd, 'src/main.js'), 'utf8'), 'console.log(1)');
});

test('never clobbers an existing file (skips it)', () => {
  const cwd = tmpDir();
  fs.writeFileSync(path.join(cwd, 'package.json'), 'ORIGINAL');
  const res = applyScaffoldFiles(cwd, [
    { path: 'package.json', contents: 'NEW' },
    { path: 'app.py', contents: 'x' },
  ]);
  assert.deepStrictEqual(res.written, ['app.py']);
  assert.deepStrictEqual(res.skipped, ['package.json']);
  assert.strictEqual(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'), 'ORIGINAL');
});

test('rejects path traversal / absolute paths', () => {
  const cwd = tmpDir();
  assert.throws(() => applyScaffoldFiles(cwd, [{ path: '../evil.js', contents: 'x' }]), /path_escape/);
  assert.throws(() => applyScaffoldFiles(cwd, [{ path: '/etc/passwd', contents: 'x' }]), /path_escape/);
  assert.throws(() => applyScaffoldFiles(cwd, [{ path: 'a/../../b', contents: 'x' }]), /path_escape/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --test backend/collab-server/__tests__/scaffold.test.js`
Expected: FAIL — `../scaffold` module not found.

- [ ] **Step 3: Implement the writer**

Create `backend/collab-server/scaffold.js`:

```js
const fs = require('fs');
const path = require('path');

/**
 * Write scaffold files into `cwd`, ONLY when the target does not already exist.
 * Every path must be relative and resolve inside `cwd` (no traversal/absolute) —
 * otherwise we throw `path_escape`. Returns { written, skipped } (relative paths).
 *
 * @param {string} cwd
 * @param {{path:string, contents:string}[]} files
 */
function applyScaffoldFiles(cwd, files) {
  const root = path.resolve(cwd);
  const written = [];
  const skipped = [];
  for (const file of Array.isArray(files) ? files : []) {
    const rel = String(file?.path || '');
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]+/).some((s) => s === '..')) {
      throw new Error('path_escape');
    }
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error('path_escape');
    }
    if (fs.existsSync(target)) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(file.contents ?? ''), 'utf8');
    written.push(rel);
  }
  return { written, skipped };
}

module.exports = { applyScaffoldFiles };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --test backend/collab-server/__tests__/scaffold.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the collab endpoint**

In `backend/collab-server/server.js`, immediately AFTER the manifest route block (the `if (manifestMatch && req.method === 'GET') { … return; }` block ending around line 1668), add:

```js
  // POST /program-runtime/:slug/scaffold  { userId, files:[{path,contents}] }
  // Writes starter files into the workspace dir, ONLY when missing. Path-guarded.
  const scaffoldMatch = /^\/program-runtime\/([^/]+)\/scaffold$/.exec(programRuntimeUrl.pathname);
  if (scaffoldMatch && req.method === 'POST') {
    const slug = decodeURIComponent(scaffoldMatch[1]);
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    try {
      const { resolveWorkspaceCwd } = require('./terminalService');
      const { applyScaffoldFiles } = require('./scaffold');
      const cwd = await resolveWorkspaceCwd(slug, parsed.userId || undefined);
      const result = applyScaffoldFiles(cwd, parsed.files || []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const code = err?.message === 'path_escape' ? 400 : 500;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'scaffold failed' }));
    }
    return;
  }
```

- [ ] **Step 6: Sanity-check server.js parses + suite stays green**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --check backend/collab-server/server.js && node --test backend/collab-server/__tests__/programRuntimeManager.test.js backend/collab-server/__tests__/scaffold.test.js`
Expected: no syntax error; programRuntimeManager 21 pass + scaffold 3 pass.

- [ ] **Step 7: Commit**

```bash
cd /c/Users/HP/source/repos/synthi-ide
git add backend/collab-server/scaffold.js backend/collab-server/__tests__/scaffold.test.js backend/collab-server/server.js
git commit -m "feat(collab): scaffold endpoint writes starter files (missing-only, path-guarded)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: runtimeClient + Next scaffold route

**Files:**
- Modify: `synthi/src/lib/programs/runtimeClient.js`
- Create: `synthi/src/app/api/workspace/[slug]/programs/scaffold/route.js`
- Test: `synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js`

- [ ] **Step 1: Write the failing tests**

In `programRoutes.test.js`:
(a) Extend the hoisted `h` with `scaffoldProgram: vi.fn()` and add `scaffoldProgram: h.scaffoldProgram` to the `@/lib/programs/runtimeClient` mock factory.
(b) Add the import: `import { POST as POST_SCAFFOLD } from '../scaffold/route.js';`
(c) Add this describe block:

```js
describe('POST /programs/scaffold', () => {
  it('scaffolds a known default into the workspace for an owner/admin', async () => {
    h.scaffoldProgram.mockResolvedValue({ written: ['package.json', 'app/page.js'], skipped: [] });
    const res = await POST_SCAFFOLD(
      req('http://x/api/workspace/team/programs/scaffold', { packageId: '@vectant/nextjs-dev' }, 'POST'),
      ctx({ slug: 'team' }),
    );
    expect(res.status).toBe(200);
    expect(h.scaffoldProgram).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', userId: 'gh1' }));
    const passed = h.scaffoldProgram.mock.calls[0][0];
    expect(passed.files.some((f) => f.path === 'package.json')).toBe(true);
    const body = await res.json();
    expect(body.written).toContain('package.json');
  });

  it('rejects a plain member (403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_SCAFFOLD(req('http://x/api/workspace/team/programs/scaffold', { packageId: '@vectant/nextjs-dev' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.scaffoldProgram).not.toHaveBeenCalled();
  });

  it('returns 404 for a packageId with no scaffold template', async () => {
    const res = await POST_SCAFFOLD(req('http://x/api/workspace/team/programs/scaffold', { packageId: '@vectant/lazygit' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(404);
    expect(h.scaffoldProgram).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run "src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js"`
Expected: FAIL — scaffold route module missing.

- [ ] **Step 3: Add the runtimeClient function**

In `synthi/src/lib/programs/runtimeClient.js`, add (after `launchInstalledProgram`):

```js
export async function scaffoldProgram({ workspaceSlug, userId = '', files = [] }) {
  return requestJson(`/program-runtime/${encodeURIComponent(workspaceSlug)}/scaffold`, {
    method: 'POST',
    body: JSON.stringify({ userId, files }),
  });
}
```

- [ ] **Step 4: Create the Next route**

Create `synthi/src/app/api/workspace/[slug]/programs/scaffold/route.js`:

```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { getScaffoldTemplate } from '@/lib/programs/scaffoldTemplates';
import { scaffoldProgram } from '@/lib/programs/runtimeClient';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/scaffold  { packageId }
// Owner/admin: write a known default's starter files into the workspace (only
// missing files). The template is resolved SERVER-SIDE from packageId — client
// `files` are ignored — and written under the IDE's workspace dir (workspaceUserId).
export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const files = getScaffoldTemplate(body.packageId);
  if (!files) {
    return NextResponse.json({ error: 'no_template' }, { status: 404 });
  }

  try {
    const result = await scaffoldProgram({ workspaceSlug: slug, userId: actor.workspaceUserId, files });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: 'scaffold_failed', message: error?.message || 'scaffold failed' },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run "src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js"`
Expected: PASS (existing + 3 new scaffold tests).

- [ ] **Step 6: Commit**

```bash
cd /c/Users/HP/source/repos/synthi-ide
git add synthi/src/lib/programs/runtimeClient.js "synthi/src/app/api/workspace/[slug]/programs/scaffold/route.js" "synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js"
git commit -m "feat(programs): owner-gated scaffold route (server-side templates, workspaceUserId)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: UI — "Set up project" action

**Files:**
- Modify: `synthi/src/components/programs/programsClient.js`
- Modify: `synthi/src/components/programs/ProgramsPanel.jsx`
- Test: `synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx`

- [ ] **Step 1: Add the client function**

In `synthi/src/components/programs/programsClient.js`, after `installPublishedProgram`:

```js
export async function scaffoldProgram(workspaceSlug, packageId) {
  return request(`${programsBase(workspaceSlug)}/scaffold`, {
    method: 'POST',
    body: JSON.stringify({ packageId }),
  });
}
```

- [ ] **Step 2: Write the failing UI test**

In `synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx`, extend the hoisted `h` with `scaffoldProgram: vi.fn()` and add `scaffoldProgram: h.scaffoldProgram` to the `../programsClient` mock factory. Then add:

```js
  it('shows "Set up project" for a scaffoldable installed default and scaffolds then launches', async () => {
    h.fetchInstalledPrograms.mockResolvedValue([{ id: 'inst1', packageId: '@vectant/nextjs-dev', version: '1.0.0', status: 'installed' }]);
    h.scaffoldProgram.mockResolvedValue({ written: ['package.json', 'app/page.js'], skipped: [] });
    h.launchInstalledProgram.mockResolvedValue({ session: { id: 'ps1', state: 'running', runtimeType: 'web' } });
    // auto-confirm the window.confirm prompt
    const origConfirm = window.confirm;
    window.confirm = () => true;
    try {
      await render();
      await act(async () => { byTestId(container, 'scaffold-inst1').click(); });
      await flush();
    } finally {
      window.confirm = origConfirm;
    }
    expect(h.scaffoldProgram).toHaveBeenCalledWith('team', '@vectant/nextjs-dev');
    expect(h.launchInstalledProgram).toHaveBeenCalledWith('team', 'inst1');
  });

  it('hides "Set up project" for a non-scaffoldable installed program', async () => {
    h.fetchInstalledPrograms.mockResolvedValue([{ id: 'inst2', packageId: 'local:team:web', version: '1.0.0', status: 'installed' }]);
    await render();
    expect(byTestId(container, 'scaffold-inst2')).toBeNull();
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/components/programs/__tests__/programsPanelInstall.test.jsx`
Expected: FAIL — `scaffold-inst1` testid not present.

- [ ] **Step 4: Implement in `ProgramsPanel.jsx`**

(a) Add imports — extend the `./programsClient` import to include `scaffoldProgram`, and the `./scaffoldTemplates`-equivalent set from the lib:
```js
import { SCAFFOLDABLE_PACKAGE_IDS } from '@/lib/programs/scaffoldTemplates';
```
and add `scaffoldProgram` to the existing `from './programsClient'` import list. Also add the `Wrench` icon to the lucide import line.

(b) Add a handler (near `handleLaunchInstall`):
```js
  const handleScaffold = useCallback(async (install) => {
    if (!workspaceSlug || !install?.id) return;
    const name = install.packageId?.split('/').pop() || 'starter';
    if (!window.confirm(`Scaffold a "${name}" starter into this workspace? Existing files are skipped.`)) return;
    setActingSessionId(install.id);
    try {
      const result = await scaffoldProgram(workspaceSlug, install.packageId);
      toast.success(`Scaffolded ${result?.written?.length || 0} file(s)` + (result?.skipped?.length ? `, skipped ${result.skipped.length}` : ''));
      await handleLaunchInstall(install);
    } catch (error) {
      toast.error(error.body?.message || error.message || 'Failed to scaffold');
      setActingSessionId(null);
    }
  }, [handleLaunchInstall, workspaceSlug]);
```

(c) Pass scaffold capability into `InstallCard` and render the button. Update the `InstallCard` usage in the Installed section to pass `onScaffold` + `scaffoldable`:
```jsx
              <InstallCard
                key={install.id}
                install={install}
                acting={actingSessionId === install.id}
                canManage={canManage}
                onLaunch={handleLaunchInstall}
                scaffoldable={SCAFFOLDABLE_PACKAGE_IDS.includes(install.packageId)}
                onScaffold={handleScaffold}
              />
```
and extend the `InstallCard` component to render the action (before the Launch button), when `canManage && scaffoldable`:
```jsx
          {canManage && scaffoldable ? (
            <button
              type="button"
              data-testid={`scaffold-${install.id}`}
              onClick={() => onScaffold(install)}
              disabled={acting}
              className="text-[11px] px-2 py-1 rounded border inline-flex items-center gap-1 disabled:opacity-50"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
            >
              <Wrench className="w-3 h-3" /> Set up project
            </button>
          ) : null}
```
(update the `InstallCard` function signature to `function InstallCard({ install, acting, canManage, onLaunch, scaffoldable, onScaffold })`).

- [ ] **Step 5: Run to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/components/programs/__tests__/programsPanelInstall.test.jsx`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Commit**

```bash
cd /c/Users/HP/source/repos/synthi-ide
git add synthi/src/components/programs/programsClient.js synthi/src/components/programs/ProgramsPanel.jsx "synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx"
git commit -m "feat(programs): 'Set up project' scaffold action on scaffoldable installs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Regression + live verify + review

**Files:**
- Modify: `tasks/todo.md`

- [ ] **Step 1: Targeted suites**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs src/lib/security src/lib/integrations "src/app/api/workspace/[slug]/programs" src/components/programs`
Expected: PASS.

- [ ] **Step 2: Backend suites**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --test backend/collab-server/__tests__/programRuntimeManager.test.js backend/collab-server/__tests__/scaffold.test.js`
Expected: programRuntimeManager 21 + scaffold 3 pass.

- [ ] **Step 3: Full regression**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run`
Expected: PASS — accept ONLY the known empty `src/lib/__tests__/preview-store.test.js` stub failure.

- [ ] **Step 4: Prisma confirm (no schema change)**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx prisma generate && npx prisma db push`
Expected: client generated; db push "already in sync".

- [ ] **Step 5: Live — rebuild frontend + collab (disk-gated)**

Check Docker free space first (`df -h /c`; prune if needed: `docker builder prune -f && docker image prune -f`). Then rebuild BOTH changed images:
Run (background, monitor `df -h /c`): `cd /c/Users/HP/source/repos/synthi-ide && docker compose build frontend collab-server`
Then recreate: `docker compose up -d frontend collab-server`.

- [ ] **Step 6: Live — end-to-end verify (browser, logged in)**

In a workspace, as owner: install `@vectant/nextjs-dev` → click **Set up project** (confirm) → confirm `package.json` + `app/page.js` appear in the editor file tree (proves Component 1: files landed in the IDE dir) → the program launches → wait for `npm install && npm run dev` → the **App tab embeds the running Next.js server** (proves Component 2: CSP). Also confirm `curl -s -D - http://127.0.0.1:3000/ | grep -i content-security-policy` shows the collab origin in `frame-src`.

- [ ] **Step 7: Review + commit**

Record results in `tasks/todo.md` (new review section: tasks done, suite counts, live verification, deviations). Then:
```bash
cd /c/Users/HP/source/repos/synthi-ide
git add tasks/todo.md
git commit -m "docs: make default programs runnable — complete

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** — Component 1 (workspaceUserId): Task 1 (resolveActor) + Task 2 (thread into publish/install/launch). Component 2 (CSP): Task 3. Component 3 (scaffold): Task 4 (templates) + Task 5 (collab writer/endpoint) + Task 6 (runtimeClient+route) + Task 7 (UI). Production-cost: documented in spec + backlog (no code). Live verify: Task 8. ✅ all spec sections mapped.

**2. Placeholder scan** — every code step has complete code; the UI task gives exact JSX + handler; no "TODO"/"handle edge cases". ✅

**3. Type consistency** — `workspaceUserId` used identically across Task 1 (resolveActor return) → Task 2 (routes) → Task 6 (scaffold route). `buildContentSecurityPolicy(collabUrl)` name matches Task 3 test + next.config. `applyScaffoldFiles(cwd, files) → {written, skipped}` matches Task 5 test + endpoint. `getScaffoldTemplate`/`SCAFFOLDABLE_PACKAGE_IDS` match Task 4 → Task 6 → Task 7. `scaffoldProgram` exists in runtimeClient (Task 6, `{workspaceSlug,userId,files}`) and programsClient (Task 7, `(slug, packageId)`) — different layers, intentionally different signatures. Route path `/programs/scaffold` consistent Task 6 + 7. ✅

**4. Test independence** — session test mocks getServerSession+prisma; route tests mock store/session/scope/runtimeClient; csp + scaffoldTemplates are pure; collab scaffold uses real temp dirs (node --test); UI uses the jsdom harness with `window.confirm` stubbed. No live DB/network in the suite. ✅
