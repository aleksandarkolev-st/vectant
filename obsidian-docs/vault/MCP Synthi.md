---
tags: "typescript", "mcp", "agents"
system: MCP Synthi (Agent Tool Server)
source-repo: vectant-ade
generated: 2026-08-25
---

# MCP Synthi (Agent Tool Server)

> [!info] Provenance
> Deep-dive analysis generated from the live repository tree (`main` @ `ce74771af`, 2026-08-25).
> Raw source: `docs/obsidian-src/mcp-synthi.md` in the repo. All paths below are repo-relative unless noted.

**synthi-mcp — MCP Server Analysis**

> Source: `mcp/synthi-mcp/` in `vectant-ade`. TypeScript MCP server (`@synthi-inc/mcp-server` v0.1.0, ESM, Node ≥18) that lets AI coding agents **observe and drive a running Synthi preview session** over WebRTC, plus a large governed tool surface (browser workflows, Agent Dojo competencies, CodeSite control plane, GPU HMR proof). Package metadata: `mcp/synthi-mcp/package.json:L2-L10`.

---

## 1. Server bootstrap + transports (stdio / HTTP)

### Entry points
- **stdio** (`bin: synthi-mcp` → `src/index.ts`): the default agent-facing transport.
  1. Loads a local `.env` *before any module reads `process.env`* via a zero-dependency dotenv loader (`--env-file=` arg → `SYNTHI_ENV_FILE` → package-root `.env`; host-provided env always wins) — `mcp/synthi-mcp/src/index.ts:L8`, `mcp/synthi-mcp/src/util/env.ts:L1-L30`.
  2. Defaults `SYNTHI_VISION_BACKEND=agent_side`; hard-fails at boot if `gemini_api` is selected without `GEMINI_API_KEY`/`GOOGLE_API_KEY` (`mcp/synthi-mcp/src/index.ts:L10-L22`).
  3. Parses `--session`/`--session-id` and `--signaling-url` CLI args; falls back to `SYNTHI_SESSION_ID` / `SYNTHI_SIGNALING_URL` / default `ws://localhost:9000` (`mcp/synthi-mcp/src/index.ts:L50-L83`).
  4. Optional side-servers: Prometheus `/metrics` (opt-in `SYNTHI_PROMETHEUS_PORT`, binds 127.0.0.1 unless `SYNTHI_PROMETHEUS_HOST`) at `mcp/synthi-mcp/src/index.ts:L112-L120`; operator bridge (`SYNTHI_OPERATOR_BRIDGE_PORT`, token mandatory) at `L126-L135`; browser workflow bridge (`SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT`) at `L141-L155`.
  5. File-backed snapshot persistor when `SYNTHI_SNAPSHOT_DIR` is set (`L87-L91`). External MCP tools resolved once at startup from `SYNTHI_API_URL` + `SYNTHI_PAT` (`L95-L98`).
  6. SIGINT/SIGTERM → `performShutdown()` (requestRegistry, session, server, metric servers) then `process.exit(0)` (`mcp/synthi-mcp/src/index.ts:L157-L175`, `mcp/synthi-mcp/src/shutdown.ts:L1-L111`); finally `server.connect(new StdioServerTransport())` (`L177`).

- **HTTP streamable** (`bin: synthi-mcp-http` → `src/http.ts`): raw `node:http` server wrapping MCP SDK `StreamableHTTPServerTransport`.
  - Config resolution: host/port/path/health-path/max-body-bytes/bearer-token/bearer-header from args or env (`SYNTHI_MCP_HTTP_*`, defaults `127.0.0.1:9467/mcp`, body cap 1 MiB) — `mcp/synthi-mcp/src/http.ts:L153-L230`.
  - **Security invariant**: a bearer token is *required* for non-loopback hosts (`synthi_mcp_http_bearer_token_required_for_non_loopback_host`) — `mcp/synthi-mcp/src/http.ts:L213-L215`. Auth compares tokens with `timingSafeEqual` (`L291-L295`).
  - Session model per HTTP connection: each MCP `initialize` creates a fresh `createSynthiServer()` + transport keyed by a random UUID `mcp-session-id`; requests carrying an existing id are routed to that session; unknown ids get `400 mcp_http_valid_session_required` (`mcp/synthi-mcp/src/http.ts:L486-L508`, `L665-L686`).
  - Extra routes: `GET /healthz`; optional "therapeutic production" endpoints (runtime authorization context, Postgres-backed runtime-state store append/get, incident-response probe proxy to an HTTPS upstream) gated behind `SYNTHI_THERAPEUTIC_PROD_ENDPOINTS_ENABLED=1` + dedicated bearer tokens + tenant scope headers `x-synthi-tenant-id`/`x-synthi-workspace-id`/`x-synthi-actor-id`, with production-identifier validation rejecting test/demo/local values (`mcp/synthi-mcp/src/http.ts:L160-L247`, `L338-L377`, `L542-L644`). Postgres migrations applied on boot when enabled (`L464-L473`).

