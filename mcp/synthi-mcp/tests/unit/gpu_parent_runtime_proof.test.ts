import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RTCDataChannel } from "werift";
import {
  canonicalizeGpuParentRuntimeProofJson,
  commitPreparedGpuParentRuntimeProofTransport,
  discardPreparedGpuParentRuntimeProofTransport,
  prepareGpuParentRuntimeProofTransport,
  verifyGpuParentRuntimeProofTransport,
  type GpuParentRuntimeProofExpectedBinding,
  type GpuParentRuntimeProofReceiptConsumer,
  type GpuParentRuntimeProofTransactionalReceiptConsumer,
} from "../../src/gpu_parent_runtime_proof.js";
import type {
  RuntimeEvidenceTransportSupportEnvelopeInput,
  RuntimeEvidenceTransportSupportVerification,
} from "../../src/runtime_evidence_transport.js";
import {
  RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
  RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL,
  RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
  RuntimeEvidenceTransportKeyPin,
  RuntimeEvidenceTransportReceiptConsumer,
  SessionRuntimeEvidenceTransportReplayStore,
} from "../../src/runtime_evidence_transport.js";

const SUBJECT_SCHEMA =
  "synthi.gpu_hmr.parent_verified_runtime_proof_subject.v3";
const TRANSPORT_SESSION_ID = "compile-session:0123456789abcdef";
const WORKER_PROCESS_ID = 9123;
const RUNNER_PROCESS_ID = 8123;
const RUNTIME_SESSION_ID = "runner-control-session:0123456789abcdef";
const RUNNER_CHALLENGE = "0123456789abcdef0123456789abcdef";
const REQUEST_ID = "gpu-reload:request:0123456789abcdef0123456789abcdef";
const SOURCE_EDIT_ID = `source-edit:sha256:${"1".repeat(64)}`;
const ARTIFACT_HASH = `sha256:${"2".repeat(64)}`;
const RUNTIME_PROOF_ID = `gpu-runtime-proof:sha256:${"3".repeat(64)}`;
const LEDGER_PROOF_ID = `gpu-ledger-proof:sha256:${"4".repeat(64)}`;
const PROTECTED_PROOF_HASH = `sha256:${"5".repeat(64)}`;
const COMMAND_ENVELOPE_HASH = `sha256:${"6".repeat(64)}`;
const EXPECTED_OUTPUT_SEMANTICS_HASH = `sha256:${"9".repeat(64)}`;
const PREPUBLICATION_OUTPUT_ORACLE_COMMITMENT = Object.freeze({
  schemaVersion: "synthi.gpu_hmr.reload_output_oracle_profile_commitment.v1" as const,
  candidateArtifactSha256: ARTIFACT_HASH,
  fissionOutputOracleContractSha256: `sha256:${"a".repeat(64)}`,
  profileBytesSha256: `sha256:${"b".repeat(64)}`,
  editId: SOURCE_EDIT_ID,
});
const TRANSPORT_RECEIPT_ID =
  `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"7".repeat(64)}`;
const OBSERVATION_CONTEXT_HASH = `sha256:${"8".repeat(64)}`;
const TRANSPORT_PRODUCER = "synthi-webrtc-compiler-worker";
const NOW_NS = 1_784_433_015_000_000_000n;

const EXPECTED_BINDING: GpuParentRuntimeProofExpectedBinding = Object.freeze({
  requestId: REQUEST_ID,
  sourceEditId: SOURCE_EDIT_ID,
  artifactContentHash: ARTIFACT_HASH,
  fullRuntimeProofId: RUNTIME_PROOF_ID,
  proofLedgerId: LEDGER_PROOF_ID,
  runnerProcessId: RUNNER_PROCESS_ID,
  runnerRuntimeSessionId: RUNTIME_SESSION_ID,
  runnerChallenge: RUNNER_CHALLENGE,
  commandEnvelopeSha256: COMMAND_ENVELOPE_HASH,
  computeExpectedOutputSemanticsHash: null,
  prepublicationOutputOracleCommitment: null,
});

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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

