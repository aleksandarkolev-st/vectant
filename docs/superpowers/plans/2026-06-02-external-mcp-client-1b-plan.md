# Slice 1b — CLI-Agent External-MCP Consumer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Let a CLI agent attached via `synthi-mcp` see and call the connecting user's connected
external MCP tools (as `ext_<i>`), sourced through a shared `@synthi/mcp-hub` package, authenticated by
a per-user Personal Access Token (PAT).

**Architecture:** Extract the Slice-1a hub into a shared `@synthi/mcp-hub` workspace package consumed by
both `synthi` and `synthi-mcp`. Add a `PersonalAccessToken` model + issuance UI. Two PAT-authed Next.js
endpoints — `GET /api/integrations/mcp/resolve` (returns decrypted, scoped, hub-ready configs) and
`POST /api/integrations/mcp/audit` (writes redacted `callerType='cli'` rows). `synthi-mcp` resolves
external tools at startup, advertises them in `ListTools`, and dispatches `ext_<i>` calls through the
shared hub.

**Tech Stack:** Next.js 15 (App Router, `runtime='nodejs'`) · Prisma + Postgres (`db push`, no
migrations dir) · vitest 4 (synthi) / vitest 2 (synthi-mcp) · TypeScript (`synthi-mcp`, `tsc` node16) ·
`@modelcontextprotocol/sdk` · npm workspaces.

---

## Spec

Authoritative spec: `docs/superpowers/specs/2026-06-02-external-mcp-client-1b-design.md`. Inherited
Slice-1a conventions (authoritative): `ext_<i>` alias keyed by `{connId, toolName}`; fail-closed
`toolAllowlist`; audit stores only sha256 arg-hash + byte sizes; SSRF guard in the hub on every
outbound URL; identity = Prisma `User` cuid (the PAT row already carries the cuid).

## Operating rules (every task)

- **Branch:** all work on `tool-compatibility-1b` (created off `tool-compatibility`).
- **Git:** stage **specific files only** (never `git add -A`/`.`). Don't push. Don't amend. End every
  commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. `memory/` and
  `.claude/scheduled_tasks.lock` are local-only — never stage them.
- **DB:** `npx prisma db push` then `npx prisma generate` after schema edits (NO migrations dir).
- **Tests:** from `synthi/` → `npx vitest run <paths>`; from `mcp/synthi-mcp/` →
  `npx vitest run tests/unit/<file>`. Mock handles inside a hoisted `vi.mock` factory MUST be created
  via `vi.hoisted(() => ({...}))`.
- **Subagents implement+test+report; the controller verifies `git log` and commits.** Confirm a SHA
  exists before trusting "committed".

## File Structure

**Created**
- `packages/mcp-hub/package.json` — shared hub package manifest (`@synthi/mcp-hub`).
- `packages/mcp-hub/index.d.ts` — hand-written public type surface (consumed by `synthi-mcp` `tsc`).
- `packages/mcp-hub/src/{ssrfGuard,client,helpers,guardedFetch,index}.js` — moved verbatim from
  `synthi/src/lib/mcp-hub/`.
- `packages/mcp-hub/src/__tests__/{ssrfGuard,client,helpers,guardedFetch}.test.js` — moved verbatim.
- `synthi/src/lib/integrations/pat.js` — PAT generate/hash helpers.
- `synthi/src/lib/integrations/patAuth.js` — Bearer-PAT request authenticator.
- `synthi/src/app/api/integrations/tokens/route.js` — PAT issuance (POST) + list (GET).
- `synthi/src/app/api/integrations/tokens/[id]/route.js` — PAT revoke (DELETE).
- `synthi/src/app/api/integrations/mcp/resolve/route.js` — PAT-authed config resolve (GET).
- `synthi/src/app/api/integrations/mcp/audit/route.js` — PAT-authed CLI audit write (POST).
- `synthi/src/components/integrations/CliAccessSection.jsx` — PAT issuance/list/revoke UI.
- `mcp/synthi-mcp/src/external/config.ts` — reads `SYNTHI_API_URL`/`SYNTHI_PAT`/`SYNTHI_WORKSPACE_SLUG`.
- `mcp/synthi-mcp/src/external/index.ts` — resolve + alias map + dispatch + audit + extcall limiter.
- `mcp/synthi-mcp/tests/unit/external.test.ts` — consumer unit tests.
- `docs/superpowers/plans/2026-06-02-external-mcp-client-1b-E2E.md` — manual E2E checklist.
- `synthi/src/lib/integrations/__tests__/pat.test.js`, `patAuth.test.js`;
  `synthi/src/app/api/integrations/{tokens,mcp/resolve,mcp/audit}/__tests__/*.test.js`.

**Modified**
- root `package.json` — add `"private": true` + `"workspaces"`.
- `synthi/next.config.mjs` — add `transpilePackages: ['@synthi/mcp-hub']`.
- `synthi/src/app/api/chat/externalTools.js` — import from `@synthi/mcp-hub`.
- `synthi/src/app/api/integrations/connections/route.js`, `[id]/route.js`, `[id]/test/route.js` —
  import from `@synthi/mcp-hub`.
- `synthi/src/app/api/chat/__tests__/externalTools.test.js`,
  `connections/__tests__/connectionRoutes.test.js` — `vi.mock('@synthi/mcp-hub', …)`.
- `synthi/src/lib/integrations/rateLimit.js` — add `resolve` + `audit` limit groups.
- `synthi/src/components/integrations/integrationsClient.js` — token CRUD methods.
- `synthi/src/components/integrations/ConnectedToolsPanel.jsx` — render `CliAccessSection`.
- `synthi/prisma/schema.prisma` — `PersonalAccessToken` model + `User.tokens` back-relation.
- `mcp/synthi-mcp/src/index.ts` — resolve external tools at startup; pass to server.
- `mcp/synthi-mcp/src/server.ts` — merge external descriptors into `ListTools`; intercept `ext_<i>` in
  dispatch.
- `mcp/synthi-mcp/.env.example` — document the 3 new env vars.

---

## Task 1: Extract the hub into `@synthi/mcp-hub` + npm workspaces

> **Atomic + highest-risk task.** Moving the hub and rewiring imports must land together so `synthi`
> never builds broken. ⚠️ Introducing npm workspaces re-hoists dependencies and changes install
> semantics — if `next build` or `synthi-mcp` `tsc` break after this, **STOP and re-plan** (do not
> patch around it).

**Files:**
- Create: `packages/mcp-hub/package.json`, `packages/mcp-hub/index.d.ts`
- Move: `synthi/src/lib/mcp-hub/*` → `packages/mcp-hub/src/*`
- Modify: root `package.json`, `synthi/next.config.mjs`, and 6 import sites (below)

- [ ] **Step 1: Create the package manifest**

Create `packages/mcp-hub/package.json`:

```json
{
  "name": "@synthi/mcp-hub",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.js",
  "types": "index.d.ts",
  "exports": {
    ".": { "types": "./index.d.ts", "default": "./src/index.js" },
    "./helpers": "./src/helpers.js"
  },
  "scripts": { "test": "vitest run" },
  "dependencies": { "@modelcontextprotocol/sdk": "^1.29.0" },
  "devDependencies": { "vitest": "^4.1.7" }
}
```

- [ ] **Step 2: Move the hub source + tests (preserve history)**

Run from repo root:
```bash
mkdir -p packages/mcp-hub/src
git mv synthi/src/lib/mcp-hub/ssrfGuard.js   packages/mcp-hub/src/ssrfGuard.js
git mv synthi/src/lib/mcp-hub/client.js      packages/mcp-hub/src/client.js
git mv synthi/src/lib/mcp-hub/helpers.js     packages/mcp-hub/src/helpers.js
git mv synthi/src/lib/mcp-hub/guardedFetch.js packages/mcp-hub/src/guardedFetch.js
git mv synthi/src/lib/mcp-hub/index.js       packages/mcp-hub/src/index.js
git mv synthi/src/lib/mcp-hub/__tests__      packages/mcp-hub/src/__tests__
```
The moved modules use **relative** imports of each other, so no edits are needed inside them.

