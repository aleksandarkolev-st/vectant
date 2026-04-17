import { session } from "../session.js";
import {
  errorFromException,
  imageAndTextResponse,
  type ToolResponse,
} from "./shared.js";

export async function screenshotTool(_args: unknown): Promise<ToolResponse> {
  try {
    const attached = session.require();
    const frame = await attached.frames.getFrame();
    const base64 = frame.data.toString("base64");
    return imageAndTextResponse(base64, {
      w: frame.width,
      h: frame.height,
      ts: frame.ts,
      seq: frame.seq,
      mimeType: "image/png",
    });
  } catch (err) {
    return errorFromException("screenshot_failed", err);
  }
}
