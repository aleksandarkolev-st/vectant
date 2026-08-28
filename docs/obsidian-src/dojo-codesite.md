# Dojo, CodeSite & Local Support — Agent Trust Infrastructure Analysis

**Repo:** `vectant-ade` (npm monorepo: `synthi/` Next.js app, `backend/collab-server` Node control plane, `backend/vectant-local-support-app` Rust/Tauri desktop daemon, `mcp/synthi-mcp` TypeScript MCP server, `docs/` plan corpus, `tmp/` proof artifacts)
**Scope:** Agent Dojo (vivarium/cortex), CodeSite (repo air-traffic control), the shared-session multi-agent plan, and the Vectant Local Support trust model.
**Analysis date:** 2026-08-25. Derived from source files listed inline; line counts are approximate.

---

## 1. The Big Picture — Three Layers of Distrust

Vectant's agent ecosystem is built around one recurring idea: **never let a claim substitute for proof, and never let proof substitute for scope.** The three systems each attack a different failure mode:

| System | Question it answers | Core artifact | Enforcement point |
|---|---|---|---|
| **Agent Dojo** | "Is this *skill/tool* allowed to do this kind of action, and what evidence says so?" | Proof-Carrying Skill Capsule + Entrustment License | MCP Skill Bus / License Kernel, before any production call |
| **CodeSite** | "May this *agent session* mutate this repo state *right now* without colliding with other live work?" | MutationLease → MutationTransaction → CodeSiteFS boundary | Filesystem/git/runtime write paths in collab-server |
| **Local Support App** | "What exactly left this machine, to whom, under which user-approved capability?" | Signed pairing + per-request capability receipts + hash-chained audit | Rust daemon; local app is final authority |

They compose deliberately (`CODESITE_CONSTRUCTION_COORDINATION_PLAN.md` §6): CodeSite consumes Dojo proof capsules as *one input* to clearance decisions but does not duplicate Dojo's proof system:

```text
DojoLicenseKernelDecision  -> capability & evidence proof ("is this skill licensed?")
CodeSite PolicyDecision    -> allow / block / hold / reroute / inspect / revoke
CodeSite MutationLease     -> live repo mutation capability
CodeSite MutationTransaction -> isolated code change attempt
CodeSiteFS                 -> filesystem boundary enforcement
```

The Local Support app sits orthogonally: it is the *human-side* trust surface for support sessions on a developer's own machine — the same "prove what happened" philosophy applied to remote diagnosis rather than agent autonomy.

A fourth document, `MULTI_HUMAN_MULTI_AGENT_SHARED_SESSION_PROOF_PLAN.md`, defines the product thesis that ties them together: **one live workspace inhabited simultaneously by multiple humans and multiple agents**, with every observation and mutation carrying an identity chain (`workspaceSlug → collaborationSessionId → effectiveWorkspaceUserId → projectId → agentSessionId → executionPlanId → mutationLeaseId → mutationTransactionId → eventId`).

---

## 2. Agent Dojo — The Vivarium Cortex

### 2.1 Concept

Primary spec: `docs/agent_dojo_breakthrough_spec.md` (2,483 lines, 2026-06-10). One-line pitch:

> Teach a workflow once. Dojo grows a synthetic miniature workplace around it, trains the skill inside that safe world, runs a checkride, issues a proof-carrying license, and only then lets agents use the skill under bounded conditions.

Dojo is explicitly positioned as a **competency lab, not an automation builder**. The claimed novelty over RPA/workflow-recording competitors rests on six pillars:

1. **Synthetic workplace organoids** — task-specific practice worlds grown from traces, not full digital twins.
2. **Competency, not automation** — asks whether a skill deserves *entrustment*, not whether it can replay clicks.
3. **Proof before action** — evidence capsule validated before execution, vs. audit-after-action.
4. **Case law, not logs** — failures become binding precedent and reusable guardrails ("antibodies").
5. **Expiring competence** — licenses expire on app release, policy change, incident, or stale evidence.
6. **Substrate graduation** — skills climb a ladder from fragile vision clicks (L1) → DOM/a11y (L2) → source-linked component actions (L3) → API calls (L4) → generated MCP tools (L5).

Real-world models borrowed: organoids, cyber ranges, wind tunnels, FAA checkrides, medical Entrustable Professional Activities, proof-carrying code, safety assurance cases, NASA TRLs, regulatory sandboxes.

### 2.2 Core loop

