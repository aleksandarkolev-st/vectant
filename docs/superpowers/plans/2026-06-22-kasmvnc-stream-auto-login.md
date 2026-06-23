# KasmVNC Stream Auto-Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch `@vectant/dbeaver` and `@vectant/postman` (KasmVNC desktop-tier programs) so their App-tab streams open with zero password entry, while each session keeps a unique random password (no shared secret), injected server-side by the collab proxy.

**Architecture:** In the single collab-server process, `launchManagedSession` generates a per-session random `KASM_PASSWORD` for `webGui` container programs, passes it into the container via **env-passthrough** (recipe declares `-e KASM_PASSWORD`; the runtime exec/pod export carries the value), and records `{user:'vectant', password}` in memory. The `/wsport` container proxy — already the workspace-access boundary — calls `resolveStreamAuth(slug, port)` and injects `Authorization: Basic base64(user:pw)` into the forwarded HTTP request and WS upgrade when a credential exists and the incoming request carries none. The credential never reaches the browser and is never persisted.

**Tech Stack:** Node.js (collab-server, `node:test`), Next.js lib (`synthi/src/lib/programs`, Vitest), Docker/KasmVNC gui-base image.

**Decision resolved (spec left open):** **env-passthrough**, not literal-splice. Verified this carries `KASM_PASSWORD` into the container on BOTH backends:
- Hybrid local (`workspaceRuntimeContainer.js::execInRuntime`): forwards declared `env` as dockerode exec `Env`; filtered only by `HOST_ENV_DENYLIST`, which does NOT contain `KASM_PASSWORD`.
- Sysbox pod (`runtimePodTerminal.js::buildRuntimeShellScript`): emits `export KEY=value` per env entry; filter only drops null/undefined values.
The recipe `-e KASM_PASSWORD` passthrough form then reads the value from that exec/shell environment. Env-passthrough keeps the password out of `docker run` argv and server logs.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `backend/collab-server/programRuntimeManager.js` | Generate/inject/store the per-session credential; expose `resolveStreamAuth`; strip secret from public snapshots | Modify |
| `backend/collab-server/__tests__/programRuntimeManager.test.js` | Unit tests for credential generation + resolution + non-leak | Modify |
| `backend/collab-server/containerPortProxy.js` | Inject `Authorization: Basic` into forwarded HTTP + WS when a cred is resolved & absent | Modify |
| `backend/collab-server/__tests__/containerPortProxy.test.js` | Unit tests for HTTP + WS injection, null-resolver, and non-clobber | Modify |
| `synthi/src/lib/programs/defaultPrograms.js` | Declare `-e KASM_PASSWORD` passthrough on dbeaver + postman recipes | Modify |
| `synthi/src/lib/programs/__tests__/defaultPrograms.test.js` | Assert the passthrough is present (no inline value) | Modify |
| `backend/collab-server/server.js` | Wire `resolveStreamAuth` from the manager into `createContainerPortProxy` | Modify |

