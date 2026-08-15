# Failure Distiller
## Turn a real software failure into the smallest stable debugging world found within a declared budget

## 1. Product thesis

An agent hits a real failure in a large repository:

```text
The invite modal closes but no invitation is sent when the workspace has SSO enabled.
```

The agent may already have useful evidence—a failed test, browser trace, console error, stack trace, HMR event, network event, screenshot, or human click sequence—but that evidence still points into a much larger execution world containing unrelated source, configuration, fixtures, services, feature flags, build machinery, and dependencies.

**Failure Distiller converts that observed failure into a small, executable, evidence-backed failure capsule.**

```ts
const result = await vectant_distill_failure({
  observation: { event_ref: "browser-trace:842" },
  budget: "standard"
});
```

A successful result gives the agent:

- a normal workspace or worktree overlay it can edit;
- a one-command reproducer;
- a stable failure predicate;
- a failure signature showing that the reduced world is failing for the same observed reason;
- a provenance map back to the original workspace;
- a reduction report explaining what was removed, what was retained, and why;
- explicit limits for anything that was mocked, approximated, or could not be isolated.

Example:

```text
Failure capsule: invite-sso-dismisses

Run:
  vectant repro run capsule_7g3

Stability:
  reproduced 20/20 runs

Predicate:
  expected: POST /invites is dispatched after Submit
  observed: modal closes without request

Failure signature:
  submit handler reached
  → SSO policy branch selected
  → close callback executed
  → invite dispatch branch not entered

Retained:
  InviteModal.tsx                 observed execution path
  useInvite.ts                    observed execution path
  ssoPolicy.ts                    removal changes failure signature
  workspace-sso.fixture.json      removal stops reproduction
  invitation contract mock       required external boundary

Reduction:
  132 candidate source/config/fixture units considered
  118 removed
  14 retained
  9 retained because removal stops same-signature reproduction
  5 retained because they are structurally required

Confidence:
  1-minimal under declared unit model and standard budget

Limits:
  real SSO provider replaced by a validated contract mock
```

The goal is not to prove a globally smallest program. That is too expensive and often not well-defined in real build graphs. The contract is:

> **Produce the smallest stable capsule found under a declared reduction boundary, unit model, and resource budget, while preserving evidence that it is still the same failure.**

Codex, Claude Code, or another coding agent can then work on the capsule using ordinary edit/test tools. A candidate patch is accepted only after Vectant maps it back and revalidates it in the original failure environment.

---

## 2. Why this matters

The expensive part of agent debugging is often not editing code. It is discovering the failure boundary.

Given only an issue sentence, stack trace, flaky test, screenshot, or user action that “does nothing,” an agent must repeatedly:

1. locate the owning code;
2. reconstruct state and configuration;
3. discover which services and feature flags matter;
4. determine whether the failure is reproducible;
5. separate causal code from incidental code;
6. make a change;
7. rebuild or replay a large system to learn whether the hypothesis was relevant.

A better prompt helps reasoning but does not remove the execution surface.

Failure Distiller changes the unit of work from:

```text
debug this repository
```

to:

```text
debug this executable failure capsule
```

The output should remain intentionally boring from the agent's perspective: a filesystem, a command, a failure, and normal source files. No proprietary reasoning loop is required.

---

## 3. Non-goals

The first implementation should explicitly avoid trying to solve all forms of debugging.

Failure Distiller is **not** initially responsible for:

- automatically fixing the bug;
- proving a globally minimal program;
- semantic program slicing across arbitrary languages;
- replacing arbitrary production services with perfect emulators;
- minimizing distributed systems across unrestricted network boundaries;
- preserving every performance characteristic of the original system;
- reducing GPU/native/browser/test failures with one universal engine;
- deriving a reliable predicate from an entirely ambiguous screenshot without additional observable evidence.

These may become later capabilities. They should not be prerequisites for the first useful version.

---

## 4. Relationship to existing Vectant capabilities

Failure Distiller should compose existing infrastructure rather than duplicate it.

