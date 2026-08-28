/**
 * Key-value state-machine world: a finite string-keyed store with an
 * ambient heartbeat, a hidden secret namespace, stable identity, and a fork
 * provider. Third ontology for the universality proof: no space, no decay —
 * just durable facts.
 *
 * Replay semantics:
 * - same_state = VERIFY-ONLY: effects recorded at teach time must still hold
 *   (set keys still carry their value; deleted keys stay gone).
 * - fresh_state = reset to cold world, re-apply steps, hash.
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

type Value = string | number | boolean;

interface KvObservation {
  tick: number;
  entries: Record<string, Value>; // secrets excluded
}

interface KvWorld {
  tick: number;
  store: Map<string, Value>;
  /** Effects recorded at teach time: key -> expected value ("__deleted__" sentinel). */
  recordedEffects: Map<string, Value | "__deleted__">;
  journal: Array<{ tick: number; snapshot: KvObservation }>;
}

type KvAction =
  | { op: "set"; key: string; value: Value }
  | { op: "delete"; key: string }
  | { op: "noop" };

const SECRET_PREFIX = "secret.";
const KEYSPACE = Array.from({ length: 10 }, (_, i) => `k${i}`);
const HEARTBEAT_KEY = "meta.heartbeat";
const DELETED_SENTINEL = "__deleted__" as const;

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

function makeWorld(realmId: string): KvWorld {
  const rand = mulberry32(hashString(realmId));
  const store = new Map<string, Value>();
  for (const key of KEYSPACE.slice(0, 4)) {
    store.set(key, Math.floor(rand() * 100));
  }
  store.set(HEARTBEAT_KEY, 0);
  store.set("secret.token", `tok-${Math.floor(rand() * 1e6)}`);
  return { tick: 0, store, recordedEffects: new Map(), journal: [] };
}

function advanceAmbient(world: KvWorld): void {
  world.tick += 1;
  const beat = world.store.get(HEARTBEAT_KEY);
  if (typeof beat === "number") world.store.set(HEARTBEAT_KEY, beat + 1);
}

function snapshot(world: KvWorld): KvObservation {
  const entries: Record<string, Value> = {};
  for (const [key, value] of world.store) {
    if (!key.startsWith(SECRET_PREFIX)) entries[key] = value;
  }
  return { tick: world.tick, entries };
}

function observeWorld(world: KvWorld): KvObservation {
  advanceAmbient(world);
  const observation = snapshot(world);
  world.journal.push({ tick: world.tick, snapshot: observation });
  if (world.journal.length > 64) world.journal.shift();
  return observation;
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

function worldHash(world: KvWorld): string {
  const visible: Record<string, Value> = {};
  for (const [key, value] of [...world.store].sort(([a], [b]) => a.localeCompare(b))) {
    if (!key.startsWith(SECRET_PREFIX)) visible[key] = value;
  }
  return djb2Hex(stableStringify({ entries: visible, effects: [...world.recordedEffects] }));
}

function flatten(observation: KvObservation): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  for (const [key, value] of Object.entries(observation.entries)) {
    flat.set(key, value);
  }
  return flat;
}

function diff(before: KvObservation | null, after: KvObservation): ChangedValue[] {
  const beforeFlat = before ? flatten(before) : new Map<string, unknown>();
  const afterFlat = flatten(after);
  const paths = new Set([...beforeFlat.keys(), ...afterFlat.keys()]);
  const changed: ChangedValue[] = [];
  for (const path of paths) {
    if (path.startsWith(SECRET_PREFIX)) continue; // defense in depth
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
    schema_id: "kv.state",
    schema_version: "1.0.0",
    value_types: [
      { path_pattern: HEARTBEAT_KEY, type: { kind: "number", bounds: { min: 0 } }, semantic_class: "ambient" },
      { path_pattern: "*", type: { kind: "string" }, semantic_class: "content" },
    ],
    identity: {
      id_scheme: "stable",
      survives: ["fork", "reset", "restart"],
      reidentification_rule: "keys are the identity",
    },
    observability: {
      fully_observable: false,
      hidden_state: ["secret namespace"],
      policy: "best_effort",
    },
    noise_fingerprints: [{ fingerprint_id: "heartbeat", path_pattern: HEARTBEAT_KEY }],
  };
  const problems = validateWorldStateSchema(schema);
  if (problems.length > 0) {
    throw new Error(`kv schema invalid: ${JSON.stringify(problems)}`);
  }
  return schema;
}

interface KvHandle extends SessionHandle<KvWorld> {
  recording: Array<{ event: KvAction }> | null;
}

