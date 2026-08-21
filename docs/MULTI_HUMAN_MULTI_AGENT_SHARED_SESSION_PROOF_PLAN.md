# Vectant Shared Session: Multi-Human, Multi-Agent Synchronization and Proof Plan

**Status:** implementation and acceptance plan
**Owner:** Vectant collaboration and CodeSite control plane
**Companion document:** [`CODESITE_CONSTRUCTION_COORDINATION_PLAN.md`](CODESITE_CONSTRUCTION_COORDINATION_PLAN.md)

## 1. Product decision

Vectant is not a service that gives every agent an isolated cloud VM and asks a human to merge the results later.

Vectant is one live workspace that can be inhabited simultaneously by multiple humans and multiple agents. Each participant has an independent identity, terminal/session, permissions, and task context. They collaborate through a durable, permissioned shared project state.

```text
                         VECTANT SHARED SESSION

    Human A terminal ─┐                 ┌─ Agent A / Codex terminal
    Human B terminal ─┼─ shared base ───┼─ Agent B / Claude terminal
    Human C terminal ─┘   workspace     └─ Agent C / custom runtime
                              │
               source, CRDT editor state, runtime observations,
              discoveries, skills, leads, plans, leases, events,
                   assumptions, evidence, and collision signals
```

The system must make this true in practice:

> If two users are in the same Vectant session and open Codex, Claude, or another supported agent in different terminals, their agents automatically become participants in the same coordination project. They receive the relevant discoveries, current work, leads, skills, runtime observations, assumptions, and change impacts without relying on manually copied chat context or later branch merging.

This does **not** mean every agent receives every private prompt, secret, terminal transcript, credential, or local memory. Shared knowledge is project-scoped, structured, redacted, attributable, and authorized.

## 2. What “same session, same workspace” means

The following properties are required together. A system that supplies only one or two is not the intended product.

| Property | Required behavior |
| --- | --- |
| One workspace identity | Humans in a collaboration session operate against the same effective workspace checkout and project identity. |
| Separate terminals | Every human and agent keeps an independent terminal, shell state, process lifecycle, and attribution. One participant cannot silently take over another terminal. |
| Live source convergence | Human editor changes converge through CRDT collaboration. Landed agent changes appear in the shared workspace and notify affected participants. |
| Isolated mutation attempts | An agent's unlanded mutation is scoped to a transaction overlay/quarantine, so concurrent work cannot silently corrupt the base workspace. |
| Shared operational state | Participants can see relevant running programs, logs, ports, test outcomes, and source changes as they happen. |
| Shared understanding | Discoveries, verified facts, assumptions, TODO leads, decisions, contracts, skills, and handoffs become durable project artifacts instead of disappearing inside a single agent conversation. |
| Anticipatory coordination | Before a write lands, CodeSite predicts file, contract, migration, runtime, test, and semantic collisions. |
| Safe information flow | Cross-user agent information travels through a project ACL, redaction, audit, and acknowledgement boundary. |

## 3. Required shared knowledge model

Git answers **who changed which text**. Vectant must answer the additional questions below while the work is underway.

| Shared object | Example | Producer | Consumers | Required system behavior |
| --- | --- | --- | --- | --- |
| Discovery | `CharacterController.cpp`, not `Camera.cpp`, owns rotation | agent or human | agents touching input/camera/door state | durable fact with source references and confidence; notify affected routes |
| Lead | `Turn()` emits a different event after 180 degrees | agent or runtime observer | event consumers and test owners | attach impact paths/contracts; keep open until confirmed or dismissed |
| Assumption | `auth.signup.v1` includes `displayName` | agent | downstream frontend/API agent | invalidate and block/rebase dependent work when the fact changes |
| Skill/capability | `run-auth-contract-tests` validates the signup payload | human or agent | agents assigned to auth work | publish metadata, usage conditions, and evidence; never copy private provider context |
| Work intent | `CODEX-04` plans to change `api/door-state/**` | agent | tower and overlapping agents | create a route, a declared read/write scope, and an expected contract impact |
| Runtime observation | preview event payload changed from `turn` to `turn:half` | runtime adapter | consumers, test agent, human operators | timestamp, attribute, retain evidence, and issue impact notices |
| Decision | schema must land before frontend and backend edits | human or tower | all affected agents | make it binding through route/lease status, not merely a chat suggestion |
| Handoff | API change landed; consumer must use `rotationDirection` | departing agent | successor and reviewers | link change, tests, unresolved risks, and acknowledgement |
| Incident/near miss | two active migrations targeted the same database | tower | project members | suspend the affected route, preserve causal replay, and learn a policy candidate |

