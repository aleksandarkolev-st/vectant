# collab-server — exhaustive per-module reference

> Every module in `backend/collab-server/`, its role, dependencies, environment surface, and failure behavior. Generated from the working tree (main @ c41d83208); line numbers refer to current files.

## 1. Service shape

Single Node process exposing HTTP + WebSocket on one listener:

- **HTTP**: raw `req.url` routing in `backend/collab-server/server.js:L2178+` — no framework; every endpoint hand-matched.
- **WebSocket**: one `server.on('upgrade')` at `backend/collab-server/server.js:L6961` fans out by pathname:
  - preview-host requests → `proxyService.proxyWsUpgrade`
  - `/port/`, `/runtime/` → runtime proxy
  - `wsport/<slug>/<port>` → `containerPortProxy` (program ports incl. HMR)
  - `notifications`, `session-events` → dedicated lightweight WSS servers
  - `exec-pty/:id` → `terminalWss` (after gateway-auth rewrite of query params)
  - `yjs/<docName>` → Yjs doc sync; docName format `workspace:${slug}:user:${userId}:${path}` with `validateFilePath` traversal rejection
- `/collab` mount prefix stripped but preserved on the request for public URL reconstruction.

## 2. HTTP endpoint table (from req.url routing)

| Line | Method | Path | Purpose |
|---|---|---|---|
| `2215` | POST | `/api/spawner/session-ended` | signaling-driven teardown of worker pods |
| `2320` | POST | `/api/spawner/ensure` | ensure worker pod for session (warm/touch) |
| `2371` | POST | `/api/spawner/touch` | liveness touch |
| `2395` | POST | `/api/spawner/release` | release/hibernate pod |
| `2427` | GET | `/turn-credentials` | mint TURN credentials (coturn REST) |
| `2453` | WS | `/wsport/:slug/:port` | container port proxy (HMR etc.) |
| `2466` | GET/WS | `/runtime/*` | runtime proxy pass-through |
| `2473` | GET | `/preview-url` | preview URL resolution |
| `2480` | GET | `/runtime-callback` | runtime callback intake |
| `2486` | GET | `/ports` | port listing |
| `2502` | GET | `/codesite/readiness` | CodeSite readiness query |
| `2507` | GET | `/codesite/deployment-status` | deployment status |
| `2516` | GET | `/debug/status` | debug status dump |
| `2632` | GET | `/sse/:channel` | SSE event stream |
| `2648` | GET | `/telemetry/metrics` | performance metrics |
| `2657` | POST | `/telemetry/reset` | reset metrics |
| `2665` | GET | `/sse/stats` | SSE statistics |
| `2672` | GET | `/debug/validate/*` | validation debug |
| `2717` | GET | `/file-content/*` | raw file content |
| `2804` | GET | `/available-shells` | shell enumeration for terminal UI |
| `3633` | POST | `/exec-terminal/:id` | exec terminal session create |
| `3870` | WS | `/exec-pty/:id` | PTY stream |
| `4045` | POST | `/exec/:id` | one-shot exec |
| `4189` | GET | `/workspaces` | workspace list |
| `4209` | POST | `/migration/*` | repo structure migration triggers |
| `4253` | POST | `/user/block` | block user |
| `4282` | POST | `/user/unblock` | unblock user |
| `4313` | GET | `/user/blocked-list` | blocked users |
| `4337` | GET | `/presence/user/:id` | presence lookup |
| `4366` | GET | `/file-history/*` | file history |
| `4389` | GET | `/file-versions/*` | version list |
| `4413` | GET | `/file-version/:id` | single version |
| `4455` | POST | `/file-version/restore` | restore version |
| `4666` | POST | `/ysweet/token` | mint y-sweet client token |
| `4724` | GET | `/workspace-presence/*` | workspace presence |
| `4795` | POST | `/session/invite-user` | invite guest (host) |
| `4882` | POST | `/session/join-user` | join with invite token |
| `4996` | POST | `/session/join-by-code` | join by short code |
| `5052` | POST | `/session/request-join/:id` | knock |
| `5100` | * | `/session/*` | session lifecycle umbrella (admit/deny/terminate/permissions/rate budgets) |
| `5435` | * | `/git/*` | git operation dispatch into gitService |


