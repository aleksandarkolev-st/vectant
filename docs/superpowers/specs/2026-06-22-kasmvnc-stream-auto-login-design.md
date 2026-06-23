# KasmVNC stream auto-login (per-session injected credentials) — design

**Date:** 2026-06-22
**Branch:** `feat/docker-sysbox-engine`
**Status:** approved design, ready for implementation plan

## Problem

KasmVNC-desktop-tier programs (`@vectant/dbeaver`, `@vectant/postman` — `runtimeType:'container'` + `webGui:true`, built on `backend/gui-images/gui-base`) stream into the App tab over noVNC. The gui-base entrypoint protects the stream with **HTTP Basic auth** — confirmed live:

```
GET /            → 401  WWW-Authenticate: Basic realm="Websockify"
GET / (vectant:<pw>) → 200    (same for /vnc.html and the /websockify WS)
```

The App tab is a **cross-origin, COEP-credentialless iframe**, and Chrome **suppresses the Basic-auth dialog** in that context. So the user can't authenticate → blank stream. Today the only workaround is a manual per-session `kasmvncpasswd` reset, which the user must redo every launch.

**Goal:** launching DBeaver/Postman opens the stream with **zero** credential entry, while every session keeps a **unique random** password (no shared/static secret anywhere). The browser never handles the credential.

## Chosen posture

Per-session **random** password, **proxy-injected** (user-selected over a shared default and over disabling auth). Each session gets a unique random KasmVNC password; the collab proxy — already the workspace-access boundary — injects the matching `Authorization: Basic` header on the user's behalf. No shared secret exists, and the credential never reaches the browser, so there is no cross-origin prompt to suppress.

## Architecture / data flow (all server-side, in collab-server)

```
launchManagedSession (webGui + runtimeType==='container')      containerPortProxy (/wsport/<slug>/<port>/…)
  • generate random pw  [A-Za-z0-9], ~24 chars                   • resolveStreamAuth(slug, port)
  • inject into the launched container as KASM_PASSWORD            •    → { user:'vectant', password } | null
  • record { user:'vectant', password } on the session record    • on HTTP request AND WS upgrade:
        (keyed by slug + port for lookup)                        •    if cred && no incoming Authorization header:
  ▼                                                              ▼       set Authorization: Basic base64(user:pw)
KasmVNC uses that pw  ───────────────────────────────────────►  KasmVNC sees valid auth → 200, stream loads
```

The proxy and the program runtime manager run in the **same collab-server process**, so the lookup is an in-memory call — no shared store, no DB, no Redis.

## Components

### 1. `programRuntimeManager.js` — generate, inject, store, expose
- In `launchManagedSession`, when `webGui === true && runtimeType === 'container'`:
  - Generate `password` from a shell-safe alphabet (`[A-Za-z0-9]`, ~24 chars — matches the gui-base entrypoint's own generator) using `crypto`.
  - **Inject** it into the launched container as `KASM_PASSWORD`. The recommended vector is **env passthrough**: set `KASM_PASSWORD` on the `env` handed to `launchRuntime` and have the recipe declare `-e KASM_PASSWORD` (passthrough form) — the pod path already exports env into the `bash -lc` script (`buildRuntimeShellScript`); **verify `execInRuntime` exports env the same way** before relying on it. If it does not, fall back to splicing a literal `-e KASM_PASSWORD=<pw>` into the `docker run` command (backend-agnostic; note the password then appears in the container's argv/server logs, a minor server-side exposure).
  - Store `{ user: 'vectant', password }` on the managed session record (e.g. `record.kasmAuth`). Regenerated on every launch, so `restartManagedSession` naturally rotates it. Gone when the record is dropped/stopped.
- Add `resolveStreamAuth(slug, port)` to the manager's public API: return the `kasmAuth` of the running `webGui` session whose `workspaceSlug === slug` and whose declared/active ports include `port`; else `null`.
- `user` is the gui-base default (`KASM_VNC_USER` → `vectant`); keep it a single source of truth.

### 2. `containerPortProxy.js` — inject the header
- Accept a new `resolveStreamAuth(slug, port)` option (alongside `resolveHost`).
- In `proxyHttp` **and** `proxyWsUpgrade`: after parsing `{slug, port}`, call `resolveStreamAuth`. If it returns a credential **and** the incoming request has no `authorization` header, add `Authorization: Basic base64(`${user}:${password}`)` to the forwarded headers. Otherwise forward unchanged (so a real future auth flow is never clobbered).
- Keep the existing `buildProxyResponseHeaders` behavior unchanged.

### 3. `server.js` — wire it
- Pass `resolveStreamAuth: (slug, port) => managedProgramRuntime.resolveStreamAuth(slug, port)` into `createContainerPortProxy(...)`, mirroring how `resolveHost` is wired.

### 4. Recipes (only if env-passthrough is chosen)
- Add `-e KASM_PASSWORD` (passthrough, **no value**) to the `@vectant/dbeaver` and `@vectant/postman` launch strings in `defaultPrograms.js`. No value is committed — the value is the per-session random the manager injects. (If the literal-splice vector is chosen instead, no recipe change is needed.)

## Behavior guarantees

1. **Scoped** — only `webGui` container sessions get a credential. The web-UI tier (`@vectant/portainer`, `runtimeType:'container'` + no `webGui`) has no `kasmAuth` → `resolveStreamAuth` returns `null` → the proxy injects nothing → Portainer is unaffected.
2. **Per-port** — keyed by `slug` + `port`, so DBeaver (6901) and Postman (6902) running in the same workspace each resolve their own credential.
3. **Lifecycle** — credential lives only on the in-memory session record; never persisted, never logged to the user-facing surface beyond what gui-base already echoes; regenerated on restart; gone on stop.
4. **Non-clobbering** — injection only fills an absent `Authorization`; an explicit incoming header always wins.

## Testing (TDD, red→green)

- `containerPortProxy.test.js`: with a stub `resolveStreamAuth`, assert `proxyHttp` and `proxyWsUpgrade` set `Authorization: Basic …` when a cred is returned and absent; do **not** set/override it when the resolver returns `null` or when the request already has an `authorization` header. Use the existing proxy test harness (mock upstream).
- `programRuntimeManager.test.js`: launching a `webGui` container session generates a `kasmAuth`, makes it resolvable via `resolveStreamAuth(slug, port)` by the declared port, and a non-`webGui` (or non-container) session yields `null`; a stopped session no longer resolves.
- `defaultPrograms.test.js` (only if env-passthrough chosen): assert the dbeaver/postman launch contains `-e KASM_PASSWORD` (passthrough, no inline value).
- Keep the full `synthi` programs lib suite + the collab-server proxy/manager suites green.

## Out of scope

- Portainer / web-UI tier (no change).
- Prod secret management — per-session random needs none.
- Any browser-side credential handling — deliberately avoided.

## Verification (live)

Division of labor (established this session): the **user** rebuilds + runs frontend and collab-server; the **assistant** preps the runtime (build/load images, seed catalog) and resolves local-runtime specifics. After collab-server carries this change, launching DBeaver and Postman in the workspace should open their App-tab streams with **no** password prompt, and both should still scale-to-fit (`ScaleToFitFrame`).
