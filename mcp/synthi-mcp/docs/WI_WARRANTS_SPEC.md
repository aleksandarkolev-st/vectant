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

## Patch D — Sealed warrants (proof-of-possession)

Motivation: warrant ids transit logs and transcripts; possession of the id string
must not equal authority. A sealed warrant additionally requires a bearer secret
on every call.

- src/security/warrant.ts: `Warrant` gains `sealed?: boolean` (never the secret).
  WarrantRecord gains `bearer_hash?: string` (sha256 hex). issue/attenuate input
  gains `seal?: boolean`; sealed issuance mints a bearer `wb_` + 32 hex chars
  (from randomUUID), stores only its sha256, and returns IssuedWarrant
  (Warrant plus optional disclosed-once `bearer`). Attenuating from a sealed
  parent ALWAYS seals the child with a fresh bearer (possession narrows with
  authority). check input gains `bearer?: string`; when the record has a
  bearer_hash, require timingSafeEqual(sha256(bearer), bearer_hash) else deny
  `bearer_mismatch` with human_reason "This warrant is sealed; the call must
  prove possession with its bearer secret in _meta.warrant_bearer."
  listWarrants/sweep never disclose secrets.
- src/tools/warrant.ts: gate passes _meta.warrant_bearer into check; issue/
  attenuate tools pass `seal` through and include `bearer` in their response;
  check tool accepts args.bearer; WARRANT_TOOLS schemas gain seal/bearer fields.
- Tests: sealed round-trip, missing/wrong bearer denial, audit secrecy,
  child-fresh-bearer, dispatcher path; live-wire default-posture battery stays
  16/16 for unsealed regression.

## Patch E — Self-graduating warrants (earned-autonomy ladders)

Motivation: enterprise frameworks (NeuBird Earned Autonomy 2026, Digital
Apprentice arXiv:2606.04321, Covenant Std Part 7) converge on graduated agent
trust - promotion on sustained evidence, hair-trigger demotion, pinned
ceilings - but ship only as org process. This mechanizes graduation inside
the credential itself.

