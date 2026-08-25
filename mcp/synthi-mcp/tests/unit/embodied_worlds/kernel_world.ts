/**
 * Kernel namespace world: a container-style unit table (active / stopped /
 * failed) with per-unit open-fd counters, a timer-interrupt ambience, a slow
 * fd leak on one unit, and a hidden ring buffer. Another ontology for the
 * universality proof: no space, no store — just process supervision.
 *
 * Replay semantics:
 * - same_state = VERIFY-ONLY: effects recorded at teach time must still hold
 *   (restarted units still run; stopped units stay down) - net effects per
 *   unit, superseded intermediate steps are skipped.
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

type UnitState = "active" | "stopped" | "failed";

interface KernelObservation {
  tick: number;
  entries: Record<string, string | number>; // ring buffer excluded
}

interface KernelWorld {
  tick: number;
  /** Unit name -> lifecycle state. */
  units: Map<string, UnitState>;
  /** Unit name -> open fd count. */
  fdCount: Map<string, number>;
  /** Timer interrupts since attach: pure ambient clockwork. */
  interrupts: number;
  /** Hidden per-tick ring buffer: exists, never exposed to observers. */
  ring: string[];
  journal: Array<{ tick: number; snapshot: KernelObservation }>;
}

type KernelAction =
  | { sys: "restart"; unit: string }
  | { sys: "stop"; unit: string }
  | { op: "noop" };

const UNIT_NAMES = ["svc0", "svc1", "svc2"] as const;
/** svc1 leaks one fd per observation tick: REAL drift, never declared noise. */
const LEAKY_UNIT = "svc1";
const INTERRUPTS_PATH = "sys.interrupts";

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

function makeWorld(realmId: string): KernelWorld {
  const rand = mulberry32(hashString(realmId));
  const units = new Map<string, UnitState>();
  const fdCount = new Map<string, number>();
  for (const name of UNIT_NAMES) {
    units.set(name, "active");
    fdCount.set(name, 10 + Math.floor(rand() * 31)); // 10..40 seeded fds
  }
  return { tick: 0, units, fdCount, interrupts: 0, ring: [], journal: [] };
}

function advanceAmbient(world: KernelWorld): void {
  world.tick += 1;
  world.interrupts += 1;
  const leaked = world.fdCount.get(LEAKY_UNIT);
  if (typeof leaked === "number") world.fdCount.set(LEAKY_UNIT, leaked + 1);
  world.ring.push(`tick-${world.tick}`);
  if (world.ring.length > 64) world.ring.shift();
}

function snapshot(world: KernelWorld): KernelObservation {
  const entries: Record<string, string | number> = {};
  for (const name of UNIT_NAMES) {
    entries[`units.${name}.state`] = world.units.get(name) ?? "failed";
    entries[`units.${name}.fds`] = world.fdCount.get(name) ?? 0;
  }
  entries[INTERRUPTS_PATH] = world.interrupts;
  return { tick: world.tick, entries };
}

function observeWorld(world: KernelWorld): KernelObservation {
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

function worldHash(world: KernelWorld): string {
  const u = [...world.units].sort(([a], [b]) => a.localeCompare(b));
  const f = [...world.fdCount].sort(([a], [b]) => a.localeCompare(b));
  return djb2Hex(stableStringify({ u, f, i: world.interrupts }));
}

function flatten(observation: KernelObservation): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  for (const [key, value] of Object.entries(observation.entries)) {
    flat.set(key, value);
  }
  return flat;
}

function diff(before: KernelObservation | null, after: KernelObservation): ChangedValue[] {
  const beforeFlat = before ? flatten(before) : new Map<string, unknown>();
  const afterFlat = flatten(after);
  const paths = new Set([...beforeFlat.keys(), ...afterFlat.keys()]);
  const changed: ChangedValue[] = [];
  for (const path of paths) {
    // The ring buffer is never exposed, so it can never appear here.
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
    schema_id: "kernel.ns.state",
    schema_version: "1.0.0",
    value_types: [
      {
        path_pattern: "units.*.state",
        type: { kind: "enum", values: ["active", "stopped", "failed"] },
        semantic_class: "state_flag",
      },
      {
        path_pattern: "units.*.fds",
        type: { kind: "number", bounds: { min: 0 } },
        semantic_class: "counter",
      },
      {
        path_pattern: INTERRUPTS_PATH,
        type: { kind: "number", bounds: { min: 0 } },
        semantic_class: "ambient",
      },
    ],
    identity: {
      id_scheme: "stable",
      survives: ["fork", "reset"],
      reidentification_rule: "unit names are identity",
    },
    observability: {
      fully_observable: false,
      hidden_state: ["kernel ring buffer"],
      policy: "best_effort",
    },
    noise_fingerprints: [{ fingerprint_id: "timer-interrupts", path_pattern: INTERRUPTS_PATH }],
  };
  const problems = validateWorldStateSchema(schema);
  if (problems.length > 0) {
    throw new Error(`kernel schema invalid: ${JSON.stringify(problems)}`);
  }
  return schema;
}

interface KernelHandle extends SessionHandle<KernelWorld> {
  recording: Array<{ event: KernelAction }> | null;
}

