# Causal Twin Cloud Plan

Status: proposal.

Canonical positioning:

> Counterfactual infrastructure for software changes: fork, replay, and prove what would have happened.

This is not agent orchestration, not another dashboard, and not "AI incident response." It is a counterfactual replay substrate for software changes. The word "causal" is product shorthand, not permission to overclaim true distributed-systems causality. The defensible claim is narrower:

> Under replay envelope E, changing input X prevented or changed observed outcome Y.

The long-term vision can expand toward cloud-level replay across compute, network, storage, IAM, scheduler state, configuration, deploys, queues, feature flags, and external side effects. That is a 5-10 year research and infrastructure roadmap, not the first business. The Vectant wedge should stay much narrower for a long time: replay for AI-built software changes and cloud development runtimes, where this repo already controls the source, workspace, build, runtime, tests, preview, deployment metadata, and verification loop.

## Executive Summary

Causal Twin Cloud records enough context around a software change to fork the past into an isolated twin, replay the observed failure, run counterfactual variants, and produce a Causal Diff report with structured proof, confidence, and coverage.

Example:

```text
At 14:03, p95 latency spiked.

Show the minimal counterfactual chain.
Replay the same traffic without deploy D.
Replay again with feature flag F disabled.
Replay again with queue autoscale threshold at 55%.
Tell me which change would have prevented recurrence.
```

Expected answer:

```text
Under replay envelope E, the database-only hypothesis did not reproduce as preventive.

The counterfactual chain was:
1. Deploy D enabled feature flag F for workspace W.
2. F increased request fanout from 3.1x to 6.4x.
3. Queue Q saturated.
4. Autoscaler policy P ignored delayed work and scaled 7 minutes late.

Rollback would have reduced the incident.
The smallest recurrence-preventing change is lowering Q autoscale threshold
from 80% to 55%, proven within replay envelope E in twin replay ctr_2026_06_21_0017.

Proof state: causal-prevention-proven
Confidence: 92%
Coverage: 73% of relevant runtime state captured
```

The product claim should be strict:

- "observed" means recorded from production or controlled runtime telemetry.
- "replayed" means executed in an isolated twin with a fixed replay envelope.
- "counterfactual" means exactly one or a declared set of inputs changed.
- "proved" means backed by deterministic gates, test/oracle output, and a structured proof artifact.
- "suggested" means AI or heuristic inference that did not meet proof requirements.
- "caused" should generally be avoided in user-facing claims. Prefer "under replay envelope E, removing X prevented Y" or "X was necessary for Y in this replay."

## First-Year Scope

The first-year product should deliberately cut most of the cloud-wide ambition.

Focus only on:

```text
AI change
  -> snapshot before
  -> snapshot after
  -> replay
  -> counterfactual replay
  -> proof report
```

Do not prioritize:

- IAM replay
- DNS replay
- packet-level network replay
- autoscaler simulation
- arbitrary queue ordering replay
- production database time travel
- general cloud incident response

Those are valuable later, but they are not necessary to prove the first commercial wedge. The strongest initial product is a premium verification feature for Vectant/Synthi: AI-generated change verification plus counterfactual replay plus proof.

## Fit With This Repo

Vectant/Synthi already contains many of the pieces needed for a credible first wedge:

- Workspace and runtime control through the collab server and runtime pods.
- Shadow verification, multiverse patch testing, and apply/cancel flows.
- Provenance tracking for AI-generated changes.
- Runtime proof discipline from GPU HMR: proof ladders, degraded states, host preservation, dispatch evidence, output oracles, and "AI proposes; deterministic systems prove."
- Browser/MCP observation surfaces for HMR, screenshots, event logs, DOM/a11y labels, and runtime health.
- Kubernetes and Cloud Run deployment assets.
- Cost, budget, and verification UX patterns.

The repo does not currently have a cloud-wide causal twin substrate. The correct move is to create an architecture plan and then implement a thin vertical slice against the surfaces the repo already owns.

## Product Shape

Product name candidates:

- Causal Twin Cloud
- Production Time Machine
- Causal Diff
- Counterfactual Runtime

Recommended naming:

- Platform primitive: Causal Twin
- User-facing wedge: Causal Diff
- Incident workflow: Production Time Machine