- src/security/warrant.ts additions:
  - type AutonomyStep { unlock_after: { min_sample: number; success_ratio: number };
    grants: readonly ToolGrant[] }  // additional grants the step unlocks
  - Warrant gains optional graduated?: boolean, ladder?: readonly AutonomyStep[]
    (frozen at issuance; NEVER mutated), plus runtime-only counters kept in the
    record (not on the audit view): admitted_count, denied_count, demoted_rungs,
    cooldown_until_ms.
  - Code constants: MIN_EVIDENCE_SAMPLE = 5 (floor for any step's min_sample),
    PROBE_DEMOTION_THRESHOLD = 3 (out-of-scope denials within current rung that
    trigger one-rung demotion), COOLDOWN_MS = 60_000.
  - issue/attenuate input gains graduated?: boolean; ladder?: readonly AutonomyStep[].
    Validation: ladder length <= 4; every step.min_sample >= MIN_EVIDENCE_SAMPLE;
    every step.success_ratio in (0,1]. Graduated warrants require admin posture
    unchanged (management plane already gated).
  - Effective grants computation (pure fn computeEffectiveGrants(warrant, record)):
    base grants + ladder steps [0 .. currentRung) where currentRung counts steps
    whose evidence is met (admitted_count >= step.unlock_after.min_sample AND
    admitted/(admitted+denied) >= step.success_ratio), minus demoted_rungs
    (floored at 0). Cooldown active => base grants only.
  - check(): records outcome AFTER the decision - allowed => admitted_count+1;
    denied with reason_code arg_out_of_scope or bearer_mismatch => denied_count+1
    and if denied_count >= PROBE_DEMOTION_THRESHOLD then demoted_rungs+1 (cap at
    ladder length), denied_count reset, cooldown_until_ms = now + COOLDOWN_MS.
    Denial evaluation uses effective grants (a graduated warrant may therefore
    be ALLOWED mid-life for tools its ladder unlocked).
  - New exported type WarrantStatusView { warrant; effective_grants; current_rung;
    next_step?: { checks_remaining: number } | null; demoted_rungs; cooldown_active }
  - New method status(warrant_id, now): WarrantStatusView - transparency surface.
  - Attenuation from a graduated parent snapshots the parent's CURRENT effective
    grants as static child grants (child never inherits the ladder; promotion
    never propagates down).
- src/tools/warrant.ts: pass graduated/ladder through issueTool/attenuateTool
  (ladder parsed defensively like grants); new tool synthi_warrant_status
  { warrant_id } returning the status view JSON; WARRANT_TOOLS schema entries
  updated (+ synthi_warrant_status definition); ADVERTISED_TOOLS gains the name.
- Tests: promotion unlocks rung after evidence; below-threshold stays locked;
  probe demotion drops rung + cooldown locks to base; ladder validation throws
  (depth/sample/ratio); attenuation snapshot excludes future rungs; status view
  math; dispatcher path for synthi_warrant_status.

## Patch F — Separate authorization from trust progression

Directive (user, 2026-08-26): authorization and trust progression are distinct
concerns with distinct owners and must not live in the same credential.

- NEW FILE src/security/trust.ts:
  - export interface ProgressionStep { unlock_after: { min_sample: number;
    success_ratio: number }; grants: readonly ToolGrant[] }  (imports ToolGrant
    type from ./warrant.js)
  - export interface ProgressionPolicy { policy_id: string; steps: readonly
    ProgressionStep[] }  // frozen at registration
  - export class TrustLedger:
    - registerPolicy(input: { policy_id: string; steps }): ProgressionPolicy -
      validates depth<=4, min_sample>=MIN_EVIDENCE_SAMPLE floor, ratio in (0,1];
      throws human Errors; duplicate policy_id throws.
    - bind(warrant_id, policy_id): attaches an EXISTING warrant to a policy;
      unknown warrant id or policy id throws; rebinding while cooling down
      throws (prevents cooldown escape); rebinding otherwise REPLACES the
      previous binding but PRESERVES accumulated counters per policy switch
      decision: counters reset to zero on policy change (fresh evidence under
      new rules) - documented behavior.
    - unbind(warrant_id): detaches; warrant reverts to full base authority.
    - record(warrant_id, outcome: { allowed: true } | { allowed: false;
      reason_code: string }, now): moves ALL graduated-evidence logic here
      (admitted_count/denied_count/demoted_rungs/cooldown_until_ms); probe codes
      = tool_not_covered | arg_out_of_scope | bearer_mismatch; threshold 3 =>
      one-rung demotion + COOLDOWN_MS; budget denials never count; unknown
      warrant ids are ignored (not bound => no progression).
    - view(warrant_id, now): { policy_id, current_rung, next_step:
      { checks_remaining } | null, demoted_rungs, cooldown_active,
      unlocked_grants: readonly ToolGrant[] } | null when unbound.
    - effectiveGrantsFor(warrant: Warrant, warrant_id: string, now): readonly
      ToolGrant[] - warrant.grants plus unlocked steps' grants (cooldown =>
      base only); unbound => exactly warrant.grants.
    - resetForTests().
  - Re-export MIN_EVIDENCE_SAMPLE / PROBE_DEMOTION_THRESHOLD / COOLDOWN_MS here
    (single home); remove from warrant.ts.
- src/security/warrant.ts PURIFICATION (revert Patch E embed):
  - remove from Warrant: graduated?, ladder?; remove runtime counters from
    WarrantRecord; remove MIN_EVIDENCE_SAMPLE/PROBE_DEMOTION_THRESHOLD/
    COOLDOWN_MS constants+exports; remove validateLadder usage in issue/
    attenuate inputs (drop graduated/ladder inputs); remove
    computeEffectiveGrants, recordGraduatedEvidence, status(); check() evaluates
    against record.warrant.grants again and contains ZERO evidence logic.
  - KEEP everything else: sealing, admin ceilings helpers stay where they are
    (tools file), attenuation subset rules, cascade revoke, budgets.
  - add optional passthrough used by the gate: none needed - composition lives
    in the tools layer.
