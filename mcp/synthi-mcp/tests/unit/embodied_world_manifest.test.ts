import { describe, expect, it } from "vitest";
import {
  resolveWorldManifest,
  validateWorldManifest,
  UnknownSubstrateError,
  type DojoWorldManifest,
} from "../../src/embodied/world_manifest.js";
import { registerSubstrateAdapter, unregisterAllSubstrateAdapters, getAdapter } from "../../src/embodied/substrate.js";
import type { SubstrateAdapterBundle } from "../../src/embodied/substrate.js";

function stubBundle(kind: string, caps: Partial<Record<"observer" | "actor" | "recorder", unknown>>): SubstrateAdapterBundle {
  return {
    substrate_kind: kind,
    adapter_version: "1",
    attach: async () => ({ handle_id: "h", environment: {}, realm: { realm_kind: "k", realm_id: kind } }),
    ...caps,
  } as unknown as SubstrateAdapterBundle;
}

const MANIFEST: DojoWorldManifest = {
  world_manifest_version: "synthi.dojo.worldManifest.v1",
  adapter_kind: "kv.state",
  realm: { realm_kind: "store", realm_id: "s1" },
  required_capabilities: ["observe", "act"],
  description: "seeded key-value world",
};

describe("dojo world manifests (plan Architecture Changes)", () => {
  it("validates structure and capability coherence", () => {
    expect(validateWorldManifest(MANIFEST)).toEqual([]);
    const bad = validateWorldManifest({
      ...MANIFEST,
      world_manifest_version: "wrong" as DojoWorldManifest["world_manifest_version"],
      realm: { realm_kind: "", realm_id: "" },
      required_capabilities: ["observe", "fly" as never],
    });
    expect(bad.length).toBeGreaterThanOrEqual(3);

    // act without observe is incoherent.
    const blind = validateWorldManifest({ ...MANIFEST, required_capabilities: ["act"] });
    expect(blind.join(" ")).toMatch(/act requires observe/);
  });

  it("resolves against the live registry; unknown kinds fail closed", async () => {
    unregisterAllSubstrateAdapters();
    registerSubstrateAdapter(
      stubBundle("kv.state", {
        observer: {},
        actor: {},
      }),
    );
    const bundle = resolveWorldManifest(MANIFEST, getAdapter);
    expect(bundle.substrate_kind).toBe("kv.state");

    // Missing capability on the registered bundle -> refused with the cap named.
    expect(() =>
      resolveWorldManifest(
        { ...MANIFEST, required_capabilities: ["observe", "record", "act"] },
        getAdapter,
      ),
    ).toThrow(/lacks record/);

    // Unregistered kind -> fail-closed.
    expect(() =>
      resolveWorldManifest({ ...MANIFEST, adapter_kind: "nope.kind" }, getAdapter),
    ).toThrow(UnknownSubstrateError);
  });
});
