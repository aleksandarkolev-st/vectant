/**
 * Spatial grid world: conformance fixture closest to the plan's continuous
 * semantics. Seeded grids contain generic entities with positions and
 * color-family enums randomized per seed; an agent moves (toleranced),
 * turns, and inspects entities. Wanderers drift on their own schedules
 * (ambient); a secret counter is declared hidden state.
 *
 * Replay semantics (the part that makes discrimination meaningful):
 * - same_state = VERIFY-ONLY: recorded inspection verdicts must still match
 *   the current world. Nothing is re-applied, nothing advances.
 * - fresh_state = reset to the cold world, re-apply steps, verify trivially,
 *   hash the result. Double fresh replays hash identically.
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

const GRID_SIZE = 20;
const COLOR_FAMILIES = ["c0", "c1", "c2", "c3", "c4", "c5"] as const;
type ColorFamily = (typeof COLOR_FAMILIES)[number];

interface Entity {
  id: string;
  x: number;
  y: number;
  family: ColorFamily;
}

interface Wanderer {
  id: string;
  x: number;
  y: number;
  period: number;
}

interface Observation {
  tick: number;
  entities: Array<{ id: string; x: number; y: number; family: ColorFamily }>;
  wanderers: Array<{ id: string; x: number; y: number }>;
  agent: { x: number; y: number; facing: number };
}

interface GridWorld {
  tick: number;
  entities: Entity[];
  wanderers: Wanderer[];
  agent: { x: number; y: number; facing: number };
  /** Hidden: never exposed in observations or diffs. */
  secretScore: number;
  /** Verdicts recorded by inspections: entity_id -> family seen. */
  inspectionVerdicts: Map<string, ColorFamily>;
  /** Snapshots appended at every observe(); used for persistence sampling. */
  journal: Array<{ tick: number; snapshot: Observation }>;
}

type GridAction =
  | { move: { dx: number; dy: number; tolerance: number } }
  | { turn: { delta: number; tolerance: number } }
  | { inspect: { entity_id: string } }
  | { op: "noop" };

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
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeWorld(realmId: string): GridWorld {
  const rand = mulberry32(hashString(realmId));
  const entityCount = 3 + Math.floor(rand() * 4);
  const entities: Entity[] = [];
  for (let i = 0; i < entityCount; i += 1) {
    entities.push({
      id: `ent-${i}`,
      x: Math.floor(rand() * GRID_SIZE),
      y: Math.floor(rand() * GRID_SIZE),
      family: COLOR_FAMILIES[Math.floor(rand() * COLOR_FAMILIES.length)] as ColorFamily,
    });
  }
  const wanderers: Wanderer[] = [];
  for (let i = 0; i < 2; i += 1) {
    wanderers.push({
      id: `wander-${i}`,
      x: Math.floor(rand() * GRID_SIZE),
      y: Math.floor(rand() * GRID_SIZE),
      period: 2 + Math.floor(rand() * 3),
    });
  }
  return {
    tick: 0,
    entities,
    wanderers,
    agent: {
      x: Math.floor(rand() * GRID_SIZE),
      y: Math.floor(rand() * GRID_SIZE),
      facing: Math.floor(rand() * 360),
    },
    secretScore: Math.floor(rand() * 1000),
    inspectionVerdicts: new Map(),
    journal: [],
  };
}

/** Ambient motion: wanderers drift, secret counter accrues. */
function advanceAmbient(world: GridWorld): void {
  world.tick += 1;
  for (const wanderer of world.wanderers) {
    if (world.tick % wanderer.period === 0) {
      wanderer.x = (wanderer.x + 1) % GRID_SIZE;
    }
  }
  world.secretScore = (world.secretScore + 7) % 1000;
}

function snapshot(world: GridWorld): Observation {
  return {
    tick: world.tick,
    entities: world.entities.map((entity) => ({ ...entity })),
    wanderers: world.wanderers.map((wanderer) => ({ ...wanderer })),
    agent: { ...world.agent },
  };
}

