# Slice 1 — Foundation + External MCP Client

**Date:** 2026-05-31
**Branch:** `tool-compatability`
**Status:** Approved design, pending implementation plan

---

## Context

Synthi wants to interoperate with the standard external developer toolchain (Docker,
Kubernetes, Git hosts, QA platforms such as TesterArmy, observability backends, issue
trackers, etc.). The full ambition spans four directions the user confirmed they want:

1. **Connect tools in-app** — users/AI connect external accounts and the in-app AI can call them.
2. **Run toolchains in workspace** — Docker/K8s/CI run inside the dev environment.
3. **Make Synthi drivable** — harden Synthi's own open protocols so external systems can drive it.
4. **Deploy to external targets** — push projects out to registries/clusters/PaaS.

That is 6–7 independent subsystems. Rather than one oversized spec, the work is decomposed
into independently shippable slices (see Roadmap at end). **This document specs the first
slice only.**

### Existing systems this slice builds on (verified)

- **MCP** lives at `mcp/synthi-mcp/` — a Phase-1 MCP *server* (33 tools) that exposes Synthi's
  preview/session to external CLI AI agents over stdio→WebRTC. It depends on
  `@modelcontextprotocol/sdk ^1.0.0`, which ships both server **and client** classes. It cannot
  currently act as an MCP *client* to reach external tools.
- **Gateway** at `ai-backend/gateway/server.js` (~2,926 lines) is a clustered WebSocket→HTTP
  proxy with a clean `action` switch. The in-app AI (frontend chat) talks to it over WS; it
  forwards to the Python `ai-engine` over HTTP. It is gateway-token / JWT authenticated.
- **ai-engine** (Python, FastAPI) runs the LLM flows (Gemini + others via
  `llm/providers/factory.py`).
- **Frontend** (`synthi/`) is Next.js + Tailwind 4 + Radix, themed via runtime CSS variables;
  reusable primitives in `components/ui/`; docking window manager with a `registerPanel()` API
  and `IDE_PANEL` constants; AI chat in `components/chat/AIChatWindow.jsx`. It runs **Prisma +
  Postgres** and already has an encrypted credential precedent: the GitHub-token block in
  `SettingsPanelContent.jsx` backed by `/api/user/github-token` and an AES-256-GCM store in
  `backend/collab-server/gitService.js`.

## Goal

Let **both** the in-app AI chat **and** attached CLI agents call tools exposed by **external,
remote (HTTP/SSE) MCP servers** that users connect from inside Synthi. Build the reusable
foundation (credential vault + connections registry + "Connect a tool" UI) that every later
slice will also use.

## Non-Goals (explicitly out of this slice)

- OAuth 2.0 authorization flows (token/header auth only for now; OAuth is a later slice).
- Local **stdio** MCP servers / spawning subprocesses in the worker (remote transport only).
- MCP **resources** and **prompts** (tools only for v1).
- Git provider abstraction (GitLab/Bitbucket), DAP/debugging, workspace toolchains, deploy
  targets, OpenTelemetry — all separate slices.
- Cross-consumer connection pooling / shared session reuse between the gateway and synthi-mcp
  (each process maintains its own hub sessions in v1).

## Success Criteria

1. A user can open a "Connected Tools" panel, add a remote MCP server (URL + optional bearer
   token / header), choose **personal** or **workspace** scope, and see a live health
   indicator plus the list of tools the server exposes.
2. Stored secrets are encrypted at rest and **never** returned to the browser.
3. In the in-app AI chat, the user can ask the AI to perform an action that requires a connected
   tool (e.g. "open a GitHub PR"), and the AI calls the external tool and uses the result.
4. A CLI agent attached via `synthi-mcp` sees the connected external tools as proxied tools.
5. The user controls, per connection, which tools the AI is allowed to call (allowlist).
6. Connecting to a disallowed/internal URL is rejected (SSRF guard).
7. All new code paths have unit tests; a documented manual E2E confirms both consumers.

---

## Architecture

### Decision: the MCP client is a shared Node package `@synthi/mcp-hub`

Both consumers must reach the client. Options considered:

| Option | Summary | Verdict |
|--------|---------|---------|
| **A. Shared Node package** imported by the Next.js app and `synthi-mcp` | One reusable hub library consumed by both Node consumers | **Chosen** |
| B. Client in Python ai-engine | `synthi-mcp` (Node) cannot reuse it; duplicate impl | Rejected |
| C. New standalone microservice | Extra deployable + ops for v1 | Rejected (revisit if pooling needed) |

Rationale: same language as `synthi-mcp`, the MCP SDK client is **already** a dependency there,
and no new deployable.

