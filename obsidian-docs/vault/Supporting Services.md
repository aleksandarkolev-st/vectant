---
tags: "packages", "services"
system: Supporting Services
source-repo: vectant-ade
generated: 2026-08-25
---

# Supporting Services

> [!info] Provenance
> Deep-dive analysis generated from the live repository tree (`main` @ `ce74771af`, 2026-08-25).
> Raw source: `docs/obsidian-src/supporting-services.md` in the repo. All paths below are repo-relative unless noted.

---
title: Supporting Services — Service Analysis
source: packages/, backend/y-sweet/, backend/synthi-webrtc-compiler/, ai-backend/gateway, ai-backend/agent-runner, extensions/vectant-oauth-relay
repo: vectant-ade
analyzed: 2026-08-25
tags: [vectant-ade, mcp-hub, atomic-orchestrator, programs-mcp, y-sweet, signaling, webrtc, ai-gateway, agent-runner, oauth-relay]
---

**Supporting Services (`vectant-ade`)**

> Analysis of the pieces around the two big services (Next.js `frontend`/synthi app and `ai-backend/ai-engine`, covered separately): the three npm-workspace **packages**, the **y-sweet CRDT store**, the **WebRTC compile stack** (Rust signaling server + worker), the Node **AI gateway**, the **agent-runner** harness image, and the **Vectant OAuth Relay** browser extension.

---

## 0. Map — who talks to whom

```
Browser ──ws──► ai-gateway :7071 ──HTTP──► ai-engine :8000        (analysis / self-healing)
   │                                                           
   ├──ws──► signaling-server :9000 ◄──ws── worker (Rust+GStreamer)  
   │             │                                            
   │             └──Redis Pub/Sub──► redis                     (multi-pod relay)
   │             └──webhook──► collab-server /api/spawner/session-ended
   │
   └──ws──► collab-server :1234 ──REST(@y-sweet/sdk)──► y-sweet :8180   (CRDT persistence)

ai-engine ──docker run──► vectant-agent-runner:local  (disposable Codex/Claude/Hermes capsule)
packages/atomic-orchestrator ◄─ imported by synthi agent-routing libs
packages/mcp-hub             ◄─ imported by synthi API routes + mcp/synthi-mcp
packages/programs-mcp        ◄─ stdio MCP server registered via .mcp.json (vectant-programs)
oauth-relay extension ──POST──► synthi /api/oauth-relay/callback
```

Infra siblings not analyzed here (see docker-compose.yml): `postgres`, `redis`, `coturn`, `runtime-image` (`vectant-runtime:local` builder stub).

---

## 1. `packages/atomic-orchestrator` (`@vectant/atomic-orchestrator`)

**Purpose.** Provider-neutral lifecycle for *atomic changes*: decompose a request into tasks, route each task to the cheapest capable agent using **metadata only**, execute with injected workers, validate independently, and recover from failures — preserving dependency/failure state throughout. The privacy boundary is deliberate: the planner sees only ids/categories/keywords; full instructions and tool schemas cross only the narrow executor boundary.

**Key files**

| File | One-liner |
|---|---|
| `src/index.js` | `createOrchestrator(options)` factory wiring planner + `runAtomicTasks`; plus `routeJson()` serializer for a route. |
| `src/task-planning.js` | Metadata-only planner: task normalization, dependency topological sort w/ cycle detection, keyword/category skill scoring (max 3 skills), cheapest-capable-agent selection, validation policy, `isFastPath()` regex (`rename|format|typo|mechanical`), optional pluggable `routers`. |
| `src/execution-lifecycle.js` | `runAtomicTasks()`: executes ordered tasks sequentially; marks `blocked` when dependencies failed; fast-path bypasses the router; picks executor by agent-id → role → `default`; invokes `loadSkills`; on error tries `recoveries[...]`; then validates via cheapest `validation`-role agent. Statuses: `completed / recovered / invalid / failed / blocked`. |
| `src/index.test.js` | Vitest suite covering routing, ordering, blocking, recovery, validation. |

**Routing policy highlights** (`validationFor`): independent validation is forced when the task is `risk: high|critical` or `category: security`, or explicitly requested; otherwise `none`.

