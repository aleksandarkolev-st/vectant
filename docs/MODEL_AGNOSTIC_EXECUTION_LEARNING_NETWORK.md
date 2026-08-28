# Vectant Model-Agnostic Execution Learning Network

**Status:** implementation design  
**Audience:** platform, CodeSite, agent-runtime, MCP, security, data, and product teams  
**Primary objective:** learn evidence-qualified, bounded decision policies from agent evidence and make them reusable across projects and, with explicit participation and strong anonymization, across organizations  
**Design posture:** evidence-first, model-agnostic, privacy-preserving, reversible, and resistant to poisoning

## 1. Executive summary

Vectant should evolve from an execution environment that helps one agent complete one task into an execution-learning system that improves whenever participating agents solve real problems.

The unit of learning is not a chat transcript, a model-specific chain of thought, or a successful command sequence. It is a generalized, independently evaluated **decision policy**:

```text
problem fingerprint
    -> applicability predicate
    -> bounded strategy and branches
    -> stop conditions
    -> verification predicate
    -> calibrated outcomes
```

An execution episode is evidence from which Vectant may infer or strengthen such a policy. It does not prove why a trajectory worked, and it is never itself the learned object:

```text
agent execution
    -> structured local episode
    -> objective outcome verification
    -> typed evidence and strict anonymized projection
    -> existing-policy evidence update or private policy candidate
    -> applicability, counterfactual, sandbox, and cross-project evaluation
    -> immutable decision-policy version
    -> human/machine public brief projection
    -> retrieval by compatible future tasks
    -> local applicability + authorization + bounded execution
    -> causally attributable outcome feedback
    -> promotion, decay, quarantine, or revocation
```

The resulting repository becomes a compounding data asset because it contains evidence-backed mappings from recurring problem signatures to applicable, bounded, empirically qualified strategies. A smaller or cheaper model can retrieve a narrow decision policy rather than rediscovering the entire strategy through expensive inference.

This can reduce input tokens, retries, latency, and frontier-model escalation. It does not automatically guarantee frontier-level performance. That claim becomes defensible only after Vectant's evaluation system shows comparable task success, safety, and review quality on representative enterprise workloads.

The system must remain model-agnostic. OpenAI, Anthropic, Gemini, open-weight, local, and future models should all produce and consume the same provider-neutral episode, solution, tool, verification, and feedback contracts. Provider identity is evaluation metadata, never part of the solution's required semantics.

## 2. Product thesis

The network effect is:

1. More participating execution environments produce more evidence-bearing episodes.
2. More episodes expose repeated errors, collisions, and successful strategies.
3. Repeated and sufficiently independent evidence improves policy coverage, applicability calibration, and reliability estimates.
4. Better retrieval reduces reasoning work for every compatible agent.
5. Lower task cost and better success attract more use, producing more evidence.

Vectant's moat is therefore not raw conversation volume. Raw conversations are noisy, provider-specific, privacy-sensitive, and difficult to verify. The moat is a repository of:

- normalized problem fingerprints;
- generalized execution strategies;
- environment compatibility constraints;
- objective verification evidence;
- independent success and failure outcomes;
- version history, drift information, and revocation lineage;
- cost and latency savings measured against no-retrieval baselines.

**Stack Overflow for agents** is a useful retrieval and presentation metaphor, not the internal learning model. A public brief may look like an anonymous question and accepted answer, but its backing object is a decision policy with a normalized problem, an applicability predicate, a bounded strategy, stop conditions, a verification predicate, and calibrated outcomes. It has no public author identity and earns rank from reproducibility, safety, applicability, and incremental economic benefit rather than votes.

Every eligible evidence-qualified solve should contribute **evidence**. Not every solve contributes **knowledge**. A solve matching an existing policy updates its evidence. A novel solve creates or updates a private candidate. Only a candidate that passes privacy, verifier-sufficiency, applicability, reproducibility, safety, and independence gates can produce a network-visible policy version and public brief. This prevents the repository from becoming a searchable accumulation of one-off successes.

## 3. Non-negotiable principles

### 3.1 Model-agnostic contracts

- The platform stores provider-neutral task and tool semantics.
- No stored procedure may require a provider-specific prompt format.
- Tokenized text is not a canonical representation because tokenizers change by provider and model version.
- Tool capabilities are negotiated by stable tool identifiers and JSON schemas.
- Model and provider names may be retained only as restricted evaluation dimensions.
- A solution is portable only when more than one eligible runtime or model family can interpret its contract, or when it is explicitly marked runtime-specific rather than model-specific.

### 3.2 Evidence before learning

- A model saying that a task succeeded is not evidence.
- Completion requires machine-checkable results where possible: tests, build, typecheck, deployment health, invariant checks, diff inspection, or explicit human acceptance.
- Adoption is not success and must not increase reliability.
- A solution's network rank comes from independent outcomes, not popularity.
- A successful trajectory establishes an observation, not causality and not a reusable policy.
- Recommendation followed by success is not sufficient attribution; promotion and economic claims require a compatible baseline or counterfactual.
- Applicability false positives are treated as more costly than retrieval misses. When evidence is insufficient or applicability is uncertain, abstention is the correct result.

### 3.3 Anonymous by construction

- Raw prompts, hidden reasoning, transcripts, source files, terminal history, credentials, environment values, user identities, repository names, organization names, and provider session references never enter the shared repository.
- Shared payloads use an allowlist schema. Removing known-secret keys from arbitrary JSON is insufficient.
- Data that cannot be confidently generalized is kept project-local or discarded.
- Cross-workspace publication and intake are explicit policy choices.

### 3.4 Bounded self-evolution

- The system evolves the repository, retrieval policy, and empirically calibrated ranking.
- It does not autonomously rewrite its policy engine, security boundaries, evaluator, or promotion thresholds.
- New knowledge is versioned and reversible.
- Every published solution has an immediate quarantine and revocation path.

### 3.5 Retrieval is guidance, not authority

- A retrieved solution does not grant tool permission or mutation permission.
- The consuming agent must still obey the receiving workspace's CodeSite control plan, leases, path rules, approvals, and release gates.
- Network knowledge cannot weaken local policy.
- A network artifact is never directly executable. The runtime must structurally pass it through lifecycle trust filtering, local applicability evaluation, local authorization, a bounded execution adapter, and local verification.
- Retrieval must be allowed to return an explicit, auditable `abstain` decision rather than forcing a low-confidence recommendation.

## 4. Terminology

| Term | Definition |
|---|---|
| **Episode** | One bounded attempt to complete a declared task, from orientation through verification or abandonment. Its typed steps are local supporting records. |
| **Evidence** | Objective verifier results and typed episode facts supporting or contradicting a candidate or policy. A trace capsule is only an anonymous projection of Evidence. |
| **Candidate** | A private generalized decision-policy hypothesis inferred from one or more compatible Evidence records. Not consumer-visible. |
| **Decision policy** | `problem fingerprint -> applicability predicate -> bounded strategy -> stop conditions -> verification predicate`. This is the unit of learning. |
| **SolutionVersion** | The immutable implementation/storage name for one approved decision-policy version. A public brief is its distribution projection. |
| **Recommendation** | A selective-decision record whose output is `recommend` or `abstain`, including eligibility, retrieval, display, selection, following, thresholds, and reason codes. Ordinary solution adoption is recommendation state, not success. |
| **Outcome** | The unit of measurement: observed success, failure, regression, revert, inconclusive/no-op result, verifier-strength vector, applicability result, safety result, and cost attached to an episode/recommendation. Evaluation runs are specialized Outcomes. |
| **Problem fingerprint** | A normalized signature describing the problem without source identifiers or proprietary content. |
| **Fleet NOTAM adoption** | A separate local governance decision that may affect clearance. It is intentionally not collapsed into ordinary Recommendation state. |
| **Abstention** | An explicit Recommendation output meaning Vectant does not have a sufficiently applicable, safe, or well-supported policy. It is a valid calibrated decision, not a system error. |
| **Learning network** | The cross-workspace repository and retrieval plane containing only published anonymous solution versions. |

The conceptual core therefore has six aggregate objects: `Episode`, `Evidence`, `Candidate`, `SolutionVersion`, `Recommendation`, and `Outcome`. Steps, capsules, briefs, lifecycle events, evaluations, catalog items, and ordinary adoption are child records, projections, specialized outcomes, or delivery compatibility layers—not competing learning objects.

## 5. Existing Vectant foundations

Vectant already has several primitives that should be extended rather than replaced:

- `CodeSiteProject`, `CodeSiteAgentSession`, and `CodeSiteEvent` provide scoped projects, model/provider metadata, and an ordered event stream.
- `CodeSiteKnowledgeItem` supports typed knowledge, lifecycle state, confidence, verification status, evidence references, causal derivation, deduplication, and learning scopes.
- `shared_skill` records already support `draft`, `pending_review`, `published`, `rejected`, `deprecated`, and `revoked` states.
- `learningNetwork.js` already exposes a redacted projection for published, high-confidence, read-only workspace or learning-network skills.
- `CodeSiteCounterfactualRun` provides a foundation for shadow evaluation and alternative execution universes.
- CodeSite agent context can deliver a learning catalog during orientation.
- The CodeSite UI can list, refresh, adopt, and opt into multi-workspace learning.
- MCP advertises shared-skill publication, learning-catalog listing, learning adoption, and control-plan updates through the canonical tool registry.

The missing system is the automatic, trustworthy path from raw local execution to typed Evidence, from Evidence to a validated decision policy, and from a recommendation to a causally attributable Outcome.

## 6. Target architecture

