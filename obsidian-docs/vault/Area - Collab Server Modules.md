---
tags: "backend", "modules"
type: exhaustive-area-reference
source-repo: vectant-ade
generated: 2026-08-25
---

# Area - Collab Server Modules

> [!info] Exhaustive reference — every module/route/file in this area, with `path:LNN` citations. Raw source: `docs/obsidian-src/area-collab-server.md`.

---
title: "Area — backend/collab-server"
source-tree: backend/collab-server
generated: 2026-08-25
tags: [obsidian-src, area, backend, collab-server]
---

**Area: `backend/collab-server`**

Exhaustive per-module analysis of the collaboration server backend. Every module under `backend/collab-server/` gets a section covering: purpose, key functions with signatures, HTTP endpoints / WebSocket paths served, module dependencies (`require`s), environment variables read, and failure behavior. References use the form `backend/collab-server/<file>:L<line>`.

## Inventory

| Lines | File |
|---:|---|
| 8 | `.dockerignore` |
| 157 | `.env.example` |
| 28 | `.gitignore` |
| 284 | `__tests__/agentSessionAttachService.test.js` |
| 220 | `__tests__/agentTerminalLifecycle.test.js` |
| 600 | `__tests__/codesiteActiveBoundary.test.js` |
| 223 | `__tests__/codesiteActivityEndpoint.test.js` |
| 540 | `__tests__/codesiteActivityRegistry.test.js` |
| 70 | `__tests__/codesiteDeploymentStatus.test.js` |
| 1723 | `__tests__/codesiteFs.test.js` |
| 166 | `__tests__/codesiteGitPolicy.test.js` |
| 204 | `__tests__/codesiteHostWriteSentinel.test.js` |
| 93 | `__tests__/codesiteReadiness.test.js` |
| 268 | `__tests__/collabGatewayAuth.test.js` |
| 140 | `__tests__/containerPortMonitor.test.js` |
| 166 | `__tests__/containerPortProxy.test.js` |
| 34 | `__tests__/contextFiles.test.js` |
| 160 | `__tests__/continuousFlushService.test.js` |
| 70 | `__tests__/ensureRuntimeRoute.test.js` |
| 187 | `__tests__/fsWatcherService.test.js` |
| 1780 | `__tests__/gitServiceCodesiteBoundary.test.js` |
| 848 | `__tests__/programRuntimeManager.test.js` |
| 60 | `__tests__/repoCacheCodesiteBoundary.test.js` |
| 426 | `__tests__/runtimeFilesystem.test.js` |
| 99 | `__tests__/runtimeObservationPublisher.test.js` |
| 154 | `__tests__/runtimePodSpawner.test.js` |
| 313 | `__tests__/runtimePodSpec.test.js` |
| 42 | `__tests__/runtimePodTerminal.test.js` |
| 46 | `__tests__/scaffold.test.js` |
| 109 | `__tests__/sessionWorkspaceAccess.test.js` |
| 42 | `__tests__/terminalEnvironment.test.js` |
| 302 | `__tests__/terminalRouting.test.js` |
| 300 | `__tests__/terminalServiceAgentLifecycle.test.js` |
| 92 | `__tests__/workflowBridgeDojoEnv.test.js` |
| 17 | `__tests__/workspaceAgentProtocol.test.js` |
| 235 | `__tests__/workspaceInstructionGitIsolation.test.js` |
| 139 | `__tests__/workspaceInstructionIdePresentation.test.js` |
| 111 | `__tests__/workspaceInstructionMetadataStore.test.js` |
| 134 | `__tests__/workspaceInstructionProjection.test.js` |
| 63 | `__tests__/workspaceInstructionProjectionCollabAdapter.test.js` |
| 139 | `__tests__/workspaceInstructionProjectionConfig.test.js` |
| 33 | `__tests__/workspaceInstructionProjectionObservability.test.js` |
| 197 | `__tests__/workspaceInstructionProjectionRuntime.test.js` |
| 303 | `__tests__/workspaceInstructionProjectionService.test.js` |
| 60 | `__tests__/workspaceManager.test.js` |
| 172 | `__tests__/workspacePrepManager.test.js` |
| 541 | `__tests__/workspaceRuntimeContainer.test.js` |
| 137 | `__tests__/writeFilesBatchEncoding.test.js` |
| 228 | `agentSessionAttachService.js` |
| 223 | `agentTerminalLifecycle.js` |
| 274 | `codesiteActiveBoundary.js` |
| 115 | `codesiteActivityEndpoint.js` |
| 658 | `codesiteActivityRegistry.js` |
| 98 | `codesiteControlPlaneTrust.js` |
| 55 | `codesiteDeploymentStatus.js` |
| 2755 | `codesiteFs.js` |
| 144 | `codesiteGitPolicy.js` |
| 590 | `codesiteHostWriteSentinel.js` |
| 89 | `codesiteReadiness.js` |
| 463 | `collabGatewayAuth.js` |
| 173 | `config.js` |
| 150 | `containerPortMonitor.js` |
| 106 | `containerPortProxy.js` |
| 30 | `contextFiles.js` |
| 174 | `continuousFlushService.js` |
| 71 | `Dockerfile` |
| 51 | `ensureRuntime.js` |
| 608 | `fileIndex.js` |
| 595 | `fsWatcherService.js` |
| 565 | `gcsSync.js` |
| 5266 | `gitService.js` |
| 390 | `localWorkerSpawner.js` |
| 115 | `logger.js` |
| 4219 | `package-lock.json` |
| 33 | `package.json` |
| 245 | `perfTelemetry.js` |
| 310 | `permissionMiddleware.js` |
| 607 | `persistence.js` |
| 306 | `processWorkerSpawner.js` |
| 965 | `programRuntimeManager.js` |
| 1209 | `proxyService.js` |
| 27 | `README.md` |
| 400 | `repoCache.js` |
| 312 | `runtimeFilesystem.js` |
| 68 | `runtimeIdentity.js` |
| 156 | `runtimeObservationPublisher.js` |
| 178 | `runtimePersistence.js` |
| 41 | `runtimePersistence.test.js` |
| 312 | `runtimePodSpec.js` |
| 449 | `runtimePodTerminal.js` |
| 39 | `scaffold.js` |
| 7440 | `server.js` |
| 160 | `sessionLifecycle.js` |
| 950 | `SessionManager.js` |
| 100 | `shadowContinuousProducer.js` |
| 39 | `spawner.js` |
| 230 | `sseService.js` |
| 177 | `terminalRouting.js` |
| 2375 | `terminalService.js` |
| 22 | `test-connection.js` |
| 51 | `workspaceAgentProtocol.js` |
| 111 | `workspaceInstructionGitFilter.js` |
| 462 | `workspaceInstructionGitIsolation.js` |
| 183 | `workspaceInstructionIdePresentation.js` |
| 234 | `workspaceInstructionMetadataStore.js` |
| 327 | `workspaceInstructionProjection.js` |
| 73 | `workspaceInstructionProjectionCollabAdapter.js` |
| 379 | `workspaceInstructionProjectionConfig.js` |
| 50 | `workspaceInstructionProjectionObservability.js` |
| 315 | `workspaceInstructionProjectionRuntime.js` |
| 634 | `workspaceInstructionProjectionService.js` |
| 97 | `workspaceManager.js` |
| 1937 | `workspacePodSpawner.js` |
| 591 | `workspacePodSpawner.js.backup` |
| 712 | `workspacePrepExecutor.js` |
| 463 | `workspacePrepManager.js` |
| 424 | `workspacePrepPlanner.js` |
| 826 | `workspaceRuntimeContainer.js` |
| 23 | `workspaces.json` |
| 209 | `yjsWsServer.js` |
| 416 | `ySweetBridge.js` |

