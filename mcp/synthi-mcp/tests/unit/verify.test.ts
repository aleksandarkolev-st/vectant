import { beforeEach, describe, expect, it } from "vitest";
import { verifyTool } from "../../src/tools/verify.js";
import { verify } from "../../src/verify/index.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";
import sharp from "sharp";

async function solidPng(w: number, h: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    raw[i * 3] = color.r;
    raw[i * 3 + 1] = color.g;
    raw[i * 3 + 2] = color.b;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

function installFake(color: { r: number; g: number; b: number }): void {
  const frame = {
    data: undefined as unknown as Buffer,
    width: 200,
    height: 100,
    ts: Date.now(),
    seq: 1,
  };
  solidPng(200, 100, color).then((png) => { frame.data = png; });
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fake",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 200, height: 100 },
    frames: {
      getFrame: async () => {
        // Lazily build the png once so the test is deterministic.
        if (!frame.data) {
          frame.data = await solidPng(200, 100, color);
        }
        return frame;
      },
    },
  };
}

describe("synthi_verify engine", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("pixel matches expected_rgb", async () => {
    installFake({ r: 100, g: 150, b: 200 });
    const r = await verify({
      kind: "pixel",
      x: 50,
      y: 50,
      expected_rgb: [100, 150, 200],
    });
    expect(r.matched).toBe(true);
  });

  it("pixel fails when expected_rgb differs", async () => {
    installFake({ r: 100, g: 150, b: 200 });
    const r = await verify({
      kind: "pixel",
      x: 50,
      y: 50,
      expected_rgb: [0, 0, 0],
    });
    expect(r.matched).toBe(false);
  });

  it("pixel tolerance accepts close colors", async () => {
    installFake({ r: 100, g: 150, b: 200 });
    const r = await verify({
      kind: "pixel",
      x: 50,
      y: 50,
      expected_rgb: [102, 148, 198],
      tolerance: 5,
    });
    expect(r.matched).toBe(true);
  });

  it("pixel out-of-bounds throws click_out_of_bounds", async () => {
    installFake({ r: 0, g: 0, b: 0 });
    const res = await verifyTool({
      predicate: { kind: "pixel", x: 9999, y: 9999, expected_rgb: [0, 0, 0] },
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("click_out_of_bounds");
  });

  it("log matches pattern in existing events", async () => {
    eventLog.push({ kind: "console", level: "info", message: "hello world", source: "mcp_internal" });
    const r = await verify({ kind: "log", pattern: "hello" });
    expect(r.matched).toBe(true);
  });

  it("log fails when no pattern match", async () => {
    const r = await verify({ kind: "log", pattern: "nonexistent" });
    expect(r.matched).toBe(false);
  });

  it("ocr returns unsupported", async () => {
    const res = await verifyTool({
      predicate: { kind: "ocr", substring: "foo" },
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toContain("ocr");
    const body = res.structuredContent as { required_tool_call?: unknown };
    expect(body.required_tool_call).toBeDefined();
  });

  it("scene_matches returns verify_scene_matches_unsupported", async () => {
    const res = await verifyTool({ predicate: { kind: "scene_matches", description: "a green button" } });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("verify_scene_matches_unsupported");
  });

  it("and composes multiple predicates (short-circuits on failure)", async () => {
    eventLog.push({ kind: "console", level: "info", message: "marker", source: "mcp_internal" });
    const r = await verify({
      kind: "and",
      predicates: [
        { kind: "log", pattern: "marker" },
        { kind: "log", pattern: "absent" },
      ],
    });
    expect(r.matched).toBe(false);
    const ev = r.evidence as { short_circuit_at: number };
    expect(ev.short_circuit_at).toBe(1);
  });

  it("or returns true on first matching predicate", async () => {
    eventLog.push({ kind: "console", level: "info", message: "marker", source: "mcp_internal" });
    const r = await verify({
      kind: "or",
      predicates: [
        { kind: "log", pattern: "absent" },
        { kind: "log", pattern: "marker" },
      ],
    });
    expect(r.matched).toBe(true);
    const ev = r.evidence as { matched_at: number };
    expect(ev.matched_at).toBe(1);
  });

  it("depth > 4 throws verify_predicate_too_deep", async () => {
    const deep = {
      kind: "and" as const,
      predicates: [
        { kind: "and" as const, predicates: [
          { kind: "and" as const, predicates: [
            { kind: "and" as const, predicates: [
              { kind: "and" as const, predicates: [
                { kind: "log" as const, pattern: "x" },
              ] },
            ] },
          ] },
        ] },
      ],
    };
    const res = await verifyTool({ predicate: deep });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("verify_predicate_too_deep");
  });

  it("clauses > 8 throws verify_predicate_too_many_clauses", async () => {
    const fat = {
      kind: "and" as const,
      predicates: Array(9).fill(null).map(() => ({ kind: "log" as const, pattern: "x" })),
    };
    const res = await verifyTool({ predicate: fat });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("verify_predicate_too_many_clauses");
  });
});