## 3. Session lifecycle

Two distinct "session" concepts:

**(a) Collab sessions** (`SessionManager.js`, in-memory Maps by design): host owns the room; guests route into the host's per-user worktree `repos/<slug>/<hostId>/`. Default permissions `{canEdit:true, canTerminal:false, canGit:false, canFileOps:true}` (`backend/collab-server/SessionManager.js:L33`). Every mutation emits `persist:session`/`persist:delete` bridged to leveldb persistence (`backend/collab-server/server.js:L7304`). Guest→host effective-user mapping (`getEffectiveUserId`) lands all FS/git ops in the host tree while tokens/commit identity stay the guest's (`backend/collab-server/server.js:L5490`).

Join flow: `invite-user` → guest `join-user`/`join-by-code` or `request-join` knock → admit/deny → `terminate`. Rate budgets enforced per action in the route table region (`backend/collab-server/server.js:L5107`).

**(b) Runtime sessions** (worker pods): state machine `warming→ready→running→hibernated/migrating/crashed/terminated` tracked in-memory by `sessionLifecycle.js` layered over the spawner's lifecycle snapshot. Signaling server drives teardown via `POST /api/spawner/session-ended` (`backend/collab-server/workspacePodSpawner.js:L1479`).


## 4. Workspace lifecycle

1. **Prep**: `workspacePrepPlanner.js` fingerprints the repo tree (SHA-256 plan v1, skipping `.git/node_modules`) → `workspacePrepManager.js` orchestrates → `workspacePrepExecutor.js` executes against targets.
2. **Spawn**: three backends selected by env/K8s detection — `workspacePodSpawner.js` (K8s pods, 39 env knobs), `localWorkerSpawner.js` (docker, dev), `processWorkerSpawner.js` (bare process). Pod specs built by `runtimePodSpec.js` (20 knobs). Idle culler runs only inside K8s (`KUBERNETES_SERVICE_HOST` check at server bootstrap tail).
3. **Runtime container**: `workspaceRuntimeContainer.js` implements hybrid Phase-1 container runtime behind `ENABLE_CONTAINER_RUNTIME` / `ENABLE_CODESITE_DOCKER_RUNTIME`.
4. **Program runtimes**: `programRuntimeManager.js` TTLs headless (5 min) and idle (10 min) program instances.


## 5. Git service

`gitService.js` is a 5,266-line class with ~146 unique methods (full method list recovered below). Notable subsystems inside one class:

- **Dual-engine status/log paths**: node-git fast path with simple-git fallback (`_readStatusBundleWithNodeGit` vs `_readStatusBundleWithSimpleGit`, `_ensureStatusBundle`, `prewarmStatusCache`, `invalidateStatusCache*`).
- **Auth-token hygiene**: tokens encrypted at rest (`_resolveEncryptionKey`, `_encryptTokenForDisk`, `_persistAuthToken`, constant-time lookups), never logged.
- **CodeSite boundaries**: every mutation passes `_runCodeSiteMutationBoundary` / `_runCodeSiteGitWorktreeBoundary` / `_runCodeSiteGitIndexBoundary` / `_runCodeSiteGitRefsBoundary` / `_runCodeSiteGitConfigBoundary` (`_codeSiteBoundaryOptions` builds options; policy from `codesiteGitPolicy.js` PATH_SCOPED_INDEX_ACTIONS).
- **Migration to session worktrees**: `isLegacyRepo`/`isMigratedRepo`/`ensureMigrated`/`_migrateToSessionStructure` with backup/restore/validate markers; bare repos + per-session worktrees (`getSessionWorktreePath`, `ensureSessionWorktree`).
- **Per-user trees**: `ensureUserRepo`, `getUserRepoPath`, `getEffectiveRepoPath` implement the host-tree routing for guests.