Primary first user:

- An engineer using Vectant/Synthi to build, verify, run, and deploy software.

Primary first job:

- "This patch/deploy broke something. Under the replay envelope, prove whether removing it would have prevented the failure."

Non-goals for the first wedge:

- Full AWS/Azure/GCP replay across all managed services.
- Packet-perfect distributed replay.
- Arbitrary database time travel.
- Automatic production mutation.
- AI-only incident claims.
- User-facing claims of absolute causality outside the replay envelope.

## Terminology Discipline

The product can be named Causal Twin or Causal Diff, but the claims must remain envelope-bound.

Preferred language:

- "Under replay envelope E, removing X prevented Y."
- "X was necessary for Y in this replay."
- "The counterfactual changed the observed outcome."
- "This hypothesis is unsupported because the base replay diverged."

Avoid:

- "X caused the incident."
- "Root cause proven" without envelope, confidence, and coverage.
- "Minimal causal chain" when minimality has not been tested.
- "Production replay" when the run only replayed tests/probes.

## Architecture Model

The architecture has six layers:

1. Causal recorder
2. Evidence ledger
3. Twin materializer
4. Replay runner
5. Counterfactual planner
6. Causal diff reporter

### 1. Causal Recorder

The recorder captures events and state transitions that could influence runtime behavior.

Initial Vectant wedge records:

- source diff and file hashes
- AI prompt, model, provider, provenance id
- generated patch id and accepted/rejected status
- workspace id, user id, repo commit, branch, dirty state
- dependency install events and lockfile hashes
- build command, toolchain version, image id
- test command, test result, diagnostics
- runtime session id and preview session id
- HMR status, compile errors, console/network events
- environment variables metadata, with secret redaction
- feature/config values explicitly exposed by the app/runtime
- deployment target, build artifact digest, Cloud Run/GKE rollout metadata where available
- shadow verification job id, universe ids, arbiter verdict, proof refs

Later cloud-level recorder records:

- request traces and span links
- deployment/config changes
- IAM authorization decisions
- scheduler and autoscaler decisions
- DNS and service discovery answers
- queue ordering and message metadata
- DB transaction metadata and read/write set summaries
- external API response envelopes as mockable side effects
- network timing and packet anomalies where needed

This later recorder list is intentionally parked. It should not block revenue or the first production slice. Treat it as roadmap language until the AI-change replay product has real usage, measured replay rates, and a cost model that works.

### 2. Evidence Ledger

The ledger is append-only and stores normalized events, snapshots, and proof artifacts.

Core entities:

```text
CausalEvent
  id
  workspaceId
  incidentId
  sessionId
  timestamp
  actorType
  actorId
  source
  kind
  subject
  inputRefs
  outputRefs
  parentEventIds
  payloadHash
  redactionPolicy

CausalSnapshot
  id
  workspaceId
  commit
  fileHashes
  envFingerprint
  dependencyFingerprint
  runtimeFingerprint
  deploymentFingerprint
  createdFromEventId

TwinReplay
  id
  incidentId
  baseSnapshotId
  replayWindow
  fixedInputs
  changedInputs
  sideEffectPolicy
  status
  resultRefs

CausalProof
  id
  incidentId
  claim
  proofState
  confidence
  coverage
  replayEnvelopeId
  replayIds
  oracleRefs
  rejectedAlternatives
  degradedReasons
```

Storage strategy:

- Postgres for metadata and queryable event rows.
- Blob/object storage for larger payloads, screenshots, logs, trace bundles, and replay artifacts.
- Content-addressed hashes for dedupe and integrity.
- Content-addressed worktrees for source snapshots.
- Layered filesystem snapshots for runtime twins where available.
- Dependency/cache layers shared across twins by lockfile hash.
- Per-workspace retention policy and explicit redaction.

### 3. Twin Materializer

The materializer creates an isolated runtime clone from a snapshot and replay envelope.

Initial wedge:

- clone workspace into a shadow worktree or runtime pod
- restore file state by commit/hash
- install dependencies using captured lockfile
- apply selected patch/config mutations
- run tests, build, preview, or runtime probes
- isolate external side effects with mocks or blocked egress

Later cloud-level version:

- fork service topology
- replay traffic windows
- restore queue envelopes
- mock external APIs
- simulate config/IAM/scheduler/autoscaler decisions
- run with tenant isolation and strict egress controls

The cloud-level materializer is not required before the first wedge reaches value. The first materializer should be boring: worktree, dependency cache, test/build/runtime probe, blocked egress, proof artifact.

### 4. Replay Runner

The runner executes deterministic or bounded-nondeterministic replays.

Replay modes:

- verify-only: run current code through captured tests/probes without mutation
- incident replay: reproduce a known failure from captured inputs
- counterfactual replay: change one variable and compare outcome
- recurrence replay: run current code/config against historical failure conditions
- guardrail replay: prove a proposed patch, test, or policy would have prevented recurrence

Initial oracles:

- tests pass/fail
- typecheck/lint pass/fail
- runtime process health
- HMR compile status
- HTTP route response status
- console/runtime errors
- browser-rendered assertions
- performance budget deltas where captured

Later oracles:

- latency percentile deltas
- queue depth and drain time
- autoscaler timing
- IAM allow/deny parity
- DB read/write conflict summaries
- external API mock contract compatibility
- SLO outcome windows

### Replay Envelope

A replay envelope defines exactly what is being held fixed, what is allowed to vary, what evidence is included, and what is outside the proof boundary. Every proof claim must cite a replay envelope id.

Example first-wedge envelope:

```text
ReplayEnvelope
  id: env_...

  Included:
    source code snapshot
    dependency lockfiles
    package manager cache fingerprint
    build command
    test command
    runtime probe command
    env var names and allowlisted values
    browser route probes
    console/runtime error capture
    shadow verification evidence

  Excluded:
    live production traffic
    production database writes
    external payment API
    real email/SMS/webhook delivery
    exact kernel/network scheduling
    unredacted secrets

  Variable:
    selected patch/config/flag mutation
    deterministic test input
    mocked external response fixture
```

User-facing reports must state the envelope plainly. A proof outside its envelope is not a proof.

### Reproduction Confidence

Replay divergence will be the dominant early state. The product must treat it as a first-class outcome instead of a quiet failure.

A replay result carries:

```text
reproductionConfidence: 0.87
symptomMatch:
  errorSignature: exact
  failingTest: exact
  routeStatus: exact
  latencyShape: partial
  consoleErrors: partial
  timestampSensitivity: high
```

Guidelines:

- Exact test/runtime failures can reach high confidence.
- Latency, race, cache, queue, and timing failures should usually start at partial confidence.
- If the base symptom does not reproduce, counterfactual claims must stop at `causal-replay-diverged`.
- A low-confidence reproduction can still be useful, but the report must say "suggestive," not "proven."

### Coverage

Proof state is not enough. Every report should show coverage: how much relevant runtime state was captured and replayed.

Coverage dimensions:

- source coverage
- dependency coverage
- env/config coverage
- test/probe coverage
- runtime event coverage
- external side-effect coverage
- data-state coverage
- timing/scheduler coverage

Example:

```text
Proof State: causal-effect-observed
Confidence: 92%
Coverage: 73%

Weak areas:
  external billing API mocked from status code only
  database state approximated by fixture seed
  latency shape matched, but packet timing was not captured
```

### 5. Counterfactual Planner

The planner chooses which alternate worlds to test.

AI can propose counterfactuals:

- rollback deploy D
- disable feature flag F
- revert config C
- increase DB pool capacity by 30%
- change queue autoscale threshold to 55%
- restore old IAM policy
- add guardrail or regression test

Deterministic systems must run and score them. AI must not decide proof states.

Planner inputs:

- observed causal graph
- incident symptoms
- recent changes
- dependency graph
- runtime traces
- shadow verification evidence
- known historical regressions
- user-specified hypotheses

Planner output:

```json
{
  "incidentId": "inc_...",
  "baseReplay": "replay_...",
  "counterfactuals": [
    {
      "id": "ctr_1",
      "description": "Replay without deploy D",
      "changedInputs": [{ "kind": "deploy", "id": "D", "state": "absent" }],
      "expectedOracle": "latency_p95_below_threshold"
    }
  ]
}
```

