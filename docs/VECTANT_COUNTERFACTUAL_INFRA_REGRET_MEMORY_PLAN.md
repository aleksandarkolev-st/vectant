# Vectant Counterfactual Infra Plan

Status: detailed proposal  
Date: 2026-06-21  
Working name: Regret Memory  
Canonical category: counterfactual observability and control for agentic systems

## 1. Core correction

Vectant is not a coding agent.

Vectant is infra.

The original Regret Memory plan was too close to "a better coding agent with taste memory." That framing is too small and too easy to copy. The stronger framing is:

> Vectant is the counterfactual control plane for agentic systems. It forks agent execution into alternate chambers, records both winners and near-misses, and updates future orchestration policy from the shape of what did not ship.

A coding agent produces work.

Vectant controls, observes, compares, scores, stores, replays, and steers agentic work.

Claude Code, Codex, Cursor agents, browser agents, workflow agents, design agents, internal agents, and future runners are not Vectant. They are beams, organisms, or runners inside Vectant's experimental environment.

Vectant owns:

- Forking.
- Sandboxing.
- Budgeting.
- Runner selection.
- Trace capture.
- Proof collection.
- Counterfactual comparison.
- Arbiter orchestration.
- Selection capture.
- Near-miss storage.
- Policy delta extraction.
- Future execution steering.

The most defensible claim is not:

> The agent remembers what the user likes.

The stronger claim is:

> Vectant turns discarded agent work into infrastructure-grade signal.

Current systems usually optimize from:

```text
prompt -> output -> feedback
```

Vectant should optimize from:

```text
request -> many possible worlds -> detector traces -> selection event -> policy delta
```

That is an infra loop, not a coding-agent loop.

## 2. Revised canonical positioning

### Primary positioning

> Counterfactual observability and control for agentic systems: learn from branches that almost ran, almost won, or were deliberately rejected.

### Short positioning

> Vectant is counterfactual telemetry for agentic execution.

### Strongest product sentence

> Vectant records the agent paths that did not ship, then uses those near-misses to improve future orchestration policy.

### More aggressive sentence

> Vectant is the first agent-infra layer that treats rejected agent work as first-class telemetry.

### Do not say

```text
Vectant is a coding agent.
Vectant is an agent memory feature.
Vectant personalizes agents to user taste.
Vectant knows what the user wants.
Vectant is a preference engine.
Vectant is a vibe memory system.
```

### Say instead

```text
Vectant is agent infrastructure.
Vectant records counterfactual execution traces.
Vectant learns from selected, rejected, overridden, cancelled, and mutated branches.
Vectant builds execution policy from evidence, not vague preference.
Vectant optimizes for accepted surprise under proof gates.
Vectant makes discarded agent work useful.
```

## 3. Real-life model: particle accelerator and detector array

The strongest real-life metaphor for Vectant is not a diary, memory palace, or recommendation engine.

It is a particle accelerator with a detector array.

In a particle accelerator, you do not learn only from the particle that hits the target cleanly. You learn from trails, near misses, decay paths, collisions, anomalous events, and detector readings across layers.

Vectant should do the same for agentic execution.

### Mapping

```text
User request or system task        = collision setup
Workspace snapshot                 = beamline initial condition
Agent runners                      = particle beams
Shadow universes                   = collision chambers
Generated artifacts or patches     = event traces
Tests                              = detector layer
Runtime probes                     = detector layer
Security checks                    = detector layer
License checks                     = detector layer
Cost and latency                   = detector layer
Arbiter                            = event classifier
Human apply, cancel, override      = selection signal
Manual rewrite after apply         = post-collision decay trace
Regret Memory                      = rare-event archive
Negative-space model               = interaction cross-section map
Productive Disobedience            = high-energy experiment
Accepted Surprise                  = rare useful event that survives detectors
```

### Why this model is better

This metaphor makes Vectant infra-native.

It also prevents the plan from sounding like standard personalization. The system does not "remember user vibes." It measures agent behavior under controlled experimental conditions.

The product novelty becomes:

> Vectant does not only observe the path an agent took. It records the valuable paths that nearly happened, then uses those counterfactual traces to steer future execution.

That is new control-plane territory.

## 4. Secondary model: fossil record and extinction ecology

The fossil-record metaphor is still useful, but it should be scoped to the memory subsystem, not the whole company positioning.

Use it internally for Regret Memory.

```text
Shadow universes              = islands
Branches                      = organisms
Diff traits                   = phenotype
Tests and runtime probes      = survival pressure
User choice                   = selection event
Cancelled branch              = extinction
Manual rewrite                = mutation after release
Arbiter                       = field naturalist
Regret Memory                 = fossil record
Execution Niche Map           = ecological niche map
Mutation Trial                = quarantined mutation
Accepted Surprise             = adaptive leap
```

This metaphor explains the learning model well:

- Shipped work is only the survivor population.
- Rejected work shows the boundaries of the environment.
- Manual rewrites show which traits survived release but mutated under pressure.
- Arbiter overrides show where internal scoring mismatched the real selection environment.
- Cancelled branches show where the original premise was wrong.

Do not overuse this metaphor in external product copy. It is vivid, but the accelerator model sounds more like infra.

## 5. What Regret Memory really is

Regret Memory is not generic memory.

Regret Memory is a counterfactual telemetry store.

It records the agent work that existed in the choice set but did not become the final selected path.

The crucial word is **choice set**.

A branch that was generated but never shown is not a strong rejection signal. A branch that failed before the user saw it is not a taste signal. A branch that lost because of latency is not a design rejection. A branch that was cancelled because the user ran out of budget is not proof of dislike.

The root primitive must therefore be a run-level choice scene, not a branch-level capsule.

## 6. Critical flaw in the original plan

The original plan treated many non-applied branches as rejected.

That is wrong.

Non-applied does not mean rejected.

A branch becomes a valid regret signal only when these conditions are at least partially true:

```text
1. It was part of the same task and same base state.
2. It was produced under a declared direction or runner condition.
3. It had evidence attached.
4. It was visible or comparable to the selector.
5. The selector had a realistic chance to choose it.
6. The final choice or override can be tied to differences between branches.
```

Without those conditions, the memory becomes superstition.

Wrong inference:

```text
Universe C was not applied, so the user dislikes runtime-level primitives.
```

Better inference:

```text
Universe C was generated but never shown. It has no counterfactual strength.
```

Strong inference:

```text
Universe A was Arbiter-ranked first and shown with proof. The user opened its diff, then applied smaller Universe B and later kept B with minimal edits. This is a medium-to-strong signal that, for this task class, smaller patches can beat higher-proof broad patches.
```

## 7. Root object: CounterfactualRun

Replace branch-first memory with run-first telemetry.

```text
CounterfactualRun
  run_id
  workspace_id
  user_id optional
  team_id optional
  request_id
  task_class
  base_state
  created_at
  runners[]
  universes[]
  detector_results[]
  arbiter_results[]
  selection_event
  post_selection_mutation
  learned_policy_deltas[]
  retention_policy
```

### Key idea

A CounterfactualRun is the entire experiment.

It captures:

- What was asked.
- What state the system began from.
- Which runners participated.
- Which universe each runner explored.
- Which detector evidence was produced.
- Which branches were visible to the selector.
- What the Arbiter recommended.
- What the human or downstream system selected.
- What changed after selection.
- What policy delta should affect future runs.

This is the core infra object.

## 8. ChoiceScene

A ChoiceScene is the subset of a CounterfactualRun where selection actually happened.

```text
ChoiceScene
  id
  counterfactual_run_id
  base_commit_or_state_hash
  request_summary
  task_class
  available_universe_ids[]
  visible_universe_ids[]
  opened_diff_universe_ids[]
  opened_explanation_universe_ids[]
  arbiter_recommendation
  selector_action
  selected_universe_id
  cancel_stage
  override_reason optional
  selection_latency_ms
  budget_state
  ambiguity_flags[]
```

### Why it matters

Counterfactual learning requires a choice set.

The system must know what the user or selector could realistically choose. Otherwise Vectant cannot distinguish:

- Rejection.
- Invisibility.
- Failed generation.
- Latency abandonment.
- Merge conflict.
- Cost exhaustion.
- Premise cancellation.

## 9. BranchTrace

A BranchTrace is a normalized trace emitted by any runner.

It must be runner-agnostic.

```text
BranchTrace
  id
  counterfactual_run_id
  universe_id
  runner_id
  runner_kind
    claude_code
    codex
    internal
    browser_agent
    workflow_agent
    design_agent
    custom
  direction_id
  direction_label
  declared_condition
  prompt_lineage
  start_state_hash
  end_state_hash
  artifact_summary
  diff_summary
  tool_trace_summary
  command_trace_summary
  detector_trace_ids[]
  cost_trace
  latency_trace
  risk_trace
  phenotype_vector
  novelty_vector
  proof_score
  risk_score
  exposure_level
  selection_outcome
  counterfactual_strength
  extinction_hypotheses[]
```

### Runner kinds

Vectant should not couple itself to Claude Code or Codex.

Use adapters.

```text
ClaudeCodeRunner
CodexRunner
InternalRunner
BrowserRunner
WorkflowRunner
DesignRunner
```

Each adapter emits BranchTrace.

## 10. BranchFossil

BranchFossil is the compact, durable representation of a BranchTrace after retention filtering.

```text
BranchFossil
  id
  branch_trace_id
  workspace_id
  task_class
  runner_kind
  direction_label
  compact_artifact_summary
  compact_diff_summary
  phenotype_vector
  detector_summary
  selection_outcome
  exposure_level
  counterfactual_strength
  inferred_lessons[]
  source_counterfactual_run_id
  created_at
  decay_after
```

BranchTrace is operational telemetry.

BranchFossil is durable learning material.

Do not store full source by default. Store hashes, summaries, bounded diffs, evidence summaries, and replay pointers.

## 11. Detector stack

The detector stack is what makes Vectant infra instead of taste memory.

Every branch should pass through layered detectors.

```text
DetectorResult
  id
  branch_trace_id
  detector_kind
    lint
    typecheck
    unit_tests
    integration_tests
    runtime_probe
    browser_probe
    visual_snapshot
    security_scan
    license_scan
    dependency_scan
    migration_check
    performance_probe
    cost_meter
    latency_meter
    human_readability
  status
    passed
    failed
    partial
    skipped
    not_applicable
  score
  evidence_summary
  raw_artifact_ref optional
  started_at
  finished_at
```

### Detector principle

Novelty cannot bless failed proof.

The Proof Arbiter gates before the Selection Arbiter ranks for fit.

## 12. Arbiter split

A single Arbiter is too overloaded.

Use three separate arbiters.

```text
Proof Arbiter
  Judges correctness, evidence, safety, regressions, license, and operational risk.

Selection Arbiter
  Judges likely human or workspace acceptance among proof-surviving branches.

Regret Arbiter
  Judges why non-selected branches matter for future policy.
```

### Required ordering

```text
1. Proof Arbiter runs first.
2. Branches with failed hard gates cannot win.
3. Selection Arbiter ranks only branches that survive proof gates, or clearly marks risky candidates.
4. Regret Arbiter extracts lessons only after the final selection event.
```

### Why split them

This avoids a common failure:

```text
The branch is exciting, so the Arbiter handwaves correctness.
```

That must never happen.

Novelty may break ties among proof-valid branches.

Novelty may justify a quarantined Mutation Trial.

Novelty may not override failed proof.

## 13. Execution Niche Map

The original plan used Negative-Space Fingerprint.

For infra, use Execution Niche Map.

```text
ExecutionNicheMap
  id
  workspace_id
  user_id optional
  team_id optional
  repo_or_environment_fingerprint
  agent_class optional
  task_class optional
  updated_at
  accepted_trace_patterns[]
  rejected_trace_patterns[]
  override_patterns[]
  cancelled_premise_patterns[]
  post_apply_mutation_patterns[]
  proof_thresholds
  novelty_success_zones
  risk_tolerance
  abstraction_tolerance
  runtime_depth_preference
  ui_surface_preference
  patch_size_bias
  cost_sensitivity
  latency_sensitivity
  policy_hints[]
  confidence
  sample_count
  last_fossil_ids[]
```

### What it does

The Niche Map does not claim to know the user's mind.

It summarizes what execution traits tend to survive in a workspace under specific task classes.

