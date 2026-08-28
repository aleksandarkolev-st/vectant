---
tags: "mcp", "tools"
type: exhaustive-area-reference
source-repo: vectant-ade
generated: 2026-08-25
---

# Area - MCP Tool Catalog

> [!info] Exhaustive reference — every module/route/file in this area, with `path:LNN` citations. Raw source: `docs/obsidian-src/area-mcp-synthi.md`.

---
area: mcp-synthi-mcp
type: module-analysis
scope: mcp/synthi-mcp/src
generated: 2026-08-25
tool_count_advertised: 275
---

**Area: mcp/synthi-mcp**

Exhaustive per-module + tool-catalog analysis of `mcp/synthi-mcp/src/` (~40 top-level entries, ~120 files).

## 1. Overview

`@synthi-inc/mcp-server` v0.1.0 — the Model Context Protocol server that lets an AI agent see and drive a Synthi preview session over WebRTC, plus a large "browser workflow / Agent Dojo" governance stack.

- **Binaries** (`package.json`): `synthi-mcp` → `dist/index.js` (stdio transport), `synthi-mcp-http` → `dist/http.js` (Streamable HTTP transport). Dev scripts run `tsx src/index.ts`; `npm run browser:workflow:bridge` starts `browser_workflow_bridge/standalone.ts`.
- **Deps**: `@modelcontextprotocol/sdk`, `werift` (pure-TS WebRTC), `ws`, `playwright-core`, `sharp`, `pg`, `@anthropic-ai/sdk`, `@google/genai`, `@ffmpeg-installer/ffmpeg`, `@synthi/mcp-hub`.
- **Layering** (bottom→top):
  1. **Transport**: `wire/input.ts` encodes Xvfb GUI events; `signaling.ts` (WS register/offer/answer/candidate); `peer.ts` (werift RTCPeerConnection); `channels.ts` (data channels: terminal input, build-log/HMR, compile w/ chunking).
  2. **Session core**: `frames.ts` (video decode sink) → `session.ts` (MCP-local attach state machine, frame gates) → consumed by every tool.
  3. **Safety rails**: `arbitration/lease.ts`, `broker/*` (frame provenance, input gating), `correctness/*`, `security/*`, `observability/quota.ts`.
  4. **Tool surface**: `server.ts` dispatch → `tools/*` (single-purpose) + group dispatchers (`tools/browser.ts`, `tools/dojo.ts`, …) + dynamic private workflow tools (`synthi_app_*`) + external proxies (`ext_<n>`).
  5. **Feature stacks**: `browser/*` (teach→compile→replay workflows), `dojo/*` (17 packages of skill licensing/governance/vivarium), bridges (`operator_bridge/`, `browser_workflow_bridge/`), observability, resources.
- **Request flow** (`server.ts:1413` CallTool handler): quota gate (`enforceQuota`) → external-tool proxy check (`ext_\d+`) → `dispatchTool` (`server.ts:1309`): group dispatchers tried in order browser → dojo → auth → source → safety → programs → jupyter → failure-distiller → codesite, then a 45-key handler map for core session tools.
- **ListTools** (`server.ts`): `STATIC_TOOL_DEFINITIONS` (`server.ts:101`) + `browserPrivateWorkflowTools()` (dynamic) + `externalTools.descriptors` (`ext_<i>` proxies).

## 2. Tool Catalog

`tool_registry.ts:L12` exports `ADVERTISED_TOOLS` — **275 names**, the single source of truth consumed by both ListTools and `tools/attach.ts` capability manifest. Prefix census: `synthi_codesite_*` 70, `synthi_dojo_*` 69, `synthi_browser_*` 43, core/session singles ~45, `synthi_failure_*` 12, `synthi_safety_*` 8, `synthi_auth_*` 7, `synthi_jupyter_*` 7, `synthi_source_*` 5, programs 8 (`list/read/launch/exec/detect/run/stop/restart`), misc 1s.

### 2.1 Core session tools (static singles, dispatched via handler map in `server.ts:1309+`)