| Capability | Existing responsibility | Failure Distiller responsibility |
|---|---|---|
| HMR | Apply/reload a candidate change | Reduce the execution world before repeated edits |
| Oracle Ledger | Record explicit pass/fail observations | Store the capsule predicate, signature, stability, and validation evidence |
| Causal Twin | Replay captured execution state and test variants | Use replay as a source world, then reduce it |
| Browser workflow teaching | Record/replay user workflows | Reduce the workflow, state, UI route, and boundaries required for the failure |
| Genome reproducers | Execute reproducers attached to proposed attacks | Derive a reproducer from a naturally observed failure |
| CodeSite replay/evidence | Coordinate and audit work | Consume capsule provenance and validation results |
| Agent Dojo Vivarium | Materialize, mutate, reset, and observe synthetic scenario worlds | Execute reduced capsules safely, reuse fixture/oracle contracts, and turn validated capsules into regression or practice scenarios |

### 4.1 Vivarium integration and usage

Failure Distiller and the Vivarium must share execution primitives, but must retain distinct entry points and claims.

- **Distiller-to-Vivarium handoff:** a distilled capsule may be exported as a Vivarium scenario manifest containing its runnable command, deterministic seed, sanitized fixture requirements, boundary mocks, predicate, failure-signature matcher, reset profile, and declared limits.
- **Reuse the Vivarium runtime:** when a capsule can run in a synthetic world, candidate reductions should be evaluated through the Vivarium fixture materializer, API fault server, UI/document/identity tissue, deterministic reset, and observed-evidence oracle rather than implementing parallel equivalents.
- **No synthetic substitution by default:** the original observed failure remains the baseline authority. A Vivarium materialization is accepted only after its predicate and failure signature match the pre-substitution baseline; otherwise return `boundary_not_isolatable` or `stable_partial` with the mismatch evidence.
- **Regression and skill practice:** after original-world patch validation, the approved capsule can become a seeded Vivarium regression scenario or practice world. Its expected failure and repair must remain versioned separately from the original incident evidence.
- **Evidence interoperability:** reduction decisions and Vivarium run/reset evidence should be written to the shared evidence ledger with capsule ID, scenario ID, source revision, world hash, fixture/manifest digests, oracle result, and redaction metadata.
- **Security boundary:** only sanitized fixtures and validated contract mocks may cross into the Vivarium. Production credentials, production write authority, and unredacted production data are prohibited.

The resulting flow is:

```text
Observed failure
  -> Distiller baseline and reduction
  -> signature-validated Vivarium materialization (when isolatable)
  -> capsule debugging and original-world patch validation
  -> versioned Vivarium regression/practice scenario
```

A useful distinction is:

> **Causal Twin asks whether a captured world can replay. Failure Distiller asks how much of that world can be removed while the same failure remains demonstrably reproducible.**

---

## 5. Core correctness model

A reducer can produce a false “minimal repro” if it preserves the visible symptom for a different reason. Therefore a capsule must preserve more than a boolean failure.

Each distillation defines four things.

### 5.1 Reproduction predicate

The machine-checkable condition that distinguishes pass from failure.

Examples:

```text
POST /invites must be observed within 2 seconds after Submit.
Rendered Save action must become enabled after valid input.
Compiler invocation must emit diagnostic E0425 for source location X.
Simulation energy at frame N+1 must be finite.
```

### 5.2 Failure signature

Evidence that the reduced world reaches substantially the same failure mechanism.

Depending on the failure type, a signature can include:

- normalized stack frames;
- executed source locations;
- callback/event sequence;
- diagnostic code and originating source span;
- selected branch IDs;
- bounded network sequence;
- DOM or scene-state transition;
- process exit/signal information;
- selected log/event fingerprints.

The signature is not required to be identical byte-for-byte. It has explicit matching rules.

Example:

```json
{
  "predicate": "POST /invites missing after Submit",
  "signature": {
    "required_events": [
      "InviteModal.onSubmit",
      "ssoPolicy.evaluate",
      "InviteModal.onClose"
    ],
    "forbidden_events": [
      "inviteClient.dispatch"
    ],
    "stack_prefix": [
      "InviteModal.onSubmit",
      "useInvite.submit"
    ]
  }
}
```

### 5.3 Stability policy

A failure must reproduce consistently enough to reduce.

Policies should be configurable by failure class. For example:

```text
deterministic test:
  5/5 required before minimization

browser/runtime failure:
  >= 9/10 with matching signature

known flaky failure:
  statistical mode with baseline rate and confidence threshold
```

Do not hard-code “20 runs” as the only validity rule. Twenty runs can be useful for a final confidence pass but is unnecessarily expensive for every candidate deletion.

### 5.4 Reduction boundary

The system must state what it is allowed to minimize.

Example:

```json
{
  "units": [
    "test_steps",
    "fixture_records",
    "feature_flags",
    "source_files",
    "config_entries"
  ],
  "immutable": [
    "compiler_version",
    "runtime_version",
    "package_lock"
  ],
  "external_boundaries": "contract_mock_if_validated"
}
```

This makes “minimal” meaningful.

---

## 6. Result states

Distillation must return structured states rather than pretending every failure can become a capsule.

```text
distilled
stable_partial
not_reproducible
unstable_baseline
predicate_ambiguous
boundary_not_isolatable
budget_exhausted
unsupported_runtime
unsafe_external_boundary
```

`stable_partial` is important: a capsule can still be useful even when it is not aggressively minimized.

Every non-success state should include the best available evidence and the next actionable reason.

---

## 7. Capsule contract

Default layout:

```text
.vectant/capsules/invite-sso-dismisses/
  CAPSULE.md
  manifest.json
  repro.json
  provenance.json
  fixture/
  mocks/
  overlay/
  scripts/
    run.mjs
  evidence/
    baseline.json
    signature.json
    validation.json
  reduction.ndjson
```

### `manifest.json`

Describes identity and reproducibility:

```json
{
  "capsule_id": "capsule_7g3",
  "source_revision": "git:8e01c5f",
  "runtime": {
    "node": "22.14.0",
    "package_manager": "pnpm@10.4.1"
  },
  "entrypoint": "vectant repro run capsule_7g3",
  "status": "distilled"
}
```

### `repro.json`

Defines the executable oracle:

```json
{
  "predicate": {
    "type": "network_absence",
    "expected": "POST /invites after Submit",
    "timeout_ms": 2000
  },
  "signature": {
    "matcher": "ordered_event_subset",
    "required": [
      "InviteModal.onSubmit",
      "ssoPolicy.evaluate",
      "InviteModal.onClose"
    ],
    "forbidden": ["inviteClient.dispatch"]
  },
  "baseline": {
    "matching_failures": 10,
    "attempts": 10
  }
}
```

### `provenance.json`

Every editable retained source path maps to an original revision and content hash.

```json
{
  "overlay/InviteModal.tsx": {
    "origin": "apps/web/src/invite/InviteModal.tsx",
    "revision": "8e01c5f",
    "sha256": "..."
  }
}
```

This makes patch mapping explicit instead of relying on an implicit copied workspace.

---

## 8. Workspace model

Use a **worktree/overlay model by default**, but do not require every capsule to physically delete unrelated files.

There are two execution modes.

### Mode A: logical capsule

The workspace remains available, but the reproducer and dependency graph expose only the retained slice to the agent and instrumentation.

Advantages:

- cheap to create;
- preserves normal tooling;
- avoids rewriting complex build graphs;
- ideal for the first MVP.

### Mode B: materialized capsule

Only the required source/config/fixture/dependency surface is materialized into an isolated workspace.

Advantages:

- portable;
- smaller context and indexing surface;
- useful for expensive repositories and remote workers.

Disadvantages:

- much harder to keep package resolution and build behavior equivalent.

**Recommendation:** implement logical capsules first. Materialization becomes an optimization after reduction correctness is proven.

---

## 9. Distillation pipeline

### Phase 0. Freeze the baseline

Before removing anything:

1. record source revision and dirty workspace state;
2. capture runtime/compiler/package-manager versions;
3. capture the original command or replay envelope;
4. run the failure enough times to estimate stability;
5. extract the initial predicate and failure signature;
6. refuse minimization if the baseline cannot be distinguished reliably from success.

The baseline is immutable evidence for the rest of the run.

### Phase 1. Build an observed frontier

Start from runtime evidence rather than the entire static import graph.

Possible signals:

```text
failing observation
  → process/test/browser action
  → executed functions/modules
  → state/config reads
  → fixture/data reads
  → rendered nodes
  → network/filesystem/process boundaries
```

Then add the minimum static closure needed for:

- parsing;
- module resolution;
- compilation;
- initialization;
- runtime loading.

The initial frontier should be an over-approximation. Reduction comes later.

### Phase 2. Normalize the world

Many false reductions come from uncontrolled environment differences.

Freeze or explicitly record:

- clock/timezone;
- random seeds where possible;
- locale;
- environment variables;
- feature flags;
- package/runtime versions;
- filesystem fixture state;
- browser viewport/device profile;
- network policy;
- database snapshot/transaction state.