- [ ] **Step 3: Hand-write the public type surface**

Create `packages/mcp-hub/index.d.ts` (consumed by `synthi-mcp`'s `tsc`; `synthi` uses the JS directly):

```ts
export interface McpToolConfig {
  id: string;
  name: string;
  url: string;
  transport?: "http" | "sse";
  authType?: "none" | "bearer" | "header";
  headerName?: string | null;
  secret?: string | null;
  allowlist?: string[];
}
export interface McpTool { name: string; description?: string; inputSchema?: unknown; }
export type HubResult<T> = ({ ok: true } & T) | { ok: false; error: { code: string; message?: string } };

export function listTools(config: McpToolConfig, opts?: unknown): Promise<HubResult<{ tools: McpTool[] }>>;
export function callTool(config: McpToolConfig, toolName: string, args?: Record<string, unknown>, opts?: unknown): Promise<HubResult<{ data: unknown }>>;
export function testConnection(config: McpToolConfig, opts?: unknown): Promise<HubResult<{ serverInfo: unknown; toolCount: number }>>;
export function assertSafeUrl(url: string, opts?: { allowlist?: string[]; lookup?: unknown }): Promise<void>;
export function isBlockedIp(ip: string): boolean;
export function buildAuthHeaders(config: McpToolConfig): Record<string, string>;
export function jsonSchemaToGemini(schema: unknown, depth?: number): unknown;
export function isAllowedHeaderName(name: string): boolean;
```

- [ ] **Step 4: Enable workspaces at the repo root**

Edit root `package.json` — add `"private": true` and a `"workspaces"` array (keep existing
`scripts`/`dependencies`):

```json
{
  "private": true,
  "workspaces": ["synthi", "mcp/synthi-mcp", "packages/*"],
  "scripts": { "start:collab": "node ./backend/collab-server/server.js" },
  "dependencies": { "@google/genai": "^1.30.0", "diff": "^8.0.2" }
}
```

- [ ] **Step 5: Add the workspace dependency to both consumers**

In `synthi/package.json` dependencies add: `"@synthi/mcp-hub": "*"`.
In `mcp/synthi-mcp/package.json` dependencies add: `"@synthi/mcp-hub": "*"`.

- [ ] **Step 6: Install at the root (creates workspace symlinks)**

Run from repo root:
```bash
npm install
```
Expected: completes; `node_modules/@synthi/mcp-hub` is a symlink to `packages/mcp-hub`.

- [ ] **Step 7: Rewrite the 6 `synthi` import sites**

`synthi/src/app/api/chat/externalTools.js` (lines 4-5):
```js
import { listTools, callTool } from '@synthi/mcp-hub';
import { jsonSchemaToGemini } from '@synthi/mcp-hub/helpers';
```
`synthi/src/app/api/integrations/connections/route.js` (line 5):
```js
import { isAllowedHeaderName } from '@synthi/mcp-hub';
```
`synthi/src/app/api/integrations/connections/[id]/route.js` (line 5):
```js
import { isAllowedHeaderName } from '@synthi/mcp-hub';
```
`synthi/src/app/api/integrations/connections/[id]/test/route.js` (line 5):
```js
import { testConnection, listTools } from '@synthi/mcp-hub';
```
`synthi/src/app/api/chat/__tests__/externalTools.test.js` (line 14 + the comment on line 20):
```js
vi.mock('@synthi/mcp-hub', () => ({ listTools: listToolsMock, callTool: callToolMock }));
// NOTE: jsonSchemaToGemini is imported from '@synthi/mcp-hub/helpers' (real, not mocked)
```
`synthi/src/app/api/integrations/connections/__tests__/connectionRoutes.test.js` (line 47):
```js
vi.mock('@synthi/mcp-hub', async (importActual) => {
```

- [ ] **Step 8: Let Next.js transpile the workspace package**

Edit `synthi/next.config.mjs` — add `transpilePackages` to the `nextConfig` object (just after
`output: 'standalone',` on line 26):
```js
  output: 'standalone',
  transpilePackages: ['@synthi/mcp-hub'],
```

- [ ] **Step 9: Verify the moved hub suite is green from its new home**

Run from `packages/mcp-hub/`:
```bash
npx vitest run
```
Expected: PASS — all moved hub tests (ssrfGuard, client, helpers, guardedFetch) pass unchanged.

- [ ] **Step 10: Verify the in-app path still passes against the package**

Run from `synthi/`:
```bash
npx vitest run src/app/api/chat src/app/api/integrations src/lib/integrations
```
Expected: PASS — `externalTools`, `connectionRoutes`, `connectionStore`, `scope`, `rateLimit`,
`session` suites all green (no logic change; only the hub specifier moved).

- [ ] **Step 11: Verify both builds**

Run from `synthi/`: `npm run build` → Expected: build succeeds (46 routes).
Run from `mcp/synthi-mcp/`: `npx tsc --noEmit` → Expected: no type errors (the new
`@synthi/mcp-hub` resolves via `index.d.ts`).

- [ ] **Step 12: Commit**

```bash
git add packages/mcp-hub package.json package-lock.json synthi/package.json mcp/synthi-mcp/package.json synthi/next.config.mjs synthi/src/app/api/chat/externalTools.js synthi/src/app/api/chat/__tests__/externalTools.test.js synthi/src/app/api/integrations/connections/route.js synthi/src/app/api/integrations/connections/[id]/route.js synthi/src/app/api/integrations/connections/[id]/test/route.js synthi/src/app/api/integrations/connections/__tests__/connectionRoutes.test.js
git commit -m 'refactor(1b): extract @synthi/mcp-hub shared package + npm workspaces

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'
```
(Note: `git mv` already staged the moved files; the `git add` above also captures the new package,
root workspace wiring, and the import rewrites. Verify `git status` shows the old
`synthi/src/lib/mcp-hub/` as deleted.)

---

## Task 2: `PersonalAccessToken` model + PAT helpers

**Files:**
- Modify: `synthi/prisma/schema.prisma`
- Create: `synthi/src/lib/integrations/pat.js`, `synthi/src/lib/integrations/__tests__/pat.test.js`

- [ ] **Step 1: Write the failing test**

Create `synthi/src/lib/integrations/__tests__/pat.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { generatePat, hashToken, looksLikePat } from '../pat';

describe('pat helpers', () => {
  it('generatePat returns a prefixed token, matching hash, and last4', () => {
    const { token, tokenHash, last4 } = generatePat();
    expect(token.startsWith('synthi_pat_')).toBe(true);
    expect(token.length).toBeGreaterThan('synthi_pat_'.length + 30);
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(last4).toBe(token.slice(-4));
  });

  it('hashToken is deterministic and differs per token', () => {
    expect(hashToken('a')).toBe(hashToken('a'));
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });

  it('looksLikePat gates obvious non-tokens', () => {
    const { token } = generatePat();
    expect(looksLikePat(token)).toBe(true);
    expect(looksLikePat('nope')).toBe(false);
    expect(looksLikePat('synthi_pat_short')).toBe(false);
    expect(looksLikePat(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run from `synthi/`: `npx vitest run src/lib/integrations/__tests__/pat.test.js`
Expected: FAIL — `Cannot find module '../pat'`.

- [ ] **Step 3: Implement the helper**

Create `synthi/src/lib/integrations/pat.js`:
```js
import crypto from 'node:crypto';

const PREFIX = 'synthi_pat_';

/** sha256 hex of a token string. Stored + looked up — the plaintext is never persisted. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Generate a new PAT. Returns { token (plaintext — show once), tokenHash, last4 }. */
export function generatePat() {
  const token = PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token), last4: token.slice(-4) };
}

