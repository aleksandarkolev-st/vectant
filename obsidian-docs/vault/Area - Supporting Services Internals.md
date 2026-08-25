---
tags: "packages", "gateway"
type: exhaustive-area-reference
source-repo: vectant-ade
generated: 2026-08-25
---

# Area - Supporting Services Internals

> [!info] Exhaustive reference — every module/route/file in this area, with `path:LNN` citations. Raw source: `docs/obsidian-src/area-supporting.md`.

---
title: Supporting Services — File-Level Analysis
area: supporting-services
status: complete
scope: packages/atomic-orchestrator, packages/mcp-hub, packages/programs-mcp, backend/y-sweet, ai-backend/gateway, ai-backend/agent-runner, extensions/vectant-oauth-relay, root wiring
---

**Supporting Services — File-Level Analysis**

> Exhaustive file-by-file analysis of the supporting services in vectant-ade.
> Refs use `path:LNN` into the working tree. Line refs verified against HEAD at time of writing.
>
> These services are *supporting* infrastructure: none serve the product UI directly.
> They are the orchestration library, SSRF-hardened MCP plumbing, a manifest-teaching
> MCP server, the CRDT persistence server, the browser→AI-engine WebSocket bridge,
> the disposable agent-runner image, and the OAuth callback relay extension.

## Scope map