**Guardrails (from mission brief — non-negotiable):**
- Work only on branch `feat/docker-sysbox-engine`. Never push without explicit approval.
- Stage files **explicitly** per commit. NEVER `git add -A`/`git add .`.
- Do NOT stage: `synthi/Dockerfile`, `docker-compose.override.yml`, `memory/`, `tasks/*.md`, scratch files.
- Commit via `git commit -F -` heredoc, trailing `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Verification commands (run from repo ROOT):**
- Collab-server suite (scoped — bare `node --test` hangs, lesson #21): `node --test --test-timeout=20000 backend/collab-server/__tests__/*.test.js`
- Programs lib suite (cwd leaks across Bash calls — use a subshell, gotcha #1): `(cd synthi && npx vitest run src/lib/programs)`

---

## Task 1: Proxy injects Basic auth (HTTP + WS)

**Files:**
- Modify: `backend/collab-server/containerPortProxy.js`
- Test: `backend/collab-server/__tests__/containerPortProxy.test.js`

Self-contained: no dependency on the manager (resolver is injected/stubbed). The new `resolveStreamAuth` option MUST default to a null-returning fn so the existing `createContainerPortProxy({ resolveHost })` test (and the dark-merge `server.js` path) keep working.

- [ ] **Step 1: Write the failing tests**

Append to `backend/collab-server/__tests__/containerPortProxy.test.js` (add `const net = require('net');` near the top with the other requires):

```js
// ── Stream auto-login: proxy injects Authorization: Basic (Task 1) ──

function httpGetBody(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test('proxyHttp injects Basic auth when a credential is resolved and absent', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('AUTH:' + (req.headers.authorization || 'none')); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();
  const proxy = createContainerPortProxy({
    resolveHost: () => '127.0.0.1',
    resolveStreamAuth: () => ({ user: 'vectant', password: 'secret123' }),
  });
  const front = http.createServer((req, res) => proxy.proxyHttp(req, res));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;

  const body = await httpGetBody(`http://127.0.0.1:${fp}/wsport/repo/${port}/x`);
  const expected = 'Basic ' + Buffer.from('vectant:secret123').toString('base64');
  assert.equal(body, 'AUTH:' + expected);
  upstream.close(); front.close();
});

test('proxyHttp injects nothing when the resolver returns null', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('AUTH:' + (req.headers.authorization || 'none')); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();
  const proxy = createContainerPortProxy({ resolveHost: () => '127.0.0.1', resolveStreamAuth: () => null });
  const front = http.createServer((req, res) => proxy.proxyHttp(req, res));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;

  const body = await httpGetBody(`http://127.0.0.1:${fp}/wsport/repo/${port}/x`);
  assert.equal(body, 'AUTH:none');
  upstream.close(); front.close();
});

test('proxyHttp does not override an Authorization header already on the request', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('AUTH:' + (req.headers.authorization || 'none')); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();
  const proxy = createContainerPortProxy({
    resolveHost: () => '127.0.0.1',
    resolveStreamAuth: () => ({ user: 'vectant', password: 'secret123' }),
  });
  const front = http.createServer((req, res) => proxy.proxyHttp(req, res));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;

  const body = await httpGetBody(`http://127.0.0.1:${fp}/wsport/repo/${port}/x`, { Authorization: 'Basic preset' });
  assert.equal(body, 'AUTH:Basic preset');
  upstream.close(); front.close();
});

test('proxyWsUpgrade injects an Authorization header line when a credential is resolved and absent', async () => {
  let received = '';
  const upstream = net.createServer((sock) => { sock.on('data', (d) => { received += d.toString('utf8'); }); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();
  const proxy = createContainerPortProxy({
    resolveHost: () => '127.0.0.1',
    resolveStreamAuth: () => ({ user: 'vectant', password: 'pw' }),
  });
  const front = http.createServer();
  front.on('upgrade', (req, socket, head) => proxy.proxyWsUpgrade(req, socket, head));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;

  const client = net.connect(fp, '127.0.0.1', () => {
    client.write(`GET /wsport/repo/${port}/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  });
  await waitUntil(() => received.includes('\r\n\r\n'));
  const expected = 'Authorization: Basic ' + Buffer.from('vectant:pw').toString('base64');
  assert.ok(received.includes(expected), `expected injected header, got:\n${received}`);
  client.destroy(); upstream.close(); front.close();
});

test('proxyWsUpgrade does not override an Authorization header already on the upgrade request', async () => {
  let received = '';
  const upstream = net.createServer((sock) => { sock.on('data', (d) => { received += d.toString('utf8'); }); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();
  const proxy = createContainerPortProxy({
    resolveHost: () => '127.0.0.1',
    resolveStreamAuth: () => ({ user: 'vectant', password: 'pw' }),
  });
  const front = http.createServer();
  front.on('upgrade', (req, socket, head) => proxy.proxyWsUpgrade(req, socket, head));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;

  const client = net.connect(fp, '127.0.0.1', () => {
    client.write(`GET /wsport/repo/${port}/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: Basic preset\r\n\r\n`);
  });
  await waitUntil(() => received.includes('\r\n\r\n'));
  const injected = 'Basic ' + Buffer.from('vectant:pw').toString('base64');
  assert.ok(received.includes('Basic preset'), `expected preset header forwarded, got:\n${received}`);
  assert.ok(!received.includes(injected), `must not inject over an existing header, got:\n${received}`);
  client.destroy(); upstream.close(); front.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=20000 backend/collab-server/__tests__/containerPortProxy.test.js`
Expected: the 5 new tests FAIL (the injecting ones see `AUTH:none` / no injected header because injection isn't implemented; `createContainerPortProxy` ignores the unknown `resolveStreamAuth` option).

- [ ] **Step 3: Implement the injection**

Edit `backend/collab-server/containerPortProxy.js`.

(a) Add a helper above `createContainerPortProxy`:

```js
/** Build an `Authorization: Basic …` value from a {user,password} cred, or null. */
function basicAuthHeaderValue(cred) {
  if (!cred || !cred.user || !cred.password) return null;
  return `Basic ${Buffer.from(`${cred.user}:${cred.password}`).toString('base64')}`;
}
```

(b) Change the factory signature to accept the optional resolver (default null-returning so existing callers/tests are unaffected):

```js
function createContainerPortProxy({ resolveHost, resolveStreamAuth = () => null } = {}) {
  if (typeof resolveHost !== 'function') throw new TypeError('resolveHost is required');
```

(c) In `proxyHttp`, after the `host` guard, build the forwarded headers with conditional injection and use them in the request:

```js
  function proxyHttp(req, res) {
    const parsed = parseWsPortUrl(req.url);
    if (!parsed) { res.writeHead(400); res.end('bad /wsport url'); return; }
    const host = resolveHost(parsed.slug);
    if (!host) { res.writeHead(502); res.end('runtime container not running'); return; }
    const headers = { ...req.headers, host: `localhost:${parsed.port}` };
    // Stream auto-login: inject the per-session KasmVNC Basic credential the
    // browser can't supply (cross-origin COEP iframe suppresses the dialog).
    // Only fill an ABSENT Authorization — never clobber a real incoming one.
    if (!req.headers.authorization) {
      const auth = basicAuthHeaderValue(resolveStreamAuth(parsed.slug, parsed.port));
      if (auth) headers.authorization = auth;
    }
    const proxyReq = http.request({
      hostname: host, port: parsed.port, path: parsed.downstream, method: req.method,
      headers, timeout: 30000,
    }, (up) => {
      res.writeHead(up.statusCode, buildProxyResponseHeaders(up.headers));
      up.pipe(res, { end: true });
    });
    proxyReq.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('upstream unreachable'); } });
    proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end('gateway timeout'); } });
    req.pipe(proxyReq, { end: true });
  }
