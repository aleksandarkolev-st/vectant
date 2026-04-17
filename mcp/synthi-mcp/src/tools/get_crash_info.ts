import { session } from "../session.js";
import { jsonResponse, type ToolResponse } from "./shared.js";

export async function getCrashInfoTool(_args: unknown): Promise<ToolResponse> {
  const info = session.crashInfo();
  const pending = session.disruptionPending();
  return jsonResponse({
    ok: true,
    pending_disruption: pending,
    crash_info: info,
  });
}