### 6. Causal Diff Reporter

The reporter presents the envelope-bound counterfactual chain and the proof-backed prevention recommendation.

Required sections:

- symptom
- replay envelope
- counterfactual chain
- disproven hypotheses
- counterfactuals run
- smallest preventing change
- confidence
- coverage
- recurrence risk under current state
- proof state
- degraded/unknown evidence
- suggested patch or guardrail

The UI should distinguish:

- Proven
- Observed but not proven
- Suggested
- Blocked by missing evidence
- Replayed but low-confidence
- Outside replay envelope

## Proof Ladder

Causal Twin must use explicit proof states, borrowing the discipline from the GPU HMR plan.

```text
causal-recorded
  The relevant event or state was captured.

causal-linked
  The event was linked into a candidate causal graph.

causal-replay-reproduced
  The incident symptom was reproduced in an isolated twin with a declared reproduction confidence.

causal-counterfactual-tested
  At least one alternate input was changed and replayed.

causal-effect-observed
  The counterfactual changed the target outcome within the replay envelope.

causal-minimality-proven
  A smaller declared candidate set failed to prevent the outcome, while this candidate succeeded.

causal-prevention-proven
  The recommended change prevented the incident under the replay envelope and passed guardrail checks.
```

Degraded states:

```text
causal-recording-incomplete
  Required telemetry was missing.

causal-replay-diverged
  The twin could not reproduce the base symptom at the minimum confidence threshold.

causal-side-effect-unmocked
  An external dependency could not be safely replayed or mocked.

causal-db-fidelity-low
  Database state was approximated below the required proof threshold.

causal-nondeterminism-unbounded
  Randomness, time, scheduling, or network variance exceeded allowed bounds.

causal-privacy-redacted
  Required payloads were unavailable due to redaction policy.

causal-ai-only-hypothesis
  AI suggested a cause, but no replay or deterministic evidence proved it.
```

Proof report fields:

```text
proofState
  Highest state reached in the ladder.

confidence
  0-100 score derived from reproduction confidence, oracle strength,
  counterfactual stability, and nondeterminism penalties.

coverage
  0-100 score showing how much relevant state was captured by the replay envelope.

replayEnvelopeId
  The exact boundary of the claim.
```

Confidence is not a model vibe. It is computed from evidence:

- base symptom reproduction strength
- exactness of failure signature
- number and consistency of repeated replays
- oracle quality
- amount of redacted/missing evidence
- nondeterminism markers
- side-effect fidelity
- data-state fidelity

Coverage is not confidence. A replay can be high-confidence for a narrow test failure and still have low cloud-state coverage. Keep both visible.

## File Touch Plan

This section lists exactly what to touch when moving from plan to implementation.

### Planning Commit

Create:

- `docs/CAUSAL_TWIN_CLOUD_PLAN.md`

Do not modify runtime code in the planning commit.

### Phase 1: Data Contracts

Create:

- `ai-backend/ai-engine/causal/__init__.py`
- `ai-backend/ai-engine/causal/types.py`
- `ai-backend/ai-engine/causal/proof.py`
- `ai-backend/ai-engine/causal/envelope.py`
- `ai-backend/ai-engine/causal/confidence.py`
- `ai-backend/ai-engine/causal/ledger.py`
- `ai-backend/ai-engine/causal/redaction.py`

Touch:

- `ai-backend/ai-engine/main.py`

Purpose:

- Define event, snapshot, replay, counterfactual, and proof schemas.
- Define replay envelope, confidence, and coverage schemas.
- Add in-memory or file-backed ledger for the first slice.
- Add proof-state enum and degraded reason enum.
- Mount health/status endpoint only after schemas exist.

Tests:

- `ai-backend/ai-engine/tests/test_causal_types.py`
- `ai-backend/ai-engine/tests/test_causal_envelope.py`
- `ai-backend/ai-engine/tests/test_causal_confidence.py`
- `ai-backend/ai-engine/tests/test_causal_ledger.py`
- `ai-backend/ai-engine/tests/test_causal_redaction.py`

### Phase 2: Recorder Hooks

Create:

- `ai-backend/ai-engine/causal/recorder.py`
- `synthi/src/lib/causal-client.js`

