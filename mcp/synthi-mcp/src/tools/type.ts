import { keyboardTool } from "./keyboard.js";
import {
  errorResponse,
  type ToolResponse,
} from "./shared.js";

interface TypeArgs {
  text?: unknown;
  lease_id?: unknown;
  based_on_frame_seq?: unknown;
  based_on_viewport?: unknown;
}

export async function typeTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as TypeArgs;
  if (typeof a.text !== "string") {
    return errorResponse("invalid_arguments", {
      hint: "text must be a string.",
    });
  }

  return keyboardTool({
    action: "type",
    text: a.text,
    lease_id: a.lease_id,
    based_on_frame_seq: a.based_on_frame_seq,
    based_on_viewport: a.based_on_viewport,
  });
}
