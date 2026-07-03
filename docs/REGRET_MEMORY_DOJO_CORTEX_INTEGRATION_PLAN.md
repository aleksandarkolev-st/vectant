# Regret Memory Integration Plan For Agent Dojo Vivarium Cortex

**Status:** integration planning document  
**Date:** 2026-06-24  
**Source plans:**  
- `docs/REGRET_MEMORY_NOVELTY_PLAN.md`  
- `docs/AGENT_DOJO_FULL_MATURE_VIVARIUM_CORTEX_PLAN.md`  

## 1. Integration Thesis

Regret Memory should become the counterfactual telemetry and policy-learning layer inside the Agent Dojo Vivarium Cortex.

Dojo already defines the mature runtime world:

```text
Skill Seed
  -> executable Skill Cortex graph
  -> Vivarium / Workspace Organoid
  -> Wind Tunnel
  -> Checkride
  -> Evidence Ledger
  -> Case Law
  -> License / Proof Capsule
  -> MCP Skill Bus
```

Regret Memory adds the missing learning loop around alternate execution paths:

```text
Dojo run
  -> multiple execution branches
  -> detector and oracle evidence
  -> selector choice or override
  -> near-miss archive
  -> policy delta
  -> changed future graph planning, practice scenarios, guardrails, and runner strategy
```

The integration should not frame Regret Memory as generic user preference memory. Inside Dojo, Regret Memory is:

> counterfactual evidence for improving skill graphs, checkrides, case law, licenses, and future execution policy.

## 2. Product Boundary

Regret Memory does not replace Dojo subsystems.

It should not own:

- graph execution
- proof capsule signing
- license enforcement
- case law approval
- tenant governance
- source/API promotion
- MCP dispatch

It should own:

- counterfactual run grouping
- branch trace normalization
- choice scene capture
- exposure and ambiguity classification
- near-miss evidence summarization
- regret lesson extraction
- policy delta generation
- execution niche aggregation
- novelty and accepted-surprise measurement

In short:

```text
Dojo proves what a skill is allowed to do.
Regret Memory learns from what the skill almost did, failed to do, was blocked from doing, or was overridden away from doing.
```

## 3. Object Mapping

| Regret Memory object | Dojo Cortex counterpart | Integration role |
|---|---|---|
| `CounterfactualRun` | `GraphExecutionRun`, `VivariumRun`, `WindTunnelRun`, `CheckrideRun` | Wraps one comparable experiment across branches. |
| `BranchTrace` | `GraphExecutionRun` variant, scenario attempt, runner trace | Normalizes alternate paths from graph/runtime/agent runners. |
| `DetectorResult` | Evidence record, oracle result, assertion result, guardrail result | Reuses Dojo evidence instead of inventing a parallel proof store. |
| `ChoiceScene` | UI selection, arbiter recommendation, approval decision, checkride outcome | Records what was actually comparable and selectable. |
| `BranchFossil` | Compact evidence summary, case-law candidate input | Durable near-miss summary after retention filtering. |
| `ExecutionNicheMap` | Workspace policy profile, skill policy memory, graph planning hints | Aggregates what survives for a workspace, skill, and task class. |
| `PolicyDelta` | `PolicySet` update candidate, graph compiler hint, guardrail candidate, scenario mutation hint | Operational output that must change a future Dojo run. |
| `MutationTrial` | Evil Twin / quarantined Wind Tunnel scenario | Evidence-backed violation of current policy under stricter gates. |
| `AcceptedSurprise` | high-novelty branch that passes proof and is retained | A key quality metric for mature Dojo learning. |

## 4. Architecture Placement

Add Regret Memory as a peer service beside Evidence, Case Law, and Governance:

```text
mcp/synthi-mcp/src/dojo/
  regret/
    types.ts
    counterfactual_run.ts
    branch_trace.ts
    choice_scene.ts
    exposure.ts
    regret_arbiter.ts
    branch_fossil.ts
    execution_niche_map.ts
    policy_delta.ts
    novelty.ts
    mutation_trial.ts
    store.ts
    service.ts
```

Dojo runtime integration points:

```text
graph/runtime.ts
  -> emits branch traces and graph execution evidence

vivarium/runner.ts
  -> starts CounterfactualRun for comparable scenario variants

vivarium/wind_tunnel.ts
  -> records mutation branches and failed near-misses

checkride/runner.ts
  -> records branch-level checkride alternatives and outcomes

evidence/ledger.ts
  -> stores detector/oracle evidence referenced by Regret Memory

case_law/registry.ts
  -> consumes strong regret lessons as proposed cases only when evidence-backed

license/kernel.ts
  -> consumes policy deltas only after promotion, never from raw weak signals

governance/service.ts
  -> exposes inspect/delete/promote controls
```

