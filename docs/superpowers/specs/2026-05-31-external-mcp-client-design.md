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
| **A. Shared Node package** hosted in the gateway, imported by `synthi-mcp` | One reusable hub library consumed by the two Node services already running | **Chosen** |
| B. Client in Python ai-engine | `synthi-mcp` (Node) cannot reuse it; duplicate impl | Rejected |
| C. New standalone microservice | Extra deployable + ops for v1 | Rejected (revisit if pooling needed) |

Rationale: same language as `synthi-mcp`, the MCP SDK client is **already** a dependency there,
no new deployable, and the gateway is already the in-app AI's tool conduit.

### Component diagram

```
┌─ Frontend ──────────────┐   Next API routes              ┌─ Postgres (Prisma) ──┐
│ "Connected Tools" panel  │ ─► /api/integrations/* ──────► │ McpConnection         │
│ (reuses GitHub-token UX) │   (CRUD + test + encrypt)     │ EncryptedSecret(vault)│
└──────────────────────────┘                               └──────────┬────────────┘
                                                    internal, gateway-token authed
                                                                       │ (decrypted cfg)
        in-app AI path                                                 ▼
  Python ai-engine ──HTTP──► Gateway ──imports──► @synthi/mcp-hub ──HTTPS──► remote MCP
  (agentic tool loop)        /internal/mcp/*       (live MCP client sessions)  servers
                                                          ▲                  (GitHub, Sentry,
  CLI agents ──► synthi-mcp ──imports─────────────────────┘                   Linear, TesterArmy…)
                 (proxies external tools)
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

**c. `@synthi/mcp-hub` (the reusable client)**
Location: `ai-backend/mcp-hub/` (new package), imported by both the gateway and `synthi-mcp`.
API surface:
- `connect(config) -> session` — opens an MCP client session over Streamable-HTTP or SSE,
  injects auth header.
- `listTools(config) -> ToolSchema[]`
- `callTool(config, toolName, args) -> result`
- `testConnection(config) -> { ok, serverInfo, toolCount, error? }`
- `health(config) -> state`
Responsibilities: live session management + reconnect, auth injection, per-call timeout,
SSRF guard on `url`, normalized error envelope. No persistence (caller passes resolved config).

**d. Gateway integration**
- New WS actions for the frontend: `mcp/list-tools`, `mcp/call-tool` (added to the `action`
  switch in `server.js`).
- New internal HTTP API for the engine: `POST /internal/mcp/tools`, `POST /internal/mcp/call`,
  authed with the existing gateway token/JWT (`isAuthorizedGatewayRequest`).
- Gateway resolves connection config + decrypts the secret (via a small data-access module that
  reads Postgres) before handing to the hub. Keep `server.js` lean: put MCP wiring in a new
  `ai-backend/gateway/mcp/` module, not inline in the 2,926-line file.

**e. Engine integration**
In agentic chat flows: fetch scoped tool schemas from the gateway internal API, convert them to
Gemini function declarations named `ext__<server>__<tool>`, and on a function call POST to
`/internal/mcp/call`. New module `ai-engine/integrations/mcp_tools.py`; wire into the existing
chat/agent loop. Provider-agnostic enough to map to other LLM providers later.

**f. `synthi-mcp` integration**
Import `@synthi/mcp-hub`; when an agent attaches, list connected external tools for that
session's scope and advertise them as proxied tools `ext__<server>__<tool>`, dispatching calls
through the hub. Zero per-tool code: any connected MCP's tools appear automatically.

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

1. Engine requests tools from the gateway internal API, scoped to `{userId, workspaceSlug}`,
   filtered to `enabled` + allowlisted.
2. Engine adds them to the LLM's function declarations.
3. LLM emits e.g. `ext__github__create_pull_request({...})`.
4. Engine POSTs `/internal/mcp/call` → gateway resolves+decrypts config → hub routes to the
   live session → returns the result.
5. Result is fed back into the agent loop; the AI responds to the user.

### Data flow / scope resolution

- **Personal** connections: visible to their `ownerUserId` in every workspace.
- **Workspace** connections: visible to all members of `workspaceSlug`; require membership to
  create/edit. The effective tool set for a chat = personal (this user) ∪ workspace (this slug),
  deduped by connection `name`.

---

## Security

- **Encryption at rest:** AES-256-GCM via the existing key/passphrase convention. Decrypted
  config never leaves the server except over the internal gateway-authed endpoint.
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
- **gateway (node tests):** new WS actions and internal HTTP endpoints resolve config, decrypt,
  and delegate to a stubbed hub; auth enforced.
- **engine (pytest):** tool-schema injection + call routing against a stubbed gateway endpoint;
  function-name mapping `ext__<server>__<tool>`.
- **frontend (component tests):** add-connection form validation, list rendering, test-result
  display, allowlist toggles; light/dark theme (no hardcoded colors).
- **manual E2E (documented):** connect a real hosted MCP (e.g. a public reference server);
  confirm (a) the in-app AI calls a tool and uses the result, and (b) a CLI agent attached via
  `synthi-mcp` sees the proxied tool. Capture evidence.

## Rollout / Config

- New env: none required beyond the existing encryption key; optional
  `SYNTHI_MCP_SSRF_ALLOWLIST` (comma-separated hosts) for self-hosted tools.
- Prisma migration adds `EncryptedSecret`, `McpConnection`, and (optional) `McpCallAudit`.
- Feature is additive: existing analyzer/healing actions and the synthi-mcp server are
  unchanged when no connections exist.

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