export function makeKernelAdapter(): FuzzableAdapter {
  const bundle: SubstrateAdapterBundle<KernelObservation, KernelAction, KernelHandle> = {
    substrate_kind: "kernel.ns",
    adapter_version: "1.0.0",

    observer: {
      channels: ["units"],
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
        if ("sys" in action && action.sys === "restart") {
          if (!world.units.has(action.unit)) {
            return { ok: false, refusal_reason: "no such unit" };
          }
          world.units.set(action.unit, "active");
          world.fdCount.set(action.unit, 0); // restart releases fds
          ok = true;
        } else if ("sys" in action && action.sys === "stop") {
          if (!world.units.has(action.unit)) {
            return { ok: false, refusal_reason: "no such unit" };
          }
          world.units.set(action.unit, "stopped");
          ok = true;
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
        return { trace_id: `kernel.ns-${handle.handle_id}`, steps };
      },
    },

    reset_provider: {
      resetProfiles: ["cold"],
      reset: async (handle) => {
        const fresh = makeWorld(handle.realm.realm_id);
        handle.environment.units = fresh.units;
        handle.environment.fdCount = fresh.fdCount;
        handle.environment.interrupts = fresh.interrupts;
        handle.environment.tick = fresh.tick;
        handle.environment.journal = [];
        handle.environment.ring = [];
      },
    },

    fork_provider: {
      fork: async (handle) => {
        const source = handle.environment;
        const clone = makeWorld(handle.realm.realm_id);
        clone.units = new Map(source.units);
        clone.fdCount = new Map(source.fdCount);
        clone.interrupts = source.interrupts;
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
        const handle = options.handle as KernelHandle;
        const world = handle.environment;

        if (options.mode === "fresh_state") {
          const fresh = makeWorld(handle.realm.realm_id);
          world.units = fresh.units;
          world.fdCount = fresh.fdCount;
          world.interrupts = fresh.interrupts;
          world.tick = fresh.tick;
          world.journal = [];
          world.ring = [];
        }

        // Net effects: for each unit touched by the fragment, the index of the
        // step that produced its final recorded sys-action.
        const finalEffects = new Map<string, number>();
        fragment.steps.forEach((step, index) => {
          const event = step.event as KernelAction;
          if ("sys" in event) finalEffects.set(event.unit, index);
        });

        const stepResults = fragment.steps.map((step, index) => {
          const event = step.event as KernelAction;
          if ("sys" in event && event.sys === "restart") {
            if (options.mode === "fresh_state") {
              world.units.set(event.unit, "active");
              world.fdCount.set(event.unit, 0);
              return { step_index: index, ok: true };
            }
            // Verify-only: an earlier effect on a unit later restarted or
            // stopped is superseded - only the FINAL effect per unit must
            // still hold in the current state (net-effect assertions).
            const finalEffect = finalEffects.get(event.unit);
            if (finalEffect !== index) return { step_index: index, ok: true };
            const running = world.units.get(event.unit) === "active";
            return {
              step_index: index,
              ok: running,
              classifier_trunk: running ? undefined : "world_changed",
            };
          }
          if ("sys" in event && event.sys === "stop") {
            if (options.mode === "fresh_state") {
              world.units.set(event.unit, "stopped");
              return { step_index: index, ok: true };
            }
            const finalEffect = finalEffects.get(event.unit);
            if (finalEffect !== index) return { step_index: index, ok: true };
            const halted = world.units.get(event.unit) !== "active";
            return {
              step_index: index,
              ok: halted,
              classifier_trunk: halted ? undefined : "world_changed",
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
      handle_id: `kernel.ns-${request.realm.realm_id}`,
      environment: makeWorld(request.realm.realm_id),
      realm: request.realm,
      recording: null,
    }),
  };

  registerSubstrateAdapter(bundle);

  const schema = makeSchema();

  const hooks = {
    randomAction(_handle: SessionHandle, rand: () => number): KernelAction {
      const roll = rand();
      const unit = UNIT_NAMES[Math.floor(rand() * UNIT_NAMES.length)]!;
      if (roll < 0.4) return { sys: "restart", unit };
      if (roll < 0.6) return { sys: "stop", unit };
      return { op: "noop" };
    },

    diffObservations(before: unknown, after: unknown): ChangedValue[] {
      return diff(before as KernelObservation | null, after as KernelObservation).map((change) => ({
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
      const world = (handle as KernelHandle).environment;
      const afterObs = after as KernelObservation;
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
      return flatten(observation as KernelObservation);
    },

    mutateAmbient(handle: SessionHandle, _rand: () => number): string | undefined {
      const world = (handle as KernelHandle).environment;
      world.interrupts += 1;
      return INTERRUPTS_PATH;
    },

    async makeTwin(handle: SessionHandle, actionThatMattered: unknown): Promise<SessionHandle> {
      const world = (handle as KernelHandle).environment;
      const twin = makeWorld(handle.realm.realm_id + "-twin");
      twin.units = new Map(world.units);
      twin.fdCount = new Map(world.fdCount);
      twin.interrupts = world.interrupts;
      twin.tick = world.tick;
      // Invert exactly the semantic effect of the recorded action.
      if ("sys" in (actionThatMattered as KernelAction)) {
        const action = actionThatMattered as KernelAction;
        if (action.sys === "restart") {
          // Crashed unit: a restart cannot have taken hold here.
          twin.units.set(action.unit, "failed");
          twin.fdCount.set(action.unit, 64);
        }
        // "stop": leave the twin unit running, so the stop cannot have happened.
      }
      return { ...handle, handle_id: `${handle.handle_id}-twin`, environment: twin };
    },
  };

  return { bundle, schema: () => schema, hooks };
}