### 3.1 Automatic synchronization rule

An agent must not need to remember to tell the other agents everything it learned. The system should derive and route obvious coordination signals automatically:

1. A source read, symbol lookup, contract lookup, runtime event, or test result becomes an attributed observation.
2. The observation is classified against active routes, dependency edges, source ownership, contracts, and runtime consumers.
3. Affected active agents receive a compact impact notice in their inbox and event stream.
4. Each agent acknowledges, rebases, answers, or explicitly dismisses the notice with evidence.
5. The tower records the outcome and updates collision confidence and future policy candidates.

Agents may still file a deliberate RFI, handoff, change order, or inspection request when human judgement is required. Automatic routing supplements structured communication; it does not replace it with uncontrolled agent chat.

## 4. Current implementation research

This section separates existing, executable substrate from the work still needed to achieve the product decision.

### 4.1 Present and useful today

| Area | What exists | Primary implementation |
| --- | --- | --- |
| Multi-human collaboration | Yjs/Y-Sweet document synchronization, presence, cursors, guest/host sessions, and effective host workspace identity for guests | `synthi/src/services/collabClient.js`, `backend/collab-server/SessionManager.js`, `backend/collab-server/server.js` |
| Independent terminal sessions | PTY, runtime, program, and reattach routing with CodeSite-aware transaction context | `backend/collab-server/terminalService.js`, `terminalRouting.js`, `workspaceRuntimeContainer.js` |
| Shared runtime filesystem | Guest actions resolve to the host's effective workspace user in a collaboration session; container runtime mounts that user-scoped checkout | `backend/collab-server/server.js`, `gitService.js`, `workspaceRuntimeContainer.js` |
| CodeSite project state | Durable projects, membership, agent sessions, execution plans, leases, transactions, assumptions, documents, events, inbox items, incidents, evidence, and provenance | `synthi/prisma/schema.prisma`, `synthi/src/lib/codesite/controlPlane.js` |
| Agent interface | MCP tools register agent sessions; file plans; request leases; record reads, writes, assumptions; read events/inboxes; predict collisions; and apply governed patches | `mcp/synthi-mcp/src/tools/codesite.ts` |
| Collision detection | Route/path overlap, restricted zones, semantic footprint signals, active lease occupancy, migration/wake-risk signals, and recommended reroutes | `synthi/src/lib/codesite/policy.js` |
| Assumption invalidation | A permitted write invalidates dependent path or semantic assumptions, records a durable event, and causes serializable validation to block stale transactions | `synthi/src/lib/codesite/controlPlane.js` |
| Mutation boundary | Managed writes validate transaction identity, lease, user/agent identity, allowed route, tool, source state, and containment before applying | `backend/collab-server/codesiteFs.js`, `codesiteActiveBoundary.js` |
| Quarantine and overlay | Raw terminal and runtime changes can be routed into quarantine/overlay storage for review and controlled replay | `backend/collab-server/codesiteFs.js`, `workspaceRuntimeContainer.js` |
| Human operator surface | CodeSite panel shows radar, events, inbox, governance, inspections, evidence, replay, simulator, locks, and quarantine views | `synthi/src/components/codesite/` |

### 4.2 Validation performed on 2026-08-22

