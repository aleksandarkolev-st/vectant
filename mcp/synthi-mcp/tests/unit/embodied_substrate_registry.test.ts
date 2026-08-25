import { beforeEach, describe, expect, it } from "vitest";
import {
  CapabilityMissingError,
  getAdapter,
  hasCapability,
  listRegisteredSubstrates,
  registerSubstrateAdapter,
  requireCapability,
  unregisterAllSubstrateAdapters,
  type SubstrateAdapterBundle,
} from "../../src/embodied/substrate.js";

function bundleWith(
  substrateKind: string,
  capabilities: Partial<SubstrateAdapterBundle>,
): SubstrateAdapterBundle {
  return {
    substrate_kind: substrateKind,
    adapter_version: "1.0.0",
    attach: async ({ realm }) => ({
      handle_id: "h1",
      environment: {},
      realm,
    }),
    ...capabilities,
  };
}

beforeEach(() => {
  unregisterAllSubstrateAdapters();
});

describe("registration", () => {
  it("registers and retrieves adapters by kind", () => {
    const adapter = bundleWith("grid.world", {});
    registerSubstrateAdapter(adapter);
    expect(getAdapter("grid.world")).toBe(adapter);
    expect(listRegisteredSubstrates()).toEqual(["grid.world"]);
  });

  it("rejects duplicate registration of different bundles", () => {
    registerSubstrateAdapter(bundleWith("kv", {}));
    expect(() => registerSubstrateAdapter(bundleWith("kv", {}))).toThrow(/already registered/);
  });

  it("rejects invalid kind names and unknown lookups", () => {
    expect(() => registerSubstrateAdapter(bundleWith("bad kind", {}))).toThrow(/invalid substrate kind/);
    expect(() => getAdapter("nowhere")).toThrow(/no adapter registered/);
  });
});

describe("structural capability negotiation", () => {
  const observerOnly = bundleWith("observer.only", {
    observer: { observe: async () => ({}), describeWorldSchema: () => ({}) as never, channels: ["state"] },
  });

  it("exposes exactly the capabilities present on the bundle", () => {
    registerSubstrateAdapter(observerOnly);
    expect(hasCapability("observer.only", "observer")).toBe(true);
    expect(hasCapability("observer.only", "actor")).toBe(false);
    expect(hasCapability("observer.only", "fork_provider")).toBe(false);
    expect(hasCapability("observer.only", "recorder")).toBe(false);
  });

  it("requireCapability returns the capability or throws a typed error", () => {
    registerSubstrateAdapter(observerOnly);
    const observer = requireCapability(
      "observer.only",
      (b) => b.observer,
      "observer",
    );
    expect(observer.channels).toEqual(["state"]);
    expect(() =>
      requireCapability("observer.only", (b) => b.actor, "actor"),
    ).toThrow(CapabilityMissingError);
    try {
      requireCapability("observer.only", (b) => b.fork_provider, "fork_provider");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as CapabilityMissingError).message).toContain('"observer.only" does not provide capability "fork_provider"');
    }
  });

  it("downstream behavior keys off negotiated structure, not booleans", () => {
    // A component that needs forks negotiates ForkProvider directly.
    const forkless = bundleWith("no.forks", {});
    registerSubstrateAdapter(forkless);
    const canFork = (() => {
      try {
        requireCapability("no.forks", (b) => b.fork_provider, "fork_provider");
        return true;
      } catch {
        return false;
      }
    })();
    expect(canFork).toBe(false); // caller falls back to multi-demo voting
  });

  it("attach flows realm consent through to handles", async () => {
    const adapter = bundleWith("consent.test", {});
    registerSubstrateAdapter(adapter);
    const handle = await adapter.attach({
      realm: { realm_kind: "origin", realm_id: "https://x.example" },
      consent_proof: { subject: "a", realm: { realm_kind: "origin", realm_id: "https://x.example" }, approved_capabilities: ["observe"] },
    });
    expect(handle.realm.realm_id).toBe("https://x.example");
    expect(handle.handle_id).toBe("h1");
  });
});