```text
┌──────────────────────────────── Source workspace ────────────────────────────────┐
│                                                                                  │
│  Model/runtime A, B, C...                                                        │
│       │                                                                          │
│       ▼                                                                          │
│  MCP + Agent Runtime ── typed observations/tool calls/results ──┐                │
│                                                                ▼                │
│                                                       Episode Collector          │
│                                                                │                │
│                         local raw data only                     ▼                │
│                                                       Outcome Verifier           │
│                                                                │                │
│                                                                ▼                │
│                                                  Evidence + Capsule Projection   │
│                                                                │                │
│                                          allowlist + DLP + anonymization         │
└────────────────────────────────────────────────────────────────┼────────────────┘
                                                                 ▼
┌──────────────────────────── Vectant learning control plane ──────────────────────┐
│  Evidence Store -> Cluster/Dedupe -> Policy Candidate -> Applicability Evaluator │
│         │                                                    │                   │
│         └──────── counterfactual + sandbox outcomes + lineage ─┘                 │
│                                      │                                           │
│                                      ▼                                           │
│                            Promotion Policy Engine                               │
│                         project -> workspace -> network                           │
│                                      │                                           │
│                                      ▼                                           │
│                   Versioned Anonymous Decision-Policy Repository                 │
│                                      │                                           │
│                    hybrid retrieval + compatibility + ranking                    │
└──────────────────────────────────────┼───────────────────────────────────────────┘
                                       ▼
┌──────────────────────────── Receiving workspace ─────────────────────────────────┐
│ Agent orientation -> trust filter -> applicability -> local authorization        │
│         -> bounded execution -> verification -> attributable outcome feedback    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## 7. Model-agnostic execution contract

Every agent integration must emit the same logical envelope regardless of provider:

```json
{
  "contractVersion": "vectant.execution.v1",
  "episodeId": "local-opaque-id",
  "projectId": "local-only-id",
  "agentSessionId": "local-only-id",
  "runtime": {
    "kind": "codex|claude-code|gemini-cli|local-agent|custom",
    "capabilities": ["filesystem.read", "filesystem.patch", "process.exec"],
    "toolSchemaVersion": "2026-08-01"
  },
  "task": {
    "intentClass": "bug_fix",
    "successCriteria": ["test_suite_passes", "build_passes"],
    "riskClass": "normal"
  },
  "step": {
    "sequence": 17,
    "type": "tool_result",
    "toolId": "process.exec",
    "semanticAction": "run_targeted_tests",
    "resultClass": "success",
    "durationMs": 1842
  }
}
```

Provider adapters translate native SDK or CLI events into this contract. The contract never stores provider prompts or hidden reasoning. When an agent cannot expose a native event stream, Vectant reconstructs the episode from MCP tool calls, CodeSite events, transactions, file provenance, and verification results.

### 7.1 Stable semantic actions

Raw command strings are local evidence. Shared traces use semantic actions such as:

- `inspect_repository_state`;
- `locate_error_origin`;
- `inspect_dependency_contract`;
- `acquire_mutation_lease`;
- `apply_minimal_patch`;
- `run_targeted_tests`;
- `run_full_verification`;
- `resolve_path_collision`;
- `rebase_or_replay_change`;
- `rollback_failed_change`.

An optional portable recipe may include a tightly constrained command template only when policy can prove it contains no paths, values, network destinations, package secrets, or destructive operations.

### 7.2 Capability negotiation

Solutions declare requirements against capability IDs, not model names:

```json
{
  "requiredCapabilities": [
    "filesystem.read",
    "repository.diff",
    "process.exec:sandboxed"
  ],
  "optionalCapabilities": ["language.typescript.diagnostics"],
  "forbiddenCapabilities": ["network.unrestricted"]
}
```

The retrieval layer filters out solutions that cannot run under the receiving session's permissions and tool manifest.

## 8. Local execution episode capture

### 8.1 Episode boundaries

An episode begins when an agent accepts a bounded task or attaches to a CodeSite execution plan. It ends when one of these terminal outcomes occurs:

- observed success with its verifier-strength vector;
- observed failure with its verifier-strength vector;
- abandoned or timed out;
- superseded by another episode;
- reverted after an initially successful completion;
- human-declined completion.

Retries belong to the same episode when the declared task and base snapshot remain stable. A new base snapshot, materially changed success criteria, or ownership transfer creates a linked child episode.

### 8.2 Captured local fields

The protected local episode may contain:

- task and success-criteria references;
- base snapshot and final snapshot digests;
- agent runtime/provider/model metadata;
- tool identifiers, normalized inputs, statuses, durations, and error classes;
- mutations and diff statistics;
- CodeSite path collisions, policy denials, quarantine, and recovery events;
- test/build/typecheck/deployment evidence;
- retrieval recommendations presented to the agent;
- selected solution version, if any;
- token usage, latency, and estimated inference cost;
- human review or acceptance outcome.

Raw sensitive data remains in source-controlled evidence storage with existing workspace access controls and retention rules. It is not copied into learning-network rows.

### 8.3 Event sourcing and idempotency

- Steps are append-only and ordered by `(episodeId, sequence)`.
- Agents send an idempotency key per step.
- The collector rejects sequence rewrites and records late events explicitly.
- Completion is a separate operation and cannot silently modify prior steps.
- A transactional outbox schedules verification and capsule generation after persistence.

## 9. Outcome evidence and verifier strength

Passing tests is strong evidence about the properties those tests exercise; it is not proof that a change is semantically correct. Existing tests may be incomplete, incorrectly scoped, or encode the wrong behavior. Vectant must therefore store the observed outcome separately from the strength and semantic reach of its verifier evidence.

The verifier produces a signed evidence vector wherever possible:

```json
{
  "outcome": "success",
  "verifierSignals": [
    {"kind": "deterministic_targeted_test", "status": "pass", "scope": "changed_contract", "evidenceDigest": "sha256:..."},
    {"kind": "build", "status": "pass", "scope": "workspace", "evidenceDigest": "sha256:..."},
    {"kind": "domain_invariant", "status": "pass", "scope": "protected_paths", "evidenceDigest": "sha256:..."}
  ],
  "verifierStrength": {
    "tier": "strong_for_declared_criteria",
    "coverage": "targeted_plus_workspace",
    "semanticReach": "declared_invariants_only",
    "independence": "project_defined",
    "unverifiedClaims": ["downstream_business_behavior"]
  },
  "regressionWindow": "7d",
  "verifierVersion": "vectant.verifier.v1"
}
```

Canonical `outcome` is `success`, `failure`, `regression`, `inconclusive`, or `no_op`; it is never internally collapsed into `verified_success`. `abstain` is a Recommendation decision, not proof of an episode outcome. Whether outcome evidence is sufficient for local use, workspace publication, network publication, ranking, or a Fleet NOTAM is decided by explicit policy thresholds for the relevant problem class.

Verifier signal kinds include:

- `deterministic_targeted_test`;
- `full_suite`;
- `build`;
- `static_analysis`;
- `deployment_health`;
- `runtime_probe`;
- `domain_invariant`;
- `transaction_integrity`;
- `human_acceptance`;
- `delayed_regression_window`;
- `model_review`, which is advisory and never independently sufficient.

Verifier strength is multidimensional rather than a universal scalar. Store signal kind, scope, coverage, independence, semantic reach, freshness, negative-test coverage, regression window, and verifier version. A derived tier may be used for filtering and UI, but must be calibrated per problem class; for example, a domain invariant may be more semantically meaningful than a large but irrelevant test suite.

Evidence priority is generally:

1. deterministic project tests and invariants;
2. compiler, typechecker, linter, and build results;
3. deployment or runtime health checks;
4. CodeSite policy and mutation-transaction evidence;
5. structured human approval;
6. model-based review, which may recommend review but cannot independently mark a network candidate successful.

An episode is not eligible for shared distillation when the only success signal is the producing agent's narrative. Passing a build alone may support a narrow compilation claim but cannot establish broader behavioral correctness unless the policy's verification predicate requires only that claim.

### 9.1 Verification sufficiency policy

Each Candidate and SolutionVersion declares the minimum acceptable evidence vector for its claims. Promotion evaluates the observed signals against that declaration and records `sufficient`, `insufficient`, or `inconclusive` plus reason codes. Missing semantic coverage cannot be compensated for merely by increasing the number of repetitions of the same weak verifier.

Public briefs expose a coarse verifier-strength summary and explicit unverified claims. Ranking uses conservative strength and coverage features, while raw internal verifier details and source identifiers remain private.

### 9.2 Delayed negative outcomes

An initially passing episode may later be associated with:

- revert commits;
- reopened incidents;
- regression tests that identify the change;
- failed deployment or rollback;
- reviewer rejection;
- a replacement solution marked as corrective.

These events must update the episode outcome and every derived candidate through lineage, without deleting history.

## 10. Anonymous Evidence capsule

The capsule is the network-safe projection of Evidence, not the unit of learning and not an executable recipe. Historical ordering is secondary observational evidence: it can help generate a Candidate, but it does not establish that the sequence or every included step caused the outcome.

### 10.1 Allowlisted schema

Only the following classes may leave the source workspace:

- generalized problem fingerprint;
- language/framework/runtime families at a coarse version range;
- normalized error or collision class;
- typed observations and decision points;
- coarse historical action classes and ordering, labeled non-causal;
- locally observed applicability facts and unknowns;
- portable verification facts and postconditions;
- capability requirements;
- coarse change statistics;
- verifier result classes and digests;
- privacy-safe latency, token, and cost buckets;
- rotating anonymous contribution cohort;
- redaction and capsule-builder versions.

The capsule must not contain:

- raw prompts or responses;
- chain-of-thought or internal reasoning;
- source code or diff content;
- repository, organization, user, branch, workspace, or project identifiers;
- absolute or relative proprietary file paths;
- terminal history or unrestricted command output;
- URLs, hostnames, IP addresses, email addresses, issue identifiers, or customer names;
- environment values, credentials, cookies, tokens, signing material, or connection strings;
- provider session IDs;
- free-form evidence references that can be resolved outside the source workspace.

### 10.2 Example capsule

```json
{
  "schemaVersion": "vectant.trace-capsule.v1",
  "problem": {
    "domain": "typescript_build",
    "class": "module_contract_mismatch",
    "symptoms": ["named_export_missing", "consumer_compile_failure"],
    "environment": {
      "language": "typescript",
      "runtimeMajor": "20",
      "packageManagerFamily": "npm",
      "repositoryShape": "workspace_monorepo"
    }
  },
  "pathEvidence": {
    "causalStatus": "observational_only",
    "actions": [
    "inspect_failing_consumer",
    "inspect_provider_exports",
    "compare_public_contract",
    "apply_minimal_contract_patch",
    "run_targeted_tests",
    "run_build"
    ],
    "applicabilityObservations": [
      "provider_symbol_present",
      "public_export_missing"
    ],
    "unresolvedConfounders": []
  },
  "result": {
    "outcome": "success",
    "verifierStrengthTier": "strong_for_declared_criteria",
    "criteria": ["targeted_tests_pass", "build_pass"],
    "changeSizeBucket": "small",
    "attemptBucket": "2-3"
  },
  "privacy": {
    "classification": "network_safe",
    "scannerVersion": "vectant.redactor.v1",
    "quasiIdentifierRisk": "low"
  }
}
```

### 10.3 Anonymization pipeline

The pipeline is defense in depth:

1. **Structural allowlist:** construct a fresh capsule from known typed fields; never redact and forward arbitrary event JSON.
2. **Canonicalization:** convert errors, tools, frameworks, paths, versions, and outcomes into controlled taxonomies.
3. **Secret scanning:** apply entropy analysis and credential/vendor detectors.
4. **PII and proprietary-identifier scanning:** names, emails, domains, URLs, IPs, ticket IDs, account IDs, and organization-specific tokens.
5. **Path generalization:** convert local paths into roles such as `consumer_module`, `provider_module`, and `targeted_test`.
6. **Literal suppression:** remove string, numeric, hash, and UUID literals unless they belong to an approved enum or coarse bucket.
7. **Quasi-identifier analysis:** reject combinations that are individually safe but uniquely identify a tenant or repository.
8. **Outbound policy validation:** fail closed when the capsule contains unknown fields or unclassified strings.
9. **Irreversible network identity:** use a rotating anonymous cohort token generated by a separate privacy service. The repository must not be able to map it back to a tenant.

### 10.4 Cohort privacy

For network-visible aggregate claims, Vectant should use thresholds such as:

- do not expose tenant counts below a configured anonymity threshold;
- bucket counts rather than expose exact low-frequency values;
- require sufficient privacy-safe effective independent evidence before labeling a policy broadly proven;
- keep rare or highly identifying fingerprints workspace-scoped until they form a safe cluster;
- rotate contribution cohort tokens so long-term activity cannot fingerprint one organization.

Security and legal review must define the production anonymity threshold and retention policy. The implementation must make the threshold configurable and auditable.

## 11. Problem fingerprinting

A problem fingerprint is designed for matching, not reconstruction. It consists of controlled features:

- domain: compiler, test, runtime, dependency, repository, policy, collision, deployment, browser, data, or tool;
- normalized error class and stable diagnostic code where public;
- language and framework family;
- coarse version compatibility ranges;
- repository topology class;
- failing operation class;
- relevant capability constraints;
- collision topology, such as overlapping path ownership or stale base snapshot;
- verifier requirements;
- privacy-safe symptom tokens.

Both lexical and semantic fingerprints may be generated. Embeddings are optional retrieval indexes, not canonical truth. The canonical fingerprint remains typed and inspectable so it works when embedding providers change.

### 11.1 Public problem brief: the agent Stack Overflow object

The public repository should expose a human-readable brief and a machine-readable contract backed by the same immutable solution version. Any Vectant agent may search these briefs through its project-scoped CodeSite gateway when the receiving organization's network-intake policy allows it; agents never receive direct access to source evidence or repository internals. A brief contains:

| Field | Public meaning |
|---|---|
| `briefId` and `version` | Opaque network identifier and immutable version. |
| `title` | Generalized problem statement, such as “Named export missing after workspace package build.” |
| `problemClass` | Controlled compiler, test, runtime, dependency, collision, policy, or deployment class. |
| `symptoms` | Privacy-safe diagnostic codes and generalized observations. |
| `environment` | Coarse language, framework, runtime, package-manager, and repository-shape compatibility. |
| `applicabilityPredicate` | Typed observations that must be established locally before the policy may be selected. |
| `strategyBrief` | Concise explanation of the bounded decision strategy and why it is expected to apply. |
| `boundedStrategy` | Provider-neutral branches and action classes, never an unrestricted executable command sequence. |
| `stopConditions` | Negative predicates, incompatible cases, escalation points, and forbidden transitions. |
| `verificationPredicate` | Tests and invariants required before claiming success. |
| `evidenceTier` | `qualified`, `proven`, `deprecated`, `quarantined`, or `revoked`; unpublished observations remain candidate evidence. |
| `outcomeSummary` | Bucketed independent success, failure, regression, freshness, and efficiency evidence. |
| `verifierStrength` | Coarse evidence kinds, semantic coverage, regression window, and explicitly unverified claims. |
| `compatibility` | Hard runtime, tool, permission, and version constraints. |
| `updatedAt` | Last evidence or lifecycle update, without contributor information. |

Example human-readable brief:

```markdown
Problem: Named export missing in a TypeScript workspace package

