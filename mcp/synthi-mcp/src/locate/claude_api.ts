/**
 * Real `claude_api` vision backend — Anthropic multimodal call for
 * natural-language → bbox grounding. Backs `synthi_locate` when
 * `preferred_vision_backend:"claude_api"` is set.
 *
 * Design choices:
 *
 * - Client injection. The class accepts an `AnthropicLike` in its ctor for
 *   tests; when omitted, it lazy-loads the real SDK on first `resolve()`.
 *   This keeps unit tests hermetic (no network, no env var required) without
 *   needing `vi.mock` trickery.
 *
 * - Cache keyed by (content_hash, description). The cache lives in-process
 *   and survives across tool calls until the PNG content changes or the
 *   agent rewords the description. This is the (frame_seq, description_hash)
 *   design from ultraplan §4.13 expressed with content-hash as the stand-in
 *   for frame_seq (frame_seq gate is tracked separately in §4.4).
 *
 * - Usage event emitted on every successful non-cache-hit call. Includes
 *   `input_tokens`, `output_tokens`, `cost_usd`, model id, and a short
 *   `trace` field so `synthi_get_usage` can surface the numbers.
 *
 * - Pricing table is per model. Unknown models fall back to the opus rate
 *   so we overestimate rather than silently underbill in logs.
 *
 * - JSON parsing. The prompt demands strict JSON; if the model wraps the
 *   answer in prose or a code-fence, we peel the first top-level
 *   `{...}` block out and parse that. Non-parseable or `bbox:null`
 *   responses raise `locator_unresolved` with a short reason string.
 */

import type { BBox } from "../util/phash.js";
import { eventLog } from "../events/index.js";
import type { LocateHints, LocateBackendName } from "./types.js";
import type { BackendResolution, VisionBackend } from "./backends.js";
import {
  buildSystemPrompt as sharedBuildSystemPrompt,
  buildUserText as sharedBuildUserText,
  clampBboxToFrame as sharedClampBboxToFrame,
  contentHash as sharedContentHash,
  descriptionHash as sharedDescriptionHash,
  parseBboxResponse as sharedParseBboxResponse,
  type CachedVisionEntry as SharedCachedVisionEntry,
  type ParsedVisionResult as SharedParsedVisionResult,
} from "./vision_utils.js";

/** Per-million-token USD prices. Extend as new Claude models ship. */
export const PRICING_USD_PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // Legacy fallbacks — treat as opus-priced so logs never silently underbill.
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4": { input: 1, output: 5 },
};

/** Safe fallback pricing (opus-rate) when the model is not in the table. */
export const FALLBACK_PRICING = { input: 15, output: 75 };

export function computeCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING_USD_PER_MILLION[model] ?? FALLBACK_PRICING;
  const cost = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000; // round to µUSD
}

/**
 * The subset of the Anthropic SDK we depend on. Declared here so tests
 * can pass a plain object without importing the real SDK.
 */
export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export interface AnthropicTextBlock {
  type: "text";
  text: string;
}
export type AnthropicContentBlock = AnthropicImageBlock | AnthropicTextBlock;

export interface AnthropicMessagesCreateParams {
  model: string;
  max_tokens: number;
  messages: Array<{ role: "user" | "assistant"; content: AnthropicContentBlock[] }>;
  system?: string;
}

export interface AnthropicMessagesResponse {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason?: string;
}

/**
 * Second-argument request options on `client.messages.create`. The real
 * Anthropic SDK accepts a `{signal?: AbortSignal}` here; we model only the
 * fields we actually forward so tests can supply a minimal mock.
 */
export interface AnthropicRequestOptions {
  signal?: AbortSignal;
}

export interface AnthropicLike {
  messages: {
    create(
      params: AnthropicMessagesCreateParams,
      options?: AnthropicRequestOptions
    ): Promise<AnthropicMessagesResponse>;
  };
}

// Re-export the shared vision utilities so existing imports continue to
// work (locate/index.ts publicly re-exports these). New backends should
// import from `./vision_utils.js` directly.
export const contentHash = sharedContentHash;
export const descriptionHash = sharedDescriptionHash;
export const buildSystemPrompt = sharedBuildSystemPrompt;
export const buildUserText = sharedBuildUserText;
export const clampBboxToFrame = sharedClampBboxToFrame;
export type ParsedVisionResult = SharedParsedVisionResult;
export type CachedVisionEntry = SharedCachedVisionEntry;

