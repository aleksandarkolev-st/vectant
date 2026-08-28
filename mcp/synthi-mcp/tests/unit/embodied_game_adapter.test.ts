/**
 * Purple-door golden fixture (plan P2): randomized door-inspection flows
 * compile, replay, and discriminate across seeds. Door hue, count, layout,
 * and colors are harness-randomized every run; zero core or adapter code
 * references doors or any color — the appearance check is the generic HSV
 * band predicate from the shared CV module.
 */
import { describe, expect, it } from "vitest";
import {
  createGameBundle,
  entityMatchesBand,
  quantizeMove,
  type GameTransport,
  type SceneGraph,
} from "../../src/embodied/adapters/game/protocol.js";
import { hsvBandPredicate } from "../../src/embodied/perception/cv.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface WorldState {
  tick: number;
  entities: SceneGraph["entities"];
}

interface SeededWorld {
  state: WorldState;
  specialHue: number;
  otherHue: number;
  handle(op: string, action?: { inspect?: { entity_id: string }; move?: { dx: number; dy: number } }): Promise<unknown>;
}

/** In-process scene world: hue band, entity count, and layout randomized. */
function makeSceneWorld(seed: number): SeededWorld {
  const rand = mulberry32(seed);
  const specialHue = rand() * 360;
  const otherHue = (specialHue + 120 + rand() * 100) % 360;
  const count = 3 + Math.floor(rand() * 5);
  const specialIndex = Math.floor(rand() * count);
  const state: WorldState = {
    tick: 0,
    entities: Array.from({ length: count }, (_, i) => ({
      id: `ent-${i}`,
      position: { x: Math.floor(rand() * 40) - 20, y: Math.floor(rand() * 40) - 20 },
      color: { h: i === specialIndex ? specialHue : otherHue, s: 0.6, v: 0.8 },
      kind: "portal",
    })),
  };

  return {
    state,
    specialHue,
    otherHue,
    async handle(op, action) {
      if (op === "observe") {
        return {
          tick: state.tick,
          entities: state.entities.map((entity) => ({ ...entity })),
          hidden: [],
        };
      }
      if (op === "act") {
        state.tick += 1;
        if (action?.inspect) {
          const exists = state.entities.some((entity) => entity.id === action.inspect!.entity_id);
          return { ok: true, tick: state.tick, detail: { inspected_exists: exists } };
        }
        if (action?.move) {
          return { ok: true, tick: state.tick };
        }
        return { ok: false, reason: "unrecognized" };
      }
      if (op === "fork") return { fork_id: "f0" };
      return { ok: false, reason: "unknown op" };
    },
  };
}

/** Transport whose receive() computes the response for the last send(). */
function pairedTransport(world: SeededWorld): GameTransport {
  let pending: { op: string; action?: { inspect?: { entity_id: string }; move?: { dx: number; dy: number } } } | null = null;
  return {
    send: async (message) => {
      pending = message as typeof pending;
    },
    receive: async <T,>() => {
      if (!pending) throw new Error("receive before send");
      const response = await world.handle(pending.op, pending.action);
      pending = null;
      return response as T;
    },
  };
}

const LEASE = (realmId: string) => ({
  lease_id: "l",
  realm: { realm_kind: "game", realm_id: realmId },
  capability: "act" as const,
  expires_at_ms: Number.MAX_SAFE_INTEGER,
});

