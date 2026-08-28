/**
 * Terminal-session world: a filesystem-as-state ontology with an ambient
 * growing log, hidden environment variables (never exposed), and
 * write-protected env namespace. Fifth ontology for the universality proof.
 *
 * Replay semantics mirror the kv net-effect approach: verify-only
 * assertions attach to the FINAL command per path.
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

const LOG_PATH = "var/log/app.log";
const ENV_PREFIX = "env.";

interface TermObservation {
  tick: number;
  fs: Record<string, string>;
}

interface TermWorld {
  tick: number;
  fs: Map<string, string>;
  /** Hidden: process environment, never exposed in observations. */
  env: Map<string, string>;
  journal: Array<{ tick: number; snapshot: TermObservation }>;
}

type TermAction =
  | { cmd: "write"; path: string; content: string }
  | { cmd: "remove"; path: string }
  | { op: "noop" };

const WORKSPACE_PATHS = [
  "src/a.txt",
  "src/b.txt",
  "src/c.txt",
  "docs/readme.md",
  "docs/notes.md",
  "config.ini",
  "data/blob.dat",
  "tmp/scratch.txt",
];

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

function makeWorld(realmId: string): TermWorld {
  const rand = mulberry32(hashString(realmId));
  const fs = new Map<string, string>();
  fs.set("src/a.txt", `alpha-${Math.floor(rand() * 100)}`);
  fs.set("src/b.txt", `beta-${Math.floor(rand() * 100)}`);
  fs.set("README.md".toLowerCase(), `readme-${Math.floor(rand() * 100)}`);
  fs.set(LOG_PATH, "");
  const env = new Map<string, string>([["TERM_SEED", String(Math.floor(rand() * 1e6))]]);
  return { tick: 0, fs, env, journal: [] };
}

/** Ambient: log grows by one line per tick. */
function advanceAmbient(world: TermWorld): void {
  world.tick += 1;
  const log = world.fs.get(LOG_PATH) ?? "";
  world.fs.set(LOG_PATH, `${log}line-${world.tick}\n`);
}

function snapshot(world: TermWorld): TermObservation {
  const fs: Record<string, string> = {};
  for (const [path, content] of world.fs) {
    fs[path] = content;
  }
  return { tick: world.tick, fs };
}

function observeWorld(world: TermWorld): TermObservation {
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

function worldHash(world: TermWorld): string {
  const entries = [...world.fs].sort(([a], [b]) => a.localeCompare(b));
  return djb2Hex(stableStringify({ fs: entries }));
}

function flatten(observation: TermObservation): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  for (const [path, content] of Object.entries(observation.fs)) {
    flat.set(path, content);
  }
  return flat;
}

function diff(before: TermObservation | null, after: TermObservation): ChangedValue[] {
  const beforeFlat = before ? flatten(before) : new Map<string, unknown>();
  const afterFlat = flatten(after);
  const paths = new Set([...beforeFlat.keys(), ...afterFlat.keys()]);
  const changed: ChangedValue[] = [];
  for (const path of paths) {
    if (path.startsWith(ENV_PREFIX)) continue; // defense in depth
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
    schema_id: "terminal.session",
    schema_version: "1.0.0",
    value_types: [
      { path_pattern: LOG_PATH, type: { kind: "string" }, semantic_class: "ambient" },
      { path_pattern: "*", type: { kind: "string" }, semantic_class: "content" },
    ],
    identity: {
      id_scheme: "stable",
      survives: ["fork", "reset"],
      reidentification_rule: "paths are identity",
    },
    observability: {
      fully_observable: false,
      hidden_state: ["process environment variables"],
      policy: "best_effort",
    },
    noise_fingerprints: [{ fingerprint_id: "log-growth", path_pattern: LOG_PATH }],
  };
  const problems = validateWorldStateSchema(schema);
  if (problems.length > 0) {
    throw new Error(`terminal schema invalid: ${JSON.stringify(problems)}`);
  }
  return schema;
}

interface TermHandle extends SessionHandle<TermWorld> {
  recording: Array<{ event: TermAction }> | null;
}

