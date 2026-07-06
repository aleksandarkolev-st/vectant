import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { escapeHatchQueue } from "../../src/escape_hatch/queue.js";
import {
  resolveOperatorBridgeOptions,
  resolveOperatorBridgePort,
  startOperatorBridge,
} from "../../src/operator_bridge/server.js";

type Bridge = ReturnType<typeof startOperatorBridge>;
const TOKEN = "s3cret";
const AUTH_HEADERS = { "X-Synthi-Operator-Token": TOKEN };

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

  it("resolveOperatorBridgeOptions requires a non-empty token when enabled", () => {
    expect(resolveOperatorBridgeOptions({})).toBeUndefined();
    expect(() => resolveOperatorBridgeOptions({ SYNTHI_OPERATOR_BRIDGE_PORT: "9465" }))
      .toThrow("operator_bridge_token_required");
    expect(() => resolveOperatorBridgeOptions({
      SYNTHI_OPERATOR_BRIDGE_PORT: "9465",
      SYNTHI_OPERATOR_BRIDGE_TOKEN: "   ",
    })).toThrow("operator_bridge_token_required");
    expect(resolveOperatorBridgeOptions({
      SYNTHI_OPERATOR_BRIDGE_PORT: "9465",
      SYNTHI_OPERATOR_BRIDGE_HOST: "0.0.0.0",
      SYNTHI_OPERATOR_BRIDGE_TOKEN: " s3cret ",
    })).toEqual({ port: 9465, host: "0.0.0.0", token: "s3cret" });
  });

  it("healthz returns ok", async () => {
    bridge = startOperatorBridge({ port: 0, token: TOKEN });
    await bridge.ready;
    const res = await fetch(`${baseUrl(bridge)}/healthz`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
  });

  it("lists pending entries without screenshots", async () => {
    bridge = startOperatorBridge({ port: 0, token: TOKEN });
    await bridge.ready;
    const enq = escapeHatchQueue.enqueue({
      kind: "annotate_and_ask",
      question: "where is the button?",
      screenshot_base64: "aGVsbG8=", // "hello" → would be payload-heavy in a real flow
      timeoutMs: 60_000,
      source_tool: "synthi_annotate_and_ask",
    });
    if (!("pending_id" in enq)) throw new Error("enqueue rejected");

    const res = await fetch(`${baseUrl(bridge)}/escape-hatch/queue`, { headers: AUTH_HEADERS });
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
    bridge = startOperatorBridge({ port: 0, token: TOKEN });
    await bridge.ready;
    const enq = escapeHatchQueue.enqueue({
      kind: "annotate_and_ask",
      question: "click the cancel button",
      screenshot_base64: "aGVsbG8=",
      timeoutMs: 60_000,
      source_tool: "synthi_annotate_and_ask",
    });
    if (!("pending_id" in enq)) throw new Error("enqueue rejected");

    const res = await fetch(`${baseUrl(bridge)}/escape-hatch/queue/${enq.pending_id}`, {
      headers: AUTH_HEADERS,
    });
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
    bridge = startOperatorBridge({ port: 0, token: TOKEN });
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
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
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
    bridge = startOperatorBridge({ port: 0, token: TOKEN });
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
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
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
    bridge = startOperatorBridge({ port: 0, token: TOKEN });
    await bridge.ready;
    const getRes = await fetch(`${baseUrl(bridge)}/escape-hatch/queue/nope`, { headers: AUTH_HEADERS });
    expect(getRes.status).toBe(404);
    const postRes = await fetch(`${baseUrl(bridge)}/escape-hatch/answer`, {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ pending_id: "nope", answer: "x" }),
    });
    expect(postRes.status).toBe(404);
  });

  it("requires the configured token for every non-preflight bridge request", async () => {
    expect(() => startOperatorBridge({ port: 0, token: "" })).toThrow("operator_bridge_token_required");

    bridge = startOperatorBridge({ port: 0, token: TOKEN });
    await bridge.ready;
    const base = baseUrl(bridge);

    const queueNoHeader = await fetch(`${base}/escape-hatch/queue`);
    expect(queueNoHeader.status).toBe(401);

    const detailNoHeader = await fetch(`${base}/escape-hatch/queue/nope`);
    expect(detailNoHeader.status).toBe(401);

    const answerNoHeader = await fetch(`${base}/escape-hatch/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pending_id: "nope", answer: "x" }),
    });
    expect(answerNoHeader.status).toBe(401);

    const eventsNoHeader = await fetch(`${base}/escape-hatch/events`);
    expect(eventsNoHeader.status).toBe(401);

    const wrongHeader = await fetch(`${base}/escape-hatch/queue`, {
      headers: { "X-Synthi-Operator-Token": "wrong" },
    });
    expect(wrongHeader.status).toBe(401);

    const withHeader = await fetch(`${base}/escape-hatch/queue`, {
      headers: AUTH_HEADERS,
    });
    expect(withHeader.status).toBe(200);
  });

  it("answers CORS preflight", async () => {
    bridge = startOperatorBridge({ port: 0, token: TOKEN });
    await bridge.ready;
    const res = await fetch(`${baseUrl(bridge)}/escape-hatch/answer`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
