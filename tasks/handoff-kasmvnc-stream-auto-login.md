# Handoff — implement KasmVNC stream auto-login (per-session injected credentials)

> Paste everything below the line into a fresh Opus 4.8 / Claude Code chat opened on
> `C:\Users\HP\source\repos\synthi-ide`. It is self-contained.

---

You are continuing work on **synthi / Vectant** (a Next.js web-IDE + Node collab-server + Rust worker + Python AI engine; GKE Sysbox pods in prod, a local hybrid rootless-Docker runtime for dev). Your task is one focused feature. Work carefully, plan-first, TDD.

## 0. Mission

Implement **per-session auto-login for KasmVNC desktop-tier programs** (`@vectant/dbeaver`, `@vectant/postman`) so their App-tab streams open with **zero** password entry, while each session keeps a **unique random** password (no shared secret). The full, approved design is committed at:

```
docs/superpowers/specs/2026-06-22-kasmvnc-stream-auto-login-design.md
```

**Read that spec first** — it is the source of truth. This prompt adds guardrails, environment context, and the hard-won gotchas you need so you don't rediscover them.

Start by using the **superpowers `writing-plans`** skill to turn the spec into a step-by-step implementation plan, then execute it with **TDD** (red→green, one commit per task). Use plan mode for non-trivial steps (project CLAUDE.md mandates it).

## 1. SECURITY & PROCESS GUARDRAILS (non-negotiable)

