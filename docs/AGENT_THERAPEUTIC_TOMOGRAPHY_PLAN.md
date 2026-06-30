# Agent Therapeutic Tomography

## Status

Production-readiness implementation is now repo-local executable, with an explicit deployment boundary.

Implemented in the repo:

- tenant-scoped durable runtime snapshots for traces, proof decisions, grants, reviews, remediation proposals, postcondition checks, case law, and policy-learning records
- therapeutic MCP tool production gates for tenant/RBAC context, hosted-runtime authorization, durable stores, protected dispatch, and proof signing
- strict proof capsules with deterministic proof routing, replay/stale/revoked checks, and signing/verification hooks compatible with the existing Dojo proof signer interface
- contract-bound probe catalogs for ML quality drop, workflow debugging, and incident response, plus a pluggable HTTPS probe adapter
- operational UI actions for pending-review approval/denial, grant revocation, runtime refresh, evidence records, audit records, remediation state, and postcondition status
- chaos controls for stale proof, revoked proof, replayed proof, leaky probes, unavailable durable store, failed revocation, failed postcondition, and emergency under-escalation
- release evidence generation for a non-demo incident-response trace that exercises brokered read-only access, scoped grant, protected dispatch, revocation, durable audit reconstruction, signed proof verification, and unauthorized protected-tool bypass denial

Deployment boundary:

- The release evidence is generated from repo-local deterministic execution with non-loopback hosted/probe URLs and a durable file store.
- True production-runtime proof still requires running the same gates against the deployed hosted runtime, configured production tenant/RBAC provider, production durable evidence store, and managed-key/KMS proof signer.
- Narrative-only proof still cannot grant broad access, raw logs, model weights, admin privileges, production writes, or diagnostic mutation. Remediation write access remains gated by diagnosis, rollback, postcondition, human approval, and revocation checks.

This version makes **Proof Capsules stricter** by separating:

```text
machine-verifiable claims
human-reviewed claims
unverifiable narrative claims
```

The system should prefer machine-verifiable claims, allow human-reviewed claims where judgment is necessary, and explicitly mark unverifiable narrative claims as weak evidence.

---

## One-liner

**Agent Therapeutic Tomography** is a proof-gated access planning system that lets AI agents diagnose and solve tasks using the minimum effective authority and the minimum necessary information.

Instead of giving an agent broad access to tools, logs, databases, files, model weights, or production systems, the system forces the agent to move through small, measurable authority doses and privacy-preserving diagnostic probes.

The goal is simple:

> Give the agent enough access to succeed, but never more than the task actually justifies.

---

## Core idea

Normal permission escalation asks:

```text
What access does the agent want next?
```

Therapeutic Tomography asks:

```text
What is the smallest authority or information projection that could change the diagnosis?
```

This difference matters because many agent failures do not require broad access. A model quality drop, for example, might be diagnosed through aggregate evaluation slices, feature drift summaries, or one-feature lineage checks.

The agent should not immediately ask for:

```text
raw production logs
full database access
model weights
admin privileges
write access
```

Therapeutic Tomography treats authority like a medical dose:

```text
Too little authority -> the agent cannot solve the task.
Too much authority -> the agent creates unnecessary risk.
Correct authority -> the agent can progress safely and efficiently.
```

---

## Design goals

1. **Minimize authority**
   - The agent should start with the lowest useful access level.
   - Escalation must be justified by evidence.

2. **Minimize information exposure**
   - Prefer aggregate, redacted, sliced, or summarized data before raw data.
   - Return only the output shape required for the task.

3. **Prevent unsafe mutation**
   - Diagnosis and remediation must be separated.
   - Read access does not automatically justify write access.

4. **Make escalation auditable**
   - Every permission increase must leave behind a strict proof capsule.
   - The system should be able to explain why access was necessary.
   - The system should also distinguish hard proof from narrative reasoning.

5. **Avoid both over-escalation and under-escalation**
   - The agent should not ask for too much access.
   - The agent should also not stay stuck with too little access during serious incidents.

6. **Train better agents over time**
   - Failed traces become case law.
   - Successful minimal-access paths become reusable policy patterns.

---

## Core loop

```text
1. Start with the smallest authority dose.
2. Identify the current uncertainty.
3. Choose the lowest-risk probe that could reduce that uncertainty.
4. Measure progress, confidence, cost, and side effects.
5. If the agent asks for broad access too early, block it.
6. Offer the best lower-risk probe instead.
7. If blocked after probes, justify the smallest authority delta.
8. Request scoped access through an Authority Broker.
9. Verify the result.
10. Store the full trace as evidence.
11. Revoke temporary access when the task ends.
12. Learn from the trace for future tasks.
```

---

## System architecture

```text
User Task
   ↓
Task Planner
   ↓
Uncertainty Model
   ↓
Probe Selector
   ↓
Authority Broker
   ↓
Policy Engine
   ↓
Tool / Data Access
   ↓
Evidence Trace
   ↓
Strict Proof Capsule
   ↓
Diagnosis / Recommendation / Action
```

---

## Main components

### 1. Task Planner

The Task Planner breaks the user request into smaller diagnostic or operational steps.

Example:

```text
Task:
Diagnose why production model quality dropped.

Subtasks:
1. Confirm that quality actually dropped.
2. Identify affected cohorts.
3. Identify likely feature, routing, data, or model causes.
4. Request the smallest extra access needed to verify the cause.
5. Produce diagnosis.
6. Produce remediation plan.
```

The planner should not immediately plan around maximum access. It should plan around uncertainty reduction.

