# Phase 0 Implementation Goal: Neutral Embodied Core

Status: active implementation goal for docs/UNIVERSAL_EMBODIED_TEACHING_PLAN.md
Scope: extract the substrate-neutral core of the teaching pipeline with zero behavior change to the existing browser path.
Rule that governs every patch: nothing in `src/embodied/` may know about doors, colors, nginx, or any other scenario. Semantics enter only through schemas and profiles supplied at runtime.

---

## Why Phase 0 exists

The browser pipeline (capture → trace → causal workflow contract → hardening → replay → classification) is the right shape but browser-typed end to end. Phase 0 proves the shape is separable: same behavior, neutral types. It also builds the two things every later phase stands on:

1. a lossless event model (`EmbodiedEvent`) that embeds today's browser trace unchanged;
2. an anti-hardcoding conformance harness on a randomized toy substrate, so universality is enforced by tests rather than intentions.

## Definition of Done (whole phase)

1. `src/embodied/` contains: `event.ts`, `consent.ts`, `classifier.ts`, `contract.ts`, `substrate.ts`, `world_state.ts`, `affordance.ts`, `state_differ/`.
2. `EmbodiedEvent` round-trips `BrowserTraceEvent` losslessly both directions (property-style tests over the full kind × action matrix).
3. Browser production code paths are untouched; the only changes to existing files are type-only imports or re-exports where a shared type replaces a duplicate definition.
4. The toy substrate passes record → differ → compile → replay across ≥50 randomized seeds with zero scenario nouns anywhere in the core.
5. Mutation check: injecting one deliberate scenario-specific shortcut into the core makes the conformance fuzz fail (verified once, then reverted).
6. Full unit test suite green; `tsc --noEmit` clean.
7. Each numbered work item below lands as its own commit, ordered, each leaving the tree green.

## Work Items (commit sequence)

### 0.1 — EmbodiedEvent model + lossless conversion

Files: `src/embodied/event.ts`, `tests/unit/embodied_event.test.ts`

Deliverables:

- `SubstrateKind`, `RealmRef`, `EnvironmentRef` types implementing the substrate/realm/environment trichotomy from the plan.
- `EmbodiedAction` covering discrete + continuous primitives (`primitive_class`, quantization/tolerance fields optional per class).
- `AffordanceCandidate` with stability tiers T0–T4.
- `StateDeltaRef` referencing differ output by id (deltas attach during reduction, not capture).
- `EmbodiedEvent` superset: browser events convert via `toEmbodied()` / `fromEmbodied()` with **no field dropped** — assert deep-equality after round-trip on generated matrices covering all 15 `BROWSER_ACTION_KINDS`, both human/agent actors, all security-flag combinations, redacted and unredacted values, semantic annotations present and absent.
- Conversion functions live in the embodied core and are pure (no IO).

Acceptance: property tests green over the full matrix; round-trip is bit-stable modulo JSON serialization; no browser imports inside `embodied/event.ts` (enforced by an import-boundary lint test that greps the module graph).

### 0.2 — Realm consent records

Files: `src/embodied/consent.ts`, `tests/unit/embodied_consent.test.ts`

Deliverables:

- `RealmConsentRecord` generalizing `BrowserConsentRecord`: realm ref, per-capability status (observe/record/act), grant/deny/revoke timestamps, reason.
- Exact-realm matching helper: equality, never prefix/suffix/subdomain; documented non-crossing rules (scheme/host/port/path-root/world id/container id are all exact-match components).
- Capability independence: observe-consent grants nothing for act; revocation clears act capability first (lease semantics stay with the broker).
- A pure decision function `evaluateConsent(record, request) -> allowed | denied | unset` used by adapters; no IO, no clock reads (time injected).

Acceptance: table-driven tests prove no crossing on any component mutation; capability isolation tests; browser consent records convert to realm records losslessly.

### 0.3 — Failure classifier trunk

Files: `src/embodied/classifier.ts`, `tests/unit/embodied_classifier.test.ts`

Deliverables:

- `FailureTrunkClass` union mirroring the shared trunk of `FailureClassV7` (locator/perception drift, auth missing/expired/refresh-failed, mutation blocked, unsafe environment, test-data missing, route/world changed, hydration/load delay, network failure, app validation error, unknown).
- Namespaced subclass registry: `registerSubstrateClasses(substrate, classes[])`; collisions rejected; unknown-substrate lookups return trunk-only.
- Total mapping `fromBrowserFailureClass(FailureClassV7) -> { trunk, sub? }` covering every V7 member.
- Classifier input is evidence-shaped (observed vs expected predicates, timing, exit signals), not string-matching error text.

Acceptance: exhaustive V7 mapping test; registry collision and isolation tests; no substrate names hardcoded in trunk logic beyond the registry keys themselves.

### 0.4 — Substrate-neutral contract spine

Files: `src/embodied/contract.ts`, `tests/unit/embodied_contract.test.ts`

Deliverables:

- Types extracted from the browser workflow compiler's spine: step id, intent text, preconditions/effects as predicate refs, tolerated variants, hard failures, recovery rule, data bindings, uncertainty annotation (evidence kind: `fork_control | multi_demo_vote | temporal_only`, sample count, truncation flag).
- Severity rules as pure functions: a `temporal_only` effect cannot be promoted to hard failure or license-gating effect without human confirmation flag; low-certainty predicates are rejected from high-severity slots.
- Contract versioning: `embodied_contract_version` constant; forward-compatible parse (unknown fields preserved).
- No emission logic yet — Phase 0 defines the data contract and validation only.