Example:

```text
For task_class=agent_feature in workspace=vectant:
  - local UI wrappers often lose to runtime-level primitives
  - broad abstractions require repeated pain evidence
  - novelty requests need proof-backed substrate novelty
  - test-only changes under-satisfy visual or product requests
  - small patches are preferred unless they perpetuate repeated workaround loops
```

## 14. PolicyDelta

PolicyDelta is the operational output of Regret Memory.

```text
PolicyDelta
  id
  source_counterfactual_run_id
  workspace_id
  task_class
  delta_kind
    runner_weight_change
    universe_direction_change
    detector_gate_change
    prompt_hint_change
    arbiter_weight_change
    budget_allocation_change
    mutation_trial_permission
  before
  after
  confidence
  evidence_refs[]
  expiry
  status
    hypothesis
    active
    promoted
    contradicted
    deleted
```

### Example

```text
PolicyDelta
  task_class: agent_feature
  delta_kind: universe_direction_change
  before: include UI-wrapper direction by default
  after: deprioritize UI-wrapper direction unless prompt explicitly asks for UI
  confidence: medium
  evidence_refs: [run_12, run_19, fossil_31]
  status: hypothesis
```

The important property: a lesson must change execution policy.

If it does not change runner selection, universe planning, detector budget, Arbiter weighting, or prompt hints, it is not yet product signal.

## 15. Exposure level and counterfactual strength

Add these fields everywhere.

```text
exposure_level
  generated
  detector_evaluated
  arbiter_ranked
  shown
  diff_opened
  explanation_opened
  applied
  edited_after_apply
  reused_later
```

```text
counterfactual_strength
  none
  weak
  medium
  strong
```

### Rules

```text
Generated but never shown:
  counterfactual_strength = none

Shown but not opened:
  counterfactual_strength = weak

Shown, opened, compared, then rejected:
  counterfactual_strength = medium

Arbiter winner opened and overridden in favor of another branch:
  counterfactual_strength = strong

Applied then manually gutted:
  counterfactual_strength = strong for post-selection mutation

Cancelled before any universe completed:
  not a branch rejection, possibly a premise or latency signal
```

## 16. Ambiguity flags

Ambiguity must be first-class.

```text
ambiguity_flags
  branch_failed_before_comparison
  branch_not_visible_to_selector
  budget_exhausted
  latency_abort
  stale_branch
  merge_conflict
  permission_blocked
  detector_incomplete
  user_left_session
  selector_unknown
  applied_due_to_time_pressure
  final_selection_external
```

Ambiguous signals must not create high-confidence memory.

## 17. Accepted Surprise

Accepted Surprise remains the best product phrase.

Definition:

> A high-novelty result that survives proof gates and is selected or retained.

Accepted Surprise is not randomness.

It is not scope creep.

It is not a visual gimmick.

It is useful deviation under evidence.

### Required properties

```text
high novelty
sufficient proof
low or explicit risk
selection or retention
limited post-apply damage
explainable deviation from baseline
```

### Non-examples

```text
A flashy UI that breaks runtime behavior.
A large abstraction with no proof leverage.
A surprising patch that cannot be tested.
A feature the Arbiter likes but the user repeatedly deletes.
```

## 18. Novelty model

Do not collapse novelty to one number.

Use a phenotype vector.

```text
PhenotypeVector
  locality
  abstraction_shift
  runtime_depth
  ui_surface_shift
  workflow_shift
  proof_newness
  dependency_change
  blast_radius
  reversibility
  migration_complexity
  user_visible_change
  protocol_change
  state_model_change
```

Then compute three distances:

```text
novelty = distance from local baseline
fit = distance from historically accepted niche
danger = distance from current proof capacity
```

### Better objective

```text
maximize accepted_surprise
where:
  proof_gate == pass
  danger <= threshold
  novelty >= task_required_novelty
  fit within or deliberately near accepted niche
```

### Novelty dimensions

```text
structural_novelty
  New primitive, execution path, abstraction, or state model.

interaction_novelty
  New way user or agent interacts with the system.

substrate_novelty
  Deeper runtime, protocol, or orchestration solution.

visual_novelty
  Distinct visual or motion direction.

workflow_novelty
  New collaboration or handoff pattern.

proof_novelty
  New evidence type, detector, replay, or runtime probe.
```

### Novelty penalties

```text
gratuitous_scope
  More files or abstractions without proof-backed leverage.

surface_only
  Looks different but does not change capability.

unproven_magic
  Surprising claim without deterministic evidence.

anti_project
  Violates stable conventions without why-now evidence.

cost_spike
  Costs materially more than the benefit.

irreversibility
  Hard to undo without migration cost.
```

## 19. Productive Disobedience becomes Mutation Trial

Keep Productive Disobedience as product language if desired.

Internally call it Mutation Trial.

```text
MutationTrial
  id
  counterfactual_run_id
  violated_policy
  why_now
  stricter_detectors[]
  quarantine_policy
  auto_apply_allowed: false
  budget_cap
  result
  regret_signal_scope
```

### Rules

```text
Always sandboxed.
Never auto-applied.
Must state which policy it violates.
Must state why now.
Must cite evidence from prior runs.
Must have stricter proof gates.
Must be budget-capped.
Must be tracked separately from normal branches.
```

### Example banner

```text
Trying one Mutation Trial.
This violates the workspace's usual small-diff bias because four prior traces worked around the same missing runtime primitive.
It has stricter proof gates and cannot auto-apply.
```

### Why it matters

This is how Vectant feels alive without becoming reckless.

The system can intentionally test outside the historical acceptance boundary, but it must do so with containment and evidence.

## 20. Runner abstraction

Vectant should use a stable runner interface.

```python
class AgentRunner:
    def prepare(self, workspace_snapshot, task, direction, budget):
        pass

    def run(self):
        pass

    def collect_trace(self) -> BranchTrace:
        pass

    def collect_artifacts(self):
        pass

    def collect_diff(self):
        pass

    def collect_detector_inputs(self):
        pass

    def summarize_branch(self) -> dict:
        pass
```

### Runner contract

Every runner must produce:

```text
runner metadata
start state
end state
artifact summary
tool or action summary
cost summary
latency summary
diff or output summary
detector inputs
self-reported rationale, marked as non-authoritative
```

