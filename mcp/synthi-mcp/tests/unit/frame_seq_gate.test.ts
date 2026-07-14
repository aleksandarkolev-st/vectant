import { beforeEach, describe, expect, it } from "vitest";
import { session, FRAME_ADVANCE_FRESHNESS_WINDOW_MS } from "../../src/session.js";
import { eventLog } from "../../src/events/index.js";
import { runWait } from "../../src/wait/engine.js";
import { buildManifest, resolvePipelineBudgetMs } from "../../src/protocol/index.js";

function installFakeAttached(frames?: {
  getFrame: () => Promise<{ data: Buffer; width: number; height: number; ts: number; seq: number }>;
  hasFrame?: () => boolean;
  dimensions?: () => { width: number; height: number };
}): {
  feedHmr: (msg: Record<string, unknown>) => void;
} {
  const listeners: Array<(msg: Record<string, unknown>) => void> = [];
  const hmr = {
    onMessage(cb: (msg: Record<string, unknown>) => void): () => void {
      listeners.push(cb);
      return () => {};
    },
    waitForTerminal: async () => ({ status: "applied" as const, source: "hmr_status" as const, elapsedMs: 10 }),
  };
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fixture",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 200, height: 200 },
    frames: frames ?? {
      getFrame: async () => ({ data: Buffer.alloc(0), width: 200, height: 200, ts: Date.now(), seq: 1 }),
      hasFrame: () => true,
      dimensions: () => ({ width: 200, height: 200 }),
    },
    channels: { hmr },
  };
  return {
    feedHmr: (msg: Record<string, unknown>) => {
      for (const l of listeners) l(msg);
    },
  };
}

describe("session frame-advance tracker", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("starts with no frame advance and gate disabled", () => {
    expect(session.getFrameAdvance()).toBeNull();
    expect(session.frameSeqGateEnabled()).toBe(false);
  });

  it("setFrameAdvance records and enables the gate", () => {
    const before = Date.now();
    session.setFrameAdvance(42, 1_000_000);
    const fa = session.getFrameAdvance();
    expect(fa).not.toBeNull();
    expect(fa?.frame_seq).toBe(42);
    expect(fa?.ts_ms).toBe(1_000_000);
    expect(fa?.observed_at).toBeGreaterThanOrEqual(before);
    expect(session.frameSeqGateEnabled()).toBe(true);
  });

  it("gate expires after the freshness window", () => {
    session.setFrameAdvance(1, 1_000, Date.now() - FRAME_ADVANCE_FRESHNESS_WINDOW_MS - 10);
    expect(session.frameSeqGateEnabled()).toBe(false);
  });

  it("awaitFrameAdvanceAtOrAfter returns immediately when latest satisfies", async () => {
    session.setFrameAdvance(1, 5_000);
    const r = await session.awaitFrameAdvanceAtOrAfter(4_000, 100);
    expect(r?.ts_ms).toBe(5_000);
  });

  it("awaitFrameAdvanceAtOrAfter resolves when a later advance arrives", async () => {
    session.setFrameAdvance(1, 1_000);
    const p = session.awaitFrameAdvanceAtOrAfter(2_000, 500);
    setTimeout(() => session.setFrameAdvance(2, 2_500), 20);
    const r = await p;
    expect(r?.frame_seq).toBe(2);
  });

  it("awaitFrameAdvanceAtOrAfter returns null on timeout", async () => {
    session.setFrameAdvance(1, 1_000);
    const r = await session.awaitFrameAdvanceAtOrAfter(2_000, 40);
    expect(r).toBeNull();
  });

  it("awaitFrameAdvanceAtOrAfter returns null when the gate is disabled", async () => {
    expect(session.frameSeqGateEnabled()).toBe(false);
    const r = await session.awaitFrameAdvanceAtOrAfter(1_000, 40);
    expect(r).toBeNull();
  });
});