| Section | Path | Files |
|---|---|---|
| [[#1-packages-atomic-orchestrator]] | `packages/atomic-orchestrator` | 4 src files + tests |
| [[#2-packages-mcp-hub]] | `packages/mcp-hub` | 6 src files + tests |
| [[#3-packages-programs-mcp]] | `packages/programs-mcp` | 7 src files + tests |
| [[#4-backend-y-sweet]] | `backend/y-sweet` | Dockerfile, README (+ k8s/compose surface) |
| [[#5-ai-backend-gateway]] | `ai-backend/gateway` | server.js (3101 L) + Dockerfile |
| [[#6-ai-backend-agent-runner]] | `ai-backend/agent-runner` | Dockerfile, entrypoint.sh |
| [[#7-extensions-vectant-oauth-relay]] | `extensions/vectant-oauth-relay` | manifest.json, background.js, content-bridge.js |
| [[#8-root-wiring]] | repo root | package.json, .mcp.json, playwright.config.ts |

---

# 1. packages/atomic-orchestrator

Provider-neutral lifecycle for "atomic" (single-responsibility, dependency-ordered) changes.
A host injects executors / validators / recoveries / skill loaders; the planner itself sees
only **metadata** (ids, categories, keywords, costs) so full instructions and tool schemas
cross only the narrow execution boundary (`packages/atomic-orchestrator/src/index.js:L7-L9`).

## packages/atomic-orchestrator/package.json (9 L)

- **Purpose:** declares `@vectant/atomic-orchestrator`, private ESM (`"type": "module"`).
- **Exports:** `"." → ./src/index.js` (`package.json:L6`). Main `src/index.js`.
- **Scripts:** `test: vitest run`; devDependency `vitest ^4.1.7`. No runtime deps — fully self-contained.
- **Consumers:** imported by path (not by package name) in `synthi/src/lib/agent-routing/chat-tool-routing.js:L1`
  and `synthi/src/lib/agent-routing/agent-pipeline-routing.js:L1`
  (`import { createOrchestrator } from '../../../../packages/atomic-orchestrator/src/index.js'`);
  referenced contractually by `mcp/synthi-mcp/src/atomic_task_router.ts:L154,L688`.

## packages/atomic-orchestrator/src/index.js (38 L)

- **Purpose:** public façade wiring planner + lifecycle.
- **Exports:**
  - `createOrchestrator(options)` — `index.js:L11-L27`: builds a `createTaskPlanner(options)`
    and returns `{ decompose, route, run }`. `run(request)` delegates to `runAtomicTasks`
    passing through `executors`, `validators`, `validatorAgents`, `recoveries`, `loadSkills` (`index.js:L17-L25`).
  - `routeJson(orchestrator, task)` — `index.js:L29-L38`: runs `orchestrator.route(task)` and
    serializes only `{ role, skills, validation, reason, suggested_tools }` — the metadata-only
    projection safe to hand to an LLM router.
- **Consumers:** the two agent-routing libs above; nothing else imports the package.

## packages/atomic-orchestrator/src/task-planning.js (270 L)

- **Purpose:** deterministic metadata router + task normalization/topological ordering.
- **Exports:**
  - `normalizedId(value)` — `task-planning.js:L3-L5`: trim+lowercase string id helper.
  - `taskMetadata(task)` — `L12-L20`: projects `{ id, description, category, risk, dependencies }` (the privacy boundary).
  - `skillMetadata(skill)` — `L22-L31`: `{ id, name, description, categories, keywords, toolGroups }`.
  - `toolMetadata(tool)` — `L33-L40`: `{ id, group, groups, keywords }`.
  - `isFastPath(task)` — `L154-L156`: true when `task.fastPath === true` or description starts with
    `/^(rename|format|typo|mechanical)\b/i`.
  - `createTaskPlanner({ skills, agents, tools, decomposer, routingAgents, routers, trace, maxSkills })` —
    `L162-L270`, returns:
    - `decompose` (= `normalizeTasks`) and `decomposeRequest(request)` (`L179-L183`; calls injectable
      `decomposer` LLM hook first when provided),
    - `order(tasks)` — DFS topological sort `orderTasks` (`L71-L93`); throws on cycles
      (`L79`) and unknown dependencies (`L83`); duplicate ids rejected in `normalizeTasks` (`L63-L67`),
      empty descriptions in `normalizeTask` (`L45`).
    - `route(rawTask)` — `L225-L230`: deterministic `makeRoute` + `routed` trace event tagged
      `'deterministic-metadata-router'`.
    - `routeWithRouter(task)` — `L236-L255`: picks cheapest routing-capable agent (`selectRoutingAgent`,
      `L232-L234`, fallback `{ id:'deterministic-metadata-router', … cost:0 }`), resolves an injectable
      `routers[agent.id|role|default]`, hands it **catalog copies** (skills/tools metadata only,
      `L245-L251`), merges its decision into `makeRoute`.
    - `fastRoute(task)` — `L263-L267`: forces risk 'low', no skills, validation 'none', reason
      'Trivial mechanical operation.'.
    - `emit(event, data)` — wraps `trace` option (`L177`).
- **Internal scoring machinery:**
  - `scoreSkill` (`L102-L115`): category match +20, exact id term +14, keyword +10, category-term +6,
    name substring +4, description substring +1 (terms = words >2 chars from description+category, `L95-L100`).
  - `selectSkills` (`L117-L124`): score > 0 only, desc by score then id, capped at `maxSkills` (default 3, `L1`).
  - `canExecute` (`L131-L137`): role filter + every selected skill must be in agent's capability list;
    empty selection requires `agent.fallback === true`.
  - `cheapest(agents, predicate)` (`L139-L144`): min `cost` (missing = ∞) tie-broken by id.
  - `validationFor` (`L146-L152`): explicit 'none'/'independent'; otherwise risk high/critical or
    category security ⇒ independent, else none.
  - `makeRoute` (`L185-L213`): honors requested `decision.skills|skillIds`, picks agent (capable →
    fallback → synthetic implementation agent `L192-L194`), exposes tools whose group/id is referenced
    by any selected skill (`L195-L198`), truncates `reason` to 240 chars (`L207`).

## packages/atomic-orchestrator/src/execution-lifecycle.js (166 L)

- **Purpose:** sequential executor for ordered tasks with failure recovery and optional independent validation.
- **Exports:** single `runAtomicTasks({ request, planner, executors, validators, validatorAgents, recoveries, loadSkills })` —
  `execution-lifecycle.js:L99-L166`.
- **Flow (per task):**
  1. Dependency gate `L111-L118`: any non-successful dependency (`completed`/`recovered`, `isSuccessful` `L15-L17`)
     ⇒ status `blocked` + `dependency_blocked` event.
  2. Routing `L120-L122`: fast-path tasks skip the router entirely (`fast_path` event).
  3. Execution `executeTask` (`L34-L69`): executor resolution order is `executors.fastPath` (when fastPath) →
     `executors[agent.id]` → `executors[role]` → `.default` (`L35-L37`); throws `'No executor for <role>'` if none.
     Loads skill instructions via injected `loadSkills(skillIds, { task, route })` (`L40-L43`), emits
     `execution_started`, invokes executor with metadata + loaded instructions (`L53-L66`), emits `executed`.
  4. Recovery `L128-L151`: on executor throw, emit `execution_failed`, resolve `recoveries[agent.id|role|default]`;
     no recovery ⇒ `failed` result; recovery success flips status to `recovered` (emits `recovered`),
     failure ⇒ `failed` with both `error` + `recoveryError` (`recovery_failed` event).
  5. Validation `validateTask` (`L71-L96`): skipped when `routing.validation === 'none'` (`L72`). Validator agent =
     `cheapestValidator` (`L3-L9`, min-cost validation-role agent, fallback `{id:'independent-validator', model:'local', cost:0}`).
     Validator fn resolution `validators[agent.id] || validators[routing.validation] || validators.default` (`L74-L76`);
     missing validator ⇒ `{ ok:false, reason:'Independent validator unavailable.' }` + `validation_failed` event (`L77-L81`).
     Throws inside validator become `{ ok:false, error }` (`L91-L95`).
  6. Final status `L155-L162`: `invalid` (validation not ok) | `recovered` | `completed`; result carries
     `{ task, status, route, output, validation, fastPath }`.
- Returns results array aligned to task order (`L165`).
- Event vocabulary emitted through `planner.emit`: `dependency_blocked`, `fast_path`, `execution_started`,
  `executed`, `execution_failed`, `recovery_started`, `recovered`, `recovery_failed`, `validation_started`,
  `validated`, `validation_failed`.

## Tests (vitest)

- `packages/atomic-orchestrator/src/index.test.js` (227 L): orchestrator façade + routeJson projection behavior.
- No test file for execution-lifecycle directly; covered transitively via index.test.js.

---

# 2. packages/mcp-hub

SSRF-hardened client hub for external MCP servers, plus shared helpers used across the Synthi app.
Package name `@synthi/mcp-hub` v0.1.0.

## packages/mcp-hub/package.json (15 L)

- **Exports** (`package.json:L8-L11`): `"."` → types `index.d.ts` + impl `src/index.js`;
  `"./helpers"` → `src/helpers.js`.
- **Deps:** `@modelcontextprotocol/sdk ^1.29.0` (the only runtime dep); devDep vitest.
- **Consumers (grep `@synthi/mcp-hub`):**
  - `synthi/src/app/api/chat/externalTools.js:L4-L5` — `listTools`, `callTool`, `jsonSchemaToGemini` (Gemini tool bridging).
  - `synthi/src/lib/git/safeFetch.js:L1` — reuses `assertSafeUrl` for git provider fetches.
  - `synthi/src/app/api/integrations/connections/*route.js` (list/test/CRUD routes) — connection testing.
  - `synthi/src/app/api/integrations/git/providers/route.js` + oauth device/web routes — provider checks.
  - `mcp/synthi-mcp/src/external/index.ts:L2` — `listTools`, `callTool`, types.
  - Referenced by `docker-compose.yml` build context comments and `synthi/Dockerfile`/`next.config.mjs`
    (bundled into the Next app via workspace transpilation).

## packages/mcp-hub/index.d.ts (21 L)

- **Purpose:** hand-written type surface (JS codebase).
- **Types:** `McpToolConfig` (`index.d.ts:L1-L10`): `{ id, name, url, transport?: 'http'|'sse',
  authType?: 'none'|'bearer'|'header', headerName?, secret?, allowlist? }`;
  `McpTool` (`L11`); `HubResult<T>` normalized envelope `({ok:true}&T) | { ok:false, error:{code,message?} }` (`L12`).
- **Functions:** `listTools`, `callTool`, `testConnection`, `assertSafeUrl`, `isBlockedIp`,
  `buildAuthHeaders`, `jsonSchemaToGemini`, `isAllowedHeaderName` (`L14-L20`).

## packages/mcp-hub/src/index.js (3 L)

- Pure re-export barrel: client (`listTools`, `callTool`, `testConnection`), ssrfGuard
  (`assertSafeUrl`, `isBlockedIp`), helpers (`buildAuthHeaders`, `jsonSchemaToGemini`, `isAllowedHeaderName`)
  (`src/index.js:L1-L3`). Note: guardedFetch is intentionally NOT re-exported here.

## packages/mcp-hub/src/client.js (99 L)

- **Purpose:** per-call MCP client sessions over StreamableHTTP or SSE transports.
- **Config:** `DEFAULT_TIMEOUT_MS = SYNTHI_MCP_CALL_TIMEOUT_MS || 20000` (`client.js:L8`).
- **Internals:**
  - `err(code, message)` — `L11-L13`: normalized envelope.
  - `makeTransport(config, guardedFetchFn)` — `L22-L31`: builds auth headers via `buildAuthHeaders`,
    injects the guarded fetch as the SDK's top-level `fetch` (used for ALL requests) alongside
    `requestInit.headers`; chooses `SSEClientTransport` when `config.transport === 'sse'`, else
    `StreamableHTTPClientTransport`.
  - `withSession(config, opts, fn)` — `L33-L58`: pre-flight `assertSafeUrl` (allowlist from env,
    injectable `opts.lookup`) returning `ssrf_blocked` on rejection (`L36-L39`); connects a
    `Client({name:'synthi-mcp-hub'})`, races connect+operation against timeout, always closes the
    client in `finally` (`L54-L57`); errors classified by `classify(e)` (`L67-L73`: timeout /
    auth_failed (401/403/unauthorized) / tls_error / protocol_error) or honored via `e._code`.
  - `ssrfAllowlist()` — `L60-L65`: comma-split `SYNTHI_MCP_SSRF_ALLOWLIST` env.
- **Exports:**
  - `listTools(config, opts)` — `L75-L80` → `{ ok:true, tools }`.
  - `callTool(config, toolName, args, opts)` — `L82-L91` → `{ ok:true, data }`; SDK call errors get `_code:'tool_error'` (`L88`).
  - `testConnection(config, opts)` — `L93-L98` → `{ ok:true, serverInfo, toolCount }`.

## packages/mcp-hub/src/ssrfGuard.js (115 L)

- **Purpose:** deny-by-default URL safety for server-side fetches (IPv4/IPv6 private ranges, DNS pinning check).
- **Internals:** `ssrfError` stamps `.code='ssrf_blocked'` (`ssrfGuard.js:L4-L8`); `ipv4ToInt` strict parser
  (`L11-L17`); `inV4Cidr` (`L19-L22`); blocked IPv4 ranges `isBlockedV4` (`L25-L35`):
  0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local incl. cloud metadata), 172.16/12, 192.168/16.
- **Exports:**
  - `isBlockedIp(ip)` — `L38-L61`: strips `[...]` from IPv6 hostname form; handles `::1`/`::`;
    IPv4-mapped IPv6 in dotted (`::ffff:a.b.c.d`) AND hex-group form (`::ffff:HHHH:HHHH`, `L52-L56` —
    WHATWG normalizes to this, comment documents why); unique-local fc00::/7 (`L58`) and
    link-local fe80::/10 (`L59`).
  - `assertSafeUrl(urlString, opts)` — `L73-L115`: parse-or-throw; lowercases host and strips one
    trailing FQDN dot so `localhost.` can't dodge the blocklist (`L82`); requires **https** unless host
    is on allowlist (`L85-L87`); allowlisted hosts bypass everything else (`L88`); blocks
    `localhost`, `metadata.google.internal`, `*.localhost` via `BLOCKED_HOSTNAMES` (`L63`, `L90-L92`);
    IP literals checked directly (`L94-L97`); otherwise DNS-resolves ALL A/AAAA records (injectable
    `opts.lookup` for tests, default `dns.lookup(all:true)` `L99-L104`) and rejects if ANY address is
    blocked (`L112-L114`); DNS failure / zero addresses are fail-closed (`L108-L111`).

## packages/mcp-hub/src/guardedFetch.js (69 L)

- **Purpose:** closes the TOCTOU holes left by pre-flight checking: DNS rebinding between check and
  connect, and redirects to internal URLs (module docstring `guardedFetch.js:L1-L10`).
- **Exports:** `createGuardedFetch({ allowlist, lookup, baseFetch, maxRedirects=3 })` — `L26-L68`
  returns an MCP-SDK-shaped `FetchLike` that, per hop: (1) re-runs `assertSafeUrl` immediately before
  every network call (`L41`), (2) fetches with `redirect:'manual'` so the platform never auto-follows
  (`L44`), (3) manually follows 301/302/303/307/308 (`REDIRECT_STATUSES` `L14`, `L50-L62`) up to
  `maxRedirects`, throwing a `code:'ssrf_blocked'` error beyond the cap (`L51-L55`); relative redirect
  targets resolved against current URL; method/body carried verbatim without 303 rewrite (deliberate,
  documented `L58-L59`). Blocked hops propagate `ssrf_blocked` uncaught (`L64`).
- **Consumers:** only `client.js:L42` (not part of the package export surface).

## packages/mcp-hub/src/helpers.js (76 L)

- **Exports:**
  - `isAllowedHeaderName(name)` — `helpers.js:L20-L27`: RFC 7230 token charset regex (`L2`), minus
    denylist (`L5-L9`: host, cookie/set-cookie, authorization/proxy-authorization, content-length/type,
    connection, transfer-encoding, te, trailer, upgrade, via, forwarded, x-real-ip) minus any
    `x-forwarded-*` prefix (`L25`).
  - `buildAuthHeaders(config)` — `L34-L41`: `bearer`+secret ⇒ `Authorization: Bearer <secret>`;
    `header`+headerName+secret only if `isAllowedHeaderName(headerName)`; otherwise `{}`.
  - `jsonSchemaToGemini(schema, depth)` — `L55-L76`: JSON Schema → Gemini function schema (UPPERCASE
    types), recursion bounded `MAX_DEPTH=8` (`L43`, degrades to STRING type past depth `L57`),
    descriptions truncated to 512 chars (`L61-L64`), preserves enum/properties/items/required,
    OBJECT always gets `properties:{}` (`L74`), missing schema ⇒ empty OBJECT (`L56`).
- **Consumers:** `externalTools.js` (Gemini tool declarations), `client.js` (auth headers);
  `safeFetch.js` uses ssrfGuard only.

## Tests

- `src/__tests__/client.test.js` (120 L), `guardedFetch.test.js` (96 L), `helpers.test.js` (135 L),
  `ssrfGuard.test.js` (49 L) — pure-module unit coverage including rebinding/redirect cases.

---

# 3. packages/programs-mcp

Standalone stdio MCP server `@synthi/programs-mcp` that teaches coding agents the
**vectant.programs.json** manifest format: describe schema / validate draft / generate from workspace.
Architecture principle (README `packages/programs-mcp/README.md:L69-L81`): pure modules carry all
behavior; `server.js`/`index.js` are thin protocol glue.

## packages/programs-mcp/package.json (29 L)

- **bin:** `vectant-programs-mcp → src/index.js` (`package.json:L7-L9`). Exports: `"."`, `"./validate"`,
  `"./spec"` (`L11-L15`). Engines node ≥18. Dep: `@modelcontextprotocol/sdk ^1.29.0` only.
- **Consumers:** registered project-scoped via root `.mcp.json` (see [[#8-root-wiring]]) as server
  name `vectant-programs`; also consumed ad hoc via `claude mcp add` (README `L39-L41`).

## packages/programs-mcp/src/index.js (22 L)

- **Purpose:** stdio entry point. `main()` builds `createProgramsMcpServer()`, connects a
  `StdioServerTransport`, writes readiness to stderr (`index.js:L12-L17`); fatal errors logged and exit 1 (`L19-L22`).

## packages/programs-mcp/src/server.js (44 L)

- **Purpose:** binds tools to the low-level SDK `Server` (raw JSON-Schema tools, deliberately no Zod —
  comment `server.js:L8-L11` notes the deprecated-but-chosen API keeps deps light).
- **Export:** `createProgramsMcpServer()` — `L16-L44`: server identity
  `{name:'vectant-programs-mcp', version:'0.1.0'}`; `ListToolsRequestSchema` handler maps
  `PROGRAMS_TOOLS` to wire descriptors (`L22-L24`); `CallToolRequestSchema` handler finds the tool,
  unknown ⇒ `isError` text (`L28-L30`); handler exceptions ⇒ `tool error:` text (`L34-L36`); responses
  carry `content[0].text` plus optional `structuredContent` passthrough (`L37-L40`).

## packages/programs-mcp/src/tools.js (67 L)

- **Export:** `PROGRAMS_TOOLS` — three descriptors `{name, description, inputSchema, handler}` (`tools.js:L14-L66`):
  1. `describe_manifest_schema` (`L15-L21`): no inputs; returns `{structuredContent: manifestReference(), text: referenceMarkdown()}`.
  2. `validate_manifest` (`L22-L41`): input `{manifest}` required; handler returns structured
     `{valid, errors[]}` + human text `invalid: N problem(s)\n- [code] field: message` (`L32-L40`).
     Description explicitly marks it ADVISORY vs. the fail-closed publish gate.
  3. `generate_manifest` (`L42-L66`): input `{files: {path: contents}, workspaceName?}`; delegates to
     injectable `deps.generate || defaultGenerate` (`L59`); text nudges to validate before saving (`L62`).
- All handlers return `{structuredContent, text}`; handlers are SDK-free and unit-testable.

## packages/programs-mcp/src/manifestSpec.js (131 L)

- **Purpose:** single source of truth for the manifest reference handed to agents; constants MIRROR
  backend parser `synthi/src/lib/programs/manifest.js` and must be kept in sync (`manifestSpec.js:L3-L5`;
  drift is tested by `__tests__/drift.test.js`).
- **Exports (constants):**
  - `KNOWN_SCOPES` (`L9-L15`): program.launch (always implied), workspace.files.read/write,
    network.outbound, ports.expose.
  - `SUPPORTED_RUNTIME_TYPES` (`L18`): web, cli, tui, background, gui, container.
  - `ALLOWED_SURFACES` (`L21`): app, logs, terminal, ports, health, settings.
  - `PACKAGE_ID_PATTERN` (`L24`): `^[a-z0-9][a-z0-9._-]{0,63}$`.
  - `SENSITIVE_SCOPES` (`L31`): network.outbound, workspace.files.write, ports.expose — declaring any
    routes review away from AI auto-approve into manual queue.
  - `FIELDS` (`L34-L49`): per-field spec incl. webGui KasmVNC note (`L48`).
  - `HOST_ESCAPE_RULES` (`L52-L56`): no docker.sock//var/run/docker mounts; no absolute-source host bind
    mounts (workspace `$PWD:/workspace` explicitly fine); no --privileged/--cap-add/--security-opt/--device.
  - `EXAMPLE_WEB` (`L59-L68`), `EXAMPLE_CONTAINER` (`L71-L80`).
- **Exports (functions):** `referenceMarkdown()` (`L83-L117`) renders the markdown reference;
  `manifestReference()` (`L120-L131`) returns the structured payload.

## packages/programs-mcp/src/hostEscape.js (37 L)

- **Purpose:** standalone copy of the backend denylist (`synthi/src/lib/programs/hostEscape.js`) —
  duplicated because this package ships independently; ADVISORY here, authoritative at backend
  publish time (`hostEscape.js:L2-L9`).
- **Exports:** `HOST_ESCAPE_FLAG_RE` (`L13`), `DOCKER_SOCK_RE` (`L16`), `HOST_BIND_MOUNT_RE` (`L23` —
  matches `-v/--volume` with absolute host-path SOURCE; quoted `$PWD` workspace mount does NOT match
  because after the optional quote the source begins with `$`), `findCommandHostEscape(text)` (`L30-L37`
  — first matching offending substring or null).

## packages/programs-mcp/src/validate.js (98 L)

- **Purpose:** advisory multi-error validator mirroring backend rules but collecting ALL problems in
  one pass instead of first-throw (`validate.js:L1-L8`).
- **Export:** `validateManifest(input)` — `L19-L98`. Checks: JSON-parse strings (`L21-L27`); object-not-array
  (`L28-L30`); packageId charset + no `..` (`L35-L37`, regex `L13`); version present (`L38-L40`); launch
  present (`L41-L42`); runtimeType enum (`L44-L46`); workingDir rejects absolute paths (POSIX, UNC, drive-letter)
  and any `..` segment (`L48-L57`); install string|string[] (`L59-L61`); env object-of-strings (`L62-L64`);
  ports integer 1–65535 each (`L65-L73`); permissions ⊆ KNOWN_SCOPES (`L74-L82`); health object (`L83-L85`);
  **host-escape scan across every command string (install entries + launch)** emitting
  `host_escape` errors (`L87-L95`). Returns `{valid, errors[], manifest}` (`L97`).
  Error shape `{code, message, field?}`; codes seen: invalid_manifest, invalid_field, missing_field,
  invalid_port, unknown_scope, path_escape, host_escape.

## packages/programs-mcp/src/generateClient.js (68 L)

- **Purpose:** delegate generation to a configured Vectant backend; OFF by default, fail-closed —
  never throws, returns structured results (`generateClient.js:L1-L9`).
- **Exports:**
  - `generateConfig(env)` — `L14-L22`: reads `VECTANT_MANIFEST_GENERATE_URL` (configured iff non-empty),
    `VECTANT_MANIFEST_GENERATE_TOKEN`, `VECTANT_MANIFEST_GENERATE_TOKEN_HEADER`
    (default `x-synthi-internal-token`, const `L11`).
  - `generateManifest({files, workspaceName}, {fetchImpl, config})` — `L28-L68`: not_configured /
    no_files / no_fetch / request_failed / http_error(+status) / bad_response / no_manifest error
    branches; POST body `{files, workspace_name}` matches the ai-engine
    `POST /programs/generate-manifest` contract (README `README.md:L53`); token header attached only
    when configured (`L43-L44`); success ⇒ `{configured:true, manifest}`.

## Tests

`__tests__/`: drift.test.js (spec↔backend sync), generateClient.test.js, hostEscape.test.js,
manifestSpec.test.js, roundtrip.test.js, server.test.js (build smoke), tools.test.js, validate.test.js —
pure-module coverage, no network/SDK.

---

# 4. backend/y-sweet

CRDT document server (Yjs/Yrs "y-sweet", jamsocket) backing collaborative editors. Directory contains
ONLY deployment configuration; the binary comes from upstream GHCR.

## backend/y-sweet/Dockerfile (13 L)

- **Base:** `ghcr.io/jamsocket/y-sweet:latest@sha256:d61ba0f…bcff0` — pinned BY DIGEST for immutability;
  comment notes binary reports 0.9.1 while GHCR publishes under `latest` tag (`Dockerfile:L1-L3`).
- **Surface:** `EXPOSE 8080`; `VOLUME ["/data"]` (`L6-L9`); CMD
  `y-sweet serve /data --host 0.0.0.0 --port 8080` (`L12-L13`).

## backend/y-sweet/README.md (40 L)

- Documents direct docker run (`-p 8080:8080 -v ysweet-data:/data`), a docker-compose service snippet,
  and points to `k8s/y-sweet.yaml` (`README.md:L38-L40`). Server reachable at `ws://localhost:8080`
  (WS) / http REST.

## Effective config surface (from consumers)

- **docker-compose.yml** `y-sweet` service (`docker-compose.yml:L32-L42`): builds this dir as
  `synthi-y-sweet`, host port `127.0.0.1:${YSWEET_HOST_PORT:-8180}:8080`, volume `ysweet-data:/data`;
  frontend containers receive `NEXT_PUBLIC_YSWEET_URL=http://localhost:${YSWEET_HOST_PORT:-8180}`
  (`L72`,`L96`); collab server gets `YSWEET_URL: http://y-sweet:8080` + `YSWEET_AUTH_KEY: dev-secret`
  (`L247-L248`) and depends_on y-sweet (`L201`).
- **k8s/y-sweet.yaml**: Deployment (namespace synthi, replicas 1 beta floor, RollingUpdate maxSurge 0,
  `runAsUser: 0` `y-sweet.yaml:L40-L42`, digest-pinned same image, args serve --host 0.0.0.0 --port 8080
  `L49-L53`); env `Y_SWEET_STORE=gcs://$(GCS_BUCKET_NAME)/ysweet` (GCS persistence, `L61-L67`),
  `Y_SWEET_AUTH_KEY` from secret `synthi-secrets/YSWEET_AUTH_KEY` optional (`L69-L74`); tcp probes :8080
  (`L82-L91`); Service y-sweet:8080 (`L93-L107`); HPA 1–4 @70% CPU (`L109-L133`).
- **Consumers:** `backend/collab-server/ySweetBridge.js` + `yjsWsServer.js` (token-gated proxying into
  collab WS); frontend `Editor.jsx` / `NextEditPrediction.js` / `FileVersionsPanel.jsx` via NEXT_PUBLIC url.
  NOTE: stray duplicate copies exist at `backend/backend/y-sweet/…` (nested dup dir) — treat `backend/y-sweet`
  as canonical.

---

# 5. ai-backend/gateway

Node WebSocket gateway bridging browser WS connections to the Python AI engine's HTTP endpoints.
Single file `server.js` (3101 L), CommonJS, deps ws + undici + dotenv.

## ai-backend/gateway/package.json (22 L)

- `synthi-gateway` v0.1.0, main server.js; scripts `start` / `dev` (cross-env NODE_ENV=development).
- Deps: dotenv ^16, undici ^6 (fetch), ws ^8. Engines node ≥18.
- **Consumers:** frontend clients `synthi/src/services/analyzerGatewayClient.js:L4-L7` and
  `synthi/src/hooks/useAnalyzerGateway.js:L11-L14` connect to `${NEXT_PUBLIC_GATEWAY_WS_URL ||
  (wss/ws)://<host>/gateway/ws || ws://localhost:7070/ws}`; docker-compose maps
  `127.0.0.1:${AI_GATEWAY_HOST_PORT:-7071}:7070` and sets NEXT_PUBLIC_GATEWAY_WS_URL accordingly.

## ai-backend/gateway/Dockerfile (24 L) & .dockerignore (4 L)

- Single-stage `node:20-alpine@sha256:fb4cd12c…` (comment: no native modules needed, `Dockerfile:L5`).
- `npm ci --omit=dev`, copies only server.js; creates non-root user/group `synthi` uid/gid 1001
  (`L18-L20`); EXPOSE 7070; CMD node server.js. .dockerignore excludes node_modules/.env/.git/.vscode.

## ai-backend/gateway/server.js (3101 L) — exhaustive

### Process model & config (L1-L58, L219-L252, L323-L328)

- `dotenv` loaded first (`L3`). **Cluster mode** `L5-L28`: primary forks one worker per CPU
  (`WORKER_COUNT = GATEWAY_WORKERS || os.cpus().length` `L14-L15`, toggle `GATEWAY_CLUSTER`, default on);
  exited workers restart automatically (`L22-L27`). Entire server lives inside the worker branch,
  closed by `} // end cluster worker/single-process block` (`L3101`).
- Env config (`L36-L47`): `GATEWAY_PORT` (7070), `GATEWAY_WS_PATH` (/ws), `BACKEND_URL`
  (http://127.0.0.1:8000), `BACKEND_REQUEST_TIMEOUT_MS` (30000), shared-secret
  `AI_BACKEND_AUTH_TOKEN || GATEWAY_AUTH_TOKEN`, JWT secret `GATEWAY_JWT_SECRET || AUTH_SECRET ||
  NEXTAUTH_SECRET`, kill-switch `GATEWAY_AUTH_DISABLED=true` — effective ONLY outside production OR
  with `GATEWAY_AUTH_ALLOW_INSECURE_LOCAL=true` (`L42-L47`).
- Backend URL constants built via `new URL(path, backendUrl)` in four blocks: analyze endpoints
  (`L48-L56`), heal endpoints (`L59-L69`), AI-agent endpoints (`L71-L88`), agentic endpoints
  (`L219-L252` — 33 URLs: diagnose, distill ×13 incl. observations/run/explain/materialize/delete/
  purge-expired/vivarium-export/promote/validate-patch/request-apply/apply-approved/metrics,
  episode create/get/list, policy evaluate/status, verify, guardrails, telemetry calibration/degrading,
  runtime ingest/stats, observability error/build/hmr-failure/stats/triggers, canary create/list/stats, status).
- Listens on `0.0.0.0` explicitly ("for WSL connectivity", `L323-L327`).

### Auth layer (L90-L217)

- `combineSignals(signal, timeoutMs)` — `L90-L105`: AbortSignal composition w/ AbortSignal.any fallback.
- `fetchWithTimeout(url, options, timeoutMs)` — `L107-L124`: undici fetch wrapper injecting
  `x-synthi-internal-token: <gatewayAuthToken>` on EVERY backend hop (`L112-L114`) + combined abort signal.
- `parseCookies(header)` — `L126-L142`.
- `extractGatewayToken(request)` — `L144-L160`: candidate token from, in order: `Authorization: Bearer`,
  `x-synthi-internal-token` header, `?token=`/`?authToken=` query param, cookie
  `synthi_gateway_token`/`ai_backend_auth`.
- `safeEqual(value, expected)` — `L162-L166`: length-checked `crypto.timingSafeEqual`.
- `verifyGatewayJwt(candidate)` — `L172-L205`: HS256-only HMAC verification (rejects other algs `L181`),
  timing-safe signature compare, exp/nbf checks, aud must equal `synthi-gateway` (string or array `L196-L200`).
- `isAuthorizedGatewayRequest(request)` — `L207-L217`: auth-disabled short-circuit → token match → JWT.

### Connection lifecycle (L254-L321)

- `http.createServer(handleHttpRequest)` + `new WebSocketServer({server, path})` (`L254-L258`) —
  WS only on the configured path; everything else hits handleHttpRequest.
- `connection` handler (`L260-L321`): unauthorized ⇒ close 1008 "Authentication required" (`L261-L265`);
  assigns random `clientId` and greets with `{type:'system', event:'connected', clientId}` (`L267-L283`);
  **per-connection rate limiting** (`L270-L307`): sliding 1s window max 20 msgs (`MAX_MESSAGES_PER_WINDOW`,
  matched to AI engine STATIC lane concurrency), max 5 concurrent in-flight (`MAX_IN_FLIGHT`, AI_ANALYZE lane),
  violations answered with `sendError` and dropped; handler errors return generic
  "Internal gateway error" with detail withheld (`L303-L306`); close/error logging (`L310-L320`).

### HTTP surface (L330-L348)

Exhaustive list of HTTP routes:
| Method | Path | Behavior | Ref |
|---|---|---|---|
| GET | `/health` or `/gateway/health` | 200 JSON `{status:'ok', backend:<backendUrl>}` | server.js:L331-L340 |
| any | anything else | 404 JSON `{error:'not-found'}` | server.js:L342-L347 |

No auth is applied to the health endpoints (no `isAuthorizedGatewayRequest` call in handleHttpRequest).

### Logging/redaction helpers (L350-L354, L3079-L3099)

- `API_KEY_REDACT_RE` + `redactApiKeys(text)` — `L351-L354`: masks `"apiKey"`/`"api_key"` values in
  debug payload logs (enabled by `GATEWAY_DEBUG_LOG_PAYLOADS=1`, `L358-L360`).
- `sendError(socket, message, extra)` — `L3079-L3085`: sends `{type:'error', message, ...extra}`
  (requestId/status/detail flow through `extra`).
- `safeSend(socket, payload)` — `L3087-L3099`: OPEN-state guard, try/catch swallow, logs first 200
  chars of EVERY outbound frame (`console.log` at `L3094` — unconditional, not gated behind debug flag).

### WS protocol — inbound envelope & full action table (L356-L609)

Inbound messages are JSON `{action, requestId, data}`; missing/empty/invalid handled at
`handleClientMessage:L357-L379`. Dispatch switch `L381-L609`. **All 74 supported actions**, grouped:

- **analyze (8)** `L382-L405`: `analyze/static`, `analyze/ai` (both → forwardAnalyzeRequest, useAi flag),
  `analyze/proactive`, `analyze/proactive/quick`, `analyze/container`, `analyze/unified`,
  `analyze/workspace`, `analyze/workspace/incremental`.
- **heal core (11)** `L406-L438`: `heal/analyze`, `heal/apply`, `heal/container`, `heal/config`,
  `heal/stats`, `heal/rules`, `heal/batch`, `heal/cache/stats`, `heal/presets`, `heal/preset`, `heal/metrics`.
- **heal/ai (20)** `L439-L498`: `heal/ai/analyze`, `heal/ai/runtime`, `heal/ai/batch`, `heal/ai/hybrid`,
  `heal/rule/translate`, `heal/ai/stats`, `heal/ai/feedback`, `heal/ai/memory`, `heal/ai/memory/clear`,
  `heal/ai/stream`, `heal/ai/project`, `heal/ai/config`, `heal/ai/config/update`, `heal/ai/health`,
  `heal/ai/cache/clear`, `heal/ai/preview`, `heal/ai/policy/suppress`, `heal/ai/policy/unsuppress`,
  `heal/ai/policy`, `heal/ai/policy/clear`.
- **heal/agentic (35)** `L501-L605`: `heal/agentic/distill`, `…distill/observations/capture`,
  `…distill/observations/list`, `…distill/run`, `…distill/explain`, `…distill/materialize`,
  `…distill/delete`, `…distill/purge-expired`, `…distill/vivarium-export`, `…distill/vivarium-promote`,
  `…distill/validate-patch`, `…distill/request-apply`, `…distill/apply-approved`,
  `…distill/metrics`, `…diagnose`, `…episode/create`, `…episode`, `…episodes`, `…policy/evaluate`,
  `…policy/status`, `…verify`, `…guardrails`, `…telemetry/calibration`, `…telemetry/degrading`,
  `…runtime/ingest`, `…runtime/stats`, `…observability/error`, `…observability/build`,
  `…observability/hmr-failure`, `…observability/stats`, `…observability/triggers`,
  `…canary/create`, `…canary`, `…canary/stats`, `…status`.
- Unknown action ⇒ `Unsupported action: <action>` error (`default` `L607-L608`).

### WS protocol — outbound message types (client-bound)

Only five shapes are ever sent:
1. `{type:'system', event:'connected', clientId}` — `L279-L283`.
2. `{type:'response', action, requestId, data}` — final answer for every forwarder (e.g. `L731-L736`, `L2805`).
3. `{type:'stream', action, streamId?|requestId, data/event}` — streaming frames; two flavors:
   simulated chunking for analyze/ai (`L713-L726`, 80-char chunks + final marker, action
   `analyze.stream`) and genuine SSE relay for `heal/ai/stream` (`L2433-L2439`).
4. `{type:'stream_end', action, requestId}` — SSE terminator `L2473-L2477`.
5. `{type:'error', message, ...extra}` — via sendError everywhere.

### Forwarder implementations (representative, function-level)

- `forwardAnalyzeRequest(socket, data, requestId, useAi)` — `L612-L737`: validates `lang` (non-empty
  string) + `code` (string) (`L616-L624`); AI lane enriches body with optional prompt/mode/model/
  api_key (mapped from client `data.apiKey` `L641-L643`), sanitized `files[{path,name,content}]`
  dropping empties (`L644-L658`), focus (`L659-L661`); POSTs to `/analyze/static` or `/analyze/ai`;
  backend !ok forwards detail + status to client (`L681-L688`); non-JSON masked (`L690-L699`); AI
  suggestion simulated-streamed then final `response` (`L701-L736`).
- `forwardProactiveAnalysis` `L744-L907`, `forwardContainerAnalysis` `L908-L1050`,
  `forwardUnifiedAnalysis` `L1051-L1215`, `forwardProactiveQuickAnalysis` `L1216-L1286`,
  `forwardWorkspaceAnalysis` `L1321-L1464` (uses `mapChangedFile(f)` `L1287-L1320`),
  `forwardWorkspaceIncrementalAnalysis` `L1465-L1565` — same pattern: field whitelisting/coercion →
  POST → response/error.
- Heal forwarders `L1566-L2060`: `forwardHealAnalyze` `L1566`, `…Apply` `L1618`, `…Container` `L1670`,
  `…Config` `L1722`, `…Stats` `L1752` (GET), `…Rules` `L1775` (GET), `…Batch` `L1798`,
  `…CacheStats` `L1825` (GET), `…Presets` `L1848` (GET), `…PresetApply` `L1871`, `…Metrics` `L1898` (GET).
- AI forwarders `L1924-L2790`: `forwardAIAnalyze` `L1924`, `forwardHealRuleTranslate` `L1986`,
  `forwardAIRuntime` `L2061`, `forwardAIBatch` `L2121`, `forwardAIHybrid` `L2171`, `forwardAIStats`
  `L2224` (GET), `forwardAIFeedback` `L2255`, `forwardAIMemory` `L2306` (GET),
  `forwardAIMemoryClear` `L2337`, `forwardAIStream` `L2374-L2482` (**true streaming**: POST with
  timeoutMs 0 = no timeout `L2394-L2398`, parses backend SSE `data:` events splitting on `\n\n`,
  re-emits each as `type:'stream'` frame, flushes decoder tail + trailing buffer, ends with
  `stream_end`), `forwardAIProject` `L2484`, `forwardAIConfig` `L2537`, `forwardAIConfigUpdate`
  `L2557`, `forwardAIHealth` `L2589` (GET), `forwardAICacheClear` `L2609`, `forwardAIPreview` `L2633`,
  `forwardAIPolicySuppress` `L2668`, `forwardAIPolicyUnsuppress` `L2706`, `forwardAIPolicyList`
  `L2741`, `forwardAIPolicyClear` `L2765`.
- Agentic tier `L2793-L3077`: generic `agenticPost` `L2793-L2810` and `agenticGet` `L2813-L2826`
  (JSON in/out, error passthrough w/ status); thin validators using `hasWorkspaceRef(data)`
  `L2935-L2937` (workspaceRef/workspace_ref non-empty) and `hasScopedCapsule(data)` `L2939-L2941`
  (capsuleId|capsulePath AND workspaceRef); per-endpoint wrappers enforce required fields — e.g.
  distill needs command string/array (`L2830`), observations capture needs observation object (`L2838`),
  explain needs `unit` (`L2864`), validate-patch needs edits array (`L2912`), apply-approved needs
  approvalId (`L2928`); snake_case/camelCase dual-field mapping throughout (`L2947-L3077`); episode
  get rewrites `/episodes→/episode/<id>` with encodeURIComponent (`L2965-L2968`).
  Note: `socket._inFlightAnalysis` Map initialized for supersede tracking (`L277`) but never read/written
  elsewhere in this file — vestigial.

### Security posture summary

- WS auth mandatory (shared token OR HS256 JWT aud `synthi-gateway`); disabled mode double-gated.
- Per-connection rate/concurrency caps; internal error details withheld except explicit backend error
  bodies passed as `detail` on non-ok backend responses (e.g. `L684`, `L2802`).
- Outbound internal-token injection centralizes service auth (`L112-L114`).
- Caveats observable in-code: query-param tokens accepted (`L153-L154`), health endpoints unauthenticated,
  unconditional outbound-frame logging (`L3094`), listen on 0.0.0.0 (`L323`).

---

# 6. ai-backend/agent-runner

Disposable container image that runs third-party CLI coding agents (Codex / Claude Code / Hermes)
inside workspaces. Two files only.

## ai-backend/agent-runner/Dockerfile (20 L) — step by step

1. `FROM node:22-bookworm-slim@sha256:a17d50af…1b066` — digest-pinned Node 22 Debian slim (`Dockerfile:L1`).
2. Build ARGs pin agent versions: `CODEX_VERSION=0.149.0`, `CLAUDE_CODE_VERSION=2.1.240`,
   `HERMES_AGENT_VERSION=0.19.0` (`L3-L5`).
3. Single RUN layer (`L7-L14`): apt installs python3 + venv + git + ca-certificates (no recommends,
   lists cleaned); `npm install --global --omit=dev` Codex + Claude Code CLIs; creates
   `/opt/hermes` python venv and pip-installs `hermes-agent==<ver>` (Hermes ships as a Python agent
   with its CLI on PATH via step 6); creates system group/user `agent` uid/gid **10001**.
4. `COPY --chmod=0555 entrypoint.sh /usr/local/bin/agent-entrypoint` (`L16`) — world-readable/executable,
   NOT writable by the agent user.
5. `USER 10001:10001` (`L17`) — everything below runs unprivileged.
6. `ENV PATH="/opt/hermes/bin:${PATH}"` (`L18`) — hermes CLI available.
7. `WORKDIR /workspace` (`L19`); `ENTRYPOINT ["/usr/local/bin/agent-entrypoint"]` (`L20`).

## ai-backend/agent-runner/entrypoint.sh (17 L) — step by step

- `#!/bin/sh` + `set -eu` (fail on error/unset vars) (`entrypoint.sh:L1-L2`).
- Credential staging loop `L7-L15` — for each of `codex`, `claude`, `hermes`: source dir
  `/run/agent-credentials/<tool>` (expected to be mounted READ-ONLY by the orchestrator) is copied to
  a writable `/tmp/<tool>` and `chmod -R u+rwX`'d. Comment (`L4-L6`): each CLI needs a private writable
  home for sessions/caches, but because it's tmpfs-style /tmp in a disposable container, nothing
  persists after exit. Missing source dirs are skipped (`[ -d ]` guard).
- `exec "$@"` (`L17`) — replaces shell with the CMD (the actual agent invocation), so signals propagate.

Security properties: non-root uid 10001, read-only credentials volume, writable copies scoped to
container lifetime, pinned versions/digests.

---

# 7. extensions/vectant-oauth-relay

Chromium MV3 extension relaying redirected localhost OAuth callbacks into an active Vectant
workspace, removing the manual paste step. Built/copied to `synthi/public/vectant/extensions/…` by
`scripts/build-oauth-relay-extension.mjs` (wired as npm script `build:oauth-relay-extension`).

## extensions/vectant-oauth-relay/manifest.json (36 L)

- MV3, name "Vectant OAuth Relay" v0.1.0 (`manifest.json:L2-L4`).
- **permissions:** `webNavigation`, `storage` only (`L6-L9`) — no tabs, no cookies, no webRequest.
- **host_permissions:** `https://beta.vectant.dev/*` exclusively (`L10-L12`).
- **background:** module service worker background.js (`L13-L16`).
- **content_scripts:** content-bridge.js injected ONLY on `https://beta.vectant.dev/*` at
  `document_start` (`L17-L27`) — never on provider pages (README security model `README.md:L22-L23`).
- **externally_connectable.matches:** `https://beta.vectant.dev/*` (`L28-L32`) — permits
  onMessageExternal from pages on that origin.
- **action.default_title** only (`L33-L35`); no popup.

## extensions/vectant-oauth-relay/background.js (265 L)

State machine: armed session (workspace-scoped, time-boxed) + navigation interception + POST submit.

- **Constants** (`background.js:L1-L10`): storage keys `synthi.oauthRelay.armedSession` /
  `.lastSubmission`; `LOOPBACK_HOSTS = {localhost, 127.0.0.1, 0.0.0.0, ::1, [::1]}`;
  `DEFAULT_ENDPOINT_PATH='/api/oauth-relay/callback'`; `MAX_SESSION_AGE_MS = 15min`;
  module-level `pendingSessionId` guards concurrent submits.
- **Helpers:** `storageArea()` prefers `chrome.storage.session` falling back to local (`L12-L14`);
  `normalizeLoopbackHost` unwraps `[::1]` (`L20-L23`); `parseUrl` null-safe (`L25-L31`);
  `parseLoopbackUrl` (`L33-L49`) accepts only http(s) + loopback host + integer port 1–65535, returns
  `{href, host, port, path}`.
- `pathMatchesPrefix(path, prefix)` (`L51-L56`): '/' matches everything; else segment-prefix match.
- `expectedMatches(session, loopback)` (`L58-L64`): each declared expectedCallback constraint
  (host/port/pathPrefix) must hold — unconstrained fields skip.
- `isExpired(session)` (`L66-L72`): expiresAt parse-fail or past, or armedAt older than 15 min.
- Storage CRUD `getStored/setStored/removeStored` (`L74-L85`).
- `normalizeEndpoint(endpoint, senderUrl)` (`L87-L94`): endpoint must be https AND same-origin as the
  arming sender (defaults to sender.origin + DEFAULT_ENDPOINT_PATH) — prevents arming a session that
  would exfiltrate callbacks to a foreign host.
- `normalizeExpectedCallback(value)` (`L96-L106`): keeps only valid loopback hosts / sane ports /
  slash-normalized pathPrefixes.
- **Message handlers:** `armRelay(payload, sender)` (`L108-L141`) validates sessionId, workspaceSlug,
  runtimeScope, endpoint, parsable expiresAt ⇒ else `invalid_relay_session`; stores session with
  armedAt; responds `{ok:true, armed:true, …, lastSubmission}`. `extensionStatus()` (`L143-L164`)
  purges expired sessions and reports `{installed:true, armed, sessionId?, lastSubmission}`.
  `clearRelay()` (`L166-L173`).
- `submitCallback(session, callbackUrl, source)` (`L175-L214`): dedupes per session via
  `pendingSessionId`; POSTs `{sessionId, workspaceSlug, callbackUrl}` to the armed endpoint with
  `credentials:'include'` (browser cookies authenticate workspace ownership); stores lastSubmission
  `{sessionId, ok, statusCode, error, source, submittedAt}`; disarms on success; network failures
  recorded structurally.
- `maybeRelayNavigation(details, source)` (`L216-L229`): top-level frames only (`frameId===0`),
  loopback-only parse, expired sessions purged, expected-constraint match, then submit with source
  label.
- **Wiring** (`L231-L264`): `handleRuntimeMessage(message, sender, sendResponse)` dispatches exactly
  three message types — `SYNTHI_OAUTH_RELAY_STATUS` → extensionStatus, `SYNTHI_OAUTH_RELAY_ARM` →
  armRelay(payload, sender), `SYNTHI_OAUTH_RELAY_CLEAR` → clearRelay; anything else ⇒
  `{installed:true, ok:false, error:'unknown_message_type'}`; async sendResponse with `return true`
  channel keep-open. Registered on BOTH `chrome.runtime.onMessage` (content script) and
  `chrome.runtime.onMessageExternal` (page, gated by externally_connectable) (`L257-L258`).
  Navigation hooks: `webNavigation.onBeforeNavigate` + `onErrorOccurred` (loopback URLs usually
  "fail" since nothing listens — onErrorOccurred is what actually catches most callbacks) (`L259-L264`).

## extensions/vectant-oauth-relay/content-bridge.js (29 L)

Window↔extension bridge on Vectant pages only:
- `PAGE_SOURCES` accepted from page: `vectant-oauth-relay-page`, legacy `synthi-oauth-relay-page`;
  replies broadcast under both `EXTENSION_SOURCES` ids (`content-bridge.js:L1-L2`).
- On injection announces readiness posting `SYNTHI_OAUTH_RELAY_READY` under both extension source ids
  to `window.location.origin` (`L4-L9`).
- Listener (`L11-L28`): accepts only same-window messages (`event.source !== window` reject), page
  source tag, and BOTH `type` and `messageId` present; forwards `{type, payload}` via
  `chrome.runtime.sendMessage`; posts the response back as
  `` `${type}_RESULT` `` with the original messageId (so the page can correlate promises).

## Message-flow summary

```
Vectant page JS ──postMessage{source:'…-page', type:ARM|STATUS|CLEAR, messageId}──▶ content-bridge
content-bridge ──chrome.runtime.sendMessage───────────────────────────────────────▶ background SW
background ──sendResponse─────────────────────────────────────────────────────────▶ content-bridge
content-bridge ──postMessage{source:'…-extension', type:<TYPE>_RESULT, messageId}─▶ page
(browser navigates to http://localhost:<port>/cb?code=…)
webNavigation.onBeforeNavigate/onErrorOccurred ──▶ maybeRelayNavigation ──▶ POST https://beta.vectant.dev/api/oauth-relay/callback
```

Backend counterpart: `synthi/src/lib/oauthRelayServer.js` + `synthi/src/app/auth/loopback/page.jsx`
(grep SYNTHI_OAUTH_RELAY), serving the zips from `synthi/public/vectant/extensions/…`.

---

# 8. Root wiring

## package.json (root, 22 L)

- Private monorepo `vectant-ade`. **workspaces:** `["synthi", "mcp/synthi-mcp", "packages/*"]`
  (`package.json:L4`) — hoists the MCP SDK for programs-mcp/mcp-hub and makes `@synthi/mcp-hub`,
  `@vectant/atomic-orchestrator`, `@synthi/programs-mcp` resolvable inside `synthi` and
  `mcp/synthi-mcp`. NOTE: `ai-backend/gateway` is NOT a workspace member — it owns its own
  package-lock and `npm ci` in its Dockerfile.
- Scripts: `start:collab` → `node ./backend/collab-server/server.js`;
  `build:oauth-relay-extension` → `node ./scripts/build-oauth-relay-extension.mjs` (`L7-L8`).
- Deps: `@google/genai ^1.30.0`, `diff ^8.0.2`; devDeps `@playwright/test ^1.60.0`, `@types/node ^25`.

## .mcp.json (repo root, 8 L)

- Project-scoped MCP registration consumed by any MCP host opened in the repo (Claude Code, Cursor…):
  server **`vectant-programs`** = `node packages/programs-mcp/src/index.js` (`.mcp.json:L1-L8`).
- This is the ONLY consumer wiring for programs-mcp; see README registration section above.
- There is NO `mcp/.mcp.json` (checked — absent); the sibling `mcp/synthi-mcp` is a workspace package
  served differently (via its own server), not registered here.

## playwright.config.ts (~110 L)

- Standard Playwright config: `testDir './tests'`, `fullyParallel`, CI-only `forbidOnly` +
  `retries: 2` + `workers: 1`, reporter html, `trace: 'on-first-retry'` (`playwright.config.ts:L14-L31`).
- Projects: chromium, firefox, webkit (Desktop devices); mobile/branded-browser projects commented out
  (`L34-L66`). No baseURL; `webServer` block commented out — tests assume servers started externally
  (see `tests/*.spec.ts`: local-support admin/desktop-shell/live-cloud/live-daemon/live-relay/staging
  smoke suites + `tests/security/` incl. k8s-network-policies test).

---

## Cross-cutting observations

1. **Two security frontiers, mirrored:** mcp-hub (network egress SSRF) and programs-mcp hostEscape
   (command escape) both implement advisory-vs-authoritative patterns — the authoritative gates live
   in the synthi backend; these packages are hardened convenience layers.
2. **Digest pinning discipline:** y-sweet image, gateway node:20-alpine, agent-runner node:22-bookworm-slim
   and even npm agent versions are all pinned (digests/ARGs).
3. **Gateway concentration risk:** all 74 WS funneled into one 3.1k-line file; adding a backend route
   touches URL constant + case + forwarder. The agentic tier shows the intended endgame: generic
   post/get helpers + thin validators.
4. **Vestigial/dead bits:** `socket._inFlightAnalysis` supersede map unused (server.js:L277);
   `backend/backend/**` duplicate tree exists on disk (canonical paths are the top-level ones);
   atomic-orchestrator imported by relative path rather than workspace name in agent-routing libs.

---

## Related

[[Supporting Services]] · [[Collab Server]]

[[00 Home|🏠 Back to Home]]
