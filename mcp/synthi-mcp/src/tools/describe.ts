import sharp from "sharp";
import { session } from "../session.js";
import { eventLog } from "../events/index.js";
import { requestRegistry } from "../util/request_registry.js";
import { assertBrokerProviderAllowed } from "../broker/security.js";
import {
  errorFromException,
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

/**
 * synthi_describe — ultraplan Core universal #12.
 *
 * Two modes:
 *   - `agent_side` (default): returns the current screenshot as base64 PNG
 *     + frame_seq + worker-supplied entity hints. The agent runs its own
 *     vision pass. Matches the `agent_side` vision backend pattern.
 *   - `server_side`: runs a VLM pass on the frame and returns a textual
 *     summary + best-effort entity list. Requires `claude_api` or
 *     `gemini_api` backend env setup; surfaces `capability_not_available`
 *     when no backend is configured.
 *
 * Worker entity hints (window chrome, OCR text regions, a11y candidates)
 * are passed through when the capability manifest advertises them. Phase
 * 1 stubs them to the empty list — the worker hook is a phase-2+ addition
 * (enriched-tier) per `AGENT_MCP_REMAINING_WORK.md §2.3`.
 */

export interface WorkerEntity {
  kind: "window_chrome" | "text_region" | "interactive_candidate";
  bbox: { x: number; y: number; w: number; h: number };
  text?: string;
  confidence?: number;
  source: "worker_hint";
}

const VALID_MODES = ["agent_side", "server_side"] as const;
type DescribeMode = (typeof VALID_MODES)[number];
const SERVER_SIDE_BACKENDS = ["claude_api", "gemini_api"] as const;
type ServerSideVisionBackend = (typeof SERVER_SIDE_BACKENDS)[number];

interface RawArgs {
  mode?: unknown;
  preferred_vision_backend?: unknown;
  focus_description?: unknown;
}

export interface DescribeToolExtra {
  signal?: AbortSignal;
}

/**
 * Worker-side entity hints. Phase 1 placeholder: the worker doesn't emit
 * entity hints yet (enriched-tier is phase 2+). Exposed as a function so
 * the worker-side hook can plug in later without touching the tool.
 */
function collectWorkerEntities(): WorkerEntity[] {
  return [];
}

function parsePreferredVisionBackend(raw: unknown): ServerSideVisionBackend | "invalid" | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.toLowerCase();
  return (SERVER_SIDE_BACKENDS as readonly string[]).includes(normalized)
    ? normalized as ServerSideVisionBackend
    : "invalid";
}

function configuredVisionBackend(): string {
  return (process.env["SYNTHI_VISION_BACKEND"] ?? "agent_side").toLowerCase();
}

function resolveConfiguredServerSideBackend(): ServerSideVisionBackend | null {
  const configured = configuredVisionBackend();
  return (SERVER_SIDE_BACKENDS as readonly string[]).includes(configured)
    ? configured as ServerSideVisionBackend
    : null;
}

async function resolveServerSideDescription(
  frame: Buffer,
  focus: string,
  backend: ServerSideVisionBackend,
  signal?: AbortSignal
): Promise<{ summary: string; entities: WorkerEntity[]; backend: string; model?: string; cost_usd?: number }> {
  // Re-use the same lazy SDK imports as the locate backends. We keep the
  // wiring shallow here — this is a phase-1 seam, not a polished product
  // surface. Agents preferring richer descriptions should use agent_side
  // (their own LLM) today.
  const base64 = frame.toString("base64");
  if (backend === "claude_api") {
    const anthropicMod = (await import("@anthropic-ai/sdk")) as unknown as {
      default: new (opts: { apiKey: string }) => unknown;
    };
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey || apiKey.length === 0) {
      throw new Error("claude_api_no_key: set ANTHROPIC_API_KEY");
    }
    const client = new anthropicMod.default({ apiKey }) as unknown as {
      messages: {
        create: (req: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<{
          content: Array<{ type: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
        }>;
      };
    };
    const model = process.env["SYNTHI_VISION_MODEL"] ?? "claude-opus-4-7";
    const prompt =
      `Describe this UI screenshot concisely. ${focus ? `Focus: ${focus}. ` : ""}` +
      `Return JSON: {"summary": string, "entities": [{"kind": "window_chrome"|"text_region"|"interactive_candidate", "bbox": {"x":number,"y":number,"w":number,"h":number}, "text"?: string}]}. ` +
      `Only return raw JSON, no prose.`;
    const res = await client.messages.create(
      {
        model,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
              { type: "text", text: prompt },
            ],
          },
        ],
      },
      signal ? { signal } : undefined
    );
    const textBlock = res.content.find((b) => b.type === "text");
    const text = textBlock?.text ?? "{}";
    let parsed: { summary?: string; entities?: WorkerEntity[] } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { summary: text, entities: [] };
    }
    return {
      summary: parsed.summary ?? "",
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      backend: "claude_api",
      model,
    };
  }

  // gemini_api path
  const googleMod = (await import("@google/genai")) as unknown as {
    GoogleGenAI: new (opts: { apiKey: string }) => {
      models: {
        generateContent: (req: Record<string, unknown>) => Promise<{ text?: string }>;
      };
    };
  };
  const apiKey = process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"];
  if (!apiKey || apiKey.length === 0) {
    throw new Error("gemini_api_no_key: set GEMINI_API_KEY or GOOGLE_API_KEY");
  }
  const model = process.env["SYNTHI_GEMINI_MODEL"] ?? "gemini-2.5-flash";
  const client = new googleMod.GoogleGenAI({ apiKey });
  const prompt =
    `Describe this UI screenshot concisely. ${focus ? `Focus: ${focus}. ` : ""}` +
    `Return only raw JSON: {"summary": string, "entities": [{"kind": "window_chrome"|"text_region"|"interactive_candidate", "bbox": {"x":number,"y":number,"w":number,"h":number}, "text"?: string}]}.`;
  const res = await client.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: base64 } },
          { text: prompt },
        ],
      },
    ],
  });
  let parsed: { summary?: string; entities?: WorkerEntity[] } = {};
  try {
    parsed = JSON.parse(res.text ?? "{}");
  } catch {
    parsed = { summary: res.text ?? "", entities: [] };
  }
  return {
    summary: parsed.summary ?? "",
    entities: Array.isArray(parsed.entities) ? parsed.entities : [],
    backend: "gemini_api",
    model,
  };
}

