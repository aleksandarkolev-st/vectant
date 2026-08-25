---
tags: "backend", "control-plane"
system: Collab Server
source-repo: vectant-ade
generated: 2026-08-25
---

# Collab Server

> [!info] Provenance
> Deep-dive analysis generated from the live repository tree (`main` @ `ce74771af`, 2026-08-25).
> Raw source: `docs/obsidian-src/collab-server.md` in the repo. All paths below are repo-relative unless noted.

---
title: collab-server — Service Analysis
source: backend/collab-server
repo: vectant-ade
analyzed: 2026-08-25
tags: [vectant-ade, collab-server, node, crdt, yjs, workspace, architecture]
---

**collab-server (`backend/collab-server`)**

> Node.js control plane for the Synthi/Vectant IDE (`package.json` name: `synthi-collab-server`, main: `server.js`). One long-running process that owns: **workspace filesystems** (per-user git repos under `repos/<slug>/<userId>/`), **real-time collaboration** (Yjs CRDT relay + y-sweet bridge), **PTY terminals** (node-pty), **git operations**, **program runtimes** (host / per-workspace rootless-Docker container / K8s Sysbox runtime pod), **preview reverse-proxying** of dev-server ports, **session (remote-control) collaboration**, and the **CodeSite guard layer** that quarantines writes made inside active CodeSite agent transactions.
>
> ~38.9k lines of JS across ~70 modules; largest are `server.js` 7,440, `gitService.js` 5,266, `codesiteFs.js` 2,755, `terminalService.js` 2,375, `workspacePodSpawner.js` 1,937.

---

## 1. Role in the Monorepo

```
vectant-ade/
├── frontend (Next.js)      ──HTTP+WS──▶  collab-server :1234
├── ai-engine (FastAPI)     ◀─code-intel index POSTs──── collab-server
├── signaling-server (:9000) ──POST /api/spawner/session-ended──▶ collab-server
├── y-sweet (:8080)         ◀──REST tokens/doc IO─────── collab-server
├── redis (:6379)           ◀──optional persistence────── collab-server
├── postgres (:5432)        ✗ not used by collab-server (frontend/ai-engine only)
└── Docker daemon socket    ◀──dockerode──────────────── collab-server
```

- Compose service `collab-server` builds from `./backend/collab-server` and mounts `/var/run/docker.sock` **only** so it can manage per-workspace runtime containers (`docker-compose.yml:214`–`:320`).
- The ingress may mount the whole API under `/collab`; both HTTP and WS handlers strip the prefix and remember it in `_synthiExternalMountPrefix` for preview URL rewriting (`backend/collab-server/server.js:2170`).
- Boot order in compose: waits on redis + y-sweet healthy, ai-engine started; healthcheck polls its own `GET /codesite/readiness` (`docker-compose.yml:313`).

Refs: `backend/collab-server/package.json:1`, `backend/collab-server/docker-compose.yml` (root) `docker-compose.yml:214`

## 2. Process bootstrap & config

- `dotenv` is loaded first; if `SYNTHI_RUNTIME_WORKSPACE_UMASK` is an octal value the process applies it via `process.umask(...)` so new collaboration writes stay group-writable for the rootless runtime group (`backend/collab-server/server.js:4`).
- Central knobs live in `config.js`: `REPOS_DIR` (`config.js:16`), `LEVELDB_DIR` (`config.js:19`), `YSWEET_URL`/`YSWEET_AUTH_KEY` (`config.js:23`), `PORT = COLLAB_PORT || 1234` (`config.js:29`), `CODE_INTEL_URL` (`config.js:32`), GCS project/bucket/credentials block (`config.js:39`–`:76`), Cloudflare TURN credentials (`config.js:87`–`:93`), repo-cache and workspace-prep tunables (`config.js:101`–`:138`).
- Container runtime wiring at module load: `ENABLE_CONTAINER_RUNTIME === '1'` opt-in, `ENABLE_CODESITE_DOCKER_RUNTIME !== '0'` default-on; either creates the dockerode-backed `workspaceRuntime` manager (`backend/collab-server/server.js:181`).
- Graceful shutdown drains all four WS servers (notify/session/terminal/yjs) with close code 1001, flushes persistence, enforces `COLLAB_SHUTDOWN_DEADLINE_MS` (default 15 s) before hard exit (`backend/collab-server/server.js:7318`).

Refs: `backend/collab-server/config.js:16`, `backend/collab-server/server.js:181`

## 3. HTTP endpoint surface (raw `req.url` routing)

`server.createRequestHandler` is one giant if-chain over raw `req.url` strings/regexes — no router library. CORS echoes exact Origin + credentials; OPTIONS short-circuits; then `enforceOrigin` blocks naive cross-site mutations (`backend/collab-server/server.js:2188`). Preview-host requests (`p<port>-rt-*.preview.vectant.dev`) bypass everything into `proxyService.proxyHttpRequest` (`server.js:2183`).

