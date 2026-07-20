import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RTCDataChannel } from "werift";
import {
  GPU_PARENT_RUNTIME_PROOF_CONTROL_VERIFICATION_MATERIAL_SCHEMA_VERSION,
  SessionGpuParentRuntimeProofAdmission,
  type GpuParentRuntimeProofAdmissionReceiptConsumer,
} from "../../src/gpu_parent_runtime_proof_admission.js";
import {
  GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_AUTHORITY,
  GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_SCHEMA_VERSION,
  GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_TYPE,
} from "../../src/gpu_parent_runtime_proof_control_binding.js";
import { canonicalizeGpuParentRuntimeProofJson } from "../../src/gpu_parent_runtime_proof.js";
import {
  RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
  RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL,
  RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
  RuntimeEvidenceTransportKeyPin,
  type RuntimeEvidenceTransportSupportVerification,
} from "../../src/runtime_evidence_transport.js";

const TRANSPORT_SESSION_ID = "opaque-transport-session:unit-01";
const WORKER_PROCESS_ID = 9123;
const RUNNER_PROCESS_ID = 8123;
const RUNTIME_SESSION_ID = "opaque-runtime-session:unit-02";
const RUNNER_CHALLENGE = "0123456789abcdef0123456789abcdef";
const COMMAND_ENVELOPE_HASH = `sha256:${"7".repeat(64)}`;
const EXPECTED_OUTPUT_CONTRACT_HASH = `sha256:${"a".repeat(64)}`;
const EXPECTED_OUTPUT_SEMANTICS_HASH = `sha256:${"b".repeat(64)}`;
const BINDING_ID_PREFIX = "gpu-parent-runtime-proof-control-binding:";
const PARENT_RECEIPT_PREFIX = "gpu-parent-runtime-proof-receipt:";
const CONTROL_METADATA_KEYS = new Set([
  "bindingCanonicalSha256",
  "bindingId",
  "runtimeEvidenceTransportEnvelope",
]);

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function controlBase(control: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(control).filter(([key]) => !CONTROL_METADATA_KEYS.has(key)),
  );
}

function sealControl(control: Record<string, unknown>): void {
  const hash = sha256(canonicalizeGpuParentRuntimeProofJson(controlBase(control)));
  control.bindingCanonicalSha256 = hash;
  control.bindingId = `${BINDING_ID_PREFIX}${hash}`;
}

function resealParent(proof: Record<string, unknown>): void {
  const parent = proof.parentVerification as Record<string, unknown>;
  delete parent.receiptId;
  parent.receiptId = `${PARENT_RECEIPT_PREFIX}${sha256(
    canonicalizeGpuParentRuntimeProofJson(parent),
  )}`;
}

interface ProofPair {
  readonly control: Record<string, unknown>;
  readonly proof: Record<string, unknown>;
}

