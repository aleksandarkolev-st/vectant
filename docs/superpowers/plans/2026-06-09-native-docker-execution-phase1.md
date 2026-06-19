# Native Docker Execution — Phase 1 (dev hybrid slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `container` program runtime type that runs `docker` / `docker compose` and real `docker build`/`docker run` inside an isolated per-workspace rootless-Docker container, in the dev docker-compose stack, with zero regression to existing programs.

**Architecture:** Hybrid execution model. Only `container`-type programs route into a per-workspace `docker:dind-rootless` runtime container (managed by collab-server via dockerode, mirroring `localWorkerSpawner`'s lifecycle). web/cli/tui/background keep running as collab-server PTYs on the untouched global `/port/<N>/` system. Container programs get an additive, workspace-scoped reverse proxy at `/wsport/<slug>/<port>/`. The whole path is gated behind `ENABLE_CONTAINER_RUNTIME=1` so it can merge dark.

**Tech Stack:** Node.js (CommonJS, `node --test`) in `backend/collab-server`; dockerode over `/var/run/docker.sock`; Vitest (run from `synthi/`) for the `synthi/` manifest/devcontainer/UI changes; Docker Desktop/WSL2 dev stack.

**Reference spec:** `docs/superpowers/specs/2026-06-09-native-docker-execution-phase1-design.md`

---

## Pre-flight constraints (read before starting)

- **Branch:** work on `tool-compatibility` only. Do NOT merge, open PRs, or run the finishing-a-branch flow. Pushing IS allowed.
- **Staging:** stage only the specific files each task names. NEVER `git add -A`. Never touch noise files: `.claude/*`, `.gitignore`, `synthi/public/node-polyfills.js`, deleted PNGs, `packages/mcp-hub/node_modules/`, `tasks/lessons.md` (except to ADD a lesson).
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **collab-server tests:** `cd backend/collab-server && node --test <file>`.
- **synthi tests:** `cd synthi && npx vitest run <file>` (vitest is invoked from `synthi/`).
- **No `git add -A`, no build/prune without the user re-confirming disk state.**

---

## File Structure

**collab-server (new):**
- `backend/collab-server/workspaceRuntimeContainer.js` — per-workspace rootless-Docker runtime container lifecycle (ensure/exec/teardown/cull/orphan-sweep). Mirrors `localWorkerSpawner.js`.
- `backend/collab-server/containerPortProxy.js` — additive `/wsport/<slug>/<port>/` HTTP+WS reverse proxy to a workspace's runtime container.
- `backend/runtime-image/Dockerfile` — `synthi-runtime:local` image (docker:dind-rootless + node/python/lazygit/http-server).
- Tests: `backend/collab-server/__tests__/workspaceRuntimeContainer.test.js`, `backend/collab-server/__tests__/containerPortProxy.test.js`.

**collab-server (modify):**
- `backend/collab-server/server.js:109` — branch `launchRuntime` on `runtimeType === 'container'`; mount `/wsport` routes.
- `backend/collab-server/programRuntimeManager.js:7-46` — allow the platform-set in-container `DOCKER_HOST` for container runtime (keep host-socket denial).

**synthi (modify):**
- `synthi/src/lib/programs/manifest.js` — add `'container'` to `SUPPORTED_RUNTIME_TYPES` + surfaces.
- `synthi/src/lib/programs/devcontainer.js` — emit `runtimeType:'container'` + real docker commands when a container image/build is present and container runtime is enabled.
- `synthi/src/lib/programs/defaultPrograms.js` — `@vectant/devcontainer` becomes a real `container` program.
- Frontend App-tab URL builder — `/wsport/<slug>/<port>/` for container programs.
- Tests: `synthi/src/lib/programs/__tests__/manifest.test.*`, `devcontainer.test.*` (follow existing locations).

**dev infra (modify):**
- `docker-compose.yml` — mount `/var/run/docker.sock` into `collab-server`; add `ENABLE_CONTAINER_RUNTIME` + runtime-image env.

---

## Task 1: SPIKE — prove rootless dockerd runs in the dev stack (HARD GATE)

> This is a time-boxed spike, not TDD. Everything else depends on its outcome. If rootless DinD cannot run in this Docker Desktop/WSL2 stack without unacceptable privilege, STOP and report — do not build on a broken foundation.

**Files:**
- Create (throwaway, do not commit): `C:\tmp\dind-spike.md` notes.

- [ ] **Step 1: Confirm collab-server can reach the host Docker socket**

The compose currently does NOT mount the socket into collab-server. Verify on the host:

Run: `docker version --format '{{.Server.Version}}'`
Expected: a version string (Docker Desktop engine reachable).

- [ ] **Step 2: Start a rootless DinD container by hand and run hello-world inside it**

Run:
```
docker run -d --name dind-spike --privileged docker:dind-rootless
docker exec dind-spike docker run --rm hello-world
```
Expected: the nested `docker run --rm hello-world` prints "Hello from Docker!" — proving a rootless daemon works nested in this WSL2 stack. If it fails, capture the exact error in the notes file and STOP.

- [ ] **Step 3: Confirm a published port inside the DinD container is reachable from another container on the same network**

Run:
```
docker network create dind-spike-net || true
docker rm -f dind-spike; docker run -d --name dind-spike --privileged --network dind-spike-net docker:dind-rootless
docker exec dind-spike sh -c 'docker run -d -p 8088:80 nginx && sleep 3'
docker run --rm --network dind-spike-net curlimages/curl -s http://dind-spike:8088/ | head -1
```
Expected: nginx's default HTML first line. Proves the `/wsport` proxy approach (collab-server → runtime-container-host:port) is viable. Record the working invocation (privileged flags, network) in the notes.

- [ ] **Step 4: Tear down the spike**

Run: `docker rm -f dind-spike; docker network rm dind-spike-net`
Expected: cleanup succeeds.

- [ ] **Step 5: Record the verified create options**

In `C:\tmp\dind-spike.md`, write the exact `HostConfig` (Privileged, NetworkMode) and the working `docker run -p` / curl invocation. Tasks 3 and 7 consume these. **Do not commit this file.** No git commit for this task.

---

## Task 2: The runtime image (`synthi-runtime:local`)

**Files:**
- Create: `backend/runtime-image/Dockerfile`
- Modify: `docker-compose.yml` (no new service — the image is built/tagged for dockerode to create containers from; add a build note)

- [ ] **Step 1: Write the runtime image Dockerfile**

Create `backend/runtime-image/Dockerfile`:
```dockerfile
# synthi-runtime:local — per-workspace rootless Docker engine + default-program toolchain.
# Based on docker:dind-rootless so each workspace gets its own isolated daemon.
# The default marketplace recipes (node/python/lazygit/http-server) must run here
# unchanged, so their toolchain is baked in alongside the engine.
FROM docker:27-dind-rootless

USER root

# Default-program toolchain (mirrors backend/collab-server/Dockerfile additions).
# Alpine base (dind images are Alpine): use apk, not apt.
RUN apk add --no-cache \
      nodejs npm \
      python3 py3-pip \
      git lazygit curl ca-certificates bash

# http-server for the @vectant/static-site recipe.
RUN npm install -g http-server

# The rootless dind entrypoint sets up the rootless daemon and exports
# DOCKER_HOST=unix:///run/user/1000/docker.sock for the rootless user.
# Workspace files are bind-mounted at /workspace by the spawner.
USER rootless
WORKDIR /workspace
```

- [ ] **Step 2: Build the image to verify it assembles**

Run: `docker build -t synthi-runtime:local backend/runtime-image`
Expected: build succeeds, `synthi-runtime:local` tagged. (If `lazygit` is not in the Alpine repos for the pinned version, fall back to the GitHub-release tarball install pattern used in `backend/collab-server/Dockerfile:62-65` — adapt to Alpine paths.)

- [ ] **Step 3: Smoke-test the engine inside the image**

Run:
```
docker run -d --name runtime-smoke --privileged synthi-runtime:local
docker exec runtime-smoke docker run --rm hello-world
docker exec runtime-smoke sh -c 'node -v && python3 --version && lazygit --version'
docker rm -f runtime-smoke
```
Expected: hello-world prints, and node/python/lazygit versions print.

- [ ] **Step 4: Commit**

```bash
git add backend/runtime-image/Dockerfile
git commit -m "feat(runtime): synthi-runtime:local rootless-Docker image with default-program toolchain

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `workspaceRuntimeContainer` — pure helpers (name/cap/cull), TDD

**Files:**
- Create: `backend/collab-server/workspaceRuntimeContainer.js`
- Test: `backend/collab-server/__tests__/workspaceRuntimeContainer.test.js`

> Build the pure, dockerode-free logic first (naming, idle-cull decision, host resolution) so it is unit-testable without Docker. The dockerode-backed `ensureRuntimeContainer`/`execInRuntime` come in Task 4.

- [ ] **Step 1: Write failing tests for the pure helpers**

Create `backend/collab-server/__tests__/workspaceRuntimeContainer.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  runtimeContainerName,
  runtimeContainerHost,
  shouldCull,
  RUNTIME_IMAGE,
} = require('../workspaceRuntimeContainer');

