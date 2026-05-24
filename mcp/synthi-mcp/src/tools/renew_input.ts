import { session } from "../session.js";
import { DEFAULT_LEASE_MS, leaseRegistry } from "../arbitration/lease.js";
import { brokerError, brokerInputEnforced } from "../broker/index.js";
import { requestSharedLease } from "./shared_lease.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface RawArgs {
  lease_id?: unknown;
  extend_ms?: unknown;
}

export async function renewInputTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  if (typeof a.lease_id !== "string" || a.lease_id.length === 0) {
    return errorResponse("invalid_args", { field: "lease_id", expected: "non-empty string" });
  }

  let extendMs = DEFAULT_LEASE_MS;
  if (a.extend_ms !== undefined) {
    if (typeof a.extend_ms !== "number" || !Number.isFinite(a.extend_ms) || a.extend_ms <= 0) {
      return errorResponse("invalid_args", { field: "extend_ms", expected: "positive number" });
    }
    extendMs = a.extend_ms;
  }

  const shared = await requestSharedLease(attached, { op: "renew", lease_id: a.lease_id, extend_ms: extendMs });
  if (shared?.ok === false) return errorResponse(shared.error, shared.detail);
  if (shared?.ok === true && shared.lease) {
    leaseRegistry.adoptSharedLease(shared.lease);
    session.touch();
    return jsonResponse({
      ok: true,
      lease_id: shared.lease.lease_id,
      expires_at: shared.lease.expires_at,
      lease_ms: shared.lease.lease_ms,
      owner: shared.lease.owner,
      scope: shared.lease.scope,
      preemptible: shared.lease.preemptible,
      reason: shared.lease.reason,
      continuous_owner_since: shared.lease.continuous_owner_since,
      enforcement: "session-shared-worker",
    });
  }
  if (brokerInputEnforced()) {
    return errorResponse("LEASE_DENIED", brokerError("LEASE_DENIED", {
      reason: "shared_session_lease_authority_unavailable",
      required_authority: "worker",
      lease_id: a.lease_id,
      session_id: attached.sessionId,
    }) as unknown as Record<string, unknown>);
  }

  const result = leaseRegistry.renew(a.lease_id, extendMs);
  session.touch();
  if (!result.ok) {
    return errorResponse(result.error, result.detail);
  }
  return jsonResponse({
    ok: true,
    lease_id: result.lease.lease_id,
    expires_at: result.lease.expires_at,
    lease_ms: result.lease.lease_ms,
    owner: result.lease.owner,
    scope: result.lease.scope,
    preemptible: result.lease.preemptible,
    reason: result.lease.reason,
    continuous_owner_since: result.lease.continuous_owner_since,
  });
}
