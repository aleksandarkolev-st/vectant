/**
 * Unit tests for the gemini_api vision backend. Mirrors the shape of
 * claude_api_backend.test.ts — same cache semantics, same usage-event
 * surface, same abort behavior, same confidence gate. Deliberately kept
 * parallel so drifting one vendor surfaces the symmetry break in diff.
 */

import { beforeEach, describe, it, expect } from "vitest";
import {
  GeminiApiBackendReal,
  GEMINI_PRICING_USD_PER_MILLION,
  GEMINI_FALLBACK_PRICING,
  computeGeminiCostUsd,
  extractGeminiText,
  parseGeminiBboxResponse,
} from "../../src/locate/gemini_api.js";
import type {
  GeminiLike,
  GeminiGenerateParams,
  GeminiGenerateResponse,
} from "../../src/locate/gemini_api.js";
import { eventLog } from "../../src/events/index.js";

const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const frameDims = { w: 800, h: 600 };

function respond(text: string, tokens = { promptTokenCount: 100, candidatesTokenCount: 20 }): GeminiGenerateResponse {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
    usageMetadata: { ...tokens, totalTokenCount: tokens.promptTokenCount + tokens.candidatesTokenCount },
  };
}

function makeClient(
  handler: (params: GeminiGenerateParams) => Promise<GeminiGenerateResponse>
): GeminiLike {
  return {
    models: {
      async generateContent(params: GeminiGenerateParams): Promise<GeminiGenerateResponse> {
        return handler(params);
      },
    },
  };
}

describe("computeGeminiCostUsd", () => {
  it("applies gemini-2.5-flash rates ($0.30/M input, $2.50/M output)", () => {
    const cost = computeGeminiCostUsd("gemini-2.5-flash", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.3 + 2.5, 6);
  });

  it("applies gemini-2.5-pro rates ($1.25/M input, $10/M output)", () => {
    const cost = computeGeminiCostUsd("gemini-2.5-pro", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(1.25 + 10, 6);
  });

  it("falls back to pro rate for unknown model ids (conservative)", () => {
    const cost = computeGeminiCostUsd("gemini-future-preview", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(
      GEMINI_FALLBACK_PRICING.input + GEMINI_FALLBACK_PRICING.output,
      6
    );
  });

  it("rounds to µUSD", () => {
    const cost = computeGeminiCostUsd("gemini-2.5-flash", 100, 50);
    // (100 * 0.3 + 50 * 2.5) / 1e6 = 0.000155 → 0.000155 (already µUSD)
    expect(cost).toBe(0.000155);
  });
});

describe("extractGeminiText", () => {
  it("concatenates all text parts from the first candidate", () => {
    const text = extractGeminiText({
      candidates: [
        {
          content: {
            parts: [{ text: "hello " }, { text: "world" }],
          },
        },
      ],
    });
    expect(text).toBe("hello world");
  });

  it("ignores non-text parts", () => {
    const text = extractGeminiText({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: "image/png", data: "abc" } },
              { text: "after the image" },
            ],
          },
        },
      ],
    });
    expect(text).toBe("after the image");
  });

  it("returns empty string when no candidates", () => {
    expect(extractGeminiText({})).toBe("");
    expect(extractGeminiText({ candidates: [] })).toBe("");
  });
});

