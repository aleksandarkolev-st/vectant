import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RTCDataChannel } from "werift";
import {
  GPU_PARENT_RUNTIME_PROOF_CONTROL_VERIFICATION_MATERIAL_SCHEMA_VERSION,
  SessionGpuParentRuntimeProofAdmission,
  type GpuParentRuntimeProofAdmissionReceiptConsumer,
  type GpuParentRuntimeProofAdmissionReceiptSigner,
} from "../../src/gpu_parent_runtime_proof_admission.js";
import {
  GpuParentRuntimeProofAdmissionReceiptSigner as Ed25519AdmissionReceiptSigner,
  verifyGpuParentRuntimeProofAdmissionReceipt,
  type GpuParentRuntimeProofAdmissionReceiptInput,
} from "../../src/gpu_parent_runtime_proof_admission_receipt.js";
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
  type RuntimeEvidenceTransportPreparedSupportEnvelope,
  type RuntimeEvidenceTransportSupportEnvelopeInput,
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
const MCP_VALIDATION_RUN_CHALLENGE = Buffer.alloc(32, 0x17).toString("base64url");
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

type TestReceiptConsumer = {
  consumeSupportEnvelope(
    input: RuntimeEvidenceTransportSupportEnvelopeInput,
  ): RuntimeEvidenceTransportSupportVerification;
};

function transactionalTestReceiptConsumer(
  delegate: TestReceiptConsumer,
): GpuParentRuntimeProofAdmissionReceiptConsumer {
  if (
    typeof (delegate as Partial<GpuParentRuntimeProofAdmissionReceiptConsumer>)
      .prepareSupportEnvelope === "function"
    && typeof (delegate as Partial<GpuParentRuntimeProofAdmissionReceiptConsumer>)
      .commitPreparedSupportEnvelope === "function"
    && typeof (delegate as Partial<GpuParentRuntimeProofAdmissionReceiptConsumer>)
      .discardPreparedSupportEnvelope === "function"
  ) {
    return delegate as GpuParentRuntimeProofAdmissionReceiptConsumer;
  }
  const prepared = new WeakMap<
    RuntimeEvidenceTransportPreparedSupportEnvelope,
    RuntimeEvidenceTransportSupportVerification
  >();
  return {
    consumeSupportEnvelope: (input) => delegate.consumeSupportEnvelope(input),
    prepareSupportEnvelope(input) {
      const verification = delegate.consumeSupportEnvelope(input);
      if (!verification.verified) {
        return Object.freeze({
          schemaVersion:
            "synthi.gpu_hmr.runtime_evidence_transport_preparation.v1" as const,
          proofAuthority:
            "cryptographic_and_freshness_preparation_only_replay_not_committed" as const,
          prepared: false,
          reason: verification.reason ?? "test_receipt_refused",
          capability: null,
          receiptId: null,
          observationContextHash: null,
          freshnessChecked: false,
          replayChecked: false as const,
          acceptedForGpuHmr: false as const,
          gpuHmrSuccess: false as const,
          canSatisfyRuntimeProof: false as const,
        });
      }
      const capability = Object.freeze({
        acceptedForGpuHmr: false as const,
        gpuHmrSuccess: false as const,
        canSatisfyRuntimeProof: false as const,
      });
      prepared.set(capability, verification);
      return Object.freeze({
        schemaVersion:
          "synthi.gpu_hmr.runtime_evidence_transport_preparation.v1" as const,
        proofAuthority:
          "cryptographic_and_freshness_preparation_only_replay_not_committed" as const,
        prepared: true,
        reason: null,
        capability,
        receiptId: verification.receiptId,
        observationContextHash: verification.observationContextHash,
        freshnessChecked: true,
        replayChecked: false as const,
        acceptedForGpuHmr: false as const,
        gpuHmrSuccess: false as const,
        canSatisfyRuntimeProof: false as const,
      });
    },
    commitPreparedSupportEnvelope(capability) {
      const verification = prepared.get(capability);
      prepared.delete(capability);
      return verification
        ?? refusedSupportVerification(
          "runtime_evidence_transport_prepared_capability_invalid",
        );
    },
    discardPreparedSupportEnvelope(capability) {
      return prepared.delete(capability);
    },
  };
}

function receiptConsumer(): TestReceiptConsumer & {
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

function admissionReceiptSigner(): Ed25519AdmissionReceiptSigner {
  return new Ed25519AdmissionReceiptSigner({
    privateKey: generateKeyPairSync("ed25519").privateKey,
    validationRunChallenge: MCP_VALIDATION_RUN_CHALLENGE,
    clockUnixNs: () => 1_784_500_000_123_456_789n,
    nonceBytes: () => Buffer.alloc(32, 0x31),
  });
}

function admission(options: Partial<{
  keyPin: RuntimeEvidenceTransportKeyPin;
  consumer: TestReceiptConsumer;
  admissionReceiptSigner: GpuParentRuntimeProofAdmissionReceiptSigner;
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
    receiptConsumer: transactionalTestReceiptConsumer(
      options.consumer ?? receiptConsumer(),
    ),
    admissionReceiptSigner:
      options.admissionReceiptSigner ?? admissionReceiptSigner(),
    now: options.now ?? (() => 1_000),
    nonceBytes: options.nonceBytes ?? nonceSource(),
    limits: options.limits,
  });
}

