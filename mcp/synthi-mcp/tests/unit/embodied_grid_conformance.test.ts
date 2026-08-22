import { describe, expect, it } from "vitest";
import { runConformancePass, runDiscriminationPass, type HarnessRunResult } from "../../src/embodied/conformance.js";
import { unregisterAllSubstrateAdapters } from "../../src/embodied/substrate.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Importing the factory registers the adapter as a side effect.
import { makeGridAdapter } from "./embodied_worlds/grid_world.js";

const SPEC = { realm_kind: "grid.world", realm_id: "", steps: 8 } as const;

function specFor(seed: number) {
  return { realm_kind: "grid.world", realm_id: `grid://seed-${seed}`, steps: 8 };
}

describe("grid world conformance through the substrate-blind harness", () => {
  it("passes the full pipeline on 12 randomized seeds", async () => {
    unregisterAllSubstrateAdapters();
    const adapter = makeGridAdapter();
    const results: HarnessRunResult[] = [];
    for (let seed = 100; seed < 112; seed += 1) {
      const result = await runConformancePass(adapter, specFor(seed), seed);
      results.push(result);
      expect(result.steps_executed).toBeGreaterThan(0);
      expect(result.events_recorded).toBeGreaterThan(0);
      expect(result.replay_same_state_ok).toBe(true);
      expect(result.replay_fresh_state_ok).toBe(true);
      expect(result.double_replay_hash_equal).toBe(true);
    }
    // Aggregates across seeds prove ambient dynamics were seen and handled.
    const totalAmbient = results.reduce((sum, r) => sum + r.deltas_ambient, 0);
    expect(totalAmbient).toBeGreaterThan(0);
  });

  it("attributes actor-caused effects and compiles predicates", async () => {
    unregisterAllSubstrateAdapters();
    const adapter = makeGridAdapter();
    let sawActorCaused = false;
    let sawPredicates = false;
    for (let seed = 200; seed < 206; seed += 1) {
      const result = await runConformancePass(adapter, specFor(seed), seed);
      if (result.deltas_actor_caused > 0) sawActorCaused = true;
      if (result.predicates_compiled > 0) sawPredicates = true;
    }
    expect(sawActorCaused).toBe(true);
    expect(sawPredicates).toBe(true);
  });

  it("discriminates twins: flipped entity family flips the inspect outcome", async () => {
    unregisterAllSubstrateAdapters();
    const adapter = makeGridAdapter();
    for (let seed = 300; seed < 302; seed += 1) {
      // Drive a real demonstration to discover an inspect action that mattered.
      const pass = await runConformancePass(adapter, specFor(seed), seed);
      expect(pass.replay_same_state_ok).toBe(true);
      // Build a concrete inspect action against this world.
      const handle = await adapter.bundle.attach({
        realm: { realm_kind: "grid.world", realm_id: specFor(seed).realm_id },
        consent_proof: {
          subject: "harness-agent",
          realm: { realm_kind: "grid.world", realm_id: specFor(seed).realm_id },
          approved_capabilities: ["observe", "record", "act"],
        },
      });
      const observation = (await adapter.bundle.observer!.observe(handle)) as {
        entities: Array<{ id: string }>;
      };
      const targetEntity = observation.entities[0]!.id;
      const outcome = await runDiscriminationPass(
        adapter,
        specFor(seed),
        seed,
        { inspect: { entity_id: targetEntity } },
      );
      expect(outcome.original_ok).toBe(true);
      expect(outcome.twin_failed).toBe(true);
      void handle;
    }
  });
});

describe("grid world boundary", () => {
  it("fixture imports only embodied core and node builtins; core stays scenario-free", () => {
    const fixtureSource = readFileSync(
      fileURLToPath(new URL("./embodied_worlds/grid_world.ts", import.meta.url)),
      "utf8",
    );
    const imports = [...fixtureSource.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const importPath of imports) {
      expect(importPath.startsWith("../../../src/embodied/") || importPath.startsWith("node:")).toBe(true);
    }
    // The core must not import this fixture or any other test world.
    const coreFile = readFileSync(
      fileURLToPath(new URL("../../src/embodied/conformance.ts", import.meta.url)),
      "utf8",
    );
    expect(coreFile).not.toContain("grid_world");
    void SPEC;
  });
});
