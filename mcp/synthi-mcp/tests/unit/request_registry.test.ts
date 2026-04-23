/**
 * Unit tests for the request registry + cancellation plumbing into the
 * claude_api vision backend. Covers ultraplan §Files `cancel.ts` +
 * §Testing `cancellation.test.ts`: "cancel mid-synthi_locate; assert
 * outbound Claude API call is aborted (no billing on cancelled request)."
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  RequestRegistry,
  requestRegistry,
} from "../../src/util/request_registry.js";
import { ClaudeApiBackendReal } from "../../src/locate/claude_api.js";
import type {
  AnthropicLike,
  AnthropicMessagesCreateParams,
  AnthropicMessagesResponse,
  AnthropicRequestOptions,
} from "../../src/locate/claude_api.js";

describe("RequestRegistry", () => {
  let reg: RequestRegistry;

  beforeEach(() => {
    reg = new RequestRegistry();
  });

  it("registers with a unique id + exposes signal/kind/startedAt", () => {
    const h1 = reg.register("synthi_locate");
    const h2 = reg.register("synthi_locate");
    expect(h1.id).not.toBe(h2.id);
    expect(h1.kind).toBe("synthi_locate");
    expect(typeof h1.startedAt).toBe("number");
    expect(h1.signal.aborted).toBe(false);
    expect(reg.size()).toBe(2);
  });

  it("unregister removes the slot + is safe to call twice", () => {
    const h = reg.register("synthi_locate");
    h.unregister();
    expect(reg.size()).toBe(0);
    expect(() => h.unregister()).not.toThrow();
  });

  it("cancel(id) aborts the derived signal + removes the entry", () => {
    const h = reg.register("synthi_locate");
    const cancelled = reg.cancel(h.id, new Error("user_aborted"));
    expect(cancelled).toBe(true);
    expect(h.signal.aborted).toBe(true);
    expect((h.signal.reason as Error).message).toBe("user_aborted");
    expect(reg.size()).toBe(0);
  });

  it("cancel of an unknown id returns false without side effects", () => {
    const h = reg.register("synthi_locate");
    const cancelled = reg.cancel("req_not_real");
    expect(cancelled).toBe(false);
    expect(h.signal.aborted).toBe(false);
  });

  it("upstream abort propagates to the derived signal", () => {
    const upstream = new AbortController();
    const h = reg.register("synthi_locate", upstream.signal);
    expect(h.signal.aborted).toBe(false);
    upstream.abort(new Error("upstream_cancelled"));
    expect(h.signal.aborted).toBe(true);
    expect((h.signal.reason as Error).message).toBe("upstream_cancelled");
  });

  it("pre-aborted upstream fires the derived signal at register time", () => {
    const upstream = new AbortController();
    upstream.abort(new Error("pre_aborted"));
    const h = reg.register("synthi_locate", upstream.signal);
    expect(h.signal.aborted).toBe(true);
  });

  it("cancelAll aborts every in-flight + returns the count", () => {
    const a = reg.register("a");
    const b = reg.register("b");
    const c = reg.register("c");
    const count = reg.cancelAll(new Error("shutdown"));
    expect(count).toBe(3);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(c.signal.aborted).toBe(true);
    expect(reg.size()).toBe(0);
  });

  it("active() exposes id/kind/startedAt/aborted for introspection", () => {
    const h = reg.register("synthi_locate");
    const snap = reg.active();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.id).toBe(h.id);
    expect(snap[0]?.kind).toBe("synthi_locate");
    expect(snap[0]?.aborted).toBe(false);
  });

  it("exported singleton survives module import", () => {
    // sanity: the shared instance is a RequestRegistry
    expect(requestRegistry).toBeInstanceOf(RequestRegistry);
  });
});

describe("ClaudeApiBackendReal cancellation", () => {
  const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const frameDims = { w: 640, h: 480 };

  function makeSlowClient(captured?: { opts?: AnthropicRequestOptions }): AnthropicLike {
    return {
      messages: {
        async create(
          _params: AnthropicMessagesCreateParams,
          options?: AnthropicRequestOptions
        ): Promise<AnthropicMessagesResponse> {
          if (captured) captured.opts = options;
          // Simulate a slow network call that respects the signal.
          return await new Promise<AnthropicMessagesResponse>((resolve, reject) => {
            const t = setTimeout(() => {
              resolve({
                content: [{ type: "text", text: '{"bbox":{"x":10,"y":10,"w":20,"h":20},"confidence":0.9,"trace":"ok"}' }],
                usage: { input_tokens: 100, output_tokens: 20 },
              });
            }, 50);
            options?.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            }, { once: true });
          });
        },
      },
    };
  }

  it("pre-aborted signal short-circuits without hitting the client", async () => {
    let called = 0;
    const client: AnthropicLike = {
      messages: {
        async create(): Promise<AnthropicMessagesResponse> {
          called++;
          throw new Error("should not be called");
        },
      },
    };
    const backend = new ClaudeApiBackendReal({ client, silentUsage: true });
    const controller = new AbortController();
    controller.abort(new Error("pre"));
    await expect(
      backend.resolve({
        description: "a button",
        frame: tinyPng,
        frameDims,
        signal: controller.signal,
      })
    ).rejects.toThrow(/claude_api_aborted/);
    expect(called).toBe(0);
  });

  it("forwards signal to client.messages.create options arg", async () => {
    const captured: { opts?: AnthropicRequestOptions } = {};
    const client = makeSlowClient(captured);
    const backend = new ClaudeApiBackendReal({ client, silentUsage: true });
    const controller = new AbortController();
    await backend.resolve({
      description: "a button",
      frame: tinyPng,
      frameDims,
      signal: controller.signal,
    });
    expect(captured.opts?.signal).toBe(controller.signal);
  });

  it("aborting mid-call surfaces claude_api_aborted (not network_error)", async () => {
    const client = makeSlowClient();
    const backend = new ClaudeApiBackendReal({ client, silentUsage: true });
    const controller = new AbortController();
    const promise = backend.resolve({
      description: "a button",
      frame: tinyPng,
      frameDims,
      signal: controller.signal,
    });
    // give the client's setTimeout a turn to register the abort listener
    await new Promise((r) => setTimeout(r, 5));
    controller.abort(new Error("mid"));
    await expect(promise).rejects.toThrow(/claude_api_aborted/);
  });

  it("successful call without signal still works (backward-compat)", async () => {
    const client = makeSlowClient();
    const backend = new ClaudeApiBackendReal({ client, silentUsage: true });
    const result = await backend.resolve({
      description: "a button",
      frame: tinyPng,
      frameDims,
    });
    expect(result.bbox).toEqual({ x: 10, y: 10, w: 20, h: 20 });
  });
});