| Tool | Purpose / schema gist | Side effects | Touches |
|---|---|---|---|
| `synthi_route_atomic_task` | Metadata-only planner: `{description required, category?, keywords?, risk enum, validation enum}` → bounded role + skills + suggested tools (`atomic_task_router.ts`) | none | router only |
| `synthi_attach` | WebRTC attach: `{sessionId?, signalingUrl?, requested_protocol_version?, i-understand-no-auth?}`; returns manifest + envelope; evicts prior browser peer | opens WS + PC; ICE from `SYNTHI_STUN_URL`/`SYNTHI_TURN_*` | signaling, peer |
| `synthi_detach` / `synthi_reconnect` | Close DC→PC→WS / re-establish peer on same sessionId | tears down or rebuilds connection | session |
| `synthi_health` | Wire state, PC connectionState, DC readyStates, first-frame latency | none | session snapshot |
| `synthi_screenshot` | Latest frame as PNG; `{region,max_dim,freshness_max_ms,allow_unbrokered_frame,after_frame_gate{gate_token},frame_gate_timeout_ms}`; returns capture_manifest with hashes; usage event each call | reads frame; consumes one-time gate token | frames, broker frame cache |
| `synthi_wait_hmr` | Block until HMR terminal status (applied/rejected/compile-error/full-reload-required/discarded); `{timeoutMs def 20min, module?, since_ts?, preview_id?}`; returns reusable `frame_gate` incl. `gate_token` (`tools/wait_hmr.ts:388`) | subscribes build-log | hmr normalizer, gpu_proof |
| `synthi_wait` | Condition wait: `hmr|motion_settled|pixel|scene_change|text|log|element|source_state|audio` (`wait/engine.ts:27`) | samples frames/logs | frames, eventLog |
| `synthi_verify` | Predicate eval tree: `pixel|ocr|element_visible|log|scene_matches|and|or`, max depth/clauses bounded (`verify/engine.ts:19`) | read-only checks | frames, OCR |
| `synthi_compile` | Fire-and-forget CompileRequest on `compile` DC; chunked (`channels.ts:8`, default 48 kB chunks); HMR streams back on build-log | sends compile chunks | channels |
| `synthi_click` / `synthi_type` | Xvfb pixel click / key-sequence typing (500 keys/s cap) | injects input | wire/input |
| `synthi_mouse` | Playwright-style actions: click, double_click, move, down, up, drag, wheel; x/y or handle_id | injects input | wire/input, lease |
| `synthi_keyboard` | type / key / chord actions | injects input | wire/input, lease, anomaly detector |
| `synthi_locate` | NL description → `{bbox,handle_id,region_phash}`; backends `agent_side` (default) / `claude_api` / `gemini_api` / `local` / `mock`; cache + drift threshold (`locate/index.ts:236`) | vision API spend possible | locate engine |
| `synthi_describe` | mode `agent_side` returns screenshot for agent's own LLM; other modes use configured backend | vision inference | locate |
| `synthi_dispatch_input` | Broker-gated state-changing input; requires `lease_id` + fresh `based_on_frame_seq` when broker input mode=enforce | input under proof | broker/input_gate, arbitration |
| `synthi_acquire_input` / `renew_input` / `release_input` / `force_release_input` | D0 lease lifecycle; owner derived server-side; continuous-ownership + starvation fairness caps (`arbitration/lease.ts:114`) | lease registry mutations | arbitration/lease |
| `synthi_request_human` / `synthi_annotate_and_ask` | Escape hatch: enqueue question for operator; annotate variant asks for click point on screenshot | enqueues | escape_hatch/queue |
| `synthi_recent_human_actions` / `synthi_answer_escape_hatch` | Read observed human actions / drain queue item by pending_id | queue mutation (answer) | escape_hatch |
| `synthi_get_event_log` | Ring-buffer query: since_seq/since_ts/kind filter | none | events/log |
| `synthi_get_source_state` / `synthi_report_source_state` | Read summary / declare edited files (emits source_state event) | event append | events |
| `synthi_get_usage` | Counters: tool_call, screenshot, vision_inference (+cost), egress_bytes | none | metrics + events |
| `synthi_set_quality` | Request fps/bitrate/resolution changes (phase-1 intent-only) | event only | session |
| `synthi_checkpoint` | Write named label marker into event log | event append | events |
| `synthi_acknowledge_disruption` / `synthi_get_crash_info` / `synthi_reset_guest` | Clear crash-recovery/full-reload gate; read last crash metadata; request guest restart | gate clear | session |
| `synthi_snapshot` / `synthi_restore` / `synthi_list_snapshots` | Capture {source_state, frame, seq, wire state} / replay it / list; persistors memory or file (`snapshot/index.ts`) | store writes | snapshot store |
| Enriched tier: `synthi_query`, `synthi_act`, `synthi_click_text`, `synthi_fill_form`, `synthi_get_labels`, `synthi_get_process_state`, `synthi_get_metrics` | Semantic entity query/act over provider registry; without a provider all return `enriched_tier_not_available` (`enriched/provider.ts`) | provider-dependent | enriched provider |
| `synthi_get_audio_level` / `synthi_wait_audio_event` | Phase-2d stubs returning `audio_backend_not_implemented` (above_threshold / silence kinds) | none | — |

### 2.2 Browser workflow group — `tools/browser.ts` (43 advertised)

Dispatched by `dispatchBrowserTool`. Backed by `browser/broker.ts` (consent/lease/redaction authority) + Playwright adapter. Highlights (full names in `ADVERTISED_TOOLS`):

- **Runtime attach**: `attach_current_workspace` (primary cloud path, no user locator needed), `revoke_hosted_runtime_session`, `attach` (CDP to existing Chrome), hosted-runtime resolution via `SYNTHI_HOSTED_BROWSER_*` env.
- **Observation**: `observe` (broker-gated screenshot + bounded DOM after exact-origin consent), `observe_preview`, `snapshot`, `get_console`, `get_network` (redacted), `wait` (selector/url/load/networkidle/timeout).
- **Consent**: `request_consent` / `get_consent` / `revoke_consent` — exact-origin only; no scheme/host/subdomain/port crossing.
- **Tabs**: `list_tabs` (authorized only), `select_tab`, `open`, `close_tab`.
- **Teach mode**: `begin_teach`/`end_teach` (primary), `start_teach`/`stop_teach`, `answer_teach_question`, `get_trace`, `get_trace_status`, `get_lane0_status` (sliding-window reducer), `get_workflow_card`, `get_unresolved_steps`.
- **Teach→artifact pipeline**: `compile_workflow` (trace → workflow card + v7 contract), `generate_script` (Playwright code + locator confidence), `generate_private_tool_manifest`, `publish_private_tool`, `list_private_tools`, `get_private_tool_manifest`.
- **Auth checkpoints**: `capture_auth_checkpoint_storage` (cookies/localStorage/sessionStorage stored broker-side, values never returned).
- **Replay & control**: `run_workflow` (coldSession default; stops before first mutation boundary), `explain_failure`, `acquire_lease` / `release_lease`, `action` (broker-filtered, requires live lease + consent).
- **Dev projects**: `detect_project`, `run_project`, `project_status`, `stop_project`, `get_deployment_readiness`.

**Dynamic private tools**: published manifests register `synthi_app_*` tools via `privateWorkflowToolRegistry`; these appear in ListTools next to static defs and require Dojo proof validation before dispatch (`dispatchBrowserPrivateWorkflowToolAfterDojoProof`, `tools/browser.ts:338` name table).

### 2.3 Agent Dojo group — `tools/dojo.ts` (69 advertised; 12,568-line dispatcher)

