# Native Docker Execution — Phase 1 (dev vertical slice)

**Date:** 2026-06-09
**Status:** Approved design direction, pending implementation plan
**Builds on:** `docs/superpowers/specs/2026-06-01-workspace-program-runtime-design.md` (Program Runtime &
Marketplace) and `docs/superpowers/specs/2026-06-09-make-default-programs-runnable-design.md`.
**Realizes the deferred backlog item:** "native container execution" called out in
`synthi/src/lib/programs/defaultPrograms.js` and `tasks/todo.md`. The `@vectant/devcontainer` default
program and the program runtime were intentionally shipped *without* real container execution; this
slice adds it.

---

## Context

Programs today launch as **PTYs inside the shared `collab-server` container**. The flow is:

```
POST /api/workspace/:slug/programs/:installId/launch
  → launchInstalledProgram (synthi/)
  → collab-server POST /program-runtime/:slug/launch
  → managedProgramRuntime.launchManagedProgram(config)
  → launchRuntime(...)                            [server.js:109]
  → createHeadlessSession(...) — spawns a PTY in collab-server
  → runs `cd <repoDir> && <install...> && <launch>` via composeProgramCommand
```

Two consequences of running in the shared container:

1. **No Docker.** `buildManagedRuntimeEnv` (`programRuntimeManager.js:7-46`) deliberately strips
   `DOCKER_HOST`, `DOCKER_SOCKET`, `DOCKER_CERT_PATH`, and any env value containing
   `/var/run/docker.sock`. Programs cannot reach a daemon at all. The `@vectant/devcontainer` recipe is
   imported as a *recipe of managed commands*, not a real container (`devcontainer.js` records
   `image`/`build` as informational `sourceHints` only).
2. **Multi-tenant isolation hole.** Every user's program runs in one shared process space. Giving that
   shared container a Docker socket would let any workspace control every other workspace's containers
   and the host — unacceptable.

The proven building block for the fix already exists: **`localWorkerSpawner.js`** spins up
**per-session containers** via dockerode on the `synthi-ide_default` network, with idle-cull and an
orphan sweep. A per-workspace Docker runtime is the same lifecycle shape applied to a new image.

## Goal

Run a per-workspace **rootless Docker engine** so that `docker` and `docker compose` work inside a
program/terminal session, and add a first-class `container` program runtime type that builds and runs a
real image from the devcontainer recipe — all inside an isolated per-workspace runtime container, never
touching the host Docker socket. Prove it end-to-end in the **dev `docker-compose` stack** first;
production (k8s + Sysbox) is a follow-on slice.

## Locked decisions (from brainstorming)

1. **Runtime model:** per-workspace rootless engine — an isolated container running its own rootless
   `dockerd`. No host privilege escalation reachable by user programs; no cross-workspace access.
2. **Engine placement (Approach A):** a **per-workspace DinD-rootless sidecar** container, spun up by
   collab-server reusing the `localWorkerSpawner` lifecycle pattern (idle-cull, orphan sweep, name
   convention). Rejected: (B) one shared daemon namespaced by labels — weak isolation, violates the
   no-cross-workspace decision; (C) baking dockerd into `synthi-worker` — wrong image (GPU/GStreamer,
   session-scoped), couples program runtime to the WebRTC worker.
3. **Execution model: hybrid for Phase 1** (revised from uniform after a design review found the port
   subsystem assumes one shared localhost — see "Discovered constraint" below). **Only** the new
   `container` runtime type routes into the per-workspace runtime container. web/cli/tui/background keep
   running as collab-server PTYs on the existing global port system, **untouched** (zero regression).
   The uniform migration (all programs → runtime container) plus the per-workspace port-system rework it
   requires are deferred to **Phase 1b**.
4. **Phasing:** dev-first vertical slice. This document is Phase 1 (dev). Phase 1b (uniform migration +
   per-workspace port rework) and Phase 2 (prod: k8s pod + Sysbox) are separate specs.
5. **v1 capability scope:** Docker CLI in the terminal **and** a `container` runtime type.

### Discovered constraint (why hybrid, not uniform)