## Architecture at a glance

<<<SEC:_arch>>>

## Module reference

## Group: Core entrypoint

### 1. `server.js` (7440 lines)

<<<SEC:server.js>>>

## Group: Services & runtime components

### 2. `agentSessionAttachService.js` (228 lines)

<<<SEC:agentSessionAttachService.js>>>

### 3. `agentTerminalLifecycle.js` (223 lines)

<<<SEC:agentTerminalLifecycle.js>>>

### 4. `collabGatewayAuth.js` (463 lines)

<<<SEC:collabGatewayAuth.js>>>

### 5. `config.js` (173 lines)

<<<SEC:config.js>>>

### 6. `containerPortMonitor.js` (150 lines)

<<<SEC:containerPortMonitor.js>>>

### 7. `containerPortProxy.js` (106 lines)

<<<SEC:containerPortProxy.js>>>

### 8. `contextFiles.js` (30 lines)

<<<SEC:contextFiles.js>>>

### 9. `continuousFlushService.js` (174 lines)

<<<SEC:continuousFlushService.js>>>

### 10. `ensureRuntime.js` (51 lines)

<<<SEC:ensureRuntime.js>>>

### 11. `fileIndex.js` (608 lines)

<<<SEC:fileIndex.js>>>

### 12. `fsWatcherService.js` (595 lines)

<<<SEC:fsWatcherService.js>>>

### 13. `gcsSync.js` (565 lines)

<<<SEC:gcsSync.js>>>

### 14. `gitService.js` (5266 lines)

<<<SEC:gitService.js>>>

### 15. `localWorkerSpawner.js` (390 lines)

<<<SEC:localWorkerSpawner.js>>>

### 16. `logger.js` (115 lines)

<<<SEC:logger.js>>>

### 17. `perfTelemetry.js` (245 lines)

<<<SEC:perfTelemetry.js>>>

### 18. `permissionMiddleware.js` (310 lines)

<<<SEC:permissionMiddleware.js>>>

### 19. `persistence.js` (607 lines)

<<<SEC:persistence.js>>>

### 20. `processWorkerSpawner.js` (306 lines)

<<<SEC:processWorkerSpawner.js>>>

### 21. `programRuntimeManager.js` (965 lines)

<<<SEC:programRuntimeManager.js>>>

### 22. `proxyService.js` (1209 lines)

<<<SEC:proxyService.js>>>

### 23. `repoCache.js` (400 lines)

<<<SEC:repoCache.js>>>

### 24. `runtimeFilesystem.js` (312 lines)

<<<SEC:runtimeFilesystem.js>>>

### 25. `runtimeIdentity.js` (68 lines)

<<<SEC:runtimeIdentity.js>>>

### 26. `runtimeObservationPublisher.js` (156 lines)

<<<SEC:runtimeObservationPublisher.js>>>

### 27. `runtimePersistence.js` (178 lines)

<<<SEC:runtimePersistence.js>>>

### 28. `runtimePersistence.test.js` (41 lines)

<<<SEC:runtimePersistence.test.js>>>

### 29. `runtimePodSpec.js` (312 lines)

<<<SEC:runtimePodSpec.js>>>

### 30. `runtimePodTerminal.js` (449 lines)

<<<SEC:runtimePodTerminal.js>>>

### 31. `scaffold.js` (39 lines)

<<<SEC:scaffold.js>>>

### 32. `sessionLifecycle.js` (160 lines)

<<<SEC:sessionLifecycle.js>>>

### 33. `SessionManager.js` (950 lines)

<<<SEC:SessionManager.js>>>

### 34. `shadowContinuousProducer.js` (100 lines)

<<<SEC:shadowContinuousProducer.js>>>

### 35. `spawner.js` (39 lines)

<<<SEC:spawner.js>>>

### 36. `sseService.js` (230 lines)

<<<SEC:sseService.js>>>

### 37. `terminalRouting.js` (177 lines)

<<<SEC:terminalRouting.js>>>

### 38. `terminalService.js` (2375 lines)

<<<SEC:terminalService.js>>>

### 39. `test-connection.js` (22 lines)

<<<SEC:test-connection.js>>>

### 40. `workspaceAgentProtocol.js` (51 lines)

<<<SEC:workspaceAgentProtocol.js>>>

### 41. `workspaceInstructionGitFilter.js` (111 lines)

<<<SEC:workspaceInstructionGitFilter.js>>>

### 42. `workspaceInstructionGitIsolation.js` (462 lines)

<<<SEC:workspaceInstructionGitIsolation.js>>>

### 43. `workspaceInstructionIdePresentation.js` (183 lines)

<<<SEC:workspaceInstructionIdePresentation.js>>>

### 44. `workspaceInstructionMetadataStore.js` (234 lines)

<<<SEC:workspaceInstructionMetadataStore.js>>>

### 45. `workspaceManager.js` (97 lines)

<<<SEC:workspaceManager.js>>>

### 46. `workspacePodSpawner.js` (1937 lines)

<<<SEC:workspacePodSpawner.js>>>

### 47. `workspacePrepExecutor.js` (712 lines)

<<<SEC:workspacePrepExecutor.js>>>

### 48. `workspacePrepManager.js` (463 lines)

<<<SEC:workspacePrepManager.js>>>

### 49. `workspacePrepPlanner.js` (424 lines)

<<<SEC:workspacePrepPlanner.js>>>

### 50. `workspaceRuntimeContainer.js` (826 lines)

<<<SEC:workspaceRuntimeContainer.js>>>

### 51. `yjsWsServer.js` (209 lines)

<<<SEC:yjsWsServer.js>>>

### 52. `ySweetBridge.js` (416 lines)

<<<SEC:ySweetBridge.js>>>

## Group: Codesite (built-in site) subsystem

### 53. `codesiteActiveBoundary.js` (274 lines)

<<<SEC:codesiteActiveBoundary.js>>>

### 54. `codesiteActivityEndpoint.js` (115 lines)

<<<SEC:codesiteActivityEndpoint.js>>>

### 55. `codesiteActivityRegistry.js` (658 lines)

<<<SEC:codesiteActivityRegistry.js>>>

### 56. `codesiteControlPlaneTrust.js` (98 lines)

<<<SEC:codesiteControlPlaneTrust.js>>>

### 57. `codesiteDeploymentStatus.js` (55 lines)

<<<SEC:codesiteDeploymentStatus.js>>>

### 58. `codesiteFs.js` (2755 lines)

<<<SEC:codesiteFs.js>>>

### 59. `codesiteGitPolicy.js` (144 lines)

<<<SEC:codesiteGitPolicy.js>>>