- The running Compose stack included frontend, collab-server, Y-Sweet, Postgres, Redis, signaling server, worker, and MCP services.
- The collab-server CodeSite boundary suite ran inside its intended Linux container: **110 of 112 tests passed**. Passing coverage includes transaction context matching, authority fail-closed behavior, path traversal and symlink containment, pre-write enforcement, transaction read/write capture, quarantine, overlay isolation, proof-carrying commit behavior, and unmanaged-host prewrite guarding.
- The two failing runtime filesystem tests are environment-coupled test failures: the configured control-plane authority replaces a test-local active record, and a fake checkout path is passed into enabled instruction projection. The tests need hermetic authority/projection configuration; this result does not prove the product flow is complete.
- `mcp/synthi-mcp/tests/unit/codesite_tools.test.ts` passed **18 of 18** tests. These are HTTP contract tests with mocked fetch, so they prove tool mapping rather than a real cross-agent workflow.
- The host Windows test run could not exercise POSIX symlink/permission cases. Those cases passed inside the Linux collab-server container, which is the relevant enforcement environment.
- The live CodeSite API correctly rejected an unauthenticated request. No project or test data was written during this assessment.

### 4.3 Important gaps found

1. **The default Compose transaction-activity bridge is incomplete.**

   The frontend tries to publish transaction open/close state to collab-server. The collab-server activity endpoint requires `COLLAB_INTERNAL_TOKEN` or `SYNTHI_COLLAB_INTERNAL_TOKEN`. The default Compose configuration sets the separate CodeSite API token but does not set this activity token for both sides. Open/close state therefore cannot be relied upon to propagate automatically in the default local stack.

2. **Agent knowledge routing is only partial.**

   `CodeSiteDocument` objects are routed to durable per-agent inboxes, with SSE, MCP polling, repo projection, and optional delivery adapters. Generic events such as `assumption_invalidated`, `write_allowed`, or `runtime` observations are retained in the project event stream but are not automatically translated into targeted inbox work items for affected agent sessions.

3. **Agents are represented, but not automatically attached from a terminal launch.**

   The system can register an `AgentSession`, but opening Codex or another agent terminal does not yet reliably create the session, bind it to its workspace/project identity, subscribe it to the event bus, restore its prior state, and announce it to the other participants.

4. **The default shadow merge result is a forecast, not necessarily a real merge execution.**

   `shadowMergeSimulate` scores coordination strategies from project signals. It can use a configured external runner, but an executable worktree merge plus targeted test result is not the default proof.

5. **Runtime observations are not yet a single shared operational stream.**

   Terminal, program runtime, filesystem, preview, and MCP event surfaces exist, but CodeSite needs one normalized, access-controlled event adapter that converts relevant events into project observations and impact notices.

6. **Authorization needs a least-privilege review.**

   Several CodeSite state-changing API routes are intentionally admitted through workspace read access and rely on later project/session checks. The final product must make every mutation-producing action explicitly role and capability scoped, including webhook delivery registration.

7. **The deployment image is not a test image.**

   The production frontend container does not contain the source test suite. CI must run the source tests in a dedicated test image or workspace, then run a separate running-stack acceptance proof.

## 5. Target architecture

### 5.1 Coordination identity chain

```text
Workspace collaboration session
  -> human membership and effective workspace identity
  -> CodeSite project membership
  -> terminal-launched AgentSession
  -> ExecutionPlan
  -> MutationLease
  -> MutationTransaction / overlay
  -> events, observations, inboxes, evidence, and landing
```

Every observation and mutation must carry these identities where applicable:

```text
workspaceSlug
collaborationSessionId
effectiveWorkspaceUserId
projectId
agentSessionId
providerSessionRef
terminalSessionId or runtimeSessionId
executionPlanId
mutationLeaseId
mutationTransactionId
eventId
```

### 5.2 One base workspace, many terminal views

