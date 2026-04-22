import { session } from "../session.js";
import { leaseRegistry, resolveLeaseMode } from "../arbitration/lease.js";
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
 * Input: {lease_ms:number, owner?:string, takeover?:boolean}.
 * Output: {ok, lease_id, acquired_at, expires_at, lease_ms, enforcement, evicted_lease_id?}.
 */

interface RawArgs {
  lease_ms?: unknown;
  owner?: unknown;
  takeover?: unknown;
}

const DEFAULT_LEASE_MS = 30_000;

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
  const owner = typeof a.owner === "string" && a.owner.length > 0 ? a.owner : "mcp_agent";
  const takeover = a.takeover === true;

  const mode = resolveLeaseMode();
  const enforcement = mode === "single-holder" ? "mcp-local" : "wire-only";

  const result = leaseRegistry.acquireWithPolicy(leaseMs, owner, { takeover });
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
    enforcement,
    ...(result.evicted ? { evicted_lease_id: result.evicted.lease_id } : {}),
  });
}
