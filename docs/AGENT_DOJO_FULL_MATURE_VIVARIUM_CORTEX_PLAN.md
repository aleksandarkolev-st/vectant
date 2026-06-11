# Agent Dojo Full Mature Vivarium Cortex Implementation Plan

**Status:** planning document for completing the mature product universe  
**Date:** 2026-06-11  
**Repo:** `vectant-ade`  
**Branch context:** `feat/agent-dojo-vivarium-cortex`  
**Purpose:** define exactly what remains to build before Agent Dojo can honestly be called a full mature Vivarium Cortex product rather than a broad executable core loop and architecture-shaped prototype.

---

## Executive Summary

The current implementation is a credible generic Dojo spine:

- taught browser workflow data can become a `SkillSeed`
- a `DojoSkill` can be built from a workflow contract
- scenarios, checkride reports, case law, guardrails, licenses, proof capsules, MCP tool exposure, repo artifacts, and UI summaries exist
- proof-gated execution exists for backing private workflow tools
- focused unit tests, self-check scripts, Docker validation, and Playwright visual proof exist for the current scope

It is not yet the full mature Vivarium Cortex universe described in the spec.

The major difference is this:

```text
Current system:
  Workflow contract -> deterministic Dojo artifacts and proof-gated workflow execution

Mature system:
  Workflow evidence -> executable graph runtime -> real synthetic workplace -> real scenario mutation
  -> evidence-backed checkride -> enforceable case law and guardrails
  -> durable license/proof/evidence control plane
  -> source/API substrate promotion
  -> enterprise UX and governance
```

The remaining work is not only more surface area. It is several production subsystems:

- executable Skill Cortex graph runtime
- real Workspace Organoid / Vivarium runner
- real Wind Tunnel and Checkride execution against synthetic fixtures and oracles
- authoritative append-only evidence ledger
- KMS-backed proof capsule service
- tenant-aware Dojo control plane
- source/API inference and tool compiler
- generated PR system for Agent-Ready UI Contracts
- enterprise graph editor UX
- consumer skill-card/passport UX
- governance dashboards
- deployed MCP host conformance
- security, chaos, soak, and compliance validation gates

This plan is intentionally direct. If this document is completed, the claim can move from:

```text
We implemented the generic Vivarium Cortex core loop.
```

to:

```text
We implemented a mature Vivarium Cortex product universe with executable practice worlds,
runtime guardrails, proof-backed licenses, governed MCP skills, source/API graduation,
and reviewable enterprise UX.
```

---

## Inputs Used

This plan incorporates four audits:

1. **Backend/runtime audit**
   - Current Dojo backend is strong architecture-shaped prototype.
   - Main gaps: static checkride, metadata organoid, no graph interpreter, non-authoritative evidence, shallow source/API substrate ladder.

2. **Frontend/product UX audit**
   - Current UI is a compact workflow drawer with Dojo credential state.
   - Main gaps: no enterprise graph editor, no dedicated passport, no practice-world explorer, no governance dashboards, no real Ghost Mode UX.

3. **Source/API/security audit**
   - Source identity, Agent-Ready UI Contract artifacts, private tool manifests, proof signing, encrypted stores, and deployment readiness exist in prototype form.
   - Main gaps: no signed source snapshots, no real API inference, no real PR generation, no KMS/HSM, no durable ledger, no tenant-aware control plane.

4. **Validation/release audit**
   - Repo-local Dojo validation is credible.
   - Main gaps: full test suite not green, no deployed third-party MCP host conformance, no chaos/soak/performance gates, no production evidence custody proof.

---

## Current Implementation Inventory

### Backend And Runtime Files

Current files that matter:

- `mcp/synthi-mcp/src/browser/dojo.ts`
  - core Dojo types and builders
  - `extractDojoSkillSeed`
  - `generateDojoVivariumScenarios`
  - `runDojoCheckride`
  - `buildDojoSkill`
  - `issueDojoProofCapsule`
  - `validateDojoProofCapsule`
  - `exportDojoRepoArtifacts`
  - graph, organoid, wind tunnel, counterfactual twin, evil twin, case law, antibodies, license, passport, skill card, agent-ready UI contract report builders

- `mcp/synthi-mcp/src/browser/dojo_vivarium.ts`
  - synthetic scenario run wrapper
  - wind tunnel execution wrapper
  - currently selects precomputed checkride results rather than executing a synthetic environment

- `mcp/synthi-mcp/src/browser/dojo_license_kernel.ts`
  - validates proof capsule
  - checks registry issuance, revocation, replay, expiry, workspace, origin, action, and proof validation

- `mcp/synthi-mcp/src/browser/dojo_store.ts`
  - in-memory store
  - AES-256-GCM encrypted file store
  - proof record persistence and revocation

- `mcp/synthi-mcp/src/browser/dojo_universe.ts`
  - universe dossier
  - lifecycle report
  - governance report
  - metrics
  - evidence ledger report
  - source affordance PR plan
  - package readiness
  - time-machine debug report
  - organization registry report

- `mcp/synthi-mcp/src/tools/dojo.ts`
  - MCP tool surface for Dojo
  - skill listing, skill details, cortex/organoid/wind/counterfactual/evil twin/training/passport/genome/UI contract/cost policy
  - proof issuing, validation, revocation, proof-gated run
  - vivarium run, wind tunnel run, license health, case law recording, license revocation

- `mcp/synthi-mcp/src/tools/browser.ts`
  - backing browser/private workflow tools
  - direct private workflow calls are proof-gated for Dojo-published tools

- `mcp/synthi-mcp/src/browser/private_tool_manifest.ts`
  - private workflow tool manifest generation

- `mcp/synthi-mcp/src/browser/private_tool_registry.ts`
  - private workflow tool store and registry

- `mcp/synthi-mcp/src/browser/source_identity.ts`
  - source identity token registration and lookup

- `mcp/synthi-mcp/src/tools/source.ts`
  - source mapping and affordance patch suggestion tool surface

- `mcp/synthi-mcp/src/browser_workflow_bridge/server.ts`
  - bridge state and Dojo panel projection

### Frontend Files

Current UI files that matter:

- `synthi/src/components/agent-workflows/AgentWorkflowPanel.jsx`
  - workflow teaching/status drawer
  - compact Dojo credential card
  - Dojo action buttons
  - state normalization for latest Dojo reports

- `synthi/src/components/docking-wm/panels/panel-wrappers.jsx`
  - dispatches workflow and Dojo tool actions
  - persists Dojo artifacts through handoff

- `synthi/src/services/agentWorkflowClient.js`
  - bridge HTTP client

- `synthi/src/services/agentWorkflowHandoff.js`
  - workflow and Dojo artifact file export helpers

### Current Validation Evidence

Current proof exists for:

- MCP typecheck
- MCP build
- focused Dojo unit tests
- Dojo store unit tests
- browser workflow bridge unit tests
- frontend Agent Workflow Panel tests
- frontend build
- durable Dojo self-check
- generated Playwright harness execution
- Docker rebuild and running services
- Playwright visual proof through workflow bridge

Current proof does not yet cover:

- full MCP unit suite green
- deployed third-party MCP host conformance
- non-loopback production hosted runtime conformance
- real synthetic fixture mutation
- real source/API promotion
- durable append-only evidence ledger
- KMS-backed proof signing
- tenant-aware persistence and authorization
- chaos, soak, performance, and compliance gates

---

## Honest Current Gap Statement

The current implementation defines most of the nouns of the Vivarium Cortex universe. It does not yet implement all of those nouns as production systems.

### What Is Executable Today

- Teach-mode workflow data can become a workflow contract.
- A workflow contract can become a Dojo skill.
- Dojo skill artifacts can be exported.
- A proof capsule can be issued and validated.
- Direct backing private workflow execution can be blocked without proof.
- A proof-gated dry run can validate the path.
- A compact UI card can surface status and trigger Dojo tools.
- A generated Playwright proof harness can be executed.

### What Is Mostly Deterministic Projection Today

- Skill Seed extraction
- Workspace Organoid
- Wind Tunnel
- Checkride
- Case Law
- Antibodies
- Agent-Ready UI Contract
- Source affordance PR plan
- Universe dossier
- Governance report
- Evidence ledger report
- Package readiness

These are useful and generic, but they are not yet mature product subsystems.

### What Must Become Real Runtime

- graph node execution
- scenario materialization
- mock UI/API/data/document/auth fixtures
- oracle-based scenario pass/fail decisions
- per-node guardrail evaluation
- proof claim verification against signed evidence
- source/API substrate execution
- approval and governance enforcement
- durable revocation and replay prevention across processes

---

## Definition Of Fully Implemented

Agent Dojo Vivarium Cortex is fully implemented only when all of these statements are true.

### Core Product Loop

1. A human demonstration produces a Skill Seed with trace, intent, entities, inputs, outputs, policies, source/API anchors, risk clues, unknowns, and evidence references.
2. The Skill Seed compiles into an executable Skill Cortex graph.
3. The graph can execute through a runtime that honors preconditions, branches, retries, assertions, guardrails, permissions, rollback, human decisions, proof requirements, and expiry.
4. A Workspace Organoid creates a disposable synthetic workplace for the skill.
5. The Workflow Wind Tunnel mutates the synthetic workplace and runs the skill against actual fixtures.
6. The Checkride evaluates knowledge, risk, and skill using observed runtime evidence and deterministic oracles.
7. Failures become case law only when backed by evidence and reviewer status.
8. Case law creates guardrail predicates that execute in the graph runtime.
9. A license is issued only for tested scope.
10. A proof capsule is issued only when its claims are verified against signed evidence.
11. Production execution routes through MCP Skill Bus -> proof validator -> license kernel -> Dojo runtime -> app runtime.
12. Raw browser/private workflow execution cannot bypass the license in production.
13. Production action produces new evidence and may update case law, license health, and recertification state.

### Enterprise Maturity

1. Tenants, organizations, workspaces, app releases, skills, skill versions, licenses, proof records, evidence records, approvals, and audit events are durable.
2. Proof signing uses KMS/HSM-backed keys or a production-grade signing service.
3. Evidence ledger is append-only, tamper-evident, redacted, and verifiable.
4. Source mappings are release-scoped, signed, drift-detected, and CI-gated.
5. Agent-Ready UI Contracts are versioned, schema-validated, and enforced.
6. Source/API substrate promotion can generate reviewable patches and API-backed tools.
7. Org-wide registry, governance dashboards, approval queues, recertification workflows, and case-law review exist.
8. Deployed MCP host conformance is proven outside a local loopback environment.
9. Security, privacy, compliance, chaos, soak, and performance gates pass.

### UX Maturity

1. Casual users get Skill Cards, Entrustment Dial, Practice History, Ask Before Rules, Safe Mode, Proof Badge, Undo Backpack, and Skill Passport.
2. Enterprise users get Skill Cortex graph editor, node inspector, organoid explorer, wind tunnel matrix, checkride report, source/API mappings, proof capsule lifecycle, case law registry, governance dashboards, and artifact exports.
3. Every refusal can explain the rule, case law, evidence, and smallest allowed next step.
4. Every risky action visibly shows license status and proof requirement before execution.

---

## Target Architecture

### High-Level Runtime Architecture

```text
Human Demonstration
  -> Trace Ingestion Service
  -> Skill Seed Extractor
  -> Source/API/Policy Enrichment
  -> Skill Cortex Compiler
  -> Executable Skill Graph
  -> Workspace Organoid Generator
  -> Vivarium Fixture Services
  -> Workflow Wind Tunnel Runner
  -> Checkride Runner
  -> Evidence Ledger
  -> Case Law Engine
  -> Guardrail Synthesizer
  -> License Kernel
  -> Proof Capsule Service
  -> MCP Skill Bus
  -> Dojo Runtime
  -> App Runtime
  -> Evidence / Monitoring / Recertification
```

### Control Plane Architecture

```text
Tenant / Org / Workspace Registry
  -> App Release Registry
  -> Source Contract Registry
  -> Skill Registry
  -> License Registry
  -> Proof Record Registry
  -> Evidence Ledger
  -> Approval Queue
  -> Case Law Registry
  -> Antibody Registry
  -> Governance Dashboard
  -> Compliance Exporter
```

### Data Plane Architecture

```text
Agent or Copilot
  -> MCP Skill Bus
  -> Tool Manifest Resolver
  -> Proof Capsule Validator
  -> License Kernel
  -> Guardrail Runtime
  -> Skill Cortex Runtime
  -> Substrate Executor
      -> MCP Tool
      -> API Client
      -> Source-Linked Component Action
      -> DOM Executor
      -> Vision Executor
  -> Assertion Runtime
  -> Evidence Writer
  -> Audit Event Writer
```

### Vivarium Architecture

```text
Skill Seed
  -> Scenario DSL
  -> Synthetic Data Generator
  -> UI Tissue Generator
  -> API Mock/Fault Server
  -> Auth/Identity Simulator
  -> Policy Simulator
  -> Document Corpus Generator
  -> Source Contract Fixture
  -> Reset Profile
  -> Scenario Runner
  -> Oracle Evaluator
  -> Evidence Exporter
```

---

## Proposed Codebase Structure

The current `dojo.ts` file is too large to become the mature product. Split it into modules with clear ownership.

### Backend Module Layout

Recommended new structure:

```text
mcp/synthi-mcp/src/dojo/
  index.ts
  types/
    core.ts
    seed.ts
    graph.ts
    scenario.ts
    checkride.ts
    evidence.ts
    license.ts
    proof.ts
    governance.ts
    source_contract.ts
    api_contract.ts
  seed/
    extractor.ts
    intent_inference.ts
    entity_inference.ts
    policy_inference.ts
    source_enrichment.ts
    schema_inference.ts
  graph/
    compiler.ts
    runtime.ts
    node_registry.ts
    node_evaluator.ts
    guardrail_runtime.ts
    assertion_runtime.ts
    rollback_runtime.ts
    substrate_selector.ts
    graph_diff.ts
  vivarium/
    scenario_dsl.ts
    scenario_generator.ts
    organoid_generator.ts
    fixture_materializer.ts
    synthetic_data.ts
    ui_tissue.ts
    api_tissue.ts
    identity_tissue.ts
    policy_tissue.ts
    document_tissue.ts
    reset_profiles.ts
    runner.ts
    oracle.ts
    wind_tunnel.ts
  checkride/
    suite_builder.ts
    runner.ts
    scoring.ts
    entrustment.ts
    readiness.ts
  evidence/
    ledger.ts
    ledger_store.ts
    redaction.ts
    claims.ts
    signer.ts
    verifier.ts
    retention.ts
    export.ts
  license/
    kernel.ts
    policy.ts
    expiry.ts
    recertification.ts
    approval.ts
  proof/
    capsule_service.ts
    signing.ts
    registry.ts
    replay.ts
    public_verifier.ts
  case_law/
    registry.ts
    classifier.ts
    guardrail_synthesizer.ts
    conflict_resolution.ts
    appeals.ts
  source/
    source_contract.ts
    source_snapshot.ts
    source_drift.ts
    affordance_planner.ts
    codemod.ts
    pr_generator.ts
  api/
    network_trace.ts
    endpoint_inference.ts
    schema_inference.ts
    auth_scope_inference.ts
    idempotency.ts
    wrapper_generator.ts
    api_tool_compiler.ts
  mcp/
    skill_bus.ts
    manifest_signing.ts
    tool_registry.ts
    dispatcher.ts
    conformance.ts
  governance/
    control_plane.ts
    registry.ts
    dashboards.ts
    audit.ts
    rbac.ts
    compliance_export.ts
  artifacts/
    repo_export.ts
    assurance_case.ts
    passport.ts
    training_report.ts
    playwright_export.ts
  store/
    interfaces.ts
    memory_store.ts
    encrypted_file_store.ts
    postgres_store.ts
    migrations.ts
```

Compatibility layer:

```text
mcp/synthi-mcp/src/browser/dojo.ts
mcp/synthi-mcp/src/browser/dojo_vivarium.ts
mcp/synthi-mcp/src/browser/dojo_license_kernel.ts
mcp/synthi-mcp/src/browser/dojo_store.ts
mcp/synthi-mcp/src/browser/dojo_universe.ts
```

These should become adapters that re-export or wrap the new `src/dojo/*` modules until callers migrate.

### Frontend Module Layout

Recommended new frontend surfaces:

```text
synthi/src/app/workspace/[slug]/dojo/
  page.jsx
  skills/page.jsx
  skills/[skillId]/page.jsx
  skills/[skillId]/passport/page.jsx
  skills/[skillId]/cortex/page.jsx
  practice/page.jsx
  governance/page.jsx
  case-law/page.jsx
  evidence/page.jsx
  debug/time-machine/page.jsx

synthi/src/components/dojo/
  SkillCardGrid.jsx
  ConsumerSkillCard.jsx
  SkillPassport.jsx
  EntrustmentTimeline.jsx
  LicenseScopeTable.jsx
  ProofBadge.jsx
  ProofCapsuleDrawer.jsx
  ProofValidationTimeline.jsx
  SkillCortexGraph.jsx
  CortexToolbar.jsx
  CortexNode.jsx
  CortexEdge.jsx
  CortexNodeInspector.jsx
  CortexEdgeInspector.jsx
  CortexMinimap.jsx
  CortexDiffOverlay.jsx
  VivariumScenarioList.jsx
  OrganoidFixtureViewer.jsx
  WindTunnelMatrix.jsx
  ScenarioEvidenceDrawer.jsx
  CheckrideReportView.jsx
  RefusalExplainerDrawer.jsx
  CaseLawRegistry.jsx
  AntibodyRegistry.jsx
  GovernanceOverview.jsx
  ApprovalQueue.jsx
  PolicyGateTable.jsx
  LicenseHealthBoard.jsx
  AuditExportPanel.jsx
  TimeMachineDebugger.jsx
  GhostModePanel.jsx
  HumanVsAgentActionDiff.jsx
  SourceAffordancePrPlan.jsx
```

