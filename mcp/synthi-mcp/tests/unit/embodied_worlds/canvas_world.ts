/**
 * PIXEL-ONLY canvas world: closes the plan Phase 0b requirement that the
 * conformance fuzz include "at least one pixel-only world variant (schema
 * declares no scene graph)".
 *
 * What makes it genuinely pixel-only:
 * - Observations are FRAMES (packed-RGB buffers) and nothing else. No
 *   entity ids, no structured channels, no scene graph.
 * - Region identity comes from GEOMETRY (a fixed slot layout), the way
 *   real screen-space perception works: the schema declares identity as
 *   "derived" surviving nothing - the below-structural posture.
 * - Every perception decision goes through the SHARED cv primitives
 *   (blockDelta, toGray, cropRegion, rgbToHsv, dHash64): this fixture
 *   implements zero bespoke pixel math beyond rendering itself.
 * - The ambient oscillator renders into a reserved strip so the world has
 *   honest, always-moving noise the pipeline must attribute correctly.
 *
 * Replay semantics:
 * - same_state = VERIFY-ONLY net effects: for each slot touched by the
 *   demonstration, the FINAL recorded appearance must still match the
 *   live frame (earlier overwritten paints are superseded, not asserted).
 * - fresh_state = reset to a cold seeded world, re-apply steps, hash the
 *   rendered frame; two fresh replays MUST hash identically.
 *
 * Test fixture only: never imported by src/embodied/**.
 */

import {
  registerSubstrateAdapter,
  type SessionHandle,
  type SubstrateAdapterBundle,
} from "../../../src/embodied/substrate.js";
import type { FuzzableAdapter } from "../../../src/embodied/conformance.js";
import {
  resolveSemanticClass,
  validateWorldStateSchema,
  type ChangedValue,
  type WorldStateSchema,
} from "../../../src/embodied/world_state.js";
import type { PersistenceTrace } from "../../../src/embodied/state_differ/types.js";
import {
  blockDelta,
  dHash64,
  rgbToHsv,
  toGray,
  type GrayBuffer,
  type RgbBuffer,
} from "../../../src/embodied/perception/cv.js";

// ---------------------------------------------------------------------------
// Geometry (fixed so observations are comparable across worlds; CONTENT is
// what gets randomized - active slots, colors, oscillation period).
// ---------------------------------------------------------------------------
const SLOTS_PER_SIDE = 3;
const SLOT_PX = 12;
const STRIP_PX = 4;
const FRAME_W = SLOTS_PER_SIDE * SLOT_PX; // 36
const FRAME_H = FRAME_W + STRIP_PX; // 40
const SLOT_COUNT = SLOTS_PER_SIDE * SLOTS_PER_SIDE;
const BACKGROUND: { h: number; s: number; v: number } = { h: 0, s: 0, v: 0.05 };

interface SlotColor {
  h: number; // 0..360
  s: number; // 0..1
  v: number; // 0..1
}

interface CanvasWorld {
  frameCounter: number;
  scanPhase: number;
  scanPeriod: number;
  /** Which slot indices can be acted on (randomized per world). */
  activeSlots: ReadonlySet<number>;
  slots: Map<number, SlotColor>;
  journal: Array<{ tick: number; snapshot: CanvasObservation }>;
}

interface CanvasObservation {
  tick: number;
  width: number;
  height: number;
  /** Row-major packed 0xRRGGBB. */
  data: number[];
}

interface CanvasAction {
  op: "paint" | "noop";
  slot?: number;
  color?: SlotColor;
}

type CanvasHandle = SessionHandle<CanvasWorld> & {
  recording: Array<{ event: CanvasAction }> | null;
};

// ---------------------------------------------------------------------------
// Deterministic randomness helpers (fixture-local, mirroring sibling worlds)
// ---------------------------------------------------------------------------
function hashString(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + 0x6d2b79f5) | 0;
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

function hsvToRgbPacket(color: SlotColor): number {
  const c = color.v * color.s;
  const hp = color.h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = color.v - c;
  const to255 = (channel: number) => Math.round((channel + m) * 255);
  return (to255(r) << 16) | (to255(g) << 8) | to255(b);
}

