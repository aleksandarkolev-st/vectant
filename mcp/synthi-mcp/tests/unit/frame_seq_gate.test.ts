import { beforeEach, describe, expect, it } from "vitest";
import { session, FRAME_ADVANCE_FRESHNESS_WINDOW_MS } from "../../src/session.js";
import { eventLog } from "../../src/events/index.js";
import { runWait } from "../../src/wait/engine.js";
import { buildManifest, resolvePipelineBudgetMs } from "../../src/protocol/index.js";

function installFakeAttached(): {
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
    frames: {
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

describe("wait({condition:\"hmr\"}) frame_gate evidence", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("reports frame_gate:disabled when no frame_advance has ever been seen", async () => {
    installFakeAttached();
    const outcome = await runWait({ condition: "hmr" }, 500);
    expect(outcome.status).toBe("resolved");
    const evidence = (outcome as { evidence: { frame_gate: { status: string } } }).evidence;
    expect(evidence.frame_gate.status).toBe("disabled");
  });

  it("reports frame_gate:satisfied when a post-budget advance arrives", async () => {
    installFakeAttached();
    session.setFrameAdvance(1, Date.now()); // mark gate enabled
    const budget = resolvePipelineBudgetMs();
    // Arrange a late advance that satisfies the budget.
    setTimeout(() => session.setFrameAdvance(2, Date.now() + budget + 50), 10);
    const outcome = await runWait({ condition: "hmr" }, 2_000);
    const evidence = (outcome as { evidence: { frame_gate: { status: string; frame_seq: number } } }).evidence;
    expect(evidence.frame_gate.status).toBe("satisfied");
    expect(evidence.frame_gate.frame_seq).toBe(2);
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
