import type { EventKind, EventLogEntry } from "./types.js";

/**
 * Distributive Omit over a discriminated union. Without this helper, TS
 * collapses the union when we Omit the shared fields, which loses the
 * discriminators and makes per-kind field names invalid.
 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type EventLogInput = DistributiveOmit<EventLogEntry, "seq" | "ts"> & { ts?: number };

export const DEFAULT_RING_CAPACITY = 1024;

export interface EventQueryOpts {
  /** Return only entries of these kinds. */
  kind?: EventKind | EventKind[];
  /** Return entries strictly after this seq. */
  since_seq?: number;
  /** Return entries with ts >= this value. */
  since_ts?: number;
  /** Cap the returned count. */
  limit?: number;
}

/**
 * Bounded ring buffer for session-scoped events.
 *
 * Producers call `push(partial)` where `partial` has everything except
 * `seq`; the log assigns a monotonic `seq` at push time. Consumers either
 * poll via `query()` or subscribe to a real-time stream via `onAppend`.
 *
 * The buffer silently drops oldest entries on overflow. Keep capacity
 * comfortable (default 1024) because the ring is the backing store for
 * both `synthi_get_event_log` and the `synthi://preview/events` MCP
 * resource, and a consumer joining late should be able to catch up on a
 * reasonable window of history.
 */
export class EventLog {
  private readonly entries: EventLogEntry[] = [];
  private readonly capacity: number;
  private seqCounter = 0;
  private readonly listeners = new Set<(e: EventLogEntry) => void>();

  constructor(capacity: number = DEFAULT_RING_CAPACITY) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error(`invalid_capacity (${capacity})`);
    }
    this.capacity = capacity;
  }

  size(): number {
    return this.entries.length;
  }

  firstSeq(): number | null {
    return this.entries[0]?.seq ?? null;
  }

  lastSeq(): number {
    return this.seqCounter;
  }

  push(partial: EventLogInput): EventLogEntry {
    this.seqCounter += 1;
    const ts = partial.ts ?? Date.now();
    const entry = { ...partial, seq: this.seqCounter, ts } as unknown as EventLogEntry;
    this.entries.push(entry);
    while (this.entries.length > this.capacity) {
      this.entries.shift();
    }
    for (const cb of this.listeners) {
      try {
        cb(entry);
      } catch {
        // listeners must not break the producer
      }
    }
    return entry;
  }

  /**
   * Snapshot query. Matches are evaluated in order (oldest first) so the
   * returned array is chronologically ordered.
   */
  query(opts: EventQueryOpts = {}): EventLogEntry[] {
    const kinds = opts.kind === undefined
      ? null
      : Array.isArray(opts.kind) ? new Set(opts.kind) : new Set([opts.kind]);
    const results: EventLogEntry[] = [];
    for (const e of this.entries) {
      if (opts.since_seq !== undefined && e.seq <= opts.since_seq) continue;
      if (opts.since_ts !== undefined && e.ts < opts.since_ts) continue;
      if (kinds && !kinds.has(e.kind)) continue;
      results.push(e);
      if (opts.limit !== undefined && results.length >= opts.limit) break;
    }
    return results;
  }

  /**
   * Live subscription. Fires for entries appended AFTER the subscribe call;
   * to fetch prior state, `query()` first.
   */
  onAppend(cb: (e: EventLogEntry) => void): () => void {
    this.listeners.add(cb);
    return (): void => {
      this.listeners.delete(cb);
    };
  }

  clear(): void {
    this.entries.length = 0;
  }

  /** Reset seq + entries. Test-only; production log must keep seq monotonic. */
  _resetForTests(): void {
    this.entries.length = 0;
    this.seqCounter = 0;
    this.listeners.clear();
  }
}

/** Per-process singleton. One MCP = one session = one event log. */
export const eventLog = new EventLog();