State services:

```text
synthi/src/services/dojoClient.js
synthi/src/services/dojoState.js
synthi/src/services/dojoArtifacts.js
```

Keep `AgentWorkflowPanel.jsx` as a compact cockpit and launcher. Do not keep adding all mature product functionality into that one drawer.

---

## Data Model Required For Maturity

The current system stores skills and proof records. Mature Dojo needs durable data models with tenancy, versioning, audit, and immutability semantics.

### Tenant And Workspace

Required entities:

- `Tenant`
- `Organization`
- `Workspace`
- `User`
- `Role`
- `PolicySet`
- `AuditActor`

Required fields:

- tenant ID
- organization ID
- workspace ID
- data residency region
- encryption key reference
- retention policy
- allowed model providers
- allowed runtime substrates
- approval policy
- audit policy

Acceptance criteria:

- every skill, license, proof, evidence record, and tool registration is tenant-scoped
- cross-tenant reads are impossible through API and store layer tests
- audit events record actor, workspace, tenant, request ID, and correlation ID

### App Release And Source Snapshot

Required entities:

- `AppRelease`
- `SourceMapSnapshot`
- `SourceToken`
- `ComponentAction`
- `RouteContract`
- `AgentReadyUiContract`

Required fields:

- app origin
- release version
- commit SHA
- source map hash
- framework adapter
- source token IDs
- component file path
- stable action name
- source locator
- risk annotation
- proof requirement
- allowed substrate
- blocked contexts
- compatibility status

Acceptance criteria:

- source tokens are scoped by app release
- source drift invalidates affected skill licenses
- UI contracts fail CI when breaking changes occur without migration
- graph nodes can reference signed source contracts rather than raw labels

### Skill And Graph

Required entities:

- `Skill`
- `SkillVersion`
- `SkillSeed`
- `SkillCortexGraph`
- `WorkflowNode`
- `WorkflowEdge`
- `NodeMemory`
- `GraphExecutionRun`

Required fields:

- graph version
- node kind
- node preconditions
- node postconditions
- node guardrail predicates
- node proof requirements
- node substrate options
- node evidence policy
- node case law references
- node expiry triggers
- edge condition
- edge confidence
- edge observed variants
- graph validation status

Acceptance criteria:

- graph can be interpreted by runtime
- every dangerous action is preceded by an enforced guardrail or permission node
- graph diff can show what changed between skill versions
- graph nodes can be disabled, expired, or recertified independently

### Vivarium And Scenario

Required entities:

- `WorkspaceOrganoid`
- `OrganoidVersion`
- `OrganoidTissue`
- `Scenario`
- `ScenarioSuite`
- `ScenarioRun`
- `SyntheticFixture`
- `Oracle`
- `ResetProfile`

Required fields:

- synthetic-data-only flag
- fixture ID
- scenario mutation kind
- simulator tier
- expected behavior
- oracle definition
- reset instructions
- fixture materialization hash
- evidence refs
- cost budget
- scenario provenance

Acceptance criteria:

- scenario can be materialized into a runnable fixture
- scenario run produces observed evidence
- oracle determines pass, fail, block, or needs-human from observed evidence
- fixture reset is deterministic and tested
- no production data is required for organoid runs

### Evidence Ledger

Required entities:

- `EvidenceArtifact`
- `EvidenceLedgerRecord`
- `EvidenceClaim`
- `RedactionManifest`
- `RetentionPolicy`
- `LedgerCheckpoint`

Required fields:

- record ID
- tenant ID
- workspace ID
- skill ID
- run ID
- artifact type
- artifact digest
- redaction digest
- previous hash
- current hash
- signer key ID
- signature
- timestamp
- retention class
- legal hold
- source refs

Acceptance criteria:

- ledger append is atomic
- old record modification breaks verification
- proof claims can be verified against ledger records
- repo exports contain redacted metadata and references, not secrets
- evidence retention and deletion policy are enforceable

### License And Proof

Required entities:

- `PermissionLicense`
- `LicenseVersion`
- `ProofCapsule`
- `ProofRecord`
- `ProofNonce`
- `Approval`
- `Revocation`
- `LicenseHealth`

Required fields:

- license scope
- entrustment level
- readiness level
- allowed actions
- gated actions
- blocked actions
- required context claims
- required evidence claims
- required guardrails
- approval requirements
- substrate requirements
- expiry policy
- signing key ID
- proof nonce
- proof status
- proof use timestamp

Acceptance criteria:

- proof issuance requires evidence verification
- proof validation fails closed
- proof use is atomic across processes
- proof replay fails across restarts
- license revocation blocks existing capsules
- license downgrade propagates to MCP skill bus

### MCP Skill Bus

Required entities:

- `McpSkillManifest`
- `ToolRegistration`
- `ToolVersion`
- `ToolCaller`
- `ToolInvocation`
- `McpHostConformanceResult`

Required fields:

- tenant scope
- tool name
- tool version
- skill ID
- license ID
- manifest digest
- signed manifest
- caller identity
- proof requirement
- direct-call policy
- rate limit
- audit event refs

Acceptance criteria:

- raw scripts are not exposed as production competencies
- skill bus lists only licensed competencies for the caller
- every production call carries proof or is blocked
- deployed host conformance passes outside loopback
- tool manifests are signed and revocable

---

## Phase 0: Truth Baseline And Guardrails

### Goal

Stop ambiguity. Establish a source-of-truth status document and enforce that current scaffold pieces are not mistaken for full maturity.

### Work Items

1. Add `docs/AGENT_DOJO_IMPLEMENTATION_STATUS.md`.
2. Classify every Dojo feature as one of:
   - `executable`
   - `deterministic_projection`
   - `report_only`
   - `planned`
3. Add a machine-readable maturity manifest:

```text
.synthi/dojo/maturity/implementation-status.json
```

4. Add runtime metadata fields:
   - `implementation_status`
   - `evidence_backing`
   - `runtime_enforced`
   - `simulation_backing`
5. Update Dojo reports to avoid implying that static projections are runtime-executed.

### Acceptance Criteria

- every Dojo MCP tool response declares whether it is report-only or runtime-enforced
- docs and UI do not claim full synthetic execution where only report building happened
- validation summary distinguishes repo-local proof from deployed production proof

---

## Phase 1: Production Execution Boundary Hardening

### Goal

Make it impossible for a published Dojo skill to execute through raw workflow or private tool paths without the Dojo license/proof path.

### Current State

The current implementation blocks direct backing private workflow tool calls for Dojo-published private tools. That is useful. It is not enough for mature production because raw workflow execution surfaces and process-local stores can still be bypass risks depending on deployment mode.

### Backend Work

1. Add a `DojoExecutionPolicyGate`.

Suggested file:

```text
mcp/synthi-mcp/src/dojo/mcp/dispatcher.ts
```

Responsibilities:

- identify workflow IDs that are bound to Dojo-published skills
- block direct browser workflow execution for those workflows in production mode
- block direct private tool execution unless the dispatcher receives validated Dojo execution context
- require proof capsule for all production actions within licensed scope
- allow explicit non-production practice modes only when isolated and marked

2. Add production mode config.

Required environment variables:

- `SYNTHI_DOJO_PRODUCTION_ENFORCEMENT=1`
- `SYNTHI_DOJO_REQUIRE_DURABLE_STORE=1`
- `SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING=1`
- `SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER=1`

3. Update deployment readiness checks.

Suggested file:

```text
mcp/synthi-mcp/src/browser/deployment_readiness.ts
```

New failures:

- default proof signing key in production
- in-memory Dojo store in production
- no proof replay durable store
- no evidence ledger configured
- local CDP used in production
- bridge binds externally without token
- Dojo-published workflow can execute raw
- private tool store is process-local in production

4. Add atomic proof use.

The current `markProofCapsuleUsed` is store-level but needs database-level atomic compare-and-set semantics.

Required behavior:

```text
issued -> used succeeds exactly once
issued -> revoked blocks use
used -> used blocks replay
revoked -> used blocks
```

5. Add proof validation error taxonomy.

Examples:

- `proof_capsule_missing`
- `proof_capsule_not_issued`
- `proof_capsule_revoked`
- `proof_capsule_replay_detected`
- `proof_signature_invalid`
- `proof_evidence_claim_unverified`
- `license_expired`
- `license_revoked`
- `action_not_licensed`
- `substrate_not_allowed`
- `workspace_mismatch`
- `origin_mismatch`
- `approval_required`
- `guardrail_failed`

### Tests

Add tests:

```text
mcp/synthi-mcp/tests/unit/dojo_execution_boundary.test.ts
mcp/synthi-mcp/tests/unit/dojo_deployment_readiness.test.ts
mcp/synthi-mcp/tests/integration/dojo_proof_replay.test.ts
```

Test cases:

- direct private tool call blocked without proof
- raw workflow replay blocked for Dojo-published workflow in production
- proof dry-run does not mark proof used
- successful production execution marks proof used
- second production execution with same proof fails
- revoked proof fails
- expired proof fails
- license revocation blocks proof
- in-memory store fails readiness when production enforcement is enabled
- default signing key fails readiness when production enforcement is enabled

### Acceptance Criteria

- no production execution path can bypass Dojo proof validation
- proof replay prevention survives process restart with durable store
- deployment readiness fails closed for insecure Dojo production configuration

---

## Phase 2: Durable Dojo Control Plane

### Goal

Replace process-local and single-file beta persistence with a production-grade tenant-aware control plane.

### Current State

`InMemoryDojoSkillStore` and `EncryptedFileDojoSkillStore` exist. They are useful for local development and sensitive local-only modes. They are not sufficient for enterprise multi-user, multi-process, audited production.

### Backend Work

1. Define store interfaces with transaction boundaries.

Suggested file:

```text
mcp/synthi-mcp/src/dojo/store/interfaces.ts
```

Required interfaces:

- `DojoSkillStore`
- `DojoLicenseStore`
- `DojoProofStore`
- `DojoEvidenceStore`
- `DojoApprovalStore`
- `DojoAuditStore`
- `DojoCaseLawStore`
- `DojoSourceContractStore`

2. Implement Postgres store.

Suggested files:

```text
mcp/synthi-mcp/src/dojo/store/postgres_store.ts
mcp/synthi-mcp/src/dojo/store/migrations.ts
```

Required tables:

- `dojo_tenants`
- `dojo_workspaces`
- `dojo_app_releases`
- `dojo_source_snapshots`
- `dojo_source_tokens`
- `dojo_skills`
- `dojo_skill_versions`
- `dojo_skill_graphs`
- `dojo_node_memories`
- `dojo_licenses`
- `dojo_license_versions`
- `dojo_proof_records`
- `dojo_evidence_records`
- `dojo_checkride_runs`
- `dojo_scenario_runs`
- `dojo_case_law`
- `dojo_antibodies`
- `dojo_approvals`
- `dojo_tool_registrations`
- `dojo_audit_events`

3. Add tenancy constraints.

Every query must require:

- `tenant_id`
- `workspace_id` where applicable
- actor identity for write operations

4. Add audit events.

Events:

- skill created
- skill version created
- checkride run started
- checkride run completed
- license issued
- license revoked
- proof issued
- proof validated
- proof used
- proof rejected
- case law proposed
- case law approved
- guardrail activated
- source contract changed
- skill expired
- permission upgrade requested
- approval granted
- approval denied

5. Add migrations and schema tests.

### Tests

Add:

```text
mcp/synthi-mcp/tests/integration/dojo_postgres_store.test.ts
mcp/synthi-mcp/tests/integration/dojo_tenant_isolation.test.ts
mcp/synthi-mcp/tests/integration/dojo_audit_log.test.ts
```

Test cases:

- skill persists across process restart
- proof replay prevention is atomic across concurrent callers
- tenant A cannot read tenant B skills
- license revocation emits audit event
- checkride evidence references are durable
- schema migration preserves existing records

### Acceptance Criteria

- production mode can run without any in-memory Dojo store
- proof records are atomically consumed in Postgres
- all writes produce audit events
- tenant isolation is tested at store layer and tool layer

---

## Phase 3: Authoritative Evidence Ledger

### Goal

Make proof capsules depend on independently verifiable evidence, not caller-provided booleans or report-generated refs.

### Current State

`buildDojoEvidenceLedger` creates a report-style hash chain over references. It is not an authoritative ledger over evidence bytes, redaction manifests, signatures, retention state, and claim verification.

### Backend Work

1. Add evidence ledger module.

Suggested files:

```text
mcp/synthi-mcp/src/dojo/evidence/ledger.ts
mcp/synthi-mcp/src/dojo/evidence/ledger_store.ts
mcp/synthi-mcp/src/dojo/evidence/redaction.ts
mcp/synthi-mcp/src/dojo/evidence/claims.ts
mcp/synthi-mcp/src/dojo/evidence/verifier.ts
mcp/synthi-mcp/src/dojo/evidence/export.ts
```

2. Define append-only record.

Required fields:

- `record_id`
- `tenant_id`
- `workspace_id`
- `skill_id`
- `run_id`
- `kind`
- `artifact_uri`
- `artifact_sha256`
- `redaction_manifest_sha256`
- `claim_ids`
- `previous_hash`
- `record_hash`
- `ledger_head_hash`
- `signer_key_id`
- `signature`
- `created_at`
- `created_by`
- `retention_class`
- `legal_hold`

3. Define evidence claim verifier.

Supported claim types:

- `checkride_passed`
- `critical_failures_open`
- `guardrails_active`
- `client_id_verified`
- `line_items_total_verified`
- `workspace_verified`
- `origin_verified`
- `substrate_allowed`
- `source_anchor_current`
- `approval_not_required`
- `approval_granted`
- `evidence_fresh`

4. Add redaction pipeline.

Redaction must handle:

- screenshots
- HTML snapshots
- trace payloads
- API responses
- cookies
- local storage
- auth tokens
- email addresses
- user-entered text
- file names
- document text

5. Add tamper verification.

APIs:

- `appendEvidenceRecord`
- `verifyLedgerHead`
- `verifyRecordChain`
- `verifyArtifactDigest`
- `verifyRedactionManifest`
- `resolveEvidenceClaims`
- `exportRedactedEvidenceManifest`

6. Update proof capsule issuance.

`issueDojoProofCapsule` must:

- ask the evidence verifier to resolve claims
- include evidence record IDs, not only string refs
- refuse to sign if required claims are unverified
- include ledger checkpoint hash

### Tests

Add:

```text
mcp/synthi-mcp/tests/unit/dojo_evidence_ledger.test.ts
mcp/synthi-mcp/tests/unit/dojo_evidence_redaction.test.ts
mcp/synthi-mcp/tests/integration/dojo_proof_evidence_claims.test.ts
```

Test cases:

- appending records updates head hash
- modifying old record breaks chain verification
- missing redaction manifest blocks repo export
- required claim not backed by evidence blocks proof issuance
- stale evidence blocks proof issuance
- proof capsule validates only when ledger checkpoint matches

### Acceptance Criteria

- proof capsules are evidence-backed
- evidence records are tamper-evident
- repo artifacts never contain raw secrets or production payloads
- proof validation can explain which evidence claim failed

---

## Phase 4: KMS-Backed Proof Capsule Service

### Goal

Move from local HMAC proof signing to production-grade proof issuing and verification.

### Current State

Proof capsules use HMAC-SHA256 with env-configured signing key and default fallback risk. That is acceptable for prototype validation but not for enterprise production.

### Backend Work

1. Add proof service module.

Suggested files:

```text
mcp/synthi-mcp/src/dojo/proof/capsule_service.ts
mcp/synthi-mcp/src/dojo/proof/signing.ts
mcp/synthi-mcp/src/dojo/proof/key_registry.ts
mcp/synthi-mcp/src/dojo/proof/replay.ts
mcp/synthi-mcp/src/dojo/proof/public_verifier.ts
```

2. Support asymmetric signing.

Supported algorithms:

- `ed25519`
- `ecdsa-p256-sha256`
- optional KMS provider adapters

3. Add key registry.

Fields:

- key ID
- issuer
- algorithm
- public key
- status
- created at
- rotated at
- revoked at
- tenant scope

4. Add key rotation.

Rules:

- new capsules use active key
- old capsules validate against valid historical public keys until expiration
- revoked keys invalidate capsules unless explicitly retained for forensic validation

5. Add public verifier.

The verifier must validate:

- schema version
- issuer
- key ID
- signature
- license version
- skill version
- evidence ledger checkpoint
- expiration
- nonce

6. Remove default signing key behavior in production.

Production readiness must fail if proof signing falls back to a default local key.

### Tests

Add:

```text
mcp/synthi-mcp/tests/unit/dojo_proof_signing.test.ts
mcp/synthi-mcp/tests/integration/dojo_proof_key_rotation.test.ts
```

Test cases:

- valid capsule verifies with public key
- tampered context claim fails
- tampered evidence claim fails
- wrong key ID fails
- expired key fails for new issuance
- old capsule remains verifiable under rotation policy
- default key fails production readiness

