import { session } from "../session.js";
import { errorFromException, jsonResponse, type ToolResponse } from "./shared.js";

/**
 * Snapshot of the MCP's connection state. Agents call this after a
 * timeout or suspicious silence to learn whether to `synthi_reconnect`
 * or to give up.
 *
 * Schema is deliberately broad so we don't need to mint a new tool
 * every time we learn a new thing worth exposing. Breakout into
 * typed sub-structures is a phase-2 activity if agents start branching
 * on specific fields.
 */
export async function healthTool(_args: unknown): Promise<ToolResponse> {
  try {
    const attached = session.get();
    const mcpState = session.getState();
    const wireState = session.getWireState();
    const wireStateTs = session.getWireStateTs();
    const unsafe = session.isUnsafeMode();
    const attachedAt = session.getAttachedAt();
    const lastActivity = session.getLastActivityAt();

    if (!attached) {
      return jsonResponse({
        ok: true,
        mcp_state: mcpState,
        wire_state: wireState,
        wire_state_ts: wireStateTs,
        unsafe_mode: unsafe,
        attached_at: attachedAt,
        last_activity_at: lastActivity,
      });
    }

    const peerConnectionState = attached.peer.pc.connectionState;
    const firstFrameSeen = attached.frames.hasFrame();
    const dims = attached.frames.dimensions();

    return jsonResponse({
      ok: true,
      mcp_state: mcpState,
      wire_state: wireState,
      wire_state_ts: wireStateTs,
      unsafe_mode: unsafe,
      session_id: attached.sessionId,
      signaling_url: attached.signalingUrl,
      attached_at: attachedAt,
      last_activity_at: lastActivity,
      peer: {
        connection_state: peerConnectionState,
      },
      data_channels: {
        terminal: attached.terminalDC.readyState,
        build_log: attached.buildLogDC.readyState,
      },
      frames: {
        first_frame_seen: firstFrameSeen,
        resolution: dims ? { w: dims.width, h: dims.height } : null,
      },
    });
  } catch (err) {
    return errorFromException("health_failed", err);
  }
}