**Consumers**
- `synthi/src/lib/agent-routing/agent-pipeline-routing.js` and `chat-tool-routing.js` import `createOrchestrator` **directly by relative path** (`../../../../packages/atomic-orchestrator/src/index.js`) — pipeline agents and chat tools route through it before Gemini declarations are attached.
- `mcp/synthi-mcp/src/atomic_task_router.ts` mirrors its route contract in TypeScript (injectable compat shape, no JS import) for the agent-side router.
- Not published; consumed only inside the monorepo (workspaces: `packages/*`).

---

## 2. `packages/mcp-hub` (`@synthi/mcp-hub`)

**Purpose.** The synthi backend's **client-side MCP toolkit**: connect to external MCP servers over Streamable-HTTP/SSE, list/call their tools, and a hardened SSRF-guarded fetch used wherever server-side code fetches URLs. Everything returns a normalized envelope `{ ok: true, ... } | { ok:false, error:{code,message} }` — never throws across the API boundary.

**Key files**

| File | One-liner |
|---|---|
| `src/index.js` | Barrel: exports `listTools/callTool/testConnection`, `assertSafeUrl/isBlockedIp`, `buildAuthHeaders/jsonSchemaToGemini/isAllowedHeaderName`. |
| `src/client.js` | MCP client sessions (`@modelcontextprotocol/sdk`) over Streamable HTTP or SSE; injects auth headers + guarded fetch into the transport; whole session raced against `SYNTHI_MCP_CALL_TIMEOUT_MS` (default 20000); error classifier → `timeout / auth_failed / tls_error / protocol_error / tool_error / ssrf_blocked`. Allowlist from `SYNTHI_MCP_SSRF_ALLOWLIST` (comma-separated hosts). |
| `src/ssrfGuard.js` | `assertSafeUrl(url,{allowlist,lookup})`: HTTPS-only unless allowlisted; blocks `localhost`, `*.localhost`, `metadata.google.internal`; IP-literal + DNS-resolved checks against loopback/private/link-local/CGNAT ranges; decodes IPv4-mapped IPv6 (dotted **and** hex-group forms); strips FQDN trailing dot so `localhost.` can't dodge. |
| `src/guardedFetch.js` | `createGuardedFetch()`: closes the TOCTOU/rebinding hole left by pre-flight checks — re-validates immediately before **every** network hop and follows redirects manually (`redirect:'manual'`, ≤3 hops, each hop re-checked). |
| `src/helpers.js` | `buildAuthHeaders` (none/bearer/custom-header, header name validated as RFC 7230 token and denied `host/cookie/authorization/x-forwarded-*` etc.); `jsonSchemaToGemini` converts MCP JSON-Schema input schemas to Gemini's UPPERCASE function schema (depth-bounded 8, description ≤512 chars). |
| `index.d.ts` | Hand-written types for the four public surfaces. |