describe("session frame gate tokens", () => {
  beforeEach(() => {
    session._resetForTests();
  });

  it("stores an immutable issuer-owned evidence binding and returns it on consume", () => {
    const sourceBinding: Record<string, unknown> = {
      schema_version: "test.evidence_binding.v1",
      observation: {
        event_id: "event-1",
        labels: ["initial"],
      },
    };
    const issued = session.issueFrameGateToken({
      session_id: "fixture",
      frame_seq: 7,
      ts_ms: 1_500,
      evidence_binding: sourceBinding,
      now: 1_000,
      ttl_ms: 1_000,
    });

    const sourceObservation = sourceBinding["observation"] as {
      event_id: string;
      labels: string[];
    };
    sourceObservation.event_id = "source-mutated";
    sourceObservation.labels.push("source-mutated");

    const issuedObservation = issued.evidence_binding?.["observation"] as Record<string, unknown>;
    expect(Object.isFrozen(issued.evidence_binding)).toBe(true);
    expect(Object.isFrozen(issuedObservation)).toBe(true);
    expect(Reflect.set(issuedObservation, "event_id", "issued-token-mutated")).toBe(false);

    const validation = session.consumeFrameGateToken({
      token: issued.token,
      session_id: "fixture",
      frame_seq: 7,
      ts_ms: 1_500,
      now: 1_001,
    });
    const expectedBinding = {
      schema_version: "test.evidence_binding.v1",
      observation: {
        event_id: "event-1",
        labels: ["initial"],
      },
    };
    expect(validation.accepted).toBe(true);
    expect(validation.evidence_binding).toEqual(expectedBinding);
    expect(validation.token?.evidence_binding).toEqual(expectedBinding);
    expect(validation.evidence_binding_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(validation.token?.evidence_binding_hash).toBe(validation.evidence_binding_hash);
  });

  it("hashes evidence bindings canonically regardless of object key order", () => {
    const first = session.issueFrameGateToken({
      session_id: "fixture",
      evidence_binding: { outer: { z: 2, a: 1 }, enabled: true },
    });
    const second = session.issueFrameGateToken({
      session_id: "fixture",
      evidence_binding: { enabled: true, outer: { a: 1, z: 2 } },
    });

    expect(first.evidence_binding_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.evidence_binding_hash).toBe(first.evidence_binding_hash);
  });

  it("rejects lossy, non-plain, unsafe, and cyclic evidence bindings", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const sparseArray: unknown[] = [];
    sparseArray.length = 1;
    const extraPropertyArray = ["entry"] as unknown[] & { extra?: string };
    extraPropertyArray.extra = "not-json";
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, 0, {
      enumerable: true,
      get: () => {
        throw new Error("array accessor must not execute");
      },
    });
    const nonEnumerable: Record<string, unknown> = {};
    Object.defineProperty(nonEnumerable, "hidden", { value: "not-json" });
    const invalidBindings: Array<Record<string, unknown>> = [
      { omitted: undefined },
      { non_finite: Number.NaN },
      { callable: (() => true) as unknown },
      { date: new Date(0) },
      { constructor: "unsafe" },
      { sparse: sparseArray },
      { extra_array_property: extraPropertyArray },
      { accessor_array: accessorArray },
      { non_enumerable: nonEnumerable },
      cyclic,
    ];

    for (const evidenceBinding of invalidBindings) {
      expect(() => session.issueFrameGateToken({
        session_id: "fixture",
        evidence_binding: evidenceBinding,
      })).toThrow(TypeError);
    }
  });

  it("preserves legacy tokens and enforces session, frame, timestamp, and one-time use", () => {
    const issued = session.issueFrameGateToken({
      session_id: "fixture",
      frame_seq: 9,
      ts_ms: 2_000,
      now: 1_000,
      ttl_ms: 1_000,
    });
    expect(issued.evidence_binding).toBeUndefined();
    expect(issued.evidence_binding_hash).toBeUndefined();

    expect(session.consumeFrameGateToken({
      token: issued.token,
      session_id: "other-session",
      frame_seq: 9,
      ts_ms: 2_000,
      now: 1_001,
    })).toEqual({ accepted: false, reason: "frame_gate_token_session_mismatch" });
    expect(session.consumeFrameGateToken({
      token: issued.token,
      session_id: "fixture",
      frame_seq: 8,
      ts_ms: 2_000,
      now: 1_002,
    })).toEqual({ accepted: false, reason: "frame_gate_token_frame_seq_mismatch" });
    expect(session.consumeFrameGateToken({
      token: issued.token,
      session_id: "fixture",
      frame_seq: 9,
      ts_ms: 1_999,
      now: 1_003,
    })).toEqual({ accepted: false, reason: "frame_gate_token_timestamp_mismatch" });

    const accepted = session.consumeFrameGateToken({
      token: issued.token,
      session_id: "fixture",
      frame_seq: 9,
      ts_ms: 2_000,
      now: 1_004,
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.token?.evidence_binding).toBeUndefined();
    expect(accepted.evidence_binding).toBeUndefined();
    expect(session.consumeFrameGateToken({
      token: issued.token,
      session_id: "fixture",
      frame_seq: 9,
      ts_ms: 2_000,
      now: 1_005,
    })).toEqual({ accepted: false, reason: "frame_gate_token_unknown" });
  });
});