## 5. Core Rule

Regret Memory must never treat "not selected" as automatically rejected.

Every learning event needs a `ChoiceScene`.

Minimum viable choice scene:

```text
same skill or task
same base state or reset profile
available branches known
visible branches known
proof/oracle evidence attached
arbiter recommendation recorded when present
selector action recorded
ambiguity flags recorded
```

This protects Dojo from bad case law, bad guardrails, and bad policy promotion.

## 6. Evidence Ledger Integration

Regret Memory should reference the Dojo Evidence Ledger rather than storing raw proof inline.

Add evidence claim kinds:

```text
counterfactual_run_started
branch_trace_normalized
branch_detector_result
choice_scene_recorded
branch_fossil_created
regret_lesson_extracted
policy_delta_proposed
policy_delta_promoted
mutation_trial_started
mutation_trial_completed
```

Evidence requirements:

- every `BranchTrace` points to evidence IDs
- every `PolicyDelta` points to source run, branch, detector, oracle, and selection evidence
- every promoted lesson has a hashable audit trail
- raw traces can expire while compact fossils remain
- redaction must happen before long-term fossil storage

## 7. Case Law Integration

Regret Memory should feed Case Law cautiously.

Allowed:

- strong, evidence-backed repeated failures become proposed case law
- post-apply mutation patterns become guardrail candidates
- rejected risky branches become scenario seeds for future Wind Tunnel tests
- Mutation Trials that reveal a real hazard become proposed antibodies

Not allowed:

- weak or invisible branch non-selection becomes binding case law
- one-off selector taste becomes organization policy
- ambiguous cancellation becomes a guardrail
- novelty preference becomes proof relaxation

Promotion path:

```text
BranchFossil
  -> RegretLesson
  -> PolicyDelta hypothesis
  -> repeated confirmation or reviewer approval
  -> proposed CaseLaw
  -> approved CaseLaw
  -> executable guardrail predicate
```

## 8. License And Proof Integration

Policy deltas can influence future license scope, but only after promotion.

Examples:

```text
Repeated near-miss:
  API-backed branch passes proof but manual selection keeps DOM fallback.

Possible delta:
  Keep DOM fallback in license until API branch passes two more checkrides.
```

```text
Repeated post-apply mutation:
  User removes broad destructive action after accepting skill.

Possible delta:
  Narrow license action scope and require approval node for destructive variant.
```

Hard boundary:

```text
Regret Memory can propose.
Proof and License decide.
```

Novelty must never lower proof requirements. A novel branch can only win after passing the same or stricter proof gates.

## 9. Vivarium And Wind Tunnel Integration

The Vivarium is the natural place to produce high-quality counterfactuals because it can reset the world and compare branches fairly.

Add counterfactual modes:

```text
baseline branch
conservative graph branch
source/API substrate branch
guardrail-heavy branch
latency-optimized branch
novel runtime branch
mutation trial branch
```

Wind Tunnel should use regret fossils to generate scenarios:

```text
near-miss failed because duplicate entity existed
  -> add duplicate-entity scenario

user overrode broad branch for smaller scoped action
  -> add minimal-scope scenario

API substrate branch passed but was not selected due to missing rollback proof
  -> add rollback oracle scenario
```

This is the strongest integration path: near-misses become practice worlds.

## 10. Skill Cortex Graph Integration

Regret Memory should affect graph compilation and planning through explicit hints.

Add graph planning inputs:

```ts
type RegretPlanningHint = {
  skillId: string
  taskClass: string
  hintKind:
    | "prefer_substrate"
    | "avoid_substrate"
    | "add_guardrail"
    | "add_assertion"
    | "split_node"
    | "narrow_scope"
    | "increase_oracle_budget"
    | "include_mutation_trial"
  confidence: "low" | "medium" | "high"
  evidenceIds: string[]
  expiresAt?: string
}
```

The graph compiler may use hints to:

- add a guardrail node
- add a postcondition assertion
- choose API over DOM substrate
- split a broad action into smaller nodes
- add a human approval branch
- increase Wind Tunnel scenario coverage
- include one quarantined Mutation Trial

The graph compiler must not silently apply high-risk hints. Risky deltas should require reviewer approval or run only in Vivarium.

## 11. UX Integration

Keep v1 UI small.

Add only these surfaces first:

```text
Skill Passport:
  "Learned from near-misses" section with top active policy hints.

Checkride Report:
  branch comparison table showing selected, blocked, failed, and near-miss branches.

Wind Tunnel Matrix:
  counterfactual outcome badges.

Governance Dashboard:
  proposed policy deltas and reviewer controls.
```

