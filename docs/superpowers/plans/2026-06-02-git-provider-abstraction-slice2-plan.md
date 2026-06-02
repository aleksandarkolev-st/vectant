# Git Provider Abstraction (Slice 2 v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect GitLab + self-hosted/"generic" Git providers alongside GitHub behind one adapter interface, with credentials in the Slice-1 vault and API-level actions (list repos, create PR/MR, read status), authenticated by OAuth (web + device) or PAT.

**Architecture:** A new `GitProvider` Prisma model (sibling to `McpConnection`) holds per-user/workspace provider connections; secrets live in `EncryptedSecret`. A `providerType→adapter` registry normalizes provider REST differences (GitHub PR ⇄ GitLab MR). Routes under `/api/integrations/git/` reuse the Slice-1 auth/scope/rate-limit pattern; every outbound URL passes the `assertSafeUrl` SSRF guard.

**Tech Stack:** Next.js (JS API routes, `runtime='nodejs'`), Prisma/Postgres, vitest, `@synthi/mcp-hub` (`assertSafeUrl`), `@/lib/tokenCrypto` (AES-256-GCM), `@/lib/integrations/{session,scope,rateLimit}`.

**Branch:** `tool-compatibility` (shared by all slices — do NOT create a new branch).

**Spec:** `docs/superpowers/specs/2026-06-02-git-provider-abstraction-slice2-design.md`

## Operating rules (every task)
- TDD: write the failing test first, see it fail, implement, see it pass, commit.
- Run vitest from `synthi/`: `npx vitest run <path>`. Do NOT run `npm run build` (disk-heavy; deferred to Task 10's gate).
- Mock `@/lib/prisma` and `@/lib/integrations/session`; any handle used inside a hoisted `vi.mock` factory MUST be created via `vi.hoisted(() => ({...}))`.
- Stage only the files a task touches (never `git add -A`/`.`). Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Reuse, don't reinvent: `resolveActor()` (→`{userId,email}`|null), `canReadScope({userId},{scope,workspaceSlug})`→bool, `checkLimit(key,RATE_LIMITS.x)`, `encryptToken`/`decryptToken`, `assertSafeUrl(url)` (throws on unsafe).

## File Structure
- `synthi/prisma/schema.prisma` — add `GitProvider` + two `EncryptedSecret` back-relations (T1).
- `synthi/src/lib/git/providerConfig.js` — per-type endpoints/defaults + `resolveBaseUrl` (T3).
- `synthi/src/lib/git/safeFetch.js` — `gitFetch(url, init)` = `assertSafeUrl` + `fetch` (T3).
- `synthi/src/lib/git/token.js` — `getToken(conn)` / `withFreshToken(conn)` (PAT + OAuth refresh) (T3).
- `synthi/src/lib/git/adapters/{github,gitlab,generic}.js` + `synthi/src/lib/git/adapters/index.js` (registry) — normalized actions (T4).
- `synthi/src/lib/git/store.js` — `createPatProvider/listProviders/getProvider/deleteProvider` (encrypt + scope) (T2).
- `synthi/src/app/api/integrations/git/providers/route.js` + `…/[id]/route.js` + `…/[id]/test/route.js` (T5).
- `synthi/src/app/api/integrations/git/providers/[id]/{repos,pulls,status}/route.js` (T6).
- `synthi/src/app/api/integrations/git/oauth/[provider]/{start,callback}/route.js` (T7).
- `synthi/src/app/api/integrations/git/oauth/[provider]/device/{start,poll}/route.js` (T8).
- `synthi/src/components/integrations/GitProvidersSection.jsx` + client methods in `integrationsClient.js` + wire into `ConnectedToolsPanel.jsx` (T9).
- `synthi/.env.example`-equivalent docs + `docs/superpowers/plans/2026-06-02-git-provider-abstraction-slice2-E2E.md` (T10).

---

## Task 1: `GitProvider` model + vault back-relations

**Files:** Modify `synthi/prisma/schema.prisma`.

- [ ] **Step 1: Add the back-relations to `EncryptedSecret`** — inside `model EncryptedSecret { … }`, after the existing `connection McpConnection?` line add:
```prisma
  gitProvider        GitProvider? @relation("GitProviderSecret")
  gitProviderRefresh GitProvider? @relation("GitProviderRefresh")
```

- [ ] **Step 2: Append the `GitProvider` model** at the end of the file:
```prisma
model GitProvider {
  id                   String    @id @default(cuid())
  name                 String
  providerType         String                       // 'github' | 'gitlab' | 'generic'
  baseUrl              String?
  scope                String                        // 'personal' | 'workspace'
  ownerUserId          String?
  workspaceSlug        String?
  authType             String    @default("pat")     // 'oauth' | 'pat'
  secretId             String?   @unique
  secret               EncryptedSecret? @relation("GitProviderSecret", fields: [secretId], references: [id], onDelete: SetNull)
  refreshSecretId      String?   @unique
  refreshSecret        EncryptedSecret? @relation("GitProviderRefresh", fields: [refreshSecretId], references: [id], onDelete: SetNull)
  accessTokenExpiresAt DateTime?
  oauthScopes          String[]  @default([])
  accountLogin         String?
  enabled              Boolean   @default(true)
  needsRelink          Boolean   @default(false)
  lastHealthState      String?
  lastHealthAt         DateTime?
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt

  @@index([ownerUserId])
  @@index([workspaceSlug])
}
```

- [ ] **Step 3: Regenerate the client** — from `synthi/`: `npx prisma generate`. Expected: success, `prisma.gitProvider` now exists. (Required — does not need a DB. `npx prisma db push` applies to a live DB; run it during E2E. If no DB is reachable, that is expected — note it, do not block.)

- [ ] **Step 4: Commit**
```bash
git add synthi/prisma/schema.prisma
git commit -m 'feat(slice2): GitProvider model + EncryptedSecret back-relations'
```

---

## Task 2: `git/store.js` — encrypted create/list/get/delete + scope

**Files:** Create `synthi/src/lib/git/store.js`, `synthi/src/lib/git/__tests__/store.test.js`.

- [ ] **Step 1: Write the failing test** — `synthi/src/lib/git/__tests__/store.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  prisma: { gitProvider: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
            encryptedSecret: { create: vi.fn() } },
  enc: vi.fn((t) => `cipher(${t})`),
}));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));
vi.mock('@/lib/tokenCrypto', () => ({ encryptToken: h.enc, decryptToken: (c) => c }));

import { createPatProvider, listProviders, scopeWhere } from '../store';

beforeEach(() => { vi.clearAllMocks(); h.prisma.encryptedSecret.create.mockResolvedValue({ id: 'sec1' }); });

describe('scopeWhere', () => {
  it('personal scopes to the owner; workspace scopes to the slug', () => {
    expect(scopeWhere({ userId: 'u1' }, null)).toEqual({ scope: 'personal', ownerUserId: 'u1' });
    expect(scopeWhere({ userId: 'u1' }, 'team')).toEqual({ scope: 'workspace', workspaceSlug: 'team' });
  });
});

describe('createPatProvider', () => {
  it('encrypts the token, stores last4, and persists authType=pat', async () => {
    h.prisma.gitProvider.create.mockResolvedValue({ id: 'g1', name: 'gl', providerType: 'gitlab', accountLogin: null });
    await createPatProvider({ userId: 'u1' }, { providerType: 'gitlab', name: 'gl', baseUrl: null, token: 'glpat-XYZ1234' });
    expect(h.enc).toHaveBeenCalledWith('glpat-XYZ1234');
    expect(h.prisma.encryptedSecret.create).toHaveBeenCalledWith({ data: { cipher: 'cipher(glpat-XYZ1234)', last4: '1234' } });
    const data = h.prisma.gitProvider.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ providerType: 'gitlab', authType: 'pat', scope: 'personal', ownerUserId: 'u1', secretId: 'sec1' });
    expect(data).not.toHaveProperty('token');
  });
});

describe('listProviders', () => {
  it('selects scoped rows WITHOUT secret material', async () => {
    h.prisma.gitProvider.findMany.mockResolvedValue([]);
    await listProviders({ userId: 'u1' }, null);
    const arg = h.prisma.gitProvider.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ scope: 'personal', ownerUserId: 'u1' });
    expect(arg.select.secretId).toBeFalsy();
    expect(arg.select.secret).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module '../store'`). `npx vitest run src/lib/git/__tests__/store.test.js`