Touch:

- `ai-backend/ai-engine/provenance.py`
- `ai-backend/ai-engine/shadow/events.py`
- `ai-backend/ai-engine/shadow/api.py`
- `synthi/src/app/api/chat/route.js`
- `synthi/src/app/api/shadow/run/route.js`
- `synthi/src/app/api/shadow/[jobId]/apply/route.js`
- `synthi/src/components/chat/hooks/useShadowVerify.js`

Purpose:

- Emit causal events for AI generation, patch acceptance, shadow verification start/end, universe verdicts, and apply actions.
- Link provenance ids to shadow job ids and workspace snapshots.
- Keep recorder non-blocking and failure-tolerant.

Tests:

- `ai-backend/ai-engine/tests/test_causal_recorder.py`
- `synthi/src/app/api/shadow/__tests__/causalRecorder.test.js`

### Phase 3: Snapshot Capture

Create:

- `ai-backend/ai-engine/causal/snapshot.py`
- `ai-backend/ai-engine/causal/fingerprint.py`
- `ai-backend/ai-engine/causal/snapshot_store.py`

Touch:

- `ai-backend/ai-engine/shadow/snapshot.py`
- `backend/collab-server/workspaceManager.js`
- `backend/collab-server/gitService.js`

Purpose:

- Capture file hashes, git state, dependency lockfile hashes, runtime image ids, env fingerprints, and test/build command metadata.
- Store snapshots as content-addressed manifests rather than copied trees by default.
- Deduplicate unchanged files and dependency layers across replays.
- Reuse existing shadow snapshot ideas but separate causal snapshot contracts from patch-apply mechanics.

Tests:

- `ai-backend/ai-engine/tests/test_causal_snapshot.py`
- `ai-backend/ai-engine/tests/test_causal_snapshot_store.py`
- `backend/collab-server/__tests__/causalSnapshotMetadata.test.js`

### Phase 4: Twin Materializer

Create:

- `ai-backend/ai-engine/causal/twin.py`
- `ai-backend/ai-engine/causal/worktree_materializer.py`
- `ai-backend/ai-engine/causal/side_effects.py`

Touch:

- `ai-backend/ai-engine/shadow/worktree.py`
- `ai-backend/ai-engine/shadow/runner/base.py`
- `ai-backend/ai-engine/shadow/runner/node.py`
- `ai-backend/ai-engine/shadow/runner/python.py`

Purpose:

- Materialize an isolated twin from a causal snapshot.
- Allow controlled mutations: patch rollback, config override, env override, feature flag override.
- Default all external side effects to deny or mock.

Tests:

- `ai-backend/ai-engine/tests/test_causal_twin.py`
- `ai-backend/ai-engine/tests/test_causal_side_effects.py`

### Phase 5: Replay API

Create:

- `ai-backend/ai-engine/causal/api.py`
- `ai-backend/ai-engine/causal/replay.py`
- `ai-backend/ai-engine/causal/oracles.py`
- `ai-backend/ai-engine/causal/reproduction.py`
- `synthi/src/app/api/causal/replay/route.js`
- `synthi/src/app/api/causal/[incidentId]/stream/route.js`

Touch:

- `ai-backend/ai-engine/main.py`
- `synthi/src/lib/internalAiAuth.js`

Purpose:

- Add API to start a replay, stream progress, and fetch proof artifacts.
- Support verify-only, incident replay, and one counterfactual replay.
- Implement first oracles: tests, typecheck, lint, runtime probe, route status, console error count.
- Compute reproduction confidence before running counterfactual claims.
- Refuse to advance past `causal-replay-diverged` when base replay confidence is below threshold.

Tests:

- `ai-backend/ai-engine/tests/test_causal_replay_api.py`
- `ai-backend/ai-engine/tests/test_causal_oracles.py`
- `ai-backend/ai-engine/tests/test_causal_reproduction.py`
- `synthi/src/app/api/causal/__tests__/replayRoutes.test.js`

### Phase 6: Causal Diff Engine

Create:

- `ai-backend/ai-engine/causal/graph.py`
- `ai-backend/ai-engine/causal/counterfactual.py`
- `ai-backend/ai-engine/causal/diff.py`
- `ai-backend/ai-engine/causal/reporter.py`

