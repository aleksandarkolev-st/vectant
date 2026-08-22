import { beforeEach, describe, expect, it } from "vitest";
import {
  allBrowserV7Members,
  classifyFromEvidence,
  FAILURE_TRUNK_CLASSES,
  fromBrowserFailureClass,
  lookupSubstrateClass,
  registerSubstrateClasses,
  resetSubstrateClassRegistries,
  SubstrateClassCollisionError,
  type SubstrateFailureClass,
} from "../../src/embodied/classifier.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("trunk class inventory", () => {
  it("exposes a closed set of trunk classes", () => {
    expect(FAILURE_TRUNK_CLASSES).toContain("perception_drift");
    expect(FAILURE_TRUNK_CLASSES).toContain("unknown");
    expect(new Set(FAILURE_TRUNK_CLASSES).size).toBe(FAILURE_TRUNK_CLASSES.length);
  });
});

describe("total mapping from legacy browser failure classes", () => {
  it("maps every V7 member to a valid trunk", () => {
    for (const member of allBrowserV7Members()) {
      const mapped = fromBrowserFailureClass(member);
      expect(FAILURE_TRUNK_CLASSES).toContain(mapped.trunk);
      if (mapped.sub) {
        expect(mapped.sub.startsWith("browser.")).toBe(true);
      }
    }
  });

  it("keeps the semantic intent of key members", () => {
    expect(fromBrowserFailureClass("locatorDrift")).toEqual({
      trunk: "perception_drift",
      sub: "browser.locatorDrift",
    });
    expect(fromBrowserFailureClass("originConsentMissing").trunk).toBe("consent_missing");
    expect(fromBrowserFailureClass("routeChanged").trunk).toBe("world_changed");
    expect(fromBrowserFailureClass("hydrationDelay").trunk).toBe("load_delay");
    expect(fromBrowserFailureClass("sourceIdentityMissing").trunk).toBe("identity_lost");
    expect(fromBrowserFailureClass("closedShadowDomBlocked").trunk).toBe("substrate_limitation");
    expect(fromBrowserFailureClass("unknown")).toEqual({ trunk: "unknown" });
  });
});

describe("substrate subclass registry", () => {
  beforeEach(() => {
    resetSubstrateClassRegistries();
  });

  const GAME_CLASSES: SubstrateFailureClass[] = [
    { id: "game.entity_not_found", trunk: "identity_lost" },
    { id: "game.physics_blocked", trunk: "unsafe_environment" },
    { id: "game.tick_rate_variance", trunk: "load_delay" },
  ];

  it("registers and resolves namespaced classes", () => {
    registerSubstrateClasses("game", GAME_CLASSES);
    expect(lookupSubstrateClass("game", "game.entity_not_found")?.trunk).toBe("identity_lost");
    expect(lookupSubstrateClass("game", "game.physics_blocked")?.trunk).toBe("unsafe_environment");
  });

  it("rejects ids that are not properly namespaced", () => {
    expect(() =>
      registerSubstrateClasses("game", [{ id: "terminal.exit_code", trunk: "app_validation_error" }]),
    ).toThrow(SubstrateClassCollisionError);
  });

  it("rejects duplicate ids with conflicting definitions", () => {
    registerSubstrateClasses("game", [{ id: "game.entity_not_found", trunk: "identity_lost" }]);
    expect(() =>
      registerSubstrateClasses("game", [
        { id: "game.entity_not_found", trunk: "world_changed" },
      ]),
    ).toThrow(SubstrateClassCollisionError);
  });

  it("allows identical re-registration as a no-op", () => {
    const classes = [{ id: "game.entity_not_found", trunk: "identity_lost" }] as const;
    registerSubstrateClasses("game", [...classes]);
    registerSubstrateClasses("game", [...classes]);
    expect(lookupSubstrateClass("game", "game.entity_not_found")?.trunk).toBe("identity_lost");
  });

  it("isolates namespaces and degrades unregistered lookups to undefined", () => {
    registerSubstrateClasses("game", GAME_CLASSES);
    expect(lookupSubstrateClass("terminal", "game.entity_not_found")).toBeUndefined();
    expect(lookupSubstrateClass("nowhere", "anything.at_all")).toBeUndefined();
  });

  it("rejects subclasses pointing at unknown trunks", () => {
    expect(() =>
      registerSubstrateClasses("weird", [
        { id: "weird.thing", trunk: "not_a_trunk" as never },
      ]),
    ).toThrow(SubstrateClassCollisionError);
  });
});

describe("evidence-shaped classification", () => {
  it("reports authority problems before perceptual ones by construction", () => {
    // A realm gate always yields consent_missing regardless of substrate detail.
    expect(classifyFromEvidence({ kind: "realm_gate", realm_approved: false, capability: "act" })).toEqual({
      trunk: "consent_missing",
    });
  });

  it("classifies each evidence kind deterministically", () => {
    expect(
      classifyFromEvidence({ kind: "lease", lease_active: false, mutating: true }).trunk,
    ).toBe("mutation_blocked");
    expect(
      classifyFromEvidence({ kind: "policy_block", reason: "irreversible" }).trunk,
    ).toBe("mutation_blocked");
    expect(classifyFromEvidence({ kind: "environment_state", safe_to_act: false }).trunk).toBe(
      "unsafe_environment",
    );
    expect(
      classifyFromEvidence({ kind: "identity_reidentification", matched: false, candidates_tried: 3 })
        .trunk,
    ).toBe("identity_lost");
    expect(
      classifyFromEvidence({ kind: "timing", waited_ms: 5000, budget_ms: 1000, settled: false }).trunk,
    ).toBe("load_delay");
    expect(classifyFromEvidence({ kind: "transport", attempts: 2, reachable: false }).trunk).toBe(
      "unsafe_environment",
    );
    expect(classifyFromEvidence({ kind: "transport", attempts: 0, reachable: false }).trunk).toBe(
      "network_failure",
    );
    expect(
      classifyFromEvidence({ kind: "app_rejection", validation_errors: 2, state_conflict: false })
        .trunk,
    ).toBe("app_validation_error");
    expect(
      classifyFromEvidence({ kind: "data_binding", missing_bindings: ["api_key"] }).trunk,
    ).toBe("test_data_missing");
    expect(classifyFromEvidence({ kind: "unclassified" })).toEqual({ trunk: "unknown" });
  });

  it("detects perception downgrade using tier order, not strings", () => {
    const decision = classifyFromEvidence({
      kind: "affordance_resolution",
      resolved: false,
      best_tier: "T4",
      previously_stable_tier: "T1",
    });
    expect(decision.trunk).toBe("perception_drift");

    const firstTime = classifyFromEvidence({
      kind: "affordance_resolution",
      resolved: false,
      best_tier: "T4",
    });
    expect(firstTime.trunk).toBe("perception_drift");
  });

  it("never inspects raw error text (input is structured)", () => {
    // The function signature only accepts ClassificationEvidence; a string is
    // a type error. Runtime guard for JS callers:
    expect(() => classifyFromEvidence("connection refused" as never)).toThrow();
  });
});

describe("classifier boundary", () => {
  it("imports no adapter modules and contains no scenario nouns", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/embodied/classifier.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+"\.\.\/browser\//);
    expect(source).not.toMatch(/from\s+"\.\.\/dojo\//);
    for (const noun of ["door", "purple", "nginx", "toast", "xpath"]) {
      expect(source.toLowerCase()).not.toContain(noun);
    }
  });
});