- [ ] **Step 3: Implement** — `synthi/src/lib/git/store.js`:
```js
import prisma from '@/lib/prisma';
import { encryptToken } from '@/lib/tokenCrypto';

/** Build a Prisma where-clause scoped to the actor (personal) or workspace. */
export function scopeWhere(actor, workspaceSlug) {
  return workspaceSlug
    ? { scope: 'workspace', workspaceSlug }
    : { scope: 'personal', ownerUserId: actor.userId };
}

const LIST_SELECT = {
  id: true, name: true, providerType: true, baseUrl: true, scope: true, workspaceSlug: true,
  authType: true, accountLogin: true, enabled: true, needsRelink: true,
  lastHealthState: true, lastHealthAt: true, createdAt: true,
};

export async function listProviders(actor, workspaceSlug) {
  return prisma.gitProvider.findMany({
    where: scopeWhere(actor, workspaceSlug),
    select: LIST_SELECT,
    orderBy: { createdAt: 'desc' },
  });
}

export async function getProvider(id) {
  return prisma.gitProvider.findUnique({ where: { id } });
}

/** Create a PAT-authed provider: encrypt the token into EncryptedSecret, link it. */
export async function createPatProvider(actor, { providerType, name, baseUrl, token, workspaceSlug = null }) {
  const sec = await prisma.encryptedSecret.create({
    data: { cipher: encryptToken(token), last4: String(token).slice(-4) },
  });
  const row = await prisma.gitProvider.create({
    data: {
      name, providerType, baseUrl: baseUrl || null, authType: 'pat',
      scope: workspaceSlug ? 'workspace' : 'personal',
      ownerUserId: workspaceSlug ? null : actor.userId,
      workspaceSlug: workspaceSlug || null,
      secretId: sec.id,
    },
    select: LIST_SELECT,
  });
  return row;
}

export async function deleteProvider(id) {
  return prisma.gitProvider.delete({ where: { id } });
}
```

- [ ] **Step 4: Run it — expect PASS** (4 tests). `npx vitest run src/lib/git/__tests__/store.test.js`

- [ ] **Step 5: Commit**
```bash
git add synthi/src/lib/git/store.js synthi/src/lib/git/__tests__/store.test.js
git commit -m 'feat(slice2): git provider store (encrypted create + scoped list)'
```

---

## Task 3: provider config + SSRF-guarded fetch + token/refresh

**Files:** Create `synthi/src/lib/git/providerConfig.js`, `synthi/src/lib/git/safeFetch.js`, `synthi/src/lib/git/token.js`, and `synthi/src/lib/git/__tests__/token.test.js`.

- [ ] **Step 1: Write the failing test** — `synthi/src/lib/git/__tests__/token.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  prisma: { gitProvider: { update: vi.fn() }, encryptedSecret: { update: vi.fn(), create: vi.fn() } },
  assertSafe: vi.fn(async () => {}),
  fetchMock: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));
vi.mock('@/lib/tokenCrypto', () => ({ encryptToken: (t) => `c(${t})`, decryptToken: (c) => c.replace(/^c\(|\)$/g, '') }));
vi.mock('@synthi/mcp-hub', () => ({ assertSafeUrl: h.assertSafe }));

import { withFreshToken } from '../token';
import { gitFetch } from '../safeFetch';

beforeEach(() => { vi.clearAllMocks(); global.fetch = h.fetchMock; });

describe('gitFetch', () => {
  it('SSRF-guards the URL before fetching', async () => {
    h.fetchMock.mockResolvedValue({ ok: true });
    await gitFetch('https://gitlab.example/api', { method: 'GET' });
    expect(h.assertSafe).toHaveBeenCalledWith('https://gitlab.example/api');
    expect(h.fetchMock).toHaveBeenCalled();
  });
  it('does NOT fetch when the URL is unsafe', async () => {
    h.assertSafe.mockRejectedValueOnce(new Error('blocked_ip'));
    await expect(gitFetch('http://169.254.169.254/', {})).rejects.toThrow('blocked_ip');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe('withFreshToken', () => {
  it('returns the PAT directly (no refresh) for authType=pat', async () => {
    const conn = { id: 'g1', authType: 'pat', secret: { cipher: 'c(pat123)' } };
    expect(await withFreshToken(conn)).toBe('pat123');
    expect(h.prisma.gitProvider.update).not.toHaveBeenCalled();
  });
  it('refreshes an expired OAuth token and persists the new one', async () => {
    h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'NEW', refresh_token: 'R2', expires_in: 7200 }) });
    h.prisma.encryptedSecret.update.mockResolvedValue({});
    const conn = { id: 'g1', providerType: 'gitlab', authType: 'oauth', baseUrl: null,
      accessTokenExpiresAt: new Date(Date.now() - 1000), secretId: 's1', refreshSecretId: 'r1',
      secret: { id: 's1', cipher: 'c(OLD)' }, refreshSecret: { id: 'r1', cipher: 'c(R1)' } };
    expect(await withFreshToken(conn)).toBe('NEW');
    expect(h.prisma.encryptedSecret.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's1' } }));
    expect(h.prisma.gitProvider.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'g1' } }));
  });
  it('marks needsRelink and throws when refresh fails', async () => {
    h.fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_grant' });
    const conn = { id: 'g1', providerType: 'gitlab', authType: 'oauth',
      accessTokenExpiresAt: new Date(Date.now() - 1000), secretId: 's1', refreshSecretId: 'r1',
      secret: { id: 's1', cipher: 'c(OLD)' }, refreshSecret: { id: 'r1', cipher: 'c(R1)' } };
    await expect(withFreshToken(conn)).rejects.toMatchObject({ code: 'needs_relink' });
    expect(h.prisma.gitProvider.update).toHaveBeenCalledWith(expect.objectContaining({ data: { needsRelink: true } }));
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.** `npx vitest run src/lib/git/__tests__/token.test.js`

- [ ] **Step 3a: Implement `providerConfig.js`:**
```js
// Per-provider hosted defaults + OAuth endpoints. baseUrl overrides host for self-hosted.
const HOSTS = {
  github: { api: 'https://api.github.com', authorize: 'https://github.com/login/oauth/authorize',
            token: 'https://github.com/login/oauth/access_token', device: 'https://github.com/login/device/code' },
  gitlab: { api: 'https://gitlab.com/api/v4', authorize: 'https://gitlab.com/oauth/authorize',
            token: 'https://gitlab.com/oauth/token', device: 'https://gitlab.com/oauth/authorize_device' },
  generic: { api: null, authorize: null, token: null, device: null }, // requires baseUrl, PAT-only
};

