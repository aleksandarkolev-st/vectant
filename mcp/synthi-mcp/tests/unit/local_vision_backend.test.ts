import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalVisionBackend,
  parseLocalResponse,
  selectBackend,
} from "../../src/locate/index.js";

describe("parseLocalResponse", () => {
  it("parses a well-formed response", () => {
    const r = parseLocalResponse({
      bbox: { x: 10, y: 20, w: 100, h: 50 },
      confidence: 0.87,
      trace: "model_v1",
    });
    expect("bbox" in r).toBe(true);
    if ("bbox" in r) {
      expect(r.bbox.w).toBe(100);
      expect(r.confidence).toBe(0.87);
      expect(r.trace).toBe("model_v1");
    }
  });

  it("clamps confidence to [0,1]", () => {
    const r = parseLocalResponse({
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      confidence: 5,
    });
    if ("bbox" in r) expect(r.confidence).toBe(1);
  });

  it("rejects a missing bbox", () => {
    const r = parseLocalResponse({ confidence: 0.5 });
    expect("error" in r).toBe(true);
  });

  it("rejects a non-positive bbox", () => {
    const r = parseLocalResponse({ bbox: { x: 0, y: 0, w: 0, h: 1 } });
    expect("error" in r).toBe(true);
  });
});

describe("LocalVisionBackend", () => {
  const originalUrl = process.env["SYNTHI_LOCAL_VISION_URL"];
  afterEach(() => {
    if (originalUrl === undefined) delete process.env["SYNTHI_LOCAL_VISION_URL"];
    else process.env["SYNTHI_LOCAL_VISION_URL"] = originalUrl;
  });

  it("short-circuits on hints.prefer_region without an HTTP call", async () => {
    let calls = 0;
    const backend = new LocalVisionBackend({
      endpointUrl: "http://localhost:65535/should-not-call",
      fetchImpl: (async () => {
        calls++;
        throw new Error("should_not_be_called");
      }) as unknown as typeof fetch,
    });
    const res = await backend.resolve({
      description: "the thing",
      frame: Buffer.from("x"),
      frameDims: { w: 100, h: 100 },
      hints: { prefer_region: { x: 5, y: 5, w: 10, h: 10 } },
    });
    expect(calls).toBe(0);
    expect(res.bbox).toEqual({ x: 5, y: 5, w: 10, h: 10 });
  });

  it("throws local_vision_backend_not_configured when env is missing", async () => {
    delete process.env["SYNTHI_LOCAL_VISION_URL"];
    const backend = new LocalVisionBackend();
    await expect(
      backend.resolve({
        description: "foo",
        frame: Buffer.from("x"),
        frameDims: { w: 10, h: 10 },
      })
    ).rejects.toThrow(/local_vision_backend_not_configured/);
  });

  it("POSTs to the endpoint and maps the bbox back", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const stubFetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body as string | undefined;
      calls.push({ url, body: body ? JSON.parse(body) : null });
      return new Response(
        JSON.stringify({
          bbox: { x: 42, y: 7, w: 100, h: 30 },
          confidence: 0.92,
          trace: "stub_model",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    const backend = new LocalVisionBackend({
      endpointUrl: "http://stub/local",
      fetchImpl: stubFetch,
    });
    const res = await backend.resolve({
      description: "the blue button",
      frame: Buffer.from("pixels"),
      frameDims: { w: 800, h: 600 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://stub/local");
    expect(res.bbox).toEqual({ x: 42, y: 7, w: 100, h: 30 });
    expect(res.confidence).toBe(0.92);
  });

  it("propagates non-2xx responses as local_vision_backend_error", async () => {
    const stubFetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const backend = new LocalVisionBackend({
      endpointUrl: "http://stub/local",
      fetchImpl: stubFetch,
    });
    await expect(
      backend.resolve({
        description: "x",
        frame: Buffer.from(""),
        frameDims: { w: 10, h: 10 },
      })
    ).rejects.toThrow(/local_vision_backend_error/);
  });
});

describe("selectBackend wiring", () => {
  const originalEnv = process.env["SYNTHI_VISION_BACKEND"];
  afterEach(() => {
    if (originalEnv === undefined) delete process.env["SYNTHI_VISION_BACKEND"];
    else process.env["SYNTHI_VISION_BACKEND"] = originalEnv;
  });

  it("selects LocalVisionBackend when override='local'", () => {
    const backend = selectBackend("local");
    expect(backend.name).toBe("local");
  });

  it("honours SYNTHI_VISION_BACKEND=local from env", () => {
    process.env["SYNTHI_VISION_BACKEND"] = "local";
    const backend = selectBackend();
    expect(backend.name).toBe("local");
  });
});
