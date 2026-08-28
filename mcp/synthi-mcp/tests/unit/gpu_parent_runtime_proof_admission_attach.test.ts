import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY,
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA,
  GpuParentRuntimeProofAdmissionAuthority,
  type GpuParentRuntimeProofAdmissionTrustMaterial,
} from "../../src/gpu_parent_runtime_proof_admission_authority.js";
import { session } from "../../src/session.js";
import { attachTool } from "../../src/tools/attach.js";

const TRUST_MATERIAL_KEYS = [
  "schemaVersion",
  "proofAuthority",
  "verificationKey",
  "validationRunChallenge",
  "replayPolicyRequired",
  "freshnessPolicyRequired",
  "onlineReplayAuthority",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
] as const;

let fixtureAuthority: GpuParentRuntimeProofAdmissionAuthority | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  session._resetForTests();
  if (fixtureAuthority !== null) await fixtureAuthority.dispose();
  fixtureAuthority = null;
});

describe("synthi_attach GPU parent proof admission trust", () => {
  it("awaits and serializes exact public v3 online authority material", async () => {
    const sessionId = "opaque-session:attach-trust-01";
    const signalingUrl = "ws://127.0.0.1:9010";
    fixtureAuthority = new GpuParentRuntimeProofAdmissionAuthority();
    const trust = await fixtureAuthority.trustMaterial();
    vi.spyOn(session, "attach").mockResolvedValue({
      sessionId,
      signalingUrl,
      resolution: null,
    } as never);

    let resolveTrust: (
      value: GpuParentRuntimeProofAdmissionTrustMaterial,
    ) => void = () => {};
    const deferredTrust = new Promise<
      GpuParentRuntimeProofAdmissionTrustMaterial
    >((resolve) => {
      resolveTrust = resolve;
    });
    const trustGetter = vi.spyOn(
      session,
      "getGpuParentRuntimeProofAdmissionTrustMaterial",
    ).mockReturnValue(deferredTrust);

    let attachSettled = false;
    const responsePromise = attachTool(
      { sessionId, signalingUrl },
      { defaultSignalingUrl: signalingUrl },
    );
    void responsePromise.then(() => {
      attachSettled = true;
    });
    await vi.waitFor(() => {
      expect(trustGetter).toHaveBeenCalledTimes(1);
    });
    expect(attachSettled).toBe(false);

    resolveTrust(trust);
    const response = await responsePromise;
    const body = response.structuredContent as Record<string, unknown>;
    const responseTrust = body.gpu_parent_runtime_proof_admission_trust as
      GpuParentRuntimeProofAdmissionTrustMaterial;

    expect(response.isError).not.toBe(true);
    expect(responseTrust).toBe(trust);
    expect(Object.keys(responseTrust)).toEqual(TRUST_MATERIAL_KEYS);
    expect(responseTrust).toEqual({
      schemaVersion: GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA,
      proofAuthority:
        GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY,
      verificationKey: trust.verificationKey,
      validationRunChallenge: trust.validationRunChallenge,
      replayPolicyRequired: true,
      freshnessPolicyRequired: true,
      onlineReplayAuthority: trust.onlineReplayAuthority,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (textBlock === undefined || textBlock.type !== "text") {
      throw new Error("attach JSON text body unavailable");
    }
    const serializedBody = JSON.parse(textBlock.text) as Record<string, unknown>;
    const serializedTrust =
      serializedBody.gpu_parent_runtime_proof_admission_trust;
    expect(serializedTrust).toEqual(JSON.parse(JSON.stringify(trust)));
    expect(Object.keys(serializedTrust as object)).toEqual(TRUST_MATERIAL_KEYS);
    expect(serializedTrust).not.toBe(trust);

    const serializedPublicTrust = JSON.stringify(responseTrust);
    expect(serializedPublicTrust).not.toMatch(
      /replayState|authenticationKey|privateKey|private_key|secret|root/i,
    );
    expect(serializedPublicTrust).not.toMatch(/backend|project|maxOperations/);
    expect(responseTrust.onlineReplayAuthority).not.toHaveProperty(
      "acceptedForGpuHmr",
    );
    expect(responseTrust.onlineReplayAuthority).not.toHaveProperty(
      "gpuHmrSuccess",
    );
    expect(responseTrust.onlineReplayAuthority).not.toHaveProperty(
      "canSatisfyRuntimeProof",
    );
  });
});