- **Branch:** work ONLY on `feat/docker-sysbox-engine`. **Never** push to `main`/`dev` or any remote without explicit user approval. (Nothing has been pushed this work-stream.)
- **Staging:** stage **specific files explicitly**. NEVER `git add -A` or `git add .`.
- **Do NOT commit** `synthi/Dockerfile` — it carries a local npm tweak; leave it modified/unstaged.
- **Do NOT commit** (local-only): `docker-compose.override.yml`, `memory/`, `tasks/*.md` (runbooks/handoffs/lessons-runbooks), and any temporary `**/_seed_*.test.js` or scratch files you create. Delete temp files when done.
- **Commit messages** end with a trailing line `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Use `git commit -F -` with a heredoc (never inline `-m` for multi-line).
- **Program isolation:** a program container may mount ONLY its own `/workspace` (via `workspaceMountFlags()` → `-v "$PWD":/workspace -w /workspace`). Never mount host paths or another workspace's docker socket.
- **Secrets:** never bake a password into an image or commit one. The per-session password is generated at runtime and lives only in memory.
- **Self-improvement:** after any user correction, append the pattern to `tasks/lessons.md` (it is a rich, real file — read it).

## 2. What you're changing (4 touch points, all in collab-server)

Per the spec:
1. `backend/collab-server/programRuntimeManager.js` — in `launchManagedSession`, for `webGui===true && runtimeType==='container'`: generate a random `[A-Za-z0-9]` ~24-char password, inject it into the launched container as `KASM_PASSWORD`, store `{user:'vectant', password}` on the session record, and expose `resolveStreamAuth(slug, port)`.
2. `backend/collab-server/containerPortProxy.js` — add a `resolveStreamAuth(slug, port)` option; in **both** `proxyHttp` and `proxyWsUpgrade`, inject `Authorization: Basic base64(user:pw)` into the forwarded request when a cred exists AND the incoming request has no `authorization` header.
3. `backend/collab-server/server.js` — wire `resolveStreamAuth` into `createContainerPortProxy(...)`, mirroring the existing `resolveHost` wiring (~line 128).
4. `synthi/src/lib/programs/defaultPrograms.js` — **only if** you choose the env-passthrough injection vector: add `-e KASM_PASSWORD` (passthrough, no value) to the dbeaver + postman launch strings, and bump `defaultPrograms.test.js` accordingly.

**Open implementation decision (resolve in your plan):** how the generated password reaches the container.
- **env passthrough (cleaner, keeps pw out of argv):** set `KASM_PASSWORD` on the `env` passed to `launchRuntime`; recipe declares `-e KASM_PASSWORD`. The pod path (`createRuntimePodProgram` → `buildRuntimeShellScript`) exports env before the command, so passthrough works there. **You MUST verify `workspaceRuntime.execInRuntime` (local hybrid path, `backend/collab-server/workspaceRuntimeContainer.js`) exports env the same way** before relying on this.
- **literal splice (backend-agnostic fallback):** splice `-e KASM_PASSWORD=<pw>` into the `docker run` command for webGui-container launches; no recipe change. Downside: pw appears in argv/server logs (minor server-side exposure).

The env scrubber `buildManagedRuntimeEnv` (same file) blocks `DOCKER_HOST`/`DATABASE_*`/secrets but **not** `KASM_PASSWORD`, so passthrough survives the scrub.

## 3. How the pieces fit (verified this session)

- KasmVNC gates on **HTTP Basic auth** — confirmed live: `GET /` → `401 WWW-Authenticate: Basic realm="Websockify"`; with `-u vectant:<pw>` → `200` (same for `/vnc.html` and the `/websockify` WS). The App tab is a cross-origin COEP-credentialless iframe, and Chrome suppresses the Basic dialog there → blank stream. That is the whole reason for this feature, and it's why a noVNC `?password=` param can't help (the gate is *before* noVNC loads).
- The **gui-base entrypoint** (`backend/gui-images/gui-base/entrypoint.sh`) already generates a random password (or uses `KASM_PASSWORD` if set), writes `~/.kasmpasswd` via `kasmvncpasswd -u "$KASM_VNC_USER" -rwo`, and echoes `[gui-base] KasmVNC user=… password=… port=…`. Default user is `vectant`.
- **Proxy** (`containerPortProxy.js`): `/wsport/<slug>/<port>/…` → `resolveHost(slug)` → runtime container host:port. It forwards `req.headers` unchanged (no auth injection today). Lives in the **same process** as the program runtime manager, so `resolveStreamAuth` is an in-memory call.
- **Two GUI tiers:** web-UI (`container`, **no** `webGui`, official image, plain App-tab iframe — Portainer) vs KasmVNC-desktop (`container` + `webGui`, custom gui-base image, noVNC stream — DBeaver, Postman). Only the latter gets a credential; Portainer must stay untouched (its `resolveStreamAuth` returns `null`).
- **Per-port matters:** DBeaver streams on 6901, Postman on 6902 (`-e KASM_PORT=6902`), so both can run in one workspace — `resolveStreamAuth(slug, port)` must match on port.

## 4. Current repo state (this work-stream's commits, newest last)

```
5ed7d7928 feat(programs): scale-to-fit App tab for all container GUI programs
c25dabddf feat(programs): add @vectant/postman (API client, KasmVNC desktop tier)
1e049c94c docs(plan): design spec for KasmVNC stream auto-login (per-session injected creds)
```
- `git status` should show only `synthi/Dockerfile` modified (leave it) + untracked local-only files (`docker-compose.override.yml`, `memory/`, `tasks/*.md`).
- Postman shipped: `backend/gui-images/postman/Dockerfile`, the `@vectant/postman` recipe in `defaultPrograms.js`, tests (catalog is 10 programs). The image `vectant-postman:dev` is built and already **loaded into the `workspace-runtime-rfxr7ism-132448520` runtime**, and `@vectant/postman` is **seeded into the local DB** (targeted upsert — Portainer's local socket patch preserved). `vectant-dbeaver:dev` is also present in that runtime.

## 5. ENVIRONMENT GOTCHAS (Windows + Docker Desktop + this stack)

These cost real time this session — honor them:

1. **cwd leaks across Bash calls.** A bare `cd synthi` in one Bash call persists into the next, so later `git`/`docker` run from the wrong dir. Run git/docker from the **repo root**; for vitest use a subshell: `(cd synthi && npx vitest run <path>)`.
2. **Run builds from repo root.** `docker compose` from inside `synthi/` reads `synthi/.env` (which has bare header lines) and fails (`key cannot contain a space`). The local `docker-compose.override.yml` points Prisma at `postgres:5432` and sets `NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS=1`; `NEXT_PUBLIC_*` must be set at **build** time.
3. **Postgres is NOT published to the host.** `localhost:5432` is unreachable; the frontend reaches it in-network as `postgres:5432`. To run SQL, `docker cp x.sql synthi-ide-postgres-1:/tmp/` then `docker exec synthi-ide-postgres-1 psql -U synthi -d synthi -f /tmp/x.sql`. PowerShell `psql -c "...\"Table\"..."` mangles quoted identifiers — **always use a `.sql` file with `-f`**.
4. **Prisma raw SQL:** tables are PascalCase-quoted (`"MarketplaceProgram"`, `"ProgramVersion"`), no `@@map`. `id` (`cuid()`) and `updatedAt` (`@updatedAt`) are app-managed → provide them explicitly (`now()`, a unique text id) in raw inserts. No local auto-migrate; if a merge adds migrations, `prisma db push` (not `migrate deploy`) — see lessons.md #40.
5. **No startup auto-seed.** `ensureDefaultPrograms` runs only via the auth-gated seed-defaults route. A **full reseed CLOBBERS** the local Portainer socket patch (rewrites every manifest). To add/patch one program locally, do a **targeted** upsert, never a full reseed.
6. **vitest swallows `console.log`** in `run` mode. To capture generated output (e.g. a manifest), `writeFileSync` it to a temp path and `Read` that file.
7. **Loading a local image into a workspace runtime:** each runtime has its **own inner dockerd** (DinD under Sysbox/rootless; `DOCKER_HOST=unix:///run/user/1000/docker.sock` locally, `/var/run/docker.sock` in prod). Local-only `vectant-*:dev` images aren't on any registry, so push them in with **file-based** save/load (the PowerShell `docker save | docker load` **pipe corrupts the stream**): `docker save img -o f.tar` → `docker cp f.tar <runtime>:/tmp/` → `docker exec <runtime> docker load -i /tmp/f.tar`. Removing the leftover tar in the runtime's rootless `/tmp` needs `docker exec -u 0`.
8. **Git Bash mangles absolute Unix paths** (`/run/user/1000/...`, `/tmp/...` → `C:/Program Files/Git/...`). Use **PowerShell** for `docker exec`/`cp` with container paths, or prefix `MSYS_NO_PATHCONV=1`.
9. **BuildKit `EOF` under memory pressure.** The Next.js frontend compile is the RAM hog; if a build dies with `rpc error … EOF`, **stop non-essential containers to free RAM** and retry. More broadly, Docker Desktop here is fragile under RAM/disk pressure — see lessons.md #19/#27/#28/#35.
10. **Frontend + collab-server are run by the USER**, not by you (they won't appear in your `docker ps`). That's the live-test division of labor.
11. **Scoped collab-server tests only:** `node --test --test-timeout=20000 backend/collab-server/__tests__/*.test.js` from repo root (bare `node --test` hangs on handle-leaking discovery — lessons.md #21). The proxy/manager suites are `node:test`.

Also skim `tasks/lessons.md` — especially **#32** (KasmVNC kiosk build/run gotchas), **#30/#31** (runtime routing: only `runtimeType:'container'` hits the sysbox-pod/hybrid docker path; headless has DOCKER_HOST scrubbed), and **#34/#41** (dind-under-sysbox, userns proof).

## 6. Verification / Definition of Done

- New unit tests written **first** (red), then green:
  - `containerPortProxy.test.js`: injects `Authorization: Basic` on HTTP **and** WS when a cred is returned & absent; does NOT inject when resolver returns `null` or when the request already has `authorization`.
  - `programRuntimeManager.test.js`: a `webGui` container launch produces a `kasmAuth` resolvable by `resolveStreamAuth(slug, port)`; non-webGui/non-container → `null`; stopped session → no longer resolves.
  - `defaultPrograms.test.js` (only if env-passthrough chosen): dbeaver/postman launch contains `-e KASM_PASSWORD` passthrough.
- Full `synthi` programs lib suite green: `(cd synthi && npx vitest run src/lib/programs)`. Collab-server suite green (scoped command above).
- Commit per task, guardrail-compliant messages, only the intended files staged.
- **Do not claim done without showing the test output.** (Project rule: evidence before assertions.)

## 7. Live test (hand back to the user)

You prep, the user verifies. After collab-server carries the change (the **user** rebuilds + runs frontend and collab), launching DBeaver and Postman in their workspace must open the App-tab streams **with no password prompt**, and both must still scale-to-fit. If you need an image (re)loaded into a runtime or the catalog (re)seeded, do that per §5.7 / §5.5 and tell the user exactly what to click. Give a 1–2 sentence plain-words recap when the implementation is done.
