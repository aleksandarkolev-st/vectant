import { describe, expect, it } from "vitest";
import {
  buildMlQualityDropTherapeuticDemoTrace,
  buildProjectionProbe,
  buildStrictProofCapsule,
  classifyTherapeuticProofRoute,
  emptyTherapeuticTrace,
  evaluateAuthorityBroker,
  inferSupportedScopeValues,
  scoreTherapeuticAction,
  selectLowestRiskProbe,
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
});