```

(d) In `proxyWsUpgrade`, build the raw header lines, conditionally append the Authorization line:

```js
  function proxyWsUpgrade(req, socket, head) {
    const parsed = parseWsPortUrl(req.url);
    if (!parsed) { socket.destroy(); return false; }
    const host = resolveHost(parsed.slug);
    if (!host) { socket.destroy(); return false; }
    const up = net.connect(parsed.port, host, () => {
      const reqLine = `${req.method} ${parsed.downstream} HTTP/1.1\r\n`;
      const headerLines = Object.entries(req.headers)
        .filter(([k]) => k.toLowerCase() !== 'host')
        .map(([k, v]) => `${k}: ${v}`)
        .concat([`Host: localhost:${parsed.port}`]);
      // Same auto-login injection as proxyHttp, for the noVNC /websockify upgrade.
      if (!req.headers.authorization) {
        const auth = basicAuthHeaderValue(resolveStreamAuth(parsed.slug, parsed.port));
        if (auth) headerLines.push(`Authorization: ${auth}`);
      }
      up.write(reqLine + headerLines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    return true;
  }
```

(e) Export the helper for completeness (keeps `module.exports` shape consistent — optional but harmless):

```js
module.exports = { parseWsPortUrl, createContainerPortProxy, buildProxyResponseHeaders, basicAuthHeaderValue };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-timeout=20000 backend/collab-server/__tests__/containerPortProxy.test.js`
Expected: ALL tests PASS (including the pre-existing `proxyHttp forwards to the resolved runtime host` and `buildProxyResponseHeaders` tests).

- [ ] **Step 5: Commit**

```bash
git add backend/collab-server/containerPortProxy.js backend/collab-server/__tests__/containerPortProxy.test.js
git commit -F - <<'EOF'
feat(proxy): inject per-session KasmVNC Basic auth on /wsport HTTP + WS

The App tab is a cross-origin COEP-credentialless iframe, so Chrome suppresses
the HTTP Basic dialog KasmVNC gates on. Add an optional resolveStreamAuth(slug,
port) to the container port proxy: when it returns a {user,password} and the
incoming request has no Authorization header, inject Authorization: Basic into
the forwarded HTTP request and WS upgrade. Non-clobbering (an explicit incoming
header always wins) and defaults to a null resolver so existing callers are
unaffected.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 2: Manager generates, injects, stores, and resolves the credential

**Files:**
- Modify: `backend/collab-server/programRuntimeManager.js`
- Test: `backend/collab-server/__tests__/programRuntimeManager.test.js`

Generate a random `[A-Za-z0-9]` 24-char password for `webGui && container` launches, add it to the scrubbed env (so the recipe's `-e KASM_PASSWORD` passthrough carries it), store `{user:'vectant', password}` on the in-memory record, expose `resolveStreamAuth(slug, port)`, and STRIP the secret from public snapshots.

- [ ] **Step 1: Write the failing tests**

Append to `backend/collab-server/__tests__/programRuntimeManager.test.js`:

```js
// ── Stream auto-login: per-session KasmVNC credential (Task 2) ──

test('webGui container launch injects a random KASM_PASSWORD and exposes kasmAuth via resolveStreamAuth', async () => {
  const launches = [];
  const mgr = makeManager({ launchRuntime: async (spec) => { launches.push(spec); return createManagedRuntimeHandle(); } });

  const s = await mgr.launchManagedSession({
    sessionId: 'g1', workspaceSlug: 'wsa', command: 'docker run x',
    runtimeType: 'container', webGui: true, ports: [6901],
  });

  // injected into the env handed to launchRuntime (for the `-e KASM_PASSWORD` passthrough)
  assert.match(launches[0].env.KASM_PASSWORD, /^[A-Za-z0-9]{24}$/);
  // resolvable by slug + declared port, user is the gui-base default
  const auth = mgr.resolveStreamAuth('wsa', 6901);
  assert.equal(auth.user, 'vectant');
  assert.equal(auth.password, launches[0].env.KASM_PASSWORD);
  // SECURITY: the public snapshot (sent to the browser) must never carry the secret
  assert.equal(s.kasmAuth, undefined);
  assert.equal(mgr.getManagedSession('g1').kasmAuth, undefined);
});

test('resolveStreamAuth returns null for non-webGui or non-container sessions', async () => {
  const mgr = makeManager();
  await mgr.launchManagedSession({ sessionId: 'c1', workspaceSlug: 'wsb', command: 'x', runtimeType: 'container', webGui: false, ports: [9000] });
  await mgr.launchManagedSession({ sessionId: 'w1', workspaceSlug: 'wsc', command: 'x', runtimeType: 'web', webGui: true, ports: [3000] });
  assert.equal(mgr.resolveStreamAuth('wsb', 9000), null);
  assert.equal(mgr.resolveStreamAuth('wsc', 3000), null);
});

test('resolveStreamAuth matches on port and stops resolving after the session stops', async () => {
  const mgr = makeManager();
  await mgr.launchManagedSession({ sessionId: 'g2', workspaceSlug: 'wsd', command: 'x', runtimeType: 'container', webGui: true, ports: [6902] });
  assert.equal(mgr.resolveStreamAuth('wsd', 6901), null);   // wrong port
  assert.ok(mgr.resolveStreamAuth('wsd', 6902));            // right port
  assert.equal(mgr.resolveStreamAuth('other', 6902), null); // wrong slug

  await mgr.stopManagedSession('g2', { reason: 'user_stop' });
  assert.equal(mgr.resolveStreamAuth('wsd', 6902), null);   // stopped → gone
});

test('a regular (non-webGui) container launch does not inject KASM_PASSWORD', async () => {
  const launches = [];
  const mgr = makeManager({ launchRuntime: async (spec) => { launches.push(spec); return createManagedRuntimeHandle(); } });
  await mgr.launchManagedSession({ sessionId: 'p1', workspaceSlug: 'w', command: 'x', runtimeType: 'container', webGui: false, ports: [9000] });
  assert.equal('KASM_PASSWORD' in launches[0].env, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-timeout=20000 backend/collab-server/__tests__/programRuntimeManager.test.js`
Expected: the 4 new tests FAIL (`mgr.resolveStreamAuth is not a function`; no `KASM_PASSWORD` in env).

- [ ] **Step 3: Implement generation, storage, stripping, and resolution**

Edit `backend/collab-server/programRuntimeManager.js`.

(a) Add the crypto require under `'use strict';` (top of file):

```js
'use strict';

const crypto = require('crypto');
```

(b) Add the user constant + generator near the other module constants (after `BLOCKED_ENV_VALUE_FRAGMENTS`):

```js
// Stream auto-login: the KasmVNC Basic-auth user is the gui-base default
// (KASM_VNC_USER → vectant); single source of truth for both the injected
// credential and the proxy header.
const KASM_STREAM_USER = 'vectant';
const KASM_PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Per-session random KasmVNC password: 24 chars of [A-Za-z0-9], unbiased. */
function generateKasmStreamPassword(length = 24) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += KASM_PASSWORD_ALPHABET[crypto.randomInt(KASM_PASSWORD_ALPHABET.length)];
  }
  return out;
}
```

(c) Strip `kasmAuth` from public snapshots in `toPublicManagedSession` (it carries the per-session secret and must never leave the server):

```js
function toPublicManagedSession(record) {
  if (!record) {
    return null;
  }

  const {
    runtime,
    idleTimer,
    healthTimer,
    health,
    runtimeDataDisposable,
    runtimeExitDisposable,
    launchRequest,
    kasmAuth, // per-session KasmVNC secret — never expose to the API/browser
    ...publicRecord
  } = record;

  return {
    ...publicRecord,
    activePorts: [...publicRecord.activePorts],
  };
}
```

(d) In `launchManagedSession`, after `const safeEnv = buildManagedRuntimeEnv(baseEnv, env);`, generate + inject for the webGui-container case. Replace the existing block:

```js
    const currentTime = now();
    const safeEnv = buildManagedRuntimeEnv(baseEnv, env);
    // Phase 2 surfaces *declared* manifest ports immediately (Phase 3 adds
    // live auto-detection via refreshManagedSessionPorts).
    const declaredPorts = normalizePorts(ports);
```

with:

```js
    const currentTime = now();
    const safeEnv = buildManagedRuntimeEnv(baseEnv, env);
    // Stream auto-login: webGui container programs (KasmVNC desktop tier) get a
    // unique random password per launch, injected via env-passthrough — the
    // recipe declares `-e KASM_PASSWORD`, which reads this value from the exec
    // env (hybrid) / exported shell env (pod). Regenerated on every launch, so
    // restartManagedSession rotates it; gone when the record is dropped.
    const isWebGuiContainer = webGui === true && runtimeType === 'container';
    let kasmAuth = null;
    if (isWebGuiContainer) {
      const password = generateKasmStreamPassword();
      safeEnv.KASM_PASSWORD = password;
      kasmAuth = { user: KASM_STREAM_USER, password };
    }
    // Phase 2 surfaces *declared* manifest ports immediately (Phase 3 adds
    // live auto-detection via refreshManagedSessionPorts).
    const declaredPorts = normalizePorts(ports);
```

(e) Add `kasmAuth` to the `record` object literal. Insert it right after the `webGui: webGui === true,` line:

```js
      runtimeType,
      webGui: webGui === true,
      kasmAuth,
      title: title || trimmedCommand,
```

(f) Add the `resolveStreamAuth` function near `getManagedSession` (before the `return { … }` API object):

```js
  /**
   * Stream auto-login lookup for the container port proxy. Return the in-memory
   * KasmVNC credential of the RUNNING webGui session whose workspaceSlug === slug
   * and whose declared/active ports include `port`; else null. Returns a copy so
   * callers can't mutate the stored secret.
   */
  function resolveStreamAuth(slug, port) {
    if (!slug || !Number.isInteger(port)) return null;
    for (const record of managedSessions.values()) {
      if (!record.kasmAuth) continue;
      if (record.workspaceSlug !== slug) continue;
      if (!RUNNING_STATES.includes(record.state)) continue;
      const ports = new Set([...(record.declaredPorts || []), ...(record.activePorts || [])]);
      if (!ports.has(port)) continue;
      return { ...record.kasmAuth };
    }
    return null;
  }
```

(g) Add `resolveStreamAuth` to the returned API object (alphabetical-ish, next to `restartManagedSession`):

```js
    recomputeRuntimeScopePorts,
    refreshManagedSessionPorts,
    resolveStreamAuth,
    restartManagedSession,
    stopManagedSession,
    promoteHeadlessSession,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-timeout=20000 backend/collab-server/__tests__/programRuntimeManager.test.js`
Expected: ALL tests PASS (new 4 + all pre-existing, incl. the `scrubs env`/webGui tests).

- [ ] **Step 5: Commit**

```bash
git add backend/collab-server/programRuntimeManager.js backend/collab-server/__tests__/programRuntimeManager.test.js
git commit -F - <<'EOF'
feat(programs): generate per-session KasmVNC credential for webGui containers

launchManagedSession now mints a unique random KASM_PASSWORD (24 chars of
[A-Za-z0-9]) for webGui + container programs, injects it via env-passthrough
(the recipe's `-e KASM_PASSWORD`), and records {user:'vectant', password} on the
in-memory session. resolveStreamAuth(slug, port) returns it for the running
session matching that workspace + declared/active port (null otherwise — so the
web-UI tier like Portainer is untouched). The secret is stripped from public
session snapshots so it never reaches the API/browser, and is regenerated on
restart / gone on stop.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 3: Recipes declare the `-e KASM_PASSWORD` passthrough

**Files:**
- Modify: `synthi/src/lib/programs/defaultPrograms.js`
- Test: `synthi/src/lib/programs/__tests__/defaultPrograms.test.js`

Add the passthrough form (`-e KASM_PASSWORD`, no value) to the dbeaver + postman launch strings so docker forwards the manager-injected value into the container.

- [ ] **Step 1: Write the failing assertions**

In `synthi/src/lib/programs/__tests__/defaultPrograms.test.js`, extend the two existing tests.

In `ships @vectant/dbeaver as a webGui container program (KasmVNC)`, add before the closing `});`:

```js
    // Per-session auto-login: the password is injected by the runtime manager;
    // the recipe only declares the passthrough (no value committed).
    expect(dbeaver.launch).toMatch(/-e KASM_PASSWORD(\s|$)/);
    expect(dbeaver.launch).not.toContain('KASM_PASSWORD=');
```

In `ships @vectant/postman as a webGui container program (KasmVNC)`, add before the closing `});`:

```js
    // Per-session auto-login passthrough (distinct from the -e KASM_PORT value above).
    expect(postman.launch).toMatch(/-e KASM_PASSWORD(\s|$)/);
    expect(postman.launch).not.toContain('KASM_PASSWORD=');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `(cd synthi && npx vitest run src/lib/programs/__tests__/defaultPrograms.test.js)`
