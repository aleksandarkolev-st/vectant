import { describe, expect, it } from "vitest";
import {
  blindSpotsOf,
  CORE_SEMANTIC_TYPE_WEIGHTS,
  effectiveSemanticWeight,
  resolveSemanticClass,
  validateWorldStateSchema,
  type WorldStateSchema,
} from "../../src/embodied/world_state.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function validSchema(overrides: Partial<WorldStateSchema> = {}): WorldStateSchema {
  return {
    schema_id: "toy.world",
    schema_version: "1.0.0",
    value_types: [
      { path_pattern: "entities.*.kind", type: { kind: "enum", values: ["a", "b", "c"] }, semantic_class: "identity" },
      { path_pattern: "entities.*.state", type: { kind: "enum", values: ["idle", "active"] }, semantic_class: "state_flag" },
      { path_pattern: "entities.*.position", type: { kind: "band", min: 0, max: 100, unit: "m" }, semantic_class: "transform" },
      { path_pattern: "clock.tick", type: { kind: "number", bounds: { min: 0 } }, semantic_class: "ambient" },
    ],
    identity: {
      id_scheme: "session",
      survives: [],
      reidentification_rule: "match by declared stable attributes",
    },
    observability: {
      fully_observable: false,
      hidden_state: ["server authority state"],
      policy: "best_effort",
    },
    ...overrides,
  };
}

describe("schema validation", () => {
  it("accepts a valid schema", () => {
    expect(validateWorldStateSchema(validSchema())).toEqual([]);
  });

  it("rejects malformed versioning and identity with precise reasons", () => {
    const problems = validateWorldStateSchema(
      validSchema({
        schema_id: "",
        schema_version: "1",
        identity: { id_scheme: "session", survives: [] },
      }),
    );
    const texts = problems.map((p) => `${p.path}: ${p.problem}`).join("\n");
    expect(texts).toContain("schema_id");
    expect(texts).toContain("semver");
    expect(texts).toContain("reidentification_rule");
  });

  it("rejects unknown survival classes and bad value types", () => {
    const problems = validateWorldStateSchema(
      validSchema({
        identity: { id_scheme: "stable", survives: ["multiverse" as never] },
        value_types: [
          { path_pattern: "x", type: { kind: "band", min: 5, max: 5 } },
          { path_pattern: "y", type: { kind: "enum", values: [] } },
          { path_pattern: "z", type: { kind: "wat" as never } as never },
        ],
      }),
    );
    const texts = problems.map((p) => `${p.path}: ${p.problem}`).join("\n");
    expect(texts).toContain('unknown survival class "multiverse"');
    expect(texts).toContain("band min must be below max");
    expect(texts).toContain("non-empty values array");
    expect(texts).toContain("unknown value type kind");
  });

  it("rejects contradictory observability declarations", () => {
    const contradictions = validateWorldStateSchema(
      validSchema({
        observability: { fully_observable: true, hidden_state: ["secret"], policy: "full" },
      }),
    );
    expect(contradictions.some((p) => p.problem.includes("contradicts declared hidden state"))).toBe(true);

    const policyMismatch = validateWorldStateSchema(
      validSchema({
        observability: { fully_observable: false, hidden_state: [], policy: "full" },
      }),
    );
    expect(
      policyMismatch.some((p) => p.problem.includes('policy "full" requires fully_observable=true')),
    ).toBe(true);
  });

  it("requires discovery confidence for discovered declarations", () => {
    const problems = validateWorldStateSchema(
      validSchema({
        value_types: [{ path_pattern: "x", type: { kind: "boolean" }, discovered: true }],
      }),
    );
    expect(problems.some((p) => p.path.includes("discovery_confidence"))).toBe(true);
  });

  it("rejects duplicate path patterns", () => {
    const problems = validateWorldStateSchema(
      validSchema({
        value_types: [
          { path_pattern: "a.b", type: { kind: "boolean" } },
          { path_pattern: "a.b", type: { kind: "boolean" } },
        ],
      }),
    );
    expect(problems.some((p) => p.problem.includes("duplicate"))).toBe(true);
  });
});

describe("core weight scale is override-proof", () => {
  it("rejects extensions that shadow core classes", () => {
    const problems = validateWorldStateSchema(
      validSchema({ semantic_type_extension: { material: 1 } }),
    );
    expect(problems.some((p) => p.problem.includes("cannot be overridden or reordered"))).toBe(true);
  });

  it("bounds extension weights to [0,1]", () => {
    const problems = validateWorldStateSchema(
      validSchema({ semantic_type_extension: { exotic_class: 7 } }),
    );
    expect(problems.some((p) => p.path.includes("exotic_class"))).toBe(true);
  });

  it("accepts genuine extensions and resolves them at runtime", () => {
    const schema = validSchema({ semantic_type_extension: { exotic_class: 0.85 } });
    expect(validateWorldStateSchema(schema)).toEqual([]);
    expect(effectiveSemanticWeight(schema, "exotic_class")).toBe(0.85);
    // Core scale untouched:
    expect(effectiveSemanticWeight(schema, "material")).toBe(CORE_SEMANTIC_TYPE_WEIGHTS.material);
    // Unknown classes sink below everything declared:
    expect(effectiveSemanticWeight(schema, "undeclared")).toBeLessThan(
      CORE_SEMANTIC_TYPE_WEIGHTS.cosmetic_transient,
    );
  });
});

describe("semantic class resolution", () => {
  const schema = validSchema();

  it("resolves exact and wildcard paths", () => {
    expect(resolveSemanticClass(schema, "entities.e1.kind")).toBe("identity");
    expect(resolveSemanticClass(schema, "entities.anything.state")).toBe("state_flag");
    expect(resolveSemanticClass(schema, "clock.tick")).toBe("ambient");
  });

  it("marks unmatched paths undeclared", () => {
    expect(resolveSemanticClass(schema, "nothing.here")).toBe("undeclared");
  });
});

describe("blind spots", () => {
  it("contracts inherit declared hidden state verbatim", () => {
    expect(blindSpotsOf(validSchema())).toEqual(["server authority state"]);
    expect(
      blindSpotsOf(validSchema({ observability: { fully_observable: true, hidden_state: [], policy: "full" } })),
    ).toEqual([]);
  });
});

describe("world_state boundary", () => {
  it("imports no adapter modules and contains no scenario nouns", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/embodied/world_state.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+"\.\.\/browser\//);
    expect(source).not.toMatch(/from\s+"\.\.\/dojo\//);
    for (const noun of ["door", "purple", "nginx", "toast"]) {
      expect(source.toLowerCase()).not.toContain(noun);
    }
  });
});