/**
 * Rendering is a pure function of (slot content, scan phase). Slots get a
 * deterministic horizontal luminance ramp so DIFFERENT colors produce
 * DIFFERENT gradients (perceptual hashes stay meaningful on non-uniform
 * regions); the strip's brightness cycles with the scan phase.
 */
function renderWorld(world: CanvasWorld): CanvasObservation {
  const data: number[] = [];
  for (let row = 0; row < SLOTS_PER_SIDE; row += 1) {
    for (let py = 0; py < SLOT_PX; py += 1) {
      for (let slotCol = 0; slotCol < SLOTS_PER_SIDE; slotCol += 1) {
        const slotIndex = row * SLOTS_PER_SIDE + slotCol;
        const color = world.slots.get(slotIndex) ?? BACKGROUND;
        const base = hsvToRgbPacket(color);
        const r = (base >> 16) & 0xff;
        const g = (base >> 8) & 0xff;
        const b = base & 0xff;
        for (let px = 0; px < SLOT_PX; px += 1) {
          // Ramp: right side of each slot is brighter - a deterministic
          // texture keyed to nothing but the color itself.
          const ramp = 0.82 + 0.18 * (px / (SLOT_PX - 1));
          data.push(
            (Math.round(r * ramp) << 16) | (Math.round(g * ramp) << 8) | Math.round(b * ramp),
          );
        }
      }
    }
  }
  for (let py = 0; py < STRIP_PX; py += 1) {
    const wave = 0.5 + 0.5 * Math.sin((2 * Math.PI * (world.scanPhase + py)) / world.scanPeriod);
    const level = Math.round(30 + 120 * wave);
    for (let px = 0; px < FRAME_W; px += 1) {
      data.push((level << 16) | (level << 8) | level);
    }
  }
  return { tick: world.frameCounter, width: FRAME_W, height: FRAME_H, data };
}

function observeWorld(world: CanvasWorld): CanvasObservation {
  world.frameCounter += 1;
  world.scanPhase += 1;
  const snapshot = renderWorld(world);
  world.journal.push({ tick: world.frameCounter, snapshot });
  if (world.journal.length > 64) world.journal.shift();
  return snapshot;
}

function makeWorld(realmId: string): CanvasWorld {
  const rand = mulberry32(hashString(realmId));
  const activeSlots = new Set<number>();
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    if (rand() < 0.65) activeSlots.add(slot);
  }
  if (activeSlots.size === 0) activeSlots.add(Math.floor(rand() * SLOT_COUNT));
  const slots = new Map<number, SlotColor>();
  for (const slot of activeSlots) {
    slots.set(slot, { h: rand() * 360, s: 0.35 + rand() * 0.5, v: 0.45 + rand() * 0.4 });
  }
  const scanPeriod = 4 + Math.floor(rand() * 6);
  return { frameCounter: 0, scanPhase: Math.floor(rand() * scanPeriod), scanPeriod, activeSlots, slots, journal: [] };
}

// ---------------------------------------------------------------------------
// Perception helpers - thin compositions over the SHARED cv module
// ---------------------------------------------------------------------------
function asRgb(observation: CanvasObservation): RgbBuffer {
  return { width: observation.width, height: observation.height, data: observation.data };
}

function asGray(observation: CanvasObservation): GrayBuffer {
  return toGray(asRgb(observation));
}

function slotRect(slot: number): { x: number; y: number; w: number; h: number } {
  return {
    x: (slot % SLOTS_PER_SIDE) * SLOT_PX,
    y: Math.floor(slot / SLOTS_PER_SIDE) * SLOT_PX,
    w: SLOT_PX,
    h: SLOT_PX,
  };
}

function slotPath(slot: number): string {
  return `frame.slot.${slot}.appearance`;
}

/** Dominant hue of a slot region: circular mean over its pixels (aggregation
 *  over rgbToHsv outputs; no bespoke color science). */
