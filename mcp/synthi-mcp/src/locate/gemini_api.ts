/**
 * Real `gemini_api` vision backend — Google Gemini multimodal call for
 * natural-language → bbox grounding. Mirrors `claude_api.ts` so the two
 * backends are operationally symmetric: injectable client for tests,
 * lazy SDK load for production, `(content_hash, description_hash)`
 * cache, usage event emission, AbortSignal support.
 *
 * Why Gemini at all (given we already have claude_api):
 *   - Users with existing GEMINI_API_KEY shouldn't have to provision a
 *     second vendor account to get server-side caching.
 *   - `gemini-2.5-flash` tails are competitive with `claude-sonnet` and
 *     materially cheaper; useful for tight agent loops against
 *     animated UIs (E2b workload).
 *   - Defense-in-depth: a vendor outage on one side isn't a full
 *     `synthi_locate` outage when the caller can pin the other.
 *
 * Wire shape:
 *   Params are the `@google/genai` SDK's `GenerateContentParameters`
 *   shape:
 *     {model, contents: Content[], config: {systemInstruction,
 *      maxOutputTokens, abortSignal}}
 *   where each Content has `parts: Part[]`, and each Part is either
 *   `{text}` or `{inlineData: {mimeType, data}}`. We model only the
 *   fields we use so tests can pass a minimal mock.
 *
 *   Response is extracted via candidates[0].content.parts[*].text (the
 *   real SDK exposes a `.text` getter that does the same concatenation;
 *   we extract from the raw shape so tests can mock without simulating
 *   getters).
 */

import type { BBox } from "../util/phash.js";
import { eventLog } from "../events/index.js";
import type { LocateHints, LocateBackendName } from "./types.js";
import type { BackendResolution, VisionBackend } from "./backends.js";
import {
  buildSystemPrompt,
  buildUserText,
  clampBboxToFrame,
  contentHash,
  descriptionHash,
  parseBboxResponse as sharedParseBboxResponse,
  type CachedVisionEntry,
} from "./vision_utils.js";

/** Per-million-token USD prices. Extend as new Gemini models ship. */
export const GEMINI_PRICING_USD_PER_MILLION: Record<string, { input: number; output: number }> = {
  // Current generation (gemini-2.5-*). Input = text + image tokens;
  // Google reports them aggregated under promptTokenCount.
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  // Legacy generation.
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.3 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
};

/**
 * Safe fallback pricing when the model id is not in the table (e.g., a
 * new preview model). Keeps the cost estimate conservative (pro-tier)
 * so logs never silently underbill.
 */
export const GEMINI_FALLBACK_PRICING = { input: 1.25, output: 10 };

export function computeGeminiCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = GEMINI_PRICING_USD_PER_MILLION[model] ?? GEMINI_FALLBACK_PRICING;
  const cost = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000; // round to µUSD
}

/**
 * The subset of the `@google/genai` SDK we depend on. Declared here so
 * tests can pass a plain object without importing the real SDK.
 *
 * The real SDK's `generateContent` accepts:
 *   {model, contents, config?: {systemInstruction, maxOutputTokens,
 *    abortSignal, ...}}
 * and returns a `GenerateContentResponse` object with `candidates[]`
 * and `usageMetadata`.
 */
export interface GeminiTextPart {
  text: string;
}
export interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}
export type GeminiPart = GeminiTextPart | GeminiInlineDataPart;

export interface GeminiContent {
  role?: string;
  parts: GeminiPart[];
}

export interface GeminiGenerateConfig {
  systemInstruction?: string | GeminiContent;
  maxOutputTokens?: number;
  /**
   * Force the model to emit a specific MIME type. `application/json`
   * makes Gemini return a single JSON object even when the element
   * isn't visible, which is how we keep the "not found" path from
   * collapsing into prose and tripping gemini_api_parse_error.
   */
  responseMimeType?: string;
  /** Forwarded to fetch() — aborts the API call without finishing. */
  abortSignal?: AbortSignal;
}

export interface GeminiGenerateParams {
  model: string;
  contents: GeminiContent[];
  config?: GeminiGenerateConfig;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      role?: string;
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsageMetadata;
}

export interface GeminiLike {
  models: {
    generateContent(params: GeminiGenerateParams): Promise<GeminiGenerateResponse>;
  };
}

/** Concatenate all text parts from the first candidate. */
export function extractGeminiText(response: GeminiGenerateResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p): string => ("text" in p && typeof p.text === "string" ? p.text : ""))
    .filter((s) => s.length > 0)
    .join("");
}

/** Parse the bbox JSON body with a gemini-specific error prefix. */
export function parseGeminiBboxResponse(text: string): ReturnType<typeof sharedParseBboxResponse> {
  return sharedParseBboxResponse(text, "gemini_api_parse_error");
}