---

### 2. Uncertainty Model

The Uncertainty Model tracks what the agent knows, what it does not know, and what evidence would change the diagnosis.

Example uncertainties:

```text
Is the quality drop real?
Which user segment is affected?
Is the issue caused by data drift?
Is the issue caused by model routing?
Is the issue caused by train/serve skew?
Is the issue caused by evaluation pipeline changes?
Is remediation safe?
```

Each uncertainty should have:

```text
Uncertainty
  id
  description
  current_confidence
  possible_causes
  useful_probes
  blocking_status
  severity
```

---

### 3. Probe Selector

The Probe Selector chooses the lowest-risk diagnostic probe that can reduce uncertainty.

Examples:

```text
eval_slice_compare
feature_drift_summary
lineage_hash_read
redacted_failure_cluster
model_route_compare
embedding_neighborhood_drift
serving_config_diff
training_data_version_check
```

The probe selector should prefer:

```text
aggregate data > redacted samples > scoped raw data > broad raw data
read-only access > write access
one-feature lineage > full lineage
one-service config > whole production config
temporary access > persistent access
```

---

### 4. Authority Broker

The Authority Broker is the enforcement layer.

The agent should never directly grant itself access. All tool and data access should pass through the broker.

```text
Agent
  ↓
Access Request
  ↓
Authority Broker
  ↓
Policy Engine
  ↓
Approved / Denied / Needs Human Approval
```

The broker checks:

```text
requested authority dose
task scope
allowed tools
allowed data classes
forbidden data classes
mutation permission
blast radius
expiration
revocation plan
proof capsule validity
```

This is what turns the idea from a prompting pattern into real infrastructure.

---

### 5. Policy Engine

The Policy Engine defines what the agent is allowed to do.

Policy can come from:

```text
workspace rules
license rules
user preferences
compliance requirements
security requirements
Dojo/Vivarium checkride rules
case law
incident severity
```

Example policy:

```yaml
license:
  max_authority_dose: read_feature_lineage
  forbidden_data_classes:
    - raw_prod_logs
    - model_weights
    - full_customer_database
  allowed_projection_probes:
    - eval_slice_compare
    - feature_drift_summary
    - lineage_hash_read
  mutation_allowed: false
```

---

### 6. Strict Proof Capsule Verifier

The Proof Capsule Verifier checks whether the agent has justified escalation.

A weak proof capsule says:

```text
The agent believes it needs more access.
```

A strict proof capsule says:

```text
The agent attempted lower-risk probes.
The lower-risk probes produced specific evidence.
The evidence narrowed the uncertainty.
The requested access is the smallest remaining useful delta.
The requested access does not include forbidden data.
The access is scoped, temporary, revocable, and verifiable.
```

The verifier should reject escalation when the proof is mostly narrative.

---

### 7. Therapeutic Trace

The Therapeutic Trace stores every authority dose, probe, escalation, result, and outcome.

It is the evidence record for the whole run.

```text
TherapeuticTrace
  task_id
  task_class
  initial_authority_dose
  authority_doses[]
  projection_probes[]
  escalation_justifications[]
  denied_requests[]
  blocked_overreach_attempts[]
  suggested_lower_risk_alternatives[]
  human_overrides[]
  final_outcome
  diagnosis
  remediation_plan
  avoided_access[]
  over_escalation_flags[]
  under_escalation_flags[]
  learned_policy_delta
```

---

## Authority scoring

Each possible next action should be scored.

```text
action_score =
  expected_information_gain
+ expected_task_progress
- privacy_cost
- blast_radius_cost
- mutation_risk
- time_cost
- compliance_cost
```

The system should prefer the action with the best usefulness-to-risk ratio.

A permission increase is only justified when:

```text
expected_information_gain / authority_cost
```

is better than the available lower-risk probes.

---

## Authority cost model

Authority is not one-dimensional. The system should score access using multiple risk dimensions.

```text
authority_cost =
  privacy_cost
+ data_sensitivity_cost
+ blast_radius_cost
+ mutation_risk
+ persistence_cost
+ reversibility_penalty
+ compliance_cost
+ human_trust_cost
```

### Example cost dimensions

| Dimension | Meaning |
|---|---|
| Privacy cost | How much sensitive information may be exposed |
| Data sensitivity | Whether data includes PII, customer data, secrets, model weights, etc. |
| Blast radius | How many systems, users, or services can be affected |
| Mutation risk | Whether the agent can change state |
| Persistence cost | Whether access is temporary or long-lived |
| Reversibility penalty | Whether damage can be rolled back |
| Compliance cost | Legal or regulatory risk |
| Human trust cost | How uncomfortable a human reviewer would be granting it |

---

## Authority ladder

For ML infrastructure tasks, use an authority ladder like this:

```text
Dose 0:
Task description only.

Dose 1:
Read aggregate evaluation reports.

Dose 2:
Run approved aggregate probes.

Dose 3:
Read redacted failure clusters.

Dose 4:
Read feature drift summaries.

Dose 5:
Read lineage for one named feature.

Dose 6:
Read scoped serving or training config.

Dose 7:
Request scoped write access for one remediation action.

Dose 8:
Request broad production access or admin privileges.
```

Rule:

```text
Dose 8 should almost never be reachable during diagnosis.
```

---

## Key objects

### AuthorityDose

```text
AuthorityDose
  id
  task_id
  level
  scope
  permitted_tools
  permitted_data_classes
  forbidden_data_classes
  mutation_allowed
  max_blast_radius
  expiration_condition
  revoke_plan
  expected_effect
  measured_effect
  side_effects
  decision
```