### 60. `codesiteHostWriteSentinel.js` (590 lines)

<<<SEC:codesiteHostWriteSentinel.js>>>

### 61. `codesiteReadiness.js` (89 lines)

<<<SEC:codesiteReadiness.js>>>

## Group: Instruction projection family

### 62. `workspaceInstructionProjection.js` (327 lines)

<<<SEC:workspaceInstructionProjection.js>>>

### 63. `workspaceInstructionProjectionCollabAdapter.js` (73 lines)

<<<SEC:workspaceInstructionProjectionCollabAdapter.js>>>

### 64. `workspaceInstructionProjectionConfig.js` (379 lines)

<<<SEC:workspaceInstructionProjectionConfig.js>>>

### 65. `workspaceInstructionProjectionObservability.js` (50 lines)

<<<SEC:workspaceInstructionProjectionObservability.js>>>

### 66. `workspaceInstructionProjectionRuntime.js` (315 lines)

<<<SEC:workspaceInstructionProjectionRuntime.js>>>

### 67. `workspaceInstructionProjectionService.js` (634 lines)

<<<SEC:workspaceInstructionProjectionService.js>>>

## Group: Tests

### 68. `__tests__/agentSessionAttachService.test.js` (284 lines)

<<<SEC:__tests__/agentSessionAttachService.test.js>>>

### 69. `__tests__/agentTerminalLifecycle.test.js` (220 lines)

<<<SEC:__tests__/agentTerminalLifecycle.test.js>>>

### 70. `__tests__/codesiteActiveBoundary.test.js` (600 lines)

<<<SEC:__tests__/codesiteActiveBoundary.test.js>>>

### 71. `__tests__/codesiteActivityEndpoint.test.js` (223 lines)

<<<SEC:__tests__/codesiteActivityEndpoint.test.js>>>

### 72. `__tests__/codesiteActivityRegistry.test.js` (540 lines)

<<<SEC:__tests__/codesiteActivityRegistry.test.js>>>

### 73. `__tests__/codesiteDeploymentStatus.test.js` (70 lines)

<<<SEC:__tests__/codesiteDeploymentStatus.test.js>>>

### 74. `__tests__/codesiteFs.test.js` (1723 lines)

<<<SEC:__tests__/codesiteFs.test.js>>>

### 75. `__tests__/codesiteGitPolicy.test.js` (166 lines)

<<<SEC:__tests__/codesiteGitPolicy.test.js>>>

### 76. `__tests__/codesiteHostWriteSentinel.test.js` (204 lines)

<<<SEC:__tests__/codesiteHostWriteSentinel.test.js>>>

### 77. `__tests__/codesiteReadiness.test.js` (93 lines)

<<<SEC:__tests__/codesiteReadiness.test.js>>>

### 78. `__tests__/collabGatewayAuth.test.js` (268 lines)

<<<SEC:__tests__/collabGatewayAuth.test.js>>>

### 79. `__tests__/containerPortMonitor.test.js` (140 lines)

<<<SEC:__tests__/containerPortMonitor.test.js>>>

### 80. `__tests__/containerPortProxy.test.js` (166 lines)

<<<SEC:__tests__/containerPortProxy.test.js>>>

### 81. `__tests__/contextFiles.test.js` (34 lines)

<<<SEC:__tests__/contextFiles.test.js>>>

### 82. `__tests__/continuousFlushService.test.js` (160 lines)

<<<SEC:__tests__/continuousFlushService.test.js>>>

### 83. `__tests__/ensureRuntimeRoute.test.js` (70 lines)

<<<SEC:__tests__/ensureRuntimeRoute.test.js>>>

### 84. `__tests__/fsWatcherService.test.js` (187 lines)

<<<SEC:__tests__/fsWatcherService.test.js>>>

### 85. `__tests__/gitServiceCodesiteBoundary.test.js` (1780 lines)

<<<SEC:__tests__/gitServiceCodesiteBoundary.test.js>>>

### 86. `__tests__/programRuntimeManager.test.js` (848 lines)

<<<SEC:__tests__/programRuntimeManager.test.js>>>

### 87. `__tests__/repoCacheCodesiteBoundary.test.js` (60 lines)

<<<SEC:__tests__/repoCacheCodesiteBoundary.test.js>>>

### 88. `__tests__/runtimeFilesystem.test.js` (426 lines)

<<<SEC:__tests__/runtimeFilesystem.test.js>>>

### 89. `__tests__/runtimeObservationPublisher.test.js` (99 lines)

<<<SEC:__tests__/runtimeObservationPublisher.test.js>>>

### 90. `__tests__/runtimePodSpawner.test.js` (154 lines)

<<<SEC:__tests__/runtimePodSpawner.test.js>>>

### 91. `__tests__/runtimePodSpec.test.js` (313 lines)

<<<SEC:__tests__/runtimePodSpec.test.js>>>

### 92. `__tests__/runtimePodTerminal.test.js` (42 lines)

<<<SEC:__tests__/runtimePodTerminal.test.js>>>

### 93. `__tests__/scaffold.test.js` (46 lines)

<<<SEC:__tests__/scaffold.test.js>>>

### 94. `__tests__/sessionWorkspaceAccess.test.js` (109 lines)

<<<SEC:__tests__/sessionWorkspaceAccess.test.js>>>

### 95. `__tests__/terminalEnvironment.test.js` (42 lines)

<<<SEC:__tests__/terminalEnvironment.test.js>>>

### 96. `__tests__/terminalRouting.test.js` (302 lines)

<<<SEC:__tests__/terminalRouting.test.js>>>

### 97. `__tests__/terminalServiceAgentLifecycle.test.js` (300 lines)

<<<SEC:__tests__/terminalServiceAgentLifecycle.test.js>>>

### 98. `__tests__/workflowBridgeDojoEnv.test.js` (92 lines)

<<<SEC:__tests__/workflowBridgeDojoEnv.test.js>>>

### 99. `__tests__/workspaceAgentProtocol.test.js` (17 lines)

<<<SEC:__tests__/workspaceAgentProtocol.test.js>>>

### 100. `__tests__/workspaceInstructionGitIsolation.test.js` (235 lines)

<<<SEC:__tests__/workspaceInstructionGitIsolation.test.js>>>

### 101. `__tests__/workspaceInstructionIdePresentation.test.js` (139 lines)

<<<SEC:__tests__/workspaceInstructionIdePresentation.test.js>>>

### 102. `__tests__/workspaceInstructionMetadataStore.test.js` (111 lines)

<<<SEC:__tests__/workspaceInstructionMetadataStore.test.js>>>

### 103. `__tests__/workspaceInstructionProjection.test.js` (134 lines)

<<<SEC:__tests__/workspaceInstructionProjection.test.js>>>

### 104. `__tests__/workspaceInstructionProjectionCollabAdapter.test.js` (63 lines)

<<<SEC:__tests__/workspaceInstructionProjectionCollabAdapter.test.js>>>

### 105. `__tests__/workspaceInstructionProjectionConfig.test.js` (139 lines)

<<<SEC:__tests__/workspaceInstructionProjectionConfig.test.js>>>

### 106. `__tests__/workspaceInstructionProjectionObservability.test.js` (33 lines)

