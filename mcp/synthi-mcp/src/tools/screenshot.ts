import { createHash } from "node:crypto";
import sharp from "sharp";
import { session } from "../session.js";
import { eventLog } from "../events/index.js";
import { brokerSloRecorder, recordBrokerFrameObservation, type BrokerFrameEvent } from "../broker/index.js";
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
  allow_unbrokered_frame?: unknown;
  after_frame_gate?: unknown;
  afterFrameGate?: unknown;
  frame_gate_timeout_ms?: unknown;
  frameGateTimeoutMs?: unknown;
}

interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FrameGateRequirement {
  frameSeq?: number;
  tsMs?: number;
  gateToken: string;
  sessionId?: string;
}

interface FrameGateSatisfiedMeta {
  status: "satisfied";
  required_frame_seq?: number;
  required_ts_ms?: number;
  gate_token: string;
  gate_token_verified: true;
  gate_token_issued_at_ms?: number;
  gate_token_expires_at_ms?: number;
  session_id: string;
  captured_frame_seq: number;
  captured_ts_ms: number;
  timeout_ms: number;
}

interface ScreenshotFrame {
  data: Buffer;
  width: number;
  height: number;
  dpr?: number;
  ts: number;
  seq: number;
  contentHash?: string;
}

const DEFAULT_FRAME_GATE_TIMEOUT_MS = 20 * 60 * 1000;
const FRAME_GATE_POLL_MS = 50;
const CAPTURE_MANIFEST_SCHEMA_VERSION = "synthi.mcp.capture_manifest.v1";

function parseBBox(v: unknown): BBox | "invalid" | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object") return "invalid";
  const o = v as Record<string, unknown>;
  if (typeof o["x"] !== "number" || typeof o["y"] !== "number" ||
      typeof o["w"] !== "number" || typeof o["h"] !== "number") return "invalid";
  if (o["w"]! <= 0 || o["h"]! <= 0) return "invalid";
  return { x: o["x"] as number, y: o["y"] as number, w: o["w"] as number, h: o["h"] as number };
}

function parseNonNegativeNumber(value: unknown): number | "invalid" | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "invalid";
  return value;
}

function parseNonNegativeInteger(value: unknown): number | "invalid" | undefined {
  const parsed = parseNonNegativeNumber(value);
  if (parsed === undefined || parsed === "invalid") return parsed;
  return Number.isInteger(parsed) ? parsed : "invalid";
}

function parseFrameGate(
  value: unknown
): FrameGateRequirement | "invalid" | { unsatisfied: Record<string, unknown> } | { unverified: Record<string, unknown> } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return "invalid";
  const gate = value as Record<string, unknown>;
  const status = gate["status"];
  if (status !== "satisfied") {
    return {
      unsatisfied: {
        status: typeof status === "string" ? status : null,
        reason: "after_frame_gate must come from a satisfied wait_hmr frame_gate",
      },
    };
  }

  const frameSeq = parseNonNegativeInteger(gate["frame_seq"] ?? gate["frameSeq"]);
  if (frameSeq === "invalid") return "invalid";
  const tsMs = parseNonNegativeNumber(gate["ts_ms"] ?? gate["tsMs"]);
  if (tsMs === "invalid") return "invalid";
  if (frameSeq === undefined && tsMs === undefined) return "invalid";
  const gateToken = gate["gate_token"] ?? gate["gateToken"];
  if (typeof gateToken !== "string" || gateToken.trim().length === 0) {
    return {
      unverified: {
        status: "unverified",
        reason: "satisfied after_frame_gate must include a one-time wait_hmr gate_token",
      },
    };
  }
  const sessionId = gate["session_id"] ?? gate["sessionId"];
  if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.trim().length === 0)) {
    return "invalid";
  }

  return {
    ...(frameSeq !== undefined ? { frameSeq } : {}),
    ...(tsMs !== undefined ? { tsMs } : {}),
    gateToken: gateToken.trim(),
    ...(typeof sessionId === "string" ? { sessionId: sessionId.trim() } : {}),
  };
}

function frameSatisfiesGate(frame: { seq: number; ts: number }, gate: FrameGateRequirement): boolean {
  if (gate.frameSeq !== undefined && frame.seq < gate.frameSeq) return false;
  if (gate.tsMs !== undefined && frame.ts < gate.tsMs) return false;
  return true;
}

