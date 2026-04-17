import { hammingDistance, regionPHash } from "../util/phash.js";
import type { CacheEntry, CacheResolveResult } from "./types.js";

export const DEFAULT_TTL_MS = 30_000;
/** Distance threshold above which a handle is considered drifted.
 * Matches `AGENT_MCP_ULTRAPLAN.md:1380` (region-pHash threshold: 12). */
export const DEFAULT_DRIFT_THRESHOLD = 12;

/**
 * In-memory region-pHash keyed cache for `synthi_locate` handles.
 *
 * The cache is a `Map<handle_id, CacheEntry>` because a handle is a caller-
 * supplied stable identity; storage is per MCP process (one session) so
 * there is no cross-session leakage to worry about. Eviction happens on
 * each `tryResolve`: expired entries are dropped in-flight; drifted
 * entries are reported to the caller so they can re-resolve.
 *
 * Determinism: `tryResolve` is idempotent — consecutive calls with the same
 * frame return the same result. This lets the spike harness measure hit
 * rates deterministically across runs.
 */
export class LocateCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly driftThreshold = DEFAULT_DRIFT_THRESHOLD
  ) {}

  put(entry: CacheEntry): void {
    this.entries.set(entry.handle_id, entry);
  }

  get(handleId: string): CacheEntry | undefined {
    return this.entries.get(handleId);
  }

  delete(handleId: string): void {
    this.entries.delete(handleId);
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * Look up a handle by id and, if present, re-hash the current frame's
   * region to decide whether the cached bbox still tracks the element.
   *
   * Resolution outcomes:
   *  - `hit`     — not expired, hamming ≤ threshold. Caller reuses the bbox.
   *  - `expired` — age > ttlMs. Caller must re-resolve (and likely `put` again).
   *  - `drift`   — hamming > threshold. Caller must re-resolve.
   *  - `miss`    — handleId unknown.
   *
   * The entry is **not** auto-evicted on `expired` / `drift` — the caller
   * does that after it knows its own re-resolution succeeded. This keeps
   * the spike harness able to distinguish expired-but-still-present from
   * truly absent handles.
   */
  async tryResolve(handleId: string, pngFrame: Buffer, now = Date.now()): Promise<CacheResolveResult> {
    const entry = this.entries.get(handleId);
    if (!entry) return { kind: "miss" };

    if (now >= entry.expires_ts) {
      return { kind: "expired", entry };
    }

    const currentPHash = await regionPHash(pngFrame, entry.bbox);
    const dist = hammingDistance(entry.region_phash, currentPHash);
    if (dist <= this.driftThreshold) {
      return {
        kind: "hit",
        entry,
        hamming_distance: dist,
        current_region_phash: currentPHash,
      };
    }
    return {
      kind: "drift",
      entry,
      hamming_distance: dist,
      current_region_phash: currentPHash,
    };
  }

  get configuredTtlMs(): number {
    return this.ttlMs;
  }

  get configuredDriftThreshold(): number {
    return this.driftThreshold;
  }
}