### Acceptance Criteria

- proof capsules are cryptographically verifiable outside the issuing process
- production proof signing does not depend on a local shared secret fallback
- key rotation is tested
- proof record nonce prevents replay across process restarts

---

## Phase 5: Executable Skill Cortex Graph Runtime

### Goal

Turn Skill Cortex from graph-shaped data into an executable runtime.

### Current State

`skillCortexFor` builds nodes and transitions. It does not execute nodes, branches, retries, rollbacks, guardrails, proof nodes, case law nodes, or expiry nodes.

### Backend Work

1. Add graph compiler.

Suggested file:

```text
mcp/synthi-mcp/src/dojo/graph/compiler.ts
```

Responsibilities:

- compile `WorkflowContractV7` and `SkillSeed` into graph IR
- validate node invariants
- insert required permission nodes before risky actions
- insert guardrail nodes before dangerous operations
- insert assertion nodes after mutations
- insert proof nodes before production actions
- insert expiry nodes for release/policy/evidence drift

2. Add graph runtime.

Suggested file:

```text
mcp/synthi-mcp/src/dojo/graph/runtime.ts
```

Responsibilities:

- execute graph nodes
- maintain run state
- evaluate preconditions
- choose branches
- execute retries
- call human nodes
- perform rollback nodes
- emit evidence
- consult license kernel
- enforce guardrails
- call substrate executor

3. Add node registry.

Node handlers:

- `Trigger`
- `Input`
- `Observe`
- `Locate`
- `Action`
- `Assertion`
- `Branch`
- `Permission`
- `Guardrail`
- `Retry`
- `Artifact`
- `Subskill`
- `Human`
- `Rollback`
- `Memory`
- `Adversary`
- `Checkride`
- `Proof`
- `CaseLaw`
- `Expiry`

4. Add guardrail predicate DSL.

Examples:

```text
client_id_verified == true
amount <= 500
currency == "EUR"
duplicate_display_name_count == 0
line_items_total_verified == true
proof_capsule_valid == true
source_anchor_current == true
approval_status != "denied"
```

5. Add assertion runtime.

Assertion types:

- DOM assertion
- API response assertion
- database/mock-state assertion
- downloaded artifact checksum
- source hook assertion
- human approval assertion

6. Add rollback runtime.

Rollback strategies:

- field restore
- file restore
- record delete when draft-only
- compensating API call
- mark for human review
- no rollback available with explicit blocked escalation

### Tests

Add:

```text
mcp/synthi-mcp/tests/unit/dojo_graph_compiler.test.ts
mcp/synthi-mcp/tests/unit/dojo_graph_runtime.test.ts
mcp/synthi-mcp/tests/unit/dojo_guardrail_runtime.test.ts
mcp/synthi-mcp/tests/integration/dojo_runtime_proof_gate.test.ts
```

Test cases:

- dangerous action requires guardrail node
- missing proof node fails graph validation for production action
- branch chooses duplicate-client path
- assertion failure triggers rollback or human review
- expired node blocks execution
- case-law guardrail blocks action
- human node pauses run and persists state
- retry node stops after configured limit

### Acceptance Criteria

- graph execution produces `DojoRun` records from actual node execution
- every production action passes through permission, guardrail, proof, and assertion checks
- runtime can explain exactly which node blocked or failed
- graph can resume after human approval

---

## Phase 6: Real Workspace Organoid And Vivarium Runner

### Goal

Turn Workspace Organoid from a manifest into disposable synthetic practice infrastructure.

### Current State

`workspaceOrganoidFor` returns tissue summaries. `runDojoVivariumScenario` materializes fixture metadata and selects a precomputed result. No synthetic app/API/document/auth environment is actually created or mutated.

### Backend Work

1. Add scenario DSL.

Suggested file:

```text
mcp/synthi-mcp/src/dojo/vivarium/scenario_dsl.ts
```

Core concepts:

- scenario ID
- mutation kind
- target graph nodes
- fixture requirements
- input overrides
- expected behavior
- oracle
- simulator tier
- reset strategy
- cost budget

2. Add synthetic fixture materializer.

Suggested file:

```text
mcp/synthi-mcp/src/dojo/vivarium/fixture_materializer.ts
```

Fixture types:

- synthetic DOM snapshot
- synthetic page route
- fake API server
- fake database state
- fake auth session
- fake documents
- fake approvals
- fake validation errors
- fake latency and partial failures

3. Add API mock/fault server.

Required behaviors:

- success response
- validation error
- latency
- timeout
- partial write
- stale entity
- duplicate entity
- downstream failure
- fake success while state fails

4. Add document tissue generator.

Required fake docs:

- clean PDF-like text artifact
- receipt-like artifact
- contract-like artifact
- ambiguous file names
- prompt injection text
- missing fields
- corrupted file

5. Add identity tissue.

States:

- normal user
- downgraded role
- expired auth
- missing permission
- unavailable approver
- changed workspace

6. Add UI tissue.

Mutations:

- button moved
- button hidden in menu
- validation below fold
- reordered table
- duplicate labels
- misleading toast
- destructive button near safe button
- changed label
- modal appears

7. Add reset profiles.

Requirements:

- deterministic fixture seed
- clean reset after each run
- record reset evidence
- fail if reset cannot be proven

### Tests

Add:

```text
mcp/synthi-mcp/tests/unit/dojo_scenario_dsl.test.ts
mcp/synthi-mcp/tests/unit/dojo_fixture_materializer.test.ts
mcp/synthi-mcp/tests/integration/dojo_vivarium_runner.test.ts
mcp/synthi-mcp/tests/integration/dojo_api_fault_server.test.ts
```

Test cases:

- duplicate entity scenario creates two records with same display name and different stable IDs
- fake success scenario shows success UI while API state fails
- auth expiry scenario expires session mid-flow
- prompt injection document is present but not executed as instruction
- reset restores initial fixture state
- synthetic-only policy rejects production data refs

### Acceptance Criteria

- a scenario run executes against materialized synthetic fixtures
- pass/fail/block is based on observed runtime evidence
- scenario fixture can be reproduced from seed and manifest
- no production data is required
- reset is deterministic and proven

---

## Phase 7: Workflow Wind Tunnel And Evil Twin As Runtime Systems

### Goal

Make Wind Tunnel and Evil Twin execute targeted attacks against the skill graph and measure outcomes.

### Current State

Wind tunnel and evil twin reports are generated from scenario sets and static heuristics. They do not actively attack weak assumptions in an executable environment.

### Backend Work

1. Add assumption extractor.

Inputs:

- graph nodes
- assertions
- source anchors
- failed runs
- case law
- license constraints
- user inputs

Outputs:

- assumed uniqueness
- assumed visibility
- assumed stable order
- assumed success signal
- assumed auth continuity
- assumed role permission
- assumed currency
- assumed file identity
- assumed document trust
- assumed API atomicity

2. Add attack generator.

Attack types:

- duplicate entity
- fake success
- moved control
- hidden validation
- reordered table
- stale ID
- auth expiry
- role downgrade
- currency mismatch
- prompt injection
- partial write
- latency timeout
- unavailable approver
- destructive adjacency

3. Add attack runner.

The runner must:

- materialize scenario
- execute graph
- collect evidence
- compute expected behavior
- classify actual behavior
- update attack success rate

4. Add attack success definition.

Attack succeeds if it causes:

- wrong action
- unsafe action
- unhandled stop condition
- false success
- missing evidence
- proof issued incorrectly
- guardrail not triggered

5. Add hardening loop.

For each successful attack:

- create failure record
- propose case law
- synthesize guardrail
- rerun targeted scenario
- update license scope
- update training report

### Tests

Add:

```text
mcp/synthi-mcp/tests/integration/dojo_evil_twin_runner.test.ts
mcp/synthi-mcp/tests/integration/dojo_wind_tunnel_hardening.test.ts
```

Test cases:

- duplicate display name attack triggers stable ID guardrail after hardening
- fake success attack requires API-state assertion
- prompt injection document does not alter task instructions
- partial write blocks success assertion
- attack success rate decreases after guardrail insertion

### Acceptance Criteria

- Evil Twin reads the graph and creates targeted scenarios
- attacks execute in Vivarium
- attack success rate is measured from observed outcomes
- at least one failure class becomes an enforced runtime guardrail

---

## Phase 8: Evidence-Backed Checkride

### Goal

Make entrustment and SRL depend on executable results, not static heuristics.

### Current State

`runDojoCheckride` evaluates generated scenarios using contract-level and scenario-level heuristics. It is useful as scaffolding but not mature certification.

### Backend Work

1. Add checkride suite builder.

Inputs:

- skill graph
- scenario suite
- case law
- license target
- risk level
- substrate options

Outputs:

- knowledge tests
- risk tests
- skill execution tests
- critical failure tests
- blocked scenario tests

2. Add executable checkride runner.

The runner must:

- run scenario materialization
- execute graph
- collect evidence
- run oracle
- classify result
- compute coverage
- compute false allow and false block estimates
- recommend entrustment
- produce assurance case evidence

3. Add scoring model.

Metrics:

- knowledge pass rate
- risk pass rate
- skill pass rate
- critical failures
- blocked scenarios
- attack success rate
- coverage score
- false allow rate
- false block rate
- substrate reliability
- evidence completeness

4. Add entrustment decision policy.

Example:

```text
E1 requires seed + basic organoid
E2 requires success assertions + no critical safety failures
E3 requires license constraints + active guardrails + evidence
E4 requires stable substrate + rollback + shadow runs
E5 requires high coverage + low false allow + signed assurance case
EX applies on drift, incident, stale evidence, revocation
```

5. Add SRL decision policy.

SRL must be calculated from actual artifacts and runs:

- SRL 0 raw trace only
- SRL 1 seed exists
- SRL 2 graph compiled
- SRL 3 assertions defined
- SRL 4 organoid generated
- SRL 5 checkride passed in synthetic scenarios
- SRL 6 shadow mode passed
- SRL 7 limited production license issued
- SRL 8 stable substrate available
- SRL 9 operational monitoring and case law feedback

### Tests

Add:

```text
mcp/synthi-mcp/tests/integration/dojo_checkride_runner.test.ts
mcp/synthi-mcp/tests/unit/dojo_entrustment_policy.test.ts
mcp/synthi-mcp/tests/unit/dojo_srl_policy.test.ts
```

Test cases:

- happy path alone cannot issue E3 if risk tests fail
- critical failure blocks production license
- blocked scenario can be acceptable if license excludes that context
- stale evidence downgrades license
- shadow run mismatch prevents E4

### Acceptance Criteria

- checkride executes scenarios against runtime
- entrustment derives from evidence-backed results
- SRL derives from real maturity artifacts
- license limitations match failed and blocked scenarios

---

## Phase 9: Case Law And Antibody Runtime

### Goal

Turn failure memory into enforceable, reviewable, reusable organizational precedent.

### Current State

Case law and antibodies are generated from checkride failures as data artifacts. They are not yet governed records with review, conflict resolution, propagation, appeal, or runtime matching.

### Backend Work

1. Add case law registry.

Fields:

- case ID
- title
- finding
- impact
- rule created
- applies to
- binding scope
- status
- reviewer
- evidence refs
- superseded by
- appeal status

2. Add guardrail synthesizer.

Guardrail output:

- predicate
- blocked actions
- severity
- scope
- evidence source
- false block risk
- review requirement

3. Add antibody matcher.

The matcher must:

- compare new skill graph nodes to known failure patterns
- identify matching risk contexts
- propose inherited guardrails
- require local practice/checkride before binding

4. Add conflict resolution.

Cases can conflict:

- broad guardrail blocks useful work
- new policy supersedes old case
- local workspace exception needed
- case law deprecated

5. Add refusal explanation generator.

Every block must include:

- blocked action
- blocking rule
- case law citation
- evidence
- required condition to proceed
- permission upgrade path if applicable

### Frontend Work

Add:

- `CaseLawRegistry`
- `CaseLawDetail`
- `AntibodyRegistry`
- `GuardrailProvenance`
- `RefusalExplainerDrawer`
- `CaseLawReviewQueue`

### Tests

Add:

```text
mcp/synthi-mcp/tests/unit/dojo_case_law_registry.test.ts
mcp/synthi-mcp/tests/unit/dojo_antibody_matcher.test.ts
mcp/synthi-mcp/tests/integration/dojo_case_law_guardrail_runtime.test.ts
```

Test cases:

- binding case creates enforced guardrail
- proposed case does not enforce until approved
- deprecated case no longer blocks
- workspace-scope case does not affect other workspace
- organization-scope antibody can be proposed to related skills
- refusal cites correct case law

### Acceptance Criteria

- important failures become reviewable cases
- approved case law creates runtime guardrails
- refusal explanations cite case law
- antibodies can transfer patterns without transferring private data

---

## Phase 10: Source-Aware Substrate Ladder

### Goal

Allow skill graph nodes to graduate from vision/DOM replay to source-linked component actions, APIs, and generated MCP tools.

### Current State

Source identity and source anchors exist. Agent-Ready UI Contract artifacts and source affordance PR plans exist. The system does not yet infer broad API anchors, generate real patches, or execute source/API substrate nodes.

### Backend Work

1. Add source snapshot service.

Responsibilities:

- capture source tokens per release
- sign snapshots
- detect drift
- map source tokens to routes/components/actions
- invalidate affected skill nodes on drift

2. Add Agent-Ready UI Contract schema package.

Required schema:

- `affordance_id`
- `component`
- `route`
- `role`
- `risk`
- `required_inputs`
- `success_condition`
- `approval_policy`
- `stable_locator`
- `proof_required`
- `allowed_substrate`
- `blocked_contexts`
- `source_version`
- `contract_version`

3. Add CI linter.

Checks:

- stable locator exists
- action risk annotation exists
- success hook exists for risky writes
- proof hook exists for proof-required actions
- accessibility label exists
- blocked contexts are testable
- contract is backward compatible or migration exists

4. Add source-linked action executor.

This executor should not directly call arbitrary component internals in unsafe ways. It should call reviewed affordance hooks or generated wrappers that enforce proof and policy.

5. Add API inference pipeline.

Inputs:

- browser network traces
- source route handlers
- OpenAPI specs
- GraphQL schema
- tRPC/RPC definitions
- backend controller files
- app logs from synthetic runs

Outputs:

- endpoint candidates
- method
- path
- request schema
- response schema
- auth scope
- mutation class
- idempotency
- rollback strategy
- postcondition
- proof claim mapping

6. Add API-backed MCP tool compiler.

Generated tool requirements:

- strict input schema
- proof capsule requirement
- license validation
- auth scope check
- idempotency key
- assertion after execution
- evidence write
- rollback or compensating action policy

### Frontend Work

Add:

- `SourceAffordancePrPlan`
- `SourceContractCoverage`
- `SubstrateLadderView`
- `NodeSubstrateInspector`
- `ApiCandidateReview`
- `GeneratedToolReview`

### Tests

Add:

```text
mcp/synthi-mcp/tests/unit/dojo_source_contract.test.ts
mcp/synthi-mcp/tests/unit/dojo_agent_ready_ui_contract.test.ts
mcp/synthi-mcp/tests/unit/dojo_api_inference.test.ts
mcp/synthi-mcp/tests/integration/dojo_api_tool_compiler.test.ts
```

Test cases:

- source drift expires affected license
- missing proof hook fails UI contract lint
- API candidate requires review before production
- API tool enforces proof and license
- source/API substrate produces same postcondition as UI replay

### Acceptance Criteria

- at least one workflow node can graduate from UI replay to API/MCP with tests
- generated PR plan can become a real patch
- Agent-Ready UI Contracts are validated in CI
- source drift causes license expiry or recertification

---

## Phase 11: Generated PR System

### Goal

Move from JSON PR plans to real reviewable source changes.

### Current State

`buildDojoSourceAffordancePrPlan` creates proposed patch metadata. It does not edit source, run codemods, create tests, create branches, or open PRs.

### Backend Work

1. Add codemod engine.

Support first:

- React JSX/TSX
- Vite React
- Next.js React

Later:

- Vue
- Svelte
- Angular
- server-rendered templates

2. Add patch generator.

Patch types:

- stable test/action IDs
- semantic action attributes
- risk annotations
- success hooks
- proof validation hooks
- sandbox fixtures
- accessibility labels
- deterministic reset profiles

3. Add test generator.

Generated tests:

- component test for stable affordance
- Playwright test for action path
- contract lint test
- proof hook test
- blocked context test

4. Add PR workflow.

Steps:

- create branch
- apply patch
- run formatter
- run tests
- generate PR description
- attach Dojo artifacts
- request code owners
- mark as generated by Dojo

5. Add review gates.

PR cannot promote source/API substrate unless:

- tests pass
- code owner approves
- security/policy reviewer approves for risky actions
- source contract snapshot is updated

### Tests

Add:

```text
mcp/synthi-mcp/tests/integration/dojo_affordance_codemod.test.ts
mcp/synthi-mcp/tests/integration/dojo_generated_pr_plan.test.ts
```

Test cases:

- codemod adds stable action ID without altering behavior
- codemod is idempotent
- generated tests fail before patch and pass after patch
- generated PR description includes license and proof impact

### Acceptance Criteria

- Dojo can create a reviewable source patch for a controlled React app
- source patch includes tests
- PR artifacts include Skill Assurance Case and UI contract
- code owner gates are represented in generated review metadata

---