`DOJO_TOOL_NAMES` at `tools/dojo.ts:241`; giant switch delegates into 43 imported `dojo/*` modules. Sub-groups:

- **Skill introspection (read)**: `list_competencies`, `get_skill`, `get_skill_cortex`, `get_workspace_organoid`, `get_wind_tunnel_report`, `get_counterfactual_twin`, `get_evil_twin_report`, `get_training_report`, `get_skill_passport`, `get_skill_genome`, `get_antibodies`, `get_agent_ready_ui_contract`, `get_cost_policy`, `get_universe_dossier`, `get_lifecycle`, `get_governance_report`, `get_metrics`, `get_registry`, `get_skill_assurance_case`, `get_entrustment_level`, `get_license`, `get_guardrails`, `get_case_law`, `get_license_health`.
- **Source-bound operations**: `capture_source_snapshot` (signed, release-scoped), `detect_source_drift`, `apply_source_drift_expiry` (dry-run default), `get_source_affordance_pr_plan`, `prepare_source_affordance_pr`, `create_source_affordance_pr_branch` (dry-run default, never opens remote PR), `prepare_api_backed_tool`, `run_api_backed_tool` (proof-gated, idempotent, postcondition-checked).
- **Training loops**: `generate_vivarium_scenarios`, `run_vivarium_scenario`, `run_wind_tunnel`, `run_evil_twin`, `run_checkride`.
- **Licensing lifecycle**: `publish_skill`, `recertify_skill`, `revoke_license`, `record_case_law`, `review_case_law`, `request_permission_upgrade`, `review_permission_upgrade`, `run_scheduled_governance_jobs` (dry-run default).
- **Debug/explain**: `explain_block`, `explain_failure`, `debug_counterfactual`, `run_time_machine_debugger`, `run_ghost_mode`.
- **Proof capsules**: `issue_proof_capsule`, `validate_proof_capsule`, `revoke_proof_capsule`, `create_hosted_runtime_session`, `run_with_proof_capsule` (production execution path: capsule validation + hosted runtime authorization).
- **Exports**: `export_artifacts`, `export_compliance_pack`.
- **Therapeutic tomography (12)**: `therapeutic_init_trace`, `therapeutic_run_probe`, `therapeutic_request_access` (Authority Broker), `therapeutic_dispatch_protected_tool` (blocked without scoped grant), `therapeutic_revoke_grants`, `therapeutic_run_checkrides`, `therapeutic_learn_policy`, `therapeutic_review_access`, `therapeutic_record_diagnosis`, `therapeutic_propose_remediation`, `therapeutic_verify_remediation`, `therapeutic_get_runtime`.

### 2.4 Other static groups

- **auth — `tools/auth.ts` (7)**: `begin_checkpoint_enrollment`, `finish_checkpoint_enrollment`, `list_checkpoints`, `revoke_checkpoint`, `configure_refresh_provider` (secret refs only; mint needs deployment approval), `test_refresh_provider`, `get_tool_auth_readiness`. Never returns secret values. Backed by `browser/auth.ts`.
- **source — `tools/source.ts` (5)**: `register_tokens`, `lookup_token`, `open_in_ide`, `get_mapping_status`, `suggest_affordance_patch`. SSR-safe source-identity tokens (`browser/source_identity.ts` + Vite plugin).
- **safety — `tools/safety.ts` (8)**: `materialize_failure_capsule_vivarium`, `validate_failure_capsule_vivarium`, `distill_browser_failure`, `get_mutation_plan`, `set_replay_isolation_profile`, `run_prefix_validation`, `run_ci_isolated_replay`, `explain_blocked_hardening`. Mutation replay only inside resettable CI isolation.
- **programs — `tools/programs.ts` (8)**: PAT-gated `/api/integrations/mcp/*` proxy to workspace runtime: `exec_in_runtime` (Sysbox shell; consent_required otherwise), `list_programs`, `read_session`, `launch_program` (container installs; owner/admin), `detect_workspace_program`, `launch_detected_program`, `stop_program`, `restart_program`.
- **jupyter — `tools/jupyter.ts` (7)**: `list_servers`, `test_server`, `snapshot_notebook`, `execute_cells` (≤100k chars; write access), `save_notebook` (optimistic concurrency via expectedServerRevision), `interrupt_kernel`, `restart_kernel`. Tokens never returned.
- **failure_distiller — `tools/failure_distiller.ts` (12)**: thin REST proxy table (`DEFINITIONS`: method+path+required props) to `/heal/agentic/distill*` endpoints: capture/list observation, distill, capsule replay/explain/materialize/validate-patch/request-apply/apply-approved/export-vivarium/promote-vivarium.
- **codesite — `tools/codesite.ts` (70)**: CodeSite control-plane proxy (transaction/permit/radar/inbox/policy-delta/quarantine/route-revision/mayday semantics). Special-cased locally: `get_relevant_context`, agent-bound knowledge tools, `apply_patch`; everything else generic request builder.

### 2.5 Dynamic + external tools

- **`synthi_app_*`** — private app-specific workflow tools minted from taught workflows (`browser/private_tool_registry.ts`); blocked manifests never register.
- **`ext_<n>`** — external MCP tools proxied through `@synthi/mcp-hub` when `SYNTHI_API_URL` + `SYNTHI_PAT` set (`external/index.ts:16` `ALIAS_RE = /^ext_\d+$/`); resolved at startup, capped `SYNTHI_MCP_MAX_TOOLS_PER_CONN` (64), audited via `postAudit`.

## 3. Per-directory sections

### 3.1 `wire/` — input encoding (198 LoC)
- `input.ts` — wire format for the `terminal` DC; envelope `{type:"gui-event", sessionId, event:<inner>}` verified against `synthi/src/app/workspace/[slug]/page.jsx:510`, `DraggableVideoWidget.jsx:119`, Rust worker parser `main.rs:1690-1805`. Exports `encodeMouseMove/MouseButton/Wheel/Key/ClickPair/TypeSequence`, `buttonNameToCode` (X11: 1=left,2=middle,3=right), `sendFrames` (`wire/input.ts:179`) with inter-frame delay enforcing the 500 keys/s cap. **Callers**: `channels.ts`, `tools/click|keyboard|mouse|dispatch_input.ts`. Env: none.

