# CodeSite Air Traffic Control Plan

**Status:** revised product and implementation plan  
**Date:** 2026-06-25  
**Working name:** CodeSite  
**Primary model:** air traffic control for AI coding agents  
**Secondary layer:** construction-grade permits, inspections, and handover evidence

---

## 1. Executive Positioning

The first CodeSite plan had the right enforcement primitives, but the wrong visible metaphor.

Construction is useful for legal control:

- permits
- inspections
- change orders
- punch lists
- handover packets

But construction is slow, document-heavy, and too close to enterprise workflow software. If CodeSite presents itself mainly as a construction site, it risks feeling like Jira with better vocabulary.

The more novel product model is:

> CodeSite is air traffic control for AI coding agents.

The repo is controlled airspace.

Agents are aircraft.

Tasks are flight plans.

Branches and worktrees are runways.

Shared files, APIs, schemas, auth, billing, and migrations are restricted airspace.

The orchestrator is the tower.

Tests and inspectors are radar.

Conflicts are near-misses.

Handover packets are black boxes.

The pitch:

> CodeSite lets many AI agents work in one repo without collision by issuing clearances, predicting conflicts, enforcing no-fly zones, inspecting landings, and replaying every near-miss.

That is the core product. Construction remains the legal layer underneath.

---

## 2. Why This Is More Defensible

The crowded baseline is real:

- GitHub Agent HQ already supports Claude, Codex, Copilot, and other agents in GitHub, VS Code, issues, PRs, and session views.
- Codex already supports parallel cloud tasks and isolated worktrees.
- Claude Code already has subagents, hooks, skills, MCP, permissions, and repo-local instructions.
- A2A already targets cross-vendor agent communication.

So CodeSite should not claim novelty from "multi-agent coordination."

CodeSite should claim:

> Enforced live mutation control for concurrent AI work in a repo.

The product should not be:

```text
Claude is chatting with Codex.
```

It should be:

```text
Tower rerouted Codex because Claude entered shared schema airspace.
```

That sounds like infrastructure.

---

## 2A. Technical Core: Transaction Manager For Codebases

ATC is the product surface. The real architecture should be a transaction manager for AI-generated code mutations.

The senior-engineer sentence:

> CodeSite gives AI agents serializable isolation over a shared repo.

The internal architecture:

```text
MVCC repo snapshots
+ capability security
+ semantic dependency tracking
+ assumption invalidation
+ filesystem-level mutation enforcement
+ invariant checks
+ proof-carrying commits
+ causal replay
```

This is the leap from "agent dashboard with permissions" to infrastructure.

### 2A.1 Mutation Transactions

Agents should not merely receive a lease. They should work inside a transaction.

```json
{
  "transaction_id": "txn_claude_signup_ui",
  "snapshot": "repo@sha256:abc",
  "read_set": [
    "packages/schemas/auth/signup.ts",
    "api/auth/signup.ts"
  ],
  "write_set": [
    "apps/web/signup/page.tsx",
    "components/auth/SignupForm.tsx"
  ],
  "invariants": [
    "auth.signup.contract.compatible",
    "frontend.typecheck.pass",
    "no.secret.exposure"
  ],
  "isolation": "serializable"
}
```

At landing, CodeSite checks:

- did the read set change?
- did another agent mutate a semantic dependency?
- did an assumption expire?
- do invariants still hold?
- can this transaction commit safely?

If not, CodeSite blocks commit, rebases, reroutes, or asks for inspection.

### 2A.2 Assumption Leases

Agents constantly reason from assumptions. CodeSite should track those assumptions as first-class leases.

Example:

```json
{
  "assumption_id": "asm_signup_payload_v1",
  "agent": "CLAUDE-17",
  "depends_on": "auth.signup.schema@v1",
  "used_by": ["SignupForm.tsx", "clientValidation.ts"],
  "invalidated_by": "auth.signup.schema@v2"
}
```

When Codex changes the schema, Tower says:

```text
CLAUDE-17 grounded: stale assumption auth.signup.schema@v1.
Rebase required before further writes.
```

This solves stale reads, not just write conflicts.

### 2A.3 CodeSiteFS

Do not rely on agents voluntarily using a patch API.

Every managed agent should run behind a filesystem layer:

```text
read-only repo base
+ per-agent writable overlay
+ MutationLease enforcement
+ transaction read/write set capture
+ illegal-write quarantine
+ process-tree provenance
```

If an agent runs:

```bash
python -c 'open("api/auth/signup.ts","w").write("bad")'
```

CodeSiteFS blocks or quarantines before the real repo changes:

```text
Write denied at filesystem boundary.
Reason: frontend MutationLease cannot mutate Class A auth API.
Process: python <- bash <- claude-cli
IncidentReplay event recorded.
```

This turns CodeSite from a dashboard into a control plane.

### 2A.4 Proof-Carrying Commits

Every agent-produced commit should carry a portable proof bundle.

```text
CodeSite-Transaction: txn_codex_auth_001
CodeSite-Lease: lease_backend_auth_001
CodeSite-Read-Set: sha256:...
CodeSite-Write-Set: sha256:...
CodeSite-Invariants: typecheck:pass, api-contract:pass, security:pass
CodeSite-Black-Box: sha256:...
```

The reviewer can verify provenance outside the CodeSite UI.

### 2A.5 Shadow Merge Simulator

Before launching agents, simulate coordination strategies:

- frontend/backend parallel
- schema-first
- backend-first
- single fullstack agent
- test-first

Use real signals:

- predicted read/write sets
- import graph
- test ownership
- schema ownership
- migration locks
- prior incidents
- expected inspection cost

Example output:

```text
Selected: schema-first
Reason:
- 0 predicted stale assumptions
- 1 shared contract lock
- 42 percent lower rework risk
- auth test suite owned by backend route
```

### 2A.6 Line-Level Causal Provenance

Click any changed line and show:

```text
Line added by: CODEX-04
Transaction: txn_backend_auth_001
Lease: lease_auth_class_A
Reason: RFI rfi_signup_display_name accepted
Evidence: auth.signup.test.ts passed
Inspector: API contract radar passed
Prompt segment: redacted summary only
Process ancestry: codex-cli -> apply_patch
```

Senior engineers hate unexplained AI diffs. This answers:

> Why does this line exist?

### 2A.7 Repo Policy Compiler

Do not require users to hand-write all rules.

Compile policy from:

```text
CODEOWNERS
+ OpenAPI
+ Prisma migrations
+ package exports
+ import graph
+ test graph
+ deployment config
+ secret patterns
+ past incidents
= MutationZone policy
```

Example:

```text
Detected Class A:
- db/migrations
- auth middleware
- billing webhook
- production infra

Detected Class B:
- shared schemas
- generated clients
- package exports
```

The product surface can call this airspace detection. Internally it is a policy compiler.

### 2A.8 Brutal Demo

The demo that proves CodeSite is infrastructure:

1. Claude starts frontend from `auth.signup.v1`.
2. Codex changes auth schema to `auth.signup.v2`.
3. CodeSite invalidates Claude's assumption before stale UI code lands.
4. Claude tries to edit `api/auth` through raw terminal.
5. CodeSiteFS blocks the write at the filesystem boundary.
6. Tower reroutes schema-first.
7. Shadow merge simulation passes.
8. Commit lands with proof bundle.
9. Reviewer clicks a line and sees causal provenance.

That is not a wrapper.

That is a transaction layer for AI-generated code changes.

---

## 2B. Why This Is Hard To Copy

The moat is not the ATC metaphor. The moat is enforced mutation infrastructure across every way an agent can change a repo.

A copyable version looks like:

```text
agent dashboard + permissions + logs + clever wording
```

The defensible version looks like:

```text
repo policy compiler
+ CodeSiteFS write boundary
+ serializable MutationTransactions
+ AssumptionLease invalidation
+ Dojo proof and evidence references
+ counterfactual incident learning
+ agent-native event protocol
+ proof-carrying commits
```

That requires deep integration points competitors cannot fake with prompts:

- all write surfaces must route through one mutation control plane
- terminal and runtime sessions must carry transaction identity
- raw filesystem writes must be blocked, quarantined, or captured before commit
- repo policy must compile from code ownership, imports, tests, contracts, migrations, infra, secrets, and prior incidents
- agent competence must come from proof and evidence, not static role labels
- cross-user agent coordination must preserve user boundaries and redact private context
- incident replay must be causal, not a transcript dump
- proof bundles must be portable outside the UI

The product should be judged by one brutal question:

> Can an untrusted agent mutate a protected file outside its lease?

If the answer is yes, CodeSite is a workflow wrapper. If the answer is no, CodeSite is infrastructure.

## 2C. Agent-Friendly Control Plane

CodeSite must be agent-friendly, not only human-friendly.

Humans see radar. Agents should see stable contracts.

Every CodeSite state transition should be available through machine-readable surfaces:

- MCP tools for CLI/cloud agents
- HTTP APIs for hosted agents
- SSE/WebSocket event streams for live sessions
- repo-local JSON/JSONL projection under `.synthi/codesite/`
- JSON schemas for flight plans, clearances, transactions, assumptions, documents, inspections, incidents, and proof bundles
- digest-addressed evidence refs for replay and verification

No critical state should exist only in the UI.

Agent happy path:

1. Register `AgentSession` with owner user, workspace, runtime, provider, tool list, and Dojo license refs.
2. Read `control-state.json` or poll `synthi_codesite_get_radar`.
3. File an `ExecutionPlan`.
4. Request a `MutationLease`.
5. Open a `MutationTransaction`.
6. Read and write only through CodeSiteFS, patch tools, or transaction-aware runtime mounts.
7. Record assumptions as they are used.
8. Emit transponder events while working.
9. Request inspection.
10. Validate and request commit.
11. Receive proof bundle, punch list, or reroute instruction.

Minimal agent-readable control state:

```json
{
  "project_id": "site_signup_email_verification",
  "agent_session_id": "ags_codex_04",
  "callsign": "CODEX-04",
  "tower_state": "holding",
  "active_execution_plan_id": "ep_backend_auth_001",
  "active_mutation_lease_id": "lease_backend_auth_001",
  "active_transaction_id": "txn_backend_auth_001",
  "allowed_paths": ["api/auth/**", "tests/auth/**"],
  "blocked_paths": ["db/migrations/**", "packages/schemas/**"],
  "required_actions": [
    "ack_event:evt_schema_landed",
    "rebase_assumption:asm_signup_payload_v1"
  ],
  "inbox_url": "/api/workspace/acme/codesite/agent-sessions/ags_codex_04/inbox",
  "events_since": "evt_439"
}
```

Agents should be able to participate correctly with no browser open.

---

## 3. Repo Reality Check

The repo already has strong substrate for CodeSite, but not the ATC product layer.

### Existing Foundations

| Area | Existing substrate | CodeSite ATC use |
|---|---|---|
| Dojo licenses and proof | `mcp/synthi-mcp/src/browser/dojo.ts`, `dojo_license_kernel.ts`, `docs/AGENT_DOJO_IMPLEMENTATION_STATUS.md` | Pilot certification, clearance eligibility, proof-backed inspections |
| Agent Cortex graph runtime | `mcp/synthi-mcp/src/dojo/graph/runtime.ts`, Cortex graph/checkride stores | Evidence-emitting preflight, landing, and competence workflows |
| MCP skill bus | `mcp/synthi-mcp/src/dojo/mcp/skill_bus.ts` | Only expose licensed agent actions |
| Evidence ledger | `mcp/synthi-mcp/src/dojo/evidence/*` | Black-box record, near-miss replay, landing evidence |
| Graph/checkride persistence | `mcp/synthi-mcp/src/dojo/store/postgres_graph_run_store.ts` | Competence history and recurrent route risk |
| Terminal/runtime | `backend/collab-server/terminalService.js`, `runtimePodTerminal.js`, `programRuntimeManager.js` | Clearance-bound terminal sessions and command telemetry |
| Collaboration and presence | `SessionManager.js`, `permissionMiddleware.js`, Yjs worker, SSE | Live radar state, human tower/inspector presence |
| Program runtime events | `ProgramSession`, `ProgramRuntimeEvent` in Prisma | Runtime radar and landing logs |
| Shadow verification | `ai-backend/ai-engine/shadow/api.py`, chat Multiverse/Arbiter UI | Detector stack, alternate routing, near-miss evidence |
| MCP audit | `McpCallAudit` in Prisma | Tool-call telemetry |
| Repo-local handoff | `agentWorkflowHandoff.js` | `.synthi/codesite/` black-box and closeout artifacts |

### Missing ATC Layer

There is no current domain model for:

- flight plans
- clearances
- airspace classes
- no-fly zones
- restricted zones
- holding patterns
- route deconfliction
- collision prediction
- mayday events
- near-miss reports
- black-box replay
- landing inspections
- live radar map
- CodeSiteFS overlay enforcement
- serializable mutation transactions
- assumption invalidation
- proof-carrying commits
- line-level causal provenance

Existing collaboration permissions are coarse:

```text
canEdit
canTerminal
canGit
canFileOps
```

CodeSite needs fine-grained, time-boxed, path-scoped, risk-scoped, contract-aware clearances.

### 3A. What Exists Today

CodeSite should reuse the existing systems as substrate, not pretend they are already the finished CodeSite layer.

#### Dojo, Cortex, and Vivarium

The Dojo/Cortex/Vivarium stack is the strongest existing foundation for clearance eligibility and evidence-backed trust.

Current useful substrate:

- Dojo implementation status already classifies checkrides, Vivarium scenario runs, Wind Tunnel, Evil Twin, proof capsule issue/validate/revoke, hosted runtime sessions, and proof-gated dispatch as executable with runtime scopes.
- Proof capsules already carry evidence claims, ledger checkpoint hashes, substrate claims, tenant context, expiry, nonce/signature, and proof records.
- The Dojo license kernel already blocks replay, revocation, workspace/origin mismatch, approval gaps, and evidence mismatch.
- Agent Cortex/Dojo graph runtime emits evidence events and supports proof validator hooks.
- Vivarium and checkride runners can materialize fixtures, execute synthetic scenarios, run oracle evidence, and append ledger records.
- Source snapshot/drift code tracks source tokens and can expire licenses on source drift.
- Dojo Postgres migrations already cover skills, graphs, licenses, proof records, source snapshots/tokens, evidence records, checkride/scenario runs, runtime sessions, and audit events.

Critical maturity boundary:

```text
Dojo is executable proof/checkride substrate.
CodeSite must not treat current Dojo tools as deployed production mutation authority.
```

The plan should use Dojo like this:

```text
DojoLicenseKernelDecision
  -> CodeSite PolicyDecision
  -> MutationLease
  -> MutationTransaction
  -> CodeSiteFS enforcement
  -> ProofBundle / IncidentReplay
```

`MutationLease.dojoProofRef` should store:

- proof capsule id
- license id/version
- ledger checkpoint hash
- evidence record ids
- validation decision digest
- implementation-status metadata

This answers the user's question directly:

> The Clearance Kernel is not the same thing as a Dojo proof capsule. It is the CodeSite policy layer that consumes Dojo proof capsules and binds them to live repo mutation leases.

Dojo proves competence and evidence. CodeSite decides whether that competence may mutate this repo state, in this zone, at this moment, alongside other active agents.

#### Shadow, Counterfactual, and Regret Memory

The repo already has shadow verification and replay primitives, but not a unified CodeSite `IncidentReplay`.

Current useful substrate:

- `ai-backend/ai-engine/shadow/*` supports multiverse runs, worktree snapshots, universe evidence, Arbiter verdicts, apply/cancel flows, cost tracking, preference examples, and regression logs.
- Shadow preference memory records accepted universe diff shape, Arbiter winner/override hints, and style/provider preferences.
- Proactive healing memory tracks accepted/rejected/modified fix patterns and can suppress consistently rejected rule IDs.
- Repair transactions snapshot files, apply patch sets, verify, commit, rollback, and aggregate rollback reasons.
- Existing provenance records prompt/model/hash/verifier/accepted status and exposes overlay/API surfaces.
- Broker replay, CI replay, shadow regression replay, and next-edit replay are fragmented but valuable replay precedents.
- Dojo Evil Twin extracts workflow/runtime assumptions and maps escaped attacks to hardening suggestions.

Boundary:

```text
Existing shadow memory is preference and repair feedback.
CodeSite needs transaction/assumption/near-miss learning.
```

Do not overclaim Regret Memory. Treat it as a future policy engine rooted in a `CounterfactualRun` or `ShadowChoiceScene`, not as already implemented infrastructure.

The first CodeSite counterfactual object should wrap:

- shadow job id
- repo snapshot
- universes attempted
- evidence refs
- Arbiter verdict
- user-visible choices
- apply/cancel/override result
- later manual rewrites
- validity strength
- resulting policy delta candidates

This lets Shadow Merge Simulator learn from actual coordination outcomes instead of only static heuristics.

#### Terminal, Runtime, and Collaboration

The runtime/collab substrate is real, but API wrapping alone is not enough.

Current useful substrate:

- `terminalService.js` supports PTY sessions, detach/reattach buffers, headless sessions, runtime environment injection, and shell selection.
- `runtimePodTerminal.js`, `runtimePodSpec.js`, and `workspaceRuntimeContainer.js` provide pod/container execution surfaces.
- `programRuntimeManager.js` tracks live runtime state, output buffers, health, ports, starts/stops, and command execution.
- `ProgramSession` and `ProgramRuntimeEvent` persistence can attach mutation transaction ids to launches, execs, outputs, and port events.
- `SessionManager.js`, `permissionMiddleware.js`, SSE, notifications, and Yjs already support multi-user collaboration and permission checks.
- Yjs flush/invalidation and filesystem watcher services can support transaction-aware reconciliation.
- `gitService.safeWriteFile`, batch writes, and shadow patch apply are practical MVP hooks for pre-write policy checks.
- MCP source/program tools and Dojo `patch_writer` already provide stale-source checks, atomic writes, bundle validation, and verification patterns.

Boundary:

```text
Out-of-band terminal writes are currently detected after the fact.
CodeSiteFS must eventually prevent or quarantine them before real repo mutation.
```

Implementation implication:

- first wrap all collab-server mutation APIs in `MutationTransaction`
- normalize path containment across write, batch write, create directory, rename, delete, sync, conflict, scaffold, Yjs flush, MCP patch, and shadow apply
- attach transaction ids to terminal/runtime/program events
- add a runtime mount or sidecar strategy for terminal writes
- reserve FUSE/overlay/fanotify/eBPF-style enforcement for the mature CodeSiteFS layer

#### Source and Line Provenance

Current source provenance exists at source-token and AI-call levels. It is not yet line-causal provenance for agent-produced commits.

CodeSite should bridge:

```text
changed line anchor
  -> transaction write-set hunk
  -> agent session
  -> MutationLease
  -> RFI/change-order/inspection reason
  -> Dojo source token or graph node when available
  -> proof bundle
  -> evidence ledger refs
```

That turns existing provenance from "which AI call happened" into "why this line exists and what proof allowed it to land."

### 3B. Integration Rule

Do not fork existing substrate when a reference is enough.

CodeSite records should cross-reference existing Dojo ids, evidence ledger ids, runtime session ids, program event ids, MCP audit ids, shadow job ids, and source token ids.

The CodeSite layer should own:

- live mutation policy
- path/tool/contract scoped leases
- serializable transaction validation
- assumption invalidation
- cross-user agent session routing
- pre-write filesystem enforcement
- causal incident replay
- proof bundle assembly
- line-level causal provenance

---

## 4. Core Vocabulary

The product should use ATC language. The implementation should use sober engineering names.

Do not overuse aviation terms in database tables, API route names, or core service names. Engineers should see serious control-plane primitives, not a cute metaphor.

| Product surface | Internal primitive |
|---|---|
| Flight plan | `ExecutionPlan` |
| Clearance | `MutationLease` |
| Tower decision | `PolicyDecision` |
| Radar finding | `InspectionSignal` |
| Landing | `InspectionRun` |
| Near-miss / black box | `IncidentReplay` |
| Airspace zone | `MutationZone` |
| Transponder event | `AgentTelemetryEvent` |

