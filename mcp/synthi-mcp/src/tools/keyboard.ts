import { eventLog } from "../events/index.js";
import { session } from "../session.js";
import { encodeKey, encodeTypeSequence } from "../wire/input.js";
import { runWait } from "../wait/index.js";
import type { LogArgs, WaitArgs } from "../wait/index.js";
import {
  errorFromException,
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface RawArgs {
  action?: unknown;
  text?: unknown;
  key?: unknown;
  keys?: unknown;
  confirm?: unknown;
  waitFor?: unknown;
}

const VALID_ACTIONS = ["type", "key", "chord"] as const;
type KeyboardAction = (typeof VALID_ACTIONS)[number];

export async function keyboardTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const action = a.action as KeyboardAction | undefined;
  if (!action || !(VALID_ACTIONS as readonly string[]).includes(action)) {
    return errorResponse("invalid_args", { field: "action", allowed: VALID_ACTIONS });
  }

  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  if (a.waitFor !== undefined) {
    const waitArgs = a.waitFor as WaitArgs & { timeoutMs?: number };
    const timeout = typeof waitArgs.timeoutMs === "number" ? waitArgs.timeoutMs : undefined;
    const outcome = await runWait(waitArgs, timeout);
    if (outcome.status === "timeout") {
      return errorResponse("wait_timeout_before_action", {
        condition: outcome.condition,
        elapsedMs: outcome.elapsedMs,
      });
    }
    if (outcome.status === "unsupported") {
      return errorResponse(`${outcome.condition}_wait_${outcome.reason}`, {
        condition: outcome.condition,
      });
    }
  }

  let charsSent = 0;
  try {
    switch (action) {
      case "type": {
        if (typeof a.text !== "string") {
          return errorResponse("invalid_args", { field: "text", expected: "string" });
        }
        if (a.text.length > 0) {
          const frames = encodeTypeSequence(attached.sessionId, a.text);
          await attached.channels.sendInput(frames);
        }
        charsSent = a.text.length;
        break;
      }
      case "key": {
        if (typeof a.key !== "string" || a.key.length === 0) {
          return errorResponse("invalid_args", { field: "key", expected: "non-empty string" });
        }
        const down = encodeKey(attached.sessionId, a.key, "down");
        const up = encodeKey(attached.sessionId, a.key, "up");
        await attached.channels.sendInput([down, up]);
        charsSent = 1;
        break;
      }
      case "chord": {
        if (!Array.isArray(a.keys) || a.keys.some((k) => typeof k !== "string" || k.length === 0)) {
          return errorResponse("invalid_args", { field: "keys", expected: "non-empty string array" });
        }
        const keys = a.keys as string[];
        const frames: string[] = [];
        for (const k of keys) frames.push(encodeKey(attached.sessionId, k, "down"));
        for (let i = keys.length - 1; i >= 0; i--) frames.push(encodeKey(attached.sessionId, keys[i]!, "up"));
        await attached.channels.sendInput(frames);
        charsSent = keys.length;
        break;
      }
    }
  } catch (err) {
    return errorFromException("keyboard_send_failed", err);
  }

  eventLog.push({
    kind: "input",
    action: `keyboard:${action}`,
    payload: {
      ...(action === "type" ? { chars: charsSent } : {}),
      ...(action === "key" ? { key: a.key } : {}),
      ...(action === "chord" ? { keys: a.keys } : {}),
    },
  });
  session.touch();

  // Post-action confirm — auto-wait for a log pattern (common idiom: type a
  // command, wait for the echoed result in build-log).
  if (a.confirm !== undefined) {
    const c = a.confirm as { pattern?: unknown; timeoutMs?: unknown };
    if (typeof c.pattern !== "string") {
      return errorResponse("invalid_args", { field: "confirm.pattern", expected: "string" });
    }
    const waitArgs: LogArgs = { condition: "log", pattern: c.pattern };
    const timeoutMs = typeof c.timeoutMs === "number" ? c.timeoutMs : 5_000;
    const outcome = await runWait(waitArgs, timeoutMs);
    if (outcome.status === "timeout") {
      return errorResponse("confirm_timeout_after_action", {
        pattern: c.pattern,
        elapsedMs: outcome.elapsedMs,
      });
    }
  }

  return jsonResponse({
    ok: true,
    action,
    charsSent,
    dispatched_at: Date.now(),
  });
}
