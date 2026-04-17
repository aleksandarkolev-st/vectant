import { beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  ClaudeApiBackendReal,
  type AnthropicLike,
  type AnthropicMessagesCreateParams,
  type AnthropicMessagesResponse,
  computeCostUsd,
  contentHash,
  descriptionHash,
  parseBboxResponse,
  clampBboxToFrame,
  PRICING_USD_PER_MILLION,
} from "../../src/locate/claude_api.js";
import { eventLog } from "../../src/events/index.js";
import type { UsageEvent } from "../../src/events/index.js";

async function tinyPng(w = 40, h = 40): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = (x * 6) & 0xff;
      raw[i + 1] = (y * 6) & 0xff;
      raw[i + 2] = 0x80;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

function mockClient(respond: (p: AnthropicMessagesCreateParams) => AnthropicMessagesResponse): {
  client: AnthropicLike;
  calls: AnthropicMessagesCreateParams[];
} {
  const calls: AnthropicMessagesCreateParams[] = [];
  return {
    calls,
    client: {
      messages: {
        async create(params: AnthropicMessagesCreateParams): Promise<AnthropicMessagesResponse> {
          calls.push(params);
          return respond(params);
        },
      },
    },
  };
}

function jsonTextResponse(body: Record<string, unknown>, usage = { input_tokens: 1100, output_tokens: 40 }): AnthropicMessagesResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    usage,
    stop_reason: "end_turn",
  };
}

describe("pricing", () => {
  it("computes cost for opus at $15/$75 per million tokens", () => {
    const cost = computeCostUsd("claude-opus-4-7", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(15 + 75, 6);
  });

  it("falls back to opus-rate for unknown models", () => {
    const cost = computeCostUsd("claude-brand-new", 1_000_000, 0);
    expect(cost).toBeCloseTo(15, 6);
  });

  it("pricing table has entries for the three tier families", () => {
    expect(PRICING_USD_PER_MILLION["claude-opus-4-7"]).toBeDefined();
    expect(PRICING_USD_PER_MILLION["claude-sonnet-4-6"]).toBeDefined();
    expect(PRICING_USD_PER_MILLION["claude-haiku-4-5"]).toBeDefined();
  });

  it("computes real-world-ish cost for a single vision call (~2K input, ~80 output on opus)", () => {
    const cost = computeCostUsd("claude-opus-4-7", 2000, 80);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.05); // sanity
  });
});