function makePair(
  compileRequestNonce: string,
  discriminator = "1",
  overrides: Partial<{
    requestId: string;
    sourceEditId: string;
    artifactContentHash: string;
    fullRuntimeProofId: string;
    proofLedgerId: string;
    payloadMarker: string;
    computeExpectedOutputContractHash: string | null;
    computeExpectedOutputSemanticsHash: string | null;
  }> = {},
): ProofPair {
  const requestId = overrides.requestId
    ?? `gpu-reload:request:${discriminator.repeat(32)}`;
  const sourceEditId = overrides.sourceEditId
    ?? `source-edit:sha256:${discriminator.repeat(64)}`;
  const artifactContentHash = overrides.artifactContentHash
    ?? `sha256:${discriminator.repeat(64)}`;
  const fullRuntimeProofId = overrides.fullRuntimeProofId
    ?? `gpu-runtime-proof:sha256:${discriminator.repeat(64)}`;
  const proofLedgerId = overrides.proofLedgerId
    ?? `gpu-ledger-proof:sha256:${discriminator.repeat(64)}`;
  const protectedProofJsonSha256 = `sha256:${"5".repeat(64)}`;
  const proof: Record<string, unknown> = {
    schemaVersion: "synthi.gpu.hmr.proof.v1",
    type: "gpu_hmr_proof",
    resultState: "gpu-hmr-full-runtime-proven",
    proofId: fullRuntimeProofId,
    payloadMarker: overrides.payloadMarker ?? `opaque-${discriminator}`,
  };
  const canonicalProofSha256 = sha256(
    canonicalizeGpuParentRuntimeProofJson(proof),
  );
  const control: Record<string, unknown> = {
    schemaVersion: GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_SCHEMA_VERSION,
    type: GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_TYPE,
    proofAuthority: GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_AUTHORITY,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    compileSessionId: TRANSPORT_SESSION_ID,
    compileRequestNonce,
    requestId,
    sourceEditId,
    artifactContentHash,
    fullRuntimeProofId,
    proofLedgerId,
    protectedProofJsonSha256,
    canonicalProofSha256,
    runnerPid: RUNNER_PROCESS_ID,
    runnerRuntimeSessionId: RUNTIME_SESSION_ID,
    runnerChallenge: RUNNER_CHALLENGE,
    commandEnvelopeSha256: COMMAND_ENVELOPE_HASH,
    prepublicationOutputOracleCommitment: null,
    computeExpectedOutputContractHash:
      overrides.computeExpectedOutputContractHash ?? null,
    computeExpectedOutputSemanticsHash:
      overrides.computeExpectedOutputSemanticsHash ?? null,
    parentPid: WORKER_PROCESS_ID,
    bindingCanonicalSha256: "",
    bindingId: "",
    runtimeEvidenceTransportEnvelope: {
      schemaVersion: "opaque.control.envelope.v1",
      runtimeEvidenceTransportReceipt: {
        receiptId: `opaque-control-receipt-${discriminator}`,
        signature: `ed25519:opaque-control-signature-${discriminator}`,
      },
    },
  };
  sealControl(control);
  const parent: Record<string, unknown> = {
    schemaVersion: "synthi.gpu_hmr.parent_verified_runtime_proof.v3",
    proofAuthority: "parent_recomputed_runtime_proof_binding_only_not_gpu_hmr_acceptance",
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    parentRecomputed: true,
    runtimeContinuationAcknowledged: true,
    compileSessionId: TRANSPORT_SESSION_ID,
    requestId,
    sourceEditId,
    artifactContentHash,
    fullRuntimeProofId,
    proofLedgerId,
    protectedProofJsonSha256,
    canonicalProofSha256,
    runnerPid: RUNNER_PROCESS_ID,
    runnerRuntimeSessionId: RUNTIME_SESSION_ID,
    runnerChallenge: RUNNER_CHALLENGE,
    commandEnvelopeSha256: COMMAND_ENVELOPE_HASH,
    computeExpectedOutputSemanticsHash:
      overrides.computeExpectedOutputSemanticsHash ?? null,
    prepublicationOutputOracleCommitment: null,
    parentPid: WORKER_PROCESS_ID,
    runtimeEvidenceTransportEnvelope: { schemaVersion: "opaque.parent.envelope.v1" },
    receiptId: "",
  };
  proof.parentVerification = parent;
  resealParent(proof);
  return { control, proof };
}

class MockEvidenceDataChannel extends EventTarget {
  readonly label = RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL;
  readonly readyState = "open" as const;

  emit(data: unknown): void {
    const event = new Event("message");
    (event as unknown as { data: unknown }).data = data;
    this.dispatchEvent(event);
  }
}

function pinnedKeyPin(workerProcessId = WORKER_PROCESS_ID): RuntimeEvidenceTransportKeyPin {
  const publicKeyBytes = Buffer.alloc(32, 9);
  const publicKey = publicKeyBytes.toString("base64url");
  const keyId = `gpu-hmr-runtime-evidence-transport-key:${sha256(publicKeyBytes)}`;
  const workerInstanceId = `gpu-hmr-worker-instance:sha256:${"8".repeat(64)}`;
  const producer = "synthi-webrtc-compiler-worker";
  const announcementMaterial = JSON.stringify([
    RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
    RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
    keyId,
    producer,
    workerInstanceId,
    String(workerProcessId),
    publicKey,
  ]);
  const channel = new MockEvidenceDataChannel();
  const pin = new RuntimeEvidenceTransportKeyPin();
  pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
  channel.emit(JSON.stringify({
    schemaVersion: RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
    algorithm: RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
    keyId,
    producer,
    workerInstanceId,
    workerProcessId: String(workerProcessId),
    publicKey,
    keyAnnouncementId:
      `gpu-hmr-runtime-evidence-transport-key-announcement:${sha256(announcementMaterial)}`,
  }));
  expect(pin.snapshot().status).toBe("pinned");
  return pin;
}

