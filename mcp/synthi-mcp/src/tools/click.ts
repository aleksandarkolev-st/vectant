import { type MouseButtonName } from "../wire/input.js";
import { mouseTool } from "./mouse.js";
import {
  errorResponse,
  type ToolResponse,
} from "./shared.js";

interface ClickArgs {
  x?: unknown;
  y?: unknown;
  button?: unknown;
  lease_id?: unknown;
  based_on_frame_seq?: unknown;
  based_on_viewport?: unknown;
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

  return mouseTool({
    action: "click",
    x,
    y,
    button,
    lease_id: a.lease_id,
    based_on_frame_seq: a.based_on_frame_seq,
    based_on_viewport: a.based_on_viewport,
  });
}
