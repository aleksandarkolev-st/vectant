import { session } from "../session.js";
import {
  errorFromException,
  errorResponse,
  jsonResponse,
  type ToolContext,
  type ToolResponse,
} from "./shared.js";

interface AttachArgs {
  sessionId?: unknown;
  signalingUrl?: unknown;
}

export async function attachTool(args: unknown, ctx: ToolContext): Promise<ToolResponse> {
  const a = (args ?? {}) as AttachArgs;

  const requestedSessionId = typeof a.sessionId === "string" ? a.sessionId : undefined;
  const sessionId = requestedSessionId ?? ctx.defaultSessionId;
  if (!sessionId) {
    return errorResponse("missing_session_id", {
      hint: "Pass sessionId argument or set SYNTHI_SESSION_ID / --session at MCP launch.",
    });
  }

  const requestedSignalingUrl =
    typeof a.signalingUrl === "string" ? a.signalingUrl : undefined;
  const signalingUrl = requestedSignalingUrl ?? ctx.defaultSignalingUrl;

  try {
    const attached = await session.attach({ sessionId, signalingUrl });
    return jsonResponse({
      ok: true,
      connected: true,
      resolution: { w: attached.resolution.width, h: attached.resolution.height },
      sessionId: attached.sessionId,
      signalingUrl: attached.signalingUrl,
    });
  } catch (err) {
    return errorFromException("attach_failed", err);
  }
}
