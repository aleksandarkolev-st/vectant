import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GpuParentRuntimeProofAdmissionReceiptSigner,
  type GpuParentRuntimeProofAdmissionReceiptInput,
} from "../../src/gpu_parent_runtime_proof_admission_receipt.js";
import {
  createGpuHmrMcpAdmissionReplayRegistry,
  GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_AUTHORITY,
  verifiedGpuHmrMcpAdmissionReceiptProjection,
  verifyGpuHmrMcpAdmissionReceiptForMatrix,
} from "../../scripts/lib/gpu-hmr-mcp-admission-receipt-matrix-verifier.mjs";

const NOW_NS = 1_784_500_000_123_456_789n;
const MAX_AGE_NS = 30_000_000_000n;
const MAX_FUTURE_SKEW_NS = 1_000_000_000n;
const CHALLENGE = Buffer.alloc(32, 0x27).toString("base64url");
const OTHER_CHALLENGE = Buffer.alloc(32, 0x28).toString("base64url");

function hash(digit: string): string {
  return `sha256:${digit.repeat(64)}`;
}

function admissionInput(
  overrides: Partial<GpuParentRuntimeProofAdmissionReceiptInput> = {},
): GpuParentRuntimeProofAdmissionReceiptInput {
  const controlBindingCanonicalSha256 = hash("4");
  return {
    transportSessionId: "opaque-transport-session:matrix-01",
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
    runnerRuntimeSessionId: "opaque-runtime-session:matrix-02",
    runnerChallenge: "23456789abcdef0123456789abcdef01",
    commandEnvelopeSha256: hash("2"),
    protectedProofJsonSha256: hash("3"),
    ...overrides,
  };
}

function deterministicNonce(seed = 0x41): () => Uint8Array {
  let next = seed;
  return () => Buffer.alloc(32, next++);
}

function receiptSigner(
  privateKey: KeyObject,
  options: Partial<{
    challenge: string;
    clockUnixNs: () => bigint;
    nonceBytes: () => Uint8Array;
  }> = {},
): GpuParentRuntimeProofAdmissionReceiptSigner {
  return new GpuParentRuntimeProofAdmissionReceiptSigner({
    privateKey,
    validationRunChallenge: options.challenge ?? CHALLENGE,
    clockUnixNs: options.clockUnixNs ?? (() => NOW_NS),
    nonceBytes: options.nonceBytes ?? deterministicNonce(),
  });
}

function expectedBinding(input: GpuParentRuntimeProofAdmissionReceiptInput) {
  return {
    transportSessionId: input.transportSessionId,
    compileRequestNonce: input.compileRequestNonce,
    computeExpectedOutputContractHash: input.computeExpectedOutputContractHash,
    computeExpectedOutputSemanticsHash: input.computeExpectedOutputSemanticsHash,
    artifactContentHash: input.artifactContentHash,
    fullRuntimeProofId: input.fullRuntimeProofId,
    proofLedgerId: input.proofLedgerId,
    runnerRuntimeSessionId: input.runnerRuntimeSessionId,
  };
}

function verificationContext(options: Partial<{
  signer: GpuParentRuntimeProofAdmissionReceiptSigner;
  input: GpuParentRuntimeProofAdmissionReceiptInput;
  receipt: ReturnType<GpuParentRuntimeProofAdmissionReceiptSigner["sign"]>;
  challenge: string;
  nowUnixNs: bigint;
  maxAgeNs: bigint;
  maxFutureSkewNs: bigint;
  replayRegistry: ReturnType<typeof createGpuHmrMcpAdmissionReplayRegistry>;
  expectedBinding: ReturnType<typeof expectedBinding>;
}> = {}) {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const signer = options.signer ?? receiptSigner(privateKey);
  const input = options.input ?? admissionInput();
  return {
    trustedVerificationKey: signer.exportVerificationKey(),
    validationRunChallenge: options.challenge ?? CHALLENGE,
    receipt: options.receipt ?? signer.sign(input),
    nowUnixNs: options.nowUnixNs ?? NOW_NS,
    maxAgeNs: options.maxAgeNs ?? MAX_AGE_NS,
    maxFutureSkewNs: options.maxFutureSkewNs ?? MAX_FUTURE_SKEW_NS,
    replayRegistry:
      options.replayRegistry ?? createGpuHmrMcpAdmissionReplayRegistry(),
    expectedBinding: options.expectedBinding ?? expectedBinding(input),
  };
}

