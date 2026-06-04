import { beforeEach, describe, expect, it } from "vitest";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";
import { waitHmrTool } from "../../src/tools/wait_hmr.js";
import { resolvePipelineBudgetMs } from "../../src/protocol/index.js";

function installFakeAttached(
  waitForTerminal: () => Promise<{ status: "applied"; source: "hmr_status"; elapsedMs: number }>
): { feedHmr: (msg: Record<string, unknown>) => void } {
  const listeners: Array<(msg: Record<string, unknown>) => void> = [];
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
        onMessage: (cb: (msg: Record<string, unknown>) => void) => {
          listeners.push(cb);
          return () => {
            const index = listeners.indexOf(cb);
            if (index >= 0) listeners.splice(index, 1);
          };
        },
        waitForTerminal,
      },
    },
  };
  return {
    feedHmr: (msg: Record<string, unknown>) => {
      for (const listener of [...listeners]) listener(msg);
    },
  };
}

describe("synthi_wait_hmr", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
    delete process.env["SYNTHI_MCP_HMR_POST_APPLY_OBSERVE_MS"];
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

  it("returns a post-apply runtime rejection instead of applied", async () => {
    process.env["SYNTHI_MCP_HMR_POST_APPLY_OBSERVE_MS"] = "100";
    const fake = installFakeAttached(async () => {
      fake.feedHmr({ status: "applied", module: "device", state_preserved: true });
      setTimeout(
        () =>
          fake.feedHmr({
            status: "rejected",
            module: "device",
            reason: "GPU kernel launch failed after sidecar reload",
            fallback: "Keep runtime running but mark GPU HMR degraded until the launch succeeds",
          }),
        10
      );
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500 });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      status: string;
      post_apply_terminal?: boolean;
      detail?: { reason?: string };
    };
    expect(body.status).toBe("rejected");
    expect(body.post_apply_terminal).toBe(true);
    expect(body.detail?.reason).toContain("GPU kernel launch failed");
  });

  it("returns a post-apply runtime rejection while waiting for frame evidence", async () => {
    session.setFrameAdvance(1, Date.now());
    const fake = installFakeAttached(async () => {
      fake.feedHmr({ status: "applied", module: "device", state_preserved: true });
      setTimeout(
        () =>
          fake.feedHmr({
            status: "rejected",
            module: "device",
            reason: "post-reload device dispatch rejected",
            fallback: "Keep runtime running but mark GPU HMR degraded until the launch succeeds",
          }),
        10
      );
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500 });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      status: string;
      post_apply_terminal?: boolean;
      detail?: { reason?: string };
    };
    expect(body.status).toBe("rejected");
    expect(body.post_apply_terminal).toBe(true);
    expect(body.detail?.reason).toContain("post-reload device dispatch rejected");
  });

  it("returns the latest GPU proof state with wait_hmr", async () => {
    const fake = installFakeAttached(async () => {
      fake.feedHmr({
        status: "gpu-proof-state",
        schemaVersion: "synthi.gpu.hmr.proof.v1",
        resultState: "gpu-hmr-symbol-bound",
        degradedState: "gpu-hmr-dispatch-unobserved",
        degradedReason: "runtime_dispatch_not_observed",
        label: "gpu-hmr-partial",
        proofId: "gpu-proof:abc",
        proofArtifactPath: ".synthi/gpu-hmr/proofs/gpu-proof_abc.json",
      });
      return { status: "applied", source: "hmr_status", elapsedMs: 10 };
    });

    const res = await waitHmrTool({ timeoutMs: 500 });

    expect(fake).toBeDefined();
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      gpu_proof?: { resultState?: string; degradedState?: string; proofId?: string };
    };
    expect(body.gpu_proof?.resultState).toBe("gpu-hmr-symbol-bound");
    expect(body.gpu_proof?.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(body.gpu_proof?.proofId).toBe("gpu-proof:abc");
  });

  it("fails wait_hmr when requested GPU proof is stronger than observed", async () => {
    installFakeAttached(async () => ({ status: "applied", source: "hmr_status", elapsedMs: 10 }));

    const res = await waitHmrTool({
      timeoutMs: 500,
      requireGpuFullRuntimeProof: true,
    });

    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      gpu_proof_validation?: { reason?: string };
    };
    expect(body.error).toBe("gpu_hmr_proof_insufficient");
    expect(body.gpu_proof_validation?.reason).toBe("proof_state_missing");
  });
});
