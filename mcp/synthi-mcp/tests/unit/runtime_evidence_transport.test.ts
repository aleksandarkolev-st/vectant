import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RTCDataChannel } from "werift";
import {
  RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
  RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL,
  RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
  RuntimeEvidenceTransportKeyPin,
  RuntimeEvidenceTransportReceiptConsumer,
  SessionRuntimeEvidenceTransportReplayStore,
  type RuntimeEvidenceTransportSupportEnvelopeInput,
  parseRuntimeEvidenceTransportVerificationKey,
} from "../../src/runtime_evidence_transport.js";

const PRODUCER = "synthi-webrtc-compiler-worker";
const KEY_ID_PREFIX = "gpu-hmr-runtime-evidence-transport-key:sha256:";
const KEY_ANNOUNCEMENT_ID_PREFIX =
  "gpu-hmr-runtime-evidence-transport-key-announcement:sha256:";
const WORKER_INSTANCE_ID_PREFIX = "gpu-hmr-worker-instance:sha256:";

class MockDataChannel extends EventTarget {
  constructor(
    readonly label: string = RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL,
    readonly readyState: "connecting" | "open" | "closing" | "closed" = "open",
  ) {
    super();
  }

  emit(data: unknown): void {
    const event = new Event("message");
    (event as unknown as { data: unknown }).data = data;
    this.dispatchEvent(event);
  }

