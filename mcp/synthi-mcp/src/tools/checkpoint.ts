import { eventLog } from "../events/index.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface RawArgs {
  label?: unknown;
  detail?: unknown;
}

/**
 * Write a named marker into the event log so post-run analysis can anchor
 * time ranges to a caller-meaningful label.
 */
export async function checkpointTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  if (typeof a.label !== "string" || a.label.length === 0) {
    return errorResponse("invalid_args", { field: "label", expected: "non-empty string" });
  }
  const entry = eventLog.push({
    kind: "console",
    level: "info",
    message: `[checkpoint] ${a.label}`,
    source: "mcp_internal",
  });
  return jsonResponse({
    ok: true,
    label: a.label,
    seq: entry.seq,
    ts: entry.ts,
    ...(a.detail !== undefined ? { detail: a.detail } : {}),
  });
}
