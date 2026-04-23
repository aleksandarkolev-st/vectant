import { session } from "../session.js";
import { buildError, pickHighestPriority, type ErrorPayload } from "./errors.js";

/**
 * Single choke-point that decides whether an input tool (mouse/keyboard)
 * is allowed to dispatch. Returns null when OK, or an ErrorPayload for
 * the agent when not. Priority-ladder-compliant (errors.ts §ERROR_PRIORITY).
 *
 * Checks (highest priority first):
 *   session_terminated     — no attach
 *   session_migrating      — wire_state=migrating
 *   session_not_ready      — wire_state=warming or crashed
 *   input_rejected_awaiting_ack — pending disruption not acknowledged
 */
export function checkInputGate(): ErrorPayload | null {
  const attached = session.get();
  if (!attached) return buildError("session_terminated", { reason: "not_attached" });

  const wireState = session.getWireState();
  if (wireState === "migrating") {
    return buildError("session_migrating", { state: wireState });
  }
  if (wireState === "warming") {
    return buildError("session_not_ready", { state: wireState });
  }
  if (wireState === "crashed" || wireState === "hibernated") {
    return buildError("session_not_ready", { state: wireState });
  }

  const pending = session.disruptionPending();
  if (pending) {
    return buildError("input_rejected_awaiting_ack", { pending_disruption: pending });
  }

  return null;
}

/** Utility for callers that want the raw priority ordering. */
export { pickHighestPriority };
