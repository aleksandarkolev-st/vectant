import { describe, expect, it } from "vitest";
import {
  runConformancePass,
  runDiscriminationPass,
  type HarnessRunResult,
} from "../../src/embodied/conformance.js";
import { unregisterAllSubstrateAdapters } from "../../src/embodied/substrate.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Importing the factory registers the adapter as a side effect.
import { makeNnAdapter } from "./embodied_worlds/nn_world.js";

function specFor(seed: number) {
  return { realm_kind: "nn.world", realm_id: `nn://seed-${seed}`, steps: 8 };
}

describe("neural-network world conformance through the substrate-blind harness", () => {
  it("passes the full pipeline on 12 randomized seeds", async () => {
    unregisterAllSubstrateAdapters();
    const adapter = makeNnAdapter();
    const results: HarnessRunResult[] = [];
    for (let seed = 31; seed < 43; seed += 1) {
      const result = await runConformancePass(adapter, specFor(seed), seed);
      results.push(result);
      expect(result.steps_executed).toBeGreaterThan(0);
      expect(result.events_recorded).toBeGreaterThan(0);
      expect(result.replay_same_state_ok).toBe(true);
      expect(result.replay_fresh_state_ok).toBe(true);
      expect(result.double_replay_hash_equal).toBe(true);
    }
    // Ambient input pulses were seen and attributed as ambient somewhere
    // across seeds (pulses land every tick; attribution may also classify
    // them via declared noise fingerprints).
    const totalAmbient = results.reduce((sum, r) => sum + r.deltas_ambient, 0);
    const totalActor = results.reduce((sum, r) => sum + r.deltas_actor_caused, 0);
    expect(totalAmbient + totalActor).toBeGreaterThan(0);
    expect(totalActor).toBeGreaterThan(0);
  });

  it("attributes actor-caused effects and compiles predicates without forks", async () => {
    unregisterAllSubstrateAdapters();
    const adapter = makeNnAdapter(); // no fork provider on purpose
    let sawPredicates = false;
    let sawActorCaused = false;
    for (let seed = 50; seed < 56; seed += 1) {
      const result = await runConformancePass(adapter, specFor(seed), seed);
      if (result.predicates_compiled > 0) sawPredicates = true;
      if (result.deltas_actor_caused > 0) sawActorCaused = true;
    }
    expect(sawActorCaused).toBe(true);
    expect(sawPredicates).toBe(true);
  });

  it("discriminates twins: zeroed outgoing weights break the fire signature", async () => {
    unregisterAllSubstrateAdapters();
    const adapter = makeNnAdapter();
    for (let seed = 60; seed < 62; seed += 1) {
      const outcome = await runDiscriminationPass(
        adapter,
        specFor(seed),
        seed,
        { fire: "nodes.1.2" },
      );
      expect(outcome.original_ok).toBe(true);
      expect(outcome.twin_failed).toBe(true);
    }
  });
});

describe("nn world boundary", () => {
  it("fixture imports only embodied core and node builtins; core stays scenario-free", () => {
    const fixtureSource = readFileSync(
      fileURLToPath(new URL("./embodied_worlds/nn_world.ts", import.meta.url)),
      "utf8",
    );
    const imports = [...fixtureSource.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    for (const importPath of imports) {
      expect(
        importPath.startsWith("../../../src/embodied/") || importPath.startsWith("node:"),
      ).toBe(true);
    }
    const coreFile = readFileSync(
      fileURLToPath(new URL("../../src/embodied/conformance.ts", import.meta.url)),
      "utf8",
    );
    expect(coreFile).not.toContain("nn_world");
    expect(coreFile.toLowerCase()).not.toContain("activation");
  });
});