## Phase 12: Mature MCP Skill Bus

### Goal

Expose certified competencies, not raw scripts, with tenant-aware authorization and deployed host conformance.

### Current State

Dojo tools are statically advertised. Backing private tools are generated and proof-gated. Production-grade registry, signed manifests, caller authorization, version pinning, rate limits, and deployed host conformance are not complete.

### Backend Work

1. Add skill bus module.

Suggested files:

```text
mcp/synthi-mcp/src/dojo/mcp/skill_bus.ts
mcp/synthi-mcp/src/dojo/mcp/tool_registry.ts
mcp/synthi-mcp/src/dojo/mcp/manifest_signing.ts
mcp/synthi-mcp/src/dojo/mcp/dispatcher.ts
mcp/synthi-mcp/src/dojo/mcp/conformance.ts
```

2. Add signed tool manifests.

Fields:

- tool name
- tool version
- skill ID
- license ID
- schema digest
- allowed actions
- proof required
- substrate policy
- issuer
- signature

3. Add caller authorization.

Checks:

- actor identity
- tenant
- workspace
- role
- tool permission
- license visibility
- approval authority

4. Add version pinning.

Rules:

- agents call specific skill/tool version
- new version requires explicit publish
- old version can be revoked
- proof capsule includes skill and license version

5. Add rate limits and audit.

Per:

- tenant
- workspace
- skill
- actor
- action

6. Add deployed host conformance suite.

Must test:

- local loopback host
- non-loopback deployed MCP host
- strict schema clients
- external private tool store
- hosted browser runtime
- proof-gated execution
- revocation propagation

### Tests

Add:

```text
mcp/synthi-mcp/tests/integration/dojo_mcp_skill_bus.test.ts
mcp/synthi-mcp/tests/live/dojo_mcp_host_conformance.test.ts
```

Test cases:

- skill bus lists only authorized skills
- direct raw backing tool hidden or blocked
- signed manifest validates
- revoked tool no longer callable
- old proof cannot call new license version
- deployed host rejects local CDP leakage

### Acceptance Criteria

- all production skill calls go through skill bus
- deployed host conformance passes
- signed manifest and proof are independently verifiable
- caller authorization is enforced

---

## Phase 13: Enterprise Skill Cortex Graph Editor

### Goal

Build the enterprise UI for inspecting, editing, validating, and approving the living skill graph.

### Current State

The current frontend has a compact Dojo credential card in the Agent Workflow panel. There is no graph canvas, node inspector, edge inspector, graph diff, or enterprise review workflow.

### Frontend Work

1. Add route:

```text
synthi/src/app/workspace/[slug]/dojo/cortex/page.jsx
```

2. Add graph components:

- `SkillCortexGraph`
- `CortexToolbar`
- `CortexNode`
- `CortexEdge`
- `CortexNodeInspector`
- `CortexEdgeInspector`
- `CortexMinimap`
- `CortexDiffOverlay`
- `CortexFilterBar`

3. Add graph visual semantics.

Path colors:

- green: licensed and well-tested
- yellow: allowed with approval or low confidence
- red: blocked
- purple: adversarially tested
- gray: observed but not certified
- blue: proof-carrying execution available
- black: expired or revoked

4. Add node inspector sections.

For every node:

- intent
- node kind
- inputs
- outputs
- preconditions
- postconditions
- confidence
- allowed contexts
- forbidden contexts
- observed variants
- failure history
- guardrails
- evidence refs
- license constraints
- execution substrates
- cost profile
- checkride results
- proof requirements
- case law refs
- expiry triggers
- source/API anchors

5. Add editing workflows.

Editable fields:

- guardrail rule
- branch condition
- human approval requirement
- evidence requirement
- blocked context
- retry limits
- rollback policy
- substrate preference

Editing rules:

- edits create draft graph version
- draft cannot execute production until checkride passes
- edits are audit logged
- risky edits require reviewer approval

6. Add graph validation.

Validation checks:

- dangerous action has guardrail
- production action has proof node
- mutation has assertion
- high-risk action has evidence
- rollback exists or explicit no-rollback warning exists
- expired source anchors block production
- case law refs valid

### Tests

Add:

```text
synthi/src/components/dojo/__tests__/SkillCortexGraph.test.jsx
synthi/src/components/dojo/__tests__/CortexNodeInspector.test.jsx
synthi/src/components/dojo/__tests__/CortexDiffOverlay.test.jsx
```

Playwright visual proof:

- graph renders nonblank
- node selection opens inspector
- filters work
- graph does not overlap at desktop/mobile
- blocked path shown red
- proof path shown blue
- expired node shown black

### Acceptance Criteria

- enterprise user can inspect the full Skill Cortex graph
- every node exposes operational memory
- graph edits create draft versions
- graph validation blocks unsafe production publish
- visual proof validates graph rendering

---

## Phase 14: Consumer Skill Cards And Skill Passport

### Goal

Create the casual user experience that hides graph complexity while preserving scope, refusal, and proof clarity.

### Frontend Work

1. Add route:

```text
synthi/src/app/workspace/[slug]/dojo/skills/page.jsx
```

2. Add components:

- `SkillCardGrid`
- `ConsumerSkillCard`
- `SkillCardDetail`
- `EntrustmentDial`
- `AskBeforeRules`
- `WillNotDoList`
- `PracticeHistory`
- `ProofBadge`
- `UndoBackpack`
- `SafeModeToggle`

3. Add passport route:

```text
synthi/src/app/workspace/[slug]/dojo/skills/[skillId]/passport/page.jsx
```

4. Add passport components:

- `SkillPassportHeader`
- `LicenseScopeTable`
- `EntrustmentTimeline`
- `ReadinessLevelPanel`
- `BlockedContextsPanel`
- `CaseLawReferences`
- `ProofRequirementsPanel`
- `ExpiryPanel`
- `PublishedToolsPanel`

5. Add one-sentence rule UX.

Input examples:

- never send without asking
- only submit expenses under 50 EUR
- if two people match, ask me
- do not delete anything

Backend output:

- proposed license constraint
- guardrail predicate
- approval requirement
- conflict warnings

### Tests

Add:

```text
synthi/src/components/dojo/__tests__/ConsumerSkillCard.test.jsx
synthi/src/components/dojo/__tests__/SkillPassport.test.jsx
synthi/src/components/dojo/__tests__/EntrustmentDial.test.jsx
```

### Acceptance Criteria

- casual user can understand what the skill can do alone, ask before, and never do
- passport is exportable and matches backend skill passport
- proof badge reflects license and proof state
- changing ask-before rules updates license draft, not production license until approved/checkridden

---

## Phase 15: Practice World UX

### Goal

Make the Vivarium visible, inspectable, and operable.

### Frontend Work

1. Add route:

```text
synthi/src/app/workspace/[slug]/dojo/practice/page.jsx
```

2. Add components:

- `PracticeWorldDashboard`
- `VivariumScenarioList`
- `OrganoidTissueViewer`
- `ScenarioRunner`
- `WindTunnelMatrix`
- `EvilTwinAttackTable`
- `ScenarioEvidenceDrawer`
- `CoverageScorePanel`
- `CostBudgetPanel`

3. Add scenario interactions.

User can:

- generate scenarios
- inspect scenario mutation
- run one scenario
- run wind tunnel with budget
- inspect pass/fail/block
- convert failure to case law
- add guardrail
- rerun impacted branch

4. Add synthetic-data proof.

Every fixture view should show:

- synthetic-only status
- fixture seed
- redaction status
- data policy
- no production data references

### Tests

Add:

```text
synthi/src/components/dojo/__tests__/PracticeWorldDashboard.test.jsx
synthi/src/components/dojo/__tests__/WindTunnelMatrix.test.jsx
synthi/src/components/dojo/__tests__/ScenarioEvidenceDrawer.test.jsx
```

Playwright proof:

- scenario list renders
- running scenario updates evidence
- wind tunnel matrix renders all statuses
- failure can open case law draft

### Acceptance Criteria

- practice world is inspectable
- scenario run results are evidence-backed
- wind tunnel budget and stop reason are visible
- user can see why a scenario passed, failed, or blocked

---

## Phase 16: Refusal, Proof, Time Machine, And Ghost Mode UX

### Goal

Build the product magic surfaces that make bounded trust understandable.

### Refusal UX

Components:

- `RefusalExplainerDrawer`
- `BlockedActionSummary`
- `CaseLawCitation`
- `GuardrailPredicateView`
- `PermissionUpgradePath`

Acceptance:

- every blocked action explains rule, case, evidence, and next step
- refusal never says only generic policy block when case law exists

### Proof Capsule UX

Components:

- `ProofBadge`
- `ProofCapsuleDrawer`
- `ProofClaimsTable`
- `ProofValidationTimeline`
- `ProofRevocationControl`
- `ProofReplayWarning`

Acceptance:

- user can inspect issued, used, revoked, expired proofs
- proof claims link to evidence records
- proof revocation is visible in license health

### Time Machine Debugger UX

Components:

- `TimeMachineDebugger`
- `CounterfactualBranchPicker`
- `BeforeAfterOutcome`
- `CausalVariableTable`
- `LicenseImpactPanel`

Acceptance:

- user selects failed scenario
- user changes one variable
- UI shows baseline and counterfactual outcome
- UI explains license impact

### Ghost Mode UX

Components:

- `GhostModePanel`
- `HumanVsAgentActionDiff`
- `ShadowRunEvidence`
- `MismatchBadge`

Acceptance:

- Ghost Mode does not execute production actions
- human action and agent planned action are compared
- mismatch prevents entrustment upgrade
- evidence is written as shadow evidence

---

## Phase 17: Governance, Registry, And Compliance Dashboards

### Goal

Make Dojo manageable as an enterprise system.

### Backend Work

1. Add governance control plane.

Capabilities:

- skill registry
- license lifecycle
- approvals
- recertification jobs
- stale license expiration
- incident-triggered downgrade
- case law review
- policy templates
- audit export
- RBAC
- SSO identity mapping

2. Add scheduled jobs.

Jobs:

- expire stale evidence
- expire on app release drift
- expire on policy change
- run recertification queue
- recompute registry metrics
- notify approvers
- archive evidence

3. Add compliance exports.

Exports:

- Skill Assurance Case
- license history
- proof capsule history
- evidence ledger manifest
- approval log
- case law registry
- audit trail
- source/API contract coverage

### Frontend Work

Add route:

```text
synthi/src/app/workspace/[slug]/dojo/governance/page.jsx
```

Components:

- `GovernanceOverview`
- `SkillRegistryTable`
- `ApprovalQueue`
- `PolicyGateTable`
- `LicenseHealthBoard`
- `RecertificationQueue`
- `CaseLawReviewQueue`
- `AuditExportPanel`
- `ComplianceEvidencePack`

### Tests

Add:

```text
mcp/synthi-mcp/tests/integration/dojo_governance.test.ts
synthi/src/components/dojo/__tests__/GovernanceDashboard.test.jsx
```

Acceptance:

- operator can revoke license
- operator can approve permission upgrade
- expired license moves to EX
- compliance export contains required artifacts
- dashboard metrics match backend registry

---

## Phase 18: Hosted Runtime Gateway

### Goal

Replace static local CDP assumptions with tenant-isolated, short-lived hosted runtime sessions.

### Current State

Hosted runtime attaches to configured CDP endpoints and repo-local validation uses loopback. Mature production needs a runtime gateway with isolation, short-lived credentials, policy, audit, and revocation.

### Backend Work

1. Add runtime gateway.

Responsibilities:

- create browser session
- bind session to tenant/workspace/skill run
- issue short-lived connection credentials
- enforce egress policy
- enforce consent and origin policy
- redact screenshots/logs
- revoke sessions
- record action audit

2. Add runtime session model.

Fields:

- session ID
- tenant ID
- workspace ID
- skill ID
- run ID
- actor ID
- origin allowlist
- created at
- expires at
- revoked at
- evidence refs

3. Add network policy.

Policies:

- allowed origins
- blocked origins
- no metadata service
- no local network unless explicitly allowed
- no cross-workspace cookies

4. Add runtime readiness.

Production readiness must fail if:

- static CDP endpoint is used
- credentials are long-lived
- session is not tenant-scoped
- no origin allowlist exists
- screenshot redaction disabled for sensitive workspace

### Tests

Add:

```text
mcp/synthi-mcp/tests/integration/dojo_hosted_runtime_gateway.test.ts
mcp/synthi-mcp/tests/live/dojo_hosted_runtime_conformance.test.ts
```

Acceptance:

- session is isolated per tenant
- credentials expire
- revoked session cannot execute
- origin policy blocks unexpected workspace
- runtime actions produce audit and evidence records

---

## Phase 19: Validation, CI, And Release Gates

### Goal

Create objective proof that the mature universe works.

### Required Local Gates

PowerShell commands:

```powershell
npm --prefix mcp\synthi-mcp run typecheck
npm --prefix mcp\synthi-mcp run build
npm --prefix mcp\synthi-mcp run test:unit
cd synthi
npm run lint
npm run build
npm test -- src/components/agent-workflows src/components/dojo src/services
```

Acceptance:

- zero failures
- no unrelated failures hidden inside release gate
- quarantined failures require explicit issue IDs and non-release scope

### Dojo Proof Gate

Command:

```powershell
npm --prefix mcp\synthi-mcp run proof:dojo:self-check
```

Acceptance:

- skill generated
- proof capsule issued
- raw private tool blocked
- proof dry-run passes
- production execution consumes proof exactly once
- Vivarium scenario executes actual fixture
- Wind Tunnel executes actual scenarios
- generated Playwright passes
- artifacts parse
- artifacts have no secrets

### Docker Integration Gate

Command:

```powershell
$env:NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS='1'
$env:AI_ENGINE_HOST_PORT='8081'
$env:POSTGRES_HOST_PORT='15432'
docker compose up -d --build --force-recreate
docker compose ps
```

Acceptance:

- `frontend` running
- `collab-server` running
- `mcp` running
- `worker` running
- `signaling-server` running
- `ai-gateway` running
- `ai-engine` running
- `y-sweet` healthy
- `postgres` healthy
- `redis` healthy
- `coturn` running
- `/workspace` returns 200
- `/ports` returns 200

### Workflow E2E Gate

Command:

```powershell
$env:SYNTHI_HOSTED_BROWSER_CDP_URL='<hosted-cdp>'
$env:SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP='1'
$env:SYNTHI_WORKFLOW_PIPELINE_TIMEOUT_MS='300000'
npm --prefix mcp\synthi-mcp run live:browser:workflow-pipeline
```

Acceptance:

- no failed checks in summary
- generated workflow scripts execute
- fresh MCP evidence exists
- hosted attach used
- local attach not used for production proof
- no fixed forwarded port literals in generated artifacts

### Private Tool Acceptance Gate

Commands:

```powershell
npm --prefix mcp\synthi-mcp run live:browser:private-tool-stdio
npm --prefix mcp\synthi-mcp run live:browser:private-tool-codex
```

Acceptance:

- strict schema works
- raw tool invocation respects proof gate
- generated tool manifest is valid
- proof capsule path works through MCP client

### Deployed Host Conformance Gate

Commands:

```powershell
npm --prefix mcp\synthi-mcp run live:browser:private-tool-host-conformance
npm --prefix mcp\synthi-mcp run live:browser:private-tool-codex-host-conformance
```

Acceptance:

- non-loopback hosted runtime
- external store
- external proof signing
- bridge token required
- no local CDP leakage
- deployed host sees only licensed skills
- revocation propagates

### Security Gates

Required tests:

- proof signature tampering
- proof context tampering
- evidence ledger tampering
- proof replay race
- license revocation
- stale evidence
- expired license
- source drift
- cross-tenant access
- raw workflow bypass
- raw private tool bypass
- prompt injection document
- malicious uploaded file instruction
- fake success UI
- auth expiry
- role downgrade
- approval denial

### Chaos Gates

Scenarios:

- worker kill during run
- signaling partition
- Redis restart
- Postgres restart during proof validation
- browser session crash
- API mock timeout
- evidence store unavailable
- proof signing service unavailable
- source contract drift mid-run

Acceptance:

- unsafe actions fail closed
- evidence records are not partially accepted
- proof is not consumed for failed preflight
- recovery path is visible

### Soak And Performance Gates

Required metrics:

- proof validation p95
- graph node execution p95
- Vivarium scenario runtime p95
- Wind Tunnel budget adherence
- checkride runtime p95
- evidence append p95
- memory growth over 60 minutes
- browser session leak count
- proof replay false allow count
- false block rate

Acceptance:

- no leak trend in 60-minute soak
- proof validation stays within budget
- scenario budget stops correctly
- no stale license actions allowed

### Visual Proof Gates

Required screenshots:

- workflow before teaching
- skill card after teaching
- proof badge after license
- graph editor with selected node
- node inspector
- practice world scenario list
- wind tunnel matrix
- refusal explainer
- proof capsule drawer
- governance dashboard
- passport
- time machine debugger
- Ghost Mode diff

Acceptance:

- screenshots show real data from bridge/backend
- UI is not blank
- text does not overlap
- controls are visible and usable at desktop and mobile widths
- actions invoke real tools

---

## Phase 20: Roadmap Execution Order

### Milestone 1: Honest Production Boundary

Build:

- production Dojo execution policy gate
- deployment readiness hard failures
- atomic proof use
- raw workflow bypass tests
- default proof key production failure

Why first:

This prevents the most damaging false claim: that a licensed skill cannot be bypassed.

