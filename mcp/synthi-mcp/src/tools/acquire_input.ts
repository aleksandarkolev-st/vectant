import { session } from "../session.js";
import {
  DEFAULT_LEASE_MS,
  MAX_LEASE_MS,
  leaseRegistry,
  resolveLeaseMode,
  resolveLeaseOwner,
  type LeaseScope,
} from "../arbitration/lease.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

/**
 * synthi_acquire_input — ultraplan §Arbitration wire.
 *
 * Modes (selected at startup via SYNTHI_LEASE_MODE):
 *   - `advisory` (default): multi-acquire allowed. Manifest reports
 *     `enforcement:"wire-only"`.
 *   - `single-holder` (phase 2c): acquiring while another live lease
 *     exists fails with `lease_already_held` unless the caller passes
 *     `takeover:true`. Manifest reports `enforcement:"mcp-local"`.
 *
 * Worker-side cross-peer enforcement (preventing a separate browser
 * session from bypassing the MCP-local registry) is a follow-up — see
 * the worker's PeerRegistry scaffold.
 *
 * Input: {lease_ms:number, scope?:("mouse"|"keyboard")[], takeover?:boolean, reason?:string}.
 * Output: {ok, lease_id, acquired_at, expires_at, lease_ms, owner, scope, enforcement, evicted_lease_id?}.
 */

interface RawArgs {
  lease_ms?: unknown;
  owner?: unknown;
  takeover?: unknown;
  scope?: unknown;
  preemptible?: unknown;
  reason?: unknown;
}

function parseScope(raw: unknown): LeaseScope[] | "invalid" | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return "invalid";
  const out: LeaseScope[] = [];
  for (const item of raw) {
    if (item !== "mouse" && item !== "keyboard") return "invalid";
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

export async function acquireInputTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  let leaseMs = DEFAULT_LEASE_MS;
  if (a.lease_ms !== undefined) {
    if (typeof a.lease_ms !== "number" || !Number.isFinite(a.lease_ms) || a.lease_ms <= 0) {
      return errorResponse("invalid_args", { field: "lease_ms", expected: "positive number" });
    }
    leaseMs = a.lease_ms;
  }
  if (leaseMs > MAX_LEASE_MS) leaseMs = MAX_LEASE_MS;
  const scope = parseScope(a.scope);
  if (scope === "invalid") {
    return errorResponse("invalid_args", { field: "scope", expected: "array of 'mouse'|'keyboard'" });
  }
  const owner = resolveLeaseOwner();
  const takeover = a.takeover === true;
  const preemptible = typeof a.preemptible === "boolean" ? a.preemptible : true;
  const reason = typeof a.reason === "string" && a.reason.length > 0 ? a.reason : null;

  const mode = resolveLeaseMode();
  const enforcement = process.env["SYNTHI_BROKER_INPUT_MODE"] === "enforce"
    ? "server"
    : mode === "single-holder" ? "mcp-local" : "wire-only";

  const result = leaseRegistry.acquireWithPolicy(leaseMs, owner, {
    takeover,
    ...(scope !== undefined ? { scope } : {}),
    preemptible,
    reason,
  });
  if (!result.ok) {
    return errorResponse(result.error, {
      current_lease_id: result.current.lease_id,
      current_lease_owner: result.current.owner,
      current_lease_expires_at: result.current.expires_at,
    });
  }
  session.touch();
  return jsonResponse({
    ok: true,
    lease_id: result.lease.lease_id,
    acquired_at: result.lease.acquired_at,
    expires_at: result.lease.expires_at,
    lease_ms: result.lease.lease_ms,
    owner: result.lease.owner,
    scope: result.lease.scope,
    preemptible: result.lease.preemptible,
    priority: result.lease.priority,
    reason: result.lease.reason,
    continuous_owner_since: result.lease.continuous_owner_since,
    enforcement,
    ...(result.evicted ? { evicted_lease_id: result.evicted.lease_id } : {}),
  });
}
