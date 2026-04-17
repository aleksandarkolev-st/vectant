import { eventLog } from "../events/index.js";
import { session } from "../session.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

/**
 * Phase-1 stub. The wire is reserved for when the worker exposes a "restart
 * guest program only" control message; until then this tool records the
 * intent and returns `not_implemented:true`. Agents can poll — once the
 * worker advertises the capability via capabilities.arbitration (or a
 * new capability bucket), this tool flips to issue the reset.
 */
export async function resetGuestTool(_args: unknown): Promise<ToolResponse> {
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");
  eventLog.push({
    kind: "lifecycle",
    state: session.getWireState(),
    detail: {
      event: "reset_guest_requested",
      applied: false,
      reason: "phase_1_record_only",
    },
  });
  return jsonResponse({
    ok: true,
    applied: false,
    note: "Phase 1 records the intent only; worker-side guest-reset control lands in phase 2.",
  });
}