Exit criteria:

- every published skill is blocked outside Dojo proof path in production mode
- proof replay prevention survives restart

### Milestone 2: Durable Control Plane

Build:

- Postgres Dojo store
- tenant/workspace scoped entities
- audit events
- migration tests

Why second:

Without durable state, proof, revocation, approvals, and case law cannot be trusted.

Exit criteria:

- no production-critical Dojo state is process-local
- tenant isolation tests pass

### Milestone 3: Evidence And Proof Authority

Build:

- append-only evidence ledger
- claim verifier
- redaction pipeline
- KMS/asymmetric proof signing
- public verifier

Why third:

Proof capsules are only meaningful if claims are independently verified.

Exit criteria:

- proof issuance fails without verified evidence
- tampered evidence breaks verification

### Milestone 4: Executable Graph Runtime

Build:

- graph compiler
- graph interpreter
- guardrail runtime
- assertion runtime
- rollback runtime
- proof nodes
- expiry nodes

Why fourth:

Dojo is a competency runtime only when the graph executes and enforces behavior.

Exit criteria:

- at least one risky workflow executes through graph runtime with enforced guardrails and proof

### Milestone 5: Real Vivarium And Wind Tunnel

Build:

- scenario DSL
- fixture materializer
- API fault server
- UI tissue mutation
- identity/policy/document tissue
- oracle evaluator
- wind tunnel runner
- Evil Twin runner

Why fifth:

The central product claim depends on practicing inside a synthetic workplace.

Exit criteria:

- duplicate entity, fake success, auth expiry, prompt injection, and partial write scenarios execute against fixtures
- attack success rate is measured from runtime outcomes

### Milestone 6: Evidence-Backed Checkride And License

Build:

- executable checkride runner
- scoring policy
- entrustment policy
- SRL policy
- license issue/downgrade from results

Why sixth:

Licenses must be earned through evidence-backed results, not static heuristics.

Exit criteria:

- happy-path-only workflow cannot get E3
- failed risk scenarios constrain license scope

### Milestone 7: Source/API Graduation

Build:

- signed source snapshots
- Agent-Ready UI Contract schema/linter
- source drift expiry
- API inference
- API-backed MCP tool compiler
- substrate selector

Why seventh:

This is the reliability and cost wedge that moves Dojo beyond RPA.

Exit criteria:

- one node graduates from UI to API/MCP with tests and proof

### Milestone 8: Generated PR System

Build:

- codemods
- generated tests
- PR branch creation
- review metadata
- code owner gates

Why eighth:

Enterprises need source-aware changes as reviewable code.

Exit criteria:

- controlled React app receives a generated Agent-Ready UI Contract patch with tests

### Milestone 9: Product UX

Build:

- Skill Cortex graph editor
- node inspector
- consumer skill cards
- Skill Passport
- Practice World UX
- refusal explainer
- proof lifecycle
- Time Machine Debugger
- Ghost Mode

Why ninth:

After runtime semantics exist, UX can expose real behavior instead of report summaries.

Exit criteria:

- Playwright visual proof covers all core UX surfaces

### Milestone 10: Governance And Enterprise Release

Build:

- org-wide registry
- approvals
- recertification jobs
- case law review
- compliance exports
- deployed MCP conformance
- chaos/soak/performance gates

Why tenth:

This makes the universe operable in enterprise deployments.

Exit criteria:

- full release gate passes in CI and deployed-host proof

---

## Full Acceptance Checklist

### Runtime

- [ ] Skill Seed extraction uses trace, source, network, policy, schema, and evidence inputs.
- [ ] Skill Cortex graph is executable.
- [ ] Guardrail nodes execute before dangerous actions.
- [ ] Permission nodes execute before licensed actions.
- [ ] Proof nodes validate required capsules.
- [ ] Assertion nodes verify postconditions.
- [ ] Rollback nodes run or block when rollback is impossible.
- [ ] Expiry nodes invalidate stale skills.
- [ ] Case law guardrails execute at runtime.
- [ ] Raw workflow/private tool bypass is blocked in production.

### Vivarium

- [ ] Organoid materializes synthetic fixtures.
- [ ] UI tissue supports layout and label mutations.
- [ ] Data tissue supports duplicates, stale IDs, missing fields, invalid values.
- [ ] Policy tissue supports thresholds and blocked actions.
- [ ] Identity tissue supports expired auth and role downgrade.
- [ ] Document tissue supports prompt injection and ambiguous files.
- [ ] API tissue supports latency, partial write, validation errors, fake success.
- [ ] Reset profile is deterministic.
- [ ] Oracles classify observed evidence.

### Checkride

- [ ] Knowledge tests execute.
- [ ] Risk tests execute.
- [ ] Skill tests execute.
- [ ] Critical failures block production licenses.
- [ ] Blocked scenarios constrain license scope.
- [ ] Entrustment derives from evidence.
- [ ] SRL derives from real artifacts and results.

### Proof And License

- [ ] Proof capsules are KMS/asymmetric signed.
- [ ] Proof claims are evidence-backed.
- [ ] Nonce and replay records are durable.
- [ ] Revocation propagates.
- [ ] License kernel checks actor, action, context, evidence, substrate, approval, expiry.
- [ ] License health is computed continuously.

### Source/API

- [ ] Source snapshots are signed and release-scoped.
- [ ] Source drift expires affected nodes.
- [ ] Agent-Ready UI Contracts are CI-gated.
- [ ] Source affordance PRs create real patches.
- [ ] API inference creates reviewed endpoint candidates.
- [ ] API-backed MCP tools enforce proof and evidence.
- [ ] Substrate selector prefers safest available substrate.

### Governance

- [ ] Tenant-aware registry exists.
- [ ] RBAC exists.
- [ ] Approval queue exists.
- [ ] Case law review exists.
- [ ] Antibody registry exists.
- [ ] Compliance export exists.
- [ ] Recertification jobs exist.
- [ ] Audit events cover all critical writes and executions.

### UX

- [ ] Enterprise graph editor exists.
- [ ] Node inspector exists.
- [ ] Consumer skill cards exist.
- [ ] Skill Passport exists.
- [ ] Practice World UI exists.
- [ ] Refusal explainer exists.
- [ ] Proof lifecycle UI exists.
- [ ] Time Machine Debugger exists.
- [ ] Ghost Mode UI exists.
- [ ] Governance dashboard exists.

### Validation

- [ ] Full MCP unit suite passes or has formal release quarantine.
- [ ] Frontend unit tests pass.
- [ ] Docker integration passes.
- [ ] Workflow e2e passes.
- [ ] Dojo proof self-check passes.
- [ ] Generated Playwright passes.
- [ ] Deployed MCP host conformance passes.
- [ ] Security tests pass.
- [ ] Chaos tests pass.
- [ ] Soak tests pass.
- [ ] Performance budgets pass.
- [ ] Visual proof covers mature UX surfaces.

---

## What Not To Claim Until This Is Done

Do not claim:

- full synthetic workplace execution
- mature enterprise graph editor
- production-grade evidence ledger
- broad arbitrary-app source-aware PR generation
- broad arbitrary-app API inference
- production-grade proof capsules
- org-wide governance
- complete Phase 4-6 roadmap
- deployed MCP host conformance
- universal safety

Safe claim before full completion:

```text
Agent Dojo currently implements a generic proof-gated competency core loop:
workflow demonstration to skill artifacts, scenario/checkride reports,
license/proof capsule, repo artifacts, MCP skill exposure, and UI proof lifecycle.
The full mature Vivarium Cortex universe requires the executable graph runtime,
real synthetic practice worlds, evidence-backed checkrides, source/API graduation,
enterprise UX, governance, and production control-plane work described in this plan.
```

Safe claim after full completion:

```text
Agent Dojo converts demonstrated workflows into evidence-backed, proof-carrying,
licensed agent competencies that practice inside synthetic task worlds,
execute through an enforceable Skill Cortex runtime, graduate from UI to source/API/MCP
substrates where reviewed, and are governed through enterprise lifecycle,
case law, evidence, and proof controls.
```

---

## Immediate Next Build Recommendation

The next engineering step should not be the graph editor. It should be the hard production boundary plus durable proof/evidence foundations.

Recommended next sprint:

1. Add production Dojo execution policy gate.
2. Block raw workflow replay for Dojo-published workflows in production mode.
3. Add deployment readiness failures for insecure Dojo config.
4. Add Postgres-backed proof records with atomic use.
5. Add evidence claim verifier skeleton.
6. Make proof issuance fail when required claims are not verified.
7. Add bypass, replay, revocation, stale evidence, and default-key tests.
8. Update validation summary to distinguish current scaffold from mature runtime.

Reason:

If the license/proof boundary is not airtight, the rest of the universe is only descriptive. Once the boundary is real, the Vivarium, graph runtime, source/API compiler, and UX can safely grow around an enforceable core.

---

## Buildability Addendum

This addendum turns the roadmap above into a dependency-aware execution plan. The key change is that work is no longer expressed only as phases. It is expressed as:

- hard dependencies
- stable module contracts
- logical ownership boundaries
- PR-sized tickets
- tiered test gates
- first merge sequence

This is the layer a team can actually build from.

---

## Hard Dependency Graph

### Dependency Node Legend

| ID | Dependency Node | Meaning |
|---|---|---|
| `D0` | Truth Baseline | Current scaffold/report/runtime status is machine-readable and visible in tool responses. |
| `D1` | Production Enforcement Config | Dojo has explicit production-mode flags and deployment readiness checks. |
| `D2` | Execution Policy Gate | Runtime can decide whether a workflow/private tool call is allowed outside Dojo. |
| `D3` | Durable Proof Store | Proof records support atomic issue/use/revoke across processes. |
| `D4` | Audit Event Model | Critical Dojo writes/executions emit durable audit events. |
| `D5` | Evidence Ledger Schema | Evidence records have stable IDs, hashes, redaction state, and ledger checkpoints. |
| `D6` | Evidence Claim Verifier | Proof claims are checked against evidence records instead of caller assertions. |
| `D7` | Production Proof Signing | Proof capsules use production-grade keys and reject default/local keys in production. |
| `D8` | License Kernel v2 | License checks include actor, action, context, proof, evidence, substrate, approval, and expiry. |
| `D9` | Graph IR Contract | Skill Cortex has a stable executable graph representation. |
| `D10` | Graph Runtime | Graph nodes execute with guardrails, assertions, proof nodes, and rollback semantics. |
| `D11` | Scenario DSL | Vivarium scenarios have machine-readable mutations, fixtures, oracles, and reset profiles. |
| `D12` | Fixture Materializer | Synthetic UI/API/data/auth/document fixtures can be created deterministically. |
| `D13` | Oracle Runner | Scenario outcomes are determined from observed evidence. |
| `D14` | Executable Checkride | Checkride uses graph runtime, fixtures, evidence, and oracles. |
| `D15` | Case Law Runtime | Approved case law creates executable guardrail predicates. |
| `D16` | Source Snapshot Contract | Source anchors are release-scoped, signed, and drift-detectable. |
| `D17` | Agent-Ready UI Contract CI | UI contracts are schema-validated and CI-gated. |
| `D18` | API Inference Contract | API candidates have reviewed schema, auth, idempotency, rollback, and postconditions. |
| `D19` | Substrate Executor | Nodes can execute through UI, DOM, source, API, or MCP substrates through a common interface. |
| `D20` | MCP Skill Bus v2 | Tool manifests are signed, tenant-scoped, versioned, authorized, and proof-gated. |
| `D21` | Governance Control Plane | Approvals, recertification, revocation, case-law review, RBAC, and compliance exports exist. |
| `D22` | Enterprise UX Shell | Dedicated Dojo route/panels exist outside the compact workflow drawer. |
| `D23` | Graph Editor UX | Cortex graph editor, node inspector, graph validation, and graph diff exist. |
| `D24` | Practice World UX | Scenario browser, organoid viewer, wind tunnel matrix, and evidence drawer exist. |
| `D25` | Proof/Refusal UX | Proof lifecycle and refusal explanation surfaces exist. |
| `D26` | Governance UX | Registry, approval queue, license health, case-law review, and audit export UI exist. |
| `D27` | Hosted Runtime Gateway | Tenant-isolated runtime sessions use short-lived credentials and origin policy. |
| `D28` | Deployed MCP Conformance | Non-loopback deployed MCP host conformance is automated and passing. |
| `D29` | Release Hardening Gates | Security, chaos, soak, performance, and compliance gates are tiered and automated. |

### Blocking Relationships

```text
D0 -> D1
D1 -> D2
D1 -> D3
D1 -> D7
D2 -> D8
D3 -> D6
D3 -> D8
D3 -> D20
D4 -> D21
D5 -> D6
D5 -> D14
D5 -> D25
D6 -> D7
D6 -> D8
D7 -> D8
D8 -> D10
D8 -> D20
D9 -> D10
D10 -> D14
D10 -> D15
D10 -> D19
D11 -> D12
D12 -> D13
D13 -> D14
D14 -> D15
D14 -> D21
D15 -> D8
D15 -> D10
D16 -> D17
D16 -> D19
D17 -> D19
D18 -> D19
D19 -> D20
D20 -> D28
D21 -> D26
D22 -> D23
D22 -> D24
D22 -> D25
D22 -> D26
D9 -> D23
D11 -> D24
D14 -> D24
D6 -> D25
D8 -> D25
D21 -> D26
D27 -> D28
D28 -> D29
```

### Practical Dependency Rules

1. **Do not build the mature graph editor before `D9` exists.**
   - A graph editor without a stable graph IR becomes a decorative graph.

2. **Do not issue production-grade proof claims before `D5` and `D6` exist.**
   - A signed capsule over self-attested claims is signed theatre.

3. **Do not claim proof-gated production execution before `D2`, `D3`, `D7`, and `D8` exist.**
   - Enforcement requires policy gate, durable proof records, production signing, and a complete license kernel.

4. **Do not promote API/MCP substrates before `D16`, `D17`, `D18`, and `D19` exist.**
   - API calls need source/API contracts, auth/idempotency review, and a common substrate executor.

5. **Do not claim a real Vivarium before `D11`, `D12`, and `D13` exist.**
   - Scenario metadata is not a synthetic workplace.

6. **Do not claim evidence-backed checkrides before `D10`, `D12`, `D13`, and `D14` exist.**
   - Checkride must run the graph inside fixtures and score observed evidence.

7. **Do not claim enterprise governance before `D4`, `D21`, and `D26` exist.**
   - Governance requires audit, control-plane workflow, and operator UI.

8. **Do not claim production host readiness before `D27`, `D28`, and `D29` exist.**
   - Local loopback validation is not deployed host conformance.

### Critical Path

The critical path to a real mature product is:

```text
D0 Truth Baseline
  -> D1 Production Enforcement Config
  -> D2 Execution Policy Gate
  -> D3 Durable Proof Store
  -> D5 Evidence Ledger Schema
  -> D6 Evidence Claim Verifier
  -> D7 Production Proof Signing
  -> D8 License Kernel v2
  -> D9 Graph IR Contract
  -> D10 Graph Runtime
  -> D11 Scenario DSL
  -> D12 Fixture Materializer
  -> D13 Oracle Runner
  -> D14 Executable Checkride
  -> D15 Case Law Runtime
  -> D19 Substrate Executor
  -> D20 MCP Skill Bus v2
  -> D27 Hosted Runtime Gateway
  -> D28 Deployed MCP Conformance
  -> D29 Release Hardening Gates
```

Parallel tracks can proceed after the contracts they depend on exist:

```text
Frontend UX:
  D22 can begin after D0.
  D23 waits for D9.
  D24 waits for D11 and D14.
  D25 waits for D6 and D8.
  D26 waits for D21.

Source/API:
  D16 can begin after D0.
  D17 waits for D16.
  D18 can begin after D16.
  D19 waits for D8, D10, D17, and D18.

Governance:
  D21 can begin after D3, D4, D8, and D15.
```

---

## Ownership And Interface Boundaries

Ownership here means logical engineering ownership, not named people.