/** Resolve the REST API base for a connection (baseUrl wins for self-hosted). */
export function resolveApiBase(conn) {
  if (conn.baseUrl) {
    const root = conn.baseUrl.replace(/\/+$/, '');
    // self-hosted GitLab exposes /api/v4; generic follows the GitLab-compatible shape
    return conn.providerType === 'github' ? root : `${root}/api/v4`;
  }
  const h = HOSTS[conn.providerType];
  if (!h?.api) throw Object.assign(new Error('baseUrl required'), { code: 'config_error' });
  return h.api;
}

export function oauthEndpoints(providerType, baseUrl) {
  if (baseUrl) {
    const root = baseUrl.replace(/\/+$/, '');
    return { authorize: `${root}/oauth/authorize`, token: `${root}/oauth/token`, device: `${root}/oauth/authorize_device` };
  }
  const h = HOSTS[providerType];
  return { authorize: h.authorize, token: h.token, device: h.device };
}
```

- [ ] **Step 3b: Implement `safeFetch.js`:**
```js
import { assertSafeUrl } from '@synthi/mcp-hub';

/** fetch() gated by the Slice-1 SSRF guard. Throws (does not fetch) on unsafe URLs. */
export async function gitFetch(url, init) {
  await assertSafeUrl(url);
  return fetch(url, init);
}
```

- [ ] **Step 3c: Implement `token.js`:**
```js
import prisma from '@/lib/prisma';
import { encryptToken, decryptToken } from '@/lib/tokenCrypto';
import { gitFetch } from './safeFetch.js';
import { oauthEndpoints } from './providerConfig.js';

const SKEW_MS = 60_000;

/** Return a usable access token for a connection, refreshing an expired OAuth token first. */
export async function withFreshToken(conn) {
  if (conn.authType === 'pat') return decryptToken(conn.secret.cipher);

  const expired = conn.accessTokenExpiresAt && new Date(conn.accessTokenExpiresAt).getTime() - SKEW_MS <= Date.now();
  if (!expired) return decryptToken(conn.secret.cipher);

  const { token: tokenUrl } = oauthEndpoints(conn.providerType, conn.baseUrl);
  const refreshToken = decryptToken(conn.refreshSecret.cipher);
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: refreshToken,
    client_id: process.env[`${conn.providerType.toUpperCase()}_CLIENT_ID`] || '',
    client_secret: process.env[`${conn.providerType.toUpperCase()}_CLIENT_SECRET`] || '',
  });
  const res = await gitFetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (!res.ok) {
    await prisma.gitProvider.update({ where: { id: conn.id }, data: { needsRelink: true } });
    throw Object.assign(new Error('token refresh failed'), { code: 'needs_relink' });
  }
  const j = await res.json();
  await prisma.encryptedSecret.update({ where: { id: conn.secretId }, data: { cipher: encryptToken(j.access_token), last4: String(j.access_token).slice(-4) } });
  if (j.refresh_token) await prisma.encryptedSecret.update({ where: { id: conn.refreshSecretId }, data: { cipher: encryptToken(j.refresh_token) } });
  await prisma.gitProvider.update({ where: { id: conn.id }, data: { accessTokenExpiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null, needsRelink: false } });
  return j.access_token;
}
```

- [ ] **Step 4: Run it — expect PASS** (5 tests). `npx vitest run src/lib/git/__tests__/token.test.js`

- [ ] **Step 5: Commit**
```bash
git add synthi/src/lib/git/providerConfig.js synthi/src/lib/git/safeFetch.js synthi/src/lib/git/token.js synthi/src/lib/git/__tests__/token.test.js
git commit -m 'feat(slice2): provider config + SSRF-guarded fetch + OAuth token refresh'
```

---

## Task 4: provider adapters (github + gitlab + generic) + registry

**Files:** Create `synthi/src/lib/git/adapters/{github,gitlab,generic,index}.js` and `synthi/src/lib/git/adapters/__tests__/adapters.test.js`.

Adapters share one shape: `{ testConnection(conn), listRepos(conn,opts), createPullRequest(conn,args), getStatus(conn,args) }`, each returning `{ ok:true, … }` or `{ ok:false, error:{code,message} }`. They call `withFreshToken(conn)` + `gitFetch(resolveApiBase(conn)+path, …)` and normalize responses. `generic` reuses the `gitlab` implementation (GitLab-compatible shape).

- [ ] **Step 1: Write the failing test** — `synthi/src/lib/git/adapters/__tests__/adapters.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({ token: vi.fn(async () => 'TKN'), fetchMock: vi.fn() }));
vi.mock('../../token.js', () => ({ withFreshToken: h.token }));
vi.mock('../../safeFetch.js', () => ({ gitFetch: (...a) => h.fetchMock(...a) }));

import { getAdapter } from '../index.js';

function okJson(data) { return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) }; }
beforeEach(() => { vi.clearAllMocks(); });

describe('github adapter', () => {
  it('createPullRequest posts to /repos/:repo/pulls and normalizes the PR', async () => {
    h.fetchMock.mockResolvedValue(okJson({ number: 7, html_url: 'https://gh/pr/7', state: 'open' }));
    const a = getAdapter('github');
    const r = await a.createPullRequest({ providerType: 'github', authType: 'pat', secret: {} }, { repo: 'o/r', sourceBranch: 'f', targetBranch: 'main', title: 't', body: 'b' });
    expect(r.ok).toBe(true);
    expect(r.pr).toMatchObject({ id: 7, url: 'https://gh/pr/7', state: 'open' });
    const [url, init] = h.fetchMock.mock.calls[0];
    expect(url).toContain('/repos/o/r/pulls');
    expect(init.headers.authorization).toBe('Bearer TKN');
  });
});