describe("wait({condition:\"hmr\"}) frame_gate evidence", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("uses decoded-frame gate evidence when no frame_advance has ever been seen", async () => {
    installFakeAttached();
    const outcome = await runWait({ condition: "hmr" }, 500);
    expect(outcome.status).toBe("resolved");
    const evidence = (outcome as {
      evidence: {
        frame_gate: {
          status: string;
          session_id?: string;
          gate_token?: string;
          capture_binding_source?: string;
          frame_advance_fallback_used?: boolean;
        };
      };
    }).evidence;
    expect(evidence.frame_gate.status).toBe("satisfied");
    expect(evidence.frame_gate.session_id).toBe("fixture");
    expect(evidence.frame_gate.gate_token).toMatch(/^frame-gate:/);
    expect(evidence.frame_gate.capture_binding_source).toBe("decoded_frame");
    expect(evidence.frame_gate.frame_advance_fallback_used).toBe(true);
  });

  it("times out when decoded frames stay before the post-budget gate", async () => {
    installFakeAttached({
      getFrame: async () => ({ data: Buffer.alloc(0), width: 200, height: 200, ts: 1, seq: 1 }),
      hasFrame: () => true,
      dimensions: () => ({ width: 200, height: 200 }),
    });
    const outcome = await runWait({ condition: "hmr" }, 50);
    expect(outcome.status).toBe("resolved");
    const evidence = (outcome as {
      evidence: { frame_gate: { status: string; reason?: string } };
    }).evidence;
    expect(evidence.frame_gate.status).toBe("timeout");
    expect(evidence.frame_gate.reason).toBe("decoded_frame_gate_timeout");
  });

  it("reports frame_gate:satisfied when a post-budget advance arrives", async () => {
    installFakeAttached();
    session.setFrameAdvance(1, Date.now()); // mark gate enabled
    const budget = resolvePipelineBudgetMs();
    // Arrange a late advance that satisfies the budget.
    setTimeout(() => session.setFrameAdvance(2, Date.now() + budget + 50), 10);
    const outcome = await runWait({ condition: "hmr" }, 2_000);
    const evidence = (outcome as {
      evidence: {
        frame_gate: {
          status: string;
          frame_seq: number;
          session_id?: string;
          gate_token?: string;
          capture_binding_required?: boolean;
        };
      };
    }).evidence;
    expect(evidence.frame_gate.status).toBe("satisfied");
    expect(evidence.frame_gate.frame_seq).toBe(2);
    expect(evidence.frame_gate.session_id).toBe("fixture");
    expect(evidence.frame_gate.gate_token).toMatch(/^frame-gate:/);
    expect(evidence.frame_gate.capture_binding_required).toBe(true);
  });

  it("reports frame_gate:timeout when no post-budget advance lands in time", async () => {
    installFakeAttached();
    session.setFrameAdvance(1, Date.now()); // gate enabled but no follow-up
    const outcome = await runWait({ condition: "hmr" }, 200);
    const evidence = (outcome as { evidence: { frame_gate: { status: string } } }).evidence;
    expect(evidence.frame_gate.status).toBe("timeout");
  });
});

describe("manifest frame_seq_gate", () => {
  beforeEach(() => {
    session._resetForTests();
  });

  it("reports pipeline_budget_ms in every manifest (default 80)", () => {
    const m = buildManifest(["synthi_attach"]);
    expect(m.frame_seq_gate.pipeline_budget_ms).toBe(80);
  });

  it("honors SYNTHI_PIPELINE_BUDGET_MS env override", () => {
    const prev = process.env["SYNTHI_PIPELINE_BUDGET_MS"];
    process.env["SYNTHI_PIPELINE_BUDGET_MS"] = "150";
    try {
      const m = buildManifest(["synthi_attach"]);
      expect(m.frame_seq_gate.pipeline_budget_ms).toBe(150);
    } finally {
      if (prev === undefined) delete process.env["SYNTHI_PIPELINE_BUDGET_MS"];
      else process.env["SYNTHI_PIPELINE_BUDGET_MS"] = prev;
    }
  });

  it("runtime flag flips available true with correct reason", () => {
    const mOff = buildManifest(["synthi_attach"], { frame_seq_gate_enabled: false });
    expect(mOff.frame_seq_gate.available).toBe(false);
    expect(mOff.frame_seq_gate.reason).toBe("no_frame_advance_seen_yet");

    const mOn = buildManifest(["synthi_attach"], { frame_seq_gate_enabled: true });
    expect(mOn.frame_seq_gate.available).toBe(true);
    expect(mOn.frame_seq_gate.reason).toBe("frame_advance_observed");
  });

  it("invalid SYNTHI_PIPELINE_BUDGET_MS falls back to default", () => {
    const prev = process.env["SYNTHI_PIPELINE_BUDGET_MS"];
    process.env["SYNTHI_PIPELINE_BUDGET_MS"] = "nonsense";
    try {
      expect(resolvePipelineBudgetMs()).toBe(80);
    } finally {
      if (prev === undefined) delete process.env["SYNTHI_PIPELINE_BUDGET_MS"];
      else process.env["SYNTHI_PIPELINE_BUDGET_MS"] = prev;
    }
  });
});