| Route | Method | Purpose | Ref |
|---|---|---|---|
| `/api/spawner/session-ended` | any | signaling-server webhook: all peers gone → teardown pod/container | `server.js:2215` |
| `/api/session/:id/lifecycle` | GET | uniform warming/ready/running/hibernated/migrating/crashed snapshot (+ sysbox runtime slice) consumed by MCP `synthi_attach`/`synthi_health` | `server.js:2226` |
| `/api/session/:id/warm` | POST | pre-warm hibernated session (`spawner.warm`) | `server.js:2256` |
| `/api/session/:id/migrate` | POST | mark migrating state (phase-1 flag for MCP) | `server.js:2289` |
| `/api/spawner/ensure` | POST | ensure worker pod exists (+ fire-and-forget sysbox runtime pod); body `{session_id,user_id,workspace_slug,runtime_kind,filesystemUserId}`; runs `ensureRuntimeFilesystem` first | `server.js:2320` |
| `/api/spawner/touch` | POST | heartbeat keeping pod alive | `server.js:2371` |
| `/api/spawner/release` | POST | explicit teardown; guards `x-runtime-scope` mismatch (403 `runtime_scope_mismatch`) | `server.js:2395` |
| `/turn-credentials` | GET | short-lived Cloudflare Calls TURN creds, cached TTL `TURN_CREDENTIAL_TTL`; degrades to public STUN on error | `server.js:2427` |
| `/wsport/...` | any | container-program port proxy → `<runtime-container>:<N>` (HMR etc.) | `server.js:2453` |
| `/port/<N>/...`, `/runtime/<scope>/...` | any | reverse proxy into dev servers / runtime-scoped previews | `server.js:2466` |
| `/preview-url` | GET | resolve localhost terminal links to canonical `rt-*` HMAC preview URL | `server.js:2473` |
| `/runtime-callback` | POST | replay browser OAuth loopback callback into correct runtime pod | `server.js:2480` |
| `/ports` | GET | list detected dev-server ports | `server.js:2486` |
| `/codesite/activity/:slug` | GET/POST | CodeSite transaction activity publish/read (internal-token gated) | `server.js:2491` |
| `/codesite/readiness` | GET | probes CodeSite control-plane readiness of frontend | `server.js:2502` |
| `/codesite/deployment-status` | GET | overlay-capability + runtime-event probe report | `server.js:2507` |
| `/debug/status` | GET | server/persistence/ySweet/file-hash-cache dump | `server.js:2516` |
| `/api/workspace/:slug/prepare` | GET/POST | workspace prep status / trigger (canFileOps-gated, codesite provisioning guard, 202 async) | `server.js:2534` |
| `/sse/:slug` | GET | Server-Sent Events stream (see §10) | `server.js:2632` |
| `/telemetry/metrics`, `/telemetry/reset` | GET/POST | perf counters (`perfTelemetry.js`) | `server.js:2648` |
| `/sse/stats` | GET | SSE client counts | `server.js:2665` |
| `/debug/validate/:slug/:path` | GET | disk-vs-CRDT hash debug for one file | `server.js:2672` |
| `/file-content/:slug/:path` | GET | authoritative file read (auto-init repo + GCS hydration once per boot) | `server.js:2717` |
| `/available-shells` | GET | shells for terminal picker | `server.js:2804` |
| `/program-runtime/:slug/sessions[/:id[/:action]]` | GET/POST | managed program sessions list/detail/events/stop/restart | `server.js:2816` |
| `/program-runtime/:slug/launch-program` | POST | launch NormalizedProgramConfig recipe; gateway EXEC scope + codesite launch-mode gate | `server.js:2873` |
| `/exec-terminal/:slug` | POST | run command through managed PTY program session (60 s cap), returns captured output | `server.js:3633` |
| `/exec-pty/:slug` | POST | same but leaves interactive PTY attached | `server.js:3870` |
| `/exec/:slug` | POST | one-shot host exec | `server.js:4045` |
| `/workspaces?owner=&recent=` | GET | workspaceManager listing | `server.js:4189` |
| `/migration/:status|:trigger/:slug` | GET/POST | legacy→per-user repo migration status/manual trigger | `server.js:4209` |
| `/user/block`, `/user/unblock`, `/user/blocked-list` | POST/GET | user block lists | `server.js:4253` |
| `/presence/user/:id` | GET | online check across notify+session WS | `server.js:4337` |
| `/file-history/:slug/...`, `/file-versions/...`, `/file-version/restore` | GET/POST | Redis-backed file activity log + version snapshots | `server.js:4366` |
| `/ysweet/token` | POST | mint y-sweet client token; pre-issue disk↔CRDT hash reconcile resets stale docs | `server.js:4666` |
| `/workspace-presence/:slug` | GET | active users+sessions per workspace | `server.js:4724` |
| `/session/invite-user`, `/join-user`, `/join-by-code`, `/request-join/` | POST | remote-control join flows | `server.js:4795` |
| `/session/:action[/:sessionId]` | POST/GET/DELETE | full host/guest API: create/host/workspace-access/validate-token/knock/admit/deny/permissions/kick/leave/terminate/info/regenerate-token, with per-action rate budgets + sessionId format validation | `server.js:5100` |
| `/git/:slug/:action` | any | git dispatch (see §7) — 60+ actions | `server.js:5435` |

