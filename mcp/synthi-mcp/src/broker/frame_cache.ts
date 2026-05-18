import { createHash } from "node:crypto";
import { hammingDistance, pHash, regionPHash, type BBox } from "../util/phash.js";
import {
  brokerVisualWorkerPool,
  type BrokerWorkerPool,
} from "./worker_pool.js";
import { brokerSloRecorder } from "./slo.js";

export interface BrokerFrameCacheViewport {
  w: number;
  h: number;
  dpr: number;
}

export interface BrokerFrameCacheEntry {
  session_id: string;
  frame_seq: number;
  frame_ts_ms: number;
  ingest_ts_ms: number;
  viewport: BrokerFrameCacheViewport;
  data: Buffer;
  byte_length: number;
  content_hash: string;
  phash?: string;
  created_at: number;
  expires_at: number;
}

export interface BrokerFrameCachePut {
  session_id: string;
  frame_seq: number;
  frame_ts_ms: number;
  ingest_ts_ms?: number;
  viewport: BrokerFrameCacheViewport;
  data: Buffer;
  now?: number;
}

export interface BrokerVisualDedupeResult {
  duplicate: boolean;
  method: "content_hash" | "phash" | "roi_phash";
  hamming_distance: number;
  threshold: number;
}

export interface BrokerInferenceEnvelope {
  session_id: string;
  frame_seq: number;
  frame_timestamp_ms: number;
  viewport_size: { w: number; h: number };
  device_pixel_ratio: number;
  model_version: string;
  confidence: number;
  coordinate_space: "frame_pixels";
  expiry_ms: number;
  valid_for_input: boolean;
  bbox: BBox;
  prompt_hash: string;
  provider?: string;
}

export interface BrokerInferenceCacheStats {
  size: number;
  hits: number;
  misses: number;
  puts: number;
}

export const DEFAULT_SHARED_FRAME_CACHE_TTL_MS = 30_000;
export const DEFAULT_SHARED_FRAME_CACHE_MAX_ENTRIES = 128;
export const DEFAULT_INFERENCE_CACHE_TTL_MS = 30_000;

export class SharedFrameCache {
  private readonly entries = new Map<string, BrokerFrameCacheEntry>();
  private readonly latestBySession = new Map<string, string>();
  private readonly inFlightFrameHashes = new Map<string, Promise<string>>();

  constructor(
    private readonly ttlMs: number = DEFAULT_SHARED_FRAME_CACHE_TTL_MS,
    private readonly maxEntries: number = DEFAULT_SHARED_FRAME_CACHE_MAX_ENTRIES,
    private readonly workerPool: BrokerWorkerPool = brokerVisualWorkerPool
  ) {}

  putFrame(input: BrokerFrameCachePut): BrokerFrameCacheEntry {
    const now = input.now ?? Date.now();
    const key = frameKey(input.session_id, input.frame_seq);
    const entry: BrokerFrameCacheEntry = {
      session_id: input.session_id,
      frame_seq: input.frame_seq,
      frame_ts_ms: input.frame_ts_ms,
      ingest_ts_ms: input.ingest_ts_ms ?? now,
      viewport: { ...input.viewport },
      data: Buffer.from(input.data),
      byte_length: input.data.length,
      content_hash: sha256(input.data),
      created_at: now,
      expires_at: now + this.ttlMs,
    };
    this.entries.set(key, entry);
    this.latestBySession.set(input.session_id, key);
    this.prune(now);
    return { ...entry, data: Buffer.from(entry.data) };
  }

  getFrame(sessionId: string, frameSeq: number, now: number = Date.now()): BrokerFrameCacheEntry | null {
    this.prune(now);
    const entry = this.entries.get(frameKey(sessionId, frameSeq));
    return entry ? { ...entry, viewport: { ...entry.viewport }, data: Buffer.from(entry.data) } : null;
  }

  latest(sessionId: string, now: number = Date.now()): BrokerFrameCacheEntry | null {
    this.prune(now);
    const key = this.latestBySession.get(sessionId);
    if (!key) return null;
    const entry = this.entries.get(key);
    return entry ? { ...entry, viewport: { ...entry.viewport }, data: Buffer.from(entry.data) } : null;
  }