### 3.2 `protocol/`
- `manifest.ts` (367) — `PROTOCOL_VERSION` (:L34) single int + `SERVER_SUPPORTS[]` fallback list; `STATIC_MANIFEST`, `buildManifest`, `negotiateProtocol` + `ProtocolNegotiationError`; `DEFAULT_PIPELINE_BUDGET_MS`/`resolvePipelineBudgetMs`; shared frame-cache stats surfaced via `broker/frame_cache`. Caller: `protocol/index.ts` re-export.

### 3.3 `broker/` (~3.9k LoC, 21 modules) — zero-trust frame/action broker
Shared frame-provenance + policy layer between producer (worker) and consumers (vision, screenshot). Consumed by 29 files incl. all input tools, screenshot, locate, health.
- `contracts.ts` — `BROKER_PROTOCOL_VERSION`, envelope types, `makeBrokerFrameEvent/LifecycleEvent/HealthStatus`, `validateBrokerRequestEnvelope`.
- `errors.ts` — `BROKER_ERROR_CODES`, categorized `brokerError`, legacy mapping.
- `control_api.ts` (:L32 class `BrokerControlPlane`) — façade wiring leases (`arbitration/lease.ts`), input gate, replay queries, subscriptions.
- `frame_cache.ts` — `SharedFrameCache` (TTL 250ms-class dedupe) + `SharedInferenceCache` keyed by `promptHash`; visual dedupe results.
- `idempotency.ts` — `IdempotencyStore`, `stablePayloadHash`, TTL'd exactly-once records.
- `input_gate.ts` — `resolveBrokerInputMode` (off/warn/enforce), `checkBrokerInputGate` (fresh frame-seq requirement).
- `ordering.ts` — per-stream dedupe keys + ordering tracker.
- `postconditions.ts` — pluggable post-condition verification hooks.
- `producer.ts` — `ProducerFenceRegistry` (single-producer attach grants/fences).
- `read_only.ts` — current lifecycle/health/frame observation snapshots (consumes `frames.ts`).
- `replay.ts` — `queryBrokerReplay`, failed-action timeline, retention policies (`MAX_REPLAY_LIMIT`, horizons).
- `rollout.ts` — dual-write/dual-read canary controller with compatibility matrix.
- `runtime.ts` — `brokerRuntime` recovery incident registry.
- `security.ts` — payload/event redaction, immutable audit log, provider allow-list assertions.
- `slo.ts` (:L59 `BROKER_SLO_DEFINITIONS`) — SLO definitions/recorder/gates.
- `subscriptions.ts` — topic subscribe/resume/health registry.
- `trace.ts` — ack-chain normalization, `recordBrokerInputTrace`.
- `worker_pool.ts` — bounded visual worker pool (`brokerVisualWorkerPool`).
- `fallback.ts`, `index.ts` (barrel).

### 3.4 `tools/` (52 files)
One file per core tool (see §2.1) + group dispatchers (§2.2–2.4). Shared helpers:
- `shared.ts` — `ToolContext`, `jsonResponse`/`errorResponse`/`imageAndTextResponse`/`errorFromException`.
- `shared_lease.ts` — `requestSharedLease` wrapper used by mouse/keyboard before dispatch.
- `wait_hmr.ts` (513) — HMR terminal wait + one-time `frame_gate_token` issuance (:L388); integrates GPU proof states.
- `screenshot.ts` (473) — region/max_dim/freshness/frame-gate consumption + capture manifest.
- `browser.ts` (3,720) — 43 browser tools + private-workflow hydration + Dojo-proof validation bridge.
- `dojo.ts` (12,568) — 69-tool switch importing 43 dojo modules; env `SYNTHI_DOJO_THERAPEUTIC_STORE_DIR`.

### 3.5 `arbitration/`
- `lease.ts` (660) — input lease registry; modes `advisory` (phase-1, log-only) vs `single-holder` (enforced); constants `DEFAULT_LEASE_MS`, `MAX_LEASE_MS` (:L114), `MAX_CONTINUOUS_OWNERSHIP_MS`, `FAIRNESS_STARVATION_MS`; `resolveLeaseMode` (:L118). Batched `InputActionBatch`. **Callers**: broker/control_api+input_gate+runtime+trace, acquire/renew/release/force tools, shared_lease, mouse, keyboard.