---

### ProjectionProbe

```text
ProjectionProbe
  id
  task_id
  name
  task_class
  target_uncertainty
  required_authority_dose
  required_data_classes
  forbidden_data_classes
  input_schema
  allowed_output_shape
  privacy_cost
  expected_information_gain
  actual_information_gain
  confidence
  result_summary
  failure_modes
  verifier
```

---

### EscalationJustification

```text
EscalationJustification
  id
  task_id
  current_dose
  requested_dose
  blocked_by
  probes_attempted
  probe_results
  remaining_uncertainty
  requested_delta
  why_minimal
  why_lower_doses_are_insufficient
  expected_information_gain
  expected_risk
  human_approval_required
  rollback_or_revoke_plan
```

---

### StrictProofCapsule

```text
StrictProofCapsule
  id
  task_id
  requested_access
  current_authority_dose
  requested_authority_dose
  machine_verifiable_claims[]
  human_reviewed_claims[]
  unverifiable_narrative_claims[]
  evidence_links[]
  verifier_results[]
  failed_claims[]
  risk_score
  minimality_score
  approved
  reviewer
  timestamp
```

---

### TherapeuticTrace

```text
TherapeuticTrace
  task_id
  task_class
  user_goal
  authority_doses[]
  projection_probes[]
  escalation_justifications[]
  proof_capsules[]
  blocked_overreach_attempts[]
  final_outcome
  diagnosis
  remediation_plan
  avoided_access[]
  over_escalation_flags[]
  under_escalation_flags[]
  learned_policy_delta
```

---

# Strict Proof Capsules

Proof capsules are the core trust mechanism.

They should not be a loose explanation written by the agent. They should be structured evidence objects with claims that can be checked.

A proof capsule should separate claims into three categories:

```text
machine-verifiable claims
human-reviewed claims
unverifiable narrative claims
```

The system should prefer proof capsules where most critical claims are machine-verifiable.

---

## Claim types

### 1. Machine-verifiable claims

These are claims the system can check automatically.

Examples:

```text
The agent attempted eval_slice_compare before requesting raw logs.
The eval_slice_compare probe returned affected_segment = enterprise_users.
The feature_drift_summary probe returned top_feature = customer_plan.
The requested access scope is lineage:customer_plan only.
The requested access is read-only.
The request does not include raw_prod_logs.
The request does not include model_weights.
The request does not include write access.
The requested permission has an expiration condition.
The probe output matched the allowed schema.
```

These should be the strongest form of proof.

They can be verified through:

```text
trace logs
probe outputs
access request schema
policy engine result
tool call history
permission diff
data class classifier
output schema validator
```

---

### 2. Human-reviewed claims

These are claims that require judgment.

Examples:

```text
The remaining uncertainty is important enough to justify lineage access.
The feature drift is suspicious enough to investigate customer_plan.
The diagnosis is plausible given the evidence.
The remediation proposal is operationally reasonable.
The incident severity justifies faster escalation.
```

These claims can be reviewed by:

```text
ML engineer
security reviewer
system owner
incident commander
data governance reviewer
```

Human-reviewed claims should be allowed, but they should not replace machine-verifiable evidence.

---

### 3. Unverifiable narrative claims

These are claims that sound reasonable but cannot be directly checked.

Examples:

```text
I need raw logs to understand the issue.
This access will probably help.
The task is blocked.
The broader access is safer because it is faster.
I believe this is the only way.
```

These claims should not be enough to approve escalation.

They may be stored for context, but the proof gate should treat them as weak evidence.

Rule:

```text
Unverifiable narrative claims can explain intent,
but they cannot authorize sensitive access.
```

---

## Strict proof capsule schema

```yaml
proof_capsule:
  id: proof_001
  task_id: quality_drop_001
  requested_access:
    authority_dose: read_feature_lineage
    scope: feature:customer_plan
    mode: read_only
    expiration: end_of_task

  machine_verifiable_claims:
    - claim: eval_slice_compare_attempted
      expected: true
      evidence: trace.probes.eval_slice_compare.status
      verifier: trace_lookup
      result: pass

    - claim: affected_segment_identified
      expected: enterprise_users
      evidence: trace.probes.eval_slice_compare.output.affected_segment
      verifier: equality_check
      result: pass

    - claim: drift_probe_attempted
      expected: true
      evidence: trace.probes.feature_drift_summary.status
      verifier: trace_lookup
      result: pass

    - claim: suspicious_feature_identified
      expected: customer_plan
      evidence: trace.probes.feature_drift_summary.output.top_feature
      verifier: equality_check
      result: pass

    - claim: requested_scope_is_minimal
      expected: feature:customer_plan
      evidence: access_request.scope
      verifier: scope_subset_check
      result: pass

    - claim: request_is_read_only
      expected: true
      evidence: access_request.mode
      verifier: permission_diff_check
      result: pass

    - claim: forbidden_data_not_requested
      expected:
        - raw_prod_logs
        - full_database
        - model_weights
        - admin_privileges
        - write_access
      evidence: access_request.data_classes
      verifier: forbidden_class_check
      result: pass

  human_reviewed_claims:
    - claim: lineage_access_is_reasonable_next_step
      reviewer_role: ml_engineer
      status: approved
      rationale: customer_plan drift is the strongest current lead.

  unverifiable_narrative_claims:
    - claim: Agent believes lineage will confirm train/serve skew.
      status: context_only

  decision:
    approved: true
    reason: Machine-verifiable claims prove that lower-risk probes narrowed the issue to customer_plan and the requested access is read-only, scoped, temporary, and does not include forbidden data.
```