`proxyService` detects ports by TCP-probing a fixed list on `127.0.0.1` *inside the collab-server
container* (`proxyService.js:102-131`) and reverse-proxies a **global** `/port/<N>/` → `127.0.0.1:N`
(`proxyService.js:204-233`). It has no workspace dimension. Moving *all* programs into per-workspace
runtime containers (separate network namespaces) would break detection (ports invisible to the
localhost scanner) and routing (workspace A's `:3000` is indistinguishable from B's `:3000`). The
uniform model therefore requires reworking the entire port subsystem — out of scope for the first
vertical slice. Hybrid sidesteps this: container programs get their **own additive** workspace-scoped
proxy route, and the global `/port/<N>/` path is never touched.

## Non-Goals (Phase 1)

- Production/k8s execution (Sysbox, per-workspace pods) — separate Phase 2 spec.
- GPU passthrough, image registries/caching infra, BuildKit remote cache.
- Replacing the WebRTC `synthi-worker` (compile/preview) — orthogonal; untouched.
- Per-workspace resource quotas beyond a basic cap + idle-cull (full quota system is later).
- Windows-host-native Docker (the dev stack uses Docker Desktop/WSL2; that is the supported dev target).

## Success Criteria (Phase-1 acceptance)

1. **CLI works:** `docker run hello-world` succeeds inside a `container`-type program's terminal, backed
   by a per-workspace rootless `dockerd` (verified: the daemon serving it is the workspace's own, not
   the host).
2. **Compose works:** `docker compose up` brings up a multi-service compose file from a `container`
   program in a workspace.
3. **`container` runtime type:** `@vectant/devcontainer` performs a real `docker build`/`docker run`
   inside the runtime container; launch/stop are wired into the Programs panel; a forwarded port
   surfaces as an App tab via the new `/wsport/<slug>/<port>/` route.
4. **Isolation:** workspace B's `docker ps` cannot see workspace A's containers; user programs cannot
   reach the host `/var/run/docker.sock`. Covered by a security test.
5. **Lifecycle:** the per-workspace runtime container is idle-culled (mirrors `localWorkerSpawner` TTL),
   orphan-swept on collab-server restart, and capped by a max-count guard.
6. **No regression:** existing web/cli/tui/background programs launch, stream logs, surface ports via
   the global `/port/<N>/` path, and idle-cull exactly as before — their code path is untouched.
7. New code paths have unit/integration/security tests.

---

## Architecture

### New component: per-workspace runtime container

- **Image** (`synthi-runtime:local`, new Dockerfile under `backend/runtime-image/`): based on
  `docker:dind-rootless`, with the default-program toolchain baked in (node 20, python3-venv/pip,
  lazygit, http-server) so the existing default recipes run unchanged. Runs rootless `dockerd` as its
  entrypoint; programs exec alongside it.
- **One per workspace** (keyed by `slug` + `workspaceUserId`, matching the per-user repo dir model),
  **not** per program session — multiple programs in a workspace share one daemon/runtime container,
  the same way they share one repo dir today.
- **Workspace files:** the per-user repo dir (`resolveWorkspaceCwd(slug, userId)`) is bind-mounted into
  the runtime container at a fixed path (e.g. `/workspace`), so `docker build .` and file edits see the
  same tree the editor does.
- **Network:** its own container on `synthi-ide_default`; published program ports are reached by the
  existing `proxyService` port-detection path (validate the detection still sees ports bound inside the
  runtime container; this is a Phase-1 spike item — see Risks).

### New module: `workspaceRuntimeContainer.js` (collab-server)

Mirrors the `localWorkerSpawner` surface, specialized for the runtime container:

- `ensureRuntimeContainer(slug, userId)` → `{ containerId, name }` — fast path (tracked + running),
  slow path (find-by-name after restart), create+start with the repo-dir bind mount; cap + label
  conventions (`MANAGED_VALUE = 'workspace-runtime-local'`).
- `execInRuntime(slug, userId, { command, env, tty })` → a PTY-like handle (stdin/onData/onExit/kill)
  backed by `docker exec`, so it drops into the **existing** `programRuntimeManager` runtime contract
  (`{ ptyProcess: { onData, onExit, kill } }`).
- `touch`, `teardown`, idle-cull, orphan-sweep, graceful shutdown — copied/adapted from
  `localWorkerSpawner`.