```text
                         shared base checkout
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
       Human editor/PTY    Agent A overlay     Agent B overlay
              │                  │                  │
       CRDT + filesystem    txn A evidence     txn B evidence
              │                  │                  │
              └──── landed, validated change ───────┘
                                 │
                     shared event and runtime stream
```

- The base checkout is the shared collaboration workspace.
- Each participant has a separate terminal session.
- An active agent mutation uses a transaction-aware overlay or quarantine view rather than freely changing the shared base tree.
- After validation and landing, CodeSite atomically updates the base tree and broadcasts a source-impact event.
- Read-only research and ordinary collaborative editing remain visible immediately, subject to normal workspace permissions.

### 5.3 The Project Coordination Bus

Add a single logical bus above existing `CodeSiteEvent`, `CodeSiteDocument`, inbox, runtime, and filesystem services.

```text
Event producers
  CRDT editor · terminal · runtime · MCP · CodeSiteFS · test runner · human tower
       │
       ▼
Project Coordination Bus
  normalize -> redact -> classify -> correlate -> authorize -> persist -> route
       │
       ├─ Project timeline and radar
       ├─ Per-agent impact inbox
       ├─ Provider callback / managed SSE connection
       ├─ Repo-local JSONL projection
       ├─ Human notifications
       └─ Evidence / replay / policy-learning store
```

The bus is a coordination service, not a group chat server. It shares bounded project facts and notices, never raw internal agent conversations by default.

### 5.4 Event classes

| Class | Producer | Automatic recipients | Required response |
| --- | --- | --- | --- |
| `discovery.recorded` | research agent/human | agents with overlapping active routes or subscriptions | acknowledge or mark irrelevant |
| `lead.opened` / `lead.resolved` | agent, test runner, or human | owner plus affected workstreams | claim, dismiss, or escalate |
| `skill.published` / `skill.updated` | human or validated agent | eligible agents in workspace/project | optional adoption acknowledgement |
| `assumption.invalidated` | CodeSite write/contract adapter | owner of assumption and all dependent transactions | rebase, refresh, or abort before continuing |
| `source.changed` | landing, CRDT flush, or governed patch | readers/consumers of changed symbols or paths | refresh source state |
| `runtime.observed` | terminal/program/preview adapter | owners of affected runtime contract | investigate, acknowledge, or attach test evidence |
| `collision.predicted` | policy engine | involved agents and human tower | accept reroute, request override, or hold |
| `handoff.ready` | finishing agent | named successor/reviewer | acknowledge handoff |
| `inspection.failed` | test/security/review agent | transaction owner, dependents, tower | remediate, waive, or abort |
| `mayday` / `ground_stop` | any authorized participant | all affected routes | stop work; human resume required |

Each event must have a stable id, causal parents, scope, source references, redaction class, recipient set, delivery attempts, acknowledgement state, and expiration policy.

## 6. Automatic agent lifecycle

### 6.1 Attach when an agent terminal opens

When a human opens Codex/Claude/custom agent from a shared workspace terminal:

1. Terminal/runtime adapter resolves the collaboration session, authenticated user, effective workspace user, workspace slug, and selected CodeSite project.
2. It creates or resumes a `CodeSiteAgentSession` using the provider session reference and terminal session id.
3. It assigns a callsign and records the agent's tools, execution host, and approved delivery channel.
4. It loads a minimal project briefing:
   - active workstreams and ownership;
   - relevant active transactions and leases;
   - unread impact notices and handoffs;
   - current source/runtime state for the agent's route;
   - available shared skills and known leads;
   - current constraints, no-fly zones, and required inspections.
5. It subscribes the agent to its durable inbox and filtered event stream.
6. It emits `agent.attached` so other participants can see a real collaborator has joined.

The initial briefing must be bounded. It is a compact working set, not another user's entire chat history or a dump of every project artifact.

### 6.2 Start work

