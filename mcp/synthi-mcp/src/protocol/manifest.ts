import { currentEnrichedProvider, enrichedAvailable } from "../enriched/provider.js";
import { MAX_PENDING } from "../escape_hatch/queue.js";

/**
 * Protocol version + capability manifest. Returned from `synthi_attach` so
 * agents can branch on feature availability instead of trial-and-error
 * against the tool surface.
 *
 * Invariants (ultraplan §4.8, §4.17):
 *   - `protocol.version` is a single integer; the server also advertises
 *     `server_supports:[...]` so a client on an older version can fall
 *     back gracefully.
 *   - Unknown enum values from the worker (e.g., a new HMR status we don't
 *     recognize, a new SessionState) are NEVER crashes — they're passed
 *     through as the literal string `"unknown"` plus the original value
 *     in a sibling `raw_value` field when we can preserve it.
 *   - Lazy tool advertisement: the core 13 are always present; enriched-
 *     tier entries appear only when `capabilities.enriched_tier.available`
 *     is true (phase-2+ feature; today always false).
 */

export const PROTOCOL_VERSION = 1;
export const SERVER_SUPPORTS: readonly number[] = [1];

export interface CapabilityManifest {
  tools: string[];
  vision_backends: string[];
  wait_conditions: string[];
  verify_predicates: string[];
  enriched_tier: {
    available: boolean;
    reason: string;
  };
  frame_seq_gate: {
    available: boolean;
    reason: string;
    /** Pipeline-shim applied after HMR resolution before the server will
     * agree the next screenshot reflects the change. Derived from
     * SYNTHI_PIPELINE_BUDGET_MS env (default 80 ms). */
    pipeline_budget_ms: number;
  };
  region_phash_cache: {
    available: boolean;
    ttl_ms: number;
    drift_threshold: number;
  };
  security: {
    unsafe_signaling_flag_supported: boolean;
    focus_lock: boolean;
    wm_class_spoof_check: boolean;
    injection_heuristic_prescreen: boolean;
    sensitive_action_interstitial: boolean;
    keystroke_rate_cap_per_sec: number;
  };
  arbitration: {
    input_lease_supported: boolean;
    enforcement: "none" | "server" | "wire-only" | "mcp-local";
  };
  limits: {
    event_log_capacity: number;
    max_screenshot_dim: number;
  };
  /** Phase-3 capabilities. Omitted at earlier protocol versions; callers
   *  must branch on presence, not assume the shape. */
  snapshot?: {
    available: boolean;
    frame_capture: boolean;
    persistor: "memory" | "file";
  };
  escape_hatch?: {
    /** true once queue-backed semantics shipped (phase 3). Earlier builds
     *  returned `escape_hatch_backend_not_implemented` — agents branch on
     *  this flag. */
    queue_available: boolean;
    max_pending: number;
    answer_tool: string;
  };
  local_vision?: {
    available: boolean;
    endpoint?: string;
    reason?: string;
  };
}

/**
 * Current manifest. This is the authoritative description of what this
 * build of the MCP supports. Update whenever a capability ships.
 *
 * The tool list is maintained by hand so it matches exactly what
 * `server.ts` advertises (no reflection — gives us compile-time guards
 * against drift). `resolveManifest` merges in runtime-only fields.
 */
export const DEFAULT_PIPELINE_BUDGET_MS = 80;

export function resolvePipelineBudgetMs(): number {
  const raw = process.env["SYNTHI_PIPELINE_BUDGET_MS"];
  if (raw === undefined) return DEFAULT_PIPELINE_BUDGET_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PIPELINE_BUDGET_MS;
  return n;
}

export interface ManifestRuntime {
  /** Whether the session has observed a worker-emitted `frame-advance`
   *  message recently (live worker → gate active). */
  frame_seq_gate_enabled?: boolean;
  /** Override the gate reason for callers that already know the state. */
  frame_seq_gate_reason?: string;
}

