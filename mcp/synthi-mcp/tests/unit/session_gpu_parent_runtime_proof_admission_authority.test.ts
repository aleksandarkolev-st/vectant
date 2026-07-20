import { beforeEach, describe, expect, it } from "vitest";
import {
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY,
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA,
} from "../../src/gpu_parent_runtime_proof_admission_authority.js";
import { session } from "../../src/session.js";

describe("SessionManager GPU parent proof admission authority", () => {
  beforeEach(() => {
    session._resetForTests();
  });

  it("retains one process-scoped public trust root across session resets", () => {
    const first = session.getGpuParentRuntimeProofAdmissionTrustMaterial();

    session._resetForTests();
    const second = session.getGpuParentRuntimeProofAdmissionTrustMaterial();

    expect(second).toBe(first);
    expect(second).toMatchObject({
      schemaVersion: GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA,
      proofAuthority:
        GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY,
      replayPolicyRequired: true,
      freshnessPolicyRequired: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(Object.isFrozen(second)).toBe(true);
    expect(second).not.toHaveProperty("privateKey");
    expect(second).not.toHaveProperty("signer");
    expect(Reflect.ownKeys(session))
      .not.toContain("gpuParentRuntimeProofAdmissionAuthority");
  });
});