describe('gitlab adapter', () => {
  it('createPullRequest posts a merge_request and normalizes it to a PR shape', async () => {
    h.fetchMock.mockResolvedValue(okJson({ iid: 3, web_url: 'https://gl/mr/3', state: 'opened' }));
    const a = getAdapter('gitlab');
    const r = await a.createPullRequest({ providerType: 'gitlab', authType: 'pat', secret: {} }, { repo: 'group/proj', sourceBranch: 'f', targetBranch: 'main', title: 't', body: 'b' });
    expect(r.ok).toBe(true);
    expect(r.pr).toMatchObject({ id: 3, url: 'https://gl/mr/3', state: 'opened' });
    expect(h.fetchMock.mock.calls[0][0]).toContain('/projects/group%2Fproj/merge_requests');
  });
  it('maps a non-ok response to a typed error', async () => {
    h.fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' });
    const r = await getAdapter('gitlab').listRepos({ providerType: 'gitlab', authType: 'pat', secret: {} }, {});
    expect(r).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

it('generic reuses the gitlab adapter', () => {
  expect(getAdapter('generic').listRepos).toBe(getAdapter('gitlab').listRepos);
});
```

- [ ] **Step 2: Run it — expect FAIL.** `npx vitest run src/lib/git/adapters`

- [ ] **Step 3a: `adapters/github.js`:**
```js
import { withFreshToken } from '../token.js';
import { gitFetch } from '../safeFetch.js';
import { resolveApiBase } from '../providerConfig.js';

function mapError(status) {
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'provider_error';
}
async function call(conn, path, init = {}) {
  const token = await withFreshToken(conn);
  const res = await gitFetch(`${resolveApiBase(conn)}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) return { ok: false, error: { code: mapError(res.status), message: `github ${res.status}` } };
  return { ok: true, data: await res.json() };
}

export const github = {
  async testConnection(conn) { const r = await call(conn, '/user'); return r.ok ? { ok: true, accountLogin: r.data.login } : r; },
  async listRepos(conn, { perPage = 30, page = 1 } = {}) {
    const r = await call(conn, `/user/repos?per_page=${perPage}&page=${page}&sort=updated`);
    return r.ok ? { ok: true, repos: r.data.map((x) => ({ id: x.id, fullName: x.full_name, url: x.html_url, private: x.private })) } : r;
  },
  async createPullRequest(conn, { repo, sourceBranch, targetBranch, title, body }) {
    const r = await call(conn, `/repos/${repo}/pulls`, { method: 'POST', body: JSON.stringify({ head: sourceBranch, base: targetBranch, title, body }) });
    return r.ok ? { ok: true, pr: { id: r.data.number, url: r.data.html_url, state: r.data.state } } : r;
  },
  async getStatus(conn, { repo, ref }) {
    const r = await call(conn, `/repos/${repo}/commits/${encodeURIComponent(ref)}/status`);
    return r.ok ? { ok: true, checks: { state: r.data.state, total: r.data.total_count } } : r;
  },
};
```

- [ ] **Step 3b: `adapters/gitlab.js`:**
```js
import { withFreshToken } from '../token.js';
import { gitFetch } from '../safeFetch.js';
import { resolveApiBase } from '../providerConfig.js';

function mapError(status) {
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'provider_error';
}
async function call(conn, path, init = {}) {
  const token = await withFreshToken(conn);
  const res = await gitFetch(`${resolveApiBase(conn)}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) return { ok: false, error: { code: mapError(res.status), message: `gitlab ${res.status}` } };
  return { ok: true, data: await res.json() };
}
const enc = (repo) => encodeURIComponent(repo);

export const gitlab = {
  async testConnection(conn) { const r = await call(conn, '/user'); return r.ok ? { ok: true, accountLogin: r.data.username } : r; },
  async listRepos(conn, { perPage = 30, page = 1 } = {}) {
    const r = await call(conn, `/projects?membership=true&per_page=${perPage}&page=${page}&order_by=last_activity_at`);
    return r.ok ? { ok: true, repos: r.data.map((x) => ({ id: x.id, fullName: x.path_with_namespace, url: x.web_url, private: x.visibility !== 'public' })) } : r;
  },
  async createPullRequest(conn, { repo, sourceBranch, targetBranch, title, body }) {
    const r = await call(conn, `/projects/${enc(repo)}/merge_requests`, { method: 'POST', body: JSON.stringify({ source_branch: sourceBranch, target_branch: targetBranch, title, description: body }) });
    return r.ok ? { ok: true, pr: { id: r.data.iid, url: r.data.web_url, state: r.data.state } } : r;
  },
  async getStatus(conn, { repo, ref }) {
    const r = await call(conn, `/projects/${enc(repo)}/repository/commits/${encodeURIComponent(ref)}/statuses`);
    return r.ok ? { ok: true, checks: { state: Array.isArray(r.data) && r.data.every((s) => s.status === 'success') ? 'success' : 'pending', total: Array.isArray(r.data) ? r.data.length : 0 } } : r;
  },
};
```

- [ ] **Step 3c: `adapters/generic.js`** + `adapters/index.js`:
```js
// generic.js — self-hosted GitLab-compatible; reuse the gitlab adapter unchanged.
export { gitlab as generic } from './gitlab.js';
```
```js
// index.js
import { github } from './github.js';
import { gitlab } from './gitlab.js';
import { generic } from './generic.js';

const REGISTRY = { github, gitlab, generic };
export function getAdapter(providerType) {
  const a = REGISTRY[providerType];
  if (!a) throw Object.assign(new Error(`unknown provider ${providerType}`), { code: 'config_error' });
  return a;
}
```

- [ ] **Step 4: Run it — expect PASS** (4 tests). `npx vitest run src/lib/git/adapters`

- [ ] **Step 5: Commit**
```bash
git add synthi/src/lib/git/adapters
git commit -m 'feat(slice2): github/gitlab/generic adapters + registry (PR<->MR normalized)'
```

---

## Task 5: provider CRUD routes (list / add-PAT / delete / test)

**Files:** Create `synthi/src/app/api/integrations/git/providers/route.js`, `…/[id]/route.js`, `…/[id]/test/route.js`, and `…/providers/__tests__/providerRoutes.test.js`. **First** add a `git` rate-limit group: in `synthi/src/lib/integrations/rateLimit.js`, inside `RATE_LIMITS`, add `git: { limit: Number(process.env.SYNTHI_RL_GIT) || 60, windowMs: 60_000 },`.

- [ ] **Step 1: Write the failing test** — `providerRoutes.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({
  actor: vi.fn(), canRead: vi.fn(),
  store: { listProviders: vi.fn(), createPatProvider: vi.fn(), getProvider: vi.fn(), deleteProvider: vi.fn() },
  assertSafe: vi.fn(async () => {}),
}));
vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.canRead }));
vi.mock('@/lib/git/store', () => h.store);
vi.mock('@synthi/mcp-hub', () => ({ assertSafeUrl: h.assertSafe }));

import { GET, POST } from '../route';
import { DELETE } from '../[id]/route';
import { __resetRateLimits } from '@/lib/integrations/rateLimit';

const req = (body) => new Request('http://x/api/integrations/git/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
beforeEach(() => { __resetRateLimits(); vi.clearAllMocks(); h.actor.mockResolvedValue({ userId: 'u1' }); });

it('GET 401 when unauthenticated', async () => { h.actor.mockResolvedValue(null); expect((await GET(new Request('http://x/api/integrations/git/providers'))).status).toBe(401); });

it('POST creates a PAT provider after SSRF-checking baseUrl', async () => {
  h.store.createPatProvider.mockResolvedValue({ id: 'g1', name: 'gl' });
  const res = await POST(req({ providerType: 'gitlab', name: 'gl', baseUrl: 'https://gl.example', token: 'glpat-1234' }));
  expect(res.status).toBe(201);
  expect(h.assertSafe).toHaveBeenCalledWith('https://gl.example');
  expect(h.store.createPatProvider).toHaveBeenCalled();
});

it('POST 400 on missing token/providerType', async () => { expect((await POST(req({ name: 'x' }))).status).toBe(400); });

it('DELETE 403 when the row belongs to someone else', async () => {
  h.store.getProvider.mockResolvedValue({ id: 'g1', scope: 'personal', ownerUserId: 'other' });
  const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'g1' }) });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run it — expect FAIL.** `npx vitest run src/app/api/integrations/git/providers`