1. Agent files or accepts an `ExecutionPlan` with mission, route, expected reads/writes, dependencies, tests, and abort conditions.
2. CodeSite predicts collisions against active plans, leases, transactions, and known semantic contracts.
3. If safe, it issues a path/tool/time scoped `MutationLease`.
4. Agent opens a `MutationTransaction` against a recorded base snapshot.
5. Agent automatically receives observations/impact notices relevant to the lease while it works.

### 6.3 Learn, research, and share

The agent adapter should expose explicit tools for these semantic actions:

```text
vectant_record_discovery
vectant_record_lead
vectant_publish_skill
vectant_link_runtime_observation
vectant_file_handoff
vectant_get_relevant_context
vectant_ack_impact_notice
```

The adapter should also infer low-risk observations from governed activity:

- files/symbols read while researching;
- source links and test output;
- successful commands and reusable validation recipes;
- changed public contracts and emitted runtime events;
- transaction dependencies and failed assumptions.

Inference must be reviewable. An agent can mark inferred information private-to-owner, project-shareable, unverified, or incorrect.

### 6.4 Land work and inform dependents

1. CodeSite records observed reads/writes and produces line/source evidence.
2. It invalidates affected assumptions before validation.
3. It detects stale reads, changed base snapshots, conflicting transactions, and failed invariants.
4. If validation passes, it lands atomically, writes the proof bundle, updates the shared base workspace, and publishes `source.changed` plus contract/runtime impact notices.
5. If validation fails, it keeps the transaction blocked or quarantined, routes a precise remediation notice, and preserves a replayable near-miss record.

## 7. Multi-user privacy, consent, and security

The system must preserve the distinction between **shared project understanding** and **private agent context**.

### 7.1 Share by default

- routes, leases, transaction state, and collision warnings;
- source paths, symbols, contracts, and commit/patch evidence;
- runtime observations scoped to the shared workspace;
- validated discoveries, leads, skills, test recipes, handoffs, and inspection results;
- redacted RFI/change-order/incident documents;
- acknowledgements, decisions, and audit metadata.

### 7.2 Never share by default

- raw prompts, hidden chain-of-thought, or terminal history;
- credentials, tokens, cookies, environment values, and private keys;
- unrelated repository context or another workspace's files;
- provider account state, billing context, or private provider-session memory;
- arbitrary unreviewed external webhook targets.

### 7.3 Required controls

- project membership must be checked for every read, write, subscription, and delivery;
- each agent session is owned by one authenticated workspace user;
- recipient-visible zones and document/event types are enforced before delivery;
- callback delivery uses allowlisted origins, signed envelopes, replay protection, retries, and a durable failure record;
- a user can mute, pause, revoke, or make their agent read-only without terminating other users;
- every cross-user notice is visible to permitted human operators and is attributable to a source session;
- human approval is required for elevated paths, mayday recovery, policy overrides, and any external side effect.

## 8. Implementation workstreams

### Workstream A — make the present control plane operational

1. Configure one non-default `COLLAB_INTERNAL_TOKEN` for both frontend and collab-server in Compose, Cloud Run, and production deployment manifests.
2. Add startup readiness that performs an authenticated control-plane probe and a collab activity publish/refresh probe without exposing token values.
3. Fail deployment readiness if either direction is unavailable:

   ```text
   frontend transaction open/close -> collab activity registry
   collab active workspace guard -> CodeSite transactions/active authority
   ```

4. Make activity-state tests hermetic: inject a test authority and disable/replace workspace instruction projection where the test does not exercise it.
5. Publish a deployment status card: `control-plane reachable`, `activity bridge reachable`, `overlay capable`, `inbox delivery capable`, and `runtime event adapter healthy`.

### Workstream B — automatic agent attach and session registry

1. Add `AgentSessionAttachService` in collab-server/runtime launch paths.
2. Bind provider session, terminal/runtime session, collaboration session, owner user, effective workspace user, project, and callsign.
3. Resume a known agent session on terminal reattach only if all ownership and transaction identities match.
4. Expose a compact `get_relevant_context` MCP response generated from current state rather than a static prompt file.
5. Emit attach/detach/heartbeat events and show them in the CodeSite radar.

