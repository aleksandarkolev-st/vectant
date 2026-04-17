import { session } from "../session.js";
import {
  buildManifest,
  negotiateProtocol,
  ProtocolNegotiationError,
} from "../protocol/index.js";
import { ADVERTISED_TOOLS } from "../tool_registry.js";
import { classifySignalingUrl } from "../security/signaling_url.js";
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
  requested_protocol_version?: unknown;
  preferred_vision_backend?: unknown;
  "i-understand-no-auth"?: unknown;
}

export async function attachTool(args: unknown, ctx: ToolContext): Promise<ToolResponse> {
  const a = (args ?? {}) as AttachArgs;

  // Protocol negotiation first — if the agent is on a version we don't
  // speak, fail fast before we even try to hold the socket.
  let agreedVersion: number;
  let serverSupports: number[];
  try {
    const requested = typeof a.requested_protocol_version === "number"
      ? a.requested_protocol_version
      : undefined;
    const n = negotiateProtocol(requested);
    agreedVersion = n.agreed;
    serverSupports = n.server_supports;
  } catch (err) {
    if (err instanceof ProtocolNegotiationError) {
      return errorResponse("unsupported_protocol", {
        requested: err.requested,
        server_supports: err.server_supports,
      });
    }
    return errorFromException("protocol_failed", err);
  }

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

  // Local-allowlist enforcement. Non-local signaling URLs require the caller
  // to acknowledge "i-understand-no-auth" per ultraplan §4.11. Phase 1 seats
  // the flag wire-side; actual server-enforcement remains wire-only until
  // phase 2 adds the per-attach-persisted unsafe_mode flag.
  const ack = a["i-understand-no-auth"] === true;
  const classification = classifySignalingUrl(signalingUrl);
  if (!classification.local && !ack) {
    return errorResponse("unsafe_signaling", {
      required_flag: "i-understand-no-auth",
      signaling_url: signalingUrl,
      reason: classification.reason,
      required_tool_call: {
        tool: "synthi_attach",
        suggested_args: {
          sessionId,
          signalingUrl,
          "i-understand-no-auth": true,
        },
      },
    });
  }

  try {
    const attached = await session.attach({ sessionId, signalingUrl });
    if (!classification.local) {
      session.markUnsafeMode();
    }
    const manifest = buildManifest(ADVERTISED_TOOLS, {
      frame_seq_gate_enabled: session.frameSeqGateEnabled(),
    });
    return jsonResponse({
      ok: true,
      connected: true,
      resolution: { w: attached.resolution.width, h: attached.resolution.height },
      sessionId: attached.sessionId,
      signalingUrl: attached.signalingUrl,
      protocol: {
        version: agreedVersion,
        server_supports: serverSupports,
      },
      capabilities: manifest,
      session: {
        id: attached.sessionId,
        state: session.getWireState(),
        state_ts: session.getWireStateTs(),
        unsafe_mode: session.isUnsafeMode(),
        // Presence counts are placeholders until the signaling-server
        // observer role + peer registry ship (ultraplan §4.16). The MCP
        // itself is attached as `browser`; worker is implicit.
        attached_humans: 0,
        attached_agents: 1,
      },
    });
  } catch (err) {
    return errorFromException("attach_failed", err);
  }
}
