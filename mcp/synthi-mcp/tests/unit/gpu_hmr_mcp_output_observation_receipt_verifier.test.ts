import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGpuHmrMcpAdmissionVerificationKey,
  GPU_HMR_MCP_ADMISSION_ALGORITHM,
  GPU_HMR_MCP_ADMISSION_PRODUCER,
  hashGpuHmrMcpValidationRunChallenge,
} from "../../scripts/lib/gpu-hmr-mcp-admission-receipt-verifier.mjs";
import {
  createGpuHmrMcpOutputObservationReceiptSigningBytes,
  finalizeGpuHmrMcpOutputObservationReceipt,
  GPU_HMR_MCP_OUTPUT_OBSERVATION_RECEIPT_AUTHORITY,
  GPU_HMR_MCP_OUTPUT_OBSERVATION_RECEIPT_SCHEMA,
  GPU_HMR_MCP_OUTPUT_OBSERVATION_VERIFICATION_AUTHORITY,
  parseGpuHmrMcpOutputObservationReceiptSigningInput,
  verifyGpuHmrMcpOutputObservationReceipt,
} from "../../scripts/lib/gpu-hmr-mcp-output-observation-receipt-verifier.mjs";

const NOW_NS = 1_784_500_000_123_456_789n;
const OBSERVED_NS = 72_000_123_456n;
const CHALLENGE = Buffer.alloc(32, 0x21).toString("base64url");
const OTHER_CHALLENGE = Buffer.alloc(32, 0x22).toString("base64url");
const OUTPUT_BYTES = Buffer.from("observed-output-bytes", "utf8");

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function verificationKey(privateKey: KeyObject): Record<string, unknown> {
  const publicKeyDer = Buffer.from(createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  }));
  const publicKey = publicKeyDer.subarray(publicKeyDer.byteLength - 32);
  const parsed = createGpuHmrMcpAdmissionVerificationKey(
    publicKey.toString("base64url"),
  );
  if (parsed === null) throw new Error("test_verification_key_invalid");
  return parsed;
}

function input() {
  return {
    transportSessionId: "opaque-transport-session:output-observation-01",
    requestChallengeSha256: sha256("one-time-observation-request"),
    runtimeBindingSha256: sha256("validated-runtime-binding"),
    producerObservationSha256: sha256("trusted-producer-observation"),
    outputContentSha256: sha256(OUTPUT_BYTES),
    outputByteLength: String(OUTPUT_BYTES.byteLength),
    observedAtMonotonicNs: OBSERVED_NS.toString(),
  };
}

function signedReceipt(options: Partial<{
  privateKey: KeyObject;
  challenge: string;
  input: ReturnType<typeof input>;
}> = {}) {
  const privateKey = options.privateKey ?? generateKeyPairSync("ed25519").privateKey;
  const trustedKey = verificationKey(privateKey);
  const unsigned = Object.freeze({
    schemaVersion: GPU_HMR_MCP_OUTPUT_OBSERVATION_RECEIPT_SCHEMA,
    algorithm: GPU_HMR_MCP_ADMISSION_ALGORITHM,
    signerKeyId: trustedKey["keyId"],
    producer: GPU_HMR_MCP_ADMISSION_PRODUCER,
    proofAuthority: GPU_HMR_MCP_OUTPUT_OBSERVATION_RECEIPT_AUTHORITY,
    outputBytesObserved: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    validationRunChallengeSha256:
      hashGpuHmrMcpValidationRunChallenge(options.challenge ?? CHALLENGE),
    ...(options.input ?? input()),
    issuedAtUnixNs: NOW_NS.toString(),
    sequence: "1",
    nonce: Buffer.alloc(32, 0x31).toString("base64url"),
  });
  const signingBytes = createGpuHmrMcpOutputObservationReceiptSigningBytes(unsigned);
  if (!Buffer.isBuffer(signingBytes)) throw new Error("test_signing_bytes_invalid");
  const signature = `ed25519:${signBytes(
    null,
    signingBytes,
    privateKey,
  ).toString("base64url")}`;
  const receipt = finalizeGpuHmrMcpOutputObservationReceipt(unsigned, signature);
  if (receipt === null) throw new Error("test_receipt_invalid");
  return { privateKey, trustedKey, receipt };
}

