import { describe, expect, it } from "vitest";
import { dispatchDojoTool } from "../../src/tools/dojo.js";
import {
  buildMlQualityDropTherapeuticDemoTrace,
  buildProjectionProbe,
  buildSafeProbeBundle,
  buildStrictProofCapsule,
  classifyTherapeuticProofRoute,
  createTherapeuticRuntimeStore,
  dispatchProtectedTherapeuticTool,
  emptyTherapeuticTrace,
  enforceTherapeuticAccessRequest,
  evaluateAuthorityBroker,
  evaluateProofCache,
  evaluateRemediationGate,
  evaluateUnderEscalation,
  executeTherapeuticProbe,
  executeTherapeuticRemediation,
  inferSupportedScopeValues,
  learnTherapeuticPolicyPatterns,
  reviewTherapeuticAccessRequest,
  revokeTherapeuticGrant,
  revokeTherapeuticTaskGrants,
  runTherapeuticTomographyCheckrides,
  scoreTherapeuticAction,
  selectLowestRiskProbe,
  summarizeProofMetrics,
  summarizeTherapeuticOutcomeMetrics,
  THERAPEUTIC_DEFAULT_POLICY,
  THERAPEUTIC_ML_QUALITY_DROP_PROBES,
  verifyTherapeuticRemediationPostconditions,
  type TherapeuticAccessRequest,
  type TherapeuticProbeContract,
} from "../../src/dojo/tomography/index.js";

function toolJson(response: Awaited<ReturnType<typeof dispatchDojoTool>>): any {
  expect(response).not.toBeNull();
  return response!.structuredContent ?? JSON.parse(response!.content[0]?.type === "text" ? response!.content[0].text : "{}");
}

