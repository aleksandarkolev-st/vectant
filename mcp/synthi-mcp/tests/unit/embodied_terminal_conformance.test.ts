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
import { makeTerminalAdapter } from "./embodied_worlds/terminal_world.js";

function specFor(seed: number) {
  return { realm_kind: "terminal.session", realm_id: `term://seed-${seed}`, steps: 8 };
}

describe("terminal-session world conformance through the substrate-blind harness", () => {
  it("passes the full pipeline on 12 randomized seeds", async () => {
    unregisterAllSubstrateAdapters();
    const adapter = makeTerminalAdapter();
    const results: HarnessRunResult[] = [];
    for (let seed = 7; seed < 19; seed += 1) {
      const result = await runConformancePass(adapter, specFor(seed), seed);
      results.push(result);
      expect(result.steps_executed).toBeGreaterThan(0);
      expect(result.events_recorded).toBeGreaterThan(0);
      expect(result.replay_same_state_ok).toBe(true);
      expect(result.replay_fresh_state_ok).toBe(true);
      expect(result.double_replay_hash_equal).toBe(true);
    }
    const totalAmbient = results.reduce((sum, r) => sum + r.deltas_ambient, 0);
    const totalActor = results.reduce((sum, r) => sum + r.deltas_actor_caused, 0);
    const totalPredicates = results.reduce((sum, r) => sum + r.predicates_compiled, 0);
    expect(totalAmbient).toBeGreaterThanOrEqual(1);
    expect(totalActor).toBeGreaterThan(0);
    expect(totalPredicates).toBeGreaterThan(0);
  });

  it("discriminates twins: inverted write effects flip verification", async () => {
    unregisterAllSubstrateAdapters();
    const adapter = makeTerminalAdapter();
    for (const seed of [7, 11]) {
      const outcome = await runDiscriminationPass(
        adapter,
        specFor(seed),
        seed,
        { cmd: "write", path: "src/a.txt", content: "probe" },
      );
      expect(outcome.original_ok).toBe(true);
      expect(outcome.twin_failed).toBe(true);
    }
  });
});

describe("terminal world boundary", () => {
  it("fixture imports only embodied core and node builtins; no scenario nouns", () => {
    const fixtureSource = readFileSync(
      fileURLToPath(new URL("./embodied_worlds/terminal_world.ts", import.meta.url)),
      "utf8",
    );
    const imports = [...fixtureSource.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    for (const importPath of imports) {
      expect(
        importPath.startsWith("../../../src/embodied/") || importPath.startsWith("node:"),
      ).toBe(true);
    }
    for (const noun of ["door", "purple", "nginx"]) {
      expect(fixtureSource.toLowerCase()).not.toContain(noun);
    }
    const coreFile = readFileSync(
      fileURLToPath(new URL("../../src/embodied/conformance.ts", import.meta.url)),
      "utf8",
    );
    expect(coreFile).not.toContain("terminal_world");
  });
});