function acceptedSupportVerification(sequence: number): RuntimeEvidenceTransportSupportVerification {
  const digit = (sequence % 16).toString(16);
  return Object.freeze({
    verified: true,
    reason: null,
    receiptId:
      `gpu-hmr-runtime-evidence-transport-receipt:sha256:${digit.repeat(64)}`,
    observationContextHash: `sha256:${digit.repeat(64)}`,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

function refusedSupportVerification(
  reason = "test_signature_refused",
): RuntimeEvidenceTransportSupportVerification {
  return Object.freeze({
    verified: false,
    reason,
    receiptId: null,
    observationContextHash: null,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    expectDeepFrozen(nested, seen);
  }
}

function receiptConsumer(): GpuParentRuntimeProofAdmissionReceiptConsumer & {
  consumeSupportEnvelope: ReturnType<typeof vi.fn>;
} {
  let sequence = 0;
  return {
    consumeSupportEnvelope: vi.fn(() => {
      sequence += 1;
      return acceptedSupportVerification(sequence);
    }),
  };
}

function nonceSource(): () => Uint8Array {
  let next = 0;
  return () => {
    next += 1;
    return Buffer.alloc(16, next);
  };
}

function admission(options: Partial<{
  keyPin: RuntimeEvidenceTransportKeyPin;
  consumer: GpuParentRuntimeProofAdmissionReceiptConsumer;
  now: () => number;
  nonceBytes: () => Uint8Array;
  limits: {
    maxPendingIntents?: number;
    maxVerifiedBindings?: number;
    maxIssuedNonces?: number;
    intentTtlMs?: number;
    bindingTtlMs?: number;
  };
}> = {}): SessionGpuParentRuntimeProofAdmission {
  return new SessionGpuParentRuntimeProofAdmission({
    transportSessionId: TRANSPORT_SESSION_ID,
    keyPin: options.keyPin ?? pinnedKeyPin(),
    receiptConsumer: options.consumer ?? receiptConsumer(),
    now: options.now ?? (() => 1_000),
    nonceBytes: options.nonceBytes ?? nonceSource(),
    limits: options.limits,
  });
}

describe("SessionGpuParentRuntimeProofAdmission", () => {
  it("issues bounded one-shot nonces and opaque support correlations", () => {
    const gate = admission();
    const first = gate.issueCompileIntent(
      EXPECTED_OUTPUT_CONTRACT_HASH,
      EXPECTED_OUTPUT_SEMANTICS_HASH,
    );
    gate.cancelCompileIntent(first.compileRequestNonce);
    const second = gate.issueCompileIntent();

    expect(first.compileRequestNonce)
      .toMatch(/^gpu-proof-transport-request:[a-f0-9]{32}$/);
    expect(second.compileRequestNonce).not.toBe(first.compileRequestNonce);
    expect(first.correlationId)
      .toMatch(/^gpu-proof-compile-correlation:sha256:[a-f0-9]{64}$/);
    expect(first.correlationId).not.toContain(first.compileRequestNonce);
    expect(first.computeExpectedOutputContractHash)
      .toBe(EXPECTED_OUTPUT_CONTRACT_HASH);
    expect(first.computeExpectedOutputSemanticsHash)
      .toBe(EXPECTED_OUTPUT_SEMANTICS_HASH);
    expect(second.computeExpectedOutputContractHash).toBeNull();
    expect(second.computeExpectedOutputSemanticsHash).toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
    expect(gate.snapshot().pendingIntentCount).toBe(1);
  });

  it("admits a signed control whose expected-output hash matches the pending intent", () => {
    const gate = admission();
    const intent = gate.issueCompileIntent(
      EXPECTED_OUTPUT_CONTRACT_HASH,
      EXPECTED_OUTPUT_SEMANTICS_HASH,
    );
    const pair = makePair(intent.compileRequestNonce, "a", {
      computeExpectedOutputContractHash: EXPECTED_OUTPUT_CONTRACT_HASH,
      computeExpectedOutputSemanticsHash: EXPECTED_OUTPUT_SEMANTICS_HASH,
    });

    expect(gate.beforeClassify(pair.control, 1)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      status: "active",
      pendingIntentCount: 0,
      verifiedBindingCount: 1,
      lastDecisionCode: "gpu_parent_runtime_proof_control_admitted",
    });
    expect(gate.beforeClassify(pair.proof, 2)).toBe(true);
  });

  it.each([
    ["omits caller semantics", EXPECTED_OUTPUT_SEMANTICS_HASH, null],
    [
      "substitutes caller semantics",
      EXPECTED_OUTPUT_SEMANTICS_HASH,
      `sha256:${"c".repeat(64)}`,
    ],
    ["injects undeclared semantics", null, EXPECTED_OUTPUT_SEMANTICS_HASH],
  ] as const)(
    "fails the intent epoch when authenticated control %s",
    (_caseName, callerSemanticsHash, controlSemanticsHash) => {
      const gate = admission();
      const intent = gate.issueCompileIntent(null, callerSemanticsHash);
      const pair = makePair(intent.compileRequestNonce, "d", {
        computeExpectedOutputSemanticsHash: controlSemanticsHash,
      });

      expect(gate.beforeClassify(pair.control, 1)).toBe(false);
      expect(gate.snapshot()).toMatchObject({
        status: "failed",
        pendingIntentCount: 0,
        verifiedBindingCount: 0,
        failureReason:
          "gpu_parent_runtime_proof_authenticated_expected_output_semantics_hash_mismatch",
      });
      expect(() => gate.issueCompileIntent(null, callerSemanticsHash))
        .toThrow(
          "gpu_parent_runtime_proof_authenticated_expected_output_semantics_hash_mismatch",
        );
    },
  );

  it("fails the intent epoch when authenticated contract B replaces caller contract A", () => {
    const contractA = sha256(canonicalizeGpuParentRuntimeProofJson({
      schemaVersion: "synthi.gpu_hmr.compute_expected_output_contract.v1",
      expectedValues: [1, 2, 3],
    }));
    const contractB = sha256(canonicalizeGpuParentRuntimeProofJson({
      schemaVersion: "synthi.gpu_hmr.compute_expected_output_contract.v1",
      expectedValues: [9, 9, 9],
    }));
    expect(contractB).not.toBe(contractA);
    const gate = admission();
    const intent = gate.issueCompileIntent(contractA);
    const regenerated = makePair(intent.compileRequestNonce, "b", {
      computeExpectedOutputContractHash: contractB,
    });

    expect(gate.beforeClassify(regenerated.control, 1)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      status: "failed",
      pendingIntentCount: 0,
      verifiedBindingCount: 0,
      failureReason:
        "gpu_parent_runtime_proof_authenticated_expected_output_contract_hash_mismatch",
    });
    expect(() => gate.issueCompileIntent(contractA))
      .toThrow(
        "gpu_parent_runtime_proof_authenticated_expected_output_contract_hash_mismatch",
      );
  });

  it("refuses an unauthenticated expected-output mismatch without failing the intent epoch", () => {
    const consumer = receiptConsumer();
    consumer.consumeSupportEnvelope.mockReturnValue(refusedSupportVerification());
    const gate = admission({ consumer });
    const intent = gate.issueCompileIntent(
      EXPECTED_OUTPUT_CONTRACT_HASH,
      EXPECTED_OUTPUT_SEMANTICS_HASH,
    );
    const pair = makePair(intent.compileRequestNonce, "c", {
      computeExpectedOutputContractHash: `sha256:${"b".repeat(64)}`,
      computeExpectedOutputSemanticsHash: `sha256:${"c".repeat(64)}`,
    });

    expect(gate.beforeClassify(pair.control, 1)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      status: "active",
      pendingIntentCount: 1,
      verifiedBindingCount: 0,
      lastDecisionCode:
        "gpu_parent_runtime_proof_control_binding_receipt_consumer_refused",
      failureReason: null,
    });
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(1);
    expect(gate.takeControlVerificationMaterial(
      pair.control.fullRuntimeProofId as string,
    )).toBeNull();
  });

  it("retains complete generic verification material only after the valid two-stage sequence", () => {
    const consumer = receiptConsumer();
    const keyPin = pinnedKeyPin();
    const pinnedKey = keyPin.snapshot().key;
    const gate = admission({ consumer, keyPin });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce);
    const fullRuntimeProofId = pair.control.fullRuntimeProofId as string;
    const wrongProofId = `gpu-runtime-proof:sha256:${"f".repeat(64)}`;

    expect(gate.takeControlVerificationMaterial(fullRuntimeProofId)).toBeNull();

    expect(gate.beforeClassify(pair.control, 1_001)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      pendingIntentCount: 0,
      verifiedBindingCount: 1,
      admittedProofCount: 0,
      lastDecisionCode: "gpu_parent_runtime_proof_control_admitted",
    });
    expect(gate.takeControlVerificationMaterial(fullRuntimeProofId)).toBeNull();
    expect(gate.beforeClassify(pair.proof, 1_002)).toBe(true);
    expect(gate.snapshot()).toMatchObject({
      verifiedBindingCount: 0,
      admittedProofCount: 1,
      lastDecisionCode: "gpu_parent_runtime_proof_parent_admitted",
    });
    expect(gate.takeControlVerificationMaterial(wrongProofId)).toBeNull();
    const material = gate.takeControlVerificationMaterial(fullRuntimeProofId);
    expect(material).toEqual({
      schemaVersion:
        GPU_PARENT_RUNTIME_PROOF_CONTROL_VERIFICATION_MATERIAL_SCHEMA_VERSION,
      controlBinding: pair.control,
      runtimeEvidenceTransportVerificationKey: pinnedKey,
      transportContext: {
        transportSessionId: TRANSPORT_SESSION_ID,
        compileRequestNonce: intent.compileRequestNonce,
        expectedWorkerProcessId: String(WORKER_PROCESS_ID),
      },
    });
    expect(material).not.toHaveProperty("proofAuthority");
    expect(material).not.toHaveProperty("verified");
    expect(material).not.toHaveProperty("acceptedForGpuHmr");
    expect(material).not.toHaveProperty("gpuHmrSuccess");
    expect(material).not.toHaveProperty("canSatisfyRuntimeProof");
    expect(gate.takeControlVerificationMaterial(fullRuntimeProofId)).toBeNull();
    expect(gate.beforeClassify(pair.proof, 1_003)).toBe(false);
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(2);
  });

  it("does not expose material for a verified control without its parent proof", () => {
    const gate = admission();
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "2");
    const fullRuntimeProofId = pair.control.fullRuntimeProofId as string;

    expect(gate.beforeClassify(pair.control, 1)).toBe(false);
    expect(gate.takeControlVerificationMaterial(fullRuntimeProofId)).toBeNull();
    expect(gate.snapshot().verifiedBindingCount).toBe(1);
  });

  it("does not retain material when matching parent transport verification is refused", () => {
    const consumer = receiptConsumer();
    consumer.consumeSupportEnvelope
      .mockImplementationOnce(() => acceptedSupportVerification(1))
      .mockImplementationOnce(() => refusedSupportVerification());
    const gate = admission({ consumer });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "3");
    const fullRuntimeProofId = pair.control.fullRuntimeProofId as string;

    expect(gate.beforeClassify(pair.control, 1)).toBe(false);
    expect(gate.beforeClassify(pair.proof, 2)).toBe(false);
    expect(gate.takeControlVerificationMaterial(fullRuntimeProofId)).toBeNull();
    expect(gate.snapshot()).toMatchObject({
      verifiedBindingCount: 1,
      admittedProofCount: 0,
      lastDecisionCode: "gpu_parent_runtime_proof_receipt_consumer_refused",
    });
  });

  it("deep-clones and deep-freezes the exact control, key, and transport context", () => {
    const keyPin = pinnedKeyPin();
    const pinnedKey = keyPin.snapshot().key;
    const gate = admission({ keyPin });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "4");
    const originalControl = structuredClone(pair.control);
    const fullRuntimeProofId = pair.control.fullRuntimeProofId as string;

    expect(gate.beforeClassify(pair.control, 1)).toBe(false);
    const sourceEnvelope = pair.control
      .runtimeEvidenceTransportEnvelope as Record<string, unknown>;
    const sourceReceipt = sourceEnvelope
      .runtimeEvidenceTransportReceipt as Record<string, unknown>;
    sourceReceipt.signature = "ed25519:mutated-after-control-verification";
    sourceEnvelope.unverifiedMutation = { nested: true };
    expect(gate.beforeClassify(pair.proof, 2)).toBe(true);

    const material = gate.takeControlVerificationMaterial(fullRuntimeProofId);
    expect(material).not.toBeNull();
    expect(material?.controlBinding).toEqual(originalControl);
    expect(material?.controlBinding).not.toBe(pair.control);
    expect(material?.runtimeEvidenceTransportVerificationKey).toEqual(pinnedKey);
    expect(material?.runtimeEvidenceTransportVerificationKey).not.toBe(pinnedKey);
    expectDeepFrozen(material);
    expect(() => {
      const retainedEnvelope = material?.controlBinding
        .runtimeEvidenceTransportEnvelope as Record<string, unknown>;
      const retainedReceipt = retainedEnvelope
        .runtimeEvidenceTransportReceipt as Record<string, unknown>;
      retainedReceipt.signature = "ed25519:mutation-must-fail";
    }).toThrow(TypeError);
  });

  it("passes ordinary and lower proof messages but suppresses unbound authority claims", () => {
    const gate = admission();

    expect(gate.beforeClassify({ type: "ordinary-event", value: 1 }, 1)).toBe(true);
    expect(gate.beforeClassify({
      type: "gpu_hmr_proof",
      resultState: "gpu-hmr-compile-proven",
    }, 2)).toBe(true);
    expect(gate.beforeClassify({
      status: "gpu-proof-state",
      resultState: "gpu-hmr-full-runtime-proven",
    }, 3)).toBe(false);
    expect(gate.beforeClassify({
      type: "gpu_hmr_proof",
      result_state: "gpu-hmr-full-runtime-proven",
    }, 4)).toBe(false);
    expect(gate.beforeClassify({
      type: "gpu_hmr_proof",
      resultState: "gpu-hmr-full-runtime-proven",
      parent_verification: {},
    }, 5)).toBe(false);
    expect(gate.beforeClassify({
      type: "ordinary-event",
      parentVerification: {},
    }, 6)).toBe(false);
  });

  it("does not let a lower-state parent record consume a valid binding", () => {
    const gate = admission();
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce);
    gate.beforeClassify(pair.control, 1);
    const lower = structuredClone(pair.proof);
    lower.resultState = "gpu-hmr-compile-proven";

    expect(gate.beforeClassify(lower, 2)).toBe(false);
    expect(gate.snapshot().verifiedBindingCount).toBe(1);
    expect(gate.beforeClassify(pair.proof, 3)).toBe(true);
  });

  it("rejects a same-identity control/parent hash splice before receipt consumption", () => {
    const consumer = receiptConsumer();
    const gate = admission({ consumer });
    const intent = gate.issueCompileIntent();
    const first = makePair(intent.compileRequestNonce, "2");
    const second = makePair(intent.compileRequestNonce, "2", {
      payloadMarker: "opaque-alternate-payload",
    });

    expect(gate.beforeClassify(first.control, 1)).toBe(false);
    expect(gate.beforeClassify(second.proof, 2)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      verifiedBindingCount: 1,
      lastDecisionCode: "gpu_parent_runtime_proof_control_parent_hash_mismatch",
    });
    expect(gate.takeControlVerificationMaterial(
      first.control.fullRuntimeProofId as string,
    )).toBeNull();
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(1);
    expect(gate.beforeClassify(first.proof, 3)).toBe(true);
  });

  it.each([
    ["session", (control: Record<string, unknown>) => {
      control.compileSessionId = "opaque-transport-session:other";
    }],
    ["worker process", (control: Record<string, unknown>) => {
      control.parentPid = WORKER_PROCESS_ID + 1;
    }],
  ])("rejects a signed-control context mismatch: %s", (_name, mutate) => {
    const consumer = receiptConsumer();
    const gate = admission({ consumer });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "3");
    mutate(pair.control);
    sealControl(pair.control);

    expect(gate.beforeClassify(pair.control, 1)).toBe(false);
    expect(gate.snapshot().pendingIntentCount).toBe(1);
    expect(consumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("rejects unknown or cancelled compile nonces before receipt consumption", () => {
    const consumer = receiptConsumer();
    const gate = admission({ consumer });
    const issued = gate.issueCompileIntent();
    gate.cancelCompileIntent(issued.compileRequestNonce);
    const pair = makePair(issued.compileRequestNonce, "4");

    expect(gate.beforeClassify(pair.control, 1)).toBe(false);
    expect(gate.snapshot().lastDecisionCode)
      .toBe("gpu_parent_runtime_proof_control_without_live_intent");
    expect(consumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it.each(["proof", "request"] as const)(
    "fails the admission epoch on an authenticated %s identity collision",
    (collisionKind) => {
    const gate = admission();
    const firstIntent = gate.issueCompileIntent();
    const secondIntent = gate.issueCompileIntent();
    const first = makePair(firstIntent.compileRequestNonce, "5");
    const second = makePair(secondIntent.compileRequestNonce, "6", {
      ...(collisionKind === "proof"
        ? { fullRuntimeProofId: first.control.fullRuntimeProofId as string }
        : { requestId: first.control.requestId as string }),
    });

    gate.beforeClassify(first.control, 1);
    gate.beforeClassify(second.control, 2);

    expect(gate.snapshot()).toMatchObject({
      status: "failed",
      pendingIntentCount: 0,
      verifiedBindingCount: 0,
      failureReason: "gpu_parent_runtime_proof_authenticated_binding_identity_collision",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    });
    expect(() => gate.issueCompileIntent())
      .toThrow("gpu_parent_runtime_proof_authenticated_binding_identity_collision");
    },
  );

  it("bounds pending intents and never reuses an issued nonce", () => {
    const bytes = Buffer.alloc(16, 1);
    const gate = admission({
      nonceBytes: () => Buffer.from(bytes),
      limits: {
        maxPendingIntents: 1,
        maxIssuedNonces: 2,
      },
    });
    const intent = gate.issueCompileIntent();
    expect(() => gate.issueCompileIntent())
      .toThrow("gpu_parent_runtime_proof_admission_intent_capacity_exhausted");
    gate.cancelCompileIntent(intent.compileRequestNonce);
    expect(() => gate.issueCompileIntent())
      .toThrow("gpu_parent_runtime_proof_admission_nonce_collision");
  });

  it("bounds nonce history instead of forgetting cancelled nonces", () => {
    const gate = admission({
      limits: { maxIssuedNonces: 1 },
    });
    const intent = gate.issueCompileIntent();
    gate.cancelCompileIntent(intent.compileRequestNonce);

    expect(() => gate.issueCompileIntent())
      .toThrow("gpu_parent_runtime_proof_admission_nonce_history_exhausted");
  });

  it("does not evict a live verified binding to accept a newer control", () => {
    const consumer = receiptConsumer();
    const gate = admission({
      consumer,
      limits: { maxVerifiedBindings: 1 },
    });
    const firstIntent = gate.issueCompileIntent();
    const secondIntent = gate.issueCompileIntent();
    const first = makePair(firstIntent.compileRequestNonce, "a");
    const second = makePair(secondIntent.compileRequestNonce, "b");

    gate.beforeClassify(first.control, 1);
    gate.beforeClassify(second.control, 2);

    expect(gate.snapshot()).toMatchObject({
      pendingIntentCount: 1,
      verifiedBindingCount: 1,
      lastDecisionCode: "gpu_parent_runtime_proof_binding_capacity_exhausted",
    });
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(1);
    expect(gate.beforeClassify(first.proof, 3)).toBe(true);
  });

  it("bounds retained material without evicting an untaken capsule", () => {
    const consumer = receiptConsumer();
    const gate = admission({
      consumer,
      limits: { maxVerifiedBindings: 1 },
    });
    const firstIntent = gate.issueCompileIntent();
    const first = makePair(firstIntent.compileRequestNonce, "5");
    const firstProofId = first.control.fullRuntimeProofId as string;
    gate.beforeClassify(first.control, 1);
    expect(gate.beforeClassify(first.proof, 2)).toBe(true);

    const secondIntent = gate.issueCompileIntent();
    const second = makePair(secondIntent.compileRequestNonce, "6");
    const secondProofId = second.control.fullRuntimeProofId as string;
    gate.beforeClassify(second.control, 3);
    expect(gate.beforeClassify(second.proof, 4)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      verifiedBindingCount: 1,
      admittedProofCount: 1,
      lastDecisionCode:
        "gpu_parent_runtime_proof_control_verification_material_capacity_exhausted",
    });
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(3);

    expect(gate.takeControlVerificationMaterial(firstProofId)).not.toBeNull();
    expect(gate.beforeClassify(second.proof, 5)).toBe(true);
    expect(gate.takeControlVerificationMaterial(secondProofId)).not.toBeNull();
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(4);
  });

  it("expires intents, verified bindings, and retained material", () => {
    let now = 100;
    const consumer = receiptConsumer();
    const gate = admission({
      consumer,
      now: () => now,
      limits: { intentTtlMs: 10, bindingTtlMs: 10 },
    });
    const staleIntent = gate.issueCompileIntent();
    const stalePair = makePair(staleIntent.compileRequestNonce, "7");
    now = 111;
    expect(gate.beforeClassify(stalePair.control, now)).toBe(false);
    expect(consumer.consumeSupportEnvelope).not.toHaveBeenCalled();

    const liveIntent = gate.issueCompileIntent();
    const livePair = makePair(liveIntent.compileRequestNonce, "8");
    gate.beforeClassify(livePair.control, now);
    expect(gate.snapshot().verifiedBindingCount).toBe(1);
    now = 122;
    expect(gate.beforeClassify(livePair.proof, now)).toBe(false);
    expect(gate.snapshot().verifiedBindingCount).toBe(0);

    const admittedIntent = gate.issueCompileIntent();
    const admittedPair = makePair(admittedIntent.compileRequestNonce, "a");
    const admittedProofId = admittedPair.control.fullRuntimeProofId as string;
    gate.beforeClassify(admittedPair.control, now);
    expect(gate.beforeClassify(admittedPair.proof, now)).toBe(true);
    now = 133;
    expect(gate.takeControlVerificationMaterial(admittedProofId)).toBeNull();
  });

  it("refuses controls until an authenticated key is pinned", () => {
    const consumer = receiptConsumer();
    const gate = admission({
      consumer,
      keyPin: new RuntimeEvidenceTransportKeyPin(),
    });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "9");

    expect(gate.beforeClassify(pair.control, 1)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      pendingIntentCount: 1,
      verifiedBindingCount: 0,
      lastDecisionCode: "gpu_parent_runtime_proof_control_key_not_pinned",
    });
    expect(consumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("clears proof state on trust invalidation while passing unrelated messages", () => {
    const gate = admission();
    const admittedIntent = gate.issueCompileIntent();
    const boundIntent = gate.issueCompileIntent();
    const pendingIntent = gate.issueCompileIntent();
    const admittedPair = makePair(admittedIntent.compileRequestNonce, "b");
    const pair = makePair(boundIntent.compileRequestNonce, "c");
    expect(gate.beforeClassify(admittedPair.control, 1)).toBe(false);
    expect(gate.beforeClassify(admittedPair.proof, 2)).toBe(true);
    expect(gate.beforeClassify(pair.control, 1)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      pendingIntentCount: 1,
      verifiedBindingCount: 1,
      admittedProofCount: 1,
    });

    gate.invalidateTrust("runtime_evidence_transport_failed");
    gate.invalidateTrust("runtime_evidence_transport_disposed");

    expect(gate.snapshot()).toMatchObject({
      status: "failed",
      pendingIntentCount: 0,
      verifiedBindingCount: 0,
      failureReason:
        "gpu_parent_runtime_proof_admission_runtime_evidence_transport_failed",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(gate.takeControlVerificationMaterial(
      admittedPair.control.fullRuntimeProofId as string,
    )).toBeNull();
    expect(gate.beforeClassify({ type: "ordinary-event", value: 1 }, 2)).toBe(true);
    expect(gate.beforeClassify({
      type: "gpu_hmr_proof",
      resultState: "gpu-hmr-full-runtime-proven",
      parentVerification: pair.proof.parentVerification,
    }, 3)).toBe(false);
    expect(() => gate.issueCompileIntent())
      .toThrow("gpu_parent_runtime_proof_admission_runtime_evidence_transport_failed");
    gate.cancelCompileIntent(pendingIntent.compileRequestNonce);
  });

  it("reports only frozen support diagnostics and clears state on disposal", () => {
    const gate = admission();
    const admittedIntent = gate.issueCompileIntent();
    const admittedPair = makePair(admittedIntent.compileRequestNonce, "d");
    gate.beforeClassify(admittedPair.control, 1);
    expect(gate.beforeClassify(admittedPair.proof, 2)).toBe(true);
    gate.issueCompileIntent();
    const active = gate.snapshot();

    expect(Object.isFrozen(active)).toBe(true);
    expect(active).toMatchObject({
      proofAuthority: "session_admission_diagnostics_only_not_gpu_hmr_acceptance",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(JSON.stringify(active)).not.toContain("gpu-proof-transport-request:");

    gate.dispose();
    expect(gate.snapshot()).toMatchObject({
      status: "disposed",
      pendingIntentCount: 0,
      verifiedBindingCount: 0,
    });
    expect(gate.takeControlVerificationMaterial(
      admittedPair.control.fullRuntimeProofId as string,
    )).toBeNull();
    expect(gate.beforeClassify({ type: "ordinary-event" }, 1)).toBe(false);
    expect(() => gate.issueCompileIntent())
      .toThrow("gpu_parent_runtime_proof_admission_disposed");
  });

  it("rejects invalid limits, clocks, and nonce sources deterministically", () => {
    expect(() => admission({ limits: { maxPendingIntents: 0 } }))
      .toThrow("gpu_parent_runtime_proof_admission_limit_invalid");
    expect(() => new SessionGpuParentRuntimeProofAdmission({
      transportSessionId: "contains a space",
      keyPin: pinnedKeyPin(),
      receiptConsumer: receiptConsumer(),
    })).toThrow("gpu_parent_runtime_proof_admission_session_invalid");
    expect(() => admission({ now: () => 1.5 }).issueCompileIntent())
      .toThrow("gpu_parent_runtime_proof_admission_clock_invalid");
    expect(() => admission({ nonceBytes: () => Buffer.alloc(15) }).issueCompileIntent())
      .toThrow("gpu_parent_runtime_proof_admission_nonce_source_invalid");
    expect(() => admission().issueCompileIntent(`sha256:${"A".repeat(64)}`))
      .toThrow("gpu_parent_runtime_proof_admission_expected_output_contract_hash_invalid");
    expect(() => admission().issueCompileIntent(null, `sha256:${"A".repeat(64)}`))
      .toThrow("gpu_parent_runtime_proof_admission_expected_output_semantics_hash_invalid");
  });
});
