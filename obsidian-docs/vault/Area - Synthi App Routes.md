---
tags: "frontend", "routes", "api"
type: exhaustive-area-reference
source-repo: vectant-ade
generated: 2026-08-25
---

# Area - Synthi App Routes

> [!info] Exhaustive reference — every module/route/file in this area, with `path:LNN` citations. Raw source: `docs/obsidian-src/area-synthi-app.md`.

---
area: synthi/src/app
kind: per-route analysis
scope: every Next.js App Router page route + all 110 API route handlers
verified: line numbers read directly from source
---

**Area: synthi/src/app — Pages & API Handlers**

Per-route analysis of `synthi/src/app` (Next.js App Router frontend + BFF layer of Synthi/Vectant ADE).
Refs are `path:L<line>`. All line numbers verified against source on disk.

## Inventory (verified by filesystem walk)

- **110 API `route.js` handlers** across 25 top-level domains (`api/admin`, `api/agent`, `api/auth`,
  `api/browser-workflows`, `api/chat`, `api/classify`, `api/code-intel`, `api/completion`,
  `api/counterfactual`, `api/extensions`, `api/format`, `api/github`, `api/integrations`,
  `api/internal`, `api/local-support`, `api/next-edit`, `api/oauth-relay`, `api/programs`,
  `api/provenance`, `api/shadow`, `api/shadow_continuous`, `api/theme-generate`,
  `api/turn-credentials`, `api/user`, `api/workspace`). 22 of them ship colocated `__tests__`/`route.test.js`.
- **26 page/layout files** (see §Page Routes).
- The `app` directory contains **zero direct Prisma calls in most domains**; DB access concentrates in
  `workspace`, `user`, `integrations`, `admin`, and `internal`. Heavy lifting is delegated to three
  backing services: **collab-server** (files/git/runtime/Yjs sessions), **ai-engine** (a.k.a.
  code-intel backend: RAG, classify, shadow runs, counterfactual, provenance), and **Gemini/Anthropic/OpenAI**
  (LLM calls made server-side). No `app/api` handler talks to y-sweet directly — realtime CRDT plumbing
  lives entirely behind collab-server.

## Cross-Cutting Auth & Infrastructure

### Session model — synthi/src/app/auth.js:L6
`authOptions`: NextAuth **JWT strategy** (`auth.js:L8`) with Google (`auth.js:L12`) + GitHub
(`auth.js:L16`, scope `read:user user:email repo` at `auth.js:L22`) providers. Custom callbacks:
- `jwt` persists `token.userId`, avatar, and GitHub `access_token` (`auth.js:L29-L44`).
- `session` **self-heals the User row** with `prisma.user.upsert` on every session resolution
  (`auth.js:L69-L74` — without this a wiped DB would 401 every DB-backed route despite a valid JWT),
  then decrypts the stored personal GitHub PAT into `session.githubToken` (`source:'pat'`),
  clearing stale ciphertext on decrypt failure (`auth.js:L75-L91`).
- Sign-in page override: `/login` (`auth.js:L103`).

Three authorization helpers dominate the API surface:

1. **`resolveActor()`** — synthi/src/lib/integrations/session.js:L6. Session → `{ userId (DB cuid),
   email, workspaceUserId }`; `null` unless both session and User row exist (`session.js:L10-L11`).
   `workspaceUserId` mirrors the IDE's repo-dir naming (`session.user.id || email`, `session.js:L15`).
2. **`requireWorkspaceAccess(slug)` / `requireWorkspaceManageAccess*` / `requireRuntimeWorkspaceAccess`** —
   synthi/src/lib/workspaceAccess.js:L88. Membership lookup via `prisma.workspace.findFirst`
   (`workspaceAccess.js:L38-L61`); roles `owner|admin` = manage (`WORKSPACE_MANAGE_ROLES`,
   `workspaceAccess.js:L6`). Non-members fall through to **live collab-server guest checks**
   (`collabGuestAccess`, `workspaceAccess.js:L107-L112`) so a kicked guest loses access instantly.
3. **PAT auth** — `authenticatePat(req)` (lib/integrations/patAuth) backs the whole `integrations/mcp/*`
   CLI/tool surface; tokens hashed via `generatePat()` (lib/integrations/pat), revoked-not-deleted.

Internal service hops add `x-synthi-internal-token` from `AI_BACKEND_AUTH_TOKEN`/`AI_ENGINE_AUTH_TOKEN`
via `withInternalAiAuth()` — synthi/src/lib/internalAiAuth.js:L1-L8 (header absent when unconfigured).

`proxyAiEngineRequest(request, targetPath, {transformJson})` — synthi/src/lib/proxyAiEngine.js:L11 —
is the generic ai-engine bridge (base `CODE_INTEL_URL` || `AI_ENGINE_URL` || `localhost:8000`,
`proxyAiEngine.js:L3-L7`); forwards method/body/search, injects internal auth, supports JSON
response transforms (`proxyAiEngine.js:L39-L58`).

Rate limiting: `checkLimit(key, RATE_LIMITS.*)` (lib/integrations/rateLimit) guards `integrations/*`
(`crud`, `test`, `git`, `extcall`, `resolve`, `audit`, `telemetry` buckets).

Env aliases seen repeatedly: `COLLAB_SERVER_URL` (default `http://localhost:1234`),
`CODE_INTEL_URL`||`AI_ENGINE_URL` (default `http://localhost:8000`), `AUTH_SECRET`||`NEXTAUTH_SECRET`.

---

## Page Routes

### `/` — Dashboard launcher — synthi/src/app/page.jsx:L263
Client component ("use client", `page.jsx:L1`), 1400 lines. Purpose: workspace launcher — list recent
workspaces, create/import/upload/publish repos. Data flow: `useSession` gate → `fetch("/api/workspace")`
create (`page.jsx:L326`) → collab-server git ops resolved via `resolveCollabHttpUrl()`: clone
(`page.jsx:L440,L590`), init (`page.jsx:L486`), batch-upload of a dragged local folder through
`/git/{slug}/write-files-batch` (`page.jsx:L506`, caps at 240 files/64 MB total/24 MB per file,
`page.jsx:L39-L41`, ignoring `.git/node_modules/.next/dist/build/out/.cache/.turbo`,
`page.jsx:L42-L51`) → optional `POST /api/github/create-repo` first (`page.jsx:L568`).
Components/hooks: framer-motion, react-icons/pi, `AIJumpstartSection`
(stashes an AI jumpstart payload into sessionStorage via lib/ai-jumpstart-session, consumed by the IDE page), sonner toasts.

### `/login` — synthi/src/app/login/page.jsx:L51
Client login page. GitHub (primary) + Google buttons (`login/page.jsx:L22-L35`) → `signIn(provider,
{callbackUrl})`. Sanitizes `callbackUrl` to same-origin-relative paths only
(`login/page.jsx:L56-L60`). Marketing panel asserts the security posture (OAuth claims, token
isolation, membership gating, session-bound runtime).

