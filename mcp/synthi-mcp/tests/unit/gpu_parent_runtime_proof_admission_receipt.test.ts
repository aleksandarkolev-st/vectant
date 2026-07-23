import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_ALGORITHM,
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_AUTHORITY,
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_PRODUCER,
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_SCHEMA,
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_VERIFICATION_AUTHORITY,
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_VERIFICATION_KEY_SCHEMA,
  GpuParentRuntimeProofAdmissionReceiptSigner,
  parseGpuParentRuntimeProofAdmissionReceiptVerificationKey,
  verifyGpuParentRuntimeProofAdmissionReceipt,
  type GpuParentRuntimeProofAdmissionReceipt,
  type GpuParentRuntimeProofAdmissionReceiptInput,
  type GpuParentRuntimeProofAdmissionReceiptVerification,
} from "../../src/gpu_parent_runtime_proof_admission_receipt.js";
import {
  createGpuHmrMcpAdmissionReceiptSigningBytes,
  finalizeGpuHmrMcpAdmissionReceipt,
  parseGpuHmrMcpAdmissionReceiptSigningInput,
  verifyGpuHmrMcpAdmissionReceipt,
} from "../../scripts/lib/gpu-hmr-mcp-admission-receipt-verifier.mjs";
import {
  GpuMcpOutputObservationReceiptSigner,
  verifyGpuMcpOutputObservationReceipt,
} from "../../src/gpu_mcp_output_observation_receipt.js";
import {
  createGpuHmrMcpOutputObservationReceiptSigningBytes,
  finalizeGpuHmrMcpOutputObservationReceipt,
} from "../../scripts/lib/gpu-hmr-mcp-output-observation-receipt-verifier.mjs";

const NOW_NS = 1_784_500_000_123_456_789n;
const VALIDATION_RUN_CHALLENGE = Buffer.alloc(32, 0x17).toString("base64url");
const OTHER_VALIDATION_RUN_CHALLENGE = Buffer.alloc(32, 0x18).toString("base64url");

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hash(digit: string): string {
  return `sha256:${digit.repeat(64)}`;
}

function admissionInput(): GpuParentRuntimeProofAdmissionReceiptInput {
  const controlBindingCanonicalSha256 = hash("4");
  return {
    transportSessionId: "opaque-transport-session:admission-01",
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
    runnerRuntimeSessionId: "opaque-runtime-session:admission-02",
    runnerChallenge: "23456789abcdef0123456789abcdef01",
    commandEnvelopeSha256: hash("2"),
    protectedProofJsonSha256: hash("3"),
  };
}

function deterministicNonce(seed = 0x31): () => Uint8Array {
  let next = seed;
  return () => {
    const value = Buffer.alloc(32, next);
    next += 1;
    return value;
  };
}

function signer(
  privateKey: KeyObject,
  options: Partial<{
    challenge: string;
    clockUnixNs: () => bigint;
    nonceBytes: () => Uint8Array;
  }> = {},
): GpuParentRuntimeProofAdmissionReceiptSigner {
  return new GpuParentRuntimeProofAdmissionReceiptSigner({
    privateKey,
    validationRunChallenge: options.challenge ?? VALIDATION_RUN_CHALLENGE,
    clockUnixNs: options.clockUnixNs ?? (() => NOW_NS),
    nonceBytes: options.nonceBytes ?? deterministicNonce(),
  });
}

function signedReceipt(options: Partial<{
  privateKey: KeyObject;
  challenge: string;
  input: GpuParentRuntimeProofAdmissionReceiptInput;
  nonceSeed: number;
}> = {}): Readonly<{
  privateKey: KeyObject;
  signer: GpuParentRuntimeProofAdmissionReceiptSigner;
  receipt: GpuParentRuntimeProofAdmissionReceipt;
}> {
  const privateKey = options.privateKey
    ?? generateKeyPairSync("ed25519").privateKey;
  const receiptSigner = signer(privateKey, {
    challenge: options.challenge,
    nonceBytes: deterministicNonce(options.nonceSeed),
  });
  return {
    privateKey,
    signer: receiptSigner,
    receipt: receiptSigner.sign(options.input ?? admissionInput()),
  };
}

function mutableReceipt(
  receipt: GpuParentRuntimeProofAdmissionReceipt,
): Record<string, unknown> {
  return structuredClone(receipt) as unknown as Record<string, unknown>;
}

