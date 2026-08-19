import { canonicalJson, sha256Hex } from "../evidence/ledger_record.js";
import {
  validateDojoScenarioDefinition,
  type DojoScenarioDefinition,
  type DojoScenarioFixtureKind,
} from "./scenario_dsl.js";
import { DojoVivariumRunner, type DojoFixtureResetResult, type DojoMaterializedScenario } from "./runner.js";

const FIXTURE_KINDS = new Set<DojoScenarioFixtureKind>([
  "synthetic_dom_snapshot", "synthetic_page_route", "fake_api_server", "fake_database_state",
  "fake_auth_session", "fake_documents", "fake_approvals", "fake_validation_errors",
  "fake_latency", "fake_partial_failure",
]);

export interface FailureCapsuleVivariumManifest {
  schema_version: "synthi.dojo.failureCapsuleScenario.v1";
  scenario_id: string;
  capsule: { capsule_id: string; source_revision: string; world_hash: string; run_command: string[] };
  synthetic_fixture_requirements: Array<{ fixture_id: string; kind: string; synthetic_data_only: true; required: boolean }>;
  boundary_mocks: Array<{ kind?: string; validated?: boolean }>;
  reset_profile: { reset_profile_id: string; strategy: "deterministic_seed"; seed: string };
  oracle: { predicate: Record<string, unknown>; failure_signature: Record<string, unknown>; baseline: Record<string, unknown> };
  evidence: { capsule_id: string; scenario_id: string; source_revision: string; fixture_manifest_sha256: string; redaction: string };
  limits: string[];
}

export interface FailureCapsuleVivariumAdapterResult {
  ok: boolean;
  status: "ready_for_materialization" | "boundary_not_isolatable";
  scenario?: DojoScenarioDefinition;
  oracle_contract?: { predicate: Record<string, unknown>; failure_signature: Record<string, unknown>; baseline: Record<string, unknown>; contract_sha256: string };
  evidence: Record<string, unknown>;
  blocked_by: string[];
}

export interface FailureCapsuleVivariumMaterializationResult {
  ok: boolean;
  status: "ready_for_run" | "boundary_not_isolatable";
  scenario?: DojoScenarioDefinition;
  materialized?: DojoMaterializedScenario;
  reset?: DojoFixtureResetResult;
  oracle_contract?: FailureCapsuleVivariumAdapterResult["oracle_contract"];
  evidence: Record<string, unknown>;
  blocked_by: string[];
}

/** Validate a Distiller handoff and map it onto existing Vivarium scenario primitives. */
export function adaptFailureCapsuleToVivarium(input: unknown): FailureCapsuleVivariumAdapterResult {
  const manifest = input as Partial<FailureCapsuleVivariumManifest>;
  const blockedBy: string[] = [];
  if (manifest.schema_version !== "synthi.dojo.failureCapsuleScenario.v1") blockedBy.push("failure_capsule_schema_invalid");
  if (!manifest.capsule?.capsule_id || !manifest.scenario_id) blockedBy.push("failure_capsule_identity_missing");
  if (!manifest.reset_profile?.seed || !manifest.reset_profile.reset_profile_id) blockedBy.push("failure_capsule_reset_profile_missing");
  if (!Array.isArray(manifest.capsule?.run_command) || manifest.capsule.run_command.length === 0) blockedBy.push("failure_capsule_command_missing");
  if (!manifest.oracle?.predicate || !manifest.oracle.failure_signature || !manifest.oracle.baseline) blockedBy.push("failure_capsule_oracle_missing");
  if (!Array.isArray(manifest.limits) || !manifest.limits.some((limit) => limit.includes("original-world validation remains required"))) blockedBy.push("failure_capsule_original_validation_guard_missing");
  if ((manifest.boundary_mocks ?? []).some((mock) => mock.validated !== true)) blockedBy.push("failure_capsule_unvalidated_boundary_mock");
  const fixtures = manifest.synthetic_fixture_requirements ?? [];
  if (!fixtures.length) blockedBy.push("failure_capsule_fixture_missing");
  if (fixtures.some((fixture) => fixture.synthetic_data_only !== true || !FIXTURE_KINDS.has(fixture.kind as DojoScenarioFixtureKind))) blockedBy.push("failure_capsule_fixture_unsafe_or_unsupported");
  if (blockedBy.length) return { ok: false, status: "boundary_not_isolatable", evidence: evidenceFor(manifest), blocked_by: blockedBy };

  const signature = manifest.oracle!.failure_signature;
  const scenario: DojoScenarioDefinition = {
    schema_version: "synthi.dojo.scenarioDefinition.v1",
    scenario_id: manifest.scenario_id!,
    title: `Failure capsule ${manifest.capsule!.capsule_id}`,
    mutation_kind: "failure_capsule",
    mutation_scopes: ["data"],
    target_graph_node_ids: [],
    fixture_requirements: fixtures.map((fixture) => ({ ...fixture, kind: fixture.kind as DojoScenarioFixtureKind, mutation_scope: "data", production_data_refs: [] })),
    input_overrides: { failure_capsule_id: manifest.capsule!.capsule_id },
    expected_behavior: "Synthetic world must reproduce the original capsule predicate and failure signature before it can be used for practice or regression.",
    oracle: { oracle_id: `oracle_${manifest.scenario_id}`, kind: "evidence_claim", expected_outcome: "fail", observed_evidence_required: ["graph_run_result", "capsule_predicate_match", `capsule_signature:${sha256Hex(canonicalJson(signature))}`] },
    simulator_tier: 0,
    reset_profile: { ...manifest.reset_profile!, requires_evidence: true },
    budget: { max_runs: 1, max_estimated_ms: 1000, max_model_calls: 0 },
    provenance: { generated_from: "seed", risk_tags: ["failure_distiller", "synthetic_data_only"] },
  };
  const validation = validateDojoScenarioDefinition(scenario);
  if (!validation.ok) return { ok: false, status: "boundary_not_isolatable", evidence: evidenceFor(manifest), blocked_by: validation.issues.map((issue) => issue.issue_id) };
  const oracleContract = { ...manifest.oracle!, contract_sha256: sha256Hex(canonicalJson(manifest.oracle)) };
  return { ok: true, status: "ready_for_materialization", scenario, oracle_contract: oracleContract, evidence: evidenceFor(manifest), blocked_by: [] };
}

