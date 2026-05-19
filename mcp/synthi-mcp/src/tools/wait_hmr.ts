import { session } from "../session.js";
import {
  errorFromException,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface WaitHmrArgs {
  timeoutMs?: unknown;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function waitHmrTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as WaitHmrArgs;
  const timeoutMs =
    typeof a.timeoutMs === "number" && a.timeoutMs > 0
      ? a.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  try {
    const attached = session.require();
    const result = await attached.channels.hmr.waitForTerminal({ timeoutMs });
    return jsonResponse({
      status: result.status,
      elapsedMs: result.elapsedMs,
      source: result.source,
      detail: result.detail ?? null,
    });
  } catch (err) {
    return errorFromException("wait_hmr_failed", err);
  }
}
