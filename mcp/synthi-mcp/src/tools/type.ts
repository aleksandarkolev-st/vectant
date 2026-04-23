import { session } from "../session.js";
import { encodeTypeSequence } from "../wire/input.js";
import {
  errorFromException,
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface TypeArgs {
  text?: unknown;
}

export async function typeTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as TypeArgs;
  if (typeof a.text !== "string") {
    return errorResponse("invalid_arguments", {
      hint: "text must be a string.",
    });
  }
  if (a.text.length === 0) {
    return jsonResponse({ ok: true, charsSent: 0 });
  }

  try {
    const attached = session.require();
    const frames = encodeTypeSequence(attached.sessionId, a.text);
    // MVP rate cap: 500 keys/sec. encodeTypeSequence emits 2 frames per char
    // (down+up), so 2ms between frames → ≤500 keys/sec.
    await attached.channels.sendInput(frames, { interFrameDelayMs: 2 });
    return jsonResponse({ ok: true, charsSent: a.text.length });
  } catch (err) {
    return errorFromException("type_failed", err);
  }
}