```text
Teach Mode Trace -> Skill Seed -> Skill Cortex (skill graph)
  -> Workspace Organoid -> Workflow Wind Tunnel -> Skill Checkride
  -> Failure Case Law -> Guardrails/Antibodies -> Entrustment License
  -> Proof-Carrying Skill Capsule -> MCP Skill Bus -> Production Agent Call
  -> New Evidence & Case Law (feedback loop)
```

Key vocabulary (all implemented as TypeScript types in `mcp/synthi-mcp/src/dojo/`):

- **Skill Seed** — smallest unit that can grow a Vivarium: observed trace ref, inferred intent, entities, input/output schemas, candidate preconditions/success assertions/failure modes, touched surfaces, policy & risk clues, source/API anchors, explicit unknowns.
- **Workspace Organoid** — disposable synthetic world with eleven named "tissues": UI, Data, Policy, Identity, Document (incl. prompt-injection payloads), API, Failure, Adversary, Evidence, Source, License.
- **Workflow Wind Tunnel** — mutates conditions around the skill (duplicate clients, hidden validation, fake success toasts, mid-flow auth expiry, currency mixing…) and measures behavior per scenario.
- **Counterfactual Twin** — tiered simulation cost control (T0 static replay → T5 production shadow mode); runner picks cheapest sufficient tier.
- **Evil Twin 2.0** — workflow-specific adversary that reads the skill graph and attacks its assumptions (implemented in `dojo/vivarium/evil_twin.ts` with 15 typed assumption kinds: `entity_uniqueness`, `stable_success_signal`, `auth_continuity`, `document_trust`, `destructive_adjacency`, etc.). Metric: Attack Success Rate against high-risk nodes.
- **Checkride** — three-layer certification: Knowledge / Risk / Skill. "A skill passes because it knows when *not* to act."
- **Entrustment levels E0–EX** — observe-only → vivarium practice → draft-in-production → bounded low-risk execution → audited+rollback broader actions → high-trust signed execution → EX blocked/expired. Skills can *lose* entrustment.
- **SRL 0–9** (Skill Readiness Levels) — maturity staging from raw trace to operational monitored skill.
- **Autonomy License Kernel** — runtime contract per skill call: allowed/constraint/blocked/requires-approval/evidence/expiry clauses; all production execution must route through `MCP Skill Bus → Proof Capsule Validator → License Kernel`; raw browser actions can never bypass it.
- **Case law & antibodies** — failures stored as structured precedent (`failure_type`, `why_it_matters`, guardrail synthesis, license impact), consumed by future runs.
- **Skill Genome** — shareable skill representation designed so skills can be shared without leaking secrets.

Dual product experience: consumer **Personal Skill Cards** (entrustment dial, undo backpack, one-sentence rules, skill passport) and enterprise side where business processes become certified tools reviewed by engineering/security/compliance.

### 2.3 Implementation reality (honest maturity)

`docs/AGENT_DOJO_FULL_MATURE_VIVARIUM_CORTEX_PLAN.md` (~5,000 lines) is unusually candid. It separates:

- **Executable today:** workflow contract from teach data → skill build/export, proof capsule issue/validate, blocking unproven private-tool execution, proof-gated dry run, generated Playwright proof harnesses.
- **Mostly deterministic projection today:** skill-seed extraction, organoid, wind tunnel, checkride, case law, antibodies, governance reports — "useful and generic, but not yet mature product subsystems."
- **Must become real runtime:** graph node execution, scenario materialization, fixture generation, oracle pass/fail, per-node guardrails, signed-evidence verification, substrate execution, durable cross-process revocation.

It lays out Phases 0–20 (truth baseline → execution-boundary hardening → durable Postgres control plane → authoritative evidence ledger → KMS-backed proof signing → executable graph runtime → real organoid/vivarium runner → wind tunnel/evil twin runtime → evidence-backed checkride → case-law runtime → substrate ladder → PR generation → mature MCP skill bus → graph editor UX → consumer cards → governance dashboards → hosted runtime gateway → CI/release gates).

### 2.4 Where the code lives