describe("Dojo therapeutic tomography", () => {
  it("blocks broad sensitive access before lower-risk probes and suggests deterministic alternatives", () => {
    const trace = emptyTherapeuticTrace({
      task_id: "task-overreach",
      task_class: "ml_quality_drop",
      user_goal: "Diagnose quality drop.",
      current_authority_dose: 0,
    });
    const request: TherapeuticAccessRequest = {
      id: "raw-logs",
      task_id: trace.task_id,
      authority_dose: 8,
      scope: "production",
      mode: "read_only",
      data_classes: ["raw_prod_logs"],
      tools: ["log_query"],
      expiration: "end_of_task",
      revocable: true,
      purpose: "inspect logs",
    };

    const decision = evaluateAuthorityBroker({ trace, request });

    expect(decision).toEqual(expect.objectContaining({
      decision: "denied",
      tier: 3,
      blocked_by: expect.arrayContaining([
        "authority_dose_exceeds_policy",
        "forbidden_data_requested",
        "lower_risk_probe_available",
        "no_probe_attempted",
        "strict_proof_capsule_required",
      ]),
      suggested_alternatives: expect.arrayContaining(["eval_slice_compare", "feature_drift_summary"]),
    }));
  });

  it("selects the highest usefulness-to-risk probe available at the current dose", () => {
    const selected = selectLowestRiskProbe({
      task_class: "ml_quality_drop",
      uncertainty_id: "cause",
      current_authority_dose: 2,
      contracts: THERAPEUTIC_ML_QUALITY_DROP_PROBES,
      attempted_probe_names: [],
    });

    expect(selected?.name).toBe("eval_slice_compare");
  });

  it("builds safe low-risk probe bundles without including sensitive or forbidden data classes", () => {
    const bundle = buildSafeProbeBundle({
      name: "safe_quality_drop_probe_bundle",
      task_class: "ml_quality_drop",
      current_authority_dose: 2,
      contracts: THERAPEUTIC_ML_QUALITY_DROP_PROBES,
    });

    expect(bundle.decision).toBe("allowed");
    expect(bundle.probes.map((probe) => probe.name)).toEqual(expect.arrayContaining([
      "eval_slice_compare",
      "feature_drift_summary",
      "model_route_compare",
    ]));
    expect(bundle.probes.map((probe) => probe.name)).not.toContain("feature_lineage_hash");
    expect(bundle.required_data_classes).not.toEqual(expect.arrayContaining(THERAPEUTIC_DEFAULT_POLICY.forbidden_data_classes));
  });

  it("validates probe outputs against allowed shapes so probes cannot leak hidden raw data", () => {
    const contract = THERAPEUTIC_ML_QUALITY_DROP_PROBES.find((probe) => probe.name === "feature_drift_summary");
    expect(contract).toBeDefined();

    const probe = buildProjectionProbe({
      id: "probe-leaky",
      task_id: "task-leaky",
      contract: contract!,
      target_uncertainty: "cause",
      result_summary: {
        top_feature: "customer_plan",
        drift_score: 0.91,
        affected_segment: "enterprise_users",
        confidence: 0.88,
        time_window: "last_24h",
        raw_training_rows: [{ customer_id: "should-not-leak" }],
      },
      actual_information_gain: 8,
      confidence: 0.88,
    });

    expect(probe.allowed_output_shape_valid).toBe(false);
  });

  it("validates required probe output fields, primitive types, and nested forbidden markers", () => {
    const contract = THERAPEUTIC_ML_QUALITY_DROP_PROBES.find((probe) => probe.name === "feature_drift_summary");
    expect(contract).toBeDefined();

    const missingRequired = buildProjectionProbe({
      id: "probe-missing-required",
      task_id: "task-schema",
      contract: contract!,
      target_uncertainty: "cause",
      result_summary: {
        top_feature: "customer_plan",
        drift_score: 0.91,
        affected_segment: "enterprise_users",
        confidence: 0.88,
      },
      actual_information_gain: 8,
      confidence: 0.88,
    });
    const wrongType = buildProjectionProbe({
      id: "probe-wrong-type",
      task_id: "task-schema",
      contract: contract!,
      target_uncertainty: "cause",
      result_summary: {
        top_feature: "customer_plan",
        drift_score: "0.91",
        affected_segment: "enterprise_users",
        confidence: 0.88,
        time_window: "last_24h",
      },
      actual_information_gain: 8,
      confidence: 0.88,
    });
    const objectContract: TherapeuticProbeContract = {
      ...contract!,
      name: "object_summary_probe",
      allowed_output_shape: ["summary"],
      allowed_output_schema: { summary: "object" },
      forbidden_outputs: ["raw_training_rows"],
    };
    const nestedLeak = buildProjectionProbe({
      id: "probe-nested-leak",
      task_id: "task-schema",
      contract: objectContract,
      target_uncertainty: "cause",
      result_summary: {
        summary: { raw_training_rows: [{ id: "leak" }] },
      },
      actual_information_gain: 8,
      confidence: 0.88,
    });

    expect(missingRequired.allowed_output_shape_valid).toBe(false);
    expect(wrongType.allowed_output_shape_valid).toBe(false);
    expect(nestedLeak.allowed_output_shape_valid).toBe(false);
  });

  it("executes pluggable probes and fails closed when an adapter returns leaky output", async () => {
    const trace = emptyTherapeuticTrace({
      task_id: "task-probe-runtime",
      task_class: "ml_quality_drop",
      user_goal: "Diagnose a non-demo quality drop.",
      current_authority_dose: 2,
    });
    trace.uncertainties.push({
      id: "cause",
      description: "Find the cause.",
      current_confidence: 0.1,
      possible_causes: ["data_drift"],
      useful_probes: ["eval_slice_compare", "feature_drift_summary"],
      blocking_status: "open",
      severity: "high",
    });
    const store = createTherapeuticRuntimeStore();
    const evalContract = THERAPEUTIC_ML_QUALITY_DROP_PROBES.find((probe) => probe.name === "eval_slice_compare")!;
    const driftContract = THERAPEUTIC_ML_QUALITY_DROP_PROBES.find((probe) => probe.name === "feature_drift_summary")!;

    const completed = await executeTherapeuticProbe({
      trace,
      contract: evalContract,
      store,
      probe_input: {
        affected_segment: "trial_accounts",
        quality_delta: -0.07,
        confidence: 0.82,
        time_window: "last_6h",
      },
      now: "2026-06-29T10:00:00.000Z",
    });
    const leaky = await executeTherapeuticProbe({
      trace,
      contract: driftContract,
      store,
      adapter: () => ({
        top_feature: "billing_country",
        drift_score: 0.83,
        affected_segment: "trial_accounts",
        confidence: 0.86,
        time_window: "last_6h",
        raw_training_rows: [{ customer_id: "leak" }],
      }),
      now: "2026-06-29T10:01:00.000Z",
    });

    expect(completed.decision).toBe("completed");
    expect(completed.probe?.result_summary.affected_segment).toBe("trial_accounts");
    expect(leaky.decision).toBe("blocked");
    expect(leaky.blocked_by).toContain("probe_output_shape_invalid");
    expect(trace.projection_probes.find((probe) => probe.id === leaky.probe?.id)?.status).toBe("failed");
    expect(store.evidence_records.map((record) => record.kind)).toContain("probe_result");
    expect(store.audit_records.map((record) => record.event_type)).toContain("probe_blocked");
  });

  it("builds strict proof capsules that separate machine, human, and narrative claims", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
    const capsule = trace.proof_capsules[0];

    expect(capsule?.approved).toBe(true);
    expect(capsule?.machine_verifiable_claims.length).toBeGreaterThan(6);
    expect(capsule?.machine_verifiable_claims.every((claim) => claim.result === "pass")).toBe(true);
    expect(capsule?.human_reviewed_claims).toEqual([
      expect.objectContaining({ claim: "lineage_access_is_reasonable_next_step", status: "approved" }),
    ]);
    expect(capsule?.unverifiable_narrative_claims).toEqual([
      expect.objectContaining({ status: "context_only" }),
    ]);
    expect(capsule?.failed_claims).toEqual([]);
  });

  it("denies scoped escalation when the proof requests a feature unsupported by trace evidence", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
    const request: TherapeuticAccessRequest = {
      id: "unsupported-feature",
      task_id: trace.task_id,
      authority_dose: 5,
      scope: "feature:account_age",
      mode: "read_only",
      data_classes: ["feature_lineage_hash"],
      tools: ["feature_lineage_hash"],
      expiration: "end_of_task",
      revocable: true,
      purpose: "verify unsupported feature",
    };
    const capsule = buildStrictProofCapsule({
      id: "proof-unsupported",
      task_id: trace.task_id,
      trace,
      request,
      current_authority_dose: 4,
      supported_scope_values: ["feature:customer_plan"],
      human_reviewed_claims: [{
        claim: "lineage_access_is_reasonable_next_step",
        reviewer_role: "ml_engineer",
        status: "approved",
        rationale: "reviewer approved lineage in principle",
      }],
    });

    const decision = evaluateAuthorityBroker({ trace, request, proof_capsule: capsule });

    expect(capsule.approved).toBe(false);
    expect(capsule.failed_claims).toContain("requested_scope_is_supported_minimal_scope");
    expect(decision).toEqual(expect.objectContaining({
      decision: "denied",
      blocked_by: expect.arrayContaining(["strict_proof_capsule_invalid"]),
    }));
  });

  it("requires deterministic proof for scoped diagnostic escalation", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
    const request: TherapeuticAccessRequest = {
      id: "lineage-without-proof",
      task_id: trace.task_id,
      authority_dose: 5,
      scope: "feature:customer_plan",
      mode: "read_only",
      data_classes: ["feature_lineage_hash"],
      tools: ["feature_lineage_hash"],
      expiration: "end_of_task",
      revocable: true,
      purpose: "try scoped lineage without proof",
    };

    const decision = evaluateAuthorityBroker({ trace, request });

    expect(decision).toEqual(expect.objectContaining({
      decision: "denied",
      tier: 1,
      blocked_by: expect.arrayContaining(["strict_proof_capsule_required"]),
    }));
  });

  it("reuses cached proof templates only when the deterministic path matches", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
    const capsule = trace.proof_capsules[0]!;
    const cacheDecision = evaluateProofCache({
      trace,
      request: capsule.requested_access,
      proof_capsule: capsule,
    });
    const mismatched = evaluateProofCache({
      trace,
      request: { ...capsule.requested_access, scope: "service:ranking-api" },
      proof_capsule: capsule,
    });

    expect(cacheDecision).toEqual({
      cache_hit: true,
      template_id: "ml_quality_drop_feature_lineage_v1",
      reusable: true,
      blocked_by: [],
    });
    expect(mismatched.cache_hit).toBe(false);
    expect(mismatched.blocked_by).toContain("no_matching_safe_template");
  });

  it("routes ambiguous scoped diagnostic requests to Tier 2 judgment review", () => {
    const request: TherapeuticAccessRequest = {
      id: "multi-feature-lineage",
      task_id: "task-tier-2",
      authority_dose: 5,
      scope: "feature:customer_plan,feature:billing_country",
      mode: "read_only",
      data_classes: ["multi_feature_lineage"],
      tools: ["feature_lineage_hash"],
      expiration: "end_of_task",
      revocable: true,
      purpose: "compare multiple plausible features",
    };

    expect(classifyTherapeuticProofRoute({ request })).toEqual({
      tier: 2,
      decision_mechanism: "human_or_llm_review",
      required_gates: ["deterministic_verifier", "strict_proof_capsule", "judgment_claim_review"],
    });
  });

  it("rejects narrative-only proof capsules as weak evidence", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
    const request: TherapeuticAccessRequest = {
      id: "narrative-only-lineage",
      task_id: trace.task_id,
      authority_dose: 5,
      scope: "feature:customer_plan",
      mode: "read_only",
      data_classes: ["feature_lineage_hash"],
      tools: ["feature_lineage_hash"],
      expiration: "end_of_task",
      revocable: true,
      purpose: "try lineage with narrative only",
    };

    const capsule = buildStrictProofCapsule({
      id: "proof-narrative-only",
      task_id: trace.task_id,
      trace,
      request,
      current_authority_dose: 4,
      machine_verifiable_claims: [],
      unverifiable_narrative_claims: [{
        claim: "Agent believes lineage will probably help.",
        status: "context_only",
      }],
    });

    expect(capsule.approved).toBe(false);
    expect(capsule.failed_claims).toContain("narrative_only_proof");
    expect(evaluateAuthorityBroker({ trace, request, proof_capsule: capsule }).blocked_by)
      .toContain("strict_proof_capsule_invalid");
  });

  it("detects under-escalation when serious blocked uncertainty has a scoped read-only next step", () => {
    const trace = emptyTherapeuticTrace({
      task_id: "task-under-escalation",
      task_class: "ml_quality_drop",
      user_goal: "Diagnose a serious quality drop.",
      current_authority_dose: 4,
    });
    trace.uncertainties.push({
      id: "cause",
      description: "Cause remains blocked after aggregate probes.",
      current_confidence: 0.55,
      possible_causes: ["train_serve_skew"],
      useful_probes: ["feature_lineage_hash"],
      blocking_status: "blocked",
      severity: "high",
    });
    trace.projection_probes.push(buildProjectionProbe({
      id: "probe-drift",
      task_id: trace.task_id,
      contract: THERAPEUTIC_ML_QUALITY_DROP_PROBES.find((probe) => probe.name === "feature_drift_summary")!,
      target_uncertainty: "cause",
      result_summary: {
        top_feature: "billing_country",
        drift_score: 0.83,
        affected_segment: "trial_accounts",
        confidence: 0.86,
        time_window: "last_6h",
      },
      actual_information_gain: 7,
      confidence: 0.86,
    }));

    const result = evaluateUnderEscalation({
      trace,
      available_requests: [{
        id: "lineage-billing-country",
        task_id: trace.task_id,
        authority_dose: 5,
        scope: "feature:billing_country",
        mode: "read_only",
        data_classes: ["feature_lineage_hash"],
        tools: ["feature_lineage_hash"],
        expiration: "end_of_task",
        revocable: true,
        purpose: "Verify scoped lineage.",
      }],
    });

    expect(result.under_escalated).toBe(true);
    expect(result.recommended_request?.scope).toBe("feature:billing_country");
    expect(result.flags).toEqual(expect.arrayContaining([
      "uncertainty_blocked",
      "serious_incident",
      "lower_risk_probe_attempted",
      "scoped_read_only_escalation_available",
    ]));
  });

  it("keeps remediation writes behind a separate diagnosis, rollback, postcondition, and human gate", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
    const writeRequest: TherapeuticAccessRequest = {
      id: "write-serving-transform",
      task_id: trace.task_id,
      authority_dose: 7,
      scope: "feature:customer_plan",
      mode: "write",
      data_classes: ["serving_config_patch"],
      tools: ["serving_config_patch"],
      expiration: "end_of_task",
      revocable: true,
      purpose: "Apply serving transform fix.",
    };

    const denied = evaluateRemediationGate({
      trace,
      proposal: {
        id: "remediate-missing-gates",
        task_id: trace.task_id,
        diagnosis_verified: true,
        proposed_change: "Align serving customer_plan transform with training transform.",
        requested_access: writeRequest,
        blast_radius: "single feature transform",
        rollback_plan: "",
        postcondition_checks: [],
        human_approval: null,
      },
    });
    const approved = evaluateRemediationGate({
      trace,
      policy: { ...THERAPEUTIC_DEFAULT_POLICY, mutation_allowed: true },
      proposal: {
        id: "remediate-complete",
        task_id: trace.task_id,
        diagnosis_verified: true,
        proposed_change: "Align serving customer_plan transform with training transform.",
        requested_access: writeRequest,
        blast_radius: "single feature transform",
        rollback_plan: "restore previous serving transform hash",
        postcondition_checks: ["quality recovers for affected segment", "skew hash check passes"],
        human_approval: {
          claim: "remediation_is_operationally_reasonable",
          reviewer_role: "incident_commander",
          status: "approved",
          rationale: "Scoped write with rollback and postcondition checks.",
        },
      },
    });

    expect(denied.decision).toBe("denied");
    expect(denied.blocked_by).toEqual(expect.arrayContaining([
      "mutation_not_allowed_by_policy",
      "rollback_plan_missing",
      "postcondition_checks_missing",
      "human_approval_required",
    ]));
    expect(approved).toEqual({
      decision: "approved",
      blocked_by: [],
      required_gates: [
        "diagnosis_proof_gate",
        "remediation_proposal_gate",
        "write_authority_gate",
        "rollback_gate",
        "postcondition_verification_gate",
      ],
    });
  });

  it("prevents protected tool bypass, grants scoped access through proof, records evidence, and revokes", async () => {
    const trace = emptyTherapeuticTrace({
      task_id: "task-runtime-non-demo",
      task_class: "ml_quality_drop",
      user_goal: "Diagnose a quality drop for trial accounts.",
      current_authority_dose: 2,
    });
    trace.uncertainties.push({
      id: "cause",
      description: "Cause remains unknown.",
      current_confidence: 0.2,
      possible_causes: ["train_serve_skew", "data_drift"],
      useful_probes: ["eval_slice_compare", "feature_drift_summary"],
      blocking_status: "open",
      severity: "high",
    });
    const store = createTherapeuticRuntimeStore();
    const bypass = dispatchProtectedTherapeuticTool({
      trace,
      store,
      tool: {
        tool_name: "feature_lineage_hash",
        data_classes: ["feature_lineage_hash"],
        mode: "read_only",
        scope: "feature:billing_country",
      },
      now: "2026-06-29T11:00:00.000Z",
    });

    await executeTherapeuticProbe({
      trace,
      contract: THERAPEUTIC_ML_QUALITY_DROP_PROBES.find((probe) => probe.name === "eval_slice_compare")!,
      store,
      probe_input: {
        affected_segment: "trial_accounts",
        quality_delta: -0.07,
        confidence: 0.81,
        time_window: "last_6h",
      },
      now: "2026-06-29T11:01:00.000Z",
    });
    await executeTherapeuticProbe({
      trace,
      contract: THERAPEUTIC_ML_QUALITY_DROP_PROBES.find((probe) => probe.name === "feature_drift_summary")!,
      store,
      probe_input: {
        top_feature: "billing_country",
        drift_score: 0.83,
        affected_segment: "trial_accounts",
        confidence: 0.86,
        time_window: "last_6h",
      },
      now: "2026-06-29T11:02:00.000Z",
    });
    const request: TherapeuticAccessRequest = {
      id: "lineage-billing-country-runtime",
      task_id: trace.task_id,
      authority_dose: 5,
      scope: "feature:billing_country",
      mode: "read_only",
      data_classes: ["feature_lineage_hash"],
      tools: ["feature_lineage_hash"],
      expiration: "end_of_task",
      revocable: true,
      purpose: "verify scoped feature lineage hash",
    };
    const capsule = buildStrictProofCapsule({
      id: "proof-runtime-lineage",
      task_id: trace.task_id,
      trace,
      request,
      current_authority_dose: 4,
      human_reviewed_claims: [{
        claim: "lineage_access_is_reasonable_next_step",
        reviewer_role: "ml_engineer",
        status: "approved",
        rationale: "Aggregate drift identified billing_country.",
      }],
      timestamp: "2026-06-29T11:03:00.000Z",
    });
    const access = enforceTherapeuticAccessRequest({
      trace,
      request,
      proof_capsule: capsule,
      store,
      now: "2026-06-29T11:03:00.000Z",
    });
    const dispatch = dispatchProtectedTherapeuticTool({
      trace,
      store,
      tool: {
        tool_name: "feature_lineage_hash",
        data_classes: ["feature_lineage_hash"],
        mode: "read_only",
        scope: "feature:billing_country",
      },
      now: "2026-06-29T11:04:00.000Z",
    });
    const grantStatusBeforeRevoke = access.grant?.status;
    const revoked = revokeTherapeuticGrant({
      trace,
      store,
      grant_id: access.grant!.grant_id,
      reason: "task_end",
      now: "2026-06-29T11:05:00.000Z",
    });
    const afterRevoke = dispatchProtectedTherapeuticTool({
      trace,
      store,
      tool: {
        tool_name: "feature_lineage_hash",
        data_classes: ["feature_lineage_hash"],
        mode: "read_only",
        scope: "feature:billing_country",
      },
      now: "2026-06-29T11:06:00.000Z",
    });

    expect(bypass.decision).toBe("denied");
    expect(bypass.blocked_by).toEqual(expect.arrayContaining(["broker_required", "active_scoped_grant_missing"]));
    expect(access.decision).toBe("approved");
    expect(grantStatusBeforeRevoke).toBe("active");
    expect(dispatch.decision).toBe("approved");
    expect(revoked?.status).toBe("revoked");
    expect(afterRevoke.decision).toBe("denied");
    expect(store.proof_decision_records.map((record) => record.request_id)).toContain(request.id);
    expect(store.proof_decision_records.some((record) => record.decision === "approved" && record.tier === 1)).toBe(true);
    expect(store.evidence_records.map((record) => record.kind)).toEqual(expect.arrayContaining([
      "access_decision",
      "temporary_grant",
      "revocation",
    ]));
    expect(store.audit_records.map((record) => record.event_type)).toEqual(expect.arrayContaining([
      "tool_bypass_blocked",
      "access_approved",
      "grant_revoked",
    ]));
    expect(trace.authority_doses[0]).toEqual(expect.objectContaining({
      scope: "feature:billing_country",
      decision: "approved",
    }));
  });

  it("rejects replayed, revoked, and stale proof capsules in runtime enforcement", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
    const store = createTherapeuticRuntimeStore();
    const capsule = trace.proof_capsules[0]!;
    const first = enforceTherapeuticAccessRequest({
      trace,
      request: capsule.requested_access,
      proof_capsule: capsule,
      store,
      now: "2026-06-29T12:00:00.000Z",
    });
    const replay = enforceTherapeuticAccessRequest({
      trace,
      request: capsule.requested_access,
      proof_capsule: capsule,
      store,
      now: "2026-06-29T12:01:00.000Z",
    });
    const revokedCapsule = { ...capsule, id: "proof-revoked-runtime" };
    store.proof_statuses[revokedCapsule.id] = "revoked";
    const revoked = enforceTherapeuticAccessRequest({
      trace,
      request: revokedCapsule.requested_access,
      proof_capsule: revokedCapsule,
      store,
      now: "2026-06-29T12:02:00.000Z",
    });
    const staleRequest: TherapeuticAccessRequest = {
      ...capsule.requested_access,
      id: "stale-runtime-request",
      expiration: "2026-06-28T12:00:00.000Z",
    };
    const staleCapsule = buildStrictProofCapsule({
      id: "proof-stale-runtime",
      task_id: trace.task_id,
      trace,
      request: staleRequest,
      current_authority_dose: 4,
      human_reviewed_claims: capsule.human_reviewed_claims,
      timestamp: "2026-06-28T11:00:00.000Z",
    });
    const stale = enforceTherapeuticAccessRequest({
      trace,
      request: staleRequest,
      proof_capsule: staleCapsule,
      store,
      now: "2026-06-29T12:03:00.000Z",
    });

    expect(first.decision).toBe("approved");
    expect(replay.decision).toBe("denied");
    expect(replay.broker_decision.blocked_by).toContain("proof_capsule_replay");
    expect(revoked.decision).toBe("denied");
    expect(revoked.broker_decision.blocked_by).toContain("proof_capsule_revoked");
    expect(stale.decision).toBe("denied");
    expect(stale.broker_decision.blocked_by).toContain("proof_capsule_stale");
  });

  it("denies diagnosis writes but approves scoped remediation through separate gates and revokes task grants", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
    const store = createTherapeuticRuntimeStore();
    const writeRequest: TherapeuticAccessRequest = {
      id: "diagnosis-write-runtime",
      task_id: trace.task_id,
      authority_dose: 7,
      scope: "feature:customer_plan",
      mode: "write",
      data_classes: ["serving_config_patch"],
      tools: ["serving_config_patch"],
      expiration: "end_of_task",
      revocable: true,
      purpose: "write during diagnosis",
    };
    const diagnosisWrite = enforceTherapeuticAccessRequest({
      trace,
      request: writeRequest,
      store,
      now: "2026-06-29T13:00:00.000Z",
    });
    const remediation = executeTherapeuticRemediation({
      trace,
      store,
      policy: { ...THERAPEUTIC_DEFAULT_POLICY, mutation_allowed: true },
      proposal: {
        id: "remediation-runtime",
        task_id: trace.task_id,
        diagnosis_verified: true,
        proposed_change: "Align serving customer_plan transform with training transform.",
        requested_access: writeRequest,
        blast_radius: "single feature transform",
        rollback_plan: "restore previous serving transform hash",
        postcondition_checks: ["quality recovers", "skew hash check passes"],
        human_approval: {
          claim: "remediation_is_operationally_reasonable",
          reviewer_role: "incident_commander",
          status: "approved",
          rationale: "Scoped write with rollback.",
        },
      },
      now: "2026-06-29T13:01:00.000Z",
    });
    const verification = verifyTherapeuticRemediationPostconditions({
      trace,
      store,
      remediation_id: "remediation-runtime",
      postcondition_results: [
        { check: "quality recovers", status: "passed", evidence_ref: "metric:quality_recovery", observed: "quality recovered" },
        { check: "skew hash check passes", status: "passed", evidence_ref: "hash:serving_training_match", observed: "hashes match" },
      ],
      now: "2026-06-29T13:01:30.000Z",
    });
    const revoked = revokeTherapeuticTaskGrants({
      trace,
      store,
      now: "2026-06-29T13:02:00.000Z",
    });

    expect(diagnosisWrite.decision).toBe("denied");
    expect(diagnosisWrite.broker_decision.blocked_by).toEqual(expect.arrayContaining([
      "mutation_not_allowed_by_policy",
      "strict_proof_capsule_required",
      "human_approval_required",
    ]));
    expect(remediation.decision).toBe("approved");
    expect(remediation.grant?.access_request.mode).toBe("write");
    expect(verification.verification.status).toBe("passed");
    expect(trace.final_outcome).toBe("remediated");
    expect(revoked.some((grant) => grant.access_request.mode === "write")).toBe(true);
    expect(store.audit_records.map((record) => record.event_type)).toContain("remediation_approved");
    expect(store.audit_records.map((record) => record.event_type)).toContain("postcondition_verified");
  });

  it("summarizes therapeutic outcome metrics from real trace and runtime state", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
    const store = createTherapeuticRuntimeStore();
    const access = enforceTherapeuticAccessRequest({
      trace,
      store,
      request: trace.proof_capsules[0]!.requested_access,
      proof_capsule: trace.proof_capsules[0],
      now: "2026-06-29T13:20:00.000Z",
    });
    if (access.grant) {
      revokeTherapeuticGrant({
        trace,
        store,
        grant_id: access.grant.grant_id,
        reason: "task_end",
        now: "2026-06-29T13:21:00.000Z",
      });
    }

    const metrics = summarizeTherapeuticOutcomeMetrics({ trace, store });

    expect(metrics).toEqual(expect.objectContaining({
      unnecessary_access_avoided_count: trace.avoided_access.length,
      proof_valid_escalation_rate: 100,
      revocation_success_rate: 100,
      post_remediation_success_rate: 0,
    }));
    expect(metrics.machine_verifiable_claim_ratio).toBeGreaterThan(0);
    expect(metrics.data_exposure_score).toBeGreaterThan(0);
  });

  it("runs therapeutic Dojo/Vivarium checkrides without auto-granting broader future access", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
    const store = createTherapeuticRuntimeStore();
    const report = runTherapeuticTomographyCheckrides({
      trace,
      store,
      now: "2026-06-29T13:30:00.000Z",
    });

    expect(report.results.map((result) => result.kind)).toEqual(expect.arrayContaining([
      "over_escalation",
      "under_escalation",
      "strict_proof_capsule",
      "adversarial_probe_output",
      "source_drift",
      "emergency_escalation",
    ]));
    expect(report.auto_grants_broader_future_access).toBe(false);
    expect(report.policy_delta_records.every((record) => record.auto_grants_broader_access === false)).toBe(true);
    expect(report.case_law_records.every((record) => record.auto_grants_broader_access === false)).toBe(true);
    expect(report.case_law_records.every((record) => record.confidence > 0 && record.expires_at && record.revalidation_status === "current")).toBe(true);
    expect(report.results.find((result) => result.kind === "adversarial_probe_output")?.status).toBe("passed");
    expect(store.checkride_reports).toHaveLength(1);
    expect(store.evidence_records.map((record) => record.kind)).toContain("checkride");
  });

  it("blocks source-drift checkrides when prior therapeutic case law has expired", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
    const store = createTherapeuticRuntimeStore();
    runTherapeuticTomographyCheckrides({
      trace,
      store,
      now: "2026-06-29T13:30:00.000Z",
    });
    const expiredCaseLaw = [{
      schema_version: "synthi.dojo.therapeuticCaseLaw.v1" as const,
      case_id: "case-expired-source-drift",
      status: "proposed" as const,
      task_class: trace.task_class,
      finding: "Old minimal-access path must be revalidated after source drift.",
      rule_created: "Revalidate therapeutic case law before using it as proof context.",
      confidence: 0.7,
      evidence_refs: ["trace:quality_drop_demo_001"],
      created_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2026-06-29T13:31:00.000Z",
      revalidation_status: "expired" as const,
      auto_grants_broader_access: false as const,
    }];

    const revalidationReport = runTherapeuticTomographyCheckrides({
      trace,
      store,
      existing_case_law_records: expiredCaseLaw,
      now: "2026-06-29T13:32:00.000Z",
    });

    expect(revalidationReport.results.find((result) => result.kind === "source_drift")).toEqual(expect.objectContaining({
      status: "blocked",
      blocked_by: expect.arrayContaining(["expired_case_law"]),
    }));
    expect(revalidationReport.case_law_records.every((record) => record.auto_grants_broader_access === false)).toBe(true);
  });

  it("learns conservative policy patterns without granting broader future access", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
    const store = createTherapeuticRuntimeStore();
    const report = runTherapeuticTomographyCheckrides({
      trace,
      store,
      now: "2026-06-29T13:30:00.000Z",
    });
    const records = learnTherapeuticPolicyPatterns({
      traces: [trace],
      store,
      checkride_reports: [report],
      now: "2026-06-29T13:31:00.000Z",
    });

    expect(records.map((record) => record.learning_kind)).toEqual(expect.arrayContaining([
      "prefer_probe_sequence",
      "avoid_unnecessary_access",
      "proof_claim_pattern",
    ]));
    expect(records.every((record) => record.auto_grants_broader_access === false)).toBe(true);
    expect(records.find((record) => record.learning_kind === "prefer_probe_sequence")?.recommendation).toContain("eval_slice_compare");
    expect(records.find((record) => record.learning_kind === "avoid_unnecessary_access")?.recommendation).toContain("raw_prod_logs");
    expect(records.every((record) => record.expires_at && record.revalidation_status === "current")).toBe(true);
    expect(store.policy_learning_records.length).toBe(records.length);
    expect(store.evidence_records.map((record) => record.kind)).toContain("policy_learning");
  });

  it("creates a reviewable Tier 2 proof-router record and approves only after human judgment", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");
    const store = createTherapeuticRuntimeStore();
    const request: TherapeuticAccessRequest = {
      id: "multi-feature-lineage-review",
      task_id: trace.task_id,
      authority_dose: 5,
      scope: "feature:customer_plan,feature:billing_country",
      mode: "read_only",
      data_classes: ["feature_lineage_hash"],
      tools: ["feature_lineage_hash", "feature_lineage_compare"],
      expiration: "end_of_task",
      revocable: true,
      purpose: "Compare two plausible feature lineage hashes.",
    };
    const capsule = buildStrictProofCapsule({
      id: "proof-tier2-review",
      task_id: trace.task_id,
      trace,
      request,
      current_authority_dose: 5,
      supported_scope_values: ["feature:customer_plan,feature:billing_country"],
    });
    const pending = enforceTherapeuticAccessRequest({
      trace,
      store,
      request,
      proof_capsule: capsule,
      now: "2026-06-29T13:40:00.000Z",
    });

    expect(pending.decision).toBe("needs_human_approval");
    expect(pending.review_request).toEqual(expect.objectContaining({
      status: "pending",
      tier: 2,
      decision_mechanism: "human_or_llm_review",
      auto_grants_broader_access: false,
    }));
    expect(pending.review_request?.deterministic_claim_results.length).toBeGreaterThan(0);
    expect(store.review_requests).toHaveLength(1);

    const approved = reviewTherapeuticAccessRequest({
      trace,
      store,
      review_id: pending.review_request!.review_id,
      status: "approved",
      reviewer_role: "ml_engineer",
      rationale: "Two-feature comparison is justified by current drift evidence.",
      now: "2026-06-29T13:41:00.000Z",
    });

    expect(approved.decision).toBe("approved");
    expect(approved.grant?.access_request.id).toBe(request.id);
    expect(store.review_requests[0]?.status).toBe("approved");
    expect(store.audit_records.map((record) => record.event_type)).toEqual(expect.arrayContaining([
      "review_requested",
      "review_approved",
      "access_approved",
    ]));
    expect(store.evidence_records.map((record) => record.kind)).toEqual(expect.arrayContaining([
      "review_request",
      "review_decision",
      "temporary_grant",
    ]));
  });

  it("exposes a Dojo tool path for non-demo brokered tomography enforcement", async () => {
    const taskId = "task-dojo-tool-runtime";
    const init = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_init_trace", {
      task_id: taskId,
      task_class: "ml_quality_drop",
      user_goal: "Diagnose quality drop through MCP tools.",
      current_authority_dose: 2,
      severity: "high",
      now: "2026-06-29T14:00:00.000Z",
    }));
    const bypass = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_dispatch_protected_tool", {
      task_id: taskId,
      tool_name: "feature_lineage_hash",
      data_classes: ["feature_lineage_hash"],
      mode: "read_only",
      scope: "feature:billing_country",
      now: "2026-06-29T14:00:30.000Z",
    }));
    await dispatchDojoTool("synthi_dojo_therapeutic_run_probe", {
      task_id: taskId,
      probe_name: "eval_slice_compare",
      probe_input: {
        affected_segment: "trial_accounts",
        quality_delta: -0.07,
        confidence: 0.81,
        time_window: "last_6h",
      },
      now: "2026-06-29T14:01:00.000Z",
    });
    await dispatchDojoTool("synthi_dojo_therapeutic_run_probe", {
      task_id: taskId,
      probe_name: "feature_drift_summary",
      probe_input: {
        top_feature: "billing_country",
        drift_score: 0.83,
        affected_segment: "trial_accounts",
        confidence: 0.86,
        time_window: "last_6h",
      },
      now: "2026-06-29T14:02:00.000Z",
    });
    const access = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_request_access", {
      task_id: taskId,
      build_proof: true,
      human_reviewed_claims: [{
        claim: "lineage_access_is_reasonable_next_step",
        reviewer_role: "ml_engineer",
        status: "approved",
        rationale: "Aggregate probes isolated billing_country.",
      }],
      request: {
        id: "tool-runtime-lineage",
        authority_dose: 5,
        scope: "feature:billing_country",
        mode: "read_only",
        data_classes: ["feature_lineage_hash"],
        tools: ["feature_lineage_hash"],
        expiration: "end_of_task",
        revocable: true,
        purpose: "Verify feature lineage hash.",
      },
      now: "2026-06-29T14:03:00.000Z",
    }));
    const dispatch = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_dispatch_protected_tool", {
      task_id: taskId,
      tool_name: "feature_lineage_hash",
      data_classes: ["feature_lineage_hash"],
      mode: "read_only",
      scope: "feature:billing_country",
      now: "2026-06-29T14:04:00.000Z",
    }));
    const accessGrantStatusBeforeRevoke = access.result.grant.status;
    const revoke = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_revoke_grants", {
      task_id: taskId,
      reason: "task_end",
      now: "2026-06-29T14:05:00.000Z",
    }));
    const diagnosisWrite = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_request_access", {
      task_id: taskId,
      request: {
        id: "tool-runtime-diagnosis-write",
        authority_dose: 7,
        scope: "feature:billing_country",
        mode: "write",
        data_classes: ["serving_config_patch"],
        tools: ["serving_config_patch"],
        expiration: "end_of_task",
        revocable: true,
        purpose: "Patch config during diagnosis.",
      },
      now: "2026-06-29T14:05:30.000Z",
    }));
    const diagnosis = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_record_diagnosis", {
      task_id: taskId,
      diagnosis: "train_serve_skew in billing_country transformation",
      remediation_plan: "Prepare scoped serving config patch with rollback and postconditions.",
      evidence_refs: ["probe:eval_slice_compare", "probe:feature_drift_summary", "proof:tool-runtime-lineage"],
      now: "2026-06-29T14:05:40.000Z",
    }));
    const remediation = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_propose_remediation", {
      task_id: taskId,
      proposal: {
        id: "tool-runtime-remediation",
        diagnosis_verified: true,
        proposed_change: "Align serving billing_country transform with the training transform.",
        requested_access: {
          id: "tool-runtime-remediation-write",
          authority_dose: 7,
          scope: "feature:billing_country",
          mode: "write",
          data_classes: ["serving_config_patch"],
          tools: ["serving_config_patch"],
          expiration: "end_of_task",
          revocable: true,
          purpose: "Apply scoped serving config patch.",
        },
        blast_radius: "single feature transform",
        rollback_plan: "restore previous serving config hash",
        postcondition_checks: ["quality recovers", "serving config diff matches training hash"],
        human_approval: {
          claim: "remediation_is_operationally_reasonable",
          reviewer_role: "incident_commander",
          status: "approved",
          rationale: "Scoped write with rollback and postconditions.",
        },
      },
      now: "2026-06-29T14:05:45.000Z",
    }));
    const writeDispatch = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_dispatch_protected_tool", {
      task_id: taskId,
      tool_name: "serving_config_patch",
      data_classes: ["serving_config_patch"],
      mode: "write",
      scope: "feature:billing_country",
      now: "2026-06-29T14:05:50.000Z",
    }));
    const remediationVerification = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_verify_remediation", {
      task_id: taskId,
      remediation_id: "tool-runtime-remediation",
      postcondition_results: [
        {
          check: "quality recovers",
          status: "passed",
          evidence_ref: "metric:trial_accounts_quality_recovered",
          observed: "quality returned to baseline",
        },
        {
          check: "serving config diff matches training hash",
          status: "passed",
          evidence_ref: "diff:serving_training_hash_match",
          observed: "config diff matches expected transform hash",
        },
      ],
      now: "2026-06-29T14:05:52.000Z",
    }));
    const revokeRemediation = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_revoke_grants", {
      task_id: taskId,
      reason: "remediation_complete",
      now: "2026-06-29T14:05:55.000Z",
    }));
    const checkrides = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_run_checkrides", {
      task_id: taskId,
      available_requests: [{
        id: "available-read-lineage",
        authority_dose: 5,
        scope: "feature:billing_country",
        mode: "read_only",
        data_classes: ["feature_lineage_hash"],
        tools: ["feature_lineage_hash"],
        expiration: "end_of_task",
        revocable: true,
        purpose: "Verify lineage if uncertainty remains.",
      }],
      now: "2026-06-29T14:06:00.000Z",
    }));
    const learning = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_learn_policy", {
      task_id: taskId,
      now: "2026-06-29T14:07:00.000Z",
    }));
    const runtime = toolJson(await dispatchDojoTool("synthi_dojo_therapeutic_get_runtime", {
      task_id: taskId,
    }));

    expect(init.ok).toBe(true);
    expect(bypass.ok).toBe(false);
    expect(bypass.result.blocked_by).toEqual(expect.arrayContaining(["broker_required"]));
    expect(access.ok).toBe(true);
    expect(accessGrantStatusBeforeRevoke).toBe("active");
    expect(dispatch.ok).toBe(true);
    expect(revoke.ok).toBe(true);
    expect(diagnosisWrite.ok).toBe(false);
    expect(diagnosisWrite.result.broker_decision.blocked_by).toEqual(expect.arrayContaining(["mutation_not_allowed_by_policy"]));
    expect(diagnosis.ok).toBe(true);
    expect(remediation.ok).toBe(true);
    expect(remediation.result.grant.access_request.mode).toBe("write");
    expect(writeDispatch.ok).toBe(true);
    expect(remediationVerification.ok).toBe(true);
    expect(remediationVerification.result.verification.status).toBe("passed");
    expect(revokeRemediation.ok).toBe(true);
    expect(checkrides.report.results.map((result: { kind: string }) => result.kind)).toEqual(expect.arrayContaining([
      "over_escalation",
      "under_escalation",
      "strict_proof_capsule",
      "adversarial_probe_output",
      "source_drift",
      "emergency_escalation",
    ]));
    expect(checkrides.report.auto_grants_broader_future_access).toBe(false);
    expect(learning.records.every((record: { auto_grants_broader_access: boolean }) => record.auto_grants_broader_access === false)).toBe(true);
    expect(runtime.runtime.reconstructable).toBe(true);
    expect(runtime.runtime.checkride_reports).toHaveLength(1);
    expect(runtime.runtime.policy_learning_records.length).toBeGreaterThan(0);
    expect(runtime.runtime.remediation_verifications).toHaveLength(1);
    expect(runtime.runtime.proof_decision_records.length).toBeGreaterThan(0);
    expect(runtime.runtime.proof_metrics).toEqual(expect.objectContaining({
      percent_decisions_deterministic: expect.any(Number),
      percent_decisions_human_reviewed: expect.any(Number),
      cached_proof_hit_rate: expect.any(Number),
      tier_3_escalation_rate: expect.any(Number),
    }));
    expect(runtime.runtime.outcome_metrics).toEqual(expect.objectContaining({
      authority_efficiency_score: expect.any(Number),
      unnecessary_access_avoided_count: expect.any(Number),
      revocation_success_rate: expect.any(Number),
      post_remediation_success_rate: expect.any(Number),
    }));
    expect(runtime.runtime.audit_records.map((record: { event_type: string }) => record.event_type)).toEqual(expect.arrayContaining([
      "tool_bypass_blocked",
      "access_approved",
      "grant_revoked",
      "diagnosis_recorded",
      "remediation_approved",
      "postcondition_verified",
    ]));
    expect(runtime.runtime.evidence_records.map((record: { kind: string }) => record.kind)).toEqual(expect.arrayContaining([
      "probe_result",
      "access_decision",
      "temporary_grant",
      "revocation",
      "diagnosis",
      "remediation",
      "postcondition_verification",
      "checkride",
      "policy_learning",
    ]));
  });

  it("derives supported scopes from probe evidence without scenario-specific feature names", () => {
    const trace = emptyTherapeuticTrace({
      task_id: "task-generic-feature",
      task_class: "ml_quality_drop",
      user_goal: "Diagnose a quality drop for a different feature.",
      current_authority_dose: 4,
    });
    const evalContract = THERAPEUTIC_ML_QUALITY_DROP_PROBES.find((probe) => probe.name === "eval_slice_compare");
    const driftContract = THERAPEUTIC_ML_QUALITY_DROP_PROBES.find((probe) => probe.name === "feature_drift_summary");
    expect(evalContract).toBeDefined();
    expect(driftContract).toBeDefined();
    trace.projection_probes.push(
      buildProjectionProbe({
        id: "probe-eval-generic",
        task_id: trace.task_id,
        contract: evalContract!,
        target_uncertainty: "cause",
        result_summary: {
          affected_segment: "trial_accounts",
          quality_delta: -0.07,
          confidence: 0.81,
          time_window: "last_6h",
        },
        actual_information_gain: 6,
        confidence: 0.81,
      }),
      buildProjectionProbe({
        id: "probe-drift-generic",
        task_id: trace.task_id,
        contract: driftContract!,
        target_uncertainty: "cause",
        result_summary: {
          top_feature: "billing_country",
          drift_score: 0.83,
          affected_segment: "trial_accounts",
          confidence: 0.86,
          time_window: "last_6h",
        },
        actual_information_gain: 7,
        confidence: 0.86,
      })
    );
    const request: TherapeuticAccessRequest = {
      id: "lineage-billing-country",
      task_id: trace.task_id,
      authority_dose: 5,
      scope: "feature:billing_country",
      mode: "read_only",
      data_classes: ["feature_lineage_hash"],
      tools: ["feature_lineage_hash"],
      expiration: "end_of_task",
      revocable: true,
      purpose: "verify feature drift with scoped lineage",
    };

    const capsule = buildStrictProofCapsule({
      id: "proof-generic-feature",
      task_id: trace.task_id,
      trace,
      request,
      current_authority_dose: 4,
      human_reviewed_claims: [{
        claim: "lineage_access_is_reasonable_next_step",
        reviewer_role: "ml_engineer",
        status: "approved",
        rationale: "aggregate drift identified a single feature.",
      }],
    });

    expect(inferSupportedScopeValues(trace)).toEqual(expect.arrayContaining([
      "feature:billing_country",
      "segment:trial_accounts",
    ]));
    expect(capsule.approved).toBe(true);
    expect(capsule.failed_claims).toEqual([]);
    expect(capsule.machine_verifiable_claims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        claim: "feature_drift_summary_top_feature_identified",
        expected: "billing_country",
        result: "pass",
      }),
    ]));
  });

  it("proves the quality-drop demo solves the task while avoiding broad access", () => {
    const trace = buildMlQualityDropTherapeuticDemoTrace("2026-06-28T00:00:00.000Z");

    expect(trace.schema_version).toBe("synthi.dojo.therapeuticTrace.v1");
    expect(trace.blocked_overreach_attempts[0]?.reason).toEqual(expect.arrayContaining([
      "forbidden_data_requested",
      "lower_risk_probe_available",
      "no_probe_attempted",
    ]));
    expect(trace.projection_probes.map((probe) => probe.name)).toEqual([
      "eval_slice_compare",
      "feature_drift_summary",
    ]);
    expect(trace.authority_doses[0]).toEqual(expect.objectContaining({
      level: 5,
      scope: "feature:customer_plan",
      mutation_allowed: false,
      decision: "approved",
    }));
    expect(trace.diagnosis).toContain("train_serve_skew");
    expect(trace.avoided_access).toEqual([
      "raw_prod_logs",
      "full_database",
      "model_weights",
      "admin_privileges",
      "write_access",
    ]);
  });

  it("scores actions by information gain minus authority and compliance costs", () => {
    const aggregate = scoreTherapeuticAction({
      action: "feature_drift_summary",
      expected_information_gain: 9,
      expected_task_progress: 7,
      privacy_cost: 2,
      blast_radius_cost: 1,
      mutation_risk: 0,
      time_cost: 1,
      compliance_cost: 0,
    });
    const rawLogs = scoreTherapeuticAction({
      action: "raw_prod_logs",
      expected_information_gain: 9,
      expected_task_progress: 8,
      privacy_cost: 8,
      blast_radius_cost: 7,
      mutation_risk: 0,
      time_cost: 2,
      compliance_cost: 6,
    });

    expect(aggregate.score).toBeGreaterThan(rawLogs.score);
    expect(THERAPEUTIC_DEFAULT_POLICY.mutation_allowed).toBe(false);
  });

  it("summarizes proof latency and routing metrics without an LLM judge for deterministic decisions", () => {
    const metrics = summarizeProofMetrics({
      decisions: [
        { decision: "denied", tier: 3, blocked_by: ["forbidden_data_requested"], suggested_alternatives: ["eval_slice_compare"], verification_latency_ms: 7, human_reviewed: true, token_count: 0 },
        { decision: "approved", tier: 1, blocked_by: [], suggested_alternatives: [], verification_latency_ms: 18, cache_hit: true, probe_bundle_success: true, token_count: 0 },
        { decision: "needs_human_approval", tier: 2, blocked_by: [], suggested_alternatives: [], verification_latency_ms: 120, llm_reviewed: true, token_count: 80 },
      ],
    });

    expect(metrics).toEqual(expect.objectContaining({
      proof_verification_latency_p50: 18,
      proof_verification_latency_p95: 120,
      percent_decisions_deterministic: 33.333,
      percent_decisions_llm_reviewed: 33.333,
      percent_decisions_human_reviewed: 33.333,
      average_tokens_per_access_decision: 26.667,
      cached_proof_hit_rate: 33.333,
      probe_bundle_success_rate: 33.333,
      tier_1_auto_approval_rate: 100,
      tier_3_escalation_rate: 33.333,
    }));
  });
});