export interface GeminiApiBackendOptions {
  client?: GeminiLike;
  model?: string;
  /** Max tokens for the response. Defaults to 256. */
  maxTokens?: number;
  /** Suppress usage event emission. Useful for pure unit tests. */
  silentUsage?: boolean;
  /** Lower bound on confidence below which the result is treated as unresolved. */
  minConfidence?: number;
  /** Cache TTL in ms. Entries expire regardless of content hash after this. */
  cacheTtlMs?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.3;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_MODEL = "gemini-2.5-flash";

export class GeminiApiBackendReal implements VisionBackend {
  readonly name: LocateBackendName = "gemini_api";

  private readonly model: string;
  private readonly maxTokens: number;
  private readonly minConfidence: number;
  private readonly cacheTtlMs: number;
  private readonly silentUsage: boolean;
  private readonly cache = new Map<string, CachedVisionEntry>();
  private client: GeminiLike | undefined;
  private clientLoadPromise: Promise<GeminiLike> | undefined;

  constructor(opts: GeminiApiBackendOptions = {}) {
    this.model = opts.model ?? process.env["SYNTHI_GEMINI_MODEL"] ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.silentUsage = opts.silentUsage ?? false;
    if (opts.client) this.client = opts.client;
  }

  cacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async resolve(args: {
    description: string;
    frame: Buffer;
    hints?: LocateHints;
    frameDims: { w: number; h: number };
    signal?: AbortSignal;
  }): Promise<BackendResolution> {
    const key = `${contentHash(args.frame)}_${descriptionHash(args.description)}`;
    const now = Date.now();

    if (args.signal?.aborted) {
      throw new Error(
        `gemini_api_aborted: ${((args.signal.reason as Error | undefined)?.message) ?? "pre_call"}`
      );
    }

    const cached = this.cache.get(key);
    if (cached && now - cached.ts < this.cacheTtlMs) {
      return {
        bbox: cached.bbox,
        confidence: cached.confidence,
        trace: `cached(${cached.trace})`,
      };
    }

    const client = await this.getClient();
    const base64 = args.frame.toString("base64");
    const systemPrompt = buildSystemPrompt();
    const userText = buildUserText(args.description, args.frameDims);

    let response: GeminiGenerateResponse;
    try {
      const config: GeminiGenerateConfig = {
        systemInstruction: systemPrompt,
        maxOutputTokens: this.maxTokens,
        responseMimeType: "application/json",
      };
      if (args.signal) config.abortSignal = args.signal;
      response = await client.models.generateContent({
        model: this.model,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/png", data: base64 } },
              { text: userText },
            ],
          },
        ],
        config,
      });
    } catch (err) {
      if (args.signal?.aborted) {
        throw new Error(`gemini_api_aborted: ${(err as Error).message}`);
      }
      throw new Error(`gemini_api_network_error: ${(err as Error).message}`);
    }

    const text = extractGeminiText(response);
    if (!text) {
      throw new Error("gemini_api_empty_response: model returned no text content");
    }
    const parsed = parseGeminiBboxResponse(text);

    if (!this.silentUsage) {
      const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
      const cost = computeGeminiCostUsd(this.model, inputTokens, outputTokens);
      eventLog.push({
        kind: "usage",
        metric: "vision_inference",
        value: 1,
        detail: {
          backend: "gemini_api",
          model: this.model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: cost,
          description_hash: descriptionHash(args.description),
          content_hash: contentHash(args.frame),
          ...(parsed.bbox === null ? { unresolved: true } : {}),
        },
      });
    }

    if (parsed.bbox === null || parsed.confidence < this.minConfidence) {
      throw new Error(
        `gemini_api_low_confidence: ${parsed.trace || "model returned bbox:null or confidence below threshold"}`
      );
    }

    const bbox = clampBboxToFrame(parsed.bbox, args.frameDims);
    this.cache.set(key, { bbox, confidence: parsed.confidence, trace: parsed.trace, model: this.model, ts: now });
    return {
      bbox,
      confidence: parsed.confidence,
      trace: `gemini_api(${this.model};conf=${parsed.confidence.toFixed(2)};${parsed.trace})`,
    };
  }

  private async getClient(): Promise<GeminiLike> {
    if (this.client) return this.client;
    if (!this.clientLoadPromise) {
      this.clientLoadPromise = this.loadSdk();
    }
    this.client = await this.clientLoadPromise;
    return this.client;
  }

  private async loadSdk(): Promise<GeminiLike> {
    const apiKey = process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"];
    if (!apiKey) {
      throw new Error("gemini_api_no_key: GEMINI_API_KEY (or GOOGLE_API_KEY) is not set");
    }
    let GoogleGenAI: new (opts: { apiKey: string }) => GeminiLike;
    try {
      const mod = (await import("@google/genai")) as { GoogleGenAI: typeof GoogleGenAI };
      GoogleGenAI = mod.GoogleGenAI;
    } catch (err) {
      throw new Error(`gemini_api_sdk_unavailable: ${(err as Error).message}`);
    }
    return new GoogleGenAI({ apiKey });
  }

  // Test-only: expose the bbox clamp shape we actually return, so golden
  // tests can pin the contract.
  _debugBboxAt(bbox: BBox, dims: { w: number; h: number }): BBox {
    return clampBboxToFrame(bbox, dims);
  }
}