Seen when:
- a consumer compiles against a workspace package;
- the provider builds successfully in isolation;
- the consumer reports a stable missing-export diagnostic.

Historically successful resolution:
1. Inspect the failing consumer import.
2. Inspect the provider's public export surface, not only the implementation file.
3. Compare the intended public contract with the built declaration output.
4. Add or correct the minimal public re-export.
5. Run the package test, the consumer test, and the workspace build.

Do not use when:
- the symbol was intentionally made private;
- the consumer targets an incompatible package version;
- the diagnostic is caused by a path-alias resolution failure.

Evidence: proven across multiple independent compatible environments.
```

No public username, company, repository, project, branch, source path, raw error output, or original code accompanies the brief.

### 11.2 Public brief publication behavior

When an episode records `success` and meets the configured minimum local evidence threshold, the evidence worker performs this sequence:

1. Build the local protected episode and verification result.
2. Construct and scan the anonymous capsule.
3. Generate the public problem fingerprint.
4. Search private and published policy indexes for an existing compatible decision policy.
5. If a compatible policy exists, attach the anonymous Evidence outcome without changing the immutable policy version.
6. If no compatible policy exists, create or update a private Candidate; do not create a public brief.
7. Infer an applicability predicate, bounded strategy, stop conditions, and verification predicate, explicitly separating observed facts from hypotheses.
8. Run schema, privacy, command-safety, applicability, negative-condition, source-counterfactual, fixture, and independence checks.
9. Publish a new SolutionVersion and its brief only when the configured reproducibility, safety, privacy, and evidence gates pass.
10. Record withheld or rejected candidates locally with an auditable reason so later evidence may safely strengthen or split them.

The governing rule is: **every eligible evidence-qualified solve contributes evidence; not every solve contributes knowledge.** A single success may strengthen an already validated policy only to the extent supported by its verifier-strength vector, while a novel one-off trajectory remains a private Candidate. Public search never presents “one agent once succeeded” as a reusable answer.

### 11.3 Fleet NOTAMs: the push layer beside the public brief repository

Vectant should keep the Fleet NOTAM system. It solves a different problem from the public problem-brief repository, and the two mechanisms become stronger when linked rather than merged.

| Dimension | Fleet NOTAM | Public problem brief |
|---|---|---|
| Primary job | Alert projects to a current hazard, compatibility event, or promoted policy delta. | Preserve a durable, reusable answer to a generalized problem. |
| Delivery | Push: relevant advisories appear for matching routes and projects. | Pull: an agent searches or Vectant retrieves at bounded decision points. |
| Time horizon | Time-sensitive; expires, is withdrawn, or is superseded. | Durable; gains evidence, decays, is deprecated, or is revoked. |
| Authority | Locally adopted NOTAMs may alter local clearance or required controls. | Guidance only; selecting a brief never changes clearance or permissions. |
| Scope | Universal across opted-in workspaces and projects, narrowed by compatibility, route, and local project decision state. | Problem fingerprint and compatible execution environments across opted-in workspaces. |
| Evidence source | An existing promoted, evidence-backed policy delta. | Independently evaluated decision policies backed by anonymous Outcomes and replay evidence. |
| Consumer action | Adopt, mute, dismiss, reactivate, inspect, or follow a superseding advisory. | Inspect, select, apply locally, verify, and report the outcome. |
| Lifecycle | Active, expired, withdrawn, or superseded. | Qualified, proven, deprecated, quarantined, or revoked. |

Fleet NOTAM visibility is universal across participating workspaces and projects. Local sovereignty remains mandatory: visibility of a Fleet NOTAM never changes a receiving project's clearance. Only an explicit adoption by that receiving project can do that. A public brief is even less authoritative: it can recommend an approach, but the receiving project's normal permissions, leases, policy, verification, and approval gates always remain in force.

#### 11.3.1 Linking rather than duplicating

A Fleet NOTAM should contain optional opaque links to one or more immutable public brief or decision-policy-version IDs. It should not copy the strategy or expose the source project. The promoted policy delta remains the authoritative source of the NOTAM; the linked brief explains applicability, the bounded strategy, stop conditions, and verification.

The integration flow is:

1. An evidence-qualified execution contributes Evidence to an existing policy or private Candidate; it does not directly create a public brief.
2. Once the decision policy is independently validated, it may produce a public brief. If its evidence also reveals a current fleet-wide hazard, compatibility break, collision pattern, or operational policy need, Vectant may create a **NOTAM proposal** referencing that policy version.
3. Existing Fleet NOTAM publication rules still require a promoted, evidence-backed policy delta. A successful episode or model recommendation alone cannot publish a NOTAM.
4. Matching projects across participating workspaces receive the anonymous advisory through the Fleet NOTAM visibility plane. The advisory can summarize the risk and link to the exact immutable brief version containing the resolution.
5. Opening or selecting the brief gives the agent guidance only. Adopting the NOTAM separately applies its local clearance or radar requirements.
6. When the urgent condition ends, the NOTAM expires or is withdrawn. When guidance changes, it is superseded. The underlying brief remains searchable, with its freshness and lifecycle updated independently.
7. If the linked solution is quarantined or revoked, Vectant immediately removes it from recommendations and proposes quarantine, withdrawal, or supersession of every active dependent NOTAM. It must never silently rewrite an existing advisory.

Not every brief should become a NOTAM. Most solutions are ordinary pull-based knowledge. NOTAM creation is appropriate only when delayed discovery creates material safety, reliability, compatibility, collision, or policy risk. Conversely, every technical NOTAM should ideally link to its supporting brief or evidence summary so agents can move from “be aware” to “here is the historically validated resolution” without another expensive search.

#### 11.3.2 Universal distribution with a private/public split

Fleet NOTAMs are universal across all participating workspaces and projects, but their source records cannot be universal. Vectant must separate two representations:

1. **Private source record:** retained in the publishing workspace and containing the source project, promoted policy delta, full rule candidate, internal audit actor, and lifecycle evidence.
2. **Public Fleet NOTAM envelope:** a signed, anonymous, allowlisted projection containing an opaque NOTAM ID, generalized title and summary, compatibility fingerprint, generalized routes or event classes, evidence tier, expiry, digest, lifecycle state, and optional public brief/version references.

The public envelope must never contain `workspaceSlug`, `originProjectId`, `sourcePolicyDeltaId`, raw rule-candidate fields, internal paths, audit identities, or source evidence. Its universal ID and signature allow every receiving workspace to verify integrity and track withdrawal or supersession without learning who published it.

Universal propagation works as follows:

1. An eligible promoted policy delta produces a private NOTAM source record.
2. The publication pipeline builds and privacy-scans the public envelope.
3. The network distribution plane routes the envelope to every opted-in, compatible project, independent of workspace.
4. Each receiving project records its own `unreviewed`, `adopted`, `muted`, `dismissed`, or `reactivated` state. These decisions never flow back as identifiable tenant activity.
5. Only a locally adopted envelope participates in that project's clearance gate.
6. Withdrawal, expiry, quarantine, and supersession propagate globally by opaque NOTAM ID and signed lifecycle event.

This is the same trust principle as public briefs: reusable knowledge and advisories may cross workspaces, but workspace identity, private policy state, and clearance authority do not.

**Current implementation gap:** `listFleetNotamsForProject`, `decideFleetNotam`, and `fleetNotamClearanceGate` currently constrain database queries by `workspaceSlug`, while `fleetNotamProjection` exposes workspace, project, and policy-delta identifiers. Therefore the checked-in implementation is cross-project within one workspace, not yet universal. The universal design requires the public-envelope and distribution layers above before removing those scope filters.

## 12. Decision-policy candidate generation and generalization

### 12.1 One episode contributes Evidence, not a policy

An evidence-bearing episode produces one or more Evidence records. Vectant first attempts to attach them to an existing compatible Candidate or SolutionVersion. Only genuinely unmatched evidence creates a new private Candidate. A successful path is retained as supporting evidence, never promoted as the policy itself.

The generalizer attempts to derive:

- a typed applicability predicate that can be checked with local observations;
- the causal hypotheses separating relevant decisions from incidental trajectory steps;
- the bounded strategy, branches, and allowed action classes;
- safe optional branches and known failure branches;
- required capabilities and permissions;
- a machine-checkable verification predicate;
- incompatibilities and stop conditions;
- a short human-readable explanation;
- a machine-readable policy that cannot directly invoke tools.

The Candidate must distinguish `observedFacts`, `inferredApplicability`, `strategyHypotheses`, and `unresolvedConfounders`. Missing causal variables keep the Candidate private or narrow its applicability; the distiller may not silently fill them from model intuition.

### 12.2 Distillation can use any model

Distillation and critique jobs use a provider-neutral interface:

```ts
interface LearningModelAdapter {
  id(): string;
  capabilities(): {
    structuredOutput: boolean;
    maxInputBytes: number;
    toolReasoning: boolean;
  };
  distill(input: DistillationInput, signal: AbortSignal): Promise<DecisionPolicyDraft>;
  critique(input: CritiqueInput, signal: AbortSignal): Promise<CritiqueResult>;
}
```

Adapters may call hosted or local models, but their output is validated against the same schema. Deterministic validators, not model identity, decide whether a draft can advance.

### 12.3 Multi-model disagreement

For high-impact or network publication, Vectant may use independent distiller and critic adapters. Agreement is supporting evidence, not proof. If models disagree on preconditions or safety, the candidate stays in review or is split into narrower candidates.

## 13. Applicability, causal evaluation, and replay

Candidates must pass increasingly realistic tests:

1. **Schema and policy evaluation:** the policy is typed, bounded, non-executable, and free of prohibited data.
2. **Source counterfactual:** replay against the source snapshot without access to source-only hidden hints.
3. **Mutation tests:** perturb paths, package versions, error text, task phrasing, and irrelevant repository structure.
4. **Fixture replay:** run against curated public or synthetic fixtures representing the fingerprint.
5. **Cross-project shadow evaluation:** evaluate against consenting compatible project snapshots without mutating their primary workspace.
6. **Model conformance:** verify that multiple model/runtime adapters can consume the solution contract.
7. **Negative tests:** confirm the policy refuses or stops when applicability predicates do not hold.
8. **Confounder tests:** remove or perturb suspected causal variables to determine whether the proposed strategy, rather than an omitted condition, explains success.
9. **Incremental-benefit evaluation:** compare eligible baseline, recommendation, and alternative-policy cohorts while segmenting by problem and environment difficulty.

`CodeSiteCounterfactualRun` should be extended to link candidate and solution versions and record each universe's compatibility, outcome, evidence, and cost.

### 13.1 No public policy from one novel solve

A single privacy-safe, evidence-qualified solve may create or strengthen a private Candidate. It may strengthen an already published compatible policy only for claims covered by its verifier evidence, but it cannot independently create a network-visible brief. New network publication requires configured reproduction outside the source episode, verifier sufficiency, negative and applicability testing, privacy approval, and sufficient effective independent evidence. An approved synthetic or public fixture path may supply reproduction evidence, but model agreement alone cannot.

## 14. Decision-policy repository

### 14.1 Repository object

A network SolutionVersion is an immutable decision-policy object. The legacy “solution” name is a storage and product compatibility label, not a claim that a trajectory is causally complete:

```json
{
  "solutionKey": "typescript.module-contract.named-export.v1",
  "version": 3,
  "status": "published",
  "problemFingerprint": {},
  "applicabilityPredicate": [],
  "boundedStrategy": [],
  "branches": [],
  "stopConditions": [],
  "requiredCapabilities": [],
  "verificationPredicate": [],
  "compatibility": {},
  "safety": {
    "actionClass": "read_only_then_bounded_mutation",
    "maxFiles": 3,
    "networkAccess": "forbidden",
    "directExecution": "forbidden"
  },
  "evaluationSummary": {},
  "lineageDigest": "sha256:...",
  "publishedAt": "..."
}
```

Updates create a new version. Existing versions remain addressable for audit but can be deprecated, quarantined, or revoked.

### 14.2 Recommended persistence additions

Use six conceptual aggregate models. Operational child tables are allowed for scale and integrity, but must not become competing domain concepts:

| Model | Purpose |
|---|---|
| `CodeSiteExecutionEpisode` | Local Episode aggregate. Append-only steps are child records. |
| `CodeSiteEvidence` | Objective verifier evidence, typed observations, evidence digest, privacy decision, and optional anonymous capsule projection. |
| `CodeSitePolicyCandidate` | Private generalized decision-policy hypothesis and promotion state. |
| `CodeSiteSolutionVersion` | Immutable workspace/network decision-policy version; briefs and catalog items are projections. |
| `CodeSiteRecommendation` | Eligibility, retrieval, display, selection, following, and ordinary adoption state. |
| `CodeSiteOutcome` | Verification, applicability, safety, efficiency, and attribution result; sandbox and evaluation runs are typed Outcomes. |

`CodeSiteExecutionStep` and lifecycle-event tables may remain append-only child tables where necessary. Capsule is a projection of Evidence; brief is a projection of SolutionVersion; evaluation is a specialized Outcome; `CodeSiteKnowledgeItem` is a delivery compatibility layer. Large local artifacts stay in scoped object storage, and network rows never reference source storage locations.

### 14.3 Relationship to `CodeSiteKnowledgeItem`

`CodeSiteKnowledgeItem(kind = shared_skill)` remains the project/workspace delivery and review projection. A published shared skill may reference a `CodeSiteSolutionVersion` by opaque solution key and version. It must not become an additional source of truth for policy evidence or outcomes.

## 15. Retrieval and recommendation

### 15.1 Retrieval stages

1. Build a provider-neutral query fingerprint from the current task, diagnostics, repository topology, available tools, and local policy.
2. Apply hard filters for scope, lifecycle status, permissions, required capabilities, language/runtime compatibility, expiration, and local network opt-in.
3. Retrieve candidates using typed fingerprint matches and BM25.
4. Optionally add embedding similarity from a replaceable embedding provider.
5. Rerank with empirical reliability, applicability calibration, environment fit, recency, effective independence, and measured incremental benefit.
6. Apply the selective-recommendation threshold and return exactly one structured decision: `recommend` with a small context pack, or `abstain` with reason codes and a safe next action.

```json
{
  "decision": "abstain",
  "reasonCodes": ["applicability_unknown", "verifier_strength_below_threshold"],
  "bestCandidateScore": 0.41,
  "requiredThreshold": 0.78,
  "nextAction": "continue_local_reasoning_or_escalate"
}
```

Valid abstention reasons include `no_candidate`, `hard_incompatibility`, `applicability_false`, `applicability_unknown`, `evidence_below_threshold`, `verifier_strength_below_threshold`, `conflicting_policies`, `risk_exceeds_benefit`, `policy_blocked`, and `all_candidates_revoked`.

### 15.2 Ranking

A conceptual ranking function is:

```text
rank = compatibility
     * applicability_probability
     * reliability_lower_bound
     * verifier_strength_factor
     * effective_independence_factor
     * recency_and_drift_factor
     * local_policy_factor
     * incremental_benefit_lower_bound
     - regression_penalty
     - ambiguity_penalty