/** Cheap shape pre-check before a DB lookup. */
export function looksLikePat(token) {
  return typeof token === 'string' && token.startsWith(PREFIX) && token.length > PREFIX.length + 20;
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run from `synthi/`: `npx vitest run src/lib/integrations/__tests__/pat.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the Prisma model + back-relation**

In `synthi/prisma/schema.prisma`, add to the `User` model (after `memberships WorkspaceMembership[]`
on line 38):
```prisma
  tokens      PersonalAccessToken[]
```
Append a new model at the end of the file:
```prisma
model PersonalAccessToken {
  id         String    @id @default(cuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  name       String
  tokenHash  String    @unique
  last4      String?
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?
  revokedAt  DateTime?

  @@index([userId])
}
```

- [ ] **Step 6: Push the schema + regenerate the client**

Run from `synthi/`:
```bash
npx prisma db push
npx prisma generate
```
Expected: `db push` reports the new table; `generate` succeeds. (Requires `DATABASE_URL`.)

- [ ] **Step 7: Commit**

```bash
git add synthi/prisma/schema.prisma synthi/src/lib/integrations/pat.js synthi/src/lib/integrations/__tests__/pat.test.js
git commit -m 'feat(1b): PersonalAccessToken model + PAT generate/hash helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'
```

---

## Task 3: `/api/integrations/tokens` route + client methods

**Files:**
- Create: `synthi/src/app/api/integrations/tokens/route.js`,
  `synthi/src/app/api/integrations/tokens/[id]/route.js`,
  `synthi/src/app/api/integrations/tokens/__tests__/tokenRoutes.test.js`
- Modify: `synthi/src/components/integrations/integrationsClient.js`

- [ ] **Step 1: Write the failing route test**

Create `synthi/src/app/api/integrations/tokens/__tests__/tokenRoutes.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  pat: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/prisma', () => ({ default: { personalAccessToken: h.pat } }));

import { POST, GET } from '../route';
import { DELETE } from '../[id]/route';
import { __resetRateLimits } from '@/lib/integrations/rateLimit';

function req(body) {
  return new Request('http://x/api/integrations/tokens', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
}

beforeEach(() => {
  __resetRateLimits();
  vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'u1', email: 'a@b.c' });
});

describe('POST /tokens', () => {
  it('creates a token and returns the plaintext exactly once', async () => {
    h.pat.create.mockResolvedValue({ id: 't1', name: 'laptop', last4: 'abcd', createdAt: new Date() });
    const res = await POST(req({ name: 'laptop' }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.token).toMatch(/^synthi_pat_/);
    // The stored row got a hash, never the plaintext.
    expect(h.pat.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'u1', name: 'laptop', tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    }));
    expect(h.pat.create.mock.calls[0][0].data).not.toHaveProperty('token');
  });

  it('401 when unauthenticated', async () => {
    h.actor.mockResolvedValue(null);
    const res = await POST(req({ name: 'x' }));
    expect(res.status).toBe(401);
  });

  it('400 when name is missing', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });
});

describe('GET /tokens', () => {
  it('lists tokens without hash/plaintext', async () => {
    h.pat.findMany.mockResolvedValue([{ id: 't1', name: 'laptop', last4: 'abcd', createdAt: new Date(), lastUsedAt: null, revokedAt: null }]);
    const res = await GET(new Request('http://x/api/integrations/tokens'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tokens[0]).not.toHaveProperty('tokenHash');
    expect(h.pat.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1' },
      select: expect.objectContaining({ tokenHash: false }),
    }));
  });
});

describe('DELETE /tokens/[id]', () => {
  it('revokes a token the caller owns', async () => {
    h.pat.findUnique.mockResolvedValue({ id: 't1', userId: 'u1' });
    h.pat.update.mockResolvedValue({});
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 't1' }) });
    expect(res.status).toBe(200);
    expect(h.pat.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 't1' }, data: expect.objectContaining({ revokedAt: expect.any(Date) }) }));
  });

  it('403 when the token belongs to someone else', async () => {
    h.pat.findUnique.mockResolvedValue({ id: 't1', userId: 'other' });
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 't1' }) });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run from `synthi/`: `npx vitest run src/app/api/integrations/tokens`
Expected: FAIL — `Cannot find module '../route'`.

- [ ] **Step 3: Implement the collection route**

Create `synthi/src/app/api/integrations/tokens/route.js`:
```js
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { resolveActor } from '@/lib/integrations/session';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { generatePat } from '@/lib/integrations/pat';

export const runtime = 'nodejs';

export async function POST(req) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`user:${actor.userId}:crud`, RATE_LIMITS.crud);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const { token, tokenHash, last4 } = generatePat();
  const row = await prisma.personalAccessToken.create({
    data: { userId: actor.userId, name, tokenHash, last4 },
  });
  // `token` (plaintext) is returned exactly once and never stored.
  return NextResponse.json({ id: row.id, name: row.name, last4: row.last4, createdAt: row.createdAt, token }, { status: 201 });
}

export async function GET() {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`user:${actor.userId}:crud`, RATE_LIMITS.crud);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const tokens = await prisma.personalAccessToken.findMany({
    where: { userId: actor.userId },
    select: { id: true, name: true, last4: true, createdAt: true, lastUsedAt: true, revokedAt: true, tokenHash: false },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ tokens });
}
```

- [ ] **Step 4: Implement the item (revoke) route**

Create `synthi/src/app/api/integrations/tokens/[id]/route.js`:
```js
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { resolveActor } from '@/lib/integrations/session';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

export async function DELETE(_req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`user:${actor.userId}:crud`, RATE_LIMITS.crud);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const { id } = await params;
  const row = await prisma.personalAccessToken.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (row.userId !== actor.userId) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  await prisma.personalAccessToken.update({ where: { id }, data: { revokedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run from `synthi/`: `npx vitest run src/app/api/integrations/tokens`
Expected: PASS (6 tests).

- [ ] **Step 6: Add client methods**

Append to `synthi/src/components/integrations/integrationsClient.js`:
```js
const TOKENS = '/api/integrations/tokens';

export async function fetchTokens() {
  const res = await fetch(TOKENS);
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to load tokens');
  return (await res.json()).tokens || [];
}

