# Slice 1b — CLI-Agent External-MCP Consumer

**Date:** 2026-06-02
**Branch:** `tool-compatibility-1b` (off `tool-compatibility`)
**Status:** Approved design, pending implementation plan
**Builds on:** Slice 1a (in-app external MCP client, HEAD `956a70b6`). The shared foundation —
encrypted vault (`EncryptedSecret`), connection registry (`McpConnection`), the persistence-free MCP
hub, scope/role authz, rate limits, the Connected Tools panel, and the in-app AI wiring — already
exists and is **not** rebuilt here.

> **Canonical conventions inherited from Slice 1a + addendum R1** (these are authoritative and
> unchanged): the external-tool name is the numeric alias **`ext_<i>`** mapped to `{connId, toolName}`;
> the tool allowlist is **fail-closed `String[]`** (empty = none); the audit row stores only a
> **sha256 arg-hash + byte sizes** (never raw args/secrets); the **SSRF guard** (pin + redirect
> re-validation) runs in the hub on every outbound URL; connections are keyed by **`id`**, never name;
> identity for DB ownership is the **Prisma `User` cuid**, never the OAuth provider id.

---

## Context

Slice 1a let the **in-app AI chat** call tools on external, remote MCP servers that users connect
inside Synthi. The agentic tool loop lives entirely in the Next.js route
`synthi/src/app/api/chat/route.js` (`buildExternalTools` / `callExternalTool` in
`synthi/src/app/api/chat/externalTools.js`), which has Prisma access and the authenticated NextAuth
session.

