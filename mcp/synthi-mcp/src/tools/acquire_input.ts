import { session } from "../session.js";
import { leaseRegistry } from "../arbitration/lease.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

/**
 * synthi_acquire_input — ultraplan §Arbitration wire.
 *
 * Phase-1 semantics: records a lease in the MCP-local registry + event
 * log. Worker does not yet enforce single-holder input (phase 2c). The
 * capability manifest reports `arbitration.enforcement:"wire-only"` so
 * agents know acquiring a lease doesn't block another peer from sending
 * input until enforcement ships.
 *
 * Input: {lease_ms:number, owner?:string}.
 * Output: {ok, lease_id, acquired_at, expires_at, lease_ms, enforcement}.
 */

interface RawArgs {
  lease_ms?: unknown;
  owner?: unknown;
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

  const lease = leaseRegistry.acquire(leaseMs, owner);
  session.touch();
  return jsonResponse({
    ok: true,
    lease_id: lease.lease_id,
    acquired_at: lease.acquired_at,
    expires_at: lease.expires_at,
    lease_ms: lease.lease_ms,
    owner: lease.owner,
    enforcement: "wire-only",
    note: "Phase 1 records the lease. Worker-side enforcement lands in phase 2c.",
  });
}