Anything that cannot be frozen becomes a declared source of nondeterminism.

### Phase 3. Isolate external boundaries

External systems are treated conservatively.

Allowed representations:

1. **record/replay boundary**  
   Use a captured, redacted interaction when deterministic replay is sufficient.

2. **contract mock**  
   Implement only the observed relevant contract.

3. **fixture snapshot**  
   Use a sanitized local dataset or database snapshot.

4. **live boundary retained**  
   Keep the service if isolation would invalidate the failure and policy permits it.

5. **cannot isolate**  
   Stop or return a partial capsule.

A mock is not considered valid merely because the predicate still fails. After substitution, Vectant must rerun the failure signature check against the pre-substitution baseline.

No capsule may contain production secrets, unrestricted credentials, or production write authority.

### Phase 4. Reduce hierarchically

Use coarse-to-fine hierarchical delta debugging.

Recommended order:

1. workflow/test steps;
2. fixture records and seed data;
3. feature flags and configuration entries;
4. optional external interactions;
5. source modules/files;
6. dependency groups;
7. source declarations/functions when language tooling is reliable;
8. statements/branches only for supported languages and only as an advanced pass.

Do **not** start by rewriting arbitrary source code. File/config/data-level reduction gives most of the value with much lower semantic risk.

For each candidate removal:

```text
apply candidate reduction
→ can world load?
→ does predicate still fail?
→ does failure signature still match?
→ does stability threshold still hold?
→ if yes: retain reduction
→ if no: revert
```

### Phase 5. Cache and parallelize candidate evaluation

Naive delta debugging can explode in runtime.

The reducer should cache evaluation by a content-addressed world hash:

```text
hash(
  source overlay
  + fixture
  + config
  + boundary mocks
  + replay command
  + runtime identity
)
```

Independent candidates may be tested in parallel workers if the runtime allows it.

The budget controls:

- maximum candidate executions;
- wall-clock budget;
- concurrency;
- minimum stability sample;
- maximum fine-grained reduction level.

### Phase 6. Confirm local minimality

When the main reducer stops, run a confirmation pass over retained removable units.

The practical claim should be:

```text
1-minimal under declared unit model:
removing any single removable retained unit either
(a) stops same-signature reproduction,
(b) makes the capsule invalid, or
(c) exceeds a declared unsupported boundary.
```

This is much more defensible than “smallest possible world.”

### Phase 7. Produce the agent workspace

The agent gets only what it needs:

```json
{
  "capsule_id": "capsule_7g3",
  "workspace_path": ".vectant/capsules/invite-sso-dismisses",
  "run": "vectant repro run capsule_7g3",
  "status": "distilled",
  "baseline": {
    "matching_failures": 10,
    "attempts": 10
  },
  "reduction": {
    "candidate_units": 132,
    "removed_units": 118,
    "retained_units": 14,
    "minimality": "1-minimal_under_declared_units"
  },
  "limits": [
    "SSO provider represented by validated contract mock"
  ]
}
```

---

## 10. Candidate fix validation

Healing the capsule is necessary but not sufficient.

A candidate patch moves through four gates:

```text
Gate 1
capsule fails before patch with matching signature

Gate 2
capsule passes after patch

Gate 3
original failure envelope passes after mapped patch

Gate 4
affected original checks show no detected regression
```

The exact affected checks can be derived from:

- original failing tests;
- dependency impact;
- touched packages;
- recorded browser workflow;
- user-selected validation commands.

### Patch mapping rules

A patch can be mapped automatically only when:

- every edited source file has provenance;
- its source revision/hash still matches or cleanly rebases;
- no capsule-only shim or mock is edited as if it were production code.

Edits to mocks, fixtures, or capsule infrastructure must be classified separately.

If mapping is ambiguous, return:

```text
patch_mapping_conflict
```

rather than applying speculative changes.

### Capsule mismatch feedback

If a patch fixes the capsule but not the original environment, do **not** immediately call the capsule “over-minimized.” Several causes are possible:

- missing causal dependency;
- invalid mock;
- failure signature too weak;
- environment drift;
- patch mapping error;
- hidden state not captured.

The system should classify the mismatch, expand or invalidate the relevant boundary, and preserve the failed validation as evidence.

---

## 11. Security and isolation

Failure Distiller executes repository code repeatedly, so its security model is part of the product.

Default capsule execution should use:

- filesystem isolation;
- no production credentials;
- denied outbound network unless explicitly required;
- scoped temporary writable directories;
- CPU/memory/process/time limits;
- package-install policy;
- explicit handling of repository lifecycle scripts;
- redaction before persistence;
- auditable boundary recordings.

External recordings should be treated as potentially sensitive workspace data.

Capsules should have clear retention and deletion controls.

---

## 12. Reduction evidence

Every reduction decision should be machine-readable.

Example `reduction.ndjson` entry:

```json
{
  "candidate": "config.featureFlags.analytics",
  "operation": "remove",
  "world_hash": "sha256:...",
  "load": "ok",
  "predicate": "fail",
  "signature": "match",
  "runs": {
    "matching_failures": 3,
    "attempts": 3
  },
  "decision": "removed"
}
```

Retained units should have explicit reasons:

```text
causal_required
structural_required
boundary_required
unstable_when_removed
unsupported_reduction
budget_not_tested
```

This avoids falsely presenting untested retained units as proven necessary.

---

## 13. APIs

### Distill

```ts
const result = await vectant_distill_failure({
  observation: {
    event_ref: "browser-trace:842"
  },
  predicate: "auto",
  budget: {
    preset: "standard"
  },
  reduction: {
    units: ["steps", "fixtures", "config", "source_files"]
  }
});
```

### Run

```bash
vectant repro run capsule_7g3
```

### Explain

```bash
vectant repro explain capsule_7g3 ssoPolicy.ts
```

Example:

```text
ssoPolicy.ts retained:
  removal tested in world sha256:...
  world loaded successfully
  predicate no longer reproduced
  therefore: causal_required under current signature
```

### Validate patch

```ts
const validation = await vectant_validate_capsule_fix({
  capsule_id: "capsule_7g3",
  patch_ref: "agent-change:19"
});
```

---

## 14. Implementation roadmap

The original idea becomes much more achievable if the implementation is staged by reduction risk.

### Milestone 0 — Reproduction envelope

Build before minimization.

Support:

- command/test capture;
- runtime identity;
- deterministic environment recording;
- predicate adapter;
- failure signature adapter;
- repeated stability runs;
- result-state model.

Success condition:

> Vectant can replay an observed supported failure and tell whether a later run is the same failure.

Without this, minimization has no trustworthy oracle.

### Milestone 1 — Pytest/Vitest fixture and config distillation

Do **not** minimize production source yet.

Support:

- one failing test target;
- imported/loaded module observation;
- fixture record reduction;
- parameter/input reduction;
- environment/config reduction;
- test-helper reduction;
- one-command capsule runner;
- reduction log.

Why first:

- deterministic;
- cheap to execute;
- strong existing pass/fail oracle;
- easy to benchmark;
- useful in real repositories.

Success condition:

> Reduce real failing tests substantially while preserving the same diagnostic/signature and producing a stable one-command repro.

### Milestone 2 — File/module-level source reduction

Add:

- source-file/module candidate units;
- static closure validation;
- content-addressed execution cache;
- 1-minimal confirmation pass;
- provenance map;
- agent-editable logical capsule.

Avoid function/statement rewriting in this milestone.

Success condition:

> Agents need fewer repository-search/tool calls to locate and fix seeded or historical bugs than when given the full repository.

### Milestone 3 — Patch round-trip

Add:

- capsule patch capture;
- provenance-based mapping;
- original-world validation;
- mismatch classification;
- selective affected-test execution.

This milestone is required before claiming the capsule is a safe debugging workflow rather than only a reproducer generator.

### Milestone 4 — Browser workflow distillation

Prerequisites:

- stable taught workflow replay;
- source/event attribution;
- network boundary recording;
- deterministic fixture state.

Reduction order:

1. user steps;
2. route/state fixture;
3. network events;
4. feature flags/config;
5. source modules.

Success condition:

> A recorded browser failure can be reduced without changing its event/network/source signature, fixed in the capsule, and validated in the original flow.

### Milestone 5 — Vivarium capsule execution and graduation

Integrate with the Agent Dojo Vivarium rather than building a second synthetic-world runtime.

Add:

- capsule-to-scenario manifest adapter;
- deterministic mapping from capsule fixture and boundary requirements to Vivarium tissue/materializers;
- shared predicate/signature oracle adapter;
- reset and run evidence linked to the capsule reduction log;
- promotion of an original-world-validated capsule into a versioned regression or practice scenario.

Success condition:

> A supported distilled capsule can execute in a deterministic, sanitized Vivarium world; its oracle evidence is linked to the original baseline; and a validated fix can be replayed as a regression scenario without replacing original-world validation.

### Milestone 6 — Materialized portable capsules

Only after logical capsules work reliably:

- physically materialize source closure;
- trim dependencies;
- generate local module/package shims where safe;
- verify build/runtime equivalence;
- optionally export/share inside the same security domain.

### Milestone 7 — Native/HMR/GPU failures

Treat these as separate adapters over the same core reduction engine.

Possible units:

- compiler flags;
- shader inputs;
- scene nodes;
- assets;
- frame/event sequences;
- native source modules.

Do not make these a dependency of the web/test MVP.

---

## 15. Architecture

```text
Observed Failure
      │
      ▼
Baseline Recorder
      │
      ├── Predicate Adapter
      ├── Signature Adapter
      └── Environment Snapshot
      │
      ▼
Frontier Builder
      │
      ├── Runtime evidence
      └── Static load/compile closure
      │
      ▼
Boundary Isolator
      │
      ▼
Hierarchical Reducer
      │
      ├── Candidate generator
      ├── World materializer/overlay
      ├── Execution cache
      ├── Stability evaluator
      └── Evidence log
      │
      ▼
Capsule Builder
      │
      ▼
Agent edits capsule
      │
      ▼
Patch Mapper
      │
      ▼
Original-world Validator
```

The reducer should be runtime-agnostic. Runtime-specific adapters own:

- instrumentation;
- candidate-unit discovery;
- world construction;
- predicate/signature extraction;
- execution.

This prevents the browser, test, Python, Node, and native implementations from becoming one hard-coded engine.

---

## 16. Metrics

“Capsules are smaller” is not enough. Measure whether they improve agent debugging.

### Reproduction quality

- baseline reproduction rate;
- capsule reproduction rate;
- signature-match rate;
- false-equivalence rate discovered during original-world validation.

### Reduction quality

- source/config/fixture units removed;
- dependency bytes removed;
- workflow steps removed;
- setup/startup time reduction;
- final 1-minimal confirmation coverage;
- percentage of retained units with tested necessity versus structural/untested reasons.

### Agent utility

Compare full-repository debugging with capsule debugging:

- tool calls before first relevant edit;
- repository-search calls;
- tokens/context consumed;
- time/executions to candidate fix;
- percentage of fixes that touch the true faulty region;
- successful original-world validation rate.

### Cost

- candidate executions per capsule;
- CPU time;
- wall-clock time;
- cache hit rate;
- average reduction by budget preset.

These metrics reveal whether the reducer is economically useful, not just technically interesting.

---

## 17. Budget presets

Example:

```text
fast
  coarse units only
  low stability sample
  100 candidate executions
  no source-declaration reduction

standard
  steps/fixtures/config/files
  adaptive stability
  1,000 candidate executions
  1-minimal file-level confirmation

deep
  finer supported language units
  larger stability sample
  parallel reduction
  extended confirmation pass
```

A budget exhaustion result is still useful if it says exactly what remains untested.

---

## 18. Guardrails

- Never claim global minimality.
- Never minimize an unstable baseline as though it were deterministic.
- Never accept a reduction on the predicate alone when a failure signature is available.
- Never treat a new mock as equivalent without revalidation.
- Never copy production secrets or unrestricted credentials.
- Never auto-edit the original workspace during distillation.
- Never auto-apply an ambiguously mapped patch.
- Never hide untested retained units behind the word “required.”
- Always preserve source revision and provenance.
- Always replay accepted fixes in the original failure environment.
- Always expose budget exhaustion, unsupported boundaries, and nondeterminism.
- Keep capsule deletion/expiry explicit and auditable.

---

## 19. Initial benchmark suite

Before broad rollout, build a corpus of failures with known causes:

```text
Vitest
  feature-flag branch bug
  fixture-dependent bug
  async timing bug
  environment-variable bug
  shared helper bug

Pytest
  parameter-dependent bug
  fixture/database-state bug
  import-time configuration bug
  filesystem-state bug

Browser
  wrong feature flag
  missing API dispatch
  stale state
  route-specific rendering bug
```

For each benchmark record:

- known faulty region;
- original repository size;
- expected essential fixtures/config;
- baseline signature;
- whether mocks are allowed;
- accepted fix.

This gives objective regression tests for the distiller itself.

---

