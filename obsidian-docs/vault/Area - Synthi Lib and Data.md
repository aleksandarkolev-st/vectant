---
tags: "frontend", "lib", "prisma"
type: exhaustive-area-reference
source-repo: vectant-ade
generated: 2026-08-25
---

# Area - Synthi Lib and Data

> [!info] Exhaustive reference — every module/route/file in this area, with `path:LNN` citations. Raw source: `docs/obsidian-src/area-synthi-lib.md`.

---
area: synthi
scope: synthi/src/lib, synthi/src/services, synthi/src/workers, synthi/src/server, synthi/src/extensions, synthi/prisma, synthi/scripts
status: complete
generated: 2026-08-25
method: static analysis (AST-lite regex pass over every file), import-graph resolution (`@/*` -> `synthi/src/*`, jsconfig paths), grep-based reverse-dependency counts, prisma schema parse
---

**synthi — lib / services / prisma area analysis**

Exhaustive per-file analysis of `synthi/src/lib` (230 files, 13 dirs incl. `__tests__`), `synthi/src/services`
(38), `synthi/src/workers` (1), `synthi/src/server` (2), `synthi/src/extensions` (67), `synthi/prisma`
(schema with **56 models** + 43 SQL migrations), and `synthi/scripts` (37). Refs use `synthi/src/lib/foo.js:L10`.

## 1. Overview

Synthi is a browser IDE (Next.js App Router + Redux + Monaco) whose server side is thin: most "backend"
logic lives in `src/lib` modules imported by `app/api/**` route handlers, plus a separate collab/signaling
server reached over HTTP/WS. The area under review covers:

- **`src/lib`** — server-only domain libraries (auth, tenancy, crypto, integrations, jupyter gateway,
  git providers) and client-side feature stores; four very large governance subsystems:
  `codesite/` (agent mutation governance control plane, 49 files, dominated by a 13,588-line
  `controlPlane.js`), `local-support/` (remote-support trust/relay control plane), `programs/`
  (container program marketplace), `agent-routing/` (chat/agent tool routing).
- **`src/services`** — browser-side service singletons: compiler (WebRTC/WebSocket signaling),
  collaboration (Yjs CRDT via Web Worker), remote-control session mgmt, Dojo agent-workflow client,
  analyzer gateway WS client, VFS abstractions.
- **`src/workers`** — `collab-crdt.worker.js`: off-main-thread Yjs lifecycle.
- **`src/server`** — Node-side GCS storage handle + workspace search index builder.
- **`src/extensions`** — an entire in-browser VS Code-compatible extension host (API surface, bridges,
  state machine, scheduler, perf monitors, VSIX loader).
- **`prisma/`** — Postgres schema: tenancy, MCP/Jupyter audit, marketplace commerce, CodeSite
  governance (24 models), Local Support trust (12 models).
- **`scripts/`** — proof harnesses (Playwright-based visual proofs, counterfactual memory proofs,
  quarantine/runtime-boundary proofs), the CodeSite shadow runner + release gate, and NEP live/replay test rigs.

Import aliasing: `@/*` maps to `synthi/src/*` (`synthi/jsconfig.json`). Reverse-dependency counts below
were computed by resolving both relative and `@/` imports across all of `synthi/src`; "importers"
always excludes the module's own tests unless stated.

## 2. Directory map & file inventory

| Scope | Files | Non-test source | Notes |
|---|--:|--:|---|
| `synthi/src/lib` (root) | 42 | 42 | auth, crypto, telemetry, HMR/theme/preview client stores |
| `synthi/src/lib/__tests__` | 4 | 0 | oauthRelayServer, preview-store, terminal-preview-links, workspaceAccess |
| `synthi/src/lib/agent-routing` | 14 | 9 | chat/agent pipeline tool routing |
| `synthi/src/lib/codesite` | 49 | 25 | CodeSite governance control plane |
| `synthi/src/lib/git` | 13 | 9 | provider adapters (github/gitlab/generic), OAuth, PAT store |
| `synthi/src/lib/healing` | 2 | 2 | self-healing rule engine + persistence |
| `synthi/src/lib/integrations` | 12 | 6 | connections/PAT/scope/rate-limit for MCP-facing API |
| `synthi/src/lib/jupyter` | 10 | 6 | notebook gateway client/policy/audit |
| `synthi/src/lib/local-support` | 27 | 14 | Local Support relay/trust control plane |
| `synthi/src/lib/programs` | 54 | 28 | marketplace programs: manifests, gates, payments, runtime |
| `synthi/src/lib/project-templates` | 1 | 1 | new-project scaffold registry |
| `synthi/src/lib/security` | 2 | 1 | CSP builder |
| `synthi/src/services` | 38 | 33 | browser service singletons (+`vfs/`) |
| `synthi/src/workers` | 1 | 1 | collab-crdt web worker |
| `synthi/src/server` | 2 | 2 | GCS + workspace search index (Node) |
| `synthi/src/extensions` | 67 | 59 | VS Code-compatible extension system |
| `synthi/prisma` | 46 | 46 | schema.prisma (47,032 B) + 43 migrations + backfill SQL + lock |
| `synthi/scripts` | 37 | 37 | proof harnesses, shadow runner, release gate |

## 3. src/lib — module-by-module

### 3.0 lib root (42 files)

#### Security & auth

**`workspaceAccess.js`** (253L; 11 route importers across `app/api/**`). Server-side tenancy gatekeeper
for every workspace-scoped API route. Exports `WORKSPACE_MANAGE_ROLES` (`owner`,`admin`,
`workspaceAccess.js:L6`), `requireWorkspaceAccess`, `requireWorkspaceAccessById`,
`requireRuntimeWorkspaceAccess`, `requireWorkspaceManageAccess`, `requireWorkspaceManageAccessById`.
Flow: `getServerSession(authOptions)` -> email lookup (`workspaceAccess.js:L29-36`) ->
`prisma.workspace.findFirst` with nested membership select (`workspaceAccess.js:L38-61`) ->
role check; guest access is delegated to `resolveCollabGuestAccess` (`collabGuestAccess.js`).
Resolves the collab-server URL from `COLLAB_SERVER_URL` / `SYNTHI_COLLAB_SERVER_URL` /
`NEXT_PUBLIC_COLLAB_SERVER_URL` / `COLLAB_URL` (`workspaceAccess.js:L8-27`).
Tested by `synthi/src/lib/__tests__/workspaceAccess.test.js`.

**`tokenCrypto.js`** (28L; imported by `lib/git/token.js`, `lib/integrations/connectionStore.js`,
`lib/jupyter/registry.js`, `app/auth` and 3 more). AES-256-GCM envelope encryption for provider tokens:
key = SHA-256 of `AUTH_SECRET` (`tokenCrypto.js:L6-10`), blob format `<iv_b64>:<tag_b64>:<ct_b64>`
(`encryptToken` `tokenCrypto.js:L12-18`, `decryptToken` `tokenCrypto.js:L20-27`). Mirrors the format
documented on `User.githubTokenCipher` in `schema.prisma:L30`.

**`internalAiAuth.js`** (9L; **17 importers**, the widest-reach lib root module after `prisma.js`/
`utils.js`). Single function `withInternalAiAuth(headers)` stamps `x-synthi-internal-token` from
`AI_BACKEND_AUTH_TOKEN` || `AI_ENGINE_AUTH_TOKEN` onto server->ai-engine requests (`internalAiAuth.js:L1-8`).
Used by nearly every `app/api/**` proxy route.

**`oauthRelayServer.js`** (367L; 2 importers in `app/api/**`). HMAC-signed, one-time-use relay session
tokens for OAuth callbacks that must traverse the desktop shell. Signed payload `relay_<b64url>.<hmac>`
(`signRelayPayload` `oauthRelayServer.js:L61-65`); verification + consumption marking with replay cache
(`verifyRelaySessionToken` `:L67`, `markRelaySessionConsumed`, in-memory `consumedRelaySessions` `:L10`).
TTL default 5 min, cap 15 min (`:L5-6`); secret falls back through `SYNTHI_OAUTH_RELAY_SECRET` ->
`NEXTAUTH_SECRET` -> `AUTH_SECRET` -> `AI_BACKEND_AUTH_TOKEN` (`:L34-40`). Also provides loopback-callback
URL parsing/validation (`parseLoopbackCallbackUrl`, `findExpectedLoopbackCallback`,
`validateCallbackAgainstExpected...`) against `LOOPBACK_HOSTS` (`:L3`). Env: `SYNTHI_OAUTH_RELAY_TTL_MS`.
Tested by `__tests__/oauthRelayServer.test.js`.

**`collabGuestAccess.js`** (86L; imported by `integrations/scope.js` and one other lib module).
Server-only bridge from Next.js routes to the collab-server live session state: resolves whether an
admitted guest (room code / invite token) may act on a workspace. Env: `COLLAB_INTERNAL_TOKEN`.

**`githubToken.js`** (33L). In-memory GitHub-token cache hydrated by `<SessionTokenHydrator/>`;
replaces direct localStorage reads in Redux thunks. Exports `getGithubToken`, `setGithubToken`,
`getGithubTokenSource`, `subscribeGithubToken`. 3 importers (`components/`, `redux/`, `services/`).

**`security/csp.js`** (36L; currently zero in-src importers — consumed as CommonJS,
`module.exports` `csp.js:L33-35`, i.e. from Next config/middleware outside `src`). Builds the app CSP:
`default-src 'self'`; `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:` (WASM +
Monaco workers need eval); `connect-src 'self' http: https: ws: wss: blob:`; `frame-src 'self' blob:
<collab-origin>` so the program App tab can embed `<collab>/port/<N>/` iframes (`csp.js:L1-31`).

#### Data access & tenancy plumbing

**`prisma.js`** (14L). Singleton `PrismaClient` cached on `globalThis.__synthiPrisma` in dev
(`prisma.js:L1-14`). **36 importers** — the backbone of every server-side store module
(codesite/local-support/programs/integrations/jupyter/git stores all go through it).