Delay:

- full Regret Memory drawer
- novelty forecast UI
- acceptance odds
- personality-style preference display
- large analytics dashboard

Required copy style:

```text
Good:
  This workspace has evidence that API-backed execution needs rollback proof before promotion.

Bad:
  You prefer safer APIs.
```

## 12. Data Model Additions

Add durable entities after the Dojo store interface and Postgres schema exist:

```text
CounterfactualRun
CounterfactualBranch
ChoiceScene
BranchFossil
RegretLesson
PolicyDelta
ExecutionNicheMap
MutationTrial
```

Minimum fields:

```text
tenant_id
workspace_id
skill_id optional
skill_version_id optional
graph_run_id optional
vivarium_run_id optional
checkride_run_id optional
task_class
base_state_hash
evidence_ids[]
exposure_level
counterfactual_strength
ambiguity_flags[]
created_at
expires_at
retention_policy
```

Privacy rules:

- workspace scoped by default
- user scoped only when explicitly required
- store compact summaries, not raw source, by default
- never infer personal traits
- allow deletion or disabling of lessons
- show when a policy hint affected planning

## 13. Implementation Sequence

Do not insert Regret Memory into the first 10 Dojo PRs. Those PRs establish enforcement and durable foundations.

The integration starts after:

```text
DOJO-0201 Store Interface Split
DOJO-0202 Dojo Postgres Schema Migration
DOJO-0301 Evidence Ledger Schema
DOJO-0302 Evidence Ledger Store
DOJO-0401 Graph IR Schema
DOJO-0403 Graph Runtime Skeleton
```

### PR R1: Regret Types And Store Interfaces

- **Branch name:** `dojo/regret-types-store`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/regret/types.ts`
  - `mcp/synthi-mcp/src/dojo/regret/store.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_regret_types.test.ts`
- **Scope:**
  - define `CounterfactualRun`, `BranchTrace`, `ChoiceScene`, `BranchFossil`, `PolicyDelta`
  - add store interface only
  - no runtime behavior change
- **Merge criteria:**
  - types compile
  - generated-but-unshown branch cannot be represented as strong signal

### PR R2: Counterfactual Run Capture For Graph Runtime

- **Branch name:** `dojo/regret-graph-run-capture`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/regret/counterfactual_run.ts`
  - `mcp/synthi-mcp/src/dojo/regret/branch_trace.ts`
  - `mcp/synthi-mcp/src/dojo/graph/runtime.ts`
  - `mcp/synthi-mcp/tests/integration/dojo_regret_graph_capture.test.ts`
- **Scope:**
  - start a run for graph execution
  - normalize graph execution variants into branch traces
  - attach evidence ledger IDs
- **Merge criteria:**
  - branch trace references evidence, not raw proof blobs

### PR R3: ChoiceScene And Counterfactual Strength

- **Branch name:** `dojo/regret-choice-scene`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/regret/choice_scene.ts`
  - `mcp/synthi-mcp/src/dojo/regret/exposure.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_regret_choice_scene.test.ts`
- **Scope:**
  - record visible branches, opened details, arbiter pick, selected branch, cancellation, ambiguity
  - compute counterfactual strength deterministically
- **Merge criteria:**
  - unshown branch has `none`
  - shown unopened branch has `weak`
  - opened overridden arbiter winner can be `strong`
  - ambiguous cancellation produces no branch preference lesson

### PR R4: Regret Arbiter Deterministic Lessons

- **Branch name:** `dojo/regret-arbiter-v1`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/regret/regret_arbiter.ts`
  - `mcp/synthi-mcp/src/dojo/regret/policy_delta.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_regret_arbiter.test.ts`
- **Scope:**
  - extract only deterministic lessons
  - create `PolicyDelta` hypotheses
  - reject ambiguous or low-exposure signals
- **Merge criteria:**
  - override lessons cite evidence IDs
  - weak signals cannot become active policy

### PR R5: Vivarium Counterfactual Branches

- **Branch name:** `dojo/regret-vivarium-branches`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/vivarium/runner.ts`
  - `mcp/synthi-mcp/src/dojo/vivarium/wind_tunnel.ts`
  - `mcp/synthi-mcp/src/dojo/regret/mutation_trial.ts`
  - `mcp/synthi-mcp/tests/integration/dojo_regret_vivarium.test.ts`
- **Scope:**
  - run comparable scenario branches from one reset profile
  - record failed, blocked, selected, and near-miss branches
  - support quarantined Mutation Trial branches
- **Merge criteria:**
  - Mutation Trial cannot auto-apply
  - failed proof cannot win due to novelty

### PR R6: Execution Niche Map And Planning Hints

- **Branch name:** `dojo/regret-niche-map-planning`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/regret/execution_niche_map.ts`
  - `mcp/synthi-mcp/src/dojo/graph/compiler.ts`
  - `mcp/synthi-mcp/tests/integration/dojo_regret_planning_hints.test.ts`