### 3.6 `browser/` (28 files, ~24k LoC) — teach→compile→replay stack
- `types.ts` — permission tiers, consent records, leases, trace events, snapshots.
- `security.ts` — origin normalization, exact-origin match, value/URL/text redaction, sensitive-field detection, bridge-token compare.
- `broker.ts` (1,269; singleton :L1252) — authority for tab visibility, origin consent, teach-mode recording, redaction, action filtering; imports lane0, trace, auth, security, workflow.
- `playwright_adapter.ts` (4,080; adapter class :L123) — CDP attach, element descriptors, human-action capture, overlay requests, storage-state helpers for auth.
- `trace.ts` (1,904; recorder :L30) — semantic teach-trace recorder + Playwright script generator; generated CI-isolated scripts gate mutation on `ALLOW_WORKFLOW_MUTATION=1`, attestations via `SYNTHI_WORKFLOW_CI_NONCE/RUN_ID/REPLAY_ATTESTATION`, proofs to `SYNTHI_WORKFLOW_VISUAL_PROOF_DIR`, storage-state reuse via `PLAYWRIGHT_STORAGE_STATE`/`SYNTHI_WORKFLOW_STORAGE_STATE`, `PLAYWRIGHT_BASE_URL`, `SYNTHI_WORKFLOW_NETWORK_IDLE_TIMEOUT_MS`.
- `workflow.ts` (1,881) — v7 workflow contract/card types; `compileWorkflowContract`, `planWorkflowReplay`, `orderBrowserReplayEvents`, `classifyWorkflowReplayBlock`.
- `safety.ts` (463) — replay isolation profiles (manifest v7), mutation safety plans, prefix-validation summaries, `parseReplayCommand`.
- `ci_replay.ts` (646) — `runCiIsolatedReplay` executing full workflows only against resettable CI profiles.
- `auth.ts` (1,516; manager :L410) — auth checkpoint enrollment/metadata; in-memory + encrypted-file stores; refresh-provider commands; readiness evaluation.
- `hosted_runtime.ts` — resolve/attach Synthi-hosted browser runtime; env: `SYNTHI_HOSTED_BROWSER_CDP_URL/PORT/HEADERS_JSON/TOPOLOGY/TARGET_TEMPLATE`, `WORKSPACE_URL`, `RUNTIME_ID`, `SESSION_ID`, `SESSION_TTL_MS`, `ORIGIN_ALLOWLIST`, `REDACT_SCREENSHOTS`, `ALLOW_LOCAL_NETWORK`; tenant ids `SYNTHI_TENANT_ID`, `SYNTHI_WORKSPACE_ID`, `SYNTHI_ACTOR_ID`, `SYNTHI_AGENT_ID`.
- `private_tool_manifest.ts` / `private_tool_registry.ts` (480; process singleton) — v7 manifest generation, publication validation, encrypted-file store, listener events.
- `source_identity.ts` — JSX source-identity transform (`SOURCE_IDENTITY_ATTR`), Vite plugin, workspace registry.
- `locator.ts` — ranked locator candidates + best pick.
- `lane0.ts` — sliding-window reducer status (v7).
- `preview_target.ts` — preview URL allow-list resolution.
- `project_runner.ts` — detect/run/status/stop local dev commands (logged processes).
- `deployment_readiness.ts` — redacted readiness report across hosted runtime/bridge/store/auth wiring.
- `bridge_server.ts` — localhost HTTP hop for the IDE panel.
- Dojo-facing: `dojo.ts` (shared domain types), `dojo_store.ts` (skill stores), `dojo_universe.ts` (dossier/lifecycle/governance/metrics/evidence builders), `dojo_vivarium.ts` (scenario + wind-tunnel runners), `dojo_license_kernel.ts` (kernel decision + execution marking).

### 3.7 `browser_workflow_bridge/`
- `server.ts` (1,922) — panel-state builder + HTTP dispatch through existing MCP handlers (no duplicated behavior); env `SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT/HOST/TOKEN`.
- `standalone.ts` (57) — CLI entry (`npm run browser:workflow:bridge`).

### 3.8 `dojo/` — 17 packages, ~90 files (largest subtree)
- **`api/`** — network-trace endpoint candidate inference → review → `compileDojoApiBackedMcpTool` producing proof-gated API-backed tools (mutation classes, idempotency, evidence).
- **`case_law/`** — failure-derived case-law records; antibody matching; guardrail synthesis binding to graphs; runtime refusal explanations; appeal/review status.
- **`checkride/`** — entrustment decisions, readiness decisions, executable checkride runner with license constraints + evidence ledger.
- **`config/enforcement.ts`** — all production-enforcement env constants (see §5): durable store requirement, external signing, evidence ledger, Postgres URLs, store file/key/scope, signing provider chain (local HMAC / Ed25519 / external command / managed KMS URI).
- **`evidence/`** — claims taxonomy; custody receipts + manifest verification (incl. external storage URIs); redaction rules; retention; export manifests; hash-chained ledger records (HMAC signer, canonical JSON, sha256); ledger resolver + Postgres append store.
- **`governance/service.ts`** (2,149) — approvals queue, RBAC policies + decisions, permission-upgrade flow, license revocation, case-law review, scheduled jobs, license health.
- **`graph/`** — typed skill-graph compiler/runtime: node kinds + risk levels, guardrail predicates (parse/normalize/evaluate), assertion runtime, rollback decisioning, node registries, substrate executor (fake + selection priority), expiry/human-decision/resume state, evidence writers; `validateDojoSkillGraph`.
- **`license/kernel.ts`** (18) — tiny façade delegating to `browser/dojo_license_kernel.ts`.
- **`mcp/`** — `execution_policy_gate` (tenant context validation, published-skill bindings, required paths), `manifest_signing` (signed skill manifests v1; issuer/key-id/algorithm envs), `skill_bus` (993: tool resolution/dispatch, rate limiter scopes/rules, execution blocks, tenant-context validators).
- **`proof/`** — capsule service (issue/validate/consume), error-code normalization, key registry (custody models), public verification bundles + verifier, signing providers (local HMAC, Ed25519 pairgen, external command, managed key service).
- **`regret/`** — counterfactual regret machinery: choice scenes → branch fossils/traces → exposure scoring → arbiter lessons → policy-delta hypotheses/promotion; service + in-memory store.
- **`runtime/`** — hosted runtime gateway (tenant sessions, short-lived credentials, action authorization, revoke), env-based resolver, Postgres session store.
- **`source/`** — source snapshots (signed, release-scoped), drift detection + expiry application + recertification handoffs, affordance PR plan validation, React codemods (AST parse/apply + vitest contract tests), patch bundle writer, PR branch git ops, PR metadata validation, agent-ready UI contract validation.
- **`status/implementation_status.ts`** — per-tool implementation metadata (real vs simulated backing), report statuses.
- **`store/`** — interfaces (skills, versions, proof capsules, upgrades, ghost/shadow evidence), migration DDL (`DOJO_POSTGRES_MIGRATIONS`), Postgres stores ×10 (skills, graph runs, licenses, proof store+key registry, mcp skill bus, host conformance, source registry, governance, ghost-shadow evidence, audit), control-plane resolver from env, published-workflow index.
- **`tomography/index.ts`** (3,893) — therapeutic Authority Broker: authority levels/tiers, probe contracts + output-schema enforcement, strict proof capsules, escalation justifications, uncertainty, access requests, claim categories; `production_runtime_state_store.ts` persists runtime state (Postgres).
- **`vivarium/`** — synthetic practice environments: scenario DSL (tier budgets), fixture materializer (entities/documents/UI controls/policies), runner (budgets, resets, counterfactual branches), oracle evaluation + evidence append, evil-twin adversarial attack/hardening, API fault server, failure-capsule adaptation, prompt-injection document mutations.