- src/tools/warrant.ts recomposition:
  - import { TrustLedger } from "../security/trust.js"; const trustLedger = new
    TrustLedger() singleton beside warrantRegistry.
  - enforceWarrantGate: authorization = registry.check(...) WITHOUT bearer-less
    changes (keep bearer flow); coverage evaluation uses
    trustLedger.effectiveGrantsFor semantics - implement by asking the ledger:
    replace direct registry.check with a composed evaluate(toolName, params,
    now): (a) resolve warrant + bearer via existing path, (b) ask ledger for
    effective grant list, (c) deny tool_not_covered/arg_out_of_scope through
    registry.check ONLY when unbound, else evaluate args locally against
    effective grants mirroring registry rules (reuse exported grantAcceptsArgs?
    - simplest: export grantAcceptsArgs + firstViolatedArgKey from warrant.ts),
    (d) after decision, trustLedger.record(...) with the outcome reason_code,
    (e) chargeInvocation unchanged on admission.
  - management plane: synthi_warrant_status REMOVED (was embedded-trust view);
    replaced by TWO tools: synthi_warrant_trust { warrant_id } ->
    jsonResponse(trustLedger.view(...)) and synthi_warrant_bind_trust
    { warrant_id, policy_id } -> bind; both join WARRANT_TOOL_NAMES (management
    set = admin-key gated automatically). New tool synthi_warrant_policy_register
    { policy_id, steps } -> registerPolicy (also management set). Net names:
    issue, attenuate, check, revoke, list, trust, bind_trust,
    policy_register (8 total; drop status).
  - WARRANT_TOOLS schema updates accordingly; ADVERTISED_TOOLS/server handlers
    updated to final name set.
- Tests rewrite (tests/unit/warrant.test.ts): replace the graduated describe
  block with trust-separation blocks: policy validation throws; bind->record->
  unlock progression; probe demotion + cooldown; rebinding-during-cooldown
  blocked; unbind restores full base; effectiveGrantsFor composition incl.
  sealed+graduated coexistence (seal stays on warrant, ladder in ledger);
  dispatcher paths for the three new tools; warrant.test keeps ALL pre-E tests
  passing unchanged (pure authorization restored).
- Live-wire acceptance: default battery adapted to 8 warrant tools; graduation
  demo repeated via register->bind->calls->status flow.

## Patch G — Red-team hardening of the authorization/trust composition

Inputs: static audit (11 findings F1-F11) + live seam attack (70 attempts).
Golden rule adopted: trust must be structurally incapable of outranking
lifecycle. Gate order everywhere: registry lifecycle/bearer FIRST, then
coverage over base UNION ledger-unlocked, then charge, then record.

G1 (F1/F5/c, CRITICAL): enforceWarrantGate bound branch - registry.check runs
  UNCONDITIONALLY FIRST (lifecycle + bearer + base coverage + chain budgets);
  any denial => use it verbatim (and record it). Only when registry allows do
  we extend: if bound and tool not covered by base, evaluate coverage against
  view.unlocked_grants with grantAcceptsArgs/firstViolatedArgKey. Revoked,
  expired, exhausted, wrong-bearer therefore always win over trust.
G2 (F3/e, HIGH): progression requires proof-of-possession. bind_trust refuses
  unsealed warrants (human error mentioning sealing). Evidence (record) only
  ever accumulates for sealed warrants because only they can bind; kills
  foreign-bind sabotage and cross-session evidence poisoning.
G3 (F6): unbind during cooldown ALLOWED (escape valve), implemented as new
  tool synthi_warrant_unbind {warrant_id, bearer} - bearer must match the
  sealed warrant (holder-only by possession). Rebind after cooldown PRESERVES
  demoted_rungs (only admitted/denied reset on policy change).
G4 (d/F9a): registerPolicy hardening - reject empty steps, non-finite or
  < MIN_EVIDENCE_SAMPLE min_sample, duplicate tools across rungs.
G5 (F10): deep-freeze registered policies (steps objects + grants arrays).
G6 (F8): synthi_warrant_check drops caller-supplied now (server clock only).
G7 (F11): remove phantom synthi_warrant_status from WARRANT_TOOL_NAMES; add
  synthi_warrant_unbind; fix header counts.