describe("SessionGpuParentRuntimeProofAdmission", () => {
  it("rejects an accessor-backed admission signer without invoking it", () => {
    let accessorCalls = 0;
    const signer = {} as GpuParentRuntimeProofAdmissionReceiptSigner;
    Object.defineProperty(signer, "signAdmissionReceipt", {
      enumerable: true,
      configurable: true,
      get: () => {
        accessorCalls += 1;
        return admissionReceiptSigner().signAdmissionReceipt;
      },
    });

    expect(() => admission({ admissionReceiptSigner: signer }))
      .toThrow("gpu_parent_runtime_proof_admission_receipt_signer_invalid");
    expect(accessorCalls).toBe(0);
  });

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
    expect(material).toMatchObject({
      schemaVersion:
        GPU_PARENT_RUNTIME_PROOF_CONTROL_VERIFICATION_MATERIAL_SCHEMA_VERSION,
      controlBinding: pair.control,
      runtimeEvidenceTransportVerificationKey: pinnedKey,
      transportContext: {
        transportSessionId: TRANSPORT_SESSION_ID,
        compileRequestNonce: intent.compileRequestNonce,
        expectedWorkerProcessId: String(WORKER_PROCESS_ID),
      },
      mcpAdmissionReceipt: {
        controlStageAdmitted: true,
        parentProofStageAdmitted: true,
        acceptedForGpuHmr: false,
        gpuHmrSuccess: false,
        canSatisfyRuntimeProof: false,
        fullRuntimeProofId,
      },
    });
    expect(material?.mcpAdmissionReceipt).not.toHaveProperty("publicKey");
    expect(material?.mcpAdmissionReceipt).not.toHaveProperty("verificationKey");
    expect(material?.mcpAdmissionReceipt).not.toHaveProperty(
      "validationRunChallenge",
    );
    expect(material).not.toHaveProperty("proofAuthority");
    expect(material).not.toHaveProperty("verified");
    expect(material).not.toHaveProperty("acceptedForGpuHmr");
    expect(material).not.toHaveProperty("gpuHmrSuccess");
    expect(material).not.toHaveProperty("canSatisfyRuntimeProof");
    expect(gate.takeControlVerificationMaterial(fullRuntimeProofId)).toBeNull();
    expect(gate.beforeClassify(pair.proof, 1_003)).toBe(false);
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(2);
  });

  it("signs the exact verifier-derived control and parent admission fields", () => {
    const keyPin = pinnedKeyPin();
    const pinnedKey = keyPin.snapshot().key;
    expect(pinnedKey).not.toBeNull();
    const concreteSigner = admissionReceiptSigner();
    let observedInput: GpuParentRuntimeProofAdmissionReceiptInput | null = null;
    const injectedSigner: GpuParentRuntimeProofAdmissionReceiptSigner = {
      signAdmissionReceipt: vi.fn((input) => {
        observedInput = input;
        return concreteSigner.signAdmissionReceipt(input);
      }),
    };
    const gate = admission({
      keyPin,
      admissionReceiptSigner: injectedSigner,
    });
    const intent = gate.issueCompileIntent(
      EXPECTED_OUTPUT_CONTRACT_HASH,
      EXPECTED_OUTPUT_SEMANTICS_HASH,
    );
    const pair = makePair(intent.compileRequestNonce, "e", {
      computeExpectedOutputContractHash: EXPECTED_OUTPUT_CONTRACT_HASH,
      computeExpectedOutputSemanticsHash: EXPECTED_OUTPUT_SEMANTICS_HASH,
    });
    const control = pair.control;
    const parent = pair.proof.parentVerification as Record<string, unknown>;

    expect(gate.beforeClassify(control, 1)).toBe(false);
    expect(gate.beforeClassify(pair.proof, 2)).toBe(true);
    expect(observedInput).toEqual({
      transportSessionId: TRANSPORT_SESSION_ID,
      compileRequestNonce: intent.compileRequestNonce,
      computeExpectedOutputContractHash: EXPECTED_OUTPUT_CONTRACT_HASH,
      computeExpectedOutputSemanticsHash: EXPECTED_OUTPUT_SEMANTICS_HASH,
      workerKeyId: pinnedKey?.keyId,
      workerKeyAnnouncementId: pinnedKey?.keyAnnouncementId,
      workerProcessId: pinnedKey?.workerProcessId,
      controlBindingId: control.bindingId,
      controlBindingCanonicalSha256: control.bindingCanonicalSha256,
      controlTransportReceiptId:
        `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"1".repeat(64)}`,
      controlObservationContextHash: `sha256:${"1".repeat(64)}`,
      parentReceiptId: parent.receiptId,
      parentTransportReceiptId:
        `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"2".repeat(64)}`,
      parentCanonicalProofSha256: parent.canonicalProofSha256,
      parentObservationContextHash: `sha256:${"2".repeat(64)}`,
      requestId: control.requestId,
      sourceEditId: control.sourceEditId,
      artifactContentHash: control.artifactContentHash,
      fullRuntimeProofId: control.fullRuntimeProofId,
      proofLedgerId: control.proofLedgerId,
      runnerProcessId: RUNNER_PROCESS_ID,
      runnerRuntimeSessionId: RUNTIME_SESSION_ID,
      runnerChallenge: RUNNER_CHALLENGE,
      commandEnvelopeSha256: COMMAND_ENVELOPE_HASH,
      protectedProofJsonSha256: control.protectedProofJsonSha256,
    });
    expect(Object.isFrozen(observedInput)).toBe(true);

    const material = gate.takeControlVerificationMaterial(
      control.fullRuntimeProofId as string,
    );
    expect(material).not.toBeNull();
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      concreteSigner.exportVerificationKey(),
      material?.mcpAdmissionReceipt,
      MCP_VALIDATION_RUN_CHALLENGE,
    )).toMatchObject({
      verified: true,
      replayChecked: false,
      freshnessChecked: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
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

  it("freezes the exact downstream parent proof before receipt verification", () => {
    let pair!: ProofPair;
    let sequence = 0;
    let observedPayload: string | null = null;
    let observedEnvelope: unknown;
    let mutationResults: boolean[] = [];
    const consumer = {
      consumeSupportEnvelope: vi.fn((
        input: RuntimeEvidenceTransportSupportEnvelopeInput,
      ) => {
        sequence += 1;
        if (sequence === 2) {
          const parent = pair.proof.parentVerification as Record<string, unknown>;
          const envelope = parent
            .runtimeEvidenceTransportEnvelope as Record<string, unknown>;
          mutationResults = [
            Reflect.set(pair.proof, "payloadMarker", "mutated-top-level"),
            Reflect.set(parent, "runnerPid", WORKER_PROCESS_ID + 100),
            Reflect.set(envelope, "schemaVersion", "mutated-nested-envelope.v1"),
          ];
          observedPayload = typeof input.observedPayload === "string"
            ? input.observedPayload
            : Buffer.from(input.observedPayload).toString("utf8");
          observedEnvelope = input.envelope;
        }
        return acceptedSupportVerification(sequence);
      }),
    };
    const gate = admission({ consumer });
    const intent = gate.issueCompileIntent();
    pair = makePair(intent.compileRequestNonce, "9");
    const originalProof = structuredClone(pair.proof);
    const originalProofPayload = Object.fromEntries(
      Object.entries(originalProof).filter(([key]) => key !== "parentVerification"),
    );
    gate.beforeClassify(pair.control, 1);

    expect(gate.beforeClassify(pair.proof, 2)).toBe(true);
    expect(mutationResults).toEqual([false, false, false]);
    expect(pair.proof).toEqual(originalProof);
    expect(observedPayload).toBe(
      canonicalizeGpuParentRuntimeProofJson(originalProofPayload),
    );
    expect(observedEnvelope).toBe(
      (pair.proof.parentVerification as Record<string, unknown>)
        .runtimeEvidenceTransportEnvelope,
    );
    expectDeepFrozen(pair.proof);
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(2);
  });

  it("deep-freezes nested parent data when the proof is already shallow-frozen", () => {
    const gate = admission();
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "a");
    gate.beforeClassify(pair.control, 1);
    Object.freeze(pair.proof);

    expect(gate.beforeClassify(pair.proof, 2)).toBe(true);
    expectDeepFrozen(pair.proof);
  });

  it("rejects a parentVerification accessor without invoking it", () => {
    const consumer = receiptConsumer();
    const gate = admission({ consumer });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "b");
    gate.beforeClassify(pair.control, 1);
    const parent = pair.proof.parentVerification;
    let getterCalls = 0;
    Object.defineProperty(pair.proof, "parentVerification", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return parent;
      },
    });

    expect(gate.beforeClassify(pair.proof, 2)).toBe(false);
    expect(getterCalls).toBe(0);
    expect(gate.snapshot().lastDecisionCode)
      .toBe("gpu_parent_runtime_proof_message_data_shape_invalid");
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(1);
  });

  it("rejects a proxied parent proof before external receipt verification", () => {
    const consumer = receiptConsumer();
    const gate = admission({ consumer });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "c");
    gate.beforeClassify(pair.control, 1);
    const proxiedProof = new Proxy(pair.proof, {});

    expect(gate.beforeClassify(proxiedProof, 2)).toBe(false);
    expect(gate.snapshot().lastDecisionCode)
      .toBe("gpu_parent_runtime_proof_parent_message_freeze_failed");
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(1);
  });

  it("suppresses synchronous same-nonce control reentry", () => {
    let gate!: SessionGpuParentRuntimeProofAdmission;
    let pair!: ProofPair;
    let recursiveResult: boolean | null = null;
    let sequence = 0;
    const consumer = {
      consumeSupportEnvelope: vi.fn(() => {
        sequence += 1;
        const currentSequence = sequence;
        if (currentSequence === 1) {
          recursiveResult = gate.beforeClassify(pair.control, 2);
        }
        return acceptedSupportVerification(currentSequence);
      }),
    };
    gate = admission({ consumer });
    const intent = gate.issueCompileIntent();
    pair = makePair(intent.compileRequestNonce, "5");

    expect(gate.beforeClassify(pair.control, 1)).toBe(false);
    expect(recursiveResult).toBe(false);
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(1);
    expect(gate.snapshot()).toMatchObject({
      pendingIntentCount: 0,
      verifiedBindingCount: 1,
      lastDecisionCode: "gpu_parent_runtime_proof_control_admitted",
    });
  });

  it("suppresses synchronous same-proof parent reentry and admits only once", () => {
    let gate!: SessionGpuParentRuntimeProofAdmission;
    let pair!: ProofPair;
    let recursiveResult: boolean | null = null;
    let sequence = 0;
    const consumer = {
      consumeSupportEnvelope: vi.fn(() => {
        sequence += 1;
        const currentSequence = sequence;
        if (currentSequence === 2) {
          recursiveResult = gate.beforeClassify(pair.proof, 3);
        }
        return acceptedSupportVerification(currentSequence);
      }),
    };
    gate = admission({ consumer });
    const intent = gate.issueCompileIntent();
    pair = makePair(intent.compileRequestNonce, "6");
    const proofId = pair.control.fullRuntimeProofId as string;
    gate.beforeClassify(pair.control, 1);

    expect(gate.beforeClassify(pair.proof, 2)).toBe(true);
    expect(recursiveResult).toBe(false);
    expect(gate.beforeClassify(pair.proof, 4)).toBe(false);
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(2);
    expect(gate.snapshot().admittedProofCount).toBe(1);
    expect(gate.takeControlVerificationMaterial(proofId)).not.toBeNull();
    expect(gate.takeControlVerificationMaterial(proofId)).toBeNull();
  });

  it("keeps the parent binding transactional when the admission signer throws", () => {
    const injectedSigner: GpuParentRuntimeProofAdmissionReceiptSigner = {
      signAdmissionReceipt: vi.fn(() => {
        throw new Error("opaque-signing-failure");
      }),
    };
    const gate = admission({ admissionReceiptSigner: injectedSigner });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "d");
    const proofId = pair.control.fullRuntimeProofId as string;
    gate.beforeClassify(pair.control, 1);

    expect(gate.beforeClassify(pair.proof, 2)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      status: "active",
      verifiedBindingCount: 1,
      admittedProofCount: 0,
      lastDecisionCode:
        "gpu_parent_runtime_proof_admission_receipt_signer_failed",
    });
    expect(gate.takeControlVerificationMaterial(proofId)).toBeNull();
    expect(injectedSigner.signAdmissionReceipt).toHaveBeenCalledTimes(1);
  });

  it("does not commit replay state when signing fails and commits one clean retry", () => {
    const concreteSigner = admissionReceiptSigner();
    let signerCalls = 0;
    const injectedSigner: GpuParentRuntimeProofAdmissionReceiptSigner = {
      signAdmissionReceipt: vi.fn((input) => {
        signerCalls += 1;
        if (signerCalls === 1) throw new Error("opaque-signing-failure");
        return concreteSigner.signAdmissionReceipt(input);
      }),
    };
    let sequence = 0;
    const prepared = new WeakMap<
      RuntimeEvidenceTransportPreparedSupportEnvelope,
      RuntimeEvidenceTransportSupportVerification
    >();
    const consumer: GpuParentRuntimeProofAdmissionReceiptConsumer = {
      consumeSupportEnvelope: vi.fn(() =>
        acceptedSupportVerification(++sequence)),
      prepareSupportEnvelope: vi.fn(() => {
        const verification = acceptedSupportVerification(++sequence);
        const capability = Object.freeze({
          acceptedForGpuHmr: false as const,
          gpuHmrSuccess: false as const,
          canSatisfyRuntimeProof: false as const,
        });
        prepared.set(capability, verification);
        return Object.freeze({
          schemaVersion:
            "synthi.gpu_hmr.runtime_evidence_transport_preparation.v1" as const,
          proofAuthority:
            "cryptographic_and_freshness_preparation_only_replay_not_committed" as const,
          prepared: true,
          reason: null,
          capability,
          receiptId: verification.receiptId,
          observationContextHash: verification.observationContextHash,
          freshnessChecked: true,
          replayChecked: false as const,
          acceptedForGpuHmr: false as const,
          gpuHmrSuccess: false as const,
          canSatisfyRuntimeProof: false as const,
        });
      }),
      commitPreparedSupportEnvelope: vi.fn((capability) => {
        const verification = prepared.get(capability);
        prepared.delete(capability);
        return verification
          ?? refusedSupportVerification(
            "runtime_evidence_transport_prepared_capability_invalid",
          );
      }),
      discardPreparedSupportEnvelope: vi.fn((capability) =>
        prepared.delete(capability)),
    };
    const gate = admission({ consumer, admissionReceiptSigner: injectedSigner });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "d");
    const proofId = pair.control.fullRuntimeProofId as string;
    gate.beforeClassify(pair.control, 1);

    expect(gate.beforeClassify(pair.proof, 2)).toBe(false);
    expect(consumer.prepareSupportEnvelope).toHaveBeenCalledTimes(1);
    expect(consumer.commitPreparedSupportEnvelope).not.toHaveBeenCalled();
    expect(consumer.discardPreparedSupportEnvelope).toHaveBeenCalledTimes(1);
    expect(gate.snapshot().verifiedBindingCount).toBe(1);

    expect(gate.beforeClassify(pair.proof, 3)).toBe(true);
    expect(consumer.prepareSupportEnvelope).toHaveBeenCalledTimes(2);
    expect(consumer.commitPreparedSupportEnvelope).toHaveBeenCalledTimes(1);
    expect(consumer.discardPreparedSupportEnvelope).toHaveBeenCalledTimes(1);
    expect(gate.takeControlVerificationMaterial(proofId)).not.toBeNull();
  });

  it("releases every failed signer preparation before a later admission", () => {
    const concreteSigner = admissionReceiptSigner();
    let failuresRemaining = 300;
    const injectedSigner: GpuParentRuntimeProofAdmissionReceiptSigner = {
      signAdmissionReceipt: vi.fn((input) => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("opaque-signing-failure");
        }
        return concreteSigner.signAdmissionReceipt(input);
      }),
    };
    let sequence = 0;
    let pendingCount = 0;
    let maximumPendingCount = 0;
    const prepared = new WeakMap<
      RuntimeEvidenceTransportPreparedSupportEnvelope,
      RuntimeEvidenceTransportSupportVerification
    >();
    const consumer: GpuParentRuntimeProofAdmissionReceiptConsumer = {
      consumeSupportEnvelope: vi.fn(() =>
        acceptedSupportVerification(++sequence)),
      prepareSupportEnvelope: vi.fn(() => {
        if (pendingCount >= 2) {
          return Object.freeze({
            schemaVersion:
              "synthi.gpu_hmr.runtime_evidence_transport_preparation.v1" as const,
            proofAuthority:
              "cryptographic_and_freshness_preparation_only_replay_not_committed" as const,
            prepared: false,
            reason:
              "runtime_evidence_transport_prepared_capability_capacity_exhausted",
            capability: null,
            receiptId: null,
            observationContextHash: null,
            freshnessChecked: false,
            replayChecked: false as const,
            acceptedForGpuHmr: false as const,
            gpuHmrSuccess: false as const,
            canSatisfyRuntimeProof: false as const,
          });
        }
        const verification = acceptedSupportVerification(++sequence);
        const capability = Object.freeze({
          acceptedForGpuHmr: false as const,
          gpuHmrSuccess: false as const,
          canSatisfyRuntimeProof: false as const,
        });
        prepared.set(capability, verification);
        pendingCount += 1;
        maximumPendingCount = Math.max(maximumPendingCount, pendingCount);
        return Object.freeze({
          schemaVersion:
            "synthi.gpu_hmr.runtime_evidence_transport_preparation.v1" as const,
          proofAuthority:
            "cryptographic_and_freshness_preparation_only_replay_not_committed" as const,
          prepared: true,
          reason: null,
          capability,
          receiptId: verification.receiptId,
          observationContextHash: verification.observationContextHash,
          freshnessChecked: true,
          replayChecked: false as const,
          acceptedForGpuHmr: false as const,
          gpuHmrSuccess: false as const,
          canSatisfyRuntimeProof: false as const,
        });
      }),
      commitPreparedSupportEnvelope: vi.fn((capability) => {
        const verification = prepared.get(capability);
        if (prepared.delete(capability)) pendingCount -= 1;
        return verification
          ?? refusedSupportVerification(
            "runtime_evidence_transport_prepared_capability_invalid",
          );
      }),
      discardPreparedSupportEnvelope: vi.fn((capability) => {
        if (!prepared.delete(capability)) return false;
        pendingCount -= 1;
        return true;
      }),
    };
    const gate = admission({ consumer, admissionReceiptSigner: injectedSigner });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "e");
    const proofId = pair.control.fullRuntimeProofId as string;
    gate.beforeClassify(pair.control, 1);

    for (let attempt = 0; attempt < 300; attempt += 1) {
      expect(gate.beforeClassify(pair.proof, attempt + 2)).toBe(false);
      expect(pendingCount).toBe(0);
    }
    expect(maximumPendingCount).toBe(1);
    expect(consumer.discardPreparedSupportEnvelope).toHaveBeenCalledTimes(300);

    expect(gate.beforeClassify(pair.proof, 302)).toBe(true);
    expect(pendingCount).toBe(0);
    expect(consumer.commitPreparedSupportEnvelope).toHaveBeenCalledTimes(1);
    expect(gate.takeControlVerificationMaterial(proofId)).not.toBeNull();
  });

  it("rejects signer-phase same-proof reentry without consuming the binding", () => {
    const concreteSigner = admissionReceiptSigner();
    let gate!: SessionGpuParentRuntimeProofAdmission;
    let pair!: ProofPair;
    let recursiveResult: boolean | null = null;
    let reenter = true;
    const injectedSigner: GpuParentRuntimeProofAdmissionReceiptSigner = {
      signAdmissionReceipt: vi.fn((input) => {
        if (reenter) {
          reenter = false;
          recursiveResult = gate.beforeClassify(pair.proof, 3);
        }
        return concreteSigner.signAdmissionReceipt(input);
      }),
    };
    gate = admission({ admissionReceiptSigner: injectedSigner });
    const intent = gate.issueCompileIntent();
    pair = makePair(intent.compileRequestNonce, "c");
    const proofId = pair.control.fullRuntimeProofId as string;
    gate.beforeClassify(pair.control, 1);

    expect(gate.beforeClassify(pair.proof, 2)).toBe(false);
    expect(recursiveResult).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      verifiedBindingCount: 1,
      admittedProofCount: 0,
      lastDecisionCode:
        "gpu_parent_runtime_proof_admission_receipt_signer_reentry_suppressed",
    });
    expect(gate.takeControlVerificationMaterial(proofId)).toBeNull();

    expect(gate.beforeClassify(pair.proof, 4)).toBe(true);
    expect(gate.snapshot()).toMatchObject({
      verifiedBindingCount: 0,
      admittedProofCount: 1,
    });
    expect(gate.takeControlVerificationMaterial(proofId)).not.toBeNull();
  });

  it("rejects signer-phase cross-proof reentry without consuming either binding", () => {
    const concreteSigner = admissionReceiptSigner();
    let gate!: SessionGpuParentRuntimeProofAdmission;
    let secondPair!: ProofPair;
    let recursiveResult: boolean | null = null;
    let reenter = true;
    const injectedSigner: GpuParentRuntimeProofAdmissionReceiptSigner = {
      signAdmissionReceipt: vi.fn((input) => {
        if (reenter) {
          reenter = false;
          recursiveResult = gate.beforeClassify(secondPair.proof, 5);
        }
        return concreteSigner.signAdmissionReceipt(input);
      }),
    };
    gate = admission({ admissionReceiptSigner: injectedSigner });
    const firstIntent = gate.issueCompileIntent();
    const secondIntent = gate.issueCompileIntent();
    const firstPair = makePair(firstIntent.compileRequestNonce, "1");
    secondPair = makePair(secondIntent.compileRequestNonce, "2");
    gate.beforeClassify(firstPair.control, 1);
    gate.beforeClassify(secondPair.control, 2);

    expect(gate.beforeClassify(firstPair.proof, 3)).toBe(false);
    expect(recursiveResult).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      verifiedBindingCount: 2,
      admittedProofCount: 0,
      lastDecisionCode:
        "gpu_parent_runtime_proof_admission_receipt_signer_reentry_suppressed",
    });

    expect(gate.beforeClassify(firstPair.proof, 6)).toBe(true);
    expect(gate.beforeClassify(secondPair.proof, 7)).toBe(true);
    expect(gate.snapshot()).toMatchObject({
      verifiedBindingCount: 0,
      admittedProofCount: 2,
    });
  });

  it("rejects admission state mutation during signing and permits a clean retry", () => {
    const concreteSigner = admissionReceiptSigner();
    let gate!: SessionGpuParentRuntimeProofAdmission;
    let mutateState = true;
    const injectedSigner: GpuParentRuntimeProofAdmissionReceiptSigner = {
      signAdmissionReceipt: vi.fn((input) => {
        if (mutateState) {
          mutateState = false;
          gate.issueCompileIntent();
        }
        return concreteSigner.signAdmissionReceipt(input);
      }),
    };
    gate = admission({ admissionReceiptSigner: injectedSigner });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "b");
    const proofId = pair.control.fullRuntimeProofId as string;
    gate.beforeClassify(pair.control, 1);

    expect(gate.beforeClassify(pair.proof, 2)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      pendingIntentCount: 1,
      verifiedBindingCount: 1,
      admittedProofCount: 0,
      lastDecisionCode:
        "gpu_parent_runtime_proof_admission_receipt_signer_state_changed",
    });
    expect(gate.takeControlVerificationMaterial(proofId)).toBeNull();

    expect(gate.beforeClassify(pair.proof, 3)).toBe(true);
    expect(gate.takeControlVerificationMaterial(proofId)).not.toBeNull();
  });

  it("rejects signer-time binding expiry without retaining partial material", () => {
    const concreteSigner = admissionReceiptSigner();
    let gate!: SessionGpuParentRuntimeProofAdmission;
    let now = 1_000;
    const injectedSigner: GpuParentRuntimeProofAdmissionReceiptSigner = {
      signAdmissionReceipt: vi.fn((input) => {
        now = 1_006;
        gate.snapshot();
        return concreteSigner.signAdmissionReceipt(input);
      }),
    };
    gate = admission({
      admissionReceiptSigner: injectedSigner,
      now: () => now,
      limits: { bindingTtlMs: 5 },
    });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "a");
    const proofId = pair.control.fullRuntimeProofId as string;
    gate.beforeClassify(pair.control, 1);

    expect(gate.beforeClassify(pair.proof, 2)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      verifiedBindingCount: 0,
      admittedProofCount: 0,
      lastDecisionCode:
        "gpu_parent_runtime_proof_admission_receipt_signer_state_changed",
    });
    expect(gate.takeControlVerificationMaterial(proofId)).toBeNull();
  });

  it("rejects signer-time worker key invalidation without committing material", () => {
    const keyPin = pinnedKeyPin();
    const concreteSigner = admissionReceiptSigner();
    const injectedSigner: GpuParentRuntimeProofAdmissionReceiptSigner = {
      signAdmissionReceipt: vi.fn((input) => {
        keyPin.dispose();
        return concreteSigner.signAdmissionReceipt(input);
      }),
    };
    const gate = admission({ keyPin, admissionReceiptSigner: injectedSigner });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "9");
    const proofId = pair.control.fullRuntimeProofId as string;
    gate.beforeClassify(pair.control, 1);

    expect(gate.beforeClassify(pair.proof, 2)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      verifiedBindingCount: 1,
      admittedProofCount: 0,
      lastDecisionCode: "gpu_parent_runtime_proof_parent_key_not_pinned",
    });
    expect(gate.takeControlVerificationMaterial(proofId)).toBeNull();
  });

  it("rejects a malformed admission signer result without consuming the binding", () => {
    const concreteSigner = admissionReceiptSigner();
    const injectedSigner: GpuParentRuntimeProofAdmissionReceiptSigner = {
      signAdmissionReceipt: vi.fn((input) => {
        const malformed = structuredClone(
          concreteSigner.signAdmissionReceipt(input),
        ) as Record<string, unknown>;
        delete malformed.signature;
        return malformed as never;
      }),
    };
    const gate = admission({ admissionReceiptSigner: injectedSigner });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "8");
    const proofId = pair.control.fullRuntimeProofId as string;
    gate.beforeClassify(pair.control, 1);

    expect(gate.beforeClassify(pair.proof, 2)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      verifiedBindingCount: 1,
      admittedProofCount: 0,
      lastDecisionCode:
        "gpu_parent_runtime_proof_admission_receipt_signer_result_invalid",
    });
    expect(gate.takeControlVerificationMaterial(proofId)).toBeNull();
  });

  it("bounds signer decimal fields before attempting U64 parsing", () => {
    const concreteSigner = admissionReceiptSigner();
    const injectedSigner: GpuParentRuntimeProofAdmissionReceiptSigner = {
      signAdmissionReceipt: vi.fn((input) => {
        const malformed = structuredClone(
          concreteSigner.signAdmissionReceipt(input),
        ) as Record<string, unknown>;
        malformed.admittedAtUnixNs = "9".repeat(100_000);
        return malformed as never;
      }),
    };
    const gate = admission({ admissionReceiptSigner: injectedSigner });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "7");
    const proofId = pair.control.fullRuntimeProofId as string;
    gate.beforeClassify(pair.control, 1);

    expect(gate.beforeClassify(pair.proof, 2)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      verifiedBindingCount: 1,
      admittedProofCount: 0,
      lastDecisionCode:
        "gpu_parent_runtime_proof_admission_receipt_signer_result_invalid",
    });
    expect(gate.takeControlVerificationMaterial(proofId)).toBeNull();
  });

  it("bounds signer result width without materializing all property names", () => {
    const concreteSigner = admissionReceiptSigner();
    const injectedSigner: GpuParentRuntimeProofAdmissionReceiptSigner = {
      signAdmissionReceipt: vi.fn((input) => {
        const malformed = structuredClone(
          concreteSigner.signAdmissionReceipt(input),
        ) as Record<string, unknown>;
        for (let index = 0; index < 10_000; index += 1) {
          malformed[`untrusted-${index}`] = index;
        }
        return malformed as never;
      }),
    };
    const gate = admission({ admissionReceiptSigner: injectedSigner });
    const intent = gate.issueCompileIntent();
    const pair = makePair(intent.compileRequestNonce, "6");
    const proofId = pair.control.fullRuntimeProofId as string;
    gate.beforeClassify(pair.control, 1);

    expect(gate.beforeClassify(pair.proof, 2)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      verifiedBindingCount: 1,
      admittedProofCount: 0,
      lastDecisionCode:
        "gpu_parent_runtime_proof_admission_receipt_signer_result_invalid",
    });
    expect(gate.takeControlVerificationMaterial(proofId)).toBeNull();
  });

  it.each([
    [
      "trust invalidation",
      "failed",
      (gate: SessionGpuParentRuntimeProofAdmission) =>
        gate.invalidateTrust("runtime_evidence_transport_failed"),
    ],
    [
      "disposal",
      "disposed",
      (gate: SessionGpuParentRuntimeProofAdmission) => gate.dispose(),
    ],
  ] as const)(
    "does not commit a control after receipt-consumer %s returns success",
    (_caseName, expectedStatus, terminate) => {
      let gate!: SessionGpuParentRuntimeProofAdmission;
      const consumer = {
        consumeSupportEnvelope: vi.fn(() => {
          terminate(gate);
          return acceptedSupportVerification(1);
        }),
      };
      gate = admission({ consumer });
      const intent = gate.issueCompileIntent();
      const pair = makePair(intent.compileRequestNonce, "7");
      const proofId = pair.control.fullRuntimeProofId as string;

      expect(gate.beforeClassify(pair.control, 1)).toBe(false);
      expect(gate.snapshot()).toMatchObject({
        status: expectedStatus,
        pendingIntentCount: 0,
        verifiedBindingCount: 0,
        admittedProofCount: 0,
      });
      expect(gate.takeControlVerificationMaterial(proofId)).toBeNull();
      expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      "trust invalidation",
      "failed",
      (gate: SessionGpuParentRuntimeProofAdmission) =>
        gate.invalidateTrust("runtime_evidence_transport_failed"),
    ],
    [
      "disposal",
      "disposed",
      (gate: SessionGpuParentRuntimeProofAdmission) => gate.dispose(),
    ],
  ] as const)(
    "does not admit a parent after receipt-consumer %s returns success",
    (_caseName, expectedStatus, terminate) => {
      let gate!: SessionGpuParentRuntimeProofAdmission;
      let sequence = 0;
      const consumer = {
        consumeSupportEnvelope: vi.fn(() => {
          sequence += 1;
          if (sequence === 2) terminate(gate);
          return acceptedSupportVerification(sequence);
        }),
      };
      gate = admission({ consumer });
      const intent = gate.issueCompileIntent();
      const pair = makePair(intent.compileRequestNonce, "8");
      const proofId = pair.control.fullRuntimeProofId as string;
      gate.beforeClassify(pair.control, 1);

      expect(gate.beforeClassify(pair.proof, 2)).toBe(false);
      expect(gate.snapshot()).toMatchObject({
        status: expectedStatus,
        pendingIntentCount: 0,
        verifiedBindingCount: 0,
        admittedProofCount: 0,
      });
      expect(gate.takeControlVerificationMaterial(proofId)).toBeNull();
      expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(2);
    },
  );

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

  it("rechecks capacity when a different control commits during verification", () => {
    let gate!: SessionGpuParentRuntimeProofAdmission;
    let second!: ProofPair;
    let sequence = 0;
    const consumer = {
      consumeSupportEnvelope: vi.fn(() => {
        sequence += 1;
        const currentSequence = sequence;
        if (currentSequence === 1) {
          gate.beforeClassify(second.control, 2);
        }
        return acceptedSupportVerification(currentSequence);
      }),
    };
    gate = admission({
      consumer,
      limits: { maxVerifiedBindings: 1 },
    });
    const firstIntent = gate.issueCompileIntent();
    const secondIntent = gate.issueCompileIntent();
    const first = makePair(firstIntent.compileRequestNonce, "e");
    second = makePair(secondIntent.compileRequestNonce, "f");

    expect(gate.beforeClassify(first.control, 1)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      status: "active",
      pendingIntentCount: 1,
      verifiedBindingCount: 1,
      lastDecisionCode: "gpu_parent_runtime_proof_binding_capacity_exhausted",
    });
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(2);
    expect(gate.beforeClassify(second.proof, 3)).toBe(true);
    expect(gate.takeControlVerificationMaterial(
      second.control.fullRuntimeProofId as string,
    )).not.toBeNull();
    expect(gate.takeControlVerificationMaterial(
      first.control.fullRuntimeProofId as string,
    )).toBeNull();
  });

  it("reserves retained capsule capacity at control admission", () => {
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
    expect(gate.snapshot()).toMatchObject({
      pendingIntentCount: 1,
      verifiedBindingCount: 0,
      admittedProofCount: 1,
      lastDecisionCode: "gpu_parent_runtime_proof_binding_capacity_exhausted",
    });
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(2);

    expect(gate.takeControlVerificationMaterial(firstProofId)).not.toBeNull();
    expect(gate.beforeClassify(second.control, 4)).toBe(false);
    expect(gate.snapshot().verifiedBindingCount).toBe(1);
    expect(gate.beforeClassify(second.proof, 5)).toBe(true);
    expect(gate.takeControlVerificationMaterial(secondProofId)).not.toBeNull();
    expect(consumer.consumeSupportEnvelope).toHaveBeenCalledTimes(4);
  });

  it("rejects a different proof ID that reuses a retained request ID", () => {
    const gate = admission();
    const firstIntent = gate.issueCompileIntent();
    const first = makePair(firstIntent.compileRequestNonce, "1");
    gate.beforeClassify(first.control, 1);
    expect(gate.beforeClassify(first.proof, 2)).toBe(true);

    const secondIntent = gate.issueCompileIntent();
    const second = makePair(secondIntent.compileRequestNonce, "2", {
      requestId: first.control.requestId as string,
    });
    gate.beforeClassify(second.control, 3);

    expect(gate.snapshot()).toMatchObject({
      status: "failed",
      verifiedBindingCount: 0,
      admittedProofCount: 1,
      failureReason:
        "gpu_parent_runtime_proof_authenticated_binding_identity_collision",
    });
    expect(gate.takeControlVerificationMaterial(
      first.control.fullRuntimeProofId as string,
    )).toBeNull();
  });

  it("keeps a request ID tombstoned after its capsule is taken", () => {
    const gate = admission();
    const firstIntent = gate.issueCompileIntent();
    const first = makePair(firstIntent.compileRequestNonce, "3");
    const requestId = first.control.requestId as string;
    gate.beforeClassify(first.control, 1);
    expect(gate.beforeClassify(first.proof, 2)).toBe(true);
    expect(gate.takeControlVerificationMaterial(
      first.control.fullRuntimeProofId as string,
    )).not.toBeNull();

    const secondIntent = gate.issueCompileIntent();
    const second = makePair(secondIntent.compileRequestNonce, "4", { requestId });
    gate.beforeClassify(second.control, 3);

    expect(gate.snapshot()).toMatchObject({
      status: "failed",
      pendingIntentCount: 0,
      verifiedBindingCount: 0,
      admittedProofCount: 1,
      failureReason:
        "gpu_parent_runtime_proof_authenticated_binding_identity_collision",
    });
  });

  it("keeps a proof ID tombstoned after its capsule is taken", () => {
    const gate = admission();
    const firstIntent = gate.issueCompileIntent();
    const first = makePair(firstIntent.compileRequestNonce, "5");
    const proofId = first.control.fullRuntimeProofId as string;
    gate.beforeClassify(first.control, 1);
    expect(gate.beforeClassify(first.proof, 2)).toBe(true);
    expect(gate.takeControlVerificationMaterial(proofId)).not.toBeNull();

    const secondIntent = gate.issueCompileIntent();
    const second = makePair(secondIntent.compileRequestNonce, "6", {
      fullRuntimeProofId: proofId,
    });
    gate.beforeClassify(second.control, 3);

    expect(gate.snapshot()).toMatchObject({
      status: "failed",
      pendingIntentCount: 0,
      verifiedBindingCount: 0,
      admittedProofCount: 1,
      failureReason:
        "gpu_parent_runtime_proof_authenticated_binding_identity_collision",
    });
  });

  it("expires live material but preserves admitted identity tombstones", () => {
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

    const reuseIntent = gate.issueCompileIntent();
    const reusePair = makePair(reuseIntent.compileRequestNonce, "b", {
      requestId: admittedPair.control.requestId as string,
    });
    gate.beforeClassify(reusePair.control, now);
    expect(gate.snapshot()).toMatchObject({
      status: "failed",
      pendingIntentCount: 0,
      verifiedBindingCount: 0,
      admittedProofCount: 1,
      failureReason:
        "gpu_parent_runtime_proof_authenticated_binding_identity_collision",
    });
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
