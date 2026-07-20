import { beforeEach, describe, expect, it } from "vitest";
import {
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY,
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA,
} from "../../src/gpu_parent_runtime_proof_admission_authority.js";
import { session } from "../../src/session.js";
import {
  createGpuHmrMcpAdmissionOnlineReplayAuthorityClient,
  gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection,
} from "../../scripts/lib/gpu-hmr-mcp-admission-online-replay-authority.mjs";

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

describe("SessionManager GPU parent proof admission authority", () => {
  beforeEach(() => {
    session._resetForTests();
  });

  it("caches one live process authority across normal session resets", async () => {
    const firstPromise =
      session.getGpuParentRuntimeProofAdmissionTrustMaterial();
    expect(session.getGpuParentRuntimeProofAdmissionTrustMaterial())
      .toBe(firstPromise);
    const first = await firstPromise;

    session._resetForTests();
    const secondPromise =
      session.getGpuParentRuntimeProofAdmissionTrustMaterial();
    expect(secondPromise).toBe(firstPromise);
    const second = await secondPromise;

    expect(second).toBe(first);
    expect(Object.keys(second)).toEqual(TRUST_MATERIAL_KEYS);
    expect(second).toEqual({
      schemaVersion: GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA,
      proofAuthority:
        GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY,
      verificationKey: second.verificationKey,
      validationRunChallenge: second.validationRunChallenge,
      replayPolicyRequired: true,
      freshnessPolicyRequired: true,
      onlineReplayAuthority: second.onlineReplayAuthority,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.onlineReplayAuthority)).toBe(true);
    expect(second.onlineReplayAuthority.parentPid).toBe(process.pid);
    expect(JSON.stringify(second)).not.toMatch(
      /replayState|authenticationKey|privateKey|private_key|secret|root/i,
    );
    expect(Reflect.ownKeys(session))
      .not.toContain("gpuParentRuntimeProofAdmissionAuthority");

    const client = createGpuHmrMcpAdmissionOnlineReplayAuthorityClient(
      second.onlineReplayAuthority,
    );
    const projection =
      gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection(client);
    if (projection === null) throw new Error("online replay client unavailable");
    await expect(projection.probe()).resolves.toMatchObject({
      authorityId: first.onlineReplayAuthority.authorityId,
      authorityGenerationId:
        first.onlineReplayAuthority.authorityGenerationId,
      responseKeyId:
        first.onlineReplayAuthority.responseVerificationKey.keyId,
      revision: "0",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
  });
});