| Air Traffic Control | CodeSite |
|---|---|
| Controlled airspace | Repository |
| Aircraft | Agent session or human contributor |
| Pilot | Agent identity plus model/runtime |
| Flight plan | Proposed task route through repo zones |
| Tower | Orchestrator/control-plane agent |
| Clearance | Time-boxed permission to mutate paths/tools/contracts |
| Runway | Branch, worktree, patch overlay, runtime session |
| Taxiing | Reading, planning, preflight, dependency install |
| Takeoff | First permitted mutation |
| Cruise | Active work under clearance |
| Holding pattern | Waiting on RFI, schema lock, inspector, or human |
| Restricted airspace | Shared schema, auth, billing, DB migrations, infra |
| No-fly zone | Paths/tools/commands blocked for an agent |
| Altitude | Trade/domain level: frontend, backend, schema, db, infra |
| Radar | Tests, typecheck, runtime probes, git diff, inspectors |
| Transponder | Agent heartbeat and current intent/path |
| TCAS | Collision prediction and avoidance recommendations |
| Mayday | Emergency risk declaration |
| Near-miss | Prevented or detected collision/conflict |
| Landing | Agent requests inspection and merge readiness |
| Black box | Full replayable evidence packet |

Construction layer mapping:

| Construction primitive | ATC layer role |
|---|---|
| Work permit | Legal backing for a clearance |
| RFI | Structured tower question |
| Change order | Flight-plan amendment for scope/contract changes |
| Inspection | Landing check |
| Stop-work order | Ground stop or clearance revocation |
| Punch list | Post-landing defects |
| Handover packet | Black box plus as-built closeout |

---

## 5. New Core Primitive: Flight Plan

Before an agent works, it files a flight plan.

```json
{
  "flight_plan_id": "fp_claude_signup_form_001",
  "agent": "Claude",
  "callsign": "CLAUDE-17",
  "mission": "Build signup form",
  "route": ["apps/web/signup/**", "components/auth/**"],
  "altitude": "frontend",
  "no_fly_zones": ["api/**", "db/**", "packages/schemas/auth/**"],
  "estimated_duration": "45m",
  "handoff_needed": ["backend-auth"],
  "abort_conditions": [
    "schema change required",
    "tests red",
    "shared contract touched"
  ],
  "requested_tools": ["read_file", "apply_patch", "npm_test", "screenshot"],
  "landing_requirements": ["typecheck", "ui_screenshot", "accessibility"]
}
```

The tower can:

- approve
- reroute
- delay
- split
- merge with another flight
- put in holding pattern
- deny
- require higher pilot license
- require an inspector escort

Flight-plan statuses:

```text
filed -> preflight -> cleared -> taxiing -> airborne -> holding
  -> rerouted -> landing_requested -> landed -> closed
  -> denied | aborted | grounded | mayday
```

The clearance is the enforceable token generated from an approved flight plan.

---

## 6. Clearance, MutationLease, and Dojo Proof Capsules

The user-facing word is clearance. The internal object should be `MutationLease`.

This is related to Dojo proof capsules, but it is not the same layer.

Dojo proof capsule:

- proves a skill/tool/action is licensed
- binds action to a Dojo skill, license version, evidence claims, guardrails, substrate, expiry, nonce, and signature
- answers: "Is this agent/tool allowed to perform this kind of action under this skill license?"

CodeSite `MutationLease`:

- grants temporary rights to mutate specific repo zones for a specific project
- binds an agent session to paths, tools, contracts, time, owner user, nearby agents, and inspection requirements
- answers: "May this agent mutate this repo state right now without colliding with other active work?"

The correct architecture is:

```text
DojoLicenseKernelDecision -> capability and evidence proof
CodeSite PolicyDecision -> allow, block, hold, reroute, inspect, or revoke
CodeSite MutationLease -> live repo mutation capability
CodeSite MutationTransaction -> isolated code change attempt
CodeSiteFS -> filesystem boundary enforcement
```

CodeSite should consume Dojo proof capsules as one input to clearance decisions. It should not duplicate Dojo's proof system.

The Clearance Kernel is therefore the CodeSite policy/decision kernel around live repo mutation. It should verify Dojo proof capsules, but it must also evaluate path scope, time scope, repo snapshot, transaction isolation, current collision risk, workspace membership, owner-user permissions, contract zones, and inspection requirements.

Store Dojo proof as references, not copied blobs:

```json
{
  "dojo_proof_ref": {
    "proof_capsule_id": "pcap_backend_auth_l2_001",
    "license_id": "backend.auth.level_2",
    "license_version": "2026-06-25.1",
    "ledger_checkpoint_hash": "sha256:...",
    "evidence_record_ids": ["ev_checkride_01", "ev_vivarium_09"],
    "validation_decision_digest": "sha256:...",
    "implementation_status": {
      "executable": true,
      "production_runtime": false
    }
  }
}
```

This makes the maturity boundary explicit in every clearance decision.

The strongest product primitive is the policy engine that evaluates a `MutationLease` and returns a `PolicyDecision`.

Inputs:

- callsign
- pilot/agent identity
- owner user
- Dojo license snapshot
- optional Dojo proof capsule
- flight plan
- mutation lease
- current route
- current path/tool/command
- airspace class
- nearby flights
- contract zones affected
- radar findings
- current time

Output:

```json
{
  "ok": false,
  "status": "blocked",
  "blocked_by": [
    "entered_no_fly_zone",
    "shared_contract_requires_clearance"
  ],
  "tower_instruction": "Hold position and file change order for packages/schemas/auth."
}
```

This is where CodeSite becomes real infrastructure.

Prompts do not enforce discipline. The policy engine does.

### Enforcement Points

The policy engine should eventually sit in front of:

- file writes
- patch apply
- Yjs save path
- scaffold writes
- terminal sessions
- program runtime launches
- git operations
- MCP tool calls
- shadow apply
- branch/PR creation

MVP enforcement can start with:

- CodeSite-managed patch apply
- terminal session tagging
- post-write diff patrol
- formal near-miss reports when an agent writes outside clearance

Mature enforcement blocks before mutation.

---

## 7. Airspace Classes

Airspace classes solve the ceremony problem.

Not every repo area needs the same control.

```json
{
  "airspace_classes": [
    {
      "class": "A",
      "label": "Critical controlled airspace",
      "paths": ["api/auth/**", "billing/**", "db/migrations/**", "infra/prod/**"],
      "rules": [
        "explicit_tower_clearance_required",
        "licensed_pilot_required",
        "inspector_signoff_required",
        "black_box_required"
      ]
    },
    {
      "class": "B",
      "label": "Shared contract airspace",
      "paths": ["packages/schemas/**", "openapi/**", "packages/*/src/index.ts"],
      "rules": [
        "flight_plan_required",
        "downstream_notification_required",
        "change_order_for_mutation"
      ]
    },
    {
      "class": "C",
      "label": "Feature implementation airspace",
      "paths": ["apps/web/**", "components/**"],
      "rules": [
        "auto_clearance_allowed",
        "landing_inspection_required"
      ]
    },
    {
      "class": "D",
      "label": "Low-risk support airspace",
      "paths": ["docs/**", "tests/**"],
      "rules": [
        "micro_clearance_allowed",
        "sample_inspection"
      ]
    }
  ]
}
```

Class A examples:

- auth
- billing
- permissions
- db migrations
- production infra
- secrets/config

Class B examples:

- shared packages
- API schemas
- public exports
- generated clients
- design tokens

Class C examples:

- feature UI
- local route handlers
- non-shared components

Class D examples:

- docs
- tests
- fixtures
- examples

This makes CodeSite feel sharp instead of bureaucratic.

---

## 8. Killer UI: Radar, Not Kanban

The main UI should look and feel like radar over a repo graph.

Example:

```text
CALLSIGN     POSITION                  STATUS       INSTRUCTION
CLAUDE-17    frontend/signup            cleared      ETA 12m
CODEX-04     api/auth                   holding      waiting on schema
TEST-02      tests/auth                 inspecting   3 failures
SCHEMA-ZONE  packages/schemas/auth      restricted   clearance required
SEC-01       api/auth                   radar        weak password finding
```

Visual states:

- green: cleared and clean
- blue: active flight
- yellow: holding
- orange: conflict risk
- red: grounded, mayday, failed landing
- purple: restricted/shared airspace
- gray: no active clearance

Radar layers:

- repo tree
- dependency graph
- active flights
- planned routes
- no-fly zones
- restricted airspace
- collision risk arcs
- inspector/radar findings
- runway/worktree occupancy
- landings and black boxes

The product should show motion:

- agents moving through file zones
- risk cones ahead of overlapping routes
- holding patterns around restricted files
- landing sequence through inspectors
- replay traces after incidents

This is more memorable than a task board.

---

## 9. Collision Prediction

Collision prediction should move from a later feature to the center of the product.

Before agents edit, CodeSite predicts conflict:

```text
Collision risk: high

Claude and Codex both need packages/schemas/auth.

Recommended tower action:
1. Freeze frontend flight.
2. Launch schema-agent first.
3. Reissue frontend/backend clearances after contract lock.
```

Inputs:

- planned routes
- current diffs
- import graph
- ownership zones
- API/schema dependencies
- migration history
- active terminal commands
- tests likely affected
- recent near-misses
- Regret Memory policy hints when available

Collision classes:

| Collision | Example | Tower response |
|---|---|---|
| File collision | two agents edit same file | sequence or split hunks |
| Contract collision | backend changes payload while frontend builds old shape | schema-first route |
| Migration collision | two agents create migrations | single runway lock |
| Runtime collision | one agent changes dev server/start command | hold runtime inspector |
| Test collision | test agent evaluates stale code | rerun after landing |
| Semantic collision | two agents implement same feature differently | choose lead flight |
| Permission collision | agent tries restricted path | block and require clearance |

Collision prediction is the main "wow" feature because it solves a real concurrency problem before it becomes a PR conflict.