---

## Proof gate approval rules

### Rule 1: Sensitive escalation requires machine-verifiable evidence

For sensitive access, approval should require machine-verifiable claims.

```text
If requested access includes sensitive data:
  require at least one successful lower-risk probe
  require explicit scope
  require forbidden data check
  require read/write mode check
  require expiration
```

---

### Rule 2: Narrative claims cannot authorize sensitive access

```text
If proof capsule only contains unverifiable narrative claims:
  deny escalation
```

Example denied proof:

```text
Agent says:
I need raw logs because the issue is probably hidden there.

System response:
Denied. No lower-risk probes were attempted. Try eval_slice_compare first.
```

---

### Rule 3: Broad access requires proof that scoped access is insufficient

```text
If requested access is broad:
  require evidence that scoped access was attempted or impossible
```

Example:

```text
Request:
raw production logs

Denied because:
eval_slice_compare is available
feature_drift_summary is available
redacted_failure_cluster is available
```

---

### Rule 4: Write access requires a separate remediation proof

```text
Diagnosis proof does not authorize mutation.
```

To get write access, the agent must prove:

```text
diagnosis is verified
proposed change is scoped
blast radius is estimated
rollback plan exists
postcondition check exists
human approval is present
```

---

### Rule 5: Failed claims block escalation

```text
If any critical machine-verifiable claim fails:
  deny escalation
```

Example:

```text
Claim:
requested_scope_is_minimal

Result:
fail

Reason:
agent requested full feature lineage instead of lineage for customer_plan only
```

---

## Probe contract

Every probe must declare exactly what it can access and exactly what it can return.

```text
ProbeContract
  name
  purpose
  required_access
  input_schema
  allowed_output_shape
  forbidden_outputs
  privacy_cost
  expected_information_gain
  sensitivity_level
  failure_modes
  verifier
  cache_policy
```

Example:

```text
FeatureDriftSummaryProbe
  purpose:
    Identify whether aggregate feature distributions changed.

  required_access:
    aggregate_feature_statistics

  forbidden_outputs:
    raw_user_logs
    raw_training_rows
    full_feature_table
    customer_identifiers

  allowed_output_shape:
    feature_name
    drift_score
    affected_segment
    confidence
    time_window

  privacy_cost:
    low

  expected_information_gain:
    high for model quality drop diagnosis
```

The allowed output shape is critical. It prevents probes from becoming hidden raw-data leaks.

---

## Diagnostic phase vs remediation phase

Diagnosis and remediation require different authority.

```text
Diagnostic phase:
  observe
  probe
  compare
  explain
  verify diagnosis

Remediation phase:
  propose fix
  estimate blast radius
  request scoped write authority
  apply change
  verify postcondition
  revoke authority
```

A successful diagnosis does not automatically justify write access.

Example:

```text
Read-only lineage proves train/serve skew.
But fixing the serving pipeline requires a separate remediation proof.
```

Suggested remediation gate:

```text
DiagnosisProofGate
  ↓
RemediationProposalGate
  ↓
WriteAuthorityGate
  ↓
RollbackGate
  ↓
PostconditionVerificationGate
```

---

## Handling under-escalation

The system must avoid becoming too cautious.

Under-escalation happens when the agent refuses to request necessary access even though the task cannot be solved safely without it.

Example:

```text
The production model is failing for enterprise customers.
The agent keeps running weak aggregate probes.
The issue remains unresolved for too long.
```

Add a severity override:

```text
If task_severity is high:
  production outage
  security incident
  legal/compliance issue
  active data corruption
  major customer impact

Then:
  allow faster escalation
  require human approval
  increase audit strictness
  require post-hoc minimality review
```

This keeps the system safe without making it useless.

---

## Threat model

Therapeutic Tomography should defend against:

```text
prompt injection asking for broader access
agent fabricating blocked status
agent skipping lower-risk probes
probe output leaking sensitive data
tool descriptions exposing hidden data
case law poisoning
overfitting to checkrides
human approving excessive access
temporary permissions not being revoked
agent using diagnostic access for remediation
agent using data outside the allowed output shape
```

Mitigations:

```text
all access goes through Authority Broker
all probe outputs are schema-limited
all escalations require strict proof capsules
all temporary access has expiration
all broad access requires human approval
case law has confidence and expiration
checkrides include adversarial scenarios
diagnosis and remediation are gated separately
```

---

## Vivarium Cortex integration

### Checkrides

Add checkrides where agents must solve tasks with partial access.

Score both:

```text
over-escalation
under-escalation
```

Failure examples:

```text
over_escalated_before_probe
requested_raw_logs_when_slice_eval_sufficient
requested_write_access_for_read_only_diagnosis
stopped_without_minimal_probe
ignored_available_low_cost_probe
continued_low_dose_probing_during_severe_incident
failed_to_revoke_temporary_access
used_probe_output_outside_allowed_shape
proof_capsule_contains_only_narrative_claims
proof_capsule_missing_machine_verifiable_minimality
```

---

### Licenses

Licenses define the maximum authority dose and allowed probe classes.

Example:

```yaml
license:
  max_authority_dose: read_feature_lineage
  forbidden_data_classes:
    - raw_prod_logs
    - model_weights
    - full_customer_database
  allowed_projection_probes:
    - eval_slice_compare
    - feature_drift_summary
    - lineage_hash_read
  mutation_allowed: false
```

