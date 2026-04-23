/**
 * Local vision backend — Phase 3 scaffold (ultraplan §Vision backend,
 * PHASE_2_PLUS_BACKLOG D6).
 *
 * Motivation: a server-side VLM call through Anthropic / Google pays a
 * $0.002–$0.02 tax per locate, and on a tight interactive loop
 * (edit → compile → wait → locate → click) that adds up fast. A local
 * grounding model (e.g. Qwen2-VL, Moondream, or a Florence-2 head)
 * hosted on the developer's workstation flattens the tail latency and
 * the bill.
 *
 * Phase 3 ships the wire-compatible backend; the actual model host is a
 * deployment concern (docker-compose profile, local Ollama, vLLM server).
 * The contract is an HTTP POST to `SYNTHI_LOCAL_VISION_URL`:
 *
 *   POST <url>
 *   {
 *     "description": "the blue button",
 *     "hints": {"prefer_region":{x,y,w,h}, ...},
 *     "frame": {"png_base64":"...", "width": N, "height": M}
 *   }
 *
 * The server responds with:
 *
 *   { "bbox": {"x","y","w","h"}, "confidence": 0..1, "trace": "..."? }
 *
 * On non-2xx, we propagate `local_vision_backend_error` with the status.
 * On missing env, we fail fast with `local_vision_backend_not_configured`
 * so agents can branch on capability rather than silently retry.
 */

import type { BBox } from "../util/phash.js";
import type { VisionBackend, BackendResolution } from "./backends.js";
import type { LocateHints } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface LocalBackendOptions {
  /** Override the env-derived URL. Tests pass a loopback stub URL. */
  endpointUrl?: string;
  /** Per-request timeout in milliseconds. Default 10s. */
  timeoutMs?: number;
  /** Override the HTTP client (test injection). */
  fetchImpl?: typeof fetch;
  /** Extra headers (e.g. auth tokens). */
  headers?: Record<string, string>;
}

export class LocalVisionBackend implements VisionBackend {
  readonly name = "local" as const;
  private readonly opts: LocalBackendOptions;

  constructor(opts: LocalBackendOptions = {}) {
    this.opts = opts;
  }

  resolvedEndpoint(): string | undefined {
    return this.opts.endpointUrl ?? process.env["SYNTHI_LOCAL_VISION_URL"];
  }

  async resolve(args: {
    description: string;
    frame: Buffer;
    hints?: LocateHints;
    frameDims: { w: number; h: number };
    signal?: AbortSignal;
  }): Promise<BackendResolution> {
    if (args.signal?.aborted) throw new Error("local_vision_aborted: pre_call");

    // Honour prefer_region short-circuit so a planner that already knows
    // the exact bbox doesn't spend a local GPU cycle.
    if (args.hints?.prefer_region) {
      return {
        bbox: args.hints.prefer_region,
        confidence: 1,
        trace: "local_used_prefer_region",
      };
    }

    const endpoint = this.resolvedEndpoint();
    if (!endpoint) {
      throw new Error(
        "local_vision_backend_not_configured: set SYNTHI_LOCAL_VISION_URL or pass endpointUrl explicitly"
      );
    }

    const body = {
      description: args.description,
      hints: args.hints ?? {},
      frame: {
        png_base64: args.frame.toString("base64"),
        width: args.frameDims.w,
        height: args.frameDims.h,
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("local_vision_timeout")),
      this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const upstreamSignal = args.signal;
    const onAbort = (): void => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal) upstreamSignal.addEventListener("abort", onAbort, { once: true });

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg.includes("local_vision_timeout")) {
        throw new Error(`local_vision_timeout: endpoint=${endpoint}`);
      }
      if (msg.includes("local_vision_aborted")) {
        throw new Error(`local_vision_aborted: endpoint=${endpoint}`);
      }
      throw new Error(`local_vision_unreachable: ${msg} endpoint=${endpoint}`);
    } finally {
      clearTimeout(timeout);
      if (upstreamSignal) upstreamSignal.removeEventListener("abort", onAbort);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "(body unreadable)");
      throw new Error(
        `local_vision_backend_error: status=${res.status} body=${text.slice(0, 200)}`
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new Error(
        `local_vision_backend_error: invalid_json ${(err as Error).message ?? String(err)}`
      );
    }
    const parsed = parseLocalResponse(json);
    if ("error" in parsed) throw new Error(`local_vision_backend_error: ${parsed.error}`);

    return {
      bbox: parsed.bbox,
      confidence: parsed.confidence,
      trace: parsed.trace ?? "local_model_resolved",
    };
  }
}

export interface ParsedLocalResponse {
  bbox: BBox;
  confidence: number;
  trace?: string;
}

type ParsedLocalResult = ParsedLocalResponse | { error: string };

export function parseLocalResponse(raw: unknown): ParsedLocalResult {
  if (!raw || typeof raw !== "object") return { error: "response_not_object" };
  const o = raw as Record<string, unknown>;
  const bboxRaw = o["bbox"] as Record<string, unknown> | undefined;
  if (!bboxRaw || typeof bboxRaw !== "object") return { error: "missing_bbox" };
  const nums = ["x", "y", "w", "h"] as const;
  for (const k of nums) {
    if (typeof bboxRaw[k] !== "number" || !Number.isFinite(bboxRaw[k] as number)) {
      return { error: `bbox.${k}_not_number` };
    }
  }
  const bbox: BBox = {
    x: bboxRaw["x"] as number,
    y: bboxRaw["y"] as number,
    w: bboxRaw["w"] as number,
    h: bboxRaw["h"] as number,
  };
  if (bbox.w <= 0 || bbox.h <= 0) return { error: "bbox_non_positive" };
  const confidenceRaw = typeof o["confidence"] === "number" ? (o["confidence"] as number) : 1;
  const confidence = Math.max(0, Math.min(1, confidenceRaw));
  const trace = typeof o["trace"] === "string" ? (o["trace"] as string) : undefined;
  return trace !== undefined ? { bbox, confidence, trace } : { bbox, confidence };
}

let defaultLocalBackend: LocalVisionBackend | undefined;

export function getDefaultLocalBackend(): LocalVisionBackend {
  if (!defaultLocalBackend) defaultLocalBackend = new LocalVisionBackend();
  return defaultLocalBackend;
}

export function _resetDefaultLocalBackendForTests(): void {
  defaultLocalBackend = undefined;
}
