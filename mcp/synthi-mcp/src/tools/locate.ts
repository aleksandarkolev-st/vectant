import { locateEngine } from "../locate/index.js";
import type { LocateArgs, LocateBackendName } from "../locate/index.js";
import { session } from "../session.js";
import {
  errorFromException,
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

const BACKEND_NAMES: readonly LocateBackendName[] = ["mock", "agent_side", "claude_api"];

interface RawArgs {
  description?: unknown;
  hints?: unknown;
  preferred_vision_backend?: unknown;
  handle_id?: unknown;
  reuse_handle?: unknown;
}

export async function locateTool(args: unknown): Promise<ToolResponse> {
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

  try {
    const result = await locateEngine.resolve(built, {
      frame: frame.data,
      frameDims: { w: frame.width, h: frame.height },
    });
    return jsonResponse({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
    if (message.startsWith("locator_unresolved")) {
      return errorResponse("locator_unresolved", { message });
    }
    return errorFromException("locate_failed", err);
  }
}
