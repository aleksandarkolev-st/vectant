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
import type { ToolContext } from "./tools/shared.js";

export interface SynthiServerOptions {
  defaultSessionId?: string;
  defaultSignalingUrl: string;
}

const TOOLS = [
  {
    name: "synthi_attach",
    description:
      "Connect as a WebRTC peer to an existing Synthi preview session. Required before any other tool call. Evicts any existing browser peer on that session (MVP Path A).",
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