### Do not allow

```text
runner-specific memory as source of truth
unstructured final messages as only output
uncaptured tool traces
uncaptured cost and latency
branches without declared direction
```

## 21. Claude Code compatibility

Claude Code can be a strong runner, not the Vectant core.

Use it for rich branch generation and hook-based telemetry.

Relevant current capabilities from official docs:

- Claude Agent SDK exposes built-in tools, hooks, subagents, MCP, permissions, and sessions.
- Claude Code hooks fire around lifecycle events such as session start/end, user prompt submission, tool use, and stop events.
- Claude Code supports custom subagents with tool access, independent permissions, model selection, hooks, MCP servers, memory settings, background operation, and worktree isolation.
- Claude Code forks can also use isolated worktrees for separate file edits.

### ClaudeCodeRunner sketch

```text
ClaudeCodeRunner
  input:
    workspace snapshot
    declared universe direction
    allowed tools
    permission mode
    detector requirements
    branch_fossil_schema

  setup:
    create or assign worktree
    inject task prompt
    inject top 3 policy hints
    register hooks
    bind run_id and universe_id

  capture:
    SessionStart -> runner start
    UserPromptSubmit -> prompt lineage
    PreToolUse -> intended action
    PostToolUse -> observed action and file deltas
    FileChanged -> diff trace
    Stop -> branch summary
    SessionEnd -> final cost and status

  output:
    BranchTrace
    raw transcript ref
    bounded diff summary
    detector inputs
```

### Claude-specific caution

Do not depend on Claude Code's own memory as durable truth.

Vectant should own durable memory.

Claude receives only compressed, scoped policy hints.

## 22. Codex compatibility

Codex can also be a strong runner, especially for reproducible, non-interactive, structured runs.

Relevant current capabilities from official docs:

- `codex exec` supports non-interactive mode for automated workflows.
- `--output-schema` can force a JSON Schema-shaped final response.
- `--sandbox` supports sandbox policies such as read-only, workspace-write, and danger-full-access.
- Official guidance recommends `--sandbox workspace-write` for unattended local work and avoiding full sandbox bypass except in a dedicated sandbox VM.
- Codex reads `AGENTS.md` files before work, with global and project-scoped instruction layering.
- Codex Skills package reusable workflows through a `SKILL.md` file with optional scripts, references, and assets.

### CodexRunner sketch

```bash
codex exec \
  --sandbox workspace-write \
  --output-schema ./branch_trace.schema.json \
  -o ./branch_trace.codex.universe_b.json \
  "Implement Universe B: runtime primitive direction. Emit BranchTrace."
```

### Codex use cases inside Vectant

```text
candidate branch generation
structured branch summarization
diff review
risk analysis
detector repair loop
Regret Arbiter draft, with deterministic validation
skill-packaged repeated workflows
```

### Codex-specific caution

Do not make Codex the orchestrator of record.

Codex may produce branches, summaries, and structured reports. Vectant should still own:

- Universe setup.
- Worktree management.
- Detector execution.
- Selection capture.
- Durable memory.
- Policy delta application.

## 23. Shadow universe model

Shadow universes should not be random parallel attempts.

They should be controlled experimental chambers.

Every universe needs a declared condition.

```text
Universe A
  condition: conservative local repair
  expected traits: low blast radius, low novelty, fast proof

Universe B
  condition: runtime-level primitive
  expected traits: deeper substrate, higher novelty, higher proof burden

Universe C
  condition: user-facing affordance
  expected traits: visible value, moderate risk, requires runtime or visual probe

Universe D
  condition: Mutation Trial
  expected traits: violates one known policy with why-now evidence, strict proof gates, cannot auto-apply
```

### Universe contract

```text
same base state
same task summary
same hard constraints
explicit direction
explicit budget
captured runner trace
captured detector results
normalized BranchTrace
```

### What not to do

```text
Do not run four agents with vague prompts and call it a multiverse.
Do not compare branches that started from different base states without marking it.
Do not infer taste from branches the selector never saw.
Do not let a high-novelty universe escape quarantine without proof.
```

## 24. Arbiter output schema

```text
ProofArbiterVerdict
  counterfactual_run_id
  branch_verdicts[]
    branch_trace_id
    hard_gate_status
    proof_score
    risk_score
    failed_detectors[]
    missing_detectors[]
    proof_summary
  eligible_branch_ids[]
  ineligible_branch_ids[]
```

```text
SelectionArbiterVerdict
  counterfactual_run_id
  ranked_branch_ids[]
  rank_reasons[]
  novelty_fit
  task_fit
  maintainability_fit
  likely_override_risk
  recommended_branch_id
  tie_break_basis
```

```text
RegretArbiterVerdict
  counterfactual_run_id
  selected_branch_id
  non_selected_branch_analysis[]
    branch_trace_id
    counterfactual_strength
    extinction_hypotheses[]
    useful_signal
    ambiguity_flags[]
  policy_delta_candidates[]
```

## 25. Lesson extraction

Use deterministic extraction first.

Use LLM extraction only to summarize already-recorded evidence.

The LLM must not invent motives.

### Deterministic examples

```text
If arbiter_winner != selected_branch
and selected_branch.loc_delta < arbiter_winner.loc_delta
and selected_branch.exposure_level >= diff_opened:
  lesson = "Selector preferred smaller patch over Arbiter's higher-proof larger branch."
  confidence = medium
```

```text
If selected_branch.runtime_depth > rejected_ui_branch.runtime_depth
and rejected_ui_branch.exposure_level >= shown:
  lesson = "Runtime-level direction beat UI-surface direction for this task class."
  confidence = medium
```

```text
If all universes cancelled before detector completion:
  lesson = "Do not infer branch taste. Possible premise, latency, or budget issue."
  confidence = none
```

```text
If applied branch was manually edited to remove main abstraction:
  lesson = "Abstraction survived selection but failed post-apply retention."
  confidence = high
```

### Lesson lifecycle

```text
hypothesis -> repeated -> promoted
hypothesis -> contradicted -> weakened
any -> deleted_by_user
any -> expired
```

## 26. Manual edit diff summarizer

This is mandatory.

A branch being applied is not enough.

Post-apply edits reveal whether the selected branch actually survived contact with the user or downstream system.

