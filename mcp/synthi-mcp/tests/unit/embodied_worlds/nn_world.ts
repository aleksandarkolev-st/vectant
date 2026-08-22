/**
 * Neural-network-like world: a tiny feedforward activation network (3 layers
 * x width 4) with decaying activations, weighted propagation through hidden
 * biases, background input pulses (ambient), session-scoped identity, and
 * NO fork provider (proving the harness's control-world attribution works
 * for substrates without forks).
 *
 * Replay semantics:
 * - same_state = VERIFY-ONLY: a fired node's effect signature must still be
 *   present (target node alive or positive-weight downstream neighbors lit).
 * - fresh_state = zero activations, re-apply fires, hash. Double fresh
 *   replays hash identically.
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

const LAYERS = 3;
const WIDTH = 4;
const DECAY = 0.98;
const PULSE_AMOUNT = 0.5;

type Activations = number[][]; // [layer][node]

interface NnObservation {
  tick: number;
  activations: Activations;
}

interface NnWorld {
  tick: number;
  activations: Activations;
  weights: number[][][]; // [from-layer][from][to]
  /** Hidden per-layer bias terms: never exposed in observations. */
  biases: number[];
  journal: Array<{ tick: number; snapshot: NnObservation }>;
}

type NnAction = { fire: string } | { op: "noop" };

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

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function makeWorld(realmId: string): NnWorld {
  const rand = mulberry32(hashString(realmId));
  const weights: number[][][] = [];
  for (let layer = 0; layer < LAYERS - 1; layer += 1) {
    const matrix: number[][] = [];
    for (let from = 0; from < WIDTH; from += 1) {
      const row: number[] = [];
      for (let to = 0; to < WIDTH; to += 1) {
        row.push(round3(rand() * 2 - 1));
      }
      matrix.push(row);
    }
    weights.push(matrix);
  }
  return {
    tick: 0,
    activations: Array.from({ length: LAYERS }, () => Array.from({ length: WIDTH }, () => 0)),
    weights,
    biases: Array.from({ length: LAYERS }, () => round3(rand())),
    journal: [],
  };
}

/** One internal tick: ambient pulse on inputs, decay, biased propagation. */
function advance(world: NnWorld): void {
  world.tick += 1;

  const pulsedNode = world.tick % WIDTH;
  world.activations[0]![pulsedNode] = clamp01(
    world.activations[0]![pulsedNode]! + PULSE_AMOUNT,
  );

  for (let layer = 0; layer < LAYERS; layer += 1) {
    for (let node = 0; node < WIDTH; node += 1) {
      world.activations[layer]![node] = round3(
        clamp01(world.activations[layer]![node]! * DECAY),
      );
    }
  }

  const propagated: Activations = world.activations.map((layerActivations) => [...layerActivations]);
  for (let layer = 0; layer < LAYERS - 1; layer += 1) {
    for (let to = 0; to < WIDTH; to += 1) {
      let sum = 0;
      for (let from = 0; from < WIDTH; from += 1) {
        sum += world.activations[layer]![from]! * world.weights[layer]![from]![to]!;
      }
      const biased = sum - world.biases[layer + 1]!;
      if (biased > 0) {
        propagated[layer + 1]![to] = clamp01(propagated[layer + 1]![to]! + round3(biased));
      }
    }
  }
  world.activations = propagated.map((layerActivations) => layerActivations.map(round3));
}

function observeWorld(world: NnWorld): NnObservation {
  advance(world);
  const observation: NnObservation = {
    tick: world.tick,
    activations: world.activations.map((l) => [...l]),
  };
  world.journal.push({ tick: observation.tick, snapshot: observation });
  if (world.journal.length > 64) world.journal.shift();
  return observation;
}

function flatten(observation: NnObservation): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  for (let layer = 0; layer < LAYERS; layer += 1) {
    for (let node = 0; node < WIDTH; node += 1) {
      flat.set(`nodes.${layer}.${node}.activation`, observation.activations[layer]![node]);
    }
  }
  return flat;
}