| Area | Primary Owner | Responsibilities | Does Not Own | Primary Contracts |
|---|---|---|---|---|
| Dojo Runtime Core | Backend Runtime | Skill graph IR, graph compiler, graph runtime, node handlers, guardrail runtime, assertion runtime, rollback runtime. | Proof signing, evidence storage, frontend graph rendering. | `SkillGraphRuntime`, `WorkflowNodeHandler`, `SubstrateExecutor` |
| Proof And License | Security / Trust Runtime | Proof capsule schema, signing, validation, replay prevention, license kernel, approval checks, expiry checks. | Evidence artifact storage, graph rendering, source codemods. | `ProofCapsuleService`, `LicenseKernel`, `ProofRecordStore` |
| Evidence Ledger | Evidence Platform | Append-only evidence records, redaction, hash-chain verification, claim resolution, retention exports. | License decisions, graph execution, UX. | `EvidenceLedger`, `EvidenceClaimVerifier`, `RedactionPipeline` |
| Dojo Store / Control Plane | Platform Backend | Tenant/workspace persistence, Postgres migrations, audit events, registry APIs, store transactions. | Runtime node semantics, UI design. | `DojoControlPlaneStore`, `AuditLog`, `TenantContext` |
| MCP Skill Bus | MCP Runtime | Tool registry, dispatcher, manifest signing, proof-gated tool invocation, host conformance. | Proof claim verification internals, UX routes. | `McpSkillBus`, `ToolManifestSigner`, `DojoExecutionPolicyGate` |
| Vivarium Runtime | Simulation Runtime | Scenario DSL, fixture materialization, API mock/fault server, reset profiles, oracles, wind tunnel runner. | Production app execution, governance UI. | `VivariumRunner`, `ScenarioMaterializer`, `ScenarioOracle` |
| Source/API Compiler | Source-Aware Automation | Source snapshots, Agent-Ready UI Contracts, codemods, API inference, API-backed tools, substrate promotion. | Proof signing, evidence ledger. | `SourceContractService`, `ApiInferenceService`, `AffordancePrGenerator` |
| Governance | Enterprise Platform | Approval workflows, case-law review, recertification, license health, compliance exports, RBAC. | Low-level runtime execution. | `GovernanceService`, `ApprovalService`, `CaseLawRegistry` |
| Frontend Dojo UX | Frontend Product | Dojo routes, graph editor, skill cards, passport, practice world UI, proof/refusal UI, governance dashboard. | Backend policy decisions. | `DojoClient`, `DojoViewModels`, route-level state |
| Hosted Runtime | Browser Runtime | Tenant-isolated browser sessions, short-lived runtime credentials, origin policy, runtime audit. | Dojo license rules. | `HostedRuntimeGateway`, `RuntimeSessionStore` |
| Validation / Release | QA / Release Engineering | Test tiers, CI matrix, live conformance, visual proof, chaos, soak, performance gates. | Feature implementation. | `ReleaseGateManifest`, `ValidationEvidenceManifest` |

### Stable Contract: Tenant Context

Every production-facing Dojo call must carry tenant context.

```ts
export type DojoTenantContext = {
  tenant_id: string
  organization_id: string
  workspace_id: string
  actor_id: string
  actor_type: "human" | "agent" | "service"
  roles: string[]
  request_id: string
  correlation_id: string
  data_region?: string
}
```

Contract rules:

- no production store method accepts implicit tenant scope
- tests must fail if tenant scope is omitted
- all audit events include this context
- all proof and evidence records are written under this context

### Stable Contract: Dojo Execution Policy Gate

```ts
export type DojoExecutionPolicyDecision = {
  ok: boolean
  status: "allowed" | "blocked" | "approval_required" | "practice_only"
  enforcement_mode: "development" | "production"
  entrypoint: "dojo_skill_bus" | "private_tool" | "browser_workflow" | "graph_runtime"
  skill_id?: string
  workflow_id?: string
  tool_name?: string
  blocked_by: string[]
  required_path?: "synthi_dojo_run_with_proof_capsule"
  audit_event_id?: string
}

export interface DojoExecutionPolicyGate {
  evaluate(input: {
    tenant: DojoTenantContext
    entrypoint: DojoExecutionPolicyDecision["entrypoint"]
    workflow_id?: string
    tool_name?: string
    requested_action: string
    proof_capsule_id?: string
    dry_run?: boolean
  }): Promise<DojoExecutionPolicyDecision>
}
```

Contract rules:

- `private_tool` and `browser_workflow` entrypoints must be blocked for Dojo-published production skills unless called through the Dojo dispatcher
- development mode may allow compatibility behavior, but response must state `enforcement_mode`
- production mode must fail closed on missing store, missing license, missing proof, or unknown mapping

### Stable Contract: Proof Capsule Service

```ts
export type DojoProofIssueResult = {
  ok: boolean
  proof_capsule?: DojoProofCarryingSkillCapsule
  validation: DojoProofValidation
  evidence_claim_results: DojoEvidenceClaimResult[]
  audit_event_id: string
}

export interface DojoProofCapsuleService {
  issue(input: {
    tenant: DojoTenantContext
    skill_id: string
    skill_version: string
    license_id: string
    requested_action: string
    context_claims: Record<string, unknown>
    evidence_claim_ids: string[]
    substrate_claim: DojoExecutionSubstrate
    expires_at?: string
  }): Promise<DojoProofIssueResult>

  validate(input: {
    tenant: DojoTenantContext
    proof_capsule: DojoProofCarryingSkillCapsule
    requested_action: string
    dry_run?: boolean
  }): Promise<DojoProofValidation>

  consume(input: {
    tenant: DojoTenantContext
    capsule_id: string
    run_id: string
  }): Promise<DojoProofConsumeResult>
}
```

Contract rules:

- `issue` must call `EvidenceClaimVerifier`
- `validate` must verify signature, issuer, key ID, expiry, license version, skill version, evidence checkpoint, and registry status
- `consume` must be atomic
- `dry_run` never consumes
- production issue fails if signing key is default/local

### Stable Contract: Evidence Ledger

```ts
export type DojoEvidenceRecordInput = {
  tenant: DojoTenantContext
  skill_id: string
  run_id: string
  kind: "trace" | "scenario" | "checkride" | "case_law" | "guardrail" | "license" | "proof" | "artifact" | "audit"
  artifact_uri: string
  artifact_sha256: string
  redaction_manifest_sha256?: string
  claim_ids: string[]
  retention_class: "ephemeral" | "standard" | "regulated" | "legal_hold"
}

export interface DojoEvidenceLedger {
  append(record: DojoEvidenceRecordInput): Promise<DojoEvidenceLedgerRecord>
  verifyHead(tenant: DojoTenantContext, head_hash: string): Promise<DojoLedgerVerification>
  verifyRecord(record_id: string): Promise<DojoLedgerVerification>
  resolveClaims(input: {
    tenant: DojoTenantContext
    claim_ids: string[]
    max_age_ms?: number
  }): Promise<DojoEvidenceClaimResult[]>
}
```

Contract rules:

- append-only semantics
- all artifact bytes or redacted manifests are content-addressed
- claim resolution is independent of caller-provided booleans
- repo export may include references and redacted metadata only

### Stable Contract: License Kernel

```ts
export interface DojoLicenseKernel {
  evaluate(input: {
    tenant: DojoTenantContext
    skill_id: string
    license_id: string
    requested_action: string
    proof_validation: DojoProofValidation
    context_claims: Record<string, unknown>
    evidence_claims: DojoEvidenceClaimResult[]
    substrate: DojoExecutionSubstrate
    approval_id?: string
    now?: string
  }): Promise<DojoLicenseKernelDecision>
}
```

Contract rules:

- license kernel does not issue proof
- license kernel does not fetch evidence bytes
- license kernel consumes verification results and policy state
- output must explain every block reason

### Stable Contract: Skill Graph Runtime

```ts
export interface DojoSkillGraphRuntime {
  validateGraph(graph: DojoSkillGraph): Promise<DojoGraphValidation>
  execute(input: {
    tenant: DojoTenantContext
    graph: DojoSkillGraph
    mode: "practice" | "checkride" | "shadow" | "production"
    inputs: Record<string, unknown>
    proof_capsule?: DojoProofCarryingSkillCapsule
    scenario_context?: DojoScenarioContext
  }): Promise<DojoGraphRunResult>
}
```

Contract rules:

- production mode requires proof nodes for licensed actions
- dangerous action without guardrail fails graph validation
- graph runtime emits evidence records through evidence ledger
- graph runtime does not directly bypass license kernel

### Stable Contract: Vivarium Runner

```ts
export interface DojoVivariumRunner {
  materialize(input: {
    tenant: DojoTenantContext
    skill_id: string
    scenario: DojoScenarioDefinition
  }): Promise<DojoMaterializedScenario>

  run(input: {
    tenant: DojoTenantContext
    materialized: DojoMaterializedScenario
    graph: DojoSkillGraph
    budget: DojoScenarioBudget
  }): Promise<DojoScenarioRunResult>

  reset(input: {
    tenant: DojoTenantContext
    materialized_id: string
  }): Promise<DojoFixtureResetResult>
}
```

Contract rules:

- no production data refs allowed in materialized fixtures
- reset must be deterministic
- scenario result must be based on oracle and observed evidence

### Stable Contract: Source Contract Service

```ts
export interface DojoSourceContractService {
  captureSnapshot(input: {
    tenant: DojoTenantContext
    app_origin: string
    app_version: string
    commit_sha: string
    source_root: string
  }): Promise<DojoSourceSnapshot>

  validateUiContract(contract: AgentReadyUiContract): Promise<DojoSourceContractValidation>
  detectDrift(input: {
    tenant: DojoTenantContext
    previous_snapshot_id: string
    next_snapshot_id: string
  }): Promise<DojoSourceDriftReport>
}
```

Contract rules:

- source snapshots are release-scoped
- drift report identifies affected skill nodes
- CI validation fails for missing proof hooks on risky actions

### Stable Contract: MCP Skill Bus

```ts
export interface DojoMcpSkillBus {
  listCompetencies(input: { tenant: DojoTenantContext }): Promise<DojoCompetencySummary[]>
  resolveTool(input: { tenant: DojoTenantContext; tool_name: string; tool_version?: string }): Promise<DojoToolResolution>
  dispatch(input: {
    tenant: DojoTenantContext
    tool_name: string
    tool_version?: string
    args: Record<string, unknown>
    proof_capsule?: DojoProofCarryingSkillCapsule
    dry_run?: boolean
  }): Promise<DojoToolDispatchResult>
}
```

Contract rules:

- `listCompetencies` filters by caller authorization
- `dispatch` validates proof before execution
- signed tool manifest digest must match registry state
- revoked tools fail closed

---

## Test Tier Matrix

The test plan must be tiered so early PRs can merge without requiring every live/deployed/chaos gate.

### Tier Definitions

| Tier | Name | Runs On | Required For | Purpose |
|---|---|---|---|---|
| `T0` | Static / Typecheck | every PR | every merge | TypeScript, lint, schema compile, import boundaries. |
| `T1` | Unit | every PR | every merge | Pure functions, policy decisions, stores with fakes, schema validators. |
| `T2` | Focused Integration | every PR touching runtime/store | milestone merge | Real module interaction with local test stores and deterministic fixtures. |
| `T3` | Docker Integration | milestone branch | milestone exit | Full local stack validates service wiring and bridge behavior. |
| `T4` | Playwright Visual / E2E | UI/runtime milestones | milestone exit | User-visible behavior and generated artifacts are visually and functionally proven. |
| `T5` | Live Hosted Runtime | release branch | release candidate | Hosted CDP/runtime, private tool acceptance, non-local workflow path. |
| `T6` | Deployed MCP Host Conformance | release branch | production release | Non-loopback MCP host, external stores, strict clients, revocation propagation. |
| `T7` | Security / Abuse | release branch and nightly | production release | Tamper, replay, bypass, cross-tenant, injection, stale evidence, revocation. |
| `T8` | Chaos / Soak / Performance | nightly and pre-release | mature enterprise release | Failure injection, long-running stability, budgets, leak detection. |

### Required Tests By Ticket Type

| Ticket Type | T0 | T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 |
|---|---|---|---|---|---|---|---|---|---|
| Type/schema only | required | required | optional | not required | not required | not required | not required | not required | not required |
| Store interface | required | required | required with fake/in-memory | optional | not required | not required | not required | optional | not required |
| Postgres store | required | required | required with test DB | optional | not required | not required | not required | required for tenant isolation | not required |
| Proof/license policy | required | required | required | optional | not required | optional | optional | required | optional |
| MCP dispatcher | required | required | required | required at milestone | not required | required at release | required at release | required | optional |
| Evidence ledger | required | required | required | optional | not required | optional | optional | required | optional |
| Graph runtime | required | required | required | optional | optional | not required | not required | required for bypass/guardrails | optional |
| Vivarium runner | required | required | required | optional | required for scenario UI | optional | not required | required for prompt/fake-success abuse | optional |
| Frontend route/component | required | required | optional with mocked client | optional | required before milestone exit | not required | not required | optional | not required |
| Hosted runtime gateway | required | required | required | required | optional | required | required | required | required |

### Minimal Merge Gate

Every PR must pass:

```text
T0 static/typecheck
T1 unit tests for changed module
focused existing tests for touched integration surface
```

Every milestone exit must pass:

```text
all PR-level gates for milestone
T2 integration tests for milestone modules
T3 Docker integration if service wiring changed
T4 Playwright visual proof if user-facing UI changed
updated validation evidence summary
```

Every release candidate must pass:

```text
all milestone gates
T5 live hosted runtime tests
T6 deployed MCP host conformance
T7 security/abuse suite
selected T8 chaos/soak/performance gates appropriate to release scope
```

### First-Merge Test Standard

For the first 10 PRs listed below, do not require Docker, live hosted runtime, deployed host conformance, chaos, or soak unless the PR specifically changes those surfaces. Require unit and focused integration tests. This keeps the early foundation mergeable.

---

## Entry Point Coverage Matrix

The acceptance criterion "no production execution path can bypass Dojo proof validation" must become concrete entrypoint tests.

| Entrypoint | Current Risk | Required Behavior In Production | First Test Tier | Release Test Tier |
|---|---|---|---|---|
| `synthi_dojo_run_with_proof_capsule` | canonical path could validate weak claims | allowed only with valid proof, license, evidence, substrate, and unused nonce | T1/T2 | T7 |
| backing private `synthi_app_*` tool | raw private tool could bypass Dojo | blocked with `dojo_proof_capsule_required` or equivalent unless invoked by Dojo dispatcher context | T1/T2 | T6/T7 |
| `synthi_browser_run_workflow` | raw saved workflow replay could bypass license | blocked for Dojo-published workflows in production mode | T1/T2 | T5/T7 |
| generated Playwright artifact | generated test could mutate outside proof path | may run only in test/practice mode; production artifact must call Dojo path | T1 | T4/T7 |
| bridge `/browser-workflows/tool` | bridge could dispatch raw tool names | production bridge applies policy gate before dispatch | T2 | T5/T7 |
| MCP direct tool call from strict client | client may call hidden or stale tool | skill bus filters by caller and tool status; revoked tools fail closed | T2 | T6/T7 |
| graph runtime action node | node could execute substrate directly | action node must call license/proof gate for production actions | T1/T2 | T7 |
| source/API generated tool | API path could over-authorize | API tool validates proof, auth scope, idempotency, postcondition, evidence | T2 | T6/T7 |
| hosted runtime action | browser action could bypass skill bus | hosted runtime accepts production action only with Dojo run/session context | T2 | T5/T7 |
| replay after proof use | stale capsule replay | atomic proof consume rejects second use | T2 | T7 |

---

## Ticket-Level Backlog

Ticket IDs are PR-sized. Each ticket should be independently reviewable. Some tickets intentionally introduce interfaces before implementations so downstream work can start without rewriting upstream modules.

### Milestone 0 Tickets: Truth Baseline

#### `DOJO-0001` Implementation Status Manifest

- **Owner:** Backend Runtime
- **Depends on:** none
- **Files:**
  - `docs/AGENT_DOJO_IMPLEMENTATION_STATUS.md`
  - `mcp/synthi-mcp/src/dojo/status/implementation_status.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_implementation_status.test.ts`
- **Scope:**
  - define status enum: `executable`, `deterministic_projection`, `report_only`, `planned`
  - map every current Dojo tool/report to a status
  - add helper that emits status metadata
- **Not in scope:**
  - changing runtime enforcement
  - adding new persistence
- **Unit tests:**
  - every Dojo tool has a status
  - status enum serializes to stable JSON
- **Merge criteria:**
  - status helper compiles
  - docs explain current scaffold honestly

#### `DOJO-0002` Tool Response Status Metadata

- **Owner:** MCP Runtime
- **Depends on:** `DOJO-0001`
- **Files:**
  - `mcp/synthi-mcp/src/tools/dojo.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_tools.test.ts`
- **Scope:**
  - add `implementation_status` to Dojo MCP structured responses
  - add `runtime_enforced`, `evidence_backing`, and `simulation_backing` metadata where relevant
- **Not in scope:**
  - changing execution behavior
- **Unit tests:**
  - scenario generation says deterministic/report state
  - proof-gated run says runtime-enforced
  - universe dossier says report-only where appropriate
- **Merge criteria:**
  - no response implies real simulation unless it actually executes

### Milestone 1 Tickets: Production Boundary

#### `DOJO-0101` Production Enforcement Config

- **Owner:** Security / Trust Runtime
- **Depends on:** `DOJO-0001`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/config/enforcement.ts`
  - `mcp/synthi-mcp/src/browser/deployment_readiness.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_enforcement_config.test.ts`
- **Scope:**
  - parse `SYNTHI_DOJO_PRODUCTION_ENFORCEMENT`
  - parse durable-store, external-signing, evidence-ledger requirements
  - expose typed config with explicit defaults
  - add readiness warnings/errors
- **Not in scope:**
  - blocking runtime calls
- **Unit tests:**
  - production mode requires explicit secure dependencies
  - development mode reports non-production status
  - invalid env values fail predictably
- **Merge criteria:**
  - deployment readiness can report Dojo production misconfiguration

#### `DOJO-0102` Dojo Execution Policy Gate Interface

- **Owner:** MCP Runtime
- **Depends on:** `DOJO-0101`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/mcp/execution_policy_gate.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_execution_policy_gate.test.ts`
- **Scope:**
  - introduce `DojoExecutionPolicyGate` interface
  - implement initial in-process policy evaluator
  - classify entrypoints: `dojo_skill_bus`, `private_tool`, `browser_workflow`, `graph_runtime`
  - return structured decisions without wiring every entrypoint yet
- **Not in scope:**
  - modifying browser/private tool dispatch
  - durable store integration
