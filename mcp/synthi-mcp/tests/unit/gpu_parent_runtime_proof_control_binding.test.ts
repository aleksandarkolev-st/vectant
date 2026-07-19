import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RTCDataChannel } from "werift";
import {
  GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_AUTHORITY,
  GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_SCHEMA_VERSION,
  GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_SUBJECT_SCHEMA_VERSION,
  GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_TYPE,
  verifyGpuParentRuntimeProofControlBinding,
  type GpuParentRuntimeProofControlBindingReceiptConsumer,
  type GpuParentRuntimeProofControlBindingVerificationContext,
} from "../../src/gpu_parent_runtime_proof_control_binding.js";
import {
  canonicalizeGpuParentRuntimeProofJson,
  type GpuParentRuntimeProofExpectedBinding,
} from "../../src/gpu_parent_runtime_proof.js";
import {
  RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
  RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL,
  RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
  RuntimeEvidenceTransportKeyPin,
  RuntimeEvidenceTransportReceiptConsumer,
  SessionRuntimeEvidenceTransportReplayStore,
  type RuntimeEvidenceTransportSupportEnvelopeInput,
  type RuntimeEvidenceTransportSupportVerification,
} from "../../src/runtime_evidence_transport.js";

const TRANSPORT_SESSION_ID = "opaque-control-session:alpha-01";
const COMPILE_REQUEST_NONCE =
  "gpu-proof-transport-request:0123456789abcdef0123456789abcdef";
const WORKER_PROCESS_ID = 9123;
const RUNNER_PROCESS_ID = 8123;
const RUNTIME_SESSION_ID = "opaque-runtime-session:beta-02";
const RUNNER_CHALLENGE = "0123456789abcdef0123456789abcdef";
const REQUEST_ID = "gpu-reload:request:0123456789abcdef0123456789abcdef";
const SOURCE_EDIT_ID = `source-edit:sha256:${"1".repeat(64)}`;
const ARTIFACT_HASH = `sha256:${"2".repeat(64)}`;
const RUNTIME_PROOF_ID = `gpu-runtime-proof:sha256:${"3".repeat(64)}`;
const LEDGER_PROOF_ID = `gpu-ledger-proof:sha256:${"4".repeat(64)}`;
const PROTECTED_PROOF_HASH = `sha256:${"5".repeat(64)}`;
const CANONICAL_PROOF_HASH = `sha256:${"6".repeat(64)}`;
const COMMAND_ENVELOPE_HASH = `sha256:${"7".repeat(64)}`;
const EXPECTED_OUTPUT_CONTRACT_HASH = `sha256:${"a".repeat(64)}`;
const EXPECTED_OUTPUT_SEMANTICS_HASH = `sha256:${"b".repeat(64)}`;
const TRANSPORT_RECEIPT_ID =
  `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"8".repeat(64)}`;
const OBSERVATION_CONTEXT_HASH = `sha256:${"9".repeat(64)}`;
const TRANSPORT_PRODUCER = "synthi-webrtc-compiler-worker";
const BINDING_ID_PREFIX = "gpu-parent-runtime-proof-control-binding:";
const NOW_NS = 1_784_433_015_000_000_000n;
const METADATA_KEYS = new Set([
  "bindingCanonicalSha256",
  "bindingId",
  "runtimeEvidenceTransportEnvelope",
]);

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function basePayload(binding: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(binding)) {
    if (!METADATA_KEYS.has(key)) payload[key] = value;
  }
  return payload;
}

function canonicalBasePayload(binding: Record<string, unknown>): string {
  return canonicalizeGpuParentRuntimeProofJson(basePayload(binding));
}

function sealBinding(binding: Record<string, unknown>): void {
  const canonical = canonicalBasePayload(binding);
  const canonicalSha256 = sha256(canonical);
  binding.bindingCanonicalSha256 = canonicalSha256;
  binding.bindingId = `${BINDING_ID_PREFIX}${canonicalSha256}`;
}