### `/[slug]` — Root redirect shim — synthi/src/app/[slug]/page.jsx:L12
Server component. Reserved paths bounce to `/` (`[slug]/page.jsx:L3-L9,L17`);
`/{slug}?collab=<id>&token=...` forwards to `/collab/<id>?token=...` (`L21-L28`);
otherwise redirects to `/workspace/<slug>` (`L30`).

### `/collab/[sessionId]` — Guest invite landing — synthi/src/app/collab/[sessionId]/page.jsx:L20
Client. Flow documented at `L9-L18`: validate invite `token` via `collabSessionService.validateToken`
(`L52`) → show host card → guest enters name → `knock()` (`L121`) → waits on socket events
`session:joined`/`knock:denied` (`L68-L97`). On admission persists
`synthi-pending-guest-session` into sessionStorage and hard-navigates to `/{hostSlug}` (`L78-L92`).
Unauthenticated users can join as ephemeral guests (`guest-{ts}-{rand}`, `L117`) or log in;
the login round-trip auto-resumes the knock via `?join=1` (`L135-L139,L141-L146`).

### `/workspace` — Command deck (static) — synthi/src/app/workspace/page.js:L42
Server component, no data fetching: quick-action links back to `/`, decorative orchestration panel.
Effectively a marketing/landing shell for the workspace area.

### `/workspace/[slug]` — THE IDE — synthi/src/app/workspace/[slug]/page.jsx:L377
The core product surface: 181 KB / 3767 lines, client component `EditorPage`. Key wiring:
- Auth guard redirects unauthenticated users home (`page.jsx:L395`); identity cached to localStorage
  for `getCurrentUser()` (`L403`).
- Bootstraps the runtime: `POST {collab}/program-runtime/{slug}/ensure-runtime` (`L432`) and loads
  workspace metadata `GET /api/workspace/{slug}` (`L778`).
- State: Redux (`workspaceSlice`, `gitSlice`, `portsSlice`, `healingSlice`) via typed hooks; files
  loaded with `fetchFilesThunk`/`selectFileThunk`; git status via `fetchGitStatus`.
- Realtime: `collabClient` (Yjs/WebSocket to collab-server), `collabSessionService` (host/guest),
  generic `useSSE` event stream from the backend (`L1393`), `useCollabNotifications`, guest banner.
- AI/healing stack: `useSelfHealing`, `useAIHealing(+Keyboard)`, `useAIAutoAnalysis`,
  `useAISelectionAnalysis`, `useHealingUndo`, `usePendingFixCodeActions`, `useSmartRuleSuggestions`,
  pre-compile healing before compiler handoff (`L2886`), `useCompiler`, `useCodeIntelIndex`,
  `useRetryCompile`, `useRuntimeHealing`, HMR/GPU-mode hooks (`L76`).
- Shell: new docking window manager (`DockableWorkspace`, `IDE_PANEL` registry, activity-bar docking,
  split/tab actions `L113`), legacy `DockablePanel` fallback, TopNav/ActivityBar/StatusBar,
  FileTreeView, SearchView, ProblemsPanel, GitStatus/GitSummaryPanel/PullRequestsPanel,
  Extensions sidebar+views, ProgramsPanel, CodeSitePanel, SettingsPanelContent, floating emulator
  window (`L3314`), ErrorOverlay, responsive viewport hooks.
- Data flow: everything funnels through `/api/workspace/*`, `/api/chat`, `/api/completion`,
  `/api/next-edit`, collab-server HTTP/WebSocket, and SSE pushes; jumpstart payload consumed on mount (`L1103`).

### `/workspace/[slug]/operator` — Operator console modal — synthi/src/app/workspace/[slug]/operator/page.jsx:L12
Client; renders `OperatorDialog` keyed by `slug` (= sessionId) and navigates back to the workspace on dismiss (`L17-L21`).

### `/workspace/[slug]/codesite` — synthi/src/app/workspace/[slug]/codesite/page.jsx:L5
Server component (`force-dynamic`), wraps `<CodeSitePanel workspaceSlug>` full-screen.

### Dojo pages — thin server wrappers passing `workspaceSlug` (+`skillId`) into `@/components/dojo/*`:
`dojo/page.jsx` → `DojoShell` (`L3`); `case-law` → CaseLawDashboard; `debug/time-machine` →
TimeMachineDebugger; `evidence` → EvidenceDashboard; `governance` → GovernanceDashboard;
`practice` → PracticeWorldDashboard; `skills` → SkillCardGrid;
`skills/[skillId]/cortex` → SkillCortexGraph; `skills/[skillId]/passport` → SkillPassport;
`source` → SourceApiDashboard; `therapeutic-trace` → TherapeuticTomographyTrace. No data fetching in the pages themselves.

### `/workspace/docking-demo` — synthi/src/app/workspace/docking-demo/page.jsx:L101
Browser-only docking-WM playground: registers 10 mock panels (`L35-L46`), preset picker + debug
overlay; mounts client-side only to dodge SSG window access (`L102-L107`).

### `/workspace/popout` — Pop-out window host — synthi/src/app/workspace/popout/page.jsx:L23
Child window for detached panels: reads `tabId/panelType/windowId` params, announces readiness and
close over `BroadcastChannel('synthi-docking-popout')` (`L36-L66`), renders `PopoutWindowContent` under the Redux store.

### `/auth/loopback` — OAuth loopback capture — synthi/src/app/auth/loopback/page.jsx (51 KB)
Client wizard for capturing OAuth redirect URLs from desktop/extension flows: accepts only loopback
hosts (`L8`), recognizes callback-ish params (`L9`), integrates with the Vectant/Synthi OAuth-relay
browser extension (`L10-L15`, install URL env-overridable), reads persisted loopback auth requests
(lib/terminal-preview-links). Used to complete OAuth for runtimes that cannot open a browser themselves.

### `/local-support` — synthi/src/app/local-support/page.jsx:L8 → `<LocalSupportTransparency/>`
(user-facing transparency console); `/local-support/admin` — `local-support/admin/page.jsx:L8` →
`<LocalSupportAdmin/>` (ops console). Both static wrappers.

### Misc
- `/extension-test` — `extension-test/page.jsx:L5`: `ExtensionDebugPanel` + manual checklist for the
  web-worker extension host (activation ≤1 s, typing latency <10 ms, 64 MB/ext).
- `/dojo-release-seed` — `dojo-release-seed/page.jsx:L5`: static inline-styled fixture button
  (`data-source-id="dojo.release.seed.action"`) used as a Dojo release-gate target.


## API Domains

### admin
- **`GET /api/admin/program-reviews`** — synthi/src/app/api/admin/program-reviews/route.js:L9.
  Platform-admin only (`resolveActor` + `isPlatformAdmin`, 401/403 at L11-L12). Returns the
  pending_review community-app queue via lib/programs/store. Prisma: indirect (programs store).
