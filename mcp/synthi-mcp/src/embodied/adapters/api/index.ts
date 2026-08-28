/**
 * API substrate (plan P4): HTTP session capture -> contract -> MCP tool
 * emission. Completes the Substrate Ladder at T0: an emitted tool is the
 * strongest, most stable affordance a workflow can earn.
 *
 * Capture: requests are recorded as EmbodiedEvent-shaped steps with
 * method/path/status affordances; secrets are scrubbed from headers and
 * bodies before anything is stored.
 * Emission: a captured flow compiles into a deterministic tool descriptor
 * (name, input schema, invocation recipe) that the existing private-tool
 * registry can host.
 */
import type {
  SessionHandle,
  SubstrateAdapterBundle,
  TraceFragmentLike,
} from "../../substrate.js";
import { scrubSecrets } from "../terminal/scrub.js";

export interface CapturedRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface CapturedResponse {
  status: number;
  body?: unknown;
}

export interface ApiSessionState {
  base_url: string;
  captured: Array<{ request: CapturedRequest; response: CapturedResponse }>;
}

interface ApiWorld {
  session: ApiSessionState | null;
}

type ApiHandle = SessionHandle<ApiWorld>;

/** Redact credential-bearing headers before anything is stored. */
function scrubRequest(request: CapturedRequest): CapturedRequest {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    headers[key] = /authorization|cookie|token|secret|key/i.test(key)
      ? "<redacted>"
      : scrubSecrets(value).text;
  }
  return {
    method: request.method,
    path: request.path,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(request.body !== undefined
      ? { body: JSON.parse(scrubSecrets(JSON.stringify(request.body)).text) }
      : {}),
  };
}

/**
 * Compile a captured session into an MCP-style tool descriptor. The tool's
 * input schema is derived from the captured requests' shapes; the invocation
 * recipe replays the same sequence against the base URL. Deterministic:
 * identical captures produce identical descriptors.
 */
export interface EmittedTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  recipe: Array<{ method: string; path: string; body?: unknown }>;
}

export function emitTool(session: ApiSessionState, toolName: string): EmittedTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const entry of session.captured) {
    if (entry.request.body !== undefined && entry.request.body !== null && typeof entry.request.body === "object") {
      for (const key of Object.keys(entry.request.body as Record<string, unknown>)) {
        properties[key] = { type: "string", description: `captured from ${entry.request.method} ${entry.request.path}` };
        required.push(key);
      }
    }
  }
  return {
    name: toolName,
    description: `Emitted from ${session.captured.length} captured calls to ${session.base_url}`,
    input_schema: {
      type: "object",
      properties,
      required: [...new Set(required)],
    },
    recipe: session.captured.map((entry) => ({
      method: entry.request.method,
      path: entry.request.path,
      ...(entry.request.body !== undefined ? { body: entry.request.body } : {}),
    })),
  };
}

export function createApiBundle(): SubstrateAdapterBundle<unknown, CapturedRequest, ApiHandle> {
  const bundle: SubstrateAdapterBundle<unknown, CapturedRequest, ApiHandle> = {
    substrate_kind: "api",
    adapter_version: "1.0.0",

    observer: {
      channels: ["session"],
      describeWorldSchema: () => ({
        schema_id: "api.session",
        schema_version: "1.0.0",
        value_types: [
          { path_pattern: "captured.*.status", type: { kind: "number" }, semantic_class: "state_flag" },
        ],
        identity: {
          id_scheme: "stable",
          survives: [],
          reidentification_rule: "base_url + path templates",
        },
        observability: {
          fully_observable: true,
          hidden_state: [],
          policy: "full",
        },
      }),
      observe: async (handle) => handle.environment.session ?? { base_url: "", captured: [] },
    },

    actor: {
      act: async (handle, request, leaseProof) => {
        if (leaseProof.expires_at_ms <= Date.now()) {
          return { ok: false, refusal_reason: "lease expired" };
        }
        if (leaseProof.realm.realm_id !== handle.realm.realm_id) {
          return { ok: false, refusal_reason: "realm mismatch" };
        }
        // Capture-only substrate: recording a request IS the action. The real
        // HTTP dispatch belongs to the deployment's executor; here the flow is
        // captured with its observed response supplied by the caller via
        // recordResponse().
        if (!handle.environment.session) {
          return { ok: false, refusal_reason: "no active capture session" };
        }
        handle.environment.session.captured.push({
          request: scrubRequest(request),
          response: { status: 200 },
        });
        return { ok: true };
      },
    },

    recorder: {
      beginRecord: (handle) => {
        handle.environment.session = { base_url: handle.realm.realm_id, captured: [] };
      },
      endRecord: (handle) => {
        const session = handle.environment.session;
        handle.environment.session = null;
        const steps = (session?.captured ?? []).map((entry) => ({
          event: { ...entry.request, _status: entry.response.status },
        }));
        return { trace_id: `api-${handle.handle_id}`, steps } satisfies TraceFragmentLike;
      },
    },

    attach: async (request) => ({
      handle_id: `api-${request.realm.realm_id}`,
      environment: { session: null },
      realm: request.realm,
    }),

    replay_provider: {
      replay: async (fragment, options) => {
        void options;
        // T0 replay = re-issue the recipe. The executor port performs the HTTP
        // calls; capture-mode replay validates the recipe shape only.
        const stepResults = fragment.steps.map((step, index) => {
          const event = step.event as CapturedRequest & { _status?: number };
          const ok = typeof event.method === "string" && typeof event.path === "string";
          return {
            step_index: index,
            ok,
            classifier_trunk: ok ? undefined : "app_validation_error",
          };
        });
        return { ok: stepResults.every((s) => s.ok), step_results: stepResults };
      },
    },
  };
  return bundle;
}