Method inventory (unique names, constructor→end): constructor, toJSON, acquire, _resolveEncryptionKey, _encryptTokenForDisk, _decodeTokenFile, _safeAuthPathPart, _getAuthTokenPath, _persistAuthToken, _loadPersistedAuthToken, _authKey, _rememberAuthToken, _lookupStoredToken, _cacheKeyForRepoPath, _inferScopeFromRepoPath, _emptyStatus, _filterStatus, _normalizeBranchRefName, _buildStatusFileEntry, _pushUniquePath, _pushUniqueRename, _decorateCommitRef, _classifyDecoratedRef, _extractTokenFromHttpsUrl, _resolveAuthToken, _readCommitRefsWithNodeGit, _countCommitsWithNodeGit, _readLogWithNodeGit, _readLogWithSimpleGit, _readStatusBundleWithNodeGit, _readStatusBundleWithSimpleGit, _readStatusBundleByRepoPath, _ensureStatusBundle, prewarmStatusCache, invalidateStatusCache, invalidateStatusCacheByRepoPath, handleFilesystemEvents, withLock, mapGitError, _codeSiteBoundaryOptions, _runCodeSiteMutationBoundary, _runCodeSiteGitWorktreeBoundary, _runCodeSiteGitIndexBoundary, _runCodeSiteGitRefsBoundary, _runCodeSiteGitConfigBoundary, _extractTokenFromRemoteUrl, getRepoPath, getUserRepoPath, getEffectiveRepoPath, _archiveGitAsync, isRepoExists, isRepoInitialized, getGit, _ensureLocalExcludes, _writeExcludePatterns, _resolveCloneBranch, _resolveRemoteUrl, initRepo, cloneRepo, listWorkspaces, getStatus, getBranches, getTags, createTag, deleteTag, pushTag, checkout, fetch, _buildCommitEnv, _prepareCodeSiteCommitMessage, commit, _propagateToBare, interactiveRebase, rebaseAbort, rebaseContinue, stageFile, stageLines, discardLines, unstageLines, unstageFile, stageAll, unstageAll, discardAll, push, addRemote, removeRemote, setRemoteUrl, getRemotes, pull, discardChange, resolveConflictOurs, resolveConflictTheirs, markResolved, cherryPick, revertCommit, getCommitDetail, abortMerge, mergeBranch, checkMergeConflicts, getConflictVersions, getDiff, parseDiff, getLog, getBlame, parseBlame, stashList, stashPush, stashPop, stashDrop, stashApply, getUnpushedCommits, getIncomingCommits, syncFile, renameItem, deleteFile, deleteItem, listFiles, listFilesMeta, readFile, _sanitizeRelativePath, writeFile, createDirectory, writeFilesBatch, getFileContent, isLegacyRepo, isMigratedRepo, getBarePath, _writeMigrationMarker, _readMigrationMarker, _createMigrationBackup, _restoreMigrationBackup, _cleanupMigrationBackup, _migrateToSessionStructure, _seedBareFromUserRepos, _validateMigration, ensureMigrated, getSessionsDir, getSessionWorktreePath, ensureSessionWorktree, removeSessionWorktree, listSessionWorktrees, ensureUserRepo, isUserRepoInitialized, getUserGit, listUserRepos.


## 6. CodeSite guard layer

Five-field identity matching (`runtimeScope`, provider session ref, membership verification) with **fail-closed denial when authority is unreachable**:

- `codesiteControlPlaneTrust.js` — normalizes/validates control-plane claims; 7 env-configurable trust knobs.
- `codesiteFs.js` (2,755 LoC) — filesystem containment: path/symlink guards around every host write.
- `codesiteGitPolicy.js` — which git index actions are path-scoped.
- `codesiteActiveBoundary.js` — `AsyncLocalStorage` context so async call-chains keep their lease identity.
- `codesiteActivityRegistry.js` (658 LoC) — live lease/flight registry feeding readiness + activity endpoints.
- `codesiteHostWriteSentinel.js` — sentinel markers detect writes that bypassed leases.
- `codesiteReadiness.js` / `codesiteDeploymentStatus.js` — readiness/status surfaces for the IDE.
- `codesiteActivityEndpoint.js` — HTTP exposure of registry queries.


## 7. Terminals

