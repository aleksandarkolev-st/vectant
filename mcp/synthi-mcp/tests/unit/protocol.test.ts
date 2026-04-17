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

  it("marks enriched_tier unavailable in phase 0.5", () => {
    const m = buildManifest(ADVERTISED_TOOLS);
    expect(m.enriched_tier.available).toBe(false);
    expect(m.enriched_tier.reason).toContain("phase_2");
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
});