function expectSupportOnly(
  result: GpuParentRuntimeProofAdmissionReceiptVerification,
): void {
  expect(result).toMatchObject({
    verificationAuthority:
      GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_VERIFICATION_AUTHORITY,
    replayChecked: false,
    freshnessChecked: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

describe("GpuParentRuntimeProofAdmissionReceiptSigner", () => {
  it("signs both admitted stages and verifies with an independently supplied key and challenge", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const receiptSigner = signer(privateKey);
    const trustedKey = receiptSigner.exportVerificationKey();
    const first = receiptSigner.signAdmissionReceipt(admissionInput());
    const second = receiptSigner.signAdmissionReceipt(admissionInput());

    expect(Reflect.ownKeys(receiptSigner)).not.toContain("privateKey");
    expect(Reflect.ownKeys(receiptSigner)).not.toContain("sequence");
    expect(Reflect.ownKeys(receiptSigner)).not.toContain("nonceBytes");
    const rawPublicKey = Buffer.from(trustedKey.publicKey, "base64url");
    expect(trustedKey).toEqual({
      schemaVersion:
        GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_VERIFICATION_KEY_SCHEMA,
      algorithm: GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_ALGORITHM,
      keyId: `gpu-hmr-mcp-admission-key:sha256:${sha256Hex(rawPublicKey)}`,
      producer: GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_PRODUCER,
      publicKey: rawPublicKey.toString("base64url"),
    });
    expect(Object.isFrozen(trustedKey)).toBe(true);
    expect(first).toMatchObject({
      schemaVersion: GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_SCHEMA,
      algorithm: GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_ALGORITHM,
      signerKeyId: trustedKey.keyId,
      producer: GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_PRODUCER,
      proofAuthority: GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_AUTHORITY,
      controlStageAdmitted: true,
      parentProofStageAdmitted: true,
      admittedAtUnixNs: NOW_NS.toString(),
      sequence: "1",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(second.sequence).toBe("2");
    expect(first.receiptId)
      .toMatch(/^gpu-hmr-mcp-admission-receipt:sha256:[a-f0-9]{64}$/);
    expect(first.signature).toMatch(/^ed25519:[A-Za-z0-9_-]{86}$/);
    expect(first).not.toHaveProperty("publicKey");
    expect(first).not.toHaveProperty("verificationKey");
    expect(first).not.toHaveProperty("verified");
    expect(Object.isFrozen(first)).toBe(true);

    const result = verifyGpuParentRuntimeProofAdmissionReceipt(
      trustedKey,
      first,
      VALIDATION_RUN_CHALLENGE,
    );
    expect(result).toMatchObject({
      verified: true,
      reason: null,
      receiptId: first.receiptId,
      admittedAtUnixNs: NOW_NS,
      sequence: 1n,
      replayScope: {
        signerKeyId: trustedKey.keyId,
        transportSessionId: first.transportSessionId,
      },
    });
    expect(result.replayScope?.replayScopeId)
      .toMatch(/^gpu-hmr-mcp-admission-replay-scope:sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.replayScope)).toBe(true);
    expectSupportOnly(result);

    expect(verifyGpuHmrMcpAdmissionReceipt(
      trustedKey,
      first,
      VALIDATION_RUN_CHALLENGE,
    )).toEqual(result);
    expect(parseGpuParentRuntimeProofAdmissionReceiptVerificationKey(trustedKey))
      .toEqual(trustedKey);
  });

  it("rejects cross-protocol receipts under the same key and challenge", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const admissionSigner = signer(privateKey);
    const outputSigner = new GpuMcpOutputObservationReceiptSigner({
      privateKey,
      validationRunChallenge: VALIDATION_RUN_CHALLENGE,
      clockMonotonicNs: () => 91n,
      clockUnixNs: () => NOW_NS,
      nonceBytes: () => Buffer.alloc(32, 0x73),
    });
    const trustedKey = admissionSigner.exportVerificationKey();
    const admissionReceipt = admissionSigner.sign(admissionInput());
    const outputReceipt = outputSigner.sign({
      transportSessionId: "opaque-transport-session:domain-separation-01",
      requestChallengeSha256: hash("a"),
      runtimeBindingSha256: hash("b"),
      producerObservationSha256: hash("c"),
      outputContentSha256: hash("d"),
      outputByteLength: "512",
    });
    const {
      receiptId: _admissionReceiptId,
      signature: _admissionSignature,
      ...unsignedAdmissionReceipt
    } = admissionReceipt;
    const {
      receiptId: _outputReceiptId,
      signature: _outputSignature,
      ...unsignedOutputReceipt
    } = outputReceipt;
    const admissionSigningBytes =
      createGpuHmrMcpAdmissionReceiptSigningBytes(unsignedAdmissionReceipt);
    const outputSigningBytes =
      createGpuHmrMcpOutputObservationReceiptSigningBytes(unsignedOutputReceipt);
    expect(Buffer.isBuffer(admissionSigningBytes)).toBe(true);
    expect(Buffer.isBuffer(outputSigningBytes)).toBe(true);
    const admissionMaterial = JSON.parse(admissionSigningBytes.toString("utf8"));
    const outputMaterial = JSON.parse(outputSigningBytes.toString("utf8"));
    expect(admissionMaterial[0]).not.toBe(outputMaterial[0]);

    const admissionShapeWithOutputDomain = [
      outputMaterial[0],
      ...admissionMaterial.slice(1),
    ];
    const outputShapeWithAdmissionDomain = [
      admissionMaterial[0],
      ...outputMaterial.slice(1),
    ];
    const crossSignedAdmissionReceipt = finalizeGpuHmrMcpAdmissionReceipt(
      unsignedAdmissionReceipt,
      `ed25519:${signBytes(
        null,
        Buffer.from(JSON.stringify(admissionShapeWithOutputDomain), "utf8"),
        privateKey,
      ).toString("base64url")}`,
    );
    const crossSignedOutputReceipt = finalizeGpuHmrMcpOutputObservationReceipt(
      unsignedOutputReceipt,
      `ed25519:${signBytes(
        null,
        Buffer.from(JSON.stringify(outputShapeWithAdmissionDomain), "utf8"),
        privateKey,
      ).toString("base64url")}`,
    );
    expect(crossSignedAdmissionReceipt).not.toBeNull();
    expect(crossSignedOutputReceipt).not.toBeNull();

    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      trustedKey,
      crossSignedAdmissionReceipt,
      VALIDATION_RUN_CHALLENGE,
    )).toMatchObject({
      verified: false,
      reason: "gpu_hmr_mcp_admission_signature_mismatch",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(verifyGpuMcpOutputObservationReceipt(
      trustedKey,
      crossSignedOutputReceipt,
      VALIDATION_RUN_CHALLENGE,
    )).toMatchObject({
      signatureVerified: false,
      reason: "gpu_hmr_mcp_output_observation_signature_mismatch",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
  });

  it("rejects a different trusted MCP key and a different external validation-run challenge", () => {
    const original = signedReceipt();
    const other = signedReceipt();

    const wrongKey = verifyGpuParentRuntimeProofAdmissionReceipt(
      other.signer.exportVerificationKey(),
      original.receipt,
      VALIDATION_RUN_CHALLENGE,
    );
    expect(wrongKey).toMatchObject({
      verified: false,
      reason: "gpu_hmr_mcp_admission_signer_key_mismatch",
      receiptId: null,
      admittedAtUnixNs: null,
      sequence: null,
      replayScope: null,
    });
    expectSupportOnly(wrongKey);

    const wrongChallenge = verifyGpuParentRuntimeProofAdmissionReceipt(
      original.signer.exportVerificationKey(),
      original.receipt,
      OTHER_VALIDATION_RUN_CHALLENGE,
    );
    expect(wrongChallenge).toMatchObject({
      verified: false,
      reason: "gpu_hmr_mcp_admission_validation_run_challenge_mismatch",
    });
    expectSupportOnly(wrongChallenge);
  });

  const identityTampering: ReadonlyArray<readonly [
    string,
    (receipt: Record<string, unknown>) => void,
  ]> = [
    ["transport session", (receipt) => {
      receipt.transportSessionId = "opaque-transport-session:other";
    }],
    ["compile nonce", (receipt) => {
      receipt.compileRequestNonce =
        `gpu-proof-transport-request:${"e".repeat(32)}`;
    }],
    ["expected output contract", (receipt) => {
      receipt.computeExpectedOutputContractHash = hash("0");
    }],
    ["expected output semantics", (receipt) => {
      receipt.computeExpectedOutputSemanticsHash = hash("1");
    }],
    ["worker key", (receipt) => {
      receipt.workerKeyId =
        `gpu-hmr-runtime-evidence-transport-key:sha256:${"a".repeat(64)}`;
    }],
    ["worker key announcement", (receipt) => {
      receipt.workerKeyAnnouncementId =
        `gpu-hmr-runtime-evidence-transport-key-announcement:sha256:${"b".repeat(64)}`;
    }],
    ["worker process", (receipt) => {
      receipt.workerProcessId = "9124";
    }],
    ["control binding", (receipt) => {
      receipt.controlBindingCanonicalSha256 = hash("c");
      receipt.controlBindingId =
        `gpu-parent-runtime-proof-control-binding:${hash("c")}`;
    }],
    ["control transport receipt", (receipt) => {
      receipt.controlTransportReceiptId =
        `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"d".repeat(64)}`;
    }],
    ["control observation context", (receipt) => {
      receipt.controlObservationContextHash = hash("e");
    }],
    ["parent receipt", (receipt) => {
      receipt.parentReceiptId =
        `gpu-parent-runtime-proof-receipt:sha256:${"f".repeat(64)}`;
    }],
    ["parent transport receipt", (receipt) => {
      receipt.parentTransportReceiptId =
        `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"0".repeat(64)}`;
    }],
    ["parent canonical proof", (receipt) => {
      receipt.parentCanonicalProofSha256 = hash("1");
    }],
    ["parent observation context", (receipt) => {
      receipt.parentObservationContextHash = hash("2");
    }],
    ["request", (receipt) => {
      receipt.requestId = `gpu-reload:request:${"3".repeat(32)}`;
    }],
    ["source edit", (receipt) => {
      receipt.sourceEditId = `source-edit:sha256:${"4".repeat(64)}`;
    }],
    ["artifact", (receipt) => {
      receipt.artifactContentHash = hash("5");
    }],
    ["full runtime proof", (receipt) => {
      receipt.fullRuntimeProofId =
        `gpu-runtime-proof:sha256:${"6".repeat(64)}`;
    }],
    ["ledger", (receipt) => {
      receipt.proofLedgerId =
        `gpu-ledger-proof:sha256:${"7".repeat(64)}`;
    }],
    ["runner process", (receipt) => {
      receipt.runnerProcessId = 8124;
    }],
    ["runner session", (receipt) => {
      receipt.runnerRuntimeSessionId = "opaque-runtime-session:other";
    }],
    ["runner challenge", (receipt) => {
      receipt.runnerChallenge = "8".repeat(32);
    }],
    ["command envelope", (receipt) => {
      receipt.commandEnvelopeSha256 = hash("9");
    }],
    ["protected proof", (receipt) => {
      receipt.protectedProofJsonSha256 = hash("a");
    }],
    ["admission timestamp", (receipt) => {
      receipt.admittedAtUnixNs = (NOW_NS + 1n).toString();
    }],
    ["sequence", (receipt) => {
      receipt.sequence = "2";
    }],
    ["nonce", (receipt) => {
      receipt.nonce = Buffer.alloc(32, 0x77).toString("base64url");
    }],
  ];

  it.each(identityTampering)(
    "cryptographically rejects valid-shaped %s tampering",
    (_label, tamper) => {
      const signed = signedReceipt();
      const tampered = mutableReceipt(signed.receipt);
      tamper(tampered);

      const result = verifyGpuParentRuntimeProofAdmissionReceipt(
        signed.signer.exportVerificationKey(),
        tampered,
        VALIDATION_RUN_CHALLENGE,
      );
      expect(result.verified).toBe(false);
      expectSupportOnly(result);
    },
  );

  it("rejects acceptance claims, stage downgrades, receipt-ID changes, and signature changes", () => {
    const signed = signedReceipt();
    const mutations: ReadonlyArray<readonly [string, unknown]> = [
      ["acceptedForGpuHmr", true],
      ["gpuHmrSuccess", true],
      ["canSatisfyRuntimeProof", true],
      ["controlStageAdmitted", false],
      ["parentProofStageAdmitted", false],
      ["proofAuthority", "mcp_signed_gpu_hmr_acceptance"],
      [
        "receiptId",
        `gpu-hmr-mcp-admission-receipt:sha256:${"0".repeat(64)}`,
      ],
      ["signature", `ed25519:${Buffer.alloc(64).toString("base64url")}`],
    ];
    for (const [field, value] of mutations) {
      const tampered = mutableReceipt(signed.receipt);
      tampered[field] = value;
      const result = verifyGpuParentRuntimeProofAdmissionReceipt(
        signed.signer.exportVerificationKey(),
        tampered,
        VALIDATION_RUN_CHALLENGE,
      );
      expect(result.verified, field).toBe(false);
      expectSupportOnly(result);
    }
  });

  it("rejects an arbitrary self-signed verification key embedded as an extra receipt field", () => {
    const trusted = signedReceipt();
    const attacker = signedReceipt();
    const forged = mutableReceipt(attacker.receipt);
    forged.publicKey = attacker.signer.exportVerificationKey().publicKey;

    const result = verifyGpuParentRuntimeProofAdmissionReceipt(
      trusted.signer.exportVerificationKey(),
      forged,
      VALIDATION_RUN_CHALLENGE,
    );
    expect(result).toMatchObject({
      verified: false,
      reason: "gpu_hmr_mcp_admission_receipt_shape_invalid",
    });
    expectSupportOnly(result);
  });

  it("advances atomically and exposes enough signed material for caller-side replay policy", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const primary = signer(privateKey, { nonceBytes: deterministicNonce(0x41) });
    const restarted = signer(privateKey, { nonceBytes: deterministicNonce(0x51) });
    const trustedKey = primary.exportVerificationKey();
    const first = primary.sign(admissionInput());
    const second = primary.sign(admissionInput());
    const staleAfterRestart = restarted.sign(admissionInput());
    const firstResult = verifyGpuParentRuntimeProofAdmissionReceipt(
      trustedKey,
      first,
      VALIDATION_RUN_CHALLENGE,
    );
    const secondResult = verifyGpuParentRuntimeProofAdmissionReceipt(
      trustedKey,
      second,
      VALIDATION_RUN_CHALLENGE,
    );
    const staleResult = verifyGpuParentRuntimeProofAdmissionReceipt(
      trustedKey,
      staleAfterRestart,
      VALIDATION_RUN_CHALLENGE,
    );
    expect(firstResult.verified).toBe(true);
    expect(secondResult.verified).toBe(true);
    expect(staleResult.verified).toBe(true);
    expect(staleAfterRestart.receiptId).not.toBe(first.receiptId);

    const replayState = new Map<string, Readonly<{
      sequence: bigint;
      receiptId: string;
    }>>();
    const consumeIfNewer = (
      result: GpuParentRuntimeProofAdmissionReceiptVerification,
    ): boolean => {
      if (!result.verified) return false;
      const previous = replayState.get(result.replayScope.replayScopeId);
      if (
        previous !== undefined
        && (
          result.sequence <= previous.sequence
          || result.receiptId === previous.receiptId
        )
      ) {
        return false;
      }
      replayState.set(result.replayScope.replayScopeId, {
        sequence: result.sequence,
        receiptId: result.receiptId,
      });
      return true;
    };

    expect(consumeIfNewer(firstResult)).toBe(true);
    expect(consumeIfNewer(firstResult)).toBe(false);
    expect(consumeIfNewer(secondResult)).toBe(true);
    expect(consumeIfNewer(staleResult)).toBe(false);
    expect(secondResult).toMatchObject({
      replayChecked: false,
      freshnessChecked: false,
    });
  });

  it("snapshots admission input before injected callbacks and isolates the receipt from later mutation", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const input = admissionInput();
    const original = structuredClone(input);
    const inputRecord = input as unknown as Record<string, unknown>;
    const receiptSigner = signer(privateKey, {
      clockUnixNs: () => {
        inputRecord.requestId = `gpu-reload:request:${"0".repeat(32)}`;
        inputRecord.runnerProcessId = 1;
        return NOW_NS;
      },
    });

    const receipt = receiptSigner.sign(input);
    inputRecord.transportSessionId = "opaque-transport-session:mutated";
    inputRecord.commandEnvelopeSha256 = hash("f");

    expect(receipt).toMatchObject(original);
    expect(receipt.requestId).toBe(original.requestId);
    expect(receipt.runnerProcessId).toBe(original.runnerProcessId);
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      receiptSigner.exportVerificationKey(),
      receipt,
      VALIDATION_RUN_CHALLENGE,
    ).verified).toBe(true);
  });

  it("does not consume a sequence when clock or nonce acquisition fails", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    let failClock = true;
    const receiptSigner = signer(privateKey, {
      clockUnixNs: () => {
        if (failClock) {
          failClock = false;
          throw new Error("clock unavailable");
        }
        return NOW_NS;
      },
    });
    expect(() => receiptSigner.sign(admissionInput()))
      .toThrow("gpu_parent_runtime_proof_admission_receipt_clock_failed");
    expect(receiptSigner.sign(admissionInput()).sequence).toBe("1");

    let failNonce = true;
    const nonceSigner = signer(privateKey, {
      nonceBytes: () => {
        if (failNonce) {
          failNonce = false;
          throw new Error("entropy unavailable");
        }
        return Buffer.alloc(32, 0x61);
      },
    });
    expect(() => nonceSigner.sign(admissionInput()))
      .toThrow("gpu_parent_runtime_proof_admission_receipt_nonce_source_failed");
    expect(nonceSigner.sign(admissionInput()).sequence).toBe("1");
  });

  it("suppresses reentrant signing without consuming sequence state", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    let receiptSigner!: GpuParentRuntimeProofAdmissionReceiptSigner;
    let attemptReentry = true;
    const nonceBytes = vi.fn(deterministicNonce(0x71));
    receiptSigner = signer(privateKey, {
      clockUnixNs: () => {
        if (attemptReentry) {
          attemptReentry = false;
          expect(() => receiptSigner.sign(admissionInput()))
            .toThrow("gpu_parent_runtime_proof_admission_receipt_signer_busy");
        }
        return NOW_NS;
      },
      nonceBytes,
    });

    const first = receiptSigner.sign(admissionInput());
    const second = receiptSigner.sign(admissionInput());

    expect(first.sequence).toBe("1");
    expect(second.sequence).toBe("2");
    expect(nonceBytes).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["number", () => 1 as unknown as bigint],
    ["negative", () => -1n],
    ["u64 overflow", () => 18_446_744_073_709_551_616n],
  ] as const)("rejects an invalid %s clock result", (_label, clockUnixNs) => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const receiptSigner = signer(privateKey, { clockUnixNs });
    expect(() => receiptSigner.sign(admissionInput()))
      .toThrow("gpu_parent_runtime_proof_admission_receipt_clock_invalid");
  });

  it("rejects invalid and proxied nonce results without invoking proxy traps", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const shortNonceSigner = signer(privateKey, {
      nonceBytes: () => Buffer.alloc(31),
    });
    expect(() => shortNonceSigner.sign(admissionInput()))
      .toThrow("gpu_parent_runtime_proof_admission_receipt_nonce_source_invalid");

    let trapCalls = 0;
    const failTrap = (): never => {
      trapCalls += 1;
      throw new Error("proxy trap must not run");
    };
    const proxiedNonce = new Proxy(Buffer.alloc(32), {
      get: failTrap,
      getOwnPropertyDescriptor: failTrap,
      getPrototypeOf: failTrap,
      ownKeys: failTrap,
    });
    const proxyNonceSigner = signer(privateKey, {
      nonceBytes: () => proxiedNonce,
    });
    expect(() => proxyNonceSigner.sign(admissionInput()))
      .toThrow("gpu_parent_runtime_proof_admission_receipt_nonce_source_invalid");
    expect(trapCalls).toBe(0);
  });

  it("fails closed after disposal, including disposal from an injected callback", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const disposed = signer(privateKey);
    const trustedKey = disposed.exportVerificationKey();
    disposed.dispose();
    disposed.dispose();
    expect(disposed.exportVerificationKey()).toBe(trustedKey);
    expect(() => disposed.sign(admissionInput()))
      .toThrow("gpu_parent_runtime_proof_admission_receipt_signer_disposed");

    let duringClock!: GpuParentRuntimeProofAdmissionReceiptSigner;
    const nonceBytes = vi.fn(() => Buffer.alloc(32));
    duringClock = signer(privateKey, {
      clockUnixNs: () => {
        duringClock.dispose();
        return NOW_NS;
      },
      nonceBytes,
    });
    expect(() => duringClock.sign(admissionInput()))
      .toThrow("gpu_parent_runtime_proof_admission_receipt_signer_disposed");
    expect(nonceBytes).not.toHaveBeenCalled();
  });
});