> **Architecture correction (verified post-spec):** the in-app AI's agentic tool loop does **not**
> run through the gateway/Python engine — it lives entirely in the Next.js route
> `synthi/src/app/api/chat/route.js` (`buildToolDeclarations()`, `runAgentLoop()`,
> `executeToolCall()`, `runtime = 'nodejs'`), which already has Prisma access. The gateway/engine
> handle only analyze/heal flows. Therefore the hub is imported **directly** by the Next.js chat
> route (in-app consumer) and by `synthi-mcp` (CLI consumer); `synthi-mcp` obtains scoped,
> decrypted connection configs from a single internal Next.js endpoint (DB access stays in one
> place). **The gateway requires no changes for this slice.**

> **Security rationale — why in-process, not via the gateway (decided 2026-05-31):** routing the
> tool loop through the gateway was considered for "single egress chokepoint" reasons and
> rejected. The gateway has **no user identity and no DB access** (shared-token/JWT proxy), so the
> per-user / per-workspace **authorization** that this feature requires can only be enforced
> correctly in the Next.js route, where the authenticated NextAuth session and Prisma live. The
> threats that actually matter for external tools — SSRF, credential theft, prompt-injection via
> tool output, destructive actions — are host-independent and are mitigated in the **hub library +
> connection store** (SSRF guard, write-only encrypted secrets, fail-closed allowlist, audit,
> timeouts), which **both** consumers share. True blast-radius isolation (running untrusted egress
> in a minimal-privilege process) is a real but separate concern the *current* gateway does not
> provide; because the hub is a persistence-free library, lifting it into a dedicated isolated
> egress service later is a non-breaking change. That is deferred to a future hardening slice.

### Implementation is split into two plans

The approved slice covers both consumers, but is delivered as two sequential plans so each ships
working, testable software:

- **Plan 1a (this plan):** foundation (`EncryptedSecret`, `McpConnection`, `McpCallAudit` + Prisma
  migration), the `@synthi/mcp-hub` library, the connection store + crypto, `/api/integrations/*`
  CRUD, the "Connected Tools" panel, and the **in-app AI** wiring in `/api/chat`. End-to-end
  usable on its own.
- **Plan 1b (fast-follow):** the `/api/internal/mcp/resolve` endpoint and the `synthi-mcp`
  wiring (components **f** above), reusing the same hub. Specced here; planned separately.

### Component diagram

```
┌─ Frontend ──────────────┐   Next API routes              ┌─ Postgres (Prisma) ──┐
│ "Connected Tools" panel  │ ─► /api/integrations/* ──────► │ McpConnection         │
│ (reuses GitHub-token UX) │   (CRUD + test + encrypt)     │ EncryptedSecret(vault)│
└──────────────────────────┘                               └──────────┬────────────┘
                                                    internal, gateway-token authed
                                                                       │ (decrypted cfg)
   in-app AI path (Plan 1a)                                            ▼
  Browser chat ─► /api/chat (Next.js, nodejs) ──imports──► lib/mcp-hub ──HTTPS──► remote MCP
                 streamGeminiWithTools                     (SSRF guard,           servers
                                                            per-call session)    (GitHub, Sentry,
   CLI agent path (Plan 1b)                                       ▲               Linear, TesterArmy…)
  CLI agents ─► synthi-mcp ─► /api/internal/mcp/resolve ─► same lib/mcp-hub ──────┘
                              (token-authed config fetch)
```

### Components

**a. Credential vault (`EncryptedSecret`)**
Generic encrypted secret store. Reuses the existing AES-256-GCM helper and
`SYNTHI_TOKEN_ENCRYPTION_KEY` / `SYNTHI_TOKEN_ENCRYPTION_PASSPHRASE` convention. Secrets are
**write-only from the UI** — the API accepts a secret on create/update and returns only a
`secretId` + non-sensitive metadata (e.g. last-4, created-at). Built generic so later slices
store kubeconfigs, registry creds, OAuth refresh tokens here too.

**b. Connections registry (`McpConnection`)**
Fields: `id, name, url, transport('http'|'sse'), scope('personal'|'workspace'),
ownerUserId (nullable), workspaceSlug (nullable), authType('none'|'bearer'|'header'),
headerName (nullable), secretId (nullable, FK to EncryptedSecret), toolAllowlist (string[] |
null = all), enabled (bool), createdAt, updatedAt, lastHealthState, lastHealthAt`.
Constraint: exactly one of `ownerUserId` / `workspaceSlug` set per `scope`.