---

## 10. TCAS: Traffic Collision Avoidance

The tower should not only warn. It should propose avoidance maneuvers.

Examples:

```json
{
  "risk": "contract_collision",
  "severity": "high",
  "aircraft": ["CLAUDE-17", "CODEX-04"],
  "conflict_zone": "packages/schemas/auth/**",
  "recommended_resolution": {
    "action": "schema_first",
    "steps": [
      "Put CLAUDE-17 in holding",
      "Issue SCHEMA-01 clearance for auth schema",
      "Notify frontend and backend",
      "Reissue clearances with schema version auth.signup.v2"
    ]
  }
}
```

Avoidance maneuvers:

- reroute
- hold
- split route
- reduce scope
- sequence flights
- require schema-first flight
- create temporary compatibility layer
- switch runway/worktree
- call inspector before mutation
- ground one agent

---

## 11. Black Box Replay

Every failed or risky run should be replayable.

The black box is an `IncidentReplay`: an append-only causal event stream plus evidence refs. It should be backed by the existing Dojo evidence ledger where possible, with CodeSite-specific event kinds layered on top.

Near-miss example:

```text
Near miss:
- Backend changed signup schema without frontend clearance.
- Frontend kept old payload.
- API contract inspector caught drift.

Replay:
T+00: CLAUDE-17 filed frontend flight.
T+08: CODEX-04 requested schema clearance.
T+12: Tower failed to notify frontend.
T+19: Contract inspector blocked merge.

Policy delta:
For auth signup, schema route must land before frontend/backend flights continue.
```

Black box contents:

- flight plan
- clearance
- transaction open/validate/commit/abort events
- declared and observed read/write sets
- assumptions recorded and invalidated
- CodeSiteFS write attempts, denied writes, and quarantines
- route and no-fly zones
- tool calls
- file writes
- terminal commands
- diffs by timestamp
- shadow run and Arbiter verdict refs
- inspector results
- RFI/change order decisions
- tower instructions
- radar/collision predictions
- actual collision or near-miss
- policy delta
- proof bundle digest
- evidence ledger refs

Repo-local storage:

```text
.synthi/codesite/
  flights/
    CLAUDE-17/
      flight-plan.json
      clearance.json
      transponder.log.jsonl
      black-box.json
  near-misses/
    nm_signup_schema_drift_001.json
  handovers/
    signup-email-verification.md
```

Black box replay is not "logs." It is a causally ordered incident record.

Minimum event kinds:

```text
transaction.opened
assumption.recorded
clearance.issued
write.attempted
write.denied
snapshot.taken
shadow.run
arbiter.verdict
inspection.result
near_miss.detected
policy_delta.proposed
transaction.committed
transaction.aborted
```

---

## 12. Mayday Mode

Agents can declare mayday when they detect unsafe conditions.

```json
{
  "type": "mayday",
  "callsign": "CODEX-04",
  "reason": "migration destructive",
  "requested_action": "freeze all db flights",
  "evidence": "DROP COLUMN detected in migration 20260625_remove_user_email.sql",
  "affected_airspace": ["db/migrations/**", "api/auth/**"]
}
```

Tower response:

1. Freeze affected airspace.
2. Snapshot repo/worktree state.
3. Suspend related clearances.
4. Launch migration/security inspector.
5. Open incident black box.
6. Require human tower approval to resume.

Mayday types:

- destructive migration
- secret exposure
- auth bypass
- contract drift
- production infra touch
- unexplained test collapse
- conflicting generated migrations
- agent loops or repeated violations

This makes CodeSite feel alive and safety-critical.

---

## 13. Tower Voice

The product voice matters.

Avoid:

```text
Claude asked Codex a question.
Codex is waiting.
Agent collaboration started.
```

Use:

```text
Tower put CODEX-04 in holding: schema airspace is restricted.
CLAUDE-17 cleared for frontend/signup until 14:20 UTC.
TEST-02 detected unstable landing: 3 auth tests failed.
SCHEMA-ZONE requires clearance before mutation.
SEC-01 issued ground stop for auth flights: weak password policy.
```

This changes the user's mental model from chat coordination to live operational control.

---

## 14. Pilot Licenses

Dojo becomes the pilot certification layer.

An agent can only receive certain clearances if it has the right license.

```json
{
  "pilot": "Codex",
  "license": "backend.auth.level_2",
  "repo_scope": "synthi-ide",
  "authorized_airspace": ["api/auth/**", "db/auth_migrations/**"],
  "restricted_airspace": ["billing/**", "infra/prod/**"],
  "earned_by": [
    "passed auth checkride",
    "completed 3 inspected auth flights",
    "0 critical clearance violations in last 30 days"
  ],
  "requires_radar": ["security", "api_contract", "migration"],
  "expires_on": ["source_drift", "security_incident", "90_days"]
}
```

License levels:

| Level | Meaning |
|---|---|
| Student | May read, draft, and propose flight plans |
| VFR | May work in Class C/D with auto-clearance |
| IFR | May work in Class B with tower monitoring |
| Type-rated | May work in specific Class A zones |
| Captain | May lead multi-agent route segments |
| Grounded | No mutation clearance |

This integrates cleanly with Dojo's existing entrustment, proof, checkride, and evidence model.

---

## 15. Landings and Inspections

Agents do not finish. They request landing.

```json
{
  "landing_request_id": "land_codex_auth_001",
  "callsign": "CODEX-04",
  "flight_plan_id": "fp_backend_auth_001",
  "changed_paths": ["api/auth/signup.ts", "tests/auth/signup.test.ts"],
  "requested_runway": "feature/signup-email-verification",
  "required_radar": ["typecheck", "unit_tests", "api_contract", "security"],
  "evidence_refs": ["runtime:event:abc", "test:auth_signup", "dojo:evidence:def"]
}
```

Landing statuses:

- cleared to land
- go around
- landed with punch items
- failed landing
- grounded

Inspectors are radar systems:

| Radar/Inspector | Checks |
|---|---|
| Clearance radar | diff stayed inside clearance |
| Type radar | typecheck and schema compatibility |
| Test radar | unit, integration, e2e |
| API radar | contract drift and downstream compatibility |
| Security radar | auth, secrets, injection, rate limits |
| Migration radar | rollback, destructive changes, ordering |
| UI radar | screenshots, responsive, visual drift |
| Accessibility radar | labels, keyboard, contrast |
| Runtime radar | starts, health, ports, logs |
| Performance radar | bundle/query/latency budgets |
| Handover radar | packet completeness |

---

## 16. Legal Layer: Construction Primitives

Keep construction vocabulary underneath ATC because it maps to governance.

| Legal/governance object | ATC object |
|---|---|
| Work permit | Clearance |
| RFI | Tower query |
| Change order | Flight-plan amendment |
| Inspection | Landing radar |
| Stop-work order | Ground stop |
| Punch list | Post-landing defects |
| Handover packet | Black box closeout |

This gives enterprise buyers the governance they need without making the visible product feel like workflow software.

---

## 17. Automatic Workflow

User asks:

```text
Build signup with email verification.
```

CodeSite runs:

1. **Airspace survey**
   - scan repo zones
   - classify auth, db, schemas, UI, tests
   - detect restricted airspace

2. **Tower plan**
   - infer missions
   - create initial flight plans
   - identify route intersections
   - predict collision risk

3. **Route deconfliction**
   - schema zone predicted as shared
   - tower launches schema flight first or locks schema airspace
   - frontend/backend flights wait or get read-only schema route

4. **Clearance issuance**
   - CLAUDE-17 cleared for frontend signup UI
   - CODEX-04 cleared for auth endpoint
   - EMAIL-03 cleared for email template/provider adapter
   - TEST-02 queued as landing radar
   - SEC-01 watches auth class A airspace

5. **Active radar**
   - agents send transponder updates
   - tower watches planned vs actual paths
   - collision prediction updates live

6. **Reroute**
   - backend needs `displayName`
   - CODEX-04 requests schema clearance
   - tower holds frontend, opens change order, updates route

7. **Mayday / stop if needed**
   - destructive migration or secret exposure freezes related flights

8. **Landing**
   - agents request inspection
   - radar stack runs
   - failed checks become go-around or punch items

9. **Black box handover**
   - reviewer gets one packet with route, collisions avoided, changes, tests, inspections, decisions, risks

---

## 18. Data Model Sketch

Add CodeSite models to `synthi/prisma/schema.prisma`, using internal control-plane names.

