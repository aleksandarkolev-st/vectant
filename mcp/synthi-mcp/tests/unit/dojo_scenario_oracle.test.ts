import { describe, expect, it } from "vitest";
import {
  appendDojoScenarioOracleEvidenceRecord,
  buildDojoScenarioOracleEvidenceRecordInput,
  evaluateDojoScenarioOracle,
} from "../../src/dojo/vivarium/oracle.js";
import { materializeDojoSyntheticFixture } from "../../src/dojo/vivarium/fixture_materializer.js";
import { toDojoScenarioDefinition } from "../../src/dojo/vivarium/scenario_dsl.js";
import type { DojoEvidenceLedgerRecord } from "../../src/dojo/evidence/types.js";
import type { DojoGraphRunResult } from "../../src/dojo/graph/runtime.js";
import type { DojoScenario } from "../../src/browser/dojo.js";

describe("Dojo scenario oracle", () => {
  it("classifies an expected block as blocked from graph evidence", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "auth_expiry",
      risk_tags: ["auth_expired"],
      layer: "risk",
    }));
    const fixture = materializeDojoSyntheticFixture(definition);
    const evaluation = evaluateDojoScenarioOracle({
      definition,
      fixture,
      graph_result: graphResult({ status: "blocked", blocked_by: ["precondition_failed:auth_valid == true"] }),
      observed_evidence: ["identity_policy_state"],
    });

    expect(evaluation).toEqual(expect.objectContaining({
      status: "blocked",
      expected_outcome: "block",
      expectation_met: true,
      blocked_by: ["precondition_failed:auth_valid == true"],
    }));
    expect(evaluation.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("classifies duplicate-entity completion without stable identity evidence as failed", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "duplicate_entity",
      risk_tags: ["ambiguous_entity_match"],
    }));
    const fixture = materializeDojoSyntheticFixture(definition);
    const evaluation = evaluateDojoScenarioOracle({
      definition,
      fixture,
      graph_result: graphResult({ status: "completed" }),
      observed_evidence: ["graph_run_result"],
    });

    expect(evaluation).toEqual(expect.objectContaining({
      status: "failed",
      blocked_by: ["oracle_stable_entity_identity_missing"],
      expectation_met: false,
    }));
  });

  it("classifies successful graph completion with required evidence as passed", () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({
      mutation_kind: "baseline",
      risk_tags: ["baseline"],
      layer: "skill",
    }));
    const fixture = materializeDojoSyntheticFixture(definition);
    const evaluation = evaluateDojoScenarioOracle({
      definition,
      fixture,
      graph_result: graphResult({ status: "completed" }),
      observed_evidence: ["graph_run_result", "oracle_result"],
    });

    expect(evaluation).toEqual(expect.objectContaining({
      status: "passed",
      expected_outcome: "pass",
      expectation_met: true,
      blocked_by: [],
    }));
  });

  it("builds and appends ledger-ready oracle evidence records", async () => {
    const definition = toDojoScenarioDefinition(scenarioFixture({ mutation_kind: "baseline", layer: "skill", risk_tags: ["baseline"] }));
    const fixture = materializeDojoSyntheticFixture(definition);
    const evaluation = evaluateDojoScenarioOracle({
      definition,
      fixture,
      graph_result: graphResult({ status: "completed" }),
      observed_evidence: ["graph_run_result", "oracle_result"],
    });
    const context = {
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      skill_id: "skill-a",
      run_id: "run-a",
      created_at: "2026-06-11T00:00:00.000Z",
      created_by: "test",
    };
    const recordInput = buildDojoScenarioOracleEvidenceRecordInput(evaluation, context);
    expect(recordInput).toEqual(expect.objectContaining({
      kind: "scenario",
      artifact_sha256: evaluation.artifact_sha256,
      claim_ids: expect.arrayContaining(["scenario_oracle:passed", "scenario_expectation:met"]),
    }));

    const appended = await appendDojoScenarioOracleEvidenceRecord(evaluation, context, {
      append: async (input): Promise<DojoEvidenceLedgerRecord> => ({
        schema_version: "synthi.dojo.evidenceRecord.v1",
        tenant_id: context.tenant_id,
        workspace_id: context.workspace_id,
        previous_hash: "0".repeat(64),
        redaction_manifest_sha256: null,
        signer_key_id: null,
        source_refs: input.source_refs ?? [],
        legal_hold: false,
        record_hash: "1".repeat(64),
        ledger_head_hash: "1".repeat(64),
        signature: null,
        ...input,
      }),
    });

    expect(appended).toEqual(expect.objectContaining({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      artifact_sha256: evaluation.artifact_sha256,
    }));
  });
});

function graphResult(input: { status: "completed" | "blocked"; blocked_by?: string[] }): DojoGraphRunResult {
  return {
    ok: input.status === "completed",
    status: input.status,
    mode: "checkride",
    blocked_by: input.blocked_by ?? [],
    node_results: [
      {
        node_id: "action",
        kind: "Action",
        status: input.status === "completed" ? "completed" : "blocked",
        blocked_by: input.blocked_by ?? [],
        assertion_results: [],
        rollback_decision: {
          status: "not_required",
          strategy: "none",
          requires_human_review: false,
          blocked_by: [],
          checkpoints: [],
        },
      },
    ],
  };
}

function scenarioFixture(overrides: Partial<DojoScenario>): DojoScenario {
  const mutationKind = overrides.mutation_kind ?? "baseline";
  return {
    scenario_id: `seed-a_scenario_${mutationKind}`,
    title: "Synthetic scenario",
    layer: overrides.layer ?? "risk",
    simulator_tier: overrides.simulator_tier ?? 2,
    mutation_kind: mutationKind,
    expected_behavior: "Exercise the skill against a synthetic fixture.",
    risk_tags: overrides.risk_tags ?? [],
    generated_from: overrides.generated_from ?? "dojo_template",
  };
}
