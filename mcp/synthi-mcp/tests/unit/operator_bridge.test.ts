import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { escapeHatchQueue } from "../../src/escape_hatch/queue.js";
import {
  resolveOperatorBridgePort,
  startOperatorBridge,
} from "../../src/operator_bridge/server.js";

type Bridge = ReturnType<typeof startOperatorBridge>;

function baseUrl(bridge: Bridge): string {
  const addr = bridge.server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

describe("operator bridge", () => {
  let bridge: Bridge | null = null;

  beforeEach(() => {
    escapeHatchQueue._resetForTests();
  });

  afterEach(async () => {
    if (bridge) {
      await bridge.close();
      bridge = null;
    }
  });

  it("resolveOperatorBridgePort validates env values", () => {
    expect(resolveOperatorBridgePort(undefined)).toBeUndefined();
    expect(resolveOperatorBridgePort("")).toBeUndefined();
    expect(resolveOperatorBridgePort("banana")).toBeUndefined();
    expect(resolveOperatorBridgePort("0")).toBeUndefined();
    expect(resolveOperatorBridgePort("70000")).toBeUndefined();
    expect(resolveOperatorBridgePort("9465")).toBe(9465);
    expect(resolveOperatorBridgePort("9465.9")).toBe(9465);
  });

  it("healthz returns ok", async () => {
    bridge = startOperatorBridge({ port: 0 });
    await bridge.ready;
    const res = await fetch(`${baseUrl(bridge)}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
  });

  it("lists pending entries without screenshots", async () => {
    bridge = startOperatorBridge({ port: 0 });
    await bridge.ready;
    const enq = escapeHatchQueue.enqueue({
      kind: "annotate_and_ask",
      question: "where is the button?",
      screenshot_base64: "aGVsbG8=", // "hello" → would be payload-heavy in a real flow
      timeoutMs: 60_000,
      source_tool: "synthi_annotate_and_ask",
    });
    if (!("pending_id" in enq)) throw new Error("enqueue rejected");

    const res = await fetch(`${baseUrl(bridge)}/escape-hatch/queue`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{
        pending_id: string;
        screenshot_base64?: string;
        screenshot_bytes?: number;
      }>;
      size: number;
    };
    expect(body.size).toBe(1);
    expect(body.entries[0]!.pending_id).toBe(enq.pending_id);
    expect(body.entries[0]!.screenshot_base64).toBeUndefined();
    expect(body.entries[0]!.screenshot_bytes).toBe(8);

    // clean up the dangling promise so vitest doesn't warn on open handles.
    escapeHatchQueue.cancel(enq.pending_id, "test_cleanup");
    await enq.promise;
  });

  it("returns full entry (with screenshot) at /queue/:id", async () => {
    bridge = startOperatorBridge({ port: 0 });
    await bridge.ready;
    const enq = escapeHatchQueue.enqueue({
      kind: "annotate_and_ask",
      question: "click the cancel button",
      screenshot_base64: "aGVsbG8=",
      timeoutMs: 60_000,
      source_tool: "synthi_annotate_and_ask",
    });
    if (!("pending_id" in enq)) throw new Error("enqueue rejected");

    const res = await fetch(`${baseUrl(bridge)}/escape-hatch/queue/${enq.pending_id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entry: { pending_id: string; screenshot_base64?: string };
    };
    expect(body.entry.pending_id).toBe(enq.pending_id);
    expect(body.entry.screenshot_base64).toBe("aGVsbG8=");

    escapeHatchQueue.cancel(enq.pending_id, "test_cleanup");
    await enq.promise;
  });

  it("resolves an answer via POST /escape-hatch/answer", async () => {
    bridge = startOperatorBridge({ port: 0 });
    await bridge.ready;
    const enq = escapeHatchQueue.enqueue({
      kind: "annotate_and_ask",
      question: "click cancel",
      screenshot_base64: "aGVsbG8=",
      timeoutMs: 60_000,
      source_tool: "synthi_annotate_and_ask",
    });
    if (!("pending_id" in enq)) throw new Error("enqueue rejected");

    const res = await fetch(`${baseUrl(bridge)}/escape-hatch/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pending_id: enq.pending_id,
        answer: { click_coords: { x: 42, y: 99 } },
        operator_id: "op-alice",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const outcome = await enq.promise;
    expect(outcome.status).toBe("answered");
    if (outcome.status === "answered") {
      expect(outcome.answer).toEqual({ click_coords: { x: 42, y: 99 } });
      expect(outcome.operator_id).toBe("op-alice");
    }
  });

  it("cancels via POST /escape-hatch/answer with cancel:true", async () => {
    bridge = startOperatorBridge({ port: 0 });
    await bridge.ready;
    const enq = escapeHatchQueue.enqueue({
      kind: "request_human",
      question: "is this ok?",
      timeoutMs: 60_000,
      source_tool: "synthi_request_human",
    });
    if (!("pending_id" in enq)) throw new Error("enqueue rejected");

    const res = await fetch(`${baseUrl(bridge)}/escape-hatch/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pending_id: enq.pending_id,
        cancel: true,
        cancel_reason: "operator_decided_not_to_answer",
      }),
    });
    expect(res.status).toBe(200);
    const outcome = await enq.promise;
    expect(outcome.status).toBe("canceled");
  });

  it("returns 404 for unknown pending_id on GET + POST", async () => {
    bridge = startOperatorBridge({ port: 0 });
    await bridge.ready;
    const getRes = await fetch(`${baseUrl(bridge)}/escape-hatch/queue/nope`);
    expect(getRes.status).toBe(404);
    const postRes = await fetch(`${baseUrl(bridge)}/escape-hatch/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pending_id: "nope", answer: "x" }),
    });
    expect(postRes.status).toBe(404);
  });

  it("rejects requests missing a configured token", async () => {
    bridge = startOperatorBridge({ port: 0, token: "s3cret" });
    await bridge.ready;
    const noHeader = await fetch(`${baseUrl(bridge)}/escape-hatch/queue`);
    expect(noHeader.status).toBe(401);

    const withHeader = await fetch(`${baseUrl(bridge)}/escape-hatch/queue`, {
      headers: { "X-Synthi-Operator-Token": "s3cret" },
    });
    expect(withHeader.status).toBe(200);
  });

  it("answers CORS preflight", async () => {
    bridge = startOperatorBridge({ port: 0 });
    await bridge.ready;
    const res = await fetch(`${baseUrl(bridge)}/escape-hatch/answer`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