Expected: the dbeaver + postman tests FAIL (`-e KASM_PASSWORD` not present).

- [ ] **Step 3: Implement the recipe change**

Edit `synthi/src/lib/programs/defaultPrograms.js`.

dbeaver `launch` (currently line ~124) — add `-e KASM_PASSWORD ` before the mount flags:

```js
      launch: `docker run --rm --name vectant-dbeaver -p ${DBEAVER_PORT}:${DBEAVER_PORT} -e KASM_PASSWORD ${workspaceMountFlags()} ${DBEAVER_IMAGE}`,
```

postman `launch` (currently line ~143) — add `-e KASM_PASSWORD ` after the existing `-e KASM_PORT=...`:

```js
      launch: `docker run --rm --name vectant-postman -p ${POSTMAN_PORT}:${POSTMAN_PORT} -e KASM_PORT=${POSTMAN_PORT} -e KASM_PASSWORD ${workspaceMountFlags()} ${POSTMAN_IMAGE}`,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `(cd synthi && npx vitest run src/lib/programs/__tests__/defaultPrograms.test.js)`
Expected: ALL tests PASS (incl. the unchanged catalog-count = 10 and the existing `-p 6901:6901` / `-e KASM_PORT=6902` / mount-flag assertions).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/lib/programs/defaultPrograms.js synthi/src/lib/programs/__tests__/defaultPrograms.test.js
git commit -F - <<'EOF'
feat(programs): declare -e KASM_PASSWORD passthrough on dbeaver + postman

The KasmVNC desktop-tier recipes now pass KASM_PASSWORD through to the container
(passthrough form, no value committed). The per-session random value is injected
into the exec env by the runtime manager; docker forwards it so the gui-base
entrypoint provisions the matching ~/.kasmpasswd, which the proxy then satisfies
on the user's behalf.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 4: Wire `resolveStreamAuth` into the proxy in server.js

**Files:**
- Modify: `backend/collab-server/server.js` (the `createContainerPortProxy({ … })` call, ~line 128-141)

Mirror the existing `resolveHost` wiring. The arrow body runs only at request time, so referencing `managedProgramRuntime` (declared later at ~line 183) inside the closure is safe — the same pattern already exists at line 176 (`runtimePortMonitor` → `managedProgramRuntime.recomputeRuntimeScopePorts`).

- [ ] **Step 1: Implement the wiring**

In `backend/collab-server/server.js`, extend the `createContainerPortProxy({ … })` options object with `resolveStreamAuth`:

```js
const containerPortProxy = ENABLE_CONTAINER_RUNTIME
  ? createContainerPortProxy({
      // Resolve the running runtime-container host for a slug. Dev is effectively
      // single-user per workspace, so match the first session keyed by `${slug} `.
      resolveHost: (slug) => {
        const match = [...workspaceRuntime._sessions.keys()].find((k) => k.startsWith(`${slug} `));
        if (!match) return null;
        // Keys are `${slug} ${userId}`; split on the FIRST space only so a userId
        // that itself contains a space is reconstructed intact.
        const spaceIdx = match.indexOf(' ');
        return runtimeContainerHost(match.slice(0, spaceIdx), match.slice(spaceIdx + 1));
      },
      // Stream auto-login: hand the proxy the per-session KasmVNC credential so it
      // injects Authorization: Basic for webGui desktop streams (DBeaver/Postman).
      // Invoked at request time, after managedProgramRuntime is initialized.
      resolveStreamAuth: (slug, port) => managedProgramRuntime.resolveStreamAuth(slug, port),
    })
  : null;
