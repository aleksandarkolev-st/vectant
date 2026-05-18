import { session } from "../session.js";
import { leaseRegistry, resolveLeaseOwner } from "../arbitration/lease.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface RawArgs {
  lease_id?: unknown;
  reason?: unknown;
  forced_by?: unknown;
}

export async function forceReleaseInputTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  if (typeof a.lease_id !== "string" || a.lease_id.length === 0) {
    return errorResponse("invalid_args", { field: "lease_id", expected: "non-empty string" });
  }
  const reason = typeof a.reason === "string" && a.reason.length > 0 ? a.reason : "admin_force_release";
  const forcedBy = typeof a.forced_by === "string" && a.forced_by.length > 0 ? a.forced_by : resolveLeaseOwner();
  const result = leaseRegistry.forceRelease(a.lease_id, forcedBy, reason);
  session.touch();
  if (!result.ok) return errorResponse(result.error, { lease_id: a.lease_id });
  return jsonResponse({
    ok: true,
    released: result.released,
    lease_id: result.lease_id,
    forced_by: result.forced_by,
    reason: result.reason,
  });
}