function diff(before: NnObservation | null, after: NnObservation): ChangedValue[] {
  const beforeFlat = before ? flatten(before) : new Map<string, unknown>();
  const afterFlat = flatten(after);
  const changed: ChangedValue[] = [];
  for (const [path, afterValue] of afterFlat) {
    const beforeValue = beforeFlat.get(path);
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

function makeSchema(): WorldStateSchema {
  const schema: WorldStateSchema = {
    schema_id: "nn.world",
    schema_version: "1.0.0",
    value_types: [
      { path_pattern: "nodes.*.activation", type: { kind: "band", min: 0, max: 1 }, semantic_class: "state_flag" },
    ],
    identity: {
      id_scheme: "session",
      survives: ["fork"],
      reidentification_rule: "fixed topology coordinates",
    },
    observability: {
      fully_observable: false,
      hidden_state: ["per-layer bias terms"],
      policy: "best_effort",
    },
    noise_fingerprints: [{ fingerprint_id: "input-pulse", path_pattern: "nodes.0.*.activation" }],
  };
  const problems = validateWorldStateSchema(schema);
  if (problems.length > 0) {
    throw new Error(`nn schema invalid: ${JSON.stringify(problems)}`);
  }
  return schema;
}

interface NnHandle extends SessionHandle<NnWorld> {
  recording: Array<{ event: NnAction }> | null;
}

function parseFireRef(actionThatMattered: unknown): { layer: number; node: number } | undefined {
  if (actionThatMattered && typeof actionThatMattered === "object" && "fire" in actionThatMattered) {
    const parts = (actionThatMattered as { fire: string }).fire.split(".");
    const layer = Number(parts[1]);
    const node = Number(parts[2]);
    if (Number.isInteger(layer) && Number.isInteger(node)) return { layer, node };
  }
  return undefined;
}

export function makeNnAdapter(): FuzzableAdapter {
  const bundle: SubstrateAdapterBundle<NnObservation, NnAction, NnHandle> = {
    substrate_kind: "nn.world",
    adapter_version: "1.0.0",

    observer: {
      channels: ["activations"],
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
        if ("fire" in action) {
          const parsed = parseFireRef(action);
          if (
            parsed &&
            parsed.layer >= 0 &&
            parsed.layer <= LAYERS - 2 && // output layer is not fireable
            parsed.node >= 0 &&
            parsed.node < WIDTH
          ) {
            world.activations[parsed.layer]![parsed.node] = 1;
            advance(world);
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
        return { trace_id: `nn-${handle.handle_id}`, steps };
      },
    },

    reset_provider: {
      resetProfiles: ["cold"],
      reset: async (handle) => {
        const fresh = makeWorld(handle.realm.realm_id);
        handle.environment.activations = fresh.activations;
        handle.environment.tick = fresh.tick;
        handle.environment.journal = [];
      },
    },

    replay_provider: {
      replay: async (fragment, options) => {
        const handle = options.handle as NnHandle;
        const world = handle.environment;
        if (options.mode === "fresh_state") {
          world.activations = Array.from({ length: LAYERS }, () =>
            Array.from({ length: WIDTH }, () => 0),
          );
          world.tick = 0;
          world.journal = [];
        }
        const stepResults = fragment.steps.map((step, index) => {
          const event = step.event as NnAction;
          if ("fire" in event) {
            if (options.mode === "fresh_state") {
              const parsed = parseFireRef(event);
              if (parsed && parsed.layer <= LAYERS - 2 && parsed.node < WIDTH) {
                world.activations[parsed.layer]![parsed.node] = 1;
              }
              advance(world);
              return { step_index: index, ok: true };
            }
            // VERIFY-ONLY in same_state: effect signature must still hold.
            const parsed = parseFireRef(event);
            let ok = false;
            if (parsed) {
              const targetAlive = (world.activations[parsed.layer]?.[parsed.node] ?? 0) > 0.05;
              let downstreamAlive = false;
              if (parsed.layer + 1 < LAYERS) {
                for (let to = 0; to < WIDTH; to += 1) {
                  const weight = world.weights[parsed.layer]?.[parsed.node]?.[to] ?? 0;
                  if (weight > 0 && (world.activations[parsed.layer + 1]?.[to] ?? 0) > 0.05) {
                    downstreamAlive = true;
                    break;
                  }
                }
              }
              ok = targetAlive || downstreamAlive;
            }
            advance(world);
            return {
              step_index: index,
              ok,
              classifier_trunk: ok ? undefined : "perception_drift",
            };
          }
          advance(world);
          return { step_index: index, ok: true };
        });
        return {
          ok: stepResults.every((stepResult) => stepResult.ok),
          step_results: stepResults,
          final_world_hash: djb2Hex(stableStringify(world.activations.map((l) => l.map(round3)))),
        };
      },
    },

    attach: async (request) => ({
      handle_id: `nn-${request.realm.realm_id}`,
      environment: makeWorld(request.realm.realm_id),
      realm: request.realm,
      recording: null,
    }),
  };

  registerSubstrateAdapter(bundle);

  const schema = makeSchema();

  const hooks = {
    randomAction(_handle: SessionHandle, rand: () => number): NnAction {
      if (rand() < 0.85) {
        const layer = Math.floor(rand() * (LAYERS - 1));
        const node = Math.floor(rand() * WIDTH);
        return { fire: `nodes.${layer}.${node}` };
      }
      return { op: "noop" };
    },

    diffObservations(before: unknown, after: unknown): ChangedValue[] {
      return diff(before as NnObservation | null, after as NnObservation).map((change) => ({
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
      const world = (handle as NnHandle).environment;
      const afterObs = after as NnObservation;
      const changed = diff(null, afterObs).filter((change) => change.path.startsWith("nodes."));
      const traces: PersistenceTrace[] = [];
      for (const change of changed) {
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
      return flatten(observation as NnObservation);
    },

    mutateAmbient(handle: SessionHandle, _rand: () => number): string | undefined {
      const world = (handle as NnHandle).environment;
      const node = world.tick % WIDTH;
      world.activations[0]![node] = clamp01(world.activations[0]![node]! + PULSE_AMOUNT);
      return `nodes.0.${node}.activation`;
    },

    async makeTwin(handle: SessionHandle, actionThatMattered: unknown): Promise<SessionHandle> {
      const world = (handle as NnHandle).environment;
      const twin = makeWorld(handle.realm.realm_id + "-twin");
      twin.activations = world.activations.map((l) => [...l]);
      twin.tick = world.tick;
      twin.weights = world.weights.map((m) => m.map((r) => [...r]));
      twin.biases = [...world.biases];
      // Model a world where this causal pathway does not exist: the fired
      // node is dead, its immediate downstream layer is dark, and its
      // outgoing weights are zeroed. Equivalent world except the pathway
      // the competency relies on - the NN analog of a repainted landmark.
      const parsed = parseFireRef(actionThatMattered);
      if (parsed && parsed.layer < LAYERS - 1) {
        twin.activations[parsed.layer]![parsed.node] = 0;
        twin.activations[parsed.layer + 1] = Array.from({ length: WIDTH }, () => 0);
        twin.weights[parsed.layer]![parsed.node] = Array.from({ length: WIDTH }, () => 0);
      }
      return { ...handle, handle_id: `${handle.handle_id}-twin`, environment: twin };
    },
  };

  return { bundle, schema: () => schema, hooks };
}
