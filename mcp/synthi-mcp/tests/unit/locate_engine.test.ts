import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { LocateEngine } from "../../src/locate/index.js";

async function testPng(w = 200, h = 200): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = (x * 2) & 0xff;
      raw[i + 1] = (y * 2) & 0xff;
      raw[i + 2] = ((x + y) * 2) & 0xff;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe("LocateEngine", () => {
  it("resolves with mock backend when hints.prefer_region is provided", async () => {
    const engine = new LocateEngine();
    const frame = await testPng();
    const bbox = { x: 40, y: 40, w: 30, h: 30 };
    const result = await engine.resolve(
      { description: "test", hints: { prefer_region: bbox }, preferred_vision_backend: "mock" },
      { frame, frameDims: { w: 200, h: 200 } }
    );
    expect(result.bbox).toEqual(bbox);
    expect(result.backend).toBe("mock");
    expect(result.resolved_via).toBe("region_match");
    expect(result.region_phash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.handle_id).toMatch(/^h_/);
  });

  it("reuses the cache on reuse_handle=true with same frame", async () => {
    const engine = new LocateEngine();
    const frame = await testPng();
    const bbox = { x: 40, y: 40, w: 30, h: 30 };

    const first = await engine.resolve(
      { description: "t", hints: { prefer_region: bbox }, preferred_vision_backend: "mock", handle_id: "panel" },
      { frame, frameDims: { w: 200, h: 200 } }
    );
    expect(first.resolved_via).toBe("region_match");

    const second = await engine.resolve(
      { description: "t", preferred_vision_backend: "mock", handle_id: "panel", reuse_handle: true },
      { frame, frameDims: { w: 200, h: 200 } }
    );
    expect(second.resolved_via).toBe("cached");
    expect(second.bbox).toEqual(bbox);
    expect(second.handle_id).toBe("panel");
  });

  it("emits one locator_resolution event per dispatch (cached + re-resolved)", async () => {
    const engine = new LocateEngine();
    const events: unknown[] = [];
    engine.onResolution((e) => events.push(e));
    const frame = await testPng();
    const bbox = { x: 40, y: 40, w: 30, h: 30 };
    await engine.resolve(
      { description: "t", hints: { prefer_region: bbox }, preferred_vision_backend: "mock", handle_id: "x" },
      { frame, frameDims: { w: 200, h: 200 } }
    );
    await engine.resolve(
      { description: "t", preferred_vision_backend: "mock", handle_id: "x", reuse_handle: true },
      { frame, frameDims: { w: 200, h: 200 } }
    );
    expect(events.length).toBe(2);
  });

  it("agent_side backend rejects when hints.prefer_region is absent", async () => {
    const engine = new LocateEngine();
    const frame = await testPng();
    await expect(
      engine.resolve(
        { description: "unknown", preferred_vision_backend: "agent_side" },
        { frame, frameDims: { w: 200, h: 200 } }
      )
    ).rejects.toThrow(/agent_side_vision_required/);
  });

  it("claude_api backend is a phase-0.5 stub", async () => {
    const engine = new LocateEngine();
    const frame = await testPng();
    await expect(
      engine.resolve(
        { description: "counter digit", preferred_vision_backend: "claude_api" },
        { frame, frameDims: { w: 200, h: 200 } }
      )
    ).rejects.toThrow(/claude_api_not_implemented/);
  });
});