All exec-ish routes (`/exec*`, `/program-runtime/*launch-program`) require command-gateway auth (`requireCommandGatewayAuth` → scope `collab:exec`) before touching anything (`server.js:2884`, `server.js:3669`).

Refs: `backend/collab-server/server.js:2170`, `backend/collab-server/server.js:5100`

## 4. WebSocket surface (single `upgrade` handler)

One `server.on('upgrade')` multiplexes by path after stripping `/collab` (`backend/collab-server/server.js:6960`):

1. Preview hosts → `proxyService.proxyWsUpgrade`.
2. `/port/…`, `/runtime/…` → preview proxy WS.
3. `wsport/<slug>/<port>/…` → `containerPortProxy.proxyWsUpgrade` (container programs).
4. `notifications` → `notifyWss` — lightweight broadcasts; connection stores `ws._slug/_userId/_sessionId` from query params (`server.js:7188`).
5. `session-events` → `sessionWss` — collaboration events; `broadcastSessionEvent` / `sendToSessionHost` (with notify-WS fallback for knock delivery) / `sendToSessionUser` helpers target it (`server.js:6878`).
6. `terminal` → `terminalWss` after `authorizeTerminalGatewayRequest` (gateway-signed tokens verified against `AUTH_SECRET`/`NEXTAUTH_SECRET`; internal-token path also accepted). Gateway auth rewrites query to inject `userId/filesystemUserId/runtimeScope/collabSessionId` and strips secrets before the PTY server sees them (`server.js:7003`).
7. `yjs/<docName>` → `yjsWss` + `yjsWsServer.setupConnection`. Doc name format `workspace:<slug>:user:<userId>:<filePath>`; seeds initial content from disk only after `validateFilePath` + realpath-containment checks inside the acquired repo (`server.js:7041`).
8. Anything else is rejected 404 ("Y-Sweet handles CRDT WebSockets directly" when the client connects straight to y-sweet using the token URL).

Presence model: a user is online iff they hold an open notify-WS or session-WS (`isUserOnline`, `server.js:7119`); undeliverable events go to the Redis inbox (`deliverToUser`, `server.js:7160`).

Refs: `backend/collab-server/server.js:6960`, `backend/collab-server/server.js:7003`

## 5. Session lifecycle (remote-control sessions)

Two distinct "session" concepts:

**(a) Collab sessions** (`SessionManager.js`, in-memory Maps by design): Host owns the room; guests route into the host's per-user worktree `repos/<slug>/<hostId>/`. Permissions `{canEdit:true, canTerminal:false, canGit:false, canFileOps:true}` by default; host has full control (`backend/collab-server/SessionManager.js:33`). Every mutation emits `persist:session`/`persist:delete`, bridged to Redis persistence (`server.js:7304`). Effective user mapping: `sessionManager.getEffectiveUserId(guestId, sessionId)` resolves guest→host so all FS/git ops land in the host's tree while tokens/commit identity remain the guest's own (`server.js:5490`).

**(b) Runtime sessions** (worker pods): wire states `warming→ready→running→hibernated/migrating/crashed/terminated` tracked in-memory by `sessionLifecycle.js` and layered over the spawner's `lifecycleSnapshot` (`backend/collab-server/sessionLifecycle.js:1`). The signaling server drives teardown via `/api/spawner/session-ended` (`workspacePodSpawner.js:1479`).

Join flow: `create` ensures host repo via `gitService.ensureUserRepo` → invite token; guests hit `knock`→`admit`/`deny` or `join-by-code`; `terminate` ends room. Rate budgets per action live in the route table (`server.js:5107`).

Refs: `backend/collab-server/SessionManager.js:1`, `backend/collab-server/sessionLifecycle.js:1`

## 6. Workspace lifecycle

### 6.1 Prep (planner → manager → executor)
- `workspacePrepPlanner.js` fingerprints a repo tree (SHA-256 over plan v1, skipping `.git/node_modules/dist/...` at `WORKSPACE_PREP_SCAN_DEPTH`, default 8) and emits a task plan (`backend/collab-server/workspacePrepPlanner.js:6`).
- `workspacePrepManager.js` serializes per `(slug,userId)` scopes: state JSON persisted under `WORKSPACE_PREP_STATE_DIR`, bounded queue with `WORKSPACE_PREP_MAX_PARALLEL` (default 1), statuses exposed to `/api/workspace/:slug/prepare` GET (`backend/collab-server/workspacePrepManager.js:12`).
- `workspacePrepExecutor.js` runs tasks in the mode-matched sandbox: bare `child_process.spawn`, dockerode exec (`DOCKER_SOCKET_PATH`, `WORKER_IMAGE`, `WORKER_NETWORK`), or k8s Jobs with namespace/node-selector/tolerations env (`K8S_NAMESPACE`, `WORKSPACE_NODE_SELECTOR_*`, `WORKSPACE_NODE_TAINT_*`); captures an output tail capped at 24 KB and marks missing tools with `__SYNTHI_PREP_TOOL_MISSING__:` (`backend/collab-server/workspacePrepExecutor.js:13`).

