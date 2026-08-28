# Plan 1a — Review Addendum R1 (design-review response)

**Date:** 2026-06-01
**Branch:** `tool-compatibility` (renamed from the original `tool-compatability` typo; local-only, safe).
**Status:** Authoritative. These amendments OVERRIDE the base spec/plan where they conflict. Every
remaining task dispatch MUST merge the relevant section below into the implementer prompt.

This addendum resolves 13 review findings. Items marked **DOC** are wording/consistency fixes (the
plan code was already correct). Items marked **CODE** are real behavioral/security changes.

---

## R1-1 — Tool allowlist is fail-closed `String[]` (DOC)
The base **spec prose** (component b) said `toolAllowlist (string[] | null = all)`. That is wrong and
is hereby retracted. The **plan's Prisma model is already correct**: `toolAllowlist String[]`,
default `[]`, **empty = no tools enabled (fail-closed)**. `null` is not a valid value; treat any
legacy `null` as `[]`. No "null = all" semantics anywhere. (Spec text updated.)

## R1-2 — `ext_<i>` numeric alias is canonical everywhere (DOC)
The base spec illustratively wrote `ext__<connId>__<tool>`. The **canonical** external-tool name in
BOTH consumers (chat now, synthi-mcp in 1b) and in audit/logs is the numeric alias **`ext_<i>`**
(regex `^ext_\d+$`), mapped to `{connId, toolName}` via an in-memory alias map. The raw
`connId/toolName` are recorded in the audit row (see R1-8), never used as the Gemini function name.
Plan 1b MUST use the same alias model. (Spec text updated.)

## R1-3 — API/hub rate limiting (CODE) — **NEW TASK (see Task R1-A)**
The base spec's "reuse the gateway's per-connection rate limiting" is retracted: the tool loop and
CRUD run in the **Next.js routes**, not the gateway, so gateway limits do not apply. Add app-level
limiting (Task R1-A). Until that task lands, no other task should claim rate limiting is handled.

## R1-4 — Health indicator = cached last-known state + manual retest (DOC)
Success criterion #1's "live health indicator" is clarified: v1 shows the **last-known**
`lastHealthState` with a relative timestamp from `lastHealthAt` (e.g. "checked 4m ago"), plus a
manual **Test** button that re-checks on demand. No background poller, no auto-TTL in v1. The panel
(Task 11) shows the relative time next to the health dot. (Spec text updated.)

## R1-5 — SSRF hardening: pin + redirect re-validation in the hub client (CODE) — **Task 4**
The Task 2 guard (resolve-all-addresses + https-only + literal/bracket/hex-mapped blocks) stays as
the pre-flight check. Task 4 (hub client) MUST additionally defeat DNS-rebinding / redirect SSRF:
1. Before connecting, call `assertSafeUrl(url, { allowlist })` (already planned).
2. Resolve the host yourself and **pin** a validated address; supply the transport a custom `fetch`
   (or `undici` dispatcher/agent) that connects to the **pinned IP** (or, minimally, re-runs
   `assertSafeUrl` immediately before the socket connects so the resolved IP is re-checked — closes
   the TOCTOU window between guard and connect).
3. **Follow no redirects blindly:** set `redirect: 'manual'`; on any 3xx, re-run `assertSafeUrl` on
   the `Location` (resolved against the current URL) before following, and cap at 3 hops. A redirect
   to a blocked host/IP → `ssrf_blocked`.
4. Enforce the scheme allowlist (https, or http only when host is on `SYNTHI_MCP_SSRF_ALLOWLIST`).
Add tests: redirect-to-internal is blocked; rebind (guard sees public IP, connect-time resolver
returns private) is blocked; happy public path still works (inject the resolver/fetch like Task 2
injects `lookup`).

## R1-6 — `headerName` denylist + normalization (CODE) — **amend Task 3 + enforce in Task 8**
`buildAuthHeaders` (Task 3, committed e9fc1b71) must not emit dangerous custom headers. Add
`isAllowedHeaderName(name)`:
- Must match RFC 7230 token charset `^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$`.
- Case-insensitive **denylist** (reject): `host`, `cookie`, `set-cookie`, `authorization`
  (reserved for `authType:'bearer'`), `content-length`, `content-type`, `connection`,
  `transfer-encoding`, `te`, `trailer`, `upgrade`, `via`, and any `x-forwarded-*` / `forwarded` /
  `x-real-ip`.
- `buildAuthHeaders` returns `{}` (and the caller treats it as a misconfig) if `authType:'header'`
  but `headerName` is missing/disallowed. Normalize by trimming; preserve the user's casing for the
  emitted header but compare against the denylist case-insensitively.
Task 8 (API) MUST reject create/update with a disallowed `headerName` (400, `invalid_header_name`)
so the bad value never reaches the DB.

## R1-7 — Gemini schema conversion: bounded + safe (CODE) — **amend Task 3 + Task 9**
`jsonSchemaToGemini` (Task 3) must be **recursion-safe and bounded** (a hostile/recursive MCP schema
must not hang or bloat the prompt):
- Add a `depth` param (default 0) and a `MAX_DEPTH` (e.g. 8). Beyond it, return `{ type: 'STRING' }`
  (a safe scalar fallback) instead of recursing.
- Drop unsupported keywords (`$ref`, `oneOf`, `anyOf`, `allOf`, `$schema`, `definitions`) rather than
  passing them through; convert the rest as today.
- Truncate any `description` to ~512 chars.
Task 9 (declaration builder) adds the aggregate limits: per-tool serialized schema cap (e.g. 8 KB)
and per-connection tool count cap (e.g. 64); on conversion failure or over-cap, **skip that tool**
(log once) — never abort the chat turn. A tool with an unconvertible schema is simply not offered.