<<<SEC:__tests__/workspaceInstructionProjectionObservability.test.js>>>

### 107. `__tests__/workspaceInstructionProjectionRuntime.test.js` (197 lines)

<<<SEC:__tests__/workspaceInstructionProjectionRuntime.test.js>>>

### 108. `__tests__/workspaceInstructionProjectionService.test.js` (303 lines)

<<<SEC:__tests__/workspaceInstructionProjectionService.test.js>>>

### 109. `__tests__/workspaceManager.test.js` (60 lines)

<<<SEC:__tests__/workspaceManager.test.js>>>

### 110. `__tests__/workspacePrepManager.test.js` (172 lines)

<<<SEC:__tests__/workspacePrepManager.test.js>>>

### 111. `__tests__/workspaceRuntimeContainer.test.js` (541 lines)

<<<SEC:__tests__/workspaceRuntimeContainer.test.js>>>

### 112. `__tests__/writeFilesBatchEncoding.test.js` (137 lines)

<<<SEC:__tests__/writeFilesBatchEncoding.test.js>>>

## Group: Non-JS assets

### 113. `.dockerignore` (8 lines)

<<<SEC:.dockerignore>>>

### 114. `.env.example` (157 lines)

<<<SEC:.env.example>>>

### 115. `.gitignore` (28 lines)

<<<SEC:.gitignore>>>

### 116. `Dockerfile` (71 lines)

<<<SEC:Dockerfile>>>

### 117. `package-lock.json` (4219 lines)

<<<SEC:package-lock.json>>>

### 118. `package.json` (33 lines)

<<<SEC:package.json>>>

### 119. `README.md` (27 lines)

<<<SEC:README.md>>>

### 120. `workspacePodSpawner.js.backup` (591 lines)

<<<SEC:workspacePodSpawner.js.backup>>>

### 121. `workspaces.json` (23 lines)

<<<SEC:workspaces.json>>>

## Cross-cutting indexes

<<<SEC:_envindex>>>

<<<SEC:_epindex>>>

<<<SEC:_failures>>>
---
title: "Area — backend/collab-server"
type: area
status: verified
source-tree: backend/collab-server
tags: [area, collab-server, backend, synthi]
---

# Area: `backend/collab-server`

> Exhaustive per-module analysis of the Synthi IDE collaboration server (`synthi-collab-server` 0.1.0, entry `server.js`, started via `node --openssl-legacy-provider server.js`). Every module gets: purpose, key functions with signatures, HTTP endpoints / WS paths served or implemented, module dependencies, env vars read, and failure behavior.
> Reference convention: `backend/collab-server/<file>:L<line>`.

## Table of Contents