Purpose:

- Build candidate causal graph from event links.
- Rank recent changes and user hypotheses.
- Run counterfactual batches.
- Produce proof-backed causal diff report.

Tests:

- `ai-backend/ai-engine/tests/test_causal_graph.py`
- `ai-backend/ai-engine/tests/test_causal_counterfactual.py`
- `ai-backend/ai-engine/tests/test_causal_diff.py`

### Phase 7: UI

Create:

- `synthi/src/components/causal/CausalDiffPanel.jsx`
- `synthi/src/components/causal/CausalChain.jsx`
- `synthi/src/components/causal/CounterfactualRunList.jsx`
- `synthi/src/components/causal/ProofStateBadge.jsx`
- `synthi/src/components/causal/hooks/useCausalReplay.js`
- `synthi/src/components/causal/causal.css`

Touch:

- `synthi/src/components/chat/AIChatWindow.jsx`
- `synthi/src/components/chat/MultiverseCard.jsx`
- `synthi/src/components/analysis/ProvenanceOverlay.jsx`

Purpose:

- Show Causal Diff as a proof panel attached to shadow jobs, provenance records, and incidents.
- Make proof state visually explicit.
- Show blocked/degraded evidence without hiding it.

Tests:

- `synthi/src/components/causal/__tests__/CausalDiffPanel.test.jsx`

### Phase 8: Persistence And Retention

Create:

- `synthi/prisma/migrations/<timestamp>_causal_ledger/migration.sql`
- `synthi/src/lib/causal-store.js`

Touch:

- `synthi/prisma/schema.prisma`
- `ai-backend/ai-engine/causal/ledger.py`

Purpose:

- Persist incidents, events, snapshots, replay jobs, and proof artifacts.
- Add workspace-scoped retention.
- Add redaction status and access-control fields.

Tests:

- `synthi/src/lib/__tests__/causal-store.test.js`
- `ai-backend/ai-engine/tests/test_causal_persistent_ledger.py`

### Phase 9: Deployment Metadata Integration

Create:

- `ai-backend/ai-engine/causal/deployments.py`

Touch:

- `cloudbuild.yaml`
- `cloudrun/*.service.yaml`
- `scripts/deploy-prod.sh`
- `k8s/*.yaml` only if runtime labels/annotations are needed

Purpose:

- Attach build artifact digests, deploy ids, Cloud Run revision ids, Kubernetes image ids, and rollout timestamps to causal events.
- Keep this metadata passive at first.

Tests:

- focused parser/unit tests for deployment metadata extraction

### Phase 10: Evaluation Harness

Create:

- `ai-backend/ai-engine/causal/bench/__init__.py`
- `ai-backend/ai-engine/causal/bench/harness.py`
- `ai-backend/ai-engine/causal/bench/fixtures/`
- `ai-backend/ai-engine/causal/bench/report.py`

Purpose:

- Test whether Causal Diff identifies known injected counterfactual relationships.
- Measure replay reproducibility, counterfactual accuracy, proof-state honesty, and latency.

Acceptance metrics:

- base replay reproduction rate >= 80% on first fixture set
- false proven-claim rate = 0
- counterfactual result consistency >= 90% for deterministic fixtures
- every degraded run reports a specific degraded state

## API Sketch

### POST `/causal/incident`

Creates or updates an incident.

```json
{
  "workspace_id": "ws_...",
  "title": "Latency spike after deploy",
  "symptom": {
    "kind": "latency",
    "metric": "p95",
    "window": {
      "start": "2026-06-21T14:03:00Z",
      "end": "2026-06-21T14:12:00Z"
    }
  },
  "hypotheses": [
    "deploy:rev_123",
    "config:queue.autoscale.threshold",
    "feature_flag:new_fanout"
  ]
}
```

### POST `/causal/replay`

Starts a replay or counterfactual.

```json
{
  "incident_id": "inc_...",
  "base_snapshot_id": "snap_...",
  "mode": "incident_replay",
  "window": {
    "start": "2026-06-21T14:03:00Z",
    "duration_seconds": 300
  },
  "changed_inputs": [],
  "oracles": ["tests", "runtime_health", "route_status", "console_errors"]
}
```