### Workstream C — shared discoveries, skills, leads, and handoffs

1. Add durable models or typed document variants for `Discovery`, `Lead`, `SharedSkill`, `ImpactNotice`, and `Handoff`.
2. Add source/contract/runtime references, confidence, verification evidence, scope, expiry, and ownership to each item.
3. Add indexing by paths, symbols, contracts, runtime/session ids, and active workstreams.
4. Add targeted notification rules: a discovery on a dependency of an active transaction produces an `ImpactNotice` for that transaction owner.
5. Add skill publication policies: a command recipe is shareable only after its source, permissions, and evidence are known.
6. Project the safe subset to `.synthi/codesite/` for compatible CLI agents.

### Workstream D — unified project event and runtime observation bus

1. Normalize existing CodeSite, CRDT, filesystem, terminal, program runtime, preview, test, and MCP events into the event classes in section 5.4.
2. Correlate events by source path, symbol/contract id, transaction, runtime session, and process ancestry.
3. Add a managed long-lived delivery channel for agent hosts. MCP polling remains a correct fallback, not the only means of synchronization.
4. Translate high-value generic events into targeted inbox notices, beginning with:
   - assumption invalidations;
   - contract/schema changes;
   - source changes intersecting active read sets;
   - runtime/test failures intersecting active plans;
   - lease revocation, expiry, collision, and mayday.
5. Preserve a single causal timeline in Postgres and a redacted JSONL projection for diagnostics.

### Workstream E — real collision and merge execution

1. Expand semantic footprints using repository indexing: exports, imports, API schemas, events, migrations, generated clients, tests, build commands, and runtime port ownership.
2. Bind declaration and use sites to transaction read/write sets automatically where possible.
3. Implement an executable shadow merge runner:
   - materialize transaction overlays into temporary worktrees;
   - apply viable ordering permutations;
   - run the selected impacted validation commands;
   - capture patch, merge, test, runtime, and cost evidence;
   - distinguish `forecast` from `executed` results in every UI/API response.
4. Promote route policy changes only from reviewed, evidence-backed counterfactual results.

### Workstream F — authorization and enforcement completion

1. Audit every CodeSite route so a state-changing operation requires explicit project write/capability authority; do not depend on a broad workspace read gate plus later assumptions.
2. Restrict delivery adapters with an allowlist and signed outbound envelope policy.
3. Ensure every mutation surface uses the same CodeSite boundary: direct file APIs, batches, Yjs flush, Git, terminal, program runtime, scaffold, sync, rename, delete, shadow apply, and external MCP patch apply.
4. Maintain Linux overlay/containment enforcement as the production boundary. Windows host checks are development diagnostics, not the authoritative production control.
5. Add a human-visible override and audit reason for each exception to normal collision/lease policy.

### Workstream G — verification and release evidence

1. Run unit tests from a dedicated source/test image, not the production frontend image.
2. Keep platform-specific tests explicit: POSIX symlink, permissions, overlay mount, and process ancestry tests run in Linux CI/container.
3. Add an authenticated disposable workspace fixture for end-to-end acceptance. It must use real frontend, collab-server, Postgres, Y-Sweet, MCP, and runtime services.
4. Produce a machine-readable proof bundle and human-readable replay after every acceptance run.

## 9. Canonical multi-human, multi-agent acceptance proof

This is the release gate for the differentiating product claim.

### 9.1 Actors

| Actor | Identity | Terminal/agent | Assignment |
| --- | --- | --- | --- |
| Alice | workspace owner | terminal plus Codex `CODEX-ROTATION-01` | investigate and change rotation event producer |
| Ben | shared-session guest | terminal plus Claude `CLAUDE-DOOR-02` | implement door-state consumer behavior |
| Priya | shared-session guest | terminal plus review agent `TEST-03` | inspect contracts, run tests, and approve landing |