export function makeTerminalAdapter(): FuzzableAdapter {
  const bundle: SubstrateAdapterBundle<TermObservation, TermAction, TermHandle> = {
    substrate_kind: "terminal.session",
    adapter_version: "1.0.0",

    observer: {
      channels: ["fs"],
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
        if ("cmd" in action && action.cmd === "write") {
          if (action.path.startsWith(ENV_PREFIX)) {
            return { ok: false, refusal_reason: "protected namespace" };
          }
          world.fs.set(action.path, action.content);
          ok = true;
        } else if ("cmd" in action && action.cmd === "remove") {
          if (action.path.startsWith(ENV_PREFIX)) {
            return { ok: false, refusal_reason: "protected namespace" };
          }
          ok = world.fs.delete(action.path);
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
        return { trace_id: `term-${handle.handle_id}`, steps };
      },
    },

    reset_provider: {
      resetProfiles: ["cold"],
      reset: async (handle) => {
        const fresh = makeWorld(handle.realm.realm_id);
        handle.environment.fs = fresh.fs;
        handle.environment.env = fresh.env;
        handle.environment.tick = fresh.tick;
        handle.environment.journal = [];
      },
    },

    fork_provider: {
      fork: async (handle) => {
        const source = handle.environment;
        const clone = makeWorld(handle.realm.realm_id);
        clone.fs = new Map(source.fs);
        clone.env = new Map(source.env);
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
        const handle = options.handle as TermHandle;
        const world = handle.environment;

        if (options.mode === "fresh_state") {
          const fresh = makeWorld(handle.realm.realm_id);
          world.fs = fresh.fs;
          world.tick = fresh.tick;
          world.journal = [];
        }

        // Net effects: final command index per path.
        const finalEffects = new Map<string, number>();
        fragment.steps.forEach((step, index) => {
          const event = step.event as TermAction;
          if ("cmd" in event) finalEffects.set(event.path, index);
        });

        const stepResults = fragment.steps.map((step, index) => {
          const event = step.event as TermAction;
          if ("cmd" in event && event.cmd === "write") {
            if (options.mode === "fresh_state") {
              world.fs.set(event.path, event.content);
              return { step_index: index, ok: true };
            }
            const finalEffect = finalEffects.get(event.path);
            if (finalEffect !== index) return { step_index: index, ok: true };
            const current = world.fs.get(event.path);
            return {
              step_index: index,
              ok: current === event.content,
              classifier_trunk: current !== event.content ? "world_changed" : undefined,
            };
          }
          if ("cmd" in event && event.cmd === "remove") {
            if (options.mode === "fresh_state") {
              world.fs.delete(event.path);
              return { step_index: index, ok: true };
            }
            const finalEffect = finalEffects.get(event.path);
            if (finalEffect !== index) return { step_index: index, ok: true };
            const gone = !world.fs.has(event.path);
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
      handle_id: `term-${request.realm.realm_id}`,
      environment: makeWorld(request.realm.realm_id),
      realm: request.realm,
      recording: null,
    }),
  };

  registerSubstrateAdapter(bundle);

  const schema = makeSchema();

  const hooks = {
    randomAction(_handle: SessionHandle, rand: () => number): TermAction {
      const roll = rand();
      const path = WORKSPACE_PATHS[Math.floor(rand() * WORKSPACE_PATHS.length)]!;
      if (roll < 0.45) {
        return { cmd: "write", path, content: `c-${Math.floor(rand() * 10000)}` };
      }
      if (roll < 0.7) return { cmd: "remove", path };
      return { op: "noop" };
    },

    diffObservations(before: unknown, after: unknown): ChangedValue[] {
      return diff(before as TermObservation | null, after as TermObservation).map((change) => ({
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
      const world = (handle as TermHandle).environment;
      const afterObs = after as TermObservation;
      const changed = diff(null, afterObs).filter((change) => change.path !== LOG_PATH);
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
      return flatten(observation as TermObservation);
    },

    mutateAmbient(handle: SessionHandle, _rand: () => number): string | undefined {
      const world = (handle as TermHandle).environment;
      advanceAmbient(world);
      return LOG_PATH;
    },

    async makeTwin(handle: SessionHandle, actionThatMattered: unknown): Promise<SessionHandle> {
      const world = (handle as TermHandle).environment;
      const twin = makeWorld(handle.realm.realm_id + "-twin");
      twin.fs = new Map(world.fs);
      twin.tick = world.tick;
      if ("cmd" in (actionThatMattered as TermAction)) {
        const action = actionThatMattered as Extract<TermAction, { cmd: string }>;
        if (action.cmd === "write") {
          twin.fs.set(action.path, `twin-${String(world.fs.get(action.path))}`);
        } else if (action.cmd === "remove") {
          twin.fs.set(action.path, `restored-${world.tick}`);
        }
      }
      return { ...handle, handle_id: `${handle.handle_id}-twin`, environment: twin };
    },
  };

  return { bundle, schema: () => schema, hooks };
}


