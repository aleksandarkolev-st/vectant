---
name: synthi-backend
description: 'Use when working on the Synthi backend stack: worker HMR, signaling-server, collab-server, ai-backend, Redis, Y-Sweet, process orchestration, backend debugging, backend architecture, environment wiring, service dependency failures, and compiled-language preview flows.'
argument-hint: 'Describe the backend task, service, or failure you want to work on.'
user-invocable: true
disable-model-invocation: false
---

# Synthi Backend

Backend workflow skill for the Synthi monorepo. Use this when the task touches backend architecture, runtime behavior, service wiring, HMR internals, signaling, collab, AI backend, or container-first local development.

## When to Use

- Debugging the compiled-language backend pipeline in `backend/synthi-webrtc-compiler/worker/`
- Working on HMR orchestration, adapter families, runtime reloads, or state restore
- Debugging `signaling-server` startup, Redis connection issues, or session routing
- Working on `backend/collab-server` workspace, git, terminal, or Y-Sweet integration
- Working on `ai-backend/ai-engine` or `ai-backend/gateway` integration points
- Tracing failures caused by missing env vars or mismatched local/container addresses
- Auditing whether backend code is live, dormant, scaffolded, or safe to delete

## Backend Map

### Core services

- `backend/synthi-webrtc-compiler/worker/`
  - Compiled-language worker, HMR planner/orchestrator, runtime loader, runner logic, signaling client
- `backend/synthi-webrtc-compiler/signaling-server/`
  - WebSocket signaling layer for worker/browser coordination
  - Hard dependency on Redis
- `backend/collab-server/`
  - File CRUD, git operations, workspace management, terminal proxy, Y-Sweet token issuance
  - Also hosts the ephemeral Yjs WS relay (`yjsWsServer.js`) — see "Y-Sweet dual-path" below.
  - Hosts the worker spawner dispatcher — see "Spawner selection" below.
- `backend/y-sweet/`
  - CRDT persistence backend. **Not a fork** — ships only a Dockerfile around the upstream `ghcr.io/jamsocket/y-sweet:latest` image.
- `ai-backend/ai-engine/`
  - Analysis, healing, code intelligence, observability endpoints. See `synthi-ai-backend` skill for depth.
- `ai-backend/gateway/`
  - WebSocket/HTTP gateway in front of the AI backend. See `synthi-ai-backend` skill for depth.

### Local dependency graph

For local Docker development, the expected service graph is:

- `redis`
- `postgres`
- `y-sweet`
- `collab-server`
- `signaling-server`
- `ai-engine`
- `ai-gateway`
- `worker`
- `frontend`

See `docker-compose.yml` for the authoritative local wiring.

## Ground Rules

1. Treat the backend as a multi-service system, not a single app.
2. Check environment wiring before blaming service logic.
3. Distinguish local host, Docker network, WSL, and Kubernetes DNS addresses.
4. For worker/HMR work, verify the live runtime path before editing dormant scaffolding.
5. Do not assume every backend module should be activated just because it exists.

## Service-Specific Expectations

### Worker

The worker is the compiled-language runtime and HMR engine. Single-package Rust crate (not a Cargo workspace). Binaries: `worker` (main.rs) and `runner` (src/runtime/runner_bin.rs).

Important directories:

- `backend/synthi-webrtc-compiler/worker/src/compiler/`
- `backend/synthi-webrtc-compiler/worker/src/runtime/`
- `backend/synthi-webrtc-compiler/worker/src/hmr/`

#### Language + adapter matrix

Authoritative source: `worker/src/hmr/adapter_registry.rs::create_adapter_for_language`. Anything outside this list is unsupported — no Python, no JS/TS, no Node runtime.

| Language(s) | Adapter family | Tier | File |
|-------------|----------------|------|------|
| `c`, `cpp`, `rust`, `zig` | `DynLibAdapter` (dlopen/dlclose) | Tier 3 (fast, in-process) | `hmr/dynlib_adapter.rs` |
| `java`, `kotlin` | `ManagedRuntimeAdapter` (JVM classloader) | Tier 2 | `hmr/managed_runtime_adapter.rs` |
| `csharp` | `ManagedRuntimeAdapter` (.NET) | Tier 2 | `hmr/managed_runtime_adapter.rs` |
| `go`, `swift` | `ProcessSwapAdapter` (candidate process + state IPC) | Tier 1 | `hmr/process_swap_adapter.rs` |

Families are split across many peer files (e.g. `dynlib_*`, `managed_*`, `process_swap_*`). Edit the family you're actually in — do not cross-wire.

#### Compiler stages

`worker/src/compiler/stages/`: `compile_core.rs`, `compile_gui.rs`, `compile_runner.rs`, `runner.rs` (authoritative runner execution path, calls `handle_runner_execution`), plus `ai_utils.rs`, `guardrails.rs`, `pch.rs`.

When debugging worker issues:

1. Identify whether the path is compile-time, planner-time, adapter-time, runner-time, or restore-time.
2. Confirm the adapter family (dynlib / managed / process-swap) matches the language.
3. Treat `compiler/handler.rs -> compiler/stages/runner.rs -> runtime/runner_logic.rs -> hmr/orchestrator.rs` as the main native reload path.
4. Prefer fixing authority boundaries and metadata targeting over adding more abstractions.

Dormant but still compiled:

- `runtime/backends/{glfw,raylib,sdl2,sfml}` — predate the current Xvfb + GStreamer rendering path. Scaffolding.
- `runtime/hot_reload/v2.rs` — minimal; live HMR orchestration is in `hmr/orchestrator.rs` + `planner.rs`.

### Signaling Server

The signaling server depends on Redis.

Startup assumptions:

- `REDIS_URL` defaults to `redis://127.0.0.1:6379`
- `COLLAB_SERVER_URL` is optional for disconnect webhook support

Common failure pattern:

- If startup prints Redis URL and then fails with connection refused, the actual problem is usually Redis reachability, not missing `COLLAB_SERVER_URL`.

Addressing rules:

- Local bare-metal Redis: `redis://127.0.0.1:6379`
- Docker Compose Redis: `redis://redis:6379`
- Kubernetes Redis: use cluster DNS, not localhost
- WSL/containerized process talking to host Redis: do not assume localhost maps to the host

### Collab Server

Node.js (Express + raw `http.createServer`). Default port `1234` (`COLLAB_PORT`). It is _both_ the workspace/file/git service AND an ephemeral Yjs WS relay — see "Y-Sweet dual-path" below. The authoritative Yjs persistence still lives in Y-Sweet.

Key files (`backend/collab-server/`):

| File | Role |
|------|------|
| `server.js` (~2900 LOC) | HTTP + 5 WebSocket servers (Yjs relay, notifications, session, terminal, sparse). Main entry. |
| `spawner.js` | Dispatcher — picks `processWorkerSpawner` / `localWorkerSpawner` / `workspacePodSpawner`. |
| `processWorkerSpawner.js` | `cargo run` worker as child process. Bare-metal dev. |
| `localWorkerSpawner.js` | Worker as Docker container via `/var/run/docker.sock`. Docker-compose dev. |
| `workspacePodSpawner.js` | Worker as Kubernetes Deployment/Job. Prod. |
| `SessionManager.js` | In-memory session state (user, workspace, permissions). |
| `fileIndex.js` + `fsWatcherService.js` | File tree indexing and watching. |
| `gitService.js` (~3800 LOC) | Complete git implementation via simple-git. |
| `gcsSync.js` | GCS backup / restore. Active only if `GCS_SYNC_ON_FLUSH=true`. |
| `terminalService.js` | node-pty WebSocket shell. |
| `workspaceManager.js` | Per-workspace repo lifecycle, LRU eviction. |
| `ySweetBridge.js` | **REST** bridge to Y-Sweet for token + snapshot. |
| `yjsWsServer.js` | **WebSocket** Yjs relay. Ephemeral, in-process. Not persistent. |
| `proxyService.js` | HTTP proxy to worker for compile requests. |
| `permissionMiddleware.js` | Session/user/permission extraction on HTTP. |

Key env vars: `COLLAB_PORT`, `YSWEET_URL` (e.g. `http://y-sweet:8080`), `YSWEET_AUTH_KEY`, `REPOS_DIR` (e.g. `/data/repos`), `CODE_INTEL_URL` (ai-engine), `WORKER_SIGNALING_URL`, `WORKER_COLLAB_URL`, `WORKER_AI_BACKEND_URL`, `GCS_SYNC_ON_FLUSH`. `LEVELDB_DIR` is read but unused (LevelDB removed).

When collab behavior is wrong:

1. Separate file/git API failures (collab-server HTTP) from Y-Sweet document-sync failures.
2. Distinguish a `yjsWsServer` (ephemeral relay) failure from a Y-Sweet persistence failure.
3. Check collab URL usage in frontend and worker callers.
4. Verify repo storage paths and workspace ownership assumptions.

#### Y-Sweet dual-path

Two Yjs components are live simultaneously:

- **Y-Sweet** (`backend/y-sweet/` → upstream binary): persistent CRDT store, REST API.
- **collab-server `yjsWsServer.js`**: in-process WebSocket relay, **not** persistent.

Normal flow:

1. Frontend asks collab-server for a Y-Sweet token (`ySweetBridge.js` → Y-Sweet REST).
2. Frontend connects Yjs via WebSocket to collab-server's `yjsWsServer` for real-time fan-out.
3. Persistence still rides Y-Sweet.

On collab-server restart, `yjsWsServer`'s in-memory rooms vanish. Clients reconnect and rehydrate from Y-Sweet. That is by design.

If you change either component, ask: am I changing the ephemeral relay (`yjsWsServer.js`) or the persistent bridge (`ySweetBridge.js`)? They are frequently confused.

#### Spawner selection

`spawner.js::pickMode()` order:

1. `SPAWNER_MODE` env var (`"process"` | `"local"` | `"k8s"`) — explicit wins.
2. `KUBERNETES_SERVICE_HOST` set → `"k8s"`.
3. Default → `"process"`.

Concrete defaults:

- Bare-metal dev: no env → `processWorkerSpawner` (`cargo run --release --bin worker`).
- `docker-compose.yml` sets `SPAWNER_MODE: "local"` → `localWorkerSpawner` (Docker-in-Docker via mounted socket). Image tag defaults to `synthi-worker:local`.
- K8s: ambient `KUBERNETES_SERVICE_HOST` → `workspacePodSpawner` using `@kubernetes/client-node`. Worker Deployment ships with `replicas: 0` — pods are created per-session by collab-server, not by a static Deployment.

When worker launch is broken, the first question is always: which spawner was picked? Collab-server logs this on startup.

### AI Backend and Gateway

Keep AI engine and gateway concerns separate:

- `ai-engine` owns analysis/healing/intelligence logic. Python/FastAPI on `:8000`.
- `gateway` owns transport and fan-out behavior. Node.js/WS on `:7070`, path `/ws`.

For any task beyond wiring-level debugging, switch to the `synthi-ai-backend` skill — it documents routes, prompt-cache mechanics, the Gemini-only factory, and supersession.

When debugging AI-backed backend features:

1. Check whether the call is transport-level, gateway-level, or engine-level.
2. Confirm the frontend/backend caller actually hits the intended route.
3. For HMR observability, verify the full path: frontend or worker -> gateway -> ai-engine.

## Recommended Workflow

### 1. Classify the task first

Place the task into one of these buckets before editing anything:

- Environment or dependency wiring
- Service startup failure
- Live HMR/runtime bug
- Dormant or partial backend subsystem
- Architecture cleanup or dead-code review

### 2. Check service boundaries

For any backend bug, answer these first:

- Which process logged the error?
- Which downstream dependency does that process require?
- Is the failing address localhost, Docker DNS, WSL host, or Kubernetes DNS?
- Is the code path actually live?

### 3. Use the right source of truth

Use these files as primary references:

- `docker-compose.yml` for local service wiring
- `k8s/configmap.yaml` and `k8s/*.yaml` for cluster wiring
- `backend/synthi-webrtc-compiler/README.md` for worker/signaling expectations
- `backend/collab-server/README.md` for collab-server behavior
- `docs/HMR_CODE_AUDIT_2026-04-10.md` for compiled-language HMR status

### 4. For HMR/backend audits

When reviewing backend code, classify each module as one of:

- live and authoritative
- live but partial
- scaffolded and worth implementing
- scaffolded and should be quarantined
- redundant and safe to delete

Do not collapse these categories.

### 5. Validate after edits

After backend edits:

1. Run targeted diagnostics on changed files.
2. Re-check env assumptions for any startup-related fix.
3. If the issue is multi-service, validate the dependent service is reachable before changing more code.

## Common Backend Failure Patterns

### Redis connection refused in signaling-server

Likely causes:

- Redis is not running
- `REDIS_URL` fell back to localhost unintentionally
- service is running in Docker/WSL and `127.0.0.1` points to the wrong network namespace

Correct response:

1. Confirm the process that emitted the log
2. Read the startup code
3. Compare the runtime `REDIS_URL` with the expected environment for that launch mode
4. Fix the environment or dependency, not the log message

### Missing `COLLAB_SERVER_URL`

This is usually not fatal by itself.

Interpretation:

- worker-side missing collab URL may trigger fallback behavior in some paths
- signaling-server-side missing collab URL usually just disables disconnect webhook handling

### Worker/HMR confusion

Common trap:

- editing managed-runtime or process-swap code when the live path is dynlib + runner logic

Correct response:

1. Confirm the language and adapter family
2. Check registry and planner decisions
3. Trace through `handler.rs`, `integration.rs`, and `runner_logic.rs`

## Deletion vs Implementation Rules

When deciding what to do with backend modules:

- Delete if the module is redundant, test-only, or replaced by a live equivalent
- Implement if the subsystem is clearly product scope and already wired close to the main path
- Quarantine if the subsystem is coherent but not currently productized
- Keep as-is if it forms part of the current runtime contract or authoritative path

Examples:

- Runtime ABI contract files are keep-as-is unless a real consolidation plan exists
- Managed runtime support is usually quarantine-or-implement, not blind deletion
- Process-swap support is usually quarantine-or-implement, not blind deletion
- Duplicate compiler-side contract files are stronger delete candidates than runtime-side ones

## What Good Output Looks Like

For backend tasks, the expected result should usually include:

- the concrete failing service or subsystem
- the dependency or code path involved
- whether the fix belongs in code, config, or orchestration
- whether nearby modules should be deleted, implemented, or quarantined

Avoid generic backend advice. Keep it tied to Synthi's actual worker, signaling, collab, AI, and infrastructure layout.