**`collab-url.js`** (31L; **12 importers**: services, components/collaboration, app pages). Normalizes
the collab-server base URL into HTTP and WS forms (`resolveCollabHttpUrl`, `resolveCollabWsUrl`);
env precedence `NEXT_PUBLIC_COLLAB_SERVER_URL` / `NEXT_PUBLIC_COLLAB_URL` / `NEXT_PUBLIC_YJS_URL`,
default `http://localhost:1234`.

#### AI editor features (NEP / completion / telemetry)

**`nextEdit.js`** (400L; 3 importers: `app/workspace`, `app/api/next-edit*`). Shared constants + Aider-style
search/replace stream parser for Next-Edit Prediction: `API_NEXT_EDIT_ROUTE`, block parser
(`parseBlock`, `createStreamParser`), indent-tolerant matcher (`findIndentTolerantMatch`,
`reindentReplacement`), rejection reasons, `NEP_BLOCK_KIND`. Wire format locked in
`inline_completions_nep_plan.md` per header comment.

**`nepTelemetry.js`** (347L; 1 importer `app/workspace`). Session counters persisted to localStorage;
debounced upload via `/api/next-edit/telemetry`; client kill-switch thresholds (`NEP_KILL_THRESHOLDS`,
`maybeRunKillSwitch`, `isNepKilled`) plus `checkServerKill`. Exports `recordNepEvent`, `rollingStats`,
`telemetrySnapshot`, `drainEventsForUpload`.

**`completion.js`** (235L; 5 importers incl. `app/api/**`). Constants/helpers for inline AI completion:
stop sequence `AI_COMPLETION_STOP_SEQUENCE`, token/char ceilings, `extractCompletion`,
`sanitizeCompletion`, `isCompletionEcho`, `truncateToFirstCompleteBlock`, `COMPLETION_OPEN/CLOSE` markers,
`API_COMPLETION_ROUTE`.

**`aiCompletionTelemetry.js`** (165L; 1 importer). Smaller event vocabulary ('fire'/'accept'/...) mirroring
NEP telemetry for the inline path: `recordAiCompletionEvent`, `aiCompletionRollingStats`,
`aiCompletionSnapshot`.

**`aiReplayHarness.js`** (163L; 2 importers). Browser-local replay/eval capture for AI editor features —
explicitly no upload/no secrets, bounded storage: `createReplayId`, `recordAiReplaySample`,
`exportAiReplayJson`. Feeds `scripts/nep-replay.mjs` workflows.

**`editKindClassifier.js`** (163L; 1 importer). Client-side classification of APPLIED edits into five kinds
(`EDIT_KIND`, `classifyEdit`, `seedSymbolsForEdit`) used by NEP analytics.

**`proxyAiEngine.js`** (67L; 4 importers in `app/api/**`). Server proxy helper to the ai-engine:
base URL from `CODE_INTEL_URL` || `AI_ENGINE_URL` || `http://localhost:8000`; merges
`withInternalAiAuth` headers. Export `proxyAiEngineRequest`.

#### HMR / preview / status islands (client stores)

A family of singleton pub/sub stores consumed by `hooks/useHMR.js`, `hooks/*` and status-bar UI:

- **`adapter-status.js`** (120L) / **`adapter-health-panel.js`** (151L): language-adapter status +
  health panel state (`normalizeAdapterFamily`, `updateAdapterHealth`, `pushError`).
- **`ai-loop-status.js`** (173L): Loop AI status store (`handleAiStatusNotification`,
  `installAiStatusListener`).
- **`loop-status.js`** (120L): generic loop-status store — **orphaned** (no importers; only textual
  mention from `hooks/useHMR.js`).
- **`candidate-tracker.js`** (159L): ghost-text candidate history store.
- **`dirty-files.js`** (129L): dirty-file / rebuild-trigger tracking — **orphaned**.
- **`dynlib-status.js`** (100L): dynamic-library hot-swap status (`handleSwapNotification`).
- **`state-restore-status.js`** (171L): workspace state-restore progress store.
- **`gpu-hmr-status.js`** (188L, `'use client'`): GPU HMR reload-plan store; parses status lines
  (`parseGpuHmrLine`) for snapshot tier/budget/reload reason. Companion to the repo's GPU HMR proof work.
- **`hmr-runtime.js`** (444L; 1 importer `hooks/useHMR.js`): the client-side HMR runtime — receives
  update bundles, validates them, checks accept boundaries, applies to the running app or escalates to
  full reload; class `HMRRuntime` + `isNativePreviewActive()`.
- **`preview-lifecycle.js`** (73L): canonical compiled-preview lifecycle states
  (`PreviewLifecycleState`, `isPreviewAlive/Busy/Error`).
- **`preview-store.js`** (131L): dedicated native-preview lifecycle state machine (single source of truth
  for compiled previews, *not* the JS HMR runtime); tested by `__tests__/preview-store.test.js`.
- **`preview-store-bridge.js`** (123L): routes legacy `synthi:*` window events from CompilerClient into
  the preview store (`installPreviewBridge`).

#### Terminal / theme / UI utilities

- **`terminal-preview-links.js`** (363L; used by `app/auth`, `app/workspace`): safe link handling for the
  embedded terminal — parses URLs, detects runtime-loopback URLs, resolves them against the runtime
  preview host, guards nested-loopback callback params (`LOOPBACK_CALLBACK_PARAM_RE`), persists loopback
  auth replies. Tested by `__tests__/terminal-preview-links.test.js`.
- **`theme-engine.js`** (522L; 5 importers incl. `extensions/loader`): pure functions converting theme JSON
  into CSS-variable maps, derived colors, Monaco/Shiki/terminal themes, DOM application
  (`resolveTheme`, `generateCSSVariables`, `generateMonacoTheme`, `applyThemeToDOM`, `getAllThemesMap`).
- **`theme-creator-schema.js`** (228L): organizes UI color keys into Theme Creator sections
  (`CREATOR_SECTIONS`, `CONTRAST_PAIRS`).
- **`contrast-utils.js`** (114L): WCAG 2.1 contrast math for theme accessibility warnings.
- **`name-validator.js`** (108L): multi-layer offensive-name filter for theme names (`validateThemeName`).
- **`terminal-color-overrides.js`** (89L): per-browser terminal color overrides layered over the theme
  provider, persisted to localStorage.
- **`formatters.js`** (41L): registers Monaco formatting providers that call server `/api/format` —
  **orphaned** (no importers found).
- **`diagnostics-schema.js`** (81L) + **`diagnostics-normalizer.js`** (119L): unified CompileDiagnostics
  shape shared by ErrorOverlay/healing/AI, and normalization of legacy backend diagnostic shapes.
- **`failure-distiller-runtime-evidence.js`** (92L): bounded ring buffer of HMR terminal states feeding
  failure distillation (`installFailureDistillerRuntimeEvidence`), used by `components/healing`.
- **`statusIslandPreferences.js`** (309L): status-island layout preferences (offset/compact/dock/presets)
  with localStorage keys exported individually.
- **`utils.js`** (7L): `cn()` classnames merge (clsx + tailwind-merge); 27 importers, most-imported lib file.
- **`workspaceInstallPlan.js`** (46L): derives dependency-install plans from workspace file listings
  (base64-aware decoding) for the dashboard bootstrap.

#### Misc root files

- **`ai-jumpstart-session.js`** (137L): sessionStorage hand-off of AI jumpstart payload dashboard ->
  workspace page (one-time, same-tab).
- **`project-templates/index.js`** (413L): registry of project/file templates for New-Workspace picker
  (`PROJECT_TEMPLATES`, `buildArchMarkdown`, `formatSystemPromptAddition`); consumed by
  `components/NewProjectPicker.jsx` and `redux/workspaceSlice.js`.

Root tests: `__tests__/oauthRelayServer.test.js`, `__tests__/preview-store.test.js`,
`__tests__/terminal-preview-links.test.js`, `__tests__/workspaceAccess.test.js`.

### 3.1 lib/agent-routing (9 source + 5 test files)

Routing layer that lets `app/api/chat/route.js` and `app/api/agent/route.js` decide which tools/skills
an agent turn may use, without shipping SKILL.md bodies to the router.

| File | What it does / exports | Imported by |
|---|---|---|
| `skill-metadata-registry.js` (320L) | Deliberately-small skill metadata records ("SKILL.md bodies never belong in this module"); `toSkillMetadata`, `SkillMetadataRegistry`, built-in `REPOSITORY_SKILL_METADATA`, singleton `repositorySkillRegistry` | agent-pipeline-routing, chat-tool-routing, selective-skill-loader (+tests) |
| `agent-execution-policy.js` (82L) | Server-owned capability policy for legacy chat agent types — "client may ask for a smaller set, never expand": `SERVER_AGENT_TOOL_POLICY`, `getServerAllowedToolIds`, `selectServerAllowedTools`, `narrowAuthoritativeIds` | app/api/agent/route.js, agent-pipeline-routing |
| `agent-pipeline-routing.js` (108L) | Routes atomic-agent tasks through `packages/atomic-orchestrator` orchestrator + skill metadata: `PIPELINE_TOOL_CATALOG`, `routePipelineAgentTask` | app/api/agent/route.js, components/chat/hooks/useAgentPipeline.js |
| `chat-tool-routing.js` (152L) | Chat-side tool selection: `CHAT_TOOL_METADATA`, `routeChatAgentTask`, `selectExplicitExternalToolNames` | app/api/chat/route.js |
| `selective-skill-loader.js` (106L) | Reads only selected SKILL.md instruction bodies from disk (budgeted, `VECTANT_REPOSITORY_ROOT` aware): `loadSelectedSkillInstructions`, `SELECTIVE_SKILL_LOADING_DEFAULTS` | app/api/agent/route.js, app/api/chat/route.js |
| `skill-execution-context.js` (32L) | One-paragraph execution context naming ≤3 selected skills: `buildSelectedSkillExecutionContext` | app/api/chat/route.js |
| `agent-context-budget.js` (22L) | Bounds inter-agent context crossing execution boundaries: `limitAgentContext`, `DEFAULT_AGENT_CONTEXT_CHAR_BUDGET` | app/api/agent/route.js, useAgentPipeline.js |
| `independent-agent-validator.js` (57L) | Validates results of independently-launched agents (tool-call evidence, compact reasons): `validateIndependentAgentResult` | app/api/agent/route.js |
| `workspace-agent-protocol.js` (17L) | Immutable server-owned baseline protocol text `ATOMIC_AGENT_PROTOCOL` for terminal-launched coding agents | app/api/chat/route.js |