### Server construction
`createSynthiServer(options)` builds one MCP `Server` named `synthi-mcp/0.1.0` with instructions = `SYNTHI_ATOMIC_AGENT_INSTRUCTIONS` and capabilities `{tools:{listChanged:true}, resources:{subscribe:true}}` (`mcp/synthi-mcp/src/server.ts:L1175-L1215`). Handlers registered for ListTools, ListResources, ReadResource, Subscribe/Unsubscribe, CallTool.

## 2. Tool registry + dispatch pipeline

- **Static definitions**: `STATIC_TOOL_DEFINITIONS` in `server.ts` carries name+description+inputSchema for every core tool (route_atomic_task, attach/detach/reconnect/health, screenshot, wait_hmr, compile, click/type/mouse/keyboard, wait, verify, locate, describe, input leases, escape hatch, enriched tier, audio stubs, snapshot/restore) — `mcp/synthi-mcp/src/server.ts:L101-L1173`.
- **Dynamic groups merged into ListTools**: `BROWSER_TOOLS`, `DOJO_TOOLS`, `AUTH_TOOLS`, `SOURCE_TOOLS`, `SAFETY_TOOLS`, `PROGRAM_TOOLS`, `JUPYTER_TOOLS`, `FAILURE_DISTILLER_TOOLS`, `CODESITE_TOOLS` (`mcp/synthi-mcp/src/server.ts:L120-L128`), plus browser *private workflow tools* published at runtime and external proxied tools advertised as `ext_<i>` (`mcp/synthi-mcp/src/server.ts:L1233-L1247`). Private-tool list changes emit `notifications/tools/list_changed` (`L1224-L1231`).
- **Canonical names list**: `ADVERTISED_TOOLS` (275 names: 43 browser-runtime, 69 dojo, plus auth/source/safety/failure-distiller/program/jupyter/CodeSite ATC and the core lifecycle/observation/input groups) is the single source of truth consumed by both ListTools and the capability manifest — `mcp/synthi-mcp/src/tool_registry.ts:L12-L314`.
- **Dispatch order** (`CallToolRequestSchema` handler): quota gate → external `ext_<i>` proxy → group dispatchers (`dispatchBrowserTool`, `dispatchDojoTool`, `dispatchAuthTool`, `dispatchSourceTool`, `dispatchSafetyTool`, `dispatchProgramTool`, `dispatchJupyterTool`, `dispatchFailureDistillerTool`, `dispatchCodeSiteTool`) → static handler table → `unknown_tool`. Every outcome is recorded to Prometheus via `recordToolCall` — `mcp/synthi-mcp/src/server.ts:L1309-L1445`.
- **Resources**: subscribable URIs `synthi://preview/{screenshot,hmr,console,events,state,source}` + phase-3 `synthi://snapshots/list` and `synthi://escape-hatch/queue`; event appends fan out to subscribers with screenshot pushes rate-limited to ≤2 Hz — `mcp/synthi-mcp/src/server.ts:L1252-L1307`, `mcp/synthi-mcp/src/resources/registry.ts:L16-L31`.
- **Capability manifest**: `buildManifest(ADVERTISED_TOOLS)` returned by `synthi_attach` advertises tools, vision backends, wait conditions, frame-seq gate state, region-pHash cache params, arbitration enforcement mode; protocol version negotiation fails fast with `unsupported_protocol` + `server_supports[]` (`PROTOCOL_VERSION = 1`) — `mcp/synthi-mcp/src/protocol/manifest.ts:L25-L27`, `mcp/synthi-mcp/src/tools/attach.ts:L80-L150`.

### Metadata catalog + atomic task router
- `tool_metadata_catalog.ts` derives schema-free routing facets (`routingTerms`, `groups`, `keywords`, origin `advertised|dynamic|both`) from `ADVERTISED_TOOLS`; it never participates in registration or dispatch — `mcp/synthi-mcp/src/tool_metadata_catalog.ts:L1-L74`.
- `atomic_skill_catalog.ts` is a frozen metadata-only index of 8 Vectant skills (runtime, browser, codesite, agent-dojo, source-identity, safety, validation, jupyter): id/name/description/groups/keywords only, never skill bodies — `mcp/synthi-mcp/src/atomic_skill_catalog.ts:L7-L72`.
- `atomic_task_router.ts` implements the planning boundary: roles `implementation|debugging|infrastructure|data|security|research|validation`; risk low→critical; fast-path detection; tool selection capped at `maxTools` (default 3), skill selection capped at `maxSkills` (default 3); returns a `vectant.atomic-task-route/v1` route with role, selected skills/tools (metadata only, no schemas), independent-validation decision, reason, and a full trace (stages: atomic-task, fast-path, tool-selection, skill-selection, role-selection, validation-decision, execution-context) — `mcp/synthi-mcp/src/atomic_task_router.ts:L20-L151`, `L568-L662`.
- The MCP exposes it as `synthi_route_atomic_task`; the route merges static + private-workflow + external dynamic entries into the catalog per call, then converts to an orchestrator-compatible shape — `mcp/synthi-mcp/src/server.ts:L82-L88`, `L1179-L1201`, `L1345-L1351`.

## 3. Session model