```prisma
model CodeSiteProject {
  id              String   @id @default(cuid())
  workspaceSlug   String
  title           String
  request         String
  status          String
  zonePolicyJson  String
  controlPlanJson String
  createdByUserId String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  agentSessions   CodeSiteAgentSession[]
  executionPlans  CodeSiteExecutionPlan[]
  mutationLeases  CodeSiteMutationLease[]
  mutationTxns     CodeSiteMutationTransaction[]
  assumptions      CodeSiteAssumptionLease[]
  policyDecisions CodeSitePolicyDecision[]
  events          CodeSiteEvent[]
  incidents       CodeSiteIncident[]
  inspectionRuns  CodeSiteInspectionRun[]
  proofBundles     CodeSiteProofBundle[]
  lineProvenance   CodeSiteLineProvenance[]
  documents       CodeSiteDocument[]
  counterfactualRuns CodeSiteCounterfactualRun[]
  policyDeltas    CodeSitePolicyDelta[]

  @@index([workspaceSlug])
  @@index([status])
}

model CodeSiteMutationZone {
  id             String   @id @default(cuid())
  workspaceSlug  String
  zoneKey        String
  label          String
  class          String
  pathsJson      String
  rulesJson      String
  risk           String
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([workspaceSlug, zoneKey])
  @@index([workspaceSlug])
  @@index([class])
}

model CodeSiteAgentSession {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  ownerUserId     String
  agentProvider   String
  agentRuntime    String?
  providerSessionRef String?
  displayCallsign String
  status          String
  permissionsJson String
  redactionPolicyJson String?
  createdAt       DateTime @default(now())
  endedAt         DateTime?

  executionPlans  CodeSiteExecutionPlan[]
  mutationLeases  CodeSiteMutationLease[]
  mutationTxns     CodeSiteMutationTransaction[]

  @@index([projectId])
  @@index([ownerUserId])
  @@index([displayCallsign])
  @@index([status])
}

model CodeSiteExecutionPlan {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  agentSessionId  String
  agentSession    CodeSiteAgentSession @relation(fields: [agentSessionId], references: [id], onDelete: Cascade)
  displayCallsign String
  mission         String
  domain          String
  status          String
  routeJson       String
  blockedZonesJson String
  abortJson       String
  requestedToolsJson String
  estimatedDurationMs Int?
  filedAt         DateTime @default(now())
  closedAt        DateTime?

  mutationLeases  CodeSiteMutationLease[]
  inspectionRuns  CodeSiteInspectionRun[]

  @@index([projectId])
  @@index([agentSessionId])
  @@index([displayCallsign])
  @@index([status])
}

model CodeSiteMutationLease {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  executionPlanId String
  executionPlan   CodeSiteExecutionPlan @relation(fields: [executionPlanId], references: [id], onDelete: Cascade)
  agentSessionId  String
  agentSession    CodeSiteAgentSession @relation(fields: [agentSessionId], references: [id], onDelete: Cascade)
  displayCallsign String
  status          String
  leaseJson       String
  dojoProofRef    String?
  dojoLicenseRef  String?
  dojoEvidenceRefsJson String?
  dojoLedgerCheckpointHash String?
  dojoDecisionDigest String?
  implementationStatusJson String?
  issuedAt        DateTime @default(now())
  expiresAt       DateTime?
  revokedAt       DateTime?

  events          CodeSiteEvent[]
  policyDecisions CodeSitePolicyDecision[]
  mutationTxns     CodeSiteMutationTransaction[]

  @@index([projectId])
  @@index([executionPlanId])
  @@index([agentSessionId])
  @@index([displayCallsign])
  @@index([status])
}

model CodeSiteMutationTransaction {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  mutationLeaseId String
  mutationLease   CodeSiteMutationLease @relation(fields: [mutationLeaseId], references: [id], onDelete: Cascade)
  agentSessionId  String
  agentSession    CodeSiteAgentSession @relation(fields: [agentSessionId], references: [id], onDelete: Cascade)
  baseSnapshot     String
  isolation        String   // serializable | repeatable_read | read_committed
  status           String
  readSetJson      String
  observedReadSetJson String?
  writeSetJson     String
  observedWriteSetJson String?
  semanticDependencyRefsJson String?
  invariantsJson   String
  assumptionRefsJson String
  commitDecisionJson String?
  proofBundleDigest String?
  openedAt         DateTime @default(now())
  closedAt         DateTime?

  proofBundles     CodeSiteProofBundle[]
  lineProvenance   CodeSiteLineProvenance[]

  @@index([projectId])
  @@index([mutationLeaseId])
  @@index([agentSessionId])
  @@index([status])
  @@index([openedAt])
}

model CodeSiteAssumptionLease {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  ownerSessionId  String
  displayCallsign String
  assumptionKey   String
  dependsOnJson   String
  usedByJson      String
  status          String   // active | invalidated | released
  invalidatedBy   String?
  invalidatedAt   DateTime?
  createdAt       DateTime @default(now())

  @@index([projectId])
  @@index([ownerSessionId])
  @@index([assumptionKey])
  @@index([status])
}

model CodeSitePolicyDecision {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  mutationLeaseId String?
  mutationLease   CodeSiteMutationLease? @relation(fields: [mutationLeaseId], references: [id], onDelete: SetNull)
  displayCallsign String?
  decision        String   // allow | block | hold | reroute | inspect | revoke
  reasonCodesJson String
  inputDigest     String
  decisionJson    String
  createdAt       DateTime @default(now())

  @@index([projectId])
  @@index([mutationLeaseId])
  @@index([displayCallsign])
  @@index([decision])
  @@index([createdAt])
}

model CodeSiteProofBundle {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  transactionId   String
  transaction     CodeSiteMutationTransaction @relation(fields: [transactionId], references: [id], onDelete: Cascade)
  commitSha       String?
  readSetDigest   String
  writeSetDigest  String
  invariantsJson  String
  evidenceRefsJson String
  dojoEvidenceRefsJson String?
  incidentReplayDigest String?
  bundleDigest    String
  createdAt       DateTime @default(now())

  @@index([projectId])
  @@index([transactionId])
  @@index([commitSha])
  @@index([bundleDigest])
}

model CodeSiteLineProvenance {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  transactionId   String
  transaction     CodeSiteMutationTransaction @relation(fields: [transactionId], references: [id], onDelete: Cascade)
  filePath        String
  lineAnchor      String
  displayCallsign String
  reasonRef       String?
  evidenceRefsJson String
  dojoSourceRefsJson String?
  proofBundleId   String?
  processAncestryJson String?
  promptSummary   String?
  createdAt       DateTime @default(now())

  @@index([projectId])
  @@index([transactionId])
  @@index([filePath])
  @@index([displayCallsign])
}

model CodeSiteInspectionRun {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  executionPlanId String?
  executionPlan   CodeSiteExecutionPlan? @relation(fields: [executionPlanId], references: [id], onDelete: SetNull)
  displayCallsign String
  status          String
  changedPathsJson String
  inspectionSignalsJson String
  evidenceRefsJson String
  requestedAt     DateTime @default(now())
  completedAt     DateTime?

  @@index([projectId])
  @@index([executionPlanId])
  @@index([displayCallsign])
  @@index([status])
}

model CodeSiteIncident {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  severity        String
  category        String
  participantsJson String
  affectedZonesJson String
  incidentReplayJson String
  replayDigest    String?
  timelineEventRefsJson String?
  policyDeltaJson String?
  evidenceRefsJson String
  createdAt       DateTime @default(now())

  @@index([projectId])
  @@index([severity])
  @@index([category])
}

model CodeSiteDocument {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  kind            String   // rfi | change_order | submittal | mayday | stop_work | punch
  status          String
  title           String
  bodyJson        String
  blocking        Boolean @default(false)
  createdAt       DateTime @default(now())
  resolvedAt      DateTime?

  @@index([projectId])
  @@index([kind])
  @@index([status])
}

model CodeSiteEvent {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  mutationLeaseId String?
  mutationLease   CodeSiteMutationLease? @relation(fields: [mutationLeaseId], references: [id], onDelete: SetNull)
  eventType       String
  displayCallsign String?
  actorType       String?
  actorId         String?
  detailsJson     String
  evidenceRefsJson String?
  createdAt       DateTime @default(now())

  @@index([projectId])
  @@index([mutationLeaseId])
  @@index([displayCallsign])
  @@index([createdAt])
}

model CodeSiteCounterfactualRun {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  shadowJobRef    String?
  baseSnapshot    String
  universesJson   String
  arbiterVerdictJson String?
  userChoiceJson  String?
  laterManualEditsJson String?
  validityStrength String
  evidenceRefsJson String
  createdAt       DateTime @default(now())

  @@index([projectId])
  @@index([shadowJobRef])
  @@index([validityStrength])
}

model CodeSitePolicyDelta {
  id              String   @id @default(cuid())
  projectId       String
  project         CodeSiteProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  learnedFromIncidentsJson String
  affectedZoneKey String?
  ruleCandidateJson String
  triggerConditionsJson String
  expectedRiskReduction Float?
  confidence      Float
  promotionState  String   // proposed | shadowed | promoted | rejected
  replayRefsJson  String
  createdAt       DateTime @default(now())
  promotedAt      DateTime?

  @@index([projectId])
  @@index([affectedZoneKey])
  @@index([promotionState])
}
```

This sketch should not duplicate Dojo or shadow tables. It should reference their durable ids:

- Dojo proof capsule id
- Dojo license id/version
- Dojo evidence ledger record ids
- Dojo source token ids
- hosted runtime session id
- program runtime event id
- MCP audit id
- shadow job/universe ids
- git commit sha
- repo snapshot digest

The CodeSite tables own the live mutation/control-plane state around those refs.

---

## 19. API Surface

Initial internal routes:

```text
POST   /api/workspace/[slug]/codesite/projects
GET    /api/workspace/[slug]/codesite/projects
GET    /api/workspace/[slug]/codesite/projects/[projectId]

POST   /api/workspace/[slug]/codesite/projects/[projectId]/zone-policy
POST   /api/workspace/[slug]/codesite/projects/[projectId]/control-plan
POST   /api/workspace/[slug]/codesite/projects/[projectId]/agent-sessions
POST   /api/workspace/[slug]/codesite/projects/[projectId]/execution-plans
POST   /api/workspace/[slug]/codesite/execution-plans/[executionPlanId]/mutation-leases
POST   /api/workspace/[slug]/codesite/mutation-leases/[mutationLeaseId]/transactions
GET    /api/workspace/[slug]/codesite/transactions/[transactionId]
GET    /api/workspace/[slug]/codesite/transactions/[transactionId]/status
POST   /api/workspace/[slug]/codesite/transactions/[transactionId]/preview
POST   /api/workspace/[slug]/codesite/transactions/[transactionId]/dry-run-patch
POST   /api/workspace/[slug]/codesite/transactions/[transactionId]/record-read
POST   /api/workspace/[slug]/codesite/transactions/[transactionId]/record-write
POST   /api/workspace/[slug]/codesite/transactions/[transactionId]/validate
POST   /api/workspace/[slug]/codesite/transactions/[transactionId]/commit
POST   /api/workspace/[slug]/codesite/transactions/[transactionId]/abort
POST   /api/workspace/[slug]/codesite/transactions/[transactionId]/assumptions
GET    /api/workspace/[slug]/codesite/transactions/[transactionId]/source-state-since
POST   /api/workspace/[slug]/codesite/mutation-leases/[mutationLeaseId]/policy-decisions
POST   /api/workspace/[slug]/codesite/mutation-leases/[mutationLeaseId]/revoke

POST   /api/workspace/[slug]/codesite/projects/[projectId]/collision-predict
POST   /api/workspace/[slug]/codesite/projects/[projectId]/shadow-merge-simulate
GET    /api/workspace/[slug]/codesite/projects/[projectId]/control-state
GET    /api/workspace/[slug]/codesite/projects/[projectId]/events
GET    /api/workspace/[slug]/codesite/projects/[projectId]/events/stream
GET    /api/workspace/[slug]/codesite/projects/[projectId]/agent-manifest
GET    /api/workspace/[slug]/codesite/projects/[projectId]/schemas
GET    /api/workspace/[slug]/codesite/agent-sessions/[agentSessionId]/inbox
POST   /api/workspace/[slug]/codesite/agent-sessions/[agentSessionId]/inbox/[eventId]/ack

POST   /api/workspace/[slug]/codesite/projects/[projectId]/documents
POST   /api/workspace/[slug]/codesite/projects/[projectId]/incidents
POST   /api/workspace/[slug]/codesite/projects/[projectId]/policy-deltas
POST   /api/workspace/[slug]/codesite/projects/[projectId]/counterfactual-runs
POST   /api/workspace/[slug]/codesite/projects/[projectId]/inspection-runs
POST   /api/workspace/[slug]/codesite/inspection-runs/[inspectionRunId]/complete

GET    /api/workspace/[slug]/codesite/provenance/line
GET    /api/workspace/[slug]/codesite/proof-bundles/[bundleId]
POST   /api/workspace/[slug]/codesite/projects/[projectId]/incident-replays
GET    /api/workspace/[slug]/codesite/incidents/[incidentId]/replay
```