### 6.2 Spawner (worker pods)
`spawner.js` is a dispatcher: `SPAWNER_MODE=process|local|k8s` picks `processWorkerSpawner` / `localWorkerSpawner` (dockerode) / `workspacePodSpawner` (@kubernetes/client-node); auto-detect falls back on `KUBERNETES_SERVICE_HOST` (`backend/collab-server/spawner.js:19`). All expose the same surface used by server.js: `ensurePod/touch/teardown/warm/lifecycleSnapshot/handleSessionEnded/startCuller`.

`workspacePodSpawner.js` details: one Deployment `rt-<base32hmac>` per session (name via `runtimeIdentity.runtimeResourceId`), watch-API readiness wait (`POD_READY_TIMEOUT_MS` default 120 s), lastActive annotation culling (`IDLE_TIMEOUT_MS` 10 min / `CULL_INTERVAL_MS` 60 s, `MAX_WORKSPACE_PODS` 50), PVC mount `WORKSPACE_DATA_PVC`→`WORKSPACE_REPOS_PATH`, optional preview sidecar (ports/env under `SYNTHI_PREVIEW_SIDECAR_*`), and the dark-launch Sysbox path: `spawnRuntimePod` builds a second container (`runtimePodSpec.buildRuntimeDeployment`) where terminals/programs exec via `runtimePodTerminal.js` (`k exec`-style streams into container `runtime`, workspace mounted `/workspace`) when `RUNTIME_BACKEND=sysbox-pod` (`backend/collab-server/workspacePodSpawner.js:1`, `runtimePodTerminal.js:14`).

### 6.3 Runtime container (hybrid Phase 1)
`workspaceRuntimeContainer.js` manages ONE rootless-dockerd container per `(workspaceSlug,userId)` for `container`-type programs: image `RUNTIME_IMAGE` (compose: `vectant-runtime:local`), network `WORKER_NETWORK`, idle TTL `RUNTIME_IDLE_TTL_MS`, cap `MAX_RUNTIME_CONTAINERS`; mounts the repo via named-volume subpath (`WORKSPACE_DATA_VOLUME` + `REPOS_VOLUME_SUBPATH` + `WORKSPACE_DATA_VOLUME_ROOT`) instead of host binds when collab itself is containerized; setgid/shared-group identity via `SYNTHI_RUNTIME_SHARED_GID` + umask `SYNTHI_RUNTIME_WORKSPACE_UMASK` (default `0002`); `RUNTIME_PRIVILEGED` toggles outer-container privilege (needed for userns on Docker Desktop, replaced by Sysbox runtimeClass in prod). Manager API: `ensureRuntimeContainer/waitForRuntimeReady/touch/teardown/listRuntimeSessions/probeOverlayCapability/execInRuntime/execInteractiveShell/cullIdle` (`backend/collab-server/workspaceRuntimeContainer.js:195`).

CodeSite overlay mode: `runtimeIdentityOptions` switches the container to `codesite-overlay` mode binding baseRoot:overlayRoot:upperRoot:workRoot so quarantined transactions get an overlayfs view (`workspaceRuntimeContainer.js:108`).

Prewarm: `ensureRuntime.js#handleEnsureRuntime` hydrates the per-user dir then warms dockerd in background (~15–25 s cold start avoided); rejects active CodeSite contexts with 409 `codesite_runtime_quarantine_unavailable` (`backend/collab-server/ensureRuntime.js:16`).

### 6.4 Program runtimes
`programRuntimeManager.js` tracks managed sessions (headless TTL 5 min, idle 10 min, output cap 50 KB) and **scrubs environment**: blocked keys include `DATABASE_URL/REDIS_URL/DOCKER_HOST/YSWEET_AUTH_KEY/NEXTAUTH_SECRET...`, blocked prefixes `DATABASE_*,GCP_*,POSTGRES_*,REDIS_*,PRISMA_*,YSWEET_...` plus generic `*API_KEY/*TOKEN/*SECRET/*PASSWORD` patterns — programs never inherit control-plane secrets (`backend/collab-server/programRuntimeManager.js:8`). Continuous editor→disk flush for container/webGui programs is handled by `continuousFlushService.js` (`SYNTHI_CONTINUOUS_FLUSH_ENABLED`, `SYNTHI_FLUSH_INTERVAL_MS`, `SYNTHI_FLUSH_DEBOUNCE_MS`), calling back into `flushWorkspaceDocsToDisk` (`server.js:365`).

Refs: `backend/collab-server/spawner.js:19`, `backend/collab-server/workspaceRuntimeContainer.js:195`, `backend/collab-server/programRuntimeManager.js:8`

## 7. Terminal routing & service