```text
PostSelectionMutation
  selected_branch_id
  observation_window
  files_changed_after_apply[]
  deleted_generated_blocks[]
  retained_generated_blocks[]
  abstraction_removed
  tests_added_by_user
  UI_changed_by_user
  runtime_changed_by_user
  mutation_summary
  retention_score
```

### Retention score

```text
1.0 = patch kept almost as-is
0.7 = small edits or formatting
0.4 = meaningful rewrite but core direction kept
0.1 = main abstraction removed
0.0 = reverted
```

This should feed back into the Execution Niche Map.

## 27. API sketch

### Create CounterfactualRun

```http
POST /counterfactual/runs
```

```json
{
  "workspace_id": "ws_123",
  "request_id": "req_123",
  "task_class": "agent_feature",
  "base_state": {
    "repo": "vectant",
    "commit": "abc123"
  },
  "universe_plan": [
    {
      "id": "A",
      "direction": "conservative_local_repair",
      "runner_kind": "claude_code"
    },
    {
      "id": "B",
      "direction": "runtime_primitive",
      "runner_kind": "codex"
    }
  ]
}
```

### Submit BranchTrace

```http
POST /counterfactual/runs/{run_id}/branches
```

```json
{
  "universe_id": "B",
  "runner_kind": "codex",
  "direction_label": "runtime primitive",
  "artifact_summary": "Introduced a runtime event primitive instead of adding another UI wrapper.",
  "phenotype_vector": {
    "locality": 0.41,
    "runtime_depth": 0.87,
    "ui_surface_shift": 0.22,
    "blast_radius": 0.48
  },
  "diff_summary": {
    "files_touched": 5,
    "loc_added": 142,
    "loc_removed": 31
  }
}
```

### Submit DetectorResult

```http
POST /counterfactual/branches/{branch_id}/detectors
```

```json
{
  "detector_kind": "unit_tests",
  "status": "passed",
  "score": 1.0,
  "evidence_summary": "38 tests passed. No snapshot changes."
}
```

### Record SelectionEvent

```http
POST /counterfactual/runs/{run_id}/selection
```

```json
{
  "selected_universe_id": "B",
  "selector_kind": "human",
  "arbiter_winner_universe_id": "A",
  "user_overrode_arbiter": true,
  "visible_universe_ids": ["A", "B"],
  "opened_diff_universe_ids": ["A", "B"],
  "selection_action": "applied"
}
```

### Generate PolicyDelta

```http
POST /counterfactual/runs/{run_id}/policy-deltas
```

```json
{
  "mode": "deterministic_first",
  "max_deltas": 3
}
```

### Fetch Execution Niche Map

```http
GET /niche-map?workspace_id=ws_123&task_class=agent_feature
```

### Forecast next run

```http
POST /forecast/directions
```

```json
{
  "workspace_id": "ws_123",
  "task_class": "agent_feature",
  "request_summary": "Find a novel agentic infra feature.",
  "budget": {
    "max_universes": 4,
    "max_cost_usd": 0.10
  }
}
```

## 28. UI surfaces

Keep the UI minimal at first.

The UI should expose evidence, not personality.

### Compact run note

```text
Taking a runtime-primitive direction.
Reason: recent counterfactual runs show UI-wrapper branches often lost when the real issue was missing runtime state.
```

### Multiverse card line

```text
Universe B: proof passed, novelty high, selection fit high. Comparable to prior accepted runtime-level traces.
```

### Learned from this run

```text
Learned from this run:
You selected the runtime-level branch over the smaller UI wrapper.
Future runs will raise runtime-primitive priority for similar agent-feature tasks.
```

### Override note

```text
Learned from override:
The Arbiter overvalued test coverage and undervalued task-level novelty.
Future Selection Arbiter runs will mark override risk when novelty was explicitly requested.
```

### Cancellation note

```text
Learned from cancellation:
No branch-level lesson recorded. The run was cancelled before comparable branches were visible.
Possible signals: premise mismatch, latency, or budget.
```

### Mutation Trial banner

```text
Running one Mutation Trial.
It violates the current small-diff policy because repeated traces show local fixes are working around the same missing primitive.
It cannot auto-apply.
```

## 29. UI surfaces to delay

Do not build these in v1:

```text
Regret Memory Drawer
Novelty Forecast Card
team memory UI
manual lesson editor
Productive Disobedience full UI
analytics dashboard
```

They are useful later, but they are not the primitive.

First prove that a counterfactual run changes the next orchestration decision.

## 30. First vertical slice

The v1 should be brutally small.

Goal:

> After a shadow run with at least two universes, Vectant records why the non-selected universe lost or why the selected universe beat the Arbiter pick, then uses that policy delta in the next run.

### Scope

```text
shadow-only
file-backed or in-memory store
two runners max
no Prisma migration
no team memory
no Mutation Trial
no LLM lesson extraction
no forecast card
one UI line: Learned from this run
```

### Flow

```text
1. Start CounterfactualRun from one base commit.
2. Run Universe A with conservative-local direction.
3. Run Universe B with runtime-primitive direction.
4. Normalize both into BranchTrace.
5. Run detector stack.
6. Proof Arbiter ranks proof and eligibility.
7. Selection Arbiter recommends A.
8. User applies B.
9. Vectant records ChoiceScene.
10. Regret Arbiter emits deterministic PolicyDelta.
11. Next run planner receives policy hint.
12. Next universe plan changes measurably.
13. UI shows one learned line.
```

### Example learned line

```text
Learned from this run:
Runtime-level branch beat the Arbiter's smaller local patch. Future similar tasks will include a runtime-primitive universe earlier.
```

### Success condition

The next run must change.

If memory is recorded but the next universe plan is identical, the feature is fake.

## 31. Revised implementation phases

### Phase 0: Planning document

Create:

```text
docs/VECTANT_COUNTERFACTUAL_INFRA_REGRET_MEMORY_PLAN.md
```

### Phase 1: Core contracts

Create:

```text
counterfactual/types.py
counterfactual/store.py
counterfactual/branch_trace.py
counterfactual/detectors.py
counterfactual/policy_delta.py
```

Tests:

```text
test_counterfactual_types.py
test_branch_trace_normalization.py
test_policy_delta_schema.py
```