### 3.9 `correctness/`
- `structural_change.ts` (180) — pHash gate around compile→applied windows (`FULL_FRAME_THRESHOLD`, `REGION_THRESHOLD`); wired in `session.ts`.
- `input_queue_depth.ts` (118) — observes dispatch counts during compile windows.
- `input_gate.ts` (39), `errors.ts` (263: `ERROR_PRIORITY`, `pickHighestPriority`), barrel.

### 3.10 `security/`
- `anomaly.ts` (71) — rolling keystroke anomaly detector (burst/monotone-repeat/scripted-pattern over last 256 keys) → `security` events.
- `injection.ts` (45) — canonical prompt-injection phrase scan over event-log text (console/build-log/log matches) pre-OCR.
- `signaling_url.ts` (66) — classify signaling URL local-only vs remote; remote requires `i-understand-no-auth`.

### 3.11 `events/`
- `types.ts` (170) — discriminated union, kinds: lifecycle, hmr, input, browser, lease, frame, locator_resolution, console, error, security, source_state, usage.
- `log.ts` (123; class :L37) — ring buffer (`DEFAULT_RING_CAPACITY`), query opts, `onAppend` fan-out consumed by resources push, metrics bridge, broker replay.

### 3.12 `observability/`
- `metrics.ts` (284) — hand-rolled Prometheus text registry (no prom-client): counters `synthi_tool_calls_total`, `synthi_inputs_total`, `synthi_screenshots_total`, `synthi_vision_inferences_total`, `synthi_vision_cost_usd_total`, `synthi_egress_bytes_total`, locator cache-dispatch/reresolution gauges; sum invariants asserted; `bindEventLogToMetrics`.
- `prometheus_server.ts` (62) — opt-in `/metrics` HTTP server; port/host resolution.
- `quota.ts` (184; `enforceQuota` :L159) — off/warn/enforce modes; limits tool-calls/min, screenshots/min, vision USD/hr; env `SYNTHI_QUOTA_MODE`, `SYNTHI_QUOTA_TOOL_CALLS_PER_MIN`, `SYNTHI_QUOTA_SCREENSHOTS_PER_MIN`, `SYNTHI_QUOTA_VISION_COST_USD_PER_HR`; breach → `quota_exceeded` before dispatch.

### 3.13 `snapshot/`
- `index.ts` (243) — id pattern + validation; record {source_state, frame, seq, wire}; `MemorySnapshotPersistor` + `FileSnapshotPersistor` (activated by `SYNTHI_SNAPSHOT_DIR`); process-wide `snapshotStore`. Consumers: index/http bootstrap, resources, snapshot/restore/list tools.

### 3.14 `verify/`
- `engine.ts` (244; `verify` :L19) — recursive predicate evaluator with depth (max) + clause-count bounds; kinds pixel/ocr/element_visible/log/scene_matches/and/or (`verify/types.ts`).

### 3.15 `wait/`
- `engine.ts` (413; `runWait` :L27) — condition→resolver dispatch; per-resolver sampling cadence under shared timeout+cancellation; conditions hmr/motion_settled/pixel/scene_change/text/log/element/source_state/audio.

### 3.16 `locate/`
- `types.ts` / `cache.ts` (TTL + drift-threshold cache) / `backends.ts` (selectBackend: mock | agent_side | claude_api | gemini_api | local) /
- `claude_api.ts` (302) — Anthropic messages client, bbox parsing, cost math (`PRICING_USD_PER_MILLION`), env `ANTHROPIC_API_KEY`, `SYNTHI_VISION_MODEL`.
- `gemini_api.ts` (332) — Gemini generateContent equivalent, env `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `SYNTHI_GEMINI_MODEL`.
- `local.ts` (196) — local vision endpoint, env `SYNTHI_LOCAL_VISION_URL`.
- `vision_utils.ts` — shared prompt/hash/clamp helpers; `index.ts` — `LocateEngine` singleton with cancellation forwarding (abort in-flight API calls on tool cancel).

### 3.17 `escape_hatch/`
- `queue.ts` (196; `MAX_PENDING` :L53) — pending-question queue (kind/outcome/listener); drained via `synthi_answer_escape_hatch` or `operator_bridge`.
- `human_actions.ts` (58) — recorded human-authored actions.

### 3.18 `operator_bridge/`
- `server.ts` (327) — opt-in HTTP (GET/POST/OPTIONS, SSE idle TTL) exposing escape-hatch queue to operator UIs; binds 127.0.0.1; env `SYNTHI_OPERATOR_BRIDGE_PORT/HOST/TOKEN` (token required), `SYNTHI_OPERATOR_SSE_IDLE_TTL_MS`.

### 3.19 `enriched/`
- `provider.ts` (77) — provider registry for semantic entity tier (a11y bridges planned); no provider ⇒ stable `enriched_tier_not_available` errors.

### 3.20 `external/`
- `config.ts` (18) — `readExternalConfig`: needs `SYNTHI_API_URL` + `SYNTHI_PAT`, optional `SYNTHI_WORKSPACE_SLUG`.
- `index.ts` (161) — descriptor resolution via `/api/integrations/mcp/resolve`, alias entries, rate-limited `callExternalTool` with `__resetExtCall` test hook, audit posting.

### 3.21 `resources/`
- `registry.ts` (222; `RESOURCE_URIS` :L21) — 8 subscribable resources: `synthi://preview/{state,hmr,screenshot,console,events,source}`, `synthi://escape-hatch/queue`, `synthi://snapshots/list`; `resourceUrisForEvent` drives notifications (screenshot pushes rate-limited ≤2 Hz in `server.ts`).