describe("parseGeminiBboxResponse", () => {
  it("parses bare JSON", () => {
    const parsed = parseGeminiBboxResponse(
      '{"bbox":{"x":10,"y":20,"w":30,"h":40},"confidence":0.8,"trace":"ok"}'
    );
    expect(parsed.bbox).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(parsed.confidence).toBe(0.8);
  });

  it("tolerates prose wrapping + code fences", () => {
    const parsed = parseGeminiBboxResponse(
      'Sure thing! Here is the result:\n```json\n{"bbox":{"x":1,"y":2,"w":3,"h":4},"confidence":0.9,"trace":"t"}\n```'
    );
    expect(parsed.bbox).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it("returns {bbox:null,confidence:0} on explicit null", () => {
    const parsed = parseGeminiBboxResponse('{"bbox":null,"confidence":0,"trace":"not_visible"}');
    expect(parsed.bbox).toBeNull();
    expect(parsed.confidence).toBe(0);
  });

  it("throws gemini_api_parse_error on missing JSON", () => {
    expect(() => parseGeminiBboxResponse("no json here")).toThrow(/gemini_api_parse_error/);
  });

  it("throws gemini_api_parse_error on malformed JSON", () => {
    expect(() => parseGeminiBboxResponse("{not json}")).toThrow(/gemini_api_parse_error/);
  });

  it("throws on bbox without numeric fields", () => {
    expect(() =>
      parseGeminiBboxResponse('{"bbox":{"x":"10","y":20,"w":30,"h":40},"confidence":0.8}')
    ).toThrow(/gemini_api_parse_error/);
  });
});

describe("GeminiApiBackendReal", () => {
  beforeEach(() => {
    eventLog.clear();
  });

  it("sends model + image + text + system instruction in request", async () => {
    const captured: { params?: GeminiGenerateParams } = {};
    const client = makeClient(async (params) => {
      captured.params = params;
      return respond('{"bbox":{"x":5,"y":5,"w":10,"h":10},"confidence":0.9,"trace":"ok"}');
    });
    const backend = new GeminiApiBackendReal({
      client,
      silentUsage: true,
      model: "gemini-2.5-flash",
    });
    await backend.resolve({
      description: "submit button",
      frame: tinyPng,
      frameDims,
    });
    expect(captured.params?.model).toBe("gemini-2.5-flash");
    expect(captured.params?.config?.systemInstruction).toContain("bounding-box");
    expect(captured.params?.config?.maxOutputTokens).toBeGreaterThan(0);
    const parts = captured.params?.contents?.[0]?.parts ?? [];
    expect(parts.some((p) => "inlineData" in p && p.inlineData.mimeType === "image/png")).toBe(true);
    expect(parts.some((p) => "text" in p && p.text.includes("submit button"))).toBe(true);
  });

  it("clamps bbox to frame + returns structured resolution", async () => {
    const client = makeClient(async () =>
      respond('{"bbox":{"x":1000,"y":1000,"w":500,"h":500},"confidence":0.9,"trace":"clamped"}')
    );
    const backend = new GeminiApiBackendReal({ client, silentUsage: true });
    const res = await backend.resolve({
      description: "x",
      frame: tinyPng,
      frameDims,
    });
    expect(res.bbox.x).toBeLessThan(frameDims.w);
    expect(res.bbox.y).toBeLessThan(frameDims.h);
    expect(res.bbox.x + res.bbox.w).toBeLessThanOrEqual(frameDims.w);
    expect(res.bbox.y + res.bbox.h).toBeLessThanOrEqual(frameDims.h);
  });

  it("caches on (content_hash, description_hash) — second call skips the client", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      return respond('{"bbox":{"x":10,"y":10,"w":20,"h":20},"confidence":0.9,"trace":"ok"}');
    });
    const backend = new GeminiApiBackendReal({ client, silentUsage: true });
    await backend.resolve({ description: "btn", frame: tinyPng, frameDims });
    const res2 = await backend.resolve({ description: "btn", frame: tinyPng, frameDims });
    expect(calls).toBe(1);
    expect(res2.trace).toMatch(/^cached\(/);
    expect(backend.cacheSize()).toBe(1);
  });

  it("cache honors TTL — expired entries trigger a fresh call", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      return respond('{"bbox":{"x":1,"y":1,"w":2,"h":2},"confidence":0.9,"trace":"ok"}');
    });
    const backend = new GeminiApiBackendReal({ client, silentUsage: true, cacheTtlMs: 1 });
    await backend.resolve({ description: "btn", frame: tinyPng, frameDims });
    await new Promise((r) => setTimeout(r, 5));
    await backend.resolve({ description: "btn", frame: tinyPng, frameDims });
    expect(calls).toBe(2);
  });

  it("emits a usage event on non-cache-hit calls with cost + tokens", async () => {
    const client = makeClient(async () =>
      respond(
        '{"bbox":{"x":1,"y":1,"w":2,"h":2},"confidence":0.9,"trace":"ok"}',
        { promptTokenCount: 200, candidatesTokenCount: 40 }
      )
    );
    const backend = new GeminiApiBackendReal({ client, model: "gemini-2.5-flash" });
    await backend.resolve({ description: "btn", frame: tinyPng, frameDims });
    const events = eventLog.query({ kinds: ["usage"] });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect((ev as { metric?: string }).metric).toBe("vision_inference");
    const detail = (ev as { detail?: Record<string, unknown> }).detail;
    expect(detail).toBeDefined();
    expect(detail).toMatchObject({
      backend: "gemini_api",
      model: "gemini-2.5-flash",
      input_tokens: 200,
      output_tokens: 40,
    });
    expect(detail?.["cost_usd"]).toBeGreaterThan(0);
  });

  it("skips usage event on cached resolution", async () => {
    const client = makeClient(async () =>
      respond('{"bbox":{"x":1,"y":1,"w":2,"h":2},"confidence":0.9,"trace":"ok"}')
    );
    const backend = new GeminiApiBackendReal({ client });
    await backend.resolve({ description: "btn", frame: tinyPng, frameDims });
    eventLog.clear();
    await backend.resolve({ description: "btn", frame: tinyPng, frameDims });
    expect(eventLog.query({ kinds: ["usage"] })).toHaveLength(0);
  });

  it("raises gemini_api_low_confidence when below threshold", async () => {
    const client = makeClient(async () =>
      respond('{"bbox":{"x":1,"y":1,"w":2,"h":2},"confidence":0.1,"trace":"weak"}')
    );
    const backend = new GeminiApiBackendReal({ client, silentUsage: true, minConfidence: 0.3 });
    await expect(
      backend.resolve({ description: "btn", frame: tinyPng, frameDims })
    ).rejects.toThrow(/gemini_api_low_confidence/);
  });

  it("raises gemini_api_empty_response when no text content", async () => {
    const client = makeClient(async () => ({
      candidates: [{ content: { role: "model", parts: [] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 },
    }));
    const backend = new GeminiApiBackendReal({ client, silentUsage: true });
    await expect(
      backend.resolve({ description: "btn", frame: tinyPng, frameDims })
    ).rejects.toThrow(/gemini_api_empty_response/);
  });

  it("wraps SDK thrown errors in gemini_api_network_error", async () => {
    const client: GeminiLike = {
      models: {
        async generateContent(): Promise<GeminiGenerateResponse> {
          throw new Error("oops");
        },
      },
    };
    const backend = new GeminiApiBackendReal({ client, silentUsage: true });
    await expect(
      backend.resolve({ description: "btn", frame: tinyPng, frameDims })
    ).rejects.toThrow(/gemini_api_network_error/);
  });

  it("pre-aborted signal short-circuits without calling the client", async () => {
    let called = 0;
    const client: GeminiLike = {
      models: {
        async generateContent(): Promise<GeminiGenerateResponse> {
          called++;
          throw new Error("should not be called");
        },
      },
    };
    const backend = new GeminiApiBackendReal({ client, silentUsage: true });
    const controller = new AbortController();
    controller.abort(new Error("pre"));
    await expect(
      backend.resolve({
        description: "x",
        frame: tinyPng,
        frameDims,
        signal: controller.signal,
      })
    ).rejects.toThrow(/gemini_api_aborted/);
    expect(called).toBe(0);
  });

  it("forwards abortSignal to client request config", async () => {
    const captured: { params?: GeminiGenerateParams } = {};
    const client = makeClient(async (params) => {
      captured.params = params;
      return respond('{"bbox":{"x":1,"y":1,"w":2,"h":2},"confidence":0.9,"trace":"ok"}');
    });
    const backend = new GeminiApiBackendReal({ client, silentUsage: true });
    const controller = new AbortController();
    await backend.resolve({
      description: "btn",
      frame: tinyPng,
      frameDims,
      signal: controller.signal,
    });
    expect(captured.params?.config?.abortSignal).toBe(controller.signal);
  });

  it("mid-call abort surfaces gemini_api_aborted (not network_error)", async () => {
    const client: GeminiLike = {
      models: {
        async generateContent(params: GeminiGenerateParams): Promise<GeminiGenerateResponse> {
          return new Promise<GeminiGenerateResponse>((resolve, reject) => {
            const t = setTimeout(() => {
              resolve(respond('{"bbox":{"x":1,"y":1,"w":2,"h":2},"confidence":0.9,"trace":"ok"}'));
            }, 50);
            params.config?.abortSignal?.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                reject(new Error("aborted"));
              },
              { once: true }
            );
          });
        },
      },
    };
    const backend = new GeminiApiBackendReal({ client, silentUsage: true });
    const controller = new AbortController();
    const p = backend.resolve({
      description: "btn",
      frame: tinyPng,
      frameDims,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort(new Error("cancelled"));
    await expect(p).rejects.toThrow(/gemini_api_aborted/);
  });
});

describe("GEMINI_PRICING_USD_PER_MILLION", () => {
  it("has entries for all supported flagship models", () => {
    const required = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
    for (const m of required) {
      expect(GEMINI_PRICING_USD_PER_MILLION[m]).toBeDefined();
    }
  });
});