MCP tools should expose product language while internally calling the control-plane routes:

```text
synthi_codesite_file_flight_plan
synthi_codesite_request_clearance
synthi_codesite_open_transaction
synthi_codesite_get_transaction_status
synthi_codesite_preview_transaction
synthi_codesite_dry_run_patch
synthi_codesite_record_assumption
synthi_codesite_record_read
synthi_codesite_record_write
synthi_codesite_validate_transaction
synthi_codesite_request_commit
synthi_codesite_get_source_state_since
synthi_codesite_get_radar
synthi_codesite_next_event
synthi_codesite_ack_event
synthi_codesite_predict_collision
synthi_codesite_shadow_merge_simulate
synthi_codesite_report_counterfactual_run
synthi_codesite_file_rfi
synthi_codesite_file_change_order
synthi_codesite_declare_mayday
synthi_codesite_request_landing
synthi_codesite_generate_black_box
synthi_codesite_get_line_provenance
```

Important implementation rule:

```text
The collab-server write surfaces and MCP patch surfaces must call the same MutationTransaction service.
```

This includes git write APIs, Yjs flushes, scaffold writes, conflict operations, shadow apply, MCP patch writes, and runtime exec-declared writes.

---

## 20. Agent Event Protocol

Agents emit structured events, not free-form cross-agent chat.

Allowed event types:

- `flight_plan_filed`
- `clearance_requested`
- `clearance_issued`
- `transaction_opened`
- `transaction_validated`
- `transaction_committed`
- `transaction_aborted`
- `assumption_recorded`
- `assumption_invalidated`
- `write_attempted`
- `write_allowed`
- `write_denied`
- `write_quarantined`
- `snapshot_taken`
- `transponder_update`
- `route_deviation`
- `holding_pattern`
- `tower_instruction`
- `rfi`
- `change_order`
- `mayday`
- `ground_stop`
- `landing_requested`
- `radar_result`
- `inspection_result`
- `shadow_run`
- `arbiter_verdict`
- `near_miss`
- `policy_delta_proposed`
- `black_box_closed`

Example transponder update:

```json
{
  "type": "transponder_update",
  "callsign": "CLAUDE-17",
  "project_id": "site_signup_email_verification",
  "clearance_id": "clr_frontend_signup_001",
  "position": "apps/web/signup/page.tsx",
  "intent": "editing client validation",
  "next_paths": ["components/auth/SignupForm.tsx"],
  "status": "airborne"
}
```

Minimum replay event shape:

```json
{
  "event_id": "evt_441",
  "project_id": "site_signup_email_verification",
  "transaction_id": "txn_backend_auth_001",
  "agent_session_id": "ags_codex_04",
  "display_callsign": "CODEX-04",
  "type": "write_denied",
  "logical_time": 441,
  "wall_time": "2026-06-25T15:42:19Z",
  "zone_key": "auth_api",
  "path": "api/auth/signup.ts",
  "policy_decision_id": "pd_998",
  "evidence_refs": ["ev_codesitefs_denied_001"],
  "details": {
    "reason": "frontend lease cannot mutate Class A auth API",
    "process_ancestry": ["python", "bash", "claude-cli"]
  }
}
```

`IncidentReplay` should be rebuilt from these events plus evidence refs, not from a free-form transcript.

---

## 21. Multi-User Agent Sessions

CodeSite must coordinate agents from different users, not only many sessions spawned by the same user.

Target scenario:

```text
Alice launches Claude for frontend.
Ben launches Codex for backend.
Priya launches a security inspector agent.
The agents need to coordinate inside the same repo project without sharing private credentials, prompts, or unrestricted write authority.
```

Each agent session must be bound to:

- owner user
- workspace membership and role
- agent provider/runtime
- available credentials and secrets
- allowed MCP connections
- Dojo licenses available to that user/agent pair
- active `ExecutionPlan`
- active `MutationLease`
- audit identity

Agents from different users should be able to talk, but only through tower-mediated structured channels:

- RFI
- change order
- submittal
- inspection request
- incident/mayday
- handoff note
- explicit tower message

They should not get an unstructured shared chat where one user's agent can exfiltrate another user's context or secretly negotiate scope.

Communication rules:

- every cross-agent message has source owner user and destination owner user
- every message is visible to the tower and project members with permission
- every message references a project, execution plan, mutation zone, contract, or inspection
- secrets and raw local prompts are never forwarded across users
- a receiving user can approve, deny, mute, or restrict their agent's participation
- user-owned agents inherit only that user's workspace permissions

The existing collaboration system already has host/guest session concepts and coarse permissions. CodeSite should extend that into agent-aware project coordination:

```text
Human user -> AgentSession -> ExecutionPlan -> MutationLease -> PolicyDecision
```

This is the real multiplayer version of CodeSite.

The connection mechanism is:

```text
workspace membership
  -> CodeSite project membership
  -> user-owned AgentSession registration
  -> tower-issued ExecutionPlan
  -> MutationLease
  -> project event stream
  -> per-agent inbox
```

Two unrelated users' agents never connect by sharing process memory or provider sessions. They connect by subscribing to the same project event stream under separate ACLs. The tower turns each RFI, change order, inspection result, mayday, or handoff into a durable `CodeSiteDocument`, redacts it, routes it to permitted recipients, and writes an inbox item each recipient agent can poll or receive over SSE/WebSocket.

This is the product answer to "how do different users' agent sessions talk together?":

```text
They do not talk peer-to-peer.
They exchange tower-mediated project documents with ACL, redaction, audit, and lease impact.
```

### 21.1 Agent Session Bus

Build this as a workspace-scoped agent session bus, not peer-to-peer agent chat.

```text
User -> AgentSession -> CodeSite Project -> Tower/Event Bus -> Other AgentSession
```

Each agent belongs to a real workspace user:

```ts
type AgentSession = {
  id: string
  workspaceSlug: string
  projectId: string
  ownerUserId: string
  provider: "claude" | "codex" | "copilot" | "custom"
  runtime: "cloud" | "local" | "cli" | "mcp" | "a2a"
  displayCallsign: string
  permissions: string[]
  activeExecutionPlanId?: string
  activeMutationLeaseId?: string
}
```

Agents communicate through CodeSite, not directly.

Core services:

```text
AgentSessionRegistry
ProjectEventBus
DocumentRouter
PolicyDecisionEngine
AgentInbox
RedactionAclLayer
MutationLeaseEnforcer
```

### 21.2 Registration

When a user starts an agent in a shared workspace:

1. CodeSite creates a `CodeSiteAgentSession`.
2. The session is bound to the owner user and workspace membership.
3. CodeSite records provider/runtime, available tools, MCP connections, Dojo licenses, and current project.
4. The tower issues or denies an `ExecutionPlan`.
5. The policy engine issues a `MutationLease` only if the user-owned agent is allowed to work in that zone.

Example:

```text
Alice -> CLAUDE-17 -> frontend ExecutionPlan -> frontend MutationLease
Ben -> CODEX-04 -> backend ExecutionPlan -> backend MutationLease
Priya -> SEC-01 -> inspection ExecutionPlan -> read-only inspection MutationLease
```

### 21.3 Shared Project Channel

Each CodeSite project has a durable project event stream:

```text
CodeSiteEvent
CodeSiteDocument
CodeSitePolicyDecision
CodeSiteIncident
CodeSiteInspectionRun
```

Live delivery can use WebSocket/SSE. Durable history should live in Postgres. Repo-local projection can be written under `.synthi/codesite/` for CLI agents and review.

### 21.4 Tower-Mediated Messages

Agents do not DM each other freely. They send structured documents through the tower.

Example RFI:

```json
{
  "type": "rfi",
  "from_session": "CLAUDE-17",
  "to_session": "CODEX-04",
  "from_user": "alice",
  "to_user": "ben",
  "question": "Can signup payload include displayName?",
  "affected_zone": "packages/schemas/auth/**",
  "blocking": true
}
```

The tower validates, records, routes, and broadcasts it according to project ACLs.

Allowed cross-agent communication:

- RFI
- RFI answer
- change order
- submittal
- inspection request
- inspection result
- mayday/incident
- handoff note
- explicit tower instruction

Disallowed by default:

- raw free-form group chat
- hidden agent-to-agent direct messages
- private prompt sharing
- secret or credential forwarding
- workspace-unrelated memory sharing

### 21.5 Permission and Redaction Gate

Before delivering any cross-agent message, CodeSite checks:

- both users are workspace members
- both agent sessions are joined to the project
- sender can contact recipient in this project
- the message references a project object such as an `ExecutionPlan`, `MutationZone`, contract, incident, or inspection
- affected zones are visible to both users
- message body does not include secrets, raw private prompts, local environment variables, API keys, or unapproved attachments
- recipient user has not disabled or restricted agent-to-agent participation

