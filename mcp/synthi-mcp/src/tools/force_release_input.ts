import { session } from "../session.js";
import { leaseRegistry } from "../arbitration/lease.js";
import { authenticateBrokerBearer, authorizeBrokerCapability } from "../broker/auth.js";
import { brokerError } from "../broker/errors.js";
import { brokerInputEnforced } from "../broker/input_gate.js";
import { requestSharedLease } from "./shared_lease.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface RawArgs {
  lease_id?: unknown;
  reason?: unknown;
  forced_by?: unknown;
  broker_token?: unknown;
}

export async function forceReleaseInputTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  if (typeof a.lease_id !== "string" || a.lease_id.length === 0) {
    return errorResponse("invalid_args", { field: "lease_id", expected: "non-empty string" });
  }

  const auth = authenticateBrokerBearer(
    typeof a.broker_token === "string" ? a.broker_token : undefined,
    {
      secret: process.env["SYNTHI_BROKER_AUTH_SECRET"],
      issuer: process.env["SYNTHI_BROKER_AUTH_ISSUER"],
      audience: process.env["SYNTHI_BROKER_AUTH_AUDIENCE"],
    }
  );
  if (!auth.ok) return errorResponse(auth.error.error, auth.error as unknown as Record<string, unknown>);
  const capability = authorizeBrokerCapability(auth.principal, "force_release_lease");
  if (capability) return errorResponse(capability.error.error, capability.error as unknown as Record<string, unknown>);
  if (a.forced_by !== undefined && a.forced_by !== auth.principal.subject) {
    return errorResponse("FORBIDDEN", brokerError("FORBIDDEN", {
      reason: "forced_by_mismatch",
    }) as unknown as Record<string, unknown>);
  }

  const reason = typeof a.reason === "string" && a.reason.length > 0 ? a.reason : "admin_force_release";
  const forcedBy = auth.principal.subject;
  const shared = await requestSharedLease(attached, {
    op: "force-release",
    lease_id: a.lease_id,
    forced_by: forcedBy,
    reason,
  });
  if (shared?.ok === false) return errorResponse(shared.error, shared.detail);
  if (shared?.ok === true) {
    leaseRegistry.forceRelease(a.lease_id, forcedBy, reason);
    session.touch();
    return jsonResponse({
      ok: true,
      released: true,
      lease_id: a.lease_id,
      forced_by: forcedBy,
      reason,
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