- [ ] **Step 3a: `providers/route.js`:**
```js
import { NextResponse } from 'next/server';
import { assertSafeUrl } from '@synthi/mcp-hub';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { listProviders, createPatProvider } from '@/lib/git/store';

export const runtime = 'nodejs';
const limited = (actor) => checkLimit(`git:${actor.userId}:crud`, RATE_LIMITS.git);

export async function GET(req) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const rl = limited(actor); if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });
  const slug = new URL(req.url).searchParams.get('workspaceSlug') || null;
  let workspaceSlug = null;
  if (slug && (await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: slug }))) workspaceSlug = slug;
  return NextResponse.json({ providers: await listProviders(actor, workspaceSlug) });
}

export async function POST(req) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const rl = limited(actor); if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });
  const b = await req.json().catch(() => ({}));
  const providerType = ['github', 'gitlab', 'generic'].includes(b.providerType) ? b.providerType : null;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const token = typeof b.token === 'string' ? b.token.trim() : '';
  if (!providerType || !name || !token) return NextResponse.json({ error: 'providerType, name, token required' }, { status: 400 });
  let baseUrl = typeof b.baseUrl === 'string' && b.baseUrl.trim() ? b.baseUrl.trim() : null;
  if (providerType === 'generic' && !baseUrl) return NextResponse.json({ error: 'baseUrl required for generic' }, { status: 400 });
  if (baseUrl) { try { await assertSafeUrl(baseUrl); } catch { return NextResponse.json({ error: 'unsafe_base_url' }, { status: 400 }); } }
  let workspaceSlug = null;
  if (b.workspaceSlug && (await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: b.workspaceSlug }))) workspaceSlug = b.workspaceSlug;
  const row = await createPatProvider(actor, { providerType, name, baseUrl, token, workspaceSlug });
  return NextResponse.json(row, { status: 201 });
}
```

- [ ] **Step 3b: `providers/[id]/route.js`** (ownership-checked DELETE):
```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { getProvider, deleteProvider } from '@/lib/git/store';

export const runtime = 'nodejs';

export async function DELETE(_req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const rl = checkLimit(`git:${actor.userId}:crud`, RATE_LIMITS.git);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });
  const { id } = await params;
  const row = await getProvider(id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const owns = row.scope === 'workspace'
    ? await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: row.workspaceSlug })
    : row.ownerUserId === actor.userId;
  if (!owns) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  await deleteProvider(id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3c: `providers/[id]/test/route.js`** (health via the adapter):
```js
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { getAdapter } from '@/lib/git/adapters/index.js';

export const runtime = 'nodejs';

export async function POST(_req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const rl = checkLimit(`git:${actor.userId}:test`, RATE_LIMITS.git);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });
  const { id } = await params;
  const conn = await prisma.gitProvider.findUnique({ where: { id }, include: { secret: true, refreshSecret: true } });
  if (!conn) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const owns = conn.scope === 'workspace'
    ? await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: conn.workspaceSlug })
    : conn.ownerUserId === actor.userId;
  if (!owns) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const r = await getAdapter(conn.providerType).testConnection(conn);
  await prisma.gitProvider.update({ where: { id }, data: { lastHealthState: r.ok ? 'ok' : 'error', lastHealthAt: new Date(), ...(r.ok ? { accountLogin: r.accountLogin } : {}) } });
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
```

- [ ] **Step 4: Run it — expect PASS** (4 tests). `npx vitest run src/app/api/integrations/git/providers`

- [ ] **Step 5: Commit**
```bash
git add synthi/src/lib/integrations/rateLimit.js synthi/src/app/api/integrations/git/providers
git commit -m 'feat(slice2): git provider CRUD routes (list/add-PAT/delete/test) + git rate-limit group'
```

---

## Task 6: action routes (repos / pulls / status)

**Files:** Create `…/git/providers/[id]/repos/route.js`, `…/[id]/pulls/route.js`, `…/[id]/status/route.js`, and `…/[id]/__tests__/actionRoutes.test.js`.

All three share a helper that auth-gates, loads the connection (with secrets), scope-checks, and dispatches to the adapter. Put it in `synthi/src/lib/git/routeHelpers.js`.

- [ ] **Step 1: Write the failing test** — `actionRoutes.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({
  actor: vi.fn(), canRead: vi.fn(),
  prisma: { gitProvider: { findUnique: vi.fn() } },
  adapter: { listRepos: vi.fn(), createPullRequest: vi.fn(), getStatus: vi.fn() },
}));
vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.canRead }));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));
vi.mock('@/lib/git/adapters/index.js', () => ({ getAdapter: () => h.adapter }));

import { GET as REPOS } from '../repos/route';
import { POST as PULLS } from '../pulls/route';
import { __resetRateLimits } from '@/lib/integrations/rateLimit';

beforeEach(() => { __resetRateLimits(); vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'u1' });
  h.prisma.gitProvider.findUnique.mockResolvedValue({ id: 'g1', providerType: 'gitlab', scope: 'personal', ownerUserId: 'u1', secret: {} });
});

it('repos: dispatches to the adapter for an owned provider', async () => {
  h.adapter.listRepos.mockResolvedValue({ ok: true, repos: [{ id: 1 }] });
  const res = await REPOS(new Request('http://x/api/integrations/git/providers/g1/repos'), { params: Promise.resolve({ id: 'g1' }) });
  expect(res.status).toBe(200);
  expect((await res.json()).repos).toHaveLength(1);
});

it('repos: 403 for a provider owned by another user', async () => {
  h.prisma.gitProvider.findUnique.mockResolvedValue({ id: 'g1', scope: 'personal', ownerUserId: 'other', secret: {} });
  const res = await REPOS(new Request('http://x/api/integrations/git/providers/g1/repos'), { params: Promise.resolve({ id: 'g1' }) });
  expect(res.status).toBe(403);
});

it('pulls: 502 + typed error when the adapter fails', async () => {
  h.adapter.createPullRequest.mockResolvedValue({ ok: false, error: { code: 'forbidden', message: 'gitlab 403' } });
  const res = await PULLS(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'g/p', sourceBranch: 'f', targetBranch: 'main', title: 't' }) }), { params: Promise.resolve({ id: 'g1' }) });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe('forbidden');
});
```

- [ ] **Step 2: Run it — expect FAIL.** `npx vitest run src/app/api/integrations/git/providers/[id]`

- [ ] **Step 3a: `routeHelpers.js`:**
```js
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { getAdapter } from './adapters/index.js';

/** Auth + load (with secrets) + scope-check a git provider; returns {error?:Response, conn?, adapter?, actor?}. */
export async function loadOwnedProvider(id) {
  const actor = await resolveActor();
  if (!actor) return { error: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) };
  const rl = checkLimit(`git:${actor.userId}:action`, RATE_LIMITS.git);
  if (!rl.ok) return { error: NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 }) };
  const conn = await prisma.gitProvider.findUnique({ where: { id }, include: { secret: true, refreshSecret: true } });
  if (!conn) return { error: NextResponse.json({ error: 'not_found' }, { status: 404 }) };
  const owns = conn.scope === 'workspace'
    ? await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: conn.workspaceSlug })
    : conn.ownerUserId === actor.userId;
  if (!owns) return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  return { actor, conn, adapter: getAdapter(conn.providerType) };
}

