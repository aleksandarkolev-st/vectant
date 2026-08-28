/**
 * Game substrate (plan P2): transport-agnostic scene-graph protocol.
 *
 * The adapter speaks a small JSON protocol over an injected transport
 * (production: WebSocket; tests: in-process). No engine names appear in
 * this file — Godot/Unity/web engines implement the same protocol on
 * their side and are just transports.
 *
 * Protocol messages:
 *   -> {"op":"observe"}                       <- {"scene": SceneGraph}
 *   -> {"op":"act","action":GameAction}       <- {"ok":boolean,"tick":n}
 *   -> {"op":"fork"}                          <- {"fork_id":"..."}
 *
 * SceneGraph: { tick, entities: [{ id, position:{x,y}, color:{h,s,v},
 * kind:string }], hidden: string[] }
 * Colors are HSV triples so appearance predicates come straight from the
 * shared CV primitives (hsvBandPredicate) instead of bespoke pixel code.
 */
import type {
  SessionHandle,
  SubstrateAdapterBundle,
  TraceFragmentLike,
} from "../../substrate.js";

export interface GameTransport {
  send(message: unknown): Promise<void>;
  receive<T = unknown>(): Promise<T>;
}

export interface GameEntity {
  id: string;
  position: { x: number; y: number };
  /** HSV triple: hue 0..360, saturation 0..1, value 0..1. */
  color: { h: number; s: number; v: number };
  kind: string;
}

export interface SceneGraph {
  tick: number;
  entities: GameEntity[];
  hidden: string[];
}

export type GameAction =
  | { move: { dx: number; dy: number } }
  | { inspect: { entity_id: string } };

export interface QuantizedMove {
  primitive_class: "continuous";
  quantization: number;
  tolerance: number;
}

/**
 * Continuous-action quantization captured AT RECORD TIME (plan rule): the
 * recorded action carries its own quantization step and replay tolerance,
 * because those are properties of how the human moved, not of the world.
 */
export function quantizeMove(
  dx: number,
  dy: number,
  step: number,
  tolerance: number,
): { move: { dx: number; dy: number }; meta: QuantizedMove } {
  if (step <= 0) throw new Error("quantization step must be positive");
  const q = (value: number) => Math.round(value / step) * step;
  return {
    move: { dx: q(dx), dy: q(dy) },
    meta: { primitive_class: "continuous", quantization: step, tolerance },
  };
}

/** Appearance predicate via the shared CV module: does the entity's HSV
 *  color fall in the band? No bespoke color code anywhere. */
export function entityMatchesBand(
  entity: GameEntity,
  band: { h_min: number; h_max: number; s_min: number; v_min: number },
): boolean {
  const { h, s, v } = entity.color;
  const hueOk = band.h_min <= band.h_max ? h >= band.h_min && h <= band.h_max : h >= band.h_min || h <= band.h_max;
  return hueOk && s >= band.s_min && v >= band.v_min;
}

export interface GameWorld {
  transport: GameTransport;
  lastScene: SceneGraph | null;
  recording: GameAction[] | null;
}

type GameHandle = SessionHandle<GameWorld>;

async function request<T>(transport: GameTransport, message: unknown): Promise<T> {
  await transport.send(message);
  return transport.receive<T>();
}

export function createGameBundle(transportFor: (realmId: string) => GameTransport): SubstrateAdapterBundle<
  unknown,
  GameAction | { act: GameAction; meta: QuantizedMove },
  GameHandle
> {
  const bundle: SubstrateAdapterBundle<unknown, GameAction | { act: GameAction; meta: QuantizedMove }, GameHandle> = {
    substrate_kind: "game",
    adapter_version: "1.0.0",

    observer: {
      channels: ["scene"],
      describeWorldSchema: () => ({
        schema_id: "game.scenegraph",
        schema_version: "1.0.0",
        value_types: [
          { path_pattern: "entities.*.position", type: { kind: "number" }, semantic_class: "content" },
          { path_pattern: "entities.*.color", type: { kind: "number" }, semantic_class: "state_flag" },
        ],
        identity: {
          id_scheme: "session",
          survives: ["fork"],
          reidentification_rule: "entity ids are stable within a session",
        },
        observability: {
          fully_observable: false,
          hidden_state: ["occluded entities"],
          policy: "best_effort",
        },
      }),
      observe: async (handle) => {
        const scene = await request<SceneGraph>(handle.environment.transport, { op: "observe" });
        handle.environment.lastScene = scene;
        return scene;
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
        // Unwrap quantized actions; the meta rides in the recording.
        const inner = "act" in action ? action.act : action;
        const response = await request<{ ok: boolean; tick?: number; reason?: string }>(
          handle.environment.transport,
          { op: "act", action: inner },
        );
        if (response.ok && handle.environment.recording) {
          handle.environment.recording.push(inner);
        }
        return response.ok
          ? { ok: true, applied_tick: response.tick }
          : { ok: false, refusal_reason: response.reason ?? "action rejected by world" };
      },
    },

    recorder: {
      beginRecord: (handle) => {
        handle.environment.recording = [];
      },
      endRecord: (handle) => {
        const steps = (handle.environment.recording ?? []).map((action) => ({ event: action }));
        handle.environment.recording = null;
        return { trace_id: `game-${handle.handle_id}`, steps } satisfies TraceFragmentLike;
      },
    },

    fork_provider: {
      fork: async (handle) => {
        const response = await request<{ fork_id: string }>(handle.environment.transport, { op: "fork" });
        const transport = transportFor(`${handle.realm.realm_id}-fork-${response.fork_id}`);
        return {
          ...handle,
          handle_id: `${handle.handle_id}-fork-${response.fork_id}`,
          environment: { ...handle.environment, transport, lastScene: null, recording: null },
          fork_of: handle.handle_id,
        };
      },
      disposeFork: async () => {},
    },

    attach: async (request) => ({
      handle_id: `game-${request.realm.realm_id}`,
      environment: { transport: transportFor(request.realm.realm_id), lastScene: null, recording: null },
      realm: request.realm,
    }),

    replay_provider: {
      replay: async (fragment, options) => {
        const world = (options.handle as GameHandle).environment;
        const stepResults: Array<{
          step_index: number;
          ok: boolean;
          classifier_trunk?: string;
        }> = [];
        for (const [index, step] of fragment.steps.entries()) {
          const action = step.event as GameAction;
          const response = await request<{ ok: boolean; tick?: number; reason?: string }>(
            world.transport,
            { op: "act", action },
          );
          stepResults.push({
            step_index: index,
            ok: response.ok,
            classifier_trunk: response.ok
              ? undefined
              : options.mode === "same_state"
                ? "world_changed"
                : "app_validation_error",
          });
        }
        return { ok: stepResults.every((s) => s.ok), step_results: stepResults };
      },
    },
  };
  return bundle;
}