function expectedBindingFrom(
  binding: Record<string, unknown>,
): GpuParentRuntimeProofExpectedBinding {
  return {
    requestId: binding.requestId as string,
    sourceEditId: binding.sourceEditId as string,
    artifactContentHash: binding.artifactContentHash as string,
    fullRuntimeProofId: binding.fullRuntimeProofId as string,
    proofLedgerId: binding.proofLedgerId as string,
    runnerProcessId: binding.runnerPid as number,
    runnerRuntimeSessionId: binding.runnerRuntimeSessionId as string,
    runnerChallenge: binding.runnerChallenge as string,
    commandEnvelopeSha256: binding.commandEnvelopeSha256 as string,
    computeExpectedOutputSemanticsHash:
      binding.computeExpectedOutputSemanticsHash as string | null,
    prepublicationOutputOracleCommitment:
      binding.prepublicationOutputOracleCommitment as
        GpuParentRuntimeProofExpectedBinding["prepublicationOutputOracleCommitment"],
  };
}

function acceptedSupportVerification(): RuntimeEvidenceTransportSupportVerification {
  return Object.freeze({
    verified: true,
    reason: null,
    receiptId: TRANSPORT_RECEIPT_ID,
    observationContextHash: OBSERVATION_CONTEXT_HASH,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

function refusedSupportVerification(): RuntimeEvidenceTransportSupportVerification {
  return Object.freeze({
    verified: false,
    reason: "test_receipt_refused",
    receiptId: null,
    observationContextHash: null,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

interface BindingFixture {
  readonly binding: Record<string, unknown>;
  readonly context: GpuParentRuntimeProofControlBindingVerificationContext;
  readonly consumeSupportEnvelope: ReturnType<typeof vi.fn>;
}

function makeFixture(
  baseOverrides: Record<string, unknown> = {},
): BindingFixture {
  const binding: Record<string, unknown> = {
    schemaVersion: GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_SCHEMA_VERSION,
    type: GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_TYPE,
    proofAuthority: GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_AUTHORITY,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    compileSessionId: TRANSPORT_SESSION_ID,
    compileRequestNonce: COMPILE_REQUEST_NONCE,
    requestId: REQUEST_ID,
    sourceEditId: SOURCE_EDIT_ID,
    artifactContentHash: ARTIFACT_HASH,
    fullRuntimeProofId: RUNTIME_PROOF_ID,
    proofLedgerId: LEDGER_PROOF_ID,
    protectedProofJsonSha256: PROTECTED_PROOF_HASH,
    canonicalProofSha256: CANONICAL_PROOF_HASH,
    runnerPid: RUNNER_PROCESS_ID,
    runnerRuntimeSessionId: RUNTIME_SESSION_ID,
    runnerChallenge: RUNNER_CHALLENGE,
    commandEnvelopeSha256: COMMAND_ENVELOPE_HASH,
    prepublicationOutputOracleCommitment: null,
    computeExpectedOutputContractHash: null,
    computeExpectedOutputSemanticsHash: null,
    parentPid: WORKER_PROCESS_ID,
    ...baseOverrides,
    bindingCanonicalSha256: "",
    bindingId: "",
    runtimeEvidenceTransportEnvelope: {
      schemaVersion: "test.transport.envelope.v1",
    },
  };
  sealBinding(binding);
  const consumeSupportEnvelope = vi.fn(
    (_input: RuntimeEvidenceTransportSupportEnvelopeInput) =>
      acceptedSupportVerification(),
  );
  return {
    binding,
    consumeSupportEnvelope,
    context: {
      transportSessionId: binding.compileSessionId as string,
      compileRequestNonce: binding.compileRequestNonce as string,
      expectedWorkerProcessId: String(binding.parentPid),
      receiptConsumer: { consumeSupportEnvelope },
    },
  };
}

function verifyFixture(
  fixture: BindingFixture,
  overrides: Partial<GpuParentRuntimeProofControlBindingVerificationContext> = {},
) {
  return verifyGpuParentRuntimeProofControlBinding(fixture.binding, {
    ...fixture.context,
    ...overrides,
  });
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

interface RealSignedEnvelope {
  readonly consumer: RuntimeEvidenceTransportReceiptConsumer;
  readonly receiptId: string;
  readonly observationContextHash: string;
  readonly canonicalPayload: Buffer;
  readonly envelope: Record<string, unknown>;
}

function attachRealSignedEnvelope(
  binding: Record<string, unknown>,
): RealSignedEnvelope {
  const canonicalPayload = Buffer.from(canonicalBasePayload(binding), "utf8");
  const observedPayloadSha256 = sha256(canonicalPayload);
  expect(binding.bindingCanonicalSha256).toBe(observedPayloadSha256);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyBytes = spki.subarray(spki.length - 32);
  const encodedPublicKey = publicKeyBytes.toString("base64url");
  const keyId =
    `gpu-hmr-runtime-evidence-transport-key:${sha256(publicKeyBytes)}`;
  const workerInstanceId =
    `gpu-hmr-worker-instance:sha256:${"a".repeat(64)}`;
  const workerProcessId = String(binding.parentPid);
  const announcementMaterial = JSON.stringify([
    RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
    RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
    keyId,
    TRANSPORT_PRODUCER,
    workerInstanceId,
    workerProcessId,
    encodedPublicKey,
  ]);
  const announcement = {
    schemaVersion: RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
    algorithm: RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
    keyId,
    producer: TRANSPORT_PRODUCER,
    workerInstanceId,
    workerProcessId,
    publicKey: encodedPublicKey,
    keyAnnouncementId:
      `gpu-hmr-runtime-evidence-transport-key-announcement:${sha256(announcementMaterial)}`,
  };
  const channel = new MockEvidenceDataChannel();
  const pin = new RuntimeEvidenceTransportKeyPin();
  pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
  channel.emit(JSON.stringify(announcement));
  expect(pin.snapshot().status).toBe("pinned");

  const runnerProcessId = binding.runnerPid as number;
  const runtimeSessionId = binding.runnerRuntimeSessionId as string;
  const runnerChallenge = binding.runnerChallenge as string;
  const transportSessionId = binding.compileSessionId as string;
  const requestId = binding.requestId as string;
  const sourceEditId = binding.sourceEditId as string;
  const artifactContentHash = binding.artifactContentHash as string;
  const observedRuntimeProofId = binding.fullRuntimeProofId as string;
  const observedProofLedgerId = binding.proofLedgerId as string;
  const runnerChallengeSha256 = sha256(runnerChallenge);
  const transportSessionBindingSha256 = sha256(
    `required\0${transportSessionId}`,
  );
  const subjectIdentityHash = sha256(JSON.stringify([
    "synthi.gpu_hmr.runtime_evidence_transport_subject_identity.v1",
    GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_SUBJECT_SCHEMA_VERSION,
    sha256(canonicalPayload),
  ]));
  const observationContextHash = sha256(JSON.stringify([
    "synthi.gpu_hmr.runtime_evidence_transport_observation_context.v1",
    keyId,
    workerInstanceId,
    workerProcessId,
    String(runnerProcessId),
    runtimeSessionId,
    runnerChallengeSha256,
    transportSessionBindingSha256,
    requestId,
    sourceEditId,
    GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_SUBJECT_SCHEMA_VERSION,
    subjectIdentityHash,
    artifactContentHash,
    observedRuntimeProofId,
    observedProofLedgerId,
    observedPayloadSha256,
  ]));
  const receipt: Record<string, unknown> = {
    schemaVersion: "synthi.gpu_hmr.runtime_evidence_transport_receipt.v2",
    algorithm: "ed25519",
    keyId,
    producer: TRANSPORT_PRODUCER,
    workerInstanceId,
    workerProcessId,
    runnerProcessId: String(runnerProcessId),
    runtimeSessionId,
    runnerChallengeSha256,
    transportSessionBindingSha256,
    requestId,
    sourceEditId,
    subjectIdentityNamespace:
      GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_SUBJECT_SCHEMA_VERSION,
    subjectIdentityHash,
    artifactContentHash,
    observedRuntimeProofId,
    observedProofLedgerId,
    observedPayloadSha256,
    observationContextHash,
    issuedAtUnixNs: String(NOW_NS),
    sequence: "1",
    nonce: "b".repeat(64),
  };
  const signingBytes = Buffer.from(JSON.stringify([
    receipt.schemaVersion,
    receipt.algorithm,
    receipt.keyId,
    receipt.producer,
    receipt.workerInstanceId,
    receipt.workerProcessId,
    receipt.runnerProcessId,
    receipt.runtimeSessionId,
    receipt.runnerChallengeSha256,
    receipt.transportSessionBindingSha256,
    receipt.requestId,
    receipt.sourceEditId,
    receipt.subjectIdentityNamespace,
    receipt.subjectIdentityHash,
    receipt.artifactContentHash,
    receipt.observedRuntimeProofId,
    receipt.observedProofLedgerId,
    receipt.observedPayloadSha256,
    receipt.observationContextHash,
    receipt.issuedAtUnixNs,
    receipt.sequence,
    receipt.nonce,
  ]), "utf8");
  const receiptId =
    `gpu-hmr-runtime-evidence-transport-receipt:${sha256(signingBytes)}`;
  receipt.receiptId = receiptId;
  receipt.signature =
    `ed25519:${sign(null, signingBytes, privateKey).toString("base64url")}`;
  const envelope: Record<string, unknown> = {
    schemaVersion: "synthi.gpu_hmr.observed_runtime_evidence_envelope.v2",
    type: "gpu_hmr_observed_runtime_evidence",
    observedPayloadSha256,
    runtimeEvidenceTransportReceipt: receipt,
    proofAuthority:
      "worker_signed_observation_transport_only_not_gpu_hmr_acceptance",
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  };
  binding.runtimeEvidenceTransportEnvelope = envelope;
  return {
    consumer: new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      new SessionRuntimeEvidenceTransportReplayStore(),
      () => NOW_NS,
    ),
    receiptId,
    observationContextHash,
    canonicalPayload,
    envelope,
  };
}

describe("verifyGpuParentRuntimeProofControlBinding", () => {
  it("passes the exact canonical base bytes as both payload and subject", () => {
    let received: RuntimeEvidenceTransportSupportEnvelopeInput | null = null;
    const fixture = makeFixture();
    const receiptConsumer: GpuParentRuntimeProofControlBindingReceiptConsumer = {
      consumeSupportEnvelope(input) {
        received = input;
        return acceptedSupportVerification();
      },
    };

    const result = verifyFixture(fixture, { receiptConsumer });

    expect(result).toMatchObject({
      verified: true,
      code: "gpu_parent_runtime_proof_control_binding_verified",
      reason: null,
      expectedBinding: expectedBindingFrom(fixture.binding),
      computeExpectedOutputContractHash: null,
      computeExpectedOutputSemanticsHash: null,
      evidence: {
        bindingId: fixture.binding.bindingId,
        bindingCanonicalSha256: fixture.binding.bindingCanonicalSha256,
        transportReceiptId: TRANSPORT_RECEIPT_ID,
        observationContextHash: OBSERVATION_CONTEXT_HASH,
      },
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(Object.keys(fixture.binding)).toHaveLength(26);
    expect(Object.keys(basePayload(fixture.binding))).toHaveLength(23);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(result.verified && Object.isFrozen(result.expectedBinding)).toBe(true);
    expect(result).not.toHaveProperty("runtimeEvidenceTransportEnvelope");

    const observed = received as RuntimeEvidenceTransportSupportEnvelopeInput | null;
    expect(observed).not.toBeNull();
    if (observed === null) throw new Error("receipt consumer was not called");
    expect(observed.subjectCanonicalBytes).toBe(observed.observedPayload);
    expect(Buffer.from(observed.observedPayload).toString("utf8"))
      .toBe(canonicalBasePayload(fixture.binding));
    expect(observed).toEqual({
      envelope: fixture.binding.runtimeEvidenceTransportEnvelope,
      observedPayload: Buffer.from(canonicalBasePayload(fixture.binding), "utf8"),
      runnerProcessId: RUNNER_PROCESS_ID,
      runtimeSessionId: RUNTIME_SESSION_ID,
      runnerChallenge: RUNNER_CHALLENGE,
      transportSessionId: TRANSPORT_SESSION_ID,
      requestId: REQUEST_ID,
      sourceEditId: SOURCE_EDIT_ID,
      subjectIdentityNamespace:
        GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_SUBJECT_SCHEMA_VERSION,
      subjectCanonicalBytes: Buffer.from(canonicalBasePayload(fixture.binding), "utf8"),
      artifactContentHash: ARTIFACT_HASH,
      observedRuntimeProofId: RUNTIME_PROOF_ID,
      observedProofLedgerId: LEDGER_PROOF_ID,
    });
  });

  it("derives expectedBinding from a real signed record without name predicates", () => {
    const fixture = makeFixture({
      compileSessionId: "opaque-scope:unclassified-77",
      requestId: `gpu-reload:request:${"c".repeat(32)}`,
      sourceEditId: `source-edit:sha256:${"d".repeat(64)}`,
      artifactContentHash: `sha256:${"e".repeat(64)}`,
      fullRuntimeProofId: `gpu-runtime-proof:sha256:${"f".repeat(64)}`,
      proofLedgerId: `gpu-ledger-proof:sha256:${"0".repeat(64)}`,
      runnerPid: 7001,
      runnerRuntimeSessionId: "opaque-runtime:unclassified-88",
      runnerChallenge: "1".repeat(32),
      commandEnvelopeSha256: `sha256:${"2".repeat(64)}`,
      prepublicationOutputOracleCommitment: {
        schemaVersion:
          "synthi.gpu_hmr.reload_output_oracle_profile_commitment.v1",
        candidateArtifactSha256: `sha256:${"e".repeat(64)}`,
        fissionOutputOracleContractSha256: `sha256:${"3".repeat(64)}`,
        profileBytesSha256: `sha256:${"4".repeat(64)}`,
        editId: `source-edit:sha256:${"d".repeat(64)}`,
      },
      computeExpectedOutputContractHash: EXPECTED_OUTPUT_CONTRACT_HASH,
      computeExpectedOutputSemanticsHash: EXPECTED_OUTPUT_SEMANTICS_HASH,
    });
    const signed = attachRealSignedEnvelope(fixture.binding);

    const result = verifyFixture(fixture, { receiptConsumer: signed.consumer });

    expect(canonicalBasePayload(fixture.binding)).not.toMatch(/project|kernel|fixture/i);
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error(result.code);
    expect(result.expectedBinding).toEqual(expectedBindingFrom(fixture.binding));
    expect(result.computeExpectedOutputContractHash)
      .toBe(EXPECTED_OUTPUT_CONTRACT_HASH);
    expect(result.computeExpectedOutputSemanticsHash)
      .toBe(EXPECTED_OUTPUT_SEMANTICS_HASH);
    expect(result.expectedBinding).not.toBe(fixture.binding);
    expect(result.evidence).toMatchObject({
      transportReceiptId: signed.receiptId,
      observationContextHash: signed.observationContextHash,
    });
    expect(signed.envelope.observedPayloadSha256)
      .toBe(sha256(signed.canonicalPayload));
  });

  it("rejects a signed expected-output hash mutation", () => {
    const fixture = makeFixture({
      computeExpectedOutputContractHash: EXPECTED_OUTPUT_CONTRACT_HASH,
    });
    const signed = attachRealSignedEnvelope(fixture.binding);
    fixture.binding.computeExpectedOutputContractHash = `sha256:${"b".repeat(64)}`;
    sealBinding(fixture.binding);

    const result = verifyFixture(fixture, { receiptConsumer: signed.consumer });

    expect(result).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_control_binding_receipt_consumer_refused",
    });
  });

  it("rejects a signed expected-output semantics mutation", () => {
    const fixture = makeFixture({
      computeExpectedOutputSemanticsHash: EXPECTED_OUTPUT_SEMANTICS_HASH,
    });
    const signed = attachRealSignedEnvelope(fixture.binding);
    fixture.binding.computeExpectedOutputSemanticsHash = `sha256:${"c".repeat(64)}`;
    sealBinding(fixture.binding);

    const result = verifyFixture(fixture, { receiptConsumer: signed.consumer });

    expect(result).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_control_binding_receipt_consumer_refused",
    });
  });

  it.each([
    [
      "artifact",
      {
        schemaVersion:
          "synthi.gpu_hmr.reload_output_oracle_profile_commitment.v1",
        candidateArtifactSha256: `sha256:${"c".repeat(64)}`,
        fissionOutputOracleContractSha256: `sha256:${"3".repeat(64)}`,
        profileBytesSha256: `sha256:${"4".repeat(64)}`,
        editId: SOURCE_EDIT_ID,
      },
    ],
    [
      "edit",
      {
        schemaVersion:
          "synthi.gpu_hmr.reload_output_oracle_profile_commitment.v1",
        candidateArtifactSha256: ARTIFACT_HASH,
        fissionOutputOracleContractSha256: `sha256:${"3".repeat(64)}`,
        profileBytesSha256: `sha256:${"4".repeat(64)}`,
        editId: `source-edit:sha256:${"d".repeat(64)}`,
      },
    ],
  ])("rejects a commitment whose %s identity disagrees with the control binding", (
    _name,
    commitment,
  ) => {
    const fixture = makeFixture({
      prepublicationOutputOracleCommitment: commitment,
    });

    expect(verifyFixture(fixture)).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_control_binding_field_invalid",
    });
    expect(fixture.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("rejects replay through the actual session replay store", () => {
    const fixture = makeFixture();
    const signed = attachRealSignedEnvelope(fixture.binding);
    const overrides = { receiptConsumer: signed.consumer };

    expect(verifyFixture(fixture, overrides).verified).toBe(true);
    const replay = verifyFixture(fixture, overrides);

    expect(replay).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_control_binding_receipt_consumer_refused",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(replay).not.toHaveProperty("expectedBinding");
    expect(Object.isFrozen(replay)).toBe(true);
    expect(Object.isFrozen(replay.evidence)).toBe(true);
  });

  it.each([
    [
      "transport session",
      { transportSessionId: "opaque-control-session:other-01" },
      "gpu_parent_runtime_proof_control_binding_transport_session_mismatch",
    ],
    [
      "compile request nonce",
      { compileRequestNonce: `gpu-proof-transport-request:${"f".repeat(32)}` },
      "gpu_parent_runtime_proof_control_binding_compile_request_nonce_mismatch",
    ],
    [
      "worker process",
      { expectedWorkerProcessId: "9124" },
      "gpu_parent_runtime_proof_control_binding_worker_process_mismatch",
    ],
  ] as const)("rejects an external %s mismatch before receipt consumption", (
    _name,
    overrides,
    code,
  ) => {
    const fixture = makeFixture();

    const result = verifyFixture(fixture, overrides);

    expect(result.code).toBe(code);
    expect(result.verified).toBe(false);
    expect(result).not.toHaveProperty("expectedBinding");
    expect(fixture.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied expectedBinding instead of trusting it", () => {
    const fixture = makeFixture();
    const forgedExpectedBinding: GpuParentRuntimeProofExpectedBinding = {
      ...expectedBindingFrom(fixture.binding),
      runnerProcessId: RUNNER_PROCESS_ID + 100,
    };
    const circularContext = {
      ...fixture.context,
      expectedBinding: forgedExpectedBinding,
    };

    const result = verifyGpuParentRuntimeProofControlBinding(
      fixture.binding,
      circularContext as unknown as GpuParentRuntimeProofControlBindingVerificationContext,
    );

    expect(result.code)
      .toBe("gpu_parent_runtime_proof_control_binding_external_context_invalid");
    expect(result).not.toHaveProperty("expectedBinding");
    expect(fixture.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it.each([
    ["missing field", (binding: Record<string, unknown>) => {
      delete binding.canonicalProofSha256;
    }],
    ["extra field", (binding: Record<string, unknown>) => {
      binding.extra = true;
    }],
    ["alias only", (binding: Record<string, unknown>) => {
      binding.compile_session_id = binding.compileSessionId;
      delete binding.compileSessionId;
    }],
    ["alias conflict", (binding: Record<string, unknown>) => {
      binding.compile_session_id = "opaque-control-session:forged";
    }],
    ["symbol field", (binding: Record<string, unknown>) => {
      Object.defineProperty(binding, Symbol("extra"), {
        value: true,
        enumerable: true,
      });
    }],
    ["accessor field", (binding: Record<string, unknown>) => {
      const requestId = binding.requestId;
      Object.defineProperty(binding, "requestId", {
        get: () => requestId,
        enumerable: true,
      });
    }],
  ])("rejects an inexact event shape: %s", (_name, mutate) => {
    const fixture = makeFixture();
    mutate(fixture.binding);

    const result = verifyFixture(fixture);

    expect(result.code).toBe("gpu_parent_runtime_proof_control_binding_shape_invalid");
    expect(fixture.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it.each([
    ["schema", "schemaVersion", "synthi.gpu_hmr.parent_runtime_proof_control_binding.v3"],
    ["type", "type", "gpu_hmr_parent_runtime_proof_binding"],
    ["authority", "proofAuthority", "parent_acceptance_authority"],
    ["accepted flag", "acceptedForGpuHmr", true],
    ["success flag", "gpuHmrSuccess", true],
    ["satisfaction flag", "canSatisfyRuntimeProof", true],
  ] as const)("rejects an invalid %s claim", (_name, field, value) => {
    const fixture = makeFixture();
    fixture.binding[field] = value;

    const result = verifyFixture(fixture);

    expect(result.code).toBe("gpu_parent_runtime_proof_control_binding_authority_invalid");
    expect(fixture.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it.each([
    ["compile session", "compileSessionId", "contains a space"],
    ["compile nonce", "compileRequestNonce", `gpu-proof-transport-request:${"A".repeat(32)}`],
    ["request ID", "requestId", "gpu-reload:request:short"],
    ["source edit ID", "sourceEditId", `source-edit:sha256:${"G".repeat(64)}`],
    ["artifact hash", "artifactContentHash", `sha256:${"G".repeat(64)}`],
    ["runtime proof ID", "fullRuntimeProofId", `gpu-runtime-proof:${"3".repeat(64)}`],
    ["ledger proof ID", "proofLedgerId", `gpu-ledger-proof:sha256:${"G".repeat(64)}`],
    ["protected proof hash", "protectedProofJsonSha256", "sha256:short"],
    ["canonical proof hash", "canonicalProofSha256", `sha256:${"G".repeat(64)}`],
    ["runner PID", "runnerPid", 1.5],
    ["runner session", "runnerRuntimeSessionId", "contains a space"],
    ["runner challenge", "runnerChallenge", "A".repeat(32)],
    ["command envelope hash", "commandEnvelopeSha256", `sha256:${"G".repeat(64)}`],
    [
      "compute expected-output contract hash",
      "computeExpectedOutputContractHash",
      `sha256:${"A".repeat(64)}`,
    ],
    [
      "compute expected-output semantics hash",
      "computeExpectedOutputSemanticsHash",
      `sha256:${"A".repeat(64)}`,
    ],
    [
      "prepublication output oracle commitment",
      "prepublicationOutputOracleCommitment",
      { schemaVersion: "invalid" },
    ],
    ["worker PID", "parentPid", { value: WORKER_PROCESS_ID }],
    ["binding hash", "bindingCanonicalSha256", "sha256:short"],
    ["binding ID", "bindingId", `gpu-parent-runtime-proof-control-binding:sha256:${"G".repeat(64)}`],
  ] as const)("rejects malformed generic field shape: %s", (
    _name,
    field,
    value,
  ) => {
    const fixture = makeFixture();
    fixture.binding[field] = value;

    const result = verifyFixture(fixture);

    expect(result.code).toBe("gpu_parent_runtime_proof_control_binding_field_invalid");
    expect(fixture.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it.each([0, -0, -1, 0x1_0000_0000, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed process number %s",
    (value) => {
      const fixture = makeFixture();
      fixture.binding.runnerPid = value;

      expect(verifyFixture(fixture).code)
        .toBe("gpu_parent_runtime_proof_control_binding_field_invalid");
      expect(fixture.consumeSupportEnvelope).not.toHaveBeenCalled();
    },
  );

  it.each([null, [], new Date(0), Object.create(null)])(
    "rejects malformed event object %#",
    (rawBinding) => {
      const fixture = makeFixture();

      const result = verifyGpuParentRuntimeProofControlBinding(
        rawBinding,
        fixture.context,
      );

      expect(result.code).toBe("gpu_parent_runtime_proof_control_binding_shape_invalid");
      expect(fixture.consumeSupportEnvelope).not.toHaveBeenCalled();
    },
  );

  it("rejects a canonical binding hash mismatch", () => {
    const fixture = makeFixture();
    fixture.binding.bindingCanonicalSha256 = sha256("different-binding");

    const result = verifyFixture(fixture);

    expect(result.code)
      .toBe("gpu_parent_runtime_proof_control_binding_canonical_hash_mismatch");
    expect(fixture.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("rejects a canonical binding ID mismatch", () => {
    const fixture = makeFixture();
    fixture.binding.bindingId = `${BINDING_ID_PREFIX}${sha256("different-id")}`;

    const result = verifyFixture(fixture);

    expect(result.code).toBe("gpu_parent_runtime_proof_control_binding_id_mismatch");
    expect(fixture.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("rejects an envelope payload mismatch through the actual consumer", () => {
    const fixture = makeFixture();
    const signed = attachRealSignedEnvelope(fixture.binding);
    signed.envelope.observedPayloadSha256 = sha256("forged-envelope-payload");

    const result = verifyFixture(fixture, { receiptConsumer: signed.consumer });

    expect(result.code)
      .toBe("gpu_parent_runtime_proof_control_binding_receipt_consumer_refused");
    expect(result).not.toHaveProperty("expectedBinding");
  });

  it("rejects an explicit support-envelope consumer refusal", () => {
    const fixture = makeFixture();
    const receiptConsumer: GpuParentRuntimeProofControlBindingReceiptConsumer = {
      consumeSupportEnvelope: vi.fn(() => refusedSupportVerification()),
    };

    const result = verifyFixture(fixture, { receiptConsumer });

    expect(result.code)
      .toBe("gpu_parent_runtime_proof_control_binding_receipt_consumer_refused");
    expect(result).not.toHaveProperty("expectedBinding");
  });

  it("rejects a malformed or acceptance-bearing consumer result", () => {
    const fixture = makeFixture();
    const receiptConsumer: GpuParentRuntimeProofControlBindingReceiptConsumer = {
      consumeSupportEnvelope: vi.fn(() => ({
        ...acceptedSupportVerification(),
        acceptedForGpuHmr: true,
      }) as unknown as RuntimeEvidenceTransportSupportVerification),
    };

    const result = verifyFixture(fixture, { receiptConsumer });

    expect(result.code)
      .toBe("gpu_parent_runtime_proof_control_binding_receipt_result_invalid");
    expect(result).not.toHaveProperty("expectedBinding");
  });

  it("fails closed when the receipt consumer throws", () => {
    const fixture = makeFixture();
    const receiptConsumer: GpuParentRuntimeProofControlBindingReceiptConsumer = {
      consumeSupportEnvelope: vi.fn(() => {
        throw new Error("consumer unavailable");
      }),
    };

    const result = verifyFixture(fixture, { receiptConsumer });

    expect(result.code)
      .toBe("gpu_parent_runtime_proof_control_binding_receipt_consumer_failed");
    expect(result).not.toHaveProperty("expectedBinding");
  });
});