**`mcp/synthi-mcp/src/dojo/` — 90 TypeScript files in 17 subpackages**, notably:
- `graph/` — compiler, runtime, node registry, guardrail predicates/runtime, assertion runtime, rollback runtime, substrate executor (the Skill Cortex engine).
- `vivarium/` — runner (materializes scenarios with budget tracking, oracle evaluation, API fault injection via a local fault server), `fixture_materializer.ts`, `scenario_dsl.ts`, `oracle.ts`, `mutations.ts`, `api_fault_server.ts`, `evil_twin.ts`, `failure_capsule.ts`.
- `checkride/` — runner, readiness, entrustment decisioning.
- `case_law/` — registry, refusal explainer, antibody matcher, guardrail synthesizer.
- `license/kernel.ts` (wraps the browser-side license kernel), `proof/` (capsule service, Ed25519/key-registry signing, public verifier + export bundle), `evidence/` (claims catalog, custody, ledger store/resolver, redaction, retention, verifier).
- `mcp/` — skill bus, manifest signing, execution policy gate.
- `governance/service.ts` — RBAC-gated governance actions, permission-upgrade requests, scheduled compliance jobs, license revocation.
- `store/` — Postgres stores for proofs, licenses, governance, skills, evidence (incl. ghost/shadow), graph runs, source registries, audit; `control_plane_resolver.ts` builds them from env.
- `regret/` — counterfactual/regret memory (branch traces, fossils, choice scenes, policy deltas, regret arbiter).
- `runtime/` — hosted runtime gateway + resolver; `tomography/` — production runtime state capture ("therapeutic tomography"); `source/` — snapshots, drift detection, PR generator for source affordances; `api/` — endpoint inference and API-tool compilation (substrate ladder L4→L5).
- `config/enforcement.ts` — fail-closed env resolution for proof-signing providers (env key, PEM, or managed KMS URI) and store configs.

**MCP tool surface:** ~69 `synthi_dojo_*` tools registered in `mcp/synthi-mcp/src/tools/dojo.ts` (~1,700-line orchestrator importing across every dojo package): read-side introspection (`get_skill_cortex`, `get_workspace_organoid`, `get_wind_tunnel_report`, `get_evil_twin_report`, `get_skill_passport`, `get_antibodies`, `get_case_law`, …), lifecycle (`capture_source_snapshot`, `detect_source_drift`, `apply_source_drift_expiry`, source-affordance PR prep/branch creation), API-tool compile/run, governance/lifecycle/metrics reports, plus debug/experience features (`run_time_machine_debugger`, `run_ghost_mode`, `explain_block`, `explain_failure`, `debug_counterfactual`).

**UI:** `synthi/src/app/workspace/[slug]/dojo/` routes — main shell (`DojoShell` + 36 components in `synthi/src/components/dojo/`: `SkillCortexGraph`, `CaseLawDashboard`, `CheckrideReportView`, `ProofCapsuleDrawer`, `LicenseHealthBoard`, `RecertificationQueue`, `GhostModePanel`, `RefusalExplainerDrawer`, `ComplianceEvidencePack`, …) with subpages `practice/`, `skills/[skillId]`, `case-law/`, `evidence/`, `governance/`, `source/`, `therapeutic-trace/`, `debug/time-machine`. Plus a standalone `/dojo-release-seed` page.

### 2.5 Release gating culture

`docs/AGENT_DOJO_RELEASE_GATE_RUNBOOK.md` (1,615 lines) codifies the repo's anti-fabrication stance: gate definitions live in `mcp/synthi-mcp/scripts/dojo-release-gate-manifest.mjs`; the runner must be invoked with `--fail-on-missing-env` so **missing external systems produce failed gates, not skipped or faked ones**; a missing-env audit must report `ok=false / promotion_ready=false` when external inputs are absent. External gates include hosted browser workflow E2E, private-tool acceptance (stdio + Codex clients), deployed MCP host conformance, managed-key proof signing observation, GKE live chaos drills, and soak/performance. The **Verifier Rule**: a candidate is incomplete unless the verifier covers all release sections and fails on any missing/stale/fixture-only/self-check-only artifact where real evidence is required. Google Cloud hosting (GKE, Cloud SQL, Memorystore, Secret Manager + External Secrets Operator, Artifact Registry, Cloud Build) is specified end-to-end in the same runbook.

---

## 3. CodeSite — Air Traffic Control for AI Coding Agents

### 3.1 Concept

Primary spec: `docs/CODESITE_CONSTRUCTION_COORDINATION_PLAN.md` (2,902 lines, 2026-06-25). Positioning pivot documented in §1: the first plan used a construction metaphor (permits, inspections, change orders, handover packets) — retained only as the legal layer. The primary model is now:

> **CodeSite is air traffic control for AI coding agents.** Repo = controlled airspace. Agents = aircraft. Tasks = flight plans. Branches/worktrees = runways. Shared files/APIs/schemas/auth/billing/migrations = restricted airspace. Orchestrator = tower. Tests = radar. Conflicts = near-misses. Handover packets = black boxes.

The defensible claim is deliberately narrow: **"enforced live mutation control for concurrent AI work in a repo"** — not generic multi-agent coordination. The senior-engineer framing (§2A): *"CodeSite gives AI agents serializable isolation over a shared repo"* — MVCC repo snapshots + capability security + semantic dependency tracking + assumption invalidation + filesystem-level mutation enforcement + invariant checks + proof-carrying commits + causal replay.

Core primitives:

- **Flight Plan** — filed before work: route globs, altitude band, no-fly zones, abort conditions, requested tools, landing requirements; tower can approve/reroute/delay/split/deny/require higher pilot license. Statuses run `filed → preflight → cleared → taxiing → airborne → holding → rerouted → landing_requested → landed → closed`, plus `denied | aborted | grounded | mayday`.
- **Clearance (user-facing) = MutationLease (internal)** — binds an agent session to paths, tools, contracts, time, owner user, nearby agents, inspection requirements. Answers *"may this agent mutate this repo state right now without colliding?"* — distinct from the Dojo capsule's *"is this kind of action licensed?"*. Dojo proofs are stored as references (`dojo_proof_ref`) with explicit `implementation_status.executable/production_runtime` flags so maturity boundaries appear in every clearance decision.
- **Airspace classes A–D** (implemented verbatim in `synthi/src/lib/codesite/policy.js`): A critical (auth/billing/migrations/prod infra/.env — tower clearance + licensed pilot + inspector signoff + black box), B shared contracts (schemas/openapi/package exports/prisma — flight plan + downstream notification + change order), C feature implementation (auto-clearance + landing inspection), D low-risk docs/tests (micro-clearance + sampled inspection).
- Supporting product surfaces: radar-not-kanban UI, collision prediction, TCAS-style avoidance, black-box replay, mayday mode, tower voice, pilot licenses, landings/inspections, regret memory feeding future ATC policy, repo-local `.synthi/codesite/` artifacts.

### 3.2 Implementation in collab-server (`backend/collab-server/codesite*.js`, ~4,800 LOC)

This is the enforcement layer where plans meet the filesystem. Wired directly into `server.js` (runtime launch, terminal, git service):