---

### Proof Capsules

Proof capsules verify that escalation was justified by previous probes and that the requested access was minimal.

Required machine-verifiable claims:

```text
initial_low_dose_attempted
probe_before_escalation
specific_uncertainty_identified
lower_risk_probe_output_recorded
requested_delta_minimal
requested_scope_is_subset_of_evidence
forbidden_data_not_requested
request_is_read_only_for_diagnosis
expiration_defined
revocation_defined
```

Required human-reviewed claims:

```text
remaining_uncertainty_is_worth_resolving
requested_probe_is_reasonable_next_step
diagnosis_is_plausible_given_evidence
```

Unverifiable narrative claims:

```text
may be stored
may explain intent
must not approve sensitive escalation alone
```

---

### Case Law

Case law records past access decisions and failure patterns.

```text
CaseLawEntry
  task_class
  context
  bad_behavior
  preferred_behavior
  authority_boundary
  probe_sequence
  outcome
  confidence
  expiration_date
```

Examples:

```text
If eval slice comparison identifies the affected cohort,
do not request raw logs first.

If drift summary names one feature,
request lineage for that feature only.

If read-only lineage proves train/serve skew,
write access requires a separate remediation proof.
```

Case law should expire because infrastructure and organizational policies change over time.

---

### Wind Tunnel

The Wind Tunnel mutates access conditions and observability surfaces.

Scenarios:

```text
slice report available, drift summary missing
drift summary noisy, lineage accurate
lineage access denied, redacted failure samples available
probe returns ambiguous result
admin access temptingly available but unnecessary
human reviewer approves excessive access
probe output is adversarially misleading
agent proof capsule contains only narrative claims
agent requests broad access after narrow evidence
```

The goal is to test whether the agent chooses efficient diagnostic probes under partial visibility.

---

### Skill Cortex Graph

Therapeutic Tomography can be represented as executable graph nodes:

```text
Observe
  ↓
ModelUncertainty
  ↓
SelectProbe
  ↓
EvaluateEvidence
  ↓
RequestDoseDelta
  ↓
VerifyMinimality
  ↓
ActOrDiagnose
  ↓
RevokeAccess
  ↓
LearnPolicyDelta
```

Node examples:

```text
EvalSliceProbe
FeatureDriftProbe
LineageHashProbe
RedactedFailureSampleProbe
AuthorityDoseGate
EscalationJustificationGate
MinimalityProofGate
ForbiddenDataGate
ClaimTypeClassifier
MachineVerifierGate
HumanReviewGate
NarrativeClaimRejector
RemediationWriteGate
RollbackGate
```

---

## MVP scope

The first MVP should be narrow.

Do not build the entire system first.

Build:

```text
one task class
one authority ladder
three probes
one strict proof gate
one UI trace
no automatic permission changes
```

---

## MVP task

```text
Diagnose a production model quality drop with restricted access.
```

---

## MVP authority ladder

```text
Dose 0:
Task description only.

Dose 1:
Read aggregate evaluation report.

Dose 2:
Run eval slice comparison.

Dose 3:
Run aggregate feature drift summary.

Dose 4:
Request read-only lineage for one suspicious feature.

Dose 5:
Produce diagnosis and remediation proposal.

Dose 6:
Request scoped write access only after human approval and separate remediation proof.
```

---

## MVP probes

```text
eval_slice_compare
feature_drift_summary
lineage_hash_read
```

---

## MVP proof gates

```text
ProbeBeforeEscalationGate
MinimalDeltaGate
ForbiddenDataGate
TraceCompletenessGate
MachineVerifiableClaimGate
NarrativeClaimRejectorGate
RevocationGate
```

---

## MVP UI

The UI should show:

```text
current authority dose
current uncertainty
agent requested access
system decision
why the request was blocked or approved
available lower-risk probes
selected probe
probe result
proof capsule claim types
machine-verifiable claims
human-reviewed claims
unverifiable narrative claims
data avoided
final diagnosis
revocation status
```

The UI should visibly show avoided access:

```text
raw production logs
full database access
model weights
admin privileges
write access
```

This makes the value obvious.

---

# Best 60-second product demo

This is the clearest demo because it shows the system blocking overreach before proving the better path.

## Demo task

```text
Diagnose why a production AI model dropped 9% in quality.
```

## Demo script

```text
1. Agent asks for raw production logs.

2. System blocks the request.

   Reason:
   Raw logs are broad, sensitive, and not justified.
   Lower-risk probes are available.

3. System offers eval slice comparison instead.

4. Agent runs eval_slice_compare.

5. Slice shows enterprise users are affected.

6. System offers feature_drift_summary.

7. Drift probe identifies customer_plan as the most suspicious feature.

8. Agent requests lineage for customer_plan only.

9. Strict Proof Gate checks:
   - eval slice comparison was attempted
   - affected segment was identified
   - drift probe was attempted
   - customer_plan was identified
   - requested scope is only customer_plan
   - request is read-only
   - raw logs are not requested
   - DB access is not requested
   - model weights are not requested
   - admin access is not requested
   - write access is not requested

10. Proof Gate approves.

11. Agent reads scoped lineage for customer_plan.

12. Diagnosis:
    train/serve skew in customer_plan transformation.

13. System shows avoided access:
    - raw production logs
    - full database access
    - model weights
    - admin privileges
    - write access
```

## Why this demo sells the idea

The demo works because the value is visible in the first 10 seconds.

The agent tries to overreach.