```

Use conservative lower bounds rather than raw rates. Two successes out of two should not outrank ninety-eight successes and two failures. Workspace count is not independence: one tenant may create thousands of highly correlated repositories and episodes. Estimate an effective independent sample size with a hierarchical correlation model over tenant, repository ancestry/topology, runtime, model family, fixture family, dependency cohort, and time cohort. These private dimensions influence calibration but are exposed publicly only as coarse, privacy-safe evidence bands. Do not literally multiply raw diversity counts.

Ranking is a selective prediction problem, not “always return the top result.” The highest-ranked policy is recommended only when it clears problem-class-specific applicability, verifier-strength, safety, and benefit thresholds and is sufficiently separated from conflicting alternatives. Otherwise the output is `abstain`. Threshold calibration uses asymmetric loss in which applying an inapplicable policy is normally more expensive than missing a potentially useful recommendation. Track the risk-coverage curve: Vectant should increase recommendation coverage only while false-application risk remains within the configured bound.

### 15.3 Context budgeting

The repository should reduce inference input, not become another large prompt. When the decision is `recommend`, the default pack should contain:

- problem match summary;
- machine-checkable applicability predicates and stop conditions;
- a bounded strategy with a small number of semantic branches and action classes;
- the verification predicate;
- compatibility and safety notes;
- one optional failure branch;
- opaque solution version ID for outcome reporting.

When the decision is `abstain`, return only reason codes, failed/unknown applicability dimensions, the threshold class, and a bounded next action such as continue local reasoning, gather a specific missing observation, or escalate. Do not include a below-threshold policy “for reference,” because that encourages the consuming model to apply the rejected strategy anyway.

Raw historical traces are never injected into the consuming model.

### 15.4 When an agent queries the repository

Agents should not query after every tool call. Vectant queries at bounded decision points where historical knowledge can avoid expensive rediscovery:

1. **After orientation, before the first mutation:** once Vectant knows the task class, repository shape, language/runtime, available tools, and local policy, it runs a low-cost proactive search. This is primarily useful for recognized maintenance tasks and known collision patterns.
2. **When a stable error appears:** compiler code, test failure class, runtime exception class, dependency-resolution failure, deployment failure, or tool failure produces a reactive fingerprint and immediate query.
3. **When CodeSite detects a collision:** path-lock denial, overlapping mutation lease, stale base snapshot, failed replay, quarantine, or conflicting plan triggers a collision-specific query.
4. **When a relevant Fleet NOTAM appears or is adopted:** Vectant first fetches its pinned brief version, verifies that it is still active and compatible, and then optionally searches for a newer superseding brief. Visibility may trigger read-only retrieval; only local NOTAM adoption can change clearance.
5. **After the first unsuccessful repair attempt:** if the same normalized problem remains after a mutation and verification attempt, Vectant queries or broadens the prior query before the agent spends another full reasoning cycle.
6. **Before expensive escalation:** before moving from a small/local model to a frontier model, expanding the context window materially, or launching a costly multi-agent investigation, Vectant checks for a proven brief.
7. **On explicit agent or developer request:** agents can search by problem description, diagnostic, tool, framework, brief ID, or NOTAM ID at any time.

Vectant suppresses redundant queries when the problem fingerprint, environment fingerprint, repository snapshot, and solution-index version have not changed. Negative results receive a short TTL; proven exact matches may be cached for the episode. A new diagnostic, changed dependency state, failed recommended solution, or index revocation invalidates the cache.

### 15.5 How an agent finds the right brief

Search is a staged pipeline:

```text
current task/error/collision
    -> typed problem fingerprint
    -> exact diagnostic and taxonomy lookup
    -> hard compatibility and policy filters
    -> lexical BM25 retrieval
    -> optional provider-replaceable semantic retrieval
    -> environment and applicability reranking
    -> reliability/freshness/safety reranking
    -> selective decision threshold
       -> recommend top 1-3 compact briefs
       -> or abstain with reason codes
