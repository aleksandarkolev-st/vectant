import { runWait, DEFAULT_TIMEOUT_MS } from "../wait/index.js";
import type { WaitArgs, WaitCondition } from "../wait/index.js";
import {
  errorFromException,
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

const VALID_CONDITIONS: readonly WaitCondition[] = [
  "hmr",
  "motion_settled",
  "pixel",
  "scene_change",
  "text",
  "log",
  "element",
  "source_state",
];

interface RawArgs {
  condition?: unknown;
  timeoutMs?: unknown;
  [key: string]: unknown;
}

export async function waitTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  if (typeof a.condition !== "string" || !VALID_CONDITIONS.includes(a.condition as WaitCondition)) {
    return errorResponse("invalid_args", {
      field: "condition",
      allowed: VALID_CONDITIONS,
    });
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (a.timeoutMs !== undefined) {
    if (typeof a.timeoutMs !== "number" || a.timeoutMs <= 0) {
      return errorResponse("invalid_args", { field: "timeoutMs", expected: "positive number (ms)" });
    }
    timeoutMs = a.timeoutMs;
  }

  const rest = { ...a };
  delete rest.timeoutMs;
  const waitArgs = rest as unknown as WaitArgs;

  try {
    const outcome = await runWait(waitArgs, timeoutMs);
    if (outcome.status === "unsupported") {
      return errorResponse(`${outcome.condition}_wait_${outcome.reason}`, {
        condition: outcome.condition,
        reason: outcome.reason,
        ...(outcome.required_tool_call ? { required_tool_call: outcome.required_tool_call } : {}),
      });
    }
    return jsonResponse({
      ok: true,
      ...outcome,
    });
  } catch (err) {
    return errorFromException("wait_failed", err);
  }
}