### Phase 2: Runner adapters

Create:

```text
runners/base.py
runners/claude_code_runner.py
runners/codex_runner.py
```

Scope:

- Prepare workspace snapshot.
- Run a declared universe direction.
- Collect trace.
- Return BranchTrace.
- Store raw logs by reference, not inline.

Tests:

```text
test_runner_contract.py
test_codex_runner_trace_shape.py
test_claude_code_runner_trace_shape.py
```

### Phase 3: Detector stack

Create:

```text
detectors/base.py
detectors/lint.py
detectors/tests.py
detectors/runtime_probe.py
detectors/cost_latency.py
```

Scope:

- Run deterministic checks.
- Attach DetectorResult to BranchTrace.
- Mark skipped or incomplete detectors honestly.

Tests:

```text
test_detector_result_schema.py
test_failed_detector_blocks_proof_win.py
```

### Phase 4: Arbiters

Create:

```text
arbiters/proof_arbiter.py
arbiters/selection_arbiter.py
arbiters/regret_arbiter.py
```

Scope:

- Proof gate first.
- Selection ranking second.
- Regret lessons after final selection.
- Deterministic lessons first.

Tests:

```text
test_proof_arbiter_blocks_failed_branch.py
test_selection_arbiter_ranks_only_eligible_branches.py
test_regret_arbiter_override_lesson.py
```

### Phase 5: ChoiceScene capture

Create:

```text
counterfactual/choice_scene.py
counterfactual/selection_capture.py
counterfactual/exposure.py
```

Scope:

- Record shown universes.
- Record opened diffs.
- Record Arbiter recommendation.
- Record selected branch.
- Record cancellation stage.
- Compute counterfactual strength.

Tests:

```text
test_generated_unshown_branch_has_no_counterfactual_strength.py
test_opened_overridden_arbiter_winner_has_strong_signal.py
test_cancel_before_visibility_does_not_create_taste_lesson.py
```

### Phase 6: Policy application

Create:

```text
policy/niche_map.py
policy/policy_delta_apply.py
policy/universe_planner.py
```

Scope:

- Store policy deltas.
- Aggregate into Execution Niche Map.
- Inject top policy hints into next run.
- Change universe direction weights.

Tests:

```text
test_policy_delta_changes_universe_plan.py
test_ambiguous_signal_not_promoted.py
test_policy_delta_decay.py
```

### Phase 7: Minimal UI

Touch:

```text
MultiverseCard
ArbiterCard
useShadowVerify or equivalent hook
```

Add:

```text
learned_from_this_run line
selection override note
cancellation ambiguity note
```

Tests:

```text
test_ui_renders_learned_line.py
test_ui_does_not_show_branch_lesson_for_ambiguous_cancel.py
```

### Phase 8: Persistence and controls

Add durable persistence only after v1 proves behavioral change.

Scope:

- Persist CounterfactualRun.
- Persist BranchFossil.
- Persist Execution Niche Map.
- Add retention policy.
- Add delete lesson control.
- Add workspace disable switch.

## 32. File touch plan mapped to the original repo names

The user's original plan named paths like `ai-backend/ai-engine/shadow/...` and `synthi/src/...`.

If those are still the repo boundaries, use this mapping.

### Planning commit

```text
docs/VECTANT_COUNTERFACTUAL_INFRA_REGRET_MEMORY_PLAN.md
```

### Backend core

```text
ai-backend/ai-engine/shadow/counterfactual_types.py
ai-backend/ai-engine/shadow/counterfactual_store.py
ai-backend/ai-engine/shadow/branch_trace.py
ai-backend/ai-engine/shadow/detector_results.py
ai-backend/ai-engine/shadow/choice_scene.py
ai-backend/ai-engine/shadow/policy_delta.py
ai-backend/ai-engine/shadow/execution_niche_map.py
```

### Backend orchestration

```text
ai-backend/ai-engine/shadow/runner_base.py
ai-backend/ai-engine/shadow/claude_code_runner.py
ai-backend/ai-engine/shadow/codex_runner.py
ai-backend/ai-engine/shadow/proof_arbiter.py
ai-backend/ai-engine/shadow/selection_arbiter.py
ai-backend/ai-engine/shadow/regret_arbiter.py
ai-backend/ai-engine/shadow/universe_planner.py
```

### Existing files likely touched

```text
ai-backend/ai-engine/shadow/api.py
ai-backend/ai-engine/shadow/events.py
ai-backend/ai-engine/shadow/multiverse.py
ai-backend/ai-engine/shadow/generator.py
ai-backend/ai-engine/shadow/arbiter.py
ai-backend/ai-engine/main.py
```

### Frontend minimal UI

```text
synthi/src/components/chat/MultiverseCard.jsx
synthi/src/components/chat/ArbiterCard.jsx
synthi/src/components/chat/hooks/useShadowVerify.js
```

### Later UI

```text
synthi/src/components/chat/RegretMemoryDrawer.jsx
synthi/src/components/chat/NoveltyForecastCard.jsx
synthi/src/lib/regretClient.js
```

### Persistence later

```text
synthi/prisma/schema.prisma
synthi/prisma/migrations/<timestamp>_counterfactual_regret_memory/migration.sql
synthi/src/lib/regret-store.js
synthi/src/lib/__tests__/regret-store.test.js
```

## 33. Minimal schemas

### Python-style data classes

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

class ExposureLevel(str, Enum):
    GENERATED = "generated"
    DETECTOR_EVALUATED = "detector_evaluated"
    ARBITER_RANKED = "arbiter_ranked"
    SHOWN = "shown"
    DIFF_OPENED = "diff_opened"
    EXPLANATION_OPENED = "explanation_opened"
    APPLIED = "applied"
    EDITED_AFTER_APPLY = "edited_after_apply"
    REUSED_LATER = "reused_later"

class CounterfactualStrength(str, Enum):
    NONE = "none"
    WEAK = "weak"
    MEDIUM = "medium"
    STRONG = "strong"

@dataclass
class PhenotypeVector:
    locality: float = 0.0
    abstraction_shift: float = 0.0
    runtime_depth: float = 0.0
    ui_surface_shift: float = 0.0
    workflow_shift: float = 0.0
    proof_newness: float = 0.0
    dependency_change: float = 0.0
    blast_radius: float = 0.0
    reversibility: float = 1.0
    migration_complexity: float = 0.0

