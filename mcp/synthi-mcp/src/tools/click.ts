import { session } from "../session.js";
import { encodeClickPair, type MouseButtonName } from "../wire/input.js";
import {
  errorFromException,
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface ClickArgs {
  x?: unknown;
  y?: unknown;
  button?: unknown;
}

function parseButton(v: unknown): MouseButtonName | null {
  if (v === undefined) return "left";
  if (v === "left" || v === "right" || v === "middle") return v;
  return null;
}

export async function clickTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as ClickArgs;
  const x = typeof a.x === "number" ? a.x : NaN;
  const y = typeof a.y === "number" ? a.y : NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return errorResponse("invalid_arguments", {
      hint: "x and y must be numbers in pixel coordinates.",
    });
  }
  const button = parseButton(a.button);
  if (button === null) {
    return errorResponse("invalid_arguments", {
      hint: "button must be 'left', 'right', or 'middle'.",
    });
  }

  try {
    const attached = session.require();
    const frames = encodeClickPair(attached.sessionId, x, y, button);
    await attached.channels.sendInput(frames);
    return jsonResponse({ ok: true });
  } catch (err) {
    return errorFromException("click_failed", err);
  }
}