- `terminalRouting.js` is pure decision logic: `shouldUseContainerTerminal({enableContainerRuntime, workspaceRuntime, workspaceSlug})`; `codeSiteTerminalLaunchMode` returns `normal | overlay-runtime | block-runtime | block-host` depending on codesite context + hybrid availability; `codeSiteTerminalReattachDecision` denies reattach unless transactionId/mutationLeaseId/agentSessionId/workspaceSlug all match the existing session (`backend/collab-server/terminalRouting.js:7`).
- `terminalService.js` owns node-pty sessions: JSON control frames over text WS + raw stdin bytes as binary frames; `ready/exit/error/pong` frames back; fs-watcher attach per workspace; headless sessions for AI (`createHeadlessSession`); shell enumeration for `/available-shells`. It consults routing to spawn either a host pty, a runtime-container pty (`execInteractiveShell`), a sysbox runtime-pod pty (`createRuntimePodPty`), or a codesite overlay workspace pty; agent-bound terminals go through `agentTerminalLifecycle` (`backend/collab-server/terminalService.js:29`).
- Agent terminals: `agentSessionAttachService.attach()` POSTs to the CodeSite control plane `/projects/:projectId/agent-sessions/attach` and validates the returned binding (collaborationSessionId, ownerUserId, effectiveWorkspaceUserId, providerSessionRef, runtimeScope...) against gateway-auth claims; heartbeats every 30 s; detach carries reason/ended (`backend/collab-server/agentTerminalLifecycle.js:34`, `agentSessionAttachService.js:125`).

Refs: `backend/collab-server/terminalRouting.js:7`, `backend/collab-server/terminalService.js:29`

## 8. Git service

`gitService.js` (5,266 lines): class `GitService` over `simple-git` (+ optional `nodegit` for blame/log fast paths). Key behaviors:
- Per-user repos: `getEffectiveRepoPath(slug, userId)` → `repos/<slug>/<userId>/`; `initRepo/cloneRepo/ensureUserRepo/ensureMigrated` handle hydration from GCS (`.git` archive restore for fast re-hydration, full upload after clone) (`backend/collab-server/gitService.js:1687`, `:1960`).
- Repo-level mutex `withLock(slug, ...)` serializes mutations (`gitService.js:1233`).
- Token store: PATs cached per user; encrypted at rest with `SYNTHI_TOKEN_ENCRYPTION_KEY` (32-byte base64) or derived from `SYNTHI_TOKEN_ENCRYPTION_PASSPHRASE` via scrypt; warns plaintext otherwise (`gitService.js:360`).
- Guest semantics: server.js splits *repo identity* (effective/host user) from *token identity* (requesting user, with fallback to host bucket) and pins `GIT_AUTHOR_*/GIT_COMMITTER_*` per-request so guest commits attribute correctly; non-ASCII names arrive `b64:`-prefixed (`server.js:5505`).
- Action dispatch: 60+ cases — remotes, clone/status/branches/checkout/fetch/commit/stage(-all/-lines)/unstage*/push/pull/discard*/merge/conflict tooling/rebase/cherry-pick/tags/stash/sync/blame/log/files/write-file/write-files-batch/create-directory/delete-item/rename-item/apply-shadow-patch/github-info (`server.js:5700`–`:6726`).
- Atomic writes with post-write hash verification + binary detection (`safeWriteFile`, `gitService.js:84`).
- Codesite hooks wrap ref-mutating ops via `shouldRunCodeSiteGitBoundary` policy (`codesiteGitPolicy.js` action sets: PATH_SCOPED_INDEX_ACTIONS, REPO_WORKTREE_ACTIONS, GIT_REF_ACTIONS incl. commit/push/pull) and `_runCodeSiteGitRefsBoundary` (`gitService.js:2785`).

Refs: `backend/collab-server/gitService.js:352`, `backend/collab-server/server.js:5435`

## 9. CodeSite guard layer

CodeSite = managed agent-transaction subsystem whose authority lives in the frontend control plane; collab-server enforces boundaries locally.