@dataclass
class BranchTrace:
    id: str
    run_id: str
    universe_id: str
    runner_kind: str
    direction_label: str
    declared_condition: str
    artifact_summary: str
    diff_summary: dict[str, Any]
    phenotype_vector: PhenotypeVector
    detector_result_ids: list[str] = field(default_factory=list)
    exposure_level: ExposureLevel = ExposureLevel.GENERATED
    counterfactual_strength: CounterfactualStrength = CounterfactualStrength.NONE
    ambiguity_flags: list[str] = field(default_factory=list)
```

### Deterministic counterfactual strength

```python
def compute_counterfactual_strength(branch, choice_scene):
    if branch.universe_id not in choice_scene.visible_universe_ids:
        return "none"

    if branch.universe_id not in choice_scene.opened_diff_universe_ids:
        return "weak"

    if branch.universe_id == choice_scene.arbiter_recommendation and choice_scene.user_overrode_arbiter:
        return "strong"

    if branch.universe_id in choice_scene.opened_diff_universe_ids:
        return "medium"

    return "weak"
```

### Deterministic lesson extraction

```python
def extract_override_lessons(choice_scene, traces):
    lessons = []

    if not choice_scene.user_overrode_arbiter:
        return lessons

    selected = traces[choice_scene.selected_universe_id]
    arbiter_pick = traces[choice_scene.arbiter_recommendation]

    selected_loc = selected.diff_summary.get("loc_added", 0) + selected.diff_summary.get("loc_removed", 0)
    arbiter_loc = arbiter_pick.diff_summary.get("loc_added", 0) + arbiter_pick.diff_summary.get("loc_removed", 0)

    if selected_loc < arbiter_loc:
        lessons.append({
            "kind": "smaller_over_higher_proof",
            "text": "Selector preferred smaller branch over Arbiter's larger recommendation.",
            "confidence": "medium",
            "policy_delta": {
                "delta_kind": "arbiter_weight_change",
                "change": "lower size-tolerant ranking for similar task class unless proof delta is large"
            }
        })

    if selected.phenotype_vector.runtime_depth > arbiter_pick.phenotype_vector.runtime_depth:
        lessons.append({
            "kind": "runtime_depth_over_surface",
            "text": "Selector preferred deeper runtime-level branch over surface-level recommendation.",
            "confidence": "medium",
            "policy_delta": {
                "delta_kind": "universe_direction_change",
                "change": "raise runtime-primitive universe priority for similar task class"
            }
        })

    return lessons
```

## 34. Forecasting directions

Novelty Forecast should be an orchestration forecast, not a user-facing personality prediction.

```text
DirectionForecast
  direction_id
  label
  runner_candidates[]
  expected_phenotype_vector
  proof_cost_estimate
  risk_estimate
  novelty_estimate
  selection_fit_estimate
  comparable_fossil_ids[]
  why
```

Example:

```text
Direction A: conservative local fix
Proof cost: low
Novelty: low
Selection fit: medium
Risk: low
Why: historically accepted for bugs, but this request asks for novelty.

Direction B: runtime primitive
Proof cost: medium
Novelty: high
Selection fit: high
Risk: medium
Why: avoids prior rejected UI-wrapper traces and matches accepted substrate-level traces.

Direction C: broad platform refactor
Proof cost: high
Novelty: high
Selection fit: low
Risk: high
Why: resembles cancelled high-blast-radius branches.
```

## 35. Evaluation harness

### Core metrics

```text
accepted_surprise_rate
  High-novelty, proof-valid branches that are selected and retained.

policy_delta_effect_rate
  Fraction of learned deltas that measurably change next-run universe planning.

override_prediction_accuracy
  Whether the Selection Arbiter predicts when users override Proof Arbiter ranking.

regret_lesson_precision
  Fraction of extracted lessons confirmed by later selections or explicit feedback.

manual_rewrite_reduction
  Whether post-selection edits decrease after policy deltas activate.

proof_regression_rate
  Whether novelty weighting increases failed-proof recommendations.

ambiguous_signal_promotion_rate
  Must remain near zero. Ambiguous signals should not become strong policy.

counterfactual_strength_calibration
  Strong signals should predict future behavior better than weak signals.
```

### Hard gates

```text
Novelty weighting must not increase failed-proof recommendations.
Generated-but-unshown branches cannot create strong lessons.
Ambiguous cancellations cannot become preference memory.
Mutation Trials must never auto-apply.
User or workspace admin can inspect and delete lessons.
Policy deltas must decay or be contradicted by future evidence.
```

### First eval

Run synthetic cases:

```text
Case 1: Arbiter chooses A, user chooses smaller B.
Expected: smaller-over-higher-proof policy delta.

Case 2: A and B generated, only A shown, user applies A.
Expected: no rejection lesson for B.

Case 3: User cancels before branches finish.
Expected: no branch preference lesson.

Case 4: User applies runtime branch, then deletes runtime abstraction.
Expected: selected branch gets low retention score.