```

- [ ] **Step 2: Verify it loads + the suite stays green**

Run (syntax/wiring smoke — must print `ok`):
`node -e "require('./backend/collab-server/containerPortProxy'); require('./backend/collab-server/programRuntimeManager'); console.log('ok')"`
Expected: `ok` (no syntax error). NOTE: do not `require('./backend/collab-server/server')` directly — it boots the full server.

Run the full collab-server suite: `node --test --test-timeout=20000 backend/collab-server/__tests__/*.test.js`
Expected: all tests PASS (55 pre-existing + the new proxy + manager tests), no regressions.

- [ ] **Step 3: Commit**

```bash
git add backend/collab-server/server.js
git commit -F - <<'EOF'
feat(server): wire resolveStreamAuth into the container port proxy

Pass managedProgramRuntime.resolveStreamAuth into createContainerPortProxy,
mirroring the resolveHost wiring, so /wsport streams for webGui desktop programs
auto-authenticate with the per-session KasmVNC credential. Resolver is invoked at
request time, after the manager is initialized.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 5: Full-suite verification (Definition of Done)

**No code change** — prove the whole change green before handing back to the user.

- [ ] **Step 1: Collab-server suite (scoped)**

Run: `node --test --test-timeout=20000 backend/collab-server/__tests__/*.test.js`
Expected: 0 failing. Capture the pass/fail tail as evidence.

- [ ] **Step 2: Full programs lib suite**

Run: `(cd synthi && npx vitest run src/lib/programs)`
Expected: all files pass, incl. `defaultPrograms.test.js` (catalog = 10) and `manifest`/`workspaceMount` suites.

- [ ] **Step 3: Confirm guardrail-clean working tree**

Run: `git status --porcelain`
Expected: the 4 source files committed (clean), with ONLY the allowed local-only leftovers unstaged/untracked: `synthi/Dockerfile` (M), `docker-compose.override.yml`, `memory/`, `tasks/*.md`. No scratch/temp files remain.

- [ ] **Step 4: Show the test output to the user** (project rule: evidence before assertions). Give a 1-2 sentence plain-words recap.

---

## Runtime/live-test prep (assistant prepares; USER verifies)

The frontend + collab-server are run by the USER. After this change is committed, the user rebuilds + runs collab-server and the frontend, then launches DBeaver and Postman. Expected: both App-tab streams open with NO password prompt and still scale-to-fit.

Assistant pre-checks before handoff (per mission §5, §7):
- The recipe change ships a NEW manifest. The local catalog is seeded in the DB; a re-seed CLOBBERS Portainer's local socket patch (lesson §5.5). To update dbeaver/postman manifests locally, do a TARGETED upsert of just those two `@vectant/*` rows (set the new `launch` string), never a full reseed. SQL via `docker cp x.sql synthi-ide-postgres-1:/tmp/` + `docker exec … psql -f` (Postgres isn't published to host; PascalCase-quoted tables; provide `id`/`updatedAt`). Tell the user exactly what to click to relaunch.
- Images `vectant-dbeaver:dev` / `vectant-postman:dev` are already loaded in the runtime; no image rebuild is needed for THIS change (it's a password/proxy change, not an image change). The gui-base entrypoint already honors `KASM_PASSWORD`.

---

## Self-Review

**Spec coverage:**
- Component 1 (generate/inject/store/expose) → Task 2. ✓
- Component 2 (proxy header injection, HTTP + WS, non-clobber) → Task 1. ✓
- Component 3 (server.js wiring) → Task 4. ✓
- Component 4 (recipe passthrough) → Task 3. ✓
- Behavior guarantee 1 (scoped: only webGui containers) → Task 2 (`isWebGuiContainer` gate; `resolveStreamAuth` null otherwise) + Task 2 test `returns null for non-webGui or non-container`. ✓
- Behavior guarantee 2 (per-port) → Task 2 `resolveStreamAuth` port-set match + test `matches on port`. ✓
- Behavior guarantee 3 (lifecycle: in-memory, regenerated on restart, gone on stop) → Task 2 (generated in `launchManagedSession`, stored on record, not in `launchRequest.env`) + test `stops resolving after stop`. ✓
- Behavior guarantee 4 (non-clobbering) → Task 1 `if (!req.headers.authorization)` + tests `does not override`. ✓
- Testing section (3 test files, full suites green) → Tasks 1-3 + Task 5. ✓
- Added beyond spec (security): strip `kasmAuth` from public snapshots so the secret never reaches the browser (the spec says "credential never reaches the browser" but the public snapshot is an API payload — Task 2 (c) + non-leak assertion). ✓

**Placeholder scan:** No TBD/TODO/"handle errors"/"similar to". All steps carry complete code. ✓

**Type/name consistency:** `resolveStreamAuth(slug, port)` identical in manager (Task 2), proxy option (Task 1), server wiring (Task 4). Credential shape `{user, password}` consistent across generator, store, resolver, and `basicAuthHeaderValue`. `KASM_STREAM_USER='vectant'` is the single user source. `generateKasmStreamPassword` named identically where referenced. ✓