function frameGateMeta(
  frame: { seq: number; ts: number },
  gate: FrameGateRequirement,
  timeoutMs: number,
  sessionId: string,
  token: { issued_at_ms?: number; expires_at_ms?: number } | null
): FrameGateSatisfiedMeta {
  return {
    status: "satisfied",
    ...(gate.frameSeq !== undefined ? { required_frame_seq: gate.frameSeq } : {}),
    ...(gate.tsMs !== undefined ? { required_ts_ms: gate.tsMs } : {}),
    gate_token: gate.gateToken,
    gate_token_verified: true,
    ...(token?.issued_at_ms !== undefined ? { gate_token_issued_at_ms: token.issued_at_ms } : {}),
    ...(token?.expires_at_ms !== undefined ? { gate_token_expires_at_ms: token.expires_at_ms } : {}),
    session_id: sessionId,
    captured_frame_seq: frame.seq,
    captured_ts_ms: frame.ts,
    timeout_ms: timeoutMs,
  };
}

async function waitForFrameGate(
  getFrame: () => Promise<ScreenshotFrame>,
  gate: FrameGateRequirement,
  timeoutMs: number
): Promise<ScreenshotFrame | null> {
  const start = Date.now();
  for (;;) {
    const frame = await getFrame();
    if (frameSatisfiesGate(frame, gate)) return frame;
    if (Date.now() - start >= timeoutMs) return null;
    const remaining = Math.max(0, timeoutMs - (Date.now() - start));
    await new Promise((resolve) => setTimeout(resolve, Math.min(FRAME_GATE_POLL_MS, remaining)));
  }
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

function sha256(data: Buffer): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
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

  let allowUnbrokeredFrame = false;
  if (a.allow_unbrokered_frame !== undefined) {
    if (typeof a.allow_unbrokered_frame !== "boolean") {
      return errorResponse("invalid_args", { field: "allow_unbrokered_frame", expected: "boolean" });
    }
    allowUnbrokeredFrame = a.allow_unbrokered_frame;
  }

  const afterFrameGateValue = a.after_frame_gate ?? a.afterFrameGate;
  const afterFrameGate = parseFrameGate(afterFrameGateValue);
  if (afterFrameGate === "invalid") {
    return errorResponse("invalid_args", {
      field: a.after_frame_gate !== undefined ? "after_frame_gate" : "afterFrameGate",
      expected: "satisfied wait_hmr frame_gate with frame_seq and/or ts_ms",
    });
  }
  if (afterFrameGate && "unsatisfied" in afterFrameGate) {
    return errorResponse("frame_gate_unsatisfied", afterFrameGate.unsatisfied);
  }
  if (afterFrameGate && "unverified" in afterFrameGate) {
    return errorResponse("frame_gate_unverified", afterFrameGate.unverified);
  }

  const frameGateTimeoutValue = a.frame_gate_timeout_ms ?? a.frameGateTimeoutMs;
  let frameGateTimeoutMs = DEFAULT_FRAME_GATE_TIMEOUT_MS;
  if (frameGateTimeoutValue !== undefined) {
    const parsed = parseNonNegativeInteger(frameGateTimeoutValue);
    if (parsed === "invalid" || parsed === undefined) {
      return errorResponse("invalid_args", {
        field: a.frame_gate_timeout_ms !== undefined ? "frame_gate_timeout_ms" : "frameGateTimeoutMs",
        expected: "non-negative integer milliseconds",
      });
    }
    frameGateTimeoutMs = parsed;
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
    const frame = afterFrameGate
      ? await waitForFrameGate(() => attached.frames.getFrame(), afterFrameGate, frameGateTimeoutMs)
      : await attached.frames.getFrame();

    if (!frame) {
      const latest = await attached.frames.getFrame().catch(() => null);
      return errorResponse("frame_gate_timeout", {
        requested_frame_seq: afterFrameGate?.frameSeq ?? null,
        requested_ts_ms: afterFrameGate?.tsMs ?? null,
        timeout_ms: frameGateTimeoutMs,
        latest_frame_seq: latest?.seq ?? null,
        latest_ts_ms: latest?.ts ?? null,
      });
    }
    if (afterFrameGate?.sessionId !== undefined && afterFrameGate.sessionId !== attached.sessionId) {
      return errorResponse("frame_gate_unverified", {
        status: "unverified",
        reason: "frame_gate_session_mismatch",
        session_id: attached.sessionId,
        requested_session_id: afterFrameGate.sessionId,
      });
    }
    const gateTokenValidation = afterFrameGate
      ? session.consumeFrameGateToken({
          token: afterFrameGate.gateToken,
          session_id: attached.sessionId,
          frame_seq: afterFrameGate.frameSeq,
          ts_ms: afterFrameGate.tsMs,
        })
      : null;
    if (afterFrameGate && gateTokenValidation?.accepted !== true) {
      return errorResponse("frame_gate_unverified", {
        status: "unverified",
        reason: gateTokenValidation?.reason ?? "frame_gate_token_rejected",
        session_id: attached.sessionId,
        requested_session_id: afterFrameGate.sessionId ?? null,
        requested_frame_seq: afterFrameGate.frameSeq ?? null,
        requested_ts_ms: afterFrameGate.tsMs ?? null,
      });
    }
    const frameGate = afterFrameGate
      ? frameGateMeta(
          frame,
          afterFrameGate,
          frameGateTimeoutMs,
          attached.sessionId,
          gateTokenValidation?.token ?? null,
        )
      : undefined;

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
    const imageHash = sha256(png);
    const sourceFrameHash = frame.contentHash ?? sha256(frame.data);
    const scaledMeta = resultMeta.scaled ? await sharp(png).metadata() : null;
    if (scaledMeta) {
      resultMeta.w = scaledMeta.width ?? resultMeta.w;
      resultMeta.h = scaledMeta.height ?? resultMeta.h;
    }

    const base64 = png.toString("base64");
    const screenshotDpr = readOnlyScreenshotDpr(frame.dpr);
    let brokerFrame: BrokerFrameEvent | undefined;
    let brokerFrameError: string | undefined;
    try {
      const brokerDpr = allowUnbrokeredFrame && screenshotDpr.inferred ? undefined : screenshotDpr.dpr;
      brokerFrame = recordBrokerFrameObservation({
        session_id: attached.sessionId,
        frame: { ...frame, contentHash: sourceFrameHash },
        ...(brokerDpr !== undefined ? { dpr: brokerDpr } : {}),
      });
    } catch (err) {
      if (!allowUnbrokeredFrame) throw err;
      brokerFrameError = err instanceof Error ? err.message : String(err);
    }
    const responseTs = Date.now();
    const captureManifest = brokerFrame ? {
      schema_version: CAPTURE_MANIFEST_SCHEMA_VERSION,
      session_id: attached.sessionId,
      capture_backend: "mcp_screenshot",
      capture_event_id: `screenshot:${attached.sessionId}:${frame.seq}:${responseTs}`,
      frame_event_id: brokerFrame.event_id,
      frame_seq: frame.seq,
      frame_ts_ms: frame.ts,
      capture_ts_ms: responseTs,
      source_frame_hash: sourceFrameHash,
      broker_frame_hash: brokerFrame.content_hash ?? sourceFrameHash,
      image_sha256: imageHash,
      image_byte_length: png.length,
      width: resultMeta.w,
      height: resultMeta.h,
      original_width: frame.width,
      original_height: frame.height,
      dpr: screenshotDpr.dpr,
      ...(frameGate !== undefined
        ? {
            frame_gate: frameGate,
            gate_token: frameGate.gate_token,
            gate_token_verified: true,
            required_frame_seq: frameGate.required_frame_seq ?? null,
            required_ts_ms: frameGate.required_ts_ms ?? null,
          }
        : {
            gate_token_verified: false,
          }),
    } : undefined;
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
        capture_manifest: captureManifest,
        ...(frameGate !== undefined ? { frame_gate: frameGate } : {}),
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
      image_sha256: imageHash,
      image_byte_length: png.length,
      source_frame_hash: sourceFrameHash,
      brokered: brokerFrame !== undefined,
      ...(brokerFrame !== undefined
        ? {
            dpr: screenshotDpr.dpr,
            dpr_inferred: screenshotDpr.inferred,
            viewport: { w: frame.width, h: frame.height, dpr: screenshotDpr.dpr },
            broker_frame: brokerFrame,
            capture_manifest: captureManifest,
            ...(frameGate !== undefined ? { frame_gate: frameGate } : {}),
          }
        : {
            broker_frame_error: brokerFrameError ?? "unbrokered_frame",
          }),
      ...(resultMeta.crop !== undefined ? { region: resultMeta.crop } : {}),
      ...(resultMeta.scaled === true ? { scaled: true } : {}),
      mimeType: "image/png",
    });
  } catch (err) {
    return errorFromException("screenshot_failed", err);
  }
}
