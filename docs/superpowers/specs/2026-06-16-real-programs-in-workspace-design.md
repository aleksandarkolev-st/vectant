# Real programs in the workspace — Slice 1: container programs on the Sysbox runtime

**Date:** 2026-06-16
**Status:** Design proposed — pending user review, then implementation plan
**Branch:** `feat/docker-sysbox-engine` (do NOT land beyond this branch without explicit approval)
**Realizes:** the "real third-party programs run with their UI inside the workspace" north-star (`vectant-product-vision` memory),
the first slice on top of the validated Phase-2 Sysbox runtime (`docs/superpowers/specs/2026-06-12-sysbox-runtime-design.md`).
**Builds on (does not replace):** the Phase-2 Sysbox runtime (validated live, dark by default behind `RUNTIME_BACKEND=sysbox-pod`)
and the existing managed-program runtime (`programRuntimeManager.js`, the program-session UI).

> ⚠️ **Grounding caveat.** This spec was written against the code at `0cbfb297` (re-read this session, lesson #24). The
> backend execution seam and frontend surfacing are unit-testable without a cluster and will be TDD'd. The end-to-end
> path (container program → web UI in the App tab via `/runtime/<scope>/port/N`) was **not** yet run live; it is the
> single live-demo gate in §10 and must be validated on a throwaway Sysbox scratch cluster before this slice is "done".

---

## 1. Goal & definition of done

A user with `RUNTIME_BACKEND=sysbox-pod` can launch a real **`container`** program — **via a marketplace recipe AND via
repo auto-detection** (`docker-compose.yml` / `devcontainer.json` / `Dockerfile`). It runs `docker`/`compose` in **their
isolated per-workspace Sysbox dockerd**; its published web port renders in the program's **App tab** via
`/runtime/<scope>/port/N`; the **Terminal** tab execs into the same runtime pod; **logs** stream. Flag OFF ⇒ byte-for-byte
current behavior. Unit tests green; one live end-to-end demo on a scratch cluster captured as evidence; hardcoded-values
audit clean.

## 2. Grounded reconciliation — what already exists at `0cbfb297`

| Component | State today | This slice |
|---|---|---|
| `server.js` `launchRuntime` injection (`:180`) | `container` programs already branch into a docker runtime — but the **dev-hybrid** `workspaceRuntime` (`ensureRuntimeContainer`/`execInRuntime`, gated on `ENABLE_CONTAINER_RUNTIME`), **not** the Sysbox pod. Default (no hybrid) ⇒ headless PTY (docker blocked). | **Add a Sysbox-pod branch** ahead of the hybrid branch (§5.1). |
| `runtimePodTerminal.js` | `createRuntimePodPty` (interactive `bash --login -i` into the `runtime` container) + `runtimeRunOnce` (one-shot exec for the port monitor). | **Add `createRuntimePodProgram`** — non-interactive exec of the composed command, streaming output (§5.2). |
| `runtimePodSpec.js` `:209` | Runtime container sets `DOCKER_HOST=unix:///var/run/docker.sock` at the **pod level** (rootful daemon). | Relied upon: an exec into the container **inherits** the right socket (§5.1, correction #1). |
| `programRuntimeManager.js` | `buildManagedRuntimeEnv` scrubs `DOCKER_HOST` for **all** managed sessions; ports come only from the global localhost scanner (`recomputeManagedPorts`). | **Keep scrubbing `DOCKER_HOST`** (inheritance, not pass-through). **Add `recomputeRuntimeScopePorts`** + stamp `runtimeScope` on the record (§5.3, §5.4). |
| Runtime port monitor (`server.js:162`) | Detects pod ports via `/proc/net/tcp`, emits `runtime-ports` `(slug, runtimeScope, ports)` → `broadcastRuntimePorts` → frontend workspace Ports panel (A5). | **Also feed** those ports into `recomputeRuntimeScopePorts(scope, ports)` so the program session's `activePorts`/`webPort` light up (§5.4). |
| `programSessionClient.getProgramSessionAppUrl` (`:65`) | Already builds `/runtime/<scope>/port/N/` when `runtimeScope` is passed. | Unchanged. **`ProgramSessionPanel` must pass `session.runtimeScope`** into it (`:119`, `:300`) — today it passes none (§5.5). |
| `manifest.js` `deriveSurfaces` (`:161`) | `container` already gets an App surface. | Unchanged. |
| `devcontainer.js` `importDevcontainer(raw, {containerRuntime:true})` (`:101`) | Already emits a `container` config (`docker pull`/`build` + `docker run -p … -v "$PWD":/workspace`). | Reuse as the **devcontainer** repo-detector; unify the capability gate (§5.6). |
| `defaultPrograms.js` / `runtimeClient.js` | `containerRuntime` is read ad-hoc from `ENABLE_CONTAINER_RUNTIME==='1'` (and `runtimeClient.js:93` doesn't pass it at all → inconsistent). | Replace with one **server-truthful `containerRuntimeAvailable`** capability (§5.6). |

**Net:** the rails (App-URL helper, `container` surfaces, devcontainer→container mapper, runtime-port broadcast) are
largely laid. The missing wiring is: (a) a Sysbox execution branch, (b) per-scope port→session attribution, (c)
`runtimeScope` carried onto the session and into the App-tab URL, and (d) compose/Dockerfile detectors + one capability gate.

## 3. The three approved corrections to the prior (§6 handoff) design

1. **`DOCKER_HOST` stays scrubbed — inheritance, not pass-through.** The program command runs *inside* the runtime
   container, whose pod-level `DOCKER_HOST` already points at the in-pod rootful daemon. The program never controls
   Docker's endpoint. (Matches the existing comment at `programRuntimeManager.js:19-24`.)
2. **Launch is a three-way branch:** Sysbox-pod container (NEW, gated on `isSysboxRuntimeEnabled()` + resolvable scope) →
   dev-hybrid `workspaceRuntime` (preserved) → headless PTY (preserved).
3. **Port attribution is scoped per `runtimeScope`,** not global. A new `recomputeRuntimeScopePorts(scope, ports)`
   attributes a pod's detected ports only across managed sessions stamped with that scope (the global scanner can't see
   into a pod, and reusing the global path would mis-attribute across workspaces).

## 4. Architecture

```
 Marketplace recipe (runtimeType:container)  ─┐
 Repo detect: compose/devcontainer/Dockerfile ─┤→ NormalizedProgramConfig (container) ─→ launchManagedProgram
                                               │      (gated on containerRuntimeAvailable)        │
                                               └────────────────────────────────────────────────┘
                                                                                                  ▼
   server.js launchRuntime injection:  runtimeType==='container' && isSysboxRuntimeEnabled() && scope
        │  resolve runtimeScope from slug (spawner.listActiveRuntimeSessions)
        ▼
   createRuntimePodProgram({ runtimeScope, command, env })          ┌── runtime pod (sysbox-runc) ──┐
        │  k8s pods/exec  ['/bin/bash','-lc', 'cd /workspace && …'] │  rootful dockerd               │
        │  (inherits pod-level DOCKER_HOST)                ────────▶ │  docker compose up  (foreground)│
        │  returns { ptyProcess, runtimeScope }                     │  publishes :3000               │
        ▼                                                           └───────────────┬───────────────┘
   managedSession: stamp record.runtimeScope; stream stdout→logs                    │ /proc/net/tcp
                                                                                     ▼
   runtime port monitor → runtime-ports (slug, scope, [3000]) ──▶ recomputeRuntimeScopePorts(scope,[3000])
        │                                                              → session.activePorts/webPort = 3000
        ▼ (5s poll: fetchProgramSession)
   ProgramSessionPanel App tab: getProgramSessionAppUrl(3000, { runtimeScope }) → /runtime/<scope>/port/3000/  (iframe)
```

## 5. Component design

### 5.1 Execution seam — three-way branch (`server.js` `launchRuntime`)

```js
launchRuntime: async ({ sessionId, workspaceSlug, userId, env, title, command, runtimeType }) => {
  // 1. Sysbox per-workspace runtime pod (prod) — NEW, takes precedence.
  if (runtimeType === 'container' && isSysboxRuntimeEnabled()) {
    const runtimeScope = await resolveRuntimeScopeForSlug(workspaceSlug); // listActiveRuntimeSessions()
    if (!runtimeScope) {
      throw new Error('runtime_pod_not_ready'); // fail loud, never silently fall back to a docker-less path
    }
    return createRuntimePodProgram({ runtimeScope, workspaceSlug, userId, command, env });
  }
  // 2. Dev-hybrid runtime container (local) — PRESERVED, unchanged.
  if (runtimeType === 'container' && workspaceRuntime) { /* existing ensure/wait/execInRuntime */ }
  // 2b. container requested but NO runtime available → fail loud. Do NOT fall through
  //     to the headless PTY, where DOCKER_HOST is scrubbed and `docker` silently fails.
  if (runtimeType === 'container') {
    throw new Error('container_runtime_unavailable');
  }
  // 3. Headless PTY default (non-container) — PRESERVED, unchanged.
  const runtime = await createHeadlessSession(...); /* … */
}
```

> The fall-through guard (2b) is the launch-side mirror of the `containerRuntimeAvailable` capability (§5.6): the UI
> shouldn't offer a launchable `container` program when no runtime exists, and if one is launched anyway it fails loud
> rather than crashing opaquely in a docker-less shell.

- `resolveRuntimeScopeForSlug(slug)`: `spawner.listActiveRuntimeSessions()` returns `[{runtimeScope, slug}]`; return the
  scope whose slug matches (the runtime pod is pre-warmed at workspace mount via `/api/spawner/ensure` →
  `spawnRuntimePod`, so its Deployment exists well before a program launch). Returns `null` if none.
- **`DOCKER_HOST` is not special-cased here.** `buildManagedRuntimeEnv` keeps scrubbing it; the execed login shell in the
  runtime container inherits the pod-level `DOCKER_HOST` (correction #1).

### 5.2 Runtime-pod program exec (`runtimePodTerminal.js` — new `createRuntimePodProgram`)

Sibling to `createRuntimePodPty`, sharing the kube-config / env-export / `cd /workspace` scaffolding, but:
- Final exec is the **composed program command**, not an interactive shell:
  `['/bin/bash','-lc', '<exports>; cd /workspace; <command>']` (TTY on, so `docker compose` colorizes; the workspace mount
  is `/workspace` per `RUNTIME_POD_WORKSPACE_MOUNT`).
- Ensures + waits for the **ready** runtime pod for `runtimeScope` (readiness probe = `docker info`, so ready ⇒ dockerd up).
- Returns `{ ptyProcess: new RuntimePodPty({...}), runtimeScope, podName }`. `RuntimePodPty` already exposes
  `onData`/`onExit`/`kill`, so it plugs into `launchManagedSession`'s `attachManagedRuntimeListeners` unchanged.

### 5.3 Stamp `runtimeScope` on the managed session (`programRuntimeManager.js`)

Minimal, keeps the manager k8s-agnostic:
- In `launchManagedSession`, after `await launchRuntime(...)`: `record.runtimeScope = runtime?.runtimeScope || null;`.
- `toPublicManagedSession` already spreads `publicRecord`, so `runtimeScope` is exposed automatically (it is **not** in the
  destructured-out private list). Add it to the `launchManagedSession` JSDoc and the public-shape test.

### 5.4 Scoped port attribution (`programRuntimeManager.js` — new `recomputeRuntimeScopePorts`)

```js
function recomputeRuntimeScopePorts(runtimeScope, detectedPorts) {
  if (!runtimeScope) return [];
  const scoped = [...managedSessions.values()].filter((r) => r.runtimeScope === runtimeScope);
  const attribution = attributeSessionPorts({
    sessions: scoped.map((r) => ({ sessionId: r.sessionId, state: r.state, declaredPorts: r.declaredPorts || [] })),
    detectedPorts,
  });
  // identical update/emit loop to recomputeManagedPorts, restricted to `scoped`:
  //   set activePorts/webPort, emit `ports_updated` only on change, return changed snapshots.
}
```

- Wired in `server.js` from the runtime port monitor's `onPortsChanged(slug, runtimeScope, ports)`: keep
  `broadcastRuntimePorts(...)` **and** add `managedProgramRuntime.recomputeRuntimeScopePorts(runtimeScope, ports)`.
- The session's `ports_updated` is picked up by the existing 5s `fetchProgramSession` poll — no new socket for the panel.
- Slice-1 attribution relies on declared ports (compose/devcontainer `forwardPorts` → `declaredPorts`); the canonical
  compose-with-web-UI case declares its port, so attribution is unambiguous. Multi-service disambiguation UI is a non-goal.

### 5.5 Frontend threading (`ProgramSessionPanel.jsx`)

- `appUrl` memo (`:118`): add `runtimeScope: session?.runtimeScope` to the `getProgramSessionAppUrl` opts and to the
  dependency array.
- Ports "Open" link (`:300`): add `runtimeScope: session?.runtimeScope`.
- The session payload already flows through `fetchProgramSession` → `body.session`; confirm the Next.js program-session
  GET passes the object verbatim (it does today) so `runtimeScope` reaches the panel.

### 5.6 Entry points — one config core, two adapters

**(a) Recipe (works once §5.1 lands):** a `container`-type manifest is accepted directly by `parseProgramManifest`
(`runtimeType:'container'`). Ship one digest-pinned `@vectant/*` example (e.g. a tiny `docker compose` web app) so the
marketplace has a one-click container demo. No gate needed for an explicit `container` manifest.

**(b) Repo auto-detection (`synthi/src/lib/programs/repoDetect.js`, new):** a pure mapper
`detectRepoProgram(files) → NormalizedProgramConfig|null`, where `files` is `{ name → contents }` for the repo root.
Precedence: `docker-compose.yml`/`compose.yaml` → `.devcontainer/devcontainer.json`/`devcontainer.json` → `Dockerfile`.
- **compose** (`importComposeFile`, new): parse the compose YAML; reject host bind mounts / `--privileged` / `docker.sock`
  (mirror `devcontainer.js` `assertNoHostEscape`); `launch = 'docker compose up'`; `declaredPorts` = host ports from each
  service's `ports:`; `runtimeType:'container'`. (Verify a YAML dep exists in `synthi/`; else a targeted `services:`/`ports:`
  parse of the documented subset — decided in the plan.)
- **devcontainer**: reuse `importDevcontainer(raw, { containerRuntime: true })` (already built).
- **Dockerfile** (`importDockerfile`, new): `install:['docker build -t <slug> .']`, `launch:'docker run --rm -p … <slug>'`;
  `declaredPorts` from `EXPOSE` lines if present, else none (App tab waits for runtime-detected ports).
- **Capability gate:** all three only shape a `container` config when **`containerRuntimeAvailable`** is true.

**Capability flag (`containerRuntimeAvailable`):** computed **server-side** as
`RUNTIME_BACKEND === 'sysbox-pod' || ENABLE_CONTAINER_RUNTIME === '1'` and surfaced to the Programs UI via the existing
Next.js program API. It replaces the scattered `ENABLE_CONTAINER_RUNTIME === '1'` reads (and the missing one in
`runtimeClient.js:93`) with one truthful signal used by `defaultPrograms`, `runtimeClient`, and `repoDetect`.

**UI hook (minimal):** the Programs panel offers detected repo programs (a "Detected in this repo" affordance) → launches
via the existing program-launch flow. The heavy multi-service compose dashboard is a non-goal (§9).

## 6. Security

- The container runs in the validated Sysbox pod: `runtimeClassName: sysbox-runc`, `hostUsers:false`, non-privileged,
  egress-hardened, host `docker.sock` unreachable, workspace files via `subPath` (per-workspace dockerd, never shared).
- User manifests/devcontainers/compose still cannot request host escape — existing `host_escape` rejections stay and the
  compose mapper adds the same guard. The platform **provides** the isolated per-workspace dockerd; the program never
  receives a `DOCKER_HOST` it controls.
- Flag-gated, dark by default. `resolveRuntimeScopeForSlug` failing ⇒ **loud error** (`runtime_pod_not_ready`), never a
  silent fallback to a docker-less path.

## 7. Flag-gating / zero regression

- New execution branch is gated on `isSysboxRuntimeEnabled()` (`RUNTIME_BACKEND==='sysbox-pod'`). OFF ⇒ the branch is
  never entered; hybrid + headless paths are byte-for-byte unchanged.
- `containerRuntimeAvailable` OFF ⇒ repo-detect/devcontainer shape **non-container** configs exactly as today.
- `recomputeRuntimeScopePorts` only acts on sessions carrying a `runtimeScope` (only set on the Sysbox path) — no effect
  on existing managed sessions.

## 8. Testing

**Unit (TDD, red→green per task):**
- `programRuntimeManager`: `recomputeRuntimeScopePorts` attributes only same-scope sessions; `ports_updated` emitted only
  on change; `runtimeScope` stamped from the runtime handle and present in the public session; `DOCKER_HOST` still scrubbed.
- `runtimePodTerminal`: `createRuntimePodProgram` builds the expected `bash -lc 'cd /workspace && <command>'` argv and a
  handle whose `onData`/`onExit`/`kill` behave (injected fake `Exec`).
- `server` launch-branch decision (pure helper extracted/tested): container + sysbox + scope → pod path; container +
  hybrid → hybrid; else headless. `resolveRuntimeScopeForSlug` matches slug→scope.
- `repoDetect` / `importComposeFile` / `importDockerfile`: precedence; host-escape rejection; declared-port extraction;
  capability gate off ⇒ null/non-container.
- frontend `ProgramSessionPanel`: when `session.runtimeScope` set, App-tab iframe `src` and Ports "Open" hrefs are
  `/runtime/<scope>/port/N/` (vitest).

**Live (the single end-to-end gate, scratch cluster only — verify `kubectl config current-context` first):** launch a real
compose program (recipe AND repo-detect) → its web UI renders in the App tab via `/runtime/<scope>/port/N`; Terminal execs
into the runtime pod; logs stream. Capture as evidence. Tear the cluster down (`--quiet --async`; confirm `clusters list`
shows prod only).

## 9. Non-goals (slice 1)

GUI-app streaming (separate spec; sysbox design §11); Approach-B per-container "docker dashboard" objects; multi-service
compose orchestration UI (start/stop individual services); image-build cache tuning beyond Slice 5/7; frontend-supplied
`runtimeScope` (server-side slug-resolution is used; frontend-supplied scope is a later hardening if the pre-warm race ever
bites); `purgeRuntimeData` DELETE-route wiring (A3 follow-up).

## 10. Open spikes / [VALIDATE]

- **[VALIDATE] End-to-end demo** (§8 live gate) — the only hard validation gate for "done".
- **[VALIDATE] compose YAML dependency** — confirm a YAML parser exists in `synthi/`; if not, decide minimal-subset parse
  vs. adding a dep (plan-time).
- **[VALIDATE] exec env inheritance** — confirm a k8s `pods/exec` login shell into the `runtime` container sees the
  pod-level `DOCKER_HOST` (expected; verified incidentally by the Slice-3 terminal running `docker` live, but re-confirm
  for the non-interactive program exec).
- **Pre-warm race** — if a program is launched before the runtime Deployment exists, `resolveRuntimeScopeForSlug` returns
  null → loud error. Acceptable for slice 1 (pod pre-warms at mount); frontend-supplied scope removes it later.

## 11. Incidental cleanup (surgical, in files already touched)

Fix the stale "rootless" comments that contradict the rootful reality (lesson #31): `runtimePodSpec.js:9` header
("rootless dockerd") and `programRuntimeManager.js:23` ("docker:dind-rootless"). Comment-only; no behavior change.

## 12. Hardcoded-values audit (per the `hardcoded-values-audit` memory)

New values must be env-driven or universal standards, never env-specific/secret. Expected new constants: the `/workspace`
mount and `runtime` container name (already centralized in `runtimePodTerminal.js`); `containerRuntimeAvailable` is derived
from existing env (`RUNTIME_BACKEND`, `ENABLE_CONTAINER_RUNTIME`), not a new literal. The `@vectant/*` example image must be
digest-pinned in Artifact Registry and pass the trivy gate. Full audit at slice end.
