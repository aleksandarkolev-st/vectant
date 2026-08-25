import { describe, expect, it } from "vitest";
import {
  createBrowserEmbodiedBundle,
  browserWorldSchema,
} from "../../src/browser/embodied_adapter.js";
import { validateWorldStateSchema } from "../../src/embodied/world_state.js";
import { embodiedToBrowserEvent } from "../../src/embodied/event.js";
import type { BrowserTraceEventShape } from "../../src/embodied/event.js";
import type { SessionHandle } from "../../src/embodied/substrate.js";

function fakePage(url: string) {
  return { url, origin: new URL(url).origin, dom: { "#save": { visible: true, text: "Save" } } };
}

function makePorts() {
  const applied: BrowserTraceEventShape[] = [];
  const pages = ["https://app.example:8443/settings", "https://app.example:8443/settings"];
  let pageIndex = 0;
  return {
    applied,
    ports: {
      observePage: async (handle: SessionHandle) => {
        void handle;
        const url = pages[Math.min(pageIndex, pages.length - 1)] as string;
        pageIndex += 1;
        return fakePage(url);
      },
      performAction: async (_handle: SessionHandle, event: BrowserTraceEventShape) => {
        applied.push(event);
        return { ok: true, applied: true };
      },
    },
  };
}

const LEASE = {
  lease_id: "lease-1",
  realm: { realm_kind: "origin", realm_id: "https://app.example:8443" },
  capability: "act" as const,
  expires_at_ms: Number.MAX_SAFE_INTEGER,
};

describe("browser substrate on capability interfaces", () => {
  it("declares a valid world schema", () => {
    expect(validateWorldStateSchema(browserWorldSchema())).toEqual([]);
  });

  it("records human actions and converts them to universal events losslessly", async () => {
    const { applied, ports } = makePorts();
    const bundle = createBrowserEmbodiedBundle(ports);
    const handle = (await bundle.attach({
      realm: { realm_kind: "origin", realm_id: "https://app.example:8443" },
      consent_proof: {
        subject: "a",
        realm: { realm_kind: "origin", realm_id: "https://app.example:8443" },
        approved_capabilities: ["observe", "record", "act"],
      },
    })) as never;

    bundle.recorder!.beginRecord(handle);
    const clickEvent: BrowserTraceEventShape = {
      event_id: "evt-1",
      trace_id: "trace-1",
      trace_version: 1,
      event_seq: 0,
      ts: 1760000000000,
      tab_id: "tab-7",
      origin: "https://app.example:8443",
      url: "https://app.example:8443/settings",
      kind: "human_action",
      action: "click",
      locator_candidates: [
        { kind: "role", locator: "button[name='Save']", confidence: 0.95, reason: "primary submit" },
      ],
      security: {
        exact_origin_approved: true,
        screenshot_approved: true,
        diagnostics_approved: false,
        auth_checkpoint_approved: false,
      },
    };
    const actResult = await bundle.actor!.act(handle, clickEvent, LEASE);
    expect(actResult.ok).toBe(true);

    const fragment = bundle.recorder!.endRecord(handle);
    expect(fragment.steps).toHaveLength(1);
    const step = fragment.steps[0] as { event: BrowserTraceEventShape; embodied: unknown };
    // Round-trip through the universal model is exact.
    expect(embodiedToBrowserEvent(step.embodied as never)).toEqual(clickEvent);
    // Universal coordinates derived correctly.
    const embodied = step.embodied as { substrate: { kind: string }; realm: { realm_kind: string } };
    expect(embodied.substrate.kind).toBe("browser");
    expect(embodied.realm.realm_kind).toBe("origin");
  });

  it("refuses actions on expired leases and mismatched realms", async () => {
    const { applied, ports } = makePorts();
    const bundle = createBrowserEmbodiedBundle(ports);
    const handle = (await bundle.attach({
      realm: { realm_kind: "origin", realm_id: "https://app.example:8443" },
      consent_proof: {
        subject: "a",
        realm: { realm_kind: "origin", realm_id: "https://app.example:8443" },
        approved_capabilities: ["act"],
      },
    })) as never;

    const expired = await bundle.actor!.act(handle, minimalClick(), {
      ...LEASE,
      expires_at_ms: Date.now() - 1000,
    });
    expect(expired.ok).toBe(false);
    expect(expired.refusal_reason).toContain("expired");

    const wrongRealm = await bundle.actor!.act(handle, minimalClick(), {
      ...LEASE,
      realm: { realm_kind: "origin", realm_id: "https://other.example" },
    });
    expect(wrongRealm.ok).toBe(false);
    expect(wrongRealm.refusal_reason).toContain("realm");

    // Nothing was performed.
    expect(applied).toHaveLength(0);
  });

  it("observes the page through the observer channel contract", async () => {
    const { applied, ports } = makePorts();
    const bundle = createBrowserEmbodiedBundle(ports);
    const handle = (await bundle.attach({
      realm: { realm_kind: "origin", realm_id: "https://app.example:8443" },
      consent_proof: {
        subject: "a",
        realm: { realm_kind: "origin", realm_id: "https://app.example:8443" },
        approved_capabilities: ["observe"],
      },
    })) as never;
    const observation = (await bundle.observer!.observe(handle)) as { origin: string };
    expect(observation.origin).toBe("https://app.example:8443");
    expect(bundle.observer!.channels).toEqual(["dom", "console", "network"]);
  });
});

function minimalClick(): BrowserTraceEventShape {
  return {
    event_id: "e",
    trace_id: "t",
    trace_version: 1,
    event_seq: 0,
    ts: 0,
    tab_id: "tab",
    origin: "https://app.example:8443",
    url: "https://app.example:8443/",
    kind: "human_action",
    action: "click",
  };
}