- **Unit tests:**
  - unknown published skill mapping fails closed in production
  - development mode exposes compatibility decision
  - production private tool entrypoint requires Dojo dispatcher context
- **Merge criteria:**
  - decision shape is stable and documented

#### `DOJO-0103` Published Workflow Mapping Registry

- **Owner:** Dojo Store / Control Plane
- **Depends on:** `DOJO-0102`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/store/published_workflow_index.ts`
  - `mcp/synthi-mcp/src/browser/dojo_store.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_published_workflow_index.test.ts`
- **Scope:**
  - map `workflow_id` and `tool_name` to Dojo `skill_id`
  - persist mapping in existing store abstraction
  - expose lookup for policy gate
- **Not in scope:**
  - Postgres store
  - raw workflow blocking
- **Unit tests:**
  - skill publish writes workflow and tool mapping
  - lookup by workflow ID returns skill
  - lookup by tool name returns skill
- **Merge criteria:**
  - policy gate can identify Dojo-published workflows/tools

#### `DOJO-0104` Private Tool Entrypoint Gate

- **Owner:** MCP Runtime
- **Depends on:** `DOJO-0102`, `DOJO-0103`
- **Files:**
  - `mcp/synthi-mcp/src/tools/browser.ts`
  - `mcp/synthi-mcp/src/tools/dojo.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_private_tool_gate.test.ts`
- **Scope:**
  - route backing private tool direct calls through `DojoExecutionPolicyGate`
  - preserve existing proof-gated Dojo dispatcher behavior
  - add explicit decision details to rejection response
- **Not in scope:**
  - raw browser workflow replay gate
  - Postgres proof use
- **Unit tests:**
  - direct backing private tool call blocked in production
  - direct non-Dojo private tool remains allowed where existing policy allows
  - Dojo dispatcher path can continue to dry-run proof validation
- **Merge criteria:**
  - private tool bypass test exists per entrypoint matrix

#### `DOJO-0105` Raw Browser Workflow Replay Gate

- **Owner:** Browser Runtime / MCP Runtime
- **Depends on:** `DOJO-0102`, `DOJO-0103`
- **Files:**
  - `mcp/synthi-mcp/src/tools/browser.ts`
  - `mcp/synthi-mcp/src/browser/broker.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_browser_workflow_gate.test.ts`
- **Scope:**
  - block `synthi_browser_run_workflow` for Dojo-published workflows in production mode
  - allow practice/checkride mode when explicitly isolated
  - return required Dojo path in error
- **Not in scope:**
  - graph runtime execution
- **Unit tests:**
  - published workflow replay blocked in production
  - unpublished workflow behavior unchanged
  - explicit practice mode has non-production decision metadata
- **Merge criteria:**
  - raw browser replay bypass test exists

#### `DOJO-0106` Proof Error Taxonomy

- **Owner:** Proof And License
- **Depends on:** `DOJO-0101`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/proof/errors.ts`
  - `mcp/synthi-mcp/src/browser/dojo_license_kernel.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_proof_errors.test.ts`
- **Scope:**
  - centralize proof/license error codes
  - normalize current validation outputs
  - map low-level failures to user-facing refusal categories
- **Not in scope:**
  - new cryptography
- **Unit tests:**
  - each known validation failure maps to stable code
  - unknown failure maps to fail-closed code
- **Merge criteria:**
  - downstream UI can rely on stable blocked-by codes

### Milestone 2 Tickets: Durable Control Plane

#### `DOJO-0201` Store Interface Split

- **Owner:** Platform Backend
- **Depends on:** `DOJO-0103`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/store/interfaces.ts`
  - `mcp/synthi-mcp/src/browser/dojo_store.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_store_interfaces.test.ts`
- **Scope:**
  - split current monolithic skill/proof store into typed interfaces
  - keep compatibility adapter for current callers
  - add transaction capability shape without implementing Postgres
- **Not in scope:**
  - migrations
  - DB driver
- **Unit tests:**
  - current encrypted file store satisfies compatibility interface
  - current in-memory store satisfies compatibility interface
- **Merge criteria:**
  - no caller needs to know concrete store class

#### `DOJO-0202` Dojo Postgres Schema Migration

- **Owner:** Platform Backend
- **Depends on:** `DOJO-0201`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/store/migrations.ts`
  - `mcp/synthi-mcp/tests/integration/dojo_postgres_schema.test.ts`
- **Scope:**
  - add schema for tenants, workspaces, skills, licenses, proof records, audit events
  - include indexes for tenant/workspace/skill/proof lookup
  - include unique constraints for proof capsule ID and nonce
- **Not in scope:**
  - full evidence ledger tables
  - query repository implementation
- **Integration tests:**
  - migration applies cleanly
  - constraints reject duplicate proof nonce
  - tenant foreign keys enforced
- **Merge criteria:**
  - migration is reversible or repeat-safe according to repo migration pattern

#### `DOJO-0203` Postgres Proof Repository

- **Owner:** Platform Backend / Proof And License
- **Depends on:** `DOJO-0202`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/store/postgres_proof_store.ts`
  - `mcp/synthi-mcp/tests/integration/dojo_postgres_proof_store.test.ts`
- **Scope:**
  - implement proof issue/read/revoke/consume
  - consume uses atomic compare-and-set
  - include tenant scope in every query
- **Not in scope:**
  - full skill repository
  - KMS signing
- **Integration tests:**
  - consume succeeds once
  - concurrent consume has one winner
  - revoked proof cannot consume
  - tenant A cannot read tenant B proof
- **Merge criteria:**
  - proof replay prevention is durable and atomic

#### `DOJO-0204` Audit Event Repository

- **Owner:** Platform Backend / Governance
- **Depends on:** `DOJO-0202`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/store/audit_store.ts`
  - `mcp/synthi-mcp/tests/integration/dojo_audit_store.test.ts`
- **Scope:**
  - write audit events for proof issue/validate/use/revoke and license revoke
  - include tenant context, actor, request ID, correlation ID
- **Not in scope:**
  - full governance UI
- **Integration tests:**
  - proof issue emits audit
  - proof reject emits audit
  - license revoke emits audit
- **Merge criteria:**
  - critical proof/license writes are auditable

### Milestone 3 Tickets: Evidence And Signing

#### `DOJO-0301` Evidence Ledger Schema

- **Owner:** Evidence Platform
- **Depends on:** `DOJO-0202`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/evidence/types.ts`
  - `mcp/synthi-mcp/src/dojo/evidence/ledger_record.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_evidence_record.test.ts`
- **Scope:**
  - define evidence record schema
  - define hash calculation rules
  - define ledger checkpoint shape
- **Not in scope:**
  - persistence implementation
  - redaction engine
- **Unit tests:**
  - stable record hash
  - hash changes when material fields change
  - previous hash included
- **Merge criteria:**
  - record schema is stable enough for store implementation

#### `DOJO-0302` Evidence Ledger Store

- **Owner:** Evidence Platform
- **Depends on:** `DOJO-0301`, `DOJO-0202`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/evidence/ledger_store.ts`
  - `mcp/synthi-mcp/tests/integration/dojo_evidence_ledger_store.test.ts`
- **Scope:**
  - append evidence records
  - maintain tenant/workspace ledger head
  - verify record chain
- **Not in scope:**
  - claim verifier
  - redaction of artifact bytes
- **Integration tests:**
  - append updates head
  - tampering breaks verification
  - cross-tenant read blocked
- **Merge criteria:**
  - ledger can prove append-only chain integrity

#### `DOJO-0303` Evidence Claim Verifier Skeleton

- **Owner:** Evidence Platform / Proof And License
- **Depends on:** `DOJO-0302`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/evidence/claims.ts`
  - `mcp/synthi-mcp/src/dojo/evidence/verifier.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_evidence_claim_verifier.test.ts`
- **Scope:**
  - implement claim registry
  - support initial claims: `workspace_verified`, `checkride_passed`, `guardrails_active`, `evidence_fresh`
  - return positive, negative, stale, and missing results
- **Not in scope:**
  - every future business claim
- **Unit tests:**
  - missing evidence returns failed claim
  - stale evidence returns stale claim
  - verified evidence returns passed claim
- **Merge criteria:**
  - proof issuance can depend on claim verifier

#### `DOJO-0304` Proof Issuance Requires Verified Claims

- **Owner:** Proof And License
- **Depends on:** `DOJO-0303`
- **Files:**
  - `mcp/synthi-mcp/src/browser/dojo.ts`
  - `mcp/synthi-mcp/src/tools/dojo.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_proof_claims.test.ts`
- **Scope:**
  - proof issuance calls claim verifier
  - unverified required claim blocks issuance
  - proof capsule includes evidence record IDs and ledger checkpoint
- **Not in scope:**
  - asymmetric signing
- **Unit tests:**
  - missing `workspace_verified` evidence blocks production proof
  - stale evidence blocks production proof
  - dry-run/dev mode can return explanatory non-production result
- **Merge criteria:**
  - proof is no longer purely self-attested for required claims

#### `DOJO-0305` Production Proof Signing Interface

- **Owner:** Security / Trust Runtime
- **Depends on:** `DOJO-0304`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/proof/signing.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_proof_signing.test.ts`
- **Scope:**
  - add signer/verifier interface
  - implement local development signer
  - implement asymmetric `ed25519` signer using Node crypto
  - production readiness rejects default signer
- **Not in scope:**
  - cloud KMS provider
- **Unit tests:**
  - valid signature verifies
  - tampered capsule fails
  - default signer rejected in production mode
- **Merge criteria:**
  - signing algorithm is pluggable and production mode can reject insecure signer

### Milestone 4 Tickets: Graph Runtime

#### `DOJO-0401` Graph IR Schema

- **Owner:** Dojo Runtime Core
- **Depends on:** `DOJO-0106`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/graph/types.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_graph_types.test.ts`
- **Scope:**
  - define executable graph nodes, edges, node memory, guardrail refs, proof requirements
  - define graph validation result
- **Not in scope:**
  - execution
- **Unit tests:**
  - graph schema validates minimal graph
  - dangerous action without guardrail fails schema-level validation
- **Merge criteria:**
  - graph editor and runtime can use same IR

#### `DOJO-0402` Graph Compiler Adapter

- **Owner:** Dojo Runtime Core
- **Depends on:** `DOJO-0401`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/graph/compiler.ts`
  - `mcp/synthi-mcp/src/browser/dojo.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_graph_compiler.test.ts`
- **Scope:**
  - compile current `WorkflowContractV7` into graph IR
  - preserve existing report builder output through adapter
  - insert proof/permission/guardrail skeleton nodes
- **Not in scope:**
  - executing graph
- **Unit tests:**
  - mutation workflow includes assertion node
  - risky action includes permission and guardrail nodes
  - production action includes proof node
- **Merge criteria:**
  - existing Dojo artifacts still export

#### `DOJO-0403` Graph Runtime Skeleton

- **Owner:** Dojo Runtime Core
- **Depends on:** `DOJO-0402`, `DOJO-0304`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/graph/runtime.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_graph_runtime.test.ts`
- **Scope:**
  - execute non-mutating node sequence
  - evaluate static preconditions
  - emit run state and node results
  - call proof/license stubs for production action nodes
- **Not in scope:**
  - real UI/API substrate execution
  - rollback
- **Unit tests:**
  - happy sequence executes
  - failed precondition blocks node
  - production action without proof blocks
- **Merge criteria:**
  - graph runtime exists and fails closed for production action

#### `DOJO-0404` Guardrail Predicate Runtime

- **Owner:** Dojo Runtime Core / Case Law Runtime
- **Depends on:** `DOJO-0403`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/graph/guardrail_runtime.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_guardrail_runtime.test.ts`
- **Scope:**
  - implement minimal predicate evaluator
  - support equality, inequality, numeric comparison, boolean truth, set membership
  - return explicit failure reason
- **Not in scope:**
  - full expression language
- **Unit tests:**
  - duplicate client guard blocks
  - amount threshold guard gates approval
  - missing claim fails closed
- **Merge criteria:**
  - guardrail nodes have executable semantics

#### `DOJO-0405` Assertion And Rollback Skeleton

- **Owner:** Dojo Runtime Core
- **Depends on:** `DOJO-0403`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/graph/assertion_runtime.ts`
  - `mcp/synthi-mcp/src/dojo/graph/rollback_runtime.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_assertion_rollback.test.ts`
- **Scope:**
  - implement assertion result contract
  - implement rollback decision contract
  - support no-rollback blocking path
- **Not in scope:**
  - real app compensation
- **Unit tests:**
  - failed assertion creates blocked run
  - no rollback available requires human review
- **Merge criteria:**
  - graph runtime can represent assertion failure and rollback requirement

### Milestone 5 Tickets: Vivarium

#### `DOJO-0501` Scenario DSL Schema

- **Owner:** Simulation Runtime
- **Depends on:** `DOJO-0401`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/vivarium/scenario_dsl.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_scenario_dsl.test.ts`
- **Scope:**
  - define scenario mutation, fixture requirements, oracle, reset profile, budget
  - convert current generated scenarios to DSL format
- **Not in scope:**
  - materializing fixtures
- **Unit tests:**
  - duplicate entity scenario validates
  - fake success scenario validates
  - invalid scenario without oracle fails
- **Merge criteria:**
  - current scenario generator can emit DSL-compatible scenarios

#### `DOJO-0502` Synthetic Fixture Materializer v1

- **Owner:** Simulation Runtime
- **Depends on:** `DOJO-0501`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/vivarium/fixture_materializer.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_fixture_materializer.test.ts`
- **Scope:**
  - materialize in-memory synthetic data fixtures
  - support duplicate entity, stale entity, missing field, threshold breach
  - enforce synthetic-only marker
- **Not in scope:**
  - browser page rendering
  - API fault server
- **Unit tests:**
  - duplicate entity fixture contains two stable IDs
  - production data ref rejected
  - same seed produces same fixture
- **Merge criteria:**
  - fixture materialization is deterministic

#### `DOJO-0503` API Fault Server v1

- **Owner:** Simulation Runtime
- **Depends on:** `DOJO-0502`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/vivarium/api_fault_server.ts`
  - `mcp/synthi-mcp/tests/integration/dojo_api_fault_server.test.ts`
- **Scope:**
  - local test-only mock server
  - support success, validation error, timeout, partial write, fake success
- **Not in scope:**
  - production hosted environment
- **Integration tests:**
  - fake success returns UI success and failed state check
  - partial write leaves oracle-detectable mismatch
- **Merge criteria:**
  - tests can run without external services

#### `DOJO-0504` Scenario Oracle v1

- **Owner:** Simulation Runtime / Evidence Platform
- **Depends on:** `DOJO-0502`, `DOJO-0302`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/vivarium/oracle.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_scenario_oracle.test.ts`
- **Scope:**
  - classify pass/fail/block from observed fixture state and graph result
  - append oracle evidence record
- **Not in scope:**
  - all future oracle types
- **Unit tests:**
  - expected block classifies as blocked
  - wrong entity classifies as failed
  - successful assertion classifies as passed
- **Merge criteria:**
  - scenario outcome no longer depends only on static heuristics

### Milestone 6 Tickets: Checkride And Case Law

#### `DOJO-0601` Executable Checkride Runner v1

- **Owner:** Dojo Runtime Core / Simulation Runtime
- **Depends on:** `DOJO-0403`, `DOJO-0504`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/checkride/runner.ts`
  - `mcp/synthi-mcp/tests/integration/dojo_checkride_runner.test.ts`
- **Scope:**
  - run a small scenario suite through graph runtime and oracle
  - produce evidence-backed checkride report
- **Not in scope:**
  - full Evil Twin attack generation
- **Integration tests:**
  - happy path alone not enough for E3 when risk scenario fails
  - blocked risk scenario constrains license
- **Merge criteria:**
  - checkride result uses runtime scenario evidence

#### `DOJO-0602` Entrustment And SRL Policy v1

- **Owner:** Proof And License / Governance
- **Depends on:** `DOJO-0601`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/checkride/entrustment.ts`
  - `mcp/synthi-mcp/src/dojo/checkride/readiness.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_entrustment_policy.test.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_srl_policy.test.ts`
- **Scope:**
  - compute E-level and SRL from checkride evidence
  - encode critical-failure and stale-evidence rules
- **Not in scope:**
  - UI display
- **Unit tests:**
  - critical failure returns EX or blocked recommendation
  - E3 requires guardrails and evidence
  - SRL 7 requires limited production license
- **Merge criteria:**
  - license issuing can consume policy output

#### `DOJO-0603` Case Law Registry v1

- **Owner:** Governance / Case Law Runtime
- **Depends on:** `DOJO-0302`, `DOJO-0601`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/case_law/registry.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_case_law_registry.test.ts`
- **Scope:**
  - create proposed case from failed run
  - approve/deprecate cases
  - lookup binding cases by scope
- **Not in scope:**
  - full UI review queue
- **Unit tests:**
  - proposed case does not enforce
  - approved case is binding
  - deprecated case not binding
- **Merge criteria:**
  - case law lifecycle state exists

#### `DOJO-0604` Case Law Guardrail Binding

