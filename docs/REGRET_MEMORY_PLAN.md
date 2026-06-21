# Regret Memory Novelty Plan

Status: proposal.

Canonical positioning:

> Counterfactual taste for agentic software work: learn from the futures the user did not ship.

This is not generic "agent memory" and not a preference toggle system. Preferences remember what a user accepted. Regret Memory studies the negative space around acceptance: rejected universes, cancelled branches, Arbiter overrides, manual rewrites after apply, and high-proof options the user still declined.

The core novelty claim:

> Vectant should become the first coding agent that optimizes for accepted surprise: work that is correct enough to prove, strange enough to matter, and shaped by the user's unchosen worlds.

## Executive Summary

Vectant already has rare substrate:

- Shadow universes that generate alternate patches.
- Arbiter verdicts that rank those patches with evidence.
- Apply, cancel, override, and why flows.
- Few-shot preference learning from accepted patches.
- Causal Twin planning for replaying what would have happened.
- Dojo proof, license, and governance language.
- Runtime MCP observation for verifying live behavior.

The missing product primitive is a durable model of what *almost* worked.

Today, accepted patches become preference examples. Non-applied branches mostly become verification history, cost metadata, or cancelled siblings. Regret Memory turns every unchosen branch into a compact lesson:

```text
Universe A passed tests but was rejected because it was too broad.
Universe B failed one edge case but matched the user's taste.
Universe C was Arbiter's pick, but the user overrode it and chose the smaller patch.
The user applied A, then manually deleted half the abstraction.
The user cancelled all universes after seeing the direction, so the premise was wrong.
```

That produces a negative-space model:

```text
For this user, in this repo:
  - safe-but-boring is usually rejected for product features
  - source-level affordance patches beat browser automation patches
  - UI novelty is welcome when paired with runtime proof
  - broad abstractions need repeated pain evidence before acceptance
  - tests matter, but test-only fixes under-satisfy visual requests
```

Future agents use that model before they plan, generate, arbitrate, and explain.

## Why This Is Novel

Most agent systems will converge on:

- long-term user memory
- project style guides
- thumbs up/down
- accepted patch examples
- team conventions
- "personalized" prompts

Those are useful, but predictable.

Regret Memory is different because it learns from **counterfactual creative waste**. The strongest signal is not just what the user accepted; it is the boundary formed by what the user saw, could have chosen, and declined.

This matters because high-end agentic work is not only a correctness problem. It is a taste-risk problem:

```text
Can the agent produce something the user did not ask for literally,
but would still accept once they see it?
```

That is accepted surprise.

## Product Language

Preferred name:

```text
Regret Memory
```

Companion terms:

- **Novelty Forecast**: predicts acceptance odds across creative directions before generation.
- **Negative-Space Fingerprint**: the learned boundary around a user's rejected directions.
- **Accepted Surprise**: a high-novelty result that still survives proof and user judgment.
- **Productive Disobedience**: a sandboxed branch that intentionally violates historical preference for a stated reason.
- **Regret Capsule**: one compact record of an unchosen branch and why it matters.

Avoid:

- "mind reading"
- "personalization engine"
- "vibe memory"
- "AI knows what you want"
- "fully autonomous taste"

Use:

- "learns from unchosen branches"
- "models acceptance boundaries"
- "optimizes for accepted surprise"
- "novelty with proof"
- "negative-space signal"

## User Experience

### Before Generation: Novelty Forecast

When a user asks for work, the agent can internally score several possible directions:

```text
Novelty Forecast

Direction A: Conservative local fix
Correctness: 94%
Novelty: 11%
Acceptance: 42%
Why: resembles 5 previously accepted bug fixes, but this request asks for novelty.

Direction B: Runtime-level primitive
Correctness: 78%
Novelty: 88%
Acceptance: 81%
Why: avoids 3 previously rejected UI-glue patterns and matches prior accepted substrate work.

Direction C: Broad platform refactor
Correctness: 66%
Novelty: 73%
Acceptance: 24%
Why: resembles 4 cancelled branches with large blast radius.
```

The user does not need to see this every time. It should surface when:

- the request explicitly asks for novelty
- the forecast is surprising
- the agent wants to take a historically unusual direction
- cost is high and branch choice matters
- Productive Disobedience is enabled

### During Shadow Verification: Negative-Space Labels

In the Multiverse card, each universe gets a regret/taste label:

```text
Universe A
Verified, low novelty.
Likely too ordinary for this prompt.

Universe B
Verified, high novelty, high fit.
Similar to prior accepted runtime-substrate moves.

Universe C
Partially verified, high novelty, low fit.
Matches branches this user usually cancels.
```

### After Apply: Learned From This Run

After a user applies, cancels, overrides, or edits:

```text
Learned from this run:
You chose the runtime-level idea over the smaller local patch.
Future agents will bias toward substrate features when they remove repeated UI glue.
```

If the user overrides the Arbiter:

```text
Learned from override:
The Arbiter overvalued test coverage and undervalued novelty.
Future Arbiter prompts will treat "cool / never seen" requests as novelty-weighted.
```

If the user cancels:

```text
Learned from cancellation:
All generated branches assumed the feature should be implemented inside the chat UI.
Future runs should consider backend/runtime primitives before UI surfaces.
```

## Core Data Model

### RegretCapsule

```text
RegretCapsule
  id
  workspace_id
  repo_fingerprint
  user_id
  conversation_id
  shadow_job_id
  universe_id
  created_at

  prompt_summary
  explicit_novelty_request
  intent_kind
  domain_kind

  branch_status
    applied
    rejected
    cancelled
    arbiter_loser
    arbiter_winner_overridden
    applied_then_rewritten
    failed_verification
    stale

  branch_features
    style
    model_pair
    files_touched
    loc_delta
    abstraction_delta
    test_delta
    ui_delta
    runtime_delta
    risk_score
    novelty_score
    proof_score

  evidence_summary
    lint
    types
    tests
    runtime_probe
    attacks_tested
    attacks_survived
    arbiter_rank
    arbiter_rationale

  user_signal
    applied_universe_id
    user_overrode_arbiter
    cancel_stage
    manual_edit_summary
    why_question
    explicit_feedback

  inferred_lesson
    lesson_text
    avoid_pattern
    prefer_pattern
    confidence
    decay_after
    source
```

### NegativeSpaceFingerprint

Aggregated per `(user, repo)` and optionally per team:

```text
NegativeSpaceFingerprint
  user_id
  repo_id
  updated_at

  accepted_patterns[]
  rejected_patterns[]
  novelty_thresholds
  proof_thresholds
  abstraction_tolerance
  visual_novelty_tolerance
  runtime_substrate_preference
  test_bias
  patch_size_bias
  override_patterns[]

  confidence
  sample_count
  last_capsule_ids[]
```

### NoveltyForecast

Computed before generation:

```text
NoveltyForecast
  request_id
  workspace_id
  user_id
  directions[]

Direction
  id
  label
  description
  correctness_estimate
  novelty_estimate
  acceptance_estimate
  proof_cost_estimate
  risk_estimate
  reasons[]
  comparable_capsule_ids[]
```

## Signals To Capture

### Strong Positive Signals

- User applies a universe.
- User overrides Arbiter and applies a non-winner.
- User keeps a patch with minimal manual edits.
- User asks "why?" and accepts after explanation.
- User reuses a generated artifact later.

### Strong Negative Signals

- User cancels before any universe completes.
- User cancels after seeing a particular direction.
- User rejects Arbiter winner.
- User applies then rapidly reverts.
- User applies then manually removes the main abstraction.
- User asks "why?" and still rejects.
- User repeatedly ignores a style of universe.

### Ambiguous Signals

- Universe failed verification.
- User ran out of budget.
- User stopped because of latency.
- Staleness detected.
- Merge conflict prevented apply.
- User manually edits because the patch was close but incomplete.

Ambiguous signals must not become strong lessons without supporting evidence.

## Novelty Scoring

Novelty should not mean random, flashy, or large. It should mean meaningfully unlike the local baseline while still grounded in the request.

Dimensions:

```text
structural_novelty
  Does the solution introduce a new primitive, execution path, or abstraction?

interaction_novelty
  Does the user experience behave in a way this product has not used before?

substrate_novelty
  Does it solve the problem at a deeper runtime/protocol/tooling layer?

visual_novelty
  Does it create a meaningfully distinct visual or motion direction?

workflow_novelty
  Does it change how agents or humans collaborate?

proof_novelty
  Does it create a new kind of evidence, not just a new UI?
```

Novelty penalties:

```text
gratuitous_scope
  More files or abstractions without proof-backed leverage.

surface_only
  Looks different but does not change capability.

unproven_magic
  Surprising claim without deterministic evidence.

anti_project
  Violates stable repo conventions without a reason.

cost_spike
  Novel path costs significantly more than its benefit.
```

