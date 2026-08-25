/**
 * Re-points the legacy browser tool surface onto the embodied capability
 * interfaces (plan Architecture Changes: "existing synthi_browser_* tools:
 * unchanged; internally become the browser adapter").
 *
 * The tools keep their names and response shapes; the ACTION path now
 * flows through the browser substrate bundle (lease + realm checks +
 * EmbodiedEvent conversion) instead of calling the Playwright adapter
 * directly. Observation and recording delegate to the same ports, so the
 * broker stays the single source of truth for live browser state.
 */
import { browserBroker } from "../browser/broker.js";
import {
  createBrowserEmbodiedBundle,
  type BrowserAdapterPorts,
} from "../browser/embodied_adapter.js";
import type { BrowserTraceEvent } from "../browser/types.js";
import type { SessionHandle, SubstrateAdapterBundle } from "../embodied/substrate.js";

/** Live ports backed by the broker + Playwright adapter: the same code the
 *  legacy tools call directly, now reached only through the bundle. */
export function liveBrowserAdapterPorts(): BrowserAdapterPorts {
  return {
    observePage: async (_handle) => {
      const snapshot = browserBroker.traceSnapshot();
      const last = snapshot[snapshot.length - 1];
      return {
        url: last?.url ?? "about:blank",
        origin: (() => {
          try {
            return last?.url ? new URL(last.url).origin : "null";
          } catch {
            return "null";
          }
        })(),
        dom: { event_count: snapshot.length },
      };
    },
    performAction: async (handle, event) => {
      void handle;
      const result = await browserBroker.recordHumanAction({
        ...(event as unknown as BrowserTraceEvent),
        action: (event as unknown as { action: string }).action as never,
      });
      return result.ok ? { ok: true } : { ok: false, refusal_reason: result.error };
    },
  };
}

/** The browser substrate bundle wired to live broker ports. */
export function liveBrowserEmbodiedBundle(): SubstrateAdapterBundle {
  return createBrowserEmbodiedBundle(liveBrowserAdapterPorts()) as SubstrateAdapterBundle;
}

/**
 * Route ONE action through the capability interfaces: lease and realm are
 * checked by the bundle's actor before any execution happens. Returns the
 * bundle's verdict so the legacy tool can render its usual response shape.
 */
export async function dispatchActionThroughEmbodiedBundle(input: {
  bundle: SubstrateAdapterBundle;
  handle: SessionHandle;
  event: BrowserTraceEvent;
  lease: { lease_id: string; realm: SessionHandle["realm"]; expires_at_ms: number };
}): Promise<{ ok: boolean; refusal_reason?: string }> {
  const outcome = await input.bundle.actor!.act(
    input.handle,
    input.event,
    {
      lease_id: input.lease.lease_id,
      realm: input.lease.realm,
      capability: "act",
      expires_at_ms: input.lease.expires_at_ms,
    },
  );
  return outcome.ok ? { ok: true } : { ok: false, refusal_reason: outcome.refusal_reason };
}

