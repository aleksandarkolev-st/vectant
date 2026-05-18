import { locateEngine } from "../locate/index.js";
import type { LocateArgs, LocateBackendName } from "../locate/index.js";
import { session } from "../session.js";
import { requestRegistry } from "../util/request_registry.js";
import { assertBrokerProviderAllowed } from "../broker/index.js";
import {
  errorFromException,
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

const BACKEND_NAMES: readonly LocateBackendName[] = [
  "mock",
  "agent_side",
  "claude_api",
  "gemini_api",
  "local",
];

interface RawArgs {
  description?: unknown;
  hints?: unknown;
  preferred_vision_backend?: unknown;
  handle_id?: unknown;
  reuse_handle?: unknown;
}

export interface LocateToolExtra {
  /** SDK-supplied cancellation signal (RequestHandlerExtra.signal). */
  signal?: AbortSignal;
}

export async function locateTool(args: unknown, extra?: LocateToolExtra): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  if (typeof a.description !== "string" || a.description.length === 0) {
    return errorResponse("invalid_args", { field: "description", expected: "non-empty string" });
  }

  let backend: LocateBackendName | undefined;
  if (a.preferred_vision_backend !== undefined) {
    if (typeof a.preferred_vision_backend !== "string" || !BACKEND_NAMES.includes(a.preferred_vision_backend as LocateBackendName)) {
      return errorResponse("invalid_args", {
        field: "preferred_vision_backend",
        allowed: BACKEND_NAMES,
      });
    }
    backend = a.preferred_vision_backend as LocateBackendName;
  }

  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  let frame;
  try {
    frame = await attached.frames.getFrame();
  } catch (err) {
    return errorFromException("no_frame_yet", err);
  }

  const built: LocateArgs = {
    description: a.description,
    ...(a.hints !== undefined ? { hints: a.hints as LocateArgs["hints"] } : {}),
    ...(backend !== undefined ? { preferred_vision_backend: backend } : {}),
    ...(typeof a.handle_id === "string" ? { handle_id: a.handle_id } : {}),
    ...(typeof a.reuse_handle === "boolean" ? { reuse_handle: a.reuse_handle } : {}),
  };
  const chosenBackend = backend ?? (process.env["SYNTHI_VISION_BACKEND"] as LocateBackendName | undefined) ?? "agent_side";
  const hints = a.hints && typeof a.hints === "object" ? a.hints as Record<string, unknown> : {};
  const providerGate = assertBrokerProviderAllowed({
    provider: chosenBackend,
    sends_screenshot: (chosenBackend === "claude_api" || chosenBackend === "gemini_api") && !hints["prefer_region"],
    session_id: attached.sessionId,
  });
  if (!providerGate.ok) {
    return errorResponse(providerGate.error.error, providerGate.error as unknown as Record<string, unknown>);
  }

  // Register the call so (a) the SDK-supplied signal propagates to the
  // vision backend and (b) operators/shutdown can cancel in-flight calls
  // by id. The Anthropic SDK picks up `signal` and aborts before billing.
  const handle = requestRegistry.register("synthi_locate", extra?.signal);
  try {
    const result = await locateEngine.resolve(built, {
      frame: frame.data,
      frameDims: { w: frame.width, h: frame.height },
      signal: handle.signal,
    });
    return jsonResponse({ ok: true, request_id: handle.id, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (handle.signal.aborted || message.includes("_aborted")) {
      return errorResponse("request_cancelled", {
        request_id: handle.id,
        reason: message,
      });
    }
    const ts = new Date().toISOString().slice(11, 23);
    const stack = err instanceof Error && err.stack ? err.stack : message;
    process.stderr.write(`[mcp ${ts}] locate: ${stack}\n`);
    if (message.startsWith("agent_side_vision_required")) {
      return errorResponse("agent_side_vision_required", {
        hint: "Run your own vision grounding on the provided screenshot, then re-call synthi_locate with hints.prefer_region populated.",
      });
    }
    if (message.startsWith("claude_api_not_implemented")) {
      return errorResponse("claude_api_not_implemented", {
        hint: "claude_api backend is a phase-0.5 stub; set SYNTHI_VISION_BACKEND=mock for spike, or pass hints.prefer_region to bypass.",
      });
    }
    if (message.startsWith("gemini_api_no_key")) {
      return errorResponse("gemini_api_no_key", {
        hint: "Set GEMINI_API_KEY (or GOOGLE_API_KEY) in the MCP process env, or switch to SYNTHI_VISION_BACKEND=agent_side.",
      });
    }
    if (message.startsWith("gemini_api_low_confidence") || message.startsWith("claude_api_low_confidence")) {
      return errorResponse("locator_unresolved", { message });
    }
    if (message.startsWith("locator_unresolved")) {
      return errorResponse("locator_unresolved", { message });
    }
    return errorFromException("locate_failed", err);
  } finally {
    handle.unregister();
  }
}
