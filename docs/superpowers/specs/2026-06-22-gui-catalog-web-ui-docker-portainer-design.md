# Spec: GUI catalog — web-UI tier + Docker (Portainer)

- **Date:** 2026-06-22
- **Status:** Approved design (with two scope adjustments noted below) — pending user review
- **Branch:** `feat/docker-sysbox-engine`
- **Sub-project 2 of 3** in the "Docker + dev tools in programs" effort. This spec covers the
  **web-UI tool tier** + the **first tool (Docker / Portainer)**. The KasmVNC-desktop tier (Postman)
  and further tools (pgAdmin, code-server, …) are follow-on specs.

## Problem / Goal

Expand the programs catalog with real dev tools. "GUI tools" split into two tiers:

| Tier | Recipe | Image | Renders as |
| --- | --- | --- | --- |
| **Web-UI** (this spec) | `container`, no `webGui` | official upstream image | the tool's web port in the **App-tab iframe** |
| **KasmVNC desktop** (later) | `container` + `webGui:true` | custom `gui-base` image | streamed desktop |

The first web-UI tool is **Docker management via Portainer CE**: a free, ~250 MB web GUI that connects
to the per-workspace runtime's `dockerd` over its socket and manages exactly that workspace's
containers/images/volumes (contained by Sysbox isolation). Docker Desktop was rejected — it needs
nested virtualization Sysbox doesn't grant, carries a per-user commercial license, and would manage
its own inner engine rather than the workspace's.

## Design

### 1. Portainer recipe (`@vectant/portainer`)

New entry in `synthi/src/lib/programs/defaultPrograms.js`, env-driven like DBeaver:

```js
const PORTAINER_IMAGE = process.env.VECTANT_PORTAINER_IMAGE || 'portainer/portainer-ce:lts';
const PORTAINER_PORT = Number(process.env.VECTANT_PORTAINER_PORT) || 9000;
// recipe:
{
  packageId: 'portainer', version: '1.0.0',
  displayName: 'Portainer (Docker)',
  description: 'Portainer CE — manage your workspace’s Docker containers, images and volumes.',
  runtimeType: 'container',           // NOT webGui — renders as a plain web iframe
  install: [],
  launch: `docker run --rm --name vectant-portainer -p ${PORTAINER_PORT}:9000 `
        + `-v /var/run/docker.sock:/var/run/docker.sock `
        + `-v "$PWD/.vectant/portainer":/data ${PORTAINER_IMAGE} --no-csp`,
  ports: [PORTAINER_PORT],
  permissions: ['program.launch', 'network.outbound', 'ports.expose'],
}
```

- **Socket:** `-v /var/run/docker.sock:/var/run/docker.sock` — the runtime's rootful `dockerd` socket
  (prod Sysbox pod). NOTE: the local hybrid runtime runs **rootless** docker, so its socket path
  differs; the local e2e step must resolve the actual socket (or run via the rootless path). This is
  a local-testing detail, not a prod concern.
- **Persistence (user choice):** `/data` → `/workspace/.vectant/portainer`, so the admin account and
  saved connections survive relaunch. `$PWD` is the workspace dir (the runtime sets it), matching
  DBeaver's `-v "$PWD":/workspace` convention; Docker creates the bind source dir if absent.
- **`--no-csp`:** Portainer's default Content-Security-Policy would block embedding; disabling it lets
  the App-tab iframe (same collab origin via the proxy) load it.
- **Auth:** on first launch Portainer prompts to create the admin account; because `/data` persists,
  that is a one-time setup and the user's chosen password is "known" + persisted. Pre-seeding a fixed
  admin password is possible (`--admin-password-file`) but deferred — smooth auto-auth is the separate
  credential-hand-off slice.

### 2. Proxy framing-allow (`containerPortProxy`)

Web UIs commonly send `X-Frame-Options: DENY/SAMEORIGIN`, which blocks the App-tab iframe. The
`/wsport/*` proxy is already the workspace-access boundary, so it is safe to **strip framing
restrictions** there. Extract the response-header construction in `proxyHttp` into a pure,
unit-testable helper and add the strip:

```js
// backend/collab-server/containerPortProxy.js
function buildProxyResponseHeaders(upstreamHeaders) {
  const headers = { ...upstreamHeaders };
  delete headers['x-frame-options'];           // allow embedding in the App tab
  return {
    ...headers,
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'cross-origin-embedder-policy': 'credentialless',
  };
}
```

`proxyHttp` calls `res.writeHead(up.statusCode, buildProxyResponseHeaders(up.headers))`. This benefits
every web-UI tool, not just Portainer. (CSP `frame-ancestors` from upstream is handled per-tool via
`--no-csp`-style flags; the proxy does not rewrite CSP in this slice.)

### 3. No custom image

The web-UI tier runs the official `portainer/portainer-ce` image (prod pins a digest in Artifact
Registry, like DBeaver). No `gui-base` build here. The desktop tier's custom image arrives with Postman.

## Scope adjustments vs. the presented design (please confirm)

1. **`vncPath` gating is deferred, not done here.** The presented design said we'd gate the App tab's
   `vncPath` to `webGui`-only so web UIs get a clean URL. On investigation, `webGui` is **not surfaced
   to the frontend session** (`mergeProgramSession` drops it), and surfacing it would also activate the
   currently-dead `webGui→floating` branch — flipping DBeaver from docked to floating, an unrelated UX
   change. The `?path=…&resize=scale` params noVNC reads are **harmless query params a web SPA like
   Portainer ignores**, so Portainer renders correctly without the gate. Gating `vncPath` (and properly
   surfacing `webGui`) is logged as a separate small cleanup. The local e2e step will confirm Portainer
   renders with the params present.
2. **Admin auth via first-launch setup + persistence** (above) rather than an injected password.

## Out of scope / non-goals

- KasmVNC-desktop tier / custom images (Postman next).
- `webGui` surfacing + `vncPath` gating + the floating-window behavior (separate cleanup).
- Credential hand-off (auto-auth), the visual-GUI-driving MCP slice.
- pgAdmin / code-server / other web tools (follow-on increments on this same tier).

## Testing

- **Recipe (vitest, `defaultPrograms.test.js`):** `@vectant/portainer` is present, is a `container`
  program with `webGui` false, declares port `9000`, and round-trips through `parseProgramManifest`
  without error (validates the launch string + scopes).
- **Proxy (node:test, new `containerPortProxy` test):** `buildProxyResponseHeaders({'x-frame-options':'DENY', 'content-type':'text/html'})`
  drops `x-frame-options`, preserves `content-type`, and sets the COEP/CORP/ACAO trio.
- **Live e2e (local):** launch Portainer from the Programs panel → App tab loads the Portainer web UI →
  create admin → it lists the workspace's running containers (proving socket access). Relaunch →
  admin persists (proving `/data` persistence).

## Risks

- **docker.sock path (local):** rootless-vs-rootful socket location differs locally; resolve in the
  e2e step. Prod (`/var/run/docker.sock`) is correct.
- **Portainer iframe headers:** if Portainer with `--no-csp` still emits something that blocks framing
  beyond `X-Frame-Options`, the e2e will catch it; the proxy helper is the place to extend.
- Low blast radius: the proxy change only strips a header on the already-gated `/wsport` path; the
  recipe is additive.