### 3.22 `util/`
- `env.ts` — dotenv loader (host env wins).
- `phash.ts` — perceptual hash, hamming distance, region pHash (used by correctness gate + locate handles).
- `request_registry.ts` — in-flight request tracking for shutdown abort.
- `dispatch_ack_registry.ts` — pending dispatch ack correlation.

## 4. Singles (top-level files)

- **`server.ts`** (1,448) — `createSynthiServer`; `SYNTHI_ATOMIC_AGENT_INSTRUCTIONS` (:L82); `STATIC_TOOL_DEFINITIONS` (:L101); ListTools/ListResources/ReadResource/Subscribe/Unsubscribe handlers; quota gate + external proxy + `dispatchTool` (:L1309); CallTool (:L1413); resource notification pump.
- **`index.ts`** (183) — stdio entrypoint. Loads `.env` before any module reads env (GEMINI/ANTHROPIC keys, `SYNTHI_VISION_BACKEND` default `agent_side`, hard-fail `gemini_api_no_key`). CLI `--session/--session-id/--signaling-url`. Wires FileSnapshotPersistor, external tools, Prometheus, operator bridge, workflow bridge, SIGINT/SIGTERM → `performShutdown`.
- **`http.ts`** (736) — Streamable HTTP transport (`parseArgs`, `resolveConfig`): bearer auth (`SYNTHI_MCP_HTTP_BEARER_TOKEN/HEADER`), body caps, health path, per-session transports; applies Dojo Postgres migrations at boot; optional therapeutic production endpoints (`SYNTHI_THERAPEUTIC_PROD_*`, ~15 vars) with dedicated authorization-body parsing exports.
- **`session.ts`** (984; singleton :L984) — MCP-local attach state (`AttachedSession` = signaling+peer+frames+channels), `AttachOptions` (ICE servers w/ Google-STUN fallback), frame advance + freshness window (`FRAME_ADVANCE_FRESHNESS_WINDOW_MS`), one-time frame-gate tokens (`FRAME_GATE_TOKEN_TTL_MS` :L94), warming progress, structural-change + injection-scan integration.
- **`peer.ts`** (411) — werift RTCPeerConnection wrapper; ICE candidate classification; `SYNTHI_MCP_ICE_POLICY=all|relay` (relay avoids flaky host↔host pairs).
- **`channels.ts`** (176) — DC multiplexing: terminal (input), build-log (feeds `HmrNormalizer`), compile channel with chunked CompileRequest (`SYNTHI_MCP_COMPILE_CHUNK_BYTES`, default 48,000).
- **`frames.ts`** (437) — FrameSink: PNG decode/validation (magic bytes), seq/ts/contentHash bookkeeping, latest-PNG access, `getActiveFrameSinkCount` (:L431). Consumed by session, broker/read_only, get_usage.
- **`signaling.ts`** (287) — WS signaling client; roles `browser|worker|observer|mcp-agent`; register/offer/answer/candidate protocol mirroring `backend/synthi-webrtc-compiler/signaling-server/src/main.rs:265-302`; TURN credential receipt on `registered`.
- **`hmr.ts`** (539; normalizer :L285) — parses 4 worker wire families on build-log, resolves first terminal event; classification + preview/module extraction.
- **`gpu_proof.ts`** (913) — GPU HMR proof state machine (`GPU_HMR_PROOF_SCHEMA_VERSION` :L11): 9 proven states (compile→symbol-bound→ABI→epoch-swap→dispatch→output-oracle→host-preservation→full-runtime) + degraded states (fake-launch-path…), acceptance-contract evaluation via `scripts/lib/gpu-hmr-acceptance-contract.mjs`.
- **`gpu_proof_ledger.ts`** (1,553) — embedded invariant ledger (`embeddedGpuHmrProofLedger` :L1544): project/artifact kinds, metric clocks/scopes/caches, model-provider availability bases (requires `google_gemini`, split=`gemini-3.5-flash`, gpu_delta=`gemini-3.1-flash-lite`), convergence metrics; `queryGpuHmrLedgerInvariants`.
- **`shutdown.ts`** (111) — ordered isolated teardown steps: cancel_in_flight → close_session → close_server → unbind_metrics → close_metrics_server → close_operator_bridge → close_browser_workflow_bridge.
- **`atomic_task_router.ts`** (715) — schema-free planner over `VectantToolMetadata` (names/groups/keywords only); roles, risk classes, agent policies, route traces; `createAtomicTaskRouter` (:L568).
- **`atomic_skill_catalog.ts`** (72) — metadata-only Vectant skill index.
- **`tool_metadata_catalog.ts`** (380) — routing facets over `ADVERTISED_TOOLS` (`TOOL_METADATA_CATALOG` :L367); never participates in registration/dispatch.
- **`tool_registry.ts`** (316) — `ADVERTISED_TOOLS` (:L12) source of truth; drift warning if misaligned with registrations.
- **`mjs-modules.d.ts`** — ambient types for `.mjs` script imports.

## 5. Environment variable catalog