- **`codesiteFs.js` (2,755 lines)** — the heart: `CodeSiteFS` class plus path-containment machinery. `resolveCodeSiteRepoPath()` rejects null bytes, absolute paths, `..` traversal, and unresolved symlinks escaping the repo root (`path_escape`, `repo_path_symlink_escape`). Exports a large governed-write surface: `assert/enforceCodeSiteWrite(s)Allowed`, `evaluateCodeSiteWrite`, quarantine workspace creation/finalization (`synthi-codesitefs-quarantine` under tmpdir, schema-versioned manifests), overlay workspace creation, snapshot trees + diffs, process-ancestry collection (procfs, depth ≤ 32) attributing writes to their spawning process chain, proof-carrying commit helpers (`codeSiteCommitTrailers`, `completeCodeSiteCommitProof`), `CodeSiteCommitBlockedError`. Denials raise typed errors (`CODESITE_WRITE_DENIED`/`CODESITE_READ_DENIED`, HTTP 403) carrying structured denial events.
- **`codesiteActiveBoundary.js` (274 lines)** — AsyncLocalStorage-scoped transaction context. A mutation of the *real* workspace is refused unless the ambient context matches an **authoritative, open** active transaction record on *every* identity field: `transactionId` + `mutationLeaseId` + `agentSessionId` + `actorUserId` + `effectiveUserId` (`contextMatchesActiveTransaction`). Produces fail-closed errors: `codesite_active_workspace_context_required` (403) when no context, `codesite_active_workspace_context_mismatch` (403) on mismatch, and 503 when the authority itself is unreachable — refusing to mutate rather than guessing.
- **`codesiteActivityRegistry.js` (658 lines)** — in-memory + JSON-file-persisted registry of active transactions per workspace, TTL-based expiry (default 30 min, refresh timeout 1.5 s), writable-status classification, authoritative-source allowlist (`next_codesite_route`, `codesite_route_activity`, `control_plane_transaction[_read]`), file-lock-guarded state persistence.
- **`codesiteActivityEndpoint.js` (115 lines)** — internal HTTP bridge (`x-collab-internal-token`, env `COLLAB_INTERNAL_TOKEN`/`SYNTHI_COLLAB_INTERNAL_TOKEN`; 503 if unconfigured, 403 on mismatch). GET returns active transactions; POST opens/closes transactions, normalizing caller-supplied control-plane URLs through the trust module. Fail-closed on missing token — never trusts activity claims without shared secret.
- **`codesiteControlPlaneTrust.js` (98 lines)** — the anti-spoofing core for "who is the authority": distinguishes explicitly configured CodeSite endpoints (`SYNTHI_CODESITE_API_BASE_URL`, `CODESITE_API_BASE_URL`, `SYNTHI_CODESITE_BASE_URL`) from generic app origins (`SYNTHI_APP_URL`, `NEXTAUTH_URL`, …) that exist for unrelated reasons. Generic origins may sit on the caller allowlist but the *default authority* consulted when none is supplied comes only from explicit CodeSite config — the comment explains that deriving it from a generic app URL would "fabricate an authority the operator never provisioned." Untrusted URLs are normalized away rather than erroring.
- **`codesiteGitPolicy.js` (144 lines)** — classifies all 35 git actions into boundary scopes (`git_index`, `git_worktree`, `git_refs`, `git_config`, `git_provisioning`) with path scoping rules; drives which git operations pass through the CodeSite boundary.
- **`codesiteHostWriteSentinel.js` (590 lines)** — detects and reverts *unmanaged host writes*: baseline snapshots of watched trees (content + sha256 + restorable baseline copies under tmpdir), a POSIX read-only pre-write guard that chmod-strips write bits tree-wide, verifies the guard actually denies creation via a probe file, restores permissions afterwards, and can restore baselines entry-by-entry (including removing untracked files). Guard failure or unsupported-platform detection fails closed (`CODESITE_HOST_PREWRITE_GUARD_FAILED`/`_UNSUPPORTED`) after rollback.
- **`codesiteReadiness.js` (89 lines)** — health probe chaining collab-server → Next.js control plane `/readiness` using `SYNTHI_CODESITE_TOKEN`; requires both `controlPlaneReachable` and `activityBridgeReachable`, else 503.
- **`codesiteDeploymentStatus.js` (55 lines)** — authenticated deployment status endpoint probing overlay capability and runtime event adapter health; both fail-closed codes when probes absent.

### 3.3 Control plane & surfaces

- **Next.js control plane:** `synthi/src/lib/codesite/controlPlane.js` is a **13,587-line** module implementing projects, membership, agent sessions, execution plans, permits, leases, transactions (open/validate/commit/abort + serializable validation + assumption invalidation), documents/knowledge/inboxes, events, incidents (mayday/resume), channels, inspections, shadow merge simulation, metrics, proof bundles, line provenance. The catch-all API route `synthi/src/app/api/workspace/[slug]/codesite/[[...path]]/route.js` maps ~70 operations behind `requireCodesiteAccess` with rate limiting. `policy.js` implements airspace classes + collision logic; supporting libs cover knowledge routing/redaction, channel security, delivery security, pilot licenses, repo policy compiler, repo snapshots, substrate identity, dojo-proof consumption (`dojoProof.js`, `dojoPublicVerifier.js`).
- **Agent (MCP) surface:** `mcp/synthi-mcp/src/tools/codesite.ts` registers exactly **70 `synthi_codesite_*` tools** — flight plans, RFIs, change orders, mayday declarations, transactions (`open_transaction`, `dry_run_patch`, `apply_patch`, `preflight_write`, `apply_quarantine`), radar/collision prediction, inbox/events, black-box generation, line provenance, landing completion, proof-bundle commits.
- **Human UI:** `synthi/src/app/workspace/[slug]/codesite/page.jsx` renders `CodeSitePanel` (`synthi/src/components/codesite/`) with views: Overview, Activity, Graph, Governance, Inspections, Evidence, Knowledge, Locks, Quarantine, Replay, Simulator (+channels/nav/ui/libs incl. motion & governance helpers).

### 3.4 Shared-session plan (multi-human, multi-agent)