/**
 * Claude-specific wrapper around the shared parser. Preserves the legacy
 * `claude_api_parse_error:` prefix so existing error-code branches keep
 * matching.
 */
export function parseBboxResponse(text: string): ParsedVisionResult {
  return sharedParseBboxResponse(text, "claude_api_parse_error");
}

/** Options accepted by the real `claude_api` backend. */
export interface ClaudeApiBackendOptions {
  client?: AnthropicLike;
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

export class ClaudeApiBackendReal implements VisionBackend {
  readonly name: LocateBackendName = "claude_api";

  private readonly model: string;
  private readonly maxTokens: number;
  private readonly minConfidence: number;
  private readonly cacheTtlMs: number;
  private readonly silentUsage: boolean;
  private readonly cache = new Map<string, CachedVisionEntry>();
  private client: AnthropicLike | undefined;
  private clientLoadPromise: Promise<AnthropicLike> | undefined;

  constructor(opts: ClaudeApiBackendOptions = {}) {
    this.model = opts.model ?? process.env["SYNTHI_VISION_MODEL"] ?? "claude-opus-4-7";
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

    // Respect cancellation before we even hit the cache or the network.
    if (args.signal?.aborted) {
      throw new Error(
        `claude_api_aborted: ${((args.signal.reason as Error | undefined)?.message) ?? "pre_call"}`
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

    let response: AnthropicMessagesResponse;
    try {
      response = await client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
                { type: "text", text: userText },
              ],
            },
          ],
        },
        args.signal ? { signal: args.signal } : {}
      );
    } catch (err) {
      // If we got here because of an abort, surface a distinct error code so
      // callers can branch (no billing, no cache update, no usage event).
      if (args.signal?.aborted) {
        throw new Error(`claude_api_aborted: ${(err as Error).message}`);
      }
      throw new Error(`claude_api_network_error: ${(err as Error).message}`);
    }

    const textBlock = response.content.find((c) => c.type === "text" && typeof c.text === "string");
    if (!textBlock || !textBlock.text) {
      throw new Error("claude_api_empty_response: model returned no text block");
    }
    const parsed = parseBboxResponse(textBlock.text);

    // Record usage regardless of whether the bbox was resolvable — the
    // call happened, so the cost happened.
    if (!this.silentUsage) {
      const cost = computeCostUsd(this.model, response.usage.input_tokens, response.usage.output_tokens);
      eventLog.push({
        kind: "usage",
        metric: "vision_inference",
        value: 1,
        detail: {
          model: this.model,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cost_usd: cost,
          description_hash: descriptionHash(args.description),
          content_hash: contentHash(args.frame),
          ...(parsed.bbox === null ? { unresolved: true } : {}),
        },
      });
    }

    if (parsed.bbox === null || parsed.confidence < this.minConfidence) {
      throw new Error(
        `claude_api_low_confidence: ${parsed.trace || "model returned bbox:null or confidence below threshold"}`
      );
    }

    const bbox = clampBboxToFrame(parsed.bbox, args.frameDims);
    this.cache.set(key, { bbox, confidence: parsed.confidence, trace: parsed.trace, model: this.model, ts: now });
    return {
      bbox,
      confidence: parsed.confidence,
      trace: `claude_api(${this.model};conf=${parsed.confidence.toFixed(2)};${parsed.trace})`,
    };
  }

  private async getClient(): Promise<AnthropicLike> {
    if (this.client) return this.client;
    if (!this.clientLoadPromise) {
      this.clientLoadPromise = this.loadSdk();
    }
    this.client = await this.clientLoadPromise;
    return this.client;
  }

  private async loadSdk(): Promise<AnthropicLike> {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error("claude_api_no_key: ANTHROPIC_API_KEY is not set");
    }
    let Anthropic: new (opts: { apiKey: string }) => AnthropicLike;
    try {
      const mod = (await import("@anthropic-ai/sdk")) as { default: typeof Anthropic };
      Anthropic = mod.default;
    } catch (err) {
      throw new Error(`claude_api_sdk_unavailable: ${(err as Error).message}`);
    }
    return new Anthropic({ apiKey });
  }
}