- [[#Inventory|Inventory]]
- [[#Architecture at a glance|Architecture at a glance]]
- [[#Core entrypoint|Core entrypoint]] — `server.js` (7440 L) with the exhaustive route table
- [[#Services & runtime components|Services & runtime components]]
- [[#Codesite subsystem|Codesite subsystem]]
- [[#Instruction projection family|Instruction projection family]]
- [[#Persistence layer|Persistence layer]]
- [[#Tests|Tests]]
- [[#Non-JS assets|Non-JS assets]]
- [[#Cross-cutting indexes|Cross-cutting indexes]] — endpoint index, env-var index, failure catalog

## Inventory

121 entries, 112 JS files, ≈56k lines (incl. `package-lock.json`).

| Lines | File | Role |
|---:|---|---|
| 7440 | `server.js` | Monolithic HTTP+WS entrypoint, route table, Yjs flush pipeline |
| 5266 | `gitService.js` | Git CLI orchestration (simple-git + nodegit), repos/worktrees/migration |
| 2755 | `codesiteFs.js` | CodeSite guarded filesystem, quarantine/overlay workspaces |
| 2375 | `terminalService.js` | node-pty terminal sessions over WebSocket |
| 1937 | `workspacePodSpawner.js` | K8s per-session worker Deployment manager (+ sysbox runtime pods) |
| 1209 | `proxyService.js` | Port scanner + `/port/:N` reverse proxy + preview hosts |
| 965 | `programRuntimeManager.js` | Managed program sessions (launch/exec/webGui/health/ports) |
| 950 | `SessionManager.js` | Host/guest collaboration rooms, permissions, tokens |
| 826 | `workspaceRuntimeContainer.js` | Per-workspace rootless-Docker runtime container (dockerode) |
| 712 | `workspacePrepExecutor.js` | Workspace prep job execution (in-process / k8s Job) |
| 658 | `codesiteActivityRegistry.js` | Active CodeSite transaction state registry (+ disk/control-plane sync) |
| 608 | `fileIndex.js` | Symbol/import search index per workspace |
| 607 | `persistence.js` | Optional Redis mirror: sessions, blocks, versions, inboxes |
| 595 | `fsWatcherService.js` | Recursive fs.watch (+ poll fallback) change broadcaster |
| 590 | `codesiteHostWriteSentinel.js` | Out-of-band host-write detector + restorable baseline |
| 565 | `gcsSync.js` | Google Cloud Storage bidirectional repo sync |
| 541 | `__tests__/workspaceRuntimeContainer.test.js` | test |
| 463 | `workspacePrepManager.js` | Prep status/ensure API over planner+executor |
| 463 | `collabGatewayAuth.js` | Gateway JWT / internal-token auth for command surfaces |
| 449 | `runtimePodTerminal.js` | PTY/exec inside sysbox runtime pods (k8s exec) |
| 424 | `workspacePrepPlanner.js` | Prep plan builder |
| 416 | `ySweetBridge.js` | Y-Sweet REST bridge: tokens, doc read/reset/diff ops |
| 400 | `repoCache.js` | LRU working-tree cache w/ pinning + GCS materialization |
| 390 | `localWorkerSpawner.js` | Spawner backend: dockerode worker containers |
| 379 | `workspaceInstructionProjectionConfig.js` | Projection config/canonicalization/rollout |
| 327 | `workspaceInstructionProjection.js` | Vectant block build/extract/merge primitives |
| 315 | `workspaceInstructionProjectionRuntime.js` | Runtime wiring of projection service + git adapter |
| 313 | `__tests__/programRuntimeManager.test.js`… | (see [[#Tests]]) |
| 312 | `runtimeFilesystem.js` | Hydrate/pin per-runtime filesystems, projection reconcile |
| 312 | `runtimePodSpec.js` | Runtime-pod Deployment/Service spec builders |
| 310 | `permissionMiddleware.js` | HTTP/WS permission checks against SessionManager |
| 306 | `processWorkerSpawner.js` | Spawner backend: bare child_process workers |
| 230 | `sseService.js` | Server-Sent Events push channel per slug |
| 228 | `agentSessionAttachService.js` | Agent attach binding issuance/validation |
| 223 | `agentTerminalLifecycle.js` | Terminal agent attach/heartbeat/finalize |
| 220 | `workspaceInstructionMetadataStore.js` | Per-workspace projection state JSON store |
| 209 | `yjsWsServer.js` | Minimal y-websocket protocol relay (rooms in-memory) |
| 205 | `workspaceInstructionGitIsolation.js` | Git clean/smudge filter install for projections |
| 196 | `workspaceInstructionIdePresentation.js` | Hide/rewrite projections for IDE tree/read/write |
| 178 | `runtimePersistence.js` | Persistent runtime dir layout + env for containers |
| 177 | `terminalRouting.js` | Pure routing decisions for terminal targets |
| 173 | `config.js` | Centralized env config |
| 166 | `containerPortMonitor.js` | Port detection inside runtime containers |
| 160 | `sessionLifecycle.js` | Advisory session state machine (warming→terminated) |
| 156 | `runtimeObservationPublisher.js` | Publish runtime health to CodeSite control plane |
| 154 | `continuousFlushService.js` | Periodic/debounced flush while programs run |
| 150 | `containerPortProxy.js` | `/wsport/:slug/:N` HTTP/WS proxy factory |
| 144 | `codesiteGitPolicy.js` | Which git actions need which boundary attempts |
| 137 | `runtimeFilesystem.test.js`… | (see [[#Tests]]) |
| 115 | `logger.js` | Structured JSON logger |
| 111 | `workspaceInstructionGitFilter.js` | The clean/smudge filter executable |
| 106 | `containerPortProxy.js`… | — |
| 100 | `shadowContinuousProducer.js` | fs-change → ai-engine `/shadow_continuous/notify` bridge |
| 98 | `codesiteControlPlaneTrust.js` | Trusted control-plane base URL resolution |
| 97 | `workspaceManager.js` | In-memory workspace metadata cache |
| 89 | `codesiteReadiness.js` | `/codesite/readiness` probe handler |
| 85 | `.env.example` docs | 157-line annotated env template |
| 71 | `Dockerfile` | node:20 two-stage image w/ claude-code CLI + lazygit |
| 68 | `runtimeIdentity.js` | HMAC base32 resource ids (rt-* names) |
| 55 | `codesiteDeploymentStatus.js` | `/codesite/deployment-status` handler |
| 51 | `ensureRuntime.js` | Prewarm runtime container route handler |
| 51 | `workspaceAgentProtocol.js` | Passive instruction text constants |
| 51 | `spawner.js` | Spawner backend dispatcher |
| 50 | `workspaceInstructionProjectionObservability.js` | Event emitter wrapper |
| 46 | `README.md`… | short dev readme |
| 42 | `test-connection.js` | WS smoke script |
| 39 | `scaffold.js` | Path-guarded scaffold writer |
| 39 | `workspacePodSpawner.js.backup`… | stale backup copy (591 L) |
| 30 | `contextFiles.js` | AGENTS.md/context file reader |
| 23 | `workspaces.json` | Legacy seed data (superseded by workspaceManager) |

## Architecture at a glance

One Node process serves everything on `COLLAB_PORT` (default **1234**, bound `0.0.0.0`, `server.js:L7403`):

```
Browser / IDE frontend ─┬─ HTTP  → http.createServer handler (server.js:L2170)
                        ├─ WS    → server.on('upgrade') dispatcher   (server.js:L6961)
                        └─ SSE   → GET /sse/:slug                    (sseService.js)

collab-server ─┬─ gitService ──── simple-git/nodegit → repos/<slug>/sessions/<user>/ worktrees
               ├─ repoCache ───── LRU over REPO_CACHE_DIR, hydrates from GCS (durable store)
               ├─ gcsSync ─────── GCS bucket upload/download/archive
               ├─ persistence ─── optional Redis mirror (sessions/blocks/file-versions/inbox)
               ├─ ySweetBridge ── Y-Sweet CRDT server REST (tokens, doc read/reset)
               ├─ yjsWsServer ─── in-process y-websocket relay (/ws/yjs/<docName>)
               ├─ terminalService node-pty → user shells (host, container, or runtime pod)
               ├─ spawner ─────── process | local(dockerode) | k8s worker per session
               │   └─ workspacePodSpawner (k8s): worker Deployment + svc + sysbox runtime pod
               ├─ workspaceRuntimeContainer: rootless-dockerd container per workspace (ENABLE_CONTAINER_RUNTIME=1)
               ├─ programRuntimeManager: managed program sessions (cli/webGui/container)
               ├─ proxyService / containerPortProxy: preview proxies to detected ports
               └─ codesite guards: activityRegistry + activeBoundary + sentinel + FS policy
                    ↕ control plane = Next.js app (SYNTHI_CODESITE_API_BASE_URL)
```

**WS endpoints** (upgrade dispatcher, `server.js:L6961-L7106`):

| Path | Server | Notes |
|---|---|---|
| `/port/:N/...`, `/runtime/:scope/port/:N/...` | proxyService.proxyWsUpgrade | HMR/hot-reload tunnels |
| `p<port>-rt-*.preview.*` wildcard hosts | proxyService.proxyWsUpgrade | preview-host traffic, checked before mount strip |
| `/wsport/<slug>/<N>/...` | containerPortProxy.proxyWsUpgrade | runtime-container programs |
| `/notifications?slug&userId&email&sessionId` | notifyWss | presence + offline inbox drain |
| `/session-events?sessionId&userId&role` | sessionWss | knock/admit/permission events; `identify` message |
| `/terminal?sessionId&workspace&cols&rows` | terminalWss | gateway-auth enforced; PTY bridge |
| `/ws/yjs/<docName>` | yjsWss → yjsWsServer.setupConnection | seeds initial content from disk after traversal checks |
| anything else | 404 + destroy | `server.js:L7101-L7106` |

**Doc name grammar** (`buildDocName`/`parseDocName`, `server.js:L1024-L1092`): `workspace:<slug>:user:<userId>:<filePath>` or `workspace:<slug>:session:<sessionId>:<filePath>`; guest docs resolve to the host's room via `resolveEffectiveUserForDoc`.

**Request pipeline order** (`server.js:L2170-L2214`): strip optional `/collab` ingress prefix (recording `req._synthiExternalMountPrefix`) → preview-host fast-path into proxyService → CORS echo-Origin headers → OPTIONS 204 → `enforceOrigin` same-origin guard for mutating verbs → route table below.

## Core entrypoint

### 1. `server.js` (7440 lines)

Single-file monolith: creates the HTTP server, owns the entire REST route table, four WebSocket servers, the Yjs↔disk flush pipeline, TURN credentials, and boot/shutdown sequencing.

#### Requires (L1–L101)

Node builtins (`http`, `fs`, `path`, `crypto`, `os`, `child_process`) plus locals: `fileIndex`, `gcsSync`, `terminalService` (createTerminalWSS/createHeadlessSession/activeSessions/broadcastToAll/getAvailableShells/resolveWorkspaceCwd), `agentSessionAttachService`, `runtimeObservationPublisher`, `programRuntimeManager`, `continuousFlushService`, `proxyService`, `workspaceRuntimeContainer.createRuntimeManager`, `ensureRuntime`, `containerPortMonitor`, `runtimePodSpec.isSysboxRuntimeEnabled`, `runtimePodTerminal` (runtimeRunOnce/runtimeExecOnce/createRuntimePodProgram/codeSiteProgramRuntimeTarget/codeSiteProgramRuntimeLaunchMode/pickRuntimeScopeForSlug), `containerPortProxy`, `config`, `gitService`, `collabGatewayAuth`, `codesiteGitPolicy`, `repoCache`, `SessionManager`, `permissionMiddleware`, `fsWatcherService` (acquireStagingLock/releaseStagingLock/pauseWatcher/resumeWatcher/registerChangeListener), `shadowContinuousProducer`, `lru-cache`, `ySweetBridge`, `perfTelemetry`, `sseService`, `persistence`, `logger`, `workspacePrepManager`, `runtimeFilesystem.ensureRuntimeFilesystem`, `workspaceInstructionProjectionRuntime` (instantiated at L70), `workspaceInstructionProjectionCollabAdapter`, `codesiteActivityRegistry`, `codesiteActiveBoundary`, `codesiteControlPlaneTrust`, `codesiteActivityEndpoint`, `codesiteReadiness`, `codesiteDeploymentStatus`, `codesiteFs` (20 named exports, L84–L101); lazily: `workspaceManager` (L1390), `spawner` (L1391), `yjsWsServer` (L6847), `sessionLifecycle` (L2299), `contextFiles`, `scaffold`.

#### Boot-time wiring (L184–L475)

- `ENABLE_CONTAINER_RUNTIME = process.env.ENABLE_CONTAINER_RUNTIME === '1'` (L184); `ENABLE_CODESITE_DOCKER_RUNTIME !== '0'` (L185); either enables `ENABLE_WORKSPACE_RUNTIME`.
- `workspaceRuntime = createRuntimeManager({ docker: dockerode({socketPath: DOCKER_SOCKET_PATH || '/var/run/docker.sock'}) })` when enabled (L187–L194).
- `containerPortProxy` with `resolveHost` (readwrite session preferred) + `resolveStreamAuth` delegating to `managedProgramRuntime.resolveStreamAuth` for KasmVNC Basic auth injection (L195–L213).
- `containerPortMonitor` — polls `/proc/net/tcp[6]` inside each runtime container via `runOnce`; broadcasts via `broadcastContainerPorts` (L218–L233).
- `runtimePortMonitor` — same monitor re-keyed `(slug, runtimeScope)` against sysbox runtime pods; only when `RUNTIME_BACKEND=sysbox-pod` (L239–L257).
- `managedProgramRuntime = createProgramRuntimeManager({ activeSessions: terminalSessions, logger, onSessionEvent … })` (L259).
- `blockedBy: Map<userId, Set<blockedUserId>>` (L381); invite-link builders `makeInviteLink` (L418) using `publicAppBaseUrl()`/`internalAppBaseUrl()` (L404/L411, `normalizeBaseUrl` L398).
- Caches: `fileHashCache` LRUCache(1000, 5 min) docName→hash (L434); `revertCooldowns` (L438); `gcsBackupDegraded` LRUCache(10k, 24 h) (L448); `rateBuckets` LRUCache(20k) (L465).
- `umask` override at L4–L9 from `SYNTHI_RUNTIME_WORKSPACE_UMASK` (setgid group-writable collaboration).

#### Small helpers worth knowing

- `queueHeadlessCommandStart(ptyProcess, command)` (L103) — waits for a shell prompt regex then injects a command; used for AI-driven headless terminals.
- `checkRateLimit(key, limit)` (L467), `clientIp(req)` (L476, x-forwarded-for aware), `enforceOrigin(req,res)` (L497 — Origin must match Host unless absent/dev), `rateLimitGuard(req,res,scope,limitPerMin)` (L527).
- `applyCollabGatewayAuthIdentity` (L535) + `requireCommandGatewayAuth(req,res,{slug,parsed,requiredScope})` (L545) — wraps `collabGatewayAuth.requireCollabGatewayAuth` for `/exec*` and program-runtime routes.
- `hydrationKey(slug,userId)` (L568) / `hydratedSlugs:Set` (L564) / `purgedLegacyRooms` (L565); `purgeLegacyRoomState(slug,filePath)` (L572) deletes stale Y-Sweet room keys after legacy migrations.
- Quarantine-replay machinery for CodeSite: `codeSiteWriteEvidence(payload)` (L597), sha digests (L612–L619), `decodeQuarantineReplayContent` (L620), `validateQuarantineReplayBase` (L658), `selectedQuarantinePathSet/Changes` (L748/L762), `prepareCodeSiteQuarantineReplayPlan` (L808), `applyQuarantineReplayItem` (L918), timeline recording `recordCodeSiteQuarantineTimelineEvent` (L954) POSTing to the trusted control plane.
- `computeHash(content)` (L585) sha256-hex used by the flush pipeline.
- Doc plumbing: `buildDocName`/`parseDocName` (L1024/L1038), `validateDocAccess(parsedDoc,{userId,sessionId})` (L1115 — guests may only open docs inside the host session they joined), `getActualFileContent(slug,filePath,userId,options)` (L1190 — goes through CodeSite read enforcement), `getYDocContent(ydoc)` (L1208).
- Flush pipeline: `flushDocToDisk(docName, options)` (L1233) — resolves effective user (throws `Refusing unscoped flush` L1245 if none), pulls content (override else `ySweetBridge.readDocContent`), 1) GCS sync with degraded-marker broadcast on failure (L1264–1283), 2) reads prior disk content BEFORE writing to seed a revert baseline version (L1291–1315), derives line provenance (L1322), runs the CodeSite mutation boundary, writes via `gitService.writeFile`, records version + file-event, updates hash cache. `flushYjsDocForFile(slug, filePath, scope)` (L1665) and `flushWorkspaceDocsToDisk(slug, userId, scope)` (L1723) wrap it for external-save and pre-launch cases.
- Invalidation: `invalidateDocsForSlug(slug, filePaths|null, scope)` (L1742) — resets Y-Sweet docs whose CRDT hash diverges from disk and broadcasts `doc-invalidated` so clients drop stale Y.Docs.
- Broadcasters: `broadcastFileTreeChanged` (L1804), `broadcastFileSaved` (L1871), `broadcastContainerPorts` (L1892), `broadcastRuntimePorts` (L1907), `broadcastBackupStatus` (L1928), debounced `broadcastGitStatusChanged` (L1946, 300 ms coalescing per scope key, SSE `git-status-changed` + notify-WS `git-status-changed-v2` snapshot), `broadcastFileReverted` (L2080). All fan out through `_matchesNotifyScope` (L1830) filtering by userId/sessionId/codesiteContext.
- `clearDocumentPersistence(docName)` (L2101).
- `getTurnCredentials()` (L2112) — Cloudflare Calls TURN with 80 %-TTL cache; falls back to `LOCAL_TURN_URL/USERNAME/CREDENTIAL`, then STUN-only.

#### Raw `req.url` route table (exhaustive, in dispatch order)

All routes are matched against the raw URL after `/collab` prefix stripping. Method noted where constrained.

| # | Line | Route | Behavior |
|---:|---|---|---|
| 1 | L2183 | *(preview wildcard host)* `isPreviewHostRequest` | `proxyService.proxyHttpRequest` before CORS/auth |
| 2 | L2215 | `POST /api/spawner/session-ended` | `spawner.handleSessionEnded` webhook (signaling server) |
| 3 | L2226 | `GET /api/session/:id/lifecycle` | spawner `lifecycleSnapshot` + optional `runtimeLifecycleSnapshot` under `.runtime`; MCP-consumed |
| 4 | L2256 | `POST /api/session/:id/warm` | pre-warm hibernated session; 501 `warm_not_supported_for_spawner_mode` when unsupported |
| 5 | L2289 | `POST /api/session/:id/migrate` | `sessionLifecycle.markMigrating(sessionId,target,reason)` — advisory only |
| 6 | L2320 | `POST /api/spawner/ensure` | `{session_id,user_id,workspace_slug?,runtime_kind?,filesystemUserId?}`; `ensureRuntimeFilesystem` then `spawner.ensurePod`; fire-and-forget `spawnRuntimePod` when exposed |
| 7 | L2371 | `POST /api/spawner/touch` | heartbeat `{session_id}` |
| 8 | L2395 | `POST /api/spawner/release` | teardown `{session_id\|runtimeScope, reason?}`; 403 `runtime_scope_mismatch` vs `x-runtime-scope` header |
| 9 | L2427 | `GET /turn-credentials` | ICE servers; degrades to STUN-only 200 with `_fallback:true` on CF error |
| 10 | L2453 | `/wsport/...` | `containerPortProxy.proxyHttp` (404 `container_runtime_disabled` when off) |
| 11 | L2466 | `/port/...`, `/runtime/...` | `proxyService.proxyHttpRequest` |
| 12 | L2473 | `GET /preview-url[?...]` | `proxyService.handlePreviewUrlRequest` — canonical rt-* preview URLs |
| 13 | L2480 | `POST /runtime-callback[?...]` | `proxyService.handleRuntimeCallbackRequest` — replay OAuth loopback callback into the right runtime pod |
| 14 | L2486 | `GET /ports[?...]` | `proxyService.handlePortsStatus` |
| 15 | L2491 | `ANY /codesite/activity/:slug` | `handleCodeSiteActivityRequest` (internal-token auth inside) |
| 16 | L2502 | `GET /codesite/readiness` | `handleCodeSiteReadinessRequest` |
| 17 | L2507 | `ANY /codesite/deployment-status` | `handleCodeSiteDeploymentStatusRequest` w/ overlay-capability + observation probes |
| 18 | L2516 | `GET /debug/status` | server/persistence/hash-cache introspection JSON |
| 19 | L2534 | `GET/POST /api/workspace/:slug/prepare` | GET → prep status; POST → requires `canFileOps` (403 `permission_denied`), auto-init repo once per hydration key (CodeSite provisioning gate), `workspacePrepManager.ensureWorkspacePrepared` returns 202; `CODESITE_WORKSPACE_PREP_REQUIRES_ISOLATION` → e.status/409 |
| 20 | L2632 | `GET /sse/:slug` | SSE stream (`sseService.handleSSEConnection`), `?userId=` optional |
| 21 | L2648 | `GET /telemetry/metrics` | perfTelemetry snapshot + event-loop block count |
| 22 | L2657 | `POST /telemetry/reset` | reset counters |
| 23 | L2665 | `GET /sse/stats` | SSE client stats |
| 24 | L2672 | `GET /debug/validate/:slug/*filePath` | compares cached hash vs actual file hash |
| 25 | L2717 | `GET /file-content/:slug/*filePath` | AI-backend source-of-truth read; auto-init repo once; 404 when missing; CodeSite read enforcement |
| 26 | L2804 | `GET /available-shells` | shells registry + default key |
| 27 | L2816 | `GET /program-runtime/:slug/sessions` | list managed sessions for slug |
| 28 | L2816 | `GET /program-runtime/:slug/sessions/:sid` | single session |
| 29 | L2844 | `GET /program-runtime/:slug/sessions/:sid/events` | session event log |
| 30 | L2851 | `POST /program-runtime/:slug/sessions/:sid/stop` | stop + unregister continuous flush |
| 31 | L2859 | `POST /program-runtime/:slug/sessions/:sid/restart` | restart |
| 32 | L2873 | `POST /program-runtime/:slug/launch-program` | `{sessionId,userId?,title?,config}` recipe launch |
| 33 | L2973 | `POST /program-runtime/:slug/exec` | one-shot command through managed runtime |
| 34 | L3044 | `POST /program-runtime/:slug/ensure-runtime` | prewarm (`ensureRuntime.handleEnsureRuntime`) |
| 35 | L3088 | `GET /program-runtime/:slug/manifest` | normalized program manifest lookup |
| 36 | L3126 | `GET /program-runtime/:slug/detect` | detect program config files |
| 37 | L3159 | `GET /program-runtime/:slug/context` | context file contents (`contextFiles`) |
| 38 | L3178 | `POST /program-runtime/:slug/scaffold` | `{userId,files[{path,contents}],overwrite?}` path-guarded write |
| 39 | L3633 | `POST /exec-terminal/:slug` | gateway EXEC scope auth; launches tracked managed PTY session, captures output until exit/timeout (max 60 s); full CodeSite surface gating (`guardCodeSiteRuntimeHostSurface` L3684, `requiresCodeSiteManagedRuntimeContext` L3689, active-context 409 L3693) |
| 40 | L3870 | `POST /exec-pty/:slug` | like exec-terminal but leaves PTY alive for later WS attach |
| 41 | L4045 | `POST /exec/:slug` | plain one-shot exec variant |
| 42 | L4189 | `GET /workspaces[?owner&recent]` | `workspaceManager.getWorkspaces` |
| 43 | L4209 | `GET/POST /migration/status|trigger/:slug` | legacy→session-structure migration status/trigger via `gitService.ensureMigrated` |
| 44 | L4253 | `POST /user/block` | block user (presence filtering) |
| 45 | L4282 | `POST /user/unblock` | unblock |
| 46 | L4313 | `GET /user/blocked-list[?...]` | list blocks |
| 47 | L4337 | `GET /presence/user/:userId` | online check across notify/session WS |
| 48 | L4366 | `GET /file-history/:slug/*path` | Redis file event log |
| 49 | L4389 | `GET /file-versions/:slug/*path` | version metadata list |
| 50 | L4413 | `GET /file-version/:slug/*path?index` | version content |
| 51 | L4455 | `POST /file-version/restore` | restore version to disk + broadcasts |
| 52 | L4666 | `POST /ysweet/token` | issue client token; pre-issue disk↔CRDT hash reconcile (resets doc or broadcasts invalidation) |
| 53 | L4724 | `GET /workspace-presence/:slug[?userId]` | active users (from notify WS) + sessions, blocked users filtered bidirectionally |
| 54 | L4795 | `POST /session/invite-user` | direct-collab invite (auto-creates session; rate 30/min) |
| 55 | L4882 | `POST /session/join-user` | invitee accept → knock/admit flow |
| 56 | L4996 | `POST /session/join-by-code` | join via room code + token |
| 57 | L5052 | `POST /session/request-join/:sessionId` | knock |
| 58 | L5100 | `/session/:action[/:sessionId]` | big switch (below) with per-action rate budgets L5109–5123 and sessionId format guard L5140 (`^[a-f0-9]{8,64}$`) |
| 59 | L5435 | `/git/:slug/:action` | git switch (below) with session-permission gate L5541, effective-user resolution, per-requester token isolation L5504–5507, commit identity headers `x-user-name/x-user-email` (b64: prefixed) L5515–5532 |
| 60 | L7189/L7208 | *(query parse)* | used by notify/session connection handlers |

`/session/:action` switch cases (`server.js:L5153-L5434`): `create` L5154, `host` L5194, `workspace-access` L5222, `validate-token` L5268, `knock` L5280, `admit` L5288, `deny` L5312, `permissions` L5333, `kick` L5344, `leave` L5366, `terminate` L5378, `info` L5389, `regenerate-token` L5401. Rate budgets (req/min): create 20, validate-token 60, host 120, workspace-access 120, knock 30, admit/deny/permissions 60, kick 30, leave/info 120, terminate 20, regenerate-token 10.

`/git/:slug/:action` switch cases (`server.js:L5699-L6845`), 67 actions: `init` L5700, `add-remote` L5724, `remove-remote` L5753→L5740 ordering, `set-remote-url` L5753, `remotes` L5769, `clone` L5772, `status` L5878, `branches` L5881, `checkout` L5884, `fetch` L5900, `commit` L5908, `stage` L5922, `stage-all` L5939, `stage-lines` L5948, `unstage-lines` L5966, `discard-lines` L5981, `unstage` L6000, `unstage-all` L6014, `push` L6023, `pull` L6043, `discard` L6060, `discard-all` L6076, `resolve-ours` L6094, `resolve-theirs` L6106, `mark-resolved` L6118, `abort-merge` L6126, `merge-branch` L6137, `check-merge-conflicts` L6152, `conflict-versions` L6161, `diff` L6164, `file-content` L6167, `log` L6171, `unpushed` L6174, `incoming` L6178, `blame` L6182, `stash-list` L6186, `stash-push` L6189, `stash-pop` L6197, `stash-apply` L6211, `stash-drop` L6225, `interactive-rebase` L6238, `rebase-abort` L6253, `rebase-continue` L6268, `cherry-pick` L6283, `tags` L6294, `create-tag` L6297, `delete-tag` L6312, `push-tag` L6325, `revert` L6341, `commit-detail` L6352, `sync` L6355, `files` L6394, `files-meta` L6400, `index-ensure` L6428, `index-status` L6435, `search` L6438, `open-lookup` L6447, `imports` L6450, `file` L6453, `file-hash` L6472, `write-file` L6490, `apply-shadow-patch` L6520, `write-files-batch` L6577, `create-directory` L6623, `delete-item` L6640, `rename-item` L6672, `clear-collab` L6717, `github-info` L6726. Permission mapping comes from `permissionMiddleware.GIT_ACTION_PERMISSIONS[action]` (L5542); unauthenticated access requires `init`/`clone` or `SYNTHI_WORKSPACE_AUTH_BYPASS=1` (L5552–L5560).

#### WebSocket layer (L6833–L7205)

- `wsPerMessageDeflate` (L6833): enabled, threshold 128 bytes — applied to notify/session servers only.
- Four `noServer` WebSocketServers: `yjsWss` (L6846), `notifyWss` (L6851), `sessionWss` (L6855), `terminalWss = createTerminalWSS({...})` (L6861) wired with runtime flags, `flushWorkspaceDocsToDisk`, and the agent attach service.
- Upgrade dispatcher (L6961): preview hosts → proxy; strip `/collab`; `/port|/runtime` → proxy; `wsport/` → containerPortProxy; exact `notifications`, `session-events`, `terminal` (with `authorizeTerminalGatewayRequest` L7006 — on gateway identity it *rewrites the query string* injecting `userId/filesystemUserId/runtimeScope/collabSessionId` and deleting client-supplied `codeSiteProjectId/agentProvider/providerSessionRef/token` L7025–7036); `yjs/...` → parse doc name, validate path (`validateFilePath` L7060), acquire repo, seed `initialContent` only when realpath stays inside repo root (symlink defense L7069–7090), else empty; unknown → 404 destroy.
- Presence/inbox: `isUserOnline(userId)` (L7115 scans notify+session clients), `deliverToUser(userId,type,payload,{slug,forceQueue})` (L7144 — live send else Redis inbox), `flushUserInboxToSocket` (L7169 — drains queued events tagged `queued:true,queuedAt`).
- `notifyWss.on('connection')` (L7188): binds `_slug/_userId/_userEmail/_sessionId` from query, drains inbox.
- `sessionWss.on('connection')` (L7207): random `_socketId`, `identify()` registers host socket or updates guest socket and clears guest disconnect grace timer (`GUEST_DISCONNECT_GRACE_MS = 30_000` L6870); message type `identify` re-runs it (L7247).
- Session event helpers: `broadcastSessionEvent` (L6880), `sendToSessionHost` (L6898 — falls back to notify WS, rewriting `knock`→`session-knock`), `sendToSessionUser` (L6950).

#### Shutdown & boot (L7318–L7440)

`gracefulShutdown(signal)` (L7321): idempotent; watchdog `process.exit(1)` after `COLLAB_SHUTDOWN_DEADLINE_MS` (default 15 000); closes HTTP listener; sends `close(1001,'server_shutting_down')` to all four WS pools; 1.5 s settle; `persistence.close()`. SIGTERM/SIGINT wired L7367–7368; `unhandledRejection` logged-not-fatal (L7372), `uncaughtException` logged-not-fatal (L7376). Boot async IIFE (L7381): `persistence.connect()` → restore sessions + blocks → `server.listen(PORT,'0.0.0.0')` → start proxy scanner, k8s-only `spawner.startCuller()` (L7412), `shadowContinuousProducer.start()`, container/runtime port monitors, `proxyService.onPortsChanged → managedProgramRuntime.recomputeManagedPorts`.

#### Env vars read directly

`SYNTHI_RUNTIME_WORKSPACE_UMASK`, `LOCAL_TURN_URL`, `LOCAL_TURN_USERNAME`, `LOCAL_TURN_CREDENTIAL`, `COLLAB_SHUTDOWN_DEADLINE_MS`, `KUBERNETES_SERVICE_HOST`, `ENABLE_CONTAINER_RUNTIME`, `ENABLE_CODESITE_DOCKER_RUNTIME`, `DOCKER_SOCKET_PATH`, plus everything surfaced through `config.js` (see [[#config-js]]), `runtimePodSpec`, `runtimePodTerminal`, `proxyService`, `terminalService`, and `collabGatewayAuth`. Full index: [[#Environment variable index]].

#### Failure behavior

Route-level `try/catch` → JSON `{error}` with 500; invalid JSON body → 400 `Invalid JSON`; missing params → 400; permission failures → 403 `permission_denied`; gateway auth failures → 401 via `writeCollabGatewayAuthError`; CodeSite denials → `CODESITE_WRITE_DENIED` mapping in `writeCodeSiteDenied(res,err)` (L1448) preserving err.status; GCS flush failure never fails the save — sets `gcsBackupDegraded` + `backup-status` broadcast (degraded); TURN failure → STUN-only success response; unscoped doc flush throws; shutdown bounded by deadline watchdog.

---

## Related

[[Collab Server]] · [[Area - Supporting Services Internals]]

[[00 Home|🏠 Back to Home]]
