import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEVERITY_POLICY,
  deriveUncertainty,
  EMBODIED_CONTRACT_VERSION,
  evaluateHardSeverity,
  parseEmbodiedContract,
  validateContractStep,
  type ContractEffect,
  type ContractStep,
} from "../../src/embodied/contract.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function effect(overrides: Partial<ContractEffect> = {}): ContractEffect {
  return {
    predicate: { predicate_id: "state.equals" },
    severity: "hard",
    uncertainty: { evidence: "fork_control", samples: 3, confidence: "high" },
    ...overrides,
  };
}

describe("severity policy", () => {
  it("allows well-evidenced hard effects", () => {
    expect(evaluateHardSeverity(effect(), false)).toEqual({ allowed: true });
  });

  it("refuses temporal-only effects without human confirmation", () => {
    const temporal = effect({
      uncertainty: { evidence: "temporal_only", samples: 9, confidence: "medium" },
    });
    expect(evaluateHardSeverity(temporal, false)).toEqual({
      allowed: false,
      refuse_because: expect.stringContaining("human confirmation"),
    });
    expect(evaluateHardSeverity(temporal, true)).toEqual({ allowed: true });
  });

  it("refuses low-confidence effects even with human confirmation", () => {
    const weak = effect({
      uncertainty: { evidence: "temporal_only", samples: 9, confidence: "low" },
    });
    expect(evaluateHardSeverity(weak, true)).toEqual({
      allowed: false,
      refuse_because: expect.stringContaining("low-confidence"),
    });
  });

  it("refuses truncated evidence regardless of confirmation", () => {
    const truncated = effect({
      uncertainty: { evidence: "fork_control", samples: 5, truncated: true, confidence: "high" },
    });
    expect(evaluateHardSeverity(truncated, true)).toEqual({
      allowed: false,
      refuse_because: expect.stringContaining("truncated"),
    });
  });

  it("enforces the sample floor", () => {
    const thin = effect({
      uncertainty: { evidence: "multi_demo_vote", samples: 1, confidence: "medium" },
    });
    expect(evaluateHardSeverity(thin, true)).toEqual({
      allowed: false,
      refuse_because: expect.stringContaining("insufficient"),
    });
  });

  it("optional severity is always allowed", () => {
    const optional = effect({ severity: "optional", uncertainty: deriveUncertainty("temporal_only", 1, true) });
    expect(evaluateHardSeverity(optional, false)).toEqual({ allowed: true });
  });

  it("policy can be tightened but not used to bypass evidence limits", () => {
    const truncated = effect({
      uncertainty: { evidence: "fork_control", samples: 5, truncated: true, confidence: "high" },
    });
    expect(
      evaluateHardSeverity(truncated, true, { ...DEFAULT_SEVERITY_POLICY, allow_truncated_hard: true }),
    ).toEqual({ allowed: true });
    expect(
      evaluateHardSeverity(effect(), true, { ...DEFAULT_SEVERITY_POLICY, min_samples_for_hard: 10 }),
    ).toEqual({
      allowed: false,
      refuse_because: expect.stringContaining("insufficient"),
    });
  });
});

describe("uncertainty derivation", () => {
  it("maps evidence quality to confidence deterministically", () => {
    expect(deriveUncertainty("fork_control", 2, false).confidence).toBe("high");
    expect(deriveUncertainty("fork_control", 2, true).confidence).toBe("medium");
    expect(deriveUncertainty("multi_demo_vote", 3, false).confidence).toBe("high");
    expect(deriveUncertainty("multi_demo_vote", 2, false).confidence).toBe("medium");
    expect(deriveUncertainty("multi_demo_vote", 1, true).confidence).toBe("low");
    expect(deriveUncertainty("temporal_only", 99, false).confidence).toBe("low");
  });

  it("keeps truncation visible in the annotation", () => {
    expect(deriveUncertainty("fork_control", 2, true).truncated).toBe(true);
    expect("truncated" in deriveUncertainty("fork_control", 2, false)).toBe(false);
  });
});