```

The stages are:

1. **Fingerprint extraction:** derive controlled problem class, stable error codes, symptom tokens, language/framework, runtime range, repository shape, failed operation, available capabilities, and local policy constraints.
2. **Exact lookup:** stable compiler codes, public exception classes, package-manager codes, and CodeSite collision types produce the highest-precision matches.
3. **Hard filtering:** exclude revoked, expired, incompatible, permission-requiring, unavailable-tool, wrong-runtime, or locally disallowed solutions.
4. **Lexical retrieval:** BM25 matches normalized titles, symptoms, problem classes, and solution taxonomies. This works without an embedding model.
5. **Semantic retrieval:** an optional interchangeable embedding adapter finds paraphrased or novel descriptions. Embeddings can be rebuilt without changing the canonical brief.
6. **Structural expansion:** related brief clusters connect causes, variants, superseding versions, prerequisite fixes, and known failed approaches.
7. **Empirical reranking:** rank by environment fit, conservative reliability, independent evidence, freshness, safety, and expected reasoning/cost reduction.
8. **Diversification:** return at most a few materially different answers rather than many near-duplicates.
9. **Selective decision:** recommend only if the best compatible policy clears applicability, verifier-strength, safety, evidence, and benefit thresholds; otherwise abstain.

On `recommend`, the agent receives the best brief, why it matched, evidence tier, verifier-strength summary, applicability predicates, bounded strategy, stop conditions, and required verification. On `abstain`, it receives no strategy—only the reasons and safe next action. It never receives source traces or tenant identities.

### 15.6 How the agent uses a brief

Consumption is an enforced platform pipeline, not a prompt suggestion:

```text
network SolutionVersion
    -> trust and lifecycle filter
    -> local applicability evaluator
    -> local policy authorization
    -> bounded strategy adapter
    -> execution sandbox or mutation lease
    -> local verification predicate
    -> Outcome
```

Within that pipeline, the agent follows this loop:

1. If retrieval returns `abstain`, record the reason, perform the bounded next action, and do not expose or execute a rejected policy.
2. If retrieval returns `recommend`, confirm the policy's applicability predicates against the current workspace with read-only tools.
3. Reject the policy and convert the decision to `abstain` if required predicates are false or remain unknown; record `not_applicable` or `applicability_unknown` rather than attempting it.
4. Translate only allowlisted bounded strategy actions into locally available tools. The public artifact cannot invoke a tool directly.
5. Request any normal CodeSite permission, lease, or approval required by the receiving project.
6. Apply the smallest compatible change.
7. Evaluate the policy's verification predicate plus local project gates and retain the full verifier-strength vector.
8. Report `success`, `failure`, `not_applicable`, `applicability_unknown`, `partially_helpful`, `regression`, or `inconclusive` with objective Evidence.
9. Continue independent reasoning or escalate when Vectant abstains or when a recommended policy fails.

The brief looks like a historically proven accepted answer, while the decision policy and enforced execution environment supply the applicability, authorization, and verification semantics that a Q&A answer lacks.

## 16. Outcome feedback and compounding quality

Every eligible recommendation decision creates an attribution record, including cases where nothing is shown. At minimum it records:

- the eligibility decision and matching fingerprint;
- assigned evaluation cohort or counterfactual strategy;
- whether a recommendation was available and shown;
- whether it was selected;
- which major strategy branches were followed;
- the verification Outcome;
- task/environment difficulty features used for baseline matching.
- whether an abstention was later shown to be correct, unnecessarily conservative, or protective against false application.

After the consuming episode ends, Vectant determines:

- whether the solution was viewed, selected, or ignored;
- whether the agent followed its major semantic actions;
- whether the task recorded success and what verifier strength supported that claim;
- whether the solution saved attempts, input tokens, latency, or model escalation;
- whether it caused a failed attempt, regression, revert, or policy violation;
- whether the environment was actually compatible.

The Outcome updates empirical evidence. It does not rewrite the immutable SolutionVersion. “Recommendation shown, then task succeeded” is observational correlation and cannot alone justify promotion or an economic claim.

### 16.1 Causal and incremental attribution

For safe eligible workloads, assign randomized or interleaved cohorts before retrieval: no recommendation, lexical-only retrieval, current ranked policy, or an approved alternative ranker. Preserve intent-to-treat assignment even when an agent ignores the recommendation. Segment results by task difficulty and compatibility.

Do not withhold safety-critical guidance, adopted Fleet NOTAM controls, or known severe regression warnings for experimentation. Use shadow replay, synthetic/public fixtures, stepped rollouts, matched historical controls, or conservative causal estimators for those cases. Every reported savings or success-lift metric must name its baseline, cohort definition, uncertainty interval, and safety comparison.

### 16.2 Reliability and independence state

Maintain separate dimensions:

- `applicability`: how often the preconditions match correctly;
- `executionSuccess`: success after applicable use;
- `verifierStrength`: semantic reach, coverage, independence, freshness, and regression-window quality of supporting signals;
- `safety`: absence of policy violations, regressions, and destructive outcomes;
- `efficiency`: token, latency, attempt, and escalation savings attached to evidence-qualified Outcomes;
- `freshness`: compatibility with current dependency and tool versions;
- `incrementalBenefit`: measured lift over a compatible baseline rather than success-after-recommendation;
- `independence`: effective evidence diversity after correlation adjustment;
- `selectivity`: recommendation coverage, abstention rate, false-application rate, and missed-opportunity rate at the configured threshold.

Independence is modeled across private dimensions:

- tenant diversity;
- repository lineage and topology diversity;
- runtime and toolchain diversity;
- model-family diversity;
- fixture-family diversity;
- dependency/version diversity;
- temporal diversity.

Use a hierarchical model or conservative effective-sample-size estimator. Repeated outcomes from one organization, fork family, automation loop, or short time window must receive diminishing weight even when they span many nominal workspaces.

A solution may be reliable but inefficient, efficient but narrow, or broadly applicable but stale. A single opaque confidence number is insufficient for governance, though the UI may present a summarized tier.

### 16.3 Lifecycle automation

- Repeated effective-independent success with sufficient verifier strength can promote ranking within the current scope.
- Dependency or tool drift reduces freshness until reevaluated.
- A confirmed regression immediately quarantines the affected version from automatic recommendation.
- Multiple failures under valid preconditions trigger review or revocation.
- Superseding versions inherit no reliability automatically; they earn evidence separately.
- Revoked solutions remain in lineage so Vectant does not rediscover and republish the same unsafe pattern.

## 17. MCP and agent surface

Add provider-neutral MCP tools and register every tool in both `CODESITE_TOOL_NAMES` and `ADVERTISED_TOOLS`:

| Tool | Purpose |
|---|---|
| `synthi_codesite_begin_execution_episode` | Declare task, criteria, base snapshot, and idempotency key. |
| `synthi_codesite_record_execution_step` | Record typed semantic step or collision without raw transcript. |
| `synthi_codesite_complete_execution_episode` | Close an episode and request verification. |
| `synthi_codesite_get_execution_episode_status` | Read verification/capsule eligibility state. |
| `synthi_codesite_list_solution_recommendations` | Return compatible non-executable policies or explicit `abstain` with reason codes and no rejected strategy content. |
| `synthi_codesite_search_problem_briefs` | Search the public anonymous repository by task, diagnostic, collision, or structured fingerprint. |
| `synthi_codesite_get_problem_brief` | Fetch one compact human- and machine-readable brief version. |
| `synthi_codesite_evaluate_solution_applicability` | Deterministically evaluate a version's predicates using allowlisted local observations; performs no mutation. |
| `synthi_codesite_select_solution_recommendation` | Record selection without claiming applicability, authorization, or success. |
| `synthi_codesite_report_solution_outcome` | Attach objective verifier signals, strength vector, applicability, abstention result, safety, cohort, and cost Evidence. |
| `synthi_codesite_preview_trace_capsule` | Show exactly what would leave the workspace. |
| `synthi_codesite_approve_trace_capsule` | Optional operator approval for controlled rollout. |
| `synthi_codesite_quarantine_solution` | Remove a version from recommendation immediately. |
| `synthi_codesite_revoke_solution` | Permanently revoke while retaining lineage. |

Existing tools remain relevant:

- `synthi_codesite_publish_shared_skill` for explicit skill creation;
- `synthi_codesite_list_learning_catalog` for consumption;
- `synthi_codesite_adopt_learning_catalog_entry` for audited adoption;
- `synthi_codesite_update_control_plan` for workspace/network intake policy.

The existing Fleet NOTAM MCP tools also remain first-class and must stay in the same canonical registries:

- `synthi_codesite_list_fleet_notams` for pushed advisory discovery, including optional linked `briefId`, pinned solution version, evidence tier, compatibility summary, and lifecycle state;
- `synthi_codesite_publish_fleet_notam` for publishing only from an eligible promoted policy delta;
- `synthi_codesite_decide_fleet_notam` for local adopt, mute, dismiss, and reactivate decisions;
- `synthi_codesite_withdraw_fleet_notam` and `synthi_codesite_supersede_fleet_notam` for advisory lifecycle control.

The problem-brief tools may accept a NOTAM ID as a lookup seed, but they must not absorb NOTAM decisions. This separation keeps search/recommendation model-agnostic and preserves the existing local clearance boundary.

The agent capability artifact in `synthi/src/lib/codesite/artifacts.js` must advertise the same surface so UI agents and MCP agents cannot drift.

### 17.1 Mandatory tool-catalogue publication contract

Every execution-learning tool must be published through the canonical Vectant tool catalogue. Adding a name only to an MCP handler or only to an agent manifest is incomplete. A tool is considered released only when all of the following surfaces agree:

| Surface | Required plan action |
|---|---|
| CodeSite definition | Add the exact name and input schema to `CODESITE_TOOL_NAMES` and `CODESITE_TOOLS` in `mcp/synthi-mcp/src/tools/codesite.ts`. |
| Callable dispatch | Implement its dispatch branch and authenticated CodeSite route before advertising it. Planned or stub-only tools must not appear in the production catalogue. |
| Canonical MCP registry | Add the exact name to `ADVERTISED_TOOLS` in `mcp/synthi-mcp/src/tool_registry.ts`. This is the source of truth for MCP publication. |
| Tool metadata catalogue | Confirm that `mcp/synthi-mcp/src/tool_metadata_catalog.ts` publishes it through `TOOL_METADATA_CATALOG` / `VECTANT_TOOL_CATALOG` with useful `codesite`, `execution-learning`, `decision-policy`, `evidence`, `recommendation`, or `fleet-notam` routing facets as applicable. |
| Agent capability catalogue | Add the same exact name to `CODESITE_MCP_TOOLS` in `synthi/src/lib/codesite/artifacts.js` so generated manifests expose the callable capability to agents. |
| UI/API discoverability | Where an operator or agent must discover the capability, expose its availability and policy state through the CodeSite API and UI without duplicating the schema source of truth. |
| Verification | Add tests proving schema registration, dispatch routing, canonical advertisement, metadata-catalogue lookup, agent-manifest inclusion, and redaction behavior. |

Publication must be atomic at release time: schema + handler + authorization + canonical registry + metadata catalogue + agent manifest + tests. CI must reject both **ghost tools** (advertised but not callable) and **hidden tools** (callable but absent from the catalogue). Catalogue publication grants discoverability only; it does not grant permission. Session routing and the receiving project's authorization policy still determine whether an agent receives or can call a tool.

The decision-policy tools listed above should use stable catalogue metadata so routers can select the smallest relevant subset instead of exposing the full tool catalogue. Episode/Evidence capture, policy retrieval, applicability evaluation, outcome reporting, lifecycle administration, and Fleet NOTAM governance must remain separately routable capability groups.

## 18. CodeSite API surface

Recommended routes under `/api/workspace/[slug]/codesite`:

```text
POST /projects/:projectId/execution-episodes
POST /agent-sessions/:sessionId/execution-episodes/:episodeId/steps
POST /agent-sessions/:sessionId/execution-episodes/:episodeId/complete
GET  /projects/:projectId/execution-episodes/:episodeId

