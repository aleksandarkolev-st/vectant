import { describe, expect, it } from "vitest";
import {
  affordanceDegradation,
  contractPrecision,
  contractRecall,
  counterfactualDiscrimination,
  causalFalsePositiveRate,
} from "../../src/embodied/metrics.js";
import type { AttributedDelta } from "../../src/embodied/state_differ/types.js";

describe("semantic-quality metrics", () => {
  it("precision counts effects whose removal breaks replay as necessary", () => {
    // 3 of 4 effects are necessary (replay fails without them).
    const precision = contractPrecision([
      { effect_id: "e1", replay_passed_without: false },
      { effect_id: "e2", replay_passed_without: false },
      { effect_id: "e3", replay_passed_without: true },
      { effect_id: "e4", replay_passed_without: false },
    ]);
    expect(precision).toBeCloseTo(0.75, 10);
    // All-unnecessary => 0; empty probes => perfect by definition.
    expect(contractPrecision([{ effect_id: "x", replay_passed_without: true }])).toBe(0);
    expect(contractPrecision([])).toBe(1);
  });

  it("recall counts detected faults; zero probes means zero knowledge", () => {
    const recall = contractRecall([
      { fault_id: "f1", detected: true },
      { fault_id: "f2", detected: false },
      { fault_id: "f3", detected: true },
      { fault_id: "f4", detected: true },
    ]);
    expect(recall).toBe(0.75);
    expect(contractRecall([])).toBe(0);
  });

  it("discrimination requires BOTH equivalent-pass and twin-fail", () => {
    const rate = counterfactualDiscrimination([
      { trial_id: "t1", equivalent_passed: true, twin_failed: true }, // real
      { trial_id: "t2", equivalent_passed: true, twin_failed: false }, // vacuous
      { trial_id: "t3", equivalent_passed: false, twin_failed: true }, // broken
      { trial_id: "t4", equivalent_passed: true, twin_failed: true },
    ]);
    expect(rate).toBe(0.5);
    expect(counterfactualDiscrimination([])).toBe(0);
  });

  it("causal FP rate measures attribution leaks among compiled effects", () => {
    const delta = (
      path: string,
      causal_class: "actor_caused" | "ambient" | "induced",
      compiled: boolean,
    ) =>
      ({
        source: { path, semantic_class: "", before: 0, after: 1, changed_at_tick: 1 },
        relevance_score: 1,
        causal_class,
        evidence: causal_class === "actor_caused" ? "fork_control" : "temporal_only",
        persistence_class: "durable",
        ...(compiled
          ? { compiled_predicate: { predicate_id: "eq", args: { path } } }
          : {}),
      }) as AttributedDelta;
    const deltas = [
      delta("good.a", "actor_caused", true),
      delta("leaked.ambient", "ambient", true), // leaked past stage 3!
      delta("dropped.b", "ambient", false), // not compiled, doesn't count
      delta("good.c", "actor_caused", true),
    ];
    const report = causalFalsePositiveRate(deltas);
    expect(report.rate).toBeCloseTo(1 / 3, 10);
    expect(report.leaked_paths).toEqual(["leaked.ambient"]);
  });

  it("degradation tracks tier drops and forces re-hardening at pixel-only", () => {
    const report = affordanceDegradation([
      { competency_id: "a", compiled_tier: "T2", current_tier: "T2" },
      { competency_id: "b", compiled_tier: "T1", current_tier: "T3" }, // degraded
      { competency_id: "c", compiled_tier: "T2", current_tier: "T4" }, // degraded + forced
      { competency_id: "d", compiled_tier: "T4", current_tier: "T4" }, // was already pixel-only
    ]);
    expect(report.degradation_rate).toBeCloseTo(0.5, 10);
    expect(report.needs_rehardening).toEqual(["c"]);
  });
});