  async computeFramePHash(sessionId: string, frameSeq: number): Promise<string> {
    const key = frameKey(sessionId, frameSeq);
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`BROKER_FRAME_NOT_FOUND (${key})`);
    if (entry.phash) return entry.phash;
    const inFlight = this.inFlightFrameHashes.get(key);
    if (inFlight) return inFlight;
    const promise = this.workerPool.run(`frame_phash:${key}`, async () => {
      const hash = await pHash(entry.data);
      entry.phash = hash;
      return hash;
    }).finally(() => {
      this.inFlightFrameHashes.delete(key);
    });
    this.inFlightFrameHashes.set(key, promise);
    return promise;
  }

  async isVisuallyDuplicate(input: {
    session_id: string;
    previous_frame_seq: number;
    next_frame_seq: number;
    threshold?: number;
  }): Promise<BrokerVisualDedupeResult> {
    const threshold = input.threshold ?? 4;
    const previous = this.requireFrame(input.session_id, input.previous_frame_seq);
    const next = this.requireFrame(input.session_id, input.next_frame_seq);
    if (previous.content_hash === next.content_hash) {
      return { duplicate: true, method: "content_hash", hamming_distance: 0, threshold };
    }
    const [a, b] = await Promise.all([
      this.computeFramePHash(input.session_id, input.previous_frame_seq),
      this.computeFramePHash(input.session_id, input.next_frame_seq),
    ]);
    const dist = hammingDistance(a, b);
    return {
      duplicate: dist <= threshold,
      method: "phash",
      hamming_distance: dist,
      threshold,
    };
  }

  async roiChanged(input: {
    session_id: string;
    previous_frame_seq: number;
    next_frame_seq: number;
    bbox: BBox;
    threshold?: number;
  }): Promise<BrokerVisualDedupeResult> {
    const threshold = input.threshold ?? 12;
    const previous = this.requireFrame(input.session_id, input.previous_frame_seq);
    const next = this.requireFrame(input.session_id, input.next_frame_seq);
    const [a, b] = await Promise.all([
      this.workerPool.run(`roi_phash:${input.session_id}:${input.previous_frame_seq}`, () => regionPHash(previous.data, input.bbox)),
      this.workerPool.run(`roi_phash:${input.session_id}:${input.next_frame_seq}`, () => regionPHash(next.data, input.bbox)),
    ]);
    const dist = hammingDistance(a, b);
    return {
      duplicate: dist <= threshold,
      method: "roi_phash",
      hamming_distance: dist,
      threshold,
    };
  }

  size(now: number = Date.now()): number {
    this.prune(now);
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.latestBySession.clear();
    this.inFlightFrameHashes.clear();
  }

  private requireFrame(sessionId: string, frameSeq: number): BrokerFrameCacheEntry {
    const entry = this.entries.get(frameKey(sessionId, frameSeq));
    if (!entry) throw new Error(`BROKER_FRAME_NOT_FOUND (${frameKey(sessionId, frameSeq)})`);
    return entry;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expires_at <= now) {
        this.entries.delete(key);
        if (this.latestBySession.get(entry.session_id) === key) this.latestBySession.delete(entry.session_id);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest && this.latestBySession.get(oldest.session_id) === oldestKey) this.latestBySession.delete(oldest.session_id);
    }
  }
}

export class SharedInferenceCache {
  private readonly entries = new Map<string, BrokerInferenceEnvelope>();
  private hits = 0;
  private misses = 0;
  private puts = 0;

  put(envelope: BrokerInferenceEnvelope): BrokerInferenceEnvelope {
    const key = inferenceKey(envelope);
    this.entries.set(key, { ...envelope, bbox: { ...envelope.bbox } });
    this.puts += 1;
    return { ...envelope, bbox: { ...envelope.bbox } };
  }

  get(input: {
    session_id: string;
    frame_seq: number;
    model_version: string;
    prompt_hash: string;
    now?: number;
    current_frame_seq?: number;
  }): BrokerInferenceEnvelope | null {
    const now = input.now ?? Date.now();
    const key = inferenceKey(input);
    const entry = this.entries.get(key);
    if (!entry || entry.expiry_ms <= now) {
      this.misses += 1;
      if (entry) this.entries.delete(key);
      return null;
    }
    const validForInput = input.current_frame_seq === undefined || input.current_frame_seq === entry.frame_seq;
    this.hits += 1;
    brokerSloRecorder.recordDuration("locate_cache_hit_latency_p95", 0, now, {
      cache: "shared_inference",
      model_version: input.model_version,
    });
    return {
      ...entry,
      bbox: { ...entry.bbox },
      valid_for_input: entry.valid_for_input && validForInput,
    };
  }

  stats(): BrokerInferenceCacheStats {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      puts: this.puts,
    };
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.puts = 0;
  }
}

export function promptHash(prompt: string): string {
  return sha256(Buffer.from(prompt, "utf8"));
}

function frameKey(sessionId: string, frameSeq: number): string {
  return `${sessionId}:${frameSeq}`;
}

function inferenceKey(input: {
  session_id: string;
  frame_seq: number;
  model_version: string;
  prompt_hash: string;
}): string {
  return `${input.session_id}:${input.frame_seq}:${input.model_version}:${input.prompt_hash}`;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export const sharedFrameCache = new SharedFrameCache();
export const sharedInferenceCache = new SharedInferenceCache();