describe("generic MCP output-observation receipt verifier", () => {
  it("verifies only the signature against an externally supplied key", () => {
    const { trustedKey, receipt } = signedReceipt();
    const verification = verifyGpuHmrMcpOutputObservationReceipt(
      trustedKey,
      receipt,
      CHALLENGE,
    );

    expect(verification).toMatchObject({
      signatureVerified: true,
      reason: null,
      verificationAuthority: GPU_HMR_MCP_OUTPUT_OBSERVATION_VERIFICATION_AUTHORITY,
      receiptId: receipt.receiptId,
      issuedAtUnixNs: NOW_NS,
      observedAtMonotonicNs: OBSERVED_NS,
      sequence: 1n,
      trustedKeyOriginChecked: false,
      requestChallengeChecked: false,
      runtimeBindingChecked: false,
      outputBytesChecked: false,
      replayChecked: false,
      freshnessChecked: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(verification.replayScope.transportSessionId)
      .toBe(receipt.transportSessionId);
    expect(receipt).not.toHaveProperty("project");
    expect(receipt).not.toHaveProperty("backend");
    expect(receipt).not.toHaveProperty("renderer");
    expect(receipt).not.toHaveProperty("camera");
    expect(receipt).not.toHaveProperty("dimensions");
    expect(receipt).not.toHaveProperty("outputKind");
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(verification)).toBe(true);
  });

  it("does not infer trust origin from a self-signed receipt", () => {
    const attacker = signedReceipt();
    const signatureOnly = verifyGpuHmrMcpOutputObservationReceipt(
      attacker.trustedKey,
      attacker.receipt,
      CHALLENGE,
    );
    expect(signatureOnly).toMatchObject({
      signatureVerified: true,
      trustedKeyOriginChecked: false,
      requestChallengeChecked: false,
      runtimeBindingChecked: false,
      outputBytesChecked: false,
      replayChecked: false,
      freshnessChecked: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(signatureOnly).not.toHaveProperty("verified");
    expect(signatureOnly).not.toHaveProperty("accepted");
  });

  it("rejects missing trust, a different key, and a different run challenge", () => {
    const original = signedReceipt();
    const other = signedReceipt();
    expect(verifyGpuHmrMcpOutputObservationReceipt(
      null,
      original.receipt,
      CHALLENGE,
    ).reason).toBe("gpu_hmr_mcp_output_observation_verification_key_invalid");
    expect(verifyGpuHmrMcpOutputObservationReceipt(
      other.trustedKey,
      original.receipt,
      CHALLENGE,
    ).reason).toBe("gpu_hmr_mcp_output_observation_signer_key_mismatch");
    expect(verifyGpuHmrMcpOutputObservationReceipt(
      original.trustedKey,
      original.receipt,
      OTHER_CHALLENGE,
    ).reason).toBe(
      "gpu_hmr_mcp_output_observation_validation_run_challenge_mismatch",
    );
  });

  it.each([
    "requestChallengeSha256",
    "runtimeBindingSha256",
    "producerObservationSha256",
    "outputContentSha256",
    "outputByteLength",
    "observedAtMonotonicNs",
    "transportSessionId",
  ])("rejects signed-field substitution for %s", (field) => {
    const { trustedKey, receipt } = signedReceipt();
    const forged = structuredClone(receipt) as Record<string, unknown>;
    forged[field] = field.endsWith("Sha256")
      ? sha256(`forged-${field}`)
      : field === "outputByteLength"
        ? "22"
        : field === "observedAtMonotonicNs"
          ? (OBSERVED_NS + 1n).toString()
          : "opaque-transport-session:forged";
    const verification = verifyGpuHmrMcpOutputObservationReceipt(
      trustedKey,
      forged,
      CHALLENGE,
    );
    expect([
      "gpu_hmr_mcp_output_observation_receipt_id_mismatch",
      "gpu_hmr_mcp_output_observation_signature_mismatch",
    ]).toContain(verification.reason);
    expect(verification.signatureVerified).toBe(false);
  });

  it("accepts empty output and rejects malformed lengths and object boundaries", () => {
    const valid = input();
    expect(parseGpuHmrMcpOutputObservationReceiptSigningInput(valid)).toEqual(valid);
    expect(parseGpuHmrMcpOutputObservationReceiptSigningInput({
      ...valid,
      projectName: "named-corpus-must-not-be-authority",
    })).toBeNull();
    expect(parseGpuHmrMcpOutputObservationReceiptSigningInput({
      ...valid,
      outputByteLength: "0",
    })).toEqual({ ...valid, outputByteLength: "0" });
    expect(parseGpuHmrMcpOutputObservationReceiptSigningInput({
      ...valid,
      outputByteLength: "-1",
    })).toBeNull();
    expect(parseGpuHmrMcpOutputObservationReceiptSigningInput({
      ...valid,
      outputByteLength: "01",
    })).toBeNull();
    expect(parseGpuHmrMcpOutputObservationReceiptSigningInput({
      ...valid,
      outputByteLength: "9007199254740993",
    })).toEqual({ ...valid, outputByteLength: "9007199254740993" });

    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "runtimeBindingSha256", {
      enumerable: true,
      get: () => valid.runtimeBindingSha256,
    });
    expect(parseGpuHmrMcpOutputObservationReceiptSigningInput(accessor)).toBeNull();
    expect(parseGpuHmrMcpOutputObservationReceiptSigningInput(
      new Proxy(valid, {}),
    )).toBeNull();
  });
});