### POST `/causal/counterfactuals`

Runs a counterfactual batch.

```json
{
  "incident_id": "inc_...",
  "base_replay_id": "replay_...",
  "counterfactuals": [
    {
      "id": "without_deploy",
      "changed_inputs": [
        { "kind": "deploy", "id": "rev_123", "state": "absent" }
      ]
    },
    {
      "id": "lower_queue_threshold",
      "changed_inputs": [
        { "kind": "config", "path": "queue.autoscale.threshold", "value": 55 }
      ]
    }
  ]
}
```

### GET `/causal/incident/{id}/diff`

Returns the causal diff report.

```json
{
  "incident_id": "inc_...",
  "proof_state": "causal-prevention-proven",
  "confidence": 92,
  "coverage": 73,
  "replay_envelope_id": "env_...",
  "chain": [],
  "counterfactuals": [],
  "smallest_preventing_change": {},
  "degraded_reasons": [],
  "artifact_refs": []
}
```

## UI Model

The first UI should be a compact proof panel, not a dashboard.

Entry points:

- from a shadow verification job
- from a provenance record
- from a failed build/runtime probe
- from a deploy/release event

Panel structure:

```text
Causal Diff

Symptom
  p95 route latency crossed 800ms during replay window.

Replay envelope
  Included code, deps, tests, runtime probe, console events.
  Excluded production DB writes and external billing API body.

Counterfactual chain
  Deploy D -> feature flag F -> fanout 6.4x -> queue Q saturated -> autoscaler late.

Counterfactuals
  Without deploy D: prevented, but reintroduces bug B.
  Flag F disabled: prevented.
  Queue threshold 55%: prevented with smallest blast-radius.

Proof
  State: causal-prevention-proven
  Confidence: 92%
  Coverage: 73%
  Base replay: reproduced
  Side effects: mocked
  Unknowns: external billing API response body redacted

Action
  Generate guardrail patch
  Add recurrence test
  Export postmortem
```

## Implementation Order

1. Land this plan as the canonical doc.
2. Implement schemas, proof states, and in-memory ledger.
3. Wire recorder to provenance and shadow verification events.
4. Capture causal snapshots from existing shadow/worktree infrastructure.
5. Materialize a twin from a snapshot and run verify-only replay.
6. Add one counterfactual mutation: "without this patch."
7. Generate first causal diff report.
8. Add UI panel.
9. Persist ledger.
10. Add snapshot dedupe and retention policies.
11. Add deploy metadata.
12. Expand counterfactual types only inside Vectant-controlled runtime state.
13. Build eval harness and fixtures.

## First Vertical Slice

Goal:

Prove whether removing an accepted AI patch would have prevented a reproduced regression under a declared replay envelope.

Scope:

- one workspace
- one accepted patch
- one shadow/provenance chain
- one test/runtime failure
- one twin materialized from pre-patch snapshot
- two replays:
  - base: with patch
  - counterfactual: without patch

Output:

```text
Under replay envelope E, patch P was necessary for failure F.
Removing patch P prevented F in the counterfactual replay.
Proof state: causal-effect-observed.
Confidence: 91%.
Coverage: 68%.
Not yet minimality-proven because no alternate patches were tested.
```

Files for first vertical slice:

- `ai-backend/ai-engine/causal/types.py`
- `ai-backend/ai-engine/causal/proof.py`
- `ai-backend/ai-engine/causal/envelope.py`
- `ai-backend/ai-engine/causal/confidence.py`
- `ai-backend/ai-engine/causal/ledger.py`
- `ai-backend/ai-engine/causal/recorder.py`
- `ai-backend/ai-engine/causal/snapshot.py`
- `ai-backend/ai-engine/causal/snapshot_store.py`
- `ai-backend/ai-engine/causal/twin.py`
- `ai-backend/ai-engine/causal/replay.py`
- `ai-backend/ai-engine/causal/reproduction.py`
- `ai-backend/ai-engine/causal/api.py`
- `ai-backend/ai-engine/main.py`
- `ai-backend/ai-engine/provenance.py`
- `ai-backend/ai-engine/shadow/api.py`
- `ai-backend/ai-engine/shadow/events.py`
- `synthi/src/app/api/causal/replay/route.js`
- `synthi/src/components/causal/CausalDiffPanel.jsx`

