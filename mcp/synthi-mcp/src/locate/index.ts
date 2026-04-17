import { randomUUID } from "node:crypto";
import { regionPHash } from "../util/phash.js";
import { DEFAULT_TTL_MS, LocateCache } from "./cache.js";
import { selectBackend, type VisionBackend } from "./backends.js";
import type {
  CacheEntry,
  LocateArgs,
  LocateResult,
  LocatorResolutionEvent,
} from "./types.js";

export interface LocateDispatchCtx {
  frame: Buffer;
  frameDims: { w: number; h: number };
  now?: number;
}

export class LocateEngine {
  private readonly cache: LocateCache;
  private readonly listeners = new Set<(ev: LocatorResolutionEvent) => void>();

  constructor(opts: { cache?: LocateCache } = {}) {
    this.cache = opts.cache ?? new LocateCache();
  }

  onResolution(cb: (ev: LocatorResolutionEvent) => void): () => void {
    this.listeners.add(cb);
    return (): void => {
      this.listeners.delete(cb);
    };
  }

  cacheStats(): { size: number; ttlMs: number; driftThreshold: number } {
    return {
      size: this.cache.size(),
      ttlMs: this.cache.configuredTtlMs,
      driftThreshold: this.cache.configuredDriftThreshold,
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Resolve a handle. If the args carry a `handle_id` + `reuse_handle`, the
   * cache is consulted first — cached hit → `resolved_via:"cached"`; drift
   * or expiry → backend is re-invoked and we mark the dispatch accordingly.
   *
   * Every dispatch emits one `locator_resolution` event — even cache hits,
   * per ultraplan §4.13. Consumers (Prometheus, event log) read from the
   * event stream; the tool's return payload carries the same info for the
   * agent's own bookkeeping.
   */
  async resolve(args: LocateArgs, ctx: LocateDispatchCtx): Promise<LocateResult> {
    const now = ctx.now ?? Date.now();
    const backend = selectBackend(args.preferred_vision_backend);

    if (args.handle_id && args.reuse_handle) {
      const res = await this.cache.tryResolve(args.handle_id, ctx.frame, now);
      if (res.kind === "hit" && res.entry) {
        const payload: LocateResult = {
          handle_id: res.entry.handle_id,
          description: res.entry.description,
          bbox: res.entry.bbox,
          region_phash: res.current_region_phash ?? res.entry.region_phash,
          expires_ts: res.entry.expires_ts,
          resolved_via: "cached",
          reason: `hamming=${res.hamming_distance ?? 0}_under_threshold`,
          backend: backend.name,
        };
        this.emit({
          type: "locator_resolution",
          handle_id: payload.handle_id,
          description: payload.description,
          resolved_via: payload.resolved_via,
          reason: payload.reason,
          bbox: payload.bbox,
          region_phash: payload.region_phash,
          hamming_distance: res.hamming_distance ?? 0,
          ts: now,
        });
        return payload;
      }
    }

    const reason = await this.resolveFresh(args, ctx, backend, now);
    return reason;
  }

  private async resolveFresh(
    args: LocateArgs,
    ctx: LocateDispatchCtx,
    backend: VisionBackend,
    now: number
  ): Promise<LocateResult> {
    const resolution = await backend.resolve({
      description: args.description,
      frame: ctx.frame,
      ...(args.hints !== undefined ? { hints: args.hints } : {}),
      frameDims: ctx.frameDims,
    });
    const regionHash = await regionPHash(ctx.frame, resolution.bbox);
    const handleId = args.handle_id ?? `h_${randomUUID()}`;
    const entry: CacheEntry = {
      handle_id: handleId,
      description: args.description,
      bbox: resolution.bbox,
      region_phash: regionHash,
      expires_ts: now + DEFAULT_TTL_MS,
      created_ts: now,
      backend: backend.name,
    };
    this.cache.put(entry);

    const resolvedVia = args.handle_id && args.reuse_handle ? "re_resolved" : "region_match";
    const reasonLabel = args.handle_id && args.reuse_handle
      ? `re_resolved_via_${backend.name}(${resolution.trace})`
      : `region_match_via_${backend.name}(${resolution.trace})`;
    const result: LocateResult = {
      handle_id: entry.handle_id,
      description: entry.description,
      bbox: entry.bbox,
      region_phash: entry.region_phash,
      expires_ts: entry.expires_ts,
      resolved_via: resolvedVia,
      reason: reasonLabel,
      backend: backend.name,
    };
    this.emit({
      type: "locator_resolution",
      handle_id: result.handle_id,
      description: result.description,
      resolved_via: result.resolved_via,
      reason: result.reason,
      bbox: result.bbox,
      region_phash: result.region_phash,
      ts: now,
    });
    return result;
  }

  private emit(ev: LocatorResolutionEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(ev);
      } catch {
        // listeners must not break dispatch
      }
    }
  }
}

export { LocateCache } from "./cache.js";
export {
  selectBackend,
  MockBackend,
  AgentSideBackend,
  ClaudeApiBackend,
  _resetDefaultClaudeApiBackendForTests,
} from "./backends.js";
export {
  ClaudeApiBackendReal,
  PRICING_USD_PER_MILLION,
  computeCostUsd,
  contentHash,
  descriptionHash,
  parseBboxResponse,
  clampBboxToFrame,
  buildSystemPrompt,
  buildUserText,
} from "./claude_api.js";
export type {
  AnthropicLike,
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicTextBlock,
  AnthropicMessagesCreateParams,
  AnthropicMessagesResponse,
  ClaudeApiBackendOptions,
  CachedVisionEntry,
  ParsedVisionResult,
} from "./claude_api.js";
export type {
  LocateArgs,
  LocateResult,
  LocateHints,
  LocateBackendName,
  LocateResolvedVia,
  LocatorResolutionEvent,
  CacheEntry,
} from "./types.js";

/** Per-process singleton shared by the MCP tool handler and resources layer. */
export const locateEngine = new LocateEngine();