export async function createToken(name) {
  const res = await fetch(TOKENS, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Failed to create token');
  return data; // { id, name, last4, createdAt, token (plaintext, once) }
}

export async function revokeToken(id) {
  const res = await fetch(`${TOKENS}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to revoke token');
  return true;
}
```

- [ ] **Step 7: Commit**

```bash
git add synthi/src/app/api/integrations/tokens synthi/src/components/integrations/integrationsClient.js
git commit -m 'feat(1b): PAT issuance/list/revoke route + client methods

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'
```

---

## Task 4: PAT issuance UI (CLI Access section)

> No component unit test (the codebase has no React testing-library setup; UI is verified by
> `next build` + the manual E2E). The tested seam is `integrationsClient` (Task 3).

**Files:**
- Create: `synthi/src/components/integrations/CliAccessSection.jsx`
- Modify: `synthi/src/components/integrations/ConnectedToolsPanel.jsx`

- [ ] **Step 1: Build the section component**

Create `synthi/src/components/integrations/CliAccessSection.jsx`:
```jsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plus, Trash2, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { fetchTokens, createToken, revokeToken } from './integrationsClient';

export default function CliAccessSection() {
  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(null); // { name, token } shown once

  const load = useCallback(async () => {
    try { setTokens(await fetchTokens()); } catch (e) { toast.error(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) { toast.error('Name the token (e.g. "laptop / claude-code")'); return; }
    setCreating(true);
    try {
      const created = await createToken(trimmed);
      setJustCreated({ name: created.name, token: created.token });
      setName('');
      load();
    } catch (e) { toast.error(e.message); } finally { setCreating(false); }
  };

  const onRevoke = async (id) => {
    try { await revokeToken(id); setTokens((t) => t.filter((x) => x.id !== id)); toast.success('Token revoked'); }
    catch (e) { toast.error(e.message); }
  };

  const copy = (text) => { navigator.clipboard?.writeText(text); toast.success('Copied'); };

  return (
    <div className="rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
      <div className="flex items-center gap-2 px-2.5 py-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        <KeyRound className="w-3.5 h-3.5" /> CLI Access (Personal Access Tokens)
      </div>

      <div className="px-2.5 pb-2 flex items-center gap-1.5">
        <input
          value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name (e.g. laptop / claude-code)"
          className="flex-1 text-xs rounded px-2 py-1 outline-none"
          style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
        />
        <Button variant="ghost" size="icon" onClick={onCreate} disabled={creating} title="Generate token">
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>

      {justCreated && (
        <div className="mx-2.5 mb-2 rounded p-2 text-[11px]" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
          <div style={{ color: 'var(--text-muted)' }}>Copy this token now — it is shown only once:</div>
          <div className="flex items-center gap-1.5 mt-1">
            <code className="flex-1 break-all font-mono">{justCreated.token}</code>
            <Button variant="ghost" size="icon" onClick={() => copy(justCreated.token)} title="Copy"><Copy className="w-3.5 h-3.5" /></Button>
          </div>
        </div>
      )}

      <div className="px-2.5 pb-2 flex flex-col gap-1">
        {tokens.length === 0 && <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>No tokens yet.</div>}
        {tokens.map((t) => (
          <div key={t.id} className="flex items-center justify-between text-xs">
            <span className="truncate">
              {t.name} <span className="font-mono" style={{ color: 'var(--text-dim)' }}>…{t.last4}</span>
              {t.revokedAt && <span style={{ color: 'var(--accent-danger, #ff5757)' }}> (revoked)</span>}
            </span>
            {!t.revokedAt && (
              <Button variant="ghost" size="icon" onClick={() => onRevoke(t.id)} title="Revoke"><Trash2 className="w-3.5 h-3.5" /></Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render it in the panel**

In `synthi/src/components/integrations/ConnectedToolsPanel.jsx`:
- Add the import after line 8 (`import AddConnectionDialog …`):
```jsx
import CliAccessSection from './CliAccessSection';
```
- Render it at the end of the scrollable list — insert just before the closing `</div>` of the
  `flex-1 overflow-y-auto` container (after the `{connections.map(...)}` block, before line 171's
  `</div>`):
```jsx
        <CliAccessSection />
```

- [ ] **Step 3: Verify the build**

Run from `synthi/`: `npm run build`
Expected: build succeeds (the new client component compiles; CSP/output unchanged).

- [ ] **Step 4: Commit**

```bash
git add synthi/src/components/integrations/CliAccessSection.jsx synthi/src/components/integrations/ConnectedToolsPanel.jsx
git commit -m 'feat(1b): CLI Access PAT issuance UI in Connected Tools panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'
```

---

## Task 5: PAT request authenticator + rate-limit groups

**Files:**
- Modify: `synthi/src/lib/integrations/rateLimit.js`
- Create: `synthi/src/lib/integrations/patAuth.js`,
  `synthi/src/lib/integrations/__tests__/patAuth.test.js`

- [ ] **Step 1: Add the resolve + audit limit groups**

In `synthi/src/lib/integrations/rateLimit.js`, extend `RATE_LIMITS` (after the `extcall` line):
```js
  resolve: { limit: Number(process.env.SYNTHI_RL_RESOLVE) || 30, windowMs: 60_000 },
  audit: { limit: Number(process.env.SYNTHI_RL_AUDIT) || 120, windowMs: 60_000 },
```

- [ ] **Step 2: Write the failing authenticator test**

Create `synthi/src/lib/integrations/__tests__/patAuth.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hashToken, generatePat } from '../pat';

const h = vi.hoisted(() => ({ pat: { findUnique: vi.fn(), update: vi.fn() } }));
vi.mock('@/lib/prisma', () => ({ default: { personalAccessToken: h.pat } }));

import { authenticatePat, bearerToken } from '../patAuth';

function reqWith(authHeader) {
  return new Request('http://x', authHeader ? { headers: { authorization: authHeader } } : undefined);
}

beforeEach(() => { vi.clearAllMocks(); h.pat.update.mockResolvedValue({}); });

describe('bearerToken', () => {
  it('extracts a Bearer token', () => {
    expect(bearerToken(reqWith('Bearer abc'))).toBe('abc');
    expect(bearerToken(reqWith('bearer xyz'))).toBe('xyz');
    expect(bearerToken(reqWith(''))).toBe(null);
    expect(bearerToken(reqWith('Basic abc'))).toBe(null);
  });
});

describe('authenticatePat', () => {
  it('resolves a valid token to its userId and bumps lastUsedAt', async () => {
    const { token } = generatePat();
    h.pat.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', revokedAt: null });
    const actor = await authenticatePat(reqWith(`Bearer ${token}`));
    expect(actor).toEqual({ userId: 'u1' });
    expect(h.pat.findUnique).toHaveBeenCalledWith({ where: { tokenHash: hashToken(token) } });
    expect(h.pat.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 't1' } }));
  });

  it('returns null for an unknown token', async () => {
    const { token } = generatePat();
    h.pat.findUnique.mockResolvedValue(null);
    expect(await authenticatePat(reqWith(`Bearer ${token}`))).toBe(null);
  });

  it('returns null for a revoked token', async () => {
    const { token } = generatePat();
    h.pat.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', revokedAt: new Date() });
    expect(await authenticatePat(reqWith(`Bearer ${token}`))).toBe(null);
  });

  it('returns null without doing a lookup for a non-PAT bearer', async () => {
    expect(await authenticatePat(reqWith('Bearer not-a-pat'))).toBe(null);
    expect(h.pat.findUnique).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run from `synthi/`: `npx vitest run src/lib/integrations/__tests__/patAuth.test.js`
Expected: FAIL — `Cannot find module '../patAuth'`.

- [ ] **Step 4: Implement the authenticator**

Create `synthi/src/lib/integrations/patAuth.js`:
```js
import prisma from '@/lib/prisma';
import { hashToken, looksLikePat } from './pat';

/** Extract a Bearer token from the Authorization header, or null. */
export function bearerToken(req) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * Authenticate a PAT-bearing request. Returns { userId } on success, else null.
 * Bumps lastUsedAt (best-effort). Rejects unknown/revoked tokens. Never throws.
 * @param {Request} req
 * @returns {Promise<{userId:string}|null>}
 */
export async function authenticatePat(req) {
  const token = bearerToken(req);
  if (!looksLikePat(token)) return null;
  let row;
  try {
    row = await prisma.personalAccessToken.findUnique({ where: { tokenHash: hashToken(token) } });
  } catch {
    return null;
  }
  if (!row || row.revokedAt) return null;
  // Fire-and-forget; a failed bump must not fail auth.
  prisma.personalAccessToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { userId: row.userId };
}
```

- [ ] **Step 5: Run it to confirm it passes**

Run from `synthi/`: `npx vitest run src/lib/integrations/__tests__/patAuth.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add synthi/src/lib/integrations/rateLimit.js synthi/src/lib/integrations/patAuth.js synthi/src/lib/integrations/__tests__/patAuth.test.js
git commit -m 'feat(1b): PAT request authenticator + resolve/audit rate-limit groups

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'
```

---

## Task 6: `GET /api/integrations/mcp/resolve`

**Files:**
- Create: `synthi/src/app/api/integrations/mcp/resolve/route.js`,
  `synthi/src/app/api/integrations/mcp/resolve/__tests__/resolveRoute.test.js`

- [ ] **Step 1: Write the failing test**

Create `synthi/src/app/api/integrations/mcp/resolve/__tests__/resolveRoute.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ auth: vi.fn(), resolve: vi.fn(), canRead: vi.fn() }));
vi.mock('@/lib/integrations/patAuth', () => ({ authenticatePat: h.auth }));
vi.mock('@/lib/integrations/connectionStore', () => ({ resolveToolConfigs: h.resolve }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.canRead }));

import { GET } from '../route';
import { __resetRateLimits } from '@/lib/integrations/rateLimit';

function req(slug) {
  const qs = slug ? `?workspaceSlug=${encodeURIComponent(slug)}` : '';
  return new Request(`http://x/api/integrations/mcp/resolve${qs}`, { headers: { authorization: 'Bearer synthi_pat_xxxxxxxxxxxxxxxxxxxxxxxx' } });
}

beforeEach(() => { __resetRateLimits(); vi.clearAllMocks(); h.resolve.mockResolvedValue([{ id: 'c1', name: 'gh' }]); });

it('401 when the PAT is invalid', async () => {
  h.auth.mockResolvedValue(null);
  const res = await GET(req());
  expect(res.status).toBe(401);
  expect(h.resolve).not.toHaveBeenCalled();
});

it('returns personal-only configs when no workspaceSlug is given', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  const res = await GET(req());
  expect(res.status).toBe(200);
  expect((await res.json()).configs).toEqual([{ id: 'c1', name: 'gh' }]);
  expect(h.resolve).toHaveBeenCalledWith({ userId: 'u1', workspaceSlug: null });
});

it('includes the workspace scope only for a member', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.canRead.mockResolvedValue(true);
  await GET(req('team'));
  expect(h.resolve).toHaveBeenCalledWith({ userId: 'u1', workspaceSlug: 'team' });
});

