import { afterEach, describe, expect, it, vi } from "vitest";
import { session } from "../../src/session.js";
import { attachTool } from "../../src/tools/attach.js";

describe("synthi_attach GPU parent proof admission trust", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    session._resetForTests();
  });

  it("returns process-captured public trust material without signing authority", async () => {
    const sessionId = "opaque-session:attach-trust-01";
    const signalingUrl = "ws://127.0.0.1:9010";
    vi.spyOn(session, "attach").mockResolvedValue({
      sessionId,
      signalingUrl,
      resolution: null,
    } as never);
    const trust = session.getGpuParentRuntimeProofAdmissionTrustMaterial();

    const response = await attachTool(
      { sessionId, signalingUrl },
      { defaultSignalingUrl: signalingUrl },
    );
    const body = response.structuredContent as Record<string, unknown>;

    expect(response.isError).not.toBe(true);
    expect(body.gpu_parent_runtime_proof_admission_trust).toBe(trust);
    expect(body.gpu_parent_runtime_proof_admission_trust).toMatchObject({
      replayPolicyRequired: true,
      freshnessPolicyRequired: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/privateKey|private_key|signer/);
  });
});