- **Owner:** Case Law Runtime / Dojo Runtime Core
- **Depends on:** `DOJO-0603`, `DOJO-0404`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/case_law/guardrail_synthesizer.ts`
  - `mcp/synthi-mcp/tests/integration/dojo_case_law_guardrail_runtime.test.ts`
- **Scope:**
  - approved case can synthesize guardrail predicate
  - graph runtime can execute synthesized guardrail
- **Not in scope:**
  - organization-wide antibody matching
- **Integration tests:**
  - duplicate display name case creates stable-ID guardrail
  - guardrail blocks production action
- **Merge criteria:**
  - case law has runtime enforcement path

### Milestone 7 Tickets: Source/API

#### `DOJO-0701` Source Snapshot Contract

- **Owner:** Source-Aware Automation
- **Depends on:** `DOJO-0001`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/source/source_snapshot.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_source_snapshot.test.ts`
- **Scope:**
  - define release-scoped source snapshot
  - sign/hash snapshot metadata
  - map source token to app release
- **Not in scope:**
  - codemods
- **Unit tests:**
  - same snapshot hashes stable
  - source token scoped by release
- **Merge criteria:**
  - source drift work can depend on snapshot schema

#### `DOJO-0702` Source Drift Expiry

- **Owner:** Source-Aware Automation / Proof And License
- **Depends on:** `DOJO-0701`, `DOJO-0602`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/source/source_drift.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_source_drift.test.ts`
- **Scope:**
  - compare snapshots
  - identify affected skill nodes
  - produce license expiry trigger
- **Not in scope:**
  - UI diff
- **Unit tests:**
  - changed source token expires mapped node
  - unrelated source change does not expire skill
- **Merge criteria:**
  - source drift can downgrade license

#### `DOJO-0703` Agent-Ready UI Contract Schema And Linter

- **Owner:** Source-Aware Automation
- **Depends on:** `DOJO-0701`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/source/agent_ready_ui_contract.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_agent_ready_ui_contract.test.ts`
- **Scope:**
  - schema validate UI contract
  - lint proof-required risky actions
  - lint stable locator and success hook
- **Not in scope:**
  - PR generation
- **Unit tests:**
  - missing proof hook fails risky action contract
  - valid contract passes
- **Merge criteria:**
  - UI contract can be CI-gated

#### `DOJO-0704` API Candidate Contract

- **Owner:** Source-Aware Automation
- **Depends on:** `DOJO-0701`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/api/types.ts`
  - `mcp/synthi-mcp/src/dojo/api/endpoint_inference.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_api_candidate.test.ts`
- **Scope:**
  - define API endpoint candidate schema
  - infer simple candidate from known network trace metadata
  - require auth, mutation, idempotency, rollback, and postcondition fields before approval
- **Not in scope:**
  - broad arbitrary stack inference
- **Unit tests:**
  - candidate missing idempotency cannot be promoted
  - mutation endpoint requires postcondition
- **Merge criteria:**
  - API substrate review has stable object model

#### `DOJO-0705` Substrate Executor Interface

- **Owner:** Dojo Runtime Core / Source-Aware Automation
- **Depends on:** `DOJO-0403`, `DOJO-0703`, `DOJO-0704`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/graph/substrate_executor.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_substrate_executor.test.ts`
- **Scope:**
  - define common substrate execution interface
  - implement no-op/fake DOM and fake API executors for tests
  - graph runtime calls substrate executor instead of direct action
- **Not in scope:**
  - real broad API execution
- **Unit tests:**
  - API substrate rejected without approved candidate
  - UI fallback rejected when license says API/MCP only
- **Merge criteria:**
  - graph runtime can choose and enforce substrate policy

### Milestone 8 Tickets: Generated PR

#### `DOJO-0801` Affordance Codemod Plan Contract

- **Owner:** Source-Aware Automation
- **Depends on:** `DOJO-0703`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/source/affordance_pr_plan.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_affordance_pr_plan.test.ts`
- **Scope:**
  - turn current JSON PR plan into typed patch operations
  - include before/after validation expectations
- **Not in scope:**
  - editing files
- **Unit tests:**
  - stable locator patch operation validates
  - proof hook patch operation validates
- **Merge criteria:**
  - codemod can consume typed operations

#### `DOJO-0802` React Affordance Codemod v1

- **Owner:** Source-Aware Automation
- **Depends on:** `DOJO-0801`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/source/codemod.ts`
  - `mcp/synthi-mcp/tests/integration/dojo_react_affordance_codemod.test.ts`
- **Scope:**
  - apply stable action ID to controlled JSX fixture
  - be idempotent
  - preserve formatting through repo formatter where possible
- **Not in scope:**
  - all frameworks
  - GitHub PR creation
- **Integration tests:**
  - patch applies
  - second patch is no-op
  - component still parses
- **Merge criteria:**
  - generated patch can change real source fixture safely

### Milestone 9 Tickets: UX

#### `DOJO-0901` Dojo Route Shell

- **Owner:** Frontend Dojo UX
- **Depends on:** `DOJO-0002`
- **Files:**
  - `synthi/src/app/workspace/[slug]/dojo/page.jsx`
  - `synthi/src/services/dojoClient.js`
  - `synthi/src/components/dojo/DojoShell.jsx`
  - `synthi/src/components/dojo/__tests__/DojoShell.test.jsx`
- **Scope:**
  - create dedicated Dojo route shell
  - fetch competencies and selected skill summary
  - link from compact workflow drawer
- **Not in scope:**
  - graph editor
- **Unit tests:**
  - shell renders empty state
  - shell renders skill summary
- **Merge criteria:**
  - mature UX has a route outside drawer

#### `DOJO-0902` Skill Passport View

- **Owner:** Frontend Dojo UX
- **Depends on:** `DOJO-0901`
- **Files:**
  - `synthi/src/app/workspace/[slug]/dojo/skills/[skillId]/passport/page.jsx`
  - `synthi/src/components/dojo/SkillPassport.jsx`
  - `synthi/src/components/dojo/__tests__/SkillPassport.test.jsx`
- **Scope:**
  - render license scope, SRL, entrustment, expiry, proof requirements, published tools
- **Not in scope:**
  - editing license
- **Unit tests:**
  - blocked contexts render
  - proof required badge renders
- **Merge criteria:**
  - passport is inspectable from route

#### `DOJO-0903` Graph Editor Read-Only v1

- **Owner:** Frontend Dojo UX
- **Depends on:** `DOJO-0401`, `DOJO-0901`
- **Files:**
  - `synthi/src/app/workspace/[slug]/dojo/skills/[skillId]/cortex/page.jsx`
  - `synthi/src/components/dojo/SkillCortexGraph.jsx`
  - `synthi/src/components/dojo/CortexNodeInspector.jsx`
  - `synthi/src/components/dojo/__tests__/SkillCortexGraph.test.jsx`
- **Scope:**
  - read-only graph visualization
  - node selection
  - inspector for operational memory
- **Not in scope:**
  - graph editing
  - custom layout engine beyond stable readable layout
- **Unit tests:**
  - nodes render
  - selected node opens inspector
- **Playwright milestone test:**
  - graph nonblank and no overlap on desktop
- **Merge criteria:**
  - enterprise graph is inspectable, not editable

#### `DOJO-0904` Proof And Refusal Drawer

- **Owner:** Frontend Dojo UX / Proof And License
- **Depends on:** `DOJO-0106`, `DOJO-0304`
- **Files:**
  - `synthi/src/components/dojo/ProofCapsuleDrawer.jsx`
  - `synthi/src/components/dojo/RefusalExplainerDrawer.jsx`
  - `synthi/src/components/dojo/__tests__/ProofRefusalDrawer.test.jsx`
- **Scope:**
  - display proof claims, validation status, replay/revoke state
  - display blocked-by codes with case-law refs when present
- **Not in scope:**
  - proof issuance backend changes
- **Unit tests:**
  - revoked proof renders blocked
  - case-law refusal cites case
- **Merge criteria:**
  - blocked actions are explainable in UI

### Milestone 10 Tickets: Governance And Release

#### `DOJO-1001` Governance Service Skeleton

- **Owner:** Governance
- **Depends on:** `DOJO-0204`, `DOJO-0603`
- **Files:**
  - `mcp/synthi-mcp/src/dojo/governance/service.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_governance_service.test.ts`
- **Scope:**
  - license health query
  - approval queue query
  - case-law review queue query
- **Not in scope:**
  - full dashboard
- **Unit tests:**
  - expired license appears in health
  - proposed case appears in review queue
- **Merge criteria:**
  - frontend governance can fetch stable view model

#### `DOJO-1002` Governance Dashboard v1

- **Owner:** Frontend Dojo UX / Governance
- **Depends on:** `DOJO-1001`, `DOJO-0901`
- **Files:**
  - `synthi/src/app/workspace/[slug]/dojo/governance/page.jsx`
  - `synthi/src/components/dojo/GovernanceOverview.jsx`
  - `synthi/src/components/dojo/ApprovalQueue.jsx`
  - `synthi/src/components/dojo/LicenseHealthBoard.jsx`
  - `synthi/src/components/dojo/__tests__/GovernanceDashboard.test.jsx`
- **Scope:**
  - read-only governance dashboard
  - approval and license health lists
- **Not in scope:**
  - approving/revoking from UI
- **Unit tests:**
  - approval rows render
  - stale license rows render
- **Merge criteria:**
  - governance state visible

#### `DOJO-1003` Deployed MCP Conformance Harness

- **Owner:** Validation / Release Engineering
- **Depends on:** `DOJO-0203`, `DOJO-0305`, `DOJO-0104`, `DOJO-0105`
- **Files:**
  - `mcp/synthi-mcp/scripts/dojo-mcp-host-conformance.mjs`
  - `mcp/synthi-mcp/tests/live/dojo_mcp_host_conformance.test.ts`
- **Scope:**
  - script accepts non-loopback MCP host
  - verifies proof-gated skill call
  - verifies raw backing tool blocked
  - verifies revocation propagation
- **Not in scope:**
  - production deployment automation
- **Live tests:**
  - runs only when host env vars provided
- **Merge criteria:**
  - release branch can run conformance against external host

---

## First 10 Mergeable PRs In Exact Order

These are the first PRs to create from the current branch. They are intentionally narrow. They build the enforcement foundation without trying to solve Vivarium, graph runtime, or UX in the same sequence.

### PR 1: `DOJO-0001` Implementation Status Manifest

- **Branch name:** `dojo/status-manifest`
- **Primary files:**
  - `docs/AGENT_DOJO_IMPLEMENTATION_STATUS.md`
  - `mcp/synthi-mcp/src/dojo/status/implementation_status.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_implementation_status.test.ts`
- **Why first:** prevents future overclaiming and gives tool responses a source of truth.
- **Required tests:** T0, T1.
- **Merge output:** status registry exists; no runtime behavior changes.

### PR 2: `DOJO-0002` Tool Response Status Metadata

- **Branch name:** `dojo/tool-status-metadata`
- **Primary files:**
  - `mcp/synthi-mcp/src/tools/dojo.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_tools.test.ts`
- **Depends on:** PR 1
- **Why second:** makes current scaffold/runtime distinction visible to clients and UI.
- **Required tests:** T0, T1, focused `dojo_tools`.
- **Merge output:** Dojo responses declare `implementation_status`.

### PR 3: `DOJO-0101` Production Enforcement Config

- **Branch name:** `dojo/production-enforcement-config`
- **Primary files:**
  - `mcp/synthi-mcp/src/dojo/config/enforcement.ts`
  - `mcp/synthi-mcp/src/browser/deployment_readiness.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_enforcement_config.test.ts`
- **Depends on:** PR 1
- **Why third:** creates explicit production/development semantics before enforcement logic.
- **Required tests:** T0, T1, deployment readiness focused tests.
- **Merge output:** deployment readiness can flag insecure Dojo production config.

### PR 4: `DOJO-0102` Execution Policy Gate Interface

- **Branch name:** `dojo/execution-policy-gate`
- **Primary files:**
  - `mcp/synthi-mcp/src/dojo/mcp/execution_policy_gate.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_execution_policy_gate.test.ts`
- **Depends on:** PR 3
- **Why fourth:** defines the central policy decision contract before wiring entrypoints.
- **Required tests:** T0, T1.
- **Merge output:** policy decisions can be computed but are not yet wired to all entrypoints.

### PR 5: `DOJO-0103` Published Workflow Mapping Registry

- **Branch name:** `dojo/published-workflow-index`
- **Primary files:**
  - `mcp/synthi-mcp/src/dojo/store/published_workflow_index.ts`
  - `mcp/synthi-mcp/src/browser/dojo_store.ts`
  - `mcp/synthi-mcp/src/tools/dojo.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_published_workflow_index.test.ts`
- **Depends on:** PR 4
- **Why fifth:** the policy gate needs to know which workflows/tools are Dojo-published.
- **Required tests:** T0, T1, focused publish-skill tests.
- **Merge output:** publish path records workflow/tool -> skill mapping.

### PR 6: `DOJO-0104` Private Tool Entrypoint Gate

- **Branch name:** `dojo/private-tool-entrypoint-gate`
- **Primary files:**
  - `mcp/synthi-mcp/src/tools/browser.ts`
  - `mcp/synthi-mcp/src/tools/dojo.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_private_tool_gate.test.ts`
- **Depends on:** PR 5
- **Why sixth:** closes the most direct backing private tool bypass.
- **Required tests:** T0, T1, T2 focused dispatcher tests.
- **Merge output:** direct backing private tool call is blocked for Dojo-published tools in production mode.

### PR 7: `DOJO-0105` Raw Browser Workflow Replay Gate

- **Branch name:** `dojo/browser-workflow-replay-gate`
- **Primary files:**
  - `mcp/synthi-mcp/src/tools/browser.ts`
  - `mcp/synthi-mcp/src/browser/broker.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_browser_workflow_gate.test.ts`
- **Depends on:** PR 5
- **Why seventh:** closes the raw saved workflow replay path.
- **Required tests:** T0, T1, T2 focused workflow dispatch tests.
- **Merge output:** `synthi_browser_run_workflow` cannot bypass Dojo for published production skills.

### PR 8: `DOJO-0106` Proof Error Taxonomy

- **Branch name:** `dojo/proof-error-taxonomy`
- **Primary files:**
  - `mcp/synthi-mcp/src/dojo/proof/errors.ts`
  - `mcp/synthi-mcp/src/browser/dojo_license_kernel.ts`
  - `mcp/synthi-mcp/src/tools/dojo.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_proof_errors.test.ts`
- **Depends on:** PR 3
- **Why eighth:** frontend refusal UX and later policy tests need stable block codes.
- **Required tests:** T0, T1, focused proof validation tests.
- **Merge output:** proof/license blocks are stable and testable by code.

### PR 9: `DOJO-0201` Store Interface Split

- **Branch name:** `dojo/store-interface-split`
- **Primary files:**
  - `mcp/synthi-mcp/src/dojo/store/interfaces.ts`
  - `mcp/synthi-mcp/src/browser/dojo_store.ts`
  - `mcp/synthi-mcp/tests/unit/dojo_store_interfaces.test.ts`
- **Depends on:** PR 5
- **Why ninth:** Postgres and durable proof work need stable interfaces.
- **Required tests:** T0, T1, existing `dojo_store` tests.
- **Merge output:** store consumers depend on interfaces rather than concrete store classes.

### PR 10: `DOJO-0202` Dojo Postgres Schema Migration

- **Branch name:** `dojo/postgres-schema-migration`
- **Primary files:**
  - `mcp/synthi-mcp/src/dojo/store/migrations.ts`
  - `mcp/synthi-mcp/tests/integration/dojo_postgres_schema.test.ts`
- **Depends on:** PR 9
- **Why tenth:** unlocks durable proof records, audit events, evidence ledger, and tenant isolation.
- **Required tests:** T0, T1 migration helpers, T2 integration with test DB.
- **Merge output:** schema exists for tenants, workspaces, skills, licenses, proof records, and audit events.

### Why The First 10 Stop Here

The first 10 PRs intentionally stop at schema migration. They do not yet build evidence ledger, graph runtime, Vivarium runner, or UX. That is correct. The next tranche becomes possible only after the execution boundary and durable schema exist.

Next tranche after PR 10:

1. `DOJO-0203` Postgres Proof Repository
2. `DOJO-0204` Audit Event Repository
3. `DOJO-0301` Evidence Ledger Schema
4. `DOJO-0302` Evidence Ledger Store
5. `DOJO-0303` Evidence Claim Verifier Skeleton
6. `DOJO-0304` Proof Issuance Requires Verified Claims
7. `DOJO-0305` Production Proof Signing Interface
8. `DOJO-0401` Graph IR Schema
9. `DOJO-0402` Graph Compiler Adapter
10. `DOJO-0403` Graph Runtime Skeleton

---

## Revised Immediate Next Build Recommendation

The next engineering step is not "build the whole universe." It is to merge the first enforcement foundation PRs in order.

Start with:

```text
PR 1: DOJO-0001 Implementation Status Manifest
PR 2: DOJO-0002 Tool Response Status Metadata
PR 3: DOJO-0101 Production Enforcement Config
PR 4: DOJO-0102 Execution Policy Gate Interface
PR 5: DOJO-0103 Published Workflow Mapping Registry
```

Then close bypass paths:

```text
PR 6: DOJO-0104 Private Tool Entrypoint Gate
PR 7: DOJO-0105 Raw Browser Workflow Replay Gate
PR 8: DOJO-0106 Proof Error Taxonomy
```

Then prepare durable state:

```text
PR 9: DOJO-0201 Store Interface Split
PR 10: DOJO-0202 Dojo Postgres Schema Migration
```

Only after these should implementation move into durable proof records, evidence ledger, proof claim verification, graph runtime, Vivarium, and the enterprise UX.