## Security And Privacy

Hard requirements:

- Never record raw secrets.
- Redact environment values by default; store only names, hashes, and allowlisted non-secret values.
- Keep causal events workspace-scoped.
- Treat external API payloads as sensitive.
- Require explicit policy for durable traffic/body replay.
- Mark proof as degraded when redaction removes required evidence.
- Block side effects by default in twin replays.
- Record who requested replay and who can view artifacts.

Redaction layers:

- env redaction
- log redaction
- trace attribute redaction
- request/response body redaction
- screenshot/artifact retention policy
- per-workspace retention cap

## Economic Model

Causal Diff should not start as a standalone observability company. The cleanest value capture is:

```text
Vectant verification platform
  base: shadow verification, provenance, runtime proof
  premium: Causal Diff counterfactual replay
```

Packaging options:

- Per workspace: included replay quota, overage billed by replay-minute.
- Per incident: paid incident bundle with N replays and retained proof artifacts.
- Enterprise: annual contract with dedicated retention, audit exports, and higher concurrency.
- Developer/team tier: small included quota to make the feature habit-forming.

Recommended first pricing model:

- Causal Diff is a premium feature on top of Synthi Genome / Shadow Verification.
- Charge by workspace seat plus replay compute quota.
- Meter expensive dimensions internally even if not exposed immediately:
  - twin materialization minutes
  - replay runtime minutes
  - stored snapshot bytes
  - retained proof artifact bytes
  - LLM planner/reporter tokens

The business value is not generic incident management. It is reducing the risk of AI-generated and fast-moving software changes by making post-change proof executable.

## Cost Controls

The cost moat is also the product risk.

Controls:

- record only metadata by default
- sample high-volume telemetry
- promote from summary to payload only around incident windows
- dedupe by content hash
- use content-addressed source snapshots instead of full copied worktrees
- use layered filesystem snapshots when running twins in containers
- share dependency installs and package caches by lockfile hash
- garbage-collect unreferenced twin layers aggressively
- cap retained snapshots per workspace and per branch
- compress trace/log bundles
- set retention tiers
- put replay jobs behind explicit budgets
- cap concurrent twins per workspace
- stream progress and allow cancellation
- show estimated replay cost before running deep counterfactual batches

## Risks

| Risk | Mitigation |
|---|---|
| Recording cost explodes | Start with workspace/change metadata; incident-window payload escalation only. |
| Snapshot storage explodes | Use content-addressed worktrees, layered snapshots, dependency-cache reuse, and retention caps from the first implementation. |
| Replay does not reproduce | Make `causal-replay-diverged`, reproduction confidence, and symptom-match details first-class results. |
| AI overclaims causality | AI can propose hypotheses only; proof states come from replay/oracle gates. |
| External side effects are unsafe | Default to mock/deny egress; require explicit connectors. |
| Privacy blocks evidence | Report `causal-privacy-redacted` and reduce proof state. |
| Database fidelity is too low | Start with code/runtime/test replay; add DB read/write summaries later. |
| Product sounds like observability wrapper | Lead with fork/replay/prove, not dashboards or chat. |
| Cloud simulation distracts from wedge | Treat IAM/DNS/queue/autoscaler replay as distant roadmap until AI-change replay has usage and revenue. |

## Success Criteria

The first version is successful if:

- A user can select an accepted patch or failed shadow job and run Causal Diff.
- The system captures a pre/post snapshot and proof artifact.
- The system materializes an isolated twin.
- The base replay reproduces a test/runtime failure for at least one fixture.
- The counterfactual replay without the patch changes the outcome.
- The report includes replay envelope, confidence, and coverage.
- The system reports replay divergence honestly when reproduction fails.
- The report clearly states proven, suggested, and degraded claims.
- No AI-only claim is presented as proof.
- Snapshot storage is deduplicated by content hash before any multi-user rollout.

The mature version is successful if:

- Postmortems become executable.
- Recurrence checks run against current code/config.
- The smallest safe preventive change can be proven, not guessed.
- Software-change operations move from "observe after damage" to "counterfactual diagnosis."