function observeWorld(world: GridWorld): Observation {
  advanceAmbient(world);
  const observation = snapshot(world);
  world.journal.push({ tick: world.tick, snapshot: observation });
  if (world.journal.length > 64) world.journal.shift();
  return observation;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(GRID_SIZE - 1, value));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return Object.fromEntries(
        Object.entries(inner).sort(([a], [b]) => String(a).localeCompare(String(b))),
      );
    }
    return inner;
  });
}

function djb2Hex(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (((hash << 5) + hash + text.charCodeAt(i)) >>> 0) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function worldHash(world: GridWorld): string {
  return djb2Hex(
    stableStringify({
      e: world.entities,
      a: world.agent,
      w: world.wanderers,
      v: [...world.inspectionVerdicts.entries()].sort(([a], [b]) => a.localeCompare(b)),
    }),
  );
}

function flatten(observation: Observation): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  for (const entity of observation.entities) {
    flat.set(`entities.${entity.id}.x`, entity.x);
    flat.set(`entities.${entity.id}.y`, entity.y);
    flat.set(`entities.${entity.id}.family`, entity.family);
  }
  for (const wanderer of observation.wanderers) {
    flat.set(`wanderers.${wanderer.id}.x`, wanderer.x);
    flat.set(`wanderers.${wanderer.id}.y`, wanderer.y);
  }
  flat.set("agent.x", observation.agent.x);
  flat.set("agent.y", observation.agent.y);
  flat.set("agent.facing", observation.agent.facing);
  return flat;
}

function diff(before: Observation | null, after: Observation): ChangedValue[] {
  const beforeFlat = before ? flatten(before) : new Map<string, unknown>();
  const afterFlat = flatten(after);
  const paths = new Set([...beforeFlat.keys(), ...afterFlat.keys()]);
  const changed: ChangedValue[] = [];
  for (const path of paths) {
    const beforeValue = beforeFlat.get(path);
    const afterValue = afterFlat.get(path);
    if (beforeValue !== afterValue) {
      changed.push({
        path,
        semantic_class: "",
        before: beforeValue,
        after: afterValue,
        changed_at_tick: after.tick,
      });
    }
  }
  return changed;
}

function makeSchema(): WorldStateSchema {
  const schema: WorldStateSchema = {
    schema_id: "grid.world",
    schema_version: "1.0.0",
    value_types: [
      { path_pattern: "entities.*.family", type: { kind: "enum", values: [...COLOR_FAMILIES] }, semantic_class: "material" },
      { path_pattern: "entities.*.x", type: { kind: "band", min: 0, max: GRID_SIZE - 1, unit: "cell" }, semantic_class: "transform" },
      { path_pattern: "entities.*.y", type: { kind: "band", min: 0, max: GRID_SIZE - 1, unit: "cell" }, semantic_class: "transform" },
      { path_pattern: "wanderers.*.x", type: { kind: "band", min: 0, max: GRID_SIZE - 1, unit: "cell" }, semantic_class: "ambient" },
      { path_pattern: "agent.*", type: { kind: "number" }, semantic_class: "transform" },
    ],
    identity: {
      id_scheme: "stable",
      survives: ["fork", "reset", "restart"],
      reidentification_rule: "entity ids are stable within a realm",
    },
    observability: {
      fully_observable: false,
      hidden_state: ["secret score counter"],
      policy: "best_effort",
    },
    noise_fingerprints: [{ fingerprint_id: "wander-drift", path_pattern: "wanderers.*.x" }],
  };
  const problems = validateWorldStateSchema(schema);
  if (problems.length > 0) {
    throw new Error(`grid schema invalid: ${JSON.stringify(problems)}`);
  }
  return schema;
}

interface GridHandle extends SessionHandle<GridWorld> {
  recording: Array<{ event: GridAction }> | null;
}