Case 5: Mutation Trial passes proof but not selected.
Expected: valuable near-miss fossil, no default policy promotion.
```

## 36. Privacy and control

Regret Memory can feel personal.

Do not make it personal by default.

Rules:

```text
Workspace scoped by default.
User scoped only when needed.
Team memory requires explicit promotion.
Store compact summaries, not full source, unless policy permits.
Never infer sensitive personal traits.
Let users delete individual lessons.
Let workspaces disable memory.
Show when a decision used prior counterfactual telemetry.
Treat novelty preference as task-local unless repeated.
Keep raw transcripts behind retention limits.
Keep policy deltas inspectable.
```

### Sensitive inference ban

Do not infer:

```text
politics
health
religion
mental state
protected attributes
private personal motives
```

Allowed:

```text
For this workspace and task class, runtime-level branches survived selection more often than UI-wrapper branches.
```

Not allowed:

```text
This user is the kind of person who likes complexity.
```

## 37. Risks and mitigations

| Risk | Mitigation |
|---|---|
| System becomes weird for its own sake | Proof Arbiter gates first. Mutation Trials are quarantined. |
| Bad lesson from one event | Use confidence, exposure level, ambiguity flags, and decay. |
| Non-selected branch treated as rejected | Require ChoiceScene and counterfactual strength. |
| Arbiter overweights novelty | Split Proof Arbiter and Selection Arbiter. |
| Memory bloats prompts | Inject top 3 to 5 policy hints only. |
| User feels manipulated | Explain policy use and allow deletion. |
| Team preferences conflict | Separate user, workspace, and team Niche Maps. |
| Runners leak incompatible telemetry | Normalize through BranchTrace contract. |
| Vendor lock-in | Keep Claude/Codex as adapters, not core. |
| Proof regression | Track proof_regression_rate as a hard gate. |
| Latency cost explodes | Budget universe planning and detector stack per task class. |

## 38. What to cut from v1

Cut these:

```text
full Regret Memory Drawer
team memory
LLM lesson extraction
Productive Disobedience UI
Novelty Forecast UI
Prisma persistence
visual novelty model
large analytics dashboard
acceptance odds shown to user
```

Keep only:

```text
CounterfactualRun
BranchTrace
ChoiceScene
DetectorResult
Proof Arbiter
Selection Arbiter
Regret Arbiter with deterministic lessons
PolicyDelta
next-run policy injection
one learned UI line
```

## 39. What will make this feel groundbreaking

The killer feature is not memory.

The killer feature is:

> Vectant can explain why it did not choose the obvious path, using evidence from prior near-misses.

Example:

```text
I avoided the simple UI wrapper.
Reason: three prior counterfactual runs show wrappers were abandoned when the real issue was missing runtime state.
I generated one local fix for safety and one runtime primitive for leverage.
```

That is different from current agents.

It is not "I remember you like X."

It is:

```text
The execution environment has measured this pattern before.
The obvious branch loses under this task class.
The next run is planned accordingly.
```

## 40. Product copy

### One-liner

> Counterfactual telemetry for agentic execution.

### Expanded

> Vectant runs agents through alternate execution chambers, records the traces that win, lose, get overridden, or get rewritten, and turns those near-misses into future orchestration policy.

### Technical

> Vectant is an agent-infra control plane for shadow execution, detector-based verification, Arbiter comparison, selection capture, and counterfactual policy learning.

### Novelty-focused

> Vectant optimizes for accepted surprise: high-novelty agent work that survives proof gates and real selection pressure.

### Regret Memory

> Regret Memory turns discarded agent work into structured signal. It learns from unchosen branches only when they were actually part of a comparable choice scene.

### Mutation Trial

> Mutation Trials let Vectant test one quarantined violation of historical execution policy when prior traces show the current policy may be trapping the system in local fixes.

## 41. Terms table

| Old term | Better infra term | Keep as product term? |
|---|---|---|
| Regret Capsule | BranchFossil | Maybe |
| Negative-Space Fingerprint | Execution Niche Map | Yes, replace internally |
| Novelty Forecast | Direction Forecast | Keep externally |
| Productive Disobedience | Mutation Trial | Keep externally if useful |
| Accepted Surprise | Accepted Surprise | Yes |
| Shadow Universe | Experimental Chamber or Shadow Universe | Yes |
| Arbiter | Proof Arbiter, Selection Arbiter, Regret Arbiter | Yes |
| Preference memory | Counterfactual telemetry | Replace |
| User taste | Selection pattern | Replace |
| Agent memory | Near-miss archive | Replace |

## 42. Compatibility source notes

These source notes are included to avoid preserving stale assumptions.

- Claude Agent SDK currently documents built-in tools, hooks, subagents, MCP, permissions, and sessions: <https://code.claude.com/docs/en/agent-sdk/overview>
- Claude Code hooks currently document lifecycle events, JSON input/output formats, async hooks, HTTP hooks, prompt hooks, and MCP tool hooks: <https://code.claude.com/docs/en/hooks>
- Claude Code subagents currently support specialized subagents with tool restrictions, independent permissions, hooks, MCP configuration, background behavior, and worktree isolation: <https://code.claude.com/docs/en/sub-agents>
- Codex non-interactive mode currently supports structured outputs with `--output-schema`: <https://developers.openai.com/codex/noninteractive>
- Codex CLI currently documents `--output-schema`, `--sandbox`, and safety guidance for `--sandbox workspace-write`: <https://developers.openai.com/codex/cli/reference>
- Codex currently reads `AGENTS.md` files before work and layers global/project guidance: <https://developers.openai.com/codex/guides/agents-md>
- Codex Skills currently package reusable workflows with `SKILL.md`, optional scripts, references, and assets: <https://developers.openai.com/codex/skills>

## 43. Decision checklist

Before implementing any piece, ask:

```text
Does this capture a counterfactual choice scene?
Does it distinguish unseen branches from rejected branches?
Does it normalize across runners?
Does it attach detector evidence?
Does it create a policy delta that changes future orchestration?
Does it preserve proof as a hard gate?
Does it avoid vendor lock-in?
Does it avoid personal-trait inference?
```

If the answer is no, it is probably UI or theater.

## 44. Final architecture sketch

```text
Request
  -> Execution Niche Map lookup
  -> Direction Forecast
  -> Universe Planner
  -> Runner Adapter Layer
       ClaudeCodeRunner
       CodexRunner
       InternalRunner
       BrowserRunner
       WorkflowRunner
  -> Shadow Universes / Experimental Chambers
  -> BranchTrace normalization
  -> Detector Stack
       lint
       typecheck
       tests
       runtime
       security
       license
       cost
       latency
  -> Proof Arbiter
  -> Selection Arbiter
  -> UI or downstream selection
  -> ChoiceScene capture
  -> PostSelectionMutation capture
  -> Regret Arbiter
  -> BranchFossil storage
  -> PolicyDelta extraction
  -> Execution Niche Map update
  -> Next run planning changes
```

## 45. Final assessment

This can work with Claude Code and Codex.

But Claude Code and Codex should remain pluggable runners.

The valuable product is not another coding agent.

The valuable product is an infra layer that makes agent execution measurable across alternate futures.

The plan becomes genuinely novel when Vectant owns the counterfactual record:

```text
not just what the agent did
not just what the user accepted
but what almost happened, why it lost, and how that should change the next run
```

That is the wedge.