**c. `mcp-hub` (the reusable client library)**
Location for Plan 1a: `synthi/src/lib/mcp-hub/` (plain ESM modules Next.js imports natively;
adds `@modelcontextprotocol/sdk` to `synthi/package.json`). Plan 1b extracts/shares it with
`synthi-mcp`; because it is persistence-free this relocation is non-breaking.
API surface (no `connect`/`health` in v1 — sessions are per-call):
- `listTools(config) -> { ok, tools? , error? }` — opens a short-lived MCP client session over
  Streamable-HTTP or SSE, injects auth header, returns tool schemas.
- `callTool(config, toolName, args) -> { ok, data?, error? }`
- `testConnection(config) -> { ok, serverInfo?, toolCount?, error? }`
Responsibilities: per-call MCP client session, auth injection, per-call timeout, **SSRF guard on
`url`**, normalized error envelope. **No persistence** (caller passes a resolved config object).

**d. Connection store + vault (Next.js, single source of DB truth)**
A server-only module `synthi/src/lib/integrations/connectionStore.js` over Prisma:
`listConnections(scope)`, `createConnection()`, `updateConnection()`, `deleteConnection()`,
`resolveToolConfigs(scope)` (returns enabled+allowlisted connections with **decrypted** secrets
for hub use). Encryption **reuses the existing `synthi/src/lib/tokenCrypto.js`**
(`encryptToken`/`decryptToken`, AES-256-GCM, key derived from **`AUTH_SECRET`**, cipher format
`iv:tag:ct`) — no new crypto module. `EncryptedSecret.cipher` stores that `iv:tag:ct` string.
(Note: `AUTH_SECRET` is the Next.js convention; the collab-server's separate
`SYNTHI_TOKEN_ENCRYPTION_KEY` store is unrelated and untouched.)

**e. In-app AI integration (Next.js chat route)**
In `synthi/src/app/api/chat/route.js` (`streamGeminiWithTools`): append external tools (named
`ext__<connId>__<tool>`) to the `tools = [{ functionDeclarations: TOOL_DECLARATIONS }]` array,
fetched via the hub from `resolveToolConfigs(scope)`; and in the `functionCall` dispatch, route
`ext__*` names through `hub.callTool()`. Tool-discovery is wrapped so a failing connection never
breaks the chat turn (degrade gracefully). Each external call is written to `McpCallAudit`.
(v1 wires the Gemini loop, the default provider; Anthropic/OpenAI parity is a small follow-up.)

**f. `synthi-mcp` integration (Plan 1b — specced, planned separately)**
Import the hub; on agent attach, fetch scoped configs from `/api/internal/mcp/resolve`
(token-authed via `SYNTHI_INTERNAL_API_TOKEN`) and advertise external tools as proxied tools
`ext__<connId>__<tool>` in the `TOOLS` list + `CallToolRequestSchema` dispatch, calling through
the hub. Zero per-tool code: any connected MCP's tools appear automatically.

**g. Connect-a-tool UI ("Connected Tools" panel)**
A dedicated docking panel registered as `IDE_PANEL.INTEGRATIONS` (chosen over a Settings
subsection because connections are a list-with-detail: discovered tools, health dot, scope
badge, per-tool allowlist toggles). Must visually match the app:
- Theme CSS variables for all colors (no hardcoded hex).
- `Button`, `Input`, `Dialog`, `Switch` from `components/ui/`.
- `lucide-react` icons; `sonner` toasts for feedback.
- The exact input → **Save** → **Test** → results pattern already used by the GitHub-token block.
Panel contents: list of connections (name, scope badge, health dot, enabled toggle); "Add
connection" dialog (name, URL, transport, scope, auth type, secret, optional header name);
detail view (discovered tools with allowlist checkboxes, Test button, Remove).

### Tool-call flow (in-app AI)

1. `/api/chat` resolves the caller's scope `{userId, workspaceSlug}` and calls
   `resolveToolConfigs(scope)` → enabled + allowlisted connections with decrypted secrets.
2. For each connection, `buildToolDeclarations()` calls `hub.listTools(config)` and appends the
   tools as `ext__<connId>__<tool>` to the existing built-in declarations.
3. The LLM emits e.g. `ext__<connId>__create_pull_request({...})`.
4. `executeToolCall()` recognizes the `ext__` prefix → `hub.callTool(config, tool, args)` → result
   is written to `McpCallAudit` and fed back into `runAgentLoop`.
5. The AI responds to the user. (CLI agents follow the same hub path, sourcing configs from
   `/api/internal/mcp/resolve` instead of the in-process store.)

### Data flow / scope resolution

- **Personal** connections: visible to their `ownerUserId` in every workspace.
- **Workspace** connections: visible to all members of `workspaceSlug`; require membership to
  create/edit. The effective tool set for a chat = personal (this user) ∪ workspace (this slug),
  deduped by connection `name`.

---

## Security

