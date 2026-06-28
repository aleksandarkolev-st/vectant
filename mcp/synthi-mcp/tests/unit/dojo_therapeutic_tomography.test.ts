import { describe, expect, it } from "vitest";
import {
  buildMlQualityDropTherapeuticDemoTrace,
  buildProjectionProbe,
  buildSafeProbeBundle,
  buildStrictProofCapsule,
  classifyTherapeuticProofRoute,
  emptyTherapeuticTrace,
  evaluateAuthorityBroker,
  evaluateProofCache,
  evaluateRemediationGate,
  evaluateUnderEscalation,
  inferSupportedScopeValues,
  scoreTherapeuticAction,
  selectLowestRiskProbe,
  summarizeProofMetrics,
  THERAPEUTIC_DEFAULT_POLICY,
  THERAPEUTIC_ML_QUALITY_DROP_PROBES,
  type TherapeuticAccessRequest,
  type TherapeuticProbeContract,
} from "../../src/dojo/tomography/index.js";

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