All three enter the same Vectant collaboration session and therefore resolve to the same effective workspace checkout. Each has an independent terminal and agent session.

### 9.2 Fixture

Use a small deterministic project with:

```text
src/CharacterController.cpp     // owns CharacterController::Turn
src/Camera.cpp                  // looks plausible but does not own rotation
src/DoorState.cpp               // consumes rotation event
contracts/rotation-event.json   // event payload contract
tests/rotation-door.test.*      // consumer behavior test
```

Initial fact:

```text
CharacterController::Turn emits rotation.completed@v1.
DoorState consumes rotation.completed@v1.
Camera.cpp does not control player rotation.
```

### 9.3 Required scenario

1. **Join and attach**
   - Alice, Ben, and Priya join one collaboration session.
   - Each opens a separate terminal and agent host.
   - CodeSite automatically creates/resumes three agent sessions and shows their callsigns, owner users, terminals, and subscriptions in radar.

2. **Research and automatic discovery**
   - Alice's Codex traces rotation and records: `CharacterController.cpp` owns rotation; `Camera.cpp` is not the producer.
   - The discovery carries source evidence and affects `contracts/rotation-event.json` and `src/DoorState.cpp`.
   - Ben's active door-state agent receives an impact notice without Alice manually pasting the discovery into chat.
   - Ben acknowledges the notice and records that it avoids duplicate Camera investigation.

3. **Plans, leases, and collision forecast**
   - Alice receives a producer/contract lease.
   - Ben receives a consumer lease but is marked dependent on `rotation.completed@v1`.
   - CodeSite predicts a contract collision and declares the dependency/reroute before either agent writes.

4. **Assumption invalidation**
   - Ben records the assumption that the producer emits `rotation.completed@v1`.
   - Alice changes `CharacterController::Turn` and its contract to `rotation.completed@v2`, including the 180-degree behavior.
   - CodeSite records the write, invalidates Ben's assumption, and delivers a targeted impact notice.
   - Ben's transaction cannot validate or land until he refreshes/rebases against v2.

5. **Runtime synchronization**
   - Alice runs the shared preview/test runtime in her own terminal session.
   - The runtime adapter observes the changed event payload and emits a normalized `runtime.observed` event.
   - Ben and Priya receive the relevant observation and evidence reference; unrelated agents do not receive private terminal output.

6. **Repair and landing**
   - Ben updates `DoorState.cpp` through his transaction overlay to consume v2.
   - Priya's agent runs the impacted contract and behavior tests, publishes a reusable shared test skill/recipe, and requests/records inspection.
   - CodeSite performs executable shadow merge validation for producer followed by consumer, validates both transactions, and lands them atomically or in the proven sequence.

7. **Shared result and replay**
   - All participants see the landed source state in the shared workspace.
   - The proof bundle contains the discovery, impact notices, acknowledgement, lease decisions, assumption invalidation, runtime observation, test evidence, merge evidence, changed lines, and causal event order.
   - A human operator can open any changed line and identify why it exists, which agent changed it, what it depended on, and what evidence permitted landing.

### 9.4 Pass criteria

The proof passes only when all of the following are true:

- three authenticated participants are in one collaboration session with three separate terminal/agent sessions;
- all agents resolve to the same effective shared workspace base;
- a discovery made by one agent reaches the relevant other agent automatically and is acknowledged;
- no raw prompt, credential, or private terminal transcript is delivered cross-user;
- CodeSite detects the producer/consumer contract collision before Ben lands stale code;
- Alice's write invalidates Ben's assumption and blocks his stale transaction;
- Ben receives a targeted, durable notice and can rebase/repair;
- each mutation is attributed to user, agent session, terminal/runtime, lease, transaction, and evidence;
- runtime observations are shared as redacted, project-scoped facts;
- the actual merge/test result is marked `executed`, not merely forecast;
- landed source appears to all participants in the shared workspace;
- the replay/proof bundle is complete and reproducible;
- an unbound terminal, a forged transaction context, an out-of-route write, and a symlink escape are each denied or quarantined before real-base mutation.