Tests co-located in `agent-routing/__tests__/` (context budget, pipeline routing, chat tool routing,
independent validator, skill metadata registry). External touchpoint: imports
`../../../../packages/atomic-orchestrator/src/index.js` (cross-package dependency).

### 3.2 lib/codesite (25 source + 24 test files)

The CodeSite governance subsystem: an "airspace control" metaphor for governing autonomous coding agents
mutating a repository — projects, zone policies, execution plans, mutation leases/transactions, proof
bundles, knowledge items, permits/documents, incidents, channels. All persistence flows through
`@/lib/prisma`; all artifacts additionally mirror to a filesystem artifact tree.

**`controlPlane.js`** (13,588L, ~536 KB — the largest source file in the repo; 85 exported functions).
Single-file implementation of the whole control-plane surface, grouped by domain (function names):
membership (`upsertProjectMember`, `listProjectMembers`, `revokeProjectMember`), projects
(`listProjects`, `createProject`, `getProject`, `updateZonePolicy`, `updateControlPlan`), agent sessions
(`createAgentSession`, `attachAgentSession`, `heartbeatAgentSession`, `detachAgentSession`,
`requireAgentTokenAuthority`), knowledge (`getRelevantAgentContext`, `createAgentKnowledgeItem`,
`getAgentSharedKnowledge`, `listProjectKnowledge`, `respondToAgentKnowledgeInbox`),
plans/leases/transactions (`createExecutionPlan`, `requestMutationLease`, `openTransaction`,
`recordTransactionWrite`, `validateTransaction`, `commitTransaction`, `abortTransaction`,
`dryRunTransactionWrites`, `preflightCodeSiteFsWrite`), documents/permits/routes (`createDocument`,
`createPermit`, `reviewDocument`, `proposeRouteRevision`, `applyRouteRevision`), incidents/inspections
(`createIncident`, `resumeMaydayIncident`, `createInspectionRun`, `completeInspectionRun`), metrics/artifacts
(`getCodeSiteMetrics`, `previewArtifacts`, `exportArtifacts`, `getSchemas`), proofs
(`getProofBundle`, `attachProofBundleCommit`, `getLineProvenance`), and registered direct agent channels
(`requestAgentChannel`, `acceptAgentChannel`, `rejectAgentChannel`, `closeAgentChannel`,
`reportAgentChannelViolation`, `listProjectChannels`; section banner at `controlPlane.js:L13144`).
It spawns subprocesses (`child_process.spawn`) for the shadow runner (env
`SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND`, `_TIMEOUT_MS`, `_CWD`) and writes artifacts under
`SYNTHI_CODESITE_ARTIFACT_ROOT`. Sole production consumer: the catch-all route
`app/api/workspace/[slug]/codesite/[[...path]]/route.js` (plus its own 380 KB test file).

**`artifacts.js`** (1,436L): versioned artifact projections + JSON-Schema definitions
(`CODESITE_ARTIFACT_VERSION`, `codesiteSchemas`, `CODESITE_MCP_TOOLS`,
`buildSharedKnowledgeRepoProjection`, `buildArtifactProjection`, `quarantineReviewRecords`);
writes to disk unless `SYNTHI_CODESITE_DISABLE_ARTIFACT_WRITE`; history capped by
`SYNTHI_CODESITE_ARTIFACT_PATH_HISTORY_MAX_BYTES`.

Remaining modules (all under `lib/codesite/`, importer lists exclude tests):

| File | Purpose / exports | Imported by |
|---|---|---|
| `json.js` (35L) | Safe JSON helpers: `parseJson`, `stringifyJson`, `asArray`, `stableJson` (canonical hashing input) | 11 sibling modules |
| `policy.js` (1,210L) | Airspace classes (`AIRSPACE_CLASSES` A=critical…), event-type registry (`CODE_SITE_EVENT_TYPES`, `validateCodeSiteEventType`), path normalization/classification (`normalizePath`, `classifyPath`, `pathsForRoute`, `matchPathPattern`), zone-policy compiler (`compileZonePolicy`, `normalizeRepoSignals`), content `digest` | 7 siblings (controlPlane, artifacts, dojoProof, knowledgeRouting, proof, repoPolicyCompiler, repoSnapshot) |
| `proof.js` (447L) | Proof bundle build/verify/sign (`buildProofBundle`, `verifyProofBundle`, `signProofBundle`, commit trailers `proofCommitTrailers`); authority base dir `SYNTHI_CODESITE_PROOF_AUTHORITY_BASE_DIR` | artifacts, controlPlane |
| `repoPolicyCompiler.js` (552L) | Scans a real repo for policy signals (skip-list `.git/.next/.turbo/…`), `discoverRepoPolicySignals`, `detectRepoRoot`; caps via `SYNTHI_CODESITE_REPO_SCAN_MAX_FILES` | controlPlane, repoSnapshot |
| `repoSnapshot.js` (554L) | Read-snapshot evidence for transactions: `buildReadSnapshotEvidence`, `validateReadSnapshotEvidence`, `resolveCodeSiteRepoRoot`; size caps `SYNTHI_CODESITE_SNAPSHOT_MAX_*` | controlPlane |
| `metrics.js` (775L) | Fleet/project metric computation `buildCodeSiteMetrics` (schema `synthi.codesite.metrics.v1`) | artifacts, controlPlane |
| `pilotLicense.js` (810L) | Pilot-license health/clearances gating sessions (`buildPilotLicenseHealthRecords`, `applyPilotLicenseHealthGate`, schema v1) | artifacts, controlPlane, metrics |
| `knowledgePolicy.js` (696L) | Knowledge item validation/state machine (`KNOWLEDGE_KINDS` discovery/lead/shared_skill/impact_notice/handoff, `allowedKnowledgeTransitions`, `transitionKnowledgeItem`, `safeKnowledgeProjection`) | artifacts, knowledgeRecords |
| `knowledgeRecords.js` (162L) | Record builders/projections (`buildKnowledgeRecord`, `projectKnowledgeRecord`) | artifacts, controlPlane |
| `knowledgeResponses.js` (109L) | Allowed response actions per kind (`allowedKnowledgeResponseActions`, `validateKnowledgeResponse`) | controlPlane |
| `knowledgeRouting.js` (215L) | Path-overlap delivery planning (`knowledgePathsOverlap`, `buildKnowledgeDeliveryPlan`) | controlPlane |
| `knowledgeEvents.js` (21L) | Canonical event-type names (`canonicalKnowledgeEventType`) | controlPlane |
| `filesystemBoundaryProof.js` (234L) | Filesystem boundary proof records (schema `…filesystemBoundaryProof.v1`, `buildFilesystemBoundaryProofRecords`) | artifacts, controlPlane |
| `substrateIdentity.js` (62L) | Ref/evidence-ref normalization shared beyond codesite (`normalizeCodeSiteRef`, `codeSiteEvidenceRefsJson`, `emptyCodeSiteIdentityFields`) | controlPlane, `app/api/chat/externalTools.js`, `app/api/integrations/mcp/audit/route.js`, `lib/programs/store.js` |
| `channelSecurity.js` (145L) | Direct-channel security primitives: modes/transports, token prefix/HMAC, duration caps, replay window (`CHANNEL_MODES`, `hashChannelToken`, timing-safe compares); env `SYNTHI_CODESITE_CHANNELS_DISABLED`, `SYNTHI_CODESITE_MAX_ACTIVE_CHANNELS`, `SYNTHI_CODESITE_MIN_CHANNEL_MODE` | autoChannels, controlPlane |
| `autoChannels.js` (105L) | Auto-open direct channels between attached agents (`autoOpenDirectChannels`) | controlPlane |
| `deliverySecurity.js` (87L) | Outbound webhook hardening (Workstream F.2): origin allow-list, signing secret, `endpointDeliveryAllowed`, `signDeliveryEnvelope` | controlPlane |
| `dojoProof.js` (168L) | Bridges CodeSite to Dojo proof capsules (`buildCodeSiteDojoProofInput`, `verifyCodeSiteDojoProof`) | controlPlane |
| `dojoPublicVerifier.js` (295L) | Public (server-less) Ed25519/crypto verification of Dojo proof capsules (`verifyDojoProofCapsulePublicWithKeyRecord`) | dojoProof |
| `projectCoordinationBus.js` (322L) | Seven-stage observation pipeline normalize→redact→classify→correlate→authorize→persist→route (`createProjectCoordinationBus`) | controlPlane |
| `projectObservation.js` (564L) | Typed runtime/agent observations (schemas, producer kinds, run states; `recordObservation` builders) | controlPlane |
| `routeHelpers.js` (137L) | Route glue for the catch-all API: JSON body/response helpers, `requireCodesiteAccess`, `enforceRateLimit`, error mapping; env `SYNTHI_CODESITE_TOKEN`, `SYNTHI_WORKSPACE_AUTH_BYPASS` (+NEXT_PUBLIC variant) | catch-all route, controlPlane |
| `activityBridgeReadiness.js` (201L) | Probes collab/activity bridge + deployment status for readiness UI (`probeCodeSiteActivityBridge`, `probeCodeSiteDeploymentStatus`); many env fallbacks (`COLLAB_SERVER_URL`, `SYNTHI_CODESITE_API_BASE_URL`, `SYNTHI_APP_INTERNAL_URL`, …) | catch-all route |

24 co-located test files mirror these modules (largest: `__tests__/controlPlane.test.js` at ~380 KB,
`__tests__/artifacts.test.js`, `__tests__/knowledgePolicy.test.js`).

### 3.3 lib/git (9 source + 4 test files)

Git provider integration: OAuth + PAT storage per user/workspace, with provider adapters and an SSRF-gated fetch.