it('degrades a non-member workspaceSlug to personal-only', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.canRead.mockResolvedValue(false);
  await GET(req('team'));
  expect(h.resolve).toHaveBeenCalledWith({ userId: 'u1', workspaceSlug: null });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run from `synthi/`: `npx vitest run src/app/api/integrations/mcp/resolve`
Expected: FAIL — `Cannot find module '../route'`.

- [ ] **Step 3: Implement the route**

Create `synthi/src/app/api/integrations/mcp/resolve/route.js`:
```js
import { NextResponse } from 'next/server';
import { authenticatePat } from '@/lib/integrations/patAuth';
import { canReadScope } from '@/lib/integrations/scope';
import { resolveToolConfigs } from '@/lib/integrations/connectionStore';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

export async function GET(req) {
  const actor = await authenticatePat(req);
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`cli:${actor.userId}:resolve`, RATE_LIMITS.resolve);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const requested = new URL(req.url).searchParams.get('workspaceSlug') || null;
  // Same defense-in-depth as the in-app path: a non-member slug degrades to personal-only.
  let workspaceSlug = null;
  if (requested && (await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: requested }))) {
    workspaceSlug = requested;
  }
  const configs = await resolveToolConfigs({ userId: actor.userId, workspaceSlug });
  return NextResponse.json({ configs });
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run from `synthi/`: `npx vitest run src/app/api/integrations/mcp/resolve`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/app/api/integrations/mcp/resolve
git commit -m 'feat(1b): PAT-authed /api/integrations/mcp/resolve (scoped decrypted configs)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'
```

---

## Task 7: `POST /api/integrations/mcp/audit`

**Files:**
- Create: `synthi/src/app/api/integrations/mcp/audit/route.js`,
  `synthi/src/app/api/integrations/mcp/audit/__tests__/auditRoute.test.js`

- [ ] **Step 1: Write the failing test**

Create `synthi/src/app/api/integrations/mcp/audit/__tests__/auditRoute.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  canRead: vi.fn(),
  prisma: { mcpCallAudit: { create: vi.fn() }, mcpConnection: { findUnique: vi.fn() } },
}));
vi.mock('@/lib/integrations/patAuth', () => ({ authenticatePat: h.auth }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.canRead }));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));

import { POST } from '../route';
import { __resetRateLimits } from '@/lib/integrations/rateLimit';

function req(body) {
  return new Request('http://x/api/integrations/mcp/audit', {
    method: 'POST', headers: { authorization: 'Bearer synthi_pat_xxxxxxxxxxxxxxxxxxxxxxxx', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  __resetRateLimits(); vi.clearAllMocks();
  h.prisma.mcpCallAudit.create.mockResolvedValue({});
  h.prisma.mcpConnection.findUnique.mockResolvedValue({ id: 'c1' });
});

it('401 when the PAT is invalid', async () => {
  h.auth.mockResolvedValue(null);
  expect((await POST(req({ outcome: 'ok' }))).status).toBe(401);
  expect(h.prisma.mcpCallAudit.create).not.toHaveBeenCalled();
});

it('writes a callerType=cli row with hash + sizes only', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  const res = await POST(req({ connId: 'c1', serverName: 'gh', toolName: 'create_pr', alias: 'ext_0', outcome: 'ok', durationMs: 12, argsHash: 'a'.repeat(64), argsBytes: 10, resultBytes: 20 }));
  expect(res.status).toBe(201);
  const data = h.prisma.mcpCallAudit.create.mock.calls[0][0].data;
  expect(data).toMatchObject({ connectionId: 'c1', serverName: 'gh', toolName: 'create_pr', userId: 'u1', callerType: 'cli', outcome: 'ok', alias: 'ext_0', argsHash: 'a'.repeat(64), argsBytes: 10, resultBytes: 20 });
  // No raw payloads ever.
  expect(data).not.toHaveProperty('args');
  expect(data).not.toHaveProperty('result');
});

it('nulls connectionId when the connection no longer exists', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.prisma.mcpConnection.findUnique.mockResolvedValue(null);
  await POST(req({ connId: 'gone', serverName: 'gh', toolName: 't', outcome: 'error', errorCode: 'tool_error' }));
  expect(h.prisma.mcpCallAudit.create.mock.calls[0][0].data.connectionId).toBe(null);
});

it('echoes workspaceSlug only for a member', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.canRead.mockResolvedValue(false);
  await POST(req({ serverName: 'gh', toolName: 't', outcome: 'ok', workspaceSlug: 'team' }));
  expect(h.prisma.mcpCallAudit.create.mock.calls[0][0].data.workspaceSlug).toBe(null);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run from `synthi/`: `npx vitest run src/app/api/integrations/mcp/audit`
Expected: FAIL — `Cannot find module '../route'`.

- [ ] **Step 3: Implement the route**

Create `synthi/src/app/api/integrations/mcp/audit/route.js`:
```js
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { authenticatePat } from '@/lib/integrations/patAuth';
import { canReadScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

const num = (v) => (Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v : null);

export async function POST(req) {
  const actor = await authenticatePat(req);
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`cli:${actor.userId}:audit`, RATE_LIMITS.audit);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const b = await req.json().catch(() => ({}));

  // Only link connectionId if the connection still exists (avoid FK violation on a stale id).
  let connectionId = null;
  if (str(b.connId)) {
    const conn = await prisma.mcpConnection.findUnique({ where: { id: b.connId } });
    connectionId = conn ? conn.id : null;
  }
  // Echo workspaceSlug only when the PAT's user is a member.
  let workspaceSlug = null;
  if (b.workspaceSlug && (await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: b.workspaceSlug }))) {
    workspaceSlug = b.workspaceSlug;
  }
  const outcome = ['ok', 'error', 'blocked'].includes(b.outcome) ? b.outcome : 'error';

  try {
    await prisma.mcpCallAudit.create({
      data: {
        connectionId,
        serverName: str(b.serverName) || 'unknown',
        toolName: str(b.toolName) || 'unknown',
        userId: actor.userId,
        workspaceSlug,
        outcome,
        errorCode: str(b.errorCode),
        alias: str(b.alias),
        callerType: 'cli',
        durationMs: num(b.durationMs),
        argsHash: str(b.argsHash),
        argsBytes: num(b.argsBytes),
        resultBytes: num(b.resultBytes),
      },
    });
  } catch {
    return NextResponse.json({ error: 'audit_write_failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run from `synthi/`: `npx vitest run src/app/api/integrations/mcp/audit`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/app/api/integrations/mcp/audit
git commit -m 'feat(1b): PAT-authed /api/integrations/mcp/audit (callerType=cli, redacted)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'
```

---

## Task 8: `synthi-mcp` external-tools module

**Files:**
- Create: `mcp/synthi-mcp/src/external/config.ts`, `mcp/synthi-mcp/src/external/index.ts`,
  `mcp/synthi-mcp/tests/unit/external.test.ts`

- [ ] **Step 1: Write the config reader**

Create `mcp/synthi-mcp/src/external/config.ts`:
```ts
export interface ExternalConfig {
  apiUrl: string;
  pat: string;
  workspaceSlug?: string;
}

/** Read external-tools config from env. Returns null (feature off) unless apiUrl AND pat are set. */
export function readExternalConfig(env: NodeJS.ProcessEnv = process.env): ExternalConfig | null {
  const apiUrl = env["SYNTHI_API_URL"]?.trim();
  const pat = env["SYNTHI_PAT"]?.trim();
  if (!apiUrl || !pat) return null;
  const workspaceSlug = env["SYNTHI_WORKSPACE_SLUG"]?.trim();
  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    pat,
    ...(workspaceSlug ? { workspaceSlug } : {}),
  };
}
```

- [ ] **Step 2: Write the failing module test**

Create `mcp/synthi-mcp/tests/unit/external.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveExternalTools,
  callExternalTool,
  isExternalToolName,
  __resetExtCall,
  type AliasEntry,
} from "../../src/external/index.js";

const cfg = { id: "c1", name: "gh", url: "https://gh.example/mcp", allowlist: ["create_pr", "list_pr"] };

function fakeListTools(tools: { name: string; description?: string; inputSchema?: unknown }[]) {
  return async () => ({ ok: true as const, tools });
}

beforeEach(() => { __resetExtCall(); });

describe("isExternalToolName", () => {
  it("matches only ext_<n>", () => {
    expect(isExternalToolName("ext_0")).toBe(true);
    expect(isExternalToolName("ext_42")).toBe(true);
    expect(isExternalToolName("synthi_attach")).toBe(false);
    expect(isExternalToolName("ext_")).toBe(false);
  });
});

describe("resolveExternalTools", () => {
  it("is off (empty) when no config", async () => {
    const out = await resolveExternalTools({} as NodeJS.ProcessEnv, {
      readExternalConfig: () => null,
      listTools: fakeListTools([]),
      fetchConfigs: async () => [],
    });
    expect(out).toEqual({ descriptors: [], aliasMap: {} });
  });

  it("builds ext_<i> descriptors for allowlisted tools only", async () => {
    const out = await resolveExternalTools({} as NodeJS.ProcessEnv, {
      readExternalConfig: () => ({ apiUrl: "https://app", pat: "synthi_pat_x" }),
      fetchConfigs: async () => [cfg],
      listTools: fakeListTools([
        { name: "create_pr", description: "Open a PR", inputSchema: { type: "object" } },
        { name: "secret_tool", description: "not allowlisted" },
      ]),
    });
    expect(out.descriptors).toHaveLength(1);
    expect(out.descriptors[0]).toMatchObject({ name: "ext_0", description: "[gh] Open a PR" });
    expect(out.aliasMap["ext_0"]).toMatchObject({ connId: "c1", connName: "gh", toolName: "create_pr" });
  });

  it("degrades to empty when resolve throws", async () => {
    const out = await resolveExternalTools({} as NodeJS.ProcessEnv, {
      readExternalConfig: () => ({ apiUrl: "https://app", pat: "synthi_pat_x" }),
      fetchConfigs: async () => { throw new Error("network"); },
      listTools: fakeListTools([]),
    });
    expect(out).toEqual({ descriptors: [], aliasMap: {} });
  });
});

describe("callExternalTool", () => {
  const aliasMap: Record<string, AliasEntry> = {
    ext_0: { connId: "c1", connName: "gh", toolName: "create_pr", config: cfg },
  };

  it("routes a known alias through the hub and audits ok", async () => {
    const audits: any[] = [];
    const res = await callExternalTool("ext_0", { title: "x" }, aliasMap, {} as NodeJS.ProcessEnv, {
      callTool: async () => ({ ok: true as const, data: { number: 7 } }),
      postAudit: async (_e, row) => { audits.push(row); },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ number: 7 });
    expect(audits[0]).toMatchObject({ alias: "ext_0", outcome: "ok", argsHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("returns isError + audits error for an unknown alias", async () => {
    const audits: any[] = [];
    const res = await callExternalTool("ext_99", {}, aliasMap, {} as NodeJS.ProcessEnv, {
      callTool: async () => ({ ok: true as const, data: {} }),
      postAudit: async (_e, row) => { audits.push(row); },
    });
    expect(res.isError).toBe(true);
    expect(audits[0]).toMatchObject({ outcome: "error", errorCode: "unknown_alias" });
  });

  it("returns isError + audits error when the hub call fails", async () => {
    const res = await callExternalTool("ext_0", {}, aliasMap, {} as NodeJS.ProcessEnv, {
      callTool: async () => ({ ok: false as const, error: { code: "tool_error", message: "boom" } }),
      postAudit: async () => {},
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].type === "text" ? res.content[0].text : "{}")).toMatchObject({ error: "external_tool_failed", code: "tool_error" });
  });

  it("blocks past the per-process extcall limit", async () => {
    process.env["SYNTHI_MCP_EXTCALL_LIMIT"] = "1";
    __resetExtCall();
    const call = () => callExternalTool("ext_0", {}, aliasMap, {} as NodeJS.ProcessEnv, {
      callTool: async () => ({ ok: true as const, data: {} }),
      postAudit: async () => {},
    });
    await call();
    const blocked = await call();
    expect(blocked.isError).toBe(true);
    expect(JSON.parse(blocked.content[0].type === "text" ? blocked.content[0].text : "{}").error).toBe("rate_limited");
    delete process.env["SYNTHI_MCP_EXTCALL_LIMIT"];
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run from `mcp/synthi-mcp/`: `npx vitest run tests/unit/external.test.ts`
Expected: FAIL — `Cannot find module '../../src/external/index.js'`.

- [ ] **Step 4: Implement the module**

Create `mcp/synthi-mcp/src/external/index.ts`:
```ts
import crypto from "node:crypto";
import { listTools, callTool, type McpToolConfig, type McpTool } from "@synthi/mcp-hub";
import { readExternalConfig, type ExternalConfig } from "./config.js";
import { jsonResponse, errorResponse, type ToolResponse } from "../tools/shared.js";

export interface ExternalToolDescriptor { name: string; description: string; inputSchema: unknown; }
export interface AliasEntry { connId: string; connName: string; toolName: string; config: McpToolConfig; }
export interface ExternalTools { descriptors: ExternalToolDescriptor[]; aliasMap: Record<string, AliasEntry>; }

interface AuditRow {
  alias?: string; connId?: string; serverName?: string; toolName?: string;
  outcome: "ok" | "error" | "blocked"; errorCode?: string;
  durationMs?: number; argsHash?: string; argsBytes?: number; resultBytes?: number | null;
}

const ALIAS_RE = /^ext_\d+$/;
const MAX_TOOLS_PER_CONN = Number(process.env["SYNTHI_MCP_MAX_TOOLS_PER_CONN"]) || 64;
const MAX_LISTTOOLS_CONCURRENCY = Number(process.env["SYNTHI_MCP_LISTTOOLS_CONCURRENCY"]) || 5;
const EXTCALL_WINDOW_MS = 60_000;

let extWindow = { count: 0, resetAt: 0 };
function extCallAllowed(now = Date.now()): boolean {
  const limit = Number(process.env["SYNTHI_MCP_EXTCALL_LIMIT"]) || 60;
  if (now >= extWindow.resetAt) extWindow = { count: 0, resetAt: now + EXTCALL_WINDOW_MS };
  if (extWindow.count >= limit) return false;
  extWindow.count += 1;
  return true;
}
/** Test-only: reset the per-process extcall window. */
export function __resetExtCall(): void { extWindow = { count: 0, resetAt: 0 }; }

export function isExternalToolName(name: string): boolean { return ALIAS_RE.test(name); }

function sha256Hex(s: string): string { return crypto.createHash("sha256").update(s).digest("hex"); }

async function fetchConfigs(cfg: ExternalConfig): Promise<McpToolConfig[]> {
  const url = new URL(`${cfg.apiUrl}/api/integrations/mcp/resolve`);
  if (cfg.workspaceSlug) url.searchParams.set("workspaceSlug", cfg.workspaceSlug);
  const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.pat}` } });
  if (!res.ok) throw new Error(`resolve_failed_${res.status}`);
  const body = (await res.json()) as { configs?: McpToolConfig[] };
  return body.configs ?? [];
}

/** POST a redacted audit row. Never throws — audit failures must not break a tool call. */
export async function postAudit(env: NodeJS.ProcessEnv, row: AuditRow): Promise<void> {
  const cfg = readExternalConfig(env);
  if (!cfg) return;
  try {
    await fetch(`${cfg.apiUrl}/api/integrations/mcp/audit`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.pat}`, "content-type": "application/json" },
      body: JSON.stringify({ ...row, ...(cfg.workspaceSlug ? { workspaceSlug: cfg.workspaceSlug } : {}) }),
    });
  } catch { /* swallow */ }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx] as T);
    }
  }
  const n = Math.min(limit, items.length);
  if (n <= 0) return results;
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

export async function resolveExternalTools(
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    readExternalConfig: typeof readExternalConfig;
    listTools: typeof listTools;
    fetchConfigs: typeof fetchConfigs;
  } = { readExternalConfig, listTools, fetchConfigs },
): Promise<ExternalTools> {
  const cfg = deps.readExternalConfig(env);
  if (!cfg) return { descriptors: [], aliasMap: {} };

  let configs: McpToolConfig[];
  try {
    configs = await deps.fetchConfigs(cfg);
  } catch (e) {
    process.stderr.write(`synthi-mcp external: resolve failed: ${(e as Error).message}\n`);
    return { descriptors: [], aliasMap: {} };
  }

  const listed = await mapWithConcurrency(configs, MAX_LISTTOOLS_CONCURRENCY, async (config) => {
    try { return { config, res: await deps.listTools(config) }; }
    catch (e) { return { config, res: { ok: false as const, error: { code: "protocol_error", message: (e as Error).message } } }; }
  });

  const descriptors: ExternalToolDescriptor[] = [];
  const aliasMap: Record<string, AliasEntry> = {};
  let i = 0;
  for (const { config, res } of listed) {
    if (!res.ok) {
      process.stderr.write(`synthi-mcp external: listTools failed for "${config.name}": ${res.error.code}\n`);
      continue;
    }
    const allow = new Set(config.allowlist ?? []);
    let perConn = 0;
    for (const tool of (res.tools ?? []) as McpTool[]) {
      if (!allow.has(tool.name)) continue;
      if (perConn >= MAX_TOOLS_PER_CONN) break;
      const alias = `ext_${i++}`;
      perConn += 1;
      descriptors.push({
        name: alias,
        description: `[${config.name}] ${tool.description ?? tool.name}`,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      });
      aliasMap[alias] = { connId: config.id, connName: config.name, toolName: tool.name, config };
    }
  }
  return { descriptors, aliasMap };
}

export async function callExternalTool(
  alias: string,
  args: Record<string, unknown> | undefined,
  aliasMap: Record<string, AliasEntry>,
  env: NodeJS.ProcessEnv = process.env,
  deps: { callTool: typeof callTool; postAudit: typeof postAudit } = { callTool, postAudit },
): Promise<ToolResponse> {
  const argsJson = (() => { try { return JSON.stringify(args ?? {}); } catch { return "{}"; } })();
  const argsBytes = Buffer.byteLength(argsJson);
  const argsHash = sha256Hex(argsJson);
  const entry = aliasMap[alias];

  if (!entry) {
    await deps.postAudit(env, { alias, outcome: "error", errorCode: "unknown_alias", argsHash, argsBytes });
    return errorResponse("unknown_tool", { tool: alias, hint: "It may have been disabled. Do not retry." });
  }
  const base = { alias, connId: entry.connId, serverName: entry.connName, toolName: entry.toolName, argsHash, argsBytes };

  if (!extCallAllowed()) {
    await deps.postAudit(env, { ...base, outcome: "blocked", errorCode: "rate_limited" });
    return errorResponse("rate_limited", { detail: "External tool call rate limit reached. Slow down and retry shortly." });
  }

  const started = Date.now();
  let res: Awaited<ReturnType<typeof callTool>>;
  try { res = await deps.callTool(entry.config, entry.toolName, args ?? {}); }
  catch (e) { res = { ok: false, error: { code: "protocol_error", message: (e as Error).message } }; }
  const durationMs = Date.now() - started;

  if (!res.ok) {
    await deps.postAudit(env, { ...base, outcome: "error", errorCode: res.error.code, durationMs });
    return errorResponse("external_tool_failed", { tool: entry.toolName, code: res.error.code, message: res.error.message });
  }

  let resultBytes: number | null = null;
  try { resultBytes = Buffer.byteLength(JSON.stringify(res.data ?? null)); } catch { /* leave null */ }
  await deps.postAudit(env, { ...base, outcome: "ok", durationMs, resultBytes });
  return jsonResponse((res.data ?? {}) as Record<string, unknown>);
}
```

- [ ] **Step 5: Run the tests + typecheck**

Run from `mcp/synthi-mcp/`:
```bash
npx vitest run tests/unit/external.test.ts
npx tsc --noEmit
```
Expected: vitest PASS (all `external` tests); `tsc` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add mcp/synthi-mcp/src/external mcp/synthi-mcp/tests/unit/external.test.ts
git commit -m 'feat(1b): synthi-mcp external-tools module (resolve, dispatch, audit)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'
```

---

## Task 9: Wire external tools into the `synthi-mcp` server

**Files:**
- Modify: `mcp/synthi-mcp/src/server.ts`, `mcp/synthi-mcp/src/index.ts`
- Create: `mcp/synthi-mcp/tests/unit/external_server.test.ts`

- [ ] **Step 1: Extend server options + merge into ListTools + intercept dispatch**

In `mcp/synthi-mcp/src/server.ts`:
- Add the import (near the other tool imports):
```ts
import { isExternalToolName, callExternalTool, type ExternalTools } from "./external/index.js";
```
- Extend the options interface:
```ts
export interface SynthiServerOptions {
  defaultSessionId?: string;
  defaultSignalingUrl: string;
  externalTools?: ExternalTools;
}
```
- In the `ListToolsRequestSchema` handler, append external descriptors:
```ts
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      ...(options.externalTools?.descriptors ?? []).map((d) => ({
        name: d.name, description: d.description, inputSchema: d.inputSchema as Record<string, unknown>,
      })),
    ],
  }));
```
- In the `CallToolRequestSchema` handler, intercept external aliases **before** the quota gate +
  `dispatchTool` (just after `const args = request.params.arguments;`):
```ts
    if (isExternalToolName(toolName)) {
      const result = await callExternalTool(
        toolName,
        (args ?? {}) as Record<string, unknown>,
        options.externalTools?.aliasMap ?? {},
      );
      recordToolCall(toolName, result.isError ? "error" : "ok");
      return result as CallToolResult;
    }
```

- [ ] **Step 2: Resolve external tools at startup**

In `mcp/synthi-mcp/src/index.ts`:
- Add the import (with the other imports):
```ts
import { resolveExternalTools } from "./external/index.js";
```
- In `main()`, just before `const server = createSynthiServer({...})`:
```ts
  // External MCP tools (Slice 1b): resolved once at startup when SYNTHI_API_URL +
  // SYNTHI_PAT are configured; otherwise empty (feature off, no behavior change).
  const externalTools = await resolveExternalTools();
  if (externalTools.descriptors.length > 0) {
    process.stderr.write(`synthi-mcp external: ${externalTools.descriptors.length} proxied tool(s) advertised\n`);
  }
```
- Pass it into the constructor:
```ts
  const server = createSynthiServer({
    defaultSessionId,
    defaultSignalingUrl,
    externalTools,
  });
```

- [ ] **Step 3: Write the server-wiring test**

Create `mcp/synthi-mcp/tests/unit/external_server.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSynthiServer } from "../../src/server.js";
import type { ExternalTools } from "../../src/external/index.js";

const externalTools: ExternalTools = {
  descriptors: [{ name: "ext_0", description: "[gh] Open a PR", inputSchema: { type: "object", properties: {} } }],
  aliasMap: { ext_0: { connId: "c1", connName: "gh", toolName: "create_pr", config: { id: "c1", name: "gh", url: "https://gh/mcp" } } },
};

async function connectedClient(opts: Parameters<typeof createSynthiServer>[0]) {
  const server = createSynthiServer(opts);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe("external tools wired into the MCP server", () => {
  it("advertises ext_<i> alongside the built-in synthi_* tools", async () => {
    const client = await connectedClient({ defaultSignalingUrl: "ws://x", externalTools });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("synthi_attach");
    expect(names).toContain("ext_0");
  });

  it("does not advertise ext_ tools when none are configured", async () => {
    const client = await connectedClient({ defaultSignalingUrl: "ws://x" });
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name.startsWith("ext_"))).toBe(false);
  });
});
```

- [ ] **Step 4: Run the tests + typecheck**

Run from `mcp/synthi-mcp/`:
```bash
npx vitest run tests/unit/external_server.test.ts
npx tsc --noEmit
```
Expected: vitest PASS (2 tests); `tsc` no errors. (If `@modelcontextprotocol/sdk/inMemory.js` is not
exported in the installed SDK version, fall back to asserting on the `ListTools` handler via
`server`'s request handler directly — but the in-memory transport is the standard SDK test seam.)

- [ ] **Step 5: Run the FULL synthi-mcp unit suite (no regressions)**

Run from `mcp/synthi-mcp/`: `npx vitest run tests/unit`
Expected: PASS — the pre-existing `synthi_*` tool suites are unaffected (external dispatch is additive
and gated on `ext_` names).

- [ ] **Step 6: Commit**

```bash
git add mcp/synthi-mcp/src/server.ts mcp/synthi-mcp/src/index.ts mcp/synthi-mcp/tests/unit/external_server.test.ts
git commit -m 'feat(1b): advertise + dispatch external ext_<i> tools in synthi-mcp server

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'
```

---

## Task 10: Env docs, E2E checklist, whole-plan verification

**Files:**
- Modify: `mcp/synthi-mcp/.env.example`
- Create: `docs/superpowers/plans/2026-06-02-external-mcp-client-1b-E2E.md`

- [ ] **Step 1: Document the new env vars**

In `mcp/synthi-mcp/.env.example`, add a section after the "Session / signaling" block:
```bash
# ── External MCP tools (Slice 1b) ────────────────────────────────────
# Point the MCP at your Synthi app + a Personal Access Token so connected
# external MCP tools appear as ext_<i> proxied tools. Generate the PAT in
# Synthi → Connected Tools → CLI Access. Leave unset to disable (default).
# SYNTHI_API_URL=https://app.synthi.example
# SYNTHI_PAT=synthi_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Optional: also include this workspace's tools (requires you to be a member).
# SYNTHI_WORKSPACE_SLUG=my-team
```

- [ ] **Step 2: Write the E2E checklist**

Create `docs/superpowers/plans/2026-06-02-external-mcp-client-1b-E2E.md`:
```markdown
# Slice 1b — Manual E2E (CLI consumer, closes criterion #4)

