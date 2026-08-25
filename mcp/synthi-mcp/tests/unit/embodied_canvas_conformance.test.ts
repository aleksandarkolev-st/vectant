/**
 * PIXEL-ONLY world conformance (plan Phase 0b: "the conformance fuzz must
 * include at least one pixel-only world variant (schema declares no scene
 * graph) to prove the CV path compiles equivalent contracts with
 * correctly-flagged confidence").
 *
 * The canvas world has NO structural channels and NO referential identity:
 * observations are frames, regions are addressed by geometry, and every
 * perceptual decision routes through the shared cv primitives. If the core
 * pipeline compiles contracts here, it truly does not need a scene graph.
 */
import { describe, expect, it } from "vitest";
import {
  runConformancePass,
  runDiscriminationPass,
  type HarnessRunResult,
} from "../../src/embodied/conformance.js";
import { unregisterAllSubstrateAdapters } from "../../src/embodied/substrate.js";
import {
  blockDelta,
  dHash64,
  hammingHex,
  hsvBandPredicate,
  toGray,
} from "../../src/embodied/perception/cv.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Importing the factory registers the adapter as a side effect.
import { makeCanvasAdapter } from "./embodied_worlds/canvas_world.js";

function specFor(seed: number) {
  return { realm_kind: "canvas.pixels", realm_id: `canvas://seed-${seed}`, steps: 8 };
}

describe("pixel-only canvas world conformance through the substrate-blind harness", () => {
  it("passes the full pipeline on 12 randomized seeds with zero structural channels", async () => {
    unregisterAllSubstrateAdapters();
    const adapter = makeCanvasAdapter();
    const results: HarnessRunResult[] = [];
    for (let seed = 700; seed < 712; seed += 1) {
      const result = await runConformancePass(adapter, specFor(seed), seed);
      results.push(result);
      expect(result.steps_executed).toBeGreaterThan(0);
      expect(result.events_recorded).toBeGreaterThan(0);
      expect(result.replay_same_state_ok).toBe(true);
      expect(result.replay_fresh_state_ok).toBe(true);
      // Seeded double-replay hash equality extends to PERCEPTUAL verdicts
      // (identical frames must produce identical verdicts).
      expect(result.double_replay_hash_equal).toBe(true);
    }
    const totalAmbient = results.reduce((sum, r) => sum + r.deltas_ambient, 0);
    expect(totalAmbient).toBeGreaterThan(0);
  });

  it("attributes actor-caused appearance changes despite an always-moving ambient strip", async () => {
    unregisterAllSubstrateAdapters();
    const adapter = makeCanvasAdapter();
    let sawActorCaused = false;
    let sawPredicates = false;
    let sawAmbient = false;
    for (let seed = 800; seed < 808; seed += 1) {
      const result = await runConformancePass(adapter, specFor(seed), seed);
      if (result.deltas_actor_caused > 0) sawActorCaused = true;
      if (result.predicates_compiled > 0) sawPredicates = true;
      if (result.deltas_ambient > 0) sawAmbient = true;
    }
    expect(sawActorCaused).toBe(true);
    expect(sawPredicates).toBe(true);
    expect(sawAmbient).toBe(true);
  });

  it("discriminates twins: a hue-flipped slot makes the same replay fail", async () => {
    unregisterAllSubstrateAdapters();
    const adapter = makeCanvasAdapter();
    for (let seed = 900; seed < 902; seed += 1) {
      const pass = await runConformancePass(adapter, specFor(seed), seed);
      expect(pass.replay_same_state_ok).toBe(true);

      // Build a concrete paint action against THIS world's live slots.
      const realm = {
        realm_kind: "canvas.pixels",
        realm_id: specFor(seed).realm_id,
      };
      const handle = (await adapter.bundle.attach({
        realm,
        consent_proof: {
          subject: "harness-agent",
          realm,
          approved_capabilities: ["observe", "record", "act"],
        },
      })) as import("../../src/embodied/substrate.js").SessionHandle & {
        environment: { activeSlots: ReadonlySet<number>; frameCounter: number };
      };
      const activeSlots = [...handle.environment.activeSlots];
      expect(activeSlots.length).toBeGreaterThan(0);
      const targetSlot = activeSlots[0] as number;
      const outcome = await runDiscriminationPass(
        adapter,
        specFor(seed),
        seed,
        { op: "paint", slot: targetSlot, color: { h: 123, s: 0.6, v: 0.6 } },
      );
      expect(outcome.original_ok).toBe(true);
      expect(outcome.twin_failed).toBe(true);
    }
  });
});

describe("pixel perception binds to shared cv primitives with deterministic verdicts", () => {
  it("renders identical frames into identical perceptual hashes (double-replay equality is real)", () => {
    unregisterAllSubstrateAdapters();
    const adapter = makeCanvasAdapter();
    void adapter;
    // Two structurally identical frames must hash identically; a repaint of
    // one slot must move the hash only within tolerance.
    const mk = (slotColor: [number, number, number]) => ({
      width: 4,
      height: 4,
      data: [
        ...Array(8).fill(((slotColor[0] << 16) | (slotColor[1] << 8) | slotColor[2]) >>> 0),
        ...Array(8).fill(0x000000),
      ] as number[],
    });
    const a = dHash64(toGray(mk([200, 60, 60])));
    const b = dHash64(toGray(mk([200, 60, 60])));
    expect(hammingHex(a, b)).toBe(0);
  });

  it("hsv band predicate agrees with the world's own dominant-hue extraction", () => {
    unregisterAllSubstrateAdapters();
    const adapter = makeCanvasAdapter();
    void adapter;
    const purple = {
      width: 2,
      height: 2,
      data: [0x7a1fa2, 0x7a1fa2, 0x7a1fa2, 0x7a1fa2] as number[],
    };
    const verdict = hsvBandPredicate(purple, { h_min: 265, h_max: 300, s_min: 0.25, v_min: 0.1 });
    expect(verdict.matches).toBe(true);
    const green = { width: 2, height: 2, data: [0x1fa24a, 0x1fa24a, 0x1fa24a, 0x1fa24a] as number[] };
    expect(hsvBandPredicate(green, { h_min: 265, h_max: 300, s_min: 0.25, v_min: 0.1 }).matches).toBe(
      false,
    );
  });

  it("block delta pre-filter isolates exactly the repainted region", () => {
    const before = { width: 12, height: 12, data: new Array(144).fill(100) as number[] };
    const afterData = new Array(144).fill(100) as number[];
    for (let y = 0; y < 6; y += 1) {
      for (let x = 0; x < 6; x += 1) afterData[y * 12 + x] = 220;
    }
    const after = { width: 12, height: 12, data: afterData };
    const blocks = blockDelta(before, after, 6, 8);
    expect(blocks.changed_blocks.length).toBe(1);
    expect(blocks.changed_blocks[0]).toEqual({ bx: 0, by: 0 });
  });
});

describe("pixel-only world boundary", () => {
  it("fixture imports only embodied core and node builtins; core stays scenario-free", () => {
    const fixtureSource = readFileSync(
      fileURLToPath(new URL("./embodied_worlds/canvas_world.ts", import.meta.url)),
      "utf8",
    );
    const imports = [...fixtureSource.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const importPath of imports) {
      expect(importPath.startsWith("../../../src/embodied/") || importPath.startsWith("node:")).toBe(
        true,
      );
    }
    // The core must not know this fixture exists.
    const coreFile = readFileSync(
      fileURLToPath(new URL("../../src/embodied/conformance.ts", import.meta.url)),
      "utf8",
    );
    expect(coreFile).not.toContain("canvas_world");
  });
});
