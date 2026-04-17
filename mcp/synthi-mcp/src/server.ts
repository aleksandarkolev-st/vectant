import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { attachTool } from "./tools/attach.js";
import { detachTool } from "./tools/detach.js";
import { healthTool } from "./tools/health.js";
import { reconnectTool } from "./tools/reconnect.js";
import { getEventLogTool } from "./tools/get_event_log.js";
import { getSourceStateTool } from "./tools/get_source_state.js";
import { screenshotTool } from "./tools/screenshot.js";
import { waitHmrTool } from "./tools/wait_hmr.js";
import { clickTool } from "./tools/click.js";
import { typeTool } from "./tools/type.js";
import { locateTool } from "./tools/locate.js";
import { waitTool } from "./tools/wait.js";
import type { ToolContext } from "./tools/shared.js";

export interface SynthiServerOptions {
  defaultSessionId?: string;
  defaultSignalingUrl: string;
}

const TOOLS = [
  {
    name: "synthi_attach",
    description:
      "Connect as a WebRTC peer to an existing Synthi preview session. Returns a protocol version + capability manifest + session envelope (state, unsafe_mode, presence). Evicts any existing browser peer on that session (MVP Path A). Required before any other tool call.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session ID from POST /session/create on collab-server. Defaults to SYNTHI_SESSION_ID env or --session CLI arg.",
        },
        signalingUrl: {
          type: "string",
          description: "WebSocket URL for the signaling server. Defaults to SYNTHI_SIGNALING_URL env or ws://localhost:9000.",
        },
        requested_protocol_version: {
          type: "number",
          description: "Agent's preferred protocol version. Server returns unsupported_protocol with server_supports[] if the version is not implemented. Omit to get the default.",
        },
        "i-understand-no-auth": {
          type: "boolean",
          description: "Required when signalingUrl is non-local (e.g., a remote hostname). Set true to acknowledge that the MCP has no authentication and the session is exposed over the network.",
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_screenshot",
    description:
      "Return the latest video frame as a PNG. Optional {region,max_dim,freshness_max_ms}. region crops; max_dim downscales the longest edge; freshness_max_ms returns frame_stale if the most recent frame is older than the SLA. Emits a `usage` event for every call.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            w: { type: "number" },
            h: { type: "number" },
          },
          required: ["x", "y", "w", "h"],
          description: "Optional crop bbox in pixels. Clamped to the frame.",
        },
        max_dim: {
          type: "number",
          description: "Downscale so longest edge <= max_dim. Positive integer.",
        },
        freshness_max_ms: {
          type: "number",
          description: "SLA: return frame_stale if latest frame's age exceeds this many ms.",
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_wait_hmr",
    description:
      "Block until the preview's HMR pipeline reaches a terminal status (applied / rejected / compile-error / full-reload-required / discarded) or the timeout elapses. Call this immediately after editing source files so the subsequent screenshot reflects the change.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: {
          type: "number",
          description: "Maximum wait in milliseconds. Default 60000 (accommodates Tier 3 AI-split + compile latency).",
          default: 60000,
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_click",
    description:
      "Send a mouse click at the given Xvfb pixel coordinates on the attached session. Coordinates are relative to the preview frame (top-left origin).",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate in pixels." },
        y: { type: "number", description: "Y coordinate in pixels." },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          default: "left",
          description: "Mouse button.",
        },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "synthi_type",
    description:
      "Type a text string into the attached session. Expands to a sequence of key down/up events. Rate-limited to 500 keys/sec.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type." },
      },
      required: ["text"],
    },
  },
  {
    name: "synthi_wait",
    description:
      "Block until a named condition is satisfied, or the timeout elapses. Conditions: hmr, log, source_state, pixel, motion_settled, scene_change, element. `text` is an ultraplan condition — phase 1 returns text_wait_requires_ocr_backend with a required_tool_call:\"synthi_wait\" suggesting condition:\"log\" as a fallback until an OCR backend ships.",
    inputSchema: {
      type: "object",
      properties: {
        condition: {
          type: "string",
          enum: ["hmr", "log", "source_state", "pixel", "motion_settled", "scene_change", "element", "text"],
          description: "Which condition to wait for.",
        },
        timeoutMs: {
          type: "number",
          description: "Maximum wait time in milliseconds. Default 60000.",
        },
        region: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
          description: "Bbox for motion_settled / scene_change / text.",
        },
        still_for_ms: { type: "number", description: "motion_settled: how long the frame must remain within `threshold` hamming before resolving." },
        threshold: { type: "number", description: "motion_settled: hamming distance below which two frames are considered 'still'. Default 4." },
        min_hamming: { type: "number", description: "scene_change: minimum hamming distance between baseline and current frame. Default 8." },
        sample_interval_ms: { type: "number", description: "motion_settled/pixel/scene_change: poll interval. Default 100." },
        x: { type: "number", description: "pixel: x coordinate." },
        y: { type: "number", description: "pixel: y coordinate." },
        expected_rgb: { type: "array", items: { type: "number" }, description: "pixel: resolve when pixel matches this RGB (within tolerance)." },
        not_rgb: { type: "array", items: { type: "number" }, description: "pixel: resolve when pixel differs from this RGB." },
        tolerance: { type: "number", description: "pixel: per-channel tolerance. Default 0." },
        substring: { type: "string", description: "text: substring to wait for on-screen." },
        pattern: { type: "string", description: "log: regex to match event entries." },
        since_seq: { type: "number", description: "log/source_state: only consider entries with seq > this." },
        handle_id: { type: "string", description: "element: handle id previously returned from synthi_locate." },
        any_change: { type: "boolean", description: "source_state: resolve on any source_state event (default true)." },
      },
      required: ["condition"],
    },
  },
  {
    name: "synthi_detach",
    description:
      "Close the current WebRTC + signaling connection and release the session handle. Safe to call when not attached. Does NOT terminate the Synthi preview session itself; a human browser can re-attach afterwards.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_health",
    description:
      "Snapshot of the MCP's connection state: wire session state + timestamp, peer connectionState, data-channel readyStates, first-frame flag, unsafe_mode flag. Read-only.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_reconnect",
    description:
      "Re-establish the WebRTC peer + signaling socket against the current sessionId. Recovers transient network drops. If the underlying session is gone (worker dead, pod evicted), returns session_terminated and the agent should synthi_attach a fresh session.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_get_event_log",
    description:
      "Fetch entries from the session-scoped event ring buffer. Supports since_seq, since_ts, kind filter (lifecycle/hmr/input/locator_resolution/console/error/security/source_state/usage), and limit. Returns entries oldest-first + last_seq.",
    inputSchema: {
      type: "object",
      properties: {
        since_seq: {
          type: "number",
          description: "Return only entries with seq > since_seq. Integer >= 0.",
        },
        since_ts: {
          type: "number",
          description: "Return only entries with ts >= since_ts (ms epoch).",
        },
        kind: {
          oneOf: [
            { type: "string", enum: ["lifecycle", "hmr", "input", "locator_resolution", "console", "error", "security", "source_state", "usage"] },
            { type: "array", items: { type: "string" } },
          ],
          description: "Filter by one kind or an array of kinds.",
        },
        limit: {
          type: "number",
          description: "Maximum number of entries to return. Integer >= 1.",
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_get_source_state",
    description:
      "Report the session's source-state summary (last_changed_files, last_change_seq, last_change_ts). Sourced from the event log. Returns a note field when no source_state events have been emitted yet.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_locate",
    description:
      "Resolve a natural-language element description into a {bbox, handle_id, region_phash} handle. Phase-0.5 spike tool: with `preferred_vision_backend:\"mock\"` (default) or an explicit `hints.prefer_region`, the server uses the hint as the answer; `agent_side` returns an unresolved-handle signal so the agent runs its own vision; `claude_api` is a phase-1 stub today. Passing `handle_id` + `reuse_handle:true` enables the region-pHash cache.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "What the agent is trying to find, in natural language (e.g., 'the counter value').",
        },
        hints: {
          type: "object",
          description: "Optional hints to narrow the search. Mock/agent_side backends require `prefer_region` today.",
          properties: {
            prefer_region: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
              },
              required: ["x", "y", "w", "h"],
            },
            exclude_bbox: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
              },
              required: ["x", "y", "w", "h"],
            },
            containing_text: { type: "string" },
            nth: { type: "number" },
          },
        },
        preferred_vision_backend: {
          type: "string",
          enum: ["mock", "agent_side", "claude_api"],
          description: "Which backend to use for vision grounding. Defaults to env SYNTHI_VISION_BACKEND or 'mock'.",
        },
        handle_id: {
          type: "string",
          description: "Caller-supplied stable identity for the element, used to key the cache.",
        },
        reuse_handle: {
          type: "boolean",
          description: "If true and handle_id is set, try the cache first.",
        },
      },
      required: ["description"],
    },
  },
] as const;

