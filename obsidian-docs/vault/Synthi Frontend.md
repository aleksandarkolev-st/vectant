---
tags: "frontend", "nextjs"
system: Synthi Frontend
source-repo: vectant-ade
generated: 2026-08-25
---

# Synthi Frontend

> [!info] Provenance
> Deep-dive analysis generated from the live repository tree (`main` @ `ce74771af`, 2026-08-25).
> Raw source: `docs/obsidian-src/frontend-synthi.md` in the repo. All paths below are repo-relative unless noted.

---
title: "Frontend — synthi/ (Next.js 15 IDE)"
product: Vectant Local Support / Vectant ADE ("Synthi")
repo: vectant-ade (npm monorepo)
path: synthi/
tags: [frontend, nextjs, react, ide, analysis]
---

**Frontend Analysis — `synthi/` (Vectant ADE / Synthi)**

> `synthi/` is the Next.js 15 App Router application that **is** the Synthi AI development environment: a cloud IDE (Monaco editor, file tree, terminal, git, notebooks, emulator) wrapped around an AI agent system (chat, sub-agents, shadow runs, healing), a multi-human/multi-agent governance plane (**CodeSite**), an agent training/governance UI (**Dojo**), and a trust-sensitive remote-support surface (**Local Support**). It is the BFF (backend-for-frontend) of the monorepo: it owns Postgres via Prisma, proxies the Python ai-engine (`ai-backend`), talks to the collab-server, and brokers MCP/browser-bridge traffic.

---

## 1. Identity & Stack

| Aspect | Value |
|---|---|
| Package | `synthi` v0.1.0, private, npm-workspaces member of repo root |
| Framework | Next.js **15.5.20**, App Router, React **19.1.0** (`next dev --turbopack`) |
| State | Redux Toolkit 2.9 + react-redux 9 (Immer Map/Set enabled) |
| DB | Prisma 6.17 → **PostgreSQL** |
| Auth | next-auth 4.24 (JWT strategy; Google + GitHub OAuth) |
| Editor | Monaco `0.55.1` + `@monaco-editor/react` + monaco-languageclient 10.4 (LSP over `vscode-ws-jsonrpc`) |
| Collab | Yjs 13.5 + y-websocket (+ dedicated CRDT web worker) |
| UI kit | Radix UI primitives + shadcn-style `components/ui`, Tailwind CSS 4, lucide/react-icons/pi icons, sonner toasts, framer-motion |
| AI SDK | `@google/genai` (Gemini direct calls from route handlers) |
| Other | `@modelcontextprotocol/sdk`, workspace pkg `@synthi/mcp-hub` (transpiled), `@google-cloud/storage`, jszip, marked+dompurify, shiki, xterm (devDeps for terminal UI), vitest |

Naming: layout metadata brands it "**Vectant ADE**" with default canonical URL `https://beta.vectant.dev`; PRODUCT.md positions the flagship flow as **Vectant Local Support**.

## 2. Build & Deployment

