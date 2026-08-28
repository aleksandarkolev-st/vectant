# GUI Catalog: Web-UI Tier + Docker (Portainer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Docker management to the programs catalog as `@vectant/portainer` — a web-UI container program whose Portainer web UI renders in the App-tab iframe and manages the workspace runtime's Docker.

**Architecture:** Web-UI tools are `container` recipes (no `webGui`) running an official upstream image; their web port is served through the existing `containerPortProxy` into the App-tab iframe. Two code changes: (1) the proxy strips `X-Frame-Options` so web UIs can be framed; (2) a new Portainer recipe (socket mount + `/data` persisted to `/workspace`). No custom image (official `portainer/portainer-ce`).

**Tech Stack:** Node `containerPortProxy` (collab-server, `node:test`), `defaultPrograms.js` recipe catalog (Vitest), Docker.

**Spec:** `docs/superpowers/specs/2026-06-22-gui-catalog-web-ui-docker-portainer-design.md`

**Conventions:** Backend tests run from repo root: `node --test --test-timeout=60000 <file>`. Frontend tests run from `synthi/` in a subshell: `(cd synthi && npx vitest run <path>)`.

---

## File Structure

- **Modify** `backend/collab-server/containerPortProxy.js` — extract a pure `buildProxyResponseHeaders(upstreamHeaders)` (adds COEP/CORP/ACAO, strips `x-frame-options`); `proxyHttp` uses it; export it.
- **Modify** `backend/collab-server/__tests__/containerPortProxy.test.js` — unit test for the new helper.
- **Modify** `synthi/src/lib/programs/defaultPrograms.js` — add the `@vectant/portainer` recipe (+ env-driven image/port consts).
- **Modify** `synthi/src/lib/programs/__tests__/defaultPrograms.test.js` — bump the catalog count `8`→`9` and add a Portainer assertion.

---

## Task 1: Proxy strips X-Frame-Options so web UIs can be framed

**Files:**
- Modify: `backend/collab-server/containerPortProxy.js`
- Test: `backend/collab-server/__tests__/containerPortProxy.test.js`

- [ ] **Step 1: Write the failing test**

In `backend/collab-server/__tests__/containerPortProxy.test.js`, change the `require` on line 5 to include the new export, then add the test after the `parseWsPortUrl` tests:

```js
const { parseWsPortUrl, createContainerPortProxy, buildProxyResponseHeaders } = require('../containerPortProxy');
```

```js
test('buildProxyResponseHeaders strips X-Frame-Options and sets embed headers', () => {
  const out = buildProxyResponseHeaders({ 'x-frame-options': 'DENY', 'content-type': 'text/html' });
  assert.equal(out['x-frame-options'], undefined);          // stripped so the App tab can iframe it
  assert.equal(out['content-type'], 'text/html');           // unrelated headers preserved
  assert.equal(out['cross-origin-embedder-policy'], 'credentialless');
  assert.equal(out['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(out['access-control-allow-origin'], '*');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-timeout=60000 backend/collab-server/__tests__/containerPortProxy.test.js`
Expected: FAIL — `buildProxyResponseHeaders is not a function` (not exported yet).

- [ ] **Step 3: Write minimal implementation**

In `backend/collab-server/containerPortProxy.js`, add this function at module scope (e.g. directly above `function createContainerPortProxy`):

```js
/**
 * Response headers for a proxied /wsport response. The App-tab iframe embeds
 * these under the IDE's COEP, so assert an embedder policy + make the resource
 * shareable. Strip X-Frame-Options so web UIs (Portainer, pgAdmin, …) can render
 * in the iframe — the /wsport proxy is already the workspace-access boundary.
 */
function buildProxyResponseHeaders(upstreamHeaders = {}) {
  const headers = { ...upstreamHeaders };
  delete headers['x-frame-options'];
  return {
    ...headers,
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'cross-origin-embedder-policy': 'credentialless',
  };
}
```

Replace the inline header block inside `proxyHttp` (the `const headers = { ...up.headers, 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin', 'cross-origin-embedder-policy': 'credentialless' };` then `res.writeHead(up.statusCode, headers);`, including its preceding comment) with:

```js
      res.writeHead(up.statusCode, buildProxyResponseHeaders(up.headers));
```

Update the exports line at the bottom of the file:

```js
module.exports = { parseWsPortUrl, createContainerPortProxy, buildProxyResponseHeaders };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-timeout=60000 backend/collab-server/__tests__/containerPortProxy.test.js`
Expected: PASS — all tests green (the new unit test + the existing `parseWsPortUrl`/`proxyHttp` integration tests, which still see COEP/CORP because `proxyHttp` now calls the helper).

- [ ] **Step 5: Commit**

```bash
git add backend/collab-server/containerPortProxy.js backend/collab-server/__tests__/containerPortProxy.test.js
git commit -F - <<'MSG'
feat(proxy): strip X-Frame-Options on /wsport so web UIs embed in the App tab

Extract buildProxyResponseHeaders (COEP/CORP/ACAO + X-Frame-Options strip) so
web-UI container programs (Portainer, pgAdmin, ...) render in the App-tab iframe.
The /wsport proxy is already the workspace-access boundary.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
```

---

## Task 2: `@vectant/portainer` recipe

**Files:**
- Modify: `synthi/src/lib/programs/defaultPrograms.js`
- Test: `synthi/src/lib/programs/__tests__/defaultPrograms.test.js`

- [ ] **Step 1: Write the failing test**

In `synthi/src/lib/programs/__tests__/defaultPrograms.test.js`:

(a) Bump the catalog count from 8 to 9 in all four places:
- line 10: `expect(built.length).toBe(9);`
- line 80: `expect(seeded.length).toBe(9);`
- line 81: `expect(prisma.marketplaceProgram.upsert).toHaveBeenCalledTimes(9);`
- line 82: `expect(prisma.programVersion.upsert).toHaveBeenCalledTimes(9);`

(b) Add this test after the `@vectant/dbeaver` test (after line 40):

```js
  it('ships @vectant/portainer as a web-UI container program (Docker GUI)', () => {
    const portainer = built.find((b) => b.packageId === '@vectant/portainer').config;
    expect(portainer.runtimeType).toBe('container');
    expect(portainer.webGui).toBe(false); // web-UI tier: plain iframe, not KasmVNC
    expect(portainer.ports).toEqual([9000]);
    expect(portainer.launch).toMatch(/^docker run .*-p 9000:9000/);
    expect(portainer.launch).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(portainer.launch).toContain('-v "$PWD/.vectant/portainer":/data');
    expect(portainer.launch).toContain('--no-csp');
    expect(portainer.permissions).toContain('ports.expose');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd synthi && npx vitest run src/lib/programs/__tests__/defaultPrograms.test.js)`
Expected: FAIL — the count assertions fail (still 8) and `built.find(... '@vectant/portainer')` is `undefined` (recipe missing → `Cannot read properties of undefined`).

- [ ] **Step 3: Write minimal implementation**

In `synthi/src/lib/programs/defaultPrograms.js`, add these consts next to the DBeaver ones (after the `DBEAVER_PORT` line, ~line 22):

```js
// Web-UI tier (Docker GUI): the official Portainer CE image. Env-driven so prod
// pins a digest in Artifact Registry; defaults to the upstream LTS tag.
const PORTAINER_IMAGE = process.env.VECTANT_PORTAINER_IMAGE || 'portainer/portainer-ce:lts';
const PORTAINER_PORT = Number(process.env.VECTANT_PORTAINER_PORT) || 9000;
```

Add this recipe object to the `DEFAULT_PROGRAM_RECIPES` array, immediately after the `dbeaver` entry (after its closing `},` ~line 118) and before the `devcontainer` entry:

```js
  {
    name: 'portainer',
    kind: 'manifest',
    recipe: {
      packageId: 'portainer', version: '1.0.0',
      displayName: 'Portainer (Docker)',
      description: 'Portainer CE - manage the Docker containers, images and volumes in your workspace via a web UI.',
      // Web-UI tier: a container program with NO webGui. Its web port is served
      // into the App-tab iframe by the container port proxy. Mounts the runtime's
      // docker socket to manage the workspace's own dockerd (contained by Sysbox);
      // --no-csp lets Portainer be framed; /data persists to /workspace so the
      // admin account + saved connections survive relaunch.
      runtimeType: 'container',
      install: [],
      launch: `docker run --rm --name vectant-portainer -p ${PORTAINER_PORT}:9000 -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/.vectant/portainer":/data ${PORTAINER_IMAGE} --no-csp`,
      ports: [PORTAINER_PORT],
      permissions: ['program.launch', 'network.outbound', 'ports.expose'],
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd synthi && npx vitest run src/lib/programs/__tests__/defaultPrograms.test.js)`
Expected: PASS — all assertions green (count now 9; the Portainer recipe round-trips through `parseProgramManifest` via `buildDefaultPrograms`, and the per-recipe validity loop accepts it).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/lib/programs/defaultPrograms.js synthi/src/lib/programs/__tests__/defaultPrograms.test.js
git commit -F - <<'MSG'
feat(programs): add @vectant/portainer (Docker management web GUI)

Web-UI tier program: Portainer CE in a container, web UI in the App tab,
mounts the runtime's docker socket, /data persisted to /workspace. Env-driven
image/port. Docker Desktop rejected (nested-virt + licensing); see spec.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
```