## 20. MVP definition

A credible MVP is narrower than the full vision.

### Supported

- Git workspace;
- Node/Vitest and Python/Pytest;
- deterministic or near-deterministic failing test;
- test/fixture/config/helper/file-level reduction;
- logical capsule overlay;
- one-command repro;
- predicate + failure signature;
- source provenance;
- reduction evidence;
- patch validation against original workspace.

### Explicitly unsupported in MVP

- arbitrary screenshot-only failures;
- distributed production failures;
- browser workflow reduction;
- native/GPU reduction;
- statement-level arbitrary source minimization;
- portable dependency-pruned repository export.

### MVP success bar

On a benchmark of real repository failures:

1. at least 90% of accepted capsules reproduce the same-signature failure at the configured stability threshold;
2. at least 80% of accepted capsule fixes that pass capsule validation also pass original-world failure validation;
3. median candidate source/config/fixture surface is reduced by at least 70%;
4. capsule-assisted agents use materially fewer discovery/search operations before the first relevant edit;
5. every retained unit is labeled with a tested or structural reason;
6. no production credential is persisted into a capsule.

The exact numerical thresholds should be tuned after the first benchmark run, but the MVP should ship with explicit targets rather than qualitative claims.

---

## 21. Agent loop

```text
agent observes a real failure
  → vectant_distill_failure
  → Vectant verifies baseline and same-failure signature
  → Vectant returns distilled or stable-partial capsule
  → agent edits normal source in the capsule
  → vectant_validate_capsule_fix
  → patch mapped through provenance
  → original failure environment replayed
  → affected checks run
  → validated patch offered for normal application
```

The critical behavior change is that the agent no longer begins with “find the bug somewhere in this repository.” It begins with a bounded executable world and evidence describing why that world exists.

---

## 22. Verified implementation status

This section records implementation evidence; it does not relax any preceding
requirement or turn a partially supported adapter into a universal one.

| Contract area | Verified implementation evidence |
|---|---|
| Reproduction envelope and isolation | Source revision/dirty policy, runtime identity, deterministic environment, predicate/signature stability evidence, retention/deletion audit, redaction, and fail-closed container execution are covered by the distiller and isolation suites. A real container test verifies outbound network denial. |
| Pytest/Vitest reduction | Versioned benchmark fixtures execute the real Pytest and Vitest runners, reduce declared fixture/config/file candidates, and validate accepted repairs by rerunning the original commands. |
| Source reduction and cache | Logical capsules retain provenance, use content-addressed persistent evaluation caching, support Python declaration/statement candidates, perform 1-minimal confirmation, and safely prefetch independent confirmation candidates in isolated worktrees. |
| Patch round-trip | Capsule edits require verified provenance; mapping conflicts and capsule-only edits are rejected. Capsule, original-world, and affected-command gates are retained as validation evidence. |
| Browser workflow | The browser adapter validates both recorded workflow envelopes and Synthi taught-workflow contracts, including route/state/device/viewport, source attribution, DOM, network, and console evidence. Current automated replay coverage is contract/envelope based; a real headed-browser failure target remains required before claiming browser-runtime parity. |
| Portable capsules | Materialization verifies integrity, copies Node and imported non-stdlib Python dependency closures without source-workspace symlinks, writes reproducible metadata/scripts, and independently reruns the same signature. Browser dependency closure support must be verified per runtime before browser portability is claimed. |
| Native/HMR/GPU | Separate typed adapters validate native diagnostics/source spans, HMR terminal event sequences, and GPU device/frame/error evidence. The benchmark and isolated round-trip suite exercise all three envelopes. Hardware/compiler-specific runtime parity remains adapter-dependent. |
| Quality gates | The versioned corpus contains Pytest, Vitest, browser, native, HMR, and GPU cases. CI enforces reproduction, reduction, original-validation, false-equivalence, and deterministic capsule path-discovery gates and publishes JSON/Markdown reports. |

The exact commands and report values are part of the release handoff; a green
unit suite alone is not evidence that an unsupported external runtime is safe
to isolate.

---

## 23. Product sentence

> **Give Vectant a real reproducible failure. It gives an agent the smallest stable debugging world it can prove under the chosen budget—and verifies the fix back in the real one.**

A shorter UI version:

> **Turn a real failure into a tiny executable debugging world.**

The value is not prettier bug reports. It is reducing the amount of software an agent must understand before it can make and validate a relevant change.