`terminalService.js` (2,375 LoC, node-pty) spawns real shells bound to workspaces; `terminalRouting.js` decides routing; `agentTerminalLifecycle.js` manages agent-owned terminals; WS entry `/exec-terminal/:id` (create) + `/exec-pty/:id` (stream) with gateway-auth parameter rewrite (`backend/collab-server/server.js:L7020-7050`). `available-shells` enumerates shells for the UI.


## 8. Collaboration stack

- `yjsWsServer.js`: y-websocket protocol server; rooms are `workspace:${slug}:user:${userId}:${filePath}`; validates paths up-front.
- `ySweetBridge.js`: mints client tokens (`/ysweet/token` route) and reads/writes snapshots against y-sweet (@y-sweet/sdk).
- `sseService.js`: SSE fan-out (`/sse/:channel`, stats at `/sse/stats`).


## 9. Persistence

`persistence.js` (leveldb) consumes SessionManager mutation events; `continuousFlushService.js` batches flushes; `runtimePersistence.js` covers runtime-session state; `gcsSync.js` optionally mirrors artifacts to GCS.


## 10. Module inventory (all 67 JS files)

| Module | Lines | Requires | Env vars | Role |
|---|---|---|---|---|
| `server.js` | 7,440 | 45 | 18 | HTTP server + single WS upgrade router. Raw `req.url` routing for 42+ endpoints (spawner callbacks, turn credentials, exec/terminal/pty, git, session lifecycle, codesite readiness, SSE, telemetry, file versions, ysweet tokens, user blocks). Routes WS upgrades to preview-proxy, port/runtime proxy, wsport, notifications, session-events, terminal PTY (with gateway-auth param rewrite), and yjs doc sync with path-traversal validation. |
| `gitService.js` | 5,266 | 6 | 3 | 5,266-line git engine: 140+ public methods — repo init/clone; status bundles (node-git + simple-git dual path); commit/push/pull/fetch; branches/tags; rebase/cherry-pick/revert/conflict resolution (ours/theirs/markResolved); diff/blame/log parsing; stash family; file ops (read/write/batch/rename/delete); CodeSite mutation/worktree/index/refs/config boundaries (`_runCodeSite*Boundary`); token encryption at rest (`_encryptTokenForDisk`); bare-repo session-worktree migration (`ensureMigrated`, `_migrateToSessionStructure`); per-user repo trees (`ensureUserRepo`). |
| `codesiteFs.js` | 2,755 | 2 | 2 | CodeSite filesystem boundary: path/symlink containment and guarded write paths enforcing MutationLease scope on every host FS operation. |
| `terminalService.js` | 2,375 | 10 | 33 | PTY Terminal Service — spawns real shells via node-pty and bridges them to WS clients; sessions bound to workspaces (33 env vars: shells, limits, recording). |
| `workspacePodSpawner.js` | 1,937 | 5 | 39 | K8s/local worker-pod lifecycle: ensure/touch/release API surface, hibernation, signaling-driven teardown via `/api/spawner/session-ended`; richest env consumer (39 vars). |
| `proxyService.js` | 1,209 | 1 | 15 | Port scanner + reverse proxy (ported from the Rust web-term sidecar): preview hosts, WS upgrade proxying, per-port runtime routing. |
| `programRuntimeManager.js` | 965 | 0 | 1 | Headless/idle TTL management for program runtimes (defaults 5 min headless / 10 min idle). |
| `SessionManager.js` | 950 | 0 | 0 | In-memory collab-session registry: host-owned rooms, guest permissions {canEdit, canTerminal, canGit, canFileOps}, invite/knock/admit flows. |
| `workspaceRuntimeContainer.js` | 826 | 0 | 11 | Hybrid Phase-1 container runtime for workspaces (gated by ENABLE_CONTAINER_RUNTIME / ENABLE_CODESITE_DOCKER_RUNTIME). |
| `workspacePrepExecutor.js` | 712 | 3 | 10 | Executes prep plans against runtime targets. |
| `codesiteActivityRegistry.js` | 658 | 2 | 6 | Registry of live CodeSite activity (leases, flights) persisted under config dirs; feeds boundary checks and activity endpoints (6 env vars). |
| `workspaceInstructionProjectionService.js` | 634 | 1 | 0 | Physical projection lifecycle; deliberately ignorant of DB/git. |
| `fileIndex.js` | 608 | 0 | 0 | Workspace file indexing for search. |
| `persistence.js` | 607 | 1 | 11 | Leveldb persistence layer fed by `persist:session` / `persist:delete` events from SessionManager (11 env vars). |
| `fsWatcherService.js` | 595 | 0 | 2 | FS event watching feeding git-status invalidation + SSE pushes. |
| `codesiteHostWriteSentinel.js` | 590 | 1 | 2 | Detects out-of-band host writes that bypass leases (sentinel markers; 2 env vars). |
| `gcsSync.js` | 565 | 1 | 0 | Google Cloud Storage sync of workspace artifacts. |
| `collabGatewayAuth.js` | 463 | 0 | 0 | Gateway auth verification: workspaceUserId/filesystemUserId/runtimeScope/collabSessionId five-field identity matching; fail-closed denial when authority unreachable. |
| `workspacePrepManager.js` | 463 | 7 | 0 | Coordinates the planner→executor pipeline per workspace. |
| `workspaceInstructionGitIsolation.js` | 462 | 1 | 0 | Keeps instruction docs out of user git history. |
| `runtimePodTerminal.js` | 449 | 3 | 4 | Terminal attach to runtime pods (exec bridge). |
| `workspacePrepPlanner.js` | 424 | 0 | 1 | Fingerprints repo tree → deterministic prep plan v1 (skips .git/node_modules). |
| `ySweetBridge.js` | 416 | 1 | 0 | Token minting + snapshot read/write bridge to the y-sweet CRDT server (@y-sweet/sdk). |
| `repoCache.js` | 400 | 3 | 0 | Repo handle caching layer. |
| `localWorkerSpawner.js` | 390 | 2 | 12 | Local docker worker spawn path — dev alternative to K8s pods (12 env vars). |
| `workspaceInstructionProjectionConfig.js` | 379 | 2 | 0 | Projection configuration resolution. |
| `workspaceInstructionProjection.js` | 327 | 0 | 0 | Core projection model for passive workspace instruction documents. |
| `workspaceInstructionProjectionRuntime.js` | 315 | 6 | 0 | Runtime binding of projections (6 requires). |
| `runtimeFilesystem.js` | 312 | 4 | 0 | Runtime-side filesystem operations abstraction used by file APIs. |
| `runtimePodSpec.js` | 312 | 1 | 20 | Builds worker-pod specs from 20 env knobs (images, resources, node selectors). |
| `permissionMiddleware.js` | 310 | 2 | 0 | Per-request permission checks (canEdit/canTerminal/canGit/canFileOps). |
| `processWorkerSpawner.js` | 306 | 1 | 10 | Bare-process worker spawn path (10 env vars). |
| `codesiteActiveBoundary.js` | 274 | 1 | 0 | AsyncLocalStorage-based active-boundary context propagation (wraps codesiteActivityRegistry). |
| `perfTelemetry.js` | 245 | 1 | 0 | Backs `/telemetry/metrics` + reset endpoints. |
| `workspaceInstructionMetadataStore.js` | 234 | 2 | 0 | Instruction metadata persistence. |
| `sseService.js` | 230 | 0 | 0 | Server-sent events fan-out service (event streams to the IDE). |
| `agentSessionAttachService.js` | 228 | 2 | 1 | Agent attach handshake: `normalizeAgentBindingClaim` + execution-plan filing; channel auto-open rules. |
| `agentTerminalLifecycle.js` | 223 | 1 | 0 | Terminal lifecycle hooks for agent-owned sessions. |
| `yjsWsServer.js` | 209 | 0 | 0 | Yjs document sync WebSocket (y-websocket protocol); room names encode `workspace:${slug}:user:${userId}:${path}`; traversal-validated before load. |
| `workspaceInstructionIdePresentation.js` | 183 | 2 | 0 | IDE presentation mapping for instructions. |
| `runtimePersistence.js` | 178 | 0 | 0 | Runtime session persistence helpers. |
| `terminalRouting.js` | 177 | 0 | 0 | Terminal session routing decisions. |
| `continuousFlushService.js` | 174 | 0 | 3 | Periodic persistence flushing. |
| `config.js` | 173 | 1 | 36 | Central config: 36 env vars parsed once (ports, dirs, feature flags). |
| `sessionLifecycle.js` | 160 | 0 | 0 | Runtime-session state machine warming→ready→running→hibernated/migrating/crashed/terminated layered over spawner snapshots. |
| `runtimeObservationPublisher.js` | 156 | 1 | 1 | Publishes runtime observations to listeners. |
| `containerPortMonitor.js` | 150 | 0 | 0 | Watches container port bindings for the proxy table. |
| `codesiteGitPolicy.js` | 144 | 0 | 0 | Path-scoped index action policy (stage/stage-lines/unstage…). |
| `codesiteActivityEndpoint.js` | 115 | 2 | 2 | HTTP exposure of activity-registry queries (2 env vars). |
| `logger.js` | 115 | 1 | 3 | Structured logger. |
| `workspaceInstructionGitFilter.js` | 111 | 0 | 0 | Git filter predicates for instruction paths. |
| `containerPortProxy.js` | 106 | 0 | 0 | Proxies WS/TCP to container ports (`wsport/<slug>/<port>`). |
| `shadowContinuousProducer.js` | 100 | 1 | 3 | Produces shadow_continuous run events toward the AI tier. |
| `codesiteControlPlaneTrust.js` | 98 | 0 | 7 | Trust normalization/validation for control-plane claims (7 env-configurable trust knobs). |
| `workspaceManager.js` | 97 | 0 | 0 | Workspace registry helpers. |
| `codesiteReadiness.js` | 89 | 1 | 3 | Readiness computation consumed by `/codesite/readiness` (3 env vars). |
| `workspaceInstructionProjectionCollabAdapter.js` | 73 | 1 | 0 | Bridges projections into collab rooms. |
| `runtimeIdentity.js` | 68 | 0 | 3 | Per-runtime identity/uid mapping. |
| `codesiteDeploymentStatus.js` | 55 | 1 | 0 | Deployment status reporting for CodeSite projects. |
| `ensureRuntime.js` | 51 | 1 | 0 | Ensures the runtime image exists before spawn. |
| `workspaceAgentProtocol.js` | 51 | 0 | 0 | Agent protocol constants. |
| `workspaceInstructionProjectionObservability.js` | 50 | 0 | 0 | Projection observability counters. |
| `scaffold.js` | 39 | 0 | 0 | New-workspace scaffolding. |
| `spawner.js` | 39 | 0 | 2 | Spawner entry shim + idle-workspace culler start (K8s only). |
| `contextFiles.js` | 30 | 0 | 0 | Context-file assembly helper. |
| `test-connection.js` | 22 | 0 | 1 | Connectivity smoke-test utility. |