function attachRealSignedEnvelope(
  fixture: ReturnType<typeof makeFixture>,
): {
  consumer: RuntimeEvidenceTransportReceiptConsumer;
  receiptId: string;
  observationContextHash: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyBytes = spki.subarray(spki.length - 32);
  const publicKeyValue = publicKeyBytes.toString("base64url");
  const keyId =
    `gpu-hmr-runtime-evidence-transport-key:${sha256(publicKeyBytes)}`;
  const workerInstanceId =
    `gpu-hmr-worker-instance:sha256:${"9".repeat(64)}`;
  const workerProcessId = String(WORKER_PROCESS_ID);
  const announcementMaterial = JSON.stringify([
    RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
    RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
    keyId,
    TRANSPORT_PRODUCER,
    workerInstanceId,
    workerProcessId,
    publicKeyValue,
  ]);
  const announcement = {
    schemaVersion: RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
    algorithm: RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
    keyId,
    producer: TRANSPORT_PRODUCER,
    workerInstanceId,
    workerProcessId,
    publicKey: publicKeyValue,
    keyAnnouncementId:
      `gpu-hmr-runtime-evidence-transport-key-announcement:${sha256(announcementMaterial)}`,
  };
  const channel = new MockEvidenceDataChannel();
  const pin = new RuntimeEvidenceTransportKeyPin();
  pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
  channel.emit(JSON.stringify(announcement));
  expect(pin.snapshot().status).toBe("pinned");

  const proofWithoutParent = { ...fixture.proof };
  delete proofWithoutParent.parentVerification;
  const observedPayload = canonicalizeGpuParentRuntimeProofJson(proofWithoutParent);
  const observedPayloadSha256 = sha256(observedPayload);
  const subjectCanonicalBytes = canonicalizeGpuParentRuntimeProofJson([
    SUBJECT_SCHEMA,
    TRANSPORT_SESSION_ID,
    REQUEST_ID,
    SOURCE_EDIT_ID,
    ARTIFACT_HASH,
    RUNTIME_PROOF_ID,
    LEDGER_PROOF_ID,
    PROTECTED_PROOF_HASH,
    fixture.parent.canonicalProofSha256,
    RUNNER_PROCESS_ID,
    RUNTIME_SESSION_ID,
    RUNNER_CHALLENGE,
    COMMAND_ENVELOPE_HASH,
    fixture.parent.computeExpectedOutputSemanticsHash,
    fixture.parent.prepublicationOutputOracleCommitment,
    WORKER_PROCESS_ID,
    true,
  ]);
  const subjectIdentityHash = sha256(JSON.stringify([
    "synthi.gpu_hmr.runtime_evidence_transport_subject_identity.v1",
    SUBJECT_SCHEMA,
    sha256(subjectCanonicalBytes),
  ]));
  const runnerChallengeSha256 = sha256(RUNNER_CHALLENGE);
  const transportSessionBindingSha256 = sha256(
    `required\0${TRANSPORT_SESSION_ID}`,
  );
  const observationContextHash = sha256(JSON.stringify([
    "synthi.gpu_hmr.runtime_evidence_transport_observation_context.v1",
    keyId,
    workerInstanceId,
    workerProcessId,
    String(RUNNER_PROCESS_ID),
    RUNTIME_SESSION_ID,
    runnerChallengeSha256,
    transportSessionBindingSha256,
    REQUEST_ID,
    SOURCE_EDIT_ID,
    SUBJECT_SCHEMA,
    subjectIdentityHash,
    ARTIFACT_HASH,
    RUNTIME_PROOF_ID,
    LEDGER_PROOF_ID,
    observedPayloadSha256,
  ]));
  const receipt: Record<string, unknown> = {
    schemaVersion: "synthi.gpu_hmr.runtime_evidence_transport_receipt.v2",
    algorithm: "ed25519",
    keyId,
    producer: TRANSPORT_PRODUCER,
    workerInstanceId,
    workerProcessId,
    runnerProcessId: String(RUNNER_PROCESS_ID),
    runtimeSessionId: RUNTIME_SESSION_ID,
    runnerChallengeSha256,
    transportSessionBindingSha256,
    requestId: REQUEST_ID,
    sourceEditId: SOURCE_EDIT_ID,
    subjectIdentityNamespace: SUBJECT_SCHEMA,
    subjectIdentityHash,
    artifactContentHash: ARTIFACT_HASH,
    observedRuntimeProofId: RUNTIME_PROOF_ID,
    observedProofLedgerId: LEDGER_PROOF_ID,
    observedPayloadSha256,
    observationContextHash,
    issuedAtUnixNs: String(NOW_NS),
    sequence: "1",
    nonce: "a".repeat(64),
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
  fixture.parent.runtimeEvidenceTransportEnvelope = {
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
  delete fixture.parent.receiptId;
  fixture.parent.receiptId = `gpu-parent-runtime-proof-receipt:${sha256(
    canonicalizeGpuParentRuntimeProofJson(fixture.parent),
  )}`;

  return {
    consumer: new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      new SessionRuntimeEvidenceTransportReplayStore(),
      () => NOW_NS,
    ),
    receiptId,
    observationContextHash,
  };
}

function acceptedTransportVerification(): RuntimeEvidenceTransportSupportVerification {
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

function refusedTransportVerification(): RuntimeEvidenceTransportSupportVerification {
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

function makeFixture(
  receiptConsumer?: GpuParentRuntimeProofReceiptConsumer,
): {
  proof: Record<string, unknown>;
  parent: Record<string, unknown>;
  receiptConsumer: GpuParentRuntimeProofReceiptConsumer;
} {
  const proof: Record<string, unknown> = {
    schemaVersion: "synthi.gpu.hmr.proof.v1",
    resultState: "gpu-hmr-full-runtime-proven",
    nested: {
      z: true,
      a: [1, "runtime", null],
    },
  };
  const canonicalProofSha256 = sha256(
    canonicalizeGpuParentRuntimeProofJson(proof),
  );
  const parent: Record<string, unknown> = {
    schemaVersion: "synthi.gpu_hmr.parent_verified_runtime_proof.v3",
    proofAuthority:
      "parent_recomputed_runtime_proof_binding_only_not_gpu_hmr_acceptance",
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    parentRecomputed: true,
    runtimeContinuationAcknowledged: true,
    compileSessionId: TRANSPORT_SESSION_ID,
    requestId: REQUEST_ID,
    sourceEditId: SOURCE_EDIT_ID,
    artifactContentHash: ARTIFACT_HASH,
    fullRuntimeProofId: RUNTIME_PROOF_ID,
    proofLedgerId: LEDGER_PROOF_ID,
    protectedProofJsonSha256: PROTECTED_PROOF_HASH,
    canonicalProofSha256,
    runnerPid: RUNNER_PROCESS_ID,
    runnerRuntimeSessionId: RUNTIME_SESSION_ID,
    runnerChallenge: RUNNER_CHALLENGE,
    commandEnvelopeSha256: COMMAND_ENVELOPE_HASH,
    computeExpectedOutputSemanticsHash: null,
    prepublicationOutputOracleCommitment: null,
    parentPid: WORKER_PROCESS_ID,
    runtimeEvidenceTransportEnvelope: {
      schemaVersion: "test.transport.envelope.v1",
      acceptedForGpuHmr: false,
    },
  };
  parent.receiptId = `gpu-parent-runtime-proof-receipt:${sha256(
    canonicalizeGpuParentRuntimeProofJson(parent),
  )}`;
  proof.parentVerification = parent;
  return {
    proof,
    parent,
    receiptConsumer: receiptConsumer ?? {
      consumeSupportEnvelope: vi.fn(() => acceptedTransportVerification()),
    },
  };
}

function verifyFixture(
  fixture: ReturnType<typeof makeFixture>,
  overrides: Partial<{
    transportSessionId: string;
    expectedWorkerProcessId: string;
    expectedBinding: GpuParentRuntimeProofExpectedBinding;
  }> = {},
) {
  return verifyGpuParentRuntimeProofTransport(fixture.proof, {
    transportSessionId: overrides.transportSessionId ?? TRANSPORT_SESSION_ID,
    expectedWorkerProcessId:
      overrides.expectedWorkerProcessId ?? String(WORKER_PROCESS_ID),
    expectedBinding: overrides.expectedBinding ?? EXPECTED_BINDING,
    receiptConsumer: fixture.receiptConsumer,
  });
}

function prepareFixture(
  fixture: ReturnType<typeof makeFixture>,
  receiptConsumer: GpuParentRuntimeProofTransactionalReceiptConsumer,
) {
  return prepareGpuParentRuntimeProofTransport(fixture.proof, {
    transportSessionId: TRANSPORT_SESSION_ID,
    expectedWorkerProcessId: String(WORKER_PROCESS_ID),
    expectedBinding: EXPECTED_BINDING,
    receiptConsumer,
  });
}

describe("verifyGpuParentRuntimeProofTransport", () => {
  it("passes exact parent-bound material to the support receipt consumer", () => {
    let received: RuntimeEvidenceTransportSupportEnvelopeInput | null = null;
    const receiptConsumer: GpuParentRuntimeProofReceiptConsumer = {
      consumeSupportEnvelope(input) {
        received = input;
        return acceptedTransportVerification();
      },
    };
    const fixture = makeFixture(receiptConsumer);

    const result = verifyFixture(fixture);

    expect(result).toMatchObject({
      verified: true,
      code: "gpu_parent_runtime_proof_verified",
      reason: null,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      evidence: {
        parentReceiptId: fixture.parent.receiptId,
        transportReceiptId: TRANSPORT_RECEIPT_ID,
        canonicalProofSha256: fixture.parent.canonicalProofSha256,
        observationContextHash: OBSERVATION_CONTEXT_HASH,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);

    const proofWithoutParent = { ...fixture.proof };
    delete proofWithoutParent.parentVerification;
    const canonicalProofBytes = Buffer.from(
      canonicalizeGpuParentRuntimeProofJson(proofWithoutParent),
      "utf8",
    );
    const expectedSubjectBytes = Buffer.from(JSON.stringify([
      SUBJECT_SCHEMA,
      TRANSPORT_SESSION_ID,
      REQUEST_ID,
      SOURCE_EDIT_ID,
      ARTIFACT_HASH,
      RUNTIME_PROOF_ID,
      LEDGER_PROOF_ID,
      PROTECTED_PROOF_HASH,
      fixture.parent.canonicalProofSha256,
      RUNNER_PROCESS_ID,
      RUNTIME_SESSION_ID,
      RUNNER_CHALLENGE,
      COMMAND_ENVELOPE_HASH,
      null,
      null,
      WORKER_PROCESS_ID,
      true,
    ]), "utf8");
    expect(received).toEqual({
      envelope: fixture.parent.runtimeEvidenceTransportEnvelope,
      observedPayload: canonicalProofBytes,
      runnerProcessId: RUNNER_PROCESS_ID,
      runtimeSessionId: RUNTIME_SESSION_ID,
      runnerChallenge: RUNNER_CHALLENGE,
      transportSessionId: TRANSPORT_SESSION_ID,
      requestId: REQUEST_ID,
      sourceEditId: SOURCE_EDIT_ID,
      subjectIdentityNamespace: SUBJECT_SCHEMA,
      subjectCanonicalBytes: expectedSubjectBytes,
      artifactContentHash: ARTIFACT_HASH,
      observedRuntimeProofId: RUNTIME_PROOF_ID,
      observedProofLedgerId: LEDGER_PROOF_ID,
    });
    expect(JSON.stringify(result)).not.toContain(RUNNER_CHALLENGE);
    expect(JSON.stringify(result)).not.toContain(REQUEST_ID);
    expect(JSON.stringify(result)).not.toContain(String(WORKER_PROCESS_ID));
  });

  it("verifies a live-channel-pinned Ed25519 envelope and rejects its replay", () => {
    const fixture = makeFixture();
    const signed = attachRealSignedEnvelope(fixture);
    fixture.receiptConsumer = signed.consumer;

    expect(verifyFixture(fixture)).toMatchObject({
      verified: true,
      code: "gpu_parent_runtime_proof_verified",
      evidence: {
        transportReceiptId: signed.receiptId,
        observationContextHash: signed.observationContextHash,
      },
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(verifyFixture(fixture)).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_receipt_consumer_refused",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
  });

  it("binds a prepublication output-oracle commitment into the parent receipt", () => {
    const fixture = makeFixture();
    fixture.parent.prepublicationOutputOracleCommitment =
      PREPUBLICATION_OUTPUT_ORACLE_COMMITMENT;
    const signed = attachRealSignedEnvelope(fixture);
    fixture.receiptConsumer = signed.consumer;

    const result = verifyFixture(fixture, {
      expectedBinding: Object.freeze({
        ...EXPECTED_BINDING,
        prepublicationOutputOracleCommitment:
          PREPUBLICATION_OUTPUT_ORACLE_COMMITMENT,
      }),
    });

    expect(result).toMatchObject({
      verified: true,
      code: "gpu_parent_runtime_proof_verified",
      evidence: {
        transportReceiptId: signed.receiptId,
        observationContextHash: signed.observationContextHash,
      },
    });
  });

  it("binds caller-owned output semantics into the parent receipt", () => {
    const fixture = makeFixture();
    fixture.parent.computeExpectedOutputSemanticsHash =
      EXPECTED_OUTPUT_SEMANTICS_HASH;
    const signed = attachRealSignedEnvelope(fixture);
    fixture.receiptConsumer = signed.consumer;

    const result = verifyFixture(fixture, {
      expectedBinding: Object.freeze({
        ...EXPECTED_BINDING,
        computeExpectedOutputSemanticsHash: EXPECTED_OUTPUT_SEMANTICS_HASH,
      }),
    });

    expect(result).toMatchObject({
      verified: true,
      code: "gpu_parent_runtime_proof_verified",
      evidence: {
        transportReceiptId: signed.receiptId,
        observationContextHash: signed.observationContextHash,
      },
    });
  });

  it.each([
    [
      "artifact",
      {
        ...PREPUBLICATION_OUTPUT_ORACLE_COMMITMENT,
        candidateArtifactSha256: `sha256:${"c".repeat(64)}`,
      },
    ],
    [
      "edit",
      {
        ...PREPUBLICATION_OUTPUT_ORACLE_COMMITMENT,
        editId: `source-edit:sha256:${"d".repeat(64)}`,
      },
    ],
  ])("rejects a commitment whose %s identity disagrees with its signed parent", (
    _name,
    commitment,
  ) => {
    const fixture = makeFixture();
    fixture.parent.prepublicationOutputOracleCommitment = commitment;
    delete fixture.parent.receiptId;
    fixture.parent.receiptId = `gpu-parent-runtime-proof-receipt:${sha256(
      canonicalizeGpuParentRuntimeProofJson(fixture.parent),
    )}`;

    expect(verifyFixture(fixture)).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_parent_field_invalid",
    });
    expect(fixture.receiptConsumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("rejects an expected commitment whose identity disagrees with its binding", () => {
    const fixture = makeFixture();
    const result = verifyFixture(fixture, {
      expectedBinding: Object.freeze({
        ...EXPECTED_BINDING,
        prepublicationOutputOracleCommitment: Object.freeze({
          ...PREPUBLICATION_OUTPUT_ORACLE_COMMITMENT,
          candidateArtifactSha256: `sha256:${"c".repeat(64)}`,
        }),
      }),
    });

    expect(result).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_external_context_invalid",
    });
    expect(fixture.receiptConsumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it.each([
    ["missing parent", (fixture: ReturnType<typeof makeFixture>) => {
      delete fixture.proof.parentVerification;
    }, "gpu_parent_runtime_proof_parent_verification_missing"],
    ["extra parent field", (fixture: ReturnType<typeof makeFixture>) => {
      fixture.parent.extra = true;
    }, "gpu_parent_runtime_proof_parent_shape_invalid"],
    ["authority claim", (fixture: ReturnType<typeof makeFixture>) => {
      fixture.parent.gpuHmrSuccess = true;
    }, "gpu_parent_runtime_proof_parent_authority_invalid"],
  ])("rejects %s", (_name, mutate, code) => {
    const fixture = makeFixture();
    mutate(fixture);
    const result = verifyFixture(fixture);
    expect(result.verified).toBe(false);
    expect(result.code).toBe(code);
    expect(fixture.receiptConsumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("rejects an externally supplied transport-session mismatch", () => {
    const fixture = makeFixture();
    const result = verifyFixture(fixture, {
      transportSessionId: "compile-session:fedcba9876543210",
    });
    expect(result.code).toBe("gpu_parent_runtime_proof_transport_session_mismatch");
    expect(fixture.receiptConsumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("fails closed instead of throwing on a missing external context", () => {
    const fixture = makeFixture();
    expect(verifyGpuParentRuntimeProofTransport(
      fixture.proof,
      null as unknown as Parameters<typeof verifyGpuParentRuntimeProofTransport>[1],
    ).code).toBe("gpu_parent_runtime_proof_external_context_invalid");
    expect(fixture.receiptConsumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("rejects an externally supplied worker-process mismatch", () => {
    const fixture = makeFixture();
    const result = verifyFixture(fixture, { expectedWorkerProcessId: "9999" });
    expect(result.code).toBe("gpu_parent_runtime_proof_worker_process_mismatch");
    expect(fixture.receiptConsumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it.each([
    ["request", "requestId", "gpu-reload:request:fedcba9876543210fedcba9876543210"],
    ["source edit", "sourceEditId", `source-edit:sha256:${"a".repeat(64)}`],
    ["artifact", "artifactContentHash", `sha256:${"b".repeat(64)}`],
    ["runtime proof", "fullRuntimeProofId", `gpu-runtime-proof:sha256:${"c".repeat(64)}`],
    ["ledger proof", "proofLedgerId", `gpu-ledger-proof:sha256:${"d".repeat(64)}`],
    ["runner process", "runnerPid", RUNNER_PROCESS_ID + 1],
    ["runner session", "runnerRuntimeSessionId", "runner-control-session:fedcba9876543210"],
    ["runner challenge", "runnerChallenge", "e".repeat(32)],
    ["command envelope", "commandEnvelopeSha256", `sha256:${"f".repeat(64)}`],
    [
      "prepublication output oracle",
      "prepublicationOutputOracleCommitment",
      PREPUBLICATION_OUTPUT_ORACLE_COMMITMENT,
    ],
  ] as const)("rejects a same-session %s splice before consuming replay state", (
    _name,
    field,
    value,
  ) => {
    const fixture = makeFixture();
    fixture.parent[field] = value;
    const result = verifyFixture(fixture);
    expect(result.code).toBe("gpu_parent_runtime_proof_external_binding_mismatch");
    expect(fixture.receiptConsumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("rejects an incomplete external binding before consuming replay state", () => {
    const fixture = makeFixture();
    const incomplete = { ...EXPECTED_BINDING } as Record<string, unknown>;
    delete incomplete.proofLedgerId;
    const result = verifyFixture(fixture, {
      expectedBinding: incomplete as unknown as GpuParentRuntimeProofExpectedBinding,
    });
    expect(result.code).toBe("gpu_parent_runtime_proof_external_context_invalid");
    expect(fixture.receiptConsumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("rejects a canonical proof hash mismatch", () => {
    const fixture = makeFixture();
    fixture.parent.canonicalProofSha256 = `sha256:${"9".repeat(64)}`;
    const result = verifyFixture(fixture);
    expect(result.code).toBe("gpu_parent_runtime_proof_canonical_hash_mismatch");
    expect(fixture.receiptConsumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("rejects a parent receipt-id mismatch", () => {
    const fixture = makeFixture();
    fixture.parent.receiptId =
      `gpu-parent-runtime-proof-receipt:sha256:${"a".repeat(64)}`;
    const result = verifyFixture(fixture);
    expect(result.code).toBe("gpu_parent_runtime_proof_parent_receipt_mismatch");
    expect(fixture.receiptConsumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it.each(["alias only", "alias conflict"])("rejects snake-case parent %s", (mode) => {
    const fixture = makeFixture();
    fixture.proof.parent_verification = fixture.parent;
    if (mode === "alias only") delete fixture.proof.parentVerification;
    const result = verifyFixture(fixture);
    expect(result.code).toBe("gpu_parent_runtime_proof_parent_alias_rejected");
    expect(fixture.receiptConsumer.consumeSupportEnvelope).not.toHaveBeenCalled();
  });

  it("rejects unsafe numeric and non-plain canonical proof values", () => {
    expect(() => canonicalizeGpuParentRuntimeProofJson({
      unsafe: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow(TypeError);
    expect(() => canonicalizeGpuParentRuntimeProofJson({ fractional: 1.5 }))
      .toThrow(TypeError);
    expect(() => canonicalizeGpuParentRuntimeProofJson({ negativeZero: -0 }))
      .toThrow(TypeError);
    expect(() => canonicalizeGpuParentRuntimeProofJson({ date: new Date(0) }))
      .toThrow(TypeError);
    expect(() => canonicalizeGpuParentRuntimeProofJson({ missing: undefined }))
      .toThrow(TypeError);

    const fixture = makeFixture();
    fixture.proof.unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(verifyFixture(fixture).code)
      .toBe("gpu_parent_runtime_proof_canonicalization_failed");
  });

  it("refuses success when the receipt consumer refuses the support envelope", () => {
    const fixture = makeFixture({
      consumeSupportEnvelope: vi.fn(() => refusedTransportVerification()),
    });
    const result = verifyFixture(fixture);
    expect(result).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_receipt_consumer_refused",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
  });
});

describe("staged GPU parent runtime proof transport", () => {
  it("prepares without consuming replay state and commits exactly once", () => {
    const fixture = makeFixture();
    const signed = attachRealSignedEnvelope(fixture);

    const prepared = prepareFixture(fixture, signed.consumer);

    expect(prepared).toMatchObject({
      schemaVersion: "synthi.gpu_hmr.parent_runtime_proof_transport_preparation.v1",
      proofAuthority:
        "parent_runtime_proof_preparation_only_not_gpu_hmr_acceptance",
      prepared: true,
      code: "gpu_parent_runtime_proof_prepared",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      evidence: {
        transportReceiptId: signed.receiptId,
        observationContextHash: signed.observationContextHash,
      },
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.evidence)).toBe(true);
    expect(prepared).not.toHaveProperty("capability");
    expect(JSON.stringify(prepared)).not.toContain(RUNNER_CHALLENGE);

    expect(commitPreparedGpuParentRuntimeProofTransport(prepared)).toMatchObject({
      verified: true,
      code: "gpu_parent_runtime_proof_verified",
      evidence: {
        transportReceiptId: signed.receiptId,
        observationContextHash: signed.observationContextHash,
      },
    });
    expect(commitPreparedGpuParentRuntimeProofTransport(prepared)).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_preparation_already_used",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
  });

  it("does not expose a committable capability through clones or forged data", () => {
    const fixture = makeFixture();
    const signed = attachRealSignedEnvelope(fixture);
    const prepared = prepareFixture(fixture, signed.consumer);
    const clone = structuredClone(prepared);
    const forged = Object.freeze({ ...prepared });

    expect(commitPreparedGpuParentRuntimeProofTransport(clone).code)
      .toBe("gpu_parent_runtime_proof_preparation_invalid");
    expect(commitPreparedGpuParentRuntimeProofTransport(forged).code)
      .toBe("gpu_parent_runtime_proof_preparation_invalid");
    expect(commitPreparedGpuParentRuntimeProofTransport(prepared).verified).toBe(true);
  });

  it("keeps a refused transport preparation non-authoritative", () => {
    const fixture = makeFixture();
    const transactionalConsumer: GpuParentRuntimeProofTransactionalReceiptConsumer = {
      consumeSupportEnvelope: vi.fn(() => refusedTransportVerification()),
      prepareSupportEnvelope: vi.fn(() => Object.freeze({
        schemaVersion:
          "synthi.gpu_hmr.runtime_evidence_transport_preparation.v1" as const,
        proofAuthority:
          "cryptographic_and_freshness_preparation_only_replay_not_committed" as const,
        prepared: false,
        reason: "test_receipt_refused",
        capability: null,
        receiptId: null,
        observationContextHash: null,
        freshnessChecked: false,
        replayChecked: false as const,
        acceptedForGpuHmr: false as const,
        gpuHmrSuccess: false as const,
        canSatisfyRuntimeProof: false as const,
      })),
      commitPreparedSupportEnvelope: vi.fn(() => acceptedTransportVerification()),
      discardPreparedSupportEnvelope: vi.fn(() => true),
    };

    const prepared = prepareFixture(fixture, transactionalConsumer);

    expect(prepared).toMatchObject({
      prepared: false,
      code: "gpu_parent_runtime_proof_receipt_consumer_refused",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(transactionalConsumer.commitPreparedSupportEnvelope).not.toHaveBeenCalled();
    expect(commitPreparedGpuParentRuntimeProofTransport(prepared).verified).toBe(false);
  });

  it("rejects accessor and proxy transactional methods without invoking them", () => {
    const fixture = makeFixture();
    const prepareGetter = vi.fn(() => () => undefined);
    const accessorConsumer = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorConsumer, "prepareSupportEnvelope", {
      enumerable: true,
      get: prepareGetter,
    });
    Object.defineProperty(accessorConsumer, "commitPreparedSupportEnvelope", {
      enumerable: true,
      value: vi.fn(),
    });

    const accessorResult = prepareFixture(
      fixture,
      accessorConsumer as unknown as GpuParentRuntimeProofTransactionalReceiptConsumer,
    );
    expect(accessorResult).toMatchObject({
      prepared: false,
      code: "gpu_parent_runtime_proof_transactional_context_invalid",
    });
    expect(prepareGetter).not.toHaveBeenCalled();

    const proxyResult = prepareFixture(
      fixture,
      new Proxy({
        consumeSupportEnvelope: vi.fn(),
        prepareSupportEnvelope: vi.fn(),
        commitPreparedSupportEnvelope: vi.fn(),
        discardPreparedSupportEnvelope: vi.fn(),
      }, {}) as unknown as GpuParentRuntimeProofTransactionalReceiptConsumer,
    );
    expect(proxyResult).toMatchObject({
      prepared: false,
      code: "gpu_parent_runtime_proof_transactional_context_invalid",
    });
  });

  it("retires the parent preparation when the transport commit throws", () => {
    const fixture = makeFixture();
    const capability = Object.freeze({});
    const transactionalConsumer: GpuParentRuntimeProofTransactionalReceiptConsumer = {
      consumeSupportEnvelope: vi.fn(() => refusedTransportVerification()),
      prepareSupportEnvelope: vi.fn(() => Object.freeze({
        schemaVersion:
          "synthi.gpu_hmr.runtime_evidence_transport_preparation.v1" as const,
        proofAuthority:
          "cryptographic_and_freshness_preparation_only_replay_not_committed" as const,
        prepared: true,
        reason: null,
        capability,
        receiptId: TRANSPORT_RECEIPT_ID,
        observationContextHash: OBSERVATION_CONTEXT_HASH,
        freshnessChecked: true,
        replayChecked: false as const,
        acceptedForGpuHmr: false as const,
        gpuHmrSuccess: false as const,
        canSatisfyRuntimeProof: false as const,
      })),
      commitPreparedSupportEnvelope: vi.fn(() => {
        throw new Error("transport unavailable");
      }),
      discardPreparedSupportEnvelope: vi.fn(() => true),
    };
    const prepared = prepareFixture(fixture, transactionalConsumer);

    expect(prepared.prepared).toBe(true);
    expect(commitPreparedGpuParentRuntimeProofTransport(prepared)).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_receipt_consumer_failed",
    });
    expect(commitPreparedGpuParentRuntimeProofTransport(prepared)).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_preparation_already_used",
    });
    expect(transactionalConsumer.commitPreparedSupportEnvelope).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the transport consumer is disposed after prepare", () => {
    const fixture = makeFixture();
    const signed = attachRealSignedEnvelope(fixture);
    const prepared = prepareFixture(fixture, signed.consumer);

    expect(prepared.prepared).toBe(true);
    signed.consumer.dispose();
    expect(commitPreparedGpuParentRuntimeProofTransport(prepared)).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_receipt_consumer_refused",
    });
    expect(commitPreparedGpuParentRuntimeProofTransport(prepared)).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_preparation_already_used",
    });
  });

  it("discards an abandoned parent preparation without consuming replay", () => {
    const fixture = makeFixture();
    const signed = attachRealSignedEnvelope(fixture);
    const prepared = prepareFixture(fixture, signed.consumer);

    expect(prepared.prepared).toBe(true);
    expect(discardPreparedGpuParentRuntimeProofTransport(structuredClone(prepared)))
      .toBe(false);
    expect(discardPreparedGpuParentRuntimeProofTransport(prepared)).toBe(true);
    expect(discardPreparedGpuParentRuntimeProofTransport(prepared)).toBe(false);
    expect(commitPreparedGpuParentRuntimeProofTransport(prepared)).toMatchObject({
      verified: false,
      code: "gpu_parent_runtime_proof_preparation_already_used",
    });

    const retry = prepareFixture(fixture, signed.consumer);
    expect(retry.prepared).toBe(true);
    expect(commitPreparedGpuParentRuntimeProofTransport(retry).verified).toBe(true);
  });
});

describe("canonicalizeGpuParentRuntimeProofJson", () => {
  it("matches the cross-language UTF-8 key-order golden vector", () => {
    const astral = "\u{10000}";
    const privateUse = "\ue000";
    expect([astral, privateUse].sort()).toEqual([astral, privateUse]);
    const canonical = canonicalizeGpuParentRuntimeProofJson({
      [astral]: 1,
      [privateUse]: 2,
      a: [null, true, false, "x", Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
    });
    expect(canonical).toBe(
      `{"a":[null,true,false,"x",9007199254740991,-9007199254740991],`
      + `"${privateUse}":2,"${astral}":1}`,
    );
    expect(sha256(canonical)).toBe(
      "sha256:9cd01d39f1b9883189a95c0fe9a25514cf561fa4f96f8367ae2bb67892ccf223",
    );
  });

  it("uses the worker's 16 MiB proof ceiling instead of a narrower MCP profile", () => {
    const overEightMiB = "x".repeat(8 * 1024 * 1024);
    expect(() => canonicalizeGpuParentRuntimeProofJson({ payload: overEightMiB }))
      .not.toThrow();
    expect(() => canonicalizeGpuParentRuntimeProofJson([
      overEightMiB,
      overEightMiB,
    ])).toThrow(TypeError);
    const overSixteenMiB = "x".repeat(16 * 1024 * 1024 + 1);
    expect(() => canonicalizeGpuParentRuntimeProofJson({ payload: overSixteenMiB }))
      .toThrow(TypeError);
  });

  it("matches the worker's container and total-node complexity limits", () => {
    const tooManyEntries = Array.from({ length: 100_001 }, () => null);
    expect(() => canonicalizeGpuParentRuntimeProofJson(tooManyEntries))
      .toThrow(TypeError);

    const nodeHeavy = Array.from(
      { length: 50_001 },
      () => [null],
    );
    expect(() => canonicalizeGpuParentRuntimeProofJson(nodeHeavy))
      .toThrow(TypeError);

    let tooDeep: unknown = null;
    for (let depth = 0; depth <= 128; depth += 1) tooDeep = [tooDeep];
    expect(() => canonicalizeGpuParentRuntimeProofJson(tooDeep))
      .toThrow(TypeError);
  });
});
