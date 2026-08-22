import { describe, expect, it } from "vitest";
import {
  affordanceAfterRealityChange,
  AFFORDANCE_RANK,
  bestTier,
  tierAtLeast,
} from "../../src/embodied/affordance.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("tier ordering", () => {
  it("orders strictly T0 < T1 < T2 < T3 < T4", () => {
    expect(AFFORDANCE_RANK.T0).toBeLessThan(AFFORDANCE_RANK.T1);
    expect(AFFORDANCE_RANK.T1).toBeLessThan(AFFORDANCE_RANK.T2);
    expect(AFFORDANCE_RANK.T2).toBeLessThan(AFFORDANCE_RANK.T3);
    expect(AFFORDANCE_RANK.T3).toBeLessThan(AFFORDANCE_RANK.T4);
  });

  it("evaluates floors and bests", () => {
    expect(tierAtLeast("T1", "T2")).toBe(true);
    expect(tierAtLeast("T3", "T2")).toBe(false);
    expect(bestTier(["T4", "T2", "T3"])).toBe("T2");
    expect(bestTier([])).toBeUndefined();
  });
});

describe("downgrade propagation across reality changes", () => {
  const stableIdentity = { survives: ["fork", "reset", "restart", "schema_major"] as const };
  const sessionIdentity = { survives: ["fork"] as const };

  it("keeps structural tiers when identity survives", () => {
    for (const change of ["fork", "reset", "restart", "schema_major"] as const) {
      const decision = affordanceAfterRealityChange("T2", change, stableIdentity);
      expect(decision).toEqual({ effective_tier: "T2", degraded_below_structural: false });
    }
  });

  it("degrades structural tiers when identity does not survive, with reason", () => {
    const decision = affordanceAfterRealityChange("T2", "reset", sessionIdentity);
    expect(decision.effective_tier).toBe("T3");
    expect(decision.degraded_below_structural).toBe(true);
    expect(decision.reason).toContain("does not survive");
  });

  it("never upgrades perceptual references into identity claims", () => {
    // T3/T4 references are observation-only: they neither need nor gain
    // identity guarantees.
    const decision = affordanceAfterRealityChange("T4", "restart", sessionIdentity);
    expect(decision).toEqual({ effective_tier: "T4", degraded_below_structural: false });
  });

  it("supports explicit fallback tiers for worlds with richer perception", () => {
    // Session ids do not survive a restart even though they survive forks.
    const decision = affordanceAfterRealityChange("T1", "restart", sessionIdentity, {
      perceptual_fallback_tier: "T3",
    });
    expect(decision.effective_tier).toBe("T3");
    expect(decision.degraded_below_structural).toBe(true);
  });

  it("treats realm_change as the harshest reality class by default setups", () => {
    const decision = affordanceAfterRealityChange("T0", "realm_change", { survives: [] });
    expect(decision.degraded_below_structural).toBe(true);
    expect(decision.effective_tier).toBe("T3");
  });
});

describe("affordance boundary", () => {
  it("imports no adapter modules and contains no scenario nouns", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/embodied/affordance.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+"\.\.\/browser\//);
    expect(source).not.toMatch(/from\s+"\.\.\/dojo\//);
    for (const noun of ["door", "purple", "nginx", "xpath"]) {
      expect(source.toLowerCase()).not.toContain(noun);
    }
  });
});
