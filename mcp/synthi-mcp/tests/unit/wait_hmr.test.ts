import { beforeEach, describe, expect, it } from "vitest";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";
import { waitHmrTool } from "../../src/tools/wait_hmr.js";
import { resolvePipelineBudgetMs } from "../../src/protocol/index.js";

function installFakeAttached(
  waitForTerminal: () => Promise<{ status: "applied"; source: "hmr_status"; elapsedMs: number }>
): void {
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fixture",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 200, height: 200 },
    frames: {
      getFrame: async () => ({
        data: Buffer.alloc(0),
        width: 200,
        height: 200,
        ts: Date.now(),
        seq: 1,
      }),
      hasFrame: () => true,
      dimensions: () => ({ width: 200, height: 200 }),
    },
    channels: {
      hmr: {
        onMessage: () => () => {},
        waitForTerminal,
      },
    },
  };
}

describe("synthi_wait_hmr", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("reports frame_gate:disabled when no frame_advance has ever been seen", async () => {
    installFakeAttached(async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }));
    const res = await waitHmrTool({ timeoutMs: 500 });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { frame_gate: { status: string }; hmrElapsedMs: number };
    expect(body.hmrElapsedMs).toBe(10);
    expect(body.frame_gate.status).toBe("disabled");
  });

  it("waits for a post-budget frame advance before returning", async () => {
    installFakeAttached(async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }));
    session.setFrameAdvance(1, Date.now());
    const budget = resolvePipelineBudgetMs();
    setTimeout(() => session.setFrameAdvance(2, Date.now() + budget + 50), 10);
    const res = await waitHmrTool({ timeoutMs: 2_000 });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { frame_gate: { status: string; frame_seq: number } };
    expect(body.frame_gate.status).toBe("satisfied");
    expect(body.frame_gate.frame_seq).toBe(2);
  });

  it("reports frame_gate:timeout when no post-budget frame arrives", async () => {
    installFakeAttached(async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }));
    session.setFrameAdvance(1, Date.now());
    const res = await waitHmrTool({ timeoutMs: 50 });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { frame_gate: { status: string } };
    expect(body.frame_gate.status).toBe("timeout");
  });
});