Tests: revoked-but-bound denied with reason_code revoked; expired-but-bound
denied; unlocked-tool admission works for bound+sealed; bind refuses
unsealed; unbind requires matching bearer and works during cooldown;
demotions survive rebind; policy validation new cases; phantom name gone.
G8 (F2): progression grants stay authority-shaped: registerPolicy rejects any
  step grant carrying max_invocations (budgets belong to issuance); at bind
  time every step grant's arg_constraints must be equal-or-stricter per key
  than the warrant's own grant for that tool (reuse patternIsStricterOrEqual,
  exported from warrant.ts) - trust can narrow, never widen.
Deferred (documented follow-ups, not defects shipped): F4 reserve/settle
async budget accounting; F7 event-log redaction.

## Patch J - production-grade safety (close deferred findings)

J1 RESERVE/SETTLE: enforceWarrantGate charges synchronously pre-dispatch;
concurrent calls interleave between check and charge => budget double-spend
(round-2 audit finding F4). Fix: WarrantRegistry gains
tryReserve(warrant_id, tool): { reserved: boolean } - atomically decrement ALL
chain remaining counters for the tool when every node has remaining undefined
or > 0. Settlement is an explicit outcome, never a caller-supplied
`commit` flag: `succeeded` retains the debit, `failed` restores it, and
`unknown` retains it after an ambiguous crash or side-effecting failure. Gate:
on an allowed decision call tryReserve BEFORE dispatch; false => deny
invocations_exhausted. server.ts settles the durable receipt after dispatch;
the external-tool proxy path settles too.
J2 O(1) LOOKUPS: registry exposes get(warrant_id): Warrant | undefined
(cloned snapshot); tools/warrant.ts replaces every listWarrants().find(...)
with registry.get(...).
J3 RESOURCES GATING: server.ts ReadResourceRequestSchema handler consults
`authorizeResourceRead(uri, params)`. In warn/enforce modes, every requested
URI is resolved by the authenticated host into an ordinary warrant grant and
is denied unless that exact grant can be atomically reserved for the request.
Its receipt is settled after the resource handler succeeds, fails, or becomes
unknown. The MCP package does not
classify URI schemes, paths, hosts, or “sensitive” resource categories, and
does not contain an administrative bypass. Off mode is unchanged.
J4 REDACTION COMPLETION: grep src for raw warrant ids in eventLog pushes
outside tools/warrant.ts rid() helper; route any stragglers through it.
Tests: parallel 10x calls vs max_invocations=2 => exactly 2 reserved-admitted;
settle(commit=false) restores budget; resources/read denied unbound in
enforce, sealed reads deny absent/wrong bearer and allow matching bearer, off
mode unaffected.

## Patch K - durable warrants + renewal (feature on top)

Motivation: all warrant state is memory-only; a restart orphans live agents
mid-task and erases earned trust. Production credentials must survive the
process that issued them.

K1 PERSISTENCE: src/security/warrant_store.ts - append-only JSONL journal,
encrypted at rest with AES-256-GCM keyed by SYNTHI_WARRANT_STORE_KEY (when
unset: fall back to machine-derived key file under os.tmpdir() with 0600).
Events appended: issue/attenuate/revoke/bind/unbind/record/taint snapshots +
periodic checkpoint every 500 appends. On module init (opt-in via
SYNTHI_WARRANT_STORE=path), tools/warrant.ts replays into registry+ledger
before serving; replay is idempotent by event seq. fsync per append.
K2 RENEWAL: synthi_warrant_renew {warrant_id, bearer?, ttl_ms} -
holder-bearer-gated for sealed warrants; extends expires_at_ms by min(ttl_ms,
org max_ttl_ms remaining headroom); PRESERVES rungs/demotions/taint/budgets
(budgets optionally topped up via add_invocations <= org ceiling); emits
journal event. Management-plane gated like other lifecycle tools EXCEPT the
bearer path allows self-renewal of sealed warrants (possession = authority to
extend, within ceilings).
K3 Tests: restart-replay round-trip (issue/bind/evidence -> new TrustLedger
replays -> identical view), renew extends within ceiling and preserves
progression, bearer-gating of self-renewal.

## Patch L - generic holder-driven delegation

Motivation: attenuation already proves that authority can only shrink down a
chain, but a production admin gate meant only an administrator could create
that child. A holder could renew its lease but could not safely delegate part
of it to another generic worker.