One attached session per MCP process (`SessionManager` singleton exported as `session`).

- Local state machine `detached | attaching | attached | closed`, deliberately distinct from the wire-level `SessionState` reported in envelopes (`ready/running/warming/hibernated/migrating/crashed/terminated`) — `mcp/synthi-mcp/src/session.ts:L18-L23`, `L147-L164`.
- Attach flow (`doAttach`): open signaling WS registering as role `observer` (default) or `mcp-agent` (via `SYNTHI_MCP_ROLE`) with optional `SYNTHI_AGENT_TOKEN`; splice signaling-server-minted TURN credentials ahead of caller ICE servers; start werift `Peer`; await connected + three data channels (`build-log`, `terminal`, `compile`) under one timeout; grab the video track into a `FrameSink` — `mcp/synthi-mcp/src/session.ts:L452-L574`.
- Build-log tap normalizes worker messages into typed handlers: `run-gui-start`/`frame-advance` (producer viewport + gate), `lifecycle` (+ warming progress), `security` (allow-listed codes), `frame-timing` snapshots, `human-action` attribution, `guest-registered`, `input-ack` (resolves DispatchAckRegistry), `input-lease-result` (lease events), compile-start/applied windows for the structural-change pHash gate and input-queue-depth histogram, terminal-only HMR events, and injection pre-scans of free-text fields — `mcp/synthi-mcp/src/session.ts:L577-L897`.
- Frame-advance gate (§4.4): tracks latest `{frame_seq, ts_ms}`; freshness window 10 s disables the gate rather than blocking forever; `awaitFrameAdvanceAtOrAfter()` stalls HMR resolution until a post-reload frame exists — `mcp/synthi-mcp/src/session.ts:L90-L94`, `L300-L363`.
- One-time **frame-gate tokens** (`frame-gate:<uuid>`, TTL 20 min, session/frame-seq/timestamp-bound, single-consume) let `synthi_screenshot({after_frame_gate})` prove the capture happened after the waited-for change — `mcp/synthi-mcp/src/session.ts:L75-L94`, `L365-L419`; schema at `mcp/synthi-mcp/src/server.ts:L187-L204`.
- Presence counts come from signaling `presence` broadcasts (default `{humans:0, agents:1}`); disruption/crash info is ack-gated via `markDisruption`/`clearDisruption` — `mcp/synthi-mcp/src/session.ts:L182-L287`.
- Close deterministically cancels pending escape-hatch entries (`escape_hatch_canceled`), disposes channels, stops frames, closes peer + signaling — `mcp/synthi-mcp/src/session.ts:L917-L958`.

## 4. Channels, signaling, peer & wire protocol

### Signaling (`SignalingClient`)
Thin `ws` wrapper over the Rust signaling-server protocol: `→ register {role, session_id, client_version?, supported_protocols?, agent_token?}`, `← registered {peer_id, turn_credentials?, agent_subject?}`, `↔ offer/answer/candidate`, plus `register-error` and `presence` broadcasts — `mcp/synthi-mcp/src/signaling.ts:L51-L59`, `L140-L231`. Roles: `browser | worker | observer | mcp-agent` (`L3`). TURN creds minted per-register (Phase 4) are exposed via `turn()` (`L10-L19`, `L92-L94`); scoped HS256 agent tokens bind {subject, session_id, role, expiry} so stolen tokens can't be replayed cross-session (`L39-L46`).

### Peer (WebRTC)
werift-based `RTCPeerConnection` (with `useVP8`/`useOPUS`): MCP registers as `observer`, adds recvonly transceivers, **creates** `terminal` + `compile` data channels before the offer, receives the worker-created `build-log` channel via `onDataChannel`, and receives the video track which `FrameSink` decodes by piping VP8 RTP payloads into an IVF file read by a bundled ffmpeg subprocess (`@ffmpeg-installer/ffmpeg`) that emits PNG frames. ICE transport policy defaults to relay-only when TURN URLs are present (avoids flaky host↔host candidate pairs), override `SYNTHI_MCP_ICE_POLICY=all|relay` — `mcp/synthi-mcp/src/peer.ts:L40-L119`, decode path `mcp/synthi-mcp/src/frames.ts:L1-L7` and `L103-L107`.

### Channels
`SessionChannels` wraps the three DCs: `sendInput()` emits `{type:"gui-event", sessionId, event:<mouse|key>}` frames on `terminal` (X11 button codes 1/2/3; verified against frontend + Rust parser) — wrapper at `mcp/synthi-mcp/src/channels.ts:L68-L96`, frame format at `mcp/synthi-mcp/src/wire/input.ts:L11-L20`. `requestInputLease()` does request/response correlation (`input-lease` → `input-lease-result` by `request_id`, 4 s timeout) — `mcp/synthi-mcp/src/channels.ts:L98-L123`. `sendCompileRequest()` sends CompileRequest JSON on `compile`, auto-chunking oversized payloads as base64 `compile-request-chunk` frames sized against `SYNTHI_MCP_COMPILE_CHUNK_BYTES` (default 48 KB) — `mcp/synthi-mcp/src/channels.ts:L125-L163`.