function expectSupportOnly(result: ReturnType<
  typeof verifyGpuHmrMcpAdmissionReceiptForMatrix
>): void {
  expect(result).toMatchObject({
    proofAuthority: GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_AUTHORITY,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

describe("MCP admission receipt matrix verifier", () => {
  it("accepts fresh externally trusted receipts and exposes only branded projections", () => {
    const result = verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext(),
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: null,
      signatureVerified: true,
      challengeBound: true,
      bindingChecked: true,
      freshnessChecked: true,
      replayChecked: true,
    });
    expectSupportOnly(result);
    expect(verifiedGpuHmrMcpAdmissionReceiptProjection(result)).toMatchObject({
      required: true,
      contractHash: hash("a"),
      semanticsHash: hash("b"),
      compileTransportNonce:
        `gpu-proof-transport-request:${"1".repeat(32)}`,
      artifactContentHash: hash("e"),
      fullRuntimeProofId: `gpu-runtime-proof:sha256:${"f".repeat(64)}`,
      proofLedgerId: `gpu-ledger-proof:sha256:${"1".repeat(64)}`,
      runtimeSessionId: "opaque-runtime-session:matrix-02",
    });
    expect(verifiedGpuHmrMcpAdmissionReceiptProjection({
      accepted: true,
      signatureVerified: true,
    })).toBeNull();
  });

  it("rejects wrong keys, wrong challenges, and self-signed receipts", () => {
    const trustedSigner = receiptSigner(generateKeyPairSync("ed25519").privateKey);
    const attackerSigner = receiptSigner(generateKeyPairSync("ed25519").privateKey);
    const input = admissionInput();
    const attackerReceipt = attackerSigner.sign(input);

    const wrongKey = verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...verificationContext({ signer: trustedSigner, input }),
      receipt: attackerReceipt,
    });
    expect(wrongKey).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_signer_key_mismatch",
    });
    expectSupportOnly(wrongKey);

    const wrongChallenge = verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...verificationContext({ signer: trustedSigner, input }),
      validationRunChallenge: OTHER_CHALLENGE,
    });
    expect(wrongChallenge).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_validation_run_challenge_mismatch",
    });
  });

  it("rejects stale and excessively future-dated receipts", () => {
    const stale = verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ nowUnixNs: NOW_NS + MAX_AGE_NS + 1n }),
    );
    expect(stale).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_receipt_stale",
      freshnessChecked: true,
    });

    const futureSigner = receiptSigner(generateKeyPairSync("ed25519").privateKey, {
      clockUnixNs: () => NOW_NS + MAX_FUTURE_SKEW_NS + 1n,
    });
    const future = verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ signer: futureSigner }),
    );
    expect(future).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_receipt_from_future",
      freshnessChecked: true,
    });
  });

  it("rejects cross-ledger and other signed binding substitution", () => {
    const context = verificationContext();
    const crossLedger = verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...context,
      expectedBinding: {
        ...context.expectedBinding,
        proofLedgerId: `gpu-ledger-proof:sha256:${"2".repeat(64)}`,
      },
    });
    expect(crossLedger).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_signed_binding_mismatch",
      bindingChecked: true,
    });

    const context2 = verificationContext();
    const artifactSubstitution = verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...context2,
      expectedBinding: {
        ...context2.expectedBinding,
        artifactContentHash: hash("0"),
      },
    });
    expect(artifactSubstitution).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_signed_binding_mismatch",
    });
  });

  it("atomically rejects replay and sequence rollback across collector tasks", async () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey);
    const input = admissionInput();
    const first = signer.sign(input);
    const second = signer.sign(input);
    const registry = createGpuHmrMcpAdmissionReplayRegistry();
    const secondContext = verificationContext({
      signer,
      input,
      receipt: second,
      replayRegistry: registry,
    });
    expect(verifyGpuHmrMcpAdmissionReceiptForMatrix(secondContext).accepted)
      .toBe(true);
    expect(verifyGpuHmrMcpAdmissionReceiptForMatrix(secondContext)).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_receipt_replayed",
      replayChecked: true,
    });
    expect(verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...secondContext,
      receipt: first,
    })).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_sequence_not_increasing",
      replayChecked: true,
    });

    const parallelRegistry = createGpuHmrMcpAdmissionReplayRegistry();
    const parallelContext = verificationContext({
      signer,
      input,
      receipt: first,
      replayRegistry: parallelRegistry,
    });
    const parallel = await Promise.all([
      Promise.resolve().then(() =>
        verifyGpuHmrMcpAdmissionReceiptForMatrix(parallelContext)),
      Promise.resolve().then(() =>
        verifyGpuHmrMcpAdmissionReceiptForMatrix(parallelContext)),
    ]);
    expect(parallel.filter((result) => result.accepted)).toHaveLength(1);
    expect(parallel.filter((result) => !result.accepted)).toEqual([
      expect.objectContaining({
        reason: "gpu_hmr_mcp_admission_receipt_replayed",
      }),
    ]);
  });

  it("rejects nonce reuse even when the signed sequence increases", () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey, {
      nonceBytes: () => Buffer.alloc(32, 0x77),
    });
    const input = admissionInput();
    const first = signer.sign(input);
    const second = signer.sign(input);
    const replayRegistry = createGpuHmrMcpAdmissionReplayRegistry();

    expect(verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ signer, input, receipt: first, replayRegistry }),
    ).accepted).toBe(true);
    expect(verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ signer, input, receipt: second, replayRegistry }),
    )).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_nonce_replayed",
    });
  });

  it("fails closed when bounded replay state reaches capacity", () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey);
    const input = admissionInput();
    const replayRegistry = createGpuHmrMcpAdmissionReplayRegistry({
      maxScopes: 1,
      maxReceiptsPerScope: 2,
    });
    const receipts = [signer.sign(input), signer.sign(input), signer.sign(input)];
    expect(verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ signer, input, receipt: receipts[0], replayRegistry }),
    ).accepted).toBe(true);
    expect(verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ signer, input, receipt: receipts[1], replayRegistry }),
    ).accepted).toBe(true);
    expect(verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ signer, input, receipt: receipts[2], replayRegistry }),
    )).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_replay_scope_receipt_capacity_exhausted",
    });

    const otherSessionInput = admissionInput({
      transportSessionId: "opaque-transport-session:matrix-02",
    });
    expect(verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({
        signer,
        input: otherSessionInput,
        receipt: signer.sign(otherSessionInput),
        replayRegistry,
      }),
    )).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_replay_scope_capacity_exhausted",
    });
    expect(() => createGpuHmrMcpAdmissionReplayRegistry({
      maxScopes: 0,
      maxReceiptsPerScope: 1,
    })).toThrow("gpu_hmr_mcp_admission_replay_registry_capacity_invalid");
  });

  it("rejects forged registries, malformed freshness, and accessor contexts", () => {
    const base = verificationContext();
    expect(verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...base,
      replayRegistry: {
        schemaVersion: "synthi.gpu_hmr.mcp_admission_replay_registry.v1",
      },
    })).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_replay_registry_invalid",
    });
    expect(verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...base,
      nowUnixNs: Number(NOW_NS),
    })).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_freshness_policy_invalid",
    });

    const accessorContext = Object.create(Object.prototype);
    for (const [key, value] of Object.entries(base)) {
      Object.defineProperty(accessorContext, key, {
        enumerable: true,
        configurable: true,
        ...(key === "receipt" ? { get: () => value } : { value }),
      });
    }
    expect(verifyGpuHmrMcpAdmissionReceiptForMatrix(accessorContext)).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_matrix_context_invalid",
    });
  });
});