L1 EXPLICIT POLICY: root issuance optionally accepts
`delegation { max_depth, max_child_ttl_ms?, max_child_invocations? }`. A
delegation policy requires `seal:true`; possession of a sealed bearer is the
authority to delegate. `max_depth` counts child hops below the policy root.
The policy is copied unchanged to children with a monotonically increasing
`delegation_depth`, so no descendant can widen its delegation envelope.
Child TTL is clamped to `max_child_ttl_ms` when supplied and
`max_child_invocations` requires each child grant to declare a bounded budget
at or below that ceiling.

L2 HOLDER PATH: `synthi_warrant_attenuate` accepts `bearer`. In warn/enforce
mode the existing admin key still admits administrator attenuation; otherwise
the handler admits the call only when `canDelegate(parent_warrant_id, bearer)`
proves an active, sealed parent, matching bearer, policy opt-in, and remaining
delegation depth. The core repeats that holder check before mutation. Existing
strict tool/argument/budget/expiry narrowing, fresh child bearers, and cascade
revocation remain unchanged. This protocol intentionally contains no
Luna-specific agent type, endpoint, or identity field.

L3 DURABILITY/PROOF: delegation policy and depth are warrant state and are
therefore included in encrypted journal snapshots. Live MCP proof issues a
sealed delegable root under an admin key, lets its holder attenuate without
that key, uses the fresh child bearer, restarts, and repeats holder delegation.
An audience/task binding is deferred until the host has an authenticated,
generic workload identity to bind; an unverified caller-supplied label would
not be a security control.

## Patch M - authenticated principal audiences

Bearer possession is necessary for sealed warrants, but it is not sufficient
for a production multi-agent deployment. A child can carry an optional generic
`audience` claim:

```json
{ "issuer": "identity-authority", "subject": "agent-session", "workspace": "workspace", "project": "project" }
```

M1 CORE: `src/security/warrant_principal.ts` owns the provider-neutral claim
shape and exact comparison. `Warrant.audience` is immutable state, included in
encrypted snapshots. `check`, holder attenuation, renewal, and resource reads
deny `principal_required` or `principal_mismatch` before bearer
or capability coverage when an audience exists. A child inherits its parent's
audience unless a verified recipient replaces it. The core contains no agent
provider, runtime, local hostname, session-token syntax, or provider-specific
capability.

M2 HOST CONTEXT: `src/security/warrant_request_context.ts` carries an
already-authenticated principal, recipient canonicalizer, shared authority,
and resource-grant resolver through request-local async context. User MCP
parameters are never treated as identity proof or as resource-grant policy.

M3 HOST INTEGRATION: `serveHttp({ warrantRequestContext })` accepts an
injected request-context provider. The MCP package intentionally has no
identity URL, route template, credential-header name, certificate location,
token syntax, agent/runtime identifier, or resource-capability name. A
deployment integration owns all transport and trust establishment, then passes
only canonical provider-neutral values into the MCP core.
`createCodeSiteWarrantContextProvider` is the CodeSite adapter: it requires a
deployment-owned service to authenticate the request and csa credential before
returning a principal, authority, service-transport attestation, resource
resolver, and recipient lookup. It
rejects recipient claims that are not an exact canonical match in the issuer's
workspace/project. The adapter contains no endpoint, header, certificate, or
capability configuration.

M4 CODESITE LIFECYCLE: CodeSite is one possible deployment integration. Its
authenticated control-plane boundary resolves canonical principals and
recipients from agent-session state. The use, issue, and issuer labels are
deployment configuration:

- `SYNTHI_CODESITE_WARRANT_ISSUER`
- `SYNTHI_CODESITE_WARRANT_USE_CAPABILITY`
- `SYNTHI_CODESITE_WARRANT_ISSUE_CAPABILITY`

No default identity or capability label is accepted. Each projection checks
attached state, csa expiry, heartbeat freshness, active project,
non-revoked project membership, required capability, and workspace/project
scope. Missing configuration or unavailable identity fails closed.

