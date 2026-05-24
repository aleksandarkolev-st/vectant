import { session } from "../session.js";
import { leaseRegistry } from "../arbitration/lease.js";
import { brokerError, brokerInputEnforced } from "../broker/index.js";
import { resolveLeaseMode } from "../arbitration/lease.js";
import { requestSharedLease } from "./shared_lease.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

/**
 * synthi_release_input — partner to synthi_acquire_input.
 *
 * Input: {lease_id?:string} — when omitted, every lease held by this
 * MCP process is released.
 * Output: {ok, released:string[]} or
 *         {error:"lease_not_found", lease_id} when the id doesn't match
 *         any live lease.
 */

interface RawArgs {
  lease_id?: unknown;
}

export async function releaseInputTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  let leaseId: string | undefined;
  if (a.lease_id !== undefined) {
    if (typeof a.lease_id !== "string" || a.lease_id.length === 0) {
      return errorResponse("invalid_args", { field: "lease_id", expected: "non-empty string" });
    }
    leaseId = a.lease_id;
  }

  if (leaseId === undefined && brokerInputEnforced()) {
    return errorResponse("FORBIDDEN", brokerError("FORBIDDEN", {
      reason: "release_all_disabled_in_enforce_mode",
    }) as unknown as Record<string, unknown>);
  }

  if (leaseId !== undefined) {
    const shared = await requestSharedLease(attached, { op: "release", lease_id: leaseId });
    if (shared?.ok === false) {
      return errorResponse(shared.error, shared.detail);
    }
    if (shared?.ok === true) {
      leaseRegistry.release(leaseId, attached.sessionId);
      session.touch();
      return jsonResponse({
        ok: true,
        released: shared.released ?? [leaseId],
        enforcement: "worker",
      });
    }
  }

  const result = leaseRegistry.release(leaseId);
  session.touch();
  if (result.not_found !== null) {
    return errorResponse("lease_not_found", { lease_id: result.not_found });
  }
  return jsonResponse({
    ok: true,
    released: result.released,
    enforcement: brokerInputEnforced() ? "server" : resolveLeaseMode() === "single-holder" ? "mcp-local" : "wire-only",
  });
}
