import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_ALGORITHM,
  GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_AUTHORITY,
  GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_PRODUCER,
  GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_SCHEMA,
  GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_VERIFICATION_AUTHORITY,
  GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_VERIFICATION_KEY_SCHEMA,
  GpuMcpOutputObservationReceiptSigner,
  parseGpuMcpOutputObservationReceiptVerificationKey,
  verifyGpuMcpOutputObservationReceipt,
  type GpuMcpOutputObservationReceiptRequest,
} from "../../src/gpu_mcp_output_observation_receipt.js";
import {
  GpuParentRuntimeProofAdmissionReceiptSigner,
  type GpuParentRuntimeProofAdmissionReceiptInput,
} from "../../src/gpu_parent_runtime_proof_admission_receipt.js";
import {
  finalizeGpuHmrMcpOutputObservationReceipt,
  verifyGpuHmrMcpOutputObservationReceipt,
} from "../../scripts/lib/gpu-hmr-mcp-output-observation-receipt-verifier.mjs";

const OBSERVED_NS = 72_000_123_456n;
const ISSUED_NS = 1_784_500_000_123_456_789n;
const CHALLENGE = Buffer.alloc(32, 0x21).toString("base64url");
const OTHER_CHALLENGE = Buffer.alloc(32, 0x22).toString("base64url");
const OUTPUT_BYTES = Buffer.from("observed-output-bytes", "utf8");

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function admissionInput(): GpuParentRuntimeProofAdmissionReceiptInput {
  const hashDigit = (digit: string): string => `sha256:${digit.repeat(64)}`;
  const controlBindingCanonicalSha256 = hashDigit("4");
  return {
    transportSessionId: "opaque-transport-session:output-observation-01",
    compileRequestNonce: `gpu-proof-transport-request:${"1".repeat(32)}`,
    computeExpectedOutputContractHash: hashDigit("a"),
    computeExpectedOutputSemanticsHash: hashDigit("b"),
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
    controlObservationContextHash: hashDigit("6"),
    parentReceiptId:
      `gpu-parent-runtime-proof-receipt:sha256:${"7".repeat(64)}`,
    parentTransportReceiptId:
      `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"8".repeat(64)}`,
    parentCanonicalProofSha256: hashDigit("9"),
    parentObservationContextHash: hashDigit("0"),
    requestId: `gpu-reload:request:${"c".repeat(32)}`,
    sourceEditId: `source-edit:sha256:${"d".repeat(64)}`,
    artifactContentHash: hashDigit("e"),
    fullRuntimeProofId: `gpu-runtime-proof:sha256:${"f".repeat(64)}`,
    proofLedgerId: `gpu-ledger-proof:sha256:${"1".repeat(64)}`,
    runnerProcessId: 8123,
    runnerRuntimeSessionId: "opaque-runtime-session:output-observation-02",
    runnerChallenge: "23456789abcdef0123456789abcdef01",
    commandEnvelopeSha256: hashDigit("2"),
    protectedProofJsonSha256: hashDigit("3"),
  };
}

function admittedReceipt(
  privateKey: KeyObject,
  challenge = CHALLENGE,
  nonceByte = 0x41,
) {
  return new GpuParentRuntimeProofAdmissionReceiptSigner({
    privateKey,
    validationRunChallenge: challenge,
    clockUnixNs: () => ISSUED_NS,
    nonceBytes: () => Buffer.alloc(32, nonceByte),
  }).sign(admissionInput());
}

function receiptRequest(
  privateKey: KeyObject,
  challenge = CHALLENGE,
  nonceByte = 0x41,
): GpuMcpOutputObservationReceiptRequest {
  return {
    admissionReceipt: admittedReceipt(
      privateKey,
      challenge,
      nonceByte,
    ),
    outputBytes: OUTPUT_BYTES,
  };
}

function deterministicNonce(seed = 0x31): () => Uint8Array {
  let next = seed;
  return () => Buffer.alloc(32, next++);
}