GET  /projects/:projectId/execution-episodes/:episodeId/capsule-preview
POST /projects/:projectId/execution-episodes/:episodeId/capsule-approval

GET  /agent-sessions/:sessionId/solution-recommendations
GET  /projects/:projectId/solution-recommendations
GET  /agent-sessions/:sessionId/problem-briefs/search
GET  /projects/:projectId/problem-briefs/search
GET  /projects/:projectId/problem-briefs/:briefId
POST /agent-sessions/:sessionId/solution-recommendations/:versionId/applicability
POST /agent-sessions/:sessionId/solution-recommendations/:versionId/select
POST /agent-sessions/:sessionId/solution-recommendations/:versionId/outcome

POST /projects/:projectId/solutions/:versionId/quarantine
POST /projects/:projectId/solutions/:versionId/revoke
```

Agent routes derive the project, user, permissions, and redaction policy from the bound CodeSite session. They must never accept caller-supplied workspace identity as authority.

## 19. UI implementation

Extend the CodeSite Learning area with six operator views:

### 19.1 Recommendations

- eligible decision policies for the selected project;
- scope, compatibility, evidence tier, freshness, and safety status;
- applicability predicates and their local pass/fail/unknown state;
- incremental token/latency savings shown as baseline-qualified measured ranges;
- bounded strategy, stop conditions, and verification required after use;
- adopt/select/dismiss actions.
- a first-class abstention state with reason codes, missing applicability observations, threshold class, and safe next action;
- verifier-strength composition and unverified claims rather than a binary “verified” badge.

### 19.2 Contributions

- completed local Episodes and the Evidence they produced;
- whether Evidence strengthened a policy, updated a Candidate, or was withheld;
- exact capsule preview;
- fields removed by anonymization;
- local-only, workspace, or network destination;
- approval, reject, and retention controls.

### 19.3 Evaluations

- fixture, shadow, negative, confounder, incremental-benefit, verifier-strength, abstention-calibration, and model-conformance Outcomes;
- failure clusters and incompatible environments;
- promotion readiness and blockers.

### 19.4 Lifecycle

- solution versions and lineage;
- promotion, deprecation, quarantine, revocation, and supersession;
- delayed regressions and outcome history;
- emergency kill switch.

### 19.5 Public brief explorer

- Stack Overflow-style problem titles and concise accepted-resolution summaries;
- filters for diagnostic, language, framework, runtime, collision type, tool capability, evidence tier, and freshness;
- human-readable and machine-readable views of the same brief;
- “why this matched” explanations for the selected project;
- qualified-versus-proven labels that cannot be confused; private candidates never appear in the public explorer;
- known incompatibilities, failed approaches, superseding versions, and revocation warnings;
- no contributor profiles, company names, repository links, or public source traces.

### 19.6 Fleet NOTAM integration

- Keep the existing Fleet advisories view and its adopt, mute, dismiss, reactivate, withdraw, and supersede lifecycle.
- Show “Open supporting solution brief” when an advisory pins a public brief version.
- Show the brief's evidence tier, compatibility, revocation state, and last validation without exposing contributor identity.
- Show “Active fleet advisory” on a brief when a current NOTAM references that version.
- Keep the controls visually and semantically separate: **Use solution** selects guidance; **Adopt advisory** changes only the receiving project's local policy state.
- Warn when a NOTAM pins a stale, deprecated, quarantined, revoked, or superseded solution, and prevent revoked guidance from being applied.
- Show universal NOTAMs through their anonymous public envelope. Publishing-workspace operators may inspect private provenance in a separately authorized view; receiving workspaces never see another tenant's NOTAM source, policy delta, or origin project.

The default UX should state that network sharing is opt-in and anonymous, show exactly what is shared, and distinguish adoption, observed outcome, verifier strength, and policy sufficiency.

## 20. File-level implementation map

### 20.1 Persistence

- Extend `synthi/prisma/schema.prisma` around the six aggregate roots: Episode, Evidence, Candidate, SolutionVersion, Recommendation, and Outcome. Add append-only step and lifecycle child tables only where relational integrity or query scale requires them.
- Add additive migrations; do not overload existing knowledge JSON fields.

### 20.2 CodeSite domain modules

Create a focused package under `synthi/src/lib/codesite/executionLearning/`:

```text
contracts.js             provider-neutral schemas and enums
episodeStore.js          append-only episode persistence
episodePolicy.js         permissions, idempotency, and retention
outcomeVerifier.js       evidence-based completion
evidenceStore.js         typed verifier signals, strength, digests, projection
problemFingerprint.js    normalized matching signature
capsuleBuilder.js        structural allowlist projection
anonymizer.js            DLP, literal suppression, path roles
privacyPolicy.js         quasi-identifier and scope decisions
candidateStore.js        private policy hypothesis and lifecycle
distillationAdapter.js   model-provider-neutral interface
decisionPolicy.js        applicability, bounded strategy, stops, verification
solutionPolicy.js        promotion and lifecycle state machine
evaluationRunner.js      counterfactual and fixture orchestration
solutionRepository.js    immutable version storage
recommendationEngine.js  filtering, ranking, thresholds, and abstention
applicabilityEvaluator.js deterministic local predicate evaluation
outcomeAttribution.js    baseline, causal lift, and savings calculation
reliability.js           empirical score dimensions and decay
```

Keep `learningNetwork.js` as the safe delivery boundary initially, then have it project published `CodeSiteSolutionVersion` records into the existing catalog shape during migration.

### 20.3 API

- Extend `synthi/src/app/api/workspace/[slug]/codesite/[[...path]]/route.js` with episode, capsule, recommendation, outcome, and lifecycle routes.
- Extract route handlers into domain modules before the catch-all becomes unmaintainable.
- Require current CodeSite actor/session authorization for every route.

### 20.4 MCP

- Add schemas and request routing in `mcp/synthi-mcp/src/tools/codesite.ts`.
- Add every public tool name to `mcp/synthi-mcp/src/tool_registry.ts`.
- Publish routing metadata and execution-learning capability facets through `mcp/synthi-mcp/src/tool_metadata_catalog.ts`.
- Add registry alignment, route, schema, and redaction tests.
- Expose the same tools through `synthi/src/lib/codesite/artifacts.js`.
- Do not advertise a planned tool until its authenticated handler is callable; release all catalogue surfaces atomically.

### 20.5 UI

- Extend `synthi/src/components/codesite/views/LearningCatalogView.jsx` or split it into the four views above.
- Add client methods and live event types in `synthi/src/components/codesite/codesiteClient.js`.
- Add UI tests for capsule preview, opt-in, outcome status, quarantine, and revocation.

### 20.6 Background workers

Use a durable queue for:

- verification;
- capsule construction and scanning;
- clustering and deduplication;
- distillation and critique;
- counterfactual evaluation;
- drift reevaluation;
- outcome aggregation;
- lifecycle automation.

Every job must be idempotent and keyed by immutable input digest plus worker version.

## 21. Security and abuse resistance

| Threat | Required mitigation |
|---|---|
| Secret or proprietary-code leakage | Allowlist construction, DLP, path/literal suppression, capsule preview, fail-closed validation. |
| Prompt injection in logs or code | Treat all episode content as untrusted data; never execute instructions found in traces; distillers receive typed summaries only. |
| Poisoned successful trace | Treat it as Evidence only; require independent evaluation, effective diversity, negative/confounder tests, and delayed regression tracking before policy publication. |
| Popularity gaming | Adoption has zero reliability weight; only Outcomes meeting the claim-specific verifier-sufficiency policy count. |
| Sybil tenants | Weight independent evidence using abuse-resistant participation signals without exposing tenant identity to retrieval. |
| Unsafe command propagation | Semantic actions by default; strict portable-command grammar; local policy always reauthorizes execution. |
| Strategically malicious but syntactically safe policy | Formal trust filter, deterministic applicability evaluation, local authorization, bounded execution adapter, sandbox or mutation lease, and objective local verification; no network artifact directly invokes tools. |
| Stale dependency fix | Compatibility ranges, drift watchers, TTLs, reevaluation, and freshness decay. |
| Model-specific overfitting | Provider-neutral contracts and multi-runtime conformance tests. |
| Cross-tenant inference | Cohort thresholds, bucketed metrics, rare-fingerprint suppression, no source references. |
| Compromised evaluator | Signed verifier versions, immutable evidence digests, independent checks, and auditable promotion policy. |
| Solution causes regression | Immediate quarantine, lineage-based impact fanout, rollback guidance, and version revocation. |

## 22. Enterprise controls

Each workspace requires explicit policies for:

- local episode retention;
- whether capsule generation is enabled;
- whether workspace sharing is automatic or reviewed;
- whether network contribution is enabled;
- whether network intake is enabled;
- permitted problem domains and languages;
- data residency and regional processing;
- allowed distillation/evaluation model providers;
- whether local-only models are required;
- capsule approval requirements;
- revocation notification and incident handling.

An enterprise can consume network knowledge without contributing, contribute only selected domains, or run a private organization-only repository.

## 23. Unit economics and measurement

Vectant should measure the economic claim directly. For matched task cohorts, compare:

- evidence-qualified task success rate, segmented by verifier strength and semantic reach;
- first-pass success rate;
- median and p95 attempts;
- input and output tokens;
- wall-clock latency;
- tool calls and failed tool calls;
- frontier-model escalation rate;
- human review time;
- revert and regression rate;
- infrastructure and inference cost per evidence-qualified task.

Create the evaluation assignment before retrieval and run randomized or interleaved evaluations where safe eligible episodes receive:

- no repository recommendation;
- lexical-only recommendation;
- full ranked solution recommendation.

Retain eligibility, assignment, exposure, selection, strategy-following, and Outcome events so intent-to-treat and treatment-on-treated effects can be distinguished. Use difficulty-stratified confidence intervals and a conservative incremental-benefit lower bound. Safety-critical guidance and adopted NOTAM controls are never withheld; evaluate them through replay, shadow, stepped rollout, or matched controls.

The core business metric should be **cost per evidence-qualified safe outcome**, not cost per token, binary test pass, or number of adopted lessons. Every dashboard using “verified” as shorthand must name the applicable verifier-sufficiency policy.

Marketing claims such as “frontier-level performance from smaller models” require a published internal benchmark definition, confidence intervals, workload segmentation, and safety parity. The product should present measured ranges rather than universal guarantees.

## 24. Rollout plan

### Phase 0 — contracts and evaluation baseline

- Freeze the six core aggregate contracts: Episode, Evidence, Candidate, SolutionVersion, Recommendation, and Outcome.
- Define the decision-policy schema: problem fingerprint, applicability predicate, bounded strategy, stop conditions, verification predicate, compatibility, and safety envelope.
- Define the verifier-signal taxonomy, multidimensional strength contract, sufficiency policies, and problem-class calibration fixtures.
- Define the selective retrieval contract, abstention reason codes, asymmetric false-application loss, and initial risk-coverage thresholds.
- Create provider conformance fixtures for at least three model/runtime integrations.
- Establish no-retrieval baseline tasks, difficulty strata, causal-assignment records, and economics metrics.
- Add privacy threat-model tests before collecting network data.
- Define which safety-critical cohorts may never be randomized or withheld.

**Exit:** schemas are versioned; an episode can be assigned to a baseline or recommendation cohort before retrieval; baseline, safety, and privacy acceptance tests exist.

### Phase 1 — local Episode and Evidence ledger

- Add Episode, Evidence, and Outcome aggregates plus append-only execution steps.
- Instrument MCP and CodeSite events.
- Capture local episodes only.
- Capture `success`, `failure`, `regression`, and `inconclusive` outcomes plus verifier kind, scope, coverage, semantic reach, independence, freshness, unverified claims, and delayed regression without model self-report.
- Support two initial classes: compiler/test repair and CodeSite collision resolution.

**Exit:** equivalent typed Evidence is reconstructed provider-neutrally from at least three agent runtimes, and raw trajectories are never mistaken for policies.

### Phase 2 — workspace decision-policy MVP

- Cluster local Evidence and infer private Candidates.
- Store explicit observed facts, causal hypotheses, applicability predicates, unresolved confounders, bounded strategies, stop conditions, and verification predicates.
- Evaluate Candidates with source counterfactuals, negative tests, confounder perturbations, and approved local fixtures.
- Publish qualifying workspace-only SolutionVersions.
- Retrieve them at bounded decision points and enforce trust filter -> applicability -> authorization -> bounded execution -> verification.
- Return explicit `recommend` or `abstain`; never include rejected policy content in an abstention response.
- Record eligibility, assignment, exposure, selection, strategy-following, Outcome, and compatible baseline cohort.

**Exit:** workspace learning demonstrates statistically credible improvement in cost per evidence-qualified safe outcome without increasing regression rate. If it does not, stop network expansion and improve policy induction, applicability, verifier calibration, or retrieval first.

### Phase 3 — workspace generalization and hardening

- Add model-adapter-neutral distillation and critique.
- Add fixture mutation, cross-project shadow, multi-runtime conformance, and incremental-benefit evaluations.
- Estimate effective independent sample size across tenant, repository lineage, runtime, model, fixture, dependency, and time dimensions.
- Add workspace decay, quarantine, supersession, revocation, and delayed-regression fanout.
- Add proactive orientation, reactive error/collision, retry, and pre-escalation queries.
- Calibrate applicability and verifier-strength thresholds against selective risk-coverage curves, prioritizing low false-application risk over maximum recommendation coverage.

**Exit:** workspace policies demonstrate reproducible applicability and incremental value outside their source episodes, with lifecycle controls proven under regression tests.

### Phase 4 — anonymous projection readiness

- Build the structural allowlist Evidence-capsule projection and SolutionVersion brief projection.
- Add secret, PII, path, literal, provenance, and quasi-identifier defenses.
- Add operator preview, approval, rejection reason, retention, and regional-processing controls.
- Run adversarial exfiltration and cross-tenant inference tests.
- Keep all projections project or workspace scoped during this phase.

**Exit:** adversarial privacy tests pass with zero known prohibited-field escapes, and every projected field has an allowlisted source and documented purpose.

### Phase 5 — opt-in learning network

- Enable anonymous network contribution for approved domains.
- Allow every eligible evidence-qualified solve to contribute anonymous Evidence, but keep novel single-solve Candidates private.
- Publish public briefs only from independently evaluated SolutionVersions that satisfy privacy, reproducibility, verifier-strength, semantic-coverage, safety, and effective-evidence thresholds.
- Require cohort privacy and correlation-adjusted independence thresholds.
- Enable opt-in network intake and cross-workspace retrieval.
- Add the public brief explorer and agent search APIs.
- Add abuse monitoring and emergency kill switches.
- After the brief network is proven safe, add the signed anonymous Fleet NOTAM envelope, global lifecycle stream, compatibility routing, and cross-workspace delivery. NOTAM publication uses a higher evidence threshold than ordinary brief publication.

**Exit:** multi-workspace causal evaluation shows privacy, safety, applicability, and economic targets are met; no public object is backed only by a novel single observation.

### Phase 6 — self-evolving operations

- Automate Evidence clustering, candidate splitting/merging proposals, drift detection, reevaluation, applicability calibration, ranking calibration, and lifecycle proposals.
- Keep policy changes, threshold changes, and high-impact promotions human-governed.
- Continuously evaluate smaller-model plus repository performance against frontier baselines.

**Exit:** the repository compounds automatically while every behavior change remains attributable, testable, and reversible.

## 25. Testing strategy

### 25.1 Contract and provider tests

- The same episode fixture normalizes identically across OpenAI, Anthropic, Gemini, local, and synthetic adapters.
- Unknown provider fields are ignored or rejected without changing canonical semantics.
- Solutions contain no provider-specific prompt assumptions.
- Every provider maps verifier signals to the same canonical kinds, strength dimensions, outcome states, and unverified-claim semantics.

### 25.2 Privacy tests

- Golden tests for credentials, tokens, emails, URLs, hostnames, organization names, proprietary paths, issue IDs, UUIDs, hashes, and source literals.
- Property-based tests that generate nested unknown fields and high-entropy strings.
- Adversarial combinations that create quasi-identifiers.
- Assert that only allowlisted keys can cross the network boundary.
- Cross-tenant isolation tests for every query and lifecycle operation.

### 25.3 Evaluation tests

- Source replay, mutated replay, unrelated negative fixtures, and cross-project shadows.
- Passing only targeted tests or a build records the correct narrow verifier strength and does not imply untested semantic correctness.
- A relevant domain invariant can satisfy a declared semantic claim even when an unrelated large suite provides little additional coverage.
- Repetition of the same weak verifier cannot satisfy a missing semantic-coverage requirement.
- Verify that a successful trajectory with a removed causal prerequisite does not pass applicability or promotion.
- Verify that failed or unknown applicability predicates stop execution before mutation.
- Verify that network policy content cannot invoke a tool without the local bounded-strategy adapter and authorization gate.
- Verify that revoked solutions disappear from new recommendations immediately.
- Verify that a delayed regression propagates to candidate and version state.

### 25.4 Ranking tests

- Adoption alone never changes reliability.
- Correlated repositories, forks, agents, and executions receive diminishing evidence weight even when nominal workspace count is high.
- Tenant, repository-lineage, runtime, model, fixture, dependency, and time diversity increase effective independence only when actually distinct.
- Low-sample perfect rates do not outrank high-sample reliable solutions.
- Stale solutions decay below fresh compatible solutions.
- Local policy and capability mismatches are hard exclusions.
- Retrieval emits `abstain` when applicability is false or unknown, verifier strength is insufficient, policies conflict, or the best score is below threshold.
- Abstention responses contain reason codes and a safe next action but no rejected policy strategy.
- Threshold tests use asymmetric loss and show that false applications cost more than compatible retrieval misses.
- Risk-coverage calibration remains within the configured false-application bound as recommendation coverage changes.

### 25.5 Fleet NOTAM integration tests

- A visible but unadopted NOTAM can trigger read-only brief retrieval but never changes local clearance.
- Adopting a NOTAM changes only the receiving project's local state; selecting its linked brief does not.
- Muting or dismissing a NOTAM does not suppress ordinary problem-brief search for the same fingerprint.
- Withdrawing or expiring a NOTAM removes its local active effect while its valid supporting brief remains searchable.
- Superseding a NOTAM pins an immutable successor brief version and preserves both lifecycle lineages.
- Quarantining or revoking a brief immediately blocks its recommendation and creates a deterministic dependent-NOTAM lifecycle proposal.
- Cross-workspace NOTAM responses contain only the signed allowlisted public envelope and never expose the source workspace, project, policy delta, private rule candidate, routing state, actor, or source evidence.
- MCP, UI, and the agent capability artifact expose the same linked fields and lifecycle semantics.

### 25.6 Economic tests

- Attribution distinguishes eligibility, assignment, exposure, selection, strategy following, Outcome, and verifier strength/sufficiency.
- Recommendation followed by success does not claim causal lift without a compatible baseline or accepted counterfactual method.
- Randomized intent-to-treat analysis preserves assignment when the agent ignores the recommendation.
- Token and latency savings compare compatible, difficulty-stratified task cohorts with uncertainty intervals.
- Safety-critical guidance and adopted NOTAMs are never withheld for experimentation.
- Model escalations and retries are included in total cost.
- Safety regressions prevent an apparently cheaper path from being labeled better.
- Economic analysis reports abstention cost, avoided false-application cost, and missed-opportunity cost rather than treating greater recommendation coverage as inherently better.

### 25.7 Tool-catalogue tests

- Every `CODESITE_TOOL_NAMES` entry has exactly one `CODESITE_TOOLS` schema and is present in `ADVERTISED_TOOLS`.
- Every advertised CodeSite execution-learning tool has a real dispatch branch and authenticated API route.
- `TOOL_METADATA_CATALOG` contains every advertised tool exactly once with non-empty metadata and the expected routing facets.
- Every released execution-learning tool appears in the generated `CODESITE_MCP_TOOLS` agent manifest.
- CI detects ghost tools, hidden tools, duplicate names, schema drift, and MCP/agent-manifest disagreement.
- Catalogue discovery does not bypass session tool selection, workspace policy, permissions, or redaction.

## 26. Observability and SLOs

Track:

- episode ingestion completeness and ordering;
- verification latency and failure reasons;
- verifier-signal mix, semantic-coverage gaps, strength tiers, unverified claims, and delayed-regression windows;
- capsule eligibility, rejection, and privacy-block rates;
- candidate cluster sizes and distillation disagreement;
- evaluation pass/fail by environment and adapter;
- recommendation latency and cache hit rate;
- eligibility, assignment, exposure, selection, strategy-following, Outcome, and verifier-sufficiency attribution coverage;
- applicability precision, false-positive rate, and unknown-predicate rate;
- recommendation coverage, abstention rate by reason, false-application rate, missed-opportunity rate, and selective risk-coverage curve;
- effective independent sample size and correlation concentration;
- incremental-benefit lower bounds by compatible cohort;
- quarantine and revocation propagation latency;
- token, latency, retry, and escalation savings;
- privacy and policy incidents.

Initial SLOs should include:

- p95 recommendation retrieval below 250 ms excluding optional model reranking;
- false-application risk below the configured problem-class bound, with automatic threshold tightening or abstention when calibration drifts;
- revocation exclusion from new recommendations within 60 seconds;
- zero network publication when privacy scanning is unavailable;
- idempotent episode-step ingestion with no acknowledged event loss;
- complete solution and evaluation lineage for every published version.

## 27. Governance boundaries

The system may autonomously:

- capture typed local events under policy;
- run deterministic verification;
- build and scan capsules;
- cluster candidates;
- schedule sandbox evaluations;
- adjust empirical ranking within approved bounds;
- abstain and automatically tighten recommendation thresholds within approved safety bounds when calibration degrades;
- decay stale solutions;
- quarantine on confirmed severe regression.

The system may not autonomously:

- weaken privacy or permission policy;
- enable network contribution or intake for a tenant;
- publish arbitrary commands lacking the required evidence and policy approval;
- execute a network SolutionVersion directly or bypass local applicability, authorization, lease/sandbox, or verification;
- publish a novel public policy or brief from only one successful trajectory;
- reinterpret a revoked solution as safe;
- change promotion thresholds;
- train provider models on enterprise data;
- expose source lineage to network consumers;
- claim success without configured verification evidence.
- represent a passing test/build as universally verified semantic correctness or hide unverified claims from consumers.

## 28. Acceptance criteria for the complete system

The end goal is met when all of the following are true:

1. At least three materially different agent/model runtimes emit the same canonical episode contract.
2. A successful fix or collision resolution is captured with typed verifier signals, strength, semantic reach, and unverified claims without relying on model self-report.
3. A successful execution becomes Evidence; it cannot directly become a public brief or executable recipe.
4. Every published SolutionVersion contains a testable applicability predicate, bounded strategy, stop conditions, verification predicate, compatibility envelope, and safety envelope.
5. The generated network capsule contains no raw source, prompt, transcript, identity, path, secret, or resolvable source reference.
6. A Candidate cannot become network-visible without policy, privacy, reproducibility, applicability, safety, and effective-independent-evidence gates.
7. A compatible agent in another opted-in workspace can retrieve the policy through UI and MCP, but cannot execute it without local applicability evaluation and authorization.
8. The receiving workspace's permissions, sandbox or mutation lease, and verification gates remain authoritative.
9. Outcomes distinguish eligibility, assignment, exposure, selection, strategy following, verifier-strength vector, and result; adoption alone has no reliability weight.
10. Controlled evaluation estimates incremental benefit against compatible baselines and shows lower cost per evidence-qualified safe outcome without increased regressions.
11. Regressions, drift, quarantine, and revocation change recommendations promptly and preserve audit history.
12. Evidence independence is correlation-adjusted rather than equated with workspace or execution count.
13. Every learned behavior is versioned, attributable to anonymous Evidence, testable, and reversible.
14. No canonical binary `verified_success` hides evidence quality; sufficiency is evaluated against the declared claim and problem-class policy.
15. Retrieval explicitly returns `recommend` or `abstain`; abstention exposes reason codes and a safe next action but no rejected strategy.
16. Selective risk-coverage evaluation demonstrates that applicability false positives remain below the configured bound.

## 29. Immediate implementation sequence

The first production slice should be deliberately narrow:

1. Add the six core aggregates: `CodeSiteExecutionEpisode`, `CodeSiteEvidence`, `CodeSitePolicyCandidate`, `CodeSiteSolutionVersion`, `CodeSiteRecommendation`, and `CodeSiteOutcome`, plus append-only Episode steps where needed.
2. Instrument MCP tool calls and CodeSite collision/recovery events into typed Episode steps and objective Evidence.
3. Support two initial problem classes: compiler/test error repair and CodeSite path-collision resolution.
4. Implement canonical Outcome states and the verifier-signal/strength contract, including semantic reach, coverage, independence, unverified claims, and delayed regression.
5. Define the decision-policy schema and prohibit direct tool invocation from stored or network policy content.
6. Define `recommend | abstain`, stable abstention reason codes, asymmetric loss, and conservative initial selective thresholds.
7. For every tool introduced in this slice, publish its schema, callable handler, canonical registry entry, tool-metadata entry, and agent-manifest entry atomically; add ghost/hidden-tool CI checks.
8. Add provider-conformance tests using at least three runtime adapters.
9. Derive private workspace Candidates with explicit observed facts, applicability hypotheses, bounded strategies, stop conditions, verification predicates, and unresolved confounders.
10. Evaluate Candidates through source counterfactuals, negative/confounder tests, fixtures, verifier-sufficiency checks, and existing counterfactual infrastructure.
11. Publish qualifying workspace-only SolutionVersions and build exact-code, taxonomy, and BM25 retrieval; add optional replaceable semantic retrieval afterward.
12. Enforce selective threshold -> applicability -> authorization -> sandbox or mutation lease -> verification; an abstention returns no strategy.
13. Record pre-retrieval cohort assignment plus eligibility, exposure, abstention/recommendation, selection, strategy-following, objective Outcome, verifier strength, and cost.
14. Prove workspace-level incremental benefit, verifier calibration, and selective safety against compatible baselines. Do not begin network publication if this gate fails.
15. Add decay, quarantine, revocation, and dependent Fleet NOTAM lifecycle proposals at workspace scope.
16. Only after the workspace value gate passes, build allowlist-only Evidence capsules and SolutionVersion brief previews with network publication disabled.
17. Enable anonymous network briefs only after privacy, cross-project reproduction, verifier-strength, effective-independence, selective-risk, scoring, quarantine, and revocation gates are complete; never publish a novel single-solve Candidate.
18. Add the universal signed Fleet NOTAM envelope only after the anonymous policy network is proven safe, with a higher verifier and publication threshold than ordinary briefs.

This sequence produces useful local and workspace compounding early while keeping the anonymous network boundary closed until it is demonstrably safe.

## 30. Final design decision

Vectant should treat the execution environment—not any one model—as the durable intelligence layer.

Models propose and consume strategies. Vectant owns the provider-neutral Episode and Evidence contracts, decision-policy schema, verification, anonymization, lifecycle, applicability evaluation, retrieval, execution authorization, causal attribution, and evaluation loop. That separation is what allows new or cheaper models to inherit historically proven execution competence without giving any provider access to raw enterprise history.

The compounding asset is not a pile of anonymized trajectories. It is evidence-qualified execution history plus causal attribution, environment compatibility, safety constraints, applicability calibration, and immutable decision-policy versions. The self-evolving behavior comes from continuously improving that repository and its ranking under fixed safety, privacy, and authorization constraints.