- **codesiteControlPlaneTrust.js** — derives the trusted control-plane base URL per workspace: explicit `SYNTHI_CODESITE_API_BASE_URL` / `CODESITE_API_BASE_URL` / `SYNTHI_CODESITE_BASE_URL` win over generic app origins (`SYNTHI_APP_INTERNAL_URL`, `NEXTAUTH_URL`, …); `{workspace_slug}` templating; fails closed when unset (`backend/collab-server/codesiteControlPlaneTrust.js:27`).
- **codesiteFs.js** (2,755 lines) — the vocabulary of the boundary: `CodeSiteFSDeniedError` (403 `CODESITE_READ_DENIED`/`CODESITE_WRITE_DENIED`), `CodeSiteCommitBlockedError` (409), path normalization rejecting traversal/null bytes, quarantine workspaces (`createCodeSiteQuarantineWorkspace` → manifest schema `synthi.codesitefs.quarantineManifest.v1` under `%TMP%/synthi-codesitefs-quarantine`), overlay workspace creation, process-ancestry capture (procfs depth 32), evidence refs, and env injection `CODESITE_TRANSACTION_ID/MUTATION_LEASE_ID/CALLSIGN/ALLOWED_PATHS/BLOCKED_PATHS/ALLOWED_TOOLS/EVIDENCE_REFS/PROCESS_ANCESTRY/SYNTHI_CODESITE_API_BASE_URL` for spawned runtimes (`backend/collab-server/codesiteFs.js:17`, `:380`).
- **codesiteActivityRegistry.js** — tracks active transactions per workspace with file-persisted state (`active-transactions.json` under `CODESITE_ACTIVITY_STATE_DIR`, TTL `SYNTHI_CODESITE_ACTIVE_TTL_MS` default 30 min, refresh timeout 1500 ms, lock-stale 30 s); authoritative sources like `next_codesite_route` keep records writable (`backend/collab-server/codesiteActivityRegistry.js:8`).
- **codesiteGitPolicy.js** — classifies git actions (index/worktree/ref/provisioning sets above) so the boundary wraps exactly the dangerous ones (`backend/collab-server/codesiteGitPolicy.js:3`).
- **codesiteActiveBoundary.js** — AsyncLocalStorage carrying the boundary context through nested operations; `assertCodeSiteWorkspaceMutationAllowedAsync`, `guardCodeSiteHostSurface`, `withCodeSiteBoundaryContext` used by server routes and gitService (`backend/collab-server/codesiteActiveBoundary.js:44`).
- **codesiteHostWriteSentinel.js** — standalone watchdog for a repoRoot during a transaction: snapshots a baseline, optionally arms a pre-write guard (`SYNTHI_CODESITE_HOST_PREWRITE_GUARD`), scans every 1 s for out-of-band host writes, quarantines offenders into baselines dir (`%TMP%/synthi-codesite-host-sentinel`, override `SYNTHI_CODESITE_HOST_SENTINEL_DIR`), and emits manifests for later replay (`backend/collab-server/codesiteHostWriteSentinel.js:280`).
- Supporting endpoints: `codesiteActivityEndpoint.js` (internal-token auth via `COLLAB_INTERNAL_TOKEN`, fails closed 503 when unconfigured), `codesiteReadiness.js` (control-plane `/readiness` probe with sentinel slug `__codesite_readiness__`), `codesiteDeploymentStatus.js` (`backend/collab-server/codesiteActivityEndpoint.js:15`, `codesiteReadiness.js:8`).

Server integration points: every mutating HTTP route builds a codesite context (`codeSiteContextFromRequest`), calls `enforceCodeSiteProvisioningAllowed`/`guardCodeSiteRuntimeHostSurface`, and maps errors to `writeCodeSiteDenied` responses (`server.js:2544`, `:2905`).

Refs: `backend/collab-server/codesiteFs.js:17`, `backend/collab-server/codesiteActivityRegistry.js:8`

## 10. SSE service

`sseService.js` — slug-scoped `text/event-stream` registry replacing polling for `git-status-changed`, `file-tree-changed`, `file-saved`, `build-completed`, `workspace-presence`, `healing-stats-update`, `code-intel-metrics`; 15 s heartbeat; typed emitters `notifyGitStatusChanged` etc. call `broadcastToSlug`; `GET /sse/stats` exposes client counts (`backend/collab-server/sseService.js:66`, `:121`).

Refs: `backend/collab-server/sseService.js:66`

## 11. Persistence

- **Primary hot state is memory.** Optional **Redis** adapter (`persistence.js`) mirrors SessionManager sessions + block lists, file activity logs (LTRIM-bounded 100/file, TTL 30 d), file version history (10/file, content ≤128 KiB inline else metadata-only), offline user inboxes (50/user, TTL 14 d). Degrades to no-op without `REDIS_URL`; write queue (1,000) with retry/backoff drains on reconnect (`backend/collab-server/persistence.js:1`).
- **LEVELDB_DIR** is exported by `config.js:19` but has no consumer inside backend/ today — leveldb is vestigial config surface (no `require('level…')` anywhere in the service; package.json ships no level dependency). Treat "leveldb persistence" as planned/deprecated.
- Boot restore: sessions + blocks reloaded from Redis before listen; logged as `sessions_restored`/`blocks_restored` (`server.js:7398`).

Refs: `backend/collab-server/persistence.js:1`, `backend/collab-server/config.js:19`

## 12. CRDT collaboration (yjs + y-sweet)

- **In-process relay**: `yjsWsServer.js` implements the y-websocket sync protocol (messageSync/messageAwareness, lib0 encoders) with `MAX_ROOMS=5000`, 30 s GC grace for empty rooms, close code 1013 on capacity; Monaco text lives in `doc.getText('monaco')` seeded from disk (`backend/collab-server/yjsWsServer.js:1`).
- **y-sweet bridge**: `ySweetBridge.js` talks REST to y-sweet via `@y-sweet/sdk` DocumentManager at `YSWEET_URL`(+`?auth=YSWEET_AUTH_KEY`); doc IDs are reversible base64url of room keys because y-sweet 0.9.x restricts ID charset; provides `getOrCreateToken`, `readDocContent`, `resetDocContent` (`backend/collab-server/ySweetBridge.js:1`).
- **Consistency loop**: editor saves flush CRDT → disk (`flushWorkspaceDocsToDisk` iterates rooms by prefix, `server.js:1723`); out-of-band disk changes clear the hash cache and broadcast `doc-invalidated` over notifyWss so clients destroy+reconnect their Y.Docs (`invalidateDocsForSlug`, `server.js:1746`); `/ysweet/token` reconciles disk-vs-CRDT hashes before minting tokens, resetting stale docs (`server.js:4694`). Both transports coexist: local relay at `/yjs/...` for tabs, direct-to-y-sweet for token-bearing clients.