function signer(
  privateKey: KeyObject,
  options: Partial<{
    challenge: string;
    clockMonotonicNs: () => bigint;
    clockUnixNs: () => bigint;
    nonceBytes: () => Uint8Array;
  }> = {},
): GpuMcpOutputObservationReceiptSigner {
  return new GpuMcpOutputObservationReceiptSigner({
    privateKey,
    validationRunChallenge: options.challenge ?? CHALLENGE,
    clockMonotonicNs: options.clockMonotonicNs ?? (() => OBSERVED_NS),
    clockUnixNs: options.clockUnixNs ?? (() => ISSUED_NS),
    nonceBytes: options.nonceBytes ?? deterministicNonce(),
  });
}

describe("GpuMcpOutputObservationReceiptSigner", () => {
  it("signs two support-only receipts with signer-owned clocks and monotonic sequence", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    let monotonic = OBSERVED_NS;
    const receiptSigner = signer(privateKey, {
      clockMonotonicNs: () => monotonic++,
    });
    const trustedKey = receiptSigner.exportVerificationKey();
    const firstRequest = receiptRequest(privateKey);
    const first = receiptSigner.sign(firstRequest);
    const second = receiptSigner.signOutputObservationReceipt(
      receiptRequest(privateKey, CHALLENGE, 0x42),
    );

    expect(Reflect.ownKeys(receiptSigner)).not.toContain("privateKey");
    expect(Object.isFrozen(trustedKey)).toBe(true);
    expect(trustedKey).toMatchObject({
      schemaVersion: GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_VERIFICATION_KEY_SCHEMA,
      algorithm: GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_ALGORITHM,
      producer: GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_PRODUCER,
    });
    expect(first).toMatchObject({
      schemaVersion: GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_SCHEMA,
      algorithm: GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_ALGORITHM,
      signerKeyId: trustedKey.keyId,
      producer: GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_PRODUCER,
      proofAuthority: GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_AUTHORITY,
      observedAtMonotonicNs: OBSERVED_NS.toString(),
      issuedAtUnixNs: ISSUED_NS.toString(),
      sequence: "1",
      outputBytesObserved: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      outputContentSha256: sha256(OUTPUT_BYTES),
      outputByteLength: String(OUTPUT_BYTES.byteLength),
      transportSessionId: firstRequest.admissionReceipt.transportSessionId,
      producerObservationSha256:
        firstRequest.admissionReceipt.protectedProofJsonSha256,
    });
    expect(first.requestChallengeSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.runtimeBindingSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first).not.toHaveProperty("outputBytes");
    expect(second.observedAtMonotonicNs).toBe((OBSERVED_NS + 1n).toString());
    expect(second.sequence).toBe("2");
    expect(first).not.toHaveProperty("publicKey");
    expect(first).not.toHaveProperty("verificationKey");
    expect(Object.isFrozen(first)).toBe(true);

    const wrapped = verifyGpuMcpOutputObservationReceipt(trustedKey, first, CHALLENGE);
    const independentlyVerified = verifyGpuHmrMcpOutputObservationReceipt(
      trustedKey,
      first,
      CHALLENGE,
    );
    expect(wrapped).toEqual(independentlyVerified);
    expect(wrapped).toMatchObject({
      signatureVerified: true,
      reason: null,
      verificationAuthority:
        GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_VERIFICATION_AUTHORITY,
      issuedAtUnixNs: ISSUED_NS,
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
  });

  it("rejects malformed requests, key mismatch, and challenge mismatch", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const receiptSigner = signer(privateKey);
    const receipt = receiptSigner.sign(receiptRequest(privateKey));
    const other = signer(generateKeyPairSync("ed25519").privateKey);

    expect(() => receiptSigner.sign({
      ...receiptRequest(privateKey),
      outputBytes: Buffer.alloc(0),
    })).toThrow("gpu_mcp_output_observation_receipt_request_invalid");
    expect(() => receiptSigner.sign(
      receiptRequest(generateKeyPairSync("ed25519").privateKey),
    )).toThrow("gpu_mcp_output_observation_receipt_request_invalid");
    expect(() => receiptSigner.sign({
      ...receiptRequest(privateKey),
      runtimeBindingSha256: sha256("caller-claimed-runtime"),
      producerObservationSha256: sha256("caller-claimed-observation"),
      outputContentSha256: sha256("caller-claimed-output"),
      outputByteLength: "999",
    } as unknown as GpuMcpOutputObservationReceiptRequest))
      .toThrow("gpu_mcp_output_observation_receipt_request_invalid");
    expect(() => receiptSigner.sign({
      ...receiptRequest(privateKey),
      extra: true,
    } as unknown as GpuMcpOutputObservationReceiptRequest))
      .toThrow("gpu_mcp_output_observation_receipt_request_invalid");
    expect(verifyGpuMcpOutputObservationReceipt(
      other.exportVerificationKey(),
      receipt,
      CHALLENGE,
    ).reason).toBe("gpu_hmr_mcp_output_observation_signer_key_mismatch");
    expect(verifyGpuMcpOutputObservationReceipt(
      receiptSigner.exportVerificationKey(),
      receipt,
      OTHER_CHALLENGE,
    ).reason).toBe(
      "gpu_hmr_mcp_output_observation_validation_run_challenge_mismatch",
    );
  });

  it("rejects post-issuance field, receipt ID, and signature tampering", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const receiptSigner = signer(privateKey);
    const trustedKey = receiptSigner.exportVerificationKey();
    const receipt = receiptSigner.sign(receiptRequest(privateKey));

    expect(verifyGpuMcpOutputObservationReceipt(trustedKey, {
      ...receipt,
      outputContentSha256: sha256("substituted-output"),
    }, CHALLENGE).reason).toBe(
      "gpu_hmr_mcp_output_observation_receipt_id_mismatch",
    );
    expect(verifyGpuMcpOutputObservationReceipt(trustedKey, {
      ...receipt,
      receiptId: `gpu-hmr-mcp-output-observation-receipt:sha256:${"0".repeat(64)}`,
    }, CHALLENGE).reason).toBe(
      "gpu_hmr_mcp_output_observation_receipt_id_mismatch",
    );

    const { receiptId: _receiptId, signature: _signature, ...unsignedReceipt } = receipt;
    const forgedSignature = `ed25519:${Buffer.alloc(64, 0x5a).toString("base64url")}`;
    const forgedReceipt = finalizeGpuHmrMcpOutputObservationReceipt(
      unsignedReceipt,
      forgedSignature,
    );
    expect(forgedReceipt).not.toBeNull();
    expect(verifyGpuMcpOutputObservationReceipt(
      trustedKey,
      forgedReceipt,
      CHALLENGE,
    ).reason).toBe("gpu_hmr_mcp_output_observation_signature_mismatch");
  });

  it("rejects proxy and accessor boundaries without invoking them", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const receiptSigner = signer(privateKey);
    const request = receiptRequest(privateKey) as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(request, "admissionReceipt", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return admittedReceipt(privateKey);
      },
    });
    expect(() => receiptSigner.sign(
      request as unknown as GpuMcpOutputObservationReceiptRequest,
    )).toThrow("gpu_mcp_output_observation_receipt_request_invalid");

    let trapCalls = 0;
    const failTrap = (): never => {
      trapCalls += 1;
      throw new Error("trap must not run");
    };
    expect(() => receiptSigner.sign(new Proxy(receiptRequest(privateKey), {
      get: failTrap,
      getOwnPropertyDescriptor: failTrap,
      getPrototypeOf: failTrap,
      ownKeys: failTrap,
    }))).toThrow("gpu_mcp_output_observation_receipt_request_invalid");
    expect(getterCalls).toBe(0);
    expect(trapCalls).toBe(0);

    expect(() => receiptSigner.sign({
      ...receiptRequest(privateKey),
      outputBytes: new Proxy(Buffer.from(OUTPUT_BYTES), {}),
    })).toThrow("gpu_mcp_output_observation_receipt_request_invalid");
    expect(() => receiptSigner.sign({
      ...receiptRequest(privateKey),
      outputBytes: new Uint16Array([1, 2]),
    } as unknown as GpuMcpOutputObservationReceiptRequest))
      .toThrow("gpu_mcp_output_observation_receipt_request_invalid");
    expect(() => receiptSigner.sign({
      ...receiptRequest(privateKey),
      outputBytes: new Uint8Array(new SharedArrayBuffer(32)),
    })).toThrow("gpu_mcp_output_observation_receipt_request_invalid");
  });

  it("snapshots observed bytes before signer callbacks can mutate them", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const mutableBytes = Buffer.from(OUTPUT_BYTES);
    const expectedHash = sha256(mutableBytes);
    const receiptSigner = signer(privateKey, {
      clockMonotonicNs: () => {
        mutableBytes.fill(0);
        return OBSERVED_NS;
      },
    });

    const receipt = receiptSigner.sign({
      ...receiptRequest(privateKey),
      outputBytes: mutableBytes,
    });
    expect(receipt.outputContentSha256).toBe(expectedHash);
    expect(receipt.outputByteLength).toBe(String(OUTPUT_BYTES.byteLength));
  });

  it("rejects non-data signer contexts, extra context fields, and public keys", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    let getterCalls = 0;
    const accessorContext = {
      validationRunChallenge: CHALLENGE,
    } as Record<string, unknown>;
    Object.defineProperty(accessorContext, "privateKey", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return privateKey;
      },
    });
    expect(() => new GpuMcpOutputObservationReceiptSigner(
      accessorContext as never,
    )).toThrow("gpu_mcp_output_observation_receipt_signer_context_invalid");

    let trapCalls = 0;
    const failTrap = (): never => {
      trapCalls += 1;
      throw new Error("trap must not run");
    };
    expect(() => new GpuMcpOutputObservationReceiptSigner(new Proxy({
      privateKey,
      validationRunChallenge: CHALLENGE,
    }, {
      get: failTrap,
      getOwnPropertyDescriptor: failTrap,
      getPrototypeOf: failTrap,
      ownKeys: failTrap,
    }))).toThrow("gpu_mcp_output_observation_receipt_signer_context_invalid");
    expect(() => new GpuMcpOutputObservationReceiptSigner({
      privateKey,
      validationRunChallenge: CHALLENGE,
      extra: true,
    } as never)).toThrow("gpu_mcp_output_observation_receipt_signer_context_invalid");
    expect(() => new GpuMcpOutputObservationReceiptSigner({
      privateKey: publicKey,
      validationRunChallenge: CHALLENGE,
    })).toThrow("gpu_mcp_output_observation_receipt_private_key_invalid");
    expect(getterCalls).toBe(0);
    expect(trapCalls).toBe(0);
  });

  it("suppresses reentry and preserves the sequence after callback failure", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    let receiptSigner!: GpuMcpOutputObservationReceiptSigner;
    let reenter = true;
    receiptSigner = signer(privateKey, {
      clockMonotonicNs: () => {
        if (reenter) {
          reenter = false;
          expect(() => receiptSigner.sign(receiptRequest(privateKey)))
            .toThrow("gpu_mcp_output_observation_receipt_signer_busy");
        }
        return OBSERVED_NS;
      },
    });
    expect(receiptSigner.sign(receiptRequest(privateKey)).sequence).toBe("1");
    expect(receiptSigner.sign(
      receiptRequest(privateKey, CHALLENGE, 0x42),
    ).sequence).toBe("2");

    let failOnce = true;
    const failedClockSigner = signer(privateKey, {
      clockUnixNs: () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("unavailable");
        }
        return ISSUED_NS;
      },
    });
    expect(() => failedClockSigner.sign(receiptRequest(privateKey)))
      .toThrow("gpu_mcp_output_observation_receipt_issuance_clock_failed");
    expect(failedClockSigner.sign(receiptRequest(privateKey)).sequence).toBe("1");

    let failNonce = true;
    const failedNonceSigner = signer(privateKey, {
      nonceBytes: () => {
        if (failNonce) {
          failNonce = false;
          throw new Error("unavailable");
        }
        return Buffer.alloc(32, 0x71);
      },
    });
    expect(() => failedNonceSigner.sign(receiptRequest(privateKey)))
      .toThrow("gpu_mcp_output_observation_receipt_nonce_source_failed");
    expect(failedNonceSigner.sign(receiptRequest(privateKey)).sequence).toBe("1");
  });

  it("fails closed when a signer-owned callback disposes the signer", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    let clockSigner!: GpuMcpOutputObservationReceiptSigner;
    clockSigner = signer(privateKey, {
      clockMonotonicNs: () => {
        clockSigner.dispose();
        return OBSERVED_NS;
      },
    });
    expect(() => clockSigner.sign(receiptRequest(privateKey)))
      .toThrow("gpu_mcp_output_observation_receipt_signer_disposed");
    expect(() => clockSigner.sign(receiptRequest(privateKey)))
      .toThrow("gpu_mcp_output_observation_receipt_signer_disposed");

    let nonceSigner!: GpuMcpOutputObservationReceiptSigner;
    nonceSigner = signer(privateKey, {
      nonceBytes: () => {
        nonceSigner.dispose();
        return Buffer.alloc(32, 0x6b);
      },
    });
    expect(() => nonceSigner.sign(receiptRequest(privateKey)))
      .toThrow("gpu_mcp_output_observation_receipt_signer_disposed");
  });

  it("rejects invalid clocks and nonce sources", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    for (const [option, reason] of [
      [{ clockMonotonicNs: () => -1n }, "gpu_mcp_output_observation_receipt_observation_clock_invalid"],
      [{ clockUnixNs: () => 1 as unknown as bigint }, "gpu_mcp_output_observation_receipt_issuance_clock_invalid"],
      [{ nonceBytes: () => Buffer.alloc(31) }, "gpu_mcp_output_observation_receipt_nonce_source_invalid"],
    ] as const) {
      expect(() => signer(privateKey, option).sign(receiptRequest(privateKey)))
        .toThrow(reason);
    }
    const proxiedNonce = new Proxy(Buffer.alloc(32), {});
    expect(() => signer(privateKey, {
      nonceBytes: () => proxiedNonce,
    }).sign(receiptRequest(privateKey))).toThrow(
      "gpu_mcp_output_observation_receipt_nonce_source_invalid",
    );
  });

  it("fails closed after disposal and exposes no private material", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const receiptSigner = signer(privateKey);
    const key = receiptSigner.exportVerificationKey();
    receiptSigner.dispose();
    receiptSigner.dispose();
    expect(receiptSigner.exportVerificationKey()).toBe(key);
    expect(() => receiptSigner.sign(receiptRequest(privateKey)))
      .toThrow("gpu_mcp_output_observation_receipt_signer_disposed");
    expect(parseGpuMcpOutputObservationReceiptVerificationKey(key)).toEqual(key);
    expect(JSON.stringify(receiptSigner)).not.toContain("private");
  });

  it("keeps the request and receipt schema generic", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const receipt = signer(privateKey).sign(receiptRequest(privateKey));
    expect(Object.keys(receiptRequest(privateKey))).toEqual([
      "admissionReceipt",
      "outputBytes",
    ]);
    for (const name of [
      "project", "backend", "renderer", "api", "image", "camera", "dimensions",
      "profile", "fixture",
    ]) {
      expect(receipt).not.toHaveProperty(name);
    }
  });
});
