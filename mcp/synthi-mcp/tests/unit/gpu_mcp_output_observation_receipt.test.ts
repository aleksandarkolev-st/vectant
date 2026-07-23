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

function receiptRequest(): GpuMcpOutputObservationReceiptRequest {
  return {
    transportSessionId: "opaque-transport-session:output-observation-01",
    requestChallengeSha256: sha256("one-time-observation-request"),
    runtimeBindingSha256: sha256("validated-runtime-binding"),
    producerObservationSha256: sha256("trusted-producer-observation"),
    outputContentSha256: sha256(OUTPUT_BYTES),
    outputByteLength: String(OUTPUT_BYTES.byteLength),
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
    const first = receiptSigner.sign(receiptRequest());
    const second = receiptSigner.signOutputObservationReceipt(receiptRequest());

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
    });
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
    const receipt = receiptSigner.sign(receiptRequest());
    const other = signer(generateKeyPairSync("ed25519").privateKey);

    expect(() => receiptSigner.sign({
      ...receiptRequest(),
      outputByteLength: "0",
    })).toThrow("gpu_mcp_output_observation_receipt_request_invalid");
    expect(() => receiptSigner.sign({
      ...receiptRequest(),
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
    const receipt = receiptSigner.sign(receiptRequest());

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
    const request = receiptRequest() as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(request, "runtimeBindingSha256", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return sha256("unreachable");
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
    expect(() => receiptSigner.sign(new Proxy(receiptRequest(), {
      get: failTrap,
      getOwnPropertyDescriptor: failTrap,
      getPrototypeOf: failTrap,
      ownKeys: failTrap,
    }))).toThrow("gpu_mcp_output_observation_receipt_request_invalid");
    expect(getterCalls).toBe(0);
    expect(trapCalls).toBe(0);
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
          expect(() => receiptSigner.sign(receiptRequest()))
            .toThrow("gpu_mcp_output_observation_receipt_signer_busy");
        }
        return OBSERVED_NS;
      },
    });
    expect(receiptSigner.sign(receiptRequest()).sequence).toBe("1");
    expect(receiptSigner.sign(receiptRequest()).sequence).toBe("2");

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
    expect(() => failedClockSigner.sign(receiptRequest()))
      .toThrow("gpu_mcp_output_observation_receipt_issuance_clock_failed");
    expect(failedClockSigner.sign(receiptRequest()).sequence).toBe("1");

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
    expect(() => failedNonceSigner.sign(receiptRequest()))
      .toThrow("gpu_mcp_output_observation_receipt_nonce_source_failed");
    expect(failedNonceSigner.sign(receiptRequest()).sequence).toBe("1");
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
    expect(() => clockSigner.sign(receiptRequest()))
      .toThrow("gpu_mcp_output_observation_receipt_signer_disposed");
    expect(() => clockSigner.sign(receiptRequest()))
      .toThrow("gpu_mcp_output_observation_receipt_signer_disposed");

    let nonceSigner!: GpuMcpOutputObservationReceiptSigner;
    nonceSigner = signer(privateKey, {
      nonceBytes: () => {
        nonceSigner.dispose();
        return Buffer.alloc(32, 0x6b);
      },
    });
    expect(() => nonceSigner.sign(receiptRequest()))
      .toThrow("gpu_mcp_output_observation_receipt_signer_disposed");
  });

  it("rejects invalid clocks and nonce sources", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    for (const [option, reason] of [
      [{ clockMonotonicNs: () => -1n }, "gpu_mcp_output_observation_receipt_observation_clock_invalid"],
      [{ clockUnixNs: () => 1 as unknown as bigint }, "gpu_mcp_output_observation_receipt_issuance_clock_invalid"],
      [{ nonceBytes: () => Buffer.alloc(31) }, "gpu_mcp_output_observation_receipt_nonce_source_invalid"],
    ] as const) {
      expect(() => signer(privateKey, option).sign(receiptRequest())).toThrow(reason);
    }
    const proxiedNonce = new Proxy(Buffer.alloc(32), {});
    expect(() => signer(privateKey, {
      nonceBytes: () => proxiedNonce,
    }).sign(receiptRequest())).toThrow(
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
    expect(() => receiptSigner.sign(receiptRequest()))
      .toThrow("gpu_mcp_output_observation_receipt_signer_disposed");
    expect(parseGpuMcpOutputObservationReceiptVerificationKey(key)).toEqual(key);
    expect(JSON.stringify(receiptSigner)).not.toContain("private");
  });

  it("keeps the request and receipt schema generic", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const receipt = signer(privateKey).sign(receiptRequest());
    expect(Object.keys(receiptRequest())).toEqual([
      "transportSessionId",
      "requestChallengeSha256",
      "runtimeBindingSha256",
      "producerObservationSha256",
      "outputContentSha256",
      "outputByteLength",
    ]);
    for (const name of [
      "project", "backend", "renderer", "api", "image", "camera", "dimensions",
      "profile", "fixture",
    ]) {
      expect(receipt).not.toHaveProperty(name);
    }
  });
});
