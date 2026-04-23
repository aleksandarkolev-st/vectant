import { beforeEach, describe, expect, it } from "vitest";
import { escapeHatchQueue, MAX_PENDING } from "../../src/escape_hatch/queue.js";
import { requestHumanTool } from "../../src/tools/request_human.js";
import { annotateAndAskTool } from "../../src/tools/annotate_and_ask.js";
import { answerEscapeHatchTool } from "../../src/tools/answer_escape_hatch.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";

function installFakeAttached(): void {
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fake",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 800, height: 600 },
  };
}

describe("escape-hatch queue primitive", () => {
  beforeEach(() => {
    escapeHatchQueue._resetForTests();
  });

  it("enqueue returns a pending id and resolves on answer", async () => {
    const enq = escapeHatchQueue.enqueue({
      kind: "request_human",
      question: "is this ok?",
      timeoutMs: 1000,
      source_tool: "synthi_request_human",
    });
    expect("pending_id" in enq).toBe(true);
    if (!("pending_id" in enq)) return;

    const answerFn = new Promise<unknown>((resolve) => {
      enq.promise.then((out) => resolve(out));
    });
    const matched = escapeHatchQueue.resolve(enq.pending_id, { ok: true });
    expect(matched).toBe(true);
    const outcome = (await answerFn) as { status: string; answer: { ok: boolean } };
    expect(outcome.status).toBe("answered");
    expect(outcome.answer).toEqual({ ok: true });
  });

  it("times out deterministically", async () => {
    const enq = escapeHatchQueue.enqueue({
      kind: "request_human",
      question: "?",
      timeoutMs: 1000,
      source_tool: "synthi_request_human",
    });
    if (!("pending_id" in enq)) throw new Error("unexpected full");
    const outcome = await enq.promise;
    expect(outcome.status).toBe("timeout");
  });

  it("refuses over-cap enqueues", () => {
    for (let i = 0; i < MAX_PENDING; i++) {
      const ok = escapeHatchQueue.enqueue({
        kind: "request_human",
        question: `q${i}`,
        timeoutMs: 60_000,
        source_tool: "synthi_request_human",
      });
      expect("pending_id" in ok).toBe(true);
    }
    const over = escapeHatchQueue.enqueue({
      kind: "request_human",
      question: "over",
      timeoutMs: 60_000,
      source_tool: "synthi_request_human",
    });
    expect("error" in over).toBe(true);
    if ("error" in over) expect(over.error).toBe("escape_hatch_queue_full");
  });

  it("cancelAll resolves pending with canceled status", async () => {
    const enq = escapeHatchQueue.enqueue({
      kind: "request_human",
      question: "?",
      timeoutMs: 60_000,
      source_tool: "synthi_request_human",
    });
    if (!("pending_id" in enq)) throw new Error("unexpected full");
    escapeHatchQueue.cancelAll("unit_test");
    const outcome = await enq.promise;
    expect(outcome.status).toBe("canceled");
    if (outcome.status === "canceled") expect(outcome.reason).toBe("unit_test");
  });
});

describe("synthi_request_human tool", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
    escapeHatchQueue._resetForTests();
  });

  it("returns not_attached when no session", async () => {
    const res = await requestHumanTool({ question: "hi", timeoutMs: 1000 });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("not_attached");
  });

  it("blocks on the queue and returns the operator's answer", async () => {
    installFakeAttached();
    const pending = requestHumanTool({ question: "continue?", timeoutMs: 5000 });

    // Pull the pending id from the queue (no races — enqueue is sync).
    await new Promise((r) => setTimeout(r, 5));
    const list = escapeHatchQueue.list();
    expect(list.length).toBe(1);
    const pendingId = list[0]!.pending_id;

    const ans = await answerEscapeHatchTool({
      pending_id: pendingId,
      answer: "yes",
      operator_id: "operator-1",
    });
    expect(ans.isError).toBeUndefined();
    const res = await pending;
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      status: string;
      answer: string;
      pending_id: string;
      operator_id?: string;
    };
    expect(body.status).toBe("answered");
    expect(body.answer).toBe("yes");
    expect(body.pending_id).toBe(pendingId);
    expect(body.operator_id).toBe("operator-1");
  });

  it("returns escape_hatch_timeout when nobody answers", async () => {
    installFakeAttached();
    const res = await requestHumanTool({ question: "?", timeoutMs: 1000 });
    expect(res.isError).toBe(true);
    const body = res.structuredContent as { error: string; timeout_ms: number };
    expect(body.error).toBe("escape_hatch_timeout");
    expect(body.timeout_ms).toBe(1000);
  });
});

describe("synthi_annotate_and_ask tool", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
    escapeHatchQueue._resetForTests();
  });

  it("requires a screenshot", async () => {
    installFakeAttached();
    const res = await annotateAndAskTool({ question: "where?", timeoutMs: 1000 });
    expect(res.isError).toBe(true);
    const body = res.structuredContent as { error: string; field: string };
    expect(body.error).toBe("invalid_args");
    expect(body.field).toBe("screenshot");
  });

  it("round-trips a click answer", async () => {
    installFakeAttached();
    const pending = annotateAndAskTool({
      question: "click the button",
      screenshot: "AAAA",
      timeoutMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 5));
    const list = escapeHatchQueue.list();
    expect(list.length).toBe(1);
    const pendingId = list[0]!.pending_id;
    await answerEscapeHatchTool({ pending_id: pendingId, answer: { x: 100, y: 200 } });
    const res = await pending;
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { answer: { x: number; y: number } };
    expect(body.answer).toEqual({ x: 100, y: 200 });
  });
});

describe("synthi_answer_escape_hatch tool", () => {
  beforeEach(() => {
    escapeHatchQueue._resetForTests();
  });

  it("cancels pending entries", async () => {
    const enq = escapeHatchQueue.enqueue({
      kind: "request_human",
      question: "?",
      timeoutMs: 60_000,
      source_tool: "synthi_request_human",
    });
    if (!("pending_id" in enq)) throw new Error("unexpected");
    const res = await answerEscapeHatchTool({
      pending_id: enq.pending_id,
      cancel: true,
      cancel_reason: "operator_timeout",
    });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { canceled: boolean; reason: string };
    expect(body.canceled).toBe(true);
    expect(body.reason).toBe("operator_timeout");
    const outcome = await enq.promise;
    expect(outcome.status).toBe("canceled");
  });

  it("returns escape_hatch_unknown_pending on unknown id", async () => {
    const res = await answerEscapeHatchTool({ pending_id: "pending_nope", answer: "x" });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("escape_hatch_unknown_pending");
  });
});