describe("parseBboxResponse", () => {
  it("parses a clean JSON bbox", () => {
    const r = parseBboxResponse('{"bbox":{"x":10,"y":20,"w":30,"h":40},"confidence":0.9,"trace":"found"}');
    expect(r.bbox).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(r.confidence).toBe(0.9);
    expect(r.trace).toBe("found");
  });

  it("peels JSON out of a ``` code fence preamble", () => {
    const r = parseBboxResponse('Sure!\n```json\n{"bbox":{"x":1,"y":2,"w":3,"h":4},"confidence":0.8,"trace":"ok"}\n```');
    expect(r.bbox).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it("rounds non-integer coordinates", () => {
    const r = parseBboxResponse('{"bbox":{"x":10.4,"y":20.6,"w":30.5,"h":40.2},"confidence":1}');
    expect(r.bbox).toEqual({ x: 10, y: 21, w: 31, h: 40 });
  });

  it("returns null bbox on not_visible", () => {
    const r = parseBboxResponse('{"bbox":null,"confidence":0,"trace":"not_visible"}');
    expect(r.bbox).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it("throws claude_api_parse_error on missing bbox fields", () => {
    expect(() =>
      parseBboxResponse('{"bbox":{"x":10,"y":20}}')
    ).toThrow(/claude_api_parse_error/);
  });

  it("throws claude_api_parse_error when no JSON block is present", () => {
    expect(() => parseBboxResponse("sorry, I can't find it")).toThrow(/claude_api_parse_error/);
  });
});

describe("clampBboxToFrame", () => {
  it("passes through an in-bounds bbox", () => {
    expect(clampBboxToFrame({ x: 10, y: 10, w: 30, h: 30 }, { w: 100, h: 100 })).toEqual({
      x: 10, y: 10, w: 30, h: 30,
    });
  });

  it("clamps x/y into the frame and trims w/h to the edge", () => {
    const out = clampBboxToFrame({ x: -5, y: -5, w: 200, h: 200 }, { w: 100, h: 100 });
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.x + out.w).toBeLessThanOrEqual(100);
  });

  it("forces a minimum width/height of 1 so pHash has pixels to hash", () => {
    const out = clampBboxToFrame({ x: 99, y: 99, w: 0, h: 0 }, { w: 100, h: 100 });
    expect(out.w).toBeGreaterThanOrEqual(1);
    expect(out.h).toBeGreaterThanOrEqual(1);
  });
});

describe("contentHash / descriptionHash", () => {
  it("same input → same hash", () => {
    expect(contentHash(Buffer.from("abc"))).toBe(contentHash(Buffer.from("abc")));
    expect(descriptionHash("the counter")).toBe(descriptionHash("the counter"));
  });

  it("different inputs → different hashes", () => {
    expect(contentHash(Buffer.from("abc"))).not.toBe(contentHash(Buffer.from("abd")));
    expect(descriptionHash("a")).not.toBe(descriptionHash("b"));
  });
});

describe("ClaudeApiBackendReal", () => {
  beforeEach(() => {
    eventLog._resetForTests();
  });

  it("invokes the client and returns a bbox", async () => {
    const { client, calls } = mockClient(() =>
      jsonTextResponse({ bbox: { x: 30, y: 40, w: 50, h: 60 }, confidence: 0.9, trace: "counter_digit" })
    );
    const backend = new ClaudeApiBackendReal({ client, model: "claude-opus-4-7" });
    const frame = await tinyPng();
    const res = await backend.resolve({
      description: "counter digit",
      frame,
      frameDims: { w: 40, h: 40 },
    });
    expect(res.bbox).toEqual({ x: 30, y: 39, w: 10, h: 1 }); // clamped to 40x40
    expect(res.confidence).toBe(0.9);
    expect(res.trace).toMatch(/claude_api/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages[0]!.content[0]!.type).toBe("image");
  });

  it("emits a usage event with input_tokens, output_tokens, and cost_usd", async () => {
    const { client } = mockClient(() =>
      jsonTextResponse(
        { bbox: { x: 10, y: 10, w: 5, h: 5 }, confidence: 0.95, trace: "ok" },
        { input_tokens: 2000, output_tokens: 100 }
      )
    );
    const backend = new ClaudeApiBackendReal({ client, model: "claude-opus-4-7" });
    const frame = await tinyPng();
    await backend.resolve({ description: "test", frame, frameDims: { w: 40, h: 40 } });

    const usage = eventLog.query({ kind: "usage" }) as UsageEvent[];
    expect(usage).toHaveLength(1);
    const detail = usage[0]!.detail as { input_tokens: number; output_tokens: number; cost_usd: number; model: string };
    expect(detail.input_tokens).toBe(2000);
    expect(detail.output_tokens).toBe(100);
    expect(detail.model).toBe("claude-opus-4-7");
    expect(detail.cost_usd).toBeCloseTo(computeCostUsd("claude-opus-4-7", 2000, 100), 6);
  });

  it("caches repeat calls by (content_hash, description)", async () => {
    const { client, calls } = mockClient(() =>
      jsonTextResponse({ bbox: { x: 1, y: 1, w: 10, h: 10 }, confidence: 0.8, trace: "ok" })
    );
    const backend = new ClaudeApiBackendReal({ client });
    const frame = await tinyPng();
    await backend.resolve({ description: "panel", frame, frameDims: { w: 40, h: 40 } });
    await backend.resolve({ description: "panel", frame, frameDims: { w: 40, h: 40 } });
    await backend.resolve({ description: "panel", frame, frameDims: { w: 40, h: 40 } });
    expect(calls).toHaveLength(1); // three callers → one API call
    expect(backend.cacheSize()).toBe(1);
  });

  it("re-invokes the client when the description changes even on the same frame", async () => {
    const { client, calls } = mockClient(() =>
      jsonTextResponse({ bbox: { x: 1, y: 1, w: 10, h: 10 }, confidence: 0.8, trace: "ok" })
    );
    const backend = new ClaudeApiBackendReal({ client });
    const frame = await tinyPng();
    await backend.resolve({ description: "panel", frame, frameDims: { w: 40, h: 40 } });
    await backend.resolve({ description: "counter digit", frame, frameDims: { w: 40, h: 40 } });
    expect(calls).toHaveLength(2);
  });

  it("raises claude_api_low_confidence when model reports bbox:null", async () => {
    const { client } = mockClient(() => jsonTextResponse({ bbox: null, confidence: 0, trace: "not_visible" }));
    const backend = new ClaudeApiBackendReal({ client });
    const frame = await tinyPng();
    await expect(
      backend.resolve({ description: "missing", frame, frameDims: { w: 40, h: 40 } })
    ).rejects.toThrow(/claude_api_low_confidence/);
    // Usage is still recorded even when the bbox is null — we paid for the call.
    const usage = eventLog.query({ kind: "usage" }) as UsageEvent[];
    expect(usage).toHaveLength(1);
    expect((usage[0]!.detail as { unresolved: boolean }).unresolved).toBe(true);
  });

  it("raises claude_api_low_confidence when confidence is below minConfidence", async () => {
    const { client } = mockClient(() =>
      jsonTextResponse({ bbox: { x: 1, y: 1, w: 10, h: 10 }, confidence: 0.1, trace: "unsure" })
    );
    const backend = new ClaudeApiBackendReal({ client, minConfidence: 0.5 });
    const frame = await tinyPng();
    await expect(
      backend.resolve({ description: "fuzzy", frame, frameDims: { w: 40, h: 40 } })
    ).rejects.toThrow(/claude_api_low_confidence/);
  });

  it("wraps SDK exceptions as claude_api_network_error", async () => {
    const backend = new ClaudeApiBackendReal({
      client: {
        messages: {
          async create() {
            throw new Error("rate_limit");
          },
        },
      },
    });
    const frame = await tinyPng();
    await expect(
      backend.resolve({ description: "x", frame, frameDims: { w: 40, h: 40 } })
    ).rejects.toThrow(/claude_api_network_error/);
  });

  it("rejects with claude_api_empty_response if the client returns no text block", async () => {
    const backend = new ClaudeApiBackendReal({
      client: {
        messages: {
          async create() {
            return { content: [], usage: { input_tokens: 1, output_tokens: 1 } };
          },
        },
      },
    });
    const frame = await tinyPng();
    await expect(
      backend.resolve({ description: "x", frame, frameDims: { w: 40, h: 40 } })
    ).rejects.toThrow(/claude_api_empty_response/);
  });

  it("silentUsage suppresses the usage event", async () => {
    const { client } = mockClient(() =>
      jsonTextResponse({ bbox: { x: 1, y: 1, w: 10, h: 10 }, confidence: 0.9, trace: "ok" })
    );
    const backend = new ClaudeApiBackendReal({ client, silentUsage: true });
    const frame = await tinyPng();
    await backend.resolve({ description: "x", frame, frameDims: { w: 40, h: 40 } });
    const usage = eventLog.query({ kind: "usage" });
    expect(usage).toHaveLength(0);
  });

  it("sends the configured model in the create params", async () => {
    const { client, calls } = mockClient(() =>
      jsonTextResponse({ bbox: { x: 1, y: 1, w: 10, h: 10 }, confidence: 0.9, trace: "ok" })
    );
    const backend = new ClaudeApiBackendReal({ client, model: "claude-sonnet-4-6" });
    const frame = await tinyPng();
    await backend.resolve({ description: "x", frame, frameDims: { w: 40, h: 40 } });
    expect(calls[0]!.model).toBe("claude-sonnet-4-6");
  });

  it("cache expires after cacheTtlMs", async () => {
    const { client, calls } = mockClient(() =>
      jsonTextResponse({ bbox: { x: 1, y: 1, w: 10, h: 10 }, confidence: 0.9, trace: "ok" })
    );
    const backend = new ClaudeApiBackendReal({ client, cacheTtlMs: 1 });
    const frame = await tinyPng();
    await backend.resolve({ description: "x", frame, frameDims: { w: 40, h: 40 } });
    await new Promise((r) => setTimeout(r, 5));
    await backend.resolve({ description: "x", frame, frameDims: { w: 40, h: 40 } });
    expect(calls).toHaveLength(2);
  });
});
