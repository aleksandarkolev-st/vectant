import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY,
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA,
  GpuParentRuntimeProofAdmissionAuthority,
} from "../../src/gpu_parent_runtime_proof_admission_authority.js";
import {
  verifyGpuParentRuntimeProofAdmissionReceipt,
  type GpuParentRuntimeProofAdmissionReceiptInput,
} from "../../src/gpu_parent_runtime_proof_admission_receipt.js";

const CHALLENGE = Buffer.alloc(32, 0x42).toString("base64url");

function hash(digit: string): string {
  return `sha256:${digit.repeat(64)}`;
}

function admissionInput(): GpuParentRuntimeProofAdmissionReceiptInput {
  const controlBindingCanonicalSha256 = hash("4");
  return {
    transportSessionId: "opaque-transport-session:authority-01",
    compileRequestNonce: `gpu-proof-transport-request:${"1".repeat(32)}`,
    computeExpectedOutputContractHash: hash("a"),
    computeExpectedOutputSemanticsHash: hash("b"),
    workerKeyId:
      `gpu-hmr-runtime-evidence-transport-key:sha256:${"2".repeat(64)}`,
    workerKeyAnnouncementId:
      `gpu-hmr-runtime-evidence-transport-key-announcement:sha256:${"3".repeat(64)}`,
    workerProcessId: "9123",
    controlBindingId:
      `gpu-parent-runtime-proof-control-binding:${controlBindingCanonicalSha256}`,
    controlBindingCanonicalSha256,
    controlTransportReceiptId:
      `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"5".repeat(64)}`,
    controlObservationContextHash: hash("6"),
    parentReceiptId:
      `gpu-parent-runtime-proof-receipt:sha256:${"7".repeat(64)}`,
    parentTransportReceiptId:
      `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"8".repeat(64)}`,
    parentCanonicalProofSha256: hash("9"),
    parentObservationContextHash: hash("0"),
    requestId: `gpu-reload:request:${"c".repeat(32)}`,
    sourceEditId: `source-edit:sha256:${"d".repeat(64)}`,
    artifactContentHash: hash("e"),
    fullRuntimeProofId: `gpu-runtime-proof:sha256:${"f".repeat(64)}`,
    proofLedgerId: `gpu-ledger-proof:sha256:${"1".repeat(64)}`,
    runnerProcessId: 8123,
    runnerRuntimeSessionId: "opaque-runtime-session:authority-02",
    runnerChallenge: "23456789abcdef0123456789abcdef01",
    commandEnvelopeSha256: hash("2"),
    protectedProofJsonSha256: hash("3"),
  };
}