Security principle:

```text
Agents share project documents, not private conversations.
```

Alice's Claude should not see Ben's raw prompt, API keys, local CLI history, or unrelated session memory. It only sees tower-approved coordination artifacts.

### 21.6 Agent Inbox

Different agents have different connectivity, so use an inbox model.

Delivery modes:

- browser agents receive WebSocket/SSE events
- CLI agents poll with MCP, for example `synthi_codesite_next_event`
- cloud agents receive task comments, webhooks, or provider-specific callbacks
- A2A agents use an adapter when available
- fallback writes structured inbox files under `.synthi/codesite/projects/<project>/inbox/<agentSessionId>/`

Minimal inbox item:

```json
{
  "event_id": "evt_123",
  "project_id": "site_signup_email_verification",
  "recipient_session": "CODEX-04",
  "recipient_user": "ben",
  "kind": "rfi",
  "requires_response": true,
  "document_id": "doc_rfi_signup_display_name",
  "created_at": "2026-06-25T00:00:00Z"
}
```

### 21.7 Reply Flow

1. CLAUDE-17 files an RFI to CODEX-04.
2. `DocumentRouter` validates ACLs and redacts unsafe fields.
3. `ProjectEventBus` records `CodeSiteDocument` and `CodeSiteEvent`.
4. `AgentInbox` delivers the item to CODEX-04.
5. CODEX-04 replies with a structured RFI answer or change order.
6. Tower updates project state, affected `ExecutionPlan`s, and `MutationLease`s.
7. All affected sessions receive a project event.

This gives agents from unrelated users a way to coordinate without giving them uncontrolled access to each other.

---

## 22. Regret Memory as Future ATC Policy

Regret Memory is not fully implemented today. Treat it as a future policy engine.

Existing shadow and healing systems provide useful signals, but they are not enough:

- accepted shadow universes are preferences, not proof that rejected universes were bad
- cancelled branches are ambiguous; non-applied does not equal rejected
- local repair rollback is not repo-wide serializable mutation control
- current provenance is AI-call provenance, not line-level causal provenance

So the CodeSite root object should be a `CounterfactualRun`, not a per-branch regret capsule.

`CounterfactualRun` should capture a complete choice scene:

```json
{
  "counterfactual_run_id": "cfr_signup_schema_route_001",
  "repo_snapshot": "repo@sha256:abc",
  "shadow_job_ref": "shadow_job_991",
  "choices": [
    {
      "universe": "schema-first",
      "result": "passed",
      "inspection_cost": 3,
      "stale_assumptions": 0
    },
    {
      "universe": "frontend-backend-parallel",
      "result": "near_miss",
      "inspection_cost": 8,
      "stale_assumptions": 2
    }
  ],
  "arbiter_verdict": "schema-first",
  "human_override": null,
  "later_manual_edits": [],
  "validity_strength": "strong"
}
```

Use it to learn:

- which flight splits reduced collisions
- which airspace classes were too strict or too loose
- which inspectors caught real issues
- which near-misses recur
- which tower reroutes saved work
- which agents violate clearances
- which schema-first policies reduce rework
- which black-box patterns should become new airspace rules

Future policy delta:

```json
{
  "policy_delta_id": "delta_auth_schema_first",
  "learned_from_incidents": ["near_miss_signup_schema_drift_001", "near_miss_profile_payload_002"],
  "affected_zone": "packages/schemas/auth/**",
  "rule_candidate": "For auth signup work, issue schema clearance before frontend/backend clearances.",
  "trigger_conditions": ["frontend route reads auth.signup", "backend route mutates auth.signup"],
  "expected_risk_reduction": 0.42,
  "confidence": 0.82,
  "promotion_state": "proposed"
}
```

This is where CodeSite becomes smarter with each controlled run.

---

## 23. Repo-Local Artifacts

Use `.synthi/codesite/`.

```text
.synthi/codesite/
  manifest.json
  schemas/
    execution-plan.schema.json
    mutation-lease.schema.json
    mutation-transaction.schema.json
    assumption-lease.schema.json
    document.schema.json
    event.schema.json
    proof-bundle.schema.json
  airspace/
    zones.json
    no-fly-zones.json
    class-rules.json
  projects/
    signup-email-verification/
      tower-plan.json
      control-state.json
      events.jsonl
      radar-snapshot.json
      collision-forecast.json
      policy-decisions/
        pd_backend_clearance_001.json
      flights/
        CLAUDE-17/
          flight-plan.json
          clearance.json
          transaction.json
          assumptions.json
          transponder.jsonl
          landing.json
          black-box.json
        CODEX-04/
          flight-plan.json
          clearance.json
          transaction.json
          assumptions.json
          transponder.jsonl
          landing.json
          black-box.json
      documents/
        rfi_signup_display_name.json
        change_order_signup_schema_v2.json
      inbox/
        CLAUDE-17/
          evt_rfi_signup_display_name.json
        CODEX-04/
          evt_schema_clearance_required.json
      near-misses/
        nm_signup_schema_drift_001.json
      incidents/
        incident-replay-signup-schema-drift.jsonl
      counterfactual-runs/
        shadow-choice-signup-v2.json
      policy-deltas/
        delta_auth_schema_first.json
      proof-bundles/
        txn_codex_auth_001.proof.json
      provenance/
        line-provenance.jsonl
      handover.md
```

This makes CodeSite usable by external CLI agents and reviewable in PRs.

Agent-readable manifest:

```json
{
  "version": 1,
  "project_id": "site_signup_email_verification",
  "control_state": "projects/signup-email-verification/control-state.json",
  "events": "projects/signup-email-verification/events.jsonl",
  "schemas": "schemas/",
  "inbox_root": "projects/signup-email-verification/inbox/",
  "proof_bundle_root": "projects/signup-email-verification/proof-bundles/",
  "mcp_tools": [
    "synthi_codesite_next_event",
    "synthi_codesite_ack_event",
    "synthi_codesite_open_transaction",
    "synthi_codesite_validate_transaction"
  ]
}
```

---

## 24. MVP

The MVP must prove the ATC loop, not a large dashboard.

### MVP Scope

1. Substrate adapters for Dojo proof/evidence, shadow jobs, collab permissions, MCP patch writes, terminal/runtime events, and Yjs flush events.
2. Airspace survey for repo paths.
3. Flight-plan JSON schema.
4. Clearance JSON schema.
5. `MutationLease` policy engine for path/tool checks.
6. `MutationTransaction` with base snapshot, read set, write set, invariants, and serializable validation.
7. Assumption leases for schema/API dependencies.
8. Agent-readable `control-state.json`, schemas, events JSONL, and MCP polling.
9. CodeSiteFS proof of pre-write blocking or quarantine for at least one managed runtime path.
10. Collision prediction for overlapping routes and shared contract zones.
11. Shadow merge simulator for schema-first vs parallel coordination.
12. Radar panel with active flights and airspace zones.
13. Transponder event log.
14. Multi-user `AgentSession` registry and project event bus.
15. Agent inbox with SSE/WebSocket plus MCP polling.
16. Tower-mediated RFI between two user-owned agent sessions.
17. Landing inspection wrapper around existing tests/typecheck/shadow where available.
18. Proof-carrying commit bundle.
19. Black-box handover packet with causal replay.

### MVP Demo

```text
User: Build signup with email verification.

Tower:
Collision risk high: frontend and backend both depend on packages/schemas/auth.
Launching SCHEMA-01 first.
CLAUDE-17 held until auth.signup.v2 lands.
CODEX-04 cleared for api/auth after schema landing.
TEST-02 assigned as landing radar.
```

Then radar shows:

```text
SCHEMA-01   packages/schemas/auth   landing     contract radar running
CLAUDE-17   frontend/signup         holding     waiting auth.signup.v2
CODEX-04    api/auth                holding     waiting auth.signup.v2
TEST-02     tests/auth              standby     runway clear
```

The reviewer sees:

```text
Black box:
- 1 predicted collision avoided
- 1 stale assumption invalidated before stale UI code landed
- 1 raw terminal write blocked by CodeSiteFS
- 2 clearances issued after schema landing
- 0 no-fly violations
- proof bundle attached to commit
- 5 inspections passed
- 1 punch item: production email provider not configured
```

### MVP Senior-Engineer Demo

```text
1. Alice's Claude starts frontend from auth.signup.v1.
2. Ben's Codex changes auth schema to auth.signup.v2.
3. CodeSite invalidates Claude's assumption before stale UI writes continue.
4. Claude tries to edit api/auth through raw terminal.
5. CodeSiteFS blocks the write at the filesystem boundary.
6. Tower reroutes schema-first.
7. Shadow merge simulation passes.
8. Commit lands with proof bundle trailers.
9. Reviewer clicks a changed line and sees causal provenance.
```

This is the demo that proves CodeSite is not an agent dashboard.

---

## 25. Implementation Roadmap

### Phase 0: Substrate Adapters

Build thin adapters over what exists:

- Dojo proof capsule and license decision reader
- Dojo evidence ledger writer for CodeSite artifact kinds
- Dojo checkride/Vivarium invocation wrapper for preflight and landing inspections
- shadow job/universe reference adapter
- healing/provenance signal importer
- collab-server mutation surface inventory
- terminal/runtime/program event transaction tagger
- SessionManager/permissionMiddleware adapter for user-owned agent sessions
- Yjs flush and filesystem watcher event adapter
- MCP source/patch writer adapter

Outcome:

- CodeSite starts by cross-referencing current systems instead of forking them
- the plan can honestly label each signal as existing substrate, planned CodeSite state, or production-enforced authority

### Phase 1: Airspace and Flight Plans

Build:

- airspace classifier
- `ExecutionPlan` schema
- `MutationLease` schema
- `MutationTransaction` schema
- `AssumptionLease` schema
- `AgentSession` schema for user-owned agents
- no-fly zones
- repo-local `.synthi/codesite/airspace` artifacts
- basic project model

Outcome:

