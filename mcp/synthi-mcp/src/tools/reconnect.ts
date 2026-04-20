import { session } from "../session.js";
import {
  errorFromException,
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

/**
 * Re-establish the WebRTC peer + signaling socket against the same session
 * that was previously `synthi_attach`-ed. Transient network drops (signaling
 * socket timeout, temporary DC close) are recoverable via this path.
 *
 * Process-level crashes — worker dead, pod evicted, session terminated in
 * collab-server — require a fresh `synthi_attach` with a new sessionId.
 * The MCP can't distinguish transient from terminal before trying, so on
 * reconnect failure we return `session_terminated` and leave the agent to
 * create a new session.
 */
export async function reconnectTool(_args: unknown): Promise<ToolResponse> {
  try {
    const existing = session.get();
    if (!existing) {
      return errorResponse("not_attached", {
        hint: "synthi_reconnect is only valid after a prior synthi_attach. Call synthi_attach first.",
      });
    }
    const sessionId = existing.sessionId;
    const signalingUrl = existing.signalingUrl;

    // Tear down the existing peer + signaling socket cleanly. This emits
    // lifecycle=terminated to the event log.
    await session.close();
    session._resetForTests();

    // Retry attach with the same session identity. If the worker is gone,
    // attach will reject and we translate to session_terminated.
    try {
      const attached = await session.attach({ sessionId, signalingUrl });
      return jsonResponse({
        ok: true,
        reconnected: true,
        resolution: attached.resolution ? { w: attached.resolution.width, h: attached.resolution.height } : null,
        session_id: attached.sessionId,
      });
    } catch (err) {
      return errorFromException("session_terminated", err);
    }
  } catch (err) {
    return errorFromException("reconnect_failed", err);
  }
}
