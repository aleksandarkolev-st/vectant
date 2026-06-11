import { createHash } from "node:crypto";
import type { DojoScenarioDefinition } from "./scenario_dsl.js";
import { validateDojoScenarioDefinition } from "./scenario_dsl.js";

export interface DojoSyntheticEntityRecord {
  stable_id: string;
  display_name: string;
  version: number;
  stale: boolean;
  fields: Record<string, unknown>;
}

export interface DojoMaterializedFixture {
  schema_version: "synthi.dojo.materializedFixture.v1";
  fixture_id: string;
  scenario_id: string;
  mutation_kind: string;
  synthetic_data_only: true;
  seed: string;
  materialization_hash: string;
  source_definition_hash: string;
  records: DojoSyntheticEntityRecord[];
  missing_fields: string[];
  threshold_breaches: Array<{ field: string; value: number; threshold: number }>;
  ui_state: {
    labels: string[];
    hidden_fields: string[];
    duplicate_labels: string[];
    route: string;
  };
  api_state: {
    latency_ms: number;
    partial_write: boolean;
    fake_success: boolean;
    validation_error: boolean;
  };
  identity_state: {
    role: string;
    auth_expired: boolean;
    permission_downgraded: boolean;
  };
  reset_evidence: {
    reset_profile_id: string;
    deterministic: true;
    reset_seed: string;
  };
}

export function materializeDojoSyntheticFixture(
  definition: DojoScenarioDefinition,
  input: { seed?: string } = {}
): DojoMaterializedFixture {
  assertMaterializable(definition);
  const seed = input.seed ?? definition.reset_profile.seed;
  const sourceDefinitionHash = sha256(canonicalJson(definition));
  const fixtureWithoutHash = fixtureFor(definition, seed, sourceDefinitionHash);
  return {
    ...fixtureWithoutHash,
    materialization_hash: sha256(canonicalJson(fixtureWithoutHash)),
  };
}

export function assertMaterializable(definition: DojoScenarioDefinition): void {
  const validation = validateDojoScenarioDefinition(definition);
  if (!validation.ok) {
    throw new Error(`dojo_scenario_definition_invalid:${validation.issues.map((issue) => issue.issue_id).join(",")}`);
  }
  const productionDataFixtures = definition.fixture_requirements.filter((fixture) => fixture.production_data_refs.length > 0);
  if (productionDataFixtures.length > 0) {
    throw new Error(`dojo_fixture_production_data_ref_forbidden:${productionDataFixtures.map((fixture) => fixture.fixture_id).join(",")}`);
  }
  const nonSyntheticFixtures = definition.fixture_requirements.filter((fixture) => fixture.synthetic_data_only !== true);
  if (nonSyntheticFixtures.length > 0) {
    throw new Error(`dojo_fixture_not_synthetic:${nonSyntheticFixtures.map((fixture) => fixture.fixture_id).join(",")}`);
  }
}

function fixtureFor(
  definition: DojoScenarioDefinition,
  seed: string,
  sourceDefinitionHash: string
): Omit<DojoMaterializedFixture, "materialization_hash"> & { materialization_hash: "" } {
  const records = recordsFor(definition, seed);
  const missingFields = missingFieldsFor(definition);
  const thresholdBreaches = thresholdBreachesFor(definition);
  return {
    schema_version: "synthi.dojo.materializedFixture.v1",
    fixture_id: `fixture_${definition.scenario_id}_${shortHash(seed)}`,
    scenario_id: definition.scenario_id,
    mutation_kind: definition.mutation_kind,
    synthetic_data_only: true,
    seed,
    materialization_hash: "",
    source_definition_hash: sourceDefinitionHash,
    records,
    missing_fields: missingFields,
    threshold_breaches: thresholdBreaches,
    ui_state: {
      labels: labelsFor(definition),
      hidden_fields: definition.mutation_kind === "hidden_required_field" ? missingFields : [],
      duplicate_labels: definition.mutation_kind === "duplicate_label" ? ["Submit", "Submit"] : [],
      route: definition.mutation_kind === "route_change" ? "/synthetic/unexpected-route" : "/synthetic/workspace",
    },
    api_state: {
      latency_ms: definition.mutation_kind === "network_latency" ? Math.min(definition.budget.max_estimated_ms, 750) : 0,
      partial_write: definition.mutation_kind === "partial_write",
      fake_success: definition.mutation_kind === "fake_success",
      validation_error: definition.mutation_kind === "validation_error",
    },
    identity_state: {
      role: definition.mutation_kind === "permission_change" ? "viewer" : "editor",
      auth_expired: definition.mutation_kind === "auth_expiry",
      permission_downgraded: definition.mutation_kind === "permission_change",
    },
    reset_evidence: {
      reset_profile_id: definition.reset_profile.reset_profile_id,
      deterministic: true,
      reset_seed: seed,
    },
  };
}

function recordsFor(definition: DojoScenarioDefinition, seed: string): DojoSyntheticEntityRecord[] {
  const baseName = syntheticNameFor(seed);
  if (definition.mutation_kind === "duplicate_entity") {
    return [
      entityRecord(`${seed}:entity:1`, baseName, { disambiguator: "A" }),
      entityRecord(`${seed}:entity:2`, baseName, { disambiguator: "B" }),
    ];
  }
  if (definition.mutation_kind === "stale_entity") {
    return [
      entityRecord(`${seed}:entity:intended`, baseName, { intended: true }),
      { ...entityRecord(`${seed}:entity:stale`, baseName, { intended: false }), stale: true, version: 1 },
    ];
  }
  return [entityRecord(`${seed}:entity:1`, baseName, { intended: true })];
}

function entityRecord(seed: string, displayName: string, fields: Record<string, unknown>): DojoSyntheticEntityRecord {
  return {
    stable_id: `synthetic_${shortHash(seed)}`,
    display_name: displayName,
    version: 2,
    stale: false,
    fields,
  };
}

function missingFieldsFor(definition: DojoScenarioDefinition): string[] {
  if (definition.mutation_kind === "input_omission") return Object.keys(definition.input_overrides).slice(0, 1);
  if (definition.mutation_kind === "hidden_required_field") return ["synthetic_required_field"];
  return [];
}

function thresholdBreachesFor(definition: DojoScenarioDefinition): Array<{ field: string; value: number; threshold: number }> {
  if (definition.mutation_kind !== "threshold_breach") return [];
  return [{ field: "amount", value: 501, threshold: 500 }];
}

function labelsFor(definition: DojoScenarioDefinition): string[] {
  if (definition.mutation_kind === "label_change") return ["Synthetic changed label"];
  if (definition.mutation_kind === "duplicate_label") return ["Submit", "Submit"];
  return ["Synthetic action"];
}

function syntheticNameFor(seed: string): string {
  return `Synthetic ${shortHash(seed).slice(0, 8)}`;
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 12);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)])
  );
}