function dominantHue(observation: CanvasObservation, slot: number): number {
  const rect = slotRect(slot);
  const rgb = asRgb(observation);
  let sinSum = 0;
  let cosSum = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const pixel = rgb.data[y * rgb.width + x] as number;
      const { h, s, v } = rgbToHsv((pixel >> 16) & 0xff, (pixel >> 8) & 0xff, pixel & 0xff);
      if (s < 0.08 || v < 0.08) continue; // background/gray carries no hue signal
      sinSum += Math.sin((h * Math.PI) / 180);
      cosSum += Math.cos((h * Math.PI) / 180);
    }
  }
  if (sinSum === 0 && cosSum === 0) return -1;
  const angle = Math.atan2(sinSum, cosSum) * (180 / Math.PI);
  return (angle + 360) % 360;
}

function extractPath(observation: CanvasObservation, path: string): unknown {
  if (path === "frame.scan") {
    const gray = asGray(observation);
    let sum = 0;
    let count = 0;
    for (let y = FRAME_H - STRIP_PX; y < FRAME_H; y += 1) {
      for (let x = 0; x < FRAME_W; x += 1) {
        sum += gray.data[y * FRAME_W + x] as number;
        count += 1;
      }
    }
    return count > 0 ? sum / count : 0;
  }
  const match = path.match(/^frame\.slot\.(\d+)\.appearance$/);
  if (!match) return undefined;
  return dominantHue(observation, Number(match[1]));
}

/** Stage 1: mechanical, complete pixel diff through shared primitives. */
function diffFrames(before: CanvasObservation | null, after: CanvasObservation): ChangedValue[] {
  const changed: ChangedValue[] = [];
  if (before && (before.width !== after.width || before.height !== after.height)) {
    throw new Error("frame geometry mismatch");
  }
  const blocks = blockDelta(
    before ? asGray(before) : { width: FRAME_W, height: FRAME_H, data: new Uint8Array(FRAME_W * FRAME_H) },
    asGray(after),
    6,
    6,
  );
  const seenRegions = new Set<string>();
  for (const block of blocks.changed_blocks) {
    const cx = block.bx * 6 + 3;
    const cy = block.by * 6 + 3;
    let path: string;
    if (cy >= FRAME_H - STRIP_PX) {
      path = "frame.scan";
    } else {
      const slot = Math.floor(cy / SLOT_PX) * SLOTS_PER_SIDE + Math.floor(cx / SLOT_PX);
      path = slotPath(slot);
    }
    if (seenRegions.has(path)) continue;
    seenRegions.add(path);
    changed.push({
      path,
      semantic_class: "",
      ...(before !== null ? { before: extractPath(before, path) } : {}),
      after: extractPath(after, path),
      changed_at_tick: after.tick,
    });
  }
  return changed;
}

function flatten(observation: CanvasObservation): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) flat.set(slotPath(slot), dominantHue(observation, slot));
  flat.set("frame.scan", extractPath(observation, "frame.scan"));
  return flat;
}

function frameHash(world: CanvasWorld): string {
  return dHash64(toGray(asRgb(renderWorld(world))));
}

// ---------------------------------------------------------------------------
// Schema: pixel-only ontology, declared honestly
// ---------------------------------------------------------------------------
function makeSchema(): WorldStateSchema {
  const schema: WorldStateSchema = {
    schema_id: "canvas.pixels",
    schema_version: "1.0.0",
    value_types: [
      {
        path_pattern: "frame.slot.*.appearance",
        type: { kind: "band", min: 0, max: 360, unit: "hue_degrees" },
        semantic_class: "material",
      },
      {
        path_pattern: "frame.scan",
        type: { kind: "number", bounds: { min: 0, max: 255 } },
        semantic_class: "ambient",
      },
    ],
    identity: {
      id_scheme: "derived",
      survives: [],
      reidentification_rule: "regions are positions in a fixed slot layout; identity is spatial, not referential",
    },
    observability: {
      fully_observable: true,
      hidden_state: [],
      policy: "best_effort",
    },
    noise_fingerprints: [
      { fingerprint_id: "scan-cycle", path_pattern: "frame.scan", period_hint_ticks: 8 },
    ],
  };
  const problems = validateWorldStateSchema(schema);
  if (problems.length > 0) {
    throw new Error(`canvas schema invalid: ${JSON.stringify(problems)}`);
  }
  return schema;
}