  closeRemotely(): void {
    this.dispatchEvent(new Event("close"));
  }
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function keyAnnouncement(
  seed: number,
  publicKeyBytes: Buffer = Buffer.alloc(32, seed),
): Record<string, unknown> {
  const publicKey = publicKeyBytes.toString("base64url");
  const keyId = `${KEY_ID_PREFIX}${sha256Hex(publicKeyBytes)}`;
  const workerInstanceId = `${WORKER_INSTANCE_ID_PREFIX}${seed.toString(16).padStart(64, "0")}`;
  const workerProcessId = String(1000 + seed);
  const material = JSON.stringify([
    RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
    RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
    keyId,
    PRODUCER,
    workerInstanceId,
    workerProcessId,
    publicKey,
  ]);
  return {
    schemaVersion: RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
    algorithm: RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
    keyId,
    producer: PRODUCER,
    workerInstanceId,
    workerProcessId,
    publicKey,
    keyAnnouncementId: `${KEY_ANNOUNCEMENT_ID_PREFIX}${sha256Hex(material)}`,
  };
}

function prefixedSha256(value: Uint8Array | string): string {
  return `sha256:${sha256Hex(value)}`;
}

function pinAnnouncement(announcement: Record<string, unknown>): RuntimeEvidenceTransportKeyPin {
  const channel = new MockDataChannel();
  const pin = new RuntimeEvidenceTransportKeyPin();
  pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
  channel.emit(JSON.stringify(announcement));
  expect(pin.snapshot().status).toBe("pinned");
  return pin;
}

interface SignedEnvelopeFixture {
  readonly input: RuntimeEvidenceTransportSupportEnvelopeInput;
  readonly receipt: Record<string, unknown>;
}

const NOW_NS = 1_784_433_015_000_000_000n;

function signedEnvelopeFixture(options: {
  announcement: Record<string, unknown>;
  privateKey: KeyObject;
  issuedAtUnixNs?: bigint;
  sequence?: bigint;
  nonceSeed?: string;
}): SignedEnvelopeFixture {
  const observedPayload = JSON.stringify({
    type: "gpu_hmr_proof",
    proofId: `gpu-runtime-proof:sha256:${"1".repeat(64)}`,
  });
  const transportSessionId = "session-arbitrary-source-tree-01";
  const requestId = `gpu-reload:request:${"2".repeat(32)}`;
  const sourceEditId = `source-edit:sha256:${"3".repeat(64)}`;
  const subjectIdentityNamespace = "synthi.test.parent_runtime_subject.v1";
  const subjectCanonicalBytes = JSON.stringify([
    subjectIdentityNamespace,
    transportSessionId,
    requestId,
    sourceEditId,
  ]);
  const artifactContentHash = `sha256:${"4".repeat(64)}`;
  const observedRuntimeProofId = `gpu-runtime-proof:sha256:${"1".repeat(64)}`;
  const observedProofLedgerId = `gpu-ledger-proof:sha256:${"5".repeat(64)}`;
  const runnerProcessId = 4201;
  const runtimeSessionId = "runner-runtime-session-arbitrary-01";
  const runnerChallenge = "a".repeat(32);
  const runnerChallengeSha256 = prefixedSha256(runnerChallenge);
  const transportSessionBindingSha256 = prefixedSha256(`required\0${transportSessionId}`);
  const observedPayloadSha256 = prefixedSha256(observedPayload);
  const subjectIdentityHash = prefixedSha256(JSON.stringify([
    "synthi.gpu_hmr.runtime_evidence_transport_subject_identity.v1",
    subjectIdentityNamespace,
    prefixedSha256(subjectCanonicalBytes),
  ]));
  const workerProcessId = String(options.announcement.workerProcessId);
  const keyId = String(options.announcement.keyId);
  const workerInstanceId = String(options.announcement.workerInstanceId);
  const observationContextHash = prefixedSha256(JSON.stringify([
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
    subjectIdentityNamespace,
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
    producer: PRODUCER,
    workerInstanceId,
    workerProcessId,
    runnerProcessId: String(runnerProcessId),
    runtimeSessionId,
    runnerChallengeSha256,
    transportSessionBindingSha256,
    requestId,
    sourceEditId,
    subjectIdentityNamespace,
    subjectIdentityHash,
    artifactContentHash,
    observedRuntimeProofId,
    observedProofLedgerId,
    observedPayloadSha256,
    observationContextHash,
    issuedAtUnixNs: String(options.issuedAtUnixNs ?? NOW_NS),
    sequence: String(options.sequence ?? 1n),
    nonce: (options.nonceSeed ?? "6").repeat(64),
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
  receipt.receiptId =
    `gpu-hmr-runtime-evidence-transport-receipt:sha256:${sha256Hex(signingBytes)}`;
  receipt.signature = `ed25519:${sign(null, signingBytes, options.privateKey).toString("base64url")}`;
  const envelope = {
    schemaVersion: "synthi.gpu_hmr.observed_runtime_evidence_envelope.v2",
    type: "gpu_hmr_observed_runtime_evidence",
    observedPayloadSha256,
    runtimeEvidenceTransportReceipt: receipt,
    proofAuthority: "worker_signed_observation_transport_only_not_gpu_hmr_acceptance",
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  };
  return {
    receipt,
    input: {
      envelope,
      observedPayload,
      runnerProcessId,
      runtimeSessionId,
      runnerChallenge,
      transportSessionId,
      requestId,
      sourceEditId,
      subjectIdentityNamespace,
      subjectCanonicalBytes,
      artifactContentHash,
      observedRuntimeProofId,
      observedProofLedgerId,
    },
  };
}

describe("RuntimeEvidenceTransportKeyPin", () => {
  it("pins one self-consistent key from the dedicated authenticated peer channel", () => {
    const channel = new MockDataChannel();
    const pin = new RuntimeEvidenceTransportKeyPin();
    pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    const announcement = keyAnnouncement(1);
    channel.emit(JSON.stringify(announcement));

    const snapshot = pin.snapshot();
    expect(snapshot.status).toBe("pinned");
    expect(snapshot.failureReason).toBeNull();
    expect(snapshot.key).toEqual(announcement);
    expect(Object.isFrozen(snapshot.key)).toBe(true);
    expect(parseRuntimeEvidenceTransportVerificationKey(announcement)).toEqual(announcement);
  });

  it("allows nonblocking binding while the authenticated channel is connecting", () => {
    const channel = new MockDataChannel(
      RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL,
      "connecting",
    );
    const pin = new RuntimeEvidenceTransportKeyPin();
    pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    expect(pin.snapshot().status).toBe("pending");

    channel.emit(JSON.stringify(keyAnnouncement(20)));
    expect(pin.snapshot().status).toBe("pinned");
  });

  it("fails closed on malformed announcements and never recovers within the session", () => {
    const channel = new MockDataChannel();
    const pin = new RuntimeEvidenceTransportKeyPin();
    pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    const forged = keyAnnouncement(2);
    forged.keyId = `${KEY_ID_PREFIX}${"f".repeat(64)}`;
    channel.emit(JSON.stringify(forged));
    channel.emit(JSON.stringify(keyAnnouncement(2)));

    expect(pin.snapshot()).toMatchObject({
      status: "failed",
      key: null,
      failureReason: "runtime_evidence_transport_key_announcement_invalid",
    });
  });

  it("invalidates the pin when the worker attempts in-session key replacement", () => {
    const channel = new MockDataChannel();
    const pin = new RuntimeEvidenceTransportKeyPin();
    const statuses: string[] = [];
    pin.onChange((snapshot) => statuses.push(snapshot.status));
    pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    channel.emit(JSON.stringify(keyAnnouncement(3)));
    channel.emit(JSON.stringify(keyAnnouncement(3)));
    channel.emit(JSON.stringify(keyAnnouncement(4)));

    expect(pin.snapshot()).toMatchObject({
      status: "failed",
      key: null,
      failureReason: "runtime_evidence_transport_key_replaced_in_session",
    });
    expect(statuses).toEqual(["pending", "pinned", "failed"]);
  });

  it("fails and notifies when the authenticated evidence channel closes", () => {
    const channel = new MockDataChannel();
    const pin = new RuntimeEvidenceTransportKeyPin();
    const snapshots: Array<{ status: string; reason: string | null }> = [];
    pin.onChange(() => {
      throw new Error("observer failure must be isolated");
    });
    pin.onChange((snapshot) => snapshots.push({
      status: snapshot.status,
      reason: snapshot.failureReason,
    }));
    pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    channel.emit(JSON.stringify(keyAnnouncement(17)));
    channel.closeRemotely();

    expect(pin.snapshot()).toMatchObject({
      status: "failed",
      key: null,
      failureReason: "runtime_evidence_transport_authenticated_channel_closed",
    });
    expect(snapshots).toEqual([
      { status: "pending", reason: null },
      { status: "pinned", reason: null },
      {
        status: "failed",
        reason: "runtime_evidence_transport_authenticated_channel_closed",
      },
    ]);
  });

  it("does not deliver stale pinned state after a reentrant terminal transition", () => {
    const channel = new MockDataChannel();
    const pin = new RuntimeEvidenceTransportKeyPin();
    const laterObserverStatuses: string[] = [];
    pin.onChange((snapshot) => {
      if (snapshot.status === "pinned") pin.dispose();
    });
    pin.onChange((snapshot) => laterObserverStatuses.push(snapshot.status));
    pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    channel.emit(JSON.stringify(keyAnnouncement(18)));

    expect(pin.snapshot().status).toBe("disposed");
    expect(laterObserverStatuses).toEqual(["pending", "disposed"]);
  });

  it("replays every terminal or usable state to late session observers", () => {
    const pinnedChannel = new MockDataChannel();
    const pinned = new RuntimeEvidenceTransportKeyPin();
    pinned.bindAuthenticatedPeerDataChannel(pinnedChannel as unknown as RTCDataChannel);
    pinnedChannel.emit(JSON.stringify(keyAnnouncement(19)));
    const pinnedStatuses: string[] = [];
    pinned.onChange((snapshot) => pinnedStatuses.push(snapshot.status));

    const failedChannel = new MockDataChannel();
    const failed = new RuntimeEvidenceTransportKeyPin();
    failed.bindAuthenticatedPeerDataChannel(failedChannel as unknown as RTCDataChannel);
    failedChannel.emit("not-json");
    const failedSnapshots: Array<{ status: string; reason: string | null }> = [];
    failed.onChange((snapshot) => failedSnapshots.push({
      status: snapshot.status,
      reason: snapshot.failureReason,
    }));

    const disposed = new RuntimeEvidenceTransportKeyPin();
    disposed.dispose();
    const disposedStatuses: string[] = [];
    disposed.onChange((snapshot) => disposedStatuses.push(snapshot.status));

    expect(pinnedStatuses).toEqual(["pinned"]);
    expect(failedSnapshots).toEqual([{
      status: "failed",
      reason: "runtime_evidence_transport_key_announcement_json_invalid",
    }]);
    expect(disposedStatuses).toEqual(["disposed"]);
  });

  it("fails immediately when the authenticated channel is already closing or closed", () => {
    for (const readyState of ["closing", "closed"] as const) {
      const pin = new RuntimeEvidenceTransportKeyPin();
      pin.bindAuthenticatedPeerDataChannel(
        new MockDataChannel(
          RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL,
          readyState,
        ) as unknown as RTCDataChannel,
      );
      expect(pin.snapshot()).toMatchObject({
        status: "failed",
        key: null,
        failureReason: "runtime_evidence_transport_authenticated_channel_invalid",
      });
    }
  });

  it("rejects the wrong channel provenance and clears key material on dispose", () => {
    const wrongChannel = new MockDataChannel("build-log");
    const wrongPin = new RuntimeEvidenceTransportKeyPin();
    wrongPin.bindAuthenticatedPeerDataChannel(wrongChannel as unknown as RTCDataChannel);
    wrongChannel.emit(JSON.stringify(keyAnnouncement(5)));
    expect(wrongPin.snapshot().status).toBe("failed");

    const channel = new MockDataChannel();
    const pin = new RuntimeEvidenceTransportKeyPin();
    pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    channel.emit(JSON.stringify(keyAnnouncement(6)));
    expect(pin.snapshot().status).toBe("pinned");
    const statuses: string[] = [];
    pin.onChange((snapshot) => statuses.push(snapshot.status));
    pin.dispose();
    expect(pin.snapshot()).toEqual({ status: "disposed", key: null, failureReason: null });
    expect(statuses).toEqual(["pinned", "disposed"]);
  });
});

describe("RuntimeEvidenceTransportReceiptConsumer", () => {
  function signingIdentity(seed: number): {
    announcement: Record<string, unknown>;
    privateKey: KeyObject;
  } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    return {
      announcement: keyAnnouncement(seed, spki.subarray(spki.length - 32)),
      privateKey,
    };
  }

  it("verifies a fresh receipt against only the live channel-pinned key", () => {
    const identity = signingIdentity(11);
    const pin = pinAnnouncement(identity.announcement);
    const fixture = signedEnvelopeFixture(identity);
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      new SessionRuntimeEvidenceTransportReplayStore(),
      () => NOW_NS,
    );

    expect(consumer.consumeSupportEnvelope(fixture.input)).toEqual({
      verified: true,
      reason: null,
      receiptId: fixture.receipt.receiptId,
      observationContextHash: fixture.receipt.observationContextHash,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
  });

  it("rejects key substitution, signature forgery, and extra receipt fields", () => {
    const identity = signingIdentity(12);
    const otherIdentity = signingIdentity(13);
    const pin = pinAnnouncement(identity.announcement);
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      new SessionRuntimeEvidenceTransportReplayStore(),
      () => NOW_NS,
    );

    const substituted = signedEnvelopeFixture(otherIdentity);
    expect(consumer.consumeSupportEnvelope(substituted.input).reason)
      .toBe("runtime_evidence_transport_verification_context_mismatch");

    const forged = signedEnvelopeFixture(identity);
    forged.receipt.signature = `ed25519:${Buffer.alloc(64).toString("base64url")}`;
    expect(consumer.consumeSupportEnvelope(forged.input).reason)
      .toBe("runtime_evidence_transport_signature_mismatch");

    const extraField = signedEnvelopeFixture(identity);
    extraField.receipt.fixtureName = "must-not-be-authority";
    expect(consumer.consumeSupportEnvelope(extraField.input).reason)
      .toBe("runtime_evidence_transport_receipt_field_shape_invalid");
  });

  it("binds the observed payload and canonical subject bytes", () => {
    const identity = signingIdentity(14);
    const pin = pinAnnouncement(identity.announcement);
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      new SessionRuntimeEvidenceTransportReplayStore(),
      () => NOW_NS,
    );
    const payloadMismatch = signedEnvelopeFixture(identity);
    expect(consumer.consumeSupportEnvelope({
      ...payloadMismatch.input,
      observedPayload: `${payloadMismatch.input.observedPayload} `,
    }).reason).toBe("runtime_evidence_transport_observed_payload_hash_mismatch");

    const subjectMismatch = signedEnvelopeFixture(identity);
    expect(consumer.consumeSupportEnvelope({
      ...subjectMismatch.input,
      subjectCanonicalBytes: "different-subject",
    }).reason).toBe("runtime_evidence_transport_verification_context_mismatch");

    const challengeMismatch = signedEnvelopeFixture(identity);
    expect(consumer.consumeSupportEnvelope({
      ...challengeMismatch.input,
      runnerChallenge: "b".repeat(32),
    }).reason).toBe("runtime_evidence_transport_verification_context_mismatch");
  });

  it("rejects expired and future receipts with nanosecond precision", () => {
    const identity = signingIdentity(15);
    const pin = pinAnnouncement(identity.announcement);
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      new SessionRuntimeEvidenceTransportReplayStore(),
      () => NOW_NS,
    );
    const expired = signedEnvelopeFixture({
      ...identity,
      issuedAtUnixNs: NOW_NS - 300_000_000_001n,
    });
    expect(consumer.consumeSupportEnvelope(expired.input).reason)
      .toBe("runtime_evidence_transport_receipt_expired");

    const future = signedEnvelopeFixture({
      ...identity,
      issuedAtUnixNs: NOW_NS + 30_000_000_001n,
    });
    expect(consumer.consumeSupportEnvelope(future.input).reason)
      .toBe("runtime_evidence_transport_receipt_from_future");
  });

  it("atomically rejects duplicate receipt IDs and non-increasing sequences", () => {
    const identity = signingIdentity(16);
    const pin = pinAnnouncement(identity.announcement);
    const replayStore = new SessionRuntimeEvidenceTransportReplayStore();
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(pin, replayStore, () => NOW_NS);
    const first = signedEnvelopeFixture({ ...identity, sequence: 1n, nonceSeed: "7" });
    expect(consumer.consumeSupportEnvelope(first.input).verified).toBe(true);
    consumer.dispose();
    const recreatedConsumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      replayStore,
      () => NOW_NS,
    );
    expect(recreatedConsumer.consumeSupportEnvelope(first.input).reason)
      .toBe("runtime_evidence_transport_receipt_replayed");

    const staleSequence = signedEnvelopeFixture({
      ...identity,
      sequence: 1n,
      nonceSeed: "8",
    });
    expect(recreatedConsumer.consumeSupportEnvelope(staleSequence.input).reason)
      .toBe("runtime_evidence_transport_receipt_replayed");

    const next = signedEnvelopeFixture({ ...identity, sequence: 2n, nonceSeed: "9" });
    expect(recreatedConsumer.consumeSupportEnvelope(next.input).verified).toBe(true);
  });
});
