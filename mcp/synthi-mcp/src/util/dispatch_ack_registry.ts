/**
 * Registry that correlates outgoing input `dispatch_id` values with the
 * worker's `{type:"input-ack", dispatch_id, accepted, reason?}` echo on
 * the build-log DC.
 *
 * Usage:
 *   const { id, promise } = registry.register(4000);
 *   await channels.sendInput(envelope_with_dispatch_id(id));
 *   const ack = await promise;     // { accepted, reason?, elapsedMs }
 *
 * Timeouts reject with `input_ack_timeout` so callers branch on
 * err.message.startsWith("input_ack_timeout"). The registry cleans up
 * pending entries on resolve/reject/timeout so leaks are structurally
 * impossible.
 *
 * Independent of RequestRegistry: that tracks AbortControllers for
 * billable vision calls; this tracks input-acks. Different lifecycles,
 * different timeouts, different consumers.
 */

import { randomUUID } from "node:crypto";

export interface DispatchAckResult {
  accepted: boolean;
  reason?: string;
  elapsedMs: number;
}

export interface PendingDispatch {
  id: string;
  promise: Promise<DispatchAckResult>;
  /** Manually resolve (test-only; production uses the worker echo). */
  _resolve: (res: DispatchAckResult) => void;
  /** Clean up without resolving (caller lost interest). */
  cancel: () => void;
}

interface Entry {
  resolve: (res: DispatchAckResult) => void;
  reject: (err: Error) => void;
  startedAt: number;
  timer?: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 4_000;

export class DispatchAckRegistry {
  private readonly pending = new Map<string, Entry>();

  /**
   * Allocate a fresh dispatch_id + promise. The promise resolves when
   * the worker's input-ack arrives, OR rejects with `input_ack_timeout`
   * after `timeoutMs`.
   */
  register(timeoutMs: number = DEFAULT_TIMEOUT_MS, id?: string): PendingDispatch {
    const dispatchId = id ?? `dsp_${randomUUID()}`;
    let resolveRef!: (res: DispatchAckResult) => void;
    let rejectRef!: (err: Error) => void;
    const promise = new Promise<DispatchAckResult>((resolve, reject) => {
      resolveRef = resolve;
      rejectRef = reject;
    });
    const startedAt = Date.now();
    const entry: Entry = {
      resolve: resolveRef,
      reject: rejectRef,
      startedAt,
    };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (this.pending.delete(dispatchId)) {
          rejectRef(new Error(`input_ack_timeout: ${dispatchId} after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      // Don't keep the process alive waiting for ack timers.
      entry.timer.unref?.();
    }
    this.pending.set(dispatchId, entry);

    const manualResolve = (res: DispatchAckResult): void => {
      if (this.pending.delete(dispatchId)) {
        if (entry.timer) clearTimeout(entry.timer);
        resolveRef(res);
      }
    };
    const cancel = (): void => {
      if (this.pending.delete(dispatchId)) {
        if (entry.timer) clearTimeout(entry.timer);
        rejectRef(new Error(`input_ack_cancelled: ${dispatchId}`));
      }
    };
    return { id: dispatchId, promise, _resolve: manualResolve, cancel };
  }

  /**
   * Called by the session's build-log tap when a `{type:"input-ack"}`
   * message arrives. Returns true if the id was pending, false otherwise
   * (worker echoed an ack for an id we never registered — surprising
   * but not fatal; log + ignore).
   */
  resolveAck(payload: { dispatch_id: string; accepted: boolean; reason?: string }): boolean {
    const entry = this.pending.get(payload.dispatch_id);
    if (!entry) return false;
    this.pending.delete(payload.dispatch_id);
    if (entry.timer) clearTimeout(entry.timer);
    const res: DispatchAckResult = {
      accepted: payload.accepted,
      elapsedMs: Date.now() - entry.startedAt,
    };
    if (payload.reason !== undefined) res.reason = payload.reason;
    entry.resolve(res);
    return true;
  }

  size(): number {
    return this.pending.size;
  }

  /** Test-only: clear without resolving any pending promises. */
  _resetForTests(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}

/** Per-process singleton. */
export const dispatchAckRegistry = new DispatchAckRegistry();
