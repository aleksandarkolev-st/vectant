import { describe, expect, it } from "vitest";
import { runWindTunnel, type WindTunnelVariant } from "../../src/embodied/hardening.js";
import type { ReplayProviderCap, SessionHandle } from "../../src/embodied/substrate.js";

type FakeHandle = SessionHandle<{ behavior: "pass" | "fail"; label: string }>;

function providerFor(
  behavior: (handle: FakeHandle) => boolean,
): ReplayProviderCap {
  return {
    replay: async (fragment, options) => {
      const world = (options.handle as FakeHandle).environment as { behavior: "pass" | "fail" } | undefined;
      const ok = (world?.behavior ?? "pass") === "pass";
      void fragment;
      return {
        ok,
        step_results: fragment.steps.map((_, index) => ({
          step_index: index,
          ok,
          classifier_trunk: ok ? undefined : "world_changed",
        })),
      };
    },
  };
}

function handle(label: string, mode: "pass" | "fail"): WindTunnelVariant["handle"] {
  return {
    handle_id: label,
    environment: { behavior: mode, label },
    realm: { realm_kind: "test", realm_id: label },
  } as unknown as WindTunnelVariant["handle"];
}

const FRAGMENT = {
  trace_id: "t",
  steps: [{ event: { step: 1 } }, { event: { step: 2 } }],
};

describe("counterfactual wind tunnel", () => {
  it("hardens when equivalents pass and twins fail; reports trunks", async () => {
    const provider = providerFor((handle) => handle.environment.behavior === "pass");
    const report = await runWindTunnel(provider, FRAGMENT, [
      { variant_id: "layout-shifted", equivalent: true, handle: handle("v1", "pass") },
      { variant_id: "colors-rotated", equivalent: true, handle: handle("v2", "pass") },
      { variant_id: "repainted-target", equivalent: false, handle: handle("v3", "fail") },
    ]);
    expect(report.hardened).toBe(true);
    expect(report.vacuous_variants).toEqual([]);
    expect(report.brittle_variants).toEqual([]);
    const twin = report.outcomes.find((outcome) => outcome.variant_id === "repainted-target")!;
    expect(twin.failed_trunks).toEqual(["world_changed"]);
  });

  it("flags VACUOUS variants: a twin where the flow wrongly succeeds", async () => {
    const alwaysPass = providerFor(() => true);
    const report = await runWindTunnel(alwaysPass, FRAGMENT, [
      { variant_id: "equivalent-a", equivalent: true, handle: handle("a", "pass") },
      { variant_id: "twin-b", equivalent: false, handle: handle("b", "pass") },
    ]);
    expect(report.hardened).toBe(false);
    expect(report.vacuous_variants).toEqual(["twin-b"]);
  });

  it("flags BRITTLE variants: an equivalent world where the flow fails", async () => {
    const alwaysFail = providerFor(() => false);
    const report = await runWindTunnel(alwaysFail, FRAGMENT, [
      { variant_id: "equiv", equivalent: true, handle: handle("e", "fail") },
    ]);
    expect(report.hardened).toBe(false);
    expect(report.brittle_variants).toEqual(["equiv"]);
    // No twin ran, so nothing is vacuous.
    expect(report.vacuous_variants).toEqual([]);
  });
});