export function createSynthiServer(options: SynthiServerOptions): Server {
  const server = new Server(
    {
      name: "synthi-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const ctx: ToolContext = {
    defaultSignalingUrl: options.defaultSignalingUrl,
    ...(options.defaultSessionId !== undefined
      ? { defaultSessionId: options.defaultSessionId }
      : {}),
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const args = request.params.arguments;
    switch (toolName) {
      case "synthi_attach":
        return (await attachTool(args, ctx)) as CallToolResult;
      case "synthi_screenshot":
        return (await screenshotTool(args)) as CallToolResult;
      case "synthi_wait_hmr":
        return (await waitHmrTool(args)) as CallToolResult;
      case "synthi_click":
        return (await clickTool(args)) as CallToolResult;
      case "synthi_type":
        return (await typeTool(args)) as CallToolResult;
      case "synthi_locate":
        return (await locateTool(args)) as CallToolResult;
      case "synthi_detach":
        return (await detachTool(args)) as CallToolResult;
      case "synthi_health":
        return (await healthTool(args)) as CallToolResult;
      case "synthi_reconnect":
        return (await reconnectTool(args)) as CallToolResult;
      case "synthi_get_event_log":
        return (await getEventLogTool(args)) as CallToolResult;
      case "synthi_get_source_state":
        return (await getSourceStateTool(args)) as CallToolResult;
      case "synthi_wait":
        return (await waitTool(args)) as CallToolResult;
      default:
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "unknown_tool", tool: toolName }),
            },
          ],
          isError: true,
        };
    }
  });

  return server;
}
