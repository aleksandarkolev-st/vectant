import { locateEngine } from "../locate/index.js";
import { eventLog } from "../events/index.js";
import { session } from "../session.js";
import { checkInputGate } from "../correctness/index.js";
import {
  buttonNameToCode,
  encodeMouseButton,
  encodeMouseMove,
  encodeWheel,
  type MouseButtonName,
} from "../wire/input.js";
import { runWait } from "../wait/index.js";
import type { WaitArgs } from "../wait/index.js";
import {
  errorFromException,
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface HandleRef {
  handle_id: string;
  reuse?: boolean;
  description?: string;
}

interface RawArgs {
  action?: unknown;
  x?: unknown;
  y?: unknown;
  toX?: unknown;
  toY?: unknown;
  deltaY?: unknown;
  button?: unknown;
  handle?: unknown;
  waitFor?: unknown;
  retry?: unknown;
}

const VALID_ACTIONS = ["click", "move", "down", "up", "drag", "wheel", "double_click"] as const;
type MouseAction = (typeof VALID_ACTIONS)[number];

export async function mouseTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const action = a.action as MouseAction | undefined;
  if (!action || !(VALID_ACTIONS as readonly string[]).includes(action)) {
    return errorResponse("invalid_args", { field: "action", allowed: VALID_ACTIONS });
  }

  const gate = checkInputGate();
  if (gate) {
    return errorResponse(gate.error, gate);
  }
  const attached = session.require();

  const button = typeof a.button === "string" ? (a.button as MouseButtonName) : "left";
  if (!["left", "right", "middle"].includes(button)) {
    return errorResponse("invalid_args", { field: "button", allowed: ["left", "right", "middle"] });
  }

  // Auto-wait pre-action.
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
        reason: outcome.reason,
      });
    }
  }

  // Resolve coords: either explicit {x,y} or via handle → locate → bbox center.
  let x: number | undefined = typeof a.x === "number" ? a.x : undefined;
  let y: number | undefined = typeof a.y === "number" ? a.y : undefined;
  let resolvedBbox: { x: number; y: number; w: number; h: number } | undefined;
  if (a.handle !== undefined) {
    const h = a.handle as HandleRef;
    if (!h || typeof h.handle_id !== "string") {
      return errorResponse("invalid_args", { field: "handle.handle_id", expected: "string" });
    }
    let frame;
    try {
      frame = await attached.frames.getFrame();
    } catch (err) {
      return errorFromException("no_frame_yet", err);
    }
    try {
      const result = await locateEngine.resolve(
        {
          description: h.description ?? `handle:${h.handle_id}`,
          handle_id: h.handle_id,
          reuse_handle: h.reuse ?? true,
        },
        { frame: frame.data, frameDims: { w: frame.width, h: frame.height } }
      );
      resolvedBbox = result.bbox;
      if (x === undefined) x = Math.round(result.bbox.x + result.bbox.w / 2);
      if (y === undefined) y = Math.round(result.bbox.y + result.bbox.h / 2);
    } catch (err) {
      return errorFromException("locator_unresolved", err);
    }
  }

  const frameDims = attached.frames.dimensions();

  try {
    switch (action) {
      case "click":
      case "double_click":
      case "down":
      case "up":
      case "move": {
        if (x === undefined || y === undefined) {
          return errorResponse("invalid_args", { field: "x/y", expected: "numbers (or handle)" });
        }
        if (frameDims && (x < 0 || y < 0 || x >= frameDims.width || y >= frameDims.height)) {
          return errorResponse("click_out_of_bounds", {
            viewport: { w: frameDims.width, h: frameDims.height },
            requested: { x, y },
          });
        }
        const code = buttonNameToCode(button);
        const frames: string[] = [];
        if (action === "click" || action === "double_click") {
          frames.push(encodeMouseButton(attached.sessionId, x, y, code, "down"));
          frames.push(encodeMouseButton(attached.sessionId, x, y, code, "up"));
          if (action === "double_click") {
            frames.push(encodeMouseButton(attached.sessionId, x, y, code, "down"));
            frames.push(encodeMouseButton(attached.sessionId, x, y, code, "up"));
          }
        } else if (action === "down") {
          frames.push(encodeMouseButton(attached.sessionId, x, y, code, "down"));
        } else if (action === "up") {
          frames.push(encodeMouseButton(attached.sessionId, x, y, code, "up"));
        } else if (action === "move") {
          frames.push(encodeMouseMove(attached.sessionId, x, y));
        }
        await attached.channels.sendInput(frames);
        break;
      }
      case "drag": {
        if (x === undefined || y === undefined) return errorResponse("invalid_args", { field: "x/y" });
        const toX = typeof a.toX === "number" ? a.toX : undefined;
        const toY = typeof a.toY === "number" ? a.toY : undefined;
        if (toX === undefined || toY === undefined) {
          return errorResponse("invalid_args", { field: "toX/toY", expected: "numbers" });
        }
        const code = buttonNameToCode(button);
        const frames: string[] = [
          encodeMouseButton(attached.sessionId, x, y, code, "down"),
          encodeMouseMove(attached.sessionId, toX, toY),
          encodeMouseButton(attached.sessionId, toX, toY, code, "up"),
        ];
        await attached.channels.sendInput(frames);
        break;
      }
      case "wheel": {
        const deltaY = typeof a.deltaY === "number" ? a.deltaY : 0;
        await attached.channels.sendInput([encodeWheel(attached.sessionId, deltaY)]);
        break;
      }
    }
  } catch (err) {
    return errorFromException("mouse_send_failed", err);
  }

  eventLog.push({
    kind: "input",
    action: `mouse:${action}`,
    payload: {
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(action === "drag" ? { toX: a.toX, toY: a.toY } : {}),
      button,
      ...(resolvedBbox ? { resolved_bbox: resolvedBbox } : {}),
    },
  });
  session.touch();

  return jsonResponse({
    ok: true,
    action,
    dispatched_at: Date.now(),
    ...(resolvedBbox ? { resolved_bbox: resolvedBbox } : {}),
  });
}