Refs: `backend/collab-server/yjsWsServer.js:1`, `backend/collab-server/server.js:4666`

## 13. Logical dependencies

| Dependency | Used for | Evidence |
|---|---|---|
| **frontend (Next.js)** | CodeSite control plane (attach/lifecycle/readiness/activity), NextAuth-derived headers, terminal gateway token signing | `agentSessionAttachService.js:125`, compose `docker-compose.yml:240` |
| **signaling-server** | webhook `/api/spawner/session-ended` on peer disconnect; workers dial `WORKER_SIGNALING_URL` | `server.js:2215`, `localWorkerSpawner.js:25` |
| **y-sweet** | CRDT document store/relay (tokens, doc IO) | `ySweetBridge.js:47`, compose `docker-compose.yml:247` |
| **redis** | optional session/block/version/inbox persistence | `persistence.js:29` |
| **ai-engine** | code-intel indexing POSTs (`CODE_INTEL_URL/code-intel/index/file`) when `CODE_INTEL_AUTO_INDEX` | `server.js:1345` |
| **Docker daemon** | per-workspace runtime containers, prep jobs (local mode) | `server.js:188`, `workspacePrepExecutor.js:9` |
| **Kubernetes API** | k8s spawner + sysbox runtime pods + prep Jobs | `workspacePodSpawner.js:41` |
| **GCS** | workspace/archive sync (bucket creds in config) | `gcsSync.js:1`, `config.js:39` |
| **Cloudflare Calls TURN** | `/turn-credentials` (token id + api token), local coturn fallback | `config.js:87`, compose `LOCAL_TURN_*` |
| **postgres** | ✗ none — `DATABASE_URL` appears only in program-env denylist; DB belongs to frontend/ai-engine | `programRuntimeManager.js:10` |

MCP consumers poll `/api/session/:id/lifecycle` for `synthi_attach`/`synthi_health` (comment at `server.js:2220`).

## 14. Environment variables consumed

Core: `COLLAB_PORT`, `COLLAB_LOG_LEVEL/_FORMAT/_SERVICE`, `CORS_ORIGIN`, `COLLAB_ALLOWED_ORIGINS`, `COLLAB_SHUTDOWN_DEADLINE_MS`, `NODE_ENV` (implicit).