`docs/MULTI_HUMAN_MULTI_AGENT_SHARED_SESSION_PROOF_PLAN.md` (559 lines, validation dated 2026-08-22) states the product decision: Vectant is **not** "an agent per VM with later merging" but one live workspace co-inhabited by humans and agents with independent identities/terminals/permissions. Required jointly: one workspace identity, separate terminals, CRDT live convergence, isolated mutation attempts (transaction overlays/quarantine), shared operational state (programs/logs/ports/tests), durable shared understanding (discoveries/leads/assumptions/skills/handoffs), anticipatory collision prediction, and safe information flow (project ACL + redaction + audit). An automatic synchronization rule derives impact notices from reads/observations instead of relying on agents remembering to share; a Project Coordination Bus normalizes → redacts → classifies → correlates → authorizes → persists → routes events (explicitly "a coordination service, not a group chat server").

Its §4 inventory maps each capability to existing code (Y-Sweet/Yjs collab, PTY routing, guest→host effective workspace identity, Prisma-backed project state, MCP tools, collision policy, assumption invalidation, mutation boundary, quarantine/overlay) — and honestly lists seven gaps found during validation: the default Compose transaction-activity token mismatch (`COLLAB_INTERNAL_TOKEN` not set on both sides), partial agent knowledge routing, no automatic attach of terminal-launched agents, shadow merge being a forecast rather than executed merge by default, fragmented runtime observations, least-privilege review needed on several state-changing routes, and the deployment image lacking test suites. Delivery phases: Phase 0 operational bridge → Phase 1 attached agents/shared context → Phase 2 knowledge synchronization → Phase 3 shared runtime + executable collision resolution → Phase 4 security/production release gate, closed out by a canonical acceptance scenario with required negative tests.

---

## 4. Vectant Local Support App — The Human Trust Surface

**Location:** `backend/vectant-local-support-app/` — Rust workspace (~10,400 LOC in `src/`) + Tauri desktop shell (`desktop/tauri.conf.json`, productName **"Vectant Local Support"**) + Windows installer smoke scripts + `tests/security.rs`.

### 4.1 Trust model (per `PRODUCT.md`)

> A **read-only, session-scoped, workspace-scoped bridge between one local development environment and one Vectant support session.** It reduces manual context sharing while keeping **the local app as the final authority**. Success means users can prove what is available locally, what was requested, what was blocked or redacted, what was actually sent, and how to stop access immediately.

Design principles: show proof not reassurance; make boundaries visible ("available locally" must never look like "sent to Vectant"; browser preview must never imply AI/support read access); keep stop controls close (pause/disconnect/deny/revoke); **fail closed with explanation** (missing/stale/invalid state ⇒ safe denial, zero bytes sent, local event logged); preserve native UX familiarity. Anti-references explicitly reject hidden background agents, RATs, security theatre, and fake activity. Brand voice: calm, plain about risk, transparency as a working control.

### 4.2 Architecture (module map)

Versioned primitives (`lib.rs`): protocol `local-support-mvp.1`, policy `2026.07.05`, scanner `scanner-2026.07.05`.