- every agent task starts with a route and abort conditions

### Phase 2: MutationLease Policy Engine

Build:

- path/tool lease evaluator
- airspace class evaluator
- mutation-lease issuance/revocation
- violation detection
- initial write wrapper for CodeSite-managed edits
- owner-user and workspace-role checks for each lease

Outcome:

- agents can be blocked from no-fly zones

### Phase 2A: Mutation Transactions

Build:

- transaction open/validate/commit/abort API
- base snapshot capture
- read-set and write-set recording
- invariant registration
- serializable commit validation
- stale read detection
- assumption invalidation hooks

Outcome:

- agents commit code like transactions, not uncontrolled file edits

### Phase 2B: Project Event Bus and Agent Inbox

Build:

- `ProjectEventBus`
- `DocumentRouter`
- `AgentInbox`
- SSE/WebSocket delivery for browser sessions
- MCP polling tools for CLI/cloud agents
- ACL/redaction gate for cross-user agent messages
- RFI send/reply flow between agents owned by different users

Outcome:

- unrelated users' agents can coordinate through structured tower-mediated documents without sharing private prompts or credentials

### Phase 2C: CodeSiteFS

Build:

- `CodeSiteFS` interface: prepare, validate, apply, verify, emitEvent, rollbackHint
- collab-server boundary integration first
- one normalized containment-checked path resolver for all mutations
- transaction wrapper around `gitService.safeWriteFile`, batch writes, create directory, rename, delete, sync, conflict operations, scaffold writes, shadow apply, and MCP patch writes
- Yjs flush transaction hooks before disk writes
- terminal/runtime exec tagging with active transaction id
- read-only repo base plus per-agent writable overlay
- MutationLease enforcement at filesystem boundary
- illegal-write quarantine
- transaction read/write set capture from filesystem events
- process-tree provenance for writes
- mature runtime enforcement through pod mount strategy, sidecar/FUSE/overlay, fanotify/eBPF-style gate, or equivalent filesystem boundary

Outcome:

- unmanaged terminal writes are blocked or quarantined before they mutate the real repo

### Phase 3: Radar UI

Build:

- workspace CodeSite radar panel
- active flight table
- repo zone map
- status colors
- tower instruction feed
- transponder event stream

Outcome:

- CodeSite becomes visually distinct from kanban/task dashboards

### Phase 4: Collision Prediction

Build:

- route overlap detector
- predicted read/write set detector
- shared contract detector
- migration runway lock
- semantic route risk hints from imports/schema/test ownership
- TCAS recommendation engine
- shadow merge simulator for coordination strategies

Outcome:

- tower can prevent frontend/backend/schema collisions before edits

### Phase 5: Landings and Radar Inspectors

Build:

- landing request flow
- type/test/API/security/migration/UI inspection adapters
- landing verdicts
- go-around/punch item generation

Outcome:

- "done" becomes "landed and inspected"

### Phase 6: Mayday and Ground Stop

Build:

- mayday event type
- ground-stop workflow
- repo snapshot on emergency
- inspector launch
- human resume gate

Outcome:

- high-risk agent discoveries freeze related airspace automatically

### Phase 7: Black Box Replay

Build:

- ordered event capture
- evidence indexing
- replay timeline
- near-miss report
- handover packet generator
- transaction timeline with read/write sets
- assumption invalidation events
- CodeSiteFS denied-write events

Outcome:

- failures become replayable operational incidents, not scattered logs

### Phase 7B: Proof-Carrying Commits and Line Provenance

Build:

- proof bundle generation from transaction, lease, read/write sets, invariants, and inspections
- commit trailer writer
- proof bundle verifier outside the UI
- line-level causal provenance index
- line provenance UI/API

Outcome:

- reviewers can verify why a line exists and whether the commit satisfied its transaction invariants

### Phase 8: Dojo Pilot Licenses

Build:

- mutation-lease eligibility from Dojo skill/passport/license data
- license health updates after landings/violations
- source drift expiration for airspace licenses

Outcome:

- agents earn clearance privileges inside a repo

### Phase 9: Counterfactual ATC Memory

Build:

- durable coordination traces
- rejected route plans
- near-miss policy deltas
- future tower-plan biasing

Outcome:

- CodeSite learns better traffic control patterns over time

---

## 26. Senior-Engineer Wow Features

### 26.1 Live Collision Cones

Show predicted conflicts as cones ahead of active agents on the repo graph.

```text
CLAUDE-17 route intersects CODEX-04 in packages/schemas/auth in 8 minutes.
Tower recommends schema-first reroute.
```

### 26.2 Runway Occupancy

Branches/worktrees are runways.

CodeSite tracks:

- which runway is occupied
- what diff is on it
- what inspections are pending
- which flights can land there

### 26.3 Wake Turbulence

Some flights leave instability behind.

Examples:

- migration changes require backend/test flights to wait
- schema changes require generated client refresh
- package export changes require downstream radar

Tower should model this as wake turbulence.

### 26.4 Clearance in Commit Metadata

Commits include:

```text
CodeSite-Project: site_signup_email_verification
CodeSite-Flight: CODEX-04
CodeSite-Clearance: clr_backend_auth_001
CodeSite-Landing: landed-with-punch
CodeSite-Black-Box: sha256:...
```

### 26.5 Emergency Broadcasts

When mayday occurs:

```text
MAYDAY from CODEX-04: destructive migration detected.
Tower issued ground stop for db/migrations and api/auth.
SEC-01 and DB-INSPECT-02 dispatched.
```

### 26.6 Tower Simulator

Before launching agents, simulate coordination strategies:

- schema-first
- frontend/backend parallel
- single fullstack agent
- test-first

Choose the plan with lowest predicted collision and inspection cost.

### 26.7 Serializable Repo Isolation

Show transaction validation like a database isolation report:

```text
Transaction txn_backend_auth_001
Base snapshot: repo@sha256:abc
Declared read set: 4 files
Observed read set: 9 files
Write set: 3 files
Isolation: serializable
Result: aborted
Reason: auth.signup.schema changed after read
Tower action: rebase and revalidate assumptions
```

### 26.8 Assumption Invalidator

Show stale agent reasoning before stale code lands:

```text
Assumption asm_signup_payload_v1 invalidated by schema auth.signup.v2.
Affected sessions: CLAUDE-17, TEST-02.
Writes paused until assumptions are refreshed.
```

### 26.9 Filesystem Boundary Proof

Make blocked writes visible as proof, not warning text:

```text
Denied write:
Path: api/auth/signup.ts
Lease: lease_frontend_signup_001
Reason: Class A auth API outside route
Process: python <- bash <- claude-cli
Evidence: ev_codesitefs_denied_001
```

### 26.10 Causal Line Inspector

Click a changed line and answer:

```text
Who wrote it?
Under which lease and transaction?
What assumption did it rely on?
Which RFI/change order caused it?
Which tests and inspectors approved it?
Which Dojo proof and evidence ledger records backed the clearance?
```

---

## 27. Success Metrics

ATC metrics:

- collisions predicted
- collisions avoided
- near-misses replayed
- no-fly violations blocked
- flights rerouted by tower
- flights held before shared-zone conflict
- landings passed first try
- go-around rate
- ground-stop events
- average time to clearance
- average time in holding

Transaction metrics:

- stale reads detected
- assumption invalidations before write
- serializable transaction abort rate
- shadow merge simulator accuracy
- CodeSiteFS blocked writes
- illegal writes quarantined
- proof bundles verified outside UI
- lines with causal provenance coverage

Software quality metrics:

- merge conflicts avoided
- contract drift incidents
- migration rollback coverage
- security findings before merge
- tests red at landing
- post-merge rollback rate

Trust metrics:

- percentage of writes with valid clearance
- black-box completeness score
- human review time saved
- pilot license violation rate
- repeated near-misses converted to airspace rules

---

## 28. Risks

### Risk: ATC becomes a skin over task management

Guardrail:

- the `MutationLease` policy engine must block real mutations
- collision prediction must drive actual tower instructions
- black-box replay must be generated from real events

### Risk: Too much ceremony

Guardrail:

- Class C/D auto-clearance
- micro-clearances for docs/tests
- ceremony scales with airspace class

### Risk: Agents bypass radar in terminal

Guardrail:

- mutation-lease-bound terminal sessions
- command telemetry
- CodeSiteFS overlay enforcement
- post-write patrol only as an MVP fallback
- pre-write filesystem interception in mature implementation
- do not rely on API wrapping for terminal, package-manager, or container writes

### Risk: Humans get a radar UI but agents get vague instructions

Guardrail:

- all control-plane state has JSON schema
- every human-visible state has an MCP/API equivalent
- `.synthi/codesite/manifest.json` points agents to current control state, events, inbox, schemas, and proof bundles
- agents receive structured tower instructions, never only prose
- no critical state exists only in the browser

### Risk: Transaction layer is too expensive

Guardrail:

- start with path-level read/write sets
- promote to semantic dependency sets for Class A/B zones
- cache policy compiler output
- run full serializable validation only for risky zones

### Risk: False confidence from Dojo maturity

Guardrail:

- show implementation-status metadata for license-backed decisions
- avoid production-runtime claims until release gates prove them

---

## 29. Final Product Shape

Do not pitch:

> CodeSite is a construction site for AI software teams.

Pitch:

> CodeSite is air traffic control for AI coding agents.

Longer version:

> CodeSite lets many agents work in one repo without collision by issuing clearances, predicting conflicts, enforcing no-fly zones, inspecting landings, and replaying every near-miss.

Technical version:

> CodeSite is the transaction layer for AI-generated code changes.

Senior-engineer version:

> CodeSite gives AI agents serializable isolation over a shared repo.

Architecture version:

> CodeSite combines MVCC repo snapshots, MutationLeases, CodeSiteFS, assumption invalidation, invariant checks, proof-carrying commits, and causal incident replay.

Moat:

> Live repo airspace control backed by enforced mutation transactions, Dojo proof, filesystem-level write control, stale-assumption detection, multi-user agent ACLs, agent-native control contracts, line-level causal provenance, black-box replay, and counterfactual traffic policy.