Prereqs: running Postgres + Synthi (`npx prisma db push` applied) + a Gemini key not required
(the CLI agent uses its own LLM). At least one connected external MCP with ≥1 tool allowlisted.

1. **Generate a PAT.** In Synthi → Connected Tools → "CLI Access", create a token; copy the
   plaintext (shown once).
2. **Register synthi-mcp.** Set `SYNTHI_API_URL`, `SYNTHI_PAT` (and optional `SYNTHI_WORKSPACE_SLUG`)
   in the MCP host registration (or `mcp/synthi-mcp/.env`). Build: `cd mcp/synthi-mcp && npm run build`.
3. **Attach a CLI agent** (e.g. Claude Code) and list tools. ✅ Expect built-in `synthi_*` tools
   PLUS `ext_<i>` entries described `[<connection>] <tool>`.
4. **Call a proxied tool** (e.g. the agent invokes `ext_0` for a connected GitHub/Sentry/Linear
   action). ✅ Expect the remote MCP result returned.
5. **Verify the audit trail.** In Postgres: `SELECT callerType, alias, serverName, toolName, outcome,
   argsHash, argsBytes, resultBytes FROM "McpCallAudit" WHERE "callerType" = 'cli' ORDER BY "createdAt"
   DESC LIMIT 5;` ✅ Expect a `cli` row with a 64-hex `argsHash` and byte sizes — never raw args.