### HMR normalization
`HmrNormalizer` parses four wire families from build-log and resolves on the first terminal event: CandidateNotification (`Promoted|RolledBack|Discarded`), bare HmrStatus (`applied|rejected|compile-error|...`), rollback notifications, and compile diagnostics (terminal only when `error_count > 0`); structured-JSON chunk reassembly supported — `mcp/synthi-mcp/src/hmr.ts:L12-L70`. Terminal statuses surfaced to tools: `applied | rejected | compile-error | full-reload-required | discarded | timeout`.

## 5. Broker (`broker/`, ~3.7 kLoC)

Broker-mediated correctness layer between tools and the session ("agent client → Synthi MCP → broker → hosted browser/runtime" per README):
- Contracts: `BROKER_PROTOCOL_VERSION`, envelope validation, frame events, health/lifecycle payloads — `mcp/synthi-mcp/src/broker/index.ts:L1-L15`.
- Errors: canonical `BROKER_ERROR_CODES` with categories + legacy mapping (`L17-L26`).
- Idempotency store (payload-hash keyed, TTL'd) for safe retries (`L28-L34`).
- Replay: queryable action timeline with short/long retention policies + persistence path (`L36-L50`).
- Read-only health/lifecycle observation + frame observations (`L52-L55`).
- **Input gate**: modes `shadow` (default; log only) vs `enforce` (`SYNTHI_BROKER_INPUT_MODE=enforce`) requiring `lease_id` + fresh `based_on_frame_seq` (+ optional viewport/DPR match within epsilon); integrates fallback controller, rollout controller, and shared lease registry — `mcp/synthi-mcp/src/broker/input_gate.ts:L33-L100`.
- Auth: bearer-token principals with roles `read_only | input_control | admin` mapped through an explicit capability matrix (`subscribe_frames`/`subscribe_logs` for all roles; `acquire_lease`/`renew_own_lease`/`dispatch_input`/`replay_logs` need input_control+; `force_release_lease` admin-only), plus principal keys (`L63-L73`). Subscriptions registry with resume support (`L74-L82`). Control-plane API (`L83`), recovery incidents/runtime (`L84`).
- Producer fence registry (single-producer attach grants) (`L85-L90`), fallback controller (`L92-L97`), postcondition verification (`L98-L100`), SLO definitions, worker pool sizing (`SYNTHI_BROKER_WORKER_POOL_SIZE`/`_QUEUE_SIZE`).

## 6. Security guards

- **Non-local signaling guard**: `classifySignalingUrl()` treats only localhost/loopback/RFC1918/link-local/docker-bridge as local; non-local attach requires explicit `"i-understand-no-auth": true` and then flips `unsafe_mode` (security event `unsafe_attach`, surfaced in manifest + health) — `mcp/synthi-mcp/src/security/signaling_url.ts:L13-L35`, `mcp/synthi-mcp/src/tools/attach.ts:L110-L145`, `mcp/synthi-mcp/src/session.ts:L261-L268`.
- **Injection heuristics**: regex pre-screen of any free text arriving via build-log/console/log-waits (ignore-previous-instructions, `<system>` tags, jailbreak preambles, role overrides, sandbox escapes) → `security/injection_suspected` events; detection-only in phase 1 — `mcp/synthi-mcp/src/security/injection.ts:L11-L44`, tap at `mcp/synthi-mcp/src/session.ts:L884-L896`.
- **Quota gate** (phase 2d): before every dispatch; modes off/warn/enforce; rolling caps vision-cost USD/hr (default $5), tool calls/min (120), screenshots/min (30); breach returns `quota_exceeded` without executing — `mcp/synthi-mcp/src/observability/quota.ts:L1-L60`, gate at `mcp/synthi-mcp/src/server.ts:L1413-L1428`.
- **Structural-change pHash gate**: baseline captured at compile-start, compared on `applied`/`Promoted`; detection-only security events today — `mcp/synthi-mcp/src/session.ts:L803-L868`; **input queue depth** windowing across compile cycles feeds the same correctness story.
- **Arbitration leases**: D0 input leases, owner derived server-side, 15 s max lease, 60 s continuous-ownership ceiling, fairness starvation window, `advisory` vs `single-holder` modes (`SYNTHI_LEASE_MODE`), urgent-human-override priority, force-release requires signed broker token — `mcp/synthi-mcp/src/arbitration/lease.ts:L113-L124`, tool schemas `mcp/synthi-mcp/src/server.ts:L781-L852`.
- **Anomaly detection**: `security/anomaly.ts` complements injection scanning.
- HTTP bearer auth w/ timing-safe compare + loopback-only no-auth posture: `mcp/synthi-mcp/src/http.ts:L213-L215`, `L282-L295`.

## 7. Dojo tools

`DOJO_TOOLS` = 69 licensed competency tools (`synthi_dojo_list_competencies`, `get_skill*`, `wind_tunnel`, `evil_twin`, `checkride`, `vivarium`, `case_law`, governance, license lifecycle, proof capsules, time-machine debugger, ghost mode, source drift/affordance PRs, API-backed tool compilation, hosted runtime sessions, therapeutic tomography suite) — full list at `mcp/synthi-mcp/src/tool_registry.ts:L59-L129`. Implementation spans:
- `src/browser/dojo.ts` + `dojo_universe.ts`: skill building/registry, proof capsule issue/validate (`issueDojoProofCapsule` at `L1382`, `validateDojoProofCapsule` at `L1437`), checkrides, vivarium scenario generation.
- `src/dojo/*` subdomains: license kernel + execution policy gate + skill bus (`license/kernel.ts`, `mcp/skill_bus.ts`), evidence ledger (claims/redaction/export/retention + Postgres stores), graph compiler/runtime/substrate-executor, case-law registry/guardrails/antibodies, checkride entrustment/readiness, regret arbiter + counterfactual runs, vivarium DSL/fixtures/oracle/runner, tomography, governance service, hosted-runtime gateway. All re-exported as public subpath exports in `package.json:L22-L217`.
- Proof signing can be delegated to an external command / managed key (`SYNTHI_DOJO_PROOF_SIGNING_*`); durable stores enforceable (`SYNTHI_DOJO_REQUIRE_DURABLE_STORE`, `_EVIDENCE_LEDGER`, `_EXTERNAL_SIGNING`); Postgres control plane via `SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL`.
- Dispatch entrypoint `dispatchDojoTool` wired first in the tool chain after browser tools — `mcp/synthi-mcp/src/server.ts:L69`, `L1317-L1318`.

## 8. GPU proof ledger + HMR tools

- **Proof ladder**: nine ordered states `gpu-hmr-compile-proven → symbol-bound → abi-proven → epoch-swap-proven → dispatch-observed → dispatch-safe-proven → output-oracle-proven → host-preservation-proven → full-runtime-proven`, plus 13 degraded states (fake-launch-path, visual-only, ram-io-unavailable…) that cap effective rank — `mcp/synthi-mcp/src/gpu_proof.ts:L6-L34`. `validateGpuHmrProofState` compares required vs observed rank incl. degraded caps and runtime-proof-artifact gates.
- **Ledger validator**: `gpu_proof_ledger.ts` (schema `synthi.gpu.hmr.proof_ledger.v1`) validates embedded ledger invariants: project/artifact kinds, monotonic clocks, cold/warm/hot scopes, cache states, required Gemini model availability provenance per role (split=`gemini-3.5-flash`, gpu_delta=`gemini-3.1-flash-lite`), convergence metrics, compute readback sources, supported backends (hip/hiprt/opencl/vulkan/webgpu/bevy_wgsl/cuda/sycl), ~15 required timing fields, compute + visual oracle artifact fields (blank/same-frame rejection, epoch watermark, camera-state hash, perceptual diff) — `mcp/synthi-mcp/src/gpu_proof_ledger.ts:L3-L121`, queries at `L1478`, embedding extraction at `L1544`.
- **wait_hmr integration**: `synthi_wait_hmr` blocks on terminal HMR (default timeout 20 min) with optional `module` filter and `since_ts` anchor; `requiredGpuProofState` / `requireGpuFullRuntimeProof` make the tool return `gpu_hmr_proof_insufficient` instead of treating plain `applied` as correct, exposing raw `gpu_proof_telemetry`; satisfied waits mint the one-time `gate_token` consumed by screenshots — `mcp/synthi-mcp/src/server.ts:L209-L254`, implementation `mcp/synthi-mcp/src/tools/wait_hmr.ts:L32-L49`.
- **compile flags** feed the same machinery: `use_ai_split`, `force_gpu_ai_delta`, `gpu_mode auto|disabled`, `gpu_arch`, prefer_gpu_pipeline — `mcp/synthi-mcp/src/server.ts:L256-L377`.

## 9. Browser workflow bridge

- **In-process HTTP bridge** (`browser_workflow_bridge/server.ts`, ~1.9 kLoC): lets the workspace IDE panel call the same workflow tools over localhost instead of stdio. Endpoints: `GET /healthz`, `GET /browser-workflows/state` (panel-safe state, no screenshots), `POST /browser-workflows/open-external` (open URL in hosted browser, no inspection), `POST /browser-workflows/tool` ({tool, arguments} dispatched through the existing MCP handlers) — header docs `mcp/synthi-mcp/src/browser_workflow_bridge/server.ts:L1-L21`. Token via `x-synthi-workflow-token`; no-token mode restricted to loopback (`L23-L31`, enforced in resolve/start logic). Standalone entrypoint `browser_workflow_bridge/standalone.ts` (`npm run browser:workflow:bridge`).
- **Browser tool family** (`tools/browser.ts` + `browser/*`): teach-mode capture (`begin/end_teach`, traces, lane0 status), workflow cards → compile workflow → generate Playwright script → private-tool manifest generation/publication (`private_tool_registry` with list-changed notifications), consent management (`request/get/revoke_consent`), lease acquire/release, observe/snapshot/action/wait/console/network, project runner + deployment readiness, failure explanation. Hosted-browser path uses `hosted_runtime.ts` (`SYNTHI_HOSTED_BROWSER_CDP_URL` etc.); local CDP attach is an explicitly labeled developer harness — README posture quote at repo `mcp/synthi-mcp/README.md` ("product path: agent client -> Synthi MCP -> broker -> Synthi-hosted browser/runtime").
- Private workflow tools join ListTools dynamically and appear as `private-workflow` group entries in the atomic router's catalog — `mcp/synthi-mcp/src/server.ts:L1184-L1190`, `L1224-L1231`.

## 10. Observability & events

- **Event ring**: `EventLog` bounded ring (capacity 1024) assigning monotonic `seq`; producers push partials, consumers poll `query()` or subscribe `onAppend`; oldest dropped silently — `mcp/synthi-mcp/src/events/log.ts:L21-L70`. Event kinds: `lifecycle, hmr, input, browser, lease, frame, locator_resolution, console, error, security, source_state, usage` — `mcp/synthi-mcp/src/events/types.ts:L18-L105`.
- **Prometheus**: hand-rolled v0.0.4 text counters (no prom-client) with stable label invariants; `bindEventLogToMetrics(eventLog)` bridges ring → counters; opt-in HTTP server `/metrics` + `/healthz` on `resolvePrometheusPort(SYNTHI_PROMETHEUS_PORT)` — `mcp/synthi-mcp/src/observability/metrics.ts:L1-L45`, `observability/prometheus_server.ts`.
- **Usage accounting**: `synthi_get_usage` aggregates tool_call/screenshot/vision_inference/egress_bytes incl. vision cost estimate and hot-seconds since attach (`mcp/synthi-mcp/src/server.ts:L552-L556`); frame-timing snapshots recorded as usage events (`session.ts:L672-L698`).
- **Operator bridge** (phase 3): token-mandatory HTTP hop over the in-memory escape-hatch queue — list/drain `request_human` + `annotate_and_ask` pendings, SSE stream with heartbeats + idle TTL; CORS permissive but every non-OPTIONS gated on shared-secret header — `mcp/synthi-mcp/src/operator_bridge/server.ts:L1-L60`.
- Snapshots: `SnapshotStore` + memory/file persistors, ids `snap_<uuid>`, replayable through `synthi_restore` — `mcp/synthi-mcp/src/snapshot/index.ts:L31-L243`.

## 11. Logical dependencies

### Talks to (outbound)
| Service | Purpose | Reference |
|---|---|---|
| Signaling server (`ws://…:9000`, Rust `synthi-webrtc-compiler/signaling-server`) | register/presence/SDP relay, TURN minting, agent-token verification | `mcp/synthi-mcp/src/signaling.ts:L51-L59` |
| Worker peer (Rust compiler worker) | WebRTC media + `build-log`/`terminal`/`compile` DCs (HMR, input, CompileRequest) | `mcp/synthi-mcp/src/channels.ts:L68-L82`, `mcp/synthi-mcp/src/wire/input.ts:L4-L9` |
| Anthropic API | `claude_api` vision backend for locate/describe (`ANTHROPIC_API_KEY`, `@anthropic-ai/sdk`) | `mcp/synthi-mcp/src/locate/backends.ts:L110` (`ClaudeApiBackend`), `mcp/synthi-mcp/src/locate/claude_api.ts:L1-L8` |
| Google Gemini API | `gemini_api` backend (`GEMINI_API_KEY`/`GOOGLE_API_KEY`, `@google/genai`) | `mcp/synthi-mcp/src/locate/backends.ts:L153` (`GeminiApiBackend`) |
| Self-hosted vision endpoint | `local` backend (`SYNTHI_LOCAL_VISION_URL`, phase 3) | `mcp/synthi-mcp/src/locate/local.ts` |
| Synthi app API (`SYNTHI_API_URL` + `SYNTHI_PAT`) | external MCP tool resolution (`/api/integrations/mcp/resolve`) + audit posting | `mcp/synthi-mcp/src/external/index.ts:L41-L58` |
| External MCP servers via `@synthi/mcp-hub` (`packages/mcp-hub`) | proxied `ext_<i>` tools (listTools/callTool) | `mcp/synthi-mcp/src/external/index.ts:L1-L10` |
| CodeSite API (`SYNTHI_CODESITE_API_BASE_URL`) | ATC control-plane REST calls | `mcp/synthi-mcp/src/tools/codesite.ts:L762-L1398` |
| Postgres (optional) | Dojo control plane/evidence ledger + therapeutic production runtime state | `mcp/synthi-mcp/src/http.ts:L464-L473`, `dojo/store/postgres_proof_store.ts` |
| Hosted browser runtime (CDP) | browser workflow teaching/replay (`SYNTHI_HOSTED_BROWSER_CDP_URL`, dev-harness `SYNTHI_BROWSER_CDP_URL`) | `mcp/synthi-mcp/src/browser/hosted_runtime.ts` |

### Talked to by (inbound)
- **Agent hosts** (Claude Code/Codex/Cursor/any MCP client) over stdio, or HTTP clients over Streamable-HTTP with bearer auth — `mcp/synthi-mcp/src/index.ts:L106/L177`, `mcp/synthi-mcp/src/http.ts:L655-L686`.
- **Workspace IDE panel** via the browser-workflow HTTP bridge — `mcp/synthi-mcp/src/browser_workflow_bridge/server.ts:L1-L21`.
- **Human operators** via the operator bridge UI (queue drain + SSE) and `synthi_answer_escape_hatch` — `mcp/synthi-mcp/src/operator_bridge/server.ts:L17-L25`.
- **Prometheus scraper** on the metrics port — `mcp/synthi-mcp/src/index.ts:L108-L120`.
- **Incident-response/probe callers** against therapeutic production endpoints — `mcp/synthi-mcp/src/http.ts:L609-L644`.

## 12. Environment variables (grouped)

Bootstrap/connectivity: `SYNTHI_SESSION_ID`, `SYNTHI_SIGNALING_URL` (default `ws://localhost:9000`), `SYNTHI_ENV_FILE`, `SYNTHI_MCP_ROLE` (`observer`|`mcp-agent`), `SYNTHI_AGENT_TOKEN`, `SYNTHI_AGENT_ID`/`SYNTHI_AGENT_SUBJECT`, STUN/TURN (`SYNTHI_STUN_URL`, `SYNTHI_TURN_URL/USERNAME/CREDENTIAL`).

HTTP transport: `SYNTHI_MCP_HTTP_HOST/PORT/PATH/HEALTH_PATH/MAX_BODY_BYTES/BEARER_TOKEN/BEARER_HEADER`, plus `SYNTHI_DOJO_MCP_BEARER_TOKEN` fallback.

Vision: `SYNTHI_VISION_BACKEND` (`agent_side|claude_api|gemini_api|local|mock`), `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `SYNTHI_VISION_MODEL`, `SYNTHI_GEMINI_MODEL`, `SYNTHI_LOCAL_VISION_URL`, `SYNTHI_ALLOW_THIRD_PARTY_INFERENCE`.

Observability/quota: `SYNTHI_PROMETHEUS_PORT/HOST`, `SYNTHI_QUOTA_MODE`, `SYNTHI_QUOTA_TOOL_CALLS_PER_MIN`, `SYNTHI_QUOTA_SCREENSHOTS_PER_MIN`, `SYNTHI_QUOTA_VISION_COST_USD_PER_HR`, `SYNTHI_PIPELINE_BUDGET_MS`, `SYNTHI_MCP_HMR_POST_APPLY_OBSERVE_MS`, `SYNTHI_OPERATOR_BRIDGE_PORT/HOST/TOKEN`, `SYNTHI_OPERATOR_SSE_IDLE_TTL_MS`.

Arbitration/broker: `SYNTHI_LEASE_MODE`, `SYNTHI_BROKER_INPUT_MODE` (`shadow|enforce`), `SYNTHI_BROKER_AUTH_SECRET/ISSUER/AUDIENCE`, `SYNTHI_BROKER_WORKER_POOL_SIZE`, `SYNTHI_BROKER_WORKER_QUEUE_SIZE`, `SYNTHI_BROKER_REPLAY_SHORT_MS/LONG_MS/PERSIST_PATH`, `SYNTHI_MCP_COMPILE_CHUNK_BYTES`.

Snapshots/external/private tools: `SYNTHI_SNAPSHOT_DIR`, `SYNTHI_API_URL`, `SYNTHI_PAT`, `SYNTHI_APP_URL`, `SYNTHI_COLLAB_BASE_URL/SERVER_URL`, `SYNTHI_MCP_MAX_TOOLS_PER_CONN`, `SYNTHI_MCP_LISTTOOLS_CONCURRENCY`, `SYNTHI_MCP_EXTCALL_LIMIT`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE/STORE_FILE/STORE_KEY`, `SYNTHI_AUTH_CHECKPOINT_SCOPE/STORE_FILE/STORE_KEY`, `SYNTHI_AUTH_REFRESH_PROVIDER_COMMAND_CONFIG`.

Browser/workflows: `SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT/HOST/TOKEN/URL`, `SYNTHI_BROWSER_EXTERNAL_OPEN_TIMEOUT_MS/BODY_LIMIT_BYTES`, `SYNTHI_BROWSER_PREVIEW_ALLOWED_ORIGINS/_HOST_SUFFIXES`, `SYNTHI_WORKSPACE_ID/URL/SLUG/PREVIEW_URL`, `SYNTHI_WORKFLOW_RUNTIME_SCOPE/PREVIEW_PORTS/CI_ARTIFACT_DIR`, hosted/dev harness (`SYNTHI_HOSTED_BROWSER_*`, `SYNTHI_BROWSER_BRIDGE_*`, `SYNTHI_BROWSER_CDP_URL/CONNECT_TIMEOUT_MS`).

Dojo/proofs/tenancy: `SYNTHI_DOJO_STORE_FILE/KEY/SCOPE`, `SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL`, `SYNTHI_DOJO_CONTROL_PLANE_STORE`, `SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL/STORE`, `SYNTHI_DOJO_REQUIRE_DURABLE_STORE/EVIDENCE_LEDGER/EXTERNAL_SIGNING`, `SYNTHI_DOJO_PROOF_ISSUER`, `SYNTHI_DOJO_PROOF_SIGNING_PROVIDER/COMMAND/COMMAND_ARGS/KEY/KEY_ID/PRIVATE_KEY_PEM/PUBLIC_KEY_PEM/MANAGED_KEY_URI`, `SYNTHI_DOJO_MCP_MANIFEST_*`, `SYNTHI_DOJO_PRODUCTION_ENFORCEMENT`, `SYNTHI_DOJO_THERAPEUTIC_STORE_DIR`, tenant trio `SYNTHI_TENANT_ID`/`SYNTHI_ORGANIZATION_ID`/`SYNTHI_ACTOR_ID`.

Therapeutic production HTTP: `SYNTHI_THERAPEUTIC_PROD_ENDPOINTS_ENABLED`, `..._RUNTIME_AUTH_CONTEXT_PATH/_RUNTIME_AUTH_TOKEN/_RUNTIME_SESSION_ID`, `..._TENANT_ID/_ORGANIZATION_ID/_WORKSPACE_ID/_ACTOR_ID/_ACTOR_ROLES`, `..._STORE_PATH/_STORE_AUTH_TOKEN`, `..._PROBE_PATH/_PROBE_AUTH_TOKEN`, `..._POSTGRES_URL`, `..._PROBE_UPSTREAM_URL/_PROBE_UPSTREAM_AUTH_TOKEN` — `mcp/synthi-mcp/src/http.ts:L160-L186`.

CodeSite: `SYNTHI_CODESITE_API_BASE_URL/BASE_URL/TOKEN/COOKIE/PROJECT_ID/SESSION_ID/AGENT_SESSION_ID/AGENT_TOKEN/USER_ID/WORKSPACE`.

## 13. How agents connect

1. **Register with an MCP host** (stdio preferred): e.g. `claude mcp add synthi -- docker run -i --rm --network host -e SYNTHI_SESSION_ID=<id> -e SYNTHI_SIGNALING_URL=ws://localhost:9000 ghcr.io/synthi-inc/synthi-mcp:v0.1.0`, or `npx @synthi-inc/mcp-server` from GitHub Packages, or a source build (`npm run build && node dist/index.js`). Distribution channels documented at `mcp/synthi-mcp/README.md` (Install section).
2. On initialize the host gets the instruction preamble telling it to decompose work atomically and call `synthi_route_atomic_task` before each change, expose execution agents only routed tools/skills, and run an independent validator when the route demands it — `mcp/synthi-mcp/src/server.ts:L82-L88`.
3. `tools/list` returns the full surface (static + private workflow + external `ext_<i>`); the capability manifest arrives on attach.
4. `synthi_attach` (required before other session tools): resolves sessionId/signalingUrl (args > env > CLI > default), negotiates protocol version, refuses non-local signaling URLs without `i-understand-no-auth:true`, splices TURN creds (tool-arg ICE > `SYNTHI_STUN_URL`/`SYNTHI_TURN_URL+USERNAME+CREDENTIAL` env), attaches as observer/mcp-agent, and returns `{connected, resolution, sessionId, signalingUrl, protocol:{version, server_supports}, capabilities manifest, session:{id, state, state_ts, unsafe_mode, attached_humans, attached_agents, warming_progress?}}` — `mcp/synthi-mcp/src/tools/attach.ts:L66-L175`, manifest builder `mcp/synthi-mcp/src/protocol/manifest.ts:L241`.
5. Canonical loop (README): `synthi_report_source_state` (or auto via compile) → `synthi_compile` → `synthi_wait_hmr` / `synthi_wait{condition:"hmr"}` (optionally demanding a GPU proof state) → `synthi_screenshot` (optionally `after_frame_gate` consuming the one-time token) → `synthi_locate`/`synthi_mouse`/`synthi_keyboard`/`synthi_verify`/`synthi_describe` to act and check.
6. Broker-enforced input (`SYNTHI_BROKER_INPUT_MODE=enforce`) wraps mouse/keyboard/dispatch_input with `synthi_acquire_input` leases + `based_on_frame_seq` staleness checks; humans stay visible via presence counts, human-action events, and arbitration priority `urgent_human_override`.
7. Detach is clean and non-destructive: `synthi_detach` releases the MCP's handle without killing the preview, letting a human browser re-attach — `mcp/synthi-mcp/src/server.ts:L474-L479`.

### Known limitations (as coded)
- No authentication on the stdio/WebRTC path by design (local-dev posture; the `i-understand-no-auth` flag is acknowledgment, not security) — README warning + `mcp/synthi-mcp/src/security/signaling_url.ts:L1-L12`.
- Several tiers are deliberate wire stubs returning `*_not_implemented`: OCR/text wait, scene_matches verify, audio level/events, request_human/annotate_and_ask backends, enriched tier without providers — `mcp/synthi-mcp/src/server.ts:L712-L1029`.

---

## Related notes

[[Dojo Codesite Local Support]] · [[Collab Server]] · [[GPU HMR System]]

[[00 Home|🏠 Back to Home]]
