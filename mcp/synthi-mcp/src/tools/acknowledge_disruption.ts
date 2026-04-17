import { eventLog } from "../events/index.js";
import { session } from "../session.js";
import { jsonResponse, type ToolResponse } from "./shared.js";

/**
 * Required after the session reports `crash-recovered` or
 * `full-reload-required`. Until acknowledged, input tools should refuse
 * dispatch (enforced by the correctness table — ticket #21). This tool
 * clears the flag and records the ack in the event log so post-run
 * analysis can tell "agent saw disruption X at time Y" from "agent
 * silently ignored disruption X".
 */
export async function acknowledgeDisruptionTool(_args: unknown): Promise<ToolResponse> {
  const cleared = session.clearDisruption();
  eventLog.push({
    kind: "lifecycle",
    state: session.getWireState(),
    detail: {
      event: "acknowledge_disruption",
      cleared: cleared ?? "none",
    },
  });
  return jsonResponse({
    ok: true,
    cleared: cleared ?? "none",
  });
}