6. **Revoke + re-attach.** Revoke the PAT in the UI; restart the MCP. ✅ Expect external tools absent
   (401 at resolve) while `synthi_*` tools still work.
```

- [ ] **Step 3: Whole-plan verification gate**

Run all suites and builds:
- From `synthi/`: `npx vitest run` → Expected: PASS (Slice-1a suites + the new pat/patAuth/tokens/
  resolve/audit suites).
- From `packages/mcp-hub/`: `npx vitest run` → Expected: PASS.
- From `mcp/synthi-mcp/`: `npx vitest run tests/unit && npx tsc --noEmit` → Expected: PASS + no type
  errors.
- From `synthi/`: `npm run build` → Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add mcp/synthi-mcp/.env.example docs/superpowers/plans/2026-06-02-external-mcp-client-1b-E2E.md
git commit -m 'docs(1b): synthi-mcp external-tools env + manual E2E checklist

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'
```

---

## Final review (controller, after all tasks)

- Whole-branch review (`superpowers:requesting-code-review`) focusing on: PAT hashing (no plaintext at
  rest), the resolve endpoint returning decrypted secrets only to a valid PAT over the documented
  HTTPS contract, audit redaction (hash + sizes only), `canReadScope` parity on both endpoints, and
  the npm-workspaces migration not breaking Docker builds.
- Then `superpowers:finishing-a-development-branch`.

## Self-review notes (author)

- **Spec coverage:** PAT model+UI+route (Tasks 2-4); resolve (6); audit (7); hub extraction P1 (1);
  synthi-mcp wiring (8-9); env+E2E (10); rate-limit groups (5). All spec components a-f + success
  criteria 1-8 mapped.
- **Type consistency:** `McpToolConfig`/`AliasEntry`/`ExternalTools`/`HubResult` defined in the hub
  d.ts (Task 1) + external module (Task 8) and reused verbatim in Task 9. `resolveToolConfigs` config
  shape (`{id,name,url,transport,authType,headerName,secret,allowlist}`) matches `McpToolConfig`.
  `RATE_LIMITS.resolve`/`.audit` added in Task 5 before use in Tasks 6/7.
- **Known risk:** the npm-workspaces migration (Task 1) — gated by builds in Step 11 + Task 10 Step 3;
  STOP-and-re-plan if Docker/`next build` resolution breaks.