- **`POST /api/admin/program-reviews/[versionId]`** — [versionId]/route.js:L9. Body
  `{action:'approve'|'reject', notes?}`; delegates to `approveSubmission`/`rejectSubmission`
  (lib/programs/reviewOrchestrator). Errors mapped: `self_review_forbidden`→403 (L28),
  `not_found`→404 (L29), other review-state errors→409 (L30).

### agent
- **`POST /api/agent`** — synthi/src/app/api/agent/route.js:L480. Executes ONE sub-agent step
  (reader/searcher/analyzer/planner/executor) server-side. Auth: NextAuth session (L41-L52, 401);
  workspace authorized through `requireRuntimeWorkspaceAccess` (L55-L69, L554).
  Routing is server-authoritative: client `selectedTools`/`selectedSkills` can only *narrow* the
  freshly routed IDs from `routePipelineAgentTask` (`L521-L552`) — never broaden. Tool executors:
  `read_file` fetches `{collab}/file-content/{slug}/{path}` truncated to 12 k chars
  (L146-L157, L186); `list_directory` via `{collab}/git/{slug}/files-meta` filtered to 50 entries,
  node_modules/.git excluded (L159-L201); `grep_search` → ai-engine `POST /code-intel/context`
  5 s timeout (L207-L231); `get_diagnostics` → `POST /analyze/static` (L237-L260).
  Optional independent validator pass (`validateIndependentAgentResult`) rejects with 422, or 503
  when the validator itself is unavailable (`L587-L594`). Failure: unknown type 400 (L513),
  bad body 400, tool failures degrade into output text; catch-all 500 (L597-L603).

### auth
- **`GET|POST /api/auth/[...nextauth]`** — [...nextauth]/route.js:L4-L5: bare NextAuth handler with `authOptions`.
- **`GET /api/auth/token`** — token/route.js:L64. Mints short-lived signed JWTs for gateways.
  Auth: NextAuth JWT cookie via `getToken` (L70-L71, 401). With `workspaceSlug`: verifies runtime
  access, normalizes scopes (default `collab:terminal`, L20-L27), validates optional agent binding
  triple `{codeSiteProjectId, agentProvider, providerSessionRef}` (L29-L46; requires terminal scope +
  collabSessionId else 400, L89-L93), then signs a 5-min `typ:'collab-gateway'` audience
  `synthi-gateway` token carrying `runtimeScope` + `filesystemUserId` derived by FNV-hashed
  scoping (`runtimeIdentityFor` L48-L62) and returns it (L95-L119). Without workspace: 15-min
  generic gateway token (L122-L127). Failures: missing AUTH_SECRET 500 (L66-L69), access denial passthrough.

### browser-workflows
- **`GET|POST /api/browser-workflows/[...path]` (+OPTIONS)** — [...path]/route.js:L732/L743/L754.
  Proxies the local **browser-workflow bridge** (Playwright-ish automation daemon on
  `http://127.0.0.1:9466` default, `L7`; per-runtime URL from HMAC-derived
  `workflowBridgeBaseUrl` L194-L208 or env override). Auth: session + `requireRuntimeWorkspaceAccess`;
  runtime context parsed/validated (`parseRuntimeContext` L100, `expectedRuntimeContext` L112,
  `authorizeRuntimeContext` L138). If the bridge isn't running, lazily asks collab-server's spawner
  (`{collab}/api/spawner/ensure`, `ensureRuntimeBridge` L395-L434) before forwarding
  (`forwardToBridge` L436-L477). Failure modes are deliberately soft for the workflow panel:
  structured error states rendered in-panel (`workflowPanelErrorState` L276, `statefulWorkflowErrorResponse` L315)
  rather than raw status codes. CORS handled in OPTIONS (L754).
- **`GET /api/browser-workflows/state`** — state/route.js:L9-L13: thin alias re-exporting the
  catch-all proxy pinned to path `['state']`.