M5 TRANSPORT: the deployment integration must use its own authenticated,
encrypted service-to-service transport and fail closed when it cannot establish
or validate identity. The host now has to return a non-caller-controlled
`serviceAuthentication` attestation containing its opaque transport and service
identities; production warrant enforcement rejects a context without it. The
attestation is where a deployment records validated mTLS or workload/service
identity, not a client-provided header. This policy deliberately does not
prescribe an endpoint layout, headers, secret mounts, cloud vendor, TLS
implementation, or capability taxonomy.

M6 PROOF: the compiled runtime proof demonstrates bearer-only denial,
wrong-principal denial, exact-recipient admission, holder delegation into a
new recipient, host-injected authority use, request-id receipts, and a
host-resolved resource grant. The transactional authority proof covers
receipts, audit chaining, and fail-closed corruption behavior. A generated
deployment migration plus real two-replica/failure-injection acceptance remain
release gates.

M7 PERSISTENCE MODEL: CodeSite's Prisma schema now models the production
authority boundary: warrants, per-tool remaining budgets, transitive lineage,
idempotency-keyed receipts (`reserved`, `succeeded`, `failed`, `unknown`), and
a per-project hash-chain audit outbox. Each production audit event also stores
its managed-signing key reference and detached signature. This is schema-first
work: the database migration must be generated and reviewed through Prisma
against the deployment database. No hand-authored SQL migration or MCP-local
JSONL store is a production authority substitute.

M8 TRANSACTION AUTHORITY: `warrant_authority.ts` defines the provider-neutral
MCP port. A deployment authority implementation owns its transport and performs
every mutation through a Serializable transaction boundary, locks its tenant
scope, conditionally decrements every ancestor budget, then creates the receipt
and audit-outbox record before returning admission. A structured tool failure
settles `failed` and refunds; a thrown/ambiguous call settles `unknown` and
deliberately retains the debit. Before every authority operation, the authority
verifies the complete tenant/project hash chain and fails closed if it is
missing or corrupted. In production every audit event is signed through an
injected managed-key command boundary. The active key and a trusted public-key
set are deployment values; keysets retain prior verification keys during a
rotation overlap, and missing, local-custody, mismatched, or unverifiable
signatures fail closed. No temporary signing key is generated by the authority.
Serializable-conflict retry is likewise deployment policy rather than a hidden
library default: CodeSite requires positive
`SYNTHI_CODESITE_WARRANT_TRANSACTION_MAX_RETRIES` and
`SYNTHI_CODESITE_WARRANT_TRANSACTION_RETRY_DELAY_MS` values plus a non-empty
`SYNTHI_CODESITE_WARRANT_TRANSACTION_RETRYABLE_ERROR_CODES_JSON` array. The
deployment supplies the retryable codes for its selected persistence driver;
the authority does not embed a vendor code. A matching transient conflict
retries the complete transaction through that injected policy; an absent policy
fails closed and exhaustion is a structured contention response, never a raw
database error.

M9 OPERATIONS: production mode rejects the historical JSONL store entirely;
it cannot be re-enabled with an explicit process-local key.
`NODE_ENV=production` with `SYNTHI_WARRANT_MODE=enforce` rejects MCP requests
unless the host injects a trusted principal, recipient canonicalizer, audience
enforcement, shared authority, authenticated service transport, and resource resolver; embedded and stdio hosts
make the same check at the tool boundary, so they cannot silently use bearer-only process-local
enforcement. In warn/enforce modes,
every resource read needs a trusted host resolver that returns the exact
ordinary grant to reserve and settle. There is no default resource capability, URI
classifier, or production admin-key bypass.
The Prometheus registry exports `synthi_warrant_decisions_total`,
`synthi_warrant_receipts_total`, and
`synthi_warrant_identity_failures_total`,
`synthi_warrant_reservation_settlement_age_ms_total`, and
`synthi_warrant_replays_total`; deployment alerts should page on
authority-unavailable denials, stale-identity rejection growth, replay growth,
or aged `reserved` receipts observed from the authority store.

The opt-in live chaos runner has a warrant two-replica failure-injection
scenario. It receives an operator-provided argv array rather than a fixed
deployment address or orchestration command, and accepts only a redacted,
digest-backed artifact proving distinct replicas, cross-replica authority and
replay behavior, concurrent reservation, lifecycle and service-transport
denial, managed-key rotation/outage handling, audit integrity, and every
required metric. An exit code alone is not acceptance evidence.