function validStep(overrides: Partial<ContractStep> = {}): ContractStep {
  return {
    step_id: "s1",
    intent: "persist the change",
    substrate_kind: "terminal",
    preconditions: [{ predicate: { predicate_id: "state.present" } }],
    action: { kind: "exec", primitive_class: "discrete" },
    expected_effects: [effect()],
    tolerated_variants: [],
    hard_failures: [],
    ...overrides,
  };
}

describe("step validation", () => {
  it("accepts a valid step", () => {
    expect(validateContractStep(validStep())).toEqual([]);
  });

  it("rejects malformed identity and structure", () => {
    const problems = validateContractStep(
      validStep({
        step_id: "",
        intent: "",
        preconditions: [{ predicate: { predicate_id: "" } }],
        action: { kind: "turn", primitive_class: "continuous" },
        expected_effects: [
          {
            predicate: { predicate_id: "x" },
            severity: "hard",
            uncertainty: { evidence: "temporal_only", samples: 1, confidence: "low" },
          },
        ],
        tolerated_variants: "none" as never,
        data_bindings: { k: "bogus" as never },
      }),
    );
    const texts = problems.map((p) => `${p.path}: ${p.problem}`).join("\n");
    expect(texts).toContain("step_id");
    expect(texts).toContain("intent");
    expect(texts).toContain("predicate_id");
    expect(texts).toContain("continuous action missing quantization");
    expect(texts).toContain("human confirmation");
    expect(texts).toContain("must be an array");
    expect(texts).toContain("invalid binding kind");
  });

  it("propagates severity refusals through validation", () => {
    const problems = validateContractStep(
      validStep({
        expected_effects: [
          // temporal-only without confirmation:
          effect({ uncertainty: { evidence: "temporal_only", samples: 4, confidence: "medium" } }),
          // separately, a low-confidence effect:
          effect({
            predicate: { predicate_id: "state.other" },
            uncertainty: { evidence: "multi_demo_vote", samples: 4, confidence: "low" },
          }),
        ],
      }),
    );
    expect(problems.some((p) => p.problem.includes("human confirmation"))).toBe(true);
    expect(problems.some((p) => p.problem.includes("low-confidence"))).toBe(true);
  });
});

describe("contract parse round-trip", () => {
  it("parses valid contracts and preserves unknown fields", () => {
    const serialized = {
      embodied_contract_version: EMBODIED_CONTRACT_VERSION,
      contract_id: "c-1",
      realm_scopes: [{ realm_kind: "origin", realm_id: "https://x.example" }],
      steps: [validStep()],
      totally_new_field: { nested: [1, 2, 3] },
    };
    const parsed = parseEmbodiedContract(serialized);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.contract.totally_new_field).toEqual({ nested: [1, 2, 3] });
      expect(JSON.parse(JSON.stringify(parsed.contract))).toEqual(serialized);
    }
  });

  it("rejects invalid contracts with structured problems", () => {
    const parsed = parseEmbodiedContract({
      embodied_contract_version: 999,
      contract_id: "",
      realm_scopes: "none",
      steps: [{ step_id: "" }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const texts = parsed.problems.map((p) => `${p.path}: ${p.problem}`).join("\n");
      expect(texts).toContain("embodied_contract_version");
      expect(texts).toContain("contract_id");
      expect(texts).toContain("realm_scopes");
      expect(texts).toContain("intent");
    }
  });
});

describe("contract boundary", () => {
  it("imports no adapter modules and contains no scenario nouns", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/embodied/contract.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+"\.\.\/browser\//);
    expect(source).not.toMatch(/from\s+"\.\.\/dojo\//);
    for (const noun of ["door", "purple", "nginx", "toast", "playwright", "xpath"]) {
      expect(source.toLowerCase()).not.toContain(noun);
    }
  });
});