- **Encryption at rest:** AES-256-GCM via the existing `tokenCrypto.js` (`AUTH_SECRET`-derived
  key). Decrypted config never leaves the server except over the internal token-authed
  `/api/internal/mcp/resolve` endpoint (Plan 1b).
- **Write-only secrets:** UI/API never return secret material; only `secretId` + metadata.
- **SSRF guard:** the hub validates connection URLs before any request — block loopback,
  link-local, RFC-1918, and cloud metadata IPs (169.254.169.254) by default, with an explicit
  admin allowlist override for self-hosted tools. Essential because the server fetches
  user-supplied URLs.
- **Tool allowlist:** per connection, the user approves which tools the AI may call. The default
  is **fail-closed** — a newly added connection has no tools enabled until the user reviews the
  discovered list and opts specific tools in. This prevents surprise actions from a freshly
  connected server.
- **Scope authorization:** workspace connections enforced against workspace membership; personal
  against the authenticated user.
- **Audit log:** record `{connectionId, server, tool, userId, workspaceSlug, outcome, ts}` per
  call (table or structured log; table preferred for later UI).
- **Timeouts + rate limits:** per-call timeout in the hub; reuse the gateway's existing
  per-connection rate limiting for the new WS actions.

## Error Handling

- Hub returns a normalized envelope `{ ok, data?, error?: { code, message } }`; never throws raw
  network errors across the boundary.
- Connection test surfaces actionable states: `unreachable`, `auth_failed`, `tls_error`,
  `ssrf_blocked`, `protocol_error`, `ok`.
- A failing tool call returns a structured error to the LLM loop so the model can recover or
  report, and is written to the audit log with `outcome: error`.
- Health is sampled lazily (on panel open / on demand) in v1 — no background poller — to keep
  scope small.

## Testing Strategy

- **hub (vitest):** against a mock MCP server — connect, listTools, callTool, auth-header
  injection, per-call timeout, normalized errors, **SSRF rejection** cases.
- **vault + API (Next route tests):** encrypt/decrypt round-trip; secret never returned to
  client; scope authorization (personal vs workspace membership).
- **connection store (vitest):** CRUD; `resolveToolConfigs` filters to enabled+allowlisted and
  decrypts; scope resolution (personal ∪ workspace).
- **chat route (vitest):** `buildToolDeclarations` appends `ext__<connId>__<tool>` from a stubbed
  hub and degrades gracefully when a connection errors; `executeToolCall` routes `ext__*` to the
  hub and writes an audit row.
- **internal resolve endpoint (vitest):** returns scoped configs only with a valid
  `SYNTHI_INTERNAL_API_TOKEN`; rejects otherwise.
- **frontend (component tests):** add-connection form validation, list rendering, test-result
  display, allowlist toggles; light/dark theme (no hardcoded colors).
- **manual E2E (documented):** connect a real hosted MCP (e.g. a public reference server);
  confirm (a) the in-app AI calls a tool and uses the result, and (b) a CLI agent attached via
  `synthi-mcp` sees the proxied tool. Capture evidence.

## Rollout / Config

- New env: the existing `AUTH_SECRET` (already required by NextAuth + `tokenCrypto.js`);
  `SYNTHI_INTERNAL_API_TOKEN` (Plan 1b — shared secret for `synthi-mcp` → `/api/internal/mcp/resolve`);
  optional `SYNTHI_MCP_SSRF_ALLOWLIST` (comma-separated hosts) for self-hosted tools.
- Prisma migration adds `EncryptedSecret`, `McpConnection`, and `McpCallAudit`.
- Feature is additive: the gateway, Python engine, analyzer/healing flows, and the built-in chat
  tools are unchanged when no connections exist. **The gateway is not modified by this slice.**

---

## Roadmap (subsequent slices — not this spec)

| # | Slice | Direction | Depends on |
|---|-------|-----------|------------|
| **1** | **Foundation + External MCP client (this doc)** | Connect in-app + drivable | — |
| 2 | Git provider abstraction (GitLab/Bitbucket/enterprise, OAuth device-flow, webhooks) | Connect in-app | 1 |
| 3 | Workspace toolchains (Docker/K8s CLIs, devcontainers spec inside workspace) | Run in workspace | — |
| 4 | Deploy targets (OCI registries, K8s, PaaS) | Deploy out | 1, 3 |
| 5 | Make Synthi drivable (harden MCP server, inbound webhooks/REST) | Drivable | 1 |
| 6 | DAP / debugging (wire the stubbed `extensions/api/debug.js`) | Cross-cutting | LSP |
| 7 | Observability (OpenTelemetry export) | Cross-cutting | — |

The shared foundation (vault + connections registry + Connect UI) built in Slice 1 is reused by
slices 2, 4, and 5.