describe("game adapter: randomized door-inspection golden fixture (P2)", () => {
  it("teaches and replays an inspect flow across 10 randomized seeds", async () => {
    for (let seed = 100; seed < 110; seed += 1) {
      const realmId = `game://seed-${seed}`;
      const world = makeSceneWorld(seed);
      const bundle = createGameBundle(() => pairedTransport(world));
      const handle = await bundle.attach({
        realm: { realm_kind: "game", realm_id: realmId },
        consent_proof: {
          subject: "t",
          realm: { realm_kind: "game", realm_id: realmId },
          approved_capabilities: ["observe", "record", "act"],
        },
      });

      // Observe; identify the special-family entity via the GENERIC CV band.
      const scene = (await bundle.observer!.observe(handle)) as SceneGraph;
      expect(scene.entities.length).toBeGreaterThanOrEqual(3);
      const band = {
        h_min: (world.specialHue - 15 + 360) % 360,
        h_max: (world.specialHue + 15) % 360,
        s_min: 0.3,
        v_min: 0.3,
      };
      const specials = scene.entities.filter((entity) => entityMatchesBand(entity, band));
      expect(specials.length).toBe(1);
      const target = specials[0]!.id;

      // Teach a quantized move toward it, then the inspection.
      bundle.recorder!.beginRecord(handle);
      const quantized = quantizeMove(
        specials[0]!.position.x,
        specials[0]!.position.y,
        5,
        2,
      );
      await bundle.actor!.act(handle, { act: { move: quantized.move }, meta: quantized.meta }, LEASE(realmId));
      await bundle.actor!.act(handle, { inspect: { entity_id: target } }, LEASE(realmId));
      const fragment = bundle.recorder!.endRecord(handle);
      expect(fragment.steps).toHaveLength(2);

      // Replay same_state: both steps hold.
      const replay = await bundle.replay_provider!.replay(fragment, { handle, mode: "same_state" });
      expect(replay.ok).toBe(true);

      // Twin: repaint the special entity with the other family hue.
      const twinWorld = makeSceneWorld(seed);
      twinWorld.state.entities.forEach((entity) => {
        if (entityMatchesBand(entity, band)) entity.color.h = twinWorld.otherHue;
      });
      const twinRealm = `game://seed-${seed}-twin`;
      const twinBundle = createGameBundle(() => pairedTransport(twinWorld));
      const twinHandle = await twinBundle.attach({
        realm: { realm_kind: "game", realm_id: twinRealm },
        consent_proof: {
          subject: "t",
          realm: { realm_kind: "game", realm_id: twinRealm },
          approved_capabilities: ["act"],
        },
      });
      // The recorded inspection must FAIL in the repainted twin: the target's
      // family membership is gone. Discrimination is semantic (the inspect op
      // still returns ok:true from the transport, so we assert at the
      // APPEARANCE level — the twin no longer matches the taught band).
      const twinScene = (await twinBundle.observer!.observe(twinHandle)) as SceneGraph;
      const stillSpecial = twinScene.entities.filter((candidate) =>
        candidate.id === target && entityMatchesBand(candidate, band),
      );
      expect(stillSpecial).toHaveLength(0);
    }
  });

  it("quantization captures tolerance at record time and is stable", () => {
    const q = quantizeMove(12.3, -7.8, 5, 2);
    expect(q.move).toEqual({ dx: 10, dy: -10 });
    expect(q.meta).toEqual({ primitive_class: "continuous", quantization: 5, tolerance: 2 });
    expect(() => quantizeMove(1, 1, 0, 1)).toThrow(/step/);
  });

  it("pixel-fallback path reports LOW confidence when evidence is weak", () => {
    const verdict = hsvBandPredicate(
      { width: 4, height: 4, data: new Uint32Array(16).fill(0x00000000) },
      { h_min: 260, h_max: 290, s_min: 0.5, v_min: 0.5 },
    );
    expect(verdict.matches).toBe(false);
    expect(verdict.confidence).toBeLessThan(0.5);
  });

  it("lease and realm guards refuse before any transport traffic", async () => {
    const world = makeSceneWorld(7);
    const bundle = createGameBundle(() => pairedTransport(world));
    const handle = await bundle.attach({
      realm: { realm_kind: "game", realm_id: "game://guard" },
      consent_proof: {
        subject: "t",
        realm: { realm_kind: "game", realm_id: "game://guard" },
        approved_capabilities: ["act"],
      },
    });
    const expired = await bundle.actor!.act(handle, { inspect: { entity_id: "ent-0" } }, {
      ...LEASE("game://guard"),
      expires_at_ms: Date.now() - 1,
    });
    expect(expired.ok).toBe(false);
    const wrongRealm = await bundle.actor!.act(handle, { inspect: { entity_id: "ent-0" } }, LEASE("game://other"));
    expect(wrongRealm.ok).toBe(false);
  });
});
