# WI_WARRANTS_SPEC — Agent Warrants: attenuating capability leases for connected agents

Enterprise feature. Any agent that connects to synthi's MCP surface (codex, claude,
cursor, copilot, custom clients — agent-agnostic by construction) can be granted a
*warrant*: an explicit, expiring, invocation-capped lease over specific tools with
argument-level constraints. An agent holding a warrant may *attenuate* it — issue a
strictly narrower sub-warrant to another agent (delegation chain). Authority only
shrinks as it flows down. Revocation cascades to the whole subtree instantly.
Fail-closed enforcement hooks the CallTool path next to the existing quota gate.

Inspired by the unsolved fine-grained-authorization gap across MCP/A2A/ACP and the
Biscuit/macaroon attenuation model. Novelty: attenuation chains enforced at the
tool-dispatch layer of a live IDE runtime.

House rules: pure modules get time injected as `now` (no clock reads inside logic),
fail-closed decisions carry `reason_code` + `human_reason` (plain language, no
jargon), no drive-by refactors, match existing file style exactly.

## Patch A — pure core module + tests (no wiring)

### New file: `mcp/synthi-mcp/src/security/warrant.ts`

Pure module, zero IO. Exports:

```ts
export interface ToolGrant {
  tool: string;
  /** glob patterns ( "*" and "**" only ) matched against top-level string values of the call args */
  arg_constraints?: Readonly<Record<string, string>>;
  /** hard ceiling on invocations charged to this grant */
  max_invocations?: number;
}

export interface Warrant {
  warrant_id: string;
  subject: string;
  grants: readonly ToolGrant[];
  issued_at_ms: number;
  expires_at_ms: number;
  /** undefined for roots; set for attenuated children */
  parent_warrant_id?: string;
  /** id of the tree root; equals warrant_id for roots */
  root_warrant_id: string;
  status: "active" | "revoked";
}

export type WarrantDecision =
  | { allowed: true; warrant_id: string }
  | { allowed: false; reason_code: string; human_reason: string };
```

Class `WarrantRegistry`:
- `issue(input: { subject, grants, now, ttl_ms }): Warrant` — generates
  `warrant_id` as `"wr_" + crypto.randomUUID()` (import from node:crypto is fine,
  randomness is not decision logic). Validates: non-empty subject; every grant has
  non-empty `tool`; `ttl_ms > 0`. Throws `Error` with human message on bad input.
- `attenuate(input: { parent_warrant_id, subject, grants, now, ttl_ms? })`:
  resolves parent (must exist, status active, not expired at `now`). Child rules —
  every child grant's `tool` must appear in some parent grant (exact name);
  child `arg_constraints`, where present, must be a subset-per-key of the parent's
  (same key, pattern equal or stricter: child pattern matches implies parent pattern
  matches — implement `patternIsStricterOrEqual(child, parent)` by literal
  comparison: equal strings OK; otherwise reject unless parent has none for that
  key); child `max_invocations` <= parent grant's remaining invocations (parent
  remaining tracked by the registry); child expiry = min(parent expiry, now+ttl_ms)
  and must be <= parent expiry. Violations => throw Error with human message.
  Chain depth: reject when depth would exceed 8 (count ancestors via parent links).
- `check(input: { warrant_id, tool, args?, now }): WarrantDecision` — THE decision
  function. Deny codes (fail-closed):
  - `no_such_warrant`, `revoked`, `expired`
  - `tool_not_covered` — human_reason e.g. "This warrant does not cover the '<tool>' capability."
  - `arg_out_of_scope` — "This warrant restricts '<key>'; the requested value is outside it."
  - `invocations_exhausted` — "This warrant used up its allowance for '<tool>'."
  Glob semantics: implement tiny matcher `globMatch(pattern, value)` supporting
  `*` (any chars except ".") and `**` (any chars). Missing optional args pass.
- `chargeInvocation(warrant_id, tool)` — decrement counters for the grant AND all
  ancestor grants covering that tool (parents' budgets are consumed by children's
  use). Idempotent per call; returns void.
- `revoke(warrant_id)` — sets status revoked on the warrant and every descendant
  (walk the tree). Returns count revoked.
- `listWarrants(): readonly Warrant[]` — full audit view.
- `sweepExpired(now): number` — marks nothing (expiry is evaluated at check time);
  returns count currently expired. (Keeps stateless purity; exists for metrics.)

### New file: `mcp/synthi-mcp/tests/unit/warrant.test.ts`

vitest, `describe/it/expect`, imports from `../../src/security/warrant.js`.
Cover at minimum:
1. issue + check happy path (allowed:true).
2. unknown id => `no_such_warrant`; revoked => `revoked`; past-expiry `now` => `expired`.
3. tool not covered => `tool_not_covered` with human_reason mentioning the tool.
4. arg constraint: pattern `"https://staging.example.com/**"` allows staging URLs,
   denies others with `arg_out_of_scope`; missing optional arg passes.
5. attenuation happy path: child narrower subset allowed.
6. widening rejected: child asks for tool not in parent => throws.
7. looser constraint rejected (child pattern different from parent's, not provably
   stricter) => throws.
8. child expiry beyond parent => clamped to parent expiry.
9. depth cap: chain of 9 attenuations => 9th throws.
10. revoke parent => child check returns `revoked` (cascade).
11. invocation budget: parent max 2, child charges twice => third check of child =>
    `invocations_exhausted` (ancestors' budgets consumed too).
12. randomized conformance sweep (~200 iterations seeded PRNG): random trees of
    grants/args; invariant — whenever child check allowed, a check with identical
    inputs against the parent warrant is also allowed (children never exceed
    parents). Deterministic seed so failures reproduce.

Acceptance Patch A: `node ../../node_modules/vitest/vitest.mjs run tests/unit/warrant.test.ts`
green from `mcp/synthi-mcp` (orchestrator runs this — codex does NOT run tests).

## Patch B — MCP surface + enforcement gate (separate delegation, after A lands)

- `mcp/synthi-mcp/src/tools/warrant.ts`: dispatcher `dispatchWarrantTool(name, args)`
  + `WARRANT_TOOL_NAMES`, pattern-following `tools/auth.ts`. Tools:
  `synthi_warrant_issue`, `synthi_warrant_attenuate`, `synthi_warrant_check`,
  `synthi_warrant_revoke`, `synthi_warrant_list`.
- `tool_registry.ts`: append the five names under a new `// Agent warrants` comment.
- `server.ts`: add dispatch entries in the handlers map; in the CallToolRequestSchema
  handler insert a warrant gate AFTER `enforceQuota` and BEFORE external/dispatch:
  env `SYNTHI_WARRANT_MODE` = off(default)|warn|enforce. Reads
  `(request.params as {_meta?: {warrant_id?: string}})._meta?.warrant_id`;
  enforce mode with missing/uncovered warrant => isError JSON
  `{ error: "warrant_required", human_reason }`; warn => eventLog security event,
  continue. On success charge the invocation. Follow quota.ts structure closely.
- Tests: extend `tests/unit/warrant.test.ts` with dispatcher round-trip tests
  (issue -> list shows it; revoke cascades; check tool returns decision JSON).

Commit discipline: one commit per patch, orchestrator commits after verifying diff
and running tests.