/**
 * Materialize a validated handoff with Vivarium's real fixture/reset runtime.
 * This deliberately stops before claiming the synthetic world has reproduced
 * the incident: callers must run it with observed predicate/signature evidence.
 */
export function materializeFailureCapsuleVivarium(input: unknown): FailureCapsuleVivariumMaterializationResult {
  const adapted = adaptFailureCapsuleToVivarium(input);
  if (!adapted.ok || !adapted.scenario) {
    return { ok: false, status: "boundary_not_isolatable", evidence: adapted.evidence, blocked_by: adapted.blocked_by };
  }
  try {
    const runner = new DojoVivariumRunner();
    const materialized = runner.materialize({
      skill_id: `failure_capsule_${String(adapted.evidence.capsule_id)}`,
      scenario: adapted.scenario,
      seed: adapted.scenario.reset_profile.seed,
    });
    const reset = runner.reset({ materialized });
    if (!reset.ok) {
      return {
        ok: false,
        status: "boundary_not_isolatable",
        scenario: adapted.scenario,
        materialized,
        reset,
        oracle_contract: adapted.oracle_contract,
        evidence: { ...adapted.evidence, fixture_materialization_hash: materialized.fixture.materialization_hash, oracle_result: "reset_not_deterministic" },
        blocked_by: reset.blocked_by,
      };
    }
    return {
      ok: true,
      status: "ready_for_run",
      scenario: adapted.scenario,
      materialized,
      reset,
      oracle_contract: adapted.oracle_contract,
      evidence: { ...adapted.evidence, fixture_materialization_hash: materialized.fixture.materialization_hash, oracle_result: "not_run" },
      blocked_by: [],
    };
  } catch (error) {
    return {
      ok: false,
      status: "boundary_not_isolatable",
      evidence: adapted.evidence,
      blocked_by: [error instanceof Error ? error.message : "failure_capsule_materialization_failed"],
    };
  }
}

function evidenceFor(manifest: Partial<FailureCapsuleVivariumManifest>): Record<string, unknown> {
  return {
    capsule_id: manifest.capsule?.capsule_id ?? "",
    scenario_id: manifest.scenario_id ?? "",
    source_revision: manifest.capsule?.source_revision ?? "",
    world_hash: manifest.capsule?.world_hash ?? "",
    fixture_manifest_sha256: manifest.evidence?.fixture_manifest_sha256 ?? "",
    redaction: manifest.evidence?.redaction ?? "",
  };
}
