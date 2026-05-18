import { randomBytes } from "node:crypto";
import { eventLog } from "../events/index.js";
import { brokerError, type BrokerErrorPayload } from "./errors.js";

export interface ProducerGrant {
  producer_id: string;
  producer_epoch: number;
  fencing_token: string;
  attached_at: number;
  teardown_confirmed: boolean;
}

export type ProducerAttachResult =
  | { ok: true; grant: ProducerGrant }
  | { ok: false; error: BrokerErrorPayload; current: ProducerGrant };

export class ProducerFenceRegistry {
  private readonly producers = new Map<string, ProducerGrant>();
  private readonly epochs = new Map<string, number>();

  attach(sessionId: string, producerId: string, now: number = Date.now()): ProducerAttachResult {
    const current = this.producers.get(sessionId);
    if (current && !current.teardown_confirmed) {
      eventLog.push({
        kind: "security",
        code: "rate_limit_warning",
        detail: {
          code: "duplicate_producer_rejected",
          session_id: sessionId,
          current_producer_id: current.producer_id,
          attempted_producer_id: producerId,
          producer_epoch: current.producer_epoch,
        },
        ts: now,
      });
      return {
        ok: false,
        error: brokerError("DUPLICATE_PRODUCER_REJECTED", {
          session_id: sessionId,
          current_producer_id: current.producer_id,
          attempted_producer_id: producerId,
        }),
        current,
      };
    }
    const epoch = (this.epochs.get(sessionId) ?? 0) + 1;
    this.epochs.set(sessionId, epoch);
    const grant: ProducerGrant = {
      producer_id: producerId,
      producer_epoch: epoch,
      fencing_token: randomBytes(16).toString("base64url"),
      attached_at: now,
      teardown_confirmed: false,
    };
    this.producers.set(sessionId, grant);
    eventLog.push({
      kind: "console",
      level: "info",
      source: "mcp_internal",
      message: `[broker_producer] attached session=${sessionId} producer=${producerId} epoch=${epoch}`,
      ts: now,
    });
    return { ok: true, grant };
  }

  validateWrite(sessionId: string, grant: Pick<ProducerGrant, "producer_id" | "producer_epoch" | "fencing_token">): { ok: true } | { ok: false; error: BrokerErrorPayload } {
    const current = this.producers.get(sessionId);
    if (
      !current ||
      current.producer_id !== grant.producer_id ||
      current.producer_epoch !== grant.producer_epoch ||
      current.fencing_token !== grant.fencing_token
    ) {
      return {
        ok: false,
        error: brokerError("DUPLICATE_PRODUCER_REJECTED", {
          session_id: sessionId,
          attempted_producer_id: grant.producer_id,
          attempted_epoch: grant.producer_epoch,
        }),
      };
    }
    return { ok: true };
  }

  confirmTeardown(sessionId: string, producerId?: string): ProducerGrant | null {
    const current = this.producers.get(sessionId);
    if (!current) return null;
    if (producerId && current.producer_id !== producerId) return null;
    const updated = { ...current, teardown_confirmed: true };
    this.producers.set(sessionId, updated);
    eventLog.push({
      kind: "console",
      level: "info",
      source: "mcp_internal",
      message: `[broker_producer] teardown_confirmed session=${sessionId} producer=${updated.producer_id} epoch=${updated.producer_epoch}`,
    });
    return updated;
  }

  current(sessionId: string): ProducerGrant | null {
    const current = this.producers.get(sessionId);
    return current ? { ...current } : null;
  }

  clear(): void {
    this.producers.clear();
    this.epochs.clear();
  }
}

export const producerFenceRegistry = new ProducerFenceRegistry();