/** Map an adapter result to an HTTP response. */
export function respond(r, okStatus = 200) {
  if (r.ok) return NextResponse.json(r, { status: okStatus });
  return NextResponse.json({ error: r.error?.code || 'provider_error', message: r.error?.message }, { status: 502 });
}
```

- [ ] **Step 3b: `repos/route.js`, `status/route.js`, `pulls/route.js`:**
```js
// repos/route.js
import { loadOwnedProvider, respond } from '@/lib/git/routeHelpers.js';
export const runtime = 'nodejs';
export async function GET(req, { params }) {
  const { id } = await params; const g = await loadOwnedProvider(id); if (g.error) return g.error;
  const u = new URL(req.url);
  return respond(await g.adapter.listRepos(g.conn, { page: Number(u.searchParams.get('page')) || 1, perPage: Number(u.searchParams.get('perPage')) || 30 }));
}
```
```js
// status/route.js
import { loadOwnedProvider, respond } from '@/lib/git/routeHelpers.js';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
export async function GET(req, { params }) {
  const { id } = await params; const g = await loadOwnedProvider(id); if (g.error) return g.error;
  const u = new URL(req.url); const repo = u.searchParams.get('repo'); const ref = u.searchParams.get('ref');
  if (!repo || !ref) return NextResponse.json({ error: 'repo and ref required' }, { status: 400 });
  return respond(await g.adapter.getStatus(g.conn, { repo, ref }));
}
```
```js
// pulls/route.js
import { loadOwnedProvider, respond } from '@/lib/git/routeHelpers.js';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
export async function POST(req, { params }) {
  const { id } = await params; const g = await loadOwnedProvider(id); if (g.error) return g.error;
  const b = await req.json().catch(() => ({}));
  if (!b.repo || !b.sourceBranch || !b.targetBranch || !b.title) return NextResponse.json({ error: 'repo, sourceBranch, targetBranch, title required' }, { status: 400 });
  return respond(await g.adapter.createPullRequest(g.conn, { repo: b.repo, sourceBranch: b.sourceBranch, targetBranch: b.targetBranch, title: b.title, body: b.body || '' }), 201);
}
```

- [ ] **Step 4: Run it — expect PASS** (3 tests). `npx vitest run src/app/api/integrations/git/providers/[id]`

- [ ] **Step 5: Commit**
```bash
git add synthi/src/lib/git/routeHelpers.js synthi/src/app/api/integrations/git/providers/[id]
git commit -m 'feat(slice2): git provider action routes (repos/pulls/status)'
```

---

## Task 7: OAuth web flow (start + callback)

**Files:** Create `…/git/oauth/[provider]/start/route.js`, `…/oauth/[provider]/callback/route.js`, `…/oauth/[provider]/__tests__/oauthWeb.test.js`. Store state in a short-lived signed cookie. Reads env `GITHUB_*`/`GITLAB_*` client creds.

- [ ] **Step 1: Write the failing test** — `oauthWeb.test.js` (callback exchanges the code and persists tokens):
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({
  actor: vi.fn(),
  prisma: { encryptedSecret: { create: vi.fn() }, gitProvider: { create: vi.fn() } },
  fetchMock: vi.fn(), assertSafe: vi.fn(async () => {}),
}));
vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));
vi.mock('@/lib/tokenCrypto', () => ({ encryptToken: (t) => `c(${t})` }));
vi.mock('@synthi/mcp-hub', () => ({ assertSafeUrl: h.assertSafe }));

import { GET as CALLBACK } from '../callback/route';
beforeEach(() => { vi.clearAllMocks(); global.fetch = h.fetchMock; h.actor.mockResolvedValue({ userId: 'u1' });
  h.prisma.encryptedSecret.create.mockResolvedValue({ id: 'sec' }); h.prisma.gitProvider.create.mockResolvedValue({ id: 'g1' });
  process.env.GITLAB_CLIENT_ID = 'cid'; process.env.GITLAB_CLIENT_SECRET = 'csec'; process.env.NEXTAUTH_URL = 'https://app.example';
});

it('exchanges the code, stores encrypted tokens, creates an oauth provider', async () => {
  h.fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 7200 }) });
  const req = new Request('https://app.example/api/integrations/git/oauth/gitlab/callback?code=abc&state=st', { headers: { cookie: 'git_oauth_state=st' } });
  const res = await CALLBACK(req, { params: Promise.resolve({ provider: 'gitlab' }) });
  expect([302, 303]).toContain(res.status); // redirects back to the app
  expect(h.prisma.encryptedSecret.create).toHaveBeenCalledWith({ data: { cipher: 'c(AT)', last4: 'AT'.slice(-4) } });
  const data = h.prisma.gitProvider.create.mock.calls[0][0].data;
  expect(data).toMatchObject({ providerType: 'gitlab', authType: 'oauth', ownerUserId: 'u1' });
});

it('rejects a state mismatch (CSRF) without exchanging', async () => {
  const req = new Request('https://app.example/api/integrations/git/oauth/gitlab/callback?code=abc&state=BAD', { headers: { cookie: 'git_oauth_state=st' } });
  const res = await CALLBACK(req, { params: Promise.resolve({ provider: 'gitlab' }) });
  expect(res.status).toBe(400);
  expect(h.fetchMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it — expect FAIL.** `npx vitest run src/app/api/integrations/git/oauth/[provider]`

- [ ] **Step 3a: `start/route.js`** (redirect to provider authorize + set state cookie):
```js
import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { resolveActor } from '@/lib/integrations/session';
import { oauthEndpoints } from '@/lib/git/providerConfig.js';

export const runtime = 'nodejs';
const SCOPES = { github: 'repo read:user', gitlab: 'api read_user' };

