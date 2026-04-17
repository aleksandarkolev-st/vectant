import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { attachTool } from "./tools/attach.js";
import { screenshotTool } from "./tools/screenshot.js";
import { waitHmrTool } from "./tools/wait_hmr.js";
import { clickTool } from "./tools/click.js";
import { typeTool } from "./tools/type.js";
import { locateTool } from "./tools/locate.js";
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
      "Return the latest video frame from the attached preview session as a PNG. Requires a prior synthi_attach call and at least one received frame.",
    inputSchema: {
      type: "object",
      properties: {},
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