**Connection/session**: `SYNTHI_SESSION_ID`, `SYNTHI_SIGNALING_URL` (defaults ws://localhost:9000), `SYNTHI_SNAPSHOT_DIR`, `SYNTHI_MCP_COMPILE_CHUNK_BYTES`, `SYNTHI_MCP_ICE_POLICY`.
**ICE**: `SYNTHI_STUN_URL`, `SYNTHI_TURN_URL`, `SYNTHI_TURN_USERNAME`, `SYNTHI_TURN_CREDENTIAL` (attach tool resolution).
**Vision/locate**: `SYNTHI_VISION_BACKEND`, `ANTHROPIC_API_KEY`, `SYNTHI_VISION_MODEL`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `SYNTHI_GEMINI_MODEL`, `SYNTHI_LOCAL_VISION_URL`.
**Observability**: `SYNTHI_PROMETHEUS_PORT`, `SYNTHI_PROMETHEUS_HOST`, `SYNTHI_QUOTA_MODE`, `SYNTHI_QUOTA_TOOL_CALLS_PER_MIN`, `SYNTHI_QUOTA_SCREENSHOTS_PER_MIN`, `SYNTHI_QUOTA_VISION_COST_USD_PER_HR`.
**Bridges**: `SYNTHI_OPERATOR_BRIDGE_PORT/HOST/TOKEN`, `SYNTHI_OPERATOR_SSE_IDLE_TTL_MS`, `SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT/HOST/TOKEN`.
**External hub**: `SYNTHI_API_URL`, `SYNTHI_PAT`, `SYNTHI_WORKSPACE_SLUG`, `SYNTHI_MCP_MAX_TOOLS_PER_CONN`, `SYNTHI_MCP_LISTTOOLS_CONCURRENCY`.
**Hosted browser**: `SYNTHI_HOSTED_BROWSER_CDP_URL/_PORT/_HEADERS_JSON/_TOPOLOGY/_TARGET_TEMPLATE`, `_WORKSPACE_URL`, `_RUNTIME_ID`, `_SESSION_ID`, `_SESSION_TTL_MS`, `_ORIGIN_ALLOWLIST`, `_REDACT_SCREENSHOTS`, `_ALLOW_LOCAL_NETWORK`; tenancy `SYNTHI_TENANT_ID`, `SYNTHI_WORKSPACE_ID`, `SYNTHI_ACTOR_ID`, `SYNTHI_AGENT_ID`.
**Workflow replay (browser/trace.ts)**: `ALLOW_WORKFLOW_MUTATION`, `PLAYWRIGHT_BASE_URL`, `PLAYWRIGHT_STORAGE_STATE`, `SYNTHI_WORKFLOW_STORAGE_STATE`, `SYNTHI_WORKFLOW_CI_RUN_ID`, `SYNTHI_WORKFLOW_CI_NONCE`, `SYNTHI_WORKFLOW_REPLAY_ATTESTATION`, `SYNTHI_WORKFLOW_VISUAL_PROOF_DIR`, `SYNTHI_WORKFLOW_NETWORK_IDLE_TIMEOUT_MS`.
**Dojo enforcement (config/enforcement.ts + manifest_signing)**: `SYNTHI_DOJO_PRODUCTION_ENFORCEMENT`, `SYNTHI_DOJO_REQUIRE_DURABLE_STORE`, `SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING`, `SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER`, `SYNTHI_DOJO_CONTROL_PLANE_STORE`, `SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL`, `SYNTHI_DOJO_STORE_FILE/_KEY/_SCOPE`, `SYNTHI_DOJO_EVIDENCE_LEDGER_STORE`, `SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL`, proof-signing family (`SYNTHI_DOJO_PROOF_SIGNING_PROVIDER/_KEY/_KEY_ID/_PRIVATE_KEY_PEM/_PUBLIC_KEY_PEM/_COMMAND/_COMMAND_ARGS/_MANAGED_KEY_URI`), manifest-signing family (`SYNTHI_DOJO_MCP_MANIFEST_ISSUER/_KEY_ID/_SIGNING_KEY/_SIGNING_ALGORITHM/_PRIVATE_KEY_PEM/_PUBLIC_KEY_PEM`), `SYNTHI_DOJO_ARTIFACT_EXECUTION_MODE`, `SYNTHI_DOJO_THERAPEUTIC_STORE_DIR`.
**HTTP transport**: `SYNTHI_MCP_HTTP_PORT/_HOST/_PATH/_HEALTH_PATH/_BEARER_TOKEN/_BEARER_HEADER/_MAX_BODY_BYTES`, `SYNTHI_DOJO_MCP_BEARER_TOKEN`, therapeutic prod family `SYNTHI_THERAPEUTIC_PROD_*` (enabled flag, endpoints, runtime auth context/token/session, store path/token, probe path/upstream/tokens, postgres url, tenant/org/workspace/actor/roles).

## 6. Cross-cutting observations

- **Three tool surfaces coexist**: 275 static advertised names, runtime `synthi_app_*` private tools (Dojo-proof gated), and unbounded `ext_<n>` hub proxies. Drift is guarded by `ADVERTISED_TOOLS` being consumed in two places with an explicit alignment comment (`tool_registry.ts` header).
- **Defense-in-depth order matters**: quota → external-proxy → group dispatchers (each returns null to decline) → handler map. Input-mutating tools additionally pass broker input gate + lease validation + frame freshness; screenshots can be marked `brokered=false` when DPR proof is unavailable.
- **Everything is observable**: every tool call lands in the event ring buffer and Prometheus; usage quotas read the same counters they enforce.
- **Dojo is the largest subsystem** (~half the codebase): its 69 tools wrap 17 packages spanning licensing, proofs, case law, vivarium simulation, governance, and therapeutic tomography — with dry-run defaults and fail-closed enforcement toggles throughout (`*_ENV` constants centralised in `dojo/config/enforcement.ts`).
- **Phase markers abound** ("Phase 1 wire-only", "Phase 2c/2d/3"): several tools are documented stubs (`audio`, guest reset enforcement, quality negotiation) that return stable wire errors rather than failing silently.

---

## Related

[[MCP Synthi]] · [[Dojo Codesite Local Support]]

[[00 Home|🏠 Back to Home]]