### Wiring change: `launchRuntime` (server.js:109) — branch on runtime type

Today `launchRuntime` always calls `createHeadlessSession` (PTY in collab-server). In the hybrid model
it **branches on `runtimeType`**: `container` programs route into the per-workspace runtime container;
everything else keeps the existing path unchanged.

```
launchRuntime: async ({ sessionId, workspaceSlug, userId, env, command, runtimeType }) => {
  if (runtimeType === 'container') {
    await workspaceRuntimeContainer.ensureRuntimeContainer(workspaceSlug, userId);
    return workspaceRuntimeContainer.execInRuntime(workspaceSlug, userId, { command, env, tty: true });
  }
  // unchanged: PTY in the shared collab-server for web/cli/tui/background
  const runtime = await createHeadlessSession(sessionId, workspaceSlug, userId, 120, 30, /*title*/ null, { env });
  const { commandStartedPromise } = queueHeadlessCommandStart(runtime.ptyProcess, command);
  return { ...runtime, commandStartedPromise };
}
```

`launchManagedSession` already passes `runtimeType` into `launchRuntime` (`programRuntimeManager.js:479`)
— the server.js callback simply doesn't destructure it yet, so the branch above needs **no**
`programRuntimeManager` change. The runtime container's working dir is `/workspace`, so
`composeProgramCommand`'s `cd "<workingDir>"` keeps working (workingDir stays repo-relative). For
container programs, `DOCKER_HOST` is provided *by the runtime container's entrypoint* pointing at its
own in-container rootless socket — outside the scrubbed per-program env, so the scrub's host-socket
denial is not weakened (see Security).

### Port routing for container programs: new `/wsport/<slug>/<port>/` route

Container programs publish ports with `docker run -p <port>:<port>` inside the runtime container, so the
port binds on the **runtime container's** interface, not collab-server's localhost — the global
`/port/<N>/` scanner/proxy cannot see or reach it. Rather than rework the global path, add an
**additive, workspace-scoped** proxy in a new module `containerPortProxy.js`:

- `GET|WS /wsport/:slug/:port/*` → resolve the workspace's runtime container host (its compose DNS name
  / inspected IP on `synthi-ide_default`), then proxy to `<runtimeHost>:<port>/*`. Mirrors the existing
  `proxyHttpRequest` / `proxyWsUpgrade` logic but keyed by slug instead of a global localhost.
- Detection is **deterministic, not scanned**: the set of published ports comes from the program's
  declared manifest ports (the `-p` flags we generated), surfaced on the managed session's
  `activePorts`/`webPort` immediately — no TCP sweep needed.
- The existing global `/port/<N>/` route, its scanner, and `getActivePorts()` are **not modified**.
- Frontend: the App-tab URL builder produces `/wsport/<slug>/<port>/` for `container` programs and the
  existing `/port/<port>/` for everything else. CSP `frame-src` already allows the collab origin (same
  origin for both routes), so **no CSP change** is required.

### New runtime type: `container`

- `manifest.js`: add `'container'` to `SUPPORTED_RUNTIME_TYPES`. `deriveSurfaces` for `container`
  surfaces `app` (when ports), `logs`, `terminal`, `ports`, `health`, `settings`.
- `devcontainer.js`: when `sourceHints.containerImage` or `sourceHints.containerBuild` is present and
  the workspace runtime supports containers, emit `runtimeType: 'container'` and translate the recipe
  into real Docker commands instead of bare managed commands:
  - `image` → `install: ['docker pull <image>']`, `launch: 'docker run --rm -p ... <image> <cmd>'`.
  - `build.dockerfile` → `install: ['docker build -t <tag> .']`, `launch: 'docker run --rm -p ... <tag>'`.
  - `forwardPorts` → `-p host:container` flags + declared ports (existing port plumbing surfaces them).
  - The existing host-escape guards (`assertNoHostEscape`) stay — `--privileged`, host bind mounts,
    docker.sock mounts, host-access features remain rejected even though we now run real containers,
    because the daemon is rootless and per-workspace.
- The `programRuntimeManager` needs no structural change: a `container` program is still
  `install + launch` composed into one command, just `docker ...` commands that now reach a real daemon.