export function makeGridAdapter(): FuzzableAdapter {
  const bundle: SubstrateAdapterBundle<Observation, GridAction, GridHandle> = {
    substrate_kind: "grid.world",
    adapter_version: "1.0.0",

    observer: {
      channels: ["state"],
      describeWorldSchema: () => makeSchema(),
      observe: async (handle) => observeWorld(handle.environment),
    },

    actor: {
      act: async (handle, action, leaseProof) => {
        const world = handle.environment;
        if (leaseProof.expires_at_ms <= world.tick) {
          return { ok: false, refusal_reason: "lease expired" };
        }
        if (leaseProof.realm.realm_id !== handle.realm.realm_id) {
          return { ok: false, refusal_reason: "realm mismatch" };
        }
        let ok = false;
        if ("move" in action) {
          world.agent.x = clamp(world.agent.x + action.move.dx);
          world.agent.y = clamp(world.agent.y + action.move.dy);
          ok = true;
        } else if ("turn" in action) {
          world.agent.facing = (((world.agent.facing + action.turn.delta) % 360) + 360) % 360;
          ok = true;
        } else if ("inspect" in action) {
          const entity = world.entities.find((candidate) => candidate.id === action.inspect.entity_id);
          if (entity) {
            world.inspectionVerdicts.set(entity.id, entity.family);
            ok = true;
          }
        } else {
          ok = true;
        }
        if (ok && handle.recording) handle.recording.push({ event: action });
        return { ok, applied_tick: world.tick };
      },
    },

    recorder: {
      beginRecord: (handle) => {
        handle.recording = [];
      },
      endRecord: (handle) => {
        const steps = (handle.recording ?? []).map((entry) => ({ event: entry.event }));
        handle.recording = null;
        return { trace_id: `grid-${handle.handle_id}`, steps };
      },
    },

    reset_provider: {
      resetProfiles: ["cold"],
      reset: async (handle) => {
        const fresh = makeWorld(handle.realm.realm_id);
        handle.environment.entities = fresh.entities;
        handle.environment.wanderers = fresh.wanderers;
        handle.environment.agent = fresh.agent;
        handle.environment.tick = fresh.tick;
        handle.environment.inspectionVerdicts = fresh.inspectionVerdicts;
        handle.environment.journal = [];
      },
    },

    fork_provider: {
      fork: async (handle) => {
        const source = handle.environment;
        const clone = makeWorld(handle.realm.realm_id);
        clone.entities = source.entities.map((entity) => ({ ...entity }));
        clone.wanderers = source.wanderers.map((wanderer) => ({ ...wanderer }));
        clone.agent = { ...source.agent };
        clone.tick = source.tick;
        clone.secretScore = source.secretScore;
        clone.inspectionVerdicts = new Map(source.inspectionVerdicts);
        clone.journal = [];
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
        const handle = options.handle as GridHandle;
        const world = handle.environment;

        if (options.mode === "fresh_state") {
          const fresh = makeWorld(handle.realm.realm_id);
          world.entities = fresh.entities;
          world.wanderers = fresh.wanderers;
          world.agent = fresh.agent;
          world.tick = fresh.tick;
          world.inspectionVerdicts = fresh.inspectionVerdicts;
          world.journal = [];
        }

        const stepResults = fragment.steps.map((step, index) => {
          const event = step.event as GridAction;
          if ("move" in event) {
            if (options.mode === "fresh_state") {
              world.agent.x = clamp(world.agent.x + event.move.dx);
              world.agent.y = clamp(world.agent.y + event.move.dy);
            }
            return { step_index: index, ok: true };
          }
          if ("turn" in event) {
            if (options.mode === "fresh_state") {
              world.agent.facing = (((world.agent.facing + event.turn.delta) % 360) + 360) % 360;
            }
            return { step_index: index, ok: true };
          }
          if ("inspect" in event) {
            // VERIFY-ONLY in same_state: the verdict recorded at teach time
            // must still describe the world. This is what makes twins fail.
            const recorded = world.inspectionVerdicts.get(event.inspect.entity_id);
            const entity = world.entities.find(
              (candidate) => candidate.id === event.inspect.entity_id,
            );
            if (options.mode === "fresh_state") {
              if (entity) world.inspectionVerdicts.set(entity.id, entity.family);
              return { step_index: index, ok: Boolean(entity) };
            }
            return {
              step_index: index,
              ok: Boolean(recorded) && recorded === entity?.family,
              classifier_trunk: recorded !== entity?.family ? "perception_drift" : undefined,
            };
          }
          return { step_index: index, ok: true };
        });

        return {
          ok: stepResults.every((stepResult) => stepResult.ok),
          step_results: stepResults,
          final_world_hash: worldHash(world),
        };
      },
    },

    attach: async (request) => ({
      handle_id: `grid-${request.realm.realm_id}`,
      environment: makeWorld(request.realm.realm_id),
      realm: request.realm,
      recording: null,
    }),
  };

  registerSubstrateAdapter(bundle);

  const schema = makeSchema();

  const hooks = {
    randomAction(handle: SessionHandle, rand: () => number): GridAction {
      const world = (handle as GridHandle).environment;
      const roll = rand();
      if (roll < 0.35) {
        const entity = world.entities[Math.floor(rand() * world.entities.length)]!;
        const dx = Math.sign(entity.x - world.agent.x) * (rand() < 0.8 ? 1 : 0);
        const dy = Math.sign(entity.y - world.agent.y) * (rand() < 0.8 ? 1 : 0);
        return { move: { dx, dy, tolerance: 1 } };
      }
      if (roll < 0.55) {
        return { turn: { delta: Math.floor(rand() * 360), tolerance: 5 } };
      }
      if (roll < 0.9) {
        const entity = world.entities[Math.floor(rand() * world.entities.length)]!;
        return { inspect: { entity_id: entity.id } };
      }
      return { op: "noop" };
    },

    diffObservations(before: unknown, after: unknown): ChangedValue[] {
      return diff(before as Observation | null, after as Observation).map((change) => ({
        ...change,
        semantic_class: resolveSemanticClass(schema, change.path),
      }));
    },

    persistenceTraces(
      handle: SessionHandle,
      before: unknown,
      after: unknown,
      settleTicks: readonly number[],
    ): PersistenceTrace[] {
      void before;
      const world = (handle as GridHandle).environment;
      const afterObs = after as Observation;
      const changed = diff(null, afterObs);
      const traces: PersistenceTrace[] = [];
      for (const change of changed) {
        // Oldest -> newest so the final sample is the freshest state.
        const samples: PersistenceTrace["samples"] = [];
        for (let back = settleTicks.length - 1; back >= 0; back -= 1) {
          const offset = settleTicks[back] as number;
          const entry = world.journal[world.journal.length - 1 - offset];
          if (!entry) continue;
          samples.push({
            tick: offset,
            value: flatten(entry.snapshot).get(change.path),
          });
        }
        if (samples.length > 0) traces.push({ path: change.path, samples });
      }
      return traces;
    },

    baselineOf(observation: unknown): Map<string, unknown> {
      return flatten(observation as Observation);
    },

    mutateAmbient(handle: SessionHandle, rand: () => number): string | undefined {
      const world = (handle as GridHandle).environment;
      const wanderer = world.wanderers[Math.floor(rand() * world.wanderers.length)];
      if (!wanderer) return undefined;
      wanderer.x = (wanderer.x + 1) % GRID_SIZE;
      return `wanderers.${wanderer.id}.x`;
    },

    async makeTwin(handle: SessionHandle, actionThatMattered: unknown): Promise<SessionHandle> {
      const world = (handle as GridHandle).environment;
      const twin = makeWorld(handle.realm.realm_id + "-twin");
      twin.entities = world.entities.map((entity) => ({ ...entity }));
      twin.wanderers = world.wanderers.map((wanderer) => ({ ...wanderer }));
      twin.agent = { ...world.agent };
      twin.tick = world.tick;
      twin.inspectionVerdicts = new Map(world.inspectionVerdicts);
      // Invert exactly the semantic effect: flip the inspected entity's family.
      if (
        actionThatMattered &&
        typeof actionThatMattered === "object" &&
        "inspect" in actionThatMattered
      ) {
        const wanted = actionThatMattered as { inspect: { entity_id: string } };
        const target = twin.entities.find((entity) => entity.id === wanted.inspect.entity_id);
        if (target) {
          const currentIndex = COLOR_FAMILIES.indexOf(target.family);
          target.family = COLOR_FAMILIES[(currentIndex + 1) % COLOR_FAMILIES.length] as ColorFamily;
        }
      }
      return { ...handle, handle_id: `${handle.handle_id}-twin`, environment: twin };
    },
  };

  return { bundle, schema: () => schema, hooks };
}
