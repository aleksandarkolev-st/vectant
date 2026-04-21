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
  /**
   * Explicit ICE server list. When present, overrides the env-var path
   * below. Each entry follows the WebRTC `RTCIceServer` dictionary —
   * `{urls, username?, credential?}`.
   */
  ice_servers?: unknown;
}

/**
 * Resolve ICE servers from (in order): explicit tool args, then
 * `SYNTHI_TURN_URL` / `SYNTHI_TURN_USERNAME` / `SYNTHI_TURN_CREDENTIAL`
 * + `SYNTHI_STUN_URL` env vars. When no TURN creds are available,
 * returns `undefined` so the Peer falls back to its built-in Google STUN
 * default (matches pre-existing behavior).
 *
 * Why the env path exists: in local docker-compose dev the worker gets
 * TURN via collab-server's `/turn-credentials` endpoint, but the MCP
 * typically runs on the host — so it needs the host-reachable TURN URL
 * (e.g. `turn:localhost:3478`) rather than the docker-internal name
 * (`turn:coturn:3478`) the worker uses. Env lets the operator pass in
 * the host-scoped URL without the MCP having to know the networking
 * topology.
 */
function resolveIceServers(args: AttachArgs): RTCIceServer[] | undefined {
  if (Array.isArray(args.ice_servers) && args.ice_servers.length > 0) {
    return args.ice_servers as RTCIceServer[];
  }

  const stunUrl = process.env.SYNTHI_STUN_URL;
  const turnUrl = process.env.SYNTHI_TURN_URL;
  const turnUser = process.env.SYNTHI_TURN_USERNAME;
  const turnCred = process.env.SYNTHI_TURN_CREDENTIAL;

  const servers: RTCIceServer[] = [];
  if (stunUrl) {
    servers.push({ urls: stunUrl });
  }
  if (turnUrl && turnUser && turnCred) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnCred });
  }
  return servers.length > 0 ? servers : undefined;
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
    const iceServers = resolveIceServers(a);
    const attachOpts: {
      sessionId: string;
      signalingUrl: string;
      iceServers?: RTCIceServer[];
    } = { sessionId, signalingUrl };
    if (iceServers !== undefined) {
      attachOpts.iceServers = iceServers;
    }
    const attached = await session.attach(attachOpts);
    if (!classification.local) {
      session.markUnsafeMode();
    }
    const manifest = buildManifest(ADVERTISED_TOOLS, {
      frame_seq_gate_enabled: session.frameSeqGateEnabled(),
    });
    return jsonResponse({
      ok: true,
      connected: true,
      resolution: attached.resolution ? { w: attached.resolution.width, h: attached.resolution.height } : null,
      sessionId: attached.sessionId,
      signalingUrl: attached.signalingUrl,
      protocol: {
        version: agreedVersion,
        server_supports: serverSupports,
      },
      capabilities: manifest,
      session: ((): Record<string, unknown> => {
        const presence = session.getPresenceCounts();
        return {
          id: attached.sessionId,
          state: session.getWireState(),
          state_ts: session.getWireStateTs(),
          unsafe_mode: session.isUnsafeMode(),
          // Populated by `presence` messages from the signaling-server.
          // Defaults to {humans:0, agents:1} (self) when no peers have
          // reported yet.
          attached_humans: presence.humans,
          attached_agents: presence.agents,
        };
      })(),
    });
  } catch (err) {
    return errorFromException("attach_failed", err);
  }
}