## R1-8 — Richer audit row (CODE) — **amend Task 5 schema + Task 9 writes**
Add to `McpCallAudit`: `alias String?` (the `ext_<i>` used), `durationMs Int?`,
`callerType String?` (`'chat'` | `'cli'`), `argsHash String?` (sha256 hex of the JSON args — NOT raw
args), `argsBytes Int?`, `resultBytes Int?`. Keep existing `serverName, toolName` (original MCP tool
name), `outcome` (`ok|error|blocked`), `errorCode`. **Never** store raw secrets or full payloads.
Task 9 computes `argsHash`/sizes and `durationMs` around the hub call and writes `callerType:'chat'`.

## R1-9 — Workspace roles + authorization matrix (CODE) — **amend Task 5, Task 7, Task 8**
Add `role String @default("member")` to `WorkspaceMembership` (`'owner' | 'admin' | 'member'`).
- **Migration/backfill:** existing rows — set the **earliest membership (min `createdAt`) per
  workspace** to `'owner'`, the rest `'member'` (Workspace has no `creatorId`, so earliest-member is
  the pragmatic creator proxy). New default is `'member'`.
- **Membership-creation sites:** the implementer MUST grep for where `workspaceMembership.create` /
  workspace creation happens and set the creating user's role to `'owner'`; invited/added members
  default `'member'`. (Exploration required — do not guess paths.)
- **Authorization matrix (MCP connections):**
  | action | personal conn | workspace conn |
  |---|---|---|
  | view / list | owner only | any member |
  | test (outbound health, no mutation) | owner only | any member |
  | create / edit / delete / enable / change allowlist | owner only | role ∈ {owner, admin} |
- Task 7 splits into `canReadScope(actor, scope)` (member-level) and `canWriteScope(actor, scope)`
  (owner/admin for workspace; self for personal). Task 8 calls the right one per route (GET/test →
  read; POST/PATCH/DELETE → write). Personal: `ownerUserId === actor.userId`.

## R1-10 — Dedup/keying by connection id, never name (CODE/DOC) — **Task 6 + Task 9**
The base spec's "deduped by connection **name**" is retracted. The effective tool set =
personal(user) ∪ workspace(slug); rows are already unique by `id`, so the union needs **no name
dedup**. Nothing downstream may key by name (names are user-controlled, mutable, and may collide
across scopes). The alias map keys by `id`+`toolName`; the UI may *display* a "duplicate name" hint
using scope badges but must not merge/drop by name. (Spec text updated.)

## R1-11 — Per-call latency + concurrency caps stated (DOC + light CODE) — **Task 9**
Document that per-call MCP sessions add latency (a fresh connect per discovery/call); acceptable for
v1. Add bounded fan-out: when building declarations, cap concurrent `listTools` across connections
(e.g. 5) and apply the per-call timeout `SYNTHI_MCP_CALL_TIMEOUT_MS` (default 20000). Cap external
tool **executions per chat turn** (e.g. 8); beyond it, return a structured `rate_limited` tool error
to the model rather than calling out. (Coordinates with Task R1-A.)

## R1-12 — Plan 1a vs 1b success boundary (DOC) — **Task 12 scope**
Plan 1a success = base criteria **1, 2, 3, 5, 6** + all unit tests + an **in-app-only** manual E2E.
Base criterion **4** (CLI agent sees proxied tools) and the **CLI half of #7** move to **Plan 1b**.
Task 12's E2E doc covers only the in-app AI consumer; it must NOT claim CLI success. (Spec updated.)

## R1-13 — Branch rename (DONE)
`tool-compatability` → `tool-compatibility` (local-only; `git branch -m`). All docs updated to the
corrected spelling. Commit trailers and future pushes use the new name.

---

## NEW TASK R1-A — Rate limiting (integrations API + external tool calls)
**Files:** Create `synthi/src/lib/integrations/rateLimit.js` + `__tests__/rateLimit.test.js`.
A small dependency-free fixed-window (or token-bucket) limiter, in-memory `Map` keyed by a string
(v1 is per-instance, **not** distributed — documented; Redis-backed is a later hardening item).
- `checkLimit(key, { limit, windowMs }) -> { ok, retryAfterMs? }`.
- Suggested keys/limits (env-overridable, sane defaults):
  - integrations CRUD: `user:<id>:crud` → 30/min.
  - connection **test** (outbound): `user:<id>:test` → 10/min.
  - external tool calls: `user:<id>:extcall` → 60/min, plus the per-turn cap from R1-11.
- Wire into `/api/integrations/*` (Task 8) and the chat external dispatch (Task 9). On limit:
  routes return 429 `{ error: 'rate_limited', retryAfterMs }`; chat returns a structured
  `rate_limited` tool result to the model (never throws, never breaks the turn).
- Tests: allows under limit, blocks over limit, window resets, independent keys don't interfere.
Place in the task order **after Task 8 and before/with Task 9** (both consume it). Tracked as
TaskList #13.

---

## Execution notes
- Tasks already DONE and unaffected: Task 1 (deps/env), Task 2 (SSRF guard — pre-flight check; the
  pin/redirect layer is additive in Task 4).
- Task 3 (helpers) is **committed (e9fc1b71) but REOPENED** to add R1-6 (`isAllowedHeaderName` +
  guarded `buildAuthHeaders`) and R1-7 (bounded `jsonSchemaToGemini`), TDD, then re-review + close.
- For every remaining task, the controller pastes the base task text **plus** the matching R1
  section(s) into the implementer prompt.