| File | What it does / exports | Imported by |
|---|---|---|
| `providerConfig.js` (42L) | Per-provider hosted defaults + OAuth endpoints; `baseUrl` override for self-hosted. `resolveApiBase`, `oauthClient`, `oauthEndpoints`. Endpoints: `https://api.github.com`, `https://github.com/login/oauth/authorize`, `/login/oauth/access_token`, `/login/device/code`, `https://gitlab.com/api/v4`, `https://gitlab.com/oauth/authorize` | adapters/github, adapters/gitlab, token, 4 OAuth routes |
| `safeFetch.js` (8L) | `gitFetch()` — fetch gated by the Slice-1 SSRF guard from `@synthi/mcp-hub` (`assertSafeUrl`); throws instead of fetching on unsafe URLs | adapters, token, 3 oauth routes |
| `token.js` (41L) | `withFreshToken(provider, fn)` — decrypts stored PAT/OAuth token (`tokenCrypto`), transparently refreshes expired OAuth tokens via provider endpoints and persists the new cipher | adapters/github, adapters/gitlab |
| `store.js` (97L) | Provider persistence: actor/workspace scoping (`scopeWhere`), `listProviders`, `createPatProvider`, `upsertOAuthProvider`, `deleteProvider`; tokens via `encryptToken` | 4 routes under `app/api/integrations/git/**` |
| `routeHelpers.js` (28L) | Route glue for provider CRUD sub-routes: `loadOwnedProvider`, `respond` | pulls/repos/status routes |
| `adapters/index.js` (12L) | Registry `getAdapter(kind)` over `{github, gitlab, generic}` | test route, routeHelpers |
| `adapters/github.js` (38L) | GitHub REST calls (repos/branches/PRs/pulls) with error mapping, through `withFreshToken` + `gitFetch` | index |
| `adapters/gitlab.js` (41L) | GitLab REST v4 equivalent | index, generic |
| `adapters/generic.js` (3L) | Self-hosted GitLab-compatible alias: `export { gitlab as generic }` | index |

Tests: `__tests__/providerConfig.test.js`, `__tests__/store.test.js`, `__tests__/token.test.js`,
`adapters/__tests__/adapters.test.js`.

### 3.4 lib/healing (2 files)

- **`ruleEngine.js`** (433L): pure routing layer for the self-healing system — given a diagnostic + fix +
  user-authored rules + confidence thresholds, decide auto-apply vs ask. Vocabularies
  (`TargetVocabulary`, `ScopeVocabulary`, `ActionVocabulary`), `categorizeDiagnostic`, `ruleMatches`,
  `evaluateFix`, `ruleToSentence`, `makeRuleId`, `createRule`. Consumed by ProblemsPanel,
  HealingRulesEditor, useAIHealing/useSelfHealing/useSmartRuleSuggestions hooks.
- **`persistence.js`** (47L): localStorage persistence of healing config only (never applied-fix history
  or undo stacks): `loadHealingPersistedState`, `saveHealingPersistedState`, `clearHealingPersistedState`.

### 3.5 lib/integrations (6 source + 6 test files)

Access-control + connection plumbing for the MCP-facing integrations API.