export async function GET(req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { provider } = await params;
  if (!['github', 'gitlab'].includes(provider)) return NextResponse.json({ error: 'unsupported_provider' }, { status: 400 });
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${process.env.NEXTAUTH_URL}/api/integrations/git/oauth/${provider}/callback`;
  const { authorize } = oauthEndpoints(provider, null);
  const url = new URL(authorize);
  url.searchParams.set('client_id', process.env[`${provider.toUpperCase()}_CLIENT_ID`] || '');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES[provider]);
  url.searchParams.set('state', state);
  const res = NextResponse.redirect(url.toString());
  res.cookies.set('git_oauth_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/' });
  return res;
}
```

- [ ] **Step 3b: `callback/route.js`** (verify state, exchange code, persist):
```js
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { encryptToken } from '@/lib/tokenCrypto';
import { resolveActor } from '@/lib/integrations/session';
import { oauthEndpoints } from '@/lib/git/providerConfig.js';

export const runtime = 'nodejs';

export async function GET(req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { provider } = await params;
  const u = new URL(req.url);
  const code = u.searchParams.get('code'); const state = u.searchParams.get('state');
  const cookieState = req.headers.get('cookie')?.match(/git_oauth_state=([^;]+)/)?.[1];
  if (!code || !state || state !== cookieState) return NextResponse.json({ error: 'invalid_state' }, { status: 400 });

  const { token: tokenUrl } = oauthEndpoints(provider, null);
  const redirectUri = `${process.env.NEXTAUTH_URL}/api/integrations/git/oauth/${provider}/callback`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: process.env[`${provider.toUpperCase()}_CLIENT_ID`] || '',
    client_secret: process.env[`${provider.toUpperCase()}_CLIENT_SECRET`] || '',
  });
  const tokenRes = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (!tokenRes.ok) return NextResponse.json({ error: 'token_exchange_failed' }, { status: 502 });
  const j = await tokenRes.json();

  const sec = await prisma.encryptedSecret.create({ data: { cipher: encryptToken(j.access_token), last4: String(j.access_token).slice(-4) } });
  let refreshSecretId = null;
  if (j.refresh_token) { const r = await prisma.encryptedSecret.create({ data: { cipher: encryptToken(j.refresh_token), last4: String(j.refresh_token).slice(-4) } }); refreshSecretId = r.id; }
  await prisma.gitProvider.create({ data: {
    name: provider === 'gitlab' ? 'GitLab' : 'GitHub', providerType: provider, authType: 'oauth',
    scope: 'personal', ownerUserId: actor.userId, secretId: sec.id, refreshSecretId,
    accessTokenExpiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null,
    oauthScopes: (j.scope || '').split(/[ ,]/).filter(Boolean),
  } });
  const res = NextResponse.redirect(`${process.env.NEXTAUTH_URL}/workspace?git_connected=${provider}`);
  res.cookies.set('git_oauth_state', '', { maxAge: 0, path: '/' });
  return res;
}
```

- [ ] **Step 4: Run it — expect PASS** (2 tests). `npx vitest run src/app/api/integrations/git/oauth/[provider]`

- [ ] **Step 5: Commit**
```bash
git add synthi/src/app/api/integrations/git/oauth/[provider]/start synthi/src/app/api/integrations/git/oauth/[provider]/callback synthi/src/app/api/integrations/git/oauth/[provider]/__tests__
git commit -m 'feat(slice2): git OAuth web flow (authorize + callback, state-checked)'
```

---

## Task 8: OAuth device flow (start + poll)

**Files:** Create `…/oauth/[provider]/device/start/route.js`, `…/device/poll/route.js`, `…/device/__tests__/oauthDevice.test.js`.

- [ ] **Step 1: Write the failing test** — `oauthDevice.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({
  actor: vi.fn(), fetchMock: vi.fn(),
  prisma: { encryptedSecret: { create: vi.fn() }, gitProvider: { create: vi.fn() } },
}));
vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));
vi.mock('@/lib/tokenCrypto', () => ({ encryptToken: (t) => `c(${t})` }));

import { POST as START } from '../start/route';
import { POST as POLL } from '../poll/route';
beforeEach(() => { vi.clearAllMocks(); global.fetch = h.fetchMock; h.actor.mockResolvedValue({ userId: 'u1' });
  process.env.GITHUB_CLIENT_ID = 'cid'; });

it('start returns the device + user code', async () => {
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ device_code: 'dc', user_code: 'WX-YZ', verification_uri: 'https://gh/device', interval: 5 }) });
  const res = await START(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ provider: 'github' }) });
  expect(res.status).toBe(200);
  expect((await res.json())).toMatchObject({ user_code: 'WX-YZ', verification_uri: 'https://gh/device' });
});

it('poll stores tokens + creates the provider on success', async () => {
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 7200 }) });
  h.prisma.encryptedSecret.create.mockResolvedValue({ id: 'sec' }); h.prisma.gitProvider.create.mockResolvedValue({ id: 'g1' });
  const res = await POLL(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: 'dc' }) }), { params: Promise.resolve({ provider: 'github' }) });
  expect(res.status).toBe(201);
  expect(h.prisma.gitProvider.create).toHaveBeenCalled();
});

it('poll relays authorization_pending without creating a provider', async () => {
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ error: 'authorization_pending' }) });
  const res = await POLL(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: 'dc' }) }), { params: Promise.resolve({ provider: 'github' }) });
  expect(res.status).toBe(202);
  expect(h.prisma.gitProvider.create).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it — expect FAIL.** `npx vitest run src/app/api/integrations/git/oauth/[provider]/device`

- [ ] **Step 3a: `device/start/route.js`:**
```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { oauthEndpoints } from '@/lib/git/providerConfig.js';

export const runtime = 'nodejs';
const SCOPES = { github: 'repo read:user', gitlab: 'api read_user' };

export async function POST(_req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { provider } = await params;
  if (!['github', 'gitlab'].includes(provider)) return NextResponse.json({ error: 'unsupported_provider' }, { status: 400 });
  const { device } = oauthEndpoints(provider, null);
  const body = new URLSearchParams({ client_id: process.env[`${provider.toUpperCase()}_CLIENT_ID`] || '', scope: SCOPES[provider] });
  const res = await fetch(device, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (!res.ok) return NextResponse.json({ error: 'device_start_failed' }, { status: 502 });
  const j = await res.json();
  return NextResponse.json({ device_code: j.device_code, user_code: j.user_code, verification_uri: j.verification_uri || j.verification_uri_complete, interval: j.interval || 5 });
}
```

- [ ] **Step 3b: `device/poll/route.js`:**
```js
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { encryptToken } from '@/lib/tokenCrypto';
import { resolveActor } from '@/lib/integrations/session';
import { oauthEndpoints } from '@/lib/git/providerConfig.js';

export const runtime = 'nodejs';
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export async function POST(req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { provider } = await params;
  const b = await req.json().catch(() => ({}));
  if (!b.device_code) return NextResponse.json({ error: 'device_code required' }, { status: 400 });
  const { token } = oauthEndpoints(provider, null);
  const body = new URLSearchParams({ client_id: process.env[`${provider.toUpperCase()}_CLIENT_ID`] || '', device_code: b.device_code, grant_type: GRANT });
  const res = await fetch(token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  const j = await res.json().catch(() => ({}));
  if (j.error === 'authorization_pending' || j.error === 'slow_down') return NextResponse.json({ status: j.error }, { status: 202 });
  if (!res.ok || !j.access_token) return NextResponse.json({ error: j.error || 'device_poll_failed' }, { status: 400 });

  const sec = await prisma.encryptedSecret.create({ data: { cipher: encryptToken(j.access_token), last4: String(j.access_token).slice(-4) } });
  let refreshSecretId = null;
  if (j.refresh_token) { const r = await prisma.encryptedSecret.create({ data: { cipher: encryptToken(j.refresh_token), last4: String(j.refresh_token).slice(-4) } }); refreshSecretId = r.id; }
  const row = await prisma.gitProvider.create({ data: {
    name: provider === 'gitlab' ? 'GitLab' : 'GitHub', providerType: provider, authType: 'oauth',
    scope: 'personal', ownerUserId: actor.userId, secretId: sec.id, refreshSecretId,
    accessTokenExpiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null,
  }, select: { id: true, name: true, providerType: true } });
  return NextResponse.json(row, { status: 201 });
}
```

- [ ] **Step 4: Run it — expect PASS** (3 tests). `npx vitest run src/app/api/integrations/git/oauth/[provider]/device`

- [ ] **Step 5: Commit**
```bash
git add synthi/src/app/api/integrations/git/oauth/[provider]/device
git commit -m 'feat(slice2): git OAuth device flow (start + poll)'
```

---

## Task 9: Connect UI — Git Providers section

**Files:** Create `synthi/src/components/integrations/GitProvidersSection.jsx`; append client methods to `synthi/src/components/integrations/integrationsClient.js`; render the section in `synthi/src/components/integrations/ConnectedToolsPanel.jsx`. **No React testing-library in this repo** → verify by esbuild parse (disk-light); the full `next build` runs in Task 10.

- [ ] **Step 1: Append client methods** to `integrationsClient.js`:
```js
const GIT = '/api/integrations/git/providers';
export async function fetchGitProviders() {
  const res = await fetch(GIT);
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to load providers');
  return (await res.json()).providers || [];
}
export async function addGitProviderPat({ providerType, name, baseUrl, token }) {
  const res = await fetch(GIT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerType, name, baseUrl, token }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Failed to add provider');
  return data;
}
export async function deleteGitProvider(id) {
  const res = await fetch(`${GIT}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to disconnect');
  return true;
}
export function startGitOAuth(provider) { window.location.href = `/api/integrations/git/oauth/${provider}/start`; }
```

- [ ] **Step 2: Create `GitProvidersSection.jsx`** (mirrors `CliAccessSection.jsx` conventions — theme vars, `ui/button`, lucide, sonner):
```jsx
'use client';
import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { fetchGitProviders, addGitProviderPat, deleteGitProvider, startGitOAuth } from './integrationsClient';

export default function GitProvidersSection() {
  const [providers, setProviders] = useState([]);
  const [form, setForm] = useState({ providerType: 'gitlab', name: '', baseUrl: '', token: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { try { setProviders(await fetchGitProviders()); } catch (e) { toast.error(e.message); } }, []);
  useEffect(() => { load(); }, [load]);

  const addPat = async () => {
    if (!form.name.trim() || !form.token.trim()) { toast.error('Name + token required'); return; }
    setBusy(true);
    try { await addGitProviderPat(form); setForm({ ...form, name: '', token: '', baseUrl: '' }); load(); toast.success('Provider connected'); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const remove = async (id) => { try { await deleteGitProvider(id); setProviders((p) => p.filter((x) => x.id !== id)); toast.success('Disconnected'); } catch (e) { toast.error(e.message); } };

  return (
    <div className="rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
      <div className="flex items-center gap-2 px-2.5 py-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        <GitBranch className="w-3.5 h-3.5" /> Git Providers
      </div>
      <div className="px-2.5 pb-2 flex flex-wrap items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={() => startGitOAuth('gitlab')}>Connect GitLab (OAuth)</Button>
        <Button variant="ghost" size="sm" onClick={() => startGitOAuth('github')}>Connect GitHub (OAuth)</Button>
      </div>
      <div className="px-2.5 pb-2 flex flex-wrap items-center gap-1.5">
        <select value={form.providerType} onChange={(e) => setForm({ ...form, providerType: e.target.value })}
          className="text-xs rounded px-1.5 py-1" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
          <option value="gitlab">GitLab</option><option value="github">GitHub</option><option value="generic">Generic</option>
        </select>
        <input placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="text-xs rounded px-2 py-1 w-24" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} />
        <input placeholder="base URL (self-hosted)" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          className="text-xs rounded px-2 py-1 flex-1" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} />
        <input placeholder="token (PAT)" type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })}
          className="text-xs rounded px-2 py-1 w-28" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} />
        <Button variant="ghost" size="icon" onClick={addPat} disabled={busy} title="Add PAT provider"><Plus className="w-3.5 h-3.5" /></Button>
      </div>
      <div className="px-2.5 pb-2 flex flex-col gap-1">
        {providers.length === 0 && <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>No git providers yet.</div>}
        {providers.map((p) => (
          <div key={p.id} className="flex items-center justify-between text-xs">
            <span className="truncate">{p.name} <span style={{ color: 'var(--text-dim)' }}>({p.providerType}{p.accountLogin ? ` · ${p.accountLogin}` : ''})</span>
              {p.needsRelink && <span style={{ color: 'var(--accent-danger, #ff5757)' }}> · needs relink</span>}</span>
            <Button variant="ghost" size="icon" onClick={() => remove(p.id)} title="Disconnect"><Trash2 className="w-3.5 h-3.5" /></Button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Render it** in `ConnectedToolsPanel.jsx` — add `import GitProvidersSection from './GitProvidersSection';` after the `CliAccessSection` import, and render `<GitProvidersSection />` immediately after `<CliAccessSection />` inside the scroll container.

- [ ] **Step 4: Verify the JSX parses** (do NOT run `npm run build` — disk). From `synthi/`:
```bash
node -e "const fs=require('fs');const esbuild=require('esbuild');(async()=>{for(const f of ['src/components/integrations/GitProvidersSection.jsx','src/components/integrations/ConnectedToolsPanel.jsx']){await esbuild.transform(fs.readFileSync(f,'utf8'),{loader:'jsx'});console.log('PARSE_OK',f)}})();"
```
Expected: `PARSE_OK` for both.

- [ ] **Step 5: Commit**
```bash
git add synthi/src/components/integrations/GitProvidersSection.jsx synthi/src/components/integrations/integrationsClient.js synthi/src/components/integrations/ConnectedToolsPanel.jsx
git commit -m 'feat(slice2): Git Providers connect UI (OAuth + PAT, list/disconnect)'
```

---

## Task 10: env docs, E2E checklist, whole-plan verification

**Files:** Modify `synthi/.env.example` (or create a docs note if absent); create `docs/superpowers/plans/2026-06-02-git-provider-abstraction-slice2-E2E.md`.

- [ ] **Step 1: Document env vars** — add to `synthi/.env.example` (create the section if the file exists; otherwise add the block to the existing env docs):
```bash
# ── Git providers (Slice 2) ──────────────────────────────────────────
# OAuth apps for hosted providers (web + device flow). Self-hosted/generic use PATs.
# GITLAB_CLIENT_ID=
# GITLAB_CLIENT_SECRET=
# GitHub reuses the existing GITHUB_ID / GITHUB_SECRET OAuth app.
# Optional rate-limit override (requests/min per user): SYNTHI_RL_GIT=60
```

- [ ] **Step 2: Write the E2E checklist** — `docs/superpowers/plans/2026-06-02-git-provider-abstraction-slice2-E2E.md`:
```markdown
# Slice 2 — Manual E2E (Git providers)

Prereqs: running Postgres + Synthi (`npx prisma db push` applied); a GitLab account; a self-hosted
GitLab or any GitLab-compatible host for the generic path; GitHub already connected via login.

1. **OAuth (GitLab):** Integrations → Git Providers → "Connect GitLab (OAuth)" → authorize → returns to
   the app. ✅ Provider appears with your `accountLogin`.
2. **PAT (self-hosted/generic):** add a provider with type `generic`, a base URL, and a PAT. ✅ Appears in
   the list; `POST …/test` reports healthy.
3. **List repos:** `GET /api/integrations/git/providers/:id/repos`. ✅ Returns normalized repos for GitHub
   and GitLab alike.
4. **Create PR/MR:** `POST …/:id/pulls` with `{repo, sourceBranch, targetBranch, title}`. ✅ GitHub opens a
   PR; GitLab opens an MR; both return `{ pr: { id, url, state } }`.
5. **Status:** `GET …/:id/status?repo=&ref=`. ✅ Normalized status.
6. **SSRF:** attempt to add a provider with `baseUrl=http://169.254.169.254/`. ✅ Rejected `unsafe_base_url`.
7. **Refresh/relink:** expire/revoke an OAuth token; next action either refreshes transparently or marks the
   provider `needsRelink` (no crash). ✅
```

- [ ] **Step 3: Whole-plan verification gate** — run all new suites + the build:
  - From `synthi/`: `npx vitest run src/lib/git src/app/api/integrations/git` → Expected: PASS (all Slice-2 suites).
  - From `synthi/`: `npx vitest run` → Expected: no regressions (the 1b/1a suites still pass).
  - **Disk-heavy (free space first; ~6 GB):** from `synthi/`: `npx prisma generate && npm run build` → Expected: build succeeds with the new `/api/integrations/git/...` routes listed.

- [ ] **Step 4: Commit**
```bash
git add synthi/.env.example docs/superpowers/plans/2026-06-02-git-provider-abstraction-slice2-E2E.md
git commit -m 'docs(slice2): git provider env + manual E2E checklist'
```

---

## Final review (controller, after all tasks)
- Whole-branch review focusing on: no plaintext tokens at rest or in responses/logs; SSRF guard on every
  `baseUrl` + outbound URL; OAuth state/CSRF on the web callback; `canReadScope` parity on every route;
  PR⇄MR normalization correctness; refresh→needsRelink path.
- Then continue on `tool-compatibility` (no branch finish — all slices share this branch).
