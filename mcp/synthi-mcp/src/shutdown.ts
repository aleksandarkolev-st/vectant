/**
 * Graceful shutdown orchestration. Extracted from `index.ts` so the
 * teardown order is unit-testable end-to-end, not "trust that SIGINT
 * does the right thing."
 *
 * Invariants (tested):
 *   1. In-flight request signals abort first so slow downstream work
 *      (Anthropic / Gemini API calls, wait primitives) unwinds before
 *      we start tearing down the session.
 *   2. Session teardown (DC -> PC -> WS) runs before the MCP SDK
 *      transport closes so response frames in flight still land.
 *   3. Metrics HTTP server closes last — a scraper that arrives during
 *      shutdown still gets served.
 *   4. Every step is try-catch-isolated. A thrown session close must
 *      not prevent the metrics listener from unsubscribing.
 *
 * Not tested here: `process.exit()`. That's a thin wrapper in `index.ts`
 * that calls `performShutdown` then exits; exit-code behavior is
 * out-of-scope for unit tests.
 */

import type { Server as HttpServer } from "node:http";

export interface ShutdownTarget {
  /** The MCP SDK server. Awaited. */
  server?: { close: () => Promise<void> | void };
  /** The Synthi session wrapper. Awaited. */
  session?: { close: () => Promise<void> | void };
  /** The per-process request registry. Its cancelAll() aborts in-flight AbortControllers. */
  requestRegistry?: { cancelAll: (reason?: unknown) => number };
  /** Optional Prometheus HTTP server. */
  metricsServer?: Pick<HttpServer, "close">;
  /** Optional event-log unsubscribe fn (from bindEventLogToMetrics). */
  unbindMetrics?: () => void;
  /**
   * Optional operator HTTP bridge. Closing it tears down any active SSE
   * streams so the process can exit without stranded sockets.
   */
  operatorBridge?: { close: () => Promise<void> | void };
  /**
   * Optional browser workflow HTTP bridge. Closing it releases the panel-facing
   * local listener used for workflow teaching actions.
   */
  browserWorkflowBridge?: { close: () => Promise<void> | void };
  /** Optional logger for teardown errors. Defaults to silent. */
  logError?: (step: ShutdownStep, err: unknown) => void;
}

export type ShutdownStep =
  | "cancel_in_flight"
  | "close_session"
  | "close_server"
  | "unbind_metrics"
  | "close_metrics_server"
  | "close_operator_bridge"
  | "close_browser_workflow_bridge";

/**
 * Drive the teardown sequence. Every step is isolated — a throw in one
 * step logs via `logError` and continues. Returns an ordered list of the
 * steps that ran (useful for assertions in tests).
 */
export async function performShutdown(target: ShutdownTarget): Promise<ShutdownStep[]> {
  const ran: ShutdownStep[] = [];
  const safe = async (step: ShutdownStep, fn: () => Promise<void> | void): Promise<void> => {
    try {
      await fn();
      ran.push(step);
    } catch (err) {
      target.logError?.(step, err);
      ran.push(step);
    }
  };

  if (target.requestRegistry) {
    await safe("cancel_in_flight", () => {
      target.requestRegistry!.cancelAll("shutdown");
    });
  }
  if (target.session) {
    await safe("close_session", async () => {
      await target.session!.close();
    });
  }
  if (target.server) {
    await safe("close_server", async () => {
      await target.server!.close();
    });
  }
  if (target.unbindMetrics) {
    await safe("unbind_metrics", () => {
      target.unbindMetrics!();
    });
  }
  if (target.metricsServer) {
    await safe("close_metrics_server", () => {
      target.metricsServer!.close();
    });
  }
  if (target.operatorBridge) {
    await safe("close_operator_bridge", async () => {
      await target.operatorBridge!.close();
    });
  }
  if (target.browserWorkflowBridge) {
    await safe("close_browser_workflow_bridge", async () => {
      await target.browserWorkflowBridge!.close();
    });
  }
  return ran;
}