describe("strict MCP admission receipt data boundaries", () => {
  it("rejects getters in signer input, trusted keys, and receipts without invoking them", () => {
    const signed = signedReceipt();
    const trustedKey = signed.signer.exportVerificationKey();
    const input = admissionInput() as unknown as Record<string, unknown>;
    const key = { ...trustedKey } as Record<string, unknown>;
    const receipt = mutableReceipt(signed.receipt);
    let getterCalls = 0;
    for (const [value, field, original] of [
      [input, "requestId", input.requestId],
      [key, "publicKey", key.publicKey],
      [receipt, "parentReceiptId", receipt.parentReceiptId],
    ] as const) {
      Object.defineProperty(value, field, {
        enumerable: true,
        configurable: true,
        get: () => {
          getterCalls += 1;
          return original;
        },
      });
    }

    expect(parseGpuHmrMcpAdmissionReceiptSigningInput(input)).toBeNull();
    expect(() => signed.signer.sign(
      input as unknown as GpuParentRuntimeProofAdmissionReceiptInput,
    )).toThrow("gpu_parent_runtime_proof_admission_receipt_input_invalid");
    expect(parseGpuParentRuntimeProofAdmissionReceiptVerificationKey(key)).toBeNull();
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      key,
      signed.receipt,
      VALIDATION_RUN_CHALLENGE,
    ).reason).toBe("gpu_hmr_mcp_admission_verification_key_invalid");
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      trustedKey,
      receipt,
      VALIDATION_RUN_CHALLENGE,
    ).reason).toBe("gpu_hmr_mcp_admission_receipt_shape_invalid");
    expect(getterCalls).toBe(0);
  });

  it("rejects proxied input, trusted keys, and receipts without invoking proxy traps", () => {
    const signed = signedReceipt();
    let trapCalls = 0;
    const failTrap = (): never => {
      trapCalls += 1;
      throw new Error("proxy trap must not run");
    };
    const traps = {
      get: failTrap,
      getOwnPropertyDescriptor: failTrap,
      getPrototypeOf: failTrap,
      ownKeys: failTrap,
    };
    const proxiedInput = new Proxy(admissionInput(), traps);
    const proxiedKey = new Proxy(signed.signer.exportVerificationKey(), traps);
    const proxiedReceipt = new Proxy(signed.receipt, traps);

    expect(() => signed.signer.sign(proxiedInput))
      .toThrow("gpu_parent_runtime_proof_admission_receipt_input_invalid");
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      proxiedKey,
      signed.receipt,
      VALIDATION_RUN_CHALLENGE,
    ).reason).toBe("gpu_hmr_mcp_admission_verification_key_invalid");
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      signed.signer.exportVerificationKey(),
      proxiedReceipt,
      VALIDATION_RUN_CHALLENGE,
    ).reason).toBe("gpu_hmr_mcp_admission_receipt_shape_invalid");
    expect(trapCalls).toBe(0);
  });

  it("rejects symbols, non-enumerable fields, wrong prototypes, extras, and missing keys", () => {
    const signed = signedReceipt();
    const trustedKey = signed.signer.exportVerificationKey();
    const invalidReceipts: Record<PropertyKey, unknown>[] = [];

    const symbolReceipt = mutableReceipt(signed.receipt);
    symbolReceipt[Symbol("self-signed-key")] = trustedKey.publicKey;
    invalidReceipts.push(symbolReceipt);

    const hiddenReceipt = mutableReceipt(signed.receipt);
    Object.defineProperty(hiddenReceipt, "nonce", {
      value: hiddenReceipt.nonce,
      enumerable: false,
    });
    invalidReceipts.push(hiddenReceipt);

    invalidReceipts.push(Object.assign(Object.create({}), signed.receipt));
    invalidReceipts.push({ ...signed.receipt, arbitraryAuthority: true });
    const missingReceipt = mutableReceipt(signed.receipt);
    delete missingReceipt.parentReceiptId;
    invalidReceipts.push(missingReceipt);

    for (const receipt of invalidReceipts) {
      expect(verifyGpuParentRuntimeProofAdmissionReceipt(
        trustedKey,
        receipt,
        VALIDATION_RUN_CHALLENGE,
      ).reason).toBe("gpu_hmr_mcp_admission_receipt_shape_invalid");
    }

    const symbolKey = { ...trustedKey } as Record<PropertyKey, unknown>;
    symbolKey[Symbol("alias")] = trustedKey.keyId;
    expect(parseGpuParentRuntimeProofAdmissionReceiptVerificationKey(symbolKey))
      .toBeNull();
    const hiddenKey = { ...trustedKey };
    Object.defineProperty(hiddenKey, "keyId", {
      value: hiddenKey.keyId,
      enumerable: false,
    });
    expect(parseGpuParentRuntimeProofAdmissionReceiptVerificationKey(hiddenKey))
      .toBeNull();
    expect(parseGpuParentRuntimeProofAdmissionReceiptVerificationKey(
      Object.assign(Object.create({}), trustedKey),
    )).toBeNull();

    const wrongPrototypeInput = Object.assign(Object.create({}), admissionInput());
    expect(() => signed.signer.sign(wrongPrototypeInput))
      .toThrow("gpu_parent_runtime_proof_admission_receipt_input_invalid");
    const symbolInput = admissionInput() as unknown as Record<PropertyKey, unknown>;
    symbolInput[Symbol("alias")] = symbolInput.requestId;
    expect(() => signed.signer.sign(
      symbolInput as unknown as GpuParentRuntimeProofAdmissionReceiptInput,
    )).toThrow("gpu_parent_runtime_proof_admission_receipt_input_invalid");
  });

  it("rejects noncanonical base64url in keys, challenges, nonces, and signatures", () => {
    const signed = signedReceipt();
    const trustedKey = signed.signer.exportVerificationKey();
    const paddedKey = { ...trustedKey, publicKey: `${trustedKey.publicKey}=` };
    expect(parseGpuParentRuntimeProofAdmissionReceiptVerificationKey(paddedKey))
      .toBeNull();
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      trustedKey,
      signed.receipt,
      `${VALIDATION_RUN_CHALLENGE}=`,
    ).reason).toBe("gpu_hmr_mcp_admission_expected_challenge_invalid");

    const paddedNonce = mutableReceipt(signed.receipt);
    paddedNonce.nonce = `${paddedNonce.nonce as string}=`;
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      trustedKey,
      paddedNonce,
      VALIDATION_RUN_CHALLENGE,
    ).reason).toBe("gpu_hmr_mcp_admission_receipt_shape_invalid");

    const paddedSignature = mutableReceipt(signed.receipt);
    paddedSignature.signature = `${paddedSignature.signature as string}=`;
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      trustedKey,
      paddedSignature,
      VALIDATION_RUN_CHALLENGE,
    ).reason).toBe("gpu_hmr_mcp_admission_receipt_shape_invalid");

    const { privateKey } = generateKeyPairSync("ed25519");
    expect(() => signer(privateKey, {
      challenge: `${VALIDATION_RUN_CHALLENGE}=`,
    })).toThrow(
      "gpu_parent_runtime_proof_admission_receipt_validation_run_challenge_invalid",
    );
  });

  it("rejects invalid process numbers and noncanonical decimal u64 fields", () => {
    const signed = signedReceipt();
    for (const runnerProcessId of [0, -1, 1.5, Number.NaN, 0x1_0000_0000]) {
      const input = {
        ...admissionInput(),
        runnerProcessId,
      };
      expect(() => signed.signer.sign(input), String(runnerProcessId))
        .toThrow("gpu_parent_runtime_proof_admission_receipt_input_invalid");
    }
    for (const workerProcessId of ["0", "01", "4294967296"]) {
      const input = {
        ...admissionInput(),
        workerProcessId,
      };
      expect(() => signed.signer.sign(input), workerProcessId)
        .toThrow("gpu_parent_runtime_proof_admission_receipt_input_invalid");
    }

    const invalidDecimals: ReadonlyArray<readonly [string, unknown]> = [
      ["admittedAtUnixNs", "01"],
      ["admittedAtUnixNs", "18446744073709551616"],
      ["admittedAtUnixNs", 1],
      ["sequence", "0"],
      ["sequence", "01"],
      ["sequence", "18446744073709551616"],
      ["sequence", 1],
    ];
    for (const [field, value] of invalidDecimals) {
      const receipt = mutableReceipt(signed.receipt);
      receipt[field] = value;
      expect(verifyGpuParentRuntimeProofAdmissionReceipt(
        signed.signer.exportVerificationKey(),
        receipt,
        VALIDATION_RUN_CHALLENGE,
      ).reason, `${field}:${String(value)}`)
        .toBe("gpu_hmr_mcp_admission_receipt_shape_invalid");
    }
  });

  it("strictly validates signer context objects without executing accessors or proxies", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    let getterCalls = 0;
    const getterContext = {
      validationRunChallenge: VALIDATION_RUN_CHALLENGE,
    } as Record<string, unknown>;
    Object.defineProperty(getterContext, "privateKey", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return privateKey;
      },
    });
    expect(() => new GpuParentRuntimeProofAdmissionReceiptSigner(
      getterContext as unknown as never,
    )).toThrow(
      "gpu_parent_runtime_proof_admission_receipt_signer_context_invalid",
    );
    expect(getterCalls).toBe(0);

    let trapCalls = 0;
    const failTrap = (): never => {
      trapCalls += 1;
      throw new Error("proxy trap must not run");
    };
    const proxyContext = new Proxy({
      privateKey,
      validationRunChallenge: VALIDATION_RUN_CHALLENGE,
    }, {
      get: failTrap,
      getOwnPropertyDescriptor: failTrap,
      getPrototypeOf: failTrap,
      ownKeys: failTrap,
    });
    expect(() => new GpuParentRuntimeProofAdmissionReceiptSigner(proxyContext))
      .toThrow(
        "gpu_parent_runtime_proof_admission_receipt_signer_context_invalid",
      );
    expect(trapCalls).toBe(0);

    expect(() => new GpuParentRuntimeProofAdmissionReceiptSigner({
      privateKey,
      validationRunChallenge: VALIDATION_RUN_CHALLENGE,
      extra: true,
    } as unknown as never)).toThrow(
      "gpu_parent_runtime_proof_admission_receipt_signer_context_invalid",
    );
  });
});