export const STATIC_MANIFEST: Omit<CapabilityManifest, "tools" | "frame_seq_gate" | "arbitration" | "enriched_tier" | "snapshot" | "escape_hatch" | "local_vision"> = {
  vision_backends: ["agent_side", "claude_api", "gemini_api", "mock", "local"],
  wait_conditions: ["hmr", "log", "source_state", "pixel", "motion_settled", "scene_change", "element", "audio"],
  verify_predicates: ["pixel", "log", "element_visible", "and", "or"],
  region_phash_cache: {
    available: true,
    ttl_ms: 30_000,
    drift_threshold: 12,
  },
  security: {
    unsafe_signaling_flag_supported: true,
    focus_lock: false,
    wm_class_spoof_check: false,
    injection_heuristic_prescreen: true,
    sensitive_action_interstitial: false,
    keystroke_rate_cap_per_sec: 500,
  },
  limits: {
    event_log_capacity: 1024,
    max_screenshot_dim: 3840,
  },
};

function resolveArbitrationManifest(): CapabilityManifest["arbitration"] {
  const mode = process.env["SYNTHI_LEASE_MODE"] === "single-holder" ? "mcp-local" : "wire-only";
  return { input_lease_supported: true, enforcement: mode };
}

function resolveEnrichedManifest(): CapabilityManifest["enriched_tier"] {
  if (enrichedAvailable()) {
    const info = currentEnrichedProvider()!.info();
    return {
      available: true,
      reason: `provider_${info.kind}${info.toolkit ? `_${info.toolkit}` : ""}`,
    };
  }
  return { available: false, reason: "no_provider_registered" };
}

export function buildManifest(
  advertisedTools: readonly string[],
  runtime: ManifestRuntime = {}
): CapabilityManifest {
  const enabled = runtime.frame_seq_gate_enabled ?? false;
  const reason =
    runtime.frame_seq_gate_reason ??
    (enabled ? "frame_advance_observed" : "no_frame_advance_seen_yet");
  const localUrl = process.env["SYNTHI_LOCAL_VISION_URL"];
  const manifest: CapabilityManifest = {
    tools: [...advertisedTools],
    ...STATIC_MANIFEST,
    enriched_tier: resolveEnrichedManifest(),
    arbitration: resolveArbitrationManifest(),
    frame_seq_gate: {
      available: enabled,
      reason,
      pipeline_budget_ms: resolvePipelineBudgetMs(),
    },
    snapshot: {
      available: true,
      frame_capture: true,
      persistor: process.env["SYNTHI_SNAPSHOT_DIR"] ? "file" : "memory",
    },
    escape_hatch: {
      queue_available: true,
      max_pending: MAX_PENDING,
      answer_tool: "synthi_answer_escape_hatch",
    },
    local_vision: localUrl
      ? { available: true, endpoint: localUrl }
      : { available: false, reason: "SYNTHI_LOCAL_VISION_URL_not_set" },
  };
  return manifest;
}

/**
 * Negotiate a protocol version against a client request. Returns the
 * agreed version, or throws with `unsupported_protocol` when the client
 * insists on a version we don't implement.
 */
export function negotiateProtocol(requested?: number): {
  agreed: number;
  server_supports: number[];
} {
  if (requested === undefined) {
    return { agreed: PROTOCOL_VERSION, server_supports: [...SERVER_SUPPORTS] };
  }
  if (!Number.isInteger(requested) || requested < 1) {
    throw new ProtocolNegotiationError(requested, [...SERVER_SUPPORTS]);
  }
  if (SERVER_SUPPORTS.includes(requested)) {
    return { agreed: requested, server_supports: [...SERVER_SUPPORTS] };
  }
  throw new ProtocolNegotiationError(requested, [...SERVER_SUPPORTS]);
}

export class ProtocolNegotiationError extends Error {
  readonly code = "unsupported_protocol";
  constructor(public requested: number, public server_supports: number[]) {
    super(`unsupported_protocol (requested=${requested}, supports=${server_supports.join(",")})`);
  }
}