| File | Purpose / exports | Importers |
|---|---|---|
| `session.js` (18L) | `resolveActor()` — NextAuth session -> `{userId, email}` via prisma | **46** API routes (widest reach in lib after prisma/utils) |
| `scope.js` (69L) | Workspace/personal scope authorization: `canReadScope`, `canWriteScope` (+guest bridge); role gates for mutations | **45** routes |
| `rateLimit.js` (56L) | Dependency-free fixed-window limiter (in-memory, per-process) with tunable buckets via env (`SYNTHI_RL_CRUD`, `_TEST`, `_GIT`, `_AUDIT`, `_EXTCALL`, `_RESOLVE`, `_TELEMETRY`, `_CHANNELS`): `checkLimit`, `RATE_LIMITS`, `__resetRateLimits` | 22 routes |
| `connectionStore.js` (114L) | MCP connections CRUD over prisma with encrypted tokens ("identified by id, never by name"): `listConnections`, `createConnection`, `updateConnection`, `deleteConnection`, `resolveToolConfigs` | externalTools.js, connections routes, mcp/resolve |
| `pat.js` (20L) | Personal-access-token hashing/generation (`synthi_pat_` prefix, sha256 hex lookup — plaintext never stored): `hashToken`, `generatePat`, `looksLikePat` | patAuth, tokens route |
| `patAuth.js` (31L) | Bearer-token extraction + PAT authentication against prisma: `bearerToken`, `authenticatePat` | 10 mcp/** routes |

### 3.6 lib/jupyter (6 source + 4 test files)

Notebook gateway: policy-checked access to user-registered Jupyter servers, with audit.

| File | Purpose / exports | Imported by |
|---|---|---|
| `policy.js` (45L) | Origin allow-list + endpoint/path whitelist (`/^api\/status$/`, `api/contents`, `api/sessions`, …), private-IP gating: `validateJupyterOrigin`, `resolveApprovedJupyterOrigin`, `safeJupyterPath`, `allowedJupyterEndpoint`. Env `JUPYTER_ALLOWED_ORIGINS`, `JUPYTER_ALLOW_DOCKER_HOST`, `JUPYTER_ALLOW_PRIVATE_HTTP` | client, registry |
| `client.js` (53L) | `JupyterClient` WS client to kernel gateways (uses `next/dist/compiled/ws` server-side), `JupyterGatewayError`; enforces policy before connect | 8 jupyter/mcp routes + chat toolDefinitions |
| `registry.js` (11L) | Server registry CRUD w/ encrypted token: `listJupyterServers`, `createJupyterServer`, `getJupyterServer`, `resolveJupyterServer`, `revokeJupyterServer` | 10 routes/toolDefinitions |
| `audit.js` (11L) | `recordJupyterAudit` — redacted operational facts only; "observability must never block Jupyter work" | 8 jupyter routes |
| `notebook.js` (83L) | Notebook parse/create/normalize/serialize with hard caps (25 MB notebook / 512 KB cell source / 2 MB output), sha256 revisions: `parseNotebook`, `createNotebook`, `normalizeNotebook`, `revisionOf` | save/snapshot routes, NotebookViewer, redux workspaceSlice |
| `outputSafety.js` (6L) | Safe output rendering: MIME preference list, `chooseSafeOutput`, `safeImageUrl`, `isExternalUrl` | NotebookViewer.jsx |
| `flags.js` (9L) | Frozen feature flags: `jupyterFlags.viewer/editing/agentExecution` (env `NEXT_PUBLIC_JUPYTER_NOTEBOOK_VIEWER/_NOTEBOOK_EDITING/_AGENT_EXECUTION`) | toolDefinitions, Editor, NotebookViewer |
| `sync.js` (19L) | Deterministic notebook sync state (`compareNotebookRevisions`, `savePlan`) — currently no in-src importers |

### 3.7 lib/local-support (14 source + 13 test files)

Local Support trust control plane: pairing a desktop device into a browser-controlled remote-support
session with signed request envelopes, durable relay queues, encrypted payloads, org-scoped policy,
security events, transparency state, and linked-project identities.

**`controlPlane.js`** (1,695L): protocol constants + pure decision logic.
`LOCAL_SUPPORT_PROTOCOL`, `DEFAULT_MIN_APP_VERSION`, `POLICY_VERSION`,
`LOCAL_SUPPORT_SESSION_TTL_MS`, `POLICY_PRECEDENCE`; envelope crypto/verification
(`signRequestEnvelope`, `verifyRequestEnvelopeSignature`, `enforceRequestEnvelopeReplayProtection`),
device proof-of-possession (`signDeviceProof`, `verifyDevicePairingProof`), semver comparison,
pairing challenge lifecycle (`createPairingChallenge`, `claimPairingChallenge`, `completePairingChallenge`),
and decision builders (`buildRelayForwardDecision`, `buildPreviewGatewayDecision`,
`buildAdminRevokeDecision`, `buildTransparencyActionDecision`, `summarizeSecurityEvent`,
`summarizeAdminState`, `recordAdminRevocation`). Consumed by all six `app/api/local-support/**` route groups.

Store modules (all thin prisma wrappers; importers are local-support API routes):

| File | Purpose / exports |
|---|---|
| `sessionStore.js` (171L) | Durable paired sessions: `persistPairedSession`, `findActivePairedSession`, `authorizeRelaySession`, `renewPairedSession`, TTL 1h |
| `pairingStore.js` (233L) | Org lookup + durable pairing challenges: `findPairingOrganization`, `persistPairingChallenge`, `claimPairingChallengeDurably`, `completePairingChallengeDurably` |
| `deviceAuth.js` (139L) | Device request authentication via signature verification + active-session lookup: `authenticateLocalSupportDevice`, `deviceRequestPayload` |
| `relayStore.js` (547L) | Durable work queues with leases (15s default / 60s max): relay requests (`enqueueRelayRequest`, `leaseRelayRequest`, `recordRelayOutcome`) and control commands (`enqueueLocalControlCommand`, `leaseLocalControlCommand`, `recordLocalControlOutcome`) |
| `relayPayloadCrypto.js` (49L) | AES payload encryption versioned `VECTANT-RELAY-PAYLOAD-V1`: `encryptRelayPayload`, `decryptRelayPayload`, `relayPayloadSha256` |
| `relayPayloadStore.js` (177L) | Encrypted approved-payload store: `storeApprovedRelayPayload`, `takeApprovedRelayPayload`, `denyReviewedRelayRequest` |
| `policyStore.js` (475L) | Durable global policy doc (id `"global"`) + public projection: `readDurableLocalSupportPolicy`, `publicLocalSupportPolicy`, `updateDurableLocalSupportPolicy` |
| `adminStore.js` (141L) | Durable admin revocations over revocable relay statuses: `readDurableAdminState`, `recordDurableAdminRevocation` |
| `securityEventStore.js` (39L) | Hashed security-event summaries: `persistSecurityEvent`, `readRecentSecurityAlerts` |
| `transparencyStore.js` (156L) | Cloud transparency state for the account: `readCloudTransparencyState` |
| `linkedProjectStore.js` (84L) | Cloud-visible collaboration identity holding graph metadata + selection hashes only, never paths/source: `createLinkedProject`, `activateLinkedProject`, `listLinkedProjects` |
| `acceptance.js` (463L) | Release-readiness catalog (no importers yet): `RELEASE_BLOCKER_CATEGORIES`, `RELEASE_BLOCKERS` (loopback-binding, etc.), `RED_TEAM_SCENARIOS`, `UX_ACCEPTANCE_PROMPTS`, `summarizeLocalSupportReleaseReadiness` |

Plus `postgres.integration.test.js` (real-DB integration harness).

### 3.8 lib/programs (28 source + 26 test files)

Container-program marketplace: recipe manifests -> normalized configs -> runtime sessions via the
collab-server container spawner, wrapped in publish review gates and Stripe-style payments.

**Core pipeline**

- **`manifest.js`** (249L): parser/validator for the `vectant.programs.json` recipe manifest producing a
  fail-closed `NormalizedProgramConfig`: `KNOWN_SCOPES`, `SUPPORTED_RUNTIME_TYPES`, `ALLOWED_SURFACES`,
  `parseProgramManifest` family. 10 importers.
- Importers into that shape: **`devcontainer.js`** (213L, documented devcontainer.json subset),
  **`compose.js`** (61L, docker-compose.yml subset), **`dockerfile.js`** (59L, build+run mapping),
  **`repoDetect.js`** (41L, highest-precedence artifact detection).
- **`runtimeClient.js`** (174L; 19 importer routes incl. all `app/api/integrations/mcp/programs/**`):
  session CRUD + launch/exec/stop/restart against the collab-server HTTP API
  (`COLLAB_SERVER_URL` || `NEXT_PUBLIC_COLLAB_SERVER_URL`, default `http://localhost:1234`);
  `launchProgramRuntime`, `execInWorkspaceRuntime`, `stopProgramRuntimeSession`.
- **`workspaceMount.js`** (25L): shared bind-mount rule so programs see the same `/workspace` as the IDE.
- **`hostEscape.js`** (35L): single denylist source of truth for host escape vectors
  (`HOST_ESCAPE_FLAG_RE`, `DOCKER_SOCK_RE`, `HOST_BIND_MOUNT_RE`, `findCommandHostEscape`).
- **`defaultPrograms.js`** (261L): canonical default catalog of official `@vectant/*` programs
  (postman/portainer/dbeaver…; image/port env overrides) — `ensureDefaultPrograms` seeds them.
- **`scaffoldTemplates.js`** (117L): inline starter file templates for scaffoldable defaults.

**Review & security gates**

- **`hardGates.js`** (59L): pure fail-closed submission gates reusing manifest validation.
- **`imageScanner.js`** (59L): trivy CVE scan wrapper (injectable runner so tests never shell out;
  `TRIVY_BIN`, `PROGRAM_SCAN_THRESHOLD`).
- **`imageSize.js`** (69L): daemon-free `crane manifest` size gate (`CRANE_BIN`, `PROGRAM_IMAGE_MAX_BYTES`).
- **`reHoster.js`** (53L): re-hosts approved community images into the Artifact Registry pinned by digest
  via `crane copy` (`VECTANT_AR_HOST/_PROJECT/_REPO`).
- **`aiReviewer.js`** (64L): advisory AI risk review calling ai-engine directly (`CODE_INTEL_URL` ||
  `AI_ENGINE_URL` → `http://localhost:8000`) with internal token; `PROGRAM_AI_RISK_THRESHOLD`/
  `PROGRAM_AI_REJECT_THRESHOLD`.
- **`reviewOrchestrator.js`** (182L): submission state machine submitted→scanning→pending_review→approved/
  rejected (autonomous unless `PROGRAM_AI_REVIEW_ENABLED=0`): `submitForReview`, `processSubmission`,
  `approveSubmission`, `rejectSubmission`.

**Commerce**

- **`pricing.js`** (91L): pricing validation + prisma upsert; "paid iff active ProgramPricing with positive price".
- **`entitlements.js`** (56L): publish/install policy gates — `canPublish`, `isPlatformAdmin`
  (`PLATFORM_ADMIN_EMAILS`), `isBillingConfigured`, `canInstall`.
- **`paidEntitlements.js`** (46L): idempotent entitlement rows keyed by (programId, subjectType, subjectId):
  `grantEntitlement`, `revokeEntitlement`, `getActiveEntitlement`.
- **`paidGate.js`** (31L): composes pricing+entitlements into paywall decisions (`evaluatePaywall`).
- **`checkoutReference.js`** (46L): HMAC-signed checkout hand-off binding program+subject+server-price
  (`PAYMENTS_HANDOFF_SECRET`).
- **`stripeSignature.js`** (48L): verifies `Stripe-Signature` without the Stripe SDK (constant-time tag compare).
- **`paymentWebhook.js`** (29L): maps webhook events to entitlement actions (`eventKind`, `extractContext`).
- **`earnings.js`** (20L): publisher earnings math (gross − platform take at `takeRateBps`) — no importers yet.

**Stores & glue**

- **`store.js`** (536L; 25 importing routes): prisma persistence for programs/versions/installs/grants/
  sessions/runtime events (`createPermissionGrant`, `createProgramSession`, `appendProgramRuntimeEvent`, …);
  carries CodeSite substrate refs into program rows.
- **`routeHelpers.js`** (79L): grant-scope normalization + session/event sanitization for MCP program routes.
- **`manifestGenerator.js`** (31L): ai-engine manifest generation client (internal token).

## 4. src/services — service-by-service

Browser-side singletons and clients. Importer counts exclude tests.

### 4.1 Compilation & runtime transport

**`compilerClient.js`** (2,099L, ~100 KB; imported by Editor, useCompiler, useExtensions, useRetryCompile,
workspaceSlice). The compile/run transport: WebRTC data channels for file sync + terminal + LSP +
vscode-server, signaled over a WebSocket.

- Signaling endpoint `SIGNAL_URL` from `NEXT_PUBLIC_COMPILE_SIGNAL_URL`, else same-origin `/signal`
  (non-localhost), else `ws://localhost:9000` (`compilerClient.js:L4-7`).
- Collab HTTP base for the spawner: `NEXT_PUBLIC_COLLAB_SERVER_URL`, else `${origin}/collab`,
  else `http://localhost:1234` (`getCollabHttpBaseUrl` `:L31-44`); remote (non-local) setups auto-enable
  the workspace spawner (`shouldUseWorkspaceSpawner` `:L10-29`) with pod ensure/touch heartbeats
  (`fetch …/api/spawner/ensure` `:L186`, `…/api/spawner/touch` `:L216`, 60s heartbeat `:L8`).
- WebRTC: `RTCPeerConnection` with ICE servers parsed from `NEXT_PUBLIC_ICE_SERVERS` plus short-lived TURN
  credentials fetched from `/api/turn-credentials` (`:L68`); media channel via `getMediaStream`.
- Data channels: `createLspChannel(language)` `:L1180`, `createVSCodeServerChannel()` `:L1205`;
  file sync API `syncFile`/`sendEditDelta`/`deleteFile`/`renameFile`/`mkdirSync`/`syncAllFiles`
  (`:L1229-1344`); remote reads via request/response correlation (`readRemoteFile` `:L1364`).
- Lifecycle: `connect()`, `softReconnect()`, `reconnect()` with disconnect grace timers and offer retries;
  build log streaming (`_emitBuildStream`); `compile({...})` entry `:L1518`; status enum `CompilerStatus`;
  module helpers `getCompilerClient()`, `compileWithWorker()`, `cancelMobileJob()`.

**`MonacoSocketAdapter.js`** (308L): adapts an RTCDataChannel to the WebSocket-like interface
(`onmessage/onclose/onerror/send/close`) that `vscode-ws-jsonrpc`'s `toSocket()` expects — used by the
Editor to run LSP over the compiler's RTC channel.

**`operatorClient.js`** (189L): WS client joining the signaling server as `role="operator"` for the
observability UI (presence broadcasts); env `NEXT_PUBLIC_COMPILE_SIGNAL_URL`. Used by OperatorPanel.

### 4.2 Collaboration

**`collabSessionService.js`** (1,214L; 17 importers across collab UI + workspace page). Frontend service
for "Remote Control" collaboration sessions. All REST calls target the collab server resolved by
`collab-url.js`: create/join/knock/admit/deny (`/session/create` `:L180`, `/session/request-join/:id`
`:L716`, `/session/admit/:id` `:L391`, `/session/deny/:id` `:L420`), permission management
(`/session/permissions/:id` `:L456`), lifecycle (`kick/terminate/leave/regenerate-token/info`),
user blocking (`/user/block`, `/user/unblock`, `/user/blocked-list`), invites
(`/session/invite-user` `:L810`, `/session/join-by-code` `:L838`, `/session/join-user` `:L765`),
plus its own WS connection (`_connectWs` `:L914`). Host session records persist to localStorage;
permission models exported as `DEFAULT_GUEST_PERMISSIONS` / `HOST_PERMISSIONS`.

**`collabClient.js`** (1,265L; 10 importers). Workspace collaboration orchestrator, Phase 4b
"Workerized CRDTs" architecture (`collabClient.js:L1-15`): all Y.Doc lifecycle, CRDT encode/decode and WS
sync live in `workers/collab-crdt.worker.js`, accessed through `crdtWorkerBridge`; this module only
applies lightweight deltas to Monaco. `MonacoTextBinding` (`:L27`) renders remote cursors/selections as
decorations + content widgets; local keystrokes are forwarded offset-based. Connects with
`resolveCollabWsUrl()` (`:L495`, fallback `ws://localhost:1234` `:L497`), socket at `:L1138`.

**`crdtWorkerBridge.js`** (437L): main-thread RPC adapter for the CRDT worker; instantiates it via
`new Worker(new URL('../workers/collab-crdt.worker.js', import.meta.url))` (`crdtWorkerBridge.js:L46-47`);
exports delta subscriptions, awareness events, doc commands; singleton export at `:L435`.

**`workers/collab-crdt.worker.js`** (497L): worker side — Yjs document lifecycle + y-websocket-style sync
protocol entirely off the main thread (`eslint-env worker` header). No direct importers (loaded by URL).

### 4.3 Dojo / agent workflows

**`dojoClient.js`** (2,252L, ~104 KB; **24 importer components** — biggest consumer footprint in services).
Read-mostly facade over the MCP browser-workflow bridge for all Dojo dashboards: workspace summary shape
(`createEmptyDojoSummary` `dojoClient.js:L9-…` with governance/licenseHealth/approvalQueue/caseLaw/
regret/practice sections), skill licensing, therapeutic-access review (`reviewTherapeuticAccess`,
`revokeTherapeuticGrants`), tenant/org id storage keys (`synthi.dojo.tenantId` etc.). Delegates tool calls
to `agentWorkflowClient` and identity to `userIdentity`.

**`agentWorkflowClient.js`** (179L): browser client for the MCP workflow bridge
(`mcp/synthi-mcp/src/browser_workflow_bridge/server.ts`): `resolveAgentWorkflowBridgeUrl/Token`,
`getAgentWorkflowState`, `callAgentWorkflowTool`, `openAgentWorkflowExternalUrl`; default bridge
`http://127.0.0.1:<DEFAULT_BRIDGE_PORT>`.

**`agentWorkflowHandoff.js`** (195L): filesystem conventions for workflow hand-off:
`.synthi/workflows` + `.synthi/dojo` roots, AGENTS.md section markers, safe dir names,
workflow index merging (`mergeWorkflowIndex`, `agentsMan…`).

**`agentWorkflowDojoAudit.js`** (74L): collects audit evidence refs from workflow state
(`collectDojoAuditEvidenceRefs`).

**`escapeHatchClient.js`** (123L): HTTP+SSE client for the MCP operator bridge
(`mcp/synthi-mcp/src/operator_bridge/server.ts`, default `http://127.0.0.1:9465`):
pending-question list/answer/cancel + SSE subscribe. Used by EscapeHatchPanel.

### 4.4 Analysis / healing

**`analyzerGatewayClient.js`** (1,273L; 5 importers). WS client to the analyzer gateway
(`AnalyzerGatewayClient` class; shared singleton via `getSharedAnalyzerClient()`); default URL
`NEXT_PUBLIC_GATEWAY_WS_URL`; drives proactive analysis, runtime healing hooks, and feeds diagnostics to
`runtimeErrorInterceptor`.

**`runtimeErrorInterceptor.js`** (564L): listens for HMR compile-error CustomEvents and orchestrates the
AI healing loop (collect source -> request fix -> apply -> recompile); singleton
`getRuntimeErrorInterceptor`.

**`aiSuppressedRules.js`** (462L): fingerprint-aware suppression store for AI healing rules — two modes,
per-fingerprint or per-rule (`computeFingerprint`, singleton `aiSuppressedRules`).

**`aiFixHistory.js`** (118L): bounded in-memory audit log of AI fix actions (apply/dismiss/auto-apply).

**`preCompileHealer.js`** (368L): zero-latency client-side syntax fixer that runs before HMR compiles
(`preCompileHeal`, `detectLanguage`).

**`monacoDiagnosticsAdapter.js`** (395L): bridges gateway diagnostics into Monaco markers/hover/decorations
and a quick-fix provider (`createMonacoMarkers`, `applyDiagnosticsToModel`, `createQuickFixProvider`).

### 4.5 Files, VFS & git UX

- **`api.js`** (416L): `ApiClient` wrapper around fetch with NextAuth session headers + SynthiException
  mapping; singleton `api`. Consumed by SynthiFileSystemProvider, SearchView, workspace page,
  useAISuggestions, workspaceSlice, loadScheduler.
- **`gitClient.js`** (437L; 14 importers): frontend git operations proxied through the collab server
  (`resolveCollabHttpUrl()` base): status/stage/commit/diff/log/branch ops used by gutter UI and SCM panels.
- **`fileCache.js`** (177L): bounded per-file snapshot cache (32 MB total / 4 MB per file defaults,
  env-tunable) + per-file local history.
- **`loadScheduler.js`** (240L): priority queue over api+fileCache for workspace tree loading.
- **`vfs/VirtualFileSystem.js`** (755L): "server-first" VFS abstraction with IndexedDB read-through cache
  (`IndexedDBCache`, `VirtualFileSystem`, `getVFS`/`destroyVFS`).
- **`vfs/VFSProvider.jsx`** (212L): React context provider binding VFS <-> Redux.
- **`vfs/index.js`** (7L): barrel re-export.
- **`ContainerVFS.js`** (330L): alternative "Gold Standard" container-centric VFS where the server container
  is the source of truth; currently no in-src importers (superseded/experimental relative to vfs/).
- **`vscodeTunnelService.js`** (547L): bridges the vscode-tunnel Service Worker with VSCodeServerProxy over
  BroadcastChannel (chunked message transport; see extensions/bridge).

### 4.6 Language tooling, identity & misc

- **`lspRegistry.js`** (183L): dynamic registry mapping language IDs -> LSP server configurations; extensions register new language->LSP mappings at install time (`initLspRegistry`, `registerLspMapping`, `registerLspForExtension`, `unregisterLspForExtension`); consumed by `hooks/useExtensions.js`; pairs with `MonacoSocketAdapter.js` for the actual LSP transport.
- **`runtimeScope.js`** (64L): derives per-user/per-workspace scoped identifiers for terminals and compile
  sessions (`USER_ID_STORAGE_KEY='synthi-user-id'`, hashing helpers, `buildWorkspaceRuntimeScope`).
- **`userIdentity.js`** (47L): centralised localStorage accessors for current user identity
  (`USER_ID_KEY/_NAME/_AVATAR/_ROLES`, `getCurrentUser`).
- **`sseClient.js`** (227L): single persistent SSE connection multiplexed to hooks (code-intel metrics,
  healing stats, presence) against the collab HTTP base.
- **`perfMarkers.js`** (50L): opt-in performance marks/measures gated by `NEXT_PUBLIC_PERF_MARKERS`.
- **`prClient.js`** (457L): GitHub REST PR management client; resolves the user token through the session
  (server-side encrypted PAT); hits `https://api.github.com`. Used by SourceControlPanel + prSlice.

## 5. src/workers

Single worker: **`collab-crdt.worker.js`** (497L) — see §4.2. Spawned by crdtWorkerBridge via
`new URL(...)`; keeps Yjs transactions off the editor thread.

## 6. src/server (Node-side)

- **`gcsStorage.js`** (27L): builds a `@google-cloud/storage` client from explicit creds
  (`GCP_CLIENT_EMAIL`/`GCP_PRIVATE_KEY`/project envs) and returns the configured bucket name
  (`GCS_BUCKET_NAME`). Imported by 3 workspace persistence routes + search index.
- **`workspaceSearchIndex.js`** (315L): `WorkspaceSearchIndex` — streams workspace archives from GCS
  (`readline` line streaming), builds/maintains a searchable index; served by
  `app/api/workspace/[slug]/index/ensure|status|search/route.js`.

## 7. src/extensions (59 source + 8 test/fixture files)

A complete VS Code-compatible extension system running in the browser. Design doc:
`extensions/ARCHITECTURE.md` (baseline rules: one Monaco instance, single host worker, frozen API
surface). Entry: `index.js` (416L) re-exporting the public API for `hooks/useExtensions.js` and
`components/ExtensionDebugPanel.jsx`.

### 7.1 api/ — vscode.* namespace implementations

`vscode.js` (1,190L) assembles the full namespace from per-namespace factories; every sub-module
communicates with the main thread via `bridge/MessageProtocol.js` types (imported by 13 of them):

| File | Namespace | Notes |
|---|---|---|
| `commands.js` (77L) | `vscode.commands` | register/execute via main-thread RPC |
| `window.js` (658L) | `vscode.window` | editors, messages, quick picks, terminals |
| `workspace.js` (485L) | `vscode.workspace` | FS events, config, text documents |
| `languages.js` (257L) | `vscode.languages` | all `register*Provider` calls emit REGISTER_PROVIDERS to the bridge (`.bak` file present: pre-refactor copy) |
| `debug.js` (147L) | `vscode.debug` | sessions, breakpoints, adapters |
| `env.js` (217L) | `vscode.env` | clipboard, openExternal, uri scheme |
| `extensions.js` (136L) | `vscode.extensions` | installed-extension queries |
| `authentication.js` (73L) | `vscode.authentication` | sessions routed through host auth |
| `scm.js` (101L) | `vscode.scm` | rootless SCM API |
| `tasks.js` (117L) | `vscode.tasks` | task execution via main thread |
| `terminal.js` (120L) | `vscode.window.createTerminal` + terminals | routed to main thread |
| `uri.js` (167L) | `Uri` class | VS Code-compatible |

### 7.2 bridge/ — worker <-> main-thread transport

- **`MainThreadBridge.js`** (1,570L): main-thread coordinator — routes extension RPC either to the local
  web-worker host or to a remote vscode-server via proxy; owns StorageService and MonacoBridge wiring;
  also drives the extension test runner.
- **`WorkerProxy.js`** (493L): typed RPC proxy toward `ExtensionHostWorker`.
- **`VSCodeServerProxy.js`** (884L): browser-side proxy to `vscode-server-manager.js` running on the host,
  with chunk reassembly (`ChunkReassembler`) over the tunnel service transport.
- **`LanguageProviderBridge.js`** (986L): receives REGISTER_PROVIDER events from the worker and registers
  corresponding Monaco language providers.
- **`MonacoBridge.js`** (495L): "Monaco text model is authoritative" — bridges extension document edits to
  Monaco models without shadow state.
- **`MessageProtocol.js`** (258L): typed request/response/event envelope (`createRequest`, `createResponse`,
  `createEvent`, method enums shared by api/ modules).

### 7.3 core/ — runtime contract, isolation, observability

Phases A–G per `core/index.js` (123L barrel):

| File | Purpose |
|---|---|
| `ExtensionStateReducer.js` (725L) | SINGLE authoritative state manager; formalized runtime contract states |
| `ExtensionState.js` (545L) | State machine definitions consumed by 6 core modules |
| `ExtensionManager.js` (876L) | Phase A+B main-thread coordinator / entry point |
| `CrossExtensionIsolation.js` (633L) | Per-extension message queues, rate limiters, fair scheduler ("single worker = shared fate unless enforced") |
| `FrozenAPI.js` (452L) | Stable API-surface contract definition |
| `RuntimeAPIEnforcer.js` (427L) | Runtime access enforcement beyond static checks |
| `RestartFence.js` (409L) | Rejects in-flight RPCs across restart boundaries |
| `LivelockDetector.js` (420L) | Drift detection beyond heartbeats + per-extension CPU tracking |
| `ObservabilityStore.js` (507L) | IndexedDB async observability (localStorage deemed blocking/unsafe) |
| `ErrorReporter.js` (381L) | Phase F user-facing error reporting |
| `ExtensionInspector.js` (447L) | Phase D internal debugging/monitoring UI data |
| `VSIXCompatibility.js` (656L) | Classifier analyzing VSIX packages for web-compatibility before install |
| `TestSuite.js` (623L) | In-repo test runner covering state invariants, livelock, isolation |

### 7.4 host/ — extension host worker

- **`ExtensionHostMain.js`** (1,060L): core logic inside the worker; dispatches to all api/* namespaces.
- **`ExtensionHostWorker.js`** (29L): worker entry point.
- **`ActivationManager.js`** (248L): strict-discipline activation sequencing.
- **`ExtensionContext.js`** (299L): per-extension context passed to `activate()` (subscriptions, storage).
- **`ExtensionRegistry.js`** (311L): metadata + allowed activation-events registry.

### 7.5 loader/, scheduler/, perf/, services/, webview/

- loader: `ManifestParser.js` (212L, package.json validation), `ExtensionInstaller.js` (480L, IndexedDB
  persistence surviving reloads), `GrammarRegistrar.js` (241L, TextMate grammars -> Monaco),
  `ThemeRegistrar.js` (138L, theme contributions), `ExtensionImportParser.js` (106L, id parsing used by
  ExtensionSidebar), `index.js` barrel.
- scheduler: `ExtensionScheduler.js` (331L, CPU budgets), `MemoryMonitor.js` (255L, heap limits),
  `TimerThrottler.js` (343L, setTimeout/setInterval governance), `VisibilityManager.js` (248L, pause on
  hidden tab); `index.js` barrel.
- perf: `TypingLatencyMonitor.js` (253L, target <10ms keypress→render), `ActivationBenchmark.js`
  (278L, target <300ms median activation), `CPUProfiler.js` (273L); `index.js` barrel.
- services: `StorageService.js` (303L, IndexedDB store `synthi-extensions`).
- webview: `WebviewManager.js` (510L, iframe webviews under a strict CSP with sandboxing).
- test/: fixtures + node runner (`hello-world-extension.js`, `bad-extension.js`, manifests,
  `test-node.mjs`, `test.html`, `extension-test-runner.js`).

## 8. prisma — schema models (56)

`synthi/prisma/schema.prisma` (47 KB, 56 models, generator `prisma-client-js`,
datasource `postgresql` w/ `DATABASE_URL`). Grouped below; line numbers are schema positions.

### 8.1 Core tenancy & identity (6)

| Model | Purpose & key relations |
|---|---|
| `Workspace` (L10) | Tenant root: `slug @unique`, optional `repoUrl`; has many `memberships` |
| `User` (L22) | Email-keyed user; `githubTokenCipher` AES-256-GCM blob (decrypted server-side only in NextAuth callback, never in JWT) + cached `githubLogin`; memberships |
| `WorkspaceMembership` (L41) | Explicit user<->workspace role row (`role` enum incl. owner/admin/editor/viewer lineage) — `user: User`, `workspace: Workspace` |
| `EncryptedSecret` (L59) | Shared AES blob table referenced by GitProvider (token + refresh), JupyterServer, McpConnection |
| `PersonalAccessToken` (L163) | Hashed PATs for machine/API auth; `user: User` |
| `GitProvider` (L177) | Per-actor git provider connection (github/gitlab/generic), OAuth or PAT, encrypted token + optional refresh secret |

### 8.2 MCP / Jupyter audit (4)

| Model | Purpose & key relations |
|---|---|
| `McpConnection` (L106) | Registered MCP tool connections (name, endpoint, encrypted secret ref) |
| `McpCallAudit` (L132) | Per-call audit trail of MCP tool invocations; optional `connection: McpConnection?` |
| `JupyterServer` (L74) | User-registered kernel gateways (approved origin, encrypted token) |
| `JupyterAuditEvent` (L90) | Redacted operational audit facts for notebook execution paths |

### 8.3 Marketplace / commerce (10)

| Model | Purpose & key relations |
|---|---|
| `MarketplaceProgram` (L204) | Program catalog entry (packageId, visibility, publisher, review status) |
| `ProgramVersion` (L205ff) | Immutable version rows; `program: MarketplaceProgram`; review state machine lives here |
| `ProgramReviewEvent` (L1273) | Review pipeline history; `version: ProgramVersion` |
| `ProgramInstall` (L264) | Per-subject installs; `program`, optional `grant: PermissionGrant?` |
| `PermissionGrant` (L309) | Scope grants (e.g. `program.launch`) attached at install time |
| `ProgramSession` (L285) | Runtime session lifecycle; `install: ProgramInstall?` |
| `ProgramRuntimeEvent` (L323) | Append-only session event log; `session: ProgramSession` |
| `ProgramPricing` (L1293) | Active price rows (paid iff positive price); `program` |
| `Entitlement` (L1308) | Purchase grants keyed by program+subject; `program` |
| `PaymentWebhookEvent` (L1328) | Raw webhook event dedupe/audit |

### 8.4 CodeSite governance (24)

Projects & membership:

| Model | Purpose & key relations |
|---|---|
| `CodeSiteProject` (L344) | Governed repo/project aggregate (zone policy, control plan, substrate refs; 34 fields) |
| `CodeSiteProjectMember` (L388) | Human/agent membership w/ roles; `project` |
| `CodeSiteMutationZone` (L412) | Path-glob mutation zones within a project |
| `CodeSiteAgentSession` (L429) | Attached agent identity/session lifecycle (agent kind, token authority) |
| `CodeSiteAgentChannel` (L1343) | Registered direct channel between two attached agent sessions — control plane authorizes/logs lifecycle, data plane runs directly between agents (per schema doc comment) |

Plans, leases, transactions:

| Model | Purpose & key relations |
|---|---|
| `CodeSiteExecutionPlan` (L493) | Approved plan of intended mutations; `project`, `agentSession` |
| `CodeSiteMutationLease` (L521) | Exclusive lease to mutate zones; `project`, `executionPlan`, `agentSession` |
| `CodeSiteMutationTransaction` (L553) | Transactional write set w/ snapshot evidence + quarantine state; `project`, `mutationLease`, `agentSession` |
| `CodeSiteAssumptionLease` (L588) | Recorded assumptions underlying a plan; `project` |
| `CodeSitePolicyDecision` (L609) | Policy engine verdicts on lease/transaction requests; `project`, optional lease |

Evidence, provenance, review:

| Model | Purpose & key relations |
|---|---|
| `CodeSiteProofBundle` (L630) | Signed proof bundles attesting transactions; `project`, `transaction` |
| `CodeSiteLineProvenance` (L658) | Line-range provenance linking code lines to transactions; `project`, `transaction` |
| `CodeSiteInspectionRun` (L686) | Inspection executions; `project`, optional plan |
| `CodeSiteIncident` (L707) | Incidents incl. mayday/resume flow; `project` |
| `CodeSiteDocument` (L728) | Governance documents (ADRs etc.); `project` |
| `CodeSitePermit` (L749) | Scoped permits granting exceptions; `project` |
| `CodeSiteDocumentReview` (L776) | Review workflow over documents; `project`, `document` |
| `CodeSiteRouteRevision` (L799) | Route revision proposals/reviews/application; `project`, plan, optional document |
| `CodeSiteEvent` (L827) | Logical-time ordered event log w/ cursor support; `project`, optional lease |

Knowledge:

| Model | Purpose & key relations |
|---|---|
| `CodeSiteKnowledgeItem` (L886) | Shared knowledge records (discovery/lead/shared_skill/impact_notice/handoff) with dedupe keys, ownership by agent sessions, self-referencing derivation chain, optional transaction target |
| `CodeSiteKnowledgeReference` (L932) | Typed references out of knowledge items |
| `CodeSiteAgentInboxItem` (L854) | Per-agent delivery inbox for events/documents/knowledge w/ ack state |
| `CodeSiteCounterfactualRun` (L949) | Counterfactual memory runs ("what would have happened") |
| `CodeSitePolicyDelta` (L969) | Regret-driven policy change proposals (promote/reject lifecycle) |

### 8.5 Local Support trust (12)

| Model | Purpose (schema doc comments preserved where present) |
|---|---|
| `LocalSupportRelayRequest` (L993) | Durable relay state; stores only signed request envelope + scrubbed target metadata; response bodies never persisted |
| `LocalSupportRelayPayload` (L1030) | Encrypted approved payload blobs awaiting device pickup; `request` |
| `LocalSupportControlCommand` (L1048) | Durable commands from authenticated browser control surface; desktop consumes via signed outbound device relay; no bearer/control secret stored |
| `LocalSupportControlAudit` (L1076) | Audit trail of command issuance/lease/outcome |
| `LocalSupportCloudAudit` (L1107) | Product/security audit summaries deliberately separate from relay delivery state; no raw body columns; `request` |
| `LocalSupportSecurityEvent` (L1137) | Hashed security-event summaries |
| `LocalSupportPolicyState` (L1159) | Durable global policy doc (org-scoped capable, full-access tier flag) |
| `LocalSupportSession` (L1176) | Paired device sessions (TTL, approved ports, app version) |
| `LocalSupportLinkedProject` (L1207) | Cloud-visible collaboration identity: graph metadata + selection hashes only, never paths/source; `session` |
| `LocalSupportDeviceNonce` (L1231) | Replay-protection nonces per device; `session` |
| `LocalSupportPairingChallenge` (L1244) | Durable pairing challenges (proof-of-possession) |
| `LocalSupportPairingRateLimit` (L1267) | Pairing attempt rate limiting |

### 8.6 Migrations summary

43 SQL migrations under `prisma/migrations/` (+`migration_lock.toml` = postgresql; +
`backfills/backfill-workspace-roles.sql`). Arc of the schema, oldest → newest:

1. **2025-10**: users/test-connection seed (`…10085525_add_basic_user_to_test_connection`),
   workspaces + membership introduction (`…10143741_add_workspaces_support_in_db`), workspace_item
   add-name/add-is_folder then removal (`…12121413_remove_workspace_item_model`),
   misc (`…1211194534_jfasldkf` — scratch-named migration).
2. **2026-05/06**: explicit workspace membership (`…260517000000`), GitHub token metadata
   (`…260526153000`), GitHub PAT storage (`…260610120000`), membership roles (`…260612110000`).
3. **2026-06/07 — CodeSite**: big-bang control plane (`…260629090000_add_codesite_control_plane`, ~21 KB
   DDL), then proof repo state, event logical-time cursor, transaction snapshot evidence, substrate
   identity, line provenance (+ index), project members, proof signatures, governance workflows
   (`…260704120000`), agent attachment identity (two-step completion), agent access token, shared
   knowledge, agent channels (`…260823070000`).
4. **2026-07 — Local Support**: relay control plane (`…260710120000`), paired session, device nonce,
   encrypted payloads, durable pairing, app-version column, security events, policy state (+org scope,
   +full-access policy), approved ports, control commands, control audit, control proposal
   (`…260716234000`), linked projects (`…260821100000`).
5. **2026-07/08 — platform**: `EncryptedSecret` table (`…260722000000_add_encrypted_secret`),
   Jupyter notebook support (`…260723000000`), programs marketplace + integrations big-bang
   (`…260728000000`, ~14 KB DDL).

## 9. scripts (37 files)

Proof harnesses dominate — Playwright-driven visual/behavioral proofs plus pure verification CLIs:

- **CodeSite proofs** (run against live dev servers or artifacts):
  `codesite-full-workflow-proof.mjs` (~216 KB — end-to-end governance workflow),
  `codesite-release-gate.mjs` (~75 KB release gate orchestrator),
  `codesite-quarantine-review-proof.mjs` (~55 KB), `codesite-ui-governance-proof.mjs` (~40 KB),
  `codesite-shadow-runner.mjs` (~47 KB, Workstream E cap on validation commands per git-patch plan),
  `codesite-run-mature-proof-suite.mjs` (suite runner w/ lazy playwright so `--no-screenshot` needs no install),
  plus `codesite-counterfactual-memory-proof.mjs`, `codesite-emergency-broadcasts-proof.mjs`,
  `codesite-filesystem-boundary-proof.mjs`, `codesite-line-inspector-proof.mjs` (line-provenance UI proof),
  `codesite-metrics-proof.mjs`, `codesite-mutation-surface-coverage-proof.mjs`,
  `codesite-pilot-license-proof.mjs`, `codesite-radar-adapter-proof.mjs` (external radar adapter),
  `codesite-release-gate-suite-freshness-proof.mjs`, `codesite-repo-local-autosync-proof.mjs`,
  `codesite-repo-policy-compiler-proof.mjs`, `codesite-runtime-mount-boundary-proof.mjs`,
  `codesite-runtime-quarantine-proof.mjs`, `codesite-runway-occupancy-proof.mjs`,
  `codesite-shadow-simulator-proof.mjs`, `codesite-unmanaged-host-boundary-proof.mjs`.
- **Verification CLIs**: `codesite-proof-verify.mjs` (verifies signed bundles; relative paths resolve
  against repo root honoring an explicit base dir), `codesite-proof-api.mjs`.
- **Channel relay**: `codesite-channel-relay.cjs` — registered direct channel relay transport (Phase 2).
- **Dojo/shadow visual proofs**: `dojo-visual-proof.mjs` (~45 KB; screenshot + missing-text gates),
  `dojo-ghost-mode-visual-proof.mjs`, `shadow-card-visual-proof.mjs`, `dojo-visual-proof-utils.mjs`.
- **NEP rigs**: `live-test-nep.mjs` (live harness), `nep-replay.mjs` (offline replay, Phase 3) consuming
  `nep-replay-fixture.jsonl`.
- **Build/polyfill**: `build-node-polyfills.js` (bundles Node polyfills into one file),
  `polyfill-entry.js` (polyfill entry for the extension host worker), `prepare-standalone.js`,
  `build-test-vsix.js` (minimal .vsix for install-flow tests), `test-ai-primitives.mjs`.

## 10. External endpoints touched by lib + services

Consolidated from literal URL/env analysis of every in-scope module (server-side defaults included):

| Destination | Resolved from | Used by |
|---|---|---|
| Collab server HTTP (files/git/sessions/spawner/ports/programs runtime) | `NEXT_PUBLIC_COLLAB_SERVER_URL` / `COLLAB_SERVER_URL` / `SYNTHI_COLLAB_SERVER_URL`, default `http://localhost:1234` | collab-url, collabSessionService (`/session/*`, `/user/*`), compilerClient (`/api/spawner/ensure|touch`), gitClient, programSessionClient, runtimeClient (lib/programs), activityBridgeReadiness, sseClient |
| Collab server WS (CRDT sync) | same env, ws scheme; fallback `ws://localhost:1234` | collabClient -> collab-crdt.worker, MonacoSocketAdapter path |
| Compile signaling WS | `NEXT_PUBLIC_COMPILE_SIGNAL_URL`, else `<origin>/signal`, else `ws://localhost:9000` | compilerClient, operatorClient |
| TURN credentials | `/api/turn-credentials` (same-origin Next route) | compilerClient |
| AI engine / code-intel | `CODE_INTEL_URL` || `AI_ENGINE_URL`, default `http://localhost:8000`; auth header `x-synthi-internal-token` via internalAiAuth | proxyAiEngine, programs/aiReviewer, programs/manifestGenerator |
| MCP browser-workflow bridge (Dojo) | bridge URL+token resolution, default `http://127.0.0.1:<port>` | agentWorkflowClient <- dojoClient |
| MCP operator bridge (escape hatch) | default `http://127.0.0.1:9465` | escapeHatchClient |
| Analyzer gateway WS | `NEXT_PUBLIC_GATEWAY_WS_URL` | analyzerGatewayClient |
| GitHub REST / OAuth | `https://api.github.com`, `https://github.com/login/oauth/{authorize,access_token,device/code}` (+ device poll) | lib/git adapters/providerConfig/token, prClient |
| GitLab REST / OAuth | `https://gitlab.com/api/v4`, `https://gitlab.com/oauth/{authorize,token}` (self-hosted via baseUrl override) | lib/git |
| Google Cloud Storage | GCS bucket via `GCS_BUCKET_NAME` + service-account envs | server/gcsStorage, workspaceSearchIndex |
| Jupyter gateways | user-registered origins, allow-listed by `JUPYTER_ALLOWED_ORIGINS`; endpoint whitelist api/status\|contents\|sessions\|kernels | lib/jupyter client/policy/registry |
| Stripe webhooks (inbound) | signed `Stripe-Signature` verification, no SDK | lib/programs/stripeSignature |
| Artifact registry (crane) | `VECTANT_AR_HOST/_PROJECT/_REPO` | lib/programs/reHoster |

SSRF posture: every git-provider outbound call goes through `gitFetch` -> `assertSafeUrl`
(`@synthi/mcp-hub`) — the Slice-1 SSRF guard; Jupyter origins are allow-listed with private-IP gating;
CodeSite webhook delivery is origin-allow-listed + HMAC-signed (`deliverySecurity.js`);
OAuth callbacks validate loopback hosts and nested callback params
(`oauthRelayServer.js:L3-4`, `terminal-preview-links.js`).

## 11. Cross-cutting observations

1. **Two-plane architecture**: browser IDE plane (services/, workers/, extensions/) vs governance/server
   plane (app/api routes delegating to lib stores). The lib layer is effectively the server's business
   logic; route files stay thin.
2. **Governance-first CodeSite**: 24 prisma models + a 13.6k-line control plane + ~20 proof scripts +
   shadow runner exist to make autonomous agent mutations auditable (leases -> transactions -> proof
   bundles -> line provenance -> counterfactual runs -> policy deltas). It is the largest subsystem by far
   (~700 KB of source + ~800 KB tests).
3. **Defense-in-depth patterns repeat**: AES-256-GCM everywhere (`tokenCrypto`, relay payloads,
   `EncryptedSecret`), HMAC-signed one-time tokens (oauth relay, checkout reference), timing-safe compares,
   replay caches/nonces (oauthRelayServer, local-support envelopes, channels), fixed-window rate limits,
   fail-closed gates (programs hardGates/paidGate/policy).
4. **Workerization boundary**: CRDT editing moved off-thread (collab-crdt.worker) while extensions run in
   their own worker with an enforced state machine, isolation queues, and restart fences.
5. **Dead/orphaned code**: `dirty-files.js`, `formatters.js`, `loop-status.js`,
   `local-support/acceptance.js` (catalog-only), `programs/earnings.js`, `jupyter/sync.js`,
   `security/csp.js` (CJS-consumed), `ContainerVFS.js`, `vfs/index.js` barrel — no in-src importers found;
   several look staged for upcoming UI rather than deleted.
6. **Env-var sprawl**: >60 distinct env vars referenced across the area (see per-module notes); collab
   server location alone has four aliases resolved in priority order in multiple modules — a recurring
   drift risk.
7. **Test mirroring**: nearly every lib subdir carries co-located `__tests__` (codesite 24 test files,
   local-support 13, programs 26); codesite's controlPlane test alone is ~380 KB.

---

*Generated by static analysis: regex export/import extraction, alias-resolved import graph over
`synthi/src`, reverse-dep counting, schema parsing. Line refs verified against working tree as of 2026-08-25.*

---

## Related

[[Synthi Frontend]] · [[Area - Synthi App Routes]]

[[00 Home|🏠 Back to Home]]