Acceptance: severity-rule tests (promotion refusal cases); round-trip parse preserving unknown fields; zero imports from `../browser/*`.

### 0.5 — World state + affordance + schema contracts

Files: `src/embodied/world_state.ts`, `src/embodied/affordance.ts`, `tests/unit/embodied_world_state.test.ts`

Deliverables:

- `WorldStateSchema` exactly as specified in the plan: schema_id/version (semver), typed value paths, identity block (id_scheme: stable|session|derived, stability guarantees, reidentification rule), observability block (fully_observable, hidden-state declarations, partial-observability policy), semantic type weights (core defaults, adapter-extensible, reorder-proof), noise fingerprints.
- Schema validation function with precise rejection reasons.
- `AffordanceCandidate` tier ordering utilities: `tierAtLeast(t)`, downgrade propagation when identity cannot survive a variant class.
- Predicate value types (typed leaves, no `any`): boolean, number+unit, enum, hue-band, path, ref.

Acceptance: schema validation matrix (valid documents accepted; each rule violation produces its specific reason); weight-reorder rejection test; tier-ordering property tests.

### 0.6 — State Differ stages 2–5

Files: `src/embodied/state_differ/*.ts`, `tests/unit/embodied_state_differ.test.ts`

Deliverables:

- Stage 2 relevance filter: salience scoring with injected weight profiles (w1 proximity, w2 action-window coincidence, w3 persistence, w4 semantic-type weight from schema, w5 novelty), budget with flagged truncation (`delta_truncated: true` + dropped count) — never silent truncation.
- Stage 3 attribution: actor-caused vs ambient vs induced vs unknown using action windows plus control comparisons; evidence kinds `fork_control` (fork diff available), `multi_demo_vote` (≥2 demonstrations agreement), `temporal_only`; ambient detection consumes schema noise fingerprints.
- Stage 4 persistence: durable / transient / oscillating classification from settle-window observations; oscillating entries feed back into known-noise fingerprints.
- Stage 5 predicate compilation: schema-typed predicates with uncertainty annotations derived from evidence kind + sample count + truncation.
- Stage 1 stays adapter-side: the differ accepts `ChangedValue[]` produced by an adapter-supplied diff function; the toy substrate provides one such implementation for tests.

Acceptance: golden tests per stage with synthetic ChangedValue streams containing known ambient oscillators, transient toasts-equivalents, and durable effects; truncation always flagged; `temporal_only` never reaches hard-failure slots (ties into 0.4 severity rules).

### 0.7 — Capability-split substrate registry + toy substrate conformance harness

Files: `src/embodied/substrate.ts`, `tests/unit/embodied_toy_substrate.test.ts`

Deliverables:

- Capability interfaces: `Observer` (+`describeWorld`), `Actor`, `Recorder`, `ResetProvider`, `ForkProvider`, `ReplayProvider`; structural negotiation — downstream code receives only the capabilities an adapter declares.
- In-process deterministic toy substrate: seeded grid world with N entities, per-entity attributes (including color-family enums chosen at random per seed), ambient oscillators (clocks, wanderers), hidden state slice declared in its schema, continuous actions (move/turn with tolerance) and discrete ones (interact). All randomness behind a seed; double-run hash equality enforced.
- Conformance fuzz driver: randomize seed → scripted pseudo-random demonstration (walk, turn, interact, observe) → record → run State Differ → compile minimal contract → replay on forked and reset worlds → assert expected-effect match and discrimination (succeeds on equivalent fork, fails on twin with mutated target attribute).
- Mutation gate: a companion test asserts the *absence* of scenario nouns in `src/embodied/**` source (grep-based boundary test): `door`, `purple`, `nginx`, `toast`, specific file names from fixtures, etc.

Acceptance: ≥50 seeds pass full pipeline with identical core code; discrimination holds on adversarial twins for every seed; boundary grep clean; deliberate-shortcut mutation check performed once manually during review (documented in commit message of 0.7), then reverted.

### 0.8 — Browser adapter wrapper (thin)

Files: `src/browser/embodied_adapter.ts`, `tests/unit/embodied_browser_wrapper.test.ts`

Deliverables:

- Implements Observer/Recorder/ReplayProvider capabilities over existing broker/trace/ci_replay functions — delegation only, no logic duplication.
- Converts between `BrowserTraceEvent` and `EmbodiedEvent` via 0.1's pure functions.
- Registers in the substrate registry under `browser` with realm = origin.

Acceptance: wrapper tests use fake broker handles; existing browser suite remains green; no browser logic moves into the core.

## Non-goals for Phase 0

- No MCP tool surface changes (tools come with Phase 1 adapters).
- No UI changes.
- No compiler emitter (Playwright or otherwise).
- No terminal/game/kernel adapters yet.

## Verification commands (each commit)

```bash
cd mcp/synthi-mcp
npx tsc --noEmit
npx vitest run tests/unit --reporter=basic
```

Baseline before 0.1 must be recorded in the 0.1 commit message (test counts, pass/fail).

## Risks

- The repo currently has pre-existing git object corruption in unreachable storage (fsck reports ~52 broken links, none reachable from HEAD or origin/main; auto-gc disabled as mitigation). If commits start failing, stop and surface to the user before any repair attempt.
- npm lockfile was out of sync with package.json (`@vectant/atomic-orchestrator`, vitest 4.x entries missing); resolved via `npm install` — if versions drift from CI, flag it instead of pinning silently.