The system says no.

The system does not just block the agent. It offers a safer diagnostic path.

The safer path works.

The final UI proves that the system solved the task while avoiding dangerous access.

That is the full product story.

---

## Example strict demo trace

```yaml
task_id: quality_drop_demo_001
task_class: ml_quality_drop

blocked_overreach_attempt:
  requested_access:
    data_classes:
      - raw_prod_logs
    mode: read_only
    scope: production
  decision: denied
  reason:
    - broad_sensitive_data
    - no_probe_attempted
    - lower_risk_probe_available
  suggested_alternative:
    - eval_slice_compare

probe_sequence:
  - name: eval_slice_compare
    status: completed
    output:
      affected_segment: enterprise_users
      confidence: 0.84
    allowed_output_shape_valid: true

  - name: feature_drift_summary
    status: completed
    output:
      top_feature: customer_plan
      drift_score: 0.91
      affected_segment: enterprise_users
      confidence: 0.88
    allowed_output_shape_valid: true

approved_escalation:
  requested_access:
    authority_dose: read_feature_lineage
    scope: feature:customer_plan
    mode: read_only
    expiration: end_of_task
  decision: approved
  proof_capsule: proof_001

proof_capsule:
  machine_verifiable_claims:
    - eval_slice_compare_attempted: pass
    - affected_segment_identified: pass
    - feature_drift_summary_attempted: pass
    - suspicious_feature_identified: pass
    - requested_scope_is_customer_plan_only: pass
    - request_is_read_only: pass
    - forbidden_data_not_requested: pass
    - expiration_defined: pass

  human_reviewed_claims:
    - lineage_is_reasonable_next_step: approved

  unverifiable_narrative_claims:
    - agent_believes_lineage_will_confirm_skew: context_only

diagnosis:
  result: train_serve_skew
  feature: customer_plan
  evidence:
    - eval_slice_compare
    - feature_drift_summary
    - customer_plan_lineage

avoided_access:
  - raw_prod_logs
  - full_database
  - model_weights
  - admin_privileges
  - write_access
```

---

# Latency and Proof Bottleneck Architecture

The biggest product risk is that proof-gated access becomes too slow and expensive.

If the agent has to negotiate every tiny step through a secondary LLM judge, the system will have bad latency, high token cost, and poor developer experience.

The solution is not to remove proof.

The solution is to make proof **tiered, cached, and mostly deterministic**.

---

## Core rule

```text
Do not use an LLM judge for every permission request.
```

Most proof checks should be handled by:

```text
static policy checks
schema validation
permission diff checks
trace lookups
scope subset checks
data class classifiers
precomputed probe contracts
cached case law
risk-tier routing
```

An LLM or human reviewer should only be used when the request contains genuine ambiguity, high risk, or a new policy situation.

---

## Proof evaluation tiers

### Tier 0: No proof required

Used for very low-risk actions.

Examples:

```text
read public task description
read already-approved aggregate metric
run local deterministic calculation
inspect prior trace summary
```

Decision mechanism:

```text
allow automatically
log lightly
```

---

### Tier 1: Deterministic proof

Used for common low-to-medium risk diagnostic probes.

Examples:

```text
eval_slice_compare
feature_drift_summary
lineage_hash_read for one feature
schema-limited config diff
```

Decision mechanism:

```text
policy engine
schema validator
trace lookup
permission diff checker
forbidden data checker
```

No LLM judge should be used here.

Example checks:

```text
Was a lower-risk probe attempted?
Did the probe output match its allowed schema?
Is the requested scope a subset of the suspicious feature?
Is the request read-only?
Are forbidden data classes absent?
Is expiration defined?
```

This should be fast enough to run inline.

---

### Tier 2: Human-reviewed or LLM-assisted proof

Used when the request requires judgment but is not extremely dangerous.

Examples:

```text
requesting lineage for several features
requesting redacted failure samples
requesting scoped service config access
deciding whether an incident severity justifies faster escalation
```

Decision mechanism:

```text
deterministic checks first
then small LLM or human review only for judgment claims
```

Important:

```text
The LLM should not re-evaluate everything.
It should only review the unresolved human-judgment claims.
```

---

### Tier 3: High-risk approval

Used for sensitive or mutating access.

Examples:

```text
raw production logs
customer database access
model weights
write access
admin privileges
production remediation
```

Decision mechanism:

```text
deterministic checks
strict proof capsule
human approval
security/compliance policy
rollback plan
postcondition verification
```

LLM review may summarize the proof, but it should not be the final authority.

---

## Fast proof path

Most permission decisions should follow this path:

```text
Access Request
  ↓
Risk Classifier
  ↓
Tier 0 / Tier 1 / Tier 2 / Tier 3
  ↓
Deterministic Verifier
  ↓
Approve / Deny / Escalate to Human or LLM Review
```

The system should only escalate review when deterministic checks cannot decide.

---

## Deterministic proof checks

The proof verifier should be built like a compiler, not like a debate judge.

### Example deterministic gates

```text
TraceLookupGate
  Checks whether required previous probes actually ran.

ProbeOutputSchemaGate
  Checks whether probe outputs match allowed output shapes.

ScopeSubsetGate
  Checks whether requested scope is limited to evidence-supported entities.

ForbiddenDataGate
  Checks whether raw logs, model weights, admin privileges, or write access are absent.

PermissionDiffGate
  Computes exactly what new authority is being requested.

ExpirationGate
  Checks whether temporary access has an expiration condition.

RevocationGate
  Checks whether access can be revoked after task completion.

MutationSeparationGate
  Blocks write access during diagnosis unless remediation proof exists.
```

