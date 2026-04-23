import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  ProtocolNegotiationError,
  SERVER_SUPPORTS,
  buildManifest,
  negotiateProtocol,
} from "../../src/protocol/index.js";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";

describe("negotiateProtocol", () => {
  it("returns default version when no request given", () => {
    const n = negotiateProtocol();
    expect(n.agreed).toBe(PROTOCOL_VERSION);
    expect(n.server_supports).toEqual([...SERVER_SUPPORTS]);
  });

  it("accepts a supported version", () => {
    const n = negotiateProtocol(1);
    expect(n.agreed).toBe(1);
  });

  it("throws unsupported_protocol for unknown version", () => {
    try {
      negotiateProtocol(999);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolNegotiationError);
      if (err instanceof ProtocolNegotiationError) {
        expect(err.code).toBe("unsupported_protocol");
        expect(err.requested).toBe(999);
        expect(err.server_supports).toEqual([...SERVER_SUPPORTS]);
      }
    }
  });

  it("throws on non-integer requests", () => {
    expect(() => negotiateProtocol(1.5)).toThrow(/unsupported_protocol/);
    expect(() => negotiateProtocol(0)).toThrow(/unsupported_protocol/);
    expect(() => negotiateProtocol(-1)).toThrow(/unsupported_protocol/);
  });
});

describe("buildManifest", () => {
  it("includes every advertised tool", () => {
    const m = buildManifest(ADVERTISED_TOOLS);
    for (const name of ADVERTISED_TOOLS) {
      expect(m.tools).toContain(name);
    }
  });

  it("always advertises mock/agent_side/claude_api vision backends", () => {
    const m = buildManifest(ADVERTISED_TOOLS);
    expect(m.vision_backends).toContain("mock");
    expect(m.vision_backends).toContain("agent_side");
    expect(m.vision_backends).toContain("claude_api");
  });

  it("marks enriched_tier unavailable when no provider is registered", () => {
    const m = buildManifest(ADVERTISED_TOOLS);
    expect(m.enriched_tier.available).toBe(false);
    expect(m.enriched_tier.reason).toBe("no_provider_registered");
  });

  it("exposes region-pHash cache defaults", () => {
    const m = buildManifest(ADVERTISED_TOOLS);
    expect(m.region_phash_cache.available).toBe(true);
    expect(m.region_phash_cache.ttl_ms).toBe(30_000);
    expect(m.region_phash_cache.drift_threshold).toBe(12);
  });

  it("keystroke rate cap is 500/s", () => {
    const m = buildManifest(ADVERTISED_TOOLS);
    expect(m.security.keystroke_rate_cap_per_sec).toBe(500);
  });

  // Regression guards: manifest must describe the actual tool surface.
  // These asserts catch the class of drift that bit us at the phase-3
  // land (manifest said "audio" as a wait condition and the wait tool
  // had no such thing; manifest omitted ocr/scene_matches even though
  // the verify engine accepts them with `unsupported` remediation).
  it("wait_conditions matches the wait tool's accepted set", async () => {
    const { waitTool } = await import("../../src/tools/wait.js");
    // Spot-check: sending a condition outside the manifest's list should
    // fail with invalid_args; sending a condition inside the list must
    // not fail with invalid_args specifically for 'condition'.
    const m = buildManifest(ADVERTISED_TOOLS);
    // audio is a separate tool (synthi_wait_audio_event), NOT a wait
    // condition — the manifest must not advertise it here.
    expect(m.wait_conditions).not.toContain("audio");
    for (const c of m.wait_conditions) {
      const res = await waitTool({ condition: c, timeoutMs: 10 });
      // We don't care about the outcome (most will time out or be
      // unsupported). The regression is: the tool must not reject the
      // condition as invalid_args for `field: "condition"`.
      const body = res.structuredContent as { error?: string; field?: string };
      const rejectedByValidator =
        body?.error === "invalid_args" && body?.field === "condition";
      expect(rejectedByValidator, `wait rejected advertised condition "${c}"`).toBe(false);
    }
  });

  it("verify_predicates matches the verify engine's switch", () => {
    const m = buildManifest(ADVERTISED_TOOLS);
    // Every kind listed must be accepted by the engine — even 'ocr' and
    // 'scene_matches', which return structured `unsupported` remediation
    // rather than throwing. Hiding them from the manifest makes agents
    // branch wrong.
    expect(m.verify_predicates).toEqual(
      expect.arrayContaining(["pixel", "log", "element_visible", "ocr", "scene_matches", "and", "or"])
    );
  });

  it("vision_backends includes all four peers + mock", () => {
    const m = buildManifest(ADVERTISED_TOOLS);
    expect(m.vision_backends).toEqual(
      expect.arrayContaining(["agent_side", "claude_api", "gemini_api", "local", "mock"])
    );
  });
});
