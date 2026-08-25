/**
 * Browser substrate on the capability interfaces (goal item 0.8).
 *
 * Thin wrapper: observation/recording/replay delegate to the existing
 * browser pipeline; conversion between BrowserTraceEvent and the universal
 * EmbodiedEvent goes through the pure functions in embodied/event.ts. No
 * browser logic is duplicated here.
 *
 * The bundle is constructed lazily from injected ports so this module never
 * imports a live browser launcher - tests inject fakes, production wires
 * the hosted runtime.
 */
import type {
  SessionHandle,
  SubstrateAdapterBundle,
} from "../embodied/substrate.js";
import { registerSubstrateAdapter } from "../embodied/substrate.js";
import {
  browserEventToEmbodied,
  type BrowserTraceEventShape,
} from "../embodied/event.js";
import type { TraceFragmentLike, ReplayOutcome } from "../embodied/substrate.js";
import type { WorldStateSchema } from "../embodied/world_state.js";

/** The browser world schema: DOM surface declared as typed paths. */
export function browserWorldSchema(): WorldStateSchema {
  return {
    schema_id: "browser.world",
    schema_version: "1.0.0",
    value_types: [
      { path_pattern: "dom.*.visible", type: { kind: "boolean" }, semantic_class: "state_flag" },
      { path_pattern: "dom.*.text", type: { kind: "string" }, semantic_class: "content" },
      { path_pattern: "page.url", type: { kind: "string" }, semantic_class: "identity" },
      { path_pattern: "net.request.completed", type: { kind: "number" }, semantic_class: "counter" },
    ],
    identity: {
      id_scheme: "stable",
      survives: ["fork", "reset"],
      reidentification_rule: "stable test ids and roles within one origin",
    },
    observability: {
      fully_observable: false,
      hidden_state: ["cross-origin frames", "closed shadow dom"],
      policy: "best_effort",
    },
  };
}

/** Ports the wrapper needs from the live browser stack. Tests inject fakes;
 *  production injects the broker/hosted-runtime-backed implementations. */
export interface BrowserAdapterPorts {
  /** Current page snapshot (url, origin, dom summary). */
  observePage(handle: SessionHandle): Promise<{
    url: string;
    origin: string;
    dom: Record<string, unknown>;
  }>;
  /** Execute one browser action under an active lease. */
  performAction(
    handle: SessionHandle,
    event: BrowserTraceEventShape,
  ): Promise<{ ok: boolean; applied?: boolean; refusal_reason?: string }>;
}

interface BrowserWorld {
  recorded: BrowserTraceEventShape[];
  recording: boolean;
}

type BrowserHandle = SessionHandle<BrowserWorld>;

export function createBrowserEmbodiedBundle(
  ports: BrowserAdapterPorts,
): SubstrateAdapterBundle<unknown, BrowserTraceEventShape, BrowserHandle> {
  const bundle: SubstrateAdapterBundle<unknown, BrowserTraceEventShape, BrowserHandle> = {
    substrate_kind: "browser",
    adapter_version: "1.0.0",

    observer: {
      channels: ["dom", "console", "network"],
      describeWorldSchema: () => browserWorldSchema(),
      observe: async (handle) => ports.observePage(handle),
    },

    actor: {
      act: async (handle, event, leaseProof) => {
        if (leaseProof.expires_at_ms <= Date.now()) {
          return { ok: false, refusal_reason: "lease expired" };
        }
        if (leaseProof.realm.realm_id !== handle.realm.realm_id) {
          return { ok: false, refusal_reason: "realm mismatch" };
        }
        const result = await ports.performAction(handle, event);
        if (result.ok && handle.environment.recording) {
          handle.environment.recorded.push(event);
        }
        return result.ok
          ? { ok: true }
          : { ok: false, refusal_reason: result.refusal_reason ?? "action refused" };
      },
    },

    recorder: {
      beginRecord: (handle) => {
        handle.environment.recording = true;
        handle.environment.recorded = [];
      },
      endRecord: (handle) => {
        const steps = handle.environment.recorded.map((event: BrowserTraceEventShape) => ({
          event,
          embodied: browserEventToEmbodied(event),
        }));
        handle.environment.recording = false;
        handle.environment.recorded = [];
        return {
          trace_id: `browser-${handle.handle_id}`,
          steps,
        } satisfies TraceFragmentLike & { steps: Array<{ event: BrowserTraceEventShape; embodied: unknown }> };
      },
    },

    replay_provider: {
      // Re-executes each recorded step through the SAME performAction port
      // the actor uses - no replay-specific logic, no knowledge of what the
      // events mean. A refused step fails the run with a classified trunk.
      replay: async (fragment, options) => {
        const stepResults = [] as ReplayOutcome["step_results"];
        for (const [index, step] of fragment.steps.entries()) {
          const result = await ports.performAction(options.handle, step.event as BrowserTraceEventShape);
          stepResults.push(
            result.ok
              ? { step_index: index, ok: true }
              : {
                  step_index: index,
                  ok: false,
                  classifier_trunk:
                    options.mode === "same_state" ? "world_changed" : "app_validation_error",
                  ...(result.refusal_reason ? { detail: { refusal_reason: result.refusal_reason } } : {}),
                },
          );
        }
        return { ok: stepResults.every((stepResult) => stepResult.ok), step_results: stepResults };
      },
    },

    attach: async (request) => ({
      handle_id: `browser-${request.realm.realm_id}`,
      environment: { recorded: [], recording: false },
      realm: request.realm,
    }),
  };
  return bundle;
}

/** Register a browser bundle under the canonical substrate kind. */
export function registerBrowserEmbodiedAdapter(ports: BrowserAdapterPorts): void {
  registerSubstrateAdapter(createBrowserEmbodiedBundle(ports));
}

export type { ReplayOutcome };