These checks should be cheap and mostly token-free.

---

## Claim routing

Proof capsules should route claims by type.

```text
machine-verifiable claim
  -> deterministic verifier

human-reviewed claim
  -> human or small review model only if needed

unverifiable narrative claim
  -> context only, never authorization
```

Example:

```yaml
claim:
  type: machine_verifiable
  name: requested_scope_is_customer_plan_only
  verifier: scope_subset_check
  result: pass
```

```yaml
claim:
  type: human_reviewed
  name: lineage_is_reasonable_next_step
  reviewer_role: ml_engineer
  result: approved
```

```yaml
claim:
  type: narrative
  name: agent_believes_raw_logs_would_help
  authorization_weight: zero
```

---

## Proof caching

Many proof decisions should be reusable.

If a task class, probe sequence, and requested scope match a known safe pattern, the system should reuse a cached proof template.

Example:

```text
Task class:
ML quality drop

Observed path:
eval_slice_compare -> feature_drift_summary

Evidence:
affected_segment = enterprise_users
top_feature = customer_plan

Requested access:
read-only lineage for customer_plan

Cached decision:
approve if forbidden data is absent and expiration is defined
```

This reduces latency and avoids re-judging obvious cases.

---

## Probe bundles

To reduce back-and-forth latency, the system can recommend a bundle of safe probes instead of one probe at a time.

Example:

```text
Instead of:
run eval_slice_compare
then ask
then run feature_drift_summary
then ask

Use:
run safe_quality_drop_probe_bundle
```

Bundle:

```text
eval_slice_compare
feature_drift_summary
model_route_compare
```

The bundle is allowed because all probes are:

```text
read-only
aggregate
schema-limited
low privacy cost
pre-approved for the task class
```

This keeps the JIT model without making the agent negotiate every micro-step.

---

## Latency budget

The system should define a target latency budget.

Example:

```text
Tier 0:
< 10 ms

Tier 1:
< 100 ms

Tier 2:
< 2 seconds if LLM-assisted
human async if needed

Tier 3:
human approval required
not optimized for speed
```

The product should optimize for this:

```text
most access decisions should be Tier 0 or Tier 1
only rare decisions should reach Tier 2 or Tier 3
```

---

## Token cost control

To avoid proof becoming expensive:

```text
Do not send full traces to an LLM.
Do not ask an LLM to judge deterministic claims.
Do not repeat policy text in every decision.
Do not generate long natural-language justifications for every low-risk probe.
```

Instead:

```text
store compact structured traces
use claim IDs
use policy IDs
use precompiled proof templates
use deterministic gate results
summarize only for UI or human review
```

Example compact proof:

```yaml
proof_id: proof_041
template: ml_quality_drop_feature_lineage_v1
machine_claims:
  eval_slice_probe_attempted: pass
  drift_probe_attempted: pass
  suspicious_feature_identified: customer_plan
  requested_scope_subset: pass
  forbidden_data_absent: pass
  read_only: pass
  expiration_defined: pass
decision: approved
```

This is much cheaper than asking another LLM:

```text
Does this agent deserve access?
```

---

## Updated demo with fast proof

The 60-second demo should also show that proof is fast.

```text
1. Agent asks for raw logs.
2. System blocks instantly using deterministic policy.
3. System offers safe_quality_drop_probe_bundle.
4. Bundle runs eval slice and drift probes.
5. Slice shows enterprise users affected.
6. Drift probe identifies customer_plan.
7. Agent requests lineage for customer_plan only.
8. Deterministic proof gate checks machine-verifiable claims.
9. Proof gate approves without LLM judge.
10. Diagnosis: train/serve skew.
11. UI shows avoided raw logs, DB access, weights, admin, and write access.
```

The key message:

```text
Strict proof does not have to mean slow proof.
```

---

## Architecture improvement

Add a **Proof Router** between the Authority Broker and Proof Capsule Verifier.

```text
Authority Broker
  ↓
Proof Router
  ↓
Tier 0: Auto Allow
Tier 1: Deterministic Verifier
Tier 2: Human / LLM-Assisted Review
Tier 3: High-Risk Approval
```

The Proof Router decides how much verification is needed.

Most common diagnostic paths should never touch the LLM judge.

---

## Updated success metrics

Add these metrics:

```text
proof_verification_latency_p50
proof_verification_latency_p95
percent_decisions_deterministic
percent_decisions_llm_reviewed
percent_decisions_human_reviewed
average_tokens_per_access_decision
cached_proof_hit_rate
probe_bundle_success_rate
tier_1_auto_approval_rate
tier_3_escalation_rate
```

These metrics prevent the architecture from becoming theoretically safe but practically unusable.

---

## Product principle

The system should be strict where authority is dangerous and fast where authority is safe.

```text
Low-risk probe:
  fast deterministic approval

Scoped diagnostic access:
  deterministic proof capsule

Ambiguous access:
  limited human or LLM review

Sensitive or mutating access:
  strict human-approved proof
```

This solves the proof bottleneck while preserving the core product promise.

Therapeutic Tomography should feel like:

```text
fast guardrails for normal diagnosis
hard gates for dangerous access
```

not:

```text
a courtroom trial for every tool call
```

---

## Success metrics