- **`pair.rs` (772)** — device pairing: ed25519 keypairs, pairing codes with expiry + fingerprint, DPAPI-protected storage on Windows (`VECTANT-DPAPI-V1` prefix), signed pairing proofs and per-request device proofs (nonce/timestamp/session binding).
- **`session.rs` (366)** — `SessionGuard`: bound to account/org/workspace/device-fingerprint, rotating bearer tokens with predecessor grace window, TTL expiry, pause flag, "fast support" countdown, replay protection via seen-request-ids.
- **`workspace.rs` (741)** — the read-only core. Every `FileReadRequest` carries request/session/account/org/workspace IDs, device fingerprint, capability, path, byte cap, **reason string**, actor, and expiry. Responses record decision, approval ID, display path, classification, exact `bytes_sent`, content SHA-256, redactions applied, scanner+policy versions, and a user-visible message. Path resolution uses canonicalized components to block traversal; max 256 KiB/file; SHA-256-rooted `WorkspaceSummary` proves which tree is shared. Commands run only in a **disposable `CommandWorkspaceProjection`** directory — never a view of the actual workspace — self-destructing on drop.
- **`policy.rs` (101)** — data classifications **L0–L5** and decisions `Allow / Deny / ApprovalRequired / RedactThenApproval`, with Once-vs-Session approval scopes and mandatory user-visible logging.
- **`scanner.rs` (137)** — secret scanning before anything leaves the machine (versioned).
- **`approval.rs` (431)** — explicit human approval records tied to requests.
- **`audit.rs` (457)** — append-only, hash-chained local audit log (prev-hash zero-hash genesis, 2 MiB cap) across eleven event classes (Control, Data, FullAccess, Mutation, Command, Process, Budget, Denied, Redaction, Preview, Security), exportable as `local-support-audit-v1`.
- **`full_access.rs` (803)** — the deliberately separate privileged mode ("Full Access"), default-deny on unknown capabilities/fields/scopes/stale receipts/budget exhaustion. Thirteen enumerated capabilities (graph read, command execute, workspace mutate/revert, process/port discovery/use…), risk classes A–E, four narrow process-visibility modes with **no "all processes" variant** — every process record must be justified by a selected workspace or loopback listener scope. Consent receipts included.
- **`mutation.rs` (646)** — even in Full Access there is **no shell write path**: mutations address a current graph node by id + expected content hash, write via same-volume temp file, journal locally, and revert strictly by transaction id; diffs surfaced to the desktop review are content-free summaries (bodies stay in a private recovery file, never serialized outward).
- **`command_broker.rs` (876)** — shell-free, allowlisted executables with argument hashing, timeouts, output caps, secret redaction of stdout/stderr.
- **`preview.rs` / `port_adapter.rs` / `process_adapter.rs`** — localhost browser preview with preview tokens bound to port + process identity, port forwarding, and narrowly validated process inspection.
- **`http.rs` (2,716)** — the local API surface binding all of the above; **`ipc.rs`**, **`desktop.rs`**, **`lifecycle.rs`**, **`update.rs`** complete the shell.
- **`tests/security.rs`** — tests proving the model: capability graph exposes no raw secret paths/bodies; mutations are graph-bound, atomic, revertible, and survive broker restart while denying secret replacement; traversal and secret-file blocks; corrupt audit storage fails closed instead of resetting history.

In short: the same proof-before-trust DNA as Dojo/CodeSite, pointed at the opposite direction of information flow — instead of governing what agents may write to a repo, it governs what bytes may leave a developer's machine, with the human as the licensing kernel.

---

## 5. Proof Artifacts (`tmp/codesite-*-proof`)