### Frontend

Minimal for Phase 1 (panel already renders runtime types generically):
- `ProgramsPanel` shows a `container` badge/label and the existing launch/stop controls.
- A `container` program with forwarded ports gets the existing App-tab iframe surface (CSP already
  permits the collab proxy origin).

---

## Security

- **No host socket to user programs.** The host `/var/run/docker.sock` is mounted only into
  *collab-server* (already true — that's how `localWorkerSpawner` works) and is used solely to manage
  the runtime container's lifecycle. It is **never** bind-mounted into the runtime container or exposed
  to programs. The runtime container talks only to its own rootless `dockerd`.
- **Env scrub nuance.** `buildManagedRuntimeEnv` keeps stripping host-socket values. The runtime
  container sets `DOCKER_HOST` to its *own* in-container rootless socket via its entrypoint, outside the
  scrubbed per-program env, so the scrub's host-socket denial is not weakened. A test asserts a program
  cannot read a host-socket `DOCKER_HOST`.
- **Rootless.** `dockerd` runs rootless inside the runtime container; even a container breakout lands as
  an unprivileged user in a user namespace, not host root.
- **Isolation test:** two workspaces, each runs a named container; assert neither `docker ps` lists the
  other's. Assert host `docker ps` (from collab-server) does not list user containers under the runtime
  daemon.
- **devcontainer host-escape guards retained** (privileged, host mounts, docker.sock, dind/sshd
  features still rejected).

## Risks / spikes (validate before building on top)

1. **Docker Desktop/WSL2 + rootless DinD.** The outer `docker:dind-rootless` container commonly needs
   `--privileged` (or specific `--security-opt`/cgroup settings) on the *outer* container to set up its
   user namespaces. **Day-1 spike:** can collab-server's dockerode start a working rootless `dockerd`
   sidecar in this dev stack and run `docker run hello-world` inside it? Everything else depends on this.
2. **Port detection through the runtime container.** `proxyService.getActivePorts()` must see ports a
   program binds *inside* the runtime container. Confirm the detection mechanism (e.g. it scans the
   right network namespace / the published ports surface on the runtime container) and adjust the
   port-forward plumbing if needed.
3. **Storage/perf.** Rootless DinD uses `fuse-overlayfs`; image pulls are slower and consume nested
   storage. Phase 1 accepts this; note image-cache strategy as a Phase-2 concern.
4. **Cold start.** First launch in a workspace now waits for runtime-container create + `dockerd` ready.
   Mirror `localWorkerSpawner`'s warm/lifecycle states so the UI shows `starting` honestly.

## Test Plan

- **Unit:** `workspaceRuntimeContainer` name/cap/cull logic (pure parts), `execInRuntime` handle shape,
  `manifest.js` accepts `container` + `deriveSurfaces`, `devcontainer.js` emits real docker commands +
  retains host-escape guards.
- **Integration (dev stack):** ensureRuntimeContainer create/reuse/teardown; a program launch runs
  inside the runtime container and streams output; idle-cull tears the runtime container down.
- **Security:** host-socket env scrub; cross-workspace `docker ps` isolation; devcontainer escape
  rejections.
- **Manual live-verify (acceptance):** the four Success Criteria above, with screenshots.

## Rollout / flags

- Gate the new `container` execution path behind an env flag (`ENABLE_CONTAINER_RUNTIME=1` on
  collab-server). When unset, `container`-type programs fall back to the existing headless PTY path (the
  recipe still runs, just without a real daemon — same as today), so the slice can be merged dark and
  flipped on once the day-1 rootless-DinD spike passes. web/cli/tui/background are unaffected by the
  flag.

## Out-of-scope follow-ons (tracked, not in this slice)

- **Phase 1b:** uniform migration (move web/cli/tui/background into the per-workspace runtime container)
  + the per-workspace port-system rework (host-aware detection + proxy) that uniform requires. Closes
  the shared-container multi-tenant hole for non-container programs.
- Phase 2: prod execution (k8s pod per workspace + Sysbox), HPA/quota, registry cache.
- AI recipe-awareness of container programs (already in the post-slices backlog).
- Prod cost controls for always-on vs idle-culled runtime containers.