```text
authority_efficiency_score
  task_success / total_authority_cost

unnecessary_access_avoided_count
  number of broad permissions avoided

minimal_escalation_validity_rate
  percent of escalations approved by proof verifier

machine_verifiable_claim_ratio
  machine-verifiable claims / total proof claims

narrative_only_escalation_block_rate
  percent of narrative-only escalation requests blocked

over_escalation_rate
  broad access requested while lower-risk probe existed

under_escalation_rate
  failure caused by refusing necessary access

time_to_diagnosis
  time from task start to verified diagnosis

data_exposure_score
  sensitivity-weighted amount of information accessed

probe_information_gain
  uncertainty reduction produced by each probe

proof_valid_escalation_rate
  percent of escalations with valid proof capsules

revocation_success_rate
  temporary permissions revoked after task completion

post_remediation_success_rate
  fix verified after action

human_override_rate
  how often humans had to override the system
```

---

## Roadmap

### Phase 1: Trace-only MVP

Goal:

```text
Prove the workflow without granting real permissions automatically.
```

Build:

```text
AuthorityDose schema
ProjectionProbe schema
EscalationJustification schema
TherapeuticTrace schema
StrictProofCapsule schema
manual probe simulator
simple proof capsule validator
basic UI trace
```

No real permission changes yet.

---

### Phase 2: ML probe catalog

Goal:

```text
Create real diagnostic probes for ML infrastructure.
```

Add:

```text
eval_slice_compare
feature_drift_summary
feature_lineage_hash
redacted_failure_cluster
model_route_compare
embedding_neighborhood_drift
serving_config_diff
```

Each probe declares:

```text
required_access
privacy_cost
expected_information_gain
allowed_output_shape
forbidden_outputs
verifier
```

---

### Phase 3: Proof-gated escalation

Goal:

```text
Block unjustified access increases.
```

Build:

```text
Authority Broker
Policy Engine
Strict Proof Capsule Verifier
MinimalDeltaGate
ForbiddenDataGate
MachineVerifiableClaimGate
NarrativeClaimRejectorGate
RevocationGate
```

Add support for:

```text
temporary access
scoped access
human approval
denied escalation logging
blocked overreach suggestions
```

---

### Phase 4: Dojo and Vivarium evaluation

Goal:

```text
Train and test agents under partial access.
```

Add:

```text
over-escalation checkrides
under-escalation checkrides
strict proof capsule checkrides
wind tunnel mutations
case law generation
case law replay
adversarial probe outputs
```

---

### Phase 5: Policy learning

Goal:

```text
Learn which probes and authority doses work best for each task class.
```

Learn:

```text
which probes collapse uncertainty
which access levels are usually unnecessary
which task classes require faster escalation
which workspaces have stricter boundaries
which failures indicate over-caution
which failures indicate excessive authority
which proof claims are usually machine-verifiable
```

The learned policy should not directly grant broader access. It should recommend safer defaults and improve proof verification.

---

## What makes this different

Therapeutic Tomography is not just permission escalation.

Permission escalation is access-centered:

```text
The agent wants more access.
Should we grant it?
```

Therapeutic Tomography is uncertainty-centered and proof-centered:

```text
What uncertainty blocks the task?
What is the smallest safe observation that can reduce it?
What proof justifies the next authority dose?
Which claims are machine-verifiable?
Which claims need human review?
Which claims are just narrative?
```

This makes it useful for:

```text
ML infrastructure debugging
enterprise AI agents
data-sensitive automation
production incident diagnosis
autonomous software engineering agents
compliance-heavy environments
multi-agent operating systems
```

---

## Main risks

### Risk 1: Too much complexity

If every action requires a long proof, the system becomes unusable.

Mitigation:

```text
Use lightweight proof for low-risk probes.
Use strict proof only for sensitive data or mutation.
```

---

### Risk 2: Agent becomes too cautious

The agent may avoid necessary escalation.

Mitigation:

```text
Add severity-based escalation paths.
Track under-escalation as a failure.
Allow human-approved emergency escalation.
```

---

### Risk 3: Probe outputs leak sensitive data

A probe could accidentally return too much information.

Mitigation:

```text
Strict allowed_output_shape
schema validation
redaction
output verifier
audit logging
```

---

### Risk 4: Case law becomes stale

Old access patterns may become unsafe or inefficient.

Mitigation:

```text
Add confidence scores.
Add expiration dates.
Revalidate case law during checkrides.
```

---

### Risk 5: Human reviewers approve too much

Humans may approve broad access because it is faster.

Mitigation:

```text
Show available lower-risk alternatives.
Show avoided access.
Show authority cost.
Require reason for broad approval.
Log broad-access approvals for review.
```

---

### Risk 6: Proof capsules become performative

The agent may generate convincing proof text without real evidence.

Mitigation:

```text
Separate machine-verifiable claims from narrative claims.
Reject narrative-only proof capsules.
Require evidence links for critical claims.
Use schema-level verification.
Use trace-level verification.
```

---

## Final pitch

Agent Therapeutic Tomography is a safety and reasoning layer for AI agents that treats access as a measured dose, not a blank check.

It forces agents to diagnose problems through small, privacy-preserving projections before requesting broader authority. Every escalation is checked by a strict proof capsule that separates machine-verifiable claims, human-reviewed claims, and unverifiable narrative claims.

The system does not merely ask whether the agent sounds reasonable. It checks whether the agent actually tried lower-risk probes, whether the requested access is minimal, whether forbidden data is avoided, and whether the access is scoped, temporary, revocable, and verifiable.

This reduces unnecessary data exposure, prevents unsafe mutation, and creates a training loop where agents learn to solve real infrastructure problems with the least authority that works.
