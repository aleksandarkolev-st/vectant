import type { DojoScenario } from "../../browser/dojo.js";
import { isPromptInjectionDocumentMutation } from "./mutations.js";

export type DojoScenarioExpectedOutcome = "pass" | "fail" | "block" | "needs_human";
export type DojoScenarioMutationScope = "ui" | "data" | "api" | "identity" | "policy" | "document" | "route";
export type DojoScenarioFixtureKind =
  | "synthetic_dom_snapshot"
  | "synthetic_page_route"
  | "fake_api_server"
  | "fake_database_state"
  | "fake_auth_session"
  | "fake_documents"
  | "fake_approvals"
  | "fake_validation_errors"
  | "fake_latency"
  | "fake_partial_failure";

export interface DojoScenarioFixtureRequirement {
  fixture_id: string;
  kind: DojoScenarioFixtureKind;
  synthetic_data_only: true;
  required: boolean;
  mutation_scope: DojoScenarioMutationScope;
  production_data_refs: string[];
}

export interface DojoScenarioOracleDefinition {
  oracle_id: string;
  kind: "postcondition" | "expected_block" | "state_delta" | "evidence_claim" | "human_review";
  expected_outcome: DojoScenarioExpectedOutcome;
  observed_evidence_required: string[];
}

export interface DojoScenarioResetProfile {
  reset_profile_id: string;
  strategy: "no_state" | "deterministic_seed" | "fixture_restore";
  seed: string;
  requires_evidence: boolean;
}

export interface DojoScenarioBudget {
  max_runs: number;
  max_estimated_ms: number;
  max_model_calls: number;
}

export interface DojoScenarioDefinition {
  schema_version: "synthi.dojo.scenarioDefinition.v1";
  scenario_id: string;
  title: string;
  mutation_kind: string;
  mutation_scopes: DojoScenarioMutationScope[];
  target_graph_node_ids: string[];
  fixture_requirements: DojoScenarioFixtureRequirement[];
  input_overrides: Record<string, unknown>;
  expected_behavior: string;
  oracle: DojoScenarioOracleDefinition;
  simulator_tier: number;
  reset_profile: DojoScenarioResetProfile;
  budget: DojoScenarioBudget;
  provenance: {
    generated_from: DojoScenario["generated_from"];
    risk_tags: string[];
  };
}

export interface DojoScenarioDefinitionValidationIssue {
  issue_id: string;
  severity: "error" | "warning";
  message: string;
}

export interface DojoScenarioDefinitionValidation {
  ok: boolean;
  issues: DojoScenarioDefinitionValidationIssue[];
}

export function toDojoScenarioDefinitions(
  scenarios: DojoScenario[],
  input: {
    target_graph_node_ids?: string[];
    input_overrides?: Record<string, unknown>;
  } = {}
): DojoScenarioDefinition[] {
  return scenarios.map((scenario) => toDojoScenarioDefinition(scenario, input));
}

export function toDojoScenarioDefinition(
  scenario: DojoScenario,
  input: {
    target_graph_node_ids?: string[];
    input_overrides?: Record<string, unknown>;
  } = {}
): DojoScenarioDefinition {
  const mutationScopes = mutationScopesFor(scenario.mutation_kind);
  return {
    schema_version: "synthi.dojo.scenarioDefinition.v1",
    scenario_id: scenario.scenario_id,
    title: scenario.title,
    mutation_kind: scenario.mutation_kind,
    mutation_scopes: mutationScopes,
    target_graph_node_ids: input.target_graph_node_ids ?? [],
    fixture_requirements: fixtureRequirementsForScenario(scenario, mutationScopes),
    input_overrides: input.input_overrides ?? {},
    expected_behavior: scenario.expected_behavior,
    oracle: oracleForScenario(scenario),
    simulator_tier: scenario.simulator_tier,
    reset_profile: {
      reset_profile_id: `reset_${scenario.scenario_id}`,
      strategy: scenario.mutation_kind === "baseline" ? "no_state" : "deterministic_seed",
      seed: scenario.scenario_id,
      requires_evidence: scenario.mutation_kind !== "baseline",
    },
    budget: {
      max_runs: 1,
      max_estimated_ms: 50 + scenario.simulator_tier * 25,
      max_model_calls: 0,
    },
    provenance: {
      generated_from: scenario.generated_from,
      risk_tags: [...scenario.risk_tags],
    },
  };
}

export function validateDojoScenarioDefinition(
  definition: DojoScenarioDefinition
): DojoScenarioDefinitionValidation {
  const issues: DojoScenarioDefinitionValidationIssue[] = [];
  if (definition.schema_version !== "synthi.dojo.scenarioDefinition.v1") {
    issues.push(errorIssue("scenario_schema_version_invalid", "Scenario definition has an unsupported schema version."));
  }
  if (!definition.scenario_id.trim()) {
    issues.push(errorIssue("scenario_id_required", "Scenario definition is missing scenario_id."));
  }
  if (!definition.mutation_kind.trim()) {
    issues.push(errorIssue("scenario_mutation_kind_required", "Scenario definition is missing mutation_kind."));
  }
  if (!definition.oracle?.oracle_id || !definition.oracle.observed_evidence_required?.length) {
    issues.push(errorIssue("scenario_oracle_required", "Scenario definition requires an oracle and observed evidence requirements."));
  }
  if (!definition.reset_profile?.reset_profile_id || !definition.reset_profile.seed) {
    issues.push(errorIssue("scenario_reset_profile_required", "Scenario definition requires a deterministic reset profile."));
  }
  if (definition.fixture_requirements.length === 0) {
    issues.push(errorIssue("scenario_fixture_required", "Scenario definition requires at least one synthetic fixture requirement."));
  }
  for (const fixture of definition.fixture_requirements) {
    if (fixture.synthetic_data_only !== true) {
      issues.push(errorIssue("scenario_fixture_synthetic_only_required", `Fixture ${fixture.fixture_id} must be synthetic-only.`));
    }
    if (fixture.production_data_refs.length > 0) {
      issues.push(errorIssue("scenario_fixture_production_data_ref_forbidden", `Fixture ${fixture.fixture_id} contains production data refs.`));
    }
  }
  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    issues,
  };
}

