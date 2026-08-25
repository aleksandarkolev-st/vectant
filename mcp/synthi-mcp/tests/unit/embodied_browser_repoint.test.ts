import { describe, expect, it, vi } from "vitest";
import {
  dispatchActionThroughEmbodiedBundle,
  liveBrowserEmbodiedBundle,
} from "../../src/tools/browser_embodied_bridge.js";
import { createBrowserEmbodiedBundle } from "../../src/browser/embodied_adapter.js";
import type { BrowserAdapterPorts } from "../../src/browser/embodied_adapter.js";
import type { SessionHandle } from "../../src/embodied/substrate.js";

function fakePorts(): BrowserAdapterPorts & { actions: string[] } {
  const actions: string[] = [];
  return {
    actions,
    observePage: async () => ({ url: "https://x.test/p", origin: "https://x.test", dom: {} }),
    performAction: async (_handle, event) => {
      actions.push((event as unknown as { action: string }).action);
      return { ok: true };
    },
  };
}

function handle(realmId: string): SessionHandle {
  return {
    handle_id: "h1",
    environment: { recorded: [], recording: false },
    realm: { realm_kind: "origin", realm_id: realmId },
  } as unknown as SessionHandle;
}

const EVENT = { kind: "human_action", ts: 1, action: "click", selector: "#go" } as never;

describe("legacy browser tools re-pointed onto the embodied bundle", () => {
  it("actions execute only after the bundle's lease + realm checks pass", async () => {
    const ports = fakePorts();
    const bundle = createBrowserEmbodiedBundle(ports);
    const h = handle("https://x.test");
    const lease = { lease_id: "l1", realm: h.realm, expires_at_ms: Date.now() + 60_000 };

    const okOutcome = await dispatchActionThroughEmbodiedBundle({ bundle, handle: h, event: EVENT, lease });
    expect(okOutcome.ok).toBe(true);
    expect(ports.actions).toEqual(["click"]);

    // Expired lease: refused BEFORE any execution.
    ports.actions.length = 0;
    const expired = await dispatchActionThroughEmbodiedBundle({
      bundle,
      handle: h,
      event: EVENT,
      lease: { ...lease, expires_at_ms: Date.now() - 1 },
    });
    expect(expired.ok).toBe(false);
    expect(expired.refusal_reason).toContain("lease expired");
    expect(ports.actions).toEqual([]);

    // Realm mismatch: refused BEFORE any execution.
    const wrongRealm = await dispatchActionThroughEmbodiedBundle({
      bundle,
      handle: h,
      event: EVENT,
      lease: { ...lease, realm: { realm_kind: "origin", realm_id: "https://other.test" } },
    });
    expect(wrongRealm.ok).toBe(false);
    expect(wrongRealm.refusal_reason).toContain("realm mismatch");
    expect(ports.actions).toEqual([]);
  });

  it("live bridge constructs a browser-kind bundle without importing a launcher", () => {
    const bundle = liveBrowserEmbodiedBundle();
    expect(bundle.substrate_kind).toBe("browser");
    // Capabilities present structurally - observer, actor, recorder.
    expect(bundle.observer).toBeDefined();
    expect(bundle.actor).toBeDefined();
    expect(bundle.recorder).toBeDefined();
    // Schema is the declared browser world schema.
    expect(bundle.observer!.describeWorldSchema().schema_id).toBe("browser.world");
    void vi;
  });
});