export async function describeTool(args: unknown, extra?: DescribeToolExtra): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const mode: DescribeMode =
    typeof a.mode === "string" && (VALID_MODES as readonly string[]).includes(a.mode)
      ? (a.mode as DescribeMode)
      : "agent_side";
  const focus = typeof a.focus_description === "string" ? a.focus_description : "";

  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  let serverSideBackend: ServerSideVisionBackend | null = null;
  if (mode === "server_side") {
    const preferred = parsePreferredVisionBackend(a.preferred_vision_backend);
    if (preferred === "invalid") {
      return errorResponse("invalid_args", {
        field: "preferred_vision_backend",
        expected: "claude_api|gemini_api",
      });
    }
    serverSideBackend = preferred ?? resolveConfiguredServerSideBackend();
    if (!serverSideBackend) {
      const configured = configuredVisionBackend();
      return errorResponse("capability_not_available", {
        message: `capability_not_available: server_side describe needs SYNTHI_VISION_BACKEND=claude_api|gemini_api; got '${configured}'`,
        available_capabilities: [],
        hint: "set SYNTHI_VISION_BACKEND=claude_api|gemini_api, or call synthi_describe({mode:'agent_side'}).",
      });
    }
    const policy = assertBrokerProviderAllowed({
      provider: serverSideBackend,
      sends_screenshot: true,
      session_id: attached.sessionId,
    });
    if (!policy.ok) {
      return errorResponse(policy.error.error, {
        ...policy.error.detail,
        broker_error: policy.error,
      });
    }
  }

  let frame;
  try {
    if (!attached.frames.hasFrame()) {
      await attached.frames.waitForFirstFrame(10_000);
    }
    frame = await attached.frames.getFrame();
  } catch (err) {
    return errorFromException("no_frame_yet", err);
  }

  const workerEntities = collectWorkerEntities();

  if (mode === "agent_side") {
    try {
      const png = await sharp(frame.data).png({ compressionLevel: 6 }).toBuffer();
      const base64 = png.toString("base64");
      eventLog.push({
        kind: "usage",
        metric: "screenshot",
        value: 1,
        detail: { bytes: png.length, source: "synthi_describe:agent_side" },
      });
      session.touch();
      return jsonResponse({
        ok: true,
        mode: "agent_side",
        frame_seq: frame.seq,
        frame_ts: frame.ts,
        width: frame.width,
        height: frame.height,
        screenshot: base64,
        mimeType: "image/png",
        entities: workerEntities,
      });
    } catch (err) {
      return errorFromException("describe_failed", err);
    }
  }

  // mode === "server_side"
  const handle = requestRegistry.register("synthi_describe", extra?.signal);
  try {
    const png = await sharp(frame.data).png({ compressionLevel: 6 }).toBuffer();
    const result = await resolveServerSideDescription(png, focus, serverSideBackend!, handle.signal);
    eventLog.push({
      kind: "usage",
      metric: "vision_inference",
      value: 1,
      detail: {
        source: "synthi_describe",
        backend: result.backend,
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.cost_usd !== undefined ? { cost_usd: result.cost_usd } : {}),
      },
    });
    session.touch();
    return jsonResponse({
      ok: true,
      mode: "server_side",
      request_id: handle.id,
      frame_seq: frame.seq,
      frame_ts: frame.ts,
      width: frame.width,
      height: frame.height,
      summary: result.summary,
      entities: [...workerEntities, ...result.entities],
      backend: result.backend,
      ...(result.model !== undefined ? { model: result.model } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (handle.signal.aborted || message.includes("_aborted")) {
      return errorResponse("request_cancelled", { request_id: handle.id, reason: message });
    }
    if (message.startsWith("capability_not_available")) {
      return errorResponse("capability_not_available", {
        message,
        available_capabilities: [],
        hint: "set SYNTHI_VISION_BACKEND=claude_api|gemini_api, or call synthi_describe({mode:'agent_side'}).",
      });
    }
    if (message.startsWith("claude_api_no_key") || message.startsWith("gemini_api_no_key")) {
      return errorResponse(message.split(":")[0] ?? "vision_backend_no_key", { message });
    }
    return errorFromException("describe_failed", err);
  } finally {
    handle.unregister();
  }
}