function fixtureRequirementsForScenario(
  scenario: DojoScenario,
  mutationScopes: DojoScenarioMutationScope[]
): DojoScenarioFixtureRequirement[] {
  const kinds = fixtureKindsFor(scenario.mutation_kind);
  return kinds.map((kind, index) => ({
    fixture_id: `${scenario.scenario_id}_fixture_${index + 1}_${kind}`,
    kind,
    synthetic_data_only: true,
    required: true,
    mutation_scope: mutationScopes[index] ?? mutationScopes[0] ?? "data",
    production_data_refs: [],
  }));
}

function fixtureKindsFor(mutationKind: string): DojoScenarioFixtureKind[] {
  switch (mutationKind) {
    case "baseline":
      return ["synthetic_dom_snapshot", "fake_database_state"];
    case "input_omission":
    case "hidden_required_field":
      return ["synthetic_dom_snapshot", "fake_validation_errors"];
    case "missing_document_field":
    case "corrupted_document":
      return ["fake_documents", "synthetic_dom_snapshot"];
    case "duplicate_entity":
    case "stale_entity":
    case "reordered_rows":
      return ["fake_database_state", "synthetic_dom_snapshot"];
    case "label_change":
    case "duplicate_label":
    case "hydration_delay":
    case "viewport_mobile":
    case "reduced_motion":
    case "feature_flag":
    case "destructive_adjacency":
      return ["synthetic_dom_snapshot"];
    case "network_latency":
      return ["fake_api_server", "fake_latency"];
    case "fake_success":
      return ["synthetic_dom_snapshot", "fake_api_server", "fake_database_state"];
    case "validation_error":
      return ["fake_api_server", "fake_validation_errors"];
    case "auth_expiry":
    case "permission_change":
      return ["fake_auth_session", "fake_approvals"];
    case "route_change":
      return ["synthetic_page_route"];
    case "partial_write":
      return ["fake_api_server", "fake_partial_failure", "fake_database_state"];
    default:
      return isPromptInjectionDocumentMutation(mutationKind)
        ? ["fake_documents", "synthetic_dom_snapshot"]
        : ["synthetic_dom_snapshot", "fake_database_state"];
  }
}

function mutationScopesFor(mutationKind: string): DojoScenarioMutationScope[] {
  switch (mutationKind) {
    case "duplicate_entity":
    case "stale_entity":
    case "reordered_rows":
      return ["data", "ui"];
    case "network_latency":
    case "fake_success":
    case "validation_error":
    case "partial_write":
      return ["api", "data"];
    case "auth_expiry":
    case "permission_change":
      return ["identity", "policy"];
    case "route_change":
      return ["route"];
    case "input_omission":
    case "hidden_required_field":
      return ["ui", "data"];
    case "missing_document_field":
    case "corrupted_document":
      return ["document", "ui"];
    default:
      return isPromptInjectionDocumentMutation(mutationKind) ? ["document", "ui"] : ["ui"];
  }
}

function oracleForScenario(scenario: DojoScenario): DojoScenarioOracleDefinition {
  const expectedOutcome = expectedOutcomeFor(scenario);
  return {
    oracle_id: `oracle_${scenario.scenario_id}`,
    kind: expectedOutcome === "block" ? "expected_block" : scenario.risk_tags.includes("evidence_required") ? "evidence_claim" : "postcondition",
    expected_outcome: expectedOutcome,
    observed_evidence_required: observedEvidenceFor(scenario),
  };
}

function expectedOutcomeFor(scenario: DojoScenario): DojoScenarioExpectedOutcome {
  if (scenario.layer === "knowledge") return "block";
  if (scenario.risk_tags.some((tag) => tag === "auth_expired" || tag === "permission_change" || tag === "destructive_write")) return "block";
  if (scenario.risk_tags.some((tag) => tag === "fake_success" || tag === "partial_failure")) return "fail";
  return "pass";
}

function observedEvidenceFor(scenario: DojoScenario): string[] {
  const evidence = ["graph_run_result", "graph_node_evidence", "oracle_result"];
  if (scenario.risk_tags.includes("evidence_required")) evidence.push("durable_state_evidence");
  if (scenario.mutation_kind === "auth_expiry" || scenario.mutation_kind === "permission_change") evidence.push("identity_policy_state");
  if (scenario.mutation_kind === "duplicate_entity" || scenario.mutation_kind === "stale_entity") evidence.push("stable_entity_identity");
  if (isPromptInjectionDocumentMutation(scenario.mutation_kind)) evidence.push("document_instruction_quarantine");
  if (scenario.mutation_kind === "missing_document_field" || scenario.mutation_kind === "corrupted_document") evidence.push("document_tissue_state");
  return evidence;
}

function errorIssue(issueId: string, message: string): DojoScenarioDefinitionValidationIssue {
  return { issue_id: issueId, severity: "error", message };
}
