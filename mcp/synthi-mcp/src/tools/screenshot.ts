import sharp from "sharp";
import { session } from "../session.js";
import { eventLog } from "../events/index.js";
import { brokerSloRecorder, recordBrokerFrameObservation } from "../broker/index.js";
import {
  errorFromException,
  errorResponse,
  imageAndTextResponse,
  type ToolResponse,
} from "./shared.js";

interface RawArgs {
  region?: unknown;
  max_dim?: unknown;
  freshness_max_ms?: unknown;
}

interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function parseBBox(v: unknown): BBox | "invalid" | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object") return "invalid";
  const o = v as Record<string, unknown>;
  if (typeof o["x"] !== "number" || typeof o["y"] !== "number" ||
      typeof o["w"] !== "number" || typeof o["h"] !== "number") return "invalid";
  if (o["w"]! <= 0 || o["h"]! <= 0) return "invalid";
  return { x: o["x"] as number, y: o["y"] as number, w: o["w"] as number, h: o["h"] as number };
}

function readOnlyScreenshotDpr(dpr: unknown): { dpr: number; inferred: boolean } {
  if (typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0) {
    return { dpr, inferred: false };
  }
  // Read-only screenshots do not need DPR for coordinate safety. Input tools
  // still reject missing producer DPR; observation can safely report CSS-pixel
  // parity when the worker video stream lacks viewport metadata.
  return { dpr: 1, inferred: true };
}

/**
 * Return the latest video frame as PNG, optionally cropped + downscaled.
 *
 * Inputs:
 *  - region:           {x,y,w,h}? — crop to this bbox (clamped to frame).
 *  - max_dim:          number?    — downscale so longest edge ≤ max_dim.
 *  - freshness_max_ms: number?    — return frame_stale if latest frame
 *                                   is older than now - freshness_max_ms.
 */
export async function screenshotTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;

  const region = parseBBox(a.region);
  if (region === "invalid") {
    return errorResponse("invalid_args", {
      field: "region",
      expected: "{x:number, y:number, w:positive number, h:positive number}",
    });
  }

  let maxDim: number | undefined;
  if (a.max_dim !== undefined) {
    if (typeof a.max_dim !== "number" || !Number.isInteger(a.max_dim) || a.max_dim < 1) {
      return errorResponse("invalid_args", { field: "max_dim", expected: "positive integer" });
    }
    maxDim = a.max_dim;
  }

  let freshnessMaxMs: number | undefined;
  if (a.freshness_max_ms !== undefined) {
    if (typeof a.freshness_max_ms !== "number" || a.freshness_max_ms < 0) {
      return errorResponse("invalid_args", { field: "freshness_max_ms", expected: "non-negative number" });
    }
    freshnessMaxMs = a.freshness_max_ms;
  }

  try {
    const attached = session.require();
    // attach() returns as soon as the peer connection + data channels are
    // ready, but video frames need another ~1–2s: keyframe arrival + VP8
    // decode → PNG. Wait here instead of forcing every caller to retry on
    // `no_frame_yet` — the old 30s attach timeout used to mask this race
    // but now that attach succeeds fast, the first screenshot can easily
    // beat the first decoded frame.
    if (!attached.frames.hasFrame()) {
      await attached.frames.waitForFirstFrame(10_000);
    }
    const frame = await attached.frames.getFrame();

    if (freshnessMaxMs !== undefined) {
      const now = Date.now();
      const staleMs = now - frame.ts;
      if (staleMs > freshnessMaxMs) {
        return errorResponse("frame_stale", {
          last_fresh_ts: frame.ts,
          stale_ms: staleMs,
          requested_max_ms: freshnessMaxMs,
        });
      }
    }

    let pipeline = sharp(frame.data);
    const resultMeta: { w: number; h: number; crop?: BBox; scaled?: boolean } = {
      w: frame.width,
      h: frame.height,
    };

    if (region) {
      // Reject before clamping if the region doesn't overlap the frame.
      if (
        region.x >= frame.width || region.y >= frame.height ||
        region.x + region.w <= 0 || region.y + region.h <= 0
      ) {
        return errorResponse("click_out_of_bounds", {
          viewport: { w: frame.width, h: frame.height },
          requested: region,
          reason: "region_entirely_off_frame",
        });
      }
      const left = Math.max(0, region.x);
      const top = Math.max(0, region.y);
      const right = Math.min(frame.width, region.x + region.w);
      const bottom = Math.min(frame.height, region.y + region.h);
      const extract = { left, top, width: right - left, height: bottom - top };
      pipeline = pipeline.extract(extract);
      resultMeta.w = extract.width;
      resultMeta.h = extract.height;
      resultMeta.crop = region;
    }

    if (maxDim !== undefined) {
      const longest = Math.max(resultMeta.w, resultMeta.h);
      if (longest > maxDim) {
        pipeline = pipeline.resize({ width: resultMeta.w >= resultMeta.h ? maxDim : undefined, height: resultMeta.h > resultMeta.w ? maxDim : undefined });
        resultMeta.scaled = true;
      }
    }

    const png = await pipeline.png({ compressionLevel: 6, adaptiveFiltering: false }).toBuffer();
    const scaledMeta = resultMeta.scaled ? await sharp(png).metadata() : null;
    if (scaledMeta) {
      resultMeta.w = scaledMeta.width ?? resultMeta.w;
      resultMeta.h = scaledMeta.height ?? resultMeta.h;
    }

    const base64 = png.toString("base64");
    const screenshotDpr = readOnlyScreenshotDpr(frame.dpr);
    const brokerFrame = recordBrokerFrameObservation({
      session_id: attached.sessionId,
      frame,
      dpr: screenshotDpr.dpr,
    });
    const responseTs = Date.now();
    brokerSloRecorder.recordDuration("screenshot_age_p95", responseTs - frame.ts, responseTs);
    eventLog.push({
      kind: "usage",
      metric: "screenshot",
      value: 1,
      detail: {
        bytes: png.length,
        frame_ts: frame.ts,
        response_ts: responseTs,
        screenshot_age_ms: responseTs - frame.ts,
        dpr_inferred: screenshotDpr.inferred,
        ...(resultMeta.crop !== undefined ? { cropped: true } : {}),
        ...(resultMeta.scaled === true ? { scaled: true } : {}),
      },
    });
    session.touch();
    return imageAndTextResponse(base64, {
      w: resultMeta.w,
      h: resultMeta.h,
      ts: frame.ts,
      seq: frame.seq,
      original_w: frame.width,
      original_h: frame.height,
      dpr: screenshotDpr.dpr,
      dpr_inferred: screenshotDpr.inferred,
      viewport: { w: frame.width, h: frame.height, dpr: screenshotDpr.dpr },
      broker_frame: brokerFrame,
      ...(resultMeta.crop !== undefined ? { region: resultMeta.crop } : {}),
      ...(resultMeta.scaled === true ? { scaled: true } : {}),
      mimeType: "image/png",
    });
  } catch (err) {
    return errorFromException("screenshot_failed", err);
  }
}