describe("GpuParentRuntimeProofAdmissionAuthority", () => {
  it("creates independent process roots with frozen support-only trust material", () => {
    const first = new GpuParentRuntimeProofAdmissionAuthority();
    const second = new GpuParentRuntimeProofAdmissionAuthority();
    const firstMaterial = first.trustMaterial();
    const secondMaterial = second.trustMaterial();

    expect(firstMaterial).toMatchObject({
      schemaVersion: GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA,
      proofAuthority:
        GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY,
      replayPolicyRequired: true,
      freshnessPolicyRequired: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(firstMaterial.verificationKey.keyId)
      .not.toBe(secondMaterial.verificationKey.keyId);
    expect(firstMaterial.validationRunChallenge)
      .not.toBe(secondMaterial.validationRunChallenge);
    expect(firstMaterial.validationRunChallenge)
      .toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.isFrozen(firstMaterial)).toBe(true);
    expect(Object.isFrozen(firstMaterial.verificationKey)).toBe(true);
    expect(firstMaterial).not.toHaveProperty("privateKey");
    expect(firstMaterial).not.toHaveProperty("signer");
  });

  it("binds deterministic live trust material to signed admission receipts", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const authority = new GpuParentRuntimeProofAdmissionAuthority({
      privateKey,
      validationRunChallenge: CHALLENGE,
      clockUnixNs: () => 1_784_500_000_123_456_789n,
      nonceBytes: () => Buffer.alloc(32, 0x51),
    });
    const trust = authority.trustMaterial();
    const receipt = authority.signer().sign(admissionInput());

    expect(trust.validationRunChallenge).toBe(CHALLENGE);
    expect(receipt).not.toHaveProperty("publicKey");
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      trust.verificationKey,
      receipt,
      trust.validationRunChallenge,
    )).toMatchObject({ verified: true, replayChecked: false, freshnessChecked: false });

    const other = new GpuParentRuntimeProofAdmissionAuthority();
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      other.trustMaterial().verificationKey,
      receipt,
      trust.validationRunChallenge,
    ).verified).toBe(false);
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      trust.verificationKey,
      receipt,
      Buffer.alloc(32, 0x52).toString("base64url"),
    ).verified).toBe(false);
  });

  it("disposes signing without invalidating already captured public trust material", () => {
    const authority = new GpuParentRuntimeProofAdmissionAuthority();
    const trust = authority.trustMaterial();
    const signer = authority.signer();

    authority.dispose();
    authority.dispose();

    expect(authority.trustMaterial()).toBe(trust);
    expect(() => authority.signer())
      .toThrow("gpu_parent_runtime_proof_admission_authority_disposed");
    expect(() => signer.sign(admissionInput()))
      .toThrow("gpu_parent_runtime_proof_admission_receipt_signer_disposed");
  });

  it("passes deterministic clock and nonce callbacks only to the internal signer", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    let clockCalls = 0;
    let nonceCalls = 0;
    const authority = new GpuParentRuntimeProofAdmissionAuthority({
      privateKey,
      validationRunChallenge: CHALLENGE,
      clockUnixNs: () => {
        clockCalls += 1;
        return 99n;
      },
      nonceBytes: () => {
        nonceCalls += 1;
        return Buffer.alloc(32, 0x61);
      },
    });

    const receipt = authority.signer().sign(admissionInput());
    expect(receipt.admittedAtUnixNs).toBe("99");
    expect(clockCalls).toBe(1);
    expect(nonceCalls).toBe(1);
    expect(authority.trustMaterial()).not.toHaveProperty("clockUnixNs");
    expect(authority.trustMaterial()).not.toHaveProperty("nonceBytes");
  });

  it("rejects malformed exact contexts without invoking accessors or proxy traps", () => {
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "privateKey", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return generateKeyPairSync("ed25519").privateKey;
      },
    });
    expect(() => new GpuParentRuntimeProofAdmissionAuthority(accessor))
      .toThrow("gpu_parent_runtime_proof_admission_authority_context_invalid");
    expect(getterCalls).toBe(0);

    let trapCalls = 0;
    const failTrap = (): never => {
      trapCalls += 1;
      throw new Error("proxy trap must not run");
    };
    const proxy = new Proxy({}, {
      get: failTrap,
      getOwnPropertyDescriptor: failTrap,
      getPrototypeOf: failTrap,
      ownKeys: failTrap,
    });
    expect(() => new GpuParentRuntimeProofAdmissionAuthority(proxy))
      .toThrow("gpu_parent_runtime_proof_admission_authority_context_invalid");
    expect(trapCalls).toBe(0);

    expect(() => new GpuParentRuntimeProofAdmissionAuthority(
      Object.assign(Object.create({}), {}),
    )).toThrow("gpu_parent_runtime_proof_admission_authority_context_invalid");
    expect(() => new GpuParentRuntimeProofAdmissionAuthority({ extra: true } as never))
      .toThrow("gpu_parent_runtime_proof_admission_authority_context_invalid");
    expect(() => new GpuParentRuntimeProofAdmissionAuthority({
      validationRunChallenge: "not-base64url",
    })).toThrow("gpu_parent_runtime_proof_admission_authority_challenge_invalid");
  });
});
