# External MCP Client — Plan 1a (Foundation + Hub + In-App AI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the in-app AI chat call tools from user-connected remote (HTTP/SSE) MCP servers, with an encrypted credential vault, a connections registry, and a "Connected Tools" panel that matches the app.

**Architecture:** A persistence-free `mcp-hub` library (`synthi/src/lib/mcp-hub/`) opens short-lived MCP client sessions to remote servers (SSRF-guarded, auth-injected). A Prisma-backed connection store (`synthi/src/lib/integrations/`) holds connections + AES-256-GCM secrets and resolves scoped, decrypted configs. `/api/integrations/*` routes do CRUD + test. The existing Next.js chat tool loop (`synthi/src/app/api/chat/route.js → streamGeminiWithTools`) appends external tools as `ext_<i>` function declarations and routes their calls through the hub, writing an audit row per call. A docking panel provides the connect UI. The gateway and Python engine are untouched.

**Tech Stack:** Next.js 15 (App Router, `runtime='nodejs'`), Prisma 6 + Postgres, `@modelcontextprotocol/sdk` (client), vitest 4, lucide-react, sonner, existing `@/components/ui/*` (Radix) primitives.

**Spec:** `docs/superpowers/specs/2026-05-31-external-mcp-client-design.md`

**Conventions for every task:**
- All paths are relative to the repo root `C:\Users\HP\source\repos\synthi-ide`.
- Run all `npm` / test commands from inside `synthi/` (e.g. `cd synthi && npm test`).
- Run a single test file with: `cd synthi && npx vitest run <path-relative-to-synthi>`.
- Commit messages end with the trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Work happens on the `tool-compatability` branch (already checked out).

---

## Task 1: Dependency + env (reuse existing vitest config)

**Files:**
- Modify: `synthi/package.json` (add dependency)
- Modify/Create: `synthi/.env.example`

> **Do NOT create a vitest config.** `synthi/vitest.config.mjs` already exists with
> `environment: 'jsdom'`, `globals: true`, `include: ['src/**/*.{test,spec}.{js,jsx,mjs}']`, and
> the `@`→`./src` alias. All tests in this plan rely on that existing config and live under
> `src/**/__tests__/*.test.js`, so they are picked up automatically. The jsdom env is fine for the
> node-logic modules here. Tests import `{ describe, it, expect, vi }` from `vitest` explicitly
> (works even with `globals: true`).

- [ ] **Step 1: Add the MCP SDK dependency**

Run: `cd synthi && npm install @modelcontextprotocol/sdk@^1.0.0`
Expected: `package.json` gains `"@modelcontextprotocol/sdk": "^1.0.0"` under `dependencies`; no install errors.

- [ ] **Step 2: Confirm the test runner + `@` alias work against the existing config**

Run: `cd synthi && npx vitest run src/lib/__tests__/preview-store.test.js`
Expected: the existing suite runs (PASS) — this confirms `vitest.config.mjs`, the `@` alias, and the
jsdom env are all working before you add new tests. If this command errors on config, STOP and
investigate rather than adding a second config file.

- [ ] **Step 3: Add the new env vars to the example env file**

Append to `synthi/.env.example` (create the file if it does not exist) these lines:

```
# External MCP tool connections (Plan 1a/1b)
# AUTH_SECRET (already required by NextAuth) also encrypts connection secrets.
# Optional: comma-separated hostnames allowed past the SSRF guard (self-hosted MCP servers).
SYNTHI_MCP_SSRF_ALLOWLIST=
# Optional: per-call timeout for outbound MCP requests (ms; default 20000).
SYNTHI_MCP_CALL_TIMEOUT_MS=
# Plan 1b only: shared secret for synthi-mcp -> /api/internal/mcp/resolve
SYNTHI_INTERNAL_API_TOKEN=
```

- [ ] **Step 4: Commit**

```bash
git add synthi/package.json synthi/package-lock.json synthi/.env.example
git commit -m "chore(integrations): add MCP SDK dependency + env documentation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: SSRF guard

**Files:**
- Create: `synthi/src/lib/mcp-hub/ssrfGuard.js`
- Test: `synthi/src/lib/mcp-hub/__tests__/ssrfGuard.test.js`

- [ ] **Step 1: Write the failing test**

Create `synthi/src/lib/mcp-hub/__tests__/ssrfGuard.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { isBlockedIp, assertSafeUrl } from '../ssrfGuard.js';

