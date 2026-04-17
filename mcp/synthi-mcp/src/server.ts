import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { eventLog } from "./events/index.js";
import {
  RESOURCES,
  RESOURCE_URIS,
  readResource,
  resourceUrisForEvent,
} from "./resources/index.js";
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
import { mouseTool } from "./tools/mouse.js";
import { keyboardTool } from "./tools/keyboard.js";
import { getUsageTool } from "./tools/get_usage.js";
import { setQualityTool } from "./tools/set_quality.js";
import { checkpointTool } from "./tools/checkpoint.js";
import { acknowledgeDisruptionTool } from "./tools/acknowledge_disruption.js";
import { getCrashInfoTool } from "./tools/get_crash_info.js";
import { resetGuestTool } from "./tools/reset_guest.js";
import { verifyTool } from "./tools/verify.js";
import { compileTool } from "./tools/compile.js";
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
    name: "synthi_compile",
    description:
      "Dispatch a CompileRequest on the worker's `compile` data channel. Fire-and-forget — the HMR status streams on `build-log`, so follow up with synthi_wait({condition:\"hmr\"}) to block on applied/compile-error/etc. Closes the edit→HMR→screenshot loop without a frontend open.",
    inputSchema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description: "Source language (e.g. 'cpp', 'rust', 'go', 'java'). Matches worker CompileRequest.language.",
        },
        source: {
          type: "string",
          description: "Primary source file content.",
        },
        filename: {
          type: "string",
          description: "Primary source filename. Defaults to main.<language>.",
        },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              content: { type: "string" },
            },
            required: ["name", "content"],
          },
          description: "Additional source files keyed by relative path.",
        },
        is_gui: {
          type: "boolean",
          description: "Whether this compile emits a GUI (Xvfb + media pipeline). Default true.",
        },
        width: { type: "number" },
        height: { type: "number" },
        use_ai_split: {
          type: "boolean",
          description: "Let the worker decide split via AI (Tier 2/3). Default false.",
        },
        user_requested_ai: {
          type: "boolean",
          description: "Explicit opt-in to the AI-split (Loop B). Default false.",
        },
        user_requested_deterministic: {
          type: "boolean",
          description: "Explicit opt-in to deterministic split (Loop A). Default false.",
        },
        target: {
          type: "string",
          description: "Target platform. Default 'native'; mobile uses 'react-native-emulator'.",
        },
        project_root: { type: "string" },
        slug: { type: "string" },
      },
      required: ["language", "source"],
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
    name: "synthi_get_usage",
    description:
      "Return per-session usage counters aggregated from the event log: tool_call, screenshot, vision_inference, egress_bytes. Includes vision_cost_usd_estimate (0 until claude_api backend ships) and hot_seconds since attach.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_set_quality",
    description:
      "Request bandwidth changes (target_fps / target_bitrate / target_resolution). Phase 1 records the intent in the event log; actual negotiation with the worker is phase 2 (returns applied:false, note:\"phase_1_record_only\").",
    inputSchema: {
      type: "object",
      properties: {
        target_fps: { type: "number" },
        target_bitrate: { type: "number", description: "Bits per second." },
        target_resolution: {
          type: "object",
          properties: { w: { type: "number" }, h: { type: "number" } },
          required: ["w", "h"],
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_checkpoint",
    description:
      "Write a named marker (label) into the event log so post-run analysis can anchor time ranges to caller-meaningful phases. Returns {seq, ts}.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Short human-readable label (required)." },
        detail: { description: "Arbitrary structured context, passed through in the response." },
      },
      required: ["label"],
    },
  },
  {
    name: "synthi_acknowledge_disruption",
    description:
      "Acknowledge a pending disruption (crash-recovered / full-reload-required) so subsequent input is accepted. Returns `cleared` with the disruption kind that was cleared, or \"none\" if nothing was pending.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_get_crash_info",
    description:
      "Return the most recent crash metadata observed by the MCP (pending_disruption + crash_info). null/empty if the session has not reported a crash.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_reset_guest",
    description:
      "Request that the guest program be restarted without closing the session. Phase 1 records the intent; worker-side enforcement lands in phase 2 (returns applied:false).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_mouse",
    description:
      "Playwright-style mouse tool. Actions: click, double_click, move, down, up, drag, wheel. Coordinates come from explicit x/y OR a handle (resolved via synthi_locate, bbox center is used). Optional auto-wait via waitFor:{condition,...} runs a synthi_wait before the action.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["click", "double_click", "move", "down", "up", "drag", "wheel"] },
        x: { type: "number" },
        y: { type: "number" },
        toX: { type: "number", description: "Drag destination x." },
        toY: { type: "number", description: "Drag destination y." },
        deltaY: { type: "number", description: "Wheel delta (positive = scroll down)." },
        button: { type: "string", enum: ["left", "middle", "right"] },
        handle: {
          type: "object",
          properties: {
            handle_id: { type: "string" },
            reuse: { type: "boolean" },
            description: { type: "string" },
          },
          required: ["handle_id"],
        },
        waitFor: {
          type: "object",
          description: "Optional pre-action wait. Same shape as synthi_wait input.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "synthi_keyboard",
    description:
      "Keyboard tool. Actions: type (string), key (single named key like Enter/Tab), chord (array of keys pressed simultaneously, released in reverse). Optional confirm:{pattern,timeoutMs} waits for a log-pattern match after the action.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["type", "key", "chord"] },
        text: { type: "string", description: "For action=type." },
        key: { type: "string", description: "For action=key. Uses JS DOM ev.key semantics (\"Enter\", \"Tab\", \"a\")." },
        keys: {
          type: "array",
          items: { type: "string" },
          description: "For action=chord (e.g., [\"Control\", \"c\"]).",
        },
        confirm: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            timeoutMs: { type: "number" },
          },
          required: ["pattern"],
        },
        waitFor: {
          type: "object",
          description: "Optional pre-action wait. Same shape as synthi_wait input.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "synthi_verify",
    description:
      "Evaluate a predicate against the current session state. Predicate kinds: pixel, log, element_visible, ocr, scene_matches, and, or. ocr returns ocr_backend_not_implemented (phase 1); scene_matches returns verify_scene_matches_unsupported with required_tool_call:\"synthi_describe\". and/or compose up to depth 4, 8 clauses per level.",
    inputSchema: {
      type: "object",
      properties: {
        predicate: {
          type: "object",
          description: "Tagged predicate object. See PhasePredicate types.",
        },
      },
      required: ["predicate"],
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
        resources: { subscribe: true, listChanged: false },
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

  // ---------------------------------------------------------------------
  // Resources (subscribable state streams).
  // ---------------------------------------------------------------------
  const subscriptions = new Set<string>();

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const contents = await readResource(uri);
    if (!contents) throw new Error(`unknown_resource: ${uri}`);
    const out: Record<string, unknown> = { uri: contents.uri, mimeType: contents.mimeType };
    if (contents.text !== undefined) out["text"] = contents.text;
    if (contents.blob !== undefined) out["blob"] = contents.blob;
    return { contents: [out] };
  });

  server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscriptions.add(req.params.uri);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscriptions.delete(req.params.uri);
    return {};
  });

  // Feed: when an event lands, notify any subscribers whose URI overlaps.
  // Rate-limit screenshot notifications to <= 2 Hz so a chatty pipeline
  // doesn't blow out the agent's inbox.
  let lastScreenshotPushTs = 0;
  const SCREENSHOT_PUSH_MIN_INTERVAL_MS = 500;

  eventLog.onAppend(async (entry) => {
    const uris = new Set(resourceUrisForEvent(entry));
    for (const uri of uris) {
      if (!subscriptions.has(uri)) continue;
      if (uri === RESOURCE_URIS.screenshot) {
        const now = Date.now();
        if (now - lastScreenshotPushTs < SCREENSHOT_PUSH_MIN_INTERVAL_MS) continue;
        lastScreenshotPushTs = now;
      }
      try {
        await server.notification({
          method: "notifications/resources/updated",
          params: { uri },
        });
      } catch {
        // ignore notification errors — transport may be disconnected
      }
    }
  });

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
      case "synthi_mouse":
        return (await mouseTool(args)) as CallToolResult;
      case "synthi_keyboard":
        return (await keyboardTool(args)) as CallToolResult;
      case "synthi_get_usage":
        return (await getUsageTool(args)) as CallToolResult;
      case "synthi_set_quality":
        return (await setQualityTool(args)) as CallToolResult;
      case "synthi_checkpoint":
        return (await checkpointTool(args)) as CallToolResult;
      case "synthi_acknowledge_disruption":
        return (await acknowledgeDisruptionTool(args)) as CallToolResult;
      case "synthi_get_crash_info":
        return (await getCrashInfoTool(args)) as CallToolResult;
      case "synthi_reset_guest":
        return (await resetGuestTool(args)) as CallToolResult;
      case "synthi_verify":
        return (await verifyTool(args)) as CallToolResult;
      case "synthi_compile":
        return (await compileTool(args)) as CallToolResult;
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
