import { createHash } from "node:crypto";

export interface IdempotencyRecord<T> {
  scope: string;
  idempotency_key: string;
  payload_hash: string;
  response: T;
  expires_at: number;
}

export type IdempotencyResult<T> =
  | { status: "stored"; record: IdempotencyRecord<T> }
  | { status: "replay"; record: IdempotencyRecord<T> }
  | { status: "conflict"; record: IdempotencyRecord<T> };

export type IdempotencyLookup<T> =
  | { status: "miss" }
  | { status: "replay"; record: IdempotencyRecord<T> }
  | { status: "conflict"; record: IdempotencyRecord<T> };

export const DEFAULT_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

export class IdempotencyStore<T = unknown> {
  private readonly records = new Map<string, IdempotencyRecord<T>>();

  constructor(private readonly ttlMs: number = DEFAULT_IDEMPOTENCY_TTL_MS) {}

  remember(input: {
    scope: string;
    idempotency_key: string;
    payload: unknown;
    response: T;
    now?: number;
  }): IdempotencyResult<T> {
    const now = input.now ?? Date.now();
    this.evictExpired(now);
    const key = this.key(input.scope, input.idempotency_key);
    const payloadHash = stablePayloadHash(input.payload);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        return { status: "conflict", record: existing };
      }
      return { status: "replay", record: existing };
    }
    const record: IdempotencyRecord<T> = {
      scope: input.scope,
      idempotency_key: input.idempotency_key,
      payload_hash: payloadHash,
      response: input.response,
      expires_at: now + this.ttlMs,
    };
    this.records.set(key, record);
    return { status: "stored", record };
  }

  lookup(input: {
    scope: string;
    idempotency_key: string;
    payload: unknown;
    now?: number;
  }): IdempotencyLookup<T> {
    const now = input.now ?? Date.now();
    this.evictExpired(now);
    const existing = this.records.get(this.key(input.scope, input.idempotency_key));
    if (!existing) return { status: "miss" };
    const payloadHash = stablePayloadHash(input.payload);
    if (existing.payload_hash !== payloadHash) return { status: "conflict", record: existing };
    return { status: "replay", record: existing };
  }

  size(now: number = Date.now()): number {
    this.evictExpired(now);
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
  }

  private evictExpired(now: number): void {
    for (const [key, record] of this.records) {
      if (record.expires_at <= now) this.records.delete(key);
    }
  }

  private key(scope: string, idempotencyKey: string): string {
    return `${scope}\0${idempotencyKey}`;
  }
}

export function stablePayloadHash(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
