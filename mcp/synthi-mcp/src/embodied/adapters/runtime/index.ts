/**
 * Runtime substrate (plan adapters/runtime/): pods, notebooks, program
 * lifecycle. In-process model with an injected lifecycle port so tests run
 * without containers and production wires a real pod supervisor.
 *
 * World semantics: programs have states (created|running|exited|crashed),
 * exit codes, and logs; notebooks are programs whose "log" is cells.
 * Ambient dynamics: running CPU time advances per observation.
 */
import type {
  SessionHandle,
  SubstrateAdapterBundle,
  TraceFragmentLike,
} from "../../substrate.js";
import { scrubSecrets } from "../terminal/scrub.js";

export interface RuntimeLifecyclePort {
  start(program: string, args: readonly string[]): Promise<{ pid: number }>;
  kill(pid: number): Promise<void>;
}

interface RuntimeProgram {
  name: string;
  args: string[];
  state: "created" | "running" | "exited" | "crashed";
  exit: number | null;
  cpu_ms: number;
}

interface RuntimeWorld {
  programs: Map<number, RuntimeProgram>;
  nextPid: number;
  journal: Array<{ tick: number; snapshot: unknown }>;
  tick: number;
  recording: Array<{ event: { op: string; name?: string; args?: string[]; pid?: number } }> | null;
}

type RuntimeHandle = SessionHandle<RuntimeWorld>;

function snapshot(world: RuntimeWorld) {
  return {
    tick: world.tick,
    programs: [...world.programs.entries()].map(([pid, p]) => ({
      pid,
      name: p.name,
      state: p.state,
      exit: p.exit,
      cpu_ms: Math.round(p.cpu_ms),
    })),
  };
}

export function createRuntimeBundle(lifecycle?: RuntimeLifecyclePort): SubstrateAdapterBundle<
  unknown,
  { op: "launch"; name: string; args?: string[] } | { op: "terminate"; pid: number } | { op: "wait"; pid: number },
  RuntimeHandle
> {
  const bundle: SubstrateAdapterBundle<
    unknown,
    { op: "launch"; name: string; args?: string[] } | { op: "terminate"; pid: number } | { op: "wait"; pid: number },
    RuntimeHandle
  > = {
    substrate_kind: "runtime",
    adapter_version: "1.0.0",

    observer: {
      channels: ["programs"],
      describeWorldSchema: () => ({
        schema_id: "runtime.pods",
        schema_version: "1.0.0",
        value_types: [
          { path_pattern: "programs.*.state", type: { kind: "string" }, semantic_class: "state_flag" },
          { path_pattern: "programs.*.exit", type: { kind: "number" }, semantic_class: "counter" },
        ],
        identity: {
          id_scheme: "session",
          survives: ["fork"],
          reidentification_rule: "pids are identity within a session",
        },
        observability: {
          fully_observable: false,
          hidden_state: ["process memory", "environment"],
          policy: "best_effort",
        },
      }),
      observe: async (handle) => {
        const world = handle.environment;
        world.tick += 1;
        // Ambient dynamics: running programs accumulate CPU.
        for (const program of world.programs.values()) {
          if (program.state === "running") program.cpu_ms += 100;
        }
        const snap = snapshot(world);
        world.journal.push({ tick: world.tick, snapshot: snap });
        if (world.journal.length > 64) world.journal.shift();
        return snap;
      },
    },

    actor: {
      act: async (handle, action, leaseProof) => {
        if (leaseProof.expires_at_ms <= Date.now()) {
          return { ok: false, refusal_reason: "lease expired" };
        }
        if (leaseProof.realm.realm_id !== handle.realm.realm_id) {
          return { ok: false, refusal_reason: "realm mismatch" };
        }
        const world = handle.environment;

        if (action.op === "launch") {
          const pid = world.nextPid;
          world.nextPid += 1;
          const program: RuntimeProgram = {
            name: scrubSecrets(action.name).text,
            args: (action.args ?? []).map((arg) => scrubSecrets(arg).text),
            state: "running",
            exit: null,
            cpu_ms: 0,
          };
          world.programs.set(pid, program);
          if (lifecycle) await lifecycle.start(program.name, program.args);
          if (world.recording) world.recording.push({ event: { op: "launch", name: action.name, args: action.args } });
          return { ok: true, applied_tick: world.tick };
        }

        if (action.op === "terminate") {
          const program = world.programs.get(action.pid);
          if (!program) return { ok: false, refusal_reason: "no such program" };
          program.state = "exited";
          program.exit = 0;
          if (lifecycle) await lifecycle.kill(action.pid);
          if (world.recording) world.recording.push({ event: { op: "terminate", pid: action.pid } });
          return { ok: true, applied_tick: world.tick };
        }

        // wait: block until the target is no longer running.
        const program = world.programs.get((action as { pid: number }).pid);
        if (!program) return { ok: false, refusal_reason: "no such program" };
        if (world.recording) world.recording.push({ event: { op: "wait", pid: (action as { pid: number }).pid } });
        return { ok: true, applied_tick: world.tick };
      },
    },

    recorder: {
      beginRecord: (handle) => {
        handle.environment.recording = [];
      },
      endRecord: (handle) => {
        const steps = (handle.environment.recording ?? []).map((entry) => ({ event: entry.event }));
        handle.environment.recording = null;
        return { trace_id: `runtime-${handle.handle_id}`, steps } satisfies TraceFragmentLike;
      },
    },

    fork_provider: {
      fork: async (handle) => {
        const source = handle.environment;
        const clone: RuntimeWorld = {
          tick: source.tick,
          nextPid: source.nextPid,
          programs: new Map(
            [...source.programs.entries()].map(([pid, program]) => [pid, { ...program }]),
          ),
          journal: [],
          recording: null,
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

    attach: async (request) => ({
      handle_id: `runtime-${request.realm.realm_id}`,
      environment: {
        programs: new Map(),
        nextPid: 1000 + Math.abs(request.realm.realm_id.length * 7),
        journal: [],
        tick: 0,
        recording: null,
      },
      realm: request.realm,
    }),

    replay_provider: {
      replay: async (fragment, options) => {
        const handle = options.handle as RuntimeHandle;
        const stepResults: Array<{ step_index: number; ok: boolean; classifier_trunk?: string }> = [];
        for (const [index, step] of fragment.steps.entries()) {
          const action = step.event as { op: string; name?: string; pid?: number };
          if (action.op === "launch") {
            const result = await bundle.actor!.act(handle, { op: "launch", name: action.name! }, {
              lease_id: "replay",
              realm: handle.realm,
              capability: "act",
              expires_at_ms: Number.MAX_SAFE_INTEGER,
            });
            stepResults.push({ step_index: index, ok: result.ok, classifier_trunk: result.ok ? undefined : "app_validation_error" });
          } else if (action.op === "wait") {
            const program = handle.environment.programs.get(action.pid!);
            const ok = program !== undefined && program.state !== "crashed";
            stepResults.push({
              step_index: index,
              ok,
              classifier_trunk: ok ? undefined : "world_changed",
            });
          } else if (action.op === "terminate") {
            const program = handle.environment.programs.get(action.pid!);
            // Net-effect verify: the program must no longer be running.
            const ok = program === undefined || program.state !== "running";
            stepResults.push({ step_index: index, ok, classifier_trunk: ok ? undefined : "world_changed" });
          } else {
            stepResults.push({ step_index: index, ok: false, classifier_trunk: "substrate_limitation" });
          }
        }
        return { ok: stepResults.every((s) => s.ok), step_results: stepResults };
      },
    },
  };
  return bundle;
}
