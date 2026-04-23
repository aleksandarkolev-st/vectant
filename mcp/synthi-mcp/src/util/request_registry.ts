/**
 * Per-process registry for in-flight tool-call AbortControllers.
 *
 * Used so that a tool-handler invocation can:
 *   1. Receive an AbortSignal from the MCP SDK (RequestHandlerExtra.signal),
 *      or from an upstream orchestrator (e.g. graceful shutdown).
 *   2. Register a derived controller here so operational callers can inspect
 *      or cancel by request id.
 *   3. Pass `handle.signal` into slow downstream work (Anthropic API calls,
 *      future worker round-trips). When the upstream aborts, or `cancel()`
 *      is called against the id, the derived signal fires and downstream
 *      work unwinds without finishing.
 *
 * Rationale for ultraplan §Files cancel.ts and §Testing cancellation.test.ts:
 * "cancel mid-`synthi_locate`; assert outbound Claude API call is aborted
 * (no billing on cancelled request)." The registry is the missing piece
 * between the SDK-supplied signal and `client.messages.create({signal})`.
 *
 * This module is intentionally UI-free: it's a Map wrapper. Cost estimates,
 * usage logging, and event-log emission live at the tool boundary where
 * the business context is available.
 */

import { randomUUID } from "node:crypto";

export interface RequestHandle {
  id: string;
  signal: AbortSignal;
  kind: string;
  startedAt: number;
  /** Release the slot back to the registry. Call in a `finally`. */
  unregister(): void;
}

export interface InflightSnapshot {
  id: string;
  kind: string;
  startedAt: number;
  aborted: boolean;
}

export class RequestRegistry {
  private readonly inflight = new Map<
    string,
    { controller: AbortController; kind: string; startedAt: number }
  >();

  /**
   * Register a new in-flight request. Returns a handle whose `signal`
   * fires when either the registry cancels the id directly or `upstream`
   * aborts. The `unregister()` fn on the handle removes the entry; it is
   * safe to call twice.
   */
  register(kind: string, upstream?: AbortSignal, id?: string): RequestHandle {
    const requestId = id ?? `req_${randomUUID()}`;
    const controller = new AbortController();
    if (upstream) {
      if (upstream.aborted) {
        controller.abort(upstream.reason ?? new Error("cancelled_upstream"));
      } else {
        const onAbort = (): void => {
          controller.abort(upstream.reason ?? new Error("cancelled_upstream"));
        };
        upstream.addEventListener("abort", onAbort, { once: true });
      }
    }
    const entry = { controller, kind, startedAt: Date.now() };
    this.inflight.set(requestId, entry);
    const unregister = (): void => {
      this.inflight.delete(requestId);
    };
    return {
      id: requestId,
      signal: controller.signal,
      kind,
      startedAt: entry.startedAt,
      unregister,
    };
  }

  /** Cancel a single in-flight request by id. Returns true if the id was present. */
  cancel(id: string, reason?: unknown): boolean {
    const entry = this.inflight.get(id);
    if (!entry) return false;
    entry.controller.abort(reason ?? new Error("cancelled"));
    this.inflight.delete(id);
    return true;
  }

  /** Cancel every in-flight request. Used by graceful shutdown. Returns the count aborted. */
  cancelAll(reason?: unknown): number {
    const count = this.inflight.size;
    const reasonVal = reason ?? new Error("shutdown");
    for (const { controller } of this.inflight.values()) {
      controller.abort(reasonVal);
    }
    this.inflight.clear();
    return count;
  }

  /** Read-only snapshot for `synthi_health` / debug introspection. */
  active(): InflightSnapshot[] {
    return Array.from(this.inflight.entries()).map(([id, v]) => ({
      id,
      kind: v.kind,
      startedAt: v.startedAt,
      aborted: v.controller.signal.aborted,
    }));
  }

  size(): number {
    return this.inflight.size;
  }

  /** Test-only: clear the registry. Does NOT abort — use cancelAll for that. */
  _resetForTests(): void {
    this.inflight.clear();
  }
}

/** Per-process singleton. */
export const requestRegistry = new RequestRegistry();
