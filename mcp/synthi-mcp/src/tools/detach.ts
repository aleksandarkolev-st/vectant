import { session } from "../session.js";
import { errorFromException, jsonResponse, type ToolResponse } from "./shared.js";

export async function detachTool(_args: unknown): Promise<ToolResponse> {
  try {
    const wasAttached = session.getState() === "attached";
    await session.close();
    session._resetForTests();
    return jsonResponse({
      ok: true,
      detached: wasAttached,
    });
  } catch (err) {
    return errorFromException("detach_failed", err);
  }
}