### 9.5 Required negative tests

| Test | Expected result |
| --- | --- |
| Ben's agent tries to read Alice's raw provider prompt | denied; no prompt material appears in events/inbox/artifacts |
| Agent tries to attach to a collaboration session owned by another user without membership | denied before agent session registration |
| Agent with no transaction uses a terminal to write a governed path | blocked or quarantined before base mutation |
| Agent supplies another agent's transaction/lease id | denied due identity/context mismatch |
| Two agents target the same migration | collision/hold before either migration lands |
| Contract producer changes a payload consumed by an active transaction | dependent assumption invalidated and targeted notice delivered |
| Inbox callback endpoint is not allowlisted/signed | no outbound request; failure is audited |
| Agent goes offline after receiving a notice | notice remains durable and appears on reconnect/reattach |
| Shadow runner unavailable | result remains explicitly `forecast`; it cannot satisfy executable-merge release gate |

## 10. Delivery order and definition of done

### Phase 0 — operational bridge

- Configure and verify the frontend/collab transaction-activity bridge.
- Repair hermetic runtime filesystem tests.
- Add deployment readiness diagnostics.

**Done when:** a real authenticated transaction open/close changes collab active state and blocks/allows the expected unmanaged mutation surfaces.

### Phase 1 — attached agents and shared context

- Implement automatic agent attach/resume.
- Publish bounded relevant context, active work, and subscriptions.
- Show agents from different users on one project radar.

**Done when:** opening two supported agent terminals from two humans in one workspace creates two distinct, correctly owned sessions that can read project state without manual configuration.

### Phase 2 — knowledge synchronization

- Add discovery, lead, skill, impact notice, and handoff objects.
- Route assumption/source/contract impacts automatically into durable recipient inboxes.
- Add acknowledgement and rebase/abort state transitions.

**Done when:** the producer/consumer discovery and stale-assumption portion of the canonical proof passes without copied chat context.

### Phase 3 — shared runtime and executable collision resolution

- Normalize runtime observations.
- Implement executable shadow merge and impacted test runner.
- Connect landing to shared-base source/runtime notifications.

**Done when:** the canonical proof has real merge/test evidence and each participant sees the landed shared state.

### Phase 4 — security and production release gate

- Complete capability authorization audit and delivery hardening.
- Run the complete Linux stack proof in CI and in a release-candidate environment.
- Export signed/reviewable evidence.

**Done when:** all pass and negative criteria in section 9 are automated, reproducible, and required before release.

## 11. Success metrics

Track outcomes, not just emitted events:

- percentage of agents automatically attached to a project when launched in a shared session;
- time from discovery/contract change to relevant agent delivery and acknowledgement;
- stale assumptions invalidated before a write or landing;
- predicted collisions avoided versus detected after-the-fact conflicts;
- percentage of governed writes with complete user/agent/terminal/transaction provenance;
- unauthorized or out-of-route writes denied before base mutation;
- handoffs completed without rediscovery work;
- shared skills reused with verified evidence;
- shadow results classified as forecast versus executed;
- project event delivery success, retry count, and offline catch-up success;
- human operator intervention rate and override reasons;
- privacy/redaction violations: target is zero.

## 12. Final product test

Vectant has achieved this outcome when the following statement is demonstrably true:

> Alice and Ben can work in the same live workspace from separate terminals. Alice's Codex discovers and changes a producer contract; Ben's Claude automatically learns the discovery and receives an invalidation when the contract changes. Ben's stale work cannot land, but he can rebase against Alice's verified change. Both see relevant runtime and test observations, share validated skills and handoffs, and land coordinated code into the same workspace with a complete replay. Neither agent receives the other's private prompt, secret, or uncontrolled terminal access.

That is the differentiator: not parallel agents with merge debt, but a live team of humans and agents that continuously develops shared understanding while CodeSite prevents the shared workspace from becoming unsafe.