test('runtimeContainerName is deterministic and docker-safe per (slug,userId)', () => {
  const a = runtimeContainerName('My_Repo', '242593757');
  assert.match(a, /^workspace-runtime-[a-z0-9-]+$/);
  assert.equal(a, runtimeContainerName('My_Repo', '242593757'));
  assert.notEqual(a, runtimeContainerName('My_Repo', 'other-user'));
});

test('runtimeContainerHost equals the container name (compose DNS on the shared network)', () => {
  assert.equal(runtimeContainerHost('repo', 'u1'), runtimeContainerName('repo', 'u1'));
});

test('shouldCull is true only past the idle TTL', () => {
  const ttl = 1000;
  assert.equal(shouldCull({ lastActive: 0 }, 999, ttl), false);
  assert.equal(shouldCull({ lastActive: 0 }, 1001, ttl), true);
});

test('RUNTIME_IMAGE defaults to synthi-runtime:local', () => {
  assert.equal(RUNTIME_IMAGE, 'synthi-runtime:local');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend/collab-server && node --test __tests__/workspaceRuntimeContainer.test.js`
Expected: FAIL — `Cannot find module '../workspaceRuntimeContainer'`.

- [ ] **Step 3: Implement the module skeleton with the pure helpers**

Create `backend/collab-server/workspaceRuntimeContainer.js`:
```js
'use strict';

/**
 * Per-workspace rootless-Docker runtime container lifecycle.
 *
 * Mirrors localWorkerSpawner.js but manages ONE runtime container per
 * (workspaceSlug,userId) instead of per signaling session. Only `container`-type
 * programs route here (hybrid Phase 1); the runtime container runs its own
 * rootless dockerd, so `docker`/`docker compose` inside it never touch the host
 * socket and cannot see another workspace's containers.
 */

const RUNTIME_IMAGE = process.env.RUNTIME_IMAGE || 'synthi-runtime:local';
const RUNTIME_NETWORK = process.env.WORKER_NETWORK || 'synthi-ide_default';
const RUNTIME_IDLE_TTL_MS = Number(process.env.RUNTIME_IDLE_TTL_MS) || 10 * 60 * 1000;
const MAX_RUNTIME_CONTAINERS = Number(process.env.MAX_RUNTIME_CONTAINERS) || 25;
const REPOS_DIR = process.env.REPOS_DIR || '/data/repos';

function safeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
}

/** Deterministic, docker-safe container name per workspace+user. */
function runtimeContainerName(slug, userId) {
  return `workspace-runtime-${safeName(`${slug}-${userId}`)}`;
}

/** On the shared compose network the container is reachable by its name. */
function runtimeContainerHost(slug, userId) {
  return runtimeContainerName(slug, userId);
}

/** Idle-cull decision (pure). */
function shouldCull(entry, now, ttlMs = RUNTIME_IDLE_TTL_MS) {
  return now - entry.lastActive > ttlMs;
}

module.exports = {
  RUNTIME_IMAGE,
  RUNTIME_NETWORK,
  RUNTIME_IDLE_TTL_MS,
  MAX_RUNTIME_CONTAINERS,
  REPOS_DIR,
  safeName,
  runtimeContainerName,
  runtimeContainerHost,
  shouldCull,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend/collab-server && node --test __tests__/workspaceRuntimeContainer.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/collab-server/workspaceRuntimeContainer.js backend/collab-server/__tests__/workspaceRuntimeContainer.test.js
git commit -m "feat(runtime): workspaceRuntimeContainer pure helpers (name/host/cull)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `workspaceRuntimeContainer` — dockerode lifecycle (ensure/exec/teardown/cull)

**Files:**
- Modify: `backend/collab-server/workspaceRuntimeContainer.js`
- Test: `backend/collab-server/__tests__/workspaceRuntimeContainer.test.js` (add injected-docker tests)

> dockerode is injected so the lifecycle is testable with a fake Docker client (no real daemon in unit tests). The create options come from the Task 1 spike notes (Privileged + NetworkMode).

- [ ] **Step 1: Write failing tests with an injected fake docker client**

Append to `backend/collab-server/__tests__/workspaceRuntimeContainer.test.js`:
```js
const { createRuntimeManager } = require('../workspaceRuntimeContainer');

function fakeDocker() {
  const created = [];
  const containers = new Map();
  return {
    created,
    containers,
    createContainer: async (opts) => {
      created.push(opts);
      const id = `id-${opts.name}`;
      const c = {
        id,
        start: async () => { containers.get(id).running = true; },
        inspect: async () => ({ Id: id, State: { Running: containers.get(id).running } }),
        remove: async () => { containers.delete(id); },
        exec: async () => ({
          start: async () => ({ on: () => {}, write: () => {}, end: () => {} }),
        }),
      };
      containers.set(id, { running: false, c, name: opts.name });
      return c;
    },
    getContainer: (id) => {
      const found = [...containers.values()].find((e) => e.c.id === id || e.name === id);
      if (!found) { const e = new Error('no such container'); e.statusCode = 404; throw e; }
      return found.c;
    },
    listContainers: async () => [],
  };
}

test('ensureRuntimeContainer creates + starts a privileged container on the shared network', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  const res = await mgr.ensureRuntimeContainer('repo', 'u1');
  assert.equal(res.name, 'workspace-runtime-repo-u1');
  assert.equal(docker.created.length, 1);
  const opts = docker.created[0];
  assert.equal(opts.Image, 'synthi-runtime:local');
  assert.equal(opts.HostConfig.Privileged, true);
  assert.equal(opts.HostConfig.NetworkMode, 'synthi-ide_default');
  // workspace repo dir bind-mounted at /workspace
  assert.ok(opts.HostConfig.Binds.some((b) => b.endsWith(':/workspace')));
});

test('ensureRuntimeContainer reuses a running container (no second create)', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');
  await mgr.ensureRuntimeContainer('repo', 'u1');
  assert.equal(docker.created.length, 1);
});

test('teardown removes the container and forgets the session', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');
  await mgr.teardown('repo', 'u1');
  assert.equal(docker.containers.size, 0);
});

test('ensureRuntimeContainer enforces the max-container cap', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker, maxContainers: 1 });
  await mgr.ensureRuntimeContainer('a', 'u1');
  await assert.rejects(() => mgr.ensureRuntimeContainer('b', 'u2'), /cap reached/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend/collab-server && node --test __tests__/workspaceRuntimeContainer.test.js`
Expected: FAIL — `createRuntimeManager is not a function`.

- [ ] **Step 3: Implement `createRuntimeManager`**

Add to `backend/collab-server/workspaceRuntimeContainer.js` (before `module.exports`, then export it):
```js
const path = require('path');

/**
 * @param {object} opts
 * @param {object} opts.docker - dockerode-compatible client (injected for tests)
 * @param {number} [opts.maxContainers]
 * @param {string} [opts.reposDir]
 */
function createRuntimeManager({
  docker,
  maxContainers = MAX_RUNTIME_CONTAINERS,
  reposDir = REPOS_DIR,
  image = RUNTIME_IMAGE,
  network = RUNTIME_NETWORK,
  logger = console,
} = {}) {
  if (!docker) throw new TypeError('docker client is required');
  /** key `${slug} ${userId}` -> { containerId, lastActive } */
  const sessions = new Map();
  const keyOf = (slug, userId) => `${slug} ${userId}`;

  async function ensureRuntimeContainer(slug, userId) {
    const name = runtimeContainerName(slug, userId);
    const key = keyOf(slug, userId);
    const now = Date.now();

    const tracked = sessions.get(key);
    if (tracked) {
      try {
        const info = await docker.getContainer(tracked.containerId).inspect();
        if (info.State.Running) {
          tracked.lastActive = now;
          return { name, host: name, containerId: tracked.containerId, created: false };
        }
        try { await docker.getContainer(tracked.containerId).remove({ force: true }); } catch (_) {}
      } catch (_) {}
      sessions.delete(key);
    }

    if (sessions.size >= maxContainers) {
      throw new Error(`Runtime container cap reached (${maxContainers})`);
    }

    // Per-user workspace dir on the host-side named volume, bind-mounted into /workspace.
    const hostRepoDir = path.posix.join(reposDir, safeName(slug), safeName(userId));
    const createOpts = {
      name,
      Image: image,
      Labels: {
        'synthi/runtime': 'workspace-runtime-local',
        'synthi/slug': String(slug),
        'synthi/userId': String(userId),
        'synthi/lastActive': String(now),
      },
      HostConfig: {
        // Privileged on the OUTER container is required for rootless dockerd to
        // set up its user namespaces in the Docker Desktop/WSL2 dev stack
        // (verified in the Task 1 spike). Prod (Phase 2) replaces this with Sysbox.
        Privileged: true,
        NetworkMode: network,
        Binds: [`${hostRepoDir}:/workspace`],
        RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
      },
    };

    const container = await docker.createContainer(createOpts);
    await container.start();
    sessions.set(key, { containerId: container.id, lastActive: now });
    logger.log(`[RuntimeContainer] Started ${name} (slug=${slug}, userId=${userId})`);
    return { name, host: name, containerId: container.id, created: true };
  }

  function touch(slug, userId) {
    const s = sessions.get(keyOf(slug, userId));
    if (s) s.lastActive = Date.now();
  }

  async function teardown(slug, userId) {
    const key = keyOf(slug, userId);
    const s = sessions.get(key);
    sessions.delete(key);
    const id = s?.containerId || runtimeContainerName(slug, userId);
    try {
      const c = docker.getContainer(id);
      try { await c.stop({ t: 5 }); } catch (_) {}
      await c.remove({ force: true });
    } catch (err) {
      if (err.statusCode !== 404) logger.warn(`[RuntimeContainer] teardown ${id}: ${err.message}`);
    }
  }

  async function cullIdle(now = Date.now()) {
    for (const [key, entry] of [...sessions.entries()]) {
      if (shouldCull(entry, now)) {
        const [slug, userId] = key.split(' ');
        await teardown(slug, userId);
      }
    }
  }

  return { ensureRuntimeContainer, touch, teardown, cullIdle, _sessions: sessions };
}
```
Add `createRuntimeManager` to the `module.exports` object.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend/collab-server && node --test __tests__/workspaceRuntimeContainer.test.js`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add backend/collab-server/workspaceRuntimeContainer.js backend/collab-server/__tests__/workspaceRuntimeContainer.test.js
git commit -m "feat(runtime): workspaceRuntimeContainer dockerode lifecycle (ensure/teardown/cull)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `execInRuntime` — PTY-shaped `docker exec` handle

**Files:**
- Modify: `backend/collab-server/workspaceRuntimeContainer.js`
- Test: `backend/collab-server/__tests__/workspaceRuntimeContainer.test.js`

> `programRuntimeManager` expects the runtime handle to expose `{ ptyProcess: { onData, onExit, kill } }` (see `programRuntimeManager.js:299-311`). `execInRuntime` adapts a dockerode exec stream to that shape.

- [ ] **Step 1: Write the failing test**

Append:
```js
test('execInRuntime returns a ptyProcess-shaped handle (onData/onExit/kill)', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');
  const handle = await mgr.execInRuntime('repo', 'u1', { command: 'echo hi', env: { FOO: 'bar' } });
  assert.equal(typeof handle.ptyProcess.onData, 'function');
  assert.equal(typeof handle.ptyProcess.onExit, 'function');
  assert.equal(typeof handle.ptyProcess.kill, 'function');
  // onData/onExit return disposables (the manager calls .dispose())
  const d = handle.ptyProcess.onData(() => {});
  assert.equal(typeof d.dispose, 'function');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend/collab-server && node --test __tests__/workspaceRuntimeContainer.test.js`
Expected: FAIL — `mgr.execInRuntime is not a function`.

- [ ] **Step 3: Implement `execInRuntime`**

Inside `createRuntimeManager`, add and export on the returned object:
```js
  async function execInRuntime(slug, userId, { command, env = {}, tty = true } = {}) {
    const s = sessions.get(keyOf(slug, userId));
    if (!s) throw new Error('runtime container not started');
    s.lastActive = Date.now();

    const Env = Object.entries(env)
      .filter(([k, v]) => typeof k === 'string' && v != null)
      .map(([k, v]) => `${k}=${v}`);

    const exec = await docker.getContainer(s.containerId).exec({
      Cmd: ['/bin/sh', '-lc', String(command)],
      Env,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: tty,
      WorkingDir: '/workspace',
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: tty });

    const dataCbs = new Set();
    const exitCbs = new Set();
    stream.on('data', (chunk) => { for (const cb of dataCbs) cb(chunk.toString('utf8')); });
    stream.on('end', async () => {
      let exitCode = null;
      try { exitCode = (await exec.inspect()).ExitCode; } catch (_) {}
      for (const cb of exitCbs) cb({ exitCode });
    });

    const ptyProcess = {
      onData: (cb) => { dataCbs.add(cb); return { dispose: () => dataCbs.delete(cb) }; },
      onExit: (cb) => { exitCbs.add(cb); return { dispose: () => exitCbs.delete(cb) }; },
      write: (data) => { try { stream.write(data); } catch (_) {} },
      kill: () => { try { stream.end(); } catch (_) {} },
    };
    return { ptyProcess, stop: () => ptyProcess.kill() };
  }
```
Add `execInRuntime` to the returned object.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend/collab-server && node --test __tests__/workspaceRuntimeContainer.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/collab-server/workspaceRuntimeContainer.js backend/collab-server/__tests__/workspaceRuntimeContainer.test.js
git commit -m "feat(runtime): execInRuntime adapts docker exec to the ptyProcess contract

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `manifest.js` + `devcontainer.js` — the `container` runtime type (synthi, Vitest)

**Files:**
- Modify: `synthi/src/lib/programs/manifest.js:22` (add `'container'`), `deriveSurfaces`
- Modify: `synthi/src/lib/programs/devcontainer.js` (emit real docker commands)
- Test: existing `synthi/src/lib/programs/__tests__/manifest.test.*` and `devcontainer.test.*` (match the existing file's framework/location — find with a glob first)

- [ ] **Step 1: Locate the existing manifest/devcontainer test files**

Run: `cd synthi && npx vitest run src/lib/programs --reporter=dot --run 2>&1 | head -5` (or glob `src/lib/programs/**/*test*`). Note the exact paths; add the new cases there.

- [ ] **Step 2: Write failing tests**

In the manifest test file, add:
```js
import { describe, it, expect } from 'vitest';
import { parseProgramManifest, SUPPORTED_RUNTIME_TYPES } from '../manifest';

describe('container runtime type', () => {
  it('accepts runtimeType "container"', () => {
    expect(SUPPORTED_RUNTIME_TYPES).toContain('container');
    const cfg = parseProgramManifest({
      packageId: 'x', version: '1.0.0', runtimeType: 'container',
      launch: 'docker run --rm hello-world',
    });
    expect(cfg.runtimeType).toBe('container');
  });
});
```
In the devcontainer test file, add:
```js
import { importDevcontainer } from '../devcontainer';

describe('container-mode devcontainer import', () => {
  it('emits a container runtimeType with real docker build/run when enabled', () => {
    const { config } = importDevcontainer({
      name: 'Dev', image: 'node:20', forwardPorts: [3000], postStartCommand: 'npm run dev',
    }, { containerRuntime: true });
    expect(config.runtimeType).toBe('container');
    expect(config.install.join(' ')).toMatch(/docker pull node:20/);
    expect(config.launch).toMatch(/docker run/);
    expect(config.launch).toMatch(/-p 3000:3000/);
  });

  it('still rejects host-escape recipes in container mode', () => {
    expect(() => importDevcontainer(
      { name: 'x', image: 'node:20', privileged: true }, { containerRuntime: true }
    )).toThrow();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd synthi && npx vitest run src/lib/programs`
Expected: FAIL — `'container'` not in SUPPORTED_RUNTIME_TYPES; `importDevcontainer` ignores the 2nd arg.

- [ ] **Step 4: Implement manifest change**

In `synthi/src/lib/programs/manifest.js:22`:
```js
export const SUPPORTED_RUNTIME_TYPES = ['web', 'cli', 'tui', 'background', 'gui', 'container'];
```
In `deriveSurfaces` (manifest.js:157-165), treat `container` like `web` for the app surface:
```js
function deriveSurfaces(runtimeType, ports) {
  const out = [];
  if (ports.length > 0 || runtimeType === 'gui' || runtimeType === 'container') out.push('app');
  out.push('logs');
  if (runtimeType !== 'background') out.push('terminal');
  if (ports.length > 0) out.push('ports');
  out.push('health', 'settings');
  return out;
}
```

- [ ] **Step 5: Implement devcontainer container-mode**

In `synthi/src/lib/programs/devcontainer.js`, change the signature to accept options and emit docker commands when `containerRuntime` is on. Replace the `install`/`launch`/`runtimeType` derivation block:
```js
export function importDevcontainer(input, { containerRuntime = false } = {}) {
  const dc = coerceManifestObject(input);
  assertNoHostEscape(dc);
  // ... existing env/strippedEnvKeys block unchanged ...

  const forwardPorts = Array.isArray(dc.forwardPorts) ? dc.forwardPorts : [];
  const ports = [];
  for (const p of forwardPorts) {
    const n = typeof p === 'number' ? p : parseInt(String(p).split(':').pop(), 10);
    if (Number.isInteger(n) && n >= 1 && n <= 65535 && !ports.includes(n)) ports.push(n);
  }

  const image = typeof dc.image === 'string' && dc.image.trim() ? dc.image.trim() : null;
  const dockerfile = (dc.build && typeof dc.build.dockerfile === 'string') ? dc.build.dockerfile
    : (typeof dc.dockerFile === 'string' ? dc.dockerFile : null);

  let runtimeType, install, launch;
  const portFlags = ports.map((p) => `-p ${p}:${p}`).join(' ');
  if (containerRuntime && (image || dockerfile)) {
    runtimeType = 'container';
    const tag = image || `${slugifyPackageId(dc.name)}:local`;
    const lifecycle = [
      ...flattenCommand(dc.onCreateCommand),
      ...flattenCommand(dc.updateContentCommand),
      ...flattenCommand(dc.postCreateCommand),
    ];
    const inContainerCmd = [
      ...lifecycle,
      ...flattenCommand(dc.postStartCommand),
    ].join(' && ') || 'sleep infinity';
    install = image
      ? [`docker pull ${image}`]
      : [`docker build -t ${tag} -f ${dockerfile} .`];
    launch = `docker run --rm ${portFlags} -v "$PWD":/workspace -w /workspace ${tag} sh -lc ${JSON.stringify(inContainerCmd)}`.trim();
  } else {
    // existing managed-command behaviour (unchanged)
    install = [
      ...flattenCommand(dc.onCreateCommand),
      ...flattenCommand(dc.updateContentCommand),
      ...flattenCommand(dc.postCreateCommand),
    ];
    const launchCmds = flattenCommand(dc.postStartCommand);
    launch = launchCmds.length ? launchCmds.join(' && ') : 'sleep infinity';
    runtimeType = ports.length ? 'web' : 'background';
  }
  // ... rest (packageId, displayName, sourceHints, permissions, parseProgramManifest call) unchanged,
  //     but pass the computed runtimeType/install/launch through ...
}
```
Keep `assertNoHostEscape(dc)` at the top so host-escape recipes are rejected in BOTH modes.

- [ ] **Step 6: Run to verify pass**

Run: `cd synthi && npx vitest run src/lib/programs`
Expected: PASS (all existing + new cases).

- [ ] **Step 7: Commit**

```bash
git add synthi/src/lib/programs/manifest.js synthi/src/lib/programs/devcontainer.js synthi/src/lib/programs/__tests__
git commit -m "feat(programs): container runtime type + container-mode devcontainer import

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `containerPortProxy` — additive `/wsport/<slug>/<port>/` reverse proxy

**Files:**
- Create: `backend/collab-server/containerPortProxy.js`
- Test: `backend/collab-server/__tests__/containerPortProxy.test.js`

> Mirrors `proxyService.proxyHttpRequest`/`parsePortUrl` but keyed by slug. The runtime-container host is resolved via an injected resolver so the route logic is unit-testable without Docker.

- [ ] **Step 1: Write the failing test for URL parsing + host resolution**

Create `backend/collab-server/__tests__/containerPortProxy.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseWsPortUrl } = require('../containerPortProxy');

test('parseWsPortUrl extracts slug, port, downstream', () => {
  assert.deepEqual(parseWsPortUrl('/wsport/my-repo/3000/foo/bar'),
    { slug: 'my-repo', port: 3000, downstream: '/foo/bar' });
  assert.deepEqual(parseWsPortUrl('/wsport/my-repo/3000'),
    { slug: 'my-repo', port: 3000, downstream: '/' });
});

test('parseWsPortUrl rejects non-matching / unsafe paths', () => {
  assert.equal(parseWsPortUrl('/port/3000/'), null);
  assert.equal(parseWsPortUrl('/wsport/../3000/'), null);
  assert.equal(parseWsPortUrl('/wsport/repo/notaport/'), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend/collab-server && node --test __tests__/containerPortProxy.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser + proxy**

Create `backend/collab-server/containerPortProxy.js`:
```js
'use strict';
const http = require('http');
const net = require('net');

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Parse `/wsport/<slug>/<port>/rest`. Returns null on any unsafe/non-match. */
function parseWsPortUrl(urlString) {
  const m = /^\/wsport\/([^/]+)\/(\d+)(\/.*)?$/.exec(urlString || '');
  if (!m) return null;
  const slug = decodeURIComponent(m[1]);
  if (slug.includes('..') || !SLUG_RE.test(slug)) return null;
  const port = parseInt(m[2], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { slug, port, downstream: m[3] || '/' };
}

/**
 * @param {object} opts
 * @param {(slug:string)=>string|null} opts.resolveHost - slug -> runtime container host (or null)
 */
function createContainerPortProxy({ resolveHost } = {}) {
  if (typeof resolveHost !== 'function') throw new TypeError('resolveHost is required');

  function proxyHttp(req, res) {
    const parsed = parseWsPortUrl(req.url);
    if (!parsed) { res.writeHead(400); res.end('bad /wsport url'); return; }
    const host = resolveHost(parsed.slug);
    if (!host) { res.writeHead(502); res.end('runtime container not running'); return; }
    const proxyReq = http.request({
      hostname: host, port: parsed.port, path: parsed.downstream, method: req.method,
      headers: { ...req.headers, host: `localhost:${parsed.port}` }, timeout: 30000,
    }, (up) => {
      const headers = { ...up.headers, 'access-control-allow-origin': '*' };
      res.writeHead(up.statusCode, headers);
      up.pipe(res, { end: true });
    });
    proxyReq.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('upstream unreachable'); } });
    proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end('gateway timeout'); } });
    req.pipe(proxyReq, { end: true });
  }

  function proxyWsUpgrade(req, socket, head) {
    const parsed = parseWsPortUrl(req.url);
    if (!parsed) { socket.destroy(); return false; }
    const host = resolveHost(parsed.slug);
    if (!host) { socket.destroy(); return false; }
    const up = net.connect(parsed.port, host, () => {
      const reqLine = `${req.method} ${parsed.downstream} HTTP/1.1\r\n`;
      const headers = Object.entries(req.headers)
        .filter(([k]) => k.toLowerCase() !== 'host')
        .map(([k, v]) => `${k}: ${v}`)
        .concat([`Host: localhost:${parsed.port}`]).join('\r\n');
      up.write(reqLine + headers + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    return true;
  }

  return { proxyHttp, proxyWsUpgrade };
}

module.exports = { parseWsPortUrl, createContainerPortProxy };
```

- [ ] **Step 4: Add a proxy-routing test with a fake upstream**

Append to the test file:
```js
const http = require('http');
const { createContainerPortProxy } = require('../containerPortProxy');

test('proxyHttp forwards to the resolved runtime host', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('OK:' + req.url); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();
  const proxy = createContainerPortProxy({ resolveHost: () => '127.0.0.1' });

  const front = http.createServer((req, res) => proxy.proxyHttp(req, res));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;

  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${fp}/wsport/repo/${port}/hello`, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
  assert.equal(body, 'OK:/hello');
  upstream.close(); front.close();
});
```

- [ ] **Step 5: Run to verify pass**

Run: `cd backend/collab-server && node --test __tests__/containerPortProxy.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/collab-server/containerPortProxy.js backend/collab-server/__tests__/containerPortProxy.test.js
git commit -m "feat(runtime): additive /wsport/<slug>/<port>/ reverse proxy for container programs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Wire into server.js — branch launchRuntime, mount /wsport, allow in-container DOCKER_HOST

**Files:**
- Modify: `backend/collab-server/server.js:105-117` (launchRuntime branch + manager wiring)
- Modify: `backend/collab-server/server.js` (route `/wsport/...` in the HTTP + upgrade handlers)
- Modify: `backend/collab-server/programRuntimeManager.js:7-46` (do not strip the platform in-container DOCKER_HOST)

> server.js has no unit harness for the HTTP router; verify this task in the live stack at Task 10. The env-scrub change IS unit-tested.

- [ ] **Step 1: Write the failing env-scrub test**

In `backend/collab-server/__tests__/programRuntimeManager.test.js`, add:
```js
test('buildManagedRuntimeEnv keeps an in-container rootless DOCKER_HOST but still strips host socket', () => {
  const { buildManagedRuntimeEnv } = require('../programRuntimeManager');
  const out = buildManagedRuntimeEnv({}, {
    DOCKER_HOST: 'unix:///run/user/1000/docker.sock', // platform-set, in-container rootless
  });
  assert.equal(out.DOCKER_HOST, 'unix:///run/user/1000/docker.sock');

  const host = buildManagedRuntimeEnv({}, { DOCKER_HOST: 'unix:///var/run/docker.sock' });
  assert.equal(host.DOCKER_HOST, undefined); // host socket still denied
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend/collab-server && node --test __tests__/programRuntimeManager.test.js`
Expected: FAIL — `DOCKER_HOST` is currently in `BLOCKED_ENV_KEYS`, so the first assertion fails (it's stripped).

- [ ] **Step 3: Implement the scrub refinement**

In `programRuntimeManager.js`: remove `'DOCKER_HOST'` from `BLOCKED_ENV_KEYS` (line 19) and instead rely on the existing `BLOCKED_ENV_VALUE_FRAGMENTS` (`/var/run/docker.sock`, `\\.\pipe\docker_engine`) to deny the host socket by value. Keep `DOCKER_SOCKET` and `DOCKER_CERT_PATH` blocked. This allows an in-container rootless `unix:///run/user/1000/docker.sock` while still stripping any value pointing at the host socket.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend/collab-server && node --test __tests__/programRuntimeManager.test.js`
Expected: PASS (existing + new).

- [ ] **Step 5: Wire the runtime manager + launchRuntime branch in server.js**

Near the top-level requires in `server.js`, add:
```js
const Docker = require('dockerode');
const { createRuntimeManager } = require('./workspaceRuntimeContainer');
const { createContainerPortProxy } = require('./containerPortProxy');

const ENABLE_CONTAINER_RUNTIME = process.env.ENABLE_CONTAINER_RUNTIME === '1';
const workspaceRuntime = ENABLE_CONTAINER_RUNTIME
  ? createRuntimeManager({ docker: new Docker({ socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock' }) })
  : null;
const containerPortProxy = ENABLE_CONTAINER_RUNTIME
  ? createContainerPortProxy({
      resolveHost: (slug) => {
        // Resolve the running runtime container host for this slug (any user — dev single-user).
        const entry = [...workspaceRuntime._sessions.entries()].find(([k]) => k.startsWith(`${slug} `));
        if (!entry) return null;
        const [k] = entry;
        const [s, u] = k.split(' ');
        return require('./workspaceRuntimeContainer').runtimeContainerHost(s, u);
      },
    })
  : null;
```
Replace the `launchRuntime` body (server.js:109-116) with the runtimeType branch:
```js
  launchRuntime: async ({ sessionId, workspaceSlug, userId, env, title, command, runtimeType }) => {
    if (runtimeType === 'container' && workspaceRuntime) {
      await workspaceRuntime.ensureRuntimeContainer(workspaceSlug, userId);
      return workspaceRuntime.execInRuntime(workspaceSlug, userId, { command, env, tty: true });
    }
    const runtime = await createHeadlessSession(sessionId, workspaceSlug, userId, 120, 30, title, { env });
    const { commandStartedPromise } = queueHeadlessCommandStart(runtime.ptyProcess, command);
    return { ...runtime, commandStartedPromise };
  },
```

- [ ] **Step 6: Mount the `/wsport` routes**

In the main HTTP request handler (where `proxyService.proxyHttpRequest` / `parsePortUrl` are dispatched — grep `parsePortUrl` in server.js), add an earlier branch:
```js
if (ENABLE_CONTAINER_RUNTIME && req.url.startsWith('/wsport/')) {
  return containerPortProxy.proxyHttp(req, res);
}
```
In the `upgrade` handler (grep `proxyWsUpgrade`), add:
```js
if (ENABLE_CONTAINER_RUNTIME && req.url.startsWith('/wsport/')) {
  if (containerPortProxy.proxyWsUpgrade(req, socket, head)) return;
}
```

- [ ] **Step 7: Run the full collab-server test suite (no regressions)**

Run: `cd backend/collab-server && node --test`
Expected: PASS across the suite.

- [ ] **Step 8: Commit**

```bash
git add backend/collab-server/server.js backend/collab-server/programRuntimeManager.js backend/collab-server/__tests__/programRuntimeManager.test.js
git commit -m "feat(runtime): wire container runtime into launchRuntime + /wsport; refine DOCKER_HOST scrub

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Compose + default program + frontend App-tab URL

**Files:**
- Modify: `docker-compose.yml` (collab-server: socket mount + env)
- Modify: `synthi/src/lib/programs/defaultPrograms.js` (devcontainer recipe → container runtime)
- Modify: frontend App-tab URL builder (locate via grep)

- [ ] **Step 1: Mount the host docker socket + flag into collab-server**

In `docker-compose.yml` under `collab-server:`, add to `environment:` `ENABLE_CONTAINER_RUNTIME: "1"` and `RUNTIME_IMAGE: "synthi-runtime:local"`, and to `volumes:` add `- /var/run/docker.sock:/var/run/docker.sock`. (Keep existing `collab-data:/data`.)

- [ ] **Step 2: Make `@vectant/devcontainer` a real container program**

In `synthi/src/lib/programs/defaultPrograms.js`, in `buildDefaultPrograms()`, call `importDevcontainer(entry.recipe, { containerRuntime: true })` for the devcontainer entry so the default ships as a `container` program. Update the `description` to drop "on the roadmap" wording.

- [ ] **Step 3: Add a defaultPrograms test asserting the container shape**

In the defaultPrograms test file (grep for an existing one under `synthi/src/lib/programs/__tests__`), add:
```js
it('@vectant/devcontainer builds a real container program', () => {
  const built = buildDefaultPrograms();
  const dc = built.find((p) => p.packageId === '@vectant/devcontainer');
  expect(dc.config.runtimeType).toBe('container');
  expect(dc.config.launch).toMatch(/docker run/);
});
```

- [ ] **Step 4: Run synthi program tests**

Run: `cd synthi && npx vitest run src/lib/programs`
Expected: PASS.

- [ ] **Step 5: Frontend App-tab URL builder**

The URL is built by `getProgramSessionAppUrl(port)` in `synthi/src/services/programSessionClient.js:52-58` (returns `` `${COLLAB_BASE}/port/${port}/` ``), called from `synthi/src/components/programs/ProgramSessionPanel.jsx:118` and `:297`. Thread `slug` + `runtimeType` through:

In `programSessionClient.js`:
```js
export function getProgramSessionAppUrl(port, { slug = null, runtimeType = null } = {}) {
  if (typeof port !== 'number' || !Number.isFinite(port)) return null;
  if (runtimeType === 'container' && slug) {
    return `${COLLAB_BASE}/wsport/${encodeURIComponent(slug)}/${port}/`;
  }
  return `${COLLAB_BASE}/port/${port}/`;
}
```
In `ProgramSessionPanel.jsx`, pass the session's slug + runtimeType at both call sites, e.g. line 118:
```js
const appUrl = useMemo(
  () => getProgramSessionAppUrl(effectiveWebPort, { slug: session?.workspaceSlug, runtimeType: session?.runtimeType }),
  [effectiveWebPort, session?.workspaceSlug, session?.runtimeType]
);
```
and line 297 similarly: `href={getProgramSessionAppUrl(port, { slug: session?.workspaceSlug, runtimeType: session?.runtimeType }) || '#'}`.
Update the existing test mock in `ProgramSessionPanel.test.jsx:68` to accept the 2nd arg (it currently takes only `port`); existing assertions for non-container programs still expect `/port/3000/`. (No CSP change — same collab origin.)

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml synthi/src/lib/programs/defaultPrograms.js synthi/src/lib/programs/__tests__ synthi/src/services/programSessionClient.js synthi/src/components/programs
git commit -m "feat(programs): ship @vectant/devcontainer as a container program; wsport App-tab URL; compose socket mount

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Live verification (acceptance) + security checks

**Files:** none (verification only). Capture screenshots/notes.

> Requires rebuilding the collab-server image and the runtime image, and bringing up the dev stack. Confirm disk headroom with the user before any `docker build` (per the standing disk gate).

- [ ] **Step 1: Build images**

Run: `docker build -t synthi-runtime:local backend/runtime-image` then `docker compose build collab-server`
Expected: both succeed.

- [ ] **Step 2: Bring up the stack and seed defaults**

Run: `docker compose up -d collab-server frontend` (+ deps). Seed defaults if needed via the existing `ENABLE_PROGRAM_SEED` flow. Confirm `@vectant/devcontainer` shows in the marketplace as a `container` program.

- [ ] **Step 3: Acceptance #1 — CLI works**

Install + launch a `container` program; in its terminal run `docker run --rm hello-world`.
Expected: "Hello from Docker!" — served by the workspace's own rootless daemon. Screenshot.

- [ ] **Step 4: Acceptance #2 — compose works**

In a workspace with a `docker-compose.yml`, run `docker compose up` from a container program terminal.
Expected: services start. Screenshot.

- [ ] **Step 5: Acceptance #3 — devcontainer + App tab**

Launch `@vectant/devcontainer`; confirm a real `docker build`/`docker run` happens and the forwarded port renders in the App tab via `/wsport/<slug>/3000/`. Screenshot.

- [ ] **Step 6: Acceptance #4 — isolation**

Open two workspaces, each running a named container. In workspace B run `docker ps`.
Expected: B does NOT list A's container. Also, from a container program, `cat /var/run/docker.sock` / `DOCKER_HOST` must NOT reach the host socket. Screenshot both.

- [ ] **Step 7: Acceptance #6 — no regression**

Launch a `web` program (e.g. `@vectant/nextjs-dev`); confirm it still runs as a collab-server PTY and its port surfaces via the global `/port/<N>/` path exactly as before.
Expected: unchanged behaviour. Screenshot.

- [ ] **Step 8: Record results**

Append a "Review" section to `tasks/todo.md` (ADD only) summarising acceptance pass/fail with screenshot references. Update the `tasks/todo.md` backlog item for native container execution to "Phase 1 (hybrid, dev) complete; Phase 1b = uniform + port rework".

- [ ] **Step 9: Commit the docs**

```bash
git add tasks/todo.md
git commit -m "docs: native Docker Phase 1 (hybrid dev slice) acceptance results

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review checklist (for the implementer before declaring done)

- [ ] All four acceptance criteria + no-regression verified live (Task 10).
- [ ] `ENABLE_CONTAINER_RUNTIME` unset ⇒ container programs fall back to headless PTY with zero new behaviour (merge-dark safe).
- [ ] Global `/port/<N>/` path, scanner, and `getActivePorts()` are byte-for-byte unchanged.
- [ ] Host `/var/run/docker.sock` is mounted ONLY into collab-server, never into a runtime container, never into a program's env.
- [ ] `assertNoHostEscape` still rejects privileged/host-mount/docker.sock/dind devcontainers in container mode.
- [ ] No `git add -A`; only the named files staged; noise files untouched.
