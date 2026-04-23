import type { BBox } from "../util/phash.js";

export type LocateBackendName = "mock" | "agent_side" | "claude_api" | "gemini_api" | "local";

export interface LocateHints {
  /** Bias the search to this region. If mock backend, this is the answer. */
  prefer_region?: BBox;
  /** Reject any match overlapping this region. */
  exclude_bbox?: BBox;
  /** Match only elements whose visible text contains this substring. */
  containing_text?: string;
  /** If multiple candidates match, pick the nth (0-indexed). */
  nth?: number;
}

export interface LocateArgs {
  description: string;
  hints?: LocateHints;
  preferred_vision_backend?: LocateBackendName;
  /** Optional stable identifier. If set, the server keys the cache on this
   * handle_id and the next call can request re-use via `reuse_handle`. */
  handle_id?: string;
  /** If true and handle_id is set, try the cache before calling the backend. */
  reuse_handle?: boolean;
}

export type LocateResolvedVia = "cached" | "region_match" | "re_resolved";

export interface LocateResult {
  handle_id: string;
  description: string;
  bbox: BBox;
  region_phash: string;
  expires_ts: number;
  resolved_via: LocateResolvedVia;
  /** Short machine-readable reason for how the result was produced. */
  reason: string;
  backend: LocateBackendName;
}

/** Wire-format event emitted to the event log on every handle dispatch. */
export interface LocatorResolutionEvent {
  type: "locator_resolution";
  handle_id: string;
  description: string;
  resolved_via: LocateResolvedVia;
  reason: string;
  bbox: BBox;
  region_phash: string;
  hamming_distance?: number;
  ts: number;
}

export interface CacheEntry {
  handle_id: string;
  description: string;
  bbox: BBox;
  region_phash: string;
  expires_ts: number;
  created_ts: number;
  backend: LocateBackendName;
}

export interface CacheResolveResult {
  kind: "hit" | "miss" | "expired" | "drift";
  entry?: CacheEntry;
  hamming_distance?: number;
  current_region_phash?: string;
}