- **Build pipeline**: `npm run build` = `scripts/build-node-polyfills.js && next build && scripts/prepare-standalone.js`. Node polyfills are bundled for browser use (buffer, stream, path, os, zlib… — the app ships Node-ish libs into the client).
- **`output: 'standalone'`** with `outputFileTracingRoot` at repo root so the standalone bundle includes hoisted deps and `@synthi/mcp-hub`. ~150 MB image payload.
- **Dockerfile** (3-stage: deps → builder → runner, node:20-alpine, pinned digests) builds from **monorepo-root context** because of the workspace package. `Dockerfile.migrate` is a separate Prisma-CLI image for K8s migration Jobs (standalone output lacks prisma CLI).
- **Turbopack vs webpack dual config** in `next.config.mjs`: both alias `yjs` to a single ESM instance and force a **single Monaco instance** (`monaco-editor$` → `@codingame/monaco-vscode-editor-api`) so monaco-languageclient LSP features work. The `$` exact-match keeps worker sub-path imports on real monaco.
- **Security headers** (all routes): CSP built by `src/lib/security/csp.js` (injects collab server origin from `NEXT_PUBLIC_COLLAB_SERVER_URL`), COEP `credentialless`, COOP `same-origin`, HSTS preload, nosniff, no-referrer, restrictive Permissions-Policy. `/local-support` + `/api/local-support/*` get a **stricter overlay**: `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `no-store`.
- ESLint ignored during builds; tests via vitest (jsdom, `src/**/*.{test,spec}.{js,jsx,mjs}`).

## 3. Route Tree (`src/app`)

### 3.1 Pages

| Route | Purpose |
|---|---|
| `/` | Dashboard / launcher: workspace list, GitHub/local-folder import (bounded upload: ≤240 files, ≤64 MB total, ignores `node_modules/.git/dist/...`), "AI Jumpstart" section |
| `/login` | OAuth sign-in (GitHub primary, Google), custom branded page |
| `/workspace` | Workspace listing/creation |
| `/workspace/[slug]` | **The IDE** (~3,800-line client component). Panels: FileTree/SearchView, dynamic-imported Editor, chat rail, terminal, git panel, ports, emulator preview. Resizable panels or docking WM |
| `/workspace/[slug]/codesite` | CodeSite governance cockpit (see §7) |
| `/workspace/[slug]/dojo/**` | Dojo shell + sub-routes: `case-law`, `debug`, `evidence`, `governance`, `practice`, `skills`, `source`, `therapeutic-trace` |
| `/workspace/[slug]/operator` | Operator console opened as modal dialog over the workspace (URL-synced, Esc returns) |
| `/workspace/docking-demo` | Docking-window-manager demo harness |
| `/workspace/popout` | Pop-out window renderer: child window connects to parent via BroadcastChannel and renders one docked panel |
| `/collab/[sessionId]` | Guest invite landing: token validation → host info → knock → host approval → redirect into workspace |
| `/local-support` | Local Support transparency page (session scope, sent/blocked/redacted history, preview approvals) |
| `/local-support/admin` | Local Support ops console (live policy, devices, sessions, revocation, security alerts) |
| `/auth/loopback` | Loopback auth helper for local flows |
| `/[slug]` | Root catch-all redirector: reserved names guard, forwards `?collab=&token=` invites into `/collab/...`, else `/workspace/<slug>` |
| `/extension-test`, `/dojo-release-seed` | Dev/test harnesses |

### 3.2 API domains (~110 route handlers under `src/app/api`, all `runtime='nodejs'`)

| Domain | Endpoints (representative) | Role |
|---|---|---|
| `chat` | `POST /api/chat` (SSE streaming agent loop), `approve-command` | Core AI chat. Gemini-driven tool loop with tool declarations (`read_file`, `search_workspace`, `list_directory`, `run_command`, `web_search`, `create_file`, `create_directory`, `execute_notebook_cells`), external MCP tools via `buildExternalTools`, skill loading (`agent-routing/selective-skill-loader`). **Human-in-the-loop command approvals**: `run_command` pauses the loop up to 120 s awaiting `POST /api/chat/approve-command` (Maps pinned on `globalThis` to survive HMR); git write commands are deferred until after user reviews FILE blocks |
| `agent` | `POST /api/agent` | Single-step sub-agent executor: per-type tool allowlists, context budget limiting, independent-result validation, pipelines through collab/code-intel/Gemini |
| `auth` | `[...nextauth]`, `token` | NextAuth handler; short-lived gateway tokens |
| `completion` | `POST` | Inline code completion (Gemini flash-lite, 12 s cap, RAG fast-context hints from code-intel, 4.8 KB block budget) |
| `next-edit` | route + `flag`, `telemetry` | NEP multi-block refactor predictions (18 s lifecycle, separate from completion path; NDJSON-ish parse with `parse_error` telemetry) |
| `classify/intent` | `POST` | Proxies intent classification to ai-engine |
| `format` | `POST` | Prettier-based formatting service |
| `theme-generate` | `POST` | NDJSON-streams a full theme palette generated from a natural-language prompt |
| `shadow` | `run`, `verify-only`, `cost`, `[jobId]/apply\|cancel\|stream\|why` | **Synthi Genome shadow runs**: speculative parallel edits executed in ai-engine, cost estimates, diff application, SSE progress, "why" explanations |
| `shadow_continuous` | `state`, `opt_out` | Continuous background shadow verification with user opt-out |
| `counterfactual/[...path]` | all verbs | Authenticated same-origin bridge to ai-engine counterfactual control plane (retention/deletion/telemetry switch owned server-side) |
| `code-intel/[...path]` | all verbs | Proxy to Python code-intel service (index health, provenance-adjacent endpoints) |
| `provenance/[...path]` | GET | Allow-listed proxy (stats / file / record id) for line-level AI provenance records |
| `browser-workflows` | `[...path]` proxy, `state` | Reverse proxy to the per-runtime browser-automation bridge (port 9466 default). Computes **runtime-scoped service names from hashed slug** (`rt-…`) using FNV hash + `SYNTHI_RUNTIME_ID_SECRET`; injects bridge token |
| `turn-credentials` | GET | Short-lived Cloudflare Calls TURN credentials for WebRTC compiler connections (cached until 20 % TTL left) |
| `workspace` | CRUD, `[slug]/item\|members\|program-sessions` | Workspace metadata in Prisma + tarball artifacts in **GCS** (`src/server/gcsStorage.js`) |
| `integrations/connections` | CRUD + test | MCP connection registry backed by `@synthi/mcp-hub` |
| `integrations/tokens` | CRUD | Personal Access Tokens (`PersonalAccessToken` model, PAT auth used by CLI/MCP paths) |
| `integrations/git/providers` + `oauth/[provider]/**` | CRUD, device-flow start/poll, callback | Multi-provider git credentials (GitHub + others), OAuth device flow relayed for local runtimes |
| `integrations/mcp/*` | `resolve`, `audit`, `jupyter`, `programs/*`, `runtime-exec` | PAT-gated MCP surface for external agents: tool resolution with rate limits, audit log, program session launch/stop/restart/detect, and `synthi_exec_in_runtime` — one-shot exec **inside the workspace's Sysbox runtime pod** |
| `github/create-repo` | POST | Creates repo using session's GitHub OAuth/PAT token |
| `user/github-token` | POST | Stores AES-256-GCM-encrypted GitHub PAT (`tokenCrypto.js`), decrypted only inside the NextAuth session callback |
| `oauth-relay` | `session`, `callback` | Relays OAuth sessions to local runtimes without exposing tokens directly |
| `extensions/search` | GET | Extension marketplace search |
| `admin/program-reviews` | GET/POST, `[versionId]` | Platform-admin review queue for marketplace programs (gated by `PLATFORM_ADMIN_EMAILS`) |
| `programs` | list/publish + `seed-defaults` | Marketplace program catalog (gated seeding via `ENABLE_PROGRAM_SEED`) |
| `internal/payments/webhook` | POST | Stripe webhook → `PaymentWebhookEvent`/Entitlement; `internal/programs/process-pending` cron target |
| `local-support/*` | `relay`, `relay/device`, `relay/payload`, `pairing`, `policy`, `request-envelope`, `security-event`, `transparency-action/state`, `preview-gateway`, `linked-projects`, `admin/state`, `test-request` | The Vectant Local Support control plane (see §8). Every handler uses shared guards `httpGuards.js` (same-origin check, bounded JSON body, uniform denial JSON) |

**Cross-cutting API middleware**: `lib/workspaceAccess.js` (membership roles `owner|admin|member`, collab guest access fallback), `lib/internalAiAuth.js` (`withInternalAiAuth` injects `x-synthi-internal-token` from `AI_BACKEND_AUTH_TOKEN`), `lib/proxyAiEngine.js` (authenticated same-origin proxy to FastAPI ai-engine), `resolveActor()` (integrations/session identity resolution).

## 4. Data Model — `prisma/schema.prisma` (56 models, PostgreSQL)

Grouped by subsystem:

- **Core tenancy (6)**: `Workspace` (unique slug, repoUrl), `User` (email unique; `githubTokenCipher` AES-256-GCM blob `<iv>:<authTag>:<cipher>` + cached `githubLogin`), `WorkspaceMembership` (role owner/admin/member, unique per user+workspace), `EncryptedSecret`, `PersonalAccessToken`, `GitProvider`.
- **Jupyter (2)**: `JupyterServer`, `JupyterAuditEvent`.
- **MCP (2)**: `McpConnection` (connection configs), `McpCallAudit` (per-call audit).
- **Marketplace programs (7 + 3 commerce)**: `MarketplaceProgram`, `ProgramVersion`, `ProgramInstall`, `ProgramSession`, `PermissionGrant`, `ProgramRuntimeEvent`, `ProgramReviewEvent`, plus `ProgramPricing`, `Entitlement`, `PaymentWebhookEvent` (Stripe).
- **CodeSite (24 models)** — the governance plane:
  - Projects & people: `CodeSiteProject` (zonePolicyJson, controlPlanJson, `channelMode` mediated_only|registered_direct|direct_preferred|open_local), `CodeSiteProjectMember`
  - Agent execution: `CodeSiteAgentSession`, `CodeSiteExecutionPlan`
  - Mutation safety: `CodeSiteMutationLease`, `CodeSiteMutationTransaction`, `CodeSiteAssumptionLease`, `CodeSiteLineProvenance`
  - Policy: `CodeSitePolicyDecision`, `CodeSitePolicyDelta`, `CodeSitePermit`
  - Evidence & QA: `CodeSiteProofBundle`, `CodeSiteInspectionRun`, `CodeSiteIncident`, `CodeSiteCounterfactualRun`
  - Knowledge: `CodeSiteDocument`, `CodeSiteDocumentReview`, `CodeSiteRouteRevision`, `CodeSiteKnowledgeItem`, `CodeSiteKnowledgeReference`
  - Coordination: `CodeSiteEvent` (append-only causal timeline), `CodeSiteAgentInboxItem`, `CodeSiteAgentChannel` (registered direct channels: requested→active→closed, transport websocket|sse, channelTokenHash, summaryDigest, messageCount)
  - Zones: `CodeSiteMutationZone`
- **Local Support (12)**: `LocalSupportRelayRequest` (deviceFingerprint, actor, capability, targetHash/classification, redactionCount, scannerVersion, policyVersion, deviceProof, envelopeSignature, lease), `LocalSupportRelayPayload`, `LocalSupportControlCommand`, `LocalSupportControlAudit`, `LocalSupportCloudAudit`, `LocalSupportSecurityEvent`, `LocalSupportPolicyState`, `LocalSupportSession`, `LocalSupportLinkedProject`, `LocalSupportDeviceNonce`, `LocalSupportPairingChallenge`, `LocalSupportPairingRateLimit`.

The schema encodes the product thesis: *every consequential agent action is leased, policy-checked, evidenced, and appended to an auditable event timeline*.

## 5. Client State — Redux (`src/redux`, ~5.4k LOC)

Store slices (`store.js`):

| Slice | Size | Notes |
|---|---|---|
| `workspace` | 1,440 ln | File tree, open tabs, active file, `fileContentCache` (Map → serializableCheck disabled for it), fetch/select thunks |
| `git` | 920 ln | Status, staging, branches, PR state |
| `healing` (+selectors) | 986 ln | Self-healing config; persisted with **version-gated migration** (`HEALING_CONFIG_VERSION = 2` discards older payloads) |
| `pr` | 584 ln | Pull-request workflow state |
| `extension` | 386 ln | Installed/enabled extensions |
| `layout` | lives in `components/docking-wm/state/layout-slice.js` (585 ln) | Docking WM tree layout |
| `ui` | 225 ln | Terminal visibility, tree side, autosave, GPU mode/target, expanded folders, emulator flags |
| `theme` | 228 ln | Active theme id, user themes, overrides |
| `compileManifest`, `ports` | 153 ln | Compile manifests, container/runtime ports |

Persistence is a hand-rolled `store.subscribe` writer to localStorage (`synthi:ui`, `synthi:expandedFolders`, `synthi:theme`, `synthi:healing`, per-slug `synthi:openTabs:<slug>` / `synthi:activeTab:<slug>`), optimized with shallow-string snapshots and reference-equality checks instead of per-keystroke JSON.stringify. Emulator preview flag deliberately never persists (must stay closed on refresh).

## 6. Services, Workers, Extensions

### `src/services` (~35 modules)
- **Editor/LSP plumbing**: `lspRegistry.js`, `MonacoSocketAdapter.js`, `monacoDiagnosticsAdapter.js`, language servers over websocket JSON-RPC.
- **Collab**: `collabClient.js` (Y.Doc per file `workspace:{slug}:{path}`, inline safe Monaco↔Y.Text binding, awareness presence), `collabSessionService.js` (hosted sessions, guest knocks), `crdtWorkerBridge.js` + `src/workers/collab-crdt.worker.js` — **all Yjs encoding/decoding and y-websocket parsing run off the main thread**; main thread never touches Y.Doc directly.
- **ContainerVFS.js** — the "gold standard" dataflow contract: *server container is source of truth; Y.js syncs keystrokes; client cache is display-only; analysis requests send paths, never content*; compiler/AI/git all read the same disk.
- **AI/analysis**: `agentWorkflowClient.js`, `analyzerGatewayClient.js`, `compilerClient.js`, `preCompileHealer.js`, `aiFixHistory.js`, `runtimeErrorInterceptor.js`, `escapeHatchClient.js` (operator console), `dojoClient.js`, `prClient.js`, `programSessionClient.js`, `sseClient.js`, `operatorClient.js`.
- **Infra**: `fileCache.js` (LRU), `loadScheduler.js`, `perfMarkers.js`, `runtimeScope.js`, `userIdentity.js`, `vscodeTunnelService.js`, `vfs/` (client VFS provider).

### `src/extensions` — VS Code-style extension system
Hard invariants (ARCHITECTURE.md): one Monaco instance, **one extension-host Web Worker**, zero extension JS on the main thread, no DOM access for extensions, webviews only as CSP-isolated iframes. Layout: `host/` (worker entry, activation manager, registry, contexts), `api/` (commands, window, workspace, scm, tasks, debug, terminal, languages, authentication, uri, env), `loader/`, `bridge/`, `scheduler/`, `services/`, `perf/`, `webview/WebviewManager.js`.

### Hooks (`src/hooks`, 38)
Heavy AI/healing integration: `useSelfHealing`, `useRuntimeHealing`, `useBatchHealing`, `useAIAutoAnalysis`, `useAISelectionAnalysis`, `useHotSwap`, `useHMR`, `useCompiler`, `useRetryCompile`, `useSSE`, `useProactiveAnalysis`, `useWorkspaceAnalysis`, `useVirtualizedTree`, `usePresence`/`useWorkspacePresence`, `usePreviewLifecycle`, dock keyboard shortcuts, etc.

## 7. Component Groups (`src/components`)

- **`docking-wm/`** — a full custom docking window manager: `DockableWorkspace.jsx` drop-in replacement for the rigid ResizablePanelGroup; panel registry + core, layout presets ("classic"), keyboard navigation + focus indicators, localStorage persistence, pop-outs via BroadcastChannel child windows (`/workspace/popout`). Its own Redux slice, styles, types, extensive tests (`test:dock` script).
- **`codesite/`** — CodeSite cockpit: `CodeSitePanel.jsx` + `views/` (Overview, Activity, Evidence, Governance, Graph, Inspections, Locks, Quarantine, Replay, Simulator) with nav (CommandStrip, DesktopSectionRail, MobileSectionTabs), a restrained operator-pane UI kit (`ui/`: Pill, Row, SignalBar, StatusRailItem, JsonPreview…), and `codesiteClient.js` which enumerates the **air-traffic-control event vocabulary** (`tower_instruction`, `holding_pattern`, `ground_stop`, `mayday`, `near_miss`, `clearance_requested/issued`, `write_allowed/denied/quarantined`, `transaction_opened/validated/committed/aborted`, …).
- **`dojo/`** (36 components) — agent training/governance surfaces: `DojoShell`, `SkillCortexGraph`, `SkillPassport`, `SkillRegistryTable`, `EvidenceLedgerChain`, `GovernanceDashboard`, `PolicyGateTable`, `CaseLawDashboard/Registry`, `ApprovalQueue`, `GhostModePanel`, `HumanVsAgentActionDiff`, `TimeMachineDebugger`, `TherapeuticTomographyTrace`, `SubstrateLadderView`, proof/capsule drawers, redacted evidence export.
- **`chat/`** — chat rail + cards: `AIChatWindow`, `ChatRail`, `CommandApprovalCard` (human-in-the-loop), `ReasoningCard`, `MultiverseCard` + `CounterfactualControls/Inspection` (Genome multiverse UX), `ShadowCostPanel`, `RegressionFindingsCard`, `ArbiterCard`, `DiagnosticsDrawer`, `VectantOrb`.
- **`healing/`** (28) — self-healing UX: `AIFixCard`, `AIConfidenceGate`, `AIDiffPreview`, `AIInlineWidget`, hover/code-action providers, decorations, stats dashboards, suppressed-rules panel, Failure Distiller panel, preset selector, toasts.
- **`local-support/`** — `LocalSupportTransparency` (public trust page) + `LocalSupportAdmin` (ops).
- Others: `git/` (history graph, hunk staging, interactive rebase, merge-conflict editor, PR detail/forms), `collaboration/` (presence list, share modal, versions, missed-events tray), `programs/` (marketplace library/my-apps/session panel), `notebook/`, `emulator/` (mobile preview frame), `analysis/` (problems, provenance overlay), `ports/`, `integrations/`, `agent-workflows/`, `compile/`, `dashboard/`, `extensions/`, shadcn-style `ui/`, plus top-level chrome (ThemeCreator/Picker/Provider, NewProjectPicker, SettingsPanelContent, EditorTabStrip, ErrorOverlay, StoreHydrator…).

Totals: ~350 JSX + ~680 JS files under `src/`.

## 8. Local Support — the trust-critical surface

PRODUCT.md defines the register: read-only, session-scoped, workspace-scoped bridging between a **local dev machine** and a Vectant support session; "show proof, not reassurance"; fail closed; stop controls always visible; no security theatre.

Implementation mirrors that in `synthi/src/lib/local-support/` (each module unit-tested): `controlPlane.js` (request-envelope signing/verification, replay protection, forward decisions), `relayPayloadCrypto.js`, stores for relay/requests/sessions/policy/security-events/transparency/admin/pairing/linked projects, `deviceAuth.js` (device nonce + pairing challenge + rate limit). API handlers uniformly enforce same-origin, bounded bodies, and return explicit denial reasons (`bad_origin`, …). The stricter CSP/XFO/no-store header overlay (§2) applies exactly to this surface. UI exposes sent-vs-available distinction, blocked items, redaction counts, and pause/disconnect.

## 9. Cross-system context (from repo docs)

- **`AI_SYSTEM_ARCHITECTURE.md`**: tiered code intelligence blueprint — Tier 0 authoritative workspace FS; Tier 1 always-on metadata manifest; Tier 2 BM25 lexical; Tier 3 vector embeddings; Tier 4 blob store; Tier 5 summaries/import graphs. Client fetches manifest only at load, bounded LRU content cache, prefetch of imports/hot files; browser cache never feeds AI. synthi's completion/provenance proxies + code-intel service implement the retrieval side.
- **`COLLABORATION.md`**: y-websocket collab-server (port 1234, LevelDB persistence at `backend/collab-server/data/collab-leveldb`); synthi integrates via `collabClient` with presence (file-tree badges, header avatars, remote cursors, per-line glyph badges); production notes demand authenticated WS upgrades.
- **`REGISTERED_DIRECT_CHANNELS_DESIGN.md`** (proposal): governed direct agent↔agent channels — control plane authorizes/logs, data plane runs WebSocket/SSE directly between agents; reuses `csa_` scoped tokens; fail closed. This is implemented as `CodeSiteAgentChannel` + channel events in codesiteClient (`channelMode` on projects), with `SYNTHI_CODESITE_*` env knobs (`CHANNELS_DISABLED`, `MIN_CHANNEL_MODE`, `DELIVERY_ALLOWED_ORIGINS`).

## 10. Environment variables consumed

From `.env.example` + code scan:

- **Auth**: `NEXTAUTH_SECRET`/`AUTH_SECRET`, `GATEWAY_JWT_SECRET`, `NEXTAUTH_URL`, `GITHUB_ID/SECRET` (+`GITHUB_ISSUER`), `GOOGLE_CLIENT_ID/SECRET`, dev-only bypass `NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS`.
- **DB/storage**: `DATABASE_URL`, `POSTGRES_HOST_PORT`, GCS service account `GCP_CLIENT_EMAIL`/`GCP_PRIVATE_KEY`.
- **AI**: `AI_BACKEND_AUTH_TOKEN` (internal token to ai-engine), `GOOGLE_AI_API_KEY`/`GEMINI_API_KEY`/`OPENAI_API_KEY`, `GEMINI_API_BASE`, `GEMINI_MODEL`/`SYNTHI_AI_MODEL` (default `gemini-3.1-flash-lite`), `CODE_INTEL_URL`/`AI_ENGINE_URL` (default localhost:8000).
- **Collab**: `COLLAB_SERVER_URL`/`SYNTHI_COLLAB_SERVER_URL`/`NEXT_PUBLIC_COLLAB_SERVER_URL`/`COLLAB_URL` (4-name fallback chain everywhere), `COLLAB_INTERNAL_TOKEN`, `NEXT_PUBLIC_GATEWAY_WS_URL`, WebRTC `NEXT_PUBLIC_ICE_SERVERS`, `CLOUDFLARE_TURN_TOKEN_ID/API_TOKEN`, `TURN_CREDENTIAL_TTL`.
- **Browser workflows**: `SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL/_TARGET_TEMPLATE/_PORT(9466)/_TOKEN`, `SYNTHI_HOSTED_BROWSER_CDP_PORT(9222)`, `SYNTHI_PREVIEW_DISCOVERY_PORTS`, `SYNTHI_PREVIEW_SCAN_PORTS`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY`, `SYNTHI_AUTH_CHECKPOINT_STORE_KEY`.
- **CodeSite/shadow**: `SYNTHI_CODESITE_AGENT_OVERLAY_ROOT`, `_CONTROL_PLANE_URL`, `_FINALIZER_COMMAND`, `SYNTHI_CODESITE_TOKEN`, `SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON/_ALLOWED_ROOT/_ALLOW_INLINE_COMMANDS`, `SYNTHI_CODESITE_MIN_CHANNEL_MODE/_CHANNELS_DISABLED/_DELIVERY_ALLOWED_ORIGINS`, `SYNTHI_CODESITE_API_BASE_URL`, artifact-history byte caps.
- **Runtime identity**: `SYNTHI_RUNTIME_ID_SECRET` (stable HMAC for `rt-…` pod/service names; rotation changes preview routes).
- **Local Support**: `VECTANT_LOCAL_SUPPORT_ENABLED`, `_LOCAL_API_URL`, `_LOCAL_BEARER`, `_ADMIN_TOKEN`, `_LOCAL_CONTROL_SECRET`, `_ENVELOPE_SECRET`, `_DEVICE_PROOF_SECRET`, `_TRANSPARENCY_STATE_JSON`, `_ORG_ID`, `_ACCOUNT_ID`.
- **Commerce/admin**: `STRIPE_WEBHOOK_SECRET`, `PLATFORM_ADMIN_EMAILS`, `ENABLE_PROGRAM_SEED`.

## 11. Observations & Risks

1. **God-component drift**: `/workspace/[slug]/page.jsx` is ~3,800 lines and the chat route ~2,200 lines; both accrete features (the docking WM exists precisely to replace part of it but isn't yet the default path).
2. **Module-level mutable state in route handlers**: pending command approvals live on `globalThis` Maps — correct under HMR but wrong under multi-instance deployment (approvals would not be shared across pods); needs Redis/DB backing for horizontal scale.
3. **Secrets adjacency**: the NextAuth session callback decrypts the GitHub PAT into the session object on every session resolution; encrypted at rest and never JWT-persisted, but any consumer of `session.accessToken`/`session.githubToken` widens exposure. PAT storage self-heals (clears ciphertext on decrypt failure).
4. **Single-Monaco / single-Yjs aliasing is fragile-but-documented**; the `$`-suffix trick and turbopack mirror must be kept in sync when upgrading either lib.
5. **Env var sprawl**: 60+ vars, four aliases for the collab URL alone; a typed config module would reduce misconfiguration risk (some fallbacks already guard against bogus localhost in prod CSP).
6. **Strong test culture in spots**: local-support, integrations, codesite lib, docking-wm, chat/agent routes have co-located tests + an elaborate `codesite:*proof:*` script suite (visual proofs, boundary proofs, release gate), but coverage is uneven across legacy components.

---

## Related notes

[[Collab Server]] · [[AI Engine]] · [[Architecture Overview]]

[[00 Home|🏠 Back to Home]]