// ---------------------------------------------------------------------------
// Adapter bundle
// ---------------------------------------------------------------------------
export function makeCanvasAdapter(): FuzzableAdapter {
  const bundle: SubstrateAdapterBundle<CanvasObservation, CanvasAction, CanvasHandle> = {
    substrate_kind: "canvas.pixels",
    adapter_version: "1.0.0",

    observer: {
      channels: ["frame"],
      describeWorldSchema: () => makeSchema(),
      observe: async (handle) => observeWorld(handle.environment),
    },

    actor: {
      act: async (handle, action, leaseProof) => {
        const world = handle.environment;
        if (leaseProof.expires_at_ms <= Date.now()) {
          return { ok: false, refusal_reason: "lease expired" };
        }
        if (leaseProof.realm.realm_id !== handle.realm.realm_id) {
          return { ok: false, refusal_reason: "realm mismatch" };
        }
        let ok = false;
        if (action.op === "paint" && action.slot !== undefined && action.color) {
          if (world.activeSlots.has(action.slot)) {
            world.slots.set(action.slot, action.color);
            ok = true;
          }
        } else if (action.op === "noop") {
          ok = true;
        }
        if (ok && handle.recording) handle.recording.push({ event: action });
        return { ok, applied_tick: world.frameCounter };
      },
    },

    recorder: {
      beginRecord: (handle) => {
        handle.recording = [];
      },
      endRecord: (handle) => {
        const steps = (handle.recording ?? []).map((entry) => ({ event: entry.event }));
        handle.recording = null;
        return { trace_id: `canvas-${handle.handle_id}`, steps };
      },
    },

    reset_provider: {
      resetProfiles: ["cold"],
      reset: async (handle) => {
        const fresh = makeWorld(handle.realm.realm_id);
        Object.assign(handle.environment, fresh, { journal: [] });
      },
    },

    fork_provider: {
      fork: async (handle) => {
        const source = handle.environment;
        const clone: CanvasWorld = {
          frameCounter: source.frameCounter,
          scanPhase: source.scanPhase,
          scanPeriod: source.scanPeriod,
          activeSlots: new Set(source.activeSlots),
          slots: new Map(source.slots),
          journal: [],
        };
        return {
          ...handle,
          handle_id: `${handle.handle_id}-fork`,
          environment: clone,
          fork_of: handle.handle_id,
        };
      },
      disposeFork: async () => {},
    },

    replay_provider: {
      replay: async (fragment, options) => {
        const handle = options.handle as CanvasHandle;
        const world = handle.environment;

        if (options.mode === "fresh_state") {
          const fresh = makeWorld(handle.realm.realm_id);
          world.slots = new Map(fresh.slots);
          world.activeSlots = fresh.activeSlots;
          world.scanPhase = fresh.scanPhase;
          world.scanPeriod = fresh.scanPeriod;
          world.frameCounter = fresh.frameCounter;
          world.journal = [];
        }

        // Net-effect bookkeeping: only each slot's FINAL recorded paint is
        // asserted (a later overwrite supersedes an earlier step).
        const finalPaintPerSlot = new Map<number, number>();
        fragment.steps.forEach((step, index) => {
          const event = step.event as CanvasAction;
          if (event.op === "paint" && event.slot !== undefined) {
            finalPaintPerSlot.set(event.slot, index);
          }
        });

        const stepResults = fragment.steps.map((step, index) => {
          const event = step.event as CanvasAction;
          if (event.op !== "paint" || event.slot === undefined || !event.color) {
            return { step_index: index, ok: true };
          }
          if (options.mode === "fresh_state") {
            if (!world.activeSlots.has(event.slot)) {
              return { step_index: index, ok: false, classifier_trunk: "identity_lost" };
            }
            world.slots.set(event.slot, event.color);
            return { step_index: index, ok: true };
          }
          // same_state VERIFY-ONLY, net effect per slot.
          if (finalPaintPerSlot.get(event.slot) !== index) {
            return { step_index: index, ok: true }; // superseded later in the trace
          }
          const current = renderWorld(world);
          const measured = dominantHue(current, event.slot);
          const expected = event.color.h;
          const angularDistance = Math.min(
            Math.abs(measured - expected),
            360 - Math.abs(measured - expected),
          );
          const matches = measured >= 0 && angularDistance <= 25; // perceptual tolerance
          return {
            step_index: index,
            ok: matches,
            ...(matches ? {} : { classifier_trunk: "world_changed" }),
          };
        });

        return {
          ok: stepResults.every((stepResult) => stepResult.ok),
          step_results: stepResults,
          final_world_hash: frameHash(world),
        };
      },
    },

    attach: async (request) => ({
      handle_id: `canvas-${request.realm.realm_id}`,
      environment: makeWorld(request.realm.realm_id),
      realm: request.realm,
      recording: null,
    }),
  };

  registerSubstrateAdapter(bundle);

  const schema = makeSchema();

  const hooks = {
    randomAction(_handle: SessionHandle, rand: () => number): CanvasAction {
      const roll = rand();
      if (roll < 0.75) {
        const slot = Math.floor(rand() * SLOT_COUNT);
        return {
          op: "paint",
          slot,
          color: { h: rand() * 360, s: 0.35 + rand() * 0.5, v: 0.45 + rand() * 0.4 },
        };
      }
      return { op: "noop" };
    },

    diffObservations(before: unknown, after: unknown): ChangedValue[] {
      return diffFrames(before as CanvasObservation | null, after as CanvasObservation).map(
        (change) => ({
          ...change,
          semantic_class: resolveSemanticClass(schema, change.path),
        }),
      );
    },

    persistenceTraces(
      handle: SessionHandle,
      _before: unknown,
      after: unknown,
      settleTicks: readonly number[],
    ): PersistenceTrace[] {
      void _before;
      const world = (handle as CanvasHandle).environment;
      const afterObs = after as CanvasObservation;
      const changed = diffFrames(null, afterObs);
      const traces: PersistenceTrace[] = [];
      for (const change of changed) {
        const samples: PersistenceTrace["samples"] = [];
        for (let back = settleTicks.length - 1; back >= 0; back -= 1) {
          const offset = settleTicks[back] as number;
          const entry = world.journal[world.journal.length - 1 - offset];
          if (!entry) continue;
          samples.push({
            tick: offset,
            value: extractPath(entry.snapshot, change.path),
          });
        }
        if (samples.length > 0) traces.push({ path: change.path, samples });
      }
      return traces;
    },

    baselineOf(observation: unknown): Map<string, unknown> {
      return flatten(observation as CanvasObservation);
    },

    mutateAmbient(handle: SessionHandle, _rand: () => number): string | undefined {
      const world = (handle as CanvasHandle).environment;
      world.scanPhase += 1;
      return "frame.scan";
    },

    async makeTwin(handle: SessionHandle, actionThatMattered: unknown): Promise<SessionHandle> {
      const world = (handle as CanvasHandle).environment;
      const clone: CanvasWorld = {
        frameCounter: world.frameCounter,
        scanPhase: world.scanPhase,
        scanPeriod: world.scanPeriod,
        activeSlots: new Set(world.activeSlots),
        slots: new Map(world.slots),
        journal: [],
      };
      const action = actionThatMattered as CanvasAction;
      if (action.op === "paint" && action.slot !== undefined && clone.slots.has(action.slot)) {
        const current = clone.slots.get(action.slot)!;
        // Flip to the opposite side of the hue wheel: the same demonstration
        // must now FAIL its net-effect assertion (discrimination, not lookup).
        clone.slots.set(action.slot, { ...current, h: (current.h + 180) % 360 });
      }
      return { ...handle, handle_id: `${handle.handle_id}-twin`, environment: clone };
    },
  };

  return { bundle, schema: () => schema, hooks };
}