The **second consumer** — CLI AI agents (e.g. Claude Code) attached via `synthi-mcp`
(`mcp/synthi-mcp/`, a published TypeScript ESM MCP **server**, 40+ `synthi_*` tools over
stdio→WebRTC) — cannot yet see those connected tools. Closing this is the last open piece of Slice 1
(success criterion #4).

### Verified ground truth (this session)

- **`synthi-mcp` has no Synthi user identity.** It attaches to a *preview session* by `sessionId` +
  `signalingUrl` over WebRTC (`src/tools/attach.ts`). The Phase-4 auth model
  (`docs/PHASE_4_AUTH.md`) is an HS256 JWT `{subject, session_id, role, expiry}` verified by the
  **signaling-server** on register — a transport-layer credential whose `subject` is an arbitrary
  agent label, **not** a Synthi user/DB identity.
- **`synthi-mcp` server shape** (`src/server.ts`): a static `TOOLS` array fed to
  `ListToolsRequestSchema`, and a `dispatchTool(name, …)` switch keyed on tool name, gated by a quota
  check in the `CallToolRequestSchema` handler. The MCP capability is `tools: {}` (no `listChanged`),
  so the advertised tool set is built once at server creation. Launch config already comes from
  env/CLI (`SYNTHI_SESSION_ID`, `SYNTHI_SIGNALING_URL`) via a tiny dotenv loader (`src/util/env.ts`)
  that never overrides host-provided env.
- **The repo has no workspace/monorepo tooling.** Root `package.json` is minimal (no `workspaces`).
  `synthi/` and `mcp/synthi-mcp/` are independent packages; `synthi-mcp` is published to GitHub
  Packages as `@synthi-inc/mcp-server` and already depends on `@modelcontextprotocol/sdk ^1.0.0`.
- **The hub** (`synthi/src/lib/mcp-hub/`) is plain ESM JS (`ssrfGuard.js`, `client.js`, `helpers.js`,
  `guardedFetch.js`, `index.js` + `__tests__`), richly JSDoc'd, imported natively by Next.js.
- **The audit schema is already complete** for the CLI path: `McpCallAudit` has `callerType`
  (`'chat'|'cli'`), `alias`, `durationMs`, `argsHash`, `argsBytes`, `resultBytes`, and a nullable
  `connectionId` (`onDelete: SetNull`). **No `McpCallAudit` schema change is needed.**
- **`SYNTHI_INTERNAL_API_TOKEN` does not exist in code** — it was a roadmap placeholder. This design
  supersedes it (see Decisions).

## Goal

Let a CLI agent attached via `synthi-mcp` see the connecting user's enabled + allowlisted external MCP
tools as proxied `ext_<i>` tools and call them — sourced through the **same** `@synthi/mcp-hub`
library, authenticated as a specific Synthi user, with the full Slice-1 security spine now applied on
the CLI path.

## Decisions (resolved at kickoff)

1. **Identity = per-user Personal Access Token (PAT), built now.** `synthi-mcp` authenticates to
   Synthi with a user-issued PAT; the resolve/audit endpoints **derive** the `userId` (Prisma cuid)
   from the token and never trust a client-asserted identity. This is multi-tenant-safe (correct for
   SaaS / user-laptop deployments). The PAT is the single internal credential — there is **no** shared
   `SYNTHI_INTERNAL_API_TOKEN`.
2. **Hub sharing = a real shared package `@synthi/mcp-hub`** imported by both `synthi` and
   `synthi-mcp` (single implementation of the security-critical SSRF/client code; no TS
   re-implementation, no divergence). Consequence: decrypted configs travel to `synthi-mcp` over the
   PAT-authed resolve endpoint, and the CLI-path audit round-trips a redacted row back to Next.js
   (Prisma access stays in one place). Both consequences are accepted (see Security ⚠️).
3. **Extraction mechanics = P1:** move the hub to top-level `packages/mcp-hub/` and introduce **npm
   workspaces** at the repo root. Keep the hub as ESM **JS**; generate `.d.ts` from its existing
   JSDoc. (No rewrite of audited Slice-1 code.)
4. **Released-artifact handling = deferred.** v1 targets running `synthi-mcp` from the monorepo
   (source). Publishing/bundling `@synthi/mcp-hub` into the released CLI is a documented follow-up;
   `npm publish` of `synthi-mcp` may be temporarily unresolvable until then.
5. **Route home = `/api/integrations/mcp/{resolve,audit}`** (PAT-authed, user-facing) rather than the
   roadmap's `/api/internal/mcp/resolve` — because PAT auth makes these reachable user endpoints, not
   service-token "internal" ones. PAT issuance lives at `/api/integrations/tokens` (NextAuth-gated).

## Non-Goals (explicitly out of this slice)

- Publishing or bundling `@synthi/mcp-hub` for an external `npm install` of `synthi-mcp` (Decision 4).
- PAT **expiry / rotation** (v1 PATs are revocable but do not expire; `expiresAt` is a trivial
  follow-up).
- **Lazy / live re-resolution** of external tools (v1 resolves once at `synthi-mcp` startup, matching
  the static `TOOLS` list and the no-`listChanged` capability).
- Server-mediated **per-call** gating of CLI external calls (would require the proxy model, which was
  considered and not chosen — see Security ⚠️ #2).
- OAuth flows, stdio/local MCP servers, MCP resources/prompts — all out of Slice 1 entirely.

## Success Criteria

1. A user can generate a PAT in the Connected Tools panel (plaintext shown exactly once), see it
   listed (name + last-4 + created/last-used), and revoke it.
2. With `SYNTHI_API_URL` + `SYNTHI_PAT` configured, an attached CLI agent's `ListTools` returns the
   built-in `synthi_*` tools **plus** the user's enabled + allowlisted external tools as `ext_<i>`.
3. The CLI agent can call an `ext_<i>` tool; it routes through `@synthi/mcp-hub.callTool` to the
   remote MCP server and the result is returned as an MCP `CallToolResult`.
4. Each CLI external call writes an `McpCallAudit` row with `callerType='cli'`, the acting user's cuid,
   and only a sha256 arg-hash + byte sizes (no raw args/secrets).
5. The resolve/audit endpoints reject a missing/invalid/revoked PAT (401) and never return another
   user's data; workspace tools require membership (`canReadScope`), else degrade to personal-only.
6. When `SYNTHI_API_URL`/`SYNTHI_PAT` are absent, `synthi-mcp` behaves **byte-identically to today**
   (external tools simply off).
7. The hub extraction is behavior-preserving: all existing Slice-1 tests pass from the package's new
   home, and `synthi` (`next build`) + `synthi-mcp` (`tsc`) + `collab-server` still build/run.
8. All new code paths have unit tests; a documented manual E2E confirms the CLI consumer end-to-end.

---

## Architecture

```
CLI agent (Claude Code, …)
   │  stdio (MCP)
   ▼
synthi-mcp  ──imports──►  @synthi/mcp-hub  (packages/mcp-hub; shared, persistence-free)
   │                                  │
   │ HTTPS + PAT (Bearer)             │ HTTPS (SSRF-guarded, redirect re-validated)
   ▼                                  ▼
 Next.js (synthi/)                  remote MCP servers (GitHub, Sentry, Linear, TesterArmy, …)
   /api/integrations/mcp/resolve   ◄── reuses resolveToolConfigs + canReadScope
   /api/integrations/mcp/audit      ◄── writes McpCallAudit (callerType='cli')
   /api/integrations/tokens (CRUD) ◄── PAT issuance/revocation (NextAuth session)
   │
   ▼
 Postgres (Prisma): + PersonalAccessToken
 (McpConnection / EncryptedSecret / McpCallAudit unchanged)
```

**Two trust planes:**
- **PAT issuance** (`/api/integrations/tokens`) — authenticated by the **NextAuth browser session**
  via `resolveActor()` (→ Prisma `User` cuid), exactly like the rest of `/api/integrations/*`.
- **Resolve / audit** (`/api/integrations/mcp/*`) — authenticated by the **PAT** (Bearer header). The
  `userId` is read from the matched `PersonalAccessToken` row (already a cuid), so the
  cuid-vs-provider-id hazard from Slice 1a cannot recur on this path.

### Components

**a. `@synthi/mcp-hub` shared package (P1 extraction).**
- Move `synthi/src/lib/mcp-hub/{ssrfGuard,client,helpers,guardedFetch,index}.js` and its `__tests__/`
  to `packages/mcp-hub/src/`. Package manifest: `{ "name": "@synthi/mcp-hub", "type": "module",
  "main": "src/index.js", "exports": { ".": "./src/index.js", "./helpers": "./src/helpers.js" },
  "types": "dist/index.d.ts" }`.
- **Types:** generate `.d.ts` from the existing JSDoc via a `build:types` script
  (`tsc --allowJs --declaration --emitDeclarationOnly --outDir dist`). No source rewrite to TS.
- **Workspaces:** root `package.json` becomes `"private": true` with
  `"workspaces": ["synthi", "mcp/synthi-mcp", "packages/*"]`. Both consumers add
  `"@synthi/mcp-hub": "*"`.
- **`synthi` consumer:** rewrite imports `@/lib/mcp-hub` → `@synthi/mcp-hub` and
  `@/lib/mcp-hub/helpers.js` → `@synthi/mcp-hub/helpers` (call sites in
  `app/api/chat/externalTools.js` and any tests). Add `transpilePackages: ['@synthi/mcp-hub']` to
  `next.config`. **No logic change** — the in-app path stays byte-identical.
- **`jsonSchemaToGemini`** remains in the package (a pure helper) but is **not** imported by
  `synthi-mcp`, which advertises native MCP schemas (raw `tool.inputSchema`).

**b. `PersonalAccessToken` Prisma model.**
```prisma
model PersonalAccessToken {
  id         String    @id @default(cuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  name       String                       // user label, e.g. "laptop / claude-code"
  tokenHash  String    @unique            // sha256(token) hex — raw token NEVER stored
  last4      String?                       // display hint only
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?
  revokedAt  DateTime?
  @@index([userId])
}
```
- Add the back-relation `tokens PersonalAccessToken[]` to `User`.
- Token string: `synthi_pat_` + `base64url(randomBytes(32))`. Store only `sha256(token)` hex; the
  plaintext is returned **once** on create and never recoverable.
- Apply via `prisma db push` then `npx prisma generate` (no migrations dir).

**c. `/api/integrations/tokens` (NextAuth-gated, mirrors `/connections`).**
- `POST` — `resolveActor()`; create a token for that user; respond `{ id, name, token (plaintext,
  once), last4, createdAt }`. Rate-limited (`user:<id>:crud`).
- `GET` — list the caller's tokens as public objects (id, name, last4, createdAt, lastUsedAt,
  revokedAt) — **never** the hash or plaintext.
- `DELETE /api/integrations/tokens/[id]` — revoke (set `revokedAt`); 404/403 if not owned by the
  caller.

**d. `/api/integrations/mcp/resolve` (PAT-authed).**
- **Auth:** read `Authorization: Bearer synthi_pat_…`; compute `sha256(token)`; `findUnique({
  tokenHash })`; reject if absent or `revokedAt != null` → **401**. On success, `userId = row.userId`
  and bump `lastUsedAt`.
- **Method/input:** `GET` (read-only) with the PAT in the `Authorization` header and an optional
  `workspaceSlug` query param. (`/audit` below is the only `POST`.)
- **Scope:** `effectiveScope = { userId, workspaceSlug: (workspaceSlug && await canReadScope({userId},
  {scope:'workspace', workspaceSlug})) ? workspaceSlug : null }` — the **same** defense-in-depth as
  `buildExternalTools` (a forged/non-member slug degrades to personal-only).
- **Output:** `{ configs: resolveToolConfigs(effectiveScope) }` — enabled + non-empty-allowlist
  connections with **decrypted** secrets, in the hub-ready shape
  `{ id, name, url, transport, authType, headerName, secret, allowlist }`.
- Rate-limited (`cli:<userId>:resolve`).

**e. `synthi-mcp` consumer wiring (new `src/external/`).**
- **Launch env:** `SYNTHI_API_URL` (Next.js base), `SYNTHI_PAT`, optional `SYNTHI_WORKSPACE_SLUG`.
  When `SYNTHI_API_URL` **or** `SYNTHI_PAT` is missing → external tools are **off** (no fetch, no
  behavior change). Add these to `.env.example`.
- **`resolveExternalTools()`** — `GET ${SYNTHI_API_URL}/api/integrations/mcp/resolve` (PAT in the
  `Authorization` header, optional `workspaceSlug` query param); for each returned config call `@synthi/mcp-hub.listTools` (bounded
  concurrency, per-connection tool cap, allowlist filter — the same guards as `buildExternalTools`);
  build the `ext_<i>` alias map `{ connId, connName, toolName, config }` and native MCP descriptors
  `{ name: 'ext_<i>', description: '[<conn>] <toolDesc>', inputSchema: tool.inputSchema }`.
- **Timing:** resolve **once at `createSynthiServer`** (startup), cache the alias map + descriptors.
  (Matches the static `TOOLS` and the no-`listChanged` capability; lazy refresh is a follow-up.)
- **Advertise:** `ListToolsRequestSchema` returns `[...TOOLS, ...externalDescriptors]`.
- **Dispatch:** in the `CallToolRequestSchema` handler, intercept `isExternalToolName(name)` **before**
  the `synthi_*` switch → `callExternalToolCli(alias, args)`: look up the alias →
  `@synthi/mcp-hub.callTool(config, toolName, args)` → wrap as `CallToolResult`
  (`content:[{type:'text', text: JSON.stringify(data)}]`; `isError:true` with a structured payload on
  failure). Fail-closed: unknown alias or hub error → structured `isError`, **never** throws across the
  MCP boundary. Mirrors `callExternalTool`'s envelope semantics.

**f. `/api/integrations/mcp/audit` (PAT-authed) + CLI-path audit.**
- After each external call, `synthi-mcp` computes `argsHash = sha256(JSON.stringify(args))`,
  `argsBytes`, `resultBytes`, `durationMs`, `outcome` (`ok|error|blocked`), `errorCode`, and the
  original `{connId, serverName(=connName), toolName, alias}`, then `POST`s that **redacted** row to
  the audit endpoint (PAT-authed → derives `userId`). The endpoint writes `McpCallAudit` with
  `callerType='cli'`, `userId` from the PAT, and `workspaceSlug` echoed from the request **only if**
  membership validates (else null). **No raw args/secrets/payloads cross the wire** — hash + sizes
  only. A client-side audit-POST failure is swallowed (never breaks the tool call), mirroring
  `writeAudit`. The endpoint is itself rate-limited (`cli:<userId>:audit`) against spam.

### Data flow (happy path)

1. User logs into Synthi → Connected Tools → "CLI Access" → generate PAT (plaintext shown once) →
   register `synthi-mcp` with `SYNTHI_API_URL`, `SYNTHI_PAT`, optional `SYNTHI_WORKSPACE_SLUG`.
2. CLI agent spawns `synthi-mcp`; at startup `resolveExternalTools()` fetches configs, lists tools via
   the hub, builds the alias map + descriptors.
3. `ListTools` → built-in `synthi_*` + `ext_<i>`. The agent's LLM calls e.g. `ext_3({...})`.
4. Dispatch intercepts `ext_3` → hub `callTool` (SSRF-guarded HTTPS to the remote MCP) → result
   returned as a `CallToolResult`.
5. `synthi-mcp` POSTs a redacted audit row → `/api/integrations/mcp/audit` (`callerType='cli'`).

---

## Security

- **PAT storage:** only `sha256(token)` is persisted; the plaintext is returned exactly once. Lookups
  hash the presented token and compare by the unique-indexed `tokenHash` (no plaintext at rest, no
  reversible storage). Revoked tokens (`revokedAt`) are rejected.
- **Identity:** the resolve/audit `userId` is the `PersonalAccessToken.userId` (already a Prisma
  cuid) — the Slice-1a cuid-vs-provider-id bug class cannot recur here. PAT *issuance* uses
  `resolveActor()` for the same reason.
- **Authorization parity:** workspace tools require `canReadScope` membership; personal tools require
  PAT ownership. Identical to the in-app `effectiveScope` logic (R1-9).
- **SSRF / fail-closed allowlist / timeouts:** unchanged — the **same** `@synthi/mcp-hub` code runs on
  the CLI path (pin + redirect re-validation, scheme allowlist, per-call timeout, header denylist).
- **Redaction:** `McpCallAudit` continues to store only sha256 arg-hash + byte sizes; raw args,
  results, and secrets are never persisted or logged on either side.
- **Transport:** `/api/integrations/mcp/*` must be served over **HTTPS in production** (the resolve
  response carries decrypted third-party secrets — see ⚠️ #1). The endpoints never log the configs or
  the PAT.
- **⚠️ Tradeoff #1 — decrypted secrets reach the authenticated CLI.** Inherent to the shared-package
  model (Decision 2): `resolve` returns the user's **own** external-tool secrets to **their** PAT-authed
  CLI so the local hub can call out. This is a deliberate, accepted property (the proxy model would
  keep secrets server-side at the cost of duplicating/centralizing the call path). Mitigations: PAT
  auth, HTTPS-only, no logging, revocable tokens.
- **⚠️ Tradeoff #2 — CLI-path rate limiting is client-side best-effort.** Because the hub call runs in
  `synthi-mcp` (client-side), the server cannot gate each individual external call in real time. The
  per-user external-call limit (`cli:<userId>:extcall`) is enforced in `synthi-mcp`; the audit
  endpoint records outcomes (including `blocked`) and is itself server-rate-limited. This is
  acceptable because the PAT already grants the user their own configs/secrets — a client that bypasses
  our limit gains no capability it didn't already have (it could call the remote server directly). A
  fully server-mediated per-call gate would require the proxy model (not chosen).

## Error Handling

- Missing/invalid/revoked PAT → **401** at resolve/audit. `synthi-mcp` logs to stderr and runs with
  external tools **off** (built-in `synthi_*` tools still work).
- resolve unreachable / network error at startup → external tools off (degrade gracefully; the MCP
  server still starts).
- A connection whose `listTools` fails → that connection's tools are skipped; others still advertised.
- A failing `callTool` → structured `isError` `CallToolResult`; audited `outcome:'error'` with the
  hub's `errorCode`.
- Unknown alias (e.g. a tool disabled since resolve) → structured `isError`; audited
  `error/unknown_alias`.
- Unconvertible/oversized schema → that tool is skipped at advertise time (same caps as chat).

## Testing Strategy

- **Hub extraction (behavior-preserving):** the moved Slice-1 hub suite runs green from
  `packages/mcp-hub/` (no logic change). `synthi`'s integration tests that import the hub
  (chat `externalTools`, `connectionStore`) pass against `@synthi/mcp-hub`. `next build`, `synthi-mcp`
  `tsc`, and `collab-server` start are all verified.
- **PAT model + `/tokens` route (vitest, Next):** create returns plaintext once and stores only the
  hash; list never returns hash/plaintext; revoke; ownership enforced; rate-limited.
- **`/resolve` (vitest):** valid PAT → scoped decrypted configs; missing/bad/revoked → 401; workspace
  membership honored (non-member slug → personal-only); fail-closed allowlist respected; `lastUsedAt`
  bumped.
- **`/audit` (vitest):** valid PAT writes a `callerType='cli'` row with hash+sizes only; bad PAT → 401;
  `workspaceSlug` validated against membership; raw args never persisted.
- **`synthi-mcp` consumer (vitest, TS):** descriptors built from a stubbed resolve; `ext_<i>` dispatch
  routes to a stubbed hub `callTool`; unknown alias → `isError`; a failing connection degrades; external
  tools **off** when env absent; alias map deterministic (config order).
- **Documented manual E2E (closes criterion #4):** generate a PAT, register `synthi-mcp` against a real
  session + a real connected MCP (public reference server), attach a CLI agent, confirm it lists and
  calls an `ext_<i>` tool and that a `callerType='cli'` audit row lands. Update the Slice-1 E2E doc
  (`docs/superpowers/plans/2026-05-31-external-mcp-client-1a-E2E.md`) or add a 1b companion.

## Rollout / Config

- **New Prisma model** `PersonalAccessToken` via `prisma db push` + `npx prisma generate` (no
  migrations dir). No change to `McpCallAudit`/`McpConnection`/`EncryptedSecret`.
- **New env (synthi-mcp):** `SYNTHI_API_URL`, `SYNTHI_PAT`, optional `SYNTHI_WORKSPACE_SLUG` (added to
  `mcp/synthi-mcp/.env.example`). No new env in `synthi` (PAT auth replaces the never-built
  `SYNTHI_INTERNAL_API_TOKEN`).
- **Workspaces:** root `package.json` gains `private: true` + `workspaces`. ⚠️ This consolidates
  installs to a root lockfile and re-hoists dependencies — see Risks; the implementer must verify each
  package's build/Docker install still works.
- **Additive:** with no PAT configured, `synthi-mcp` and the in-app path are unchanged.

## Risks

- **npm-workspaces migration.** Introducing workspaces to a repo with independent per-package
  lockfiles re-hoists dependencies and changes install semantics; Docker builds that do
  `cd synthi && npm ci` (or equivalent for `synthi-mcp`) may need adjustment so `@synthi/mcp-hub`
  resolves. **Gate:** verify `next build`, `synthi-mcp` `tsc`, and `collab-server` start after the
  change before proceeding. If consolidation proves too disruptive to a Docker build, the fallback is
  to vendor/copy the hub into that build context — an implementation detail for the plan.
- **Import-rewrite regressions in `synthi`.** Every `@/lib/mcp-hub` call site must move to
  `@synthi/mcp-hub`; a miss breaks the in-app path. **Gate:** Slice-1 suite green + `next build`.
- **Decrypted secrets on the wire** (⚠️ #1) — mitigated by PAT auth + HTTPS-only + no logging.
- **PAT leakage** — a leaked PAT grants the holder the user's connected-tool configs (incl. decrypted
  secrets) until revoked. Mitigations: revocable, hashed at rest, `lastUsedAt` for anomaly spotting,
  shown once.

## Out of Scope / Follow-ups

Publishing or bundling `@synthi/mcp-hub` for the released CLI (Decision 4) · PAT expiry/rotation ·
lazy/live tool re-resolution · server-mediated per-call gating (proxy model) · OAuth · stdio/local MCP
servers · MCP resources/prompts.