Auth/trust: `AUTH_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `AI_BACKEND_AUTH_TOKEN`/`AI_ENGINE_AUTH_TOKEN`, `COLLAB_INTERNAL_TOKEN` (activity endpoint + trusted internal header), `SYNTHI_WORKSPACE_AUTH_BYPASS`, `SYNTHI_TOKEN_ENCRYPTION_KEY`, `SYNTHI_TOKEN_ENCRYPTION_PASSPHRASE`.

CRDT: `YSWEET_URL`, `YSWEET_AUTH_KEY`.

Storage: `REPOS_DIR`, `REPO_CACHE_DIR`, `REPO_CACHE_MAX`, `REPO_CACHE_TTL_MS`, `REPO_CACHE_DELETE_ON_EVICT`, `LEVELDB_DIR` (vestigial), `REDIS_URL`, `COLLAB_REDIS_PREFIX/_SESSION_TTL_SEC/_BLOCK_TTL_SEC/_EVENT_TTL_SEC/_VERSION_TTL_SEC/_INBOX_TTL_SEC/_MAX_EVENTS/_MAX_VERSIONS/_MAX_INBOX/_MAX_VERSION_BYTES`, GCS block `GCP_PROJECT_ID|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT`, `GCS_BUCKET_NAME`, `GCP_CLIENT_EMAIL`, `GCP_PRIVATE_KEY`, `GCP_CREDENTIALS`, `GCS_WORKSPACE_PREFIX`, `GCS_SYNC_ON_FLUSH`.

Workspace prep: `WORKSPACE_PREP_STATE_DIR`, `WORKSPACE_PREP_MAX_PARALLEL`, `WORKSPACE_PREP_JOB_TIMEOUT_MS`, `WORKSPACE_PREP_LOCAL_VOLUME`, `WORKSPACE_PREP_MOUNT_PATH`, `WORKSPACE_PREP_PVC_NAME`, `WORKSPACE_PREP_SCAN_DEPTH`.

Spawner/k8s: `SPAWNER_MODE`, `SPAWNER_CLEANUP_ON_SHUTDOWN`, `KUBERNETES_SERVICE_HOST`, `K8S_NAMESPACE`, `WORKER_IMAGE`, `WORKER_NETWORK`, `WORKER_SIGNALING_URL`, `WORKER_COLLAB_URL`, `WORKER_AI_BACKEND_URL`, `WORKER_LOG_LEVEL`, `IDLE_TIMEOUT_MS`, `CULL_INTERVAL_MS`, `MAX_WORKSPACE_PODS`, `POD_READY_TIMEOUT_MS`, `MAX_RUNTIME_PODS`, `WORKSPACE_NODE_SELECTOR_KEY/_VALUE`, `WORKSPACE_NODE_TAINT_KEY/_VALUE/_EFFECT`, `WORKSPACE_DATA_PVC`, `WORKSPACE_DATA_MOUNT`, `WORKSPACE_REPOS_PATH`.

Runtime containers/sysbox: `ENABLE_CONTAINER_RUNTIME`, `ENABLE_CODESITE_DOCKER_RUNTIME`, `RUNTIME_BACKEND`, `RUNTIME_IMAGE`, `RUNTIME_IDLE_TTL_MS`, `MAX_RUNTIME_CONTAINERS`, `RUNTIME_PRIVILEGED`, `DOCKER_SOCKET_PATH`, `WORKSPACE_DATA_VOLUME`, `REPOS_VOLUME_SUBPATH`, `WORKSPACE_DATA_VOLUME_ROOT`, `SYNTHI_RUNTIME_SHARED_GID`, `SYNTHI_RUNTIME_WORKSPACE_UMASK`, `SYNTHI_TERMINAL_K8S_CONTAINER`, `SYNTHI_TERMINAL_PORT_RANGE_START/_SIZE`.

Preview/proxy: `PROXY_TARGET_HOST`, `PROXY_SCAN_PORTS`, `SYNTHI_PREVIEW_TARGET_TEMPLATE`, `SYNTHI_PREVIEW_SIDECAR_PORT/_PREFIX/_IMAGE/_TIMEOUT_MS`, `SYNTHI_PREVIEW_PUBLIC_DOMAIN/_PROTOCOL/_PREFIX`, `SYNTHI_PREVIEW_SCAN_PORTS/_EXCLUDE_PORTS/_INFRA_PORTS/_PORT_PROBE_TIMEOUT_MS/_BIND_HOST`, `SYNTHI_APP_URL`, `SYNTHI_APP_INTERNAL_URL`, `SYNTHI_PUBLIC_APP_URL`.

TURN: `CLOUDFLARE_TURN_TOKEN_ID`, `CLOUDFLARE_TURN_API_TOKEN`, `TURN_CREDENTIAL_TTL`, `LOCAL_TURN_URL`, `LOCAL_TURN_USERNAME`, `LOCAL_TURN_CREDENTIAL`.

AI/intel: `CODE_INTEL_URL`, `CODE_INTEL_AUTO_INDEX`.

CodeSite: `SYNTHI_CODESITE_API_BASE_URL`, `CODESITE_API_BASE_URL`, `SYNTHI_CODESITE_BASE_URL`, `SYNTHI_CODESITE_TOKEN`, `SYNTHI_CODESITE_COOKIE`, `SYNTHI_CODESITE_ACTIVE_TTL_MS`, `SYNTHI_CODESITE_ACTIVE_REFRESH_TIMEOUT_MS`, `SYNTHI_CODESITE_ACTIVITY_STATE_DIR`, `SYNTHI_CODESITE_ACTIVITY_PERSISTENCE`, `SYNTHI_CODESITE_ACTIVITY_STATE_FILE`, `SYNTHI_CODESITE_HOST_SENTINEL_DIR`, `SYNTHI_CODESITE_HOST_PREWRITE_GUARD`, `SYNTHI_CODESITE_READINESS_WORKSPACE_SLUG`, `WORKSPACE_INSTRUCTION_METADATA_DIR`.

Flush/toolchain detection: `SYNTHI_CONTINUOUS_FLUSH_ENABLED`, `SYNTHI_FLUSH_INTERVAL_MS`, `SYNTHI_FLUSH_DEBOUNCE_MS`; SDK roots probed for toolchains: `ANDROID_SDK_ROOT/ANDROID_HOME`, `DART_SDK/DART_HOME`, `FLUTTER_ROOT/FLUTTER_HOME/FLUTTER_SDK`, `JAVA_HOME`, `GRADLE_HOME`, `CLAUDE_BIN_DIR`.

Refs: `backend/collab-server/config.js:16`, `backend/collab-server/workspacePodSpawner.js:60`, `backend/collab-server/workspaceRuntimeContainer.js:32`

## 15. Notable risks / observations

- Monolithic raw-string router in `server.js` (7.4k lines) makes route inventory brittle — no 404 fallthrough logging except unknown WS upgrades; unmatched HTTP hangs until client timeout (verify: chain ends without explicit 404).
- `/file-content`, `/git/*`, presence and several debug routes accept identity from headers/query (`x-user-id`) with no signature — trust boundary relies on network position + gateway auth only for exec/terminal scopes (`server.js:2735`).
- `LEVELDB_DIR` dead config (§11) — remove or implement.
- Sentinel + quarantine dirs default to OS temp (`codesiteFs.js:20`, `codesiteHostWriteSentinel.js:18`) — survivability across reboots depends on explicit env overrides.
- Program env scrubbing (`programRuntimeManager.js:8`) is thorough but pattern-based; new secret-shaped vars must match the deny patterns.

---

## Related notes

[[Synthi Frontend]] · [[Rust Systems]] · [[MCP Synthi]] · [[Infra Deployment]]

[[00 Home|🏠 Back to Home]]