describe('isBlockedIp', () => {
  it('blocks loopback, private, link-local, and metadata IPs', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });
  it('allows public IPs', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

describe('assertSafeUrl', () => {
  const allowPublic = () => Promise.resolve(['93.184.216.34']);
  const allowInternal = () => Promise.resolve(['10.0.0.5']);

  it('rejects non-https URLs not on the allowlist', async () => {
    await expect(assertSafeUrl('http://example.com/mcp', { lookup: allowPublic }))
      .rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
  it('rejects localhost by name', async () => {
    await expect(assertSafeUrl('https://localhost/mcp', { lookup: allowInternal }))
      .rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
  it('rejects hosts resolving to internal IPs', async () => {
    await expect(assertSafeUrl('https://evil.example.com/mcp', { lookup: allowInternal }))
      .rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
  it('accepts https hosts resolving to public IPs', async () => {
    await expect(assertSafeUrl('https://api.example.com/mcp', { lookup: allowPublic }))
      .resolves.toBeUndefined();
  });
  it('accepts an http host explicitly on the allowlist', async () => {
    await expect(assertSafeUrl('http://internal-tools/mcp', { allowlist: ['internal-tools'], lookup: allowInternal }))
      .resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd synthi && npx vitest run src/lib/mcp-hub/__tests__/ssrfGuard.test.js`
Expected: FAIL with "Failed to resolve import '../ssrfGuard.js'".

- [ ] **Step 3: Implement the SSRF guard**

Create `synthi/src/lib/mcp-hub/ssrfGuard.js`:

```js
import dns from 'node:dns/promises';

/** Error with a stable `code` so callers can map to a normalized envelope. */
function ssrfError(message) {
  const e = new Error(message);
  e.code = 'ssrf_blocked';
  return e;
}

/** Parse an IPv4 dotted string to a 32-bit int, or null if not IPv4. */
function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inV4Cidr(ipInt, base, maskBits) {
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (ipv4ToInt(base) & mask);
}

/** True if an IP literal (v4 or v6) is in a blocked range. */
export function isBlockedIp(ip) {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    return (
      inV4Cidr(v4, '0.0.0.0', 8) ||
      inV4Cidr(v4, '10.0.0.0', 8) ||
      inV4Cidr(v4, '100.64.0.0', 10) ||
      inV4Cidr(v4, '127.0.0.0', 8) ||
      inV4Cidr(v4, '169.254.0.0', 16) ||
      inV4Cidr(v4, '172.16.0.0', 12) ||
      inV4Cidr(v4, '192.168.0.0', 16)
    );
  }
  const lower = String(ip).toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isBlockedIp(mapped[1]);
  // Unique-local fc00::/7 and link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  return false;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/**
 * Throw an `ssrf_blocked` error if `urlString` is unsafe to fetch server-side.
 * - Requires https unless the hostname is on `allowlist`.
 * - Blocks loopback/private/link-local/metadata, by literal IP or DNS resolution.
 * @param {string} urlString
 * @param {{ allowlist?: string[], lookup?: (host:string)=>Promise<string[]> }} [opts]
 *        `lookup` is injectable for tests; defaults to DNS A/AAAA resolution.
 */
export async function assertSafeUrl(urlString, opts = {}) {
  const { allowlist = [], lookup } = opts;
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw ssrfError('invalid URL');
  }
  const host = url.hostname.toLowerCase();
  const onAllowlist = allowlist.map((h) => h.toLowerCase()).includes(host);

  if (url.protocol !== 'https:' && !onAllowlist) {
    throw ssrfError('non-https URL not on allowlist');
  }
  if (onAllowlist) return;

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    throw ssrfError(`blocked hostname: ${host}`);
  }
  // If the host is an IP literal, check it directly.
  if (ipv4ToInt(host) !== null || host.includes(':')) {
    if (isBlockedIp(host)) throw ssrfError(`blocked IP: ${host}`);
    return;
  }
  // Otherwise resolve and check every returned address.
  const resolver =
    lookup ||
    (async (h) => {
      const recs = await dns.lookup(h, { all: true });
      return recs.map((r) => r.address);
    });
  let addrs;
  try {
    addrs = await resolver(host);
  } catch {
    throw ssrfError(`DNS resolution failed for ${host}`);
  }
  if (!addrs || addrs.length === 0) throw ssrfError(`no addresses for ${host}`);
  for (const addr of addrs) {
    if (isBlockedIp(addr)) throw ssrfError(`${host} resolves to blocked IP ${addr}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd synthi && npx vitest run src/lib/mcp-hub/__tests__/ssrfGuard.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/lib/mcp-hub/ssrfGuard.js synthi/src/lib/mcp-hub/__tests__/ssrfGuard.test.js
git commit -m "feat(mcp-hub): SSRF guard for outbound MCP connection URLs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Hub auth headers + schema converter (pure helpers)

**Files:**
- Create: `synthi/src/lib/mcp-hub/helpers.js`
- Test: `synthi/src/lib/mcp-hub/__tests__/helpers.test.js`

- [ ] **Step 1: Write the failing test**

Create `synthi/src/lib/mcp-hub/__tests__/helpers.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildAuthHeaders, jsonSchemaToGemini } from '../helpers.js';

describe('buildAuthHeaders', () => {
  it('builds a bearer header', () => {
    expect(buildAuthHeaders({ authType: 'bearer', secret: 'tok' }))
      .toEqual({ Authorization: 'Bearer tok' });
  });
  it('builds a custom header', () => {
    expect(buildAuthHeaders({ authType: 'header', headerName: 'X-Api-Key', secret: 'k' }))
      .toEqual({ 'X-Api-Key': 'k' });
  });
  it('returns an empty object for none', () => {
    expect(buildAuthHeaders({ authType: 'none' })).toEqual({});
  });
});

describe('jsonSchemaToGemini', () => {
  it('uppercases types recursively and preserves structure', () => {
    const out = jsonSchemaToGemini({
      type: 'object',
      properties: {
        title: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    });
    expect(out).toEqual({
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING' },
        tags: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['title'],
    });
  });
  it('defaults missing/empty schema to an empty OBJECT', () => {
    expect(jsonSchemaToGemini(undefined)).toEqual({ type: 'OBJECT', properties: {} });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd synthi && npx vitest run src/lib/mcp-hub/__tests__/helpers.test.js`
Expected: FAIL with "Failed to resolve import '../helpers.js'".

- [ ] **Step 3: Implement the helpers**

Create `synthi/src/lib/mcp-hub/helpers.js`:

```js
/**
 * Build the auth headers for a resolved connection config.
 * @param {{authType:'none'|'bearer'|'header', headerName?:string, secret?:string}} config
 * @returns {Record<string,string>}
 */
export function buildAuthHeaders(config) {
  const { authType, headerName, secret } = config || {};
  if (authType === 'bearer' && secret) return { Authorization: `Bearer ${secret}` };
  if (authType === 'header' && headerName && secret) return { [headerName]: secret };
  return {};
}

/**
 * Convert a JSON Schema (MCP tool inputSchema) to Gemini's function-parameter
 * schema, which uses UPPERCASE type names. Recurses through properties + items.
 * Falls back to an empty OBJECT when the schema is missing.
 * @param {object|undefined} schema
 * @returns {object}
 */
export function jsonSchemaToGemini(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} };
  const out = {};
  if (schema.type) out.type = String(schema.type).toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = jsonSchemaToGemini(v);
    }
  }
  if (schema.items) out.items = jsonSchemaToGemini(schema.items);
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (out.type === 'OBJECT' && !out.properties) out.properties = {};
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd synthi && npx vitest run src/lib/mcp-hub/__tests__/helpers.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/lib/mcp-hub/helpers.js synthi/src/lib/mcp-hub/__tests__/helpers.test.js
git commit -m "feat(mcp-hub): auth-header builder + JSON-Schema->Gemini converter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Hub client (listTools / callTool / testConnection)

**Files:**
- Create: `synthi/src/lib/mcp-hub/client.js`
- Create: `synthi/src/lib/mcp-hub/index.js`
- Test: `synthi/src/lib/mcp-hub/__tests__/client.test.js`

The client opens a short-lived MCP session per call. We mock the SDK `Client` and the two transports so tests need no network.

- [ ] **Step 1: Write the failing test**

Create `synthi/src/lib/mcp-hub/__tests__/client.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the MCP SDK client + transports ───────────────────────────────
const connectMock = vi.fn();
const listToolsMock = vi.fn();
const callToolMock = vi.fn();
const closeMock = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: connectMock,
    listTools: listToolsMock,
    callTool: callToolMock,
    close: closeMock,
    getServerVersion: () => ({ name: 'mock-server', version: '9.9.9' }),
  })),
}));

let lastHttpOpts;
let lastSseOpts;
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation((url, opts) => {
    lastHttpOpts = opts;
    return { kind: 'http', url };
  }),
}));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation((url, opts) => {
    lastSseOpts = opts;
    return { kind: 'sse', url };
  }),
}));

import { listTools, callTool, testConnection } from '../client.js';

const baseConfig = {
  url: 'https://api.example.com/mcp',
  transport: 'http',
  authType: 'bearer',
  secret: 'tok',
};
// Inject a lookup that resolves to a public IP so the SSRF guard passes.
const lookup = () => Promise.resolve(['93.184.216.34']);

beforeEach(() => {
  connectMock.mockReset().mockResolvedValue(undefined);
  listToolsMock.mockReset().mockResolvedValue({ tools: [{ name: 'create_issue', description: 'd', inputSchema: { type: 'object', properties: {} } }] });
  callToolMock.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  closeMock.mockReset().mockResolvedValue(undefined);
  lastHttpOpts = undefined;
  lastSseOpts = undefined;
});

describe('listTools', () => {
  it('returns tools and injects the bearer header', async () => {
    const res = await listTools(baseConfig, { lookup });
    expect(res.ok).toBe(true);
    expect(res.tools[0].name).toBe('create_issue');
    expect(lastHttpOpts.requestInit.headers).toEqual({ Authorization: 'Bearer tok' });
    expect(closeMock).toHaveBeenCalled();
  });

  it('uses the SSE transport when transport=sse', async () => {
    await listTools({ ...baseConfig, transport: 'sse' }, { lookup });
    expect(lastSseOpts.requestInit.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('returns a normalized error when the URL is SSRF-blocked', async () => {
    const res = await listTools({ ...baseConfig, url: 'https://localhost/mcp' }, { lookup });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('ssrf_blocked');
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('normalizes connect failures', async () => {
    connectMock.mockRejectedValueOnce(new Error('boom'));
    const res = await listTools(baseConfig, { lookup });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('protocol_error');
  });
});

describe('callTool', () => {
  it('forwards name + args and returns ok', async () => {
    const res = await callTool(baseConfig, 'create_issue', { title: 'x' }, { lookup });
    expect(res.ok).toBe(true);
    expect(callToolMock).toHaveBeenCalledWith({ name: 'create_issue', arguments: { title: 'x' } });
  });
});

describe('testConnection', () => {
  it('returns ok with server info + tool count', async () => {
    const res = await testConnection(baseConfig, { lookup });
    expect(res).toMatchObject({ ok: true, toolCount: 1, serverInfo: { name: 'mock-server' } });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd synthi && npx vitest run src/lib/mcp-hub/__tests__/client.test.js`
Expected: FAIL with "Failed to resolve import '../client.js'".

- [ ] **Step 3: Implement the client**

Create `synthi/src/lib/mcp-hub/client.js`:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { assertSafeUrl } from './ssrfGuard.js';
import { buildAuthHeaders } from './helpers.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.SYNTHI_MCP_CALL_TIMEOUT_MS || 20_000);

function parseAllowlist() {
  return String(process.env.SYNTHI_MCP_SSRF_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalize any thrown value into `{ code, message }`. */
function toError(err) {
  if (err && err.code === 'ssrf_blocked') return { code: 'ssrf_blocked', message: err.message };
  const msg = String(err?.message || err || 'unknown error');
  if (/401|403|unauthor|forbidden/i.test(msg)) return { code: 'auth_failed', message: msg };
  if (/timed out|timeout/i.test(msg)) return { code: 'timeout', message: msg };
  if (/certificate|tls|ssl/i.test(msg)) return { code: 'tls_error', message: msg };
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|network/i.test(msg)) return { code: 'unreachable', message: msg };
  return { code: 'protocol_error', message: msg };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`MCP call timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function makeTransport(config) {
  const url = new URL(config.url);
  const headers = buildAuthHeaders(config);
  const init = { requestInit: { headers } };
  if (config.transport === 'sse') return new SSEClientTransport(url, init);
  return new StreamableHTTPClientTransport(url, init);
}

/**
 * Open a session, run `fn(client)`, always close. SSRF-guard the URL first.
 * @param {object} config resolved connection config (url, transport, authType, headerName, secret)
 * @param {{lookup?:Function, timeoutMs?:number}} [opts]
 */
async function withSession(config, opts, fn) {
  const { lookup, timeoutMs = DEFAULT_TIMEOUT_MS } = opts || {};
  try {
    await assertSafeUrl(config.url, { allowlist: parseAllowlist(), lookup });
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
  const client = new Client({ name: 'synthi-mcp-hub', version: '1.0.0' }, { capabilities: {} });
  try {
    const transport = makeTransport(config);
    await withTimeout(client.connect(transport), timeoutMs);
    const data = await withTimeout(Promise.resolve(fn(client)), timeoutMs);
    return { ok: true, data, client };
  } catch (err) {
    return { ok: false, error: toError(err) };
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

/** List tools. Returns `{ ok, tools? , error? }`. */
export async function listTools(config, opts) {
  const res = await withSession(config, opts, (c) => c.listTools());
  if (!res.ok) return res;
  return { ok: true, tools: res.data?.tools || [] };
}

/** Call a tool. Returns `{ ok, data?, error? }`. */
export async function callTool(config, toolName, args, opts) {
  const res = await withSession(config, opts, (c) => c.callTool({ name: toolName, arguments: args || {} }));
  if (!res.ok) return res;
  return { ok: true, data: res.data };
}

/** Probe a connection. Returns `{ ok, serverInfo?, toolCount?, error? }`. */
export async function testConnection(config, opts) {
  const res = await withSession(config, opts, (c) => ({
    tools: c.listTools(),
    serverInfo: c.getServerVersion?.() || null,
  }));
  if (!res.ok) return res;
  const tools = await res.data.tools;
  return { ok: true, serverInfo: res.data.serverInfo, toolCount: (tools?.tools || []).length };
}
```

- [ ] **Step 4: Create the package barrel**

Create `synthi/src/lib/mcp-hub/index.js`:

```js
export { listTools, callTool, testConnection } from './client.js';
export { buildAuthHeaders, jsonSchemaToGemini } from './helpers.js';
export { assertSafeUrl, isBlockedIp } from './ssrfGuard.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd synthi && npx vitest run src/lib/mcp-hub/__tests__/client.test.js`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add synthi/src/lib/mcp-hub/client.js synthi/src/lib/mcp-hub/index.js synthi/src/lib/mcp-hub/__tests__/client.test.js
git commit -m "feat(mcp-hub): short-lived MCP client (listTools/callTool/testConnection)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Prisma models + migration

**Files:**
- Modify: `synthi/prisma/schema.prisma`

- [ ] **Step 1: Add the three models**

Append to `synthi/prisma/schema.prisma`:

```prisma
model EncryptedSecret {
  id        String   @id @default(cuid())
  // AES-256-GCM blob from src/lib/tokenCrypto.js, format "iv:tag:ct".
  cipher    String
  // Non-sensitive last-4 chars of the plaintext, for display only.
  last4     String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  connection McpConnection?
}

model McpConnection {
  id            String   @id @default(cuid())
  name          String
  url           String
  transport     String   @default("http") // 'http' | 'sse'
  scope         String                     // 'personal' | 'workspace'
  ownerUserId   String?
  workspaceSlug String?
  authType      String   @default("none")  // 'none' | 'bearer' | 'header'
  headerName    String?
  secretId      String?  @unique
  secret        EncryptedSecret? @relation(fields: [secretId], references: [id], onDelete: SetNull)
  // Tool names the AI may call. Empty array = none enabled (fail-closed).
  toolAllowlist String[]
  enabled       Boolean  @default(true)
  lastHealthState String?
  lastHealthAt    DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  audits McpCallAudit[]

  @@index([ownerUserId])
  @@index([workspaceSlug])
}

model McpCallAudit {
  id            String   @id @default(cuid())
  connectionId  String
  connection    McpConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  serverName    String
  toolName      String
  userId        String?
  workspaceSlug String?
  outcome       String                     // 'ok' | 'error' | 'blocked'
  errorCode     String?
  createdAt     DateTime @default(now())

  @@index([connectionId])
  @@index([createdAt])
}
```

- [ ] **Step 2: Validate the schema**

Run: `cd synthi && npx prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀".

- [ ] **Step 3: Create the migration**

Run: `cd synthi && npx prisma migrate dev --name add_mcp_connections --create-only`
Expected: a new folder `synthi/prisma/migrations/<timestamp>_add_mcp_connections/migration.sql` containing `CREATE TABLE "McpConnection"`, `"EncryptedSecret"`, `"McpCallAudit"`.

> If no database is reachable in this environment, instead run
> `cd synthi && npx prisma generate` (regenerates the client from the schema so
> types are available) and note in the commit body that the migration must be
> applied with `prisma migrate deploy` during deployment. Do not block on a DB.

- [ ] **Step 4: Regenerate the Prisma client**

Run: `cd synthi && npx prisma generate`
Expected: "Generated Prisma Client".

- [ ] **Step 5: Commit**

```bash
git add synthi/prisma/schema.prisma synthi/prisma/migrations
git commit -m "feat(db): McpConnection, EncryptedSecret, McpCallAudit models

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Connection store + vault

**Files:**
- Create: `synthi/src/lib/integrations/connectionStore.js`
- Test: `synthi/src/lib/integrations/__tests__/connectionStore.test.js`

The store is the single source of DB truth. Tests mock `@/lib/prisma` and `@/lib/tokenCrypto`.

- [ ] **Step 1: Write the failing test**

Create `synthi/src/lib/integrations/__tests__/connectionStore.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = {
  mcpConnection: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), findUnique: vi.fn() },
  encryptedSecret: { create: vi.fn(), delete: vi.fn() },
  $transaction: vi.fn(async (fns) => Promise.all(fns)),
};
vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/tokenCrypto', () => ({
  encryptToken: (pt) => `cipher(${pt})`,
  decryptToken: (blob) => String(blob).replace(/^cipher\((.*)\)$/, '$1'),
}));

import { listConnections, resolveToolConfigs, toPublic } from '../connectionStore.js';

beforeEach(() => {
  for (const m of Object.values(prismaMock.mcpConnection)) m.mockReset();
  for (const m of Object.values(prismaMock.encryptedSecret)) m.mockReset();
});

describe('toPublic', () => {
  it('never exposes secret cipher material', () => {
    const pub = toPublic({
      id: 'c1', name: 'GH', url: 'https://x', transport: 'http', scope: 'personal',
      authType: 'bearer', enabled: true, toolAllowlist: ['a'],
      secret: { id: 's1', cipher: 'cipher(tok)', last4: '..ok' },
    });
    expect(pub.secret).toBeUndefined();
    expect(pub.hasSecret).toBe(true);
    expect(pub.secretLast4).toBe('..ok');
    expect(pub.cipher).toBeUndefined();
  });
});

describe('listConnections', () => {
  it('queries personal OR workspace rows for the scope', async () => {
    prismaMock.mcpConnection.findMany.mockResolvedValue([]);
    await listConnections({ userId: 'u1', workspaceSlug: 'w1' });
    const arg = prismaMock.mcpConnection.findMany.mock.calls[0][0];
    expect(arg.where.OR).toEqual([
      { scope: 'personal', ownerUserId: 'u1' },
      { scope: 'workspace', workspaceSlug: 'w1' },
    ]);
  });
});

describe('resolveToolConfigs', () => {
  it('returns only enabled connections with a non-empty allowlist, decrypted', async () => {
    prismaMock.mcpConnection.findMany.mockResolvedValue([
      { id: 'c1', name: 'GH', url: 'https://gh', transport: 'http', authType: 'bearer', headerName: null,
        enabled: true, toolAllowlist: ['create_issue'], secret: { cipher: 'cipher(tok)' } },
      { id: 'c2', name: 'Off', url: 'https://x', transport: 'http', authType: 'none',
        enabled: false, toolAllowlist: ['a'], secret: null },
      { id: 'c3', name: 'NoTools', url: 'https://y', transport: 'http', authType: 'none',
        enabled: true, toolAllowlist: [], secret: null },
    ]);
    const out = await resolveToolConfigs({ userId: 'u1', workspaceSlug: 'w1' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'c1', secret: 'tok', allowlist: ['create_issue'] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd synthi && npx vitest run src/lib/integrations/__tests__/connectionStore.test.js`
Expected: FAIL with "Failed to resolve import '../connectionStore.js'".

- [ ] **Step 3: Implement the store**

Create `synthi/src/lib/integrations/connectionStore.js`:

```js
import prisma from '@/lib/prisma';
import { encryptToken, decryptToken } from '@/lib/tokenCrypto';

/**
 * Shape a DB row for the browser. NEVER returns secret material — only flags
 * and a last-4 hint.
 */
export function toPublic(row) {
  if (!row) return null;
  const { secret, secretId, ...rest } = row;
  return {
    ...rest,
    hasSecret: !!secret,
    secretLast4: secret?.last4 || null,
  };
}

function scopeWhere({ userId, workspaceSlug }) {
  const or = [];
  if (userId) or.push({ scope: 'personal', ownerUserId: userId });
  if (workspaceSlug) or.push({ scope: 'workspace', workspaceSlug });
  // Guard: if neither is provided, match nothing.
  return or.length ? { OR: or } : { id: '__none__' };
}

/** List connections visible to a scope, as public (secret-free) objects. */
export async function listConnections(scope) {
  const rows = await prisma.mcpConnection.findMany({
    where: scopeWhere(scope),
    include: { secret: true },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toPublic);
}

/** Create a connection (+ optional secret). Returns the public object. */
export async function createConnection(input) {
  const {
    name, url, transport = 'http', scope, ownerUserId = null, workspaceSlug = null,
    authType = 'none', headerName = null, secret = null, toolAllowlist = [], enabled = true,
  } = input;

  let secretId = null;
  if (secret) {
    const created = await prisma.encryptedSecret.create({
      data: { cipher: encryptToken(secret), last4: secret.slice(-4) },
    });
    secretId = created.id;
  }
  const row = await prisma.mcpConnection.create({
    data: { name, url, transport, scope, ownerUserId, workspaceSlug, authType, headerName, secretId, toolAllowlist, enabled },
    include: { secret: true },
  });
  return toPublic(row);
}

/** Update mutable fields (enabled, toolAllowlist, name, and optionally a new secret). */
export async function updateConnection(id, patch) {
  const data = {};
  for (const k of ['name', 'enabled', 'toolAllowlist', 'authType', 'headerName', 'url', 'transport', 'lastHealthState', 'lastHealthAt']) {
    if (patch[k] !== undefined) data[k] = patch[k];
  }
  if (patch.secret) {
    const created = await prisma.encryptedSecret.create({
      data: { cipher: encryptToken(patch.secret), last4: patch.secret.slice(-4) },
    });
    data.secretId = created.id;
  }
  const row = await prisma.mcpConnection.update({ where: { id }, data, include: { secret: true } });
  return toPublic(row);
}

/** Delete a connection (and its secret via cascade-free explicit cleanup). */
export async function deleteConnection(id) {
  const existing = await prisma.mcpConnection.findUnique({ where: { id } });
  await prisma.mcpConnection.delete({ where: { id } });
  if (existing?.secretId) {
    try { await prisma.encryptedSecret.delete({ where: { id: existing.secretId } }); } catch { /* already gone */ }
  }
}

/** Fetch a single row (with secret) for authz checks. Internal use. */
export async function getConnectionRow(id) {
  return prisma.mcpConnection.findUnique({ where: { id }, include: { secret: true } });
}

/**
 * Return resolved, decrypted configs for the hub: only enabled connections with
 * a non-empty allowlist (fail-closed). Each item is hub-ready.
 */
export async function resolveToolConfigs(scope) {
  const rows = await prisma.mcpConnection.findMany({
    where: scopeWhere(scope),
    include: { secret: true },
  });
  return rows
    .filter((r) => r.enabled && Array.isArray(r.toolAllowlist) && r.toolAllowlist.length > 0)
    .map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      transport: r.transport,
      authType: r.authType,
      headerName: r.headerName,
      secret: r.secret ? decryptToken(r.secret.cipher) : null,
      allowlist: r.toolAllowlist,
    }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd synthi && npx vitest run src/lib/integrations/__tests__/connectionStore.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/lib/integrations/connectionStore.js synthi/src/lib/integrations/__tests__/connectionStore.test.js
git commit -m "feat(integrations): Prisma-backed connection store + vault (secret-free reads)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Scope + authz helper

**Files:**
- Create: `synthi/src/lib/integrations/scope.js`
- Test: `synthi/src/lib/integrations/__tests__/scope.test.js`

- [ ] **Step 1: Write the failing test**

Create `synthi/src/lib/integrations/__tests__/scope.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = {
  user: { findUnique: vi.fn() },
  workspace: { findUnique: vi.fn() },
};
vi.mock('@/lib/prisma', () => ({ default: prismaMock }));

import { canWriteScope } from '../scope.js';

beforeEach(() => {
  prismaMock.user.findUnique.mockReset();
  prismaMock.workspace.findUnique.mockReset();
});

describe('canWriteScope', () => {
  it('allows a personal connection for its owner', async () => {
    const ok = await canWriteScope({ userId: 'u1' }, { scope: 'personal', ownerUserId: 'u1' });
    expect(ok).toBe(true);
  });
  it('denies a personal connection for a different user', async () => {
    const ok = await canWriteScope({ userId: 'u1' }, { scope: 'personal', ownerUserId: 'u2' });
    expect(ok).toBe(false);
  });
  it('allows a workspace connection for a member', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({
      id: 'w', memberships: [{ userId: 'u1' }],
    });
    const ok = await canWriteScope({ userId: 'u1' }, { scope: 'workspace', workspaceSlug: 'team' });
    expect(ok).toBe(true);
  });
  it('denies a workspace connection for a non-member', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 'w', memberships: [] });
    const ok = await canWriteScope({ userId: 'u1' }, { scope: 'workspace', workspaceSlug: 'team' });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd synthi && npx vitest run src/lib/integrations/__tests__/scope.test.js`
Expected: FAIL with "Failed to resolve import '../scope.js'".

- [ ] **Step 3: Implement the scope helper**

Create `synthi/src/lib/integrations/scope.js`:

```js
import prisma from '@/lib/prisma';

/**
 * Can the authenticated user create/edit/delete a connection with this scope?
 * - personal: only the owner.
 * - workspace: only a member of the workspace.
 * @param {{userId:string}} actor
 * @param {{scope:string, ownerUserId?:string, workspaceSlug?:string}} target
 * @returns {Promise<boolean>}
 */
export async function canWriteScope(actor, target) {
  if (!actor?.userId) return false;
  if (target.scope === 'personal') {
    return target.ownerUserId === actor.userId;
  }
  if (target.scope === 'workspace') {
    if (!target.workspaceSlug) return false;
    const ws = await prisma.workspace.findUnique({
      where: { slug: target.workspaceSlug },
      include: { memberships: { where: { userId: actor.userId } } },
    });
    return !!ws && ws.memberships.length > 0;
  }
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd synthi && npx vitest run src/lib/integrations/__tests__/scope.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/lib/integrations/scope.js synthi/src/lib/integrations/__tests__/scope.test.js
git commit -m "feat(integrations): scope authorization (personal owner / workspace member)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: API routes — list/create + update/delete + test

**Files:**
- Create: `synthi/src/lib/integrations/session.js` (auth helper shared by routes)
- Create: `synthi/src/app/api/integrations/connections/route.js`
- Create: `synthi/src/app/api/integrations/connections/[id]/route.js`
- Create: `synthi/src/app/api/integrations/connections/[id]/test/route.js`
- Test: `synthi/src/lib/integrations/__tests__/session.test.js`

The route handlers are thin glue over the tested store/scope/hub modules, so the focused unit test targets the shared `session.js` resolver; routes are exercised by the manual E2E in Task 11.

- [ ] **Step 1: Write the failing test for the session resolver**

Create `synthi/src/lib/integrations/__tests__/session.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getServerSessionMock = vi.fn();
vi.mock('next-auth', () => ({ getServerSession: getServerSessionMock }));
vi.mock('@/app/auth', () => ({ authOptions: {} }));
const prismaMock = { user: { findUnique: vi.fn() } };
vi.mock('@/lib/prisma', () => ({ default: prismaMock }));

import { resolveActor } from '../session.js';

beforeEach(() => {
  getServerSessionMock.mockReset();
  prismaMock.user.findUnique.mockReset();
});

describe('resolveActor', () => {
  it('returns null when unauthenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    expect(await resolveActor()).toBeNull();
  });
  it('maps an authenticated email to a userId', async () => {
    getServerSessionMock.mockResolvedValue({ user: { email: 'a@b.c' } });
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.c' });
    expect(await resolveActor()).toEqual({ userId: 'u1', email: 'a@b.c' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd synthi && npx vitest run src/lib/integrations/__tests__/session.test.js`
Expected: FAIL with "Failed to resolve import '../session.js'".

- [ ] **Step 3: Implement the session resolver**

Create `synthi/src/lib/integrations/session.js`:

```js
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/auth';
import prisma from '@/lib/prisma';

/**
 * Resolve the authenticated actor to `{ userId, email }`, or null.
 * Mirrors the auth pattern used by src/app/api/user/github-token/route.js.
 */
export async function resolveActor() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) return null;
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) return null;
  return { userId: user.id, email: user.email };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd synthi && npx vitest run src/lib/integrations/__tests__/session.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement the list/create route**

Create `synthi/src/app/api/integrations/connections/route.js`:

```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { listConnections, createConnection } from '@/lib/integrations/connectionStore';

export const runtime = 'nodejs';

export async function GET(req) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const workspaceSlug = new URL(req.url).searchParams.get('workspaceSlug') || null;
  const connections = await listConnections({ userId: actor.userId, workspaceSlug });
  return NextResponse.json({ connections });
}

export async function POST(req) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { name, url, transport = 'http', scope, workspaceSlug = null, authType = 'none', headerName = null, secret = null } = body || {};

  if (!name || !url || !scope) {
    return NextResponse.json({ error: 'name, url and scope are required' }, { status: 400 });
  }
  if (!['http', 'sse'].includes(transport)) {
    return NextResponse.json({ error: 'invalid transport' }, { status: 400 });
  }
  if (!['none', 'bearer', 'header'].includes(authType)) {
    return NextResponse.json({ error: 'invalid authType' }, { status: 400 });
  }

  const ownerUserId = scope === 'personal' ? actor.userId : null;
  const allowed = await canWriteScope(actor, { scope, ownerUserId, workspaceSlug });
  if (!allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // Fail-closed: a new connection starts with NO tools enabled.
  const created = await createConnection({
    name, url, transport, scope, ownerUserId, workspaceSlug, authType, headerName, secret, toolAllowlist: [], enabled: true,
  });
  return NextResponse.json({ connection: created }, { status: 201 });
}
```

- [ ] **Step 6: Implement the update/delete route**

Create `synthi/src/app/api/integrations/connections/[id]/route.js`:

```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { getConnectionRow, updateConnection, deleteConnection } from '@/lib/integrations/connectionStore';

export const runtime = 'nodejs';

async function authorize(id) {
  const actor = await resolveActor();
  if (!actor) return { status: 401, error: 'unauthenticated' };
  const row = await getConnectionRow(id);
  if (!row) return { status: 404, error: 'not_found' };
  const allowed = await canWriteScope(actor, row);
  if (!allowed) return { status: 403, error: 'forbidden' };
  return { actor, row };
}

export async function PATCH(req, { params }) {
  const { id } = await params;
  const gate = await authorize(id);
  if (gate.error) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const body = await req.json().catch(() => ({}));
  const patch = {};
  if (typeof body.name === 'string') patch.name = body.name;
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (Array.isArray(body.toolAllowlist)) patch.toolAllowlist = body.toolAllowlist.filter((t) => typeof t === 'string');
  if (typeof body.secret === 'string' && body.secret) patch.secret = body.secret;
  if (['none', 'bearer', 'header'].includes(body.authType)) patch.authType = body.authType;
  if (typeof body.headerName === 'string') patch.headerName = body.headerName;

  const updated = await updateConnection(id, patch);
  return NextResponse.json({ connection: updated });
}

export async function DELETE(_req, { params }) {
  const { id } = await params;
  const gate = await authorize(id);
  if (gate.error) return NextResponse.json({ error: gate.error }, { status: gate.status });
  await deleteConnection(id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 7: Implement the test-connection route**

Create `synthi/src/app/api/integrations/connections/[id]/test/route.js`:

```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { getConnectionRow, updateConnection } from '@/lib/integrations/connectionStore';
import { testConnection, listTools } from '@/lib/mcp-hub';
import { decryptToken } from '@/lib/tokenCrypto';

export const runtime = 'nodejs';

export async function POST(_req, { params }) {
  const { id } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const row = await getConnectionRow(id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!(await canWriteScope(actor, row))) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const config = {
    url: row.url,
    transport: row.transport,
    authType: row.authType,
    headerName: row.headerName,
    secret: row.secret ? decryptToken(row.secret.cipher) : null,
  };

  const probe = await testConnection(config);
  const state = probe.ok ? 'ok' : (probe.error?.code || 'error');
  await updateConnection(id, { lastHealthState: state, lastHealthAt: new Date() });

  if (!probe.ok) return NextResponse.json({ ok: false, state, error: probe.error }, { status: 200 });

  // Also return the discovered tool list so the UI can populate the allowlist.
  const tools = await listTools(config);
  return NextResponse.json({
    ok: true,
    state,
    serverInfo: probe.serverInfo,
    toolCount: probe.toolCount,
    tools: tools.ok ? tools.tools.map((t) => ({ name: t.name, description: t.description || '' })) : [],
  });
}
```

- [ ] **Step 8: Build to verify routes compile**

Run: `cd synthi && npx vitest run src/lib/integrations`
Expected: PASS (all integration unit tests green).

- [ ] **Step 9: Commit**

```bash
git add synthi/src/lib/integrations/session.js synthi/src/lib/integrations/__tests__/session.test.js synthi/src/app/api/integrations
git commit -m "feat(api): /api/integrations/connections CRUD + test-connection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Chat external-tools module

**Files:**
- Create: `synthi/src/app/api/chat/externalTools.js`
- Test: `synthi/src/app/api/chat/__tests__/externalTools.test.js`

This module is the seam between the chat loop and the hub. It builds Gemini declarations from resolved configs and routes `ext_<i>` calls back through the hub, writing an audit row.

- [ ] **Step 1: Write the failing test**

Create `synthi/src/app/api/chat/__tests__/externalTools.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveToolConfigsMock = vi.fn();
vi.mock('@/lib/integrations/connectionStore', () => ({ resolveToolConfigs: resolveToolConfigsMock }));
const listToolsMock = vi.fn();
const callToolMock = vi.fn();
vi.mock('@/lib/mcp-hub', () => ({ listTools: listToolsMock, callTool: callToolMock }));
const auditCreateMock = vi.fn();
vi.mock('@/lib/prisma', () => ({ default: { mcpCallAudit: { create: auditCreateMock } } }));

import { buildExternalTools, isExternalToolName, callExternalTool } from '../externalTools.js';

beforeEach(() => {
  resolveToolConfigsMock.mockReset();
  listToolsMock.mockReset();
  callToolMock.mockReset();
  auditCreateMock.mockReset().mockResolvedValue({});
});

describe('isExternalToolName', () => {
  it('matches ext_<n> only', () => {
    expect(isExternalToolName('ext_0')).toBe(true);
    expect(isExternalToolName('ext_12')).toBe(true);
    expect(isExternalToolName('read_file')).toBe(false);
    expect(isExternalToolName('ext_x')).toBe(false);
  });
});

describe('buildExternalTools', () => {
  it('builds aliased declarations limited to the allowlist; degrades on error', async () => {
    resolveToolConfigsMock.mockResolvedValue([
      { id: 'c1', name: 'GitHub', allowlist: ['create_issue'],
        url: 'https://gh', transport: 'http', authType: 'none' },
      { id: 'c2', name: 'Broken', allowlist: ['x'],
        url: 'https://b', transport: 'http', authType: 'none' },
    ]);
    listToolsMock.mockImplementation(async (cfg) => {
      if (cfg.id === 'c1') {
        return { ok: true, tools: [
          { name: 'create_issue', description: 'Create', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
          { name: 'secret_tool', description: 'hidden', inputSchema: { type: 'object' } },
        ] };
      }
      return { ok: false, error: { code: 'unreachable', message: 'down' } };
    });

    const { declarations, aliasMap } = await buildExternalTools({ userId: 'u1', workspaceSlug: 'w1' });
    expect(declarations).toHaveLength(1);
    expect(declarations[0].name).toBe('ext_0');
    expect(declarations[0].parameters.type).toBe('OBJECT');
    expect(aliasMap.ext_0).toMatchObject({ connId: 'c1', toolName: 'create_issue', connName: 'GitHub' });
  });

  it('returns empty when there are no resolved configs', async () => {
    resolveToolConfigsMock.mockResolvedValue([]);
    const { declarations } = await buildExternalTools({ userId: 'u1', workspaceSlug: null });
    expect(declarations).toEqual([]);
  });
});

describe('callExternalTool', () => {
  const aliasMap = {
    ext_0: { connId: 'c1', connName: 'GitHub', toolName: 'create_issue',
      config: { id: 'c1', url: 'https://gh', transport: 'http', authType: 'none' } },
  };

  it('routes to the hub and writes an ok audit row', async () => {
    callToolMock.mockResolvedValue({ ok: true, data: { content: [{ type: 'text', text: 'done' }] } });
    const res = await callExternalTool('ext_0', { title: 't' }, aliasMap, { userId: 'u1', workspaceSlug: 'w1' });
    expect(callToolMock).toHaveBeenCalledWith(aliasMap.ext_0.config, 'create_issue', { title: 't' });
    expect(res).toMatchObject({ content: [{ type: 'text', text: 'done' }] });
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ connectionId: 'c1', toolName: 'create_issue', outcome: 'ok' }),
    }));
  });

  it('returns a structured error and audits failure for an unknown alias', async () => {
    const res = await callExternalTool('ext_99', {}, aliasMap, { userId: 'u1' });
    expect(res.error).toBeTruthy();
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ outcome: 'error' }),
    }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd synthi && npx vitest run src/app/api/chat/__tests__/externalTools.test.js`
Expected: FAIL with "Failed to resolve import '../externalTools.js'".

- [ ] **Step 3: Implement the module**

Create `synthi/src/app/api/chat/externalTools.js`:

```js
import prisma from '@/lib/prisma';
import { resolveToolConfigs } from '@/lib/integrations/connectionStore';
import { listTools, callTool } from '@/lib/mcp-hub';
import { jsonSchemaToGemini } from '@/lib/mcp-hub/helpers.js';

const ALIAS_RE = /^ext_\d+$/;

/** True if a function name is an external-tool alias. */
export function isExternalToolName(name) {
  return ALIAS_RE.test(String(name || ''));
}

/**
 * Build Gemini function declarations for all external tools the scope may call.
 * Aliases (`ext_<i>`) avoid Gemini name-length/charset limits and hide internal
 * IDs. A failing connection is skipped (chat continues).
 * @param {{userId:string, workspaceSlug:string|null}} scope
 * @returns {Promise<{declarations:Array, aliasMap:Record<string,object>}>}
 */
export async function buildExternalTools(scope) {
  let configs = [];
  try {
    configs = await resolveToolConfigs(scope);
  } catch (e) {
    console.warn('[externalTools] resolveToolConfigs failed:', e?.message);
    return { declarations: [], aliasMap: {} };
  }

  const declarations = [];
  const aliasMap = {};
  let i = 0;

  for (const config of configs) {
    let res;
    try {
      res = await listTools(config);
    } catch (e) {
      res = { ok: false, error: { code: 'protocol_error', message: e?.message } };
    }
    if (!res.ok) {
      console.warn(`[externalTools] listTools failed for "${config.name}": ${res.error?.code}`);
      continue;
    }
    const allow = new Set(config.allowlist || []);
    for (const tool of res.tools) {
      if (!allow.has(tool.name)) continue;
      const alias = `ext_${i++}`;
      declarations.push({
        name: alias,
        description: `[${config.name}] ${tool.description || tool.name}`,
        parameters: jsonSchemaToGemini(tool.inputSchema),
      });
      aliasMap[alias] = { connId: config.id, connName: config.name, toolName: tool.name, config };
    }
  }
  return { declarations, aliasMap };
}

async function writeAudit({ connId, connName, toolName, scope, outcome, errorCode }) {
  try {
    await prisma.mcpCallAudit.create({
      data: {
        connectionId: connId || '__unknown__',
        serverName: connName || 'unknown',
        toolName: toolName || 'unknown',
        userId: scope?.userId || null,
        workspaceSlug: scope?.workspaceSlug || null,
        outcome,
        errorCode: errorCode || null,
      },
    });
  } catch (e) {
    console.warn('[externalTools] audit write failed:', e?.message);
  }
}

/**
 * Execute an external tool call by alias. Always returns a JSON-serializable
 * object suitable as a Gemini functionResponse (`{ ...result }` or `{ error }`).
 * @param {string} alias e.g. "ext_0"
 * @param {object} args
 * @param {Record<string,object>} aliasMap from buildExternalTools
 * @param {{userId:string, workspaceSlug?:string|null}} scope
 */
export async function callExternalTool(alias, args, aliasMap, scope) {
  const entry = aliasMap[alias];
  if (!entry) {
    await writeAudit({ scope, outcome: 'error', errorCode: 'unknown_alias' });
    return { error: `Unknown tool "${alias}". It may have been disabled. Do not retry.` };
  }
  let res;
  try {
    res = await callTool(entry.config, entry.toolName, args || {});
  } catch (e) {
    res = { ok: false, error: { code: 'protocol_error', message: e?.message } };
  }
  if (!res.ok) {
    await writeAudit({ connId: entry.connId, connName: entry.connName, toolName: entry.toolName, scope, outcome: 'error', errorCode: res.error?.code });
    return { error: `Tool "${entry.toolName}" failed (${res.error?.code}): ${res.error?.message}. You may report this to the user.` };
  }
  await writeAudit({ connId: entry.connId, connName: entry.connName, toolName: entry.toolName, scope, outcome: 'ok' });
  return res.data;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd synthi && npx vitest run src/app/api/chat/__tests__/externalTools.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/app/api/chat/externalTools.js synthi/src/app/api/chat/__tests__/externalTools.test.js
git commit -m "feat(chat): external-tool declaration builder + hub call router + audit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Wire external tools into the chat loop

**Files:**
- Modify: `synthi/src/app/api/chat/route.js`

This is an integration edit into `streamGeminiWithTools`. Locate exact anchors with grep before editing (line numbers drift).

- [ ] **Step 1: Import the module**

At the top of `synthi/src/app/api/chat/route.js`, just after the existing import on line 5
(`import { TOOL_DECLARATIONS, executeTool, isComplexTask } from './toolDefinitions.js';`), add:

```js
import { buildExternalTools, isExternalToolName, callExternalTool } from './externalTools.js';
```

- [ ] **Step 2: Thread `workspaceSlug` into `streamGeminiWithTools`**

The function signature is at line ~853 (`const streamGeminiWithTools = async ({`). Its parameter
list contains a `userId,` param (around line 860). Add a sibling param on the line immediately
after `userId,`:

```js
    userId,
    workspaceSlug,
```

(If `userId` in the current file has a default like `userId = null,`, keep that default and simply
add `workspaceSlug = null,` on the next line — match the existing style.)

- [ ] **Step 3: Update the call site**

The single call site is at lines ~1939–1948 (find it with
`grep -n "streamGeminiWithTools({" src/app/api/chat/route.js`). The POST handler destructures the
body around lines 1782–1794 with **plain `slug` and `userId`** (no `slugRaw`/`effectiveUserId`
aliases), so `slug` is already in scope. The call currently passes `userId,` as a shorthand
property:

```js
            stream = await streamGeminiWithTools({
                model,
                apiKey: providerKey,
                userContent,
                conversationHistory: history,
                attachments,
                workspacePath,
                userId,
                signal,
            });
```

Add `workspaceSlug: slug || null,` immediately after the `userId,` line:

```js
                workspacePath,
                userId,
                workspaceSlug: slug || null,
                signal,
```

(Indentation: 16 spaces, matching the surrounding properties.)

- [ ] **Step 4: Build external declarations before the tool loop**

Find the line (grep `const tools = [{ functionDeclarations: TOOL_DECLARATIONS }];`). Replace that
single line with:

```js
    // Built-in tools + user-connected external MCP tools (degrade gracefully).
    const { declarations: extDecls, aliasMap: extAliasMap } =
        await buildExternalTools({ userId, workspaceSlug });
    const tools = [{ functionDeclarations: [...TOOL_DECLARATIONS, ...extDecls] }];
```

- [ ] **Step 5: Route `ext_*` calls inside the dispatch loop**

Find the final `else` branch of the per-call dispatch (grep
`// Non-command tools execute immediately`). It currently reads:

```js
                    } else {
                        // Non-command tools execute immediately (read_file, search, etc.)
                        await writeEvent({ toolCall: { tool: name, args, status: 'running' } });
                        const result = await executeTool(name, args, workspacePath, signal, { apiKey: key });
                        await writeEvent({ toolCall: { tool: name, args, status: 'done' } });
                        fnResponses.push({ functionResponse: { name, response: result } });
                    }
```

Insert a new branch immediately BEFORE that `} else {` so external aliases are handled first:

```js
                    } else if (isExternalToolName(name)) {
                        // External MCP tool (user-connected). Route through the hub.
                        const extEntry = extAliasMap[name];
                        const label = extEntry ? `${extEntry.connName}:${extEntry.toolName}` : name;
                        await writeEvent({ toolCall: { tool: label, args, status: 'running' } });
                        const result = await callExternalTool(name, args, extAliasMap, { userId, workspaceSlug });
                        await writeEvent({ toolCall: { tool: label, args, status: result?.error ? 'error' : 'done' } });
                        fnResponses.push({ functionResponse: { name, response: result } });
                    } else {
```

(The new branch reuses the existing `} else {` that follows — i.e. change the existing `} else {`
into the tail of this `} else if (...) { ... } else {` chain. Keep the original `else` body intact.)

- [ ] **Step 6: Verify the existing test suite still passes and the route compiles**

Run: `cd synthi && npx vitest run src/app/api/chat`
Expected: PASS (externalTools tests still green).

Run: `cd synthi && npx eslint src/app/api/chat/route.js`
Expected: no new errors introduced by the edit (pre-existing warnings are acceptable).

- [ ] **Step 7: Commit**

```bash
git add synthi/src/app/api/chat/route.js
git commit -m "feat(chat): wire user-connected external MCP tools into the Gemini tool loop

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Frontend — client wrapper + Connected Tools panel

**Files:**
- Create: `synthi/src/components/integrations/integrationsClient.js`
- Create: `synthi/src/components/integrations/ConnectedToolsPanel.jsx`
- Create: `synthi/src/components/integrations/AddConnectionDialog.jsx`

No jsdom test environment exists, so this task is verified by `next build` + lint + the manual
check in Task 12. All colors use theme CSS variables; primitives come from `@/components/ui/*`.

- [ ] **Step 1: Create the fetch client**

Create `synthi/src/components/integrations/integrationsClient.js`:

```js
const BASE = '/api/integrations/connections';

export async function fetchConnections(workspaceSlug) {
  const qs = workspaceSlug ? `?workspaceSlug=${encodeURIComponent(workspaceSlug)}` : '';
  const res = await fetch(`${BASE}${qs}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to load connections');
  return (await res.json()).connections || [];
}

export async function createConnection(payload) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Failed to create connection');
  return data.connection;
}

export async function updateConnection(id, patch) {
  const res = await fetch(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Failed to update connection');
  return data.connection;
}

export async function deleteConnection(id) {
  const res = await fetch(`${BASE}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to delete connection');
  return true;
}

export async function testConnection(id) {
  const res = await fetch(`${BASE}/${id}/test`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Test failed');
  return data; // { ok, state, tools?: [{name, description}], ... }
}
```

- [ ] **Step 2: Create the Add-Connection dialog**

Create `synthi/src/components/integrations/AddConnectionDialog.jsx`:

```jsx
'use client';

import { useState } from 'react';
import { Plug, Eye, EyeOff } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { createConnection } from './integrationsClient';

export default function AddConnectionDialog({ workspaceSlug, onCreated }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [form, setForm] = useState({
    name: '', url: '', transport: 'http', scope: 'personal', authType: 'none', headerName: '', secret: '',
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (!form.name.trim() || !form.url.trim()) {
      toast.error('Name and URL are required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        url: form.url.trim(),
        transport: form.transport,
        scope: form.scope,
        workspaceSlug: form.scope === 'workspace' ? workspaceSlug : null,
        authType: form.authType,
        headerName: form.authType === 'header' ? form.headerName.trim() : null,
        secret: form.authType === 'none' ? null : form.secret.trim(),
      };
      const created = await createConnection(payload);
      toast.success(`Connected "${created.name}". Review its tools to enable them.`);
      setOpen(false);
      setForm({ name: '', url: '', transport: 'http', scope: 'personal', authType: 'none', headerName: '', secret: '' });
      onCreated?.(created);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const labelCls = 'text-[11px] uppercase tracking-wider';
  const labelStyle = { color: 'var(--text-muted)' };
  const fieldStyle = {
    background: 'var(--bg-input, var(--bg-editor))',
    borderColor: 'var(--border-subtle)',
    color: 'var(--text-primary)',
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Plug className="w-3.5 h-3.5" /> Add connection
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a tool (MCP server)</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-1">
          <div className="flex flex-col gap-1">
            <span className={labelCls} style={labelStyle}>Name</span>
            <Input value={form.name} onChange={set('name')} placeholder="e.g. GitHub" />
          </div>

          <div className="flex flex-col gap-1">
            <span className={labelCls} style={labelStyle}>Server URL (https)</span>
            <Input value={form.url} onChange={set('url')} placeholder="https://example.com/mcp" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <span className={labelCls} style={labelStyle}>Transport</span>
              <select value={form.transport} onChange={set('transport')}
                className="h-9 rounded-md border px-2 text-sm" style={fieldStyle}>
                <option value="http">Streamable HTTP</option>
                <option value="sse">SSE</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <span className={labelCls} style={labelStyle}>Scope</span>
              <select value={form.scope} onChange={set('scope')}
                className="h-9 rounded-md border px-2 text-sm" style={fieldStyle}>
                <option value="personal">Personal</option>
                <option value="workspace" disabled={!workspaceSlug}>Workspace</option>
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className={labelCls} style={labelStyle}>Auth</span>
            <select value={form.authType} onChange={set('authType')}
              className="h-9 rounded-md border px-2 text-sm" style={fieldStyle}>
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
            </select>
          </div>

          {form.authType === 'header' && (
            <div className="flex flex-col gap-1">
              <span className={labelCls} style={labelStyle}>Header name</span>
              <Input value={form.headerName} onChange={set('headerName')} placeholder="X-Api-Key" />
            </div>
          )}

          {form.authType !== 'none' && (
            <div className="flex flex-col gap-1">
              <span className={labelCls} style={labelStyle}>Secret</span>
              <div className="relative">
                <Input type={showSecret ? 'text' : 'password'} value={form.secret} onChange={set('secret')}
                  placeholder="Token / key (stored encrypted)" className="pr-8 font-mono" />
                <button type="button" onClick={() => setShowSecret((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 opacity-60 hover:opacity-90">
                  {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Create the panel**

Create `synthi/src/components/integrations/ConnectedToolsPanel.jsx`:

```jsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { Plug, RefreshCw, Trash2, CheckCircle2, XCircle, Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import AddConnectionDialog from './AddConnectionDialog';
import { fetchConnections, deleteConnection, testConnection, updateConnection } from './integrationsClient';

const HEALTH_ICON = {
  ok: { Icon: CheckCircle2, color: 'var(--accent-success, #4ade80)' },
  error: { Icon: XCircle, color: 'var(--accent-danger, #ff5757)' },
};

function HealthDot({ state }) {
  const entry = state && HEALTH_ICON[state] ? HEALTH_ICON[state] : (state && state !== 'ok' ? HEALTH_ICON.error : null);
  if (!entry) return <Circle className="w-3.5 h-3.5" style={{ color: 'var(--text-dim)' }} />;
  const { Icon, color } = entry;
  return <Icon className="w-3.5 h-3.5" style={{ color }} title={state} />;
}

export default function ConnectedToolsPanel() {
  const workspaceSlug = useSelector((s) => s.workspace?.slug || null);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toolsByConn, setToolsByConn] = useState({}); // id -> [{name, description}]

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setConnections(await fetchConnections(workspaceSlug));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug]);

  useEffect(() => { load(); }, [load]);

  const onTest = async (conn) => {
    try {
      const res = await testConnection(conn.id);
      if (res.ok) {
        setToolsByConn((m) => ({ ...m, [conn.id]: res.tools || [] }));
        toast.success(`${conn.name}: ${res.toolCount} tools available`);
      } else {
        toast.error(`${conn.name}: ${res.state}`);
      }
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const onToggleTool = async (conn, toolName) => {
    const current = new Set(conn.toolAllowlist || []);
    current.has(toolName) ? current.delete(toolName) : current.add(toolName);
    try {
      const updated = await updateConnection(conn.id, { toolAllowlist: [...current] });
      setConnections((cs) => cs.map((c) => (c.id === conn.id ? updated : c)));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const onToggleEnabled = async (conn) => {
    try {
      const updated = await updateConnection(conn.id, { enabled: !conn.enabled });
      setConnections((cs) => cs.map((c) => (c.id === conn.id ? updated : c)));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const onDelete = async (conn) => {
    try {
      await deleteConnection(conn.id);
      setConnections((cs) => cs.filter((c) => c.id !== conn.id));
      toast.success(`Removed "${conn.name}"`);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="flex flex-col h-full" style={{ color: 'var(--text-primary)' }}>
      <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          <Plug className="w-3.5 h-3.5" /> Connected Tools
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon" onClick={load} title="Refresh"><RefreshCw className="w-3.5 h-3.5" /></Button>
          <AddConnectionDialog workspaceSlug={workspaceSlug} onCreated={() => load()} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {loading && <div className="text-xs px-2 py-3" style={{ color: 'var(--text-muted)' }}>Loading…</div>}
        {!loading && connections.length === 0 && (
          <div className="text-xs px-2 py-6 text-center" style={{ color: 'var(--text-muted)' }}>
            No tools connected yet. Click “Add connection” to connect an MCP server
            (GitHub, Sentry, Linear, TesterArmy…).
          </div>
        )}

        {connections.map((conn) => {
          const tools = toolsByConn[conn.id] || [];
          const allow = new Set(conn.toolAllowlist || []);
          return (
            <div key={conn.id} className="rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
              <div className="flex items-center justify-between px-2.5 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <HealthDot state={conn.lastHealthState} />
                  <span className="text-sm truncate">{conn.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                    {conn.scope}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => onToggleEnabled(conn)} title={conn.enabled ? 'Enabled' : 'Disabled'}
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: conn.enabled ? 'color-mix(in srgb, #4ade80 18%, transparent)' : 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
                    {conn.enabled ? 'on' : 'off'}
                  </button>
                  <Button variant="ghost" size="icon" onClick={() => onTest(conn)} title="Test & list tools"><RefreshCw className="w-3.5 h-3.5" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => onDelete(conn)} title="Remove"><Trash2 className="w-3.5 h-3.5" /></Button>
                </div>
              </div>

              {tools.length > 0 && (
                <div className="px-2.5 pb-2 flex flex-col gap-1 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="text-[10px] uppercase tracking-wider pt-2" style={{ color: 'var(--text-muted)' }}>
                    Tools the AI may use
                  </div>
                  {tools.map((t) => (
                    <label key={t.name} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input type="checkbox" checked={allow.has(t.name)} onChange={() => onToggleTool(conn, t.name)} />
                      <span className="font-mono">{t.name}</span>
                    </label>
                  ))}
                </div>
              )}
              {tools.length === 0 && (allow.size > 0) && (
                <div className="px-2.5 pb-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {allow.size} tool(s) enabled. Click test to refresh the list.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify it builds**

Run: `cd synthi && npx eslint src/components/integrations`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/integrations
git commit -m "feat(ui): Connected Tools panel + add-connection dialog (theme-matched)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: Register the panel + activity-bar entry, then verify end-to-end

**Files:**
- Modify: `synthi/src/components/docking-wm/panels/panel-types.js`
- Modify: `synthi/src/components/docking-wm/panels/panel-wrappers.jsx`
- Modify: `synthi/src/components/docking-wm/panels/ide-panels.js`
- Modify: `synthi/src/components/docking-wm/components/DockingActivityBar.jsx`
- Modify: `synthi/src/components/docking-wm/hooks/use-activity-bar-docking.js`
- Create: `docs/superpowers/plans/2026-05-31-external-mcp-client-1a-E2E.md` (manual checklist)

- [ ] **Step 1: Add the panel type constant**

In `synthi/src/components/docking-wm/panels/panel-types.js`, add a line inside the `IDE_PANEL`
object immediately after `AI_HEALING: 'ai-healing',`:

```js
  INTEGRATIONS: 'integrations',
```

- [ ] **Step 2: Add the lazy import + wrapper in panel-wrappers.jsx**

In `synthi/src/components/docking-wm/panels/panel-wrappers.jsx`, after the existing lazy import line
for `AIHealingPanel` (`const AIHealingPanel = dynamic(() => import('@/components/healing/AIHealingPanel'), { ssr: false });`),
add:

```js
const ConnectedToolsPanel = dynamic(() => import('@/components/integrations/ConnectedToolsPanel'), { ssr: false });
```

Then, after the `AIHealingPanelWrapper` function (just before the `// ── Exports ──` comment), add a
wrapper that mirrors the others:

```js
function IntegrationsPanelWrapper() {
  const ctx = useWorkspacePanel();
  return <ConnectedToolsPanel {...ctx} />;
}
```

Then add `IntegrationsPanelWrapper,` to the `export { ... }` block (after `AIHealingPanelWrapper,`).

> Note: `ConnectedToolsPanel` reads `workspaceSlug` from the Redux store via `useSelector`, so the
> spread `ctx` is harmless (extra props are ignored). This keeps the wrapper identical in shape to its
> siblings.

- [ ] **Step 3: Import the wrapper + add the definition in ide-panels.js**

In `synthi/src/components/docking-wm/panels/ide-panels.js`:

(a) Add `IntegrationsPanelWrapper,` to the import block from `'./panel-wrappers'` (after
`AIHealingPanelWrapper,`).

(b) Add a definition object to the END of the `IDE_PANEL_DEFINITIONS` array (after the `AI_HEALING`
entry, which is the last one — insert before the closing `];`):

```js
  {
    panelType: IDE_PANEL.INTEGRATIONS,
    displayName: 'Connected Tools',
    icon: 'plug',
    category: 'sidebar',
    component: IntegrationsPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'left',
    closable: true,
  },
```

- [ ] **Step 4: Add the activity-bar button**

In `synthi/src/components/docking-wm/components/DockingActivityBar.jsx`:

(a) Add `Plug` to the `lucide-react` import block (alongside `Sparkles`, `Box`, etc.).

(b) Add an entry to the `TOP_ITEMS` array (after the `ai-healing` entry):

```js
  { id: 'integrations', panelType: IDE_PANEL.INTEGRATIONS, label: 'Connected Tools', Icon: Plug },
```

- [ ] **Step 5: Add the toggle handler**

In `synthi/src/components/docking-wm/hooks/use-activity-bar-docking.js`, add to the `handlers`
object returned by `useMemo` (after the `'ai-healing':` line):

```js
      integrations:  () => togglePanel(IDE_PANEL.INTEGRATIONS, 'Connected Tools'),
```

The activity-bar button's `id` (`'integrations'`) maps to this handler key, matching the existing
pattern (e.g. `'ai-healing'`).

- [ ] **Step 4: Build the app**

Run: `cd synthi && npm run build`
Expected: build succeeds (the new route + panel compile). Fix any type/import errors surfaced.

- [ ] **Step 5: Write the manual E2E checklist**

Create `docs/superpowers/plans/2026-05-31-external-mcp-client-1a-E2E.md`:

```markdown
# Plan 1a — Manual E2E checklist

Prereq: `AUTH_SECRET` set; Postgres reachable; migration applied
(`cd synthi && npx prisma migrate deploy`); a hosted MCP server URL + token available
(e.g. a public reference MCP, or GitHub's hosted MCP).

1. Start the app (`cd synthi && npm run dev`) and open a workspace.
2. Open the **Connected Tools** panel from the left activity bar.
3. Click **Add connection** → enter name, the MCP URL, choose **Bearer token**, paste the token,
   scope **Personal** → Save. Expect a success toast.
4. Click the connection's **test** (refresh) icon. Expect a green health dot and a tool list.
5. Tick one or two tools to add them to the allowlist.
6. Open **AI Chat**, ask the model to do something that needs that tool
   (e.g. "list my GitHub issues"). Expect a `toolCall` chip showing `<server>:<tool>` and a
   useful answer.
7. In the DB, confirm an `McpCallAudit` row exists with `outcome='ok'`.
8. Negative checks:
   - Add a connection with URL `https://localhost/mcp` → test → expect `ssrf_blocked`.
   - Untick all tools → ask the AI to use it → the tool is not offered (fail-closed).
   - Toggle the connection **off** → tools are not offered.
9. Secret hygiene: reload the panel; confirm the secret is never returned (only a masked hint),
   and that GET `/api/integrations/connections` contains no cipher/secret fields.
```

- [ ] **Step 6: Run the full test suite**

Run: `cd synthi && npm test`
Expected: all vitest suites pass (ssrfGuard, helpers, client, connectionStore, scope, session, externalTools).

- [ ] **Step 7: Commit**

```bash
git add synthi/src/components/docking-wm/panels/panel-types.js synthi/src/components/docking-wm/panels/ide-panels.js docs/superpowers/plans/2026-05-31-external-mcp-client-1a-E2E.md
git commit -m "feat(ui): register Connected Tools panel + manual E2E checklist

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Done criteria for Plan 1a

- `cd synthi && npm test` is green (7 unit suites).
- `cd synthi && npm run build` succeeds.
- The manual E2E checklist passes end-to-end (in-app AI calls an external tool; audit row written; SSRF + fail-closed + secret-hygiene negative checks hold).
- Gateway, Python engine, and `synthi-mcp` are unchanged (Plan 1b wires `synthi-mcp`).