### chat
- **`POST /api/chat`** — synthi/src/app/api/chat/route.js:L1871. The flagship streaming chat route
  (2160 lines). Auth: session → userId (L1874-L1880, 401); workspace authorized & userId rebound
  via `requireRuntimeWorkspaceAccess` (L1916-L1926, 403). Body carries prompt/code/files/
  attachments/model/apiKey/provider/workspacePath/runtimeScope/filesystemUserId/codeSiteContext/
  maxContextTokens/conversationHistory/fullRepoContext/useTools ('auto'|true|false') (L1890-L1912).
  TTFT optimization runs code-intel RAG (`fetchCodeIntelContext` → `POST {ai}/code-intel/context`,
  L471-L511) and file hydration from collab (`hydrateFromCollab` via `{collab}/file-content/...` and
  `/git/{slug}/files-meta`, L731-L755) **in parallel** (L1929-L1957); RAG-sourced files are then
  hydrated individually (≤8, capped MAX_FILE_CHARS) and prepended (L1960-L2003).
  Provider dispatch (L2043-L2078): Gemini agentic tool-loop when `provider==='gemini'` &&
  (`useTools===true` or auto-complex-task) — `streamGeminiWithTools` with ≤6 tool rounds (L839),
  command approval gate (git writes DEFERRED via `GIT_WRITE_CMD_RE` L43, others await approval
  Promise with 120 s timeout L45,L51), create_file interception for FILE: blocks (L1174);
  otherwise direct NDJSON streams from Anthropic (`claude-sonnet-4-6` default, L86),
  OpenAI (`gpt-4o-mini`, L87), or Gemini (`gemini-3.1-flash-lite`, L152) — 45 s upstream timeout (L153).
  Also fires a shadow verification run post-answer (`fireShadowRun` → `{ai}/shadow/run`,
  L162-L193, gated by `SHADOW_VERIFY_ENABLED`). Response headers expose provider/model and
  code-intel telemetry (`x-llm-provider`, `x-code-intel-*`, L2109-L2129). Errors normalized:
  401 upstream-auth, 429 rate-limit, 504 timeout, else 502 (L2131-L2155). Module-level
  `pendingCommandApprovals`/`deferredCommandsMap` exported on globalThis for cross-route sharing (L33,L40).
- **`POST /api/chat/approve-command`** — approve-command/route.js:L15. Resolves approvals for the
  tool loop: LIVE commands resolve the pending Promise (L25-L30); DEFERRED git commands write the
  intercepted files first (`executeTool('create_file')`, L43-L61) then execute the git command via
  `executeTool('run_command', …)` with 35 s timeout (L64-L83); exec failure → 500 (L84-L90);
  expired/unknown id → 404 (L93-L96). NOTE: no explicit auth check on this route — it trusts
  unguessable approval ids.

### classify
- **`POST /api/classify/intent`** — intent/route.js:L6-L8: pure proxy of ai-engine
  `/classify/intent` via `proxyAiEngineRequest`. No own auth (delegated to internal-token hop).

### code-intel
- **`GET|POST|PUT|DELETE /api/code-intel/[...path]`** — [...path]/route.js:L6-L19. Generic forwarder
  to ai-engine `/code-intel/*` with per-segment encoding; special-cases single-segment `health`
  → `/health` (L10-L12). No session check here.

### completion
- **`POST /api/completion`** — synthi/src/app/api/completion/route.js:L401. Inline FIM code
  completions streamed as plain text. Builds prefix/suffix from `contextBlocks`
  (capped `AI_COMPLETION_MAX_INPUT_CHARS`, truncation keeps trailing prefix L422-L427), merges
  client references with a fast RAG lookup (`GET {ai}/code-intel/context/fast`, 350 ms fetch /
  120 ms embed budgets, in-process TTL cache 256 entries·2 MB, L33-L40,L170-L175) keyed off the
  trailing 600 chars of prefix (L436-L443). Streams `gemini-3.1-flash-lite` via @google/genai SDK
  (temp 0.15, stop sequences incl. COMPLETION_CLOSE, L487-L523), falling back to single-shot when
  the SDK won't stream (L499-L517). 12 s overall timeout (L13); client abort tears the stream down
  to stop token burn (L472-L484). Empty context → empty 200 text (L415-L420). No explicit user
  auth (latency-sensitive path); internal token used only toward code-intel.

### counterfactual
- **`GET|POST|PUT|DELETE /api/counterfactual/[...path]`** — [...path]/route.js:L15-L39.
  "Authenticated same-origin bridge" to the ai-engine counterfactual control plane (comment L6-L10):
  requires a session (`getServerSession`, 401 at L17-L23), requires non-empty suffix (404, L26-L28),
  forwards to `/counterfactual/{suffix}`; ai-engine stays authority for retention/deletion/telemetry
  switch. Proxy failure → 502 (L31-L33).

### extensions
- **`GET /api/extensions/search`** — search/route.js:L18. Open VSX registry proxy (CORS shield):
  `action=search` (query/offset/size/category/sort, L160-L174), `action=detail`
  (namespace+extension required, L175-L184), `action=proxy` for arbitrary open-vsx.org URLs only
  (SSRF-guarded by prefix check, L24-L53), `action=download-vsix` binary passthrough with 120 s
  timeout (L56+). 15 s JSON timeouts via AbortController; cache headers `s-maxage=300`.
  Timeout→504, upstream error passthrough, else 500 (L216-L228). No auth.

### format
- **`POST /api/format`** — format/route.js:L28. Spawns local formatters on stdin/stdout:
  rustfmt (rust), clang-format (c/cpp), prettier (js/ts) (L37-L52). Unsupported language → 400;
  spawn failure/nonzero exit → 500 (L54-L59); malformed JSON → 400. **No auth**, arbitrary code
  piped to host binaries — trusted-environment assumption.

### github
- **`POST /api/github/create-repo`** — create-repo/route.js:L5. Uses the NextAuth session's GitHub
  `accessToken` (401 without, L7-L13); validates repo name charset (L25-L34); creates repo via
  `POST https://api.github.com/user/repos` with `auto_init:true` (L36-L50). Maps 404/403 to a
  re-auth hint and 404→401 (L59-L68); other GitHub errors surface their message; network/unknown → 500.

### integrations
MCP/connection/token management + git providers. Cookie routes use `resolveActor` + scope checks +
rate limits; CLI/MCP routes use PATs.

*Connections (cookie auth)*
- **`GET|POST /api/integrations/connections`** — connections/route.js:L10/L26. List (workspace
  listing needs membership via `canReadScope`) / create MCP connection `{name,url,transport(http|
  sse),scope(personal|workspace),authType(none|bearer|header),headerName,secret}`;
  header names validated against `isAllowedHeaderName` (R1-6, L49-L53); new connections start with
  **empty tool allowlist** fail-closed (L60-L63). Store: lib/integrations/connectionStore (Prisma mcpConnection).
- **`PATCH|DELETE /api/integrations/connections/[id]`** — [id]/route.js:L28/L50. Shared
  `authorize()`: actor + rate limit + row exists + `canWriteScope` (L10-L20). PATCH whitelists
  name/enabled/toolAllowlist/secret/authType/headerName (L38-L45).
- **`POST .../connections/[id]/test`** — test/route.js:L11. Read-level allowed (R1-9, L21-L22);
  decrypts secret, probes via `testConnection`+`listTools` from @synthi/mcp-hub, persists health
  (L32-L35). Probe failure returns 200 with ok:false (deliberate).

*Tokens (Prisma personalAccessToken)*
- **`POST|GET /api/integrations/tokens`** — tokens/route.js:L9/L27. Generate PAT (`generatePat` →
  hash+last4 stored, plaintext returned once, L20-L24) / list own tokens sans hashes.
- **`DELETE /api/integrations/tokens/[id]`** — [id]/route.js:L8. Ownership-checked revoke
  (sets revokedAt, L20).

*Git providers*
- **`GET|POST /api/integrations/git/providers`** — providers/route.js:L11/L21. List (optional
  workspace filter honoring membership) / register PAT provider (github|gitlab|generic; baseUrl
  SSRF-checked via `assertSafeUrl`, L32). Store: lib/git/store (Prisma GitProvider + Secret).
- **`DELETE /api/integrations/git/providers/[id]`** — [id]/route.js:L9. Owner or workspace-member check (L17-L20).
- **`GET .../[id]/repos`** — repos/route.js:L4; **`GET .../[id]/status`** — status/route.js:L5
  (`repo`+`ref` required); both via shared `loadOwnedProvider`+adapter `respond` helper
  (lib/git/routeHelpers).
- **`POST .../[id]/test`** — test/route.js:L10. Adapter `testConnection`, persists health + accountLogin (L22-L24); failure 502.
- **`POST .../[id]/pulls`** — pulls/route.js:L6. Creates PR via adapter; optional CodeSite proof
  boundary: if any codesite context present, requires workspaceSlug+proofBundleId+commitSha+
  commitMessage-or-trailers (400 at L36-L41), verifies through `attachProofBundleCommit` (L42-L56),
  appends a "CodeSite proof" footer to the PR body (L59-L70). 201 on success.

*Git OAuth*
- **`GET .../oauth/[provider]/start`** — start/route.js:L9. Builds authorize redirect for
  github/gitlab (scopes `repo read:user` / `api read_user`, L7), CSRF `state` in httpOnly cookie
  `git_oauth_state` 10 min (L24).
- **`GET .../oauth/[provider]/callback`** — callback/route.js:L9. State-vs-cookie compare (400 on
  mismatch, L16-L18), exchanges code via `gitFetch` (safe-fetch wrapper), upserts OAuth provider
  (encrypted refresh token), redirects to `/workspace?git_connected={provider}`, clears cookie (L30-L38).
  Token-exchange failure → 502 (L27).
- **`POST .../oauth/[provider]/device/start`** — device/start/route.js:L9. RFC device-flow kickoff;
  returns device_code/user_code/verification_uri/interval. Upstream failure 502.
- **`POST .../oauth/[provider]/device/poll`** — device/poll/route.js:L10. Grant-type device_code;
  `authorization_pending|slow_down` → 202 (L21); success upserts provider, returns minimal row 201 (L24-L29).

*MCP (PAT auth)*
- **`GET /api/integrations/mcp/resolve`** — resolve/route.js:L9. Resolved tool configs for the CLI;
  non-member workspace slug silently degrades to personal-only (defense-in-depth comment L17).
- **`POST /api/integrations/mcp/runtime-exec`** — runtime-exec/route.js:L34. One-shot command inside
  the workspace Sysbox pod via `execInWorkspaceRuntime` (routed by slug→runtimeScope, never user id,
  comment L11-L25). Requires canWriteScope **and** pre-existing `program.launch` consent grant —
  a PAT cannot self-grant (L52-L55, 409 `consent_required`). Transient: no ProgramSession row.
  Runtime 409 passthrough; other errors 502.
- **`GET /api/integrations/mcp/programs`** — programs/route.js:L18. Merged DB sessions + live
  runtime sessions + installed catalog for `synthi_list_programs`. Member-readable.
- **`GET /api/integrations/mcp/programs/[sessionId]`** — [sessionId]/route.js:L17. Session merged
  with runtime state + recent events redacted via `sanitizeProgramEvent` (command/env stripped, L45).
- **`POST .../programs/[sessionId]/restart` / `stop`** — restart/route.js:L11, stop/route.js:L11.
  Write-scoped; call runtimeClient restart/stop, update session row + append ack event
  (`via:'mcp'`); stop sets endedAt.
- **`GET|POST /api/integrations/mcp/programs/detect`** — detect/route.js:L27/L40. GET returns the
  detected runtime recipe (no file exposure); POST launches it — additionally gated on existing
  program.launch consent (PAT cannot self-grant, comment L35-L38); crash marks session `crashed` +
  `launch_failed` event, 502 (L60-L64).
- **`POST /api/integrations/mcp/programs/launch`** — launch/route.js:L40. Launch by installId for
  `synthi_launch_program`; **container runtimeType only** (headless/hybrid are user-id-routed so
  PAT-forbidden, L80-L81); full pipeline install→version→manifest parse (422 invalid) →
  createProgramSession → launchInstalledProgram → launch_ack/launch_failed events (L84-L128).
- **`POST /api/integrations/mcp/audit`** — audit/route.js:L66. CLI-side audit sink for MCP tool
  calls → Prisma `mcpCallAudit.create` (bounded strings, sha256 argsHash validated hex64, outcome
  enum ok/error/blocked defaulting to 'error', callerType 'cli', L92-L113). Connection linking is
  ownership-verified (403 forbidden_connection, L77-L86); CodeSite refs resolved **server-side**
  against project/transaction/lease/agent-session rows before persisting (`resolveTrustedCodeSiteRefs`
  L30-L64 — client-supplied ids never trusted blindly). Write failure → 500 audit_write_failed.
- **`GET|POST /api/integrations/mcp/jupyter`** — jupyter/route.js:L153/L163. Multi-op PAT bridge:
  GET ops list|snapshot; POST ops test|execute|save|interrupt|restart. Read ops need canReadScope,
  write ops canWriteScope (L30-L45). Size caps: code 100 KB, notebook 2 MB (L14-L16). Save does
  optimistic-concurrency via expectedServerRevision → 409 server_newer (L117-L119). Every op
  records a Jupyter audit event. Registration stays UI-only by design (comment L149-L152).

### internal
- **`POST /api/internal/payments/webhook`** — payments/webhook/route.js:L14. Stripe webhook:
  verifies `Stripe-Signature` over RAW body fail-closed 401 (L18-L22); maps
  payment_intent.succeeded→grantEntitlement, charge.refunded→revokeEntitlement using event metadata
  (missing metadata 400, L35-L37); dedupes via recordWebhookEventOnce (P2002-safe) reporting
  `{duplicate}` (L48-L51). Unconfigured secret → 503 billing_unconfigured (L15-L16).
- **`POST /api/internal/programs/process-pending`** — programs/process-pending/route.js:L12.
  Scheduler-only autonomous sweep driving non-terminal submissions to terminal state; shared-secret
  header `x-synthi-internal-token` === SYNTHI_INTERNAL_API_TOKEN (503 unconfigured, 401 mismatch,
  L13-L17). Processes ≤50 rows best-effort (single failure doesn't abort batch, L21-L28).

### programs (global)
- **`POST /api/programs/seed-defaults`** — seed-defaults/route.js:L12. Idempotent seeding of official
  `@vectant/*` catalog; inert unless `ENABLE_PROGRAM_SEED==='1'` (404 seed_disabled, L16-L18);
  still requires an authenticated actor.

### local-support
Zero-trust control plane between cloud, support agents, and the user's paired local app. All routes:
same-origin guard + bounded JSON bodies (`httpGuards`), durable policy store consulted first, and a
strict deny-by-default decision envelope (`decision:'denied'`, `bytes_sent:0`, `raw_body_included:false`,
`Cache-Control:no-store` everywhere).
- **`GET /api/local-support/policy`** — policy/route.js:L7. Public org policy read; store failure →
  503 with disabled policy (fail-closed, L12-L20).
- **`POST /api/local-support/pairing`** — pairing/route.js:L19. Actions create|claim|complete.
  `create` demands a NextAuth session and stamps account/org ids (L34-L50); claim/complete resolve
  org from the challenge then enforce durable policy; challenges persisted durably (persistence
  failure → 503 pairing_session_persistence_failed, L105-L112). Status mapping per reason (L115-L120).
- **`GET|POST|DELETE /api/local-support/linked-projects`** — linked-projects/route.js:L11/L16/L28.
  Session-gated linked-project registry tied to an active browser-control session (403 if not
  paired, L22-L23); POST queues a confirmation control command (202); DELETE validates `lproj_…` id
  and queues disconnect (202).
- **`GET|POST /api/local-support/admin/state`** — admin/state/route.js:L16/L40. Admin token header
  `x-vectant-admin-token` vs VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN with constant-time compare and
  token-strength checks (L78-L109); same-origin required; GET summarizes sessions+policy, POST
  performs `update_policy` or revocation actions; store failures → 503.
- **`POST /api/local-support/request-envelope`** — request-envelope/route.js:L14. Validates a
  support-request envelope: signature (`VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET`) when policy enabled
  (403 on bad sig), schema validation, relay-session authorization (403), replay protection (409).
- **`POST /api/local-support/preview-gateway`** — preview-gateway/route.js:L13. Same gates but
  builds a preview-forward decision (`buildPreviewGatewayDecision`) — dry-run counterpart of relay.
- **`POST /api/local-support/security-event`** — security-event/route.js:L12. Session-gated security
  event reporting; summarized then durably persisted unless denied (persist failure 503).
- **`POST /api/local-support/test-request`** — test-request/route.js:L13. Gated behind
  `VECTANT_LOCAL_SUPPORT_TEST_REQUESTS==='true'` (404 otherwise); fabricates an L2
  package.json-read envelope for the newest active paired session and enqueues it (202). Prisma:
  `localSupportSession.findFirst` (L27-L30).
- **`POST /api/local-support/relay`** — relay/route.js:L16. The main support-request intake:
  signature → buildRelayForwardDecision → authorizeRelaySession → replay reserve → enqueueRelayRequest.
  P2002 on enqueue = replay detected → 409 (L86-L94); enqueue failure releases the replay slot and
  503s (L95-L103). Success 202 `relay_queued`.
- **`POST /api/local-support/relay/device`** — device/route.js:L35. Device-authenticated
  (HMAC-signed body via authenticateLocalSupportDevice, 16 KB cap) polling endpoint. Actions:
  `poll` (lease control-command else relay-request else idle), `renew` (session renewal),
  `control_outcome`, `status` (port report), `linked_project_status` (activate linked project),
  `outcome` (report sent/denied/review_pending with bytes/redactions/scanner version). Strict
  field allowlists + regex ids per action (L202-L235); lease mismatches → 409.
- **`POST /api/local-support/relay/device/payload`** — device/payload/route.js:L21. Device uploads
  approved payload content (≤256 KB content / 384 KB body, sha256 verified field) or denies the
  request (`reason` must be exactly `local_user_denied`); stores via relayPayloadStore; stale
  requests → 409 payload_request_not_pending.
- **`POST /api/local-support/relay/payload`** — payload/route.js:L10. Browser-side pickup of an
  approved payload after user review: strict id-shape validation, `takeApprovedRelayPayload`
  (single-delivery semantics), 404 when nothing pending, 503 on store failure.
- **`POST /api/local-support/transparency-action`** — transparency-action/route.js:L22 (462 lines).
  User-initiated control actions over an active session: enable/disable_fast_support, pause/resume/
  disconnect_session, revoke_session_approvals, export/delete_history, revoke_port,
  full_access_enrollment_proposal (builder L309). Requires NextAuth session (L60); consults durable
  admin state + policy; forwards matching actions to the **loopback local daemon**
  (`readLocalDaemonStatus` L203, `forwardLocalDaemonAction` L244, loopback-hostname enforced
  L408, responses sanitized/scrubbed L417/L452) and records revocations durably.
- **`GET /api/local-support/transparency-state`** — transparency-state/route.js:L11. Aggregated
  transparency snapshot for the UI: cloud state + public policy + local daemon status mapped
  (`mapLocalDaemonStatus` L112), no-store.

### next-edit (NEP)
- **`POST /api/next-edit`** — synthi/src/app/api/next-edit/route.js:L441. Next-Edit Prediction:
  given recent edits + cached files, streams predicted SEARCH/REPLACE blocks. Pre-model phase is
  hard-budgeted to 500 ms wall clock (L484-L506): cross-file impact candidates from ai-engine
  `POST {ai}/code-intel/edit-impact` (350 ms timeout, L255-L260) hydrated with real contents from
  collab-server `/git/{slug}/file` (top-4, 400 ms, L309) only within remaining budget. Prompt
  assembles recent-edits/files/impact/codeIntel/validationFeedback blocks (L521-L531). Streams
  `gemini-3.1-flash-lite` (temp 0.2, 1024 max tokens, 18 s timeout, client-abort aware,
  L537-L620). Bail-out: no edits and no files → empty 200 (L464-L469).
- **`GET /api/next-edit/flag`** — flag/route.js:L23. Ops kill switch: `NEP_FLAG_DISABLED`(+_REASON)
  env-driven, 60 s client cache hint. Complements the client-side rolling-window kill (comment L18-L22). No auth.
- **`GET|POST /api/next-edit/telemetry`** — telemetry/route.js:L88/L111. Actor + rate-limited
  (`RATE_LIMITS.telemetry`). POST ingests ≤500 validated events (kind whitelist fire/emitted/
  validated/accepted/rejected/skipped/dismissed; timestamp skew bounds) into an in-process ring
  (≤1 MB); GET aggregates accept/reject rates over a window for dashboards. Test hook
  `__resetTelemetryForTests` (L125).

### oauth-relay
- **`POST /api/oauth-relay/session`** (+OPTIONS) — session/route.js:L7. Workspace-gated creation of
  a relay session binding `{sessionId, expiresAt, expectedCallback, workspaceSlug, runtimeScope,
  providerOrigin}` for extension/desktop OAuth handoff.
- **`POST /api/oauth-relay/callback`** (+OPTIONS) — callback/route.js:L12. Consumes a relay session
  (one-shot: consumed check L26-L32, marked after forward L66), verifies workspaceSlug match (403),
  `requireWorkspaceAccess`, validates callbackUrl against the session's expected callback (L47-L53),
  then forwards to the runtime and reports status (upstream 4xx/5xx passthrough, floor 502).

### provenance
- **`GET /api/provenance/[...path]`** — [...path]/route.js:L57. Allowlisted proxy to ai-engine
  provenance: `/provenance/stats`, `/provenance/file/{path}`, or bare record id (regex
  `[A-Za-z0-9_-]{1,128}`); everything else 404 (L14-L23). Applies a **redaction transform** before
  returning: strips prompt previews, context-file lists, session/user ids and metadata
  (`redactRecord` L40-L55). POST explicitly 405 (L70-L72). Actor required (401).

### shadow (Synthi Genome — Wave 1)
Thin authenticated proxies to ai-engine `/shadow*`; all use `withInternalAiAuth`, all return 502 on
transport failure, `dynamic='force-dynamic'`.
- **`POST /api/shadow/run`** — run/route.js:L21. Validates `workspace_path` + non-empty patches;
  tolerates auth misconfig (logs, proceeds — Wave 1 comment L26-L28); forwards tier/models/user_id.
- **`POST /api/shadow/verify-only`** — verify-only/route.js:L21. Same shape, no-LLM lint/type/test
  mode; same `{jobId,tier}` envelope so the SSE stream is reusable.
- **`POST /api/shadow/[jobId]/apply`** — apply/route.js:L19. Requires universeId; forwards opened
  diff/explanation universe ids; actual Yjs merge happens in the follow-up collab-server endpoint
  (master plan §8.4 comment L8-L10).
- **`POST /api/shadow/[jobId]/cancel`** — cancel/route.js:L14. Fire-and-forget cancel.
- **`GET /api/shadow/[jobId]/stream`** — stream/route.js:L16. Byte-for-byte SSE passthrough
  (`text/event-stream`, x-accel-buffering:no, keep-alive).
- **`POST /api/shadow/[jobId]/why`** — why/route.js:L20. `[Why?]` follow-up: non-empty question →
  Arbiter re-run against cached evidence bundle (§22).
- **`GET|POST /api/shadow/cost`** — cost/route.js:L19/L37. Per-workspace cost dashboard snapshot /
  daily-cap update (numeric daily_cap_usd required).

### shadow_continuous
- **`POST /api/shadow_continuous/opt_out`** — opt_out/route.js:L10. `{workspace_path, opted_out:boolean}` → ai-engine opt-out toggle.
- **`GET /api/shadow_continuous/state`** — state/route.js:L19. Watcher snapshot per workspace
  (last findings, pending paths, debounce, spend — §14+§17). Both plain proxies, no session gate.

### theme-generate
- **`POST /api/theme-generate`** — theme-generate/route.js:L71. AI theme generation: prompt →
  Gemini `generateContent` with a system prompt enumerating ~60 required colour keys + WCAG AA
  contrast rules (L18-L68); response JSON de-fenced, parsed, key-filtered (missing keys simply
  omitted, L144-L150). Missing GEMINI_API_KEY → 503; upstream error → 502; unparsable model output
  → 502. No user auth (client-side feature gate assumed).

### turn-credentials
- **`GET /api/turn-credentials`** — turn-credentials/route.js:L70. WebRTC TURN bootstrap for
  collaboration screenshare/sessions. Requires logged-in JWT (401, L76-L79). Cloudflare Calls
  credentials fetched with in-process cache refreshed below 80% TTL (L21-L30); STUN always included
  (L57). Graceful degradation ladder: Cloudflare unconfigured → LOCAL_TURN_* static creds if set →
  STUN-only `_fallback:true` (L82-L98); CF API failure also degrades to STUN-only with `_error` (L103-L111).

### user
- **`GET|POST|DELETE /api/user/github-token`** — github-token/route.js:L14/L28/L71. Personal GitHub
  PAT vault. GET returns only `{hasToken, login}` (never the token, L22-L25). POST validates the
  token live against `https://api.github.com/user` before persisting encrypted
  (`encryptToken`, upsert githubTokenCipher+githubLogin, L38-L66); invalid → 400 invalid_token,
  GH outage → 502. DELETE nulls both columns.

### workspace
- **`GET|POST|PUT|DELETE /api/workspace`** — route.js:L16/L43/L133/L168. Core CRUD on Prisma
  `workspace`. GET by `?id=` (access-checked). POST: session email → `prisma.user.upsert` → create
  workspace + owner membership in one nested create (creator-is-owner Plan 1a R1-9, L78-L84);
  P2002 slug clash → 409 (L86-L97); then best-effort GCS marker folder `workspaces/{slug}/`
  (skipped w/o bucket config, L100-L124). PUT rename (manage-access). DELETE: manage-access, wipes
  all GCS objects under the prefix **then** deletes the row (L182-L191).
- **`GET /api/workspace/[slug]`** — [slug]/route.js:L65. Access-gated GCS file tree builder
  (`buildFileTree` L9-L62). Empty-bucket self-heal: pulls the file list from collab-server
  `/git/{slug}/files` and back-fills contents via `/git/{slug}/file?path=…` in parallel before
  re-listing (L104-L140).
- **`GET|POST /api/workspace/[slug]/members`** — members/route.js:L11/L48. GET lists memberships
  (role desc) + caller role; POST manage-only invite/upsert by email (role member|admin,
  `workspaceMembership.upsert` L69-L84).
- **`GET /api/workspace/[slug]/search`** — search/route.js:L8. In-memory workspace search index
  (server/workspaceSearchIndex): kicks `ensure()` non-blocking, serves current index state.
  Access-gated.
- **`GET /api/workspace/[slug]/index/ensure`** — index/ensure/route.js:L7 and
  **`GET .../index/status`** — index/status/route.js:L7: manual triggers/status for the same index. No explicit auth on these two (slug acts as capability).
- **`GET|POST|PUT|DELETE /api/workspace/[slug]/item`** — item/route.js:L85/L144/L239/L359. GCS file
  operations under `workspaces/{slug}/…` with normalized paths (`normalizeWorkspaceItemPath` L15)
  and permission mapping to collab perms (`requireCollabPermission` L77): GET download (inline/meta
  modes), POST upload (base64 content, folder markers), PUT rename/move (prefix copy+delete for
  folders, L268-L314) and content save, DELETE folder (prefix sweep incl. virtual-folder marker,
  L379-L397) or file. All access-gated via `requireAuthorizedWorkspace` (L52).
- **Jupyter (cookie auth, `canRead/canWriteScope`, audited)** — servers/route.js:L8-L10
  (list/create registrations via lib/jupyter/registry, tokens stripped on list);
  servers/[id]/route.js (revoke, write-scope); servers/[id]/test/route.js:L9 (status probe);
  execute/route.js:L10 (connectKernel+execute, `.ipynb` + code required);
  save/route.js:L10 (revision-checked save, 409 server_newer on stale expectedServerRevision);
  snapshot/route.js:L8 (read notebook + revisions);
  kernels/[kernelId]/interrupt|restart/route.js:L10 each. Every op writes `recordJupyterAudit`;
  failures map to `{error.code, detail}` 502-ish statuses.
- **Program sessions (cookie auth mirror of the MCP surface)** —
  program-sessions/route.js:L29/L49 (GET merged list; POST launch ad-hoc command: consent grant
  auto-created from requested scopes when absent (L66-L78) — unlike PAT paths which require
  pre-existing consent; createProgramSession → launchProgramRuntime → launch_ack/launch_failed,
  502 on crash);
  [sessionId]/route.js:L10/L28 (GET merged; DELETE stops-if-active then removes);
  [sessionId]/events/route.js:L10 (stored + runtime events sanitized/sorted);
  [sessionId]/restart|stop/route.js:L10 (write-scope lifecycle with ack events + endedAt).
- **Program marketplace/lifecycle (owner/admin for writes, member for reads)** —
  marketplace/route.js:L13 (published catalog enriched with redacted pricing + entitlement flags;
  payout refs never leak, comment L10-L12);
  installed/route.js:L10 (public install metadata);
  scaffold/route.js:L13 (writes starter files server-side from template registry — client files ignored);
  manifest/route.js:L13 (re-validate then overwrite `vectant.programs.json`; fail-closed 422 on schema/scope/host-escape);
  generate-manifest/route.js:L14 (Gemini draft from workspace context; returned even when invalid);
  detect/route.js:L14/L31 (GET recipe; POST launch-detected);
  [installId]/launch/route.js:L19 (paywall evaluated via evaluatePaywall/paywallDenial before launch);
  install/route.js:L29 (POST install by packageId: canWriteScope; discovers the workspace manifest via
  runtimeClient `discoverManifest`, verifies any required consent grant covers its scopes
  (`grantCoversScopes` L19), paywall gate via evaluatePaywall/paywallDenial, persists the install row);
  checkout/route.js:L20 (signed Stripe checkout reference for paid installs; billing-unconfigured → 503);
  pricing/route.js:L14 (set price, PricingError → 4xx);
  publish/route.js:L13 (submitForReview + immediate processSubmission kick-off);
  unpublish/route.js:L11; submissions/route.js:L10 (redacted queue items for this workspace).
- **`GET|POST|PUT|DELETE /api/workspace/[slug]/codesite/[[...path]]`** — codesite/[[...path]]/route.js
  (1117 lines; GET L105, POST L333, PUT/DELETE explicitly 405 L1110-L1114). The CodeSite control-plane
  BFF: ~85 imported control-plane functions (L1-L85) dispatched over a large route table. GET covers
  projects, knowledge, members, permits, route-revisions, events (+SSE `events/stream` L220-L228,
  inbox/stream L280-L286), agent-manifest, channels, schemas, artifact previews, active transactions,
  transaction status/source-state-since, quarantines (proxied L293), line provenance, proof bundles,
  incident replays, readiness/deployment-status probes (internal-service-only readiness, L141-L151).
  POST table governed by `postAccessMode(route)` mapping most mutation endpoints to 'read' level with
  true writes defaulting to 'write' (L754-L791): transactions (open/validate/preview/dry-run/commit/
  abort/record-read/record-write/quarantine-events/assumptions), agent sessions (create/attach/
  heartbeat/inbox-acknowledge/knowledge/channels request-accept-reject-close-violate/mutation leases/
  execution plans), documents+reviews, incidents (create/resume mayday), counterfactual runs,
  inspection runs, policy deltas (create/promote/reject), zone policy updates, members upsert/revoke,
  collision-predict, observations, proof-bundle commit, route revision propose/review/apply.
  Agent-token routes (`bearerToken()` L323) bypass cookie auth for agent-session context/inbox reads.
  Quarantine sub-routes proxy to the runtime with a synthesized identity (L869-L1031) and fire a
  short-timeout activity notification to collab-server (`notifyCollabCodeSiteActivity` L1058-L1091).
  Access via `requireCodesiteAccess(slug, mode, request)`; errors funneled through handleCodesiteError.

## Cross-Cutting Observations

1. **Three-tier delegation**: Next.js app layer is mostly auth + orchestration; file truth lives in
   collab-server (`/git/*`, `/file-content/*`, spawner, program-runtime), intelligence in ai-engine
   (`/code-intel/*`, `/classify/*`, `/shadow*`, `/counterfactual/*`, `/provenance/*`), LLM calls
   either proxied (Gemini REST in chat/theme-generate/next-edit/completion) or SDK-side (@google/genai).
   y-sweet is never referenced from app code — realtime is fully abstracted behind collab-server.
2. **Auth gradient**: strictest = admin/internal (platform-admin flag, shared-secret headers);
   middle = workspace membership (owner/admin for writes via workspaceAccess); loosest = latency-
   sensitive IDE routes (`completion`, `format`, `theme-generate`, `classify`, `code-intel`,
   `next-edit/flag`) which carry no explicit session check — they rely on network position.
   `chat/approve-command` similarly trusts opaque approval ids.
3. **Consent asymmetry**: cookie/UI program launches may mint a `program.launch` PermissionGrant on
   the fly (program-sessions POST), while every PAT/MCP launch path refuses to self-grant and
   returns 409 consent_required — deliberate privilege boundary.
4. **Fail-closed patterns recur**: new MCP connections ship with empty tool allowlists; local-support
   denies with `bytes_sent:0` on every failure path including store outages; Stripe webhooks verify
   signature over the raw body before parsing; provenance responses are redacted server-side.
5. **Latency engineering in editor routes**: parallel RAG+hydration fan-in (chat), wall-clock-budgeted
   pre-model phases (next-edit 500 ms), micro-timeouts on RAG (completion 350/120 ms), aggressive
   client-abort propagation to stop token spend, and in-process caches (TURN creds, NEP telemetry
   ring, completion RAG cache).

## Appendix: Complete API handler index (110)

```
admin      GET  /api/admin/program-reviews                     · POST /[versionId]
agent      POST /api/agent
auth       GET|POST /api/auth/[...nextauth]                    · GET /api/auth/token
browser    GET|POST|OPTIONS /api/browser-workflows/[...path]   · GET /api/browser-workflows/state
chat       POST /api/chat                                      · POST /api/chat/approve-command
classify   POST /api/classify/intent
code-intel GET|POST|PUT|DELETE /api/code-intel/[...path]
completion POST /api/completion
counterfactual GET|POST|PUT|DELETE /api/counterfactual/[...path]
extensions GET  /api/extensions/search
format     POST /api/format
github     POST /api/github/create-repo
integra    GET|POST /api/integrations/connections              · PATCH|DELETE /connections/[id] · POST /connections/[id]/test
           GET|POST /api/integrations/tokens                   · DELETE /tokens/[id]
           GET|POST /api/integrations/git/providers            · DELETE /providers/[id] · GET /repos · GET /status · POST /test · POST /pulls
           GET /git/oauth/[provider]/start · GET /callback · POST /device/start · POST /device/poll
           GET /api/integrations/mcp/resolve · POST /mcp/runtime-exec · GET|POST /mcp/jupyter · POST /mcp/audit
           GET /mcp/programs · GET /programs/[sessionId] · POST restart · POST stop · GET|POST detect · POST launch
internal   POST /api/internal/payments/webhook                 · POST /api/internal/programs/process-pending
local-sup  GET policy · POST pairing · GET|POST|DELETE linked-projects · GET|POST admin/state
           POST request-envelope · POST preview-gateway · POST security-event · POST test-request
           POST relay · POST relay/payload · POST relay/device · POST relay/device/payload
           POST transparency-action · GET transparency-state
next-edit  POST /api/next-edit                                 · GET flag · GET|POST telemetry
oauth-relay POST session · POST callback (+OPTIONS)
programs   POST /api/programs/seed-defaults
provenance GET /api/provenance/[...path]
shadow     POST run · POST verify-only · POST [jobId]/apply · POST cancel · GET stream · POST why · GET|POST cost
shadow_cont POST opt_out · GET state
theme-gen  POST /api/theme-generate
turn-cred  GET /api/turn-credentials
user       GET|POST|DELETE /api/user/github-token
workspace  GET|POST|PUT|DELETE /api/workspace · GET /[slug] · GET|POST members · GET search · GET index/ensure · GET index/status
           GET|POST|PUT|DELETE item
           jupyter: GET|POST servers · DELETE servers/[id] · POST test · POST execute · POST save · GET snapshot · POST interrupt · POST restart
           program-sessions: GET|POST · GET|[D]ELETE [sessionId] · GET events · POST restart · POST stop
           programs: GET marketplace · GET installed · POST scaffold · POST manifest · POST generate-manifest · GET|POST detect
                     POST install · POST [installId]/launch · POST checkout · POST pricing · POST publish · POST unpublish · GET submissions
           GET|POST|PUT|DELETE codesite/[[...path]]
```

---

## Related

[[Synthi Frontend]] · [[Area - Synthi Lib and Data]]

[[00 Home|🏠 Back to Home]]