- **Scope:**
  - aggregate promoted policy deltas
  - inject top planning hints into graph compilation
  - prove next run changes measurably
- **Merge criteria:**
  - policy delta changes future graph plan
  - expired or contradicted delta is ignored

### PR R7: Case Law Candidate Integration

- **Branch name:** `dojo/regret-case-law-candidates`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/case_law/registry.ts`
  - `mcp/synthi-mcp/src/dojo/regret/branch_fossil.ts`
  - `mcp/synthi-mcp/tests/integration/dojo_regret_case_law.test.ts`
- **Scope:**
  - convert strong repeated lessons into proposed case law
  - keep approval lifecycle separate
- **Merge criteria:**
  - proposed cases do not enforce until approved
  - one-off weak lessons are not eligible

### PR R8: Minimal UX Surfaces

- **Branch name:** `dojo/regret-minimal-ux`
- **Files:**
  - `synthi/src/components/dojo/SkillPassport.jsx`
  - `synthi/src/components/dojo/CheckrideReportView.jsx`
  - `synthi/src/components/dojo/WindTunnelMatrix.jsx`
  - `synthi/src/components/dojo/GovernanceOverview.jsx`
  - `synthi/src/components/dojo/__tests__/RegretSignals.test.jsx`
- **Scope:**
  - show learned near-miss line
  - show policy delta hypotheses
  - show ambiguity notes
  - show reviewer controls for promote/delete
- **Merge criteria:**
  - UI never labels unseen branches as rejected
  - UI copy stays workspace/task scoped

## 14. Acceptance Gates

Regret Memory is integrated only when:

- generated-but-unshown branches cannot produce preference lessons
- policy deltas cite evidence ledger records
- strong lessons require exposure and selection evidence
- graph planning changes after promoted policy deltas
- Vivarium can replay a counterfactual scenario from a reset profile
- Mutation Trials are quarantined and never auto-applied
- failed proof cannot be rescued by novelty
- case law promotion requires reviewer approval or repeated strong evidence
- users/admins can inspect, delete, and disable memory
- UI explains policy use without personal-trait inference

## 15. Evaluation Metrics

Track:

```text
accepted_surprise_rate
policy_delta_effect_rate
override_prediction_accuracy
regret_lesson_precision
ambiguous_signal_promotion_rate
proof_regression_rate
mutation_trial_escape_rate
case_law_false_positive_rate
manual_rewrite_reduction
scenario_generation_from_fossils_rate
```

Hard gates:

```text
ambiguous_signal_promotion_rate must stay near zero
proof_regression_rate must not increase after novelty weighting
mutation_trial_escape_rate must be zero
generated_unshown_strong_lesson_count must be zero
```

## 16. What To Cut From V1

Cut:

- LLM-based lesson extraction
- full novelty forecast UI
- acceptance odds
- team-wide memory
- raw transcript retention
- automatic case-law enforcement from regret lessons
- personality or taste summaries
- broad analytics dashboard

Keep:

- run-first telemetry
- branch trace normalization
- evidence references
- choice scene capture
- deterministic counterfactual strength
- deterministic policy deltas
- one visible learned line
- reviewer control over promotion

## 17. Final Integration Shape

The mature combined loop should become:

```text
Skill Seed
  -> Skill Cortex Graph
  -> Execution Niche Map lookup
  -> Graph planning hints
  -> Vivarium / Wind Tunnel branches
  -> Graph Runtime execution
  -> Evidence Ledger
  -> Proof / License / Guardrail evaluation
  -> ChoiceScene capture
  -> BranchFossil storage
  -> Regret Arbiter
  -> PolicyDelta hypothesis
  -> reviewer or repeated-evidence promotion
  -> Case Law / Graph Compiler / License planning influence
  -> next run changes
```

The deciding test is simple:

> If Regret Memory records a near-miss but the next Dojo graph, scenario set, guardrail, license hint, or runner plan does not change, the integration is theater.

The first real win is not a dashboard. It is a future Dojo run that can say:

```text
I generated an API-substrate branch this time because prior checkrides showed DOM replay passed the happy path but failed rollback and drift scenarios.
The API branch has stricter proof gates and cannot be licensed until rollback evidence passes.
```

That is the integration worth building.