## Productive Disobedience

Productive Disobedience is a controlled mode where one universe intentionally violates the learned preference boundary.

It is not default recklessness. It must declare:

```text
I know this repo usually prefers small diffs.
I am testing one larger runtime-level branch because the last four accepted fixes
all worked around the same missing primitive.
This branch is quarantined unless it proves simpler future work.
```

Rules:

- Always sandboxed.
- Never auto-applied.
- Must include a why-now reason.
- Must cite the preference it is violating.
- Must have stricter proof gates than normal branches.
- Must be limited by budget.
- Must be tracked separately in Regret Memory.

This is the feature that makes the agent feel alive without becoming chaotic.

## Architecture

```text
Shadow Job / Chat Run / Dojo Skill Run
  -> Branch Evidence Collector
  -> Regret Capsule Builder
  -> Manual Edit Diff Summarizer
  -> Lesson Extractor
  -> Negative-Space Fingerprint Store
  -> Novelty Forecast Engine
  -> Generator Direction Planner
  -> Arbiter Novelty Weighting
  -> UI Explanation Surfaces
```

### Branch Evidence Collector

Consumes:

- shadow universe results
- Arbiter verdicts
- apply/cancel/why events
- post-apply file diffs
- provenance ids
- Causal Twin replay outcomes when available
- Dojo skill acceptance or refusal events

### Regret Capsule Builder

Produces a compact structured record. It should avoid storing full source by default. Store:

- hashes and patch summaries
- compact diffs capped by size
- evidence counts
- reasons and labels
- comparable capsule refs

### Lesson Extractor

Uses deterministic templates first, LLM second.

Deterministic examples:

```text
If arbiter_winner != applied_universe and applied_universe has lower LOC:
  lesson = "User preferred smaller patch over Arbiter's higher-proof branch."

If applied patch touched runtime files and rejected patches touched UI files:
  lesson = "User preferred substrate-level solution over surface UI solution."

If prompt includes novelty terms and low-novelty branch rejected:
  lesson = "Novelty request should raise novelty weight."
```

LLM extraction should only summarize already-recorded evidence; it must not invent user motives.

### Novelty Forecast Engine

Inputs:

- current prompt
- repo fingerprint
- user fingerprint
- recent accepted examples
- recent regret capsules
- project docs and status plans
- cost budget
- proof budget

Outputs:

- ranked directions
- acceptance estimates
- novelty estimates
- comparable historical capsules
- whether Productive Disobedience is justified

### Generator Integration

Before generating patches, the Generator receives:

```text
Accepted examples:
  last N applied patches

Avoid patterns:
  compact lessons from regret capsules

Novelty objective:
  low / medium / high / breakthrough

Direction choice:
  selected forecast direction + why
```

### Arbiter Integration

The Arbiter should judge:

- correctness
- proof
- risk
- maintainability
- novelty fit
- request satisfaction
- user/repo acceptance likelihood

It must not let novelty override failed proof, but it should allow novelty to break ties among verified branches.

## API Sketch

### POST `/regret/capsule`

Records one branch outcome.

```json
{
  "workspace_id": "ws_123",
  "shadow_job_id": "shd_123",
  "universe_id": "B",
  "branch_status": "arbiter_winner_overridden",
  "applied_universe_id": "C",
  "evidence": {
    "tests": "8/8",
    "attacks_survived": 0,
    "loc_delta": "+44 -12",
    "arbiter_rank": 1
  }
}
```

### GET `/regret/fingerprint?workspace_id=...`

Returns the current negative-space fingerprint.

### POST `/regret/forecast`

Produces a Novelty Forecast for a request.

```json
{
  "workspace_id": "ws_123",
  "user_request": "find a cool never-before-seen agentic feature",
  "intent": "ideation",
  "budget": {
    "max_directions": 3,
    "max_cost_usd": 0.05
  }
}
```

Response:

```json
{
  "directions": [
    {
      "id": "runtime_substrate",
      "label": "Runtime-level primitive",
      "novelty": 0.91,
      "acceptance": 0.84,
      "risk": 0.38,
      "why": [
        "User previously preferred substrate features over UI glue",
        "Prompt explicitly requests novelty"
      ]
    }
  ]
}
```

## UI Surfaces

### Compact Chat Surface

Only show when useful:

```text
I am taking the runtime-primitive direction.
Why: your last rejected branches were surface UI wrappers; this asks for novelty.
```

### Multiverse Card

Add one line per universe:

```text
Novelty fit: high
Taste risk: low
Comparable: accepted runtime-substrate patch, 2026-06-16
```

### Regret Memory Drawer

Not a dashboard. A compact inspection drawer:

```text
Regret Memory

Recent lessons
  - Prefer runtime primitives over UI wrappers for agent features.
  - Avoid broad refactors unless repeated pain is proven.
  - For novelty prompts, low-risk conservative branches underperform.

Evidence
  12 accepted patches
  31 rejected universes
  4 Arbiter overrides
  7 post-apply rewrites
```

### Productive Disobedience Banner

```text
Trying one disobedient branch
This violates the repo's usual small-diff bias because the last 4 fixes worked around the same missing primitive.
It will not auto-apply.
```

## File Touch Plan

### Planning Commit

Create:

- `docs/REGRET_MEMORY_NOVELTY_PLAN.md`

### Phase 1: Data Contracts

Create:

- `ai-backend/ai-engine/shadow/regret_types.py`
- `ai-backend/ai-engine/shadow/regret_store.py`
- `ai-backend/ai-engine/shadow/novelty_score.py`

Tests:

- `ai-backend/ai-engine/test_shadow_regret_types.py`
- `ai-backend/ai-engine/test_shadow_novelty_score.py`

### Phase 2: Capture Regret Capsules From Shadow Apply/Cancel

Touch:

- `ai-backend/ai-engine/shadow/api.py`
- `ai-backend/ai-engine/shadow/events.py`
- `ai-backend/ai-engine/shadow/preference.py`

Create:

- `ai-backend/ai-engine/shadow/regret_capture.py`

Scope:

- On apply, create capsules for applied universe and non-applied siblings.
- On cancel, create cancellation capsules with stage and partial evidence.
- On Arbiter override, mark winner as overridden and applied universe as user-preferred.

### Phase 3: Negative-Space Fingerprint

Create:

- `ai-backend/ai-engine/shadow/regret_fingerprint.py`
- `ai-backend/ai-engine/shadow/regret_lessons.py`

Scope:

- Aggregate compact lessons per `(user, repo)`.
- Decay stale lessons.
- Separate strong, weak, and ambiguous signals.

### Phase 4: Novelty Forecast API

Create:

- `ai-backend/ai-engine/shadow/novelty_forecast.py`
- `synthi/src/app/api/regret/forecast/route.js`
- `synthi/src/lib/regretClient.js`

Touch:

- `ai-backend/ai-engine/main.py`

Scope:

- Produce 2-4 candidate directions for a request.
- Score novelty, acceptance, risk, proof cost.
- Cite comparable capsules.

### Phase 5: Generator And Arbiter Prompt Integration

Touch:

- `ai-backend/ai-engine/shadow/generator.py`
- `ai-backend/ai-engine/shadow/arbiter.py`
- `ai-backend/ai-engine/shadow/multiverse.py`

Scope:

- Inject accepted examples plus avoid patterns.
- Add novelty objective to generator styles.
- Add novelty-fit field to Arbiter verdict schema.
- Ensure novelty cannot bless failed proof.

### Phase 6: UI

Create:

- `synthi/src/components/chat/RegretMemoryDrawer.jsx`
- `synthi/src/components/chat/NoveltyForecastCard.jsx`

Touch:

- `synthi/src/components/chat/MultiverseCard.jsx`
- `synthi/src/components/chat/ArbiterCard.jsx`
- `synthi/src/components/chat/hooks/useShadowVerify.js`

Scope:

- Show novelty fit and taste risk on universes.
- Show "learned from this run" after apply/cancel.
- Add optional drawer for recent regret lessons.

### Phase 7: Productive Disobedience

Create:

- `ai-backend/ai-engine/shadow/productive_disobedience.py`

Touch:

- `ai-backend/ai-engine/shadow/multiverse.py`
- `ai-backend/ai-engine/shadow/scoring.py`
- `synthi/src/components/chat/MultiverseCard.jsx`

Scope:

- Add one quarantined high-novelty branch when justified.
- Require stricter proof gates.
- Never auto-apply.
- Track as a distinct regret/acceptance signal.

### Phase 8: Persistence

Touch:

- `synthi/prisma/schema.prisma`

Create:

- `synthi/src/lib/regret-store.js`
- `synthi/src/lib/__tests__/regret-store.test.js`
- `synthi/prisma/migrations/<timestamp>_regret_memory/migration.sql`

Scope:

- Persist capsules and fingerprints.
- Scope by workspace/user.
- Add retention and redaction policy.

## First Vertical Slice

Goal:

After a shadow job with at least two universes, Vectant records why the non-applied universe lost and uses that lesson in the next generation.

Scope:

- Shadow-only.
- In-memory or file-backed store.
- No Prisma migration yet.
- No Productive Disobedience yet.
- Deterministic lesson extraction only.
- One UI line: "Learned from this run."

Flow:

```text
1. Run a shadow job with Universe A and Universe B.
2. Arbiter recommends A.
3. User applies B.
4. System records:
     A: arbiter_winner_overridden
     B: applied_user_override
5. Lesson extractor emits:
     "User preferred smaller patch over Arbiter's higher-proof branch."
6. Next generation receives that as an avoid/prefer hint.
7. UI shows the learned lesson after apply.
```

Files:

- `ai-backend/ai-engine/shadow/regret_types.py`
- `ai-backend/ai-engine/shadow/regret_store.py`
- `ai-backend/ai-engine/shadow/regret_capture.py`
- `ai-backend/ai-engine/shadow/regret_lessons.py`
- `ai-backend/ai-engine/shadow/api.py`
- `ai-backend/ai-engine/shadow/generator.py`
- `synthi/src/components/chat/MultiverseCard.jsx`
- `synthi/src/components/chat/hooks/useShadowVerify.js`

Tests:

- applying non-Arbiter winner creates override capsules
- cancelling a job creates cancellation capsules
- deterministic lesson extraction handles smaller-over-higher-proof override
- generator prompt receives avoid/prefer hints
- UI renders learned lesson

## Evaluation Harness

Metrics:

```text
accepted_surprise_rate
  High-novelty branches that are accepted and verified.

boring_acceptance_drop
  Rate at which low-novelty branches are rejected for novelty prompts.

override_prediction_accuracy
  Whether the forecast predicts Arbiter override risk.

regret_lesson_precision
  Fraction of extracted lessons the user or later behavior confirms.

manual_rewrite_reduction
  Whether post-apply manual edits decrease after Regret Memory is active.

proof_regression_rate
  Whether novelty weighting causes more failed-proof branches to be recommended.
```

Hard gates:

- Novelty weighting must not increase failed-proof recommendations.
- Lessons from ambiguous signals cannot enter high-confidence memory.
- Productive Disobedience must never auto-apply.
- User can inspect and delete learned lessons.

## Privacy And Control

Regret Memory can feel personal. Keep it honest and controllable.

Rules:

- Workspace scoped by default.
- User scoped unless explicitly promoted to team memory.
- Store compact summaries, not full source, unless policy permits.
- Never infer sensitive personal traits.
- Let user delete individual lessons.
- Let user disable memory per workspace.
- Show when a decision used Regret Memory.
- Treat "novelty preference" as task-local unless repeated.

## Risks

| Risk | Mitigation |
|---|---|
| Agent becomes too weird | Novelty cannot override proof gates; Productive Disobedience is sandboxed. |
| Bad lesson from one rejection | Confidence and decay; require repeated evidence for strong lessons. |
| User feels manipulated | Surface "why this direction" and allow deleting lessons. |
| Arbiter overweights taste | Separate proof score from novelty fit; failed proof cannot win. |
| Memory bloats prompts | Compress into top 3-5 avoid/prefer hints. |
| Novelty becomes visual gimmick | Score substrate, workflow, and proof novelty, not only visual novelty. |
| Team tastes conflict | Keep user and team fingerprints separate; show conflict in forecast. |

## Success Criteria

The first version is successful if:

- Non-applied universes produce durable Regret Capsules.
- Arbiter overrides create clear negative-space lessons.
- The next generation changes direction based on those lessons.
- The UI shows what was learned without feeling noisy.
- Users can delete or disable lessons.
- Novelty-request prompts produce less generic work.

The mature version is successful if:

- Vectant reliably proposes surprising ideas users accept.
- Agents can explain why they avoided obvious but historically rejected directions.
- Productive Disobedience occasionally discovers better primitives without creating reckless changes.
- The system's taste model is evidence-backed, inspectable, and proof-gated.
- "Accepted surprise" becomes a measurable product quality.