export function makeKvAdapter(): FuzzableAdapter {
  const bundle: SubstrateAdapterBundle<KvObservation, KvAction, KvHandle> = {
    substrate_kind: "kv.state",
    adapter_version: "1.0.0",

    observer: {
      channels: ["entries"],
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
        if ("op" in action && action.op === "set") {
          if (!action.key.startsWith(SECRET_PREFIX)) {
            world.store.set(action.key, action.value);
            world.recordedEffects.set(action.key, action.value);
            ok = true;
          }
        } else if ("op" in action && action.op === "delete") {
          if (!action.key.startsWith(SECRET_PREFIX)) {
            world.store.delete(action.key);
            world.recordedEffects.set(action.key, DELETED_SENTINEL);
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
        return { trace_id: `kv-${handle.handle_id}`, steps };
      },
    },

    reset_provider: {
      resetProfiles: ["cold"],
      reset: async (handle) => {
        const fresh = makeWorld(handle.realm.realm_id);
        handle.environment.store = fresh.store;
        handle.environment.recordedEffects = fresh.recordedEffects;
        handle.environment.tick = fresh.tick;
        handle.environment.journal = [];
      },
    },

    fork_provider: {
      fork: async (handle) => {
        const source = handle.environment;
        const clone = makeWorld(handle.realm.realm_id);
        clone.store = new Map(source.store);
        clone.recordedEffects = new Map(source.recordedEffects);
        clone.tick = source.tick;
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
        const handle = options.handle as KvHandle;
        const world = handle.environment;

        if (options.mode === "fresh_state") {
          const fresh = makeWorld(handle.realm.realm_id);
          world.store = fresh.store;
          world.recordedEffects = new Map();
          world.tick = fresh.tick;
          world.journal = [];
        }

        // Net effects: for each key touched by the fragment, the index of the
        // step that produced its final recorded effect.
        const finalEffects = new Map<string, number>();
        fragment.steps.forEach((step, index) => {
          const event = step.event as KvAction;
          if ("op" in event && (event.op === "set" || event.op === "delete")) {
            finalEffects.set(event.key, index);
          }
        });

        const stepResults = fragment.steps.map((step, index) => {
          const event = step.event as KvAction;
          if ("op" in event && event.op === "set") {
            if (options.mode === "fresh_state") {
              world.store.set(event.key, event.value);
              world.recordedEffects.set(event.key, event.value);
              return { step_index: index, ok: true };
            }
            // Verify-only: an earlier effect on a key later overwritten or
            // deleted is superseded - only the FINAL effect per key must
            // still hold in the current state (net-effect assertions).
            const finalEffect = finalEffects.get(event.key);
            if (finalEffect !== index) return { step_index: index, ok: true };
            const current = world.store.get(event.key);
            return {
              step_index: index,
              ok: current === event.value,
              classifier_trunk: current !== event.value ? "world_changed" : undefined,
            };
          }
          if ("op" in event && event.op === "delete") {
            if (options.mode === "fresh_state") {
              world.store.delete(event.key);
              world.recordedEffects.set(event.key, DELETED_SENTINEL);
              return { step_index: index, ok: true };
            }
            const finalEffect = finalEffects.get(event.key);
            if (finalEffect !== index) return { step_index: index, ok: true };
            const gone = !world.store.has(event.key);
            return {
              step_index: index,
              ok: gone,
              classifier_trunk: gone ? undefined : "world_changed",
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
      handle_id: `kv-${request.realm.realm_id}`,
      environment: makeWorld(request.realm.realm_id),
      realm: request.realm,
      recording: null,
    }),
  };

  registerSubstrateAdapter(bundle);

  const schema = makeSchema();

  const randomValue = (rand: () => number): Value => {
    const roll = rand();
    if (roll < 0.4) return Math.floor(rand() * 100);
    if (roll < 0.7) return `v-${Math.floor(rand() * 1000)}`;
    return rand() < 0.5;
  };

  const hooks = {
    randomAction(_handle: SessionHandle, rand: () => number): KvAction {
      const roll = rand();
      const key = KEYSPACE[Math.floor(rand() * KEYSPACE.length)]!;
      if (roll < 0.45) return { op: "set", key, value: randomValue(rand) };
      if (roll < 0.7) return { op: "delete", key };
      return { op: "noop" };
    },

    diffObservations(before: unknown, after: unknown): ChangedValue[] {
      return diff(before as KvObservation | null, after as KvObservation).map((change) => ({
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
      const world = (handle as KvHandle).environment;
      const afterObs = after as KvObservation;
      const changed = diff(null, afterObs);
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
      return flatten(observation as KvObservation);
    },

    mutateAmbient(handle: SessionHandle, _rand: () => number): string | undefined {
      const world = (handle as KvHandle).environment;
      const beat = world.store.get(HEARTBEAT_KEY);
      if (typeof beat === "number") world.store.set(HEARTBEAT_KEY, beat + 1);
      return HEARTBEAT_KEY;
    },

    async makeTwin(handle: SessionHandle, actionThatMattered: unknown): Promise<SessionHandle> {
      const world = (handle as KvHandle).environment;
      const twin = makeWorld(handle.realm.realm_id + "-twin");
      twin.store = new Map(world.store);
      twin.tick = world.tick;
      // Invert exactly the semantic effect of the recorded action.
      if ("op" in (actionThatMattered as KvAction)) {
        const action = actionThatMattered as KvAction;
        if (action.op === "set") {
          twin.store.set(action.key, `twin-${String(world.store.get(action.key))}`);
        } else if (action.op === "delete") {
          twin.store.set(action.key, randomValue(mulberry32(hashString(action.key))));
        }
      }
      return { ...handle, handle_id: `${handle.handle_id}-twin`, environment: twin };
    },
  };

  return { bundle, schema: () => schema, hooks };
}