---

## Task 3: Live e2e (local, manual verification)

**Files:** none (verification only). This step needs the local stack and a built/pulled Portainer image; it is interactive, like the DBeaver bring-up.

- [ ] **Step 1: Rebuild the changed services + re-seed the catalog**

The proxy change is in collab-server; the recipe is seeded by `ensureDefaultPrograms`. Rebuild collab-server and frontend, bring them up, then re-seed defaults (so `@vectant/portainer` appears in the marketplace). Use the existing local bring-up flow (`docker compose build collab-server frontend` from the repo root → `docker compose up -d` → run the seed).

- [ ] **Step 2: Resolve the docker.sock path for the local rootless runtime**

The recipe mounts `/var/run/docker.sock` (correct for the prod Sysbox pod's rootful dockerd). The **local hybrid** runtime runs **rootless** docker, so its socket is elsewhere (e.g. `/run/user/<uid>/docker.sock` or via `DOCKER_HOST`). Before the live launch, exec into the runtime container and confirm the socket path:
`docker exec --user rootless <runtime> sh -c 'echo $DOCKER_HOST; ls -la /var/run/docker.sock /run/user/*/docker.sock 2>/dev/null'`
If it differs, override the recipe locally (e.g. set `VECTANT_PORTAINER_IMAGE` is unrelated; for the socket, temporarily edit the local DB manifest's launch to the rootless socket path, the same way the DBeaver password was patched). Document the resolved path; prod stays `/var/run/docker.sock`.

- [ ] **Step 3: Install + launch Portainer from the Programs panel**

In the workspace Programs panel: install `@vectant/portainer` (Marketplace → Install), then Launch. Open the **App** tab.

- [ ] **Step 4: Verify**

Confirm, in order:
1. The App tab renders Portainer's web UI in the iframe (proves `X-Frame-Options` strip + `--no-csp` + the `?path=…&resize=scale` params are harmless to the web SPA — the deferred `vncPath` gate is not needed).
2. Create the admin account; Portainer's container list shows the workspace's running containers (proves docker-socket access).
3. Stop + relaunch Portainer → the admin account persists, no re-setup (proves `/data` → `/workspace/.vectant/portainer` persistence).

If (1) fails with a blank/blocked frame, capture the response headers for `/wsport/<slug>/9000/` (look for a residual framing/CSP header) and extend `buildProxyResponseHeaders` accordingly. If (2) fails, it's the socket path (Step 2).

---

## Self-Review

**Spec coverage:**
- Portainer recipe (image/port/socket/`/data`/`--no-csp`/scopes) → Task 2. ✓
- Proxy framing-allow (strip X-Frame-Options, extract testable helper) → Task 1. ✓
- No custom image (official Portainer) → Task 2 uses `portainer/portainer-ce`. ✓
- Persistence to `/workspace/.vectant/portainer` → Task 2 launch + Task 3 verify. ✓
- Auth via first-launch + persist → Task 3 verify (no code). ✓
- `vncPath` gating deferred → not a task; Task 3 Step 4 confirms it's unnecessary. ✓
- docker.sock local wrinkle → Task 3 Step 2. ✓
- Tests (recipe validity + proxy header strip) → Tasks 1–2. ✓

**Placeholder scan:** No TBD/TODO; all code/commands concrete. Task 3 is intentionally a manual verification procedure (needs the live stack), with exact checks. ✓

**Type/name consistency:** `buildProxyResponseHeaders` defined + exported (Task 1) and asserted by name (Task 1 test); `PORTAINER_IMAGE`/`PORTAINER_PORT` defined and used in the same recipe (Task 2); `@vectant/portainer` packageId matches the `name: 'portainer'` entry via `buildDefaultPrograms`'s `@vectant/${name}` prefix; count `9` consistent across the four updated assertions. ✓