## 11. Environment surface

206 distinct env vars across the service. Heaviest consumers: `workspacePodSpawner.js` (39), `terminalService.js` (33), `config.js` (36), `proxyService.js` (15), `localWorkerSpawner.js` (12), `workspaceRuntimeContainer.js` (11). Key flags:

- `ENABLE_CONTAINER_RUNTIME`, `ENABLE_CODESITE_DOCKER_RUNTIME` — hybrid Phase-1 runtime gates
- `SYNTHI_RUNTIME_WORKSPACE_UMASK` — setgid-aware group-writable workspaces for rootless runtime peers (validated regex at server head)
- `LEVELDB_DIR` — persistence location
- `KUBERNETES_SERVICE_HOST` — gates K8s-only behaviors (idle culler)
- spawner family: image/resource/node-selector knobs consumed by `runtimePodSpec.js`


## 12. Failure behavior

- Gateway auth: fail-closed — if the control-plane authority cannot be reached, denials are returned rather than allowing through (`collabGatewayAuth.js`).
- Git status: dual-engine fallback node-git → simple-git → cached bundle; cache invalidation wired to fsWatcherService events.
- Spawner: pod loss surfaces as `crashed` in sessionLifecycle; signaling webhook `/api/spawner/session-ended` reconciles external terminations.
- Yjs: malformed/traversal docNames rejected before any disk access (`validateFilePath` throw path).
- Leveldb: write-behind via continuousFlush; crash windows bounded by flush interval.