**Consumers** — a genuine synthi dependency (`"@synthi/mcp-hub": "*"` in `synthi/package.json`, transpiled via `next.config.mjs → transpilePackages`):
- `synthi/src/app/api/chat/externalTools.js` — exposes external MCP connection tools inside chat (`listTools` discovery with bounded fan-out, `callTool` execution capped per turn, `jsonSchemaToGemini` for declarations).
- `synthi/src/app/api/integrations/connections/*` — `isAllowedHeaderName` guards custom auth headers stored per connection.
- `synthi/src/lib/git/safeFetch.js` — every server-side git fetch goes through `assertSafeUrl`.
- `mcp/synthi-mcp` (`"file:../../packages/mcp-hub"`) — `src/external/index.ts` uses `listTools/callTool`; because of this, both `synthi/Dockerfile` and `mcp/synthi-mcp/Dockerfile*` must build from the **monorepo root context** and `COPY packages/mcp-hub` in (a narrow context can't resolve the workspace sibling).

---

## 3. `packages/programs-mcp` (`@synthi/programs-mcp`)

**Purpose.** A standalone **stdio MCP server** that teaches an AI coding agent (Claude Code, Codex, Cursor — anything speaking MCP stdio) the **`vectant.programs.json`** manifest format, so the agent can author/validate a program recipe directly from a Vectant workspace terminal. Explicitly **advisory**: the authoritative, fail-closed gate runs server-side at publish time (`parseProgramManifest` + review pipeline).

**Key files**

| File | One-liner |
|---|---|
| `src/index.js` | `#!/usr/bin/env node` entry; `StdioServerTransport`; prints `ready (stdio)` on stderr. |
| `src/server.js` | Thin glue binding `PROGRAMS_TOOLS` to the low-level SDK `Server` (raw JSON-Schema tools — deliberately avoids Zod to stay dependency-light). |
| `src/tools.js` | The three tools as pure `{name, description, inputSchema, handler}` descriptors: `describe_manifest_schema`, `validate_manifest`, `generate_manifest`. Handlers return `{structuredContent, text}`; deps injectable for tests. |
| `src/manifestSpec.js` | Single source of truth mirrored from `synthi/src/lib/programs/manifest.js`: `KNOWN_SCOPES` (`program.launch`, files read/write, `network.outbound`, `ports.expose`), `SUPPORTED_RUNTIME_TYPES` (web/cli/tui/background/gui/container), `ALLOWED_SURFACES`, `PACKAGE_ID_PATTERN`, `SENSITIVE_SCOPES` (route submissions to manual review), field table, host-escape rules, web + container worked examples, rendered markdown reference. |
| `src/validate.js` | Advisory validator collecting **all** problems in one pass: packageId charset/no `..`, missing version/launch, bad runtimeType, absolute/traversal `workingDir`, port ranges, unknown scopes, and a `host_escape` scan across every `install[]` + `launch` command string. |
| `src/hostEscape.js` | Standalone copy of the backend denylist (kept in sync with `synthi/src/lib/programs/hostEscape.js`): rejects `docker.sock` / `/var/run/docker`, `--privileged|--cap-add|--security-opt|--device`, and `-v/--volume` with an **absolute host-path source** (the legitimate `-v "$PWD":/workspace` passes because its source starts with `$`). |
| `src/generateClient.js` | Optional delegation: `POST {files, workspace_name}` to `VECTANT_MANIFEST_GENERATE_URL` with token header `VECTANT_MANIFEST_GENERATE_TOKEN_HEADER` (default `x-synthi-internal-token`). Off until configured (`not_configured`) — matches the ai-engine endpoint `POST /programs/generate-manifest` (`ai-backend/ai-engine/main.py`). Fail-closed structural errors, fetch injectable. |

**Registration & consumers**
- Repo-root `.mcp.json` auto-registers it as `vectant-programs` (`node packages/programs-mcp/src/index.js`) for any MCP host opened in this repo/workspace.
- Manual registration elsewhere: `claude mcp add vectant-programs -- node .../packages/programs-mcp/src/index.js`.
- `__tests__/drift.test.js` keeps `manifestSpec`/`hostEscape` in sync with the backend parser; per-user workspace terminals do **not yet** auto-provision this server (seeding into the runtime image is tracked as separate infra work).

---

## 4. `backend/y-sweet` + compose service `y-sweet`

**Purpose.** Docker packaging for the official **Y-Sweet** server (jamsocket) — the **Yjs/Yrs CRDT document server** providing WebSocket sync relay + document persistence for collaborative editing. The directory contains only a `Dockerfile` (pins `ghcr.io/jamsocket/y-sweet:latest` **by digest**, binary reports v0.9.1) and a README; all behavior comes from upstream.

**Compose service**

| Aspect | Value |
|---|---|
| Build/image | `./backend/y-sweet` → `synthi-y-sweet` |
| Ports | `127.0.0.1:${YSWEET_HOST_PORT:-8180} → 8080` |
| Command | `y-sweet serve /data --host 0.0.0.0 --port 8080` |
| Volume | `ysweet-data:/data` (persistence) |
| Env | `Y_SWEET_AUTH_KEY=dev-secret` |
| Healthcheck | bash `/dev/tcp` probe on 8080 |

**Consumers**
- **collab-server** is the primary client: `YSWEET_URL=http://y-sweet:8080`, `YSWEET_AUTH_KEY=dev-secret`.
  - `backend/collab-server/ySweetBridge.js` — thin `@y-sweet/sdk` `DocumentManager` bridge: issues client-connection tokens, reads doc content server-side (pre-stage flush / git sync), and `resetDocContent()` heals split-brain when disk was written out-of-band (AI agent/terminal) and diverged from the CRDT snapshot. Doc IDs are base64url-encoded because y-sweet 0.9.x restricts ID charset.
  - `POST /ysweet/token` route in `collab-server/server.js` — reconciles the y-sweet doc hash against authoritative disk content **before** issuing tokens, resetting if disk is newer.
- **k8s**: `k8s/y-sweet.yaml` deploys the same image (single replica "beta floor", GCS-backed persistence, stateless pods).
- **frontend** receives `NEXT_PUBLIC_YSWEET_URL` as a build arg (`http://localhost:${YSWEET_HOST_PORT:-8180}`), but in the current local stack browsers reach CRDT state through **collab-server's own `/collab` WebSocket** (`collab-crdt.worker.js` → `resolveCollabWsUrl()`); y-sweet acts as the durable CRDT store behind collab-server rather than a direct browser dependency.

---

## 5. `backend/synthi-webrtc-compiler` — signaling-server + worker

Monorepo-within-the-monorepo for the **WebRTC compile/stream plane**: a Rust signaling server and a heavy Rust worker that compiles/runs user programs and streams the GUI back to the browser. Shared docs: `README.md` (manual run + ICE/TURN guidance), `PLUGIN_ABI.md` (frozen core/gui module-slot ABI enabling GUI-only hot reload).

### 5.1 `signaling-server` (compose service `signaling-server`) — Rust, v0.2.0

**What it does.** Session-multiplexed WebSocket signaling for every WebRTC pairing in the product (browser↔worker, MCP observers). Peers `register {role, session_id}`; SDP/ICE is routed **only between peers sharing the same session**; Redis Pub/Sub lets any pod deliver to whichever pod holds the target socket (horizontal scale, no sticky sessions).

**Source files** (`src/`)

| File | One-liner |
|---|---|
| `main.rs` (~1.4k lines) | Whole server: wire protocol, roles, Redis relay, presence, operator controls, disconnect webhook. |
| `agent_auth.rs` | Phase-4 scoped-agent auth + TURN credential minting (details below). |

**Behavior highlights**
- **Roles**: `browser` (singleton/session), `worker` (singleton), `observer` (multi-peer — humans debugging / MCP Path A co-attach), `operator` (one monitor with kill switch; never counted in presence, may only send `register` + `kick-peer`), `mcp-agent` (Phase-4 multi-peer agent role, optionally token-gated).
- **Eviction ("Path A")**: re-registering a singleton role evicts the prior sender. Multi-peer roles append.
- **Relay**: publishes `RelayEnvelope{source_node,target_key,payload}` on channel `signaling:relay`; target keys are `session:<sid>:<role>` (fan-out) or `peer:<peer_id>` (direct delivery when the worker stamps a peer id — avoids cross-talk between observers). Subscribed pods skip their own messages; reconnect loop retries every 2 s; Redis PING fails fast at boot.
- **Identity safety**: server always stamps `peer_id`+`role` onto forwarded non-worker payloads (client-sent values are overwritten — prevents an observer forging `role:"browser"` to evict the real browser). Non-registered sockets are dropped; operators' non-control messages are dropped.
- **Presence**: broadcasts `{type:"presence", attached_humans, attached_agents}` on register/disconnect (worker/operator excluded from counts; unknown roles count conservatively as human).
- **Operator controls**: `kick-peer` (operator-only; `worker`/`operator` not kickable) fires per-peer kill signals biased ahead of socket reads; kicked peer gets a final `{type:"evicted", reason}` frame; other operators get a `kick_executed` event.
- **Protocol negotiation**: `supported_protocols` handshake, highest mutually-supported wins; omitting defaults to v1 (byte-identical legacy wire); no overlap → `unsupported_protocol` rejection before any routing state is populated.
- **Legacy dev mode**: worker without `SESSION_ID` registers under `__legacy__` and is bridged to whichever real browser session it serves (this is exactly how the base compose worker runs).
- **Session teardown webhook**: when the last peer leaves, `POST {COLLAB_SERVER_URL}/api/spawner/session-ended` so collab-server can tear down the workspace pod (route exists at collab-server/server.js:2212).
- **Auth/TURN (`agent_auth.rs`)**: if `SYNTHI_AGENT_TOKEN_SECRET` is set, `mcp-agent` registers must carry an HS256 JWT with claims `{sub, scope:"mcp-agent", session_id, role?, exp}` (60 s clock-skew grace; stable rejection codes like `agent_token_session_mismatch`). If `SYNTHI_TURN_SECRET` + `SYNTHI_TURN_URLS` are set, the `registered` ack includes coturn `use-auth-secret` REST credentials (`username=<expiry>:<subject>`, `credential=base64(HMAC-SHA1(secret, username))`, TTL default 3600 s). Both opt-in/off by default.

**Ports/env**: `SIGNALING_PORT` (9000), `REDIS_URL`, `NODE_ID`, `COLLAB_SERVER_URL`, `SYNTHI_AGENT_TOKEN_SECRET`, `SYNTHI_TURN_SECRET`, `SYNTHI_TURN_URLS`, `SYNTHI_TURN_TTL_SECONDS`.
**Deployment**: multi-stage `rust:1.88-bookworm` → `debian:bookworm-slim`, non-root `signaling` user, EXPOSE 9000; compose maps `127.0.0.1:${SIGNALING_HOST_PORT:-9000}:9000` with `REDIS_URL=redis://redis:6379`, `COLLAB_SERVER_URL=http://collab-server:1234`; k8s manifest `k8s-signaling.yaml`.

**Consumers**
- Browser: `synthi/src/services/compilerClient.js` + `operatorClient.js` via `NEXT_PUBLIC_COMPILE_SIGNAL_URL` (`ws://localhost:${SIGNALING_HOST_PORT:-9000}` baked at build).
- Rust worker: `SIGNALING_URL` env.
- `mcp/synthi-mcp`: `SYNTHI_SIGNALING_URL` (default `ws://localhost:9000`) — registers `observer`/`mcp-agent` peers; the compose `mcp` sleeper container `depends_on` signaling-server and pairs container-to-container over host ICE candidates to skip TURN deliberately.
- collab-server spawners (`localWorkerSpawner.js`, `processWorkerSpawner.js`, `workspacePodSpawner.js`) hand each spawned worker its `WORKER_SIGNALING_URL`.

### 5.2 `worker` (compose service `worker`) — Rust + GStreamer + Xvfb

**What it does.** The compute endpoint of a session: accepts browser input/code over WebRTC (data channels + video via GStreamer `webrtcbin`), **compiles and runs user programs**, streams the resulting GUI video back, and drives hot reload. Modules: `compiler/` (plugin ABI slots `core`/`gui`/`main`, builders, error parser), `hmr/` (fast-refresh boundary checker, adapter FSMs, GPU-HMR behind the `gpu-hmr` cargo feature — see docs/obsidian-src/gpu-hmr.md), `runtime/` + `runner` binary, `safety/` (hardened IPC, quiescence), `android/`, `infra/` (observability), `webrtc/` (PeerRegistry with Browser/Observer/MCP roles). `main.rs` alone is ~5.3k lines; expected image size 3–5 GB (compiler toolchains, GStreamer, Xvfb, LSP servers, VS Code server manager).

**Compose wiring**: built from `./backend/synthi-webrtc-compiler/worker` with `WORKER_CARGO_FEATURES` (base stack: `gpu-hmr`; NVIDIA/AMD overlays add device access via `INSTALL_ROCM`, `/dev/dxg`, etc.). Runs `restart: unless-stopped` (an unattended panic otherwise hangs every subsequent compile), `shm_size 8gb`, `cap_drop: ALL`, `no-new-privileges`, mounts `collab-data:/data:ro` (reads the same repos collab-server writes). Key env: `SIGNALING_URL`, `COLLAB_SERVER_URL`, `AI_BACKEND_URL=http://ai-engine:8000`, `SYNTHI_REPOS_PATH=/data/repos`, `DISPLAY=:99`, `GST_DEBUG`, `RUST_BACKTRACE=full`, `SYNTHI_GPU_HMR`.

**Consumers/callers**: browsers pair through the signaling server (RUN button in a `.cpp`/code file starts a compile stream per README); the worker itself calls **ai-engine** (`AI_BACKEND_URL`) for LLM refactor/heal operations and reads workspace files from the shared volume; collab-server spawns workers (local process spawner, per-workspace containers, or K8s pods) pointing them at signaling.

---

## 6. `ai-backend/gateway` (compose service `ai-gateway`) — Node WS⇄HTTP edge

**Purpose.** Bridges the browser's single WebSocket (`/ws`) to the Python ai-engine's large HTTP surface. Lets the frontend avoid many HTTP endpoints and get streaming-style progress over one socket. Package name `synthi-gateway`; deps just `ws`, `undici`, `dotenv`.

**Key facts about `server.js` (~3.1k lines)**

- **Cluster mode**: primary forks one worker per CPU and restarts dead ones (`GATEWAY_CLUSTER`, `GATEWAY_WORKERS`); compose sets `GATEWAY_CLUSTER=false` locally.
- **75 WS actions** mapped to ai-engine routes, grouped as:
  - `analyze/static|ai|proactive(/quick)|container|unified|workspace(/incremental)`
  - `heal/analyze|apply|container|config|stats|rules|batch|cache/stats|presets|preset|metrics`
  - `heal/ai/*` — analyze, batch, hybrid, stats, feedback, memory(+clear), **stream**, project, config(+update), health, cache/clear, preview, policy suppress/unsuppress/list/clear, rule/translate
  - `heal/agentic/*` — Failure-Distiller plane: distill (run/explain/materialize/delete/purge-expired/vivarium-export/vivarium-promote/validate-patch/request-apply/apply-approved/metrics/observations), diagnose, episode(s), policy evaluate/status, verify, guardrails, telemetry calibration/degrading, runtime ingest/stats, observability error/build/**hmr-failure**/stats/triggers, canary create/list/stats, status.
- **Streaming**: `heal/ai/stream` consumes the backend's `text/event-stream` and re-emits each SSE event as a WS message; several analyzers emit progressive partial updates (tier/layer/diagnostics) so the UI feels streamed.
- **Auth** (`isAuthorizedGatewayRequest`): static shared token (timing-safe compare) **or** HS256 JWT verified with `GATEWAY_JWT_SECRET || AUTH_SECRET || NEXTAUTH_SECRET` requiring `aud: "synthi-gateway"` + exp/nbf checks. Token sources: `Authorization: Bearer`, `x-synthi-internal-token`, `?token=`/`?authToken=`, cookies `synthi_gateway_token`/`ai_backend_auth`. `GATEWAY_AUTH_DISABLED=true` is honored only outside production unless `GATEWAY_AUTH_ALLOW_INSECURE_LOCAL=true` (compose sets both → open locally, closed by default in prod).
- **Backpressure**: per-connection sliding-window rate limit (20 msg/s) + max 5 in-flight requests; oversized/error details withheld from clients (requestId reference instead); `apiKey/api_key` values redacted before logging; outbound requests carry `x-synthi-internal-token` when `AI_BACKEND_AUTH_TOKEN` is set and are timeout-bounded (`BACKEND_REQUEST_TIMEOUT_MS` default 30 s).
- **HTTP side**: only `/health` + `/gateway/health` (returns backend URL) — everything else is 404.

**Ports/env**: container `GATEWAY_PORT=7070`, path `GATEWAY_WS_PATH=/ws`, host `127.0.0.1:${AI_GATEWAY_HOST_PORT:-7071}`; `BACKEND_URL=http://ai-engine:8000`. Dockerfile pins `node:20-alpine` by digest, non-root `synthi`, EXPOSE 7070. K8s: `k8s/ai-gateway.yaml`.

**Consumers**: frontend hooks `useAnalyzerGateway` / `useAIHealing` / `useProactiveAnalysis` through `synthi/src/services/analyzerGatewayClient.js`, pointed at `NEXT_PUBLIC_GATEWAY_WS_URL` (`ws://localhost:${AI_GATEWAY_HOST_PORT:-7071}/ws` baked into the frontend build args).

---

## 7. `ai-backend/agent-runner` (compose service `agent-runner-image`) — disposable agent harness image

**What it does.** Not a running service — it **builds the `vectant-agent-runner:local` image** that ai-engine launches as short-lived, heavily sandboxed Docker containers whenever an authorized agent performs live edits (shadow/agent flows). The compose entry runs `/bin/true` and exits so a plain `docker compose up --build` materializes the image; `ai-engine` `depends_on: agent-runner-image (service_completed_successfully)`.

**Dockerfile**: `node:22-bookworm-slim` (digest-pinned) + python3/venv/git; installs `@openai/codex@0.149.0` and `@anthropic-ai/claude-code@2.1.240` globally, plus `hermes-agent==0.19.0` into a `/opt/hermes` venv prepended to PATH; creates system group/user `agent` (uid/gid 10001, no home); WORKDIR `/workspace`; ENTRYPOINT `agent-entrypoint.sh` (mode 0555, runs as 10001).

**`entrypoint.sh`**: copies per-tool credential trees from the **read-only** `/run/agent-credentials/<codex|claude|hermes>` volume into private writable `/tmp/<tool>` dirs (sessions/caches) so credentials work but nothing persists past the disposable container; then `exec "$@"`.

**Consumed by**: `ai-backend/ai-engine/shadow/agent_execution.py` — `AgentContainerPolicy.from_environment()` reads `SYNTHI_AGENT_RUNNER_IMAGE` (= `vectant-agent-runner:local`), `SYNTHI_AGENT_RUNNER_NETWORK=vectant-ade_agent-egress` (isolated egress network), `SYNTHI_AGENT_CREDENTIALS_VOLUME=vectant-ade_agent-credentials`, workspace from `SYNTHI_AGENT_WORKSPACE_VOLUME` (`vectant-ade_collab-data`), and builds a fail-closed invocation: `--rm`, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, pids/memory/cpu caps, 300 s timeout. The engine control-plane itself never gets these mounts; secrets come from the provisioned credentials volume, never the engine's env. (Distinct from the Failure Distiller capsules, which use a pinned `python:3.12-slim` allowlist.)

---

## 8. `extensions/vectant-oauth-relay` — Chrome MV3 OAuth callback relay

**Purpose.** Removes the paste step from terminal OAuth flows. CLIs in a workspace print `localhost` redirect URIs that can't resolve in the user's normal browser; the default flow is "open link, copy redirected URL, paste back". With the extension, when a relay session is **armed** from a Vectant page, it captures the failed loopback navigation and submits it to the backend automatically. Without it, the manual flow still works (per README + `docs/TERMINAL_OAUTH_RELAY_PLAN.md`).

**Key files**

| File | One-liner |
|---|---|
| `manifest.json` | MV3; permissions `webNavigation`+`storage`; host permissions limited to `https://beta.vectant.dev/*`; module service worker; content script `content-bridge.js` at `document_start` on beta.vectant.dev; `externally_connectable` for beta.vectant.dev. |
| `background.js` | Arms/stores short-lived relay sessions (`chrome.storage.session`, fallback local; 15-min hard cap `MAX_SESSION_AGE_MS` + expiry); listens to `webNavigation.onBeforeNavigate`/`onErrorOccurred`; parses **loopback-only** URLs (`localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, valid port); matches against the armed session's `expectedCallback` (host/port/pathPrefix); POSTs `{sessionId, workspaceSlug, callbackUrl}` to the armed HTTPS endpoint (must equal the arming page origin) with `credentials:'include'`; records `lastSubmission` **without query params**; disarms on success/expiry; dedupes per-session submissions; handles `SYNTHI_OAUTH_RELAY_STATUS/ARM/CLEAR` messages (incl. `onMessageExternal` from the Vectant origin). |
| `content-bridge.js` | Page↔extension `postMessage` bridge (namespaced sources `vectant-/synthi-oauth-relay-page|extension`), READY ping + messageId-correlated request/response forwarding to `chrome.runtime`. |

**Backend counterpart (consumers of the extension's POSTs)** — in the synthi app:
- `POST /api/oauth-relay/session` (`synthi/src/app/api/oauth-relay/session/route.js`) — after `requireWorkspaceAccess`, mints a signed short-lived relay-session payload (`createRelaySessionPayload`, secret chain `SYNTHI_OAUTH_RELAY_SECRET → NEXTAUTH_SECRET → AUTH_SECRET → …`) returning sessionId/expiresAt/expectedCallback.
- `POST /api/oauth-relay/callback` (`callback/route.js`) — validates session unconsumed, workspace scope match, workspace access, and callback-vs-expected shape; then `forwardRuntimeCallback` delivers the exact URL into the workspace runtime and marks the session consumed.

**Security model** (README): no scripts injected into provider pages, no provider DOM inspected, callbacks never stored (only relay metadata + last submit result minus params), capture must be armed from a Vectant page for a specific workspace/runtime, communication restricted to `https://beta.vectant.dev/*`.

**Build/distribution**: `npm run build:oauth-relay-extension` (root package.json → `scripts/build-oauth-relay-extension.mjs`) writes unpacked dir + stable zip + versioned zip under `synthi/public/vectant/extensions/`, plus legacy `synthi-oauth-relay*` aliases served to older beta links. Chromium MV3 today; Firefox possible via the same WebExtensions concepts but untargeted.

---

## 9. Port & env quick reference (supporting services only)

| Service | Container port | Host port (compose) | Defining env |
|---|---|---|---|
| y-sweet | 8080 | `${YSWEET_HOST_PORT:-8180}` | `Y_SWEET_AUTH_KEY=dev-secret` |
| signaling-server | 9000 | `${SIGNALING_HOST_PORT:-9000}` | `SIGNALING_PORT`, `REDIS_URL`, `COLLAB_SERVER_URL`, `SYNTHI_AGENT_TOKEN_SECRET`, `SYNTHI_TURN_*` |
| worker | — | — | `SIGNALING_URL`, `COLLAB_SERVER_URL`, `AI_BACKEND_URL`, `SYNTHI_REPOS_PATH`, `WORKER_CARGO_FEATURES`, `SYNTHI_GPU_HMR` |
| ai-gateway | 7070 | `${AI_GATEWAY_HOST_PORT:-7071}` | `GATEWAY_PORT`, `GATEWAY_WS_PATH`, `BACKEND_URL`, `GATEWAY_CLUSTER`, `GATEWAY_AUTH_DISABLED`, `GATEWAY_AUTH_ALLOW_INSECURE_LOCAL`, `AI_BACKEND_AUTH_TOKEN`/`GATEWAY_JWT_SECRET` |
| agent-runner-image | — | — (exit-stub) | build args `CODEX_VERSION`, `CLAUDE_CODE_VERSION`, `HERMES_AGENT_VERSION` |
| mcp-hub (library) | — | — | `SYNTHI_MCP_CALL_TIMEOUT_MS`, `SYNTHI_MCP_SSRF_ALLOWLIST` |
| programs-mcp (stdio) | — | — | `VECTANT_MANIFEST_GENERATE_URL/_TOKEN/_TOKEN_HEADER` (generation only) |
| oauth-relay extension | — | — | none (armed sessions come from page messages; endpoint fixed to Vectant origin) |

## 10. Observations / gotchas

- **Root-context builds are load-bearing**: both `synthi/Dockerfile` and `mcp/synthi-mcp/Dockerfile*` exist *because* `@synthi/mcp-hub` is a workspace sibling — narrow contexts 404 on `npm ci`.
- **The orchestrator is imported by relative path**, not by package name (`../../../../packages/atomic-orchestrator/src/index.js`) — moving the package requires touching synthi's agent-routing libs; `mcp/synthi-mcp` chose contract-mirroring in TS to avoid the coupling.
- **Advisory vs authoritative split** repeats deliberately: programs-mcp validation/hostEscape and mcp-hub's ssrfGuard pre-checks mirror server-side gates but never replace them (publish-time parser, publish-time review, guardedFetch per-hop checks).
- **Signaling legacy mode** (`__legacy__` session) is what makes the base compose stack usable with a single unconfigured worker; the eviction/fan-out logic is written so real multi-peer sessions degrade gracefully to it.
- **Gateway auth is fail-open only locally by construction**: `GATEWAY_AUTH_DISABLED` additionally requires non-production or explicit insecure-local opt-in, so copying compose settings to prod silently re-enables token/JWT checks.
- **Agent-runner credentials never touch the control plane**: entrypoint copies from a read-only volume into tmpfs; ai-engine raises if image/network/credentials-volume aren't all configured (fail-closed).

---

## Related notes

[[Collab Server]] · [[Synthi Frontend]] · [[MCP Synthi]]

[[00 Home|🏠 Back to Home]]