Six proof directories exist (Playwright-driven `.mjs` runners emit `.json` evidence + rendered `.html` + `.png` screenshots per proof — the repo's standard "show, don't claim" format):

| Directory | Contents |
|---|---|
| `tmp/codesite-dojo-proof/` | The flagship suite: **208 entries**, ~60 individual proofs (each as json/html/png): active-mutation-boundary, active-transaction-registry, actual-git-commit, black-box-completeness, context-alias, counterfactual-memory, direct-gitService boundary, git-provisioning boundary, gitService index/worktree/index proofs, isolation contract, line-inspector + line-provenance-diff, monitor-downgrade, pathless-run, proof-bundle-git-context, proof-carrying-commit, quarantine-review (+UI shots), radar UI + adapter, release-gate (current/docker/freshness/negative/input-replay/suite-freshness), repo-cache boundary, repo-local autosync, repo-policy-compiler, repo-state-identity, runtime boundary/context/filesystem-hydration/mount-boundary/overlay/quarantine, runway occupancy, schema-first-clearance, serializable-commit-race, shadow simulator (+assumption invalidator panel), terminal-reattach, unmanaged-host boundary, workspace-prep-guard, full-workflow publication bundles, plus `runs/` timestamped mature-suite executions (`codesite-mature-full-proof-2026*`), Codex-agent evidence dirs, trusted-authority manifests |
| `tmp/codesite-governance-gate-proof/` | Governance review-gate UI proof (desktop + mobile png) |
| `tmp/codesite-governance-proof/` | Governance control-plane proof |
| `tmp/codesite-mcp-lifecycle-proof/` | MCP lifecycle proof (desktop/mobile) |
| `tmp/codesite-metrics-proof/` | Human-review-savings metrics proof |
| `tmp/codesite-ui-governance-proof/` | Five timestamped UI-governance captures (cockpit/console/tower-feed/review-gate/reduced-motion screenshots + html/json) |

---

## 6. Cross-Cutting Observations

1. **One philosophy, three domains.** Fail-closed defaults, explicit authority resolution, versioned schemas (`schema_version` fields everywhere), hash chains (audit log, evidence ledger, proof keys), expiring credentials, and structured denial reasons recur in all three systems. Even test failures are treated as findings, not noise — the shared-session doc distinguishes environment-coupled test failures (110/112 passing in-container) from product gaps.
2. **Spec-to-code traceability is unusually tight.** Airspace classes in the plan appear verbatim in `policy.js`; Evil Twin assumption kinds in the spec map to the 15 enum variants in `evil_twin.ts`; flight-plan statuses match control-plane incident/route handling; the ATC vocabulary (radar, locks, quarantine, replay, simulator) is literally the view list of `CodeSitePanel`.
3. **Honesty as a design constraint.** Multiple docs contain "brutal reality"/"honest gap" sections; release gates are designed to fail loudly on missing external inputs; the maturity plan labels subsystems as projection vs. runtime; Dojo proof refs embed `implementation_status` so downstream consumers can't mistake projected maturity for production enforcement.
4. **Identity depth.** Every mutation carries the full chain (workspace → session → effective user → project → agent session → plan → lease → transaction → event). CodeSite's boundary refuses writes unless *all five* identity fields match the authoritative active record — a much stronger guarantee than path ACLs alone.
5. **Layered defense at the FS level.** Managed writes face: path containment + symlink canonicalization → lease/transaction context matching → git-action boundary classification → quarantine/overlay routing → post-hoc host sentinel reverting unmanaged writes → proof-carrying commit trailers. The sentinel's chmod-based pre-write guard with probe verification shows awareness of POSIX limitation edge cases and fails closed on unsupported platforms.
6. **Known weak points** (self-reported): Compose-default token wiring gap breaks automatic transaction-activity propagation; terminal-launched agents aren't auto-attached yet; shadow merge is forecast-by-default; some state-changing routes rely on workspace-read access pending least-privilege review; large parts of the Dojo cortex remain deterministic projections rather than executed runtimes.
7. **Local Support is the philosophical mirror.** Dojo/CodeSite govern agent autonomy over repos; Local Support governs human-mediated data egress from machines — both refuse to let "connected" mean anything beyond what can be shown: actor, scope, decision, outcome, and a working stop button.

---

## 7. Key File Index

```text
docs/
  agent_dojo_breakthrough_spec.md ............ Dojo concept bible (2,483 ln)
  AGENT_DOJO_FULL_MATURE_VIVARIUM_CORTEX_PLAN.md  20-phase maturity plan + honest gaps
  AGENT_DOJO_RELEASE_GATE_RUNBOOK.md ......... fail-closed release gates + GCP hosting
  CODESITE_CONSTRUCTION_COORDINATION_PLAN.md . CodeSite ATC concept + roadmap (2,902 ln)
  MULTI_HUMAN_MULTI_AGENT_SHARED_SESSION_PROOF_PLAN.md  shared-session thesis + gap audit

mcp/synthi-mcp/src/dojo/ .................... 90 TS files / 17 pkgs (graph, vivarium,
                                              checkride, case_law, license, proof,
                                              evidence, mcp skill bus, governance,
                                              store/postgres, regret, runtime, tomography)
mcp/synthi-mcp/src/tools/dojo.ts ............ ~69 synthi_dojo_* MCP tools
mcp/synthi-mcp/src/tools/codesite.ts ........ 70 synthi_codesite_* MCP tools

backend/collab-server/codesite*.js .......... ~4,800 LOC enforcement layer
  codesiteFs.js (2,755) · HostWriteSentinel (590) · ActivityRegistry (658) ·
  ActiveBoundary (274) · GitPolicy (144) · ActivityEndpoint (115) ·
  ControlPlaneTrust (98) · Readiness (89) · DeploymentStatus (55)

backend/vectant-local-support-app/ .......... Rust daemon + Tauri desktop (~10.4k LOC)
  PRODUCT.md trust model · pair/session/workspace/policy/scanner/approval/audit/
  full_access/mutation/command_broker/preview modules · tests/security.rs

synthi/src/lib/codesite/controlPlane.js ..... 13,587-line control-plane core
synthi/src/lib/codesite/policy.js ........... airspace classes A–D + collision logic
synthi/src/app/api/workspace/[slug]/codesite/[[...path]]/route.js  REST surface
synthi/src/app/workspace/[slug]/codesite/ ... CodeSitePanel (11 views)
synthi/src/app/workspace/[slug]/dojo/ ....... Dojo UI (8 pages) + components/dojo/ (36)

tmp/codesite-dojo-proof/ .................... 208-entry flagship proof suite
tmp/{governance,governance-gate,mcp-lifecycle,metrics,ui-governance}-proof/
```
